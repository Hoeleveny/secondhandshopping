"""分类 / 小类 / 全局枚举等基础只读接口（游客可访问）。"""
from flask import Blueprint

from api.common import fail, ok
from models import CampusPlace, Category, Product, Subcategory
from config import Config

bp = Blueprint("catalog", __name__, url_prefix="/api")


@bp.get("/categories")
def list_categories():
    """分类列表；with_subs=1 时连带小类一起返回，减少前端一次请求。"""
    from api.common import arg_int

    with_subs = arg_int("with_subs", 0) == 1
    cats = Category.query.order_by(Category.sort, Category.id).all()
    return ok([c.to_dict(with_subs=with_subs) for c in cats])


@bp.get("/categories/<int:cid>/subcategories")
def list_subcategories(cid: int):
    if Category.query.get(cid) is None:
        return fail("分类不存在", 404)
    subs = Subcategory.query.filter_by(category_id=cid).order_by(Subcategory.id).all()
    return ok([s.to_dict() for s in subs])


@bp.get("/places")
def list_places():
    """校园地点库（自提点），游客可看。"""
    from api.common import arg_str

    ptype = arg_str("type")
    q = CampusPlace.query
    if ptype:
        q = q.filter(CampusPlace.type == ptype)
    places = q.order_by(CampusPlace.sort, CampusPlace.id).all()
    return ok([p.to_dict() for p in places])


@bp.get("/meta")
def meta():
    """前端需要的各种枚举与开关，一次拿全。"""
    return ok(
        {
            "conditions": Config.CONDITIONS,
            "post_tags": Config.POST_TAGS,
            "report_reasons": Config.REPORT_REASONS,
            "place_types": CampusPlace.PLACE_TYPES,
            "product_status_text": Product.STATUS_TEXT,
            "swap_match_ratio": Config.SWAP_MATCH_RATIO,
            "page_size": Config.DEFAULT_PAGE_SIZE,
            "tencent_map_key": Config.TENCENT_MAP_KEY,
            "max_images": Config.MAX_IMAGES_PER_PRODUCT,
            "max_image_size": Config.MAX_IMAGE_SIZE,
        }
    )
