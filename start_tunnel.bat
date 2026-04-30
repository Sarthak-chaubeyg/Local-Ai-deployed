@echo off
title Cloudflare Tunnel — Auto Deploy
cd /d "%~dp0"

echo.
echo  ============================================================
echo         Cloudflare Tunnel — Auto URL Deploy
echo  ============================================================
echo.

REM ─── Check cloudflared.exe exists ───
if not exist "%~dp0cloudflared.exe" (
    echo  [ERROR] cloudflared.exe not found in %~dp0
    echo  Download it first.
    pause
    exit /b 1
)

REM ─── Kill any existing cloudflared ───
taskkill /f /im cloudflared.exe >nul 2>nul

REM ─── Temp file for capturing output ───
set "LOGFILE=%~dp0tunnel_log.txt"
if exist "%LOGFILE%" del "%LOGFILE%" >nul 2>nul

echo  [Tunnel] Starting Cloudflare tunnel on port 1234...

REM ─── Start cloudflared in background, redirect output to log ───
start /b "" "%~dp0cloudflared.exe" tunnel --url http://localhost:1234 > "%LOGFILE%" 2>&1

REM ─── Wait for the URL to appear in the log (up to 30 seconds) ───
set "TUNNEL_URL="
set "ATTEMPTS=0"

:waitloop
if %ATTEMPTS% GEQ 30 goto :nourlfound
timeout /t 1 /nobreak >nul
set /a ATTEMPTS+=1

REM ─── Search for the trycloudflare.com URL in the log ───
for /f "tokens=*" %%L in ('findstr /C:"trycloudflare.com" "%LOGFILE%" 2^>nul') do (
    for /f "tokens=*" %%U in ('powershell -Command "(('%%L' | Select-String -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches).Matches[0].Value)"') do (
        set "TUNNEL_URL=%%U"
    )
)

if defined TUNNEL_URL goto :urlfound
echo  [Tunnel] Waiting for URL... (%ATTEMPTS%s)
goto :waitloop

:nourlfound
echo  [ERROR] Tunnel URL not found after 30 seconds.
echo  Check tunnel_log.txt for errors.
pause
exit /b 1

:urlfound
echo.
echo  ┌──────────────────────────────────────────────────────┐
echo  │                                                      │
echo  │  TUNNEL IS LIVE:                                     │
echo  │  %TUNNEL_URL%
echo  │                                                      │
echo  └──────────────────────────────────────────────────────┘
echo.

REM ─── Update config.example.js with the new URL ───
echo  [Deploy] Updating config.example.js with new tunnel URL...

powershell -ExecutionPolicy Bypass -Command ^
  "$configFile = '%~dp0js\config.example.js';" ^
  "$content = Get-Content $configFile -Raw;" ^
  "$newUrl = '%TUNNEL_URL%';" ^
  "$content = $content -replace 'PUBLIC_API_URL:\s*\"[^\"]*\"', ('PUBLIC_API_URL: \"' + $newUrl + '\"');" ^
  "Set-Content -Path $configFile -Value $content -NoNewline;" ^
  "Write-Host '  [Deploy] config.example.js updated with:' $newUrl"

REM ─── Git commit and push ───
echo  [Deploy] Committing and pushing to GitHub...

git add js/config.example.js >nul 2>nul
git commit -m "Auto-update tunnel URL: %TUNNEL_URL%" >nul 2>nul
git push origin master >nul 2>nul

if %errorlevel%==0 (
    echo  [Deploy] Pushed to GitHub successfully!
    echo  [Deploy] Netlify will auto-deploy in ~30 seconds.
) else (
    echo  [Deploy] Git push skipped (no changes or auth issue)
)

echo.
echo  ============================================================
echo   Tunnel is running. Do NOT close this window.
echo   Your Netlify site will connect automatically.
echo  ============================================================
echo.

REM ─── Keep the window alive (cloudflared runs in background) ───
:keepalive
timeout /t 60 /nobreak >nul
REM Check if cloudflared is still running
tasklist /fi "imagename eq cloudflared.exe" 2>nul | findstr /i "cloudflared" >nul
if %errorlevel%==0 goto :keepalive

echo  [Tunnel] cloudflared has stopped. Restarting...
goto :waitloop
