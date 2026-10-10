# Tax evidence checklist in Ask

Sign in to the owner app and open **Ask & Explore**. Select one owned financial
entity, enter a tax year, and choose **Tax evidence checklist** beside the question
box. The checklist button is available only in the owner workspace. It requires
an explicit entity and a four-digit year from 1900 through 2200.

The result is a dated, nonmonetary checklist of stored evidence and missing review
steps. Tax amounts and filing readiness are not checked. A populated checklist
is never tax correctness, filing approval, a complete document population, or
permission for a money answer.

Typing a question, including `Check tax readiness for 2025.`, always uses ordinary
Ask. Quoting, punctuation, casing, compound instructions and monetary text do not
select a workflow. The checklist button does not send or rewrite the question draft.

The workflow reads the current Financial Map and the structured Financial
Picture inventory. It does not search prose to prove absence, extract PDFs,
evaluate tax rules, store a tax document, refresh a provider, or contact a
preparer. Existing authentication audit bookkeeping still applies.

## Access and scope

Only a valid full owner app session or the full admin credential can enter the
workflow. The Worker passes an explicit internal capability after authentication.
Proxy keys, capability grants (including unrestricted grants), document grants,
and remote MCP's default owner label do not confer this capability. Request
fields cannot supply a map, confirmation, capability, or amount. Current owner
access is checked again before any map or inventory result is returned, including
missing/stale map notices and entity/year clarification. Lost or unverifiable
access withholds those private states and diagnostic read counts.

Ask's existing entity scope validation runs first. Missing entity selection or
an invalid structured action asks for clarification. Missing, unreadable and stale
maps have separate actions. The map reader resolves the exact selected ledger
entity to its signed map reference inside the captured inventory. Labels and
Financial Picture references are never used to join map identities. An excluded
entity or a year outside the active map does not trigger a whole-owner fallback.
Ambiguous or unconfirmed filing units remain gaps.

## Structured action contract

Send a JSON POST to `/api/rag/think` with exactly:

```json
{ "workflow": "tax_evidence_checklist", "entity": "fixture-entity", "year": 2025 }
```

`entity` is the exact owned ledger identity, and `year` is an integer. A string
year, unknown workflow, missing fields, extra fields (including `q`, `entity_slug`,
source filters, confirmations or amounts) are refused. A present `workflow`
field, even null or malformed, never falls through to generic Ask. The search
route does not accept workflow actions. Without a `workflow` field the existing
Ask parser, scope validation, tax-question safeguards and retrieval remain unchanged.

The dispatcher also reserves structured `cash_brief` (`entity`) and `books_check`
(`entity`, `period_start`, `period_end`, optional `account_ref`) actions. They
currently return unavailable placeholders. Books dates must be canonical real,
ordered calendar dates. Its optional account reference is an exact opaque string
of 1 through 256 characters without control characters; no trimming, casing or
Unicode normalization occurs. No text command invokes these placeholders.

## What the checklist means

Books, payroll, tax returns, filing/payment evidence, supporting evidence and
periods are requested for the exact entity and tax year. Conflicts lack a
tax-year filter in the existing inventory contract, so that section reads the
selected entity across all periods and explicitly labels that wider period
scope. Period inventory covers assigned tax-year rows, not every overlapping
account statement or unknown-year row. The response's `entity_scope` matches
the selected entity; filter echoes are verified before using inventory pages.

Each section distinguishes present metadata, unreadable originals, unavailable
reads or access, and measured empty stored scope. A failed read has no zero
count. An explicit unreliable-extraction flag also triggers the originals-review
gap, even when custody says the original is readable and extraction is native.
A measured empty section does not prove that an original or tax item is
absent. Payroll, rejected/unextracted documents, freshness, form classification,
K-1 role, filing jurisdiction, official form mapping and authenticated field
review remain explicit limitations with next steps. Inventory metadata is not
field confirmation or proof of the underlying amount.

No production official form map ships. Owner-entered map labels and test fixture
maps do not supply one. The checklist uses the existing 32-family tax catalog:
all 32 remain not checked, including the 14 implemented families and 18 families
without implementations. It calls `uncheckedTaxResult`, never the evaluator,
and creates no T1 transfer. The denominator and prerequisite gaps are visible
in the ordinary Ask answer display.

Opaque inventory references are not original-document citations. This increment
resolves no original-document links and returns an explicit citation gap with
an empty citation list. It renders no raw source text, titles, map labels, money
values or raw errors. Safe metadata contains checklist states, counts, year,
date and fixed reason codes. `financial_authority` and evidence-gate support
remain false. Checklist output cannot approve a monetary response.

## Bounded reads and concurrent changes

Each of seven sections uses one-section inventory requests at 100 records per
page, at most two pages per section. Only the inventory's returned `next_cursor`
is followed, with the same filters and page size. Cursor, filter echo, count and
page-shape inconsistencies become unavailable. An unvisited continuation stays
visibly partial. Up to 14 initial calls and 14 validation calls are possible;
map reads bracket the operation. Each page uses the reader's existing D1
snapshot semantics.

Inventory continuation uses offsets into live state, not one cross-page
snapshot. Before rendering, the workflow replays the same requests, compares
the section metadata, rereads the map and revalidates owner access. Changed
source/evidence metadata, changed map, failed recheck or lost owner access
withholds the affected checklist. A stable replay still does not establish a
shared mutation fence or completeness, and no such claim is made.

## Extension and verification

`dispatchCfoWorkflow` now accepts `{ action, entityScope, ownerCapability,
filters, reauthorize }` and injected handlers. `parseCfoQuestion` and the text
classifier have been removed; `parseCfoAction` validates the closed typed object.
The trusted capability is still supplied independently of the action body.
Handler kinds and intent shapes remain `tax_readiness` with `taxYear`, `cash_brief`,
and `books_check` with `periodStart`, `periodEnd`, `accountRef`.
Handlers return `{status, answer, gaps, metadata}`; the dispatcher supplies the
Ask envelope and fixed scope. Later workflows must retain the positive owner
capability, source authorization and final recheck boundaries and add their own
money verifier before rendering amounts. An internal handler is not callable
through request JSON.

The dedicated suites exercise actual Worker fetch requests, SQLite-backed
ledger and map activation, supported credentials and excluded readers, empty
versus failed inventory, continuation limits, scope mismatch and mid-read
revocation. Free-text regression cases from prior reviews now all require generic
Ask and a zero `cfo_workflow` invocation counter. Structured positive and negative
controls prove the separate workflow boundary. This fixed aggregate timing stage
is visible only through existing authorized diagnostics; it carries no question,
entity, year, financial value or raw error. Offline lane tests are not release
or live acceptance. Full host/CI,
package/history privacy, independent review and separately authorized desktop,
mobile and deployed Ask verification remain integration gates.
