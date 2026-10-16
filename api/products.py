"""M02 首页 / M03 搜索与筛选（数据交叉筛选）/ M04 商品详情 / M09 发布与管理商品。"""
import os
import uuid
from datetime import datetime

from flask import Blueprint, current_app, request
from sqlalchemy import or_

import audit
import product_code
from api.common import (
    arg_float, arg_int, arg_str, current_user, fail, json_body, login_required,
    ok, paginate_args,
)
from config import Config
from extensions import db
from models import (
    Category, Favorite, Message, Order, Product, ProductImage, ProductWant, Report, Review,
    Subcategory, SwapOffer, User,
    PRODUCT_DELETED, PRODUCT_OFF_SHELF, PRODUCT_ON_SALE, PRODUCT_SOLD, ROLE_ADMIN,
)
from rating import seller_rating
from api.social import hidden_author_ids, social_state

bp = Blueprint("products", __name__, url_prefix="/api")

SORTS = {
    "newest": lambda: Product.created_at.desc(),
    "price_asc": lambda: Product.price.asc(),
    "price_desc": lambda: Product.price.desc(),
    "views": lambda: Product.views.desc(),
}


# ------------------------------------------------------------------ 首页
@bp.get("/home")
def home():
    """首页聚合：分类入口 + 最新上架 + 平台概况。"""
    cats = Category.query.order_by(Category.sort, Category.id).all()
    newest = (
        Product.query.filter(Product.status == PRODUCT_ON_SALE)
        .order_by(Product.created_at.desc())
        .limit(8)
        .all()
    )
    return ok(
        {
            "categories": [c.to_dict() for c in cats],
            "newest": [p.to_dict() for p in newest],
            "stats": {
                "on_sale": Product.query.filter(Product.status == PRODUCT_ON_SALE).count(),
                "sold": Product.query.filter(Product.status == PRODUCT_SOLD).count(),
            },
        }
    )


# ------------------------------------------------------------------ 交叉筛选
@bp.get("/products")
def list_products():
    """数据交叉筛选：多个条件之间是 AND 叠加，可任意组合；只返回「在售」商品。

    支持参数：keyword / category_id / subcategory_id / min_price / max_price /
             condition / sort / page / page_size
    """
    page, size = paginate_args(Config.DEFAULT_PAGE_SIZE)

    q = Product.query.filter(Product.status == PRODUCT_ON_SALE)

    # 新批需求⑦：我拉黑过的人，他的商品在列表与搜索里都不出现
    _viewer = current_user()
    if _viewer:
        _hidden = hidden_author_ids(_viewer.id)
        if _hidden:
            q = q.filter(~Product.seller_id.in_(_hidden))

    keyword = arg_str("keyword")
    if keyword:
        like = f"%{keyword}%"
        # 关键词同时匹配：商品名、描述、分类名、小类名。
        # 说明：功能文档 7.4 的示例 SQL 只匹配 p.name；这里做超集扩展，
        # 让搜「教材」这类分类词也能命中，筛选结果更符合直觉。
        q = q.filter(
            or_(
                Product.name.like(like),
                Product.description.like(like),
                Product.category.has(Category.name.like(like)),
                Product.subcategory.has(Subcategory.name.like(like)),
            )
        )

    category_id = arg_int("category_id")
    if category_id:
        q = q.filter(Product.category_id == category_id)

    subcategory_id = arg_int("subcategory_id")
    if subcategory_id:
        q = q.filter(Product.subcategory_id == subcategory_id)

    min_price = arg_float("min_price")
    if min_price is not None:
        q = q.filter(Product.price >= min_price)

    max_price = arg_float("max_price")
    if max_price is not None:
        q = q.filter(Product.price <= max_price)

    condition = arg_str("condition")
    if condition:
        if condition not in Config.CONDITIONS:
            return fail("成色取值不合法")
        q = q.filter(Product.condition == condition)

    seller_id = arg_int("seller_id")
    if seller_id:
        q = q.filter(Product.seller_id == seller_id)

    sort = arg_str("sort") or "newest"
    order = SORTS.get(sort, SORTS["newest"])()

    total = q.count()
    items = q.order_by(order).offset((page - 1) * size).limit(size).all()

    viewer = current_user()
    viewer_id = viewer.id if viewer else None
    return ok(
        {
            "list": [p.to_dict(viewer_id=viewer_id) for p in items],
            "total": total,
            "page": page,
            "page_size": size,
            "pages": max(1, (total + size - 1) // size),
            "filters": {
                "keyword": keyword or "",
                "category_id": category_id,
                "subcategory_id": subcategory_id,
                "min_price": min_price,
                "max_price": max_price,
                "condition": condition or "",
                "sort": sort,
            },
        }
    )


# ------------------------------------------------------------------ 卖家：我的商品
@bp.get("/products/mine")
@login_required
def my_products():
    user = current_user()
    page, size = paginate_args(Config.DEFAULT_PAGE_SIZE)
    status = arg_str("status") or "all"
    if status not in ("all", PRODUCT_ON_SALE, PRODUCT_SOLD, PRODUCT_OFF_SHELF, PRODUCT_DELETED):
        return fail("状态取值不合法")

    q = Product.query.filter(Product.seller_id == user.id)
    if status == "all":
        # 「全部」不包含已删除的商品；要处理已删除记录请切到「已删除」页签
        q = q.filter(Product.status != PRODUCT_DELETED)
    else:
        q = q.filter(Product.status == status)

    total = q.count()
    items = q.order_by(Product.created_at.desc()).offset((page - 1) * size).limit(size).all()

    # 需求⑥：已售商品要能在「我的商品」里直接收尾交易，所以把对应订单一并带出去
    # （只针对已售商品查，列表不大；不做进 to_dict 是为了避免所有商品列表都跟着 N+1）
    payload = []
    for product in items:
        data = product.to_dict()
        if product.status == PRODUCT_SOLD:
            order = (Order.query.filter_by(product_id=product.id)
                     .order_by(Order.created_at.desc()).first())
            if order is not None:
                data["order_id"] = order.id
                data["order_no"] = order.order_no
                data["order_status"] = order.status
                data["order_status_text"] = order.STATUS_TEXT.get(order.status, order.status)
                data["order_seller_deleted"] = bool(order.seller_deleted)
        payload.append(data)

    counts = {
        "all": Product.query.filter(Product.seller_id == user.id,
                                    Product.status != PRODUCT_DELETED).count(),
        PRODUCT_ON_SALE: Product.query.filter_by(seller_id=user.id, status=PRODUCT_ON_SALE).count(),
        PRODUCT_SOLD: Product.query.filter_by(seller_id=user.id, status=PRODUCT_SOLD).count(),
        PRODUCT_OFF_SHELF: Product.query.filter_by(seller_id=user.id, status=PRODUCT_OFF_SHELF).count(),
        PRODUCT_DELETED: Product.query.filter_by(seller_id=user.id, status=PRODUCT_DELETED).count(),
    }
    return ok({"list": payload, "total": total,
               "page": page, "page_size": size, "counts": counts})


# ------------------------------------------------------------------ 商品详情
@bp.get("/products/<int:pid>")
def product_detail(pid: int):
    product = Product.query.get(pid)
    if product is None or product.status == PRODUCT_DELETED:
        return fail("商品不存在或已下架", 404)

    # 新批需求⑦：我拉黑过的人，他的商品对我不可见（含直接点链接进来）
    _viewer = current_user()
    if _viewer and product.seller_id in hidden_author_ids(_viewer.id):
        return fail("商品不存在或已下架", 404)

    # 每打开一次浏览量 +1（功能文档 5.2.3）
    product.views = (product.views or 0) + 1
    db.session.commit()

    user = current_user()
    viewer_id = user.id if user else None
    data = product.to_dict(detail=True, viewer_id=viewer_id)
    data["is_owner"] = bool(user and user.id == product.seller_id)
    data["is_admin"] = bool(user and user.role == ROLE_ADMIN)
    data["favorited"] = bool(
        user and Favorite.query.filter_by(user_id=user.id, product_id=product.id).first()
    )
    data["can_buy"] = (
        product.status == PRODUCT_ON_SALE
        and (user is None or user.id != product.seller_id)
    )
    reviews = (
        Review.query.filter_by(product_id=product.id)
        .order_by(Review.created_at.desc()).all()
    )
    data["reviews"] = [r.to_dict(user.id if user else None) for r in reviews]
    data["review_count"] = len(reviews)
    data["avg_rating"] = (
        round(sum(r.rating for r in reviews) / len(reviews), 1) if reviews else None
    )
    # 需求③：商品详情页也要显示卖家的好评率与分级（买家下单前最需要这个）
    data["seller_rating"] = seller_rating(product.seller_id)
    return ok(data)


@bp.get("/sellers/<int:uid>")
def seller_profile(uid: int):
    """需求②：卖家商品主页的数据。

    - 卖家公开信息：昵称、头像、商家简介、加入时间、卖家编号（脱敏序号）；
      刻意**不返回** username / credit —— 前者是登录名，后者按约定不参与规则。
    - 商品列表：默认「在售」，可切「已售」（当作成交记录看）；
      已下架与已删除的商品不展示。支持关键词与分类筛选。
    """
    seller = User.query.get(uid)
    if seller is None or seller.role == ROLE_ADMIN:
        return fail("卖家不存在", 404)

    # 新批需求⑦：被我拉黑的人——主页还能打开（不然我会以为"用户没了"），
    # 但**看不到他任何商品**，并明确告诉我这是因为我拉黑了他。
    _me = current_user()
    _blocked_by_me = bool(_me and uid in hidden_author_ids(_me.id))

    status = arg_str("status") or PRODUCT_ON_SALE
    if status not in (PRODUCT_ON_SALE, PRODUCT_SOLD):
        return fail("只能查看「在售」或「已售」的商品")

    q = Product.query.filter(Product.seller_id == uid, Product.status == status)
    keyword = arg_str("keyword")
    if keyword:
        like = f"%{keyword}%"
        q = q.filter(or_(Product.name.like(like), Product.description.like(like)))
    category_id = arg_int("category_id")
    if category_id:
        q = q.filter(Product.category_id == category_id)

    page, size = paginate_args(12)
    total = q.count()
    items = (q.order_by(Product.created_at.desc())
             .offset((page - 1) * size).limit(size).all())

    counts = {
        "on_sale": Product.query.filter_by(seller_id=uid, status=PRODUCT_ON_SALE).count(),
        "sold": Product.query.filter_by(seller_id=uid, status=PRODUCT_SOLD).count(),
    }
    return ok({
        "seller": {
            "id": seller.id,
            "nickname": seller.nickname,
            "avatar": seller.avatar or None,
            "bio": seller.bio or None,
            "seller_code": f"{seller.seller_seq:04d}" if seller.seller_seq else None,
            "joined_at": (seller.created_at.strftime("%Y-%m-%d")
                          if seller.created_at else None),
            # 需求③：好评率与分级（只算「买家评卖家」的那一半）
            "rating": seller_rating(seller.id),
        },
        # 新批需求⑦：关注/拉黑状态与关注、粉丝数
        "social": social_state(_me.id if _me else None, uid),
        "blocked_by_me": _blocked_by_me,
        "counts": counts,
        "list": [] if _blocked_by_me else [p.to_dict() for p in items],
        "total": 0 if _blocked_by_me else total,
        "page": page, "page_size": size,
    })


@bp.get("/products/<int:pid>/reviews")
def product_reviews(pid: int):
    if Product.query.get(pid) is None:
        return fail("商品不存在", 404)
    user = current_user()
    reviews = (Review.query.filter_by(product_id=pid)
               .order_by(Review.created_at.desc()).all())
    return ok([r.to_dict(user.id if user else None) for r in reviews])


# ------------------------------------------------------------------ 我想要（功能③）
@bp.post("/products/<int:pid>/want")
@login_required
def toggle_want(pid: int):
    """点一次标记「我想要」，再点一次取消；返回最新的想要人数。"""
    user = current_user()
    product = Product.query.get(pid)
    if product is None or product.status == PRODUCT_DELETED:
        return fail("商品不存在或已下架", 404)
    if product.seller_id == user.id:
        return fail("不能对自己发布的商品点「我想要」")

    existing = ProductWant.query.filter_by(user_id=user.id, product_id=product.id).first()
    if existing:
        db.session.delete(existing)
        wanted = False
    else:
        db.session.add(ProductWant(user_id=user.id, product_id=product.id))
        wanted = True
    db.session.commit()

    count = ProductWant.query.filter_by(product_id=product.id).count()
    return ok({"wanted": wanted, "want_count": count},
              msg="已标记「我想要」" if wanted else "已取消「我想要」")


@bp.get("/products/<int:pid>/wants")
def product_wants(pid: int):
    """谁想要这件商品（游客可看人数，登录后能看名单）。"""
    if Product.query.get(pid) is None:
        return fail("商品不存在", 404)
    wants = (ProductWant.query.filter_by(product_id=pid)
             .order_by(ProductWant.created_at.desc()).all())
    return ok({"count": len(wants), "list": [w.to_dict() for w in wants]})


# ------------------------------------------------------------------ 发布 / 编辑
def _parse_product_body(body: dict) -> tuple[dict, str | None]:
    """校验并规整商品字段，返回 (字段字典, 错误信息)。"""
    data: dict = {}

    name = (body.get("name") or "").strip()
    if not name:
        return {}, "商品名称不能为空"
    if len(name) > 100:
        return {}, "商品名称不能超过 100 个字符"
    data["name"] = name

    try:
        price = float(body.get("price"))
    except (TypeError, ValueError):
        return {}, "价格必须是数字"
    if price <= 0:
        return {}, "价格必须大于 0"
    if price > 9_999_999:
        return {}, "价格超出允许范围"
    data["price"] = round(price, 2)

    category_id = body.get("category_id")
    if not category_id or Category.query.get(int(category_id)) is None:
        return {}, "请选择有效的分类"
    data["category_id"] = int(category_id)

    subcategory_id = body.get("subcategory_id")
    if subcategory_id in (None, "", 0):
        data["subcategory_id"] = None
    else:
        data["subcategory_id"] = int(subcategory_id)

    condition = (body.get("condition") or "").strip()
    if condition not in Config.CONDITIONS:
        return {}, "请选择有效的成色"
    data["condition"] = condition

    description = (body.get("description") or "").strip()
    data["description"] = description[:5000]

    place_id = body.get("default_place_id")
    data["default_place_id"] = int(place_id) if place_id not in (None, "", 0) else None

    images = body.get("images") or []
    if not isinstance(images, list):
        return {}, "图片参数格式不正确"
    images = [str(i) for i in images if str(i).strip()]
    if len(images) > Config.MAX_IMAGES_PER_PRODUCT:
        return {}, f"最多上传 {Config.MAX_IMAGES_PER_PRODUCT} 张图片"
    data["images"] = images

    return data, None


def _replace_images(product: Product, filenames: list[str]) -> None:
    ProductImage.query.filter_by(product_id=product.id).delete()
    for idx, filename in enumerate(filenames):
        db.session.add(ProductImage(product_id=product.id, url=filename, sort=idx))


@bp.post("/products")
@login_required
def create_product():
    user = current_user()
    if user.role == ROLE_ADMIN:
        return fail("管理员不发布商品，请使用普通账号", 403)

    data, error = _parse_product_body(json_body())
    if error:
        return fail(error)

    images = data.pop("images")
    product = Product(seller_id=user.id, status=PRODUCT_ON_SALE, views=0, **data)
    # 商品编号：同一事务内、入库前生成（生成逻辑统一在 product_code.py）
    product.product_code = product_code.assign_for(user, product)
    db.session.add(product)
    db.session.flush()
    _replace_images(product, images)
    audit.record("product_create", "product", product.id,
                 f"发布商品「{product.name}」（{product.product_code}，¥{product.price}）")
    db.session.commit()
    return ok(product.to_dict(detail=True), msg="发布成功")


@bp.put("/products/<int:pid>")
@login_required
def update_product(pid: int):
    product = Product.query.get(pid)
    if product is None or product.status == PRODUCT_DELETED:
        return fail("商品不存在", 404)

    user = current_user()
    if user.role != ROLE_ADMIN and product.seller_id != user.id:
        return fail("只能编辑自己发布的商品", 403)

    data, error = _parse_product_body(json_body())
    if error:
        return fail(error)

    # 不可变约定：编辑接口忽略并丢弃前端可能传来的 product_code / seller_seq，
    # _parse_product_body 只挑已知字段，所以这里天然不会被覆盖。
    data.pop("product_code", None)

    images = data.pop("images")
    for key, value in data.items():
        setattr(product, key, value)
    _replace_images(product, images)
    audit.record("product_update", "product", product.id,
                 f"编辑商品「{product.name}」（{product.product_code}，¥{product.price}）")
    db.session.commit()
    return ok(product.to_dict(detail=True), msg="保存成功")


@bp.patch("/products/<int:pid>/status")
@login_required
def change_product_status(pid: int):
    """上下架 / 重新上架。已售商品不能改回在售（二手物品只有一件）。"""
    product = Product.query.get(pid)
    if product is None or product.status == PRODUCT_DELETED:
        return fail("商品不存在", 404)

    user = current_user()
    if user.role != ROLE_ADMIN and product.seller_id != user.id:
        return fail("只能操作自己发布的商品", 403)

    target = (json_body().get("status") or "").strip()
    if target not in (PRODUCT_ON_SALE, PRODUCT_OFF_SHELF):
        return fail("只能切换到「在售」或「已下架」")
    if product.status == PRODUCT_SOLD:
        return fail("该商品已售出，不能重新上架；如有需要请重新发布")

    product.status = target
    audit.record(f"product_{'on' if target == PRODUCT_ON_SALE else 'off'}", "product", product.id,
                 f"{'上架' if target == PRODUCT_ON_SALE else '下架'}商品「{product.name}」")
    db.session.commit()
    return ok(product.to_dict(), msg="已重新上架" if target == PRODUCT_ON_SALE else "已下架")


@bp.delete("/products/<int:pid>")
@login_required
def delete_product(pid: int):
    """软删除：只改状态，历史订单靠 product_snapshot 仍可完整显示。"""
    product = Product.query.get(pid)
    if product is None or product.status == PRODUCT_DELETED:
        return fail("商品不存在", 404)

    user = current_user()
    if user.role != ROLE_ADMIN and product.seller_id != user.id:
        return fail("只能删除自己发布的商品", 403)

    product.status = PRODUCT_DELETED
    # 商品已删除，相关收藏与「我想要」一并清掉
    Favorite.query.filter_by(product_id=product.id).delete()
    ProductWant.query.filter_by(product_id=product.id).delete()
    audit.record("product_delete", "product", product.id,
                 f"删除商品「{product.name}」（{product.product_code}）")
    db.session.commit()
    return ok(msg="商品已删除")


@bp.delete("/products/<int:pid>/record")
@login_required
def delete_product_record(pid: int):
    """彻底删除一条「已删除」的商品记录（功能④，卖家本人 / 管理员）。

    规则：
    - 只有在售/已售/已下架商品先软删除之后，才允许彻底删记录；
    - **有交易记录（订单）的商品不允许彻底删除**——历史订单必须保留商品信息，
      否则买家/卖家的成交记录就无从回溯。
    """
    user = current_user()
    product = Product.query.get(pid)
    if product is None:
        return fail("商品记录不存在", 404)
    if user.role != ROLE_ADMIN and product.seller_id != user.id:
        return fail("只能删除自己发布的商品记录", 403)
    if product.status != PRODUCT_DELETED:
        return fail("只能删除「已删除」状态的商品记录；在售 / 已售商品请先删除")

    order_count = Order.query.filter_by(product_id=product.id).count()
    if order_count:
        return fail(
            f"这件商品有 {order_count} 笔交易记录，历史订单需要保留商品信息，不能彻底删除"
        )

    # 没有交易记录，说明没有任何需要留档的数据，可以把所有引用它的行一并清掉
    ProductImage.query.filter_by(product_id=product.id).delete()
    Favorite.query.filter_by(product_id=product.id).delete()
    ProductWant.query.filter_by(product_id=product.id).delete()
    SwapOffer.query.filter_by(product_id=product.id).delete()
    Report.query.filter_by(product_id=product.id).delete()
    Review.query.filter_by(product_id=product.id).delete()
    # 私信里的商品卡片：**保留聊天记录**，只把 product_id 摘掉（否则外键会挡住彻底删除；
    # 卡片本身靠 messages.product_snapshot 继续显示）。新批需求④ 顺带补的既有漏洞。
    Message.query.filter_by(product_id=product.id).update(
        {Message.product_id: None}, synchronize_session=False)
    db.session.delete(product)
    audit.record("product_purge", "product", pid,
                 f"彻底删除商品记录「{product.name}」（{product.product_code}）")
    db.session.commit()
    return ok(msg="商品记录已彻底删除")


# ------------------------------------------------------------------ 图片上传
@bp.post("/upload")
@login_required
def upload_image():
    file = request.files.get("file")
    if file is None or not file.filename:
        return fail("请选择要上传的图片")

    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else ""
    if ext not in Config.ALLOWED_IMAGE_EXT:
        return fail("只支持 jpg / png / webp 格式的图片")

    file.seek(0, os.SEEK_END)
    size = file.tell()
    file.seek(0)
    if size <= 0:
        return fail("图片内容为空")
    if size > Config.MAX_IMAGE_SIZE:
        return fail(f"单张图片不能超过 {Config.MAX_IMAGE_SIZE // 1024 // 1024} MB")

    filename = f"{uuid.uuid4().hex}.{ext}"
    file.save(os.path.join(current_app.config["UPLOAD_FOLDER"], filename))
    return ok({"url": filename}, msg="上传成功")
