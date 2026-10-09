"""项目配置。

所有可变项都支持环境变量覆盖，密钥不写死在代码里（要求见功能文档 9.2）。
"""
import os
from datetime import timedelta
from pathlib import Path
from urllib.parse import quote_plus

BASE_DIR = Path(__file__).resolve().parent


class Config:
    # ---------- Flask ----------
    SECRET_KEY = os.environ.get(
        "SECRET_KEY", "campus-market-dev-secret-key-change-me-in-production"
    )
    JSON_AS_ASCII = False
    TEMPLATES_AUTO_RELOAD = True

    # ---------- 数据库：MySQL 8 ----------
    DB_HOST = os.environ.get("DB_HOST", "127.0.0.1")
    DB_PORT = os.environ.get("DB_PORT", "3306")
    DB_NAME = os.environ.get("DB_NAME", "campus_market")
    DB_USER = os.environ.get("DB_USER", "campus")
    DB_PASSWORD = os.environ.get("DB_PASSWORD", "Campus@2026")

    SQLALCHEMY_DATABASE_URI = (
        f"mysql+pymysql://{DB_USER}:{quote_plus(DB_PASSWORD)}"
        f"@{DB_HOST}:{DB_PORT}/{DB_NAME}?charset=utf8mb4"
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SQLALCHEMY_ENGINE_OPTIONS = {
        "pool_pre_ping": True,   # 断线自动重连，避免长跑后 MySQL 掉连接
        "pool_recycle": 280,
        "future": True,
    }

    # ---------- JWT 登录凭证 ----------
    JWT_SECRET_KEY = os.environ.get("JWT_SECRET_KEY", SECRET_KEY)
    JWT_ACCESS_TOKEN_EXPIRES = timedelta(hours=int(os.environ.get("JWT_HOURS", "12")))
    JWT_TOKEN_LOCATION = ["headers"]

    # ---------- 图片上传 ----------
    UPLOAD_FOLDER = os.environ.get("UPLOAD_FOLDER", str(BASE_DIR / "uploads"))
    ALLOWED_IMAGE_EXT = {"jpg", "jpeg", "png", "webp"}
    MAX_IMAGE_SIZE = 2 * 1024 * 1024      # 单张 ≤ 2MB（功能文档 5.3.1）
    MAX_IMAGES_PER_PRODUCT = 6
    MAX_CONTENT_LENGTH = 20 * 1024 * 1024  # 单次请求体上限

    # ---------- 分页 ----------
    DEFAULT_PAGE_SIZE = 12                # 功能文档 6.5：每页 8 / 12 条 → 取 12
    MAX_PAGE_SIZE = 60

    # ---------- 地图（腾讯地图 JS API，GCJ-02）----------
    # 留空时前端自动降级为 canvas 自绘校园示意图，不影响功能
    TENCENT_MAP_KEY = os.environ.get("TENCENT_MAP_KEY", "")

    # ---------- 业务常量 ----------
    CONDITIONS = ["全新", "九成新", "八成新", "七成新及以下"]
    POST_TAGS = ["安利", "避雷", "闲聊", "求助"]
    REPORT_REASONS = ["虚假信息", "违禁物品", "价格欺诈", "骚扰辱骂", "其他"]
    SWAP_MATCH_RATIO = 0.20               # 以物换物估价 ±20% 匹配
    STRAIGHT_LINE_METERS_PER_DEGREE = 111_000  # 粗略换算，精确值用 Haversine

    # ---------- 备份 ----------
    BACKUP_DIR = os.environ.get("BACKUP_DIR", str(BASE_DIR / "backups"))
