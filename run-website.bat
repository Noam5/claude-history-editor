@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but was not found in PATH.
  echo Install Node.js, then run this file again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 goto :failed
)

echo Building Claude History Editor...
call npm run build
if errorlevel 1 goto :failed

echo Starting at http://127.0.0.1:4317
if /i "%~1"=="--no-browser" goto :start_server
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:4317'"

:start_server
call npm start
exit /b %errorlevel%

:failed
echo.
echo Claude History Editor could not be started.
pause
exit /b 1
