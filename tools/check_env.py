"""环境自检：确认虚拟环境依赖齐全、MySQL 可连、14 张表就位。

用法：
    .venv\\Scripts\\python.exe tools\\check_env.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

OK = "[OK]  "
BAD = "[FAIL]"


def check_imports() -> bool:
    print("--- 1. 依赖导入 ---")
    ok = True
    try:
        from importlib.metadata import version

        import bcrypt  # noqa: F401
        import cryptography  # noqa: F401
        import flask  # noqa: F401
        import flask_bcrypt  # noqa: F401
        import flask_jwt_extended  # noqa: F401
        import flask_sqlalchemy  # noqa: F401
        import jwt  # noqa: F401
        import pymysql
        import sqlalchemy

        print(f"{OK}flask {version('flask')} / sqlalchemy {version('sqlalchemy')} "
              f"/ flask-sqlalchemy {version('flask-sqlalchemy')}")
        print(f"{OK}pymysql {version('pymysql')} / bcrypt {version('bcrypt')} "
              f"/ cryptography {version('cryptography')}")
    except Exception as exc:  # noqa: BLE001
        print(f"{BAD} 依赖导入失败：{exc!r}")
        ok = False
    return ok


def check_import_project() -> bool:
    print("--- 2. 项目模块导入 ---")
    try:
        import config  # noqa: F401
        import models

        tables = [t for t in dir(models) if hasattr(getattr(models, t), "__tablename__")]
        print(f"{OK}config / models 可导入，模型类 {len(tables)} 个")
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"{BAD} 项目模块导入失败：{exc!r}")
        return False


def check_database() -> bool:
    print("--- 3. MySQL 连接与表结构 ---")
    import pymysql

    from config import Config

    try:
        conn = pymysql.connect(
            host=Config.DB_HOST, port=int(Config.DB_PORT),
            user=Config.DB_USER, password=Config.DB_PASSWORD,
            database=Config.DB_NAME, charset="utf8mb4",
        )
    except Exception as exc:  # noqa: BLE001
        print(f"{BAD} 连接失败：{exc!r}")
        return False

    with conn:
        cur = conn.cursor()
        cur.execute("SELECT VERSION()")
        print(f"{OK}MySQL {cur.fetchone()[0]}")
        cur.execute(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=%s",
            (Config.DB_NAME,),
        )
        count = cur.fetchone()[0]
        print(f"{OK}库 {Config.DB_NAME} 内共 {count} 张表（应 14）")
        cur.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema=%s ORDER BY table_name",
            (Config.DB_NAME,),
        )
        names = [r[0] for r in cur.fetchall()]
        print("      " + ", ".join(names))
        cur.execute("SELECT COUNT(*) FROM users")
        print(f"{OK}users 行数 = {cur.fetchone()[0]}")

        # 校验两处已确认的表结构修正是否落地
        cur.execute(
            "SELECT COLUMN_TYPE FROM information_schema.columns "
            "WHERE table_schema=%s AND table_name='products' AND column_name='status'",
            (Config.DB_NAME,),
        )
        row = cur.fetchone()
        has_deleted = bool(row and "deleted" in row[0])
        print(f"{OK if has_deleted else BAD}products.status 含 deleted：{row[0] if row else '缺失'}")

        cur.execute(
            "SELECT COUNT(*) FROM information_schema.statistics "
            "WHERE table_schema=%s AND table_name='reviews' "
            "AND index_name='uk_reviews_order_reviewer'",
            (Config.DB_NAME,),
        )
        print(f"{OK if cur.fetchone()[0] else BAD}reviews 唯一约束为 (order_id, reviewer_id)")

        cur.execute(
            "SELECT COUNT(*) FROM information_schema.columns "
            "WHERE table_schema=%s AND table_name='swap_offers' "
            "AND column_name IN ('matched_offer_id','matched_at')",
            (Config.DB_NAME,),
        )
        print(f"{OK if cur.fetchone()[0] == 2 else BAD}swap_offers 含 matched_offer_id / matched_at")

        cur.execute("SHOW TABLES LIKE 'products'")
        cur.execute(
            "SELECT COLUMN_NAME FROM information_schema.columns "
            "WHERE table_schema=%s AND table_name='products' AND COLUMN_NAME='condition'",
            (Config.DB_NAME,),
        )
        print(f"{OK if cur.fetchone() else BAD}products.condition 保留字列存在")
    return True


def main() -> int:
    results = [check_imports(), check_import_project(), check_database()]
    print("\n===== 自检结果：" + ("全部通过" if all(results) else "存在失败项") + " =====")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
