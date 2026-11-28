# Windows PowerShell 5.1. Disposable hosted runner only. No owner setup or login.
[CmdletBinding()]
param()
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$SmokeRoot = Join-Path $env:RUNNER_TEMP 'setup-exe-smoke'
$null = New-Item -ItemType Directory -Path $SmokeRoot -Force
$SmokeLog = Join-Path $SmokeRoot 'smoke.log'
$null = New-Item -ItemType File -Path $SmokeLog -Force
$SmokeResults = @{}
$SmokeNativeExit = $null
$SmokeKit = $null
$SmokeRun = $null
$SmokeNode = Join-Path $env:ProgramFiles 'nodejs\node.exe'
$SmokeGit = Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd\git.exe'
$SmokeClaude = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
$SmokeSource = Join-Path $PSScriptRoot 'setup.ps1'
$SmokeExe = Join-Path $SmokeRoot 'FinancialBrainSetup-0.4.36.exe'
$SmokeBasePath = @($env:SystemRoot, (Join-Path $env:SystemRoot 'System32'), (Join-Path $env:SystemRoot 'System32\Wbem'), (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0')) -join ';'
function Write-SmokeLog([string]$Line) {
    Write-Host $Line
    Add-Content -LiteralPath $SmokeLog -Value $Line -Encoding UTF8
}
function Assert-Smoke($Condition, [string]$Code) { if (-not $Condition) { throw $Code } }
function Write-SmokeResult([string]$Name, [bool]$Passed, $Watch, [string]$Code) {
    $SmokeResults[$Name] = $Passed
    $status = if ($Passed) { 'PASS' } else { 'FAIL' }
    $line = '{0} {1} utc={2} seconds={3} code={4}' -f $status, $Name, ([DateTime]::UtcNow.ToString('o')), ([Math]::Round($Watch.Elapsed.TotalSeconds, 3)), $Code
    Write-SmokeLog $line
}
function Invoke-SmokeStage([string]$Name, [string[]]$Needs, [scriptblock]$Body) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $script:SmokeNativeExit = $null
    $script:NativeExit = $null
    foreach ($need in $Needs) {
        if (-not $SmokeResults.ContainsKey($need) -or -not $SmokeResults[$need]) {
            Write-SmokeResult $Name $false $watch ('BLOCKED_' + $need.Replace('-', '_').ToUpperInvariant())
            return
        }
    }
    try {
        # Dot source into this function so returned local values stay available to the body.
        # Persistent results deliberately use script scope. Shipped functions are unchanged.
        $null = . $Body
        Write-SmokeResult $Name $true $watch 'OK'
    } catch {
        $code = 'UNEXPECTED_' + $_.Exception.GetType().Name
        if ($_.Exception.Message -cmatch '^[A-Z][A-Z0-9_]{2,80}$') { $code = $_.Exception.Message }
        if ($null -ne $SmokeNativeExit) { $code += ('_EXIT_' + $SmokeNativeExit) }
        elseif ($null -ne $script:NativeExit) { $code += ('_CHILD_EXIT_' + $script:NativeExit) }
        # Never print raw exception text, child output, environment or transcripts.
        Write-SmokeResult $Name $false $watch $code
    }
}
function Set-SmokePath([switch]$Node, [switch]$Git, [switch]$Claude) {
    $parts = @($SmokeBasePath)
    if ($Node) { $parts += Split-Path -Parent $SmokeNode }
    if ($Git) { $parts += Split-Path -Parent $SmokeGit }
    if ($Claude) { $parts += Split-Path -Parent $SmokeClaude }
    $env:Path = $parts -join ';'
}
function Assert-SmokeNative([string]$Code) {
    $script:SmokeNativeExit = $LASTEXITCODE
    Assert-Smoke ($LASTEXITCODE -eq 0) $Code
}
Write-SmokeLog ('RUN source_commit=' + $env:GITHUB_SHA)
Write-SmokeLog 'LIMITATION disposable hosted x64 runner, elevated account; standard-user UAC and desktop interaction require a real PC.'
Write-SmokeLog 'LIMITATION machine Git and other runner software remain installed; process PATH is rebuilt before each stage.'
Write-SmokeLog 'LIMITATION live versioned EXE and kit are pinned; the official Claude bootstrap is vendor-current.'

# Source must be checked and loaded at script scope, not in a stage function.
$watch = [Diagnostics.Stopwatch]::StartNew()
try {
    Assert-Smoke ($PSVersionTable.PSVersion.Major -eq 5 -and $PSVersionTable.PSVersion.Minor -eq 1 -and [Environment]::Is64BitProcess -and $env:PROCESSOR_ARCHITECTURE -ceq 'AMD64') 'SMOKE_POWERSHELL_X64'
    Assert-Smoke ($env:BRAIN_NO_WRANGLER_LOGIN -ceq '1' -and $env:HOME.StartsWith($env:RUNNER_TEMP, [StringComparison]::OrdinalIgnoreCase)) 'SMOKE_SCRATCH_HOME'
    $tokens = $null; $errors = $null
    $null = [Management.Automation.Language.Parser]::ParseFile($SmokeSource, [ref]$tokens, [ref]$errors)
    Assert-Smoke ($errors.Count -eq 0) 'SMOKE_SOURCE_PARSER'
    # Review identity tolerates checkout line endings and BOM only. The signed
    # resource comparison below is strict byte equality, including those bytes.
    $reviewText = [IO.File]::ReadAllText($SmokeSource).Replace("`r`n", "`n")
    $reviewSha = [Security.Cryptography.SHA256]::Create()
    try { $reviewHash = ([BitConverter]::ToString($reviewSha.ComputeHash([Text.Encoding]::UTF8.GetBytes($reviewText)))).Replace('-', '').ToLowerInvariant() } finally { $reviewSha.Dispose() }
    Assert-Smoke ($reviewHash -ceq '8f6a7f67d08dda3b83af2e93820e2ad0c97e087a0eb5b4e6118bd432af5986ec') 'SMOKE_REVIEWED_SOURCE_HASH'
    . $SmokeSource -FunctionsOnly
    Assert-SetupPins
    $SmokeExpectedFiles = @($script:BundleFiles)
    Write-SmokeLog ('EVIDENCE checkout setup.ps1 sha256=' + (Get-FileHash -LiteralPath $SmokeSource -Algorithm SHA256).Hash.ToLowerInvariant())
    Write-SmokeResult 'source' $true $watch 'OK'
} catch { Write-SmokeResult 'source' $false $watch 'SMOKE_SOURCE_INVALID' }

Invoke-SmokeStage 'signed-exe' @('source') {
    Get-VerifiedDownload 'https://financialbrain.ai/install/FinancialBrainSetup-0.4.36.exe' $SmokeExe '691aad493b6eae9e26897fb47badf4664f172c6b9d8c27c58650f966405a9aff' 38184 @('financialbrain.ai')
    $signature = Get-AuthenticodeSignature -LiteralPath $SmokeExe
    Assert-Smoke ($signature.Status -eq 'Valid') 'SMOKE_SIGNATURE'
    Assert-Smoke ($null -ne $signature.SignerCertificate -and $signature.SignerCertificate.Subject.Contains('Financial Brain LLC')) 'SMOKE_SIGNER'
    # Reading the resource never calls the EXE entry point.
    $assembly = [Reflection.Assembly]::LoadFile([IO.Path]::GetFullPath($SmokeExe))
    $stream = $assembly.GetManifestResourceStream('setup.ps1')
    Assert-Smoke ($null -ne $stream) 'SMOKE_EMBEDDED_RESOURCE'
    $memory = New-Object IO.MemoryStream
    try {
        $stream.CopyTo($memory)
        $embedded = $memory.ToArray()
        $sourceBytes = [IO.File]::ReadAllBytes($SmokeSource)
        Assert-Smoke ($embedded.Length -eq $sourceBytes.Length) 'SMOKE_EMBEDDED_LENGTH'
        for ($i = 0; $i -lt $embedded.Length; $i++) {
            Assert-Smoke ($embedded[$i] -eq $sourceBytes[$i]) 'SMOKE_EMBEDDED_BYTES'
        }
    } finally { $stream.Dispose(); $memory.Dispose() }
    Write-SmokeLog 'EVIDENCE EXE bytes=38184 sha256=691aad493b6eae9e26897fb47badf4664f172c6b9d8c27c58650f966405a9aff signature=Valid embedded_script=byte_equal'
}

Invoke-SmokeStage 'fresh-tools' @('signed-exe') {
    # Hide all runner tools for discovery. Remove an existing MSI registration so
    # the pinned Node MSI installs afresh instead of accepting/repairing runner Node.
    Set-SmokePath
    Assert-Smoke (-not (Get-NodeState).Present -and -not (Test-Git)) 'SMOKE_PATH_NOT_FRESH'
    Assert-Smoke (-not (Find-Claude)) 'SMOKE_CLAUDE_PREEXISTS'
    $registrations = @()
    foreach ($root in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall', 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')) {
        if (Test-Path -LiteralPath $root) {
            $registrations += @(Get-ChildItem -LiteralPath $root | ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } | Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -ceq 'Node.js' })
        }
    }
    foreach ($registration in $registrations) {
        Assert-Smoke ($registration.PSObject.Properties['WindowsInstaller'] -and $registration.WindowsInstaller -eq 1 -and $registration.PSChildName -match '^\{[0-9A-Fa-f-]{36}\}$') 'SMOKE_NODE_NON_MSI'
        $process = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') -ArgumentList ('/x ' + $registration.PSChildName + ' /qn /norestart') -Wait -PassThru
        $script:SmokeNativeExit = $process.ExitCode
        Assert-Smoke ($process.ExitCode -eq 0) 'SMOKE_NODE_UNINSTALL'
    }
    Assert-Smoke (-not (Test-Path -LiteralPath $SmokeNode)) 'SMOKE_NODE_BINARY_REMAINS'
    # A client PC has no Git yet. The hosted runner ships machine Git, and the pinned
    # installer upgrades that copy in place instead of installing per-user, so remove
    # the runner's machine Git (disposable VM) to test the real fresh-install path.
    $machineGitUninstaller = Join-Path $env:ProgramFiles 'Git\unins000.exe'
    if (Test-Path -LiteralPath $machineGitUninstaller) {
        $process = Start-Process -FilePath $machineGitUninstaller -ArgumentList '/VERYSILENT /NORESTART /SUPPRESSMSGBOXES' -Wait -PassThru
        $script:SmokeNativeExit = $process.ExitCode
        Assert-Smoke ($process.ExitCode -eq 0) 'SMOKE_MACHINE_GIT_UNINSTALL'
        Write-SmokeLog 'EVIDENCE removed the runner machine Git before the fresh install'
    }
    Assert-Smoke (-not (Test-Path -LiteralPath $SmokeGit)) 'SMOKE_USER_GIT_PREEXISTS'
    Assert-Smoke (-not (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'FinancialBrainSetup\0.4.36\kit'))) 'SMOKE_KIT_PREEXISTS'
    Write-SmokeLog ('EVIDENCE hidden Node/Git; absent native Claude/user Git/kit; removed Node MSI registrations=' + $registrations.Count)
}

Invoke-SmokeStage 'node' @('fresh-tools') {
    Set-SmokePath
    $before = Get-NodeState
    Assert-Smoke (-not $before.Present) 'SMOKE_NODE_DECISION'
    $reboot = Install-Node
    Assert-Smoke (-not $reboot) 'SMOKE_NODE_REBOOT_REQUIRED'
    Assert-Smoke ((Get-Item -LiteralPath (Join-Path $script:Work 'node.msi')).Length -gt 0) 'SMOKE_NODE_MSI_NOT_REACHED'
    Set-SmokePath -Node
    $command = Get-Command node.exe -CommandType Application
    Assert-Smoke ($command.Source -ieq $SmokeNode) 'SMOKE_NODE_LOCATION'
    $version = @(& $SmokeNode --version 2>$null); Assert-SmokeNative 'SMOKE_NODE_VERSION_EXIT'
    $arch = @(& $SmokeNode -p 'process.arch' 2>$null); Assert-SmokeNative 'SMOKE_NODE_ARCH_EXIT'
    Assert-Smoke ($version.Count -eq 1 -and $version[0] -ceq 'v24.22.3' -and $arch.Count -eq 1 -and $arch[0] -ceq 'x64' -and (Get-NodeState).Ready) 'SMOKE_NODE_VERSION'
    Write-SmokeLog 'EVIDENCE new MSI install; node=v24.22.3 arch=x64 location=ProgramFiles/nodejs'
}

Invoke-SmokeStage 'git' @('node') {
    Set-SmokePath -Node
    Assert-Smoke (-not (Test-Git)) 'SMOKE_GIT_DECISION'
    Install-Git
    Assert-Smoke ((Get-Item -LiteralPath (Join-Path $script:Work 'git.exe')).Length -gt 0) 'SMOKE_GIT_INSTALL_NOT_REACHED'
    $found = @((Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd\git.exe'), (Join-Path $env:ProgramFiles 'Git\cmd\git.exe') | Where-Object { Test-Path -LiteralPath $_ })
    Write-SmokeLog ('EVIDENCE git.exe after install: ' + (($found | ForEach-Object { $_.Replace($env:LOCALAPPDATA,'LOCALAPPDATA').Replace($env:ProgramFiles,'ProgramFiles') }) -join ', '))
    Set-SmokePath -Node -Git
    $command = Get-Command git.exe -CommandType Application
    Assert-Smoke ($command.Source -ieq $SmokeGit -and (Test-Git)) 'SMOKE_GIT_LOCATION'
    $version = @(& $SmokeGit --version 2>$null); Assert-SmokeNative 'SMOKE_GIT_VERSION_EXIT'
    Assert-Smoke ($version.Count -eq 1 -and $version[0] -ceq 'git version 2.56.1.windows.1') 'SMOKE_GIT_VERSION'
    Write-SmokeLog 'EVIDENCE new per-user Git=2.56.1.windows.1 location=LOCALAPPDATA/Programs/Git/cmd'
}

Invoke-SmokeStage 'claude' @('git') {
    Set-SmokePath -Node -Git
    Assert-Smoke (-not (Find-Claude)) 'SMOKE_CLAUDE_DECISION'
    Install-Claude
    Set-SmokePath -Node -Git -Claude
    Assert-Smoke ((Find-Claude) -ieq $SmokeClaude) 'SMOKE_CLAUDE_LOCATION'
    $version = @(& $SmokeClaude --version 2>$null); Assert-SmokeNative 'SMOKE_CLAUDE_VERSION_EXIT'
    Assert-Smoke ($version.Count -eq 1 -and $version[0] -match '^\d+\.\d+\.\d+\s+\(Claude Code\)$') 'SMOKE_CLAUDE_VERSION'
    Write-SmokeLog ('EVIDENCE native Claude version=' + $version[0] + ' location=USERPROFILE/.local/bin')
}

Invoke-SmokeStage 'kit' @('claude') {
    $script:SmokeKit = Get-ClientBundle
    $entries = @(Get-ChildItem -LiteralPath $SmokeKit -Force)
    Assert-Smoke ($entries.Count -eq 13 -and $SmokeExpectedFiles.Count -eq 13) 'SMOKE_KIT_COUNT'
    foreach ($entry in $entries) {
        Assert-Smoke (-not $entry.PSIsContainer -and $SmokeExpectedFiles -ccontains $entry.Name -and -not ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'SMOKE_KIT_ENTRY'
        $zones = @(Get-Item -LiteralPath $entry.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue)
        Assert-Smoke ($zones.Count -eq 0) 'SMOKE_KIT_ZONE'
    }
    Assert-Smoke (Test-Path -LiteralPath (Join-Path $script:Work 'client.zip')) 'SMOKE_KIT_DOWNLOAD_NOT_REACHED'
    Write-SmokeLog 'EVIDENCE pinned ZIP downloaded, hash/bytes checked, extracted, exact 13 files, zone marks absent'
}

# start.ps1 exposes pure checks. Load only its functions after setup stages end.
$watch = [Diagnostics.Stopwatch]::StartNew()
if ($SmokeResults['kit']) {
    try {
        $start = Join-Path $SmokeKit 'start.ps1'
        Assert-Smoke ((Get-FileHash -LiteralPath $start -Algorithm SHA256).Hash.ToLowerInvariant() -ceq '76ca9f47cff14d8f393b4dcb79d1a8a055facff1512578b34e390a42a61ec9b6') 'SMOKE_START_REVIEWED_HASH'
        . $start -FunctionsOnly
        Write-SmokeResult 'start-functions' $true $watch 'OK'
    } catch { Write-SmokeResult 'start-functions' $false $watch 'SMOKE_START_FUNCTIONS' }
} else { Write-SmokeResult 'start-functions' $false $watch 'BLOCKED_KIT' }

Invoke-SmokeStage 'file-checksums' @('start-functions') {
    Test-ClientFiles $SmokeKit
    Write-SmokeLog 'EVIDENCE shipped Test-ClientFiles verified all 12 SHA256SUMS rows plus runtime identity and package bytes'
}

Invoke-SmokeStage 'computer-checks' @('file-checksums') {
    $os = Get-CimInstance -ClassName Win32_OperatingSystem
    $processors = @(Get-CimInstance -ClassName Win32_Processor)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try { $principal = [Security.Principal.WindowsPrincipal]::new($identity); $elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } finally { $identity.Dispose() }
    $local = Assert-LocalPath $env:LOCALAPPDATA
    $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($local))
    $facts = [pscustomobject]@{
        WindowsMajor = [int](([string]$os.Version).Split('.')[0])
        X64 = [IntPtr]::Size -eq 8 -and $processors.Count -gt 0 -and @($processors | Where-Object { $_.Architecture -ne 9 }).Count -eq 0
        Elevated = $elevated; NodeReady = (Get-NodeState).Ready; GitReady = (Test-Git)
        FreeBytes = $(if ($drive.IsReady) { $drive.AvailableFreeSpace } else { 0 })
    }
    $assessment = Test-SystemFacts $facts
    Assert-Smoke ($assessment.Reached.Count -eq 6) 'SMOKE_COMPUTER_DECISION_NOT_REACHED'
    $unexpected = @($assessment.Issues | Where-Object { $_.Id -cne 'elevated' })
    Assert-Smoke ($unexpected.Count -eq 0 -and $assessment.Ready -eq (-not $elevated) -and $assessment.Issues.Count -eq [int]$elevated) 'SMOKE_COMPUTER_FACTS'
    Write-SmokeLog ('EVIDENCE computer checks reached=6 elevated=' + $elevated + ' actual_ready=' + $assessment.Ready + '; no elevated fact was changed')
    # Positive control and reached negative decision for the shipped pure function.
    $control = $facts.PSObject.Copy(); $control.Elevated = $false
    Assert-Smoke (Test-SystemFacts $control).Ready 'SMOKE_COMPUTER_GREEN_CONTROL'
    $control.NodeReady = $false; $negative = Test-SystemFacts $control
    Assert-Smoke (-not $negative.Ready -and $negative.Reached -ccontains 'node' -and @($negative.Issues | Where-Object { $_.Id -ceq 'node' }).Count -eq 1) 'SMOKE_COMPUTER_NEGATIVE_CONTROL'
    Write-SmokeLog 'LIMITATION computer-checks PASS proves checks executed; elevated runner is correctly NOT READY for interactive number 1.'
}

Invoke-SmokeStage 'unpack' @('file-checksums') {
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    Assert-Smoke (Test-Path -LiteralPath $tar -PathType Leaf) 'SMOKE_TAR_MISSING'
    $script:SmokeRun = Join-Path $SmokeRoot 'number-one-checks'
    Assert-Smoke (-not (Test-Path -LiteralPath $SmokeRun)) 'SMOKE_UNPACK_PREEXISTS'
    $null = New-Item -ItemType Directory -Path $SmokeRun
    foreach ($name in $SmokeExpectedFiles) { Copy-Item -LiteralPath (Join-Path $SmokeKit $name) -Destination (Join-Path $SmokeRun $name) }
    Test-ClientFiles $SmokeRun
    $archive = Join-Path $SmokeRun 'brain-installer-0.4.36.tgz'
    Test-PackageArchive $tar $archive
    & $tar -xf $archive -C $SmokeRun 2>$null; Assert-SmokeNative 'SMOKE_EXTRACT_EXIT'
    foreach ($required in @('package\brain.mjs', 'package\skills\financial-brain-technician\SKILL.md', 'package\node_modules', 'package\tools\preflight.ps1')) {
        Assert-Smoke (Test-Path -LiteralPath (Join-Path $SmokeRun $required)) 'SMOKE_PACKAGE_INCOMPLETE'
    }
    Get-ChildItem -LiteralPath (Join-Path $SmokeRun 'package') -Recurse -File | ForEach-Object { Unblock-File -LiteralPath $_.FullName }
    # This is the only packaged CLI call; no manifest, credential or setup command.
    $version = @(& $SmokeNode (Join-Path $SmokeRun 'package\brain.mjs') --version 2>$null)
    Assert-SmokeNative 'SMOKE_PACKAGE_VERSION_EXIT'
    Assert-Smoke ($version.Count -eq 1 -and $version[0] -ceq '0.4.36') 'SMOKE_PACKAGE_VERSION'
    Write-SmokeLog 'EVIDENCE shipped archive check=996 files; extracted required paths; package version=0.4.36'
}

Invoke-SmokeStage 'early-screen' @('unpack') {
    Push-Location -LiteralPath $SmokeRun
    try {
        $screen = @(& $SmokeNode (Join-Path $SmokeRun 'pre-session-check.mjs') 2>&1)
        Assert-SmokeNative 'SMOKE_EARLY_SCREEN_EXIT'
        Assert-Smoke ($screen.Count -eq 1 -and [string]$screen[0] -ceq 'Checking your computer: done. Your installer will finish the remaining checks.') 'SMOKE_EARLY_SCREEN'
    } finally { Pop-Location }
    Write-SmokeLog 'EVIDENCE real early screen exited=0; no product preflight, approval, tools, shortcut or Claude launch invoked'
}

Invoke-SmokeStage 'stop-boundary' @('early-screen', 'computer-checks') {
    foreach ($relative in @('brain.manifest.json', 'CLAUDE.md', 'INSTALL-STEPS.md', 'START-READY.txt')) {
        Assert-Smoke (-not (Test-Path -LiteralPath (Join-Path $SmokeRun $relative))) 'SMOKE_APPROVAL_BOUNDARY'
    }
    Write-SmokeLog 'EVIDENCE stopped before packaged product preflight (may use network/credentials), every Yes/No dialog, tools writes and Claude launch'
}
$failed = @($SmokeResults.Keys | Where-Object { -not $SmokeResults[$_] })
Write-SmokeLog ('SUMMARY stages=' + $SmokeResults.Count + ' passed=' + ($SmokeResults.Count - $failed.Count) + ' failed=' + $failed.Count + '; offline material is not release evidence')
Assert-Smoke ($SmokeResults.Count -eq 13 -and $failed.Count -eq 0) 'SMOKE_FAILED'
