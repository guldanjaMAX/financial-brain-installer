import test from "node:test";
import assert from "node:assert/strict";

import { accountKindFor } from "../src/lib/bank-feed.js";
import { ledgerCashPosition } from "../src/lib/fin-d1.js";
import { readOwnerFinancialMapState } from "../src/lib/owner-financial-map.js";
import {
  completePlaidLink,
  createPlaidLinkToken,
  syncPlaidItem,
} from "../src/lib/plaid-bank-feed.js";
import { assignPlaidAccountEntity } from "../src/lib/plaid-account-entities.js";
import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";

const NOW = "2026-09-24T12:00:00.000Z";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ACCOUNTS = Object.freeze([
  Object.freeze({
    account_id: "fixture-checking", name: "Fixture checking", mask: "1001",
    type: "depository", subtype: "checking",
    balances: { current: "100.00", available: "90.00", iso_currency_code: "USD" },
  }),
  Object.freeze({
    account_id: "fixture-savings", name: "Fixture savings", mask: "1002",
    type: "depository", subtype: "savings",
    balances: { current: "200.00", available: "200.00", iso_currency_code: "USD" },
  }),
  Object.freeze({
    account_id: "fixture-cd", name: "Fixture certificate", mask: "1003",
    type: "depository", subtype: "cd",
    balances: { current: "300.00", available: null, iso_currency_code: "USD" },
  }),
  Object.freeze({
    account_id: "fixture-hsa", name: "Fixture health savings", mask: "1004",
    type: "depository", subtype: "hsa",
    balances: { current: "400.00", available: null, iso_currency_code: "USD" },
  }),
]);

function plaidFixtureFetch() {
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body || "{}");
    if (path === "/link/token/create") {
      return jsonResponse({
        link_token: "link-fixture-short-lived",
        expiration: "2099-09-24T12:00:00.000Z",
      });
    }
    if (path === "/item/public_token/exchange") {
      assert.equal(body.public_token, "public-fixture-once");
      return jsonResponse({ item_id: "item-fixture-restricted", access_token: "access-fixture-secret" });
    }
    if (path === "/accounts/get") {
      fetchImpl.accountReads += 1;
      return jsonResponse({ accounts: fetchImpl.accounts });
    }
    if (path === "/transactions/sync") {
      return jsonResponse({
        added: [], modified: [], removed: [], next_cursor: "fixture-complete",
        has_more: false, transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
      });
    }
    throw new Error(`unexpected fixture path ${path}`);
  };
  fetchImpl.accountReads = 0;
  fetchImpl.accounts = ACCOUNTS;
  return fetchImpl;
}

async function connectedFixture() {
  const fixture = await createProductFixture({ env: {
    BANK_FEED_PROVIDER: "plaid",
    BANK_FEED_ENV: "sandbox",
    BANK_FEED_CLIENT_ID: "fixture-client-id",
    BANK_FEED_SECRET: "fixture-secret",
    BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
    BRAIN_NAME: "Fixture Brain",
  } });
  seedOwnedEntity(fixture, "fixture-owner", "Fixture owner");
  const fetchImpl = plaidFixtureFetch();
  const link = await createPlaidLinkToken(fixture.env, {
    url: "https://brain.invalid/app/connect/bank",
    sessionRef: "restricted-cash-link-fixture-0001",
    fetchImpl,
    now: NOW,
  });
  await completePlaidLink(fixture.env, {
    sessionRef: link.session_ref,
    publicToken: "public-fixture-once",
    fetchImpl,
    now: NOW,
  });
  const first = await syncPlaidItem(fixture.env, "item-fixture-restricted", { fetchImpl, now: NOW });
  assert.equal(first.status, "assignment_required");
  const assignments = fixture.rows(
    "SELECT provider_account_id,account_ref FROM plaid_account_entity_assignments ORDER BY provider_account_id",
  );
  assert.equal(assignments.length, ACCOUNTS.length, "the subtype probe reached the reviewed assignment decision");
  for (const [index, account] of assignments.entries()) {
    await assignPlaidAccountEntity(fixture.env, {
      request_id: `restricted-cash-assignment-${index}`,
      account_ref: account.account_ref,
      entity_slug: "fixture-owner",
    }, { now: NOW });
  }
  return { fixture, fetchImpl };
}

test("Plaid CDs and HSAs are restricted cash while every existing mapping stays unchanged", () => {
  const unchanged = [
    ["depository", "checking", "checking"],
    ["depository", "savings", "savings"],
    ["depository", "money market", "savings"],
    ["depository", "cash management", "checking"],
    ["credit", "credit card", "card"],
    ["credit", "other", "card"],
    ["loan", "auto", "loan"],
    ["loan", "mortgage", "loan"],
    ["loan", "student", "loan"],
    ["loan", "line of credit", "line_of_credit"],
    ["loan", "other", "loan"],
    ["investment", "brokerage", "investment"],
    ["investment", "ira", "retirement"],
    ["investment", "401k", "retirement"],
    ["investment", "other", "other"],
  ];
  for (const [type, subtype, expected] of unchanged) {
    assert.equal(accountKindFor(type, subtype), expected, `${type}:${subtype} remains ${expected}`);
  }
  assert.equal(accountKindFor("depository", "cd"), "cd");
  assert.equal(accountKindFor("depository", "hsa"), "hsa");
});

test("a sandbox-shaped Plaid item separates spendable and restricted cash", async () => {
  const { fixture, fetchImpl } = await connectedFixture();
  try {
    const stagedCd = fixture.first(
      "SELECT account_slug FROM plaid_sync_stage_accounts WHERE provider_account_id='fixture-cd'",
    );
    fixture.raw(
      `INSERT INTO fin_accounts
         (tenant_id,account_slug,entity_slug,label,account_kind,balance_role,external_ref,
          provenance,source_feed,basis_state,recorded_at)
       VALUES ('primary',?,'fixture-owner','Fixture existing certificate','checking','asset','fixture-cd',
               'feed','bank-feed:item-fixture-restricted','confirmed','2026-09-01T00:00:00.000Z')`,
      stagedCd.account_slug,
    );
    fixture.raw(
      `INSERT INTO fin_transactions
         (tenant_id,txn_uid,account_slug,posted_on,amount_minor,direction,currency,description,
          external_id,pending,provenance,source_feed,basis_state,recorded_at)
       VALUES ('primary','fixture-existing-cd-history',?,'2026-09-01',2500,'inflow','USD',
               'Fixture retained history','fixture-existing-cd-line',0,'feed',
               'bank-feed:item-fixture-restricted','confirmed','2026-09-01T00:00:00.000Z')`,
      stagedCd.account_slug,
    );
    const historyBefore = fixture.rows(
      "SELECT * FROM fin_transactions WHERE account_slug=? ORDER BY txn_uid",
      stagedCd.account_slug,
    );

    const promoted = await syncPlaidItem(
      fixture.env,
      "item-fixture-restricted",
      { fetchImpl, now: NOW },
    );
    assert.equal(promoted.resumed_promotion, true);

    const cash = await ledgerCashPosition(fixture.env, { asOf: "2026-09-24" });
    assert.equal(cash.total_minor, 30000, "spendable cash is checking plus savings exactly");
    assert.equal(cash.accounts_considered, 2);
    assert.equal(cash.restricted_cash.total_minor, 70000, "restricted cash is CD plus HSA exactly");
    assert.equal(cash.restricted_cash.accounts_considered, 2);
    assert.deepEqual(
      cash.restricted_cash.covered.map((row) => row.account_kind).sort(),
      ["cd", "hsa"],
    );

    const durableCd = fixture.first(
      "SELECT account_kind,restricted_cash_kind FROM fin_accounts WHERE external_ref='fixture-cd'",
    );
    assert.equal(durableCd.restricted_cash_kind, "cd", "the next sync reclassifies the stored account");
    const historyAfter = fixture.rows(
      "SELECT * FROM fin_transactions WHERE account_slug=? ORDER BY txn_uid",
      stagedCd.account_slug,
    );
    assert.equal(historyAfter.length, historyBefore.length, "reclassification adds or removes no history row");
    assert.deepEqual(historyAfter, historyBefore, "reclassification leaves every ledger history field unchanged");

    const map = await readOwnerFinancialMapState(fixture.env);
    const kinds = map.current_inventory.accounts.map((account) => account.fields.kind.current_value).sort();
    assert.deepEqual(kinds, ["cd", "checking", "hsa", "savings"]);
  } finally {
    fixture.close();
  }
});

test("a later Plaid sync with no subtype preserves an existing restricted-cash classification", async () => {
  const { fixture, fetchImpl } = await connectedFixture();
  try {
    const accountsWithCdSubtype = (subtype) => ACCOUNTS.map((account) => {
      if (account.account_id !== "fixture-cd") return account;
      const changed = { ...account };
      if (subtype === undefined) delete changed.subtype;
      else changed.subtype = subtype;
      return changed;
    });
    const initialPromotion = await syncPlaidItem(
      fixture.env,
      "item-fixture-restricted",
      { fetchImpl, now: NOW },
    );
    assert.equal(initialPromotion.resumed_promotion, true);
    assert.equal(
      fixture.first("SELECT restricted_cash_kind FROM fin_accounts WHERE external_ref='fixture-cd'")
        .restricted_cash_kind,
      "cd",
    );

    fetchImpl.accounts = accountsWithCdSubtype(undefined);
    const laterSync = await syncPlaidItem(
      fixture.env,
      "item-fixture-restricted",
      { fetchImpl, now: NOW },
    );
    assert.equal(fetchImpl.accountReads, 2, "the later sync read the provider's omitted subtype");
    assert.equal(laterSync.promoted, true, "the later promotion decision was reached");

    const durableCd = fixture.first(
      "SELECT account_kind,restricted_cash_kind FROM fin_accounts WHERE external_ref='fixture-cd'",
    );
    assert.equal(durableCd.restricted_cash_kind, "cd");
    const cash = await ledgerCashPosition(fixture.env, { asOf: "2026-09-24" });
    assert.equal(cash.total_minor, 30000, "the known CD remains outside spendable cash");
    assert.equal(cash.restricted_cash.total_minor, 70000);

    fetchImpl.accounts = accountsWithCdSubtype("other");
    const ambiguousSync = await syncPlaidItem(
      fixture.env,
      "item-fixture-restricted",
      { fetchImpl, now: NOW },
    );
    assert.equal(fetchImpl.accountReads, 3);
    assert.equal(ambiguousSync.promoted, true);
    assert.equal(
      fixture.first("SELECT restricted_cash_kind FROM fin_accounts WHERE external_ref='fixture-cd'")
        .restricted_cash_kind,
      "cd",
      "an ambiguous subtype does not clear known restricted cash",
    );

    fetchImpl.accounts = accountsWithCdSubtype("checking");
    const authoritativeSync = await syncPlaidItem(
      fixture.env,
      "item-fixture-restricted",
      { fetchImpl, now: NOW },
    );
    assert.equal(fetchImpl.accountReads, 4);
    assert.equal(authoritativeSync.promoted, true);
    assert.equal(
      fixture.first("SELECT restricted_cash_kind FROM fin_accounts WHERE external_ref='fixture-cd'")
        .restricted_cash_kind,
      null,
      "an explicit supported subtype clears the stale restriction",
    );
    const reclassifiedCash = await ledgerCashPosition(fixture.env, { asOf: "2026-09-24" });
    assert.equal(reclassifiedCash.total_minor, 60000, "the explicit checking subtype becomes spendable");
    assert.equal(reclassifiedCash.restricted_cash.total_minor, 40000);
  } finally {
    fixture.close();
  }
});
