@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo [错误] 没有找到虚拟环境 .venv
    echo 请先执行：
    echo     python -m venv .venv
    echo     .venv\Scripts\python.exe -m pip install -r requirements.txt
    pause
    exit /b 1
)

echo ============================================
echo   校园二手集市 - 正在启动
echo   启动后请用浏览器打开： http://127.0.0.1:5000
echo   按 Ctrl+C 停止服务
echo ============================================
echo.

".venv\Scripts\python.exe" app.py
pause
