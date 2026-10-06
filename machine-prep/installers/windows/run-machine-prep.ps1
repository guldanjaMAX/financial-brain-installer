# Runs inside the installing user's token from the per-user MSI.
[CmdletBinding()]
param([string]$TestChildPath = "")

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$CurrentVersion = if ($env:MACHINE_PREP_OS_VERSION_OVERRIDE) {
  [Version]$env:MACHINE_PREP_OS_VERSION_OVERRIDE
} else {
  [Environment]::OSVersion.Version
}

Write-Output "OS_DECISION_REACHED=1 current=$CurrentVersion minimum=10.0"
if ($CurrentVersion.Major -lt 10) {
  [Console]::Error.WriteLine("REFUSED Windows 10 or newer is required; no machine preparation started")
  exit 2
}
if ($env:MACHINE_PREP_INSTALLER_TEST_MODE -eq "1") {
  Write-Output "INSTALLER_TEST_GATE_REACHED=1"
}

$LocalRoot = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE "AppData\Local" }
$LogDir = Join-Path $LocalRoot "FinancialBrainMachinePrep"
$LogFile = Join-Path $LogDir "installer.log"
[IO.Directory]::CreateDirectory($LogDir) | Out-Null
[IO.File]::WriteAllText($LogFile, "")

function Write-SafeLog([string]$Line) {
  if ($Line -notmatch '^(LOG_SCHEMA_DECISION_REACHED=1|INSTALLER_PROGRESS=|PREP_EXIT_CODE=|SETUP_LAUNCH_DECISION_REACHED=|SETUP_WINDOW_STARTED=|INSTALLER_HANDOFF_EXIT_CODE=|INSTALLER_HANDOFF_STARTED=)') {
    throw "non-schema installer log event refused"
  }
  [IO.File]::AppendAllText($LogFile, "$Line`r`n")
  [Console]::Out.WriteLine($Line)
}

function Invoke-EmbeddedPowerShell([string]$ScriptPath, [string[]]$ScriptArguments, [bool]$RunActualProcess = $false) {
  if ($env:MACHINE_PREP_INSTALLER_TEST_MODE -eq "1" -and -not $RunActualProcess) {
    $code = if ($ScriptPath -like "*prep-windows.ps1") { [int]$env:MACHINE_PREP_TEST_PREP_EXIT } else { [int]$env:MACHINE_PREP_TEST_HANDOFF_EXIT }
    return [pscustomobject]@{ ExitCode = $code }
  }
  $powerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $powerShell
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $quotedScript = $ScriptPath.Replace('"', '""')
  $info.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$quotedScript`" " + ($ScriptArguments -join ' ')
  $allowedPath = @(
    (Join-Path $env:SystemRoot "System32")
    (Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0")
    (Join-Path $env:USERPROFILE ".local\bin")
    (Join-Path $env:LOCALAPPDATA "FinancialBrainTools\npm")
    (Join-Path $env:LOCALAPPDATA "Programs\Git\cmd")
  )
  if ($env:ProgramFiles) {
    $allowedPath += Join-Path $env:ProgramFiles "nodejs"
    $allowedPath += Join-Path $env:ProgramFiles "Git\cmd"
  }
  $info.EnvironmentVariables.Clear()
  foreach ($pair in @{
    SystemRoot = $env:SystemRoot; USERPROFILE = $env:USERPROFILE; HOME = $env:USERPROFILE
    LOCALAPPDATA = $env:LOCALAPPDATA; APPDATA = $env:APPDATA; TEMP = $env:TEMP; TMP = $env:TMP
    PATH = ($allowedPath -join ";"); PATHEXT = ".COM;.EXE;.BAT;.CMD"
    BRAIN_NO_WRANGLER_LOGIN = "1"
  }.GetEnumerator()) { if ($null -ne $pair.Value) { $info.EnvironmentVariables[$pair.Key] = [string]$pair.Value } }
  $process = [Diagnostics.Process]::Start($info)
  try {
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdoutTask, $stderrTask))
    return [pscustomobject]@{ ExitCode = [int]$process.ExitCode }
  } finally {
    $process.Dispose()
  }
}

if ($TestChildPath) {
  if ($env:MACHINE_PREP_INSTALLER_TEST_MODE -ne "1") { [Console]::Error.WriteLine("REFUSED test child outside test mode"); exit 2 }
  $testResult = Invoke-EmbeddedPowerShell $TestChildPath @() $true
  Write-Output "REDIRECTED_PROCESS_DECISION_REACHED=1 exit=$($testResult.ExitCode)"
  exit $testResult.ExitCode
}

Write-SafeLog "LOG_SCHEMA_DECISION_REACHED=1"
Write-SafeLog "INSTALLER_PROGRESS=1/4 Preparing tools and Financial Brain"
$prep = Join-Path $ScriptDir "prep-windows.ps1"
$prepResult = Invoke-EmbeddedPowerShell $prep @("--real")
Write-SafeLog "PREP_EXIT_CODE=$($prepResult.ExitCode)"
if ($prepResult.ExitCode -eq 0) {
  Write-SafeLog "INSTALLER_PROGRESS=2/4 Tool and CLI checks completed"
  Write-SafeLog "SETUP_LAUNCH_DECISION_REACHED=1"
  $powerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $setup = Join-Path $ScriptDir "start-brain-setup.ps1"
  $setupArguments = @(
    "-NoLogo", "-NoProfile", "-NoExit", "-ExecutionPolicy", "Bypass",
    "-File", ('"{0}"' -f $setup)
  )
  if ($env:MACHINE_PREP_INSTALLER_TEST_MODE -eq "1") {
    Write-Output "TEST_SETUP_ATTEMPTS=1"
    $setupExit = [int]$env:MACHINE_PREP_TEST_SETUP_EXIT
  } else {
    try { Start-Process -FilePath $powerShell -ArgumentList $setupArguments -ErrorAction Stop | Out-Null; $setupExit = 0 } catch { $setupExit = 1 }
  }
  if ($setupExit -ne 0) { Write-SafeLog "SETUP_WINDOW_STARTED=0"; exit $setupExit }
  Write-SafeLog "SETUP_WINDOW_STARTED=1"
} else {
  Write-SafeLog "INSTALLER_PROGRESS=2/4 Prep needs attention; setup was not opened"
  Write-SafeLog "SETUP_LAUNCH_DECISION_REACHED=1 skipped=prep_failed"
  [Console]::Out.WriteLine("OWNER ACTION: install any missing prerequisite from its official signed installer, then reopen Run Financial Brain Machine Prep from the Start Menu.")
  if ($env:MACHINE_PREP_INSTALLER_TEST_MODE -eq "1") { Write-Output "TEST_SETUP_ATTEMPTS=0" }
  exit $prepResult.ExitCode
}

Write-SafeLog "INSTALLER_PROGRESS=3/4 Opening the local Claude handoff"
$handoff = Join-Path $ScriptDir "handoff\handoff-windows.ps1"
$handoffResult = Invoke-EmbeddedPowerShell $handoff @()
Write-SafeLog "INSTALLER_HANDOFF_EXIT_CODE=$($handoffResult.ExitCode)"
if ($handoffResult.ExitCode -ne 0) { Write-SafeLog "INSTALLER_HANDOFF_STARTED=0"; exit $handoffResult.ExitCode }
Write-SafeLog "INSTALLER_HANDOFF_STARTED=1"
Write-SafeLog "INSTALLER_PROGRESS=4/4 Installer handoff completed"
exit 0
