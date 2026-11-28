# Native offline tests. No CLI, download, installation, browser or credential access.
[CmdletBinding()]
param()
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$script:Pass = 0
function Assert-True($Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Case([string]$Name, [scriptblock]$Body) { & $Body; $script:Pass++; Write-Host ('PASS ' + $Name) }
$tokens = $null; $errors = $null
foreach ($name in @('setup.ps1','build.ps1','self-test.ps1')) {
    $null = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $name), [ref]$tokens, [ref]$errors)
    Assert-True ($errors.Count -eq 0) ('Parser: ' + $name)
}
. (Join-Path $PSScriptRoot 'setup.ps1') -FunctionsOnly
# Every external side effect on the orchestration path is replaced, not run.
$script:Calls = New-Object 'System.Collections.Generic.List[string]'
$script:Node = @{ Present=$true; Ready=$true; Major=24; Arch='x64' }
$script:Git = $true; $script:Claude = $true; $script:Reboot = $false
function Assert-Platform { $script:Calls.Add('platform') }
function Refresh-Path { $script:Calls.Add('path-refresh') }
function Get-NodeState { $script:Calls.Add('node-check'); return $script:Node }
function Test-Git { $script:Calls.Add('git-check'); return $script:Git }
function Find-Claude { $script:Calls.Add('claude-check'); if ($script:Claude) { return 'fixture-claude.exe' }; return $null }
function Install-Node { $script:Calls.Add('node-install'); $script:Node.Ready=$true; return $script:Reboot }
function Install-Git { $script:Calls.Add('git-install'); $script:Git=$true }
function Install-Claude { $script:Calls.Add('claude-install'); $script:Claude=$true }
function Get-ClientBundle { $script:Calls.Add('bundle'); return 'fixture-kit' }
function Open-NumberOne([string]$kit) { $script:Calls.Add('number-one'); Assert-True ($kit -ceq 'fixture-kit') 'handoff path changed' }
Case 'present tools skip; green bundle handoff reached' {
    Invoke-Setup
    Assert-True ($script:Calls.Contains('bundle') -and $script:Calls.Contains('number-one')) 'handoff not reached'
    Assert-True (-not $script:Calls.Contains('node-install') -and -not $script:Calls.Contains('git-install') -and -not $script:Calls.Contains('claude-install')) 'present tool reinstalled'
}
Case 'all missing tools install, recheck and hand off' {
    $script:Calls.Clear(); $script:Node=@{Present=$false;Ready=$false;Major=0;Arch=''}; $script:Git=$false; $script:Claude=$false
    Invoke-Setup
    foreach ($call in @('platform','node-install','git-install','claude-install','bundle','number-one')) { Assert-True ($script:Calls.Contains($call)) ('missing call: '+$call) }
    Assert-True (@($script:Calls | Where-Object { $_ -eq 'node-check' }).Count -eq 2) 'no installed-node recheck'
}
Case 'rerun skips completed prerequisite installs' {
    $script:Calls.Clear(); Invoke-Setup
    Assert-True ($script:Calls.Contains('node-check') -and $script:Calls.Contains('bundle')) 'rerun decision not reached'
    Assert-True (@($script:Calls | Where-Object { $_ -like '*-install' }).Count -eq 0) 'rerun installed a tool'
}
Case 'newer incompatible Node stops before download; decision reached' {
    $script:Calls.Clear(); $script:Node=@{Present=$true;Ready=$false;Major=25;Arch='ia32'}
    $caught=$false; try { Invoke-Setup } catch { $caught=$_.Exception.Message -eq 'NODE_INCOMPATIBLE' }
    Assert-True ($caught -and $script:Calls.Contains('node-check')) 'wrong stop or decision not reached'
    Assert-True (-not $script:Calls.Contains('node-install') -and -not $script:Calls.Contains('bundle')) 'downgrade or handoff after stop'
}
Case 'MSI reboot code stops with no bundle; node install reached' {
    $script:Calls.Clear(); $script:Node=@{Present=$false;Ready=$false;Major=0;Arch=''}; $script:Reboot=$true
    $caught=$false; try { Invoke-Setup } catch { $caught=$_.Exception.Message -eq 'REBOOT_REQUIRED' }
    Assert-True ($caught -and $script:Calls.Contains('node-install') -and -not $script:Calls.Contains('bundle')) 'reboot stop did not run'
    $script:Reboot=$false
}
# Exercise the real download/hash decision, with only transport mocked.
$scratch=Join-Path ([IO.Path]::GetTempPath()) ('setup-test-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
$script:TransportCalls=0
$script:PinChecks=0
$script:RealAssertPin=(Get-Command Assert-Pin).ScriptBlock
function Assert-Pin([string]$Url,[string]$Hash,[string[]]$Hosts) {
    $script:PinChecks++
    & $script:RealAssertPin $Url $Hash $Hosts
}
function Save-Https([string]$Url,[string]$Destination,[string[]]$AllowedHosts) {
    $script:TransportCalls++; [IO.File]::WriteAllText($Destination,'fixture-bytes')
}
try {
    $fixture=Join-Path $scratch 'fixture'; [IO.File]::WriteAllText($fixture,'fixture-bytes')
    $good=(Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash.ToLowerInvariant()
    Case 'verified download green control' {
        $script:TransportCalls=0
        Get-VerifiedDownload 'https://nodejs.org/dist/fixture' (Join-Path $scratch 'good') $good 13 @('nodejs.org')
        Assert-True ($script:TransportCalls -eq 1) 'transport not reached'
    }
    Case 'hash mismatch stops after transport' {
        $script:TransportCalls=0; $caught=$false
        try { Get-VerifiedDownload 'https://nodejs.org/dist/fixture' (Join-Path $scratch 'bad') ('0'*64) 13 @('nodejs.org') } catch { $caught=$_.Exception.Message -eq 'DOWNLOAD_HASH' }
        Assert-True ($caught -and $script:TransportCalls -eq 1) 'hash decision not reached'
    }
    Case 'size mismatch stops after transport' {
        $script:TransportCalls=0; $caught=$false
        try { Get-VerifiedDownload 'https://nodejs.org/dist/fixture' (Join-Path $scratch 'short') $good 14 @('nodejs.org') } catch { $caught=$_.Exception.Message -eq 'DOWNLOAD_SIZE' }
        Assert-True ($caught -and $script:TransportCalls -eq 1) 'size decision not reached'
    }
    Case 'unresolved pin stops before transport after pin decision' {
        $script:TransportCalls=0; $script:PinChecks=0; $caught=$false
        try { Get-VerifiedDownload 'https://nodejs.org/dist/fixture' (Join-Path $scratch 'pin') 'PIN_ME_FIXTURE_SHA256' 0 @('nodejs.org') } catch { $caught=$_.Exception.Message -eq 'PIN_REQUIRED' }
        Assert-True ($caught -and $script:PinChecks -eq 1 -and $script:TransportCalls -eq 0) 'pin decision not reached or guard failed'
    }
} finally { Remove-Item -LiteralPath $scratch -Recurse -Force }
Write-Host ('Native offline cases passed: '+$script:Pass+'; parser files: 3')
