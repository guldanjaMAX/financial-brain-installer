import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createProductFixture } from "./product-contract-fixture.mjs";
import { syncQuickBooksOnline } from "../../connectors/quickbooks-online.mjs";
import { normalizeProviderResult } from "../../connectors/provider-runtime.mjs";
import { providerEnvelope } from "../../connectors/provider-sync.mjs";
import { SNAPSHOT, FIXTURES } from "../../test/fixtures/quickbooks-records.mjs";
import { quickBooksMoneyPolicy } from "../src/lib/quickbooks-money.js";
import { quickBooksOpenItemsAnswer } from "../src/lib/quickbooks-open-items.js";
import { quickBooksBalanceAnswer } from "../src/lib/quickbooks-balance.js";
import { ownerSystemStatus } from "../src/lib/system-status.js";
import { supportSystemProjection } from "../src/lib/support-access.js";
import { coverageGapReport } from "../src/lib/store-d1.js";

const NOW = Date.parse(SNAPSHOT) + 60_000;
const ADMIN = { "X-Admin-Key": "fixture-admin-key" };
const REFUSAL = "QuickBooks money draft contains an ambiguous or unbound statement; exact cited native records at the latest observation are required";
const OWES = '"Customer One" owes USD 75.00 on Invoice "1016" as of 2026-10-07 [1].';
const fixtureRow = (entity) => FIXTURES.find(([kind]) => kind === entity)[1];
const statements = (policy) => policy.instruction.split("\n").filter((line) => /\[\d+\]\.$/.test(line));

async function collect(entity, rows) {
  let reads = 0;
  const result = await syncQuickBooksOnline({
    realmId: "synthetic-company", accessToken: "synthetic-fixture", apiBase: "https://provider.invalid",
    entities: [entity], snapshotAt: SNAPSHOT, now: () => NOW,
    fetchImpl: async () => {
      reads++;
      return new Response(JSON.stringify({ QueryResponse: { [entity]: rows } }));
    },
  });
  assert.equal(reads, 1, "the real adapter reached the injected provider boundary");
  assert.equal(result.documents.length, rows.length);
  return result;
}

function candidate(document, n = 1, source = "quickbooks") {
  return {
    n, source, source_kind: "quickbooks", ref: document.source_id, ref_key: document.source_id,
    snippet: document.content.replace(/\s+/g, " "), ts: document.occurred_at,
    date_source: document.date_source, date_reliable: document.date_reliable,
    text_source: document.text_source, text_reliable: document.text_reliable,
    lineage: { status: "known", kind: "source_record" },
  };
}

for (const otherSource of ["quickbooks_desktop", "quickbooks_prod"]) {
  test(`mixed QuickBooks candidates refuse across ${otherSource}`, async () => {
    const row = fixtureRow("Invoice");
    const unpaid = candidate((await collect("Invoice", [row])).documents[0], 1, otherSource);
    const paid = candidate((await collect("Invoice", [{ ...row, Balance: 0 }])).documents[0], 2);
    const single = quickBooksMoneyPolicy({ docs: [unpaid], now: NOW });
    assert.equal(single.refusal(OWES), null, "single-source green control is an actual allowed statement");
    const expected = [
      `Invoice "1016" to "Customer One": total USD 75.00, open balance USD 75.00 (unpaid) as of ${SNAPSHOT}; dated 2026-07-23, due 2026-08-22, terms "Net 30" [1].`,
      ...[SNAPSHOT, "2026-10-07"].flatMap((date) => [
        `Invoice "1016" for "Customer One" has an open balance of USD 75.00 as of ${date} [1].`,
        `Invoice "1016" to "Customer One": open balance USD 75.00 (unpaid) as of ${date} [1].`,
        `"Customer One" owes USD 75.00 on Invoice "1016" as of ${date} [1].`,
      ]),
    ];
    assert.deepEqual(statements(single), expected, "single-source finite language stays byte-exact");
    const sourcesRead = new Set();
    const candidates = [unpaid, paid].map((doc) => ({ ...doc,
      get source() { sourcesRead.add(doc.source); return doc.source; },
    }));
    const mixed = quickBooksMoneyPolicy({ docs: [unpaid], candidates, now: NOW });
    assert.equal(sourcesRead.size, 2, "both distinct source identities reached the policy decision");
    assert.deepEqual(statements(mixed), []);
    assert.equal(mixed.refusal(OWES), REFUSAL);
    assert.equal(mixed.refusal('"Customer One" owes USD 75.00 on Invoice 1016 as of 2026-10-07 [1].'), REFUSAL);
    assert.equal(mixed.partialBody(OWES, new Set([1])), "");
    const observed = quickBooksMoneyPolicy({ docs: [unpaid], candidates, now: NOW, observedAnswer: { answer: OWES } });
    assert.equal(observed.refusal(OWES), REFUSAL, "an observed proposal cannot bypass mixed-source refusal");
    for (const scopedPeer of [
      { ...paid, source_kind: null, snippet: "Unparsed provider text" },
      { ...paid, source_kind: null, date_source: "none" },
      { ...paid, source_kind: null, date_source: "none", snippet: "Historical provider text. QuickBooks Purchase." },
    ]) {
      const policy = quickBooksMoneyPolicy({ docs: [unpaid], candidates: [unpaid, scopedPeer], now: NOW });
      assert.deepEqual(statements(policy), [], "date provenance and text markers each independently scope a peer");
    }
    const unrelated = { ...paid, source_kind: "upload", date_source: "none", snippet: "Other evidence" };
    assert.deepEqual(statements(quickBooksMoneyPolicy({ docs: [unpaid], candidates: [unpaid, unrelated], now: NOW })), expected);
  });
}

test("void invoices cannot become paid facts; a nonvoid invoice keeps its golden opening", async () => {
  const row = fixtureRow("Invoice");
  const valid = (await collect("Invoice", [row])).documents[0];
  assert.equal(valid.content.split("\n")[0], FIXTURES.find(([kind]) => kind === "Invoice")[2]);
  const good = candidate(valid);
  const question = "Who owes us money in QuickBooks?";
  assert.ok(quickBooksOpenItemsAnswer({ question, candidates: [good], citationCount: 1, now: NOW }));
  assert.equal(quickBooksMoneyPolicy({ docs: [good], now: NOW }).refusal(OWES), null);
  const result = await collect("Invoice", [{ ...row, TotalAmt: 0, Balance: 0 }]);
  const doc = result.documents[0];
  assert.match(doc.content.split("\n")[0], /total amount not provided, balance not provided/);
  assert.doesNotMatch(doc.content, /Total Amt:|\bBalance:|\(paid\)/);
  const withheld = candidate(doc);
  assert.equal(quickBooksOpenItemsAnswer({ question, candidates: [withheld], citationCount: 1, now: NOW }), null);
  assert.deepEqual(statements(quickBooksMoneyPolicy({ docs: [withheld], now: NOW })), []);
  assert.ok(result.warnings.includes("QuickBooks: 1 TotalAmt field(s) withheld by the shared record guard."));
  assert.ok(result.warnings.includes("QuickBooks: 1 Balance field(s) withheld by the shared record guard."));
});

test("Online preserves proven card signs and withholds unproven liability signs", async () => {
  const bank = fixtureRow("Account");
  const result = await collect("Account", [bank, { ...bank, Id: "card-one", Name: "Company Card", AccountType: "Credit Card", CurrentBalance: -75.25 }]);
  const docs = result.documents.map((doc, i) => candidate(doc, i + 1));
  assert.equal(result.documents[0].content.split("\n")[0], FIXTURES[0][2]);
  assert.equal(result.documents[1].content.split("\n")[0], `Credit Card account Company Card: balance USD -75.25 (owes USD 75.25) as of ${SNAPSHOT}.`);
  const combined = quickBooksBalanceAnswer({ question: "What are my bank and credit card balances?", docs, results: docs, now: NOW });
  assert.equal(combined.answer.split("\n").slice(0, 2).join("\n"),
    '"Checking" (Bank): balance USD 1,201.00 as of 2026-10-07 [1].\n"Company Card" (Credit Card): owes USD 75.25 as of 2026-10-07 [2].');
  const answer = quickBooksBalanceAnswer({ question: "What are my bank balances?", docs, results: docs, now: NOW });
  assert.equal(answer.answer.split("\n")[0], '"Checking" (Bank): balance USD 1,201.00 as of 2026-10-07 [1].');
  assert.ok(!result.warnings.some((warning) => warning.includes("CurrentBalance field(s) withheld")));
  const withheld = await collect("Account", [bank, { ...bank, Id: "liability-one", Name: "Company Liability", AccountType: "Other Current Liability", CurrentBalance: -75.25 }]);
  const withheldDocs = withheld.documents.map((doc, i) => candidate(doc, i + 1));
  assert.equal(withheld.documents[1].content.split("\n")[0], "Other Current Liability account Company Liability: balance not provided.");
  assert.doesNotMatch(withheld.documents[1].content, /75\.25|Current Balance:/);
  assert.equal(quickBooksBalanceAnswer({ question: "What are my account balances?", docs: withheldDocs, results: withheldDocs, now: NOW }), null);
  assert.ok(quickBooksBalanceAnswer({ question: "What are my account balances?", docs, results: docs, now: NOW }), "the same account question admits the proven sign controls");
  assert.ok(withheld.warnings.includes("QuickBooks: 1 CurrentBalance field(s) withheld by the shared record guard."));
});

test("every void entity passes through the Online guard before rendering and reconciliation", async () => {
  for (const entity of ["Bill", "CreditMemo", "BillPayment"]) {
    const row = fixtureRow(entity);
    const control = await collect(entity, [row]);
    assert.equal(control.documents[0].content.split("\n")[0], FIXTURES.find(([kind]) => kind === entity)[2]);
    assert.ok(statements(quickBooksMoneyPolicy({ docs: [candidate(control.documents[0])], now: NOW })).length > 0);
    const result = await collect(entity, [{ ...row, TotalAmt: "0.00" }]);
    const doc = result.documents[0];
    assert.match(doc.content.split("\n")[0], /amount not provided/);
    assert.deepEqual(doc.metadata.reconciliation_lines, []);
    assert.deepEqual(statements(quickBooksMoneyPolicy({ docs: [candidate(doc)], now: NOW })), []);
    assert.ok(result.warnings.includes("QuickBooks: 1 TotalAmt field(s) withheld by the shared record guard."));
  }
});

test("reconciliation requires provider currency and counts omitted rows without values", async () => {
  const row = fixtureRow("Purchase");
  const valid = await collect("Purchase", [row]);
  assert.equal(valid.documents[0].metadata.reconciliation_lines.length, 1);
  assert.equal(valid.documents[0].metadata.reconciliation_lines[0].currency, "USD");
  const missing = await collect("Purchase", [{ ...row, CurrencyRef: undefined }, { ...row, Id: "row-two", CurrencyRef: {} }]);
  assert.ok(missing.documents.every((doc) => doc.metadata.reconciliation_lines.length === 0));
  assert.ok(missing.warnings.includes("QuickBooks: 2 record(s): reconciliation lines without a provider currency were omitted."));
  assert.ok(!valid.warnings.some((warning) => warning.includes("without a provider currency")));
});

test("batch file grants cannot forge registered QuickBooks records; owner and upload controls pass", async () => {
  const fixture = await createProductFixture();
  try {
    for (const [name, kind] of [["quickbooks_desktop", "quickbooks"], ["quickbooks", "quickbooks"], ["files", "upload"]]) {
      fixture.raw("INSERT INTO sources(name,kind,status,created_at) VALUES (?,?,'ready',?)", name, kind, SNAPSHOT);
    }
    const token = "synthetic-file-grant";
    fixture.raw("INSERT INTO grants(grant_id,display_name,capabilities,created_at,created_by) VALUES ('filer','Filer','[\"file\"]',?,'owner')", NOW);
    fixture.raw("INSERT INTO grant_credentials(token_hash,grant_id,created_at) VALUES (?,'filer',?)", createHash("sha256").update(token).digest("hex"), NOW);
    const result = await collect("Invoice", [fixtureRow("Invoice")]);
    const docs = ["quickbooks_desktop", "quickbooks", "files"].flatMap((source) => normalizeProviderResult(source, result).documents);
    const response = await fixture.post("/api/admin/brain/ingest/batch", { docs }, { "X-Admin-Key": token });
    assert.equal(response.status, 200, "authenticated file grant reached the batch route");
    const body = await response.json();
    assert.equal(body.results.length, 3);
    assert.equal(body.created, 1, "the same grant actually wrote the ordinary upload control");
    assert.equal(body.refused, 2);
    assert.ok(fixture.seen.sql.some((sql) => /SELECT kind FROM sources WHERE name=/.test(sql)), "registered source kinds reached the refusal decision");
    for (const entry of body.results.slice(0, 2)) {
      assert.equal(entry.status, "refused");
      assert.deepEqual(entry.labels, ["quickbooks_owner_required"]);
    }
    assert.equal(fixture.first("SELECT count(*) AS n FROM documents WHERE source IN ('quickbooks','quickbooks_desktop')").n, 0);
    const owner = await fixture.post("/api/admin/brain/ingest/batch", { docs: docs.slice(0, 2) }, ADMIN);
    assert.equal(owner.status, 200);
    const accepted = await owner.json();
    assert.equal(accepted.created, 2);
    assert.equal(accepted.refused, 0);
    const before = fixture.first("SELECT count(*) AS n FROM documents").n;
    fixture.control.failOn = /SELECT kind FROM sources WHERE name=/;
    const readsBefore = fixture.seen.sql.length;
    const unavailable = await fixture.post("/api/admin/brain/ingest/batch", { docs: [{ ...docs[0], source_id: "invoice:two" }] }, { "X-Admin-Key": token });
    assert.equal(unavailable.status, 500);
    assert.ok(fixture.seen.sql.slice(readsBefore).some((sql) => fixture.control.failOn.test(sql)), "the failing source-kind read was actually attempted");
    assert.equal(fixture.first("SELECT count(*) AS n FROM documents").n, before);
  } finally { fixture.close(); }
});

test("relationship claims use registered kind through actual citation candidates", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  for (const [source, kind, blocked] of [["quickbooks_desktop", "quickbooks", true], ["quickbooks", "quickbooks", true], ["relationship_notes", "upload", false]]) {
    let verifications = 0;
    const fixture = await createProductFixture({ env: { AI: { async run(model, input) {
      if (model.includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
      if (String(input.messages?.[0]?.content).includes("verify a proposed answer")) {
        verifications++;
        return { response: { supported: true, complete: true, evidence: [1], reason: "injected approval" } };
      }
      return { response: "Customer One is an active customer as of 2026-10-07 [1]." };
    } } } });
    try {
      fixture.raw("INSERT INTO sources(name,kind,status,created_at) VALUES (?,?,'ready',?)", source, kind, SNAPSHOT);
      const doc = providerEnvelope(source, "customer:one", { title: "Customer One relationship", content: "Customer One is an active customer.", occurredAt: SNAPSHOT });
      const ingested = await fixture.post("/api/admin/brain/ingest/batch", { docs: [doc] }, ADMIN);
      assert.equal((await ingested.json()).created, 1);
      const response = await fixture.post("/api/rag/think", { q: "Is Customer One an active customer now?" }, ADMIN);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.results.length, 1, "real retrieval reached the relationship document");
      assert.equal(body.results[0].source_kind, kind);
      assert.ok(verifications > 0, "the draft reached the evidence verifier before the relationship guard");
      assert.equal(body.evidence_gate.supported, !blocked);
      if (blocked) assert.equal(body.evidence_gate.reason, "newest cited evidence did not itself support the present-status claim");
      else assert.equal(body.citations[0].source_kind, kind);
    } finally { fixture.close(); }
  }
});

test("owner and support status label either QuickBooks source generically", async () => {
  const status = await ownerSystemStatus({}, {
    health: () => ({ status: "ok" }),
    diagnose: async () => ({}), vectorReadiness: async () => ({}),
    freshness: async () => ({ sources: [
      { name: "quickbooks", kind: "quickbooks", documents: 1, state: "fresh" },
      { name: "quickbooks_desktop", kind: "quickbooks", documents: 1, state: "fresh" },
      { name: "files", kind: "upload", documents: 1, state: "manual" },
    ] }),
  });
  assert.equal(status.sources.length, 3, "both label paths reached source projection");
  assert.deepEqual(status.sources.map((source) => source.label), ["QuickBooks", "QuickBooks", "Files you uploaded"]);
  const support = supportSystemProjection(status);
  assert.deepEqual(support.sources.map((source) => source.label), ["QuickBooks", "QuickBooks", "Files you uploaded"]);
});

test("stored QuickBooks coverage gaps keep a generic label and name the Desktop read remedy", async () => {
  const fixture = await createProductFixture();
  try {
    fixture.raw("INSERT INTO sources(name,kind,status,created_at) VALUES ('quickbooks_desktop','quickbooks','ready',?)", SNAPSHOT);
    const report = await coverageGapReport(fixture.env, { now: NOW });
    assert.equal(report.unavailable, false);
    assert.ok(report.gaps.length > 0, "the registered source reached coverage-gap construction");
    assert.ok(report.gaps.some((gap) => gap.detail.startsWith("The QuickBooks source")));
    assert.ok(report.gaps.some((gap) => gap.remedy.includes("For QuickBooks Desktop, open QuickBooks on the connected PC so the next scheduled read can run.")));
    assert.ok(report.gaps.every((gap) => !gap.detail.includes("QuickBooks Online")));
  } finally { fixture.close(); }
});

// Port of the independent single-ingest custody probe, through the real router,
// provider normalizer, SQLite store and subsequent money-answer route.
for (const route of ["/api/admin/brain/ingest", "/api/admin/brain/ingest/batch"]) {
  test(`registered QuickBooks custody covers ${route} and its following money answer`, async t => {
    t.mock.method(Date, "now", () => NOW);
    const fixture = await createProductFixture();
    try {
      fixture.raw("INSERT INTO sources(name,kind,status,created_at) VALUES ('ledger','quickbooks','ready',?)", SNAPSHOT);
      const token = "synthetic-filing-grant";
      fixture.raw("INSERT INTO grants(grant_id,display_name,capabilities,created_at,created_by) VALUES ('filer','Filer','[\"file\"]',?,'owner')", NOW);
      fixture.raw("INSERT INTO grant_credentials(token_hash,grant_id,created_at) VALUES (?,'filer',?)", createHash("sha256").update(token).digest("hex"), NOW);
      const [doc] = normalizeProviderResult("ledger", await collect("Invoice", [fixtureRow("Invoice")])).documents;
      const send = (document, headers) => fixture.post(route, route.endsWith("/batch") ? { docs: [document] } : document, headers);
      const grant = { "X-Admin-Key": token };
      const before = fixture.seen.sql.length;
      const response = await send(doc, grant);
      const body = await response.json();
      assert.equal(fixture.first("SELECT count(*) AS n FROM documents").n, 0, "a filing grant cannot persist QuickBooks evidence");
      assert.ok(fixture.seen.sql.slice(before).some(sql => /SELECT kind FROM sources WHERE name=/.test(sql)), "registered-kind decision was reached");
      if (route.endsWith("/batch")) {
        assert.equal(response.status, 200); assert.equal(body.refused, 1);
        assert.deepEqual(body.results[0].labels, ["quickbooks_owner_required"]);
      } else {
        assert.equal(response.status, 403); assert.equal(body.code, "quickbooks_owner_required");
      }
      const answerResponse = await fixture.post("/api/rag/think", { q: "Who owes us money in QuickBooks?" }, ADMIN);
      assert.equal(answerResponse.status, 200);
      const answer = await answerResponse.json();
      assert.notEqual(answer.evidence_gate?.supported, true, "the refused write cannot support a money answer");
      assert.equal(answer.citations.length, 0);
      const owner = await send(doc, ADMIN);
      assert.equal(owner.status, 200);
      assert.equal(fixture.first("SELECT count(*) AS n FROM documents").n, 1, "owner control reaches storage");
      const supported = await (await fixture.post("/api/rag/think", { q: "Who owes us money in QuickBooks?" }, ADMIN)).json();
      assert.equal(supported.evidence_gate.supported, true);
      assert.equal(supported.evidence_gate.method, "quickbooks_observed_open_items");
      assert.equal(supported.citations.length, 1);
      const stored = fixture.first("SELECT content_hash FROM documents").content_hash;
      const overwriteBefore = fixture.seen.sql.length;
      await send({ ...doc, content: doc.content + "\nUntrusted amendment." }, grant);
      assert.ok(fixture.seen.sql.slice(overwriteBefore).some(sql => /SELECT kind FROM sources WHERE name=/.test(sql)), "overwrite reached custody decision");
      assert.equal(fixture.first("SELECT content_hash FROM documents").content_hash, stored, "refused overwrite preserves the owner record");
      fixture.control.failOn = /SELECT kind FROM sources WHERE name=/;
      const failedBefore = fixture.seen.sql.length;
      const failed = await send({ ...doc, source_id: "invoice:unavailable" }, grant);
      assert.equal(failed.status, 500);
      assert.ok(fixture.seen.sql.slice(failedBefore).some(sql => fixture.control.failOn.test(sql)), "failing registry lookup was attempted");
      assert.equal(fixture.first("SELECT count(*) AS n FROM documents").n, 1);
      assert.equal(fixture.first("SELECT content_hash FROM documents").content_hash, stored);
    } finally { fixture.close(); }
  });
}
