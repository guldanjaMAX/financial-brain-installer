<#
  brain-windows-update.ps1 — Windows Brain, 0.4.0/0.4.1 -> 0.4.8, CANDIDATE build e44a38b.
  Reusable for a pre-0.4.4 Brain the week of 2026-09-21 (WEEKEND-PLAN B4).

  THE HONESTY LINE, FIRST, BECAUSE EVERYTHING ELSE DEPENDS ON IT
    The offline selftest is executed on Windows PowerShell 5.1 and PowerShell 7 in GitHub Actions.
    No mode has contacted or changed a Brain on Windows. The field logic is written from the
    shipped 0.4.8 CLI read on 2026-09-17 and from the Mac kit it mirrors.
    Sunday 2026-09-20 is a READ-ONLY REHEARSAL: discover, install, preview. `apply` exists, and it
    is gated so hard that on this Brain it cannot run at all today — see PREVIEW, below.

  WHAT WE EXPECT TO HAPPEN ON SUNDAY, AND WHY IT IS A PASS, NOT A FAILURE
    Verified in git: the Worker only began reporting its own `version` on /documents in 0.4.4.
    The supported starting versions are 0.4.0 and 0.4.1, whose deployed Workers do not report it.
    The 0.4.8 preview's MODERN path requires inventory.version to equal the manifest's recorded
    version (operations/update-preview.mjs:1271-1276), and the legacy-observation fallback is
    gated on recordedVersion === "0.4.6" (brain.mjs:23555-23557, update-preview.mjs:1410) — which
    is another update path, not this one. So the preview is EXPECTED TO REFUSE here, with
    UPDATE_PREVIEW_READINESS_RECEIPT_INVALID or UPDATE_PREVIEW_DEPLOYED_GENERATION_MISMATCH.
    Capturing that refusal cleanly IS Sunday's deliverable (WEEKEND-PLAN E8). `preview` exits 3
    on it, prints what to send back, and stops. `apply` refuses to run without a MODERN plan.

  MODES
    discover        read-only, NO NETWORK AT ALL. Node/npm/CLI versions, manifest detection,
                    recorded version, prefix state, kit integrity. The Brain is never contacted.
    install         npm.cmd install --global --prefix <kit>\prefix <tgz>, then all five
                    candidate-build signatures (the bank-feed module is #4), the CLI version,
                    and the wrapper usage check.
    preview         health, then ONE read-only `brain update --preview`. Classifies the result:
                      modern plan            -> prints the approval sentence, exit 0
                      expected pre-0.4.4     -> prints EXPECTED REFUSAL, exit 3
                      anything else          -> STOP, exit 4
    apply -Run -Approval "<sentence>"
                    only reachable after a MODERN plan. Re-previews, requires plan-fingerprint
                    equality and a byte-exact sentence, then ONE bare `brain update <manifest>`,
                    then the readback.
    resume-preview  for ONE other state and no other: an update that STOPPED with the Brain left
                    PAUSED mid-update, new Worker already deployed. Two spaced read-only looks
                    (health, wait, preview), both expected to exit NON-ZERO. Prints the RESUME
                    sentence, bound to a paused-state OBSERVATION fingerprint and to the MINUTE
                    it was taken.
    resume -Run -Approval "<sentence>"
                    re-observes, refuses unless the fingerprint still matches AND the observation
                    the operator was shown is less than 20 minutes old, then ONE update + the readback.
    selftest        offline. No network, no Brain, no install. Fake profile directories and
                    fixtures only. Proves this script's own logic and nothing else.

  EXIT CODES
    0   the mode did what it is for
    2   selftest had failures
    3   preview: the EXPECTED pre-0.4.4 refusal. Stop, send the receipts folder to the technician.
    4   preview: a receipt that is neither a modern plan nor the expected refusal. STOP.
    64  usage error (bad mode or missing switch)
    65  any other hard stop: kit, guards, prefix, approval, freshness, observation

  WINDOWS RULES BAKED IN (from the Sep 4 / Sep 8 field writeups and the shipped CLI)
    * PowerShell 5.1 AND 7. No ternary, no ??, no &&/||, no -AsHashtable, no bare $IsWindows.
      Script file only — nothing here is meant to be pasted line by line at a prompt.
    * npm.cmd / npx.cmd, never bare npm / npx: a restricted execution policy blocks the .ps1 shims.
    * Explicit --prefix always; never a bare `npm i -g` (an MSIX shell redirects %APPDATA%).
    * A prefix path with a space is refused: cmd.exe re-parses arguments (doctor.mjs:111-113).
      Every path this script passes is fully quoted anyway.
    * Get-FileHash -Algorithm SHA256 for every hash.
    * No token is ever printed, prompted for, or written. The CLI refuses Cloudflare token entry
      on Windows outright (brain.mjs:790-812) — browser sign-in is the only path. If any prompt
      is ever needed for a NON-Cloudflare secret, it is Read-Host -AsSecureString; no mode here
      prompts for anything.
    * curl.exe, never curl. This script does not use either.

  Options (any mode): -Manifest PATH  -Prefix PATH  -NodePath PATH  -NpmCmd PATH  -Out DIR
                      -Kit DIR  -Subject "NAME"  -Run  -Approval "<sentence>"

  Never Ctrl-C the update. Never retry it. Never clear VECTOR_DRAIN_MODE by hand. Never restore
  the D1 bookmark. On any STOP: save the output, report, do nothing else that session.
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string] $Mode = 'help',

    [string] $Manifest = '',
    [string] $Prefix   = '',
    [string] $NodePath = '',
    [string] $NpmCmd   = '',
    [string] $Out      = '',
    [string] $Kit      = '',
    [string] $Subject  = '',
    [switch] $Run,
    [string] $Approval = '',

    # selftest / internal only. Never used in the field.
    [string] $Pos1 = '',
    [string] $Pos2 = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- constants

$ExpectHeadSha     = 'e44a38b5c9d562ff98f81b7d5a8cd1f581c938d1'
$ExpectBuild       = 'e44a38b'
$ExpectVersion     = '0.4.8'
# This kit is for a PRE-0.4.4 Brain at 0.4.0 or 0.4.1. A 0.4.6 Brain takes the
# legacy-observation path this script does not implement — that is the Mac kit's path.
$ExpectFromVersions = @('0.4.0', '0.4.1')
$ExpectPkgSha      = 'c6363a24ca4f7b369753f964ed8624920113074d634ace61975f430d13ecabf3'
$ExpectRuntimeSha  = 'ad5ed8102fec8fb002c66ccef043348c65f8158ed506cb57512edff05327bc37'
$FixLine           = 'Math.max(limit, docs.length)'
$MinNodeMajor      = 22
$ResumeObsSpacingSeconds = 12    # one request stream at a time on the Brain
$ResumeObsMaxAgeSeconds  = 1200  # 20 minutes. A resume sentence authorizes ONE resume of the
                                 # state the operator was SHOWN, not that state whenever it is next pasted.
$SourcesQuietSeconds     = 65    # `brain sources` 503s if it follows `brain check` too closely
                                 # (measured: check 17:35:22, sources 17:35:23 -> HTTP 503).

$ExpectedRefusalCodes = @('UPDATE_PREVIEW_READINESS_RECEIPT_INVALID',
                          'UPDATE_PREVIEW_DEPLOYED_GENERATION_MISMATCH')
$PausedRefusalCodes   = @('UPDATE_PREVIEW_DEPLOYED_DRAIN_PAUSED',
                          'UPDATE_PREVIEW_DEPLOYED_GENERATION_MISMATCH')
$PauseSentence        = 'this Brain is paused for an update and cannot accept documents'

$script:ExitStop            = 65
$script:ExitUsage           = 64
$script:ExitExpectedRefusal = 3
$script:ExitUnclassified    = 4

# ---------------------------------------------------------------- paths

if ([string]::IsNullOrEmpty($Kit)) {
    $script:KitDir = Split-Path -Parent $PSCommandPath
} else {
    $script:KitDir = $Kit
}
$script:ScriptFileName = Split-Path -Leaf $PSCommandPath
$script:PkgPath  = Join-Path $script:KitDir 'brain-installer-0.4.8.tgz'
$script:RcptPath = Join-Path $script:KitDir 'field-prepare-receipt.json'
$script:SumsPath = Join-Path $script:KitDir 'SHA256SUMS'

if ([string]::IsNullOrEmpty($Out)) {
    $script:OutDir = Join-Path $script:KitDir 'receipts'
} else {
    $script:OutDir = $Out
}
if ([string]::IsNullOrEmpty($Prefix)) {
    $script:PrefixDir = Join-Path $script:KitDir 'prefix'
} else {
    $script:PrefixDir = $Prefix
}

$script:LogPath      = Join-Path $script:OutDir 'brain-windows-update.log'
$script:IdentityPath = Join-Path $script:OutDir 'kit-identity.txt'
$script:ResumeFpPath = Join-Path $script:OutDir 'resume-observation-fingerprint.txt'

$script:NodeExe   = ''
$script:NpmCmdExe = ''
$script:CliPath   = ''
$script:ManifestPath = ''
$script:PkgSha = ''; $script:RuntimeSha = ''; $script:PkgBytes = 0; $script:PkgFiles = 0
$script:InstalledCliSha = ''; $script:NodeSha = ''
$script:PlanFingerprint = ''; $script:PlanVectors = ''
$script:ResumeObsFp = ''; $script:ResumeObsAt = ''
$script:ResumeRecordedFp = ''; $script:ResumeRecordedAt = ''; $script:ResumeRecordedAge = 0
$script:HeldWriterLock = ''

# ---------------------------------------------------------------- output helpers

function New-KitDirectory {
    param([string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

New-KitDirectory -Path $script:OutDir

function Write-Utf8NoBom {
    param([string] $Path, [string] $Text)
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $enc)
}

function Say {
    param([string] $Text = '')
    Write-Output $Text
    try { Add-Content -LiteralPath $script:LogPath -Value $Text -Encoding UTF8 } catch { }
}

function Log {
    param([string] $Text = '')
    Say ('[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $Text)
}

function Stop-Kit {
    param([string] $Text)
    Say ''
    Say ('STOP: ' + $Text)
    if (-not [string]::IsNullOrEmpty($script:HeldWriterLock)) {
        Exit-WriterLock -Lock $script:HeldWriterLock
    }
    exit $script:ExitStop
}

function Stop-Usage {
    param([string] $Text)
    Say ('USAGE: ' + $Text)
    exit $script:ExitUsage
}

# ---------------------------------------------------------------- platform

function Test-IsWindowsHost {
    # $IsWindows does not exist in PowerShell 5.1, and Set-StrictMode makes touching an
    # undefined variable a terminating error, so it is probed rather than read.
    if ($PSVersionTable.PSVersion.Major -lt 6) { return $true }
    $v = Get-Variable -Name 'IsWindows' -ErrorAction SilentlyContinue
    if ($null -eq $v) { return $true }
    return [bool] $v.Value
}

function Get-ProfileDir {
    # The user's profile root, for manifest detection. Windows: %USERPROFILE%. The selftest
    # points USERPROFILE / APPDATA / LOCALAPPDATA / HOME at a scratch directory, so nothing
    # in this script can reach a real installed Brain's state while it is testing itself.
    if (-not [string]::IsNullOrEmpty($env:USERPROFILE)) { return $env:USERPROFILE }
    if (-not [string]::IsNullOrEmpty($env:HOME))        { return $env:HOME }
    return (Get-Location).Path
}

# ---------------------------------------------------------------- hashing

function Get-Sha256OfFile {
    param([string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) { Stop-Kit ('cannot hash a file that is not there: ' + $Path) }
    $h = Get-FileHash -LiteralPath $Path -Algorithm SHA256
    return $h.Hash.ToLowerInvariant()
}

function Get-Sha256OfString {
    param([string] $Text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        $hash  = $sha.ComputeHash($bytes)
        $sb = New-Object System.Text.StringBuilder
        foreach ($b in $hash) { [void] $sb.Append($b.ToString('x2')) }
        return $sb.ToString()
    } finally {
        $sha.Dispose()
    }
}

# ---------------------------------------------------------------- safe JSON access

function Get-Prop {
    # Set-StrictMode turns a missing property into a terminating error, and every receipt this
    # script reads may legitimately be missing fields (that is often the finding). So nothing
    # reads a property with a dot; everything goes through here and gets $null for absent.
    param($Object, [string] $Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $null
    }
    $p = $Object.PSObject.Properties[$Name]
    if ($null -eq $p) { return $null }
    return $p.Value
}

function Get-PropPath {
    param($Object, [string] $Path)
    $cur = $Object
    foreach ($part in $Path.Split('.')) {
        $cur = Get-Prop -Object $cur -Name $part
        if ($null -eq $cur) { return $null }
    }
    return $cur
}

function Test-HasProp {
    param($Object, [string] $Name)
    if ($null -eq $Object) { return $false }
    if ($Object -is [System.Collections.IDictionary]) { return $Object.Contains($Name) }
    return ($null -ne $Object.PSObject.Properties[$Name])
}

function Get-PropNames {
    param($Object)
    if ($null -eq $Object) { return @() }
    if ($Object -is [System.Collections.IDictionary]) { return @($Object.Keys) }
    return @($Object.PSObject.Properties | ForEach-Object { $_.Name })
}

function Read-JsonReceipt {
    # The CLI may print human text before its JSON, exactly as the Mac kit's readers assume.
    # Read the LAST complete JSON object. A human log line may contain an earlier "{"; taking
    # the first brace to EOF would then hide a valid receipt. Braces inside JSON strings are not
    # structural. Returns $null when there is no parsable object; callers treat that as a finding.
    param([string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $raw = ''
    try { $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop } catch { return $null }
    if ($null -eq $raw -or $raw.Length -eq 0) { return $null }

    # Try opening braces from the end, balance forward while honoring JSON strings, and retain the
    # valid object whose closing brace is latest. When a root and a nested object share the same
    # final brace, the earlier opening brace wins, so the complete receipt is returned.
    $best = $null
    $bestEnd = -1
    $bestStart = [int]::MaxValue
    $searchAt = $raw.Length - 1
    while ($searchAt -ge 0) {
        $start = $raw.LastIndexOf('{', $searchAt)
        if ($start -lt 0) { break }
        $depth = 0
        $inString = $false
        $escaped = $false
        for ($i = $start; $i -lt $raw.Length; $i++) {
            $ch = $raw[$i]
            if ($inString) {
                if ($escaped) { $escaped = $false; continue }
                if ($ch -eq '\') { $escaped = $true; continue }
                if ($ch -eq '"') { $inString = $false }
                continue
            }
            if ($ch -eq '"') { $inString = $true; continue }
            if ($ch -eq '{') { $depth = $depth + 1; continue }
            if ($ch -eq '}') {
                $depth = $depth - 1
                if ($depth -eq 0) {
                    try {
                        $candidate = $raw.Substring($start, $i - $start + 1) | ConvertFrom-Json
                        if ($i -gt $bestEnd -or ($i -eq $bestEnd -and $start -lt $bestStart)) {
                            $best = $candidate
                            $bestEnd = $i
                            $bestStart = $start
                        }
                    } catch { }
                    break
                }
                if ($depth -lt 0) { break }
            }
        }
        $searchAt = $start - 1
    }
    return $best
}

# ---------------------------------------------------------------- canonical JSON (fingerprints)

function ConvertTo-CanonicalJson {
    # Byte-for-byte the same canonicalisation the Mac kit uses inside node:
    #   arrays in order, object keys sorted ordinally, JSON.stringify semantics for scalars,
    #   undefined/absent rendered as null. The paused-state observation fingerprint is a sha256
    #   over the output of this function, so the two kits produce comparable fingerprints.
    param($Value)
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [bool]) {
        if ($Value) { return 'true' }
        return 'false'
    }
    if ($Value -is [string]) {
        $sb = New-Object System.Text.StringBuilder
        [void] $sb.Append('"')
        foreach ($ch in $Value.ToCharArray()) {
            $c = [int] $ch
            if ($ch -eq '"') { [void] $sb.Append('\"') }
            elseif ($ch -eq '\') { [void] $sb.Append('\\') }
            elseif ($c -eq 8)  { [void] $sb.Append('\b') }
            elseif ($c -eq 9)  { [void] $sb.Append('\t') }
            elseif ($c -eq 10) { [void] $sb.Append('\n') }
            elseif ($c -eq 12) { [void] $sb.Append('\f') }
            elseif ($c -eq 13) { [void] $sb.Append('\r') }
            elseif ($c -lt 32) { [void] $sb.Append('\u' + $c.ToString('x4')) }
            else { [void] $sb.Append($ch) }
        }
        [void] $sb.Append('"')
        return $sb.ToString()
    }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [int16] -or $Value -is [byte]) {
        return $Value.ToString([System.Globalization.CultureInfo]::InvariantCulture)
    }
    if ($Value -is [double] -or $Value -is [decimal] -or $Value -is [single]) {
        $d = [double] $Value
        if ([math]::Floor($d) -eq $d -and [math]::Abs($d) -lt 1e15) {
            return ([long] $d).ToString([System.Globalization.CultureInfo]::InvariantCulture)
        }
        return $d.ToString('R', [System.Globalization.CultureInfo]::InvariantCulture)
    }
    # PowerShell arrays are also PSObjects. Test IList/array first or the object branch recurses
    # into the array's adapter properties forever.
    if ($Value -is [System.Collections.IList] -or $Value -is [array]) {
        $parts = @()
        foreach ($v in $Value) { $parts += (ConvertTo-CanonicalJson -Value $v) }
        return '[' + ($parts -join ',') + ']'
    }
    if ($Value -is [System.Collections.IDictionary] -or $Value -is [psobject] -or $Value -is [pscustomobject]) {
        # Ordinal sort, not the culture-sensitive default: the Mac kit's Object.keys().sort() is
        # UTF-16 code-unit order, and the two fingerprints have to agree.
        $names = [string[]] @(Get-PropNames -Object $Value)
        [System.Array]::Sort($names, [System.StringComparer]::Ordinal)
        $parts = @()
        foreach ($n in $names) {
            $parts += ((ConvertTo-CanonicalJson -Value ([string] $n)) + ':' +
                       (ConvertTo-CanonicalJson -Value (Get-Prop -Object $Value -Name $n)))
        }
        return '{' + ($parts -join ',') + '}'
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $parts = @()
        foreach ($v in $Value) { $parts += (ConvertTo-CanonicalJson -Value $v) }
        return '[' + ($parts -join ',') + ']'
    }
    return (ConvertTo-CanonicalJson -Value ([string] $Value))
}

# ---------------------------------------------------------------- running things

function ConvertTo-CmdArg {
    # Windows CRT argv quoting, done properly: a path with a space is fully quoted and
    # backslashes before a quote are doubled. Start-Process -ArgumentList does NOT quote for
    # you, and every path this script passes may contain a space.
    param([string] $Value)
    if ($Value -notmatch '[\s"]') { return $Value }
    $sb = New-Object System.Text.StringBuilder
    [void] $sb.Append('"')
    $backslashes = 0
    foreach ($ch in $Value.ToCharArray()) {
        if ($ch -eq '\') {
            $backslashes = $backslashes + 1
        } elseif ($ch -eq '"') {
            [void] $sb.Append('\' * ($backslashes * 2 + 1))
            [void] $sb.Append('"')
            $backslashes = 0
        } else {
            if ($backslashes -gt 0) { [void] $sb.Append('\' * $backslashes); $backslashes = 0 }
            [void] $sb.Append($ch)
        }
    }
    if ($backslashes -gt 0) { [void] $sb.Append('\' * ($backslashes * 2)) }
    [void] $sb.Append('"')
    return $sb.ToString()
}

function Invoke-Captured {
    # One external command, stdout and stderr to separate files, exit code returned.
    # Start-Process is used rather than the call operator because $ErrorActionPreference='Stop'
    # turns a native command's stderr into a terminating error under a 2>&1 redirect, and a
    # refusal that writes to stderr is exactly what several of these calls are FOR.
    param(
        [string] $FilePath,
        [string[]] $Arguments,
        [string] $StdoutPath,
        [string] $StderrPath
    )
    $quoted = @()
    foreach ($a in $Arguments) { $quoted += (ConvertTo-CmdArg -Value $a) }
    $start = @{
        FilePath = $FilePath
        NoNewWindow = $true
        Wait = $true
        PassThru = $true
        RedirectStandardOutput = $StdoutPath
        RedirectStandardError = $StderrPath
    }
    # Windows PowerShell 5.1 rejects an explicitly empty -ArgumentList. Omit the parameter on the
    # normal wrapper-usage path, where invoking a command with no arguments is intentional.
    if ($quoted.Count -gt 0) { $start.ArgumentList = $quoted }
    $p = Start-Process @start
    return [int] $p.ExitCode
}

function Invoke-BrainRead {
    # One read-only CLI call against the manifest. Returns the exit code; receipts land in $OutDir.
    param([string] $Stem, [string[]] $BrainArgs)
    $so = Join-Path $script:OutDir ($Stem + '.stdout')
    $se = Join-Path $script:OutDir ($Stem + '.stderr')
    $all = @($script:CliPath) + $BrainArgs
    $rc = Invoke-Captured -FilePath $script:NodeExe -Arguments $all -StdoutPath $so -StderrPath $se
    return $rc
}

# ---------------------------------------------------------------- node and npm

function Resolve-NodeExe {
    if (-not [string]::IsNullOrEmpty($NodePath)) {
        if (-not (Test-Path -LiteralPath $NodePath)) { Stop-Kit ('no node at ' + $NodePath) }
        $script:NodeExe = (Resolve-Path -LiteralPath $NodePath).Path
        return
    }
    $c = Get-Command -Name 'node' -CommandType Application -ErrorAction SilentlyContinue |
         Select-Object -First 1
    if ($null -eq $c) {
        Stop-Kit ('no node on PATH. Install Node ' + $MinNodeMajor +
                  ' or newer at a stable absolute path, or pass -NodePath <full path to node.exe>.')
    }
    # HIS node wins, and it must be the real executable path: this absolute path is baked into
    # the local registrations the update writes, so a shim is silent and permanent.
    $so = Join-Path $script:OutDir 'node-execpath.txt'
    $se = Join-Path $script:OutDir 'node-execpath.stderr'
    $rc = Invoke-Captured -FilePath $c.Source -Arguments @('-p', 'process.execPath') `
                          -StdoutPath $so -StderrPath $se
    if ($rc -eq 0) {
        $p = (Get-Content -LiteralPath $so -Raw).Trim()
        if (-not [string]::IsNullOrEmpty($p) -and (Test-Path -LiteralPath $p)) {
            $script:NodeExe = $p
            return
        }
    }
    $script:NodeExe = $c.Source
}

function Get-NodeInfo {
    # Returns a hashtable: version, major, arch, platform, sha256.
    $so = Join-Path $script:OutDir 'node-info.txt'
    $se = Join-Path $script:OutDir 'node-info.stderr'
    $expr = 'process.stdout.write([process.versions.node,process.arch,process.platform].join(" "))'
    $rc = Invoke-Captured -FilePath $script:NodeExe -Arguments @('-e', $expr) `
                          -StdoutPath $so -StderrPath $se
    if ($rc -ne 0) { Stop-Kit ('node at ' + $script:NodeExe + ' would not run (exit ' + $rc + ')') }
    $parts = ((Get-Content -LiteralPath $so -Raw).Trim() -split '\s+')
    $info = @{
        version  = $parts[0]
        major    = [int] ($parts[0].Split('.')[0])
        arch     = $parts[1]
        platform = $parts[2]
        sha256   = (Get-Sha256OfFile -Path $script:NodeExe)
    }
    return $info
}

function Test-NodeVersionManaged {
    param([string] $Path)
    $p = $Path.ToLowerInvariant()
    foreach ($m in @('\nvm\', '\nvm4w\', '\.nvm\', '\fnm\', '\volta\', '\nodist\',
                     '\.asdf\', '\nodenv\', '\mise\', '\scoop\apps\nodejs')) {
        if ($p.Contains($m)) { return $true }
    }
    return $false
}

function Resolve-NpmCmd {
    if (-not [string]::IsNullOrEmpty($NpmCmd)) {
        if (-not (Test-Path -LiteralPath $NpmCmd)) { Stop-Kit ('no npm at ' + $NpmCmd) }
        $script:NpmCmdExe = (Resolve-Path -LiteralPath $NpmCmd).Path
        return $true
    }
    # npm.cmd, never npm: a restricted execution policy blocks npm.ps1, and that is the single
    # most common Windows stop in the Sep 4 / Sep 8 writeups.
    foreach ($name in @('npm.cmd', 'npm')) {
        $c = Get-Command -Name $name -CommandType Application -ErrorAction SilentlyContinue |
             Where-Object { $_.Source -notlike '*.ps1' } | Select-Object -First 1
        if ($null -ne $c) { $script:NpmCmdExe = $c.Source; return $true }
    }
    $guess = Join-Path (Split-Path -Parent $script:NodeExe) 'npm.cmd'
    if (Test-Path -LiteralPath $guess) { $script:NpmCmdExe = $guess; return $true }
    return $false
}

# ---------------------------------------------------------------- kit integrity

function Test-Kit {
    # Nothing here trusts a typed constant for the package or runtime hash. The values come out
    # of SHA256SUMS and field-prepare-receipt.json at run time; the constants above are only
    # cross-checked against them, so a mismatch names which of the two is wrong.
    if (-not (Test-Path -LiteralPath $script:PkgPath))  { Stop-Kit ('package missing: ' + $script:PkgPath) }
    if (-not (Test-Path -LiteralPath $script:RcptPath)) { Stop-Kit ('preparation receipt missing: ' + $script:RcptPath) }
    if (-not (Test-Path -LiteralPath $script:SumsPath)) { Stop-Kit ('SHA256SUMS missing: ' + $script:SumsPath) }

    $report = @()
    $bad    = @()
    # The public and private copies use different descriptive filenames. Bind the script entry to
    # the file that is actually running and require exactly one Markdown guide, while preserving
    # the exact four-entry checksum contract.
    $expectedSumNames = @('brain-installer-0.4.8.tgz', 'field-prepare-receipt.json',
                          $script:ScriptFileName)
    $guideSumNames = @()
    $listedSumNames = @()
    foreach ($line in (Get-Content -LiteralPath $script:SumsPath)) {
        $t = $line.Trim()
        if ([string]::IsNullOrEmpty($t)) { continue }
        if (-not ($t -match '^([0-9a-fA-F]{64})\s+\*?(.+)$')) {
            $bad += ('unreadable SHA256SUMS line: ' + $t)
            continue
        }
        $want = $Matches[1].ToLowerInvariant()
        $name = $Matches[2].Trim()
        $listedSumNames += $name
        $isGuideName = [string]::Equals([System.IO.Path]::GetExtension($name), '.md',
                                        [System.StringComparison]::OrdinalIgnoreCase)
        if ($isGuideName) { $guideSumNames += $name }
        if ((-not ($expectedSumNames -contains $name)) -and (-not $isGuideName)) {
            $bad += ($name + ': UNEXPECTED entry in SHA256SUMS')
            continue
        }
        if (@($listedSumNames | Where-Object { [string]::Equals($_, $name, [System.StringComparison]::Ordinal) }).Count -gt 1) {
            $bad += ($name + ': DUPLICATE entry in SHA256SUMS')
            continue
        }
        $f = Join-Path $script:KitDir $name
        if (-not (Test-Path -LiteralPath $f)) { $bad += ($name + ': MISSING from the kit folder'); continue }
        $got = Get-Sha256OfFile -Path $f
        if ($got -ne $want) { $bad += ($name + ': SHA-256 MISMATCH'); $report += ($name + '  MISMATCH') }
        else { $report += ($name + '  OK') }
    }
    foreach ($name in $expectedSumNames) {
        $present = @($listedSumNames | Where-Object { [string]::Equals($_, $name, [System.StringComparison]::Ordinal) }).Count
        if ($present -eq 0) { $bad += ($name + ': MISSING from SHA256SUMS') }
    }
    if ($guideSumNames.Count -ne 1) {
        $bad += ('SHA256SUMS must contain exactly one Markdown guide entry; found ' + $guideSumNames.Count)
    }
    $expectedSumCount = $expectedSumNames.Count + 1
    if ($listedSumNames.Count -ne $expectedSumCount) {
        $bad += ('SHA256SUMS must contain exactly ' + $expectedSumCount +
                 ' entries; found ' + $listedSumNames.Count)
    }
    Write-Utf8NoBom -Path (Join-Path $script:OutDir 'kit-sha256-check.txt') -Text (($report + $bad) -join "`r`n")
    if ($bad.Count -gt 0) {
        foreach ($b in $bad) { Say ('  ' + $b) }
        Stop-Kit 'the kit files do not match SHA256SUMS. Do not install. Re-send the kit.'
    }

    $r = Read-JsonReceipt -Path $script:RcptPath
    if ($null -eq $r) { Stop-Kit 'the preparation receipt is not readable JSON — do not install' }

    $status = Get-Prop -Object $r -Name 'status'
    if ($status -ne 'source_preparation_passed') {
        Stop-Kit ('the preparation receipt status is "' + [string] $status + '", not source_preparation_passed — do not install')
    }
    $steps = Get-Prop -Object $r -Name 'steps'
    if ($null -eq $steps -or @($steps).Count -eq 0) { Stop-Kit 'the preparation receipt carries no steps — do not install' }
    foreach ($s in @($steps)) {
        $st = Get-Prop -Object $s -Name 'status'
        if ($st -ne 'passed') {
            Stop-Kit ('preparation step "' + [string] (Get-Prop -Object $s -Name 'id') +
                      '" is ' + [string] $st + ', not passed — this is not a full pass, do not install')
        }
    }
    $head = Get-PropPath -Object $r -Path 'source.head_sha'
    if ($head -ne $ExpectHeadSha) {
        Stop-Kit ('the receipt is for source head ' + [string] $head + ', not ' + $ExpectHeadSha + ' — do not install')
    }
    $clean = Get-PropPath -Object $r -Path 'source.working_tree_clean'
    if ($clean -ne $true) { Stop-Kit 'the receipt does not record a clean working tree — do not install' }

    $script:PkgSha     = [string] (Get-PropPath -Object $r -Path 'package.sha256')
    $script:RuntimeSha = [string] (Get-PropPath -Object $r -Path 'package.runtime_payload_sha256')
    $pkgName           = [string] (Get-PropPath -Object $r -Path 'package.filename')
    $pkgVersion        = [string] (Get-PropPath -Object $r -Path 'source.package_version')
    $bytesVal          = Get-PropPath -Object $r -Path 'package.bytes'
    $filesVal          = Get-PropPath -Object $r -Path 'package.file_count'
    if ($null -eq $bytesVal) { Stop-Kit 'the receipt does not record the package byte count' }
    $script:PkgBytes = [int64] $bytesVal
    if ($null -eq $filesVal) { $script:PkgFiles = 0 } else { $script:PkgFiles = [int] $filesVal }

    if ($pkgName -ne (Split-Path -Leaf $script:PkgPath)) {
        Stop-Kit ('the receipt names ' + $pkgName + ' but the kit holds ' + (Split-Path -Leaf $script:PkgPath))
    }
    if ($pkgVersion -ne $ExpectVersion) {
        Stop-Kit ('the receipt says version ' + $pkgVersion + ', expected ' + $ExpectVersion)
    }
    if ($script:PkgSha -ne $ExpectPkgSha) {
        Stop-Kit ('the receipt package SHA-256 ' + $script:PkgSha + ' is not the expected ' + $ExpectPkgSha)
    }
    if ($script:RuntimeSha -ne $ExpectRuntimeSha) {
        Stop-Kit ('the receipt runtime SHA-256 ' + $script:RuntimeSha + ' is not the expected ' + $ExpectRuntimeSha)
    }
    $actualSha   = Get-Sha256OfFile -Path $script:PkgPath
    $actualBytes = (Get-Item -LiteralPath $script:PkgPath).Length
    if ($actualSha -ne $script:PkgSha)       { Stop-Kit 'the package bytes do not match the receipt' }
    if ($actualBytes -ne $script:PkgBytes)   { Stop-Kit ('the package byte count (' + $actualBytes + ') does not match the receipt (' + $script:PkgBytes + ')') }

    Say ('kit verified: ' + (Split-Path -Leaf $script:PkgPath) + ' ' + $script:PkgBytes + ' bytes, ' + $script:PkgFiles + ' files')
    Say ('  package SHA-256 ' + $script:PkgSha)
    Say ('  runtime SHA-256 ' + $script:RuntimeSha)
    Say ('  source head     ' + $ExpectHeadSha)
}

# ---------------------------------------------------------------- manifest

function Get-ManifestCandidates {
    # Manifest detection under the user's profile. Read-only, and it never looks outside the
    # profile: nothing here scans the whole disk or reads any file it has not named.
    $root = Get-ProfileDir
    $cands = @()
    $pointers = @(
        (Join-Path $root '.financial-brain\state\installed-manifest.json'),
        (Join-Path $root '.financial-brain/state/installed-manifest.json')
    )
    if (-not [string]::IsNullOrEmpty($env:APPDATA)) {
        $pointers += (Join-Path $env:APPDATA 'FinancialBrain\state\installed-manifest.json')
    }
    if (-not [string]::IsNullOrEmpty($env:LOCALAPPDATA)) {
        $pointers += (Join-Path $env:LOCALAPPDATA 'FinancialBrain\state\installed-manifest.json')
    }
    $result = @{ pointers = @(); manifests = @() }
    foreach ($p in $pointers) {
        if (-not (Test-Path -LiteralPath $p)) { continue }
        $j = Read-JsonReceipt -Path $p
        $mp = Get-Prop -Object $j -Name 'manifest_path'
        $result.pointers += @{ pointer = $p; manifest_path = [string] $mp }
    }
    foreach ($dir in @((Join-Path $root 'brain-installer\instances'),
                       (Join-Path $root '.financial-brain\instances'),
                       (Join-Path $root 'FinancialBrain\instances'))) {
        if (-not (Test-Path -LiteralPath $dir)) { continue }
        $found = Get-ChildItem -LiteralPath $dir -Filter '*.manifest.json' -File -ErrorAction SilentlyContinue
        foreach ($f in $found) { $cands += $f.FullName }
    }
    $result.manifests = $cands
    return $result
}

function Resolve-ManifestPath {
    if (-not [string]::IsNullOrEmpty($Manifest)) {
        if (-not (Test-Path -LiteralPath $Manifest)) { Stop-Kit ('no manifest at ' + $Manifest) }
        $script:ManifestPath = (Resolve-Path -LiteralPath $Manifest).Path
        return
    }
    $c = Get-ManifestCandidates
    foreach ($p in $c.pointers) {
        if (-not [string]::IsNullOrEmpty($p.manifest_path) -and (Test-Path -LiteralPath $p.manifest_path)) {
            $script:ManifestPath = (Resolve-Path -LiteralPath $p.manifest_path).Path
            Say ('  manifest found via the remembered-manifest pointer: ' + $p.pointer)
            return
        }
    }
    if (@($c.manifests).Count -eq 1) {
        $script:ManifestPath = $c.manifests[0]
        Say ('  manifest found under the profile: ' + $script:ManifestPath)
        return
    }
    if (@($c.manifests).Count -gt 1) {
        Say '  more than one manifest is present under the profile:'
        foreach ($m in $c.manifests) { Say ('    ' + $m) }
        Stop-Kit 'more than one manifest was found — pass -Manifest "<the right one>" explicitly'
    }
    Stop-Kit 'no remembered-manifest pointer and no manifest under the profile — pass -Manifest "<his manifest .json>"'
}

function Get-ManifestValue {
    param([string] $Path)
    $j = Read-JsonReceipt -Path $script:ManifestPath
    if ($null -eq $j) { Stop-Kit ('the manifest at ' + $script:ManifestPath + ' is not readable JSON') }
    $v = Get-PropPath -Object $j -Path $Path
    if ($null -eq $v) { return '' }
    return [string] $v
}

function Show-ManifestFacts {
    # Settings only. No record, message, key or token is read or printed — presence, never value.
    $m = Read-JsonReceipt -Path $script:ManifestPath
    if ($null -eq $m) { Stop-Kit ('the manifest at ' + $script:ManifestPath + ' is not readable JSON') }
    $present = {
        param($v)
        if ($null -eq $v) { return 'absent' }
        if ($v -is [string] -and $v.Length -eq 0) { return 'absent' }
        return 'present'
    }
    $rows = @()
    $rows += ,@('brain name',        [string] (Get-PropPath -Object $m -Path 'brain.worker_name'))
    $rows += ,@('brain domain',      [string] (Get-PropPath -Object $m -Path 'brain.domain'))
    $rows += ,@('recorded version',  [string] (Get-PropPath -Object $m -Path 'brain.version'))
    $rows += ,@('client slug',       [string] (Get-PropPath -Object $m -Path 'client.slug'))
    $rows += ,@('client timezone',   [string] (Get-PropPath -Object $m -Path 'client.timezone'))
    $rows += ,@('client display_name', (& $present (Get-PropPath -Object $m -Path 'client.display_name')))
    $rows += ,@('storage backend',   [string] (Get-PropPath -Object $m -Path 'infrastructure.storage'))
    $rows += ,@('cloudflare auth_profile', (& $present (Get-PropPath -Object $m -Path 'infrastructure.cloudflare.auth_profile')))
    $rows += ,@('admin key locator', (& $present (Get-PropPath -Object $m -Path 'operations.admin_key_secret')))
    $corpora = Get-Prop -Object $m -Name 'corpora'
    $on = @(); $off = @()
    foreach ($n in (Get-PropNames -Object $corpora)) {
        $c = Get-Prop -Object $corpora -Name $n
        if ((Get-Prop -Object $c -Name 'enabled') -eq $true) { $on += $n } else { $off += $n }
    }
    if ($on.Count -gt 0)  { $rows += ,@('corpora enabled',  ($on  -join ', ')) } else { $rows += ,@('corpora enabled',  '(none)') }
    if ($off.Count -gt 0) { $rows += ,@('corpora disabled', ($off -join ', ')) } else { $rows += ,@('corpora disabled', '(none)') }
    $probes = Get-PropPath -Object $m -Path 'testing.probe_questions'
    if ($null -eq $probes) { $rows += ,@('probe_questions count', 'key absent') }
    else { $rows += ,@('probe_questions count', [string] @($probes).Count) }
    $rows += ,@('ingest_cron', [string] (Get-PropPath -Object $m -Path 'operations.ingest_cron'))
    $cap = Get-PropPath -Object $m -Path 'safety.daily_llm_spend_cap_usd'
    if ($null -eq $cap) { $rows += ,@('daily LLM spend cap in manifest (USD) - NOT the Cloudflare account limit', 'not present') }
    else { $rows += ,@('daily LLM spend cap in manifest (USD) - NOT the Cloudflare account limit', [string] $cap) }
    $rows += ,@('manifest_version', [string] (Get-PropPath -Object $m -Path 'manifest_version'))

    $w = 0
    foreach ($r in $rows) { if ($r[0].Length -gt $w) { $w = $r[0].Length } }
    foreach ($r in $rows) {
        $label = $r[0]
        while ($label.Length -lt $w) { $label = $label + ' ' }
        $val = $r[1]
        if ([string]::IsNullOrEmpty($val)) { $val = 'not present' }
        Say ('  ' + $label + ' : ' + $val)
    }
}

# ---------------------------------------------------------------- prefix verification

function Get-PrefixRoot {
    # npm on Windows installs a global package at <prefix>\node_modules\<name>, not at
    # <prefix>\lib\node_modules\<name> as it does on POSIX. Both are probed so that a prefix
    # made by either layout verifies, and the one that exists is what every later path uses.
    param([string] $PrefixPath)
    foreach ($rel in @('node_modules\brain-installer', 'lib\node_modules\brain-installer')) {
        $p = Join-Path $PrefixPath $rel
        if (Test-Path -LiteralPath (Join-Path $p 'brain.mjs')) { return $p }
    }
    return ''
}

function Test-Prefix {
    # CANDIDATE BUILD: five independent signatures, ALL required, each a hard stop. A CLI or
    # runtime hash alone cannot tell this build from one that is missing a fix, which is the
    # whole reason the Mac kit stopped relying on a single fix line.
    param([string] $PrefixPath)

    $root = Get-PrefixRoot -PrefixPath $PrefixPath
    if ([string]::IsNullOrEmpty($root)) {
        Stop-Kit ('no installed CLI under ' + $PrefixPath +
                  ' (looked for node_modules\brain-installer\brain.mjs and lib\node_modules\...). Run: install')
    }
    $script:CliPath = Join-Path $root 'brain.mjs'

    $worker      = Join-Path $root 'worker\src\index.js'
    $storeD1     = Join-Path $root 'worker\src\lib\store-d1.js'
    $ownerNotes  = Join-Path $root 'worker\src\lib\owner-notes.js'
    $bankFeed    = Join-Path $root 'operations\bank-feed-owner-secrets.mjs'
    $store       = Join-Path $root 'worker\src\lib\store.js'

    # The wrapper must print its usage. On Windows npm writes brain.cmd beside the prefix root.
    $wrapper = ''
    foreach ($w in @((Join-Path $PrefixPath 'brain.cmd'), (Join-Path $PrefixPath 'bin\brain.cmd'),
                     (Join-Path $PrefixPath 'bin\brain'))) {
        if (Test-Path -LiteralPath $w) { $wrapper = $w; break }
    }
    if ([string]::IsNullOrEmpty($wrapper)) {
        Say '  note: no brain.cmd shim was written beside the prefix. That is not a stop — every'
        Say '        command in this kit calls node with the full path to brain.mjs anyway.'
    } else {
        $so = Join-Path $script:OutDir 'prefix-wrapper-usage.txt'
        $se = Join-Path $script:OutDir 'prefix-wrapper-usage.stderr'
        Invoke-Captured -FilePath $wrapper -Arguments @() -StdoutPath $so -StderrPath $se | Out-Null
        $usage = ''
        foreach ($f in @($so, $se)) {
            if (Test-Path -LiteralPath $f) {
                $t = Get-Content -LiteralPath $f -Raw
                if ($null -ne $t) { $usage = $usage + $t }
            }
        }
        if ($usage.IndexOf('brain setup', [System.StringComparison]::Ordinal) -lt 0) {
            Stop-Kit ('the wrapper at ' + $wrapper + ' did not print the expected usage text (it should name "brain setup")')
        }
    }

    $so = Join-Path $script:OutDir 'prefix-cli-version.txt'
    $se = Join-Path $script:OutDir 'prefix-cli-version.stderr'
    $rc = Invoke-Captured -FilePath $script:NodeExe -Arguments @($script:CliPath, '--version') `
                          -StdoutPath $so -StderrPath $se
    $ver = ''
    if (Test-Path -LiteralPath $so) {
        $t = Get-Content -LiteralPath $so -Raw
        if ($null -ne $t -and $t.Trim().Length -gt 0) { $ver = ($t.Trim() -split "`n")[0].Trim() }
    }
    if (-not $ver.StartsWith($ExpectVersion, [System.StringComparison]::Ordinal)) {
        Stop-Kit ('the installed CLI reports "' + $ver + '" (exit ' + $rc + '), expected ' + $ExpectVersion + '*')
    }

    $sigs = @(
        @{ n = '1/5'; f = $worker;     s = $FixLine;                      once = $true;
           why = 'the c795716 evidence-contract fix line — on its own it is what used to be the ONLY check that told the fixed build from the broken 29a1075 build' },
        @{ n = '2/5'; f = $storeD1;    s = 'INVENTORY_DOCUMENT_CTES_SQL'; once = $false;
           why = 'the source-inventory fix (brain sources)' },
        @{ n = '3/5'; f = $ownerNotes; s = 'sweep receipt by construction'; once = $false;
           why = 'the owner-notes sweep receipt' },
        @{ n = '5/5'; f = $store;      s = 'revisionCommitReturned';      once = $false;
           why = 'the ingest-finalization fix (the D1 trigger changes false negative)' }
    )
    foreach ($sig in $sigs) {
        if (-not (Test-Path -LiteralPath $sig.f)) {
            Stop-Kit ('candidate-build check failed (' + $sig.n + '): ' + $sig.f + ' is missing from the installed prefix')
        }
        $hits = @(Select-String -LiteralPath $sig.f -SimpleMatch -Pattern $sig.s)
        if ($sig.once) {
            if ($hits.Count -ne 1) {
                Stop-Kit ('candidate-build check failed (' + $sig.n + '): "' + $sig.s + '" (' + $sig.why +
                          ') is not present exactly once in ' + $sig.f + ' (found ' + $hits.Count +
                          '). This is one of FIVE required signatures — do not proceed.')
            }
        } elseif ($hits.Count -lt 1) {
            Stop-Kit ('candidate-build check failed (' + $sig.n + '): "' + $sig.s + '" (' + $sig.why +
                      ') is not present in ' + $sig.f +
                      '. This is one of FIVE required candidate-build signatures — do not proceed.')
        }
        Say ('  signature ' + $sig.n + ' present')
    }
    # Signature 4/5 — the Plaid owner-custody module. Presence only, no content check.
    if (-not (Test-Path -LiteralPath $bankFeed)) {
        Stop-Kit ('candidate-build check failed (4/5): operations\bank-feed-owner-secrets.mjs (the bank-feed owner-custody module) is not present in the installed prefix. This is one of FIVE required candidate-build signatures — do not proceed.')
    }
    Say '  signature 4/5 present'

    $script:InstalledCliSha = Get-Sha256OfFile -Path $script:CliPath
    Say ('prefix verified: CLI ' + $ver + ', all five candidate-build signatures present, CLI SHA-256 ' + $script:InstalledCliSha)
}

# ---------------------------------------------------------------- identity and guards

function Save-Identity {
    $info = Get-NodeInfo
    $lines = @(
        ('recorded_at      ' + (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz')),
        ('node_path        ' + $script:NodeExe),
        ('node_version     ' + $info.version),
        ('node_arch_os     ' + $info.arch + ' ' + $info.platform),
        ('node_sha256      ' + $info.sha256),
        ('prefix           ' + $script:PrefixDir),
        ('cli_sha256       ' + $script:InstalledCliSha),
        ('package_sha256   ' + $script:PkgSha),
        ('runtime_sha256   ' + $script:RuntimeSha)
    )
    Write-Utf8NoBom -Path $script:IdentityPath -Text (($lines -join "`r`n") + "`r`n")
    $script:NodeSha = $info.sha256
    Say ('identity recorded to ' + $script:IdentityPath)
}

function Get-IdentityField {
    param([string] $Name)
    foreach ($line in (Get-Content -LiteralPath $script:IdentityPath)) {
        if ($line -match ('^' + [regex]::Escape($Name) + '\s+(.+)$')) { return $Matches[1].Trim() }
    }
    return ''
}

function Test-IdentityUnchanged {
    if (-not (Test-Path -LiteralPath $script:IdentityPath)) {
        Stop-Kit ('no recorded identity at ' + $script:IdentityPath + ' — run install first (it records the Node and CLI hashes)')
    }
    $wantNode    = Get-IdentityField -Name 'node_path'
    $wantNodeSha = Get-IdentityField -Name 'node_sha256'
    $wantCliSha  = Get-IdentityField -Name 'cli_sha256'
    if ($script:NodeExe -ne $wantNode) {
        Stop-Kit ('the Node path changed since install (' + $wantNode + ' -> ' + $script:NodeExe + ')')
    }
    $nowNodeSha = Get-Sha256OfFile -Path $script:NodeExe
    if ($nowNodeSha -ne $wantNodeSha) { Stop-Kit 'the Node binary changed since install' }
    $nowCliSha = Get-Sha256OfFile -Path $script:CliPath
    if ($nowCliSha -ne $wantCliSha)   { Stop-Kit 'the installed CLI changed since install' }
    $script:NodeSha = $wantNodeSha
    $script:InstalledCliSha = $wantCliSha
}

function Test-AcPower {
    if (-not (Test-IsWindowsHost)) { return $true }
    try {
        $bat = @(Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue)
    } catch {
        return $true
    }
    if ($bat.Count -eq 0) { return $true }   # a desktop: no battery, always on mains
    foreach ($b in $bat) {
        $s = Get-Prop -Object $b -Name 'BatteryStatus'
        # 2 = "AC power" per Win32_Battery. 6/7/8/9 are also charging/on-mains states.
        if ($s -eq 2 -or $s -eq 6 -or $s -eq 7 -or $s -eq 8 -or $s -eq 9) { return $true }
    }
    return $false
}

function Get-OtherBrainWriters {
    if (-not (Test-IsWindowsHost)) { return @() }
    $hits = @()
    try {
        $procs = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)
    } catch {
        return @()
    }
    foreach ($p in $procs) {
        $cl = Get-Prop -Object $p -Name 'CommandLine'
        if ($null -eq $cl) { continue }
        if ($cl -notmatch 'brain\.mjs|imessage-scheduler|curated-sync-scheduler|field-prepare') { continue }
        if ($cl -match 'brain-mcp\.mjs') { continue }      # the assistant connection is a reader
        if ($cl -match [regex]::Escape([System.IO.Path]::GetFileNameWithoutExtension($script:ScriptFileName))) { continue }
        if ((Get-Prop -Object $p -Name 'ProcessId') -eq $PID) { continue }
        $hits += ('pid ' + [string] (Get-Prop -Object $p -Name 'ProcessId'))
    }
    return $hits
}

function Get-RunningBrainScheduledTasks {
    if (-not (Test-IsWindowsHost)) { return @() }
    $names = @()
    $cmd = Get-Command -Name 'Get-ScheduledTask' -ErrorAction SilentlyContinue
    if ($null -eq $cmd) { return @() }
    try {
        $tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue |
                   Where-Object { $_.TaskName -match 'brain' })
    } catch {
        return @()
    }
    foreach ($t in $tasks) {
        if ((Get-Prop -Object $t -Name 'State') -eq 'Running') { $names += [string] $t.TaskName }
    }
    return $names
}

function Test-Guards {
    if (Test-NodeVersionManaged -Path $script:NodeExe) {
        Stop-Kit ('the Node at ' + $script:NodeExe + ' sits under a version manager. The update bakes this absolute path into the local registrations, so it must be a stable path. Point -NodePath at a real installed Node before going further.')
    }
    $info = Get-NodeInfo
    if ($info.major -lt $MinNodeMajor) {
        Stop-Kit ('Node major version ' + $info.major + ' is below the required ' + $MinNodeMajor)
    }
    if (Test-IsWindowsHost) {
        if ($info.arch -ne 'x64' -or $info.platform -ne 'win32') {
            Stop-Kit ('this CLI is x64 Windows only and refuses ARM64, including x64 Node under emulation. Node reports "' + $info.arch + ' ' + $info.platform + '", expected "x64 win32".')
        }
    }
    if (-not (Test-AcPower)) {
        Stop-Kit 'this PC is on battery. Plug it in; the update can run for a long time and must not be interrupted.'
    }
    $writers = Get-OtherBrainWriters
    if ($writers.Count -gt 0) {
        Stop-Kit ('another Brain writer is running (' + ($writers -join ', ') + '). Wait for it to finish; do not kill it.')
    }
    $tasks = Get-RunningBrainScheduledTasks
    if ($tasks.Count -gt 0) {
        Stop-Kit ('a Brain scheduled task is running right now (' + ($tasks -join ', ') + '). Wait for it to finish.')
    }
    if ([string]::IsNullOrEmpty($script:CliPath) -or -not (Test-Path -LiteralPath $script:CliPath)) {
        Stop-Kit ('no installed CLI under ' + $script:PrefixDir + ' — run: install')
    }
}

function Get-WriterLockPath {
    $t = $env:TEMP
    if ([string]::IsNullOrEmpty($t)) { $t = $env:TMPDIR }
    if ([string]::IsNullOrEmpty($t)) { $t = '/tmp' }
    return (Join-Path $t 'financial-brain-pilot-writer.lock')
}

function Enter-WriterLock {
    $lock = Get-WriterLockPath
    try {
        New-Item -ItemType Directory -Path $lock -ErrorAction Stop | Out-Null
    } catch {
        Stop-Kit ('another ceremony script holds ' + $lock + '. Only remove it if no update is running.')
    }
    $script:HeldWriterLock = $lock
    return $lock
}

function Exit-WriterLock {
    param([string] $Lock)
    if (-not [string]::IsNullOrEmpty($Lock)) {
        try { Remove-Item -LiteralPath $Lock -Force -Recurse -ErrorAction SilentlyContinue } catch { }
        if ([string]::Equals($script:HeldWriterLock, $Lock, [System.StringComparison]::Ordinal)) {
            $script:HeldWriterLock = ''
        }
    }
}

# ---------------------------------------------------------------- the approval sentences

# Both sentences — the ordinary update one and the RESUME one — are rendered from the SAME three
# blocks, so a clause can never be carried by one path and silently dropped by the other. The
# held-candidate disclosure is byte-identical to the corresponding Mac kit's
# SENTENCE_DISCLOSURE): it is the whole reason an owner is being asked to consent to a build
# that is not released, and it is not optional on either path.
$SentenceDisclosure = ' — a version that is not publicly released, whose own packaged technician guidance says a held candidate should not be used on a customer Brain, which the technician is installing as a supervised private pilot and will update until it is released — '
$SentenceTrail      = '; one attempt; no automatic retry; I understand that this also rewrites, on my PC, my manifest''s version field, the remembered-manifest pointer, my already-managed Claude Code and Codex Brain connections, a managed CLAUDE.md and the technician skill, and that in my Cloudflare account it enables the workers.dev route and may remove managed provider secrets the new version does not use.'
$SentenceCarve      = ' I understand my manifest has no Cloudflare sign-in profile yet, so signing in will add that one field and change its fingerprint, and that the technician must read me a fresh sentence if that happens before we start.'

function New-RenderedSentence {
    param(
        [string] $Opening,            # through the build
        [string] $ObservationClause,  # what binds this sentence to what was observed
        [string] $ManifestSha,
        [string] $PackageSha,
        [string] $RuntimeSha,
        [string] $NodeSha,
        [string] $CliSha,
        [string] $AuthState           # present | absent
    )
    $carve = ''
    if ($AuthState -eq 'absent') { $carve = $SentenceCarve }
    return ($Opening + $SentenceDisclosure +
            'using manifest SHA-256 ' + $ManifestSha + ', ' + $ObservationClause +
            ', package SHA-256 ' + $PackageSha +
            ', runtime SHA-256 ' + $RuntimeSha +
            ', Node SHA-256 ' + $NodeSha +
            ', and CLI SHA-256 ' + $CliSha +
            $SentenceTrail + $carve)
}

function New-UpdateSentence {
    param(
        [string] $BrainName, [string] $BrainDomain, [string] $FromVersion,
        [string] $ManifestSha, [string] $PlanFingerprint,
        [string] $PackageSha, [string] $RuntimeSha, [string] $NodeSha, [string] $CliSha,
        [string] $AuthState
    )
    return (New-RenderedSentence `
        -Opening ('I approve one update of ' + $BrainName + ' (' + $BrainDomain + ') from ' +
                  $FromVersion + ' to ' + $ExpectVersion + ' build ' + $ExpectBuild) `
        -ObservationClause ('plan fingerprint ' + $PlanFingerprint) `
        -ManifestSha $ManifestSha -PackageSha $PackageSha -RuntimeSha $RuntimeSha `
        -NodeSha $NodeSha -CliSha $CliSha -AuthState $AuthState)
}

function New-ResumeSentence {
    # Differs from the update sentence in EXACTLY two spans and nothing else:
    #   1. the opening clause gains "RESUME of the paused update ... (the paused generation
    #      already deployed)", because that is the true description of what one more
    #      `brain update` does from here; and
    #   2. the observation clause becomes "paused-state observation <fp> taken <ISO minute>",
    #      because the paused refusal carries no plan at all, and because that fingerprint is a
    #      pure function of STABLE values — without the minute, a sentence captured once would
    #      authorize a resume for ever.
    # The selftest diffs the two rendered sentences and FAILS on any third difference.
    param(
        [string] $BrainName, [string] $BrainDomain, [string] $FromVersion,
        [string] $ManifestSha, [string] $ObservationFingerprint, [string] $ObservedAt,
        [string] $PackageSha, [string] $RuntimeSha, [string] $NodeSha, [string] $CliSha,
        [string] $AuthState
    )
    if ([string]::IsNullOrEmpty($ObservedAt)) {
        Stop-Kit 'the RESUME sentence needs the time the paused-state observation was taken'
    }
    return (New-RenderedSentence `
        -Opening ('I approve one RESUME of the paused update of ' + $BrainName + ' (' + $BrainDomain +
                  ') from ' + $FromVersion + ' to ' + $ExpectVersion + ' build ' + $ExpectBuild +
                  ' (the paused generation already deployed)') `
        -ObservationClause ('paused-state observation ' + $ObservationFingerprint + ' taken ' + $ObservedAt) `
        -ManifestSha $ManifestSha -PackageSha $PackageSha -RuntimeSha $RuntimeSha `
        -NodeSha $NodeSha -CliSha $CliSha -AuthState $AuthState)
}

function Test-ApprovalSentence {
    # Byte-exact, ordinal, case-sensitive. Not a normalised compare, not a trim.
    param([string] $Given, [string] $Fresh, [string] $FreshPathStem)
    if ([string]::Equals($Given, $Fresh, [System.StringComparison]::Ordinal)) { return }
    $p = Join-Path $script:OutDir ($FreshPathStem + '.txt')
    Write-Utf8NoBom -Path $p -Text $Fresh
    Say ''
    Say 'The sentence he agreed to is not the sentence that is true right now.'
    Say ('The fresh one has been saved to ' + $p)
    Say 'This is usually one of two things, and neither is a fault:'
    Say '  * he signed in to Cloudflare since the preview, which added auth_profile to his manifest, or'
    Say '  * the preview was re-run and produced a new fingerprint.'
    Say 'Either way he has not consented to THIS sentence. Read him the fresh one and ask again.'
    Stop-Kit 'the approval does not match the fresh checks'
}

function Write-ApprovalReceipt {
    param([string] $Path, [string] $Sentence)
    $lines = @(
        ('recorded_at   ' + (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz')),
        'ceremony      The technician read the plain-language approval paragraph aloud and the owner consented in plain language. The technical sentence below was recorded verbatim and offered to the owner, not read at the owner.',
        ('build         ' + $ExpectBuild + ' — a held candidate, not a public release'),
        '',
        $Sentence
    )
    Write-Utf8NoBom -Path $Path -Text (($lines -join "`r`n") + "`r`n")
}

# ---------------------------------------------------------------- preview classification

function Get-EffectsVerdict {
    # The read-only effects contract both paths share: exactly 1 credential read, exactly 1
    # network request, and zero of EVERY other counter, known to this script or not.
    param($Effects)
    $fails = @()
    $names = @(Get-PropNames -Object $Effects)
    if ($names.Count -eq 0) { return @('effects is empty or absent — a receipt with no effects record proves nothing') }
    $cr = Get-Prop -Object $Effects -Name 'credential_reads'
    $nr = Get-Prop -Object $Effects -Name 'network_requests'
    if ($cr -ne 1) { $fails += ('effects.credential_reads=' + [string] $cr + ' expected 1') }
    if ($nr -ne 1) { $fails += ('effects.network_requests=' + [string] $nr + ' expected 1') }
    foreach ($n in $names) {
        if ($n -eq 'credential_reads' -or $n -eq 'network_requests') { continue }
        $v = Get-Prop -Object $Effects -Name $n
        if ($v -ne 0) {
            $fails += ('effects.' + $n + '=' + [string] $v +
                       ' expected 0 — no counter other than credential_reads and network_requests may be non-zero, known or not')
        }
    }
    return $fails
}

function Get-PreviewClassification {
    # Returns a hashtable:
    #   kind         = modern | expected_refusal | paused | unclassified
    #   fails        = why it is not the kind it most resembles
    #   fingerprint  = the plan fingerprint (modern only)
    #   vectors      = actual_vectors (modern only)
    #   error_code   = the refusal code, when there is one
    param([string] $PreviewJsonPath, [int] $ExitCode)

    $res = @{ kind = 'unclassified'; fails = @(); fingerprint = ''; vectors = ''; error_code = '' }
    $r = Read-JsonReceipt -Path $PreviewJsonPath
    if ($null -eq $r) {
        $res.fails = @('the preview printed no parsable JSON at all (' + $PreviewJsonPath + ')')
        return $res
    }
    $status  = [string] (Get-Prop -Object $r -Name 'status')
    $code    = [string] (Get-Prop -Object $r -Name 'error_code')
    $effects = Get-Prop -Object $r -Name 'effects'
    $res.error_code = $code

    # ---- the MODERN plan: the only receipt that can authorize an apply -----------------------
    if ($status -eq 'pre_update_check_complete') {
        $fails = @()
        if ($ExitCode -ne 0) { $fails += ('the preview exited ' + $ExitCode + ' while reporting a completed pre-update check') }
        if ((Get-Prop -Object $r -Name 'projection_ready') -ne $true) { $fails += 'projection_ready is not true' }
        $fp = [string] (Get-Prop -Object $r -Name 'plan_fingerprint')
        if ([string]::IsNullOrEmpty($fp)) { $fails += 'there is no plan_fingerprint' }
        $plan = Get-Prop -Object $r -Name 'plan'
        if ($null -eq $plan) { $fails += 'there is no plan' }
        $dp = Get-PropPath -Object $r -Path 'plan.deployed_projection'
        if ($null -eq $dp) { $fails += 'there is no plan.deployed_projection' }
        else {
            $verdict = [string] (Get-Prop -Object $dp -Name 'verdict')
            if ($verdict -ne 'ready') { $fails += ('plan.deployed_projection.verdict=' + $verdict + ' expected ready') }
            $ev = Get-Prop -Object $dp -Name 'expected_vectors'
            $av = Get-Prop -Object $dp -Name 'actual_vectors'
            if ($null -eq $ev -or $null -eq $av) { $fails += 'expected_vectors / actual_vectors are not both present' }
            elseif ([int64] $ev -ne [int64] $av) { $fails += ('expected_vectors=' + [string] $ev + ' != actual_vectors=' + [string] $av) }
            else { $res.vectors = [string] $av }
            $pending = Get-PropPath -Object $dp -Path 'queue.pending'
            if ($null -eq $pending) { $fails += 'plan.deployed_projection.queue.pending is missing' }
            elseif ([int64] $pending -ne 0) { $fails += ('queue.pending=' + [string] $pending + ' expected 0') }
        }
        $fails = @($fails) + @(Get-EffectsVerdict -Effects $effects)
        if ($fails.Count -eq 0) {
            $res.kind = 'modern'
            $res.fingerprint = $fp
            return $res
        }
        $res.kind = 'unclassified'
        $res.fails = @('this looks like a modern plan but it does not meet the plan contract:') + $fails
        return $res
    }

    # ---- the EXPECTED pre-0.4.4 refusal -------------------------------------------------------
    if ($status -eq 'failed') {
        $fails = @()
        if ($ExitCode -eq 0) { $fails += 'the preview exited 0 while reporting status failed' }
        if ((Get-Prop -Object $r -Name 'read_only') -ne $true) { $fails += 'read_only is not true' }
        if ((Get-Prop -Object $r -Name 'authorizes_update') -ne $false) { $fails += 'authorizes_update is not false' }
        if (Test-HasProp -Object $r -Name 'plan') { $fails += 'the receipt carries a plan — a refusal must not' }
        if (Test-HasProp -Object $r -Name 'plan_fingerprint') { $fails += 'the receipt carries a plan_fingerprint — a refusal must not' }
        $fails = @($fails) + @(Get-EffectsVerdict -Effects $effects)
        if ($ExpectedRefusalCodes -contains $code -and $fails.Count -eq 0) {
            $res.kind = 'expected_refusal'
            return $res
        }
        if ($ExpectedRefusalCodes -notcontains $code) {
            $fails = @('error_code=' + $code + ' is not one of ' + ($ExpectedRefusalCodes -join ' / ')) + $fails
        }
        if ($code -eq 'UPDATE_PREVIEW_DEPLOYED_DRAIN_PAUSED') {
            $res.kind = 'paused'
            $res.fails = @('this Brain is PAUSED mid-update (UPDATE_PREVIEW_DEPLOYED_DRAIN_PAUSED). preview/apply is not the mode for that state — use resume-preview.')
            return $res
        }
        $res.kind = 'unclassified'
        $res.fails = @('this looks like a refusal but it is not the expected pre-0.4.4 one:') + $fails
        return $res
    }

    if ($status -eq 'legacy_observation_complete') {
        $res.kind = 'unclassified'
        $res.fails = @('this Brain took the 0.4.6 LEGACY observation path (status legacy_observation_complete). That is the Mac kit''s contract, not this one — this kit is for a recorded ' + ($ExpectFromVersions -join ' or ') + ' Brain. Stop and reassess.')
        return $res
    }

    $res.kind = 'unclassified'
    $res.fails = @('the preview reported status "' + $status + '" (error_code "' + $code + '", exit ' + $ExitCode + '), which is neither a modern plan nor a refusal this kit knows.')
    return $res
}

# ---------------------------------------------------------------- paused-state observation

function Get-HealthSummary {
    # Reads the human/JSON health output into the SAME seven fields the Mac kit hashes, using the
    # same relaxed separator, so the two kits produce comparable observation fingerprints.
    param([string] $HealthText, [int] $HealthExit)
    $t = ''
    # PowerShell 5.1 has no `e escape, so ESC is built from its code point.
    $esc = [string] [char] 27
    if ($null -ne $HealthText) { $t = [regex]::Replace($HealthText, ($esc + '\[[0-9;]*m'), '') }

    $code = $null
    if ($t -match 'HEALTH_CHECK_FAILED') { $code = 'HEALTH_CHECK_FAILED' }

    $acc = $null
    if ($t -match 'accepting_documents"?\s*[:=]?\s*false') { $acc = $false }
    elseif ($t -match 'accepting_documents"?\s*[:=]?\s*true') { $acc = $true }

    $drain = $null
    if ($t -match 'vector[ _-]drain[ _-]mode"?\s*[:=]?\s*"?([A-Za-z0-9_.-]+)') { $drain = $Matches[1] }

    $ver = $null
    if ($t -match '\b0\.4\.\d+\b') { $ver = $Matches[0] }

    $s = New-Object psobject
    Add-Member -InputObject $s -MemberType NoteProperty -Name 'accepting_documents' -Value $acc
    Add-Member -InputObject $s -MemberType NoteProperty -Name 'drain_mode'          -Value $drain
    Add-Member -InputObject $s -MemberType NoteProperty -Name 'error_code'          -Value $code
    Add-Member -InputObject $s -MemberType NoteProperty -Name 'exit_nonzero'        -Value ($HealthExit -ne 0)
    Add-Member -InputObject $s -MemberType NoteProperty -Name 'paused_for_update'   -Value ($t.IndexOf($PauseSentence, [System.StringComparison]::Ordinal) -ge 0)
    Add-Member -InputObject $s -MemberType NoteProperty -Name 'paused_for_upgrade'  -Value ($t -match 'paused-for-upgrade')
    Add-Member -InputObject $s -MemberType NoteProperty -Name 'version'             -Value $ver
    return $s
}

function Test-PausedObservation {
    # Fail-closed on ANYTHING that is not the exact paused-state signature — including a Brain
    # that is healthy again, a Brain still wholly on its recorded version, and a real modern
    # plan. The binding artifact is an OBSERVATION FINGERPRINT over
    # sha256(canonical-JSON { error_code, effects, health }), because this state has no plan and
    # therefore no plan fingerprint to bind to.
    # Returns a hashtable: ok, fails, fingerprint, observed_at, error_code, health.
    param(
        [string] $PreviewJsonPath, [int] $PreviewExit,
        [string] $HealthTextPath,  [int] $HealthExit,
        [string] $ObservationOutPath,
        [string] $RecordedVersion
    )
    $fails = @()

    $healthText = ''
    if (Test-Path -LiteralPath $HealthTextPath) {
        $tt = Get-Content -LiteralPath $HealthTextPath -Raw
        if ($null -ne $tt) { $healthText = $tt }
    } else {
        $fails += ('the health output could not be read: ' + $HealthTextPath)
    }
    $hs = Get-HealthSummary -HealthText $healthText -HealthExit $HealthExit

    # ---- (1) health must be the paused failure, and nothing else -----------------------------
    if ($HealthExit -eq 0) {
        $fails += 'health exited 0 — this Brain is NOT paused mid-update any more. Do not resume; re-read the state first.'
    }
    if ($hs.error_code -ne 'HEALTH_CHECK_FAILED') {
        $fails += ('health error_code=' + [string] $hs.error_code + ' expected HEALTH_CHECK_FAILED')
    }
    if (-not $hs.paused_for_update) {
        $fails += ('health did not print the pause sentence ("' + $PauseSentence + '") — it failed for some OTHER reason (an unbound documents receipt, a wrong backend, an unreachable domain). That is not this mode.')
    }
    if ($hs.accepting_documents -eq $true) {
        $fails += 'health reports accepting_documents=true — a paused Brain does not accept documents'
    }
    # The pause sentence is the discriminator. On a paused Brain `brain health` dies at that
    # sentence before printing the drain mode, so drain_mode / accepting_documents are only
    # opportunistic fail-closed extras when a future or unusual output happens to include them.
    # Silence is accepted; any explicit value that contradicts paused is a STOP.
    if ($null -ne $hs.drain_mode -and $hs.drain_mode -notmatch '^paused') {
        $fails += ('health reports vector drain mode "' + [string] $hs.drain_mode + '", which is not a paused drain mode — the writer is live, so this is a generation mismatch with a RUNNING writer, not an update that stopped mid-flight. Do not resume; re-read the state first.')
    }
    if ($hs.paused_for_upgrade -and $hs.accepting_documents -eq $true) {
        $fails += 'health names paused-for-upgrade and accepting_documents=true at once — those cannot both be true'
    }
    if ($null -ne $hs.version -and $hs.version -ne $RecordedVersion -and $hs.version -ne $ExpectVersion) {
        $fails += ('health names version ' + [string] $hs.version + ', which is neither ' + $RecordedVersion + ' nor ' + $ExpectVersion)
    }

    # ---- (2) the preview must be the read-only refusal, with no plan --------------------------
    if ($PreviewExit -eq 0) { $fails += 'the preview exited 0 — that is a real plan, not the paused refusal' }
    $r = Read-JsonReceipt -Path $PreviewJsonPath
    $effects = $null
    $code = $null
    if ($null -eq $r) {
        $fails += ('the preview printed no parsable JSON at all (' + $PreviewJsonPath + ')')
    } else {
        $code = [string] (Get-Prop -Object $r -Name 'error_code')
        if ((Get-Prop -Object $r -Name 'status') -ne 'failed') { $fails += ('status=' + [string] (Get-Prop -Object $r -Name 'status') + ' expected "failed"') }
        if ((Get-Prop -Object $r -Name 'read_only') -ne $true) { $fails += 'read_only is not true' }
        if ((Get-Prop -Object $r -Name 'authorizes_update') -ne $false) { $fails += 'authorizes_update is not false' }
        if ($PausedRefusalCodes -notcontains $code) {
            $fails += ('error_code=' + $code + ' is not one of ' + ($PausedRefusalCodes -join ' / '))
        }
        if (Test-HasProp -Object $r -Name 'plan') { $fails += 'the receipt carries a plan — this is a real update plan, not the paused refusal. Use preview/apply, not resume.' }
        if (Test-HasProp -Object $r -Name 'plan_fingerprint') { $fails += 'the receipt carries a plan_fingerprint — this is a real update plan, not the paused refusal' }
        if (Test-HasProp -Object $r -Name 'legacy_observation') { $fails += 'the receipt carries a legacy_observation — this Brain took the 0.4.6 legacy path, so it is NOT paused mid-update' }
        $effects = Get-Prop -Object $r -Name 'effects'
        $fails = @($fails) + @(Get-EffectsVerdict -Effects $effects)
    }

    # ---- (3) the observation fingerprint ------------------------------------------------------
    $payload = New-Object psobject
    Add-Member -InputObject $payload -MemberType NoteProperty -Name 'error_code' -Value $code
    if ($null -eq $effects) {
        Add-Member -InputObject $payload -MemberType NoteProperty -Name 'effects' -Value (New-Object psobject)
    } else {
        Add-Member -InputObject $payload -MemberType NoteProperty -Name 'effects' -Value $effects
    }
    Add-Member -InputObject $payload -MemberType NoteProperty -Name 'health' -Value $hs
    $body = ConvertTo-CanonicalJson -Value $payload
    $fp   = Get-Sha256OfString -Text $body

    $res = @{ ok = ($fails.Count -eq 0); fails = $fails; fingerprint = $fp;
              observed_at = ''; error_code = $code; health = $hs; body = $body }
    if (-not $res.ok) { return $res }

    # WHEN this observation was taken, ISO 8601 to the MINUTE with the local offset. It is
    # deliberately NOT part of the hashed body: the fingerprint has to be stable across a
    # re-observation of the same paused state, while the TIME is exactly what bounds how long a
    # sentence built from it stays good for. Truncating to the minute rounds DOWN, which makes
    # the computed age larger, never smaller.
    $observedAt = (Get-Date).ToString('yyyy-MM-ddTHH:mmzzz', [System.Globalization.CultureInfo]::InvariantCulture)
    $res.observed_at = $observedAt
    $out = '{"observed_at":' + (ConvertTo-CanonicalJson -Value $observedAt) +
           ',"observation_fingerprint":' + (ConvertTo-CanonicalJson -Value $fp) +
           ',"observation":' + $body + '}'
    Write-Utf8NoBom -Path $ObservationOutPath -Text ($out + "`r`n")
    return $res
}

function Invoke-PausedObservation {
    # Two read-only observations, sequential and spaced: one health, wait, one preview.
    # One request stream at a time on his Brain.
    # Side effect worth knowing about, and the only one: each FAILED `brain health` run saves ONE
    # local private support-journal note under the installer's own state on his PC. Nothing is
    # uploaded, and nothing is written to his Brain, his manifest, the prefix or any scheduled task.
    param([string] $Label, [string] $RecordedVersion)

    $hrc = Invoke-BrainRead -Stem ($Label + '-health') -BrainArgs @('health', $script:ManifestPath, '--json')
    $hso = Join-Path $script:OutDir ($Label + '-health.stdout')
    $hse = Join-Path $script:OutDir ($Label + '-health.stderr')
    $htxt = Join-Path $script:OutDir ($Label + '-health.txt')
    $combined = ''
    foreach ($f in @($hso, $hse)) {
        if (Test-Path -LiteralPath $f) {
            $t = Get-Content -LiteralPath $f -Raw
            if ($null -ne $t) { $combined = $combined + $t }
        }
    }
    Write-Utf8NoBom -Path $htxt -Text $combined
    Say ('  ' + $Label + ' health  exit=' + $hrc + '  (NON-ZERO is the correct answer for a paused Brain)')

    Start-Sleep -Seconds $ResumeObsSpacingSeconds

    $prc = Invoke-BrainRead -Stem ($Label + '-preview') -BrainArgs @(
        'update', $script:ManifestPath, '--preview',
        '--expect-runtime-sha256', $script:RuntimeSha, '--json')
    $pjson = Join-Path $script:OutDir ($Label + '-preview.stdout')
    Say ('  ' + $Label + ' preview exit=' + $prc + '  (NON-ZERO is the correct answer here)')

    $obsFile = Join-Path $script:OutDir ($Label + '-observation.json')
    $res = Test-PausedObservation -PreviewJsonPath $pjson -PreviewExit $prc `
                                  -HealthTextPath $htxt -HealthExit $hrc `
                                  -ObservationOutPath $obsFile -RecordedVersion $RecordedVersion
    if (-not $res.ok) {
        Say ''
        Say 'This is NOT the paused-state observation that resume is for:'
        foreach ($f in $res.fails) { Say ('    ' + $f) }
        Say ''
        Say '  Every line above is a STOP, not a variation. Do not resume. Do not retry, Ctrl-C,'
        Say '  unpause, clear the drain mode, reindex, ingest, repair or restore. Read-only only,'
        Say '  then report the public /health and the output of: brain status "<manifest>".'
        Say ('  Full preview JSON : ' + $pjson)
        Say ('  Full health output: ' + $htxt)
        Stop-Kit 'the paused-state observation was not met'
    }
    $script:ResumeObsFp = $res.fingerprint
    $script:ResumeObsAt = $res.observed_at
    Say ('  refusal          : ' + [string] $res.error_code)
    Say ('  health           : exit_nonzero=' + [string] $res.health.exit_nonzero +
         ' error_code=' + [string] $res.health.error_code +
         ' paused_for_update=' + [string] $res.health.paused_for_update +
         ' accepting_documents=' + [string] $res.health.accepting_documents +
         ' drain_mode=' + [string] $res.health.drain_mode +
         ' version=' + [string] $res.health.version)
    Say ('  observation      : ' + $obsFile)
    Say ('  observed at      : ' + $script:ResumeObsAt)
    Say ('  observation fp   : ' + $script:ResumeObsFp)
}

# ---------------------------------------------------------------- the resume record and its age

function Get-IsoAgeSeconds {
    param([string] $Iso)
    $dto = [System.DateTimeOffset]::MinValue
    $styles = [System.Globalization.DateTimeStyles]::AssumeLocal
    if (-not [System.DateTimeOffset]::TryParse($Iso, [System.Globalization.CultureInfo]::InvariantCulture, $styles, [ref] $dto)) {
        return $null
    }
    return [int] [math]::Floor(([System.DateTimeOffset]::Now - $dto).TotalSeconds)
}

function Read-ResumeRecord {
    param([string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        Stop-Kit ('no resume-preview observation on record at ' + $Path + ' — run: resume-preview')
    }
    $fp = ''; $at = ''
    foreach ($line in (Get-Content -LiteralPath $Path)) {
        if ($line -match '^fingerprint\s+(\S+)') { $fp = $Matches[1] }
        if ($line -match '^observed_at\s+(\S+)') { $at = $Matches[1] }
    }
    if ([string]::IsNullOrEmpty($fp)) {
        Stop-Kit ('the recorded paused-state observation at ' + $Path + ' carries no fingerprint — run resume-preview again and use its sentence')
    }
    if ([string]::IsNullOrEmpty($at)) {
        Stop-Kit ('the recorded paused-state observation at ' + $Path + ' carries no observed_at time, so its age cannot be bounded — run resume-preview again and use its sentence')
    }
    $age = Get-IsoAgeSeconds -Iso $at
    if ($null -eq $age) {
        Stop-Kit ('could not read the observed_at time in ' + $Path + ' ("' + $at + '") — run resume-preview again and use its sentence')
    }
    $script:ResumeRecordedFp  = $fp
    $script:ResumeRecordedAt  = $at
    $script:ResumeRecordedAge = $age
}

function Test-ResumeRecordFresh {
    # WHY a time bound at all: the observation fingerprint is sha256 over the refusal code, the
    # effects counters and the health summary. Every one of those is STABLE while the Brain stays
    # paused, so the fingerprint observed a week from now is the same fingerprint — a sentence
    # captured once would otherwise authorize a resume indefinitely, long after the conversation
    # in which he said yes. The freshness bound is what makes his yes a yes to THIS moment.
    if ($script:ResumeRecordedAge -lt 0) {
        Stop-Kit ('the recorded paused-state observation is dated in the future (' + $script:ResumeRecordedAt + '). Check the PC clock, then run resume-preview again.')
    }
    if ($script:ResumeRecordedAge -ge $ResumeObsMaxAgeSeconds) {
        Say ''
        Say 'The paused-state observation he was shown is stale.'
        Say ('  taken at        : ' + $script:ResumeRecordedAt)
        Say ('  age now         : ' + $script:ResumeRecordedAge + 's')
        Say ('  freshness bound : ' + $ResumeObsMaxAgeSeconds + 's')
        Say 'The fingerprint alone does not go stale — a paused Brain keeps producing the same one —'
        Say 'so the sentence is bound to the MINUTE the state was observed as well. Run resume-preview'
        Say 'again, read him the fresh sentence, and ask again. Do not paste the old one.'
        Stop-Kit ('the paused-state observation is older than ' + $ResumeObsMaxAgeSeconds + 's — run resume-preview again')
    }
}

function Test-ResumeObservationGate {
    param([string] $RecordPath, [string] $ObservedNow)
    Read-ResumeRecord -Path $RecordPath
    Test-ResumeRecordFresh
    if ($script:ResumeRecordedFp -ne $ObservedNow) {
        Say ''
        Say 'The paused state is not the state he was shown.'
        Say ('  recorded at resume-preview : ' + $script:ResumeRecordedFp + ' (taken ' + $script:ResumeRecordedAt + ')')
        Say ('  observed just now          : ' + $ObservedNow)
        Say 'Something about the refusal, its effects or the health output changed in between.'
        Say 'He has not consented to THIS state. Run resume-preview again, read him the fresh'
        Say 'sentence, and ask again. Do not paste the old one.'
        Stop-Kit 'the paused state changed since resume-preview (the observation fingerprint differs)'
    }
}

# ---------------------------------------------------------------- shared context

$script:BrainName = ''; $script:BrainDomain = ''; $script:ManifestSha = ''
$script:AuthState = ''; $script:FromVersion = ''

function Initialize-BrainContext {
    # Everything preview / apply / resume-preview / resume all need, in the order that fails
    # cheapest first: a wrong manifest is caught before any guard and long before his Brain is
    # contacted or a writer lock is taken.
    Resolve-NodeExe
    Test-Kit
    Resolve-ManifestPath
    $script:FromVersion = Get-ManifestValue -Path 'brain.version'
    if ($ExpectFromVersions -notcontains $script:FromVersion) {
        Stop-Kit ('this manifest records version "' + $script:FromVersion + '". This kit is for a ' +
                  ($ExpectFromVersions -join ' or ') + ' Brain only. A 0.4.6 Brain takes the legacy-observation ' +
                  'path this script does not implement — that is the Mac kit. Stop and reassess.')
    }
    Test-Prefix -PrefixPath $script:PrefixDir
    Test-Guards
    Test-IdentityUnchanged

    $script:ManifestSha  = Get-Sha256OfFile -Path $script:ManifestPath
    $script:BrainName    = Get-ManifestValue -Path 'brain.worker_name'
    $script:BrainDomain  = Get-ManifestValue -Path 'brain.domain'
    $auth = Get-ManifestValue -Path 'infrastructure.cloudflare.auth_profile'
    if ([string]::IsNullOrEmpty($auth)) { $script:AuthState = 'absent' } else { $script:AuthState = 'present' }

    Say ('manifest        : ' + $script:ManifestPath)
    Say ('manifest SHA-256: ' + $script:ManifestSha)
    Say ('recorded version: ' + $script:FromVersion)
    Say ('Cloudflare sign-in profile in manifest: ' + $script:AuthState)
    if ($script:AuthState -eq 'absent') {
        Say '  (the first sign-in writes that one field, which changes the manifest SHA — see the sentence)'
    }
}

# ---------------------------------------------------------------- discover

function Invoke-ModeDiscover {
    Say '=============================================================='
    Say ' DISCOVER — read-only, and NO NETWORK AT ALL. Nothing about'
    Say ' this Brain, this Cloudflare account or these records is'
    Say ' changed, installed, sent or contacted.'
    Say '=============================================================='
    Resolve-NodeExe
    $info = Get-NodeInfo

    Say ''
    Say 'Node'
    Say ('  resolved path    : ' + $script:NodeExe)
    Say ('  version          : v' + $info.version)
    Say ('  arch / platform  : ' + $info.arch + ' ' + $info.platform)
    Say ('  SHA-256          : ' + $info.sha256)
    if ($info.major -lt $MinNodeMajor) {
        Say ('  ** Node ' + $info.major + ' is below the required ' + $MinNodeMajor + '. This is a STOP for install/preview/apply. **')
    }
    if ((Test-IsWindowsHost) -and ($info.arch -ne 'x64' -or $info.platform -ne 'win32')) {
        Say '  ** This CLI is x64 Windows only. It refuses ARM64, including x64 Node under emulation.'
        Say '     This is a STOP for install/preview/apply. **'
    }
    if (Test-NodeVersionManaged -Path $script:NodeExe) {
        Say '  ** This Node sits under a version manager. The absolute path is baked into the local'
        Say '     registrations the update writes, and it breaks silently the next time the version'
        Say '     changes. This is a STOP for install/preview/apply. **'
    }

    Say ''
    Say 'PowerShell and the shell it is running in'
    Say ('  PSVersion        : ' + $PSVersionTable.PSVersion.ToString())
    Say ('  PSEdition        : ' + $PSVersionTable.PSEdition)
    if (Test-IsWindowsHost) {
        try { Say ('  ExecutionPolicy  : ' + (Get-ExecutionPolicy).ToString() + '   (do not change it — this kit uses the .cmd shims)') } catch { }
        if (-not [string]::IsNullOrEmpty($env:APPDATA)) { Say ('  APPDATA          : ' + $env:APPDATA) }
        if ($env:APPDATA -match 'WindowsApps|Packages\\') {
            Say '  ** APPDATA looks redirected (an MSIX / packaged shell). A bare `npm i -g` would install'
            Say '     into the wrong place. This kit always passes --prefix, but start a Start-menu'
            Say '     PowerShell anyway. **'
        }
    }

    Say ''
    Say 'npm'
    if (Resolve-NpmCmd) {
        Say ('  npm command      : ' + $script:NpmCmdExe)
        if ($script:NpmCmdExe -like '*.ps1') {
            Say '  ** that is the .ps1 shim, which a restricted execution policy blocks. Pass'
            Say '     -NpmCmd "<path>\npm.cmd" instead. **'
        }
        $so = Join-Path $script:OutDir 'npm-version.txt'
        $se = Join-Path $script:OutDir 'npm-version.stderr'
        $rc = Invoke-Captured -FilePath $script:NpmCmdExe -Arguments @('--version') -StdoutPath $so -StderrPath $se
        if ($rc -eq 0) { Say ('  npm version      : ' + (Get-Content -LiteralPath $so -Raw).Trim()) }
        else { Say ('  npm version      : could not be read (exit ' + $rc + ') — see ' + $se) }
    } else {
        Say '  npm command      : NOT FOUND. Find it with "where npm.cmd" and pass -NpmCmd <that path>.'
    }

    Say ''
    Say 'The prefix this kit would install into'
    Say ('  prefix           : ' + $script:PrefixDir)
    $root = Get-PrefixRoot -PrefixPath $script:PrefixDir
    if ([string]::IsNullOrEmpty($root)) {
        if (Test-Path -LiteralPath $script:PrefixDir) { Say '  state            : the folder exists but holds no brain-installer — install would refuse it' }
        else { Say '  state            : not present yet (this is the normal state before install)' }
    } else {
        Say ('  state            : brain-installer is already installed at ' + $root)
        $so = Join-Path $script:OutDir 'discover-cli-version.txt'
        $se = Join-Path $script:OutDir 'discover-cli-version.stderr'
        $rc = Invoke-Captured -FilePath $script:NodeExe -Arguments @((Join-Path $root 'brain.mjs'), '--version') `
                              -StdoutPath $so -StderrPath $se
        if ($rc -eq 0) { Say ('  installed CLI    : ' + (Get-Content -LiteralPath $so -Raw).Trim()) }
    }
    if ($script:PrefixDir -match '\s') {
        Say '  ** this prefix path contains a SPACE. cmd.exe re-parses arguments and can split it'
        Say '     silently. install will refuse it. Unzip the kit to a path with no space, for'
        Say '     example C:\FinancialBrain-kit, or pass -Prefix "C:\FinancialBrain\prefix". **'
    }

    Say ''
    Say 'Any CLI already on PATH (not used by this kit — every command here uses the full path)'
    $b = Get-Command -Name 'brain' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $b) { Say '  brain on PATH    : none' }
    else { Say ('  brain on PATH    : ' + $b.Source + '   (a stale shim can point at another install — ignore it)') }

    Say ''
    Say 'The manifest'
    $c = Get-ManifestCandidates
    if (@($c.pointers).Count -eq 0) { Say '  remembered-manifest pointer: none found under the profile' }
    foreach ($p in $c.pointers) {
        Say ('  pointer          : ' + $p.pointer)
        Say ('    names          : ' + $p.manifest_path)
    }
    foreach ($m in $c.manifests) { Say ('  manifest under profile: ' + $m) }
    Resolve-ManifestPath
    Say ('  path             : ' + $script:ManifestPath)
    Say ('  SHA-256          : ' + (Get-Sha256OfFile -Path $script:ManifestPath))
    Show-ManifestFacts
    Say '  (Values above are settings only. No record, message, key or token is read or printed.)'
    $recorded = Get-ManifestValue -Path 'brain.version'
    if ($ExpectFromVersions -notcontains $recorded) {
        Say ('  ** the recorded version is "' + $recorded + '". This kit is for ' + ($ExpectFromVersions -join ' or ') + ' only. **')
    }
    $storage = Get-ManifestValue -Path 'infrastructure.storage'
    if (-not [string]::IsNullOrEmpty($storage) -and $storage -ne 'd1') {
        Say ('  ** storage is "' + $storage + '". The update refuses anything but d1 (brain.mjs:23271). **')
    }
    $adminKey = Get-ManifestValue -Path 'operations.admin_key_secret'
    if (-not [string]::IsNullOrEmpty($adminKey) -and $adminKey -like 'keychain://*') {
        Say '  ** the admin-key locator is a macOS keychain:// URI. On Windows the CLI treats any'
        Say '     keychain locator as an unsupported admin key store (brain.mjs:23286-23296) — a'
        Say '     Windows Brain must use the adjacent DPAPI-protected key file. Flag this to the technician. **'
    }

    Say ''
    Say 'The kit'
    Test-Kit

    Show-ExpectedTable
    Say ''
    Say 'Discover finished. Nothing was changed and no network request was made.'
    Say ('Receipts: ' + $script:OutDir)
}

function Show-ExpectedTable {
    Say ''
    Say 'What each step should print if all is well'
    Say '  discover   Node/npm/PowerShell identity, the manifest facts, the prefix state and the'
    Say '             kit verification. No network at all. Nothing is changed.'
    Say ('  install    "installed ... into <prefix>", then "prefix verified: CLI ' + $ExpectVersion + ', all five')
    Say '             candidate-build signatures present".'
    Say '  preview    ONE of three outcomes, and it says which:'
    Say '               EXPECTED here, on a pre-0.4.4 Brain — a read-only refusal, exit 3.'
    Say '                 The 0.4.0 and 0.4.1 Workers do not report their own version on /documents'
    Say '                 (that landed in 0.4.4), and the 0.4.8 modern preview requires it. Capturing'
    Say '                 that refusal cleanly is what Sunday is FOR. Stop there and send the receipts.'
    Say '               a modern plan — exit 0, and only then is there a sentence to read.'
    Say '               anything else — exit 4. STOP and call the technician.'
    Say ('  apply      one update, uninterrupted, ending "upgrade verified, now at ' + $ExpectVersion + '", then the readback.')
    Say '             The bare update command does NOT enforce the runtime SHA-256. That hash names'
    Say '             the kit being run; only the read-only preview can bind it before the update.'
    Say ''
    Say 'Known and expected, not faults'
    Say '  * The preview refusing on a 0.4.0 / 0.4.1 Brain. That is the finding, not a fault.'
    Say '  * "brain sources" returns HTTP 503 if it follows "brain check" too closely. The readback'
    Say ('    here waits ' + $SourcesQuietSeconds + ' seconds and runs it alone.')
    Say '  * "mcp-config --apply" is expected to refuse with a name collision. This kit never runs --apply.'
    Say '  * "brain test" marks stale sources FAILED by design. This kit never runs it.'
}

# ---------------------------------------------------------------- install

function Invoke-ModeInstall {
    Say '=============================================================='
    Say ' INSTALL — the kit package only. No Brain, no Cloudflare.'
    Say '=============================================================='
    Resolve-NodeExe
    if (Test-NodeVersionManaged -Path $script:NodeExe) {
        Stop-Kit ('the Node at ' + $script:NodeExe + ' sits under a version manager — see discover. Resolve to a stable Node first.')
    }
    $info = Get-NodeInfo
    if ($info.major -lt $MinNodeMajor) { Stop-Kit ('Node major version ' + $info.major + ' is below ' + $MinNodeMajor) }
    if (Test-IsWindowsHost) {
        if ($info.arch -ne 'x64' -or $info.platform -ne 'win32') {
            Stop-Kit ('this CLI is x64 Windows only. Node reports "' + $info.arch + ' ' + $info.platform + '", expected "x64 win32".')
        }
    }
    if (-not (Resolve-NpmCmd)) {
        Stop-Kit 'could not locate npm. Find it with "where npm.cmd", then pass -NpmCmd "<that path>".'
    }
    if ($script:NpmCmdExe -like '*.ps1') {
        Stop-Kit ('the npm found is the PowerShell shim ' + $script:NpmCmdExe + '. A restricted execution policy blocks it. Pass -NpmCmd "<path>\npm.cmd".')
    }
    Test-Kit

    if ($script:PrefixDir -match '\s') {
        Stop-Kit ('the prefix path "' + $script:PrefixDir + '" contains a space. cmd.exe re-parses arguments and can split it silently (doctor.mjs:111-113). Unzip the kit somewhere without a space — C:\FinancialBrain-kit is the recommended place — or pass -Prefix "C:\FinancialBrain\prefix".')
    }
    foreach ($bad in @('\Downloads\', '\OneDrive', '\Dropbox', '\Google Drive', '\Temp\', '\Windows\Temp')) {
        if ($script:PrefixDir -like ('*' + $bad + '*')) {
            Stop-Kit ('the prefix must be permanent and local. "' + $script:PrefixDir + '" is a temporary or synced location, and the update bakes this path into local registrations, so it must never move.')
        }
    }
    if (-not [string]::IsNullOrEmpty((Get-PrefixRoot -PrefixPath $script:PrefixDir))) {
        Stop-Kit ('a brain-installer prefix already exists at ' + $script:PrefixDir + ' — not overwriting. Choose another with -Prefix, or check what is there first.')
    }

    New-KitDirectory -Path $script:PrefixDir
    Say ('installing ' + (Split-Path -Leaf $script:PkgPath) + ' into ' + $script:PrefixDir)
    Say '  (npm.cmd, explicit --prefix, scripts disabled; every path fully quoted)'
    $npmArgs = @('install', '--global', '--ignore-scripts', '--no-audit', '--no-fund',
                 '--prefix', $script:PrefixDir, $script:PkgPath)
    $so = Join-Path $script:OutDir '00-install.stdout'
    $se = Join-Path $script:OutDir '00-install.stderr'
    $rc = Invoke-Captured -FilePath $script:NpmCmdExe -Arguments $npmArgs -StdoutPath $so -StderrPath $se
    if ($rc -ne 0) {
        if (Test-Path -LiteralPath $se) { Get-Content -LiteralPath $se -Tail 20 | ForEach-Object { Say ('    ' + $_) } }
        Stop-Kit ('the install failed (exit ' + $rc + '). Output: ' + $se)
    }
    if (Test-Path -LiteralPath $so) { Get-Content -LiteralPath $so -Tail 5 | ForEach-Object { Say ('    ' + $_) } }

    Test-Prefix -PrefixPath $script:PrefixDir
    Save-Identity
    Say ''
    Say ('Installed. Never move or delete ' + $script:PrefixDir + ' after an update — the local')
    Say 'registrations point at absolute paths inside it.'
    Say 'Next: preview'
}

# ---------------------------------------------------------------- preview

function Invoke-HealthProbe {
    # `brain health` first, exactly as the runbook says, for one reason: it is what tells a
    # PAUSED Brain apart from a live pre-0.4.4 one. Both can answer the preview with
    # UPDATE_PREVIEW_DEPLOYED_GENERATION_MISMATCH, and they need completely different modes.
    param([string] $Label)
    $rc = Invoke-BrainRead -Stem $Label -BrainArgs @('health', $script:ManifestPath, '--json')
    $txt = ''
    foreach ($f in @((Join-Path $script:OutDir ($Label + '.stdout')), (Join-Path $script:OutDir ($Label + '.stderr')))) {
        if (Test-Path -LiteralPath $f) {
            $t = Get-Content -LiteralPath $f -Raw
            if ($null -ne $t) { $txt = $txt + $t }
        }
    }
    Write-Utf8NoBom -Path (Join-Path $script:OutDir ($Label + '.txt')) -Text $txt
    Say ('  ' + $Label + ' exit=' + $rc)
    if ($rc -ne 0 -and $txt.IndexOf($PauseSentence, [System.StringComparison]::Ordinal) -ge 0) {
        Say ''
        Say 'This Brain is PAUSED mid-update: health refuses with the pause sentence.'
        Say 'preview and apply are not the modes for that state. Do not retry, Ctrl-C, unpause,'
        Say 'clear the drain mode, reindex, ingest, repair or restore.'
        Say 'Run instead:   resume-preview'
        Stop-Kit 'this Brain is paused mid-update — use resume-preview, not preview'
    }
    if ($rc -ne 0) {
        Say '  ** health did not exit 0. That is not automatically a stop — the preview below is the'
        Say '     authoritative read — but note it, and send this file back with the receipts:'
        Say ('     ' + (Join-Path $script:OutDir ($Label + '.txt')))
    }
    return $rc
}

function Invoke-ModePreview {
    Say '=============================================================='
    Say ' PREVIEW — read-only. Health, then ONE look at this Brain.'
    Say ' Nothing is written. On a 0.4.0 / 0.4.1 Brain a REFUSAL is the'
    Say ' expected outcome and it is the finding Sunday exists to get.'
    Say '=============================================================='
    Initialize-BrainContext

    Say ''
    Say 'health (read-only)'
    Invoke-HealthProbe -Label '01-health' | Out-Null

    Say ''
    Say 'the read-only preview'
    $prc = Invoke-BrainRead -Stem '02-preview' -BrainArgs @(
        'update', $script:ManifestPath, '--preview',
        '--expect-runtime-sha256', $script:RuntimeSha, '--json')
    $pjson = Join-Path $script:OutDir '02-preview.stdout'
    Say ('  02-preview exit=' + $prc)

    $cls = Get-PreviewClassification -PreviewJsonPath $pjson -ExitCode $prc
    Say ('  classification: ' + $cls.kind)
    if (-not [string]::IsNullOrEmpty($cls.error_code)) { Say ('  error_code    : ' + $cls.error_code) }

    if ($cls.kind -eq 'expected_refusal') {
        Say ''
        Say '--------------------------------------------------------------'
        Say 'EXPECTED REFUSAL on a pre-0.4.4 Brain: stop here, send the receipts folder to the technician'
        Say '--------------------------------------------------------------'
        Say ('This Brain records ' + $script:FromVersion + '. Its deployed Worker does not report its own version on')
        Say '/documents — that field only arrived in 0.4.4 — and the 0.4.8 modern preview requires it,'
        Say 'with a legacy fallback only for a recorded 0.4.6. So the preview refused, read-only:'
        Say ('  error_code        : ' + $cls.error_code)
        Say '  read_only         : true'
        Say '  authorizes_update : false'
        Say '  effects           : 1 credential read, 1 network request, zero of every other counter'
        Say '  plan              : none, and no plan fingerprint'
        Say ''
        Say 'Nothing was changed. Nothing is broken. This is the rehearsal result we came for.'
        Say 'There is no approval sentence to read, because there is nothing to approve.'
        Say ('Zip ' + $script:OutDir + ' and send it to the technician through the agreed private channel.')
        Say 'Do not retry, do not pass any other flag, and do not run apply.'
        exit $script:ExitExpectedRefusal
    }

    if ($cls.kind -ne 'modern') {
        Say ''
        Say '--------------------------------------------------------------'
        Say 'STOP — this is neither a modern plan nor the expected pre-0.4.4 refusal.'
        Say '--------------------------------------------------------------'
        foreach ($f in $cls.fails) { Say ('  ' + $f) }
        Say ''
        Say ('Full preview JSON: ' + $pjson)
        Say 'Do nothing else this session. Save the output, send the receipts folder to the technician, and'
        Say 'wait. Recovery, rollback and repair each need a new approval on another day.'
        exit $script:ExitUnclassified
    }

    # ---- a MODERN plan. Only here is there anything to approve. -------------------------------
    $script:PlanFingerprint = $cls.fingerprint
    $script:PlanVectors     = $cls.vectors
    Write-Utf8NoBom -Path (Join-Path $script:OutDir 'plan-fingerprint.txt') `
                    -Text (('fingerprint ' + $cls.fingerprint) + "`r`n" + ('vectors ' + $cls.vectors) + "`r`n")
    Say ('  plan fingerprint  : ' + $cls.fingerprint)
    Say ('  search entries    : ' + $cls.vectors + '   (expected == actual, queue empty, verdict ready)')

    $sentence = New-UpdateSentence -BrainName $script:BrainName -BrainDomain $script:BrainDomain `
        -FromVersion $script:FromVersion -ManifestSha $script:ManifestSha `
        -PlanFingerprint $cls.fingerprint -PackageSha $script:PkgSha -RuntimeSha $script:RuntimeSha `
        -NodeSha $script:NodeSha -CliSha $script:InstalledCliSha -AuthState $script:AuthState
    $sp = Join-Path $script:OutDir ('approval-sentence-' + $cls.fingerprint + '.txt')
    Write-Utf8NoBom -Path $sp -Text $sentence
    Say ''
    Say '--------------------------------------------------------------'
    Say 'RECORD ONLY — do not read the hashes aloud.'
    Say 'Say the plain-language paragraph, get his yes, then paste this sentence back with'
    Say '-Approval. His "yes" is the consent; this sentence is the record of what he agreed to.'
    Say '--------------------------------------------------------------'
    Write-Output $sentence
    Say '--------------------------------------------------------------'
    Say ('Saved to ' + $sp)
    Say ''
    Say 'Then run, pasting the sentence exactly:'
    Say ('  .\' + $script:ScriptFileName + ' apply -Run -Approval "<the sentence>"')
    Say ''
    Say 'If the owner says no, or is unsure, that is a fine answer. Stop here; nothing has changed.'
}

# ---------------------------------------------------------------- the one update, and the readback

function Invoke-OneUpdate {
    # ONE bare `brain update <manifest>`, in the foreground, uninterrupted, output streamed to
    # the window AND captured. Shared by apply and resume so that a resume cannot run a
    # different command from the one that was approved; only the receipt stem differs.
    param([string] $Stem)
    Say ''
    Say ('== ' + $Stem + ' — do not Ctrl-C, do not close this window, do not let the PC sleep')
    Say '   Progress lines with the first number climbing are the thing working.'
    $start = Get-Date
    $outFile = Join-Path $script:OutDir ($Stem + '.stdout')

    # $ErrorActionPreference='Stop' turns a native command's stderr into a terminating error
    # under a 2>&1 redirect, and this command writes progress to both streams. It is relaxed for
    # exactly this call and restored immediately after; $LASTEXITCODE is what decides.
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $global:LASTEXITCODE = 0
    try {
        & $script:NodeExe $script:CliPath 'update' $script:ManifestPath 2>&1 |
            Tee-Object -FilePath $outFile
    } finally {
        $ErrorActionPreference = $prev
    }
    $rc = $LASTEXITCODE
    $wall = [int] ((Get-Date) - $start).TotalSeconds
    Say ($Stem + ' exit=' + $rc + ' wall=' + $wall + 's')

    if ($rc -ne 0) {
        Say ''
        Say 'The update did not complete. Do NOT retry, Ctrl-C, unpause, clear VECTOR_DRAIN_MODE,'
        Say 'restore the D1 bookmark, reindex, ingest, repair or restore.'
        Say 'If it stopped at "paused vector-drain health verification", that is the known unfixed'
        Say 'single-shot receipt check (brain.mjs:3075, Track E item E1). The Brain is left PAUSED:'
        Say 'it still answers questions and refuses new material with 503. The path from there is'
        Say ('  resume-preview   then   resume -Run -Approval "<the fresh sentence>"')
        Say ('Send the technician: the last 40 lines of ' + $outFile)
        Stop-Kit ('the update exited ' + $rc)
    }
    $verified = @(Select-String -LiteralPath $outFile -SimpleMatch -Pattern 'upgrade verified')
    if ($verified.Count -lt 1) {
        Stop-Kit 'the update exited 0 but did not print "upgrade verified". Treat this as a stop and report it.'
    }
    Say ('update reported: ' + $verified[0].Line.Trim())
}

function Invoke-PostUpdateReadback {
    # Read-only, in the order the runbook fixes. `sources` runs ALONE and only after a quiet
    # gap, because it 503s when it follows `check` immediately (measured on 2026-09-17).
    param([string] $AfterStem, [string] $ReadbackStem, [string] $WantVectors)
    Say ''
    Say '== readback (read-only)'

    $arc = Invoke-BrainRead -Stem $AfterStem -BrainArgs @(
        'update', $script:ManifestPath, '--preview',
        '--expect-runtime-sha256', $script:RuntimeSha, '--json')
    Say ($AfterStem + ' exit=' + $arc)
    $cls = Get-PreviewClassification -PreviewJsonPath (Join-Path $script:OutDir ($AfterStem + '.stdout')) -ExitCode $arc
    $afterOk = $false
    if ($cls.kind -eq 'modern') {
        if ([string]::IsNullOrEmpty($WantVectors)) { $afterOk = $true }
        elseif ($cls.vectors -eq $WantVectors) { $afterOk = $true }
        Say ('   status pre_update_check_complete | verdict ready | expected == actual == ' + $cls.vectors)
    } else {
        foreach ($f in $cls.fails) { Say ('   ' + $f) }
    }

    # status, health, check — then a quiet gap — then sources, alone.
    foreach ($c in @('status', 'health')) {
        $rc = Invoke-BrainRead -Stem ($ReadbackStem + '-' + $c) -BrainArgs @($c, $script:ManifestPath)
        Say ($ReadbackStem + '-' + $c + ' exit=' + $rc)
    }
    $checkArgs = @('check', $script:ManifestPath)
    if (-not [string]::IsNullOrEmpty($Subject)) { $checkArgs = @('check', $script:ManifestPath, '--subject', $Subject) }
    $rc = Invoke-BrainRead -Stem ($ReadbackStem + '-check') -BrainArgs $checkArgs
    Say ($ReadbackStem + '-check exit=' + $rc + '   (exit 0 is NOT the pass signal here — count the completed categories)')
    $rc = Invoke-BrainRead -Stem ($ReadbackStem + '-mcp-config') -BrainArgs @('mcp-config', $script:ManifestPath)
    Say ($ReadbackStem + '-mcp-config exit=' + $rc + '   (read-only; --apply is never run by this kit)')

    Say ('   waiting ' + $SourcesQuietSeconds + 's before sources — it 503s when it follows check too closely')
    Start-Sleep -Seconds $SourcesQuietSeconds
    $rc = Invoke-BrainRead -Stem ($ReadbackStem + '-sources') -BrainArgs @('sources', $script:ManifestPath, '--json')
    Say ($ReadbackStem + '-sources exit=' + $rc + '   (0 = the source-inventory fix is proven live on this Brain)')

    if (-not $afterOk) {
        Say ''
        Say 'The post-update preview did not assert clean. The update itself reported "upgrade verified",'
        Say 'so do NOT retry, Ctrl-C, unpause, reindex, ingest, repair or restore. Read-only only.'
        Say ('Full JSON: ' + (Join-Path $script:OutDir ($AfterStem + '.stdout')))
        Stop-Kit 'the post-update preview did not match: status pre_update_check_complete, verdict ready, expected == actual'
    }

    Say ''
    Say '=============================================================='
    Say ' Pass means all of these, and nothing less:'
    Say ('   ' + $AfterStem + ' : pre_update_check_complete, projection_ready true, verdict ready, expected == actual')
    Say ('   ' + $ReadbackStem + '-status  : ' + $ExpectVersion + ', schema 46, "' + $script:FromVersion + ' -> ' + $ExpectVersion + ' verified", 0 pending migrations')
    Say ('   ' + $ReadbackStem + '-health  : active, queue 0, documents endpoint 200')
    Say ('   ' + $ReadbackStem + '-sources : exit 0')
    Say ' Expected and NOT failures: warnings about the local assistant registration after'
    Say ' "upgrade verified"; a check run that says categories are provisional.'
    Say ' Still to do by hand: quit and reopen Claude Code (this update rewrites the'
    Say ' registrations), then ask one question and confirm it comes back cited.'
    Say (' Never move or delete ' + $script:PrefixDir + '.')
    Say '=============================================================='
    Say ('Receipts: ' + $script:OutDir)
}

# ---------------------------------------------------------------- apply

function Invoke-ModeApply {
    if (-not $Run)                          { Stop-Usage 'apply needs -Run. Nothing was done.' }
    if ([string]::IsNullOrEmpty($Approval)) { Stop-Usage 'apply needs -Approval "<the exact sentence>". Nothing was done.' }

    # The recorded-version gate runs before the writer lock is taken and long before anything
    # contacts his Brain: a kit pointed at the wrong manifest is a mistake to catch quietly, not
    # one that leaves a lock directory behind for the next person to reason about.
    Resolve-NodeExe
    Resolve-ManifestPath
    $recorded = Get-ManifestValue -Path 'brain.version'
    if ($ExpectFromVersions -notcontains $recorded) {
        Stop-Kit ('this manifest records version "' + $recorded + '", not ' + ($ExpectFromVersions -join ' or '))
    }

    $lock = Enter-WriterLock
    try {
        Say '=============================================================='
        Say ' APPLY — ONE update. Never Ctrl-C. Never retry.'
        Say '=============================================================='
        Initialize-BrainContext

        Say ''
        Say 'health (read-only)'
        Invoke-HealthProbe -Label '03-health-recheck' | Out-Null

        Say 're-running the preview so the sentence is checked against what is true right now'
        $prc = Invoke-BrainRead -Stem '04-preview-recheck' -BrainArgs @(
            'update', $script:ManifestPath, '--preview',
            '--expect-runtime-sha256', $script:RuntimeSha, '--json')
        Say ('  04-preview-recheck exit=' + $prc)
        $cls = Get-PreviewClassification -PreviewJsonPath (Join-Path $script:OutDir '04-preview-recheck.stdout') -ExitCode $prc

        if ($cls.kind -eq 'expected_refusal') {
            Say ''
            Say ('The preview refuses on this Brain (' + $cls.error_code + '). There is no plan, so there is')
            Say 'nothing an approval can authorize. apply cannot run. This is the expected pre-0.4.4'
            Say 'outcome — stop here and send the receipts folder to the technician.'
            Exit-WriterLock -Lock $lock
            exit $script:ExitExpectedRefusal
        }
        if ($cls.kind -ne 'modern') {
            Say ''
            Say 'STOP — apply requires a MODERN plan and this is not one:'
            foreach ($f in $cls.fails) { Say ('  ' + $f) }
            Exit-WriterLock -Lock $lock
            exit $script:ExitUnclassified
        }

        # The plan fingerprint the owner was read must still be the plan fingerprint now.
        $recordedFpFile = Join-Path $script:OutDir 'plan-fingerprint.txt'
        if (-not (Test-Path -LiteralPath $recordedFpFile)) {
            Stop-Kit ('no preview plan fingerprint on record at ' + $recordedFpFile + ' — run preview first and use its sentence')
        }
        $recordedFp = ''
        foreach ($line in (Get-Content -LiteralPath $recordedFpFile)) {
            if ($line -match '^fingerprint\s+(\S+)') { $recordedFp = $Matches[1] }
        }
        if ($recordedFp -ne $cls.fingerprint) {
            Say ''
            Say 'The plan is not the plan he was shown.'
            Say ('  recorded at preview : ' + $recordedFp)
            Say ('  observed just now   : ' + $cls.fingerprint)
            Stop-Kit 'the plan changed since preview (the plan fingerprint differs) — run preview again and use its sentence'
        }

        $fresh = New-UpdateSentence -BrainName $script:BrainName -BrainDomain $script:BrainDomain `
            -FromVersion $script:FromVersion -ManifestSha $script:ManifestSha `
            -PlanFingerprint $cls.fingerprint -PackageSha $script:PkgSha -RuntimeSha $script:RuntimeSha `
            -NodeSha $script:NodeSha -CliSha $script:InstalledCliSha -AuthState $script:AuthState
        Test-ApprovalSentence -Given $Approval -Fresh $fresh -FreshPathStem ('approval-sentence-fresh-' + $cls.fingerprint)
        Write-ApprovalReceipt -Path (Join-Path $script:OutDir ('approval-recorded-' + $cls.fingerprint + '.txt')) -Sentence $Approval
        Say 'approval matched and recorded'

        Invoke-OneUpdate -Stem '05-update'
        Invoke-PostUpdateReadback -AfterStem '06-preview-after' -ReadbackStem '07' -WantVectors $cls.vectors
    } finally {
        Exit-WriterLock -Lock $lock
    }
}

# ---------------------------------------------------------------- resume-preview / resume

function Show-ResumeExpectedTable {
    Say ''
    Say 'What resume-preview should print if all is well'
    Say '  health   a NON-ZERO exit, HEALTH_CHECK_FAILED, and the sentence'
    Say ('           "' + $PauseSentence + '".')
    Say '           A health that exits 0 means this Brain is no longer paused — that is a STOP here.'
    Say '  preview  a NON-ZERO exit and a read-only REFUSAL: status failed, read_only true,'
    Say '           authorizes_update false, NO plan and NO plan fingerprint, exactly 1 credential'
    Say '           read, 1 network request, and zero of every other counter. The code should be'
    Say ('           ' + ($PausedRefusalCodes -join ' or ') + '.')
    Say '           Any OTHER code, or a plan, is a STOP.'
    Say '  then     the paused-state observation fingerprint, the MINUTE it was taken, the file'
    Say '           both were written to, and the RESUME approval sentence naming both.'
    Say ''
    Say 'Known and expected, not faults'
    Say '  * Both commands exit non-zero. In this state that is the correct answer, not a failure.'
    Say '  * There is no vector count and no queue depth to read: the paused preview returns no plan,'
    Say '    and health dies at the pause before it reaches the D1 backlog section.'
    Say '  * Each failed health run writes ONE local private support-journal note on this PC.'
    Say '    Nothing is uploaded and nothing is written to the Brain.'
    Say '  * The runtime SHA-256 in the RESUME sentence is THE KIT''S, not an observation of this'
    Say '    Brain: it says which package is about to be run. The paused preview refuses before'
    Say '    binding it to anything, so on THIS path that hash proves nothing about what is deployed.'
    Say ('  * The sentence names the minute the observation was taken, and it goes stale after ' + $ResumeObsMaxAgeSeconds + 's')
    Say '    (20 minutes), because the fingerprint itself never goes stale while the Brain stays'
    Say '    paused: without the time, one captured sentence would authorize a resume for ever.'
}

function Invoke-ModeResumePreview {
    Say '=============================================================='
    Say ' RESUME-PREVIEW — read-only. Two looks at this Brain, spaced.'
    Say ' Nothing is written. This mode is for ONE state and no other:'
    Say ' an update that STOPPED with the Brain left PAUSED mid-update,'
    Say ' with the new Worker already deployed. If the Brain is healthy,'
    Say ' this mode refuses — use preview and apply instead.'
    Say '=============================================================='
    Initialize-BrainContext
    Show-ResumeExpectedTable

    Say ''
    Say ('observing the paused state (read-only: one health, then one preview, ' + $ResumeObsSpacingSeconds + 's apart)')
    Invoke-PausedObservation -Label '10-resume-observe' -RecordedVersion $script:FromVersion

    Write-Utf8NoBom -Path $script:ResumeFpPath `
        -Text (('fingerprint ' + $script:ResumeObsFp) + "`r`n" + ('observed_at ' + $script:ResumeObsAt) + "`r`n")

    $sentence = New-ResumeSentence -BrainName $script:BrainName -BrainDomain $script:BrainDomain `
        -FromVersion $script:FromVersion -ManifestSha $script:ManifestSha `
        -ObservationFingerprint $script:ResumeObsFp -ObservedAt $script:ResumeObsAt `
        -PackageSha $script:PkgSha -RuntimeSha $script:RuntimeSha `
        -NodeSha $script:NodeSha -CliSha $script:InstalledCliSha -AuthState $script:AuthState
    $sp = Join-Path $script:OutDir ('resume-approval-sentence-' + $script:ResumeObsFp + '.txt')
    Write-Utf8NoBom -Path $sp -Text $sentence

    Say ''
    Say '--------------------------------------------------------------'
    Say 'RECORD ONLY — do not read the hashes aloud.'
    Say 'Say plainly that his Brain is paused right now, that his records are readable but he'
    Say 'cannot add to them until this finishes, and that this is one more attempt at the SAME'
    Say 'update he already agreed to — not a new one, and not a repair. Get his yes, then paste'
    Say 'this sentence back with -Approval.'
    Say '--------------------------------------------------------------'
    Write-Output $sentence
    Say '--------------------------------------------------------------'
    Say ('Saved to ' + $sp)
    Say ''
    Say 'Then run, pasting the sentence exactly:'
    Say ('  .\' + $script:ScriptFileName + ' resume -Run -Approval "<the sentence>"')
    Say ''
    Say ('This sentence goes stale. It was taken at ' + $script:ResumeObsAt + ' and resume refuses it more than')
    Say ([string] $ResumeObsMaxAgeSeconds + 's (20 minutes) after that. If the conversation runs long, run resume-preview')
    Say 'again and read him the fresh sentence — that is the intended outcome, not a fault.'
}

function Invoke-ModeResume {
    if (-not $Run)                          { Stop-Usage 'resume needs -Run. Nothing was done.' }
    if ([string]::IsNullOrEmpty($Approval)) { Stop-Usage 'resume needs -Approval "<the exact sentence>". Nothing was done.' }

    Resolve-NodeExe
    Resolve-ManifestPath
    $recorded = Get-ManifestValue -Path 'brain.version'
    if ($ExpectFromVersions -notcontains $recorded) {
        Stop-Kit ('this manifest records version "' + $recorded + '", not ' + ($ExpectFromVersions -join ' or ') +
                  '. A stopped update leaves the manifest untouched, so a manifest recording something else means this is not the paused-mid-update state. Stop and reassess.')
    }

    $lock = Enter-WriterLock
    try {
        Say '=============================================================='
        Say ' RESUME — ONE update, from the top. Never Ctrl-C. Never retry.'
        Say '=============================================================='
        Initialize-BrainContext

        # Read the recorded observation and bound its age BEFORE his Brain is touched: a stale or
        # missing record is refused without spending a request on it. The same check runs again
        # inside the gate after the re-observation, and that one is the authoritative one.
        Read-ResumeRecord -Path $script:ResumeFpPath
        Say ('recorded paused-state observation: ' + $script:ResumeRecordedFp +
             ' taken ' + $script:ResumeRecordedAt + ' (' + $script:ResumeRecordedAge + 's ago)')
        Test-ResumeRecordFresh

        Say 're-observing the paused state so the sentence is checked against what is true right now'
        Invoke-PausedObservation -Label '11-resume-recheck' -RecordedVersion $script:FromVersion
        Test-ResumeObservationGate -RecordPath $script:ResumeFpPath -ObservedNow $script:ResumeObsFp

        # The sentence names the minute the RECORDED observation was taken — the one he was read —
        # not this instant, so the rebuilt sentence can match his byte for byte. What keeps that
        # honest is the freshness bound above, not a fresh timestamp here.
        $fresh = New-ResumeSentence -BrainName $script:BrainName -BrainDomain $script:BrainDomain `
            -FromVersion $script:FromVersion -ManifestSha $script:ManifestSha `
            -ObservationFingerprint $script:ResumeObsFp -ObservedAt $script:ResumeRecordedAt `
            -PackageSha $script:PkgSha -RuntimeSha $script:RuntimeSha `
            -NodeSha $script:NodeSha -CliSha $script:InstalledCliSha -AuthState $script:AuthState
        Test-ApprovalSentence -Given $Approval -Fresh $fresh -FreshPathStem ('resume-approval-sentence-fresh-' + $script:ResumeObsFp)
        Write-ApprovalReceipt -Path (Join-Path $script:OutDir ('resume-approval-recorded-' + $script:ResumeObsFp + '.txt')) -Sentence $Approval
        Say 'approval matched and recorded'

        # The paused preview returns no plan and so no vector count. WantVectors stays empty on
        # purpose: the shared readback then asserts verdict ready and expected == actual WITHOUT
        # a target count, instead of silently comparing against a count from some earlier run.
        Invoke-OneUpdate -Stem '12-resume-update'
        Invoke-PostUpdateReadback -AfterStem '13-preview-after' -ReadbackStem '14' -WantVectors ''
    } finally {
        Exit-WriterLock -Lock $lock
    }
}

# ---------------------------------------------------------------- selftest

$script:SelfPass = 0
$script:SelfFail = 0

function Test-Ok   { param([string] $Name) $script:SelfPass = $script:SelfPass + 1; Write-Output ('  ok   ' + $Name) }
function Test-Bad  { param([string] $Name) $script:SelfFail = $script:SelfFail + 1; Write-Output ('  FAIL ' + $Name) }
function Test-Says {
    param([string] $Name, [bool] $Condition)
    if ($Condition) { Test-Ok $Name } else { Test-Bad $Name }
}
function Test-Equal {
    param([string] $Name, [string] $Got, [string] $Want)
    if ([string]::Equals($Got, $Want, [System.StringComparison]::Ordinal)) { Test-Ok $Name }
    else {
        Test-Bad $Name
        Write-Output ('       got  : ' + $Got)
        Write-Output ('       want : ' + $Want)
    }
}

function New-FixtureFile {
    param([string] $Path, [string] $Text)
    New-KitDirectory -Path (Split-Path -Parent $Path)
    Write-Utf8NoBom -Path $Path -Text $Text
    return $Path
}

function Invoke-ModeSelftest {
    Write-Output 'SELFTEST — offline. No network, no Brain, no install, no real profile touched.'
    Write-Output ('  host: PowerShell ' + $PSVersionTable.PSVersion.ToString() + ' (' + $PSVersionTable.PSEdition + ')')

    $T = Join-Path ([System.IO.Path]::GetTempPath()) ('brain-windows-kit-selftest-' + [System.Guid]::NewGuid().ToString('N'))
    New-KitDirectory -Path $T
    $fakeHome = Join-Path $T 'profile'
    New-KitDirectory -Path $fakeHome
    $script:OutDir = Join-Path $T 'out'
    New-KitDirectory -Path $script:OutDir
    $script:LogPath = Join-Path $script:OutDir 'brain-windows-update.log'

    # Every child process and every profile read is pointed at the scratch directory, so nothing
    # in this selftest can reach a real Brain's state, a real manifest or a real prefix.
    $saved = @{}
    foreach ($n in @('USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME')) {
        $saved[$n] = [System.Environment]::GetEnvironmentVariable($n)
    }
    [System.Environment]::SetEnvironmentVariable('USERPROFILE', $fakeHome)
    [System.Environment]::SetEnvironmentVariable('APPDATA',     (Join-Path $fakeHome 'AppData\Roaming'))
    [System.Environment]::SetEnvironmentVariable('LOCALAPPDATA',(Join-Path $fakeHome 'AppData\Local'))
    [System.Environment]::SetEnvironmentVariable('HOME',        $fakeHome)

    try {
        Resolve-NodeExe
        $script:NodeSha = Get-Sha256OfFile -Path $script:NodeExe

        # ---- T0 the three parser/process regressions fixed by this review ----------------------
        $noArgExe = (Get-Command -Name 'whoami' -CommandType Application -ErrorAction Stop |
                     Select-Object -First 1).Source
        $noArgOut = Join-Path $T 'no-arguments.stdout'
        $noArgErr = Join-Path $T 'no-arguments.stderr'
        $noArgRc = Invoke-Captured -FilePath $noArgExe -Arguments @() `
                                   -StdoutPath $noArgOut -StderrPath $noArgErr
        Test-Says 'T0  Invoke-Captured runs a command with NO arguments (ArgumentList omitted)' `
                  (($noArgRc -eq 0) -and (Test-Path -LiteralPath $noArgOut))

        $loggedJson = New-FixtureFile -Path (Join-Path $T 'logged-receipt.txt') -Text (
            'log line contains an unmatched { before the receipt' + "`r`n" +
            '{"status":"older"}' + "`r`n" +
            '{"status":"last","nested":{"text":"a } brace inside a string"}}' + "`r`n" +
            'trailing human text')
        $parsedLast = Read-JsonReceipt -Path $loggedJson
        Test-Says 'T0b Read-JsonReceipt returns the LAST complete object after a log brace' `
                  ([string]::Equals([string] (Get-Prop -Object $parsedLast -Name 'status'), 'last',
                                    [System.StringComparison]::Ordinal))

        $nestedArrays = '{"z":[[1,2],["x",[true,null]]],"a":"ok"}' | ConvertFrom-Json
        $nestedCanonical = ConvertTo-CanonicalJson -Value $nestedArrays
        Test-Equal 'T0c canonical JSON handles nested arrays before the PSObject branch' `
                   $nestedCanonical '{"a":"ok","z":[[1,2],["x",[true,null]]]}'

        # ---- a fake prefix carrying all five candidate-build signatures ----------------------
        $fp = Join-Path $fakeHome 'prefix'
        $root = Join-Path $fp 'node_modules\brain-installer'
        New-FixtureFile -Path (Join-Path $root 'brain.mjs') -Text @'
if (process.argv.includes("--version")) { console.log("0.4.8"); process.exit(0); }
process.exit(1);
'@ | Out-Null
        New-FixtureFile -Path (Join-Path $root 'worker\src\index.js')            -Text 'const take = Math.max(limit, docs.length);' | Out-Null
        New-FixtureFile -Path (Join-Path $root 'worker\src\lib\store-d1.js')     -Text 'const CTE = "INVENTORY_DOCUMENT_CTES_SQL";' | Out-Null
        New-FixtureFile -Path (Join-Path $root 'worker\src\lib\owner-notes.js')  -Text 'const field = "sweep receipt by construction";' | Out-Null
        New-FixtureFile -Path (Join-Path $root 'worker\src\lib\store.js')        -Text 'const commit = "revisionCommitReturned";' | Out-Null
        New-FixtureFile -Path (Join-Path $root 'operations\bank-feed-owner-secrets.mjs') -Text '// bank feed owner secrets' | Out-Null

        # ---- T1 the five-signature prefix check ---------------------------------------------
        $okPrefix = $true
        try { Test-Prefix -PrefixPath $fp } catch { $okPrefix = $false }
        Test-Says 'T1  a prefix carrying all five candidate-build signatures verifies' $okPrefix

        # Each signature removed in turn must be a hard stop. Test-Prefix calls Stop-Kit, which
        # exits, so each is run in a child process of this same script.
        $selfExe = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
        function Invoke-Child {
            param([string[]] $ChildArgs)
            $so = Join-Path $T ('child-' + [System.Guid]::NewGuid().ToString('N') + '.out')
            $se = $so + '.err'
            $full = @('-NoProfile', '-NonInteractive', '-File', $PSCommandPath) + $ChildArgs
            $rc = Invoke-Captured -FilePath $selfExe -Arguments $full -StdoutPath $so -StderrPath $se
            $txt = ''
            foreach ($f in @($so, $se)) {
                if (Test-Path -LiteralPath $f) {
                    $t = Get-Content -LiteralPath $f -Raw
                    if ($null -ne $t) { $txt = $txt + $t }
                }
            }
            return @{ code = $rc; text = $txt }
        }

        $sigFiles = @(
            @{ n = '1/5'; f = (Join-Path $root 'worker\src\index.js') },
            @{ n = '2/5'; f = (Join-Path $root 'worker\src\lib\store-d1.js') },
            @{ n = '3/5'; f = (Join-Path $root 'worker\src\lib\owner-notes.js') },
            @{ n = '5/5'; f = (Join-Path $root 'worker\src\lib\store.js') }
        )
        foreach ($sf in $sigFiles) {
            $keep = Get-Content -LiteralPath $sf.f -Raw
            Write-Utf8NoBom -Path $sf.f -Text '// nothing to see here'
            $r = Invoke-Child -ChildArgs @('__verify-prefix', '-Prefix', $fp, '-Out', (Join-Path $T 'childout'))
            Test-Says ('T2  a prefix WITHOUT signature ' + $sf.n + ' is refused') `
                      (($r.code -ne 0) -and ($r.text -match 'candidate-build check failed'))
            Write-Utf8NoBom -Path $sf.f -Text $keep
        }
        # Signature 4/5 is presence-only, so its real negative test removes the file entirely.
        $bf = Join-Path $root 'operations\bank-feed-owner-secrets.mjs'
        $keep = Get-Content -LiteralPath $bf -Raw
        Remove-Item -LiteralPath $bf -Force
        $r = Invoke-Child -ChildArgs @('__verify-prefix', '-Prefix', $fp, '-Out', (Join-Path $T 'childout'))
        Test-Says 'T2b an absent bank-feed module (signature 4/5) is refused' `
                  (($r.code -ne 0) -and ($r.text -match '4/5'))
        Write-Utf8NoBom -Path $bf -Text $keep

        # A CLI reporting the wrong version.
        $cli = Join-Path $root 'brain.mjs'
        $keepCli = Get-Content -LiteralPath $cli -Raw
        Write-Utf8NoBom -Path $cli -Text 'if (process.argv.includes("--version")) { console.log("0.4.1"); process.exit(0); }'
        $r = Invoke-Child -ChildArgs @('__verify-prefix', '-Prefix', $fp, '-Out', (Join-Path $T 'childout'))
        Test-Says 'T3  a prefix reporting 0.4.1 is refused as not 0.4.8' `
                  (($r.code -ne 0) -and ($r.text -match 'expected 0\.4\.8'))
        Write-Utf8NoBom -Path $cli -Text $keepCli

        # ---- T4..T9 the PREVIEW classifier ---------------------------------------------------
        $effectsOk = '"effects":{"credential_reads":1,"network_requests":1,"manifest_writes":0,"brain_writes":0,"cloudflare_control_requests":0,"deployments":0,"browser_launches":0,"package_installs":0,"workspace_writes":0,"skill_writes":0}'

        $modern = New-FixtureFile -Path (Join-Path $T 'fx-modern.json') -Text (
            '{"status":"pre_update_check_complete","projection_ready":true,' +
            '"plan_fingerprint":"a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",' +
            '"plan":{"version_relation":"upgrade","deployed_projection":{"verdict":"ready",' +
            '"expected_vectors":406135,"actual_vectors":406135,' +
            '"queue":{"pending":0,"upserts":0,"deletes":0,"submitted":0}}},' + $effectsOk + '}')
        $cls = Get-PreviewClassification -PreviewJsonPath $modern -ExitCode 0
        Test-Says 'T4  a clean MODERN plan classifies as modern' ($cls.kind -eq 'modern')
        Test-Says 'T4b the plan fingerprint and the vector count come back' `
                  (($cls.fingerprint -eq 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90') -and ($cls.vectors -eq '406135'))

        $refusal = New-FixtureFile -Path (Join-Path $T 'fx-refusal-receipt-invalid.json') -Text (
            '{"status":"failed","read_only":true,"authorizes_update":false,"projection_ready":false,' +
            '"error_code":"UPDATE_PREVIEW_READINESS_RECEIPT_INVALID",' + $effectsOk + '}')
        $cls = Get-PreviewClassification -PreviewJsonPath $refusal -ExitCode 1
        Test-Says 'T5  the pre-0.4.4 READINESS_RECEIPT_INVALID refusal classifies as expected_refusal' `
                  ($cls.kind -eq 'expected_refusal')

        $mismatch = New-FixtureFile -Path (Join-Path $T 'fx-refusal-mismatch.json') -Text (
            '{"status":"failed","read_only":true,"authorizes_update":false,"projection_ready":false,' +
            '"error_code":"UPDATE_PREVIEW_DEPLOYED_GENERATION_MISMATCH",' + $effectsOk + '}')
        $cls = Get-PreviewClassification -PreviewJsonPath $mismatch -ExitCode 1
        Test-Says 'T5b a DEPLOYED_GENERATION_MISMATCH refusal also classifies as expected_refusal' `
                  ($cls.kind -eq 'expected_refusal')

        $paused = New-FixtureFile -Path (Join-Path $T 'fx-refusal-paused.json') -Text (
            '{"status":"failed","read_only":true,"authorizes_update":false,"projection_ready":false,' +
            '"error_code":"UPDATE_PREVIEW_DEPLOYED_DRAIN_PAUSED",' + $effectsOk + '}')
        $cls = Get-PreviewClassification -PreviewJsonPath $paused -ExitCode 1
        Test-Says 'T6  the PAUSED refusal is NOT treated as the expected pre-0.4.4 one — it routes to resume' `
                  ($cls.kind -eq 'paused')

        $legacy = New-FixtureFile -Path (Join-Path $T 'fx-legacy.json') -Text (
            '{"status":"legacy_observation_complete","error_code":"UPDATE_PREVIEW_LEGACY_GENERATION_UNBOUND",' +
            '"authorizes_update":false,"projection_ready":false,' + $effectsOk + '}')
        $cls = Get-PreviewClassification -PreviewJsonPath $legacy -ExitCode 1
        Test-Says 'T7  the 0.4.6 LEGACY receipt (the Mac kit''s contract) is refused by this kit' `
                  ($cls.kind -eq 'unclassified')

        $writes = New-FixtureFile -Path (Join-Path $T 'fx-refusal-writes.json') -Text (
            '{"status":"failed","read_only":true,"authorizes_update":false,' +
            '"error_code":"UPDATE_PREVIEW_READINESS_RECEIPT_INVALID",' +
            '"effects":{"credential_reads":1,"network_requests":1,"manifest_writes":1,"brain_writes":0}}')
        $cls = Get-PreviewClassification -PreviewJsonPath $writes -ExitCode 1
        Test-Says 'T8  a refusal that recorded a WRITE is refused, not accepted as expected' `
                  ($cls.kind -eq 'unclassified')

        $unknownCounter = New-FixtureFile -Path (Join-Path $T 'fx-refusal-unknown-counter.json') -Text (
            '{"status":"failed","read_only":true,"authorizes_update":false,' +
            '"error_code":"UPDATE_PREVIEW_READINESS_RECEIPT_INVALID",' +
            '"effects":{"credential_reads":1,"network_requests":1,"some_new_counter":2}}')
        $cls = Get-PreviewClassification -PreviewJsonPath $unknownCounter -ExitCode 1
        Test-Says 'T8b a counter this script has never heard of, non-zero, is still refused' `
                  ($cls.kind -eq 'unclassified')

        $planExit = Get-PreviewClassification -PreviewJsonPath $modern -ExitCode 1
        Test-Says 'T9  a modern-looking receipt with a non-zero exit is NOT accepted as a plan' `
                  ($planExit.kind -ne 'modern')
        $garbage = New-FixtureFile -Path (Join-Path $T 'fx-garbage.txt') -Text 'this is not json'
        $cls = Get-PreviewClassification -PreviewJsonPath $garbage -ExitCode 1
        Test-Says 'T9b output with no JSON at all is unclassified, never silently passed' ($cls.kind -eq 'unclassified')
        $modernQueue = New-FixtureFile -Path (Join-Path $T 'fx-modern-queue.json') -Text (
            (Get-Content -LiteralPath $modern -Raw).Replace('"pending":0', '"pending":7'))
        $cls = Get-PreviewClassification -PreviewJsonPath $modernQueue -ExitCode 0
        Test-Says 'T9c a modern plan with a non-empty queue is refused' ($cls.kind -ne 'modern')
        $modernVec = New-FixtureFile -Path (Join-Path $T 'fx-modern-vec.json') -Text (
            (Get-Content -LiteralPath $modern -Raw).Replace('"actual_vectors":406135', '"actual_vectors":406100'))
        $cls = Get-PreviewClassification -PreviewJsonPath $modernVec -ExitCode 0
        Test-Says 'T9d a modern plan where expected != actual is refused' ($cls.kind -ne 'modern')

        # ---- T10..T16 the PAUSED-state observation -------------------------------------------
        # These two byte strings are the REAL captured health outputs named by the review,
        # including their ANSI escape sequences. They are embedded because section 2 copies only
        # this script and the README into the Windows rehearsal worktree.
        $healthPaused = Join-Path $T 'fx-health-paused.txt'
        [System.IO.File]::WriteAllBytes($healthPaused, [Convert]::FromBase64String(
            'G1sybcK3G1swbSAgICAgcHJvYmluZyBodHRwczovL2JyYWluLmphbWVzZ3VsZGFuLmNvbQobWzJtwrcbWzBtICAgICBwdWJsaWMgL2hlYWx0aCAyMDA7IGV4YWN0IHZlcnNpb24gYW5kIHdyaXRlciBzdGF0ZSByZWNlaXZlZCwgYmluZGluZyBpdCB0byBhdXRoZW50aWNhdGVkIGludmVudG9yeQobWzMxbWZhaWwbWzBtICB0aGlzIEJyYWluIGlzIHBhdXNlZCBmb3IgYW4gdXBkYXRlIGFuZCBjYW5ub3QgYWNjZXB0IGRvY3VtZW50cy4KICAgICAgSXRzIHJlYWQtb25seSBjb3JwdXMgcmVtYWlucyBhdmFpbGFibGUsIGJ1dCBvcmRpbmFyeSBoZWFsdGggY2Fubm90IHBhc3MgdW50aWwKICAgICAgYGJyYWluIHVwZGF0ZSA8bWFuaWZlc3Q+YCBmaW5pc2hlcyBhbmQgdGhlIHdyaXRlciBpcyBhY3RpdmUuCiAgSXNzdWUgY29kZTogSEVBTFRIX0NIRUNLX0ZBSUxFRAogIFdoYXQgdG8gdHJ5IG5leHQ6IGJyYWluIHN1cHBvcnQgLS1leHBsYWluIEhFQUxUSF9DSEVDS19GQUlMRUQK'))
        $obsOut = Join-Path $T 'obs-1.json'
        $o = Test-PausedObservation -PreviewJsonPath $paused -PreviewExit 1 `
                                    -HealthTextPath $healthPaused -HealthExit 1 `
                                    -ObservationOutPath $obsOut -RecordedVersion '0.4.0'
        Test-Says 'T10 the DRAIN_PAUSED refusal plus a paused health is accepted' $o.ok
        Test-Says 'T10b the observation fingerprint is a 64-hex sha256' ($o.fingerprint -match '^[0-9a-f]{64}$')
        Test-Says 'T10c the observation file records observed_at beside the fingerprint' `
                  ((Test-Path -LiteralPath $obsOut) -and ((Get-Content -LiteralPath $obsOut -Raw) -match '"observed_at":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}'))
        Test-Says 'T10d the fingerprint re-derives from the recorded observation body (the time is NOT hashed in)' `
                  ((Get-Sha256OfString -Text $o.body) -eq $o.fingerprint)

        $o2 = Test-PausedObservation -PreviewJsonPath $mismatch -PreviewExit 1 `
                                     -HealthTextPath $healthPaused -HealthExit 1 `
                                     -ObservationOutPath (Join-Path $T 'obs-2.json') -RecordedVersion '0.4.0'
        Test-Says 'T11 the GENERATION_MISMATCH paused refusal is accepted too' $o2.ok
        Test-Says 'T11b the two refusal codes produce DIFFERENT observation fingerprints' `
                  ($o2.fingerprint -ne $o.fingerprint)

        $o3 = Test-PausedObservation -PreviewJsonPath $paused -PreviewExit 1 `
                                     -HealthTextPath $healthPaused -HealthExit 0 `
                                     -ObservationOutPath (Join-Path $T 'obs-3.json') -RecordedVersion '0.4.0'
        Test-Says 'T12 health EXIT 0 is refused — a Brain that is no longer paused must not be resumed' (-not $o3.ok)

        $healthSkew = Join-Path $T 'fx-health-skew.txt'
        [System.IO.File]::WriteAllBytes($healthSkew, [Convert]::FromBase64String(
            'G1szMW1mYWlsG1swbSAgdGhlIGF1dGhlbnRpY2F0ZWQgZG9jdW1lbnRzIHJlY2VpcHQgZGlkIG5vdCBtYXRjaCB0aGUgcHVibGljIFdvcmtlciB2ZXJzaW9uIGFuZCB3cml0ZXIgbW9kZS4KICBJc3N1ZSBjb2RlOiBIRUFMVEhfQ0hFQ0tfRkFJTEVECg=='))
        $o4 = Test-PausedObservation -PreviewJsonPath $paused -PreviewExit 1 `
                                     -HealthTextPath $healthSkew -HealthExit 1 `
                                     -ObservationOutPath (Join-Path $T 'obs-4.json') -RecordedVersion '0.4.0'
        Test-Says 'T13 the receipt-SKEW health failure (no pause sentence) is refused, not read as paused' (-not $o4.ok)

        $healthLive = New-FixtureFile -Path (Join-Path $T 'fx-health-live-drain.txt') -Text (
            (Get-Content -LiteralPath $healthPaused -Raw) + "`r`nvector_drain_mode: active`r`n")
        $o5 = Test-PausedObservation -PreviewJsonPath $mismatch -PreviewExit 1 `
                                     -HealthTextPath $healthLive -HealthExit 1 `
                                     -ObservationOutPath (Join-Path $T 'obs-5.json') -RecordedVersion '0.4.0'
        Test-Says 'T14 an opportunistic LIVE drain-mode value fails closed even with the real pause sentence present' (-not $o5.ok)

        $healthAccepting = New-FixtureFile -Path (Join-Path $T 'fx-health-accepting.txt') -Text (
            (Get-Content -LiteralPath $healthPaused -Raw) + "`r`n`"accepting_documents`": true`r`n")
        $o6 = Test-PausedObservation -PreviewJsonPath $paused -PreviewExit 1 `
                                     -HealthTextPath $healthAccepting -HealthExit 1 `
                                     -ObservationOutPath (Join-Path $T 'obs-6.json') -RecordedVersion '0.4.0'
        Test-Says 'T15 a JSON-shaped "accepting_documents": true is SEEN and refused' (-not $o6.ok)

        $o7 = Test-PausedObservation -PreviewJsonPath $modern -PreviewExit 0 `
                                     -HealthTextPath $healthPaused -HealthExit 1 `
                                     -ObservationOutPath (Join-Path $T 'obs-7.json') -RecordedVersion '0.4.0'
        Test-Says 'T16 a real MODERN plan is refused by the resume gate' (-not $o7.ok)

        # ---- T20..T24 the sentences -----------------------------------------------------------
        $s1 = New-UpdateSentence -BrainName 'fake-brain' -BrainDomain 'fake.example.invalid' -FromVersion '0.4.0' `
              -ManifestSha 'MSHA' -PlanFingerprint 'FPX' -PackageSha 'PKGX' -RuntimeSha 'RTX' `
              -NodeSha 'NODEX' -CliSha 'CLIX' -AuthState 'present'
        $s1b = New-UpdateSentence -BrainName 'fake-brain' -BrainDomain 'fake.example.invalid' -FromVersion '0.4.0' `
               -ManifestSha 'MSHA' -PlanFingerprint 'FPX' -PackageSha 'PKGX' -RuntimeSha 'RTX' `
               -NodeSha 'NODEX' -CliSha 'CLIX' -AuthState 'present'
        Test-Equal 'T20 the update sentence is byte-identical on two runs' $s1 $s1b
        foreach ($want in @('one update of fake-brain (fake.example.invalid)', 'from 0.4.0 to 0.4.8 build e44a38b',
                            'manifest SHA-256 MSHA', 'plan fingerprint FPX', 'package SHA-256 PKGX',
                            'runtime SHA-256 RTX', 'Node SHA-256 NODEX', 'CLI SHA-256 CLIX',
                            'one attempt', 'no automatic retry', 'workers.dev',
                            'not publicly released', 'should not be used on a customer Brain')) {
            Test-Says ('T20 the update sentence contains "' + $want + '"') ($s1.IndexOf($want) -ge 0)
        }
        $s3 = New-UpdateSentence -BrainName 'fake-brain' -BrainDomain 'fake.example.invalid' -FromVersion '0.4.0' `
              -ManifestSha 'MSHA' -PlanFingerprint 'FPX' -PackageSha 'PKGX' -RuntimeSha 'RTX' `
              -NodeSha 'NODEX' -CliSha 'CLIX' -AuthState 'absent'
        Test-Says 'T21 an absent auth_profile adds the sign-in carve-out' `
                  (($s3 -ne $s1) -and ($s3.IndexOf('no Cloudflare sign-in profile yet') -ge 0))

        $r1 = New-ResumeSentence -BrainName 'fake-brain' -BrainDomain 'fake.example.invalid' -FromVersion '0.4.0' `
              -ManifestSha 'MSHA' -ObservationFingerprint 'OBSX' -ObservedAt '2026-09-20T14:05-07:00' `
              -PackageSha 'PKGX' -RuntimeSha 'RTX' -NodeSha 'NODEX' -CliSha 'CLIX' -AuthState 'present'
        Test-Says 'T22 the RESUME sentence names the observation AND the minute it was taken' `
                  (($r1.IndexOf('paused-state observation OBSX taken 2026-09-20T14:05-07:00') -ge 0))
        Test-Says 'T22b the RESUME sentence carries the held-candidate disclosure, byte-identical to the Mac kit''s' `
                  ($r1.IndexOf('whose own packaged technician guidance says a held candidate should not be used on a customer Brain') -ge 0)
        # The two sentences must differ in EXACTLY the two documented spans and in nothing else.
        $derived = $s1.Replace('I approve one update of fake-brain (fake.example.invalid) from 0.4.0 to 0.4.8 build e44a38b',
                               'I approve one RESUME of the paused update of fake-brain (fake.example.invalid) from 0.4.0 to 0.4.8 build e44a38b (the paused generation already deployed)')
        $derived = $derived.Replace('plan fingerprint FPX', 'paused-state observation OBSX taken 2026-09-20T14:05-07:00')
        Test-Equal 'T23 the resume sentence differs from the update sentence ONLY in those two spans' $r1 $derived

        # ---- T25..T28 the approval gate and the freshness bound --------------------------------
        $gateOk = $true
        try { Test-ApprovalSentence -Given $s1 -Fresh $s1 -FreshPathStem 'selftest-fresh' } catch { $gateOk = $false }
        Test-Says 'T25 the approval gate accepts the identical sentence' $gateOk
        $tampered = $s1.Substring(0, $s1.Length - 1) + 'X'
        $r = Invoke-Child -ChildArgs @('__approval-gate', '-Out', (Join-Path $T 'childout'), '-Pos1', $tampered, '-Pos2', $s1)
        Test-Says 'T26 the approval gate REFUSES a one-character-altered sentence' `
                  (($r.code -ne 0) -and ($r.text -match 'does not match the fresh checks'))
        $r = Invoke-Child -ChildArgs @('__approval-gate', '-Out', (Join-Path $T 'childout'), '-Pos1', $r1, '-Pos2', $s1)
        Test-Says 'T26b a RESUME sentence cannot stand in for the ordinary update sentence' ($r.code -ne 0)
        $r = Invoke-Child -ChildArgs @('__approval-gate', '-Out', (Join-Path $T 'childout'), '-Pos1', $s3, '-Pos2', $s1)
        Test-Says 'T26c a sentence that lost its sign-in carve-out is refused' ($r.code -ne 0)

        $fresh18 = (Get-Date).AddMinutes(-18).ToString('yyyy-MM-ddTHH:mmzzz', [System.Globalization.CultureInfo]::InvariantCulture)
        $stale25 = (Get-Date).AddMinutes(-25).ToString('yyyy-MM-ddTHH:mmzzz', [System.Globalization.CultureInfo]::InvariantCulture)
        $future  = (Get-Date).AddMinutes(30).ToString('yyyy-MM-ddTHH:mmzzz', [System.Globalization.CultureInfo]::InvariantCulture)
        $recFresh = New-FixtureFile -Path (Join-Path $T 'rec-fresh.txt') -Text ("fingerprint AAAA`r`nobserved_at " + $fresh18 + "`r`n")
        $recStale = New-FixtureFile -Path (Join-Path $T 'rec-stale.txt') -Text ("fingerprint AAAA`r`nobserved_at " + $stale25 + "`r`n")
        $recNoAt  = New-FixtureFile -Path (Join-Path $T 'rec-noat.txt')  -Text "fingerprint AAAA`r`n"
        $recFuture= New-FixtureFile -Path (Join-Path $T 'rec-future.txt') -Text ("fingerprint AAAA`r`nobserved_at " + $future + "`r`n")

        $r = Invoke-Child -ChildArgs @('__resume-fp-gate', '-Out', (Join-Path $T 'childout'), '-Pos1', $recFresh, '-Pos2', 'AAAA')
        Test-Says 'T27 an 18-minute-old observation with a matching fingerprint is accepted (inside the 20-minute bound)' ($r.code -eq 0)
        $r = Invoke-Child -ChildArgs @('__resume-fp-gate', '-Out', (Join-Path $T 'childout'), '-Pos1', $recStale, '-Pos2', 'AAAA')
        Test-Says 'T27b a 25-minute-old observation is REFUSED although its fingerprint still matches exactly (replay bound)' `
                  (($r.code -ne 0) -and ($r.text -match 'stale|older than'))
        $r = Invoke-Child -ChildArgs @('__resume-fp-gate', '-Out', (Join-Path $T 'childout'), '-Pos1', $recNoAt, '-Pos2', 'AAAA')
        Test-Says 'T27c a record with no observed_at is refused — its age cannot be bounded' ($r.code -ne 0)
        $r = Invoke-Child -ChildArgs @('__resume-fp-gate', '-Out', (Join-Path $T 'childout'), '-Pos1', $recFuture, '-Pos2', 'AAAA')
        Test-Says 'T27d an observation dated in the future is refused rather than treated as fresh' ($r.code -ne 0)
        $r = Invoke-Child -ChildArgs @('__resume-fp-gate', '-Out', (Join-Path $T 'childout'), '-Pos1', $recFresh, '-Pos2', 'BBBB')
        Test-Says 'T28 a fingerprint MISMATCH is refused (the paused state changed since resume-preview)' `
                  (($r.code -ne 0) -and ($r.text -match 'not the state he was shown'))

        # ---- T30..T33 argument handling and the cheap gates ------------------------------------
        $r = Invoke-Child -ChildArgs @('apply', '-Out', (Join-Path $T 'childout'), '-Approval', 'anything')
        Test-Says 'T30 apply refuses without -Run' (($r.code -eq 64) -and ($r.text -match '-Run'))
        $r = Invoke-Child -ChildArgs @('apply', '-Out', (Join-Path $T 'childout'), '-Run')
        Test-Says 'T30b apply refuses with no approval sentence' (($r.code -eq 64) -and ($r.text -match '-Approval'))
        $r = Invoke-Child -ChildArgs @('resume', '-Out', (Join-Path $T 'childout'), '-Approval', 'anything')
        Test-Says 'T30c resume refuses without -Run' ($r.code -eq 64)
        $r = Invoke-Child -ChildArgs @('nonsense-mode', '-Out', (Join-Path $T 'childout'))
        Test-Says 'T30d an unknown mode is a usage error, not a run' ($r.code -eq 64)

        # A manifest recording a version this kit is not for must be refused before anything else.
        $badManifest = New-FixtureFile -Path (Join-Path $T 'bad.manifest.json') -Text (
            '{"manifest_version":3,"client":{"slug":"x","display_name":"X","timezone":"America/Phoenix"},' +
            '"brain":{"version":"0.4.6","worker_name":"x-brain","domain":"x.example.invalid"},' +
            '"infrastructure":{"storage":"d1","cloudflare":{"account_id":"REDACTED"}},"corpora":{}}')
        $r = Invoke-Child -ChildArgs @('apply', '-Out', (Join-Path $T 'childout'), '-Run', '-Approval', 'x',
                                       '-Manifest', $badManifest, '-Prefix', $fp, '-Kit', $script:KitDir)
        Test-Says 'T31 apply refuses a manifest recording 0.4.6 before any guard, Brain contact or lock' `
                  (($r.code -ne 0) -and ($r.text -match '0\.4\.6'))
        Test-Says 'T31b it took no writer lock on the way out' (-not (Test-Path -LiteralPath (Get-WriterLockPath)))

        $accountMarker = 'SECRET_ACCOUNT_MARKER_7F3A'
        $adminMarker   = 'SECRET_ADMIN_MARKER_91B2'
        $profileMarker = 'SECRET_PROFILE_MARKER_4C8D'
        $displayMarker = 'SECRET_DISPLAY_MARKER_2E6F'
        $probeMarker   = 'SECRET_PROBE_MARKER_5A7C'
        $goodManifest = New-FixtureFile -Path (Join-Path $T 'good.manifest.json') -Text (
            '{"manifest_version":3,"client":{"slug":"operator","display_name":"Test Operator","timezone":"America/Phoenix"},' +
            '"brain":{"version":"0.4.0","worker_name":"operator-brain","domain":"operator-brain.example.invalid"},' +
            '"infrastructure":{"storage":"d1","cloudflare":{"account_id":"' + $accountMarker + '","auth_profile":"' + $profileMarker + '"}},' +
            '"operations":{"admin_key_secret":"file://' + $adminMarker + '"},"corpora":{"google_drive":{"enabled":true}},' +
            '"testing":{"probe_questions":["q1","' + $probeMarker + '","q3"]}}')
        # Replace display_name through parsed JSON text construction so every deliberately hidden
        # manifest field carries a unique marker that the output test can detect.
        $manifestText = (Get-Content -LiteralPath $goodManifest -Raw).Replace('"display_name":"Test Operator"', '"display_name":"' + $displayMarker + '"')
        Write-Utf8NoBom -Path $goodManifest -Text $manifestText
        $script:ManifestPath = $goodManifest
        $facts = (Show-ManifestFacts | Out-String)
        $hiddenMarkers = @($accountMarker, $adminMarker, $profileMarker, $displayMarker, $probeMarker)
        $allHidden = $true
        foreach ($marker in $hiddenMarkers) {
            if ($facts.IndexOf($marker, [System.StringComparison]::Ordinal) -ge 0) { $allHidden = $false }
        }
        Test-Says 'T32 injected private manifest values are omitted; only presence/count is printed' $allHidden
        Test-Says 'T32b the recorded version is printed' ($facts -match 'recorded version\s+:\s+0\.4\.0')
        Test-Says 'T32c probe_questions is counted, not listed' ($facts -match 'probe_questions count\s+:\s+3')

        # ---- T34 the kit itself, if the sealed files are beside this script ---------------------
        if ((Test-Path -LiteralPath $script:PkgPath) -and (Test-Path -LiteralPath $script:SumsPath)) {
            $r = Invoke-Child -ChildArgs @('__verify-kit', '-Out', (Join-Path $T 'childout'), '-Kit', $script:KitDir)
            Test-Says 'T34 the real kit beside this script verifies against SHA256SUMS and the receipt' `
                      (($r.code -eq 0) -and ($r.text -match 'kit verified'))
            # A tampered copy of the kit must be refused by the checksum gate.
            $tamperKit = Join-Path $T 'tamperkit'
            New-KitDirectory -Path $tamperKit
            Copy-Item -LiteralPath $script:SumsPath  -Destination (Join-Path $tamperKit 'SHA256SUMS')
            Copy-Item -LiteralPath $script:RcptPath  -Destination (Join-Path $tamperKit 'field-prepare-receipt.json')
            Copy-Item -LiteralPath $PSCommandPath    -Destination (Join-Path $tamperKit $script:ScriptFileName)
            Copy-Item -LiteralPath $script:PkgPath   -Destination (Join-Path $tamperKit 'brain-installer-0.4.8.tgz')
            Add-Content -LiteralPath (Join-Path $tamperKit 'brain-installer-0.4.8.tgz') -Value 'tamper'
            $r = Invoke-Child -ChildArgs @('__verify-kit', '-Out', (Join-Path $T 'childout'), '-Kit', $tamperKit)
            Test-Says 'T34b a tampered package is refused by the checksum gate' `
                      (($r.code -ne 0) -and ($r.text -match 'do not match SHA256SUMS'))
        } else {
            Write-Output '  note T34 skipped: the sealed package / SHA256SUMS are not beside this script'
        }

        # ---- T35 an exit reached inside a mode cannot strand the writer lock --------------------
        $r = Invoke-Child -ChildArgs @('__lock-exit-test', '-Out', (Join-Path $T 'childout'))
        Test-Says 'T35 Stop-Kit inside a writer-locked mode explicitly releases the lock before exit' `
                  (($r.code -eq 65) -and (-not (Test-Path -LiteralPath (Get-WriterLockPath))))
    } finally {
        foreach ($n in @('USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME')) {
            [System.Environment]::SetEnvironmentVariable($n, $saved[$n])
        }
        try { Remove-Item -LiteralPath $T -Recurse -Force -ErrorAction SilentlyContinue } catch { }
    }

    Write-Output ''
    Write-Output ('SELFTEST: ' + $script:SelfPass + ' passed, ' + $script:SelfFail + ' failed')
    if ($script:SelfFail -ne 0) { exit 2 }
    Write-Output 'All checks passed. This proves this script''s own logic only — it proves nothing about any Brain.'
}

# ---------------------------------------------------------------- dispatch

switch ($Mode) {
    'discover'        { Invoke-ModeDiscover }
    'install'         { Invoke-ModeInstall }
    'preview'         { Invoke-ModePreview }
    'apply'           { Invoke-ModeApply }
    'resume-preview'  { Invoke-ModeResumePreview }
    'resume'          { Invoke-ModeResume }
    'selftest'        { Invoke-ModeSelftest }

    # internal, used only by selftest; never run in the field
    '__verify-kit'    { Resolve-NodeExe; Test-Kit }
    '__verify-prefix' { Resolve-NodeExe; Test-Prefix -PrefixPath $script:PrefixDir }
    '__approval-gate' { Test-ApprovalSentence -Given $Pos1 -Fresh $Pos2 -FreshPathStem 'gate-fresh'; Write-Output 'APPROVAL_MATCHED' }
    '__resume-fp-gate'{ Resolve-NodeExe; Test-ResumeObservationGate -RecordPath $Pos1 -ObservedNow $Pos2; Write-Output 'RESUME_FP_MATCHED' }
    '__lock-exit-test' { $lock = Enter-WriterLock; Stop-Kit 'selftest intentional exit while locked' }

    default {
        Write-Output ('usage: .\' + $script:ScriptFileName + ' discover | install | preview | apply -Run -Approval "<sentence>" | selftest')
        Write-Output ('       paused mid-update only: .\' + $script:ScriptFileName + ' resume-preview | resume -Run -Approval "<sentence>"')
        Write-Output '       options: -Manifest PATH  -Prefix PATH  -NodePath PATH  -NpmCmd PATH  -Out DIR  -Kit DIR  -Subject NAME'
        exit 64
    }
}
