import test from "node:test";
import assert from "node:assert/strict";
import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";
import {
  completePlaidLink,
  createPlaidLinkToken,
  disconnectPlaidItem,
  syncPlaidItem,
} from "../src/lib/plaid-bank-feed.js";
import { encryptAccessReference, handleBankFeed } from "../src/lib/bank-feed.js";
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

test("disconnect then reconnect resumes the same ledger accounts without duplicate transactions", async () => {
  const f = await createProductFixture({ env: config });
  const oldItem = "removed-item";
  const newItem = "replacement-item";
  const oldFeed = `bank-feed:${oldItem}`;
  const newFeed = `bank-feed:${newItem}`;
  const accountSlug = "ledger-removed-item";
  const stamp = "2026-09-24T15:00:00.000Z";
  const calls = [];
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
      assert.equal(Object.hasOwn(body, "cursor"), false, "a reconnect must start with a new cursor");
      return json({
        added: [
          {
            transaction_id: "replacement-transaction",
            account_id: "replacement-account",
            amount: "10.00",
            iso_currency_code: "USD",
            date: "2026-09-20",
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
              'feed_positive_amount_is_outflow','USD','Existing fixture transaction',0,
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
      "SELECT COUNT(*) AS n FROM fin_transactions WHERE account_slug=? AND source_feed=?",
      accountSlug, newFeed,
    ).n, 2);
    assert.equal(f.first("SELECT COUNT(*) AS n FROM fin_balance_snapshots WHERE account_slug=?", accountSlug).n, 1);
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
