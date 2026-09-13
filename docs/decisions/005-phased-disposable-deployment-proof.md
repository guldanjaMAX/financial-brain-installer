# ADR 005: Split disposable deployment proof across causal approval phases

- Status: Proposed
- Date: 2026-09-12
- Owners: Product and engineering
- Confidence: High on the approval and ambiguity boundaries, medium on the
  first live Cloudflare response fixtures
- Supersedes: None

## Problem

The v0.4.8 disposable recovery campaign must prove a specific causal order:
deploy and seal the synthetic source, seed that exact source, then approve and
prepare the empty target. The current fixture-only producer uploads and deploys
both Workers under one approval and emits one combined receipt. The seed receipt
also expects target version identifiers that should not exist yet. Adding a
Cloudflare implementation behind that interface would make the wrong order
executable.

Worker version upload and traffic deployment are separate remote mutations. A
timeout or lost response can occur after Cloudflare commits either mutation. A
single whole-run pending marker cannot identify which boundary was crossed, and
blindly repeating a version upload can create an unreviewed extra version.

The provider must also preserve the existing credential boundary. The account
token belongs only inside the owner-approved Keychain-backed child process. It
must not enter the coordinator, arguments, receipt, journal, error text, or
repository.

## Options considered

1. Keep the combined producer and add a thin provider. Rejected because it
   crosses the separate source and target approvals and requires target
   deployment before source seeding.
2. Use only Wrangler's version commands. Rejected for this campaign because the
   pinned version does not preserve the exact baseline `version_id` on every
   inherited secret binding. Latest-secret inheritance is not exact recovery
   evidence.
3. Use the stable Cloudflare Workers API through a narrow, Keychain-backed child
   transport, with separate source and target producers, phase receipts, and a
   durable per-mutation journal. Chosen.
4. Deploy through the older whole-script upload endpoint and infer the active
   target version afterward. Rejected because the recovery gate needs an active
   target version uploaded but not promoted, plus an independently pinned paused
   version.

## Decision

Disposable deployment is two separately approved state machines. The source
phase may upload and deploy only the reviewed active source version. Its final
receipt must exist before the fixed synthetic seeder can run. The target phase
requires that source receipt and the completed seed receipt, performs a fresh
read-only target preflight, then may upload the reviewed paused and active target
versions and deploy only the paused version. The final target receipt binds both
earlier receipt hashes.

Each remote mutation gets a unique, phase-scoped journal step. The coordinator
durably records the exact request hash and `sent_unconfirmed` state before the
child call. It appends a confirmation only after a strict sanitized response is
validated and fsynced. A confirmed exact replay returns the recorded result
without repeating the mutation. A prepared or sent step without confirmation is
ambiguous and blocks all later mutations. Reconciliation may use read-only calls
only when the provider contract proves they identify the exact mutation.

The transport uses Cloudflare's Worker Version upload endpoint with
`bindings_inherit=strict`, and every secret names one exact baseline version.
Version upload never deploys. Traffic deployment uses the percentage strategy
with one exact version at 100 percent and never uses `force`. Exact Worker
version, deployment, script route list, workers.dev state, schedules, custom
domains, D1 identity, and Vectorize shape are read twice after the phase and must
match before a receipt can finalize.

Cloudflare response bodies remain inside the private child boundary. The journal
may retain bounded status, content type, body hash, request hash, operation ID,
and the provider identifiers needed for exact reconciliation. Public evidence
contains only approved aggregate claims.

## Consequences

- Source seeding can no longer depend on target versions or target traffic.
- The source and target need separate previews and approval fingerprints.
- A target approval is state-bound to the exact already-seeded source, not just
  to the candidate package and manifests.
- A lost version-upload response remains a deliberate stop. The documented
  stable version-list response does not provide a reliable annotation key for
  discovering that exact upload, so the system does not guess or retry it.
- The direct API child is a smaller executable boundary than a general
  Cloudflare client. It accepts only the fixed campaign operations and returns
  only strict sanitized observations.
- More private control files are retained until teardown. This is intentional:
  they distinguish interruption from absence and prevent an unsafe fresh start.
- Existing combined fixture receipts are not field evidence and cannot be
  converted into phased receipts.
- The provider and split package entry point now exist and pass fixtures.
  `DISPOSABLE_RECOVERY_DEPLOYMENT_PROVIDER_ENTRYPOINT_AVAILABLE` records that
  fact. `DISPOSABLE_RECOVERY_DEPLOYMENT_EXECUTABLE_PROVIDER_READY` retains its
  historical field-readiness meaning and remains false until both phases,
  journal recovery, exact double-read, packaging, and live disposable provider
  behavior are proven.

## Verification

- Unit tests cover exact phase schemas, ordering, approval binding, and receipt
  readback.
- Journal tests cut execution before and after every mutation boundary, proving
  exact replay, ambiguity refusal, conflict refusal, owner-only durability, and
  rejection of malformed or extra records.
- Transport tests assert exact methods, paths, strict-inheritance query, multipart
  metadata, baseline secret version IDs, no deploy-on-upload, no `force`, bounded
  responses, redirect refusal, and token absence from every output and error.
- Provider and dispatcher fixture tests derive every receipt field from canonical observations
  and fail on response drift, resource mismatch, missing routes, unexpected
  domains or schedules, and mismatched final reads.
- Package privacy and execution-inventory tests include the new shipped modules.
- The final field gate uses only the named synthetic resources and requires the
  separately approved source and target phases. Fixture success does not flip
  executable readiness or authorize that field action.

## Revisit when

- Cloudflare documents an idempotency key for Worker version upload or exposes a
  stable, unique client operation identifier in both upload and list/read APIs.
- The pinned Wrangler version supports exact per-secret inheritance from a named
  version without altering or dropping the identifier.
- The campaign no longer needs a pre-seed source receipt or an uploaded but
  unpromoted active target version.
