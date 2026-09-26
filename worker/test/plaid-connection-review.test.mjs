import test from "node:test";
import assert from "node:assert/strict";
import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";
import {
  completePlaidLink,
  createPlaidLinkToken,
  disconnectPlaidItem,
  plaidFeedStatus,
  syncPlaidItem,
} from "../src/lib/plaid-bank-feed.js";
import { encryptAccessReference, handleBankFeed } from "../src/lib/bank-feed.js";
import { assignPlaidAccountEntity } from "../src/lib/plaid-account-entities.js";
import Worker from "../src/index.js";

const config = {
  BANK_FEED_PROVIDER: "plaid", BANK_FEED_ENV: "sandbox",
  BANK_FEED_CLIENT_ID: "synthetic-client", BANK_FEED_SECRET: "synthetic-secret",
  BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
};
const json = (data) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
function savedAccount(f, {
  item = "existing-item",
  institution = "synthetic-bank",
  name = "Operating",
  mask = "1234",
  accountKind = "checking",
  persistentAccountId = null,
  environment = "sandbox",
  removed = false,
} = {}) {
  f.raw(`INSERT INTO bank_feed_items (tenant_id,item_ref,institution_ref,access_ciphertext,access_iv,key_version,environment,status,connected_at,removed_at)
    VALUES ('primary',?,?, 'c2VhbGVkY2lwaGVydGV4dA==','AAAAAAAAAAAAAAAA',2,?,'connected','2026-09-01',?)`,
  item, institution, environment, removed ? "2026-09-02" : null);
  f.raw(`INSERT INTO fin_accounts (tenant_id,account_slug,entity_slug,institution,label,account_kind,balance_role,mask,feed_mode,external_ref,provenance,source_locator,source_feed,basis_state,recorded_at)
    VALUES ('primary',?,'primary','Synthetic Bank',?,?,?,?,'live',?,'feed',?,?,'confirmed','2026-09-01')`,
  `ledger-${item}`, name, accountKind, ["card", "loan", "line_of_credit"].includes(accountKind) ? "liability" : "asset",
  mask, `account-${item}`,
  `plaid/account-identity/depository/checking/${encodeURIComponent(persistentAccountId || "-")}`,
  `bank-feed:${item}`);
}
async function session(f, ref, extra = {}) {
  return createPlaidLinkToken(f.env, { url: "https://brain.invalid/app/connect/bank", sessionRef: ref,
    fetchImpl: async () => json({ link_token: "link-synthetic", expiration: "2099-01-01T00:00:00Z" }), ...extra });
}

async function reconnectAcrossTwoWindows({ secondAdded, beforeFirstSync = null, stopAfterFirst = false }) {
  const f = await createProductFixture({ env: config });
  const oldItem = "two-window-removed-item";
  const newItem = "two-window-replacement-item";
  const stamp = "2026-09-24T15:30:00.000Z";
  const cursors = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body || "{}");
    if (path === "/item/public_token/exchange") {
      return json({ item_id: newItem, access_token: "replacement-access" });
    }
    if (path === "/accounts/get") {
      return json({ accounts: [{
        account_id: "replacement-account", name: "Operating", mask: "1234",
        type: "depository", subtype: "checking",
        balances: { current: "100.00", available: "100.00", iso_currency_code: "USD" },
      }] });
    }
    if (path === "/transactions/sync") {
      const cursor = Object.hasOwn(body, "cursor") ? body.cursor : null;
      cursors.push(cursor);
      if (cursor === null) {
        return json({
          added: [], modified: [], removed: [], next_cursor: "first-replacement-cursor",
          has_more: false, transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
        });
      }
      assert.equal(cursor, "first-replacement-cursor");
      return json({
        added: secondAdded, modified: [], removed: [], next_cursor: "second-replacement-cursor",
        has_more: false, transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
      });
    }
    throw new Error(`unexpected Plaid path ${path}`);
  };

  seedOwnedEntity(f, "two-window-owner", "Two Window Owner");
  savedAccount(f, { item: oldItem, removed: true });
  f.raw("UPDATE fin_accounts SET entity_slug='two-window-owner' WHERE source_feed=?", `bank-feed:${oldItem}`);
  await session(f, "two-window-session-0001", { now: stamp });
  await completePlaidLink(f.env, {
    sessionRef: "two-window-session-0001", publicToken: "synthetic-public",
    institutionRef: "synthetic-bank", institutionLabel: "Synthetic Bank",
    accounts: [{
      id: "replacement-account", name: "Operating", mask: "1234",
      type: "depository", subtype: "checking",
    }],
    fetchImpl, now: stamp,
  });
  if (beforeFirstSync) await beforeFirstSync({ f, newItem, stamp });
  const first = await syncPlaidItem(f.env, newItem, { fetchImpl, now: stamp });
  const planTypeAfterFirst = f.first(
    "SELECT json_type(receipt_json,'$._reconnect_plan') AS plan_type FROM plaid_link_operations WHERE session_ref=?",
    "two-window-session-0001",
  ).plan_type;
  const second = stopAfterFirst ? null : await syncPlaidItem(f.env, newItem, {
    fetchImpl, now: "2026-09-24T15:35:00.000Z",
  });
  return { f, oldItem, newItem, first, second, cursors, planTypeAfterFirst };
}

test("disconnect then reconnect resumes the same ledger accounts without duplicate transactions", async () => {
  const f = await createProductFixture({ env: config });
  const oldItem = "removed-item";
  const newItem = "replacement-item";
  const oldFeed = `bank-feed:${oldItem}`;
  const newFeed = `bank-feed:${newItem}`;
  const accountSlug = "ledger-removed-item";
  const stamp = "2026-09-24T15:00:00.000Z";
  const calls = [];
  let syncReads = 0;
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body || "{}");
    calls.push(path);
    if (path === "/item/remove") return json({ removed: true });
    if (path === "/link/token/create") {
      return json({ link_token: "replacement-link", expiration: "2099-01-01T00:00:00.000Z" });
    }
    if (path === "/item/public_token/exchange") {
      return json({ item_id: newItem, access_token: "replacement-access" });
    }
    if (path === "/accounts/get") {
      return json({ accounts: [{
        account_id: "replacement-account",
        persistent_account_id: "persistent-ledger-account",
        name: "Synthetic checking",
        mask: "1234",
        type: "depository",
        subtype: "checking",
        balances: { current: "90.00", available: "80.00", iso_currency_code: "USD" },
      }] });
    }
    if (path === "/transactions/sync") {
      syncReads += 1;
      assert.equal(Object.hasOwn(body, "cursor"), false, "a reconnect must start with a new cursor");
      return json({
        added: [
          {
            transaction_id: "replacement-transaction",
            account_id: "replacement-account",
            amount: "10.00",
            iso_currency_code: "USD",
            date: "2026-09-23",
            pending: false,
            name: "Existing fixture transaction",
          },
          {
            transaction_id: "new-transaction",
            account_id: "replacement-account",
            amount: "5.00",
            iso_currency_code: "USD",
            date: "2026-09-23",
            pending: false,
            name: "New fixture transaction",
          },
        ],
        modified: [],
        removed: [],
        next_cursor: "replacement-cursor",
        has_more: false,
        transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
      });
    }
    throw new Error(`unexpected Plaid path ${path}`);
  };
  try {
    seedOwnedEntity(f, "fixture-household", "Fixture Household");
    const sealed = await encryptAccessReference(f.env, "removed-access");
    f.raw(`INSERT INTO bank_feed_items
      (tenant_id,item_ref,institution_ref,institution_label,access_ciphertext,access_iv,key_version,
       environment,cursor,status,connected_at)
      VALUES ('primary',?,'synthetic-bank','Synthetic Bank',?,?,?,'sandbox','old-cursor','connected',?)`,
    oldItem, sealed.ciphertext, sealed.iv, sealed.keyVersion, "2026-09-01T00:00:00.000Z");
    f.raw(`INSERT INTO fin_accounts
      (tenant_id,account_slug,entity_slug,institution,label,account_kind,balance_role,mask,currency,
       feed_mode,external_ref,provenance,source_locator,source_feed,basis_state,recorded_at)
      VALUES ('primary',?,'fixture-household','Synthetic Bank','Synthetic checking','checking','asset','1234','USD',
              'live','removed-account','feed','plaid/account-identity/depository/checking/persistent-ledger-account',?,'confirmed',?)`,
    accountSlug, oldFeed, stamp);
    f.raw(`INSERT INTO fin_transactions
      (tenant_id,txn_uid,account_slug,posted_on,amount_minor,direction,raw_amount_minor,
       raw_sign_convention,currency,description,pending,external_id,provenance,source_locator,
       source_feed,basis_state,recorded_at)
      VALUES ('primary','plaid:prior-transaction',?,'2026-09-20',1000,'outflow',1000,
              'feed_positive_amount_is_outflow','USD','Existing fixture transaction',1,
              'prior-transaction','feed','plaid/transactions/prior-transaction',?,'confirmed',?)`,
    accountSlug, oldFeed, stamp);
    f.raw(`INSERT INTO fin_balance_snapshots
      (tenant_id,account_slug,as_of_date,current_minor,available_minor,currency,provenance,
       source_locator,source_feed,basis_state,recorded_at)
      VALUES ('primary',?,'2026-09-24',10000,9000,'USD','feed','plaid/balance/removed',?,'confirmed',?)`,
    accountSlug, oldFeed, stamp);
    f.raw(`INSERT INTO plaid_account_entity_assignments
      (tenant_id,item_ref,provider_account_id,account_ref,entity_slug,discovered_at,last_seen_at,assigned_at,updated_at)
      VALUES ('primary',?,'removed-account',?,'fixture-household',?,?,?,?)`,
    oldItem, `acct_${"1".repeat(32)}`, stamp, stamp, stamp, stamp);
    const originalAccountId = f.first("SELECT id FROM fin_accounts WHERE account_slug=?", accountSlug).id;

    const disconnected = await disconnectPlaidItem(f.env, oldItem, {
      fetchImpl,
      now: "2026-09-22T15:00:00.000Z",
    });
    assert.equal(disconnected.revocation_state, "confirmed");
    assert.ok(calls.includes("/item/remove"), "the disconnect decision point must be reached");

    const link = await createPlaidLinkToken(f.env, {
      url: "https://brain.invalid/app/connect/bank",
      sessionRef: "replacement-session-0001",
      fetchImpl,
      now: stamp,
    });
    const reconnected = await completePlaidLink(f.env, {
      sessionRef: link.session_ref,
      publicToken: "replacement-public-token",
      institutionRef: "synthetic-bank",
      institutionLabel: "Synthetic Bank",
      accounts: [{
        id: "replacement-account", name: "Synthetic checking", mask: "1234",
        type: "depository", subtype: "checking",
      }],
      fetchImpl,
      now: stamp,
    });
    assert.equal(reconnected.item_ref, newItem);
    assert.equal(reconnected.reconnected, true);
    assert.equal(Object.hasOwn(reconnected, "_reconnect_plan"), false);
    const replayed = await completePlaidLink(f.env, {
      sessionRef: link.session_ref,
      publicToken: "replacement-public-token",
      fetchImpl: async () => { throw new Error("a completed exchange must replay its public receipt"); },
      now: stamp,
    });
    assert.equal(replayed.reconnected, true);
    assert.equal(Object.hasOwn(replayed, "_reconnect_plan"), false,
      "the private ledger mapping must not enter the owner-visible durable receipt");
    assert.deepEqual({ ...f.first(
      "SELECT id,account_slug,entity_slug,external_ref,source_feed FROM fin_accounts",
    ) }, {
      id: originalAccountId,
      account_slug: accountSlug,
      entity_slug: "fixture-household",
      external_ref: "removed-account",
      source_feed: oldFeed,
    });
    assert.equal(f.first(
      "SELECT COUNT(*) AS n FROM plaid_account_entity_assignments WHERE item_ref=?", newItem,
    ).n, 0, "exchange must not copy the owner assignment before authoritative history reconciliation");
    assert.match(f.first("SELECT status_detail FROM bank_feed_items WHERE item_ref=?", oldItem).status_detail,
      /replacement connection is staged/);

    const synced = await syncPlaidItem(f.env, newItem, { fetchImpl, now: stamp });
    assert.equal(syncReads, 1, "the pending-to-posted reconciliation decision must read the staged provider window");
    assert.equal(synced.ok, true, JSON.stringify(synced));
    assert.equal(f.first("SELECT cursor FROM bank_feed_items WHERE item_ref=?", newItem).cursor,
      "replacement-cursor");
    assert.equal(f.first("SELECT COUNT(*) AS n FROM fin_accounts").n, 1);
    assert.deepEqual({ ...f.first(
      "SELECT id,account_slug,entity_slug,external_ref,source_feed FROM fin_accounts",
    ) }, {
      id: originalAccountId,
      account_slug: accountSlug,
      entity_slug: "fixture-household",
      external_ref: "replacement-account",
      source_feed: newFeed,
    });
    assert.equal(f.first(
      "SELECT entity_slug FROM plaid_account_entity_assignments WHERE item_ref=?", newItem,
    ).entity_slug, "fixture-household");
    assert.equal(f.first("SELECT source_locator FROM fin_accounts").source_locator,
      "plaid/account-identity/depository/checking/persistent-ledger-account");
    assert.equal(f.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 2);
    assert.equal(f.first(
      "SELECT COUNT(*) AS n FROM fin_transactions WHERE txn_uid='plaid:replacement-transaction'",
    ).n, 1);
    assert.equal(f.first(
      "SELECT COUNT(*) AS n FROM fin_transactions WHERE txn_uid='plaid:prior-transaction'",
    ).n, 0, "the retained row must be reused even when the replacement Item changes its transaction id");
    assert.equal(f.first(
      "SELECT COUNT(*) AS n FROM fin_transactions WHERE removed_at IS NULL AND amount_minor=1000 AND description='Existing fixture transaction'",
    ).n, 1, "one live economic transaction must remain after a pending row settles with no usable linkage");
    assert.equal(f.first(
      "SELECT COUNT(*) AS n FROM fin_transactions WHERE account_slug=? AND source_feed=?",
      accountSlug, newFeed,
    ).n, 2);
    assert.equal(f.first("SELECT COUNT(*) AS n FROM fin_balance_snapshots WHERE account_slug=?", accountSlug).n, 1);
  } finally { f.close(); }
});

test("a reconnect holds a changed-label settlement authorized before disconnect", async () => {
  const f = await createProductFixture({ env: config });
  const oldItem = "authorization-removed-item";
  const newItem = "authorization-replacement-item";
  const oldFeed = `bank-feed:${oldItem}`;
  const stamp = "2026-09-24T15:20:00.000Z";
  let syncReads = 0;
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/item/public_token/exchange") {
      return json({ item_id: newItem, access_token: "replacement-access" });
    }
    if (path === "/accounts/get") {
      return json({ accounts: [{
        account_id: "authorization-replacement-account", name: "Operating", mask: "1234",
        type: "depository", subtype: "checking",
        balances: { current: "90.00", available: "80.00", iso_currency_code: "USD" },
      }] });
    }
    if (path === "/transactions/sync") {
      syncReads += 1;
      return json({
        added: [{
          transaction_id: "changed-settlement", account_id: "authorization-replacement-account",
          amount: "10.00", iso_currency_code: "USD", date: "2026-09-23",
          authorized_date: "2026-09-20", pending: false, name: "Changed fixture label",
        }],
        modified: [], removed: [], next_cursor: "must-stay-held", has_more: false,
        transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
      });
    }
    throw new Error(`unexpected Plaid path ${path}`);
  };
  try {
    seedOwnedEntity(f, "authorization-owner", "Authorization Owner");
    savedAccount(f, { item: oldItem, removed: true });
    f.raw("UPDATE bank_feed_items SET removed_at='2026-09-22T15:00:00.000Z' WHERE item_ref=?", oldItem);
    f.raw("UPDATE fin_accounts SET entity_slug='authorization-owner' WHERE source_feed=?", oldFeed);
    f.raw(`INSERT INTO fin_transactions
      (tenant_id,txn_uid,account_slug,posted_on,amount_minor,direction,raw_amount_minor,
       raw_sign_convention,currency,description,pending,external_id,provenance,source_locator,
       source_feed,basis_state,recorded_at)
      VALUES ('primary','plaid:authorization-pending','ledger-authorization-removed-item','2026-09-20',
              1000,'outflow',1000,'feed_positive_amount_is_outflow','USD','Original fixture label',1,
              'authorization-pending','feed','plaid/transactions/authorization-pending',?,'confirmed',?)`,
    oldFeed, stamp);
    await session(f, "authorization-session-0001", { now: stamp });
    await completePlaidLink(f.env, {
      sessionRef: "authorization-session-0001", publicToken: "synthetic-public",
      institutionRef: "synthetic-bank", institutionLabel: "Synthetic Bank",
      accounts: [{
        id: "authorization-replacement-account", name: "Operating", mask: "1234",
        type: "depository", subtype: "checking",
      }],
      fetchImpl, now: stamp,
    });
    const result = await syncPlaidItem(f.env, newItem, { fetchImpl, now: stamp });
    assert.equal(syncReads, 1, "the authorization-boundary decision must read the provider window");
    assert.equal(result.code, "plaid_reconnect_transaction_review_required");
    assert.equal(result.cursor_advanced, false);
    assert.equal(f.first("SELECT cursor FROM bank_feed_items WHERE item_ref=?", newItem).cursor, null);
    assert.equal(f.first(
      "SELECT COUNT(*) AS n FROM plaid_sync_stage_transactions WHERE provider_transaction_id='changed-settlement'",
    ).n, 1, "the complete uncertain window must remain staged");
    assert.equal(f.first("SELECT COUNT(*) AS n FROM fin_transactions WHERE removed_at IS NULL").n, 1,
      "the changed settlement must not create a second live money row");
  } finally { f.close(); }
});

test("a promoted reconnect advances an empty second window without reattaching again", async () => {
  const result = await reconnectAcrossTwoWindows({ secondAdded: [] });
  try {
    assert.equal(result.first.ok, true, JSON.stringify(result.first));
    assert.equal(result.planTypeAfterFirst, null,
      "the first guarded promotion must consume its private reconnect plan");
    assert.equal(result.second.ok, true, JSON.stringify(result.second));
    assert.deepEqual(result.cursors, [null, "first-replacement-cursor"],
      "the second provider decision must continue from the promoted cursor");
    assert.equal(result.f.first(
      "SELECT cursor FROM bank_feed_items WHERE item_ref=?", result.newItem,
    ).cursor, "second-replacement-cursor");
    assert.equal(result.f.first(
      "SELECT COUNT(*) AS n FROM plaid_account_entity_assignments WHERE item_ref=?", result.newItem,
    ).n, 1, "ordinary refresh must retain one exact assignment");
    assert.equal(result.f.first(
      "SELECT COUNT(*) AS n FROM fin_accounts WHERE source_feed=?", `bank-feed:${result.oldItem}`,
    ).n, 0, "the second window must not rerun the old-feed move");
  } finally { result.f.close(); }
});

test("a promoted reconnect adds one genuinely new transaction in its second window", async () => {
  const result = await reconnectAcrossTwoWindows({
    secondAdded: [{
      transaction_id: "genuinely-new-transaction", account_id: "replacement-account",
      amount: "7.50", iso_currency_code: "USD", date: "2026-09-24",
      pending: false, name: "New fixture purchase",
    }],
  });
  try {
    assert.equal(result.first.ok, true, JSON.stringify(result.first));
    assert.equal(result.planTypeAfterFirst, null,
      "the first guarded promotion must consume its private reconnect plan");
    assert.equal(result.second.ok, true, JSON.stringify(result.second));
    assert.deepEqual(result.cursors, [null, "first-replacement-cursor"],
      "the second provider decision must continue from the promoted cursor");
    assert.equal(result.f.first(
      "SELECT cursor FROM bank_feed_items WHERE item_ref=?", result.newItem,
    ).cursor, "second-replacement-cursor");
    assert.equal(result.f.first(
      "SELECT COUNT(*) AS n FROM fin_transactions WHERE txn_uid='plaid:genuinely-new-transaction' AND removed_at IS NULL",
    ).n, 1, "the ordinary second window must add the new transaction exactly once");
    assert.equal(result.f.first(
      "SELECT COUNT(*) AS n FROM plaid_account_entity_assignments WHERE item_ref=?", result.newItem,
    ).n, 1, "the second window must not duplicate the retained assignment");
  } finally { result.f.close(); }
});

test("a repeated reconnect assignment is accepted only when every stored field matches", async () => {
  const result = await reconnectAcrossTwoWindows({
    secondAdded: [],
    stopAfterFirst: true,
    beforeFirstSync: ({ f, newItem, stamp }) => {
      const receipt = JSON.parse(f.first(
        "SELECT receipt_json FROM plaid_link_operations WHERE session_ref='two-window-session-0001'",
      ).receipt_json);
      const account = receipt._reconnect_plan.accounts[0];
      f.raw(`INSERT INTO plaid_account_entity_assignments
        (tenant_id,item_ref,provider_account_id,account_ref,entity_slug,
         discovered_at,last_seen_at,assigned_at,updated_at)
        VALUES ('primary',?,?,?,?,?,?,?,?)`,
      newItem, account.providerAccountId, account.accountRef, account.entitySlug,
      stamp, stamp, stamp, "2026-09-24T15:29:59.000Z");
    },
  });
  try {
    assert.deepEqual(result.cursors, [null],
      "the mismatched replay control must reach one provider reconciliation window");
    assert.equal(result.first.code, "plaid_reconnect_transaction_review_required");
    assert.equal(result.first.cursor_advanced, false);
    assert.equal(result.planTypeAfterFirst, "object",
      "a rejected replay must retain the private plan for review");
    assert.equal(result.f.first(
      "SELECT cursor FROM bank_feed_items WHERE item_ref=?", result.newItem,
    ).cursor, null);
    assert.equal(result.f.first(
      "SELECT source_feed FROM fin_accounts WHERE account_slug='ledger-two-window-removed-item'",
    ).source_feed, `bank-feed:${result.oldItem}`,
    "a mismatched assignment field must roll back the complete reconnect promotion");
  } finally { result.f.close(); }
});

test("a removed legacy account without a locator refuses reconnect before exchange", async () => {
  const f = await createProductFixture({ env: config });
  const oldItem = "legacy-removed-item";
  const newItem = "legacy-replacement-item";
  const oldFeed = `bank-feed:${oldItem}`;
  const stamp = "2026-09-24T18:00:00.000Z";
  let removals = 0;
  let exchanges = 0;
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/item/remove") {
      removals += 1;
      return json({ removed: true });
    }
    if (path === "/item/public_token/exchange") {
      exchanges += 1;
      return json({ item_id: newItem, access_token: "replacement-access" });
    }
    throw new Error(`unexpected Plaid path ${path}`);
  };
  try {
    const sealed = await encryptAccessReference(f.env, "legacy-access");
    f.raw(`INSERT INTO bank_feed_items
      (tenant_id,item_ref,institution_ref,institution_label,access_ciphertext,access_iv,key_version,
       environment,cursor,status,connected_at)
      VALUES ('primary',?,'synthetic-bank','Synthetic Bank',?,?,?,'sandbox','legacy-cursor','connected',?)`,
    oldItem, sealed.ciphertext, sealed.iv, sealed.keyVersion, "2026-09-01T00:00:00.000Z");
    // This is the comparison-base promotion shape: it predates the account
    // identity locator and therefore cannot prove an automatic reattachment.
    f.raw(`INSERT INTO fin_accounts
      (tenant_id,account_slug,entity_slug,label,account_kind,balance_role,mask,currency,
       feed_mode,external_ref,provenance,source_feed,basis_state,recorded_at,
       source_iso_currency_code,source_unofficial_currency_code)
      VALUES ('primary','ledger-legacy-account','primary','Operating','checking','asset','1234','USD',
              'live','legacy-provider-account','feed',?,'confirmed',?,'USD',NULL)`, oldFeed, stamp);
    f.raw(`INSERT INTO fin_transactions
      (tenant_id,txn_uid,account_slug,posted_on,amount_minor,direction,raw_amount_minor,
       raw_sign_convention,currency,description,pending,external_id,provenance,source_locator,
       source_feed,basis_state,recorded_at)
      VALUES ('primary','plaid:legacy-transaction','ledger-legacy-account','2026-09-10',2500,'outflow',2500,
              'feed_positive_amount_is_outflow','USD','Legacy fixture transaction',0,
              'legacy-transaction','feed','plaid/transactions/legacy-transaction',?,'confirmed',?)`, oldFeed, stamp);

    const disconnected = await disconnectPlaidItem(f.env, oldItem, { fetchImpl, now: stamp });
    assert.equal(disconnected.revocation_state, "confirmed");
    assert.equal(removals, 1, "the legacy control must reach confirmed provider removal");
    assert.equal(f.first("SELECT source_locator FROM fin_accounts WHERE account_slug='ledger-legacy-account'").source_locator,
      null, "the comparison-base account must really lack the later identity locator");

    await session(f, "legacy-review-session-0001", { now: stamp });
    const beforeLedger = { ...f.first(
      "SELECT entity_slug,external_ref,source_feed,source_locator FROM fin_accounts WHERE account_slug='ledger-legacy-account'",
    ) };
    await assert.rejects(completePlaidLink(f.env, {
      sessionRef: "legacy-review-session-0001", publicToken: "synthetic-public",
      institutionRef: "synthetic-bank", institutionLabel: "Synthetic Bank",
      accounts: [{
        id: "legacy-replacement-account", name: "Operating", mask: "1234",
        type: "depository", subtype: "checking",
      }],
      fetchImpl, now: stamp,
    }), { code: "plaid_legacy_reconnect_support_required" });
    assert.equal(exchanges, 0, "the missing-identity decision must refuse before one-time exchange");
    assert.deepEqual({ ...f.first(
      "SELECT entity_slug,external_ref,source_feed,source_locator FROM fin_accounts WHERE account_slug='ledger-legacy-account'",
    ) }, beforeLedger, "a refused legacy reconnect must make zero ledger change");
    assert.equal(f.first("SELECT COUNT(*) AS n FROM bank_feed_items WHERE item_ref=?", newItem).n, 0);
    assert.match(f.first("SELECT status_detail FROM bank_feed_items WHERE item_ref=?", oldItem).status_detail,
      /Operating ending 1234/, "the support note must identify the exact saved account safely");
    assert.equal(f.first(
      "SELECT state FROM plaid_link_operations WHERE session_ref='legacy-review-session-0001'",
    ).state, "link_ready", "the pre-exchange refusal must release the Link claim");
  } finally { f.close(); }
});

test("the next ordinary sync backfills a live legacy account identity locator", async () => {
  const f = await createProductFixture({ env: config });
  const item = "live-legacy-item";
  const stamp = "2026-09-24T18:10:00.000Z";
  let accountReads = 0;
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/accounts/get") {
      accountReads += 1;
      return json({ accounts: [{
        account_id: "live-legacy-account", persistent_account_id: "stable-live-account",
        name: "Operating", mask: "1234", type: "depository", subtype: "checking",
        balances: { current: "50.00", available: "40.00", iso_currency_code: "USD" },
      }] });
    }
    if (path === "/transactions/sync") {
      return json({
        added: [], modified: [], removed: [], next_cursor: "live-legacy-cursor",
        has_more: false, transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
      });
    }
    throw new Error(`unexpected Plaid path ${path}`);
  };
  try {
    seedOwnedEntity(f, "live-legacy-owner", "Live Legacy Owner");
    const sealed = await encryptAccessReference(f.env, "live-legacy-access");
    f.raw(`INSERT INTO bank_feed_items
      (tenant_id,item_ref,institution_ref,institution_label,access_ciphertext,access_iv,key_version,
       environment,status,connected_at)
      VALUES ('primary',?,'synthetic-bank','Synthetic Bank',?,?,?,'sandbox','connected',?)`,
    item, sealed.ciphertext, sealed.iv, sealed.keyVersion, stamp);
    f.raw(`INSERT INTO fin_accounts
      (tenant_id,account_slug,entity_slug,label,account_kind,balance_role,mask,currency,
       feed_mode,external_ref,provenance,source_locator,source_feed,basis_state,recorded_at)
      VALUES ('primary','ledger-live-legacy','live-legacy-owner','Operating','checking','asset','1234','USD',
              'live','live-legacy-account','feed',NULL,?,'confirmed',?)`, `bank-feed:${item}`, stamp);
    f.raw(`INSERT INTO plaid_account_entity_assignments
      (tenant_id,item_ref,provider_account_id,account_ref,entity_slug,discovered_at,last_seen_at,assigned_at,updated_at)
      VALUES ('primary',?,'live-legacy-account',?,'live-legacy-owner',?,?,?,?)`,
    item, `acct_${"2".repeat(32)}`, stamp, stamp, stamp, stamp);
    f.raw(`INSERT INTO bank_feed_backfill (tenant_id,item_ref,requested_days,state,queued_at)
      VALUES ('primary',?,730,'queued',?)`, item, stamp);
    const result = await syncPlaidItem(f.env, item, { fetchImpl, now: stamp });
    assert.equal(accountReads, 1, "the backfill must use the authoritative provider inventory");
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(f.first(
      "SELECT source_locator FROM fin_accounts WHERE account_slug='ledger-live-legacy'",
    ).source_locator, "plaid/account-identity/depository/checking/stable-live-account");
  } finally { f.close(); }
});

test("a mixed reconnect reattaches the saved account and routes the new account through owner assignment", async () => {
  const f = await createProductFixture({ env: config });
  const oldItem = "mixed-removed-item";
  const newItem = "mixed-replacement-item";
  const oldFeed = `bank-feed:${oldItem}`;
  const stamp = "2026-09-24T18:20:00.000Z";
  let exchanges = 0;
  let syncReads = 0;
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body || "{}");
    if (path === "/item/public_token/exchange") {
      exchanges += 1;
      return json({ item_id: newItem, access_token: "mixed-replacement-access" });
    }
    if (path === "/accounts/get") {
      return json({ accounts: [
        {
          account_id: "mixed-saved-account", name: "Operating", mask: "1234",
          type: "depository", subtype: "checking",
          balances: { current: "90.00", available: "80.00", iso_currency_code: "USD" },
        },
        {
          account_id: "mixed-new-account", name: "Reserve", mask: "5678",
          type: "depository", subtype: "savings",
          balances: { current: "25.00", available: "25.00", iso_currency_code: "USD" },
        },
      ] });
    }
    if (path === "/transactions/sync") {
      syncReads += 1;
      assert.equal(Object.hasOwn(body, "cursor"), false);
      return json({
        added: [
          {
            transaction_id: "mixed-retained-posted", account_id: "mixed-saved-account",
            amount: "10.00", iso_currency_code: "USD", date: "2026-09-20",
            pending: false, name: "Retained fixture purchase",
          },
          {
            transaction_id: "mixed-new-purchase", account_id: "mixed-new-account",
            amount: "5.00", iso_currency_code: "USD", date: "2026-09-24",
            authorized_date: "2026-09-24", pending: false, name: "New fixture purchase",
          },
        ],
        modified: [], removed: [], next_cursor: "mixed-final-cursor", has_more: false,
        transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
      });
    }
    throw new Error(`unexpected Plaid path ${path}`);
  };
  try {
    seedOwnedEntity(f, "mixed-owner", "Mixed Owner");
    savedAccount(f, { item: oldItem, removed: true });
    f.raw("UPDATE bank_feed_items SET removed_at='2026-09-22T15:00:00.000Z' WHERE item_ref=?", oldItem);
    f.raw("UPDATE fin_accounts SET entity_slug='mixed-owner' WHERE source_feed=?", oldFeed);
    f.raw(`INSERT INTO fin_transactions
      (tenant_id,txn_uid,account_slug,posted_on,amount_minor,direction,raw_amount_minor,
       raw_sign_convention,currency,description,pending,external_id,provenance,source_locator,
       source_feed,basis_state,recorded_at)
      VALUES ('primary','plaid:mixed-retained-pending','ledger-mixed-removed-item','2026-09-20',1000,
              'outflow',1000,'feed_positive_amount_is_outflow','USD','Retained fixture purchase',1,
              'mixed-retained-pending','feed','plaid/transactions/mixed-retained-pending',?,'confirmed',?)`,
    oldFeed, stamp);
    await session(f, "mixed-session-0001", { now: stamp });
    const linked = await completePlaidLink(f.env, {
      sessionRef: "mixed-session-0001", publicToken: "synthetic-public",
      institutionRef: "synthetic-bank", institutionLabel: "Synthetic Bank",
      accounts: [
        { id: "mixed-saved-account", name: "Operating", mask: "1234", type: "depository", subtype: "checking" },
        { id: "mixed-new-account", name: "Reserve", mask: "5678", type: "depository", subtype: "savings" },
      ],
      fetchImpl, now: stamp,
    });
    assert.equal(exchanges, 1, "the mixed plan must reach exactly one guarded exchange");
    assert.equal(linked.reconnected, true);
    const waiting = await syncPlaidItem(f.env, newItem, { fetchImpl, now: stamp });
    assert.equal(syncReads, 1, "the mixed decision must stage one complete provider window");
    assert.equal(waiting.status, "assignment_required");
    assert.equal(waiting.assignments_remaining, 1);
    const ownerStatus = await plaidFeedStatus(f.env);
    const mixedConnection = ownerStatus.connections.find((connection) => connection.item_ref === newItem);
    assert.equal(mixedConnection.accounts_needing_owner, 1,
      "owner status must not ask for a second choice on the guarded saved account");
    assert.match(mixedConnection.status_detail, /^1 account needs an owner choice/);
    assert.equal(f.first("SELECT cursor FROM bank_feed_items WHERE item_ref=?", newItem).cursor, null);
    assert.equal(f.first("SELECT COUNT(*) AS n FROM fin_transactions WHERE removed_at IS NULL").n, 1,
      "the held mixed window must not count either staged transaction yet");
    const newAccount = f.first(
      "SELECT account_ref FROM plaid_account_entity_assignments WHERE item_ref=? AND provider_account_id='mixed-new-account'",
      newItem,
    );
    assert.ok(newAccount?.account_ref, "the genuinely new account must enter ordinary owner assignment");
    assert.equal(f.first(
      "SELECT COUNT(*) AS n FROM plaid_account_entity_assignments WHERE item_ref=? AND provider_account_id='mixed-saved-account'",
      newItem,
    ).n, 0, "the saved assignment must remain guarded until reconnect promotion");
    await assignPlaidAccountEntity(f.env, {
      request_id: "mixed-owner-assignment-0001",
      account_ref: newAccount.account_ref,
      entity_slug: "mixed-owner",
    }, { now: stamp });
    const promoted = await syncPlaidItem(f.env, newItem, {
      fetchImpl: async () => { throw new Error("a ready held window must promote without rereading Plaid"); },
      now: "2026-09-24T18:25:00.000Z",
    });
    assert.equal(promoted.status, "partial", JSON.stringify(promoted));
    assert.equal(promoted.refresh_pending, true,
      "resuming a held window must schedule one ordinary refresh after guarded promotion");
    assert.equal(f.first("SELECT cursor FROM bank_feed_items WHERE item_ref=?", newItem).cursor,
      "mixed-final-cursor", "the cursor must advance only with the guarded mixed promotion");
    assert.equal(f.first("SELECT COUNT(*) AS n FROM fin_accounts WHERE source_feed=?", oldFeed).n, 0);
    assert.equal(f.first("SELECT COUNT(*) AS n FROM fin_accounts WHERE source_feed=?", `bank-feed:${newItem}`).n, 2);
    assert.equal(f.first("SELECT COUNT(*) AS n FROM fin_transactions WHERE removed_at IS NULL").n, 2,
      "one retained purchase and one new purchase must remain live, with no double count");
    assert.equal(f.first(
      "SELECT COUNT(*) AS n FROM fin_transactions WHERE txn_uid='plaid:mixed-retained-posted' AND removed_at IS NULL",
    ).n, 1, "the retained pending row must be reused under its posted replacement id");
    assert.equal(f.first(
      "SELECT COUNT(*) AS n FROM fin_transactions WHERE txn_uid='plaid:mixed-new-purchase' AND removed_at IS NULL",
    ).n, 1);
  } finally { f.close(); }
});

test("a post-exchange inventory missing Link metadata enters an owner-visible non-retrying review", async () => {
  const f = await createProductFixture({ env: config });
  const oldItem = "inventory-removed-item";
  const newItem = "inventory-replacement-item";
  const stamp = "2026-09-24T18:30:00.000Z";
  let accountReads = 0;
  let syncReads = 0;
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/item/public_token/exchange") {
      return json({ item_id: newItem, access_token: "inventory-replacement-access" });
    }
    if (path === "/accounts/get") {
      accountReads += 1;
      return json({ accounts: [{
        account_id: "inventory-saved-account", name: "Operating", mask: "1234",
        type: "depository", subtype: "checking",
        balances: { current: "90.00", available: "80.00", iso_currency_code: "USD" },
      }] });
    }
    if (path === "/transactions/sync") {
      syncReads += 1;
      return json({
        added: [], modified: [], removed: [], next_cursor: "must-not-advance", has_more: false,
        transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
      });
    }
    throw new Error(`unexpected Plaid path ${path}`);
  };
  try {
    seedOwnedEntity(f, "inventory-owner", "Inventory Owner");
    savedAccount(f, { item: oldItem, removed: true });
    f.raw("UPDATE fin_accounts SET entity_slug='inventory-owner' WHERE source_feed=?", `bank-feed:${oldItem}`);
    await session(f, "inventory-session-0001", { now: stamp });
    await completePlaidLink(f.env, {
      sessionRef: "inventory-session-0001", publicToken: "synthetic-public",
      institutionRef: "synthetic-bank", institutionLabel: "Synthetic Bank",
      accounts: [
        { id: "inventory-saved-account", name: "Operating", mask: "1234", type: "depository", subtype: "checking" },
        { id: "link-only-new-account", name: "Reserve", mask: "5678", type: "depository", subtype: "savings" },
      ],
      fetchImpl, now: stamp,
    });
    const result = await syncPlaidItem(f.env, newItem, { fetchImpl, now: stamp });
    assert.equal(accountReads, 1, "the disposition must use the authoritative post-exchange inventory");
    assert.equal(syncReads, 0, "an inventory disagreement must hold before reading or counting money");
    assert.equal(result.code, "plaid_reconnect_account_inventory_review_required");
    assert.equal(result.cursor_advanced, false);
    assert.equal(f.first("SELECT state FROM plaid_sync_windows WHERE item_ref=?", newItem).state, "refused");
    assert.deepEqual({ ...f.first(
      "SELECT reason,state FROM plaid_reconciliation WHERE item_ref=?", newItem,
    ) }, { reason: "reconnect_inventory_review", state: "refused" },
    "the held mismatch must not enter an automatic retry loop");
    assert.match(f.first("SELECT status_detail FROM bank_feed_items WHERE item_ref=?", newItem).status_detail,
      /account list changed.*disconnect.*support/i, "the owner must receive a concrete way out");
    assert.equal(f.first("SELECT COUNT(*) AS n FROM fin_transactions WHERE source_feed=?", `bank-feed:${newItem}`).n, 0);
  } finally { f.close(); }
});

test("ambiguous replacement history stays staged for owner review", async () => {
  const f = await createProductFixture({ env: config });
  const oldItem = "ambiguous-removed-item";
  const newItem = "ambiguous-replacement-item";
  const stamp = "2026-09-24T16:00:00.000Z";
  let syncReads = 0;
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/item/public_token/exchange") {
      return json({ item_id: newItem, access_token: "replacement-access" });
    }
    if (path === "/accounts/get") {
      return json({ accounts: [{
        account_id: "replacement-account", name: "Operating", mask: "1234",
        type: "depository", subtype: "checking",
        balances: { current: "100.00", available: "100.00", iso_currency_code: "USD" },
      }] });
    }
    if (path === "/transactions/sync") {
      syncReads += 1;
      return json({
        added: [{
          transaction_id: "replacement-ambiguous", account_id: "replacement-account",
          amount: "10.00", iso_currency_code: "USD", date: "2026-09-20",
          pending: false, name: "Repeated fixture transaction",
        }],
        modified: [], removed: [], next_cursor: "held-cursor", has_more: false,
        transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
      });
    }
    throw new Error(`unexpected Plaid path ${path}`);
  };
  try {
    seedOwnedEntity(f, "fixture-owner", "Fixture Owner");
    savedAccount(f, { item: oldItem, removed: true });
    f.raw("UPDATE fin_accounts SET entity_slug='fixture-owner' WHERE source_feed=?", `bank-feed:${oldItem}`);
    for (const suffix of ["one", "two"]) {
      f.raw(`INSERT INTO fin_transactions
        (tenant_id,txn_uid,account_slug,posted_on,amount_minor,direction,raw_amount_minor,
         raw_sign_convention,currency,description,pending,external_id,provenance,source_locator,
         source_feed,basis_state,recorded_at)
        VALUES ('primary',?,'ledger-ambiguous-removed-item','2026-09-20',1000,'outflow',1000,
                'feed_positive_amount_is_outflow','USD','Repeated fixture transaction',0,?,
                'feed',?,?,'confirmed',?)`,
      `plaid:prior-${suffix}`, `prior-${suffix}`, `plaid/transactions/prior-${suffix}`,
      `bank-feed:${oldItem}`, stamp);
    }
    await session(f, "ambiguous-session-0001", { now: stamp });
    await completePlaidLink(f.env, {
      sessionRef: "ambiguous-session-0001", publicToken: "synthetic-public",
      institutionRef: "synthetic-bank", institutionLabel: "Synthetic Bank",
      accounts: [{
        id: "replacement-account", name: "Operating", mask: "1234",
        type: "depository", subtype: "checking",
      }],
      fetchImpl, now: stamp,
    });
    const result = await syncPlaidItem(f.env, newItem, { fetchImpl, now: stamp });
    assert.equal(syncReads, 1, "the replacement history decision point must read the staged provider window");
    assert.equal(result.code, "plaid_reconnect_transaction_review_required");
    assert.equal(result.cursor_advanced, false);
    assert.equal(f.first(
      "SELECT COUNT(*) AS n FROM plaid_sync_stage_transactions WHERE provider_transaction_id='replacement-ambiguous'",
    ).n, 1, "the ambiguous replacement row must remain staged");
    assert.equal(f.first("SELECT COUNT(*) AS n FROM fin_transactions WHERE removed_at IS NULL").n, 2);
    assert.equal(f.first("SELECT cursor FROM bank_feed_items WHERE item_ref=?", newItem).cursor, null);
    assert.equal(f.first(
      "SELECT source_feed FROM fin_accounts WHERE account_slug='ledger-ambiguous-removed-item'",
    ).source_feed, `bank-feed:${oldItem}`);
    assert.equal(f.first(
      "SELECT COUNT(*) AS n FROM plaid_account_entity_assignments WHERE item_ref=?", newItem,
    ).n, 0, "an ambiguous history window must not copy the retained owner assignment");
  } finally { f.close(); }
});

test("authoritative persistent identity conflict quarantines the replacement Item", async () => {
  const f = await createProductFixture({ env: config });
  const oldItem = "persistent-removed-item";
  const newItem = "persistent-replacement-item";
  const stamp = "2026-09-24T17:00:00.000Z";
  let exchanges = 0;
  let syncReads = 0;
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/item/public_token/exchange") {
      exchanges += 1;
      return json({ item_id: newItem, access_token: "replacement-access" });
    }
    if (path === "/accounts/get") {
      return json({ accounts: [{
        account_id: "replacement-account", persistent_account_id: "stable-account-two",
        name: "Operating", mask: "1234", type: "depository", subtype: "checking",
        balances: { current: "100.00", available: "100.00", iso_currency_code: "USD" },
      }] });
    }
    if (path === "/transactions/sync") {
      syncReads += 1;
      return json({
        added: [], modified: [], removed: [], next_cursor: "held-persistent-cursor", has_more: false,
        transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
      });
    }
    throw new Error(`unexpected Plaid path ${path}`);
  };
  try {
    seedOwnedEntity(f, "fixture-owner", "Fixture Owner");
    savedAccount(f, { item: oldItem, removed: true, persistentAccountId: "stable-account-one" });
    f.raw("UPDATE fin_accounts SET entity_slug='fixture-owner' WHERE source_feed=?", `bank-feed:${oldItem}`);
    await session(f, "persistent-session-0001", { now: stamp });
    await completePlaidLink(f.env, {
      sessionRef: "persistent-session-0001", publicToken: "synthetic-public",
      institutionRef: "synthetic-bank", institutionLabel: "Synthetic Bank",
      accounts: [{
        id: "replacement-account", name: "Operating", mask: "1234",
        type: "depository", subtype: "checking",
      }],
      fetchImpl, now: stamp,
    });
    const result = await syncPlaidItem(f.env, newItem, { fetchImpl, now: stamp });
    assert.equal(exchanges, 1, "the authoritative post-exchange identity decision must be reached");
    assert.equal(syncReads, 1, "the replacement window must be staged before quarantine");
    assert.equal(result.code, "plaid_reconnect_transaction_review_required");
    assert.equal(f.first("SELECT COUNT(*) AS n FROM plaid_sync_stage_accounts WHERE window_ref IS NOT NULL").n, 1);
    assert.equal(f.first("SELECT source_feed FROM fin_accounts WHERE account_slug=?", `ledger-${oldItem}`).source_feed,
      `bank-feed:${oldItem}`);
    assert.equal(f.first(
      "SELECT COUNT(*) AS n FROM plaid_account_entity_assignments WHERE item_ref=?", newItem,
    ).n, 0);
    assert.equal(f.first("SELECT cursor FROM bank_feed_items WHERE item_ref=?", newItem).cursor, null);
  } finally { f.close(); }
});

test("reattach refuses cross-environment and conflicting account identities before exchange", async () => {
  const cases = [
    {
      label: "cross-environment",
      saved: { environment: "production" },
      incoming: { id: "replacement-account", name: "Operating", mask: "1234", type: "depository", subtype: "checking" },
    },
    {
      label: "different-name",
      saved: {},
      incoming: { id: "replacement-account", name: "Reserve", mask: "1234", type: "depository", subtype: "checking" },
    },
    {
      label: "different-type",
      saved: {},
      incoming: { id: "replacement-account", name: "Operating", mask: "1234", type: "credit", subtype: "credit card" },
    },
    {
      label: "different-persistent-id",
      saved: { persistentAccountId: "stable-account-one" },
      incoming: {
        id: "replacement-account", name: "Operating", mask: "1234", type: "depository", subtype: "checking",
        persistentAccountId: "stable-account-two",
      },
    },
  ];
  for (const variant of cases) {
    const f = await createProductFixture({ env: config });
    let exchanges = 0;
    try {
      savedAccount(f, { ...variant.saved, removed: true });
      const before = { ...f.first(
        "SELECT entity_slug,external_ref,source_feed FROM fin_accounts WHERE account_slug='ledger-existing-item'",
      ) };
      await session(f, `identity-${variant.label}-0001`);
      await assert.rejects(completePlaidLink(f.env, {
        sessionRef: `identity-${variant.label}-0001`, publicToken: "synthetic-public",
        institutionRef: "synthetic-bank", accounts: [variant.incoming],
        fetchImpl: async () => {
          exchanges += 1;
          return json({ item_id: "replacement-item", access_token: "replacement-access" });
        },
      }), { code: "plaid_duplicate_connection_review" }, variant.label);
      assert.equal(exchanges, 0, `${variant.label}: refusal must occur before provider exchange`);
      assert.deepEqual({ ...f.first(
        "SELECT entity_slug,external_ref,source_feed FROM fin_accounts WHERE account_slug='ledger-existing-item'",
      ) }, before, `${variant.label}: refusal must not rewrite ledger ownership or feed identity`);
      assert.equal(f.first(
        "SELECT state FROM plaid_link_operations WHERE session_ref=?", `identity-${variant.label}-0001`,
      ).state, "link_ready", `${variant.label}: the pre-exchange decision point must release the claim`);
    } finally { f.close(); }
  }
});

test("a removed connection with only a partial account match still refuses before exchange", async () => {
  const f = await createProductFixture({ env: config });
  let exchanges = 0;
  try {
    savedAccount(f, { removed: true });
    f.raw(`INSERT INTO fin_accounts
      (tenant_id,account_slug,entity_slug,institution,label,account_kind,balance_role,mask,
       feed_mode,external_ref,provenance,source_feed,basis_state,recorded_at)
      VALUES ('primary','ledger-second','primary','Synthetic Bank','Savings','savings','asset','5678',
              'live','account-second','feed','bank-feed:existing-item','confirmed','2026-09-01')`);
    await session(f, "partial-removed-session-0001");
    await assert.rejects(completePlaidLink(f.env, {
      sessionRef: "partial-removed-session-0001",
      publicToken: "synthetic-public",
      institutionRef: "synthetic-bank",
      accounts: [{ id: "replacement-operating", name: "Operating", mask: "1234" }],
      fetchImpl: async () => {
        exchanges += 1;
        return json({ item_id: "replacement-item", access_token: "replacement-access" });
      },
    }), { code: "plaid_duplicate_connection_review" });
    assert.equal(exchanges, 0);
    assert.equal(f.first(
      "SELECT state FROM plaid_link_operations WHERE session_ref='partial-removed-session-0001'",
    ).state, "link_ready", "the duplicate-review decision must release the safe pre-exchange claim");
  } finally { f.close(); }
});

test("repeat bank Link is reviewed before exchange; distinct accounts at that bank remain allowed", async () => {
  const f = await createProductFixture({ env: config });
  let exchanges = 0;
  const fetchImpl = async () => { exchanges++; return json({ item_id: "new-item", access_token: "synthetic-access" }); };
  try {
    savedAccount(f);
    await session(f, "duplicate-session-0001");
    const args = { sessionRef: "duplicate-session-0001", publicToken: "synthetic-public",
      institutionRef: "synthetic-bank", accounts: [{ id: "changed-provider-id", name: "Operating", mask: "1234", type: "depository", subtype: "checking" }], fetchImpl };
    await assert.rejects(completePlaidLink(f.env, args), { code: "plaid_duplicate_connection_review" });
    assert.equal(exchanges, 0);
    assert.equal(f.first("SELECT count(*) AS n FROM bank_feed_items").n, 1);
    assert.equal(f.first("SELECT state FROM plaid_link_operations WHERE session_ref=?", args.sessionRef).state, "link_ready");
    await session(f, "distinct-session-0001");
    const result = await completePlaidLink(f.env, { ...args, sessionRef: "distinct-session-0001", publicToken: "different-public",
      accounts: [{ id: "separate-account", name: "Payroll", mask: "9876", type: "depository", subtype: "checking" }] });
    assert.equal(result.item_ref, "new-item");
    assert.equal(exchanges, 1);
    const replay = await completePlaidLink(f.env, { ...args, sessionRef: "distinct-session-0001", publicToken: "different-public", accounts: null });
    assert.equal(replay.item_ref, "new-item");
    assert.equal(exchanges, 1);
  } finally { f.close(); }
});

test("unknown live inventory does not silently create another bank copy", async () => {
  for (const variant of ["missing-accounts", "missing-institution", "null-mask", "inventory-pending"]) {
    const f = await createProductFixture({ env: config });
    let calls = 0;
    try {
      savedAccount(f);
      if (variant === "inventory-pending") f.raw("DELETE FROM fin_accounts");
      await session(f, "review-session-00001");
      await assert.rejects(completePlaidLink(f.env, {
        sessionRef: "review-session-00001", publicToken: "synthetic-public",
        institutionRef: variant === "missing-institution" ? null : "synthetic-bank",
        accounts: variant === "missing-accounts" ? null : [{ id: "new-account", name: "Operating", mask: variant === "null-mask" ? null : "1234" }],
        fetchImpl: async () => { calls++; return json({ item_id: "new-item", access_token: "synthetic-access" }); },
      }), { code: "plaid_duplicate_connection_review" }, variant);
      assert.equal(calls, 0, variant);
      assert.equal(f.first("SELECT count(*) AS n FROM bank_feed_items").n, 1, variant);
    } finally { f.close(); }
  }
});

test("concurrent new sessions cannot both exchange before prior connection is durable", async () => {
  const f = await createProductFixture({ env: config });
  let finish, started;
  const pending = new Promise((resolve) => { finish = resolve; });
  const arrived = new Promise((resolve) => { started = resolve; });
  let exchanges = 0;
  const fetchImpl = async () => { exchanges++; started(); if (exchanges === 1) await pending; return json({ item_id: "new-item", access_token: "synthetic-access" }); };
  try {
    await session(f, "concurrent-session-01");
    await session(f, "concurrent-session-02");
    const args = { publicToken: "synthetic-public", institutionRef: "synthetic-bank", fetchImpl };
    const first = completePlaidLink(f.env, { ...args, sessionRef: "concurrent-session-01" });
    await arrived;
    try {
      await assert.rejects(completePlaidLink(f.env, { ...args, sessionRef: "concurrent-session-02" }),
        { code: "plaid_connection_in_progress" });
    } finally { finish(); await first; }
    assert.equal(exchanges, 1);
    assert.equal(f.first("SELECT count(*) AS n FROM bank_feed_items").n, 1);
  } finally { f.close(); }
});

test("owner exchange route forwards account review metadata and returns only a safe issue code", async () => {
  const f = await createProductFixture({ env: config });
  let calls = 0;
  try {
    savedAccount(f);
    await session(f, "owner-review-session");
    const url = new URL("https://brain.invalid/api/bank-feed/exchange");
    const response = await handleBankFeed(f.env, new Request(url, {
      method: "POST", headers: { "Content-Type": "application/json", ...await f.ownerHeaders() },
      body: JSON.stringify({ session_ref: "owner-review-session", public_token: "synthetic-public",
        institution_ref: "synthetic-bank", accounts: [{ id: "changed-id", name: "Operating", mask: "1234" }] }),
    }), url, url.pathname, { bankFeedFetchImpl: async () => { calls++; throw new Error("must not reach provider"); } });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "conflict", code: "plaid_duplicate_connection_review" });
    assert.equal(calls, 0);
  } finally { f.close(); }
});

test("definitive invalid handoff releases new-connection custody but an unknown outcome retains it", async () => {
  for (const status of [400, 500]) {
    const f = await createProductFixture({ env: config });
    try {
      await session(f, "rejected-session-0001");
      await session(f, "following-session-001");
      await assert.rejects(completePlaidLink(f.env, {
        sessionRef: "rejected-session-0001", publicToken: "invalid-synthetic", institutionRef: "synthetic-bank",
        fetchImpl: async () => new Response(JSON.stringify({ error_code: status === 400 ? "INVALID_PUBLIC_TOKEN" : "INTERNAL_SERVER_ERROR" }),
          { status, headers: { "Content-Type": "application/json" } }),
      }), { code: status === 400 ? "plaid_link_handoff_rejected" : "PLAID_EXCHANGE_OUTCOME_UNKNOWN" });
      assert.equal(f.first("SELECT state FROM plaid_link_operations WHERE session_ref='rejected-session-0001'").state,
        status === 400 ? "manual_recovery" : "exchange_started");
      if (status === 400) {
        await assert.rejects(session(f, "rejected-session-0001"), { code: "plaid_link_handoff_rejected" });
        await assert.rejects(completePlaidLink(f.env, { sessionRef: "rejected-session-0001", publicToken: "invalid-synthetic" }),
          { code: "plaid_link_handoff_rejected" });
      }
      const next = () => completePlaidLink(f.env, {
        sessionRef: "following-session-001", publicToken: "next-synthetic", institutionRef: "different-bank",
        fetchImpl: async () => json({ item_id: "next-item", access_token: "synthetic-access" }),
      });
      if (status === 400) assert.equal((await next()).item_ref, "next-item");
      else await assert.rejects(next(), { code: "plaid_connection_in_progress" });
    } finally { f.close(); }
  }
});

test("verified update pause refuses bank mutations and webhooks before any D1 or provider access", async () => {
  let reads = 0;
  const env = { ...config, STORAGE: "d1", VECTOR_DRAIN_MODE: "paused-for-upgrade",
    DB: { prepare() { reads++; throw new Error("paused bank write reached D1"); } } };
  for (const path of ["/api/bank-feed/link-token", "/api/bank-feed/exchange", "/api/bank-feed/accounts/assign",
    "/api/bank-feed/sync", "/api/bank-feed/disconnect", "/api/webhooks/plaid"]) {
    const response = await Worker.fetch(new Request(`https://brain.invalid${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }), env, { waitUntil() {} });
    assert.equal(response.status, 503, path);
    assert.equal((await response.json()).code, "BANK_WRITES_PAUSED", path);
  }
  assert.equal(reads, 0);
});
