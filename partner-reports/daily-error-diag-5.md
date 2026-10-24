# DAILY-ERROR-DIAG-5

Branch: `partner/daily-error-diag-5`. Starting commit: `17603d2`.
Validation host: Windows, Node `v24.18.0`, 2026-10-24.
Final focused suites and mutants completed by 10:34 MST, before the 14:00 cutoff.

## Result

Daily source failure details now come only from one fixed message table.
Provider text is never used to construct the receipt or log detail. The five
required focused suites passed **195 tests, 0 failures**: diagnostics 125,
loader 11, runner 55, chain registration 3, chain completeness 1. All nine
retained or new mutants were reached and killed, each with passing controls.

Only synthetic fixtures and temporary homes under `%TEMP%` were used. No
network, real account, credential lookup, dependency installation, full test
chain, Git mutation, commit or push was performed. Every ad-hoc Node command
and mutation run loaded the required network guard. No ad-hoc connector or
provider call was made. Changes remain in the working tree for the operator.

## Changes

| Location | Change |
| --- | --- |
| `operations/daily-refresh-messages.mjs:1` | One frozen table with 71 fixed, short messages: every support code accepted by the classifier plus `UNKNOWN`. No provider value is interpolated. |
| `operations/daily-refresh-run.mjs:12`, `operations/daily-refresh-run.mjs:417` | Remove the diagnostic path/credential regexes, normalization and scanner dependency. Both receipt and log use the exact table value. Log labels use the plan's fixed connector key. Existing receipt identity and bounded removal-review metadata remain. |
| `operations/daily-refresh-run.mjs:87` | Export the unchanged error-graph helper for direct tests of selection, counts and limits now that these observations stay in memory. |
| `operations/daily-refresh-run.mjs:433`, `operations/daily-refresh-run.mjs:580` | Remove the generic source failure's suggestion that raw private diagnostics exist, and describe the fixed-message output policy accurately. |
| `operations/daily-refresh-observation.mjs:106` | Correct the persistence comment; no behavior change in the log writer. |
| `brain.mjs:476`, `brain.mjs:16804`, `brain.mjs:16818`, `brain.mjs:16836`, `brain.mjs:16852`, `brain.mjs:16927` | Give `info`, `ok`, and `warn` an optional logger and pass the loader's selected logger at all four call sites. Interactive defaults and formatting remain. |
| `test/daily-error-diag.test.mjs:80`, `test/daily-error-diag.test.mjs:89`, `test/daily-error-diag.test.mjs:107`, `test/daily-error-diag.test.mjs:129` | Prove fixed network text, mixed private-message exclusion, exact table coverage without duplicate keys, and real receipt/log readback for all 71 codes. |
| `test/daily-error-diag.test.mjs:285`, `test/daily-error-diag.test.mjs:313`, `test/daily-error-diag.test.mjs:347`, `test/daily-error-diag.test.mjs:414` | Preserve graph-boundary, shared-leaf and tie-selection checks in memory; convert historical privacy cases to fixed-message assertions. |
| `test/daily-load-errors.test.mjs:172`, `test/daily-load-errors.test.mjs:210`, `test/daily-load-errors.test.mjs:233`, `test/daily-load-errors.test.mjs:264` | Extend every-channel capture to successful source labels and progress, verify fixed persistence, and test selected logger delivery for progress, preview and limit notices. |
| `test/daily-refresh-run.test.mjs:164`, `test/daily-refresh-run.test.mjs:261`, `test/daily-refresh-run.test.mjs:317`, `test/daily-refresh-run.test.mjs:742` | Update runner privacy expectations to fixed text. Successful and partial receipt controls remain unchanged. |
| `test/fixtures/daily-error-diag-mutant.mjs:7`, `test/fixtures/daily-error-diag-mutant.mjs:12`, `test/fixtures/daily-error-diag-mutant.mjs:15` | Add helper-output and missing-message mutants, retarget raw detail to the new assignment, and remove the obsolete spaced-filename regex mutant. |
| `docs/README-developer.md:1425`, `CHANGELOG.md:13` | Replace heuristic-redaction claims with fixed-message behavior, actual output policy, and diagnostics limits. |
| `partner-reports/daily-error-diag-5.md:1` | Record this round and the prepared commit. Prior reports remain historical and unchanged. |

## Classification and privacy boundary

A read-only comparison against the starting commit proved the classification,
priority and bounded traversal source identical except for the helper export.
Removal approval still precedes other safety review, held lock, network,
other recognized issues and unknown. Cause traversal is still cycle-aware,
limited to 64 examined entries and depth 8, with stable ties and shared-leaf
counts. Those counts and limit observations stay in memory and do not prefix
the fixed message. Failure never advances freshness; later clean work runs.

The coverage test compares table keys against exactly `SUPPORT_ERROR_CODES`
plus `UNKNOWN`, checks the declared keys for duplicates, and checks every
literal classifier return for a table entry. Each code also goes through the
real receipt and log writers with a later clean source control. The network
message has an independent exact-text assertion. The mixed privacy test uses
a runtime marker in a spaced path, credential assignment and invalid-domain
URL, including both colon and plain-word suffixes. Boolean assertions avoid
printing planted private values on failure.

There is **no separate private daily diagnostics path for raw provider errors**.
The actual daily paths are `~/.brain/daily-receipts/`
(`operations/daily-refresh-run.mjs:490`) and
`~/.brain/logs/<identity>/daily.log`
(`operations/daily-refresh-observation.mjs:12`). The handled source catch at
`operations/daily-refresh-run.mjs:417` writes those two outputs only.
`observeDailyRun` at `operations/daily-refresh-observation.mjs:233` records a
fixed run outcome, not the raw cause. The separate existing
`~/.brain/support/events/` path (`support-journal.mjs:321`) is metadata-only;
its schema excludes raw messages, paths, URLs and content, and handled daily
source failures do not reach its CLI failure hook. No new diagnostics store
was invented. Original typed causes remain in memory through the loader's
non-enumerable cause chain (`brain.mjs:16858`, `brain.mjs:17001`).

## N3 and the round 4 operator note

The round 4 note's claim that every loader-owned output used `options.log`
was inaccurate at that commit. `info()` and `ok()` called `console.log`, and
the limit warning did too. This round routes all three helpers through the
selected loader logger. Ordinary callers keep the same default console output.

The existing capture harness intercepts every public own console method plus
both output streams. A runtime source-label marker exercises `ok()` in failed,
partial and fully successful daily runs. `info()` receives only source counts
or fixed preview prose, so the tests assert its complete absence from captured
daily output and its delivery through an explicitly selected logger. The
interactive control verifies progress, success and both failure-report lines.
The capture self-control exercises all intercepted channels. This is a loader
output policy; connector-owned output remains outside its scope.

## Red then green evidence

1. **Fixed persistence:** before product changes, the new harmless-message
   control and mixed private-message test failed, with the clean source control
   passing: **1 pass / 2 fail**. The same command after replacement passed
   **3 / 0**. Copying provider text back in reproduces both failures while the
   clean source control remains green.
2. **Loader helper policy:** before the helper change, all three daily adapter
   modes exposed progress output, and the selected-logger test captured five
   bypass lines: **2 pass / 4 fail**. Capture and interactive controls passed.
   The same command after routing passed **6 / 0**. Restoring the old helper
   behavior reproduces all four failures with both controls green.

During conversion of historical assertions, one diagnostics run was
**120 pass / 5 fail**: five expectations incorrectly assumed `UNKNOWN`, but
the unchanged classifier recognizes `invalid` in the synthetic reserved-domain
strings as `CONFIG_INVALID`. Correcting the expectations to the selected
code's fixed message produced **125 / 0** without changing classification.

## Every test command run

Counts are passes/failures. Red tests exited 1; green tests exited 0. Table
pipes are escaped for Markdown; actual patterns contain ordinary regex pipes.

| Command | Every observed result |
| --- | --- |
| `node --test --test-name-pattern='clean source control\|fixed message' test/daily-error-diag.test.mjs` | Red 1/2; green 3/0. |
| `node --test --test-name-pattern='default adapter\|output capture control\|interactive output control\|selected output policy' test/daily-load-errors.test.mjs` | Red 2/4; green 6/0. |
| `node --test test/daily-error-diag.test.mjs` | Integration 120/5; corrected 125/0. |
| `node --test test/daily-load-errors.test.mjs test/daily-refresh-run.test.mjs` | Green 66/0. |
| `node --test test/daily-error-diag.test.mjs test/daily-load-errors.test.mjs test/daily-refresh-run.test.mjs test/test-chain-runner.test.mjs test/test-chain-complete.test.mjs` | Final green 195/0. |

All mutation commands used this exact prefix, with
`DAILY_ERROR_DIAG_MUTANT` set to the table ID and removed in `finally`:

```text
node --import file:///C:/offload/lanes-1023/no-network.mjs --import ./test/fixtures/daily-error-diag-mutant.mjs --test
```

Each mutant ran twice: once after integration and once after the final five
suites. Both runs had the same counts below. Every run printed
`LANE_NETWORK_GUARD_ACTIVE` and `DAILY_DIAG_MUTANT_REACHED:<id>`. The wrapper
asserted Node exit 1, both markers, and absence of target-count or unknown-mutant
errors. Mutations existed only in memory.

| Mutant ID | Arguments appended to prefix | Initial and final passes/failures |
| --- | --- | --- |
| `raw_detail` | `--test-name-pattern='clean source control\|fixed message' test/daily-error-diag.test.mjs` | 1/2 each |
| `missing_issue_message` | `--test-name-pattern='clean source control\|message table covers' test/daily-error-diag.test.mjs` | 1/1 each |
| `loader_helpers_ignore_output_policy` | `--test-name-pattern='default adapter\|output capture control\|interactive output control\|selected output policy' test/daily-load-errors.test.mjs` | 2/4 each |
| `daily_load_output_policy_removed` | `--test-name-pattern='default adapter\|output capture control\|interactive output control\|selected output policy' test/daily-load-errors.test.mjs` | 3/3 each |
| `lost_load_causes` | `--test-name-pattern='default adapter\|clean source control' test/daily-load-errors.test.mjs` | 2/2 each |
| `unknown_issue_code` | `--test-name-pattern='clean source control\|removal approval\|safety review is\|lock held uses\|network failure recognizes' test/daily-error-diag.test.mjs` | 1/4 each |
| `first_aggregate_entry` | `--test-name-pattern='clean source control\|aggregate unknown\|aggregate priority\|aggregate equal-priority control' test/daily-error-diag.test.mjs` | 2/5 each |
| `nested_aggregate_not_flattened` | `--test-name-pattern='clean source control\|nested aggregate\|aggregate equal-priority control' test/daily-error-diag.test.mjs` | 1/3 each |
| `unregistered_daily_suites` | `--test-name-pattern='test chain registers' test/test-chain-runner.test.mjs test/test-chain-complete.test.mjs` | 1/3 each |

The three named round 5 mutants are:

- `raw_detail`: copies the selected provider message back into persisted detail.
  Both fixed-message tests fail, including mixed path/credential/URL privacy;
  the clean source passes.
- `missing_issue_message`: removes `WRANGLER_UNAVAILABLE` from the table.
  Exact catalog coverage fails; the clean source passes.
- `loader_helpers_ignore_output_policy`: restores the three helpers' direct
  console behavior. Every default-adapter mode and the selected logger test
  fail; capture and interactive controls pass.

The other six mutants preserve their previous contracts: removing the daily
logger fails all three adapter modes; losing causes fails both failed/partial
classifications; forced unknown fails four typed-stop checks; first-entry
selection fails five priority cases; skipped nested traversal fails both leaf
checks and the tie check; removed registration fails both daily registrations
and completeness while the existing runner registration passes.

Removed `spaced_filename_boundary_removed` because the entire path-regex
pipeline is gone. Retained `raw_detail` under its existing ID but replaced its
obsolete sanitizer target with the new fixed-message assignment. No regex-only
mutant remains.

Guarded syntax checks passed for `brain.mjs`,
`operations/daily-refresh-run.mjs`, `operations/daily-refresh-messages.mjs`,
`operations/daily-refresh-observation.mjs`, `test/daily-error-diag.test.mjs`,
`test/daily-load-errors.test.mjs`, `test/daily-refresh-run.test.mjs`, and
`test/fixtures/daily-error-diag-mutant.mjs`, each using
`node --import file:///C:/offload/lanes-1023/no-network.mjs --check <file>`.
The loader and its test were also checked earlier; the message table was
checked again after wording review. The guarded
`node --import file:///C:/offload/lanes-1023/no-network.mjs -p process.versions.node`
probe reported `24.18.0`. `git diff --check` passed throughout and after report
completion. Read-only review confirmed the existing `operations/` publication
allowlist includes the new table, without changing that boundary.

## Limits

This is synthetic offline proof on one Windows Node 24 host. No live source,
native scheduler rehearsal, Node 22 run, six-platform CI or field gate was run.
Existing historical logs are not rewritten. Missing commit and push are
expected under this run's instructions and are not readiness defects.

## Prepared commit

Subject: `Use fixed daily issue messages and route loader helper output`

Body:

```text
Replace provider-derived daily diagnostics with one complete fixed-message
table. Preserve typed classification in memory and remove the path and
credential regex pipeline. Route loader progress, success and warnings through
its selected logger while preserving interactive defaults.

Focused validation: 195 tests passed; all nine retained or new mutants reached
and killed with passing controls. Include the round 5 operator report.
```

## Operator note

The Codex sandbox on this Windows machine makes `.git` read-only, so the lane could not commit. The operator (Claude Code) re-ran on the unchanged working tree:

- The five suites (daily-error-diag, daily-load-errors, daily-refresh-run, test-chain-runner, test-chain-complete): 195/195.
- All nine mutants with the network guard, using the table's patterns: `raw_detail` 1 pass / 2 fail, `missing_issue_message` 1/1, `loader_helpers_ignore_output_policy` 2/4, `daily_load_output_policy_removed` 3/3, `lost_load_causes` 2/2, `unknown_issue_code` 1/4, `first_aggregate_entry` 2/5, `nested_aggregate_not_flattened` 1/3, `unregistered_daily_suites` 1/3. Each was reached and killed.
- Correcting the operator's round 4 note (partner N3): this time the operator checked every helper call inside `cmdLoad` (brain.mjs). All `ok`, `info` and `warn` calls pass `log`, there are no `say` calls and no direct console or stdout writes. The path and credential regex pipeline is gone from `operations/daily-refresh-run.mjs`.
- No credential-shaped literal lines; `git diff --check` clean. Names, banned-word, email, user-path and key scan: none.

The operator made the prepared commit unchanged and added the Codex co-author trailer. No code was edited by the operator.

LANE DAILY-ERROR-DIAG-5: READY
