# WIN-RENAME-RETRY-2

Branch: `partner/win-rename-retry-2`. Starting commit: `f063ebc6`.
Read the round 1 report and its operator note before changing code. That note
records the outside-sandbox round 1 verification; this report covers round 2.
Changes remain in the working tree for the operator. No commit or push was attempted.
This is pending 0.4.20 work, with no release/version change or release claim.

## Changes

- `operations/rename-retry.mjs:33` and `:52`: both APIs require an injected
  `revalidate()`, executed before attempt one and every later attempt. The async
  API awaits the proof. Proof errors bypass the rename catch and wait entirely,
  retaining the exact error even when its code is retryable.
- `operations/rename-retry.mjs:5`: `platform = process.platform` restricts
  retries to `win32`. Windows retains ten attempts, nine 225 ms waits and the
  final native error. Other platforms make exactly one attempt without waiting.
- `operations/rename-retry.mjs:9` and `:19`: shared identity observations use
  `lstat`, distinguish absence from observation failure, and compare regular
  non-symlink files by device, inode, link count, size, modification time and mode.
- All 27 converted callers now supply proof, listed below. Staging identities
  come from the original write descriptor after writing, not from a pathname
  that could already have been replaced. Simple pathname writers now open an
  exclusive descriptor to establish that proof. Existing specialized readers,
  exact-byte checks, permission operations, readback, rollback and cleanup remain
  at their caller boundaries.
- `docs/ARCHITECTURE.md:1090`: documents Windows-only retry and per-attempt proof.
- `scripts/run-test-chain.mjs:19` and `:317`: registers the additional local
  configuration suite in both command arrays. The completeness test sees all
  455 tracked or new candidate test files.

The six previously unguarded simple writers had no identity-specific refusal
to preserve: calendar state, ingest state, answer JSON, daily receipt, field
artifacts and bundle generation. Calendar, ingest, answer JSON and daily receipt
now use plain sanitized errors without new error codes. Field artifacts and
bundle generation reuse `field_prepare_failed` and
`package_bundle_verification_failed`, respectively, because their CLI boundaries
turn error text into public codes. Callers with an existing identity refusal keep
that refusal. Admin-key and token-store observation failures also retain their
original error object through the outer rename wrapper.

## All 27 caller proofs

Every row checks the original staging inode. No site is exempt for lacking a
meaningful identity. In this table, "snapshot" means the shared device/inode and
metadata comparison described above. Existing specialized comparisons are named
where used. Destination proof is repeated immediately before each rename attempt.

| Site | Staging and destination proof | Existing refusal/result |
| --- | --- | --- |
| `brain.mjs:5722` | Descriptor snapshot; original manifest inode and exact pinned hash through `revalidateUpdateManifest` | Existing update-manifest revalidation errors |
| `brain.mjs:14713` | Descriptor snapshot; original calendar destination snapshot or absence | Plain calendar-state error; no previous identity refusal |
| `brain.mjs:23789` | Rollback descriptor snapshot; captured current configuration inode, exact bytes and unchanged non-target settings | Existing configuration-changed-before-rollback error, returning `false` |
| `brain.mjs:23962` | Descriptor snapshot; approved configuration inode/bytes or absence and original containing-directory identity | Existing configuration-changed-before-approved-write error |
| `connectors/google-auth.mjs:923` | Original protected staging descriptor, regular file and one link; original destination inode or absence | Existing token destination/staged-identity errors |
| `connectors/google-auth.mjs:958` | Original backup descriptor; destination still the published staging inode; both regular with one link | Existing transaction identity and unverified-rollback refusal |
| `connectors/quickbooks-desktop-binding.mjs:95` | Descriptor snapshot; destination stat returned by original `checked(path)` or absence | `QB_BINDING_INVALID` |
| `connectors/whatsapp.mjs:443` | Descriptor snapshot; original drain destination snapshot or absence | Existing drain-state identity error |
| `ingest/run.mjs:2142` | Descriptor snapshot; original checkpoint snapshot or absence | Plain ingest-state error; no previous identity refusal |
| `operations/admin-key-file.mjs:876` | Original protected staging descriptor, regular file and one link; original destination inode or absence | Existing admin-key destination/staged-identity errors |
| `operations/admin-key-file.mjs:905` | Original backup descriptor; destination still published staging inode; both regular with one link | Existing transaction identity and unverified-rollback refusal |
| `operations/answer-setup.mjs:235` | Descriptor snapshot; original manifest/journal snapshot or absence | Plain JSON-file error; no previous identity refusal |
| `operations/bootstrap-status.mjs:455` | Original descriptor via injected `fstat`; same predecessor used by initial safety validation, or absence, via injected `lstat` | Existing unsafe-regular-file error |
| `operations/claude-skill.mjs:390` | Rollback descriptor snapshot; original current skill snapshot and exact current bytes | Existing skill-changed-before-rollback error, returning `false` |
| `operations/claude-skill.mjs:701` | Descriptor snapshot; predecessor captured before skill inspection, or absence | Existing skill-destination-changed-after-preview error |
| `operations/claude-workspace.mjs:425` | Original descriptor, exact bytes and ownership proof; same lock and parent identities; ready destination remains absent | Existing `not_written`; identity refusal keeps its no-cleanup path |
| `operations/curated-dual-sync.mjs:1228` | Descriptor snapshot; original stat returned by ledger validation, or absence | Existing unsafe-ledger-destination error |
| `operations/daily-refresh-run.mjs:490` | Descriptor snapshot; original receipt snapshot or absence, including deferred writes without a lifecycle lock | Plain daily-receipt error; no previous identity refusal |
| `operations/daily-refresh-scheduler.mjs:693` | Descriptor snapshot; destination captured before reading prior transaction JSON, or absence | Existing unsafe-transaction-receipt error |
| `operations/daily-refresh-scheduler.mjs:815` | Descriptor snapshot; original archive snapshot or absence; active transaction file still matches its original snapshot | Existing unsafe-history error |
| `operations/folder-retirement.mjs:201` | Original descriptor, regular file and one link; original manifest inode bracketed around exact original-byte read | Existing `FOLDER_MANIFEST_CHANGED` |
| `operations/folder-retirement.mjs:243` | Original rollback descriptor; destination still the published staging inode; regular files and one link | Existing concurrent-edit error enters restore-failed/retained-backup path |
| `operations/installed-manifest.mjs:333` | Descriptor snapshot; original validated pointer stat or explicitly approved unsafe-repair stat, using existing `sameFile`; otherwise absence | Existing `INSTALLED_MANIFEST_POINTER_CHANGED` |
| `operations/quickbooks-schedule-state.mjs:66` | Descriptor snapshot; original `checked(path)` destination or absence | Existing `QB_SCHEDULE_STATE_INVALID` |
| `operations/verified-recovery.mjs:1295` | Descriptor after write/fsync/chmod; original predecessor through existing `sameFile`, including inode, link count, size, modification and change times | Existing recovery-control-destination-changed error |
| `scripts/field-prepare.mjs:632` | Descriptor snapshot; original private artifact snapshot or absence | Existing `field_prepare_failed` boundary |
| `scripts/verify-package-bundles.mjs:49` | Descriptor snapshot; predecessor captured before the no-replace decision, or absence | Existing `package_bundle_verification_failed` boundary |

## Test changes and reproduction

- `test/rename-retry.test.mjs:149`: paired Windows/macOS/Linux EPERM cases;
  `:171`: first-attempt refusal with zero renames/waits; `:184`: destination and
  staging replacement during backoff, paired with unchanged-file controls.
  Both sync and async helpers preserve the exact proof error. Async ordering
  also proves validation finishes before rename begins.
- `test/rename-retry-windows.test.mjs:96`, `:137`, `:247`: ten protected
  commit/rollback/daily/recovery sites, each with an unchanged passing control
  and both destination and staging replacement. Synthetic credential protection
  is injected and in memory. No actual credential or provider is used.
- `test/rename-retry-writers.test.mjs:118`: nine general writers, each with the
  same three cases; `:382`: bundle CLI replacement cases, paired with its existing
  passing CLI control. `test/fixtures/rename-retry-cli.mjs:47` injects the CLI race.
  Existing writer tests now expect one native call off Windows; Windows-only
  between-retry cases have explicit platform gating.
- `test/rename-retry-config.test.mjs:102`: all seven configuration/skill/workspace
  sites, each with the same three cases. Process-local loader exports expose
  existing private writers without expanding the production CLI API. These tests
  use same-byte replacement files and keep displaced inodes alive, proving inode
  checks rather than relying on changed payloads or recycled file identities.
- `test/fixtures/rename-retry-mutant.mjs:3`: retains the three round 1 mutants
  and adds skipped retry revalidation and removal of the platform gate.

Every test command below was preceded by `Get-Date` and used
`node --import file:///C:/offload/lanes-1023/no-network.mjs` before the suffix
shown. Times are MST on 2026-10-24. Logs and baseline loaders are under `%TEMP%`.
Original-source red loaders use read-only `git show HEAD:<path>` and process-local
module substitution. They do not alter product files or Git metadata and do not
create a copied repository. Where current imports need the new utility exports,
the loader appends only those utilities to the original helper; the original
rename algorithm and original caller bodies remain unchanged.

Command aliases used below:

| Alias | Suffix |
| --- | --- |
| H | `--test test/rename-retry.test.mjs` |
| W | `--test test/rename-retry-windows.test.mjs` |
| G | `--test test/rename-retry-writers.test.mjs` |
| C | `--test test/rename-retry-config.test.mjs` |

For pattern rows, insert `--test-name-pattern='<pattern>'` after `--test`.
For baseline/mutant rows, the specified `--import` precedes `--test`.
Counts are pass/fail unless skips are stated. Exit was 1 for every red, mutant
or harness-failure row and 0 for every green row.

### Helper red, green and five named mutants

| Time | Command | Result | Log filename |
| --- | --- | --- | --- |
| 12:21:18 | H | RED 28/17: proof/platform regressions | `win-rename-r2-helper-red.log` |
| 12:21:39 | H | RED 28/19, including identity utilities | `win-rename-r2-helper-identity-red.log` |
| 12:21:51 | H | GREEN 47/0 | `win-rename-r2-helper-green.log` |
| 12:21:56 | H + mutant `no_retry` | KILLED 20/27 | `win-rename-r2-mutant-no_retry.log` |
| 12:21:57 | H + mutant `retry_every_error` | KILLED 39/8 | `win-rename-r2-mutant-retry_every_error.log` |
| 12:21:57 | H + mutant `unbounded_tries` | KILLED 41/6 | `win-rename-r2-mutant-unbounded_tries.log` |
| 12:21:57 | H + mutant `skip_retry_revalidation` | KILLED 36/11 | `win-rename-r2-mutant-skip_retry_revalidation.log` |
| 12:21:57 | H + mutant `remove_platform_gate` | KILLED 43/4 | `win-rename-r2-mutant-remove_platform_gate.log` |

Mutation commands set `BRAIN_RENAME_MUTANT` to the named value and add
`--import ./test/fixtures/rename-retry-mutant.mjs`. Every run printed
`MUTATION_APPLIED`; selectors were removed afterward. No product bytes were
mutated. `no_retry` is killed by successful recovery and exhaustion controls;
`retry_every_error` by immediate refusals for unrelated errors;
`unbounded_tries` by exactly-ten-attempt exhaustion; `skip_retry_revalidation`
by replacement during backoff; and `remove_platform_gate` by the macOS/Linux
single-call, no-wait cases in both APIs.

### Protected writers: all runs

The baseline import in this table is
`%TEMP%/win-rename-round2-protected-baseline.mjs`.

| Time | W pattern / other command | Result | Log filename |
| --- | --- | --- | --- |
| 12:21:36 | `identity:.*between attempts` | Harness trial 1/8; synthetic protection controls invalid, not accepted as overall red | `win-rename-round2-protected-red.log` |
| 12:21:59 | Same pattern | GREEN 9/0 after fixture correction | `win-rename-round2-protected-red-corrected.log` |
| 12:22:20 | Same pattern + baseline import | Verified RED 3 controls/6 race failures | `win-rename-round2-protected-baseline-red.log` |
| 12:22:59 | `daily.*identity:.*between attempts` + baseline | Harness failure 0/1: missing utility exports, not accepted red | `win-rename-round2-daily-red.log` |
| 12:23:06 | Same pattern + corrected baseline | 2/7; receipt observation hit sandbox ACL/cleanup, not accepted as complete daily red | `win-rename-round2-daily-red-corrected.log` |
| 12:23:29 | Same pattern + baseline; injected observation boundary | Verified RED 3 controls/6 race failures | `win-rename-round2-daily-red-final.log` |
| 12:23:36 | `identity:.*between attempts` | GREEN 18/0 | `win-rename-round2-protected-daily-green.log` |
| 12:24:15 | `identity rollback:\|recovery state identity:` + baseline | 3/9; recovery manifest fixture incomplete, not accepted as complete red | `win-rename-round2-rollback-recovery-red.log` |
| 12:24:27 | Same pattern + baseline, corrected fixture | Verified RED 4 controls/8 race failures | `win-rename-round2-rollback-recovery-red-final.log` |
| 12:24:32 | `identity(:\| rollback:)` | GREEN 30/0 | `win-rename-round2-protected-final-green.log` |
| 12:25:02 | Same pattern + `skip_retry_revalidation` mutant | KILLED 10 controls/20 race failures | `win-rename-round2-protected-mutant.log` |
| 12:25:23 | `--test test/folder-off.test.mjs test/verified-recovery.test.mjs` | GREEN 2/0 file tests | `win-rename-round2-protected-regression.log` |
| 12:25:48 | W, `identity(:\| rollback:)` | GREEN 30/0, 7460 ms | `win-rename-round2-protected-final-green-2.log` |

The early fake-protection fixture incorrectly retained a Buffer that production
correctly clears. The corrected fixture copies its input. The daily receipt
fixture now injects `appendObservation` so unrelated native ACL work cannot hide
the rename being tested. Initial temporary ACL residue was left untouched outside
the repository. These harness failures are disclosed and are not counted as
valid red evidence. Exact original-source replay supplies the valid paired reds.

### General writers: all runs

Baseline imports below are
`%TEMP%/win-rename-r2-general/baseline-loader.mjs` (original helper) and
`%TEMP%/win-rename-r2-general/baseline-callers-loader.mjs` (original ten callers
and helper).

| Time | G pattern / other command | Result | Log filename |
| --- | --- | --- | --- |
| 12:21:52 | `retry identity` | Harness trial 0/27 during required-callback API change; not accepted red | `win-rename-r2-general-red.log` |
| 12:22:02 | Same pattern + helper baseline | Verified RED 9 controls/18 race failures | `win-rename-r2-general-red-verified.log` |
| 12:22:23 | `bundle manifest CLI.*(?:control|retry identity)` + helper baseline | Verified RED 1 control/2 race failures | `win-rename-r2-bundle-red.log` |
| 12:22:58 | `retry identity` | GREEN 29/0 | `win-rename-r2-general-green.log` |
| 12:23:22 | G, no pattern | GREEN 44/0 | `win-rename-r2-writers-first-full.log` |
| 12:23:53 | `retry identity\|writer: control` | GREEN 33/0 | `win-rename-r2-general-green-final.log` |
| 12:24:26 | Same pattern + callers baseline | Final verified RED 13 controls/20 race failures | `win-rename-r2-general-red-final.log` |
| 12:24:43 | `--test test/rename-retry-writers.test.mjs test/bootstrap-status.test.mjs test/quickbooks-schedule-state.test.mjs` | GREEN 58/0, 2 explicit POSIX-only skips; 19392.659 ms | `win-rename-r2-general-final.log` |
| 12:25:20 | G, `retry identity\|writer: control` + `skip_retry_revalidation` mutant | KILLED 13 controls/20 race failures | `win-rename-r2-general-mutant.log` |

### Configuration writers and final verification: all runs

The configuration baseline import is
`%TEMP%/win-rename-r2-config-baseline-loader.mjs`, loading the original helper.

| Time | Command | Result | Log filename |
| --- | --- | --- | --- |
| 12:21:57 | C | Harness trial 0/21 during required-callback API change; not accepted red | `win-rename-r2-config-red.log` |
| 12:22:21 | C + baseline import, before caller edits | Verified RED 7 controls/14 race failures | `win-rename-r2-config-red-verified.log` |
| 12:22:58 | C | 20/1: manifest refused correctly, but invalid-JSON substitute expected the wrong existing refusal variant | `win-rename-r2-config-green.log` |
| 12:23:11 | C, same-byte replacement fixture | GREEN 21/0 | `win-rename-r2-config-green-final.log` |
| 12:23:44 | `--test test/calendar-ingest.test.mjs test/assistant-repair.test.mjs` | GREEN 2/0 file tests; calendar reports all 38 internal checks passing | `win-rename-r2-config-regression.log` |
| 12:24:35 | C + `skip_retry_revalidation` mutant | KILLED 7 controls/14 race failures | `win-rename-r2-config-mutant.log` |
| 12:26:26 | Final six-file command below | GREEN 158/0, zero skips; 19558.1518 ms | `win-rename-r2-final-focused.log` |

The final command, including all three requested rename suites and both requested
test-chain checks, was:

```powershell
node --import file:///C:/offload/lanes-1023/no-network.mjs --test test/rename-retry.test.mjs test/rename-retry-windows.test.mjs test/rename-retry-writers.test.mjs test/rename-retry-config.test.mjs test/test-chain-runner.test.mjs test/test-chain-complete.test.mjs
```

Final suite totals: helper 47, Windows 44, writers 44, configuration 21, and two
test-chain files. The native Windows held-handle controls, delayed release and
terminal refusal cases all ran without skips. The test-chain runner executes
its tiny synthetic fixtures; it does not execute the full product test chain.
Every new negative behavior has an unchanged passing control. The actual-caller
mutation runs independently kill skipped retry validation across all 27 sites.

At 12:25:45, guard-loaded `node --check` passed for all 27 changed/new JavaScript
modules; log: `%TEMP%/win-rename-r2-syntax.log`. Final suites load the completed
modules as well. `git diff --check` passed. Independent read-only review checked
all 27 proofs, original descriptor provenance, refusal preservation, rollback
boundaries, platform behavior and test portability.

## Limits and handoff

These checks prove the offline local persistence contract, including native
Windows sharing refusals. They do not prove a live deployment or real account
behavior. Credential-protection and workspace ownership boundaries are injected
in the synthetic race tests, as documented in their source. Existing terminal
cleanup remains caller-owned; this change prevents publication after observed
identity drift and does not claim an operating-system compare-and-swap primitive.

No real Brain, account, real credential, provider request, dependency install,
full test chain, network access, repository scratch tree or Git metadata write
was used. Only focused suites and syntax checks ran. All test processes finished
by 12:26:46 MST, before the 13:25 hard stop. The operator can rerun the focused
checks in its authorized environment and make the commit from this working tree.

## Prepared commit

Subject: Revalidate staged renames and limit retries to Windows

Body: Require caller identity proof before every rename attempt at all 27
converted sites. Preserve existing refusal and rollback paths, keep retries
Windows-only, and document the contract. Add paired replacement-race tests,
platform controls and two new killed mutants while retaining the three original
mutants. Record focused verification and the complete caller proof inventory.

LANE WIN-RENAME-RETRY-2: READY
