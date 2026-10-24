# DAILY-ERROR-DIAG-3

Branch: `partner/daily-error-diag-3`. Starting commit: `00b49f2`.
Validation host: Windows, Node `v24.18.0`, 2026-10-24.
Final focused tests completed by 06:37 MST, before the 14:00 cutoff.

## Result and scope

All three requested corrections are complete. Final focused validation passed
**108 tests, 0 failures**: diagnostics 47, loader 6, runner 55. Three named
in-memory mutants were reached and killed. Every failing-source fixture also
runs a later clean source and checks its successful completion. The standalone
clean-source and required safe-prose controls remain green.

Only synthetic fixtures and temporary homes under `%TEMP%` were used. No
network, real account, credential lookup, dependency installation, full test
chain, Git mutation, commit or push was performed. Every ad-hoc Node command
and mutation run included the required network guard. No connector or provider
function was called by an ad-hoc probe. Changes remain in the working tree for
the operator. Both prior reports remain unchanged.

## Changes

| Location | Change |
| --- | --- |
| `operations/daily-refresh-run.mjs:87`, `operations/daily-refresh-run.mjs:93` | Walk nested aggregates and causes before ranking stops. Bound traversal by entry count and depth, guard cycles, preserve shared-error leg counts and higher-priority safety wrappers. |
| `operations/daily-refresh-run.mjs:130`, `operations/daily-refresh-run.mjs:186` | Add the conservative bare-relative path rule for a spaced final filename after at least two separators. |
| `operations/daily-refresh-run.mjs:502` | Explicitly mark a truncated diagnostic graph instead of presenting a partial count as exact. |
| `test/daily-error-diag.test.mjs:174`, `test/daily-error-diag.test.mjs:186` | Unknown-first nested network and nested lock regressions, including all three held-lock codes. Receipt, log and status readback use the existing observation helper. |
| `test/daily-error-diag.test.mjs:200`, `test/daily-error-diag.test.mjs:214`, `test/daily-error-diag.test.mjs:226`, `test/daily-error-diag.test.mjs:236`, `test/daily-error-diag.test.mjs:252` | Cover cyclic causes, aggregate causes, safety wrapper priority, deeper transport detail, exact depth and size boundaries, repeated references and shared-leaf counts. |
| `test/daily-error-diag.test.mjs:262`, `test/daily-error-diag.test.mjs:285` | Extend every adjacent priority pair and the equal-priority controls to nested aggregates. |
| `test/daily-error-diag.test.mjs:297`, `test/daily-error-diag.test.mjs:329`, `test/daily-error-diag.test.mjs:352` | Retain exact slash-prose controls and add four spaced-filename cases. Check the full path and both filename fragments are absent from the receipt and daily log. |
| `test/daily-error-diag.test.mjs:311`, `test/daily-error-diag.test.mjs:377`, `test/daily-error-diag.test.mjs:387` | Assemble credential field labels, schemes and values from runtime pieces. Preserve the six original messages and assertions. Add a source-shape regression with runtime positive controls. |
| `test/fixtures/daily-error-diag-mutant.mjs:11`, `test/fixtures/daily-error-diag-mutant.mjs:13`, `test/fixtures/daily-error-diag-mutant.mjs:15` | Retarget the first-entry mutant and add the spaced-filename and missing-flattening mutants. Exact target-count checks remain in place. |
| `docs/README-developer.md:1432`, `docs/README-developer.md:1452` | Document the path boundary, traversal bounds, ordering, count semantics and truncation signal. |
| `CHANGELOG.md:13` | Describe nested failure recognition and spaced filenames in paths with multiple folders, with the existing owner verification step. |
| `partner-reports/daily-error-diag-3.md:1` | Record this round's evidence and prepared commit. |

## Exact path boundary

The new rule accepts a bare relative value with at least two slash or backslash
separators before a spaced final filename. It removes the exact requested
`records/reports/quarterly report.xlsx`, its backslash equivalent, its
sentence-ending-period variant, and a variant with a spaced intermediate
directory. The final filename is removed in full, including both words.

The first component contains Unicode letters or numbers, underscore, dot or
hyphen. Each nonempty intermediate component excludes separators, comma,
semicolon, CR/LF, closing parenthesis/bracket/brace and quote/backtick
delimiters; it may contain spaces. The final component contains letters,
numbers, underscores, dots and hyphens, with one or more spaces or tabs between
its words, then a dot and an extension of 1 to 16 letters or numbers.

The start is the beginning of text or follows whitespace, equals, opening
parenthesis or a quote/backtick. The end is end-of-text, whitespace, comma,
semicolon, closing delimiter or quote/backtick. A final period, exclamation
mark or question mark is accepted only before another end boundary.

The broader rule refuses ambiguous one-separator spaced-basename text, bare
filenames, extensionless final components and final components containing
characters outside that grammar. The existing narrower rule still removes
single-separator relative paths whose final filename has no spaces and has an
extension. This is a conservative heuristic, not a general filesystem parser.
Combined multi-slash prose matching the broader grammar may also be redacted.

The required `and/or`, `read/write`, `success/failure`, spaced slash, and
sentence naming a Markdown file all remain byte-for-byte readable in the
receipt and daily log. Neither safe prose nor path fixtures require a real file.

## Error graph contract

The walk examines **at most 64 entries**, including the root and repeated or
cyclic references, and follows edges through **depth 8**, with the root at
depth 0. Both bounds are stated in the source comment. The entry budget bounds
work even when a large aggregate repeats the same reference. An active-path
set prevents cycles while allowing separate failed legs sharing the same Error
object to count separately.

Depth-first traversal follows aggregate children in source order, then any
aggregate cause. Cause leaves compete using the unchanged fixed priority:
removal approval, other safety review, held lock, network failure, other
recognized issue, then unknown. Aggregate summaries do not outrank their
leaves. A higher-priority non-aggregate wrapper still protects an explicit
safety refusal over a lower-priority cause. Equal-priority causes retain the
deeper detail; equal-priority aggregate branches retain source order.

Counts describe terminal error occurrences reached, including fallbacks at a
cycle boundary. If either traversal budget is exhausted, the persisted detail
starts with `diagnostic graph limit reached` instead of claiming an exact
failure count. Selection beyond that bound is intentionally unproven. The
source stays failed, freshness cannot advance, and later clean work continues.
No new support-journal category or raw-error persistence was added.

## Red then green evidence

1. **Spaced filename privacy:** all four new cases failed before the fix;
   clean-source and slash-prose controls passed. The same selection passed
   after adding the broader path rule. Assertions check receipt and daily-log
   bytes for both full-value and fragment leakage, retain the redaction marker,
   and preserve explanatory prose around the delimited value.
2. **Nested stops and bounded traversal:** unknown-first nested network and
   nested lock both returned `UNKNOWN` before the change. The additional
   cycle/cause, deeper-detail and graph-boundary checks were also red. All six
   graph tests became green with traversal and limit reporting. The final
   suite covers each priority pair in both orders, flat and nested.
3. **Credential fixture source:** the new source-shape check failed against
   the six literal positions, while its runtime positive controls recognized
   constructed positions. Rebuilding labels, schemes and values from separate
   pieces made the source check green. The original redaction and split-value
   behavioral assertions remain unchanged and pass.
4. **Review correction for shared references:** a new test first passed its
   single-error control, then failed the two-leg count because global visited
   deduplication collapsed the shared error. The standalone clean test also
   passed: 1 pass, 1 failure. An active-path cycle guard made the exact same
   command pass 2/2, retaining both bounded work and leg multiplicity.

The initial combined targeted run was **2 passed, 11 failed**. The same
targeted command became **13 passed, 0 failed**. Final combined focused
validation, including the review correction, is **108 passed, 0 failed**.

## Every test command run

Counts are passes/failures. Red and killed-mutant runs exited 1; green runs
exited 0. Backslashes before table pipes are Markdown escaping only; actual
test-name patterns used ordinary regex alternation pipes.

| Command | Every observed result |
| --- | --- |
| `node --test --test-name-pattern='clean source control\|safe slash prose\|spaced filename\|spaced directory and filename\|nested aggregate\|error graph\|credential fixture source' test/daily-error-diag.test.mjs` | Red 2/11; green 13/0. |
| `node --test test/daily-error-diag.test.mjs test/daily-load-errors.test.mjs test/daily-refresh-run.test.mjs` | First green 107/0; final green 108/0 after the shared-reference correction. |
| `node --test --test-name-pattern='clean source control\|shared leaf' test/daily-error-diag.test.mjs` | Red 1/1; green 2/0. |
| With `DAILY_ERROR_DIAG_MUTANT=spaced_filename_boundary_removed`: `node --import file:///C:/offload/lanes-1023/no-network.mjs --import ./test/fixtures/daily-error-diag-mutant.mjs --test --test-name-pattern='clean source control\|safe slash prose\|spaced filename\|spaced directory and filename' test/daily-error-diag.test.mjs` | Killed: 2/4. |
| With `DAILY_ERROR_DIAG_MUTANT=nested_aggregate_not_flattened`: `node --import file:///C:/offload/lanes-1023/no-network.mjs --import ./test/fixtures/daily-error-diag-mutant.mjs --test --test-name-pattern='clean source control\|nested aggregate\|aggregate equal-priority control' test/daily-error-diag.test.mjs` | Killed: 1/3. |
| With `DAILY_ERROR_DIAG_MUTANT=first_aggregate_entry`: `node --import file:///C:/offload/lanes-1023/no-network.mjs --import ./test/fixtures/daily-error-diag-mutant.mjs --test --test-name-pattern='clean source control\|aggregate unknown\|aggregate priority\|aggregate equal-priority control' test/daily-error-diag.test.mjs` | Killed: 2/5. |

Three individual syntax commands passed, each using
`node --import file:///C:/offload/lanes-1023/no-network.mjs --check <file>`:
`operations/daily-refresh-run.mjs`, `test/daily-error-diag.test.mjs`, and
`test/fixtures/daily-error-diag-mutant.mjs`. The guarded Node version probe
reported `v24.18.0`. The syntax commands and probe printed
`LANE_NETWORK_GUARD_ACTIVE`. `git diff --check` passed before and after report
completion. The final added-text scan found no prohibited wording, em dash or
user-profile path. Read-only peer review found no remaining material issue.

## Named mutants and proof

Each mutant printed both `LANE_NETWORK_GUARD_ACTIVE` and
`DAILY_DIAG_MUTANT_REACHED:<name>`. The hook requires exactly one matching target
for each of these mutants. Failures were behavioral assertions, not import or
target-count errors. The environment variable was removed in `finally` after
each run; imported source was changed only in memory.

| Mutant | Defect and kill evidence |
| --- | --- |
| `spaced_filename_boundary_removed` | Deletes only the new spaced-filename rule. All four new path cases fail. Clean-source and exact slash-prose controls pass. Exit 1, 2 passes/4 failures. |
| `nested_aggregate_not_flattened` | Collects immediate aggregate entries without visiting their graph. Nested network and lock return `UNKNOWN`; the nested equal-priority case loses the leaf detail. Clean-source control passes. Exit 1, 1 pass/3 failures. |
| `first_aggregate_entry` | Chooses the first collected stop instead of applying fixed priority. Flat and nested unknown-first network/lock cases fail, as does priority ordering. Clean-source and equal-priority controls pass. Exit 1, 2 passes/5 failures. |

## Limits

This is synthetic offline proof on one Windows Node 24 host. It does not prove
native scheduler execution, live connector recovery, a production refresh,
Node 22 behavior or six-platform CI. No field gate was run. Paths outside the
documented heuristic and error stops outside the bounded graph are not claimed
as covered. Missing commit and push are expected under this run's instructions.

## Prepared commit

Subject: `Close spaced-path and nested daily diagnostic gaps`

Body:

```text
Redact spaced filenames in multi-folder relative paths and rank stops across
bounded, cycle-aware aggregate and cause graphs. Preserve shared-error leg
counts and surface diagnostic traversal limits.

Build credential fixtures from runtime pieces and document the boundaries.
Focused validation: 108 tests passed; three named mutants reached and killed.
Include the round 3 report for operator handoff.
```

## Operator note

The Codex sandbox on this Windows machine makes `.git` read-only, so the lane could not commit. The operator (Claude Code) did the following:

- Re-ran `node --test test/daily-error-diag.test.mjs test/daily-load-errors.test.mjs test/daily-refresh-run.test.mjs test/test-chain-runner.test.mjs test/test-chain-complete.test.mjs` on the unchanged working tree: 112 passed, 0 failed.
- Re-ran the three mutants with the guard: `spaced_filename_boundary_removed` 2 pass / 4 fail, `nested_aggregate_not_flattened` 1/3, `first_aggregate_entry` 2/5. Each was reached and killed.
- Item 4: the round 1 and round 2 commits were recreated with identical trees plus the Codex co-author trailer (730979d became d17b51b, 85d83ca became 00b49f2). This commit builds on them.
- No line in `test/daily-error-diag.test.mjs` holds a literal credential shape. The one bearer-shaped case builds both its label and its value from runtime pieces.
- Names, banned-word, email, user-path and key scan of every added line and new file: none.

The operator made the prepared commit unchanged and added the Codex co-author trailer. No code was edited by the operator.

LANE DAILY-ERROR-DIAG-3: READY
