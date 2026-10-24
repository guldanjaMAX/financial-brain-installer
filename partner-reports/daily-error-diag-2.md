# DAILY-ERROR-DIAG-2

Branch: `partner/daily-error-diag-2`. Starting commit: `730979d`.
Validation host: Windows, Node `v24.18.0`, 2026-10-23.

## Result and scope

All three review fixes are complete. The final five focused suites pass
**100 tests, 0 failures**. Three named in-memory mutants are killed, including
the required first-entry-only aggregate selection mutant. Every negative
diagnostic fixture also runs a later clean source and verifies its completion.

Only synthetic fixtures and temporary local homes were used. No network,
account, credential lookup, dependency installation, full test chain, release,
Git mutation or push was performed. Changes remain in the working tree for
the operator. The round 1 report is unchanged.

## Changes

| Location | Change |
| --- | --- |
| `scripts/run-test-chain.mjs:109`, `scripts/run-test-chain.mjs:362` | Register both diagnostic suites in `POST_LAUNCHER_TEST_COMMANDS` and `TEST_COMMANDS`. |
| `test/test-chain-runner.test.mjs:208` | Assert each suite occurs exactly once in each list, with an existing daily runner registration as the passing control. |
| `operations/daily-refresh-run.mjs:70`, `operations/daily-refresh-run.mjs:96` | Select the highest-priority recognized aggregate stop instead of falling back to the first unknown error. Document priority and stable ties. |
| `operations/daily-refresh-run.mjs:155` | Redact authority-bearing `file://` URLs as well as local file URLs. |
| `operations/daily-refresh-run.mjs:157` | Preserve a spaced slash in ordinary prose. |
| `operations/daily-refresh-run.mjs:158` | Redact bare relative file paths with slash or backslash separators, space-containing intermediate directories, dotted directories, and sentence-ending punctuation. |
| `test/daily-error-diag.test.mjs:150`, `test/daily-error-diag.test.mjs:161` | Unknown-then-network and unknown-then-lock regressions, including all three recognized lock codes. |
| `test/daily-error-diag.test.mjs:174`, `test/daily-error-diag.test.mjs:195` | Exercise each adjacent priority pair in both orders and retain the first detail for equal priorities. |
| `test/daily-error-diag.test.mjs:205`, `test/daily-error-diag.test.mjs:227`, `test/daily-error-diag.test.mjs:243` | Receipt and `daily.log` privacy regressions plus exact safe-prose controls for `and/or`, `read/write`, `success/failure`, a spaced slash, and prose containing a Markdown filename. |
| `test/fixtures/daily-error-diag-mutant.mjs:11` | Add registration-removal and first-entry-only mutants. Require exact target counts and normalize line endings in memory for reproducible Windows imports. Reuse the existing raw-detail mutant. |
| `docs/README-developer.md:1429`, `docs/README-developer.md:1437` | Document path recognition and fixed aggregate priority. |
| `CHANGELOG.md:13` | Explain visible recognized stops, path redaction, readable prose and what the owner should verify. |
| `partner-reports/daily-error-diag-2.md:1` | Record this round's implementation, focused validation, mutants and prepared commit. |

## Fixed priority

Removal approval > other safety review > held lock > network failure > other
recognized issue > `UNKNOWN`. Equal priorities retain the first source entry.

Approval and safety decisions need attention before a retry. Lock contention
comes before transport recovery because another operation may still own the
source. A network failure gives a specific retry action. Other recognized
issues still outrank an unknown message. The previous safety-first behavior is
preserved and made deterministic between removal approval and other reviews.
The same order and rationale appear in the code comment.

The change ranks direct aggregate entries. Existing bounded, cycle-aware
traversal of the selected cause chain remains in place. The persisted diagnostic
still contains only a failure count and one bounded reason, never raw errors.

## Red then green evidence

1. **Test-chain registration:** new exact-once checks failed for both missing
   suites while the existing daily runner control passed: 1 pass, 2 failures.
   Registering both suites in both lists made the same command pass 3/3.
   The focused completeness checker also proved all 453 tracked or new candidate
   test files are registered. It inspects the graph without running the chain.
2. **Path privacy and prose:** the first targeted diagnostic run failed bare
   forward-slash paths, bare backslash paths and authority-bearing file URLs.
   The new prose control also exposed an existing over-redaction of a spaced
   slash. The same selection became green after correction, with explicit
   receipt and `daily.log` assertions and exact preservation of readable prose.
   Review then added a final-period case, dotted intermediate directories and
   prose mentioning a Markdown filename. The first review run was 4 passes,
   2 failures. Strengthening the dotted-directory fixture to expose a leaked
   middle word produced 3 passes, 3 failures. The refined matcher made all 6
   selected tests pass. The clean source control passed in every run.
3. **Aggregate priority:** unknown-then-network and unknown-then-lock returned
   `UNKNOWN` before the fix; reversed safety/removal order selected the wrong
   reason. Those three tests failed while clean-source and equal-priority
   controls passed. The initial combined diagnostic selection moved from
   2 passes/7 failures to 9 passes/0 failures. All adjacent priority pairs now
   pass in both orders, and failed sources remain failed without advancing
   freshness. The helper reads back the actual receipt, failure log record and
   status result and checks that the issue/detail agree.

## Every test command run

Counts are passes/failures. Red and killed-mutant runs exit 1; green runs exit 0.
Repeated commands list every observed result. Table escapes before regex pipe
characters are Markdown only; actual command patterns use ordinary pipes.

| Command | Results |
| --- | --- |
| `node --test test/test-chain-runner.test.mjs` | Red 1/2; green 3/0. Existing imperative runner assertions also passed. |
| `node --test test/test-chain-complete.test.mjs` | Green 1/0, with all five internal completeness checks passing. |
| `node --test --test-name-pattern='clean source control\|safe slash prose\|bare relative\|file host URL\|aggregate' test/daily-error-diag.test.mjs` | Red 2/7; green 9/0. |
| `node --test test/daily-error-diag.test.mjs test/daily-load-errors.test.mjs test/daily-refresh-run.test.mjs test/test-chain-runner.test.mjs test/test-chain-complete.test.mjs` | First green 98/0; final green 100/0 after the two additional path cases. Final breakdown: diagnostic 35, loader 6, runner 55, registration 3, completeness 1. |
| `node --test --test-name-pattern='clean source control\|safe slash prose\|bare relative' test/daily-error-diag.test.mjs` | Review red 4/2; stronger dotted-directory fixture red 3/3; green 6/0. |
| With `DAILY_ERROR_DIAG_MUTANT=unregistered_daily_suites`: `node --import ./test/fixtures/daily-error-diag-mutant.mjs --test test/test-chain-runner.test.mjs` | Killed: 1/2. |
| With `DAILY_ERROR_DIAG_MUTANT=raw_detail`: `node --import ./test/fixtures/daily-error-diag-mutant.mjs --test --test-name-pattern='clean source control\|safe slash prose\|bare relative\|file host URL' test/daily-error-diag.test.mjs` | Killed: initial 2/3; final 2/5 after the extra path cases. |
| With `DAILY_ERROR_DIAG_MUTANT=first_aggregate_entry`: `node --import ./test/fixtures/daily-error-diag-mutant.mjs --test --test-name-pattern='clean source control\|aggregate' test/daily-error-diag.test.mjs` | Killed: 2/3. |

`node --check` passed for `scripts/run-test-chain.mjs` and
`test/test-chain-runner.test.mjs` after registration changes, then passed for
both again in final validation. Final syntax checks also passed for
`operations/daily-refresh-run.mjs`, `test/daily-error-diag.test.mjs` and
`test/fixtures/daily-error-diag-mutant.mjs`. `git diff --check` passed after
registration, final code validation and report completion.

## Mutants

Every run emitted `DAILY_DIAG_MUTANT_REACHED:<name>` before behavioral failures.
The hook checks the exact replacement count, so an unreached mutation cannot
count as a kill. Each environment variable was removed in a `finally` block.
Product source files were never rewritten by mutation runs.

| Mutant | Deliberate defect | Proof of kill and control |
| --- | --- | --- |
| `unregistered_daily_suites` | Remove both suites from both command lists in memory. | Both new exact-once checks fail with count 0; the existing-suite control passes. Exit 1, 1 pass/2 failures. |
| `raw_detail` | Return bounded raw detail before redaction. | All five final new path cases fail receipt/log privacy assertions; clean-source and exact safe-prose controls pass. Exit 1, 2 passes/5 failures. |
| `first_aggregate_entry` | Replace preferred aggregate selection with `error.errors[0]`. | Unknown-then-network, unknown-then-lock and fixed-priority tests fail. Clean-source and equal-priority controls pass. Exit 1, 2 passes/3 failures. |

## Limits

These are offline synthetic proofs on Node 24. No native scheduler, live
connector, account, real corpus, full suite or CI field gate was exercised.
Bare relative paths are recognized from a first component without spaces and
a slash-adjacent final filename without spaces and with an extension; spaces
and dots in intermediate directories are supported. This avoids treating
ordinary slash prose followed by a dotted word as a path. Ambiguous extensionless
relative strings and bare filenames containing spaces are outside that new
heuristic. Existing explicitly rooted path redaction remains broader.

## Prepared commit

Subject: `Complete daily diagnostic coverage and stop priority`

Body:

```text
Register both diagnostic suites in the test chain and preserve readable prose
while redacting relative file paths and shared-file URLs. Prefer recognized
aggregate stops using a fixed safety-first order.

Add receipt/log regressions, passing controls, three mutation proofs and the
round 2 handoff report. Focused validation: 100 tests passed.
```

## Operator note

The Codex sandbox on this Windows machine makes `.git` read-only, so the lane could not commit. The operator (Claude Code) re-ran `node --test test/daily-error-diag.test.mjs test/daily-load-errors.test.mjs test/daily-refresh-run.test.mjs test/test-chain-runner.test.mjs test/test-chain-complete.test.mjs` on the unchanged working tree (100 passed, 0 failed) and the three mutants (`unregistered_daily_suites` 1 pass/2 fail, `raw_detail` 2/5, `first_aggregate_entry` 2/3, each reached and killed), scanned the changes for names and banned words (none), and made the prepared commit unchanged. No code was edited by the operator.

LANE DAILY-ERROR-DIAG-2: READY
