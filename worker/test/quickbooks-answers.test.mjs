import assert from "node:assert/strict";
import test from "node:test";
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
  const fixture = await createProductFixture({ env: { AI: { async run(model, input) {
    if (model.includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
    if (String(input.messages?.[0]?.content).includes("verify a proposed answer")) {
      verifierCalls++;
      return { response: { supported: true, complete: true, evidence: answer ? [...new Set([...answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])))] : [1], reason: "injected approval" } };
    }
    return { response: answer || "Checking currently has a balance of USD 1,201.00 as of 2026-10-07 [1]." };
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
