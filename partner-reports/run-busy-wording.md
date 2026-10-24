# RUN-BUSY-WORDING lane report

Branch: `partner/run-busy-wording-1`

Starting commit: `f8a7cd05a1e641d29d5b3af77fc91901a5281639`

Local verification: Windows, Node `v24.18.0`, 2026-10-23 MST.

## Changes

- `worker/src/lib/custom-api-visibility.js:22`: explicitly maps `RUN_BUSY` to
  "The <configured source name> was already updating. It will try again on the
  next run." The configured name still uses the existing normalization and
  default. The bad-data fallback is unchanged.
- `worker/test/custom-api-route.test.mjs:44`: tests the busy mapping with the
  store dashboard name, a different name containing extra whitespace, and the
  default name.
- `worker/test/custom-api-route.test.mjs:57`: adds separate passing controls for
  `INVALID_RESPONSE`, `INVALID_ROW_KEY`, `DUPLICATE_ROW_KEY`, and
  `SECRET_IN_RESPONSE`, each retaining the exact bad-data warning.
- `worker/test/custom-api-route.test.mjs:66`: exercises the real HTTP route's
  busy lease refusal. It proves one lease acquisition attempt, zero provider
  fetches, HTTP 409, `RUN_BUSY`, `retryable: true`, and the exact owner message.
- `CHANGELOG.md:39`: describes the owner-visible wording correction and asks
  the owner to check the feed after its next run.
- `partner-reports/run-busy-wording.md:1`: records scope, controls, test results,
  red-to-green evidence, and mutant results.

## Scope and controls

Inspection of `worker/src/lib/custom-api.js:51` and
`worker/src/lib/custom-api.js:1802` found `RUN_BUSY` to be the only typed lease
or contention code in this feed path. Its retryable refusal is emitted at
`worker/src/lib/custom-api.js:1815`. The other retryable codes are
`RATE_LIMITED`, `REMOTE_UNAVAILABLE`, and `NETWORK_UNREACHABLE`; they already
have specific owner messages. No additional contention codes were invented.

Only rendering changes. Lease acquisition, scheduling, stored issue codes,
retryability, HTTP status, and persistence are unchanged. The route and source
freshness readers already share the corrected helper.

The busy refusal is paired with the existing successful HTTP dry-run control
at `worker/test/custom-api-route.test.mjs:95`, which returns HTTP 200/completed
and performs one mocked provider fetch. The focused scheduled suite also proves
successful due runs and skipping an early tick. The four bad-data controls pass
both before and after the fix, while the distinct busy wording passes after it.

## Test runs and red-to-green evidence

All test invocations are listed below in execution order. Fixtures were
synthetic, provider fetches were mocked, and scheduled persistence used in-memory
SQLite. No network or real Brain was used.

| Run | Exact command | Result |
| --- | --- | --- |
| Red, new tests before production fix | `node --test worker/test/custom-api-route.test.mjs` | Exit 1; 9 passed, 2 failed. The helper and HTTP busy tests expected retry wording but received the bad-data message. All four bad-data controls and the successful dry-run control passed. |
| Green, explicit mapping added | `node --test worker/test/custom-api-route.test.mjs` | Exit 0; 11 passed, 0 failed. Both original failures passed. |
| M1 applied temporarily | `node --test worker/test/custom-api-route.test.mjs` | Exit 1; 9 passed, 2 failed. Both busy wording assertions caught the removed mapping. |
| M2 applied temporarily | `node --test worker/test/custom-api-route.test.mjs` | Exit 1; 10 passed, 1 failed. The `INVALID_RESPONSE` control caught the incorrect retry message. |
| M3 applied temporarily | `node --test worker/test/custom-api-route.test.mjs` | Exit 1; 10 passed, 1 failed. The configured-name test expected inventory feed wording but received store dashboard wording. |
| Final restored source | `node --test worker/test/custom-api-route.test.mjs worker/test/custom-api-scheduled.test.mjs` | Exit 0; 15 passed, 0 failed, 0 skipped. |

Additional checks passed: `node --check worker/src/lib/custom-api-visibility.js`,
`node --check worker/test/custom-api-route.test.mjs`, and `git diff --check`.

## Mutants killed

1. **M1_DROP_BUSY_MAPPING:** remove the explicit `RUN_BUSY` branch. Killed by
   the helper test at line 44 and HTTP test at line 66, each detecting the old
   bad-data wording. Passing controls: four bad-data tests and successful dry run.
2. **M2_HIDE_INVALID_DATA:** extend the busy branch condition to also match
   `INVALID_RESPONSE`. Killed by that code's bad-data control at line 58.
   Passing controls: busy helper and HTTP tests, plus the other bad-data cases.
3. **M3_HARDCODE_SOURCE_NAME:** replace the busy message's configured name with
   the fixed store dashboard name. Killed by the whitespace-normalized inventory
   feed case at line 44. Passing controls: HTTP busy test, bad-data tests, and
   successful dry run.

Each mutant was applied to the production mapper, tested, and removed. The final
15-test run used the restored fix. No mutant remains in the final source.

## Local commit blocker

The required local commit could not be created. Staging the four changed files
with `git add -- CHANGELOG.md worker/src/lib/custom-api-visibility.js worker/test/custom-api-route.test.mjs partner-reports/run-busy-wording.md`
failed with exit 1 because Git could not create `.git/index.lock`: permission
denied. The workspace permits reading `.git` but does not permit writing it.
No files were staged and no commit was created. The code and focused verification
are complete; the lane remains incomplete until the local commit is made in a
workspace that permits Git metadata writes.

Prepared commit subject: `Fix retry wording for busy custom API feeds`

Prepared short body: `Render a deferred-update message for RUN_BUSY while preserving invalid-data warnings. Add route and mapper controls, mutant evidence, and the lane report.`

## Boundaries

No dependency installation, full test chain, network, remote Git operation,
production action, version bump, or Git configuration change was performed.
Only this lane's four files are included. The result is local synthetic proof,
not field acceptance or release approval. The operator handles any later push.

## Operator note

The Codex sandbox on this Windows machine makes .git read-only, so the lane could not commit. The operator (Claude Code) re-ran 
ode --test worker/test/custom-api-route.test.mjs worker/test/custom-api-scheduled.test.mjs on the unchanged working tree (15 passed, 0 failed), checked the four files for names and banned words, and made the prepared commit unchanged. No code was edited by the operator.

LANE RUN-BUSY-WORDING: READY