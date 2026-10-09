[CmdletBinding()]
param(
  [string]$ArtifactDirectory,
  [Parameter(Mandatory = $true)][string]$LogDirectory,
  [string]$ContextFile,
  [switch]$AdminControl,
  [switch]$Cleanup
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$control = "$LogDirectory-control"
$statePath = "$LogDirectory-state.json"

function Read-SessionToken {
  # TokenElevationType alone is Default for BOTH standard users and admins
  # with UAC disabled. Read TokenElevation and effective group membership too.
  if (-not ('BootstrapToken' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BootstrapToken {
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetTokenInformation(IntPtr token, int kind, out int value, int size, out int returned);
  public static int Read(IntPtr token, int kind) {
    int value, returned;
    if (!GetTokenInformation(token, kind, out value, sizeof(int), out returned) || returned != sizeof(int))
      throw new InvalidOperationException("Token readback failed");
    return value;
  }
}
'@
  }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  try {
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return [pscustomobject]@{
      sid = $identity.User.Value
      admin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
      elevated = [BootstrapToken]::Read($identity.Token, 20)
      elevationType = [BootstrapToken]::Read($identity.Token, 18)
    }
  } finally { $identity.Dispose() }
}

function Remove-BootstrapAccount($State) {
  $failures = 0
  try {
    # Enumerate and match exactly: suppressing lookup errors would turn a
    # provider/permission failure into false proof that a resource is absent.
    $task = Get-ScheduledTask | Where-Object { $_.TaskName -ceq $State.taskName -and $_.TaskPath -ceq '\' }
    if ($task) {
      if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $State.taskName }
      Unregister-ScheduledTask -TaskName $State.taskName -Confirm:$false
    }
    if (Get-ScheduledTask | Where-Object { $_.TaskName -ceq $State.taskName -and $_.TaskPath -ceq '\' }) { throw 'Task remains' }
    'STANDARD_TASK_REMOVED=1' | Add-Content -LiteralPath (Join-Path $control 'cleanup.log')
  } catch { $failures++ }
  # Save intent before account creation so always() can recover a partial run.
  # Resolve only this attempt's random account; never search by profile path.
  try {
    $user = Get-LocalUser | Where-Object { $_.Name -ceq $State.userName }
    if ($user) {
      if ($State.sid -and $user.SID.Value -cne $State.sid) { throw 'Account identity changed' }
      $State.sid = $user.SID.Value
      $State | ConvertTo-Json | Set-Content -LiteralPath $statePath
    }
    if ($State.sid) {
      $deadline = [DateTime]::UtcNow.AddSeconds(60)
      do {
        $profiles = @(Get-CimInstance Win32_UserProfile -Filter "SID='$($State.sid)'")
        if (@($profiles | Where-Object { $_.Loaded }).Count -eq 0) { break }
        if ([DateTime]::UtcNow -ge $deadline) { throw 'Profile remains loaded' }
        Start-Sleep -Seconds 2
      } while ($true)
      if ($profiles.Count -gt 1) { throw 'Ambiguous profile identity' }
      if ($profiles.Count -eq 1) {
        $State.profilePath = $profiles[0].LocalPath
        $State | ConvertTo-Json | Set-Content -LiteralPath $statePath
      }
      $profiles | Remove-CimInstance
      if (@(Get-CimInstance Win32_UserProfile -Filter "SID='$($State.sid)'").Count -ne 0 -or
          (Test-Path -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$($State.sid)") -or
          ($State.profilePath -and (Test-Path -LiteralPath $State.profilePath))) { throw 'Profile remains' }
    }
    'STANDARD_PROFILE_REMOVED=1' | Add-Content -LiteralPath (Join-Path $control 'cleanup.log')
  } catch { $failures++ }
  # A profile-removal error must not leave a usable local account behind.
  try {
    $user = Get-LocalUser | Where-Object { $_.Name -ceq $State.userName }
    if ($user) {
      if ($State.sid -and $user.SID.Value -cne $State.sid) { throw 'Account identity changed' }
      Remove-LocalUser -SID $user.SID
    }
    if (Get-LocalUser | Where-Object { $_.Name -ceq $State.userName }) { throw 'Account remains' }
    'STANDARD_USER_REMOVED=1' | Add-Content -LiteralPath (Join-Path $control 'cleanup.log')
  } catch { $failures++ }
  $contextPath = Join-Path $control 'context.json'
  if (Test-Path -LiteralPath $contextPath) { Remove-Item -LiteralPath $contextPath -Force }
  "CLEANUP_FAILURES=$failures" | Add-Content -LiteralPath (Join-Path $control 'cleanup.log')
  if ($failures -ne 0) { throw 'Standard-user cleanup failed; always cleanup must retry' }
  Remove-Item -LiteralPath $statePath -Force
}

if ($ContextFile) {
  $context = Get-Content -LiteralPath $ContextFile -Raw | ConvertFrom-Json
  $code = 1
  try {
    if ($context.githubActions -cne 'true' -or $context.runnerEnvironment -cne 'github-hosted') { throw 'Hosted runner required' }
    $token = Read-SessionToken
    $sidMatches = $token.sid -ceq $context.sid
    @('TOKEN_DECISION_REACHED=1', "SID_MATCH=$([int]$sidMatches)", "TOKEN_ADMIN=$([int]$token.admin)",
      "TOKEN_ELEVATED=$($token.elevated)", "TOKEN_ELEVATION_TYPE=$($token.elevationType)") |
      Set-Content -LiteralPath (Join-Path $control 'session.log')
    if (-not $sidMatches -or $token.admin -or $token.elevated -ne 0 -or $token.elevationType -ne 1) {
      throw 'Bootstrap requires the dedicated standard-user token'
    }
    # Read the logon-created profile BEFORE changing the process environment.
    $profileRecord = Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$($context.sid)"
    $userProfileRoot = [Environment]::ExpandEnvironmentVariables($profileRecord.ProfileImagePath)
    $profileMatches = $env:USERPROFILE -ieq $userProfileRoot -and [Environment]::GetFolderPath('UserProfile') -ieq $userProfileRoot
    $local = [Environment]::GetFolderPath('LocalApplicationData')
    $localMatches = $env:LOCALAPPDATA -ieq $local -and $local -ieq (Join-Path $userProfileRoot 'AppData\Local')
    $roaming = [Environment]::GetFolderPath('ApplicationData')
    $roamingMatches = $env:APPDATA -ieq $roaming -and $roaming -ieq (Join-Path $userProfileRoot 'AppData\Roaming')
    $probeKey = 'Software\InstallerBootstrap-' + [Guid]::NewGuid().ToString('N')
    $probeValue = [Guid]::NewGuid().ToString('N')
    try {
      New-Item -Path "HKCU:\$probeKey" -Force | Out-Null
      New-ItemProperty -LiteralPath "HKCU:\$probeKey" -Name Witness -Value $probeValue | Out-Null
      $hkcuMatches = (Get-ItemProperty -LiteralPath "Registry::HKEY_USERS\$($context.sid)\$probeKey").Witness -ceq $probeValue
    } finally { Remove-Item -LiteralPath "HKCU:\$probeKey" -Force }
    @('PROFILE_DECISION_REACHED=1', "PROFILE_MATCH=$([int]$profileMatches)", "LOCALAPPDATA_IN_PROFILE=$([int]$localMatches)",
      "APPDATA_IN_PROFILE=$([int]$roamingMatches)", "HKCU_SID_MATCH=$([int]$hkcuMatches)") |
      Add-Content -LiteralPath (Join-Path $control 'session.log')
    if (-not $profileMatches -or -not $localMatches -or -not $roamingMatches -or -not $hkcuMatches) { throw 'Profile readback failed' }
    $environment = @{}
    foreach ($name in @('SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'ProgramFiles', 'ProgramFiles(x86)')) {
      $environment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
    $environment['PATH'] = $context.path
    $environment['HOME'] = $userProfileRoot
    $environment['USERPROFILE'] = $userProfileRoot
    $environment['LOCALAPPDATA'] = $local
    $environment['APPDATA'] = $roaming
    $environment['TEMP'] = Join-Path $local 'Temp'
    $environment['TMP'] = $environment['TEMP']
    $environment['GITHUB_ACTIONS'] = $context.githubActions
    $environment['RUNNER_ENVIRONMENT'] = $context.runnerEnvironment
    $environment['BRAIN_NO_WRANGLER_LOGIN'] = '1'
    New-Item -ItemType Directory -Path $environment['TEMP'] -Force | Out-Null
    Get-ChildItem Env: | ForEach-Object { [Environment]::SetEnvironmentVariable($_.Name, $null, 'Process') }
    foreach ($name in $environment.Keys) { [Environment]::SetEnvironmentVariable($name, $environment[$name], 'Process') }
    'STANDARD_USER_SESSION_VERIFIED=1' | Add-Content -LiteralPath (Join-Path $control 'session.log')
    & $context.node $context.entry windows $ArtifactDirectory (Join-Path $LogDirectory 'lifecycle') --bootstrap *> (Join-Path $control 'bootstrap.log')
    $code = $LASTEXITCODE
  } catch {
    'STANDARD_USER_BOOTSTRAP_FAILED=1' | Set-Content -LiteralPath (Join-Path $control 'failure.log')
  } finally {
    [IO.File]::WriteAllText((Join-Path $control 'exit-code.txt'), [string]$code)
  }
  exit $code
}

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Hosted runner required' }
if ($AdminControl) {
  New-Item -ItemType Directory -Path $control -Force | Out-Null
  $token = Read-SessionToken
  @('ADMIN_CONTROL_DECISION_REACHED=1', "TOKEN_ADMIN=$([int]$token.admin)",
    "TOKEN_ELEVATED=$($token.elevated)", "TOKEN_ELEVATION_TYPE=$($token.elevationType)") |
    Set-Content -LiteralPath (Join-Path $control 'admin-control.log')
  if (-not $token.admin -or $token.elevated -ne 1 -or $token.elevationType -notin @(1, 2)) {
    throw 'Negative control did not detect the elevated runner administrator'
  }
  'ADMIN_CONTROL_VERIFIED=1' | Add-Content -LiteralPath (Join-Path $control 'admin-control.log')
  exit 0
}
if ($Cleanup) {
  if (Test-Path -LiteralPath $statePath) { Remove-BootstrapAccount (Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json) }
  exit 0
}
if (-not $ArtifactDirectory) { throw 'Signed artifact directory required' }
if ((Test-Path -LiteralPath $statePath) -or (Test-Path -LiteralPath $LogDirectory) -or (Test-Path -LiteralPath $control)) {
  throw 'Bootstrap destination already exists'
}
New-Item -ItemType Directory -Path $control, $LogDirectory | Out-Null
$state = @{
  userName = 'bs' + [Guid]::NewGuid().ToString('N').Substring(0, 18)
  taskName = 'InstallerBootstrap-' + [Guid]::NewGuid().ToString('N')
  sid = ''
  profilePath = ''
}
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath
$password = $null
$securePassword = $null
$phase = 'account'
try {
  $random = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($random) } finally { $rng.Dispose() }
  $password = 'Aa1!' + [Convert]::ToBase64String($random)
  Write-Output "::add-mask::$password"
  $securePassword = ConvertTo-SecureString $password -AsPlainText -Force
  $user = New-LocalUser -Name $state.userName -Password $securePassword -AccountNeverExpires
  $state.sid = $user.SID.Value
  $state | ConvertTo-Json | Set-Content -LiteralPath $statePath
  # SID-based built-in groups also work on localized runner images.
  $users = Get-LocalGroup -SID 'S-1-5-32-545'
  Add-LocalGroupMember -Group $users -Member $user
  $administrators = Get-LocalGroup -SID 'S-1-5-32-544'
  $adminMembership = @(Get-LocalGroupMember -Group $administrators | Where-Object { $_.SID.Value -ceq $state.sid }).Count
  $userMembership = @(Get-LocalGroupMember -Group $users | Where-Object { $_.SID.Value -ceq $state.sid }).Count
  $distinct = $state.sid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  @('ACCOUNT_DECISION_REACHED=1', "ADMIN_GROUP_MEMBERSHIPS=$adminMembership", "USERS_GROUP_MEMBERSHIPS=$userMembership",
    "DISTINCT_USER_SID=$([int]$distinct)") | Set-Content -LiteralPath (Join-Path $control 'account.log')
  if ($adminMembership -ne 0 -or $userMembership -ne 1 -or -not $distinct) { throw 'Local standard-user membership readback failed' }
  $phase = 'stage'
  # Stage readable inputs outside the runner profile. Only disposable output
  # directories receive Modify rights; no runner credentials are inherited.
  Copy-Item -LiteralPath $PSScriptRoot -Destination (Join-Path $control 'smoke') -Recurse
  Copy-Item -LiteralPath $ArtifactDirectory -Destination (Join-Path $control 'signed-input') -Recurse
  foreach ($directory in @($control, $LogDirectory)) {
    $acl = Get-Acl -LiteralPath $directory
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user.SID, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    Set-Acl -LiteralPath $directory -AclObject $acl
  }
  $phase = 'context'
  # A runner can expose several node/pwsh executables on PATH; use the first, as the shell would.
  $node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
  $pwsh = (Get-Command pwsh -CommandType Application | Select-Object -First 1).Source
  $context = @{
    sid = $state.sid
    githubActions = $env:GITHUB_ACTIONS
    runnerEnvironment = $env:RUNNER_ENVIRONMENT
    node = $node
    entry = Join-Path $control 'smoke\run.mjs'
    path = (Split-Path $node) + ';' + (Split-Path $pwsh) + ';' + [Environment]::GetEnvironmentVariable('Path', 'Machine')
  }
  $contextPath = Join-Path $control 'context.json'
  $context | ConvertTo-Json | Set-Content -LiteralPath $contextPath
  $phase = 'logon-right'
  # Windows Server grants "Log on as a batch job" only to Administrators, Backup
  # Operators and Performance Log Users. A Password-logon task for a new standard
  # user needs it, so grant it to this disposable account's SID alone.
  $rightsExport = Join-Path $control 'rights-export.inf'
  $rightsApply = Join-Path $control 'rights-apply.inf'
  $rightsDb = Join-Path $control 'rights.sdb'
  & secedit.exe /export /cfg $rightsExport /areas USER_RIGHTS /quiet | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'User-rights export failed' }
  $batchLine = @(Get-Content -LiteralPath $rightsExport | Where-Object { $_ -match '^SeBatchLogonRight\s*=' }) | Select-Object -First 1
  $batchValue = if ($batchLine) { ($batchLine -split '=', 2)[1].Trim() } else { '' }
  $batchEntry = "*$($state.sid)"
  $batchValue = if ($batchValue) { "$batchValue,$batchEntry" } else { $batchEntry }
  @('[Unicode]', 'Unicode=yes', '[Version]', 'signature="$CHICAGO$"', 'Revision=1', '[Privilege Rights]', "SeBatchLogonRight = $batchValue") |
    Set-Content -LiteralPath $rightsApply -Encoding Unicode
  & secedit.exe /configure /db $rightsDb /cfg $rightsApply /areas USER_RIGHTS /quiet | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'User-rights grant failed' }
  & secedit.exe /export /cfg $rightsExport /areas USER_RIGHTS /quiet | Out-Null
  $granted = @(Get-Content -LiteralPath $rightsExport | Where-Object { $_ -match '^SeBatchLogonRight\s*=' -and $_.Contains($batchEntry) }).Count -eq 1
  "STANDARD_BATCH_RIGHT_GRANTED=$([int]$granted)" | Set-Content -LiteralPath (Join-Path $control 'logon-right.log')
  if (-not $granted) { throw 'User-rights readback failed' }
  $phase = 'register'
  $executable = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ArtifactDirectory "{1}" -LogDirectory "{2}" -ContextFile "{3}"' -f (Join-Path $control 'smoke\windows-limited.ps1'), (Join-Path $control 'signed-input'), $LogDirectory, $contextPath
  $action = New-ScheduledTaskAction -Execute $executable -Argument $arguments
  # Password logon loads this account's profile and HKCU in a batch session.
  # Limited is supplementary; membership and native token readback are proof.
  $principal = New-ScheduledTaskPrincipal -UserId $state.sid -LogonType Password -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
  $task = New-ScheduledTask -Action $action -Principal $principal -Settings $settings
  $qualifiedUser = "$env:COMPUTERNAME\$($state.userName)"
  Register-ScheduledTask -TaskName $state.taskName -InputObject $task -User $qualifiedUser -Password $password | Out-Null
  $password = $null
  $securePassword.Dispose()
  $securePassword = $null
  $phase = 'readback'
  $registered = Get-ScheduledTask -TaskName $state.taskName
  $registeredSid = ([Security.Principal.NTAccount]::new($qualifiedUser)).Translate([Security.Principal.SecurityIdentifier]).Value
  # Task Scheduler may report a local principal as a SID, COMPUTER\name or a bare name; compare by SID.
  $principalUserId = [string]$registered.Principal.UserId
  $principalForm = if ($principalUserId -match '^S-1-') { 'sid' } elseif ($principalUserId.Contains('\')) { 'qualified' } else { 'bare' }
  "STANDARD_TASK_PRINCIPAL_FORM=$principalForm" | Set-Content -LiteralPath (Join-Path $control 'task-principal.log')
  $principalSid = if ($principalForm -eq 'sid') { $principalUserId } else {
    $principalName = if ($principalForm -eq 'qualified') { $principalUserId } else { "$env:COMPUTERNAME\$principalUserId" }
    ([Security.Principal.NTAccount]::new($principalName)).Translate([Security.Principal.SecurityIdentifier]).Value
  }
  if ($registered.Principal.LogonType -ne 'Password' -or $registered.Principal.RunLevel -ne 'Limited' -or
      $registeredSid -cne $state.sid -or $principalSid -cne $state.sid) { throw 'Task principal readback failed' }
  'STANDARD_TASK_REGISTERED=1' | Set-Content -LiteralPath (Join-Path $control 'task-registration.log')
  $phase = 'run'
  $previousRun = (Get-ScheduledTaskInfo -TaskName $state.taskName).LastRunTime
  Start-ScheduledTask -TaskName $state.taskName
  $deadline = [DateTime]::UtcNow.AddMinutes(31)
  $resultFile = Join-Path $control 'exit-code.txt'
  while (-not (Test-Path -LiteralPath $resultFile)) {
    $info = Get-ScheduledTaskInfo -TaskName $state.taskName
    if ($info.LastRunTime -gt $previousRun -and (Get-ScheduledTask -TaskName $state.taskName).State -ne 'Running' -and $info.LastTaskResult -ne 0) {
      # The native task result is a status code, never output, so it is safe to retain.
      ('STANDARD_TASK_LAST_RESULT=0x{0:X8}' -f [uint32]$info.LastTaskResult) | Set-Content -LiteralPath (Join-Path $control 'task-result.log')
      throw 'Standard-user bootstrap task failed before its completion receipt'
    }
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Standard-user bootstrap task did not produce a receipt before its deadline' }
    Start-Sleep -Seconds 2
  }
  while ((Get-ScheduledTask -TaskName $state.taskName).State -eq 'Running') {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Standard-user bootstrap task did not exit' }
    Start-Sleep -Seconds 1
  }
  $phase = 'result'
  $result = [IO.File]::ReadAllText($resultFile)
  $nativeResult = (Get-ScheduledTaskInfo -TaskName $state.taskName).LastTaskResult
  "STANDARD_TASK_EXIT=$result native=$nativeResult" | Set-Content -LiteralPath (Join-Path $control 'task.log')
  if ($result -cne '0' -or $nativeResult -ne 0) { throw 'Standard-user bootstrap failed' }
} catch {
  # Native account/task exceptions must never serialize a password-bearing call.
  # Only the phase name is recorded: no exception text, which could carry a password-bearing call.
  @('STANDARD_USER_PARENT_FAILED=1', "STANDARD_USER_PARENT_PHASE=$phase") | Set-Content -LiteralPath (Join-Path $control 'parent-failure.log')
  throw 'Standard-user bootstrap failed; inspect retained receipts'
} finally {
  $password = $null
  if ($securePassword) { $securePassword.Dispose() }
  Remove-BootstrapAccount $state
}
exit 0
