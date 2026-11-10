[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('verifySignature','inspectPayload','assertClean','install','verifyInstalled','uninstall','verifyRemoved')][string]$Phase,
  [Parameter(Mandatory=$true)][string]$Artifact,
  [Parameter(Mandatory=$true)][string]$LogDirectory,
  [switch]$LocalReview,
  [string]$InstallDirectory = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $LocalReview -and ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted')) { throw 'Requires a disposable hosted runner or explicit local review' }
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
try {
  $principal=New-Object Security.Principal.WindowsPrincipal($identity)
  if ($LocalReview -and $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Local review requires a Standard account' }
} finally { $identity.Dispose() }
$Artifact=(Resolve-Path -LiteralPath $Artifact).Path
$LogDirectory=(Resolve-Path -LiteralPath $LogDirectory).Path
$installer=New-Object -ComObject WindowsInstaller.Installer
$database=$installer.OpenDatabase($Artifact,0)
function Property([string]$Name) {
  $view=$database.OpenView(('SELECT `Value` FROM `Property` WHERE `Property` = '''+$Name+''''))
  $null=$view.Execute()
  try { $record=$view.Fetch(); if ($record) { return [string]$record.StringData(1) }; return '' }
  finally { $null=$view.Close() }
}
$version=Property 'ProductVersion'
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid version' }
$root=Join-Path $env:LOCALAPPDATA ('FinancialBrain\app\'+$version)
if ($InstallDirectory) { $root=[IO.Path]::GetFullPath($InstallDirectory) }
$menu=Join-Path ([Environment]::GetFolderPath('Programs')) ('Financial Brain\Financial Brain '+$version+' Setup.lnk')
$state=Join-Path $LogDirectory 'payload-smoke-state.json'
$sentinel=Join-Path $env:LOCALAPPDATA 'FinancialBrain\payload-smoke-owner-state.txt'
function Msi([string]$Verb) {
  $arguments=@($Verb,('"'+$Artifact+'"'),'/qn','/norestart','/l*v',('"'+(Join-Path $LogDirectory ($Phase+'.log'))+'"'))
  if ($Verb -eq '/i' -and $InstallDirectory) { $arguments += ('INSTALLFOLDER="'+$root+'"') }
  $info=New-Object Diagnostics.ProcessStartInfo
  $info.FileName=Join-Path $env:SystemRoot 'System32\msiexec.exe'
  $info.Arguments=$arguments -join ' '
  $info.UseShellExecute=$false; $info.CreateNoWindow=$true
  $info.EnvironmentVariables.Clear()
  foreach ($name in @('SystemRoot','WINDIR','COMSPEC','USERPROFILE','LOCALAPPDATA','APPDATA','TEMP','TMP')) {
    $value=[Environment]::GetEnvironmentVariable($name)
    if ($value) { $info.EnvironmentVariables[$name]=$value }
  }
  $info.EnvironmentVariables['PATH']=Join-Path $env:SystemRoot 'System32'
  $info.EnvironmentVariables['PATHEXT']='.COM;.EXE;.BAT;.CMD'
  $p=[Diagnostics.Process]::Start($info)
  $p.WaitForExit()
  Write-Output ('MSI_EXIT_CODE='+$p.ExitCode)
  if ($p.ExitCode -ne 0) { throw 'MSI operation failed' }
}
switch ($Phase) {
  'verifySignature' {
    $signature=Get-AuthenticodeSignature -LiteralPath $Artifact
    if ($signature.Status -ne 'Valid' -or -not $signature.TimeStamperCertificate -or $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=Financial Brain LLC(?:,|$)') { throw 'Invalid signed artifact' }
    Write-Output 'AUTHENTICODE_VALID=1'
  }
  'inspectPayload' { & (Join-Path $PSScriptRoot '..\windows\verify-msi.ps1') -MsiPath $Artifact }
  'assertClean' {
    if ((Test-Path -LiteralPath $root) -or (Test-Path -LiteralPath $menu) -or (Test-Path -LiteralPath $state) -or (Test-Path -LiteralPath $sentinel)) { throw 'Destination occupied' }
    [pscustomobject]@{root=$root;product=(Property 'ProductCode');attempted=$false} | ConvertTo-Json | Set-Content -LiteralPath $state
  }
  'install' {
    $checkpoint=Get-Content -Raw -LiteralPath $state | ConvertFrom-Json
    if ($checkpoint.root -cne $root -or $checkpoint.product -cne (Property 'ProductCode') -or $checkpoint.attempted) { throw 'Invalid install checkpoint' }
    $checkpoint.attempted=$true
    $checkpoint | ConvertTo-Json | Set-Content -LiteralPath $state
    [IO.Directory]::CreateDirectory((Split-Path -Parent $sentinel)) | Out-Null
    [IO.File]::WriteAllText($sentinel,'synthetic owner state')
    Msi '/i'
  }
  'verifyInstalled' {
    $shortcut=(New-Object -ComObject WScript.Shell).CreateShortcut($menu)
    $expectedTarget=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if ($shortcut.TargetPath -ine $expectedTarget -or $shortcut.WorkingDirectory.TrimEnd('\') -ine $root.TrimEnd('\') -or $shortcut.Arguments -cne ('-NoLogo -NoProfile -ExecutionPolicy Bypass -File "'+(Join-Path $root 'start-brain-setup.ps1')+'"')) { throw 'Shortcut mismatch' }
    # Launch the actual shortcut target headlessly. The installed script checks
    # every digest before private Node; no CLI setup or provider login occurs.
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=$shortcut.TargetPath
    $info.Arguments=$shortcut.Arguments+' -SelfCheck'
    $info.UseShellExecute=$false; $info.CreateNoWindow=$true
    $info.EnvironmentVariables.Clear()
    foreach ($name in @('SystemRoot','WINDIR','COMSPEC','USERPROFILE','LOCALAPPDATA','APPDATA','TEMP','TMP')) {
      $value=[Environment]::GetEnvironmentVariable($name)
      if ($value) { $info.EnvironmentVariables[$name]=$value }
    }
    $child=[Diagnostics.Process]::Start($info); $child.WaitForExit()
    if ($child.ExitCode -ne 0) { throw 'Installed launcher refused' }
    $probeHome=Join-Path $LogDirectory 'synthetic-version-profile'
    [IO.Directory]::CreateDirectory($probeHome) | Out-Null
    foreach ($name in @('USERPROFILE','HOME','LOCALAPPDATA','APPDATA','TEMP','TMP')) { $info.EnvironmentVariables[$name]=$probeHome }
    $info.EnvironmentVariables['BRAIN_NO_WRANGLER_LOGIN']='1'
    $info.FileName=Join-Path $root 'runtime\node.exe'
    $guard=([Uri](Join-Path $PSScriptRoot 'version-guard.mjs')).AbsoluteUri
    $info.Arguments='--import "'+$guard+'" "'+(Join-Path $root 'cli\brain.mjs')+'" --version'
    $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
    $probe=[Diagnostics.Process]::Start($info)
    $stdout=$probe.StandardOutput.ReadToEndAsync(); $stderr=$probe.StandardError.ReadToEndAsync()
    $probe.WaitForExit()
    if ($probe.ExitCode -ne 0 -or $stdout.Result.Trim() -cne $version) { throw 'Installed CLI version probe failed' }
    Get-ChildItem -LiteralPath $root -Recurse -File | ForEach-Object { [pscustomobject]@{path=$_.FullName.Substring($root.Length+1).Replace('\','/');size=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()} } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $LogDirectory 'installed-inventory.json')
    Write-Output ('BUNDLED_CLI_VERSION_VERIFIED='+$version)
  }
  'uninstall' {
    $checkpoint=Get-Content -Raw -LiteralPath $state | ConvertFrom-Json
    if ($checkpoint.root -cne $root -or $checkpoint.product -cne (Property 'ProductCode') -or -not $checkpoint.attempted) { throw 'Invalid removal checkpoint' }
    Msi '/x'
  }
  'verifyRemoved' {
    if ((Test-Path -LiteralPath $root) -or (Test-Path -LiteralPath $menu)) { throw 'Application remains' }
    if ((Get-Content -Raw -LiteralPath $sentinel) -cne 'synthetic owner state') { throw 'Owner state changed' }
    # Remove only the exact synthetic sentinel created by this rehearsal.
    Remove-Item -LiteralPath $sentinel
    Write-Output 'OWNER_STATE_PRESERVED=1'
  }
}
