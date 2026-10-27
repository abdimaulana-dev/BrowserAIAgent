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
$appReady = $appState -and $appState.app_version -eq "2.2.4"
if ($bridgeReady -or $appReady) {
    throw "Bridge Desk is already running outside this command window. Close the existing app first so this window can control it."
}

$started = @()
try {
    $bridgeScript = Join-Path $project "server\harness_server.py"
    $process = Start-Process -FilePath $python -ArgumentList ('"{0}"' -f $bridgeScript) `
        -WorkingDirectory $project -NoNewWindow -PassThru
    $started += [pscustomobject]@{ launcherPid = $process.Id; port = 5050; scriptPath = $bridgeScript }

    $appScript = Join-Path $desktopApp "app.py"
    $process = Start-Process -FilePath $python -ArgumentList ('"{0}"' -f $appScript) `
        -WorkingDirectory $desktopApp -NoNewWindow -PassThru
    $started += [pscustomobject]@{ launcherPid = $process.Id; port = 5100; scriptPath = $appScript }

    $deadline = (Get-Date).AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 500
        $bridgeReady = Test-LocalService "http://127.0.0.1:5050/health"
        $appState = Get-BridgeDeskState "$appUrl/api/state"
        $appReady = $appState -and $appState.app_version -eq "2.2.4"
    } until (($bridgeReady -and $appReady) -or (Get-Date) -ge $deadline)

    if (-not ($bridgeReady -and $appReady)) {
        throw "Bridge Desk did not start. Review the errors shown in this command window."
    }

    $tracked = @()
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
    New-Item -ItemType Directory -Force -Path $localDir | Out-Null
    $tracked | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 $statePath

    Start-Process $appUrl
    Write-Host "Bridge Desk is running. Keep this command window open; closing it stops the app and bridge."
    while ((Test-LocalService "http://127.0.0.1:5050/health") -and (Test-LocalService "$appUrl/api/state")) {
        Start-Sleep -Seconds 1
    }
} finally {
    foreach ($item in $started) {
        if (Get-Process -Id ([int]$item.launcherPid) -ErrorAction SilentlyContinue) {
            & taskkill.exe /PID ([int]$item.launcherPid) /T /F 2>$null | Out-Null
        }
    }
    if (Test-Path $statePath) { Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue }
}
