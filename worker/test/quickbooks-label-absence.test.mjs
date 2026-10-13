// Lens qbo-ledger: does the widened ABSENCE word list in money-veto.js refuse
// correct, fully cited QuickBooks answers whose provider label merely contains
// an ordinary word ("Nothing", "Settled", "None", "Nope")? Every payer, amount,
// date and account below is invented. Harness copied from the shipped
// worker/test/quickbooks-answers.test.mjs (same AI stub, same counters).
// Regression: exact cited QuickBooks answers must survive provider labels
// that merely contain an ordinary word.
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const at = (path) => import(pathToFileURL(join(ROOT, path)).href);
const { createProductFixture } = await at("worker/test/product-contract-fixture.mjs");
const { syncQuickBooksOnline } = await at("connectors/quickbooks-online.mjs");
const { normalizeProviderResult } = await at("connectors/provider-runtime.mjs");
const { SNAPSHOT, FIXTURES } = await at("test/fixtures/quickbooks-records.mjs");
const EXPECT_REFUSAL = false;

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

async function answerCase(t, { source = "quickbooks", kind = "quickbooks", entity = "Account", answer, rows, question, limit = 10, expectedDrafts, expectedVerifiers }) {
  t.mock.method(Date, "now", () => NOW);
  let verifierCalls = 0;
  let draftCalls = 0;
  let draft;
  const fixture = await createProductFixture({ env: { AI: { async run(model, input) {
    if (model.includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
    if (String(input.messages?.[0]?.content).includes("verify a proposed answer")) {
      verifierCalls++;
      return { response: { supported: true, complete: true, evidence: [...new Set([...draft.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])))], reason: "injected approval" } };
    }
    draftCalls++;
    draft = answer;
    return { response: draft };
  } } } });
  try {
    await register(fixture, source, kind);
    const docs = normalizeProviderResult(source, await collect(entity, rows)).documents;
    await ingest(fixture, docs);
    const response = await fixture.post("/api/rag/think", { q: question, limit }, ADMIN);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.results.length, "retrieval reached actual stored evidence");
    assert.equal(draftCalls, expectedDrafts, "generation attempts reached as expected");
    assert.equal(verifierCalls, expectedVerifiers, "the expected evidence-verifier decision point was reached");
    assert.equal(body.timing.stages.answer_llm.calls, draftCalls);
    assert.equal(body.timing.stages.verifier_llm.calls, verifierCalls);
    return { body, draftCalls, verifierCalls };
  } finally { fixture.close(); }
}

const labelQuestion = (entity) => entity === "Account" ? "What are the current QuickBooks account balances?"
  : entity === "Invoice" ? "Who owes us money in QuickBooks?"
    : entity === "Bill" ? "What bills do we owe in QuickBooks?" : "What did we pay vendors in QuickBooks?";
const labelRow = (entity, label) => ({ ...FIXTURES.find(([kind]) => kind === entity)[1],
  ...(entity === "Account" ? { Name: label }
    : { [entity === "Invoice" ? "CustomerRef" : "VendorRef"]: { value: "party-one", name: label } }),
});
const labelClaim = (entity, label) => {
  const quoted = JSON.stringify(label.normalize("NFKC"));
  if (entity === "Account") return `${quoted} (Bank): balance USD 1,201.00 as of 2026-10-07 [1].`;
  if (entity === "BillPayment") return `${quoted} was paid USD 75.00 by credit card on 2026-07-23 for bill "bill-one" [1].`;
  return `${entity} "1016" ${entity === "Invoice" ? "to" : "from"} ${quoted}: ${entity === "Invoice" ? "owes USD 75.00" : "we owe USD 25.00"}, due 2026-08-22, as of 2026-10-07 [1].`;
};

const CASES = [
  ["Invoice", "Nothing Fancy Bakery"],
  ["Bill", "Settled Roots Farm"],
  ["Account", "Settled Funds"],
  ["Invoice", "Nope Design Studio"],
  ["Bill", "None Too Soon Movers"],
  ["BillPayment", "Nothing Fancy Bakery"],
];

for (const [entity, label] of CASES) {
  test(`${entity} exact QuickBooks answer for ordinary label ${JSON.stringify(label)}`, async (t) => {
    const generated = entity === "BillPayment";
    const options = { entity, question: labelQuestion(entity),
      expectedDrafts: generated ? 1 : 0, expectedVerifiers: generated ? 1 : 0 };
    // Green control: same entity, same question, same harness, ordinary label.
    const control = await answerCase(t, { ...options, rows: [labelRow(entity, "Party One")], answer: labelClaim(entity, "Party One") });
    assert.equal(control.body.evidence_gate.supported, true, `control: ${control.body.evidence_gate.reason}`);
    assert.equal(control.body.answer.split("\n")[0], labelClaim(entity, "Party One"));
    assert.equal(control.body.citations.length, 1);

    const expected = labelClaim(entity, label);
    const probe = await answerCase(t, { ...options, rows: [labelRow(entity, label)], answer: expected });
    const veto = (probe.body.gaps || []).find((gap) => gap?.type === "money_veto");
    console.log(JSON.stringify({ root: ROOT.split("/").at(-1), entity, label,
      draftCalls: probe.draftCalls, verifierCalls: probe.verifierCalls,
      method: probe.body.evidence_gate?.method, supported: probe.body.evidence_gate?.supported,
      reason: probe.body.evidence_gate?.reason, vetoRule: veto?.rule, answer: probe.body.answer }));
    if (!generated) {
      // The deterministic renderer admitted the exact record (decision point
      // reached) before the shared money veto made its decision.
      assert.equal(probe.body.evidence_gate.method, entity === "Account" ? "quickbooks_observed_balances" : "quickbooks_observed_open_items");
    }
    if (EXPECT_REFUSAL) {
      assert.equal(probe.body.evidence_gate.supported, false, "the correct exact answer was refused");
      assert.equal(veto?.rule, "document_coverage", "refused by the widened ABSENCE rule");
      assert.equal(probe.body.citations.length, 0);
    } else {
      assert.equal(probe.body.evidence_gate.supported, true, probe.body.evidence_gate.reason);
      assert.equal(probe.body.answer.split("\n")[0], expected);
      assert.equal(probe.body.citations.length, 1);
    }
  });
}

// One ordinary customer name among three exact open invoices removes the
// whole receivables list, not just its own line.
const RECEIVABLES_QUESTION = "Which customers have unpaid invoices in QuickBooks, and how much does each one owe?";
const openRows = (names) => names.map((name, index) => ({
  ...FIXTURES.find(([kind]) => kind === "Invoice")[1], Id: `open-${index}`, DocNumber: String(2010 + index),
  TotalAmt: 100 + index, Balance: 75 + index, CustomerRef: { value: `party-${index}`, name },
}));
test("three exact open invoices: one ordinary label refuses the whole list", async (t) => {
  const options = { entity: "Invoice", question: RECEIVABLES_QUESTION, expectedDrafts: 0, expectedVerifiers: 0 };
  const control = await answerCase(t, { ...options, rows: openRows(["Party One", "Party Two", "Party Three"]) });
  assert.equal(control.body.evidence_gate.supported, true, "control list answered");
  assert.equal(control.body.citations.length, 3);
  const probe = await answerCase(t, { ...options, rows: openRows(["Party One", "Settled Roots Farm", "Party Three"]) });
  assert.equal(probe.body.results.length, 3, "all three invoices retrieved");
  assert.equal(probe.body.evidence_gate.method, "quickbooks_observed_open_items", "renderer admitted all three");
  const veto = (probe.body.gaps || []).find((gap) => gap?.type === "money_veto");
  console.log(JSON.stringify({ root: ROOT.split("/").at(-1), supported: probe.body.evidence_gate.supported,
    vetoRule: veto?.rule, citations: probe.body.citations.length, answerLines: (probe.body.answer || "").split("\n").filter((l) => /^Invoice /.test(l)) }));
  if (EXPECT_REFUSAL) {
    assert.equal(probe.body.evidence_gate.supported, false);
    assert.equal(veto?.rule, "document_coverage");
    assert.equal(probe.body.citations.length, 0, "the two unaffected exact lines are lost too");
  } else {
    assert.equal(probe.body.evidence_gate.supported, true);
    assert.equal(probe.body.citations.length, 3);
  }
});
