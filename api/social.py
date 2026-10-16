"""关注 / 拉黑（新批需求⑦）。

口径（用户拍板）：
- **关注**单向；个人主页显示「关注 / 粉丝」数；关注时给对方发一条平台私信通知。
- **拉黑**单向：我拉黑 TA 之后——**我这边看不到 TA 的商品与评论**，
  并且 **TA 不能给我发私信**；但 TA 仍能看到我、也能下单（交易不受影响）。

过滤一律放在**接口层**（前端只负责隐藏按钮）。
"""
from flask import Blueprint
from sqlalchemy import and_, or_

from api.common import current_user, fail, login_required, ok
from extensions import db
from models import Block, Follow, Message, User

bp = Blueprint("social", __name__, url_prefix="/api")


# ---------------------------------------------------------------- 供其它接口复用的过滤helper
def hidden_author_ids(viewer_id: int | None) -> list[int]:
    """我拉黑过的人：查询「按作者过滤内容」的接口用这个把他们的内容排掉。"""
    if not viewer_id:
        return []
    return [b.blocked_id for b in Block.query.filter_by(blocker_id=viewer_id).all()]


def blocked_me(viewer_id: int | None, other_id: int) -> bool:
    """对方是否拉黑了我（他拉黑我 → 我不能给他发私信）。"""
    if not viewer_id:
        return False
    return Block.query.filter_by(blocker_id=other_id, blocked_id=viewer_id).first() is not None


def block_between(a: int | None, b: int | None) -> bool:
    """a 与 b 之间是否存在拉黑关系（**任一方向**）。

    2026-10-16 用户把口径从「单向阻断」改成「**双向都不能发私信**」：
    不论是我拉黑了 TA，还是 TA 拉黑了我，双方都不能互发私信。
    """
    if not a or not b:
        return False
    return Block.query.filter(or_(
        and_(Block.blocker_id == a, Block.blocked_id == b),
        and_(Block.blocker_id == b, Block.blocked_id == a),
    )).first() is not None


def social_state(viewer_id: int | None, uid: int) -> dict:
    """某个用户对外的关注/拉黑状态（主页与列表共用）。"""
    following = Follow.query.filter_by(follower_id=uid).count()
    followers = Follow.query.filter_by(followee_id=uid).count()
    data = {
        "following_count": following,
        "follower_count": followers,
        "is_following": False,
        "is_blocked": False,
        "blocked_me": False,
    }
    if viewer_id:
        data["is_following"] = Follow.query.filter_by(
            follower_id=viewer_id, followee_id=uid).first() is not None
        data["is_blocked"] = Block.query.filter_by(
            blocker_id=viewer_id, blocked_id=uid).first() is not None
        data["blocked_me"] = blocked_me(viewer_id, uid)
    return data


def _target(uid: int):
    user = User.query.get(uid)
    if user is None:
        return None, fail("用户不存在", 404)
    me = current_user()
    if user.id == me.id:
        return None, fail("不能对自己做这个操作")
    return user, None


# ---------------------------------------------------------------- 关注
@bp.post("/follows/<int:uid>")
@login_required
def follow_user(uid: int):
    user, error = _target(uid)
    if error:
        return error
    me = current_user()
    if Follow.query.filter_by(follower_id=me.id, followee_id=user.id).first():
        return ok(social_state(me.id, user.id), msg="已经关注过了")

    db.session.add(Follow(follower_id=me.id, followee_id=user.id))
    db.session.add(Message(
        sender_id=me.id, receiver_id=user.id,
        content=(f"【关注通知】{me.nickname} 关注了你。"
                 f"（本条为平台通知，无需回复）")[:Message.MAX_LENGTH]))
    db.session.commit()
    return ok(social_state(me.id, user.id), msg=f"已关注 {user.nickname}")


@bp.delete("/follows/<int:uid>")
@login_required
def unfollow_user(uid: int):
    user, error = _target(uid)
    if error:
        return error
    me = current_user()
    row = Follow.query.filter_by(follower_id=me.id, followee_id=user.id).first()
    if row is None:
        return fail("你还没有关注 TA", 409)
    db.session.delete(row)
    db.session.commit()
    return ok(social_state(me.id, user.id), msg=f"已取消关注 {user.nickname}")


@bp.get("/follows/mine")
@login_required
def my_follows():
    """我关注的人（需求⑧「我的关注」列表，可在这里取消关注）。"""
    me = current_user()
    rows = (Follow.query.filter_by(follower_id=me.id)
            .order_by(Follow.created_at.desc()).all())
    items = [{
        "id": f.followee.id,
        "nickname": f.followee.nickname,
        "avatar": f.followee.avatar or None,
        "bio": f.followee.bio or None,
        "followed_at": f.created_at.strftime("%Y-%m-%d %H:%M") if f.created_at else None,
    } for f in rows if f.followee is not None]
    return ok({"list": items, "total": len(items)})


# ---------------------------------------------------------------- 拉黑
@bp.post("/blocks/<int:uid>")
@login_required
def block_user(uid: int):
    user, error = _target(uid)
    if error:
        return error
    me = current_user()
    if Block.query.filter_by(blocker_id=me.id, blocked_id=user.id).first():
        return ok(social_state(me.id, user.id), msg="已经拉黑过了")

    db.session.add(Block(blocker_id=me.id, blocked_id=user.id))
    # 拉黑后两边的关注关系都没有意义了，顺手清掉，免得列表里还挂着 TA
    for row in Follow.query.filter_by(follower_id=me.id, followee_id=user.id).all():
        db.session.delete(row)
    for row in Follow.query.filter_by(follower_id=user.id, followee_id=me.id).all():
        db.session.delete(row)
    db.session.commit()
    return ok(social_state(me.id, user.id), msg=f"已拉黑 {user.nickname}")


@bp.delete("/blocks/<int:uid>")
@login_required
def unblock_user(uid: int):
    user, error = _target(uid)
    if error:
        return error
    me = current_user()
    row = Block.query.filter_by(blocker_id=me.id, blocked_id=user.id).first()
    if row is None:
        return fail("你还没有拉黑 TA", 409)
    db.session.delete(row)
    db.session.commit()
    return ok(social_state(me.id, user.id), msg=f"已解除拉黑 {user.nickname}")


@bp.get("/blocks/mine")
@login_required
def my_blocks():
    """我拉黑的人（需求⑧「我的拉黑」列表，可在这里解除）。"""
    me = current_user()
    rows = (Block.query.filter_by(blocker_id=me.id)
            .order_by(Block.created_at.desc()).all())
    items = [{
        "id": b.blocked.id,
        "nickname": b.blocked.nickname,
        "avatar": b.blocked.avatar or None,
        "bio": b.blocked.bio or None,
        "blocked_at": b.created_at.strftime("%Y-%m-%d %H:%M") if b.created_at else None,
    } for b in rows if b.blocked is not None]
    return ok({"list": items, "total": len(items)})
