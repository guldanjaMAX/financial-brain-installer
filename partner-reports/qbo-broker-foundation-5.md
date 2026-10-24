# QBO-BROKER-FOUNDATION-5 report

The schema-driven privacy fix is complete. The final eleven-file command passed
**185 tests, 0 failures, 0 skips, 0 TODOs**. Both test-graph checks passed and
confirmed all **460** inventoried files are scheduled. The final explicit mutant
run passed **17/17**, killing all three new named mutants. The broker-local
schema remains exactly equal to the protocol catalog. Production remains closed.

Observed branch: `partner/qbo-broker-foundation-5`. Starting commit: `cbe012c`.
The round 4 report was read first, followed by the read-only design contract and
required repository documentation. Independent review checked schema coverage,
response identity, exact field grants and caught validation failures.

All changes remain in the working tree for the operator. No Git write, commit,
push, dependency installation, full test chain, live account, external DNS or
network action ran. Every Node invocation loaded the mandatory network guard.
Broker/provider transport stayed injected into the fake provider. No scratch
tree was created; existing synthetic test helpers use `%TEMP%`. Final test runs
finished around 10:34 MST on 2026-10-24, before the 14:00 cutoff.

## Changed files

| File and line | Change |
| --- | --- |
| `protocol/quickbooks-broker/v1/schemas/protocol.schema.json:84` | Add 22 reviewed scalar `x-private: true` annotations. |
| `broker/quickbooks/src/protocol-schema.mjs:85` | Preserve the equal broker-local schema copy. |
| `broker/quickbooks/src/validation.mjs:17` | Permit the annotation only when true and attached to an effective string schema. |
| `protocol/quickbooks-broker/testing/schema-test-helper.mjs:20` | Enforce the same annotation contract in the test validator. |
| `protocol/quickbooks-broker/testing/schema.test.mjs:23` | Reviewed annotation inventory, sensitive-name rule and closed public-field inventory; line 124 removes every annotation independently. |
| `protocol/quickbooks-broker/probes/harness.mjs:16` | Traverse references, matching alternatives and arrays for private values; line 260 validates successful broker JSON responses using the wire declaration; line 412 removes only the granted field during scanning. Caught validation failures remain permanently visible. |
| `protocol/quickbooks-broker/probes/harness.unit.mjs:13` | Generic traversal, route-schema completeness, caught-failure and repaired-response regressions. Existing spies now return valid health or callback shapes. |
| `protocol/quickbooks-broker/testing/broker-privacy.test.mjs:27` | Real successful refresh helper; line 68 tests owner and raw broker controls; line 83 defines the two refresh echo mutants. Existing health echoes still require an independent privacy rejection after shape rejection. |
| `protocol/quickbooks-broker/probes/broker.e2e.probe.mjs:163` | Successful refresh control now calls `assertPrivate()`. |
| `protocol/quickbooks-broker/v1/wire-contract.json:5` | Declare the existing status-only enrollment acknowledgement using `errorResponse`. No response bytes changed. |
| `protocol/quickbooks-broker/probes/README.md:59` | Document automatic schema registration, exact grants, retained failures and coverage checks. |
| `protocol/quickbooks-broker/v1/PROTOCOL.md:42` | Document annotation semantics and the enrollment acknowledgement declaration. |
| `partner-reports/qbo-broker-foundation-5.md:1` | Evidence and prepared commit. |

No broker handler, owner storage behavior, deployed route, migration, CLI,
manifest, package version, publication allowlist or connector availability
changed. The runtime validator only gains support for the reviewed annotation.

## Class fix and privacy classification

The harness no longer names START response private fields. Every successful
broker JSON response is strictly decoded, validated against its route's declared
schema, and traversed for `x-private` leaves. References, matching `oneOf` and
`anyOf` branches, `allOf`, nested objects and array indices are supported.
Duplicate paths from combined schemas produce one grant. Each private value
can belong to exactly one Response identity and one field path. Another response
cannot acquire a second grant for the same value.

All recorded response bodies and headers remain scanned, including owner status,
refusals and distinct snapshots of the same Response. Only the exact permitted
decoded field is removed for its own value's scan. Strict JSON decoding still
rejects duplicate keys and exposes escaped echoes. Redirects and the static HTML
result page remain scanned under their existing non-JSON contracts; the exact
validated provider launch state parameter retains its existing narrow exception.

Validation happens after recording the response. A caught validation assertion
cannot turn an invalid observation into a privacy pass. Once a recorded Response
fails, later successful validation of the same object cannot erase that failure.

"Every private field" is decided by **both review and naming rules**:

- An exact reviewed list identifies all 22 annotation sites.
- Sensitive names cover ciphertext, secret, private-key, raw token, launch
  capability, realm, state, challenge, authorization code and delivery auth key.
- Every other property name must belong to a closed reviewed non-credential
  inventory. New unknown names require classification rather than silently
  becoming public. `errorResponse.code` is an explicit exception constrained to
  the reviewed public outcome schema.

This is an auditable classification contract, not semantic inference from
arbitrary field content. Generic capability/digest types also encode recurring
public bindings and are not marked wholesale. Stored credential and private-key
containers inherit the marker from `storedCiphertext.ciphertext`. Raw realm
fields inherit the `realmId` definition. Public binding/authentication metadata
continues to obey its existing broker retention rules.

The annotated sites are:

```text
storedCiphertext.ciphertext
enrollmentChallenge.challenge
enrollmentIssue.challenge
enrollmentDelivery.challenge
startBody.delivery_auth_key
refreshBody.refresh_token
refreshBody.delivery_auth_key
revokeBody.token
launchRequest.launch_capability
launchResponse.launch_capability
callbackSuccess.state
callbackSuccess.code
callbackDenied.state
deliveryEnvelope.ciphertext
refreshResponse.ciphertext
tokenBundle.access_token
tokenBundle.refresh_token
realmId
transactionPayload.state
transactionPayload.delivery_auth_key
transactionCapsule.ciphertext
completionEnvelope.ciphertext
```

## Red-to-green evidence

The initial refresh run passed its successful-refresh control but failed all
14 echo/reuse subcases and both mutant parents: **1 passed, 16 failed**. Each
negative reached the real successful refresh and failed with a missing expected
rejection. After automatic schema registration, the same command passed **17/17**.
The complete privacy file then passed **45/45**. The E2E successful-refresh
control also passed with its new privacy assertion.

Schema coverage first failed **0/3** because the reviewed private fields lacked
annotations. After marking the 22 leaves and supporting the keyword in both
validators, schema plus boundary tests passed **25/25**. Crypto tests passed
**9/9**, including exact catalog equality. Missing, false and non-string
annotations are rejected, as are new private and unclassified names.

Three harness regressions first failed **0/3**: the generic traversal was absent,
the successful enrollment response had no declared schema, and caught success
validation errors were not retained. They passed **3/3** after implementation.
The protocol wrapper then exposed three obsolete success spies, **77/3**;
schema-valid health/callback controls and explicit privacy rejection assertions
returned it to **80/0** without weakening validation.

Independent review found that reobserving the same Response after repairing its
Content-Type could clear an earlier failure. A passing clean control followed
by that repair first failed **0/1** with a missing expected rejection. Failure
state now only changes to failed and never clears; the same regression passed
**1/1**. The final protocol wrapper, included in the eleven-file run, passed
with all four new harness regressions.

## Complete test inventory

The following symbols are report notation only. Every invocation used `N`:

```text
N = node --import file:///C:/offload/lanes-1023/no-network.mjs
P = protocol/quickbooks-broker/testing/broker-privacy.test.mjs
S = protocol/quickbooks-broker/testing/schema.test.mjs
U = protocol/quickbooks-broker/probes/harness.unit.mjs
E = protocol/quickbooks-broker/probes/broker.e2e.probe.mjs
Q = test/qbo-broker-protocol.test.mjs
B = broker/quickbooks/test/boundary.test.mjs
C = broker/quickbooks/test/crypto.test.mjs
RF = "successful refresh keeps|REFRESH_CIPHERTEXT"
SC = "private schema|PRIVATE_ANNOTATION_REMOVED"
HU = "private response fields|every successful broker JSON|successful response schema refusals"
HR = "reobserving a repaired response"
M = "REFRESH_CIPHERTEXT|PRIVATE_ANNOTATION_REMOVED"
```

Sequences are ordered within each independent track. Counts include subtests and
parent tests as reported by Node. All runs had zero skips and TODOs.

| Track | Exact command after symbol expansion | Passed/failed and result |
| --- | --- | --- |
| Refresh 1 | `N --test --test-name-pattern=RF P` | 1/16 red. |
| Refresh 2 | Same command | 17/0 green. |
| Refresh 3 | `N --test --test-name-pattern="E2E refresh" E` | 1/0. |
| Refresh 4 | `N --test P` | 45/0. |
| Schema 1 | `N --test --test-name-pattern=SC S` | 0/3 red. |
| Schema 2 | `N --test S B` | 25/0 green. |
| Schema 3 | `N --test C` | 9/0, including catalog equality. |
| Harness 1 | `N --test --test-name-pattern=HU U` | 0/3 red. |
| Harness 2 | Same command | 3/0 green. |
| Harness 3 | `N --test Q` | 77/3, obsolete success spies. |
| Harness 4 | Same command | 80/0 after fixture corrections. |
| Harness 5 | `N --test --test-name-pattern=HR U` | 0/1 red. |
| Harness 6 | Same command | 1/0 green. |
| Final foundation | Exact command below | 185/0. |
| Final graph | Exact command below | 2/0; 460 files, no exemptions. |
| Final new mutants | `N --test --test-name-pattern=M P S` | 17/0, all three mutants killed. |

The final required commands were:

```text
node --import file:///C:/offload/lanes-1023/no-network.mjs --test broker/quickbooks/test/provider.test.mjs broker/quickbooks/test/crypto.test.mjs broker/quickbooks/test/store.test.mjs broker/quickbooks/test/boundary.test.mjs broker/quickbooks/test/broker-security.test.mjs broker/quickbooks/test/callback-quota.test.mjs broker/quickbooks/test/revoke-quota.test.mjs broker/quickbooks/test/routes.test.mjs protocol/quickbooks-broker/testing/broker-privacy.test.mjs protocol/quickbooks-broker/probes/broker.e2e.probe.mjs test/qbo-broker-protocol.test.mjs
node --import file:///C:/offload/lanes-1023/no-network.mjs --test test/test-chain-complete.test.mjs test/test-chain-runner.test.mjs
node --import file:///C:/offload/lanes-1023/no-network.mjs --test --test-name-pattern="REFRESH_CIPHERTEXT|PRIVATE_ANNOTATION_REMOVED" protocol/quickbooks-broker/testing/broker-privacy.test.mjs protocol/quickbooks-broker/testing/schema.test.mjs
```

Guarded `N --check <file>` passed twice each for `schema.test.mjs`,
`schema-test-helper.mjs`, broker `validation.mjs` and `protocol-schema.mjs`:
once during schema work and once on final bytes. It passed once on final bytes
for `harness.mjs`, `harness.unit.mjs`, `broker.e2e.probe.mjs` and
`broker-privacy.test.mjs`. These were twelve syntax-check invocations total.
One guarded ad-hoc stdin module wrote the annotation sites and equal local copy.
No unguarded Node probe ran. `git diff --check` passed during both implementation
tracks and final review. Added-line language, profile-path, address and private
material review passed. Only the listed files changed.

## Named mutants and kill proof

Every mutant first passes an unmodified control. All three run both inside the
final eleven-file command and the final explicit mutant command.

| Mutant | Alteration and proof |
| --- | --- |
| `REFRESH_CIPHERTEXT_BODY_ECHO` | Six cases echo real refresh ciphertext through later health, owner status or broker refusal bodies after owner/raw broker refreshes. A seventh reuses it in another successful refresh's ciphertext field. Each is rejected by the exact privacy scan or single-field grant invariant. Health body schema rejection is followed by a separate required privacy rejection, so schema rejection cannot mask missing registration. |
| `REFRESH_CIPHERTEXT_HEADER_ECHO` | Six cases echo the ciphertext through later health, status or refusal headers after both refresh entry points. A seventh puts fresh ciphertext in the same refresh response's header. All seven fail the privacy assertion outside the one granted body field. |
| `PRIVATE_ANNOTATION_REMOVED` | After a passing classification control, independently removes each of the 22 markers. Every altered catalog fails the same reviewed private-field assertion. The refresh ciphertext marker is explicitly among these removals. |

## Prepared commit

Subject: `Derive broker response privacy grants from schema annotations`

Body:

```text
Annotate private protocol fields and validate successful broker JSON responses
before granting one exact response field exception. Preserve caught schema
failures across response reuse and scan refresh ciphertext in later output.

Add successful-refresh controls, body/header echo mutants and complete
annotation coverage. Record 185 focused tests, two graph checks, equal schema
copies and three killed mutants while keeping provider transport injected.
```

The operator can rerun the listed commands and commit the working-tree changes
on `partner/qbo-broker-foundation-5`. No commit or push was attempted because
this run explicitly makes Git metadata read-only. No requested work remains.

## Operator note

The Codex sandbox on this Windows machine makes `.git` read-only, so the lane could not commit. The operator (Claude Code) re-ran on the unchanged working tree: the eleven-file command with the network guard gave 185 passed, 0 failed, with the guard active and nothing blocked. `node --test test/test-chain-complete.test.mjs test/test-chain-runner.test.mjs` gave 2/2. The schema carries 22 `x-private` annotations, and the round 5 mutant tests run inside those commands and pass, so each was killed. The base of this branch is lanes 5 and 6 rounds 1-4, recreated with identical trees plus the Codex trailer. `git diff --check` is clean. Names, banned-word, email, user-path and key scan: none. The operator made the prepared commit unchanged and added the Codex co-author trailer. No code was edited by the operator.

LANE QBO-BROKER-FOUNDATION-5: READY
