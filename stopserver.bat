@echo off
title Intelligent Chat — Stop Server
cd /d "%~dp0"

set "PORT=8080"

echo.
echo  ============================================================
echo         Intelligent Chat — Stop Server
echo  ============================================================
echo.

REM ─── Check if server is running on the port ───
set "SERVER_PID="
set "SERVER_RUNNING=0"

for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":%PORT%.*LISTENING"') do (
    if not "%%a"=="0" (
        set "SERVER_PID=%%a"
        set "SERVER_RUNNING=1"
    )
)

if "%SERVER_RUNNING%"=="1" (
    echo  ● Server WAS RUNNING on port %PORT% (PID: %SERVER_PID%)
    echo.

    REM Kill the server process
    taskkill /PID %SERVER_PID% /F >nul 2>nul

    REM Small delay to let the process terminate
    timeout /t 1 /nobreak >nul 2>nul

    REM Verify it was killed
    set "STILL_RUNNING=0"
    for /f "tokens=5" %%b in ('netstat -aon 2^>nul ^| findstr ":%PORT%.*LISTENING"') do (
        if not "%%b"=="0" set "STILL_RUNNING=1"
    )

    if "!STILL_RUNNING!"=="1" (
        echo  ⚠️  Process may still be running. Try running as Administrator.
    ) else (
        echo  ✅ Server has been STOPPED successfully.
    )
) else (
    echo  ○ Server was NOT RUNNING on port %PORT%.
    echo    No action was needed.
)

echo.

REM ─── Cleanup port file ───
if exist "%~dp0.server_port" del "%~dp0.server_port" >nul 2>nul

echo  ────────────────────────────────────────────────────────
echo.
timeout /t 4 /nobreak >nul
