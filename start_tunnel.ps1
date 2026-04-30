# ═══════════════════════════════════════════════════════
#  start_tunnel.ps1
#  Auto-starts Cloudflare tunnel, captures URL,
#  updates config, pushes to GitHub.
#  Netlify auto-deploys. Zero manual work.
# ═══════════════════════════════════════════════════════

$ErrorActionPreference = 'SilentlyContinue'
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectDir

Write-Host ""
Write-Host "  =========================================================="
Write-Host "         Cloudflare Tunnel - Auto URL Deploy"
Write-Host "  =========================================================="
Write-Host ""

# --- Check cloudflared.exe ---
$cfExe = Join-Path $projectDir "cloudflared.exe"
if (-not (Test-Path $cfExe)) {
    Write-Host "  [ERROR] cloudflared.exe not found!" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# --- Kill existing cloudflared ---
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

# --- Start cloudflared and capture output ---
Write-Host "  [Tunnel] Starting Cloudflare tunnel on port 1234..."

$logFile = Join-Path $projectDir "tunnel_log.txt"
if (Test-Path $logFile) { Remove-Item $logFile -Force }

$pinfo = New-Object System.Diagnostics.ProcessStartInfo
$pinfo.FileName = $cfExe
$pinfo.Arguments = "tunnel --url http://localhost:1234"
$pinfo.RedirectStandardOutput = $true
$pinfo.RedirectStandardError = $true
$pinfo.UseShellExecute = $false
$pinfo.CreateNoWindow = $true
$pinfo.WorkingDirectory = $projectDir

$process = New-Object System.Diagnostics.Process
$process.StartInfo = $pinfo
$process.Start() | Out-Null

# --- Wait for the URL (up to 40 seconds) ---
$tunnelUrl = ""
$attempts = 0
$maxAttempts = 40

while ($attempts -lt $maxAttempts -and -not $tunnelUrl) {
    Start-Sleep -Seconds 1
    $attempts++
    
    # Read stderr (cloudflared writes info to stderr)
    $errOutput = ""
    while (-not $process.StandardError.EndOfStream) {
        $line = $process.StandardError.ReadLine()
        $errOutput += $line + "`n"
        Add-Content -Path $logFile -Value $line
        
        if ($line -match '(https://[a-z0-9-]+\.trycloudflare\.com)') {
            $tunnelUrl = $Matches[1]
            break
        }
    }
    
    if (-not $tunnelUrl) {
        Write-Host "  [Tunnel] Waiting for URL... ($attempts`s)"
    }
}

if (-not $tunnelUrl) {
    Write-Host "  [ERROR] Tunnel URL not found after $maxAttempts seconds." -ForegroundColor Red
    Write-Host "  Check tunnel_log.txt for details."
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host ""
Write-Host "  ==========================================================" -ForegroundColor Green
Write-Host "   TUNNEL IS LIVE: $tunnelUrl" -ForegroundColor Green
Write-Host "  ==========================================================" -ForegroundColor Green
Write-Host ""

# --- Update config.example.js ---
Write-Host "  [Deploy] Updating config.example.js..."
$configFile = Join-Path $projectDir "js\config.example.js"
$content = Get-Content $configFile -Raw
$content = $content -replace 'PUBLIC_API_URL:\s*"[^"]*"', "PUBLIC_API_URL: `"$tunnelUrl`""
Set-Content -Path $configFile -Value $content -NoNewline
Write-Host "  [Deploy] Updated with: $tunnelUrl"

# --- Git commit and push ---
Write-Host "  [Deploy] Pushing to GitHub..."
& git add "js/config.example.js" 2>$null
& git diff --cached --quiet 2>$null
$hasChanges = $LASTEXITCODE -ne 0

if ($hasChanges) {
    & git commit -m "Auto-update tunnel URL" 2>$null | Out-Null
    & git push origin master 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [Deploy] Pushed to GitHub! Netlify will auto-deploy." -ForegroundColor Green
    } else {
        Write-Host "  [Deploy] Push failed - check credentials." -ForegroundColor Yellow
    }
} else {
    Write-Host "  [Deploy] URL unchanged, no push needed."
}

Write-Host ""
Write-Host "  ==========================================================" 
Write-Host "   Tunnel is running. Do NOT close this window."
Write-Host "   Your Netlify site will connect automatically."
Write-Host "  ==========================================================" 
Write-Host ""

# --- Keep alive: wait for cloudflared to exit ---
try {
    $process.WaitForExit()
} catch {
    # Process was killed externally
}
Write-Host "  [Tunnel] Cloudflared has stopped." -ForegroundColor Yellow
Read-Host "Press Enter to exit"
