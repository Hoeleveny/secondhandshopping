"""用户行为监测（2026-10-18 需求①）：登录 / 登出 / 页面浏览。

- 前端每次路由切换上报一条 `page`，登录/登出在 auth 里记 `login` / `logout`；
- 管理员在「行为监测」页签看概览（今日登录/登出/浏览/活跃用户）、页面热度与明细；
- 这是"使用轨迹"，与 operation_logs（业务写操作留痕）刻意分开，互不干扰。
"""
import re

from datetime import datetime, timedelta

from flask import Blueprint, request
from sqlalchemy import func

from api.common import (
    admin_required, arg_int, arg_str, current_user, fail, json_body, login_required,
    ok, paginate_args,
)
from extensions import db
from models import Category, Post, Product, User, UserActivity

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


def activity_row(a: UserActivity, titles=None) -> dict:
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
        title, kind = page_display_title(a, titles or {})
        row["summary"] = "浏览%s：%s" % (REF_LABEL.get(kind, "页面"), title)
        row["ref_kind"] = kind
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

    # ---- 用户类型（2026-10-18 需求③）：只看 TA 浏览过的【商品大类】与【帖子 tag】 ----
    product_ids, post_ids = [], []
    for p in pages:
        kind, rid = classify_page(p.page)
        if kind == "product":
            product_ids.append(rid)
        elif kind == "post":
            post_ids.append(rid)

    cat_counter: dict = {}
    if product_ids:
        prods = {x.id: x for x in Product.query.filter(
            Product.id.in_(set(product_ids))).all()}
        cats = {c.id: c for c in Category.query.all()}
        for pid in product_ids:
            pr = prods.get(pid)
            if pr is None:
                continue                      # 商品已被删，不计入偏好
            c = cats.get(pr.category_id)
            name = c.name if c else "未知"
            cat_counter[name] = cat_counter.get(name, 0) + 1

    tag_counter: dict = {}
    if post_ids:
        posts = {x.id: x for x in Post.query.filter(Post.id.in_(set(post_ids))).all()}
        for pid in post_ids:
            po = posts.get(pid)
            if po is not None:
                tag_counter[po.tag] = tag_counter.get(po.tag, 0) + 1

    def _breakdown(counter: dict) -> list:
        total = sum(counter.values())
        if not total:
            return []
        return sorted(({"name": k, "count": v, "share": round(v / total, 3)}
                       for k, v in counter.items()), key=lambda x: -x["count"])

    TYPE_MAP = {"教材": "学业备考型", "数码": "数码装备型", "生活用品": "日用生活型",
                "运动": "运动户外型", "其他": "杂货猎奇型"}
    product_total = sum(cat_counter.values())
    post_total = sum(tag_counter.values())
    breakdown = _breakdown(cat_counter)
    post_breakdown = _breakdown(tag_counter)

    MIN_SAMPLES = 5          # 样本太少不硬归类
    MIN_SHARE = 0.4          # 最高占比 ≥40% 才算有明确偏好
    if product_total < MIN_SAMPLES:
        main_type, main_reason = "样本不足", "浏览过的商品不足 %d 件" % MIN_SAMPLES
    elif breakdown[0]["share"] >= MIN_SHARE:
        top = breakdown[0]["name"]
        main_type = TYPE_MAP.get(top, "%s偏好型" % top)
        main_reason = "%s 占商品浏览的 %d%%（%d/%d）" % (
            top, round(breakdown[0]["share"] * 100), breakdown[0]["count"], product_total)
    else:
        main_type = "广泛浏览型"
        main_reason = "各类都看，最高只占 %d%%" % round(breakdown[0]["share"] * 100)

    focus = ("关注" + post_breakdown[0]["name"]) if post_breakdown else ""
    utype = {
        "main": main_type,
        "reason": main_reason,
        "share": breakdown[0]["share"] if breakdown else 0,
        "product_total": product_total,
        "post_total": post_total,
        "breakdown": breakdown,
        "post_breakdown": post_breakdown,
        "focus": focus,
        "rule": "最高占比 ≥%d%% 且商品浏览 ≥%d 次才归类，否则算广泛浏览 / 样本不足" % (
            round(MIN_SHARE * 100), MIN_SAMPLES),
    }

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
        "utype": utype,
    })

# ---------------------------------------------------------------- 浏览记录折叠（2026-10-18 需求②）
PRODUCT_PATH = re.compile(r"^/product/(\d+)$")
POST_PATH = re.compile(r"^/post/(\d+)$")
PAGE_GAP = timedelta(minutes=30)     # 同一用户间隔 ≤30 分钟的浏览算"一串"
MAX_GROUP_ITEMS = 50                 # 每组最多带出的商品/帖子条数


def classify_page(page: str) -> tuple:
    """浏览路径归类：/product/12 → ('product', 12)；/post/3 → ('post', 3)；其余 ('other', None)。"""
    raw = page or ""
    m = PRODUCT_PATH.match(raw)
    if m:
        return "product", int(m.group(1))
    m = POST_PATH.match(raw)
    if m:
        return "post", int(m.group(1))
    return "other", None


def ref_titles(rows) -> dict:
    """把浏览路径里的商品 id / 帖子 id 批量反查成名称（不新增字段，直接查现有表）。"""
    from models import Post, Product          # 避免顶层循环导入

    pids, post_ids = set(), set()
    for r in rows:
        kind, rid = classify_page(r.page)
        if kind == "product":
            pids.add(rid)
        elif kind == "post":
            post_ids.add(rid)
    titles = {}
    if pids:
        for p in Product.query.filter(Product.id.in_(pids)).all():
            titles[("product", p.id)] = p.name
    if post_ids:
        for p in Post.query.filter(Post.id.in_(post_ids)).all():
            titles[("post", p.id)] = (p.title or p.content or "")[:60]
    return titles


REF_LABEL = {"product": "商品", "post": "帖子"}


def page_display_title(a, titles: dict) -> tuple:
    """浏览记录的可读标题与分类：(标题, kind)；商品页/帖子页优先用反查到的真名。"""
    kind, rid = classify_page(a.page)
    if kind == "other":
        return (a.page_name or a.page or "—"), "other"
    found = titles.get((kind, rid))
    if found:
        return found, kind
    return "%s #%d（已删除）" % (REF_LABEL.get(kind, "对象"), rid), kind


def _page_item(a: UserActivity, titles: dict) -> dict:
    kind, rid = classify_page(a.page)
    title, _ = page_display_title(a, titles)
    return {
        "id": a.id,
        "at": a.created_at.strftime("%Y-%m-%d %H:%M:%S"),
        "page": a.page,
        "page_name": a.page_name,
        "kind": kind,                          # product / post / other
        "ref_id": rid,
        "title": title,
        "deleted": kind in ("product", "post") and (kind, rid) not in titles,
        "ip": a.ip,
    }


def group_sessions(rows) -> list:
    """把行为记录整理成「会话」（2026-10-18 需求③：登录记录太多，简化但不丢信息）。

    rows 需按 (created_at, id) **升序**。一次会话 = 一次登录 → 期间的浏览 → 登出
    （没有登出就以最后一次活动结束，标"未正常退出"）。
    没有登录记录的浏览（数据从中途开始）也各自成组，按 30 分钟间隔切分。
    """
    sessions, current = [], {}

    def _new(user_id, at, kind=None, aid=None):
        s = {"user_id": user_id, "start_at": at, "end_at": at, "closed_at": None,
             "login_id": None, "logout_id": None, "items": [], "orphan": True}
        if kind == "login":
            s["login_id"] = aid
            s["orphan"] = False
        elif kind == "logout":
            s["logout_id"] = aid
        sessions.append(s)
        current[user_id] = s
        return s

    for a in rows:
        if a.kind == "login":
            _new(a.user_id, a.created_at, "login", a.id)
        elif a.kind == "logout":
            s = current.get(a.user_id)
            if s is None or s["closed_at"] is not None:
                s = _new(a.user_id, a.created_at, "logout", a.id)
            s["logout_id"] = a.id
            s["closed_at"] = a.created_at
            s["end_at"] = a.created_at
        else:                                   # page
            s = current.get(a.user_id)
            if s is None:
                s = _new(a.user_id, a.created_at)
            elif s["closed_at"] is not None:
                s = _new(a.user_id, a.created_at)          # 登出之后又来浏览 → 新的一段
            elif (a.created_at - s["end_at"]) > PAGE_GAP and not s["login_id"]:
                s = _new(a.user_id, a.created_at)          # 无登录记录的浏览：间隔太大就切开
            s["end_at"] = a.created_at
            s["items"].append(a)
    return sessions


def session_row(s: dict, titles: dict) -> dict:
    """把一次会话变成时间线里的一行（默认折叠，点开看它浏览过的商品/帖子）。"""
    user = User.query.get(s["user_id"])
    items = [_page_item(a, titles) for a in sorted(s["items"], key=lambda x: (x.created_at, x.id),
                                                   reverse=True)]
    focus = [x for x in items if x["kind"] != "other"][:MAX_GROUP_ITEMS]
    other_count = len(items) - len(focus)
    secs = int((s["end_at"] - s["start_at"]).total_seconds()) if s["end_at"] else 0
    closed = s["closed_at"] is not None

    seen, names = set(), []
    for x in focus:
        if x["title"] in seen:
            continue
        seen.add(x["title"])
        names.append(x["title"])
        if len(names) >= 3:
            break

    start_txt = s["start_at"].strftime("%m-%d %H:%M")
    end_txt = s["end_at"].strftime("%H:%M")
    if s["login_id"]:
        head = "登录 %s，在线 %s" % (start_txt, duration_text(secs))
    else:
        head = "%s ~ %s 的浏览" % (start_txt, end_txt)
    if items:
        head += "，浏览 %d 个页面" % len(items)
    if names:
        head += "（%s%s）" % ("、".join(names), "…" if len(seen) >= 3 else "")
    if s["login_id"]:
        head += "，已退出" if closed else "，未正常退出"

    return {
        "id": None,
        "key": "ses-%d-%s" % (s["user_id"], s["start_at"].strftime("%Y%m%d%H%M%S")),
        "source": "session",
        "user_id": s["user_id"],
        "nickname": user.nickname if user else "（已注销）",
        "username": user.username if user else "",
        "action": "session",
        "action_text": "会话",
        "summary": head,
        "created_at": s["end_at"].strftime("%Y-%m-%d %H:%M:%S"),
        "start_at": s["start_at"].strftime("%Y-%m-%d %H:%M:%S"),
        "end_at": s["end_at"].strftime("%Y-%m-%d %H:%M:%S"),
        "duration_seconds": secs,
        "duration_text": duration_text(secs),
        "session_closed": closed,
        "count": len(items),
        "other_count": other_count,
        "items": focus,
        # 删除整次会话时用它定位（后端按 user + 时间范围删）
        "session_start": s["start_at"].strftime("%Y-%m-%d %H:%M:%S"),
        "session_end": s["end_at"].strftime("%Y-%m-%d %H:%M:%S"),
    }


@bp.post("/admin/activities/delete-session")
@admin_required
def delete_session():
    """删掉一次会话的全部行为记录（需求①：折叠的浏览记录也要能选中删除）。"""
    body = json_body() or {}
    try:
        user_id = int(body.get("user_id"))
    except (TypeError, ValueError):
        return fail("缺少用户")
    start = (body.get("start_at") or "").strip()
    end = (body.get("end_at") or "").strip()
    if not start or not end:
        return fail("缺少会话时间范围")
    try:
        t0 = datetime.strptime(start, "%Y-%m-%d %H:%M:%S")
        t1 = datetime.strptime(end, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return fail("时间格式不正确")
    rows = UserActivity.query.filter(
        UserActivity.user_id == user_id,
        UserActivity.created_at >= t0,
        UserActivity.created_at <= t1,
    ).all()
    for r in rows:
        db.session.delete(r)
    db.session.commit()
    return ok({"deleted": len(rows)}, msg="已删除 %d 条行为记录" % len(rows))
