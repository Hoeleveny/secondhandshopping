"""操作留痕：管理后台「动态监控」时间线的数据来源。

设计要点：
- 只在这里写日志，调用方一行 `audit.record(...)`，不各自拼字段；
- 日志与业务操作**同一事务**：业务提交时日志一起落库，回滚时一起消失，
  不会出现"操作成功但没留痕"的情况；
- 操作人取当前登录用户（可在批量/系统操作里用 user= 显式指定，或 user=None 表示系统）；
- summary 是给人看的一句话，超长自动截断，避免撑爆 VARCHAR(255)。
"""
from __future__ import annotations

MAX_SUMMARY = 255


def record(action: str, target_type: str = "", target_id: int | None = None,
           summary: str = "", user=None, role: str | None = None) -> None:
    """写一条操作日志（不 commit，跟着业务事务一起提交）。"""
    from extensions import db
    from models import OperationLog

    if user is None:
        try:  # 不在请求上下文（如 seed、脚本）时静默跳过
            from api.common import current_user

            user = current_user()
        except Exception:  # noqa: BLE001
            user = None

    db.session.add(OperationLog(
        user_id=getattr(user, "id", None),
        username=(getattr(user, "username", "") or "")[:50],
        role=(role or getattr(user, "role", "") or "")[:20],
        action=action[:30],
        target_type=(target_type or "")[:20],
        target_id=target_id,
        summary=(summary or "")[:MAX_SUMMARY],
    ))
