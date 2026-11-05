// One provider-independent book of signed integer cents. Renderers never feed
// the oracle: expected membership is explicit in this synthetic book.
import assert from "node:assert/strict";
import { createProductFixture, seedOwnedEntity } from "../product-contract-fixture.mjs";
import * as simplefin from "../../src/lib/simplefin-bank-feed.js";
import { createPlaidLinkToken, completePlaidLink, syncPlaidItem } from "../../src/lib/plaid-bank-feed.js";
import { assignPlaidAccountEntity } from "../../src/lib/plaid-account-entities.js";
import { withLedgerAnswer } from "../../src/lib/ledger-answer.js";

export const NOW = "2026-11-04T12:00:00.000Z";
export const START = "2026-08-07";
export const END = "2026-11-04";
const epoch = day => Date.parse(`${day}T12:00:00Z`) / 1000;
const decimal = cents => `${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
const sum = rows => Number(rows.reduce((total, row) => total + BigInt(Math.abs(row.cents)), 0n));
const normalize = value => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function moneyBook() {
  const accounts = [
    { id: "operating", bank: "bank-a", institution: "Fixture North", label: "Business Checking", mask: "1111", kind: "checking", balance: 2300400, available: 2200400 },
    { id: "reserve", bank: "bank-b", institution: "Fixture South", label: "Reserve Savings", mask: "2222", kind: "savings", balance: 740000, available: 740000 },
    { id: "card", bank: "bank-b", institution: "Fixture South", label: "Business Credit Card", mask: "3333", kind: "card", balance: -186042, available: 813958 },
    { id: "loan", bank: "bank-a", institution: "Fixture North", label: "Equipment Loan", mask: "4444", kind: "loan", balance: -2500000, available: null },
  ];
  const transactions = [];
  const add = (id, account, day, cents, payee, category = "GENERAL_MERCHANDISE", extra = {}) => {
    transactions.push({ id, account, day, authorized: day, cents, payee,
      description: `PURCHASE ${payee}`, category, expense: cents < 0, ...extra });
  };
  for (let d = 0; d < 90; d++) {
    const day = new Date(Date.parse(`${START}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
    for (let n = 0; n < 8; n++) add(`debit-${d}-${n}`, "operating", day, -(1000 + d * 19 + n * 127),
      n === 0 ? ["Lumen Supply", "LUMEN SUPPLY", "Lumen-Supply"][d % 3] : `Fixture Vendor ${n}`);
    for (let n = 0; n < 4; n++) add(`credit-${d}-${n}`, "operating", day, 22000 + d * 31 + n * 223,
      `Fixture Customer ${n}`, "INCOME_OTHER_INCOME", { description: `Payment from Fixture Customer ${n}`, expense: false });
    for (let n = 0; n < 4; n++) add(`card-${d}-${n}`, "card", day, -(3000 + d * 23 + n * 137), `Fixture Card Shop ${n}`);
    if (d % 7 === 0) {
      const cents = 50000 + d;
      add(`transfer-out-${d}`, "operating", day, -cents, null, "TRANSFER_OUT", { description: "Transfer from Business Checking to Reserve Savings", expense: false, move: "transfer" });
      add(`transfer-in-${d}`, "reserve", day, cents, null, "TRANSFER_IN", { description: "Transfer from Business Checking to Reserve Savings", expense: false, move: "transfer" });
    }
  }
  for (const month of ["08", "09", "10"]) {
    add(`recurring-${month}`, "operating", `2026-${month}-15`, -4999, "Orbit Software", "GENERAL_SERVICES");
    add(`card-payment-out-${month}`, "operating", `2026-${month}-20`, -80000, null, "TRANSFER_OUT_ACCOUNT_TRANSFER", { description: "Payment to Business Credit Card", expense: false, move: "card-payment" });
    add(`card-payment-in-${month}`, "card", `2026-${month}-20`, 80000, null, "TRANSFER_IN_ACCOUNT_TRANSFER", { description: "Payment from Business Checking", expense: false, move: "card-payment" });
    add(`loan-payment-out-${month}`, "operating", `2026-${month}-22`, -35000, null, "LOAN_PAYMENTS", { description: "Payment to Equipment Loan", expense: false, move: "loan-payment" });
    add(`loan-payment-in-${month}`, "loan", `2026-${month}-22`, 35000, null, "TRANSFER_IN", { description: "Payment from Business Checking", expense: false, move: "loan-payment" });
    add(`refund-${month}`, "card", `2026-${month}-25`, 3210, "Fixture Card Shop 0", "GENERAL_MERCHANDISE", { description: "Refund Fixture Card Shop 0", expense: false, refund: true });
  }
  add("reversal-out", "operating", "2026-10-12", -7654, "Fixture Reversal", "GENERAL_MERCHANDISE");
  add("reversal-in", "operating", "2026-10-13", 7654, "Fixture Reversal", "GENERAL_MERCHANDISE", { description: "Reversal Fixture Reversal", expense: false, refund: true });
  add("arrival", "operating", "2026-10-16", 123456, "Fixture Payer", "INCOME_OTHER_INCOME", { description: "Payment from Fixture Payer", expense: false });
  add("post-a", "card", "2026-11-03", -8765, "Fixture Pending Shop", "GENERAL_MERCHANDISE", { authorized: "2026-11-02", pendingId: "pending-a" });
  add("post-b", "operating", "2026-11-04", -4321, "Fixture Pending Store", "GENERAL_MERCHANDISE", { authorized: "2026-11-03", pendingId: "pending-b" });
  return { accounts, transactions };
}

export function oracleFor(book) {
  const october = book.transactions.filter(row => row.day >= "2026-10-01" && row.day <= "2026-10-31");
  const expenses = october.filter(row => row.expense);
  const sorted = [...expenses].sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents));
  return {
    count: book.transactions.length,
    balances: Object.fromEntries(book.accounts.map(a => [a.label, a.balance])),
    expense: sum(expenses), largest: sorted.slice(0, 5).map(row => Math.abs(row.cents)),
    // Money in/out omit proved transfers and card payments, while loan
    // payments remain account cash movement. No income is inferred.
    moneyIn: sum(october.filter(row => row.cents > 0 && !["transfer", "card-payment"].includes(row.move))),
    moneyOut: sum(october.filter(row => row.cents < 0 && !["transfer", "card-payment"].includes(row.move))),
    grossIn: sum(october.filter(row => row.cents > 0)),
    grossOut: sum(october.filter(row => row.cents < 0)),
    outsideIn: sum(october.filter(row => row.cents > 0 && !row.move)),
    vendor: sum(october.filter(row => row.cents < 0 && normalize(row.payee || "") === "lumen supply")),
    transfers: sum(october.filter(row => row.cents > 0 && ["transfer", "card-payment", "loan-payment"].includes(row.move))),
    recurring: { merchant: "orbit software", typical: 4999, count: 3 },
    refunds: sum(october.filter(row => row.refund)),
    last: [...book.transactions].sort((a, b) => b.day.localeCompare(a.day)).slice(0, 10),
  };
}

function phaseRows(book, phase) {
  return book.transactions.map(row => phase === 0 && row.pendingId
    ? { ...row, id: row.pendingId, day: row.authorized, pending: true } : row);
}

export function plaidRendering(book, bank, phase) {
  const selected = book.accounts.filter(a => a.bank === bank);
  return {
    accounts: selected.map(a => ({ account_id: a.id, name: a.label, mask: a.mask, type: ["checking", "savings"].includes(a.kind) ? "depository" : a.kind === "card" ? "credit" : "loan",
      subtype: a.kind === "card" ? "credit card" : a.kind === "loan" ? "commercial" : a.kind,
      balances: { current: decimal(["card", "loan"].includes(a.kind) ? -a.balance : a.balance), available: a.available == null ? null : decimal(a.available), iso_currency_code: "USD" } })),
    transactions: phaseRows(book, phase).filter(row => selected.some(a => a.id === row.account)).map(row => ({
      transaction_id: row.id, account_id: row.account, amount: decimal(-row.cents), date: row.day,
      authorized_date: row.authorized, pending: Boolean(row.pending), pending_transaction_id: row.pending ? null : row.pendingId || null,
      name: row.description, merchant_name: row.payee, personal_finance_category: { primary: row.category, detailed: row.category }, iso_currency_code: "USD",
    })),
  };
}

export function simplefinRendering(book, phase, { from = -Infinity, to = Infinity, payees = true } = {}) {
  // The Worker requests protocol v2. Its connection inventory replaces v1 org.
  return { errlist: [], connections: [...new Set(book.accounts.map(a => a.bank))].map(bank => ({
    conn_id: bank, name: book.accounts.find(a => a.bank === bank).institution,
    org_id: bank, org_name: book.accounts.find(a => a.bank === bank).institution,
    org_url: `https://${bank}.example.invalid`, sfin_url: "https://bridge.example.invalid/simplefin",
  })), accounts: book.accounts.map(a => ({ id: a.id, name: a.label,
    conn_id: a.bank, currency: "USD", balance: decimal(a.balance),
    ...(a.available == null ? {} : { "available-balance": decimal(a.available) }), "balance-date": epoch(END),
    transactions: phaseRows(book, phase).filter(row => row.account === a.id && epoch(row.day) >= from && epoch(row.day) < to).map(row => ({
      id: row.id, posted: row.pending && row.id === "pending-a" ? 0 : epoch(row.day), amount: decimal(row.cents),
      description: row.description, ...(payees && row.payee ? { payee: row.payee, memo: row.description } : {}),
      transacted_at: epoch(row.authorized), pending: Boolean(row.pending),
    })),
  })) };
}

export async function buildParityLedgers({ sf = simplefin, book = moneyBook(), payees = true } = {}) {
  const fixtures = [];
  try {
    const make = async provider => {
      const fixture = await createProductFixture({ env: { BANK_FEED_PROVIDER: provider, BANK_FEED_ENV: "sandbox",
        BANK_FEED_CLIENT_ID: "fixture-client", BANK_FEED_SECRET: "fixture-secret", BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`, BRAIN_TIMEZONE: "UTC" } });
      fixtures.push(fixture);
      seedOwnedEntity(fixture, "store", "Store");
      return fixture;
    };
    const plaid = await make("plaid"), simple = await make("simplefin");
    const calls = { plaid: [], simplefin: [] };
    const plaidInitial = [];
    for (const bank of ["bank-a", "bank-b"]) {
      let phase = 0;
      const fetchImpl = async (url, init) => {
        const path = new URL(url).pathname;
        calls.plaid.push(path);
        const rendered = plaidRendering(book, bank, phase);
        if (path === "/link/token/create") return Response.json({ link_token: "fixture-link", expiration: "2099-01-01T00:00:00Z" });
        if (path === "/item/public_token/exchange") return Response.json({ item_id: bank, access_token: "fixture-access" });
        if (path === "/accounts/get") return Response.json({ accounts: rendered.accounts });
        if (path === "/transactions/sync") {
          const cursor = JSON.parse(init.body).cursor;
          return Response.json({ added: rendered.transactions, modified: [], removed: [], has_more: false,
            next_cursor: `${bank}-${phase}-${cursor ? "refresh" : "initial"}`, transactions_update_status: "HISTORICAL_UPDATE_COMPLETE" });
        }
        if (path === "/item/get") return Response.json({ item: { item_id: bank, error: null } });
        throw new Error("unhandled synthetic Plaid route");
      };
      const link = await createPlaidLinkToken(plaid.env, { url: "https://brain.invalid/app/connect/bank", sessionRef: `parity-session-${bank}`, fetchImpl, now: NOW });
      await completePlaidLink(plaid.env, { sessionRef: link.session_ref, publicToken: "fixture-public", institutionRef: bank,
        institutionLabel: book.accounts.find(a => a.bank === bank).institution, accounts: renderedAccounts(book, bank), fetchImpl, now: NOW });
      const staged = await syncPlaidItem(plaid.env, bank, { fetchImpl, now: NOW });
      assert.equal(staged.status, "assignment_required", "real Plaid assignment hold reached");
      assert.equal(plaid.first("SELECT count(*) AS n FROM fin_transactions WHERE source_feed=?", `bank-feed:${bank}`).n, 0,
        "unassigned Plaid item has no promoted activity");
      for (const row of plaid.rows("SELECT account_ref FROM plaid_account_entity_assignments WHERE item_ref=?", bank)) {
        await assignPlaidAccountEntity(plaid.env, { request_id: `parity-${row.account_ref}`, account_ref: row.account_ref, entity_slug: "store" }, { now: NOW });
      }
      await syncPlaidItem(plaid.env, bank, { fetchImpl, now: NOW });
      plaidInitial.splice(0, plaidInitial.length, ...plaid.rows("SELECT * FROM fin_transactions WHERE removed_at IS NULL"));
      phase = 1;
      await syncPlaidItem(plaid.env, bank, { fetchImpl, now: NOW });
    }
    let phase = 0;
    const fetchImpl = async request => {
      calls.simplefin.push(request.method);
      assert.equal(new URL(request.url).username, "", "native request strips fixture URL credentials");
      if (request.method === "POST") {
        const access = new URL("https://bridge.example.invalid/simplefin/parity");
        access.username = "fixture-user"; access.password = "fixture-pass";
        return new Response(access.href);
      }
      const url = new URL(request.url);
      return Response.json(simplefinRendering(book, phase, { from: Number(url.searchParams.get("start-date")), to: Number(url.searchParams.get("end-date")), payees }));
    };
    await sf.claimSimpleFinAccess(simple.env, { requestId: "parity-claim-request-0001",
      setupToken: btoa("https://bridge.example.invalid/claim/parity"), fetchImpl, now: NOW });
    const pull = async now => {
      const result = await sf.runSimpleFinMaintenance(simple.env, { fetchImpl, now });
      assert.equal(result.ran, 1, "real SimpleFIN maintenance decision reached");
      assert.equal(result.items[0].ok, true, "synthetic provider pull promoted without error");
    };
    await pull(NOW);
    assert.equal(simple.first("SELECT count(*) AS n FROM fin_transactions").n, 0, "unassigned staged inventory is held");
    assert.equal(simple.first("SELECT count(*) AS n FROM simplefin_stage_accounts").n, 4, "nonempty hold reached staging");
    for (const row of simple.rows("SELECT account_ref FROM simplefin_account_assignments")) {
      await sf.assignSimpleFinAccountEntity(simple.env, { request_id: `parity-${row.account_ref}`, account_ref: row.account_ref, entity_slug: "store" }, { now: NOW });
    }
    // Make the next bounded scheduler slice due without advancing the clock.
    // Ten historical requests plus current refreshes remain under 24/day.
    for (let slice = 0; slice < 3; slice++) {
      simple.raw("UPDATE simplefin_connections SET next_pull_at=?", NOW);
      await pull(NOW);
    }
    const simpleInitial = simple.rows("SELECT * FROM fin_transactions WHERE removed_at IS NULL");
    phase = 1;
    simple.raw("UPDATE simplefin_connections SET next_pull_at=?", NOW);
    await pull(NOW);
    // The current three-day slice must repeat without doubling posted rows.
    simple.raw("UPDATE simplefin_connections SET next_pull_at=?", NOW);
    await pull(NOW);
    const ask = async (fixture, question) => {
      const before = fixture.seen.sql.length;
      let fallbacks = 0;
      const body = await (await withLedgerAnswer({ env: fixture.env, question, now: NOW,
        grantScope: { all: true }, scopePrincipalKind: "owner" }, async gap => {
        fallbacks++;
        return Response.json({ answer: null, citations: [], gaps: gap ? [gap] : [] });
      })).json();
      return { body, fallbacks, reads: fixture.seen.sql.slice(before) };
    };
    return { book, oracle: oracleFor(book), plaid, simple, calls, plaidInitial, simpleInitial, ask,
      close() { fixtures.forEach(f => f.close()); } };
  } catch (error) { fixtures.forEach(f => f.close()); throw error; }
}

function renderedAccounts(book, bank) {
  return book.accounts.filter(a => a.bank === bank).map(a => ({ id: a.id, name: a.label, mask: a.mask }));
}

export function assertLedgerMatchesBook(f, book, provider) {
  assert.equal(f.first("SELECT count(*) AS n FROM fin_transactions WHERE removed_at IS NULL").n, book.transactions.length,
    "pending-to-posted replay must retain exactly one completed event");
  for (const account of book.accounts) {
    const saved = f.first("SELECT * FROM fin_accounts WHERE label=?", account.label);
    assert.equal(saved.institution, account.institution, `${account.id}: institution`);
    assert.equal(saved.mask, provider === "plaid" ? account.mask : null, `${account.id}: provider mask boundary`);
    assert.equal(saved.account_kind, account.kind, `${account.id}: kind`);
    const balance = f.first("SELECT * FROM fin_balance_snapshots WHERE account_slug=? ORDER BY as_of_date DESC LIMIT 1", saved.account_slug);
    const expectedBalance = ["card", "loan"].includes(account.kind) ? -account.balance : account.balance;
    assert.equal(balance.current_minor, expectedBalance, `${account.id}: normalized amount held or owed`);
    assert.equal(balance.available_minor, account.available, `${account.id}: available balance`);
    const rows = f.rows("SELECT * FROM fin_transactions WHERE account_slug=? AND removed_at IS NULL", saved.account_slug);
    const expected = book.transactions.filter(t => t.account === account.id);
    assert.equal(rows.length, expected.length, `${account.id}: no invented or missing event`);
    for (const truth of expected) {
      const row = rows.find(t => t.external_id === truth.id);
      assert.ok(row, `${truth.id}: real promoted row`);
      assert.equal(row.posted_on, truth.day, `${truth.id}: posting day`);
      assert.equal(row.amount_minor, Math.abs(truth.cents), `${truth.id}: cents`);
      assert.equal(row.direction, truth.cents < 0 ? "outflow" : "inflow", `${truth.id}: sign`);
      assert.equal(row.raw_amount_minor, provider === "plaid" ? -truth.cents : truth.cents, `${truth.id}: provider sign retained`);
      assert.equal(row.payee, truth.payee, `${truth.id}: structured vendor`);
      assert.equal(row.description, provider === "plaid" ? truth.payee || truth.description : truth.description,
        `${truth.id}: provider's existing description precedence`);
      assert.equal(row.pending, 0);
      if (provider === "plaid") assert.equal(row.category, truth.category);
      else assert.equal(row.category, null, "a missing category is never invented from a merchant");
    }
  }
}

export function ledgerDiff(run) {
  const read = f => f.rows(`SELECT a.label,t.external_id,t.posted_on,t.amount_minor,t.direction,t.pending,t.payee,t.description,t.category,t.raw_amount_minor
    FROM fin_transactions t JOIN fin_accounts a ON a.account_slug=t.account_slug AND a.tenant_id=t.tenant_id
    WHERE t.removed_at IS NULL ORDER BY a.label,t.external_id`);
  const plaid = read(run.plaid), simple = read(run.simple);
  const fields = ["posted_on", "amount_minor", "direction", "pending", "payee", "description", "category", "raw_amount_minor"];
  const differences = Object.fromEntries(fields.map(field => [field, 0]));
  const byKey = new Map(simple.map(row => [`${row.label}/${row.external_id}`, row]));
  let missing = 0;
  for (const row of plaid) {
    const other = byKey.get(`${row.label}/${row.external_id}`);
    if (!other) { missing++; continue; }
    for (const field of fields) if (row[field] !== other[field]) differences[field]++;
  }
  return { plaid_rows: plaid.length, simplefin_rows: simple.length, missing, differences };
}

export const questionGroups = [
  ["balances", ["What is in each account?", "Show my account balances", "How much is in my accounts?", "What are my current balances?"]],
  ["last", ["Show my last 10 transactions", "What were my last 10 transactions?", "List my last 10 transactions", "Show the last 10 transactions"]],
  ["money-in", ["How much money came in last month?", "What was my money in last month?", "How much came into my accounts last month?", "Show money in last month"]],
  ["money-out", ["How much money went out last month?", "What was my money out last month?", "How much did I spend last month?", "Show money out last month"]],
  ["largest", ["What were my 5 biggest expenses last month?", "Show my 5 largest expenses last month", "List my 5 biggest expenses last month", "What are the top 5 expenses last month?"]],
  ["payment", ["Did a payment of $1234.56 arrive around October 16, 2026?", "Did I receive $1234.56 around October 16, 2026?", "Was $1234.56 deposited around October 16, 2026?", "Did the $1234.56 payment come in around October 16, 2026?"]],
  ["vendor", ["How much did I spend at Lumen Supply last month?"]],
  ["recurring", ["What recurring charges do I have?", "Show my recurring charges"]],
  ["transfers", ["How much did I transfer between my own accounts last month?"]],
  ["card", ["What is my credit card balance?", "What is my card balance?"]],
  ["refunds", ["How much did I receive in refunds last month?"]],
];

// The scoring key is written against the book, not either provider's result.
// Missing supported structure is a refusal, never silently counted as RIGHT.
export function scoreAnswer(group, body, book, oracle) {
  const l = body.ledger;
  // No independently attributed refund answer exists yet. Require the actual
  // no-answer gap contract; unknown prose and structured totals fail closed.
  // This runs before the generic unstructured-answer path for every phrasing.
  if (group === "refunds") return {
    decision: "refunds",
    score: !l && !body.answer ? "honest-refusal" : "WRONG",
    detail: "refund attribution is unproved; only a no-answer result is a refusal",
  };
  if (!l) return { score: body.answer ? "PARTLY" : "honest-refusal", detail: body.gaps?.[0]?.reason || "unsupported offline wording" };
  const check = (condition, detail) => { if (!condition) throw new Error(detail); };
  const cents = amount => `$${Math.floor(amount / 100).toLocaleString("en-US")}.${String(amount % 100).padStart(2, "0")}`;
  try {
    check(typeof body.answer === "string" && body.answer.length > 0, "missing answer text");
    if (group === "balances" || group === "card") {
      check(l.kind === "balance", "wrong answer kind");
      const expected = (group === "card" ? book.accounts.filter(a => a.kind === "card") : book.accounts)
        .map(a => ["card", "loan"].includes(a.kind) ? -a.balance : a.balance).sort((a, b) => a - b);
      check(JSON.stringify(l.accounts.map(a => a.current_minor).sort((a, b) => a - b)) === JSON.stringify(expected), "wrong balance or account membership");
      check(expected.every(a => body.answer.includes(cents(Math.abs(a)))), "prose omits an account figure");
    } else if (group === "last") {
      check(l.kind === "transactions" && l.rows.length === 10, "wrong transaction limit");
      const cutoff = oracle.last.at(-1).day;
      const seen = new Set();
      for (const row of l.rows) {
        const key = `${row.posted_on}:${row.amount_minor}:${row.direction}:${row.payee}`;
        check(!seen.has(key), "duplicate recent event"); seen.add(key);
        check(row.posted_on >= cutoff && book.transactions.some(t => t.day === row.posted_on && Math.abs(t.cents) === row.amount_minor &&
          (t.cents < 0 ? "outflow" : "inflow") === row.direction && (t.payee || t.description) === row.payee), "wrong recent event or sign");
      }
    } else if (group === "money-in" || group === "money-out") {
      check(l.from === "2026-10-01" && l.to === "2026-10-31", "wrong calendar month");
      if (l.kind === "expense_summary") {
        check(l.expense_total_minor === oracle.expense, "wrong ordinary expense total");
        check(body.answer.includes(cents(oracle.expense)), "prose omits the expense figure");
      }
      else {
        check(l.kind === "totals", "wrong movement answer kind");
        const total = (rows, key) => Number(rows.reduce((n, row) => n + BigInt(row[key]), 0n));
        check(total(l.accounts, "credits_minor") === oracle.grossIn && total(l.accounts, "debits_minor") === oracle.grossOut, "wrong gross account movement");
        check(total(l.lead_accounts, "credits_minor") === oracle.moneyIn && total(l.lead_accounts, "debits_minor") === oracle.moneyOut, "wrong movement exclusions");
        if (l.outside_inflow_minor != null) check(l.outside_inflow_minor === oracle.outsideIn, "wrong outside inflow");
      }
    } else if (group === "largest") {
      check(l.kind === "largest", "wrong ranking kind");
      check(JSON.stringify(l.lead_rows.map(r => r.amount_minor)) === JSON.stringify(oracle.largest), "wrong ordinary expense ranking");
    } else if (group === "payment") {
      check(l.kind === "payment" && l.found === true && l.amount_minor === 123456 && l.match_count === 1, "wrong payment arrival");
      check(body.citations.some(c => c.posted_on === "2026-10-16" && c.amount_minor === 123456), "payment lacks the independent dated evidence");
    } else if (group === "vendor") {
      check(l.kind === "merchant" && l.total_minor === oracle.vendor, "wrong vendor total");
      check(body.answer.includes(cents(oracle.vendor)), "prose omits the vendor figure");
    } else if (group === "transfers") {
      check(l.kind === "transfers" && l.total_minor === oracle.transfers, "wrong own-transfer total");
      check(body.answer.includes(cents(oracle.transfers)), "prose omits the transfer figure");
    }
    else if (group === "recurring") {
      check(l.kind === "recurring", "wrong recurring kind");
      const series = l.recurring.find(r => r.merchant === oracle.recurring.merchant);
      check(series && series.typical_minor === oracle.recurring.typical && series.occurrence_count === oracle.recurring.count && series.cadence === "monthly", "wrong recurring series");
    } else return { score: "WRONG", detail: "unsupported answer group" };
    return { score: l.complete === false ? "PARTLY" : "RIGHT", detail: l.complete === false ? "bounded incomplete evidence" : "independent cents and membership match" };
  } catch (error) { return { score: "WRONG", detail: error.message }; }
}
