"""M07 我的收藏。"""
from flask import Blueprint

from api.common import current_user, fail, json_body, login_required, ok, paginate_args
from config import Config
from extensions import db
from models import Favorite, Product, PRODUCT_DELETED

bp = Blueprint("favorites", __name__, url_prefix="/api")


@bp.get("/favorites")
@login_required
def list_favorites():
    user = current_user()
    page, size = paginate_args(Config.DEFAULT_PAGE_SIZE)
    q = Favorite.query.filter_by(user_id=user.id)
    total = q.count()
    items = (q.order_by(Favorite.created_at.desc())
             .offset((page - 1) * size).limit(size).all())

    result = []
    for fav in items:
        product = fav.product
        if product is None:
            continue
        item = product.to_dict()
        item["favorited_at"] = fav.created_at.strftime("%Y-%m-%d %H:%M:%S")
        item["available"] = product.status != PRODUCT_DELETED
        result.append(item)
    return ok({"list": result, "total": total, "page": page, "page_size": size})


@bp.post("/favorites")
@login_required
def add_favorite():
    user = current_user()
    product_id = json_body().get("product_id")
    if not product_id:
        return fail("请指定商品")

    product = Product.query.get(int(product_id))
    if product is None or product.status == PRODUCT_DELETED:
        return fail("商品不存在", 404)

    exists = Favorite.query.filter_by(user_id=user.id, product_id=product.id).first()
    if exists:
        return ok({"favorited": True}, msg="已经在收藏里了")

    db.session.add(Favorite(user_id=user.id, product_id=product.id))
    db.session.commit()
    return ok({"favorited": True}, msg="收藏成功")


@bp.delete("/favorites/<int:pid>")
@login_required
def remove_favorite(pid: int):
    user = current_user()
    deleted = Favorite.query.filter_by(user_id=user.id, product_id=pid).delete()
    db.session.commit()
    if not deleted:
        return fail("该商品不在你的收藏里", 404)
    return ok({"favorited": False}, msg="已取消收藏")
