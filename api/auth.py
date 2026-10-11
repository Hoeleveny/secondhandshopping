"""M01 用户认证：注册、登录、当前用户、退出。

身份规则（本项目核心设计，见功能文档 3.1.1）：
- 注册只能选 buyer / seller，这个选择只是「登录后的默认视角」，不是权限；
- 普通用户登录后可用顶栏滑块在买家 ⇄ 卖家之间自由切换，同一账号既能买也能卖；
- 管理员必须选「管理员」身份 + 管理员账号密码登录，登录后不可切换到普通视角；
- 真正的权限判断在接口层（是否本人数据 / 是否管理员），前端只负责隐藏按钮。
"""
import re

from flask import Blueprint, request
from flask_jwt_extended import create_access_token

from api.common import current_user, fail, json_body, login_required, ok
from extensions import db
from models import ROLE_ADMIN, ROLE_BUYER, ROLE_SELLER, User

bp = Blueprint("auth", __name__, url_prefix="/api/auth")

USERNAME_RE = re.compile(r"^[A-Za-z0-9_\u4e00-\u9fa5]{2,20}$")
MIN_PASSWORD_LEN = 4
NORMAL_ROLES = (ROLE_BUYER, ROLE_SELLER)


def _token_for(user: User, view: str) -> str:
    return create_access_token(
        identity=str(user.id),
        additional_claims={"role": user.role, "view": view, "nickname": user.nickname},
    )


@bp.post("/register")
def register():
    body = json_body()
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    role = (body.get("role") or "").strip().lower()
    nickname = (body.get("nickname") or "").strip() or username

    if not USERNAME_RE.match(username):
        return fail("用户名需 2-20 位，只能包含中英文、数字和下划线")
    if len(password) < MIN_PASSWORD_LEN:
        return fail(f"密码长度不能少于 {MIN_PASSWORD_LEN} 位")
    if role not in NORMAL_ROLES:
        return fail("注册身份只能是「买家」或「卖家」，管理员为预置账号不可注册")
    if User.query.filter_by(username=username).first():
        return fail("该用户名已被注册")

    user = User(username=username, nickname=nickname[:50], role=role, credit=5.0)
    user.set_password(password)
    db.session.add(user)
    db.session.commit()

    return ok(
        {"token": _token_for(user, role), "user": user.to_dict(), "view": role},
        msg="注册成功",
    )


@bp.post("/login")
def login():
    body = json_body()
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    role = (body.get("role") or "").strip().lower()

    if role not in (ROLE_BUYER, ROLE_SELLER, ROLE_ADMIN):
        return fail("请先选择登录身份（买家 / 卖家 / 管理员）")
    if not username or not password:
        return fail("请输入用户名和密码")

    user = User.query.filter_by(username=username).first()
    if user is None or not user.check_password(password):
        return fail("用户名或密码错误", 401)

    if role == ROLE_ADMIN:
        if user.role != ROLE_ADMIN:
            return fail("该账号不是管理员，无法以管理员身份登录", 403)
        view = ROLE_ADMIN
    else:
        if user.role == ROLE_ADMIN:
            return fail("管理员账号请在登录页选择「管理员」身份登录", 403)
        # 普通用户：以所选视角进入（买家/卖家只是视角，不限制权限）
        view = role

    return ok(
        {"token": _token_for(user, view), "user": user.to_dict(), "view": view},
        msg="登录成功",
    )


@bp.get("/me")
@login_required
def me():
    user = current_user()
    view = (request.headers.get("X-View-Role") or "").strip().lower()
    if user.role == ROLE_ADMIN:
        view = ROLE_ADMIN
    elif view not in NORMAL_ROLES:
        view = user.role
    return ok({"user": user.to_dict(), "view": view, "is_admin": user.is_admin})


@bp.put("/profile")
@login_required
def update_profile():
    """功能⑦：修改昵称与头像。

    头像走 /api/upload 上传拿到文件名后，把文件名提交到这里；
    传 avatar="" 表示恢复成默认（首字）头像。
    """
    user = current_user()
    body = json_body()
    changed = []

    if "nickname" in body:
        nickname = (body.get("nickname") or "").strip()
        if not nickname:
            return fail("昵称不能为空")
        if len(nickname) > 20:
            return fail("昵称不能超过 20 个字符")
        if nickname != user.nickname:
            user.nickname = nickname
            changed.append("昵称")

    if "avatar" in body:
        avatar = (body.get("avatar") or "").strip()
        if len(avatar) > 255:
            return fail("头像文件名过长")
        if avatar != (user.avatar or ""):
            user.avatar = avatar or None
            changed.append("头像")

    if not changed:
        return ok(user.to_dict(), msg="资料没有变化")

    db.session.commit()
    # 昵称写进了 JWT 的 claims，改完让前端重新取一次 /me 即可生效
    return ok(user.to_dict(), msg=f"{'、'.join(changed)}已更新")


@bp.post("/logout")
def logout():
    """JWT 无状态，退出由前端清除本地凭证即可。"""
    return ok(msg="已退出登录")
