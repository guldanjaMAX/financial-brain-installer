# DAILY-ERROR-DIAG-4

Branch: `partner/daily-error-diag-4`. Starting commit: `68dd217`.
Validation host: Windows, Node `v24.18.0`, 2026-10-24.
Final focused tests and mutants completed by 07:37 MST, before the 14:00 cutoff.

## Result and scope

Both requested corrections are complete. The five required focused suites
passed **120 tests, 0 failures**: diagnostics 51, loader 10, runner 55, chain
registration 3, and chain completeness 1. The three round 4 named mutants and
all five other inherited mutants were reached and killed with passing controls.

Only synthetic fixtures and temporary homes under `%TEMP%` were used. No
network, real account, credential lookup, dependency installation, full test
chain, Git mutation, commit or push was performed. Every ad-hoc Node command
and mutation run loaded the required network guard. No connector or provider
function was called by an ad-hoc probe. Changes remain in the working tree for
the operator. Prior reports remain unchanged.

## Changes

| Location | Change |
| --- | --- |
| `operations/daily-refresh-run.mjs:667` | The default adapter passes an explicit no-output `log() {}` callback as `cmdLoad`'s `options.log`. This suppresses both raw leg failure lines and the consolidated load report before daily diagnostic redaction. |
| `operations/daily-refresh-run.mjs:130`, `operations/daily-refresh-run.mjs:191` | Extend the existing spaced-filename rule with a bounded one-separator alternative, preserving the multi-folder rule and its mutant target. |
| `test/daily-load-errors.test.mjs:127`, `test/daily-load-errors.test.mjs:149` | Capture every public own console method plus `process.stdout.write` and `process.stderr.write`; restore in `finally`. The capture control exercises every captured method and both streams. |
| `test/daily-load-errors.test.mjs:161` | Replace the previously suppressed default-runner test with real-loader failed, partial and clean cases, a runtime marker, persisted receipt/log readback and in-memory typed-cause assertions. |
| `test/daily-load-errors.test.mjs:236` | Prove an interactive caller still prints both its immediate failure and consolidated report. |
| `test/daily-error-diag.test.mjs:333`, `test/daily-error-diag.test.mjs:368` | Cover slash, backslash, sentence punctuation and end-of-text one-separator paths in both receipt and log, including both filename fragments. |
| `test/fixtures/daily-error-diag-mutant.mjs:5` | Add the output-policy removal mutant with an exact single-target check. |
| `docs/README-developer.md:1432`, `docs/README-developer.md:1449` | Document the path grammar and explicit loader output policy, including their limits. |
| `CHANGELOG.md:13` | Describe the newly covered path example and suppression of the raw daily load failure report, with the existing owner verification step. |
| `partner-reports/daily-error-diag-4.md:1` | Record evidence and the prepared commit for handoff. |

## Output policy and proof

The default daily adapter supplies `options.log` directly in its `cmdLoad`
call, alongside its selected-source flags and existing lifecycle/partial-load
options. Both the loader catch and `renderLoadReport` already use that
callback. No global console replacement is introduced in product code, and
`brain.mjs` is unchanged. Interactive callers keep their existing logger.
Original typed errors remain only in the non-enumerable in-memory cause chain
until the daily runner constructs its redacted diagnostic.

The regression uses the default `runSource` adapter and real `cmdLoad`. Its
wrapper supplies only synthetic registry/probe dependencies and forwards the
adapter's options. It does not use `quietRun`, a fixture logger, or a replacement
`runSource`. A UUID is generated at runtime and embedded in an invalid-domain
URL in a typed leg error; no committed line contains the complete marker.
Assertions examine every captured output entry without printing its content.
Both failed and partial cases prove the failing leg ran, later clean work
completed, freshness stayed false for the failed source, and the same redacted
detail exists in the receipt and daily log. The caught cause is the original
typed object, while serializing the caught wrapper produces `{}`.

The clean default-adapter control verifies complete work and advancing
freshness without a source failure. The interactive control proves both raw
report locations remain active for ordinary callers. The logger policy covers
`cmdLoad`'s report; it is not a connector-wide silence policy. Existing
connector-owned output and loader progress helpers are outside this change.

## Path boundary

The new alternative accepts one slash or backslash between a first component
and a spaced final filename with an extension. The first component contains
letters, numbers, underscore, dot or hyphen. The final component uses those
characters with one or more spaces/tabs between words, followed by a dot and
1 to 16 letters or numbers. The existing start boundary is preserved.

For one separator, the extension must end the diagnostic or be immediately
followed by a comma, semicolon, closing delimiter/quote, or sentence punctuation
with its own end boundary. Ordinary whitespace after the extension alone does
not qualify. This preserves `and/or read the troubleshooting.md guide.` and
the exact existing `and/or`, `read/write`, `success/failure`, spaced-slash and
Markdown prose controls. Other prose that fits the bounded path grammar may be
redacted conservatively. Multi-folder paths retain their previous broader
whitespace boundary. Whitespace-followed single-folder text, extensionless
filenames and characters outside this grammar remain outside the new rule.

## Red then green evidence

1. **Default-adapter output:** before the fix, both failed and partial cases
   failed with `raw leg diagnostic escaped through console.log`. The capture,
   clean and interactive controls passed: **3 pass / 2 fail**. Adding the
   adapter's callback made the same command pass **5 / 0**. Removing only that
   callback in memory reproduced both failures with all three controls green.
2. **One-separator spaced filenames:** before the regex change, all four new
   receipt/log cases failed while the clean and safe-prose controls passed:
   **2 pass / 4 fail**. The same command became **6 / 0**. Expanded spaced-path
   and prose coverage passed **10 / 0**. The final boundary mutant failed all
   eight spaced-path cases, including all four new cases, with both controls
   still passing.

## Every test command run

Counts below are passes/failures. Ordinary red runs exited 1 and green runs
exited 0. Mutation failures are intentional. Markdown table pipes are escaped;
the actual patterns use ordinary regex alternation pipes.

| Command | Every observed result |
| --- | --- |
| `node --test --test-name-pattern='default adapter\|output capture control\|interactive output control' test/daily-load-errors.test.mjs` | Red 3/2; green 5/0. |
| `node --test --test-name-pattern='clean source control\|safe slash prose\|one-separator' test/daily-error-diag.test.mjs` | Red 2/4; green 6/0. |
| `node --test --test-name-pattern='clean source control\|safe slash prose\|spaced filename\|spaced directory and filename' test/daily-error-diag.test.mjs` | Green 10/0. |
| `node --test test/daily-error-diag.test.mjs test/daily-load-errors.test.mjs test/daily-refresh-run.test.mjs test/test-chain-runner.test.mjs test/test-chain-complete.test.mjs` | Final green 120/0. |

All mutation commands used this exact prefix, with the environment variable
`DAILY_ERROR_DIAG_MUTANT` set to the table's ID and removed in `finally`:

```text
node --import file:///C:/offload/lanes-1023/no-network.mjs --import ./test/fixtures/daily-error-diag-mutant.mjs --test
```

| Mutant ID | Arguments appended to that prefix | Every observed result |
| --- | --- | --- |
| `daily_load_output_policy_removed` | `--test-name-pattern='default adapter\|output capture control\|interactive output control' test/daily-load-errors.test.mjs` | Initial 3/2; final 3/2. |
| `spaced_filename_boundary_removed` | `--test-name-pattern='clean source control\|safe slash prose\|one-separator' test/daily-error-diag.test.mjs` | Initial 2/4. |
| `spaced_filename_boundary_removed` | `--test-name-pattern='clean source control\|safe slash prose\|spaced filename\|spaced directory and filename' test/daily-error-diag.test.mjs` | Final 2/8. |
| `lost_load_causes` | `--test-name-pattern='default adapter\|clean source control' test/daily-load-errors.test.mjs` | Final 2/2. |
| `unknown_issue_code` | `--test-name-pattern='clean source control\|removal approval\|safety review is\|lock held uses\|network failure recognizes' test/daily-error-diag.test.mjs` | Final 1/4. |
| `raw_detail` | `--test-name-pattern='clean source control\|safe slash prose\|one-separator' test/daily-error-diag.test.mjs` | Final 2/4. |
| `first_aggregate_entry` | `--test-name-pattern='clean source control\|aggregate unknown\|aggregate priority\|aggregate equal-priority control' test/daily-error-diag.test.mjs` | Final 2/5. |
| `nested_aggregate_not_flattened` | `--test-name-pattern='clean source control\|nested aggregate\|aggregate equal-priority control' test/daily-error-diag.test.mjs` | Final 1/3. |
| `unregistered_daily_suites` | `--test-name-pattern='test chain registers' test/test-chain-runner.test.mjs test/test-chain-complete.test.mjs` | Final 1/3. |

The first output-mutant PowerShell wrapper returned 0 after its cleanup despite
Node reporting the two expected failures. The final mutation loop explicitly
captured and asserted Node exit 1 for every mutant. Every run printed both
`LANE_NETWORK_GUARD_ACTIVE` and `DAILY_DIAG_MUTANT_REACHED:<id>`. No failure was
an import or target-count error. Mutated source existed only in memory.

Four individual syntax commands passed, each using
`node --import file:///C:/offload/lanes-1023/no-network.mjs --check <file>`:
`operations/daily-refresh-run.mjs`, `test/daily-error-diag.test.mjs`,
`test/daily-load-errors.test.mjs`, and `test/fixtures/daily-error-diag-mutant.mjs`.
The guarded probe
`node --import file:///C:/offload/lanes-1023/no-network.mjs -p process.versions.node`
reported `24.18.0`. Each printed the guard marker. `git diff --check` passed
before and after report completion. Added-text policy checks and read-only
peer review found no remaining material issue.

## Named mutants and kill evidence

The three round 4 named mutants are:

| Mutant | Behavioral proof |
| --- | --- |
| `daily_load_output_policy_removed` | Deleting only the adapter logger restores raw output in failed and partial real-loader runs. Both fail the runtime-marker absence assertion; capture, clean and interactive controls pass. |
| `spaced_filename_boundary_removed` | Deleting only the shared spaced-path replacement leaks both the requested one-separator paths and prior multi-folder paths into persisted diagnostics. All eight fail; clean and exact prose controls pass. |
| `lost_load_causes` | Dropping original leg causes changes both failed and partial default-adapter diagnostics to `UNKNOWN`. Both clean controls pass. |

All remaining inherited mutants were also revalidated: forced unknown codes
fail the four typed-stop checks; raw detail fails the four new path privacy
checks; first-entry selection fails five priority cases; skipped flattening
fails three nested cases; removed suite registration fails both registration
checks plus completeness while the existing daily-runner registration passes.

## Limits

This is synthetic offline proof on one Windows Node 24 host. No native
scheduler execution, live connector recovery, production refresh, Node 22 run
or six-platform CI is claimed. No field gate was run. The documented path
grammar is a bounded heuristic. Missing commit and push are expected under
this run's instructions and are not readiness defects.

## Prepared commit

Subject: `Close raw daily load output and single-folder diagnostic leaks`

Body:

```text
Pass an explicit loader logger from the default daily adapter and redact
bounded single-folder paths containing spaced filenames. Preserve interactive
reports and typed causes in memory.

Prove the output boundary through real-loader channel capture and clean
controls. Focused validation: 120 tests passed; all eight mutants killed.
Include the round 4 report for operator handoff.
```

## Operator note

The Codex sandbox on this Windows machine makes `.git` read-only, so the lane could not commit. The operator (Claude Code) re-ran on the unchanged working tree:

- The five suites (daily-error-diag, daily-load-errors, daily-refresh-run, test-chain-runner, test-chain-complete): 120/120.
- All eight mutants with the network guard, using the table's patterns: `daily_load_output_policy_removed` 3 pass / 2 fail, `spaced_filename_boundary_removed` 2/8, `lost_load_causes` 2/2, `unknown_issue_code` 1/4, `raw_detail` 2/4, `first_aggregate_entry` 2/5, `nested_aggregate_not_flattened` 1/3, `unregistered_daily_suites` 1/3. Each was reached and killed.
- `cmdLoad` (brain.mjs) sends all of its own output through `options.log || console.log`, and there is no other console or stdout write in it, so the daily adapter's `log() {}` closes the raw-print path the partner named.
- No credential-shaped literal lines; `git diff --check` clean. Names, banned-word, email, user-path and key scan: none.

The operator made the prepared commit unchanged and added the Codex co-author trailer. No code was edited by the operator.

LANE DAILY-ERROR-DIAG-4: READY
