@echo off
REM ============================================================================
REM  Install On-Demand Gatekeeper as a Windows Service
REM
REM  Run this script as Administrator (right-click -> Run as administrator).
REM
REM  Usage:
REM    install-service.bat                          (uses defaults: gazi-portfolio, port 8023)
REM    install-service.bat <service-name> <env-file> (custom instance)
REM
REM  Examples:
REM    install-service.bat OnDemandGatekeeper-gazi-portfolio C:\path\to\gazi.env
REM    install-service.bat OnDemandGatekeeper-ai-invoice C:\path\to\ai-invoice.env
REM ============================================================================

setlocal

set "GK_DIR=C:\Users\ciphe\Documents\GitHub\on-demand-gatekeeper"
set "SERVICE_NAME=%~1"
if "%SERVICE_NAME%"=="" set "SERVICE_NAME=OnDemandGatekeeper-gazi-portfolio"
set "ENV_FILE=%~2"
if "%ENV_FILE%"=="" set "ENV_FILE=%GK_DIR%\.env"

set "NODE_EXE=C:\Users\ciphe\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.14.0-win-x64\node.exe"
set "WINSW=%GK_DIR%\node_modules\node-windows\bin\winsw\winsw.exe"
set "WRAPPER=%GK_DIR%\node_modules\node-windows\lib\wrapper.js"
set "ENTRY=%GK_DIR%\service-wrapper.js"
set "DAEMON_DIR=%GK_DIR%\daemon"
set "XML_FILE=%DAEMON_DIR%\%SERVICE_NAME%.xml"

if not exist "%DAEMON_DIR%" mkdir "%DAEMON_DIR%"

REM Derive a safe id from the service name (lowercase, no hyphens)
set "SVC_ID=%SERVICE_NAME%"
set "SVC_ID=%SVC_ID:-=%"
set "SVC_ID=%SVC_ID: =%"

REM Write the winsw XML config
(
echo ^<service^>
echo 	^<id^>%SVC_ID%.exe^</id^>
echo 	^<name^>%SERVICE_NAME%^</name^>
echo 	^<description^>On-Demand Gatekeeper - %SERVICE_NAME%^</description^>
echo 	^<executable^>%NODE_EXE%^</executable^>
echo 	^<argument^>%WRAPPER%^</argument^>
echo 	^<argument^>--file^</argument^>
echo 	^<argument^>%ENTRY%^</argument^>
echo 	^<argument^>--scriptoptions=^</argument^>
echo 	^<argument^>--log^</argument^>
echo 	^<argument^>%SERVICE_NAME% wrapper^</argument^>
echo 	^<argument^>--grow^</argument^>
echo 	^<argument^>0.25^</argument^>
echo 	^<argument^>--wait^</argument^>
echo 	^<argument^>1^</argument^>
echo 	^<argument^>--maxrestarts^</argument^>
echo 	^<argument^>3^</argument^>
echo 	^<argument^>--abortonerror^</argument^>
echo 	^<argument^>n^</argument^>
echo 	^<argument^>--stopparentfirst^</argument^>
echo 	^<env name="GATEKEEPER_ENV_FILE" value="%ENV_FILE%" /^>
echo ^</service^>
) > "%XML_FILE%"

REM Copy winsw.exe next to the XML with matching name
copy /Y "%WINSW%" "%DAEMON_DIR%\%SVC_ID%.exe" >nul

echo Installing service %SERVICE_NAME%...
"%DAEMON_DIR%\%SVC_ID%.exe" install "%XML_FILE%"

if %ERRORLEVEL% EQU 0 (
    echo Service installed successfully.
    echo Starting service...
    sc start "%SERVICE_NAME%"
) else (
    echo Service installation failed. Make sure you are running as Administrator.
)

pause
endlocal