# Custom business API setup

Use this when an owner has a read-only JSON API that should refresh inside the
owner's Brain without a laptop. This path has local mock proof only. A real API
and deployed Brain remain separate field gates.

## Before install day

Ask the API developer for the HTTPS base URL, endpoint paths, paging shape, row
identity fields, and the name you will use for the bearer-token Worker secret.
Do not ask them to put the bearer value in a manifest, ticket, log, command, or
chat. Decide the readable document grouping and wording with the owner.

Copy `corpora.custom_api` from `templates/brain.manifest.json` into the instance
manifest and review every field:

- `base_url` is the one allowed HTTPS origin and path prefix.
- `token_secret` is an uppercase Worker-secret name, never the value.
- each endpoint declares `path`, `row_key`, and its readable `document` template.
- `legacy_row_key` is optional and is used only when older rows omit newer key
  fields.
- `cadence_seconds` defaults to one day. Size, row, page, time, and retry limits
  are explicit and bounded.

Set `enabled` to `true` only after that review. Deploy the reviewed manifest so
the Worker receives the declarative configuration. The deployment contains the
secret name but not its value.

## Owner-present key ceremony

Run this from an interactive terminal while the owner or authorized developer
is present:

```text
brain connect custom-api <manifest>
```

The command prompts for the bearer key without echoing it, writes exactly the
manifest-declared Worker secret, reads back the secret name, and registers the
source's freshness expectation. It never accepts the value as a flag or an
environment variable. Use `--replace-key` only for an intentional rotation.

## Preview, run, and hand off

Preview before the first write:

```text
brain custom-api <manifest> --dry-run
```

Confirm the endpoint count, new or corrected row counts, readable document
count, and any retained missing rows. The preview calls the API but changes no
Brain data. When the plan is expected, run:

```text
brain custom-api <manifest>
brain sources <manifest>
```

Confirm the named source is ready, has the expected daily freshness window, and
that sample owner questions return the readable documents with endpoint, fetch
time, and response-hash provenance. The Worker's existing cron checks the
source every minute but fetches only when its D1 cadence gate is due.

If the dashboard refuses the key, replace it only after its developer confirms
the correct credential. If the response is malformed, too large, unexpectedly
redirected, or outside the declared host, leave the saved data unchanged and
fix the API contract or limits before rerunning. Never paste a provider response
or key into support material.

The exact structured rows are reserved for a later reviewed financial-map
adapter. This setup does not post anything to the ledger and does not infer
deletions when an upstream row disappears.
