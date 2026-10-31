import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { withLedgerAnswer } from "../src/lib/ledger-answer.js";
import {
  ACCOUNTS, ANSWER_KEY, BALANCES, EXTRA_BALANCE_ACCOUNTS, LAST_SYNCED_AT, NOW, OWNER_TIME_ZONE,
} from "./fixtures/everyday-money-balance-key.mjs";

function productFixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  const migrationRoot = new URL("../../migrations/d1/", import.meta.url);
  for (const sourceFile of readdirSync(migrationRoot).filter(name => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(sourceFile, migrationRoot), "utf8"));
  }
  const seen = [];
  const execute = (sql, binds, mode) => {
    seen.push(sql);
    const statement = sqlite.prepare(sql);
    if (mode === "first") return statement.get(...binds) ?? null;
    if (mode === "all") return { results: statement.all(...binds) };
    const result = statement.run(...binds);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  };
  const prepare = (sql, binds = []) => ({
    sql, binds,
    bind: (...args) => prepare(sql, args),
    first: async () => execute(sql, binds, "first"),
    all: async () => execute(sql, binds, "all"),
    run: async () => execute(sql, binds, "run"),
  });
  let modelCalls = 0;
  const env = {
    BRAIN_TIMEZONE: OWNER_TIME_ZONE,
    AI: { async run() { modelCalls++; throw new Error("the model must not draft ledger figures"); } },
    DB: {
      prepare,
      async batch(statements) {
        sqlite.exec("BEGIN");
        try {
          const results = statements.map(statement => execute(statement.sql, statement.binds,
            /^\s*(?:SELECT|WITH|PRAGMA)\b/i.test(statement.sql) ? "all" : "run"));
          sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      },
    },
  };
  const raw = (sql, ...binds) => sqlite.prepare(sql).run(...binds);
  raw(`INSERT INTO fin_entities
    (entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('owner-unit','Owner unit','business','owned','owner_stated','confirmed',?)`, NOW);
  raw(`INSERT INTO bank_feed_items
    (item_ref,institution_label,access_ciphertext,access_iv,environment,connected_at,last_synced_at)
    VALUES ('fixture-feed','Institution unit',?,?,'sandbox',?,?)`, "A".repeat(24), "B".repeat(12), NOW, LAST_SYNCED_AT);
  for (const account of ACCOUNTS) {
    raw(`INSERT INTO fin_accounts
      (account_slug,entity_slug,institution,label,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,'owner-unit','Institution unit',?,?,?,?,?,'feed','bank-feed:fixture-feed','confirmed',?)`,
    account.slug, `${account.kind} unit`, account.kind, account.role, account.mask, "live", NOW);
    raw(`INSERT INTO fin_account_coverage
      (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,'complete','2026-09-01','2026-10-29',?,'feed','bank-feed:fixture-feed','confirmed',?)`,
    account.slug, NOW, NOW);
  }
  for (const balance of BALANCES) {
    raw(`INSERT INTO fin_balance_snapshots
      (account_slug,as_of_date,current_minor,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,?,?,'feed','bank-feed:fixture-feed','confirmed',?)`,
    balance.account, balance.day, balance.amount, NOW);
  }
  const f = { env, seen, fallbackCalls: 0, sqlite, modelCalls: () => modelCalls };
  f.addBalanceAccount = account => {
    raw(`INSERT INTO fin_accounts
      (account_slug,entity_slug,institution,label,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,'owner-unit','Institution unit',?,?,?,?,?,'feed','bank-feed:fixture-feed','confirmed',?)`,
    account.slug, `${account.kind} unit`, account.kind, account.role, account.mask, "live", NOW);
    raw(`INSERT INTO fin_account_coverage
      (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,'complete','2026-09-01','2026-10-29',?,'feed','bank-feed:fixture-feed','confirmed',?)`,
    account.slug, NOW, NOW);
    raw(`INSERT INTO fin_balance_snapshots
      (account_slug,as_of_date,current_minor,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,?,?,'feed','bank-feed:fixture-feed','confirmed',?)`,
    account.slug, account.day, account.amount, NOW);
  };
  f.ask = async question => {
    const before = seen.length;
    const response = await withLedgerAnswer({
      env, question, now: Date.parse(NOW), grantScope: { all: true }, scopePrincipalKind: "owner",
    }, async gap => {
      f.fallbackCalls++;
      return Response.json({ route: "documents", gap, answer: null, citations: [], gaps: gap ? [gap] : [] });
    });
    return { body: await response.json(), sql: seen.slice(before) };
  };
  t.after(() => sqlite.close());
  return f;
}

const reachedAccounts = result => result.sql.some(sql => /FROM fin_accounts/.test(sql));

test("EA-R5 balance leads plainly and gives each account's latest synced dated value", async t => {
  const f = productFixture(t);
  const control = await f.ask("Show me all my bank balances.");
  const positive = await f.ask("What's my balance?");
  const fallbackBefore = f.fallbackCalls;
  const negative = await f.ask("What is my balance at the named bank?");

  assert.equal(control.body.ledger?.kind, "balance", "green balance phrasing reached the ledger");
  assert.ok(control.sql.some(sql => /fin_balance_snapshots/.test(sql)), "green control reached balance SQL");
  assert.equal(positive.body.ledger?.kind, "balance");
  assert.ok(positive.sql.some(sql => /fin_balance_snapshots/.test(sql)), "positive reached balance SQL");
  assert.equal(negative.body.route, "documents");
  assert.equal(f.fallbackCalls, fallbackBefore + 1, "negative sibling reached one fallback decision");
  assert.equal(reachedAccounts(negative), false);
  assert.deepEqual(positive.body.ledger.accounts.map(account => [
    account.account_mask, account.current_minor, account.as_of, account.last_synced_at,
  ]), ANSWER_KEY.balances);
  assert.match(positive.body.answer, /^Your latest synced balances are below\./);
  assert.ok(positive.body.citations.length <= 5);
  for (const [, amount, day] of ANSWER_KEY.balances) {
    assert.match(positive.body.answer, new RegExp(`\\$${(amount / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}.*${day}`));
  }
  assert.equal(f.modelCalls(), 0);
});

test("R1W-003 a six-account answer shows five cited values and an exact remainder clause", async t => {
  const f = productFixture(t);
  for (const account of EXTRA_BALANCE_ACCOUNTS) f.addBalanceAccount(account);
  const result = await f.ask("What are my account balances?");

  assert.equal(result.body.ledger?.kind, "balance", "six-account fixture reached the balance decision");
  assert.ok(result.sql.some(sql => /fin_balance_snapshots/.test(sql)), "six-account fixture reached balance SQL");
  assert.equal(result.body.ledger.accounts.length, 6, "all six structured balances were read");
  assert.equal(result.body.citations.length, 5, "the citation cap was reached");
  const valueLines = result.body.answer.split("\n").filter(line => line.includes("$"));
  assert.equal(valueLines.length, 5, "no uncited sixth value is shown");
  assert.ok(valueLines.every(line => /\[\d+\]\.$/.test(line)), "every shown value has a citation marker");
  assert.ok(result.body.answer.endsWith("\nand 1 more accounts"));
  assert.doesNotMatch(result.body.answer, /\$654\.32/);
});

test("R1W-003 five-account control shows and cites every value without a remainder clause", async t => {
  const f = productFixture(t);
  f.addBalanceAccount(EXTRA_BALANCE_ACCOUNTS[0]);
  const result = await f.ask("What are my account balances?");

  assert.equal(result.body.ledger?.kind, "balance", "five-account control reached the balance decision");
  assert.ok(result.sql.some(sql => /fin_balance_snapshots/.test(sql)), "five-account control reached balance SQL");
  assert.equal(result.body.ledger.accounts.length, 5);
  assert.equal(result.body.citations.length, 5);
  const valueLines = result.body.answer.split("\n").filter(line => line.includes("$"));
  assert.equal(valueLines.length, 5);
  assert.ok(valueLines.every(line => /\[\d+\]\.$/.test(line)));
  assert.doesNotMatch(result.body.answer, /and \d+ more accounts/);
  assert.match(result.body.answer, /\$7,654\.32/);
});
