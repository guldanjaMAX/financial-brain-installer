# Clean my Brain: help

Clean my Brain removes an exact, reviewed list of Gmail or Drive items from your Brain, takes a restore point first, and remembers each removal so the item is not loaded again. Nothing is removed without `--apply`.

```
brain clean <manifest> --list <ids-file>
brain clean <manifest> --list <ids-file> --preview-all
brain clean <manifest> --list <ids-file> --apply --plan-sha256 <digest>
brain clean <manifest> --restore <ids-file> --apply
```

The default preview is a sample of up to three batches. `--preview-all` checks
every batch and saves the exact documents, missing IDs, and inventory fences in
a private `<list>.clean-plan.json` beside the list. Review that file and use
the digest printed by the preview to approve it. Use the same `--batch` value
for preview and apply. The command verifies the Worker route and D1 database
through the manifest's Cloudflare account. The route must be the Worker's
enabled workers.dev address or its registered Cloudflare Custom Domain.

Rerun the same apply with its original digest to continue an interrupted or
staged run. Keep the plan and progress file together. If the inventory
changed or the files belong to another Brain, the run stops. Keep the
existing receipts and use a new list of remaining items for a fresh review.

Only `gmail:<id>` and `drive:<id>` lines are accepted. Other options: `--max-calls N` (stop after N batches, for a first small trial), `--allow-missing` (see CLEAN_MANY_MISSING), `--skip-check` (leave out the end-of-run counter check).

**Ids that are not in the Brain.** An id already gone (removed earlier) is remembered as removed so it cannot return. An id that never existed (a typo, another account) would be blocked the same way, so the dry run shows examples, a run stops when more than 20% of the ids are missing (CLEAN_MANY_MISSING), and every remembered missing id is written to `<list>.already-gone.txt` next to the list.

**Bringing items back.** `--restore` only stops the block. A Gmail item comes back when a full read reaches it again; a Drive item comes back the next time it is edited (or after a full Drive re-read). Nothing is loaded by the restore itself.

**Undoing the whole run.** The restore point is a database bookmark. `brain rollback` puts the entire database back as it was at that moment, so mail loaded and bank-feed rows written since are lost too, and `brain update` must then rebuild the search vectors. It is for a run that went wrong, not for single items; use `--restore` for those.

Every stop prints a code, the system's own message, the next step and a link here (`https://financialbrain.ai/help/<code>`). One line per code:

## CLEAN_LIST_INVALID

The id list has a bad line or changed after review; rebuild it from the review.

Next: Rebuild the list from the review sheet; it needs a matching .meta.json next to it.

## CLEAN_USAGE

The command is missing a value or has an unknown option; use the usage lines it prints.

Next: Run it as shown in the usage lines above.

## CLEAN_STAGE_TOO_LARGE

Over 20% of the Brain in one stage; split it.

Next: Split the list into smaller stages and run them one at a time.

## CLEAN_BRAIN_SIZE_UNKNOWN

The Brain did not report its size, so the 20% check could not run; nothing was removed.

Next: Run brain update (it adds the size check) or brain health, then try again. Nothing was removed.

## CLEAN_WORKER_TOO_OLD

Update the Brain first; it cannot remember removals yet.

Next: Run brain update first, then run brain clean again. Nothing was removed.

## CLEAN_RESTORE_POINT_FAILED

Cloudflare gave no restore point (its message is shown); nothing was removed.

Next: Check the Cloudflare message below, fix it, and run the same command again.

## CLEAN_HEALTH_NOT_OK

The Brain was busy or unhealthy; wait and rerun, it resumes.

Next: Wait a few minutes and run the same command; it resumes where it stopped.

## CLEAN_D1_BUSY

Database busy (the database message is shown); rerun later, it resumes.

Next: Run the same command later; it resumes. The database's own message is shown below.

## CLEAN_PLAN_CHANGED

The complete plan is missing, changed or stale; review an exact plan for the remaining items.

Next: Run --preview-all and review the plan. If a stage already started, review the remaining items in a new list.

## CLEAN_BATCH_UNVERIFIED

A batch could not be proved; stop; the read-back shows exactly which ids are gone.

Next: Run the same command: it reads back exactly which ids are gone before doing anything else.

## CLEAN_LATE_RECEIPT

A batch committed but its receipt was lost; the read-back proved it and the run continued.

Next: Nothing to do. This is shown so the lost receipt is never a mystery.

## CLEAN_COUNT_MISMATCH

Counts disagree (new mail can cause this); rerun to re-check, nothing was lost.

Next: New mail may have arrived during the run. Run brain clean again with the same list to re-check; nothing was lost.

## CLEAN_COUNTERS_DRIFTED

Stored counts disagreed with the documents and were repaired; nothing was lost.

Next: Nothing to do. The check read the real rows and corrected the totals.

## CLEAN_NOT_ON_THIS_BRAIN

The owner key or exact Brain identity could not be verified; check the manifest and saved plan.

Next: Check the manifest, Cloudflare route and database, and use the plan and progress for this Brain.

## CLEAN_SOURCE_UNSUPPORTED

Only gmail: and drive: items can be cleaned; remove other sources from the list.

Next: Take the other sources out of the list. Nothing was removed.

## CLEAN_MANY_MISSING

Over 20% of the ids are not in the Brain (a typo or the wrong account?); check the list or add --allow-missing.

Next: Open the already-gone list it names. If the ids are wrong, fix the list. If you removed them earlier on purpose, run the same command with --allow-missing.

## CLEAN_SETUP_FAILED

The Brain's settings or address could not be loaded (its message is shown); nothing was removed.

Next: Check the manifest path and run brain doctor. The system's own message is shown below. Nothing was removed.

## CLEAN_PROGRESS_NOT_SAVED

The progress or already-gone file could not be written (its message is shown); fix the folder and rerun.

Next: Make that folder writable (on Windows, close anything holding the file), then run the same command; it checks what is already gone first.

## OWNER_REMOVED

You removed this item; brain clean --restore brings it back.

Next: To bring it back: brain clean <manifest> --restore <ids-file> --apply, then run ingest again.


## Codes the Brain itself returns

These appear inside the messages above (the system's own words) and in the Brain's logs.

### OWNER_REMOVAL_INVALID

The request to the removal memory had a missing or unknown field. An up-to-date `brain clean` never sends one; if you see it, update the Brain first (CLEAN_WORKER_TOO_OLD).

### OWNER_REMOVAL_SOURCE_UNSUPPORTED

A source other than Gmail or Drive was sent to the removal memory. Nothing was removed or remembered. Take those items out of the list (CLEAN_SOURCE_UNSUPPORTED).

### OWNER_REMOVAL_FAMILY_LIVE

An item you asked to remember as removed is stored again (new mail arrived). Run `brain clean` again so it is removed first (CLEAN_PLAN_CHANGED).

### OWNER_REMOVAL_UNAVAILABLE

The Brain could not read or write its removal memory. Nothing was changed by that request; rerun later (CLEAN_D1_BUSY).

### INGEST_REMOVAL_UNAVAILABLE and INGEST_REMOVAL_CAPACITY

The database did not finish a removal batch. The answer now says where it stopped (`stage`: `delete_batch`, `readback` or `marker`), whether the delete may already be in (`committed`: `true`, `false` or `unknown`), the database's own message, and a class (`cpu_limit`, `timeout`, `busy`, `storage_unavailable`, `network`, `other`). `brain clean` reads the batch back before it does anything else, so a lost receipt (CLEAN_LATE_RECEIPT) never means a repeated or half-done removal.

### OWNER_REMOVED label

Shown when a later Gmail or Drive read skips an item you removed. It is not an error: the item is simply not loaded again.

## How it works, in four lines

1. The list comes from the review sheet and carries a hash; `brain clean` refuses a list that changed after review.
2. A restore point is taken first and printed, with the command that undoes the whole run and a warning of what that costs.
3. Each batch of 50 is previewed fresh, removed, and remembered in the same database transaction.
4. At the end the stored counts are checked against the real rows (one statement per source) and repaired only if they disagree. The Brain size used for the 20% limit comes from the per-source counters, not from a document scan.
