# Owner workspace API contract

This document freezes the browser owner-workspace contract introduced by D1
migration 0021. Unless a section explicitly defines a separate read transport,
these routes use JSON `POST`, return `Cache-Control: no-store`, and require both
a valid passkey session and `X-Brain-App: 1`. The session must resolve
positively to `{ kind: "owner", grantId: null }`. Browser owner-workspace
routes have no admin-key fallback.

Missing or invalid sessions return `401 {"error":"unauthorized","code":"session_required"}`.
A live scoped principal returns `403 {"error":"forbidden","code":"owner_required"}`.
Unavailable authorization or storage fails closed with a stable `503` code.

## Read-only Financial Picture inventory

`POST /api/fin/financial-picture` is a separate read transport used by
`brain financial-picture <manifest> --json`. It accepts either the same full
owner session described above or the install's admin key. Scoped grant and
document-grant sessions are refused. The admin key is sent only in the private
header by a protected-store resolver after the CLI validates the exact HTTPS
origin; it is never a CLI argument, URL value, request-body value, response
field, or redirect-forwarded header. This command deliberately ignores an
ambient `ADMIN_KEY` environment variable. With `--json`, command failures are
also returned as one sanitized machine-readable error receipt. The CLI requires
one saved, valid HTTPS `brain.domain`; a missing or invalid domain fails before
any admin-key read, account resolver, Wrangler session, or network request.

The request accepts only:

```json
{
  "sections": ["entities", "periods", "accounts", "books", "payroll", "tax_returns", "filing_payments", "evidence", "conflicts"],
  "filters": {
    "entity_slug": "exact-owned-or-candidate-entity-id",
    "tax_year": 2024,
    "period_start": "2024-01-01",
    "period_end": "2024-12-31"
  },
  "limit": 100,
  "cursor": "one returned section cursor",
  "provenance_baseline": {
    "recorded_at": "2026-09-10T12:00:00.000Z"
  }
}
```

Unknown fields, sections, malformed dates, limits above 500, unknown exact
entity IDs, and a cursor used with more than one section fail closed. SQL uses
only prepared statements over the `primary` tenant and exact equality filters.
All requested counts and pages run in one transactional D1 binding batch. The
response carries a deterministic SHA-256 receipt over both the inventory and
its snapshot metadata, an exact `as_of` boundary captured before the D1 read
begins, an optional keyed D1 bookmark reference, and an explicit warning that
separately paged responses are separate snapshots. A content hash identifies
that exact page. When `database_version_ref` is available, exact equality
establishes that separate pages observed the same D1 version without disclosing
the raw bookmark; its absence is explicit and does not become consistency
proof. Changing the as-of time, consistency state, bookmark state, or
database-version reference invalidates the content receipt. The CLI recomputes
that receipt and checks
the echoed sections, filters, limit, baseline, and top-level `request_cursor`
before accepting the receipt. An available section must also echo the exact
requested page cursor; an Unavailable section keeps its section cursor null.
Both the Worker immediately before JSON serialization and the CLI before JSON
output or human rendering apply the same closed version-2 response schema.
Unknown fields and raw-looking identifier, UID, provider, feed, source-name, or
locator fields are rejected recursively, including inside conflict roots.

Every section envelope carries `state`, `unavailable`, `unavailable_reason`,
`unavailable_fields`, `total`, `returned`, `truncated`, `cursor`,
`next_cursor`, exact applied and inapplicable filters, and a record-level
provenance declaration. A failed D1 batch returns every section as Unavailable;
it never turns a read failure into an empty result or labels the failed read as
a complete D1 snapshot.

Entity ownership is never inferred from a name or document. The current schema
does not retain an owner-actor receipt for entity or mapping confirmation, so
even `relationship=owned`, `provenance=owner_stated`, and
`basis_state=confirmed` is reported only as
`stored_owner_assertion_unconfirmed`. It never produces
`ownership_confirmed:true`; Optimize must obtain current owner confirmation in
the interview. Stored counterparties are likewise labeled as unconfirmed
stored assertions. Client, vendor, employer, adviser, filing-unit, and K-1
issuer-versus-recipient roles are not collapsed into ownership. Where the
current schema cannot distinguish one, the exact field is listed as
Unavailable.

Every material entity field is carried under `material_fields`, not as an
unqualified fact. `kind`, `status`, `holds`, `ownership_basis_points`,
`tax_class`, and `relationship` each retain their stored value and separately
report confirmation state, stored provenance and basis, whether the value is
only a stored owner assertion, whether an owner-actor receipt is present, and
the exact confirmation gap. In this schema `confirmed_by_owner` is always null
and `owner_actor_receipt_present` is false, so Optimize must not present any of
those values as settled owner truth.

Each record separates `source_lineage` from `mapping_confirmation`. Source
lineage reports the stored provenance kind, completeness status, stable reason
codes, basis state, source reference, timestamp, and stored unparsed reason.
Mapping confirmation carries separate stored provenance and basis for every
entity, role, account, or period field. An `owner_stated` and `confirmed` tuple
is exposed as a stored owner assertion, with
`owner_actor_receipt_present:false`, `confirmed_by_owner:null`, and a current
owner confirmation gap. Feed, document, or owner-stated provenance alone never
upgrades a mapping to owner-confirmed scope.

Coverage and statement rows are preserved even when their stored account id no
longer resolves to a current account. The period record exposes only a stable
account hash, sets `account_reference_state` to `unresolved`, leaves the entity
unassigned, and names the blocking mapping gap. The accounts and periods
sections also include a tenant-wide bounded `reference_integrity` count. This
count still runs for an exact entity filter because an unattributed orphan
cannot honestly be assigned to or excluded from that entity. Any such row
makes the provenance baseline gate `insufficient_scope`.

Account and QuickBooks identities are non-disclosing: accounts use a keyed
HMAC-SHA-256 reference plus institution, category, and at most the stored last
four; QuickBooks turns the connector's internal company fingerprint into the
same kind of keyed public reference and never returns either the fingerprint or
raw realm ID. Every digit in the unconstrained institution field is masked;
only the separately validated account mask may provide the last four. Free-form
account labels, external account references, document
titles, document text, content hashes, and raw provider record IDs are omitted.
Stored financial provenance fields remain available to the owner verifier,
including provenance, basis state, recorded time, derivation roots, and document
supersession when the ledger stores them. Raw corpus document UIDs, structured
provider locators, and feed keys never leave the Worker because each may embed
a provider account or record identifier. The receipt replaces them with stable
domain-separated, per-Brain HMAC-SHA-256 references plus explicit presence and
resolution states, so exact
equality can be checked without disclosure. Source and feed names are never
returned. Only a connector kind from the Worker's closed allowlist may be
readable; an absent or unrecognized kind remains hash-only.
The public lineage fields are `source_document_ref`,
`source_document_present`, `source_document_reference_state`,
`source_feed_ref`, `source_feed_present`, `source_feed_kind`,
`source_feed_kind_state`, `source_feed_registry_state`,
`linked_corpus_source_ref`, `linked_corpus_source_present`,
`linked_corpus_source_kind`, and `linked_corpus_source_state`. The internal
`source_doc_uid`, `source_feed`, and linked source-name values are never
response fields. Public references use domain-separated HMAC-SHA-256 under the
Brain's existing per-Brain session-signing secret. They remain equal across
pages and receipts from that Brain until the secret rotates, are not
dictionaryable without the secret, and rotate when the secret rotates. A
missing secret fails the inventory closed before any record is returned.

Document provenance is complete only when the stored document UID and locator
resolve to a current `fin_documents` or corpus `documents` row and the linked
corpus row's canonical provenance receipt validates against its stored source,
source ID, lineage, and normalized text fields. Migration-era
`text_source=native,text_reliable=1` values alone are never proof. The shared
`storedProvenanceAssessment` helper is the only receipt adjudicator used by
this route; a missing, malformed, or mismatched receipt makes extraction
unavailable and produces provenance debt. Feed provenance
is complete only when the stored feed resolves to the source registry. A stored
feed that disagrees with the linked corpus source is explicit provenance debt;
the route reports their non-disclosing references and any allowlisted connector
kinds without overwriting either stored value.

Conflict records return at most 50 ordered derivation roots and report the exact
root total and truncation. A truncated root set is itself provenance debt and
also makes a requested baseline gate `insufficient_scope`; the route never
expands a nested claim list without a bound. A claim may expose its constrained
public target kind, but neither its internal table name nor target UID is
returned. The target is represented by a keyed reference so an embedded account
slug or provider transaction ID cannot leak.
An incomplete target table and UID pair is reported as unavailable provenance
debt instead of being treated as a claim with no backing row.
A current claim target under a different stored entity or account is reported
as a scope-mapping conflict, not as a resolved reference.
An exception's transaction target is checked against both its stated account
and the current account-to-entity mapping; a mismatch or missing mapping stays
blocking evidence debt.
Open reconciliations remain conflicts even when their aggregate delta is zero;
only a durable arithmetic `matched` state is excluded.

Each returned record also carries a verification object. It names the exact
missing provenance, extraction, and freshness fields, the stored extraction
state (`native`, `ocr`, `ocr_partial`, or `unreadable`), source and ingest
timestamps when present, and whether those gaps block financial verification.
Every section aggregates affected and blocking counts over only the returned,
bounded page and says whether that page covers all matching rows. The current
schema does not durably register documents rejected before a financial evidence
row exists, so `scan_only` versus `empty` remains explicitly Unavailable. It
also lacks a durable freshness-applicability and evaluation policy, so the
route exposes timestamps but does not call evidence current or stale.
An extraction field is exposed only after canonical receipt assessment. A
valid receipt with a false reliability value remains blocking; an unassessed
row exposes neither its legacy text source nor reliability. A grouped
QuickBooks observation becomes conservatively unavailable when any member is
unassessed or lacks a canonical extraction source, and reports exact assessed,
unassessed, and missing member counts. The SQL materializes at most 50 ordered
corpus provenance receipts for one QuickBooks group while retaining the exact
full evidence count; every omitted member is counted as unassessed provenance
debt. This prevents an unbounded provider-sized JSON aggregate from entering
the Worker.

`verification.freshness.source_coverage` is produced by the shared
`sourceCoverageFromEvidence` helper from the matching source-registry row and
one exact latest `sync_runs` row selected inside the same financial-picture D1
batch. Confirmed and target ranges and accepted, refused, and failed counts all
come from that one run. A clean older run is never combined with a newer
refused, failed, unfinished, or pre-metrics run. Unmeasured outcome counts stay
null, a range stays unconfirmed when that exact run lost evidence, semantic
projection stays unknown, and this route never converts registry timestamps
into a current/stale verdict. It also leaves owner-machine waiting state null:
a raw `indexing`, `ready`, or error label is evidence, not the canonical
operational freshness adjudication needed to say catching up, current, stale,
or waiting on the owner.

An optional `provenance_baseline.recorded_at` accepts the exact past UTC
`snapshot.as_of` from an earlier receipt. The forward-looking gate counts rows
whose durable `recorded_at` is strictly later and reports whether any carry
provenance debt, with reason-code totals. Pagination, nested lineage
truncation, an unusable recorded time, an empty record registry, or any
requested Unavailable section produces `insufficient_scope` or `unavailable`,
never a pass. A stored `owner_stated` assertion without an owner-actor receipt
also counts as provenance debt, even if its legacy basis says `confirmed`.
Aggregate counts are
section-level provenance-record occurrences and may overlap when the same row
supports multiple requested sections. The baseline comparison does not
reconstruct history or infer that a source, entity, role, or period is
complete.

This endpoint is inventory evidence only. It does not use generic search,
infer real-world completeness, run a books or tax correctness check, mutate the
ledger, or return a correctness verdict. The current schema cannot prove
filing-unit identity, payroll systems or applicability, current QuickBooks
connection applicability, tax form, K-1 role, tax-authority acceptance, or
payment settlement. Those remain explicit Partial or Unavailable states.
Recovery output is planning only: this route cannot OCR, reingest, repair,
supersede, or write any record.

The Owner Financial Map has a narrow technician contract for read and preview,
plus a separate private owner-app contract for review and confirmation. Read and
preview accept the full admin key for local technician tooling. Review and
confirmation require an exact unscoped owner session plus `X-Brain-App: 1` and
have no admin-key fallback.

## Owner Financial Map

Migration 0041 adds an immutable, linear history of complete version 1 map
snapshots. It performs no backfill. Existing structured rows remain possible
mentions until the owner reviews them.

- `POST /api/admin/brain/financial-map/read` accepts `{}`. It returns the
  current possible entity and account inventory, map status, active snapshot,
  population state, and complete unresolved-item list.
- `POST /api/admin/brain/financial-map/preview` accepts `{snapshot}`. The
  snapshot is a closed full replacement, not a patch. It records only an
  24-hour non-authoritative preview and returns only state, counts, unresolved
  count, expiration, and an instruction to continue in the signed-in owner app.
  It returns no map content, selector, receipt hash, or activation authority.
- `POST /api/owner/financial-map/review` accepts `{}` from the owner app. It
  discovers the one latest pending preview after reload and returns the complete
  private map, every unresolved item, and a comparison with the last confirmed
  map. A newer preview invalidates the older one, and the database enforces one
  pending preview per tenant.
- `POST /api/owner/financial-map/passkey/options` accepts the current transient
  `{review_id}` only from that same owner-app boundary. The `ofmp_` value is a
  non-authorizing selector derived from the stored receipt hash. It must remain
  only in React memory, never a URL, chat message, clipboard, or browser storage.
  Expiration, changed inventory, and stale head are refused before a short-lived
  WebAuthn challenge is issued.
- `POST /api/owner/financial-map/activate` accepts that transient review selector,
  the app's fresh request ID, and the owner's WebAuthn assertion. A valid fresh
  ceremony appends one sealed snapshot and consumes the challenge. The app must
  verify the receipt's exact request, map, denominator, sequence, and zero-mutation
  fields, then reread authoritative active state before showing success. If the
  activation response is lost, the open page retains the exact signed request
  only in React memory. One later owner click resends that same request without
  opening another passkey ceremony; it never creates or persists a replacement.

The retired `/api/admin/brain/financial-map/passkey/options` and
`/api/admin/brain/financial-map/activate` paths always return 410. There is no
CLI or MCP activation path.

The owner workspace Financial Map screen shows every exact private label, the
complete current preview, the complete prior-map change list, and every
unresolved item. It excludes internal IDs, slugs, source locators, external
references, hashes, and raw mask fields. It explains the device passkey window
before presenting one confirmation button. Loading, navigating, and scrolling
never invoke WebAuthn. Browser automation may help with those steps but must stop
before confirmation. Canceling the device window activates nothing.

Optimize must not call any owner-app Financial Map route, start the passkey
ceremony, or use confirmation as an audit prerequisite. It uses read mode only
as its first audit evidence after the owner's opening goal. Immediately before
the private read, it explains that no map snapshot is sent and nothing changes,
even if the assistant displays an approval prompt. Before any
financial-completeness conclusion, it offers the optional guided, session-only
interview. That interview submits nothing and changes nothing. Optimize ends
before any separately explained and approved preview write.

Each snapshot names tenant `primary`, scope
`whole_owner_financial_picture`, a finite tax-year horizon of no more than 21
years, and population state `owner_asserted_complete`, `known_partial`, or
`unknown`. Every current entity and account appears exactly once with
`included`, `excluded`, or `unavailable`. The owner may add expected entities
and accounts that have no current ledger row. Every entity-year pair in the
horizon appears once, including pairs for those owner-declared rows.

Entity, account, filing-unit, return, form, K-1-role, bookkeeping-company, and
expected-source records use opaque type-prefixed local map IDs with 32 lowercase
hex characters after the prefix. A current
entity or account supplies its opaque `ledger_ref`; an expected-but-missing row
supplies `ledger_ref:null`. The normalized preview keeps this distinction under
`ledger_evidence` as either `linked_current_record` or
`owner_declared_no_current_record`. It never creates a `fin_entities` or
`fin_accounts` row. A ledger-linked row keeps its local map ID across later
snapshots; a preview that silently remaps it is refused.

The entity fields `kind`, `status`, `holds`, `ownership`, `tax_class`,
`relationship`, and `parent`, and the account fields `entity_assignment`,
`kind`, `balance_role`, `currency`, and `status`, are independently assessed as
`confirmed`, `unknown`, `unavailable`, or `not_applicable`. Each field answer is
`{assessment,owner_value}`. Only a confirmed answer carries a non-null owner
value. The normalized preview keeps the owner value separate from the current
ledger value and reports `evidence_match`. Row and current-value hashes bind
the evidence without turning it into owner truth.

Top-level `filing_units` declare the expected filing population. Every
entity-year then answers all of these categories: filing-unit membership,
required returns, required forms, K-1 roles, books and any bookkeeping company,
payroll applicability, and expected sources. Each category has its own
assessment. Expected items have stable local map IDs and independent
assessments, so an empty confirmed list, an unknown list, and an unavailable
record are not treated as the same fact.

The preview input uses this closed shape. All omitted entity years and material
fields are rejected.

```json
{
  "snapshot": {
    "version": 1,
    "scope": { "tenant_id": "primary", "kind": "whole_owner_financial_picture" },
    "tax_year_horizon": { "start": 2024, "end": 2026 },
    "population_state": "known_partial",
    "filing_units": [
      { "map_id": "ofmf_11111111111111111111111111111111", "label": "Personal return", "assessment": "confirmed" }
    ],
    "entities": [
      {
        "map_id": "ofme_66666666666666666666666666666666",
        "ledger_ref": "<opaque-current-ref-or-null>",
        "label": "Consulting company",
        "disposition": "included",
        "fields": {
          "kind": { "assessment": "confirmed", "owner_value": "business" },
          "status": { "assessment": "confirmed", "owner_value": "active" },
          "holds": { "assessment": "unknown", "owner_value": null },
          "ownership": { "assessment": "confirmed", "owner_value": 10000 },
          "tax_class": { "assessment": "unknown", "owner_value": null },
          "relationship": { "assessment": "confirmed", "owner_value": "owned" },
          "parent": { "assessment": "not_applicable", "owner_value": null }
        },
        "tax_years": [
          {
            "tax_year": 2024,
            "state": "included",
            "filing_units": { "assessment": "confirmed", "refs": ["ofmf_11111111111111111111111111111111"] },
            "required_returns": { "assessment": "unknown", "items": [] },
            "required_forms": { "assessment": "unknown", "items": [] },
            "k1_roles": { "assessment": "unknown", "items": [] },
            "books": { "assessment": "unknown", "bookkeeping_company": null },
            "payroll": { "assessment": "unknown" },
            "expected_sources": { "assessment": "unknown", "items": [] }
          }
        ]
      }
    ],
    "accounts": [
      {
        "map_id": "ofma_77777777777777777777777777777777",
        "ledger_ref": null,
        "label": "Expected operating account",
        "disposition": "included",
        "fields": {
          "entity_assignment": { "assessment": "confirmed", "owner_value": "ofme_66666666666666666666666666666666" },
          "kind": { "assessment": "confirmed", "owner_value": "checking" },
          "balance_role": { "assessment": "confirmed", "owner_value": "asset" },
          "currency": { "assessment": "confirmed", "owner_value": "USD" },
          "status": { "assessment": "confirmed", "owner_value": "never_connected" }
        }
      }
    ]
  }
}
```

The example abbreviates `tax_years`; a real request includes every year in the
horizon. Return, form, K-1-role, and expected-source groups use items shaped as
`{map_id,label,assessment}`. Expected-source items also require `kind` from
`banking`, `credit`, `loan`, `investment`, `books`, `payroll`, `tax`,
`documents`, `commerce`, or `other`. `books.bookkeeping_company`, when present,
uses `{map_id,label,assessment}`.

The request is limited to 250 entities, 500 accounts, 250 filing units, 21 tax
years, 25 items in one obligation group, 10,000 obligation-item occurrences,
and a 768 KiB normalized snapshot. Unknown fields, enums, references, duplicate
current rows, missing current rows, unreferenced filing units, and conflicting
uses of one local map ID are rejected. The map hash, denominator hash,
inventory generation, prior snapshot ID, prior map hash, and database-local
HMAC seals bind activation to one linear head. The salt for those seals is
created once by migration 0041 and is immutable, so rotating the session key
does not invalidate map history.

Verified recovery retains the immutable key and activated snapshots. It does
not retain expired previews or the inventory-generation race counter. Replayed
financial rows rebuild that local counter, and the exact inventory hash decides
whether the restored active map still matches current structured evidence.

Read and preview fail closed when migration 0041, current structured inventory,
the immutable signing key, the inventory marker, the derived head and its
predecessor, or the sequence count is unavailable or cannot be verified.
Preview and activation do not change ledger, source, tax, books, payroll, or
account records. Local MCP exposes read and preview only. Activation is a
separately explained owner passkey ceremony and is never part of Optimize.

## Source coverage

`POST /api/app/system` returns each registered source with four independent
coverage dimensions. The owner app uses these fields instead of turning one
successful refresh or one global percentage into a complete-history claim.

```json
{
  "label": "Email",
  "documents": 66000,
  "coverage": {
    "starter_context": { "state": "ready" },
    "live_updates": { "state": "catching_up" },
    "history": { "state": "running" },
    "meaning_search": { "state": "projecting" },
    "confirmed_range": { "from": null, "through": null },
    "target_range": { "from": null, "through": null },
    "current_window": null,
    "counts": { "seen": null, "accepted": null, "refused": null, "failed": null },
    "last_progress_at": "2026-09-06T10:00:00.000Z",
    "projection_pending": null,
    "waiting_on_owner_machine": false
  }
}
```

`unknown` means the stored evidence cannot prove a dimension. It is never
coerced to ready. The exact whole-brain Vectorize readiness check settles an
unknown meaning-search state conservatively: any unresolved global debt keeps
the source in `projecting`. Per-source pending counts stay null until the
priority outbox has a cheap durable aggregate, avoiding a full outbox scan on
every owner page load. Historical completeness still requires a complete
source sweep; a recent incremental receipt cannot create it.

## Shared write envelope

Every write requires `request_id`, 1 to 128 letters, digits, underscores, or
hyphens. Successful write responses contain:

```json
{
  "request_id": "stable retry identity",
  "entity_scope": { "entity_slug": "owned-entity-or-null" },
  "changed": true,
  "activity_event_id": "event id or null",
  "replayed": false
}
```

An exact retry returns the stored result with `replayed:true`, HTTP 200, and no
second domain write or activity event. Reusing a request ID with a different
normalized request returns HTTP 409 with `code:"request_id_conflict"`.

Writes are refused with HTTP 503 and `code:"owner_writes_paused"` while
`VECTOR_DRAIN_MODE=paused-for-upgrade`.

An owned entity is a live `fin_entities` row with `relationship="owned"`.
Unknown entities return 404. Counterparties return 403. Database failures
return 503 and never fall through to a broader scope.

## Upload

`POST /api/owner/uploads/capabilities` accepts `{}` and declares the backend's
exact MIME, extension, encoding, and byte limits. Current support is:

- `text/plain` with `.txt`
- `text/markdown` with `.md` or `.markdown`
- strict UTF-8, with one leading UTF-8 BOM removed
- 1,000,000 UTF-8 content bytes

Empty or unknown MIME types, PDFs, images, Office files, RTF, email containers,
archives, and binary files return HTTP 415. Full binary upload remains blocked
on a separately reviewed storage and extraction architecture.

`POST /api/owner/uploads` request:

```json
{
  "request_id": "upload_attempt_1",
  "document_id": "stable_document_identity",
  "entity_slug": "owned_entity",
  "media_type": "text/plain",
  "file_name": "notes.txt",
  "envelope": {
    "content": "text",
    "title": "optional title",
    "metadata": {}
  }
}
```

`document_id` is stable across retries and later versions of the same logical
document. `request_id` identifies one attempted write only. Clients must not
send `envelope.source_type` or `envelope.source_id`. The server binds:

- `source_type = "upload"`
- `source_id = "owner:{entity_slug}:{document_id}"`
- authoritative `metadata.entity_slug = entity_slug`
- legacy Vectorize candidate metadata `client = entity_slug`

The resulting corpus identity is `upload:owner:{entity_slug}:{document_id}`.
Every accepted upload passes through the common ingest scanner, provenance,
chunking, and store path. Created or updated content emits one event only after
the store succeeds. Identical content is `unchanged` and emits no event.

The route persists a bounded pending intent before common ingest. A retry after
ingest committed but before receipt finalization resumes that intent, returns
HTTP 200 with the original action and `replayed:true`, and finalizes exactly one
event. A scanner rejection removes the pending intent and leaves no receipt or
event.

## Approvals

`POST /api/owner/approvals` supports:

```json
{
  "request_id": "ruling_1",
  "entity_slug": "owned_entity",
  "approval_type": "reconciliation_ruling",
  "subject_uid": "reconciliation_uid",
  "selected_claim_uid": "claim_uid",
  "note": "optional"
}
```

```json
{
  "request_id": "exception_1",
  "entity_slug": "owned_entity",
  "approval_type": "exception_resolution",
  "subject_uid": "exception_uid",
  "resolution": "required resolution",
  "note": "optional"
}
```

The reconciliation write updates the served `fin_reconciliations` row while
preserving both claims and appends `owner_approvals`. The exception write
updates the served `fin_exceptions` row without changing its transaction.
Approval and activity rows are append-only in SQL.

## Period close

- `POST /api/owner/period-closes/read`
- `POST /api/owner/period-closes/accept`
- `POST /api/owner/period-closes/reopen`

Read accepts `{entity_slug,period_start?,period_end?}`. A healthy empty result
contains `period_closes:[]`. An unavailable read omits the collection and names
`sections_unavailable:["period_closes"]`.

Accept and reopen require `request_id`, `entity_slug`, `period_start`, and
`period_end`. Accept may include `acknowledge_incomplete:true`. Evidence failure
returns 503 without a write. Incomplete evidence returns 409 unless explicitly
acknowledged.

The response keeps decision and evidence orthogonal:

```json
{
  "period_close": {
    "period_close_id": "id",
    "status": "accepted",
    "evidence_state": "complete",
    "acknowledged_incomplete": false
  }
}
```

`status` is `accepted` or `reopened`. `evidence_state` is `complete` or
`owner_acknowledged_incomplete`. Re-acceptance derives evidence state from the
current evidence snapshot, not from an older acceptance.

## Activity

`POST /api/owner/activity` accepts `{entity_slug?,limit?,cursor?}` and returns
an append-only page under `activity_events`. Each row uses `event_type`,
`entity_slug`, `subject_kind`, `subject_id`, `display_label`, and `occurred_at`.

The one human history includes upload, approval, close, target, preference,
document-grant create/invite-reissue/revoke, and passkey/device changes. Shared
security writers use `document_grant_created`,
`document_grant_invite_reissued`, `document_grant_revoked`, `passkey_added`,
`passkey_renamed`, `passkey_revoked`, and `sessions_revoked` only after a
successful non-replayed state change. The history never contains document
content, questions, answers, credentials, credential IDs, raw errors, IP
addresses, user agents, or low-level allow/deny telemetry. Security telemetry
remains separate.

## Targets and preferences

Targets:

- `POST /api/owner/targets/read` with `{entity_slug}`
- `POST /api/owner/targets/upsert`
- `POST /api/owner/targets/archive`

Metrics are `revenue`, `cash_reserve`, `spending_limit`, `debt_reduction`, or
`other`. Money is a safe integer in minor units with a three-letter currency.
Identical upserts and repeated archives return `changed:false` and emit no event.

Preferences:

- `POST /api/owner/preferences/read` with `{entity_slug?}`
- `POST /api/owner/preferences/set`

Supported keys are `default_entity`, `display_currency`,
`fiscal_year_start_month`, and `activity_window_days`. Scope and value rules are
enforced by the backend. Setting an identical value returns `changed:false` and
emits no event.

## Entity-scoped Explore and Ask

`POST /api/rag/unified` and `POST /api/rag/think` accept `entity_slug` in the
private JSON body. D1 validates a live owned entity, then applies exact
`documents.entity_slug` equality to keyword search and vector hydration.

Migration 0021 backfills this authority only from an unambiguous live
`fin_documents.corpus_doc_uid` mapping. It never infers authority from the
free-form legacy `documents.client` label. Unmapped or ambiguous legacy rows
remain `NULL` and owner-only.

Vectorize does not yet have canonical entity metadata. The legacy client value
is used only as a candidate hint, never as a D1 predicate. Every scoped response
therefore reports `degraded:"vector"` and
`degraded_reason:"entity-vector-authority-unindexed"` until the canonical
metadata index is built and reprojected. A scoped semantic miss cannot appear
as a healthy empty result.
