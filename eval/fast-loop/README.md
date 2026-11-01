# Synthetic money fast loop

This is the Day 1 development harness. It evaluates 12 base cases and 17 child
controls against the real `withLedgerAnswer`, classifier, SQLite reader and
composers, using every shipped D1 migration. It changes no product behavior.
The current product intentionally remains red on reproduced defects.

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
promoted. The opt-in red probe has five failing desired-behavior assertions
and five passing peers at the pinned product. The registered green suite also
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
No full-route, model tape, document, private corpus, 80-case, live improvement
or release claim is made. These files and the synthetic key are outside the
package publication allowlist.
