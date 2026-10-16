"""常驻运行入口：给「让网站一直挂着」用的。

与 app.py 的区别：
- 关掉 debug 与热重载 —— 不会出现双进程、也不会因为改文件而自己重启；
- 开启 threaded，浏览器并发请求不互相阻塞；
- **默认监听 0.0.0.0**，同一局域网的手机/别的电脑都能访问（想只给本机用就设 APP_HOST=127.0.0.1）；
- **自己把输出写进 logs/server.log**（不依赖 cmd 的重定向），因此可以用
  pythonw.exe 无窗口运行，适合放进「启动」文件夹随登录自动拉起。

手动启动：.venv\\Scripts\\pythonw.exe service.py
停止：    stop-service.bat
"""
import os
import socket
import sys
from datetime import datetime
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

# ---- 自己接管输出：pythonw 没有控制台，必须由 Python 落盘 ----
LOG_DIR = BASE_DIR / "logs"
LOG_DIR.mkdir(exist_ok=True)
_log = open(LOG_DIR / "server.log", "a", encoding="utf-8", buffering=1)
sys.stdout = _log
sys.stderr = _log


def _say(message: str) -> None:
    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {message}", flush=True)


def lan_ip() -> str:
    """探出本机在局域网里的地址（不真的发包，只是让系统按路由规则挑一张网卡）。"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return ""
    finally:
        sock.close()


def main() -> None:
    from app import create_app  # 放在接管输出之后再导入，导入期的报错也能落盘
    from config import Config

    host, port = Config.APP_HOST, Config.APP_PORT
    app = create_app()
    _say(f"校园二手集市启动：本机 http://127.0.0.1:{port}"
         + (f"｜局域网 http://{lan_ip()}:{port}" if host == "0.0.0.0" and lan_ip() else "")
         + f"（监听 {host}:{port}，进程 {os.getpid()}）")
    if host == "0.0.0.0":
        _say("提示：局域网访问需要 Windows 防火墙放行该端口，"
             "双击项目根目录的 open-lan.bat（选「以管理员身份运行」）即可。")
    try:
        app.run(host=host, port=port, debug=False, use_reloader=False, threaded=True)
    except Exception as exc:  # noqa: BLE001
        _say(f"启动失败：{exc!r}（若是端口被占用，说明服务已经在跑了）")
        raise
    finally:
        _say("服务已退出")


if __name__ == "__main__":
    main()

