"""演示行为数据：给演示账号造浏览 / 图片停留 / 收藏 / 成交，让用户画像有料可算。

为什么需要：画像（品类偏好、商家偏好、帖子分区、图片偏好）全靠"行为"喂出来。
只加商品不加行为，画像里永远是「样本不足」。

口径（2026-10-18 用户拍板）：
- 只动演示账号（buyer1 / buyer2 / seller1~3），**admin 不造**；
- 允许把少量商品走完整成交（下单 → 卖家确认 → 完成），这些商品会变成**已售**；
- 时间**回填**到最近 20 天、并散落到不同时段——否则"停留时长"全是 0、"活跃时段"全挤在一起；
- 幂等：某账号已有 ≥ `MIN_EXISTING` 条商品页浏览就跳过该账号，可反复跑；
- 回滚：`--clear` 删掉这些账号的浏览/看图行为 + 本脚本造的订单（商品退回在售）。

用法：
    .venv\\Scripts\\python.exe manage.py demo-behavior            # 每个账号 12 件商品
    .venv\\Scripts\\python.exe manage.py demo-behavior 20         # 自定义件数
    .venv\\Scripts\\python.exe manage.py demo-behavior --clear    # 回滚
"""
from __future__ import annotations

import random
from datetime import datetime, timedelta

# 每个演示账号偏好的大类（造出彼此不同的画像，画像才看得出区分度）
ACCOUNTS = {
    "buyer1": ["教材", "数码"],
    "buyer2": ["生活用品", "运动"],
    "seller1": ["其他", "教材"],
    "seller2": ["数码", "生活用品"],
    "seller3": ["运动", "其他"],
}

MIN_EXISTING = 20          # 这个账号已有 ≥ 20 条商品页浏览就不再造（幂等）
DAYS_BACK = 20
DEAL_MARK = "演示成交（demo-behavior）"

# 完整成交：买家 → 商品名（走「下单 → 卖家确认 → 完成」，商品最终变已售）
DEALS = [
    ("buyer1", "数据结构（C 语言版）第 3 版"),
    ("buyer2", "USB 夹式阅读灯"),
    ("buyer1", "机械键盘 87 键（红轴）"),
    ("buyer2", "篮球 7 号（室内外两用）"),
    ("buyer1", "索尼 MDR-ZX110 有线耳机"),
    ("buyer2", "折叠收纳凳（可坐）"),
]


def _when(now: datetime, rng: random.Random) -> datetime:
    """随机时间点：最近 DAYS_BACK 天内，19~23 点为主（宿舍里刷手机的高峰）。"""
    day = rng.randint(0, DAYS_BACK - 1)
    hour = rng.choice([9, 10, 12, 14, 16, 19, 20, 21, 21, 22, 22, 23])
    return (now - timedelta(days=day)).replace(
        hour=hour, minute=rng.randint(0, 59), second=rng.randint(0, 59), microsecond=0)


def clear() -> dict:
    """回滚本脚本造成的影响：删行为与图片埋点、删带标记的订单、商品退回在售。"""
    from extensions import db
    from models import Order, Product, ProductImageView, User, UserActivity

    users = {u.username: u for u in User.query.filter(User.username.in_(ACCOUNTS)).all()}
    uids = [u.id for u in users.values()]
    acts = (UserActivity.query.filter(UserActivity.user_id.in_(uids)).delete(
        synchronize_session=False) if uids else 0)
    views = (ProductImageView.query.filter(ProductImageView.user_id.in_(uids)).delete(
        synchronize_session=False) if uids else 0)

    orders = Order.query.filter(Order.trade_note == DEAL_MARK).all()
    restored = 0
    for order in orders:
        product = Product.query.get(order.product_id)
        if product is not None and product.status == "sold":
            product.status = "on_sale"
            restored += 1
        db.session.delete(order)
    db.session.commit()
    return {"activities": acts, "image_views": views,
            "orders": len(orders), "products_restored": restored}


def run(per_account: int = 12) -> dict:
    """给演示账号造一批行为。返回统计（第二次跑应当全是 0）。"""
    from extensions import db
    from models import (
        Category, Favorite, Order, Post, Product, ProductImage, ProductImageView,
        User, UserActivity,
    )
    from api.orders import product_snapshot

    rng = random.Random(20261018)          # 固定种子：同样的数据，方便复现与截图
    now = datetime.now()

    users = {u.username: u for u in User.query.all()}
    cats = {c.id: c.name for c in Category.query.all()}
    prods = [p for p in Product.query.filter(Product.status == "on_sale").all()]
    by_cat = {}
    for p in prods:
        by_cat.setdefault(cats.get(p.category_id, ""), []).append(p)
    for lst in by_cat.values():
        lst.sort(key=lambda x: x.id)
    posts = Post.query.order_by(Post.id).all()
    places = [p for p in Product.query.filter(Product.status == "on_sale").all()]
    img_count = {}
    for im in ProductImage.query.all():
        img_count[im.product_id] = img_count.get(im.product_id, 0) + 1

    stats = {"accounts": 0, "pages": 0, "image_views": 0, "favorites": 0, "skipped": 0}
    _meet_place = None
    if places:
        _meet_place = places[0].default_place_id

    for username, prefer in ACCOUNTS.items():
        user = users.get(username)
        if user is None:
            continue
        existing = (UserActivity.query.filter_by(user_id=user.id, kind="page")
                    .filter(UserActivity.page.like("/product/%")).count())
        if existing >= MIN_EXISTING:
            stats["skipped"] += 1
            continue

        pool = []
        for cat in prefer:                      # 先按偏好大类挑，再补其他大类
            pool.extend(by_cat.get(cat, [])[: per_account * 2])
        rest = [p for p in prods if p not in pool]
        rng.shuffle(rest)
        pool.extend(rest)
        picks = [p for p in pool if p.seller_id != user.id][:per_account]
        if not picks:
            continue

        rows = []                               # (when, path, name)
        for product in picks:
            visits = rng.randint(2, 3)          # 同一个商品看 2~3 次（构成"停留"）
            t = _when(now, rng)
            for _ in range(visits):
                rows.append((t, f"/product/{product.id}", "商品详情"))
                t = t + timedelta(seconds=rng.randint(20, 240))
            # 图片级埋点：首图必看，有第二张时再看一张（构造"头图党 / 细节党"差异）
            n_img = img_count.get(product.id, 0)
            if n_img:
                db.session.add(ProductImageView(
                    user_id=user.id, product_id=product.id, image_index=0,
                    dwell_ms=rng.randint(1200, 9000), created_at=t,
                ))
                stats["image_views"] += 1
                if n_img >= 2 and rng.random() < 0.45:
                    db.session.add(ProductImageView(
                        user_id=user.id, product_id=product.id, image_index=1,
                        dwell_ms=rng.randint(1500, 12000), created_at=t + timedelta(seconds=12),
                    ))
                    stats["image_views"] += 1
            # 收藏：偏好大类里的商品更容易被收
            if rng.random() < 0.22:
                ok = Favorite.query.filter_by(user_id=user.id, product_id=product.id).first()
                if ok is None:
                    db.session.add(Favorite(user_id=user.id, product_id=product.id,
                                            created_at=t + timedelta(seconds=8)))
                    stats["favorites"] += 1

        # 商家主页：各有 2~3 位"常逛的卖家"
        for product in picks[:3]:
            rows.append((_when(now, rng), f"/seller/{product.seller_id}", "用户主页"))
        # 帖子：逛 3~5 个（让帖子分区维度有样本）
        for post in posts[: rng.randint(3, 5)] if posts else []:
            rows.append((_when(now, rng), f"/post/{post.id}", "交流广场"))

        rows.sort(key=lambda x: x[0])
        for when, path, name in rows:
            db.session.add(UserActivity(
                user_id=user.id, kind="page", page=path, page_name=name,
                ip="", user_agent="demo-behavior", created_at=when,
            ))
            stats["pages"] += 1
        stats["accounts"] += 1

    # ---- 完整成交：下单 → 卖家确认 → 完成（商品变已售）----
    by_name = {p.name: p for p in prods}
    stats["orders"] = 0
    for username, pname in DEALS:
        buyer = users.get(username)
        product = by_name.get(pname)
        if buyer is None or product is None:
            continue
        if product.status != "on_sale" or product.seller_id == buyer.id:
            continue                          # 已售 / 自己的商品，跳过（幂等）
        if Order.query.filter_by(buyer_id=buyer.id, product_id=product.id).first():
            continue
        done_at = _when(now, rng)
        order = Order(
            order_no="PENDING", product_id=product.id, buyer_id=buyer.id,
            seller_id=product.seller_id, price=product.price,
            product_snapshot=product_snapshot(product), status="done",
            trade_note=DEAL_MARK, meet_place_id=product.default_place_id or _meet_place,
            created_at=done_at, finished_at=done_at + timedelta(hours=3),
        )
        db.session.add(order)
        db.session.flush()
        order.order_no = f"CM{done_at:%Y%m%d%H%M%S}{order.id:06d}"
        product.status = "sold"
        product.updated_at = done_at + timedelta(hours=3)
        stats["orders"] += 1

    db.session.commit()

    # ---- 成交商品的看图记录：给「图片风格 × 行为结果」提供正样本（幂等）----
    stats["deal_views"] = 0
    for username, pname in DEALS:
        buyer = users.get(username)
        product = Product.query.filter(Product.name == pname).first()
        if buyer is None or product is None:
            continue
        have = ProductImageView.query.filter_by(
            user_id=buyer.id, product_id=product.id).count()
        at = _when(now, rng)
        added = 0
        for idx in (0, 1):
            if have + added >= 2:
                break
            db.session.add(ProductImageView(
                user_id=buyer.id, product_id=product.id, image_index=idx,
                dwell_ms=rng.randint(3500, 11000),
                created_at=at + timedelta(seconds=10 * idx),
            ))
            added += 1
        stats["deal_views"] += added
    db.session.commit()

    stats["page_rows"] = UserActivity.query.filter(
        UserActivity.user_id.in_([users[u].id for u in ACCOUNTS if u in users])).count()
    return stats
