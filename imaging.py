"""图片特征提取（2026-10-18 需求② 用户「图像感知偏好」）。

口径（用户拍板）：**色彩按像素真实统计**；「人物 / 物体形状」没有模型可用，
只能做**启发式近似**（肤色像素占比、边缘密度、长宽比），界面上必须标注"算法近似"，
不许包装成识别结果。

设计要点：
- 统一缩到 96px 再统计，单张几毫秒；特征一旦算好就入库（`image_features` 表，按文件名唯一），
  展示时直接读，不在接口里实时算。
- 所有字段都是 0~1 的比例或标量，便于聚合与解释。
"""
from __future__ import annotations

import colorsys
import math

from PIL import Image, ImageFilter, ImageStat

SAMPLE = 96

# 色相分段：右上不含、左闭（deg 落在 [前一段的上界, 本段上界) 取本段名）
HUE_NAMES = [(15, "红"), (45, "橙"), (70, "黄"), (160, "绿"), (200, "青"),
             (255, "蓝"), (290, "紫"), (330, "品红"), (361, "红")]


def _hue_name(deg: float) -> str:
    for bound, name in HUE_NAMES:
        if deg < bound:
            return name
    return "红"


def _is_skin(r: int, g: int, b: int) -> bool:
    """经典 RGB 肤色判据（近似）：只用来给"疑似人像"的**强度提示**。"""
    return (r > 95 and g > 40 and b > 20
            and r > g and r > b
            and (max(r, g, b) - min(r, g, b)) > 15
            and abs(r - g) > 15)


def _mean_std(xs):
    m = sum(xs) / len(xs)
    return m, math.sqrt(sum((x - m) ** 2 for x in xs) / len(xs))


def analyze(path: str) -> dict | None:
    """统计一张图，返回可直接入库的 dict；打不开/格式不支持返回 None。"""
    try:
        with Image.open(path) as im:
            im = im.convert("RGB")
            width, height = im.size
            im.thumbnail((SAMPLE, SAMPLE))
            pixels = list(im.getdata())
            luma = im.convert("L")
            edges = ImageStat.Stat(luma.filter(ImageFilter.FIND_EDGES)).mean[0] / 255.0
    except Exception:
        return None
    if not pixels:
        return None

    n = len(pixels)
    warm = cool = grey = 0
    sat_sum = light_sum = skin = 0.0
    hue_bucket: dict[str, int] = {}

    for (r, g, b) in pixels:
        hh, ll, ss = colorsys.rgb_to_hls(r / 255.0, g / 255.0, b / 255.0)
        sat_sum += ss
        light_sum += ll
        if ss < 0.12:                       # 近灰/黑白：不参与冷暖判定
            grey += 1
        else:
            deg = hh * 360.0
            if deg < 70 or deg >= 300:
                warm += 1
            else:
                cool += 1
            name = _hue_name(deg)
            hue_bucket[name] = hue_bucket.get(name, 0) + 1
        if _is_skin(r, g, b):
            skin += 1

    chroma = warm + cool
    rg = [p[0] - p[1] for p in pixels]
    yb = [(p[0] + p[1]) / 2.0 - p[2] for p in pixels]
    rg_m, rg_s = _mean_std(rg)
    yb_m, yb_s = _mean_std(yb)
    colorfulness = math.sqrt(rg_s ** 2 + yb_s ** 2) + 0.3 * math.sqrt(rg_m ** 2 + yb_m ** 2)

    dominant = max(hue_bucket.items(), key=lambda kv: kv[1])[0] if hue_bucket else "灰"

    return {
        "width": int(width),
        "height": int(height),
        "aspect": round(width / height, 3) if height else 0.0,
        "warm": round(warm / chroma, 4) if chroma else 0.0,   # 彩色像素里暖色占比
        "grey": round(grey / n, 4),
        "light": round(light_sum / n, 4),
        "sat": round(sat_sum / n, 4),
        "colorfulness": round(colorfulness, 2),
        "edges": round(min(edges, 1.0), 4),
        "skin": round(skin / n, 4),                            # 疑似人像强度（近似）
        "dominant": dominant,
    }


def describe(f: dict | None) -> str:
    """把特征翻成人话，界面直接用。"""
    if not f:
        return ""
    parts = []
    parts.append("偏暖" if (f.get("warm") or 0) >= 0.5 else "偏冷")
    light = f.get("light") or 0
    parts.append("明亮" if light >= 0.6 else ("中间调" if light >= 0.35 else "暗调"))
    sat = f.get("sat") or 0
    parts.append("鲜艳" if sat >= 0.45 else ("适中" if sat >= 0.25 else "素净"))
    if (f.get("skin") or 0) >= 0.12:
        parts.append("疑似人像")
    edge = f.get("edges") or 0
    if edge >= 0.35:
        parts.append("画面繁复")
    elif edge < 0.12:
        parts.append("画面简洁")
    return " · ".join(parts)


def aggregate(feats: list[dict]) -> dict:
    """把一个人看过的若干张图的特征，汇总成他的图像偏好。"""
    feats = [f for f in feats if f]
    if not feats:
        return {"count": 0, "text": "", "empty": True}
    n = len(feats)

    def avg(key):
        return round(sum(float(f.get(key) or 0) for f in feats) / n, 4)

    dom: dict[str, int] = {}
    for f in feats:
        if f.get("dominant"):
            dom[f["dominant"]] = dom.get(f["dominant"], 0) + 1
    top_dom = sorted(dom.items(), key=lambda kv: -kv[1])[:3]

    merged = {
        "warm": avg("warm"), "light": avg("light"), "sat": avg("sat"),
        "skin": avg("skin"), "edges": avg("edges"),
    }
    return {
        "count": n,
        "warm": merged["warm"], "light": merged["light"], "sat": merged["sat"],
        "skin": merged["skin"], "edges": merged["edges"],
        "dominants": [{"name": k, "count": v} for k, v in top_dom],
        "text": describe(merged),
        "empty": False,
    }


def store_features(filename: str, folder: str):
    """算一张图的特征并入库存好；重复调用不会重复入库。返回 dict 或 None。"""
    import os

    from extensions import db
    from models import ImageFeature

    try:
        row = ImageFeature.query.filter_by(path=filename).first()
        if row is not None:
            return row.to_dict()
        feats = analyze(os.path.join(folder, filename))
        if not feats:
            return None
        row = ImageFeature(path=filename, **feats)
        db.session.add(row)
        db.session.commit()
        return row.to_dict()
    except Exception:
        try:
            db.session.rollback()
        except Exception:
            pass
        return None
