"""M06 下单与订单。

并发与一致性要点（功能文档 7.7）：
- 下单时用「带条件的 UPDATE」把商品从 on_sale 改 sold，靠 affected rows 判断是否抢到，
  可避免两个人同时下单把同一件二手物品卖两次；
- 「商品变已售 + 插入订单」在同一次事务里提交，失败一起回滚；
- 取消订单时「订单变已取消 + 商品恢复在售」同样在同一事务。
"""
from datetime import datetime

from flask import Blueprint

from api.common import (
    arg_str, current_user, fail, haversine_m, json_body, login_required,
    midpoint, nearest_place, ok, paginate_args,
)
from config import Config
from extensions import db
from models import (
    CampusPlace, Order, Product, User,
    ORDER_CANCELED, ORDER_DONE, ORDER_PENDING,
    PRODUCT_ON_SALE, PRODUCT_SOLD, ROLE_ADMIN,
)

bp = Blueprint("orders", __name__, url_prefix="/api")

STATUSES = (ORDER_PENDING, ORDER_DONE, ORDER_CANCELED)


def product_snapshot(product: Product) -> dict:
    """下单瞬间冻结商品信息，商品之后被删除也还能完整显示。"""
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


def _visible_order(order_id: int) -> tuple[Order | None, str | None]:
    """取订单并校验当前用户可见（买家 / 卖家 / 管理员）。"""
    order = Order.query.get(order_id)
    if order is None:
        return None, "订单不存在"
    user = current_user()
    if user is None:
        return None, "请先登录"
    if user.role != ROLE_ADMIN and user.id not in (order.buyer_id, order.seller_id):
        return None, "无权查看该订单"
    return order, None


# ------------------------------------------------------------------ 下单
@bp.post("/orders")
@login_required
def create_order():
    user = current_user()
    body = json_body()

    product_id = body.get("product_id")
    if not product_id:
        return fail("请指定要购买的商品")
    product = Product.query.get(int(product_id))
    if product is None:
        return fail("商品不存在", 404)
    if product.status != PRODUCT_ON_SALE:
        return fail("该商品已售出或已下架，无法下单", 409)
    if product.seller_id == user.id:
        return fail("不能购买自己发布的商品")

    meet_place_id = body.get("meet_place_id") or product.default_place_id
    if not meet_place_id:
        return fail("请选择约定的自提点")
    place = CampusPlace.query.get(int(meet_place_id))
    if place is None:
        return fail("自提点不存在")

    trade_note = (body.get("trade_note") or "").strip()[:255]

    # 条件更新：只有仍为「在售」时才抢得到这件商品
    affected = (
        db.session.query(Product)
        .filter(Product.id == product.id, Product.status == PRODUCT_ON_SALE)
        .update({Product.status: PRODUCT_SOLD}, synchronize_session=False)
    )
    if affected == 0:
        db.session.rollback()
        return fail("手慢了一步，该商品已被他人买走", 409)

    db.session.refresh(product)
    order = Order(
        order_no="PENDING",
        product_id=product.id,
        buyer_id=user.id,
        seller_id=product.seller_id,
        price=product.price,
        product_snapshot=product_snapshot(product),
        status=ORDER_PENDING,
        trade_note=trade_note or None,
        meet_place_id=place.id,
    )
    db.session.add(order)
    db.session.flush()
    order.order_no = f"CM{datetime.now():%Y%m%d%H%M%S}{order.id:06d}"
    db.session.commit()

    return ok(order.to_dict(user.id), msg="下单成功，请与卖家约定时间自提")


# ------------------------------------------------------------------ 订单列表
@bp.get("/orders/mine")
@login_required
def my_orders():
    user = current_user()
    page, size = paginate_args(Config.DEFAULT_PAGE_SIZE)
    status = arg_str("status") or "all"
    if status not in ("all",) + STATUSES:
        return fail("状态取值不合法")

    # 买家自己删掉的订单记录不再显示（只影响买家侧，卖家与管理员照常可见）
    visible = (Order.buyer_id == user.id, Order.buyer_deleted.is_(False))
    q = Order.query.filter(*visible)
    if status != "all":
        q = q.filter(Order.status == status)
    total = q.count()
    items = q.order_by(Order.created_at.desc()).offset((page - 1) * size).limit(size).all()

    counts = {
        "all": Order.query.filter(*visible).count(),
        ORDER_PENDING: Order.query.filter(*visible, Order.status == ORDER_PENDING).count(),
        ORDER_DONE: Order.query.filter(*visible, Order.status == ORDER_DONE).count(),
        ORDER_CANCELED: Order.query.filter(*visible, Order.status == ORDER_CANCELED).count(),
    }
    return ok({"list": [o.to_dict(user.id) for o in items], "total": total,
               "page": page, "page_size": size, "counts": counts})


@bp.get("/orders/sold")
@login_required
def sold_orders():
    user = current_user()
    page, size = paginate_args(Config.DEFAULT_PAGE_SIZE)
    status = arg_str("status") or "all"
    if status not in ("all",) + STATUSES:
        return fail("状态取值不合法")

    q = Order.query.filter(Order.seller_id == user.id)
    if status != "all":
        q = q.filter(Order.status == status)
    total = q.count()
    items = q.order_by(Order.created_at.desc()).offset((page - 1) * size).limit(size).all()

    counts = {
        "all": Order.query.filter_by(seller_id=user.id).count(),
        ORDER_PENDING: Order.query.filter_by(seller_id=user.id, status=ORDER_PENDING).count(),
        ORDER_DONE: Order.query.filter_by(seller_id=user.id, status=ORDER_DONE).count(),
        ORDER_CANCELED: Order.query.filter_by(seller_id=user.id, status=ORDER_CANCELED).count(),
    }
    return ok({"list": [o.to_dict(user.id) for o in items], "total": total,
               "page": page, "page_size": size, "counts": counts})


@bp.get("/orders/<int:oid>")
@login_required
def order_detail(oid: int):
    order, error = _visible_order(oid)
    if error:
        return fail(error, 403 if "无权" in error else 404)
    user = current_user()
    data = order.to_dict(user.id)
    data["role_in_order"] = (
        "buyer" if user.id == order.buyer_id else
        "seller" if user.id == order.seller_id else "admin"
    )
    return ok(data)


# ------------------------------------------------------------------ 状态流转
@bp.patch("/orders/<int:oid>/complete")
@login_required
def complete_order(oid: int):
    order, error = _visible_order(oid)
    if error:
        return fail(error, 403 if "无权" in error else 404)

    user = current_user()
    if order.buyer_id != user.id and user.role != ROLE_ADMIN:
        return fail("只有买家可以确认完成", 403)
    if order.status != ORDER_PENDING:
        return fail("只有「待完成」的订单可以确认完成", 409)

    order.status = ORDER_DONE
    order.finished_at = datetime.now()
    db.session.commit()
    return ok(order.to_dict(user.id), msg="交易已完成，别忘了评价对方")


@bp.patch("/orders/<int:oid>/cancel")
@login_required
def cancel_order(oid: int):
    order, error = _visible_order(oid)
    if error:
        return fail(error, 403 if "无权" in error else 404)

    user = current_user()
    if order.buyer_id != user.id and user.role != ROLE_ADMIN:
        return fail("只有买家可以取消订单", 403)
    if order.status != ORDER_PENDING:
        return fail("只有「待完成」的订单可以取消", 409)

    order.status = ORDER_CANCELED
    order.finished_at = datetime.now()
    # 商品恢复在售（若期间已被管理员下架，则保持下架，不强行上架）
    db.session.query(Product).filter(
        Product.id == order.product_id, Product.status == PRODUCT_SOLD
    ).update({Product.status: PRODUCT_ON_SALE}, synchronize_session=False)
    db.session.commit()
    return ok(order.to_dict(user.id), msg="订单已取消，商品已恢复在售")


@bp.delete("/orders/<int:oid>/record")
@login_required
def delete_order_record(oid: int):
    """买家删除自己的订单记录（功能④）。

    只是「买家侧隐藏」：订单数据、卖家卖出订单、交易统计都完整保留。
    待完成的订单属于进行中的交易，必须先确认完成或取消才能删除记录。
    """
    order, error = _visible_order(oid)
    if error:
        return fail(error, 403 if "无权" in error else 404)

    user = current_user()
    if order.buyer_id != user.id and user.role != ROLE_ADMIN:
        return fail("只有买家可以删除自己的订单记录", 403)
    if order.status == ORDER_PENDING:
        return fail("「待完成」的订单不能删除记录，请先确认完成或取消订单", 409)
    if order.buyer_deleted:
        return fail("这条订单记录已经删除过了", 409)

    order.buyer_deleted = True
    db.session.commit()
    return ok(msg="订单记录已删除（卖家侧记录不受影响）")


# ------------------------------------------------------------------ 交易定位
@bp.put("/orders/<int:oid>/location")
@login_required
def update_location(oid: int):
    """买家 / 卖家更新自己在本次交易中的位置（手动选点或选校园地标）。"""
    order, error = _visible_order(oid)
    if error:
        return fail(error, 403 if "无权" in error else 404)

    user = current_user()
    if order.status != ORDER_PENDING:
        return fail("交易已结束，位置不再更新", 409)

    body = json_body()
    lng, lat = body.get("lng"), body.get("lat")
    place_id = body.get("place_id")

    if place_id not in (None, "", 0):
        place = CampusPlace.query.get(int(place_id))
        if place is None:
            return fail("校园地点不存在")
        lng, lat = float(place.lng), float(place.lat)

    try:
        lng, lat = float(lng), float(lat)
    except (TypeError, ValueError):
        return fail("请选择位置：可传经纬度或校园地点 ID")
    if not (-180 <= lng <= 180) or not (-90 <= lat <= 90):
        return fail("经纬度超出合法范围")

    if user.id == order.buyer_id:
        order.buyer_lng, order.buyer_lat = lng, lat
    elif user.id == order.seller_id:
        order.seller_lng, order.seller_lat = lng, lat
    else:
        return fail("管理员不参与本次交易定位", 403)

    db.session.commit()
    return ok(_map_payload(order, user.id), msg="位置已更新")


@bp.get("/orders/<int:oid>/map")
@login_required
def order_map(oid: int):
    order, error = _visible_order(oid)
    if error:
        return fail(error, 403 if "无权" in error else 404)
    return ok(_map_payload(order, current_user().id))


def _map_payload(order: Order, viewer_id: int) -> dict:
    """自提小地图所需的全部数据。

    隐私规则（功能文档 9.2）：只有「待完成」订单的买卖双方能看到精确坐标；
    交易完成后只保留自提点名称，不再返回双方经纬度。
    """
    payload = {
        "order_id": order.id,
        "order_no": order.order_no,
        "status": order.status,
        "meet_place": order.meet_place.to_dict() if order.meet_place else None,
        "map_key": Config.TENCENT_MAP_KEY,
        "can_see_location": False,
        "buyer_location": None,
        "seller_location": None,
        "distance_m": None,
        "suggest_place": None,
    }

    if order.status != ORDER_PENDING or viewer_id not in (order.buyer_id, order.seller_id):
        return payload

    payload["can_see_location"] = True
    buyer = (
        {"lng": float(order.buyer_lng), "lat": float(order.buyer_lat)}
        if order.buyer_lng is not None and order.buyer_lat is not None else None
    )
    seller = (
        {"lng": float(order.seller_lng), "lat": float(order.seller_lat)}
        if order.seller_lng is not None and order.seller_lat is not None else None
    )
    payload["buyer_location"] = buyer
    payload["seller_location"] = seller

    if buyer and seller:
        distance = haversine_m(buyer["lng"], buyer["lat"], seller["lng"], seller["lat"])
        payload["distance_m"] = round(distance)
        mid_lng, mid_lat = midpoint(buyer["lng"], buyer["lat"], seller["lng"], seller["lat"])
        place, place_distance = nearest_place(mid_lng, mid_lat)
        if place is not None:
            item = place.to_dict()
            item["distance_to_midpoint_m"] = round(place_distance or 0)
            payload["suggest_place"] = item
        # 没有双方坐标时，退而用约定自提点作为建议点
    elif order.meet_place:
        payload["suggest_place"] = order.meet_place.to_dict()

    return payload
