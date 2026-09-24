# Recovery

## If something goes wrong

Do not start by deleting resources or running setup again. Stop the command that
is writing, keep the manifest, and choose the smallest recovery below.

### What is protected automatically

- D1 keeps point-in-time history automatically. Cloudflare currently retains
  30 days on Workers Paid and 7 days on Workers Free. D1 history and restore do
  not add a separate charge.
- A confirmed ingest, load, removal, update, upgrade, or legacy rollback first
  saves the manifest, source settings, and resumable ingest state in the owner
  backup folder. The Brain admin key is never copied there.
- `brain schedule <manifest> --install --backup` runs the same local backup
  daily on macOS and applies the manifest's retention setting. Windows Task
  Scheduler or Linux cron can run `brain backup <manifest>` daily.
- D1 is the durable document and chunk record. Vectorize is rebuilt from D1
  after a restore. A restore is not called complete until every chunk has a
  vector and the vector queue is empty.
- Cloudflare retains Worker versions separately. A Worker-code rollback does
  not roll back D1 or Vectorize.

The backup folder does not contain source files or an admin key. Put
`operations.backup.directory` on owner-controlled off-computer storage. Do not
put it inside a folder the Brain ingests. Keep the admin key in the owner's
password manager under the recovery-card entry.

### Undo the last protected change

First preview:

```bash
brain undo-last /full/path/to/brain.manifest.json
```

The preview prints the operation boundary, current counts, effects, and an
approval fingerprint. It changes nothing. Review it with the owner. If it is
the right boundary, repeat the command with the exact fingerprint:

```bash
brain undo-last /full/path/to/brain.manifest.json --approve <fingerprint>
```

This restores all D1 writes after that recorded operation boundary. It is not a
selected-row edit. Keep every ingest and update stopped from preview through
completion. The command pauses the Worker, restores D1, creates a clean
Vectorize index, rebuilds it from D1, proves exact counts, and writes a receipt.
The prior Vectorize index is retained for review. Later local ingest cursors are
cleared only after their pre-restore backup exists, so the next ingest performs
a full source comparison instead of trusting state from after the restored time.

### Go back to yesterday or another exact time

Use an RFC3339 timestamp with its timezone. Preview first:

```bash
brain restore /full/path/to/brain.manifest.json --to 2026-09-23T17:00:00-07:00
```

After owner review, use only the fresh fingerprint printed by that preview:

```bash
brain restore /full/path/to/brain.manifest.json --to 2026-09-23T17:00:00-07:00 --approve <fingerprint>
```

D1 restore is destructive and in place. Everything written after the selected
time is in scope. The command takes a pre-restore point and requires the undo
bookmark returned by Cloudflare before continuing. If any stage stops, keep the
Worker paused and review the receipt. Do not retry blindly.

### If the computer is lost

1. Install the same reviewed Brain version on the replacement computer.
2. Recover the exact manifest from the owner backup folder. Do not create a
   similarly named Brain.
3. Recover the admin key from the password-manager item named on the recovery
   card. Enter it only through the reviewed hidden credential ceremony. Never
   paste it into chat, a command, the manifest, or a support message.
4. Run `brain machine-continuity <manifest> --json`. Resolve every missing or
   unproven item before update, ingest, or restore.
5. Reinstall the daily backup schedule and verify one new local receipt.

If the admin key may be compromised, do not restore the old value. Use the
owner-approved `brain secrets` rotation path with a new password-manager value,
then refresh the managed assistant registrations. Cloudflare account access and
the exact manifest are still required.

### Recovery card

Complete the [recovery card](../onboarding/12-recovery-card.md) during install
and store it in the owner's password manager. The card records where recovery
material lives, not any secret value. A backup is not ready for computer loss
until the exact manifest and password-manager entry exist off that computer.

---

## Verified Cloudflare recovery

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
The fixed v0.4.8 campaign also requires an operator-attested continuous
no-competing-Vectorize-writer interval from target creation or provisioning
through acceptance of the final active composite proof. The exact manifest pair
and target resource fingerprint bind that approval.

Initialize and inspect the control files with:

```bash
node operations/verified-recovery.mjs \
  derive-vectorize-mutation-quiescence \
  <source-manifest> <isolated-target-manifest>

node operations/verified-recovery.mjs init \
  <source-manifest> <isolated-target-manifest> \
  <private-plan> <private-state> \
  --approve-vectorize-mutation-quiescence <reviewed-fingerprint>

node operations/verified-recovery.mjs status <private-plan> <private-state>
```

Both destinations are created as mode `0600` files and existing files are
refused. Instance plans and state are ignored by Git.

## Required lifecycle

The reviewed order is fixed:

1. Build a complete restorable D1 SQL stream from the reviewed durable tables
   and the exact checked-in migrations already applied on the source, then seal
   it as a version-1 encrypted provenance artifact.
2. Hash the encrypted file, open it only in the owner-only artifact directory,
   restore the plaintext stream locally with SQLite safe mode, run database and
   FTS integrity checks, and record only its schema, aggregate, and exact
   durable-data fingerprints.
3. Prove the remote restore target is the reviewed, empty D1 and Vectorize pair.
4. Open and import the exact encrypted provenance artifact into that isolated
   D1 database.
5. Export the restored durable tables back from D1 and require integrity,
   schema, aggregate counts, and the exact data SHA-256 to match the source
   export sealed in that artifact.
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
   never calls reindex to reset them. Page every D1 vector ID and every provider
   Vectorize ID and require exact set equality. Require the provider's stable
   processed mutation watermark to equal the Worker's verified projection
   barrier. Persist a durable promotion-intent receipt that binds that proof and
   the exact active version before issuing the deployment request. After
   promotion, repeat the D1, outbox, exact Worker, ID-set, watermark, and barrier
   proof before continuing.
8. Run post-restore health with zero failures and exact `vector_readiness`:
   `ready=true`, zero pending/submitted work, and equal D1/Vectorize counts.
9. Run the release evaluation profile once with zero critical failures and zero
   unauthorized retrievals. Require all non-`llm_call_log` durable content and
   sequence state to remain byte-for-byte unchanged. Validate the append's exact
   labels, model, call bounds, timestamps, sequential IDs, matching SQLite
   sequence advance, and nonnegative cost fields, then capture the final target
   D1 deletion-state fingerprint.

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

The durable `.brain-recovery-export.sql.fbrenc` file is the encrypted provenance
artifact. AES-256-GCM protects the file and verifies its integrity before its
plaintext is used. Its independent version-1 provenance-protection key is
resolved only from the target manifest's
`operations.recovery_artifact_key_secret` Keychain locator.
The key never enters a manifest, plan, state, command line, or artifact. A
plaintext SQL file exists only inside the owner-only directory while the local
verifier or Wrangler import callback owns it, and it is removed afterward. Any
stale plaintext or provenance-protection temporary is a hard stop for manual
review. The single-file import contract refuses exports above 5 GiB; a reviewed
split-import procedure is required above that boundary.

## Disposable Cloudflare field gate

The held v0.4.8 package uses a closed, fixed-campaign ladder: K0 local
Keychain preparation; A1 source provisioning; separately approved A3 target
provisioning; full recovery-plan freeze; A2 source deployment; the fixed
synthetic seed; A4 target deployment; provider-neutral recovery through active
promotion; target evaluation and A12 retention; source teardown A13/A14; target
teardown A15/A16; and the held A17 local Keychain closeout. Aggregate
publication is a later independent decision. Each executable step consumes its
exact preceding private receipts and has a separate state-bound fingerprint.

Run the installed package commands, not mutable checkout entry points, and read
their supported help before preparing private arguments:

```bash
brain-v048-disposable-keychain-prep help
brain-v048-disposable-deploy help
brain-v048-disposable-teardown help
brain-v048-disposable-closeout help
```

Target evaluation deliberately accepts only its fully specified
`brain-v048-disposable-target-eval preview` and `execute` forms. Missing or
unknown arguments print one fixed usage line and refuse before reading private
evidence. Its artifact directory is the exact campaign receipt directory, and
execute writes the fixed `v048-disposable-target-eval-receipt.json` there for
teardown.

K0 is the only step before the first provider call. Its preview reads sealed
local evidence and the presence state of four fixed Keychain items. Execute
requires the exact preview fingerprint and an explicit single-operator
confirmation. If K0 stops partway, use only `reset-preview` followed by the
exact-approved `reset-execute`. Do not rerun fresh or delete an item by hand.
Reset removes only a current value whose hash still matches the durable K0
marker, and it never touches the shared Cloudflare token.

The A12 target evaluation changes neither corpus nor provider state. Its
private questions may create ordinary aggregate usage records. A12 completes
only after its owner-private receipt is reviewed and retained. The source and
target teardown ceremonies then remain separate and preserve A13/A14 before
A15/A16 ordering.

The A17 review surface is present. A17 is implemented offline and locally
fixture-tested, but remains held, unfielded, and uncertified. It has no field or
live proof and grants no release authority. Any execution must reopen and hash
the exact manifests, plan, state, package, field receipt, recovery wrapper,
golden, receipt directory, and encrypted provenance artifact before each
deletion. The implemented closeout may remove only the four fixed campaign
Keychain values and must prove the shared test token remains. The
retained evidence includes the sanitized receipts, encrypted provenance
artifact, plan, state, manifests, exact package, field receipt, reviewed
wrapper, and private golden. Transient provider runtime directories are not
retained evidence. None of these commands grants provider, release, update,
customer, or publication authority.

`operations/cloudflare-recovery-adapter.mjs` is the reviewed live provider
adapter. It can exercise the state machine only against an already-provisioned
disposable target. It cannot create, upload, delete, or destroy a Cloudflare
resource. Its sole Worker mutation is the exact 100-percent deployment of the
active immutable version already named in the reviewed target claim, after the
paused bootstrap has passed exact vector proof and the durable promotion-intent
receipt is closed. It does not touch Supabase.

Provisioning and immutable-version deployment belong to the separate packaged
`brain-v048-disposable-deploy` dispatcher.
`operations/cloudflare-disposable-deployment-transport.mjs` is its sole
Cloudflare HTTP layer. Source and target phases have separate local previews,
read-only provider preflights, mutation approvals, ambiguity journals, and
private receipts. Target preflight and final receipt bind the exact Worker
versions and reviewed generation, the closed network surface, complete campaign
custody, and the same continuous Vectorize mutation-quiescence approval carried
by the recovery plan. The final receipt is a mandatory recovery input for this
campaign.

The provider's source and target semantic role records carry
`network_isolation` and `worker_generation`. Target preflight and final semantic
records also carry `campaign_custody`. Both target receipts carry a top-level
`vectorize_mutation_quiescence` claim; recovery validates the final receipt's
`vectorize_mutation_quiescence.approval_fingerprint` against the plan before any
provider or credential boundary.

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

The network-isolation receipt proves the exact workers.dev identity, proves
previews and cache are disabled, and requires zero routes, custom domains,
schedules, tails, extra Worker exports, assets, and logpush. The custody reader
exhaustively inspects every
traffic-bearing version of every non-campaign Worker and refuses if any one
binds either campaign D1 database or Vectorize index. Counts alone, a resource
name, or the absence of a route in the manifest cannot replace these provider
reads.

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
For this disposable campaign, do not resume any source D1 write after
`verify_export` accepts its deletion-state fingerprint; the freeze continues
through the A14 source teardown commit.

Before preview, prepare all of these locally and out of band:

- reviewed source and target manifests that produced the private recovery plan,
  including the accepted continuous Vectorize mutation-quiescence fingerprint;
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
- the final owner-private deployment receipt produced by
  `brain-v048-disposable-deploy target-mutate`. It must close the source receipt,
  seed receipt, target preflight, exact provider deployment ID, independent
  paused and active version IDs and script etags, reviewed Worker generation,
  network-isolation proof, campaign-custody proof, and the exact same Vectorize
  mutation-quiescence claim. Provider etags remain opaque per-version drift
  identifiers, not local code digests. The recovery adapter reopens this receipt
  and reinspects the exact versions on every applicable target stage;
- the target manifest's `operations.admin_key_secret` Keychain locator, with
  the disposable target key already stored there;
- the source manifest's `operations.admin_key_secret` Keychain locator when the
  source already has `BANK_FEED_WRAPPING_KEY_V2`, so the adapter can prove that
  its key fingerprint matches the target before import;
- the target manifest's `operations.recovery_artifact_key_secret` Keychain
  locator, containing an independent version-1 32-byte provenance-protection
  key;
- an executable Wrangler wrapper in an owner-controlled, non-writable-by-others
  directory that reads its Cloudflare token from Keychain at execution time;
- an owner-only directory for the encrypted provenance artifact and a complete
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
digest the schema-46 predecessor edge. The encrypted provenance artifact
protects the exported row bytes as a whole, while the separate recovery-close
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
export, so a retry cannot reuse an encrypted provenance artifact poisoned by an
invocation-local lease, mutation fence, or old provider receipt. Older exact
migration prefixes remain offline-inspectable, but the live field runner
requires both source and restored target to match the latest packaged migration
(currently exact schema 46) before any current bootstrap operation.

The v0.4.8 campaign records two separate deletion-state identities. During
`verify_export`, the adapter double-captures the source's exact binding,
migration checksums, integrity result, complete table and schema inventory,
durable and FTS shadow-table export bytes, reviewed SQLite sequence rows, and
FTS count. During `verify_eval`, it captures the same complete fingerprint for
the final target. Raw schema and export material remain private; only the
domain-separated fingerprints enter recovery evidence. The later teardown must
freshly double-capture the selected D1 and match the applicable stored
fingerprint immediately before deletion.

The exact persisted field names are part of the v0.4.8 contract:

| Location | Required evidence |
| --- | --- |
| Plan | `vectorize_mutation_quiescence_sha256` |
| `verify_export` | `source_d1_deletion_state_fingerprint` |
| `rebuild_vectorize` | `vectorize_mutation_quiescence_sha256`, `vector_id_set_sha256`, `vector_watermark_sha256`, `vector_barrier_sha256`, `promotion_intent_sha256` |
| `verify_eval` | `final_d1_content_fingerprint`, `final_d1_deletion_state_fingerprint`, `target_eval_llm_append`, `vectorize_mutation_quiescence_sha256` |
| Field proof | `source_phase_receipt_sha256`, `deployment_receipt_sha256`, `seed_receipt_sha256`, and the interruption, resume, and promotion authorization hashes |

The same quiescence value must match the target deployment receipt, plan,
rebuild evidence, and final evaluation evidence. Teardown consumes these values
and the receipt hashes from the complete recovery state; it does not rediscover
or substitute them by resource name.

Deletion-state continuity is a separate write freeze. From accepted
`verify_export` evidence through source teardown, and from accepted `verify_eval`
evidence through target teardown, no Worker route, model evaluation, direct SQL,
Wrangler command, dashboard action, or other path may mutate the applicable D1.
Only read-only provider/custody observations and the bounded D1 captures needed
to re-prove the stored fingerprint are permitted. Lifecycle quiescence governs
resource creation, replacement, rebinding, and deletion; Vectorize quiescence
governs competing projection writes. Neither one permits or masks D1 drift.

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
  --golden <private-release-golden> \
  --field-deployment-receipt <owner-only-final-target-receipt>
```

For the exact v0.4.8 campaign, the preview returns eight independent approvals:

- `plan_fingerprint` binds the full reviewed recovery policy and both manifests;
- `target_approval_fingerprint` binds the isolated D1, Vectorize, Worker, and
  hostname identity;
- `target_execution_approval_fingerprint` binds both pinned Worker versions plus
  the deployment receipt's exact generation, bindings, network isolation, and
  campaign custody;
- `source_export_blocking_approval_fingerprint` binds the source whose D1
  export will take a blocking lock during the approved maintenance window;
- `wrapper_approval_fingerprint` binds the exact Keychain-backed wrapper bytes;
- `golden_approval_fingerprint` is the SHA-256 of the exact private release
  golden bytes that will judge the restored Brain;
- `implementation_approval_fingerprint` binds the sealed recovery entrypoint,
  complete local import graph, package contract, and migration bytes; and
- `vectorize_mutation_quiescence_approval_fingerprint` binds the exact target
  and the operator's continuous no-competing-writer interval.

Copy all eight values from that preview into the run command:

```bash
node operations/cloudflare-recovery-adapter.mjs run \
  --source-manifest <source-manifest> \
  --target-manifest <disposable-target-manifest> \
  --plan <private-plan> \
  --state <private-state> \
  --artifact-directory <owner-only-directory> \
  --wrangler-wrapper <owner-only-keychain-wrapper> \
  --golden <private-release-golden> \
  --field-deployment-receipt <owner-only-final-target-receipt> \
  --approve-plan <plan-fingerprint> \
  --approve-disposable-target <target-resource-fingerprint> \
  --approve-target-execution <target-execution-fingerprint> \
  --approve-source-export-blocking <source-export-fingerprint> \
  --approve-wrapper <wrapper-fingerprint> \
  --approve-golden <golden-fingerprint> \
  --approve-implementation <implementation-fingerprint> \
  --approve-vectorize-mutation-quiescence <quiescence-fingerprint> \
  --stop-after-stage restore_d1
```

`--stop-after-stage` is an optional supervised drill control. Its only accepted
values are `export_d1`, `restore_d1`, `reconcile_security`,
`rebuild_vectorize`, and `verify_eval`. The field gate still requires all eight
base approvals and completes all verification leading to the
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
that receipt. Append this exact suffix to the preview command:

```bash
  --test-interrupt-mid-bootstrap v048-synthetic-disposable-field-proof-v1 \
  --test-bootstrap-candidate-sha <40-hex-candidate-sha> \
  --test-bootstrap-field-receipt <owner-only-full-field-receipt> \
  --test-bootstrap-package <exact-owner-only-tarball> \
  --test-bootstrap-source-phase-receipt <owner-only-source-phase-receipt> \
  --test-bootstrap-deployment-receipt <owner-only-final-target-receipt> \
  --test-bootstrap-seed-receipt <owner-only-seed-receipt>
```

Append the same seven flags to the run command and add its ninth approval:

```bash
  --approve-test-bootstrap-interruption <interruption-fingerprint>
```

The test deployment-receipt path must name the same pinned final target receipt
already supplied through `--field-deployment-receipt`. Field preparation also
reconstructs `wrangler 4.131.1` and its
complete host-compatible dependency closure from the exact SHA-512 npm cache
objects named by `package-lock.json`. It refuses a missing or corrupt cache
object and refuses when those trusted bytes differ from the checkout install
used by the offline suite. The fixed owner-only runtime directory, entrypoint,
Node executable, host tuple, package count, file count, byte count, and full
regular-file inventory are bound into the receipt. Before any provider command
or credential read, the adapter
compares every regular archive member byte-for-byte with the package root that
is executing, verifies the exact migration member set, and binds that inventory
to a ninth, plan-specific interruption approval. A copied flag, renamed
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

Resume requires the same plan, state, manifests, encrypted provenance artifact,
wrapper, golden, deployment receipt, npm archive, exact prepared `wrangler
4.131.1` runtime closure and Node executable, eight base recovery approvals,
and the ninth interruption approval. Before the first resumed bootstrap POST,
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
second, durable promotion-intent receipt is then written before the provider
deployment request. It binds the exact ID set, processed mutation watermark,
Worker barrier, active version, implementation, wrapper, plan, and continuous
quiescence approval. If the deployment response is lost, recovery can accept
only the exact already-active state that receipt names; it does not blindly
repeat the request. A
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

The ordinary `--stop-after-stage` control accepts five boundaries:

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
5. Re-run with `--stop-after-stage verify_eval`. The rebuild is already
   checkpointed, so the run continues through health and the one allowed
   evaluation attempt, durably completes the journal, then returns the
   intentional stop.

The 6,001-record mid-bootstrap fault is a different control and cannot be
combined with `--stop-after-stage`. For that campaign, use the stage stops only
through `reconcile_security`, then invoke the full test-only argument set while
`rebuild_vectorize` is current. Its first invocation must stop at the reviewed
non-final bootstrap point; its identical approved retry resumes the same epoch
and continues through promotion, health, and evaluation. A later local-only run
may retire the completed checkpoint files without provider or credential
access.

Changing only this stop boundary does not authorize another resource or write.
The same manifests, target execution claim, wrapper, private golden bytes,
plan, deployment receipt, and eight base approval fingerprints remain mandatory
on every invocation. A
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
enter the plan, state, or command output. The encrypted provenance artifact is
the one necessary durable corpus copy and remains mode `0600` in the owner-only
directory.

Exact Vectorize proof is deliberately stronger than aggregate parity. The
adapter proves that every D1 chunk has one distinct non-null vector ID, reads
the entire provider ID inventory through bounded pages, rejects duplicates,
extras, omissions, truncation, or cursor loops, and requires identical
domain-separated set fingerprints. It reads the provider watermark before and
after the Worker's authenticated vector-readiness barrier and requires both
watermark observations to be stable and to name the barrier mutation. The same
composite is stable-double-read while paused and after the exact active Worker
is deployed.

Evaluation is the only stage classified as an isolated target audit write. Its
opening and closing D1 captures exclude only `llm_call_log`; all other durable
tables, schema, non-LLM sequences, and FTS shadow bytes must stay identical. The
allowed append is validated against the private golden's exact call bounds, the
reviewed answer model, the `rag-think` and `rag-evidence-gate` labels, and the
evaluation time window. Its IDs must be sequential, its SQLite sequence must
advance to the final ID, and each captured cost field must be nonnegative. An
attempt after the first fails with
`RECOVERY_TARGET_EVAL_RETRY_REVIEW_REQUIRED` so an ambiguous prior model call is
never silently repeated.

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

## Receipt-bound disposable teardown

Teardown is a separate mutation authority. The historical
`scripts/teardown-test-brain.mjs` operator path is retired. Its `--name`,
`--v048-campaign`, source, target, and `--commit` forms stop locally and direct
the operator to the fixed packaged broker. They cannot read a Cloudflare token
or reach a provider.

Use only the installed package entry point and inspect its current fixed
arguments before preparing private paths:

```bash
brain-v048-disposable-teardown help
```

The broker exposes four separate ceremonies in the required order:

```text
source-preview  -> A13, read-only Cloudflare observation and private approval receipt
source-mutate   -> A14, exact approved source deletion and absence receipt
target-preview  -> A15, read-only observation after the completed A14 receipt
target-mutate   -> A16, exact approved target deletion and absence receipt
```

Every command requires the fixed common arguments printed by `help`, including
the exact candidate, package, field receipt, complete recovery plan and state,
private golden, receipt directory, source and target manifests, reviewed
Wrangler wrapper, teardown wrapper, and the explicit maintenance-window
confirmation. Each mutation also requires the fingerprint emitted by its own
immediately preceding preview. Do not translate these commands back into a
direct `node scripts/teardown-test-brain.mjs` invocation.

The owner maintains one continuous maintenance window in which no dashboard,
API, Wrangler, token, or other lifecycle writer creates, replaces, rebinds, or
deletes either campaign role. Only the separately approved A14 and A16 broker
mutations are permitted. The target preview is unreachable until the fixed
source receipt proves all three source resources absent.

Each role captures the full two-role campaign custody before work and adjacent
to every mutation. It deletes only the selected Worker's exact name, then its
Vectorize index, then its D1 UUID. It proves exact absence after each request
while requiring every non-selected identity to remain fixed. Immediately before
D1 deletion, it double-captures the database's full deletion state and requires
the source `verify_export` or target `verify_eval` fingerprint. Any uncertain
delete response, changed custody, unmatched Worker generation, changed D1
state, or incomplete absence proof is an ambiguous stop, never a cleanup pass.

Keep the source D1 write-frozen from its accepted `verify_export` fingerprint
through the A14 commit, and keep the target D1 write-frozen from its accepted
`verify_eval` fingerprint through the A16 commit. Do not make a retrieval call
that appends model-usage audit rows, invoke any corpus or projection mutation,
or run direct SQL during either interval. A mismatch is a stop, not permission
to refresh the stored fingerprint.

Passing deterministic tests is not a production recovery claim. The broker is
implemented and locally fixture-tested, but this held v0.4.8 candidate remains
unfielded and uncertified. The remaining live gate still includes A1 through
A12, the 6,001-record interruption and resume, exact projection, promotion,
health, immutable evaluation, independent protected-resource confirmation, and
the separate A13 through A16 broker ceremonies proving source-before-target
absence. None of those provider actions has occurred in the offline candidate.
This document authorizes no deployment, deletion, release, customer action, or
publication.

Cloudflare documents the current export and import commands in
[Import and export data](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
and the complete flags in the
[D1 Wrangler command reference](https://developers.cloudflare.com/d1/wrangler-commands/).
Vectorize inspection commands are in the
[Vectorize Wrangler command reference](https://developers.cloudflare.com/vectorize/reference/wrangler-commands/).
