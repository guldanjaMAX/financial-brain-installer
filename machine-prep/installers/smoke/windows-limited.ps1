[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ArtifactDirectory,
  [Parameter(Mandatory = $true)][string]$LogDirectory,
  [string]$ContextFile
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The hosted service normally has an elevated token. Task Scheduler's S4U
# limited principal uses the same identity without a password or logon secret.
# Public HTTPS needs no network logon credentials. Never relax the prep guard.
if ($ContextFile) {
  $context = Get-Content -LiteralPath $ContextFile -Raw | ConvertFrom-Json
  Get-ChildItem Env: | ForEach-Object { [Environment]::SetEnvironmentVariable($_.Name, $null, 'Process') }
  foreach ($property in $context.environment.PSObject.Properties) {
    [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process')
  }
  if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Hosted runner required' }
  $code = 1
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if ($identity.User.Value -cne $context.sid -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
      throw 'Bootstrap requires the same runner user with a non-administrator token'
    }
    'SAME_USER_LIMITED_TOKEN_VERIFIED=1' | Set-Content -LiteralPath (Join-Path $context.control 'session.log')
    & $context.node $context.entry windows $ArtifactDirectory $LogDirectory --bootstrap *> (Join-Path $context.control 'bootstrap.log')
    $code = $LASTEXITCODE
  } catch {
    $_ | Out-String | Set-Content -LiteralPath (Join-Path $context.control 'failure.log')
  } finally {
    [IO.File]::WriteAllText((Join-Path $context.control 'exit-code.txt'), [string]$code)
  }
  exit $code
}

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Hosted runner required' }
$control = "$LogDirectory-control"
if (Test-Path -LiteralPath $control) { throw 'Bootstrap control directory already exists' }
New-Item -ItemType Directory -Path $control -ErrorAction Stop | Out-Null
$environment = @{}
foreach ($name in @('HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC',
  'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT')) {
  $value = [Environment]::GetEnvironmentVariable($name, 'Process')
  if ($value) { $environment[$name] = $value }
}
$environment['BRAIN_NO_WRANGLER_LOGIN'] = '1'
$context = @{
  environment = $environment
  sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  node = (Get-Command node -CommandType Application).Source
  entry = Join-Path $PSScriptRoot 'run.mjs'
  control = $control
}
$contextPath = Join-Path $control 'context.json'
$context | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $contextPath
$taskName = 'InstallerBootstrap-' + [Guid]::NewGuid().ToString('N')
$registered = $false
try {
  $executable = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ArtifactDirectory "{1}" -LogDirectory "{2}" -ContextFile "{3}"' -f $PSCommandPath, $ArtifactDirectory, $LogDirectory, $contextPath
  $action = New-ScheduledTaskAction -Execute $executable -Argument $arguments
  $principal = New-ScheduledTaskPrincipal -UserId $context.sid -LogonType S4U -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
  Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -ErrorAction Stop | Out-Null
  $registered = $true
  'LIMITED_TASK_REGISTERED=1' | Set-Content -LiteralPath (Join-Path $control 'task-registration.log')
  $previousRun = (Get-ScheduledTaskInfo -TaskName $taskName).LastRunTime
  Start-ScheduledTask -TaskName $taskName
  $deadline = [DateTime]::UtcNow.AddMinutes(31)
  $resultFile = Join-Path $control 'exit-code.txt'
  while (-not (Test-Path -LiteralPath $resultFile)) {
    $info = Get-ScheduledTaskInfo -TaskName $taskName
    if ($info.LastRunTime -gt $previousRun -and (Get-ScheduledTask -TaskName $taskName).State -ne 'Running' -and $info.LastTaskResult -ne 0) {
      "LIMITED_TASK_START_FAILURE=$($info.LastTaskResult)" | Set-Content -LiteralPath (Join-Path $control 'task.log')
      throw 'Limited bootstrap task failed before its completion receipt'
    }
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Limited bootstrap task did not produce a receipt before its deadline' }
    Start-Sleep -Seconds 2
  }
  # The result is written before process exit. Wait for task completion too.
  while ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running') {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Limited bootstrap task did not exit' }
    Start-Sleep -Seconds 1
  }
  $result = [IO.File]::ReadAllText($resultFile)
  $nativeResult = (Get-ScheduledTaskInfo -TaskName $taskName).LastTaskResult
  "LIMITED_TASK_EXIT=$result native=$nativeResult" | Set-Content -LiteralPath (Join-Path $control 'task.log')
  if ($result -cne '0' -or $nativeResult -ne 0) { throw 'Limited bootstrap failed; inspect retained receipts' }
} finally {
  if ($registered) {
    if ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running') { Stop-ScheduledTask -TaskName $taskName }
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw 'Bootstrap task removal failed' }
    'LIMITED_TASK_REMOVED=1' | Set-Content -LiteralPath (Join-Path $control 'task-cleanup.log')
  }
  # Do not upload environment/path context. It contains no credential, but is
  # temporary invocation state, not a proof receipt.
  Remove-Item -LiteralPath $contextPath -Force
}
exit 0
