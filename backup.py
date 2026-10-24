"""数据备份与恢复（导出 / 导入 JSON）。

- dump_all()：把 14 张表的全部数据导出成一个可读 JSON；
- load_all(payload)：清空后按外键依赖顺序重建，用于「恢复数据」。

注意：swap_offers 的 matched_offer_id 是自引用外键，插入时先置空、
插入完成后再回填，避免自引用导致的外键约束失败。
"""
from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, Numeric

from extensions import db
from models import (
    Block, CampusPlace, Category, Favorite, Follow, Message, MessageClear, MessageHide,
    OperationLog, Order, Post,
    PostComment, PostImage,
    PostLike, Product, ProductImage, ProductWant, Report, Review, ReviewComment, Subcategory,
    SwapOffer, User, UserActivity,
)

# 插入顺序＝外键依赖顺序（父表在前）；删除时反序
INSERT_ORDER = [
    ("users", User),
    ("categories", Category),
    ("subcategories", Subcategory),
    ("campus_places", CampusPlace),
    ("products", Product),
    ("product_images", ProductImage),
    ("orders", Order),
    ("favorites", Favorite),
    ("reviews", Review),
    ("review_comments", ReviewComment),
    ("posts", Post),
    ("post_comments", PostComment),
    ("post_likes", PostLike),
    ("reports", Report),
    ("swap_offers", SwapOffer),
    ("messages", Message),
    ("product_wants", ProductWant),
    ("post_images", PostImage),
    ("operation_logs", OperationLog),
    ("message_clears", MessageClear),
    ("message_hides", MessageHide),
    ("user_activities", UserActivity),
    ("follows", Follow),
    ("blocks", Block),
]

BACKUP_VERSION = 1


def dump_all() -> dict:
    data: dict[str, list[dict]] = {}
    for name, model in INSERT_ORDER:
        rows = []
        for obj in model.query.order_by(model.id).all():
            rows.append(_serialize(model, obj))
        data[name] = rows
    return {
        "app": "campus-market",
        "version": BACKUP_VERSION,
        "exported_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "data": data,
    }


def _serialize(model, obj) -> dict:
    row = {}
    for column in model.__table__.columns:
        value = getattr(obj, column.name)
        if isinstance(value, datetime):
            value = value.strftime("%Y-%m-%d %H:%M:%S")
        elif isinstance(value, Decimal):
            value = float(value)
        row[column.name] = value
    return row


def _deserialize(model, row: dict) -> dict:
    result = {}
    for column in model.__table__.columns:
        if column.name not in row:
            continue
        value = row[column.name]
        if value is not None and isinstance(column.type, DateTime):
            if isinstance(value, str):
                value = _parse_dt(value)
        elif value is not None and isinstance(column.type, Numeric):
            value = Decimal(str(value))
        result[column.name] = value
    return result


def _parse_dt(text: str) -> datetime | None:
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def wipe_all() -> None:
    for _name, model in reversed(INSERT_ORDER):
        db.session.query(model).delete()
    db.session.commit()


def load_all(payload: dict) -> dict:
    """用备份内容整体替换当前数据，返回各表写入行数。"""
    data = (payload or {}).get("data")
    if not isinstance(data, dict):
        raise ValueError("备份文件格式不正确：缺少 data 字段")

    wipe_all()
    stats: dict[str, int] = {}

    for name, model in INSERT_ORDER:
        rows = data.get(name) or []
        if name == "swap_offers":
            # 先置空自引用外键，插完再回填
            pending = [
                (r.get("id"), r.get("matched_offer_id"), r.get("matched_at"))
                for r in rows
            ]
            clean = []
            for row in rows:
                row = dict(row)
                row["matched_offer_id"] = None
                clean.append(row)
            _bulk_insert(model, clean)
            for offer_id, matched_id, matched_at in pending:
                if matched_id:
                    db.session.query(SwapOffer).filter(SwapOffer.id == offer_id).update(
                        {"matched_offer_id": matched_id,
                         "matched_at": _parse_dt(matched_at) if isinstance(matched_at, str)
                         else matched_at},
                        synchronize_session=False,
                    )
            db.session.commit()
        else:
            _bulk_insert(model, rows)
        stats[name] = len(rows)

    db.session.commit()
    _reset_auto_increment()
    return stats


def _bulk_insert(model, rows: list[dict]) -> None:
    if not rows:
        return
    mappings = [_deserialize(model, row) for row in rows]
    db.session.bulk_insert_mappings(model, mappings)
    db.session.commit()


def _reset_auto_increment() -> None:
    for name, _model in INSERT_ORDER:
        db.session.execute(db.text(f"ALTER TABLE {name} AUTO_INCREMENT = 1"))
    db.session.commit()
