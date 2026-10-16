"""M06 下单与订单。

并发与一致性要点（功能文档 7.7）：
- 下单时用「带条件的 UPDATE」把商品从 on_sale 改 sold，靠 affected rows 判断是否抢到，
  可避免两个人同时下单把同一件二手物品卖两次；
- 「商品变已售 + 插入订单」在同一次事务里提交，失败一起回滚；
- 取消订单时「订单变已取消 + 商品恢复在售」同样在同一事务。
"""
from datetime import datetime

from flask import Blueprint
from sqlalchemy import and_, or_

from api.common import (
    arg_str, current_user, fail, haversine_m, json_body, login_required,
    midpoint, nearest_place, ok, paginate_args,
)
from config import Config
from extensions import db
from models import (
    CampusPlace, Message, OperationLog, Order, Product, User,
    ORDER_AWAITING, ORDER_CANCELED, ORDER_DONE, ORDER_PENDING,
    PRODUCT_ON_SALE, PRODUCT_SOLD, ROLE_ADMIN,
)

bp = Blueprint("orders", __name__, url_prefix="/api")

STATUSES = (ORDER_AWAITING, ORDER_PENDING, ORDER_DONE, ORDER_CANCELED)


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
        # 一并冻结商品编号，商品被彻底删除后订单仍能显示原编号
        "product_code": product.product_code,
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

    # 新批需求③：下单只是「意向」，不锁商品；但同一个买家对同一件商品不能堆多条意向
    dup = Order.query.filter(
        Order.product_id == product.id, Order.buyer_id == user.id,
        Order.status.in_((ORDER_AWAITING, ORDER_PENDING))).first()
    if dup is not None:
        return fail("你已经对这件商品提交过购买意向，等卖家确认即可", 409)

    order = Order(
        order_no="PENDING",
        product_id=product.id,
        buyer_id=user.id,
        seller_id=product.seller_id,
        price=product.price,
        product_snapshot=product_snapshot(product),
        status=ORDER_AWAITING,
        trade_note=trade_note or None,
        meet_place_id=place.id,
    )
    db.session.add(order)
    db.session.flush()
    order.order_no = f"CM{datetime.now():%Y%m%d%H%M%S}{order.id:06d}"
    import audit

    audit.record("order_create", "order", order.id,
                 f"提交购买意向「{product.name}」（{product.product_code}，¥{order.price}）"
                 "，等待卖家确认")
    db.session.commit()

    return ok(order.to_dict(user.id), msg="已提交购买意向，等卖家确认后商品才会锁定")


@bp.get("/orders/updates")
@login_required
def order_updates():
    """需求⑥：「我的订单」上的小红点。

    口径：**别人**在我参与的订单上留下的操作日志，且比我上次查看订单时更新的，算未读。
    - 我自己的操作不算（自己刚下的单不用提醒自己）；
    - 打开一次「我的订单」页就会把游标推到最新（见 /orders/updates/seen）。
    """
    user = current_user()
    latest = _latest_order_log_id(user.id)
    seen = user.orders_seen_log_id or 0
    count = _order_log_query(user.id).filter(OperationLog.id > seen).count()
    return ok({"count": count, "latest_id": latest, "seen_id": seen})


@bp.post("/orders/updates/seen")
@login_required
def order_updates_seen():
    """把订单红点清零：游标推到当前最新（只推自己的，不影响别人）。"""
    user = current_user()
    latest = _latest_order_log_id(user.id)
    if latest > (user.orders_seen_log_id or 0):
        user.orders_seen_log_id = latest
        db.session.commit()
    return ok({"count": 0, "seen_id": user.orders_seen_log_id or 0})


def _my_order_ids(user_id: int) -> list[int]:
    rows = db.session.query(Order.id).filter(
        or_(Order.buyer_id == user_id, Order.seller_id == user_id)).all()
    return [r[0] for r in rows]


def _order_log_query(user_id: int):
    """「与我有关、但不是我自己做的」订单操作日志。"""
    oids = _my_order_ids(user_id)
    return OperationLog.query.filter(
        OperationLog.target_type == "order",
        OperationLog.target_id.in_(oids or [-1]),
        OperationLog.user_id != user_id,
    )


def _latest_order_log_id(user_id: int) -> int:
    row = _order_log_query(user_id).order_by(OperationLog.id.desc()).first()
    return row.id if row else 0


# ------------------------------------------------------------------ 订单列表
@bp.get("/orders/mine")
@login_required
def my_orders():
    """我的订单（需求④合并后一个页面看两侧）。

    side=buyer（默认，兼容老调用）/ seller / all：
    - all 会同时包含「我买的」与「我卖的」，每条订单带 my_role 供前端标出我的身份；
    - 各自侧的「删除记录」只对自己隐藏，所以过滤条件也要按侧区分。
    """
    user = current_user()
    page, size = paginate_args(Config.DEFAULT_PAGE_SIZE)
    status = arg_str("status") or "all"
    if status not in ("all",) + STATUSES:
        return fail("状态取值不合法")
    side = arg_str("side") or "buyer"
    if side not in ("buyer", "seller", "all"):
        return fail("side 只能是 buyer / seller / all")

    buyer_side = and_(Order.buyer_id == user.id, Order.buyer_deleted.is_(False))
    seller_side = and_(Order.seller_id == user.id, Order.seller_deleted.is_(False))
    visible = {
        "buyer": (buyer_side,),
        "seller": (seller_side,),
        "all": (or_(buyer_side, seller_side),),
    }[side]

    q = Order.query.filter(*visible)
    if status != "all":
        q = q.filter(Order.status == status)
    total = q.count()
    items = q.order_by(Order.created_at.desc()).offset((page - 1) * size).limit(size).all()

    counts = {
        "all": Order.query.filter(*visible).count(),
        ORDER_AWAITING: Order.query.filter(*visible, Order.status == ORDER_AWAITING).count(),
        ORDER_PENDING: Order.query.filter(*visible, Order.status == ORDER_PENDING).count(),
        ORDER_DONE: Order.query.filter(*visible, Order.status == ORDER_DONE).count(),
        ORDER_CANCELED: Order.query.filter(*visible, Order.status == ORDER_CANCELED).count(),
    }
    return ok({"list": [o.to_dict(user.id) for o in items], "total": total,
               "page": page, "page_size": size, "counts": counts, "side": side})


@bp.get("/orders/sold")
@login_required
def sold_orders():
    user = current_user()
    page, size = paginate_args(Config.DEFAULT_PAGE_SIZE)
    status = arg_str("status") or "all"
    if status not in ("all",) + STATUSES:
        return fail("状态取值不合法")

    # 需求⑥：卖家侧删掉的记录也不再显示（只影响卖家侧，买家与管理员照常可见）
    visible = (Order.seller_id == user.id, Order.seller_deleted.is_(False))
    q = Order.query.filter(*visible)
    if status != "all":
        q = q.filter(Order.status == status)
    total = q.count()
    items = q.order_by(Order.created_at.desc()).offset((page - 1) * size).limit(size).all()

    counts = {
        "all": Order.query.filter(*visible).count(),
        ORDER_AWAITING: Order.query.filter(*visible, Order.status == ORDER_AWAITING).count(),
        ORDER_PENDING: Order.query.filter(*visible, Order.status == ORDER_PENDING).count(),
        ORDER_DONE: Order.query.filter(*visible, Order.status == ORDER_DONE).count(),
        ORDER_CANCELED: Order.query.filter(*visible, Order.status == ORDER_CANCELED).count(),
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
    if order.buyer_id != user.id and order.seller_id != user.id and user.role != ROLE_ADMIN:
        return fail("只有交易双方可以确认完成", 403)
    if order.status != ORDER_PENDING:
        return fail("只有「待完成」的订单可以确认完成", 409)

    order.status = ORDER_DONE
    order.finished_at = datetime.now()
    import audit

    product = Product.query.get(order.product_id)
    audit.record(
        "admin_order_complete" if user.role == ROLE_ADMIN else "order_complete",
        "order", order.id,
        f"{'管理员标记' if user.role == ROLE_ADMIN else ''}完成交易 {order.order_no}"
        f"「{product.name if product else '商品已删除'}」",
        role=user.role,
    )
    db.session.commit()
    return ok(order.to_dict(user.id), msg="交易已完成，别忘了评价对方")


@bp.patch("/orders/<int:oid>/confirm")
@login_required
def confirm_order(oid: int):
    """卖家确认接单（新批需求③）：**确认之后才锁定商品**。

    口径：买家下单只是「意向」（awaiting），商品仍在售、别人也能下单；
    卖家确认其中一单后，这一单转「待完成」并用条件更新把商品锁成已售，
    同一商品上其余还挂着的意向自动取消并私信告知买家。
    """
    order, error = _visible_order(oid)
    if error:
        return fail(error, 403 if "无权" in error else 404)

    user = current_user()
    if order.seller_id != user.id and user.role != ROLE_ADMIN:
        return fail("只有卖家可以确认交易", 403)
    if order.status != ORDER_AWAITING:
        return fail("这一单现在不是「待卖家确认」状态", 409)

    import audit

    product = Product.query.get(order.product_id)
    pname = product.name if product else "商品已删除"
    now = datetime.now()

    # 商品已经不在售（被别人确认走了 / 被下架 / 被删）→ 这一单没法成交，直接作废
    if product is None or product.status != PRODUCT_ON_SALE:
        order.status = ORDER_CANCELED
        order.finished_at = now
        db.session.add(Message(
            sender_id=user.id, receiver_id=order.buyer_id,
            content=(f"【交易提醒】你意向购买的「{pname}」已经不在售，"
                     f"你的意向已自动取消。")[:Message.MAX_LENGTH]))
        audit.record("order_reject", "order", order.id,
                     f"确认失败自动取消：{order.order_no}「{pname}」已不在售")
        db.session.commit()
        return fail("该商品已不在售，这一单已自动取消", 409)

    # 条件更新：只有仍为「在售」时才锁得住
    affected = (
        db.session.query(Product)
        .filter(Product.id == product.id, Product.status == PRODUCT_ON_SALE)
        .update({Product.status: PRODUCT_SOLD}, synchronize_session=False)
    )
    if affected == 0:
        db.session.rollback()
        return fail("手慢了一步，该商品已被别的交易锁定", 409)

    order.status = ORDER_PENDING
    db.session.flush()

    # 其余还挂着的意向：自动取消 + 私信告知（需求③ 口径）
    others = Order.query.filter(
        Order.product_id == product.id, Order.id != order.id,
        Order.status == ORDER_AWAITING).all()
    for other in others:
        other.status = ORDER_CANCELED
        other.finished_at = now
        db.session.add(Message(
            sender_id=user.id, receiver_id=other.buyer_id,
            content=(f"【交易提醒】你意向购买的「{pname}」已被卖家确认给其他买家，"
                     f"你的购买意向已自动取消。")[:Message.MAX_LENGTH]))

    audit.record(
        "order_confirm", "order", order.id,
        f"{'管理员代为' if user.role == ROLE_ADMIN else '卖家'}确认接单 {order.order_no}"
        f"「{pname}」（{product.product_code}），商品已锁定"
        + (f"；另有 {len(others)} 个购买意向自动取消" if others else ""),
        role=user.role,
    )
    db.session.commit()
    return ok(order.to_dict(user.id), msg="已确认交易并锁定商品，请与买家约定自提时间")


@bp.patch("/orders/<int:oid>/reject")
@login_required
def reject_order(oid: int):
    """卖家拒绝这一单意向（新批需求③）：商品不受影响，仍是别人可以买的在售商品。"""
    order, error = _visible_order(oid)
    if error:
        return fail(error, 403 if "无权" in error else 404)

    user = current_user()
    if order.seller_id != user.id and user.role != ROLE_ADMIN:
        return fail("只有卖家可以拒绝交易", 403)
    if order.status != ORDER_AWAITING:
        return fail("这一单现在不是「待卖家确认」状态", 409)

    import audit

    product = Product.query.get(order.product_id)
    pname = product.name if product else "商品已删除"
    order.status = ORDER_CANCELED
    order.finished_at = datetime.now()
    db.session.add(Message(
        sender_id=user.id, receiver_id=order.buyer_id,
        content=(f"【交易提醒】卖家没有接受你对「{pname}」的购买意向，"
                 f"这一单已取消，你可以看看别的商品。")[:Message.MAX_LENGTH]))
    audit.record("order_reject", "order", order.id,
                 f"卖家拒绝接单 {order.order_no}「{pname}」", role=user.role)
    db.session.commit()
    return ok(order.to_dict(user.id), msg="已拒绝这一单，商品仍在售")


@bp.patch("/orders/<int:oid>/cancel")
@login_required
def cancel_order(oid: int):
    order, error = _visible_order(oid)
    if error:
        return fail(error, 403 if "无权" in error else 404)

    user = current_user()
    if order.buyer_id != user.id and user.role != ROLE_ADMIN:
        return fail("只有买家可以取消订单", 403)
    # 需求③起：还没被卖家确认的「意向」也能由买家自己撤掉（此时商品没被锁，无需恢复）
    if order.status not in (ORDER_AWAITING, ORDER_PENDING):
        return fail("只有「待卖家确认」或「待完成」的订单可以取消", 409)

    was_pending = order.status == ORDER_PENDING
    order.status = ORDER_CANCELED
    order.finished_at = datetime.now()
    # 商品恢复在售（仅当这一单确实锁过商品；若期间已被管理员下架，则保持下架，不强行上架）
    if was_pending:
        db.session.query(Product).filter(
            Product.id == order.product_id, Product.status == PRODUCT_SOLD
        ).update({Product.status: PRODUCT_ON_SALE}, synchronize_session=False)
    import audit

    product = Product.query.get(order.product_id)
    if was_pending:
        _summary = (f"{'管理员强制取消' if user.role == ROLE_ADMIN else '取消交易'} "
                    f"{order.order_no}「{product.name if product else '商品已删除'}」")
    else:
        _summary = (f"撤回购买意向 {order.order_no}"
                    f"「{product.name if product else '商品已删除'}」")
    audit.record(
        "admin_order_cancel" if user.role == ROLE_ADMIN else "order_cancel",
        "order", order.id, _summary, role=user.role,
    )
    db.session.commit()
    return ok(order.to_dict(user.id),
              msg="订单已取消，商品已恢复在售" if was_pending else "已撤回购买意向")


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
    if order.buyer_id != user.id and order.seller_id != user.id and user.role != ROLE_ADMIN:
        return fail("只有交易双方可以删除自己的订单记录", 403)
    if order.status in (ORDER_AWAITING, ORDER_PENDING):
        return fail("「待卖家确认」或「待完成」的订单不能删除记录，请先取消或完成", 409)
    # 需求⑥：买卖双方各自「只对自己隐藏」，互不影响
    if user.id == order.seller_id:
        if order.seller_deleted:
            return fail("这条卖出记录已经删除过了", 409)
        order.seller_deleted = True
    else:
        if order.buyer_deleted:
            return fail("这条订单记录已经删除过了", 409)
        order.buyer_deleted = True
    import audit

    audit.record("order_record_delete", "order", order.id,
                 f"删除订单记录 {order.order_no}"
                 f"「{order.product.name if order.product else '商品已删除'}」"
                 f"（只对{'卖家' if user.id == order.seller_id else '买家'}自己隐藏）")
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
