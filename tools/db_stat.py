"""数据库现状速查：打印各表行数，用于确认测试有没有留下脏数据。

用法：
    .venv\\Scripts\\python.exe tools\\db_stat.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pymysql  # noqa: E402

from config import Config  # noqa: E402

TABLES = [
    "users", "categories", "subcategories", "campus_places", "products",
    "product_images", "orders", "favorites", "reviews", "reports",
    "swap_offers", "posts", "post_comments", "post_likes", "messages",
]

NOISE_PATTERNS = [
    ("products", "name", "冒烟%"),
    ("products", "name", "验收%"),
    ("messages", "content", "冒烟测试%"),
    ("messages", "content", "自动化测试%"),
    ("posts", "title", "冒烟%"),
    ("posts", "title", "验收%"),
]


def main() -> int:
    conn = pymysql.connect(
        host=Config.DB_HOST, port=int(Config.DB_PORT), user=Config.DB_USER,
        password=Config.DB_PASSWORD, database=Config.DB_NAME, charset="utf8mb4",
    )
    try:
        with conn.cursor() as cur:
            print(f"数据库 {Config.DB_NAME} 各表行数：")
            for table in TABLES:
                try:
                    cur.execute(f"SELECT COUNT(*) FROM `{table}`")
                    print(f"  {table:<16} {cur.fetchone()[0]}")
                except Exception as exc:  # noqa: BLE001
                    print(f"  {table:<16} （{exc.__class__.__name__}）")

            print("\n测试残留检查：")
            noisy = False
            for table, column, pattern in NOISE_PATTERNS:
                cur.execute(
                    f"SELECT COUNT(*) FROM `{table}` WHERE `{column}` LIKE %s", (pattern,)
                )
                count = cur.fetchone()[0]
                if count:
                    noisy = True
                print(f"  {table}.{column} LIKE {pattern!r:<16} {count}")
            print("\n结论：" + ("存在测试残留，建议清理" if noisy else "没有发现测试残留 ✓"))
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
