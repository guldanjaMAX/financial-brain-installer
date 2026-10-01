import test from "node:test";
import assert from "node:assert/strict";
import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";
import {
  completePlaidLink,
  createPlaidLinkToken,
  plaidFeedStatus,
  syncPlaidItem,
} from "../src/lib/plaid-bank-feed.js";

// One account at a bank whose currency or balance this Brain cannot store
// exactly used to fail the WHOLE connection, so every other account at that
// bank stopped syncing too. That one account is now held with a named reason,
// its provider records are kept aside, and it never reaches any ledger total.

const ITEM = "item-sandbox-1";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function account(account_id, index, balances) {
  return {
    account_id, name: `Synthetic account ${index}`, mask: String(1000 + index),
    type: "depository", subtype: "checking", balances,
  };
}

function transaction(account_id, index, currency = { iso_currency_code: "USD" }) {
  return {
    transaction_id: `held-fixture-transaction-${index}`, account_id, amount: "12.00",
    date: "2026-08-30", pending: false, name: "Synthetic held-account fixture", ...currency,
  };
}

async function heldFixture({ accounts, added }) {
  const fixture = await createProductFixture({ env: {
    BANK_FEED_PROVIDER: "plaid", BANK_FEED_ENV: "sandbox",
    BANK_FEED_CLIENT_ID: "fixture-client-id", BANK_FEED_SECRET: "fixture-secret",
    BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`, BRAIN_NAME: "Sandbox Brain",
  } });
  seedOwnedEntity(fixture, "household", "Household");
  const now = "2026-08-30T13:00:00.000Z";
  const state = { accounts, page: {
    added, modified: [], removed: [], next_cursor: "held-complete", has_more: false,
    transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
  } };
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/link/token/create") {
      return jsonResponse({ link_token: "link-sandbox-short-lived", expiration: "2099-08-30T13:30:00.000Z" });
    }
    if (path === "/item/public_token/exchange") {
      return jsonResponse({ item_id: ITEM, access_token: "access-sandbox-secret" });
    }
    if (path === "/accounts/get") return jsonResponse({ accounts: state.accounts });
    if (path === "/transactions/sync") return jsonResponse(state.page);
    throw new Error(`unexpected Plaid path ${path} ${init?.method || ""}`);
  };
  const link = await createPlaidLinkToken(fixture.env, {
    url: "https://brain.invalid/app/connect/bank", sessionRef: "held-account-link-0001", fetchImpl, now,
  });
  await completePlaidLink(fixture.env, { sessionRef: link.session_ref, publicToken: "public-sandbox-once", fetchImpl, now });
  const run = () => syncPlaidItem(fixture.env, ITEM, { fetchImpl, now });
  const assignAll = async () => {
    const { assignPlaidAccountEntity } = await import("../src/lib/plaid-account-entities.js");
    for (const [index, row] of fixture.rows(
      "SELECT account_ref FROM plaid_account_entity_assignments ORDER BY provider_account_id",
    ).entries()) {
      await assignPlaidAccountEntity(fixture.env, {
        request_id: `held-assignment-${index}`, account_ref: row.account_ref, entity_slug: "household",
      }, { now });
    }
  };
  // Owner choice first, then the resumed promotion of the same staged window.
  const syncThroughAssignment = async () => {
    const first = await run();
    assert.equal(first.status, "assignment_required", JSON.stringify(first));
    await assignAll();
    const second = await run();
    assert.equal(second.resumed_promotion, true, JSON.stringify(second));
    assert.equal(second.finalCursor, "held-complete");
    return second;
  };
  return { fixture, state, run, syncThroughAssignment };
}

function assertBankKeptSyncing(fixture, { supported, held }) {
  const item = fixture.first("SELECT status,cursor FROM bank_feed_items WHERE item_ref=?", ITEM);
  assert.equal(item.status, "connected");
  assert.equal(item.cursor, "held-complete");
  assert.deepEqual(
    fixture.rows("SELECT external_ref FROM fin_accounts ORDER BY external_ref").map(row => row.external_ref),
    [...supported].sort(),
  );
  assert.equal(fixture.first(
    "SELECT COUNT(*) AS n FROM fin_accounts WHERE external_ref=?", held).n, 0);
  assert.equal(fixture.first(`SELECT COUNT(*) AS n FROM fin_transactions t
      JOIN fin_accounts f ON f.tenant_id=t.tenant_id AND f.account_slug=t.account_slug
     WHERE f.external_ref=?`, held).n, 0);
  // Held money never reaches a snapshot, so it cannot reach any total.
  assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_balance_snapshots").n, supported.length);
  // The held account is never offered for an owner choice it cannot use.
  assert.deepEqual(
    fixture.rows("SELECT provider_account_id FROM plaid_account_entity_assignments ORDER BY provider_account_id")
      .map(row => row.provider_account_id),
    [...supported].sort(),
  );
}

async function heldEntry(fixture) {
  const status = await plaidFeedStatus(fixture.env);
  const entry = status.needs_attention.find(row => row.item_ref === ITEM);
  assert.ok(entry, "a held account puts its connection in needs_attention");
  assert.equal(entry.status, "connected");
  assert.equal(entry.code, "plaid_account_held");
  assert.equal(entry.held_accounts.length, 1);
  const connection = status.connections.find(row => row.item_ref === ITEM);
  assert.deepEqual(connection.held_accounts, entry.held_accounts);
  return entry;
}

test("mixed-currency bank: USD accounts sync while the MXN account is held with its reason", async () => {
  const { fixture, state, run, syncThroughAssignment } = await heldFixture({
    accounts: [
      account("usd-checking", 0, { current: "100.00", iso_currency_code: "USD" }),
      account("usd-savings", 1, { current: "250.50", iso_currency_code: "USD" }),
      account("mxn-account", 2, { current: "5000.00", iso_currency_code: "MXN" }),
    ],
    added: [
      transaction("usd-checking", 0),
      transaction("usd-savings", 1),
      transaction("mxn-account", 2, { iso_currency_code: "MXN" }),
    ],
  });
  try {
    const receipt = await syncThroughAssignment();
    assert.equal(receipt.held_accounts, 1);
    assert.equal(receipt.ok, false, "a held account is never reported as a complete sync");
    assertBankKeptSyncing(fixture, { supported: ["usd-checking", "usd-savings"], held: "mxn-account" });
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 2);
    assert.equal(fixture.first("SELECT SUM(current_minor) AS total FROM fin_balance_snapshots").total, 35050);
    const entry = await heldEntry(fixture);
    assert.deepEqual(entry.held_accounts[0], {
      masked_identifier: "Synthetic account 2 ending 1002",
      account_kind: entry.held_accounts[0].account_kind,
      code: "plaid_currency_unsupported",
      source_currency: "MXN",
      held_transactions: 1,
      detail: entry.held_accounts[0].detail,
    });
    assert.match(entry.held_accounts[0].detail, /not in any total/);
    assert.equal(entry.held_transactions, 1);
    // Kept aside with the provider's exact decimal, not dropped.
    const kept = fixture.first(`SELECT amount_decimal,amount_minor,iso_currency_code FROM plaid_sync_stage_transactions
      WHERE provider_transaction_id='held-fixture-transaction-2'`);
    assert.deepEqual({ ...kept }, { amount_decimal: "12.00", amount_minor: null, iso_currency_code: "MXN" });

    // The next refresh keeps syncing the bank. A provider withdrawal of held
    // activity is recorded beside it rather than lost with the window.
    state.page = {
      added: [transaction("usd-checking", 3)], modified: [],
      removed: [{ transaction_id: "held-fixture-transaction-2" }],
      next_cursor: "held-complete-2", has_more: false,
      transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
    };
    const next = await run();
    assert.equal(next.held_accounts, 1, JSON.stringify(next));
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items").cursor, "held-complete-2");
    assert.equal(fixture.first("SELECT status FROM bank_feed_items").status, "connected");
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 3);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_accounts WHERE external_ref='mxn-account'").n, 0);
    assert.equal(fixture.first(`SELECT COUNT(*) AS n FROM plaid_sync_stage_transactions
      WHERE provider_transaction_id='held-fixture-transaction-2'`).n, 2);
    const after = await heldEntry(fixture);
    assert.equal(after.held_accounts[0].held_transactions, 0);
  } finally { fixture.close(); }
});

test("an account reported only with an unofficial currency is held, not failed", async () => {
  const { fixture, syncThroughAssignment } = await heldFixture({
    accounts: [
      account("usd-checking", 0, { current: "100.00", iso_currency_code: "USD" }),
      account("unofficial-wallet", 1, { current: "3.50", iso_currency_code: null, unofficial_currency_code: "XBT" }),
    ],
    added: [
      transaction("usd-checking", 0),
      transaction("unofficial-wallet", 1, { iso_currency_code: null, unofficial_currency_code: "XBT" }),
    ],
  });
  try {
    await syncThroughAssignment();
    assertBankKeptSyncing(fixture, { supported: ["usd-checking"], held: "unofficial-wallet" });
    assert.equal(fixture.first("SELECT SUM(current_minor) AS total FROM fin_balance_snapshots").total, 10000);
    const entry = await heldEntry(fixture);
    assert.equal(entry.held_accounts[0].code, "plaid_currency_unsupported");
    assert.equal(entry.held_accounts[0].source_currency, "XBT");
    assert.equal(entry.held_accounts[0].held_transactions, 1);
  } finally { fixture.close(); }
});

test("an account whose balance has an unsafe magnitude is held the same way", async () => {
  const { fixture, syncThroughAssignment } = await heldFixture({
    accounts: [
      account("usd-checking", 0, { current: "100.00", iso_currency_code: "USD" }),
      // 9007199254740993 minor units: past Number.MAX_SAFE_INTEGER.
      account("unsafe-balance", 1, { current: "90071992547409.93", iso_currency_code: "USD" }),
    ],
    added: [transaction("usd-checking", 0), transaction("unsafe-balance", 1)],
  });
  try {
    await syncThroughAssignment();
    assertBankKeptSyncing(fixture, { supported: ["usd-checking"], held: "unsafe-balance" });
    assert.equal(fixture.first("SELECT SUM(current_minor) AS total FROM fin_balance_snapshots").total, 10000);
    // Even its ordinary USD activity stays out of the ledger while it is held.
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 1);
    const entry = await heldEntry(fixture);
    assert.equal(entry.held_accounts[0].code, "plaid_amount_not_representable");
    assert.equal(entry.held_accounts[0].source_currency, "USD");
    assert.equal(entry.held_accounts[0].held_transactions, 1);
  } finally { fixture.close(); }
});
