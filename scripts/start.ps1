# Starts the API as a detached background process (survives the terminal).
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/start.ps1
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $root "data"
$pidFile = Join-Path $dataDir "server.pid"
$outLog = Join-Path $dataDir "server.log"
$errLog = Join-Path $dataDir "server.err.log"
$port = if ($env:DSPACE_PORT) { $env:DSPACE_PORT } else { "8787" }
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) { throw "bun not found on PATH" }

# Refuse to start if anything is already listening (prevents doomed EADDRINUSE spawns).
$busy = netstat -ano | Select-String "LISTENING" | Select-String ":$port\s"
if ($busy) {
  Write-Host "Port $port is already in use:"
  $busy | ForEach-Object { Write-Host "  $_" }
  Write-Host "Run scripts/stop.ps1 first, or set DSPACE_PORT to another port."
  exit 1
}

$proc = Start-Process -FilePath $bun `
  -ArgumentList "src/server.js" `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog `
  -PassThru

$proc.Id | Set-Content $pidFile

Start-Sleep -Seconds 2
try {
  $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "http://127.0.0.1:$port/api/health"
  Write-Host "Server running (pid $($proc.Id)): http://127.0.0.1:$port/api/health [$($r.StatusCode)]"
} catch {
  Write-Host "Started pid $($proc.Id), but health check failed. See $errLog"
  exit 1
}
