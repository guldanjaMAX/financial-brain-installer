# Financial Brain prerequisite preparation for Windows.
# --check and --dry-run are read-only. Real mode is deliberately per-user.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$NodeVersion = "24.13.1"
$ClaudeVersion = "2.1.261"
$CodexVersion = "0.155.0-alpha.16"
$BrainVersion = "0.4.8"
$WranglerVersion = "4.131.1"
$Mode = if ($args.Count -gt 0) { [string]$args[0] } else { "--real" }
$FixtureDir = [string]$env:MACHINE_PREP_FIXTURE_DIR
$PrepHome = if ($env:MACHINE_PREP_HOME) { $env:MACHINE_PREP_HOME } elseif ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$LocalRoot = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $PrepHome "AppData\Local" }
$ToolsRoot = Join-Path $LocalRoot "FinancialBrainTools"
$NpmPrefix = Join-Path $ToolsRoot "npm"
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
    Write-Status $script:NodeState "Node.js" "install pinned v$NodeVersion; fix: run --real"
  } elseif ($node -match '^v(22|24)\.') {
    $script:NodeState = "READY"
    Write-Status $script:NodeState "Node.js" $node
  } else {
    $script:NodeState = "WRONG_VERSION"
    Write-Status $script:NodeState "Node.js" "$node; supported majors are 22 and 24; fix: run --real"
  }

  $npm = Get-ToolVersion "npm"
  if ($npm) { Write-Status "READY" "npm" $npm } else { Write-Status "MISSING" "npm" "install with Node.js; fix: run --real" }

  $git = Get-ToolVersion "git"
  if ($git) {
    $script:GitState = "READY"
    Write-Status $script:GitState "Git" $git
  } else {
    $script:GitState = "MISSING"
    Write-Status $script:GitState "Git" "install Git for Windows 2.54.0; fix: run --real"
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
    Write-Status $script:ClaudeState "Claude Code" "install pinned $ClaudeVersion; fix: run --real"
  } elseif ($claude.Contains($ClaudeVersion)) {
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
    Write-Status $script:CodexState "Codex CLI" "install pinned $CodexVersion; fix: run --real"
  } elseif ($codex.Contains($CodexVersion)) {
    $script:CodexState = "READY"
    Write-Status $script:CodexState "Codex CLI" $codex
  } else {
    $script:CodexState = "WRONG_VERSION"
    Write-Status $script:CodexState "Codex CLI" "$codex; expected $CodexVersion; fix: run --real"
  }

  $brainPaths = @(Get-ToolPaths "brain")
  $brain = Get-ToolVersion "brain"
  $canonicalBrain = Join-Path $LocalRoot "FinancialBrain\brain.cmd"
  if ($brainPaths.Count -gt 1) {
    $script:BrainState = "SHADOWED"
    Write-Status $script:BrainState "Financial Brain CLI" "$($brainPaths.Count) PATH matches; fix: remove the earlier PATH entry and reopen PowerShell"
  } elseif ($brainPaths.Count -eq 0) {
    $script:BrainState = "MISSING"
    Write-Status $script:BrainState "Financial Brain CLI" "held $BrainVersion candidate has no stable asset; fix: wait for the immutable release receipt"
  } elseif (-not [string]::Equals([IO.Path]::GetFullPath($brainPaths[0]), [IO.Path]::GetFullPath($canonicalBrain), [StringComparison]::OrdinalIgnoreCase)) {
    $script:BrainState = "SHADOWED"
    Write-Status $script:BrainState "Financial Brain CLI" "$($brainPaths[0]) resolves first; fix: put $canonicalBrain first on PATH"
  } elseif (-not $brain -or -not $brain.Contains($BrainVersion)) {
    $script:BrainState = "WRONG_VERSION"
    Write-Status $script:BrainState "Financial Brain CLI" "$(if ($brain) { $brain } else { 'unknown' }); expected $BrainVersion; fix: use the immutable stable installer when released"
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
  Write-Output "2. DOWNLOAD: Node.js v$NodeVersion from nodejs.org into the per-user tool directory."
  Write-Output "3. VERIFY: match the Node archive against the pinned release's official SHASUMS256.txt before extraction."
  Write-Output "4. INSTALL: Git for Windows 2.54.0 in current-user scope through Windows Package Manager if Git is missing."
  Write-Output "5. INSTALL: Anthropic Claude Code $ClaudeVersion from a saved official installer file; never pipe a download into PowerShell."
  Write-Output "6. INSTALL: OpenAI Codex CLI $CodexVersion from the exact official npm package into the per-user prefix."
  Write-Output "7. PATH: add only the two managed per-user directories through the User PATH API; never use setx."
  Write-Output "8. SKIP: do not install global Wrangler; Financial Brain owns wrangler@$WranglerVersion."
  Write-Output "9. HOLD: do not install Financial Brain until the published stable contract provides immutable bytes and a SHA-256 receipt."
  Write-Output "10. VERIFY: rerun --check and show the operator the green/red list."
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

function Install-Node {
  $arch = if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq [Runtime.InteropServices.Architecture]::X64) { "x64" } else { throw "Only Windows x64 is currently field-supported" }
  $archive = "node-v$NodeVersion-win-$arch.zip"
  $base = "https://nodejs.org/dist/v$NodeVersion"
  $target = Join-Path $ToolsRoot "node-v$NodeVersion-win-$arch"
  if (Test-Path -LiteralPath $target) { throw "Existing managed Node target is not ready; refusing to overwrite $target" }
  $temp = Join-Path ([IO.Path]::GetTempPath()) ("financial-brain-machine-prep-" + [Guid]::NewGuid().ToString("N"))
  [IO.Directory]::CreateDirectory($temp) | Out-Null
  try {
    $archivePath = Join-Path $temp $archive
    $sumsPath = Join-Path $temp "SHASUMS256.txt"
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$archive" -OutFile $archivePath
    Invoke-WebRequest -UseBasicParsing -Uri "$base/SHASUMS256.txt" -OutFile $sumsPath
    $line = Get-Content -LiteralPath $sumsPath | Where-Object { $_ -match ("\s" + [regex]::Escape($archive) + "$") } | Select-Object -First 1
    if (-not $line) { throw "Official Node checksum manifest does not name $archive" }
    $expected = ($line -split '\s+')[0]
    Test-Checksum $archivePath $expected
    if ($script:ChecksumExitCode -ne 0) { throw "Node archive checksum mismatch" }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $temp
    [IO.Directory]::CreateDirectory($ToolsRoot) | Out-Null
    Move-Item -LiteralPath (Join-Path $temp "node-v$NodeVersion-win-$arch") -Destination $target
    Add-UserPath @($target, $NpmPrefix)
    Write-Log "installed Node.js v$NodeVersion after SHA-256 verification"
  } finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
  }
}

function Install-Git {
  $winget = @(Get-Command winget.exe -CommandType Application -ErrorAction SilentlyContinue)[0]
  if (-not $winget) { throw "Windows Package Manager is missing; install App Installer from Microsoft, then rerun" }
  & $winget.Source install --id Git.Git --exact --version 2.54.0 --scope user --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw "Git for Windows install failed" }
  Write-Log "installed Git for Windows 2.54.0 in current-user scope"
}

function Install-Claude {
  $temp = Join-Path ([IO.Path]::GetTempPath()) ("financial-brain-machine-prep-" + [Guid]::NewGuid().ToString("N"))
  [IO.Directory]::CreateDirectory($temp) | Out-Null
  try {
    $installer = Join-Path $temp "claude-install.ps1"
    Invoke-WebRequest -UseBasicParsing -Uri "https://claude.ai/install.ps1" -OutFile $installer
    & $installer $ClaudeVersion
    if (-not $?) { throw "Claude Code native installer failed" }
    $claudeExe = Join-Path $PrepHome ".local\bin\claude.exe"
    if (-not (Test-Path -LiteralPath $claudeExe -PathType Leaf)) { throw "Claude installer did not create the official per-user executable" }
    $signature = Get-AuthenticodeSignature -LiteralPath $claudeExe
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) { throw "Claude executable signature verification failed" }
    $version = @(& $claudeExe --version 2>$null)
    if ($version.Count -eq 0 -or -not ([string]$version[0]).Contains($ClaudeVersion)) { throw "Claude executable version readback failed" }
    Write-Log "installed Claude Code $ClaudeVersion and verified its Authenticode signature and version"
  } finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
  }
}

function Install-Codex {
  $npmPaths = @(Get-ToolPaths "npm")
  if ($npmPaths.Count -eq 0) { throw "npm is unavailable after Node preparation" }
  [IO.Directory]::CreateDirectory($NpmPrefix) | Out-Null
  & $npmPaths[0] install --global --prefix $NpmPrefix --no-audit --no-fund "@openai/codex@$CodexVersion"
  if ($LASTEXITCODE -ne 0) { throw "Codex CLI install failed" }
  Add-UserPath @($NpmPrefix)
  Write-Log "installed OpenAI Codex CLI $CodexVersion through npm integrity verification"
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
  [IO.Directory]::CreateDirectory($ToolsRoot) | Out-Null
  [IO.Directory]::CreateDirectory($NpmPrefix) | Out-Null
  Write-Log "real mode started"
  if ($script:GitState -ne "READY") { Install-Git }
  if ($script:NodeState -ne "READY") { Install-Node }
  if ($script:ClaudeState -ne "READY") { Install-Claude }
  if ($script:CodexState -ne "READY") { Install-Codex }
  Write-Log "Financial Brain install held pending immutable stable package receipt"
  Write-Output "HOLD: Financial Brain $BrainVersion has no immutable stable customer asset. No Brain install was attempted."
  Write-Output "Log: $LogFile"
  Write-Output ""
  Show-Check
  if ($script:CheckFailures -ne 0) { $script:RealExitCode = 1 }
}

switch ($Mode) {
  "--check" { Show-Check; if ($script:CheckFailures -eq 0) { exit 0 } else { exit 1 } }
  "--dry-run" { Show-Plan; exit 0 }
  "--real" { Invoke-Real; exit $script:RealExitCode }
  "--verify-checksum" {
    if ($args.Count -ne 3) { [Console]::Error.WriteLine("Usage: prep-windows.ps1 --verify-checksum FILE EXPECTED_SHA256"); exit 2 }
    Test-Checksum ([string]$args[1]) ([string]$args[2]); exit $script:ChecksumExitCode
  }
  "--help" { Write-Output "Usage: prep-windows.ps1 --check | --dry-run | --real"; exit 0 }
  default { [Console]::Error.WriteLine("Usage: prep-windows.ps1 --check | --dry-run | --real"); exit 2 }
}
