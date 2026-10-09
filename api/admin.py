"""M10 管理后台 / M11 数据看板 / 基础数据维护 / 备份恢复。

覆盖：
- 全部商品管理（含已售、已下架、已删除）：下架、重新上架、删除；
- 举报审核：按对象区分动作（商品→下架，帖子→删帖）；
- 基础数据维护：分类 / 小类 / 校园地点增删改；
- 数据看板：4 个数字卡 + 分类占比饼图 + 价格区间柱状图（全部用 SQL 聚合）；
- 数据管理：备份 / 恢复 / 重置示例数据。
"""
import json
from datetime import datetime
from pathlib import Path

from flask import Blueprint, current_app, send_from_directory
from sqlalchemy import and_, case, func, or_

from api.common import (
    admin_required, arg_int, arg_str, current_user, fail, json_body, ok, paginate_args,
)
from config import Config
from extensions import db
from models import (
    CampusPlace, Category, Order, Post, Product, Report, Subcategory, User,
    ORDER_CANCELED, ORDER_DONE, ORDER_PENDING,
    PRODUCT_DELETED, PRODUCT_OFF_SHELF, PRODUCT_ON_SALE, PRODUCT_SOLD,
)
from backup import dump_all, load_all

bp = Blueprint("admin", __name__, url_prefix="/api/admin")


# ================================================================ 商品管理
@bp.get("/products")
@admin_required
def all_products():
    """全部商品（含已售 / 已下架）；默认不显示已删除，可显式筛 status=deleted。"""
    page, size = paginate_args(20)
    keyword = arg_str("keyword")
    category_id = arg_int("category_id")
    status = arg_str("status") or "all"

    q = Product.query
    if status == "all":
        q = q.filter(Product.status != PRODUCT_DELETED)
    else:
        q = q.filter(Product.status == status)

    if keyword:
        like = f"%{keyword}%"
        q = q.filter(or_(Product.name.like(like), Product.description.like(like)))
    if category_id:
        q = q.filter(Product.category_id == category_id)

    total = q.count()
    items = q.order_by(Product.created_at.desc()).offset((page - 1) * size).limit(size).all()
    return ok({"list": [p.to_dict() for p in items], "total": total,
               "page": page, "page_size": size})


@bp.patch("/products/<int:pid>/status")
@admin_required
def admin_change_status(pid: int):
    product = Product.query.get(pid)
    if product is None or product.status == PRODUCT_DELETED:
        return fail("商品不存在", 404)

    target = (json_body().get("status") or "").strip()
    if target not in (PRODUCT_ON_SALE, PRODUCT_OFF_SHELF):
        return fail("只能切换到「在售」或「已下架」")
    # 已售商品不可上下架：一旦卖出去，改状态会让历史订单与商品对不上
    if product.status == PRODUCT_SOLD:
        return fail("该商品已售出，不能再上下架；如需处理请直接删除")

    product.status = target
    db.session.commit()
    return ok(product.to_dict(), msg="已重新上架" if target == PRODUCT_ON_SALE else "已下架")


@bp.delete("/products/<int:pid>")
@admin_required
def admin_delete_product(pid: int):
    product = Product.query.get(pid)
    if product is None or product.status == PRODUCT_DELETED:
        return fail("商品不存在", 404)
    product.status = PRODUCT_DELETED
    db.session.commit()
    return ok(msg="商品已删除")


# ================================================================ 举报审核
@bp.get("/reports")
@admin_required
def report_list():
    page, size = paginate_args(20)
    status = arg_str("status") or "pending"
    q = Report.query
    if status != "all":
        q = q.filter(Report.status == status)
    total = q.count()
    items = q.order_by(Report.created_at.desc()).offset((page - 1) * size).limit(size).all()

    counts = {
        "pending": Report.query.filter_by(status="pending").count(),
        "handled": Report.query.filter_by(status="handled").count(),
        "dismissed": Report.query.filter_by(status="dismissed").count(),
    }
    return ok({"list": [r.to_dict() for r in items], "total": total,
               "page": page, "page_size": size, "counts": counts})


@bp.patch("/reports/<int:rid>")
@admin_required
def handle_report(rid: int):
    """action=handle → 下架商品 / 删除帖子；action=dismiss → 驳回。"""
    user = current_user()
    report = Report.query.get(rid)
    if report is None:
        return fail("举报不存在", 404)
    if report.status != "pending":
        return fail("该举报已经处理过了", 409)

    action = (json_body().get("action") or "").strip().lower()
    if action not in ("handle", "dismiss"):
        return fail("处理动作只能是 handle（处理）或 dismiss（驳回）")

    message = ""
    if action == "handle":
        if report.product_id:
            product = Product.query.get(report.product_id)
            if product and product.status != PRODUCT_DELETED:
                product.status = PRODUCT_OFF_SHELF
            message = "已下架被举报的商品"
        elif report.post_id:
            post = Post.query.get(report.post_id)
            if post and post.status == "normal":
                post.status = "deleted"
            message = "已删除被举报的帖子"
        report.status = "handled"
    else:
        report.status = "dismissed"
        message = "已驳回该举报"

    report.handled_by = user.id
    report.handled_at = datetime.now()
    db.session.commit()
    return ok(report.to_dict(), msg=message)


# ================================================================ 基础数据
# ---------------------------------------------------------------- 分类
@bp.post("/categories")
@admin_required
def create_category():
    body = json_body()
    name = (body.get("name") or "").strip()
    if not name:
        return fail("分类名不能为空")
    if Category.query.filter_by(name=name).first():
        return fail("分类名已存在")
    category = Category(name=name, icon=(body.get("icon") or "").strip()[:10],
                        sort=int(body.get("sort") or 0))
    db.session.add(category)
    db.session.commit()
    return ok(category.to_dict(with_subs=True), msg="分类已新增")


@bp.put("/categories/<int:cid>")
@admin_required
def update_category(cid: int):
    category = Category.query.get(cid)
    if category is None:
        return fail("分类不存在", 404)
    body = json_body()
    if "name" in body:
        name = (body.get("name") or "").strip()
        if not name:
            return fail("分类名不能为空")
        exists = Category.query.filter(Category.name == name, Category.id != cid).first()
        if exists:
            return fail("分类名已存在")
        category.name = name
    if "icon" in body:
        category.icon = (body.get("icon") or "").strip()[:10]
    if "sort" in body:
        category.sort = int(body.get("sort") or 0)
    db.session.commit()
    return ok(category.to_dict(with_subs=True), msg="分类已保存")


@bp.delete("/categories/<int:cid>")
@admin_required
def delete_category(cid: int):
    category = Category.query.get(cid)
    if category is None:
        return fail("分类不存在", 404)
    used = Product.query.filter(Product.category_id == cid,
                                Product.status != PRODUCT_DELETED).count()
    if used:
        return fail(f"该分类下还有 {used} 件商品，不能删除")
    Subcategory.query.filter_by(category_id=cid).delete()
    db.session.delete(category)
    db.session.commit()
    return ok(msg="分类已删除")


# ---------------------------------------------------------------- 小类
@bp.post("/subcategories")
@admin_required
def create_subcategory():
    body = json_body()
    category_id = body.get("category_id")
    name = (body.get("name") or "").strip()
    if not category_id or Category.query.get(int(category_id)) is None:
        return fail("请选择所属分类")
    if not name:
        return fail("小类名不能为空")
    exists = Subcategory.query.filter_by(category_id=int(category_id), name=name).first()
    if exists:
        return fail("该分类下已存在同名小类")
    sub = Subcategory(category_id=int(category_id), name=name[:50])
    db.session.add(sub)
    db.session.commit()
    return ok(sub.to_dict(), msg="小类已新增")


@bp.put("/subcategories/<int:sid>")
@admin_required
def update_subcategory(sid: int):
    sub = Subcategory.query.get(sid)
    if sub is None:
        return fail("小类不存在", 404)
    body = json_body()
    if "name" in body:
        name = (body.get("name") or "").strip()
        if not name:
            return fail("小类名不能为空")
        sub.name = name[:50]
    if "category_id" in body and body.get("category_id"):
        if Category.query.get(int(body["category_id"])) is None:
            return fail("所属分类不存在")
        sub.category_id = int(body["category_id"])
    db.session.commit()
    return ok(sub.to_dict(), msg="小类已保存")


@bp.delete("/subcategories/<int:sid>")
@admin_required
def delete_subcategory(sid: int):
    sub = Subcategory.query.get(sid)
    if sub is None:
        return fail("小类不存在", 404)
    used = Product.query.filter(Product.subcategory_id == sid,
                                Product.status != PRODUCT_DELETED).count()
    if used:
        return fail(f"该小类下还有 {used} 件商品，不能删除")
    db.session.delete(sub)
    db.session.commit()
    return ok(msg="小类已删除")


# ---------------------------------------------------------------- 校园地点
@bp.post("/places")
@admin_required
def create_place():
    body = json_body()
    name = (body.get("name") or "").strip()
    ptype = (body.get("type") or "其他").strip()
    if not name:
        return fail("地点名不能为空")
    if ptype not in CampusPlace.PLACE_TYPES:
        return fail("地点类型不合法")
    if CampusPlace.query.filter_by(name=name).first():
        return fail("该地点已存在")
    try:
        lng, lat = float(body.get("lng")), float(body.get("lat"))
    except (TypeError, ValueError):
        return fail("请填写合法的经纬度")
    if not (-180 <= lng <= 180) or not (-90 <= lat <= 90):
        return fail("经纬度超出合法范围")

    place = CampusPlace(name=name[:50], type=ptype, lng=lng, lat=lat,
                        sort=int(body.get("sort") or 0))
    db.session.add(place)
    db.session.commit()
    return ok(place.to_dict(), msg="校园地点已新增")


@bp.put("/places/<int:pid>")
@admin_required
def update_place(pid: int):
    place = CampusPlace.query.get(pid)
    if place is None:
        return fail("地点不存在", 404)
    body = json_body()
    if "name" in body:
        name = (body.get("name") or "").strip()
        if not name:
            return fail("地点名不能为空")
        place.name = name[:50]
    if "type" in body:
        if body.get("type") not in CampusPlace.PLACE_TYPES:
            return fail("地点类型不合法")
        place.type = body["type"]
    if "lng" in body or "lat" in body:
        try:
            lng = float(body.get("lng", place.lng))
            lat = float(body.get("lat", place.lat))
        except (TypeError, ValueError):
            return fail("请填写合法的经纬度")
        if not (-180 <= lng <= 180) or not (-90 <= lat <= 90):
            return fail("经纬度超出合法范围")
        place.lng, place.lat = lng, lat
    if "sort" in body:
        place.sort = int(body.get("sort") or 0)
    db.session.commit()
    return ok(place.to_dict(), msg="校园地点已保存")


@bp.delete("/places/<int:pid>")
@admin_required
def delete_place(pid: int):
    place = CampusPlace.query.get(pid)
    if place is None:
        return fail("地点不存在", 404)
    # products.default_place_id / orders.meet_place_id 都是 ON DELETE SET NULL
    db.session.delete(place)
    db.session.commit()
    return ok(msg="校园地点已删除")


# ================================================================ 数据看板
@bp.get("/stats")
@admin_required
def dashboard_stats():
    """全部口径都基于「未删除」的商品，保证四个数字与图表自洽。"""
    alive = Product.query.filter(Product.status != PRODUCT_DELETED)

    total = alive.count()
    on_sale = alive.filter(Product.status == PRODUCT_ON_SALE).count()
    sold = alive.filter(Product.status == PRODUCT_SOLD).count()
    off_shelf = alive.filter(Product.status == PRODUCT_OFF_SHELF).count()

    # 分类占比
    pie_rows = (
        db.session.query(Category.name, Category.icon, func.count(Product.id))
        .join(Product, Product.category_id == Category.id)
        .filter(Product.status != PRODUCT_DELETED)
        .group_by(Category.id, Category.name, Category.icon)
        .order_by(func.count(Product.id).desc())
        .all()
    )

    # 价格区间分布（复合条件必须用 and_ 包成单个表达式，case 只接受 (条件, 值) 二元组）
    bars = (
        db.session.query(
            func.sum(case((Product.price <= 20, 1), else_=0)),
            func.sum(case((and_(Product.price > 20, Product.price <= 50), 1), else_=0)),
            func.sum(case((and_(Product.price > 50, Product.price <= 100), 1), else_=0)),
            func.sum(case((and_(Product.price > 100, Product.price <= 200), 1), else_=0)),
            func.sum(case((Product.price > 200, 1), else_=0)),
        )
        .filter(Product.status != PRODUCT_DELETED)
        .one()
    )

    order_counts = {
        "total": Order.query.count(),
        ORDER_PENDING: Order.query.filter_by(status=ORDER_PENDING).count(),
        ORDER_DONE: Order.query.filter_by(status=ORDER_DONE).count(),
        ORDER_CANCELED: Order.query.filter_by(status=ORDER_CANCELED).count(),
    }

    return ok({
        "cards": {"total": total, "on_sale": on_sale, "sold": sold, "off_shelf": off_shelf},
        "category_pie": [
            {"name": name, "icon": icon, "count": int(count)} for name, icon, count in pie_rows
        ],
        "price_bars": {
            "labels": ["0-20", "20-50", "50-100", "100-200", "200+"],
            "values": [int(v or 0) for v in bars],
        },
        "orders": order_counts,
        "users": User.query.count(),
        "reports_pending": Report.query.filter_by(status="pending").count(),
        "posts": Post.query.filter_by(status="normal").count(),
    })


# ================================================================ 备份 / 恢复
@bp.post("/backup")
@admin_required
def make_backup():
    """导出全库数据为 JSON，同时在本机 backups/ 目录留一份副本。"""
    payload = dump_all()
    backup_dir = Path(current_app.config["BACKUP_DIR"])
    backup_dir.mkdir(parents=True, exist_ok=True)
    filename = f"campus-backup-{datetime.now():%Y%m%d-%H%M%S}.json"
    (backup_dir / filename).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    counts = {name: len(rows) for name, rows in payload["data"].items()}
    return ok({"filename": filename, "download_url": f"/api/admin/backup/{filename}",
               "payload": payload, "counts": counts},
              msg="备份完成")


@bp.get("/backup/<path:filename>")
@admin_required
def download_backup(filename: str):
    return send_from_directory(current_app.config["BACKUP_DIR"], filename,
                               as_attachment=True)


@bp.get("/backups")
@admin_required
def list_backups():
    backup_dir = Path(current_app.config["BACKUP_DIR"])
    backup_dir.mkdir(parents=True, exist_ok=True)
    files = sorted(backup_dir.glob("*.json"), reverse=True)
    return ok([
        {"filename": f.name, "size": f.stat().st_size,
         "created_at": datetime.fromtimestamp(f.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S")}
        for f in files
    ])


@bp.post("/restore")
@admin_required
def restore():
    """用上传的 JSON 备份整体恢复数据（会覆盖当前全部业务数据）。"""
    payload = json_body()
    if not payload:
        return fail("请提交备份文件内容")
    try:
        stats = load_all(payload)
    except Exception as exc:  # noqa: BLE001
        db.session.rollback()
        return fail(f"恢复失败：{exc}", 400)
    return ok({"restored": stats}, msg="数据已恢复")


@bp.post("/reset-demo")
@admin_required
def reset_demo():
    """重置示例数据。"""
    from seed import seed_all

    stats = seed_all(reset=True)
    return ok(stats, msg="示例数据已重置")


@bp.get("/users")
@admin_required
def user_list():
    page, size = paginate_args(20)
    total = User.query.count()
    items = (User.query.order_by(User.id).offset((page - 1) * size).limit(size).all())
    return ok({"list": [u.to_dict() for u in items], "total": total,
               "page": page, "page_size": size})
