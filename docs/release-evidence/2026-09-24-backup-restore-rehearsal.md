# Disposable owner-restore rehearsal

Run this only in an owner-approved disposable Brain. It intentionally writes
synthetic documents, removes one by an approved plan, performs an in-place D1
Time Travel restore, deploys a paused Worker, and creates a replacement
Vectorize index. Do not substitute a production manifest.

The restore point must be taken before the junk and removal. A point taken after
the junk cannot prove a return to pre-junk state.

## Preconditions

- The exact candidate package is installed on the disposable computer.
- The manifest names disposable D1, Vectorize, and Worker resources.
- No ingest, update, restore, webhook, or other writer is running.
- The owner has approved this destructive rehearsal.
- The Brain is healthy before the first command.

Use Bash for the commands below. Replace only the absolute manifest path.

```bash
set -euo pipefail
umask 077

export BRAIN_REHEARSAL_MANIFEST="/absolute/path/to/disposable/brain.manifest.json"
BRAIN_REHEARSAL_ROOT="$(mktemp -d)"
BRAIN_REHEARSAL_SOURCE="$BRAIN_REHEARSAL_ROOT/source"
mkdir -p "$BRAIN_REHEARSAL_SOURCE"

printf '%s\n' 'Synthetic baseline note one for the disposable restore rehearsal.' \
  > "$BRAIN_REHEARSAL_SOURCE/baseline-one.txt"
printf '%s\n' 'Synthetic baseline note two for the disposable restore rehearsal.' \
  > "$BRAIN_REHEARSAL_SOURCE/baseline-two.txt"

brain ingest "$BRAIN_REHEARSAL_MANIFEST" \
  --path "$BRAIN_REHEARSAL_SOURCE" \
  --source rollback-rehearsal

for BRAIN_HEALTH_ATTEMPT in $(seq 1 40); do
  if brain health "$BRAIN_REHEARSAL_MANIFEST"; then break; fi
  if [ "$BRAIN_HEALTH_ATTEMPT" -eq 40 ]; then exit 1; fi
  sleep 15
done

brain sources "$BRAIN_REHEARSAL_MANIFEST" --json \
  > "$BRAIN_REHEARSAL_ROOT/pre-damage-sources.json"
brain backup "$BRAIN_REHEARSAL_MANIFEST" --json \
  > "$BRAIN_REHEARSAL_ROOT/pre-damage-backup.json"

BRAIN_RESTORE_TIME="$(node -e '
  const fs = require("node:fs");
  const receipt = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!receipt.restore_point?.timestamp) process.exit(1);
  process.stdout.write(receipt.restore_point.timestamp);
' "$BRAIN_REHEARSAL_ROOT/pre-damage-backup.json")"

brain restore "$BRAIN_REHEARSAL_MANIFEST" --to "$BRAIN_RESTORE_TIME" \
  > "$BRAIN_REHEARSAL_ROOT/pre-damage-restore-preview.txt" 2>&1

printf '%s\n' 'Synthetic junk that must not survive the approved restore.' \
  > "$BRAIN_REHEARSAL_SOURCE/junk.txt"
brain ingest "$BRAIN_REHEARSAL_MANIFEST" \
  --path "$BRAIN_REHEARSAL_SOURCE" \
  --source rollback-rehearsal

brain forget "$BRAIN_REHEARSAL_MANIFEST" \
  --source rollback-rehearsal \
  > "$BRAIN_REHEARSAL_ROOT/removal-preview.txt" 2>&1
grep -F 'Nothing has been removed.' "$BRAIN_REHEARSAL_ROOT/removal-preview.txt"
grep -F -- '--source rollback-rehearsal --yes' "$BRAIN_REHEARSAL_ROOT/removal-preview.txt"

brain forget "$BRAIN_REHEARSAL_MANIFEST" \
  --source rollback-rehearsal \
  --yes \
  > "$BRAIN_REHEARSAL_ROOT/removed.txt" 2>&1

brain restore "$BRAIN_REHEARSAL_MANIFEST" --to "$BRAIN_RESTORE_TIME" \
  > "$BRAIN_REHEARSAL_ROOT/restore-preview.txt" 2>&1

BRAIN_RESTORE_FINGERPRINT="$(sed -nE \
  's/.*approval fingerprint: ([0-9a-f]{64}).*/\1/p' \
  "$BRAIN_REHEARSAL_ROOT/restore-preview.txt" | tail -1)"
test "${#BRAIN_RESTORE_FINGERPRINT}" -eq 64

brain restore "$BRAIN_REHEARSAL_MANIFEST" \
  --to "$BRAIN_RESTORE_TIME" \
  --approve "$BRAIN_RESTORE_FINGERPRINT" \
  > "$BRAIN_REHEARSAL_ROOT/restored.txt" 2>&1

brain health "$BRAIN_REHEARSAL_MANIFEST"
brain sources "$BRAIN_REHEARSAL_MANIFEST" --json \
  > "$BRAIN_REHEARSAL_ROOT/restored-sources.json"

node - \
  "$BRAIN_REHEARSAL_ROOT/pre-damage-restore-preview.txt" \
  "$BRAIN_REHEARSAL_ROOT/restored.txt" \
  "$BRAIN_REHEARSAL_ROOT/pre-damage-sources.json" \
  "$BRAIN_REHEARSAL_ROOT/restored-sources.json" \
  "$BRAIN_REHEARSAL_ROOT/pre-damage-backup.json" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [beforeOutput, afterOutput, beforeSourcesPath, afterSourcesPath, backupPath] = process.argv.slice(2);
const counts = (file) => {
  const text = fs.readFileSync(file, "utf8");
  const matches = [...text.matchAll(/([\d,]+) document\(s\), ([\d,]+) chunk\(s\), ([\d,]+) vector\(s\)/g)];
  if (!matches.length) throw new Error(`aggregate receipt missing from ${path.basename(file)}`);
  return matches.at(-1).slice(1).map((value) => Number(value.replaceAll(",", "")));
};
const before = counts(beforeOutput);
const after = counts(afterOutput);
if (JSON.stringify(before) !== JSON.stringify(after)) {
  throw new Error(`aggregate mismatch: before=${before.join("/")} after=${after.join("/")}`);
}
const sourceStorage = (file) => {
  const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  const row = receipt.sources.find((source) => source.name === "rollback-rehearsal");
  if (!row) throw new Error("rehearsal source missing from source receipt");
  return row.storage;
};
if (JSON.stringify(sourceStorage(beforeSourcesPath)) !== JSON.stringify(sourceStorage(afterSourcesPath))) {
  throw new Error("the restored source storage receipt does not match the pre-damage receipt");
}
const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
const backupRoot = path.dirname(backup.path);
const receipts = fs.readdirSync(backupRoot)
  .filter((name) => /^restore-.*\.json$/.test(name))
  .map((name) => ({ name, time: fs.statSync(path.join(backupRoot, name)).mtimeMs }))
  .sort((a, b) => b.time - a.time);
if (!receipts.length) throw new Error("restore receipt missing");
const restoreReceipt = JSON.parse(fs.readFileSync(path.join(backupRoot, receipts[0].name), "utf8"));
if (restoreReceipt.local_resume_states_reset < 1) {
  throw new Error("the restore did not reset later local ingest state");
}
console.log(JSON.stringify({
  status: "verified",
  documents: after[0],
  chunks: after[1],
  vectors: after[2],
  local_resume_states_reset: restoreReceipt.local_resume_states_reset,
}));
NODE
```

Keep the rehearsal directory and restore receipt for review. Do not delete the
old Vectorize index during this rehearsal. Its removal needs a separate exact
target preview and approval.

## Expected output

- The first `brain forget` run exits zero, prints the exact document and source
  removal plan plus a `--yes` command, and says `Nothing has been removed.`
- The approved `brain forget --yes` reports the observed document count removed
  and proves that no documents remain under the rehearsal source.
- The restore preview says `restore preview only: nothing was changed`, prints
  the current document, chunk, and vector counts, and prints one approval
  fingerprint.
- The approved restore reports D1 restored, a verified clean Vectorize
  projection, and exact final document, chunk, and vector counts.
- `brain health` reports an active Worker, authenticated inventory, zero
  pending vector work, and a query-ready vector index.
- The final verifier prints one JSON object with `status: "verified"`, equal
  pre-damage and post-restore aggregate counts, and at least one reset local
  resume-state file.

Any missing fingerprint, count mismatch, non-empty vector queue, missing
receipt, or zero local-state reset is a failed rehearsal. Keep the Worker and
evidence as-is for review. Do not retry the restore blindly.

## Cost

- D1 Time Travel history and restore have no additional charge according to
  [Cloudflare's current D1 documentation](https://developers.cloudflare.com/d1/reference/time-travel/).
- The current embedding model is priced at about $0.067 per million input
  tokens, with 10,000 Workers AI neurons per day included before paid usage.
  See [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).
- Vectorize on Workers Paid includes the first 10 million stored dimensions and
  50 million queried dimensions per month. Extra stored dimensions are $0.05
  per 100 million, and extra queried dimensions are $0.01 per million. See
  [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/).
- This three-file synthetic rehearsal should remain inside the included usage
  unless the account has already exhausted it. The exact cost depends on the
  account's usage that day and month. The old index is retained, so its stored
  dimensions continue to count until separately reviewed cleanup.
