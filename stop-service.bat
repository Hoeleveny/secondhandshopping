@echo off
chcp 65001 >nul
echo 正在停止校园二手集市服务...

REM 先结束计划任务（如果它是被计划任务拉起来的）
schtasks /End /TN "SecondHandShop" >nul 2>&1

REM 再按端口找到真正在跑的进程结束掉
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":5000 " ^| findstr "LISTENING"') do (
    echo   结束进程 PID=%%p
    taskkill /PID %%p /F >nul 2>&1
)

echo 已停止。
pause
