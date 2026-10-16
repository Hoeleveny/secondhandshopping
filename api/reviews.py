"""M08 评价与评分（双向互评）。

规则：
- 只有「已完成」的订单可以评价；
- 买卖双方各自可以评价对方一次（reviews 唯一约束为 order_id + reviewer_id）；
- 展示在商品详情页。
"""
from flask import Blueprint

from api.common import current_user, fail, json_body, login_required, ok, paginate_args
from config import Config
from extensions import db
from models import Order, Review, ReviewComment, ORDER_DONE

bp = Blueprint("reviews", __name__, url_prefix="/api")


def _reviewed_order_ids(user_id: int) -> set[int]:
    rows = db.session.query(Review.order_id).filter(Review.reviewer_id == user_id).all()
    return {r[0] for r in rows}


@bp.post("/reviews")
@login_required
def create_review():
    user = current_user()
    body = json_body()

    order_id = body.get("order_id")
    if not order_id:
        return fail("请指定要评价的订单")
    order = Order.query.get(int(order_id))
    if order is None:
        return fail("订单不存在", 404)
    if user.id not in (order.buyer_id, order.seller_id):
        return fail("只能评价自己参与的订单", 403)
    if order.status != ORDER_DONE:
        return fail("只有已完成的订单才能评价", 409)

    exists = Review.query.filter_by(order_id=order.id, reviewer_id=user.id).first()
    if exists:
        return fail("这笔订单你已经评价过了", 409)

    try:
        rating = int(body.get("rating"))
    except (TypeError, ValueError):
        return fail("请给出 1-5 星的评分")
    if not 1 <= rating <= 5:
        return fail("评分只能是 1-5 星")

    content = (body.get("content") or "").strip()[:2000]
    reviewee_id = order.seller_id if user.id == order.buyer_id else order.buyer_id

    review = Review(
        order_id=order.id, product_id=order.product_id,
        reviewer_id=user.id, reviewee_id=reviewee_id,
        rating=rating, content=content or None,
    )
    db.session.add(review)
    db.session.flush()  # 先落库拿到 review.id，否则日志里的 target_id 会是 None
    import audit

    audit.record("review_create", "review", review.id,
                 f"给「{order.product.name if order.product else '商品已删除'}」"
                 f"（订单 {order.order_no}）打了 {rating} 星评价")
    db.session.commit()
    return ok(review.to_dict(user.id), msg="评价已提交")


@bp.get("/reviews/pending")
@login_required
def pending_reviews():
    """我已完成的、但还没评价的订单（前端用来提醒"去评价"）。"""
    user = current_user()
    done_ids = _reviewed_order_ids(user.id)
    orders = (
        Order.query.filter(
            Order.status == ORDER_DONE,
            (Order.buyer_id == user.id) | (Order.seller_id == user.id),
        ).order_by(Order.finished_at.desc()).all()
    )
    result = [o.to_dict(user.id) for o in orders if o.id not in done_ids]
    return ok(result)


@bp.get("/reviews/received")
@login_required
def received_reviews():
    user = current_user()
    page, size = paginate_args(Config.DEFAULT_PAGE_SIZE)
    q = Review.query.filter(Review.reviewee_id == user.id)
    total = q.count()
    items = q.order_by(Review.created_at.desc()).offset((page - 1) * size).limit(size).all()
    return ok({"list": [r.to_dict(user.id) for r in items], "total": total,
               "page": page, "page_size": size})


@bp.get("/reviews/given")
@login_required
def given_reviews():
    user = current_user()
    page, size = paginate_args(Config.DEFAULT_PAGE_SIZE)
    q = Review.query.filter(Review.reviewer_id == user.id)
    total = q.count()
    items = q.order_by(Review.created_at.desc()).offset((page - 1) * size).limit(size).all()
    return ok({"list": [r.to_dict(user.id) for r in items], "total": total,
               "page": page, "page_size": size})


@bp.get("/reviews/user/<int:uid>")
def user_reviews(uid: int):
    """某个用户收到的评价（游客可看，用于展示信用口碑）。"""
    page, size = paginate_args(Config.DEFAULT_PAGE_SIZE)
    q = Review.query.filter(Review.reviewee_id == uid)
    total = q.count()
    items = q.order_by(Review.created_at.desc()).offset((page - 1) * size).limit(size).all()
    viewer = current_user()
    avg = round(sum(r.rating for r in items) / len(items), 1) if items else None
    return ok({"list": [r.to_dict(viewer.id if viewer else None) for r in items],
               "total": total, "avg_rating": avg})


# ---------------------------------------------------------------- 评价下的评论（新批需求⑤）
@bp.get("/reviews/<int:rid>/comments")
def list_review_comments(rid: int):
    """评价下面的评论（游客可看）。"""
    if Review.query.get(rid) is None:
        return fail("评价不存在", 404)
    rows = (ReviewComment.query.filter_by(review_id=rid)
            .order_by(ReviewComment.created_at.asc()).all())
    return ok([c.to_dict() for c in rows])


@bp.post("/reviews/<int:rid>/comments")
@login_required
def create_review_comment(rid: int):
    """在商品评价下面发评论（新批需求⑤）。

    「引用(@用户名)」就是这个内容里带 `@昵称 `（点「回复」自动填），不需要额外字段。
    """
    user = current_user()
    review = Review.query.get(rid)
    if review is None:
        return fail("评价不存在", 404)
    content = (json_body().get("content") or "").strip()
    if not content:
        return fail("评论内容不能为空")
    if len(content) > 500:
        return fail("评论内容不能超过 500 个字")

    comment = ReviewComment(review_id=review.id, author_id=user.id, content=content)
    db.session.add(comment)
    db.session.commit()
    return ok(comment.to_dict(), msg="评论已发布")
