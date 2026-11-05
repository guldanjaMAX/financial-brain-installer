import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { buildParityLedgers, moneyBook, oracleFor, plaidRendering, simplefinRendering, questionGroups, scoreAnswer,
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

test("verified consecutive SimpleFIN windows establish coverage after backfill and retain it on current refresh", () => {
  assert.equal(run.simple.first("SELECT state FROM bank_feed_backfill").state, "complete", "backfill completion decision reached");
  for (const row of run.simple.rows("SELECT * FROM fin_account_coverage")) {
    assert.equal(row.coverage_status, "complete", "all successful windows have a durable promotion receipt");
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
  const mutated = await buildParityLedgers({ sf });
  t.after(() => mutated.close());
  assertLedgerMatchesBook(mutated.plaid, mutated.book, "plaid");
  assert.throws(() => assertLedgerMatchesBook(mutated.simple, mutated.book, "simplefin"), failure,
    "the identical parity assertion must turn red after the mutation");
  mutants.push({ id, killed: true, original_sha256: createHash("sha256").update(original).digest("hex"),
    copied_mutant_sha256: createHash("sha256").update(source).digest("hex"), failure: failure.source });
});
