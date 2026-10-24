# QuickBooks broker protocol 1

Status: offline review contract. Wire identifier: `qbo-broker/1`. This version
is unrelated to the existing callback-envelope version 1. It changes caller
authentication, custody, exchange, delivery, and refresh semantics. Never
interpret migration 0032 or `/api/oauth/quickbooks/*` as this protocol.

The governing design is the complete external `QBO-DESIGN.md` supplied to this
lane. This document supplies wire details that design left open. The capsule,
sender authentication key, encodings, timing values, and retry proof below are
review proposals within its custody rules, not provider approval or deployment
evidence. After this contract is accepted, an incompatible change needs a new
protocol identifier and route version. Unknown versions fail before mutation.

## Custody and authority

The broker's only durable application secret is the Intuit app secret binding.
It transiently handles authorization codes, company identity and provider
tokens. It stores neither those values nor their ciphertext or fingerprints.
It has no install registry, callback registry, token recovery route, accounting
proxy, arbitrary fetch route, or impersonation route. A malicious deployment
could capture future credentials in transit; this protocol does not eliminate
that risk.

The owner Worker authenticates the owner, owns the source reservation, keeps
tokens and raw company identity encrypted with an independent random Worker
secret, and reads Intuit accounting APIs directly. Its D1 record and exact
readback decide connection success. Imported records survive disconnect.
Scheduled report emails stay the default; live OAuth remains opt in and closed
until every design gate passes. Existing local sandbox credentials are never
promoted or uploaded automatically.

Browser state contains short-lived launch material and a sealed transaction
cookie. It contains no provider token. Owner credentials never go into a
manifest, CLI argument, support record, URL, or browser-visible response.

## Wire conventions

The [wire contract](wire-contract.json) fixes paths, limits, domains and labels.
The [schema catalog](schemas/protocol.schema.json) uses JSON Schema 2020-12.
Each schema is addressed as `urn:financial-brain:qbo-broker:1:schemas#/$defs/NAME`.
Credential-bearing string leaves carry `x-private: true`, inherited through
schema references. The offline harness validates every successful broker JSON
response against its declared schema and permits each annotated value only in
that response's exact field. The schema tests require reviewed private sites and
classify every field name; a new field requires a privacy review. Public binding
identifiers do not become credentials merely by sharing the capability encoding.
The enrollment route uses `errorResponse` for its existing status-only accepted
acknowledgement; the voucher is delivered separately to the verified owner.
All object shapes are closed; unknown or duplicate JSON keys, duplicate query
keys, invalid UTF-8, lone surrogates, noncanonical encodings, and unsupported
versions refuse. Reject compressed request bodies. Bound streamed bytes before
parsing: 12 KiB controls and 32 KiB encrypted delivery/refresh responses. A
Content-Length header alone is insufficient. The provider response parser has
the same 32 KiB bound and never copies raw errors to output.

Server-to-server JSON mutations use exactly `application/json`. Browser launch
uses a real top-level HTML form POST with exactly
`application/x-www-form-urlencoded` and fields protocol, launch_capability and
transaction. Transaction is a canonical JSON string decoded to the capsule
object before validating launchRequest. Reject duplicate fields and cap encoded
as well as decoded bytes. The 303 navigates the browser to the fixed provider
target. A background fetch is not a navigation mechanism. Do not put the launch
capability in a query string or accept an arbitrary browser return URL. Token calls to Intuit use the pinned
provider contract: form-encoded token requests and JSON revocation requests.
Provider endpoints and app configuration are deployment constants. Production
uses the one registered broker callback. Tests replace every endpoint with a
reserved `.invalid` origin and never forward elsewhere.

Canonical encoding `C(value)` recursively sorts object keys by UTF-16 code
unit order, emits JSON with no whitespace, keeps array order, and uses JSON
string escaping without Unicode normalization. All protocol member names are
ASCII. Numbers must be safe integers, never negative zero, fractions or
nonfinite values. Null and Boolean values retain their JSON representation.
`B(value)` means UTF-8 bytes of `C(value)`. Canonical output is required on
signed and encrypted wire objects; parsed input is not silently normalized to
make a signature or callback match. Duplicate keys must be rejected before
ordinary JSON parsing can discard them.

Binary values use unpadded base64url. Decode, check byte length, then re-encode
to require the identical spelling, including unused pad bits. Random intent,
state, request, delivery, voucher and launch identifiers contain at least 256
bits of entropy and are 43 to 128 URL-safe characters. A SHA-256 or HMAC digest
is 32 bytes (43 characters); an ES256 signature is a 64-byte IEEE-P1363 r||s
value (86 characters), not DER. Public keys contain only EC/P-256 kty, crv, x
and y; point import must succeed and private JWK members refuse.

Times are integer epoch milliseconds. For signed control request admission require `issued_at <= now +
30000`, `issued_at < expires_at`, `expires_at <= issued_at + 60000`, and `now <
expires_at`. All operation deadlines also obey the shorter local intent and
voucher deadline. Launch lasts at most two minutes; an owner intent and browser
transaction last at most ten minutes from owner creation. Do not restart either
clock at launch. Challenge and no-contact proof lifetimes are at most two
minutes. Voucher lifetime is at most 24 hours, always limited to the current
broker key generation. These are proposed v1 limits, not externally verified
provider limits.

## Keys, signatures and fingerprints

Broker keys use HKDF-SHA-256, 32-byte output, the app secret binding as input
key material, UTF-8 `qbo-broker/1:generation:N` as salt, and the exact role label
in `broker_hkdf_labels` as info. Launch, cookie, voucher, audit, quota and
no-contact keys are distinct. No other durable broker application secret is
introduced. Temporary delivery authentication material is described below.

For a signed owner request, `body_hash = base64url(SHA256(B(body)))`. The owner
signs `UTF8("qbo-broker/1/request\n") || B(request_without_signature)` with
ECDSA P-256/SHA-256. This covers method, route, request ID, both timestamps,
generation, the complete voucher, body and body hash. Verify against the exact
install public key in the verified voucher. Compare HTTP method/path with the
signed fields; reject queries and redirects. Recomputing the body hash does
not repair a changed signature. TLS is required even for signed requests.

A voucher MAC is HMAC-SHA-256 using the voucher key over
`UTF8("qbo-broker/1/voucher\n") || B(claims)`. It binds one public key, exact
callback, environment, issuance, expiry, random voucher ID and generation.
The owner treats the voucher as opaque broker authority, obtained over its
verified enrollment channel. HMAC does not give owners independent public-key
verification. Only the current generation is accepted.

The transient install fingerprint is base64url SHA-256 of the canonical whole
voucher. It binds a particular enrollment voucher, not an owner identity.
When stored in a broker audit/replay/quota row, the field named
`install_fingerprint` is instead HMAC(audit-key, `UTF8("install\n") ||
B(voucher)`). The broker computes it; callers cannot choose it. Other durable
ID hashes use the same audit key with distinct `event`, `request`, `intent`,
`state` and `launch` labels followed by LF and the exact UTF-8 identifier.
These durable pseudonyms are never used as envelope binding values. Broker
quota network hashes use the quota key and label `address\n` plus canonical
address bytes. Do not keep any token hash or raw body hash in durable rows.

The delivery key fingerprint is base64url SHA-256 of the canonical public JWK.
`provider_configuration_hash` is base64url SHA-256 of canonical environment,
public app identifier, fixed authorization/token/revoke endpoints and registered
redirect URI. The broker places this hash in the sealed transaction and
compares it to current configuration before exchange.

Company identity preserves the existing connector contract:
`[A-Za-z0-9._~-]{1,128}` with no surrounding whitespace. The owner recomputes
the lowercase hex SHA-256 of UTF-8 `quickbooks-company-v1:` plus the exact
realm. That company fingerprint remains compatible with source reservations
and reconciliation. Neither it nor the raw realm may enter broker storage.

## Enrollment

An authenticated owner Worker creates a signing key and fresh challenge. An
operator with the dedicated product-account Access role explicitly approves
the exact HTTPS callback, public key and environment. The issue route verifies
Access audience, issuer, expiry and role at the trusted boundary. Caller
headers cannot claim to be an Access principal. An approved operator is not
thereby an owner login.

The owner-approved bootstrap conveys the random challenge directly into the
Access-protected operator ceremony over HTTPS. Treat it as a confidential
one-use enrollment capability, not a public DNS value. It never appears in a
query, log, ordinary status response or support artifact. The operator page
must not cache or expose it to third-party scripts.

`enrollmentIssue` is posted to the issue route. Fetch the fresh
`enrollmentChallenge` only from the validated owner origin at the fixed
`/api/quickbooks/connect/enrollment/challenge` path, using the confidential
challenge as a non-logged Authorization Bearer capability. Unauthenticated
retrieval cannot return the challenge or consume it. The challenge signature is
ES256 over `UTF8("qbo-broker/1/challenge\n") || B(challenge_without_signature)`.
Verify challenge, callback, key, environment, generation and expiry exactly,
and atomically fence the broker's challenge hash before voucher issuance. The callback
SSRF rules below apply to both enrollment calls.

POST `enrollmentDelivery` directly to the same origin's fixed
`/api/quickbooks/connect/enrollment/voucher` path. The Worker accepts it only
for its still confidential, unexpired one-use challenge and the exact pending
key, callback and environment. Possession authenticates this direct delivery;
public HTTPS alone would not authenticate the broker to the Worker. Atomically
consume the owner challenge while saving the voucher and encrypted install
private key with exact readback. Store the canonical delivery hash and exact
status-only acknowledgement with the consumed challenge. Exact delivery retries
return that saved acknowledgement without another voucher save, including
after the consumed challenge expires; different bytes refuse. The broker retries
identical delivery bytes at most three times within ten seconds and the original
challenge deadline, without minting another voucher. The operator receives a status-only 202 after
verified delivery, never the voucher or an owner secret. The broker retains
only a permitted enrollment audit/replay record. These enrollment paths are
additional owner provisioning surfaces, not owner login APIs.

Emergency generation rotation invalidates every voucher. Selective revocation
may mark the exact HMAC voucher fingerprint revoked in the retained security
ledger, expiring no earlier than that voucher. Every start/launch/exchange/token
admission checks that marker. A same-generation voucher refresh needs the same
approved live challenge ceremony; there is no anonymous renewal endpoint.
Operator delegation, Access configuration, and rotation canaries are separate
deployment review gates.

## Start, launch and callback

The owner authenticates with the existing owner session and passkey requirement
before creating an intent. One pending intent per source is permitted. Store
the delivery private key and an independent one-time 32-byte
`delivery_auth_key` under the owner wrapping key. The signed `startRequest`
carries its public delivery key and authentication key over TLS to the broker.
The signed expected_token_generation is 1 on first connect and current+1 on
repair. Persist it with the source reservation in the owner intent and include
it in the sealed transaction; the broker cannot choose a reset generation.

Validate exact shape, signature, callback equality, voucher generation and
environment, expiry, quotas and uniqueness before committing the start row.
Return 201 with `launchResponse`: random capability plus `transaction` capsule.
The capsule solves the no-registry constraint. It encrypts `transactionPayload`
containing the callback/voucher, request and intent binding, delivery public
key, delivery authentication key, provider configuration hash, random state,
launch capability hash, start hash and deadlines. It contains no provider code
or token. It is carried by the browser, never stored by the broker.

Use AES-256-GCM with the launch key, fresh random 96-bit IV, and 128-bit tag.
AAD is `UTF8("qbo-broker/1/launch\n") || B({protocol,key_generation})`.
The capability hash is HMAC(audit-key, `UTF8("launch\n") || UTF8(capability)`).
`start_hash` is SHA-256 of the canonical whole signed start. Link the start
replay record to the capsule's state hash. Launch validates both capsule and
capability and atomically consumes the one-use start before redirecting.

Reseal the same payload with a fresh IV and the distinct cookie key, replacing
the AAD domain with `qbo-broker/1/cookie`. The cookie value is the compact
dot-separated `generation.iv.ciphertext.authentication_tag`, not base64 of
JSON. Require the complete Set-Cookie string to be less than 4096 UTF-8 bytes;
refuse oversized context before handing out a launch capability. The cookie is
host-only, Secure, HttpOnly, SameSite=Lax, scoped to the callback path, and
expires with the intent. Clear it on all handled callback outcomes. All pages
use no-store, no-referrer and restrictive CSP with no third-party assets or
body/query telemetry.

Redirect 303 only to the configured Intuit authorization endpoint using exact
client, registered redirect, `response_type=code`, Accounting scope and random
state. The capsule and cookie must survive broker restarts with only the
allowlisted ledger retained. The broker may not quietly keep an in-memory or
durable install registry as a correctness dependency.

Callback success has exactly state, code and realmId; denial has exactly state
and `error=access_denied`. Duplicate and unknown parameters refuse. Verify
state against decrypted cookie and ledger, original deadlines, generation,
voucher, environment and fixed provider configuration. If a trustworthy
transaction cannot be identified, do not consume another transaction supplied
only by an attacker. Refuse and expire through bounded cleanup. Return a 303
to a fixed, query-free static broker result page at `/v1/quickbooks/result`.
This static page exposes no status lookup or new API. With a verified binding,
the only owner result target is that callback origin's
`/app/connect/quickbooks`, with no query or fragment. It reads owner status.

Commit a unique `exchange_started` fence before the first provider request.
Only one provider code exchange is permitted, even on rejection, timeout,
restart, or simultaneous callbacks. A lost response consumes the state and
requires fresh consent. A confirmed cancellation marks the owner intent
canceled using the encrypted completion notice below; no token row is created.
Do not send provider error descriptions through the result URL or logs.

## Token delivery and owner receipt

Require nonempty bounded access and replacement refresh tokens, bearer token
type (case-insensitive provider spelling, encoded as `Bearer` in tokenBundle),
and positive finite integral returned expiries. Compute expiry timestamps
from actual receipt time with checked arithmetic. Missing refresh expiry refuses
activation; an absent hard-refresh expiry is null, never invented. A supplied
hard deadline must be valid and cannot be extended by rotation. Use the callback
realm for connect. A contradictory provider realm echo refuses activation.

For both `deliveryEnvelope` and `refreshResponse`, generate a new ephemeral
P-256 ECDH key, salt of 32 random bytes, and IV of 12 random bytes. Derive the
32-byte AES key using HKDF-SHA-256 on the ECDH shared secret, envelope salt,
and `UTF8("qbo-broker/1/envelope\n") || B(header)` as info. Encrypt
`B(tokenBundle)` with AES-256-GCM and `B(header)` as AAD; keep the 16-byte tag
separate. Header binds purpose, install, intent, callback, environment,
generation, delivery key fingerprint, request/delivery ID and expiry. Plaintext
bundle generation and identity must agree with those expectations.

Encryption to a public key alone does not authenticate the sender. Derive a
separate HMAC key using HKDF-SHA-256 on the one-time `delivery_auth_key`, the
same envelope salt, and `UTF8("qbo-broker/1/sender-auth\n") || B(header)` as
info. `broker_authentication_tag` is HMAC-SHA-256 of the canonical entire
envelope without that field. The owner verifies this MAC in constant time
before decrypting. The authentication key is confined to owner encrypted
operation state, broker transient memory and the sealed browser context. It
adds no durable broker secret and is destroyed with the operation.

POST the connect envelope to the exact verified callback using the pinned
destination and manual redirects. The owner checks unexpired intent, all
bindings, sender tag, successful authenticated decryption, company/source
reservation and wrapping-key availability. It atomically stores independently
encrypted access token, refresh token and raw company with independent IVs and
AAD binding field, source, environment and token generation. No plaintext or
wrapping key enters D1. A wrong/missing wrapping key cannot overwrite existing
ciphertext. Persist and read back the complete record before issuing a receipt.

The owner signs `UTF8("qbo-broker/1/receipt\n") || B(receipt.claims)` with its
installation key. Receipt claims bind the canonical envelope hash, delivery
and request IDs, install, intent, environment, broker generation and token
generation. Verify all claims against the delivered envelope. Owner signatures
are not evidence of a provider API read. The owner connection remains the
authoritative status even if the browser saw a failed handoff.

Same delivery ID plus identical canonical envelope bytes returns the exact
stored receipt without re-saving tokens, even after ephemeral key destruction.
Same ID with different bytes or a different second delivery refuses. Retain
the non-secret owner receipt through intent cleanup long enough to serve these
duplicates; it contains no plaintext credential. Keep its envelope hash local
to the owner, never in the broker audit ledger.

The ownerIntent schema distinguishes active `pending` and `saved` records from
terminal `committed`, `canceled`, `failed` and `expired` records. Both encrypted
delivery keys are required while active. Terminal records omit both key fields
entirely, including null placeholders, and retain only protocol, intent, status,
delivery ID, envelope hash and receipt for replay. If no delivery was accepted,
the three receipt fields are null in canceled, failed or expired records.
Committed records require a non-null delivery ID, envelope hash and token
deliveryReceipt; a completionReceipt cannot establish a committed connection.
Destruction removes the delivery public key,
callback and other active-operation context as well. The separate connection
record remains authoritative for source reservation and current credentials.

For a verified cancellation or terminal failure, send completionEnvelope with
purpose `completion` using the same ECDH and sender-MAC construction. Its
plaintext completionResult contains only protocol and one of owner_canceled,
failed or manual_provider_removal_required. Owner callback accepts the
ownerCallbackRequest union; it must never parse a completion as tokenBundle.
Persist the stable owner result and read it back before returning the signed
completionReceipt. Match the receipt outcome to the expected envelope purpose,
and match envelope hash, intent and every
binding. A matching receipt after key destruction is idempotent for these
outcomes as well. Untrusted callback state cannot trigger a completion notice.
If the owner callback is unavailable, leave its pending intent to expire visibly;
the browser result never fabricates successful owner notification. Failure
notification after a token delivery cannot overwrite an already connected
intent; owner status remains authoritative.
An authenticated owner status decision must expire overdue pending intents in
a bounded batch, destroy both temporary keys, and read back the exact terminal
record before reporting success. A failed readback must refuse and remain
recoverable. The offline fixture processes at most 32 records per status call;
later calls finish older backlogs without provider contact.

Retry delivery at most three total attempts and ten seconds, only within the
same active broker invocation and intent deadline, using the identical
encrypted envelope. Never queue it. If delivery is unconfirmed, attempt one
fenced revocation while a token remains in memory. If no usable token is
available after malformed/lost exchange, record uncertainty and direct the
owner to remove the grant at Intuit. Drop references on every return path;
JavaScript cannot promise physical memory erasure. Broker crash can leave an
untracked grant and must never become a later token recovery workflow.

## Refresh

The owner schedules refresh ten minutes before returned access expiry, with
up to one minute of early jitter. Already safely valid tokens do not refresh
just because a read starts. Acquire the per-connection lease, verify generation
and refresh/hard deadline, and commit outcome_unknown before sending one signed
`refreshRequest`. Refresh has a fresh delivery key and authentication key.

The body includes the current token, realm and company fingerprint transiently.
The broker recomputes the realm fingerprint for internal consistency but has
no registry with which to prove ownership or the current owner generation.
Owner D1 compare-and-swap and the local source reservation supply that proof.
Do not infer new provider identity proof from an absent realm echo on refresh.
A contradictory echo refuses. Provider success must contain a replacement
refresh token and an encrypted response bound to this exact operation.

The broker commits a unique refresh request fence before contact. No old token
retry follows ambiguous contact, including transport failure that cannot prove
noncontact. Owner commit atomically preserves the newest ciphertext, advances
generation exactly once, reads it back, then clears the fence. Failed readback
retains the newest available ciphertext and fence. Rejection, expiry, invalid
response or lost response moves the connection to reauthorization_required.
Both scheduled and direct reads remain disabled while reauthorization is
required and throughout disconnect. The ownerConnected and ownerStatus schemas
require `reads_enabled: false` in those states. Owner status also disables reads
when not connected, connecting, disconnected or locally destroyed with unknown
remote outcome. Connected and delayed status may permit reads only while the
credential remains valid and no unresolved mutation fence blocks its use;
the schema alone does not prove those runtime prerequisites.
No automatic loop on the old refresh token is allowed.

After a direct API 401, refresh only if the rejected generation is still
current, then retry that read once. Concurrent reads use the winning generation.
A second 401 refuses. A 429 respects Retry-After; provider 5xx and network
failures leave visible delayed freshness. An unstarted refresh during broker
outage may keep the current access token until its actual expiry, but an
uncleared mutation fence never authorizes continued scheduled use.

## Revoke, no-contact proof and destruction

Owner authentication and explicit disconnect confirmation precede disabling
scheduled reads and committing the revoke fence. Broker makes one provider
attempt and returns `revokeResponse`: confirmed, definitely rejected, or
uncertain, without provider details. A provider network failure is uncertain
even if the fake can internally tell that it happened before mutation.

Only a broker refusal known to precede all provider contact can return
`noContactProof`. Its MAC uses the no-contact key over
`UTF8("qbo-broker/1/no-contact\n") || B(claims)`. Claims bind original request,
install, intent, token generation, broker generation, expiry and operation_hash.
That hash is SHA-256 of canonical original revoke body without no_contact_proof.
It is carried only in the transient proof, never retained as a token surrogate.
Do not mint a proof if the durable decision could not be committed.

The owner receives this proof over authenticated TLS and treats the MAC as
opaque. Only the broker can cryptographically verify it. An explicit retry
uses a fresh signed request ID, the same revoke operation fields, and the
original proof. The broker verifies the original not_sent decision, exact
operation hash and expiry, atomically changes the original replay row from
not_sent to proof_consumed and inserts the new revoke_started request row before
contact. Both decisions form one transaction; competing retries cannot each win.
A new request ID never bypasses an attempted or
uncertain original operation. Replay identity is ledger-scoped; token hashes
are not retained. A malicious already-compromised owner can sign a new operation
with a stolen token; this protocol does not claim the broker can identify token
reuse across arbitrary authorized requests without a prohibited token registry.

Confirmed revoke destroys owner token/realm ciphertext and ephemeral keys,
retaining source reservation and non-secret receipt. Rejected/uncertain revoke
keeps all use disabled. Explicit local destruction remains available and must
say remote revocation is unconfirmed. Imported records are retained in either
case. Removing them is a separate preview and approval. If the owner Worker is
gone, revoke through Intuit; the broker has no recovery token.

## Durable ledger, quotas and failure responses

Only auditEvent, replayRow and quotaRow fields may persist in the broker.
Reject extra fields at the write boundary, not only during export. Do not store
raw callbacks, hosts, URLs, headers, user agents, errors, body hashes, voucher
bytes, company/token fingerprints, ciphertext, codes or credentials in any
cache, queue, exception, trace, metric label, backup or database row.

Replay uniqueness is `(generation, route, request_id_hash)` and, for callback,
`(generation, state_hash)`. Atomic compare-and-swap protects phase transitions,
launch consumption and provider_attempts <= 1. Verify exact readback before
success. Keep replay tombstones through the full acceptance window and skew;
30-day security retention is the proposed maximum. Never delete a live fence
because a pending invocation appears old. After expiry the old timestamp and
generation must still refuse even if its tombstone was pruned.

Quotas follow the wire contract. Network quota rows expire after at most two
windows, never longer than 20 minutes. Hourly install quotas count retained
audit/replay metadata rather than extending network-address retention. Enforce
route global circuit breakers and fail closed when replay/quota storage cannot
decide. Cleanup is bounded and deletion of expired metadata never becomes an
unbounded public request workload. Final retention needs the design's review.

Use stable allowlisted outcome codes from the schema, with 400 malformed,
401 invalid proof, 403 forbidden binding, 409 consumed/conflicting operation,
410 expired, 413 oversized, 415 content type, 429 quota, and 503 unavailable.
Callback handling always uses the query-free result flow. A revoke provider
outcome is a 200 result object because the operation was classified; that does
not mean remote revocation succeeded. Health returns readiness/build only,
503 when dependencies cannot safely decide, with no provider or owner content.
All responses are no-store. No untrusted provider text is reflected.

## Callback destination and data routing

Require exact canonical ASCII HTTPS hostname, default port, and the fixed
owner callback path. No URL credentials, query, fragment, nonstandard port,
IP literal, localhost, alternate encoded path, dot segment, trailing-dot host,
or URL-parser normalization is accepted. Reject all local, private, loopback,
link-local, multicast, reserved and nonpublic A/AAAA answers including mapped
IPv4. Validate every resolved answer, pin the validated destination for that
request, keep the approved Host/TLS name, and never follow a redirect. If the
Worker transport cannot enforce those DNS guarantees, enrollment and delivery
remain closed until a reviewed transport can. Schema URL patterns alone are
not SSRF protection.

Owner accounting reads construct the provider URL from the locally validated
realm, environment and supported entity allowlist. Preserve 1,000-row
pagination, exact source binding, bounded retries and explicit unavailable
deletion authority. No accounting request reaches the broker. Broker route
tests refuse all `/v3/company/` shapes, token lookup/recovery and proxy paths;
owner tests refuse create/update/delete verbs.

## State machine and verification scope

The machine-readable table defines five machines: enrollment, authorization,
token_request, owner_intent and owner_connection. All transitions require
independently verified facts; caller Boolean flags are never evidence. Missing,
false or unknown guards refuse. Terminal provider mutations never restart.
Owner complete intent allows only exact receipt replay. The state oracle is
test-only; it does not implement transactions, leases, encryption, or routes.
Model phases are logical states, not new database columns. Authorization
delivery_pending retains the exchange_started ledger phase until a receipt or
cleanup decision. A token_request started phase maps to refresh_started or
revoke_started according to its exact signed route; confirmed maps to refreshed
or revoked. No-contact and proof-consumed phases map directly. Owner canceled,
failed and complete intents permit exact receipt replay without a second write.
The model's `complete` phase maps to the stored ownerIntent status `committed`;
the intermediate `saved` phase retains its delivery keys until finalization.

For a token request the response-delivery-key guard means a valid one-time key
for refresh, and the exact key-free status response contract for revoke.
Generation-bound means cryptographically bound to the request; only the owner
can compare it to its current connection. Status storage projects active to
connected and uncertain refresh to reauthorization_required; disconnect states
always disable reads. Distinct state phases may share a public status without
erasing the durable operation fence.

Unit tests establish schema shapes, state prerequisites, cryptographic fixture
binding, fake provider behavior and probe harness checks. They do not establish
an operating deployment. The E2E probes run against the separate broker
foundation and a test-only owner handler. Their adapter requirements and attack inventory are in
[the probe guide](../probes/README.md). Intuit acceptance, browser cookie
behavior, Cloudflare routing/logging, DNS pinning, native D1 transactions and a
separately approved production canary all remain external gates.
