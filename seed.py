"""示例数据（种子数据）。

内容：管理员 + 演示用户、5 个分类与小类、校园地点库、16 件不同状态的商品、
订单与互评、收藏、交流广场帖子/评论/点赞、举报、以物换物。

用法：
    .venv\\Scripts\\python.exe seed.py          # 清空业务数据后重新写入
    from seed import seed_all; seed_all()       # 在代码里调用（管理员「重置示例数据」）

说明：
- 所有演示账号密码统一为 123456，便于验收演示。
- 校园地点经纬度为 GCJ-02 示例坐标（腾讯地图坐标系），可由管理员在
  「管理后台 → 基础数据」里修改成自己学校的真实坐标。
"""
from datetime import datetime, timedelta

from extensions import db
from models import (
    CampusPlace,
    Category,
    Favorite,
    Order,
    Post,
    PostComment,
    PostLike,
    Product,
    ProductImage,  # noqa: F401  (保留：后续生成示例图时会用到)
    Report,
    Review,
    Subcategory,
    SwapOffer,
    User,
)

DEMO_PASSWORD = "123456"

# ----------------------------------------------------------------- 分类与小类
CATEGORIES = [
    ("教材", "📚", 1, ["公共课教材", "专业课教材", "考研资料", "英语四六级"]),
    ("数码", "📱", 2, ["手机", "笔记本电脑", "平板", "耳机", "键盘鼠标"]),
    ("生活用品", "💡", 3, ["台灯", "收纳", "水壶", "小电器"]),
    ("运动", "🚲", 4, ["自行车", "球类", "健身器材", "运动鞋"]),
    ("其他", "📦", 5, ["票券", "乐器", "手办", "其他"]),
]

# ----------------------------------------------------------------- 校园地点
# 基准点：示例校园（GCJ-02）。东为正 lng，北为正 lat。
BASE_LNG, BASE_LAT = 114.4140000, 30.5110000
PLACES = [
    ("图书馆", "图书馆", 0.0004, 0.0006, 1),
    ("图书馆南门", "图书馆", 0.0004, -0.0002, 2),
    ("第一教学楼", "教学楼", -0.0012, 0.0010, 3),
    ("第二教学楼", "教学楼", -0.0008, 0.0016, 4),
    ("学生一食堂", "食堂", 0.0016, 0.0002, 5),
    ("学生二食堂", "食堂", 0.0012, -0.0009, 6),
    ("1 号宿舍楼", "宿舍", -0.0020, -0.0006, 7),
    ("3 号宿舍楼", "宿舍", -0.0024, 0.0004, 8),
    ("田径运动场", "运动场", 0.0026, 0.0012, 9),
    ("东区篮球场", "运动场", 0.0020, -0.0016, 10),
    ("大学生活动中心", "其他", 0.0002, 0.0018, 11),
    ("菜鸟驿站（校门口）", "其他", -0.0030, -0.0012, 12),
]

# ----------------------------------------------------------------- 演示用户
# (用户名, 昵称, 注册身份)
USERS = [
    ("admin", "平台管理员", "admin"),
    ("buyer1", "李小明", "buyer"),
    ("buyer2", "王芳", "buyer"),
    ("seller1", "陈同学", "seller"),
    ("seller2", "刘同学", "seller"),
    ("seller3", "赵同学", "seller"),
]

# ----------------------------------------------------------------- 商品
# (卖家, 分类, 小类, 名称, 价格, 成色, 状态, 浏览量, 默认自提点, 描述)
PRODUCTS = [
    ("seller1", "教材", "公共课教材", "高等数学（同济第七版）上下册", 25.00, "九成新", "on_sale", 132,
     "图书馆南门", "无笔记、无划线，书角略微磨损，内页干净。可拆开单卖。"),
    ("seller1", "教材", "考研资料", "考研英语一历年真题解析（2020-2025）", 45.00, "八成新", "on_sale", 88,
     "第二教学楼", "做过的部分已用铅笔擦除，答案册全新。"),
    ("seller2", "教材", "公共课教材", "大学物理实验报告册（全新未用）", 12.00, "全新", "sold", 41,
     "第一教学楼", "买重了，全新没用过。"),
    ("seller1", "数码", "耳机", "小米蓝牙耳机 Air2 SE", 79.00, "九成新", "on_sale", 210,
     "学生一食堂", "用了两个月，音质正常，包含充电盒。"),
    ("seller2", "数码", "平板", "iPad 第九代 64G WiFi 版", 1250.00, "八成新", "sold", 530,
     "图书馆", "屏幕无划痕，边角有轻微磕碰，送保护壳和钢化膜。"),
    ("seller3", "数码", "键盘鼠标", "罗技 K380 蓝牙键盘", 105.00, "九成新", "on_sale", 96,
     "3 号宿舍楼", "三模连接，键帽无磨损，含原装电池。"),
    ("seller2", "数码", "笔记本电脑", "联想小新 Air14 笔记本", 2100.00, "八成新", "off_shelf", 402,
     "图书馆", "配置 i5/16G/512G，电池健康度 86%。因换新机出售。"),
    ("seller3", "生活用品", "台灯", "护眼台灯（可调色温亮度）", 35.00, "九成新", "on_sale", 74,
     "1 号宿舍楼", "三档色温无极调光，USB 供电，含说明书。"),
    ("seller1", "生活用品", "收纳", "宿舍收纳箱三件套", 18.00, "八成新", "on_sale", 55,
     "3 号宿舍楼", "两个大号一个中号，可叠放，无异味。"),
    ("seller3", "生活用品", "小电器", "美的电热水壶 1.5L", 39.00, "九成新", "sold", 120,
     "学生二食堂", "304 不锈钢内胆，已除垢清洗。"),
    ("seller2", "运动", "自行车", "捷安特 ATX 山地自行车", 480.00, "七成新及以下", "on_sale", 288,
     "东区篮球场", "毕业出，车况良好，前后刹车刚换过，送车锁和打气筒。"),
    ("seller1", "运动", "球类", "斯伯丁篮球 7 号", 65.00, "八成新", "on_sale", 63,
     "东区篮球场", "室内外通用，气密性良好，打了半年。"),
    ("seller3", "运动", "健身器材", "哑铃一对 5kg（包胶）", 55.00, "九成新", "off_shelf", 37,
     "田径运动场", "包胶无磕碰，可拆片。"),
    ("seller2", "其他", "乐器", "民谣吉他 41 寸（含琴包）", 320.00, "八成新", "on_sale", 165,
     "大学生活动中心", "云杉面板，手感不错，送变调夹、拨片和备用弦。"),
    ("seller3", "其他", "票券", "校园音乐节门票 2 张", 15.00, "全新", "on_sale", 22,
     "大学生活动中心", "本周六晚 19:00，有事去不了，原价转。"),
    ("seller1", "生活用品", "水壶", "保温杯 500ml", 8.00, "全新", "on_sale", 19,
     "菜鸟驿站（校门口）", "全新未拆封，颜色为浅绿。"),
]

# ----------------------------------------------------------------- 订单
# (订单序号, 商品名, 买家, 状态, 交易说明, 自提点, 下单距今天数, 买家偏移, 卖家偏移)
ORDERS = [
    ("大学物理实验报告册（全新未用）", "buyer2", "pending", "今天下午 4 点后都行，到了微信联系。",
     "第一教学楼", 1, (0.0006, 0.0004), (-0.0009, 0.0012)),
    ("iPad 第九代 64G WiFi 版", "buyer1", "done", "校内自提，当面验机。",
     "图书馆", 9, (0.0012, -0.0006), (0.0004, 0.0006)),
    ("美的电热水壶 1.5L", "buyer2", "done", "晚饭后在食堂门口见。",
     "学生二食堂", 5, (0.0010, -0.0011), (0.0012, -0.0009)),
]

# ----------------------------------------------------------------- 评价
# (订单序号, 评价人, 被评价人, 星级, 内容)
REVIEWS = [
    (1, "buyer1", "seller2", 5, "卖家很爽快，机器和描述一致，还送了保护壳，推荐。"),
    (1, "seller2", "buyer1", 5, "买家守时，沟通顺畅，交易愉快。"),
    (2, "buyer2", "seller3", 4, "水壶成色不错，就是约的时间稍微晚了一点。"),
]

# ----------------------------------------------------------------- 收藏
FAVORITES = [
    ("buyer1", "高等数学（同济第七版）上下册"),
    ("buyer1", "小米蓝牙耳机 Air2 SE"),
    ("buyer1", "民谣吉他 41 寸（含琴包）"),
    ("buyer2", "捷安特 ATX 山地自行车"),
    ("buyer2", "护眼台灯（可调色温亮度）"),
]

# ----------------------------------------------------------------- 帖子
POSTS = [
    ("seller1", "安利", "图书馆三楼靠窗的自习位太香了",
     "下午有阳光但不晒，插座就在桌边，桌子也大，摊开两本书加电脑完全够用。想安静复习的同学可以早点去占位。"),
    ("buyer1", "避雷", "别买某宝 9.9 包邮的充电宝",
     "上周图便宜买了一个，用两次就鼓包了，现在只能退货。这种带电池的东西还是买正规品牌吧，二手也要看成色和批次。"),
    ("seller2", "闲聊", "有一起打羽毛球的吗",
     "每周二、四晚上 7 点在体育馆，目前固定 4 个人，还差 1-2 个，水平一般般，纯娱乐。"),
    ("buyer2", "求助", "求推荐便宜好用的宿舍台灯",
     "预算 50 以内，主要晚上看书用，希望能调光，不要闪眼睛的那种。有同学用过不错的型号吗？"),
]

# (帖子序号, 评论人, 内容)
COMMENTS = [
    (0, "buyer2", "同意，三楼比二楼安静多了。"),
    (0, "seller3", "补充一句：四楼最近装修，别去。"),
    (1, "seller3", "感谢提醒，我正好在看便宜的。"),
    (2, "buyer1", "我报名！不过这周四有课，周二来。"),
    (3, "seller3", "我这儿有个闲置的护眼台灯，可以看看我的商品。"),
]

# (帖子序号, 点赞人)
LIKES = [
    (0, "buyer1"), (0, "buyer2"), (0, "seller2"), (0, "seller3"),
    (1, "buyer2"), (1, "seller1"),
    (2, "buyer1"), (2, "seller1"), (2, "seller2"),
    (3, "seller1"),
]

# ----------------------------------------------------------------- 举报
# (类型, 目标名, 举报人, 理由)
REPORTS = [
    ("product", "校园音乐节门票 2 张", "buyer1", "价格欺诈：怀疑是黄牛票，要求核实票源。"),
    ("post", "别买某宝 9.9 包邮的充电宝", "seller3", "其他：帖子内容带有明显引流嫌疑。"),
]

# ----------------------------------------------------------------- 以物换物
# (发起人, 商品名, 标题, 估价)
SWAPS = [
    ("seller1", "高等数学（同济第七版）上下册", "高数教材换考研资料", 25.00),
    ("seller3", "宿舍收纳箱三件套", "收纳箱换小台灯", 22.00),
    ("seller2", "斯伯丁篮球 7 号", "篮球换羽毛球拍", 65.00),
    ("seller1", "保温杯 500ml", "全新保温杯换小风扇", 9.00),
]


# ================================================================= 写入逻辑
def wipe() -> None:
    """按外键依赖顺序清空全部业务数据。"""
    for model in (
        Report, Review, Favorite, SwapOffer, PostLike, PostComment, Order, Post,
        ProductImage, Product, CampusPlace, Subcategory, Category, User,
    ):
        db.session.query(model).delete()
    db.session.commit()
    db.session.execute(db.text("ALTER TABLE users AUTO_INCREMENT = 1"))
    for table in ("categories", "subcategories", "campus_places", "products",
                  "orders", "reviews", "reports", "swap_offers", "posts",
                  "post_comments", "post_likes", "favorites", "product_images"):
        db.session.execute(db.text(f"ALTER TABLE {table} AUTO_INCREMENT = 1"))
    db.session.commit()


def seed_all(reset: bool = True) -> dict:
    """写入示例数据，返回统计信息。"""
    if reset:
        wipe()

    # ---- 用户 ----
    users: dict[str, User] = {}
    for username, nickname, role in USERS:
        u = User(username=username, nickname=nickname, role=role, credit=5.0)
        u.set_password(DEMO_PASSWORD)
        db.session.add(u)
        users[username] = u
    db.session.flush()

    # ---- 分类与小类 ----
    subs: dict[tuple[str, str], Subcategory] = {}
    cats: dict[str, Category] = {}
    for name, icon, sort, sub_names in CATEGORIES:
        c = Category(name=name, icon=icon, sort=sort)
        db.session.add(c)
        db.session.flush()
        cats[name] = c
        for sub_name in sub_names:
            s = Subcategory(category_id=c.id, name=sub_name)
            db.session.add(s)
            db.session.flush()
            subs[(name, sub_name)] = s

    # ---- 校园地点 ----
    places: dict[str, CampusPlace] = {}
    for name, ptype, dx, dy, sort in PLACES:
        p = CampusPlace(
            name=name, type=ptype, sort=sort,
            lng=round(BASE_LNG + dx, 7), lat=round(BASE_LAT + dy, 7),
        )
        db.session.add(p)
        db.session.flush()
        places[name] = p

    # ---- 商品 ----
    now = datetime.now()
    base_time = now - timedelta(days=30)
    products: dict[str, Product] = {}
    for idx, (seller, cat, sub, name, price, cond, status, views, place, desc) in enumerate(PRODUCTS):
        p = Product(
            seller_id=users[seller].id,
            category_id=cats[cat].id,
            subcategory_id=subs[(cat, sub)].id,
            name=name, price=price, condition=cond, status=status, views=views,
            description=desc, default_place_id=places[place].id,
            created_at=base_time + timedelta(days=idx, hours=idx * 2),
            updated_at=base_time + timedelta(days=idx, hours=idx * 2),
        )
        db.session.add(p)
        db.session.flush()
        products[name] = p

    # ---- 订单（商品状态与订单联动）----
    orders: dict[int, Order] = {}
    for idx, (pname, buyer, status, note, place, days_ago, buyer_off, seller_off) in enumerate(ORDERS):
        p = products[pname]
        p.status = "sold"
        created = now - timedelta(days=days_ago, hours=2)
        order = Order(
            order_no=f"CM{created:%Y%m%d%H%M%S}{idx + 1:04d}",
            product_id=p.id,
            buyer_id=users[buyer].id,
            seller_id=p.seller_id,
            price=p.price,
            product_snapshot=snapshot(p),
            status=status,
            trade_note=note,
            meet_place_id=places[place].id,
            buyer_lng=round(BASE_LNG + buyer_off[0], 7),
            buyer_lat=round(BASE_LAT + buyer_off[1], 7),
            seller_lng=round(BASE_LNG + seller_off[0], 7),
            seller_lat=round(BASE_LAT + seller_off[1], 7),
            created_at=created,
            finished_at=created + timedelta(hours=6) if status == "done" else None,
        )
        db.session.add(order)
        db.session.flush()
        orders[idx + 1] = order

    # ---- 评价 ----
    for order_idx, reviewer, reviewee, rating, content in REVIEWS:
        order = orders[order_idx]
        db.session.add(Review(
            order_id=order.id, product_id=order.product_id,
            reviewer_id=users[reviewer].id, reviewee_id=users[reviewee].id,
            rating=rating, content=content,
            created_at=(order.finished_at or order.created_at) + timedelta(hours=1),
        ))

    # ---- 收藏 ----
    for username, pname in FAVORITES:
        db.session.add(Favorite(user_id=users[username].id, product_id=products[pname].id))

    # ---- 帖子 / 评论 / 点赞 ----
    posts = []
    for idx, (author, tag, title, content) in enumerate(POSTS):
        post = Post(
            author_id=users[author].id, title=title, content=content, tag=tag,
            created_at=now - timedelta(days=len(POSTS) - idx, hours=idx * 3),
        )
        db.session.add(post)
        db.session.flush()
        posts.append(post)
    for post_idx, author, content in COMMENTS:
        db.session.add(PostComment(
            post_id=posts[post_idx].id, author_id=users[author].id, content=content,
        ))
    for post_idx, username in LIKES:
        db.session.add(PostLike(post_id=posts[post_idx].id, user_id=users[username].id))

    # ---- 举报 ----
    for target_type, target_name, reporter, reason in REPORTS:
        kwargs = {"reporter_id": users[reporter].id, "reason": reason, "status": "pending"}
        if target_type == "product":
            kwargs["product_id"] = products[target_name].id
        else:
            kwargs["post_id"] = next(p.id for p in posts if p.title == target_name)
        db.session.add(Report(**kwargs))

    # ---- 以物换物 ----
    for username, pname, title, estimate in SWAPS:
        db.session.add(SwapOffer(
            user_id=users[username].id, product_id=products[pname].id,
            title=title, estimate_price=estimate, status="open",
        ))

    db.session.commit()

    stats = {
        "users": User.query.count(),
        "categories": Category.query.count(),
        "subcategories": Subcategory.query.count(),
        "campus_places": CampusPlace.query.count(),
        "products": Product.query.count(),
        "products_on_sale": Product.query.filter_by(status="on_sale").count(),
        "orders": Order.query.count(),
        "reviews": Review.query.count(),
        "favorites": Favorite.query.count(),
        "posts": Post.query.count(),
        "comments": PostComment.query.count(),
        "likes": PostLike.query.count(),
        "reports": Report.query.count(),
        "swaps": SwapOffer.query.count(),
    }
    return stats


def snapshot(product: Product) -> dict:
    """下单时冻结商品信息，商品被删除后订单仍可完整显示。"""
    return {
        "id": product.id,
        "name": product.name,
        "price": float(product.price),
        "condition": product.condition,
        "cover": product.images[0].url if product.images else None,
        "category_name": product.category.name if product.category else None,
        "category_icon": product.category.icon if product.category else "",
        "subcategory_name": product.subcategory.name if product.subcategory else None,
        "seller_nickname": product.seller.nickname if product.seller else None,
    }


if __name__ == "__main__":
    from app import create_app

    application = create_app()
    with application.app_context():
        result = seed_all(reset=True)
        print("示例数据写入完成：")
        for key, value in result.items():
            print(f"  {key:<20} {value}")
