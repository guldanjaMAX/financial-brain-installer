# DAILY-ERROR-DIAG

Branch: `partner/daily-error-diag-1`. Starting commit: `f8a7cd05`.
Validation host: Windows, Node `v24.18.0`, 2026-10-23.

## Result and scope

The starting checkout already had bounded daily receipt and log diagnostics.
The production gap was upstream: `cmdLoad` replaced the original source error
with its aggregate "did not load" exception. This change preserves that cause
in memory and uses it for the daily issue and redacted detail.

No network, remote access, dependency installation, deployment, real account,
credential lookup, full test chain, tag, release or push was performed. Source
execution and freshness use synthetic injected fixtures. The implementation
and report remain uncommitted because this workspace makes `.git` read-only.
The operator must create the requested single local commit before any push.

## Changes

| Location | Change |
| --- | --- |
| `brain.mjs:16856`, `brain.mjs:16999` | Preserve original leg errors in non-enumerable `Fatal.cause`, using `AggregateError` for several failures. Both whole and partial failures retain causes; later sources still run. |
| `operations/daily-refresh-run.mjs:31`, `operations/daily-refresh-run.mjs:70` | Recognize removal approval, other safety review, held source/lifecycle locks and network failures. Inspect bounded cause chains; several failures retain a count and prioritize a safety review. |
| `operations/daily-refresh-run.mjs:89`, `operations/daily-refresh-run.mjs:110` | Redact credentials, explicit short token/authorization values, email addresses, HTTP URLs with queries, and absolute or explicitly relative paths. Handle quoted punctuation and normalize split credentials before redaction; preserve the 200-character, single-line bound. |
| `operations/daily-refresh-run.mjs:450` | Persist the same safe issue/detail in the source receipt and `daily.log`; keep a distinct stop reason and failed freshness. |
| `test/daily-error-diag.test.mjs:68` | Clean completion control and stop-class, wrapper, privacy, bound, receipt, log and status-readback regressions. Every failure case also runs a later clean source and verifies `complete`. |
| `test/daily-load-errors.test.mjs:58`, `test/daily-load-errors.test.mjs:123` | Actual loader cause preservation, continuation, partial failures, clean control and default daily adapter integration. |
| `test/daily-refresh-run.test.mjs:458`, `test/daily-refresh-run.test.mjs:802`, `test/daily-refresh-run.test.mjs:918` | Isolate existing tests to temporary homes and simulated POSIX filesystem behavior. Keep explicit Windows ACL denial/success injection tests intact. |
| `test/fixtures/daily-error-diag-mutant.mjs:4` | Three reproducible import-hook mutants; no product source files are rewritten by mutation runs. |
| `docs/README-developer.md:1427` | Document diagnostic privacy, cause preservation and existing issue-code mappings. |
| `onboarding/06-runbook-top-ten-failures.md:63` | Explain the distinct daily stops and owner next steps. |
| `CHANGELOG.md:13` | Owner-facing change and what to verify. |

Existing support codes are reused: `SAFETY_REVIEW_REQUIRED`,
`SCHEDULE_RUN_FAILED` and `NETWORK_UNREACHABLE`. The metadata-only support
journal schema and recovery catalog do not gain a new issue category.

## Red then green evidence

1. **Loader cause loss:** the new loader file initially had 1 passing clean
   control and 5 failures. Preserving causes made 5 pass; the default daily
   adapter remained red until daily cause traversal landed. It now passes all
   6 tests, including the real `cmdLoad` adapter boundary.
2. **Stop classification and diagnostic privacy:** the first diagnostic file
   run had 5 passes and 12 failures. These covered missing removal-name/code
   mapping, generic safety mislabeled as removal, locks and network failures
   mapped to `UNKNOWN`, discarded wrapped causes, emails, query URLs, Windows
   forward-slash paths, relative/home paths and normalized email privacy.
   The initial corrected file passed all 17 tests.
3. **Network wrapper detail:** a new focused regression had 1 passing control
   and 1 failure: the outer summary survived instead of the original transport
   message. Removing premature nested-code classification made it green.
4. **Short explicit credentials:** a new selection had 1 passing control and
   4 failing bearer/token/basic-authorization cases. Diagnostic-specific
   structural redaction made them green.
5. **Quoted path tails:** a new selection had 1 passing control and 2 failures
   for punctuation/apostrophes inside quoted paths. Whole quoted-span redaction
   made both green.
6. **Split credential fragments:** a new selection had 1 passing control and
   1 failure. Canonicalizing before the first replacement removed the fragment
   left after a format control or line break. Both variants now pass.
7. **Existing test isolation:** the first combined loader/runner run had
   54 passes and 7 failures. Existing cases omitted a synthetic home or invoked
   native Windows ACL behavior before their intended assertions. Some attempted
   owner-home filesystem writes were denied by the sandbox. Those seams now
   use temporary homes and explicit simulated filesystem platforms; the runner
   file passes 55/55. No production permission guard was weakened.

Final combined result: **86 passed, 0 failed**, including all new negatives,
their clean controls, existing complete/partial receipt compatibility,
freshness guards, receipt/log readback and explicit Windows ACL mocks.

## Every test command run

Counts below are passes/failures; a red run exits 1 and a green run exits 0.
Repeated commands are listed with each observed result.

| Command | Results |
| --- | --- |
| `node --test test/daily-load-errors.test.mjs` | Initial 1/5; after loader change 5/1, awaiting daily cause traversal. |
| `node --test test/daily-error-diag.test.mjs` | Initial 5/12; after initial correction 17/0. |
| `node --test test/daily-load-errors.test.mjs test/daily-refresh-run.test.mjs` | 54/7; loader integration green, existing isolation failures described above. |
| `node --test --test-name-pattern='clean source control\|network wrapper' test/daily-error-diag.test.mjs` | 1/1 red. |
| `node --test --test-name-pattern='clean source control\|short bearer\|short token\|quoted token\|basic authorization' test/daily-error-diag.test.mjs` | 1/4 red. |
| `node --test test/daily-error-diag.test.mjs test/daily-load-errors.test.mjs` | 28/0 after transport/credential fixes; 30/0 after quoted-path fixes. |
| `node --test --test-name-pattern='clean source control\|quoted path' test/daily-error-diag.test.mjs` | 1/2 red. |
| `node --test test/daily-refresh-run.test.mjs` | 55/0 after isolation changes. |
| `node --test --test-name-pattern='clean source control\|split value' test/daily-error-diag.test.mjs` | 1/1 red. |
| `node --test test/daily-error-diag.test.mjs test/daily-load-errors.test.mjs test/daily-refresh-run.test.mjs` | Final 86/0. |

The backslashes before table pipe characters are Markdown escaping; the actual
test-name patterns contain ordinary regex alternation pipes.

`node --check brain.mjs` passed during implementation and again in final
validation. Final `node --check` also passed individually for
`operations/daily-refresh-run.mjs`, `test/daily-error-diag.test.mjs`,
`test/daily-load-errors.test.mjs`, `test/daily-refresh-run.test.mjs` and
`test/fixtures/daily-error-diag-mutant.mjs`. `git diff --check` passed.

The final `git add -- <the ten changed files>` failed before staging because
Git could not create `.git/index.lock`: permission denied. The workspace
permission profile grants read access only to `.git`, and escalation is
unavailable. `git rev-list --count f8a7cd05..HEAD` remains `0`. No alternate Git
directory, permission changes or remote operation was attempted. Empty-index
checks after that refusal do not count as staged-content validation.

## Mutants

Each run printed `DAILY_DIAG_MUTANT_REACHED:<name>`, then failed behavioral
assertions while its clean-source control passed. Each mutant is killed.

| Mutant | Deliberate defect | Command and observed proof |
| --- | --- | --- |
| `lost_load_causes` | Drop the source error collected by `cmdLoad`. | With `DAILY_ERROR_DIAG_MUTANT=lost_load_causes`, run `node --import ./test/fixtures/daily-error-diag-mutant.mjs --test test/daily-load-errors.test.mjs`: exit 1, 1 pass/5 failures, including the default daily adapter returning `UNKNOWN`. |
| `unknown_issue_code` | Replace the classified source issue with `UNKNOWN`. | With `DAILY_ERROR_DIAG_MUTANT=unknown_issue_code`, run `node --import ./test/fixtures/daily-error-diag-mutant.mjs --test test/daily-error-diag.test.mjs`: exit 1, 18 passes/6 failures across the stop and wrapper cases. |
| `raw_detail` | Bound the message but bypass all diagnostic redaction. | With `DAILY_ERROR_DIAG_MUTANT=raw_detail`, run `node --import ./test/fixtures/daily-error-diag-mutant.mjs --test test/daily-error-diag.test.mjs`: initial exit 1, 7 passes/17 failures; rerun after split-value coverage exit 1, 7 passes/18 failures. |

The named environment variable was removed after each command. Mutation runs
modify imported code in memory only. No mutation remains in the working tree.

## Limits

These are offline synthetic proofs on Node 24. They do not establish native
Windows ACL acceptance, a real scheduler execution, live connector recovery,
Node 22 behavior or six-platform CI. No field gate was run. Multiple failing
legs preserve their errors in memory; the persisted diagnostic intentionally
keeps a count and one bounded reason rather than raw error objects.

Suggested local commit subject: `Preserve safe daily source failure diagnostics`

Suggested short body: `Retain loader causes, classify daily stops, and redact bounded receipt and log details. Add focused regressions, mutation proof, isolated runner tests, and the lane report.`

## Operator note

The Codex sandbox on this Windows machine makes `.git` read-only, so the lane could not commit. The operator (Claude Code) re-ran `node --test test/daily-error-diag.test.mjs test/daily-load-errors.test.mjs test/daily-refresh-run.test.mjs test/daily-refresh-update-production.test.mjs` on the unchanged working tree (185 passed, 0 failed), scanned the changes for names and banned words (none; fixture addresses use the .invalid domain), and made the suggested commit unchanged. No code was edited by the operator.

LANE DAILY-ERROR-DIAG: READY
