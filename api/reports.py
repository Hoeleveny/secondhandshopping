"""举报提交（商品 / 帖子）。审核动作在 api/admin.py。"""
from flask import Blueprint

from api.common import current_user, fail, json_body, login_required, ok, paginate_args
from config import Config
from extensions import db
from models import Post, Product, Report, PRODUCT_DELETED

bp = Blueprint("reports", __name__, url_prefix="/api")

VALID_REASONS = Config.REPORT_REASONS


@bp.post("/reports")
@login_required
def create_report():
    user = current_user()
    body = json_body()

    target_type = (body.get("target_type") or "product").strip().lower()
    reason = (body.get("reason") or "").strip()
    detail = (body.get("detail") or "").strip()
    target_id = body.get("target_id") or body.get("product_id") or body.get("post_id")

    if not target_id:
        return fail("请选择要举报的对象")
    if not reason:
        return fail("请选择举报理由")
    if reason not in VALID_REASONS and reason != "其他":
        return fail("举报理由不在允许范围内")

    full_reason = reason if not detail else f"{reason}：{detail}"[:200]

    if target_type == "product":
        product = Product.query.get(int(target_id))
        if product is None or product.status == PRODUCT_DELETED:
            return fail("商品不存在", 404)
        if product.seller_id == user.id:
            return fail("不能举报自己发布的商品")
        target_field = {"product_id": product.id}
    elif target_type == "post":
        post = Post.query.get(int(target_id))
        if post is None or post.status != "normal":
            return fail("帖子不存在", 404)
        if post.author_id == user.id:
            return fail("不能举报自己发布的帖子")
        target_field = {"post_id": post.id}
    else:
        return fail("举报对象只能是商品或帖子")

    duplicate = Report.query.filter_by(
        reporter_id=user.id, status="pending", **target_field
    ).first()
    if duplicate:
        return fail("你已经举报过这个对象了，请等待管理员处理", 409)

    report = Report(reporter_id=user.id, reason=full_reason,
                    status="pending", **target_field)
    db.session.add(report)
    db.session.commit()
    return ok(report.to_dict(), msg="举报已提交，管理员会尽快处理")


@bp.get("/reports/mine")
@login_required
def my_reports():
    user = current_user()
    page, size = paginate_args(Config.DEFAULT_PAGE_SIZE)
    q = Report.query.filter_by(reporter_id=user.id)
    total = q.count()
    items = q.order_by(Report.created_at.desc()).offset((page - 1) * size).limit(size).all()
    return ok({"list": [r.to_dict() for r in items], "total": total,
               "page": page, "page_size": size})
