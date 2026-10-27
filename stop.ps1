$ErrorActionPreference = "Stop"
$statePath = Join-Path $PSScriptRoot ".local\desktop-app-processes.json"
if (-not (Test-Path $statePath)) {
    Write-Host "No Bridge Desk processes are recorded as started by this launcher."
    exit 0
}

$records = @(Get-Content $statePath -Raw | ConvertFrom-Json)
foreach ($record in $records) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)" -ErrorAction SilentlyContinue
    if ($process -and $process.CommandLine -and
        $process.CommandLine.IndexOf([string]$record.scriptPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Stop-Process -Id $record.pid -Force -ErrorAction SilentlyContinue
    }
}
Remove-Item -LiteralPath $statePath -Force
Write-Host "Bridge Desk processes started by this launcher were stopped."
