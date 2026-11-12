"""商品共视相似度（2026-10-18 第四批，参考 Amazon item-to-item 协同过滤）。

口径（用户拍板）：
- 同一用户在 **30 分钟内**先后浏览的两件商品算「一次共视」；同一会话里同一对商品只计一次；
- 相似度用论文的**余弦归一**：`sim(a,b) = co(a,b) / sqrt(view(a) * view(b))`，
  其中 `view(x)` = 有该商品浏览记录的**会话数**（同会话看多次只算一次）。
  这样能压掉"什么都看的人"和"热门商品"的双重偏置——纯共视次数会让最热的那件出现在每个商品的推荐里。

这两件事都是纯函数，冒烟里可以直接构造序列验证数值，不需要连库。
"""
from __future__ import annotations

import re
from collections import defaultdict
from datetime import timedelta

SESSION_GAP = timedelta(minutes=30)          # 同一用户的相邻浏览超过 30 分钟就算新会话
PRODUCT_PATH = re.compile(r"^/product/(\d+)$")


def parse_page(page: str):
    """`/product/12` → 12；其它页面（/seller/4、/post/3）返回 None。"""
    m = PRODUCT_PATH.match(page or "")
    return int(m.group(1)) if m else None


def build_stats(rows):
    """rows = [(user_id, product_id, created_at), ...]（顺序任意）。

    返回 `(co, pop)`：
    - `co[(a, b)]`（a < b）：共视次数；
    - `pop[x]`：看过 x 的会话数。
    """
    by_user = defaultdict(list)
    for uid, pid, at in rows:
        if uid is None or pid is None or at is None:
            continue
        by_user[uid].append((at, pid))

    co: dict = defaultdict(int)
    pop: dict = defaultdict(int)

    def flush(seq):
        if not seq:
            return
        seen = []
        for pid in seq:                       # 同会话内同一商品只算一次
            if pid not in seen:
                seen.append(pid)
        for pid in seen:
            pop[pid] += 1
        for i, a in enumerate(seen):
            for b in seen[i + 1:]:
                key = (a, b) if a < b else (b, a)
                co[key] += 1

    for items in by_user.values():
        items.sort()
        session: list = []
        last_at = None
        for at, pid in items:
            if last_at is not None and (at - last_at) > SESSION_GAP:
                flush(session)
                session = []
            session.append(pid)
            last_at = at
        flush(session)
    return co, pop


def similarity(pid: int, co, pop, limit: int = 6) -> list:
    """对某商品算相似商品：返回 `[(other_id, score, co_count), ...]`，按 score 降序。"""
    scores: dict = {}
    for (a, b), n in co.items():
        if a == pid:
            other = b
        elif b == pid:
            other = a
        else:
            continue
        denom = (float(pop.get(a, 0)) * float(pop.get(b, 0))) ** 0.5
        if denom <= 0:
            continue
        scores[other] = (n / denom, n)
    ranked = sorted(scores.items(), key=lambda kv: (-kv[1][0], -kv[1][1], kv[0]))
    return [(other, round(score, 4), cnt) for other, (score, cnt) in ranked[:limit]]
