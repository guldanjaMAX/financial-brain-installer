# Financial Brain prerequisite preparation for Windows.
# --check and --dry-run are read-only. Real mode is deliberately per-user.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$NodeVersion = "24.13.1"
$ClaudeVersion = "2.1.261"
$CodexVersion = "0.155.0-alpha.16"
$BrainVersion = "0.4.9"
$BrainKitUrl = "https://financialbrain.ai/kit/brain-installer-0.4.9-0555ad1972d7f8d6.tgz"
$BrainKitSize = 6668013
$BrainKitSha256 = "0555ad1972d7f8d6c1ded78a9fc4265f873cc4f4ce8c11fd04198cc5599409b2"
$WranglerVersion = "4.131.1"
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
$script:CodexState = "MISSING"
$script:BrainState = "MISSING"
$script:SessionState = "READY"
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
  if ($Name -eq "claude") {
    $canonical = Join-Path $PrepHome ".local\bin\claude.exe"
    if (-not [string]::Equals([IO.Path]::GetFullPath($paths[0]), [IO.Path]::GetFullPath($canonical), [StringComparison]::OrdinalIgnoreCase)) { return $null }
    $fileVersion = (Get-Item -LiteralPath $canonical).VersionInfo.ProductVersion
    if (-not $fileVersion) { return $null }
    return "$fileVersion (Claude Code)"
  }
  $output = @(& $paths[0] --version 2>$null)
  if ($output.Count -eq 0) { return $null }
  return [string]$output[0]
}

function Write-Status([string]$State, [string]$Label, [string]$Detail) {
  Write-Output ("{0,-14} {1,-23} {2}" -f $State, $Label, $Detail)
  if ($State -in @("MISSING", "WRONG_VERSION", "SHADOWED")) { $script:CheckFailures++ }
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

function Invoke-Checks {
  $script:CheckFailures = 0
  $node = Get-ToolVersion "node"
  if (-not $node) {
    $script:NodeState = "MISSING"
    Write-Status $script:NodeState "Node.js" "OWNER ACTION: install supported Node.js from its official signed installer"
  } elseif ($node -match '^v(22|24)\.') {
    $script:NodeState = "READY"
    Write-Status $script:NodeState "Node.js" $node
  } else {
    $script:NodeState = "WRONG_VERSION"
    Write-Status $script:NodeState "Node.js" "$node; OWNER ACTION: install supported major 22 or 24"
  }

  $npm = Get-ToolVersion "npm"
  if ($npm) { Write-Status "READY" "npm" $npm } else { Write-Status "MISSING" "npm" "OWNER ACTION: install it with supported Node.js" }

  $git = Get-ToolVersion "git"
  if ($git) {
    $script:GitState = "READY"
    Write-Status $script:GitState "Git" $git
  } else {
    $script:GitState = "MISSING"
    Write-Status $script:GitState "Git" "OWNER ACTION: install Git for Windows 2.54.0 from its official signed installer"
  }

  $claudePaths = @(Get-ToolPaths "claude")
  $claude = Get-ToolVersion "claude"
  $canonicalClaude = Join-Path $PrepHome ".local\bin\claude.exe"
  if ($claudePaths.Count -gt 1) {
    $script:ClaudeState = "SHADOWED"
    Write-Status $script:ClaudeState "Claude Code" "$($claudePaths.Count) PATH matches; fix: keep only the official per-user path"
  } elseif ($claudePaths.Count -eq 1 -and -not [string]::Equals([IO.Path]::GetFullPath($claudePaths[0]), [IO.Path]::GetFullPath($canonicalClaude), [StringComparison]::OrdinalIgnoreCase)) {
    $script:ClaudeState = "SHADOWED"
    Write-Status $script:ClaudeState "Claude Code" "$($claudePaths[0]) resolves first; fix: put $canonicalClaude first on PATH"
  } elseif (-not $claude) {
    $script:ClaudeState = "MISSING"
    Write-Status $script:ClaudeState "Claude Code" "OWNER ACTION: install pinned $ClaudeVersion from the official signed installer"
  } elseif ($claude -ceq "$ClaudeVersion (Claude Code)") {
    $script:ClaudeState = "READY"
    Write-Status $script:ClaudeState "Claude Code" $claude
  } else {
    $script:ClaudeState = "WRONG_VERSION"
    Write-Status $script:ClaudeState "Claude Code" "$claude; expected $ClaudeVersion; fix: run --real"
  }

  $codexPaths = @(Get-ToolPaths "codex")
  $codex = Get-ToolVersion "codex"
  $canonicalCodex = Join-Path $NpmPrefix "codex.cmd"
  if ($codexPaths.Count -gt 1) {
    $script:CodexState = "SHADOWED"
    Write-Status $script:CodexState "Codex CLI" "$($codexPaths.Count) PATH matches; fix: keep only the managed per-user path"
  } elseif ($codexPaths.Count -eq 1 -and -not [string]::Equals([IO.Path]::GetFullPath($codexPaths[0]), [IO.Path]::GetFullPath($canonicalCodex), [StringComparison]::OrdinalIgnoreCase)) {
    $script:CodexState = "SHADOWED"
    Write-Status $script:CodexState "Codex CLI" "$($codexPaths[0]) resolves first; fix: put $canonicalCodex first on PATH"
  } elseif (-not $codex) {
    $script:CodexState = "MISSING"
    Write-Status $script:CodexState "Codex CLI" "OWNER ACTION: install pinned $CodexVersion from the official package"
  } elseif ($codex -ceq "codex-cli $CodexVersion") {
    $script:CodexState = "READY"
    Write-Status $script:CodexState "Codex CLI" $codex
  } else {
    $script:CodexState = "WRONG_VERSION"
    Write-Status $script:CodexState "Codex CLI" "$codex; expected $CodexVersion; fix: run --real"
  }

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
  Write-Output "2. OWNER ACTION: install any missing Node.js, Git, Claude Code, or Codex prerequisite from its official signed installer, then rerun this launcher."
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
  [IO.Directory]::CreateDirectory($LogDir) | Out-Null
  $stamp = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow, "US Mountain Standard Time").ToString("yyyy-MM-ddTHH:mm:sszzz")
  [IO.File]::AppendAllText($LogFile, "$stamp $Message`r`n")
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
}

function Invoke-IsolatedNpm([string]$Npm, [string]$Prefix, [string]$Archive, [string]$Temp) {
  $cmd = Join-Path $env:SystemRoot "System32\cmd.exe"
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $cmd
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $quoted = @($Npm, $Prefix, $Archive) | ForEach-Object { '"' + $_.Replace('"', '""') + '"' }
  $info.Arguments = "/d /s /c `"`"$($quoted[0])`" install --global --ignore-scripts --no-audit --no-fund --prefix $($quoted[1]) $($quoted[2])`""
  $info.EnvironmentVariables.Clear()
  foreach ($pair in @{
    SystemRoot = $env:SystemRoot; ComSpec = $cmd; USERPROFILE = $PrepHome; HOME = $PrepHome
    TEMP = $Temp; TMP = $Temp; PATH = ((Split-Path -Parent $Npm) + ";" + (Join-Path $env:SystemRoot "System32"))
    BRAIN_NO_WRANGLER_LOGIN = "1"; npm_config_userconfig = (Join-Path $Temp "npmrc")
    npm_config_cache = (Join-Path $Temp "npm-cache"); npm_config_update_notifier = "false"
  }.GetEnumerator()) { $info.EnvironmentVariables[$pair.Key] = [string]$pair.Value }
  [IO.File]::WriteAllText((Join-Path $Temp "npmrc"), "")
  [Console]::Out.WriteLine("NPM_ENVIRONMENT_ISOLATED=1")
  $process = [Diagnostics.Process]::Start($info)
  try {
    Wait-RedirectedProcess $process
    return [int]$process.ExitCode
  } finally {
    $process.Dispose()
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
  $npmPaths = if ($env:MACHINE_PREP_TEST_MODE -eq "1" -and $env:MACHINE_PREP_TEST_NPM_PATH) {
    @($env:MACHINE_PREP_TEST_NPM_PATH)
  } else {
    @(Get-ToolPaths "npm")
  }
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
  if ($script:GitState -ne "READY" -or $script:NodeState -ne "READY" -or $script:ClaudeState -ne "READY" -or $script:CodexState -ne "READY") {
    [Console]::Error.WriteLine("OWNER ACTION: install the missing prerequisite from its official signed installer, then rerun. No prerequisite was downloaded or executed.")
    $script:RealExitCode = 2
    return
  }
  if (Test-Path -LiteralPath $BrainPrefix) { Test-InstalledBrain $BrainPrefix; $script:RealExitCode = 2; return }
  Install-Brain
  Write-Output "Financial Brain CLI preparation completed"
}

switch ($Mode) {
  "--check" { Show-Check; if ($script:CheckFailures -eq 0) { exit 0 } else { exit 1 } }
  "--dry-run" { Show-Plan; exit 0 }
  "--real" { Invoke-Real; exit $script:RealExitCode }
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
  "--help" { Write-Output "Usage: prep-windows.ps1 --check | --dry-run | --real | --verify-prefix DIRECTORY | --verify-installed DIRECTORY"; exit 0 }
  default { [Console]::Error.WriteLine("Usage: prep-windows.ps1 --check | --dry-run | --real | --verify-prefix DIRECTORY | --verify-installed DIRECTORY"); exit 2 }
}
