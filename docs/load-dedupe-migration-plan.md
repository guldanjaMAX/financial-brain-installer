# Same-source load dedupe migration plan

Status: design only. The load preview reports exact normalized-text duplicates,
but this branch does not merge stored documents.

## Why this needs a schema migration

The current corpus has one `documents` row for each `(source, source_id)`. Its
`doc_uid` owns chunks, Vectorize ids, source-original provenance, access state,
and citation identity. Deleting that document cascades to its chunks and queues
their vectors for deletion. Repointing a second path to the first document in
only the ingest handler would therefore make either citation identity or later
removal incorrect.

The concurrent large-corpus index work already allocates migration 0047. This
change must take the next available migration number after that branch lands.
It must not rewrite 0047 or assume that its branch order will remain unchanged.

## Proposed storage contract

Add a `document_references` table with one live row per source location:

```text
source              source boundary, never normalized across providers
source_id           provider or source-relative location identity
doc_uid             canonical documents row that owns text and chunks
content_hash        normalized extracted-text hash observed at this location
title, uri           citation fields for this location
first_seen_at        first confirmed observation
last_seen_at         most recent complete walk observation
deleted_at           null while this location still exists
```

Required constraints and indexes:

- Primary key or unique constraint on `(source, source_id)`.
- Foreign key from `doc_uid` to `documents(doc_uid)` with deletion restricted
  until no live reference remains.
- Index on `(source, content_hash, deleted_at)` for same-source reuse.
- Index on `(doc_uid, deleted_at)` for citation hydration and last-reference
  removal.
- Backfill exactly one live reference for every live document. Verify exact
  counts and orphan absence before enabling dedupe writes.

The canonical document remains the D1 text and metadata authority. Chunks and
Vectorize remain one derived set per canonical document. Every source location
remains independently addressable through its reference row.

## Ingest transaction

1. Extract, run the text-quality checks, run the credential scanner, and split
   only after every existing safety gate has passed.
2. Compute the normalized extracted-text hash. The normalizer must be shared
   with preview and versioned so preview and ingest cannot disagree.
3. Look up a live canonical document by exact `(source, content_hash)`. Never
   use a content match from another source as authority for a merge.
4. If no same-source match exists, write the document, chunks, provenance, and
   reference using the current guarded transaction and outbox rules.
5. If a same-source match exists, insert or update only this location's
   reference. Do not rewrite chunks and do not queue Vectorize work. Return an
   explicit `duplicate_reference` receipt that names no private location.
6. If another source has the same hash, keep both documents and increment an
   aggregate cross-source duplicate measurement. Do not merge silently.

An existing location whose content changes must atomically detach from the old
canonical document and attach to an existing or new same-source canonical for
the new hash. Cleanup of the old canonical is allowed only after the transaction
proves that no live reference remains.

## Removal and citation behavior

A source deletion first soft-deletes that location's reference. If another live
reference points to the canonical document, the document, chunks, FTS rows,
provenance, and vector projection stay intact. Only deleting the final live
reference may invoke the current document and vector cleanup path.

Search hydration must resolve citation fields from live references, not assume
that the canonical document's original `source_id`, title, or URI is the only
location. The response contract should include the reference count and a
deterministic bounded alias list, with a paginated owner-authorized read for all
locations. Direct source and location lookup must resolve through the reference
table so any recorded location can still be cited.

Source-original bindings, family receipts, access grants, memory
supersessions, recovery export, forget preview, source inventory, and corpus
stats all need explicit migration tests. None may be inferred safe from the
foreign key alone.

## Maintained quality counters

The migration should also add per-run aggregate counters for:

- same-source duplicate references created or retained;
- cross-source exact matches observed but not merged;
- refusal reason codes, including too large and text-quality classes;
- accepted canonical documents and accepted references.

The after-load report can then use indexed run receipts for exact reason totals
without scanning document bodies or exposing source locations. Existing runs
must remain `unknown`, not zero, for counters they never recorded.

## Required probes before implementation

- Two paths in one source with identical normalized text produce one document,
  one chunk set, one vector set, and two live references.
- The same hash in two sources produces two documents and an aggregate
  cross-source observation.
- Deleting one of two references keeps the document and vectors.
- Deleting the final reference queues exact vector deletion and removes the
  canonical document through the existing guarded path.
- A changed path detaches and reattaches atomically without losing the other
  reference.
- Concurrent duplicate arrivals choose one canonical document.
- Retry after an ambiguous response is idempotent and creates no extra
  reference, chunk, or outbox row.
- Migration backfill creates one reference per live document and no reference
  for a deleted document.
- Citation hydration returns every stored location through bounded pages and
  contains no deleted location.
- SQLite query plans use the new same-source hash and reference indexes.

Implementation should begin only after the large-corpus index branch is merged
and its final schema number is known.
