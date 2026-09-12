# Verified Cloudflare recovery

Recovery is complete only when an isolated Brain can be rebuilt from a D1
export and pass retrieval evaluation. A D1 bookmark or SQL file by itself is
not that proof because Vectorize is derived state and cannot be restored with
D1.

## Safety boundary

`operations/verified-recovery.mjs` creates an owner-only plan and state file.
The files contain only configuration fingerprints, fixed policy, aggregate
counts, and bounded status codes. They contain no manifest path, account or
resource identifier, hostname, query, answer, document identity, content, raw
provider response, or credential.

The source and target manifests must describe the same client, product version,
and embedding contract. The target D1 database, Vectorize index, Worker, and any
declared domain must be separate from the source. A provider adapter must then
prove that the target has zero user tables and zero vectors, with the expected
Vectorize dimensions and metric, before the first target write is reachable.

Initialize and inspect the control files with:

```bash
node operations/verified-recovery.mjs init \
  <source-manifest> <isolated-target-manifest> \
  <private-plan> <private-state>

node operations/verified-recovery.mjs status <private-plan> <private-state>
```

Both destinations are created as mode `0600` files and existing files are
refused. Instance plans and state are ignored by Git.

## Required lifecycle

The reviewed order is fixed:

1. Build a complete restorable D1 SQL stream from the reviewed durable tables
   and the exact checked-in migrations already applied on the source, then seal
   it as an authenticated version-1 recovery artifact.
2. Hash the ciphertext, open it only in the owner-only artifact directory,
   restore the plaintext stream locally with SQLite safe mode, run database and
   FTS integrity checks, and record only its schema, aggregate, and exact
   durable-data fingerprints.
3. Prove the remote restore target is the reviewed, empty D1 and Vectorize pair.
4. Open and import the exact verified artifact into that isolated D1 database.
5. Export the restored durable tables back from D1 and require integrity,
   schema, aggregate counts, and the exact data SHA-256 to match the source
   artifact.
6. Reconcile recovered security state while the target is still paused. Require
   the target's exact reviewed secret-name set, prove bank wrapping-key custody,
   keep the live `agent_action_receipts` authority table empty, and rewrap every
   recoverable legacy bank reference. Any reference that cannot be opened
   becomes explicit reauthorization state; no unsupported key version or
   actionable legacy rewrap work may remain.
7. While the reviewed compatibility Worker is deployed in
   `paused-for-upgrade` mode, drive the schema-35 `/api/admin/brain/bootstrap`
   contract until every D1 chunk has one query-visible vector, all durable batch
   receipts are confirmed, the outbox and submitted counts are zero, and no
   vector failed. A retry resumes the saved epoch, cursor, and batch history and
   never calls reindex to reset them. After exact inventory and provider-count
   proof, deploy only the pre-reviewed immutable active Worker version and prove
   that exact version and `active` mode before continuing.
8. Run post-restore health with zero failures and exact `vector_readiness`:
   `ready=true`, zero pending/submitted work, and equal D1/Vectorize counts.
9. Run the release evaluation profile with zero critical failures and zero
   unauthorized retrievals.

## The pause is a precondition of step 7, not a preference

Do not clear `VECTOR_DRAIN_MODE` by hand to give a stalled client their brain
back before the projection is rebuilt. Reprojection and availability are not
ordered that way, and they cannot be:

- `POST /api/admin/brain/bootstrap` answers `409` with
  `{"error":"the accelerated bootstrap requires the verified upgrade pause","paused":false}`
  whenever `VECTOR_DRAIN_MODE` is anything other than `paused-for-upgrade`.
  `acceleratedVectorBootstrap` refuses again below the route. Clearing the pause
  therefore does not unblock recovery; it removes the only endpoint that can
  finish it, and nothing can proceed until the Worker is paused again.
- `POST /api/admin/brain/drain` and `POST /api/admin/brain/reindex` are the
  mirror image: while the Worker is paused they answer `503` with
  `{"paused":true}`. They are the active-mode projection path and cannot stand
  in for the paused bootstrap.
- So there is no mode in which both paths work, and no valid order that
  unpauses first. Paused, the bootstrap is the only way to project. Active,
  drain and reindex are the only way. A corpus the code has marked
  `bootstrap_required` is rebuilt under the pause and nowhere else.

Clearing the pause also buys the client nothing they do not already have. The
pause is a corpus **write** barrier, not a read barrier: it refuses `POST` on
ingest, batch ingest, source registration, receipts and expectations, zone
assignment, forget, reindex, drain, and bank import. Retrieval is untouched.
The one retry-state exception is `/api/admin/brain/vector-retry`: its preview
with `{"confirm":false}` is read-only, and an owner-reviewed
`{"confirm":true}` deletes each selected retry-state row, including its
quarantine marker, failure code, last error, attempt history, timestamps, and
backoff, then resets attempts and the last error on the matching outbox row.
That discards stored failure evidence so the generation can be tried as new. It
does not write the corpus or call Vectorize. `/api/rag/think`
and `/api/rag/unified` answer normally while paused, and the MCP connector's
`think` and `search` are deliberately left open so a paused brain can still be
asked questions. What the client loses under the pause is the ability to add
documents, which is exactly what an unverified projection must not accept.

Returning to `active` before the projection is proven is the failure the
barrier exists to prevent: retrieval would look finished while the semantic
index was still partial. The active deployment is permitted only after the
exact completion receipt.

Every stage is persisted as `running` before its adapter executes. If the
process stops after an external write but before the completion receipt, the
next run retries that same stage. A mutating adapter must reconcile an already
completed write and return the same evidence. It must never infer that a write
did not happen from a missing local completion receipt.

The runner also requires both manifests to be reopened and matched to the plan
before and after every adapter call. A changed resource, runtime setting, or
manifest file therefore leaves the current stage retryable instead of letting a
credential or write cross the reviewed boundary.

The durable `.brain-recovery-export.sql.fbrenc` artifact is authenticated
AES-256-GCM ciphertext. Its independent version-1 key is resolved only from the
target manifest's `operations.recovery_artifact_key_secret` Keychain locator.
The key never enters a manifest, plan, state, command line, or artifact. A
plaintext SQL file exists only inside the owner-only directory while the local
verifier or Wrangler import callback owns it, and it is removed afterward. Any
stale plaintext or encryption temporary is a hard stop for manual review. The
single-file import contract refuses exports above 5 GiB; a reviewed
split-import procedure is required above that boundary.

## Disposable Cloudflare field gate

`operations/cloudflare-recovery-adapter.mjs` is the reviewed live provider
adapter. It can exercise the state machine only against an already-provisioned
disposable target. It cannot create, upload, delete, or destroy a Cloudflare
resource. Its sole Worker mutation is the exact 100-percent deployment of the
active immutable version already named in the reviewed target claim, after the
paused bootstrap has passed exact vector proof. It does not touch Supabase.

`operations/aggregate-field-observer.mjs` is the separate read-only progress
boundary for a supervised disposable bootstrap. It owns no provider client,
credential lookup, retry loop, deployment, drain, reindex, or write callback.
A reviewed adapter supplies a target-identity fingerprint, one fixed
aggregate-only D1 SELECT, and the Vectorize count. The observer brackets those
reads, rejects identity or corpus drift, and returns only counts and cursor
ordinals. Raw cursors, high-water identities, document identities, provider
responses, errors, and paths cannot enter its receipt. A local observer pass is
not Cloudflare field proof until the separately approved disposable campaign
binds those injected reads to the exact target resources.

A normal full D1 export cannot include an FTS5 virtual table. The adapter never
drops or changes source FTS. It exports data only from the exact reviewed table
allowlist, prepends the exact checked-in migrations recorded on the source, and
recreates the derived FTS index through those migrations and triggers. The
`vector_outbox` queue is recreated empty instead of copied because Vectorize is
rebuilt; source verification therefore also requires that queue to be empty.
Any unknown durable table, migration mismatch, schema mismatch, FTS integrity
failure, aggregate mismatch, or durable-data hash mismatch stops the run.
Migration checksums bind the exact reviewed SQL bytes. Schema comparison then
canonicalizes SQL comments and whitespace because D1 removes non-semantic
comments from `sqlite_schema` while local SQLite preserves them.

Cloudflare's remote D1 export takes a blocking lock. Run the source export only
in an approved maintenance window with source ingest and writes paused. The
`source_export_blocking_approval_fingerprint` is the explicit acknowledgement
for that exact source. It is not a claim that the adapter can detect traffic.

Before preview, prepare all of these locally and out of band:

- reviewed source and target manifests that produced the private recovery plan;
- an empty disposable D1 database, zero-count Vectorize index, and two immutable
  Worker versions in the reviewed Cloudflare account. The paused version must be
  the sole version deployed at 100 percent before the first field-gate stage;
- one shared random nonce in the target Worker, D1, and Vectorize names. The
  Worker name must end in `recovery-gate-<nonce>` and its hostname must be the
  matching `*.workers.dev` hostname. Production-like names are refused;
- exact bindings on both Worker versions to the target D1 and Vectorize
  resources, the reviewed Brain identity and version, and the required
  `ADMIN_KEY`, `RAG_PROXY_KEY`, and `SESSION_SIGNING_KEY` secrets. The only
  allowed optional names are `ANTHROPIC_API_KEY`, `BANK_FEED_CLIENT_ID`,
  `BANK_FEED_SECRET`, `BANK_FEED_WRAPPING_KEY_V2`, `ZOOM_ACCOUNT_ID`,
  `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, and `ZOOM_WEBHOOK_SECRET_TOKEN`. The
  two bank provider secrets must appear together, as must all four Zoom secrets.
  The target must include `BANK_FEED_WRAPPING_KEY_V2`, and its exact secret-name
  set must equal the source set plus that key when the source does not have it
  yet. The two target versions' bindings must be identical except that the
  paused version has
  exactly `VECTOR_DRAIN_MODE=paused-for-upgrade` and the active version has no
  `VECTOR_DRAIN_MODE` binding;
- local-only Google, Gmail, Drive, IMAP, iMessage, WhatsApp, and named-provider
  OAuth credentials stay outside the Worker secret set and the recovery
  artifact. Supabase Worker credentials are also excluded because this field
  gate requires D1 storage;
- a fresh manual Cloudflare review that the target Worker has no routes and no
  custom domains. Record the immutable paused version as
  `paused_worker_version_id`, the immutable active version as
  `active_worker_version_id`, their identical reviewed script hash as
  `worker_script_etag`, the empty route lists, and review timestamp in the target manifest's
  `operations.recovery_field_gate`. The adapter pins and inspects both versions
  on every target stage, but route inventory is a manually reviewed assertion
  because Wrangler does not expose it through this adapter;
- the target manifest's `operations.admin_key_secret` Keychain locator, with
  the disposable target key already stored there;
- the source manifest's `operations.admin_key_secret` Keychain locator when the
  source already has `BANK_FEED_WRAPPING_KEY_V2`, so the adapter can prove that
  its key fingerprint matches the target before import;
- the target manifest's `operations.recovery_artifact_key_secret` Keychain
  locator, containing an independent version-1 32-byte recovery artifact key;
- an executable Wrangler wrapper in an owner-controlled, non-writable-by-others
  directory that reads its Cloudflare token from Keychain at execution time;
- an owner-only directory for the encrypted recovery artifact and a complete
  private release evaluation golden set.

The decrypted SQL stream never carries live derived-index coordination. The
adapter exports the reviewed `install_state` row separately from the raw
provider tables and forces the ephemeral drain lease owner/expiry and projection
mutation ID/submission time to `NULL`. It also resets the bulk-bootstrap protocol to
`NULL`, its verified base count to zero, and `outbox_generation` to zero because
the queue counter and those receipts prove only the source Vectorize index. For
a nonempty corpus it records `bootstrap_required`, epoch 1, a null cursor, and
the exact SQL `MAX(chunk_uid)` high-water. The `vector_outbox` and
`vector_bootstrap_batches` tables remain in the restored schema, but their
provider-specific rows are excluded from the export and recreated empty.
`document_source_inventory` is also derived: migration 0034 recreates the table,
and its backfill and document triggers rebuild its rows. Inventory rows are
excluded from both the content export and aggregate fingerprint.
`agent_action_receipts` holds live single-use authority, so its rows are also
excluded; the restored table must remain empty before and after bank security
reconciliation.

Schema 44 result-family members and their portable family headers are durable
history and are restored after the schema-43 raw binding rows. The
`source_original_result_family_verifications` table remains in the schema, but
its rows are excluded from export and restore because they describe the source
deployment's Vectorize projection. A restored portable seal is historical
evidence only. It is not query-ready proof until the target Vectorize rebuild
finishes and the private deterministic retrieval verification is repeated.
The artifact opens `source_original_result_family_recovery_state` only while
the target has no imported corpus or provenance rows, keeps immutable binding
checks active, then deletes the marker and executes a fail-closed empty-state
assertion. Source inspection, restored snapshot checks, and promotion also
refuse any target with that marker left open.

Schema 45 accepted-resolution rows are portable historical lineage and restore
after their observation, binding, and result-family dependencies. The export
does not include the ephemeral admission rows, deployment-local result-family
verifications, or accepted-resolution activations. Closing the import marker
requires every restored accepted observation to have exactly one matching
portable resolution, every portable resolution to have its matching prior
unresolved observation and family receipt, and all local-only acceptance tables
to be empty.

Schema 46 carries the authority-chain version and predecessor on each portable
observation row. Legacy schema-42 through schema-45 rows may appear only as a
version-zero prefix. Before the import marker closes, every version-one row
must point to the immediately preceding same-original sequence, and every
version-one accepted observation must immediately follow the gap or failure it
resolves. Schema 45 legally allowed a version-zero accepted row to resolve an
earlier non-immediate gap. Recovery preserves that row as historical evidence,
but the schema-46 current view keeps it noncurrent and the head check refuses
reactivation with `history_advanced`. A restored later exclusion likewise
remains the head and blocks reactivating an older accepted resolution. No
deployment-local activation is restored or inferred from that history.

`observation_hash` is the digest of the event receipt fields established by the
schema-42 contract. It is not a self-authenticating chain hash and does not
digest the schema-46 predecessor edge. The authenticated whole recovery
artifact protects the exported row bytes, while the separate recovery-close
validator proves each version-one predecessor against D1 sequence. A future
receipt contract may bind the edge directly, but schema 46 does not reinterpret
or invalidate existing observation digests.

A restored accepted resolution is therefore not current verification for the
target deployment. After the recovered Vectorize projection is rebuilt, the
old preview approval is invalid and the exact target must be previewed again
under a new source lease. The full-admin-only recovery sequence is fixed:
record the current schema-44 `result_family`, verify that schema-44 receipt,
record the schema-45 `accepted_resolution`, then verify schema 45. Every stage
reruns or validates the exact one-target family, Vectorize, and production owner
retrieval proof. The record operation creates the fresh local verification and
activation; verify alone cannot recreate either. Until the complete sequence
succeeds, verification reports the resolution as requiring reactivation.

The portable history never establishes whole-source completeness. Recovery
does not enable the legacy no-target `provenance-repair --apply` command or
authorize OCR, source-wide reingest, source-wide deletion, deployment, or
customer execution. The exact-target lane may reingest only the newly previewed
native-readable original, reconcile only that original's family, and must keep
source receipts, cursors, and source-wide removal state untouched.

The exact verified artifact also anchors a versioned bank security proof in the
private recovery journal. Each ordered pair of hashes commits the row identity
and every bank field: the exact original semantic row and its one permitted
recovery result. Readable references normalize only their randomized wrapping
bytes inside the Worker and permit only the applicable version-1 to version-2
transition, never a downgrade. Unreadable legacy references permit only the exact
reauthorization status, fixed explanation, and timestamp recorded before any
reconciliation write. Non-bank durable data retains its exact full fingerprint.
Readbacks bracket proof collection with unchanged full snapshots, so an
interrupted rewrap or lost response cannot conceal another bank or corpus change.
The existing authenticated key-proof endpoint returns only bounded hashes and
positional pagination, never bank identifiers or references.

This proof supports at most 1,000 bank connection rows, including removed rows,
within the private journal's existing size limit. A larger inventory, missing
baseline, or changed proof leaves recovery paused and fails closed. Keep the
verified artifact and journal, and obtain a reviewed recovery plan with an
adequate proof bound; do not delete rows, edit the journal, or bypass the check.
After an ordinary interruption within the bound, rerun the same approved recovery
command with the same journal and pinned keys.
The artifact advances `session_generation` exactly once, invalidating every
cookie minted against the source even if the target uses the same signing key.
Target readback preserves that restored generation so retry fingerprints remain
stable.
The normalized row is then hashed together with the remaining durable table
export, so a retry cannot reuse a recovery artifact poisoned by an
invocation-local lease, mutation fence, or old provider receipt. Older exact
migration prefixes remain offline-inspectable, but the live field runner
requires both source and restored target to match the latest packaged migration
(currently exact schema 46) before any current bootstrap operation.

The preview is local only. It reads and fingerprints those files but does not
invoke Wrangler, read Keychain, or call either Brain:

```bash
node operations/cloudflare-recovery-adapter.mjs preview \
  --source-manifest <source-manifest> \
  --target-manifest <disposable-target-manifest> \
  --plan <private-plan> \
  --state <private-state> \
  --artifact-directory <owner-only-directory> \
  --wrangler-wrapper <owner-only-keychain-wrapper> \
  --golden <private-release-golden>
```

The preview returns six independent approvals:

- `plan_fingerprint` binds the full reviewed recovery policy and both manifests;
- `target_approval_fingerprint` binds the isolated D1, Vectorize, Worker, and
  hostname identity;
- `target_execution_approval_fingerprint` binds both pinned Worker versions plus
  the manually reviewed empty route and custom-domain claim;
- `source_export_blocking_approval_fingerprint` binds the source whose D1
  export will take a blocking lock during the approved maintenance window;
- `wrapper_approval_fingerprint` binds the exact Keychain-backed wrapper bytes;
- `golden_approval_fingerprint` is the SHA-256 of the exact private release
  golden bytes that will judge the restored Brain.

Copy all six values from that preview into the run command:

```bash
node operations/cloudflare-recovery-adapter.mjs run \
  --source-manifest <source-manifest> \
  --target-manifest <disposable-target-manifest> \
  --plan <private-plan> \
  --state <private-state> \
  --artifact-directory <owner-only-directory> \
  --wrangler-wrapper <owner-only-keychain-wrapper> \
  --golden <private-release-golden> \
  --approve-plan <plan-fingerprint> \
  --approve-disposable-target <target-resource-fingerprint> \
  --approve-target-execution <target-execution-fingerprint> \
  --approve-source-export-blocking <source-export-fingerprint> \
  --approve-wrapper <wrapper-fingerprint> \
  --approve-golden <golden-fingerprint> \
  --stop-after-stage restore_d1
```

`--stop-after-stage` is an optional supervised drill control. Its only accepted
values are `export_d1`, `restore_d1`, `reconcile_security`, and
`rebuild_vectorize`. The field gate
still requires all six approvals and completes all verification leading to the
named stage. It then persists that stage's completed evidence, releases the
field-gate lock, reports only the fixed code
`RECOVERY_FIELD_GATE_INTENTIONAL_INTERRUPTION`, and exits nonzero. Re-run the
identical approved command to continue. Because the named stage is already in
the durable completed prefix, the rerun does not execute its external effect or
stop there again. Omitting the option runs every remaining stage normally.

The separate mid-bootstrap interruption is not an ordinary recovery option.
It exists only for the exact synthetic v0.4.8 disposable field identity named
in `docs/release-evidence/v0.4.8-disposable-vector-field-plan.md`. A preview must
also receive the fixed test mode, the candidate SHA, the owner-only complete
`field-prepare-receipt.json`, and the exact owner-only npm archive recorded by
that receipt. Field preparation also reconstructs `wrangler 4.127.1` and its
complete host-compatible dependency closure from the exact SHA-512 npm cache
objects named by `package-lock.json`. It refuses a missing or corrupt cache
object and refuses when those trusted bytes differ from the checkout install
used by the offline suite. The fixed owner-only runtime directory, entrypoint,
Node executable, host tuple, package count, file count, byte count, and full
regular-file inventory are bound into the receipt. Before any provider command
or credential read, the adapter
compares every regular archive member byte-for-byte with the package root that
is executing, verifies the exact migration member set, and binds that inventory
to a seventh, plan-specific interruption approval. A copied flag, renamed
manifest, different receipt, different package byte, different source lock
file, or ordinary/customer identity fails locally.

The hook remains armed only while the exact paused Worker is deployed and the
verified restore contains at least 6,001 documents and 6,001 chunks. This
minimum is deliberate: the real bootstrap admits up to three 1,000-row batches
per call, so a smaller documented fixture cannot guarantee a non-final cut
after at least 3,001 durable admissions. Before the first POST, a private fixed
aggregate read proves the normalized opening state: epoch 1, base count zero,
protocol and cursor both `NULL`, zero batch rows, zero outbox work, zero
provider vectors, and unchanged D1/FTS aggregates. It waits
for a persisted non-final `bootstrap-v2` receipt and aggregate observation with
at least 3,001 actual epoch batch-row admissions. It then writes and fsyncs one
private checkpoint containing the epoch, aggregate counts, and only the SHA-256
of the nonempty private cursor. It raises
`RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_INTERRUPTION` through the normal adapter
failure path, so the recovery state remains retryable and the field lock is
released. No active-version promotion can occur before that stop.

Resume requires the same plan, state, manifests, artifact, wrapper, golden,
receipt, npm archive, exact prepared `wrangler 4.127.1` runtime closure and Node
executable, six recovery approvals,
and seventh interruption approval. Before the first resumed bootstrap POST,
the observer must prove the same paused target, epoch, ordinal cut, corpus,
high-water mark, durable ledger, and private cursor digest. That exact proof is
fsynced as a bound resume authorization before the POST. If a later POST commits
but its response is lost, a retry may accept only monotonic same-epoch progress
from the checkpoint. Confirmation may progress while the cursor remains at the
same exact private value after all rows have been admitted.

Paused complete parity is separately fsynced as a promotion authorization
before the exact reviewed active version is deployed. That marker permits a
retry to reconcile that exact version after a lost deploy response; it never
permits an unrelated active version or active promotion before parity. A
changed target, substituted cursor at the same ordinal, regressed ledger,
stalled receipt, orphaned authorization marker, or past-midpoint state without
the matching promotion proof is refused. The active checkpoint remains
available through later health/evaluation retries and is renamed to a private
completed receipt only after the whole verified recovery passes. A retry of an
already-complete durable state performs that local retirement without provider
or credential access. Every control file is pinned by inode and bytes through
use; retirement moves the resume and promotion authorizations first and the
checkpoint last, fsyncing and reading back the same inode and hash after each
move. Any live checkpoint, resume marker, or promotion marker blocks ordinary
recovery regardless of a completed filename. Completed receipts are evidence
only; their existence does not authorize reuse or bypass a live marker. A
machine/process loss can also leave the separate
field-gate lock; resume in that case remains blocked until a separately reviewed
stale-lock reconciliation, rather than automatic lock removal.

One disposable target can exercise all four checkpoint boundaries in order:

1. Run with `--stop-after-stage export_d1` and require the intentional nonzero
   exit. Confirm status now names `verify_export`.
2. Re-run with `--stop-after-stage restore_d1`. It resumes after the export,
   completes the verified import, then stops. Confirm status names `verify_d1`.
3. Re-run with `--stop-after-stage reconcile_security`. It proves the recovered
   bank wrapping key and clears all legacy bank-reference work before stopping.
   Confirm status names `rebuild_vectorize`.
4. Re-run with `--stop-after-stage rebuild_vectorize`. It resumes after the
   import, completes the vector rebuild, then stops. Confirm status names
   `verify_health`.
5. Re-run that exact fourth command. The rebuild is already checkpointed, so the
   run continues through health and release evaluation without rebuilding it.

Changing only this stop boundary does not authorize another resource or write.
The same manifests, target execution claim, wrapper, private golden bytes,
plan, and six approval fingerprints remain mandatory on every invocation. A
valid but changed golden set is refused before Cloudflare or Keychain access.

The adapter reopens and fingerprints the wrapper, manifests, golden set, and
artifact directory before and after every stage. Wrangler receives a narrow
child environment and transient private log directory, and runs from a private
copy of the exact approved wrapper. In the controlled interruption mode, each
call also copies only the prepared lock-integrity-derived runtime closure into
that fresh directory, revalidates it before and after the child, and invokes its
absolute entrypoint with the bound Node executable, global module search
disabled, and the inventoried synchronous resolution guard preloaded. The guard
permits Node built-ins and only module files whose canonical path remains inside
the materialized runtime. There is no `npx`, PATH, repository `node_modules`,
registry, or fallback resolution. Wrangler logging is sanitized and telemetry
is disabled.
Every command explicitly disables experimental provisioning and automatic
resource creation. Authenticated HTTPS
requests refuse redirects, contain no private values in URLs, and read the
target admin key from Keychain only after the target identity is proven. The
special interruption campaign accepts only a five-line wrapper: a literal
`/usr/bin/security find-generic-password` lookup with shell-inert account and
service labels, a non-empty token check, one export, and the exact pinned Node
exec. Its complete bytes are approval-bound; ambient Cloudflare tokens and
Wrangler OAuth fallback are not accepted.
Provider diagnostics, credentials, corpus content, and resource names never
enter the plan, state, or command output. The encrypted recovery artifact is the
one necessary durable corpus copy and remains mode `0600` in the owner-only
directory.

Interrupted runs resume from the persisted stage. A retry after import accepts
only an exact completed target or the original empty target. Any partial or
ambiguous target stops for review. The vector rebuild resumes from schema-35
durable bootstrap receipts while the paused version remains deployed. If the
active-version deployment succeeded but its local response was lost, a retry
accepts the already-active target only after exact corpus, vector inventory,
outbox, provider count, immutable version, binding, and active-mode proof. A
first rebuild attempt that finds the active version is refused. A leftover
`.brain-recovery-field-gate.lock` is also fail-closed; inspect the prior process
and private state before removing that lock manually.

Passing deterministic tests is not a production recovery claim. The remaining
live release gate is to provision the disposable resources out of band, refresh
the manual no-route/no-custom-domain review and both pinned version claims, pause
source writes for the approved export window, and complete one full run. That
run must exercise the four deterministic post-checkpoint stops above,
followed by independent Cloudflare confirmation that source resources and
production routes did not change. Disposal of the test resources is a separate
operator action; this adapter has no destroy command.

Cloudflare documents the current export and import commands in
[Import and export data](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
and the complete flags in the
[D1 Wrangler command reference](https://developers.cloudflare.com/d1/wrangler-commands/).
Vectorize inspection commands are in the
[Vectorize Wrangler command reference](https://developers.cloudflare.com/vectorize/reference/wrangler-commands/).
