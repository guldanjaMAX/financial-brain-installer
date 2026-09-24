# Custom business API install-night checklist

Use this owner-present checklist to connect the read-only store dashboard during
an install call. Budget 15 minutes after the Brain itself is deployed. This path
has local mock proof only. The real API and deployed Brain remain separate field
gates until this checklist succeeds.

The feed returns a full snapshot on every call. Query parameters do not narrow
it. The Brain calls the exact `/sales`, `/inventory`, and `/costs` paths, upserts
rows by their declared keys, retains rows that disappear upstream, and runs the
same pull daily in the owner's Worker. The laptop does not need to stay on.

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
  "max_rows": 2000,
  "max_pages": 20,
  "retries": 3,
  "endpoints": [
    {
      "name": "sales",
      "path": "/sales",
      "row_key": ["store", "period", "revenue_stream"],
      "legacy_row_key": ["store", "period"],
      "document": {
        "group_by": ["store", "period"],
        "title_template": "{{store}}, {{period}} sales",
        "body_template": "{{store}}, {{period}}: net sales {{sum.net_sales}} across {{row_count}} recorded streams. {{missing.revenue_stream}}\n\n{{rows_table}}",
        "aggregates": { "net_sales": "sum", "transactions": "sum", "units": "sum", "puppies_sold": "sum" },
        "formats": { "net_sales": "currency" },
        "fields": ["store", "period", "revenue_stream", "net_sales", "transactions", "units", "puppies_sold"],
        "expected_values": { "revenue_stream": ["live_animal", "supplies", "services", "other"] }
      }
    },
    {
      "name": "inventory",
      "path": "/inventory",
      "row_key": ["store", "breed"],
      "document": {
        "group_by": [],
        "title_template": "Inventory snapshot {{fetched_date}}",
        "body_template": "Inventory snapshot for {{fetched_date}}.\n\n{{rows_table}}",
        "fields": ["store", "breed", "count"]
      }
    },
    {
      "name": "costs",
      "path": "/costs",
      "row_key": ["store", "breed"],
      "document": {
        "group_by": [],
        "title_template": "Cost table {{fetched_date}}",
        "body_template": "Average costs received through {{fetched_date}}.\n\n{{rows_table}}",
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

Turn screen sharing **off** before this step. The owner or authorized developer
enters the bearer key into the hidden terminal prompt. Never paste it into chat,
the manifest, a command argument, a ticket, or a support log.

Windows: open PowerShell from the Start menu, then paste:

```powershell
& "$env:LOCALAPPDATA\FinancialBrain\brain.cmd" connect custom-api "$HOME\Financial Brain\brain.manifest.json"
```

macOS: open Terminal, then paste:

```bash
"$HOME/.financial-brain/bin/brain" connect custom-api "$HOME/Financial Brain/brain.manifest.json"
```

Wait for confirmation that the declared secret name was written and read back.
Turn screen sharing on again only after the hidden prompt and command complete.

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

Confirm all three endpoint lines, the readable-document count, any refused-row
count, and the printed time for the next daily pull. A missing revenue stream is
reported as not recorded, never as zero. A null store is retained as
`unassigned`. Unknown provider fields remain in the structured row but stay out
of the readable document unless the manifest lists them in `fields`.

## 0:12 to 0:15: prove the owner experience

Ask one owner question that requires the new source:

> What were net sales by store last month?

Confirm the answer cites the new readable sales documents and does not invent
zero sales for an absent stream. This is the install-night owner check, not a
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
