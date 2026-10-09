"""M05 比价：同一分类下在售商品的价格行情。"""
from sqlalchemy import func

from flask import Blueprint

from api.common import arg_int, fail, ok
from models import Category, Product, PRODUCT_ON_SALE

bp = Blueprint("compare", __name__, url_prefix="/api")


@bp.get("/compare")
def compare():
    """返回所选分类的在售商品价格行情：最低 / 最高 / 平均 / 件数 + 价格升序列表。"""
    category_id = arg_int("category_id")
    if not category_id:
        return fail("请选择要比较的分类")

    category = Category.query.get(category_id)
    if category is None:
        return fail("分类不存在", 404)

    base = Product.query.filter(
        Product.status == PRODUCT_ON_SALE, Product.category_id == category_id
    )
    agg = base.with_entities(
        func.count(Product.id), func.min(Product.price),
        func.max(Product.price), func.avg(Product.price),
    ).one()
    count, min_price, max_price, avg_price = agg

    items = base.order_by(Product.price.asc()).all()
    return ok(
        {
            "category": category.to_dict(),
            "count": int(count or 0),
            "min_price": float(min_price) if min_price is not None else None,
            "max_price": float(max_price) if max_price is not None else None,
            "avg_price": round(float(avg_price), 2) if avg_price is not None else None,
            # 列表已按价格升序，前端把第一条（最低价）高亮
            "list": [p.to_dict() for p in items],
        }
    )
