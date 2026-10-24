# QBO-BROKER-FOUNDATION-4 report

All three requested fixes are complete. The required final eleven-file command
passed **161 tests, 0 failures, 0 skips, 0 TODOs**. The two test-graph checks
passed **2/2** and confirmed all **460** inventoried files are scheduled with
zero exemptions. Two new privacy mutants and the updated terminal-key mutant
are killed. Production remains closed.

Observed branch: `partner/qbo-broker-foundation-4`. Starting commit: `ad658e9`.
The round 3 report was read first, followed by the read-only external design
contract and required repository documentation. Independent read-only review
covered terminal storage, refresh retention, readback witnesses and privacy
exceptions. Its JSON-escaping finding received another red-to-green regression.

All changes remain in the working tree for the operator. No Git write, commit,
push, installation, full test chain, real-account access, external provider
contact, external DNS or network action ran. Every Node invocation included the mandatory network
guard. Transports remained injected into the fake provider. No scratch tree was
created; existing synthetic test helpers use `%TEMP%`. Final test runs finished
around 07:38 MST on 2026-10-24, well before the 14:00 cutoff.

## Changed files

| File and line | Change |
| --- | --- |
| `protocol/quickbooks-broker/probes/harness.mjs:8` | Strict response JSON decoding rejects duplicate keys before granting exceptions. Line 124 maps each private value to its one allowed response and field; line 202 retains every distinct snapshot of the same response; line 233 collects valid START values through every entry point; line 351 scans raw and decoded response bodies and headers. |
| `protocol/quickbooks-broker/testing/broker-privacy.test.mjs:16` | Clean control exercises two starts through helper, raw owner and raw signed broker entry points. Line 28 defines body/header mutants with 19 subcases; lines 86 and 102 cover escaped echoes and duplicate START keys. |
| `protocol/quickbooks-broker/probes/harness.unit.mjs:10` | Unit spies return valid synthetic launch responses; lines 143 and 158 preserve the missing-audit mutants without relying on invalid empty START bodies. |
| `protocol/quickbooks-broker/testing/owner-runtime.mjs:61` | Exact six-field terminal projection. Line 66 validates the concrete row to be stored and actual SQLite readback; line 150 instruments enrollment readback attempts; line 199 projects and verifies expiry; line 329 persists callback terminal receipts; line 343 shares real receipt signing; line 378 verifies refresh terminal storage before clearing the fence; line 479 exposes safe attempt counts; line 517 exposes private test-only stored-row inspection. |
| `protocol/quickbooks-broker/probes/broker.e2e.probe.mjs:530` | Five actual stored-row scenarios cover connect, cancellation, failure, expiry and refresh. Line 566 checks callback replay after key destruction/deadline and changed-byte refusal; line 613 proves bounded cleanup attempts, recovery and idempotence; line 642 updates the real-source key-retention mutant. |
| `broker/quickbooks/test/broker-security.test.mjs:109` | Enrollment readback regression now requires three failed attempt observations and counts, one passing control, and the fourth successful recovery attempt. |
| `broker/quickbooks/README.md:112` | Document exact terminal storage, schema/readback checks and attempted observations. |
| `protocol/quickbooks-broker/probes/README.md:48` | Add terminal storage coverage; line 62 documents per-value privacy exceptions; line 156 adds safe attempt counters; line 172 describes attempt witnesses and private stored-row inspection. |
| `protocol/quickbooks-broker/README.md:24` | Describe the expanded terminal-schema and expiry probes without a stale test count. |
| `protocol/quickbooks-broker/v1/PROTOCOL.md:491` | Remove the stale E2E count while preserving the offline boundary. |
| `docs/README-developer.md:2023` | Remove the stale integration-test count. |
| `partner-reports/qbo-broker-foundation-4.md:1` | This evidence and prepared commit. |

No deployed owner route, broker production handler, product migration, schema
catalog, CLI, manifest, package version, publication allowlist or connector
availability changed. Owner storage remains a test-only SQLite fixture. Only
terminal rows claim `ownerIntent` conformance; active rows retain the fixture's
internal representation.

## Fixes and red-to-green evidence

### 1. Later-response privacy

The initial clean-start controls passed, but both later-response mutant groups
failed because `assertPrivate()` accepted the leak. The expanded matrix proved
the same gap for capability and capsule, in body and header, through all three
start entry points: twelve failing subcases plus two failing parent tests.

The oracle now records private values at the validated broker START response,
not only when `rig.start()` happens to run. Each value has at most one exact
response identity and field exception. The owner relay forwards the same
response object, so its identity remains one grant while all distinct observed
snapshots remain visible. Later header mutation cannot disappear through
deduplication. Other responses, including later successful STARTs, receive no
exception for an older value. Each scan removes only the permitted decoded
property or the exact state parameter from its validated launch Location.

Review then identified JSON escaping as another way to evade a raw byte scan.
Both escaped later echoes first failed their rejection assertions. Strict
decoding plus normalized scanning killed them. A separate duplicate-key START
case also went red before strict parsing was moved ahead of grant creation.
The final privacy file passed 28/28, including the two mutant parents and their
19 subcases. The final privacy/protocol/E2E integration passed 119/119.

START validation exposed five old harness units whose spies returned empty 204
bodies. Their fixtures now return the declared launch schema; validation was
not weakened. The wrapper returned from 69/5 to 74/0.

### 2. Exact persisted terminal intents

Five new lifecycle controls reached their intended terminal states, then failed
on `assertSchema('ownerIntent', row)` against the actual SQLite rows. They were
not validating constructed samples. The rows retained active context and null
key placeholders and lacked the required terminal receipt projection.

The stored record now contains exactly `protocol`, `intent`, `status`,
`delivery_id`, `envelope_hash` and `receipt`. Both temporary key fields and all
top-level active context are absent. The exact object passed to the writer and
the real SELECT readback must satisfy the closed schema before transaction
commit. Accepted connect, completion and refresh envelopes retain their actual
signed receipts; expiry retains null receipt fields.

Refresh keeps the newest encrypted credentials durable and the uncertainty
fence intact while signing and committing its terminal intent. It clears the
fence only after verified terminal persistence. A failure cannot restore a
consumed refresh token. Callback receipt replay still returns identical bytes
after key destruction and the old deadline; changed delivery bytes refuse and
preserve the rows. All five stored-row tests passed after the fix, and the
complete E2E file passed 17/17.

### 3. Readback-decision witnesses

The enrollment regression first passed its normal 202 control and observed
three failed deliveries, then failed because attempted observations were zero
instead of three. Instrumentation now increments
`enrollmentReadbackAttemptCount` and emits the fixed
`owner.enrollment.readback.attempted` immediately before the injected comparison.
The negative arm requires three events and attempts with no commit or replay.
The control requires one; an identical recovery delivery raises both to four
and commits once. The focused test changed from 0/1 to 1/0.

The expiry regression first failed on its missing attempted observation. The
runtime now increments `intentExpiryReadbackAttemptCount` and emits
`owner.intent.expiry.readback.attempted` immediately before its comparison.
The failing arm uses an event checkpoint and requires exactly one attempt,
zero committed expiries and all 33 pending intents with 66 keys intact.
Recovery produces 33 cumulative attempts after the 32-record batch, then 34
after the final record. A terminal poll changes neither attempt nor committed
count. The terminal/cleanup group changed from 0/6 to 6/0.

## Complete focused test inventory

The abbreviations below are report notation, not shell aliases. Every test
invocation is listed; all runs had zero skips and TODOs. Parallel work tracks
are listed separately, with repeated runs ordered within each track.

| Symbol | Exact expansion |
| --- | --- |
| `N` | `node --import file:///C:/offload/lanes-1023/no-network.mjs` |
| `P` | `protocol/quickbooks-broker/testing/broker-privacy.test.mjs` |
| `Q` | `test/qbo-broker-protocol.test.mjs` |
| `E` | `protocol/quickbooks-broker/probes/broker.e2e.probe.mjs` |
| `B` | `broker/quickbooks/test/broker-security.test.mjs` |
| `G` | `test/test-chain-complete.test.mjs` |
| `R` | `test/test-chain-runner.test.mjs` |

| Privacy sequence | Command | Passed/failed and result |
| --- | --- | --- |
| 1 | `N --test P` | 7/2: initial later body/header echo reds. |
| 2 | `N --test P` | 7/14: all twelve echo subcases plus parents red. |
| 3 | `N --test P` | 7/14: same-object header mutation also exposed. |
| 4 | `N --test P` | 21/0: initial exact response/field fix. |
| 5 | `N --test P` | 25/0: same-response header and repeated-START controls. |
| 6 | `N --test Q` | 69/5: old empty START spy bodies rejected. |
| 7 | `N --test Q` | 74/0: schema-valid spy repair. |
| 8 | `N --test P` | 24/3: two escaped echoes plus parent red. |
| 9 | `N --test P Q` | 101/0: exact decoded-field scan. |
| 10 | `N --test P` | 26/2: duplicate START key plus parent red. |
| 11 | `N --test P Q` | 102/0: strict START decoding. |
| 12 | `N --test P Q E` | 119/0: final privacy/protocol/E2E integration. |

| Other track | Command | Every observed result, passed/failed |
| --- | --- | --- |
| Enrollment | `N --test --test-name-pattern="enrollment readback failure" B` | 0/1 red, then 1/0 green. |
| Terminal/expiry | `N --test --test-name-pattern="E2E terminal intent rows\|E2E pending cleanup" E` | 0/6 red, then 6/0 green. The backslash only escapes the Markdown separator; the actual shell pattern joins the two phrases with a literal pipe. |
| E2E | `N --test E` | 17/0 after terminal replay and source-mutant updates. |
| Idempotent cleanup | `N --test --test-name-pattern="E2E pending cleanup" E` | 1/0 after checking that the last poll adds no attempt. |
| Final foundation | Exact eleven-file command below | 161/0. |
| Final graph | `N --test G R` | 2/0; all 460 inventoried files scheduled, no exemptions. |

The required final command was:

```text
node --import file:///C:/offload/lanes-1023/no-network.mjs --test broker/quickbooks/test/provider.test.mjs broker/quickbooks/test/crypto.test.mjs broker/quickbooks/test/store.test.mjs broker/quickbooks/test/boundary.test.mjs broker/quickbooks/test/broker-security.test.mjs broker/quickbooks/test/callback-quota.test.mjs broker/quickbooks/test/revoke-quota.test.mjs broker/quickbooks/test/routes.test.mjs protocol/quickbooks-broker/testing/broker-privacy.test.mjs protocol/quickbooks-broker/probes/broker.e2e.probe.mjs test/qbo-broker-protocol.test.mjs
```

It was followed by:

```text
node --import file:///C:/offload/lanes-1023/no-network.mjs --test test/test-chain-complete.test.mjs test/test-chain-runner.test.mjs
```

Guarded `N --check <file>` passed twice each for the owner runtime, E2E file,
privacy harness, harness unit file and privacy test file: once during focused
work and once on final bytes. It passed once for the broker security test on
final bytes. These were eleven syntax-check invocations total.
`git diff --check` passed during both implementation tracks and final review.
Added-line language, profile-path, email and private-material review passed.
Only the listed source, test, documentation and report files changed.

## Named mutants and kill proof

Every mutant first runs its passing unmodified control. All three execute in
the final eleven-file command.

| Mutant | Alteration and proof |
| --- | --- |
| `LATER_RESPONSE_BODY_ECHO` | Eleven subcases echo a capability or capsule from an earlier response through helper/raw owner/raw broker paths, try to reuse an earlier grant in a fresh START, encode later echoes, or introduce an escaped duplicate START key. The original oracle missed echoes; the final oracle rejects the precise privacy or unambiguous-JSON assertion. |
| `LATER_RESPONSE_HEADER_ECHO` | Eight subcases echo capability/capsule in later headers or mutate the same START Response during owner relay. Clean privacy controls pass; every echo fails the exact response/field privacy assertion, including snapshots recorded before and after header mutation. |
| `OVERDUE_INTENT_KEEPS_KEYS` | Updated existing source mutant merges the active row into the terminal expiry projection, retaining context and keys. The real runtime passes the deadline control. The mutant is rejected by actual terminal schema validation before commit, and the shared expiry invariant fails with exactly `deadline cleanup must return verified status`. This is a schema refusal, not a claimed post-commit key-count failure. |

## Prepared commit

Subject: `Close broker privacy gaps and validate terminal owner intents`

Body:

```text
Bind private response exceptions to one response and exact decoded field.
Validate actual terminal intent rows and readbacks, preserve signed receipt
replay, and witness enrollment and expiry readback attempts.

Record red-to-green evidence, 161 focused tests, two graph checks and three
killed mutants. Keep all provider transport injected and production closed.
```

The operator can rerun the listed commands and commit the working-tree changes
on `partner/qbo-broker-foundation-4`. No commit or push was attempted because
the run explicitly makes Git metadata read-only. No requested item remains.

## Operator note

The Codex sandbox on this Windows machine makes `.git` read-only, so the lane could not commit. The operator (Claude Code) re-ran on the unchanged working tree: the eleven-file command with the network guard gave 161 passed, 0 failed, with the guard active and nothing blocked. `node --test test/test-chain-complete.test.mjs test/test-chain-runner.test.mjs` gave 2/2. The round 4 mutant tests run inside those commands and pass, so each was killed. The owner runtime calls `assertSchema('ownerIntent', ...)` on the stored rows. `git diff --check` is clean. Names, banned-word, email, user-path and key scan: none. The operator made the prepared commit unchanged and added the Codex co-author trailer. No code was edited by the operator.

LANE QBO-BROKER-FOUNDATION-4: READY
