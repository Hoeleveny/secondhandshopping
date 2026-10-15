"""功能①：私信消息。

- 两个用户之间的点对点私信，可附带一件商品作为上下文（从商品详情页发起）；
- 未读数用于顶栏红点提醒；
- 打开与某人的会话即把他的来信标记为已读。
"""
from flask import Blueprint
from sqlalchemy import and_, or_

from api.common import current_user, fail, json_body, login_required, ok
from extensions import db
from models import Message, Product, User
from rating import seller_rating

bp = Blueprint("messages", __name__, url_prefix="/api")

MAX_CONTENT = Message.MAX_LENGTH


@bp.post("/messages")
@login_required
def send_message():
    me = current_user()
    body = json_body()

    receiver_id = body.get("receiver_id")
    content = (body.get("content") or "").strip()
    product_id = body.get("product_id")

    if not receiver_id:
        return fail("请指定收信人")
    try:
        receiver_id = int(receiver_id)
    except (TypeError, ValueError):
        return fail("收信人参数不正确")
    if receiver_id == me.id:
        return fail("不能给自己发私信")
    if not content:
        return fail("消息内容不能为空")
    if len(content) > MAX_CONTENT:
        return fail(f"消息内容不能超过 {MAX_CONTENT} 个字")

    receiver = User.query.get(receiver_id)
    if receiver is None:
        return fail("收信人不存在", 404)

    product = None
    if product_id not in (None, "", 0):
        product = Product.query.get(int(product_id))
        if product is None:
            return fail("关联的商品不存在", 404)

    message = Message(
        sender_id=me.id,
        receiver_id=receiver.id,
        product_id=product.id if product else None,
        content=content,
        is_read=False,
    )
    db.session.add(message)
    db.session.commit()
    return ok(message.to_dict(), msg="消息已发送")


@bp.get("/messages/conversations")
@login_required
def conversations():
    """会话列表：按聊天对象分组，给出最新一条与未读数，按最新时间倒序。"""
    me = current_user().id
    rows = (
        Message.query
        .filter(or_(Message.sender_id == me, Message.receiver_id == me))
        .order_by(Message.created_at.desc(), Message.id.desc())
        .limit(500)
        .all()
    )

    groups: dict[int, dict] = {}
    for message in rows:
        other = message.receiver_id if message.sender_id == me else message.sender_id
        if other not in groups:
            groups[other] = {"other_id": other, "last": message, "unread": 0}
        if message.receiver_id == me and not message.is_read:
            groups[other]["unread"] += 1

    users = {}
    if groups:
        users = {u.id: u for u in User.query.filter(User.id.in_(list(groups))).all()}

    items = []
    for other_id, group in groups.items():
        user = users.get(other_id)
        items.append({
            "user": user.to_dict() if user else None,
            "last_message": group["last"].to_dict(),
            "unread": group["unread"],
        })
    items.sort(key=lambda x: x["last_message"]["created_at"] or "", reverse=True)
    return ok(items)


@bp.get("/messages/with/<int:uid>")
@login_required
def with_user(uid: int):
    """与某人的完整聊天记录；顺带把他发来的未读消息标记为已读。"""
    me = current_user().id
    other = User.query.get(uid)
    if other is None:
        return fail("对方不存在", 404)

    # 先标记已读，再取列表，这样返回的就是最新状态
    Message.query.filter(
        Message.sender_id == uid, Message.receiver_id == me, Message.is_read.is_(False)
    ).update({Message.is_read: True}, synchronize_session=False)
    db.session.commit()

    rows = (
        Message.query
        .filter(or_(
            and_(Message.sender_id == me, Message.receiver_id == uid),
            and_(Message.sender_id == uid, Message.receiver_id == me),
        ))
        .order_by(Message.created_at.asc(), Message.id.asc())
        .limit(300)
        .all()
    )
    # 需求③：聊天窗口头部显示对方的好评率（取代原来的信用分展示）
    other_data = other.to_dict()
    other_data["rating"] = seller_rating(other.id)
    return ok({"user": other_data, "list": [m.to_dict() for m in rows]})


@bp.get("/messages/unread")
@login_required
def unread_count():
    me = current_user().id
    count = Message.query.filter_by(receiver_id=me, is_read=False).count()
    return ok({"count": count})
