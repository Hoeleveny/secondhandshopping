"""商品编号（product_code）的生成与解析。

编号结构（固定 22 位，含 3 个分隔符）：

    [分类码4]-[卖家码4]-[日期码6]-[流水号5]
    LF03      -0287     -261014   -00035
     │          │         │         └── 该卖家已发布商品的第 35 件（永不改变）
     │          │         └──────────── 发布日 YYMMDD
     │          └────────────────────── 卖家脱敏序号（users.seller_seq，非真实 id）
     └───────────────────────────────── 大类字母码(categories.code) + 大类内小类序号

约定（用户拍板）：
- 后端生成，前端不感知、不接收、不提交；
- 一经生成永不改变：卖家改分类/改名/改价/上下架/软删都不重算，
  分类码以「首次发布时」为准；
- 流水号取「该卖家已有编号里的最大流水号 + 1」——**不用 COUNT(*)+1**：
  本项目的商品记录可以被彻底物理删除，用计数会在「删掉中间某件」后与
  现存的编号撞号（唯一索引拒绝 → 重试仍是同号 → 发布失败）。

生成逻辑只在本模块实现一处，发布接口与回填脚本都调它，避免两套实现分叉。
"""
from __future__ import annotations

import re
from datetime import datetime

CODE_RE = re.compile(r"^([A-Z0-9]{2})(\d{2})-(\d{4})-(\d{6})-(\d{5})$")

SEG_CATEGORY = 4
SEG_SELLER = 4
SEG_DATE = 6
SEG_SEQ = 5


# ---------------------------------------------------------------- 纯函数部分
def pad(value: int, width: int) -> str:
    return str(int(value)).zfill(width)[:width]


def build(cat_code: str, sub_seq: int | None, seller_seq: int,
          when: datetime, serial: int) -> str:
    """按四段拼出编号。cat_code 是 2 位大类字母码。"""
    sub_part = pad(sub_seq, 2) if sub_seq else "00"
    return "-".join([
        f"{cat_code}{sub_part}",
        pad(seller_seq, SEG_SELLER),
        when.strftime("%y%m%d"),
        pad(serial, SEG_SEQ),
    ])


def parse(code: str) -> dict | None:
    """解析编号，供校验与调试用；格式不对返回 None。"""
    m = CODE_RE.match(code or "")
    if not m:
        return None
    return {
        "category_code": m.group(1),
        "sub_seq": int(m.group(2)),
        "seller_seq": int(m.group(3)),
        "date": m.group(4),
        "serial": int(m.group(5)),
    }


def serial_of(code: str) -> int:
    """取编号里的流水号（用于 MAX+1 计算）；解析不了按 0 处理。"""
    parsed = parse(code)
    return parsed["serial"] if parsed else 0


# ---------------------------------------------------------------- 依赖数据库的部分
def category_code(category) -> str:
    """大类 2 位字母码；没配就回退成 id 补零 2 位并告警（提示词第 6 章约定）。"""
    if category is not None and category.code:
        return category.code
    from flask import current_app

    fallback = str(category.id if category else 0).zfill(2)[-2:]
    try:
        current_app.logger.warning(
            "分类「%s」未配置字母码，商品编号回退用 id 补零为 %s"
            "（请到管理后台「基础数据」补配）",
            getattr(category, "name", "?"), fallback,
        )
    except Exception:  # noqa: BLE001  不在应用上下文里时忽略告警
        pass
    return fallback


def ensure_seller_seq(user) -> int:
    """卖家码：首次发布商品时惰性分配，之后不变。

    注意本项目「买家 / 卖家只是视角、不是权限」，任何普通用户都能发布商品，
    所以不存在提示词里「仅卖家有值」那种人——一律按“首次发布时才分配”处理。
    """
    from extensions import db
    from models import User

    if user.seller_seq:
        return user.seller_seq
    biggest = db.session.query(db.func.max(User.seller_seq)).scalar() or 0
    user.seller_seq = int(biggest) + 1
    db.session.flush()
    return user.seller_seq


def assign_for(user, product) -> str:
    """给一件待入库的商品算出编号（不负责写库，由调用方 flush/commit）。"""
    from extensions import db
    from models import Category, Product, Subcategory

    seller_seq = ensure_seller_seq(user)
    category = Category.query.get(product.category_id) if product.category_id else None
    sub = Subcategory.query.get(product.subcategory_id) if product.subcategory_id else None
    when = product.created_at or datetime.now()

    used = [
        serial_of(code)
        for (code,) in db.session.query(Product.product_code)
        .filter(Product.seller_id == user.id, Product.product_code.isnot(None)).all()
    ]
    serial = (max(used) if used else 0) + 1

    return build(
        category_code(category),
        sub.seq_in_category if sub else None,
        seller_seq,
        when,
        serial,
    )
