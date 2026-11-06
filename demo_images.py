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
# 顺序＝优先级：越具体越靠前（"篮球鞋"必须排在"篮球"前面，否则会配成篮球的照片）
PRODUCT_TERMS = [
    # ---- 2026-10-18 第三批（商品扩到 100 件）新增的关键词 ----
    ("篮球鞋", "basketball shoes"),
    ("小米平板", "tablet computer"),
    ("荣耀平板", "tablet computer"),
    ("ThinkPad", "laptop computer"),
    ("AirPods", "wireless earbuds"),
    ("nova", "smartphone"),
    ("戴尔", "laptop computer"),
    ("漫步者", "wireless earbuds"),
    ("G102", "computer mouse"),
    ("概率论", "statistics textbook"),
    ("考研数学", "calculus textbook"),
    ("数据库系统", "database textbook"),
    ("操作系统概念", "operating system textbook"),
    ("马克思主义", "politics textbook"),
    ("考研政治", "politics textbook"),
    ("计算机组成原理", "computer architecture book"),
    ("六级", "english dictionary"),
    ("四级听力", "english listening test"),
    ("大学英语", "english textbook"),
    ("收纳凳", "folding stool"),
    ("挂袋", "hanging organizer"),
    ("收纳盒", "plastic storage box"),
    ("水杯", "water bottle"),
    ("风扇", "electric fan"),
    ("插排", "power strip"),
    ("电饭煲", "rice cooker"),
    ("电吹风", "hair dryer"),
    ("排球", "volleyball"),
    ("网球", "tennis racket"),
    ("筋膜枪", "massage gun"),
    ("跳绳", "jump rope"),
    ("瑜伽球", "exercise ball"),
    ("拼图", "jigsaw puzzle"),
    # ---- 2026-10-18 追加商品的关键词（放在前面，先匹配更具体的）----
    ("数据结构", "data structures textbook"),
    ("四级", "english vocabulary book"),
    ("计算机网络", "computer networks book"),
    ("线性代数", "linear algebra textbook"),
    ("红米", "smartphone"),
    ("iPhone", "iphone"),
    ("M590", "computer mouse"),
    ("鼠标", "computer mouse"),
    ("索尼", "headphones"),
    ("保护壳", "phone case"),
    ("机械键盘", "mechanical keyboard"),
    ("置物架", "shelf"),
    ("电煮锅", "rice cooker"),
    ("保温壶", "thermos"),
    ("阅读灯", "reading lamp"),
    ("床帘", "curtain"),
    ("全身镜", "mirror"),
    ("跑鞋", "running shoes"),
    ("羽毛球", "badminton racket"),
    ("瑜伽垫", "yoga mat"),
    ("折叠自行车", "folding bicycle"),
    ("足球", "football ball"),
    ("乒乓球", "table tennis racket"),
    ("尤克里里", "ukulele"),
    ("电子琴", "electronic keyboard"),
    ("初号机", "action figure"),
    ("高达", "model kit"),
    ("话剧", "theatre ticket"),
    ("多肉", "succulent plant"),
    ("纸箱", "cardboard box"),
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

# 帖子配图：标题/正文关键词 → Commons 搜索词；匹配不到按 tag 兜底
POST_TERMS = [
    ("自习", "library reading room"),
    ("图书馆", "library reading room"),
    ("充电宝", "power bank"),
    ("羽毛球", "badminton"),
    ("台灯", "desk lamp"),
    ("快递", "parcel delivery"),
    ("食堂", "cafeteria"),
    ("宿舍", "dormitory room"),
    ("考研", "study desk"),
    ("毕业", "graduation"),
    ("篮球", "outdoor basketball court"),
    ("自行车", "bicycle"),
]
POST_TAG_TERMS = {
    "安利": "student dormitory",
    "避雷": "worn out product",
    "闲聊": "campus",
    "求助": "desk lamp",
}

# 不适合当商品图的内容：只挡"不是实物照"的（图表/地图/海报/扫描件/图标）。
# 2026-10-18 用户拍板：**敏感照片不再加黑名单，正常显示即可**——所以这里没有内容类过滤。
BAD_WORDS = ("logo", "diagram", "map", "chart", "icon", "symbol", "seal", "sign",
             "poster", "screenshot", "cover", "scan", "certificate", "blueprint",
             "clipart", "infographic", "flowchart")


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


def post_term_for(post) -> str:
    """帖子配图的搜索词：先看标题/正文关键词，匹配不到按 tag 兜底。"""
    blob = f"{post.title or ''} {post.content or ''}"
    for key, term in POST_TERMS:
        if key in blob:
            return term
    return POST_TAG_TERMS.get(post.tag or "", "campus university")


def run_post_images(per_post: int = 2) -> dict:
    """给演示帖子补配图（2026-10-18 第三批）。幂等：已有的算在内，只补差额。"""
    from flask import current_app

    from extensions import db
    from imaging import store_features
    from models import ImageFeature, Post, PostImage

    folder = current_app.config["UPLOAD_FOLDER"]
    credit_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "seed_images", "credit.json")
    try:
        with open(credit_path, encoding="utf-8") as fh:
            credits = json.load(fh)
    except Exception:
        credits = {}

    stats = {"posts": 0, "images": 0, "skipped": 0, "failed": 0}
    for post in Post.query.order_by(Post.id).all():
        have = PostImage.query.filter_by(post_id=post.id).count()
        need = per_post - have
        if need <= 0:
            stats["skipped"] += 1
            continue
        term = post_term_for(post)
        picks = search(term)
        if not picks:
            stats["failed"] += 1
            print(f"  [--] 帖子#{post.id} 搜不到「{term}」")
            continue
        got = 0
        for item in picks:
            if got >= need:
                break
            filename = f"{uuid.uuid4().hex}.jpg"
            dest = os.path.join(folder, filename)
            if not download(item["thumb"], dest):
                continue
            db.session.add(PostImage(post_id=post.id, url=filename, sort=have + got))
            db.session.commit()
            store_features(filename, folder)      # 顺手算进 image_features（画像用）
            credits[filename] = {
                "post": (post.title or "")[:40], "keyword": term,
                "source_page": item["page"], "title": item["title"],
                "artist": item["artist"], "license": item["license"],
            }
            got += 1
            stats["images"] += 1
            time.sleep(0.25)
        if got:
            stats["posts"] += 1
            print(f"  [OK] 帖子#{post.id} 补 {got} 张（关键词「{term}」）")
        else:
            stats["failed"] += 1

    with open(credit_path, "w", encoding="utf-8") as fh:
        json.dump(credits, fh, ensure_ascii=False, indent=2)
    stats["credit_file"] = credit_path
    stats["feature_rows"] = ImageFeature.query.count()
    return stats


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
