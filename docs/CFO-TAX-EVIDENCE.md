# Tax evidence checklist in Ask

Sign in to the owner app, select one owned entity, and ask:

> Check tax readiness for 2025.

Use the exact year you want to review. The result is a dated, nonmonetary
checklist of stored evidence and missing review steps. Tax amounts and filing
readiness are not checked. A populated checklist is never tax correctness,
filing approval, a complete document population, or permission for a money answer.

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
an unsupported question asks for clarification. Missing, unreadable and stale
maps have separate actions. The map reader resolves the exact selected ledger
entity to its signed map reference inside the captured inventory. Labels and
Financial Picture references are never used to join map identities. An excluded
entity or a year outside the active map does not trigger a whole-owner fallback.
Ambiguous or unconfirmed filing units remain gaps.

The dispatcher recognizes these complete questions, with optional final period
and case-insensitive command words:

- `Check tax readiness for YYYY.` (1900 through 2200)
- `Show my weekly cash brief.`
- `Check books against bank from YYYY-MM-DD to YYYY-MM-DD.`
- `Check books against bank from YYYY-MM-DD to YYYY-MM-DD for account "opaque reference".`

Books dates must be real and ordered. Its optional account reference is a JSON
string, decoded exactly without trimming or case folding, limited to 256
characters and excluding control characters. Cash and Books currently return
unavailable placeholders. They cannot fall through to generic retrieval.
Routing makes one structural decision: an explicit workflow request enters the
workflow boundary; anything else retains generic Ask unchanged. Detection uses
an NFKC-normalized, lowercase token view, treating punctuation and quotation
marks as presentation. The original question and opaque Books account reference
are never rewritten. Only the complete grammar above can invoke a handler;
other explicit forms return nonmonetary scoped clarification, with no evidence
snippets or model call.

A request head consists of a workflow action and noun, optionally preceded by
polite/modal operators, an explicit year, or execution operators (`run` and
`execute`). Thus `Please run "Check tax readiness for 2025; review books".` is
an execution request, including with Unicode quotes or compatibility characters.
Quoted command arguments belong to that execution head. Separate unquoted
action clauses also stay inside the workflow boundary, as in `Summarize the
project notes; check tax readiness for 2025.`

A document or explanation head instead owns its quoted arguments and any data
introduced by a colon through the end of the request. Neither punctuation inside
that data nor a coordinated quoted title becomes a new action. For example,
`What did the CFO mean by this instruction: check tax readiness for 2025?` and
`Find the note titled "Check tax readiness for 2025; review books".` retain
document retrieval. Merely mentioning the CFO or a workflow topic does not
invoke a workflow. Extra source, category, platform, folder and date filters
are refused for CFO requests.

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
in the ordinary Ask answer, which needs no frontend change.

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

`dispatchCfoWorkflow` accepts trusted parsed context and injected handlers.
Handlers return `{status, answer, gaps, metadata}`; the dispatcher supplies the
Ask envelope and fixed scope. Later workflows must retain the positive owner
capability, source authorization and final recheck boundaries and add their own
money verifier before rendering amounts. An internal handler is not callable
through request JSON.

The dedicated suites exercise actual Worker fetch requests, SQLite-backed
ledger and map activation, supported credentials and excluded readers, empty
versus failed inventory, continuation limits, scope mismatch and mid-read
revocation. A balanced 48-case routing corpus uses stored monetary originals
to distinguish workflow refusal from real document retrieval; 648 generated
quote, punctuation and casing variants each exercise execution and reported
text. Offline lane tests are not release or live acceptance. Full host/CI,
package/history privacy, independent review and separately authorized desktop,
mobile and deployed Ask verification remain integration gates.
