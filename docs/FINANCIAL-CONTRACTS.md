# Financial evidence contracts, version 1

These internal contracts are the 0.4.11 integration boundary for report adapters,
Books check, tax review, the independent oracle and money answers. They add no
CLI command, HTTP route, provider capability, or owner confirmation ceremony.
They do not establish that the books are correct or that tax treatment is valid.

## Shared imports and versions

Both CLI connectors and Worker code import the same implementation under
`worker/src/lib/`, as existing connector provenance modules already do.

| Module | Internal exports |
| --- | --- |
| `financial-contract-schema.js` | Deeply frozen `FINANCIAL_CONTRACT_SCHEMA`, JSON Schema 2020-12 descriptors under `$defs` |
| `financial-snapshot-contract.js` | `validateFinancialContract(kind, value)`, `assertFinancialContract`, `sealFinancialSnapshot`, `verifyFinancialSnapshot`, `resolveFinancialCell`, `normalizeFinancialReportCell`, `financialHash`, `canonicalFinancialJson` |
| `financial-money.js` | `moneyFromDecimal`, `moneyFromMinor`, `assertMoney`, `sumMoney`, `moneyToSafeInteger`, version-1 currency exponent catalog |
| `financial-answer-plan.js` | `verifyFinancialAnswerPlan(plan, {resolveSnapshot})` |
| `financial-evidence-store.js` | `createFinancialEvidenceStore({db, authorize, readSource, readMapHead})` |

The package remains CLI-only with closed package exports. These relative imports
are internal implementation seams, not new supported package entry points.
Every object is closed, every field is required, and unknown versions or fields
are rejected. Nullable fields preserve unknowns. JSON Schema describes shape;
the shared validator additionally enforces money, dates, counts, scope echoes,
hierarchy, status and comparison invariants. A generic JSON Schema validator alone
is insufficient. Validation returns `{ok, checked, errors:[{code}]}` without input
content. `checked` witnesses entry into the decision path.

| Contract | Version | Meaning |
| --- | --- | --- |
| R1 snapshot | `financial-snapshot-1` | Immutable typed report observation |
| Coverage | `financial-coverage-1` | Explicit measured scope, never real-world completeness |
| Citation | `financial-citation-1` | Exact snapshot hash, source identity and row/cell coordinate |
| B1 finding | `books-finding-1` | One versioned B01-B14 check result, with both evidence sides |
| T1 transfer | `books-tax-1` | Books-to-tax review payload, never financial authority |
| Answer plan | `financial-answer-1` | Exact scope and deterministically recomputed monetary claims |

Money and scope are versioned by this enclosing contract bundle. Wire money is
`{decimal,currency,exponent,amount_minor,precision}`. Decimal and minor units are
strings; JavaScript money numbers are rejected even when integral. The original
decimal, including negative zero, is retained. BigInt performs exact arithmetic.
USD, JPY and KWD use exponents 2, 0 and 3. The exported currency catalog is a
deliberate supported ISO subset; unsupported codes fail closed. Values smaller
than the currency unit remain `unrepresentable` with null minor units. Rounded
observations remain labelled and cannot enter exact sums. `sumMoney` checks
numeric currency/precision; callers must also establish account roles, scope,
additivity and evidence through the answer/finding contracts. Unsafe legacy
integer storage fails instead of clamping. V1 supports up to 78 minor-unit digits.

## R1 normalization and coverage

Scope records tenant, entity, exact owner map, company fingerprint, inclusive
company-local period and reporting as-of date, timezone, fiscal-year end, basis,
currencies, filters and exact request/echo parameters. `observed_at` is a separate
instant, never inferred from the reporting date. Company fingerprints are SHA-256
hex, not provider realms. Opaque IDs are compared verbatim.

Rows are flat with immutable raw JSON pointer paths and explicit parent paths.
Labels are display only; typed `group_ref` preserves account/customer/dimension
IDs even when a report provides no transaction version. Native transaction
identity/version/line fields remain separate. Column keys identify money, dates,
percentages or text.
Every detail row carries every column, including explicit blank or unavailable
cells. Row kind distinguishes detail, header, subtotal and total. Totals refer to
existing typed cells; callers never add parent and child totals together.
`normalizeFinancialReportCell` supports canonical decimal text and explicitly
selected accounting parentheses. It preserves raw display text, refuses guessed
locale separators, and never turns blank into zero. Provider-specific envelope
parsing and verified report-name capabilities belong to QBO-REPORTS.

Coverage distinguishes `complete_for_report_scope`, `partial`, `unavailable` and
`not_applicable`. Complete requires measured, agreeing report/entity types,
page/row counters, exhausted or inapplicable continuation, no parse failures,
omissions or unsupported scope, exact parameters, source readback and byte count.
Ordered page receipts carry unique IDs/hashes and measured row/byte counts. Raw
storage is the exact concatenation of those byte slices; readback hashes each
slice and the entire payload. Repeated pages or mismatched counters refuse.
No-data reports may carry explicitly measured zero total cells. Request and echo
parameters must bind `report_name`, `company_fingerprint`, `period_start`,
`period_end`, `as_of`, `basis`, `presentation_currency`, plus the three filters.
Filter parameter values are canonical JSON arrays; `[]` means all only with the
matching request and echo. Missing provider echoes need a verified adapter
receipt or an incomplete snapshot, never copied request values presented as echo.

A single report may be complete when a mutation fence is unsupported. Cross-report
arithmetic additionally requires a stable shared fence, generation and observation.
This is a comparison contract, not a claim of transactional provider reads.
Provider names, extra dimensions, locale and expanded date macros must be included
in `report_parameters` by their adapter. The validator cannot authenticate a
provider response or independently prove that its parser read the right cell.

Snapshot hashing is SHA-256 over UTF-8 canonical JSON, sorted object keys and
preserved array order, excluding only `content_hash`. Raw payload hashing covers
the exact input bytes. Hashes prove byte identity, not truth. Use
`verifyFinancialSnapshot` in addition to structural validation before trusting a
stored snapshot. Native report lineage has its real source-document root and
company source family. Derived lineage is limited to 16 roots without truncation.

## B1 and T1

B1 preserves the program's detailed outcomes and the packet's summary names:

| Detailed outcome | Summary status |
| --- | --- |
| `pass`, `not_applicable` | `clear` |
| `candidate` | `finding` |
| `incomplete`, `not_comparable` | `incomplete` |

`clear` means this check's outcome only. It is never a books-correctness verdict.
Each result records rule/policy versions, severity, evidence, candidates, reason,
bookkeeper question, resolution state and `financial_authority:false`. Missing
evidence remains unavailable; absence needs a complete search receipt. Comparable
differences are exactly left minus right. A nonzero difference cannot be `pass`.
The store binds each side's value to its cited typed cell. A calculated aggregate
must first obtain its own verified derived/report cell; an array of citations
alone does not authorize summing overlapping records. B01-B14 evaluation,
run-level rule denominators and trusted search-receipt construction remain owned
by the Books lanes.

The v1 store accepts absence only from a complete no-data report with a cited
explicit zero cell. Subset searches need a separately reviewed receipt adapter;
caller-supplied zero-match counts on nonempty reports are refused.

### Books transaction matching seam

`books-match.js` adds `matchBooksSnapshots({scope, quickbooks, bank},
{resolveSnapshot})` and `verifyBooksAbsenceReceipt(receipt, {resolveSnapshot})`.
The two input references use the existing `snapshot_ref` contract. The resolver
must return the currently authorized R1 snapshot after checking custody, current
head, source grants and the active owner map. Snapshot hashes are verified again.
Supplying request JSON as that resolver's authority is prohibited.

The smallest adapter extension is the internal `BooksTransactions` R1 profile.
This is a normalized inventory profile, not a claim that a provider exposes a
report with that name. No provider reader or new route is enabled here. It uses
the existing money, scope, coverage, row and citation schemas unchanged:

- `source_kind` is `quickbooks_report` or `bank_report`, respectively. Both sides
  have the exact same entity, company, owner-map head, basis, currency, timezone,
  fiscal-year end and filters. A nonempty `account_filter` names reviewed owner
  account IDs; adapters must bind each native account to that map before using
  `group_ref: {kind: 'account', id: <owner account ID>}`. Labels cannot map accounts.
- Each detail row carries native entity ID, version, and optional line ID.
  `amount` is exact nonnegative wire money, with `inflow` or `outflow` cell role.
  Required text/date columns are `posted_on`, `direction`, `reference`,
  `linked_entity_id`, `linked_line_id`, `transfer_ref` and `record_state`.
  Reference/link/transfer cells use explicit blank when unknown. Other fields
  must be present. IDs and references are compared verbatim, with no trimming.
- `linked_entity_id` and optional `linked_line_id` name the opposite side's
  native identity. Adapters must document those links, never infer them from
  amount or label. `transfer_ref` is a documented common transfer identity across
  the reviewed internal accounts. Intercompany transfers require a separate
  adapter and remain unsupported by this same-entity profile.
- `record_state` is `settled`, `pending`, `removed` or `superseded`. Excluded rows
  remain visible and block absence proof. Identical active ID/version replays
  retain every citation but contribute one record. Conflicting active versions
  refuse. This bounded profile accepts at most 500 physical rows per snapshot;
  overflow refuses without truncation. A graph exceeding 10,000 candidate edges
  also refuses as a whole, keeping dense ambiguity from producing an unbounded
  response. No partial candidate selection is returned on either bound.

The matcher builds the complete graph before allocating records. Explicit links
reserve their endpoints against weaker guesses. Contradictory links and all
competing candidates survive in their connected component. A heuristic exact
pair requires mutual uniqueness, identical documented reference, account,
currency, direction, amount and date. Unknown references cannot certify identity.
A date shift within three calendar days is a timing candidate. Amount differences
use BigInt and shared wire money. Each component retains all records and candidate
edges; no amount is selected for an ambiguous component. Duplicate candidates
remain review-only. A transfer allocation requires two equal, opposite legs on
distinct reviewed accounts on each side, and a unique compatible cross-source
partner for each leg. A missing or inconsistent leg never becomes a net zero.

`books-match-search-1` is a separate, replayable subset absence receipt. Its closed
shape is the exact output of the matcher: `schema_version`, `policy_version`,
`scope`, `present` (a real citation), `quickbooks` and `bank` snapshot references,
`predicate_hash`, `search_start`, `search_end`, `opposite_side`,
`opposite_coverage`, `searched_record_count` and `match_count: 0`.
The predicate hash covers canonical JSON of policy version, scope, present
citation and both snapshot references. No absent record or zero-money citation
is fabricated. Both complete inventories must cover the period plus three days
on each boundary, agree on observation, generation and stable mutation fence,
and have no exclusions. The final covered day must have ended in the company
timezone by observation time. Future or still-open days cannot establish absence. Records used
only in the search margin remain visible under `boundary_only`. A counterpart
reserved by another link still blocks a zero-match receipt.

Verification resolves both current snapshots again and repeats the entire
deterministic search, then compares every receipt field exactly. A changed source,
revoked grant, stale map, changed count, changed policy or extra field refuses.
This receipt is not yet the B1 store's narrower `search_receipt` object. The
BOOKS-DOCUMENT integration must invoke this verifier and provide a reviewed
persistence adapter; it must not paste a subset zero into the whole-report B1
slot. Existing B1/T1 schemas and storage acceptance remain unchanged.

Results expose `checked`, `groups`, `excluded`, `boundary_only`, and
`checks_completed|needs_review|incomplete`. All results are review-only and set
`financial_authority:false` and `mutated_source_records:false`. The legacy bounded
reconciliation route also uses the complete candidate graph; its unmatched rows
remain incomplete because its coverage labels cannot supply these receipts.
Its existing amount/date-only exact groups are legacy present-record comparisons,
not B02 identity or absence proof. Books rules must use the R1 matching seam.

T1 carries typed metrics, signed bridge adjustments, report hashes, unresolved
finding references, exact mapping version and optional authenticated confirmation
reference. A transfer with `confirmation:null` is valid only as `not_checked`.
A compared tax line needs matching entity/filing unit/role/year/jurisdiction,
period, basis, currency and measure, operative version and reviewed extraction.
Whole-dollar comparison supports explicit half-away-from-zero rounding with
signed ties; it never uses a blanket one-dollar tolerance. Unknown precision
blocks comparison. Equality concerns these claims only.

The fixed T1 wording is **Possible miss, review with your preparer**. No tax amount,
eligibility, deduction, savings, filing recommendation or winning source is
determined. Confirmation and extraction references describe evidence; they are
not self-authenticating. TAX-CHECK must resolve server-held, hash-bound receipts,
exact-year maps and current source grants before executing a comparison. This
does not broaden the existing human-confirmed gross-receipts bridge.

## Answer boundary

The verifier requires a trusted `resolveSnapshot(citation)` that returns the
currently authorized immutable snapshot. Use the store's `readCitation` and
return its `snapshot`; never return caller-provided JSON as authority. Every
operand is checked for hash, exact coordinates, source IDs, scope, observation,
coverage, precision and role. Every output claim is recomputed. One failed claim
returns a typed refusal with no partially rendered monetary text.

V1 renders fixed source-qualified text only. There is no arbitrary prose slot.
It supports a source cell, exact difference, or a bounded flat subtotal with a
complete cited additive set and matching report total. Partial data can support
an explicitly labelled individual detail cell, never an aggregate. Unknown scope
refuses. FX, percentages, ranges, general partitions and unbound prose need an
explicit later contract; the current shape refuses them. MONEY-ANSWERS owns
routing this gate through every actual API, MCP, app, export and document path.
Installing these modules alone does not change current answer behavior.

## Storage, access and migration reservation

**0053_financial_evidence.sql is reserved by FIN-CONTRACT.** Integrating lanes
must reuse it rather than independently claim 0053. It appends
`financial_snapshots`, `financial_snapshot_heads`, `financial_findings` and
`financial_run_events`. No shipped migration changes. Recovery includes all four
tables only from schema 53 onward, restoring immutable generations before heads.

The store retains exact raw bytes, normalized JSON and append-only implementation
SHA/input/dependency/time receipts. One D1 batch publishes snapshot, fenced head
and completion event. A readback verifies actual stored bytes, hashes and pointer
before success. Retries cannot replace an existing snapshot ID with different
bytes. A changed source appends a generation; history remains readable explicitly
as historical, but cannot answer as current. Partial candidates record an
incomplete event and preserve the current head. Provider staging/pages and cursor
advancement remain the connector's responsibility and must precede/follow this
boundary respectively.

Raw input is bounded at 512 KiB and normalized JSON at 1 MiB per snapshot. Larger
reports require the Reports lane's verified partition/manifest adapter or a
visible refusal. They must never be silently truncated. No source writes, ledger
corrections, background jobs or source-retirement hooks are introduced here.

All store dependencies are injected. `authorize` must enforce the tenant, exact
entity, source and document grants for the requested action. `readSource` must
resolve immutable custody and return matching source/document/raw hash plus
`available:true`; missing/retired/revoked evidence must fail. `readMapHead` returns
the authenticated active owner-map ID. Every snapshot and citation read rechecks
these dependencies, and finding reads recheck both sides. Integrators must wire
these callbacks to existing custody and auth services. There is deliberately no
ambient credential, endpoint, clock or permissive default implementation.

## Cross-lane fixtures and gates

`test/fixtures/financial-contract.mjs` exports fresh invented instances:
`financialFixtures`, `invalidFinancialFixtures`, `financialScope`,
`financialCoverage`, `financialCitation`, `financialReportFixture`,
`financialTaxComparison`, a fixed observation time and exact synthetic raw bytes.
Fixtures remain repository test material and are excluded from the npm package.
The report builder covers 0/1/17/1001 detail rows, nested total relationships,
duplicate labels and USD/JPY/KWD. Tax examples simulate authenticated receipts;
they are not official form maps or the independent accounting oracle.

Focused suites are `test/financial-contract.test.mjs` and
`test/financial-evidence-storage.test.mjs`, registered in the full offline chain.
Schema migration, recovery, syntax, privacy, full host and CI verification remain
required at integration. Real-provider semantics, a test Brain, exact-year tax
review, UI verification and independent review are separate gates.

## Tax check implementation seam

The tax lane adds internal, dependency-injected modules without changing R1,
B1, T1, the existing gross-receipts reconciliation, the OCR answer gate, or the
reserved migration. It registers three focused suites in the offline chain.
These functions do not register a CLI command, HTTP route, owner approval flow,
or ordinary retrieval document. MAIN must connect the authenticated owner flow
and exact-year map registry before exposing this capability.

| Module | Entry point and boundary |
| --- | --- |
| `ingest/tax-pdf.mjs` | `extractTaxPdf({bytes,formMap,textSource})` parses local PDF bytes with the installed `unpdf` parser. Monetary rectangles and widget names come from an exact template map. It returns bounded candidates, never accepted tax amounts. |
| `worker/src/lib/tax-check.js` | `confirmTaxLine(input,deps)` consumes an authenticated field review; `confirmTaxLines(inputs,deps)` preserves partial results from one scoped batch. `evaluateTaxCheck({rule_id,transfer},deps)` resolves current evidence and executes a T1 rule. |
| `worker/src/lib/tax-check-rules.js` | `evaluateTaxRule(ruleId,transfer,{review,mapping})` is pure computation over already resolved evidence. It is not an authorization endpoint. |
| `worker/src/lib/tax-check-document.js` | `createTaxCheckStore(deps).publish(request)` computes and stores a private `Tax check <year>` document; `.read({tenant,run_ref,current})` rechecks evidence and grants. |

All PDF values require owner confirmation in this first implementation. Native
AcroForm and layout text have distinct candidate confidence categories; repeated
widgets, field/text disagreement, unsupported rotation, malformed money, missing
pages and XFA fail closed. Blank remains blank. The parser does not inspect or
certify appearance streams, render page crops, or perform OCR. A scan's separate
confirmed value is `owner_stated`; neither original `text_source` nor
`text_reliable` is promoted. No production form map ships with these modules.
An exact-year registry must be reviewed against official forms/instructions and
preparer policy; fixture maps are invented, not official tax mappings.

The compatible extensions are local receipt/envelope contracts around unchanged
T1. They are not additions to the shared JSON Schema or independently trusted
claims:

- `tax-pdf-map-1`: version, form, form revision, year, jurisdiction, USD currency,
  page count, and monetary field entries with line/box, page, widget name,
  rectangle, signed-value permission, US decimal format and rounding convention.
- `tax-field-review-1`: authenticated principal and confirmation time, receipt
  reference, confirmation kind and SHA-256 of the exact T1 line. Candidate review
  also binds the candidate hash over document hash, map hash, provenance, locator,
  state and exact value. `confirmTaxLine` requires an explicit tenant and current
  authorized source custody. The authenticated review UI must issue this receipt
  only after the owner reviews the exact field.
- `tax-check-map-1`: reviewed version, content hash and unique rule entries for
  measure, form/revision/line, year/jurisdiction, period, basis, currency, signed
  values and rounding. The content hash is canonical JSON with `content_hash:null`.
- `tax-check-review-1`: authenticated principal/time, receipt reference,
  `binding_hash`, mapping hash, inventory revision, complete-for-rule source and
  return inventories, reviewed corrections/allocations/adjustments, linked or
  unlinked treatment, operative return hash, and optional reviewed absence locator.
  `taxCheckBinding` binds the entire T1 input and rule ID, with confirmation null,
  comparison `not_checked` and difference null to avoid a self-referential hash.
  This receipt must come from server storage, never request JSON.

Reviewed absence uses a separate locator on the trusted review receipt and leaves
T1's numeric `tax_line` null. Its cited R1 evidence must be a current complete
reviewed no-data report with an explicit zero cell. That cell records the bounded
review inventory, not a zero tax line or a search result. Unsupported absence
adapters stay not checked. A source aggregate must already have a verified R1
cell. Raw document lists, original plus corrected forms, ordinary plus qualified
dividends, and 1099-K plus already booked receipts are never automatically summed.
Cross-report adjustments additionally require matching stable fences, generation
and observation, reviewed mapping, and nonoverlapping roots.

Supported rule implementations are T01, T05, T06, T09, T11, T12, T13, T14, T15,
T16, T17, T18, T19 and T22. Six compare reviewed source/return amounts; eight
ask about unlinked treatment without calculating a deduction. T01/T05/T06 flag
only a reviewed excess. A larger return amount yields no signal only for that
bounded comparison; it does not establish payer completeness. T09/T11/T18 compare
both directions. The other eighteen catalog families are always visibly not
checked. Every enabled family still requires a reviewed map and complete scope.
US federal USD scopes with matching year/period are the bounded implementation;
cross-year fiscal periods and unsupported jurisdictions refuse.

The coordinator requires `now`, `readCitation`, `readReview`, `readMapping`,
`readDocument` and `readMapHead`. `readCitation` must delegate to the financial
store's current authorized read. `readDocument` must enforce tenant, entity and
original source grants and return available/current status, exact original hash,
text source and reliability. Review and mapping resolvers must read authenticated
server records. Source retirement, replacement, grant loss, pending findings,
unknown rounding, changed map or receipt, or a union above sixteen roots blocks
the affected comparison. A plain client boolean cannot satisfy these adapters.

The document store additionally takes a D1-compatible `db` and `authorizeRun`.
Publish requests contain only `scope`, `tax_year`, `filing_unit_ref`,
`jurisdiction`, `observed_at`, `implementation_sha` and `{rule_id,transfer}` entries.
Unprovided rules are explicit gaps. The immutable document, all thirty-two
outcomes, exact citation index, dependencies and input receipt share one
`financial_run_events` row. A conditional insert fences the next sequence for
the exact scope; readback verifies its hash, bytes, current sequence and freshly
resolved evidence. Lost responses retry by content identity. Earlier rows remain
immutable, and a later published sequence supersedes their current view even if
source timestamps are identical. Historical rows remain stored; this adapter
still refuses historical monetary rendering when current dependencies no longer
validate. It does not silently revive an obsolete result.

Every owner-facing section says **Possible miss, review with your preparer**.
Money and differences use only integer minor units and cited typed values.
Original identifiers, filenames, free-text labels and PDF text are excluded;
suspicious identifier metadata is refused rather than altering citation identity.
Source PDFs remain private custody material. This lane produces no unredacted
page crop. A future crop UI must apply verified redaction geometry before showing
an image. Saving a check never contacts a preparer or changes the books.

The tests include real synthetic fillable/flattened PDFs, fourteen planted cases
with fourteen controls, signed whole-dollar boundaries, one-cent and large-value
comparisons, authenticated confirmation and scope refusals, receipt/source drift,
SQLite persistence, concurrent publication, retries and privacy canaries. They
are offline implementation evidence only. Official map review, owner UI wiring,
MAIN's host/CI gates and synthetic live integration remain separate requirements.
