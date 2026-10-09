"""M12 以物换物。

流程（已与用户确认的"最小完整版"）：
1. 发布换物：选一件自己的在售商品 + 写标题 + 填估价；
2. 系统按估价 ±20% 列出别人的在售换物，作为可交换的候选；
3. 点「发起交换」即达成：双方两条换物互标 matched、互记 matched_offer_id，
   双方商品同时变「已售」——不需要对方二次确认。
"""
from datetime import datetime

from flask import Blueprint

from api.common import (
    arg_str, current_user, fail, json_body, login_required, ok, paginate_args,
)
from config import Config
from extensions import db
from models import Product, SwapOffer, PRODUCT_ON_SALE, PRODUCT_SOLD

bp = Blueprint("swaps", __name__, url_prefix="/api")


def _match_range(estimate: float) -> tuple[float, float]:
    ratio = Config.SWAP_MATCH_RATIO
    return round(estimate * (1 - ratio), 2), round(estimate * (1 + ratio), 2)


@bp.get("/swaps")
@login_required
def list_swaps():
    """换物广场：默认只看「进行中」的换物。"""
    user = current_user()
    page, size = paginate_args(Config.DEFAULT_PAGE_SIZE)
    status = arg_str("status") or "open"

    q = SwapOffer.query
    if status != "all":
        q = q.filter(SwapOffer.status == status)
    total = q.count()
    items = (q.order_by(SwapOffer.created_at.desc())
             .offset((page - 1) * size).limit(size).all())

    result = []
    for offer in items:
        item = offer.to_dict()
        item["is_mine"] = offer.user_id == user.id
        item["match_range"] = list(_match_range(float(offer.estimate_price)))
        result.append(item)
    return ok({"list": result, "total": total, "page": page, "page_size": size,
               "match_ratio": Config.SWAP_MATCH_RATIO})


@bp.get("/swaps/mine")
@login_required
def my_swaps():
    user = current_user()
    offers = (SwapOffer.query.filter_by(user_id=user.id)
              .order_by(SwapOffer.created_at.desc()).all())
    return ok([o.to_dict() for o in offers])


@bp.get("/swaps/<int:sid>/matches")
@login_required
def swap_matches(sid: int):
    """估价 ±20% 的相近换物（排除自己和已匹配的）。"""
    offer = SwapOffer.query.get(sid)
    if offer is None:
        return fail("换物信息不存在", 404)
    low, high = _match_range(float(offer.estimate_price))
    candidates = (
        SwapOffer.query.filter(
            SwapOffer.id != offer.id,
            SwapOffer.user_id != offer.user_id,
            SwapOffer.status == "open",
            SwapOffer.estimate_price >= low,
            SwapOffer.estimate_price <= high,
        ).order_by(SwapOffer.estimate_price).all()
    )
    return ok({
        "offer": offer.to_dict(),
        "range": [low, high],
        "matches": [c.to_dict() for c in candidates],
    })


@bp.post("/swaps")
@login_required
def create_swap():
    user = current_user()
    body = json_body()

    product_id = body.get("product_id")
    if not product_id:
        return fail("请选择要用来交换的商品")
    product = Product.query.get(int(product_id))
    if product is None or product.status != PRODUCT_ON_SALE:
        return fail("只能选择自己「在售」的商品发起换物")
    if product.seller_id != user.id:
        return fail("只能选择自己发布的商品", 403)

    title = (body.get("title") or "").strip()
    if not title:
        return fail("请填写换物标题")
    if len(title) > 100:
        return fail("换物标题不能超过 100 个字符")

    try:
        estimate = float(body.get("estimate_price"))
    except (TypeError, ValueError):
        return fail("请填写估价（数字）")
    if estimate <= 0:
        return fail("估价必须大于 0")

    exists = SwapOffer.query.filter_by(product_id=product.id, status="open").first()
    if exists:
        return fail("这件商品已经在换物列表里了", 409)

    offer = SwapOffer(user_id=user.id, product_id=product.id, title=title[:100],
                      estimate_price=round(estimate, 2), status="open")
    db.session.add(offer)
    db.session.commit()
    low, high = _match_range(estimate)
    return ok({"offer": offer.to_dict(), "range": [low, high]}, msg="换物已发布")


@bp.post("/swaps/<int:sid>/exchange")
@login_required
def exchange(sid: int):
    """发起交换：双方换物互相标记 matched，双方商品变「已售」。"""
    user = current_user()
    mine = SwapOffer.query.get(sid)
    if mine is None:
        return fail("换物信息不存在", 404)
    if mine.user_id != user.id:
        return fail("只能发起自己的换物", 403)
    if mine.status != "open":
        return fail("这条换物已经不在进行中", 409)

    target_id = json_body().get("target_offer_id")
    if not target_id:
        return fail("请选择要交换的对象")
    target = SwapOffer.query.get(int(target_id))
    if target is None:
        return fail("对方的换物不存在", 404)
    if target.id == mine.id:
        return fail("不能和自己交换")
    if target.user_id == user.id:
        return fail("不能和自己的另一条换物交换")
    if target.status != "open":
        return fail("对方的换物已经不在进行中", 409)

    low, high = _match_range(float(mine.estimate_price))
    if not (low <= float(target.estimate_price) <= high):
        return fail(f"对方估价超出你的 ±{int(Config.SWAP_MATCH_RATIO * 100)}% 匹配范围", 409)

    my_product = mine.product
    target_product = target.product
    if my_product is None or my_product.status != PRODUCT_ON_SALE:
        return fail("你的商品已不在售，无法交换", 409)
    if target_product is None or target_product.status != PRODUCT_ON_SALE:
        return fail("对方的商品已不在售，无法交换", 409)

    now = datetime.now()
    mine.status = target.status = "matched"
    mine.matched_offer_id, target.matched_offer_id = target.id, mine.id
    mine.matched_at = target.matched_at = now
    my_product.status = target_product.status = PRODUCT_SOLD
    db.session.commit()

    return ok({"mine": mine.to_dict(), "target": target.to_dict()},
              msg="交换达成，双方商品已标记为已售")


@bp.post("/swaps/<int:sid>/close")
@login_required
def close_swap(sid: int):
    user = current_user()
    offer = SwapOffer.query.get(sid)
    if offer is None:
        return fail("换物信息不存在", 404)
    if offer.user_id != user.id and not user.is_admin:
        return fail("只能关闭自己的换物", 403)
    if offer.status == "matched":
        return fail("已达成交换的换物不能关闭", 409)
    offer.status = "closed"
    db.session.commit()
    return ok(offer.to_dict(), msg="换物已关闭")
