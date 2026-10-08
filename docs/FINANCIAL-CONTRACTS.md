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
