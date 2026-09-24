# How Optimize cleans up a Brain

Optimize starts with a read-only cleanup audit. It looks for exact duplicate
content, possible transcript/notes/summary families, text that now fails the
same readability check used by new loads, records outside a declared source
scope, unusually heavy items, and records with a stored successor.

The report works in small pages. Each finding says how many items the page
found, the estimated vectors and text storage a selected rule could save, what
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

The plan names exact counts, estimated savings, and a fingerprint. It also
runs the product's existing forget path as a no-op dry run. The plan changes
nothing. To apply it, the owner must approve that exact fingerprint:

```bash
brain optimize-cleanup ./brain.manifest.json --plan exact-duplicates \
  --apply --approve <fingerprint> --json
```

The command rebuilds the plan first. If any target changed, the fingerprint
changes and removal is refused. Exact duplicates keep one canonical document.
Every known source location is attached to that copy so retrieval can still
show where the evidence appeared.

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

## Receipt and recovery

An applied cleanup returns document, chunk/vector, duplicate, and D1-size
measurements before and after. Vector deletion is queued through the normal D1
outbox, so reclaimed provider space may finish after the D1 removal.

The current D1 forget path has no one-command undo window. The receipt says so
plainly. Recovery means loading the original source again. Do not approve a
cleanup unless the source remains available or that limitation is acceptable.
