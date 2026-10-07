import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createProductFixture } from "./product-contract-fixture.mjs";
import { syncQuickBooksOnline } from "../../connectors/quickbooks-online.mjs";
import { normalizeProviderResult, deliverProviderDocuments } from "../../connectors/provider-runtime.mjs";
import { providerEnvelope, renderRecord } from "../../connectors/provider-sync.mjs";
import { splitOversized } from "../../ingest/envelope-batching.mjs";
import { SNAPSHOT, CHANGED, FIXTURES } from "../../test/fixtures/quickbooks-records.mjs";

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

async function answerCase(t, { mutate = (doc) => doc, source = "quickbooks", kind = "quickbooks", entity = "Account", answer, rows = null, question = "What are the current QuickBooks bank account balances?" } = {}) {
  t.mock.method(Date, "now", () => NOW);
  let verifierCalls = 0;
  let draft;
  const fixture = await createProductFixture({ env: { AI: { async run(model, input) {
    if (model.includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
    if (String(input.messages?.[0]?.content).includes("verify a proposed answer")) {
      verifierCalls++;
      return { response: { supported: true, complete: true, evidence: [...new Set([...draft.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])))], reason: "injected approval" } };
    }
    draft = typeof answer === "function" ? answer(input.messages.at(-1).content)
      : answer || "Checking currently has a balance of USD 1,201.00 as of 2026-10-07 [1].";
    return { response: draft };
  } } } });
  try {
    await register(fixture, source, kind);
    const result = await collect(entity, rows || [{ ...FIXTURES[0][1], Active: undefined }]);
    const docs = normalizeProviderResult(source, result).documents.map(mutate);
    await ingest(fixture, docs);
    const response = await fixture.post("/api/rag/think", { q: question, limit: 10 }, ADMIN);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.results.length, "retrieval reached actual stored evidence");
    assert.equal(verifierCalls, 1, "the temporal decision follows an affirmative evidence verifier");
    return body;
  } finally { fixture.close(); }
}

for (const source of ["quickbooks", "books_secondary"]) {
  test(`balance read through real storage and think is answerable for ${source}`, async (t) => {
    const body = await answerCase(t, { source });
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
  test(`balance exception refuses ${label} after affirmative verifier`, async (t) => {
    const body = await answerCase(t, options);
    assert.equal(body.evidence_gate.supported, false);
    assert.equal(body.citations.length, 0);
  });
}

for (const [entity, subject, amount] of [["Customer", "Customer One", "75.00"], ["Vendor", "Vendor One", "75.00"], ["Invoice", "Customer One", "75.00"], ["Bill", "Vendor One", "25.00"], ["CreditMemo", "Customer One", "25.00"]]) {
  test(`${entity} supports only the exact observed party balance`, async (t) => {
    const row = FIXTURES.find(([kind]) => kind === entity)[1];
    const body = await answerCase(t, { entity, rows: [row], question: `What is the current QuickBooks balance for ${subject}?`,
      answer: `${subject} currently has ${entity === "CreditMemo" ? "remaining credit" : "an open balance"} of USD ${amount} as of 2026-10-07 [1].` });
    assert.equal(body.evidence_gate.supported, true, body.evidence_gate.reason);
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

test("one sentence checks three account balances against their own same-sync observations", async (t) => {
  const body = await answerCase(t, { rows: ACCOUNT_ROWS, answer: accountAnswer(MULTI_ANSWER),
    question: "What bank and credit card accounts are in QuickBooks, and what are their current balances?" });
  assert.equal(body.results.length, 3);
  assert.equal(body.evidence_gate.supported, true, body.evidence_gate.reason);
  assert.equal(body.evidence_gate.complete, true);
  assert.equal(body.citations.length, 3);
  assert.match(body.answer, /Company Card owes USD 75\.25/);
});

test("a newer observation for a different account does not invalidate a dated balance", async (t) => {
  const body = await answerCase(t, { rows: ACCOUNT_ROWS,
    mutate: (doc) => doc.source_id.endsWith("bank-one") ? { ...doc,
      occurred_at: "2026-10-07T11:59:00.000Z", content: doc.content.replaceAll(SNAPSHOT, "2026-10-07T11:59:00.000Z") } : doc,
    answer: accountAnswer("Operating currently has a balance of USD 1,201.00 as of 2026-10-07 [1]. Reserve currently has a balance of USD 500.00 as of 2026-10-07 [2]. Company Card owes USD 75.25 as of 2026-10-07 [3].") });
  assert.equal(body.results.length, 3);
  assert.equal(body.evidence_gate.supported, true, body.evidence_gate.reason);
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
  const control = await answerCase(t, { rows: ACCOUNT_ROWS, answer: accountAnswer(answer) });
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
  assert.match(body.evidence_gate.reason, /older evidence/);
  assert.equal(body.citations.length, 0);
});

for (const [label, answer] of [
  ["markdown list", "**Operating**: balance USD 1,201.00 as of 2026-10-07 [1]\n**Reserve**: balance USD 500.00 as of 2026-10-07 [2]\n**Company Card**: owes USD 75.25 as of 2026-10-07 [3]"],
  ["shared trailing citations", "As of October 7, 2026, Operating has a balance of USD 1,201.00, Reserve has a balance of USD 500.00, and Company Card owes USD 75.25 [1][2][3]."],
  ["uppercase month", MULTI_ANSWER.replace("2026-10-07", "OCTOBER 7, 2026")],
  ["signed card balance", MULTI_ANSWER.replace("owes USD 75.25", "has a balance of USD -75.25")],
  ["signed balance with debt explanation", MULTI_ANSWER.replace("owes USD 75.25", "has balance USD -75.25 (owes USD 75.25)")],
]) {
  test(`multi-account balances accept ${label}`, async (t) => {
    const body = await answerCase(t, { rows: ACCOUNT_ROWS, answer: accountAnswer(answer) });
    assert.equal(body.evidence_gate.supported, true, body.evidence_gate.reason);
    assert.equal(body.citations.length, 3);
  });
}

test("a fractional negative balance cannot lose its sign", async (t) => {
  const rows = ACCOUNT_ROWS.map((row) => row.Name === "Company Card" ? { ...row, CurrentBalance: -0.25 } : row);
  const answer = MULTI_ANSWER.replace("owes USD 75.25", "owes USD 0.25");
  const control = await answerCase(t, { rows, answer: accountAnswer(answer) });
  assert.equal(control.evidence_gate.supported, true, control.evidence_gate.reason);
  const wrong = await answerCase(t, { rows, answer: accountAnswer(answer.replace("owes USD 0.25", "has a balance of USD 0.25")) });
  assert.equal(wrong.evidence_gate.supported, false);
  assert.equal(wrong.citations.length, 0);
});

test("an as-of heading qualifies only its contiguous account balance bullets", async (t) => {
  const list = "QuickBooks account balances as of 2026-10-07:\n- Operating: USD 1,201.00 [1]\n- Reserve: USD 500.00 [2]\n- Company Card: owes USD 75.25 [3]";
  const control = await answerCase(t, { rows: ACCOUNT_ROWS, answer: accountAnswer(list) });
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
