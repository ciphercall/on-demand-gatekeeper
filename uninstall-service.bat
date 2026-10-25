@echo off
REM ============================================================================
REM  Uninstall On-Demand Gatekeeper Windows Service
REM
REM  Run this script as Administrator (right-click -> Run as administrator).
REM
REM  Usage:
REM    uninstall-service.bat <service-name>
REM
REM  Examples:
REM    uninstall-service.bat OnDemandGatekeeper-gazi-portfolio
REM    uninstall-service.bat OnDemandGatekeeper-ai-invoice
REM ============================================================================

setlocal

set "GK_DIR=C:\Users\ciphe\Documents\GitHub\on-demand-gatekeeper"
set "SERVICE_NAME=%~1"
if "%SERVICE_NAME%"=="" (
    echo Usage: uninstall-service.bat ^<service-name^>
    echo Example: uninstall-service.bat OnDemandGatekeeper-gazi-portfolio
    pause
    exit /b 1
)

set "SVC_ID=%SERVICE_NAME%"
set "SVC_ID=%SVC_ID:-=%"
set "SVC_ID=%SVC_ID: =%"

set "DAEMON_DIR=%GK_DIR%\daemon"

echo Stopping service %SERVICE_NAME%...
sc stop "%SERVICE_NAME%" 2>nul

echo Uninstalling service %SERVICE_NAME%...
"%DAEMON_DIR%\%SVC_ID%.exe" uninstall 2>nul

if %ERRORLEVEL% EQU 0 (
    echo Service uninstalled successfully.
) else (
    echo Service uninstall may have failed. Check if the service exists.
)

pause
endlocal