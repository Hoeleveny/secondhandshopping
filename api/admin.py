"""M10 管理后台 / M11 数据看板 / 基础数据维护 / 备份恢复。

覆盖：
- 全部商品管理（含已售、已下架、已删除）：下架、重新上架、删除；
- 举报审核：按对象区分动作（商品→下架，帖子→删帖）；
- 基础数据维护：分类 / 小类 / 校园地点增删改；
- 数据看板：4 个数字卡 + 分类占比饼图 + 价格区间柱状图（全部用 SQL 聚合）；
- 数据管理：备份 / 恢复 / 重置示例数据。
"""
import json
from datetime import datetime, timedelta
from pathlib import Path

from flask import Blueprint, current_app, send_from_directory
from sqlalchemy import and_, case, func, or_

import audit
from api.common import (
    admin_required, arg_int, arg_str, current_user, fail, json_body, ok, paginate_args,
)
from config import Config
from extensions import db
from models import (
    CampusPlace, Category, Message, OperationLog, Order, Post, Product, Report,
    Review, Subcategory, User, _dt,
    ORDER_CANCELED, ORDER_DONE, ORDER_PENDING,
    PRODUCT_DELETED, PRODUCT_OFF_SHELF, PRODUCT_ON_SALE, PRODUCT_SOLD,
)
from backup import dump_all, load_all
from rating import seller_rating

bp = Blueprint("admin", __name__, url_prefix="/api/admin")


# ================================================================ 商品管理
@bp.get("/products")
@admin_required
def all_products():
    """全部商品（含已售 / 已下架）；默认不显示已删除，可显式筛 status=deleted。"""
    page, size = paginate_args(20)
    keyword = arg_str("keyword")
    category_id = arg_int("category_id")
    status = arg_str("status") or "all"

    q = Product.query
    if status == "all":
        q = q.filter(Product.status != PRODUCT_DELETED)
    else:
        q = q.filter(Product.status == status)

    if keyword:
        like = f"%{keyword}%"
        # 顺带支持按「商品编号」搜索（前缀/精确/包含都能命中）
        q = q.filter(or_(Product.name.like(like), Product.description.like(like),
                         Product.product_code.like(like)))
    if category_id:
        q = q.filter(Product.category_id == category_id)

    total = q.count()
    items = q.order_by(Product.created_at.desc()).offset((page - 1) * size).limit(size).all()
    return ok({"list": [p.to_dict() for p in items], "total": total,
               "page": page, "page_size": size})


# ================================================================ 交易监管（需求①）
@bp.get("/orders")
@admin_required
def admin_orders():
    """交易列表：默认只看「进行中」（待完成），也支持查全部/已完成/已取消。

    每行带上商品名称与**商品编号**、买卖双方昵称、进行时长（前端按 created_at 算），
    供管理员实时监管「多项交易并发」。
    """
    page, size = paginate_args(20)
    status = arg_str("status") or ORDER_PENDING
    keyword = arg_str("keyword")
    seller_id = arg_int("seller_id")

    q = Order.query
    if status != "all":
        if status not in (ORDER_PENDING, ORDER_DONE, ORDER_CANCELED):
            return fail("状态取值不合法")
        q = q.filter(Order.status == status)
    if seller_id:
        q = q.filter(Order.seller_id == seller_id)

    if keyword:
        like = f"%{keyword}%"
        # 订单号 / 商品名 / 商品编号 / 买卖双方昵称 / 用户名 都能搜
        q = q.join(User, User.id == Order.buyer_id).join(Product, Product.id == Order.product_id)
        q = q.filter(or_(
            Order.order_no.like(like),
            Product.name.like(like),
            Product.product_code.like(like),
            User.nickname.like(like),
            User.username.like(like),
        ))

    total = q.count()
    # 进行中的交易按「最早下单的排前面」——挂得越久越需要关注
    order_by = Order.created_at.asc() if status == ORDER_PENDING else Order.created_at.desc()
    rows = q.order_by(order_by).offset((page - 1) * size).limit(size).all()

    now = datetime.now()
    items = []
    for o in rows:
        data = o.to_dict()
        product = Product.query.get(o.product_id)
        data["product_name"] = product.name if product else None
        data["product_code"] = product.product_code if product else None
        data["elapsed_minutes"] = int((now - o.created_at).total_seconds() // 60)
        items.append(data)

    # 顺带给出「进行中交易总览」，让管理员一眼看到并发规模
    pending = Order.query.filter(Order.status == ORDER_PENDING)
    oldest = pending.order_by(Order.created_at.asc()).first()
    stats = {
        "pending": pending.count(),
        "done": Order.query.filter(Order.status == ORDER_DONE).count(),
        "canceled": Order.query.filter(Order.status == ORDER_CANCELED).count(),
        "sellers_in_trade": db.session.query(func.count(func.distinct(Order.seller_id)))
                                    .filter(Order.status == ORDER_PENDING).scalar() or 0,
        "longest_pending_minutes": (
            int((now - oldest.created_at).total_seconds() // 60) if oldest else 0
        ),
        "today_orders": Order.query.filter(Order.created_at >= now.replace(
            hour=0, minute=0, second=0, microsecond=0)).count(),
    }
    return ok({"list": items, "total": total, "page": page, "page_size": size, "stats": stats})


@bp.get("/orders/detail")
@admin_required
def admin_orders_detail():
    """交易监管页「状态卡」的下钻明细（需求①）。

    type=pending  进行中的交易列表（按挂得最久排前面）
    type=sellers  正在交易的商家：每人几笔进行中 + 在售/已售件数 + 好评率
    type=today    今日新增订单
    type=longest  挂得最久的那一笔（含双方信息、自提点、交易说明等完整细节）
    """
    kind = arg_str("type") or "pending"
    now = datetime.now()

    def order_row(order):
        product = Product.query.get(order.product_id)
        seller = User.query.get(order.seller_id)
        data = order.to_dict()
        data["product_name"] = product.name if product else None
        data["product_code"] = product.product_code if product else None
        data["seller_code"] = f"{seller.seller_seq:04d}" if seller and seller.seller_seq else None
        data["elapsed_minutes"] = int((now - order.created_at).total_seconds() // 60)
        return data

    if kind == "pending":
        rows = (Order.query.filter(Order.status == ORDER_PENDING)
                .order_by(Order.created_at.asc()).limit(200).all())
        return ok({"type": kind, "title": "进行中的交易",
                   "subtitle": "按挂得最久排前面，共 %d 笔" % len(rows),
                   "list": [order_row(o) for o in rows]})

    if kind == "sellers":
        grouped = (db.session.query(Order.seller_id, func.count(Order.id))
                   .filter(Order.status == ORDER_PENDING)
                   .group_by(Order.seller_id).all())
        items = []
        for seller_id, pending in grouped:
            seller = User.query.get(seller_id)
            if seller is None:
                continue
            items.append({
                "seller_id": seller_id,
                "nickname": seller.nickname,
                "seller_code": f"{seller.seller_seq:04d}" if seller.seller_seq else None,
                "pending": pending,
                "on_sale": Product.query.filter_by(
                    seller_id=seller_id, status=PRODUCT_ON_SALE).count(),
                "sold": Product.query.filter_by(
                    seller_id=seller_id, status=PRODUCT_SOLD).count(),
                "rating": seller_rating(seller_id),
            })
        items.sort(key=lambda x: (-x["pending"], x["nickname"] or ""))
        return ok({"type": kind, "title": "正在交易的商家",
                   "subtitle": "按进行中笔数排序，共 %d 位" % len(items), "list": items})

    if kind == "today":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        rows = (Order.query.filter(Order.created_at >= start)
                .order_by(Order.created_at.desc()).limit(200).all())
        return ok({"type": kind, "title": "今日新增订单",
                   "subtitle": "%s 00:00 起，共 %d 笔" % (start.strftime("%Y-%m-%d"), len(rows)),
                   "list": [order_row(o) for o in rows]})

    if kind == "longest":
        order = (Order.query.filter(Order.status == ORDER_PENDING)
                 .order_by(Order.created_at.asc()).first())
        if order is None:
            return ok({"type": kind, "title": "挂得最久的一笔交易",
                       "subtitle": "当前没有进行中的交易", "order": None})
        data = order_row(order)
        product = Product.query.get(order.product_id)
        data["product_views"] = product.views if product else None
        data["product_status"] = product.status if product else None
        data["product_price"] = float(product.price) if product else None
        data["buyer_order_count"] = Order.query.filter_by(buyer_id=order.buyer_id).count()
        data["seller_pending_count"] = Order.query.filter_by(
            seller_id=order.seller_id, status=ORDER_PENDING).count()
        return ok({"type": kind, "title": "挂得最久的一笔交易",
                   "subtitle": "已进行 %d 分钟" % data["elapsed_minutes"], "order": data})

    return fail("未知的下钻类型")


def _ago_text(when) -> str:
    """把时间说成人话：刚刚 / N 分钟前 / N 小时前 / N 天前。"""
    if when is None:
        return ""
    seconds = int((datetime.now() - when).total_seconds())
    if seconds < 60:
        return "刚刚"
    if seconds < 3600:
        return f"{seconds // 60} 分钟前"
    if seconds < 86400:
        return f"{seconds // 3600} 小时前"
    return f"{seconds // 86400} 天前"


@bp.get("/logs/<int:log_id>")
@admin_required
def admin_log_detail(log_id: int):
    """「动态监控」单条日志的详情（需求②）。

    不只给日志本身，还把**涉及的对象**一并查出来：发起人、精确时间、
    相关订单（交易双方、金额、状态、自提点、下单/完成时间）、相关商品（名称/编号/价格/状态）、
    以及评价或举报的具体内容。对象已被彻底删除时如实说明。
    """
    log = OperationLog.query.get(log_id)
    if log is None:
        return fail("日志不存在", 404)

    data = log.to_dict()
    data["ago_text"] = _ago_text(log.created_at)

    actor = User.query.get(log.user_id) if log.user_id else None
    result = {
        "log": data,
        "actor": {
            "id": actor.id if actor else None,
            "nickname": actor.nickname if actor else (log.username or "系统"),
            "username": actor.username if actor else log.username,
            "role": log.role or (actor.role if actor else ""),
            "bio": (actor.bio or None) if actor else None,
        },
        "order": None,
        "product": None,
        "extra": None,
        "links": [],
    }

    order = None
    product = None
    if log.target_type == "order" and log.target_id:
        order = Order.query.get(log.target_id)
    elif log.target_type == "product" and log.target_id:
        product = Product.query.get(log.target_id)
    elif log.target_type == "review" and log.target_id:
        review = Review.query.get(log.target_id)
        if review:
            order = Order.query.get(review.order_id) if review.order_id else None
            result["extra"] = {
                "kind": "review",
                "rating": review.rating,
                "content": review.content,
                "reviewer": review.reviewer.nickname if review.reviewer else None,
                "reviewee": review.reviewee.nickname if review.reviewee else None,
            }
    elif log.target_type == "report" and log.target_id:
        report = Report.query.get(log.target_id)
        if report:
            result["extra"] = {
                "kind": "report",
                "reason": report.reason,
                "status": report.status,
                "reporter": report.reporter.nickname if report.reporter else None,
                "target": "商品" if report.product_id else "帖子",
            }

    if order:
        buyer = User.query.get(order.buyer_id)
        seller = User.query.get(order.seller_id)
        product = product or (Product.query.get(order.product_id) if order.product_id else None)
        result["order"] = {
            "id": order.id,
            "order_no": order.order_no,
            "status": order.status,
            "status_text": order.STATUS_TEXT.get(order.status, order.status),
            "price": float(order.price),
            "created_at": _dt(order.created_at),
            "finished_at": _dt(order.finished_at),
            "ago_text": _ago_text(order.created_at),
            "trade_note": order.trade_note or "",
            "meet_place": order.meet_place.name if order.meet_place else None,
            "buyer": {"id": order.buyer_id, "nickname": buyer.nickname if buyer else None},
            "seller": {
                "id": order.seller_id,
                "nickname": seller.nickname if seller else None,
                "seller_code": f"{seller.seller_seq:04d}" if seller and seller.seller_seq else None,
            },
        }
        result["links"].append({"label": "查看该订单的商品", "hash": f"#/product/{order.product_id}"})

    if product:
        result["product"] = {
            "id": product.id,
            "name": product.name,
            "product_code": product.product_code,
            "price": float(product.price),
            "status": product.status,
            "status_text": (product.to_dict().get("status_text") or product.status),
            "condition": product.condition,
            "category_name": product.category.name if product.category else None,
            "seller_id": product.seller_id,
            "seller_nickname": product.seller.nickname if product.seller else None,
            "views": product.views,
        }
        result["links"].append({"label": "查看商品详情", "hash": f"#/product/{product.id}"})
        if product.seller_id:
            result["links"].append(
                {"label": "查看卖家主页", "hash": f"#/seller/{product.seller_id}"})

    if log.target_type == "product" and log.target_id and product is None:
        result["extra"] = {"kind": "missing", "message": "这件商品已被彻底删除，只能从日志回溯"}

    return ok(result)


@bp.get("/logs")
@admin_required
def admin_logs():
    """操作日志时间线（「动态监控」）：默认按时间倒序。

    支持按 动作 / 关键词 / **动作时间区间** / **动作发起人** / **具体商品（名称或商品编号）** /
    **订单号** 筛选（需求③）。商品与订单号这两种筛选要跨表关联：
    - 商品：命中「日志直接指向该商品」以及「指向该商品相关订单/评价」的日志；
    - 订单号：命中「日志直接指向该订单」的日志。
    """
    page, size = paginate_args(30)
    action = arg_str("action")
    keyword = arg_str("keyword")
    date_from = arg_str("date_from")
    date_to = arg_str("date_to")
    user_id = arg_int("user_id")
    product = arg_str("product")
    order_no = arg_str("order_no")

    q = OperationLog.query
    if action and action != "all":
        q = q.filter(OperationLog.action == action)
    if keyword:
        like = f"%{keyword}%"
        q = q.filter(or_(OperationLog.summary.like(like),
                         OperationLog.username.like(like),
                         OperationLog.action.like(like)))

    if date_from:
        try:
            q = q.filter(OperationLog.created_at >= datetime.strptime(date_from, "%Y-%m-%d"))
        except ValueError:
            return fail("起始日期格式应为 YYYY-MM-DD")
    if date_to:
        try:
            # 结束日期含当天整天，所以要 < 次日 00:00
            end = datetime.strptime(date_to, "%Y-%m-%d") + timedelta(days=1)
        except ValueError:
            return fail("结束日期格式应为 YYYY-MM-DD")
        q = q.filter(OperationLog.created_at < end)

    if user_id:
        q = q.filter(OperationLog.user_id == user_id)

    if order_no:
        oids = [o.id for o in
                Order.query.filter(Order.order_no.like(f"%{order_no}%")).limit(500)]
        q = q.filter(OperationLog.target_type == "order",
                     OperationLog.target_id.in_(oids or [-1]))

    if product:
        # 商品编号精确匹配 + 商品名模糊匹配，两者都算
        pids = {p.id for p in Product.query.filter(Product.product_code == product).all()}
        pids |= {p.id for p in
                 Product.query.filter(Product.name.like(f"%{product}%")).limit(200).all()}
        if not pids:
            return ok({"list": [], "total": 0, "page": 1, "page_size": size,
                       "actions": _log_actions(), "actors": _log_actors()})
        pids = list(pids)
        oids = [o.id for o in Order.query.filter(Order.product_id.in_(pids))]
        rids = [r.id for r in Review.query.filter(Review.product_id.in_(pids))]
        conds = [and_(OperationLog.target_type == "product",
                      OperationLog.target_id.in_(pids))]
        if oids:
            conds.append(and_(OperationLog.target_type == "order",
                              OperationLog.target_id.in_(oids)))
        if rids:
            conds.append(and_(OperationLog.target_type == "review",
                              OperationLog.target_id.in_(rids)))
        q = q.filter(or_(*conds))

    total = q.count()
    rows = (q.order_by(OperationLog.created_at.desc(), OperationLog.id.desc())
            .offset((page - 1) * size).limit(size).all())

    return ok({"list": [r.to_dict() for r in rows], "total": total,
               "page": page, "page_size": size,
               "actions": _log_actions(), "actors": _log_actors()})


def _log_actions() -> list[dict]:
    """筛选下拉用：库里出现过的动作码。"""
    used = [a for (a,) in db.session.query(OperationLog.action).distinct().all()]
    return sorted(({"action": a, "text": OperationLog.ACTIONS.get(a, a)} for a in used),
                  key=lambda x: x["action"])


def _log_actors() -> list[dict]:
    """筛选下拉用：库里出现过的操作人。"""
    pairs = (db.session.query(OperationLog.user_id, OperationLog.username)
             .filter(OperationLog.user_id.isnot(None)).distinct().all())
    ids = [uid for uid, _name in pairs]
    users = {u.id: u for u in User.query.filter(User.id.in_(ids)).all()} if ids else {}
    actors = [{
        "id": uid,
        "nickname": users[uid].nickname if uid in users else (name or ""),
        "username": users[uid].username if uid in users else name,
    } for uid, name in pairs]
    return sorted(actors, key=lambda x: x["nickname"] or "")


@bp.patch("/products/<int:pid>/status")
@admin_required
def admin_change_status(pid: int):
    product = Product.query.get(pid)
    if product is None or product.status == PRODUCT_DELETED:
        return fail("商品不存在", 404)

    target = (json_body().get("status") or "").strip()
    if target not in (PRODUCT_ON_SALE, PRODUCT_OFF_SHELF):
        return fail("只能切换到「在售」或「已下架」")
    # 已售商品不可上下架：一旦卖出去，改状态会让历史订单与商品对不上
    if product.status == PRODUCT_SOLD:
        return fail("该商品已售出，不能再上下架；如需处理请直接删除")

    product.status = target
    db.session.commit()
    return ok(product.to_dict(), msg="已重新上架" if target == PRODUCT_ON_SALE else "已下架")


@bp.delete("/products/<int:pid>")
@admin_required
def admin_delete_product(pid: int):
    product = Product.query.get(pid)
    if product is None or product.status == PRODUCT_DELETED:
        return fail("商品不存在", 404)
    product.status = PRODUCT_DELETED
    db.session.commit()
    return ok(msg="商品已删除")


# ================================================================ 举报审核
@bp.get("/reports")
@admin_required
def report_list():
    page, size = paginate_args(20)
    status = arg_str("status") or "pending"
    q = Report.query
    if status != "all":
        q = q.filter(Report.status == status)
    total = q.count()
    items = q.order_by(Report.created_at.desc()).offset((page - 1) * size).limit(size).all()

    counts = {
        "pending": Report.query.filter_by(status="pending").count(),
        "handled": Report.query.filter_by(status="handled").count(),
        "dismissed": Report.query.filter_by(status="dismissed").count(),
    }
    return ok({"list": [r.to_dict() for r in items], "total": total,
               "page": page, "page_size": size, "counts": counts,
               # 需求④：前端弹窗的「大致原因」下拉直接用这份清单，避免前后端各写一套
               "reason_options": REPORT_REASONS})


# 处理举报时可选的「大致原因」（需求④）：删帖/下架通知发布者、驳回通知举报者
REPORT_REASONS = {
    "handle": ["违规内容", "虚假信息", "广告刷屏", "人身攻击", "涉及隐私", "其他"],
    "dismiss": ["证据不足", "内容不违规", "重复举报", "已处理过", "其他"],
}


@bp.patch("/reports/<int:rid>")
@admin_required
def handle_report(rid: int):
    """action=handle → 下架商品 / 删除帖子；action=dismiss → 驳回。

    需求④：处理时可以填「大致原因（预设）+ 详细说明」，处理结果会**以私信反馈**：
    删帖/下架 → 通知帖子/商品的发布者；驳回 → 通知举报者。
    """
    user = current_user()
    body = json_body()
    report = Report.query.get(rid)
    if report is None:
        return fail("举报不存在", 404)
    if report.status != "pending":
        return fail("该举报已经处理过了", 409)

    action = (body.get("action") or "").strip().lower()
    if action not in ("handle", "dismiss"):
        return fail("处理动作只能是 handle（处理）或 dismiss（驳回）")

    reasons = REPORT_REASONS[action]
    reason_code = (body.get("reason_code") or "").strip()
    if reason_code and reason_code not in reasons:
        return fail("原因不在可选项里：" + "、".join(reasons))
    reason_code = reason_code or "其他"      # 不传时给个中性值，消息依然读得通
    reason_text = (body.get("reason_text") or "").strip()[:200]

    message = ""
    notice = ""
    notify_id = None
    if action == "handle":
        if report.product_id:
            product = Product.query.get(report.product_id)
            if product and product.status != PRODUCT_DELETED:
                product.status = PRODUCT_OFF_SHELF
            title = product.name if product else "（商品已删除）"
            notify_id = product.seller_id if product else None
            message = "已下架被举报的商品"
            notice = f"【平台通知】你发布的商品《{title}》因【{reason_code}】已被下架。"
        elif report.post_id:
            post = Post.query.get(report.post_id)
            if post and post.status == "normal":
                post.status = "deleted"
            title = post.title if post else "（帖子已删除）"
            notify_id = post.author_id if post else None
            message = "已删除被举报的帖子"
            notice = f"【平台通知】你发布的帖子《{title}》因【{reason_code}】已被删除。"
        report.status = "handled"
    else:
        if report.post_id and report.post:
            title = report.post.title
        elif report.product_id and report.product:
            title = report.product.name
        else:
            title = "（对象已删除）"
        notify_id = report.reporter_id
        report.status = "dismissed"
        message = "已驳回该举报"
        notice = f"【平台通知】你对《{title}》的举报，经核实因【{reason_code}】未予处理（已驳回）。"

    if reason_text:
        notice += f"补充说明：{reason_text}"
    if notify_id:
        notice += "（本条为平台通知，无需回复）"

    report.handled_by = user.id
    report.handled_at = datetime.now()

    # 需求④：以私信把处理结果反馈给相关的人
    if notify_id and notify_id != user.id:
        db.session.add(Message(sender_id=user.id, receiver_id=notify_id,
                               content=notice[:Message.MAX_LENGTH]))
    audit.record("report_handle" if action == "handle" else "report_dismiss",
                 "report", report.id,
                 f"{'处理' if action == 'handle' else '驳回'}举报（原因：{reason_code}"
                 + (f"，说明：{reason_text}" if reason_text else "")
                 + f"）：{notice}")
    db.session.commit()
    return ok(report.to_dict(), msg=message)


# ================================================================ 基础数据
# ---------------------------------------------------------------- 分类
@bp.post("/categories")
@admin_required
def create_category():
    body = json_body()
    name = (body.get("name") or "").strip()
    if not name:
        return fail("分类名不能为空")
    if Category.query.filter_by(name=name).first():
        return fail("分类名已存在")
    category = Category(name=name, icon=(body.get("icon") or "").strip()[:10],
                        sort=int(body.get("sort") or 0))
    code = (body.get("code") or "").strip().upper()
    if code:
        if len(code) != 2:
            return fail("字母码必须是 2 位（如 TA / DG / LF / SP / OT）")
        if Category.query.filter_by(code=code).first():
            return fail(f"字母码 {code} 已被其他分类占用")
        category.code = code
    db.session.add(category)
    db.session.commit()
    return ok(category.to_dict(with_subs=True), msg="分类已新增")


@bp.put("/categories/<int:cid>")
@admin_required
def update_category(cid: int):
    category = Category.query.get(cid)
    if category is None:
        return fail("分类不存在", 404)
    body = json_body()
    if "name" in body:
        name = (body.get("name") or "").strip()
        if not name:
            return fail("分类名不能为空")
        exists = Category.query.filter(Category.name == name, Category.id != cid).first()
        if exists:
            return fail("分类名已存在")
        category.name = name
    if "icon" in body:
        category.icon = (body.get("icon") or "").strip()[:10]
    if "sort" in body:
        category.sort = int(body.get("sort") or 0)
    if "code" in body:
        code = (body.get("code") or "").strip().upper()
        if code and len(code) != 2:
            return fail("字母码必须是 2 位（如 TA / DG / LF / SP / OT）")
        if code:
            taken = Category.query.filter(Category.code == code, Category.id != cid).first()
            if taken:
                return fail(f"字母码 {code} 已被「{taken.name}」占用")
        category.code = code or None
    db.session.commit()
    return ok(category.to_dict(with_subs=True), msg="分类已保存")


@bp.delete("/categories/<int:cid>")
@admin_required
def delete_category(cid: int):
    category = Category.query.get(cid)
    if category is None:
        return fail("分类不存在", 404)
    used = Product.query.filter(Product.category_id == cid,
                                Product.status != PRODUCT_DELETED).count()
    if used:
        return fail(f"该分类下还有 {used} 件商品，不能删除")
    # 已软删除的商品仍然占着 category_id 外键：只统计「未删除」会放行，
    # 然后被 FK 拦住抛 500。这里提前给出可读提示。
    dangling = Product.query.filter(Product.category_id == cid).count()
    if dangling:
        return fail(f"该分类下还有 {dangling} 件商品记录（含已删除的），"
                    "请先到「我的商品 → 已删除」彻底删除这些记录再删分类")
    Subcategory.query.filter_by(category_id=cid).delete()
    db.session.delete(category)
    db.session.commit()
    return ok(msg="分类已删除")


# ---------------------------------------------------------------- 小类
@bp.post("/subcategories")
@admin_required
def create_subcategory():
    body = json_body()
    category_id = body.get("category_id")
    name = (body.get("name") or "").strip()
    if not category_id or Category.query.get(int(category_id)) is None:
        return fail("请选择所属分类")
    if not name:
        return fail("小类名不能为空")
    exists = Subcategory.query.filter_by(category_id=int(category_id), name=name).first()
    if exists:
        return fail("该分类下已存在同名小类")
    sub = Subcategory(category_id=int(category_id), name=name[:50])
    # 商品编号的小类段要的是「大类内稳定序号」：新增小类时自动排在末尾，
    # 之后不随删除变化（所以后台不提供手填，避免把已有编号的含义改掉）。
    biggest = (
        db.session.query(db.func.max(Subcategory.seq_in_category))
        .filter(Subcategory.category_id == int(category_id)).scalar() or 0
    )
    sub.seq_in_category = int(biggest) + 1
    db.session.add(sub)
    db.session.commit()
    return ok(sub.to_dict(), msg="小类已新增")


@bp.put("/subcategories/<int:sid>")
@admin_required
def update_subcategory(sid: int):
    sub = Subcategory.query.get(sid)
    if sub is None:
        return fail("小类不存在", 404)
    body = json_body()
    if "name" in body:
        name = (body.get("name") or "").strip()
        if not name:
            return fail("小类名不能为空")
        sub.name = name[:50]
    if "category_id" in body and body.get("category_id"):
        if Category.query.get(int(body["category_id"])) is None:
            return fail("所属分类不存在")
        sub.category_id = int(body["category_id"])
    db.session.commit()
    return ok(sub.to_dict(), msg="小类已保存")


@bp.delete("/subcategories/<int:sid>")
@admin_required
def delete_subcategory(sid: int):
    sub = Subcategory.query.get(sid)
    if sub is None:
        return fail("小类不存在", 404)
    used = Product.query.filter(Product.subcategory_id == sid,
                                Product.status != PRODUCT_DELETED).count()
    if used:
        return fail(f"该小类下还有 {used} 件商品，不能删除")
    db.session.delete(sub)
    db.session.commit()
    return ok(msg="小类已删除")


# ---------------------------------------------------------------- 校园地点
@bp.post("/places")
@admin_required
def create_place():
    body = json_body()
    name = (body.get("name") or "").strip()
    ptype = (body.get("type") or "其他").strip()
    if not name:
        return fail("地点名不能为空")
    if ptype not in CampusPlace.PLACE_TYPES:
        return fail("地点类型不合法")
    if CampusPlace.query.filter_by(name=name).first():
        return fail("该地点已存在")
    try:
        lng, lat = float(body.get("lng")), float(body.get("lat"))
    except (TypeError, ValueError):
        return fail("请填写合法的经纬度")
    if not (-180 <= lng <= 180) or not (-90 <= lat <= 90):
        return fail("经纬度超出合法范围")

    place = CampusPlace(name=name[:50], type=ptype, lng=lng, lat=lat,
                        sort=int(body.get("sort") or 0))
    db.session.add(place)
    db.session.commit()
    return ok(place.to_dict(), msg="校园地点已新增")


@bp.put("/places/<int:pid>")
@admin_required
def update_place(pid: int):
    place = CampusPlace.query.get(pid)
    if place is None:
        return fail("地点不存在", 404)
    body = json_body()
    if "name" in body:
        name = (body.get("name") or "").strip()
        if not name:
            return fail("地点名不能为空")
        place.name = name[:50]
    if "type" in body:
        if body.get("type") not in CampusPlace.PLACE_TYPES:
            return fail("地点类型不合法")
        place.type = body["type"]
    if "lng" in body or "lat" in body:
        try:
            lng = float(body.get("lng", place.lng))
            lat = float(body.get("lat", place.lat))
        except (TypeError, ValueError):
            return fail("请填写合法的经纬度")
        if not (-180 <= lng <= 180) or not (-90 <= lat <= 90):
            return fail("经纬度超出合法范围")
        place.lng, place.lat = lng, lat
    if "sort" in body:
        place.sort = int(body.get("sort") or 0)
    db.session.commit()
    return ok(place.to_dict(), msg="校园地点已保存")


@bp.delete("/places/<int:pid>")
@admin_required
def delete_place(pid: int):
    place = CampusPlace.query.get(pid)
    if place is None:
        return fail("地点不存在", 404)
    # products.default_place_id / orders.meet_place_id 都是 ON DELETE SET NULL
    db.session.delete(place)
    db.session.commit()
    return ok(msg="校园地点已删除")


# ================================================================ 数据看板
@bp.get("/stats")
@admin_required
def dashboard_stats():
    """全部口径都基于「未删除」的商品，保证四个数字与图表自洽。"""
    alive = Product.query.filter(Product.status != PRODUCT_DELETED)

    total = alive.count()
    on_sale = alive.filter(Product.status == PRODUCT_ON_SALE).count()
    sold = alive.filter(Product.status == PRODUCT_SOLD).count()
    off_shelf = alive.filter(Product.status == PRODUCT_OFF_SHELF).count()

    # 分类占比
    pie_rows = (
        db.session.query(Category.name, Category.icon, func.count(Product.id))
        .join(Product, Product.category_id == Category.id)
        .filter(Product.status != PRODUCT_DELETED)
        .group_by(Category.id, Category.name, Category.icon)
        .order_by(func.count(Product.id).desc())
        .all()
    )

    # 价格区间分布（复合条件必须用 and_ 包成单个表达式，case 只接受 (条件, 值) 二元组）
    bars = (
        db.session.query(
            func.sum(case((Product.price <= 20, 1), else_=0)),
            func.sum(case((and_(Product.price > 20, Product.price <= 50), 1), else_=0)),
            func.sum(case((and_(Product.price > 50, Product.price <= 100), 1), else_=0)),
            func.sum(case((and_(Product.price > 100, Product.price <= 200), 1), else_=0)),
            func.sum(case((Product.price > 200, 1), else_=0)),
        )
        .filter(Product.status != PRODUCT_DELETED)
        .one()
    )

    order_counts = {
        "total": Order.query.count(),
        ORDER_PENDING: Order.query.filter_by(status=ORDER_PENDING).count(),
        ORDER_DONE: Order.query.filter_by(status=ORDER_DONE).count(),
        ORDER_CANCELED: Order.query.filter_by(status=ORDER_CANCELED).count(),
    }

    return ok({
        "cards": {"total": total, "on_sale": on_sale, "sold": sold, "off_shelf": off_shelf},
        "category_pie": [
            {"name": name, "icon": icon, "count": int(count)} for name, icon, count in pie_rows
        ],
        "price_bars": {
            "labels": ["0-20", "20-50", "50-100", "100-200", "200+"],
            "values": [int(v or 0) for v in bars],
        },
        "orders": order_counts,
        "users": User.query.count(),
        "reports_pending": Report.query.filter_by(status="pending").count(),
        "posts": Post.query.filter_by(status="normal").count(),
    })


# ================================================================ 备份 / 恢复
@bp.post("/backup")
@admin_required
def make_backup():
    """导出全库数据为 JSON，同时在本机 backups/ 目录留一份副本。"""
    payload = dump_all()
    backup_dir = Path(current_app.config["BACKUP_DIR"])
    backup_dir.mkdir(parents=True, exist_ok=True)
    filename = f"campus-backup-{datetime.now():%Y%m%d-%H%M%S}.json"
    (backup_dir / filename).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    counts = {name: len(rows) for name, rows in payload["data"].items()}
    return ok({"filename": filename, "download_url": f"/api/admin/backup/{filename}",
               "payload": payload, "counts": counts},
              msg="备份完成")


@bp.get("/backup/<path:filename>")
@admin_required
def download_backup(filename: str):
    return send_from_directory(current_app.config["BACKUP_DIR"], filename,
                               as_attachment=True)


@bp.get("/backups")
@admin_required
def list_backups():
    backup_dir = Path(current_app.config["BACKUP_DIR"])
    backup_dir.mkdir(parents=True, exist_ok=True)
    files = sorted(backup_dir.glob("*.json"), reverse=True)
    return ok([
        {"filename": f.name, "size": f.stat().st_size,
         "created_at": datetime.fromtimestamp(f.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S")}
        for f in files
    ])


@bp.post("/restore")
@admin_required
def restore():
    """用上传的 JSON 备份整体恢复数据（会覆盖当前全部业务数据）。"""
    payload = json_body()
    if not payload:
        return fail("请提交备份文件内容")
    try:
        stats = load_all(payload)
    except Exception as exc:  # noqa: BLE001
        db.session.rollback()
        return fail(f"恢复失败：{exc}", 400)
    return ok({"restored": stats}, msg="数据已恢复")


@bp.post("/reset-demo")
@admin_required
def reset_demo():
    """重置示例数据。"""
    from seed import seed_all

    stats = seed_all(reset=True)
    return ok(stats, msg="示例数据已重置")


@bp.get("/users")
@admin_required
def user_list():
    page, size = paginate_args(20)
    total = User.query.count()
    items = (User.query.order_by(User.id).offset((page - 1) * size).limit(size).all())
    return ok({"list": [u.to_dict() for u in items], "total": total,
               "page": page, "page_size": size})
