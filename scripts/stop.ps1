# Stops the API: uses data/server.pid first, then falls back to the process
# actually LISTENING on the port (handles orphans from earlier runs).
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/stop.ps1
$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root "data\server.pid"
$port = if ($env:DSPACE_PORT) { $env:DSPACE_PORT } else { "8787" }

$targets = @()

if (Test-Path $pidFile) {
  $saved = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($saved -and (Get-Process -Id $saved -ErrorAction SilentlyContinue)) {
    $targets += [int]$saved
  }
}

# Fallback: whoever is listening on the port (bun may be an orphan without a pid file).
netstat -ano | Select-String "LISTENING" | Select-String ":$port\s" | ForEach-Object {
  $parts = ($_ -replace "\s+", " ").Trim() -split " "
  $candidate = [int]$parts[-1]
  if ($candidate -gt 0 -and $candidate -ne $PID -and $targets -notcontains $candidate) {
    $targets += $candidate
  }
}

if (-not $targets) {
  Write-Host "Nothing listening on port $port."
  Remove-Item $pidFile -ErrorAction SilentlyContinue
  exit 0
}

foreach ($t in $targets) {
  $proc = Get-Process -Id $t -ErrorAction SilentlyContinue
  if ($proc) {
    Stop-Process -Id $t -Force
    Write-Host "Stopped $($proc.ProcessName) pid $t"
  }
}
Remove-Item $pidFile -ErrorAction SilentlyContinue
