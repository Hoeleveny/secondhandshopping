"""局域网可访问性自检（可反复运行）。

用法： .venv\\Scripts\\python.exe tools\\lan_check.py

检查四件事：
  ① 配置里的监听地址是不是允许局域网访问（0.0.0.0 / 具体网卡 IP，而不是 127.0.0.1）
  ② 实际监听的套接字是不是只绑在回环地址上（解析 netstat）
  ③ 用本机局域网 IP 能不能真的连上 /api/health
  ④ Windows 防火墙有没有放行该端口的入站规则（没有就提示跑 open-lan.bat）
另外顺带扫一遍前端源码里有没有写死 127.0.0.1/localhost（那会让手机打开后接口全挂）。
"""
from __future__ import annotations

import re
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from config import Config  # noqa: E402

results: list[tuple[bool, str, str]] = []


def check(ok: bool, title: str, evidence: str = "") -> None:
    results.append((bool(ok), title, evidence))


def lan_ip() -> str:
    """探本机局域网 IP（不真的发包，只让系统按路由挑网卡）。"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return ""
    finally:
        sock.close()


def netstat_listeners(port: int) -> list[str]:
    """返回该端口上处于 LISTENING 的本地地址串。"""
    try:
        out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True,
                             timeout=20, encoding="utf-8", errors="ignore").stdout
    except Exception:  # noqa: BLE001
        return []
    found = []
    pattern = re.compile(rf"^\s*TCP\s+(\S+):{port}\s+\S+\s+LISTENING", re.MULTILINE)
    for match in pattern.finditer(out or ""):
        found.append(match.group(1))
    return found


def firewall_allows(port: int) -> tuple[bool, str]:
    """看看防火墙里有没有放行该端口的入站规则。"""
    try:
        out = subprocess.run(["netsh", "advfirewall", "firewall", "show", "rule", "name=all"],
                             capture_output=True, text=True, timeout=40,
                             encoding="utf-8", errors="ignore").stdout or ""
    except Exception as exc:  # noqa: BLE001
        return False, f"读取防火墙规则失败：{exc!r}"
    for block in re.split(r"\r?\n\s*\r?\n", out):
        if str(port) not in block:
            continue
        allow = ("允许" in block) or ("Allow" in block)
        inbound = ("入" in block) or ("In" in block)
        if allow and inbound:
            name = next((line.split(":", 1)[-1].strip() for line in block.splitlines()
                         if "规则名称" in line or "Rule Name" in line), "?")
            return True, f"规则「{name}」已放行 {port}"
    return False, f"没有找到放行 {port} 入站的防火墙规则"


def frontend_has_hardcoded_host() -> list[str]:
    """前端里写死本机地址的话，手机打开后接口会全挂。"""
    hits: list[str] = []
    for path in list((BASE_DIR / "static").rglob("*.js")) + list((BASE_DIR / "templates").glob("*.html")):
        text = path.read_text(encoding="utf-8", errors="ignore")
        for idx, line in enumerate(text.splitlines(), start=1):
            if "127.0.0.1" in line or "localhost" in line:
                hits.append(f"{path.relative_to(BASE_DIR)}:{idx} {line.strip()[:70]}")
    return hits


def main() -> int:
    host, port = Config.APP_HOST, Config.APP_PORT
    ip = lan_ip()
    print(f"  监听配置：{host}:{port}　本机局域网 IP：{ip or '（探不到，可能没连网）'}")

    check(host not in ("127.0.0.1", "localhost"),
          "监听地址允许局域网访问（0.0.0.0 或具体网卡 IP）",
          f"APP_HOST={host}")

    listeners = netstat_listeners(port)
    loopback_only = bool(listeners) and all(a.startswith("127.") for a in listeners)
    check(bool(listeners) and not loopback_only,
          f"实际已监听 {port} 且不是只绑回环地址",
          f"监听地址={listeners or '（没有进程在监听）'}")

    if ip:
        try:
            with urllib.request.urlopen(f"http://{ip}:{port}/api/health", timeout=8) as resp:
                ok = resp.status == 200
            check(ok, f"用局域网 IP 能连上（http://{ip}:{port}/api/health）", f"HTTP {resp.status}")
        except Exception as exc:  # noqa: BLE001
            check(False, f"用局域网 IP 能连上（http://{ip}:{port}/api/health）", f"{exc!r}")
    else:
        check(False, "能探到本机局域网 IP", "没有可用网卡地址，局域网访问无从谈起")

    allowed, evidence = firewall_allows(port)
    check(allowed, f"Windows 防火墙已放行 {port} 入站",
          evidence + ("" if allowed else "——双击项目根目录的 open-lan.bat（管理员）即可放行"))

    hits = frontend_has_hardcoded_host()
    check(not hits, "前端没有写死 127.0.0.1/localhost（否则手机打开后接口会挂）",
          "；".join(hits[:3]) if hits else "全部是相对路径")

    print()
    passed = sum(1 for ok, _t, _e in results if ok)
    for ok, title, evidence in results:
        print(f"  [{'PASS' if ok else 'FAIL'}] {title}" + (f"　（{evidence}）" if evidence else ""))
    print(f"\n===== 结果：通过 {passed} / {len(results)} ======")
    if passed == len(results) and ip:
        print(f"🎉 局域网里用 http://{ip}:{port} 即可访问（手机连同一 Wi-Fi）")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
