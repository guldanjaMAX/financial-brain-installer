# Run on a Windows build host. No extra runtime is installed on the client.
[CmdletBinding()]
param([string]$Destination = '')
Set-StrictMode -Version 2.0
if (-not $Destination) { $Destination = Join-Path $PSScriptRoot 'dist' }
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'setup.ps1') -FunctionsOnly
Assert-SetupPins
$csc=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) { throw 'Framework csc.exe is absent' }
$null=New-Item -ItemType Directory -Path $Destination -Force
$exe=Join-Path $Destination 'FinancialBrainSetup-0.4.36.exe'
if (Test-Path -LiteralPath $exe) { throw 'Build destination already exists; preserve it and use a fresh destination' }
& $csc /nologo /target:exe /platform:x64 /optimize+ (('/out:')+$exe) (('/win32manifest:')+(Join-Path $PSScriptRoot 'app.manifest')) (('/resource:')+(Join-Path $PSScriptRoot 'setup.ps1')+',setup.ps1') (Join-Path $PSScriptRoot 'FinancialBrainSetup.cs')
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $exe)) { throw 'Launcher compilation failed' }
$version=[Diagnostics.FileVersionInfo]::GetVersionInfo($exe)
if ($version.FileVersion -cne '0.4.36.0' -or $version.CompanyName -cne 'Financial Brain LLC' -or $version.ProductName -cne 'Financial Brain Setup') { throw 'Launcher version information is wrong' }
# Confirm the compiled resource is exactly the reviewed source before signing.
$assembly=[Reflection.Assembly]::LoadFile([IO.Path]::GetFullPath($exe))
$stream=$assembly.GetManifestResourceStream('setup.ps1')
if (-not $stream) { throw 'Embedded setup resource missing' }
$sha=[Security.Cryptography.SHA256]::Create()
try {
    $embedded=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()
    if ($embedded -cne (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'setup.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()) { throw 'Embedded resource differs from source' }
} finally { $stream.Dispose(); $sha.Dispose() }
