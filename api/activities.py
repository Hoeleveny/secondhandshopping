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

# ---------------------------------------------------------------- 会话时长（近似）
def session_end(user_id: int, login_at) -> tuple:
    """一次登录会话的结束时间（**近似口径**，用户 2026-10-18 拍板）。

    规则：下一次「登出」或下一次「登录」（先到的那个）为界；
    界之前该用户的最后一次活动即会话结束；什么都没有则该会话仍算进行中。
    返回 (结束时间, 是否正常退出)。
    """
    nxt = (UserActivity.query
           .filter(UserActivity.user_id == user_id,
                   UserActivity.kind.in_(("login", "logout")),
                   UserActivity.created_at > login_at)
           .order_by(UserActivity.created_at.asc()).first())
    limit = nxt.created_at if nxt else None
    q = UserActivity.query.filter(UserActivity.user_id == user_id,
                                  UserActivity.created_at >= login_at)
    if limit is not None:
        q = q.filter(UserActivity.created_at <= limit)
    last = q.order_by(UserActivity.created_at.desc()).first()
    end_at = last.created_at if last else login_at
    closed = bool(nxt is not None and nxt.kind == "logout")
    return end_at, closed


def duration_text(seconds: int) -> str:
    seconds = max(0, int(seconds))
    if seconds < 60:
        return "%d 秒" % seconds
    minutes = seconds // 60
    if minutes < 60:
        return "%d 分钟" % minutes
    hours, minutes = divmod(minutes, 60)
    return "%d 小时 %d 分钟" % (hours, minutes) if minutes else "%d 小时" % hours


def activity_query(*, action=None, user_id=None, user_q=None,
                   start=None, end=None, page_path=None, kind=None,
                   exclude=False):
    """行为记录的统一筛选（供「动态监控」把两类数据合并时复用）。"""
    q = UserActivity.query
    if exclude:            # 按「商品 / 订单号」筛时，行为记录本来就没有这些概念，直接排除
        return q.filter(UserActivity.id < 0)
    want = kind or action
    if want and want != "all":
        if want in UserActivity.KINDS:
            q = q.filter(UserActivity.kind == want)
        else:
            q = q.filter(UserActivity.id < 0)      # 选的是业务动作 → 行为记录不参与
    if user_id:
        q = q.filter(UserActivity.user_id == user_id)
    if user_q:
        if user_q.isdigit():
            q = q.filter(UserActivity.user_id == int(user_q))
        else:
            like = f"%{user_q}%"
            ids = [u.id for u in User.query.filter(
                (User.username.like(like)) | (User.nickname.like(like))).limit(300).all()]
            q = q.filter(UserActivity.user_id.in_(ids or [-1]))
    if page_path:
        q = q.filter(UserActivity.page.like(f"%{page_path}%"))
    if start:
        q = q.filter(UserActivity.created_at >= start)
    if end:
        q = q.filter(UserActivity.created_at < end)
    return q


def activity_row(a: UserActivity) -> dict:
    """把一条行为记录转成「动态监控」时间线里的一行（与操作日志同构）。"""
    ts = a.created_at
    row = {
        "id": a.id,
        "key": "act-%d" % a.id,
        "source": "activity",
        "user_id": a.user_id,
        "nickname": a.user.nickname if a.user else "（已注销）",
        "username": a.user.username if a.user else "",
        "action": a.kind,
        "action_text": UserActivity.KINDS.get(a.kind, a.kind),
        "summary": "",
        "page": a.page,
        "page_name": a.page_name,
        "ip": a.ip,
        "created_at": ts.strftime("%Y-%m-%d %H:%M:%S") if ts else None,
    }
    if a.kind == "login":
        end_at, closed = session_end(a.user_id, ts)
        secs = int((end_at - ts).total_seconds()) if end_at else 0
        row["duration_seconds"] = secs
        row["duration_text"] = duration_text(secs)
        row["session_closed"] = closed
        row["summary"] = "登录（本次使用 %s%s）" % (
            duration_text(secs), "" if closed else "，未正常退出")
    elif a.kind == "logout":
        row["summary"] = "退出登录"
    else:
        row["summary"] = "浏览：%s" % (a.page_name or a.page or "—")
    return row


@bp.post("/admin/activities/delete")
@admin_required
def delete_activities():
    """删除选定的行为记录（与删除操作日志同一套交互）。"""
    ids = (json_body() or {}).get("ids") or []
    if not isinstance(ids, list) or not ids:
        return fail("请先勾选要删除的记录")
    try:
        clean = [int(x) for x in ids][:200]
    except (TypeError, ValueError):
        return fail("记录 id 不合法")
    rows = UserActivity.query.filter(UserActivity.id.in_(clean)).all()
    for r in rows:
        db.session.delete(r)
    db.session.commit()
    return ok({"deleted": len(rows)}, msg="已删除 %d 条行为记录" % len(rows))


# ---------------------------------------------------------------- 按用户小结（画像参考）
@bp.get("/admin/activities/profile")
@admin_required
def activities_profile():
    """单个用户的使用小结：登录次数、累计/平均时长、常去页面、最近活跃。"""
    user_id = arg_int("user_id")
    user_q = arg_str("user")
    target = None
    if user_id:
        target = User.query.get(user_id)
    elif user_q:
        like = f"%{user_q}%"
        target = (User.query.filter((User.username.like(like)) | (User.nickname.like(like)))
                  .order_by(User.id.asc()).first())
    if target is None:
        return fail("没找到这个用户", 404)

    rows = (UserActivity.query.filter(UserActivity.user_id == target.id)
            .order_by(UserActivity.created_at.asc()).all())
    logins = [r for r in rows if r.kind == "login"]
    logouts = [r for r in rows if r.kind == "logout"]
    pages = [r for r in rows if r.kind == "page"]

    total_secs = 0
    sessions = []
    for lg in logins:
        end_at, closed = session_end(target.id, lg.created_at)
        secs = int((end_at - lg.created_at).total_seconds()) if end_at else 0
        total_secs += secs
        sessions.append({
            "login_at": lg.created_at.strftime("%Y-%m-%d %H:%M:%S"),
            "end_at": end_at.strftime("%Y-%m-%d %H:%M:%S") if end_at else "",
            "seconds": secs, "duration_text": duration_text(secs), "closed": closed,
        })

    page_counter: dict = {}
    for p in pages:
        key = (p.page, p.page_name)
        page_counter[key] = page_counter.get(key, 0) + 1
    top_pages = [{"page": k[0], "name": k[1] or k[0], "count": v}
                 for k, v in sorted(page_counter.items(), key=lambda kv: -kv[1])[:5]]

    return ok({
        "user": target.to_dict(),
        "login_count": len(logins),
        "logout_count": len(logouts),
        "page_count": len(pages),
        "total_seconds": total_secs,
        "total_text": duration_text(total_secs),
        "avg_text": duration_text(total_secs // len(logins)) if logins else "0 秒",
        "last_active": (max(r.created_at for r in rows).strftime("%Y-%m-%d %H:%M:%S")
                        if rows else ""),
        "top_pages": top_pages,
        "recent_sessions": sessions[-5:][::-1],
    })
