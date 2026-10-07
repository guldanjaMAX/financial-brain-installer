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

async function answerCase(t, { mutate = (doc) => doc, source = "quickbooks", kind = "quickbooks", entity = "Account", answer, rows = null, question = "What are the current QuickBooks bank account balances?", limit = 10, expectedDrafts, expectedVerifiers = 1, verify = true } = {}) {
  t.mock.method(Date, "now", () => NOW);
  let verifierCalls = 0;
  let draftCalls = 0;
  let draft;
  const fixture = await createProductFixture({ env: { AI: { async run(model, input) {
    if (model.includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
    if (String(input.messages?.[0]?.content).includes("verify a proposed answer")) {
      verifierCalls++;
      return { response: { supported: verify, complete: true, evidence: [...new Set([...draft.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])))], reason: verify ? "injected approval" : "injected rejection" } };
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
    const response = await fixture.post("/api/rag/think", { q: question, limit }, ADMIN);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.results.length, "retrieval reached actual stored evidence");
    assert.equal(verifierCalls, expectedVerifiers, "the draft reached the expected evidence-verifier decision point");
    if (expectedDrafts !== undefined) assert.equal(draftCalls, expectedDrafts, "generation attempts are bounded");
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
]) {
  test(`entire balance claim refuses ${label}`, async (t) => {
    const body = await answerCase(t, { answer });
    assert.equal(body.evidence_gate.supported, false, body.evidence_gate.reason);
    assert.equal(body.citations.length, 0);
  });
}

test("dollar notation is accepted only with the exact observed USD sign and amount", async (t) => {
  const body = await answerCase(t, { answer: "Checking currently has a balance of $1,201.00 as of 2026-10-07 [1]." });
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
    const control = await answerCase(t, { entity, rows: [row], answer: claim });
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

// The field artifacts retain twelve Account candidates and four approved
// citation numbers, but discard the rejected draft. Preserve that evidence
// shape with invented records; this is a format-boundary reproduction, not a
// claim to replay the lost model text.
test("same-sync account evidence can regenerate an unsupported dated list format once", async (t) => {
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
  const refused = await answerCase(t, { ...options, answer: (prompt) => bind(initial, prompt), expectedDrafts: 2 });
  assert.equal(refused.results.length, 12);
  assert.equal(refused.evidence_gate.supported, false);
  assert.match(refused.evidence_gate.reason, /newest cited evidence did not itself support/);
  assert.equal(refused.citations.length, 0);
  const body = await answerCase(t, { ...options, expectedDrafts: 2, answer: (prompt, attempt) => {
    if (attempt === 2) assert.match(prompt, /one sentence per account/i);
    return bind(attempt === 1 ? initial : repaired, prompt);
  } });
  assert.equal(body.results.length, 12);
  assert.equal(body.evidence_gate.supported, true, body.evidence_gate.reason);
  assert.equal(body.citations.length, 4);
  assert.match(body.answer, /Company Card owes USD 75\.25/);
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

test("a cited balance table can request the checked sentence format without recognizing its rows", async (t) => {
  const initial = "As of 2026-10-07:\n| Account | Current balance | Evidence |\n| --- | --- | --- |\n| Operating | USD 1,201.00 | [1] |\n| Reserve | USD 500.00 | [2] |\n| Company Card | USD -75.25 | [3] |";
  const body = await answerCase(t, { rows: ACCOUNT_ROWS, expectedDrafts: 2,
    answer: (prompt, attempt) => accountAnswer(attempt === 1 ? initial : MULTI_ANSWER)(prompt) });
  assert.equal(body.evidence_gate.supported, true, body.evidence_gate.reason);
  assert.equal(body.citations.length, 3);
  const unchanged = await answerCase(t, { rows: ACCOUNT_ROWS, expectedDrafts: 2, answer: accountAnswer(initial) });
  assert.equal(unchanged.evidence_gate.supported, false);
  assert.equal(unchanged.citations.length, 0);
});
