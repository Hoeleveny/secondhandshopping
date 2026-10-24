"""功能①：私信消息。

- 两个用户之间的点对点私信，可附带一件商品作为上下文（从商品详情页发起）；
- 未读数用于顶栏红点提醒；
- 打开与某人的会话即把他的来信标记为已读。
"""
from flask import Blueprint
from sqlalchemy import and_, or_

from api.common import current_user, fail, json_body, login_required, ok
from api.orders import product_snapshot
from api.social import block_between
from extensions import db
from models import Message, MessageClear, MessageHide, Product, User
from rating import seller_rating

bp = Blueprint("messages", __name__, url_prefix="/api")


def _hidden_subq(me: int):
    """我「单条删除」掉的那些消息（本批需求②：只对我隐藏，与删除会话同口径）。"""
    return db.session.query(MessageHide.message_id).filter(MessageHide.user_id == me)


def _clear_marks(me: int) -> dict[int, int]:
    """我在各会话里清空到哪条消息为止：{peer_id: last_message_id}。

    需求⑤「删除对话」只对我隐藏，靠这份下限实现：id <= 下限的消息对我不可见。
    """
    return {c.peer_id: c.last_message_id or 0
            for c in MessageClear.query.filter_by(user_id=me).all()}

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
    # 注意：只带商品、不带文字也是合法的一条消息（需求④ 的商品卡片），
    # 所以这里只在「既没内容、也没关联商品」时才拒绝。
    if not content and product_id in (None, "", 0):
        return fail("消息内容不能为空")
    if len(content) > MAX_CONTENT:
        return fail(f"消息内容不能超过 {MAX_CONTENT} 个字")

    receiver = User.query.get(receiver_id)
    if receiver is None:
        return fail("收信人不存在", 404)

    # 拉黑：2026-10-16 起是**双向**阻断——我拉黑了 TA，或 TA 拉黑了我，双方都不能互发私信
    if block_between(me.id, receiver.id):
        return fail("你与对方之间存在拉黑关系，无法互发私信", 403)

    product = None
    if product_id not in (None, "", 0):
        product = Product.query.get(int(product_id))
        if product is None:
            return fail("关联的商品不存在", 404)

    # 新批需求④：发「商品详情卡片」——没填内容时自动用商品名兜一句可读文本，
    # 这样会话列表的「最后一条」与未读提醒都还看得懂。
    is_card = (body.get("kind") == "product") or (product is not None and not content)
    if not content:
        if product is None:
            return fail("消息内容不能为空")
        content = f"【商品】{product.name}"[:MAX_CONTENT]

    message = Message(
        sender_id=me.id,
        receiver_id=receiver.id,
        product_id=product.id if product else None,
        kind="product" if is_card else "text",
        product_snapshot=product_snapshot(product) if product else None,
        content=content,
        is_read=False,
    )
    db.session.add(message)
    db.session.commit()
    return ok(message.to_dict(), msg="消息已发送")


@bp.get("/messages/conversations")
@login_required
def conversations():
    """会话列表：按聊天对象分组，给出最新一条与未读数，按最新时间倒序。

    需求⑤：我曾「删除对话」的那些会话，下限之前的消息对我不可见；
    如果对方之后又发了新消息，它会以新消息重新出现在列表里。
    """
    me = current_user().id
    marks = _clear_marks(me)
    rows = (
        Message.query
        .filter(or_(Message.sender_id == me, Message.receiver_id == me))
        .filter(Message.id.notin_(_hidden_subq(me)))    # 本批需求②：单条删掉的不再出现在列表里
        .order_by(Message.created_at.desc(), Message.id.desc())
        .limit(500)
        .all()
    )

    groups: dict[int, dict] = {}
    for message in rows:
        other = message.receiver_id if message.sender_id == me else message.sender_id
        if message.id <= marks.get(other, 0):
            continue  # 这段对话我清空到更后面了，这条对我不可见
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

    floor = _clear_marks(me).get(uid, 0)  # 需求⑤：我删过的话，这个 id 之前的对我不可见
    # 先标记已读，再取列表，这样返回的就是最新状态。
    # 2026-10-18 需求②：**进聊天框看到消息就算读过了**——连之前手动「标为未读」的那些也一并清掉，
    # 否则用户明明已经读了，顶栏/会话的红点却一直不消（这正是本条反馈的问题）。
    Message.query.filter(
        Message.sender_id == uid, Message.receiver_id == me, Message.is_read.is_(False),
        Message.id > floor,
    ).update({Message.is_read: True, Message.keep_unread: False}, synchronize_session=False)
    db.session.commit()

    rows = (
        Message.query
        .filter(or_(
            and_(Message.sender_id == me, Message.receiver_id == uid),
            and_(Message.sender_id == uid, Message.receiver_id == me),
        ), Message.id > floor)
        .filter(Message.id.notin_(_hidden_subq(me)))    # 本批需求②：被我单条删掉的不再显示
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
    marks = _clear_marks(me)
    q = Message.query.filter_by(receiver_id=me, is_read=False)
    # 本批需求②：被我从自己这边单条删掉的，不再计入未读（否则红点点不掉）
    q = q.filter(Message.id.notin_(_hidden_subq(me)))
    if marks:
        # 被清空过的会话，只统计「下限之后」的未读；没清空过的会话照常统计
        conds = [and_(Message.sender_id == peer, Message.id > mark)
                 for peer, mark in marks.items()]
        q = q.filter(or_(Message.sender_id.notin_(list(marks)), *conds))
    return ok({"count": q.count()})


@bp.delete("/messages/conversations/<int:uid>")
@login_required
def clear_conversation(uid: int):
    """删除对话（需求⑤）：**只对我隐藏**，对方完全不受影响。

    - 我从会话列表移除它、我这边的历史从此刻重新计（下限记到当前最后一条消息 id）；
    - 对方那边一切照旧，仍能看到全部聊天；
    - 对方之后再发新消息，会话会重新出现在我的列表里。
    """
    me = current_user().id
    if uid == me:
        return fail("不能和自己聊天", 400)
    if User.query.get(uid) is None:
        return fail("对方不存在", 404)

    last_id = (
        db.session.query(db.func.max(Message.id))
        .filter(or_(
            and_(Message.sender_id == me, Message.receiver_id == uid),
            and_(Message.sender_id == uid, Message.receiver_id == me),
        ))
        .scalar()
    ) or 0

    mark = MessageClear.query.filter_by(user_id=me, peer_id=uid).first()
    if mark is None:
        db.session.add(MessageClear(user_id=me, peer_id=uid, last_message_id=last_id))
    else:
        # 再次删除：下限只增不减，避免把更早的消息又露出来
        mark.last_message_id = max(mark.last_message_id or 0, last_id)
    db.session.commit()
    return ok(msg="对话已从你的列表移除（对方不受影响）")


@bp.post("/messages/<int:mid>/hide")
@login_required
def hide_message(mid: int):
    """删掉**单条**消息（本批需求②）：只对我隐藏，对方完全不受影响。

    与「删除对话」同一个口径；会话列表、聊天记录、未读数三处都会过滤掉它。
    """
    me = current_user().id
    message = Message.query.get(mid)
    if message is None or me not in (message.sender_id, message.receiver_id):
        return fail("消息不存在", 404)
    if MessageHide.query.filter_by(user_id=me, message_id=mid).first() is None:
        db.session.add(MessageHide(user_id=me, message_id=mid))
        db.session.commit()
    return ok(msg="已从你这边删除（对方不受影响）", data={"hidden": mid})


@bp.post("/messages/<int:mid>/read")
@login_required
def mark_message_read(mid: int):
    """把某一条「我收到的」消息标记为已读 / 未读（本批需求②）。

    标为未读时会记下 keep_unread，进聊天框的自动置已读不会把它改回去。
    """
    me = current_user().id
    message = Message.query.get(mid)
    if message is None or me not in (message.sender_id, message.receiver_id):
        return fail("消息不存在", 404)
    if message.receiver_id != me:
        return fail("只能标记自己收到的消息", 403)
    read = bool((json_body() or {}).get("read", True))
    message.is_read = read
    message.keep_unread = not read
    db.session.commit()
    unread = (Message.query.filter_by(receiver_id=me, is_read=False)
              .filter(Message.id.notin_(_hidden_subq(me))).count())
    return ok({
        "is_read": read, "id": mid, "unread": unread,
        "msg": "已标为已读" if read else "已标为未读",
    })
