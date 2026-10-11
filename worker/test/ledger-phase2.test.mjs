import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";
import { withLedgerAnswer } from "../src/lib/ledger-answer.js";
import { classifyLedgerQuestion } from "../src/lib/ledger-question.js";

const NOW = "2026-10-11T12:00:00Z";
const stamp = "2026-10-11T10:00:00Z";
test.before(() => mock.method(Date, "now", () => Date.parse(NOW)));
test.after(() => mock.restoreAll());
async function fixture(t) {
  const f = await createProductFixture({ env: {
    ADMIN_KEY: randomBytes(24).toString("hex"), SESSION_SIGNING_KEY: randomBytes(32).toString("hex"),
    AI: { async run() { throw new Error("money must use the ledger"); } },
  } });
  t.after(() => f.close());
  seedOwnedEntity(f, "owner", "Owner");
  f.account = (slug, mask, kind = "checking", mode = "live") => {
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
      VALUES (?,'owner',?,'asset',?,?,'owner_stated','confirmed',?)`, slug, kind, mask, mode, stamp);
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES (?,'complete','2026-06-01','2026-10-11',?,'owner_stated','confirmed',?)`, slug, stamp, stamp);
  };
  f.account("account-a", "1111"); f.account("account-b", "2222", "savings");
  f.add = (id, date, amount, direction = "outflow", description = "Fixture merchant", category = null, basis = null, account = "account-a") => {
    f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,category,category_basis_state,provenance,basis_state,recorded_at)
      VALUES (?,?,?,?,?,?,?,?,'owner_stated','confirmed',?)`, id, account, date, amount, direction, description, category, basis, stamp);
  };
  f.ask = (question, extra = {}) => withLedgerAnswer({ env: f.env, question, now: NOW,
    grantScope: { all: true }, scopePrincipalKind: "owner", ...extra },
  async () => new Response(JSON.stringify({ answer: null, gaps: [] }))).then(r => r.json());
  return f;
}
const transactionReads = f => f.seen.sql.filter(sql => /JOIN fin_transactions/.test(sql)).length;
const sumAccounts = (body, field) => body.ledger.accounts.reduce((sum, a) => sum + a[field], 0);

for (const [question, kind, seed] of [
  ["What were my ten largest expenses in the last 60 days?", "largest", f => f.add("expense", "2026-09-15", 12001)],
  ["What were my 3 largest deposits in September 2026?", "largest", f => f.add("deposit", "2026-09-15", 12001, "inflow")],
  ["How much did I spend at Fixture Store in September 2026?", "merchant", f => f.add("merchant", "2026-09-15", 12001, "outflow", "FIXTURE-STORE purchase")],
  ["How much income came from Fixture payer in September 2026?", "merchant", f => f.add("payer", "2026-09-15", 12001, "inflow", "Fixture payer deposit")],
  ["How much did I spend on software/SaaS in Q3?", "category", f => f.add("software", "2026-09-15", 12001, "outflow", "Fixture service", "SOFTWARE", "proposed")],
  ["How much income by category in September 2026?", "category", f => f.add("income", "2026-09-15", 12001, "inflow", "Fixture payer", "income", "confirmed")],
  ["What deposits came in over the last 14 days?", "deposits", f => f.add("recent", "2026-10-01", 12001, "inflow")],
  ["What recurring subscriptions am I paying for, and how much per month?", "recurring", f => {
    for (const [i, day] of ["2026-08-10", "2026-09-10", "2026-10-10"].entries()) f.add(`monthly-${i}`, day, 12001);
  }],
  ["How much did I transfer between my own accounts last month?", "transfers", f => {
    f.add("sent", "2026-09-15", 12001, "outflow", "TRANSFER TO savings");
    f.add("received", "2026-09-18", 12001, "inflow", "TRANSFER FROM checking", null, null, "account-b");
  }],
]) {
  test(`${kind}: found, bounded absence and out of coverage through SQLite`, async t => {
    const f = await fixture(t); seed(f);
    const found = await f.ask(question);
    assert.equal(found.ledger?.kind, kind);
    assert.equal(found.ledger.found, true);
    assert.ok(found.citations.length > 0);
    assert.ok(transactionReads(f) > 0, "real transaction decision reached");
    f.raw("DELETE FROM fin_transactions");
    const before = transactionReads(f);
    const absent = await f.ask(question);
    assert.equal(absent.ledger?.found, false);
    assert.ok(transactionReads(f) > before, "absence inspected transactions");
    assert.match(absent.answer, /1111.*2222/);
    assert.ok(absent.answer.includes(absent.ledger.from) && absent.answer.includes(absent.ledger.to));
    assert.match(absent.answer, /covered through 2026-10-11/);
    seed(f);
    f.raw("UPDATE fin_account_coverage SET covered_from='2026-10-05'");
    const readCount = f.seen.sql.length;
    const outside = await f.ask(question);
    assert.equal(outside.gaps[0]?.reason, "period_outside_coverage");
    assert.ok(f.seen.sql.slice(readCount).some(sql => /FROM fin_accounts/.test(sql)), "coverage decision reached");
    assert.equal(outside.ledger, undefined);
  });
}

test("largest and deposits retain cents, order, citations, posted filters and twin dedup", async t => {
  const f = await fixture(t);
  f.account("manual-a", "1111", "checking", "manual");
  f.add("small", "2026-09-15", 900);
  f.add("large", "2026-09-16", 10001);
  f.add("twin", "2026-09-16", 10001, "outflow", "Fixture merchant", null, null, "manual-a");
  for (const id of ["pending", "removed", "superseded"]) f.add(id, "2026-09-17", 99999);
  f.raw("UPDATE fin_transactions SET pending=1 WHERE txn_uid='pending'");
  f.raw("UPDATE fin_transactions SET removed_at=?,removal_reason='fixture' WHERE txn_uid='removed'", stamp);
  f.raw("UPDATE fin_transactions SET superseded_by_id=999 WHERE txn_uid='superseded'");
  const result = await f.ask("What were my 1 largest expenses in September 2026?");
  assert.deepEqual(result.ledger.rows.map(r => r.amount_minor), [10001]);
  assert.equal(result.citations.length, 1); assert.match(result.answer, /\[1\]/);
  f.add("start", "2026-09-28", 20001, "inflow");
  f.add("end", "2026-10-11", 30002, "inflow");
  f.add("outside", "2026-09-27", 40003, "inflow");
  const recent = await f.ask("What deposits came in over the last 14 days?");
  assert.deepEqual(recent.ledger.rows.map(r => r.amount_minor), [30002, 20001]);
  assert.equal(recent.citations.length, 2);
});

test("merchant tokens are contiguous and category proposals and Unsorted stay explicit", async t => {
  const f = await fixture(t);
  f.add("exact", "2026-09-15", 10001, "outflow", "ＦＩＸＴＵＲＥ-STORE purchase", "SOFTWARE", "proposed");
  f.add("other", "2026-09-16", 500, "outflow", "Fixture Storehouse", "SOFTWARE", "confirmed");
  f.add("unsorted", "2026-09-17", 99, "outflow", "Fixture Store");
  const merchant = await f.ask("How much did I spend at fixture store in September 2026?");
  assert.equal(merchant.ledger.total_minor, 10100);
  assert.match(merchant.answer, /Unsorted.*\$0\.99/);
  const category = await f.ask("How much did I spend on software/SaaS in Q3?");
  assert.equal(category.ledger.total_minor, 10501);
  assert.equal(category.ledger.unsorted_minor, 99);
  assert.match(category.answer, /bank's category \(unconfirmed\)/);
  assert.match(category.answer, /Unsorted.*\$0\.99/);
  const breakdown = await f.ask("How much did I spend by category in September 2026?");
  assert.equal(breakdown.ledger.total_minor, 10600);
  assert.equal(breakdown.ledger.groups.filter(g => g.category === "software").length, 2);
});

test("transfers exclude each matched leg once; near misses stay counted and labeled", async t => {
  const f = await fixture(t);
  f.add("out", "2026-09-15", 10001, "outflow", "TRANSFER TO savings");
  f.add("in", "2026-09-18", 10001, "inflow", "Fixture bank", "TRANSFER_IN_ACCOUNT_TRANSFER", "proposed", "account-b");
  f.add("amount-out", "2026-09-20", 20001, "outflow", "TRANSFER TO savings");
  f.add("amount-in", "2026-09-20", 20002, "inflow", "TRANSFER FROM checking", null, null, "account-b");
  f.add("date-out", "2026-09-01", 30001, "outflow", "TRANSFER TO savings");
  f.add("date-in", "2026-09-05", 30001, "inflow", "TRANSFER FROM checking", null, null, "account-b");
  f.add("expense", "2026-09-16", 77);
  const changes = f.sqlite.prepare("SELECT total_changes() n").get().n;
  const totals = await f.ask("How much money came in and went out in September 2026?");
  assert.equal(sumAccounts(totals, "debits_minor"), 50079);
  assert.equal(sumAccounts(totals, "credits_minor"), 50003);
  assert.equal(totals.ledger.matched_transfer_count, 1);
  assert.equal(totals.ledger.unmatched_transfers.length, 4);
  assert.equal(totals.ledger.includes_own_transfers, false);
  assert.match(totals.answer, /excludes 1 matched transfers between your accounts/);
  assert.match(totals.answer, /possible transfer, unmatched/i);
  const transfer = await f.ask("How much did I transfer between my own accounts last month?");
  assert.equal(transfer.ledger.total_minor, 10001);
  assert.equal(transfer.ledger.transfers.length, 1);
  assert.equal(f.sqlite.prepare("SELECT total_changes() n").get().n, changes);
});

test("three-account ambiguity never consumes a leg twice; unique second pair works", async t => {
  const f = await fixture(t); f.account("account-c", "3333", "savings");
  f.add("out", "2026-09-15", 10001, "outflow", "TRANSFER TO savings");
  for (const account of ["account-b", "account-c"]) f.add(account, "2026-09-16", 10001, "inflow", "TRANSFER FROM checking", null, null, account);
  const ambiguous = await f.ask("How much did I transfer between my own accounts last month?");
  assert.equal(ambiguous.ledger.found, false);
  assert.equal(ambiguous.ledger.unmatched_transfers.length, 3);
  assert.ok(transactionReads(f) > 0);
  f.raw("UPDATE fin_transactions SET amount_minor=7001 WHERE txn_uid='account-c'");
  f.add("second-out", "2026-09-15", 7001, "outflow", "TRANSFER TO savings", null, null, "account-b");
  const unique = await f.ask("How much did I transfer between my own accounts last month?");
  assert.equal(unique.ledger.transfers.length, 2);
  assert.equal(unique.ledger.total_minor, 17002);
});

test("monthly and weekly detection have three occurrences, integer tolerance and cadence boundaries", async t => {
  const f = await fixture(t);
  for (const [i, day] of ["2026-08-10", "2026-09-10", "2026-10-10"].entries()) f.add(`monthly-${i}`, day, i === 2 ? 1100 : 1000, "outflow", "Fixture subscription");
  for (const [i, day] of ["2026-09-27", "2026-10-04", "2026-10-11"].entries()) f.add(`weekly-${i}`, day, 301, "outflow", "Fixture weekly");
  const control = await f.ask("What recurring subscriptions am I paying for, and how much per month?");
  assert.equal(control.ledger.recurring.length, 2);
  assert.equal(control.ledger.monthly_total_minor, 2304);
  assert.match(control.answer, /detected.*not confirmed/i);
  assert.equal(control.citations.length, 6);
  f.raw("UPDATE fin_transactions SET amount_minor=1101 WHERE txn_uid='monthly-2'");
  f.raw("UPDATE fin_transactions SET posted_on='2026-10-01' WHERE txn_uid='weekly-1'");
  const negative = await f.ask("What recurring subscriptions am I paying for, and how much per month?");
  assert.equal(negative.ledger.recurring.length, 0);
  assert.equal(negative.ledger.found, false);
  assert.ok(transactionReads(f) >= 2);
});

test("phase-two grammar rejects unknown qualifiers, and dates use UTC", () => {
  const options = { now: "2026-10-01T00:30:00Z" };
  const control = classifyLedgerQuestion("How much did I spend on software/SaaS in Q3?", options);
  assert.deepEqual([control.from, control.to], ["2026-07-01", "2026-09-30"]);
  for (const q of ["What were my 100000 largest expenses in the last 60 days?",
    "How much did I spend on software/SaaS in Q3 excluding refunds?",
    "How much did I spend at Fixture Store in September 2026 and October 2026?",
    "What recurring subscriptions will I pay next year?",
    "How much income by category for another entity in September 2026?"]) {
    assert.equal(classifyLedgerQuestion(q, options).kind, null, q);
  }
});

test("selected account still pairs with owned counterparts across month boundaries", async t => {
  const f = await fixture(t);
  f.add("boundary-out", "2026-09-30", 5555, "outflow", "TRANSFER TO savings");
  f.add("boundary-in", "2026-10-02", 5555, "inflow", "TRANSFER FROM checking", null, null, "account-b");
  const out = await f.ask("How much money went out in September 2026 for account 1111?");
  assert.equal(out.ledger.accounts.length, 1);
  assert.equal(out.ledger.accounts[0].debits_minor, 0);
  assert.equal(out.ledger.matched_transfer_count, 1);
  const income = await f.ask("How much income by category in October 2026?", { now: "2026-11-01T00:00:00Z" });
  assert.equal(income.gaps[0]?.reason, "period_outside_coverage");
  f.raw("UPDATE fin_account_coverage SET covered_to='2026-10-31'");
  const inResult = await f.ask("How much income by category in October 2026?");
  assert.equal(inResult.ledger.total_minor, 0);
  assert.equal(inResult.ledger.matched_transfer_count, 1);
});

test("SQL date arms use an account date range index and the row cap fails visibly", async t => {
  const f = await fixture(t);
  f.add("control", "2026-09-15", 101);
  assert.equal((await f.ask("How much did I spend by category in September 2026?")).ledger.total_minor, 101);
  const i = f.seen.sql.findIndex(sql => /JOIN fin_transactions/.test(sql));
  assert.ok(i >= 0);
  const plan = f.sqlite.prepare(`EXPLAIN QUERY PLAN ${f.seen.sql[i]}`).all(...f.seen.binds[i]);
  assert.ok(plan.some(row => /idx_fin_transactions_account.*posted_on>\? AND posted_on<\?/.test(row.detail)), JSON.stringify(plan));
  f.raw(`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<5000)
    INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,provenance,basis_state,recorded_at)
    SELECT 'cap-'||n,'account-a','2026-09-15',1,'outflow','owner_stated','confirmed',? FROM ids`, stamp);
  const before = transactionReads(f);
  const limited = await f.ask("How much did I spend by category in September 2026?");
  assert.equal(limited.gaps[0]?.reason, "ledger_unavailable");
  assert.ok(transactionReads(f) > before, "row bound reached SQL");
  assert.equal(limited.ledger, undefined);
});

test("ordinary recurring meetings keep the identical non-money response", async t => {
  const f = await fixture(t);
  const expected = new Response('{"answer":"agenda", "gaps":[]}');
  let nextCalls = 0;
  const before = f.seen.sql.length;
  const actual = await withLedgerAnswer({ env: f.env, question: "Where are my recurring meeting notes?" }, async () => { nextCalls++; return expected; });
  assert.equal(nextCalls, 1);
  assert.equal(actual, expected);
  assert.equal(f.seen.sql.length, before);
  f.add("control", "2026-09-15", 101);
  assert.equal((await f.ask("How much did I spend by category in September 2026?")).ledger.total_minor, 101);
});

async function mutantAnswer(from, to) {
  const analysisUrl = new URL("../src/lib/ledger-analysis.js", import.meta.url);
  const analysis = readFileSync(analysisUrl, "utf8");
  assert.equal(analysis.split(from).length - 1, 1, "exactly one mutation site");
  const altered = analysis.replace(from, to);
  const analysisModule = `data:text/javascript;base64,${Buffer.from(altered).toString("base64")}`;
  const answerUrl = new URL("../src/lib/ledger-answer.js", import.meta.url);
  const answer = readFileSync(answerUrl, "utf8").replace(/from "(\.\/.+?)"/g, (_, path) =>
    `from ${JSON.stringify(path === "./ledger-analysis.js" ? analysisModule : new URL(path, answerUrl).href)}`);
  return (await import(`data:text/javascript;base64,${Buffer.from(answer).toString("base64")}`)).withLedgerAnswer;
}
const askMutant = (f, question, answer) => answer({ env: f.env, question, now: NOW,
  grantScope: { all: true }, scopePrincipalKind: "owner" },
async () => new Response(JSON.stringify({ answer: null, gaps: [] }))).then(r => r.json());

test("mutation control kills transfer exclusion through the real SQLite answer path", async t => {
  const f = await fixture(t);
  f.add("out", "2026-09-15", 10001, "outflow", "TRANSFER TO savings");
  f.add("in", "2026-09-18", 10001, "inflow", "TRANSFER FROM checking", null, null, "account-b");
  f.add("expense", "2026-09-16", 77);
  const question = "How much money came in and went out in September 2026?";
  const control = await f.ask(question);
  assert.equal(control.ledger.matched_transfer_count, 1);
  assert.equal(sumAccounts(control, "debits_minor"), 77);
  const mutant = await mutantAnswer("rows.filter(row => !matched.has(row.id));", "rows.filter(row => true);");
  const before = transactionReads(f);
  const changed = await askMutant(f, question, mutant);
  assert.ok(transactionReads(f) > before, "mutant reached SQL and pairing");
  assert.equal(changed.ledger.matched_transfer_count, 1);
  assert.equal(sumAccounts(changed, "debits_minor"), 10078);
  assert.notEqual(sumAccounts(changed, "debits_minor"), sumAccounts(control, "debits_minor"));
});

test("mutation control kills a removed recurring cadence guard through SQLite", async t => {
  const f = await fixture(t);
  for (const [i, day] of ["2026-08-10", "2026-09-10", "2026-10-10"].entries()) f.add(`regular-${i}`, day, 1001, "outflow", "Fixture regular");
  for (const [i, day] of ["2026-08-10", "2026-08-11", "2026-10-10"].entries()) f.add(`irregular-${i}`, day, 5001, "outflow", "Fixture irregular");
  const question = "What recurring subscriptions am I paying for, and how much per month?";
  const control = await f.ask(question);
  assert.equal(control.ledger.recurring.length, 1);
  assert.equal(control.ledger.monthly_total_minor, 1001);
  const mutant = await mutantAnswer("intervals.every(days => days >= 25 && days <= 35)", "intervals.every(() => true)");
  const before = transactionReads(f);
  const changed = await askMutant(f, question, mutant);
  assert.ok(transactionReads(f) > before, "mutant reached SQL and cadence detection");
  assert.equal(changed.ledger.recurring.length, 2);
  assert.equal(changed.ledger.monthly_total_minor, 6002);
});

test("merchant punctuation and category words do not become implicit account selectors", async t => {
  const f = await fixture(t);
  f.add("punctuation", "2026-09-15", 1357, "outflow", "Fixture.Store card payment", "SOFTWARE", "confirmed");
  const punctuation = await f.ask("How much did I spend at Fixture.Store in September 2026?");
  assert.equal(punctuation.ledger.total_minor, 1357);
  const accountWord = await f.ask("How much did I spend at Fixture Store card in September 2026?");
  assert.equal(accountWord.ledger?.total_minor, 1357);
  const selected = await f.ask("How much did I spend at Fixture.Store in September 2026 for checking account 1111?");
  assert.equal(selected.ledger.total_minor, 1357);
  assert.equal(selected.ledger.accounts.length, 1);
});

test("Unsorted can be requested without silently excluding uncategorized rows", async t => {
  const f = await fixture(t);
  f.add("unsorted", "2026-09-15", 1717);
  f.add("confirmed", "2026-09-16", 1357, "outflow", "Fixture store", "SOFTWARE", "confirmed");
  assert.equal((await f.ask("How much did I spend on software in Q3?")).ledger.total_minor, 1357);
  const unsorted = await f.ask("How much did I spend on Unsorted in Q3?");
  assert.equal(unsorted.ledger.total_minor, 1717);
  assert.equal(unsorted.ledger.found, true);
});

test("Think uses the existing single call site and phase two keeps the owner scope guard", async t => {
  const f = await fixture(t);
  f.add("expense", "2026-09-15", 101);
  const question = "What were my ten largest expenses in the last 60 days?";
  const response = await f.post("/api/rag/think", { q: question }, { "X-Admin-Key": f.env.ADMIN_KEY });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ledger.kind, "largest");
  for (const scope of [{ scopePrincipalKind: "grant" }, { grantScope: { all: true, exclude: ["medical"] } },
    { access: { documentIds: ["fixture-doc"] } }, { filters: { source: "drive" } }, { entityScope: { applied: true } }]) {
    const before = f.seen.sql.length;
    const denied = await f.ask(question, scope);
    assert.equal(denied.gaps[0]?.reason, "retrieval_scope_restricted");
    assert.equal(f.seen.sql.length, before);
  }
});

test("recurrence rejects two charges and stale runs; exact cadence edges have controls", async t => {
  const f = await fixture(t);
  for (const [i, day] of ["2026-08-05", "2026-08-30", "2026-10-04"].entries()) f.add(`month-${i}`, day, i === 0 ? 900 : 1000, "outflow", "Fixture monthly edge");
  for (const [i, day] of ["2026-09-27", "2026-10-03", "2026-10-11"].entries()) f.add(`week-${i}`, day, 600, "outflow", "Fixture weekly edge");
  for (const [i, day] of ["2026-09-10", "2026-10-10"].entries()) f.add(`two-${i}`, day, 700, "outflow", "Fixture two");
  for (const [i, day] of ["2026-07-01", "2026-08-01", "2026-09-01"].entries()) f.add(`stale-${i}`, day, 800, "outflow", "Fixture stale");
  const control = await f.ask("Show my recurring charges");
  assert.deepEqual(control.ledger.recurring.map(g => g.cadence), ["monthly", "weekly"]);
  f.raw("UPDATE fin_transactions SET posted_on='2026-08-29' WHERE txn_uid='month-1'");
  f.raw("UPDATE fin_transactions SET posted_on='2026-10-02' WHERE txn_uid='week-1'");
  const negative = await f.ask("Show my recurring charges");
  assert.equal(negative.ledger.recurring.length, 0);
  assert.ok(transactionReads(f) >= 2);
});

test("transfer uniqueness inspects competitors beyond a window-edge counterpart", async t => {
  const f = await fixture(t); f.account("account-c", "3333", "savings");
  f.add("out", "2026-09-01", 12345, "outflow", "TRANSFER TO savings");
  f.add("in", "2026-08-29", 12345, "inflow", "TRANSFER FROM checking", null, null, "account-b");
  const control = await f.ask("How much money went out in September 2026 for account 1111?");
  assert.equal(control.ledger.accounts[0].debits_minor, 0);
  assert.equal(control.ledger.matched_transfer_count, 1);
  f.add("competitor", "2026-08-26", 12345, "outflow", "TRANSFER TO savings", null, null, "account-c");
  const before = transactionReads(f);
  const ambiguous = await f.ask("How much money went out in September 2026 for account 1111?");
  assert.ok(transactionReads(f) > before);
  assert.equal(ambiguous.ledger.accounts[0].debits_minor, 12345);
  assert.equal(ambiguous.ledger.matched_transfer_count, 0);
  assert.equal(ambiguous.ledger.unmatched_transfers.length, 1);
});

test("row LIMIT stops a large covered range before a global sort scans it all", async t => {
  const f = await fixture(t);
  f.add("control", "2026-09-15", 101);
  const question = "How much did I spend by category in September 2026?";
  assert.equal((await f.ask(question)).ledger.total_minor, 101);
  f.raw(`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<12000)
    INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,provenance,basis_state,recorded_at)
    SELECT 'range-'||n,'account-a','2026-09-15',1,'outflow','owner_stated','confirmed',? FROM ids`, stamp);
  let visits = 0, hooks = 0;
  f.sqlite.function("fixture_visit", (_id) => { visits++; return 1; });
  const prepare = f.env.DB.prepare;
  f.env.DB.prepare = sql => {
    if (/JOIN fin_transactions/.test(sql)) {
      hooks++;
      sql = sql.replaceAll("WHERE t.tenant_id=?2", "WHERE fixture_visit(t.id)=1 AND t.tenant_id=?2");
    }
    return prepare(sql);
  };
  const limited = await f.ask(question);
  assert.equal(limited.gaps[0]?.reason, "ledger_unavailable");
  assert.equal(hooks, 1, "actual reader query instrumented");
  assert.equal(visits, 5001, "LIMIT stops the range once overflow is established");
});
