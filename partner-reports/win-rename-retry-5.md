# WIN-RENAME-RETRY-5

Starting branch: `partner/win-rename-retry-5`, commit `34474db6`.
The round 4 report and its operator review were read first. This is held
0.4.20 work, not release or live-account evidence. All changes remain in the
working tree for the operator. No Git metadata write, commit, push, network
request, dependency installation, full test chain, real account or Brain was
used. The earlier reports and the two separate checkouts are unchanged.

## Changes and red/green evidence

1. `operations/rename-retry.mjs:56`: a private staging comparator excludes
   change time on every platform. Exact bounded bytes, device, inode, link
   count, size, modification time and mode remain checked through the existing
   descriptor and pathname brackets. The public metadata comparators stay
   unchanged. `test/rename-retry.test.mjs:203`, `:225`, `:289` cover ctime-only
   changes, native Windows ACL-before-baseline publication and POSIX chmod
   after baseline. The POSIX case changes permissions and restores the original
   owner mode, isolating ctime while retaining the mode invariant.

   Native red at 21:52:37 was 1/2/1: the unchanged control passed, the actual
   ACL case reached the caller's publication refusal after observed delayed
   ctime movement, and the portable ctime case failed. Green at 21:52:53 was
   3/0/1. The Windows fixture follows the credential sequence: create/close
   empty file, apply `icacls`, write/fsync/close payload, capture proof, then
   poll without ever replacing that proof. Sixteen independent files now make
   the native observation less timing-sensitive. If this sandbox exposes no
   delayed change during the bounded poll, all renames still run but the
   regression row explicitly skips rather than claiming delayed-change coverage.
   A final native-targeted ctime-restoration mutant at 21:59:29 was 1/2/0,
   killed at the native publication assertion as well as the portable assertion.

2. `operations/daily-refresh-scheduler.mjs:626`, `:661`, `:701`, `:709`,
   `:720`, `:864`, `:899`, `brain.mjs:31145`, `:31196`, `:31222`, and
   `operations/daily-refresh-run.mjs:589`: fenceless receipts have a separate
   recovery path. The reader derives an
   immutable runtime marker from the live fence, never from JSON. Update keeps
   the exact prior receipt solely as replacement custody and conservative
   remote-dispatch evidence, captures current daily/legacy/bridge schedules,
   and starts a fresh transaction. Atomic replacement avoids an erase-before-
   write gap. No prior schedule authorizes restoration. Prior bridge evidence
   is archived, with exact publication readback, before being superseded.
   Daily execution still checks the live lease/fence and no longer defers
   indefinitely on an explicitly fenceless receipt.

   The first complete owner-change matrix was 9/5/0 red, then 14/0/0 green.
   It drives real `cmdDaily off/on` followed by `cmdUpdate` preflight refusal
   with Windows and macOS scheduler fixtures. Removed tasks stay removed and
   newer definitions survive. Unchanged schedules are passing controls.
   Additional paired tests cover prior remote uncertainty, failure before
   fresh snapshot/publication, legacy-pause refusal, no managed schedules,
   archive readback and a foreign content-equal replacement receipt. Receipt
   publication and fence creation are checked while the real update lock is
   held. Possible prior remote dispatch stays fenced for verified recovery;
   only proven pre-dispatch failure restores the current snapshot.

   Independent review added archive corruption/new-inode controls (2/4/0 red,
   6/0/0 green) and direct-writer/fresh-publication controls (3/1/0 red,
   4/0/0 green). The writer independently inspects the actual fence and requires
   the reader's exact custody proof before replacing a fenceless predecessor.
   It cannot inherit old authority merely because a direct caller omitted the
   marker. Final focused receipt tests pass 34/0/0. Relevant tests are at
   `test/daily-refresh-update-production.test.mjs:344`, `:381`, `:399`, `:421`,
   `:480`, `:507`, `:543`, `:568`, `:616`, `:655`, `:687`, and `:719`.

3. `operations/claude-workspace.mjs:387`, `:420`, `:434`, `:459`, `:522`:
   metadata/ownership revalidation no longer re-reads staging bytes outside
   the shared retry boundary. Terminal sharing observation retains the file
   and releases the mutex before any active guide has been displaced. Native
   testing found that Windows also locks the containing directory, so the
   initial temporary file now lives in a separately pinned, random preparing
   directory. A held file can remain there while the empty mutex is released.
   The ready/install/previous layout after preparation is unchanged. Definite
   byte/identity refusals still retain the mutex and evidence.

   Injected observation plus initial name tests were 11/9/0 red, then 20/0/0
   green. Actual native FileShare.None rows were 4/2/0 red: both held cases
   stranded the mutex despite the injected tests passing. The native green
   rerun was 9/0/0, including three existing rename controls. Held cases prove
   ten denied observations, no publication, the exact retained pending path,
   mutex release and a successful later write after handle release. Eight
   added parent/preparing-directory custody controls pass without another
   product edit. No native subprocess was added to production.

4. `operations/admin-key-file.mjs:911`, `:924` and
   `connectors/google-auth.mjs:954`, `:968`: once exact replacement readback
   and directory synchronization succeed, backup cleanup failure cannot roll
   back that verified credential. The error says the verified replacement
   remains stored and backup cleanup could not be verified. This claims local
   persistence only, not remote credential convergence. Cleanup tests were
   2/2/0 red, then 4/0/0 green; blocked cleanup previously caused a second,
   rollback rename. Tests now prove one publication and retained protected
   backup evidence under the injected sharing refusal.

5. Delayed ACL ctime can also reach the destination of an immediate subsequent
   write. Five private predecessor comparators now omit only ctime:
   `operations/admin-key-file.mjs:66`, `connectors/google-auth.mjs:411`,
   `connectors/whatsapp.mjs:392`,
   `connectors/quickbooks-desktop-binding.mjs:26`, and
   `operations/quickbooks-schedule-state.mjs:11`. They retain regular-file,
   absence, device, inode, link-count, size, mtime and mode checks. They do not
   add an un-retried destination read. Credential prior bytes are snapshotted
   earlier; these predecessor checks are metadata proofs, not fresh byte
   proofs. Staging, publication and rollback still require exact bytes.
   Credential predecessor tests were 4/2/0 red; the other three ACL paths were
   6/3/0 red. The combined final new suites pass 19/0/0. Every ctime case has
   an unchanged control and a modification-time refusal control.

6. Thirteen remaining weak staging-name sites/helpers now use random entropy:
   `operations/answer-setup.mjs:234`, `brain.mjs:14711`,
   `ingest/run.mjs:2134`, `connectors/whatsapp.mjs:418`,
   `operations/claude-skill.mjs:696`, `operations/daily-refresh-run.mjs:484`,
   `connectors/imessage.mjs:385`, `operations/drive-scheduler.mjs:917`,
   `operations/whatsapp-daemon.mjs:215`, both native daily adapter staging
   paths in `operations/daily-refresh-scheduler.mjs:1046` and `:1294`,
   `scripts/field-prepare.mjs:624`, and
   `scripts/verify-package-bundles.mjs:43`. The additional seven pairs were
   7/7/0 red, then 14/0/0 green. Old-name residues retain their inode and bytes.
   The fixed drive log `.rotate.tmp` slot remains intentional bounded log
   retention; durable recovery pending paths and lifecycle lock names are not
   ephemeral staging names. The audit found no other PID-only or clock-only
   temporary name in the reviewed source directories.

7. `test/rename-retry-config.test.mjs:237`, `:255`, `:306`,
   `test/rename-retry-windows.test.mjs:424`, `:647`, and
   `test/rename-retry-writers.test.mjs:153` contain the caller regressions.
   `test/fixtures/rename-retry-cli.mjs:66` recognizes the random CLI staging
   path. The new suites are `test/credential-backup-cleanup.test.mjs:42`,
   `test/acl-predecessor.test.mjs:51`, and
   `test/rename-retry-staging-names.test.mjs:1`.
   `scripts/run-test-chain.mjs:20` registers all three new suites in the graph
   and post-launcher projection. The completeness check first caught the three
   orphan tests; both chain checks then passed 2/0/0. The chain itself was not
   run. Architecture and developer docs describe the revised proof, recovery,
   cleanup and workspace layout.

The older answer-provider domain save after daily re-registration remains out
of scope. Its round 4 implementation was not changed here; only its existing
caller mutant was preserved as a checked-in fixture and rerun.

## Helper interface

No export, argument order, option name, default or return type changed this
round. `captureStagedProofWithRetry` remains the only added export relative to
the pre-round-4 helper. The private comparator is not exported.

| Export | Preserved contract |
| --- | --- |
| `RENAME_IDENTITY_KEYS` | Frozen dev, ino, nlink, size, mtimeMs, ctimeMs, mode array |
| `captureRenameIdentity` | `(path, {lstat, bigint=false}={})`, Stats or null |
| `sameRenameIdentity` | `(actual, expected)`, boolean, still compares ctime |
| `renameIdentityMatches` | `(path, expected, {lstat}={})`, boolean, still compares ctime |
| `stagedBytesMatch` | `(path, expected, bytes, {fs={}}={})`, boolean without waiting |
| `captureStagedProof` | `(path, bytes, created, {fs={}}={})`, synchronous frozen Stats or null |
| `captureStagedProofWithRetry` | Same arguments plus `{fs, platform, sleep}`, synchronous frozen Stats or null |
| `removeOwnedStaging` | `(path, created, {proof, bytes=null, fs={}}={})`, boolean |
| `renameWithRetrySync` | `(from, to, {revalidate, staged, fs, platform, rename, sleep}={})`, rename result |
| `renameWithRetry` | Same option names, Promise of rename result |

The round 4 shared nine-wait budget, Windows-only retry codes, definite-refusal
behavior, exact read bound, close-error refusal and async proof-to-rename
ordering remain. The old `drop_ctime` mutant is retained and killed by public
metadata-identity tests; the new mutant restores ctime only to staging.

## Remaining change-time comparisons

The public helper's metadata checks remain at `operations/rename-retry.mjs:36`
and `:44`. Their remaining predecessor callers are the calendar writer in
`brain.mjs:14724`, ordinary answer JSON writes at
`operations/answer-setup.mjs:232`, bootstrap status at
`operations/bootstrap-status.mjs:477`, skill publication at
`operations/claude-skill.mjs:711`, curated state at
`operations/curated-dual-sync.mjs:1232`, ingest state at `ingest/run.mjs:2147`,
daily execution receipt at `operations/daily-refresh-run.mjs:495`, and daily
transaction/history predecessor checks in `operations/daily-refresh-scheduler.mjs`.
Workspace's helper use is expected absence only, so no timestamp is compared.
These writers do not apply a native file ACL to those destinations. Directory
ACL work on a separate lifecycle lock does not cause the measured file drift.
Their stricter metadata behavior is preserved.

Publication/rollback proof callers in answer setup, skill repair, assistant
repair and manifest rollback in `brain.mjs`, daily transaction reading/clearing,
folder retirement, credentials and owned backup cleanup use
`captureStagedProof`/`stagedBytesMatch`/`removeOwnedStaging`. They no longer
compare ctime through those proofs. The five native ACL-protected predecessor
exceptions above also no longer compare it. No fresh destination byte read was
introduced before rename retry.

Independent private ctime comparators remain in `installed-manifest.mjs:53`
and `verified-recovery.mjs:227`, plus package/runtime identity and source/recovery
artifact readers: `cloudflare-recovery-adapter.mjs:1189`,
`cloudflare-disposable-deployment-provider.mjs:189`,
`disposable-recovery-deployment-journal.mjs:361`,
`disposable-recovery-field-acceptance.mjs:224`,
`disposable-recovery-field-closeout-journal.mjs:119`,
`disposable-recovery-field-closeout.mjs:289`,
`disposable-recovery-field-closeout-terminal-anchor.mjs:89`,
`disposable-recovery-field-teardown.mjs:428`, `machine-continuity.mjs:147`,
`locked-wrangler-runtime.mjs:142`, `package-bundle-verifier.mjs:90`,
`private-aggregate-receipt.mjs:89`, `:94`,
`quickbooks-desktop-signed.mjs:42`, `quickbooks-desktop-bridge.mjs:187`,
`v048-teardown-d1-content-proof.mjs:143`, `recovery-content-fingerprint.mjs:38`,
`update-preview.mjs:311`, and `recovery-artifact-crypto.mjs:158`.
These paths are under `operations/`. None applies `icacls` or
`restrictWindowsFileToCurrentUser` to its own compared file; closeout only
inspects ACLs. Their reads and longer-lived artifact pins are outside this
staging fix. External metadata changes can still cause their deliberate
refusals; this report does not claim universal ctime stability.

## Execution record

All times below are MST on 2026-10-24. Every Node command began with
`node --import file:///C:/offload/lanes-1023/no-network.mjs`.
Get-Date and a cutoff check preceded every test, including each mutant.
Counts are pass/fail/skip. Node exit 0 means a passing run, exit 1 a failed
suite or killed mutant; a PowerShell wrapper exit is not the Node result.
Logs and the one ad-hoc probe are under `%TEMP%`, never the repository.

These suffix aliases follow the guarded Node prefix. Patterns in prose use
literal `|` regex alternation.

| Alias | Command suffix |
| --- | --- |
| H | `--test test/rename-retry.test.mjs` |
| C | `--test --test-name-pattern='change-time-only\|native Windows ACL\|POSIX chmod' test/rename-retry.test.mjs` |
| R | `--test test/rename-retry.test.mjs test/rename-retry-windows.test.mjs test/rename-retry-writers.test.mjs test/rename-retry-config.test.mjs test/test-chain-runner.test.mjs test/test-chain-complete.test.mjs` |
| W | `--test test/rename-retry-config.test.mjs test/rename-retry-writers.test.mjs test/rename-retry-windows.test.mjs test/rename-retry-staging-names.test.mjs` |
| WP | `--test --test-name-pattern='staging name\|workspace staging observation' test/rename-retry-config.test.mjs test/rename-retry-writers.test.mjs test/rename-retry-windows.test.mjs` |
| E | `--test test/rename-retry-staging-names.test.mjs` |
| K | `--test test/credential-backup-cleanup.test.mjs` |
| KP | `--test --test-name-pattern='predecessor' test/credential-backup-cleanup.test.mjs` |
| A | `--test test/acl-predecessor.test.mjs` |
| AK | `--test test/acl-predecessor.test.mjs test/credential-backup-cleanup.test.mjs` |
| D | `--test test/daily-refresh-update-production.test.mjs` |
| F | D with `--test-name-pattern='fenceless daily receipt\|daily run with\|production daily receipt'` before the file |
| FF | D with `--test-name-pattern='fenceless daily receipt\|fenceless receipt\|daily run with\|production daily receipt'` before the file |
| S | `--test test/daily-refresh-run.test.mjs test/daily-refresh-scheduler.test.mjs` |
| X | `--test --test-name-pattern='domain-save rollback' test/anthropic-connect.test.mjs` |
| L | `--test --test-name-pattern='R2 Windows native launch counts stay at the pre-change baseline' test/owner-contract-workspace.test.mjs` |
| T | `--test test/test-chain-runner.test.mjs test/test-chain-complete.test.mjs` |

All log names in the following tables have prefix `win-r5-` and suffix `.log`.

| Time | Run | Result | Log stem |
| --- | --- | --- | --- |
| 21:52:08 | C, initial ACL-after-payload fixture | 1/2/1; native drift not reproduced, superseded | ctime-red |
| 21:52:37 | C, credential-order native fixture before fix | RED 1/2/1; native publication refusal reproduced | ctime-red-secured |
| 21:52:53 | C after helper fix | 3/0/1 | ctime-green |
| 21:54:43 | H, single native sample | 160/1/2; native observation absent | helper-full |
| 21:55:09 | X | 10/0/0 | domain-control |
| 21:55:55 | C, sixteen samples | 3/0/1 | ctime-sampled-green |
| 21:58:59 | H, explicit no-observation skip policy | 161/0/2 | helper-final |
| 21:59:48 | R | 408/1/2; completeness found three new orphan tests | required-final |
| 21:59:48 | L | 0/1/0; ownership refusal before launch counts | launch-final |
| 22:00:42 | T after graph registration | 2/0/0 | chain-green |
| 22:03:29 | R after direct-writer guard | 411/5/3; old fixture seeded invalid `{}` instead of exact predecessor | required-complete |
| 22:03:29 | E plus AK, all three new suites | 33/0/0 | added-complete |
| 22:04:27 | `--test --test-name-pattern='daily transaction identity' test/rename-retry-windows.test.mjs` | 5/0/0 after valid seed and exact predecessor fixture | daily-identity-fixture-green |
| 22:04:54 | R, final sources and fixtures | 416/0/3 | required-verified |

The five fixture cases still prove two real rename calls for unchanged/squat
controls and one call before destination, staging or in-place byte refusal.
The product's new fenceless guard was not weakened to recover these controls.

| Time | Workspace/names run | Result | Log stem |
| --- | --- | --- | --- |
| 21:52:45 | WP before fixes | RED 11/9/0 | workspace-names-red |
| 21:53:28 | WP after fixes | 20/0/0 | workspace-names-green |
| 21:54:37 | E before remaining name fixes | RED 7/7/0 | extra-names-red |
| 21:54:58 | E after fixes | 14/0/0 | extra-names-green |
| 21:55:37 | W before native workspace rows | 254/0/0 | writers-full |
| 21:56:22 | Windows suite, pattern `native workspace staging observation` | RED 4/2/0 | workspace-native |
| 21:57:35 | Windows suite, pattern `native workspace staging observation\|workspace staging rename` | 9/0/0 | workspace-native-green |
| 21:58:45 | W | 260/0/0 | writers-final |
| 22:00:21 | Config suite, pattern `workspace directory custody` | 8/0/0 | workspace-directory-custody |

"Windows suite" expands to `--test test/rename-retry-windows.test.mjs`;
"Config suite" expands to `--test test/rename-retry-config.test.mjs`, with the
stated `--test-name-pattern` before the file.

| Time | Credential/ACL run | Result | Log stem |
| --- | --- | --- | --- |
| 21:52:14 | K before cleanup fix | RED 2/2/0 | credential-cleanup-red |
| 21:52:23 | K after cleanup fix | 4/0/0 | credential-cleanup-green |
| 21:52:52 | KP before predecessor fix | RED 4/2/0 | credential-predecessor-red |
| 21:53:03 | K after predecessor fix | 10/0/0 | credential-predecessor-green |
| 21:53:15 | direct `test/admin-key-file.test.mjs` | exit 1, cleanup masks assertion totals | direct-admin-key-file |
| 21:53:15 | direct `test/admin-key-rotation.test.mjs` | exit 1, cleanup masks assertion totals | direct-admin-key-rotation |
| 21:53:16 | direct `test/google-auth-storage.test.mjs` | exit 1, cleanup masks assertion totals | direct-google-auth-storage |
| 21:53:41 | `--test test/admin-key-file.test.mjs` | 0/1/0 file-level | direct-test-admin-key-file |
| 21:53:41 | `--test test/admin-key-rotation.test.mjs` | 0/1/0 file-level | direct-test-admin-key-rotation |
| 21:53:41 | `--test test/google-auth-storage.test.mjs` | 0/1/0 file-level | direct-test-google-auth-storage |
| 21:54:18 | K after cleanup wording refinement | 10/0/0 | credential-cleanup-final |
| 21:55:07 | A before other ACL predecessor fixes | RED 6/3/0 | acl-predecessor-red |
| 21:55:26 | A after fixes | 9/0/0 | acl-predecessor-green |
| 21:56:15 | AK, final credential sources | 19/0/0 | credentials-final |
| 21:57:11 | `--test test/quickbooks-schedule-state.test.mjs` | 3/0/1 | acl-regression-schedule-state |
| 21:57:11 | `--test --test-name-pattern='Windows binding ACL failures' test/quickbooks-desktop-connect.test.mjs` | 1/0/0 | acl-regression-desktop-binding |
| 21:57:12 | `--test test/whatsapp-capture.test.mjs` | 0/1/0 file-level, cleanup EPERM | acl-regression-whatsapp-capture |
| 22:03:29 | direct `test/google-auth-storage.test.mjs`, final sources | exit 1, cleanup masks assertion totals | direct-final-google-auth-storage |
| 22:03:31 | direct `test/admin-key-file.test.mjs`, final sources | exit 1, cleanup masks assertion totals | direct-final-admin-key-file |
| 22:03:32 | direct `test/admin-key-rotation.test.mjs`, final sources | exit 1, cleanup masks assertion totals | direct-final-admin-key-rotation |

Direct means guarded `node <file>` without `--test` or the chain harness. These
scripts are not node:test suites, so invented internal pass counts would be
misleading. All three stop at their final cleanup EPERM, respectively test
lines 796, 654 and 1192. The wrapper runs provide exact 0/1/0 file-level totals.
Cleanup can mask an earlier failure, so no functional pass or base-equivalence
claim is made. The capture suite similarly stops at cleanup line 557.

| Time | Receipt run | Result | Log stem |
| --- | --- | --- | --- |
| 21:52:11 | F, first native fixture | 6/8/0; fixture ACL/legacy-adapter interference | fenceless-red |
| 21:52:31 | F, isolated fixture | RED 8/6/0 | fenceless-red-isolated |
| 21:52:48 | F, completed paired controls before fix | RED 9/5/0 | fenceless-red-final |
| 21:53:01 | F | 14/0/0 | fenceless-green |
| 21:53:47 | F plus live fence/update-lock assertions | 14/0/0 | fenceless-final |
| 21:53:55 | D | 25/88/0 | daily-production-full |
| 21:53:55 | S | 90/10/0 | daily-run-scheduler |
| 21:56:43 | D, pattern `fenceless receipt preserves remote\|fenceless receipt survives before` | RED 2/2/0 | fenceless-uncertainty-red |
| 21:57:06 | Same uncertainty pattern | 4/0/0 | fenceless-uncertainty-green |
| 21:57:33 | D, pattern `without managed schedules` | RED 1/1/0 | fenceless-empty-red |
| 21:57:40 | Same empty-schedule pattern | 2/0/0 | fenceless-empty-green |
| 21:57:57 | D, pattern `fenceless receipt keeps uncertainty` | RED 1/1/0 | fenceless-legacy-red |
| 21:58:02 | Same legacy pattern | 2/0/0 | fenceless-legacy-green |
| 21:58:49 | D, pattern `fenceless receipt archives prior` | RED 1/1/0 | fenceless-history-red |
| 21:59:02 | Same archive pattern | 2/0/0 | fenceless-history-green |
| 21:59:16 | D | 35/88/0 | daily-production-final |
| 21:59:16 | S | 90/10/0 | daily-run-scheduler-final |
| 21:59:17 | FF | 24/0/0 | fenceless-final-complete |
| 22:00:58 | D, pattern `fenceless receipt archive readback` | RED 2/4/0 | fenceless-archive-proof-red |
| 22:01:04 | Same archive-readback pattern | 6/0/0 | fenceless-archive-proof-green |
| 22:01:14 | FF | 30/0/0 | fenceless-reviewed-final |
| 22:01:14 | D | 41/88/0 | daily-production-reviewed-final |
| 22:01:53 | D, pattern `fenceless receipt direct writer\|fenceless receipt fresh publication` | RED 3/1/0 | fenceless-direct-proof-red |
| 22:02:03 | Same direct-writer/publication pattern | 4/0/0 | fenceless-direct-proof-green |
| 22:02:34 | FF | 34/0/0 | fenceless-all-final |
| 22:02:34 | D | 45/88/0 | daily-production-all-final |
| 22:06:46 | S, final sources | 90/10/0 | daily-run-scheduler-verified |

All 34 new focused receipt cases pass in the final full production run. Its
88 failing case names match the earlier round-5 full run; this was compared
read-only, not inferred from totals. It is not a comparison with an untouched
checkout. Runner/scheduler totals are 48/7/0 and 42/3/0, respectively. Their
native ACL, private-profile and cleanup failures require the normal-identity
operator rerun. No live state was used to work around these restrictions.

## Mutants

All 22 mutations are checked-in process-only loader fixtures. Every recorded
run printed `MUTATION_APPLIED` with the network guard active and exited 1.
No mutant rewrites product files. Every existing helper mutant and both prior
caller mutants are retained. The prior temporary domain-save and
discard-fenceless loaders now have repository fixtures.

For helper mutations, set `BRAIN_RENAME_MUTANT`, insert
`--import ./test/fixtures/rename-retry-mutant.mjs` after the network import,
then run H and remove the selector. The first complete batch used the strict
native-drift fixture; some rows also had a host-observation failure. The final
batch explicitly skips absent native drift and independently kills every
mutant through its intended behavioral assertions.

| Mutant | First batch time and counts | Final batch time and counts | Kill |
| --- | --- | --- | --- |
| no_retry | 21:56:25, 87/74/2 | 22:00:05, 86/74/3 | Released locks and shared retry budget |
| retry_every_error | 21:56:30, 151/10/2 | 22:00:13, 150/10/3 | Non-retryable errors stop |
| unbounded_tries | 21:56:41, 131/30/2 | 22:00:27, 131/29/3 | Ten-attempt/shared-budget bounds |
| skip_retry_revalidation | 21:56:57, 119/42/2 | 22:00:42, 119/41/3 | Per-attempt caller custody |
| remove_platform_gate | 21:57:10, 144/17/2 | 22:00:56, 144/16/3 | POSIX single attempt |
| skip_byte_proof | 21:57:24, 144/17/2 | 22:01:10, 144/16/3 | Same-metadata rewritten bytes |
| path_only_cleanup | 21:57:38, 158/3/2 | 22:01:24, 158/2/3 | Foreign inode survives cleanup |
| drop_ctime | 21:57:51, 158/3/2 | 22:01:38, 158/2/3 | Public metadata comparators stay strict |
| skip_sync_byte_proof_call | 21:58:05, 132/29/2 | 22:01:51, 132/28/3 | Sync in-place byte rewrite |
| skip_async_byte_proof_call | 21:58:21, 132/29/2 | 22:02:07, 132/28/3 | Async in-place byte rewrite |
| oversized_proof_read | 21:58:35, 141/20/2 | 22:02:21, 141/19/3 | Requested length plus EOF bound |
| restore_staging_ctime | 21:58:48, 159/2/2 | 22:02:35, 159/1/3 | Portable ctime control; native targeted kill below |

Logs are `win-r5-helper-mutant-<name>.log` and
`win-r5-helper-mutant-final-<name>.log`. The targeted final native run at
21:59:29 used pattern `native Windows ACL|change-time-only` with the same
ctime-restoration loader: **1/2/0**, log `win-r5-ctime-native-mutant.log`.
The native case fails at `native ACL drift must not refuse the owned bytes`,
not a fixture-observation assertion. The unchanged native control passes.

Caller mutation reproduction:

- `test/fixtures/daily-receipt-mutant.mjs`, selector
  `BRAIN_DAILY_RECEIPT_MUTANT`, FF after the loader. The authoritative mutant
  restores both reader and writer adoption so it reaches the actual stale
  schedule cases; it does not merely fail the new writer guard.
- `test/fixtures/rename-retry-writer-mutant.mjs`, selector
  `BRAIN_RENAME_WRITER_MUTANT`, then
  `--test --test-name-pattern='workspace staging observation|technician skill commit staging name' test/rename-retry-config.test.mjs test/rename-retry-windows.test.mjs`.
- `test/fixtures/credential-cleanup-mutant.mjs`, no selector, then K.
- `test/fixtures/acl-predecessor-mutant.mjs`, no selector, then AK.
- `test/fixtures/domain-save-mutant.mjs`, no selector, then X.

Each loader goes after the network import and before `--test`. Remove any
environment selector after its run.

| Mutant | Times and exact counts | Kill evidence |
| --- | --- | --- |
| resume_fenceless_authoritatively | 21:54:08 8/6/0; 21:59:26 13/11/0; 22:02:43 17/17/0 | All four removed/newer native-schedule cases, fresh ID and daily-run controls |
| discard_fenceless_receipt | 21:54:08 5/9/0; 21:59:26 8/16/0; 22:02:43 9/25/0 | Exact retained predecessor and recovery evidence |
| erase_fenceless_remote_intent | 21:59:26 22/2/0; 22:02:43 32/2/0 | Possible-dispatch preflight and legacy-pause refusals |
| workspace_reread | 21:58:05 10/4/0; 22:04:54 10/4/0 | Injected and native publication read locks |
| workspace_keep_lock | 21:58:10 10/4/0; 22:04:58 10/4/0 | Held baseline/publication must permit later retry |
| workspace_mutex_staging | 21:58:16 12/2/0; 22:05:05 12/2/0 | Only actual native held-file rows expose locked parent directory |
| pid_staging | 21:58:23 13/1/0; 22:05:12 13/1/0 | Skill old-name residue, with empty-directory control |
| rollback_verified_cleanup | 21:52:35 2/2/0; 21:54:19 8/2/0; 21:56:15 8/2/0 | Both verified credentials must avoid rollback |
| restore_acl_predecessor_ctime | 21:55:38 14/5/0; 21:56:16 14/5/0 | All five ACL-protected ctime-only predecessors |
| bypass_deployment_manifest_writer | 21:55:11 8/2/0 | Absent-domain rejection and deployment failure rollback |

Daily logs use `daily-mutant-<name>`, `daily-mutant-final-<name>`, and
`daily-mutant-all-final-<name>` with the common prefix/suffix. Writer logs use
`writer-mutant-<name>` and `writer-mutant-final-<name>`. Credential logs are `credential-cleanup-mutant`,
`credential-cleanup-mutant-final`, `credentials-cleanup-mutant`,
`acl-predecessor-mutant`, and `credentials-acl-mutant`. Domain log is
`domain-mutant`.

## Verification limits and handoff

The required launch-count test stops at `preserved_unsafe_existing_file` before
measuring launches under this sandbox identity. No new native production
subprocess was added, but source review does not replace the operator's
normal-identity launch-count rerun. Native Windows staging and workspace
FileShare.None tests did execute here. POSIX chmod execution remains a POSIX
host gate. The helper's other existing skip is Windows symlink creation EPERM.

The 21:58:37 guarded `%TEMP%/win-r5-acl-handle-probe.mjs` investigated delayed
ctime with no retained handle, a prior read handle, a prior write handle and
a later read handle. It printed only booleans (true/true/false/true), exited 0,
and removed its temporary directory. It is diagnostic evidence, not a test
count or the regression's proof. The checked-in native test is the proof.

At 22:04:28 a guarded `%TEMP%/win-r5-parse-modules.mjs` parsed all 34 changed
JavaScript modules with `vm.SourceTextModule` without evaluating them; all
passed. `git diff --check` passed. Read-only Git inspection confirms earlier
reports unchanged. No `.tmp-*` directory was present in the repository root.
Some cleanup-refused synthetic directories remain only under `%TEMP%` from
the existing credential/scheduler suites; no new probe left repository debris.

Final required batch: **416/0/3**, comprising helper 160/0/3, Windows 84/0/0,
writers 99/0/0, configuration 71/0/0, and the two chain-check files 2/0/0.
The three helper skips are POSIX chmod on Windows, unsupported Windows symlink
creation, and no delayed ACL ctime observed in that final invocation. The
separate native red/green and native mutant kill above did observe the actual
delayed-change mechanism. All three new suites pass **33/0/0**. The final
receipt focus passes **34/0/0**; all **22 mutants** are killed.

Direct credential runs, the 88 production scheduler failures, the ten
runner/scheduler failures and the stopped launch-count test remain explicit
normal-identity verification limits. They are not represented as passing or
as regressions disproved by a base comparison. The lane's requested behavioral
fixes and synthetic/native regression evidence are ready for operator review.

At 22:06:49 the added-line and new-file scan found no prohibited word, em dash,
literal user-profile path or owner name. Synthetic fixture review found no
instance manifest, real identifier, credential, source content or unrelated
working-tree change. The package allowlist and all version files are unchanged.
All test processes completed by 22:06:48, before the 22:45 cutoff. This report
was completed before 22:10, ahead of the 22:55 handoff deadline.

## Prepared commit

Subject: Preserve staged writes and current daily recovery state

Body: Ignore delayed ACL change time in byte-backed staging proofs while
preserving the existing helper interface. Recover fenceless receipts from
current schedules with exact predecessor custody and retained remote-write
uncertainty. Keep verified credentials after backup cleanup refusal, release
unpublished workspace attempts after held reads, and randomize remaining
staging names. Add native regressions, persistent mutants and the round 5
verification report with sandbox limits.

## Operator verification and review

The lane's work is commit `0428e3e1`, unchanged; its own verdict was READY.
The operator re-ran the checks outside the lane sandbox on the same Windows
host (normal non-elevated user, Developer Mode off), each run in a fresh
profile-shaped fence with the network guard, and ran an independent read-only
review. Times are MST on 2026-10-24; all test runs ended by 22:41.

### The partner's items, verified on this host

- Change time: the credential suites run directly with node now pass 3 of 3
  each (google-auth-storage, admin-key-file, admin-key-rotation; all three
  failed 5 of 5 on round 4). acl-predecessor 9/0/0 and
  credential-backup-cleanup 10/0/0, 3 of 3 each. The native ACL rows ran
  without skipping: "native Windows ACL before baseline delayed change time
  still publishes" passed (3/0/1 for the targeted rows; the skip is the POSIX
  chmod control on Windows). Through the chain harness the same row also ran
  and passed.
- Helper interface: the export lines are identical to round 4. Change time is
  removed only in a private staging comparator; `RENAME_IDENTITY_KEYS`,
  `sameRenameIdentity` and `renameIdentityMatches` still compare it.
- Launch counts measured: create 10, refresh 15, setup of both 21, update of
  both 30.
- Suites: rename-retry 161/0/2, configuration 71/0/0, Windows 84/0/0, writers
  99/0/0, staging names 14/0/0, test-chain runner and complete pass,
  daily-refresh-update-production 133/0/0, daily-refresh-run 55/0/0,
  daily-refresh-scheduler 45/0/0, anthropic-connect 44/0/0, ledger-mcp
  36/0/0, mcp-search-contract 17/0/0, update-pending-refusal 58/0/0.
- 151 suites compared with `ebec973f` by failing test names per suite: 147
  identical, the three new suites pass, and cloudflare-recovery-adapter fails
  with RECOVERY_EXECUTION_SNAPSHOT_CHANGED. That suite fails the same way on
  `ebec973f` 2 of 2 on this host tonight (it passed there at 19:41), so it is a
  host issue outside lane 8; not traced. Suites failing identically on both
  trees: field-prepare 1, older-release-paused-resume 1,
  owner-contract-workspace 3, package-bundle-verifier 15, package-privacy 1,
  quickbooks-desktop-connect 1, technician-setup 1, upgrade-verify 1.
- Mutants, each with `MUTATION_APPLIED` and the guard active, all killed:
  helper (unmutated control 161/0/2) `no_retry` 87/74, `retry_every_error`
  151/10, `unbounded_tries` 131/29, `skip_retry_revalidation` 119/41,
  `remove_platform_gate` 144/16, `skip_byte_proof` 144/16,
  `path_only_cleanup` 158/2, `drop_ctime` 158/2,
  `skip_sync_byte_proof_call` 132/28, `skip_async_byte_proof_call` 132/28,
  `oversized_proof_read` 141/19, `restore_staging_ctime` 159/1 and 1/2 on the
  native rows; daily (control 34/0) `resume_fenceless_authoritatively` 17/17,
  `discard_fenceless_receipt` 9/25, `erase_fenceless_remote_intent` 32/2;
  writer (control 14/0) `workspace_reread` 10/4, `workspace_keep_lock` 10/4,
  `workspace_mutex_staging` 12/2, `pid_staging` 13/1; credential cleanup 8/2;
  ACL predecessor 14/5; domain save (control 10/0) 8/2.
- `git diff --check` clean; names, secrets, email and user-path scan clean on
  every added line and new file; no `.tmp-*` folders left in the repository
  root. The round 2, 3 and 4 reports are unchanged.

### Review (read-only: three area reviewers, one refuter)

Confirmed by the refuter:

1. P2, from this round's credential cleanup change: `brain.mjs:3716-3727`
   (cause `operations/admin-key-file.mjs:911`, `:922-926`). When the backup
   cleanup fails after the new admin key is verified, `brain secrets` catches
   the new "verified and remains stored" error with a bare catch and tells the
   owner the remote key was not changed because the local file could not be
   updated. In fact the local key is the new verified key and the Worker still
   has the old one, so local calls get 401 until the owner reruns the command.
2. P2, from the same change: `connectors/google-auth.mjs:954-970` (callers
   `connectors/imap.mjs:118-125`, `connectors/provider-oauth.mjs:724`,
   `brain.mjs:20637`) and `operations/admin-key-file.mjs:911-926`. After a
   blocked backup cleanup, the protected backup of a removed or superseded
   credential stays on disk with no sweeper, and a retried disconnect reports
   that nothing was stored.
3. P2, macOS: `brain.mjs:31148-31169`, `:31376-31383` with
   `operations/brain-lifecycle-lock.mjs:166` and
   `operations/daily-refresh-scheduler.mjs:627`, `:864`, `:910`. The macOS
   fence lives under /tmp, so an interrupted update's real receipt can become
   fenceless after a reboot. Round 5 then snapshots the update's own pause as
   the current schedule, a later preflight refusal restores that pause, and the
   receipt is deleted without archive, so the owner's daily and legacy
   schedules stay off with no message. Not reproducible on this Windows host;
   whether macOS clears /tmp at boot on the target version is unverified.
4. P3: the native ACL row skips itself when no drift is observed, so a green
   run on a host without drift does not prove native coverage
   (`test/rename-retry.test.mjs:226-285`). It ran and passed on this host.
5. P3: if receipt cleanup fails after this process cleared the fence, the
   recovery write is refused and a completed update ends with a bare "the
   daily update transaction receipt is unsafe"
   (`operations/daily-refresh-scheduler.mjs:706-712`, `brain.mjs:31343-31356`).

Operator verdict: not ready. Every item the partner listed for round 5 is done
and verified on this host. Two new P2s come from this round's credential
cleanup change (a misleading `brain secrets` message with mismatched keys, and
an unswept protected backup), and one is a macOS fence-location P2.

LANE WIN-RENAME-RETRY-5: NOT READY the partner's round 5 items are done and verified on this host; review found new P2s in the credential cleanup path (brain secrets misreports a verified local key; unswept protected backup) and a macOS fence-loss path
