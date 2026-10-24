# QBO-BROKER-PROTOCOL lane report

Step 1 is ready for review: a versioned offline protocol, state machine, JSON
schemas, fake Intuit, passing unit tests, and deliberately failing integration
probes. This is not an implemented or deployed broker. Production stays closed.

Working branch: `partner/qbo-broker-protocol-1`.
Observed starting commit: `f8a7cd05a1e641d29d5b3af77fc91901a5281639`.
The supplied working-copy instruction takes precedence over older base pins in
the lane packet. All deliverable changes remain in the working tree for the
operator. No commit, push, checkout, stash, release, or live provider action was
performed. No dependency installation, full test chain or release test was run.

## Added and changed files

| File | Purpose |
| --- | --- |
| `protocol/quickbooks-broker/README.md` | Entry point, scope, focused commands, explicit red-probe exclusion. |
| `protocol/quickbooks-broker/v1/PROTOCOL.md` | Normative draft: custody, routes, encodings, authentication, enrollment, launch, exchange, delivery, completion, refresh, revoke, SSRF, replay, privacy and limits. |
| `protocol/quickbooks-broker/v1/wire-contract.json` | Machine-readable version, seven API routes, owner routes, limits, quotas, crypto domains and HKDF labels. |
| `protocol/quickbooks-broker/v1/state-machine.json` | Five logical state machines and required evidence for every transition. |
| `protocol/quickbooks-broker/v1/schemas/protocol.schema.json` | Closed JSON Schema 2020-12 catalog with 66 named definitions. |
| `protocol/quickbooks-broker/testing/protocol.test.mjs` | Five protocol/cryptographic fixture units using generated keys and Node primitives. |
| `protocol/quickbooks-broker/testing/state-machine-model.mjs` | Test-only table interpreter; no I/O or broker implementation. |
| `protocol/quickbooks-broker/testing/state-machine.test.mjs` | Eleven state units, all-edge controls and missing/false guard refusals. |
| `protocol/quickbooks-broker/testing/schema-test-helper.mjs` | Test-only strict schema subset validator and runtime fixture builder. |
| `protocol/quickbooks-broker/testing/schema.test.mjs` | Sixteen schema units, including 34 top-level schema controls and privacy refusals. |
| `protocol/quickbooks-broker/testing/fake-intuit.mjs` | In-memory Request/Response provider double with injected time and scripted faults. |
| `protocol/quickbooks-broker/testing/fake-intuit.test.mjs` | Twenty-one fake provider units. |
| `protocol/quickbooks-broker/probes/harness.mjs` | Offline transport, request/form builders, exact retained-schema checks, canary scans and reached/order assertions. |
| `protocol/quickbooks-broker/probes/harness.unit.mjs` | Nine green tests of the probe harness itself. |
| `protocol/quickbooks-broker/probes/broker.e2e.probe.mjs` | Nine explicit E2E gates; each currently fails for the missing implementation adapter. |
| `protocol/quickbooks-broker/probes/README.md` | Adapter interface, fault injection, observations and attack inventory. |
| `test/qbo-broker-protocol.test.mjs` | Green wrapper importing only units, plus registration/exclusion/package-boundary assertion. |
| `scripts/run-test-chain.mjs` | Two list entries register the green wrapper in the ordered graph and its post-launcher projection. |
| `partner-reports/qbo-broker-protocol.md` | This report and prepared commit. |

No CLI, deployed Worker, migration, manifest, connector behavior, package version,
lockfile, publication allowlist, or owner availability copy changed. The existing
allowlist excludes protocol files, tests and partner reports from publication.
The existing production refusal remains in place.

## Protocol version and decisions

Wire version is **`qbo-broker/1`**, with `/v1/quickbooks/` routes. This is a new
protocol despite the existing local callback envelope also having version 1.
It must never reuse migration 0032 as broker storage.

The broker holds the shared app secret durably and sees credentials only
transiently. Domain-separated HKDF keys protect its capsule, cookie, voucher,
audit hashes, network quotas and no-contact proofs. Durable broker objects
allow only non-content audit, replay and quota metadata. Accounting traffic
goes directly from owner Worker to fake/provider; the broker has no data route.

Review resolved several wire gaps without changing those custody boundaries:

- A random launch capability alone cannot reconstruct a callback without a
  registry. A separate sealed browser transaction capsule carries the voucher,
  callback, delivery key and operation context across broker restarts.
- Real browser launch uses an exact top-level form POST followed by 303.
  Background JSON fetch is not treated as navigation.
- Public-key encryption does not prove the broker sent an envelope. A separate
  owner-generated one-time delivery authentication key supplies a sender MAC.
  It lives only in encrypted owner operation state, sealed browser context and
  transient broker memory; it is not a second durable broker secret.
- Authenticated encrypted completion notices carry cancellation/failure without
  token fields or result-page queries. Owner status requires a committed result
  and signed receipt. Exact duplicate receipts survive ephemeral key destruction.
- Signed start and capsule carry the owner's expected token generation;
  source reservation and generation remain authoritative in owner D1.
- Enrollment challenge retrieval requires the confidential capability from the
  approved owner-to-operator ceremony. Public HTTPS alone is not accepted as
  broker-to-owner authentication for voucher delivery.
- A no-contact retry uses a fresh request ID with the same revoke operation.
  Original not_sent to proof_consumed and the new revoke_started fence must
  commit atomically. An uncertain attempted request never earns this proof.
- The existing opaque realm syntax and hex company fingerprint remain intact.
  Refresh carries the owner realm transiently because provider token responses
  need not echo it. The broker cannot independently know owner D1 generation.

These are review choices, not Intuit acceptance evidence. Retention, Access
policy, real DNS pinning, observability, rotation, deployment and production
canary gates remain required by the governing design.

## State machines

| Machine | Main path and refusal behavior |
| --- | --- |
| enrollment | unenrolled -> challenged -> issued; verified Access, live protected challenge, exact callback/key, one-use fence and verified delivery are prerequisites. Refusal never issues a voucher. |
| authorization | new -> launch_pending -> launched -> exchange_started -> delivery_pending -> delivered. Launch is one use. State/cookie/config/expiry and a committed exchange fence precede contact. Cancellation, expiry and failure terminate exchange authority. Unconfirmed delivery enters in-memory cleanup with confirmed or uncertain revoke. |
| token_request | new -> started -> confirmed/rejected/uncertain. No-contact refusal enters not_sent; exact proof consumption moves it once to proof_consumed while authorizing a new fenced request. No old provider attempt restarts. |
| owner_intent | pending -> saved -> complete, or canceled/failed/expired. Only authenticated exact bindings and committed readback produce receipts. Complete/canceled/failed permit identical receipt replay after key destruction; changed bytes refuse. |
| owner_connection | active -> refresh_fenced -> active only after replacement, company/generation comparison, ciphertext commit and exact readback. Lost, rejected, invalid or expired grants require reauthorization. Disconnect disables reads before revoke_fenced. Confirmed revoke destroys credentials; uncertainty stays disabled. Explicit local destruction never claims remote revocation. |

The table is an executable specification, not a transaction implementation.
Every listed transition has a passing control and tests that remove or falsify
each prerequisite. Logical phases map to the allowed ledger/status phases as
documented; no new database schema is installed.

## Every JSON schema

All definitions live in
`protocol/quickbooks-broker/v1/schemas/protocol.schema.json`, addressed by
`#/$defs/<name>`. Objects are exact-key shapes. The following groups enumerate
all 66 definitions, including shared primitives and unions:

| Group | Definitions and purpose |
| --- | --- |
| Primitive wire values | `protocol` fixes the version; `capability` bounds random identifiers; `digest` is a 32-byte base64url shape; `signature` is ES256 P1363; `timestamp` is an epoch safe integer; `generation` is positive; `environment` separates sandbox/production; `callback` bounds the fixed HTTPS callback shape; `publicKey` forbids private JWK fields. |
| Identity compatibility | `realmId` preserves the connector's opaque realm syntax; `companyFingerprint` preserves its hex SHA-256 source identity. |
| Owner encrypted storage | `storedCiphertext` contains ciphertext, IV, tag, key version and AAD hash; `ownerInstallation` stores the opaque voucher and encrypted installation key. |
| Enrollment | `enrollmentChallenge` carries the signed live ownership challenge; `enrollmentIssue` is the operator's exact issue request; `voucherClaims` binds key/callback/environment/generation/lifetime; `installationVoucher` adds the broker MAC; `enrollmentDelivery` goes only to the verified Worker. |
| Signed control requests | `startBody`, `refreshBody`, `revokeBody` define route-specific payloads; `startRequest`, `refreshRequest`, `revokeRequest` bind method, route, unique ID, clock window, voucher, body hash and signature. |
| No-contact authority | `noContactClaims` binds original operation and not-sent decision; `noContactProof` adds its broker-verifiable MAC. |
| Launch and transient context | `launchRequest` is the decoded exact form shape; `launchResponse` returns capability and capsule; `transactionPayload` is transient context including expected generation; `transactionCapsule` is the sealed launch shape; `transactionCookie` uses the same shape under a separate key. |
| Provider callback | `callbackSuccess` is exact state/code/realm; `callbackDenied` is exact state/access_denied; `callbackQuery` accepts exactly one branch. |
| Token delivery and refresh | `deliveryHeader` and `refreshHeader` bind purpose, install, callback, environment, intent, keys and generations; `deliveryEnvelope` and `refreshResponse` add ECDH/AES-GCM material plus sender MAC; `tokenBundle` contains the transient provider pair, realm, fingerprint and actual expiries. |
| Owner token receipt | `receiptClaims` binds envelope hash and committed readback; `deliveryReceipt` adds the owner's signature. |
| Token-free completion | `completionOutcome` allowlists stable results; `completionHeader` fixes completion purpose; `completionEnvelope` authenticates encrypted status; `completionResult` has only version/outcome; `completionReceiptClaims` binds the status commit; `completionReceipt` adds owner signature. |
| Owner callback unions | `ownerCallbackRequest` distinguishes token versus completion envelopes; `ownerCallbackReceipt` distinguishes their signed receipts. |
| Revocation results | `revokeAttempted` distinguishes confirmed/rejected/uncertain after attempted contact; `revokeNotSent` alone includes retry proof; `revokeResponse` is their exclusive union. |
| Broker durable records | `route`, `phase`, `outcome` are fixed allowlists; `auditEvent`, `replayRow`, `quotaRow` cannot accept payloads, raw callbacks, credentials or ciphertext. |
| Owner operations/status | `ownerIntent` includes encrypted delivery secrets and source/generation expectations; `ownerConnected` stores encrypted credentials; `ownerDisconnected` retains only non-secret reservation/status; `ownerConnection` is their union; `ownerFence` stores mutation uncertainty/lease/generation; `ownerStatus` returns safe status only. |
| Public results | `healthResponse` exposes build/dependency readiness only; `errorResponse` exposes stable code and retry category only. |

Schema shape is not proof of signatures, canonical byte spelling, curve-point
validity, time ordering, DNS safety, atomicity, readback or retention. Those
semantic obligations are explicit in the protocol. The test-only validator
rejects unsupported keywords and unresolved references instead of ignoring them.

## Fake Intuit behavior

The fake has no listener, DNS, filesystem, subprocess, ambient credential read
or network fallback. Its endpoints are reserved `.invalid` origins. Every app
identifier, secret, code, state, company and token fixture is generated in
memory at test time; diagnostics expose only numeric counters.

It supports consent and cancellation; exact client/redirect/scope/state checks;
single-use codes with expiry; token generation and refresh rotation; access,
refresh and hard-refresh expiry using injected time; replay/invalid_grant;
JSON revocation of either token; malformed responses; missing replacement
refresh tokens; inconsistent company echoes; 429 with Retry-After; 503; loss
before provider entry and after provider mutation; and concurrent single-use
operations. Its read-only accounting double preserves the existing 15 entities
and 1,000-row limit, checks Bearer scheme/company/environment/current generation,
and rejects mutation verbs and arbitrary destinations.

`snapshot()` separates attempted, reached and mutated counts. Tests cannot
equate a missing response with proven noncontact. The fake's private in-memory
token maps model provider custody only; they are never broker storage.

## E2E probe inventory and exclusion

All nine named tests are in
`protocol/quickbooks-broker/probes/broker.e2e.probe.mjs`. Each requires a
successful control before its negative cases, reached-guard observations and
provider/owner mutation counters. The future adapter must bind actual handlers,
not return canned observations or use the table oracle as a fake broker.

| Probe | Attacks and failure paths |
| --- | --- |
| E2E connect | Unauthorized enrollment, bad ownership challenge, missing owner authentication, altered request signature/body, extra key, expired launch; restart across start/launch/callback proves context has no hidden registry dependency. |
| E2E callback | Missing/wrong state or cookie, duplicate code, extra query parameter, expired intent, consent cancellation and query/fragment smuggling in completion redirects. |
| E2E code exchange | Missing durable fence, provider rejection, malformed/missing token fields, changed company, lost response, callback outage, bounded identical-envelope retries, cleanup revocation and lost acknowledgement with one owner save. |
| E2E refresh | Missing owner authentication, lost response before/after mutation, rejected/malformed/missing replacement, changed company, readback failure, old-token retry, unnecessary early refresh and racing generation mutations. |
| E2E revoke | Missing owner authentication, reads continuing before revoke, lost/rejected result incorrectly confirmed, repeated contact without proof, no-contact retry authority, credential destruction and preservation of imported records. |
| E2E replay | Reused launch, serial/concurrent callback, signed start/refresh/revoke request replay, duplicate delivery receipt, changed bytes under the same delivery ID. |
| E2E mix-up | Voucher/callback/environment mismatch, another transaction cookie, another owner envelope, wrong intent/key/generations, missing/wrong sender MAC, tampered refresh realm/company/generation and stale voucher generation. |
| E2E SSRF and privacy | Unsafe callback schemes/hosts/ports/credentials/fragments/paths, private DNS, callback redirects, accounting/proxy/token lookup/recovery routes, broker credential/ciphertext retention and response leaks. Direct owner accounting read is the positive control. |
| E2E abuse | Quota/replay store outage, wrong content type, oversized control body, expired signed proof and quota exhaustion. Owner envelope byte limit is also probed. |

Expected command: `node --test protocol/quickbooks-broker/probes/broker.e2e.probe.mjs`.
Current result: exit 1, 0 passed, 9 failed, 0 skipped, 0 TODO. Every failure is
the explicit `BROKER_IMPLEMENTATION_MISSING` assertion. The adapter file is
intentionally absent. No attack has yet reached a real broker guard.

The default chain is explicit, not recursive discovery. Only
`node --test test/qbo-broker-protocol.test.mjs` is registered. That wrapper
imports green units and `harness.unit.mjs`, never `broker.e2e.probe.mjs`.
The red file is under `probes/` with `.probe.mjs`, outside the existing
top-level test-completeness pattern. No default-test exemption or skip was
added. The wrapper asserts these boundaries.

## Focused verification and red-first record

All tests used synthetic local state on Node 24.18.0, on Friday outside the
specified rehearsal pause window. No live account, external DNS or provider
request was used. Commands below are the complete test-command inventory;
repeated runs are recorded under their command.

| Command | Observed results |
| --- | --- |
| `node --test protocol/quickbooks-broker/testing/protocol.test.mjs` | Initial 5 failures for missing wire contract, then 5/5 pass. |
| `node --test protocol/quickbooks-broker/testing/state-machine.test.mjs` | Initial 8 failures for missing table/interpreter, then 8/8. Receipt-after-key-destruction regression: 8 pass/1 fail, then 9/9. Deadline/SSRF/source-retention regression: 9 pass/1 fail, then 10/10. Proof-consumption/completion replay regression: 10 pass/1 fail, then final 11/11. |
| `node --test protocol/quickbooks-broker/testing/schema.test.mjs` | Initial missing-catalog red, then 8/8. Capsule/realm/refresh-proof regressions observed red with 2, 3 and 4 failures respectively, then 11/11. Sender-proof regression: 11 pass/1 fail, then 12/12. Completion and owner reservation regressions: 11 pass/2 fail, then 11 pass/3 fail, then 14/14. Signed target-generation/no-contact phase regressions: 14 pass/2 fail, then final 16/16. |
| `node --test protocol/quickbooks-broker/testing/fake-intuit.test.mjs` | Initial missing-module red, then 18/18. After JSON revoke fix 19/19; after Bearer and concurrent-operation checks final 21/21. |
| `node --test --test-name-pattern="repository provider JSON" protocol/quickbooks-broker/testing/fake-intuit.test.mjs` | Red before the fake was corrected from form to JSON revoke. Its matching control passes in the final suite. |
| `node --test --test-name-pattern="requires the Bearer" protocol/quickbooks-broker/testing/fake-intuit.test.mjs` | Red when a raw token without Bearer was accepted, then corrected; matching control passes in the final suite. |
| `node --test protocol/quickbooks-broker/probes/harness.unit.mjs` | Initial 4/4. Browser credential-leak regression 4 pass/1 fail, then 5/5. Valid audit callback-route regression 4 pass/1 fail, then 5/5. Exact-schema and missing-fence regressions 5 pass/2 fail, then 7/7. Owner-to-broker transport regression 7 pass/1 fail, then 8/8. Form-navigation regression 8 pass/1 fail, then final 9/9. |
| `node --test protocol/quickbooks-broker/probes/broker.e2e.probe.mjs` | Initial and subsequent runs all intentionally red: 9 missing-adapter failures, no skips/TODOs. Final root rerun confirms the same. |
| `node --test test/qbo-broker-protocol.test.mjs` | Registration red: 56 pass/1 fail, including after only the projection list was updated. A concurrent schema-edit run remained red for in-progress schema regressions. After both chain entries and all review fixes, final 63/63 pass, no skips/TODOs. |
| `node test/test-chain-complete.test.mjs` | Pass: all 452 tracked/new candidate top-level test files accounted for; no exemptions. |
| `node test/test-chain-runner.test.mjs` | Pass: graph order/projection, child failures/signals, continuation and short npm entry verified. This tests the runner, not the full chain. |
| `node test/package-privacy.test.mjs` | Aborted with exit 1 and no result output after inspection revealed broader package work and temporary Git fixture setup. Not claimed as passing or as package-install evidence. No rerun. |
| `node --check <file>` | All 12 lane JavaScript modules, wrapper and modified runner checked, pass. Earlier focused agent syntax checks also passed. |
| `git diff --check` | Pass for tracked changes; a separate text scan covers the new files. |

The package-privacy test was stopped rather than allowed to continue its broader
fixture workflow. The attempted process-inspection follow-up was denied by the
sandbox; the execution session itself returned terminated exit 1. No new
repository artifact appeared in `git status`. The published package inventory
and clean package-install gate are not claimed by this lane.

## Named mutants

These are three actual injected counterexamples, not unexecuted suggestions.
Each lives inside a passing unit with the same valid control and invariant.

| Mutant | Injection and proof of kill |
| --- | --- |
| `UNFENCED_EXCHANGE` | Clone the table and remove exchange_fence_committed from the exchange edge. The normal table refuses false fence evidence. The mutant allows it, so the same invariant throws ERR_ASSERTION; the test requires that failure. |
| `AUDIT_EXTRA_FIELD` | Change the audit schema to permit extra fields. A normal audit control passes and the original rejects an added runtime-generated refresh token. The mutated schema admits it, causing the privacy invariant's expected rejection to fail; the test asserts the kill. |
| `REUSE_CODE` | Enable the fake's test-only reuse-code behavior. The valid one-use control produces one exchange and rejects replay. The mutated fake accepts replay, causing the same single-use assertion to fail; the passing test requires that assertion failure. |

These kills prove sensitivity of the specification/fake unit oracles. They do
not claim mutation coverage of an absent broker implementation.

## Mapping the older design references

The external design was read in full first. Its `product/` prefix maps directly
to this repository root. Its pinned commit is `52a36e11`; the working tree is
the supplied `f8a7cd05` tip. The cited QuickBooks anchors below still occur at
the same line locations; no line drift was observed at these anchors. This is
not a claim that the full older tree is identical.

| Design reference | Current path and checked anchor |
| --- | --- |
| `product/package.json:2-3` | `package.json:2-3`, product version 0.4.19. |
| `product/CHANGELOG.md:7-11`, `67-74` | `CHANGELOG.md:7-11` still marks the candidate; attachment work is at line 73 within the cited later range. |
| `product/connectors/quickbooks-online.mjs:1-16`, `119-218` | Same file/ranges; entity allowlist at 11, page size at 17, realm contract at 21, direct query construction at 157, deletion authority unavailable at 208. |
| `product/migrations/d1/0032_quickbooks_oauth_intents.sql:1-66` | Same migration; callback ciphertext handoff, not token broker storage. Untouched. |
| `product/brain.mjs:32116-32127`, `32163-32166`, `32213-32223`, `32226-32293` | Same CLI ranges; production refusal code at 32125 and broader-scope warning at 32165. Local custody/disconnect contract remains unchanged. |
| `product/operations/quickbooks-callback-client.mjs:1-6` | Same helper header and future integration/key-lifetime limitation. |
| `product/worker/src/lib/quickbooks-oauth-callback.js:1-8`, `23-39`, `121-176`, `232-345`, `356-405`, `593-604` | Same module; no exchange/token custody; ten-minute TTL at 32, 12 KiB bound at 33, capability syntax at 37, callback handler at 356, cleanup at 594. |
| `product/manifest.schema.json:312-340` | Same stanza; line 314 still describes local provider custody and the closed production path. |
| `product/frontend/src/components/Settings.tsx:37-128`, `178-213`, `409-417` | Same Settings file; bank section declaration at 40 and use at 409. No QuickBooks surface added. |
| `product/worker/src/lib/bank-feed.js:456-523`, `564-589` and `product/migrations/d1/0018_bank_feed.sql:26-31`, `47-84` | Same independent wrapping-key/AES-GCM pattern; encryption at 571 and D1 ciphertext field at migration line 49. |
| `product/worker/src/lib/public-request-guard.js:90-110`, `121-167` | Same fail-closed public guard; unavailable quota response at 162-164. |
| `product/connectors/provider-oauth.mjs:1124-1191`, `1521-1596`, `1626-1650` | Same bounded exchange/uncertainty and replacement-refresh guards; outcome_unknown at 1585, missing replacement refusal at 1628. JSON revoke contract checked separately at 821-830. |

External decision-note paths in the design are contextual references, not
`product/` files copied into this lane. No instance material was imported.

## Prepared commit

Subject: `Define offline QuickBooks broker protocol and probe gates`

Body:

```text
Add the qbo-broker/1 wire contract, state machines, closed schemas and an
in-memory provider double with paired positive and negative controls.

Register 63 passing offline unit checks. Keep nine explicit integration
gates red until reviewed broker and owner handlers exist. Record custody,
replay, privacy and mutant evidence without enabling production behavior.
```

The operator should rerun the focused wrapper and expected-red probe command,
review the working-tree files, and make the commit. The missing commit/push is
intentional under this run's read-only Git rules and does not affect readiness.

## Operator note

The Codex sandbox on this Windows machine makes `.git` read-only, so the lane could not commit. The operator (Claude Code) re-ran `node --test test/qbo-broker-protocol.test.mjs` (63 passed, 0 failed) and `node --test protocol/quickbooks-broker/probes/broker.e2e.probe.mjs` (9 of 9 fail as designed, each with BROKER_IMPLEMENTATION_MISSING). It scanned the 19 new or changed files for names, banned words and secret-like strings (none; the fixture address uses the .invalid domain) and made the prepared commit unchanged. No code was edited by the operator.

LANE QBO-BROKER-PROTOCOL: READY
