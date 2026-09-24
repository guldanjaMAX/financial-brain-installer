# How Optimize cleans up a Brain

Optimize starts with a read-only cleanup audit. It looks for exact duplicate
content, possible transcript/notes/summary families, text that now fails the
same readability check used by new loads, records outside a declared source
scope, unusually heavy items, and records with a stored successor.

The report works in small pages. Each finding says how many items the page
found, the estimated projected vectors and text characters a selected rule could save, what
would be lost, and the rule in plain language. Titles stay hidden unless the
owner asks to see samples. A possible match is not permission to remove it.

## Nothing is removed during Optimize

The read-only audit is:

```bash
brain optimize-cleanup ./brain.manifest.json --json
```

If the response has `next_cursor`, the technician can read the next bounded
page by passing that opaque value with `--cursor`. The audit stops if a load,
update, or vector drain is active.

After the report, the owner may choose one rule. Exact duplicates can be
planned automatically:

```bash
brain optimize-cleanup ./brain.manifest.json --plan exact-duplicates --json
```

The plan names exact counts, estimated savings, a continuation cursor when
more groups may remain, and a fingerprint. It also
runs the product's existing forget path as a no-op dry run. The plan changes
nothing. Duplicate equivalence includes source, entity, client, category,
top folder, platform, and date. Chunk metadata must prove the same boundaries,
and a document grant or an unprovable boundary refuses collapse.

The private plan may show bounded source-location references so the owner can
review what a future guarded removal would have to preserve. Those references
are not written to document metadata and never enter search results, citations,
or the answer model prompt.

Confirmed removal is currently unavailable. Even this fully approved form
rebuilds the plan and then fails closed without changing a document:

```bash
brain optimize-cleanup ./brain.manifest.json --plan exact-duplicates \
  --apply --approve <fingerprint> --json
```

The command rebuilds the plan first. If any target changed, the fingerprint
changes. If it did not change, the Worker still returns
`cleanup_apply_unavailable` until citation preservation, exact boundary and
content-hash readback, affected-row checks, and deletion are one atomic guarded
mutation. This is a review surface, not a deletion ceremony.

Near duplicates are candidates only. Size is also never enough to authorize a
removal. A technician may build a selected-document plan only after the owner
reviews the candidates and chooses the exact records.

## Keep an approved exclusion from coming back

When the owner approves a path rule, preview the matching future Drive setting:

```bash
brain optimize-cleanup ./brain.manifest.json \
  --source-exclusion "Reviewed/Archive" --json
```

That preview has its own fingerprint because changing future loads is a
separate decision. Add `--apply --approve <fingerprint>` only after the owner
approves it. The command changes only `corpora.google_drive.exclude_paths` in
the local manifest and verifies the exact write.

## Measurement and recovery

The report labels the D1 chunk-derived value as `expected_vectors`, leaves
`actual_vectors` unproved, and reports text length as characters. A plan labels
the projected queue work as `expected_vector_deletes`. It never describes a
bounded batch as whole-Brain completion; `more_cleanup_possible` and the plan
cursor name any remaining scan work.

No cleanup removal or recovery receipt is produced by this version. The
separate existing D1 forget path still has no one-command undo window.
