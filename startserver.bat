@echo off
title Intelligent Chat Server
cd /d "%~dp0"

echo.
echo  ============================================================
echo         Intelligent Chat — Local Network Server
echo  ============================================================
echo.

REM ─── Detect local IP address ───
set "LOCAL_IP="
set "HOSTNAME_NAME=%COMPUTERNAME%"
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /R /C:"IPv4.*192\.168\." /C:"IPv4.*10\." /C:"IPv4.*172\."') do (
    for /f "tokens=1" %%b in ("%%a") do (
        if not defined LOCAL_IP set "LOCAL_IP=%%b"
    )
)

set "PORT=8080"

echo  ┌──────────────────────────────────────────────────────┐
echo  │                                                      │
echo  │  ACCESS URLs:                                        │
echo  │                                                      │
echo  │  From THIS device (laptop):                          │
echo  │    http://localhost:%PORT%                            │
echo  │                                                      │
if defined LOCAL_IP (
echo  │  From PHONE / other devices on WiFi:                 │
echo  │    http://%LOCAL_IP%:%PORT%                     │
echo  │                                                      │
)
echo  │  LM Studio must be running with API on port 1234     │
echo  │                                                      │
echo  └──────────────────────────────────────────────────────┘
echo.

if defined LOCAL_IP (
echo  TIP: To keep the same URL every day, set a STATIC IP
echo  on this device. See the walkthrough for instructions.
echo.
)

REM ─── Save port for stopserver.bat ───
echo %PORT% > "%~dp0.server_port"

REM ─── Try py launcher first (most reliable on Windows) ───
where py >nul 2>nul
if %errorlevel%==0 (
    echo  [Server] Found Python via 'py' launcher
    py -3 -m http.server %PORT% --bind 0.0.0.0
    goto :done
)

REM ─── Try python ───
where python >nul 2>nul
if %errorlevel%==0 (
    REM Verify it's real Python, not the Windows Store stub
    python --version >nul 2>nul
    if %errorlevel%==0 (
        echo  [Server] Found Python via 'python'
        python -m http.server %PORT% --bind 0.0.0.0
        goto :done
    )
)

REM ─── Try python3 ───
where python3 >nul 2>nul
if %errorlevel%==0 (
    echo  [Server] Found Python via 'python3'
    python3 -m http.server %PORT% --bind 0.0.0.0
    goto :done
)

REM ─── Try common install paths ───
if exist "%LOCALAPPDATA%\Programs\Python" (
    for /f "delims=" %%p in ('dir /b /o-n "%LOCALAPPDATA%\Programs\Python\Python3*" 2^>nul') do (
        if exist "%LOCALAPPDATA%\Programs\Python\%%p\python.exe" (
            echo  [Server] Found Python at %LOCALAPPDATA%\Programs\Python\%%p
            "%LOCALAPPDATA%\Programs\Python\%%p\python.exe" -m http.server %PORT% --bind 0.0.0.0
            goto :done
        )
    )
)

REM ─── Try Program Files ───
if exist "C:\Python3*" (
    for /f "delims=" %%p in ('dir /b /o-n "C:\Python3*" 2^>nul') do (
        if exist "C:\%%p\python.exe" (
            echo  [Server] Found Python at C:\%%p
            "C:\%%p\python.exe" -m http.server %PORT% --bind 0.0.0.0
            goto :done
        )
    )
)

REM ─── Fallback: PowerShell HTTP server ───
echo  [Server] Python not found — using PowerShell HTTP server
echo  (For better performance, install Python: python.org/downloads)
echo.
powershell -ExecutionPolicy Bypass -Command ^
 "$ErrorActionPreference='Stop';" ^
 "$port=%PORT%;" ^
 "$root='%~dp0'.TrimEnd('\');" ^
 "$listener=New-Object System.Net.HttpListener;" ^
 "$listener.Prefixes.Add('http://+:'+$port+'/');" ^
 "try{$listener.Start()}catch{Write-Host '  ERROR: Port '+$port+' in use or admin needed.';Write-Host '  Try: Run as Administrator, or change PORT in startserver.bat';Read-Host;exit};" ^
 "Write-Host '  [Server] Listening on port' $port '(PowerShell)';" ^
 "Write-Host '';" ^
 "$mime=@{'.html'='text/html;charset=utf-8';'.css'='text/css;charset=utf-8';'.js'='application/javascript;charset=utf-8';'.json'='application/json';'.png'='image/png';'.jpg'='image/jpeg';'.svg'='image/svg+xml';'.ico'='image/x-icon';'.woff'='font/woff';'.woff2'='font/woff2';'.ttf'='font/ttf';'.pdf'='application/pdf'};" ^
 "while($listener.IsListening){" ^
 "  $ctx=$listener.GetContext();" ^
 "  $path=$ctx.Request.Url.LocalPath;" ^
 "  if($path -eq '/'){$path='/index.html'};" ^
 "  $file=Join-Path $root ($path.TrimStart('/').Replace('/','\\'));" ^
 "  $ts=Get-Date -Format 'HH:mm:ss';" ^
 "  if(Test-Path $file -PathType Leaf){" ^
 "    $ext=[IO.Path]::GetExtension($file).ToLower();" ^
 "    $ct=if($mime.ContainsKey($ext)){$mime[$ext]}else{'application/octet-stream'};" ^
 "    $ctx.Response.ContentType=$ct;" ^
 "    $ctx.Response.StatusCode=200;" ^
 "    $bytes=[IO.File]::ReadAllBytes($file);" ^
 "    $ctx.Response.OutputStream.Write($bytes,0,$bytes.Length);" ^
 "    Write-Host ('  '+$ts+'  200  '+$path);" ^
 "  }else{" ^
 "    $ctx.Response.StatusCode=404;" ^
 "    $msg=[Text.Encoding]::UTF8.GetBytes('404 Not Found');" ^
 "    $ctx.Response.OutputStream.Write($msg,0,$msg.Length);" ^
 "    Write-Host ('  '+$ts+'  404  '+$path);" ^
 "  };" ^
 "  $ctx.Response.Close();" ^
 "}"

:done
if exist "%~dp0.server_port" del "%~dp0.server_port" >nul 2>nul
echo.
echo  Server stopped.
pause
