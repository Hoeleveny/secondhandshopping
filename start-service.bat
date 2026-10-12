@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\pythonw.exe" (
    echo [错误] 没有找到虚拟环境 .venv
    pause
    exit /b 1
)

if not exist "logs" mkdir "logs"

REM 已经在跑就不重复启动
netstat -ano | findstr ":5000 " | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo 服务已在运行：http://127.0.0.1:5000
    exit /b 0
)

echo 正在后台启动校园二手集市...
echo   地址： http://127.0.0.1:5000
echo   日志： logs\server.log
echo   停止： 运行 stop-service.bat
echo.

REM pythonw = 无控制台窗口；日志由 service.py 自己写盘
start "" ".venv\Scripts\pythonw.exe" "service.py"
exit /b 0
