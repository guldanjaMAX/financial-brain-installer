# Populated schema-48 upgrade and money acceptance

This is MAIN's supervised operating sequence after the exact artifact passes
the host gate, CI and independent review. It is not approval to touch an owner
install. Keep manifests, receipts, account identities and acceptance questions
in the private instance workspace. Record times and the exact runtime fingerprint.

## Premises checked at candidate 1478883a

- The checkout still declares **0.4.11**, with **0.4.12 unreleased** notes.
  Verify the final approved artifact's actual version; this filename is a target,
  not proof that a 0.4.12 package exists.
- The supervised 0.4.9 lineage at
  `0d9126246b8f791e4a9d57c2c80e873882455a06` ends at **0048**. Its 48 migration
  files and financial importer are byte-identical at
  `eac2d9396658c35d8c28607f2caf2edba10e4745`. No local 0.4.9 tag exists;
  [the maintainer record](../MAINTAINER.md#cut-an-immutable-release) says those
  candidates were not public tagged releases. Read the installed ledger rather
  than inferring it from the version label.
- This candidate adds **0049–0055**. The regression
  [ledger-upgrade-from-048.test.mjs](../../test/ledger-upgrade-from-048.test.mjs)
  uses the historical writer and real `cmdMigrate`, ledger CLI handlers and
  Worker routes over populated SQLite. It does not rehearse a deployment,
  provider latency, vector indexing or local scheduler ownership.
- `refreshContentDates` exists as an internal bounded helper. There is **no
  operator command or Worker route wired to it in this revision**. Step 10 is
  blocked here; a separately reviewed command must land before repair is run.

In the commands below, `<manifest>` is the verified private instance manifest.
Resolve every `brain` command to the exact approved installed executable before
running it. `<old-prefix>` and `<new-prefix>` identify stable, retained installs,
outside disposable build workspaces. Never let PATH choose the rollback binary.

## Ordered procedure

| Step | Action and GO evidence | NO-GO and failure action |
| --- | --- | --- |
| 1. Read installed state | Record the CLI version, `/health` Worker version and schema, authenticated `brain health <manifest>` readiness, and the complete installed `schema_migrations` version/name/checksum ledger through MAIN's approved read-only inspection path. Verify exact account, Worker, D1 and Vectorize identity. GO only when the installed prefix and all checksums match the reviewed baseline, expected here to be schema 48. | Missing identity, checksum drift, unknown schema or version disagreement: stop before writes. Preserve the evidence and revise the migration plan. Never use a label alone to authorize migration. |
| 2. Stop producers | Save the existing schedule inventory with `brain daily status <manifest> --json` and `brain schedule <manifest> --status --all-configured --json`. With owner approval, use `brain daily off <manifest>` for the owned daily definition and reviewed native procedures for remaining owned local jobs. Inventory legacy jobs, QuickBooks jobs, running imports and any remote push/cron producers separately. Read back disabled state and wait for in-flight writers to finish. | An unowned, unidentified or still-running writer is a stop. Do not kill or remove unrelated jobs. Escalate any remote producer that cannot be quiesced under the approved plan. Scheduler absence alone does not prove that an existing process stopped. [M5] |
| 3. Prove an empty queue for five minutes | While the Worker is active and producers are stopped, record authenticated readiness at least once a minute over a full five-minute interval, including both endpoints. Every sample must report exact pending **0**, no accepted-but-unconfirmed work, and query readiness. Reset the five-minute interval if any work appears. | A read failure, capped/unknown count, nonzero queue or stalled upserts stops the upgrade. Keep producers stopped. Use the supported active-Worker drain/diagnostic procedure and inspect confirmation progress. A healthy HTTP response or decreasing deletes does not prove upserts are searchable. Do not ingest more to fix an indexing stall. [M1, M4] |
| 4. Stage recovery | Retain and verify the old installed executable, dependencies, private manifest and recovery material. Stage the exact **`brain deploy <manifest>` resolved from `<old-prefix>`**, with the target identity checked, as the pre-migration paused-Worker escape. Have the reviewed backup/bookmark available and verify the update's durable bookmark receipt before migration begins. Preparing the command does not mean running it now. | Missing old runtime, mismatched target, missing backup/readback or an unverified bookmark is a stop. This deploy reactivates compatible Worker code; it does not undo D1 migrations or restore a semantic index. Never apply it automatically once migration may have started. [M1, M3] |
| 5. Update | Run `brain update <manifest>` from `<new-prefix>` under the approved ceremony. Keep producers stopped and preserve stage receipts, migration intents and the verified recovery bookmark. GO only on verified completion. | Classify the last proven phase using the recovery table below. Do not repeat a destructive operation, edit `install_state`, clear a pause binding, delete intent files or edit the manifest to make the version look current. |
| 6. Read back readiness | Read `/health`, authenticated `brain health <manifest>`, the migration ledger and installed state again. Require the approved Worker version, correct schema (55 here), exact migration checksums, active drain mode, accepting documents, no version mismatch, zero pending work and query readiness. Verify the persisted product version and local manifest agree only after successful update verification. Run a small known retrieval query as well. | Any mismatch, 503, missing readiness field or pending work holds acceptance and schedules. A migration receipt alone must leave the old product version until deployment verification succeeds. Use phase-specific recovery below. |
| 7. Rekey each manual account | `brain ledger rekey <manifest> --account <account> --preview`. Review the populated page, `blocked`, candidate count and exact `plan_hash`; obtain approval for that page. Apply with `brain ledger rekey <manifest> --account <account> --apply --approve <hash>`. Read back counts, cents, signs, dates, category authority and identifiers after each page. Repeat a fresh preview until `complete: true` and no legacy identities remain. Pages are bounded to 2,000 rows and may be smaller to keep identity groups intact. | A blocked group, stale approval, transport ambiguity, count/cents change or failed readback stops that account. Keep imports off; preserve the receipt and obtain a fresh preview before deciding what to retry. Do not reuse a prior page's approval for a new page, remove ambiguous rows, or claim completion from one successful page. |
| 8. Link reviewed twins | `brain ledger link-accounts <manifest> --manual <manual-account> --live <live-account> --preview`. Owner evidence must establish that both identities are the same account; a matching mask is insufficient. Approve the exact plan, then apply with `brain ledger link-accounts <manifest> --manual <manual-account> --live <live-account> --apply --approve <hash>`. Require complete readback, the active approved link and unchanged physical rows/cents. | Unclear identity, blocked/stale plan or failed readback stops linking. Leave both records intact. Unlinked twins and unknown coverage must continue refusing totals. A mistaken saved link needs the separately reviewed `--unlink --preview`, followed by its exact approval. |
| 9. Small money acceptance set | Use the real owner Think surface. Check a balance with its as-of date; payment arrival with exact cents, date and mask; one month's credits/debits; a month outside coverage; an unknown period; and a transfer question. Add the private reviewed category and loan check. Compare exact cents with the owner's primary records. Linked overlap counts once; transfers remain in primary income/spend and are only flagged as possible. | Any incorrect figure, unsupported answer, missing refusal, changed category/loan, or silently removed transfer stops acceptance. Keep refresh jobs off, save private evidence and fix the product or fixture premise before retrying. No broad corpus cleanup is an acceptance repair. |
| 10. Optional content-date repair | **Blocked on 1478883a.** First verify the final artifact actually exposes a reviewed operator command with preview, approval, bounded pages, resumable cursor and readback. Declare a numeric queue budget and stop threshold before applying; a missing budget is a stop. Preview one page, approve it, then process only that bounded page while below budget. Read back dates, revisions and resulting outbox work before advancing. The current internal helper caps at 10 documents, which does not cap their chunk/vector count. | If the command is absent, defer this step and record it explicitly; never call the helper directly against production or invent a command. Stop on queue growth beyond budget, stalled confirmations, stale revision, incomplete readback or loss of readiness. Keep the cursor at the last verified page. Resume only under a fresh reviewed plan. This optional repair must not hold a verified upgrade hostage. [M4] |
| 11. Drive scope change, preview first | Separately approve the exact desired `corpora.google_drive.root_folder_ids` change in the private manifest while schedulers remain off. Retain its previous configuration and ingest state. Run `brain ingest <manifest> --from drive --dry-run` first. Review additions, exclusions, removals, expected indexing volume and the queue budget. Execute only the separately approved scope; any removal gate requires its exact current fingerprint. Read back source scope, receipt completeness and query readiness. | A partial inventory, unexpected removal, changed fingerprint, permission refusal, unknown queue budget or stalled indexing stops the scope change. Preserve resumable state and unresolved removals. Never add `--reset` or blanket approval to force success. This means folder-selection scope, not OAuth consent: `brain connect google --scopes ...` has no dry-run ceremony and requires separate authorization if needed. |
| 12. Daily schedules on, with readback | After required acceptance passes and optional deferrals are recorded, run `brain daily on <manifest>` from the stable approved runtime, then `brain daily status <manifest> --json` and `brain schedule <manifest> --status --all-configured --json`. Verify executable and module paths, manifest identity, selected sources, cadence/timezone, ownership, definition hash and source freshness expectations. Confirm the first approved run's journal and terminal receipt. | A path into a scratch prefix, duplicate legacy job, missing runtime, failed registration/readback or failed first run keeps schedules off. Repair and re-read the exact owned definition. Do not reclaim old runtime folders while any job still references them. An installed task is not proof of a successful import. [M5] |

## Recovery by proven failure phase

| Evidence | Supported next step |
| --- | --- |
| Refused before the paused deploy; installed state unchanged | Correct the preflight problem while active. Re-prove the full empty-queue interval and restart the approved update. |
| Paused old Worker with queued work; **proved no migration began**, unchanged schema/checksums, compatible retained 0.4.9 runtime, and no projection-rebuild requirement | Use the staged old-prefix `brain deploy <manifest>` under the recovery approval. Read back active mode, accepting documents and actual queue confirmation progress. Restart only after queue zero for five minutes. Waiting on a paused Worker cannot drain it. If phase or compatibility is uncertain, hold for supervised recovery. [M1] |
| `MIGRATION_STILL_APPLYING`, ambiguous D1 reply, or migration may have started | Keep the paused state and durable intents. Use exact schema/column readback and the supported restart-safe update continuation. This candidate gives each statement 300 seconds and bounded 30-second polling for up to 15 minutes. Do not resend ALTER manually or deploy the old Worker. 0044's historical timeout illustrates the hazard but is not pending in a verified schema-48 upgrade. [M3] |
| Both deployments succeeded, active new Worker verified, final convergence alone saw the old paused isolate's 503 | Read state and `brain support --explain UPGRADE_FAILED` first. For this exact historical shape, the supported recovery was one bare `brain update <manifest>` from the same approved new runtime after read-only diagnosis. Do not force a preview generation match by editing state. If the next attempt fails, stop and escalate with receipts. [M2] |
| D1 advanced, active state uncertain, projection bootstrap required, excess vectors, or rollback already changed durable state | Do not use the pre-migration deploy escape or assume drain can restore correctness. Hold writers and use the reviewed bookmark/recovery procedure for that exact state. Prove the restored schema, data and semantic index before serving or scheduling work. |

## Incident sources

These are the named local operator memories supplied with the packet, not public
URLs. Resolve them in the operator's private memory directory. Their historical
observations inform the gates above; current verified state governs recovery.
No instance identifiers or private record contents are reproduced here.

- **M1:** `update-stage2-trap-and-rollback.md`, 2026-09-22: paused queue deadlock
  and the pre-migration same-prefix deploy escape.
- **M2:** `update-convergence-503-race.md`, 2026-09-19: last-stage stale paused
  isolate and verified same-runtime update retry.
- **M3:** `migration-0044-timeout-big-brains.md`, 2026-09-30: D1 can complete an
  ALTER after the caller times out; inspect exact schema before continuation.
- **M4:** `vector-upsert-queue-stall.md`, 2026-09-20: provider acceptance and
  progressing deletes do not prove query-visible upserts.
- **M5:** `owner-jobs-pinned-to-scratch-prefixes.md`, 2026-10-09: scheduled imports
  fail when a disposable runtime is cleaned; verify stable paths and run receipts.
