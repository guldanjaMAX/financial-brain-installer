# Drive incremental apply and recovery

This is an owner-reviewed integration procedure, not permission to operate an
install. Offline lane results are not release evidence. Use the exact gated CLI
and Worker together. The package version alone does not identify this change.
Placeholders below are private local paths or non-secret receipt values. Never
paste credentials into a command, transcript, report, or manifest.

## Backup first

1. Record the exact existing CLI entrypoint, complete runtime identity and SHA-256,
   deployed Worker identity, D1 binding and schema prefix. Retain the complete
   prior runtime separately before replacing any installed byte. Capture the
   manifest and adjacent `.brain-ingest-drive.json` together in an owner-only
   backup directory. If the checkpoint is absent, record absence explicitly.
   Hash each copied file and verify the copy against its original. Do not copy
   an adjacent admin key or an OAuth store into this backup. Keep each credential
   in its declared protected store. A source checkpoint may contain private names.
2. Record approved scheduler definitions and enabled intent first. Inspect with
   `brain daily status "<manifest>" --json` and
   `brain schedule "<manifest>" --status --all-configured --json`.
   With approval, `brain daily off "<manifest>"` stops the daily launcher;
   `brain schedule "<manifest>" --remove` stops the separate Drive launcher and
   preserves its logs. Verify status again. Stop manual import sessions on every
   computer and exclude other source writers for the recovery window. Do not kill
   an unknown process. A local source lease does not exclude another computer.
3. Before installation or any corpus write, use the authenticated Cloudflare D1
   dashboard for the exact recorded database to capture a current Time Travel
   bookmark. Record its database/account binding, capture time, displayed restore
   window and expiry, and successful bookmark readback in an owner-only recovery
   receipt. A URL or database name alone is not identity proof. Do not assume a
   retention duration or that a bookmark from another database is usable.
4. Verify the existing physical counter baseline before the update. The shipped
   bounded admin endpoint is `POST /api/admin/brain/documents/report` with an empty
   JSON body, using the existing protected admin transport. Compare its completed
   per-source `stored_documents` and physical chunk counts with the exact
   `corpus_stats` rows for the selected
   sources on the disposable backup. The CLI does not dispatch `brain report` in
   this pinned tree, despite older count-note copy advertising it. Do not invent
   that command or put a key in a request argument. If the old Worker lacks this
   endpoint or cannot complete inside its page budget, verify the exported
   disposable backup through a separately reviewed bounded count instead. Any drift requires a
   separately reviewed bounded reconciliation before applying the new counter
   triggers. No baseline is assumed from an empty receipt or a healthy Worker.
   Verify recovery on an isolated disposable database with the same schema prefix,
   accepted target text, checkpoint and runtime. The offline lane test restores
   a real SQLite backup and its checkpoint as one pair, checks `PRAGMA quick_check`
   and the exact old text, and retains the post-backup database separately. That
   is not a D1 Time Travel field proof. Before the production canary, the approved
   operator must prove provider bookmark restore on a disposable D1 target of an
   appropriate size and record the compatible runtime and restore time. If no
   valid recovery point or sufficient restore window is available, stop here.

## Apply and dry run

5. MAIN completes the full host, privacy, migration, package and CI gates and
   supplies an immutable package/runtime receipt for the paired CLI and Worker.
   Install that reviewed artifact only after the backups above. Preserve the
   existing manifest and checkpoint bytes. Do not reset, delete, reseed or edit
   their cursor. This procedure does not approve the old mirror removal plan.
6. Run the supported non-writing update diagnostic using the runtime-payload
   digest from that package receipt, then review it:

   ```sh
   brain update "<manifest>" --preview --expect-runtime-sha256 <runtime-payload-sha256> --json
   ```

   After separate update approval, run `brain update "<manifest>"`. Its existing
   implementation captures and verifies its own private pre-migration bookmark,
   establishes the paused-writer boundary, and applies pending migrations before
   returning active. Migration 0065 creates empty retained-revision journals and
   the open-run receipt index, and transactional physical-row counter triggers.
   It preserves the prior supported counter baseline and does no new
   document/chunk backfill or corpus
   rewrite. Verify the exact deployed modules, schema-65 ledger/readback and
   runtime receipt, not just version text or process exit. Do not run the new
   producer against an older Worker. Keep all schedules off.
7. Inspect the local cursor with
   `brain ingest "<manifest>" --from drive --status`.
   An unreadable or malformed checkpoint must stop before credentials, receipts
   or provider calls. Preserve it and restore a verified backup, or obtain a
   separately reviewed bounded recovery plan. A 410 similarly preserves its
   token; it does not authorize seeding a replacement.
8. Preview one file without a Brain write or checkpoint write:

   ```sh
   brain ingest "<manifest>" --from drive --dry-run --json --limit 1
   ```

   This is the existing bounded provider preview, not a simulation of all future
   change pages. It cannot establish historical coverage. Review the exact
   configured roots, exclusions, refusal and extraction outcomes privately.
9. After approval, run the bounded canary:

   ```sh
   brain ingest "<manifest>" --from drive --limit 1
   brain ingest "<manifest>" --from drive --status
   ```

   With a valid saved token, it consumes that exact feed. With genuinely absent
   state, it only seeds a token and reports historical coverage incomplete;
   nothing before that token is claimed recovered. The owner must provide one
   reviewed added/modified file under a configured root to prove an actual write.
   A removal/trashed/out-of-root event creates an owner decision and retains the
   indexed document. Never use `--full-walk-review`, `--apply-removals`, or
   `--approve-removals` in this procedure.
10. Verify that exact file through owner document reading: expected new text,
    unchanged stable source identity, the complete active revision, and an honest
    confidence/gap response. Check a shortened revision cannot expose an old
    trailing figure. Confirm the previous revision is in the retained journal,
    local checkpoint offset/token matches accepted work, receipts use measured
    outcomes, no unexpected removal ran, and old unrelated documents remain.
    Pending outbox work is not semantic completion. Require exact D1/Vectorize
    readiness and owner retrieval proof separately. Source receipt totals are
    intentionally unmeasured; use the bounded report for counts.
    Include a deterministic skipped file followed by a supported addition in the
    approved canary. Local status must list the skipped identity, version, reason,
    code and retry class; the page must advance and the later addition must be
    readable. The source must remain incomplete with a failed receipt while that
    skip is unresolved. A skipped update leaves the previous accepted text active;
    never treat a caught-up feed as proof that the skipped replacement was read.
    Include a permanent ancestor denial and a depth-limited source before a good
    file: neither may download unproved-scope bytes or hold the later file.
    Account/auth/unknown transport errors must instead retain the exact page.
    Verify an ordinary same-identity single-part update and its quiet check both
    complete without a removal hold. The paired Worker's owner-only
    `POST /api/admin/brain/drive-family` readback must prove the exact live base
    and absence of any part candidate. A real obsolete part or failed readback
    stays visible and incomplete; no removal is authorized by that check.
11. Stop on a lost lease, schema/runtime mismatch, failed readback, malformed
    checkpoint, 410, unexpected text change, wrong figure at High confidence or
    missing recovery proof. Keep schedules off and preserve every receipt.
    Once the canary passes, rerun the same default incremental command to consume
    later bounded pages. Only after the owner accepts the results should the
    previously approved schedules be restored with their recorded settings and
    verified against the paired safe runtime.

## Resume and way back

A transport-wide failure normally needs only the same incremental command.
The exact page and offset remain local. An item-specific activation failure
keeps a durable retry identity while independent feed work may advance; accepted text stays active
until all replacement chunks, ownership and final marker commit in one D1
transaction. Before activation, a durable journal contains the old document,
old chunks, new envelope and new chunks. No automatic journal cleanup or chunk
or document deletion runs. Shortened revisions retain the old tail outside the
active reading. A lost successful response is recovered by an unchanged replay.

Deterministic source omissions (too large, unreadable or unsupported) and the
paired writer's explicit retained-revision admission limits settle differently:
the per-file skip and reason are checkpointed before the page offset advances.
They do not hold later changes. A saved skip retains its source version, and a
writer rejection also retains each failed part's identity, safe code and retry
class. Status lists these under `Skipped items`; coverage remains incomplete.
Ordinary runs continue from the advanced token; retryable gaps receive bounded
fair automatic retries, while permanent skips await a changed version or reset. A later changed source version is tried normally. After repairing a
source, `--reset` retries at most ten held identities without reseeding. A durable
rotation cursor advances before each retry, including a retry interrupted by a
transport failure. Later runs reach every held identity instead of restarting
at a permanent prefix. No held entry is erased to make room. A permanent failure
is recorded again. Held-item retry failures are checkpointed locally and do not
abort independent feed work. Authentication/account failures, lost source-lock
ownership and checkpoint failures still stop the run. A shared-access or unknown transport failure on the current
feed page keeps its own offset unsettled; a durable item-local retry permits
independent feed progress. With a file limit above one, retry
admission reserves at least one file slot for the feed. Before any held request,
a durable pending feed turn is saved. If retry work consumes the time budget or
is interrupted, the next run admits feed work before more retries. At a limit of
one, this also alternates retry and feed turns. The total file/time budget still
includes all retries and feed events. Ordinary runs
also rotate through old family holds, clearing a false hold only after exact
bounded readback of its accepted single-part identity. A real obsolete family,
inconsistent local family plan or failed read remains held.
Recognized file-specific ancestor unavailability and the 100-ancestor depth bound
are visible unresolved scope skips with a source version. They settle the event
without downloading content. Accepted text stays active. Authentication, account
policy and unknown transport failures remain retryable page failures. Malformed
ancestor data and cycles are visible retryable per-file gaps; they never count as safe scope skips.
The 512-chunk snapshot limit is not a request to delete or shrink accepted
database rows. Its `owner_recovery` class needs a separately reviewed bounded
recovery plan. Unknown per-part failure codes, contradictory retry flags, mixed transient
part failures and item SQL faults stay visible as retryable gaps. Unconfirmed
batch transport and incomplete batch receipts retain the page for retry.

If the checkpoint alone needs recovery, keep writers excluded, preserve and hash
the failed artifact, and restore only the verified checkpoint copy with its
recorded database boundary. Do not turn a damaged file into an empty state.
Replaying an earlier valid token against the safe runtime is idempotent; an
expired earlier token requires a reviewed plan. Do not enable the older runtime's
mirror writer as a fallback.

For data recovery, retain a separate current database/recovery point and current
checkpoint before changing either, so post-backup writes are not discarded.
`brain rollback "<manifest>" "<bookmark>"` is the supported local preview. It
performs no restore without a separate confirmation; review its exact database,
bookmark and loss warning against the retained recovery receipt. This procedure
does not prescribe or authorize a destructive production restore. A current,
explicit owner recovery plan must name every later write, the matched checkpoint,
compatible runtime and provider restore boundary. First demonstrate that plan on
a disposable target and verify the complete restored bytes.

Rollback requires two observed quiet writer readings before any restore. An
unreadable, missing, malformed or continuously busy writer state leaves the
Worker paused and performs no restore, even after the safety wait elapses.
A successful rollback leaves the Worker paused and invalidates its semantic proof. D1 restoration does not restore Vectorize. Supervised
recovery must recreate/rebind a clean Vectorize index with every required
metadata index, forward-migrate with the reviewed safe runtime, rebuild and prove
exact readiness, and repeat owner retrieval before activation or scheduling.
Ordinary reindex cannot remove provider-only vectors created after a bookmark.
Restoring only the prior CLI or only the progressed checkpoint is not rollback.
The old runtime may be retained for identity/read-only inspection; do not permit
it to write over schema-65 retained revisions.

## Independent progress after per-document retries

The entry boundary is shared by current feed work and saved retries. A typed
per-document retry, including an OCR page still pending while the Brain is
reachable, is saved with its reason, code, retry class and version before the
feed offset advances. The accepted previous text stays available and source
coverage remains incomplete. When current metadata could not be read, the saved
record identifies its prior accepted version or explicitly marks the version
unavailable. Local status includes retryable skips as well as owner-review gaps.

Ordinary runs fairly rotate over retryable document failures and family holds.
Permanent owner-review skips still require a changed source or explicit reset.
The pending feed turn applies to a failed current entry as well as a held retry:
if that entry spends the time budget, the next ordinary run reaches the saved
page suffix before retrying it. File and time budgets still include all attempts.
An unsettled entry already on that suffix is not also retried ahead of the page.

Authentication/account failures, unknown current-page transport failures, OCR
system failures, lost source ownership, uncertain checkpoints and unconfirmed
batch transport/receipts stop the run. Family readback no longer hides auth or
ownership errors. A one-time ownership loss during OCR remains fatal through PDF
extraction. A failed offset or terminal-token save restores the in-memory replay
boundary before error/finally saves, so a later diagnostic save cannot commit the
uncertain cursor accidentally. Known family query failures remain visible local
retries, and an obsolete family still requires the existing owner decision.

Before any approved canary, extend step 10 with a pending scanned document ahead
of healthy text, an ordinary restart after budget exhaustion, a recovered OCR
control, and ownership/checkpoint stops. Verify actual later acceptance, retained
prior text, retry reason/class/version, offset/token readback and incomplete
receipts. All backup, paired-runtime, dry-run, semantic-readiness and rollback
requirements above continue to apply. No lane result supplies a host or field gate.
