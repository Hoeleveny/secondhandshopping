"""ORM 模型 —— 与 sql/schema.sql 的 14 张表一一对应。

注意：
1. 表结构以 sql/schema.sql 为准（显式 DDL 带注释，便于答辩讲解）；
   本文件负责对象映射与业务方法，两者字段必须保持一致。
2. `condition` 是 MySQL 8 的保留字，故用 quoted_name 强制加反引号。
"""
from datetime import datetime

from sqlalchemy.sql import quoted_name

from extensions import bcrypt, db

# ---------------------------------------------------------------- 1. 用户
ROLE_BUYER, ROLE_SELLER, ROLE_ADMIN = "buyer", "seller", "admin"


class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.BigInteger, primary_key=True)
    username = db.Column(db.String(50), nullable=False, unique=True)
    nickname = db.Column(db.String(50), nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(
        db.Enum("buyer", "seller", "admin", name="role_enum"),
        nullable=False, default=ROLE_BUYER,
    )
    credit = db.Column(db.Numeric(3, 1), nullable=False, default=5.0)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.now)

    # ---- 业务方法 ----
    def set_password(self, raw: str) -> None:
        self.password_hash = bcrypt.generate_password_hash(raw).decode("utf-8")

    def check_password(self, raw: str) -> bool:
        return bcrypt.check_password_hash(self.password_hash, raw)

    @property
    def is_admin(self) -> bool:
        return self.role == ROLE_ADMIN

    def to_dict(self, with_credit: bool = True) -> dict:
        data = {
            "id": self.id,
            "username": self.username,
            "nickname": self.nickname,
            "role": self.role,
        }
        if with_credit:
            data["credit"] = float(self.credit or 0)
            data["created_at"] = _dt(self.created_at)
        return data


# ---------------------------------------------------------------- 2. 分类
class Category(db.Model):
    __tablename__ = "categories"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(50), nullable=False, unique=True)
    icon = db.Column(db.String(10), nullable=False, default="")
    sort = db.Column(db.Integer, nullable=False, default=0)

    subcategories = db.relationship(
        "Subcategory", backref="category", lazy="select",
        cascade="all, delete-orphan", order_by="Subcategory.id",
    )

    def to_dict(self, with_subs: bool = False) -> dict:
        data = {"id": self.id, "name": self.name, "icon": self.icon, "sort": self.sort}
        if with_subs:
            data["subcategories"] = [s.to_dict() for s in self.subcategories]
        return data


# ---------------------------------------------------------------- 3. 小类
class Subcategory(db.Model):
    __tablename__ = "subcategories"

    id = db.Column(db.Integer, primary_key=True)
    category_id = db.Column(db.Integer, db.ForeignKey("categories.id"), nullable=False)
    name = db.Column(db.String(50), nullable=False)

    __table_args__ = (db.UniqueConstraint("category_id", "name", name="uk_subcategories_category_name"),)

    def to_dict(self) -> dict:
        return {"id": self.id, "category_id": self.category_id, "name": self.name}


# ---------------------------------------------------------------- 14. 校园地点
class CampusPlace(db.Model):
    __tablename__ = "campus_places"

    PLACE_TYPES = ["教学楼", "图书馆", "食堂", "宿舍", "运动场", "其他"]

    id = db.Column(db.BigInteger, primary_key=True)
    name = db.Column(db.String(50), nullable=False, unique=True)
    type = db.Column(
        db.Enum(*PLACE_TYPES, name="place_type_enum"), nullable=False, default="其他"
    )
    lng = db.Column(db.Numeric(10, 7), nullable=False)
    lat = db.Column(db.Numeric(10, 7), nullable=False)
    sort = db.Column(db.Integer, nullable=False, default=0)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "type": self.type,
            "lng": float(self.lng),
            "lat": float(self.lat),
            "sort": self.sort,
        }


# ---------------------------------------------------------------- 4. 商品
PRODUCT_ON_SALE, PRODUCT_SOLD, PRODUCT_OFF_SHELF, PRODUCT_DELETED = (
    "on_sale", "sold", "off_shelf", "deleted"
)


class Product(db.Model):
    __tablename__ = "products"

    id = db.Column(db.BigInteger, primary_key=True)
    seller_id = db.Column(db.BigInteger, db.ForeignKey("users.id"), nullable=False)
    category_id = db.Column(db.Integer, db.ForeignKey("categories.id"), nullable=False)
    subcategory_id = db.Column(db.Integer, db.ForeignKey("subcategories.id"))
    name = db.Column(db.String(100), nullable=False)
    price = db.Column(db.Numeric(10, 2), nullable=False)
    # condition 为 MySQL 保留字，强制加反引号
    condition = db.Column(quoted_name("condition", True), db.String(20), nullable=False)
    description = db.Column(db.Text)
    status = db.Column(
        db.Enum("on_sale", "sold", "off_shelf", "deleted", name="product_status_enum"),
        nullable=False, default=PRODUCT_ON_SALE,
    )
    views = db.Column(db.Integer, nullable=False, default=0)
    default_place_id = db.Column(db.BigInteger, db.ForeignKey("campus_places.id"))
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.now)
    updated_at = db.Column(
        db.DateTime, nullable=False, default=datetime.now, onupdate=datetime.now
    )

    seller = db.relationship("User", foreign_keys=[seller_id])
    category = db.relationship("Category")
    subcategory = db.relationship("Subcategory")
    default_place = db.relationship("CampusPlace")
    images = db.relationship(
        "ProductImage", backref="product", lazy="select",
        cascade="all, delete-orphan", order_by="ProductImage.sort, ProductImage.id",
    )
    # 功能③：想要这件商品的人
    wants = db.relationship(
        "ProductWant", backref="product", lazy="select", cascade="all, delete-orphan",
    )

    STATUS_TEXT = {
        "on_sale": "在售",
        "sold": "已售",
        "off_shelf": "已下架",
        "deleted": "已删除",
    }

    def to_dict(self, detail: bool = False, viewer_id: int | None = None) -> dict:
        data = {
            "id": self.id,
            "name": self.name,
            "price": float(self.price),
            "condition": self.condition,
            "status": self.status,
            "status_text": self.STATUS_TEXT.get(self.status, self.status),
            "category_id": self.category_id,
            "category_name": self.category.name if self.category else None,
            "category_icon": self.category.icon if self.category else "",
            "subcategory_id": self.subcategory_id,
            "subcategory_name": self.subcategory.name if self.subcategory else None,
            "cover": self.images[0].url if self.images else None,
            "images": [img.url for img in self.images],
            "seller_id": self.seller_id,
            "seller_nickname": self.seller.nickname if self.seller else None,
            "views": self.views,
            "want_count": len(self.wants),
            "wanted": bool(viewer_id and any(w.user_id == viewer_id for w in self.wants)),
            "created_at": _dt(self.created_at),
        }
        if detail:
            data.update(
                {
                    "description": self.description or "",
                    "default_place_id": self.default_place_id,
                    "default_place": self.default_place.to_dict() if self.default_place else None,
                    "updated_at": _dt(self.updated_at),
                }
            )
        return data


# ---------------------------------------------------------------- 5. 商品图片
class ProductImage(db.Model):
    __tablename__ = "product_images"

    id = db.Column(db.BigInteger, primary_key=True)
    product_id = db.Column(db.BigInteger, db.ForeignKey("products.id"), nullable=False)
    url = db.Column(db.String(255), nullable=False)
    sort = db.Column(db.Integer, nullable=False, default=0)

    def to_dict(self) -> dict:
        return {"id": self.id, "url": self.url, "sort": self.sort}


# ---------------------------------------------------------------- 5b. 我想要（功能③）
class ProductWant(db.Model):
    """谁对哪件商品点过「我想要」；一个用户对同一件商品只会有一条记录。"""

    __tablename__ = "product_wants"

    id = db.Column(db.BigInteger, primary_key=True)
    user_id = db.Column(db.BigInteger, db.ForeignKey("users.id"), nullable=False)
    product_id = db.Column(db.BigInteger, db.ForeignKey("products.id"), nullable=False)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.now)

    user = db.relationship("User")

    __table_args__ = (
        db.UniqueConstraint("user_id", "product_id", name="uk_product_wants_user_product"),
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "user_id": self.user_id,
            "user_nickname": self.user.nickname if self.user else None,
            "product_id": self.product_id,
            "created_at": _dt(self.created_at),
        }


# ---------------------------------------------------------------- 6. 订单
ORDER_PENDING, ORDER_DONE, ORDER_CANCELED = "pending", "done", "canceled"


class Order(db.Model):
    __tablename__ = "orders"

    id = db.Column(db.BigInteger, primary_key=True)
    order_no = db.Column(db.String(32), nullable=False, unique=True)
    product_id = db.Column(db.BigInteger, db.ForeignKey("products.id"), nullable=False)
    buyer_id = db.Column(db.BigInteger, db.ForeignKey("users.id"), nullable=False)
    seller_id = db.Column(db.BigInteger, db.ForeignKey("users.id"), nullable=False)
    price = db.Column(db.Numeric(10, 2), nullable=False)
    product_snapshot = db.Column(db.JSON, nullable=False)
    status = db.Column(
        db.Enum("pending", "done", "canceled", name="order_status_enum"),
        nullable=False, default=ORDER_PENDING,
    )
    trade_note = db.Column(db.String(255))
    meet_place_id = db.Column(db.BigInteger, db.ForeignKey("campus_places.id"))
    buyer_lng = db.Column(db.Numeric(10, 7))
    buyer_lat = db.Column(db.Numeric(10, 7))
    seller_lng = db.Column(db.Numeric(10, 7))
    seller_lat = db.Column(db.Numeric(10, 7))
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.now)
    finished_at = db.Column(db.DateTime)
    # 功能④：买家是否已删除这条订单记录（仅买家侧隐藏，卖家与统计不受影响）
    buyer_deleted = db.Column(db.Boolean, nullable=False, default=False)

    product = db.relationship("Product")
    buyer = db.relationship("User", foreign_keys=[buyer_id])
    seller = db.relationship("User", foreign_keys=[seller_id])
    meet_place = db.relationship("CampusPlace")

    STATUS_TEXT = {"pending": "待完成", "done": "已完成", "canceled": "已取消"}

    def to_dict(self, viewer_id: int | None = None) -> dict:
        """viewer_id 用于隐私控制：仅「待完成」订单的买卖双方能看到精确位置。"""
        snap = self.product_snapshot or {}
        data = {
            "id": self.id,
            "order_no": self.order_no,
            "product_id": self.product_id,
            "product": snap,
            "price": float(self.price),
            "status": self.status,
            "status_text": self.STATUS_TEXT.get(self.status, self.status),
            "trade_note": self.trade_note or "",
            "buyer_id": self.buyer_id,
            "buyer_nickname": self.buyer.nickname if self.buyer else None,
            "seller_id": self.seller_id,
            "seller_nickname": self.seller.nickname if self.seller else None,
            "meet_place": self.meet_place.to_dict() if self.meet_place else None,
            "created_at": _dt(self.created_at),
            "finished_at": _dt(self.finished_at),
        }
        can_see_location = (
            self.status == ORDER_PENDING
            and viewer_id in (self.buyer_id, self.seller_id)
        )
        data["can_see_location"] = can_see_location
        if can_see_location:
            data["buyer_location"] = _loc(self.buyer_lng, self.buyer_lat)
            data["seller_location"] = _loc(self.seller_lng, self.seller_lat)
        else:
            data["buyer_location"] = None
            data["seller_location"] = None
        return data


# ---------------------------------------------------------------- 7. 收藏
class Favorite(db.Model):
    __tablename__ = "favorites"

    id = db.Column(db.BigInteger, primary_key=True)
    user_id = db.Column(db.BigInteger, db.ForeignKey("users.id"), nullable=False)
    product_id = db.Column(db.BigInteger, db.ForeignKey("products.id"), nullable=False)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.now)

    product = db.relationship("Product")

    __table_args__ = (db.UniqueConstraint("user_id", "product_id", name="uk_favorites_user_product"),)


# ---------------------------------------------------------------- 8. 评价
class Review(db.Model):
    __tablename__ = "reviews"

    id = db.Column(db.BigInteger, primary_key=True)
    order_id = db.Column(db.BigInteger, db.ForeignKey("orders.id"), nullable=False)
    product_id = db.Column(db.BigInteger, db.ForeignKey("products.id"), nullable=False)
    reviewer_id = db.Column(db.BigInteger, db.ForeignKey("users.id"), nullable=False)
    reviewee_id = db.Column(db.BigInteger, db.ForeignKey("users.id"), nullable=False)
    rating = db.Column(db.SmallInteger, nullable=False)
    content = db.Column(db.Text)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.now)

    reviewer = db.relationship("User", foreign_keys=[reviewer_id])
    reviewee = db.relationship("User", foreign_keys=[reviewee_id])
    order = db.relationship("Order")

    __table_args__ = (
        db.UniqueConstraint("order_id", "reviewer_id", name="uk_reviews_order_reviewer"),
    )

    def to_dict(self, viewer_id: int | None = None) -> dict:
        direction = "买家评卖家"
        if self.order and viewer_id is not None:
            direction = "我发出的评价" if self.reviewer_id == viewer_id else "我收到的评价"
        return {
            "id": self.id,
            "order_id": self.order_id,
            "product_id": self.product_id,
            "reviewer_id": self.reviewer_id,
            "reviewer_nickname": self.reviewer.nickname if self.reviewer else None,
            "reviewee_id": self.reviewee_id,
            "reviewee_nickname": self.reviewee.nickname if self.reviewee else None,
            "rating": self.rating,
            "content": self.content or "",
            "direction": direction,
            "created_at": _dt(self.created_at),
        }


# ---------------------------------------------------------------- 9. 举报
REPORT_PENDING, REPORT_HANDLED, REPORT_DISMISSED = "pending", "handled", "dismissed"


class Report(db.Model):
    __tablename__ = "reports"

    id = db.Column(db.BigInteger, primary_key=True)
    product_id = db.Column(db.BigInteger, db.ForeignKey("products.id"))
    post_id = db.Column(db.BigInteger, db.ForeignKey("posts.id"))
    reporter_id = db.Column(db.BigInteger, db.ForeignKey("users.id"), nullable=False)
    reason = db.Column(db.String(200), nullable=False)
    status = db.Column(
        db.Enum("pending", "handled", "dismissed", name="report_status_enum"),
        nullable=False, default=REPORT_PENDING,
    )
    handled_by = db.Column(db.BigInteger, db.ForeignKey("users.id"))
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.now)
    handled_at = db.Column(db.DateTime)

    reporter = db.relationship("User", foreign_keys=[reporter_id])
    handler = db.relationship("User", foreign_keys=[handled_by])
    product = db.relationship("Product")
    post = db.relationship("Post")

    STATUS_TEXT = {"pending": "待处理", "handled": "已处理", "dismissed": "驳回"}

    @property
    def target_type(self) -> str:
        return "product" if self.product_id else "post"

    def to_dict(self) -> dict:
        target = None
        if self.product_id and self.product:
            target = {"type": "product", "id": self.product_id, "title": self.product.name}
        elif self.post_id and self.post:
            target = {"type": "post", "id": self.post_id, "title": self.post.title}
        return {
            "id": self.id,
            "target": target,
            "target_type": self.target_type,
            "reporter_id": self.reporter_id,
            "reporter_nickname": self.reporter.nickname if self.reporter else None,
            "reason": self.reason,
            "status": self.status,
            "status_text": self.STATUS_TEXT.get(self.status, self.status),
            "handled_by": self.handled_by,
            "handled_at": _dt(self.handled_at),
            "created_at": _dt(self.created_at),
        }


# ---------------------------------------------------------------- 10. 以物换物
class SwapOffer(db.Model):
    __tablename__ = "swap_offers"

    id = db.Column(db.BigInteger, primary_key=True)
    user_id = db.Column(db.BigInteger, db.ForeignKey("users.id"), nullable=False)
    product_id = db.Column(db.BigInteger, db.ForeignKey("products.id"), nullable=False)
    title = db.Column(db.String(100), nullable=False)
    estimate_price = db.Column(db.Numeric(10, 2), nullable=False)
    status = db.Column(
        db.Enum("open", "matched", "closed", name="swap_status_enum"),
        nullable=False, default="open",
    )
    matched_offer_id = db.Column(db.BigInteger, db.ForeignKey("swap_offers.id"))
    matched_at = db.Column(db.DateTime)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.now)

    user = db.relationship("User")
    product = db.relationship("Product")
    matched_offer = db.relationship("SwapOffer", remote_side=[id])

    STATUS_TEXT = {"open": "进行中", "matched": "已匹配", "closed": "已关闭"}

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "user_id": self.user_id,
            "user_nickname": self.user.nickname if self.user else None,
            "product_id": self.product_id,
            "product": self.product.to_dict() if self.product else None,
            "title": self.title,
            "estimate_price": float(self.estimate_price),
            "status": self.status,
            "status_text": self.STATUS_TEXT.get(self.status, self.status),
            "matched_offer_id": self.matched_offer_id,
            "matched_at": _dt(self.matched_at),
            "created_at": _dt(self.created_at),
        }


# ---------------------------------------------------------------- 11. 帖子
class Post(db.Model):
    __tablename__ = "posts"

    id = db.Column(db.BigInteger, primary_key=True)
    author_id = db.Column(db.BigInteger, db.ForeignKey("users.id"), nullable=False)
    title = db.Column(db.String(100), nullable=False)
    content = db.Column(db.Text, nullable=False)
    tag = db.Column(db.Enum("安利", "避雷", "闲聊", "求助", name="post_tag_enum"),
                    nullable=False, default="闲聊")
    status = db.Column(db.Enum("normal", "deleted", name="post_status_enum"),
                       nullable=False, default="normal")
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.now)

    author = db.relationship("User")
    comments = db.relationship("PostComment", backref="post", lazy="select",
                               cascade="all, delete-orphan", order_by="PostComment.id")
    likes = db.relationship("PostLike", backref="post", lazy="select",
                            cascade="all, delete-orphan")
    # 功能⑥：帖子配图
    images = db.relationship("PostImage", backref="post", lazy="select",
                             cascade="all, delete-orphan",
                             order_by="PostImage.sort, PostImage.id")

    def to_dict(self, viewer_id: int | None = None, with_comments: bool = False) -> dict:
        data = {
            "id": self.id,
            "author_id": self.author_id,
            "author_nickname": self.author.nickname if self.author else None,
            "title": self.title,
            "content": self.content,
            "tag": self.tag,
            "status": self.status,
            "like_count": len(self.likes),
            "comment_count": len(self.comments),
            "images": [img.url for img in self.images],
            "liked": bool(viewer_id and any(lk.user_id == viewer_id for lk in self.likes)),
            "created_at": _dt(self.created_at),
        }
        if with_comments:
            data["comments"] = [c.to_dict() for c in self.comments]
        return data


# ---------------------------------------------------------------- 12. 帖子评论
class PostComment(db.Model):
    __tablename__ = "post_comments"

    id = db.Column(db.BigInteger, primary_key=True)
    post_id = db.Column(db.BigInteger, db.ForeignKey("posts.id"), nullable=False)
    author_id = db.Column(db.BigInteger, db.ForeignKey("users.id"), nullable=False)
    content = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.now)

    author = db.relationship("User")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "post_id": self.post_id,
            "author_id": self.author_id,
            "author_nickname": self.author.nickname if self.author else None,
            "content": self.content,
            "created_at": _dt(self.created_at),
        }


# ---------------------------------------------------------------- 13. 帖子点赞
class PostLike(db.Model):
    __tablename__ = "post_likes"

    id = db.Column(db.BigInteger, primary_key=True)
    post_id = db.Column(db.BigInteger, db.ForeignKey("posts.id"), nullable=False)
    user_id = db.Column(db.BigInteger, db.ForeignKey("users.id"), nullable=False)

    __table_args__ = (db.UniqueConstraint("post_id", "user_id", name="uk_post_likes_post_user"),)


# ---------------------------------------------------------------- 14. 帖子配图（功能⑥）
class PostImage(db.Model):
    __tablename__ = "post_images"

    id = db.Column(db.BigInteger, primary_key=True)
    post_id = db.Column(db.BigInteger, db.ForeignKey("posts.id"), nullable=False)
    url = db.Column(db.String(255), nullable=False)
    sort = db.Column(db.Integer, nullable=False, default=0)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.now)

    def to_dict(self) -> dict:
        return {"id": self.id, "url": self.url, "sort": self.sort}


# ---------------------------------------------------------------- 15. 私信消息（功能①）
class Message(db.Model):
    __tablename__ = "messages"

    MAX_LENGTH = 1000

    id = db.Column(db.BigInteger, primary_key=True)
    sender_id = db.Column(db.BigInteger, db.ForeignKey("users.id"), nullable=False)
    receiver_id = db.Column(db.BigInteger, db.ForeignKey("users.id"), nullable=False)
    product_id = db.Column(db.BigInteger, db.ForeignKey("products.id"))
    content = db.Column(db.String(MAX_LENGTH), nullable=False)
    is_read = db.Column(db.Boolean, nullable=False, default=False)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.now)

    sender = db.relationship("User", foreign_keys=[sender_id])
    receiver = db.relationship("User", foreign_keys=[receiver_id])
    product = db.relationship("Product")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "sender_id": self.sender_id,
            "sender_nickname": self.sender.nickname if self.sender else None,
            "receiver_id": self.receiver_id,
            "receiver_nickname": self.receiver.nickname if self.receiver else None,
            "product_id": self.product_id,
            "product_name": self.product.name if self.product else None,
            "content": self.content,
            "is_read": bool(self.is_read),
            "created_at": _dt(self.created_at),
        }


# ---------------------------------------------------------------- 工具函数
def _dt(value: datetime | None) -> str | None:
    return value.strftime("%Y-%m-%d %H:%M:%S") if value else None


def _loc(lng, lat) -> dict | None:
    if lng is None or lat is None:
        return None
    return {"lng": float(lng), "lat": float(lat)}
