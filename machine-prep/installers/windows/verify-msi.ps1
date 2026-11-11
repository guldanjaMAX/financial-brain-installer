[CmdletBinding()]
param([Parameter(Mandatory=$true,Position=0)][string]$MsiPath, [string]$PayloadRoot = '')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $installer.OpenDatabase((Resolve-Path -LiteralPath $MsiPath).Path, 0)
function Read-Rows([string]$Table,[string[]]$Columns) {
  $quoted = ($Columns | ForEach-Object { '`' + $_ + '`' }) -join ', '
  $view = $database.OpenView(('SELECT {0} FROM `{1}`' -f $quoted,$Table))
  $null = $view.Execute()
  try {
    while ($record = $view.Fetch()) {
      $row = @{}
      for ($i=0; $i -lt $Columns.Count; $i++) { $row[$Columns[$i]] = [string]$record.StringData($i+1) }
      [pscustomobject]$row
    }
  } finally {
    $null = $view.Close()
  }
}
$properties = @{}
Read-Rows 'Property' @('Property','Value') | ForEach-Object { $properties[$_.Property]=$_.Value }
if ($properties['ALLUSERS'] -or $properties['Manufacturer'] -cne 'Financial Brain LLC') { throw 'Unexpected MSI scope' }
$tables = @(Read-Rows '_Tables' @('Name') | ForEach-Object { $_.Name })
if ('CustomAction' -in $tables -or 'Upgrade' -in $tables -or 'Environment' -in $tables -or 'ServiceInstall' -in $tables) { throw 'Unexpected lifecycle action' }
$directories = @{}
Read-Rows 'Directory' @('Directory','Directory_Parent','DefaultDir') | ForEach-Object {
  $_.DefaultDir=(($_.DefaultDir -split ':')[0] -split '\|')[-1]
  $directories[$_.Directory]=$_
}
if (-not $directories.ContainsKey('LocalAppDataFolder') -or $directories.ContainsKey('ProgramFiles64Folder')) { throw 'Unexpected directory root' }
if ($directories['OWNERROOT'].Directory_Parent -cne 'LocalAppDataFolder' -or $directories['OWNERROOT'].DefaultDir -cne 'FinancialBrain' -or $directories['APPROOT'].Directory_Parent -cne 'OWNERROOT' -or $directories['APPROOT'].DefaultDir -cne 'app' -or $directories['INSTALLFOLDER'].Directory_Parent -cne 'APPROOT' -or $directories['INSTALLFOLDER'].DefaultDir -cne $properties['ProductVersion']) { throw 'Unexpected application boundary' }
function App-Path([string]$directory) {
  $parts = @(); $seen = @{}
  while ($directory -cne 'INSTALLFOLDER') {
    if (-not $directories.ContainsKey($directory) -or $seen.ContainsKey($directory)) { throw 'File outside version folder' }
    $seen[$directory]=$true
    $row=$directories[$directory]
    $parts = @(($row.DefaultDir -split ':')[0] -split '\|' | Select-Object -Last 1) + $parts
    $directory=$row.Directory_Parent
  }
  return ($parts -join '/')
}
$registry = @(Read-Rows 'Registry' @('Registry','Root','Key','Name','Value','Component_'))
$components = @{}
Read-Rows 'Component' @('Component','Directory_','Attributes','KeyPath') | ForEach-Object {
  $components[$_.Component]=$_
  $component=$_
  $rows=@($registry | Where-Object { $_.Component_ -ceq $component.Component })
  if ($rows.Count -ne 1 -or $rows[0].Root -ne '1' -or $rows[0].Key -cne ('Software\FinancialBrain\Payload\'+$properties['ProductVersion']) -or $rows[0].Registry -cne $component.KeyPath -or -not ([int]$component.Attributes -band 4)) { throw 'Unexpected component keypath' }
}
$files = @(Read-Rows 'File' @('File','Component_','FileName','FileSize'))
$paths=@($files | ForEach-Object {
  $prefix=App-Path $components[$_.Component_].Directory_
  $name=($_.FileName -split '\|')[-1]
  if ($prefix) { "$prefix/$name" } else { $name }
})
foreach ($required in @('runtime/node.exe','runtime/LICENSE','cli.tgz','cli/brain.mjs','cli/package.json','launcher.mjs','payload.mjs','start-brain-setup.ps1','payload-receipt.json')) {
  if ($required -cnotin $paths) { throw 'Missing required payload entry' }
}
if ($PayloadRoot) {
  $receipt=Get-Content -Raw -LiteralPath (Join-Path $PayloadRoot 'payload-receipt.json') | ConvertFrom-Json
  $expected=@($receipt.inventory | Where-Object kind -eq 'file' | ForEach-Object path) + @('payload-receipt.json')
  if ((($paths | Sort-Object) -join "`n") -cne (($expected | Sort-Object) -join "`n")) { throw 'Unexpected exact MSI inventory' }
  if ($receipt.version -cne $properties['ProductVersion']) { throw 'Payload version mismatch' }
}
$removals=@(Read-Rows 'RemoveFile' @('FileName','DirProperty','InstallMode'))
foreach ($removal in $removals) {
  if ($removal.FileName -or $removal.InstallMode -ne '2' -or -not $directories.ContainsKey($removal.DirProperty)) { throw 'Uninstall must remove only empty directories' }
}
$shortcuts=@(Read-Rows 'Shortcut' @('Target','Arguments','WkDir'))
if ($shortcuts.Count -ne 1 -or $shortcuts[0].Target -cne '[System64Folder]WindowsPowerShell\v1.0\powershell.exe' -or $shortcuts[0].Arguments -cne '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "[INSTALLFOLDER]start-brain-setup.ps1"' -or $shortcuts[0].WkDir -cne 'INSTALLFOLDER') { throw 'Unexpected setup shortcut' }
Write-Output ('MSI_CONTENTS_VERIFIED='+$files.Count)
Write-Output 'MSI_SCOPE_VERIFIED=per_user'
Write-Output 'MSI_VISIBLE_LAUNCHER_VERIFIED=1'
