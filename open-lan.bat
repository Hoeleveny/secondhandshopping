@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================================
echo  让「校园二手集市」在局域网里可访问
echo ============================================================
echo.
echo  这一步要做两件事：
echo    1) 放行 Windows 防火墙的 5000 端口（需要管理员权限）
echo    2) 告诉你局域网里该用哪个地址打开
echo.

net session >nul 2>&1
if errorlevel 1 (
  echo  [!] 当前不是管理员窗口。
  echo      请右键本文件 -^> 「以管理员身份运行」，否则防火墙放行会失败。
  echo.
  pause
  exit /b 1
)

echo [1/2] 放行防火墙入站 5000 端口（仅限同一网段）...
netsh advfirewall firewall delete rule name="校园二手集市 5000" >nul 2>&1
netsh advfirewall firewall add rule name="校园二手集市 5000" dir=in action=allow ^
  protocol=TCP localport=5000 remoteip=LocalSubnet profile=private,domain,public >nul
if errorlevel 1 (
  echo  [!] 放行失败，请确认是以管理员身份运行的。
) else (
  echo  [OK] 已放行 TCP 5000（入站，来源限定同网段）。
)

echo.
echo [2/2] 局域网访问地址：
powershell -NoProfile -Command ^
  "$ips = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }; foreach ($i in $ips) { Write-Host ('      http://' + $i.IPAddress + ':5000    (' + $i.InterfaceAlias + ')') }"

echo.
echo  手机上连同一个 Wi-Fi，用上面任一地址打开即可。
echo  打不开时依次检查：服务是否在跑（浏览器本机打开 http://127.0.0.1:5000）、
echo  手机和电脑是否真在同一网段、路由器是否开了「AP 隔离」。
echo.
pause
