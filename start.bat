@echo off
rem Starts Ghost Journal at http://localhost:8766 and opens it in the browser.
cd /d "%~dp0"
start "Ghost Journal server" python server.py 8766
timeout /t 2 /nobreak >nul
start "" http://localhost:8766/
