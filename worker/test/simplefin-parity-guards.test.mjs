import test from "node:test";
import assert from "node:assert/strict";
import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";
import { claimSimpleFinAccess, runSimpleFinMaintenance, assignSimpleFinAccountEntity, promoteSimpleFinWindows } from "../src/lib/simplefin-bank-feed.js";
import { buildParityLedgers, NOW } from "./fixtures/simplefin-parity.mjs";

async function feed(t, definitions = [{ id: "fixture", name: "Business Checking", balance: "25.00" }]) {
  const f = await createProductFixture({ env: { BANK_FEED_PROVIDER: "simplefin", BANK_FEED_ENV: "production",
    BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`, BRAIN_TIMEZONE: "UTC" } });
  t.after(() => f.close());
  seedOwnedEntity(f, "store", "Store");
  let fetches = 0;
  const access = new URL("https://bridge.example.invalid/simplefin/guard");
  access.username = "fixture-user"; access.password = "fixture-pass";
  const claim = await claimSimpleFinAccess(f.env, { requestId: "parity-guard-claim-0001", setupToken: btoa("https://bridge.example.invalid/claim/guard"), now: NOW,
    fetchImpl: async () => new Response(access.href) });
  const item = claim.body.item_ref;
  const pull = async ({ partial = false, unread = false, omit = false, fail = false } = {}) => {
    f.raw("UPDATE simplefin_connections SET next_pull_at=?", NOW);
    return runSimpleFinMaintenance(f.env, { now: NOW, maxRequestsPerItem: 1, fetchImpl: async request => {
      fetches++;
      if (fail) throw new Error("synthetic transport interruption");
      const from = Number(new URL(request.url).searchParams.get("start-date"));
      return Response.json({ errlist: partial ? ["temporary provider gap"] : [], accounts: omit ? [] : definitions.map(a => ({
        ...a, currency: "USD", "balance-date": from + 43200,
        transactions: [{ id: `transaction-${from}`, posted: from + 43200,
          amount: unread ? "not-money" : "-1.23", description: "Fixture purchase", payee: "Fixture Vendor" }],
      })) });
    } });
  };
  await pull();
  for (const row of f.rows("SELECT account_ref FROM simplefin_account_assignments")) await assignSimpleFinAccountEntity(f.env, {
    request_id: `assign-${row.account_ref}`, account_ref: row.account_ref, entity_slug: "store",
  }, { now: NOW });
  return { f, item, pull, fetches: () => fetches };
}

test("account-name rules work across labels, preserve overdrafts, and refuse ambiguous or contrary evidence", async t => {
  const { f } = await feed(t, [
    { id: "overdraft", name: "Operating Checking", balance: "-12.00" },
    { id: "savings", name: "Reserve Savings Account", balance: "40.00" },
    { id: "card", name: "Travel Credit Card", balance: "-56.00" },
    { id: "loan", name: "Equipment Loan", balance: "-78.00" },
    { id: "credit", name: "Working Line of Credit", balance: "-90.00" },
    { id: "generic", name: "Everyday Card", balance: "-1.00" },
    { id: "negative", name: "Main Account", balance: "-2.00" },
    { id: "ambiguous", name: "Checking Credit Card", balance: "-3.00" },
    { id: "contrary", name: "Credit Card", balance: "4.00" },
    { id: "missing", name: "Loan Account", balance: null },
  ]);
  const expected = ["checking", "savings", "card", "loan", "line_of_credit", "other", "other", "other", "other", "other"];
  for (const [index, row] of f.rows("SELECT account_label,account_ref FROM simplefin_account_assignments ORDER BY rowid").entries()) {
    const account = f.first("SELECT * FROM fin_accounts WHERE external_ref=?", row.account_ref);
    assert.equal(account.account_kind, expected[index], row.account_label);
    assert.equal(account.balance_role, index < 2 ? "asset" : index < 5 ? "liability" : "neither");
  }
  const balances = f.rows("SELECT a.label,b.current_minor FROM fin_accounts a JOIN fin_balance_snapshots b ON b.account_slug=a.account_slug");
  assert.equal(balances.find(r => r.label === "Operating Checking").current_minor, -1200, "negative cash remains an overdraft");
  assert.equal(balances.find(r => r.label === "Travel Credit Card").current_minor, 5600, "explicit debt is an amount owed");
});

test("an unread amount, partial response and failed replacement cannot certify coverage; corrected data recovers", async t => {
  const { f, item, pull, fetches } = await feed(t);
  assert.equal(f.first("SELECT coverage_status FROM fin_account_coverage").coverage_status, "complete", "green receipt control");
  for (const fault of [{ unread: true }, { partial: true }, { fail: true }]) {
    // Replay the same first window to exercise replacement, not a fresh range.
    f.raw("UPDATE simplefin_connections SET backfill_next=backfill_start");
    const before = fetches();
    await pull(fault);
    assert.equal(fetches(), before + 1, "negative control reached the provider decision");
    assert.equal(f.first("SELECT coverage_status FROM fin_account_coverage").coverage_status, "partial");
    assert.ok(f.first("SELECT count(*) AS n FROM fin_transactions").n > 0, "saved data remains visible");
    f.raw("UPDATE simplefin_connections SET backfill_next=backfill_start");
    await pull();
    assert.equal(f.first("SELECT coverage_status FROM fin_account_coverage").coverage_status, "complete", "successful replacement restores exact coverage");
  }
  assert.equal(f.first("SELECT status FROM bank_feed_items WHERE item_ref=?", item).status, "connected");
});

test("an account absent from an intervening response leaves a coverage gap", async t => {
  const { f, pull, fetches } = await feed(t);
  const first = f.first("SELECT covered_from,covered_to FROM fin_account_coverage");
  await pull({ omit: true });
  await pull();
  const latest = f.first("SELECT covered_from,covered_to,coverage_status FROM fin_account_coverage");
  assert.equal(fetches(), 3, "the absent window and returning account were both read");
  assert.equal(latest.coverage_status, "complete", "the returning bounded segment is proved");
  assert.ok(latest.covered_from > first.covered_to, "the missing middle is never bridged by a min/max envelope");
});

test("a revision racing coverage publication rolls back the attempted completeness claim", async t => {
  const { f, item } = await feed(t);
  f.raw("UPDATE fin_account_coverage SET coverage_status='partial'");
  const batch = f.DB.batch;
  let guards = 0;
  f.DB.batch = async statements => {
    if (statements.some(s => /AS coverage_guard/.test(s.sql))) {
      guards++;
      f.raw("UPDATE simplefin_sync_windows SET staging_revision='racing-replacement' WHERE item_ref=?", item);
    }
    return batch(statements);
  };
  await assert.rejects(promoteSimpleFinWindows(f.env, { itemRef: item, now: NOW }), /malformed JSON/);
  assert.equal(guards, 1, "the exact publication decision was reached");
  assert.equal(f.first("SELECT coverage_status FROM fin_account_coverage").coverage_status, "partial");
  f.DB.batch = batch;
  f.raw("UPDATE simplefin_sync_windows SET staging_revision=revision WHERE item_ref=?", item);
  await promoteSimpleFinWindows(f.env, { itemRef: item, now: NOW });
  assert.equal(f.first("SELECT coverage_status FROM fin_account_coverage").coverage_status, "complete", "green exact-revision control");
});

test("coverage publication stays inside the existing bounded D1 batch size for a large inventory", async t => {
  const { f, item } = await feed(t, Array.from({ length: 63 }, (_, index) => ({
    id: `account-${index}`, name: `Fixture ${index} Checking`, balance: "20.00",
  })));
  assert.equal(f.first("SELECT count(*) AS n FROM fin_accounts").n, 63, "nonempty large inventory control");
  const batch = f.DB.batch;
  let publications = 0;
  f.DB.batch = async statements => {
    if (statements.some(s => /AS coverage_guard/.test(s.sql))) {
      publications++;
      assert.ok(statements.length <= 51, "coverage repeats its fence within the existing 50-write chunk bound");
    }
    return batch(statements);
  };
  await promoteSimpleFinWindows(f.env, { itemRef: item, now: NOW });
  assert.equal(publications, 2, "both publication slices reached the fenced write decision");
  assert.equal(f.first("SELECT count(*) AS n FROM fin_account_coverage WHERE coverage_status='complete'").n, 63);
});

test("description-only SimpleFIN data offers matching rows without guessing vendor identity or categories", async t => {
  const run = await buildParityLedgers({ payees: false });
  t.after(() => run.close());
  const reply = await run.ask(run.simple, "How much did I spend at Lumen Supply last month?");
  assert.ok(reply.reads.some(sql => /JOIN fin_transactions/.test(sql)), "vendor attribution reached real rows");
  assert.equal(reply.body.ledger?.kind, "merchant");
  assert.equal(Object.hasOwn(reply.body.ledger, "total_minor"), false);
  assert.equal(reply.body.ledger.match_basis, "possible");
  assert.equal(reply.body.ledger.possible_match_count, 31);
  assert.match(reply.body.answer, /unconfirmed|no store total is confirmed/i);
  assert.ok(run.simple.rows("SELECT category FROM fin_transactions").every(row => row.category === null));
  const control = await run.ask(run.plaid, "How much did I spend at Lumen Supply last month?");
  assert.equal(control.body.ledger.total_minor, run.oracle.vendor, "structured payee control establishes the vendor");
});
