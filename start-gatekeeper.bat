@echo off
REM start-gatekeeper.bat - runs a gatekeeper instance using a .env file
REM Usage: start-gatekeeper.bat <path-to-.env>
if "%~1"=="" (
    echo Usage: start-gatekeeper.bat ^<path-to-.env^>
    exit /b 1
)
set "GK_DIR=C:\Users\ciphe\Documents\GitHub\on-demand-gatekeeper"
set "NODE_EXE=C:\Users\ciphe\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.14.0-win-x64\node.exe"
cd /d "%GK_DIR%"
"%NODE_EXE%" "start-instance.js" "%~1"