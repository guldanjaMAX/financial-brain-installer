# Synthetic money fast loop

Day 3 runs 19 permanent questions, 20 additional development cases and 10
reserved cases through the actual HTTP entry. The CLI defaults to the current
working tree's four ledger modules against baseline `34a8f832`. All 19 money
cases also run directly. The historical Batch 1 arm remains available explicitly.
After the required quiet-file wait, with a scratch HOME and
`BRAIN_NO_WRANGLER_LOGIN=1`, run:

```sh
node eval/fast-loop/day3-cli.mjs
node eval/fast-loop/day3-cli.mjs --candidate batch1
node --test test/fastloop-day3.test.mjs
```

The single bench command attempts all cases and six discriminating controls per
revision. Exit 0 requires complete execution and the headline comparison gate.
Tape misses remain invalid executions with attempted-call counts, and block
that gate. Existing SQL and model tapes are never replaced automatically. Product verdicts
remain explicit in `lane-evidence/day3-results.json` and `day3-table.md`; a false
`product_quality` gate is never a release pass. Timings separate HTTP warm replay,
direct migration setup and direct warm execution. HTTP replay includes compartment
creation but excludes the separate synthetic tape-authoring command.

Inputs have typed money, document, call, mail, calendar and status records.
Each has separate gold and an answerability verdict: answer, partial, scoped none
or honest refusal. The existing money scorer evaluates money figures, sources
and scope. A small evidence scorer uses the same verdict vocabulary for the new
domains and requires independently keyed facts, used citations and delivered
source spans. Unreviewed prose blocks quality credit. Controlled source omissions
in the recorded model replies test detection, rather than establish live recall.
Status questions read a dated synthetic document and disclose that a snapshot
cannot certify current runtime freshness. There is no operational status reader.

Reserved inputs and tapes live in separate files; their input digest is frozen
before comparison. No product tuning occurs in this bench. Money cases reuse the
tiny relational envelope; reserved non-money records use separate document IDs.
This is a 49-case synthetic bank, not an 80-case or private-quality claim.

`baseline-sources.json` holds all four baseline modules with per-module SHA-256
checks and a pinned inventory digest. `batch1-sources.json` retains the three
historical candidate modules, paired with the baseline reader. Six shared dependencies are checked against
`historical-shared-v1.json` in HTTP and direct historical arms. Four retain the
original baseline bytes; the reviewed D1 and kind modules supply the unchanged
tenant constant to the frozen reader. A shared dependency change requires a
separate compatibility review. Current-tree mode
loads all four current modules once before replay and selects the separate
`candidate-inventory-v1.json` tape arm. Its 27 explicit inventory occurrences
across 14 cases include transactional batches. Each change binds the historical
entry hash, the exact reviewed SQL and a null review projection supported by the
frozen synthetic inputs. Six explicitly listed case streams also carry the
current balance query or supported ledger route in place of historical document
fallback. Each replacement binds its prior case hash and captured source hashes.
Historical arms and independent expected facts stay
unchanged. Blocked control peers remain in the receipt and prevent the headline
gate from passing. Both HTTP and direct executed
source hashes must match the selected bytes. The baseline HTTP arm also restores
the exact pinned money-veto module from `baseline-http-source.json`; its override
accepts only that one SHA-256, and arbitrary veto edits remain refused. Runtime replay requires no Git or
historical object access. The working product tree stays unchanged. The explicit local authoring tools
`freeze-batch1-sources.mjs` and `build-day3-fixtures.mjs` export reviewed local Git
objects and create synthetic tapes. Ordinary replay never invokes either tool,
recaptures a miss, or consumes gold in the child.

Day 2 also drives the unchanged default Worker HTTP entry. After the same
quiet-file wait and scratch environment described below, run:

```sh
node eval/fast-loop/money-cli.mjs --routes
node --test test/fastloop-money.test.mjs test/fastloop-route.test.mjs
```

The runner prints direct-ledger and HTTP verdicts side by side for all 12 base
cases and 17 controls. Existing monetary failures still make it exit 1. Empty
synthetic document retrieval is labeled explicitly; it earns no new supported
fact or forecast credit. HTTP responses include the actual authorization,
retrieval, prompt, draft/check, citation and final gate path. All money cases
and six document cases have byte-identical bodies with tracing enabled and
disabled, under the same frozen runtime dependencies.

`route-replay.mjs` runs the actual Worker modules in the permission-restricted
child. A VM-local frozen `Date`, fixed timing clock and synthetic request ID
govern every relative-time consumer without editing product code or the host
clock. Authentication is real HTTP header validation using runtime-built
synthetic authority. Model generation is injected at `callLLM`; real spend
accounting and provider serialization are outside this seam and are not tested
or silently simulated. Replay neither opens services nor writes product data.

The checked-in synthetic tapes bind exact SQL, typed binds, methods, batch
grouping, principal and ordered occurrence. Model tapes bind every `callLLM`
option except its callback-bearing local timing object, including the exact
system/messages, model, label, timeout, stage and output ceilings. Embedding
and Vectorize requests have their own exact ordered tape. Snapshot identity
also binds the synthetic source rows. Missing calls, extra calls and mismatches
set sticky failures checked after the product returns and scheduled tasks drain.
Unknown inputs never receive an empty default or a provider fallback.

Source-span traces map actual prompt text to code-point offsets, source hashes,
revisions and individual composition contributors. Ambiguous origins are marked;
cropped or missing negations do not inherit whole-document coverage. The seven
earlier retrieval arms run the real store and assert returned rows, identities,
degradation fields, SQL entry and vector retry counts directly. They are synthetic
dependency injections, not evidence of live recall or bounded capture work.

`node eval/fast-loop/route-probe.mjs` is a passing control. Each of `sql`, `bind`,
`model`, `model-check`, `model-prompt`, `model-name` and `model-messages` as its
single argument must exit 1 with an attempted-call witness. Tests also corrupt
returned evidence and remove delivered source contributors.

`build-route-fixtures.mjs` is an explicit offline fixture-authoring tool. It
executes real SQL on the complete tiny migrated synthetic database and uses
declared synthetic model outputs. It never captures a live service and is never
called by replay to repair a miss. Review regenerated tapes as fixture changes.
These results are development evidence, not a release or private-quality gate.

This is the Day 1 development harness. It evaluates 12 base cases and 17 child
controls against the real `withLedgerAnswer`, classifier, SQLite reader and
composers, using every shipped D1 migration. Batch 1 repairs typed repayment
locators, ordinary-expense ranking, explicit spending synonyms and posted scope.
Unknown account types and provider classification resets remain held for A/I1.

Batch 2 has a separate 20-case synthetic slice and boundary/mutation suite at
`worker/test/fastloop-batch2.test.mjs`. It covers current balance aliases with
separate cash, liability and other/unknown groups; exact-vendor trailing months
and days; payment lookup around an explicit date; monthly recurrence wording;
combined posted inflows; and a forecast limitation with dated observations.
The existing recurrence detector is unchanged. A detected charge is not a
confirmed subscription. An inflow total is not established income, and
transfer-related credits remain included and flagged without assumed ownership.

The early-month development slice runs with
`node eval/fast-loop/early-month-bench.mjs`. It compares the pinned `129c78f5`
product modules with the current sources using the same replay harness. The
29 original cases, 20 Batch 2 cases and 19 added development cases must have
zero new wrong figures or unsupported claims. Existing selected-period answers
must remain identical. The added key checks every displayed amount, factual
line, source identity, repayment and coverage qualification.

Undated expense/spend requests show the owner-calendar month-to-date result,
then the previous complete calendar month during the first three days or when
no posted expense rows were found. Explicit periods keep their original
behavior. Missing previous-month coverage or a failed read stays visible and
cannot become a zero. The focused `worker/test/ledger-early-month.test.mjs`
also checks leap years, year turns and restoring mutants. These are synthetic
development checks, never release evidence.

The vendor-family development slice runs with
`node eval/fast-loop/vendor-family-bench.mjs` after the same quiet-file wait and
scratch environment. It compares the pinned `cc679bb0` product modules with
current sources over 29 original, 20 Batch 2, 22 early-month and 15 new family
cases. New wrong figures and unsupported claims must both stay zero. Prior
Batch 2 and early-month responses must stay identical. The separate family key
reviews every displayed amount and factual line, payee spelling, row membership,
citation, ambiguity, refund, owned movement and coverage qualification.
`worker/test/ledger-vendor-selector.test.mjs` runs a restoring mutant against
that same key with exact-payee and bank-text green controls. These added cases
are synthetic development material only.

Trailing calendar months preserve the owner's day of month with month-end
clamping. At the frozen October 31 clock, three months means July 31 through
October 31 inclusive, while 90 days means August 3 through October 31 inclusive.
An explicit near-date lookup prints the inclusive date minus/plus seven-day
window. Multiple matching deposits produce an ambiguity rather than a unique
payment confirmation. Forecast requests produce no future figures. Their
current observations are useful partial answers, never successful forecasts.

Run `node --test worker/test/fastloop-batch2.test.mjs` after the same quiet-file
wait and scratch environment described below. Each D5–D10 repair has its own
positive cases, refusal peers and restoring mutant. The replay's optional
`snapshotFor` supplies only synthetic evidence; the key stays outside the child.
Every observation binds the complete supplied envelope in its input digest.

From the repository root, first create `lane-evidence/home-fastloop` and
`lane-evidence/tmp`. Before each Node or npm command, run the required host
quiet-file wait. Set `HOME` to that scratch home and
`BRAIN_NO_WRANGLER_LOGIN=1`. Then use:

```sh
npm run fastloop:money -- --out lane-evidence/baseline.json
npm run fastloop:money -- --out lane-evidence/candidate.json
npm run fastloop:money -- --baseline lane-evidence/baseline.json --candidate lane-evidence/candidate.json
node --test test/fastloop-money.test.mjs
node --test test/fastloop-money-red.mjs
```

The direct equivalent of the npm entry is `node eval/fast-loop/money-cli.mjs`.
A run exits 1 for wrong monetary answers or invalid executions. A comparison
exits 1 for a regression, and 0 when no new regression exists. An unchanged
baseline passes that regression check but has no improvement and cannot be
promoted. The original opt-in probe has eight passing assertions and two
storage-prerequisite failures after Batch 1 (five pass and five fail at the
Day 1 pin). The registered green suite also
runs that probe and verifies its counted outcome; nothing is skipped or marked
todo. The test graph registers the green suite in both required command lists.
`test/test-chain-complete.test.mjs` proves registration, including untracked tests.

Inputs and expected keys are separate files under
`test/fixtures/fastloop-money/`. The key uses independently authored row
membership and integer arithmetic from `money-oracle.mjs`, with no product
classifier or sum helper. Ordinary expenses are 61,000 cents, gross outgoing
money is 101,000 cents, and the whole owned repayment is 40,000 cents. The
outside payment has that same amount and remains an expense. An unknown-type
account, a provider import reset and an account-number memo each have their own
arm. No principal or interest split is inferred. The final plan's trailing
three-month rule is recorded, although that case belongs to a later slice.

The candidate child receives question, scope, clock and the complete tiny
synthetic relational envelope. It receives no key. Outputs are serialized and
hashed before scoring. Input, migration, product module, harness, runtime and
scorer identities travel with each receipt. Comparison requires the same
inputs, case set, keys, adapter and runtime. Changed product sources are recorded
separately. Missing cases or stale scorer identities fail closed.

The trusted launcher passes an allowlisted environment. Node permissions deny
external filesystem reads, filesystem writes and child processes. A transport
preload blocks sockets and fetch before contact. Product modules execute in a
separate VM context with a restricted relative-module loader and denied
network/process globals. This compartment is for reviewed local code, not a
security boundary for hostile JavaScript. Capability probes verify denied
fetch, process access, subprocess access, builtin imports and database writes;
a separate probe verifies the transport preload exits before fetch. No native
credential service is invoked, even by a probe.

Fixture loading and the import-reset rehearsal write only the in-memory
database before answering. Replay switches SQLite to `query_only` and compares
`total_changes()` before and after the answer. Inventory and facts keep the
real atomic D1 batch using SQLite savepoints. The three reviewed SQL templates
have exact byte digests; method, tenant, mapping and interval admission are
checked separately. Unknown SQL/binds or forbidden effects set a sticky fatal
flag that product exception handling cannot clear. They are harness errors,
never honest refusals. A later SQL edit needs an explicit adapter review.

The trace records the classifier actually called inside `withLedgerAnswer`,
route, SQL, typed binds, batch boundaries, rows, reader exclusions, returned
semantic exclusions, and every structured cent field. Semantic exclusion
membership that the product does not expose is left unknown. The trace never
pretends that a reader-unreached row was filtered by SQL.

Scoring checks structured money, every displayed currency amount, citation
amounts, source identities, periods, row order, ownership and required refusal.
Unknown renderer prose is held as an unsupported claim. A one-cent display
error, a new wrong value on an already-red case, an omitted outside payment,
missing citation, false complete zero, unsupported extra claim and blanket
refusal are discriminating controls with green peers. Blanket refusal cannot
earn a correct verdict. Per-case fact losses also fail comparison.
Fact utility uses the frozen key's required obligations with equal weights;
renderer and safety checks do not increase that denominator or reward refusal.

Unsupported wording records `documents_unexecuted`. The empty fallback marker
never counts as a document answer or as a tested forecast refusal. Results are
ledger-attempt verdicts, not complete HTTP or model-backed answer verdicts.
For an exact baseline replay, `replay({sourceOverrides})` accepts source text for
only the four reviewed ledger product modules. Restore those modules from the
pinned Git commit; their executed bytes are hashed in the receipt. Both arms
use the current identical harness and scorer. No expected total or membership
changed: key v2 adds the separate repayment and original gross ranking for M08.
The scorer checks the ordinary lead, the separately labeled gross view, and the
whole repayment. `worker/test/fastloop-batch1.test.mjs` restores each defect
individually and reruns its positive contract; independent oracle/comparison
mutants additionally prove each repair can fail the same fast-loop gate.

No full-route, model tape, document, private corpus, 80-case, live improvement
or release claim is made. These files and the synthetic key are outside the
package publication allowlist.
