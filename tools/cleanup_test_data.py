"""清掉自动化测试留在库里脏数据。

冒烟测试（tools/smoke_test.py）会反复创建带「冒烟」前缀的商品、帖子、
换物与消息；商品接口只做软删除，所以这些记录会一直堆在库里。
本模块按前缀把它们连同关联行一起物理删除，保持演示数据干净。

用法：
    .venv\\Scripts\\python.exe tools\\cleanup_test_data.py
    .venv\\Scripts\\python.exe manage.py clean-test

注意：只删「冒烟」/「验收」前缀的测试数据，不会碰任何真实业务数据。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pymysql  # noqa: E402

from config import Config  # noqa: E402

# 按外键依赖顺序删除，避免约束报错
STEPS: list[tuple[str, str]] = [
    ("临时表：收集冒烟商品",
     "CREATE TEMPORARY TABLE tmp_smoke_pid (id BIGINT UNSIGNED PRIMARY KEY) "
     "SELECT id FROM products WHERE name LIKE '冒烟%'"),
    ("举报（指向冒烟商品）",
     "DELETE FROM reports WHERE product_id IN (SELECT id FROM tmp_smoke_pid)"),
    ("以物换物（指向冒烟商品）",
     "DELETE FROM swap_offers WHERE product_id IN (SELECT id FROM tmp_smoke_pid)"),
    ("收藏（指向冒烟商品）",
     "DELETE FROM favorites WHERE product_id IN (SELECT id FROM tmp_smoke_pid)"),
    ("评价（按冒烟商品）",
     "DELETE FROM reviews WHERE product_id IN (SELECT id FROM tmp_smoke_pid)"),
    ("评价（按冒烟商品的订单）",
     "DELETE FROM reviews WHERE order_id IN "
     "(SELECT id FROM orders WHERE product_id IN (SELECT id FROM tmp_smoke_pid))"),
    ("订单（指向冒烟商品）",
     "DELETE FROM orders WHERE product_id IN (SELECT id FROM tmp_smoke_pid)"),
    ("商品图片",
     "DELETE FROM product_images WHERE product_id IN (SELECT id FROM tmp_smoke_pid)"),
    ("冒烟商品本身",
     "DELETE FROM products WHERE id IN (SELECT id FROM tmp_smoke_pid)"),
    ("冒烟帖子（评论/点赞随外键级联删除）",
     "DELETE FROM posts WHERE title LIKE '冒烟%'"),
    ("冒烟私信",
     "DELETE FROM messages WHERE content LIKE '冒烟测试%'"),
    ("冒烟测试账号",
     "DELETE FROM users WHERE username IN ('smoke_buyer','acc_buyer')"),
    ("清理临时表",
     "DROP TEMPORARY TABLE IF EXISTS tmp_smoke_pid"),
]


def cleanup(verbose: bool = True) -> dict[str, int]:
    """执行清理，返回每个步骤影响的行数。

    单步失败不会中断整体清理（FK 约束等原因），失败记 -1。
    """
    conn = pymysql.connect(
        host=Config.DB_HOST, port=int(Config.DB_PORT), user=Config.DB_USER,
        password=Config.DB_PASSWORD, database=Config.DB_NAME, charset="utf8mb4",
        autocommit=True,
    )
    result: dict[str, int] = {}
    try:
        with conn.cursor() as cur:
            for label, sql in STEPS:
                if sql.startswith("DROP TEMPORARY") or sql.startswith("CREATE TEMPORARY"):
                    try:
                        cur.execute(sql)
                        result[label] = 0
                    except Exception:  # noqa: BLE001
                        result[label] = -1
                    continue
                try:
                    cur.execute(sql)
                    result[label] = max(cur.rowcount, 0)
                    if verbose and cur.rowcount > 0:
                        print(f"      删除 {label}：{cur.rowcount} 行")
                except Exception as exc:  # noqa: BLE001
                    result[label] = -1
                    if verbose:
                        print(f"      跳过 {label}（{exc.__class__.__name__}: {exc}）")
    finally:
        conn.close()
    return result


def main() -> int:
    print("清理自动化测试残留（只删「冒烟」前缀的测试数据）…")
    result = cleanup()
    total = sum(v for v in result.values() if v > 0)
    if total:
        print(f"[OK]  共清理 {total} 行")
    else:
        print("[OK]  没有需要清理的数据")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
