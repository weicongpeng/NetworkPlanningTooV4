@echo off
REM Start Electron with retry logic for Vite port availability

echo Waiting for Vite dev server to be ready...

setlocal enabledelayedexpansion
set maxRetries=30
set retryCount=0
set portReady=0

REM Try to check if port is ready using a simple curl/wget approach
:retryLoop
if !retryCount! geq !maxRetries! (
    echo [WARNING] Vite port 5173 not responding after !maxRetries! attempts
    echo Starting Electron anyway...
    goto startElectron
)

REM Try to connect to the port
powershell -Command "try { $null = [System.Net.Sockets.TcpClient]::new().Connect('127.0.0.1', 5173); exit 0 } catch { exit 1 }" >nul 2>&1
if errorlevel 0 (
    set portReady=1
    echo Vite server is ready!
    goto startElectron
)

REM Wait and retry
set /a retryCount+=1
echo Attempt !retryCount!/!maxRetries!...
timeout /t 1 /nobreak >nul
goto retryLoop

:startElectron
echo Starting Electron...
npx electron .

endlocal
