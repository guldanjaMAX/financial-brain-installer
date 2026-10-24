# QBO-BROKER-FOUNDATION lane report

Step 2 is ready for review as an offline broker foundation. All seven API
routes are implemented in a separate private package. The original nine lane 5
integration probes pass against actual broker handlers, injected fake Intuit
and SQLite stores. The final focused run passed 112 tests with zero failures,
skips or TODOs. Production remains closed.

Working branch: `partner/qbo-broker-foundation-1`.
Starting commit: `9a4f4d7`, carrying the lane 5 protocol on the supplied candidate
base. The supplied working-copy instruction takes precedence over older base
pins in the lane packet. The lane 5 report and external design were read in
full, together with the repository guidance and relevant architecture sections.

All changes remain in the working tree. No Git write command, commit, push,
checkout, stash, release, account access or deployment was performed. No
dependency installation, full test chain, release test or package command ran.
Every Node invocation included the mandatory network-guard import. Test runs
printed `LANE_NETWORK_GUARD_ACTIVE`. Tests ran on Friday outside the stated
rehearsal pause window. Only generated synthetic credentials and reserved
fixture destinations were used. Scratch database snapshots used `%TEMP%` and
were removed by their owning test helper.

## Changed files

| File and anchor | Change |
| --- | --- |
| `broker/quickbooks/package.json:1` | Private, dependency-free module package with a closed broker entry point. |
| `broker/quickbooks/README.md:1` | Custody, storage, transport requirements, focused verification and operational review gates. |
| `broker/quickbooks/migrations/0001_security_ledger.sql:3` | New broker-only append-only migration: security events at 3, replay ledger at 27, token-operation uniqueness at 47, quotas at 50, global readiness at 66. |
| `broker/quickbooks/src/broker.mjs:23` | Explicitly injected handler factory, exact build/generation readiness, closed logging, quotas and request proof. Enrollment at 124, start at 161, launch at 199, delivery at 231, callback at 269, refresh at 334, revoke at 359. |
| `broker/quickbooks/src/provider.mjs:5` | Fixed production and offline provider endpoints, no arbitrary URL operation, bounded token parsing, stable uncertainty, transient partial-token cleanup. |
| `broker/quickbooks/src/crypto.mjs:18` | Canonical bytes, strict binary encoding, ES256, separated HKDF keys, voucher MACs, sealed browser context and sender-authenticated ECDH envelopes. |
| `broker/quickbooks/src/validation.mjs:73` | Closed schema admission, duplicate-key refusal, strict UTF-8, streamed byte limits, exact forms/queries, callback and all-answer DNS validation. |
| `broker/quickbooks/src/protocol-schema.mjs:2` | Exact local copy of the 66-definition lane 5 catalog; equality checked against the protocol source. |
| `broker/quickbooks/src/store.mjs:38` | Closed write schemas and stable store errors; atomic D1 batches, exact readback, compare-and-swap fences, proof consumption, quotas, provider circuit, revocation markers and bounded cleanup. |
| `broker/quickbooks/test/support/sqlite-d1.mjs:5` | Real in-memory SQLite with the D1 interface and explicit commit/readback faults. |
| `broker/quickbooks/test/boundary.test.mjs:12` | Traverses every broker runtime import, forbids outside dependencies, dynamic loading and ambient network fallback. |
| `broker/quickbooks/test/store.test.mjs:21` | Migration/SQL validation, replay/readback, proof atomicity, quotas, readiness, retention, circuit and two actual mutant kills. |
| `broker/quickbooks/test/crypto.test.mjs:16` | Encoding, schema, signatures, capsule/envelope, stream, URL/DNS and sender-MAC mutant checks. |
| `broker/quickbooks/test/provider.test.mjs:13` | Valid exchange/rotation/revoke controls, malformed/rejected/lost replies, fixed destinations, runtime canary exceptions and safe assertion diagnostics. |
| `broker/quickbooks/test/broker-security.test.mjs:92` | Live enrollment requirements, stale/signature/approval refusals, valid curve admission, stable denial events, persisted circuit and outgoing capsule limits. |
| `broker/quickbooks/test/callback-quota.test.mjs:6` | Malformed callbacks consume the address quota before expensive parsing or exchange. |
| `broker/quickbooks/test/revoke-quota.test.mjs:6` | No-contact refusals cannot bypass the hourly revoke limit. |
| `broker/quickbooks/test/routes.test.mjs:7` | Exact method admission for every route, with ready health as control. |
| `protocol/quickbooks-broker/implementation-adapter.mjs:13` | Actual handler/store glue, isolated owner fixtures, dependency faults, real log capture, restart and complete database image inspection. |
| `protocol/quickbooks-broker/testing/owner-runtime.mjs:27` | Test-only SQLite owner handler with encrypted keys/tokens, signed challenge/receipt, exact readback, refresh/disconnect fences and direct fake accounting read. |
| `protocol/quickbooks-broker/testing/broker-privacy.test.mjs:8` | Partial-token cleanup, fresh-ID operation replay and all-surface runtime canary scans. |
| `protocol/quickbooks-broker/README.md:3` | Current step 2 scope and passing explicit probe status. |
| `protocol/quickbooks-broker/probes/README.md:3` | Current adapter evidence and explicit deployment limitations. |
| `protocol/quickbooks-broker/v1/PROTOCOL.md:459` | Verification-status paragraph only; normative wire contract unchanged. |
| `test/qbo-broker-protocol.test.mjs:1` | Update stale comment/test title; keeps E2E an explicit focused gate. |
| `docs/README-developer.md:2020` | Document the separate offline foundation and continuing production closure. |
| `partner-reports/qbo-broker-foundation.md:1` | This evidence and prepared commit. |

No owner migration, deployed owner route, CLI behavior, manifest, connector
status, product version, lockfile, publication allowlist or public changelog was
changed. The installer allowlist excludes the broker package, protocol fixtures
and partner reports. Migration 0032 remains the original code-handoff schema.

## Implemented boundaries

Enrollment requires both the trusted operator-verification dependency and a
fresh signed owner-Worker challenge retrieved using its confidential capability.
The challenge binds the exact callback, environment, generation and install
public key. Operator approval alone, a self-signed request alone, a missing or
wrong signature, and a stale challenge cannot issue a voucher. The one-use
challenge fence commits before voucher delivery. Only the Worker receives the
voucher; the operator receives status. The broker retains a keyed fingerprint
and stable outcomes, never a callback registry.

Signed starts verify the voucher, exact body hash, request signature, delivery
curve point, timestamp window and quotas. A one-use launch capsule carries the
encrypted callback context across restarts. Its separate cookie has Secure,
HttpOnly and SameSite=Lax flags and a callback-only path. Form navigation uses a
303 to the fixed authorization endpoint. Callback parsing rejects duplicate or
unknown fields, verifies cookie/state/configuration and consumes the durable
exchange fence before one provider send. Completion redirects are query-free.

Exchange and refresh validate required replacement tokens, returned expiry
arithmetic and company binding. Token envelopes use a one-time sender MAC as
well as recipient encryption. Delivery retries reuse identical bytes at most
three times within the same invocation. Unconfirmed delivery triggers a
separately fenced revoke while the token remains transient. Even a partial
exchange reply with a usable access token is cleaned up. Lost or malformed
results cannot reactivate an old grant. If the owner callback remains
unavailable, its pending intent expires visibly; the broker neither claims
notification nor queues a token for a later invocation.

Refresh and revoke each require a unique durable attempt. A new request ID
cannot repeat the same attempted operation. A signed no-contact proof binds the
unchanged operation; consuming it and inserting the replacement revoke fence
are atomic. Both ordinary requests and no-contact paths obey hourly admission.
The owner fixture disables reads before revoke and preserves imported records.
This fixture proves protocol integration only, not deployed owner behavior.

All metadata writes and successful state transitions require exact readback.
Audit and SQL schemas have no open payload/error field and reject forbidden
fields. Address quota retention never exceeds two windows or 20 minutes;
security/replay retention is capped at 30 days. A bounded cleanup method is
available to the deployment lifecycle. Hourly limits use replay metadata.
Global route admission is 1,000/minute; the persisted provider-outcome circuit
closes after 20 rejected or uncertain outcomes/minute. These initial circuit
settings require load review before deployment.

There are no accounting, proxy, token lookup/recovery or impersonation routes.
The broker runtime import closure stays entirely inside its package source.
Provider and owner transports have no ambient fallback. Every callback address
answer must be public and is passed to the pinning boundary; redirects refuse.

## Focused verification and red-first evidence

In the tables below, `N` expands exactly to
`node --import file:///C:/offload/lanes-1023/no-network.mjs`.
Only the listed files were run. No full chain was invoked.

| Test file or command group | Observed red-to-green results |
| --- | --- |
| `N --test broker/quickbooks/test/provider.test.mjs` | Initial missing-module failure, then 3/3 pass. Valid exchange, replacement refresh and revoke are controls for provider failures and configuration refusals. A final diagnostic-safety regression gave 3 pass/1 fail: direct token equality assertions could retain the canary in a caught assertion object. Boolean-only assertions made it 4/4 in the final aggregate; the red diagnostic test itself printed no canary. |
| `N --test broker/quickbooks/test/crypto.test.mjs` | Initial missing-module failure, then 8/8; after code mapping, 8/8. New BOM and forged stream-error tests: 7 pass/2 fail, then 9/9. Duplicate/noncanonical input is refused and an untrusted stream exception cannot expose its canary. |
| `N --test broker/quickbooks/test/store.test.mjs broker/quickbooks/test/boundary.test.mjs` | Initial 0 pass/2 fail for absent store/package. Two interim 9 pass/1 fail runs corrected a test rollback fixture binding and a scanner false positive for the handler's `fetch` method; these are test corrections, not product defects. Then 10/10. New phase-authority regression: 11 pass/1 fail; adding circuit regression: 11 pass/2 fail; corrected to 13/13. New exact quota increment regression: 13 pass/1 fail, corrected to 14/14. Final aggregate includes the later proof-quota test and passes all 15 in these two files. |
| `N --test broker/quickbooks/test/broker-security.test.mjs` | Invalid delivery curve regression: 2 pass/1 fail, then 3/3. Denial audit/circuit regressions: 3 pass/2 fail, then 5/5. A speculative maximum-input denial assertion was wrong: the valid maximum fixture produced 2,762 ciphertext characters and correctly succeeded. That assertion was replaced by a passing maximum-shape control. A real handler serializer fault producing 3,502 characters then gave 5 pass/1 fail; outgoing capsule/response guards made it 6/6. No reachable oversized-input bug is claimed from the speculative assertion. |
| `N --test protocol/quickbooks-broker/probes/broker.e2e.probe.mjs` | Baseline 0/9, all `BROKER_IMPLEMENTATION_MISSING`. First integrated run 8/9: old-generation rejection did not reach the named generation guard. Reordering that explicit guard produced 9/9. Subsequent integrated runs remained 9/9. |
| `N --test protocol/quickbooks-broker/testing/broker-privacy.test.mjs` | Partial exchange cleanup regression: 2 pass/1 fail because the usable access token was discarded without revoke. Transient cleanup capability and a fenced revoke made all 3 pass. Fresh-ID operation replay and complete privacy scans had valid controls. |
| `N --test broker/quickbooks/test/callback-quota.test.mjs` | 0 pass/1 fail after a successful connect control: 30 malformed callbacks did not consume the quota. Moving admission before state parsing made it 1/1. |
| `N --test broker/quickbooks/test/routes.test.mjs` | 0 pass/1 fail after healthy GET control: POST callback returned 503 instead of 405. Explicit method dispatch made it 1/1. |
| `N --test broker/quickbooks/test/store.test.mjs broker/quickbooks/test/revoke-quota.test.mjs` | 13 pass/2 fail for omitted no-contact hourly admission and proof consumption ignoring limits. Rate guards inside the same proof transaction and all revoke branches corrected both. |
| `N --test broker/quickbooks/test/store.test.mjs broker/quickbooks/test/revoke-quota.test.mjs broker/quickbooks/test/callback-quota.test.mjs` | 16/16 pass after the no-contact and callback quota corrections. |
| `N --test broker/quickbooks/test/broker-security.test.mjs protocol/quickbooks-broker/testing/broker-privacy.test.mjs protocol/quickbooks-broker/probes/broker.e2e.probe.mjs` | 17/17 pass at that stage: 5 security, 3 privacy and 9 original probes. |
| `N --test protocol/quickbooks-broker/testing/broker-privacy.test.mjs protocol/quickbooks-broker/probes/broker.e2e.probe.mjs` | 12/12 pass. |
| Final explicit eleven-file command below | First 111/111; after the diagnostic-safety test, 112/112 pass with zero failures/skips/TODOs, including the unchanged 63-test protocol wrapper and 49 foundation/integration checks. |
| `N --check <file>` | Earlier owner-runtime checks twice and adapter check once passed. Final pass checked all 19 new/changed JavaScript files, all passing; the final two edited test files were checked again after the diagnostic-safety correction. |
| `git diff --check` and changed-text scans | Pass. A first whole-file language scan noticed an existing long dash in unchanged developer-documentation text; scanning the actual added lines and all new files found no prohibited word, long dash or user-profile path. |

Every negative behavior check includes a successful control, either in that
test or the same scenario before the negative branch. Actual injected faults
exercise dependencies or runtime source; they do not fabricate guard events.
No red test remains.

The final command was:

```text
node --import file:///C:/offload/lanes-1023/no-network.mjs --test broker/quickbooks/test/provider.test.mjs broker/quickbooks/test/crypto.test.mjs broker/quickbooks/test/store.test.mjs broker/quickbooks/test/boundary.test.mjs broker/quickbooks/test/broker-security.test.mjs broker/quickbooks/test/callback-quota.test.mjs broker/quickbooks/test/revoke-quota.test.mjs broker/quickbooks/test/routes.test.mjs protocol/quickbooks-broker/testing/broker-privacy.test.mjs protocol/quickbooks-broker/probes/broker.e2e.probe.mjs test/qbo-broker-protocol.test.mjs
```

The canary tests collect actual runtime-generated fake access/refresh tokens,
the fake shared secret and a generated transport-error canary. They scan the
complete broker SQLite backup image, including freed pages and readiness,
all retained rows, captured audit logs, response bodies/headers and escaped
exceptions. No canary appears. Source checks also reject an unreviewed analytics
or console sink; no analytics writer or data-bearing analytics fixture exists.
The owner fixture retains ciphertext in its separate SQLite database and is
not included in the broker database privacy projection.

## Named mutants

These three foundation mutants are executed and killed, in addition to the
inherited lane 5 specification tests. They are not unexecuted suggestions.

| Mutant | Actual alteration and kill evidence |
| --- | --- |
| `AUDIT_EXTRA_FIELD` | `store.test.mjs:143` changes the exact-shape boundary to admit an extra field. The valid audit control roundtrips; the original rejects the runtime-generated forbidden token field. The changed validator admits it, so the same rejection invariant throws and the test requires that failure. |
| `UNFENCED_PROVIDER_SEND` | `store.test.mjs:166` removes the actual store's transition readback check from imported source. A dependency reports successful write metadata while truthful SQLite readback remains unchanged. The original refuses provider authorization; the mutant permits it, causing the same fence-before-send invariant to throw. |
| `MISSING_SENDER_MAC` | `crypto.test.mjs:60` removes actual sender-MAC verification from imported crypto source. A valid envelope opens; the original refuses an altered sender tag. The mutant decrypts it, so the unchanged rejection assertion fails and the test requires that kill. |

## Mapping the older design references

The design's `product/` prefix maps directly to the repository root. Its older
pinned tree is `52a36e11`; this lane started at `9a4f4d7`. None of the design's
referenced product modules was changed here. Checked source anchors still lie
inside their cited ranges; no code-line drift requiring a different mapping
was found. The earlier lane report's page-size anchor was one line imprecise:
the declaration is line 16, not 17.

| Design reference | Current mapping and relevant anchor |
| --- | --- |
| `product/package.json:2-3` | `package.json:2-3`, version remains 0.4.19. |
| `product/CHANGELOG.md:7-11`, `67-74` | `CHANGELOG.md` at the same ranges; no release copy changed. |
| `product/connectors/quickbooks-online.mjs:1-16`, `119-218` | `connectors/quickbooks-online.mjs`; page size at 16, realm syntax at 21, query construction at 157 and no deletion authority within the cited range. |
| `product/migrations/d1/0032_quickbooks_oauth_intents.sql:1-66` | Same owner migration, untouched. New broker storage lives only in its separate migration directory. |
| `product/brain.mjs:32116-32127`, `32163-32166`, `32213-32293` | Same CLI ranges for production refusal, scope disclosure, local custody and disconnect. |
| `product/operations/quickbooks-callback-client.mjs:1-6` | Same helper header and key-lifetime limitation. |
| `product/worker/src/lib/quickbooks-oauth-callback.js:1-8`, `23-39`, `121-176`, `232-405`, `593-604` | Same handoff module; preserves the reference patterns for bounds, exact shapes, neutral completion, hashes and cleanup. Its no-token claim was not copied to the broker. |
| `product/manifest.schema.json:312-340` | Same local-custody description and closed production contract. |
| `product/frontend/src/components/Settings.tsx:37-128`, `178-213`, `409-417` | Same owner UI; no live QuickBooks surface added. |
| `product/worker/src/lib/bank-feed.js:456-523`, `564-589` and `product/migrations/d1/0018_bank_feed.sql:26-31`, `47-84` | Same independent owner wrapping-key/ciphertext reference. |
| `product/worker/src/lib/public-request-guard.js:90-110`, `121-167` | Same fail-closed public quota reference. |
| `product/connectors/provider-oauth.mjs:1124-1191`, `1521-1596`, `1626-1650` | Same bounded token, uncertain-outcome and replacement-refresh references; outcome fence at 1585 and missing-rotation code at 1629. |

External decision-note references were treated as context, not copied as product
fixtures. The new developer note shifts later documentation lines by seven;
that file is not one of the design's pinned product-code references.

## Remaining external gates

This lane provides a broker factory and injected boundaries, not a production
deployment. There is deliberately no shipping Access verifier, production DNS
pinning transport, deployment binding or production owner integration. A real
transport must enforce the validated addresses and Host/TLS binding and honor
deadlines; a DNS precheck followed by ordinary fetch is insufficient. A trusted
Access verifier must enforce issuer, audience, expiry and the dedicated role.
Those reviews are required before enrollment can be enabled in a deployment.

Native D1 behavior, platform observability configuration, browser cookie
behavior, provider approval, retention approval, load limits, rotation,
incident response, public pages and an explicitly approved production canary
remain the design's external gates. The unit and integration passes do not
claim any of these. No real-account gate or production state was touched.

## Prepared commit

Subject: `Implement isolated QuickBooks broker foundation`

Body:

```text
Add the separate broker package, append-only security ledger and all v1
control routes with injected transports, durable one-use fences and
authenticated encrypted token delivery.

Bind the protocol probes to real offline handlers and SQLite stores.
Record 112 focused passing checks, privacy canary scans and three killed
mutants while keeping production deployment and owner integration closed.
```

The operator should rerun the final focused command, review this working tree
and make the prepared commit on `partner/qbo-broker-foundation-1`. The missing
commit and push are intentional under this run's read-only Git instruction.

## Operator note

The Codex sandbox on this Windows machine makes `.git` read-only, so the lane could not commit. The operator (Claude Code) re-ran the final eleven-file command above with the network guard on the unchanged working tree: 112 passed, 0 failed, 0 skipped, 0 todo. The guard printed LANE_NETWORK_GUARD_ACTIVE and blocked nothing. A guard-free run of the boundary, provider and end-to-end probe files also passed (14/14). The named mutant tests ran and passed in that run, which means each mutant was killed.

The operator also checked the new broker and fixture code for real DNS, socket or fetch use: none. Every `fetch` is the broker's own handler method or the fake Intuit. The three Intuit URLs in the source are the fixed endpoint constants; no test reaches them. Names, banned-word, email, user-path and key scan of every added line and new file: none.

The operator made the prepared commit unchanged. No code was edited by the operator.

LANE QBO-BROKER-FOUNDATION: READY
