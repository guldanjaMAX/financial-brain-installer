[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$MsiPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$resolved = (Resolve-Path -LiteralPath $MsiPath).Path
$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $installer.OpenDatabase($resolved, 0)

function Read-Column([string]$Sql) {
  $view = $database.OpenView($Sql)
  $view.Execute()
  $values = @()
  while ($record = $view.Fetch()) {
    $values += [string]$record.StringData(1)
  }
  $view.Close()
  return $values
}

$files = @(Read-Column 'SELECT `FileName` FROM `File`' | ForEach-Object { ($_ -split '\|')[-1] })
$expected = @(
  "prep-windows.ps1",
  "run-machine-prep.ps1",
  "UNINSTALL.txt",
  "handoff-windows.ps1",
  "message-windows.txt",
  "handoff-windows.url"
)
foreach ($name in $expected) {
  if ($name -notin $files) { throw "MSI payload is missing $name" }
}
if ($files.Count -ne $expected.Count) {
  throw "MSI payload has $($files.Count) files; expected exactly $($expected.Count)"
}

$customTargets = @(Read-Column 'SELECT `Target` FROM `CustomAction`')
if (-not ($customTargets | Where-Object { $_ -like "*ExecutionPolicy Bypass*run-machine-prep.ps1*" })) {
  throw "MSI custom action does not use the reviewed process-only policy bypass"
}
$launchConditions = @(Read-Column 'SELECT `Condition` FROM `LaunchCondition`')
if (-not ($launchConditions -contains "Installed OR VersionNT64 >= 1000")) {
  throw "MSI does not carry the Windows 10 x64 refusal gate"
}

Write-Output "MSI_CONTENTS_VERIFIED=$($files.Count)"
Write-Output "MSI_OS_GATE_VERIFIED=1"
Write-Output "MSI_POLICY_SCOPE_VERIFIED=process_only"
