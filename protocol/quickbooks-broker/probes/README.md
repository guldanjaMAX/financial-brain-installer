# Broker E2E gates

These probes describe the broker and owner boundaries. The tests run using
`implementation-adapter.mjs`, the actual separate broker package and an isolated
test-only owner handler with SQLite and cryptography. No scenario is skipped or
marked TODO. Production owner integration and the external design gates remain
unproven. The original missing-adapter failures are recorded in the lane 5 report.

Run the explicit gate from the repository root with the offline network guard:

```text
node --import <offline-network-guard-url> --test protocol/quickbooks-broker/probes/broker.e2e.probe.mjs
```

The protocol/fake unit suite imports only the passing harness unit file:

```text
node --test protocol/quickbooks-broker/probes/harness.unit.mjs
```

`scripts/run-test-chain.mjs` explicitly registers the eleven-file foundation
command in both command lists. It includes this E2E file, the privacy test,
eight broker tests and the protocol wrapper. The `.probe.mjs` suffix remains
outside the completeness discovery pattern; positive coverage checks require
its registration. No broker test is exempted from the completeness gate. Lane
verification runs focused files directly without running the full chain.

## Scenario inventory

Each scenario first runs a successful control, then changes one boundary at a
time. A negative must reach its named validation observation and show no forbidden
provider mutation or owner commit. Provider counters distinguish attempts,
provider entry, and mutation; observations are fixed event names with no payload.

| Scenario | Controls and attacks |
| --- | --- |
| Connect | Approved Access enrollment and live ownership challenge; owner session; signed start; exact provider redirect and cookie flags. Refuses absent Access, bad challenge, unauthenticated owner, changed signature/body, extra JSON key, expired launch. Restarts the broker after start and launch with only its allowed durable rows, proving there is no hidden callback registry. |
| Callback | Successful state/cookie binding. Refuses absent or wrong state/cookie, duplicate code, unknown query key, and expired intent before exchange; handles consent cancellation visibly; uses only exact query-free result pages. |
| Code exchange | One provider exchange after a committed replay fence and one owner save after exact readback. Exercises provider refusal, malformed/missing token fields, inconsistent company echo, response loss, failed replay commit, unavailable owner callback, bounded identical-envelope retries, in-memory revoke, and lost receipt followed by idempotent delivery. |
| Refresh | Due refresh rotates one generation and clears the owner fence only after readback. Exercises loss before/after provider mutation, refusal, malformed/missing replacement, inconsistent company echo, failed readback, no retry of the old token, safely valid-token no-op, and two competing refreshes under one lease. |
| Revoke | Schedule disable and owner fence precede confirmed revoke; token ciphertext is removed and a preexisting synthetic imported record remains. Exercises rejected/uncertain outcomes and refusal to repeat contact; a verified no-contact proof alone permits retry of the same fenced operation. |
| Replay | The same delivery returns the same signed receipt; changed ciphertext under the same delivery ID fails. Reuses launch capability, serial and concurrent callback state, and signed start/refresh/revoke request IDs. Provider mutation count remains one. |
| Mix-up | Correct connection is the control. Tests signed callback/environment disagreement with voucher, another transaction's cookie, a valid envelope delivered to another owner, altered intent/environment/key/generations, missing or wrong broker sender tag, tampered refresh company/generation/realm fields, and rotated voucher generation. |
| SSRF and privacy | Health and direct owner-to-provider accounting read are controls. Refuses HTTP, IP/localhost, userinfo, fragments, nonstandard port and wrong callback path at enrollment; refuses private DNS answers before delivery; never follows callback redirects. Data proxy, token lookup and token recovery routes are absent. Scans durable broker rows, logs and returned responses for generated credential canaries and validates exact non-content schemas. |
| Abuse | Valid signed start is the control. Refuses unavailable quota/replay storage, wrong content type, body larger than 12 KiB, expired proof, and the sixth start within ten minutes. |
| Pending expiry | Unavailable delivery and an invalid callback leave pending intents. Status retains both keys at 599999 ms, then expires the intent and destroys both keys at 600000 ms without outbound contact. |
| Cleanup recovery | Exact readback failure rolls back expiry. A backlog of 33 intents requires two status calls, with at most 32 records cleaned per call. Terminal polls are idempotent. |
| Terminal storage | Actual SQLite rows for connect, refresh, cancellation, failure and expiry satisfy the closed owner-intent schema. Terminal rows omit both key fields and all active context; accepted deliveries retain signed receipt replay material. |
| Key-retention mutant | Removes key destruction from the actual owner runtime. The same stored-key expiry invariant passes the real runtime and rejects the mutant. |

The broker has no company/token registry. The refresh tampering checks therefore
assert request-signature integrity, not knowledge of an owner's D1 generation.
The owner performs the authoritative generation comparison and company binding
check when it accepts an encrypted replacement. Another owner's valid delivery
and changed authenticated bindings must never activate or overwrite a connection.

Privacy checks require fresh, distinct audit witnesses for each observed broker
operation, in both durable rows and captured logs. Empty sinks, stale evidence,
or one concurrent operation borrowing another's witness cannot pass. One capture
function walks every request and response exchange at the broker, owner and
injected fake-provider boundaries. It visits these channels, including empty ones:

- `body`: the full text and decoded JSON or form fields, including the launch
  transaction's decoded capsule.
- `headers`: every header, with repeated `Set-Cookie` fields retained separately
  through `getSetCookie()`.
- `cookies`: every `Cookie` pair and `Set-Cookie` pair and payload, tied to the
  original physical header field. The full header is captured above.
- `query`: all decoded name/value entries, preserving duplicate callback fields.

The recorder snapshots each channel independently before calling the capture
function. Completeness compares those contents with the traversal evidence, so
omitting either a whole channel or one entry fails. Header-skip and cookie-skip
mutants exercise both omissions with passing controls. Captured fixture values
stay in memory and never enter assertion diagnostics.

Requests register every `x-private` value before handler entry; responses do so
on receipt, including callback receipts that are subsequently lost by a transport
fault. The closed header models make every header name private except the
reviewed transport and policy metadata allowlist. Authorization, proxy
authorization, every Access header, cookie headers and unfamiliar future
credential headers therefore remain private. Registration preserves both
the full credential and its bearer payload. Cookie registration preserves the
full header, transmitted pair and payload. Only the exact payload-free
transaction-cookie clearing header is public in the schema.

Each declared broker request is also decoded and validated against its request
schema, including enrollment, JSON controls, form launch and callback queries.
Successful broker JSON responses are strictly decoded and validated against
their declared response schema. The harness follows schema references, matching
alternatives and array paths when registering private fields. A request value
cannot acquire a new response permission by appearing in an otherwise valid
private response field. Embedded echoes remain leaks even if the containing
field has a grant for a different value.

Each grant names one exact field of one response identity. Forwarding the same
Response preserves its identity and every observed snapshot; it does not create
another grant. Prior exact grants survive legitimate capability, capsule, state
and cookie round trips. A validated provider launch alone permits its exact
Location state parameter and exact transaction `Set-Cookie` field. The cookie's
full-header, pair and payload aliases all share that single physical field;
other cookies, headers and body content remain scanned. Redirects, completion
pages and static HTML have no general privacy exemption. Rejected schema
observations remain failed even if a caller catches the assertion or later
repairs the response. An unavailable audit ledger cannot certify a privacy pass.

Malformed-input probes explicitly set `expectInvalidRequest: true`. The harness
must first observe validation failure, then require a real broker refusal; the
option cannot admit a valid request. Decoded private leaves remain registered
even when another field invalidates the request, and all raw callback private
query values remain covered, including duplicate fields. Unparseable JSON/form
fixtures stop before the handler even with that option. Synthetic request
snapshots use finite buffered fixture bytes so inspecting an oversized request
does not wait for cancellation of its still-unread handler stream.

The exact authenticated owner enrollment-challenge reply is a private
owner-to-broker protocol exchange. Its schema requires the challenge value and
is checked during the same capture. Only its exact challenge body field has a
local transmission allowance; its headers and other fields remain scanned.
Direct owner calls receive no such allowance. Broker responses, direct owner
calls, voucher acknowledgements and callback receipts remain scanned. Enrollment
fixtures send their request through the same harness boundary as ordinary broker
calls. Fake-provider requests and replies also traverse every channel and add
private values to the registry. Provider token replies are private transport
input, not outward broker or owner responses.

Schema coverage combines a reviewed private-site inventory, sensitive field
names and a closed inventory of reviewed public names across every schema
definition, including request, header and cookie schemas. All 24 reviewed scalar
annotation sites have removal checks. Unclassified new names, missing annotations
and non-string annotations fail. Stored credential and key containers inherit
their marker from the shared ciphertext leaf. Refresh controls
exercise owner and raw broker entry points; body/header mutants echo ciphertext
through health, status and refusals, or try to reuse a grant in another response.

Refresh and disconnect replay checks require a refusal plus unchanged owner
state and complete provider counters. The safe fence fingerprint detects a
changed durable fence without exposing its contents. A fresh request ID using
an already consumed no-contact proof must be refused with `replayed` while the
original ledger row remains `proof_consumed`. Both scheduled and direct reads
are exercised after uncertain refreshes and while provider revocation is held
in flight, with connected valid reads as controls.

## Adapter contract

Add the one fixed adapter path only when binding the actual reviewed handlers.
Export `async createProbeAdapter(dependencies)`. The adapter is glue: it must not
implement a second broker, fabricate status responses, synthesize guard events,
insert successful vouchers directly, or use the state-machine oracle as a router.
Every response comes from the actual handler under test. It may use real in-memory
SQLite stores and test-only identity/key fixtures. Nothing opens a listener,
resolves external DNS, reads ambient credentials, or falls back to global fetch.

The probe injects:

| Dependency | Contract |
| --- | --- |
| `protocol` | `qbo-broker/1`. |
| `now()` | Milliseconds since epoch; the probe advances time without sleeping. |
| `origins` | Two reserved `.invalid` owner origins. Each is an isolated install with its own keys, session, voucher, delivery key and wrapping key. Seed one clearly synthetic preexisting imported record per owner for disconnect retention checks. |
| `brokerConfig` | The fake provider's generated client configuration and fixed `.invalid` endpoints. Bind the generated shared secret only to the broker. Do not copy it into owner fixtures, stores, request bodies or diagnostics. |
| `brokerFetch` | In-memory provider/control transport for broker outbound requests. Rejects every unknown destination and every broker accounting request. |
| `ownerFetch` | In-memory transport for owner-to-broker control traffic and direct owner-to-provider API traffic. |
| `resolve(host)` | Injected DNS answers. The default public address is a synthetic resolver response only; no connection is made. The probe replaces it with private addresses to exercise delivery rejection. Pin the validated destination for the request and never use real DNS. |
| `observe(name)` | Emit only the exact fixed observation name, after entry into the corresponding real guard or completed transaction. No request values, labels, errors, or objects. |

Return this interface:

```text
{
  broker: { fetch(Request) -> Promise<Response> },
  owners: [
    { fetch(Request) -> Promise<Response>, authHeaders },
    { fetch(Request) -> Promise<Response>, authHeaders }
  ],
  fixtures: {
    enroll({owner, authorized = true, challengeValid = true, callback?, send?}) -> Response,
    signedRequest({owner, route, bodyOverrides = {}}) -> Request
  },
  inspect() -> observations,
  armFault(name),
  restartBroker() -> Promise<void>,
  runScheduledRead({owner}) -> Promise<boolean>,
  runDirectRead({owner}) -> Promise<boolean>
}
```

`fixtures.enroll` sends an actual Access-authenticated issue request through its
injected `send` transport (the harness boundary, defaulting to `ownerFetch`) and serves
the owner's actual one-time ownership challenge. Its returned response is the
issue route's response. The voucher is delivered only to that owner Worker.
The negative options remove Access, fail challenge verification or propose the
specified callback. They do not replace route decisions with fixture decisions.

`fixtures.signedRequest` constructs a fresh, otherwise valid signed wire request
for one of the three broker routes. It uses the install's real synthetic signing
key and voucher and current owner credentials; values remain only in memory. It
applies `bodyOverrides` before computing the body hash and signature so callback
and environment disagreements reach the voucher-binding decision. Tests using
`rewriteJson` mutate bytes **after** signing and must fail proof verification.

`restartBroker` discards all broker instance memory, then reconnects a fresh
handler using the same current configuration and only the exact allowlisted
durable audit/replay/quota rows. It preserves the owner Workers. An adapter that
copies a callback map or encrypted token queue across restart violates the test.

`runScheduledRead` invokes the owner's actual scheduled direct-read entry point.
It cannot emulate a read by incrementing counters or calling the fake directly.
The owner constructs the provider URL and request from its encrypted connection.
`runDirectRead` enters the same credential/status/fence guard without requiring
the schedule to be enabled. Both return false when disabled and true only after
a successful fake-provider read. Neither is a deployed owner API in this lane.

`inspect()` reads actual stores and exposes safe observations:

```text
{
  brokerRows: [auditEvent | replayRow | quotaRow],
  brokerLogs: [auditEvent],
  voucherIssueCount: integer,
  exchangeFences: integer,
  owners: [{
    status, intentStatus, intentKeyCount, pendingIntentCount,
    temporaryIntentKeyCount, intentExpiryReadbackCount, intentExpiryReadbackAttemptCount,
    enrollmentReadbackAttemptCount, tokenGeneration, tokenCiphertextCount,
    connectionCommitCount, connectionReadbackCount,
    scheduleEnabled, readsEnabled, importedRecordCount, outcomeUnknown, fenceFingerprint,
    remoteRevocation, noContactProofVerified
  }, ...]
}
```

Rows and logs are the complete retained broker records, without filtering or
renaming fields to pass a scan. Every broker row must match exactly one of the
three schema shapes; every application log must match `auditEvent`. Do not return
owner ciphertext, credentials, paths, raw company values, or record content in
the safe owner summary. Counters must reflect actual store commits/readbacks.
The owner `connected` status requires a committed token pair, encrypted company,
and successful readback. `remoteRevocation` is `confirmed`, `rejected`, `uncertain`
or unset; uncertainty cannot become confirmation through local destruction.
Enrollment and expiry emit fixed `owner.enrollment.readback.attempted` and
`owner.intent.expiry.readback.attempted` observations immediately before their
readback comparisons. Attempt counters include failed decisions, while the
expiry success counter advances only after the batch commits. Failing probes
assert both witnesses so an earlier refusal cannot satisfy the readback test.
The fixture's private `inspectIntents()` helper reads actual SQLite rows for
schema assertions; those rows never enter the status response or safe summary.

The adapter must inject these one-shot faults at the named real dependency:

| Fault | Effect |
| --- | --- |
| `broker.replay.commit` | Fail the exchange fence transaction before provider contact. |
| `broker.replay.unavailable` | Refuse the start replay-store operation. |
| `broker.quota.unavailable` | Refuse start quota admission. |
| `owner.refresh.readback` | Fail readback after the replacement commit attempt. |
| `owner.enrollment.readback` | Roll back installation and consumed-challenge acknowledgement if exact readback fails. |
| `owner.intent.expiry.readback` | Roll back the bounded pending-intent expiry batch and refuse status. |
| `broker.revoke.before_fence` | Produce the reviewed, authenticated no-contact result before any provider send; only this proof permits the same operation retry. |
| `broker.rotate_generation` | Rotate current broker key generation; leave the old owner voucher unchanged. |

The harness separately injects callback unavailability, a 307 callback redirect,
one lost owner receipt, and provider faults through the fake. Delivery attempts
must be at most three and must reuse byte-identical encrypted envelopes during
the same invocation. No job, queue, table or subsequent invocation can retain
that envelope for redelivery.

Required guard observations are visible in the assertions in
`broker.e2e.probe.mjs`. Their groups are `enrollment.*`, `start.*`, `launch.*`,
`callback.*`, `request.replay.checked`, `refresh.proof.checked`,
`broker.exchange.*`, `broker.refresh.sent`, `broker.revoke.*`,
`delivery.*`, and `owner.*`. `ordered` requires that **both** events occurred
before comparing their positions. For already-used guards, negative checks use
an event checkpoint so an earlier successful request cannot satisfy the attack's
reached condition.

The synthetic completion pages are exactly
`https://broker.invalid/v1/quickbooks/result` for an untrusted callback and each
owner's `/app/connect/quickbooks` for a trusted binding. No completion query or
fragment is accepted. Provider consent navigation is simulated by fake Intuit;
the launch response must still contain the exact client, fixed redirect, scope,
state and authorization-code response type before the consent fixture runs.
The wrong-cookie case retains the real cookie name and sealed-cookie shape,
changes the authentication tag, and reaches `callback.cookie.binding.checked`
after cookie parsing. It cannot pass by repeating the missing-cookie case.

Launch uses a real top-level HTML form navigation in the eventual browser UI.
The harness models its POST as exact `application/x-www-form-urlencoded` with
exactly one each of `protocol`, `launch_capability`, and `transaction`. The last
field contains the capsule's canonical compact JSON string. After form decoding
and JSON parsing, the object must satisfy `launchRequest`; raw duplicate fields
must be refused before constructing that object. `launchRequest()` builds this
request for all probe launches. A JavaScript JSON fetch followed by a cross-origin
303 is not an equivalent browser navigation. The harness uses manual redirect
inspection only to simulate that navigation without opening a browser or network.

Trusted cancellation and failure completion uses `completionEnvelope` carrying
the token-free `completionResult`, authenticated with the one-time delivery auth
key. The owner returns `completionReceipt` only after it commits and reads back
the matching local intent status. This carries cancellation visibility without
putting a code, token, or owner identity into the completion URL.

The foundation proves the in-memory handler, encryption and SQLite decisions
against injected boundaries. It does not prove deployed behavior, public DNS
pinning, Cloudflare observability settings, provider acceptance or an
owner-authorized field gate. Complete broker readiness metadata is exposed
separately as `brokerReadiness`; traffic rows remain the three closed v1 shapes.
