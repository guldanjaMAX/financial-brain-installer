import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { classifyLedgerQuestion } from "../src/lib/ledger-question.js";
import { withLedgerAnswer } from "../src/lib/ledger-answer.js";
import {
  ACCOUNTS, ANSWER_KEY, LAST_SYNCED_AT, NOW, OWNER_TIME_ZONE, TRANSACTIONS,
} from "./fixtures/everyday-money-expenses-key.mjs";

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
    account.slug, `${account.kind} unit`, account.kind, account.role, account.mask, "live", NOW);
    raw(`INSERT INTO fin_account_coverage
      (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,?, '2026-09-01','2026-10-29',?,'feed','bank-feed:fixture-feed','confirmed',?)`,
    account.slug, account.coverageStatus || "complete", NOW, NOW);
  }
  for (const row of transactions) {
    raw(`INSERT INTO fin_transactions
      (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,?,?,?,?,?,?,'feed','bank-feed:fixture-feed','confirmed',?)`,
    row.id, row.account, row.day, row.amount, row.direction, row.description, row.payee, NOW);
  }
  const f = { env, seen, fallbackCalls: 0, documentAnswer: null, sqlite, modelCalls: () => modelCalls, raw };
  f.ask = async question => {
    const before = seen.length;
    const response = await withLedgerAnswer({
      env, question, now: Date.parse(NOW), grantScope: { all: true }, scopePrincipalKind: "owner",
    }, async gap => {
      f.fallbackCalls++;
      return Response.json({ route: "documents", gap, answer: f.documentAnswer, citations: [], gaps: gap ? [gap] : [] });
    });
    return { body: await response.json(), sql: seen.slice(before) };
  };
  t.after(() => sqlite.close());
  return f;
}

const reachedTransactions = result => result.sql.some(sql => /JOIN fin_transactions/.test(sql));
const reachedAccounts = result => result.sql.some(sql => /FROM fin_accounts/.test(sql));
const citationNumbers = answer => [...String(answer || "").matchAll(/\[(\d+)\]/g)].map(match => Number(match[1]));
const coverageLineCount = answer => (String(answer || "").match(/^Coverage:/gm) || []).length;
const intentShape = question => {
  const intent = classifyLedgerQuestion(question, { now: Date.parse(NOW), timeZone: OWNER_TIME_ZONE });
  return [intent.kind, intent.from, intent.to];
};

test("EA-R2 expenses group merchants and separate connected loan or card payments", async t => {
  const f = productFixture(t);
  const control = await f.ask("What were my ten largest expenses in October?");
  const positive = await f.ask("What are my expenses this month?");
  const fallbackBefore = f.fallbackCalls;
  const negative = await f.ask("What are my projected expenses this month?");
  const variants = [
    "What went out today?", "How much went out yesterday?", "What are my expenses this week?",
    "How much did I spend this month?", "What were my expenses last month?",
  ].map(question => [question, ...intentShape(question)]);
  const composedEveryday = intentShape("How much did I spend in the past month?");

  assert.equal(control.body.ledger?.kind, "largest", "green expense-list control reached the ledger");
  assert.ok(reachedTransactions(control), "green control reached transaction SQL");
  assert.ok(reachedTransactions(positive), "positive expense request reached transaction SQL");
  assert.equal(negative.body.route, "documents");
  assert.equal(f.fallbackCalls, fallbackBefore + 1, "negative sibling reached one fallback decision");
  assert.equal(reachedAccounts(negative), false);
  assert.deepEqual(variants, [
    ["What went out today?", "expense_summary", "2026-10-29", "2026-10-29"],
    ["How much went out yesterday?", "expense_summary", "2026-10-28", "2026-10-28"],
    ["What are my expenses this week?", "expense_summary", "2026-10-26", "2026-10-29"],
    ["How much did I spend this month?", "expense_summary", "2026-10-01", "2026-10-29"],
    ["What were my expenses last month?", "expense_summary", "2026-09-01", "2026-09-30"],
  ], "all everyday variants reached a nonuniform classifier decision");
  assert.deepEqual(composedEveryday, ["expense_summary", "2026-09-30", "2026-10-29"],
    "the neighboring everyday-phrasing window is reused with the summary kind");
  assert.equal(positive.body.ledger?.kind, "expense_summary");
  assert.equal(positive.body.ledger.total_minor, ANSWER_KEY.expenses.total_minor);
  assert.equal(positive.body.ledger.row_count, ANSWER_KEY.expenses.row_count);
  assert.deepEqual(positive.body.ledger.groups.map(group => [group.merchant, group.total_minor, group.count]),
    ANSWER_KEY.expenses.groups);
  assert.equal(positive.body.ledger.excluded_own_transfer_minor, ANSWER_KEY.expenses.excluded_own_transfer_minor);
  assert.deepEqual({
    total_minor: positive.body.ledger.own_account_payments.total_minor,
    count: positive.body.ledger.own_account_payments.count,
    card_minor: positive.body.ledger.own_account_payments.card_minor,
    loan_minor: positive.body.ledger.own_account_payments.loan_minor,
  }, ANSWER_KEY.expenses.own_account_payments);
  assert.ok(positive.body.citations.length <= 5);
  assert.ok(citationNumbers(positive.body.answer).length <= 5);
  assert.match(positive.body.answer, /^You spent \$3,265\.00 this month\./);
  assert.match(positive.body.answer, /payments to your own loan\/card accounts/i);
  assert.match(positive.body.answer, /and 9 more rows/i);
  assert.equal(coverageLineCount(positive.body.answer), 1);
  assert.doesNotMatch(positive.body.answer, /\b(?:credits|debits)\b/i);
  assert.equal(f.modelCalls(), 0);
});

test("M3B spend wording has one expense-summary route with vendor and category groups", async t => {
  const f = productFixture(t);
  f.raw(`UPDATE fin_transactions
    SET category=CASE WHEN payee LIKE 'Vendor Unit%' THEN 'Software' ELSE 'Operations' END,
        category_basis_state='confirmed'
    WHERE direction='outflow'`);
  f.raw(`INSERT INTO fin_transactions
    (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,category,
     category_basis_state,provenance,source_feed,basis_state,recorded_at)
    VALUES ('last-month-vendor','checking-unit','2026-09-20',4200,'outflow','Fixture vendor',
      'Fixture vendor','Operations','confirmed','feed','bank-feed:fixture-feed','confirmed',?)`, NOW);
  const currentQuestions = [
    "What did I spend this month, and on what?",
    "What did I spend this month?",
    "What was my spending this month?",
    "What were my expenses this month?",
    "What went out this month?",
    "How much money went out this month?",
  ];
  const answers = [];
  for (const question of currentQuestions) {
    const result = await f.ask(question);
    assert.ok(reachedTransactions(result), `${question}: transaction decision reached`);
    assert.equal(result.body.ledger?.kind, "expense_summary", question);
    assert.equal(result.body.ledger.total_minor, ANSWER_KEY.expenses.total_minor, question);
    answers.push(result.body.ledger.total_minor);
  }
  assert.equal(new Set(answers).size, 1, "every current spend synonym returns the same figure");

  const composed = await f.ask("What did I spend last month, and on what?");
  assert.ok(reachedTransactions(composed), "last-month composed wording reached transaction SQL");
  assert.equal(composed.body.ledger?.kind, "expense_summary");
  assert.ok(composed.body.ledger.groups.length > 0, "vendor grouping decision reached");
  assert.ok(composed.body.ledger.category_groups.length > 0, "category grouping decision reached");
  assert.match(composed.body.answer, /^You spent \$[\d,]+\.\d{2} last month\./);
  assert.match(composed.body.answer, /^Merchant groups:$/m);
  assert.match(composed.body.answer, /^Category groups:$/m);
  assert.doesNotMatch(composed.body.answer, /\b(?:credits|debits)\b/i);

  const fallbackBefore = f.fallbackCalls;
  const negative = await f.ask("What were my projected expenses this month?");
  assert.equal(negative.body.route, "documents", "planning wording remains a document question");
  assert.equal(f.fallbackCalls, fallbackBefore + 1, "negative sibling reached document routing once");
  assert.equal(reachedAccounts(negative), false);

  const control = await f.ask("What were my ten largest expenses in October?");
  assert.equal(control.body.ledger?.kind, "largest", "green list control keeps its distinct route");
  assert.ok(reachedTransactions(control));
  assert.equal(f.modelCalls(), 0);
});

test("M3B one endpoint matcher drives came-in, spent, and vendor lead exclusions", async t => {
  const pair = [
    { id: "movement-out", account: "checking-unit", day: "2026-10-20", amount: 33333,
      direction: "outflow", description: "ONLINE TRANSFER TO account 2202", payee: "savings unit" },
    { id: "movement-in", account: "savings-unit", day: "2026-10-20", amount: 33333,
      direction: "inflow", description: "ONLINE TRANSFER FROM account 1101", payee: "checking unit" },
    { id: "ordinary-out", account: "checking-unit", day: "2026-10-21", amount: 2500,
      direction: "outflow", description: "Fixture vendor", payee: "Fixture vendor" },
    { id: "ordinary-in", account: "checking-unit", day: "2026-10-22", amount: 4000,
      direction: "inflow", description: "Fixture customer", payee: "Fixture customer" },
  ];
  const f = productFixture(t, { transactions: pair });
  const cameIn = await f.ask("How much money came in this month?");
  const spent = await f.ask("What are my expenses this month?");
  const vendors = await f.ask("Show spending by merchant this month");
  for (const [label, result] of [["came in", cameIn], ["spent", spent], ["vendor totals", vendors]]) {
    assert.ok(reachedTransactions(result), `${label}: transaction decision reached`);
    assert.equal(result.body.ledger.candidate_transfer_count, 1, `${label}: pairing decision reached`);
  }
  assert.equal(cameIn.body.ledger.lead_accounts.reduce((sum, row) => sum + row.credits_minor, 0), 4000);
  assert.equal(cameIn.body.ledger.lead_accounts.reduce((sum, row) => sum + row.debits_minor, 0), 2500);
  assert.equal(spent.body.ledger.total_minor, 2500);
  assert.equal(spent.body.ledger.excluded_own_transfer_minor, 33333);
  assert.equal(vendors.body.ledger.lead_total_minor, 2500);
  assert.equal(vendors.body.ledger.default_exclusions.own_transfer_minor, 33333);

  const negative = productFixture(t, { transactions: pair.map(row => row.id === "movement-in"
    ? { ...row, description: "TRANSFER FROM outside account 9999", payee: null } : row) });
  const retained = await negative.ask("How much money came in this month?");
  assert.ok(reachedTransactions(retained), "unproved sibling reached transaction SQL");
  assert.equal(retained.body.ledger.candidate_transfer_count, 1, "unproved sibling reached pairing");
  assert.equal(retained.body.ledger.lead_accounts.reduce((sum, row) => sum + row.credits_minor, 0), 37333,
    "unproved movement remains in the figure");

  const analysisSource = readFileSync(new URL("../src/lib/ledger-analysis.js", import.meta.url), "utf8");
  const liabilityMatcher = /export function ownedLiabilityPaymentKind[\s\S]+?\n}/.exec(analysisSource)?.[0] || "";
  assert.match(liabilityMatcher, /transferEndpoints\(/, "connected-liability parsing calls the shared matcher");
  assert.doesNotMatch(liabilityMatcher, /\.match\(/, "connected-liability parsing has no private endpoint regex");
  assert.equal((analysisSource.match(/function transferEndpoints\(/g) || []).length, 1,
    "there is one endpoint matcher implementation");
  assert.equal(f.modelCalls() + negative.modelCalls(), 0);
});

test("M3B route precedence keeps non-money owner questions outside every money route", async () => {
  const nonMoney = [
    "what are the office expense reimbursement rules",
    "what does the travel expense policy require",
    "where is the company credit card policy",
    "summarize the invoice approval process",
    "how much floor space does the office have",
    "who did I meet with last week",
    "what did my lawyer say about the hearing",
    "how much paint does the hallway need",
    "how much time is left in the workshop",
    "how much storage space is available",
    "how many pages are in the proposal",
    "what did the contractor say about the schedule",
    "where are the meeting notes",
    "when is the next hearing",
    "what did the doctor recommend",
    "summarize the office lease clause",
    "how much savings in time did the automation create",
    "how much interest did the article generate",
    "what card did the designer choose for the invitation",
  ];
  let fallbackCalls = 0, ledgerCalls = 0;
  for (const question of nonMoney) {
    const intent = classifyLedgerQuestion(question, { now: Date.parse(NOW), timeZone: OWNER_TIME_ZONE });
    assert.deepEqual(intent, { broad: false, kind: null }, question);
    const raw = '{"route":"documents", "gaps":[]}';
    const expected = new Response(raw, { headers: { "X-Document-Result": "preserved" } });
    const response = await withLedgerAnswer({
      env: { BRAIN_TIMEZONE: OWNER_TIME_ZONE, DB: { prepare() { ledgerCalls++; throw new Error("ledger reached"); } } },
      question, now: Date.parse(NOW), grantScope: { all: true }, scopePrincipalKind: "owner",
    }, async gap => {
      fallbackCalls++;
      assert.equal(gap, null, `${question}: no money gap reached the document route`);
      return expected;
    });
    assert.equal(response, expected, `${question}: exact document response object is preserved`);
    assert.equal(await response.text(), raw, `${question}: exact document response bytes are preserved`);
    assert.equal(response.headers.get("X-Document-Result"), "preserved");
  }
  assert.equal(fallbackCalls, nonMoney.length, "every non-money routing decision was reached");
  assert.equal(ledgerCalls, 0, "no non-money question reached ledger inventory");

  const unsupportedRaw = '{"route":"documents", "gaps":[]}';
  const unsupportedDocument = new Response(unsupportedRaw);
  let unsupportedFallbackCalls = 0;
  const unsupportedResponse = await withLedgerAnswer({
    env: { BRAIN_TIMEZONE: OWNER_TIME_ZONE, DB: { prepare() { ledgerCalls++; throw new Error("ledger reached"); } } },
    question: "What invoice was paid in January 2020?", now: Date.parse(NOW),
    grantScope: { all: true }, scopePrincipalKind: "owner",
  }, async gap => {
    unsupportedFallbackCalls++;
    assert.equal(gap?.reason, "ledger_wording_unsupported", "true unsupported-money decision reached");
    return unsupportedDocument;
  });
  assert.equal(unsupportedFallbackCalls, 1);
  assert.notEqual(unsupportedResponse, unsupportedDocument, "unsupported money still adds a gap");
  assert.equal((await unsupportedResponse.json()).gaps[0].reason, "ledger_wording_unsupported");
  assert.equal(ledgerCalls, 0, "unsupported wording does not read ledger inventory");

  const moneyRoutes = [
    ["What is my current balance?", "balance"],
    ["How much money came in and went out this month?", "totals"],
    ["What did I spend this month?", "expense_summary"],
    ["What were my ten largest expenses this month?", "largest"],
    ["Show my recent deposits", "deposits"],
    ["How much did I spend at Fixture Vendor this month?", "merchant"],
    ["Show spending by category this month", "category"],
    ["What are my recurring charges?", "recurring"],
    ["Show my own-account transfers this month", "transfers"],
    ["What was my profit this month?", "totals"],
    ["Did the payment from Fixture Payer arrive?", "payment"],
    ["Show my last 3 transactions", "transactions"],
  ];
  const landed = moneyRoutes.map(([question, expected]) => {
    const intent = classifyLedgerQuestion(question, { now: Date.parse(NOW), timeZone: OWNER_TIME_ZONE });
    assert.equal(intent.kind, expected, question);
    assert.equal(intent.broad, true, question);
    return intent.kind;
  });
  assert.ok(new Set(landed).size >= 10, "money controls reached distinct intended routes");
});

test("EA-R2 expense movement pairs require an in-window outgoing leg", async t => {
  const arms = [
    { name: "same-window card payment", outDay: "2026-10-01", inDay: "2026-10-02",
      inAccount: "card-unit", outDescription: "PAYMENT TO CARD ENDING 3303", inDescription: "PAYMENT THANK YOU",
      paymentMinor: 51234, paymentCount: 1, transferMinor: 0 },
    { name: "straddling card payment", outDay: "2026-09-30", inDay: "2026-10-01",
      inAccount: "card-unit", outDescription: "PAYMENT TO CARD ENDING 3303", inDescription: "PAYMENT THANK YOU",
      paymentMinor: 0, paymentCount: 0, transferMinor: 0 },
    { name: "same-window loan payment", outDay: "2026-10-01", inDay: "2026-10-02",
      inAccount: "loan-unit", outDescription: "TRANSFER TO LOAN ACCT 4404", inDescription: "TRANSFER FROM ACCOUNT 1101",
      paymentMinor: 51234, paymentCount: 1, transferMinor: 0 },
    { name: "straddling loan payment", outDay: "2026-09-30", inDay: "2026-10-01",
      inAccount: "loan-unit", outDescription: "TRANSFER TO LOAN ACCT 4404", inDescription: "TRANSFER FROM ACCOUNT 1101",
      paymentMinor: 0, paymentCount: 0, transferMinor: 0 },
    { name: "same-window line-of-credit payment", outDay: "2026-10-01", inDay: "2026-10-02",
      accounts: [...ACCOUNTS, { slug: "loc-unit", mask: "5505", kind: "line_of_credit", role: "liability" }],
      inAccount: "loc-unit", outDescription: "TRANSFER TO LINE OF CREDIT 5505", inDescription: "TRANSFER FROM ACCOUNT 1101",
      paymentMinor: 51234, paymentCount: 1, transferMinor: 0 },
    { name: "straddling line-of-credit payment", outDay: "2026-09-30", inDay: "2026-10-01",
      accounts: [...ACCOUNTS, { slug: "loc-unit", mask: "5505", kind: "line_of_credit", role: "liability" }],
      inAccount: "loc-unit", outDescription: "TRANSFER TO LINE OF CREDIT 5505", inDescription: "TRANSFER FROM ACCOUNT 1101",
      paymentMinor: 0, paymentCount: 0, transferMinor: 0 },
    { name: "same-window own transfer", outDay: "2026-10-01", inDay: "2026-10-02",
      inAccount: "savings-unit", outDescription: "TRANSFER FROM X1101 TO X2202", inDescription: "TRANSFER FROM X1101 TO X2202",
      paymentMinor: 0, paymentCount: 0, transferMinor: 51234 },
    { name: "straddling own transfer", outDay: "2026-09-30", inDay: "2026-10-01",
      inAccount: "savings-unit", outDescription: "TRANSFER FROM X1101 TO X2202", inDescription: "TRANSFER FROM X1101 TO X2202",
      paymentMinor: 0, paymentCount: 0, transferMinor: 0 },
  ];
  for (const arm of arms) {
    const f = productFixture(t, { accounts: arm.accounts || ACCOUNTS, transactions: [
      { id: `${arm.name}-out`, account: "checking-unit", day: arm.outDay, amount: 51234,
        direction: "outflow", description: arm.outDescription, payee: null },
      { id: `${arm.name}-in`, account: arm.inAccount, day: arm.inDay, amount: 51234,
        direction: "inflow", description: arm.inDescription, payee: null },
    ] });
    const result = await f.ask("What are my expenses this month?");

    assert.ok(reachedTransactions(result), `${arm.name} reached transaction SQL`);
    assert.equal(result.body.ledger.candidate_transfer_count, 1, `${arm.name} reached pairing`);
    assert.equal(result.body.ledger.total_minor, 0);
    assert.equal(result.body.ledger.excluded_own_transfer_minor, arm.transferMinor);
    assert.equal(result.body.ledger.own_account_payments.total_minor, arm.paymentMinor);
    assert.equal(result.body.ledger.own_account_payments.count, arm.paymentCount);
    if (arm.paymentCount === 0) assert.doesNotMatch(result.body.answer, /\$512\.34/);
    assert.equal(f.modelCalls(), 0);
  }
});

test("EA-R2 generic bank payees do not override an exact connected-liability locator", async t => {
  const genericPayees = [
    "PAYMENT", "AUTOMATIC PAYMENT", "INTERNET PAYMENT", "MOBILE PAYMENT", "ONLINE PAYMENT",
    "TRANSFER", "AUTOMATIC TRANSFER", "INTERNET TRANSFER", "MOBILE TRANSFER", "ONLINE TRANSFER",
  ];
  for (const payee of genericPayees) {
    const f = productFixture(t, { transactions: [
      { id: `generic-${payee.toLowerCase().replaceAll(" ", "-")}`, account: "checking-unit", day: "2026-10-21",
        amount: 45678, direction: "outflow", description: "TRANSFER TO LOAN ACCT 4404", payee },
    ] });
    const result = await f.ask("What are my expenses this month?");

    assert.ok(reachedTransactions(result), `${payee} reached transaction SQL`);
    assert.equal(result.body.ledger.total_minor, 0, `${payee} is not an ordinary expense`);
    assert.deepEqual(result.body.ledger.own_account_payments,
      { total_minor: 45678, count: 1, card_minor: 0, loan_minor: 45678 });
    assert.equal(f.modelCalls(), 0);
  }

  const external = productFixture(t, { transactions: [
    { id: "external-named-payee", account: "checking-unit", day: "2026-10-21", amount: 45678,
      direction: "outflow", description: "TRANSFER TO LOAN ACCT 4404", payee: "Utility Unit" },
  ] });
  const externalResult = await external.ask("What are my expenses this month?");
  assert.ok(reachedTransactions(externalResult), "external-payee control reached transaction SQL");
  assert.equal(externalResult.body.ledger.total_minor, 45678);
  assert.deepEqual(externalResult.body.ledger.own_account_payments,
    { total_minor: 0, count: 0, card_minor: 0, loan_minor: 0 });
  assert.equal(external.modelCalls(), 0);
});

test("EA-R2 bilateral owned-liability pairing uses the same bounded payee rule", async t => {
  const arms = [
    { name: "generic payee", payee: "AUTOMATIC PAYMENT", paymentMinor: 45678, ordinaryMinor: 0 },
    { name: "external named payee", payee: "Utility Unit", paymentMinor: 0, ordinaryMinor: 45678 },
  ];
  for (const arm of arms) {
    const f = productFixture(t, { transactions: [
      { id: `${arm.name}-out`, account: "checking-unit", day: "2026-10-21", amount: 45678,
        direction: "outflow", description: "TRANSFER FROM X1101 TO X4404", payee: arm.payee },
      { id: `${arm.name}-in`, account: "loan-unit", day: "2026-10-21", amount: 45678,
        direction: "inflow", description: "TRANSFER FROM X1101 TO X4404", payee: null },
    ] });
    const result = await f.ask("What are my expenses this month?");

    assert.ok(reachedTransactions(result), `${arm.name} reached transaction SQL`);
    assert.equal(result.body.ledger.candidate_transfer_count, 1, `${arm.name} reached pairing`);
    assert.equal(result.body.ledger.total_minor, arm.ordinaryMinor);
    assert.equal(result.body.ledger.own_account_payments.total_minor, arm.paymentMinor);
    assert.equal(f.modelCalls(), 0);
  }
});

test("EA-R2 partial coverage returns only the supported subtotal and names exclusions", async t => {
  const f = productFixture(t);
  f.raw("UPDATE fin_account_coverage SET coverage_status='partial' WHERE account_slug IN ('card-unit','loan-unit')");
  const result = await f.ask("What are my expenses this month?");

  assert.ok(reachedTransactions(result), "partial decision reached transaction SQL");
  assert.equal(result.body.ledger?.kind, "expense_summary");
  assert.equal(result.body.ledger.total_minor, 46500);
  assert.equal(result.body.ledger.row_count, 7);
  assert.deepEqual(result.body.ledger.groups.map(group => [group.merchant, group.total_minor, group.count]), [
    ["utility unit", 11000, 1],
    ["vendor unit purple", 9000, 1],
    ["atm withdrawal", 7500, 1],
    ["vendor unit orange", 6500, 1],
    ["vendor unit blue", 5000, 1],
    ["zelle to outside payee", 4000, 1],
    ["p2p payment outside payee", 3500, 1],
  ]);
  assert.equal(result.body.ledger.excluded_own_transfer_minor, 33333);
  assert.deepEqual(result.body.ledger.own_account_payments,
    { total_minor: 96912, count: 2, card_minor: 51234, loan_minor: 45678 });
  assert.deepEqual({
    status: result.body.ledger.coverage.status,
    complete: result.body.ledger.coverage.complete,
    covered: result.body.ledger.coverage.covered_account_count,
    omitted: result.body.ledger.coverage.omitted_account_count,
  }, { status: "partial", complete: false, covered: 2, omitted: 2 });
  assert.deepEqual(result.body.ledger.coverage.excluded_accounts.map(account => account.account_mask), ["3303", "4404"]);
  assert.equal(result.body.evidence_gate.complete, false);
  assert.equal(result.body.evidence_gate.partial, true, "partial coverage is explicit in the response contract");
  assert.match(result.body.evidence_gate.reason, /partial ledger coverage/);
  assert.match(result.body.answer, /^Covered-account expense subtotal: \$465\.00 this month \(partial coverage\)\./);
  assert.match(result.body.answer, /^Coverage: partial,.*excluded account \*\*\*\*3303, account \*\*\*\*4404\.$/m);
  assert.equal(coverageLineCount(result.body.answer), 1);
  assert.equal(result.body.citations.length, 5);
  assert.equal(result.body.ledger.omitted_row_count, 2);
  assert.equal(f.fallbackCalls, 0);
  assert.equal(f.modelCalls(), 0);
});

test("EA-R5 supported spend intents fail closed whenever the ledger cannot answer", async t => {
  const intents = [
    { label: "expense summary", question: "What are my expenses this month?",
      maskedQuestion: "What are my expenses this month for account ending 9999?",
      kind: "expense_summary", total: ANSWER_KEY.expenses.total_minor },
    { label: "exact named vendor", question: "How much did I spend at Vendor Unit Red this month?",
      maskedQuestion: "How much did I spend at Vendor Unit Red this month for account ending 9999?",
      kind: "merchant", total: null, matchBasis: "exact_and_possible",
      exactSubtotal: 160000, possibleSubtotal: 120000 },
  ];
  const refusalArms = [
    { label: "all accounts uncovered", reason: "period_outside_coverage",
      fixture: st => {
        const f = productFixture(st);
        f.raw("UPDATE fin_account_coverage SET coverage_status='partial'");
        return f;
      },
      question: intent => intent.question },
    { label: "empty account inventory", reason: "no_accounts",
      fixture: st => productFixture(st, { accounts: [], transactions: [] }),
      question: intent => intent.question },
    { label: "unmatched account mask", reason: "no_accounts",
      fixture: st => productFixture(st),
      question: intent => intent.maskedQuestion },
  ];

  for (const intent of intents) await t.test(intent.label, async st => {
    for (const refusalArm of refusalArms) await st.test(refusalArm.label, async refusalTest => {
      const f = refusalArm.fixture(refusalTest);
      f.documentAnswer = "$9,999.99 from unrelated document text";
      const refused = await f.ask(refusalArm.question(intent));

      assert.equal(refused.body.ledger, undefined);
      assert.equal(refused.body.answer, null);
      assert.equal(refused.body.gaps?.[0]?.reason, refusalArm.reason,
        `${refusalArm.label} account decision reached`);
      assert.equal(f.fallbackCalls, 0, "document callback stayed closed");
      assert.ok(reachedAccounts(refused), `${refusalArm.label} reached account inventory`);
      assert.equal(reachedTransactions(refused), false);
      assert.doesNotMatch(JSON.stringify(refused.body), /\$\d/,
        "a document-derived currency figure cannot cross the refusal boundary");
      assert.equal(f.modelCalls(), 0);
    });

    const control = productFixture(st);
    const supported = await control.ask(intent.question);
    assert.ok(reachedTransactions(supported), "valid-account control reached transaction SQL");
    assert.equal(supported.body.ledger.kind, intent.kind);
    assert.equal(supported.body.ledger.total_minor, intent.total);
    if (intent.matchBasis) assert.equal(supported.body.ledger.match_basis, intent.matchBasis);
    if (intent.exactSubtotal) {
      assert.equal(supported.body.ledger.exact_subtotal_minor, intent.exactSubtotal);
      assert.equal(supported.body.ledger.possible_subtotal_minor, intent.possibleSubtotal);
      assert.equal(supported.body.evidence_gate.complete, false);
    }
    assert.match(supported.body.answer, /\$\d/, "valid-account control retained its supported figure");
    assert.ok(supported.body.citations.length > 0, "valid-account control retained amount-bearing citations");
    assert.equal(control.fallbackCalls, 0);
    assert.equal(control.modelCalls(), 0);
  });

  await t.test("unrelated document question", async st => {
    const f = productFixture(st);
    f.documentAnswer = "$9,999.99 from unrelated document text";
    const result = await f.ask("What are my projected expenses this month?");
    assert.equal(result.body.route, "documents");
    assert.equal(result.body.answer, f.documentAnswer);
    assert.equal(f.fallbackCalls, 1, "unrelated intent retained document fallback");
    assert.equal(reachedAccounts(result), false);
    assert.equal(reachedTransactions(result), false);
  });
});

test("EA-R2 periodless form defaults narrowly to the owner-zone current month", async t => {
  const f = productFixture(t);
  const intent = classifyLedgerQuestion("What are my expenses?", {
    now: Date.parse("2026-10-30T02:00:00.000Z"), timeZone: OWNER_TIME_ZONE,
  });
  assert.deepEqual([intent.kind, intent.from, intent.to],
    ["expense_summary", "2026-10-01", "2026-10-29"], "owner-zone period decision reached");
  const result = await f.ask("What are my expenses?");
  assert.equal(result.body.ledger?.kind, "expense_summary");
  assert.deepEqual([result.body.ledger.from, result.body.ledger.to], ["2026-10-01", "2026-10-29"]);
  assert.match(result.body.answer, /Period: 2026-10-01 through 2026-10-29\./);
  assert.equal(f.modelCalls(), 0);
});

test("3B-R1 periodless expenses fail closed for every unavailable owner time zone", async t => {
  for (const [zoneState, timeZone] of [["missing", null], ["invalid", "Invalid/Zone"]]) {
    await t.test(zoneState, async st => {
      const f = productFixture(st);
      if (timeZone === null) delete f.env.BRAIN_TIMEZONE;
      else f.env.BRAIN_TIMEZONE = timeZone;
      f.documentAnswer = "$9,999.99 from unrelated document text";
      const fallbackBefore = f.fallbackCalls;
      const refused = await f.ask("What are my expenses?");

      assert.equal(refused.body.code, "owner_timezone_unavailable", `${zoneState}: refusal code`);
      assert.equal(refused.body.answer, null, `${zoneState}: no computed answer`);
      assert.equal(refused.body.ledger, undefined, `${zoneState}: no ledger result`);
      assert.equal(refused.body.gaps?.[0]?.reason, "owner_timezone_unavailable",
        `${zoneState}: time-zone decision reached`);
      assert.equal(f.fallbackCalls, fallbackBefore, `${zoneState}: document fallback stayed closed`);
      assert.equal(reachedAccounts(refused), false, `${zoneState}: no account read`);
      assert.equal(reachedTransactions(refused), false, `${zoneState}: no transaction read`);
      assert.equal(f.modelCalls(), 0, `${zoneState}: no model call`);
    });
  }

  await t.test("valid owner zone", async st => {
    const f = productFixture(st);
    const answered = await f.ask("What are my expenses?");
    assert.equal(answered.body.ledger?.kind, "expense_summary", "normal-answer decision reached");
    assert.deepEqual([answered.body.ledger.from, answered.body.ledger.to],
      ["2026-10-01", "2026-10-29"]);
    assert.ok(reachedTransactions(answered), "valid-zone sibling reached transaction SQL");
    assert.equal(f.modelCalls(), 0);
  });

  await t.test("explicit historical month", async st => {
    const f = productFixture(st);
    delete f.env.BRAIN_TIMEZONE;
    const answered = await f.ask("What were my expenses in September 2026?");
    assert.equal(answered.body.ledger?.kind, "expense_summary", "fixed historical control answered");
    assert.deepEqual([answered.body.ledger.from, answered.body.ledger.to],
      ["2026-09-01", "2026-09-30"]);
    assert.ok(reachedTransactions(answered), "fixed historical control reached transaction SQL");
    assert.equal(f.modelCalls(), 0);
  });
});

test("EA-R2 invalid owner time zone refuses before ledger reads", async t => {
  const f = productFixture(t);
  f.env.BRAIN_TIMEZONE = "Invalid/Zone";
  const before = f.fallbackCalls;
  const result = await f.ask("What are my expenses this month?");

  assert.equal(result.body.code, "owner_timezone_unavailable");
  assert.equal(result.body.answer, null);
  assert.equal(result.body.ledger, undefined);
  assert.equal(result.body.gaps?.[0]?.reason, "owner_timezone_unavailable");
  assert.equal(f.fallbackCalls, before, "invalid-zone no-SQL decision stayed a plain refusal");
  assert.equal(reachedAccounts(result), false);
  assert.equal(reachedTransactions(result), false);
  assert.equal(f.modelCalls(), 0);
});

test("M3B expense summary gives a plain owner-time-zone refusal with usable siblings", async t => {
  for (const [zoneState, timeZone] of [["missing", null], ["invalid", "Invalid/Zone"]]) {
    const f = productFixture(t);
    if (timeZone === null) delete f.env.BRAIN_TIMEZONE;
    else f.env.BRAIN_TIMEZONE = timeZone;
    const fallbackBefore = f.fallbackCalls;
    const refused = await f.ask("What did I spend this month, and on what?");
    assert.equal(refused.body.code, "owner_timezone_unavailable", `${zoneState}: plain refusal code`);
    assert.equal(refused.body.answer, null, `${zoneState}: no spend figure`);
    assert.equal(refused.body.gaps?.[0]?.reason, "owner_timezone_unavailable", `${zoneState}: decision reached`);
    assert.equal(f.fallbackCalls, fallbackBefore, `${zoneState}: documents were not asked for a substitute figure`);
    assert.equal(reachedAccounts(refused), false);
    assert.equal(reachedTransactions(refused), false);
    assert.equal(f.modelCalls(), 0);
  }

  const available = productFixture(t);
  const answered = await available.ask("What did I spend this month, and on what?");
  assert.equal(answered.body.ledger?.kind, "expense_summary", "available-zone sibling has a normal answer");
  assert.ok(reachedTransactions(answered));

  const historical = productFixture(t);
  delete historical.env.BRAIN_TIMEZONE;
  const fixed = await historical.ask("What were my expenses in September 2026?");
  assert.equal(fixed.body.ledger?.kind, "expense_summary", "fixed historical month is the green control");
  assert.ok(reachedTransactions(fixed));
});

const EXPENSE_COVERAGE_ORACLE = Object.freeze([
  { id: "C09", coverage: "full", candidates: 2, covered: 2,
    rows: [["group-delta", 2000, 4], ["group-charlie", 3000, 3], ["group-bravo", 4000, 2], ["group-alpha", 5000, 1]],
    uncovered: [], transfer: 6000, total: 14000, cited: 4, omittedRows: 0,
    order: ["group-alpha", "group-bravo", "group-charlie", "group-delta"] },
  { id: "C10", coverage: "zero", candidates: 2, covered: 0, rows: [],
    uncovered: [["u1", 2000], ["u2", 3000]], transfer: 6000, total: null, cited: 0, omittedRows: 0, order: [] },
  { id: "C11", coverage: "partial", candidates: 3, covered: 1,
    rows: [["group-alpha", 1111, 1]], uncovered: [["u1", 2222], ["u2", 3333]],
    transfer: 0, total: 1111, cited: 1, omittedRows: 0, order: ["group-alpha"] },
  { id: "C12", coverage: "full", candidates: 2, covered: 2,
    rows: [["group-alpha", 1000, 1], ["group-beta", 1000, 2]], uncovered: [],
    transfer: 0, total: 2000, cited: 2, omittedRows: 0, order: ["group-alpha", "group-beta"] },
  { id: "C13", coverage: "partial", candidates: 2, covered: 1,
    rows: [["group-a", 1000, 6], ["group-b", 2000, 5], ["group-c", 3000, 4],
      ["group-d", 4000, 3], ["group-e", 5000, 2], ["group-f", 6000, 1]],
    uncovered: [["u1", 9999]], transfer: 0, total: 21000, cited: 5, omittedRows: 1,
    order: ["group-f", "group-e", "group-d", "group-c", "group-b", "group-a"] },
  { id: "C14", coverage: "full", candidates: 1, covered: 1,
    rows: [["group-c", 7000, 3], ["group-b", 8000, 2], ["group-a", 9000, 1]],
    uncovered: [], transfer: 24000, total: 24000, cited: 3, omittedRows: 0,
    order: ["group-a", "group-b", "group-c"], scoped: true },
  { id: "C15", coverage: "partial", candidates: 4, covered: 3,
    rows: [["group-e", 1200, 5], ["group-d", 2300, 4], ["group-c", 3400, 3],
      ["group-b", 4500, 2], ["group-a", 5600, 1]],
    uncovered: [["u1", 10000], ["u2", 11000]], transfer: 0, total: 17000, cited: 5, omittedRows: 0,
    order: ["group-a", "group-b", "group-c", "group-d", "group-e"] },
]);

for (const oracle of EXPENSE_COVERAGE_ORACLE) test(`EA-R2 coverage oracle ${oracle.id} ${oracle.coverage}`, async t => {
  const accountCount = oracle.scoped ? 2 : oracle.candidates;
  const accounts = Array.from({ length: accountCount }, (_, index) => ({
    slug: `oracle-${oracle.id.toLowerCase()}-${index + 1}`,
    mask: String(5101 + index), kind: index ? "savings" : "checking", role: "asset",
    coverageStatus: index < oracle.covered || oracle.scoped && index === 1 ? "complete" : "partial",
  }));
  const coveredAccounts = accounts.slice(0, Math.max(oracle.covered, 1));
  const omittedAccounts = accounts.slice(oracle.covered, oracle.candidates);
  const transactions = oracle.rows.map(([label, amount, rank], index) => ({
    id: `${oracle.id.toLowerCase()}-covered-${rank}`,
    account: coveredAccounts[index % coveredAccounts.length].slug,
    day: `2026-10-${String(10 + index).padStart(2, "0")}`,
    amount, direction: "outflow", description: label, payee: label,
  }));
  for (const [index, [label, amount]] of oracle.uncovered.entries()) transactions.push({
    id: `${oracle.id.toLowerCase()}-uncovered-${index + 1}`,
    account: omittedAccounts[index % omittedAccounts.length].slug,
    day: `2026-10-${String(20 + index).padStart(2, "0")}`,
    amount, direction: "outflow", description: label, payee: label,
  });
  if (oracle.transfer) {
    transactions.push({ id: `${oracle.id.toLowerCase()}-transfer-out`, account: accounts[0].slug,
      day: "2026-10-25", amount: oracle.transfer, direction: "outflow",
      description: `TRANSFER TO account ${accounts[1].mask}`, payee: null });
    transactions.push({ id: `${oracle.id.toLowerCase()}-transfer-in`, account: accounts[1].slug,
      day: "2026-10-25", amount: oracle.transfer, direction: "inflow",
      description: `TRANSFER FROM account ${accounts[0].mask}`, payee: null });
  }
  const f = productFixture(t, { accounts, transactions });
  const question = oracle.scoped
    ? `What are my expenses this month for account ending ${accounts[0].mask}?`
    : "What are my expenses this month?";
  const result = await f.ask(question);
  if (oracle.coverage === "zero") {
    assert.equal(result.body.ledger, undefined);
    assert.equal(result.body.answer, null);
    assert.equal(result.body.gaps?.[0]?.reason, "period_outside_coverage");
    assert.equal(f.fallbackCalls, 0, "oracle refusal stayed closed to document fallback");
    assert.ok(reachedAccounts(result), "oracle zero control reached account inventory");
    assert.equal(reachedTransactions(result), false);
  } else {
    assert.ok(reachedTransactions(result), "oracle figure decision reached transaction SQL");
    assert.equal(result.body.ledger?.total_minor, oracle.total);
    assert.equal(result.body.ledger.row_count, oracle.rows.length);
    assert.equal(result.body.ledger.coverage.covered_account_count, oracle.covered);
    assert.equal(result.body.ledger.coverage.omitted_account_count, oracle.candidates - oracle.covered);
    assert.equal(result.body.ledger.coverage.status, oracle.coverage);
    assert.equal(result.body.ledger.excluded_own_transfer_minor, oracle.transfer);
    assert.equal(result.body.ledger.cited_row_count, oracle.cited);
    assert.equal(result.body.ledger.omitted_row_count, oracle.omittedRows);
    assert.deepEqual(result.body.ledger.groups.map(group => group.merchant),
      oracle.order.map(label => label.replaceAll("-", " ")), "oracle ordering signature survives product label normalization");
    assert.equal(result.body.citations.length, oracle.cited);
    assert.equal(coverageLineCount(result.body.answer), 1);
  }
  assert.equal(f.modelCalls(), 0);
});
