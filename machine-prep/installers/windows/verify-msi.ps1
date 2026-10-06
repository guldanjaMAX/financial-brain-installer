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
  "start-brain-setup.ps1",
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

$shortcutArguments = @(Read-Column 'SELECT `Arguments` FROM `Shortcut`')
if (-not ($shortcutArguments | Where-Object { $_ -like "*ExecutionPolicy Bypass*run-machine-prep.ps1*" })) {
  throw "MSI Start Menu launcher does not use the reviewed process-only policy bypass"
}
$directories = @(Read-Column 'SELECT `Directory` FROM `Directory`')
if ($directories -notcontains "LocalAppDataFolder" -or $directories -contains "ProgramFiles64Folder") {
  throw "MSI is not confined to the current user's LocalAppData"
}
$launchConditions = @(Read-Column 'SELECT `Condition` FROM `LaunchCondition`')
if (-not ($launchConditions -contains "Installed OR VersionNT64 >= 1000")) {
  throw "MSI does not carry the Windows 10 x64 refusal gate"
}

Write-Output "MSI_CONTENTS_VERIFIED=$($files.Count)"
Write-Output "MSI_OS_GATE_VERIFIED=1"
Write-Output "MSI_POLICY_SCOPE_VERIFIED=process_only"
Write-Output "MSI_SCOPE_VERIFIED=per_user"
Write-Output "MSI_VISIBLE_LAUNCHER_VERIFIED=1"
