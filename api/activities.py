"""用户行为监测（2026-10-18 需求①）：登录 / 登出 / 页面浏览。

- 前端每次路由切换上报一条 `page`，登录/登出在 auth 里记 `login` / `logout`；
- 管理员在「行为监测」页签看概览（今日登录/登出/浏览/活跃用户）、页面热度与明细；
- 这是"使用轨迹"，与 operation_logs（业务写操作留痕）刻意分开，互不干扰。
"""
from datetime import datetime, timedelta

from flask import Blueprint, request
from sqlalchemy import func

from api.common import (
    admin_required, arg_int, arg_str, current_user, fail, json_body, login_required,
    ok, paginate_args,
)
from extensions import db
from models import User, UserActivity

bp = Blueprint("activities", __name__, url_prefix="/api")

MAX_PAGE = 60
MAX_PAGE_NAME = 40
MAX_UA = 200


def client_ip() -> str:
    """客户端 IP：优先取反代头，其次 remote_addr。"""
    fwd = request.headers.get("X-Forwarded-For", "")
    if fwd:
        return fwd.split(",")[0].strip()[:45]
    return (request.remote_addr or "")[:45]


def client_ua() -> str:
    return (request.headers.get("User-Agent") or "")[:MAX_UA]


def record_activity(user_id: int, kind: str, page: str = "", page_name: str = "") -> None:
    """写一条行为记录（由调用方负责 commit）。

    kind 只能是 login / logout / page；page 只保留路径、去掉查询串。
    """
    if kind not in UserActivity.KINDS:
        return
    clean_page = (page or "").split("?")[0][:MAX_PAGE]
    if clean_page and not clean_page.startswith("/"):
        clean_page = "/" + clean_page
    db.session.add(UserActivity(
        user_id=user_id, kind=kind,
        page=clean_page, page_name=(page_name or "")[:MAX_PAGE_NAME],
        ip=client_ip(), user_agent=client_ua(),
    ))


# ---------------------------------------------------------------- 上报
@bp.post("/activities/page")
@login_required
def report_page_view():
    """前端每次切换页面时上报（登录用户）。"""
    me = current_user()
    body = json_body() or {}
    page = (body.get("page") or "").strip()
    if not page:
        return fail("page 不能为空")
    record_activity(me.id, "page", page, (body.get("name") or "").strip())
    db.session.commit()
    return ok(msg="ok")


# ---------------------------------------------------------------- 管理端
@bp.get("/admin/activities")
@admin_required
def list_activities():
    """行为明细：可按 类型 / 用户 / 页面 / 日期 筛选。"""
    page, size = paginate_args(30)
    kind = arg_str("kind")
    user_kw = arg_str("user")
    page_kw = arg_str("page_path")   # 注意：page 已被分页占用，这里叫 page_path 避免撞车
    date_from = arg_str("date_from")
    date_to = arg_str("date_to")

    q = UserActivity.query
    if kind in UserActivity.KINDS:
        q = q.filter(UserActivity.kind == kind)
    if page_kw:
        q = q.filter(UserActivity.page.like(f"%{page_kw}%"))
    if user_kw:
        like = f"%{user_kw}%"
        ids = [u.id for u in User.query.filter(
            (User.username.like(like)) | (User.nickname.like(like))).limit(200).all()]
        if not ids:
            return ok({"list": [], "total": 0, "page": page, "page_size": size,
                       "kinds": UserActivity.KINDS})
        q = q.filter(UserActivity.user_id.in_(ids))
    if date_from:
        q = q.filter(UserActivity.created_at >= f"{date_from} 00:00:00")
    if date_to:
        q = q.filter(UserActivity.created_at <= f"{date_to} 23:59:59")

    total = q.count()
    items = (q.order_by(UserActivity.created_at.desc(), UserActivity.id.desc())
             .offset((page - 1) * size).limit(size).all())
    return ok({
        "list": [a.to_dict() for a in items],
        "total": total, "page": page, "page_size": size,
        "kinds": UserActivity.KINDS,
        "pages": _page_options(),
    })


def _page_options() -> list[dict]:
    """目前出现过的页面（供筛选下拉）。"""
    rows = (db.session.query(UserActivity.page, UserActivity.page_name,
                             func.count(UserActivity.id))
            .filter(UserActivity.kind == "page", UserActivity.page != "")
            .group_by(UserActivity.page, UserActivity.page_name)
            .order_by(func.count(UserActivity.id).desc())
            .limit(50).all())
    return [{"page": p, "name": n or p, "count": c} for p, n, c in rows]


@bp.get("/admin/activities/summary")
@admin_required
def activities_summary():
    """概览：今日登录/登出/浏览/活跃用户 + 页面热度 Top + 活跃用户 Top。"""
    today = datetime.now().strftime("%Y-%m-%d")
    week_ago = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d 00:00:00")

    def count_of(kind: str, since: str = f"{today} 00:00:00") -> int:
        return (UserActivity.query
                .filter(UserActivity.kind == kind, UserActivity.created_at >= since)
                .count())

    active_users = (db.session.query(func.count(func.distinct(UserActivity.user_id)))
                    .filter(UserActivity.created_at >= f"{today} 00:00:00").scalar()) or 0
    active_users_week = (db.session.query(func.count(func.distinct(UserActivity.user_id)))
                         .filter(UserActivity.created_at >= week_ago).scalar()) or 0

    top_pages = [
        {"page": p, "name": n or p, "count": c}
        for p, n, c in (db.session.query(UserActivity.page, UserActivity.page_name,
                                         func.count(UserActivity.id))
                        .filter(UserActivity.kind == "page")
                        .group_by(UserActivity.page, UserActivity.page_name)
                        .order_by(func.count(UserActivity.id).desc())
                        .limit(8).all())
    ]

    top_users = []
    for uid, cnt, last in (db.session.query(
            UserActivity.user_id, func.count(UserActivity.id),
            func.max(UserActivity.created_at))
            .group_by(UserActivity.user_id)
            .order_by(func.count(UserActivity.id).desc())
            .limit(8).all()):
        u = User.query.get(uid)
        top_users.append({
            "user_id": uid,
            "nickname": u.nickname if u else "（已注销）",
            "username": u.username if u else "",
            "count": cnt,
            "last_at": last.strftime("%Y-%m-%d %H:%M:%S") if last else "",
        })

    return ok({
        "today": {
            "login": count_of("login"), "logout": count_of("logout"),
            "page": count_of("page"), "users": active_users,
        },
        "week_active_users": active_users_week,
        "top_pages": top_pages,
        "top_users": top_users,
        "total": UserActivity.query.count(),
    })
