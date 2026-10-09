"""让 pip 能在受限文件沙箱下正常工作的补丁。

背景
----
本机 DSH 的文件沙箱（workspace-write 模式）下存在一个明确现象：

    os.makedirs() 创建的子目录          -> 里面可以正常建文件
    tempfile.mkdtemp() 创建的子目录      -> 里面建文件报 PermissionError [Errno 13]

而 pip 全程用 tempfile.mkdtemp() 创建临时目录（pip/_internal/utils/temp_dir.py），
因此直接在沙箱里跑 pip 必然失败在：
    pip/_internal/network/download.py:213  with open(filepath, "wb") as content_file:

解决办法
--------
在导入 pip 之前，把 tempfile.mkdtemp 替换成"用 os.makedirs 创建"的实现。
不对 pip 源码做任何修改，也不降低沙箱权限。

用法
----
    python tools/sandbox_pip.py install flask
    python tools/sandbox_pip.py download --no-deps -d wheels flask

注意：请把 TMP / TEMP 指向工作区内的目录（如 _build_tmp），
      沙箱自身的临时目录在工作区之外，不可写。
"""
import os
import random
import string
import sys
import tempfile


def _mkdtemp(suffix: str = "", prefix: str = "tmp", dir: str | None = None) -> str:
    """等价于 tempfile.mkdtemp，但用 os.makedirs 创建目录。"""
    if dir is None:
        dir = tempfile.gettempdir()
    alphabet = string.ascii_lowercase + string.digits
    for _ in range(10000):
        name = prefix + "".join(random.choices(alphabet, k=8)) + suffix
        path = os.path.join(dir, name)
        try:
            os.makedirs(path)
        except FileExistsError:
            continue
        return path
    raise FileExistsError(f"无法在 {dir} 下创建唯一临时目录")


def install_patch() -> None:
    tempfile.mkdtemp = _mkdtemp  # type: ignore[assignment]


def main() -> int:
    install_patch()
    try:
        from pip._internal.cli.main import main as pip_main
    except ImportError:
        print("找不到 pip，请确认当前 Python 里已安装 pip。", file=sys.stderr)
        return 2
    return pip_main(sys.argv[1:])


if __name__ == "__main__":
    sys.exit(main())
