// Provider precision finer than a currency's minor unit must never fail a whole
// Plaid Item. Field evidence: every sandbox Item that included the standard
// 401k account refused `balances.current` 23631.9805 USD, so no account at
// that institution could load. The integer is rounded half-even and the row is
// flagged so a rounded figure never reads as exact; the exact decimal stays on
// staged rows and ledger transactions. Every identifier, name and amount here
// is synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";
import { completePlaidLink, createPlaidLinkToken, plaidFeedStatus, syncPlaidItem } from "../src/lib/plaid-bank-feed.js";
import { assignPlaidAccountEntity, plaidOwnerAccountStatus } from "../src/lib/plaid-account-entities.js";
import { normalisePlaidAccount, normalisePlaidTransaction, PlaidProtocolError } from "../src/lib/plaid-protocol.js";
import { ledgerCashPosition, ledgerUnsortedSpending } from "../src/lib/fin-d1.js";

const NOW = "2026-09-20T13:00:00.000Z";
const ITEM = "item-precision-1";
const ENV = {
  BANK_FEED_PROVIDER: "plaid",
  BANK_FEED_ENV: "sandbox",
  BANK_FEED_CLIENT_ID: "fixture-client-id",
  BANK_FEED_SECRET: "fixture-secret",
  BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
  BRAIN_NAME: "Precision Fixture Brain",
};

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});

function account(id, { type = "depository", subtype = "checking", current = "100.00", available = null, currency = "USD" } = {}) {
  return {
    account_id: id, name: `Synthetic ${subtype || type} ${id}`, mask: "0000", type, subtype,
    balances: { current, available, iso_currency_code: currency },
  };
}

function transaction(id, accountId, amount, currency = "USD") {
  return {
    transaction_id: id, account_id: accountId, amount, iso_currency_code: currency,
    date: "2026-09-18", pending: false, name: "Synthetic precision fixture",
  };
}

async function precisionFixture({ accounts, added = [] }) {
  const fixture = await createProductFixture({ env: ENV });
  seedOwnedEntity(fixture, "fixture-household", "Fixture Household");
  const state = {
    accounts,
    page: {
      added, modified: [], removed: [], next_cursor: "precision-complete", has_more: false,
      transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
    },
  };
  // JSON.stringify writes a JS number exactly as a provider's JSON would carry
  // it, including exponent notation such as 1e-7.
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/link/token/create") return json({ link_token: "link-sandbox-precision", expiration: "2099-01-01T00:00:00.000Z" });
    if (path === "/item/public_token/exchange") return json({ item_id: ITEM, access_token: "access-sandbox-precision" });
    if (path === "/accounts/get") return json({ accounts: state.accounts });
    if (path === "/transactions/sync") return json(state.page);
    throw new Error(`unexpected Plaid path ${path}`);
  };
  const link = await createPlaidLinkToken(fixture.env, {
    url: "https://brain.invalid/app/connect/bank", sessionRef: "precision-link-session-0001", fetchImpl, now: NOW,
  });
  await completePlaidLink(fixture.env, {
    sessionRef: link.session_ref, publicToken: "public-sandbox-precision", fetchImpl, now: NOW,
  });
  const run = () => syncPlaidItem(fixture.env, ITEM, { fetchImpl, now: NOW });
  const assignAll = async () => {
    const refs = fixture.rows("SELECT account_ref FROM plaid_account_entity_assignments ORDER BY provider_account_id");
    for (const [index, row] of refs.entries()) {
      await assignPlaidAccountEntity(fixture.env, {
        request_id: `precision-assignment-${index}`, account_ref: row.account_ref, entity_slug: "fixture-household",
      }, { now: NOW });
    }
  };
  return { fixture, state, run, assignAll };
}

/** Stage, assign every account, then promote the staged window. */
async function syncToLedger(options) {
  const context = await precisionFixture(options);
  const staged = await context.run();
  assert.equal(staged.status, "assignment_required",
    `staging must reach the owner-choice guard, not fail: ${JSON.stringify({ status: staged.status, code: staged.code })}`);
  const stagedAccounts = context.fixture.rows(
    "SELECT provider_account_id,current_balance_decimal,available_balance_decimal,current_balance_minor,available_balance_minor,provenance_json FROM plaid_sync_stage_accounts",
  ).map((row) => ({ ...row, provenance: JSON.parse(row.provenance_json) }));
  const stagedTransactions = context.fixture.rows(
    "SELECT provider_transaction_id,amount_decimal,amount_minor,direction,provenance_json FROM plaid_sync_stage_transactions",
  ).map((row) => ({ ...row, provenance: JSON.parse(row.provenance_json) }));
  const stagedStatus = await plaidFeedStatus(context.fixture.env);
  await context.assignAll();
  const promoted = await context.run();
  assert.equal(promoted.promoted ?? promoted.resumed_promotion, true,
    `the staged window must promote: ${JSON.stringify({ status: promoted.status, code: promoted.code })}`);
  return { ...context, staged, stagedAccounts, stagedTransactions, stagedStatus, promoted };
}

const snapshotFor = (fixture, providerAccountId) => fixture.first(
  `SELECT b.current_minor,b.available_minor,b.currency,b.source_locator FROM fin_balance_snapshots b
     JOIN fin_accounts f ON f.tenant_id=b.tenant_id AND f.account_slug=b.account_slug
    WHERE f.external_ref=?`, providerAccountId);

const ledgerLine = (fixture, providerTransactionId) => fixture.first(
  `SELECT amount_minor,raw_amount_minor,direction,source_amount_decimal,source_locator,currency
     FROM fin_transactions WHERE external_id=?`, providerTransactionId);

test("amount text is plain positional decimal for any finite number, including exponent notation", () => {
  const cases = [
    [1e-7, "0.0000001"],
    [-2.5e-8, "-0.000000025"],
    [1.5e21, "1500000000000000000000"],
    [23631.9805, "23631.9805"],
    [-12.345, "-12.345"],
    ["2.5E+3", "2500"],
  ];
  for (const [value, expected] of cases) {
    assert.equal(normalisePlaidAccount(account("text-account", { current: value })).currentBalance, expected,
      `balance ${String(value)}`);
    assert.equal(normalisePlaidTransaction(transaction("text-transaction", "text-account", value)).amount, expected,
      `amount ${String(value)}`);
  }
  const tiny = normalisePlaidAccount(account("tiny-account", { current: 5e-324 })).currentBalance;
  assert.match(tiny, /^0\.0{323}5$/, "the smallest positive double still expands exactly");
});

test("genuinely invalid amounts are still refused as invalid input", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "not-money", "1.2.3", "", {}, "1e999999999"]) {
    assert.throws(() => normalisePlaidTransaction(transaction("invalid-transaction", "invalid-account", value)),
      (error) => error instanceof PlaidProtocolError && error.code === "INVALID_AMOUNT", `amount ${String(value)}`);
  }
});

test("a 4-decimal 401k balance no longer fails the Item and is stored rounded, flagged, with its exact decimal", async () => {
  const run = await syncToLedger({
    accounts: [
      account("checking-exact", { current: 110, available: 100 }),
      account("retirement-401k", { type: "investment", subtype: "401k", current: 23631.9805 }),
      account("tie-even", { current: "10.125", available: "10.135" }),
    ],
    added: [transaction("exact-line", "checking-exact", 4.33)],
  });
  const { fixture, stagedAccounts, stagedStatus } = run;
  try {
    // Visible to the owner and operator status before and after promotion.
    const retirementLabel = "Synthetic 401k retirement-401k ending 0000";
    assert.deepEqual(stagedStatus.connections[0].rounded_balances.find((row) => row.masked_identifier === retirementLabel),
      { masked_identifier: retirementLabel, account_kind: "retirement", fields: ["current"], stage: "staged" });
    const promotedStatus = await plaidFeedStatus(fixture.env);
    assert.deepEqual(promotedStatus.connections[0].rounded_balances.map(({ masked_identifier, fields, stage }) => ({ masked_identifier, fields, stage })), [
      { masked_identifier: retirementLabel, fields: ["current"], stage: "in_ledger" },
      { masked_identifier: "Synthetic checking tie-even ending 0000", fields: ["current", "available"], stage: "in_ledger" },
    ]);
    const ownerRows = (await plaidOwnerAccountStatus(fixture.env, { now: NOW })).accounts;
    const ownerRetirement = ownerRows.find((row) => row.masked_identifier === retirementLabel);
    assert.deepEqual(ownerRetirement.balance_minor_rounded, { staged: [], in_ledger: ["current"] });
    assert.deepEqual(ownerRows.find((row) => row.masked_identifier === "Synthetic checking checking-exact ending 0000")
      .balance_minor_rounded, { staged: [], in_ledger: [] });

    const retirement = stagedAccounts.find((row) => row.provider_account_id === "retirement-401k");
    assert.equal(retirement.current_balance_decimal, "23631.9805", "the exact provider decimal is kept");
    assert.equal(retirement.current_balance_minor, 2363198);
    assert.equal(retirement.provenance.current_balance_minor_rounded, true, "the staged row is flagged");
    const exact = stagedAccounts.find((row) => row.provider_account_id === "checking-exact");
    assert.equal(exact.provenance.current_balance_minor_rounded, undefined, "an exact figure carries no flag");

    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items").cursor, "precision-complete");
    assert.equal(fixture.first("SELECT status FROM bank_feed_items").status, "connected");
    assert.deepEqual({ ...snapshotFor(fixture, "retirement-401k") }, {
      current_minor: 2363198, available_minor: null, currency: "USD",
      source_locator: `plaid/balance/${fixture.first("SELECT source_window_ref AS w FROM fin_transactions").w}/retirement-401k#minor_rounded=current`,
    });
    // Half-even: 1012.5 cents rounds to the even 1012, 1013.5 to the even 1014.
    const ties = snapshotFor(fixture, "tie-even");
    assert.equal(ties.current_minor, 1012);
    assert.equal(ties.available_minor, 1014);
    assert.match(ties.source_locator, /#minor_rounded=current,available$/);
    const plain = snapshotFor(fixture, "checking-exact");
    assert.equal(plain.current_minor, 11000);
    assert.doesNotMatch(plain.source_locator, /minor_rounded/);

    const status = await plaidFeedStatus(fixture.env);
    assert.equal(status.connections[0].status, "connected");
    assert.equal(JSON.stringify(status).includes("plaid_amount_not_representable"), false);
  } finally { fixture.close(); }
});

test("the cash position a surface reads says which summed balances were rounded", async () => {
  const { fixture } = await syncToLedger({
    accounts: [
      account("cash-exact", { current: "200.00" }),
      account("cash-rounded", { subtype: "savings", current: "50.005" }),
    ],
  });
  try {
    const cash = await ledgerCashPosition(fixture.env);
    const bySlugRef = Object.fromEntries(cash.covered.map((row) => [
      fixture.first("SELECT external_ref FROM fin_accounts WHERE account_slug=?", row.account_slug).external_ref,
      row,
    ]));
    assert.equal(bySlugRef["cash-rounded"].amount_minor, 5000, "50.005 rounds half-even to 5000");
    assert.equal(bySlugRef["cash-rounded"].minor_rounded, true);
    assert.equal(bySlugRef["cash-exact"].minor_rounded, false);
    assert.equal(cash.rounded_accounts, 1, "the total names how many summed figures are rounded");
    assert.equal(cash.total_minor, 25000);
  } finally { fixture.close(); }
});

test("3-decimal, negative and exponent-notation transactions round half-even with their sign and flag", async () => {
  const { fixture, stagedTransactions } = await syncToLedger({
    accounts: [account("card-account", { type: "credit", subtype: "credit card", current: -12.3456 })],
    added: [
      transaction("three-decimal-even", "card-account", 12.345),
      transaction("three-decimal-odd", "card-account", 12.355),
      transaction("negative-even", "card-account", -4.225),
      transaction("negative-odd", "card-account", -4.235),
      transaction("sub-cent-outflow", "card-account", 1e-7),
      transaction("sub-cent-inflow", "card-account", -2.5e-8),
      transaction("exact-line", "card-account", "7.10"),
    ],
  });
  try {
    const expected = {
      "three-decimal-even": { amount_minor: 1234, raw_amount_minor: 1234, direction: "outflow", source_amount_decimal: "12.345" },
      "three-decimal-odd": { amount_minor: 1236, raw_amount_minor: 1236, direction: "outflow", source_amount_decimal: "12.355" },
      "negative-even": { amount_minor: 422, raw_amount_minor: -422, direction: "inflow", source_amount_decimal: "-4.225" },
      "negative-odd": { amount_minor: 424, raw_amount_minor: -424, direction: "inflow", source_amount_decimal: "-4.235" },
      // Rounded to zero, the direction still follows the provider's exact sign.
      "sub-cent-outflow": { amount_minor: 0, raw_amount_minor: 0, direction: "outflow", source_amount_decimal: "0.0000001" },
      "sub-cent-inflow": { amount_minor: 0, raw_amount_minor: 0, direction: "inflow", source_amount_decimal: "-0.000000025" },
    };
    for (const [id, figures] of Object.entries(expected)) {
      const line = ledgerLine(fixture, id);
      assert.deepEqual({
        amount_minor: line.amount_minor, raw_amount_minor: line.raw_amount_minor,
        direction: line.direction, source_amount_decimal: line.source_amount_decimal,
      }, figures, id);
      assert.match(line.source_locator, /#minor_rounded$/, `${id} carries the rounding flag`);
      assert.equal(stagedTransactions.find((row) => row.provider_transaction_id === id).provenance.amount_minor_rounded, true);
    }
    const exact = ledgerLine(fixture, "exact-line");
    assert.equal(exact.amount_minor, 710);
    assert.doesNotMatch(exact.source_locator, /minor_rounded/);
    assert.equal(stagedTransactions.find((row) => row.provider_transaction_id === "exact-line").provenance.amount_minor_rounded, undefined);

    // -12.3456 USD is -1234.56 cents, which rounds away from the half to -1235.
    assert.equal(snapshotFor(fixture, "card-account").current_minor, -1235);
    const spending = await ledgerUnsortedSpending(fixture.env);
    assert.equal(spending.by_account[0].rounded_lines, 3, "only counted outflow lines that were rounded are named");
  } finally { fixture.close(); }
});

test("a zero-exponent currency and a three-decimal currency round in their own minor units", async () => {
  const { fixture } = await syncToLedger({
    accounts: [
      account("yen-account", { current: 1234.5, available: 99.5, currency: "JPY" }),
      account("dinar-account", { current: "1.23456", available: "2.125", currency: "KWD" }),
    ],
    added: [
      transaction("yen-tie", "yen-account", 99.5, "JPY"),
      transaction("yen-exact", "yen-account", 1500, "JPY"),
      transaction("dinar-half-fils", "dinar-account", "0.0005", "KWD"),
      transaction("dinar-exact", "dinar-account", "2.125", "KWD"),
    ],
  });
  try {
    const yen = snapshotFor(fixture, "yen-account");
    assert.deepEqual([yen.current_minor, yen.available_minor, yen.currency], [1234, 100, "JPY"]);
    assert.match(yen.source_locator, /#minor_rounded=current,available$/);
    const dinar = snapshotFor(fixture, "dinar-account");
    assert.deepEqual([dinar.current_minor, dinar.available_minor, dinar.currency], [1235, 2125, "KWD"]);
    assert.match(dinar.source_locator, /#minor_rounded=current$/);

    assert.deepEqual([ledgerLine(fixture, "yen-tie").amount_minor, ledgerLine(fixture, "yen-tie").currency], [100, "JPY"]);
    assert.match(ledgerLine(fixture, "yen-tie").source_locator, /#minor_rounded$/);
    assert.equal(ledgerLine(fixture, "yen-exact").amount_minor, 1500);
    assert.doesNotMatch(ledgerLine(fixture, "yen-exact").source_locator, /minor_rounded/);
    // Half a fils rounds to the even 0; the line keeps its exact 0.0005 and its outflow sign.
    assert.deepEqual({ ...ledgerLine(fixture, "dinar-half-fils") }, {
      amount_minor: 0, raw_amount_minor: 0, direction: "outflow", source_amount_decimal: "0.0005",
      source_locator: "plaid/transactions/dinar-half-fils#minor_rounded", currency: "KWD",
    });
    assert.equal(ledgerLine(fixture, "dinar-exact").amount_minor, 2125);
  } finally { fixture.close(); }
});

test("unsupported currency and unsafe magnitude still stop the sync without moving the cursor", async () => {
  for (const balances of [
    { current: "10.00", iso_currency_code: "ZZZ" },
    { current: "90071992547409.925", iso_currency_code: "USD" },
  ]) {
    const { fixture, state, run } = await precisionFixture({ accounts: [account("refused-account")] });
    try {
      state.accounts[0].balances = balances;
      const result = await run();
      assert.equal(result.ok, false);
      assert.match(result.code, /^plaid_(?:currency_unsupported|amount_not_representable)$/);
      assert.equal(fixture.first("SELECT cursor FROM bank_feed_items").cursor, null);
      assert.equal(fixture.first("SELECT COUNT(*) AS n FROM plaid_sync_stage_accounts").n, 0);
    } finally { fixture.close(); }
  }
});
