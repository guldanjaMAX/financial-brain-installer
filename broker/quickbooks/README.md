# QuickBooks broker foundation

This private, dependency-free package implements the `qbo-broker/1` control
routes. It is excluded from the installer publication allowlist. It has no
import path to owner records, accounting ingestion or the owner Worker. The
existing production connector remains closed.

`src/broker.mjs` exports `createBroker(dependencies)`. Dependencies include the
broker configuration, D1 store, clock, provider transport, owner transport,
resolver, verified Access boundary and optional allowlisted audit sink. There
is no global fetch fallback, credential lookup, environment read or registry.
Tests inject the in-memory provider from the protocol package. The only offline
endpoints accepted are the fixed reserved `.invalid` fixture endpoints.

The broker holds the shared app secret and sees codes, raw company identifiers
and tokens in memory. Only owner-side encrypted storage retains tokens. The
broker derives independent keys for vouchers, browser capsules, cookies, audit
identifiers, address quotas and no-contact proofs. Replacing the shared secret
requires a new generation and new install vouchers. JavaScript reference
removal does not guarantee physical memory erasure.

## Storage and readiness

Apply `migrations/0001_security_ledger.sql` only to a separate broker D1 database.
It starts this package's append-only migration history at 0001. Owner migration
0032 and all owner migrations remain untouched. The four tables contain closed
security events, replay decisions, short-lived quota counters and a singleton
build/generation readiness record. They have no payload, URL, token, ciphertext,
company, callback registry or free-form error column.

`createBrokerStore(db)` accepts the Worker D1 `prepare`/`batch` interface. A
provider call requires a committed replay fence and exact readback. Compare and
swap prevents two callbacks from exchanging the same code. Proof consumption
and its replacement revoke fence share one transaction. A new request ID cannot
repeat an already attempted token operation. Store failure never authorizes a
provider call. Tests execute migrations and these statements using real SQLite.

Readiness starts absent. An authorized deployment must record the exact build
digest and current secret generation with `setReadiness`, then read `/health`
back exactly. The handler does not create readiness during normal requests.
`ready: false`, a missing row, another build/generation or unreadable D1 closes
mutation admission. The readiness record contains no secret and is not a
per-install configuration store.

Security events and replay tombstones currently retain at most 30 days. Address
quota rows retain at most two windows and never exceed 20 minutes. Hourly
install limits count the replay ledger. A route circuit closes after 20 provider
rejections or uncertain outcomes in a minute; a separate global admission
counter caps each route at 1,000 requests per minute. These starting values need
load review. Schedule `store.cleanup({limit:100})`
through an approved deployment lifecycle; it deletes only expired metadata in
a bounded slice. Final retention remains subject to the design review.

## Enrollment and transport boundaries

`verifyAccess(request)` is a trusted injected verifier, not a claim from a
header. A deployment must validate the dedicated Access issuer, audience,
expiry and authorized operator role. Approval alone cannot issue a voucher.
The broker retrieves a fresh, confidential, signed owner challenge, verifies
the exact callback and install public key, commits its one-use fence, then
delivers the voucher only to the same owner Worker. The operator gets a status
response. The owner acknowledgement is the exact canonical object containing
`protocol`, `outcome: committed_readback` and the issued voucher fingerprint.
The owner stores the canonical delivery hash and exact acknowledgement with
the consumed challenge in the same transaction as the encrypted installation.
An identical retry returns that acknowledgement without another save, even
after challenge expiry; changed delivery bytes refuse. Enrollment delivery
reuses one voucher and identical bytes for at most three attempts within ten
seconds and the original challenge deadline.

Every owner call validates all injected DNS answers and supplies the approved
hostname and address set to `ownerTransport(request, destination)`. That
transport must actually pin the validated addresses while preserving the
approved Host/TLS name and honoring abort signals. A transport that merely
checks DNS and calls ordinary fetch does not satisfy the contract. This lane
ships no production transport or Access verifier. Enrollment and delivery must
remain closed until those deployment boundaries pass review.

Provider transport receives only fixed token/revoke requests with manual
redirect handling. Provider errors become fixed local outcomes. There is no
accounting, arbitrary fetch, token lookup, token recovery or support proxy route.
The browser receives only launch material, an encrypted transaction cookie and
query-free completion. Token delivery uses authenticated ECDH/AES-GCM envelopes
and exact signed owner receipts. Unconfirmed delivery permits at most three
identical envelope attempts in the same invocation, followed by one separately
fenced revoke while the token is still in memory. A broker crash cannot recover
or redeliver that token.

## Offline verification and deployment gates

Run only the focused files with the lane's mandatory network guard:

```text
node --import <offline-network-guard-url> --test broker/quickbooks/test/provider.test.mjs
node --import <offline-network-guard-url> --test broker/quickbooks/test/crypto.test.mjs
node --import <offline-network-guard-url> --test broker/quickbooks/test/store.test.mjs broker/quickbooks/test/boundary.test.mjs
node --import <offline-network-guard-url> --test broker/quickbooks/test/broker-security.test.mjs
node --import <offline-network-guard-url> --test protocol/quickbooks-broker/probes/broker.e2e.probe.mjs
```

The ordinary test graph registers the complete eleven-file foundation command
in both command lists, including all eight broker tests, the privacy test, the
E2E probe and the protocol wrapper. The lane runs that focused group directly;
registering it does not require running the full chain during lane work.

The adapter uses actual broker handlers and a test-only owner handler backed by
SQLite and authenticated encryption. It is not deployed owner integration. It
does not prove native D1 semantics, browser cookies, provider acceptance,
Cloudflare Access, DNS pinning, platform logging or a real-account canary.
The owner fixture expires overdue pending intents during authenticated status
reads, at most 32 per call. Each expired record loses both temporary keys and
all active context. Terminal records retain only the protocol, intent, status
and receipt replay fields. The intended stored row and its SQLite readback
must satisfy the closed owner-intent schema before commit; failure rolls back
the batch and refuses status. Enrollment and expiry readback attempts emit
fixed observations and increment attempt counters before the comparison.
Repeated polls finish older backlogs. This is not a deployed background task.

A deployment must disable request/query/body/header logging, exception payload
capture, tracing payloads and analytics labels that accept arbitrary data. The
optional application log sink accepts only the closed audit schema. Review the
actual platform settings separately. Do not bind this package to production
until the design's approval gates, reviewed transports, observability settings,
secret rotation rehearsal, incident runbook and explicit canary all pass.

For secret rotation, hold readiness, stop starts and token mutations, replace
the secret, deploy the matching generation, reissue vouchers through the live
ownership ceremony, verify a separately approved canary and exact health, then
resume. Old vouchers and in-flight capsules must fail. Rollback cannot restore
an old secret generation's authority silently.

For a compromise, hold readiness and disable broker ingress, rotate the shared
provider secret, revoke affected grants through the provider, and follow the
reviewed owner notification process. For normal offboarding, the owner disables
reads before revoke, destroys local ciphertext after confirmed revocation and
checks the grant at the provider. Imported records remain until a separate
previewed removal. If the owner Worker is gone, removal at the provider is the
only recovery route; the broker holds no recovery token.
