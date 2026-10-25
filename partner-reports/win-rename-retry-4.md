# WIN-RENAME-RETRY-4

Starting branch: `partner/win-rename-retry-4`, commit `bdfcb99b`.
The round 3 report, especially its operator review, was read first. All three
P2 findings were verified in source and reproduced before their fixes. This
is held 0.4.20 work, with no release or live-account claim. All changes remain
in the working tree for the operator. No Git metadata write, commit, push,
dependency installation, network request, full test chain or real account was
used. The separate base checkout was read only. Round 2 and round 3 reports
are unchanged.

## Changes and evidence

1. `operations/rename-retry.mjs:62`, `:121`, `:127`, `:171`, `:185`, `:210`:
   private observation distinguishes a positive match, a definite refusal, and
   an open/read error. Only Windows EPERM/EACCES/EBUSY observation errors spend
   retry attempts. Staged publication requires a positive match. A definite mismatch
   or exhausted observation budget calls the existing staged refusal. Ordinary
   rename exhaustion still throws its exact last error. Caller revalidation
   remains outside retry handling, including refusals with retryable codes.
   Baseline capture applies the same rule, pins its first observed identity,
   and privately carries consumed waits into publication. Baseline plus rename
   have at most nine 225 ms waits, not two separate budgets. POSIX has one attempt.
   No product subprocess was added.

   `test/rename-retry.test.mjs:508`, `:611`, `:641`, `:669` cover open/read
   errors, release, exhaustion, mixed proof/rename refusals, platform controls,
   baseline refusal, and the combined budget. Nine native Windows rows exercise
   FileShare.None on the staging file: baseline, synchronous and asynchronous
   publication, each with unchanged, approximately 450 ms release and held
   controls. Held cases observe ten attempts, publish nothing and return the
   caller's exact refusal after backoff. Red was 93/34/1; the first green was
   127/0/1, before later baseline and close-edge additions.

   Independent review found a further edge: a transient read error followed by
   cleanup-close failure must not retry with uncertain descriptor custody.
   `operations/rename-retry.mjs:103` now refuses it. Six paired baseline/sync/
   async cases at `test/rename-retry.test.mjs:780` were 3/3/0 red, then 6/0/0.

2. `operations/answer-setup.mjs:513`, `:616` and `brain.mjs:2878`, `:3214`,
   `:19831`: forward deployment receives the transaction's guarded atomic
   manifest writer. The verified domain save requires the exact prior
   publication and records its replacement immediately through `onPublished`.
   Rollback deployment uses `persistDomain: false`, preserving original domain
   absence. This general writer boundary preserves successful domain persistence
   without adopting whatever another writer left on disk. Its default behavior
   outside this transaction remains the ordinary manifest saver.

   `test/anthropic-connect.test.mjs:571` adds ten actual-filesystem cases through
   the real CLI adapter, domain saver and atomic writer. Domain absent/present
   is crossed with acceptance, Worker rejection, deployment failure after save,
   foreign rewrite after deploy and foreign rewrite before the owned save.
   Successful rollback restores exact manifest bytes, removes the rejected key
   from the Worker fixture and removes the journal. Foreign changes preserve
   recovery state and refuse. Red 5/1/0 became 6/0/0; the expanded full suite is
   44/0/0. The cmdDeploy option forwarding is source-reviewed; provider/deploy/
   Worker boundaries are synthetic, not a live deployment.

3. `operations/daily-refresh-scheduler.mjs:797`: a fully validated receipt
   without a recovery fence now retains its existing immutable object and
   private identity/byte proof. The existing update recovery path carries that
   exact predecessor and recreates its fence on the next transaction write
   under the update lock. Missing fence no longer means receipt absence. No
   public receipt field, schema change or new adoption rule was introduced.

   `test/daily-refresh-update-production.test.mjs:312`, `:337`, `:355` add absent,
   fenced and fenceless cases, each completing two real cmdUpdate runs against
   synthetic deployment/Worker boundaries. Fenced and fenceless content-equal
   replacement receipts are refused and their inode/bytes survive. Red 3/2/0
   became 5/0/0. The new fixtures inject only native ACL restriction while using
   the real lifecycle lock; existing fixtures retain their native ACL behavior.
   The new recovery cases seed paused state with remote mutation intent and an
   installed daily task. Other recovery states retain existing coverage.

4. Requested test and P3 work is complete:
   - `test/rename-retry.test.mjs:441`: caller revalidation checks staging dev/ino
     plus the destination; staged refusal has a distinct error. Removing either
     API's proof call now kills its in-place retry row.
   - `test/rename-retry.test.mjs:114`: frozen injected stats hide an extra 64 KiB
     on disk. The test sums requested read lengths, including EOF, and requires
     at most intended length plus one. The unchanged file is its passing control.
   - `operations/bootstrap-status.mjs:26`, `:451`: an eight-random-byte suffix
     avoids stale per-PID staging collisions while preserving owned cleanup.
     `test/rename-retry-writers.test.mjs:136` proves both empty-directory success
     and success with an untouched legacy residue.
   - `operations/verified-recovery.mjs:1311`: first-create linking refuses a
     null staging proof before publication. Paired cases at
     `test/rename-retry-windows.test.mjs:219` prove refusal and successful create.
     The two P3 pairs were 2/2/0 red, then 4/0/0 green.
   - The three test loaders now inject the baseline platform as well as both
     rename platforms: `test/rename-retry-config.test.mjs:17`,
     `test/rename-retry-writers.test.mjs:15`,
     `test/fixtures/rename-retry-cli.mjs:22`.
   - `test/fixtures/rename-retry-mutant.mjs:19`, `:23`, `:27`, `:48` adds the
     synchronous/asynchronous proof-call removals and oversized requested-read
     mutant, with newline normalization for exact source substitutions.
   - `docs/ARCHITECTURE.md:651`, `:1094`, `:1113`, `:1123` records fenceless
     recovery, observation retries, the combined budget and domain-save custody.

## Helper interface

Every existing export, argument order, option name and return type is unchanged.
The only added export is the explicit injectable baseline retry variant.
`stagedBytesMatch` remains boolean and does not wait. Existing baseline capture
remains synchronous and nullable; it now waits for eligible Windows locks.
The synchronous sleep default was factored into a private function with the
same blocking behavior. No caller must change its existing invocation.

In this table, defaults shown are unchanged unless the row says new.

| Export | Before | After |
| --- | --- | --- |
| `RENAME_IDENTITY_KEYS` | frozen array of dev, ino, nlink, size, mtimeMs, ctimeMs, mode | Same |
| `captureRenameIdentity` | `(path, {lstat=lstatSync, bigint=false}={}) -> Stats or null` | Same |
| `sameRenameIdentity` | `(actual, expected) -> boolean` | Same |
| `renameIdentityMatches` | `(path, expected, {lstat=lstatSync}={}) -> boolean` | Same |
| `stagedBytesMatch` | `(path, expected, bytes, {fs={}}={}) -> boolean` | Same |
| `captureStagedProof` | `(path, bytes, created, {fs={}}={}) -> frozen Stats or null` | Same |
| `removeOwnedStaging` | `(path, created, {proof, bytes=null, fs={}}={}) -> boolean` | Same |
| `renameWithRetrySync` | `(from, to, {revalidate, staged, fs, platform=process.platform, rename=renameSync, sleep=blocking wait}={}) -> rename result` | Same |
| `renameWithRetry` | `(from, to, {revalidate, staged, fs, platform=process.platform, rename=fs-promises rename, sleep=timers-promises delay}={}) -> Promise of rename result` | Same |
| `captureStagedProofWithRetry` | Absent | New: `(path, bytes, created, {fs={}, platform=process.platform, sleep=blocking wait}={}) -> frozen Stats or null` |

Stats can be number or bigint according to the existing creation/identity input.
Production rename returns undefined; injected rename return values still pass
through. The private baseline wait count is held in a WeakMap, not in returned
Stats or serialized receipt fields.

## Execution record

All times are MST on 2026-10-24. Get-Date preceded every run, with a hard cutoff
check for the final batches. Every Node invocation, including probes, syntax
checks and mutation loaders, began with:

`node --import file:///C:/offload/lanes-1023/no-network.mjs`

Counts below are pass/fail/skip. Logs and temporary loaders/probes are under
`%TEMP%`. Node exits 1 for failed suites/mutants and 0 for clean suites. Wrapper
PowerShell exit status alone is not the Node result. No chain command ran;
test-chain-runner executes only its own small synthetic child fixtures.

Suffix aliases after that guard:

| Alias | Exact suffix |
| --- | --- |
| H | `--test test/rename-retry.test.mjs` |
| T | `--test test/rename-retry.test.mjs test/rename-retry-windows.test.mjs test/rename-retry-writers.test.mjs test/rename-retry-config.test.mjs test/test-chain-runner.test.mjs test/test-chain-complete.test.mjs` |
| P | `--test --test-name-pattern='bootstrap staging name\|recovery first creation' test/rename-retry-writers.test.mjs test/rename-retry-windows.test.mjs` |
| A | `--test test/anthropic-connect.test.mjs` |
| AP | `--test --test-name-pattern='domain-save rollback' test/anthropic-connect.test.mjs` |
| D | `--test test/daily-refresh-update-production.test.mjs` |
| DP | `--test --test-name-pattern='production daily receipt' test/daily-refresh-update-production.test.mjs` |
| CP | `--test --test-name-pattern='transient proof read' test/rename-retry.test.mjs` |
| L | `--test --test-name-pattern='R2 Windows native launch counts stay at the pre-change baseline' test/owner-contract-workspace.test.mjs` |

The escaped pipes in Markdown table cells represent literal regex alternation.

| Time | Command | Result | Log filename |
| --- | --- | --- | --- |
| 20:39:05 | P before product edits | RED 2/2/0; both unchanged controls pass | `win-r4-optional-red.log` |
| 20:39:07 | DP initial native ACL fixture | 1/4/0, three ACL/cleanup failures mask test bodies | `win-r4-daily-red.log` |
| 20:39:16 | P after fixes | 4/0/0 | `win-r4-optional-green.log` |
| 20:39:17 | AP before fix | RED 5/1/0, absent-domain rollback fails | `win-r4-answer-red.log` |
| 20:39:20 | `--test test/bootstrap-status.test.mjs test/verified-recovery.test.mjs` | 12/0/1 | `win-r4-optional-regression.log` |
| 20:39:24 | DP with temporary body/cleanup diagnostics | 1/4/0, lock-owner write EPERM identified; diagnostics then removed | `win-r4-daily-red-details.log` |
| 20:39:30 | H before helper fix | RED 93/34/1 | `win-r4-helper-red.log` |
| 20:39:33 | AP after fix | 6/0/0 | `win-r4-answer-green.log` |
| 20:39:36 | DP final isolated fixture before fix | RED 3/2/0; unsafe receipt and missing predecessor proof | `win-r4-daily-red-isolated.log` |
| 20:39:42 | DP after fix | 5/0/0 | `win-r4-daily-green.log` |
| 20:39:48 | D | 16/88/0; all five added cases pass | `win-r4-daily-production-full.log` |
| 20:39:56 | A with expanded ten-case matrix | 44/0/0 | `win-r4-answer-full.log` |
| 20:39:57 | `--test test/daily-refresh-scheduler.test.mjs` | 42/3/0 | `win-r4-daily-scheduler-full.log` |
| 20:40:02 | H after fix, before baseline/close additions | 127/0/1 | `win-r4-helper-green.log` |
| 20:40:13 | `--test test/setup-clean-path.test.mjs test/subdomain-read-names-its-cause.test.mjs` | 3/1/0 | `win-r4-answer-domain-regressions.log` |
| 20:40:27 | AP plus temp domain-save mutant import | KILLED 8/2/0 | `win-r4-answer-mutant.log` |
| 20:40:39 | `%TEMP%/win-r4-daily-platform-probe.mjs` | three asserted probe rows, exit 0; not node:test counts | `win-r4-daily-platform-probe.log` |
| 20:40:50 | DP plus temp fenceless mutant import | KILLED 3/2/0 | `win-r4-daily-mutant.log` |
| 20:41:12 | CP before close-edge fix | RED 3/3/0 | `win-r4-proof-close-red.log` |
| 20:41:18 | CP after close-edge fix | 6/0/0 | `win-r4-proof-close-green.log` |
| 20:41:27 | T before loader count updates | 237/2/1; config/writers module loaders reject the third platform default | `win-r4-required-rename.log` |
| 20:41:38 | L | 0/1/0, initial ownership refusal | `win-r4-launch.log` |
| 20:43:02 | T with top-level loaders updated | 380/3/1; three bundle child rows expose the same stale CLI loader count | `win-r4-required-rename-final.log` |
| 20:43:41 | T with all three loaders updated | 383/0/1 | `win-r4-required-rename-complete.log` |
| 20:44:12 | A after fixture cleanup added | 44/0/0 | `win-r4-answer-final.log` |
| 20:44:13 | D on final product sources | 16/88/0; all five added cases pass | `win-r4-daily-final.log` |
| 20:47:04 | AP plus temp domain-save mutant import, final sources | KILLED 8/2/0 | `win-r4-answer-mutant-final.log` |
| 20:47:05 | DP plus temp fenceless mutant import, final sources | KILLED 3/2/0 | `win-r4-daily-mutant-final.log` |

The final combined suite contains helper 159/0/1, Windows 76/0/0, writers
93/0/0, configuration 53/0/0 and two passing test-chain files. The helper's only
skip is native Windows symlink creation EPERM. No held-handle row is skipped.
The additional regression skip is the existing POSIX-only bootstrap permission
case. The final helper-only control after adding a mutation-hang guard is
159/0/1; that guard changes only the test fixture's excessive-observation exit.

## Mutants

Each completed mutant run printed `MUTATION_APPLIED` and the network guard
marker. Source substitutions affect only that process, never product files.
The checked-in helper fixture is imported with
`--import ./test/fixtures/rename-retry-mutant.mjs` before H, with the named
`BRAIN_RENAME_MUTANT` environment selector removed afterward.

The final complete-helper batch uses no name filter. Logs are
`win-r4-mutant-complete-<name>.log` under %TEMP%.

| Start time | Mutant | Pass/fail/skip | Kill evidence |
| --- | --- | --- | --- |
| 20:44:40 | Unmutated control | 159/0/1 | All native and injected rows pass |
| 20:44:51 | `no_retry` | 85/74/1 | Release and budget controls require retries |
| 20:44:55 | `retry_every_error` | 149/10/1 | Non-retryable proof/rename errors must stop |
| 20:45:05 | `unbounded_tries` | 130/29/1 | Ten-attempt and shared-budget assertions |
| 20:45:17 | `skip_retry_revalidation` | 118/41/1 | Caller proof must run on every attempt |
| 20:45:28 | `remove_platform_gate` | 143/16/1 | POSIX one-attempt controls |
| 20:45:38 | `skip_byte_proof` | 145/14/1 | Frozen-stat, changed-byte controls |
| 20:45:48 | `path_only_cleanup` | 157/2/1 | Replacement inode must survive |
| 20:45:58 | `drop_ctime` | 157/2/1 | Metadata-only drift must refuse |
| 20:46:09 | `skip_sync_byte_proof_call` | 131/28/1 | Sync in-place row reaches distinct staged refusal |
| 20:46:21 | `skip_async_byte_proof_call` | 131/28/1 | Async in-place row reaches distinct staged refusal |
| 20:46:31 | `oversized_proof_read` | 140/19/1 | Requested-read bound fails |

The new proof-call mutants specifically fail their respective
`staging-in-place replacement during backoff refuses` rows. The oversized-read
mutant specifically fails `byte proof bounds requested reads even when frozen
metadata hides a much larger file`. Thus their kills reach the requested gaps.

Two caller mutants add independent regression proof:

- `bypass_deployment_manifest_writer`: `%TEMP%/win-r4-answer-mutant.mjs`
  replaces the awaited injected domain saver with the original in-place saver.
  Import its file URL before AP. It kills absent-domain Worker rejection and
  failure after domain save, with eight passing controls: 8/2/0.
- `discard_fenceless_receipt`: `%TEMP%/win-r4-fenceless-mutant.mjs` reinserts
  `if (manifestPath && !fence) return null;` before the reader's new comment.
  Import its file URL before DP. Both fenceless cases fail; the absent/fenced
  controls pass: 3/2/0.

Earlier complete-helper attempts at 20:41:55 and 20:41:59 used
`--test-name-pattern='^(?!native Windows)'`, which unexpectedly admitted native
rows. They killed no_retry at 85/74/1 and retry_every_error at 149/10/1, logs
`win-r4-mutant-<name>.log`. The 20:42:09 unbounded_tries run was interrupted
without final totals when its synchronous native held row outlived the test
timeout. Its synthetic holder was signalled to release. No kill is claimed
from that incomplete run. A bounded observation assertion was then added to
the native fixture so the same mutant cannot strand the synchronous test.

A complete filtered batch at 20:43:02-07 used
`--test-name-pattern='^(identity proof|byte proof|staged proof|owned cleanup|capture staged proof|change-time-only|injected filesystem|sync:|async:|baseline:)'`
with H. Logs are `win-r4-mutant-final-<name>.log`. Control was 150/0/1.
In table order, the eleven mutants returned 82/68/1, 140/10/1, 124/26/1,
109/41/1, 134/16/1, 136/14/1, 148/2/1, 148/2/1, 125/25/1, 124/26/1,
and 131/19/1. The final unfiltered batch above supersedes these counts.

## Intermittent EPERM investigation

Confirmed platform injection explains why the retry does not engage.
`test/update-pending-refusal.test.mjs:554`, `:568`, `:588` explicitly select
darwin for the plan, native options and daily options.
`brain.mjs:31113` forwards that platform into daily transaction options, and
`operations/daily-refresh-scheduler.mjs:715` forwards it to the retry helper.
The untouched base has the same forwarding. Therefore an occasional Windows
EPERM in this macOS fixture intentionally takes the one-attempt POSIX path.

The guarded temporary probe invokes the actual transaction writer with one
injected EPERM followed by a real rename. Assertions prove darwin: one attempt,
EPERM; linux: one attempt, EPERM; win32: two attempts, success. This identifies
the retry-policy cause, not which native process occasionally holds the receipt.
No change was made to that existing test or platform policy.

## Limits and operator verification

The launch-count test stops at `preserved_unsafe_existing_file` before counts
can be measured in this sandbox. The operator must rerun it outside this
identity; round 3 already measured create 10, refresh 15, setup both 21 and
update both 30. This round adds no native protection or ownership process.

The full daily production suite was run twice and remains 16/88/0 here. Its
existing rows hit native ACL/cleanup and bridge-fixture failures; all added
rows pass. This is not a baseline-equivalence claim. The scheduler's three
failures are the same named sandbox cases documented in round 3: public
all-configured install, reuse of the installed ownership plan, and unavailable
freshness inventory. The domain regression's setup-clean-path case stops at a
migration-intent write under %USERPROFILE%; its three subdomain cases pass.
These full suites require the operator's normal-identity rerun. No production
state or TEST account was touched to work around the sandbox.

Guarded syntax checks passed at 20:40:45 for brain, answer setup and its test;
at 20:40:52 for the daily scheduler and its production test; and at 20:46:21
for all 14 changed JavaScript files. `git diff --check` passed. Read-only Git
comparison confirms both prior reports are unchanged. Added-line plus new-report
scans found no prohibited word, em dash or literal user-profile path. Review of
the changed fixtures found only synthetic data. No instance artifact is added.
All test processes completed at 20:47, and this report was finished before
20:50, ahead of the 22:15 test and 22:30 report deadlines.

## Prepared commit

Subject: Retry staging observation locks and preserve recovery publication proof

Body: Share the bounded Windows retry budget across baseline observation and
publication while preserving existing helper APIs. Keep verified domain saves
inside answer setup rollback custody and recover validated fenceless daily
receipts without adopting another writer's replacement. Randomize bootstrap
staging, refuse unproved recovery links, strengthen native and mutation tests,
and record focused results plus sandbox verification limits.

LANE WIN-RENAME-RETRY-4: READY
