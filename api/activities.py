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


@bp.post("/activities/image-view")
@login_required
def report_image_view():
    """详情页图片级埋点（2026-10-18 画像需求）：看的是第几张图、停留多久。

    前端只在「切换图片」和「离开页面」时各报一次，很轻。
    """
    from models import ProductImageView

    me = current_user()
    body = json_body() or {}
    try:
        product_id = int(body.get("product_id"))
        index = max(0, int(body.get("index") or 0))
        dwell = max(0, min(int(body.get("dwell_ms") or 0), 30 * 60 * 1000))
    except (TypeError, ValueError):
        return fail("参数不合法")
    if Product.query.get(product_id) is None:
        return fail("商品不存在", 404)
    db.session.add(ProductImageView(user_id=me.id, product_id=product_id,
                                    image_index=index, dwell_ms=dwell))
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

    # 2026-10-18 性能修复：原来是「每条登录都调 session_end() 查 2 次库」，
    # 1544 条登录 ≈ 3000 次查询、接口要 8 秒，画像卡一直停在"加载中"。
    # 改成对已取出的 rows 做一次归并（group_sessions 就是同一套口径），O(n) 无额外查询。
    total_secs = 0
    sessions = []
    for s_ in group_sessions(rows):
        if not s_["login_id"]:
            continue                      # 只统计"有登录"的会话
        secs = int((s_["end_at"] - s_["start_at"]).total_seconds())
        total_secs += secs
        sessions.append({
            "login_at": s_["start_at"].strftime("%Y-%m-%d %H:%M:%S"),
            "end_at": s_["end_at"].strftime("%Y-%m-%d %H:%M:%S"),
            "seconds": secs, "duration_text": duration_text(secs),
            "closed": s_["closed_at"] is not None,
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
    prods: dict = {}
    cats = {c.id: c for c in Category.query.all()}   # 大类表很小，画像多处要用，先取一次
    if product_ids:
        prods = {x.id: x for x in Product.query.filter(
            Product.id.in_(set(product_ids))).all()}
        for pid in product_ids:
            pr = prods.get(pid)
            if pr is None:
                continue                      # 商品已被删，不计入偏好
            c = cats.get(pr.category_id)
            name = c.name if c else "未知"
            cat_counter[name] = cat_counter.get(name, 0) + 1

    tag_counter: dict = {}
    posts: dict = {}
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

    # ================= 多维画像（2026-10-18 需求）=================
    from models import Favorite, Order, ProductImageView, Subcategory

    # ⑦ 停留时长：用「相邻两条页面记录的时间差」近似；>30 分钟视为挂机截断；最后一条无下一跳、不计
    page_rows = [r for r in rows if r.kind == "page"]
    dwells = []
    for i, r in enumerate(page_rows[:-1]):
        gap = (page_rows[i + 1].created_at - r.created_at).total_seconds()
        if gap <= 30 * 60:
            dwells.append((r.page, gap))
    total_dwell = int(sum(g for _p, g in dwells))
    product_dwells = [g for pg, g in dwells if classify_page(pg)[0] == "product"]
    avg_dwell = int(total_dwell / len(dwells)) if dwells else 0
    avg_product_dwell = int(sum(product_dwells) / len(product_dwells)) if product_dwells else 0

    # ⑦b 按对象聚合停留（2026-10-18 需求）：单件商品页停多久、某位商家主页停多久
    dwell_by_kind, dwell_by_ref = {}, {}
    for pg, g in dwells:
        kind, rid = classify_page(pg)
        dwell_by_kind.setdefault(kind, []).append(g)
        if kind in ("product", "post", "seller"):
            item = dwell_by_ref.setdefault((kind, rid), {"secs": 0.0, "visits": 0})
            item["secs"] += g
            item["visits"] += 1
    _titles = ref_titles(page_rows)
    KIND_LABEL = {"product": "商品详情", "post": "帖子详情", "seller": "商家主页", "other": "其它页面"}
    dwell_kinds = [
        {"kind": k, "name": KIND_LABEL.get(k, k), "count": len(v),
         "avg_secs": int(sum(v) / len(v)), "avg_text": duration_text(int(sum(v) / len(v)))}
        for k, v in sorted(dwell_by_kind.items(), key=lambda kv: -len(kv[1]))
    ]
    top_dwell = sorted(
        [{"kind": k, "ref_id": rid,
          "name": _titles.get((k, rid)) or "%s #%d" % (REF_LABEL.get(k, "对象"), rid),
          "seconds": int(v["secs"]), "visits": v["visits"],
          "avg_secs": int(v["secs"] / max(1, v["visits"])),
          "avg_text": duration_text(int(v["secs"] / max(1, v["visits"])))}
         for (k, rid), v in dwell_by_ref.items()],
        key=lambda x: -x["seconds"])[:5]

    # ② 价格带偏好
    PRICE_BANDS = [("0-50", 0, 50), ("50-200", 50, 200), ("200-500", 200, 500),
                   ("500-1000", 500, 1000), ("1000 以上", 1000, None)]
    price_counter = {}
    seen_products = set()
    revisit = 0
    for pid in product_ids:
        pr = prods.get(pid) if product_ids else None
        if pr is None:
            continue
        if pid in seen_products:
            revisit += 1
        seen_products.add(pid)
        price = float(pr.price or 0)
        for name, low, high in PRICE_BANDS:
            if price >= low and (high is None or price < high):
                price_counter[name] = price_counter.get(name, 0) + 1
                break
    price_breakdown = _breakdown(price_counter)

    # ④ 活跃时段（按小时）
    hour_counter = {}
    for r in rows:
        if r.kind in ("login", "page") and r.created_at:
            h = r.created_at.hour
            hour_counter[h] = hour_counter.get(h, 0) + 1
    peak_hours = sorted(hour_counter.items(), key=lambda kv: -kv[1])[:3]
    hours = [{"hour": h, "count": c} for h, c in sorted(hour_counter.items())]
    peak_text = ("、".join("%d:00" % h for h, _c in peak_hours)) if peak_hours else ""

    # ⑤ 深度 vs 广度
    depth = {
        "distinct_products": len(seen_products),
        "revisit_count": revisit,
        "avg_dwell_text": duration_text(avg_dwell),
        "avg_product_dwell_text": duration_text(avg_product_dwell),
        "total_dwell_text": duration_text(total_dwell),
        "style": ("深挖型" if revisit >= 3 and revisit >= len(seen_products) * 0.5
                  else ("广泛浏览型" if len(seen_products) >= 10 else "轻度浏览")),
    }

    # ⑥ 转化倾向：浏览过的商品里，收藏/下单了多少
    # 2026-10-18 修复：这里原来多写了一行 `Order = None`，把局部名 Order 置空，
    # 于是 `query(Order)` 必抛异常、被下面的 except 吞掉 → 「下单」恒为 0。删掉即可。
    fav, order_cnt = 0, 0
    try:
        fav = (db.session.query(Favorite).filter(Favorite.user_id == target.id)
               .filter(Favorite.product_id.in_(list(seen_products) or [-1])).count())
        order_cnt = (db.session.query(Order).filter(Order.buyer_id == target.id)
                     .filter(Order.product_id.in_(list(seen_products) or [-1])).count())
    except Exception:                       # noqa: BLE001 —— 画像不该因统计失败而中断
        fav, order_cnt = 0, 0
    conv = {
        "favorites": fav or 0,
        "orders": order_cnt if isinstance(order_cnt, int) else 0,
    }
    conv["rate"] = round((conv["favorites"] + conv["orders"]) / max(1, len(seen_products)), 3)

    # ⑩ 商品级 / 小类级偏好（2026-10-18 偏好分析①）：粒度从「大类占比」细化到具体商品与小类
    #    权重（本轮口径，用户认可）：浏览 ×1、停留每分钟 ×1、收藏 ×3、下单 ×4
    #    （模型名用别名取，避免和上面「转化倾向」里的局部变量撞名）
    from models import Favorite as FavModel, Order as OrderModel

    browse_cnt: dict = {}
    for pid in product_ids:
        browse_cnt[pid] = browse_cnt.get(pid, 0) + 1
    secs_by_pid: dict = {}
    for _pg, _gap in dwells:
        _k, _rid = classify_page(_pg)
        if _k == "product":
            secs_by_pid[_rid] = secs_by_pid.get(_rid, 0.0) + _gap

    fav_pids, order_by_pid = set(), {}
    try:                                  # 统计失败也不该让画像接口 500
        fav_pids = {f.product_id for f in
                    db.session.query(FavModel).filter(FavModel.user_id == target.id).all()}
        for _o in db.session.query(OrderModel).filter(OrderModel.buyer_id == target.id).all():
            order_by_pid[_o.product_id] = order_by_pid.get(_o.product_id, 0) + 1
    except Exception:                     # noqa: BLE001
        fav_pids, order_by_pid = set(), {}

    W_VIEW, W_MINUTE, W_FAV, W_ORDER = 1.0, 1.0, 3.0, 4.0
    touched = set(browse_cnt) | set(secs_by_pid) | set(fav_pids) | set(order_by_pid)
    _missing = touched - set(prods)
    if _missing:                          # 只收藏/下过单、没浏览过的商品也要算进来
        prods.update({p.id: p for p in Product.query.filter(Product.id.in_(_missing)).all()})
    subs = {s.id: s for s in Subcategory.query.all()}

    product_rows = []
    for pid in touched:
        pr = prods.get(pid)
        if pr is None:                    # 已软删除的商品不参与偏好
            continue
        views = browse_cnt.get(pid, 0)
        secs = int(secs_by_pid.get(pid, 0.0))
        favd = pid in fav_pids
        ocnt = order_by_pid.get(pid, 0)
        score = (views * W_VIEW + (secs / 60.0) * W_MINUTE
                 + (W_FAV if favd else 0.0) + ocnt * W_ORDER)
        sub = subs.get(pr.subcategory_id)
        cat = cats.get(pr.category_id)
        product_rows.append({
            "product_id": pid, "name": pr.name,
            "category": cat.name if cat else "未知",
            "subcategory": sub.name if sub else "",
            "views": views, "dwell_secs": secs, "dwell_text": duration_text(secs),
            "favorite": favd, "orders": ocnt, "score": round(score, 2),
        })
    product_rows.sort(key=lambda x: (-x["score"], x["product_id"]))

    sub_counter: dict = {}
    for pid in product_ids:               # 小类占比与「用户类型」同口径：按浏览次数计
        pr = prods.get(pid)
        if pr is None:
            continue
        sub = subs.get(pr.subcategory_id)
        cat = cats.get(pr.category_id)
        key = "%s / %s" % (cat.name if cat else "未知", sub.name if sub else "未分类")
        sub_counter[key] = sub_counter.get(key, 0) + 1

    product_pref = {
        "top": product_rows[:5],
        "count": len(product_rows),
        "sub_breakdown": _breakdown(sub_counter),
        "weight": {"view": W_VIEW, "minute": W_MINUTE, "favorite": W_FAV, "order": W_ORDER},
        "note": "偏好分 = 浏览×1 + 停留分钟×1 + 收藏×3 + 下单×4（统计口径，不改现有埋点）",
        "empty": not product_rows,
    }

    # ⑪ 商家级偏好（2026-10-18 偏好分析②）：他在看谁家的东西、是不是回头客
    from models import Follow

    seller_views, seller_secs = {}, {}          # 商品页按卖家归并（浏览次数 / 停留秒数）
    for pid in product_ids:
        pr = prods.get(pid)
        if pr is not None:
            seller_views[pr.seller_id] = seller_views.get(pr.seller_id, 0) + 1
    for _pg, _gap in dwells:
        _k, _rid = classify_page(_pg)
        if _k == "product":
            _pr = prods.get(_rid)
            if _pr is not None:
                seller_secs[_pr.seller_id] = seller_secs.get(_pr.seller_id, 0.0) + _gap

    home_views, home_secs = {}, {}              # 商家主页（/seller/<uid>）的访问与停留
    for _p in pages:
        _k, _rid = classify_page(_p.page)
        if _k == "seller":
            home_views[_rid] = home_views.get(_rid, 0) + 1
    for _pg, _gap in dwells:
        _k, _rid = classify_page(_pg)
        if _k == "seller":
            home_secs[_rid] = home_secs.get(_rid, 0.0) + _gap

    seller_fav, seller_orders = {}, {}
    for _pid in fav_pids:
        _pr = prods.get(_pid)
        if _pr is not None:
            seller_fav[_pr.seller_id] = seller_fav.get(_pr.seller_id, 0) + 1
    for _pid, _cnt in order_by_pid.items():
        _pr = prods.get(_pid)
        if _pr is not None:
            seller_orders[_pr.seller_id] = seller_orders.get(_pr.seller_id, 0) + _cnt

    follow_ids = set()
    try:
        follow_ids = {f.followee_id for f in
                      db.session.query(Follow).filter(Follow.follower_id == target.id).all()}
    except Exception:                     # noqa: BLE001
        follow_ids = set()

    seller_ids = set(seller_views) | set(home_views) | set(seller_fav) | set(seller_orders)
    sellers = ({u.id: u for u in User.query.filter(User.id.in_(seller_ids)).all()}
               if seller_ids else {})
    seller_rows = []
    for sid in seller_ids:
        u = sellers.get(sid)
        views = seller_views.get(sid, 0)
        psecs = int(seller_secs.get(sid, 0.0))
        hviews = home_views.get(sid, 0)
        hsecs = int(home_secs.get(sid, 0.0))
        fcnt = seller_fav.get(sid, 0)
        ocnt = seller_orders.get(sid, 0)
        score = (views * W_VIEW + ((psecs + hsecs) / 60.0) * W_MINUTE
                 + fcnt * W_FAV + ocnt * W_ORDER)
        seller_rows.append({
            "seller_id": sid,
            "nickname": (u.nickname or u.username) if u else "已注销用户",
            "products": views, "dwell_secs": psecs, "dwell_text": duration_text(psecs),
            "home_views": hviews, "home_dwell_secs": hsecs,
            "home_dwell_text": duration_text(hsecs),
            "favorites": fcnt, "orders": ocnt, "followed": sid in follow_ids,
            "score": round(score, 2),
        })
    seller_rows.sort(key=lambda x: (-x["score"], x["seller_id"]))

    total_seller_views = sum(seller_views.values())
    top3_views = sum(sorted(seller_views.values(), reverse=True)[:3])
    _ordered = [x for x in seller_rows if x["orders"] >= 1]
    _repeat = [x for x in _ordered if x["orders"] >= 2]
    seller_pref = {
        "top": seller_rows[:5],
        "count": len(seller_rows),
        # 集中度：浏览次数最多的 3 位卖家占他全部商品浏览的比例（越高越"认店"）
        "concentration": round(top3_views / total_seller_views, 3) if total_seller_views else 0.0,
        "repeat": {
            "sellers_with_orders": len(_ordered),
            "repeat_sellers": len(_repeat),
            "rate": round(len(_repeat) / len(_ordered), 3) if _ordered else 0.0,
        },
        "note": "卖家偏好分 = 该卖家商品页浏览×1 + （商品页+商家主页）停留分钟×1"
                " + 收藏该卖家商品×3 + 下单次数×4",
        "empty": not seller_rows,
    }

    # ⑫ 帖子分区偏好（2026-10-18 偏好分析③）：分区＝帖子 tag（安利/避雷/闲聊/求助）
    from models import PostComment, PostLike

    tag_views, tag_secs = {}, {}
    for _p in pages:
        _k, _rid = classify_page(_p.page)
        if _k == "post":
            _po = posts.get(_rid)
            if _po is not None:
                tag_views[_po.tag] = tag_views.get(_po.tag, 0) + 1
    for _pg, _gap in dwells:
        _k, _rid = classify_page(_pg)
        if _k == "post":
            _po = posts.get(_rid)
            if _po is not None:
                tag_secs[_po.tag] = tag_secs.get(_po.tag, 0.0) + _gap

    tag_likes, tag_comments = {}, {}
    _like_ids, _cmt_ids = set(), []
    try:
        _like_ids = {x.post_id for x in
                     db.session.query(PostLike).filter(PostLike.user_id == target.id).all()}
        _cmt_ids = [x.post_id for x in
                    db.session.query(PostComment)
                    .filter(PostComment.author_id == target.id).all()]
    except Exception:                     # noqa: BLE001
        pass
    _need_posts = (set(_like_ids) | set(_cmt_ids)) - set(posts)
    if _need_posts:                       # 点赞/评论过、但没浏览过的帖子也要归到分区
        posts.update({p.id: p for p in Post.query.filter(Post.id.in_(_need_posts)).all()})
    for _pid in _like_ids:
        _po = posts.get(_pid)
        if _po is not None:
            tag_likes[_po.tag] = tag_likes.get(_po.tag, 0) + 1
    for _pid in _cmt_ids:
        _po = posts.get(_pid)
        if _po is not None:
            tag_comments[_po.tag] = tag_comments.get(_po.tag, 0) + 1

    # 大众基线：全站用户按 tag 的帖子浏览次数占比（帖子总量很小，一次取完再累加）
    base_tag, base_total = {}, 0
    all_post_tags = {p.id: p.tag for p in Post.query.all()}
    if all_post_tags:
        for (_pg_only,) in (db.session.query(UserActivity.page)
                            .filter(UserActivity.kind == "page",
                                    UserActivity.page.like("/post/%")).all()):
            _m = POST_PATH.match(_pg_only or "")
            if not _m:
                continue
            _tag = all_post_tags.get(int(_m.group(1)))
            if _tag:
                base_tag[_tag] = base_tag.get(_tag, 0) + 1
                base_total += 1

    _tag_set = set(tag_views) | set(tag_likes) | set(tag_comments)
    total_tag_views = sum(tag_views.values())
    post_rows = []
    for _t in _tag_set:
        _v = tag_views.get(_t, 0)
        _secs = int(tag_secs.get(_t, 0.0))
        post_rows.append({
            "tag": _t, "views": _v, "dwell_secs": _secs, "dwell_text": duration_text(_secs),
            "likes": tag_likes.get(_t, 0), "comments": tag_comments.get(_t, 0),
            "share": round(_v / total_tag_views, 3) if total_tag_views else 0.0,
            "base_share": (round(base_tag.get(_t, 0) / base_total, 3)
                           if base_total else 0.0),
        })
    for _r in post_rows:                  # 与大众口味差多少（正数＝更偏这个分区）
        _r["diff"] = round(_r["share"] - _r["base_share"], 3)
    post_rows.sort(key=lambda x: (-x["views"], x["tag"]))

    post_pref = {
        "top": post_rows,
        "top_tag": post_rows[0]["tag"] if post_rows and total_tag_views else "",
        "total_views": total_tag_views,
        "like_total": sum(tag_likes.values()),
        "comment_total": sum(tag_comments.values()),
        "note": "分区＝帖子 tag；占比按浏览次数算，base_share 是全站该分区的浏览占比（大众口味）",
        "empty": not post_rows,
    }

    # ⑬ 图片偏好（2026-10-18 偏好分析④，用户拍板口径）：
    #    偏好强度 = 停留秒（不足 1 秒按 1）× 主动翻图 1.5（第 2 张起）× 成交回推 2（该商品被收藏/下单）；
    #    「偏好」必须相对大众——基数＝同权重聚合其他用户；再拆「头图 / 细节图」两组看他在找什么。
    from imaging import compare as _img_compare, view_weight as _img_weight
    from imaging import weighted_aggregate as _img_wagg
    from models import ImageFeature, ProductImage, ProductImageView

    _views_all = (ProductImageView.query
                  .order_by(ProductImageView.created_at.desc()).limit(3000).all())
    _v_pids = {v.product_id for v in _views_all}
    _v_pimgs = (ProductImage.query.filter(ProductImage.product_id.in_(_v_pids)).all()
                if _v_pids else [])
    _urls_by_pid: dict = {}
    for _im in sorted(_v_pimgs, key=lambda x: (x.product_id, x.id)):
        _urls_by_pid.setdefault(_im.product_id, []).append(_im.url)
    _all_paths = {u for urls in _urls_by_pid.values() for u in urls}
    _feats_by_path = ({f.path: f.to_dict() for f in
                       ImageFeature.query.filter(ImageFeature.path.in_(_all_paths)).all()}
                      if _all_paths else {})

    # 每个人的收藏/下单集合（大众基线要按各人自己的"成交回推"加权，一次批量取，避免 N+1）
    _fav_by_user, _ord_by_user = {}, {}
    try:
        for _f2 in (db.session.query(FavModel)
                    .filter(FavModel.product_id.in_(_v_pids or [-1])).all()):
            _fav_by_user.setdefault(_f2.user_id, set()).add(_f2.product_id)
        for _o2 in (db.session.query(OrderModel)
                    .filter(OrderModel.product_id.in_(_v_pids or [-1])).all()):
            _ord_by_user.setdefault(_o2.buyer_id, set()).add(_o2.product_id)
    except Exception:                     # noqa: BLE001
        _fav_by_user, _ord_by_user = {}, {}

    _mine_items, _head_items, _detail_items, _base_items = [], [], [], []
    for _v in _views_all:
        _urls = _urls_by_pid.get(_v.product_id)
        if not _urls:                     # 没图 / 图被删
            continue
        _idx = _v.image_index or 0
        _path = _urls[_idx] if 0 <= _idx < len(_urls) else _urls[0]
        _feat = _feats_by_path.get(_path)
        if not _feat:
            continue
        if _v.user_id == target.id:
            _w = _img_weight(_v.dwell_ms, _idx,
                             _v.product_id in fav_pids or _v.product_id in order_by_pid)
            _mine_items.append((_feat, _w))
            (_detail_items if _idx >= 1 else _head_items).append((_feat, _w))
        else:
            _w = _img_weight(_v.dwell_ms, _idx,
                             _v.product_id in _fav_by_user.get(_v.user_id, ())
                             or _v.product_id in _ord_by_user.get(_v.user_id, ()))
            _base_items.append((_feat, _w))

    _mine = _img_wagg(_mine_items)
    _base = _img_wagg(_base_items)
    _head = _img_wagg(_head_items)
    _detail = _img_wagg(_detail_items)
    _IMG_KEYS = ("warm", "light", "sat", "skin", "edges")
    _MIN_IMG = 5                          # 少于 5 张不下结论

    def _brief(agg: dict) -> dict:
        if agg.get("empty"):
            return {"count": 0, "weight": 0.0, "text": "", "values": {}}
        return {
            "count": agg["count"], "weight": agg["weight"], "text": agg["text"],
            "values": {k: agg[k] for k in _IMG_KEYS},
            "dominants": agg.get("dominants") or [],
        }

    _w_total = (_mine.get("weight") or 0) if not _mine.get("empty") else 0
    _w_head = (_head.get("weight") or 0) if not _head.get("empty") else 0
    image_pref = {
        "count": _mine.get("count", 0),
        "weight": _mine.get("weight", 0.0),
        "mine": _brief(_mine),
        "base": _brief(_base),
        "compare": [] if _mine.get("empty") else _img_compare(_mine, _base),
        "position": {
            "head": _brief(_head),
            "detail": _brief(_detail),
            "head_weight_share": round(_w_head / _w_total, 3) if _w_total else 0.0,
        },
        "dominants": _mine.get("dominants") or [],
        "text": _mine.get("text", ""),
        "insufficient": _mine.get("count", 0) < _MIN_IMG,
        "rule": "少于 %d 张不下结论" % _MIN_IMG,
        "note": "偏好强度＝停留秒（≥1）× 主动翻图 1.5（第 2 张起）× 成交回推 2（该商品被收藏/下单）；"
                "大众基线＝同权重聚合其他用户；色彩按像素统计，人像/繁简是算法近似",
        "empty": bool(_mine.get("empty")),
    }

    # ⑭ 品类 × 图片特征（2026-10-18 第四批）：他看不同大类时，偏好的图是不是不一样
    # ⑮ 图片风格 × 行为结果：哪一类风格的图更容易被收藏/下单（"打动他的图"）
    from imaging import style_labels as _style_labels

    _cat_of = ({p.id: p.category_id for p in
                Product.query.filter(Product.id.in_(_v_pids)).all()}
               if _v_pids else {})

    _cat_mine, _cat_base, _tag_stats = {}, {}, {}
    for _v in _views_all:
        _urls = _urls_by_pid.get(_v.product_id)
        if not _urls:
            continue
        _idx = _v.image_index or 0
        _path = _urls[_idx] if 0 <= _idx < len(_urls) else _urls[0]
        _feat = _feats_by_path.get(_path)
        if not _feat:
            continue
        _cid = _cat_of.get(_v.product_id)
        _conv_mine = _v.product_id in fav_pids or _v.product_id in order_by_pid
        if _v.user_id == target.id:
            _w = _img_weight(_v.dwell_ms, _idx, _conv_mine)
            _cat_mine.setdefault(_cid, []).append((_feat, _w))
            for _lb in _style_labels(_feat):
                _bucket = _tag_stats.setdefault(_lb, {"views": 0, "deals": 0, "dwell_ms": 0})
                _bucket["views"] += 1
                _bucket["dwell_ms"] += int(_v.dwell_ms or 0)
                if _conv_mine:
                    _bucket["deals"] += 1
        else:
            _w = _img_weight(_v.dwell_ms, _idx,
                             _v.product_id in _fav_by_user.get(_v.user_id, ())
                             or _v.product_id in _ord_by_user.get(_v.user_id, ()))
            _cat_base.setdefault(_cid, []).append((_feat, _w))

    _cat_rows = []
    for _cid, _items in _cat_mine.items():
        _agg = _img_wagg(_items)
        if _agg.get("empty"):
            continue
        _bagg = _img_wagg(_cat_base.get(_cid) or [])
        _cat_rows.append({
            "category_id": _cid,
            "category": cats[_cid].name if _cid in cats else "未知",
            "count": _agg["count"], "weight": _agg["weight"], "text": _agg["text"],
            "values": {_k: _agg[_k] for _k in _IMG_KEYS},
            "base_text": "" if _bagg.get("empty") else _bagg["text"],
            "base_values": ({} if _bagg.get("empty")
                            else {_k: _bagg[_k] for _k in _IMG_KEYS}),
            "diff": [] if _bagg.get("empty") else _img_compare(_agg, _bagg),
            "dominant": ((_agg.get("dominants") or [{}])[0].get("name") or ""),
        })
    _cat_rows.sort(key=lambda x: -x["weight"])
    cat_image_pref = {
        "rows": _cat_rows,
        "count": len(_cat_rows),
        "note": "按大类别聚合他看过的商品图（同一套三层加权）；base 是全站其他用户在同大类的基线",
        "empty": not _cat_rows,
    }

    _out_rows = []
    for _lb, _bucket in _tag_stats.items():
        _n = _bucket["views"] or 0
        _deals = _bucket["deals"] or 0
        _secs = int(_bucket["dwell_ms"] / _n / 1000) if _n else 0
        _out_rows.append({
            "label": _lb, "views": _n, "deals": _deals,
            "rate": round(_deals / _n, 3) if _n else 0.0,
            "avg_dwell_secs": _secs, "avg_dwell_text": duration_text(_secs),
            "insufficient": _n < _MIN_IMG,
        })
    # 样本够的先排（按成交率），样本不足的垫底——否则"看过 4 次成交 4 次"会压过真实结论
    _out_rows.sort(key=lambda x: (x["insufficient"], -x["rate"], -x["views"], x["label"]))
    image_outcome = {
        "rows": _out_rows,
        "best": next((x for x in _out_rows if not x["insufficient"] and x["deals"] > 0), None),
        "deal_total": sum(x["deals"] for x in _out_rows),
        "min_views": _MIN_IMG,
        "note": "成交＝该商品被本人收藏或下过单；一行一个风格标签（同一张图会落进多个维度），"
                "少于 %d 次观看不下结论" % _MIN_IMG,
        "empty": not _out_rows,
    }

    # ⑧ 图片偏好（图片级埋点）
    imgs = (ProductImageView.query.filter(ProductImageView.user_id == target.id)
            .order_by(ProductImageView.created_at.desc()).limit(500).all())
    img_total = len(imgs)
    head_views = sum(1 for x in imgs if x.image_index == 0)
    img_dwell = [x.dwell_ms for x in imgs if x.dwell_ms > 0]
    img_products = {x.product_id for x in imgs}
    img_dim = {
        "views": img_total,
        "products": len(img_products),
        "avg_images_per_product": round(img_total / len(img_products), 1) if img_products else 0,
        "head_share": round(head_views / img_total, 3) if img_total else 0,
        "avg_dwell_ms": int(sum(img_dwell) / len(img_dwell)) if img_dwell else 0,
        "style": ("偏爱头图，很少翻图" if img_total and head_views / img_total >= 0.8
                  else ("爱翻细节图" if img_total and head_views / img_total < 0.6 else "两者都有")),
    }

    # 把多维信息汇总成一句画像
    bits = [main_type]
    if price_breakdown:
        bits.append("价格带 " + price_breakdown[0]["name"])
    if depth["style"]:
        bits.append(depth["style"])
    if img_dim["views"]:
        bits.append("头图党" if img_dim["head_share"] >= 0.8 else "细节党")
    if peak_text:
        bits.append("常在线 " + peak_text)
    portrait = " · ".join(bits)
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

    # ⑨ 图像感知偏好（2026-10-18 需求②）：看过的图片 → 色彩 / 构图 / 疑似人像
    from imaging import aggregate as _img_agg
    from models import ImageFeature, ProductImage

    _paths = []
    _views = ProductImageView.query.filter_by(user_id=target.id).all()
    if product_ids:
        _pimgs = ProductImage.query.filter(ProductImage.product_id.in_(product_ids)).all()
        _by_pid = {}
        for _im in sorted(_pimgs, key=lambda x: (x.product_id, x.id)):
            _by_pid.setdefault(_im.product_id, []).append(_im.url)
        for _v in _views:
            _urls = _by_pid.get(_v.product_id) or []
            if _urls:
                _idx = _v.image_index or 0
                _paths.append(_urls[_idx] if 0 <= _idx < len(_urls) else _urls[0])
        if not _paths:                       # 没图片级埋点就退回"浏览过的商品的所有图"
            _paths = [u for urls in _by_pid.values() for u in urls]
    _feats = (ImageFeature.query.filter(ImageFeature.path.in_(set(_paths))).all()
              if _paths else [])
    image_perception = _img_agg([f.to_dict() for f in _feats])
    image_perception["note"] = "色彩按像素真实统计；人像/繁简是算法近似（无模型）"

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
        "price_breakdown": price_breakdown,
        "hours": hours,
        "peak_text": peak_text,
        "depth": depth,
        "conversion": conv,
        "images": img_dim,
        "product_pref": product_pref,
        "seller_pref": seller_pref,
        "post_pref": post_pref,
        "image_pref": image_pref,
        "cat_image_pref": cat_image_pref,
        "image_outcome": image_outcome,
        "dwell_kinds": dwell_kinds,
        "top_dwell": top_dwell,
        "image_perception": image_perception,
        "portrait": portrait,
    })

# ---------------------------------------------------------------- 浏览记录折叠（2026-10-18 需求②）
PRODUCT_PATH = re.compile(r"^/product/(\d+)$")
POST_PATH = re.compile(r"^/post/(\d+)$")
SELLER_PATH = re.compile(r"^/seller/(\d+)$")   # 2026-10-18：商家主页也要能算停留
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
    m = SELLER_PATH.match(raw)
    if m:
        return "seller", int(m.group(1))
    return "other", None


def ref_titles(rows) -> dict:
    """把浏览路径里的商品 id / 帖子 id 批量反查成名称（不新增字段，直接查现有表）。"""
    from models import Post, Product          # 避免顶层循环导入

    pids, post_ids, seller_ids = set(), set(), set()
    for r in rows:
        kind, rid = classify_page(r.page)
        if kind == "product":
            pids.add(rid)
        elif kind == "post":
            post_ids.add(rid)
        elif kind == "seller":
            seller_ids.add(rid)
    titles = {}
    if pids:
        for p in Product.query.filter(Product.id.in_(pids)).all():
            titles[("product", p.id)] = p.name
    if post_ids:
        for p in Post.query.filter(Post.id.in_(post_ids)).all():
            titles[("post", p.id)] = (p.title or p.content or "")[:60]
    if seller_ids:
        from models import User
        for u in User.query.filter(User.id.in_(seller_ids)).all():
            titles[("seller", u.id)] = (u.nickname or u.username or "")[:40]
    return titles


REF_LABEL = {"product": "商品", "post": "帖子", "seller": "商家"}


def page_display_title(a, titles: dict) -> tuple:
    """浏览记录的可读标题与分类：(标题, kind)；商品页/帖子页优先用反查到的真名。"""
    kind, rid = classify_page(a.page)
    if kind == "other":
        return (a.page_name or a.page or "—"), "other"
    found = titles.get((kind, rid))
    if found:
        return found, kind
    gone = "（已注销）" if kind == "seller" else "（已删除）"
    return "%s #%d%s" % (REF_LABEL.get(kind, "对象"), rid, gone), kind


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
