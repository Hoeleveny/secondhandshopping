' Start the campus second-hand shop server in background (no console window).
' Installed copy lives in the Startup folder, so it runs at every logon.
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\secondhandshop"
sh.Run """D:\secondhandshop\.venv\Scripts\pythonw.exe"" ""D:\secondhandshop\service.py""", 0, False
