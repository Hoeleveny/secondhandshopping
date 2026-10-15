"""商家好评率与分级（需求③）。

口径（用户拍板）：
- 好评 = 4~5 星；
- 好评率 = 好评数 ÷ 总评价数；
- **只统计「卖家作为被评方」的评价**——本项目的评价是双向互评，
  只有「买家评卖家」那一半才算商家的信誉；
- 四档：≥95% 优秀 / 85%~95% 良好 / 70%~85% 一般 / <70% 待改进；
- 一条评价都没有时显示「暂无评价」，且不参与分级。

实时聚合、不落冗余列：避免"库里存的好评率跟评价对不上"。
"""
from __future__ import annotations

# (阈值下限, 档位码, 档位名, 一句话说明)；按阈值从高到低匹配
LEVELS = [
    (95, "excellent", "优秀", "好评率很高，可以放心交易"),
    (85, "good", "良好", "整体评价不错"),
    (70, "fair", "一般", "有过一些差评，交易前可以多沟通"),
    (0, "poor", "待改进", "差评较多，请谨慎交易"),
]

GOOD_THRESHOLD = 4  # 4~5 星算好评


def seller_rating(user_id: int) -> dict:
    """算出某位卖家作为「被评价方」的好评率与分级。

    本项目评价是双向互评，`reviews` 里同时存在「买家评卖家」和「卖家评买家」，
    光看 `reviewee_id` 分不出方向——**必须关联订单**：只有「被评人正是该订单的卖家」
    的那一条才算商家信誉；卖家给买家写的评价不计入。
    """
    from models import Order, Review

    ratings = [
        r for (r,) in
        Review.query
        .join(Order, Order.id == Review.order_id)
        .filter(Review.reviewee_id == user_id, Order.seller_id == user_id)
        .with_entities(Review.rating).all()
    ]

    total = len(ratings)
    if total == 0:
        return {
            "total": 0, "good": 0, "bad": 0, "rate": None, "avg": None,
            "level": None, "level_text": "暂无评价",
            "level_hint": "这位卖家还没有收到评价",
        }

    good = sum(1 for r in ratings if r >= GOOD_THRESHOLD)
    rate = round(good * 100 / total, 1)
    avg = round(sum(ratings) / total, 1)

    for threshold, key, text, hint in LEVELS:
        if rate >= threshold:
            return {
                "total": total, "good": good, "bad": total - good,
                "rate": rate, "avg": avg,
                "level": key, "level_text": text, "level_hint": hint,
            }
    # 理论上到不了这里（LEVELS 最后一档下限是 0）
    return {"total": total, "good": good, "bad": total - good, "rate": rate,
            "avg": avg, "level": "poor", "level_text": "待改进",
            "level_hint": LEVELS[-1][3]}
