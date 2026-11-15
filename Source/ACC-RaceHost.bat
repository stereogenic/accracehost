@echo off
title ACC Race Host

:: 1. Force the script to look at the ACTUAL directory of the EXE file
for /f "delims=" %%I in ("%~dp0.") do set "APP_DIR=%%~fI"

:: Fallback check: if running inside Bat to Exe temp folder, grab the true directory
if not exist "%APP_DIR%\bin\node.exe" (
    set "APP_DIR=%CD%"
)

:: 2. Check if port 3030 is already open and listening
netstat -ano | findstr ":3030" | findstr "LISTENING" >NUL
if %ERRORLEVEL% equ 0 (
    echo ACC Race Host is already running. Opening GUI...
    start "" "http://localhost:3030"
    exit /b
)

:: 3. Launch the tray & background Node server via PowerShell using the absolute APP_DIR path
powershell -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -ArgumentList '-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File \"%APP_DIR%\bin\tray.ps1\"' -WindowStyle Hidden"

exit /b