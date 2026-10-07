import assert from "node:assert/strict";
import test from "node:test";
import { syncQuickBooksOnline, QBO_DEFAULT_ENTITIES } from "../connectors/quickbooks-online.mjs";
import { SNAPSHOT, CHANGED, FIXTURES } from "./fixtures/quickbooks-records.mjs";
import { evidenceLineageValidationError } from "../worker/src/lib/evidence-lineage.js";
import { normalizeProviderResult } from "../connectors/provider-runtime.mjs";
import { quickBooksMoney } from "../connectors/quickbooks-records.mjs";

async function collect(entity, rows, options = {}) {
  let calls = 0;
  const result = await syncQuickBooksOnline({
    realmId: "synthetic-company", accessToken: "synthetic-fixture", entities: [entity],
    snapshotAt: SNAPSHOT, now: () => Date.parse(SNAPSHOT),
    fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({ QueryResponse: { [entity]: rows, maxResults: rows.length } }));
    }, ...options,
  });
  assert.equal(calls, 1, "real adapter reached the injected provider boundary");
  assert.equal(result.documents.length, rows.length);
  return result;
}

test("all configured entities have invented fixtures", () => {
  assert.deepEqual(FIXTURES.map(([kind]) => kind), [...QBO_DEFAULT_ENTITIES]);
});
for (const [kind, row, opening] of FIXTURES) {
  test(`${kind} leads with owner facts and keeps provenance`, async () => {
    const result = await collect(kind, [row]);
    const doc = result.documents[0];
    assert.equal(doc.content.split("\n")[0], opening);
    assert.equal(doc.source_id, `${kind.toLowerCase()}:${row.Id}`);
    assert.equal(doc.metadata.provider_version, CHANGED);
    assert.equal(doc.metadata.evidence_lineage.kind, "source_record");
    assert.equal(doc.text_reliable, true);
    assert.ok(doc.content.includes("QuickBooks"));
    assert.ok(!/SyncToken|\bdomain:|\bsparse:/.test(doc.content));
    const repeat = await collect(kind, [Object.fromEntries(Object.entries(row).reverse())]);
    assert.deepEqual(doc, repeat.documents[0], "key order does not create a revision");
  });
}
test("balance observation dates differ from transaction and provider-change dates", async () => {
  for (const [kind, row] of FIXTURES) {
    const doc = (await collect(kind, [row])).documents[0];
    const balance = ["Account", "Customer", "Vendor", "Invoice", "Bill", "CreditMemo"].includes(kind);
    assert.equal(doc.occurred_at, balance ? SNAPSHOT : CHANGED);
    assert.equal(doc.date_source, balance ? "quickbooks:balance_snapshot" : "quickbooks:provider_timestamp");
    assert.equal(doc.metadata.transaction_date, row.TxnDate || null);
    assert.equal(doc.metadata.provider_version, CHANGED);
  }
});
test("title collision has a stable tie breaker, even after truncation", async () => {
  const row = FIXTURES.find(([kind]) => kind === "BillPayment")[1];
  const docs = (await collect("BillPayment", [row, { ...row, Id: "row-two" }])).documents;
  assert.notEqual(docs[0].source_id, docs[1].source_id);
  assert.notEqual(docs[0].title, docs[1].title);
  for (const doc of docs) {
    assert.match(doc.title, /BillPayment.*1016.*Vendor One.*2026-07-23.*USD 75\.00/);
    assert.ok(doc.title.length <= 200);
    assert.ok(!doc.title.includes("\u2014"));
  }
  const long = { ...row, VendorRef: { name: "Long party ".repeat(200) } };
  const bounded = (await collect("BillPayment", [long, { ...long, Id: "row-two" }])).documents;
  assert.notEqual(bounded[0].title, bounded[1].title);
  assert.ok(bounded.every((doc) => doc.title.length <= 200));
});
test("paid, partial, missing and credit balances remain distinct", async () => {
  const row = FIXTURES.find(([kind]) => kind === "Invoice")[1];
  for (const [Balance, status] of [[0, "paid"], [25, "partially paid"], [75, "unpaid"], [-5, "credit balance"], [undefined, "balance not provided"]]) {
    const doc = (await collect("Invoice", [{ ...row, Balance }])).documents[0];
    assert.ok(doc.content.split("\n")[0].includes(status));
    if (Balance === undefined) assert.equal(doc.occurred_at, CHANGED);
  }
});
test("snapshot timestamps reject malformed and future observations", async () => {
  const row = FIXTURES[0][1];
  let reached = 0;
  for (const snapshotAt of ["yesterday", "2026-02-30T00:00:00.000Z", "2027-01-01T00:00:00.000Z"]) {
    reached++;
    await assert.rejects(collect("Account", [row], { snapshotAt }), /snapshot timestamp/i);
  }
  assert.equal(reached, 3);
  assert.equal((await collect("Account", [row])).documents[0].occurred_at, SNAPSHOT);
});
test("long details stay bounded with visible omission and leading balance", async () => {
  const row = FIXTURES.find(([kind]) => kind === "Invoice")[1];
  const doc = (await collect("Invoice", [{ ...row, CustomField: Array.from({ length: 1000 }, (_, i) => ({ Name: `Field ${i}`, StringValue: "Supplementary information ".repeat(20) })) }])).documents[0];
  assert.match(doc.content.slice(0, 900), /Customer One.*open balance USD 75\.00/);
  assert.ok(doc.content.length < 32000);
  assert.match(doc.content, /omitted.*bounded/i);
});
test("re-sync preserves identity and reconciliation fields, with no deletion authority", async () => {
  for (const [kind, row] of FIXTURES) {
    const before = await collect(kind, [row]);
    const after = await collect(kind, [{ ...row, Balance: 0 }], { snapshotAt: "2026-10-07T12:01:00.000Z", now: () => Date.parse("2026-10-07T12:01:00.000Z") });
    assert.equal(before.documents[0].source_id, after.documents[0].source_id);
    assert.deepEqual(before.documents[0].metadata.reconciliation_lines, after.documents[0].metadata.reconciliation_lines);
    assert.deepEqual(after.deletions, []);
    assert.equal(after.deletion_authority, "unavailable");
    const renamed = normalizeProviderResult("books_secondary", after);
    assert.deepEqual(renamed.documents[0].metadata.evidence_lineage.root_ids, [`books_secondary:${after.documents[0].source_id}`]);
  }
});
test("summary boundary is explicit: no invented complete list or truncated lineage", async () => {
  const row = FIXTURES.find(([kind]) => kind === "Invoice")[1];
  const result = await collect("Invoice", Array.from({ length: 17 }, (_, i) => ({ ...row, Id: `invoice-${i}` })));
  assert.equal(result.walk_complete, true);
  const roots = result.documents.map((doc) => `quickbooks:${doc.source_id}`);
  const lineage = (root_ids) => ({ evidence_lineage: { version: 1, kind: "derived_record", root_ids } });
  assert.equal(evidenceLineageValidationError(lineage(roots.slice(0, 16))), null);
  assert.match(evidenceLineageValidationError(lineage(roots)), /root_ids/);
  assert.ok(result.documents.every((doc) => doc.metadata.evidence_lineage.kind === "source_record"));
  assert.ok(result.warnings.some((warning) => /complete.*list|list.*complete/i.test(warning)));
});

test("line descriptions and account references precede noisy ancillary fields", async () => {
  const row = FIXTURES.find(([kind]) => kind === "Payment")[1];
  const doc = (await collect("Payment", [{ ...row,
    CustomField: Array.from({ length: 500 }, (_, i) => ({ Name: `Field ${i}`, StringValue: "Supplementary ".repeat(100) })),
    Line: [{ Amount: 75, Description: "Quarterly hosting", AccountBasedExpenseLineDetail: { AccountRef: { value: "hosting", name: "Hosting expense" } } }],
  }])).documents[0];
  assert.match(doc.content.slice(0, 1500), /Quarterly hosting/);
  assert.match(doc.content.slice(0, 1500), /Hosting expense/);
});

test("money preserves sign and decimal precision without assuming an absent currency", () => {
  assert.equal(quickBooksMoney("9007199254740993.01", { value: "USD" }), "USD 9,007,199,254,740,993.01");
  assert.equal(quickBooksMoney(-1250.5, { value: "EUR" }), "EUR -1,250.50");
  assert.equal(quickBooksMoney("0.125", { value: "KWD" }), "KWD 0.125");
  assert.equal(quickBooksMoney(75, null), "currency unspecified 75.00");
  assert.equal(quickBooksMoney(null, { value: "USD" }), "amount not provided");
  assert.equal(quickBooksMoney(Infinity, { value: "USD" }), "amount not provided");
});

test("snapshot dating does not inherit a future provider last-change date", async () => {
  const future = "2026-11-11T06:59:57.000Z";
  const row = { ...FIXTURES[0][1], MetaData: { LastUpdatedTime: future } };
  const doc = (await collect("Account", [row])).documents[0];
  assert.equal(doc.occurred_at, SNAPSHOT);
  assert.equal(doc.metadata.provider_version, future);
  assert.match(doc.content, /Provider last changed: 2026-11-11T06:59:57\.000Z/);
});

test("partial-payment status compares exact decimal amounts", async () => {
  const row = FIXTURES.find(([kind]) => kind === "Invoice")[1];
  const doc = (await collect("Invoice", [{ ...row, TotalAmt: "9007199254740992.01", Balance: "9007199254740992.00" }])).documents[0];
  assert.match(doc.content.split("\n")[0], /partially paid/);
});
