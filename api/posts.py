"""M13 交流广场：发帖、标签筛选、点赞、评论、删帖。"""
from flask import Blueprint
from sqlalchemy import or_

from api.common import (
    arg_str, current_user, fail, json_body, login_required, ok, paginate_args,
)
from config import Config
from extensions import db
from models import Post, PostComment, PostImage, PostLike  # noqa: F401

bp = Blueprint("posts", __name__, url_prefix="/api")


# ------------------------------------------------------------------ 列表
@bp.get("/posts")
def list_posts():
    """帖子列表，游客可看；支持标签页签与关键词筛选。"""
    page, size = paginate_args(Config.DEFAULT_PAGE_SIZE)
    tag = arg_str("tag")
    keyword = arg_str("keyword")
    author_id = arg_str("author_id")

    q = Post.query.filter(Post.status == "normal")
    if tag:
        if tag not in Config.POST_TAGS:
            return fail("标签取值不合法")
        q = q.filter(Post.tag == tag)
    if keyword:
        like = f"%{keyword}%"
        q = q.filter(or_(Post.title.like(like), Post.content.like(like)))
    if author_id:
        q = q.filter(Post.author_id == int(author_id))

    total = q.count()
    items = q.order_by(Post.created_at.desc()).offset((page - 1) * size).limit(size).all()
    user = current_user()
    viewer_id = user.id if user else None

    counts = {t: Post.query.filter_by(status="normal", tag=t).count() for t in Config.POST_TAGS}
    return ok({
        "list": [p.to_dict(viewer_id) for p in items],
        "total": total, "page": page, "page_size": size,
        "tag_counts": counts,
        "tags": Config.POST_TAGS,
    })


@bp.get("/posts/<int:pid>")
def post_detail(pid: int):
    post = Post.query.get(pid)
    if post is None or post.status != "normal":
        return fail("帖子不存在或已删除", 404)
    user = current_user()
    return ok(post.to_dict(user.id if user else None, with_comments=True))


# ------------------------------------------------------------------ 发帖 / 删帖
@bp.post("/posts")
@login_required
def create_post():
    user = current_user()
    body = json_body()

    title = (body.get("title") or "").strip()
    content = (body.get("content") or "").strip()
    tag = (body.get("tag") or "").strip()

    if not title:
        return fail("请填写帖子标题")
    if len(title) > 100:
        return fail("标题不能超过 100 个字符")
    if not content:
        return fail("请填写帖子内容")
    if tag not in Config.POST_TAGS:
        return fail("请选择标签（安利 / 避雷 / 闲聊 / 求助）")

    # 功能⑥：帖子配图（前端先调用 /api/upload 拿到文件名，再随发帖提交）
    images = body.get("images") or []
    if not isinstance(images, list):
        return fail("图片参数格式不正确")
    images = [str(i).strip() for i in images if str(i).strip()]
    if len(images) > Config.MAX_IMAGES_PER_PRODUCT:
        return fail(f"一篇帖子最多配 {Config.MAX_IMAGES_PER_PRODUCT} 张图")

    post = Post(author_id=user.id, title=title, content=content[:5000], tag=tag)
    db.session.add(post)
    db.session.flush()
    for index, filename in enumerate(images):
        db.session.add(PostImage(post_id=post.id, url=filename, sort=index))
    db.session.commit()
    return ok(post.to_dict(user.id), msg="发布成功")


@bp.delete("/posts/<int:pid>")
@login_required
def delete_post(pid: int):
    user = current_user()
    post = Post.query.get(pid)
    if post is None or post.status != "normal":
        return fail("帖子不存在", 404)
    if post.author_id != user.id and not user.is_admin:
        return fail("只能删除自己的帖子", 403)

    post.status = "deleted"
    db.session.commit()
    return ok(msg="帖子已删除")


# ------------------------------------------------------------------ 点赞
@bp.post("/posts/<int:pid>/like")
@login_required
def toggle_like(pid: int):
    user = current_user()
    post = Post.query.get(pid)
    if post is None or post.status != "normal":
        return fail("帖子不存在", 404)

    existing = PostLike.query.filter_by(post_id=post.id, user_id=user.id).first()
    if existing:
        db.session.delete(existing)
        liked = False
    else:
        db.session.add(PostLike(post_id=post.id, user_id=user.id))
        liked = True
    db.session.commit()

    count = PostLike.query.filter_by(post_id=post.id).count()
    return ok({"liked": liked, "like_count": count},
              msg="已点赞" if liked else "已取消点赞")


# ------------------------------------------------------------------ 评论
@bp.get("/posts/<int:pid>/comments")
def list_comments(pid: int):
    post = Post.query.get(pid)
    if post is None or post.status != "normal":
        return fail("帖子不存在", 404)
    comments = (PostComment.query.filter_by(post_id=pid)
                .order_by(PostComment.created_at.asc()).all())
    return ok([c.to_dict() for c in comments])


@bp.post("/posts/<int:pid>/comments")
@login_required
def create_comment(pid: int):
    user = current_user()
    post = Post.query.get(pid)
    if post is None or post.status != "normal":
        return fail("帖子不存在", 404)

    content = (json_body().get("content") or "").strip()
    if not content:
        return fail("评论内容不能为空")

    comment = PostComment(post_id=post.id, author_id=user.id, content=content[:2000])
    db.session.add(comment)
    db.session.commit()
    return ok(comment.to_dict(), msg="评论成功")
