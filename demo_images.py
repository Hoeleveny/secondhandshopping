"""演示商品配图：从 **Wikimedia Commons** 抓自由授权图片。

口径（用户拍板）：**不爬电商站**（条款与版权风险），只用明确允许再利用的图源；
每张图都记录 作者 / 许可 / 来源页 到 `seed_images/credit.json`，README 注明出处。

用法：`manage.py demo-images`（幂等：已经有图的商品跳过；`--force` 才重做）
"""
from __future__ import annotations

import html
import json
import os
import re
import time
import urllib.parse
import urllib.request
import uuid

API = "https://commons.wikimedia.org/w/api.php"
UA = "CampusMarket-DemoSeeder/1.0 (school project; contact: local)"

# 商品名里的关键词 → Commons 搜索词（尽量对得上商品本体）
PRODUCT_TERMS = [
    ("高等数学", "calculus textbook"),
    ("考研英语", "english textbook"),
    ("大学物理", "physics textbook"),
    ("蓝牙耳机", "wireless earbuds"),
    ("iPad", "ipad tablet"),
    ("蓝牙键盘", "computer keyboard"),
    ("笔记本", "laptop computer"),
    ("台灯", "desk lamp"),
    ("收纳箱", "storage box"),
    ("电热水壶", "electric kettle"),
    ("自行车", "mountain bicycle"),
    ("篮球", "basketball"),
    ("哑铃", "dumbbell"),
    ("吉他", "acoustic guitar"),
    ("门票", "concert ticket"),
    ("保温杯", "vacuum flask"),
    ("相机", "digital camera"),
    ("充电宝", "power bank"),
    ("景品", "anime figure"),
    ("写真", "portrait photograph"),
]

CATEGORY_TERMS = {
    "教材": "textbook",
    "数码": "consumer electronics",
    "生活用品": "household goods",
    "运动": "sports equipment",
    "其他": "second-hand goods",
}

# 不适合当商品图的内容：① 图表/标志类 ② 露骨或成人内容（演示项目必须挡掉）
BAD_WORDS = ("logo", "diagram", "map", "chart", "icon", "symbol", "seal", "sign",
             "poster", "screenshot", "cover", "scan", "certificate", "blueprint",
             "nude", "nudity", "naked", "topless", "erotic", "erotica", "sexual",
             "sex ", "porn", "penis", "vagina", "breast", "nipple", "bikini",
             "lingerie", "underwear", "fetish", "gore", "blood", "corpse")


def _get_json(params: dict) -> dict:
    url = API + "?" + urllib.parse.urlencode({
        "action": "query", "format": "json", "generator": "search",
        "gsrsearch": params["term"] + " filetype:bitmap",
        "gsrnamespace": "6", "gsrlimit": str(params.get("limit", 8)),
        "prop": "imageinfo", "iiprop": "url|extmetadata|size|mime",
        "iiurlwidth": "900",
    })
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=25) as resp:
        return json.loads(resp.read())


def search(term: str, limit: int = 8) -> list[dict]:
    """搜一批可用的图片元数据（按 Commons 的相关度顺序）。"""
    try:
        data = _get_json({"term": term, "limit": limit})
    except Exception:
        return []
    pages = ((data.get("query") or {}).get("pages") or {})
    items = []
    for page in sorted(pages.values(), key=lambda p: p.get("index", 99)):
        info = (page.get("imageinfo") or [{}])[0]
        mime = info.get("mime") or ""
        thumb = info.get("thumburl") or ""
        width, height = info.get("width") or 0, info.get("height") or 0
        title = (page.get("title") or "").lower()
        if not thumb or not mime.startswith("image/"):
            continue
        if mime in ("image/svg+xml", "image/gif", "image/tiff"):
            continue
        if width < 500 or height < 350:          # 太小的不要
            continue
        meta = info.get("extmetadata") or {}
        cats = str((meta.get("Categories") or {}).get("value") or "").lower()
        blob = title + " " + cats
        if any(bad in blob for bad in BAD_WORDS):
            continue
        # 相关性：搜索词里的实词至少命中一个，否则容易配到"风马牛不相及"的图
        words = [w for w in term.lower().split() if len(w) >= 4]
        hits = sum(1 for w in words if w in blob)
        if words and hits == 0:
            continue

        def field(name):
            v = str((meta.get(name) or {}).get("value") or "")
            v = re.sub(r"<[^>]+>", "", v)          # 去掉 Commons 返回的 HTML 标签
            v = html.unescape(v).strip()
            return re.sub(r"\s+", " ", v)[:120]

        items.append({
            "hits": hits,
            "thumb": thumb,
            "page": info.get("descriptionurl") or page.get("title") or "",
            "title": page.get("title") or "",
            "artist": field("Artist"),
            "license": field("LicenseShortName"),
            "width": width, "height": height,
        })
    items.sort(key=lambda x: -x.get("hits", 0))
    return items


def download(url: str, dest_path: str) -> bool:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
        if len(data) < 3000:                      # 太小多半是占位/错误图
            return False
        with open(dest_path, "wb") as fh:
            fh.write(data)
        return True
    except Exception:
        return False


def term_for(product, category_name: str) -> str:
    name = product.name or ""
    for key, term in PRODUCT_TERMS:
        if key.lower() in name.lower():
            return term
    return CATEGORY_TERMS.get(category_name or "", "second-hand goods")


def run(per_product: int = 2, only_missing: bool = True) -> dict:
    """给演示商品补图。返回统计。"""
    from flask import current_app

    from extensions import db
    from imaging import store_features
    from models import Category, ImageFeature, Product, ProductImage

    folder = current_app.config["UPLOAD_FOLDER"]
    credit_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "seed_images", "credit.json")
    os.makedirs(os.path.dirname(credit_path), exist_ok=True)
    try:
        with open(credit_path, encoding="utf-8") as fh:
            credits = json.load(fh)
    except Exception:
        credits = {}

    cats = {c.id: c.name for c in Category.query.all()}
    products = Product.query.filter(Product.status != "deleted").order_by(Product.id).all()

    stats = {"products": 0, "images": 0, "skipped": 0, "failed": 0}
    for p in products:
        # per_product 是「目标总张数」：已有的算在内，只补差额（幂等，可反复跑到满意）
        have = ProductImage.query.filter_by(product_id=p.id).count()
        need = per_product - have
        if need <= 0:
            stats["skipped"] += 1
            continue
        term = term_for(p, cats.get(p.category_id, ""))
        picks = search(term)
        if not picks:
            stats["failed"] += 1
            print(f"  [--] {p.name[:16]:16s} 搜不到「{term}」")
            continue
        got = 0
        for item in picks:
            if got >= need:
                break
            ext = ".jpg"
            filename = f"{uuid.uuid4().hex}{ext}"
            dest = os.path.join(folder, filename)
            if not download(item["thumb"], dest):
                continue
            db.session.add(ProductImage(product_id=p.id, url=filename, sort=got))
            db.session.commit()
            store_features(filename, folder)      # 顺手算进 image_features（画像用）
            credits[filename] = {
                "product": p.name, "keyword": term,
                "source_page": item["page"], "title": item["title"],
                "artist": item["artist"], "license": item["license"],
            }
            got += 1
            stats["images"] += 1
            time.sleep(0.25)
        if got:
            stats["products"] += 1
            print(f"  [OK] {p.name[:16]:16s} 补 {got} 张（关键词「{term}」）")
        else:
            stats["failed"] += 1
            print(f"  [--] {p.name[:16]:16s} 下载失败（关键词「{term}」）")

    with open(credit_path, "w", encoding="utf-8") as fh:
        json.dump(credits, fh, ensure_ascii=False, indent=2)
    stats["credit_file"] = credit_path
    stats["feature_rows"] = ImageFeature.query.count()
    return stats
