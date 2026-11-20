# Bounded Gmail rollout and recovery

This procedure is an owner-approved field gate, separate from offline review.
Use the exact integrated build and the existing protected credential wrapper.
Do not paste credentials or private inventory into commands or receipts.
`MANIFEST` below means the operator's existing private manifest path.

New-message acceptance runs before the historical accepted-part audit. A
settled history window can advance while that audit is deferred, but source
status and complete-sweep evidence remain incomplete. The audit retains its
database identity, restore-point binding and checkpoint; missing historical
parts become durable logical-message retries. Freshly read-back messages are
excluded from that run's historical audit. No removal authority changes.

1. Stop the scheduled job first through the supported scheduler control,
   record/read back its disabled or absent state, and confirm the existing run
   has exited. Stop other unattended source writers too. A stopped schedule
   alone does not mean its last process is idle. Never terminate an unknown
   process or remove a lock to force progress. Record the exact installed package version, package SHA-256,
   Worker deployment and schema version. Retain the complete prior installed
   package in an owner-only recovery directory. Keep the original install in
   place until its replacement has passed the host gate.
2. Backup verified: before any update or ingestion, capture a D1 Time Travel
   bookmark for the exact database through the approved control-plane adapter
   or dashboard. The repository uses the read-only
   `/accounts/<account>/d1/database/<database>/time_travel/bookmark` operation.
   Bind the returned bookmark privately to the exact database/account,
   capture time, manifest hash and installed version. Read the saved receipt
   back and verify exact bytes, owner-only permissions and the provider's
   current retention deadline. Do not assume a large-database export will complete or
   that an implicit installer backup is sufficient. Stop if restore eligibility
   cannot be verified. No database copy or restore was performed by this lane.
3. While writers remain stopped, copy the manifest, adjacent Gmail ingest
   state, durable retries, pending removal decisions and scanner progress into
   that protected directory. Record SHA-256 and byte counts; verify every copy
   against its source. Record the existing credential locator only. Do not
   duplicate Keychain records or an admin-key file. Retain the existing approved
   credential store in place. The manifest and state are private instance data.
4. Rollback rehearsal: on a disposable recovery target, prove the prior package
   starts, saved state parses, and the database restore/readback procedure works
   at the required size. This lane tests the shipped `cmdRollback` path with
   injected offline dependencies: preview makes zero writes; confirmed restore
   acquires the shared idle lifecycle lease, pauses, verifies health, requires
   the rollback writer fence and two complete quiet readings with provider
   completion proof, restores the exact bookmark,
   invalidates projection receipts and leaves the Worker paused. A busy local
   sync prevents dispatch. Missing, unreadable or busy remote writer evidence
   stops before restore and leaves the Worker paused. The fence also blocks
   bootstrap, which an ordinary upgrade pause permits. A real-account
   restore rehearsal and protected-copy custody checks remain host field gates.
   Stop rollout if either prerequisite fails.
5. Complete the integrated host gates. Use the supported owner-reviewed update
   path; its separate pre-migration bookmark receipt must also read back before
   deployment. Verify the exact deployed Worker and the schema-59 projection's
   `complete=1` receipt, indexes and triggers. An unfinished projection returns
   a visible readiness error. Let its existing bounded backfill resume, then
   verify again. Never mark it complete by hand.
6. First dry run: run the installed
   `brain ingest "$MANIFEST" --from gmail --dry-run` through the approved
   wrapper. Read the aggregate `mode`, window, pending and deleted counts.
   Preview must not change source state, documents, receipts or cursor. Check
   that the selected mode is history or bounded bootstrap, with no full mirror
   or inventory compatibility fallback. Do not add `--limit` to a real sync.
7. Run `brain daily run "$MANIFEST"` through the existing approved daily path.
   It consumes at most 32 Gmail windows and checks its runtime deadline between
   windows. Each window reads at most one provider page, accepts at most 1,000
   history identities plus 100 durable retries, and queries stored truth only
   in indexed groups of 97 identities. Provider calls and retries share the
   remaining daily deadline, including policy reads, unchanged mail and skips.
   History JSON is capped at 256 KiB before parsing. Larger responses enter
   the same paginated recovery instead of repeatedly expanding the large page.
   Indexed preparation saves a fair offset, spends one third of the remaining
   budget on reads, and retains no stored/absent evidence across runs. Only its
   freshly checked slice enters message processing. Policy-read prefixes and
   resolved skips checkpoint without advancing an unfinished window. Resolved
   outcomes retain their measured counts and pending owner decisions across a
   restart; state flushes in groups of 50 identities. Failed retries rotate
   behind unvisited identities, and
   retry work keeps continuation visible. Missing label/date evidence and
   item-specific read or preparation failures retain their prior copy, exact
   retry identity and visible reason while healthy siblings and later history
   continue. Account/auth/transport failures still stop the source. A budget
   expiry saves a deferred receipt; the next scheduled daily run resumes it. An interrupted run retains accepted
   prefixes. Repeat the same supported run to resume; never reset or edit state.
8. Verify exact aggregate readback: no automatic removal calls, preserved prior
   documents, expected accepted counts, last batch time, durable retry counts,
   continuation progress and error reasons. `more_history` means incomplete
   coverage. Pending owner removals also keep coverage incomplete. Preview
   their exact targets separately with ordinary Gmail ingestion; only a later,
   separately authorized fingerprint apply may delete them. Do not approve any
   removal as part of this rollout. Confirm exhausted history and successful
   source receipts before claiming current coverage. Pending vector work must
   drain and exact retrieval must also be checked.
9. Check the owner's exact retrieval path against independently known facts.
   Every answer must answer and follow the five-part contract. Keep computed
   scores internal and hide confidence labels and percentages from owners.
   Thin or missing evidence gets one plain sentence without a number or scale
   word; preserve the gap and missing data in the five answer parts. Any refusal or wrong supported figure at High confidence stops
   sign-off. Observe the next scheduled execution separately.

## Rollback

Stop the scheduled job first and read back its disabled or absent state.
Confirm its current run and all manual syncs are idle before changing files.
Preserve the failed candidate, current manifest, latest state, receipts and
package bytes before changing anything. The rollback command must acquire the
same exclusive lifecycle lease as daily/manual sync, and holds it through the
restore. An active sync blocks it before any account or deployment call. Keep those bytes separate
from the pre-run backup.

Post-backup writes: restoring an old D1 bookmark loses every subsequent write,
including writes from other sources. Inventory and preserve that accepted delta
with the reviewed recovery export mechanism, and prove restoration to a
separate target before approving a database restore. A saved Gmail cursor alone
cannot preserve document bodies or other source writes. If preservation cannot
be proved, keep the database and checkpoints and use a forward fix. Never
restore merely to make the next daily run green.

For a code-only rollback, restore the exact retained compatible local package
under the supported installer recovery procedure. Keep candidate Gmail state
protected, pause scheduling, and confirm the old build understands its schema
and all continuation fields before running it. An older reader must not ignore
pending recovery state. If compatibility is unproved, remain paused and use a
forward fix. This lane adds no schema migration.

For an explicitly approved database rollback, first preview with
`brain rollback "$MANIFEST" <reviewed-bookmark>`. Inspect the pinned database,
bookmark, lost-write warning and D1-only limitation. Only after the owner
approves those exact effects may the operator repeat it with `--yes`. The
shipped restore deploys and verifies the rollback writer fence, closing every
application Vectorize writer, including upgrade bootstrap. It requires two
complete readbacks proving a null lease, an empty outbox, no ambiguous receipt
failures or unconfirmed bootstrap batches, and a verified projection. Both
readbacks must also match the global mutation to the provider's processed
watermark (or prove a never-written empty index). A missing permission, malformed
response, differing opaque watermark or failed receipt is unknown. An elapsed
wait is never proof. Unknown or busy
writer state performs zero restore calls and leaves the Worker paused; resolve
the writer state through supported recovery before retrying. An unconfirmed
ordering-probe submission retains a durable unknown marker even after another
drain attempt. Keep writers paused and use supervised clean-index forward
recovery; do not reset the marker or treat an old watermark as completion. A confirmed
restore also leaves the Worker paused. D1 and Vectorize are not restored
transactionally: supervised recovery must recreate/rebind a clean Vectorize
index and the verified update path must rebuild it and prove exact readiness.
Never reactivate the old index or clear the pause by hand.

Restore the matching protected manifest and Gmail state only while all writers
remain paused and after the matching database state has been restored and read
back. If the database was retained, keep its latest accepted checkpoints instead
of replacing them with older state. Reconcile and replay every preserved
post-backup write, verify counts and exact retrieval, then restore the supported
scheduler definition and observe a fresh run. Retain both recovery snapshots
until the owner accepts the result.
