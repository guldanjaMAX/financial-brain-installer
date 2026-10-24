# QBO-BROKER-FOUNDATION-6 report

Request-side privacy registration is complete. The final required eleven-file
command passed **198 tests, 0 failures, 0 skips, 0 TODOs**. Both graph checks
passed and confirmed all **460** inventoried files are scheduled. The final
explicit mutant command passed **13/13**, killing all three new named mutants.
Schema copy equality and the existing annotation-coverage check remain green.

Observed branch: `partner/qbo-broker-foundation-6`. Starting commit: `939f21c`.
The round 5 report was read first, followed by the read-only design contract and
repository documentation. Independent review checked request annotations,
registration order, retained response grants, enrollment and malformed probes.

All changes remain in the working tree for the operator. No Git metadata write,
commit, push, network action, dependency installation, full test chain or live
account operation ran. Every Node invocation used the mandatory network guard.
Provider transport remained injected into the fake provider. No scratch tree
was created; existing synthetic SQLite helpers use `%TEMP%`. Final tests and
syntax checks finished at approximately **11:02 MST on 2026-10-24**, before the 14:00 cutoff.
Production remains closed.

## Changed files

| File and line | Change |
| --- | --- |
| `protocol/quickbooks-broker/probes/harness.mjs:21` | Share schema traversal between response grants and request registration; conservatively collect decoded private leaves from intentional malformed probes. |
| `protocol/quickbooks-broker/probes/harness.mjs:43` | Decode exact form/query fields without duplicate-key collapse. |
| `protocol/quickbooks-broker/probes/harness.mjs:210` | Validate the exact private owner enrollment-challenge reply separately from outward responses. |
| `protocol/quickbooks-broker/probes/harness.mjs:317` | Validate each declared request before handler entry; register request-private values without a new response grant; require explicit invalid-probe intent and real refusal. |
| `protocol/quickbooks-broker/probes/harness.mjs:377` | Send enrollment through the common request boundary. |
| `protocol/quickbooks-broker/implementation-adapter.mjs:67` | Give enrollment an injected send transport, defaulting to the injected owner transport. |
| `protocol/quickbooks-broker/probes/harness.unit.mjs:11` | Use schema-valid START fixtures and test four request-validation bypass cases with controls. |
| `protocol/quickbooks-broker/testing/broker-privacy.test.mjs:28` | Add the START request-key mutant with real-handler counters, exact/embedded echoes and malformed refusal echoes. |
| `protocol/quickbooks-broker/testing/broker-privacy.test.mjs:123` | Add the enrollment request-challenge echo mutant after a successful real-handler control. |
| `protocol/quickbooks-broker/probes/broker.e2e.probe.mjs:33` | Identify deliberate invalid requests explicitly; preserve reached observations and provider/state assertions. Additional sites are lines 95, 439 and 496. |
| `broker/quickbooks/test/callback-quota.test.mjs:14` | Explicitly send malformed query probes while preserving the successful connection control and real quota counter. |
| `broker/quickbooks/test/routes.test.mjs:12` | Explicitly send wrong-method probes while preserving health control, actual 405 responses and zero provider attempts. |
| `protocol/quickbooks-broker/probes/README.md:64` | Document request validation, no-grant registration, malformed probes and the private enrollment reply boundary. |
| `protocol/quickbooks-broker/v1/PROTOCOL.md:43` | Document request privacy registration and request/response annotation coverage. |
| `partner-reports/qbo-broker-foundation-6.md:1` | Evidence and prepared commit. |

No broker runtime handler, provider implementation, deployed route, storage
migration, manifest, package version or publication allowlist changed.

## Privacy behavior and scope

The wire contract selects each request schema. JSON controls, form launch and
callback queries are decoded and validated before the real handler runs.
Annotated request values enter the private-value registry with no response
permission. The response-side schema grant cannot override that registration,
and the per-value scan also rejects a request key embedded within a different
valid capability that has its own field grant.

A request may reuse a capability, capsule or state already issued under an
earlier exact response grant. Registration does not create another grant or
erase the earlier legitimate issuance. The existing one-response, one-field
restriction still applies to later responses.

Intentional malformed probes set `expectInvalidRequest: true`. That option must
observe invalid input and a real refusal, not a successful handler result.
Decoded private leaves remain protected even if another field is invalid.
Unparseable JSON/form input stops before handler entry even with the option.
Bodyless method probes have no private payload. Callback canaries retain every
raw decoded value, including duplicate query fields.

Enrollment previously called a closed-over broker directly. Its fixture now
uses the same observed boundary. The broker's authenticated GET of the exact
owner enrollment-challenge endpoint intentionally returns the challenge by
protocol contract. That private owner-to-broker reply is schema-checked
separately and receives no outward response grant. All broker responses, direct
owner calls, voucher acknowledgements and callback receipts remain scanned.

No request annotations were missing. The existing check at
`protocol/quickbooks-broker/testing/schema.test.mjs:100` traverses every `$defs`
entry, including request schemas. Its reviewed 22-site inventory at line 23
already includes START's `delivery_auth_key`, refresh and revoke private fields,
launch material, callback values and enrollment challenges. The removal mutant
at line 124 independently removes each marker. The broker-local catalog remains
exactly equal to the protocol catalog.

## Red-to-green evidence

The initial START run passed the unmodified start control, then failed all four
exact/embedded broker/owner echo cases and their parent: **1 passed, 5 failed**.
Each case had two wrapper calls, two successful real-handler responses and one
mutation. Both original and mutated launch responses satisfied the schema.
After request registration, all four cases reject the leak. The exact broker
echo fails grant acquisition; an owner catch cannot hide the recorded leak.
Embedded echoes fail the independent privacy scan.

The enrollment mutant initially failed **0/1** because the old fixture bypassed
the wrapper. It now proves a real successful enrollment reached the wrapper,
then rejects its echoed challenge header. The successful control remains green.

The request-validation mutant initially failed **0/4**: missing private field,
unknown field and duplicate field all reached the accepting handler. It now
blocks each before handler entry. A later uninspectable malformed-input opt-in
case first failed **3/2**, then passed **5/0** after that opt-in was closed too.
Each case first passes an unchanged schema-valid request and privacy check.

Review added malformed START body/header echoes. The four earlier START cases
passed, but those two new cases and their parent failed: **4/3**. Registering
decoded private leaves despite overall schema failure killed both echoes.

The first combined harness/E2E/privacy run found twelve old fixtures that needed
the new contract: **76/12**. A subsequent run was interrupted during oversized
request inspection because canceling a cloned bounded reader could wait for its
unread handler branch. The harness now snapshots finite synthetic fixture bytes
before checking size and schema; production bounded parsing is unchanged.
After fixture updates and request-reader correction, the three files passed
**90/0**. A callback-only diagnostic also passed **1/0**.

The first eleven-file run passed **196/198** and exposed the remaining malformed
callback-quota and wrong-method fixtures. Their explicit invalid-probe updates
passed **2/2**, preserving the real 405 and quota assertions. The final
eleven-file run passed **198/198**.

## Complete test inventory

Symbols below are report notation, not shell variables. Every command used `N`.
Counts include subtests and parent tests. Completed runs had zero skips and TODOs.

```text
N = node --import file:///C:/offload/lanes-1023/no-network.mjs
P = protocol/quickbooks-broker/testing/broker-privacy.test.mjs
U = protocol/quickbooks-broker/probes/harness.unit.mjs
E = protocol/quickbooks-broker/probes/broker.e2e.probe.mjs
S = protocol/quickbooks-broker/testing/schema.test.mjs
C = broker/quickbooks/test/crypto.test.mjs
M = "START_REQUEST_PRIVATE_ECHO|ENROLLMENT_REQUEST_PRIVATE_ECHO|REQUEST_SCHEMA_BYPASS"
```

| Run | Command after symbol expansion | Passed/failed or result |
| --- | --- | --- |
| Schema review | `N --test --test-name-pattern="private schema\|PRIVATE_ANNOTATION_REMOVED" S` | 3/0; all 22 removal cases checked. |
| Copy review | `N --test --test-name-pattern="vendored closed catalog" C` | 1/0; exact equality. |
| START red | `N --test --test-name-pattern="clean starts\|START_REQUEST_PRIVATE_ECHO" P` | 1/5. |
| Enrollment red | `N --test --test-name-pattern="ENROLLMENT_REQUEST_PRIVATE_ECHO" P` | 0/1. |
| Validation red | `N --test --test-name-pattern=REQUEST_SCHEMA_BYPASS U` | 0/4. |
| Initial green mutants and control | `N --test --test-name-pattern="clean starts\|START_REQUEST_PRIVATE_ECHO\|ENROLLMENT_REQUEST_PRIVATE_ECHO\|REQUEST_SCHEMA_BYPASS" P U` | 11/0. |
| Combined fixtures 1 | `N --test U E P` | 76/12; obsolete invalid fixtures. |
| Combined fixtures 2 | `N --test U E P` | Interrupted during oversized inspection; partial output 7 passed, 1 failed, no final totals. |
| Callback diagnostic | `N --test --test-name-pattern="E2E callback" E` | 1/0. |
| Malformed START red | `N --test --test-name-pattern="START_REQUEST_PRIVATE_ECHO" P` | 4/3. |
| Combined green | `N --test U E P` | 90/0. |
| Uninspectable opt-in red | `N --test --test-name-pattern=REQUEST_SCHEMA_BYPASS U` | 3/2. |
| Uninspectable opt-in green | Same command | 5/0. |
| Foundation 1 | Eleven-file command below | 196/2; two remaining invalid fixtures. |
| Graph 1 | Graph command below | 2/0; 460 files covered. |
| Mutants 1 | `N --test --test-name-pattern=M P U` | 13/0. |
| Remaining fixture green | `N --test broker/quickbooks/test/callback-quota.test.mjs broker/quickbooks/test/routes.test.mjs` | 2/0. |
| Final foundation | Eleven-file command below | 198/0. |
| Final graph | Graph command below | 2/0; 460 files covered. |
| Final mutants | `N --test --test-name-pattern=M P U` | 13/0. |

Final required commands:

```text
node --import file:///C:/offload/lanes-1023/no-network.mjs --test broker/quickbooks/test/provider.test.mjs broker/quickbooks/test/crypto.test.mjs broker/quickbooks/test/store.test.mjs broker/quickbooks/test/boundary.test.mjs broker/quickbooks/test/broker-security.test.mjs broker/quickbooks/test/callback-quota.test.mjs broker/quickbooks/test/revoke-quota.test.mjs broker/quickbooks/test/routes.test.mjs protocol/quickbooks-broker/testing/broker-privacy.test.mjs protocol/quickbooks-broker/probes/broker.e2e.probe.mjs test/qbo-broker-protocol.test.mjs
node --import file:///C:/offload/lanes-1023/no-network.mjs --test test/test-chain-complete.test.mjs test/test-chain-runner.test.mjs
node --import file:///C:/offload/lanes-1023/no-network.mjs --test --test-name-pattern="START_REQUEST_PRIVATE_ECHO|ENROLLMENT_REQUEST_PRIVATE_ECHO|REQUEST_SCHEMA_BYPASS" protocol/quickbooks-broker/testing/broker-privacy.test.mjs protocol/quickbooks-broker/probes/harness.unit.mjs
```

Seven final syntax checks, each `N --check <file>`, passed for the adapter,
`harness.mjs`, `harness.unit.mjs`, `broker.e2e.probe.mjs`,
`broker-privacy.test.mjs`, `callback-quota.test.mjs` and `routes.test.mjs` at
the paths listed above. All printed the active guard marker. No ad-hoc provider
or connector probe ran. `git diff --check` passed throughout review and on the
final working tree. Only the listed source/test/docs and this report changed.

## Named mutants and kill proof

| Mutant | Passing control and kill proof |
| --- | --- |
| `START_REQUEST_PRIVATE_ECHO` | Six cases. Four wrap real START and replace or embed the captured request `delivery_auth_key` in schema-valid `launch_capability` through broker and owner entry points. Each proves two wrapper calls, two real successful handlers and one mutation. Two additional cases echo the key through the real malformed-request refusal body/header after a successful same-wrapper control. All independently fail the privacy scan; exact raw broker substitution also fails grant acquisition. |
| `ENROLLMENT_REQUEST_PRIVATE_ECHO` | Unmodified successful enrollment and privacy control pass. The wrapper then captures the next request challenge, proves one real successful handler call and returns a challenge header. The privacy scan rejects it. |
| `REQUEST_SCHEMA_BYPASS` | Four cases start with an unchanged valid request and privacy control. Missing, unknown, duplicate and uninspectable opt-in requests all fail validation before the accepting handler runs; the wrapper counter stays zero. |

All three run inside the final foundation command and the explicit final mutant
command. Captured values remain in memory and never enter assertion diagnostics.

## Prepared commit

Subject: `Block broker response grants for private request values`

Body:

```text
Validate declared requests before broker entry and register private request
values without response grants. Route enrollment through the same boundary
and keep malformed refusal probes explicit and private.

Add real-handler START and enrollment echo mutants plus request-validation
controls. Record 198 focused tests, two graph checks and three killed mutants.
```

The operator can rerun the listed commands and commit the working-tree changes
on `partner/qbo-broker-foundation-6`. No commit or push was attempted because
this run explicitly makes Git metadata read-only.

## Operator note

The Codex sandbox on this Windows machine makes `.git` read-only, so the lane could not commit. The operator (Claude Code) re-ran on the unchanged working tree: the eleven-file command with the network guard gave 198 passed, 0 failed, with the guard active and nothing blocked. `node --test test/test-chain-complete.test.mjs test/test-chain-runner.test.mjs` gave 2/2. The round 6 mutant tests run inside those commands and pass, so each was killed. `git diff --check` is clean. Names, banned-word, email, user-path and key scan: none. The operator made the prepared commit unchanged and added the Codex co-author trailer. No code was edited by the operator.

LANE QBO-BROKER-FOUNDATION-6: READY
