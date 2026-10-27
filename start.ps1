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

function Get-ListenerPid([int]$Port) {
    $pattern = '^\s*TCP\s+\S+:' + [regex]::Escape([string]$Port) + '\s+\S+\s+LISTENING\s+(?<pid>\d+)\s*$'
    $line = netstat.exe -ano -p TCP | Where-Object { $_ -match $pattern } | Select-Object -First 1
    if ($line -and $line -match $pattern) { return [int]$Matches.pid }
    return $null
}

$bridgeReady = Test-LocalService "http://127.0.0.1:5050/health"
$appUrl = "http://127.0.0.1:5100"
$appState = Get-BridgeDeskState "$appUrl/api/state"
$appReady = $appState -and $appState.app_version -eq "2.2.3"
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
    $started += [pscustomobject]@{ launcherPid = $process.Id; port = 5050; scriptPath = $bridgeScript }
}

if (-not $appReady) {
    $appLog = Join-Path $logDir "desktop-app-$stamp.log"
    $appError = Join-Path $logDir "desktop-app-$stamp.err.log"
    $appScript = Join-Path $desktopApp "app.py"
    $process = Start-Process -FilePath $python `
        -ArgumentList ('"{0}"' -f $appScript) `
        -WorkingDirectory $desktopApp -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $appLog -RedirectStandardError $appError
    $started += [pscustomobject]@{ launcherPid = $process.Id; port = 5100; scriptPath = $appScript }
}

$deadline = (Get-Date).AddSeconds(30)
do {
    Start-Sleep -Milliseconds 500
    $bridgeReady = Test-LocalService "http://127.0.0.1:5050/health"
    $appState = Get-BridgeDeskState "$appUrl/api/state"
    $appReady = $appState -and $appState.app_version -eq "2.2.3"
} until (($bridgeReady -and $appReady) -or (Get-Date) -ge $deadline)

if (-not ($bridgeReady -and $appReady)) {
    foreach ($item in $started) {
        & taskkill.exe /PID ([int]$item.launcherPid) /T /F | Out-Null
    }
    throw "Bridge Desk did not start. Check the latest logs in .local\logs."
}

if ($started.Count) {
    $tracked = @()
    if (Test-Path $statePath) {
        try { $tracked = @(Get-Content $statePath -Raw | ConvertFrom-Json) } catch { $tracked = @() }
    }
    foreach ($item in $started) {
        $listenerPid = Get-ListenerPid ([int]$item.port)
        if (-not $listenerPid) { throw "Could not record the listener on port $($item.port)." }
        $listener = Get-Process -Id $listenerPid -ErrorAction Stop
        $tracked += [pscustomobject]@{
            pid = $listenerPid
            scriptPath = $item.scriptPath
            startTimeFileTimeUtc = [string]$listener.StartTime.ToFileTimeUtc()
        }
    }
    $tracked | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 $statePath
}

Start-Process $appUrl
Write-Host "Bridge Desk is open in your browser."
Write-Host "To stop the background app and bridge, run .\stop.bat."
