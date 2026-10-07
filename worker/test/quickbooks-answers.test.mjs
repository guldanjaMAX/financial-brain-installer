import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createProductFixture } from "./product-contract-fixture.mjs";
import { syncQuickBooksOnline } from "../../connectors/quickbooks-online.mjs";
import { normalizeProviderResult, deliverProviderDocuments } from "../../connectors/provider-runtime.mjs";
import { providerEnvelope, renderRecord } from "../../connectors/provider-sync.mjs";
import { splitOversized } from "../../ingest/envelope-batching.mjs";
import { SNAPSHOT, CHANGED, FIXTURES } from "../../test/fixtures/quickbooks-records.mjs";
import { quickBooksBalanceAnswer } from "../src/lib/quickbooks-balance.js";
import { quickBooksOpenItemsAnswer, quickBooksOpenItemsRequest } from "../src/lib/quickbooks-open-items.js";

const ADMIN = { "X-Admin-Key": "fixture-admin-key" };
const NOW = Date.parse(SNAPSHOT) + 60_000;
async function collect(entity, rows, snapshotAt = SNAPSHOT) {
  let reads = 0;
  const result = await syncQuickBooksOnline({
    realmId: "synthetic-company", accessToken: "synthetic-fixture", entities: [entity], snapshotAt, now: () => NOW,
    fetchImpl: async () => { reads++; return new Response(JSON.stringify({ QueryResponse: { [entity]: rows } })); },
  });
  assert.equal(reads, 1);
  return result;
}
async function ingest(fixture, docs) {
  const response = await fixture.post("/api/admin/brain/ingest/batch", { docs }, ADMIN);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.results.length, docs.length);
  return body;
}
async function register(fixture, source, kind = "quickbooks") {
  fixture.raw("INSERT INTO sources(name,kind,status,created_at) VALUES (?,?,'ready',?)", source, kind, SNAPSHOT);
}

test("real batch delivery replaces old raw records in place and keeps lineage", async () => {
  const fixture = await createProductFixture();
  try {
    await register(fixture, "books_secondary");
    for (const [kind, row] of FIXTURES) {
      const id = `${kind.toLowerCase()}:${row.Id}`;
      const old = providerEnvelope("quickbooks", id, { title: `${kind}: ${row.DocNumber || row.Id}`, content: renderRecord(`QuickBooks ${kind}`, row), occurredAt: CHANGED });
      const result = await collect(kind, [row]);
      const normalized = normalizeProviderResult("books_secondary", result);
      const legacy = normalizeProviderResult("books_secondary", { ...result, documents: [old] }).documents;
      assert.equal((await ingest(fixture, legacy)).results[0].status, "created");
      let sends = 0;
      const sendBatch = async ({ docs }) => { sends++; return ingest(fixture, docs); };
      const changed = await deliverProviderDocuments(normalized.documents, { sendBatch });
      assert.equal(sends, 1);
      assert.equal(changed.updated, 1);
      assert.equal(changed.created, 0);
      const repeat = await deliverProviderDocuments(normalized.documents, { sendBatch });
      assert.equal(sends, 2);
      assert.equal(repeat.unchanged, 1);
      assert.equal(fixture.first("SELECT count(*) AS n FROM documents WHERE source_id=?", id).n, 1);
      const stored = fixture.first("SELECT * FROM documents WHERE source_id=?", id);
      assert.equal(stored.date_source, normalized.documents[0].date_source);
      assert.equal(stored.document_date, Date.parse(normalized.documents[0].occurred_at));
      assert.deepEqual(JSON.parse(stored.meta).evidence_lineage.root_ids, [`books_secondary:${id}`]);
    }
    assert.equal(fixture.first("SELECT count(*) AS n FROM documents").n, 15);
    const invoice = FIXTURES.find(([kind]) => kind === "Invoice")[1];
    const paid = normalizeProviderResult("books_secondary", await collect("Invoice", [{ ...invoice, Balance: 0 }], "2026-10-07T12:01:00.000Z"));
    assert.equal((await ingest(fixture, paid.documents)).results[0].status, "updated");
    const stored = fixture.first("SELECT text FROM chunks WHERE doc_uid=? ORDER BY chunk_ix LIMIT 1", `books_secondary:invoice:${invoice.Id}`);
    assert.match(stored.text, /open balance USD 0\.00 \(paid\)/);
    assert.equal(fixture.first("SELECT count(*) AS n FROM documents").n, 15);
  } finally { fixture.close(); }
});

// This is a boundary probe, not a passing claim of migration completeness.
// Ordinary upsert above is the green control; a split legacy family requires
// an exact-family migration that this provider runner does not authorize.
test("legacy split families expose the existing migration boundary", async () => {
  const fixture = await createProductFixture();
  try {
    await register(fixture, "quickbooks");
    const row = FIXTURES.find(([kind]) => kind === "Invoice")[1];
    const result = await collect("Invoice", [row]);
    const old = providerEnvelope("quickbooks", result.documents[0].source_id, {
      title: "Invoice: 1016", content: "Synthetic legacy detail ".repeat(19000), occurredAt: CHANGED,
    });
    const parts = splitOversized(old);
    assert.ok(parts.length > 1, "actually reached a split legacy family");
    for (const part of parts) await ingest(fixture, [part]);
    await ingest(fixture, result.documents);
    assert.equal(fixture.first("SELECT count(*) AS n FROM documents").n, parts.length + 1);
    assert.deepEqual(result.deletions, []);
  } finally { fixture.close(); }
});

async function answerCase(t, { mutate = (doc) => doc, source = "quickbooks", kind = "quickbooks", entity = "Account", answer, rows = null, related = [], hybrid = false, question = "What are the current QuickBooks bank account balances?", limit = 10, expectedDrafts, expectedVerifiers = 1, verify = true, balanceOnly = false, verdict = {} } = {}) {
  t.mock.method(Date, "now", () => NOW);
  let verifierCalls = 0;
  let draftCalls = 0;
  let draft;
  const fixture = await createProductFixture({ env: { AI: { async run(model, input) {
    if (model.includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
    if (String(input.messages?.[0]?.content).includes("verify a proposed answer")) {
      verifierCalls++;
      return { response: { supported: verify, complete: true, evidence: [...new Set([...draft.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])))], reason: verify ? "injected approval" : "injected rejection", ...verdict } };
    }
    draftCalls++;
    draft = typeof answer === "function" ? answer(input.messages.at(-1).content, draftCalls)
      : answer || "Checking currently has a balance of USD 1,201.00 as of 2026-10-07 [1].";
    return { response: draft };
  } } } });
  try {
    await register(fixture, source, kind);
    const result = await collect(entity, rows || [{ ...FIXTURES[0][1], Active: undefined }]);
    const docs = normalizeProviderResult(source, result).documents.map(mutate);
    await ingest(fixture, docs);
    for (const [relatedEntity, relatedRows] of related) {
      await ingest(fixture, normalizeProviderResult(source, await collect(relatedEntity, relatedRows)).documents);
    }
    if (hybrid) {
      fixture.env.VECTORIZE.query = async () => {
        fixture.seen.vectorQueries.push("synthetic matched chunks");
        return { matches: fixture.rows("SELECT chunk_uid AS id FROM chunks ORDER BY chunk_uid") };
      };
    }
    // The adversarial draft tests must still reach generation and its gates.
    // A compound request requires explanation beyond deterministic balances;
    // keep every prior wrong-money/state assertion on that normal route.
    const q = balanceOnly ? question : `${question} Explain what the evidence does and does not establish.`;
    const response = await fixture.post("/api/rag/think", { q, limit }, ADMIN);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.results.length, "retrieval reached actual stored evidence");
    if (hybrid) assert.ok(fixture.seen.vectorQueries.length, "real hybrid search reached the injected semantic boundary");
    assert.equal(verifierCalls, expectedVerifiers, "the draft reached the expected evidence-verifier decision point");
    if (expectedVerifiers) assert.equal(body.evidence_gate?.error, undefined, "a thrown gate is not a valid refusal");
    if (expectedDrafts !== undefined) assert.equal(draftCalls, expectedDrafts, "generation attempts are bounded");
    return body;
  } finally { fixture.close(); }
}

for (const source of ["quickbooks", "books_secondary"]) {
  test(`balance read through real storage and think is answerable for ${source}`, async (t) => {
    const body = await answerCase(t, { source, balanceOnly: true, expectedDrafts: 0, expectedVerifiers: 0 });
    assert.equal(body.evidence_gate.supported, true, body.evidence_gate.reason);
    assert.match(body.answer, /1,201\.00/);
    assert.equal(body.citations[0].date_source, "quickbooks:balance_snapshot");
  });
}
for (const [label, options] of [
  ["wrong provider", { kind: "local_folder" }],
  ["unmarked snapshot", { mutate: (doc) => ({ ...doc, date_source: "quickbooks:provider_timestamp" }) }],
  ["unreliable date", { mutate: (doc) => ({ ...doc, date_reliable: false }) }],
  ["future date", { mutate: (doc) => ({ ...doc, occurred_at: "2027-01-01T00:00:00.000Z" }) }],
  ["unreliable text", { mutate: (doc) => ({ ...doc, text_source: "ocr", text_reliable: false }) }],
  ["wrong account", { answer: "Savings currently has a balance of USD 1,201.00 as of 2026-10-07 [1]." }],
  ["wrong balance", { answer: "Checking currently has a balance of USD 1,999.00 as of 2026-10-07 [1]." }],
  ["active bookkeeping flag with wrong balance", { rows: [FIXTURES[0][1]], answer: "Checking currently has a balance of USD 1,999.00 as of 2026-10-07 [1]." }],
  ["wrong date", { answer: "Checking currently has a balance of USD 1,201.00 as of 2026-10-06 [1]." }],
  ["missing as-of", { answer: "Checking currently has a balance of USD 1,201.00 [1]." }],
  ["implicit current balance without as-of", { answer: "Checking has a balance of USD 1,201.00 [1]." }],
  ["mixed relationship", { answer: "Checking currently has a balance of USD 1,201.00 as of 2026-10-07 and the client relationship remains active [1]." }],
  ["recurring income borrowed from a balance", { answer: "Checking currently receives USD 1,201.00 every month as of 2026-10-07 [1]." }],
]) {
  test(`generated current balance refuses ${label} after affirmative verifier`, async (t) => {
    const body = await answerCase(t, options);
    assert.equal(body.evidence_gate.supported, false);
    assert.equal(body.citations.length, 0);
  });
}

for (const [entity, subject, amount] of [["Customer", "Customer One", "75.00"], ["Vendor", "Vendor One", "75.00"], ["Invoice", "Customer One", "75.00"], ["Bill", "Vendor One", "25.00"], ["CreditMemo", "Customer One", "25.00"]]) {
  test(`${entity} current balance no longer earns an LLM exception`, async (t) => {
    const row = FIXTURES.find(([kind]) => kind === entity)[1];
    const body = await answerCase(t, { entity, rows: [row], question: `What is the current QuickBooks balance for ${subject}?`,
      answer: `${subject} currently has ${entity === "CreditMemo" ? "remaining credit" : "an open balance"} of USD ${amount} as of 2026-10-07 [1].` });
    assert.equal(body.evidence_gate.supported, false, body.evidence_gate.reason);
    assert.equal(body.citations.length, 0);
  });
}

// Independent review R1-R3: every arm reaches real retrieval and an
// affirmative verifier. The exact balance controls above must stay green.
for (const [label, entity, answer] of [
  ["added customer relationship", "Customer", "Customer One currently has an open balance of USD 75.00 as of 2026-10-07 and remains a customer [1]."],
  ["added ongoing service", "Account", "Checking currently has a balance of USD 1,201.00 as of 2026-10-07 and the service is ongoing [1]."],
  ["negative sign before dollar", "Account", "Checking currently has a balance of -$1,201.00 as of 2026-10-07 [1]."],
  ["accounting negative", "Account", "Checking currently has a balance of ($1,201.00) as of 2026-10-07 [1]."],
  ["foreign dollar prefix", "Account", "Checking currently has a balance of CAD $1,201.00 as of 2026-10-07 [1]."],
  ["amount multiplier", "Account", "Checking currently has a balance of USD 1,201.00 million as of 2026-10-07 [1]."],
  ["coordinated unknown account", "Account", "Checking and Imaginary currently have balances of USD 1,201.00 each as of 2026-10-07 [1]."],
  ["wrong invoice identity", "Invoice", "Invoice 9999 for Customer One currently has an open balance of USD 75.00 as of 2026-10-07 [1]."],
]) {
  test(`review R1-R3 refuses ${label}`, async (t) => {
    const row = { ...FIXTURES.find(([kind]) => kind === entity)[1], Active: undefined };
    const body = await answerCase(t, { entity, rows: [row], answer });
    assert.equal(body.results.length, 1, "only the claimed source record reached retrieval");
    assert.equal(body.evidence_gate.supported, false, body.evidence_gate.reason);
    assert.equal(body.citations.length, 0);
  });
}

for (const [label, answer] of [
  ["uncertainty appended to a wrong amount", "Checking currently has a balance of USD 9,999.00 as of 2026-10-07, but the service is unknown [1]."],
  ["approximation mark", "Checking currently has a balance of USD ~1,201.00 as of 2026-10-07 [1]."],
  ["struck negative sign", "Checking currently has a balance of USD ~~-~~1,201.00 as of 2026-10-07 [1]."],
  ["unbound leading account", "Imaginary and Checking currently have balances of USD 1,201.00 each as of 2026-10-07 [1]."],
  ["extra amount with no currency", "Checking currently has a balance of USD 1,201.00 and 500.00 as of 2026-10-07 [1]."],
  ["malformed thousands grouping", "Checking currently has a balance of USD 12,01.00 as of 2026-10-07 [1]."],
  ["additional timing clause", "Checking currently has a balance of USD 1,201.00 every month as of 2026-10-07 [1]."],
  ["asset balance described as credit", "Checking currently has remaining credit of USD 1,201.00 as of 2026-10-07 [1]."],
  ["compact negative dollar without balance word", "As of 2026-10-07, Checking: -$1,201.00 [1]."],
  ["table integer without balance word", "As of 2026-10-07:\n| Checking | 9999 | [1] |"],
  ["bare integer without balance word", "Checking has 9999 as of 2026-10-07 [1]."],
  ["incorrect account type", "Checking (Credit Card): balance USD 1,201.00 as of 2026-10-07 [1]."],
  ["state clause inside account type", "Checking (Bank and service is ongoing): balance USD 1,201.00 as of 2026-10-07 [1]."],
]) {
  test(`entire balance claim refuses ${label}`, async (t) => {
    const body = await answerCase(t, { answer });
    assert.equal(body.evidence_gate.supported, false, body.evidence_gate.reason);
    assert.equal(body.citations.length, 0);
  });
}

test("dollar notation in an unused model draft cannot change rendered currency", async (t) => {
  const body = await answerCase(t, { balanceOnly: true, expectedDrafts: 0, expectedVerifiers: 0, answer: "Checking currently has a balance of $1,201.00 as of 2026-10-07 [1]." });
  assert.equal(body.evidence_gate.supported, true, body.evidence_gate.reason);
  assert.equal(body.citations.length, 1);
});

for (const [entity, subject, balance] of [
  ["Invoice", "Invoice 1016 for Customer One", "an open balance of USD 75.00"],
  ["Bill", "Bill 1016 from Vendor One", "an open balance of USD 25.00"],
  ["CreditMemo", "Credit memo 1016 for Customer One", "remaining credit of USD 25.00"],
]) {
  test(`explicit ${entity} identity must match the balance record`, async (t) => {
    const row = FIXTURES.find(([kind]) => kind === entity)[1];
    const claim = `${subject} currently has ${balance} as of 2026-10-07 [1].`;
    const control = await answerCase(t, { entity, rows: [row], question: "What balance was recorded on 2026-10-07?", answer: claim.replace("currently ", "") });
    assert.equal(control.evidence_gate.supported, true, control.evidence_gate.reason);
    const wrong = await answerCase(t, { entity, rows: [row], answer: claim.replace("1016", "9999") });
    assert.equal(wrong.evidence_gate.supported, false);
    assert.equal(wrong.citations.length, 0);
  });
}

test("older snapshot cannot be used when a newer direct balance was retrieved", async (t) => {
  const row = { ...FIXTURES[0][1], Active: undefined };
  const body = await answerCase(t, { rows: [row, { ...row, Id: "older-account" }],
    mutate: (doc) => doc.source_id.endsWith("older-account") ? { ...doc,
      occurred_at: "2026-10-06T12:00:00.000Z", content: doc.content.replaceAll(SNAPSHOT, "2026-10-06T12:00:00.000Z") } : doc,
    answer: "Checking currently has a balance of USD 1,201.00 as of 2026-10-06 [2]." });
  assert.equal(body.results.length, 2);
  assert.equal(body.evidence_gate.supported, false);
  assert.match(body.evidence_gate.reason, /older evidence/);
});

const ACCOUNT_ROWS = [
  { ...FIXTURES[0][1], Id: "bank-one", Name: "Operating", Active: undefined, CurrentBalance: 1201 },
  { ...FIXTURES[0][1], Id: "bank-two", Name: "Reserve", Active: undefined, CurrentBalance: 500 },
  { ...FIXTURES[0][1], Id: "card-one", Name: "Company Card", Active: undefined, AccountType: "Credit Card", CurrentBalance: -75.25 },
];
const MULTI_ANSWER = "As of 2026-10-07, Operating has a balance of USD 1,201.00 [1], Reserve has a balance of USD 500.00 [2], and Company Card owes USD 75.25 [3].";
const BALANCE_QUESTION = "What bank and credit card accounts are in QuickBooks, and what are their current balances?";
const deterministicCase = (t, options = {}) => answerCase(t, {
  rows: ACCOUNT_ROWS, question: BALANCE_QUESTION, balanceOnly: true,
  expectedDrafts: 0, expectedVerifiers: 0, ...options,
});

test("deterministic balances answer three accounts without generation or verification calls", async (t) => {
  const body = await deterministicCase(t);
  assert.equal(body.results.length, 3);
  assert.equal(body.evidence_gate.method, "quickbooks_observed_balances");
  assert.equal(body.evidence_gate.supported, true, body.evidence_gate.reason);
  assert.equal(body.evidence_gate.complete, true, "the missing inventory is explicitly disclosed");
  assert.equal(body.citations.length, 3);
  assert.match(body.answer, /Operating \(Bank\): balance USD 1,201\.00 as of 2026-10-07 \[\d+\]/);
  assert.match(body.answer, /Reserve \(Bank\): balance USD 500\.00 as of 2026-10-07 \[\d+\]/);
  assert.match(body.answer, /Company Card \(Credit Card\): owes USD 75\.25 as of 2026-10-07 \[\d+\]/);
  assert.match(body.answer, /only accounts found.*not a complete/i);
  assert.match(body.answer, /Heads up:/);
  assert.ok(body.gaps.length, "retrieval gaps remain available");
  assert.equal(body.model, undefined);
  for (const line of body.answer.split("\n").filter((value) => /\[\d+\]/.test(value))) {
    const n = Number(/\[(\d+)\]/.exec(line)[1]);
    assert.ok(body.citations.some((citation) => citation.n === n));
    assert.ok(body.results[n - 1].snippet.includes(line.match(/^(.*?) \(/)[1]), "citation binds its own account");
  }
});

test("deterministic bank and card scope excludes expense accounts and handles signed and zero balances", async (t) => {
  const rows = [...ACCOUNT_ROWS.map((row) => row.Name === "Operating" ? { ...row, CurrentBalance: -0.25 } : row),
    { ...ACCOUNT_ROWS[2], Id: "card-zero", Name: "Travel Card", CurrentBalance: 0 },
    { ...ACCOUNT_ROWS[0], Id: "expense-one", Name: "Office Expense", AccountType: "Expense", CurrentBalance: 42 },
  ];
  const body = await deterministicCase(t, { rows });
  assert.equal(body.results.length, 5);
  assert.equal(body.citations.length, 4);
  assert.match(body.answer, /Operating \(Bank\): balance USD -0\.25/);
  assert.match(body.answer, /Travel Card \(Credit Card\): balance USD 0\.00/);
  assert.doesNotMatch(body.answer, /Office Expense|Travel Card.*owes/);
});

test("deterministic balances support a renamed provider and an exact named account", async (t) => {
  const body = await deterministicCase(t, { source: "books_secondary", question: "What is the current balance of Reserve in QuickBooks?" });
  assert.equal(body.results.length, 3);
  assert.equal(body.evidence_gate.method, "quickbooks_observed_balances");
  assert.equal(body.citations.length, 1);
  assert.match(body.answer, /Reserve \(Bank\): balance USD 500\.00/);
  assert.doesNotMatch(body.answer, /Operating|Company Card/);
});

test("deterministic balances inspect a full retrieval window but cite only numbered accounts", async (t) => {
  const rows = [...ACCOUNT_ROWS, ...Array.from({ length: 15 }, (_, i) => ({
    ...ACCOUNT_ROWS[0], Id: `extra-${i}`, Name: `Extra Bank ${i}`, CurrentBalance: 20 + i,
  }))];
  const body = await deterministicCase(t, { rows });
  assert.equal(body.results.length, 12, "public candidates remain bounded to the numbered citation window");
  assert.equal(body.citations.length, 12);
  assert.equal(body.evidence_gate.supported, true, body.evidence_gate.reason);
  assert.ok(body.citations.every((citation) => citation.n <= body.results.length));
  assert.match(body.answer, /not a complete QuickBooks inventory/);
});

test("an unrelated historical expense account does not cancel observed bank and card balances", async (t) => {
  const rows = [...ACCOUNT_ROWS, { ...ACCOUNT_ROWS[0], Id: "expense-old", Name: "Office Expense",
    AccountType: "Expense", CurrentBalance: undefined }];
  const body = await deterministicCase(t, { rows });
  assert.equal(body.results.length, 4);
  assert.equal(body.citations.length, 3);
  assert.equal(body.evidence_gate.supported, true, body.evidence_gate.reason);
  assert.doesNotMatch(body.answer, /Office Expense/);
});

for (const [label, options] of [
  ["spending intent", { question: "How much did we spend with Operating?" }],
  ["compound balance and relationship request", { question: "What are the current QuickBooks bank account balances, and is the service ongoing?" }],
  ["historical request", { question: "What were the bank balances last year?" }],
  ["unknown named account", { question: "What is the current balance of Imaginary in QuickBooks?" }],
  ["unbound extra named account", { question: "What is the current balance of Operating and Imaginary in QuickBooks?" }],
  ["non-QuickBooks provider", { kind: "local_folder" }],
  ["missing balance", { rows: ACCOUNT_ROWS.map((row) => row.Name === "Reserve" ? { ...row, CurrentBalance: undefined } : row) }],
  ["unspecified currency", { rows: ACCOUNT_ROWS.map((row) => ({ ...row, CurrencyRef: undefined })) }],
  ["duplicate account names", { rows: [...ACCOUNT_ROWS, { ...ACCOUNT_ROWS[0], Id: "ambiguous", CurrentBalance: 1202 }] }],
  ["mixed observation times", { mutate: (doc) => doc.source_id.endsWith("bank-one") ? { ...doc,
    occurred_at: "2026-10-07T11:59:00.000Z", content: doc.content.replaceAll(SNAPSHOT, "2026-10-07T11:59:00.000Z") } : doc }],
  ["stale record beside fresh records", { mutate: (doc) => doc.source_id.endsWith("bank-one") ? { ...doc,
    occurred_at: CHANGED, content: doc.content.replaceAll(SNAPSHOT, CHANGED) } : doc }],
  ["stale-only records", { mutate: (doc) => ({ ...doc, occurred_at: CHANGED, content: doc.content.replaceAll(SNAPSHOT, CHANGED) }) }],
  ["future observations", { mutate: (doc) => ({ ...doc, occurred_at: "2027-01-01T00:00:00.000Z", content: doc.content.replaceAll(SNAPSHOT, "2027-01-01T00:00:00.000Z") }) }],
  ["unmarked snapshot", { mutate: (doc) => ({ ...doc, date_source: "quickbooks:provider_timestamp" }) }],
  ["unreliable text", { mutate: (doc) => ({ ...doc, text_source: "ocr", text_reliable: false }) }],
  ["unreliable date", { mutate: (doc) => ({ ...doc, date_reliable: false }) }],
  ["mismatched observation date", { mutate: (doc) => ({ ...doc, content: doc.content.replaceAll(SNAPSHOT, "2026-10-06T12:00:00.000Z") }) }],
  ["amount multiplier in record opening", { mutate: (doc) => ({ ...doc, content: doc.content.replace("USD 500.00 as of", "USD 500.00 million as of") }) }],
  ["inconsistent card debt explanation", { mutate: (doc) => ({ ...doc, content: doc.content.replace("owes USD 75.25", "owes USD 175.25") }) }],
]) {
  test(`deterministic balance admission falls back for ${label}`, async (t) => {
    const body = await deterministicCase(t, { ...options, expectedDrafts: 1, expectedVerifiers: 0,
      answer: "The documents do not answer the question." });
    assert.ok(body.results.length > 0, "the admission decision had retrieved evidence");
    assert.notEqual(body.evidence_gate.method, "quickbooks_observed_balances");
    assert.equal(body.evidence_gate.supported, false);
    assert.equal(body.citations.length, 0);
  });
}

test("deterministic admission binds source identity, lineage and the whole retrieved window", () => {
  const doc = { n: 1, source: "quickbooks", source_kind: "quickbooks", ref: "account:one", ts: SNAPSHOT,
    date_reliable: true, date_source: "quickbooks:balance_snapshot", text_source: "native", text_reliable: true,
    lineage: { kind: "source_record", status: "known" },
    snippet: `Bank account Operating: balance USD 1,201.00 as of ${SNAPSHOT}. QuickBooks Account.` };
  const input = { question: BALANCE_QUESTION, now: NOW, docs: [doc], results: [{ ...doc, ref_key: doc.ref }] };
  assert.ok(quickBooksBalanceAnswer(input), "exact direct observation is the green admission control");
  for (const change of [
    { lineage: { kind: "derived_record", status: "known" } },
    { lineage: { kind: "source_record", status: "unknown" } },
    { ref: "invoice:one" },
    { authority: { eligible: false } },
    { snippet: doc.snippet.replace("Operating", "Operating [99]") },
    { snippet: doc.snippet.replace("USD 1,201.00", "CAD $1,201.00") },
    { snippet: doc.snippet.replace("USD 1,201.00", "($1,201.00)") },
    { snippet: doc.snippet.replace("USD 1,201.00", "-$1,201.00") },
    { snippet: doc.snippet.replace("USD 1,201.00", "USD 1,201.00 million") },
    { snippet: doc.snippet.replace("QuickBooks Account.", "QuickBooks Invoice.") },
  ]) {
    assert.equal(quickBooksBalanceAnswer({ ...input, docs: [{ ...doc, ...change }] }), null);
  }
  const extra = { ...doc, n: 2, source: "books_secondary", ref: "account:two",
    snippet: doc.snippet.replace("Operating", "Reserve") };
  assert.equal(quickBooksBalanceAnswer({ ...input, docs: [doc, extra],
    results: [...input.results, { ...extra, ref_key: extra.ref }] }), null, "two source namespaces cannot establish one company");
  assert.equal(quickBooksBalanceAnswer({ ...input,
    results: [...input.results, { ...doc, ref_key: "account:outside-window" }] }), null, "an account outside numbered evidence cannot be silently ignored");
});

// Bind invented account slots to the actual retrieval order, including when
// freshness changes ranking. A citation mismatch must be intentional in a test.
const accountAnswer = (text) => (prompt) => {
  const found = [...prompt.matchAll(/^\[(\d+)\] \([^\n]*\) Account ([^\n]+)/gm)];
  const numbers = ACCOUNT_ROWS.map((row) => {
    const suffix = createHash("sha256").update(`Account:${row.Id}`).digest("hex").slice(0, 12);
    return found.find((match) => match[2].endsWith(suffix))?.[1];
  });
  assert.ok(numbers.every(Boolean), "all three accounts reached the answer prompt");
  return text.replace(/\[(\d+)\]/g, (_, n) => `[${numbers[Number(n) - 1]}]`);
};

test("three exact balances move from a generated sentence to deterministic evidence", async (t) => {
  const body = await answerCase(t, { rows: ACCOUNT_ROWS, balanceOnly: true, expectedDrafts: 0, expectedVerifiers: 0, answer: accountAnswer(MULTI_ANSWER),
    question: "What bank and credit card accounts are in QuickBooks, and what are their current balances?" });
  assert.equal(body.results.length, 3);
  assert.equal(body.evidence_gate.supported, true, body.evidence_gate.reason);
  assert.equal(body.evidence_gate.complete, true);
  assert.equal(body.citations.length, 3);
  assert.match(body.answer, /Company Card \(Credit Card\): owes USD 75\.25/);
});

test("mixed observation times no longer earn an LLM balance exception", async (t) => {
  const body = await answerCase(t, { rows: ACCOUNT_ROWS,
    mutate: (doc) => doc.source_id.endsWith("bank-one") ? { ...doc,
      occurred_at: "2026-10-07T11:59:00.000Z", content: doc.content.replaceAll(SNAPSHOT, "2026-10-07T11:59:00.000Z") } : doc,
    answer: accountAnswer("Operating currently has a balance of USD 1,201.00 as of 2026-10-07 [1]. Reserve currently has a balance of USD 500.00 as of 2026-10-07 [2]. Company Card owes USD 75.25 as of 2026-10-07 [3].") });
  assert.equal(body.results.length, 3);
  assert.equal(body.evidence_gate.supported, false, body.evidence_gate.reason);
  assert.equal(body.citations.length, 0);
});

for (const [label, answer] of [
  ["swapped amounts", MULTI_ANSWER.replace("USD 1,201.00", "USD 500.00").replace("Reserve has a balance of USD 500.00", "Reserve has a balance of USD 1,201.00")],
  ["wrong currency", MULTI_ANSWER.replace("USD 500.00", "EUR 500.00")],
  ["wrong as-of date", MULTI_ANSWER.replace("2026-10-07", "2026-10-06")],
  ["wrong card sign", MULTI_ANSWER.replace("owes USD 75.25", "owes USD -75.25")],
  ["liability called available funds", MULTI_ANSWER.replace("owes USD 75.25", "has a balance of USD 75.25")],
  ["wrong account citation", MULTI_ANSWER.replace("USD 500.00 [2]", "USD 500.00 [1]")],
  ["uncited account", MULTI_ANSWER.replace("USD 500.00 [2]", "USD 500.00")],
  ["one wrong date among matching dates", MULTI_ANSWER.replace("USD 500.00 [2]", "USD 500.00 as of 2026-10-06 [2]")],
  ["one wrong observation time", MULTI_ANSWER.replace("USD 500.00 [2]", "USD 500.00 as of 2026-10-07T11:59:00.000Z [2]")],
  ["one wrong offset timestamp", MULTI_ANSWER.replace("USD 500.00 [2]", "USD 500.00 as of 2026-10-07T12:00:00+02:00 [2]")],
  ["unknown account borrowing an equal amount", MULTI_ANSWER.replace("USD 500.00 [2]", "USD 500.00 [2], Imaginary has a balance of USD 500.00 [2]")],
]) {
  test(`multi-account balance refuses ${label} after affirmative verifier`, async (t) => {
    const body = await answerCase(t, { rows: ACCOUNT_ROWS, answer: accountAnswer(answer) });
    assert.equal(body.results.length, 3);
    assert.equal(body.evidence_gate.supported, false);
    assert.equal(body.citations.length, 0);
  });
}

test("compact account list without the word balance still checks each amount", async (t) => {
  const answer = "As of 2026-10-07, Operating: USD 1,201.00 [1]; Reserve: USD 500.00 [2]; Company Card: USD -75.25 [3].";
  const control = await deterministicCase(t, { answer: accountAnswer(answer) });
  assert.equal(control.evidence_gate.supported, true, control.evidence_gate.reason);
  const wrong = await answerCase(t, { rows: ACCOUNT_ROWS, answer: accountAnswer(answer.replace("USD 500.00", "EUR 500.00")) });
  assert.equal(wrong.evidence_gate.supported, false);
  assert.equal(wrong.citations.length, 0);
  for (const replacement of ["eur 500.00", "999.00"]) {
    const malformed = await answerCase(t, { rows: ACCOUNT_ROWS, answer: accountAnswer(answer.replace("USD 500.00", replacement)) });
    assert.equal(malformed.evidence_gate.supported, false, "a malformed account clause must not evade checking");
    assert.equal(malformed.citations.length, 0);
  }
});

test("multi-account answer cannot cite a stale observation of one account", async (t) => {
  const body = await answerCase(t, { rows: [...ACCOUNT_ROWS, { ...ACCOUNT_ROWS[0], Id: "bank-one-newer" }],
    mutate: (doc) => doc.source_id === "account:bank-one" ? { ...doc,
      occurred_at: "2026-10-07T11:59:00.000Z", content: doc.content.replaceAll(SNAPSHOT, "2026-10-07T11:59:00.000Z") } : doc,
    answer: accountAnswer(MULTI_ANSWER) });
  assert.equal(body.results.length, 4, "both versions plus the other two accounts reached retrieval");
  assert.equal(body.evidence_gate.supported, false);
  assert.match(body.evidence_gate.reason, /deterministic observed Account evidence/);
  assert.equal(body.citations.length, 0);
});

for (const [label, answer] of [
  ["markdown list", "**Operating**: balance USD 1,201.00 as of 2026-10-07 [1]\n**Reserve**: balance USD 500.00 as of 2026-10-07 [2]\n**Company Card**: owes USD 75.25 as of 2026-10-07 [3]"],
  ["shared trailing citations", "As of October 7, 2026, Operating has a balance of USD 1,201.00, Reserve has a balance of USD 500.00, and Company Card owes USD 75.25 [1][2][3]."],
  ["uppercase month", MULTI_ANSWER.replace("2026-10-07", "OCTOBER 7, 2026")],
  ["signed card balance", MULTI_ANSWER.replace("owes USD 75.25", "has a balance of USD -75.25")],
  ["signed balance with debt explanation", MULTI_ANSWER.replace("owes USD 75.25", "has balance USD -75.25 (owes USD 75.25)")],
]) {
  test(`deterministic multi-account balances replace ${label}`, async (t) => {
    const body = await deterministicCase(t, { rows: ACCOUNT_ROWS, answer: accountAnswer(answer) });
    assert.equal(body.evidence_gate.supported, true, body.evidence_gate.reason);
    assert.equal(body.citations.length, 3);
  });
}

test("a fractional negative balance cannot lose its sign", async (t) => {
  const rows = ACCOUNT_ROWS.map((row) => row.Name === "Company Card" ? { ...row, CurrentBalance: -0.25 } : row);
  const answer = MULTI_ANSWER.replace("owes USD 75.25", "owes USD 0.25");
  const control = await deterministicCase(t, { rows, answer: accountAnswer(answer) });
  assert.equal(control.evidence_gate.supported, true, control.evidence_gate.reason);
  const wrong = await answerCase(t, { rows, answer: accountAnswer(answer.replace("owes USD 0.25", "has a balance of USD 0.25")) });
  assert.equal(wrong.evidence_gate.supported, false);
  assert.equal(wrong.citations.length, 0);
});

test("an as-of heading qualifies only its contiguous account balance bullets", async (t) => {
  const list = "QuickBooks account balances as of 2026-10-07:\n- Operating: USD 1,201.00 [1]\n- Reserve: USD 500.00 [2]\n- Company Card: owes USD 75.25 [3]";
  const control = await deterministicCase(t, { answer: accountAnswer(list) });
  assert.equal(control.evidence_gate.supported, true, control.evidence_gate.reason);
  for (const answer of [
    list.replace("2026-10-07", "2026-10-06"),
    list.replace(" as of 2026-10-07", ""),
    list + "\nOperating currently has a balance of USD 1,201.00 [1].",
  ]) {
    const body = await answerCase(t, { rows: ACCOUNT_ROWS, answer: accountAnswer(answer) });
    assert.equal(body.evidence_gate.supported, false);
    assert.equal(body.citations.length, 0);
  }
});

// The field artifacts retain twelve Account candidates and four approved
// citation numbers, but discard the rejected draft. Preserve that evidence
// shape with invented records; this is a format-boundary reproduction, not a
// claim to replay the lost model text.
test("same-sync field evidence shape renders without a list-format repair", async (t) => {
  const rows = [...ACCOUNT_ROWS,
    { ...ACCOUNT_ROWS[2], Id: "card-two", Name: "Reserve Card", CurrentBalance: 0 },
    ...Array.from({ length: 8 }, (_, i) => ({ ...ACCOUNT_ROWS[0], Id: `expense-${i}`, Name: `Expense ${i}`, AccountType: "Expense", CurrentBalance: i })),
  ];
  const bind = (text, prompt) => {
    const matches = [...prompt.matchAll(/^\[(\d+)\] \([^\n]*\) Account ([^\n]+)/gm)];
    const numbers = rows.slice(0, 4).map((row) => matches.find((m) => m[2].endsWith(createHash("sha256").update(`Account:${row.Id}`).digest("hex").slice(0, 12)))?.[1]);
    assert.equal(matches.length, 12, "all twelve same-sync records reached generation");
    assert.ok(numbers.every(Boolean));
    return text.replace(/\[(\d+)\]/g, (_, n) => `[${numbers[n - 1]}]`);
  };
  const initial = "Your QuickBooks bank and credit card accounts currently show these balances (as of October 7, 2026) [1][2][3][4]:\n- Operating: USD 1,201.00 [1]\n- Reserve: USD 500.00 [2]\n- Company Card: owes USD 75.25 [3]\n- Reserve Card: USD 0.00 [4]";
  const repaired = "Operating has a balance of USD 1,201.00 as of 2026-10-07 [1].\nReserve has a balance of USD 500.00 as of 2026-10-07 [2].\nCompany Card owes USD 75.25 as of 2026-10-07 [3].\nReserve Card has a balance of USD 0.00 as of 2026-10-07 [4].";
  const options = { rows, limit: 12, question: "What bank and credit card accounts are in QuickBooks, and what are their current balances?" };
  const refused = await answerCase(t, { ...options, answer: (prompt) => bind(initial, prompt), expectedDrafts: 1 });
  assert.equal(refused.results.length, 12);
  assert.equal(refused.evidence_gate.supported, false);
  assert.match(refused.evidence_gate.reason, /newest cited evidence did not itself support/);
  assert.equal(refused.citations.length, 0);
  const body = await answerCase(t, { ...options, balanceOnly: true, expectedDrafts: 0, expectedVerifiers: 0, answer: (prompt, attempt) => {
    if (attempt === 2) assert.match(prompt, /one sentence per account/i);
    return bind(attempt === 1 ? initial : repaired, prompt);
  } });
  assert.equal(body.results.length, 12);
  assert.equal(body.evidence_gate.supported, true, body.evidence_gate.reason);
  assert.equal(body.citations.length, 4);
  assert.match(body.answer, /Company Card \(Credit Card\): owes USD 75\.25/);
});

test("an uncited vendor draft is regenerated once and the cited replacement is verified", async (t) => {
  const rows = [FIXTURES.find(([kind]) => kind === "BillPayment")[1]];
  const claim = "Vendor One was paid USD 75.00 by credit card on 2026-07-23 for bill bill-one";
  const options = { entity: "BillPayment", rows, question: "How much did we spend with Vendor One, and what were those bills or payments for?" };
  const control = await answerCase(t, { ...options, answer: `${claim} [1].`, expectedDrafts: 1 });
  assert.equal(control.evidence_gate.supported, true);
  const body = await answerCase(t, { ...options, expectedDrafts: 2, answer: (prompt, attempt) => {
    if (attempt === 2) assert.match(prompt, /cite every factual claim/i);
    return `${claim}${attempt === 1 ? "" : " [1]"}.`;
  } });
  assert.equal(body.evidence_gate.supported, true);
  assert.equal(body.citations.length, 1);
  assert.match(body.answer, /75\.00.*\[1\]/);
});

test("a repaired vendor draft cannot mix a real citation with an unavailable number", async (t) => {
  const body = await answerCase(t, { entity: "BillPayment", rows: [FIXTURES.find(([kind]) => kind === "BillPayment")[1]],
    question: "How much was Vendor One paid?", expectedDrafts: 2, expectedVerifiers: 0,
    answer: (_prompt, attempt) => `Vendor One was paid USD 75.00${attempt === 1 ? "" : " [1][99]"}.` });
  assert.equal(body.evidence_gate.supported, false);
  assert.equal(body.citations.length, 0);
  assert.match(body.evidence_gate.reason, /unavailable document/);
});

for (const [label, second, verifiers] of [
  ["still uncited", "Vendor One was paid USD 75.00.", 0],
  ["unknown citation", "Vendor One was paid USD 75.00 [99].", 0],
  ["explicit refusal", "The documents do not answer the question.", 0],
  ["verifier rejection", "Vendor One was paid USD 999.00 [1].", 1],
]) {
  test(`citation regeneration fails closed for ${label}`, async (t) => {
    const body = await answerCase(t, { entity: "BillPayment", rows: [FIXTURES.find(([kind]) => kind === "BillPayment")[1]],
      question: "How much was Vendor One paid?", expectedDrafts: 2, expectedVerifiers: verifiers, verify: false,
      answer: (_prompt, attempt) => attempt === 1 ? "Vendor One was paid USD 75.00." : second });
    assert.equal(body.evidence_gate.supported, false);
    assert.equal(body.citations.length, 0);
  });
}

test("an explicit model refusal is not retried", async (t) => {
  const body = await answerCase(t, { answer: "The documents do not answer the question.", expectedDrafts: 1, expectedVerifiers: 0 });
  assert.equal(body.evidence_gate.supported, false);
  assert.equal(body.citations.length, 0);
});

for (const [label, repaired] of [
  ["wrong amount", MULTI_ANSWER.replace("USD 500.00", "USD 999.00")],
  ["wrong currency", MULTI_ANSWER.replace("USD 500.00", "EUR 500.00")],
  ["wrong date", MULTI_ANSWER.replace("2026-10-07", "2026-10-06")],
  ["wrong liability sign", MULTI_ANSWER.replace("owes USD 75.25", "has a balance of USD 75.25")],
]) {
  test(`a cited regeneration with ${label} still refuses after verifier approval`, async (t) => {
    const body = await answerCase(t, { rows: ACCOUNT_ROWS, expectedDrafts: 2,
      answer: (prompt, attempt) => attempt === 1 ? MULTI_ANSWER.replace(/\[\d+\]/g, "") : accountAnswer(repaired)(prompt) });
    assert.equal(body.results.length, 3);
    assert.equal(body.evidence_gate.supported, false);
    assert.equal(body.citations.length, 0);
  });
}

test("a failed citation repair cannot expose its unverified first draft", async (t) => {
  const body = await answerCase(t, { expectedDrafts: 2, expectedVerifiers: 0,
    answer: (_prompt, attempt) => {
      if (attempt === 2) throw new Error("fixture regeneration unavailable");
      return "Checking currently has USD 1,201.00 as of 2026-10-07.";
    } });
  assert.equal(body.answer, null);
  assert.equal(body.citations.length, 0);
  assert.equal(body.evidence_gate, undefined);
});

test("a balance table is never generated when exact Account rendering is available", async (t) => {
  const initial = "As of 2026-10-07:\n| Account | Current balance | Evidence |\n| --- | --- | --- |\n| Operating | USD 1,201.00 | [1] |\n| Reserve | USD 500.00 | [2] |\n| Company Card | USD -75.25 | [3] |";
  const body = await deterministicCase(t, { rows: ACCOUNT_ROWS,
    answer: (prompt, attempt) => accountAnswer(attempt === 1 ? initial : MULTI_ANSWER)(prompt) });
  assert.equal(body.evidence_gate.supported, true, body.evidence_gate.reason);
  assert.equal(body.citations.length, 3);
  const unchanged = await answerCase(t, { rows: ACCOUNT_ROWS, expectedDrafts: 1, answer: accountAnswer(initial) });
  assert.equal(unchanged.evidence_gate.supported, false);
  assert.equal(unchanged.citations.length, 0);
});

// Review R4: separate semantic context cannot earn approval through a
// balance clause, even after an affirmative verifier and real retrieval.
for (const [label, answer] of [
  ["millions heading", "Amounts in millions:\nChecking has a balance of USD 1,201.00 as of 2026-10-07 [1]."],
  ["thousands sentence", "All figures below are in thousands.\nChecking has a balance of USD 1,201.00 as of 2026-10-07 [1]."],
  ["currency heading", "Amounts in CAD:\nChecking has a balance of $1,201.00 as of 2026-10-07 [1]."],
  ["negative heading", "Every amount below is negative:\nChecking has a balance of USD 1,201.00 as of 2026-10-07 [1]."],
  ["absent second subject", "Checking has a balance of USD 1,201.00 as of 2026-10-07 [1].\nThe same amount applies to Savings."],
  ["renewed engagement", "Checking has a balance of USD 1,201.00 as of 2026-10-07 [1].\nThe engagement has been renewed."],
]) {
  test(`review R4 refuses generated ${label}`, async (t) => {
    const control = await deterministicCase(t);
    assert.equal(control.evidence_gate.supported, true);
    const body = await answerCase(t, { answer, expectedDrafts: 1 });
    assert.equal(body.results.length, 1);
    assert.equal(body.evidence_gate.supported, false);
    assert.equal(body.citations.length, 0);
  });
}

test("the balance module exposes no generated-claim approval API", async () => {
  const exports = await import("../src/lib/quickbooks-balance.js");
  assert.deepEqual(Object.keys(exports), ["quickBooksBalanceAnswer", "quickBooksBalanceRequest"]);
});

for (const question of ["What are my bank balances?", "What are my bank balances, and what fees did we pay?"]) {
  test(`an implied-current balance request cannot fall back to generated stale money: ${question}`, async (t) => {
    const control = await deterministicCase(t, { question: "What are my bank balances?" });
    assert.equal(control.evidence_gate.supported, true);
    const body = await deterministicCase(t, { question,
      mutate: (doc) => ({ ...doc, occurred_at: CHANGED, content: doc.content.replaceAll(SNAPSHOT, CHANGED) }),
      expectedDrafts: 1, expectedVerifiers: 1,
      answer: "Operating has a balance of USD 9,999.00 as of 2026-10-07 [1]." });
    assert.equal(body.results.length, 3);
    assert.equal(body.evidence_gate.supported, false);
    assert.equal(body.citations.length, 0);
  });
}

// R5 uses money questions without the old question-word trigger. Every attack
// reaches generation and an affirmative verifier after a deterministic control.
for (const [label, options] of [
  ["amount", { answer: "Checking has a balance of USD 9,999.00 as of 2026-10-07 [1]." }],
  ["currency", { answer: "Checking has USD 1,201.00 million as of 2026-10-07 [1]." }],
  ["OCR", { mutate: (doc) => ({ ...doc, text_source: "ocr", text_reliable: true }) }],
  ["unreliable", { mutate: (doc) => ({ ...doc, text_reliable: false }) }],
  ["foreign source", { kind: "local_folder" }],
  ["words", { answer: "Checking contains nine thousand dollars [1]." }],
  ["no money token", { answer: "Checking contains nine thousand [1]." }],
  ["implicit multiplier", { answer: "Amounts in millions. Checking contains USD 1,201.00 [1]." }],
]) {
  test(`R5 money guard rejects ${label} without a balance question`, async (t) => {
    assert.equal((await deterministicCase(t)).evidence_gate.supported, true);
    const body = await answerCase(t, { question: "How much money is currently in Checking in QuickBooks?", ...options });
    assert.equal(body.evidence_gate.supported, false);
    assert.equal(body.citations.length, 0);
  });
}

const invoiceClaim = "Invoice 1016 to Customer One: open balance USD 75.00 (unpaid) as of 2026-10-07 [1].";
const vendorClaim = "Vendor One was paid USD 75.00 by credit card on 2026-07-23 for bill bill-one [1].";
for (const [entity, claim, question] of [
  ["Invoice", invoiceClaim, "Which customers have unpaid invoices in QuickBooks, and how much does each owe?"],
  ["BillPayment", vendorClaim, "How much did we spend with Vendor One in QuickBooks?"],
]) {
  test(`money guard preserves exact ${entity} and cannot override verifier refusal`, async (t) => {
    const options = { entity, rows: [FIXTURES.find(([kind]) => kind === entity)[1]], answer: claim, question };
    const body = await answerCase(t, options);
    assert.equal(body.evidence_gate.supported, true, body.evidence_gate.reason);
    assert.equal(body.citations.length, 1);
    const refused = await answerCase(t, { ...options, verify: false });
    assert.equal(refused.evidence_gate.supported, false);
    assert.equal(refused.citations.length, 0);
  });
  for (const [label, change] of [
    ["wrong value", (s) => s.replace("75.00", "999.00")],
    ["wrong currency", (s) => s.replace("USD", "CAD")],
    ["wrong sign", (s) => s.replace("USD 75", "USD -75")],
    ["currency symbol ambiguity", (s) => s.replace("USD ", "$")],
    ["scale", (s) => s.replace("75.00", "75.00 million")],
    ["subject", (s) => s.replace("One", "Two")],
    ["extra subject", (s) => s.replace("One", "One and Imaginary")],
    ["date", (s) => s.replace("2026-10-07", "2026-10-08").replace("2026-07-23", "2026-07-24")],
    ["side clause", (s) => s.replace(" [1]", " and the service is ongoing [1]")],
    ["uncited afterthought", (s) => `${s}\nThe same amount applies to Imaginary.`],
    ["heads-up money", (s) => `${s}\nHeads up: the amount is in millions.`],
    ["separate context", (s) => `All amounts below are negative.\n${s}`],
  ]) {
    test(`money guard refuses ${entity} ${label} after affirmative verifier`, async (t) => {
      const options = { entity, rows: [FIXTURES.find(([kind]) => kind === entity)[1]], question };
      assert.equal((await answerCase(t, { ...options, answer: claim })).evidence_gate.supported, true);
      const body = await answerCase(t, { ...options, answer: change(claim) });
      assert.equal(body.evidence_gate.supported, false);
      assert.equal(body.citations.length, 0);
    });
  }
}

for (const entity of ["Customer", "Vendor", "Bill", "CreditMemo"]) {
  test(`money guard covers ${entity} independent of question wording`, async (t) => {
    const [_, row, opening] = FIXTURES.find(([kind]) => kind === entity);
    const control = await answerCase(t, { entity, rows: [row], question: "What do the QuickBooks records say?",
      answer: `${opening.slice(0, -1)} [1].` });
    assert.equal(control.evidence_gate.supported, true, control.evidence_gate.reason);
    const body = await answerCase(t, { entity, rows: [FIXTURES.find(([kind]) => kind === entity)[1]],
      question: "What do the QuickBooks records say?", answer: `${entity} One owes USD 9,999.00 [1].` });
    assert.equal(body.evidence_gate.supported, false);
    assert.equal(body.citations.length, 0);
  });
}

test("Q1 unpaid invoice list preserves three individually cited customer amounts", async (t) => {
  const base = FIXTURES.find(([kind]) => kind === "Invoice")[1];
  const rows = ["One", "Two", "Three"].map((name, index) => ({ ...base, Id: `invoice-${index}`,
    DocNumber: String(1016 + index), Balance: 75 + index, TotalAmt: 75 + index,
    CustomerRef: { value: `customer-${index}`, name: `Customer ${name}` } }));
  const body = await answerCase(t, { entity: "Invoice", rows, question: "Who owes us money in QuickBooks?",
    answer: (prompt) => {
      assert.match(prompt, /QUICKBOOKS MONEY CONTRACT/);
      const lines = prompt.split("\n").filter((line) => /^Invoice \d+ to Customer \w+: open balance .* \[\d+\]\.$/.test(line) && !line.includes("T12:"));
      assert.equal(lines.length, 3, "every invoice has its own admissible statement and citation");
      return lines.join("\n") + "\nThe documents do not establish a complete list or a company-wide total.";
    } });
  assert.equal(body.evidence_gate.supported, true, body.evidence_gate.reason);
  assert.equal(body.citations.length, 3);
  assert.match(body.answer, /USD 75\.00/);
  assert.match(body.answer, /USD 76\.00/);
  assert.match(body.answer, /USD 77\.00/);
  assert.match(body.answer, /Heads up:/);
});

test("Q2 two vendor payments retain their dates, cards, bills and recorded purpose", async (t) => {
  const base = FIXTURES.find(([kind]) => kind === "BillPayment")[1];
  const rows = [base, { ...base, Id: "second-payment", TxnDate: "2026-08-23", TotalAmt: 56.5,
    Line: [{ Amount: 56.5, LinkedTxn: [{ TxnType: "Bill", TxnId: "bill-two" }] }] }];
  const body = await answerCase(t, { entity: "BillPayment", rows,
    question: "How much did we spend with Vendor One, and what were the bills or payments for?",
    answer: (prompt) => {
      const lines = prompt.split("\n").filter((line) => /^(?:Bill payment to|Recorded memo for BillPayment).* \[\d+\]\.$/.test(line));
      assert.equal(lines.length, 4, "two independently bound payments and two purpose statements");
      return lines.join("\n");
    } });
  assert.equal(body.evidence_gate.supported, true, body.evidence_gate.reason);
  assert.equal(body.citations.length, 2);
  assert.match(body.answer, /USD 75\.00/);
  assert.match(body.answer, /USD 56\.50/);
  assert.match(body.answer, /Company Card/);
  assert.match(body.answer, /Monthly service/);
});

for (const [label, mutate] of [
  ["OCR", (doc) => ({ ...doc, text_source: "ocr", text_reliable: true })],
  ["unreliable date", (doc) => ({ ...doc, date_reliable: false })],
  ["stale", (doc) => ({ ...doc, occurred_at: "2026-09-01T12:00:00.000Z", content: doc.content.replaceAll(SNAPSHOT, "2026-09-01T12:00:00.000Z") })],
  ["derived", (doc) => ({ ...doc, metadata: { ...doc.metadata, evidence_lineage: { version: 1, kind: "derived_record", root_ids: ["quickbooks:invoice:row-one"] } } })],
]) {
  test(`exact invoice wording cannot launder ${label} evidence`, async (t) => {
    const options = { entity: "Invoice", rows: [FIXTURES.find(([kind]) => kind === "Invoice")[1]],
      question: "Who owes us money in QuickBooks?", answer: invoiceClaim };
    assert.equal((await answerCase(t, options)).evidence_gate.supported, true);
    const body = await answerCase(t, { ...options, mutate });
    assert.equal(body.evidence_gate.supported, false);
    assert.equal(body.citations.length, 0);
  });
}

for (const [label, oldDate] of [["newer observation", "2026-10-07T11:59:00.000Z"], ["conflicting same-time observation", SNAPSHOT]]) {
  test(`invoice money refuses ${label} for the same named document`, async (t) => {
    const base = FIXTURES.find(([kind]) => kind === "Invoice")[1];
    assert.equal((await answerCase(t, { entity: "Invoice", rows: [base], question: "Who owes us money in QuickBooks?",
      answer: invoiceClaim })).evidence_gate.supported, true);
    const rows = [base, { ...base, Id: "older-invoice", Balance: 65 }];
    const body = await answerCase(t, { entity: "Invoice", rows, question: "Who owes us money in QuickBooks?",
      mutate: (doc) => doc.source_id.endsWith("older-invoice") ? { ...doc, occurred_at: oldDate,
        content: doc.content.replaceAll(SNAPSHOT, oldDate) } : doc,
      answer: (prompt) => {
        const suffix = createHash("sha256").update("Invoice:older-invoice").digest("hex").slice(0, 12);
        const line = prompt.split("\n").find((line) => line.startsWith("[") && line.endsWith(suffix));
        assert.ok(line, "the older/conflicting invoice reached the numbered prompt");
        return `Invoice 1016 to Customer One: open balance USD 65.00 (partially paid) as of ${oldDate.slice(0, 10)} [${/^\[(\d+)\]/.exec(line)[1]}].`;
      } });
    assert.equal(body.results.length, 2);
    assert.equal(body.evidence_gate.supported, false);
    assert.equal(body.citations.length, 0);
  });
}

test("a malformed newer invoice cannot disappear from the observation comparison", async (t) => {
  const base = FIXTURES.find(([kind]) => kind === "Invoice")[1];
  assert.equal((await answerCase(t, { entity: "Invoice", rows: [base], question: "Who owes us money in QuickBooks?",
    answer: invoiceClaim })).evidence_gate.supported, true);
  const body = await answerCase(t, { entity: "Invoice", rows: [base, { ...base, Id: "newer-broken" }],
    question: "Who owes us money in QuickBooks?",
    mutate: (doc) => doc.source_id.endsWith("newer-broken") ? { ...doc, occurred_at: "2026-10-07T12:00:30.000Z",
      content: doc.content.replaceAll(SNAPSHOT, "2026-10-07T12:00:30.000Z").replace("total USD 75.00", "total USD 75.00 million") } : doc,
    answer: (prompt) => {
      const suffix = createHash("sha256").update("Invoice:row-one").digest("hex").slice(0, 12);
      const line = prompt.split("\n").find((line) => line.startsWith("[") && line.endsWith(suffix));
      assert.ok(line);
      return invoiceClaim.replace("[1]", `[${/^\[(\d+)\]/.exec(line)[1]}]`);
    } });
  assert.equal(body.results.length, 2);
  assert.equal(body.evidence_gate.supported, false);
  assert.equal(body.citations.length, 0);
});

test("recorded memo cannot supply a separate monetary scale", async (t) => {
  const row = { ...FIXTURES.find(([kind]) => kind === "BillPayment")[1], PrivateNote: "Amounts in millions" };
  assert.equal((await answerCase(t, { entity: "BillPayment", rows: [row], question: "How much did we spend with Vendor One?",
    answer: vendorClaim })).evidence_gate.supported, true);
  const body = await answerCase(t, { entity: "BillPayment", rows: [row], question: "How much did we spend with Vendor One?",
    answer: `${vendorClaim}\nRecorded memo for BillPayment row-one: "Amounts in millions" [1].` });
  assert.equal(body.evidence_gate.supported, false);
  assert.equal(body.citations.length, 0);
});

test("a bill purpose line keeps its amount and attribution without becoming a total", async (t) => {
  const rows = [FIXTURES.find(([kind]) => kind === "Bill")[1]];
  const claim = "Recorded line 1 for Bill 1016: USD 75.00; Telephone service [1].";
  const options = { entity: "Bill", rows, question: "What was the bill from Vendor One for?" };
  const body = await answerCase(t, { ...options, answer: claim });
  assert.equal(body.evidence_gate.supported, true, body.evidence_gate.reason);
  const wrong = await answerCase(t, { ...options, answer: claim.replace("75.00", "999.00") });
  assert.equal(wrong.evidence_gate.supported, false);
  assert.equal(wrong.citations.length, 0);
});

test("a native bill expense-account line preserves the expense purpose", async (t) => {
  const base = FIXTURES.find(([kind]) => kind === "Bill")[1];
  const rows = [{ ...base, Line: [{ Amount: 75, Description: "Telephone service",
    AccountBasedExpenseLineDetail: { AccountRef: { value: "expense-one", name: "Telephone Expense" } } }] }];
  const claim = "Recorded line 1 for Bill 1016: USD 75.00; account Telephone Expense; Telephone service [1].";
  const options = { entity: "Bill", rows, question: "What were the bills from Vendor One for?" };
  assert.equal((await answerCase(t, { ...options, answer: claim })).evidence_gate.supported, true);
  const wrong = await answerCase(t, { ...options, answer: claim.replace("75.00", "999.00") });
  assert.equal(wrong.evidence_gate.supported, false);
  assert.equal(wrong.citations.length, 0);
});


test("a partial verifier explanation cannot append unbound money after the guard", async (t) => {
  const options = { entity: "BillPayment", rows: [FIXTURES.find(([kind]) => kind === "BillPayment")[1]],
    question: "How much did we spend with Vendor One?", answer: vendorClaim };
  assert.equal((await answerCase(t, options)).evidence_gate.supported, true);
  const body = await answerCase(t, { ...options,
    verdict: { complete: false, reason: "Imaginary owes USD 9,999.00 as of 2026-10-07" } });
  assert.equal(body.evidence_gate.partial, true, "the post-verifier partial rendering branch was reached");
  assert.match(body.answer, /Vendor One was paid USD 75\.00/);
  assert.doesNotMatch(body.answer, /Imaginary|9,999/);
  assert.doesNotMatch(JSON.stringify(body.evidence_gate), /Imaginary|9,999/);
});

test("a draft cannot invent QuickBooks attribution outside a QuickBooks question", async (t) => {
  const options = { kind: "local_folder", question: "What does the Checking memo say?",
    mutate: (doc) => ({ ...doc, date_source: "file:modified", content: "Checking memo records money of USD 1,201.00 on 2026-10-07." }) };
  const control = await answerCase(t, { ...options, answer: "The memo records Checking at USD 1,201.00 on 2026-10-07 [1]." });
  assert.equal(control.evidence_gate.supported, true, "ordinary non-QuickBooks evidence keeps its generic gate");
  const body = await answerCase(t, { ...options, answer: "QuickBooks says Checking has a balance of USD 9,999.00 [1]." });
  assert.equal(body.evidence_gate.supported, false);
  assert.equal(body.citations.length, 0);
});

// Open-item answers must come from complete native openings, never a model's
// paraphrase or money hidden inside a memo/line description.
const RECEIVABLES_QUESTION = "Which customers have unpaid invoices in QuickBooks, and how much does each one owe?";
const PAYABLES_QUESTION = "What bills do we owe in QuickBooks?";
const openRows = (entity = "Invoice") => ["One", "Two", "Three"].map((name, index) => ({
  ...FIXTURES.find(([kind]) => kind === entity)[1], Id: `open-${index}`, DocNumber: String(2010 + index),
  TotalAmt: 100 + index, Balance: 75 + index,
  [entity === "Invoice" ? "CustomerRef" : "VendorRef"]: { value: `party-${index}`, name: `Party ${name}` },
}));
const openCase = (t, options = {}) => answerCase(t, {
  entity: "Invoice", rows: openRows(), question: RECEIVABLES_QUESTION, balanceOnly: true,
  expectedDrafts: 0, expectedVerifiers: 0, ...options,
});

for (const entity of ["Invoice", "Bill"]) {
  test(`open items render three cited ${entity} balances without model calls`, async (t) => {
    const body = await openCase(t, { entity, rows: openRows(entity),
      question: entity === "Invoice" ? RECEIVABLES_QUESTION : PAYABLES_QUESTION });
    assert.equal(body.results.length, 3);
    assert.equal(body.evidence_gate.method, "quickbooks_observed_open_items");
    assert.equal(body.evidence_gate.supported, true, body.evidence_gate.reason);
    assert.equal(body.evidence_gate.complete, true, "inventory limit explicitly disclosed");
    assert.equal(body.citations.length, 3);
    assert.equal(body.model, undefined);
    for (const [index, name] of ["One", "Two", "Three"].entries()) {
      const line = body.answer.split("\n").find((value) => value.includes(`${entity} ${2010 + index}`));
      assert.ok(line, "every retrieved open item is listed");
      assert.ok(line.includes(`Party ${name}`));
      assert.ok(line.includes(`USD ${75 + index}.00`));
      assert.match(line, /due 2026-08-22, as of 2026-10-07 \[\d+\]/);
      assert.match(line, entity === "Invoice" ? /owes USD/ : /we owe USD/);
      const n = Number(/\[(\d+)\]/.exec(line)[1]);
      assert.ok(body.citations.some((citation) => citation.n === n));
      assert.ok(body.results[n - 1].snippet.includes(`${entity} ${2010 + index}`), "own item citation");
    }
    assert.match(body.answer, /Lists only (?:invoices|bills) found/);
    assert.match(body.answer, /not a complete QuickBooks inventory/);
    assert.match(body.answer, /No company-wide or net amount owed is established/);
    assert.match(body.answer, /Heads up:/);
    assert.ok(body.gaps.length);
  });
}

test("open items keep mixed currencies and per-invoice subjects without totals or credit netting", async (t) => {
  const rows = openRows();
  rows[1].CurrencyRef = { value: "CAD" };
  rows[1].CustomerRef = rows[0].CustomerRef;
  rows.push({ ...rows[0], Id: "paid", DocNumber: "2090", Balance: 0 },
    { ...rows[0], Id: "credit-balance", DocNumber: "2091", Balance: -10 });
  const body = await openCase(t, { rows,
    related: [["CreditMemo", [FIXTURES.find(([kind]) => kind === "CreditMemo")[1]]]] });
  assert.equal(body.results.length, 6, "paid and credit records actually retrieved");
  assert.equal(body.evidence_gate.supported, true);
  assert.equal(body.citations.length, 3);
  assert.match(body.answer, /Invoice 2010.*Party One.*USD 75\.00/);
  assert.match(body.answer, /Invoice 2011.*Party One.*CAD 76\.00/);
  assert.doesNotMatch(body.answer, /Invoice 209[01]|remaining credit|USD -10|USD 0\.00|(?:Total|total):/);
  assert.match(body.answer, /Credit memos and credit balances are not netted/);
});

test("open bill rendering states missing due dates and preserves a dotted vendor name", async (t) => {
  const rows = openRows("Bill");
  rows[0].DueDate = undefined;
  rows[0].VendorRef.name = "Vendor Co. Ltd";
  const body = await openCase(t, { entity: "Bill", rows, question: "List open payables in QuickBooks." });
  assert.equal(body.evidence_gate.supported, true);
  assert.match(body.answer, /Bill 2010 from Vendor Co\. Ltd: we owe USD 75\.00, due date not provided, as of 2026-10-07/);
});

for (const [label, options] of [
  ["non-AR intent", { question: "What were the invoices in QuickBooks for?" }],
  ["extra material request", { question: "Who owes us in QuickBooks, and is the service ongoing?" }],
  ["historical intent", { question: "Who owed us in QuickBooks last year?" }],
  ["net-credit intent", { question: "What do customers owe net of credit memos in QuickBooks?" }],
  ["only credit memos", { entity: "CreditMemo", rows: [FIXTURES.find(([kind]) => kind === "CreditMemo")[1]] }],
  ["only paid invoices", { rows: openRows().map((row) => ({ ...row, Balance: 0 })) }],
  ["non-provider evidence", { kind: "local_folder" }],
  ["unknown currency", { rows: openRows().map((row) => ({ ...row, CurrencyRef: undefined })) }],
  ["duplicate item identities", { rows: [...openRows(), { ...openRows()[0], Id: "competing", Balance: 99 }] }],
  ["OCR", { mutate: (doc) => ({ ...doc, text_source: "ocr", text_reliable: true }) }],
  ["unreliable text", { mutate: (doc) => ({ ...doc, text_reliable: false }) }],
  ["unreliable date", { mutate: (doc) => ({ ...doc, date_reliable: false }) }],
  ["unmarked observation", { mutate: (doc) => ({ ...doc, date_source: "quickbooks:provider_timestamp" }) }],
  ["derived record", { mutate: (doc) => ({ ...doc, metadata: { ...doc.metadata,
    evidence_lineage: { version: 1, kind: "derived_record", root_ids: [`quickbooks:${doc.source_id}`] } } }) }],
  ["stale beside fresh", { mutate: (doc) => doc.source_id.endsWith("open-0") ? { ...doc,
    occurred_at: CHANGED, content: doc.content.replaceAll(SNAPSHOT, CHANGED) } : doc }],
  ["stale-only canonical observations", { mutate: (doc) => ({ ...doc,
    occurred_at: "2026-10-05T12:00:00.000Z", content: doc.content.replaceAll(SNAPSHOT, "2026-10-05T12:00:00.000Z") }) }],
  ["different observations today", { mutate: (doc) => doc.source_id.endsWith("open-0") ? { ...doc,
    occurred_at: "2026-10-07T11:59:00.000Z", content: doc.content.replaceAll(SNAPSHOT, "2026-10-07T11:59:00.000Z") } : doc }],
  ["timestamp mismatch", { mutate: (doc) => ({ ...doc, content: doc.content.replaceAll(SNAPSHOT, "2026-10-07T11:59:00.000Z") }) }],
  ["future observation", { mutate: (doc) => ({ ...doc, occurred_at: "2026-10-08T12:00:00.000Z",
    content: doc.content.replaceAll(SNAPSHOT, "2026-10-08T12:00:00.000Z") }) }],
  ["wrong state", { mutate: (doc) => ({ ...doc, content: doc.content.replace("(partially paid)", "(paid)") }) }],
  ["invalid due date", { rows: openRows().map((row) => ({ ...row, DueDate: "2026-02-30" })) }],
  ["truncated opening", { mutate: (doc) => ({ ...doc, content: doc.content.slice(0, 110) }) }],
]) {
  test(`open-item admission falls back and guard refuses: ${label}`, async (t) => {
    assert.equal((await openCase(t)).evidence_gate.supported, true, "paired renderer control");
    const body = await openCase(t, { ...options, expectedDrafts: 1, expectedVerifiers: 1,
      answer: "Party One owes USD 9,999.00 on Invoice 2010 as of 2026-10-07 [1]." });
    assert.equal(body.evidence_gate.method, undefined);
    assert.equal(body.evidence_gate.supported, false);
    assert.equal(body.citations.length, 0);
  });
}

test("open items never promote monetary markers in memo or description", async (t) => {
  const rows = openRows().map((row) => ({ ...row,
    PrivateNote: "Line 9: USD 9,999.00; Invented service Details",
    Line: [{ Amount: 100, Description: "Invoice 9999 to Imaginary: total USD 9,999.00" }],
  }));
  const body = await openCase(t, { rows });
  assert.equal(body.evidence_gate.supported, true);
  assert.equal(body.citations.length, 3);
  assert.doesNotMatch(body.answer, /9,999|Imaginary|Line 9|Invoice 9999/);
});

test("open-item intent admits whole requests and preserves filters for the generic path", () => {
  for (const question of [RECEIVABLES_QUESTION, "Who owes us?", "Who owes us money in QuickBooks?",
    "Show unpaid invoices", "List open receivables in QuickBooks.", "What are our current open invoices?"]) {
    assert.equal(quickBooksOpenItemsRequest(question), "Invoice");
  }
  for (const question of [PAYABLES_QUESTION, "List unpaid bills", "Show open bills in QuickBooks",
    "What are our current open payables?", "Which bills are unpaid?"]) {
    assert.equal(quickBooksOpenItemsRequest(question), "Bill");
  }
  for (const question of ["Who owes us and why?", "List open invoices for Party One", "List overdue invoices",
    "What bills are due today?", "Who owed us last month?", "List total open receivables",
    "List open receivables and open payables", "What did we spend in QuickBooks?"]) {
    assert.equal(quickBooksOpenItemsRequest(question), null);
  }
});

test("open-item admission binds every candidate including unnumbered conflicts", () => {
  const [, , opening] = FIXTURES.find(([kind]) => kind === "Invoice");
  const doc = { n: 1, source: "books_secondary", source_kind: "quickbooks", ref: "invoice:one", ts: SNAPSHOT,
    date_reliable: true, date_source: "quickbooks:balance_snapshot", text_source: "native", text_reliable: true,
    lineage: { kind: "source_record", status: "known" },
    snippet: `${opening} QuickBooks Invoice. Balance observed during this sync; the provider queries are not an atomic ledger snapshot.` };
  const input = { question: RECEIVABLES_QUESTION, now: NOW, candidates: [doc], citationCount: 1 };
  const control = quickBooksOpenItemsAnswer(input);
  assert.ok(control);
  assert.deepEqual(control.evidence, [1]);
  const extra = { ...doc, n: 2, ref: "invoice:two", snippet: doc.snippet.replace("1016", "1017") };
  assert.equal(quickBooksOpenItemsAnswer({ ...input, candidates: [doc, extra] }).evidence.length, 1,
    "an unnumbered valid record can constrain observation but is not cited");
  for (const change of [
    { lineage: { kind: "derived_record", status: "known" } },
    { lineage: { kind: "source_record", status: "unknown" } },
    { authority: { eligible: false } }, { source: "?" }, { n: 12 }, { ref: "bill:one" },
    { snippet: doc.snippet.replace("Customer One", "Customer [99]") },
    { snippet: doc.snippet.replace("open balance USD 75.00", "open balance CAD 75.00") },
    { snippet: doc.snippet.replace("open balance USD 75.00", "open balance USD 75.00 million") },
    { snippet: doc.snippet.replace("open balance USD 75.00", "open balance USD -75.00") },
    { snippet: doc.snippet.replace("QuickBooks Invoice.", "QuickBooks Bill.") },
  ]) {
    assert.equal(quickBooksOpenItemsAnswer({ ...input, candidates: [{ ...doc, ...change }] }), null);
  }
  for (const change of [
    { source: "another_company" },
    { ts: "2026-10-07T11:59:00.000Z", snippet: extra.snippet.replaceAll(SNAPSHOT, "2026-10-07T11:59:00.000Z") },
    { snippet: extra.snippet.slice(0, 100) },
    { ref: doc.ref },
  ]) {
    assert.equal(quickBooksOpenItemsAnswer({ ...input, candidates: [doc, { ...extra, ...change }] }), null,
      "conflict outside citation window participates in admission");
  }
});

test("paid bills are not returned as open payables", async (t) => {
  const rows = openRows("Bill");
  rows[1].Balance = 0;
  const body = await openCase(t, { entity: "Bill", rows, question: PAYABLES_QUESTION });
  assert.equal(body.results.length, 3);
  assert.equal(body.evidence_gate.supported, true);
  assert.equal(body.citations.length, 2);
  assert.doesNotMatch(body.answer, /Bill 2011/);
});

test("open-item rendering caps citations at the real numbered evidence window", async (t) => {
  const rows = Array.from({ length: 15 }, (_, index) => ({ ...openRows()[0], Id: `item-${index}`, DocNumber: `30${index}` }));
  const body = await openCase(t, { rows });
  assert.equal(body.results.length, 12);
  assert.equal(body.citations.length, 12);
  assert.equal(body.evidence_gate.supported, true);
  assert.ok(body.citations.every((citation) => citation.n <= 12));
  assert.match(body.answer, /only invoices found/);
});


for (const entity of ["Invoice", "Bill"]) {
  test(`hybrid retrieval retains the full ${entity} opening for open-item rendering`, async (t) => {
    const rows = openRows(entity).map((row) => ({ ...row, TotalAmt: row.Balance,
      [entity === "Invoice" ? "CustomerRef" : "VendorRef"]: { value: "party", name: "Synthetic Trading Company" },
    }));
    const body = await openCase(t, { entity, rows, hybrid: true,
      question: entity === "Invoice" ? RECEIVABLES_QUESTION : PAYABLES_QUESTION });
    assert.equal(body.results.length, 3);
    assert.equal(body.evidence_gate.method, "quickbooks_observed_open_items");
    assert.equal(body.evidence_gate.supported, true);
    assert.equal(body.citations.length, 3);
    for (const row of body.results) {
      assert.ok(row.snippet.startsWith("["), "the intact connector title prefix remains anchored");
      assert.ok(row.snippet.includes(`QuickBooks ${entity}. Balance observed`));
    }
  });
}
