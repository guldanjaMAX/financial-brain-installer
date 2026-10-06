# Runs inside the installing user's token after Windows Installer owns the one
# UAC prompt. The embedded prep remains per-user and refuses packaged shells.
[CmdletBinding()]
param()

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
  exit 0
}

$LocalRoot = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE "AppData\Local" }
$LogDir = Join-Path $LocalRoot "FinancialBrainMachinePrep"
$LogFile = Join-Path $LogDir "installer.log"
[IO.Directory]::CreateDirectory($LogDir) | Out-Null
[IO.File]::WriteAllText($LogFile, "")

function Write-SafeLog([string]$Line) {
  $safe = if ($env:USERPROFILE) { $Line.Replace($env:USERPROFILE, "~") } else { $Line }
  $safe | Tee-Object -FilePath $LogFile -Append
}

function Invoke-EmbeddedPowerShell([string]$ScriptPath, [string[]]$ScriptArguments) {
  $powerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $stdout = Join-Path $LogDir ("child-stdout-" + [Guid]::NewGuid().ToString("N") + ".tmp")
  $stderr = Join-Path $LogDir ("child-stderr-" + [Guid]::NewGuid().ToString("N") + ".tmp")
  $arguments = @(
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", ('"{0}"' -f $ScriptPath)
  ) + $ScriptArguments
  try {
    $process = Start-Process -FilePath $powerShell -ArgumentList $arguments -Wait -PassThru `
      -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    foreach ($path in @($stdout, $stderr)) {
      if (Test-Path -LiteralPath $path -PathType Leaf) {
        foreach ($line in [IO.File]::ReadAllLines($path)) { Write-SafeLog $line }
      }
    }
    return $process.ExitCode
  } finally {
    foreach ($path in @($stdout, $stderr)) {
      if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    }
  }
}

Write-SafeLog "INSTALLER_PROGRESS=1/4 Preparing tools and Financial Brain"
$prep = Join-Path $ScriptDir "prep-windows.ps1"
$prepStatus = Invoke-EmbeddedPowerShell $prep @("--real")
Write-SafeLog "PREP_EXIT_CODE=$prepStatus"
if ($prepStatus -eq 0) {
  Write-SafeLog "INSTALLER_PROGRESS=2/4 Tool and CLI checks completed"
  Write-SafeLog "SETUP_LAUNCH_DECISION_REACHED=1"
  $powerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $setup = Join-Path $ScriptDir "start-brain-setup.ps1"
  $setupArguments = @(
    "-NoLogo", "-NoProfile", "-NoExit", "-ExecutionPolicy", "Bypass",
    "-File", ('"{0}"' -f $setup)
  )
  Start-Process -FilePath $powerShell -ArgumentList $setupArguments | Out-Null
  Write-SafeLog "SETUP_WINDOW_STARTED=1"
} else {
  Write-SafeLog "INSTALLER_PROGRESS=2/4 Prep needs attention; setup was not opened"
  Write-SafeLog "SETUP_LAUNCH_DECISION_REACHED=1 skipped=prep_failed"
}

Write-SafeLog "INSTALLER_PROGRESS=3/4 Opening the local Claude handoff"
$handoff = Join-Path $ScriptDir "handoff\handoff-windows.ps1"
$handoffStatus = Invoke-EmbeddedPowerShell $handoff @()
Write-SafeLog "INSTALLER_HANDOFF_EXIT_CODE=$handoffStatus"
Write-SafeLog "INSTALLER_PROGRESS=4/4 Installer handoff completed"

# The MSI transaction installed the reviewed launcher successfully. Prep
# readiness remains separately visible through PREP_EXIT_CODE and Claude.
exit 0
