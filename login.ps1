$ErrorActionPreference = "Stop"
$project = $PSScriptRoot
$python = Join-Path $project ".venv\Scripts\python.exe"
$app = Join-Path $project "desktop-app\app.py"
if (-not (Test-Path $python) -or -not (Test-Path (Join-Path $project "desktop-app\.env"))) {
    throw "Run .\setup.bat first."
}
& $python $app --login
if ($LASTEXITCODE -ne 0) { throw "Gemini sign-in setup failed." }
