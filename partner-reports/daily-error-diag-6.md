# DAILY-ERROR-DIAG-6

Branch: `partner/daily-error-diag-6`. Starting commit: `2c3137d`.
Docs only. All test runs finished by 10:57 MST on 2026-10-24.

## Changes and search findings

- `onboarding/06-runbook-top-ten-failures.md:63`: each issue code selects one
  fixed message shared by the source receipt and private `daily.log`. Neither
  records provider text. Recovery steps and the metadata-only support journal
  guidance remain unchanged.
- `partner-reports/daily-error-diag-6.md:1`: this report and prepared commit.

Searches across `onboarding/`, `docs/`, and `CHANGELOG.md`, including
multiline review, found three stale claims in the original runbook paragraph:

| Original location | Claim corrected |
| --- | --- |
| `onboarding/06-runbook-top-ten-failures.md:63` | Daily status exposes bounded, redacted detail. |
| `onboarding/06-runbook-top-ten-failures.md:64` | Receipt and log retain the original cause. |
| `onboarding/06-runbook-top-ten-failures.md:71` | Tokens, email addresses, URLs and paths are redacted from those details. |

No other daily receipt or daily.log promise needed correction.
`docs/README-developer.md:1425` and `CHANGELOG.md:13` already describe fixed
messages. Other redaction references concern different outputs and were left
unchanged. Read-only source review confirmed the message lookup at
`operations/daily-refresh-run.mjs:422` and fixed table at
`operations/daily-refresh-messages.mjs:1`. The runbook already names
`brain.mjs`; this edit keeps the explanation in owner terms without adding
another implementation path.

## Verification

Every Node invocation loaded
`--import file:///C:/offload/lanes-1023/no-network.mjs` and printed
`LANE_NETWORK_GUARD_ACTIVE`. No network or provider call was made.

A temporary focused documentation test reads only the daily paragraph.
Its passing control checks the existing status command, approval boundary,
lock/network guidance, freshness warning and support-journal boundary.
Two checks require issue-code selection of a shared fixed message and explicit
exclusion of provider text without the old redaction/original-cause promises.
No test or product code was changed in the repository.

For the command table, `T` is
`%TEMP%\daily-error-diag-6-1792864604012\daily-runbook.test.mjs`.
Every command starts with
`node --import file:///C:/offload/lanes-1023/no-network.mjs`.

| Arguments after that prefix | Result |
| --- | --- |
| `--test T` before editing | Red: 1 passing control, 2 failures; Node exit 1. |
| `--test --test-reporter=tap T` after editing | Green: 3 passed, 0 failed; exit 0. |
| `--test --test-reporter=tap T` with `DAILY_DOC_MUTANT=restore_provider_detail` | Mutant killed: 1 passing control, 2 failures; Node exit 1. |
| `--test --test-reporter=tap --test-name-pattern=P test/client-experience-packet.test.mjs test/fix-update-0419-ledger.test.mjs test/source-inventory-cli.test.mjs` | 4 passed, 0 failed; exit 0. Each matching existing runbook test ran once. |

The exact pattern `P` was:

```text
^(OCR guidance preserves consent, cost, and unknown scan state|source guidance requires same-item proof and keeps run failures bounded|the owner runbook never routes a repair through direct migrate|shipped source guidance uses v3 JSON or the actual concise human columns)$
```

The initial red wrapper expected TAP count labels but Node used its default
reporter. The observed Node result was 1 pass / 2 failures; subsequent commands
explicitly selected TAP.

Named mutant `restore_provider_detail` substitutes the saved original
paragraph in memory. It printed
`DAILY_DOC_MUTANT_REACHED:restore_provider_detail`, failed both wording checks,
and kept the recovery control green. The revised file stayed untouched.
The mutation environment variable was removed afterward.

The test search also found `test/package-privacy.test.mjs:518`, which lists
package membership rather than checking runbook prose. It was not run.
`git diff --check` and changed-text/report checks passed. Final review found only the runbook and this report
changed. No dependency install, full suite, account access or Git mutation was
performed. Changes remain in the working tree for the operator.

## Prepared commit

Subject: `Document fixed daily failure messages in the runbook`

Body:

```text
Replace obsolete provider-redaction and original-cause retention claims with
the shipped issue-code message policy. Preserve daily recovery guidance.

Verify four existing runbook checks and a focused documentation red/green
check. Kill the old-paragraph mutant with its recovery control still passing.
Include the round 6 report.
```

## Operator note

The Codex sandbox on this Windows machine makes `.git` read-only, so the lane could not commit. The operator (Claude Code) checked the diff: only `onboarding/06-runbook-top-ten-failures.md` changed, and only the daily receipt and log paragraph. The operator also re-ran the existing tests that read the runbook, `node --test test/client-experience-packet.test.mjs test/fix-update-0419-ledger.test.mjs test/source-inventory-cli.test.mjs`: 50/50. `git diff --check` is clean. Names, banned-word, em dash and user-path scan: none. The operator made the prepared commit unchanged and added the Codex co-author trailer.

LANE DAILY-ERROR-DIAG-6: READY
