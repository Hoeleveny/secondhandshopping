"""商品编号的一次性回填（幂等，可反复执行）。

对应提示词第 7 章。执行顺序：
  ① 大类字母码（categories.code）
  ② 小类在大类内的稳定序号（subcategories.seq_in_category，按 id 顺序固化）
  ③ 卖家脱敏序号（users.seller_seq，只给「发布过商品」的用户按 id 顺序分配）
  ④ 存量商品补编号（按 created_at ASC, id ASC 逐条生成）
  ⑤ 把编号补进老订单的 product_snapshot（老单也能显示原编号）
  ⑥ 全部补完后把 products.product_code 收紧为 NOT NULL

每一步都先判断「是否已经有值」，已处理过的直接跳过。

用法： .venv\\Scripts\\python.exe manage.py backfill-codes
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# 五个初始大类的字母助记码（提示词 §2.4 给定）。新增大类由管理员在
# 管理后台「基础数据」里自行填写，这里不做猜测。
DEFAULT_CATEGORY_CODES = {
    "教材": "TA",
    "数码": "DG",
    "生活用品": "LF",
    "运动": "SP",
    "其他": "OT",
}


def assign_category_codes() -> int:
    """给还没有字母码的大类补上初始映射（幂等）。"""
    from extensions import db

    from models import Category

    taken = {c for (c,) in db.session.query(Category.code).filter(Category.code.isnot(None)).all()}
    changed = 0
    for cat in Category.query.order_by(Category.id).all():
        if cat.code:
            continue
        code = DEFAULT_CATEGORY_CODES.get(cat.name)
        if code and code not in taken:
            cat.code = code
            taken.add(code)
            changed += 1
    db.session.flush()
    return changed


def assign_subcategory_seqs() -> int:
    """给还没有序号的小类按 id 顺序固化「大类内序号」（幂等）。"""
    from extensions import db

    from models import Category, Subcategory

    changed = 0
    for cat in Category.query.order_by(Category.id).all():
        subs = Subcategory.query.filter_by(category_id=cat.id).order_by(Subcategory.id).all()
        used = {s.seq_in_category for s in subs if s.seq_in_category}
        nxt = 1
        for sub in subs:
            if sub.seq_in_category:
                continue
            while nxt in used:
                nxt += 1
            sub.seq_in_category = nxt
            used.add(nxt)
            changed += 1
    db.session.flush()
    return changed


def run(verbose: bool = True) -> dict:
    from sqlalchemy import text

    import product_code
    from extensions import db
    from models import Order, Product, User

    stats = {"categories": 0, "subcategories": 0, "sellers": 0,
             "products": 0, "snapshots": 0, "tightened": 0}

    def say(msg):
        if verbose:
            print("      " + msg)

    # ① 大类字母码 ---------------------------------------------------------
    stats["categories"] = assign_category_codes()
    if verbose and stats["categories"]:
        say(f"补了 {stats['categories']} 个大类的字母码")

    # ② 小类稳定序号（按 id 顺序，已有值的跳过）-----------------------------
    stats["subcategories"] = assign_subcategory_seqs()
    if verbose and stats["subcategories"]:
        say(f"补了 {stats['subcategories']} 个小类的序号")

    # ③ 卖家码：只给发布过商品的用户分配 -----------------------------------
    seller_ids = sorted({sid for (sid,) in db.session.query(Product.seller_id).distinct().all()})
    used_seq = {s for (s,) in db.session.query(User.seller_seq).filter(User.seller_seq.isnot(None)).all()}
    nxt = max(used_seq) if used_seq else 0
    for uid in seller_ids:
        user = User.query.get(uid)
        if user is None or user.seller_seq:
            continue
        nxt += 1
        user.seller_seq = nxt
        stats["sellers"] += 1
        say(f"卖家「{user.nickname or user.username}」-> 卖家码 {nxt:04d}")
    db.session.flush()

    # ④ 存量商品补编号（时间升序，保证流水号与发布顺序一致）-----------------
    pending = (
        Product.query.filter(Product.product_code.is_(None))
        .order_by(Product.created_at.asc(), Product.id.asc()).all()
    )
    for product in pending:
        seller = User.query.get(product.seller_id)
        product.product_code = product_code.assign_for(seller, product)
        stats["products"] += 1
        say(f"商品 #{product.id} {product.name[:16]} -> {product.product_code}")
    db.session.flush()

    # ⑤ 老订单快照补上编号（快照里没有该键的才补）---------------------------
    for order in Order.query.order_by(Order.id).all():
        snap = dict(order.product_snapshot or {})
        if snap.get("product_code"):
            continue
        code = None
        if order.product_id:
            product = Product.query.get(order.product_id)
            code = product.product_code if product else None
        if not code:
            continue
        snap["product_code"] = code
        order.product_snapshot = snap          # 赋新 dict，确保 JSON 变更被察觉
        stats["snapshots"] += 1
    db.session.commit()

    # ⑥ 全部补完后收紧为 NOT NULL（还有 NULL 就不动，下次再跑）-------------
    remaining = Product.query.filter(Product.product_code.is_(None)).count()
    if remaining == 0:
        db.session.execute(text(
            "ALTER TABLE `products` MODIFY `product_code` VARCHAR(32) NOT NULL "
            "COMMENT '商品编号：分类码-卖家码-日期码-流水号，系统生成、永不改变'"
        ))
        db.session.commit()
        stats["tightened"] = 1
        say("products.product_code 已收紧为 NOT NULL")
    elif verbose:
        say(f"仍有 {remaining} 件商品没有编号，本次不收紧 NOT NULL")

    return stats
