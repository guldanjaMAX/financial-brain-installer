import assert from "node:assert/strict";
import { createProductFixture, seedOwnedEntity } from "../../product-contract-fixture.mjs";
import { withLedgerAnswer } from "../../../src/lib/ledger-answer.js";
import { seedKnownPayers } from '../../ledger-known-payers-fixture.mjs';

export const NOW = "2026-10-11T12:00:00Z";
const stamp = "2026-10-11T10:00:00Z";
export const Q = {
  totals: "How much money came in and went out in September 2026?",
  october: "How much money came in and went out in October 2026?",
  checking: "How much money came in and went out of my checking account in September 2026?",
  balance: "What is my current balance?",
  payment: "Did the payment of $731.29 arrive on 2026-09-03?",
  largest: "What were my ten largest expenses in September 2026?",
  deposits: "What were my deposits in September 2026?",
  merchant: "How much did I spend by merchant in September 2026?",
  category: "How much did I spend by category in September 2026?",
  recurring: "Show my recurring charges in September 2026?",
  transfers: "How much did I transfer between my own accounts in September 2026?",
  income: "How much income came from Fixture brokerage in September 2026?",
  profit: "What was my profit in September 2026?",
};
export const flipQuestion = (question, phrase) => question.replace(/\?$/, ` ${phrase}?`);
export const accepted = [
  [Q.profit, "totals", "profit", "2026-09-01", "2026-09-30", null],
  ["What is my net income last month?", "totals", "net_income", "2026-09-01", "2026-09-30", null],
  ["What was our cash flow in Q3?", "totals", "cash_flow", "2026-07-01", "2026-09-30", null],
  ["How much profit did I make so far this year?", "totals", "profit", "2026-01-01", "2026-10-11", null],
  ["What was my profit in September 2026 for account ending 1111?", "totals", "profit", "2026-09-01", "2026-09-30", "1111"],
  [flipQuestion(Q.totals, "excluding transfers"), "totals", undefined, "2026-09-01", "2026-09-30", null, "exclude"],
  [Q.totals.replace("?", ", including transfers?"), "totals", undefined, "2026-09-01", "2026-09-30", null, "include"],
  [flipQuestion(Q.totals, "including withdrawals"), "totals", undefined, "2026-09-01", "2026-09-30", null, undefined, "include"],
  ["How much did I spend at Fixture Store in September 2026 excluding transfers?", "merchant", undefined, "2026-09-01", "2026-09-30", null, "exclude"],
];
export const refused = [
  "What was my profit before tax in September 2026?",
  "What was my projected profit in September 2026?",
  "What was my average cash flow in Q3?",
  "What was my net income in 2025?",
  "What was my profit in September and October 2026?",
  "What was my gross profit in September 2026?",
  "What was my business profit in September 2026?",
  "What is my QuickBooks profit for September 2026?",
  flipQuestion(Q.totals, "excluding refunds"),
  flipQuestion(Q.totals, "excluding transfers and refunds"),
  "What is my balance excluding transfers?",
  "Did the payment of $120.01 arrive on 2026-09-15 excluding transfers?",
  "How much did I spend on software/SaaS in Q3 excluding refunds?",
  flipQuestion(Q.totals, "including transfers excluding transfers"),
  flipQuestion(Q.totals, "excluding transfers without transfers"),
  flipQuestion(Q.totals, "including withdrawals including retirement withdrawals"),
  flipQuestion(Q.transfers, "excluding transfers"),
  flipQuestion(Q.payment, "including withdrawals"),
  "What was my profit?",
  "What was my net income in September 2026 after fees?",
];

// All values are invented. A pair's evidence comes from literal account
// references, never a merchant label or a real institution name.
export async function fixture(t, scenario = "own") {
  const f = await createProductFixture({ env: { AI: { async run() {
    f.modelCalls++; throw new Error("fixture model must not draft money");
  } } } });
  if (t) t.after(() => f.close());
  f.modelCalls = 0;
  seedOwnedEntity(f, "owner", "Fixture Owner");
  // Independent owner-confirmed identities precede every receipt. The bank
  // descriptions below do not create payer authority for named-income tests.
  seedKnownPayers(f, ['Fixture client', 'Fixture brokerage'], NOW);
  f.raw("UPDATE fin_entities SET display_label='account 1111' WHERE entity_slug='owner'");
  f.account = (slug, mask, kind = "checking", mode = "live") => {
    const role = ["card", "loan", "line_of_credit"].includes(kind) ? "liability" : "asset";
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at,institution)
      VALUES (?,'owner',?,?,?,?,'owner_stated','confirmed',?,'Fixture Institution')`, slug, kind, role, mask, mode, stamp);
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES (?,'complete','2026-01-01','2026-10-11',?,'owner_stated','confirmed',?)`, slug, stamp, stamp);
    f.raw(`INSERT INTO fin_balance_snapshots (account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at)
      VALUES (?,'2026-10-11',83719,'owner_stated','confirmed',?)`, slug, stamp);
  };
  f.add = (id, date, amount, direction = "outflow", description = "Fixture Store", category = null, basis = null, account = "account-a") => {
    f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,category,category_basis_state,provenance,basis_state,recorded_at)
      VALUES (?,?,?,?,?,?,?,?,'owner_stated','confirmed',?)`, id, account, date, amount, direction, description, category, basis, stamp);
  };
  f.changes = () => f.sqlite.prepare("SELECT total_changes() n").get().n;
  f.ask = async (question, route = false) => {
    const changes = f.changes();
    const response = route ? await f.post("/api/rag/think", { q: question }, { "X-Admin-Key": f.env.ADMIN_KEY }) :
      await withLedgerAnswer({ env: f.env, question, now: NOW, grantScope: { all: true }, scopePrincipalKind: "owner" },
        async () => new Response(JSON.stringify({ answer: null, gaps: [] })));
    const body = await response.json();
    assert.equal(f.changes(), changes, "every question is read-only, including fall-throughs");
    return body;
  };
  seed(f, scenario);
  return f;
}
function base(f) {
  f.account("account-a", "1111");
  f.add("deposit", "2026-09-03", 73129, "inflow", "Fixture client deposit");
  f.add("expense-a", "2026-09-05", 2807, "outflow", "Fixture Store", "SOFTWARE", "confirmed");
  f.add("expense-b", "2026-09-07", 1903, "outflow", "Fixture Supplies");
}
function own(f) {
  f.account("account-b", "2222", "savings");
  f.add("move-out", "2026-09-15", 23617, "outflow", "TRANSFER TO account 2222", "TRANSFER_OUT_ACCOUNT_TRANSFER", "proposed");
  f.add("move-in", "2026-09-16", 23617, "inflow", "TRANSFER FROM account 1111", null, null, "account-b");
}
function card(f) {
  f.account("account-c", "3333", "card");
  f.add("card-out", "2026-09-19", 15439, "outflow", "PAYMENT TO CARD ENDING 3333");
  f.add("card-in", "2026-09-20", 15439, "inflow", "PAYMENT THANK YOU", null, null, "account-c");
  f.add("purchase", "2026-09-12", 9341, "outflow", "Fixture purchase", null, null, "account-c");
}
function loan(f, kind = "loan") {
  f.account("account-d", "4444", kind);
  f.add("loan-out", "2026-09-23", 18263, "outflow", "TRANSFER TO account 4444");
  f.add("loan-in", "2026-09-23", 18263, "inflow", "TRANSFER FROM account 1111", null, null, "account-d");
}
function withdrawal(f, kind = "investment", contribution = false) {
  f.account("account-e", "5555", kind);
  f.add("withdraw-out", "2026-09-26", 32641, "outflow", `TRANSFER TO account ${contribution ? "5555" : "1111"}`, null, null, contribution ? "account-a" : "account-e");
  f.add("withdraw-in", "2026-09-27", 32641, "inflow", `TRANSFER FROM account ${contribution ? "1111" : "5555"}`, null, null, contribution ? "account-e" : "account-a");
}
function seed(f, scenario) {
  if (scenario === "no-move-kind") {
    f.account("account-d", "4444", "loan");
    f.add("receipt", "2026-09-15", 18263, "inflow", "Fixture receipt", null, null, "account-d");
    return;
  }
  base(f);
  if (["own", "combined", "recurring-pairs"].includes(scenario)) own(f);
  if (["card", "combined"].includes(scenario)) card(f);
  if (["loan", "combined", "loan-as-savings", "credit-line", "kept-other"].includes(scenario))
    loan(f, scenario === "loan-as-savings" ? "savings" : scenario === "credit-line" ? "line_of_credit" : scenario === "kept-other" ? "other" : "loan");
  if (["investment", "retirement", "contribution", "combined"].includes(scenario))
    withdrawal(f, scenario === "retirement" ? "retirement" : "investment", scenario === "contribution");
  if (["category-withdrawal", "confirmed-withdrawal", "dividend", "description-ira", "description-401k"].includes(scenario)) {
    const category = scenario === "dividend" ? "INCOME_DIVIDENDS" : scenario.startsWith("description") ? null : "transfer_in_investment_and_retirement_funds";
    const description = scenario === "description-ira" ? "Fixture IRA distribution" : scenario === "description-401k" ? "Fixture 401k" : "Fixture brokerage";
    f.add("income", "2026-09-18", 41383, "inflow", description, category, category ? scenario === "confirmed-withdrawal" ? "confirmed" : "proposed" : null);
  }
  if (["unrelated", "related"].includes(scenario)) {
    f.account("account-b", "2222", "savings");
    // Outside parties are in descriptions. Two explicit outside payees would
    // veto pairing even after the one-description control change.
    f.add("same-out", "2026-09-15", 23617, "outflow", scenario === "related" ? "TRANSFER TO account 2222" : "Fixture outside supplier");
    f.add("same-in", "2026-09-17", 23617, "inflow", "Fixture outside customer", null, null, "account-b");
  }
  if (["boundary", "boundary-far", "boundary-uncovered"].includes(scenario)) {
    f.account("account-b", "2222", "savings");
    f.add("boundary-out", "2026-09-30", 27653, "outflow", "TRANSFER TO account 2222");
    f.add("boundary-in", scenario === "boundary-far" ? "2026-10-04" : "2026-10-02", 27653, "inflow", "TRANSFER FROM account 1111", null, null, "account-b");
    if (scenario === "boundary-uncovered") f.raw("UPDATE fin_account_coverage SET covered_to='2026-09-30' WHERE account_slug='account-b'");
  }
  if (scenario === "card-unconnected") f.add("card-out", "2026-09-19", 15439, "outflow", "PAYMENT TO CARD ENDING 9999", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", "proposed");
  if (["plain", "recurring-pairs"].includes(scenario)) for (const [i, day] of ["2026-07-15", "2026-08-15", "2026-09-15"].entries())
    f.add(`subscription-${i}`, day, 2713, "outflow", "Fixture subscription", "SOFTWARE", "confirmed");
  if (scenario === "recurring-pairs") for (const [i, day] of ["2026-07-15", "2026-08-15"].entries()) {
    f.add(`repeat-out-${i}`, day, 23617, "outflow", "TRANSFER TO account 2222");
    f.add(`repeat-in-${i}`, day, 23617, "inflow", "TRANSFER FROM account 1111", null, null, "account-b");
  }
}
export const scenarios = {
  own: [...Object.values(Q), ...accepted.map(r => r[0]), ...refused,
    flipQuestion(Q.totals, "including transfers"), flipQuestion(Q.totals, "without my own transfers between my own accounts"),
    flipQuestion(Q.totals, "not counting our transfers"), flipQuestion(Q.totals, "including investment withdrawals")],
  plain: [Q.balance, Q.payment, Q.totals, Q.largest, Q.deposits, Q.merchant, Q.category, Q.recurring, Q.transfers],
  unrelated: [Q.totals], related: [Q.totals],
  boundary: [Q.totals, Q.october], "boundary-far": [Q.totals], "boundary-uncovered": [Q.totals],
  card: [Q.totals, Q.checking, flipQuestion(Q.checking, "excluding transfers")],
  "card-unconnected": [Q.totals],
  loan: [Q.totals, flipQuestion(Q.totals, "excluding transfers")], "loan-as-savings": [Q.totals],
  "credit-line": [Q.totals], "kept-other": [Q.totals],
  "category-withdrawal": [Q.totals, Q.income, flipQuestion(Q.totals, "including withdrawals")],
  "confirmed-withdrawal": [Q.totals], dividend: [Q.totals], "description-ira": [Q.totals], "description-401k": [Q.totals],
  investment: [Q.totals], retirement: [Q.totals], contribution: [Q.totals, flipQuestion(Q.totals, "excluding transfers")],
  combined: [Q.profit, Q.totals, flipQuestion(Q.totals, "including transfers including withdrawals")],
  "no-move-kind": [Q.profit, Q.totals], "recurring-pairs": ["Show my recurring charges?"],
};
