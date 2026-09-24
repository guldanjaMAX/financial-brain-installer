# PR draft: owner backups and point-in-time restore

## Summary

- add local owner-held backups for the manifest and resumable ingest state,
  optional AES-256-GCM encryption, daily macOS scheduling, and bounded retention
- take automatic restore points before confirmed ingest, load, removal, update,
  upgrade, legacy rollback, and owner restore operations
- add fingerprinted `brain restore --to <time>` and `brain undo-last` previews
  that restore D1, bind a clean Vectorize index, rebuild from D1, and accept only
  exact projection proof
- reset later local ingest state after D1 restore, only after its automatic
  snapshot exists, so the next source run cannot trust a future cursor
- add the owner recovery page, recovery card, failure inventory, and disposable
  live-rehearsal runbook

## Safety properties

- backups make no Brain or Cloudflare request and never copy the admin key
- plaintext admin-key-shaped manifest state and non-ingest sidecars are refused
- previews do not mutate; execution requires the exact fresh plan fingerprint
- active ingest or update state refuses restore before the first mutation
- a non-404 Vectorize inspection error cannot become index creation
- the old Vectorize index is retained, and final success requires chunks equal
  vectors with an empty outbox
- restore receipts contain aggregate proof and no source content

## Verification

- owner backup and restore: 19/19 passed
- CLI errors: 100/100 passed
- drive scheduler: 79/79 passed
- upgrade verification: 246/246 passed
- CLI guidance, support journal, and schedule-platform checks passed
- package privacy: 594 reviewed package files and 911 candidate paths passed
- local history field-preparation scan passed at exact `HEAD`; seven existing
  stale dispositions remain unchanged for the public-history gate
- rehearsal Bash passed `bash -n`
- `node --check` on changed JavaScript and `git diff --check` passed

The packet prohibits the full local test chain. Package privacy must use the
reviewed seeded private npm cache, which was used for the result above. The
live restore rehearsal is written but not run; it requires separate approval
and disposable Cloudflare resources.

## Premise correction

This checkout has no mutating `Optimize cleanup` command and no CLI command for
changing a source path. Optimize is a read-only assistant workflow, while a
source path is changed by editing the manifest. This PR therefore does not add
fictional command hooks. The owner guide requires `brain backup` before a
manual path edit, and every existing confirmed CLI mutation named above has an
automatic restore point.
