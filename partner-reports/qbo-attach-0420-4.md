# QBO-ATTACH-0420-4

## Result

NOT READY: the Windows checkpoint replacement failure is reproduced, but its
blocking handle or filesystem cause and the lane/base difference remain
unproven. No product fix or retry loop is proposed.

The eight final plain repeats passed five times and failed three times. All
three failures showed `EPERM` at checkpoint rename. M1 passed 56/56 and B1/M2
passed 52/52, including 172 internal connector checks.

The first final policy repeat exposed the previously hidden sequence:
the initial scanner-migration child failed with `EPERM/rename` before printing
review or approval; its subsequent child reached review and printed approval.
The resulting assertion was the policy/scanner-upgrade baseline assertion.
That occurrence was an earlier persistence failure, not evidence that the
subsequent review diluted its denominator.

The only behavioral change is to test diagnostics. Both reset/baseline
assertions retain all their conditions and now summarize the initial and retry
children separately, without copying raw output or state. The old macOS issue
is closed as the operator's checkout setup issue and was not investigated.

## Scope and safety

Read the round 3 report including its operator note, repository instructions,
README, developer guide and architecture documentation. Compared the lane
against `f8a7cd05` with read-only Git commands. No tests or writes ran in the
read-only base checkout. All fixture activity was synthetic and offline.

No network, dependency installation, live account, credential ceremony, full
test chain, Git metadata write, commit or push was performed. Every ad-hoc
Node probe and mutation command included
`--import file:///C:/offload/lanes-1023/no-network.mjs`. The native probe's Node
children received only an explicit environment allowlist. Focused tests used
their closed fixture routes. Work took place before the Saturday rehearsal
pause window. Product version remains 0.4.19.

Scratch probes and logs are under `%TEMP%\qbo-round4-*`; the locator is
`%TEMP%\qbo-round4-log-root.txt`. No scratch checkout was created. Earlier
reports are unchanged. These scratch artifacts are not product files.

## Suspect A: linked or redirected paths

PowerShell inspected `ReparsePoint` attributes with `Get-Item -Force` for
every ancestor and `Get-ChildItem -Force -Recurse` for descendants, recording
enumeration errors rather than treating them as empty directories.

| Scope | Observation |
| --- | --- |
| Initial checkout snapshot, including Git metadata | 210 directories, 1,774 files; zero reparse points. |
| Installed dependencies, included above | 28 directories, 230 files; zero reparse points. |
| Every checkout, Node executable, TEMP and TMP ancestor through the volume root | Plain paths. TEMP equals TMP; TMPDIR is unset. The volume is local with no redirected display root. |
| Initial retained policy fixture snapshot | 54 roots, 233 visible directories, 234 files, 54 checkpoint files; zero visible reparse points or read-only checkpoints. |
| Old retained directory limitation | 50 support directory interiors and one lifecycle directory interior denied enumeration. Their own metadata was readable and plain. Their descendants remain unexamined. |
| Fresh paths during the observed policy run | Nine samples over 40.7 seconds: four recent roots, 37 directories, 34 files, four checkpoints and 12 lifecycle entries; no reparse points, read-only checkpoints or unreadable paths. |
| In-process observer on the eight dilution-flow children | Each checked seven checkpoint-parent/ancestor entries; zero links and zero path-check errors. |
| Separate complete pass with inspection for every CLI child | 63 children; 1,532 metadata observations of checkpoint-root trees and ancestors, including lease directories while saving and each fixture tree at child exit; zero links or inspection errors. Counts include repeated paths across children. |

`runCase()` creates each temporary root with `mkdtempSync` and immediately
canonicalizes it with `realpathSync.native`. The checkpoint, isolated user root,
credential directory, source lease and lifecycle lease are descendants of
that root. This rules out links on the inspected paths, including recently
created fixture paths sampled while the policy run was active. Sampling is
not a census of every temporary root. It does not certify inaccessible old
fixture descendants or prove the absence of a filesystem filter driver.

## Suspect B: checkpoint handles and write ordering

| Boundary | Evidence |
| --- | --- |
| `ingest/run.mjs:2126` | Unchanged from base: path-based synchronous `writeFileSync` of a temporary sibling, `renameSync` to the state path, then `chmodSync(0o600)`. No retained descriptor, stream or watcher. A failed replacement removes its temporary sibling and throws. |
| `loadState()` and `readGmailCheckpointState()` | Synchronous path-based reads. No retained handle. |
| Attachment backfill and cleanup review | Neither module imports filesystem APIs. Both use the injected synchronous save callback. Checkpoint and review receipts are fields in the same adjacent JSON file, not separate open files. |
| Source and lifecycle leases | Separate owner records. Synchronous reads/writes/heartbeat updates. Release clears heartbeat intervals in `finally`; the Windows source lease does not retain a directory descriptor. |
| Removal runtime binding | Synchronously reads package and dependency files, never the ingest checkpoint. |
| Test parent and child | `spawnSync` returns and termination checks pass before the parent reads/edits state, starts the next child or removes the fixture directory. No overlapping parent checkpoint access. |
| Extractor children | The policy fixture contains body-only mail; PDF extraction children are not reached. Attachment bytes otherwise remain in memory. |

The lane's reset addition only retains the attachment checkpoint in the new
in-memory state. The apply-command addition chooses the independent review
and supplies the same lease-checked state writer. Within backfill, persistence
occurs on checkpoint initialization/rebinding, stale-intent replacement,
enumeration completion, expired-token reset, page retention before raw reads,
accepted revision plus cleanup intent, candidate retirement and error status.
Review persistence occurs on remembered families, plan preview/apply through
the shared review engine, and empty-review settlement. None starts a stream,
watcher or background state writer; dry runs bypass those saves.

No source-owned leaked state handle or pending write stream was found. The
mode `0o600` includes owner write permission; inspected checkpoints were not
read-only. This code audit does not rule out an external process, filter
driver or OS-level pending handle at the instant of failure. Native process
parentage inspection through CIM was denied by the sandbox. Process presence
alone cannot attribute checkpoint ownership, and no such attribution is made.

A guarded native probe used the unchanged real `saveState()` with a synthetic
checkpoint in the scratch directory. PowerShell held a .NET `FileStream` on
the destination while an allowlisted Node child attempted replacement:

| Probe | Result |
| --- | --- |
| Destination held with `FileShare.Read` | `EPERM`, syscall `rename`; prior JSON preserved; zero temporary residue. |
| Handle disposed, same writer/path | Replacement succeeded; new JSON read back; zero residue. |
| Destination held with `ReadWrite | Delete` sharing | This host/runtime still returned `EPERM/rename`; the destination remained readable and zero residue remained. This was not a passing control. |
| Second handle disposed, same writer/path | Replacement succeeded again; new JSON read back; zero residue. |

This establishes an open-handle reproduction and closed-handle controls. It
does not establish that the intermittent suite failure had that same holder.
No sleep, automatic retry, permission change or unlink-before-rename was added.

## Lane/base difference and the failing flow

The state writer, removal baseline logic, exact approval checks and source
lease implementation are unchanged from `f8a7cd05`. The new attachment
backfill runs only after source removal review completes. The failing full
sweeps stop at `brain.mjs:18841`, before backfill, so its added saves cannot
directly explain these stopped runs.

The scanner-migration/removal flow writes in this order:

1. Retain scanner progress and save it.
2. Read the stored-source inventory, preserve the minimum valid reviewed
   denominator and save that baseline.
3. For each accepted batch, save sender bookkeeping, then accepted revisions,
   scanner progress and pending replacement families.
4. Preview removals, bind the runtime, save the exact removal plan, then stop
   for explicit approval. The plan is saved before approval is printed.

Repeated reset reprocesses all 901 synthetic new messages while retaining
the reviewed baseline. An ordinary retry resumes accepted revisions and
performs fewer replacements. A successful observed suite counted 41
write/rename/chmod triplets for each initial or reset dilution sweep, versus
three for an ordinary stopped-review retry. The two reset sweeps wrote about
8.62 MB each; the other initial sweeps wrote about 8.82 MB each. Largest state
files were approximately 577 KB and 582 KB respectively. The observer did not
retry or change a filesystem result and reported no failed operation in that
run.

The lane adds the 19-byte `gmail-extraction-2:` prefix to accepted revisions
in `done`, scanner progress and pending-family hashes, about 51,357 bytes for
three copies across 901 messages. It also adds extraction/scanning work and
envelope metadata. Those are concrete size/timing changes before refusal;
there is no additional lane save site before this review stop. The fixture's
native credential/ACL substitutions came later and cannot explain failures
already observed in round 1.

Final repeat 8 also failed at rename in the small `since-safe-sweep` fixture,
before its zero-removal control completed. The symptom is therefore not
confined to the 901-message dilution/reset workload. The lane's current-revision
guard also re-reads this fixture's legacy accepted revision where base can
resume it, changing which existing save paths execute. Neither that change
nor larger checkpoint bytes prove the cause of the Windows refusal.
In the later observed pass, this same small fixture made nine replacements,
wrote 6,083 bytes in total and had a largest checkpoint of only 977 bytes.

The operator's 9 failures in 26 lane runs versus 6 passes in 6 base runs
remain relevant correlation. This round does not prove why the lane triggers
the failure more often. The same writer exists on base. A native trace at a
failure, or a controlled comparison isolating one size/timing change, is
still needed. A retry would currently mask an unclassified failure and has
not been justified.

## Diagnostic change, red test and mutant

The two existing assertions printed only the retry output/state even when
their initial child had failed before review. The new fixture helper emits
closed first/retry summaries: bounded exit status, review/approval observed
flags and an enumerated filesystem code/operation. It emits no paths,
fingerprints, source content, state dump or credentials.

| Invocation | Result |
| --- | --- |
| New diagnostic suite against the extracted former retry-only detail | Red: 1 pass, 3 fail, exit 1, 56.1388 ms; normal review control passed. |
| New diagnostic suite after implementation | Green: 4/4, exit 0, 57.0676 ms. |
| `hide_initial_checkpoint_failure` mutation | Applied and killed: 1 pass, 3 fail, exit 1, 57.2587 ms; normal review control passed. |
| Independent diagnostic-suite verification | 4/4, exit 0, 59.8585 ms. |
| Independent guarded mutant verification | Applied and killed again: 1 pass, 3 fail, exit 1, 63.933 ms; control passed. |

Commands are `node --test test/gmail-policy-diagnostics.test.mjs` and, for
the mutant, the same focused command preceded by the mandatory guard and
`--import ./test/fixtures/gmail-policy-diagnostics-mutant.mjs`. The mutation
removes only the first-stage summary in memory. It is a diagnostic regression
mutant, not a claimed fix or root-cause test for Windows persistence.

## Focused verification

Initial plain policy run: exit 0, all 64 checks, 57,734.8208 ms.
One observer bootstrap attempt exited 1 before running policy checks because
a Windows path was passed to ESM import instead of its file URL. After
correcting the scratch invocation, the guarded observed policy run passed
all 64 checks, exit 0, 53,579.0355 ms. That invocation is separate from the
final plain repeats.

M1 ran once with the exact requested three files:
`test/gmail-attachment-backfill.test.mjs`,
`test/gmail-attachment-pager.test.mjs`,
`test/gmail-attachment-review.test.mjs`.
Result: 56/56, exit 0, 2,647.69 ms.

B1/M2 ran once with the exact requested six files:
`test/gmail-attachments.test.mjs`, `test/gmail-encrypted-pdf.test.mjs`,
`test/gmail-attachment-parts.test.mjs`,
`test/gmail-attachment-resume.test.mjs`,
`test/gmail-attachment-credentials.test.mjs`, `test/google-drive.test.mjs`.
Result: 52/52, exit 0, 1,430.3364 ms, including 172 internal connector checks.

Final repeats use `node --test test/gmail-incremental-policy.test.mjs`,
sequentially, without the observer or any concurrent test suite. No failed
run is discarded or counted as a pass because a later run passes.

| Repeat | Result | Duration |
| --- | --- | --- |
| 1 | Exit 1; 58 checks passed, then policy/scanner-upgrade baseline assertion. Initial child: `EPERM/rename`, no review/approval. Retry child: review/approval observed, no filesystem failure observed. | 52,827.0343 ms |
| 2 | Exit 0; 64/64 checks. | 53,693.7903 ms |
| 3 | Exit 0; 64/64 checks. | 54,355.2042 ms |
| 4 | Exit 1; 54 checks passed, then initial dilution-review assertion. The initial sweep printed 100 loaded and failed at checkpoint rename with `EPERM`, before review. | 40,968.7557 ms |
| 5 | Exit 0; 64/64 checks. | 53,907.339 ms |
| 6 | Exit 0; 64/64 checks. | 52,816.1097 ms |
| 7 | Exit 0; 64/64 checks. | 53,555.5516 ms |
| 8 | Exit 1; 28 checks passed, then the date-floor zero-removal control. The small `since-safe-sweep` run failed at checkpoint rename with `EPERM`. | 5,210.955 ms |

Runtime-bound source stayed unchanged during this entire eight-run series.
Afterward, the new diagnostic suite was registered in both test-runner lists.
The graph-only checker passed 1/1, exit 0, 570.4739 ms; it ran only its tiny
runner fixtures, not the product test chain. All five changed/new JavaScript
files passed guard-loaded syntax checks.

A separate final guarded policy run used `state-observer-all-paths.mjs` from
the scratch directory, passed all 64 checks, exit 0, 52,297.398 ms, and recorded
63 CLI children with 1,532 metadata observations, zero links, zero inspection
errors and zero state-operation failures. It inspected fixture trees before
checkpoint writes and again at child exit without changing filesystem results
or retrying. This observer adds filesystem reads and can change timing; its
pass does not replace any failed plain repeat or establish an unheld handle
at those earlier failures.

`git diff --check` passed. The added-text scan found no prohibited wording,
em dash, literal user-profile path or email address. The change set contains
only the six files listed below; earlier reports and instance material are
unchanged.

## Changed files

- `test/gmail-incremental-policy.test.mjs`: replace only two assertion-detail
  arguments; every existing safety predicate remains intact.
- `test/fixtures/gmail-policy-diagnostics.mjs`: closed first/retry summary.
- `test/gmail-policy-diagnostics.test.mjs`: initial failure, retry failure,
  normal review control and privacy/bounds checks.
- `test/fixtures/gmail-policy-diagnostics-mutant.mjs`: one in-memory mutant.
- `scripts/run-test-chain.mjs`: register the new focused suite in both lists.
- `partner-reports/qbo-attach-0420-4.md`: this investigation and handoff.

No connector, state writer, removal engine, credential, schema, manifest,
dependency or version file was changed in this round.

## Operator handoff

The remaining gate is attribution of the Windows persistence failure and an
explanation of the lane/base difference. If collecting another base comparison,
use a regular dependency copy and capture the same per-operation metadata and
both child stages. A passing base run alone cannot identify the lane cause.
The scratch observer is `state-observer.mjs` and its logs remain under the
scratch directory named above; pass its file URL to Node. It adds the guard to
CLI children and forwards only aggregate state-I/O observations.

All changes remain in the working tree for operator review and commit on
`partner/qbo-attach-0420-4`. Missing commit/push is expected and is not the
readiness reason. No release, cross-host validation or live-source acceptance
is claimed.

## Prepared commit

Subject: Preserve both Gmail policy failure stages in test diagnostics

Body: Add bounded summaries without private data for initial and retry failures
without weakening reset or removal-baseline assertions. Cover the diagnostic
regression with a red-first test and killed mutant. Record Windows path,
handle and checkpoint-write evidence while retaining the unproven persistence
cause as the round 4 blocker.

## Operator note

The Codex sandbox on this Windows machine makes `.git` read-only, so the lane could not commit. The operator (Claude Code) re-ran on the unchanged working tree:

- `test/gmail-policy-diagnostics.test.mjs`: 4/4. With the network guard and `gmail-policy-diagnostics-mutant.mjs`: 1 pass / 3 fail, so the mutant is killed.
- The three M1 suites: 56/56. The six B1/M2 suites: 52/52. `test/test-chain-runner.test.mjs`: 1/1.
- `test/gmail-incremental-policy.test.mjs`, 4 sequential runs: 3 passed, 1 failed. The failure was at "newly ingested mail cannot dilute review of the entire prior Gmail corpus". The new diagnostics showed the cause directly: `EPERM` on the rename of the `.brain-ingest-gmail.json` temporary file into place, inside a `%TEMP%` fixture root.

Operator observation, not a proven cause: Microsoft Defender Antivirus (service WinDefend) and Microsoft Defender for Endpoint (service Sense) are both running on this machine. Real-time scanning briefly opens newly written files, and a rename onto or from a file held that way is refused with `EPERM` on Windows. That would also explain why more and larger checkpoint writes (the lane's case) fail more often than base. The common `graceful-fs` package retries `EPERM` renames on Windows for this reason. The operator did not change any security setting or exclusion, and did not test this hypothesis.

Names, banned-word, email, user-path and key scan of every added line and new file: none. The operator made the prepared commit unchanged. No code was edited by the operator.

LANE QBO-ATTACH-0420-4: NOT READY Windows checkpoint replacement cause and lane/base difference unproven
