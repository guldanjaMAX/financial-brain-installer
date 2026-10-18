import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";
import { classifyLedgerQuestion } from "../src/lib/ledger-question.js";
import { withLedgerAnswer } from "../src/lib/ledger-answer.js";
import { readEffectiveAccounts, readEffectiveTransactions } from "../src/lib/ledger-reader.js";

import { linkAccounts } from "./fixtures/money-fix/fixture.mjs";

const NOW = "2026-10-11T12:00:00.000Z";
const stamp = "2026-10-11T10:00:00.000Z";
test.before(() => mock.method(Date, "now", () => Date.parse(NOW)));
test.after(() => mock.restoreAll());
const fallback = async () => new Response(JSON.stringify({ answer: null, citations: [], gaps: [] }));
const direct = (f, question, extra = {}) => withLedgerAnswer({ env: f.env, question,
  grantScope: { all: true }, scopePrincipalKind: "owner", now: NOW, ...extra }, fallback).then(r => r.json());

async function fixtureFor(t) {
  const fixture = await createProductFixture({ env: {
    ADMIN_KEY: randomBytes(24).toString("hex"),
    SESSION_SIGNING_KEY: randomBytes(32).toString("hex"),
    RAG_PROXY_KEY: randomBytes(24).toString("hex"),
    AI: { async run(model) {
      if (String(model).includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
      return { response: "The documents do not answer the question." };
    } },
  } });
  t.after(() => fixture.close());
  seedOwnedEntity(fixture, "owner-company", "Owner Company");
  fixture.raw(`INSERT INTO bank_feed_items
    (item_ref,institution_label,access_ciphertext,access_iv,environment,connected_at,last_synced_at)
    VALUES ('fixture-feed','Fixture Bank',?,?,'sandbox',?,?)`,
  randomBytes(32).toString("base64"), randomBytes(12).toString("base64"), stamp, stamp);
  for (const [slug, mode, start, end] of [
    ["manual-account", "manual", "2026-08-01", "2026-09-30"],
    ["live-account", "live", "2026-09-01", "2026-10-11"],
  ]) {
    fixture.raw(`INSERT INTO fin_accounts
      (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at,institution)
      VALUES (?,'owner-company','checking','asset','4321',?,'feed','bank-feed:fixture-feed','confirmed',?,'Fixture Bank')`, slug, mode, stamp);
    fixture.raw(`INSERT INTO fin_account_coverage
      (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES (?,'complete',?,?,?,'owner_stated','confirmed',?)`, slug, start, end, stamp, stamp);
  }
  const add = (id, account, date, cents, direction = "inflow", description = "Fixture payer deposit") => fixture.raw(
    `INSERT INTO fin_transactions
      (txn_uid,account_slug,posted_on,amount_minor,direction,description,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,?,?,?,?,?,'feed','bank-feed:fixture-feed','confirmed',?)`, id, account, date, cents, direction, description, stamp);
  add("older-manual", "manual-account", "2026-08-31", 1100);
  add("duplicate-manual", "manual-account", "2026-09-15", 12001);
  add("live-deposit", "live-account", "2026-09-15", 12001);
  add("live-debit", "live-account", "2026-09-16", 2300, "outflow", "Fixture transfer");
  fixture.raw(`INSERT INTO fin_balance_snapshots
    (account_slug,as_of_date,current_minor,available_minor,provenance,source_feed,basis_state,recorded_at)
    VALUES ('live-account','2026-10-11',98765,98000,'feed','bank-feed:fixture-feed','confirmed',?)`, stamp);
  fixture.ask = (q, extra = {}, headers = { "X-Admin-Key": fixture.env.ADMIN_KEY }) =>
    fixture.post("/api/rag/think", { q, ...extra }, headers);
  fixture.add = add;
  await linkAccounts(fixture);
  return fixture;
}

test("Think reads the latest balance directly, with ledger citation and no model call", async (t) => {
  const f = await fixtureFor(t);
  let modelCalls = 0;
  f.env.AI.run = async () => { modelCalls++; throw new Error("model must not draft money"); };
  const response = await f.ask("What is my current balance?");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.answer || "", /987\.65/);
  assert.match(body.answer, /2026-10-11/);
  assert.equal(body.citations[0].source_kind, "ledger");
  assert.equal(body.citations[0].last_synced_at, stamp);
  assert.equal(body.citations[0].account_mask, "4321");
  assert.equal(modelCalls, 0);
});

test("Think totals exclude the manual twin inside live coverage", async (t) => {
  const f = await fixtureFor(t);
  const before = f.sqlite.prepare("SELECT total_changes() AS n").get().n;
  const body = await (await f.ask("How much money came in and went out in September 2026?")).json();
  assert.equal(body.ledger?.accounts.length, 1);
  assert.equal(body.ledger.accounts[0].credits_minor, 12001);
  assert.equal(body.ledger.accounts[0].debits_minor, 2300);
  assert.match(body.answer, /no rows were removed as transfers/);
  assert.ok(f.seen.sql.some(sql => /fin_transactions/.test(sql)), "transaction decision was reached");
  assert.equal(f.sqlite.prepare("SELECT total_changes() AS n").get().n, before);
});

test("Think payment matches exact cents and returns bounded absence", async (t) => {
  const f = await fixtureFor(t);
  const found = await (await f.ask("Did the payment of $120.01 arrive on September 15, 2026?")).json();
  assert.equal(found.ledger?.found, true);
  const absent = await (await f.ask("Did the payment of $120.02 arrive on September 15, 2026?")).json();
  assert.equal(absent.ledger?.found, false);
  assert.match(absent.answer, /no matching deposit/i);
  assert.match(absent.answer, /2026-09-08.*2026-09-22/);
  assert.match(absent.answer, /covers through.*2026-10-11/);
  assert.ok(f.seen.sql.filter(sql => /fin_transactions/.test(sql)).length >= 2);
});

test("reader preserves manual rows outside both live-window edges and records each supplier", async (t) => {
  const f = await fixtureFor(t);
  f.add("later-manual", "manual-account", "2026-10-12", 700);
  f.add("first-manual", "manual-account", "2026-09-01", 800);
  f.add("last-manual", "manual-account", "2026-10-11", 900);
  const accounts = await readEffectiveAccounts(f.env);
  assert.equal(accounts.length, 1);
  const rows = await readEffectiveTransactions(f.env, accounts, { from: "2026-08-01", to: "2026-10-31" });
  assert.deepEqual(rows.map(r => [r.posted_on, r.amount_minor, r.source_account_slug]), [
    ["2026-08-31", 1100, "manual-account"], ["2026-09-15", 12001, "live-account"],
    ["2026-09-16", 2300, "live-account"], ["2026-10-12", 700, "manual-account"],
  ]);
  const older = await direct(f, "How much money came in August 2026?");
  assert.equal(older.ledger.accounts[0].credits_minor, 1100);
  assert.equal(older.citations[0].supplied_by, "manual");
});

test("all period shapes use an injected UTC calendar and covered zero periods stay explicit", async (t) => {
  const f = await fixtureFor(t);
  for (const [q, from, to, credits] of [
    ["How much money came in last month?", "2026-09-01", "2026-09-30", 12001],
    ["How much money went out last 10 days?", "2026-10-02", "2026-10-11", 0],
    ["How much money came in so far this year?", "2026-01-01", "2026-10-11", null],
  ]) {
    const intent = classifyLedgerQuestion(q, { now: NOW });
    assert.equal(intent.from, from); assert.equal(intent.to, to);
    const body = await direct(f, q);
    if (credits === null) {
      assert.equal(body.gaps[0].type, "ledger_out_of_coverage");
      assert.equal(body.gaps[0].accounts[0].covered_to, "2026-10-11");
    } else {
      assert.equal(body.ledger.accounts[0].credits_minor, credits);
      assert.equal(body.ledger.includes_own_transfers, true);
    }
  }
  f.raw("UPDATE fin_account_coverage SET covered_from='2026-01-01' WHERE account_slug='manual-account'");
  assert.equal((await direct(f, "How much money came in so far this year?")).ledger.accounts[0].credits_minor, 13101);
});

test("payment edges are inclusive, optional mask and counterparty are exact, and defaults are 30 days", async (t) => {
  const f = await fixtureFor(t);
  for (const [id, date] of [["before", "2026-09-07"], ["start", "2026-09-08"], ["end", "2026-09-22"], ["after", "2026-09-23"]]) {
    f.add(id, "live-account", date, 5011, "inflow", "Fixture payer deposit");
  }
  const body = await direct(f, "Did the payment of $50.11 from Fixture payer arrive on 2026-09-15 in account 4321?");
  assert.equal(body.ledger.found, true);
  assert.deepEqual(body.citations.map(c => c.posted_on), ["2026-09-08", "2026-09-22"]);
  const wrongPayer = await direct(f, "Did the payment of $50.11 from Different payer arrive on 2026-09-15?");
  // Every in-scope inflow remains visible; an amount filter cannot prove payer absence.
  assert.equal(wrongPayer.ledger.found, null);
  assert.equal(wrongPayer.ledger.inflow_count, 3);
  assert.deepEqual(wrongPayer.citations.map(c => c.posted_on), ["2026-09-22", "2026-09-15", "2026-09-08"]);
  const wrongMask = await direct(f, "Did the payment of $50.11 arrive on 2026-09-15 in account 9999?");
  assert.equal(wrongMask.gaps[0].reason, "no_accounts");
  assert.equal((await direct(f, "Did the payment of $120.01 arrive?")).ledger.found, true);
  assert.deepEqual([classifyLedgerQuestion("Did the payment of $120.01 arrive?", { now: NOW }).from,
    classifyLedgerQuestion("Did the payment of $120.01 arrive?", { now: NOW }).to], ["2026-09-12", "2026-10-11"]);
  assert.equal((await direct(f, "Did the payment of $120.00 arrive?")).ledger.found, false);
});

test("ambiguous and missing accounts, missing balances, unreadable and partial coverage fall through", async (t) => {
  const f = await fixtureFor(t);
  const control = await direct(f, "What is my balance?");
  assert.equal(control.ledger.kind, "balance");
  f.raw("UPDATE fin_balance_snapshots SET basis_state='unparsed',unparsed_reason='fixture',current_minor=NULL,available_minor=NULL");
  assert.equal((await direct(f, "What is my balance?")).gaps[0].reason, "balance_unavailable");
  f.raw("UPDATE fin_account_coverage SET coverage_status='partial' WHERE account_slug='live-account'");
  assert.equal((await direct(f, "How much money came in September 2026?")).gaps[0].type, "ledger_out_of_coverage");
  f.raw("UPDATE fin_account_coverage SET coverage_status='complete'");
  f.raw("UPDATE fin_transactions SET basis_state='unparsed',unparsed_reason='fixture',amount_minor=NULL,direction=NULL WHERE txn_uid='live-deposit'");
  assert.equal((await direct(f, "How much money came in September 2026?")).gaps[0].reason, "unreadable_transactions");
  f.raw("UPDATE fin_accounts SET feed_mode='live' WHERE account_slug='manual-account'");
  assert.equal((await direct(f, "What is my balance?")).gaps[0].reason, "ledger_account_link_required");
  f.raw("UPDATE fin_accounts SET superseded_by_id=999");
  assert.equal((await direct(f, "What is my balance?")).gaps[0].reason, "no_accounts");
  assert.ok(f.seen.sql.some(sql => /fin_balance_snapshots/.test(sql)));
  assert.ok(f.seen.sql.some(sql => /fin_transactions/.test(sql)));
});

test("proxy, grant, excluded owner and filtered owner reach refusal without a ledger read", async (t) => {
  const f = await fixtureFor(t);
  assert.equal((await (await f.ask("What is my balance?")).json()).ledger.kind, "balance");
  const start = f.seen.sql.length;
  const proxy = await (await f.ask("What is my balance?", {}, { "X-Admin-Key": f.env.RAG_PROXY_KEY })).json();
  assert.equal(proxy.access.principal, "proxy");
  assert.equal(proxy.gaps[0].reason, "retrieval_scope_restricted");
  assert.equal(f.seen.sql.slice(start).some(sql => /FROM fin_accounts/.test(sql)), false);
  for (const scope of [
    { scopePrincipalKind: "grant" }, { grantScope: { all: true, exclude: ["medical"] } },
    { access: { documentIds: ["fixture-doc"] } }, { filters: { source: "drive" } },
    { entityScope: { applied: true } }, { grantScope: null },
  ]) {
    const before = f.seen.sql.length;
    const response = await direct(f, "What is my balance?", scope);
    assert.equal(response.gaps[0].reason, "retrieval_scope_restricted");
    assert.equal(response.gaps[0].accounts.length, 0);
    assert.equal(f.seen.sql.length, before);
  }
});

test("ordinary non-money Think response is byte-identical with and without a populated ledger", async (t) => {
  t.mock.method(performance, "now", () => 0);
  t.mock.method(crypto, "randomUUID", () => "00000000-0000-4000-8000-000000000000");
  const f = await fixtureFor(t);
  const start = f.seen.sql.length;
  const populated = await (await f.ask("Where is the meeting agenda?")).text();
  assert.ok(f.seen.sql.length > start, "the normal retrieval decision was reached");
  assert.equal(f.seen.sql.slice(start).some(sql => /FROM fin_accounts/.test(sql)), false);
  f.raw("DELETE FROM fin_transactions"); f.raw("DELETE FROM fin_accounts");
  const empty = await (await f.ask("Where is the meeting agenda?")).text();
  assert.equal(populated, empty);
  const expected = new Response('{"answer":"control", "gaps":[]}');
  const actual = await withLedgerAnswer({ env: f.env, question: "Where is the meeting agenda?" }, async () => expected);
  assert.equal(actual, expected);
});

test("money fallback gap leads even when documents carry an old reliable date", async (t) => {
  const f = await fixtureFor(t);
  const q = "How much money came in September 2026?";
  f.raw("UPDATE fin_transactions SET basis_state='proposed' WHERE txn_uid='live-deposit'");
  f.raw(`INSERT INTO documents (doc_uid,source,source_id,title,ingested_at,content_hash,meta,document_date,date_source,date_reliable)
    VALUES ('fixture:money','upload','money','Money expenses',?,'fixture','{}',?,'content',1)`, Date.parse("2026-01-01T00:00:00Z"), Date.parse("2026-01-01T00:00:00Z"));
  f.raw(`INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title,document_date)
    VALUES ('fixture:money#0','fixture:money',0,'Money expenses historical record','upload','Money expenses',?)`, Date.parse("2026-01-01T00:00:00Z"));
  const body = await (await f.ask(q)).json();
  assert.equal(body.gaps[0].type, "ledger_not_consulted");
  assert.equal(body.gaps[0].accounts[0].last_synced_at, stamp);
  const stale = body.gaps.find(g => g.type === "stale");
  assert.ok(stale, "dated retrieval reached the stale-gap decision");
  assert.match(stale.detail, /retrieved document.*does not measure bank-feed freshness/);
});

test("pending, removed and superseded transactions never count; descriptions redact account numbers", async (t) => {
  const f = await fixtureFor(t);
  for (const id of ["pending", "removed", "superseded"]) f.add(id, "live-account", "2026-09-15", 12001);
  f.raw("UPDATE fin_transactions SET pending=1 WHERE txn_uid='pending'");
  f.raw("UPDATE fin_transactions SET removed_at=?,removal_reason='fixture' WHERE txn_uid='removed'", stamp);
  f.raw("UPDATE fin_transactions SET superseded_by_id=999 WHERE txn_uid='superseded'");
  const number = Array.from({ length: 12 }, (_, i) => i % 10).join("");
  f.raw("UPDATE fin_transactions SET description=? WHERE txn_uid='live-deposit'", `Deposit account ${number}`);
  const body = await direct(f, "Did the payment of $120.01 arrive on 2026-09-15?");
  assert.equal(body.citations.length, 1);
  assert.ok(!JSON.stringify(body).includes(number));
  assert.match(body.answer, /redacted/);
});

test("mutation controls kill dedup exclusion and exact amount comparison in real SQLite", async (t) => {
  const f = await fixtureFor(t);
  const accounts = await readEffectiveAccounts(f.env);
  const source = readFileSync(new URL("../src/lib/ledger-reader.js", import.meta.url), "utf8");
  assert.ok(source.includes("NOT (t.posted_on BETWEEN"));
  assert.ok(source.includes("t.amount_minor = ?5"));
  const mutations = [
    ["dedup", sql => sql.replace("NOT (t.posted_on BETWEEN", "(t.posted_on BETWEEN"), null, 24002],
    ["amount", sql => sql.replace("t.amount_minor = ?5", "t.amount_minor <> ?5"), 12002, 12001],
  ];
  for (const [name, mutate, amountMinor, expected] of mutations) {
    let changed = 0;
    const mutant = { DB: { batch: f.env.DB.batch, prepare(sql) {
      const altered = mutate(sql); if (altered !== sql) changed++;
      return f.env.DB.prepare(altered);
    } } };
    const options = { from: "2026-09-01", to: "2026-09-30", amountMinor };
    const control = await readEffectiveTransactions(f.env, accounts, options);
    const rows = await readEffectiveTransactions(mutant, accounts, options);
    const credits = list => list.filter(r => r.direction === "inflow").reduce((sum, r) => sum + r.amount_minor, 0);
    assert.equal(changed, 1, `${name} mutation reached its decision`);
    assert.equal(credits(control), amountMinor === null ? 12001 : 0);
    assert.equal(credits(rows), expected);
    assert.notEqual(credits(rows), credits(control));
  }
});

test("classifier refuses unsupported qualifiers instead of widening money questions", () => {
  assert.equal(classifyLedgerQuestion("What's my balance?", { now: NOW }).kind, "balance");
  assert.equal(classifyLedgerQuestion("Did the payment of $120.01 arrive on 15 September 2026?", { now: NOW }).from, "2026-09-08");
  for (const question of [
    "How much money came in September 2026 and October 2026?",
    "How much money came in September 2026 at Fixture Bank?",
    "How much money came in September 2026 in the payroll account?",
    "How much money came in September 2026 from Fixture payer?",
    "Did the payment of $120.01 arrive in September?",
    "Did the payment of $120.01 arrive at Fixture Bank on 2026-09-15?",
    "Did the payment of $120.01 arrive before 2026-09-15?",
    "Did the payment of $120.012 arrive on 2026-09-15?",
    "Did the payment of $120.01 and $120.02 arrive on 2026-09-15?",
    "What is the balance for account 123456789?",
  ]) {
    const intent = classifyLedgerQuestion(question, { now: NOW });
    assert.equal(intent.broad, true);
    assert.equal(intent.kind, null, question);
  }
});

test("all twin members must be confirmed and the configured tenant must be used", async (t) => {
  const f = await fixtureFor(t);
  assert.equal((await direct(f, "What is my balance?")).ledger.kind, "balance");
  f.raw("UPDATE fin_accounts SET basis_state='proposed' WHERE account_slug='manual-account'");
  assert.equal((await direct(f, "How much money came in September 2026?")).gaps[0].reason, "ledger_account_link_required");
  f.env.BANK_FEED_TENANT = "second-owner";
  assert.equal((await direct(f, "What is my balance?")).gaps[0].reason, "no_accounts");
});

test("latest snapshot wins across twins, and different kinds and entities do not merge", async (t) => {
  const f = await fixtureFor(t);
  f.raw(`INSERT INTO fin_balance_snapshots
    (account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at)
    VALUES ('manual-account','2026-10-12',65432,'owner_stated','confirmed','2026-10-12T12:00:00Z')`);
  const body = await direct(f, "What are my current balances?");
  assert.equal(body.ledger.accounts.length, 1);
  assert.equal(body.ledger.accounts[0].current_minor, 65432);
  assert.equal(body.citations[0].supplied_by, "manual");
  await linkAccounts(f, "manual-account", "live-account", true);
  f.raw("UPDATE fin_accounts SET account_kind='savings' WHERE account_slug='manual-account'");
  assert.equal((await readEffectiveAccounts(f.env)).length, 2);
  assert.equal((await direct(f, "What is my balance for account 4321?")).gaps[0].reason, "ambiguous_account");
  assert.equal((await direct(f, "What is my checking balance for account 4321?")).ledger.accounts[0].current_minor, 98765);
  seedOwnedEntity(f, "second-company", "Second Company");
  f.raw("UPDATE fin_accounts SET account_kind='checking',entity_slug='second-company' WHERE account_slug='manual-account'");
  assert.equal((await readEffectiveAccounts(f.env)).length, 2);
});

test("coverage holes and failed reads cannot become a zero total", async (t) => {
  const f = await fixtureFor(t);
  assert.equal((await direct(f, "How much money came in August 2026?")).ledger.accounts[0].credits_minor, 1100);
  f.raw("UPDATE fin_account_coverage SET covered_to='2026-08-20' WHERE account_slug='manual-account'");
  assert.equal((await direct(f, "How much money came in August 2026?")).gaps[0].type, "ledger_out_of_coverage");
  f.control.failOn = /FROM fin_accounts/;
  const before = f.seen.sql.length;
  const unavailable = await direct(f, "What is my balance?");
  assert.equal(unavailable.gaps[0].reason, "ledger_unavailable");
  assert.ok(f.seen.sql.length > before, "failed database decision was reached");
  f.control.failOn = null;
  assert.equal((await direct(f, "What is my balance?")).ledger.kind, "balance");
});

test("explicit deposit amount does not hide a posted row with an unknown date", async (t) => {
  const f = await fixtureFor(t);
  assert.equal((await direct(f, "Did the payment of $120.01 arrive on 2026-09-15?")).ledger.found, true);
  f.add("undated", "live-account", null, 8000);
  assert.equal((await direct(f, "Did the payment of $120.01 arrive on 2026-09-15?")).gaps[0].reason, "unreadable_transactions");
});

test("a concurrent coverage change cannot mix old twin precedence with new rows", async (t) => {
  const f = await fixtureFor(t);
  assert.equal((await direct(f, "How much money came in September 2026?")).ledger.accounts[0].credits_minor, 12001);
  let changed = 0;
  const prepare = f.env.DB.prepare;
  f.env.DB.prepare = sql => {
    if (/FROM json_each\(\?1\) m CROSS JOIN fin_transactions/.test(sql) && !changed++) {
      f.raw("UPDATE fin_account_coverage SET covered_from='2026-09-16' WHERE account_slug='live-account'");
    }
    return prepare(sql);
  };
  const body = await direct(f, "How much money came in September 2026?");
  assert.equal(changed, 1);
  assert.equal(body.gaps[0]?.reason, "ledger_unavailable");
  assert.equal(body.answer, null);
});

test("short numeric masks use the same exact twin rule and malformed coverage cannot certify a period", async (t) => {
  const f = await fixtureFor(t);
  await linkAccounts(f, "manual-account", "live-account", true);
  f.raw("UPDATE fin_accounts SET mask='321'");
  await linkAccounts(f);
  assert.equal((await readEffectiveAccounts(f.env)).length, 1);
  assert.equal((await direct(f, "How much money came in September 2026 for account 321?")).ledger.accounts[0].credits_minor, 12001);
  assert.equal((await direct(f, "How much money came in August 2026?")).ledger.accounts[0].credits_minor, 1100);
  f.raw("UPDATE fin_account_coverage SET covered_from='2026-00-01' WHERE account_slug='manual-account'");
  assert.equal((await direct(f, "How much money came in August 2026?")).gaps[0].type, "ledger_out_of_coverage");
});

// Keep the production-shaped probe in this registered suite so the full chain runs it.
import { ledgerFixture } from "./ledger-review-fixture.mjs";
import { reachedAnswer, productionFixture, measureProduction } from "./ledger-production-fixture.mjs";
for (const label of ["Zelle", "ACH", "ACH Credit", "Deposit", "Transfer", "Wire", "Mobile Deposit", "Unknown", "Online Transfer",
  "Bank", "PayPal", "Venmo", "Unknown Merchant", "Zelle Payment", "None"]) {
  test(`generic bank label cannot prove a different payer: ${label}`, async t => {
    const f = ledgerFixture(t);
    for (const [description, payee] of [["Settlement", label], [`Transfer from ${label}`, null]]) {
      f.raw("DELETE FROM fin_transactions");
      f.add("unknown", description, payee);
      const unknown = [];
      for (const question of [payerPayment, payerIncome]) unknown.push(await reachedAnswer(f, question));
      f.raw("UPDATE fin_transactions SET payee='Payer One'");
      for (const question of [payerPayment, payerIncome]) {
        const control = await reachedAnswer(f, question);
        assert.equal(control.ledger.found, true);
        assert.equal(control.evidence_gate.complete, control.ledger.kind === "payment");
      }
      for (const body of unknown) {
        assert.equal(body.ledger.found, null);
        assert.equal(body.evidence_gate.complete, false);
        assert.equal(body.ledger.inflow_count, 1);
      }
    }
  });
}

for (const description of ["Deposit for invoice from Payer Two", "Deposit memo by Payer Two", "Deposit invoice from Payer Two", "Deposit processed by Payer Two",
  "Payer One memo from Payer Two"]) {
  test(`incidental sender clause is unknown: ${description}`, async t => {
    const f = ledgerFixture(t);
    f.add("unknown", description, null);
    const unknown = [];
    for (const question of [payerPayment, payerIncome]) unknown.push(await reachedAnswer(f, question));
    f.raw("UPDATE fin_transactions SET description='Transfer from Payer Two for invoice from Payer One'");
    for (const question of [payerPayment, payerIncome]) {
      const control = await reachedAnswer(f, question);
      assert.equal(control.ledger.found, null);
      assert.equal(control.evidence_gate.complete, false);
    }
    for (const body of unknown) {
      assert.equal(body.ledger.found, null);
      assert.equal(body.evidence_gate.complete, false);
    }
    f.raw("UPDATE fin_transactions SET payee='Payer One'");
    for (const question of [payerPayment, payerIncome]) {
      const positive = await reachedAnswer(f, question);
      assert.equal(positive.ledger.found, true, "structured payer discriminates every memo arm");
    }
  });
}

test("partial sender identity cannot certify zero income", async t => {
  const f = ledgerFixture(t);
  f.add("partial", "WIRE FROM Payer One BENEFICIARY Operating Company", null);
  assert.equal((await reachedAnswer(f, payerPayment)).ledger.found, true, "existing payment prefix control");
  const income = await reachedAnswer(f, payerIncome);
  f.raw("UPDATE fin_transactions SET description='WIRE FROM Payer One REF 48261703'");
  assert.equal((await reachedAnswer(f, payerIncome)).ledger.attributed_subtotal_minor, 2500, "bounded exact sender control");
  assert.equal(income.ledger.found, null, "partial identity is unknown for an exact income total");
  assert.equal(income.ledger.total_minor, null);
  assert.equal(income.ledger.if_own_transfers.total_minor, null, "a conditional view also cannot certify zero");
  assert.equal(income.evidence_gate.complete, false);
  f.raw("UPDATE fin_transactions SET description='WIRE FROM Payer Oneplus'");
  for (const question of [payerPayment, payerIncome]) {
    const different = await reachedAnswer(f, question);
    assert.equal(different.ledger.found, null, "partial words cannot prove presence or absence");
    assert.equal(different.evidence_gate.complete, false);
  }
});

test("uncertain deposits omit descriptions and bank labels throughout JSON", async t => {
  const f = ledgerFixture(t);
  const identifiers = ["AB12CD34EF56", "482.617.039.258.001", "482617039258001"];
  for (const [i, identifier] of identifiers.entries()) f.add(`unknown-${i}`, `Deposit TRACE: ${identifier}`, null);
  const unknown = [];
  for (const question of [payerPayment, payerIncome]) unknown.push(await reachedAnswer(f, question));
  f.raw("UPDATE fin_transactions SET payee='Payer One'");
  const control = await reachedAnswer(f, payerIncome);
  assert.equal(control.evidence_gate.complete, false);
  assert.equal(control.ledger.attributed_subtotal_minor, 7500);
  for (const body of unknown) {
    assert.equal(body.ledger.inflows.length, 3);
    for (const deposit of body.ledger.inflows) {
      assert.equal(deposit.description, undefined);
      assert.equal(deposit.payee, undefined);
      assert.equal(deposit.posted_on, "2026-10-05");
      assert.equal(deposit.amount_minor, 2500);
      assert.equal(deposit.account_mask, "1234");
    }
    for (const identifier of identifiers) assert.ok(!JSON.stringify(body).includes(identifier));
    assert.ok(!JSON.stringify(body).includes("Deposit TRACE"));
  }
  for (const identifier of identifiers) {
    f.raw("UPDATE fin_transactions SET payee=?", `Payer One TRACE: ${identifier}`);
    const body = await reachedAnswer(f, payerIncome);
    assert.equal(body.ledger.found, null, "partly matching bank label reached uncertainty");
    assert.equal(body.ledger.inflows[0].payee, undefined);
    assert.ok(!JSON.stringify(body).includes(identifier));
  }
});

test("income groups keep bank labels and exact bank totals with a payer warning", async t => {
  const f = ledgerFixture(t);
  f.add("known", "Settlement", "Payer One", { cents: 1729 });
  for (let i = 0; i < 12; i++) f.add(`unknown-${i}`, "Deposit", null);
  const body = await reachedAnswer(f, "How much income came by merchant in October 2026?");
  assert.equal(body.ledger.total_minor, 31729);
  assert.equal(body.ledger.groups.find(g => g.merchant === "payer one").total_minor, 1729, "named group decision reached");
  f.raw("UPDATE fin_transactions SET payee='Payer Two' WHERE payee IS NULL");
  const control = await reachedAnswer(f, "How much income came by merchant in October 2026?");
  assert.equal(control.evidence_gate.complete, false);
  assert.equal(control.ledger.total_minor, 31729);
  assert.equal(control.ledger.groups.length, 2);
  assert.equal(body.evidence_gate.complete, false);
  assert.equal(body.ledger.inflows, undefined, "bank grouping keeps its base shape");
  assert.equal(body.ledger.groups.find(g => g.merchant === "deposit").total_minor, 30000);
  const named = body.ledger.groups.find(g => g.merchant === "payer one");
  assert.equal(named.total_minor, 1729);
  assert.equal(named.complete, false);
  assert.match(body.answer, /Labels come from your bank and may not identify who paid\./);
});

test("named payer production matrix never certifies an unknown deposit as absent", async t => {
  const stats = await measureProduction(productionFixture(t));
  t.diagnostic(JSON.stringify(stats));
  assert.equal(stats.wrong, 0);
  assert.ok(stats.answered >= 34, "preserve the previously correct answers");
  assert.equal(stats.answered + stats.refused, 40);
});

const payerPayment = "Did the payment from Payer One arrive in October 2026?";
const payerIncome = "How much income came from Payer One in October 2026?";
for (const description of [
  "ORIG CO NAME: Payer One", "WIRE TRANSFER ORIGINATOR NAME: Payer One",
  "WIRE ORIGINATOR: Payer One; BENEFICIARY: Operating Company",
  "WIRE FROM: Payer One; REF: 48261703", "ORIGINATOR NAME: Payer One",
  "SENDER: Payer One", "Deposit", "", "Unrecognized bank narration",
]) test(`unattributed deposit cannot certify absence or zero: ${description || "empty"}`, async t => {
  const f = ledgerFixture(t);
  f.add("uncertain", description, null);
  for (const question of [payerPayment, payerIncome]) {
    const body = await reachedAnswer(f, question);
    // Existing positive parsing is intentionally unchanged by this hotfix.
    if (description === "WIRE FROM: Payer One; REF: 48261703") {
      assert.equal(body.ledger.found, true);
      assert.equal(body.citations[0].amount_minor, 2500);
      continue;
    }
    assert.equal(body.ledger.found, null);
    assert.equal(body.evidence_gate.complete, false);
    assert.doesNotMatch(body.answer, /No matching deposit|\$0\.00/);
    assert.match(body.answer, /can't confirm/i);
    assert.match(body.answer, /2026-10-05/);
    assert.match(body.answer, /covered through|covers through/);
    assert.equal(body.ledger.inflow_count, 1);
    assert.equal(body.ledger.inflows[0].amount_minor, 2500);
    if (body.ledger.kind === "merchant") assert.equal(body.ledger.total_minor, null);
  }
  f.raw("UPDATE fin_transactions SET payee='Payer One'");
  for (const question of [payerPayment, payerIncome]) {
    const control = await reachedAnswer(f, question);
    assert.equal(control.ledger.found, true, "structured payee restores the answer");
    assert.equal(control.evidence_gate.complete, control.ledger.kind === "payment");
  }
});

test("different sender labels and amounts cannot prove absence; period and direction still bind", async t => {
  const f = ledgerFixture(t);
  f.add("structured", "Settlement", "Payer Two");
  f.add("extracted", "Transfer from Payer Three for Payer One invoice", null);
  f.add("outside", "Deposit", null, { date: "2026-09-30" });
  f.add("outflow", "Deposit", null, { direction: "outflow" });
  for (const question of [payerPayment, payerIncome]) {
    const control = await reachedAnswer(f, question);
    assert.equal(control.ledger.found, null);
    assert.equal(control.evidence_gate.complete, false);
    assert.equal(control.ledger.total_minor, null);
  }
  f.add("unknown", "Deposit", null, { cents: 3900 });
  const bounded = await reachedAnswer(f, "Did the payment of $25 from Payer One arrive in October 2026?");
  assert.equal(bounded.ledger.found, null, "an amount filter cannot prove an empty inflow window");
  const uncertain = await reachedAnswer(f, payerPayment);
  assert.equal(uncertain.ledger.found, null);
  assert.equal(uncertain.ledger.inflow_count, 3);
  f.add("matched", "Settlement", "Payer One");
  const positive = await reachedAnswer(f, payerPayment);
  assert.equal(positive.ledger.found, true, "a confirmed receipt still proves presence");
});

test("income keeps only an incomplete attributed subtotal and caps masked uncertain receipts at ten", async t => {
  const f = ledgerFixture(t);
  f.add("matched", "Settlement", "Payer One", { cents: 1729 });
  const control = await reachedAnswer(f, payerIncome);
  assert.equal(control.ledger.total_minor, null);
  assert.equal(control.ledger.attributed_subtotal_minor, 1729);
  for (let i = 0; i < 12; i++) f.add(`unknown-${i}`, "Deposit 482617039258001", null, { cents: 2500 + i });
  const body = await reachedAnswer(f, payerIncome);
  assert.equal(body.ledger.found, true);
  assert.equal(body.ledger.total_minor, null);
  assert.equal(body.ledger.attributed_subtotal_minor, 1729);
  assert.equal(body.evidence_gate.complete, false);
  assert.match(body.answer, /at least.*\$17\.29.*subtotal.*not complete/i);
  assert.doesNotMatch(body.answer, /Total income|482617039258001/);
  assert.equal(body.ledger.inflow_count, 13);
  assert.equal(body.ledger.inflows.length, 10);
  assert.equal(body.citations.length, 10);
  for (const row of body.ledger.inflows) {
    assert.equal(row.posted_on, "2026-10-05");
    assert.equal(row.description, undefined, "uncertain receipts never expose descriptions");
    assert.equal(row.account_mask, "1234");
    assert.ok(body.citations.some(c => c.n === row.n && c.amount_minor === row.amount_minor));
  }
  assert.doesNotMatch(JSON.stringify(body), /482617039258001|Deposit \[redacted\]/);
  const payment = await reachedAnswer(f, "Did the payment from Absent Payer arrive in October 2026?");
  assert.equal(payment.ledger.found, null);
  assert.equal(payment.ledger.inflows.length, 10);
  assert.equal(payment.ledger.inflow_count, 13);
  assert.doesNotMatch(JSON.stringify(payment), /482617039258001/);
});

// Registered here so the ordinary test chain executes both review rounds.
import "./ledger-conservative.test.mjs";
