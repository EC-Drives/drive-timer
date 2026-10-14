@echo off
rem Starts Drive Timer on this laptop only, at http://localhost:8765/
rem Close this window (or press Ctrl+C) to stop it.
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python is needed to run Drive Timer on the laptop, and it was not found.
  pause
  exit /b 1
)
echo Starting Drive Timer. Your browser will open in a moment.
echo Keep this window open while you use it. Close it to stop.
python -I tools\serve.py 8765 --open
pause
