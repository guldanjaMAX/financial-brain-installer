param(
  [Parameter(Mandatory = $true)]
  [string]$ExpectedSha
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

function Stop-Rehearsal([string]$Message) {
  [Console]::Error.WriteLine("STOP: $Message")
  exit 1
}

function Resolve-Directory([string]$Path) {
  try {
    $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    return [System.IO.Path]::GetFullPath($resolved).TrimEnd([char[]]@('\', '/'))
  } catch {
    Stop-Rehearsal "the reviewed repository folder could not be verified"
  }
}

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  Stop-Rehearsal "this launcher is only for a Windows PowerShell rehearsal"
}

if ($ExpectedSha -cnotmatch '^[0-9a-f]{40}$') {
  Stop-Rehearsal "the technician's exact 40-character lowercase commit SHA is required"
}

try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  $isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch {
  Stop-Rehearsal "Windows could not verify that this is a normal, non-administrator PowerShell window"
}
if ($isAdministrator) {
  Stop-Rehearsal "this PowerShell window is running as Administrator. Close it and open PowerShell normally from the Start menu"
}

$repositoryRoot = Resolve-Directory (Join-Path $PSScriptRoot "..")
$currentDirectory = Resolve-Directory (Get-Location).Path
if (-not [System.String]::Equals($currentDirectory, $repositoryRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  Stop-Rehearsal "run this command from the reviewed repository's top-level folder, not a default or unrelated folder"
}

$git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue
if (-not $git) {
  Stop-Rehearsal "Git is not available in this PowerShell window"
}

$gitRootOutput = @(& $git.Source rev-parse --show-toplevel 2>$null)
$gitRootExit = $LASTEXITCODE
if ($gitRootExit -ne 0 -or $gitRootOutput.Count -ne 1) {
  Stop-Rehearsal "the current folder is not one reviewed Git checkout"
}
$gitRoot = Resolve-Directory ([string]$gitRootOutput[0])
if (-not [System.String]::Equals($gitRoot, $repositoryRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  Stop-Rehearsal "the launcher file and current Git checkout do not have the same repository root"
}

$actualShaOutput = @(& $git.Source rev-parse HEAD 2>$null)
$actualShaExit = $LASTEXITCODE
if ($actualShaExit -ne 0 -or $actualShaOutput.Count -ne 1 -or ([string]$actualShaOutput[0]).Trim() -cne $ExpectedSha) {
  Stop-Rehearsal "this checkout is not the exact commit supplied by the technician"
}

$dirty = @(& $git.Source status --porcelain=v1 --untracked-files=all 2>$null)
$dirtyExit = $LASTEXITCODE
if ($dirtyExit -ne 0 -or $dirty.Count -ne 0) {
  Stop-Rehearsal "this checkout has local changes. Use a new, clean checkout of the reviewed commit"
}

$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
if (-not $node) {
  Stop-Rehearsal "Node.js is not available. Install Node.js 22 or newer, then open a new normal PowerShell window"
}
$nodeVersionOutput = @(& $node.Source -p "process.versions.node" 2>$null)
$nodeVersionExit = $LASTEXITCODE
if ($nodeVersionExit -ne 0 -or $nodeVersionOutput.Count -ne 1) {
  Stop-Rehearsal "the Node.js version could not be verified"
}
try {
  $nodeVersion = [System.Version]([string]$nodeVersionOutput[0])
} catch {
  Stop-Rehearsal "the Node.js version could not be verified"
}
if ($nodeVersion.Major -lt 22) {
  Stop-Rehearsal "Node.js $nodeVersion is too old. This rehearsal needs Node.js 22 or newer"
}

$rehearsal = Join-Path $repositoryRoot "scripts\onboarding-sandbox.mjs"
if (-not (Test-Path -LiteralPath $rehearsal -PathType Leaf)) {
  Stop-Rehearsal "the reviewed local rehearsal program is missing from this checkout"
}

Write-Host ""
Write-Host "Financial Brain safe local rehearsal"
Write-Host "  Exact reviewed commit: confirmed"
Write-Host "  Normal non-administrator PowerShell: confirmed"
Write-Host "  Local-only synthetic data: confirmed"
Write-Host ""
Write-Host "The first run may download one additional small set of public UI packages."
Write-Host "That preparation uses no account credential and can be quiet for several minutes."
Write-Host "Please leave this window open until the local address appears."
Write-Host ""
Write-Host "When you are finished, close the browser tab, return here, and press Control-C once."
Write-Host "This launcher starts Node directly, so the ready rehearsal does not use the npm.cmd batch prompt."
Write-Host ""

& $node.Source $rehearsal
$rehearsalExit = $LASTEXITCODE
if ($rehearsalExit -ne 0) {
  Stop-Rehearsal "the local rehearsal did not finish cleanly. Send the technician only the short final error"
}

Write-Host "Local rehearsal stopped. No account was connected and no live Brain was changed."
