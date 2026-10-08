[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('verifySignature', 'inspectPayload', 'assertClean', 'install', 'verifyInstalled', 'uninstall', 'verifyRemoved')]
  [string]$Phase,
  [Parameter(Mandatory = $true)][string]$Artifact,
  [Parameter(Mandatory = $true)][string]$LogDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Installation requires a disposable GitHub-hosted runner'
}
$Artifact = (Resolve-Path -LiteralPath $Artifact).Path
$InstallRoot = Join-Path $env:LOCALAPPDATA 'Financial Brain Machine Prep'
$MenuRoot = Join-Path ([Environment]::GetFolderPath('Programs')) 'Financial Brain Machine Prep'
$ShortcutPath = Join-Path $MenuRoot 'Run Financial Brain Machine Prep.lnk'
$RegistryPath = 'HKCU:\Software\FinancialBrain\MachinePrep'
$RegistryMarkers = @{
  MachinePrepScripts = 'scriptsInstalled'
  ClaudeHandoff = 'handoffInstalled'
  MachinePrepShortcut = 'installed'
}
$ExpectedFiles = @('prep-windows.ps1', 'run-machine-prep.ps1', 'start-brain-setup.ps1', 'UNINSTALL.txt',
  'handoff/handoff-windows.ps1', 'handoff/message-windows.txt', 'handoff/handoff-windows.url')
$StateFile = Join-Path $LogDirectory 'windows-state.json'
$Sentinels = @((Join-Path $env:LOCALAPPDATA 'FinancialBrain'), (Join-Path $env:USERPROFILE '.brain'),
  (Join-Path $env:ProgramFiles 'Financial Brain Machine Prep'),
  (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'Financial Brain Machine Prep'))

function Assert-EqualSet($Actual, $Expected) {
  if ((@($Actual | Sort-Object) -join "`n") -cne (@($Expected | Sort-Object) -join "`n")) { throw 'Unexpected MSI inventory' }
}
function Assert-PerUserTables([object[]]$Components, [object[]]$RegistryRows, [object[]]$RemovalRows) {
  Write-Output 'PER_USER_TABLE_DECISION_REACHED=1'
  Assert-EqualSet @($Components | ForEach-Object { $_.Component }) @($RegistryMarkers.Keys)
  if ($RegistryRows.Count -ne $RegistryMarkers.Count) { throw 'Unexpected MSI registry write count' }
  if ($RemovalRows.Count -ne $Components.Count) { throw 'Unexpected MSI removal scope count' }
  foreach ($component in $Components) {
    $rows = @($RegistryRows | Where-Object { $_.Component_ -ceq $component.Component })
    # MSI Component.KeyPath refers to Registry.Registry when bit 4 is set.
    # Matching counts alone would accept a file key path or a shared marker.
    if ($rows.Count -ne 1 -or $rows[0].Root -ne '1' -or $rows[0].Key -cne 'Software\FinancialBrain\MachinePrep' -or
        $rows[0].Name -cne $RegistryMarkers[$component.Component] -or $rows[0].Value -cne '#1' -or
        ([int]$component.Attributes -band 4) -ne 4 -or $component.KeyPath -cne $rows[0].Registry) {
      throw 'Unexpected MSI per-user registry KeyPath'
    }
    $removal = @($RemovalRows | Where-Object { $_.Component_ -ceq $component.Component })
    if ($removal.Count -ne 1 -or $removal[0].FileName -or
        $removal[0].DirProperty -cne $component.Directory_ -or $removal[0].InstallMode -ne '2') {
      throw 'Unexpected MSI removal scope'
    }
  }
}
function Assert-Absent([string]$Path) {
  if (Test-Path -LiteralPath $Path) { throw 'Smoke destination is occupied' }
}
function Open-Database {
  $script:Installer = New-Object -ComObject WindowsInstaller.Installer
  $script:Database = $script:Installer.OpenDatabase($Artifact, 0)
}
function Read-Rows([string]$Table, [string[]]$Columns) {
  $quoted = ($Columns | ForEach-Object { '`' + $_ + '`' }) -join ', '
  $view = $script:Database.OpenView(('SELECT {0} FROM `{1}`' -f $quoted, $Table))
  # Windows Installer COM results would otherwise join this function's output
  # as extra rows (the same defect verify-msi.ps1 had).
  $null = $view.Execute()
  try {
    while ($record = $view.Fetch()) {
      $row = @{}
      for ($index = 0; $index -lt $Columns.Count; $index++) { $row[$Columns[$index]] = [string]$record.StringData($index + 1) }
      [pscustomobject]$row
    }
  } finally { $null = $view.Close() }
}
function Read-Properties {
  $values = @{}
  Read-Rows 'Property' @('Property', 'Value') | ForEach-Object { $values[$_.Property] = $_.Value }
  return $values
}
function Get-Inventory([string]$Root) {
  if ((Get-Item -LiteralPath $Root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point at installed root' }
  $items = @(Get-ChildItem -LiteralPath $Root -Recurse -Force)
  if (@($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count -gt 0) { throw 'Reparse point in installed payload' }
  return @($items | ForEach-Object {
    $relative = $_.FullName.Substring($Root.Length + 1).Replace('\', '/')
    if ($_.PSIsContainer) { "$relative/" } else { $relative }
  })
}
function Invoke-Msi([string]$Verb, [string]$LogName) {
  $log = Join-Path $LogDirectory $LogName
  $operation = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') -Wait -PassThru -ArgumentList @(
    $Verb, ('"{0}"' -f $Artifact), '/qn', '/norestart', '/L*v', ('"{0}"' -f $log)
  )
  Write-Output "MSI_EXIT_CODE=$($operation.ExitCode)"
  # A reboot request is not a clean smoke pass; retain the log for diagnosis.
  if ($operation.ExitCode -ne 0) { throw "MSI operation failed: $($operation.ExitCode)" }
}

switch ($Phase) {
  'verifySignature' {
    $signature = Get-AuthenticodeSignature -LiteralPath $Artifact
    if ($signature.Status -ne 'Valid' -or -not $signature.TimeStamperCertificate) { throw 'MSI signature or timestamp is invalid' }
    # Match the organization RDN, never a substring in the CN or issuer.
    if ($signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=Financial Brain LLC(?:,|$)') { throw 'Unexpected MSI signer organization' }
    Write-Output 'AUTHENTICODE_VALID=1'
    Write-Output 'SIGNER_ORGANIZATION_VERIFIED=1'
  }
  'inspectPayload' {
    Open-Database
    $properties = Read-Properties
    if ($properties['ALLUSERS'] -or $properties['ProductVersion'] -cne '0.2.0' -or
        $properties['Manufacturer'] -cne 'Financial Brain LLC') { throw 'Unexpected MSI scope or product metadata' }
    $tables = @(Read-Rows '_Tables' @('Name') | ForEach-Object { $_.Name })
    $allowedTables = @('Property', 'Directory', 'Feature', 'FeatureComponents', 'Component', 'File', 'Media', 'Registry',
      'Shortcut', 'RemoveFile', 'Upgrade', 'LaunchCondition', 'MsiFileHash', '_Validation',
      'AdminExecuteSequence', 'AdminUISequence', 'AdvtExecuteSequence', 'InstallExecuteSequence', 'InstallUISequence')
    foreach ($table in $tables) {
      if ($table -notin $allowedTables) { throw 'Unexpected MSI table outside the shell contract' }
    }
    $directories = @{}
    Read-Rows 'Directory' @('Directory', 'Directory_Parent', 'DefaultDir') | ForEach-Object { $directories[$_.Directory] = $_ }
    foreach ($key in $directories.Keys) {
      if ($key -notin @('TARGETDIR', 'LocalAppDataFolder', 'ProgramMenuFolder', 'INSTALLFOLDER', 'HANDOFFFOLDER', 'ApplicationProgramsFolder', 'System64Folder')) { throw 'Unreviewed MSI directory' }
    }
    foreach ($row in @(
      @('INSTALLFOLDER', 'LocalAppDataFolder', 'Financial Brain Machine Prep'),
      @('HANDOFFFOLDER', 'INSTALLFOLDER', 'handoff'),
      @('ApplicationProgramsFolder', 'ProgramMenuFolder', 'Financial Brain Machine Prep')
    )) {
      $directory = $directories[$row[0]]
      if (-not $directory -or $directory.Directory_Parent -cne $row[1] -or ($directory.DefaultDir -split '\|')[-1] -cne $row[2]) { throw 'MSI destination escaped the reviewed directory tree' }
    }
    foreach ($key in @('LocalAppDataFolder', 'ProgramMenuFolder')) {
      if (-not $directories[$key] -or $directories[$key].Directory_Parent -cne 'TARGETDIR') { throw 'Unexpected MSI standard directory ancestry' }
      if ($properties.ContainsKey($key)) { throw 'MSI overrides a standard user directory' }
    }
    $components = @{}
    $componentRows = @(Read-Rows 'Component' @('Component', 'Directory_', 'Attributes', 'KeyPath'))
    $componentRows | ForEach-Object { $components[$_.Component] = $_.Directory_ }
    Assert-EqualSet @($components.Keys) @('MachinePrepScripts', 'ClaudeHandoff', 'MachinePrepShortcut')
    if ($components['MachinePrepScripts'] -cne 'INSTALLFOLDER' -or $components['ClaudeHandoff'] -cne 'HANDOFFFOLDER' -or
        $components['MachinePrepShortcut'] -cne 'ApplicationProgramsFolder') { throw 'Unexpected MSI component destination' }
    $payload = @(Read-Rows 'File' @('Component_', 'FileName') | ForEach-Object {
      $name = ($_.FileName -split '\|')[-1]
      if ($_.Component_ -eq 'ClaudeHandoff') { "handoff/$name" }
      elseif ($_.Component_ -eq 'MachinePrepScripts') { $name }
      else { throw 'File attached to an unreviewed component' }
    })
    Assert-EqualSet $payload $ExpectedFiles
    $registry = @(Read-Rows 'Registry' @('Registry', 'Root', 'Key', 'Name', 'Value', 'Component_'))
    $shortcuts = @(Read-Rows 'Shortcut' @('Directory_', 'Target', 'Arguments', 'WkDir'))
    if ($shortcuts.Count -ne 1 -or $shortcuts[0].Directory_ -cne 'ApplicationProgramsFolder' -or
        $shortcuts[0].Target -cne '[System64Folder]WindowsPowerShell\v1.0\powershell.exe' -or
        $shortcuts[0].Arguments -cne '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "[INSTALLFOLDER]run-machine-prep.ps1"' -or
        $shortcuts[0].WkDir -cne 'INSTALLFOLDER') { throw 'Unexpected MSI shortcut' }
    $removals = @(Read-Rows 'RemoveFile' @('Component_', 'FileName', 'DirProperty', 'InstallMode'))
    Assert-PerUserTables $componentRows $registry $removals
    Write-Output "PAYLOAD_FILES_VERIFIED=$($payload.Count)"
  }
  'assertClean' {
    foreach ($path in @($InstallRoot, $MenuRoot, $RegistryPath) + $Sentinels) { Assert-Absent $path }
    Open-Database
    $product = (Read-Properties)['ProductCode']
    $products = @($script:Installer.Products | ForEach-Object { [string]$_ })
    if ($product -in $products) { throw 'MSI is already registered' }
    @{ product = $product } | ConvertTo-Json | Set-Content -LiteralPath $StateFile
    Write-Output 'INSTALL_SCOPE=current_user'
  }
  'install' { Invoke-Msi '/i' 'msi-install.log' }
  'verifyInstalled' {
    Assert-EqualSet (Get-Inventory $InstallRoot) (@('handoff/') + $ExpectedFiles)
    Assert-EqualSet (Get-Inventory $MenuRoot) @('Run Financial Brain Machine Prep.lnk')
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($ShortcutPath)
    $expectedTarget = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if ($shortcut.TargetPath -ine $expectedTarget -or $shortcut.WorkingDirectory -ine $InstallRoot -or
        $shortcut.Arguments -cne ('-NoLogo -NoProfile -ExecutionPolicy Bypass -File "{0}\run-machine-prep.ps1"' -f $InstallRoot)) { throw 'Installed launcher readback differs' }
    $installedMarkers = Get-ItemProperty -LiteralPath $RegistryPath
    foreach ($marker in $RegistryMarkers.Values) {
      if ($installedMarkers.$marker -ne 1) { throw 'Installed registry marker missing' }
    }
    Open-Database
    $state = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
    if ($script:Installer.ProductState($state.product) -ne 5) { throw 'MSI product is not installed' }
    $hashes = @{}
    Read-Rows 'MsiFileHash' @('File_', 'HashPart1', 'HashPart2', 'HashPart3', 'HashPart4') | ForEach-Object { $hashes[$_.File_] = $_ }
    $fileRows = @(Read-Rows 'File' @('File', 'Component_', 'FileName'))
    Assert-EqualSet @($hashes.Keys) @($fileRows | ForEach-Object { $_.File })
    foreach ($file in $fileRows) {
      $relative = ($file.FileName -split '\|')[-1]
      if ($file.Component_ -eq 'ClaudeHandoff') { $relative = 'handoff\' + $relative }
      $actualHash = $script:Installer.FileHash((Join-Path $InstallRoot $relative), 0)
      for ($part = 1; $part -le 4; $part++) {
        if ($actualHash.IntegerData($part) -ne [int]$hashes[$file.File].("HashPart$part")) { throw 'Installed file differs from signed MSI hash' }
      }
    }
    # Parse the actual installed launcher, then execute only installed help.
    # The visible launcher starts network preparation and is outside this gate.
    $tokens = $null; $parseErrors = $null
    [Management.Automation.Language.Parser]::ParseFile((Join-Path $InstallRoot 'run-machine-prep.ps1'), [ref]$tokens, [ref]$parseErrors) | Out-Null
    if ($parseErrors.Count -ne 0) { throw 'Installed launcher syntax is invalid' }
    & $expectedTarget -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'prep-windows.ps1') --help
    if ($LASTEXITCODE -ne 0) { throw 'Installed preparation help failed' }
    foreach ($path in $Sentinels) { Assert-Absent $path }
    Write-Output 'INSTALLED_LAUNCHERS_VERIFIED=1'
  }
  'uninstall' {
    if (-not (Test-Path -LiteralPath $StateFile)) { throw 'No clean-target ownership proof' }
    Open-Database
    $state = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
    # A failed MSI install can roll back completely. Do not turn 1605 into a
    # successful uninstall; prove absent state in verifyRemoved instead.
    if ($script:Installer.ProductState($state.product) -ne -1) { Invoke-Msi '/x' 'msi-uninstall.log' }
  }
  'verifyRemoved' {
    foreach ($path in @($InstallRoot, $MenuRoot, $RegistryPath) + $Sentinels) { Assert-Absent $path }
    Open-Database
    $state = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
    if ($script:Installer.ProductState($state.product) -ne -1) { throw 'MSI remains registered after uninstall' }
    Write-Output 'UNINSTALL_VERIFIED=1'
  }
}
