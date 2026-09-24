# Windows Task Scheduler proof

This is a physical-machine field gate, not an offline or CI check. The technician runs it from an ordinary, non-administrator PowerShell window on a Windows PC after installing the exact reviewed package.

The example proves the watched-folder lane. It installs one current-user task, reads back its full Task Scheduler definition, triggers it, verifies the Brain's source receipt advanced, and removes it. Do not continue if the install says that nothing was scheduled.

```powershell
$Brain = "$env:LOCALAPPDATA\FinancialBrain\brain.cmd"
$Manifest = (Resolve-Path "$HOME\Financial Brain\brain.manifest.json").Path
$Slug = (Get-Content -Raw $Manifest | ConvertFrom-Json).client.slug
$Task = "com.brain-installer.$Slug.folder-ingest"

& $Brain sources $Manifest --json
& $Brain schedule $Manifest --folder --install
schtasks /Query /TN $Task /FO LIST /V
schtasks /Run /TN $Task
schtasks /Query /TN $Task /FO LIST /V
& $Brain sources $Manifest --json
& $Brain schedule $Manifest --folder --remove
schtasks /Query /TN $Task /FO LIST /V
```

Required evidence:

1. Install prints the effective five-field cron and the stable task name.
2. The first query shows the exact absolute `brain.cmd` and manifest paths, the expected schedule, and a current-user task with no elevated run level.
3. The run request succeeds. Wait for the second query to show that the task is no longer running and inspect its last-run result.
4. `brain sources` returns `contract_version: 3`; the watched-folder source's `receipt.last_successful_run_at` is later than the pre-run value recorded by the technician.
5. Remove prints that the refresh was removed. The final direct query reports that the task does not exist.

For a provider lane, substitute `--provider <provider>` for `--folder`, use the task name `com.brain-installer.$Slug.<provider>-ingest`, and verify that provider's source receipt advanced. Do not paste source content, credentials, manifest contents, or private paths into the proof record.
