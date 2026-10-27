$ErrorActionPreference = "Stop"
$statePath = Join-Path $PSScriptRoot ".local\desktop-app-processes.json"
if (-not (Test-Path $statePath)) {
    Write-Host "No Bridge Desk processes are recorded as started by this launcher."
    exit 0
}

$records = @(Get-Content $statePath -Raw | ConvertFrom-Json)
$allowedScripts = @(
    [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "server\harness_server.py")),
    [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "desktop-app\app.py"))
)
$venvPython = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".venv\Scripts\python.exe"))
$unverified = @()
$remaining = @()
foreach ($record in $records) {
    $scriptPath = [IO.Path]::GetFullPath([string]$record.scriptPath)
    if ($scriptPath -notin $allowedScripts) {
        Write-Warning "Skipping unrecognized process record: $scriptPath"
        $remaining += $record
        continue
    }
    $process = Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    if ($record.startTimeFileTimeUtc) {
        if ([string]$process.StartTime.ToFileTimeUtc() -ne [string]$record.startTimeFileTimeUtc) {
            Write-Warning "Skipping reused process ID $($record.pid)."
            continue
        }
    } elseif ($process.Path -and [IO.Path]::GetFullPath($process.Path) -ne $venvPython) {
        Write-Warning "Skipping unverified legacy process ID $($record.pid)."
        $remaining += $record
        continue
    }
    & taskkill.exe /PID ([int]$record.pid) /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { $unverified += [int]$record.pid; $remaining += $record }
}
if ($remaining.Count) {
    $remaining | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 $statePath
    if ($unverified.Count) { throw "Could not stop process IDs: $($unverified -join ', '). The process record was kept for another attempt." }
    throw "Some process records could not be verified. They were kept for safety."
}
Remove-Item -LiteralPath $statePath -Force
Write-Host "Bridge Desk processes started by this launcher were stopped."
