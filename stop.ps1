$ErrorActionPreference = "Stop"
$statePath = Join-Path $PSScriptRoot ".local\desktop-app-processes.json"
if (-not (Test-Path $statePath)) {
    Write-Host "No Bridge Desk processes are recorded as started by this launcher."
    exit 0
}

try {
    $records = @(Get-Content $statePath -Raw | ConvertFrom-Json)
} catch {
    throw "The saved process list is damaged. Close the Bridge Desk command window to stop it, then remove .local\desktop-app-processes.json."
}
$allowedScripts = @(
    (Join-Path $PSScriptRoot "server\harness_server.py"),
    (Join-Path $PSScriptRoot "desktop-app\app.py")
)
$unverified = @()
$remaining = @()
foreach ($record in $records) {
    $scriptPath = ([string]$record.scriptPath).Trim().Trim('"')
    if ($allowedScripts -notcontains $scriptPath) {
        Write-Warning "Skipping unrecognized process record."
        $remaining += $record
        continue
    }
    $processId = 0
    if (-not [int]::TryParse([string]$record.pid, [ref]$processId)) {
        Write-Warning "Skipping a process record with an invalid process ID."
        $remaining += $record
        continue
    }
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    if ($record.startTimeFileTimeUtc) {
        if ([string]$process.StartTime.ToFileTimeUtc() -ne [string]$record.startTimeFileTimeUtc) {
            Write-Warning "Skipping reused process ID $processId."
            continue
        }
    } else {
        $isPython = $false
        try { $isPython = [string]$process.ProcessName -match '^python(w)?$' } catch { }
        if (-not $isPython) {
            Write-Warning "Skipping unverified legacy process ID $processId."
            $remaining += $record
            continue
        }
    }
    & taskkill.exe /PID $processId /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { $unverified += $processId; $remaining += $record }
}
if ($remaining.Count) {
    $remaining | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 $statePath
    if ($unverified.Count) { throw "Could not stop process IDs: $($unverified -join ', '). The process record was kept for another attempt." }
    throw "Some process records could not be verified. They were kept for safety."
}
Remove-Item -LiteralPath $statePath -Force
Write-Host "Bridge Desk processes started by this launcher were stopped."
