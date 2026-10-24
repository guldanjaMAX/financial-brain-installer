# VECTOR-EXCESS-PLAN

## Scope and conclusion

Round 1 was an offline source study of `f8a7cd05a1e641d29d5b3af77fc91901a5281639` on
`partner/vector-excess-plan-1`. The supplied observation is 1,922,668 provider
vectors against 1,922,642 expected vectors, a net excess of 26. It was not
independently observed against an installation.

The update refusal is intentional. It compares aggregate projection counts,
not vector identities. The least destructive repair is to enumerate both
complete ID sets under a proven writer exclusion boundary, preview their
difference, and delete only approved provider-only IDs through durable outbox
receipts. Reindex alone cannot identify those IDs.

The study and implementation plan are complete. Round 1's original commit
restriction is historical: the operator subsequently committed that report.
Round 2 leaves its reviewed changes in the working tree as instructed, with a
prepared commit below for the operator. Read-only Git metadata is not a handoff
blocker for this round.
This report is not live repair authorization or a claim that a supported
targeted-repair command exists.
The current general CLI has no such command. Its disposable recovery adapter
has useful enumeration checks but refuses more than 100,000 IDs. A separate
reviewed implementation and field approval are prerequisites for live use.
Round 1 added only this report. Round 2 adds a synthetic characterization of
the accelerated whole-corpus stored-ID remap and a canonical-ID control.
Product behavior, shared fixtures and configuration remain unchanged.

## Exactly what the preview compares

1. `worker/src/index.js:3301` builds the authenticated documents response with
   the Worker version, backend, writer mode, backlog and vector readiness;
   `:3335` calls `vectorReadiness` with the backlog from that response.
2. `worker/src/lib/store-d1.js:7523` obtains provider `describe()` and `:7527`
   reads `vectorCount`, falling back to `vectorsCount` or `count`. This is
   `actual_vectors`; it is not a provider-ID enumeration.
3. `worker/src/lib/store-d1.js:7546` reads the maintained
   `install_state.vector_projection_bootstrap_base_count` and `:7547` reads
   the live chunk sum from `corpus_stats`. At `:7565`, expected is an explicit
   count override if supplied, otherwise the maintained count when verified,
   or the larger of that count and the live sum while unverified. The documents
   route does not supply an override. Preview therefore does not execute a
   fresh `COUNT(*) FROM chunks` or compare against document-summary totals.
4. `worker/src/lib/store-d1.js:2327` establishes the maintained verified count
   only across an empty queue, processed fence and exact projection count.
   Its default count expression at `:2275` includes live chunks plus retained
   chunks of soft-deleted documents. They must remain in the repair's protected
   D1 set. Pending-state expected counts can be informational lower bounds.
5. `operations/update-preview.mjs:1223` validates the aggregate envelope,
   including coherent queue components and readiness. `:1348` checks the
   same-response version; `:1354` checks writer mode. `:1317` copies expected
   and actual counts; `:1332` assigns its field named `query_ready` from
   `readiness.ready`, not the Worker's more permissive `readiness.query_ready`.
6. `operations/update-preview.mjs:1385` selects `projection_excess` whenever
   actual exceeds expected after validation, including with queued work.
   `:73` declares the error code and `:1870` maps that verdict to
   `UPDATE_PREVIEW_PROJECTION_EXCESS`. The refusal remains read-only and
   non-authorizing (`:1876`). There is no percentage tolerance in this gate.

The separate small-excess query availability rule is at
`worker/src/lib/store-d1.js:7659` with its ratio constant at `:7706`.
The supplied excess is about 0.0013523%, below that rule's 0.01% threshold,
but it also requires settled work and other state checks. Search availability
does not establish exact projection readiness or permit an update.

Let `D` be every physical D1 chunk's stored provider ID and `P` the complete
provider ID set. With valid unique mappings, the net difference satisfies:

```text
|P| - |D| = |P \ D| - |D \ P|
26 = provider-only count - D1-only count
```

Thus 27 extras plus one missing vector produces the same observation as 26
extras and zero missing. Neither the preview nor count parity proves set
equality. Null, duplicate, stale, or incorrect D1 mappings are a separate stop.
The reported counts alone do not establish a root cause.

## Cause tree and code paths

The following covers the current D1 mutation paths, historical failure modes
documented by migrations, and external-state causes. It distinguishes durable
orphan hypotheses from normal temporary provider lag. No incident history or
provider inventory was available to attribute the supplied 26 to one branch.

| Branch | Source evidence | Interpretation and discriminating evidence |
| --- | --- | --- |
| Observation is unsettled or denominator is stale | `worker/src/lib/store-d1.js:7565`, `:3374` | Pending work, asynchronous visibility, or a stale maintained denominator can show excess without a proven orphan set. Compare stable exact inventories only after outstanding work is reconciled. |
| Whole-source or document forget | `worker/src/lib/store-d1.js:7834`, `:7837`, `:7845`, `:7848`; `worker/src/index.js:4215` | The same transaction retains stored vector IDs as deletes before removing D1 rows. Provider-only vectors exist until the drain confirms absence. An interrupted or failed drain should leave visible recoverable queue work. |
| Approved deletion and connector removal | `worker/src/lib/agent-action-receipts.js:407`; `worker/src/lib/ingest-removal-plan.js:77`, `:94`; `worker/src/lib/custom-api.js:1079` | These delegate to guarded forget, including obsolete connector versions. They have the same temporary gap rather than a separate provider-delete implementation. |
| Re-split and family reconciliation | `worker/src/lib/store-d1.js:8292`; `worker/src/lib/ingest-removal-plan.js:94`; `test/vector-delete-outbox.test.mjs:971` | Stale base documents, prior part counts and removed siblings use forget. Current parts and unrelated families stay protected. The old HTTP family arm is preview-only at `worker/src/index.js:4166`. |
| Shorter atomic revision | `worker/src/lib/store-d1.js:1659`, `:1671`, `:1740`, `:1751` | Queue old stored IDs, remove old chunks, then upsert retained current IDs in one batch. With canonical mappings, retained IDs are overwritten in place and only the removed tail stays a delete. Tail vectors are temporary extras until processing. |
| Resumable revision | `worker/src/lib/store.js:1027`; `worker/src/lib/store-d1.js:1792`, `:1795`, `:1814`, `:1526` | Replacement batches the old-ID queue and chunk deletion; subsequent chunk writes queue upserts. Interruption does not erase the queued old tail. |
| Identical-content retention path | `worker/src/lib/store-d1.js:1347`, `:1591`, `:1609` | Rows satisfying the retention predicate remain; all removed rows have their stored-ID deletes queued first under the same transaction predicates. |
| Failed, deferred, or quarantined delete | `worker/src/lib/store-d1.js:1887`, `:2498`, `:2624` | Failure/backoff can prolong excess. Retry state does not make a queued delete disappear. Incomplete receipt writes and visibility mismatches are not treated as permanent provider failures. Inspect queue and retry state before proposing orphan cleanup. |
| Delete versus in-flight upsert ordering | `worker/src/lib/store-d1.js:2575`, `:2593`, `:2606`, `:2638`, `:2941` | Accepted work is confirmed first, the global fence survives row replacement, eligible deletes precede new upserts, and one lease serializes drains. A cached negative delete probe can defer a concurrently enqueued delete to the next invocation (`:2608`). Backoff and quarantine remain visible. |
| Provider acceptance or receipt-write ambiguity | `worker/src/lib/store-d1.js:2495`, `:2497`, `:2761`, `:2768` | Provider acceptance precedes D1 receipt persistence. Current failures retain work. Confirmation requires a processed fence and exact absence for deletes (`:2386`, `:2423`); queue removal also matches ID, operation, generation and mutation receipt (`:2433`). Acceptance alone is insufficient. |
| Reindex and accelerated bootstrap | `worker/src/lib/store-d1.js:7465`, `:7478`, `:7493`, `:7067`, `:7075` | Reindex enumerates D1, so it leaves unknown provider-only IDs intact. Bootstrap supersedes upserts but preserves and drains deletes. Rebuilding the known set cannot subtract unknown IDs. Existing synthetic evidence records this limitation at `test/client-upgrade-rehearsal.test.mjs:832`. That file was inspected, not run. |
| Accelerated whole-corpus stored-ID remap | `worker/src/lib/store-d1.js:6306`, `:6461`, `:6473`, `:6483`, `:6577` | The batch queues the stored provider ID, upserts a recomputed canonical ID, moves D1 to that canonical ID, then clears the old-ID outbox row after canonical confirmation. It never queues deletion of a different old ID. Round 2 reproduces this with a preloaded provider: the old ID remains provider-only while its document and chunk still exist. The canonical-ID control converges. See `test/vector-bootstrap-stored-id.test.mjs:101` and `:123`. |
| Historical deletion protocol | `migrations/d1/0008_vector_delete_outbox.sql:3` | The migration documents permanent orphans when D1 deletion loses the historical vector ID and provider deletion fails. Affected version/history would support this branch; current source retains the ID. |
| Historical stale acknowledgement or concurrent drains | `migrations/d1/0010_vector_outbox_generation.sql:3`; `migrations/d1/0011_vector_drain_lease.sql:3`; `migrations/d1/0012_vector_visibility_receipts.sql:3` | Documented prior risks include same-millisecond replacement receipts, provider writes landing out of order, and acceptance preceding visibility. Current generation CAS, lease, and visibility checks address these classes; they do not discover already lost IDs. |
| Conditional legacy ID remap residue | `worker/src/lib/store-d1.js:162`, `:1659`, `:1740`, `:2064`, `:2746`; `migrations/d1/0004_corpus.sql:121` | If an old stored provider ID differs from the canonical ID for the same chunk UID, the single-key outbox can replace delete(old ID) with upsert(new ID). Drain also computes canonical IDs and remaps D1 without separately deleting a different old provider ID. Requires legacy, imported, inconsistent, or changed-ID-contract state; it is not evidence that ordinary current ingest creates this mismatch. |
| Conditional failed remap followed by forget | `worker/src/lib/store-d1.js:2761`, `:2133`, `:7838` | A canonical provider upsert can land before its mapping is durable. If that remap fails or loses a generation race, forget can retain a different stale stored ID. This is a source-derived hypothesis requiring a focused reproduction, not a proven cause of this observation. |
| D1 restore without matching index recovery | `docs/ARCHITECTURE.md:157` | Restoring D1 does not rewind Vectorize. Post-bookmark provider IDs can outlive their authoritative chunks. Inspect restore and binding history. |
| Wrong binding, direct SQL, shared index or external provider writer | `docs/ARCHITECTURE.md:167`, `:1274` | Direct queue clearing or D1 deletion can discard cleanup evidence; another writer can add IDs. Wrong resources invalidate the entire comparison. These are outside normal outbox guarantees and require resource and writer history. |

The accelerated remap case is a demonstrated current defect under the synthetic
precondition that a stored, provider-visible ID differs from the canonical ID.
It does not explain how that mismatch originated or attribute the reported 26
to this cause. The real batch confirms and empties its outbox, but exact
verification still refuses completion because provider count exceeds D1 count
(`worker/src/lib/store-d1.js:7287`). A later bootstrap poll leaves that excess
intact. This is distinct from merely preserving an already provider-only ID:
the old ID starts referenced by D1 and becomes provider-only during bootstrap.

All direct current product chunk-removal SQL found by the audit is in the
retention, atomic replacement, resumable replacement and forget paths above.
The other deletion callers delegate to them. Ordinary and accelerated provider
upserts are at `worker/src/lib/store-d1.js:2761` and `:6473`; the delete writer
is at `:2495`. The ordering probe is another provider delete, but cannot add
extra vectors: `worker/src/lib/vector-fence-probe.js:22` first proves its random
ID absent and `:31` only deletes it. Soft deletion alone retains the chunk and
is not a provider-only vector under the required physical-row definition.

## Least destructive repair plan

These are requirements for a future reviewed operation, not runnable shell
instructions. No production command, manual SQL edit, deployment, credential
read, or provider access was performed by this lane.

### 1. Read-only diagnosis first

Capture the authenticated preview/refusal, exact installed/runtime version,
schema and authoritative manifest binding. Independently match the account,
D1 database, Worker deployment and Vectorize index; names alone do not prove
ownership. Capture queue components, retry/quarantine state, bootstrap state,
projection status/count, generation, mutation fence and processed watermark.
Use owner-private evidence; public output contains counts and fingerprints.

Stop for unknown ownership, incompatible schema/runtime, incorrect binding,
unreadable state, pending or submitted work, an unfinished bootstrap walk or
batch, or ambiguous provider mutations. Existing queued deletes are
ordinary recoverable work, not permission to remove a separately guessed set.
Allow separately authorized normal work to settle, then repeat diagnosis.
A read-only preview must never pause writers, acquire a D1 write lease,
enqueue, embed, probe by mutation, or change readiness. A fully confirmed
sweep awaiting exact readiness solely because of proven excess remains
eligible for the separately approved inventory and repair path. Preserve its
confirmed batch history; incomplete readiness alone must not be confused with
unfinished bootstrap work.

### 2. Establish a separately approved maintenance boundary

Before an authoritative destructive preview, the operator must separately
approve and verify the mechanism that excludes every corpus and vector writer:
ingesters, schedulers, owner actions, cron/manual drains, bootstrap, old Worker
invocations, dashboard/API/Wrangler writes, and any other credential holder.
A local scheduler stop or a drain lease alone does not exclude them all.

The existing lifecycle pause and quiescence logic is design evidence at
`brain.mjs:5991` and `:6024`. Its old-writer grace is 20 minutes, and its modern
probe requires consecutive quiet observations. A false `proven` result is a
stop. Neither elapsed time nor an idle processed watermark establishes absence
of an unknown accepted mutation. Reconcile all known accepted work and stop
if the historical writer boundary remains unproven.

Do not use ordinary update to bypass its excess gate or silently deploy a
different Worker to obtain this boundary. The reviewed maintenance entrypoint
must itself be authorized and must preserve the existing runtime/schema and
resource contract. If no such entrypoint is approved, stop at the study.

### 3. Enumerate complete identities, with bounded work

The disposable adapter at `operations/cloudflare-recovery-adapter.mjs:6394`
and `:6441` is a reference for D1 keyset pagination, non-null/distinct count
checks, provider duplicate detection, cursor progress, truncation checks and
terminal-page proof. It returns only count/hash receipts (`:6438`, `:6499`).
Its 100,000-ID ceiling (`:324`, `:6397`, `:6444`) prevents reuse for this corpus.
Its disposable-target restriction also remains in force
(`docs/README-developer.md:314`). Do not just increase its constant or run its
campaign against an existing installation.

A reviewed scalable enumerator must walk all physical D1 chunks using indexed
keyset pages, collecting stored `vector_id` without source, zone, live-document,
or namespace sampling filters. Prove one distinct, non-null provider ID per
chunk, intact document ownership, and compatible canonical mapping. Stop on
missing, duplicated, malformed, noncanonical or conflicting mappings. Long
chunk UIDs are hashed (`worker/src/lib/store-d1.js:162`), so they cannot replace
the stored provider ID. Include retained chunks of soft-deleted documents.

The provider inventory must also cover former stored IDs of still-retained
chunks after a completed canonical remap. Such an old ID can carry metadata
pointing to a document that still exists. Do not restrict candidates to deleted
documents, missing chunk UIDs, or historical ID prefixes. Protect each current
valid D1 mapping; consider the old ID only through complete `P \ D` subtraction
and the same non-membership and ownership checks as every other candidate.
An unresolved noncanonical D1 mapping remains a stop, not permission to delete
either identity. This expands the causal coverage, not the approved delete set.

Walk every provider page to an explicit terminal receipt. Require unique IDs,
valid advancing cursors, consistent totals and complete coverage of the exact
index. Never treat a page limit, timeout, rate limit, expired cursor, short
response, duplicate, or missing page as completion. At 1,000 IDs per page the
supplied sizes require approximately 1,923 pages per side, per full pass.
Actual provider page and snapshot guarantees must be verified during the
separate field review; this offline study does not certify them.

Use owner-private disk-backed indexed storage or external sorting with fixed
memory, byte, page, request and elapsed-time budgets suitable for this size.
Do not create persistent diagnostic tables in production D1. Bind local
checkpoints to resource identities and opening fences; an expired or changed
snapshot requires a fresh complete pass. Raw IDs, cursors, metadata and content
must not enter this repository, command arguments, support records or logs.

Bracket each pass with D1 corpus generation/nonce, outbox generation, queue
emptiness, absence of unfinished bootstrap work, runtime/bindings, projection
fence and provider watermark.
`operations/cloudflare-recovery-adapter.mjs:7680` and `:7717` provide examples
of composite verification. Require two identical complete ID inventories and
unchanged fences while the continuous writer exclusion remains proven.
Failure or drift discards the destructive preview.

### 4. Dry-run result and exact approval

Compute both `E = P \ D` and `M = D \ P`. For this reported case require:

- `|D| = 1,922,642`, `|P| = 1,922,668`, `|E| = 26`, and `|M| = 0`.
- Exact D1 cardinality agrees with the readiness denominator; there are no
  mapping anomalies or unresolved queue/batch work.
- Every candidate is absent from every physical D1 chunk reference, including
  soft-deleted records, and no other authorized writer owns that provider ID.

Any other result stops this specific 26-ID plan. A new diagnosis and preview
must explain the changed scope; never truncate a larger difference to 26.
Matching sets produce an empty plan with no mutations.

Persist a private immutable plan with sorted candidate IDs and set digests,
exact resource and runtime identities, schema, corpus and queue fences,
bootstrap state, watermark, deadline, operation identity and expected effects.
The owner reviews the exact private ID list and approves its plan fingerprint.
Public output says 26 provider vectors would be deleted, zero source documents
or chunks would change, and no embedding or full reindex would run. Approval
of maintenance does not authorize this deletion; approval of this deletion
does not authorize an index replacement or update.

### 5. Revalidate and enqueue only the approved deletes

A future guarded executor must reacquire the complete writer exclusion proof,
verify the unexpired approval, compare the full inventories and fences again,
and recheck D1 non-membership immediately before the enqueue transaction.
Refuse new work, lease contention, mapping changes, added references, resource
drift, altered plan bytes, or loss of the continuous maintenance boundary.

Enqueue exactly one operation-scoped tombstone per approved provider ID using
the existing outbox contract. Each tombstone's synthetic `chunk_uid` must be
collision-free against both chunks and outbox; its `vector_id` is the exact
approved provider ID. Do not overwrite a queue row or derive a target from
metadata, prefixes, titles, source names or hashes of a missing chunk.
The transaction must check the approved fences and current non-membership,
then read back the exact tombstone set and generations. Only bookkeeping
changes are allowed. Documents, chunks, FTS, sources and content stay intact.

Migration triggers give enqueues fresh generations and mark projection pending
(`migrations/d1/0013_accelerated_vector_bootstrap.sql:64`). Record the operation's
expected state transitions durably so a retry can distinguish its own rows
from unrelated work. Never edit runtime rows manually to make checks pass.

### 6. Delete through the receipt protocol, under the pause

Ordinary `/drain`, `/forget` and `/reindex` are blocked while paused
(`worker/src/index.js:3400`); scheduled work also stops (`:4366`). The exported
drain returns without writes in that mode (`worker/src/lib/store-d1.js:2928`).
Thus "pause, enqueue, run ordinary drain" is not an executable repair.

A separately reviewed repair-only wrapper can reuse the leased drain internals
with internal `allowPausedBootstrap: true`, `skipUpserts: true`, and
`disableBootstrapAdvance: true` (`worker/src/lib/store-d1.js:2648`, `:2863`,
`:2893`, `:2932`). These are not public repair flags. It must restrict every
queue read, submission and acknowledgement to the exact approved tombstones,
reject unrelated queued/submitted work, preserve confirmed bootstrap history,
and make embedding/upsert calls fail.
It must also prevent the automatic ordering probe from issuing a delete
outside the approved set; an unexpected fence requires reconciliation and
a stop, not an undisclosed probe mutation.

Lease handling needs review: `drainOutbox` acquires its own lease at `:2941`.
Do not acquire one and then nest that call. Factor the existing
`drainOutboxWithLease` boundary (`:2822`), or release/reacquire with full plan
and queue revalidation. Renew immediately before each provider write and stop
on lost ownership. An invocation lease is shorter than the total inventory
work, so it cannot replace continuous maintenance exclusion.

Use bounded delete batches from `:2490`; 26 IDs fit the existing 100-ID delete
bound at `:1824`. Record each accepted mutation and its exact D1 generations
before any success claim. Wait for the processed mutation receipt, then verify
absence using `getByIds` in pages of at most 20 (`:2381`, `:2405`). A processed
watermark with a still-visible vector is not completion. Clear only matching
generation/operation/ID/receipt rows (`:2433`).

On timeout, lost response, failed persistence, retry deferral or lease loss,
retain the pending evidence, stop new submissions and reconcile before retry.
Resume only the same approved still-unreferenced IDs; never silently widen the
set, clear receipts, or reset quarantine. A fully completed replay is a no-op.
Do not use the full bootstrap endpoint: it can replace queued upserts and
start bulk embedding (`worker/src/lib/store-d1.js:7055`, `:7225`). A naked
provider delete is also insufficient because it does not persist the matching
Worker mutation fence.

### 7. Exact post-repair proof and return to service

While writers remain excluded, re-enumerate both complete sets and require
`P_after = D_before = D_after`; specifically `P_before \ P_after = E` and
`P_after \ P_before` is empty. Recheck every approved ID's absence, zero
outbox, no submitted or unfinished batch work, stable final watermark covering
the recorded repair mutations, unchanged bindings and all D1 corpus fingerprints.

Provider count must now be 1,922,642. The normal exact empty-queue verification
must establish `projection_status = verified`, matching expected/actual and
`ready = true` (`worker/src/lib/store-d1.js:2327`, `:2913`). Do not set that
flag or count by hand. Count equality alone cannot substitute for set proof.
Keep this a projection repair; do not claim it proves every preexisting vector
payload or retrieval ranking was correct.

Any changed ID set, missing D1 vector, incomplete readback, corpus mutation,
unexpected provider write or failed health check during the maintenance proof
leaves the repair incomplete. Preserve private receipts and stop; do not
escalate automatically to whole-index replacement.

Repeat authenticated health and the exact-runtime update preview in active
mode while the remaining ingestion controls still hold. If active deployment
restarts automatic writers, those surfaces must also remain independently
excluded until this final check completes. Only after the approved
return-to-service boundary is verified should normal writers resume. Thereafter
legitimate new ingest may change both sets; monitor that expected queue work
is visible and progressing rather than treating it as repair-proof drift.
Index recreation/rebind remains a separately reviewed fallback
described at `docs/ARCHITECTURE.md:746` when complete safe subtraction cannot be
proved, with its own preview and approval.

## Synthetic reproduction and proof recipe

This remains a recipe for the future diagnostic/executor tests, not an executed
repair. Round 1 ran only the existing focused tests recorded below. Round 2
separately executes the accelerated whole-corpus remap characterization and
control; it does not implement this diagnostic or executor. No real
installation, account or source fixture is required.

1. Use the real SQLite migration harness in
   `test/fixtures/vector-fence-env.mjs:6`. `seed(db, 256)` at `:93` provides
   synthetic documents, canonical stored vector IDs and queued upserts.
   Drain, explicitly process accepted mock mutations, then confirm until the
   queue is empty and all 256 vectors are visible. The mock separates acceptance
   from processing at `:47` and provides an unapplied-watermark path at `:57`.
2. Include a retained soft-deleted document and a long-UID/canonical-hash case,
   using the production store paths and verified counts. Freeze the final D1
   document/chunk/source/FTS snapshot and all protected provider payloads.
   The control with identical sets must produce an empty preview and zero writes.
3. Inject 26 IDs, `fixture-extra-00` through `fixture-extra-25`, into the mock
   provider's `visible` map only. This deliberately models an already-stranded
   historical/provider-only state; it does not attribute the original incident.
   Wrap all write methods in recording spies. Serve provider listing through
   several short pages with explicit final truncation/cursor fields.
4. Preview must return precisely those 26 IDs, zero missing IDs, and stable set
   fingerprints. Assert no provider or D1 writes, no embedding, no lease write,
   and byte-for-byte unchanged fixture state. The production preview classifier
   must report `projection_excess`. Separately feed the pure classifier the
   supplied 1,922,642/1,922,668 aggregate shape to reproduce the exact refusal
   without materializing a large corpus.
5. Approve the plan in the synthetic harness. Exercise the future paused,
   guarded delete-only wrapper with embedding/upsert stubs that throw. Verify
   exactly 26 tombstones and their generations. Immediately after provider
   acceptance, assert all 26 vectors still exist, the rows remain queued and
   the result is incomplete. Process the mock mutation and perform confirmation.
6. Assert the union of deletion request IDs is exactly the approved set, every
   request is its subset, all 26 extras disappear, and every protected vector's
   ID, values and metadata are byte-for-byte unchanged. Require unchanged D1
   corpus/FTS, empty outbox and batch residue, exact final set equality and
   readiness. Approved replay must make zero provider mutations.
7. Independently reproduce normal lag by removing a synthetic 26-chunk tail
   through `replaceDocumentChunks`, then forcing delete failure. It must retain
   26 durable deletes and fail orphan-preview eligibility. Restore the provider
   and prove ordinary processing removes that tail. This distinguishes queued
   cleanup from the intentionally stranded provider-only setup.
8. For the conditional ordinary-drain remap branch, seed a visible historical ID different
   from a retained chunk's canonical ID, then replace/reindex that chunk and
   drain. Record whether the historical ID remains. A canonical-ID control
   must converge without residue. Treat this as a separate causal experiment,
   not a fix or a result already obtained in this lane. The separate accelerated
   whole-corpus branch is now characterized in Round 2 below.

Required negative cases and passing controls for the future implementation:

| Negative case | Required refusal/invariant | Passing control |
| --- | --- | --- |
| 27 extras plus one missing, still net +26 | No delete plan; report both differences | 26 extras and no missing |
| Null, duplicate or noncanonical D1 mapping | No destructive plan | Distinct canonical stored IDs, including long-UID hash |
| Filtering out a soft-deleted document | Test must catch attempted deletion of its vector | All physical chunks remain protected |
| Truncated page, cursor loop/expiry, duplicate ID, changing total or exhausted budget | Incomplete evidence and zero mutations | Complete unique pages and matching final totals |
| More than 100,000 synthetic IDs | Existing adapter refuses; future enumerator must prove full bounded coverage | Supported small inventory plus complete scalable inventory |
| Added D1 reference or changed generation after approval | Stale plan refused before first mutation | Identical stable fences and candidate non-membership |
| New unrelated queue row, bootstrap work or lost lease | No unauthorized provider call | Exact repair rows under the owned lease |
| Accepted delete not applied, or watermark advances without deletion | Keep tombstones and remain incomplete | Processed receipt plus exact absence |
| Provider timeout or D1 receipt-write failure | Preserve ambiguity and reconcile same IDs before retry | Durable submission/confirmation and no-op completed replay |
| Unexpected upsert, embedding or ordering-probe delete | Throw before the unauthorized effect | Only approved provider-ID deletes |

For scale qualification, stream 1,922,642 deterministic protected IDs and 26
extras through the future external-sort/indexed-storage implementation. Prove
the same set and payload invariants, page coverage, cursor failure behavior and
bounded peak memory. This is a separately scheduled focused test, not permission
to run the full chain or a live corpus here.

## Live operator checklist

Before any repair:

- Verify approved package/runtime, schema compatibility and exact resource
  ownership/bindings, independent of resource names and public health.
- Retain the original authenticated refusal and private restore/migration/ID
  history needed to distinguish old cleanup from active work. Establish an
  approved recovery checkpoint; a D1 bookmark alone does not restore Vectorize.
- Confirm a reviewed scalable diagnostic and guarded repair executor exist and
  have passed their focused tests and separate provider field gate.
- Approve maintenance, establish continuous writer exclusion and reconcile old
  invocations and accepted mutations. Confirm no pending, submitted, retry or
  bootstrap work is being mistaken for provider-only state.
- Require complete repeated inventories, all physical chunks protected, valid
  unique mappings, exactly 26 provider-only and zero D1-only IDs, stable fences,
  and an unexpired exact private deletion plan approved by the owner.

After deletion, before resuming writers:

- Verify each approved ID is absent after its mutation is processed. Require
  exact final ID-set equality and the expected 1,922,642 provider count.
- Verify unchanged D1 documents, chunks, FTS, sources and identities; retain
  proof that only approved provider IDs were submitted for deletion and no
  embedding/upsert occurred. Keep private evidence outside product source.
- Require zero repair/outbox/batch residue, a coherent final mutation fence and
  verified projection readiness. Preserve unresolved receipts on any failure.

After the approved return to service:

- Verify the exact active Worker and bindings, authenticated health, and a fresh
  exact-runtime update preview. A successful preview still does not authorize
  update or release on its own.
- Observe that expected new ingest work progresses without renewed unexplained
  excess. Investigate recurrence instead of repeating unbounded cleanup.

## Round 1 changes and verification history

In Round 1, only `partner-reports/vector-excess-plan.md:1` was added. It contains the
comparison trace, cause tree, repair plan, synthetic recipe, operator checklist
and verification record. That round changed no product behavior or tests.

Focused tests ran offline on Node v24.18.0 on Friday, 2026-10-23, outside the
specified Saturday and Sunday test pauses. All fixtures were synthetic.

| Exact command | Result |
| --- | --- |
| `node --test --test-name-pattern='projection classifier\|authenticated projection validation\|projection validation fails closed' test/update-preview.test.mjs` | PASS, 3 selected tests, 0 failures, about 0.064 seconds. Ready and excess classification plus coherent/incoherent controls. |
| `node --test test/vector-delete-outbox.test.mjs` | PASS, 110/110 internal checks, 1 passing test file, about 6.86 seconds. Includes deletion failures and controls, tail and family removal, stale-generation races, remap failure, asynchronous visibility and preserved bootstrap deletes. |
| `node --test test/reindex.test.mjs` | PASS, 13/13 internal checks, 1 passing test file, about 0.25 seconds. Non-destructive/default dry-run, resume and scoped-upsert behavior. |
| `node --test test/vector-fence-recovery.test.mjs` | PASS, 8/8 internal checks, 1 passing test file, about 0.26 seconds. Overtaken fence recovery and refusal to acknowledge an unapplied delete. |

Red-then-green evidence: not applicable. There is no code fix in this study,
so no red test or changed-code green run is claimed. The passing suites verify
existing protections; they do not prove the proposed executor or the live repair.

Mutants: none executed because this is a read-only study with no implementation
change. No killed-mutant claim is made. For the future implementation, require
these three named mutants and their paired passing controls before approval:

- `COUNT_ONLY_TARGETS`: replace set subtraction with selection by net count.
  The 27-extra/one-missing test must kill it; 26-extra/zero-missing is the control.
- `ACK_ON_ACCEPT`: clear tombstones when the provider accepts deletion.
  The delayed-processing and unapplied-watermark tests must kill it; processed
  absence is the control.
- `ALLOW_UNSCOPED_DRAIN`: permit bootstrap, upsert or non-plan deletes during
  repair. The throwing write spies and exact request-set assertion must kill it;
  an approved delete-only run is the control.

Additional local checks: report reference existence/line bounds, trailing
whitespace scan, content constraints and exact final status line passed;
independent source review completed. The Git no-index whitespace check emitted
only an LF-to-CRLF advisory. No dependency
installation, full test chain, network, live account access, credential access,
remote operation or push was performed.

Round 1 commit history, resolved by the operator: the original session could
not create its required commit. `git add --
partner-reports/vector-excess-plan.md` failed because Git could not create
`.git/index.lock` (permission denied). The workspace explicitly exposes Git
metadata as read-only, and this session cannot elevate permissions. No Git
configuration was changed and no workaround was attempted. The operator later
created the commit as recorded below. This historical restriction does not
block Round 2, which expressly requires an uncommitted working-tree handoff.

Round 1 commit subject: `docs: plan targeted repair for vector excess`

Round 1 short body: `Trace projection refusal and deletion failure paths.
Document exact-ID repair gates, synthetic coverage and operator checks.`

## Round 1 operator note

The Codex sandbox on this Windows machine made `.git` read-only, so the original session could not commit. The operator spot-checked four cited lines (worker/src/index.js:3335, worker/src/lib/store-d1.js:7523, operations/update-preview.mjs:73 and :1870; all match), scanned the report for names and banned words (none), and made the suggested commit unchanged. Round 1 was a study-only lane: the report added no product, fixture or test changes. No content was edited by the operator.

## Round 2

### Scope and result

Started from `1b2eec4` on `partner/vector-excess-plan-2`. The missing accelerated
whole-corpus cause is now in the tree and repair plan. Its synthetic test uses
the real `acceleratedVectorBootstrap`, real SQLite migrations and the existing
in-memory provider fixture. `env.VECTORIZE`, `options.embed`, `options.embedBatch`
and `options.now` are injected; no connector, real provider or fetch is used.

One retained chunk begins with a different stored ID already visible at the
provider. The real bootstrap copies that ID into its batch outbox row, submits
the canonical ID, then changes D1's mapping. Before mock processing, acceptance
does not change the visible set and a second poll retains the submitted row.
After processing and exact canonical confirmation, the batch is confirmed and
the outbox is empty, but both provider IDs remain. The old payload is unchanged,
there are zero delete submissions, and a later poll neither deletes it nor
re-embeds the chunk. There is one provider-only ID and zero missing IDs. The
receipt stays incomplete and D1 stays pending with expected 1 versus actual 2.

The adjacent control differs only in using the canonical stored ID from the
start. It follows the same delayed-processing path, ends with identical D1 and
provider sets, expected/actual 1, an empty outbox, verified status, and complete
readiness. Both scenarios retain the same document and chunk content. This is
characterization of an existing defect, not a repair or an accepted completion
criterion. A future product fix must deliberately revise this test.

### Changed files

- `test/vector-bootstrap-stored-id.test.mjs:1`: adds the explicitly labeled
  defect characterization. The shared synthetic driver starts at `:12`, the
  old-ID case at `:101`, and the converging canonical control at `:123`.
- `partner-reports/vector-excess-plan.md:16`: corrects the handoff status;
  `:100` adds the missing cause; `:192` covers former IDs of retained chunks in
  the repair inventory; `:489` marks the commit restriction as resolved history;
  `:507` records Round 2 evidence and the prepared commit. No production file,
  fixture, migration or package configuration is changed.

### Red-then-green evidence and focused runs

All runs used synthetic fixtures on 2026-10-24 before 07:00 MST, well before
the 14:00 local cutoff. No dependency installation or full chain ran. Each row
below records a separate invocation; the test command was exactly
`node --test test/vector-bootstrap-stored-id.test.mjs`.

| Run | Result |
| --- | --- |
| Diagnostic red, before the characterization assertion was finalized | Exit 1, 1 pass / 1 fail, 457.0086 ms. The deliberately desired assertion `visible.has(oldId) === false` failed with actual `true`; the canonical control passed. |
| Characterization green | Exit 0, 2 pass / 0 fail, 272.1205 ms. Changed only that assertion and its message to document `visible.has(oldId) === true`. |
| `BOOTSTRAP_REUSE_STORED_ID` mutant | Exit 1, 1 pass / 1 fail, 276.8219 ms. Defect case failed the canonical submission assertion; canonical control passed. |
| `BOOTSTRAP_SKIP_D1_REMAP` mutant | Exit 1, 1 pass / 1 fail, 277.0322 ms. Defect case failed exact mapping readback with the ambiguous mutation-receipt error; canonical control passed. |
| Restored-source green | Exit 0, 2 pass / 0 fail, 287.9154 ms. Both temporary source mutants removed and original bytes restored. |

The red run establishes that the desired cleanup does not occur. The green run
records that defect honestly; it does not claim a product fix. The report's
historical blocked text was corrected as documentation, so it has no behavioral
red test. The original ordinary-drain causal recipe remains unexecuted.

### Named mutants and proof

Both mutants were applied separately and only inside
`submitAcceleratedBootstrapBatch`. PowerShell retained the original bytes in
memory, restored them in `finally`, and verified their SHA-256 after each run.
No scratch tree or Git write was needed.

1. `BOOTSTRAP_REUSE_STORED_ID`: at `worker/src/lib/store-d1.js:6461`, replace
   canonical derivation with a D1 lookup of that chunk's stored `vector_id`.
   The new test fails at `test/vector-bootstrap-stored-id.test.mjs:69`, because
   the submitted ID is the old ID instead of the canonical ID. Its paired
   canonical control still passes, so the failure isolates the mismatch path.
2. `BOOTSTRAP_SKIP_D1_REMAP`: at `worker/src/lib/store-d1.js:6484`, replace
   `SELECT json_extract(value,'$.v') FROM json_each(?1)` with
   `SELECT c.vector_id FROM json_each(?1)` in the mapping update. The old D1
   ID then persists and exact readback throws at `:6529`; the characterization
   fails on its first real bootstrap invocation at
   `test/vector-bootstrap-stored-id.test.mjs:64`. The canonical control passes.

These are mutation-sensitivity checks for the causal reproduction, not a claim
that either mutant implements a repair. The three future-executor mutants in
the Round 1 history remain planned only.

### Additional checks and handoff

`node --import file:///C:/offload/lanes-1023/no-network.mjs --check test/vector-bootstrap-stored-id.test.mjs`
passed. Focused test files used the permitted closed-fixture exemption. There
were no ad-hoc Node probes. Independent source and test review found no blocking
gap. `git diff --check` and PowerShell checks of both changed files passed:
no trailing whitespace, prohibited wording, em dash or user-profile path;
all explicit file:line references exist and are within file bounds; the final
line is exactly the required Round 2 READY marker. `git diff` confirms no
production source change, and `git status --short` lists only the report and
new test. Git emitted only its existing LF-to-CRLF advisory.

No live account, credentials, network, runtime artifact or production state was
accessed. No Git metadata write or push was attempted. The operator owns the
focused-test rerun and commit. The lane is ready for that handoff; it does not
authorize a live repair, release or deployment.

### Prepared commit

Subject: `test: characterize bootstrap stored-id vector excess`

Body:

```text
Reproduce old provider IDs stranded by accelerated whole-corpus bootstrap.
Add a canonical-ID control and extend the exact-ID repair cause coverage.
Clarify prior commit history and record focused tests and killed mutants.
```

### Operator note (round 2)

The Codex sandbox on this Windows machine makes `.git` read-only, so the lane could not commit. The operator (Claude Code) re-ran `node --test test/vector-bootstrap-stored-id.test.mjs` on the unchanged working tree: 2 passed, 0 failed (the defect characterization and the canonical-ID control). `git status` shows only this report and the new test; no product file changed. The new test is a characterization of a current defect and is deliberately not registered in the test chain. Names, banned-word, email, user-path and key scan: none. The operator made the prepared commit unchanged and added the Codex co-author trailer.

LANE VECTOR-EXCESS-PLAN-2: READY
