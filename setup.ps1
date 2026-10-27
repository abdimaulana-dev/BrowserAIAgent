$ErrorActionPreference = "Stop"

$project = $PSScriptRoot
$venvPython = Join-Path $project ".venv\Scripts\python.exe"
$localDir = Join-Path $project ".local"
$envFile = Join-Path $project ".env"
$desktopApp = Join-Path $project "desktop-app"
$desktopEnvFile = Join-Path $desktopApp ".env"

if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
    throw "Python launcher 'py' was not found. Install Python 3.10+ and enable the Python launcher, then run this script again."
}
py -3 -c "import sys; assert sys.version_info >= (3, 10), 'Python 3.10 or newer is required.'"
if ($LASTEXITCODE -ne 0) { throw "Python 3.10 or newer is required." }

if (-not (Test-Path $venvPython)) {
    py -3 -m venv (Join-Path $project ".venv")
    if ($LASTEXITCODE -ne 0) { throw "Could not create the virtual environment." }
}

& $venvPython -m pip install -r (Join-Path $project "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "Could not install Python dependencies." }
& $venvPython -m pip install -r (Join-Path $desktopApp "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "Could not install desktop app dependencies." }
& $venvPython -m playwright install chrome
if ($LASTEXITCODE -ne 0) { throw "Could not install Chrome for the desktop app." }

New-Item -ItemType Directory -Force -Path $localDir | Out-Null
if (-not (Test-Path $envFile)) {
    $token = (& $venvPython -c "import secrets; print(secrets.token_urlsafe(32))").Trim()
    if ($LASTEXITCODE -ne 0 -or -not $token) { throw "Could not generate the local token." }
    $workspace = Join-Path $env:USERPROFILE "PC-Agent-Workspace"
    @("MCP_AUTH_TOKEN=$token", "PC_AGENT_WORKSPACE=$workspace") | Set-Content -Encoding ascii $envFile
}

$settings = @{}
Get-Content $envFile | ForEach-Object {
    if ($_ -match '^([^#=]+)=(.*)$') { $settings[$matches[1]] = $matches[2] }
}
if (-not $settings.MCP_AUTH_TOKEN) { throw ".env is missing MCP_AUTH_TOKEN." }
if (-not $settings.PC_AGENT_WORKSPACE) { throw ".env is missing PC_AGENT_WORKSPACE." }
New-Item -ItemType Directory -Force -Path $settings.PC_AGENT_WORKSPACE | Out-Null

$desktopSettings = @{}
if (Test-Path $desktopEnvFile) {
    Get-Content $desktopEnvFile | ForEach-Object {
        if ($_ -match '^([^#=]+)=(.*)$') { $desktopSettings[$matches[1]] = $matches[2] }
    }
}
if (-not $desktopSettings.BRIDGE_URL) { $desktopSettings.BRIDGE_URL = "http://127.0.0.1:5050/mcp" }
$desktopSettings.MCP_AUTH_TOKEN = $settings.MCP_AUTH_TOKEN
if (-not $desktopSettings.GEMINI_HEADLESS) { $desktopSettings.GEMINI_HEADLESS = "true" }
if (-not $desktopSettings.APP_PORT) { $desktopSettings.APP_PORT = "5100" }
@(
    "BRIDGE_URL=$($desktopSettings.BRIDGE_URL)",
    "MCP_AUTH_TOKEN=$($desktopSettings.MCP_AUTH_TOKEN)",
    "GEMINI_HEADLESS=$($desktopSettings.GEMINI_HEADLESS)",
    "APP_PORT=$($desktopSettings.APP_PORT)"
) | Set-Content -Encoding ascii $desktopEnvFile

$template = Get-Content (Join-Path $project "userscript\tampermonkey_harness.user.js") -Raw
$configured = $template.Replace('"REPLACE_WITH_THE_SAME_LONG_RANDOM_TOKEN"', ('"' + $settings.MCP_AUTH_TOKEN + '"'))
$scriptPath = Join-Path $localDir "tampermonkey_harness.user.js"
Set-Content -Path $scriptPath -Value $configured -Encoding utf8

Write-Host "Setup complete."
Write-Host "Workspace: $($settings.PC_AGENT_WORKSPACE)"
Write-Host "Default app: run .\start.bat to open Bridge Desk."
Write-Host "Legacy Tampermonkey script:"
Write-Host $scriptPath
if (-not (Test-Path (Join-Path $desktopApp ".gemini-profile\Local State"))) {
    Write-Host "Sign in to Gemini in the dedicated Chrome profile now. Close Chrome and press Enter when setup asks."
    & $venvPython (Join-Path $desktopApp "app.py") --login
    if ($LASTEXITCODE -ne 0) { throw "Gemini sign-in setup failed. You can retry later with .\login.bat." }
} else {
    Write-Host "Gemini profile already exists. To sign in again, run .\login.bat."
}
