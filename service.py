"""常驻运行入口：给「让网站一直挂着」用的。

与 app.py 的区别：
- 关掉 debug 与热重载 —— 不会出现双进程、也不会因为改文件而自己重启；
- 开启 threaded，浏览器并发请求不互相阻塞；
- **自己把输出写进 logs/server.log**（不依赖 cmd 的重定向），因此可以用
  pythonw.exe 无窗口运行，适合放进「启动」文件夹随登录自动拉起。

手动启动：.venv\\Scripts\\pythonw.exe service.py
停止：    stop-service.bat
"""
import os
import sys
from datetime import datetime
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

HOST = os.environ.get("APP_HOST", "127.0.0.1")
PORT = int(os.environ.get("APP_PORT", "5000"))

# ---- 自己接管输出：pythonw 没有控制台，必须由 Python 落盘 ----
LOG_DIR = BASE_DIR / "logs"
LOG_DIR.mkdir(exist_ok=True)
_log = open(LOG_DIR / "server.log", "a", encoding="utf-8", buffering=1)
sys.stdout = _log
sys.stderr = _log


def _say(message: str) -> None:
    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {message}", flush=True)


def main() -> None:
    from app import create_app  # 放在接管输出之后再导入，导入期的报错也能落盘

    app = create_app()
    _say(f"校园二手集市启动：http://{HOST}:{PORT}（进程 {os.getpid()}）")
    try:
        app.run(host=HOST, port=PORT, debug=False, use_reloader=False, threaded=True)
    except Exception as exc:  # noqa: BLE001
        _say(f"启动失败：{exc!r}（若是端口被占用，说明服务已经在跑了）")
        raise
    finally:
        _say("服务已退出")


if __name__ == "__main__":
    main()
