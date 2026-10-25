' start-gatekeeper.vbs — runs a gatekeeper instance hidden (no window)
' Usage: wscript start-gatekeeper.vbs <path-to-.env>
If WScript.Arguments.Count < 1 Then
    WScript.Echo "Usage: wscript start-gatekeeper.vbs <path-to-.env>"
    WScript.Quit 1
End If

Dim envFile, gkDir, nodeExe, wsh
envFile = WScript.Arguments(0)
gkDir = "C:\Users\ciphe\Documents\GitHub\on-demand-gatekeeper"
nodeExe = "C:\Users\ciphe\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.14.0-win-x64\node.exe"

Set wsh = CreateObject("WScript.Shell")
wsh.CurrentDirectory = gkDir
' Run node in background (0 = hidden window, False = don't wait)
wsh.Run Chr(34) & nodeExe & Chr(34) & " start-instance.js " & Chr(34) & envFile & Chr(34), 0, False
Set wsh = Nothing