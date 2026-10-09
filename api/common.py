"""接口层公共工具：统一响应、当前用户、角色校验、分页、地理计算。"""
import math
from datetime import datetime
from functools import wraps

from flask import jsonify, request
from flask_jwt_extended import get_jwt, get_jwt_identity, verify_jwt_in_request

from models import ROLE_ADMIN, User

# ------------------------------------------------------------------ 统一响应


def ok(data=None, msg="ok"):
    return jsonify(code=0, msg=msg, data=data)


def fail(msg, code=400):
    return jsonify(code=code, msg=msg, data=None), code


# ------------------------------------------------------------------ 当前用户


def current_user() -> User | None:
    """取当前登录用户；未登录返回 None（用于「游客可访问」的接口）。"""
    try:
        verify_jwt_in_request(optional=True)
    except Exception:  # noqa: BLE001
        return None
    uid = get_jwt_identity()
    if not uid:
        return None
    return User.query.get(int(uid))


def current_role() -> str | None:
    """当前视角：普通用户登录时前端会带 X-View-Role 头在 buyer/seller 间切换。

    注意（重要设计）：买家 / 卖家只是同一个普通账号的两个「视角」，
    二者的权限集合是相同的，真正的边界在「是不是本人数据」，
    因此这里只用于展示默认页/菜单，不做权限拦截。
    """
    user = current_user()
    if not user:
        return None
    if user.role == ROLE_ADMIN:
        return ROLE_ADMIN
    view = (request.headers.get("X-View-Role") or "").strip().lower()
    return view if view in ("buyer", "seller") else user.role


def login_required(fn):
    """要求登录（游客不可用的操作类接口）。"""

    @wraps(fn)
    def wrapper(*args, **kwargs):
        verify_jwt_in_request()
        user = current_user()
        if user is None:
            return fail("请先登录", 401)
        return fn(*args, **kwargs)

    return wrapper


def admin_required(fn):
    """仅管理员。"""

    @wraps(fn)
    def wrapper(*args, **kwargs):
        verify_jwt_in_request()
        user = current_user()
        if user is None:
            return fail("请先登录", 401)
        if user.role != ROLE_ADMIN:
            return fail("需要管理员权限", 403)
        return fn(*args, **kwargs)

    return wrapper


def claims() -> dict:
    try:
        return get_jwt()
    except Exception:  # noqa: BLE001
        return {}


# ------------------------------------------------------------------ 参数解析


def arg_int(name: str, default=None):
    raw = request.args.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default


def arg_float(name: str, default=None):
    raw = request.args.get(name)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        return default


def arg_str(name: str, default=None):
    raw = request.args.get(name)
    return default if raw is None or raw == "" else raw.strip()


def json_body() -> dict:
    return request.get_json(silent=True) or {}


def paginate_args(default_size: int) -> tuple[int, int]:
    page = arg_int("page", 1) or 1
    size = arg_int("page_size", default_size) or default_size
    page = max(1, page)
    size = max(1, min(size, 60))
    return page, size


# ------------------------------------------------------------------ 杂项


def now() -> datetime:
    return datetime.now()


def make_order_no(seq: int) -> str:
    """订单号：CM + yyyymmddHHMMSS + 6 位序号。"""
    return f"CM{datetime.now():%Y%m%d%H%M%S}{seq:06d}"


# ------------------------------------------------------------------ 地理计算
def haversine_m(lng1: float, lat1: float, lng2: float, lat2: float) -> float:
    """两点间直线距离（米）。坐标统一为 GCJ-02。"""
    radius = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = (math.sin(dphi / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2)
    return 2 * radius * math.asin(math.sqrt(a))


def midpoint(lng1: float, lat1: float, lng2: float, lat2: float) -> tuple[float, float]:
    return (lng1 + lng2) / 2, (lat1 + lat2) / 2


def nearest_place(lng: float, lat: float):
    """离给定坐标最近的校园地点（建议会面点）。"""
    from models import CampusPlace

    best, best_distance = None, None
    for place in CampusPlace.query.all():
        distance = haversine_m(lng, lat, float(place.lng), float(place.lat))
        if best_distance is None or distance < best_distance:
            best, best_distance = place, distance
    return best, best_distance
