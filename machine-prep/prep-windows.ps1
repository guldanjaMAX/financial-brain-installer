# Financial Brain prerequisite preparation for Windows.
# --check and --dry-run are read-only. Real mode is deliberately per-user.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$NodeVersion = "24.13.1"
$ClaudeMinVersion = "2.1.261"
$BrainVersion = "0.4.10"
$BrainKitUrl = "https://financialbrain.ai/kit/brain-installer-0.4.10-55824b383909c57b.tgz"
$BrainKitSize = 6828366
$BrainKitSha256 = "55824b383909c57b37f4db6179562bf603f670eaae3c7d315135dd290b0afdfe"
$WranglerVersion = "4.131.1"
# Official pages and the exact step on each, named to the owner when a
# prerequisite needs action. Real mode never downloads or runs anything from
# them; the owner installs by hand. Claude uses a floor because native
# installs auto-update. Codex is informational and never blocks preparation.
$NodeSource = "https://nodejs.org/en/download"
$GitSource = "https://git-scm.com/install/windows"
$ClaudeSource = "https://code.claude.com/docs/en/setup#install-claude-code"
$NodeHow = "At the top of the page, choose a version that starts with v24 (marked LTS). Then, under ""Or get a prebuilt Node.js"", click ""Windows Installer (.msi)"" and open the downloaded file. Download page: $NodeSource"
$GitHow = "Use the ""Click here to download"" link at the top of the page and open the downloaded file. Download page: $GitSource"
$ClaudeHow = "Under ""Install Claude Code"" on the setup page, choose ""Native Install (Recommended)"" and run the default command for your system. Setup page: $ClaudeSource"
$ClaudeUpdateHow = "Open a new terminal and run claude update."
$ClaudeConflictHow = "Open a new terminal and run claude doctor. Follow its installation warning to select the Native Install copy."
$Mode = if ($args.Count -gt 0) { [string]$args[0] } else { "--real" }
if ($Mode -eq "--test-install-brain") {
  if ($env:MACHINE_PREP_TEST_MODE -ne "1") { throw "test install seam outside test mode" }
  $BrainKitSize = [long]$env:MACHINE_PREP_TEST_KIT_SIZE
  $BrainKitSha256 = [string]$env:MACHINE_PREP_TEST_KIT_SHA256
}
$FixtureDir = [string]$env:MACHINE_PREP_FIXTURE_DIR
$PrepHome = if ($env:MACHINE_PREP_HOME) { $env:MACHINE_PREP_HOME } elseif ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$LocalRoot = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $PrepHome "AppData\Local" }
$ToolsRoot = Join-Path $LocalRoot "FinancialBrainTools"
$NpmPrefix = Join-Path $ToolsRoot "npm"
$BrainPrefix = Join-Path $LocalRoot "FinancialBrain"
$LogDir = Join-Path $LocalRoot "FinancialBrainMachinePrep"
$LogFile = Join-Path $LogDir "prep.log"
$script:CheckFailures = 0
$script:NodeState = "MISSING"
$script:GitState = "MISSING"
$script:ClaudeState = "MISSING"
$script:CodexDetail = "not found. Setup can continue without it."
$script:BrainState = "MISSING"
$script:SessionState = "READY"
$script:OwnerSteps = @()
$script:ChecksumExitCode = 0
$script:RealExitCode = 0
$script:InstalledBrainReady = $false

function Read-Fixture([string]$Name) {
  if (-not $FixtureDir) { return $null }
  $path = Join-Path $FixtureDir $Name
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  return ([System.IO.File]::ReadAllText($path)).TrimEnd("`r", "`n")
}

function Get-ToolPaths([string]$Name) {
  if ($FixtureDir) {
    $value = Read-Fixture "$Name.paths"
    if (-not $value -or $value -eq "MISSING") { return @() }
    return @($value -split "`r?`n" | Where-Object { $_ } | Select-Object -Unique)
  }
  $names = if ($Name -eq "brain") { @("brain", "brain.cmd") } else { @($Name) }
  $found = foreach ($candidate in $names) {
    Get-Command $candidate -All -CommandType Application -ErrorAction SilentlyContinue | ForEach-Object Source
  }
  return @($found | Where-Object { $_ } | Select-Object -Unique)
}

function Get-ToolVersion([string]$Name) {
  if ($Name -eq "claude") {
    $paths = @(Get-ToolPaths $Name)
    if ($paths.Count -eq 0) { return $null }
    $canonical = Join-Path $PrepHome ".local\bin\claude.exe"
    if (-not [string]::Equals([IO.Path]::GetFullPath($paths[0]), [IO.Path]::GetFullPath($canonical), [StringComparison]::OrdinalIgnoreCase)) { return $null }
    # Keep older fixtures intact; the new input exercises the metadata reading
    # through the same validation used for the native executable.
    if ($FixtureDir -and -not (Test-Path -LiteralPath (Join-Path $FixtureDir "claude.product-version") -PathType Leaf)) {
      return Read-Fixture "claude.version"
    }
    $fileVersion = $null
    if ($FixtureDir) { $fileVersion = Read-Fixture "claude.product-version" } else {
      try { $fileVersion = (Get-Item -LiteralPath $canonical).VersionInfo.ProductVersion } catch { $fileVersion = $null }
    }
    # Native builds have reported X.Y.Z.0 here; X.Y.Z is accepted too. Anything
    # else reads as "version could not be read". Nothing is run to compensate.
    if ($fileVersion -cmatch '\A([0-9]+\.[0-9]+\.[0-9]+)(?:\.0)?\z') { return "$($Matches[1]) (Claude Code)" }
    return $null
  }
  if ($FixtureDir) {
    $value = Read-Fixture "$Name.version"
    if (-not $value -or $value -eq "MISSING") { return $null }
    return $value
  }
  $paths = @(Get-ToolPaths $Name)
  if ($paths.Count -eq 0) { return $null }
  if ($Name -eq "brain") {
    $packageJson = Join-Path $LocalRoot "FinancialBrain\node_modules\brain-installer\package.json"
    if (-not (Test-Path -LiteralPath $packageJson -PathType Leaf)) { return $null }
    return [string](([IO.File]::ReadAllText($packageJson) | ConvertFrom-Json).version)
  }
  if ($Name -eq "codex") {
    $packageJson = Join-Path $NpmPrefix "node_modules\@openai\codex\package.json"
    $canonical = Join-Path $NpmPrefix "codex.cmd"
    if (-not [string]::Equals([IO.Path]::GetFullPath($paths[0]), [IO.Path]::GetFullPath($canonical), [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $packageJson -PathType Leaf)) { return $null }
    return "codex-cli $([string](([IO.File]::ReadAllText($packageJson) | ConvertFrom-Json).version))"
  }
  $output = @(& $paths[0] --version 2>$null)
  if ($output.Count -eq 0) { return $null }
  return [string]$output[0]
}

function Write-Status([string]$State, [string]$Label, [string]$Detail) {
  Write-Output ("{0,-14} {1,-23} {2}" -f $State, $Label, $Detail)
  if ($State -in @("MISSING", "WRONG_VERSION", "SHADOWED")) { $script:CheckFailures++ }
}

# Records one plain-language line for a prerequisite that blocks real mode:
# the tool, what is wrong, what the check needs, and the one next step.
# Only Invoke-Real prints these, so check and dry-run output stay unchanged.
function Add-OwnerStep([string]$Tool, [string]$Problem, [string]$Need, [string]$NextStep) {
  $script:OwnerSteps += "- {0}: {1}. Needs {2}. {3}" -f $Tool, $Problem, $Need, $NextStep
}

function Test-StandardSession {
  if ($FixtureDir) { return (Read-Fixture "session.status") -eq "standard" }
  if (-not $env:LOCALAPPDATA) { return $false }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  $admin = [Security.Principal.WindowsBuiltInRole]::Administrator
  if ($principal.IsInRole($admin)) { return $false }
  if ($env:APPDATA -like "*\Packages\*" -or $env:LOCALAPPDATA -like "*\Packages\*") { return $false }
  try {
    if (-not ("FinancialBrainMachinePrepPackageContext" -as [type])) {
      Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
using System.Text;
public static class FinancialBrainMachinePrepPackageContext {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetCurrentPackageFullName(ref uint length, StringBuilder name);
}
'@ | Out-Null
    }
    [uint32]$length = 0
    $status = [FinancialBrainMachinePrepPackageContext]::GetCurrentPackageFullName([ref]$length, $null)
    if ($status -eq 15700) { return $true }
    return $false
  } catch {
    return $false
  }
}

# Mirror the numeric component comparison on macOS. Validation happens first;
# no lexical comparison or exact pin can reject a newer stable native release.
function Test-ClaudeFloor([string]$Actual) {
  $actualParts = $Actual.Split('.')
  $floorParts = $ClaudeMinVersion.Split('.')
  for ($i = 0; $i -lt 3; $i++) {
    if ([double]$actualParts[$i] -gt [double]$floorParts[$i]) { return $true }
    if ([double]$actualParts[$i] -lt [double]$floorParts[$i]) { return $false }
  }
  return $true
}

function Invoke-Checks {
  $script:CheckFailures = 0
  $script:OwnerSteps = @()
  $node = Get-ToolVersion "node"
  if (-not $node) {
    $script:NodeState = "MISSING"
    Write-Status $script:NodeState "Node.js" "OWNER ACTION: install supported Node.js from its official signed installer"
    Add-OwnerStep "Node.js" "not found" "version 24 or 22" $NodeHow
  } elseif ($node -match '^v(22|24)\.') {
    $script:NodeState = "READY"
    Write-Status $script:NodeState "Node.js" $node
  } else {
    $script:NodeState = "WRONG_VERSION"
    Write-Status $script:NodeState "Node.js" "$node; OWNER ACTION: install supported major 22 or 24"
    $found = $node
    Add-OwnerStep "Node.js" "version $found is installed" "version 24 or 22" $NodeHow
  }

  $npm = Get-ToolVersion "npm"
  if ($npm) { Write-Status "READY" "npm" $npm } else { Write-Status "MISSING" "npm" "OWNER ACTION: install it with supported Node.js" }

  $git = Get-ToolVersion "git"
  if ($git) {
    $script:GitState = "READY"
    Write-Status $script:GitState "Git" $git
  } else {
    $script:GitState = "MISSING"
    Write-Status $script:GitState "Git" "OWNER ACTION: install Git for Windows (any version) from its official signed installer"
    Add-OwnerStep "Git" "not found" "Git for Windows, any version" $GitHow
  }

  $claudePaths = @(Get-ToolPaths "claude")
  $claude = Get-ToolVersion "claude"
  $canonicalClaude = Join-Path $PrepHome ".local\bin\claude.exe"
  # Only the selected copy can block setup. Later copies do not shadow it.
  # The native launcher location is documented in the vendor setup guide.
  if ($claudePaths.Count -gt 0 -and -not [string]::Equals([IO.Path]::GetFullPath($claudePaths[0]), [IO.Path]::GetFullPath($canonicalClaude), [StringComparison]::OrdinalIgnoreCase)) {
    $script:ClaudeState = "SHADOWED"
    Write-Status $script:ClaudeState "Claude Code" "another install is selected; $ClaudeConflictHow"
    Add-OwnerStep "Claude Code" "another install is selected instead of the Native Install copy" "version $ClaudeMinVersion or newer from Native Install" $ClaudeConflictHow
  } elseif ($claudePaths.Count -eq 0 -or -not $claude -or $claude -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+ \(Claude Code\)$') {
    $script:ClaudeState = "MISSING"
    Write-Status $script:ClaudeState "Claude Code" "version $ClaudeMinVersion or newer; $ClaudeHow"
    $problem = if ($claudePaths.Count -eq 0) { "not found" } else { "a copy was found, but its version could not be read" }
    Add-OwnerStep "Claude Code" "$problem" "version $ClaudeMinVersion or newer" $ClaudeHow
  } elseif (Test-ClaudeFloor ($claude -creplace ' \(Claude Code\)$', '')) {
    $script:ClaudeState = "READY"
    Write-Status $script:ClaudeState "Claude Code" $claude
  } else {
    $script:ClaudeState = "WRONG_VERSION"
    Write-Status $script:ClaudeState "Claude Code" "$claude; needs $ClaudeMinVersion or newer; $ClaudeUpdateHow"
    $found = $claude -creplace ' \(Claude Code\)$', ''
    Add-OwnerStep "Claude Code" "version $found is installed" "version $ClaudeMinVersion or newer" $ClaudeUpdateHow
  }

  $codexPaths = @(Get-ToolPaths "codex")
  # Optional metadata may be absent or unreadable without blocking setup.
  try { $codex = Get-ToolVersion "codex" } catch { $codex = $null }
  if ($codexPaths.Count -eq 0) {
    $script:CodexDetail = "not found. Setup can continue without it."
  } elseif ($codex -and $codex -cmatch '^codex-cli [0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$') {
    $script:CodexDetail = "found, version $($codex -creplace '^codex-cli ', '')."
  } else {
    # Inspect known package metadata only. Never start an optional assistant
    # just to get its version, and never echo unrecognized tool output.
    $script:CodexDetail = "found; version unavailable. Setup can continue without it."
  }
  Write-Status "OPTIONAL" "Codex CLI" $script:CodexDetail

  $brainPaths = @(Get-ToolPaths "brain")
  $brain = Get-ToolVersion "brain"
  $canonicalBrain = Join-Path $BrainPrefix "brain.cmd"
  if ($brainPaths.Count -gt 1) {
    $script:BrainState = "SHADOWED"
    Write-Status $script:BrainState "Financial Brain CLI" "$($brainPaths.Count) PATH matches; fix: remove the earlier PATH entry and reopen PowerShell"
  } elseif ($brainPaths.Count -eq 0) {
    $script:BrainState = "MISSING"
    Write-Status $script:BrainState "Financial Brain CLI" "install pinned $BrainVersion kit; fix: run --real"
  } elseif (-not [string]::Equals([IO.Path]::GetFullPath($brainPaths[0]), [IO.Path]::GetFullPath($canonicalBrain), [StringComparison]::OrdinalIgnoreCase)) {
    $script:BrainState = "SHADOWED"
    Write-Status $script:BrainState "Financial Brain CLI" "$($brainPaths[0]) resolves first; fix: put $canonicalBrain first on PATH"
  } elseif (-not $brain -or $brain -cne $BrainVersion) {
    $script:BrainState = "WRONG_VERSION"
    Write-Status $script:BrainState "Financial Brain CLI" "$(if ($brain) { $brain } else { 'unknown' }); expected $BrainVersion; fix: use the signed installer for a clean prefix"
  } else {
    $script:BrainState = "READY"
    Write-Status $script:BrainState "Financial Brain CLI" "$brain at the canonical per-user path"
  }

  Write-Status "READY" "Wrangler" "package pin $WranglerVersion; no global install needed"
  Write-Status "READY" "Python 3" "not required by standard machine prep"

  if (Test-StandardSession) {
    $script:SessionState = "READY"
    Write-Status $script:SessionState "Windows session" "normal current-user PowerShell"
  } else {
    $script:SessionState = "WRONG_VERSION"
    Write-Status $script:SessionState "Windows session" "Administrator or packaged-app shell; fix: open PowerShell from Start as the current user"
  }
}

function Show-Check {
  Write-Output "Machine Prep for Windows"
  Write-Output "MODE check (read-only)"
  Write-Output ""
  Write-Output "READINESS"
  Invoke-Checks
  Write-Output "CHECKS_REACHED=9"
  if ($script:CheckFailures -eq 0) { Write-Output "READINESS GREEN" }
  else { Write-Output "READINESS RED" }
}

function Show-Plan {
  Write-Output "Machine Prep for Windows"
  Write-Output "MODE dry-run (no changes)"
  Write-Output ""
  Write-Output "READINESS"
  Invoke-Checks
  Write-Output "CHECKS_REACHED=9"
  if ($script:CheckFailures -eq 0) { Write-Output "READINESS GREEN" } else { Write-Output "READINESS RED" }
  Write-Output ""
  Write-Output "PLAN"
  Write-Output "1. ADMIN: no Administrator session is needed or allowed; keep this normal current-user PowerShell window."
  Write-Output "2. OWNER ACTION: install any missing Node.js, Git, or Claude Code tool from its official signed installer, then rerun this launcher."
  Write-Output "3. REFUSE: the launcher does not download or execute prerequisite installers whose bytes it cannot authenticate before execution."
  Write-Output "4. SKIP: do not install global Wrangler; Financial Brain owns wrangler@$WranglerVersion."
  Write-Output "5. DOWNLOAD: Financial Brain $BrainVersion from the one pinned HTTPS kit URL without following redirects."
  Write-Output "6. VERIFY: require exactly $BrainKitSize bytes and SHA-256 $BrainKitSha256 before npm sees the local file."
  Write-Output "7. INSTALL: use an isolated npm environment and private staging prefix, then atomically promote to clean per-user $BrainPrefix."
  Write-Output "8. VERIFY: rerun --check and show the operator the green/red list."
  Write-Output ""
  Write-Output "No command was executed, no directory was created, and no log was written."
}

function Test-Checksum([string]$File, [string]$Expected) {
  $script:ChecksumExitCode = 0
  Write-Output "CHECKSUM_DECISION_REACHED=1"
  if (-not (Test-Path -LiteralPath $File -PathType Leaf) -or $Expected -notmatch '^[0-9a-fA-F]{64}$') {
    [Console]::Error.WriteLine("REFUSED checksum input invalid")
    $script:ChecksumExitCode = 2
    return
  }
  $actual = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -cne $Expected.ToLowerInvariant()) {
    [Console]::Error.WriteLine("REFUSED checksum mismatch")
    $script:ChecksumExitCode = 2
    return
  }
  Write-Output "VERIFIED checksum"
}

function Test-Prefix([string]$Target) {
  $script:PrefixExitCode = 0
  Write-Output "PREFIX_DECISION_REACHED=1"
  if ([string]::IsNullOrWhiteSpace($Target)) {
    [Console]::Error.WriteLine("REFUSED prefix input invalid")
    $script:PrefixExitCode = 2
    return
  }
  if (Test-Path -LiteralPath $Target) {
    [Console]::Error.WriteLine("REFUSED prefix collision")
    $script:PrefixExitCode = 2
    return
  }
  Write-Output "AVAILABLE prefix"
}

function Test-InstalledBrain([string]$Prefix) {
  $script:InstalledBrainReady = $false
  Write-Output "INSTALLED_BRAIN_DECISION_REACHED=1"
  Write-Output "REUSE_ATTEMPTED=0"
  [Console]::Error.WriteLine("REFUSED existing prefix cannot be authenticated against reviewed release bytes; move it aside and rerun")
}

function Test-BrainKit([string]$File) {
  Write-Output "KIT_SIZE_DECISION_REACHED=1 expected=$BrainKitSize"
  if (-not (Test-Path -LiteralPath $File -PathType Leaf) -or (Get-Item -LiteralPath $File).Length -ne $BrainKitSize) {
    throw "REFUSED kit size mismatch"
  }
  Test-Checksum $File $BrainKitSha256
  if ($script:ChecksumExitCode -ne 0) { throw "Financial Brain kit checksum mismatch" }
}

function Write-Log([string]$Message) {
  $stamp = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow, "US Mountain Standard Time").ToString("yyyy-MM-ddTHH:mm:sszzz")
  [MachinePrepLogIO]::Append($LogDir, "$stamp $Message`r`n")
}

function Add-UserPath([string[]]$Directories) {
  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = @($current -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  foreach ($directory in $Directories) {
    $present = @($parts | Where-Object { [string]::Equals($_, $directory, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
    if (-not $present) { $parts += $directory }
  }
  [Environment]::SetEnvironmentVariable("Path", ($parts -join ';'), "User")
  $env:Path = (($Directories + @($env:Path)) -join ';')
}

function Copy-PinnedKitStream([IO.Stream]$SourceStream, [string]$Destination, [long]$ExpectedSize) {
  Write-Output "DOWNLOAD_WRITE_DECISION_REACHED=1"
  $output = $null
  $created = $false
  try {
    $output = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $created = $true
    $buffer = New-Object byte[] 65536
    [long]$total = 0
    while (($read = $SourceStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $total += $read
      if ($total -gt $ExpectedSize) { throw "kit download refused: size limit exceeded" }
      $output.Write($buffer, 0, $read)
    }
    if ($total -ne $ExpectedSize) { throw "kit download refused: size mismatch" }
  } catch {
    if ($output) { $output.Dispose(); $output = $null }
    if ($created -and (Test-Path -LiteralPath $Destination -PathType Leaf)) { Remove-Item -LiteralPath $Destination -Force }
    throw
  } finally {
    if ($output) { $output.Dispose() }
  }
}

function Receive-PinnedKit([string]$Destination) {
  if ($env:MACHINE_PREP_TEST_MODE -eq "1" -and $env:MACHINE_PREP_TEST_KIT_SOURCE) {
    $testInput = [IO.File]::OpenRead($env:MACHINE_PREP_TEST_KIT_SOURCE)
    $testTransferSize = if ($env:MACHINE_PREP_TEST_TRANSFER_SIZE) { [long]$env:MACHINE_PREP_TEST_TRANSFER_SIZE } else { $BrainKitSize }
    try { Copy-PinnedKitStream $testInput $Destination $testTransferSize } finally { $testInput.Dispose() }
    return
  }
  Add-Type -AssemblyName System.Net.Http
  $handler = [Net.Http.HttpClientHandler]::new()
  $handler.AllowAutoRedirect = $false
  $client = [Net.Http.HttpClient]::new($handler)
  $response = $null
  $ResponseStream = $null
  try {
    $client.Timeout = [TimeSpan]::FromMinutes(5)
    Write-Output "NO_REDIRECTS=1"
    $response = $client.GetAsync($BrainKitUrl, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    if ([int]$response.StatusCode -ne 200 -or $response.RequestMessage.RequestUri.AbsoluteUri -cne $BrainKitUrl) { throw "kit download refused: direct HTTPS 200 required" }
    if ($response.Content.Headers.ContentLength -ne $BrainKitSize) { throw "kit download refused: content length mismatch" }
    $ResponseStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    Copy-PinnedKitStream $ResponseStream $Destination $BrainKitSize
  } finally {
    if ($ResponseStream) { $ResponseStream.Dispose() }
    if ($response) { $response.Dispose() }
    $client.Dispose()
    $handler.Dispose()
  }
}

function Wait-RedirectedProcess([Diagnostics.Process]$Process) {
  $stdoutTask = $Process.StandardOutput.ReadToEndAsync()
  $stderrTask = $Process.StandardError.ReadToEndAsync()
  $Process.WaitForExit()
  [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdoutTask, $stderrTask))
  return [pscustomobject]@{ ExitCode = [int]$Process.ExitCode; Output = $stdoutTask.Result; Errors = $stderrTask.Result }
}

# npm can echo config, argv and authenticated URLs. Keep the same conservative
# redaction as macOS, including when retaining the full newest debug log.
function Protect-NpmOutput([string]$Text) {
  $lines = foreach ($line in ($Text -split "`r?`n")) {
    $safe = $line -replace '\x1b\[[0-9;]*[A-Za-z]', '' -replace '[\x00-\x1f\x7f]', ''
    $safe = $safe -replace '//[^/\s]*@', '//[REDACTED]@'
    $safe = $safe -replace '[?#][^\s"<>]*', '[REDACTED]'
    if ($safe -match 'auth|token|password|passwd|secret|credential|bearer|api[ _-]?key|npm_[a-z0-9]{16,}|gh[pousr]_[a-z0-9]+|github_pat_|eyj[a-z0-9_-]+\.') { $safe = '[REDACTED]' }
    $safe
  }
  return [string]::Join("`r`n", [string[]]$lines)
}

# Keep every directory handle open without FILE_SHARE_DELETE until I/O ends.
# OPEN_REPARSE_POINT checks the object itself, so a junction at any level or a
# swapped leaf cannot redirect diagnostic reads/writes outside the attempt.
function Initialize-NpmLogIO {
  if ('MachinePrepLogIO' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class MachinePrepLogIO {
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file, out Info info);
  [DllImport("kernel32.dll")] static extern uint GetFileType(SafeFileHandle file);
  static SafeFileHandle Open(string path, bool directory, bool write) {
    // OPEN_EXISTING for append preserves bytes; all new leaves use CreateNew.
    var h = CreateFile(path, directory ? 0x80u : (write ? 0x40000000u : 0x80000000u), directory ? 3u : 1u,
      IntPtr.Zero, 3u, 0x00200000u | (directory ? 0x02000000u : 0u), IntPtr.Zero);
    Info i;
    if (h.IsInvalid || !GetFileInformationByHandle(h, out i) || (i.Attributes & 0x400) != 0 ||
        ((i.Attributes & 0x10) != 0) != directory || (!directory && (GetFileType(h) != 1 || i.Links != 1))) {
      h.Dispose(); throw new IOException("Unsafe diagnostic path");
    }
    return h;
  }
  sealed class Directories : IDisposable {
    readonly List<SafeFileHandle> held = new List<SafeFileHandle>();
    public Directories(string path, bool create, bool owner) {
      try {
        path = Path.GetFullPath(path);
        var root = Path.GetPathRoot(path);
        if (root.Length != 3 || root[1] != ':') throw new IOException("Local log directory required");
        var current = root;
        held.Add(Open(current, true, false));
        foreach (var part in path.Substring(root.Length).Split(new char[] { '\\' }, StringSplitOptions.RemoveEmptyEntries)) {
          current = Path.Combine(current, part);
          if (create && !Directory.Exists(current)) {
            // SetOwner alone leaves an empty DACL: even this user cannot open
            // or delete the result. Grant access before creation, including
            // inheritance for debug files, without importing broader grants.
            var security = new DirectorySecurity(); security.SetOwner(WindowsIdentity.GetCurrent().User);
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User, FileSystemRights.FullControl,
              InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            Directory.CreateDirectory(current, security);
          }
          held.Add(Open(current, true, false));
        }
        if (owner && !Directory.GetAccessControl(path).GetOwner(typeof(SecurityIdentifier)).Equals(WindowsIdentity.GetCurrent().User))
          throw new IOException("Log directory owner mismatch");
      } catch { Dispose(); throw; }
    }
    public void Dispose() { for (int n = held.Count - 1; n >= 0; n--) held[n].Dispose(); }
  }
  public static string ReadNewest(string attempt) {
    // The fixed child components establish containment, not a textual prefix.
    using (var dirs = new Directories(Path.Combine(attempt, "npm-cache", "_logs"), false, false)) {
      FileStream newest = null; DateTime stamp = DateTime.MinValue;
      try {
        foreach (var name in Directory.GetFiles(Path.Combine(attempt, "npm-cache", "_logs"), "*.log")) {
          FileStream file;
          try { file = new FileStream(Open(name, false, false), FileAccess.Read); } catch (IOException) { continue; }
          var time = File.GetLastWriteTimeUtc(name);
          if (newest == null || time > stamp) { if (newest != null) newest.Dispose(); newest = file; stamp = time; }
          else file.Dispose();
        }
        if (newest == null) return null;
        using (var reader = new StreamReader(newest)) { return reader.ReadToEnd(); }
      } finally { if (newest != null) newest.Dispose(); }
    }
  }
  public static string WriteNew(string directory, string text) {
    using (var dirs = new Directories(directory, true, true)) {
      var name = "npm-debug-" + Guid.NewGuid().ToString("N") + ".log";
      using (var file = new FileStream(Path.Combine(directory, name), FileMode.CreateNew, FileAccess.Write, FileShare.None))
      using (var writer = new StreamWriter(file)) { writer.Write(text); }
      return name;
    }
  }
  public static void Append(string directory, string text) {
    using (var dirs = new Directories(directory, true, true)) {
      var path = Path.Combine(directory, "prep.log");
      if (!File.Exists(path)) {
        // Ownership is not permission to reopen the file after CreateNew.
        var security = new FileSecurity(); security.SetOwner(WindowsIdentity.GetCurrent().User);
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User, FileSystemRights.FullControl, AccessControlType.Allow));
        using (var created = new FileStream(path, FileMode.CreateNew, FileSystemRights.Write, FileShare.None, 4096, FileOptions.None, security)) { }
      }
      using (var file = new FileStream(Open(path, false, true), FileAccess.Write)) {
        if (!File.GetAccessControl(path).GetOwner(typeof(SecurityIdentifier)).Equals(WindowsIdentity.GetCurrent().User))
          throw new IOException("Log file owner mismatch");
        file.Seek(0, SeekOrigin.End);
        using (var writer = new StreamWriter(file)) { writer.Write(text); }
      }
    }
  }
}
'@
}

# Windows PowerShell 5.1 lacks ArgumentList. Use CRT argv quoting for a direct
# executable, including trailing backslashes; no command shell expands % or !.
function ConvertTo-NativeArgument([string]$Value) {
  return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function Test-StandardNpmShim([string]$Text) {
  # Checked against npm 11.8.0 and 11.9.0 bin/npm.cmd. Recognize the whole
  # standard structure, not a target substring that a forwarding shim can keep.
  # Blank lines, comments, case and indentation may vary; extra commands cannot.
  $lines = @($Text -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -notmatch '^(::|REM(?:\s|$))[^&|<>^%!\x00-\x1f]*$' })
  $patterns = @(
    '^@?ECHO\s+OFF$'
    '^SETLOCAL$'
    '^SET\s+"NODE_EXE=%~dp0\\node\.exe"$'
    '^IF\s+NOT\s+EXIST\s+"%NODE_EXE%"\s+\($'
    '^SET\s+"NODE_EXE=node"$'
    '^\)$'
    '^SET\s+"NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix\.js"$'
    '^SET\s+"NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli\.js"$'
    '^FOR\s+/F\s+"delims="\s+%%F\s+IN\s+\(\x27CALL\s+"%NODE_EXE%"\s+"%NPM_PREFIX_JS%"\x27\)\s+DO\s+\($'
    '^SET\s+"NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli\.js"$'
    '^\)$'
    '^IF\s+EXIST\s+"%NPM_PREFIX_NPM_CLI_JS%"\s+\($'
    '^SET\s+"NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%"$'
    '^\)$'
    '^"%NODE_EXE%"\s+"%NPM_CLI_JS%"\s+%\*$'
  )
  if ($lines.Count -ne $patterns.Count) { return $false }
  for ($i = 0; $i -lt $patterns.Count; $i++) {
    if ($lines[$i] -notmatch $patterns[$i]) { return $false }
  }
  return $true
}

function Resolve-StandardNpmRuntime([string]$Npm) {
  $directory = Split-Path -Parent $Npm
  $runtime = [pscustomobject]@{
    Supported = $false
    Node = Join-Path $directory 'node.exe'
    NpmCli = Join-Path $directory 'node_modules\npm\bin\npm-cli.js'
  }
  try {
    if ([IO.Path]::GetFileName($Npm) -ine 'npm.cmd') { return $runtime }
    foreach ($path in @($Npm, $runtime.Node, $runtime.NpmCli)) {
      $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
      if ($item -isnot [IO.FileInfo] -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $runtime }
    }
    if (-not (Test-StandardNpmShim ([IO.File]::ReadAllText($Npm)))) { return $runtime }
    $runtime.Supported = $true
  } catch { return $runtime }
  return $runtime
}

function Write-NpmFailure($Result, [Diagnostics.ProcessStartInfo]$Info, [string]$Npm, [string]$Temp, $Runtime) {
  Initialize-NpmLogIO
  Write-Log "npm_exit_code=$($Result.ExitCode)"
  foreach ($stream in @(@{ Name = 'stdout'; Text = $Result.Output }, @{ Name = 'stderr'; Text = $Result.Errors })) {
    if ($stream.Text) {
      $lines = ([regex]::Replace($stream.Text, '\r?\n\z', '') -split "`r?`n") | Select-Object -Last 40
      foreach ($line in $lines) {
        $safe = Protect-NpmOutput $line
        [MachinePrepLogIO]::Append($LogDir, "$($stream.Name): $safe`r`n")
      }
    }
  }
  # Version probes may create their own debug logs. Retain the install's newest
  # log first, before Install-Brain's finally removes the owned temporary tree.
  $debug = $null
  try { $debug = [MachinePrepLogIO]::ReadNewest($Temp) } catch { $debug = $null }
  if ($null -ne $debug) {
    $safe = Protect-NpmOutput $debug
    $name = [MachinePrepLogIO]::WriteNew($LogDir, $safe)
    Write-Log "npm_debug_log=saved file=$name"
  } else {
    Write-Log 'npm_debug_log=unavailable'
  }
  Write-Log (Protect-NpmOutput "npm_selected=$Npm")
  Write-Log (Protect-NpmOutput "npm_candidate_node=$($Runtime.Node)")
  Write-Log (Protect-NpmOutput "npm_candidate_entry_point=$($Runtime.NpmCli)")
  $npmCli = if ($Runtime.Supported) { $Runtime.NpmCli } else { 'unavailable' }
  Write-Log (Protect-NpmOutput "npm_entry_point=$npmCli")
  # An unsupported shim must not trigger the guessed adjacent npm, even for a
  # diagnostic version probe. Candidate paths above explain the refusal.
  if (-not $Runtime.Supported) { return }
  $installArguments = $Info.Arguments
  $installExecutable = $Info.FileName
  try {
    # Reuse the exact isolated PATH and execute every probe without cmd.
    $where = Join-Path $env:SystemRoot 'System32\where.exe'
    foreach ($probe in @(
      @{ Name = 'npm_path'; File = $where; Arguments = 'npm.cmd' },
      @{ Name = 'node_path'; File = $where; Arguments = 'node.exe' },
      @{ Name = 'node_version'; File = $installExecutable; Arguments = '--version' },
      @{ Name = 'npm_version'; File = $installExecutable; Arguments = ((ConvertTo-NativeArgument $npmCli) + ' --version') }
    )) {
      $Info.FileName = $probe.File
      $Info.Arguments = $probe.Arguments
      $value = 'unavailable'
      try {
        $child = [Diagnostics.Process]::Start($Info)
        try { $observed = Wait-RedirectedProcess $child } finally { $child.Dispose() }
        if ($observed.ExitCode -eq 0) { $value = $observed.Output.TrimEnd("`r", "`n") }
      } catch { $value = 'unavailable' }
      Write-Log (Protect-NpmOutput "$($probe.Name)=$value")
    }
  } finally { $Info.FileName = $installExecutable; $Info.Arguments = $installArguments }
}

function Show-NpmFailure($Result) {
  $text = "$($Result.Output)`n$($Result.Errors)"
  if ($text -match 'unsupported npm layout') {
    [Console]::Error.WriteLine("Financial Brain setup needs the standard Node.js install (npm next to node.exe). This PC uses a different npm setup. For help, send Financial Brain support this log: $LogFile")
    return
  }
  $reason = 'an unclassified npm error'
  if ($text -match 'node.*(not recognized|not found|no such file)|cannot find.*node') {
    $reason = 'npm could not find Node.js'
  } elseif ($text -match 'ENOTCACHED') {
    $reason = 'a package was not in the offline cache (ENOTCACHED)'
  } elseif ($text -match 'EACCES|EPERM|EAI_AGAIN|ENOTFOUND|ECONN|ETIMEDOUT|network|permission') {
    $reason = 'a network or permission error'
  }
  [Console]::Error.WriteLine("Financial Brain CLI install failed: $reason. For help, send Financial Brain support this log: $LogFile")
}

function Invoke-IsolatedNpm([string]$Npm, [string]$Prefix, [string]$Archive, [string]$Temp) {
  $cmd = Join-Path $env:SystemRoot "System32\cmd.exe"
  $info = [Diagnostics.ProcessStartInfo]::new()
  $runtime = Resolve-StandardNpmRuntime $Npm
  $node = $runtime.Node
  $npmCli = $runtime.NpmCli
  $info.FileName = $node
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.Arguments = (@($npmCli, 'install', '--global', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', $Prefix, $Archive) |
    ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '
  $info.EnvironmentVariables.Clear()
  foreach ($pair in @{
    SystemRoot = $env:SystemRoot; ComSpec = $cmd; USERPROFILE = $PrepHome; HOME = $PrepHome
    TEMP = $Temp; TMP = $Temp; PATH = ((Split-Path -Parent $Npm) + ";" + (Join-Path $env:SystemRoot "System32"))
    BRAIN_NO_WRANGLER_LOGIN = "1"; npm_config_userconfig = (Join-Path $Temp "npmrc")
    npm_config_cache = (Join-Path $Temp "npm-cache"); npm_config_update_notifier = "false"
  }.GetEnumerator()) { $info.EnvironmentVariables[$pair.Key] = [string]$pair.Value }
  [IO.File]::WriteAllText((Join-Path $Temp "npmrc"), "")
  [Console]::Out.WriteLine("NPM_ENVIRONMENT_ISOLATED=1")
  $process = $null
  try {
    [Console]::Out.WriteLine('NPM_LAYOUT_DECISION_REACHED=1')
    if (-not $runtime.Supported) {
      $result = [pscustomobject]@{ ExitCode = 1; Output = ''; Errors = 'unsupported npm layout' }
    } else {
      $process = [Diagnostics.Process]::Start($info)
      $result = Wait-RedirectedProcess $process
    }
    if ($result.ExitCode -ne 0) {
      try { Write-NpmFailure $result $info $Npm $Temp $runtime } catch {
        # A logging failure must not hide the npm failure or prevent cleanup.
        [Console]::Error.WriteLine("Machine Prep could not save all npm diagnostics.")
      }
      Show-NpmFailure $result
    }
    return [int]$result.ExitCode
  } finally {
    if ($process) { $process.Dispose() }
  }
}

function Set-InstallAttemptMarker([string]$Directory, [string]$AttemptId) {
  [IO.File]::WriteAllText((Join-Path $Directory ".financial-brain-install-attempt"), "$AttemptId`r`n")
  if (-not (Test-InstallAttemptOwnership $Directory $AttemptId)) { throw "install ownership marker readback failed" }
}

function Test-InstallAttemptOwnership([string]$Directory, [string]$AttemptId) {
  if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return $false }
  $item = Get-Item -LiteralPath $Directory -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
  $marker = Join-Path $Directory ".financial-brain-install-attempt"
  if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { return $false }
  return ([IO.File]::ReadAllText($marker)).TrimEnd("`r", "`n") -ceq $AttemptId
}

function Remove-OwnedInstallDirectory([string]$Directory, [string]$AttemptId) {
  Write-Output "CLEANUP_OWNERSHIP_DECISION_REACHED=1"
  if (-not (Test-InstallAttemptOwnership $Directory $AttemptId)) {
    [Console]::Error.WriteLine("CLEANUP_STOP_UNOWNED=1 path_role=installer_material")
    throw "cleanup refused unowned installer material"
  }
  [IO.Directory]::Delete($Directory, $true)
}

function Install-Brain {
  Test-Prefix $BrainPrefix
  if ($script:PrefixExitCode -ne 0) { throw "Financial Brain prefix collision" }
  # Keep the array: assigning an if-expression unrolls a one-item array to a scalar,
  # and .Count on a scalar or $null throws under Set-StrictMode -Version Latest.
  $npmPaths = @(if ($env:MACHINE_PREP_TEST_MODE -eq "1" -and $env:MACHINE_PREP_TEST_NPM_PATH) {
    $env:MACHINE_PREP_TEST_NPM_PATH
  } else {
    Get-ToolPaths "npm"
  })
  if ($npmPaths.Count -eq 0) { throw "npm is unavailable" }
  $attemptId = "attempt-$PID-$([Guid]::NewGuid().ToString('N'))"
  $temp = Join-Path ([IO.Path]::GetTempPath()) ("financial-brain-installer-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $temp -ErrorAction Stop | Out-Null
  Set-InstallAttemptMarker $temp $attemptId
  $lock = $null
  $stage = $null
  $publishedPrefixOwned = $false
  $installComplete = $false
  try {
    $archive = Join-Path $temp "brain-installer-$BrainVersion.tgz"
    Write-Output "DOWNLOAD_STARTED=1 kit_version=$BrainVersion"
    Receive-PinnedKit $archive
    Test-BrainKit $archive
    $lock = "$BrainPrefix.install.lock"
    Write-Output "INSTALL_LOCK_DECISION_REACHED=1"
    try { New-Item -ItemType Directory -Path $lock -ErrorAction Stop | Out-Null } catch { throw "another install owns the per-user install lock" }
    Set-InstallAttemptMarker $lock $attemptId
    Write-Output "INSTALL_LOCK_ACQUIRED=1"
    Write-Output "STAGE_ALLOCATION_DECISION_REACHED=1"
    $stage = if ($env:MACHINE_PREP_TEST_MODE -eq "1" -and $env:MACHINE_PREP_TEST_STAGE_PATH) {
      $env:MACHINE_PREP_TEST_STAGE_PATH
    } else {
      "$BrainPrefix.stage.$([Guid]::NewGuid().ToString('N'))"
    }
    try { New-Item -ItemType Directory -Path $stage -ErrorAction Stop | Out-Null } catch { throw "staging prefix collision" }
    Set-InstallAttemptMarker $stage $attemptId
    Write-Output "INSTALL_STARTED=1 kit_version=$BrainVersion"
    $npmExit = Invoke-IsolatedNpm $npmPaths[0] $stage $archive $temp
    if ($npmExit -ne 0) { throw "Financial Brain CLI install failed" }
    $packageJson = Join-Path $stage "node_modules\brain-installer\package.json"
    $brainCmd = Join-Path $stage "brain.cmd"
    if (-not (Test-Path -LiteralPath $packageJson -PathType Leaf) -or -not (Test-Path -LiteralPath $brainCmd -PathType Leaf)) {
      throw "installed Financial Brain readback failed"
    }
    $installedVersion = [string](([IO.File]::ReadAllText($packageJson) | ConvertFrom-Json).version)
    if ($installedVersion -cne $BrainVersion) { throw "installed Financial Brain version readback failed" }
    Write-Output "STAGED_PREFIX_VERIFIED=1"
    Write-Output "ATOMIC_PROMOTION_DECISION_REACHED=1"
    # Directory.Move is an atomic same-volume rename and throws when the exact
    # destination exists. It cannot move the stage inside a foreign directory.
    [IO.Directory]::Move($stage, $BrainPrefix)
    $publishedPrefixOwned = $true
    $stage = $null
    $publishedPackageJson = Join-Path $BrainPrefix "node_modules\brain-installer\package.json"
    $publishedBrainCmd = Join-Path $BrainPrefix "brain.cmd"
    if (-not (Test-Path -LiteralPath $publishedPackageJson -PathType Leaf) -or -not (Test-Path -LiteralPath $publishedBrainCmd -PathType Leaf)) {
      throw "atomic promotion readback failed"
    }
    $publishedVersion = [string](([IO.File]::ReadAllText($publishedPackageJson) | ConvertFrom-Json).version)
    if ($publishedVersion -cne $BrainVersion) { throw "atomic promotion version readback failed" }
    Write-Output "ATOMIC_PROMOTION_VERIFIED=1"
    Remove-OwnedInstallDirectory $lock $attemptId
    $lock = $null
    Remove-Item -LiteralPath (Join-Path $BrainPrefix ".financial-brain-install-attempt") -Force -ErrorAction Stop
    $installComplete = $true
    Write-Output "BRAIN_INSTALL_VERIFIED=1 version=$installedVersion"
  } finally {
    $cleanupFailure = $null
    foreach ($candidate in @(
      $(if (-not $installComplete -and $publishedPrefixOwned) { $BrainPrefix }),
      $stage,
      $lock,
      $temp
    )) {
      if ($candidate -and (Test-Path -LiteralPath $candidate)) {
        try { Remove-OwnedInstallDirectory $candidate $attemptId } catch { if (-not $cleanupFailure) { $cleanupFailure = $_ } }
      }
    }
    if ($cleanupFailure) { throw $cleanupFailure }
  }
}

# CLI-only preparation shares the production download, verification, staging,
# promotion and cleanup path. It never opens setup or checks assistant logins.
function Invoke-CliPreparation {
  Write-Output "CLI_PREPARATION_SESSION_DECISION_REACHED=1"
  if ($env:MACHINE_PREP_TEST_MODE -eq "1" -or $FixtureDir) {
    throw "REFUSED CLI preparation while fixture/test mode is active"
  }
  if (-not (Test-StandardSession)) {
    throw "REFUSED CLI preparation requires normal current-user PowerShell"
  }
  Write-Output "CLI_PREPARATION_PREREQUISITE_DECISION_REACHED=1"
  $nodeVersion = Get-ToolVersion "node"
  if (-not $nodeVersion -or $nodeVersion -notmatch '^v(22|24)\.') {
    throw "REFUSED CLI preparation requires Node.js 22 or 24"
  }
  if (@(Get-ToolPaths "npm").Count -eq 0) { throw "REFUSED npm is unavailable" }
  Install-Brain
}

function Invoke-Real {
  $script:RealExitCode = 0
  if ($env:MACHINE_PREP_TEST_MODE -eq "1" -or $FixtureDir) {
    [Console]::Error.WriteLine("REFUSED real mode while fixture/test mode is active")
    $script:RealExitCode = 2
    return
  }
  if (-not (Test-StandardSession)) {
    [Console]::Error.WriteLine("REFUSED use a normal Start-menu PowerShell as the current user, never Administrator or a packaged app shell")
    $script:RealExitCode = 2
    return
  }
  Write-Output "Machine Prep for Windows"
  Write-Output "MODE real"
  Invoke-Checks | Out-Null
  Write-Output "PREREQUISITE_DECISION_REACHED=1"
  if ($script:GitState -ne "READY" -or $script:NodeState -ne "READY" -or $script:ClaudeState -ne "READY") {
    [Console]::Error.WriteLine("Financial Brain setup cannot start yet. Nothing was downloaded or installed.")
    [Console]::Error.WriteLine("What you need to do:")
    foreach ($step in $script:OwnerSteps) { [Console]::Error.WriteLine($step) }
    [Console]::Error.WriteLine("When everything above is done, open Run Financial Brain Machine Prep again from the Start menu.")
    # Keep optional information outside the required-action block on screen.
    Write-Output "Codex CLI (optional): $script:CodexDetail"
    $script:RealExitCode = 2
    return
  }
  Write-Output "Codex CLI (optional): $script:CodexDetail"
  if (Test-Path -LiteralPath $BrainPrefix) { Test-InstalledBrain $BrainPrefix; $script:RealExitCode = 2; return }
  # Mirrors install_brain || return 1 on macOS: the launcher shows this output,
  # and an uncaught error would add PowerShell's script path, which names the
  # owner's profile folder.
  try { Install-Brain } catch {
    [Console]::Error.WriteLine([string]$_.Exception.Message)
    $script:RealExitCode = 1
    return
  }
  Write-Output "Financial Brain CLI preparation completed"
}

switch ($Mode) {
  "--check" { Show-Check; if ($script:CheckFailures -eq 0) { exit 0 } else { exit 1 } }
  "--dry-run" { Show-Plan; exit 0 }
  "--real" { Invoke-Real; exit $script:RealExitCode }
  "--prepare-cli" { Invoke-CliPreparation; exit 0 }
  "--verify-checksum" {
    if ($args.Count -ne 3) { [Console]::Error.WriteLine("Usage: prep-windows.ps1 --verify-checksum FILE EXPECTED_SHA256"); exit 2 }
    Test-Checksum ([string]$args[1]) ([string]$args[2]); exit $script:ChecksumExitCode
  }
  "--verify-prefix" {
    if ($args.Count -ne 2) { [Console]::Error.WriteLine("Usage: prep-windows.ps1 --verify-prefix DIRECTORY"); exit 2 }
    Test-Prefix ([string]$args[1]); exit $script:PrefixExitCode
  }
  "--verify-installed" {
    if ($args.Count -ne 2) { [Console]::Error.WriteLine("Usage: prep-windows.ps1 --verify-installed DIRECTORY"); exit 2 }
    Test-InstalledBrain ([string]$args[1]); exit 2
  }
  "--test-copy-pinned-kit" {
    if ($env:MACHINE_PREP_TEST_MODE -ne "1" -or $args.Count -ne 4) { [Console]::Error.WriteLine("REFUSED invalid test copy invocation"); exit 2 }
    $source = [IO.File]::OpenRead([string]$args[1])
    try { Copy-PinnedKitStream $source ([string]$args[2]) ([long]$args[3]) } finally { $source.Dispose() }
    Write-Output "DOWNLOAD_WRITE_VERIFIED=1"
    exit 0
  }
  "--test-isolated-npm" {
    if ($env:MACHINE_PREP_TEST_MODE -ne "1" -or $args.Count -ne 5) { [Console]::Error.WriteLine("REFUSED invalid test process invocation"); exit 2 }
    $testExit = Invoke-IsolatedNpm ([string]$args[1]) ([string]$args[2]) ([string]$args[3]) ([string]$args[4])
    Write-Output "REDIRECTED_PROCESS_DECISION_REACHED=1 exit=$testExit"
    exit $testExit
  }
  "--test-install-brain" {
    if ($env:MACHINE_PREP_TEST_MODE -ne "1") { [Console]::Error.WriteLine("REFUSED test install outside test mode"); exit 2 }
    Install-Brain
    exit 0
  }
  "--help" { Write-Output "Usage: prep-windows.ps1 --check | --dry-run | --real | --prepare-cli | --verify-prefix DIRECTORY | --verify-installed DIRECTORY"; exit 0 }
  default { [Console]::Error.WriteLine("Usage: prep-windows.ps1 --check | --dry-run | --real | --prepare-cli | --verify-prefix DIRECTORY | --verify-installed DIRECTORY"); exit 2 }
}
