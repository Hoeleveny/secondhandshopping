"""项目命令行工具。

用法：
    .venv\\Scripts\\python.exe manage.py init-db       # 建库建表（按 sql/schema.sql，会重建表）
    .venv\\Scripts\\python.exe manage.py migrate       # 只执行增量迁移（幂等，不动已有数据）
    .venv\\Scripts\\python.exe manage.py reset-demo    # 清空业务数据并重新写入示例数据
    .venv\\Scripts\\python.exe manage.py check         # 环境自检
    .venv\\Scripts\\python.exe manage.py run           # 启动开发服务器
"""
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

USAGE = __doc__


def cmd_init_db() -> int:
    """执行 sql/schema.sql 建表（幂等：脚本内是 DROP TABLE IF EXISTS + CREATE）。"""
    import pymysql
    from pymysql.constants import CLIENT

    from config import Config

    schema_path = BASE_DIR / "sql" / "schema.sql"
    if not schema_path.exists():
        print(f"[FAIL] 找不到建表脚本：{schema_path}")
        return 1

    sql_text = schema_path.read_text(encoding="utf-8")
    conn = pymysql.connect(
        host=Config.DB_HOST, port=int(Config.DB_PORT),
        user=Config.DB_USER, password=Config.DB_PASSWORD,
        database=Config.DB_NAME, charset="utf8mb4",
        client_flag=CLIENT.MULTI_STATEMENTS, autocommit=True,
    )
    try:
        with conn.cursor() as cur:
            cur.execute(sql_text)
            while cur.nextset():
                pass
            cur.execute(
                "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=%s",
                (Config.DB_NAME,),
            )
            count = cur.fetchone()[0]
        expected = sql_text.upper().count("CREATE TABLE")
        print(f"[OK]  建表完成，{Config.DB_NAME} 内共 {count} 张表（脚本定义了 {expected} 张）")
        return 0 if count >= expected else 1
    finally:
        conn.close()


def cmd_reset_demo() -> int:
    """重置示例数据（等同管理后台的「重置示例数据」按钮）。"""
    from app import create_app
    from seed import seed_all

    application = create_app()
    with application.app_context():
        stats = seed_all(reset=True)
    print("[OK]  示例数据已重置：")
    for key, value in stats.items():
        print(f"      {key:<18} {value}")
    return 0


def cmd_migrate() -> int:
    """执行 sql/migrations/ 下的增量迁移脚本。

    迁移脚本一律写成幂等的（CREATE TABLE IF NOT EXISTS / 条件 ALTER），
    可以反复执行，只增不删，不会动到库里已有的数据。
    """
    import pymysql
    from pymysql.constants import CLIENT

    from config import Config

    migration_dir = BASE_DIR / "sql" / "migrations"
    files = sorted(migration_dir.glob("*.sql")) if migration_dir.exists() else []
    if not files:
        print("[OK]  没有需要执行的迁移脚本")
        return 0

    conn = pymysql.connect(
        host=Config.DB_HOST, port=int(Config.DB_PORT),
        user=Config.DB_USER, password=Config.DB_PASSWORD,
        database=Config.DB_NAME, charset="utf8mb4",
        client_flag=CLIENT.MULTI_STATEMENTS, autocommit=True,
    )
    try:
        for path in files:
            print(f"      执行 {path.name}")
            with conn.cursor() as cur:
                cur.execute(path.read_text(encoding="utf-8"))
                while cur.nextset():
                    pass
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=%s",
                (Config.DB_NAME,),
            )
            count = cur.fetchone()[0]
        print(f"[OK]  {len(files)} 个迁移脚本已执行，当前共 {count} 张表")
        return 0
    finally:
        conn.close()


def cmd_clean_test() -> int:
    """清掉自动化测试留下的脏数据（冒烟/验收前缀）。"""
    from tools.cleanup_test_data import main as clean_main

    return clean_main()


def cmd_check() -> int:
    from tools.check_env import main as check_main

    return check_main()


def cmd_run() -> int:
    from app import app

    print("[OK]  开发服务器启动中：http://127.0.0.1:5000   （Ctrl+C 停止）")
    app.run(host="127.0.0.1", port=5000, debug=True)
    return 0


COMMANDS = {
    "init-db": cmd_init_db,
    "migrate": cmd_migrate,
    "clean-test": cmd_clean_test,
    "reset-demo": cmd_reset_demo,
    "check": cmd_check,
    "run": cmd_run,
}


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(USAGE)
        return 0 if len(sys.argv) < 2 else 2
    return COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    sys.exit(main())
