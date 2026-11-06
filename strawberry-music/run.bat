@echo off
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python is required but was not found on PATH.
  pause
  exit /b 1
)

python -c "import fastapi, uvicorn, ytmusicapi, yt_dlp, requests" >nul 2>nul
if errorlevel 1 (
  echo Installing dependencies...
  python -m pip install -r requirements.txt
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

if "%PORT%"=="" set PORT=8420
start /b "" python -m uvicorn server.main:app --host 127.0.0.1 --port %PORT%
timeout /t 3 /nobreak >nul
start "" http://127.0.0.1:%PORT%
