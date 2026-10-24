# QBO-ATTACH-0420-3

## Result

M1 is implemented. The original three negative requirements and all three
controls are green. The final backfill suite has 21 cases, the pager suite has
8, and the independent cleanup suite has 27. Their final combined run, including
the test-graph checker, passed 57/57. The requested B1/M2 compatibility set
passed 52/52, including all 172 internal Google connector checks.

R0 remains unproven. No product fix for the reported macOS failure is claimed.
A normal Windows policy run and an LF-normalized copy each passed all 64
checks. Final policy repeats passed 3 of 4; the failure was a later reset/removal
baseline assertion, not the original credential-refusal assertion. The nonempty-plan
assertion remains intact. No checkpoint retry shim was added.

All changes remain in the working tree on `partner/qbo-attach-0420-3`. No Git
metadata write, commit, push, installation, full test chain, live account,
credential ceremony, or network request was performed. The read-only base copy
was inspected only. Product version remains 0.4.19; this is proposed work, not
a release or a live deployment.

## M1 behavior and design details

The membership hash retains the historical serialized extraction value `1`.
Extraction version `2` still stamps accepted message revisions. An extraction
upgrade alone therefore keeps the existing history lane live.

After normal history settles under the existing source lease, the runner uses
the eligible-mail query plus
`has:attachment {filename:xlsx filename:xls filename:csv filename:pdf}`.
Production processes at most 100 candidates and 10 provider pages per run.
The existing 2,000-page safety scale also bounds retained token hashes; an
exhausted bound is an explicit incomplete outcome, never completion. Tokens
are stored only in the private adjacent ingest state. No manifest setting was
added. The injected limit exists only for focused tests.

`gmail_attachment_backfill` stores the query, extraction and scanner binding,
pending IDs, next token, enumeration state, token hashes and completion flag.
IDs and the following token are saved before raw reads. Exact acknowledgement
of every split part is required before the accepted revision and candidate
cleanup intent are saved together. Pending IDs retire only after cleanup
settles or a fixed terminal exclusion is recorded. Missing provider/MIME
evidence and incomplete writes remain retryable. Raw reads recheck current
label/date eligibility, including saved candidates whose membership changed.

An expired candidate token restarts only candidate enumeration. Existing
accepted extraction receipts prevent resending already accepted candidates.
Search pagination is not an authoritative snapshot, source-absence proof, or
complete mailbox attachment census. Normal history covers concurrent changes.

Cleanup uses the existing exact preview/apply/readback machinery with a small,
isolated review snapshot. It binds the candidate revision, structural family,
targets, source, manifest, runtime and migration policy. It never requests
the full stored-source inventory. A pending candidate review does not enter
the normal `ingest_removal_plan` or `ingest_pending_families` state and cannot
hold or rewind normal history. Actual D1 mutations still invalidate the remote
inventory marker and require another preview.

The design is extended with a bounded `refresh_ids` recovery list. If normal
history changes an accepted candidate, or the migration binding changes,
validated retained cleanup IDs are queued for a fresh read and preview. The
old approval is invalidated, not reused. Malformed intent is retained and
refused. Interrupted empty-preview settlement also resumes without leaving
an orphaned review receipt. Dry previews validate their checkpoint, report
the candidate send count, and write no state, documents or receipts.

The 140,000-entry synthetic checkpoint produced exactly three raw reads,
three sends and three candidate-family previews. Full mailbox lists and full
stored-source inventory reads were both zero. The body-only revision and
140,000-entry denominator were preserved. This is a work-count probe, not a
live mailbox benchmark.

## Changed files

| File:line | Change |
| --- | --- |
| `connectors/gmail.mjs:30`, `connectors/gmail.mjs:107`, `connectors/gmail.mjs:119`, `connectors/gmail.mjs:204` | Fixed cap, supported candidate query, historical membership hash and strict single-page provider seam. |
| `operations/gmail-attachment-backfill.mjs:20`, `operations/gmail-attachment-backfill.mjs:44` | Validated private checkpoint, capped resumable candidate processing, expiration/requeue recovery and exact acceptance settlement. |
| `operations/gmail-attachment-review.mjs:20`, `operations/gmail-attachment-review.mjs:75` | Retained-intent validation, independent review binding, explicit apply and exact readback. |
| `brain.mjs:12900` | Route an exact candidate approval to its isolated review. |
| `brain.mjs:17321` | Reset retains unfinished attachment work. |
| `brain.mjs:19201`, `brain.mjs:19316` | Inject normal preparation/batching/receipt dependencies and run backfill after history settlement. |
| `brain.mjs:19334`, `brain.mjs:19456` | Incomplete backfill remains visible in status and failures without rewinding history. |
| `test/gmail-attachment-backfill.test.mjs:179` | Original acceptance controls plus cap, scale, retry, malformed-state, approval, interruption and dry-preview coverage. |
| `test/gmail-attachment-pager.test.mjs:20` | Legacy fingerprint and strict provider-page controls. |
| `test/gmail-attachment-review.test.mjs:61` | Exact approval/readback, invalidated bindings, retained overlap and stale-intent recovery controls. |
| `test/fixtures/gmail-attachment-membership-mutant.mjs:1`, `test/fixtures/gmail-attachment-cap-mutant.mjs:1`, `test/fixtures/gmail-attachment-review-mutant.mjs:1` | Three in-memory mutation hooks. |
| `test/fixtures/gmail-attachment-parts.mjs:68`, `test/gmail-attachment-resume.test.mjs:62`, `test/gmail-finalization.test.mjs:80` | Explicit empty candidate pagers for unrelated synthetic history fixtures. |
| `test/gmail-incremental-policy.test.mjs:304`, `test/fixtures/gmail-incremental-policy-fetch.mjs:227` | Restore the legacy hash expectation and explicitly serve empty attachment search for body-only policy fixtures. These are M1 contract updates, not an R0 fix. |
| `scripts/run-test-chain.mjs:39`, `scripts/run-test-chain.mjs:659` | Register all three green M1 suites in both required lists. |
| `README.md:883`, `README.md:920` | Owner description of capped backfill and independent cleanup. |
| `docs/README-developer.md:506`, `docs/README-developer.md:951`, `docs/README-developer.md:958`, `docs/README-developer.md:1155` | Connector, recovery, approval and verification contract. |
| `docs/ARCHITECTURE.md:437` | Membership/extraction separation, private checkpoint and cleanup ownership. |
| `manifest.schema.json:233`, `templates/brain.manifest.json:106`, `onboarding/07-ingest-source-matrix.md:45`, `onboarding/07-ingest-source-matrix.md:131` | Matching capability descriptions without new instance configuration. |

## R0 investigation

| Candidate | Evidence and limit |
| --- | --- |
| CRLF versus LF | `core.autocrlf=true` is present, but `.gitattributes` already pins `brain.mjs` and package JSON files to LF. Fixture mail uses explicit escaped CRLF, independent of source checkout endings. A separate tree normalized 1,086 source/text files to LF and copied installed dependencies as regular files. Its policy suite passed all 64 checks, including credential-refusal. This rules out LF normalization by itself on this Windows/Node runtime, not every native macOS interaction. |
| Runtime file reads, bytes and hashes | `ingestRemovalRuntime()` binds file bytes, sizes, package allowlist, dependency closure and Node version. Its implementation and dependency declarations did not change in round 1. The first nonempty credential-refusal plan is also the first runtime hash call. A missing, linked or unreadable checkout artifact can throw before `state.ingest_removal_plan` is assigned, matching exit 1/no plan. This is a narrowed hypothesis, not evidence that it happened on the other host. Stable line-ending differences change the digest but have no prior digest to compare during first plan creation. |
| Extraction fingerprint forcing a sweep | This explains the real M1 product defect. It does not explain this fixture: `stateFor("credential-refusal")` calculates the current scanner and policy hashes with the same connector module used by the child CLI. Its fixture deliberately rejects a full messages list in that mode. The Windows and LF runs reached and passed the original removal assertion. |
| Path separators and case | The round 1 production diff adds the extraction revision guard and wording in the runner, not path handling. New imports match tracked filename case. State paths and runtime traversal use the existing path helpers. Native case-sensitive-host behavior was not exercised here. |
| POSIX modes | New round 1 files use mode `100644`; no executable/permission-mode change appears in that diff. Credential, lock and checkpoint permission code did not change. Native POSIX custody was not tested in this sandbox. |
| Temporary path realpath | The policy fixture canonicalizes its temporary root with `realpathSync.native`; source-state canonicalization is unchanged from the base. No new `/var` versus `/private/var` branch was introduced. A native macOS reproduction remains unavailable. |
| File ordering | Runtime directory/dependency traversal sorts names, and the fixture constructs deterministic message/inventory arrays. Those paths did not change in the lane. No ordering failure was reproduced. |
| Node version | Runs here use Node v24.18.0. Runtime approval intentionally binds `process.version`, but one fixture invocation uses the same executable for parent and children. No second Node runtime or macOS runtime was available for an independent version comparison. |

The previous diagnostic improvement is retained: exit 1 is not treated as proof
that removal review was reached, and the exact nonempty-plan assertion remains.
No assertion was weakened and no R0 production change was made. The operator
still needs the redacted failing-host output from that boundary to prove the
cause. The known Windows checkpoint replacement issue is reported separately
where observed; it is not used to explain the macOS result.

## Red then green

| Fix or protection | Red evidence | Green evidence and control |
| --- | --- | --- |
| M1 original requirements | Original suite 3/6: legacy hash changed; scale tripwire observed fetch=104, send=50, preview=0; saved candidates never resumed. | Final backfill 21/21. Completed history, ordinary-mail send/preview and dry no-write controls remain. Scale is exactly 3/3/3 with zero full lists/inventories. |
| Strict candidate pager | New pager suite 1/8 before implementation. | 8/8; valid empty/nonempty pages and unchanged membership query accompany corruption/bound tests. |
| Isolated removal review | Corrected shared-state baseline 11/13: history invalidated approval and excluded overlap was silently cleared. | Initial implementation 13/13, final expanded suite 27/27. Exact approved removal and empty preview controls pass. |
| Completed marker and acceptance intent | Expanded backfill 13/15: pending cleanup could hide behind complete; rejected intent left a resumable revision. | Same 15/15 after fixes; empty completed checkpoint and normal candidate acceptance pass. |
| Malformed nested reviews | Selected malformed-review/partial-family/scanner group 2/3. | Combined backfill/review 32/32; clean exhausted checkpoint and preview controls pass. |
| Stale cleanup and dry validation | Selected changed-revision/dry-preview group 0/2. Recovery-helper extension 14/26. | Combined backfill/review 46/46 after requeue and validation; fresh clean candidates and unchanged approval controls pass. |
| Structural selector bounds | Selected unpreviewed-selector test 0/1 for an impossible part/count relation. | Review suite 27/27; valid structural selectors remain accepted. |
| Candidate dry count | Selected dry-run test 0/1: reported zero despite one prepared candidate. | Same selected test 1/1; no-write and completed-checkpoint controls also remain green. |
| Interruption after cleanup readback | Selected interruption test 0/1: subsequent run stranded the leftover receipt. | Same test 1/1; stable later rerun performs no second read/send. |
| R0 | Original other-host failure was not reproduced. | No R0 fix claimed; passing runs do not establish its cause. |

## Every focused test invocation

All commands ran offline on Windows. A count such as 13/15 means 13 passed
and 2 failed. The following sets name exact arguments, not the full test chain:

- `compat-five`: `test/gmail-attachments.test.mjs test/gmail-attachment-resume.test.mjs test/gmail-attachment-parts.test.mjs test/gmail-attachment-credentials.test.mjs test/gmail-finalization.test.mjs`
- `required-six`: `test/gmail-attachments.test.mjs test/gmail-encrypted-pdf.test.mjs test/gmail-attachment-parts.test.mjs test/gmail-attachment-resume.test.mjs test/gmail-attachment-credentials.test.mjs test/google-drive.test.mjs`
- `M1-final`: `test/gmail-attachment-backfill.test.mjs test/gmail-attachment-pager.test.mjs test/gmail-attachment-review.test.mjs test/test-chain-runner.test.mjs`

| Command | Every result in execution order for that command |
| --- | --- |
| `node --test test/gmail-attachment-backfill.test.mjs` | 3/6 baseline red; 4/12 after fingerprint fix with runner absent; 12/12 first implementation; 13/15 expanded red; 15/15 green. |
| `node --test test/gmail-attachment-pager.test.mjs` | 1/8 red; 8/8 green. |
| `node --test test/gmail-attachment-review.test.mjs` | 0/13 initial fixture error from wrong structural suffix; corrected baseline 11/13; implementation 13/13; expanded 14/14; helper red 14/26; helper green 26/26; final selector validation 27/27. |
| `node --test --test-name-pattern='malformed nested\|partial family\|changed scanner' test/gmail-attachment-backfill.test.mjs` | 2/3, malformed nested review failed; other two controls passed. Shell patterns used ordinary regex alternation. |
| `node --test test/gmail-attachment-backfill.test.mjs test/gmail-attachment-review.test.mjs` | 32/32 after nested-review fix; 46/46 after recovery integration. |
| `node --test --test-name-pattern='changed accepted revision\|unfinished dry preview' test/gmail-attachment-backfill.test.mjs` | 0/2 red. |
| `node --test --test-name-pattern='unpreviewed selectors' test/gmail-attachment-review.test.mjs` | 0/1 red. |
| `node --test --test-name-pattern='candidate dry run' test/gmail-attachment-backfill.test.mjs` | 0/1 red; 1/1 green. |
| `node --test --test-name-pattern='interruption after empty' test/gmail-attachment-backfill.test.mjs` | 0/1 red; 1/1 green. |
| `node --test <compat-five>` | Before empty-pager fixture seams: exit 1, missing candidate boundary; the retained tool output truncated the aggregate count. After fixture seams: 70/71, all 47 attachment cases passed; finalization's shared-backoff reset control saw 1 group instead of 3. Its earlier count assertion masked the later error assertion, so no cause is claimed. |
| `node --test test/gmail-finalization.test.mjs` | Isolated unchanged-source run 24/24, 671.336 ms. No retry shim. |
| `node --test test/test-chain-runner.test.mjs` | 1/1, exit 0, 590.7 ms. This checks the graph without executing it. |
| `node --test <required-six>` | Final 52/52, exit 0, 1,439.698 ms; Google connector script reports 172/172 internal checks. |
| `node --test <M1-final>` | Final 57/57, exit 0, 2,474.854 ms. |

Policy suite command is always
`node --test test/gmail-incremental-policy.test.mjs`:

| Invocation | Result |
| --- | --- |
| Initial current-tree attempt | Exit 1 after three checks because the round 2 expectation required a changed hash. M1 restores the historical hash, so the expectation was updated back to exact equality. |
| Current-tree diagnostic run | Exit 0, 64/64, 55,855.056 ms. |
| LF-normalized scratch copy | Exit 0, 64/64, 42,811.618 ms. Dependencies were regular copies, not junctions that runtime validation would reject. |
| Final unchanged-source repeat 1 | Exit 0, 64/64, 42,040.051 ms. |
| Final unchanged-source repeat 2 | Exit 1, 57 checks passed before `repeating --reset cannot discard Gmail's reviewed denominator or bypass exact approval` at line 859; 37,486.456 ms. Original credential-refusal case passed. No `EPERM` appeared in retained output; the assertion prints only the later reset's output/state, so the earlier reset's failure cause is not proved. |
| Final unchanged-source repeat 3 | Exit 0, 64/64, 40,570.922 ms. |
| Final unchanged-source repeat 4 | Exit 0, 64/64, 40,936.019 ms. |

These four final repeats ran sequentially with product source frozen and no
other focused test suite running. No failed result was discarded or retried
through a shim. Their result is three passes and one failure, not four clean
passes. The separate LF pass does not replace a failed final repeat.

## Three named mutants

Each hook requires one exact replacement and prints `MUTATION_APPLIED`.
No reviewed source file is edited by these runs. All mutant commands load
`--import file:///C:/offload/lanes-1023/no-network.mjs` and print
`LANE_NETWORK_GUARD_ACTIVE` before the hook and focused test.

1. `extraction_forces_membership_sweep` replaces the fixed historical extraction
   field with the current extraction version. An initial equivalent in-memory
   data-URL hook and the durable
   `--import ./test/fixtures/gmail-attachment-membership-mutant.mjs --test test/gmail-attachment-pager.test.mjs`
   each exited 1 with 7 passed/1 failed. The legacy hash test kills it; all pager
   controls pass.
2. `ignore_saved_candidate_cap` drains saved pending IDs beyond the run cap.
   `--import ./test/fixtures/gmail-attachment-cap-mutant.mjs --test test/gmail-attachment-backfill.test.mjs`
   exited 1 with 17 passed/1 failed at the 18-case stage. The cap-one resume
   assertion sees two sends; scale and normal-history controls pass.
3. `omit_candidate_receipt_binding` removes the outer accepted-revision and skip
   checks. `--import ./test/fixtures/gmail-attachment-review-mutant.mjs --test test/gmail-attachment-review.test.mjs`
   ran three times: 11 passed/2 failed, then 12 passed/2 failed, then final
   25 passed/2 failed. Changed candidate revision and skip evidence kill it;
   exact approval and ordinary-history controls pass.

## Static checks, scratch state and handoff

Guard-loaded syntax checks passed for all 16 changed/new JavaScript files,
including the production modules and dispatcher, test graph, tests and mutant
hooks. Both edited JSON files parsed. The added-text wording scan passed for
the prohibited name/word and em dash. `git diff --check` passed throughout;
Git emitted only normal checkout line-ending notices.

The LF experiment created `.r0-lf/` inside this working copy. Its source files
and installed dependencies are synthetic/repository copies; it contains no
real account material. It must not be staged or packaged. Cleanup did not
complete: automatic approval review rejected both native PowerShell removal
attempts with `blocked by policy`, including the explicit absolute target
after its resolved workspace path was verified. No permission bypass or
alternative deletion tool was used. The operator must remove `.r0-lf/`.

No other scratch folder was created by this round. Test-owned temporary
fixtures used their existing cleanup paths. Round 1 and round 2 reports were
left unchanged. No release, cross-host CI, real mailbox, or live Brain acceptance
is claimed. The missing commit is expected under the run instructions and is
not a readiness reason.

## Prepared commit

Subject: Cap Gmail attachment backfill independently of normal history

Body: Preserve the historical membership fingerprint and add a resumable
supported-attachment candidate search. Keep exact replacement approval in an
independent checkpoint with stale-intent recovery. Add bounded scale, retry,
dry-run and mutation evidence. Retain the unproven cross-host regression as an
explicit blocker.

## Operator note

The Codex sandbox on this Windows machine makes `.git` read-only, so the lane could not commit. The operator (Claude Code) did the following:

- Removed `.r0-lf/` after checking it held only a plain copy of the tree and of `node_modules`, with no junctions or links. The repo's own `node_modules` was unchanged. That cleanup was the second NOT READY reason, so the last line now names R0 only. The lane's verdict is otherwise unchanged.
- Checked the lane log for network use. Every ad-hoc node command loaded `no-network.mjs`, and the guard blocked no request. No non-local host appears in a command.
- Re-ran on the unchanged working tree: `M1-final` 57/57; `required-six` 52/52; `test/gmail-finalization.test.mjs` alone 24/24; `compat-five` combined 71/71 (the lane once saw 70/71 here). Mutants with the guard: `gmail-attachment-membership-mutant` 7 pass / 1 fail, `gmail-attachment-cap-mutant` 20/1, `gmail-attachment-review-mutant` 25/2. All three are applied and killed.
- `node --test test/gmail-incremental-policy.test.mjs`: 4 runs, 2 passed and 2 failed. One failed at "a policy or scanner upgrade cannot dilute a stopped Gmail removal baseline", one at "repeating --reset cannot discard Gmail's reviewed denominator or bypass exact approval".
- The same suite on the base f8a7cd05 checkout on this machine: 4 of 4 passed (6 of 6 including two earlier runs).
- Across rounds 1 to 3, the lane branches failed this suite in 9 of 26 runs on this machine. Every failure was in a removal-baseline or reset-approval check, or a checkpoint `EPERM`. This is a small sample, but it points to a lane-linked failure that also shows up on Windows, intermittently. It may share a cause with the deterministic failure on the other host.
- Names, banned-word, email, user-path and key scan of every added line and new file: none.

The operator made the prepared commit unchanged. No code was edited by the operator.

LANE QBO-ATTACH-0420-3: NOT READY R0 root cause unproven
