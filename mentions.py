"""评论里的 @昵称 解析（用户 2026-10-16 提出：@昵称落库成可点）。

用户点「回复」时输入框会预填 `@昵称 `，提交时用这里把它解析成
`[{"id": 被@的人, "nickname": 当时的昵称}]` 存进评论行的 `mentions` 列，
前端据此把那段文字渲染成可点的链接（点一下进 TA 的主页）。

说明：
- 只认**库里真实存在的昵称**（完全匹配），@ 不存在的名字就原样当文字，不影响发布；
- 昵称同时把当时的写法存下来（改名后链接仍然指得准，显示的字也不会凭空消失）；
- 同一个人被 @ 多次只存一条。
"""
import re

# @ 后面跟 1~20 个「非空白、非常见标点」的字符；中英文标点都算边界
_MENTION_RE = re.compile(r"@([^\s@，。！？、,.!?:：；;（）()\[\]【】\"'“”]{1,20})")


def parse_mentions(content: str | None) -> list[dict]:
    """从评论内容里解析出被 @ 到的用户（返回 [{id, nickname}]，按出现顺序去重）。"""
    from models import User  # 延迟导入，避免与 models 的循环依赖

    text = content or ""
    names = _MENTION_RE.findall(text)
    if not names:
        return []

    found: list[dict] = []
    seen: set[int] = set()
    for name in names:
        user = User.query.filter_by(nickname=name).first()
        if user is None or user.id in seen:
            continue
        seen.add(user.id)
        found.append({"id": user.id, "nickname": user.nickname})
    return found
