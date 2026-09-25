# Custom business API install-night checklist

Use this owner-present checklist to connect the read-only store dashboard during
an install call. Budget 15 minutes after the Brain itself is deployed. This path
has local mock proof only. The real API and deployed Brain remain separate field
gates until this checklist succeeds.

The feed returns a full snapshot on every call. Query parameters do not narrow
it. The Brain fetches and validates all three exact endpoints before staging a
durable job, then advances one bounded, exactly read-back slice per request.
Rows that disappear remain as history with `present: false`; current totals and
snapshots use only rows in the new response. The same resumable job advances on
the owner's Worker cron, so the laptop does not need to stay on.

## 0:00 to 0:04: add and deploy the manifest block

Copy this block into `corpora` in the instance manifest. Replace only the
placeholder HTTPS base URL and, if needed, the dedicated Worker secret name.
The bearer value never belongs in this file.

```json
"custom_api": {
  "enabled": true,
  "display_name": "store dashboard",
  "source": "store-dashboard",
  "base_url": "https://dashboard.example.invalid/api/",
  "token_secret": "STORE_DASHBOARD_TOKEN",
  "cadence_seconds": 86400,
  "timeout_ms": 30000,
  "max_response_bytes": 5242880,
  "max_rows": 10000,
  "max_pages": 20,
  "retries": 3,
  "endpoints": [
    {
      "name": "sales",
      "path": "/sales",
      "row_key": ["store", "period", "revenue_stream"],
      "legacy_row_key": ["store", "period"],
      "documents": [
        {
          "name": "monthly",
          "group_by": ["period"],
          "title_template": "{{period}} sales across all stores",
          "body_template": "{{period}}: net sales {{sum.net_sales}} across {{row_count}} store and stream rows. {{missing.revenue_stream}}\n\n{{rows_table}}",
          "aggregates": { "net_sales": "sum", "transactions": "sum", "units": "sum", "puppies_sold": "sum" },
          "formats": { "net_sales": "currency" },
          "fields": ["store", "revenue_stream", "net_sales", "transactions", "units", "puppies_sold"],
          "expected_values": { "revenue_stream": ["live_animal", "supplies", "services", "other"] }
        },
        {
          "name": "store-history",
          "group_by": ["store"],
          "title_template": "{{store}} sales by month",
          "body_template": "{{store}} monthly sales history through {{fetched_date}}.\n\n{{rows_table}}",
          "aggregates": { "net_sales": "sum", "transactions": "sum", "units": "sum", "puppies_sold": "sum" },
          "formats": { "net_sales": "currency" },
          "fields": ["period", "net_sales", "transactions", "units", "puppies_sold"]
        }
      ]
    },
    {
      "name": "inventory",
      "path": "/inventory",
      "row_key": ["store", "breed"],
      "document": {
        "group_by": ["store"],
        "title_template": "{{store}} inventory snapshot {{fetched_date}}",
        "body_template": "{{store}} inventory snapshot for {{fetched_date}}.\n\n{{rows_table}}",
        "fields": ["store", "breed", "count"]
      }
    },
    {
      "name": "costs",
      "path": "/costs",
      "row_key": ["store", "breed"],
      "document": {
        "group_by": ["store"],
        "title_template": "{{store}} cost table {{fetched_date}}",
        "body_template": "{{store}} average costs received through {{fetched_date}}.\n\n{{rows_table}}",
        "formats": { "avg_cost": "currency" },
        "fields": ["store", "breed", "avg_cost", "received"]
      }
    }
  ]
}
```

Deploy the already reviewed manifest through the install workflow. Do not add a
trailing slash to any endpoint path. A `308` response means the path is not the
canonical path and the pull stops with a configuration error.

## 0:04 to 0:07: connect the bearer key privately

Never paste the bearer key into chat, the manifest, a command argument, a ticket,
or a support log.

On Windows, confirm clipboard history is already off in Card Q and turn screen
sharing off. Open the key email, copy only the key, and run this one line:

```powershell
& "$env:LOCALAPPDATA\FinancialBrain\brain.cmd" connect custom-api "$HOME\Financial Brain\brain.manifest.json" --from-clipboard
```

Clipboard mode is the Windows default. The command trims surrounding whitespace,
writes only the declared Worker secret, clears the clipboard even if the write
fails, and verifies only that the secret name exists. Wait for **Store key saved
in your Brain and cleared from the clipboard.** before turning screen sharing
on again. If the clipboard is empty or cannot be read, copy only the key and run
the same line again.

If clipboard entry still fails, keep screen sharing off and use the dashboard
fallback:

```powershell
& "$env:LOCALAPPDATA\FinancialBrain\brain.cmd" connect custom-api "$HOME\Financial Brain\brain.manifest.json" --key-set-in-dashboard
```

Follow the printed path exactly: **Workers & Pages → the named Worker → Settings
→ Variables and Secrets → Add → type Secret**. Paste the value only into
Cloudflare's masked field. The command waits up to two minutes and verifies only
that the declared name exists, never its value.

macOS keeps the hidden terminal prompt. Turn screen sharing off before running:

```bash
"$HOME/.financial-brain/bin/brain" connect custom-api "$HOME/Financial Brain/brain.manifest.json"
```

Wait for confirmation that the declared secret name was read back. On macOS,
turn screen sharing on again only after the hidden prompt and command complete.
Clipboard entry is also available on macOS by copying the key and adding
`--from-clipboard`; the same validation, clearing, and name-only readback apply.

## 0:07 to 0:10: preview the live feed without saving

Windows PowerShell:

```powershell
& "$env:LOCALAPPDATA\FinancialBrain\brain.cmd" custom-api "$HOME\Financial Brain\brain.manifest.json" --dry-run
```

macOS Terminal:

```bash
"$HOME/.financial-brain/bin/brain" custom-api "$HOME/Financial Brain/brain.manifest.json" --dry-run
```

The preview must print one line for each endpoint with its returned row count,
the number of readable documents it would write, and the number of refused
rows. It makes the three feed requests but persists nothing. Stop if any line
is missing, a row is refused unexpectedly, or the dashboard refuses the key.

## 0:10 to 0:12: perform the first pull now

Do not wait for tomorrow's cron. Run the same command without `--dry-run`.

Windows PowerShell:

```powershell
& "$env:LOCALAPPDATA\FinancialBrain\brain.cmd" custom-api "$HOME\Financial Brain\brain.manifest.json"
```

macOS Terminal:

```bash
"$HOME/.financial-brain/bin/brain" custom-api "$HOME/Financial Brain/brain.manifest.json"
```

The command starts or resumes one durable job and makes one bounded Worker
request per slice, printing progress until terminal verification succeeds.
Confirm the separately printed saved-snapshot result, all three endpoint lines,
the readable-document count, any refused-row count, and the next daily pull.
A missing revenue stream is
reported as not recorded, never as zero. A null store is retained as
`unassigned`. Unknown provider fields remain in the structured row but stay out
of the readable document unless the manifest lists them in `fields`.

If an endpoint exceeds 10,000 rows or the 5 MiB cap, that endpoint is left
unchanged and the job does not stage. Do not raise either ceiling during the
call. Ask the provider developer to add paging or narrow the endpoint.

## 0:12 to 0:15: wait for meaning search, then prove the owner experience

The saved-snapshot line is not meaning-search readiness. If the command says
the source is still indexing, let the Worker's scheduled drain advance in the
background, then rerun the custom API command until it prints **meaning search
is ready for this source**:

```bash
brain custom-api <manifest>
```

Do not ask the owner question while the source outbox is pending.

Ask one owner question that requires the new source:

> What were net sales by store last month?

Confirm the answer cites the single monthly cross-store sales document, covers
every store in that month even when there are more than eight stores, and does
not invent zero sales for an absent stream. This is the install-night owner check, not a
general accuracy certification.

## Tomorrow: prove the Worker ran without the laptop

After the printed next-pull time has passed, check source freshness.

Windows PowerShell:

```powershell
& "$env:LOCALAPPDATA\FinancialBrain\brain.cmd" sources "$HOME\Financial Brain\brain.manifest.json"
```

macOS Terminal:

```bash
"$HOME/.financial-brain/bin/brain" sources "$HOME/Financial Brain/brain.manifest.json"
```

The `store-dashboard` source must be ready and show a successful ingest after
the install-night pull, inside its one-day freshness window. An unchanged full
response may write zero documents; the fresh successful pull is still visible.
If freshness did not advance, leave the saved rows unchanged and inspect the
named source error. A `401` means the dashboard refused the key. A `308` means
the manifest endpoint path is not canonical. Never paste the provider response
or bearer key into support material.

The structured rows are reserved for a later reviewed financial-map adapter.
This setup does not post anything to the ledger.
