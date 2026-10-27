param([switch]$BridgeOnly)

$ErrorActionPreference = "Stop"
$project = $PSScriptRoot
$envFile = Join-Path $project ".env"
$python = Join-Path $project ".venv\Scripts\python.exe"
$desktopApp = Join-Path $project "desktop-app"
$desktopEnvFile = Join-Path $desktopApp ".env"
$localDir = Join-Path $project ".local"
$statePath = Join-Path $localDir "desktop-app-processes.json"

if (-not (Test-Path $envFile) -or -not (Test-Path $python)) {
    throw "Run .\setup.bat first."
}
Get-Content $envFile | ForEach-Object {
    if ($_ -match '^([^#=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process") }
}

if ($BridgeOnly) {
    & $python (Join-Path $project "server\harness_server.py")
    exit $LASTEXITCODE
}
if (-not (Test-Path $desktopEnvFile)) { throw "Run .\setup.bat first to configure Bridge Desk." }

function Test-LocalService([string]$Url) {
    try {
        $null = Invoke-WebRequest -Uri $Url -TimeoutSec 2 -UseBasicParsing
        return $true
    } catch {
        return $false
    }
}

function Get-BridgeDeskState([string]$Url) {
    try {
        return Invoke-RestMethod -Uri $Url -TimeoutSec 2
    } catch {
        return $null
    }
}

$bridgeReady = Test-LocalService "http://127.0.0.1:5050/health"
$appUrl = "http://127.0.0.1:5100"
$appState = Get-BridgeDeskState "$appUrl/api/state"
$appReady = $appState -and $appState.app_version -eq "2.2.2"
if ($appState -and -not $appReady) {
    throw "Another or older app is using port 5100. Close that app, then run .\start.bat again."
}
$started = @()
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logDir = Join-Path $localDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (-not $bridgeReady) {
    $bridgeLog = Join-Path $logDir "bridge-$stamp.log"
    $bridgeError = Join-Path $logDir "bridge-$stamp.err.log"
    $bridgeScript = Join-Path $project "server\harness_server.py"
    $process = Start-Process -FilePath $python `
        -ArgumentList ('"{0}"' -f $bridgeScript) `
        -WorkingDirectory $project -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $bridgeLog -RedirectStandardError $bridgeError
    $started += [pscustomobject]@{ pid = $process.Id; scriptPath = $bridgeScript }
}

if (-not $appReady) {
    $appLog = Join-Path $logDir "desktop-app-$stamp.log"
    $appError = Join-Path $logDir "desktop-app-$stamp.err.log"
    $appScript = Join-Path $desktopApp "app.py"
    $process = Start-Process -FilePath $python `
        -ArgumentList ('"{0}"' -f $appScript) `
        -WorkingDirectory $desktopApp -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $appLog -RedirectStandardError $appError
    $started += [pscustomobject]@{ pid = $process.Id; scriptPath = $appScript }
}

if ($started.Count) {
    $tracked = @()
    if (Test-Path $statePath) {
        try { $tracked = @(Get-Content $statePath -Raw | ConvertFrom-Json) } catch { $tracked = @() }
    }
    $tracked += $started
    $tracked | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 $statePath
}

$deadline = (Get-Date).AddSeconds(30)
do {
    Start-Sleep -Milliseconds 500
    $bridgeReady = Test-LocalService "http://127.0.0.1:5050/health"
    $appState = Get-BridgeDeskState "$appUrl/api/state"
    $appReady = $appState -and $appState.app_version -eq "2.2.2"
} until (($bridgeReady -and $appReady) -or (Get-Date) -ge $deadline)

if (-not ($bridgeReady -and $appReady)) {
    foreach ($item in $started) {
        Stop-Process -Id $item.pid -Force -ErrorAction SilentlyContinue
    }
    throw "Bridge Desk did not start. Check the latest logs in .local\logs."
}

Start-Process $appUrl
Write-Host "Bridge Desk is open in your browser."
Write-Host "To stop the background app and bridge, run .\stop.bat."
