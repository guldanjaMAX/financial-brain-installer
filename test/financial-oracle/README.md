# Financial oracle (test-only)

This directory is an offline oracle and MAIN-only sandbox harness. It is excluded
from the package allowlist. Nothing here establishes release readiness or tax
advice. Do not copy it into `scripts/`, which is published as a directory.

The independent ledger recomputes all 23 expected values and four open items.
It does not read `expected_minor` when calculating. The unchanged original
self-test provides a second arithmetic check. Amounts use BigInt and decimal
strings, including exact numeric-token serialization at the Intuit boundary.

The copied fixture sources have these SHA-256 values:

| Source | SHA-256 |
| --- | --- |
| golden-company.json | 6898f6d137b19983b8cf789f8d84d5066725a64a788713a155e3213c165e1237 |
| seed-requests.json | f49e09eaf413cc511e92428178393c0812d8de13201ad2e9eb83703756ed5daa |
| golden-selftest.mjs | 3975ea85a8bcf3316b42cd7a787a55aaafc4f3ebe17cf4d299be35149c3a0fda |

The source program directory supplied these invented fixtures. The separate
pair-order defect belongs to BOOKS-MATCH; this harness does not repair it.

## Offline commands

Run from the reviewed repository root, with a scratch HOME, credential-login
opt-out, and the coordination wait required by the lane. `WORK` below is an
existing private scratch directory. Every output path must be new; receipts
are written mode 0600, synced, and read back. No output is written to stdout.

```sh
node test/financial-oracle/cli.mjs truth --out "$WORK/truth.json"
node test/financial-oracle/cli.mjs campaign --out "$WORK/campaign.json"
node test/financial-oracle/cli.mjs cases --out "$WORK/base-cases.json"
node test/financial-oracle/cli.mjs banks --out "$WORK/bank-fixture.json"
node --test test/financial-oracle/*.test.mjs test/financial-oracle/fixtures/golden-selftest.mjs
```

`cases` defaults to 144 questions: 12 intents, four rephrasings, three repeats.
`--phase units`, `--phase periods`, and `--phase adversarial` select additional
sets. `--phase expense-1` through `--phase expense-30` select recomputed expense
perturbations. The full campaign has 583 responses over 34 phases. Thirty
adversarial prompts are distinct requests from user, memo, and attachment
contexts; they exercise subset-total and missing-coverage temptations.

The test bank records preserve the two provider sign conventions and typed
account roles. They are inputs to separately reviewed bank adapters, not an
alternative production ingest route or proof of live feed coverage.

## Seeder configuration and authority

MAIN must obtain a dedicated disposable US/USD sandbox, verify the exact API
minor version and entity/write schemas, freeze other writers, and review the
plan. Provider schema names, control account subtypes, the non-taxable code,
credit application, and native report variants still need field confirmation.
A journal is not a substitute for native payroll or sales-tax capability proof.

Create one private configuration JSON with these fields. Values are locators,
identity hashes, or reviewed non-secret metadata. Never insert OAuth values.

| Field | Required value and provenance |
| --- | --- |
| `synthetic_only` | `true`, confirmed disposable synthetic company |
| `environment`, `api_base` | `sandbox`, `https://sandbox-quickbooks.api.intuit.com` |
| `run_tag` | Unique `synthetic_` prefix plus lowercase letters, digits or underscores |
| `source` | Exact existing QuickBooks source binding |
| `company_fingerprint` | Product's existing SHA-256 company fingerprint |
| `implementation_sha` | Exact reviewed 40-hex integration commit from MAIN |
| `minor_version` | Reviewed numeric provider version string |
| `writers_frozen` | `true` only while all other sandbox writers are stopped |
| `storage` | Existing declared backend, `file` or `keychain`, with existing path or locator; no new store |
| `control_accounts` | `ar`, `ap`, `undeposited`: exact verified `Id`, `AccountType`, and subtype when applicable |
| `non_taxable` | Verified native code projection, including exact `Id` and `Taxable: false` |
| `company_info_sha256` | SHA-256 of `JSON.stringify(CompanyInfo)` from a reviewed native read |
| `preferences_sha256` | SHA-256 of `JSON.stringify(Preferences)` from a reviewed native read |
| `baseline_reports` | Three scoped requests: BalanceSheet, TrialBalance, ProfitAndLoss; see below |
| `schema_review_sha256` | Hash of MAIN's retained review of every generated request schema for this exact plan/version |
| `plan_sha256` | Copy of the dry-run plan's hash after review |
| `report_requests` | The 20 post-seed requests described below |

Storage is loaded through `loadProviderCredentials('quickbooks', ...)`, the
product's read-only loader, with migration disabled. It verifies the existing
sandbox source/company reservation. Expired or refresh-fenced credentials
refuse; no token refresh or reconnect is attempted by the harness. Tests inject
this boundary and never open a real credential store.

CompanyInfo and Preferences comparisons exclude volatile outer response time
fields. The hashed inner objects must match exactly. Their review must establish
country, currency, fiscal year, timezone, and credit/tax settings. The schema
review hash records an operator review; it is not an automatic API-schema
validator. The fake API is invented and cannot validate Intuit's live semantics.

A report request has this shape (the `scope` must match exact response headers):

```json
{
  "phase": "month",
  "scope": {
    "report": "ProfitAndLoss",
    "start": "2025-01-01",
    "end": "2025-01-31",
    "basis": "Accrual",
    "currency": "USD"
  },
  "parameters": {
    "start_date": "2025-01-01",
    "end_date": "2025-01-31",
    "accounting_method": "Accrual"
  }
}
```

Baseline requests must prove zero money or an explicit native NoReportData
response. Posting-entity queries must also be empty, with measured exhaustion.
Existing sample data is never deleted. Account reuse requires exact provider IDs
and readback; names alone are insufficient. The base creates 15 ordinary
accounts, three customers, two vendors, one service item and 21 transaction
requests: 42 writes. All writes carry the run/seed tag in PrivateNote, Notes or
Description as appropriate for the entity.

A journal binds the implementation commit, run, company, plan and exact request
hashes. It retains a hash-linked append-only transition history across resumes. Before every POST,
the pending intent is synced. A stored ID is read back on retry. A lost response
is investigated by paginated native queries for the exact tag; exactly one
matching body is required. Zero matches or competing matches stop. There is no
blind create retry and no automatic stale-lock deletion. MAIN must investigate
an abandoned lock and uncertain request before resuming. Final invoice/bill
balances and unused credit are verified before the journal becomes complete.

## MAIN live sequence

These commands are a runbook, not authority for an offline lane to contact
anything. MAIN must have separate approval for the sandbox and test Brain.
`SEED_CONFIG`, `BRAIN_CONFIG`, `MANIFEST`, and `WORK` are explicit private paths.
Do not run against a production connection or real-owner manifest.

1. Prepare and review the configuration above. No harness command creates or
   changes provider settings. Preserve the capability/schema review privately.

```sh
node test/financial-oracle/cli.mjs seed --config "$SEED_CONFIG" --out "$WORK/seed-plan.json"
```

2. After reviewing all 42 steps, record `plan_sha256` in the configuration.
   Apply once. A retry uses the same config/journal and a new receipt path.

```sh
node test/financial-oracle/cli.mjs seed --config "$SEED_CONFIG" --journal "$WORK/seed-journal.json" --out "$WORK/seed-readback.json" --apply
node test/financial-oracle/cli.mjs reports --config "$SEED_CONFIG" --journal "$WORK/seed-journal.json" --out "$WORK/native-reports.json"
```

The 20 native requests are all nine R1 variants for January (`phase: month`) and
annual 2025 (`phase: year`), plus a February no-activity P&L
(`phase: empty-february`) and January cash-basis P&L (`phase: cash-basis`).
Use exact supported provider parameters. Never reuse accrual profit as expected
cash-basis profit. CashFlow must use its native account denominator and a
separately reviewed cash-account bridge. Reports are bounded single responses;
no QueryResponse pagination is invented for them. Large or unsupported report
shapes refuse. Parsed cells alone do not prove transport/storage completeness.

3. On the separately integrated test Brain, ingest with the existing command:

```sh
node brain.mjs ingest "$MANIFEST" --from quickbooks
```

At the pinned baseline this command imports records only. It does not fetch
R1 reports. Stop the live accuracy campaign until MAIN integrates and validates
QBO-REPORTS and the monetary-answer contract. MAIN must retain exact report
storage readback, generation/citation mappings, and outbox/index readiness.
There is no invented `brain search`, `brain seed`, or report-ingest CLI flag.

4. Create a private readiness receipt with `test_only: true`, `base_sha256`
   (hash of the HTTPS Brain origin), exact 40-hex `implementation_sha`,
   `outbox_pending: 0`, and `sources_complete: true`, backed by the observed
   integrated product receipts. This is a trusted MAIN attestation, not a
   health-ping substitute. `BRAIN_CONFIG` contains `test_brain: true`,
   `synthetic_only: true`, HTTPS `brain_base`, `implementation_sha`, fixed `model`,
   and `admin_key_file` pointing to the existing test Brain credential. The
   existing product file loader reads it; no key value enters arguments.

```sh
node test/financial-oracle/cli.mjs cases --out "$WORK/base-cases.json"
node test/financial-oracle/cli.mjs ask --config "$BRAIN_CONFIG" --readiness "$WORK/readiness.json" --cases "$WORK/base-cases.json" --out "$WORK/base-responses.json"
```

For G11, use the integrated harness to withhold the aging snapshot while keeping
nonempty retrieved records. G12 must reach the actual tax policy gate. A prompt
that merely says evidence is missing does not establish that test condition.
The captured file deliberately leaves `annotation` and `trace` null. MAIN must
bind the correct source-withholding phase and actual product decision traces
before scoring. Never manufacture a gate counter from an observed refusal.

5. Prepare the independent reviewed input described below, then score it:

```sh
node test/financial-oracle/cli.mjs evaluate --input "$WORK/base-reviewed.json" --out "$WORK/base-score.json"
```

Repeat cases/ask/evaluate with `--phase units`, `periods`, and `adversarial` on
the matching evidence phase. For each `expense-N`, use a separately empty
sandbox and isolated test source, or MAIN's independently reviewed restoration
protocol. The harness itself never restores, deletes, or mutates a seeded
purchase. `seed --phase expense-N` uses the same 21 templates with S12 increased
by N cents; `cases --phase expense-N` independently recomputes the expected
cash/profit decline. Record a separate config, plan, journal and report snapshot
for each phase. Never apply a second seed into the existing nonempty baseline.

Collect reviewed phase inputs into an object keyed by the 34 campaign phase IDs:

```sh
node test/financial-oracle/cli.mjs score-campaign --input "$WORK/reviewed-phases.json" --out "$WORK/campaign-score.json"
```

Expected runtime, estimates rather than measurements: offline tests about two
seconds; seed plus native report readback about 3-10 minutes per empty sandbox;
ingest/readiness about 5-20 minutes depending on outbox work; base 144 serial
answers about 25-75 minutes at 10-30 seconds each. The 583-answer campaign is
about 1.6-4.9 hours of model time, plus 30 separately prepared seed phases and
independent review. Each answer has a 90-second timeout and no automatic retry.
Provisioning disposable realms, field troubleshooting, and annotation review
are additional time. No live runtime was measured in this lane.

## Reviewed evaluator input

The evaluator accepts `{cases, responses, evidence, run}`. Its own case builder
provides the expected claim tuples from the ledger. Both CLI scoring commands replace
capture-supplied cases with the trusted generated phase denominator. Select the
matching `--phase` for the `evaluate` command; its default is the 144-case base. `ready` means
this observed input passed; `release_ready` is always false.

Each response keeps the original `{answer, citations}` object and a case ID.
The independent reviewer supplies an annotation bound to SHA-256 of
`JSON.stringify(response)`:

- `review`: `status: reviewed`, an opaque `reviewer_ref`, and
  `unmapped_semantics: false`. Review checks every assertion, including role,
  party, aging bucket, completeness, conditions and tax wording against the
  visible answer. The answering model cannot attest to its own correctness.
- `status`: `answered` or `refused`; `complete`, `qualifiers`, and exact claims.
  Refusals have the case's `refusal_reason` and a useful `next_step`.
- Each claim has `metric`, integer-string `minor`, `role`, exact `scope`,
  `unit` (`major`, `minor`, `thousand`), optional `party`/`aging_bucket`, and
  `[start,end)` character offsets covering its visible decimal amount.
- Each citation has `snapshot_id`, `content_hash`, `source_doc_ref`, `row_path`,
  `column_key`, and coefficient `1` or `-1`. Derived money must cite the exact
  additive terms; a transfer-net claim can cite both opposite bank legs.
- `trace` is separately bound to the response hash and contains the actual
  reached `gates` and positive `candidates` count from product/harness evidence.
  If the integrated product cannot expose this, the result is a harness error.

The evidence manifest is trusted input assembled from verified native bytes and
Brain readback. Each snapshot records `raw` JSON, hash, exact scope, source ref,
`current`, `authorized`, `complete`, and a reviewed `cells` mapping of raw JSON
pointer, column key, and supported metrics. The scorer verifies the bytes, cell,
source ref in the actual response citations, signed arithmetic, date/basis/
currency/entity/filter scope, and all monetary spans. Do not use answer-supplied
booleans as evidence of source access or completeness. Report completion is only
for the report scope, never proof all business activity was recorded.

Numerical token coverage is strict: exact scoped ISO dates and emitted citation
markers are the only automatic non-money exemptions. Spelled-out money and
unmapped prose require review and cannot silently pass. This does not claim a
universal natural-language theorem checker. Missing annotations, unsupported
precision/formatting, or inaccessible source bytes produce a failed receipt.
`response-fixtures.mjs` demonstrates the structure using invented raw sources;
it is never used to score a live response as if it were source evidence.

Receipts distinguish wrong money, wrong scope, wrong citation, missing claims,
unsupported refusal, refusal errors, and harness errors. One wrong monetary
claim fails regardless of average usefulness. A refusal requires its gate,
nonempty candidates, and a passing supported sibling. An all-refuse harness,
an all-answer harness, duplicate cases, or missing phases cannot pass.

## Remaining integration work

MAIN and an independent evidence reviewer must sign off the expected truth,
native report cell mapping, API capability receipts, source-withholding and
mutation phases, live citation/access checks, and the complete host/CI gates.
A10's 70 Books-rule branches and A11's tax-rule catalog belong to their product
lanes; this oracle does not claim to implement those rule engines. Additional
lifecycle, foreign-currency, payroll, reconciliation-history and original
12-question field artifacts remain separate program gates. The reported earlier
7/12 result is not reproduced or relabeled by this synthetic campaign.
