# Private money replay

This is an offline development tool. It executes the real `withLedgerAnswer`,
reader, classifier and composers against SQLite with the shipped migrations.
It makes no provider, model, Brain or credential-store requests. Private replay
does not grade correctness. An independent private key and owner review decide
whether changed figures are correct. Document fallback is recorded as
`documents_unexecuted`; it is never treated as a document answer.

The reviewed `ledger-reader.js` reads exactly seven financial tables:

| Table | Purpose |
| --- | --- |
| `fin_entities` | Confirmed ownership |
| `fin_accounts` | Account identity and classification |
| `fin_account_kind_reviews` | Owner classification facts, identity binding and revocation history |
| `fin_account_coverage` | Covered intervals and evidence |
| `fin_account_links` | Explicit manual/live account precedence |
| `fin_transactions` | Posted transactions, including retained superseded rows |
| `fin_balance_snapshots` | Dated observations |

Three additional tables affect those exact SQL decisions. Omitting them changes
freshness and empty-history coverage. Export only these columns:

| Table | Columns |
| --- | --- |
| `bank_feed_items` | `tenant_id,item_ref,last_synced_at,status,removed_at` |
| `bank_feed_backfill` | `tenant_id,item_ref,state,provider_history_state,unread_lines,requested_days,queued_at,finished_at` |
| `plaid_sync_windows` | `tenant_id,item_ref` |

The seven financial tables contain private owner records and must stay local.
The three status projections exclude encrypted credentials, nonces, cursors,
provider payloads and errors. Offline TEMP tables shadow these status tables
after real migrations run, so no fake credential values are needed. No document,
chunk, vector, source inventory or other financial table is exported.

## MAIN-only read-only capture procedure

These instructions describe later owner-reviewed work. Nothing in this lane
authorizes or executes live access. Use an existing approved credential-backed
wrapper selected locally by MAIN. Set `CF_WRAPPER` to that executable's locator,
`CF_CONFIG` to the existing reviewed private Wrangler configuration, `MONEY_DB`
to its exact D1 binding, and `CLOUDFLARE_ACCOUNT_ID` to the reviewed account.
Do not place a credential value in a command, configuration or environment
assignment. Do not discover a database by a similar name.

MAIN must first bind the current source runtime and schema to an existing
reviewed receipt. This adapter supports the checked-out migration bytes only;
candidate schema changes require a separate adapter review. Independently
establish a stable window with no financial import, sync or maintenance writer.
The following captures are separate requests, not one transactional snapshot.
Equal before/after counts cannot detect updates with unchanged row counts.
Without that stable-window evidence, stop. Never pause or update a Brain as an
implicit part of this procedure.

Choose a new private local root outside every Git worktree, outside a synced
folder, and outside any published artifact location. Set `PRIVATE_ROOT` to that
locator, `REPLAY_TREE` to the reviewed checkout, and `MONEY_TENANT` to the exact
tenant from the existing receipt. Do not guess the tenant. The example below
uses `primary` only as a synthetic illustration of the shape.

Before **each** Node command, use the host quiet-file wait required by the lane.
That wait is also applied immediately before each replay child. Run the offline
plan generator first, using a scratch HOME and `BRAIN_NO_WRANGLER_LOGIN=1`:

```sh
umask 077
MONEY_TENANT=primary
node "$REPLAY_TREE/eval/fast-loop/private-ledger-replay.mjs" \
  --export-plan "$PRIVATE_ROOT/plan" --tenant "$MONEY_TENANT"
mkdir -m 700 "$PRIVATE_ROOT/export"
```

The plan contains eleven mode-600 SQL files. `counts.sql` performs ten bounded
counts, each over at most 10,001 rows in the exact tenant of one named table.
These are approximate row counts: 10,001 means **over budget**, not a complete
count. Stop if any count exceeds 10,000 or their sum exceeds 50,000. Even below
those limits, MAIN must approve the visited-row/request budget before capture.
There is no retry, paging or broader census in this procedure.

Run the one count request and inspect its local JSON before any row export:

```sh
"$CF_WRAPPER" d1 execute "$MONEY_DB" --config "$CF_CONFIG" --remote \
  --command "$(cat "$PRIVATE_ROOT/plan/counts.sql")" --json \
  > "$PRIVATE_ROOT/export/counts-before.json"
```

Use `--command`, **not `--file`**. In the installed Wrangler 4.131.1 source,
remote `--file` enters D1's import/ingestion flow; `--command` enters the query
API. The plan contains SELECT statements only. No Wrangler command was run to
verify this procedure; the flags, result shape and dispatch were read from the
pinned installed source. Actual live read parity remains a MAIN field check.

After checking the counts and budget, run exactly the ten reviewed row queries,
serially, with at least ten seconds between completed requests:

```sh
for table in fin_entities fin_accounts fin_account_kind_reviews fin_account_coverage fin_account_links \
  fin_transactions fin_balance_snapshots bank_feed_items bank_feed_backfill \
  plaid_sync_windows
do
  "$CF_WRAPPER" d1 execute "$MONEY_DB" --config "$CF_CONFIG" --remote \
    --command "$(cat "$PRIVATE_ROOT/plan/$table.sql")" --json \
    > "$PRIVATE_ROOT/export/$table.json" || break
  sleep 10
done
```

Stop on any error, timeout, unexpected result, nonzero write count, missing
receipt, rate limit or changed state. Do not retry. Inspect each result privately;
every file must contain exactly one successful D1 result with `meta.changes=0`
and `meta.rows_written=0`. There must be exactly ten table files, even for empty
tables. A failed loop is incomplete and must never proceed as a valid export.
Then repeat the identical bounded count query once into `counts-after.json`.
Keep the independent stable-window evidence beside this private capture.

Create `export/export.json`, mode 600, with these fields and the owner's actual
configured IANA time zone. Freeze `now_utc` deliberately; do not derive it from
the replay machine's wall clock. This invented example exercises a UTC/local
month boundary:

```json
{
  "schema": 1,
  "tenant_id": "primary",
  "now_utc": "2026-11-01T01:00:00Z",
  "owner_time_zone": "America/Phoenix",
  "consistency": "owner-reviewed-stable-money-window"
}
```

`consistency` records an operator attestation, not an automatically proved
snapshot. Keep source identity and custody receipts private beside the export.
The loader requires exact counts, safe integer values and complete status
projections. Missing tables, over-budget captures and credential columns fail
closed. Files use Wrangler's JSON format, not SQL dumps:

```json
[{"success":true,"results":[],"meta":{"changes":0,"rows_written":0}}]
```

## Replay and comparison

Questions are a mode-600 JSON array with unique IDs and no expected answers:

```json
[
  {"id":"expense","question":"What are my expenses?"},
  {"id":"balance","question":"What are my account balances?"},
  {"id":"rows","question":"Show my last ten transactions."}
]
```

After each required quiet-file wait:

```sh
node "$REPLAY_TREE/eval/fast-loop/private-ledger-replay.mjs" \
  "$PRIVATE_ROOT/export" "$PRIVATE_ROOT/questions.json" "$PRIVATE_ROOT/run"
node "$REPLAY_TREE/eval/fast-loop/private-ledger-replay.mjs" \
  "$PRIVATE_ROOT/export" "$PRIVATE_ROOT/questions.json" "$PRIVATE_ROOT/candidate-run" \
  --candidate "$CANDIDATE_TREE"
node "$REPLAY_TREE/eval/fast-loop/private-ledger-replay.mjs" \
  "$PRIVATE_ROOT/export" "$PRIVATE_ROOT/questions.json" "$PRIVATE_ROOT/comparison" \
  --baseline "$BASELINE_TREE" --candidate "$CANDIDATE_TREE"
```

The default arm uses the tool's checkout. Comparison executes both worktrees
with the identical input bytes and reviewed migrations. Changed SQL templates
are fatal until explicitly reviewed, even if product code catches the failure.
Only reviewed local candidates belong in this harness; the VM and Node guards
are defense in depth, not a security boundary for hostile JavaScript.

Each run creates a new mode-700 directory and mode-600 JSON files. Existing
outputs are preserved and refused. Lexical paths, canonical paths and ancestor
Git markers are checked, including symlinks and both comparison worktrees.
Stdout contains counts and output paths only; errors contain fixed codes.
Private child results travel through a dedicated pipe, never stdout. The
in-memory SQLite database is closed without persisting another copy.

`answers.json` includes answers, actual classifier decisions, exact SQL and typed
binds, batch groups, returned rows, structured and displayed figures, semantic
exclusion summaries, frozen clock, denied-effect witnesses and source/input/
migration/harness hashes. Comparison adds `baseline.json`, `candidate.json` and
`comparison.json`, with per-question figure paths, before/after cents and deltas.
Prose and route changes remain visible. No correctness or promotion verdict is
inferred from a difference. Exit 0 means all executions completed, exit 1 means
harness-invalid questions were recorded, and exit 2 means invalid input, refused
output, source mismatch or a child/IO failure. An unchanged comparison is not
evidence of improvement.
