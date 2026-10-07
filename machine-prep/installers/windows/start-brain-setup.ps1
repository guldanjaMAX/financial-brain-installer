# Runs the installed CLI in a visible owner-controlled PowerShell window.
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$localRoot = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE "AppData\Local" }
$brain = Join-Path $localRoot "FinancialBrain\brain.cmd"
$manifest = Join-Path $env:USERPROFILE "Financial Brain\brain.manifest.json"

if (-not (Test-Path -LiteralPath $brain -PathType Leaf)) {
  Write-Output "Financial Brain setup could not start because the installed CLI is missing."
  Write-Output "Send the installer log under LocalAppData\FinancialBrainMachinePrep to support."
  Read-Host "Press Enter to close this window"
  exit 2
}

Write-Output "Financial Brain setup"
Write-Output "The private prompts in this window belong to the Brain CLI. Do not copy credentials into chat."
Write-Output ""
& $brain setup $manifest
$status = $LASTEXITCODE
Write-Output ""
Write-Output "Setup exited with code $status. This window can stay open while Claude helps with the next owner action."
Read-Host "Press Enter to close this window"
exit $status
