# WIN-RENAME-RETRY

Working branch: `partner/win-rename-retry-1`. Baseline: `f8a7cd05`.
Changes are left in the working tree for the operator. No commit or push was attempted.

## Implementation

`operations/rename-retry.mjs:5` shares the error/attempt predicate;
`:12` implements synchronous rename and `:28` implements asynchronous rename.
Both allow ten attempts separated by 225 ms waits, at most 2,025 ms of backoff.
Only `EPERM`, `EACCES` and `EBUSY` qualify. The final error object is rethrown.
Synchronous callers use `Atomics.wait`; asynchronous callers await the delay.
The same bounded behavior applies on every platform, matching the reference design.

All 27 Windows-reachable staging writes now call the shared synchronous helper.
No original asynchronous filesystem rename exists in this package inventory.
The daily receipt callback is async, but its original filesystem operation was
synchronous and remains so. Only rename is retried. Existing staging bytes,
ACL/chmod/fsync operations, readback, rollback, cleanup, retained recovery files
and sanitized refusal messages remain at their original boundaries. Existing
injected rename functions remain honored, including the folder filesystem
method receiver. The `operations/` publication allowlist already includes the helper.

Other changes:

- `CHANGELOG.md:13`: owner-facing explanation of brief lock recovery and persistent refusal.
- `docs/ARCHITECTURE.md:1090`: retry budget and caller-owned persistence boundaries.
- `scripts/run-test-chain.mjs:16` and `:313`: all three new test files registered in both command arrays.
- `test/field-prepare.test.mjs:1008`: its copied-source fixture includes the new helper dependency.
- `test/rename-retry.test.mjs:12`: deterministic synchronous/asynchronous controls, error filtering, exhaustion, final-attempt success and ordering.
- `test/rename-retry-windows.test.mjs:20`: three real Windows held-handle writers; `:219` checks chmod failures; `:243` covers workspace staging.
- `test/rename-retry-writers.test.mjs:74`: actual answer manifest and journal writers; `:123` covers field receipt/checklist writers, `:158` the package-manifest CLI writer and `:208` the installation pointer.
- `test/fixtures/rename-retry-mutant.mjs:3`: process-local mutation loader.
- `test/fixtures/rename-retry-cli.mjs:14`: synthetic generation input boundary; `:38` observes the real CLI filesystem writer.

## Shipped staging-write inventory

Inspected the repository-owned files selected by `package.json`'s `files`
allowlist, including aliased rename calls and staged files passed through a
rename wrapper. Found **36 staging-file rename sites, 27 Windows reachable and
9 platform gated**. These counts agree with the supplied study. References
below are to this working tree. Each Yes row was converted; each No row remains unchanged.

| File:line | Windows | Purpose or platform reason |
| --- | --- | --- |
| `brain.mjs:5722` | Yes | Manifest version commit |
| `brain.mjs:14702` | Yes | Calendar checkpoint |
| `brain.mjs:23777` | Yes | Assistant configuration rollback |
| `brain.mjs:23947` | Yes | Assistant configuration commit |
| `connectors/google-auth.mjs:916` | Yes | Protected token-store commit |
| `connectors/google-auth.mjs:954` | Yes | Protected token-store rollback |
| `connectors/imessage.mjs:387` | No | Capture CLI requires macOS at `brain.mjs:15108` |
| `connectors/quickbooks-desktop-binding.mjs:91` | Yes | Desktop company binding |
| `connectors/whatsapp.mjs:441` | Yes | Drain checkpoint has explicit Windows ACL handling |
| `ingest/run.mjs:2136` | Yes | Shared ingest checkpoint |
| `operations/admin-key-file.mjs:869` | Yes | Protected admin-key commit |
| `operations/admin-key-file.mjs:902` | Yes | Protected admin-key rollback |
| `operations/answer-setup.mjs:226` | Yes | Manifest and answer-setup journal |
| `operations/bootstrap-status.mjs:452` | Yes | Bootstrap receipt |
| `operations/claude-skill.mjs:392` | Yes | Technician skill rollback |
| `operations/claude-skill.mjs:696` | Yes | Technician skill installation |
| `operations/claude-workspace.mjs:423` | Yes | Staged workspace guide becomes ready |
| `operations/curated-dual-sync.mjs:1226` | Yes | Coverage ledger |
| `operations/curated-sync-scheduler.mjs:182` | No | Freshness writer enters macOS-only planner at line 212 |
| `operations/curated-sync-scheduler.mjs:317` | No | Plist commit enters the same macOS-only planner |
| `operations/daily-refresh-run.mjs:484` | Yes | Daily receipt, using a synchronous filesystem rename |
| `operations/daily-refresh-scheduler.mjs:687` | Yes | Update transaction receipt |
| `operations/daily-refresh-scheduler.mjs:799` | Yes | Completed transaction history receipt |
| `operations/daily-refresh-scheduler.mjs:971` | No | macOS native adapter plist |
| `operations/disposable-recovery-field-seed.mjs:387` | No | Execution refuses Windows at line 976 before persistence |
| `operations/drive-scheduler.mjs:590` | No | Staged log snapshot at line 707 uses macOS scheduler plans |
| `operations/drive-scheduler.mjs:929` | No | macOS scheduler plist |
| `operations/folder-retirement.mjs:207` | Yes | Manifest commit |
| `operations/folder-retirement.mjs:232` | Yes | Manifest rollback |
| `operations/installed-manifest.mjs:332` | Yes | Saved installation pointer |
| `operations/provider-scheduler.mjs:218` | No | macOS provider plist rollback |
| `operations/quickbooks-schedule-state.mjs:64` | Yes | Local scheduler evidence |
| `operations/verified-recovery.mjs:1301` | Yes | Existing recovery-state replacement |
| `operations/whatsapp-daemon.mjs:226` | No | Daemon plist requires macOS planner |
| `scripts/field-prepare.mjs:628` | Yes | Receipt/checklist replacement |
| `scripts/verify-package-bundles.mjs:46` | Yes | Reviewed bundle-manifest generation |

Excluded from that count: existing-guide displacement at
`operations/claude-workspace.mjs:437`; directory moves at its lines 463/476
and `operations/windows-task-contract.mjs:300`; active log rotation at
`operations/daily-refresh-observation.mjs:145`; existing recovery-control
retirement at `operations/cloudflare-recovery-adapter.mjs:3647`.
`migration/state-file.mjs:163,168` is outside the allowlist: the singular
`migration/` directory is not the shipped `migrations/` directory.

## Red, green and mutation evidence

Every run below was preceded by `Get-Date`. Ad-hoc Node commands loaded
`--import file:///C:/offload/lanes-1023/no-network.mjs`; the focused fixtures
also used that guard except for the initial native and grouped existing-suite
runs. New Node CLI children propagate the guard. Native PowerShell holders use
an explicit environment allowlist and hidden windows.

The native holder opens the destination with `FileShare.Read`. Its 450 ms
release countdown starts only after a real native rename refusal. The
never-release arm stays open through all ten attempts. Each of the checkpoint,
manifest and bootstrap receipt writers has its own uncontended control,
delayed-release arm and terminal arm. Terminal arms prove prior bytes,
original-error identity and existing temporary cleanup. Two chmod tests prove
that successful rename does not cause chmod failures to be retried.

| Run / command suffix | Result | Evidence log under `%TEMP%` |
| --- | --- | --- |
| `--test test/rename-retry.test.mjs`, single-call stub, 11:27:05 | RED: 12 pass, 17 fail, exit 1; no-contention controls pass | `win-rename-helper-red.log` |
| Same helper suite after implementation, 11:27:24 | GREEN: 29/29, 75.501 ms | `win-rename-helper-green.log` |
| `--test test/rename-retry-windows.test.mjs`, original writers, 11:27:22 | RED: 3 controls pass, 6 contention arms fail, 2995.2643 ms | `win-rename-native-red.log` |
| Same native suite after conversion, 11:28:01 | GREEN: 9/9, zero skips, 9965.4541 ms | `win-rename-native-green.log` |
| Same native suite with chmod checks, 11:28:30 | GREEN: 11/11, zero skips, 10007.4295 ms | `win-rename-native-final.log` |
| Writers suite initial harness trial, 11:29:29 | 3 pass, 9 fail; CLI preload path needed a file URL; not accepted as red evidence | `win-rename-writers-red.log` |
| Writers suite with corrected preload and `no_retry`, 11:29:40 | RED: 4 controls pass, 8 fail, 345.6684 ms | `win-rename-writers-red-verified.log` |
| Writers suite before generation-fixture simplification, 11:29:44 | GREEN: 12/12, 10043.8456 ms | `win-rename-writers-green.log` |
| Final `--test test/rename-retry-writers.test.mjs` with `no_retry`, 11:31:11 | RED: 4 controls pass, 8 fail, 314.6274 ms | `win-rename-writers-red-final.log` |
| Final writers suite, 11:31:15 | GREEN: 12/12, 9961.0472 ms | `win-rename-writers-green-final.log` |
| Native file with `--test-name-pattern=workspace`, `no_retry`, 11:33:18 | RED: 1 control pass, 2 fail, 124.8009 ms | `win-rename-workspace-red.log` |
| Same workspace selection, 11:33:21 | GREEN: 3/3, 2494.9074 ms | `win-rename-workspace-green.log` |
| Writers file with `--test-name-pattern='installed manifest pointer'`, `no_retry`, 11:34:03 | RED: 1 control pass, 2 fail, 95.5897 ms | `win-rename-pointer-red.log` |
| Same pointer selection, 11:34:07 | GREEN: 3/3, 2463.8613 ms; real default durability handling | `win-rename-pointer-green.log` |
| All three final files together, 11:35:09: `--test test/rename-retry.test.mjs test/rename-retry-windows.test.mjs test/rename-retry-writers.test.mjs` | GREEN: 58/58, zero skips, 12367.4095 ms | `win-rename-final-focused.log` |

The final CLI fixture supplies synthetic generation input at the verifier
boundary and executes the real CLI parsing, staging, rename and refusal path.
Workspace staging tests model ownership through the existing dependency to
get past this sandbox's unrelated profile-metadata refusal, then inject rename
refusals to exercise retry. They do not establish native Windows ownership validation. File
identities, staged bytes, publication, retained copies and directory moves
remain real. Its terminal
case preserves the existing `not_written` result and retained recovery bytes.

Three named mutants were killed, each with the guard and `MUTATION_APPLIED`
marker. Command: set `BRAIN_RENAME_MUTANT` to the name, then run
`node --import file:///C:/offload/lanes-1023/no-network.mjs --import ./test/fixtures/rename-retry-mutant.mjs --test test/rename-retry.test.mjs`.
The environment selector was removed afterward; product files were not mutated.

| Mutant | Result at 11:27:34 | Killed by |
| --- | --- | --- |
| `no_retry` | Exit 1; 12 pass, 17 fail; 69.2083 ms | Recovery, exhaustion and tenth-attempt success checks |
| `retry_every_error` | Exit 1; 21 pass, 8 fail; 69.638 ms | Immediate refusal for ENOENT, ENOSPC, EIO and uncoded errors in both APIs |
| `unbounded_tries` | Exit 1; 23 pass, 6 fail; 73.2881 ms | All three eligible errors exhaust exactly ten attempts in both APIs |

Logs are `win-rename-mutant-<name>.log`. The same `no_retry` mutant also kills
the final writer, workspace and pointer regressions above. Every negative behavior has
a passing no-contention or successful persistence control.

The copied field-preparation fixture needed its new dependency. The first
manual fixture construction had a PowerShell path-joining error; its red and
green attempts both exited 1 and are not accepted evidence
(`win-rename-field-fixture-{red,green}.log`). Rebuilding the fixture correctly
at 11:31:13 produced `ERR_MODULE_NOT_FOUND` for the helper, exit 1, before the
fixture-copy fix; adding the helper made the same guarded `field-prepare.mjs
--help` exit 0. Logs: `win-rename-field-fixture-{red,green}-verified.log`.
This probe created no Git metadata.

## Focused regression runs

Each group below used `node --test` followed by the listed files. Guarded
reruns additionally used the mandatory `--import` above. No full test chain,
dependency installation, package installation or live account gate ran.

| Group | Files, all under `test/` | Result |
| --- | --- | --- |
| Storage, 11:28:22 | `ingest-run.test.mjs`, `calendar-ingest.test.mjs`, `admin-key-file.test.mjs`, `google-auth-storage.test.mjs`, `whatsapp-capture.test.mjs`, `quickbooks-desktop-connect.test.mjs`, `quickbooks-schedule-state.test.mjs` | Exit 1; 27 pass, 5 fail, 1 skip, 2892.7653 ms. Calendar 38 internal checks and ingest 97 internal checks pass; ingest has one host symlink skip. Initial failures were native ACL identity mismatch and absent HOME. |
| State, 11:28:47 | `folder-off.test.mjs`, `bootstrap-status.test.mjs`, `curated-dual-sync.test.mjs`, `verified-recovery.test.mjs` | Exit 1; 13 pass, 1 fail, 1 skip, 899.3311 ms. Only curated default-home lock acquisition fails. Bootstrap POSIX case and folder symlink case have explicit host skips. |
| Lifecycle, 11:29:02 | `daily-refresh-run.test.mjs`, `daily-refresh-scheduler.test.mjs`, `daily-refresh-update-production.test.mjs`, `owner-contract-workspace.test.mjs`, `technician-setup.test.mjs`, `assistant-repair.test.mjs`, `upgrade-verify.test.mjs`, `cli-path-persist.test.mjs` | Exit 1; 185 pass, 215 fail, 23 skip, 2742.8169 ms. Assistant repair and CLI path persistence pass. |
| Corrected storage environment, 11:29:39 | `admin-key-file.test.mjs`, `google-auth-storage.test.mjs`, `whatsapp-capture.test.mjs`, `quickbooks-desktop-connect.test.mjs`, `curated-dual-sync.test.mjs` | Exit 1; 27 pass, 1 fail, zero skips, 4819.2089 ms. Key file, all 73 Google-storage checks, all 55 capture checks and curated sync pass. Desktop write/read/remove succeeds, then its symlink fixture is denied. |
| Corrected lifecycle environment, 11:30:03 | `daily-refresh-run.test.mjs`, `daily-refresh-scheduler.test.mjs`, `daily-refresh-update-production.test.mjs`, `owner-contract-workspace.test.mjs`, `technician-setup.test.mjs`, `upgrade-verify.test.mjs` | Exit 1; 281 pass, 117 fail, 23 skip, 9005.1875 ms. All three daily modules pass. Remaining failures exactly match original HEAD below. |
| Runner registration, 11:30:34 | `test-chain-runner.test.mjs`, `test-chain-complete.test.mjs` | Exit 0; 2/2, 618.9351 ms; 454 tracked/new test files registered. Only the runner's tiny fixtures execute. |
| Tools, 11:31:25 | `field-prepare.test.mjs`, `anthropic-connect.test.mjs` | Exit 1; 57 pass, 1 fail, 435.6152 ms. Anthropic setup passes. Unchanged Wrangler runtime-cache fixture fails because isolated cache is absent. Three Git-mutating fixture cases were excluded by name. |
| Safe field subset, 11:33:58 | `field-prepare.test.mjs` | Exit 0; 23/23, 355.8527 ms. Excludes the same three Git-mutating fixtures and the unavailable runtime-cache fixture. Real receipt writes have separate new coverage. |

The exclusions used
`--test-skip-pattern='JSON plan argument failures|npm execution entrypoint refuses plan mode|CLI plan binds a clean checkout'`.
The final safe field subset appended `|long-lived Wrangler pins` to that pattern.
These cases were not silently counted as passes. The new helper dependency is
separately verified by the clean copied-source help probe described above.

Group logs are `win-rename-regression-{storage,state,lifecycle,isolated,lifecycle-isolated,tools}.log`,
`win-rename-chain.log` and `win-rename-field-safe.log` under `%TEMP%`.

Read-only SID comparison established that the inherited USERNAME named a
different identity from the process token. Initial native ACL tests protected
their synthetic files for that different identity. Scoped reruns set USERNAME
to the actual process identity without logging it, and used synthetic HOME,
USERPROFILE, APPDATA, LOCALAPPDATA, nested temporary directories and lock roots.
They also set `BRAIN_TEST_CHAIN=1` and `BRAIN_NO_WRANGLER_LOGIN=1`. No product
permission check or test assertion was weakened, and no old ACL residue was altered.

## Baseline comparison and limits

Read-only `git show HEAD:<path>` supplied exact original UTF-8 modules to a
temporary loader. This avoided checkouts, Git writes and a copied repository.
All **117 remaining lifecycle failure names match original HEAD exactly**:

| Original-HEAD focused file | Result | Final baseline duration |
| --- | --- | --- |
| `test/owner-contract-workspace.test.mjs` | 49 pass, 113 fail, 23 skip | 2353.623 ms |
| `test/technician-setup.test.mjs` | 33 pass, 3 fail | 355.0709 ms |
| `test/upgrade-verify.test.mjs` | File-level failure at unchanged Windows task inventory | 1899.5573 ms |

Final baseline runs started at 11:31:54, 11:31:57 and 11:31:57 MST and ended by
11:31:59. Preliminary baseline runs had identical counts and failure names;
they were repeated to remove native stdout decoding ambiguity. Preliminary
durations were 2523.023, 361.0485 and 2072.9936 ms, respectively.

At 11:32:33/34, both current and original HEAD also ran
`--test --test-reporter=spec --test-name-pattern='binding is owner-only'
test/quickbooks-desktop-connect.test.mjs`. Both exited 1 on the same denied
symlink after real binding write/read/remove passed, in 309.5566 and 258.7607 ms.
Logs, loader, source map and result metadata are located through
`%TEMP%/win-rename-baseline-root.txt`; preliminary results have `.initial` names.

The workspace suite's 49 passes do not prove staging publication. The new
workspace control/transient/terminal tests explicitly close that gap. Likewise,
direct pointer tests cover persistence beyond the unrelated upgrade-suite stop.
These host limitations remain visible; this report does not claim an entirely
green existing suite, CI, physical owner acceptance or any live deployment.

## Verification and handoff

Guard-loaded syntax checks passed for all 27 changed/new JavaScript modules
at 11:33:15; the subsequently extended writer test passed its own syntax check
at 11:34:13. The final combined run also loaded every new test successfully.
`git diff --check` passed. Independent read-only review confirmed all 27 intended
conversions, all nine platform exclusions, existing cleanup and permission
boundaries, injection seams and both test registries. Added files contain only
synthetic fixtures. No instance material or credentials were added to the package.

No network, real Brain, Cloudflare account, real provider credential, dependency
installation, Git metadata write, commit or push was used. Scratch fixtures and
logs are under `%TEMP%`, outside the working tree. All test processes were
finished by 11:35:28 MST on 2026-10-24, well before the 13:30 hard stop.
The operator must rerun focused checks in its authorized
host environment and make the commit on this lane branch.

## Prepared commit

Subject: Retry transient staged-file renames through one bounded helper

Body: Route all 27 Windows-reachable staging writes through shared synchronous
rename retry, preserving existing permission, readback, rollback and cleanup
behavior. Add asynchronous helper coverage, real Windows held-handle controls,
writer regressions and three killed mutants. Register focused tests, document
the 36-site inventory and retain exact baseline evidence for host limitations.

## Operator note

The Codex sandbox on this Windows machine makes `.git` read-only and runs under a different Windows identity, so the lane could not commit and several existing suites misbehaved there. The operator (Claude Code) verified outside the sandbox, as a normal non-elevated user, in a profile-shaped fence:

- The three new suites: `rename-retry` 29/29, `rename-retry-windows` 14/14 (native held-handle arms), `rename-retry-writers` 15/15.
- Mutants with the guard: `no_retry` 12 pass / 17 fail (and 6/8 on the native held-handle suite), `retry_every_error` 21/8, `unbounded_tries` 23/6. Each was applied and killed.
- Regression check: 23 existing suites covering the touched modules ran on this branch and on the original f8a7cd05, each in its own fresh fence. Pass, fail and skip counts and the failing test names are identical on both sides for all 23 files. The few failures on both sides are host limits already known on this PC: symlink rights, the long-path guide case, one field-prepare fixture and one upgrade-verify case.
- `git diff --check` clean. Names, banned-word, email, user-path and key scan: none.

The operator made the prepared commit unchanged and added the Codex co-author trailer. No code was edited by the operator.

LANE WIN-RENAME-RETRY: READY
