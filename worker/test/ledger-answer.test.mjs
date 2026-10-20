import { assertPossibleMatch } from './partner-r7-assertions.mjs';
import { seedKnownPayers } from './ledger-known-payers-fixture.mjs';
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
  seedKnownPayers(fixture, ['Fixture payer'], NOW);
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
  // Exact fields retain the original edge/amount contract. Under the shorthand
  // contract, the other amount remains visible as an uncertain payer receipt.
  f.raw("UPDATE fin_transactions SET description='FROM: Fixture payer' WHERE direction='inflow'");
  const body = await direct(f, "Did the payment of $50.11 from Fixture payer arrive on 2026-09-15 in account 4321?");
  assert.equal(body.ledger.found, true);
  assert.deepEqual(body.citations.map(c => c.posted_on), ["2026-09-08", "2026-09-22"]);
  // Unknown question labels refuse; only a registered identity can prove absence.
  const unregistered = await direct(f, "Did the payment of $50.11 from Different payer arrive on 2026-09-15?");
  assert.equal(unregistered.ledger.found, null);
  assert.equal(unregistered.evidence_gate.complete, false);
  assert.doesNotMatch(unregistered.answer, /No matching|\$0\.00/);
  f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('known-absent','Different payer','business','owned','owner_stated','confirmed',?)`, NOW);
  const wrongPayer = await direct(f, "Did the payment of $50.11 from Different payer arrive on 2026-09-15?");
  assert.equal(wrongPayer.ledger.found, false);
  const wrongMask = await direct(f, "Did the payment of $50.11 arrive on 2026-09-15 in account 9999?");
  assert.equal(wrongMask.gaps[0].reason, "no_accounts");
  assert.equal((await direct(f, "Did the payment of $120.01 arrive?")).ledger.found, true);
  assert.deepEqual([classifyLedgerQuestion("Did the payment of $120.01 arrive?", { now: NOW }).from,
    classifyLedgerQuestion("Did the payment of $120.01 arrive?", { now: NOW }).to], ["2026-09-12", "2026-10-11"]);
  assert.equal((await direct(f, "Did the payment of $120.00 arrive?")).ledger.found, false);
  f.raw("UPDATE fin_transactions SET description='Fixture payer deposit' WHERE direction='inflow'");
  const shorthand = await (await f.ask("Did the payment of $50.11 from Fixture payer arrive on 2026-09-15 in account 4321?")).json();
  assert.ok(f.seen.sql.some(sql => /JOIN fin_transactions/.test(sql)), 'real Think attribution decision reached');
  assertPossibleMatch(shorthand, 10022);
  assert.equal(shorthand.evidence_gate.complete, false);
  assert.equal(shorthand.ledger.rows.length, 2);
  const assumption = shorthand.assumptions[0];
  assert.equal(assumption.type, 'payer_shorthand');
  assert.equal(assumption.count, 2); assert.equal(assumption.amount_minor, 10022);
  assert.deepEqual(shorthand.citations.filter(c => assumption.citations.includes(c.n)).map(c => c.posted_on), ['2026-09-08', '2026-09-22']);
  assert.equal(shorthand.ledger.inflow_total_minor, 22023, 'all read inflows remain in the gross scope');
  assert.ok(shorthand.citations.every(c => c.amount_minor === 5011), 'only possible matching receipts enter the subtotal');
  assert.ok(shorthand.ledger.flip.includes('exact names only'));
  assert.ok(shorthand.notes.every(note => shorthand.answer.includes(note)), 'Think must render every shorthand assumption note');
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
