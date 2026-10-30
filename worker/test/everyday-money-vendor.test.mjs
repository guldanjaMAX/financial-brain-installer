import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { classifyLedgerQuestion } from "../src/lib/ledger-question.js";
import { withLedgerAnswer } from "../src/lib/ledger-answer.js";
import {
  ACCOUNTS, ANSWER_KEY, LAST_SYNCED_AT, NOW, OWNER_TIME_ZONE, REQUESTED_VENDOR_ROW_REFS,
  TRANSACTIONS, VENDOR_ORACLE_CASES, VENDOR_PAYMENT_EXCLUSION_CASES,
} from "./fixtures/everyday-money-vendor-key.mjs";

function productFixture(t, { accounts = ACCOUNTS, transactions = TRANSACTIONS } = {}) {
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
  for (const account of accounts) {
    raw(`INSERT INTO fin_accounts
      (account_slug,entity_slug,institution,label,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,'owner-unit','Institution unit',?,?,?,?,?,'feed','bank-feed:fixture-feed','confirmed',?)`,
    account.slug, account.label || `${account.kind} unit`, account.kind, account.role, account.mask, "live", NOW);
    raw(`INSERT INTO fin_account_coverage
      (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,'complete',?,?,?,'feed','bank-feed:fixture-feed','confirmed',?)`,
    account.slug, account.coveredFrom || "2026-09-01", account.coveredTo || "2026-10-29", NOW, NOW);
  }
  for (const row of transactions) {
    raw(`INSERT INTO fin_transactions
      (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,?,?,?,?,?,?,'feed','bank-feed:fixture-feed','confirmed',?)`,
    row.id, row.account, row.day, row.amount, row.direction, row.description, row.payee, NOW);
  }
  const f = { env, raw, seen, fallbackCalls: 0, sqlite, modelCalls: () => modelCalls };
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

const reachedTransactions = result => result.sql.some(sql => /JOIN fin_transactions/.test(sql));
const reachedAccounts = result => result.sql.some(sql => /FROM fin_accounts/.test(sql));
const dollarFigures = answer => String(answer || "").match(/\$\d[\d,]*\.\d{2}/g) || [];
const citationNumbers = answer => [...String(answer || "").matchAll(/\[(\d+)\]/g)].map(match => Number(match[1]));
const coverageLineCount = answer => (String(answer || "").match(/^Coverage:/gm) || []).length;
const intentShape = question => {
  const intent = classifyLedgerQuestion(question, { now: Date.parse(NOW), timeZone: OWNER_TIME_ZONE });
  return [intent.kind, intent.from, intent.to];
};

test("EA-R3 vendor spend is one figure with exactly five requested-supplier citations", async t => {
  const f = productFixture(t);
  const question = `How much did I spend at ${ANSWER_KEY.vendor.selector} this month?`;
  const classified = classifyLedgerQuestion(question, { now: Date.parse(NOW), timeZone: OWNER_TIME_ZONE });
  const positive = await f.ask(question);
  const control = intentShape(`Show me ${ANSWER_KEY.vendor.selector} spend this month?`);
  const fallbackBefore = f.fallbackCalls;
  const negative = await f.ask(`How much did I plan to spend at ${ANSWER_KEY.vendor.selector} this month?`);

  assert.deepEqual(control, ["merchant", "2026-10-01", "2026-10-29"], "green phrasing control classified");
  assert.equal(classified.match, ANSWER_KEY.vendor.selector, "requested supplier remains in classifier custody");
  assert.ok(reachedTransactions(positive), "vendor request reached transaction SQL");
  assert.equal(positive.body.ledger?.kind, "merchant");
  assert.equal(negative.body.route, "documents");
  assert.equal(f.fallbackCalls, fallbackBefore + 1, "negative sibling reached one fallback decision");
  assert.equal(reachedAccounts(negative), false);
  assert.equal(positive.body.ledger.total_minor, ANSWER_KEY.vendor.total_minor);
  assert.equal(positive.body.ledger.row_count, ANSWER_KEY.vendor.row_count);
  assert.equal(positive.body.ledger.omitted_row_count, ANSWER_KEY.vendor.omitted_row_count);
  assert.equal(dollarFigures(positive.body.answer).length, 1, "the answer contains one currency figure");
  assert.equal(positive.body.citations.length, ANSWER_KEY.vendor.cited_row_count);
  assert.equal(citationNumbers(positive.body.answer).length, ANSWER_KEY.vendor.cited_row_count);
  const requestedRefs = new Set(REQUESTED_VENDOR_ROW_REFS);
  const citedRefs = positive.body.citations.map(citation => Number(citation.ref.split(":").at(-1)));
  assert.ok(citedRefs.every(ref => requestedRefs.has(ref)), "every citation belongs to the requested supplier");
  assert.deepEqual(citedRefs, [7, 6, 5, 4, 3], "citation custody follows the requested rows only");
  assert.match(positive.body.answer, /^You spent \$2,800\.00 at Vendor Unit Red this month\./);
  assert.match(positive.body.answer, /and 2 more rows/i);
  assert.doesNotMatch(positive.body.answer, /possible (?:transfer|move)/i);
  assert.equal(coverageLineCount(positive.body.answer), 1);
  assert.equal(f.modelCalls(), 0);
});

test("vendor payment exclusions require bilateral owned-liability evidence", async t => {
  for (const scenario of VENDOR_PAYMENT_EXCLUSION_CASES) await t.test(scenario.id, async st => {
    const f = productFixture(st, { accounts: scenario.accounts, transactions: scenario.rows });
    const result = await f.ask(`How much did I spend at ${scenario.selector} this month?`);

    assert.ok(reachedTransactions(result), `${scenario.id}: transaction decision reached`);
    assert.equal(f.fallbackCalls, 0, `${scenario.id}: ledger path did not fall through`);
    assert.equal(result.body.ledger.kind, "merchant");
    assert.equal(result.body.ledger.match_basis, scenario.matchBasis);
    assert.equal(result.body.ledger.row_count, scenario.rowCount);
    assert.equal(result.body.ledger.total_minor, scenario.total);
    assert.equal(result.body.citations.length, scenario.cited);
    assert.equal(result.body.ledger.excluded_own_movement_count, scenario.excludedOwnMovements);
    assert.equal(result.body.ledger.excluded_own_movement_minor, scenario.excludedOwnMovementMinor);
    assert.equal(dollarFigures(result.body.answer).length, scenario.total === null ? 0 : 1);
    assert.equal(f.modelCalls(), 0);
  });
});

test("vendor partial-coverage oracle keeps every supported figure bounded and partial", async t => {
  for (const oracle of VENDOR_ORACLE_CASES) await t.test(oracle.id, async st => {
    const f = productFixture(st, { accounts: oracle.accounts, transactions: oracle.rows });
    const question = `How much did I spend at ${oracle.selector} this month?`;
    const result = await f.ask(question);

    if (oracle.coverage === "zero") {
      assert.equal(result.body.answer, null);
      assert.equal(result.body.gaps?.[0]?.reason, "period_outside_coverage", "zero-coverage decision reached");
      assert.equal(f.fallbackCalls, 0, "zero coverage stayed closed to document fallback");
      assert.equal(reachedTransactions(result), false);
      assert.equal(dollarFigures(result.body.answer).length, 0);

      f.raw("UPDATE fin_account_coverage SET covered_from='2026-01-01'");
      const control = await f.ask(question);
      assert.ok(reachedTransactions(control), "adjacent full-coverage control reached transaction SQL");
      assert.equal(control.body.ledger.total_minor, oracle.controlTotal);
      assert.equal(control.body.ledger.complete, true);
      assert.equal(f.modelCalls(), 0);
      return;
    }

    assert.ok(reachedTransactions(result), `${oracle.id}: transaction decision reached`);
    assert.equal(result.body.ledger.kind, "merchant");
    assert.equal(result.body.ledger.match_basis, "exact");
    assert.equal(result.body.ledger.row_count, oracle.rowCount);
    assert.equal(result.body.ledger.omitted_row_count, oracle.omittedRows);
    assert.equal(result.body.citations.length, oracle.cited);
    assert.deepEqual(result.body.citations.map(citation => Number(citation.ref.split(":").at(-1))),
      oracle.citationRefs, "posted date desc, then stable row id asc");
    assert.equal(result.body.ledger.coverage.covered_account_count, oracle.coveredAccounts);
    assert.equal(result.body.ledger.coverage.omitted_account_count, oracle.omittedAccounts);
    assert.equal(result.body.ledger.coverage.contributing_account_count, oracle.contributingAccounts);
    assert.equal(result.body.ledger.excluded_own_movement_count, oracle.excludedOwnMovements);
    assert.match(result.body.answer, /2026-10-01 through 2026-10-29/);

    if (oracle.coverage === "partial") {
      assert.equal(result.body.ledger.total_minor, null);
      assert.equal(result.body.ledger.partial_subtotal_minor, oracle.total);
      assert.equal(result.body.ledger.complete, false);
      assert.equal(result.body.evidence_gate.complete, false);
      assert.equal(result.body.evidence_gate.partial, true);
      assert.match(result.body.answer, /^Partial:/);
      assert.match(result.body.answer, /not a complete total/i);
    } else {
      assert.equal(result.body.ledger.total_minor, oracle.total);
      assert.equal(result.body.ledger.complete, true);
      assert.equal(result.body.evidence_gate.complete, true);
      assert.equal(result.body.evidence_gate.partial, false);
    }
    assert.equal(dollarFigures(result.body.answer).length, 1, "exact selector renders one figure");
    assert.equal(coverageLineCount(result.body.answer), 1);
    assert.equal(f.modelCalls(), 0);
  });
});
