# Windows Task Scheduler proof

This is a physical-machine field gate, not an offline or CI check. The technician runs it from an ordinary, non-administrator PowerShell window on a Windows PC after installing the exact reviewed package.

The example proves the watched-folder lane. It installs one current-user task, reads back its full Task Scheduler definition, triggers it, verifies the Brain's source receipt advanced, and removes it. Do not continue if the install says that nothing was scheduled.

```powershell
$Brain = "$env:LOCALAPPDATA\FinancialBrain\brain.cmd"
$Manifest = (Resolve-Path "$HOME\Financial Brain\brain.manifest.json").Path
$Slug = (Get-Content -Raw $Manifest | ConvertFrom-Json).client.slug
$Task = "com.brain-installer.$Slug.folder-ingest"
$TaskXml = Join-Path $env:TEMP "brain-schedule-proof.xml"

& $Brain sources $Manifest --json
& $Brain schedule $Manifest --folder --install
schtasks.exe /Query /TN $Task /XML > $TaskXml
[xml]$StoredTask = Get-Content -LiteralPath $TaskXml -Raw
$StoredTask.Task.Principals.Principal | Format-List UserId,LogonType,RunLevel
$StoredTask.Task.Triggers | Format-List
$StoredTask.Task.Actions.Exec | Format-List Command,Arguments
schtasks.exe /Run /TN $Task
do {
  Start-Sleep -Seconds 2
  $TaskState = schtasks.exe /Query /TN $Task /FO LIST /V
} while ($TaskState -match "Running")
$TaskState
& $Brain sources $Manifest --json
& $Brain schedule $Manifest --folder --remove
schtasks.exe /Query /TN $Task /FO LIST /V
Remove-Item -LiteralPath $TaskXml
```

Required evidence:

1. Install prints the effective five-field cron and the stable task name.
2. The XML readback shows the exact absolute `brain.cmd`, manifest, and watched-folder paths in the stored action; the expected trigger; the current-user principal; and `LeastPrivilege` run level. Backslash-quote text such as `\"` is a failure.
3. The run request succeeds. The polling query shows that the task stopped and its last-run result is `0`.
4. `brain sources` returns `contract_version: 3`; the watched-folder source's `receipt.last_successful_run_at` is later than the pre-run value recorded by the technician.
5. Remove prints that the refresh was removed. The final direct query reports that the task does not exist.

For a provider lane, substitute `--provider <provider>` for `--folder`, use the task name `com.brain-installer.$Slug.<provider>-ingest`, and verify that provider's source receipt advanced. Do not paste source content, credentials, manifest contents, or private paths into the proof record.
