"""商品标签的规范化与校验（2026-10-18 第七批）。

口径（用户拍板：一期先用现有维度跑通、二期上标签体系）：
- 一个商品最多 **5 个**标签，每个 **1~8 个字**；
- 允许「毕业出」「宿舍必备」「可小刀」这类自由词，但要**去重、去空白**；
- 标签里不要带逗号/分号（前端用逗号分隔输入，带了会切不干净）。

两个函数都是纯函数，冒烟里可直接构造输入验证，不需要连库。
"""
from __future__ import annotations

import re

MAX_TAGS = 5
MAX_LEN = 8
_SPLIT = re.compile(r"[,，;；、\s]+")
_BAD = set(",，;；、\n\r\t")


def normalize(raw) -> list:
    """把前端传来的 tags 变成干净的列表：支持 list、逗号/顿号/空白分隔的字符串。

    保序去重；空串丢弃；不截断超长（交给 `validate` 报错，避免"悄悄改用户输入"）。
    """
    if raw is None:
        return []
    if isinstance(raw, str):
        items = _SPLIT.split(raw)
    elif isinstance(raw, (list, tuple, set)):
        items = list(raw)
    else:
        return []
    out = []
    for item in items:
        text = str(item).strip()
        if not text or text in out:
            continue
        out.append(text)
    return out


def validate(tags) -> str | None:
    """返回错误提示；合法返回 None。"""
    if len(tags) > MAX_TAGS:
        return f"最多 {MAX_TAGS} 个标签"
    for tag in tags:
        if len(tag) > MAX_LEN:
            return f"单个标签最多 {MAX_LEN} 个字：「{tag[:12]}」"
        if any(ch in _BAD for ch in tag):
            return "标签里不要带逗号、分号或换行"
    return None


# 演示商品的自动打标规则：商品名关键词 → 标签（先匹配到的优先，最多 5 个）
DEMO_RULES = [
    ("考研", "考研"),
    ("四级", "四六级"), ("六级", "四六级"), ("大学英语", "四六级"),
    ("高等数学", "复习"), ("线性代数", "复习"), ("概率论", "复习"),
    ("大学物理", "复习"), ("马克思主义", "复习"),
    ("数据结构", "计算机"), ("数据库", "计算机"), ("计算机网络", "计算机"),
    ("操作系统", "计算机"), ("计算机组成", "计算机"),
    ("耳机", "耳机"), ("键盘", "键鼠"), ("鼠标", "键鼠"), ("保护壳", "配件"),
    ("手机", "手机"), ("平板", "平板"), ("笔记本", "笔记本"), ("相机", "摄影"),
    ("台灯", "宿舍必备"), ("阅读灯", "宿舍必备"),
    ("收纳", "收纳"), ("挂袋", "收纳"), ("置物架", "收纳"),
    ("保温", "保温"), ("水杯", "保温"), ("水壶", "保温"),
    ("电煮锅", "小电器"), ("电饭煲", "小电器"), ("风扇", "小电器"),
    ("插排", "小电器"), ("电吹风", "小电器"),
    ("自行车", "代步"),
    ("跑鞋", "鞋"), ("篮球鞋", "鞋"), ("鞋", "鞋"),
    ("篮球", "球类"), ("排球", "球类"), ("羽毛球", "球类"), ("网球", "球类"),
    ("足球", "球类"), ("乒乓", "球类"),
    ("瑜伽", "健身"), ("哑铃", "健身"), ("跳绳", "健身"), ("筋膜枪", "健身"),
    ("吉他", "乐器"), ("尤克里里", "乐器"), ("电子琴", "乐器"),
    ("手办", "玩具"), ("高达", "玩具"), ("景品", "玩具"), ("拼图", "玩具"),
    ("门票", "票券"), ("话剧", "票券"), ("音乐会", "票券"),
    ("多肉", "绿植"),
    ("纸箱", "搬家"),
]


def demo_tags_for(name: str) -> list:
    """按名称关键词给演示商品挑标签（纯函数，便于单测）。"""
    out = []
    text = name or ""
    for key, tag in DEMO_RULES:
        if key in text and tag not in out:
            out.append(tag)
            if len(out) >= MAX_TAGS:
                break
    return out


def backfill_demo() -> dict:
    """给演示商品按名称自动补标签（幂等：只补不存在的，不动已有标签）。

    直接按 `ProductTag` 表判断已有标签（不走 relationship 缓存），
    否则同一 session 里刚加过的行可能读不到，统计会失真。
    """
    from extensions import db
    from models import Product, ProductTag

    existing: dict = {}
    for row in ProductTag.query.all():
        existing.setdefault(row.product_id, set()).add(row.tag)

    added = touched = 0
    for product in Product.query.filter(Product.status != "deleted").all():
        have = existing.get(product.id, set())
        room = MAX_TAGS - len(have)
        if room <= 0:
            continue
        want = [t for t in demo_tags_for(product.name or "") if t not in have][:room]
        if not want:
            continue
        for tag in want:
            db.session.add(ProductTag(product_id=product.id, tag=tag))
            added += 1
        touched += 1
    db.session.commit()
    return {"products": touched, "tags": added, "total_rows": ProductTag.query.count()}


def apply(product, raw, replace: bool = True) -> str | None:
    """把标签写到商品上（在 app context 内调用，调用方负责 commit）。

    - `replace=True`：整体替换（编辑商品时用）；
    - `replace=False`：只补不存在的（回填脚本用）。
    返回错误提示；成功返回 None。
    """
    from extensions import db
    from models import ProductTag

    tags = normalize(raw)
    err = validate(tags)
    if err:
        return err

    existing = {row.tag: row for row in product.tag_rows}
    if replace:
        for tag, row in list(existing.items()):
            if tag not in tags:
                db.session.delete(row)
                existing.pop(tag)
    for tag in tags:
        if tag in existing:
            continue
        if len(existing) >= MAX_TAGS:
            break
        db.session.add(ProductTag(product_id=product.id, tag=tag))
        existing[tag] = None
    return None
