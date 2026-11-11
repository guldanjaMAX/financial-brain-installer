import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { buildParityLedgers, moneyBook, oracleFor, plaidRendering, simplefinRendering, questionGroups, scoreAnswer, NOW,
  assertLedgerMatchesBook, ledgerDiff } from "./fixtures/simplefin-parity.mjs";

let run;
const mutants = [];
const ambientFetch = globalThis.fetch;
let ambientCalls = 0;
test.before(async () => {
  globalThis.fetch = async () => { ambientCalls++; throw new Error("parity forbids ambient network"); };
  run = await buildParityLedgers();
});
test.after(() => {
  run?.close();
  globalThis.fetch = ambientFetch;
  assert.equal(ambientCalls, 0, "every provider call stayed inside the injected transport");
  if (process.env.PARITY_RECEIPT) {
    const receipt = JSON.parse(readFileSync(process.env.PARITY_RECEIPT, "utf8"));
    writeFileSync(process.env.PARITY_RECEIPT, JSON.stringify({ ...receipt, mutants }, null, 2));
  }
});

test("the independent cents oracle covers 90 days, two institutions and all four account kinds", () => {
  const book = moneyBook(), oracle = oracleFor(book);
  assert.equal(new Set(book.accounts.map(a => a.bank)).size, 2);
  assert.equal(new Set(book.transactions.map(t => t.day)).size, 90);
  assert.ok(oracle.count >= 1450 && oracle.count <= 1550);
  assert.ok(book.transactions.some(t => t.pendingId));
  assert.equal(book.transactions.filter(t => t.id.startsWith("recurring-")).length, 3);
  assert.equal(book.transactions.filter(t => t.id.startsWith("reversal-")).length, 2);
  assert.ok(oracle.vendor > 0 && oracle.expense > oracle.vendor);
  assert.equal(plaidRendering(book, "bank-a", 1).accounts[0].type, "depository");
  const sf = simplefinRendering(book, 1);
  assert.equal(sf.connections.length, 2);
  assert.ok(sf.accounts.every(a => sf.connections.some(c => c.conn_id === a.conn_id)));
  assert.ok(sf.accounts.every(a => !("type" in a) && !("subtype" in a)));
  assert.ok(sf.accounts.flatMap(a => a.transactions).every(t => !("category" in t) && !("merchant_name" in t)));
  assert.equal(oracleFor(book).expense, oracle.expense, "rendering cannot change oracle membership");
});

test("SimpleFIN derives only explicit unambiguous account kinds and agrees with the typed Plaid inventory", () => {
  for (const expected of run.book.accounts) {
    for (const f of [run.plaid, run.simple]) {
      const actual = f.first("SELECT account_kind,balance_role FROM fin_accounts WHERE label=?", expected.label);
      assert.equal(actual.account_kind, expected.kind, `${expected.id}: account kind`);
      assert.equal(actual.balance_role, ["card", "loan"].includes(expected.kind) ? "liability" : "asset");
    }
  }
});

test("unsolicited SimpleFIN pending rows never become completed money and later posting is idempotent", () => {
  assert.ok(run.calls.simplefin.filter(method => method === "GET").length >= 10, "all real backfill windows and repeated current pulls ran");
  assert.equal(run.calls.simplefin.filter(method => method === "POST").length, 1, "claim decision reached once");
  assert.ok(run.simpleInitial.length > 1400, "pending decision was reached alongside a nonempty posted control");
  assert.equal(run.simpleInitial.filter(t => t.external_id.startsWith("pending-")).length, 0,
    "the feed requests posted history only; pending is never relabelled as posted");
  for (const f of [run.plaid, run.simple]) {
    const active = f.rows("SELECT * FROM fin_transactions WHERE removed_at IS NULL");
    assert.equal(active.length, run.oracle.count, "pending-to-posted and current-window replay retain one completed event");
    assert.equal(active.filter(t => t.pending).length, 0);
    assert.equal(active.filter(t => t.posted_on === "1970-01-01").length, 0);
  }
});

test("both ledgers match every independent posted event, signed balance, date, payee and proposed category boundary", () => {
  assertLedgerMatchesBook(run.plaid, run.book, "plaid");
  assertLedgerMatchesBook(run.simple, run.book, "simplefin");
});

test("explicit owner comparison establishes bounded coverage after verified backfill", () => {
  assert.equal(run.simple.first("SELECT state FROM bank_feed_backfill").state, "complete", "backfill completion decision reached");
  for (const row of run.simple.rows("SELECT * FROM fin_account_coverage")) {
    assert.equal(row.coverage_status, "complete", "exact bank comparison follows durable publication receipts");
    assert.ok(row.covered_from <= "2026-08-07");
    assert.equal(row.covered_to, "2026-11-04");
  }
});

test("same question wordings use the real read-only money path against each independently ingested book", async () => {
  const observations = [];
  for (const [group, wordings] of questionGroups) {
    for (const [wording, question] of wordings.entries()) {
      const plaid = await run.ask(run.plaid, question);
      const simplefin = await run.ask(run.simple, question);
      for (const result of [plaid, simplefin]) {
        assert.ok(result.reads.length > 0 || result.fallbacks === 1, "the answer or refusal decision was reached");
        assert.ok(result.reads.every(sql => !/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)), "answer path is read only");
      }
      observations.push({ group, wording: wording + 1, question, plaid: plaid.body, simplefin: simplefin.body,
        scores: { plaid: scoreAnswer(group, plaid.body, run.book, run.oracle), simplefin: scoreAnswer(group, simplefin.body, run.book, run.oracle) } });
    }
  }
  if (process.env.PARITY_RECEIPT) writeFileSync(process.env.PARITY_RECEIPT,
    JSON.stringify({ oracle: run.oracle, ledger_diff: ledgerDiff(run), observations }, null, 2));
  assert.equal(observations.length, 31);
  assert.equal(observations.filter(o => o.scores.simplefin.score === "WRONG").length, 0,
    observations.filter(o => o.scores.simplefin.score === "WRONG").map(o => `${o.group}/${o.wording}: ${o.scores.simplefin.detail}`).join("; "));
  const right = observations.filter(o => o.scores.plaid.score === "RIGHT");
  assert.ok(right.length >= 18, "green Plaid controls prevent a uniform-refusal harness from passing");
  assert.ok(observations.some(o => o.scores.plaid.score === "honest-refusal"), "unsupported wordings exercise refusal controls");
  for (const o of right) assert.equal(o.scores.simplefin.score, "RIGHT", `${o.group}/${o.wording}: SimpleFIN must preserve a right Plaid answer`);
});

for (const [id, before, after, failure] of [
  ["drop-pending-dedup", "if (transaction.pending === true) continue;", "if (false && transaction.pending === true) continue;", /exactly one completed event/],
  ["invert-card-sign", 'balanceRoleFor(accountKind) === "liability" ? -currentMinor : currentMinor',
    'balanceRoleFor(accountKind) === "liability" ? (accountKind === "card" ? currentMinor : -currentMinor) : currentMinor', /card: normalized amount held or owed/],
  ["ignore-payee", "payee: row.payee || null,", "payee: null,", /structured vendor/],
]) test(`parity oracle kills the SimpleFIN-only ${id} mutant`, async t => {
  assertLedgerMatchesBook(run.simple, run.book, "simplefin");
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "simplefin-parity-mutant-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const original = readFileSync(new URL("../src/lib/simplefin-bank-feed.js", import.meta.url), "utf8");
  assert.equal(original.split(before).length, 2, "one live mutation decision, never a stale text replacement");
  let source = original.replace(before, after);
  source = source.replace(/from "(\.\/[^\"]+)"/g, (_, dependency) =>
    `from ${JSON.stringify(new URL(dependency, new URL("../src/lib/simplefin-bank-feed.js", import.meta.url)).href)}`);
  const target = join(directory, "mutant.mjs");
  writeFileSync(target, source);
  const sf = await import(pathToFileURL(target).href);
  const mutated = await buildParityLedgers({ sf, reviewCoverage: false });
  t.after(() => mutated.close());
  assertLedgerMatchesBook(mutated.plaid, mutated.book, "plaid");
  assert.throws(() => assertLedgerMatchesBook(mutated.simple, mutated.book, "simplefin"), failure,
    "the identical parity assertion must turn red after the mutation");
  mutants.push({ id, killed: true, original_sha256: createHash("sha256").update(original).digest("hex"),
    copied_mutant_sha256: createHash("sha256").update(source).digest("hex"), failure: failure.source });
});

test("parity oracle kills the drop-non-repayment-account-posting mutant", async t => {
  const posting = run.book.transactions.find(row => row.id === "reversal-out");
  assert.ok(posting && !posting.move && posting.cents < 0 && posting.day.startsWith("2026-10-"),
    "the book supplies an ordinary October debit, not a repayment leg");
  assert.equal(run.book.transactions.filter(row => row.day === posting.day && row.cents === posting.cents).length, 1,
    "the mutation selects exactly one authored posting");
  const origin = new URL("../src/lib/ledger-answer.js", import.meta.url);
  const original = readFileSync(origin, "utf8");
  const before = 'ledger.accounts = accounts.map(account => {\n      const ownRows = activity.filter(row => row.effective_account_slug === account.account_slug);';
  assert.equal(original.split(before).length, 2, "one live account-membership mutation decision");
  const omit = `!(row.posted_on === ${JSON.stringify(posting.day)} && row.amount_minor === ${Math.abs(posting.cents)} && row.direction === "outflow")`;
  const after = before.replace('row.effective_account_slug === account.account_slug',
    `row.effective_account_slug === account.account_slug && ${omit}`);
  let source = original.replace(before, after);
  source = source.replace(/from "(\.\/[^\"]+)"/g, (_, dependency) =>
    `from ${JSON.stringify(new URL(dependency, origin).href)}`);
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "parity-account-mutant-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = join(directory, "mutant.mjs");
  writeFileSync(target, source);
  const { withLedgerAnswer } = await import(pathToFileURL(target).href);
  const total = (body, key) => body.ledger.accounts.reduce((n, account) => n + account[key], 0);
  let killed = 0;
  for (const [provider, fixture] of [["plaid", run.plaid], ["simplefin", run.simple]]) {
    assertLedgerMatchesBook(fixture, run.book, provider);
    for (const [group, wordings] of questionGroups.filter(([group]) => ["money-in", "money-out"].includes(group))) {
      for (const index of [1, 3]) {
        const question = wordings[index], control = await run.ask(fixture, question);
        assert.equal(scoreAnswer(group, control.body, run.book, run.oracle).score, "RIGHT",
          `${provider}/${group}/${index + 1}: green product control`);
        const reads = fixture.seen.sql.length;
        const changed = await (await withLedgerAnswer({ env: fixture.env, question, now: NOW,
          grantScope: { all: true }, scopePrincipalKind: "owner" }, () => assert.fail("mutant must reach the ledger"))).json();
        assert.ok(fixture.seen.sql.slice(reads).some(sql => /JOIN fin_transactions/.test(sql)),
          "the mutant reached the real transaction reader");
        assert.equal(changed.ledger.kind, "totals");
        assert.equal(total(changed, "credits_minor"), total(control.body, "credits_minor"));
        assert.equal(total(changed, "debits_minor"), total(control.body, "debits_minor") - Math.abs(posting.cents),
          "the populated account totals lost exactly the non-repayment debit");
        assert.equal(total(changed, "transaction_count"), total(control.body, "transaction_count") - 1);
        assert.deepEqual(changed.ledger.lead_accounts, control.body.ledger.lead_accounts, "headline membership is unchanged");
        const score = scoreAnswer(group, changed, run.book, run.oracle);
        assert.equal(score.score, "WRONG");
        assert.equal(score.detail, "wrong account movement membership", "the same account check kills the mutant");
        killed++;
      }
    }
    assertLedgerMatchesBook(fixture, run.book, provider);
  }
  assert.equal(killed, 8, "both providers reach all four non-repayment membership decisions");
  mutants.push({ id: "drop-non-repayment-account-posting", killed: true, decisions: killed,
    original_sha256: createHash("sha256").update(original).digest("hex"),
    copied_mutant_sha256: createHash("sha256").update(source).digest("hex"), failure: "wrong account movement membership" });
});
