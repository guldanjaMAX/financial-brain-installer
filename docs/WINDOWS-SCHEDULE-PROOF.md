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
& $Brain schedule $Manifest --folder --status
& $Brain schedule $Manifest --folder --install
schtasks.exe /Query /TN $Task /XML > $TaskXml
[xml]$StoredTask = Get-Content -LiteralPath $TaskXml -Raw
$StoredTask.Task.Principals.Principal | Format-List UserId,LogonType,RunLevel
$StoredTask.Task.Triggers | Format-List
$StoredTask.Task.Actions.Exec | Format-List Command,Arguments
$StoredTask.Task.Settings | Format-List MultipleInstancesPolicy,DisallowStartIfOnBatteries,StopIfGoingOnBatteries,StartWhenAvailable
schtasks.exe /Run /TN $Task
do {
  Start-Sleep -Seconds 2
  $TaskState = schtasks.exe /Query /TN $Task /FO LIST /V
} while ($TaskState -match "Running")
$TaskState
& $Brain schedule $Manifest --folder --status
& $Brain sources $Manifest --json
& $Brain schedule $Manifest --folder --remove
& $Brain schedule $Manifest --folder --remove
schtasks.exe /Query /TN $Task /FO LIST /V
Remove-Item -LiteralPath $TaskXml
```

Required evidence:

1. Install prints the effective five-field cron and the stable task name.
2. The XML readback shows `Command` as `%SystemRoot%\System32\conhost.exe` and `Arguments` starting with `--headless`, then the absolute `node.exe`, installed `brain.mjs`, manifest, and watched-folder paths and a `--config-hash`; the expected trigger; the current-user principal with `InteractiveToken` logon and `LeastPrivilege` run level; and `IgnoreNew`, `false`, `false`, `true` for the four settings. No console window opens during the run, and the lane log under `%LOCALAPPDATA%\FinancialBrain\logs` gains the run's output. Repeat once with the watched folder set to a drive root such as `D:\` and confirm the run succeeds.
   Repeat the install on battery power with the lid closed across a trigger time, and confirm the missed run starts after wake.
3. The run request succeeds. The polling query shows that the task stopped and its last-run result is `0`.
4. `brain sources` returns `contract_version: 3`; the watched-folder source's `receipt.last_successful_run_at` is later than the pre-run value recorded by the technician.
5. Remove prints that the refresh was removed. The second remove prints that it was not installed and that the freshness expectation was cleared. The final direct query reports that the task does not exist.
6. The status before install prints that the refresh is not installed and names the lane log path. The status after the run prints the last run time, `last result: 0 (success)`, and the same log path, and the log ends with the run's output.
7. Repeat steps 5 and 6 on a PC whose display language is not English, and on a PC that holds one deliberately corrupted unrelated task (for example a copy of a disposable task whose XML under `%SystemRoot%\System32\Tasks` was edited by an administrator). Both status before install and remove of the already-absent task must still succeed; `schtasks /Query /FO CSV` on that PC fails, which is the condition being proven.
8. Run `& $Brain windows-scheduled-ingest $Manifest --path <watched folder> --source <source>` without `--config-hash`. It must refuse before reading any credential, and the lane log must gain exactly one `scheduled ingest failed:` line that names the missing `--config-hash`.

For a provider lane, substitute `--provider <provider>` for `--folder`, use the task name `com.brain-installer.$Slug.<provider>-ingest`, and verify that provider's source receipt advanced. Do not paste source content, credentials, manifest contents, or private paths into the proof record.
