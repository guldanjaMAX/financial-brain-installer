# Opens the supported Claude Desktop Code deep link, then falls back to the
# installed Claude Code CLI only when Windows has no registered Claude handler.
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PromptPath = Join-Path $ScriptDir "message-windows.txt"
$UrlPath = Join-Path $ScriptDir "handoff-windows.url"

if (-not (Test-Path -LiteralPath $PromptPath -PathType Leaf)) { throw "REFUSED missing Claude handoff message" }
if (-not (Test-Path -LiteralPath $UrlPath -PathType Leaf)) { throw "REFUSED missing Claude handoff URL" }
$url = ([IO.File]::ReadAllText($UrlPath)).Trim()
if (-not $url.StartsWith("claude://code/new?q=", [StringComparison]::Ordinal)) { throw "REFUSED invalid Claude handoff URL" }

Write-Output "HANDOFF_DECISION_REACHED=1"
if ($env:MACHINE_PREP_HANDOFF_TEST_MODE -eq "desktop") {
  Write-Output "HANDOFF_DESKTOP_URL=$url"
  return
}
if ($env:MACHINE_PREP_HANDOFF_TEST_MODE -eq "fallback") {
  Write-Output "HANDOFF_FALLBACK_CLI=1"
  return
}

$handler = Get-Item -LiteralPath "Registry::HKEY_CLASSES_ROOT\claude\shell\open\command" -ErrorAction SilentlyContinue
if ($handler) {
  Start-Process $url
  Write-Output "HANDOFF_DESKTOP_OPENED=1"
  return
}

Write-Output "HANDOFF_FALLBACK_CLI=1"
$claude = Join-Path $env:USERPROFILE ".local\bin\claude.exe"
if (-not (Test-Path -LiteralPath $claude -PathType Leaf)) {
  throw "Claude Code is not ready. Send the installer log from LocalAppData\FinancialBrainMachinePrep\installer.log to support."
}
$escapedClaude = $claude.Replace("'", "''")
$escapedPrompt = $PromptPath.Replace("'", "''")
$command = "& '$escapedClaude' ([IO.File]::ReadAllText('$escapedPrompt'))"
Start-Process "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList @(
  "-NoLogo", "-NoProfile", "-NoExit", "-Command", $command
)
