# Windows PowerShell 5.1. Only prerequisite preparation and verified kit handoff.
[CmdletBinding()]
param([switch]$FunctionsOnly)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$script:NodeVersion = '24.22.3'
$script:NodeUrl = 'https://nodejs.org/dist/v24.22.3/node-v24.22.3-x64.msi'
$script:NodeSha256 = '4a1ab5bdec5434bae58efae6c3e5077a011f6f1e76d2b47b7b10af043f7db545'
# Offline source proves this version's ZIP only. MAIN must verify the MSI row at:
# https://nodejs.org/dist/v24.22.3/SHASUMS256.txt and confirm current v24 LTS.
$script:GitVersion = '2.56.1'
$script:GitUrl = 'https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1/Git-2.56.1-64-bit.exe'
$script:GitSha256 = 'c330c72e10b408cc39994bfefdb63542b0d93d21699325c3e0bd874af8a5a559'
$script:ClaudeUrl = 'https://claude.ai/install.ps1'
$script:BundleUrl = 'https://financialbrain.ai/download/financial-brain-0.4.36-68d4d041f6e581d6.zip'
$script:BundleSha256 = '68d4d041f6e581d6609e3eab253a5cb43b3b8284233e5c525d09f63fac7fe59f'
$script:BundleBytes = 8527362
$script:BundleFiles = @('1-Start-here.cmd','2-Create-my-Brain.cmd','3-Connect-Google.cmd','4-Connect-Claude.cmd','SHA256SUMS','START-HERE.txt','What each file does.txt','brain-installer-0.4.36-runtime-identity.json','brain-installer-0.4.36.tgz','company-google.mjs','pre-session-check.mjs','start.ps1','steps.ps1')
$script:Stage = 'computer-check'
$script:Next = 'Keep this window open and ask your installer to review this step before trying again.'
$script:NativeExit = $null
$script:Work = $null
function Write-Step([int]$Number,[string]$Stage,[string]$Line,[string]$Next) {
    $script:Stage=$Stage; $script:Next=$Next
    Write-Host ('Step '+$Number+' of 5: '+$Line)
}
function Assert-Pin([string]$Url,[string]$Hash,[string[]]$Hosts) {
    if ($Url -match 'PIN_ME_' -or $Hash -cnotmatch '^[0-9a-f]{64}$') { throw 'PIN_REQUIRED' }
    $uri=[Uri]$Url
    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -cne 'https' -or $Hosts -cnotcontains $uri.Host -or $uri.UserInfo -or $uri.Port -ne 443) { throw 'PIN_HOST' }
}
function Assert-SetupPins {
    Assert-Pin $script:NodeUrl $script:NodeSha256 @('nodejs.org')
    Assert-Pin $script:GitUrl $script:GitSha256 @('github.com')
    Assert-Pin $script:BundleUrl $script:BundleSha256 @('financialbrain.ai')
    if ($script:NodeVersion -cnotmatch '^24\.\d+\.\d+$' -or $script:NodeUrl -cne ('https://nodejs.org/dist/v'+$script:NodeVersion+'/node-v'+$script:NodeVersion+'-x64.msi')) { throw 'NODE_PIN_VERSION' }
    if ($script:GitVersion -match 'PIN_ME_' -or $script:GitUrl -notmatch ('/Git-'+[regex]::Escape($script:GitVersion)+'-64-bit\.exe$')) { throw 'GIT_PIN_VERSION' }
}
function Assert-PlainPath([string]$Path) {
    if ($Path -notmatch '^[A-Za-z]:[\\/]' -or $Path -match '[";\r\n]') { throw 'LOCAL_PATH_REQUIRED' }
    $cursor=[IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'REPARSE_PATH' }
        }
        $parent=Split-Path -Path $cursor -Parent
        if ($parent -eq $cursor) { break }; $cursor=$parent
    }
}
function Assert-Platform {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -cne 'AMD64') { throw 'WINDOWS_X64_REQUIRED' }
    if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'POWERSHELL_51_REQUIRED' }
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    try { $principal=New-Object Security.Principal.WindowsPrincipal($identity); if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'STANDARD_USER_REQUIRED' } } finally { $identity.Dispose() }
    Assert-PlainPath $env:LOCALAPPDATA; Assert-PlainPath $env:USERPROFILE
}
function Refresh-Path {
    $parts=@([Environment]::GetEnvironmentVariable('Path','Machine'),[Environment]::GetEnvironmentVariable('Path','User'),$env:Path,(Join-Path $env:USERPROFILE '.local\bin'),(Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd'))
    $env:Path=($parts | Where-Object { $_ }) -join ';'
}
function Get-NodeState {
    $command=Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) { return @{Present=$false; Ready=$false; Major=0; Arch=''} }
    $value=@(& $command.Source -p 'JSON.stringify({major:Number(process.versions.node.split(String.fromCharCode(46))[0]),arch:process.arch})' 2>$null)
    if ($LASTEXITCODE -ne 0 -or $value.Count -ne 1) { throw 'NODE_UNREADABLE' }
    $facts=$value[0] | ConvertFrom-Json
    return @{Present=$true;Ready=([int]$facts.major -ge 22 -and $facts.arch -ceq 'x64');Major=[int]$facts.major;Arch=[string]$facts.arch}
}
function Test-Git {
    $command=Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) { return $false }
    $null=& $command.Source --version 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'GIT_UNREADABLE' }; return $true
}
function Find-Claude {
    $native=Join-Path $env:USERPROFILE '.local\bin\claude.exe'
    if (Test-Path -LiteralPath $native -PathType Leaf) { return $native }
    $found=Get-Command claude.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.Source }; return $null
}
function Save-Https([string]$Url,[string]$Destination,[string[]]$AllowedHosts) {
    [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
    $current=[Uri]$Url
    for ($redirect=0; $redirect -le 5; $redirect++) {
        if ($current.Scheme -cne 'https' -or $AllowedHosts -cnotcontains $current.Host -or $current.UserInfo -or $current.Port -ne 443) { throw 'DOWNLOAD_HOST' }
        $request=[Net.HttpWebRequest]::Create($current)
        $request.AllowAutoRedirect=$false; $request.Timeout=120000; $request.ReadWriteTimeout=120000
        $response=$request.GetResponse()
        try {
            $status=[int]$response.StatusCode
            if ($status -in @(301,302,303,307,308)) { $current=New-Object Uri($current,$response.Headers['Location']); continue }
            if ($status -ne 200) { throw 'DOWNLOAD_STATUS' }
            $inputStream=$response.GetResponseStream()
            $outputStream=[IO.File]::Open($Destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
            try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
            return
        } finally { $response.Close() }
    }
    throw 'DOWNLOAD_REDIRECTS'
}
function Get-VerifiedDownload([string]$Url,[string]$Destination,[string]$Hash,[long]$Bytes,[string[]]$Hosts) {
    Assert-Pin $Url $Hash $Hosts
    Save-Https $Url $Destination $Hosts
    if ($Bytes -gt 0 -and (Get-Item -LiteralPath $Destination).Length -ne $Bytes) { throw 'DOWNLOAD_SIZE' }
    if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Hash) { throw 'DOWNLOAD_HASH' }
}
function Get-WorkFolder {
    if (-not $script:Work) {
        $base=Join-Path $env:LOCALAPPDATA 'FinancialBrainSetup'
        Assert-PlainPath $base
        $null=New-Item -ItemType Directory -Path $base -Force
        $script:Work=Join-Path $base ('attempt-'+[Guid]::NewGuid().ToString('N'))
        $null=New-Item -ItemType Directory -Path $script:Work
    }
    return $script:Work
}
function Install-Node {
    $msi=Join-Path (Get-WorkFolder) 'node.msi'
    Get-VerifiedDownload $script:NodeUrl $msi $script:NodeSha256 0 @('nodejs.org')
    Write-Host 'Your client clicks Yes on the Windows prompt (remote control cannot click it)'
    Write-Host 'Installer: give control back to your client now.'
    Write-Host 'Client: stop sharing and recording before any administrator sign-in; the client or administrator completes it privately.'
    $process=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') -ArgumentList ('/i "'+$msi+'" /passive /norestart') -Verb RunAs -Wait -PassThru
    $script:NativeExit=$process.ExitCode
    if ($process.ExitCode -eq 3010 -or $process.ExitCode -eq 1641) { return $true }
    if ($process.ExitCode -ne 0) { throw 'NODE_INSTALL' }
    Refresh-Path; return $false
}
function Install-Git {
    $exe=Join-Path (Get-WorkFolder) 'git.exe'
    Get-VerifiedDownload $script:GitUrl $exe $script:GitSha256 0 @('github.com','release-assets.githubusercontent.com','objects.githubusercontent.com')
    # MAIN must prove /CURRENTUSER support on the selected signed release.
    $process=Start-Process -FilePath $exe -ArgumentList '/CURRENTUSER /VERYSILENT /NORESTART /SP-' -Wait -PassThru
    $script:NativeExit=$process.ExitCode
    if ($process.ExitCode -ne 0) { throw 'GIT_INSTALL' }; Refresh-Path
}
function Install-Claude {
    # Official native PowerShell bootstrap, isolated so its exit cannot skip our checks.
    # https://code.claude.com/docs/en/setup#install-claude-code (not fetched in this lane).
    $powershell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $command='& { $ErrorActionPreference = ''Stop''; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; try { Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression } catch { exit 1 } }'
    $process=Start-Process -FilePath $powershell -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -Command "'+$command+'"') -NoNewWindow -Wait -PassThru
    $script:NativeExit=$process.ExitCode
    if ($process.ExitCode -ne 0) { throw 'CLAUDE_INSTALL' }; Refresh-Path
}
function Assert-ClientTree([string]$Expected,[string]$Actual) {
    Assert-PlainPath $Actual
    $entries=@(Get-ChildItem -LiteralPath $Actual -Force)
    if ($entries.Count -ne $script:BundleFiles.Count) { throw 'EXISTING_KIT_CHANGED' }
    foreach ($file in $entries) {
        if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $script:BundleFiles -cnotcontains $file.Name) { throw 'EXISTING_KIT_CHANGED' }
        $other=Join-Path $Expected $file.Name
        if ($file.Length -ne (Get-Item -LiteralPath $other).Length -or (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath $other -Algorithm SHA256).Hash) { throw 'EXISTING_KIT_CHANGED' }
    }
}
function Get-ClientBundle {
    $work=Get-WorkFolder
    $zip=Join-Path $work 'client.zip'
    Get-VerifiedDownload $script:BundleUrl $zip $script:BundleSha256 $script:BundleBytes @('financialbrain.ai')
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive=[IO.Compression.ZipFile]::OpenRead($zip)
    try {
        $seen=New-Object 'System.Collections.Generic.HashSet[string]' -ArgumentList ([StringComparer]::OrdinalIgnoreCase)
        if ($archive.Entries.Count -ne $script:BundleFiles.Count) { throw 'ZIP_COUNT' }
        foreach ($entry in $archive.Entries) {
            if ($script:BundleFiles -cnotcontains $entry.FullName -or -not $seen.Add($entry.FullName)) { throw 'ZIP_PATH' }
        }
    } finally { $archive.Dispose() }
    $fresh=Join-Path $work 'verified-kit'
    [IO.Compression.ZipFile]::ExtractToDirectory($zip,$fresh)
    $root=Join-Path $env:LOCALAPPDATA 'FinancialBrainSetup\0.4.36'
    Assert-PlainPath $root
    $null=New-Item -ItemType Directory -Path $root -Force
    $kit=Join-Path $root 'kit'
    if (Test-Path -LiteralPath $kit) { Assert-ClientTree $fresh $kit }
    else { Move-Item -LiteralPath $fresh -Destination $kit }
    # Reverify against a freshly extracted pinned ZIP before changing zone marks.
    # If moved, the kit itself is the fresh extraction; no existing files were reused.
    foreach ($name in $script:BundleFiles) { Unblock-File -LiteralPath (Join-Path $kit $name) }
    return $kit
}
function Open-NumberOne([string]$kit) {
    $launcher=Join-Path $kit '1-Start-here.cmd'
    $null=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') -ArgumentList ('/d /c ""'+$launcher+'""') -WorkingDirectory $kit -WindowStyle Normal -PassThru
}
function Invoke-Setup {
    Assert-Platform; Refresh-Path
    Write-Step 1 'node' 'checking Node.js (about 2 minutes if installation is needed)' 'Ask your installer to check Node.js, then reopen Setup (about 5 minutes).'
    $node=Get-NodeState
    if (-not $node.Ready) {
        if ($node.Present -and $node.Major -ge 24) { throw 'NODE_INCOMPATIBLE' }
        if (Install-Node) { $script:Next='Restart Windows when convenient, then reopen Setup (about 5 minutes).'; throw 'REBOOT_REQUIRED' }
        if (-not (Get-NodeState).Ready) { throw 'NODE_NOT_READY' }
    }
    Write-Step 2 'git' 'checking Git (about 1 minute if installation is needed)' 'Ask your installer to check Git, then reopen Setup (about 5 minutes).'
    if (-not (Test-Git)) { Install-Git; if (-not (Test-Git)) { throw 'GIT_NOT_READY' } }
    Write-Step 3 'claude' 'checking Claude Code (about 2 minutes if installation is needed)' 'Ask your installer to check Claude Code, then reopen Setup (about 5 minutes).'
    if (-not (Find-Claude)) { Install-Claude; if (-not (Find-Claude)) { throw 'CLAUDE_NOT_READY' } }
    Write-Step 4 'kit' 'downloading and checking your setup files (about 1 minute)' 'Keep the setup folder and ask your installer to review the download before retrying (about 5 minutes).'
    $kit=Get-ClientBundle
    Write-Step 5 'handoff' 'opening number 1 in a new window (about 5 to 10 minutes)' 'Ask your installer to open number 1 in the setup folder (about 1 minute).'
    Open-NumberOne $kit
}
function Write-StopNote {
    Write-Host "I'm finishing this with your installer."
    Write-Host ('Next: '+$script:Next)
    $lines=@('Financial Brain setup stopped.',('Stage: '+$script:Stage),'Launcher result: stopped (1)',('Last captured child exit: '+$(if ($null -eq $script:NativeExit) {'not available'} else {[string]$script:NativeExit})),('Next: '+$script:Next),'Share only this note with your installer if you choose.')
    foreach ($base in @([Environment]::GetFolderPath('DesktopDirectory'),$env:TEMP)) {
        try {
            Assert-PlainPath $base
            $folder=Join-Path $base ('FinancialBrain-Help-'+[Guid]::NewGuid().ToString('N'))
            $null=New-Item -ItemType Directory -Path $folder
            [IO.File]::WriteAllLines((Join-Path $folder 'SEND-TO-INSTALLER.txt'),$lines,[Text.UTF8Encoding]::new($false))
            Write-Host ('Share only SEND-TO-INSTALLER.txt in '+$folder+' if you choose (about 1 minute).'); return
        } catch { }
    }
    Write-Host 'A support note could not be saved; tell your installer which numbered step stopped.'
}
if ($FunctionsOnly) { return }
try {
    $Host.UI.RawUI.WindowTitle='Financial Brain Setup'
    Invoke-Setup
    exit 0
} catch {
    Write-StopNote
    $null=Read-Host 'Press Enter when your installer has read this window'
    exit 1
}
