$ErrorActionPreference = "Stop"

$project = $PSScriptRoot
$envFile = Join-Path $project ".env"
$python = Join-Path $project ".venv\Scripts\python.exe"
if (-not (Test-Path $envFile) -or -not (Test-Path $python)) {
    throw "Run .\setup.ps1 first."
}

Get-Content $envFile | ForEach-Object {
    if ($_ -match '^([^#=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process") }
}
& $python (Join-Path $project "server\harness_server.py")
