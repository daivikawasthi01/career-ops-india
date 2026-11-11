# Apply for Windows: one command to set up and run the helper behind the browser extension.
#
#   apply.cmd install      first time: installs what is needed, starts the helper, opens Chrome's extension page
#   apply.cmd doctor       what is ready and what is missing
#   apply.cmd start | stop | restart | status
#   apply.cmd scan         look for jobs from the terminal (the Jobs tab has the same button)
#   apply.cmd update       get the latest version and refresh what it needs
#   apply.cmd reset-pair   let a different Chrome profile use this helper
#
# Add -DryRun to see what a command would do without doing it.
param(
  [Parameter(Position = 0)][string]$Command = "help",
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo = (Resolve-Path (Join-Path $Here "..\..")).Path
$Py = Join-Path $Here ".venv\Scripts\python.exe"
$ScanPy = Join-Path $Repo "tools\.venv-jobspy\Scripts\python.exe"
$Port = 8765

function Say($t) { Write-Host $t }
function Step($n, $t) { Write-Host ""; Write-Host "[$n] $t" }
function Ok($t) { Write-Host "    done: $t" }
function Note($t) { Write-Host "    NOTE: $t" -ForegroundColor Yellow }
function Die($t) { Write-Host ""; Write-Host "Could not finish: $t" -ForegroundColor Red; exit 1 }
function Run($exe, [string[]]$arguments, $cwd = $null) {
  if ($DryRun) { Write-Host "    would run: $exe $($arguments -join ' ')"; return $true }
  if ($cwd) { Push-Location $cwd }
  try { & $exe @arguments | Out-Host; return ($LASTEXITCODE -eq 0) } finally   # Out-Host keeps the tool's output from being mistaken for the result { if ($cwd) { Pop-Location } }
}
function Have($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function RefreshPath { $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User") }

function FindPython {
  # a Python 3.10 or newer: the "py" launcher first, then python on the PATH
  foreach ($cand in @(@("py", "-3.13"), @("py", "-3.12"), @("py", "-3.11"), @("py", "-3.10"), @("python"))) {
    if (-not (Have $cand[0])) { continue }
    try {
      $a = @($cand | Select-Object -Skip 1) + @("-c", "import sys; print(sys.executable) if sys.version_info >= (3, 10) else sys.exit(1)")
      $exe = & $cand[0] @a 2>$null
      if ($LASTEXITCODE -eq 0 -and $exe) { return $exe.Trim() }
    } catch { }
  }
  return $null
}

function WaitForServer {
  if ($DryRun) { return $true }
  for ($i = 0; $i -lt 15; $i++) {
    if (ServerUp) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}
function ServerUp {
  try { Invoke-WebRequest -Uri "http://127.0.0.1:$Port/status" -UseBasicParsing -TimeoutSec 2 | Out-Null; return $true }
  catch { if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) { return $true }; return $false }
}

function Install {
  Say "Setting up Apply. You can leave this running; it asks nothing."

  Step "1/6" "Checking the Windows package manager (winget)"
  if (-not (Have winget)) {
    Say ""
    Say "    Apply uses winget to install a few tools. It comes with current Windows 10 and 11."
    Say "    Open the Microsoft Store, search for 'App Installer', update it, then run this again."
    exit 1
  }
  Ok "winget found"

  Step "2/6" "Installing the tools Apply uses"
  $PyExe = FindPython
  if (-not $PyExe) {
    Run "winget" @("install", "-e", "--id", "Python.Python.3.12", "--accept-package-agreements", "--accept-source-agreements") | Out-Null
    RefreshPath; $PyExe = FindPython
  }
  if (-not $PyExe -and $DryRun) { $PyExe = "python" }
  if (-not $PyExe) { Die "no Python 3.10 or newer. Install it from https://www.python.org/downloads/, tick 'Add python.exe to PATH', then run this again." }
  if (-not (Have node)) { Run "winget" @("install", "-e", "--id", "OpenJS.NodeJS.LTS", "--accept-package-agreements", "--accept-source-agreements") | Out-Null; RefreshPath }
  # Optional: reading the text of your CV PDF (poppler) and building tailored CV PDFs (tectonic). Scoop installs both.
  if (-not ((Have pdftotext) -and (Have tectonic))) {
    if (Have scoop) { Run "scoop" @("install", "poppler", "tectonic") | Out-Null }
    else { Note "poppler and tectonic are not installed. Without them Apply cannot read the text of your CV PDF (you can paste it instead) or tailor CV PDFs. To add them later: install Scoop from https://scoop.sh, then run: scoop install poppler tectonic" }
  }
  Ok "tools ready"

  Step "3/6" "Preparing the helper"
  if (-not (Test-Path $Py)) { if (-not (Run $PyExe @("-m", "venv", (Join-Path $Here ".venv")))) { Die "could not create the Python environment" } }
  Run $Py @("-m", "pip", "install", "--quiet", "--upgrade", "pip") | Out-Null
  if (-not (Run $Py @("-m", "pip", "install", "--quiet", "-r", (Join-Path $Here "requirements.txt")))) { Die "could not install the helper's Python packages" }
  if (-not (Run "npm" @("install", "--no-audit", "--no-fund", "--loglevel=error") $Repo)) { Note "npm install did not finish; job search may not work" }
  if (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path (Join-Path $Here "data"), (Join-Path $Repo "data"), (Join-Path $Repo "output\resumes") | Out-Null
    $envFile = Join-Path $Repo ".env"; if (-not (Test-Path $envFile)) { Set-Content -Path $envFile -Value "# Your keys. The Apply panel writes this file for you." }
    $facts = Join-Path $Here "facts.yml"; if (-not (Test-Path $facts)) { Set-Content -Path $facts -Value "# Your details. Fill them in from the Apply panel." }
  }
  Run $Py @((Join-Path $Here "orchestrator.py"), "init") | Out-Null
  Ok "helper ready"

  Step "4/6" "Installing the job search tools (the biggest download)"
  if (-not (Test-Path $ScanPy)) { if (-not (Run $PyExe @("-m", "venv", (Join-Path $Repo "tools\.venv-jobspy")))) { Note "could not create the job search environment" } }
  if ((Test-Path $ScanPy) -or $DryRun) {
    if (-not (Run $ScanPy @("-m", "pip", "install", "--quiet", "-r", (Join-Path $Repo "tools\requirements.txt")))) { Note "the job search tools did not install; the Jobs tab will say so" }
  }
  Ok "job search tools ready"

  Step "5/6" "Starting the helper (it also starts when you log in)"
  if (-not (Run $Py @((Join-Path $Here "orchestrator.py"), "install-service", "--load"))) { Die "could not start the helper" }
  if (WaitForServer) { Ok "the helper is running" } else { Note "the helper did not answer yet; try apply.cmd status in a minute" }

  Step "6/6" "Adding the extension to Chrome"
  $browser = Join-Path $Here "browser"
  if (-not $DryRun) { Set-Clipboard -Value $browser }
  Say ""
  Say "    Chrome needs you for this last part, once:"
  Say "      1. In the page that opens, turn on 'Developer mode' (top right)."
  Say "      2. Press 'Load unpacked' and choose this folder (it is already copied; paste it into the folder box with Ctrl+V):"
  Say "           $browser"
  Say "      3. Pin Apply with the puzzle icon, then click it. The panel walks you through the rest."
  Say ""
  if (-not $DryRun) {
    try { Start-Process "chrome" "chrome://extensions" } catch { Say "    Open Chrome and go to chrome://extensions" }
  }
}

function HelperProcesses { Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*orchestrator.py*serve*" } }
function Start-Helper {
  if (ServerUp) { Say "Apply is running."; return }
  Run $Py @((Join-Path $Here "orchestrator.py"), "install-service", "--load") | Out-Null
  if (WaitForServer) { Say "Apply is running." } else { Say "Apply did not start. Run apply.cmd doctor." }
}
function Stop-Helper {
  if ($DryRun) { Say "    would stop the helper"; return }
  HelperProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Say "Apply is stopped. It starts again at your next login, or with apply.cmd start."
}

switch ($Command) {
  "install"    { Install }
  "doctor"     { & $Py (Join-Path $Here "orchestrator.py") doctor }
  "start"      { Start-Helper }
  "stop"       { Stop-Helper }
  "restart"    { Stop-Helper | Out-Null; Start-Sleep -Seconds 1; Start-Helper }
  "status"     { if (ServerUp) { Say "Apply is running." } else { Say "Apply is not running. Run apply.cmd start." } }
  "scan"       { if (-not (Test-Path $ScanPy)) { Die "the job search tools are not installed. Run apply.cmd install" }; Run $ScanPy @("tools\mine.py", "--no-slow") $Repo | Out-Null }
  "update"     {
    Say "Getting the latest version"
    if (-not (Run "git" @("pull", "--ff-only") $Repo)) { Die "could not update. If you changed files in this folder, ask for help before pulling." }
    Run $Py @("-m", "pip", "install", "--quiet", "-r", (Join-Path $Here "requirements.txt")) | Out-Null
    Run "npm" @("install", "--no-audit", "--no-fund", "--loglevel=error") $Repo | Out-Null
    if (Test-Path $ScanPy) { Run $ScanPy @("-m", "pip", "install", "--quiet", "-r", (Join-Path $Repo "tools\requirements.txt")) | Out-Null }
    Stop-Helper | Out-Null; Start-Sleep -Seconds 1; Start-Helper
    Say "Updated. In Chrome, open chrome://extensions and press the reload arrow on Apply."
  }
  "reset-pair" { Stop-Helper | Out-Null; Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Here "data\server.json"); Start-Helper; Say "Done. Open Apply in the Chrome profile you want to use." }
  default      { Get-Content $MyInvocation.MyCommand.Path | Select-Object -Skip 1 -First 10 | ForEach-Object { $_ -replace "^# ?", "" } }
}
