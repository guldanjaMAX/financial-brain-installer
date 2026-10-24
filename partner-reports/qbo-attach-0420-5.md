# QBO-ATTACH-0420-5

## Result

READY: the state writer now tolerates bounded transient rename refusals while
preserving its existing refusal and cleanup behavior. All eight sequential
policy repeats passed all 64 checks. The new suites passed 16/16, including
all three native Windows arms, and all three named mutants were killed.
M1 passed 56/56 and B1/M2 passed 52/52, including 172 internal connector checks.
Existing persistence suites and the runner graph check also passed, with one
pre-existing symlink-capability case explicitly skipped on this account.

## Scope and behavior

Read the round 4 report and its operator note first, then the repository
instructions, README, developer guide and architecture documentation. The
working branch is `partner/qbo-attach-0420-5`, starting at `b1bde83`.

The only product behavior change is inside `saveState()` in `ingest/run.mjs`.
It stages JSON once and retries only the rename, only for `EPERM`, `EACCES`
and `EBUSY`. There are at most ten rename calls, with nine 225 ms waits:
2,025 ms of intentional backoff plus filesystem time. A successful attempt
returns through the existing chmod. Every other rename error is refused
immediately. Chmod is never retried. Exhaustion uses the existing temporary
sibling cleanup and rethrows the exact terminal error object, preserving
its code. The prior checkpoint remains intact when rename never succeeds.

The optional injected rename and sleep are synchronous, preserving the
existing persistence-before-progress contract. Defaults use native rename
and `Atomics.wait`. No retry was added outside this writer. No connector,
cursor, removal approval, credential, manifest, dependency or version behavior
was changed. The product version remains 0.4.19.

This is a bounded response to demonstrated Windows sharing refusals. It does
not identify the process responsible for earlier intermittent failures or
prove the suspected antivirus explanation. This round has no live-source,
cross-host or release acceptance claim.

## Changed files

- `ingest/run.mjs:2126`: document synchronous private persistence, add injected
  rename/sleep defaults and the bounded rename-only retry at line 2146.
  Existing chmod and outer cleanup remain at lines 2157 and 2159.
- `test/ingest-state.test.mjs:27`: uncontended and default-dependency controls;
  line 46 covers all three recoverable codes, line 70 exact exhaustion and
  terminal error identity, line 90 final-attempt success, line 106 unrelated
  and uncoded errors, and line 122 chmod isolation.
- `test/ingest-state-windows.test.mjs:38`: hidden native holder with explicit
  environment allowlist and bounded readiness/cleanup. Lines 121, 132 and 163
  cover no contention, delayed release and a persistent hold respectively.
  Non-Windows platforms skip with a stated native-semantics reason.
- `test/fixtures/ingest-state-mutant.mjs:3`: three in-memory mutants with
  unique target checks and explicit application markers.
- `scripts/run-test-chain.mjs:43` and `:666`: register both new suites in both
  test-runner lists without changing the preserved legacy graph.
- `partner-reports/qbo-attach-0420-5.md:1`: this evidence and operator handoff.

## Red then green

The single fix was tested before adding its retry loop. The red implementation
had only the injected rename/sleep seam and retained the prior single-rename
behavior. Tests were not weakened after observing the failures.

| Invocation | Result | Duration |
| --- | --- | --- |
| `node --test test/ingest-state.test.mjs`, before retry | Exit 1; 6 pass, 7 fail. Recovery, ten-try exhaustion and final-attempt success fail; no-contention, default, unrelated-code and chmod controls pass. | 300.5793 ms |
| `node --test --test-reporter=tap test/ingest-state-windows.test.mjs`, before retry | Exit 1; 1 pass, 2 fail. Delayed release cannot recover; persistent hold sees one attempt instead of ten. Native no-contention control passes. | 739.8154 ms |
| `node --test --test-reporter=tap test/ingest-state.test.mjs test/ingest-state-windows.test.mjs`, after retry | Exit 0; 16/16, no skips. | 3,376.6291 ms |

For the native delayed arm, another hidden PowerShell process opens the
destination with `FileShare.Read`, signals readiness, then releases 450 ms
after the first real failed rename is observed. This prevents a false pass
where the handle closes before the writer starts. The green arm completes
in 925.346 ms including process setup and cleanup. The persistent arm holds
until cleanup, observes exactly ten failures, preserves the exact last native
error and prior JSON, and leaves no temporary sibling; it completes in
2,359.2119 ms including setup and cleanup. The no-contention arm makes exactly
one rename. All fixture data is synthetic and local.

Every negative arm has a passing control: each transient code has recovery
coverage, unrelated-code and chmod failures share the one-rename successful
control, and native persistent contention has delayed-release and uncontended
controls. Unit sleeps are injected and record exact ordering and intervals.

## Mutants

Each command sets `BRAIN_STATE_MUTANT` to the listed name, then runs:

```powershell
node --import file:///C:/offload/lanes-1023/no-network.mjs --import ./test/fixtures/ingest-state-mutant.mjs --test --test-reporter=tap test/ingest-state.test.mjs
```

The variable was cleared afterward. Each run printed
`LANE_NETWORK_GUARD_ACTIVE` and its exact `MUTATION_APPLIED` marker, then
failed behavioral assertions. Product source was never mutated on disk.

| Mutant | Applied change and kill evidence | Result | Duration |
| --- | --- | --- | --- |
| `retry_every_error` | Remove the code allowlist. ENOSPC, EIO and uncoded arms observe ten calls instead of one. | Exit 1; 10 pass, 3 fail. | 126.1349 ms |
| `no_backoff` | Remove the sleep call. Recovery/exhaustion event and wait assertions fail. | Exit 1; 6 pass, 7 fail. | 125.5105 ms |
| `unbounded_tries` | Remove the last-attempt guard. Each exhaustion arm detects attempt eleven and fails. A test sentinel stops the mutant without hanging. | Exit 1; 10 pass, 3 fail. | 127.3862 ms |

Both no-contention controls and the chmod control pass under every mutant.

## Final sequential policy repeats

Command for every repeat:
`node --test --test-reporter=tap test/gmail-incremental-policy.test.mjs`.
The eight runs are sequential with no concurrent suite, observer or mutant.
Runtime source remains unchanged throughout. The TAP wrapper counts this
legacy suite as one test; the table separately records its internal checks.

| Repeat | Result | Duration |
| --- | --- | --- |
| 1 | Exit 0; 64/64 checks. | 50,244.3931 ms |
| 2 | Exit 0; 64/64 checks. | 48,653.7381 ms |
| 3 | Exit 0; 64/64 checks. | 49,430.7705 ms |
| 4 | Exit 0; 64/64 checks. | 51,678.5721 ms |
| 5 | Exit 0; 64/64 checks. | 51,049.9598 ms |
| 6 | Exit 0; 64/64 checks. | 49,252.5100 ms |
| 7 | Exit 0; 64/64 checks. | 48,204.5373 ms |
| 8 | Exit 0; 64/64 checks. | 49,323.0591 ms |

## Other focused verification

After the eight policy repeats, the following groups ran once, in this order.
Each command used `node --test --test-reporter=tap` followed by the exact files
listed for that group. No full product chain ran.

| Group | Files and result | Duration |
| --- | --- | --- |
| M1 | `test/gmail-attachment-backfill.test.mjs`, `test/gmail-attachment-pager.test.mjs`, `test/gmail-attachment-review.test.mjs`: exit 0, 56/56, no skips. | 2,638.6767 ms |
| B1/M2 | `test/gmail-attachments.test.mjs`, `test/gmail-encrypted-pdf.test.mjs`, `test/gmail-attachment-parts.test.mjs`, `test/gmail-attachment-resume.test.mjs`, `test/gmail-attachment-credentials.test.mjs`, `test/google-drive.test.mjs`: exit 0, 52/52, no skips, including 172 internal Drive connector checks. | 1,312.0208 ms |
| Existing state coverage | `test/ingest-run.test.mjs`: 97 internal passes and one explicit symlink skip; `test/folder-scheduler.test.mjs`: 42 internal passes; `test/gmail-finalization.test.mjs`: 24 passes. Group exit 0, 26/26 TAP tests. | 2,745.3406 ms |
| Runner registration | `test/test-chain-runner.test.mjs`: exit 0, 1/1; only its small runner fixtures execute. | 609.4345 ms |

The existing ingest suite skipped the linked-target refusal case because
symlink privilege is unavailable on this account. Its checkpoint round-trip,
atomic replacement and temporary-sibling assertions passed. The new native
Windows tests had no skips. The folder scheduler and finalization suites
exercise real checkpoint persistence and resumed progress.

Guard-loaded `node --check` passed for `ingest/run.mjs`,
`test/ingest-state.test.mjs`, `test/ingest-state-windows.test.mjs`,
`test/fixtures/ingest-state-mutant.mjs` and `scripts/run-test-chain.mjs`.
Every invocation printed the guard marker and exited 0. `git diff --check`
passed. Added-text checks found no prohibited wording, em dash, literal
user-profile path or email address. Manual review found only synthetic fixture
identities and no private instance material.

Independent read-only review found no blocking issue in the implementation,
tests, runner registration or report references. No extra tests were run by
the reviewing agents.

## Safety and handoff

No network, dependency installation, real account, real Brain, credential
ceremony, full test chain, Git metadata write, commit or push was performed.
No tests or writes ran in the read-only base checkout. Ad-hoc Node invocations
loaded the mandatory network guard; focused test files used their closed
fixtures. Native helpers receive only an explicit environment allowlist.
All test processes completed before 06:44 MST on 2026-10-24, well before the
14:00 local cutoff.

Logs are under `%TEMP%\qbo-round5-*`, located by
`%TEMP%\qbo-round5-log-root.txt`. No scratch tree was created in the repository.
Earlier reports are unchanged. All changes remain in the working tree for
operator review, focused-test reruns and commit on the current lane branch.

## Prepared commit

Subject: Retry transient checkpoint rename refusals within a bounded window

Body: Keep synchronous checkpoint writes atomic while retrying only EPERM,
EACCES and EBUSY renames up to ten times with short backoff. Preserve immediate
failure for other errors, terminal error identity, temporary cleanup and
single chmod behavior. Add deterministic and native Windows coverage, kill
three retry mutants, and record the round 5 focused regression evidence.

## Operator note

The Codex sandbox on this Windows machine makes `.git` read-only, so the lane could not commit. The operator (Claude Code) re-ran on the unchanged working tree:

- `test/ingest-state.test.mjs` and `test/ingest-state-windows.test.mjs`: 16/16, including the native Windows held-handle arms.
- Mutants with the guard: `retry_every_error` 10 pass / 3 fail, `no_backoff` 6/7, `unbounded_tries` 10/3. All three are killed.
- M1 suites 56/56. B1/M2 suites 52/52. `gmail-policy-diagnostics` plus `test-chain-runner` 5/5.
- `test/gmail-incremental-policy.test.mjs`: 4 of 4 sequential runs passed. Together with the lane's 8, that makes 12 consecutive passes on this machine, against 9 failures in 26 runs on rounds 1 to 3 without the retry.

Names, banned-word, email, user-path and key scan of every added line and new file: none. The operator made the prepared commit unchanged and added the Codex co-author trailer. No code was edited by the operator.

LANE QBO-ATTACH-0420-5: READY
