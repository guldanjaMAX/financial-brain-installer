# Backup and rollback inventory

This inventory describes the protections that existed before the owner-backup
work began. It separates a guard against damage from a way to recover after the
damage has already happened.

## Current recovery substrate

- D1 is the durable text and metadata record. Vectorize is a derived projection.
  The architecture already says that reindex can rebuild current vectors from
  D1, but cannot enumerate provider-only vectors left after a database rollback
  (`docs/ARCHITECTURE.md:474-477`).
- An update captures a required D1 bookmark before any migration and refuses to
  proceed without it (`brain.mjs:5598-5608`).
- `brain rollback` previews a destructive D1-only restore, pauses writers,
  restores the exact bookmark, invalidates vector projection receipts, and
  leaves the Worker paused for supervised clean-index recovery
  (`brain.mjs:5825-5846`, `brain.mjs:5862-5901`, `brain.mjs:5990-6002`).
- Cloudflare D1 Time Travel is always on for production-backend databases,
  creates bookmarks automatically, costs no extra for history or restores, and
  can restore to any minute in the retention window. The current limit is 30
  days on Workers Paid and 7 days on Workers Free. A restore overwrites the
  database in place and returns the previous bookmark for undo. See
  [Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
  and the [Time Travel API response](https://developers.cloudflare.com/api/resources/d1/subresources/database/subresources/time_travel/).
- Each Worker upload has Cloudflare version and deployment history. Cloudflare
  currently exposes the 100 most recent versions and deployments and permits a
  rollback to a compatible prior version. Worker rollback does not roll back D1
  or other bound storage. See [Workers versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)
  and [Workers rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).
- The machine-continuity audit checks the exact manifest, remembered location,
  durable owner credential, installed CLI, and assistant registrations. A
  missing credential is reported as a recovery task, not regenerated silently
  (`operations/machine-continuity.mjs:188-220`,
  `operations/machine-continuity.mjs:258-290`).
- `brain secrets` has a separate, reviewed admin-key rotation transaction. The
  manifest-selected protected store is desired state, and an explicit
  replacement is persisted before remote secret rotation (`brain.mjs:2635-2710`).

## Failure inventory

| Failure | Protection before this work | Recovery before this work | Missing before this work |
| --- | --- | --- | --- |
| Junk, a wrong folder, or bad generated content is added | Ingest keeps resumable state. Source cleanup builds a deterministic removal plan and binds surprising deletions to an exact fingerprint (`operations/drive-removal-plan.mjs:46-119`, `operations/drive-removal-plan.mjs:122-137`). | Reingest can reconcile known source truth. D1 Time Travel can return the whole database to an earlier minute. | No product-level restore point before ingest, no one-command last-change undo, and no complete D1 plus Vectorize recovery transaction. Source reconciliation may not identify plausible but unwanted content. |
| Content is removed by mistake through a removal plan, `forget`, or a moved/deleted folder | `forget` prints the damage first and requires `--yes`; it verifies live removal before freeing the source name (`brain.mjs:10776-10844`, `brain.mjs:10846-10870`). Large source removals require the exact plan fingerprint and do not advance the cursor when refused (`brain.mjs:15911-15931`). | D1 Time Travel can recover database rows. The existing rollback path keeps semantic retrieval paused rather than claiming Vectorize was restored. | No automatic restore point before an approved removal, no scoped undo entry point, and no automatic clean Vectorize replacement and proof. |
| An update or deploy breaks the Brain | Update captures a pre-migration D1 bookmark and uses a paused-writer migration protocol. Cloudflare retains Worker versions. `brain doctor --repair` resumes the same idempotent update path; `--rollback` discovers the recorded bookmark (`brain.mjs:18187-18248`). | Worker code can be rolled back independently when bindings remain compatible. D1 can be restored to the captured bookmark. | Worker rollback and D1 rollback are separate. The existing D1 rollback stops before clean Vectorize replacement, so recovery requires a supervised sequence and has no combined before/after receipt. |
| A wrong manifest setting is saved | Commands pin and revalidate the manifest around sensitive update and rollback stages. | A manually retained manifest copy can be restored. Git may help only when the instance manifest was deliberately versioned outside the product. | There is no automatic owner-held manifest history, no scheduled retention, and no safe product hook for a manual source-path edit. |
| The owner's computer is lost | The machine-continuity command identifies what is missing and refuses to infer resources from names. The admin key is stored in the manifest-declared Keychain item or protected local file. | A surviving exact manifest plus the owner-custodied admin key can drive continuity checks. D1 and Vectorize remain in the owner's Cloudflare account. | The installer creates no off-machine manifest/state backup. A Keychain-only admin key and the only manifest can be lost together. The recovery card did not explicitly require a password-manager copy. |
| The admin key is compromised or intentionally rotated | Rotation is explicit, validates the replacement, updates the selected durable store, rotates the Worker secret, and refreshes existing assistant registrations. | A valid replacement can be applied with `brain secrets`; older credentials are retired from managed registrations. | A lost key still needs an owner-held recovery copy. No backup may contain the key in plaintext, and restoring a manifest must not roll the secret back. |

## Correct recovery ladder

Use the least destructive rung that addresses the failure:

1. Stop the writer and correct the source or setting.
2. Preview source reconciliation or the exact removal plan.
3. Undo the most recent protected owner operation when its restore point is
   still inside D1 retention.
4. Restore D1 to an owner-approved timestamp, bind a new empty Vectorize index,
   rebuild it from D1, and accept only exact document, chunk, vector, and empty
   outbox proof.
5. Use Cloudflare Worker rollback only for compatible Worker-code regressions.
   It does not restore D1 or Vectorize.
6. On a replacement computer, recover the exact manifest and the recovery-card
   credential first, then run the machine-continuity audit. Never provision a
   similarly named replacement as a shortcut.

Time Travel is a short-horizon safety net, not an archive. Owner backups must
therefore preserve the local manifest and resumable state independently. Longer
D1 retention would require a separate D1 export design; it is not part of the
small point-in-time recovery lane described here.
