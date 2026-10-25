# WIN-RENAME-RETRY-3

Starting branch: `partner/win-rename-retry-3`, commit `ebec973f`.
The round 2 report and its operator section were read first. The operator's
duplicate-check removal is preserved. This is held 0.4.20 work, with no version,
release, live-account, or deployment claim. Changes are left in the working tree
for the operator; no Git metadata write, commit, push, installation, or network
operation was attempted. The round 2 report is unchanged.

## Result and contract

Both replay blockers are fixed at all 27 sites. Every attempt uses the shared
bounded byte proof. Cleanup preserves another writer's replacement, and the
listed caller rollbacks require a record of an actual publication plus current
identity and bytes. All 27 writers hold the exact intended bytes in memory;
each proof is bounded by that sequence's length. There is no stream exception.

- `operations/rename-retry.mjs:10`: number and bigint identity key lists include
  change time. Mixed stat kinds are refused. All new staging baselines and
  ownership-removal identities use bigint dev/ino. Some existing specialized
  destination and readback guards retain number Stats for compatibility.
- `operations/rename-retry.mjs:58`: the proof checks regular, non-link, one-link
  type and exact length, opens read-only with no-follow where available, checks
  descriptor identity, reads at most the intended length plus one EOF byte,
  compares bytes, checks the descriptor again, closes, and checks the pathname
  again. It never uses `readFileSync`. Buffers are cleared. Observation, close,
  and injected-filesystem initialization errors return false.
- `operations/rename-retry.mjs:96`: baseline capture follows writes, protection,
  chmod, fsync where present, and close. It requires the inode from the fstat
  immediately after exclusive create. Windows ctime alone is explicitly not a
  byte binding: a same-user handle can set or suppress timestamps.
- `operations/rename-retry.mjs:110`: shared removal checks regular/non-link/one
  link and original dev/ino, then confirms absence. Errors do not replace the
  caller's primary error. An explicitly null rollback proof refuses; omitting
  proof is reserved for unpublished owned staging. Published destination
  removal additionally supplies its authorized exact proof and bytes.
- Both retry APIs perform the synchronous byte proof after caller revalidation,
  immediately before invoking rename. The async API has no await in that gap.
  Windows-only retry bounds and original refusal behavior remain intact.
- `docs/ARCHITECTURE.md:1104` documents byte proof, publication authority and the
  remaining check-to-unlink race. No native process was added to any proof.

## All 27 sites

Every row captures the create identity immediately after successful exclusive
open. "Owned cleanup" below means shared removal only with that identity and
while unpublished; EEXIST supplies no identity and cannot authorize cleanup.
Post-forward-rename proofs are used for rollback destinations because rename
can change ctime. Existing terminal retention policies are preserved.

| Site | Intended bytes and baseline position | Cleanup / rollback change |
| --- | --- | --- |
| `brain.mjs:5725` manifest version | Existing `output`; after fsync and close | Finally uses owned cleanup; success/readback failures cannot delete a new staging occupant; cleanup cannot mask refusal. |
| `brain.mjs:14722` calendar | Hoisted JSON Buffer; after close | Owned cleanup replaces the ineffective path-only cleanup; post-publish chmod cannot authorize removal. |
| `brain.mjs:23800` config restore | `snapshot.bytes`; after fchmod, fsync and close | Owned staging cleanup; destination uses current bigint identity and exact bytes, with bundle publication authority. |
| `brain.mjs:23973` config commit | Existing `bytes`; after fchmod, fsync and close | Owned cleanup; post-rename proof recorded before later readback/scope failure. |
| `connectors/google-auth.mjs:934` token commit | Existing protected `encoded`; after protection, write, fsync and close | Shared owned temporary/backup removal; post-rename proof for rollback; no per-attempt DPAPI or ACL process. |
| `connectors/google-auth.mjs:972` token rollback | Protected `backupBytes`; after backup protection/write/fsync/close | Backup publication flag; replacement destination must match post-forward proof; refused backup replacement survives. |
| `connectors/quickbooks-desktop-binding.mjs:103` binding | Hoisted JSON Buffer; after close and protection | Owned finally cleanup, including EEXIST and success-path squats; primary error preserved. |
| `connectors/whatsapp.mjs:447` drain | Existing bytes; after protection, write, fsync and close | Owned cleanup before publish only. |
| `ingest/run.mjs:2146` ingest checkpoint | Hoisted JSON Buffer; after close | Owned cleanup, including EEXIST and post-publish chmod failures. |
| `operations/admin-key-file.mjs:887` admin key commit | Existing protected `bytes`; after protection/write/fsync/close | Shared temporary/backup removal; post-rename proof for rollback; no extra protection launch. |
| `operations/admin-key-file.mjs:919` admin key rollback | Protected `backupBytes`; after backup protection/write/fsync/close | Backup publication flag and post-forward destination proof; absence rollback also requires exact bytes. |
| `operations/answer-setup.mjs:242` JSON writer | Hoisted JSON Buffer; after close | Retains staging on failure as before; publication receipt governs manifest rollback and journal removal. |
| `operations/bootstrap-status.mjs:469` bootstrap | UTF-8 payload Buffer; after fsync and close through injected fs | Owned cleanup through the same injected fs, including EEXIST and post-publish failure. |
| `operations/claude-skill.mjs:395` skill restore | `snapshot.bytes`; after fchmod, fsync and close | Owned staging cleanup; restoration/deletion requires the repair's publication receipt. |
| `operations/claude-skill.mjs:710` skill commit | Hoisted UTF-8 Buffer; after fchmod, fsync and close | Owned cleanup; publication callback follows exact post-rename proof, before later failure. |
| `operations/claude-workspace.mjs:429` workspace pending | Hoisted UTF-8 Buffer; shared proof and ownership snapshot after close | Existing no-cleanup refusal/retention remains; one existing ownership process per attempt; operator pre-check removal retained. |
| `operations/curated-dual-sync.mjs:1231` coverage ledger | Existing canonical Buffer; after fsync and close | Owned cleanup; readback failure after publish cannot delete a new occupant. |
| `operations/daily-refresh-run.mjs:493` daily receipt | Hoisted JSON Buffer; after close | Existing staging retention remains; create-fstat failure closes its descriptor. |
| `operations/daily-refresh-scheduler.mjs:714` transaction | Hoisted JSON Buffer; after close | Owned finally cleanup and post-rename publication proof; exact expected predecessor propagated by callers. |
| `operations/daily-refresh-scheduler.mjs:856` history | Hoisted JSON Buffer; after close | Owned finally cleanup; live receipt is re-proved before archive and before owned removal. |
| `operations/folder-retirement.mjs:215` manifest forward | Existing `intendedBytes`; after private write metadata/fsync/close | Owned temp and backup removal; return object privately carries post-rename publication authority. |
| `operations/folder-retirement.mjs:251` manifest rollback | Existing `originalBytes`; after rollback metadata/fsync/close | Owned rollback cleanup; destination bound to post-forward identity and bytes; retained backup on unsafe restoration. |
| `operations/installed-manifest.mjs:335` pointer | Hoisted canonical Buffer; after chmod, fsync and close | Owned cleanup before publication only. |
| `operations/quickbooks-schedule-state.mjs:74` schedule evidence | Hoisted JSON Buffer; after close and protection | Owned finally cleanup, including EEXIST and success squats. |
| `operations/verified-recovery.mjs:1298` recovery control | Existing intended bytes; after write/fsync/chmod/close | Shared proof replaces its separate staging identity path; owned cleanup on refusal. The existing first-create link branch separately checks original bigint inode and two links before removing its private link. |
| `scripts/field-prepare.mjs:635` field artifact | Buffer of existing rendered bytes; after close | Existing recoverable staging retention remains. |
| `scripts/verify-package-bundles.mjs:52` bundle manifest | Hoisted JSON Buffer; after close | Existing recoverable staging retention remains. |

## Caller rollback authority

`brain.mjs:8326` refuses assistant-bundle rollback without the exact publication
record created at `brain.mjs:23986`. A never-attempted or refused write cannot
adopt another process's content-equal registration. `brain.mjs:23749` repeats
the exact current proof before restoration or removal. Tests exercise prior
absence and prior contents, refused publication, unattempted publication, and
a same-byte replacement after successful publication, with successful rollback
controls.

`operations/claude-skill.mjs:346` keeps repair publication receipts in a WeakMap.
The installer records publication through the callback at `:585`, including a
write that succeeded before a later injected failure. Missing receipts cannot
authorize removal or overwrite. The repair restores completed owned writes and
preserves content-equal replacements or files installed by another attempt.

`operations/answer-setup.mjs:245` creates an exact publication receipt without
changing the public manifest return value. The run tracks journal/manifest
publication at `:359` and `:471`; refusal before manifest publication does not
roll the manifest back (`:568`). Rollback checks the receipt and repeats proof
inside the atomic writer (`:583`). Default journal removal at `:364` checks
identity and bytes on all completion and failure paths. The in-memory fixtures
in `test/anthropic-connect.test.mjs:9` now explicitly model publication receipts;
there is no production missing-receipt fallback.

`operations/folder-retirement.mjs:114` privately associates its returned result
with a publication proof. `brain.mjs:27602` keeps that result for daily-intent
rollback at `:27663`. `operations/quickbooks-schedule.mjs:318`, `:374` and `:415`
carry exact publication tokens through connect, nested daily preference and
schedule-intent rollback. They propagate a later owned restoration's token and
preserve nested concurrent-edit refusal. No private bytes or bigint identifiers
are added to public receipts.

`operations/daily-refresh-scheduler.mjs:600` keeps receipt proof privately.
Read/write/clear accept exact expected receipt objects, refuse replacement,
and remove only a freshly proved receipt. `brain.mjs:31084` keeps the last
successful receipt; `:31182` uses it as the expected predecessor and advances
it only after successful return. Recovery reads and clear paths at `:31215`,
`:31334`, `:31362`, `:31371` and `:31389` cannot recapture another writer's receipt
after a refusal. History staging and active receipt removal both use exact proof.

## Test design, red evidence and inventory differences

The four existing suites were extended, without creating another suite or
changing the test chain. `test/fixtures/rename-retry-staging.mjs` pins a recent
whole even second on exclusive-create descriptors and their later writable
reopens, never on proof read descriptors. Same-inode rewriting uses `r+`, flips
every byte, restores mtime, and requires exact equality of all six round 2
metadata fields with bigint stats. A failed precondition is thrown outside
product refusal wrappers, never accepted as a passing negative. Every existing
staging-replacement mode now asserts surviving bigint inode and exact bytes.
Configuration/general loops inject Windows retry scope on POSIX instead of
silently skipping. Protection fixtures actually change ctime.

On exact `ebec973f`, 25 of 27 in-place rows fail. Workspace's existing byte
comparison and recovery's existing ctime check are the two passing controls.
The new survival assertions expose 17 deletions. Calendar survival is also an
existing control: its old `rmSync` reference has no import/binding, so its caught
ReferenceError prevented deletion. This disagrees with the inventory's calendar
deletion prediction, rather than indicating a sandbox permission result.
The other existing survival controls retain staging or already check inode.

Additional paired coverage includes EEXIST, success-path squats, ledger readback
failure after publication, all requested rollback chains, backup/live receipt
replacement, short read/EOF growth, pathname and descriptor bracket races,
close failure, missing proof, injected-fs initialization failure, mixed bigint
stats, and synchronous proof-to-rename ordering in the async API. Create-fstat
failures also prove the opened descriptor closes. No speculative payload caps,
filename policy changes or extra fsync operations were introduced; reads are
bounded by the already computed intended bytes plus one byte. Daily transaction
and history writes now enforce their existing reader's 1 MiB contract before
publication.

The inventory's proposed proof-first workspace ordering was not used: caller
ownership/lock checks run first, then the shared byte proof is the last action
before rename as required. It adds Node fs work only, with no duplicate native
ownership check. Existing desktop-binding reads still protect the destination;
a concurrent read may change ctime and cause a fail-closed refusal. That check
was not weakened.

## Reproduction and execution record

All times below are MST on 2026-10-24. Every run was preceded by `Get-Date` and
used the prefix `node --import file:///C:/offload/lanes-1023/no-network.mjs`.
Counts are pass/fail/skip, including explicit skips. A Node run with failures
exited 1; clean runs exited 0. A surrounding PowerShell log-display command's
exit code is not the Node result. All logs and source replay maps are in
`%TEMP%`. No test chain, dependency installation or live gate ran.

Aliases are exact suffixes after the guard:

| Alias | Suffix |
| --- | --- |
| H | `--test test/rename-retry.test.mjs` |
| W | `--test test/rename-retry-windows.test.mjs` |
| G | `--test test/rename-retry-writers.test.mjs` |
| C | `--test test/rename-retry-config.test.mjs` |
| B | Add `--import` with the file URL of `%TEMP%/win-r3-baseline-loader.mjs` before `--test`. |
| M | Set `BRAIN_RENAME_MUTANT`, add `--import ./test/fixtures/rename-retry-mutant.mjs` before `--test`, then remove the selector. |

Pattern entries insert `--test-name-pattern='<pattern>'` after `--test`.
The baseline loader uses read-only `git show ebec973f:<path>` source for all
20 helper/caller modules. It substitutes modules in the test process only;
there is no repository copy or Git mutation. Extra maps for individual replay
runs are identified below. Hook exports expose private writers only to tests.

### Helper and root configuration runs

| Time | Command | Pass/fail/skip | Log under `%TEMP%` |
| --- | --- | --- | --- |
| 19:04:01 | H, before helper edit | 48/3/0 RED: ctime and both in-place API rows | `win-rename-r3-helper-red.log` |
| 19:04:29 | C, raw Windows path passed to `--import` | 0/1/0 harness error, unsupported ESM scheme | `win-r3-config-red.log` |
| 19:04:47 | B + C | 17/11/0 RED: six in-place and five cleanup failures | `win-r3-config-red-2.log` |
| 19:04:48 | H, extended API tests before implementation | 48/8/0 RED, including five absent-new-API cases | `win-rename-r3-helper-red-extended.log` |
| 19:05:04 | H | 56/0/0 | `win-rename-r3-helper-green.log` |
| 19:05:35 | B + C, `bundle rollback ownership` | 3/8/0 RED, three rollback controls pass | `win-r3-config-bundle-red.log` |
| 19:05:49 | H | 59/0/1 | `win-rename-r3-helper-green-edges.log` |
| 19:06:26 | C | 39/0/0 | `win-r3-config-green-1.log` |
| 19:07:17 | B + C, `daily intent caller` | 1/1/0 RED | `win-r3-daily-intent-red.log` |
| 19:08:53 | B + C, all added cleanup/control rows | 29/24/0 RED | `win-rename-r3-config-full-red-edges.log` |
| 19:09:09 | C | 53/0/0 | `win-rename-r3-config-full-green-edges.log` |
| 19:09:46 | H, `explicitly refused rollback proof` before fix | 0/1/0 RED; same test first passes omitted-proof own-inode control | `win-rename-r3-null-proof-red.log` |
| 19:09:48 | H | 60/0/1 | `win-rename-r3-helper-green-null-proof.log` |
| 19:11:42 | H, `injected filesystem initialization failure` before fix | 0/1/0 RED | `win-rename-r3-proof-io-red.log` |
| 19:11:44 | H | 61/0/1 | `win-rename-r3-helper-final-green.log` |

The one helper skip is a Windows symlink-creation EPERM. Its target is preserved.
No in-place, replacement-survival, native held-handle or caller-rollback row is
skipped on this host.

### General writer execution

All times are MST on 2026-10-24. Every test command started with `node --import file:///C:/offload/lanes-1023/no-network.mjs`. `Get-Date -Format o` preceded every test run. No network, account, repository scratch copy, or Git write was used.

Aliases below:

- G: `--test test/rename-retry-writers.test.mjs`
- B: `--import file:///<resolved-%TEMP%>/win-r3-baseline-loader.mjs` (the root agent's exact ebec973f module map)
- GB: `--import file:///<resolved-%TEMP%>/win-rename-r3-general/baseline-loader.mjs` (the general agent's exact ebec973f map of its ten callers plus helper)
- L: `%TEMP%/win-rename-r3-general/`
- X: `--test test/anthropic-connect.test.mjs test/bootstrap-status.test.mjs test/quickbooks-schedule-state.test.mjs`

Pattern flags are inserted after `--test`. Counts are pass/fail/skip. Every run with failures returned Node exit 1, every clean run returned 0. The surrounding PowerShell log-display commands could themselves exit 0.

| Time | Exact suffix / options after guard | Result | Log under L |
| --- | --- | --- | --- |
| 19:04:28 | Raw Windows absolute-path `--import <resolved-%TEMP%>/win-rename-r3-general/baseline-loader.mjs`; G with `--test-name-pattern='retry identity|writer: control'` | 0/1/0 harness failure, unsupported ESM URL scheme; not red evidence | red.log |
| 19:04:50 | GB; G with `--test-name-pattern='retry identity|writer: control'` | RED 33/19/0: ten in-place, seven staging-survival, two success-squat failures; unchanged controls pass | red-verified.log |
| 19:06:14 | GB; G with `--test-name-pattern='answer setup published ownership'` | 0/1/0 harness failure, another concurrent caller imported a helper export missing from the partial baseline map; not red evidence | answer-rollback-red.log |
| 19:06:24 | B; G with `--test-name-pattern='answer setup published ownership'` | RED 1/4/0: unchanged completion passes; refused journal/manifest and same-byte published manifest/journal replacement fail | answer-rollback-red-verified.log |
| 19:06:50 | G | GREEN 68/0/0, 26410.1248 ms | green-first.log |
| 19:07:29 | X | 38/10/2: ten in-memory rollback mocks omitted the new explicit publication receipt; updated mocks below | regression-first.log |
| 19:08:16 | B; G with `--test-name-pattern='exclusive-create refusal|post-publish readback|published ownership'` | RED 8/9/0: four EEXIST deletions, one ledger post-publication replacement deletion, four answer ownership failures; unchanged publication/rollback controls pass | cleanup-extra-red.log |
| 19:08:23 | `--test test/rename-retry-writers.test.mjs test/anthropic-connect.test.mjs test/bootstrap-status.test.mjs test/quickbooks-schedule-state.test.mjs` | GREEN 128/0/2, 26665.7101 ms; two existing POSIX-only skips | green-expanded.log |
| 19:09:01 | `BRAIN_RENAME_MUTANT=path_only_cleanup`; `--import ./test/fixtures/rename-retry-mutant.mjs`; G with `--test-name-pattern='retry identity: (none|staging)$|post-publish readback|exclusive-create refusal'` | KILLED 22/7/0, 5308.6617 ms, MUTATION_APPLIED printed; seven shared-cleanup staging survival rows fail, controls pass | mutant-path-only.log |
| 19:10:19 | B; G with `--test-name-pattern='retry identity: (none|staging-in-place)$|bundle manifest CLI.*(control|race-staging-in-place)'` | Final RED 10/10/0, 5578.1218 ms; every intended in-place row fails, every control passes; fixture precondition errors now rethrown outside product wrappers | in-place-red-final.log |
| 19:10:32 | G | Final GREEN 80/0/0, 26607.6506 ms, NODE_EXIT=0 | green-final.log |

The mutant environment selector was removed immediately after its run. The byte-proof mutant has no general-site kill claim: ctime changes can independently reject the rewrite, so the helper's controlled-stat byte tests provide the deterministic kill.

`git diff --check` passed after these changes. No syntax-only Node command ran in this subtask. Guard-loaded ad-hoc Node scripts only edited reviewed source/test files. One attempted Python editing command failed before execution because Python was unavailable; it changed nothing.

### Descriptor close follow-up

An independent review found that six newly inserted create-time fstat calls sat just before the existing close-finally block. An fstat failure would therefore leak the just-opened descriptor. The fstat is now the first operation inside that block, still before writing any bytes. Binding and schedule cleanup also explicitly require a captured identity.

Added tests use an injected EIO on the first fstat of the exclusive-create descriptor and assert it closes. Each negative has an unchanged writer control, including the CLI process. The test closes any intentionally leaked descriptor in its own finally during the red run so fixture cleanup remains safe.

| Time | Exact suffix after guard | Result | Log under L |
| --- | --- | --- | --- |
| 19:13:05 | G with `--test-name-pattern='create identity fstat|CLI generation writer: (control|fstat-refusal)'` | RED on the pre-fix working tree: 6/6/0, 827.7521 ms. All six controls pass and all six failure-close cases fail. | fstat-red.log |
| 19:13:21 | Same command | GREEN 12/0/0, 883.9935 ms. | fstat-green.log |

The complete writers file now contains 91 tests, for the root agent's final combined run. Updated affected product references: answer-setup baseline :241 and create :238; field-prepare baseline :633 and create :628; verify-package-bundles baseline :50 and create :47; desktop binding baseline :101, create :96, cleanup :110; quickbooks schedule baseline :72, create :67, cleanup :78. Ingest saveState keeps its existing final baseline and cleanup line numbers, with fstat now inside the close-finally block.

### Protected writer execution

`W` means `--test test/rename-retry-windows.test.mjs`. `Q` means `--test test/quickbooks-schedule-integration.test.mjs`. Pattern arguments follow `--test`. `B` adds the exact baseline loader before `--test`. Counts are pass/fail/skip; nonzero-failure rows had test exit 1, green rows exit 0. The PowerShell summary command exits independently, so the node summaries are the authority.

| Local time | Command suffix or selection | Result | Log |
| --- | --- | --- | --- |
| 19:04:27 | W, pattern `identity(:\| rollback:)`, invalid absolute-path baseline import | Harness 0/1/0; Node rejected the non-file-URL import before any test | `win-r3-protected-red.log` |
| 19:04:42 | B W, pattern `identity(:\| rollback:)` | Harness trial 27/13/0; not accepted red because admin writable reopen was unpinned and a hook assertion could be wrapped | `win-r3-protected-red-2.log` |
| 19:06:46 | B W, pattern `identity(:\| rollback:)`, corrected fixture and external hook-error assertion | Verified RED 26/14/0 | `win-r3-protected-red-final.log` |
| 19:07:23 | B W, pattern `receipt ownership\|publication rollback` | RED 4/4/0 | `win-r3-protected-caller-red.log` |
| 19:08:02 | W, pattern `identity(:\| rollback:)\|receipt ownership\|publication rollback` | GREEN 48/0/0 | `win-r3-protected-green-first.log` |
| 19:09:07 | Q, pattern `manifest rollback ownership`, unchanged caller source before its fix | RED 3/3/0; helper/folder implementation already updated, isolating caller authority failure | `win-r3-qb-caller-red.log` |
| 19:09:17 | Q, same pattern | GREEN 6/0/0 | `win-r3-qb-caller-green.log` |
| 19:09:40 | B W, pattern `squat-after-success\|identity(:\| rollback:).*control` | RED 17/3/0 | `win-r3-protected-success-red.log` |
| 19:09:54 | W, no pattern | GREEN 72/0/0, including native Windows handle cases | `win-r3-windows-full-first.log` |
| 19:10:26 | `--test test/folder-off.test.mjs test/verified-recovery.test.mjs test/daily-refresh-scheduler.test.mjs test/quickbooks-schedule.test.mjs test/quickbooks-schedule-integration.test.mjs` | 92/5/0; three sandbox daily failures plus two obsolete writer-mock controls corrected next | `win-r3-protected-regression-first.log` |
| 19:10:41 | Q, no pattern after mock writers return real publications | GREEN 34/0/0 | `win-r3-qb-integration-green.log` |
| 19:10:52 | B `--test test/daily-refresh-scheduler.test.mjs` | 42/3/0; exact same three named sandbox daily failures | `win-r3-daily-regression-baseline.log` |
| 19:10:53 | `--test test/admin-key-file.test.mjs test/admin-key-rotation.test.mjs test/google-auth-storage.test.mjs` | 0/3/0 file tests; each fails its final rmSync with sandbox EPERM | `win-r3-credential-regression-first.log` |
| 19:11:26 | B, same three credential suites | 0/3/0, same final rmSync EPERM locations | `win-r3-credential-regression-baseline.log` |
| 19:11:48 | W, pattern `identity(:\| rollback:).* (control\|staging) between attempts`, `BRAIN_RENAME_MUTANT=path_only_cleanup`, plus `--import ./test/fixtures/rename-retry-mutant.mjs` | KILLED 13/7/0; `MUTATION_APPLIED path_only_cleanup` present; selector removed afterward | `win-r3-protected-cleanup-mutant.log` |
| 19:12:39 | W, pattern `daily receipt descriptor` | RED 1/1/0 for an introduced first-fstat descriptor leak found in review | `win-r3-descriptor-red.log` |
| 19:12:46 | W, same pattern after moving create fstat inside close-finally | GREEN 2/0/0 | `win-r3-descriptor-green.log` |

The valid original-source 40-case red has nine in-place failures. The recovery in-place row was already green because its original comparator included ctime; it remains a control. Five staging-survival rows were red: folder commit, folder rollback, recovery state, daily transaction, daily history. Admin/token commit and rollback survival were already green because their prior cleanup checked dev/ino; daily receipt had no cleanup. All ten unchanged controls passed. The success-path red kills folder rollback cleanup and both daily transaction/history finally removals.

The cleanup mutant kills seven actual caller rows (folder commit/rollback, admin commit, token commit, recovery, daily transaction/history) with all ten unchanged controls passing. Failed credential rollbacks intentionally retain their backup, and daily receipt retains staging, so those three survival rows remain passing under this particular mutant.

Sandbox daily failures are the public all-configured Windows install, scheduled ownership-plan reuse, and freshness-inventory-unavailable case. Two cannot create the shared lifecycle lock under `%ProgramData%`; one cannot create observation logs under `%USERPROFILE%`. The credential cleanup failures can mask earlier assertions, so comparison of the terminal error is not a claim that those full suites passed. The operator must rerun them outside this sandbox.

## Mutants

All five existing mutants remain and are killed. Required byte-proof and
path-only-cleanup mutants and optional ctime removal are also killed. Each run
printed `MUTATION_APPLIED`; no product file was mutated. Final helper runs use
M + H, with logs `%TEMP%/win-rename-r3-mutant-complete-<name>.log`.

| Mutant | Final time | Pass/fail/skip | Kill |
| --- | --- | --- | --- |
| `no_retry` | 19:11:52 | 30/31/1 | Recovery/exhaustion controls require retry. |
| `retry_every_error` | 19:11:52 | 53/8/1 | Non-retryable errors must stop immediately. |
| `unbounded_tries` | 19:11:52 | 55/6/1 | Exactly ten attempts, with a guard against hanging. |
| `skip_retry_revalidation` | 19:11:53 | 46/15/1 | Destination changes between attempts still require caller proof. |
| `remove_platform_gate` | 19:11:53 | 57/4/1 | macOS/Linux one-attempt controls. |
| `skip_byte_proof` | 19:11:53 | 59/2/1 | Same-length changed bytes with injected unchanged lstat/fstat metadata. |
| `path_only_cleanup` | 19:11:54 | 59/2/1 | Different-inode replacement survives, including the symlink-independent replacement test. |
| `drop_ctime` | 19:11:54 | 59/2/1 | Metadata-only ctime drift with unchanged bytes and six-field control. |

Earlier complete mutant batches also ran: 19:05:57-59, logs
`win-rename-r3-mutant-<name>.log`, results in the above order
28/31/1, 51/8/1, 53/6/1, 44/15/1, 55/4/1, 57/2/1, 57/2/1 and 57/2/1; and 19:10:16-17, logs `win-rename-r3-mutant-final-<name>.log`.
The latter had one fewer pass per row than the final batch and identical
failure/skip counts. Site-level cleanup kills are recorded in the writer and
protected execution tables. No claim is made that a real same-inode test alone
kills byte-proof removal: ctime may independently refuse it. The frozen-stat
helper test isolates that proof.

## Final checks and baseline comparison

The final command T was:

```powershell
node --import file:///C:/offload/lanes-1023/no-network.mjs --test test/rename-retry.test.mjs test/rename-retry-windows.test.mjs test/rename-retry-writers.test.mjs test/rename-retry-config.test.mjs test/test-chain-runner.test.mjs test/test-chain-complete.test.mjs
```

Its final result is **281 passed, 0 failed, 1 explicit symlink skip**. Suite
totals are helper 62 (61 pass/1 skip), Windows 74, writers 91, configuration 53,
plus two test-chain files. The test-chain runner executes only its small
synthetic fixtures, not the product chain. Native Windows held-handle cases ran.

Additional suffix aliases for the complete root execution record:

- L: `--test --test-name-pattern='R2 Windows native launch counts stay at the pre-change baseline' test/owner-contract-workspace.test.mjs`
- R3: `--test test/assistant-repair.test.mjs test/technician-setup.test.mjs test/upgrade-verify.test.mjs`
- R8: `--test test/assistant-repair.test.mjs test/technician-setup.test.mjs test/folder-off.test.mjs test/quickbooks-schedule-state.test.mjs test/daily-refresh-scheduler.test.mjs test/upgrade-verify.test.mjs test/anthropic-connect.test.mjs test/calendar-ingest.test.mjs`
- P5: `--test test/folder-off.test.mjs test/verified-recovery.test.mjs test/daily-refresh-scheduler.test.mjs test/quickbooks-schedule.test.mjs test/quickbooks-schedule-integration.test.mjs`
- R12: R8 plus `test/verified-recovery.test.mjs test/quickbooks-schedule.test.mjs test/quickbooks-schedule-integration.test.mjs test/bootstrap-status.test.mjs`.

| Time | Command | Pass/fail/skip | Log under `%TEMP%` |
| --- | --- | --- | --- |
| 19:08:01 | L | 0/1/0, initial ownership refusal | `win-r3-launch-count.log` |
| 19:08:02 | R3 | 34/4/0 | `win-r3-root-regressions-1.log` |
| 19:08:11 | B + R3 | 34/4/0, identical failures | `win-r3-root-regressions-baseline.log` |
| 19:08:14 | B + L | 0/1/0, identical ownership refusal | `win-r3-launch-count-baseline.log` |
| 19:11:11 | T, before final helper/fs-init and descriptor edge additions | 267/0/1 | `win-r3-final-focused.log` |
| 19:11:44 | R8 | 115/7/1 | `win-r3-final-caller-regressions.log` |
| 19:11:47 | L | 0/1/0, same ownership refusal | `win-r3-final-launch-count.log` |
| 19:11:53 | B + R8 | 115/7/1, identical seven failures | `win-r3-final-caller-regressions-baseline.log` |
| 19:12:20 | T, before final descriptor-close additions | 268/0/1 | `win-r3-final-focused-complete.log` |
| 19:12:20 | P5 | 94/3/0, same baseline daily failures | `win-r3-final-protected-callers.log` |
| 19:14:17 | T, final sources | 281/0/1, 27150.3561 ms | `win-r3-final-all.log` |
| 19:14:17 | R12, final sources | 177/7/2, 3131.4393 ms | `win-r3-final-regressions-all.log` |
| 19:14:17 | L, final sources | 0/1/0, same baseline ownership refusal | `win-r3-final-launch-complete.log` |

The seven final regression failures match the exact baseline comparison:

- Daily scheduler: public all-configured Windows install, scheduled ownership
  plan reuse, and unavailable freshness inventory. These encounter sandbox
  restrictions on `%ProgramData%` lifecycle state or `%USERPROFILE%` observation
  state, before the relevant assertions complete.
- Technician setup: creation of an owner-only workspace, preservation of an
  unrelated workspace, and refresh of an installed workspace. This sandbox's
  ownership/path boundary differs from the normal owner identity.
- Upgrade verification: its final fixture `rmSync` throws EPERM. Like the
  separately compared credential suites, a failing finally can mask earlier
  assertions. Matching terminal failure is not a claim those suites passed.

The two R12 skips are existing POSIX-only permission cases. The final renamed
writer cases and all new rollback tests pass. Existing in-memory test writers
were updated to return explicit publication evidence; their obsolete-mock
failures are disclosed above and do not remain.

At 19:11:33, guarded `node --check <file>` passed for all 29 modified JavaScript
files. The final helper and new staging fixture were also checked at 19:12:20.
The final syntax/diff/privacy inspection is recorded below.

At 19:15, guarded `node --check <file>` passed for all 29 modified JavaScript
files plus the new staging fixture (30 files total); log
`%TEMP%/win-r3-final-syntax.log`. `git diff --check` passed with the repository's
normal newline settings. Added-line and new-file scans found no prohibited name,
word, em dash or literal user-profile path. Read-only Git comparison confirms
the round 2 report is byte-for-byte unchanged. All test processes ended before
19:15, ahead of the 23:15 test cutoff; this report was completed before 19:20,
ahead of the 23:30 report deadline.

The launch-count test was executed unchanged. It stops at the initial workspace
ownership decision with `preserved_unsafe_existing_file`, on both this tree and
exact `ebec973f`, before counts can be measured in this sandbox. The required
outside-sandbox baselines remain create 10, refresh 15, setup of both 21 and
update of both 30. The operator must rerun that test outside this identity.
Source review confirms the new proof uses Node fs only and retains the single
pre-attempt ownership check from the accepted operator commit.

## Out-of-scope observations and limits

These paths were inspected and left unchanged:

- `operations/claude-workspace.mjs:448`, `:474`, `:488`: displacement and retained
  lock-directory renames. The private install-link unlink at `:462` belongs to
  the separate two-link publication path, outside these 27 single-file renames.
- `operations/daily-refresh-observation.mjs:145`: plain log-rotation rename.
- `operations/windows-task-contract.mjs:300`: pending lock-directory publish;
  its owner-file cleanup at `:302` and `:306` remains outside this lane.
- `operations/daily-refresh-scheduler.mjs:1017`, `:1038`, `:1056`: Darwin
  exclusive staging, plain rename and path-only finally cleanup. Collision and
  success-squat deletion have the same shape but are outside the 27 sites.
- `operations/daily-refresh-scheduler.mjs:1265`, `:1283`: Windows task XML
  exclusive creation and path-only cleanup, not a rename site.
- `operations/daily-refresh-run.mjs:414`, `:438`, `:485`: after an initial
  receipt refusal, the follow-up write can hit the same per-pid staging EEXIST
  and hide the original refusal. This was expressly left out of scope.
- `brain.mjs:24025`, `:24033`: legacy external-assistant-CLI reconciliation
  captures current state for restoration. It now benefits from exact current
  identity/bytes in the shared restore writer, but has no proof the external
  CLI authored that inode. It is outside the assistant-bundle refused-helper
  rollback chain; no publication-authority claim is made for that older path.

Node does not provide an atomic conditional unlink or rename-by-handle here.
There remains a race after the last pathname proof and the filesystem syscall.
This change fixes the observed between-attempt races and accidental replacement
cleanup; it does not claim protection against every same-user filesystem race.
Some older destination snapshot readers still use unbounded reads; they are not
reused for the new bounded staging proof. Live/provider behavior, other operating
systems and sandbox-blocked credential regression bodies require their separate
operator/CI gates. No full-chain or real-account execution occurred.

## Prepared commit

Subject: Bind staged rename retries to exact bytes and owned cleanup

Body: Prove bounded staged bytes at all 27 retry sites, compare change time,
and preserve replacement files during cleanup. Bind assistant, skill, answer
setup, daily and schedule manifest rollback to exact publication receipts.
Keep the accepted workspace launch-check change. Add paired race, collision,
rollback, descriptor and mutation tests, and record focused baseline comparison
and remaining platform limits.

## Operator verification and review

The lane's work is commit `a124fd61`, unchanged; its own verdict was READY.
The operator re-ran the checks outside the lane sandbox on the same Windows
host (normal non-elevated user, Developer Mode off), each run in a fresh
profile-shaped fence with the network guard, and ran an independent read-only
review. Times are MST on 2026-10-24.

Tests on the round 3 tree:

- Rename suites: helper 61/0/1 (the one symlink EPERM skip), configuration
  53/0/0, writers 91/0/0, Windows 74/0/0. Test-chain runner and complete pass.
- Launch counts measured: create 10, refresh 15, setup of both 21, update of
  both 30, the same as `ebec973f`. The lane sandbox could not measure them.
- The suites the sandbox could not complete pass here on both trees:
  admin-key-file, admin-key-rotation, google-auth-storage and
  daily-refresh-scheduler (45/0/0).
- 140 suites (every test file that imports a changed module, plus the suites
  for the changed brain.mjs paths) were run on this tree and on an exact
  `ebec973f` worktree at the same path length, then compared by failing test
  names per suite. 139 are identical. The 140th, update-pending-refusal
  ("production recovery retry keeps imports paused through refusal and
  reconciles manifest drift only after health proof"), is flaky on both trees:
  it failed 1 of 3 runs here and 1 of 2 runs on `ebec973f`, both times with
  EPERM on the daily receipt rename in about 130 ms. That is too fast for the
  retry budget, so the retry seems not to engage there; not traced.
- Suites failing identically on both trees on this host: field-prepare 1,
  older-release-paused-resume 1, owner-contract-workspace 3,
  package-bundle-verifier 15, package-privacy 1, quickbooks-desktop-connect 1,
  technician-setup 1, upgrade-verify 1.
- Mutants, each with `MUTATION_APPLIED` and the guard active, all killed with
  the counts in the table above: `no_retry` 30/31, `retry_every_error` 53/8,
  `unbounded_tries` 55/6, `skip_retry_revalidation` 46/15,
  `remove_platform_gate` 57/4, `skip_byte_proof` 59/2, `path_only_cleanup`
  59/2, `drop_ctime` 59/2. Unmutated control 61/0/1.
- `git diff --check` clean; names, secrets, email and user-path scan clean on
  every added line and new file. The round 2 report is unchanged.

Review: four area reviewers, one refuter over all findings, one completeness
critic, all read-only. Confirmed by the refuter; the operator also read the
code for the third P2 and confirms it.

1. P2 `operations/rename-retry.mjs:69`, `:86`, `:124-129`, `:144-146`,
   `:166-168`. Any error opening or reading the staging file for the proof
   returns false and is mapped straight to the caller's refusal, outside the
   try that holds the retry decision. On Windows, a process holding the fresh
   staging file without read sharing turns a transient lock, the case the
   retry exists for, into a hard refusal on the first attempt. Round 2's
   lstat-only check was not affected. Suggested fix: a three-way proof result
   (match, mismatch, not observable); retry "not observable" within the same
   ten-attempt budget and never rename without a positive match; add a native
   test that holds the staging file with no read sharing for about 450 ms.
2. P2 `operations/answer-setup.mjs:583-586`. When the manifest has no
   `brain.domain`, the run's own forward deploy (`brain.mjs:19830` into
   `persistWorkersDevDomain` at `:3211-3219`, then `saveManifest` at
   `:2877-2878`) rewrites the manifest in place. The recorded publication
   proof no longer matches, so any later failure stops rollback with
   ANTHROPIC_ROLLBACK_INCOMPLETE before any step runs: the manifest keeps the
   new model pair, a key the Worker rejected stays on the Worker, and the
   journal is kept. Suggested fix: deploy with `persistDomain: false` in the
   forward step, or re-record the publication after the run's own domain save.
3. P2 `operations/daily-refresh-scheduler.mjs:641`, `:603-604`, `:797`, with
   `brain.mjs:31143-31144` and `:31172-31188`. When a receipt exists but its
   recovery fence does not, the read returns null, `brain update` passes null
   as the expected predecessor, and the write requires the file to be absent.
   Every later `brain update` then stops with "the daily update transaction
   receipt is unsafe", and a retry cannot succeed. `ebec973f` had no such
   check here. Suggested fix: carry the actual receipt identity and bytes from
   the read as the expected predecessor, or give the fenceless receipt its own
   recovery path.

P3 and test findings:

- `test/rename-retry.test.mjs:423-441`: the helper suite's in-place retry row
  is refused by the test's own ctime-aware revalidate before the product byte
  proof runs, so removing the proof call from `renameWithRetrySync` passes the
  helper suite. Add a mutant that removes that call, and give `staged.refuse`
  its own error.
- `test/rename-retry.test.mjs:56-78`: the read-bound assertion counts returned
  bytes, so an unbounded read-until-EOF regression would pass. Add a much
  larger on-disk file with frozen stats and sum the requested lengths.
- `operations/bootstrap-status.mjs:448`, `:461`, `:485`: the staging name is
  per process ID only; a leftover temp from a killed run now blocks later runs
  that reuse that ID, because EEXIST no longer clears it. Rare.
- `operations/verified-recovery.mjs:1296`, `:1314`: the first-create link path
  publishes even when the shared proof capture refused.
- Uncertain: publication tokens bind ctime and mtime, so a metadata-only change
  by a sync client refuses a legitimate daily or schedule rollback
  (`operations/folder-retirement.mjs:198-202`). It fails closed.

Report claims that need a qualifier: the "25 of 27 red on exact `ebec973f`"
evidence used a module-substitution loader inside round 3 tests, not a checkout;
the create-fstat descriptor-close tests cover 7 writers, the rest rest on code
review; the launch counts were not measured in the sandbox (now measured above).

Operator verdict: not ready. All three P2s fail closed (no data loss, no
corruption), but each can stop a legitimate owner operation.

LANE WIN-RENAME-RETRY-3: NOT READY operator review confirmed three fail-closed P2 regressions (proof read not retried on a Windows sharing lock; answer setup rollback refused after its own domain save; a fenceless daily receipt blocks every later update)
