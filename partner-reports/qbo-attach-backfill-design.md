# Gmail attachment backfill design (M1, not implemented)

This note replaces round 1's proposed extraction-policy full sweep. It is design
evidence and an executable red-test contract. It does not claim implemented
backfill, accepted attachment coverage, or a production migration.

## Why the present migration scales with the whole mailbox

`connectors/gmail.mjs:107` includes `GMAIL_EXTRACTION_POLICY_VERSION` in the
membership fingerprint. Raising that value changes the saved fingerprint.
`brain.mjs:17369` then selects an authoritative full sweep, and
`brain.mjs:18567` prevents legacy accepted revisions from using the immutable
message resume path. Every listed old message is fetched and resent with a new
revision, even when it has no supported attachment. Each accepted family also
enters replacement cleanup preview. This work scales with all mail.

Deleting the extraction field from the fingerprint would still change its
serialized bytes and repeat the same migration. Preserve the historical
membership hash with its original fixed extraction value of `1`, or recognize
the exact historical canonical hash before using a new membership-only format.
Query, excluded labels, the optional corpus floor, and scanner policy retain
their current membership and security migration semantics.

## Separate capped candidate workflow

1. Complete and settle the normal history window under the existing source
   lease. Attachment migration alone never selects a full membership sweep.
   A real corpus policy change, missing history, or expired history retains its
   existing independent full-sweep behavior.
2. Call a bounded candidate pager with the normal eligible-mail query followed
   by `has:attachment {filename:xlsx filename:xls filename:csv filename:pdf}`.
   Gmail search is a candidate selector; the MIME extractor still decides the
   actual extension and excludes unsupported or misleading parts.
3. Process at most 100 candidates per run. Bound provider pages separately so
   empty pages cannot cause an unbounded walk. Never fetch ordinary mail merely
   to add attachment metadata. Keep only the current bounded page in memory.
4. Save the candidate IDs and next page token in their own checkpoint before
   raw reads. Resume pending candidates before fetching another page. Exact
   accepted-family acknowledgement or a fixed terminal exclusion retires one
   pending ID. Missing provider/MIME evidence and incomplete writes retain it.
5. Continue normal history on later runs even while attachment work remains
   incomplete. Report bounded progress and exclusions without claiming a full
   mailbox attachment census. Candidate enumeration never proves source
   absence and never authorizes source-wide deletion.

The focused module should accept parsed values and injected provider, storage,
preparation, send, and preview dependencies. It must not inspect global argv,
load credentials, or introduce another credential store. Its production caller
holds the existing source lease throughout every checkpoint or data mutation.

## Proposed private checkpoint and pager contract

The checkpoint lives under `state.gmail_attachment_backfill` in the existing
private adjacent state file. No new per-install manifest configuration is
needed. The executable tests propose this version-one shape:

```text
schema_version: 1
extraction_version: current extraction version
query: complete supported-attachment candidate query
scanner_fingerprint: current scanner policy fingerprint
pending_ids: bounded array of unfinished message IDs
next_page_token: validated provider token or null
complete: boolean
```

The pager seam is
`gmail.listAttachmentCandidates(getToken, { query, pageToken, pageSize })`,
returning `{ ids, nextPageToken }`. It must reject malformed IDs, oversized
tokens, repeated tokens, non-array responses, and overfull pages. The production
cap is fixed at 100. `gmailAttachmentBackfillLimit` in the proposed runner
dependency options lets the offline resume test use a cap of one; it is not a
CLI or manifest setting.

The finalized implementation must also specify page-token expiry and concurrent
mailbox mutation behavior. An invalid/expired token must restart only the
candidate search, preserving accepted extraction receipts, rather than
silently declaring completion. Search pagination does not establish a stable
authoritative mailbox snapshot. Normal history remains responsible for mail
that arrives or changes during the candidate walk.

An absent checkpoint starts a migration. An incompatible extraction, scanner,
or query binding restarts candidate enumeration safely. A malformed checkpoint
must stay visible and cannot grant completion. A completed compatible
checkpoint makes the ordinary empty-history path perform zero candidate reads,
sends, and replacement previews.

## Replacement cleanup requires a separate binding

The current `createIngestRemovalReview` stores pending families in shared state
and hashes all state for approval (`operations/ingest-removal-plan.mjs:13`).
Placing unfinished backfill cleanup in that same state can hold the next normal
history run, or invalidate an approval as history advances.

Implementation must isolate the candidate replacement review and bind it to
the exact candidate family, accepted revision, stored targets, source, manifest,
and runtime. It must retain explicit approval and exact readback for actual
removals. Candidate replacement preview can inspect only candidate families;
it must not request the entire stored source inventory. An unresolved candidate
cleanup cannot grant completed backfill coverage, erase its checkpoint, or
rewind a settled normal history marker. Changing the shared approval binding
without dedicated negative tests is outside this design-only fallback.

## Executable red tests and controls

`test/gmail-attachment-backfill.test.mjs` uses the real remote runner, batch
receipt validation, and replacement preview. It injects snapshot checkpoint
storage, synthetic provider responses, source leases, and the data-plane
boundary. Every nonfixture HTTP origin or unknown route is rejected locally.
It saves no key or content fixture and retains only closed counts and synthetic
identities for assertions.

The three negative requirements have independent passing controls:

| Requirement | Red assertion | Passing control |
| --- | --- | --- |
| Membership stability | Current membership hash equals the canonical legacy hash when only extraction changes. | Default query equals the query with an absent floor; current-policy empty history works. |
| Candidate-only scale | A state containing 140,000 legacy messages reads, sends, and previews exactly three report candidates, without full enumeration or stored-source inventory. | A completed checkpoint does zero content work; ordinary new mail reaches read, send, and preview once. |
| Cap and restart | With cap one and two saved pending IDs, three runs process each candidate once, consuming pending IDs before the next page while advancing history every run. | Completed-checkpoint history remains live, and the ordinary-mail control proves the send and preview counters. |

The scale fixture contains the full 140,000-entry checkpoint. To prevent a red
test from performing 140,000 synthetic writes, an erroneous full enumeration
stops after 104 rows, already enough to prove the three-candidate budget was
violated. The failure reports fetch, send, and preview counts only. It is not a
timing benchmark or live-account proof.

A completed-checkpoint dry-run control additionally proves zero state, document,
and source-receipt writes. Before implementation is accepted, extend the reds
with provider-page corruption, expiration, interruption after partial family
acceptance, missing acknowledgement, candidate MIME gaps, independent cleanup
approval, scanner-binding changes, and bounded incomplete dry-run cases.

Test execution and results belong in the round 2 lane report. These files do
not register the unfinished red suite in the normal product test chain.
