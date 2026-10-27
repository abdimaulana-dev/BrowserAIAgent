@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0login.ps1"
if errorlevel 1 (
    echo.
    echo Sign-in setup failed. Review the message above.
    echo.
    pause
)
