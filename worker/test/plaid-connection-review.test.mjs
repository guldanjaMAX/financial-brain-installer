import test from "node:test";
import assert from "node:assert/strict";
import { createProductFixture } from "./product-contract-fixture.mjs";
import { createPlaidLinkToken, completePlaidLink } from "../src/lib/plaid-bank-feed.js";
import { bankFeedOwnerErrorMessage, handleBankFeed } from "../src/lib/bank-feed.js";
import Worker from "../src/index.js";

const config = {
  BANK_FEED_PROVIDER: "plaid", BANK_FEED_ENV: "sandbox",
  BANK_FEED_CLIENT_ID: "synthetic-client", BANK_FEED_SECRET: "synthetic-secret",
  BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
};
const json = (data) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
const NOW = "2026-09-03T12:00:00.000Z";
function savedAccount(f, { item = "existing-item", institution = "synthetic-bank", name = "Operating", mask = "1234", removed = false } = {}) {
  f.raw(`INSERT INTO bank_feed_items (tenant_id,item_ref,institution_ref,access_ciphertext,access_iv,key_version,environment,status,connected_at,removed_at)
    VALUES ('primary',?,?, 'c2VhbGVkY2lwaGVydGV4dA==','AAAAAAAAAAAAAAAA',2,'sandbox','connected','2026-09-01',?)`, item, institution, removed ? "2026-09-02" : null);
  f.raw(`INSERT INTO fin_accounts (tenant_id,account_slug,entity_slug,institution,label,account_kind,balance_role,mask,feed_mode,external_ref,provenance,source_feed,basis_state,recorded_at)
    VALUES ('primary',?,'primary','Synthetic Bank',?,'checking','asset',?,'live',?,'feed',?,'confirmed','2026-09-01')`,
  `ledger-${item}`, name, mask, `account-${item}`, `bank-feed:${item}`);
}
async function session(f, ref, extra = {}) {
  return createPlaidLinkToken(f.env, { url: "https://brain.invalid/app/connect/bank", sessionRef: ref,
    fetchImpl: async () => json({ link_token: "link-synthetic", expiration: "2099-01-01T00:00:00Z" }), now: NOW, ...extra });
}

function stageAbandonedWindow(f, { tenant = "primary", item = "existing-item", window = "abandoned-window" } = {}) {
  f.raw(`INSERT INTO plaid_sync_windows (tenant_id,item_ref,window_ref,state,started_at,updated_at)
    VALUES (?,?,?,'ready',?,?)`, tenant, item, window, NOW, NOW);
  f.raw(`INSERT INTO plaid_sync_stage_accounts
    (tenant_id,window_ref,provider_account_id,account_slug,name,mask,account_type,account_kind,balance_role,currency,provenance_json)
    VALUES (?,?,'old-account','staged-account','Operating','1234','depository','checking','asset','USD','{}')`, tenant, window);
  f.raw(`INSERT INTO plaid_sync_stage_transactions
    (tenant_id,window_ref,page_index,operation,provider_transaction_id,provider_account_id)
    VALUES (?,?,0,'added','old-transaction','old-account')`, tenant, window);
}

function reconnectArgs(fetchImpl, extra = {}) {
  return { sessionRef: "reconnect-session-001", publicToken: "synthetic-public",
    institutionRef: "synthetic-bank", accounts: [{ id: "old-account", name: "Operating", mask: "1234" }],
    fetchImpl, now: NOW, ...extra };
}

test("a removed bank with no promoted history reconnects and clears only its abandoned staging", async () => {
  for (const staged of [false, true]) {
    const f = await createProductFixture({ env: config });
    let exchanges = 0;
    try {
      savedAccount(f, { removed: true });
      f.raw("DELETE FROM fin_accounts");
      if (staged) stageAbandonedWindow(f);
      stageAbandonedWindow(f, { item: "unrelated-item", window: "unrelated-window" });
      stageAbandonedWindow(f, { tenant: "other-tenant" });
      await session(f, "reconnect-session-001");
      const result = await completePlaidLink(f.env, reconnectArgs(async () => {
        exchanges++;
        return json({ item_id: "replacement-item", access_token: "synthetic-access" });
      }));
      assert.equal(result.item_ref, "replacement-item");
      assert.equal(exchanges, 1, "the real exchange decision was reached");
      assert.ok(f.seen.sql.some(sql => sql.includes("FROM bank_feed_items") && sql.includes("institution_ref")));
      for (const table of ["plaid_sync_windows", "plaid_sync_stage_accounts", "plaid_sync_stage_transactions"]) {
        assert.equal(f.first(`SELECT count(*) AS n FROM ${table} WHERE tenant_id='primary' AND window_ref='abandoned-window'`).n, 0);
        assert.equal(f.first(`SELECT count(*) AS n FROM ${table} WHERE tenant_id='primary' AND window_ref='unrelated-window'`).n, 1);
        assert.equal(f.first(`SELECT count(*) AS n FROM ${table} WHERE tenant_id='other-tenant'`).n, 1);
      }
      assert.equal(f.first("SELECT count(*) AS n FROM fin_accounts").n, 0);
      assert.equal(f.first("SELECT count(*) AS n FROM fin_transactions").n, 0);
      assert.equal(f.first("SELECT removed_at FROM bank_feed_items WHERE item_ref='existing-item'").removed_at, "2026-09-02");
    } finally { f.close(); }
  }
});

test("removed history needs support before exchange, even with changed account metadata", async () => {
  for (const history of ["account", "superseded-account", "transaction", "removed-transaction", "balance", "progress", "cursor"]) {
    const f = await createProductFixture({ env: config });
    let exchanges = 0;
    try {
      savedAccount(f, { removed: true });
      if (history === "superseded-account") f.raw("UPDATE fin_accounts SET superseded_by_id=999");
      else if (history !== "account") f.raw("DELETE FROM fin_accounts");
      if (history.includes("transaction")) {
        f.raw(`INSERT INTO fin_transactions
          (txn_uid,account_slug,amount_minor,direction,provenance,source_feed,basis_state,recorded_at,removed_at,removal_reason)
          VALUES ('saved-transaction','ledger-existing-item',100,'outflow','feed','bank-feed:existing-item','confirmed',?,?,?)`,
        NOW, history === "removed-transaction" ? NOW : null, history === "removed-transaction" ? "provider withdrew" : null);
      } else if (history === "balance") {
        f.raw(`INSERT INTO fin_balance_snapshots
          (account_slug,as_of_date,current_minor,provenance,source_feed,basis_state,recorded_at)
          VALUES ('ledger-existing-item','2026-09-01',100,'feed','bank-feed:existing-item','confirmed',?)`, NOW);
      } else if (history === "progress") {
        f.raw(`INSERT INTO bank_feed_backfill (tenant_id,item_ref,requested_days,state,pages_done,queued_at)
          VALUES ('primary','existing-item',730,'running',1,?)`, NOW);
      } else if (history === "cursor") f.raw("UPDATE bank_feed_items SET cursor='saved-cursor'");
      stageAbandonedWindow(f);
      const before = f.rows("SELECT * FROM fin_accounts");
      await session(f, "reconnect-session-001");
      const fetchImpl = async () => { exchanges++; return json({ item_id: "control-item", access_token: "synthetic-access" }); };
      await assert.rejects(completePlaidLink(f.env, reconnectArgs(fetchImpl, {
        accounts: [{ id: "changed-id", name: "Different label", mask: "9876" }],
      })), { code: "plaid_reconnect_support_required" }, history);
      assert.ok(f.seen.sql.some(sql => sql.includes("FROM bank_feed_items") && sql.includes("institution_ref")), "inventory review was reached");
      assert.equal(exchanges, 0, history);
      assert.deepEqual(f.rows("SELECT * FROM fin_accounts"), before);
      assert.equal(f.first("SELECT count(*) AS n FROM plaid_sync_stage_accounts").n, 1, "refusal preserves staging");
      assert.equal(f.first("SELECT state FROM plaid_link_operations WHERE session_ref='reconnect-session-001'").state, "link_ready");
      // The same claim can still connect a genuinely different institution.
      const control = await completePlaidLink(f.env, reconnectArgs(fetchImpl, { institutionRef: "different-bank" }));
      assert.equal(control.item_ref, "control-item");
      assert.equal(exchanges, 1);
    } finally { f.close(); }
  }
});

test("removed-history owner route names support and never an unavailable Repair button", async () => {
  const f = await createProductFixture({ env: config });
  let exchanges = 0;
  try {
    savedAccount(f, { removed: true });
    await session(f, "reconnect-session-001");
    const url = new URL("https://brain.invalid/api/bank-feed/exchange");
    const response = await handleBankFeed(f.env, new Request(url, {
      method: "POST", headers: { "Content-Type": "application/json", ...await f.ownerHeaders() },
      body: JSON.stringify({ session_ref: "reconnect-session-001", public_token: "synthetic-public",
        institution_ref: "synthetic-bank", accounts: [{ id: "old-account", name: "Operating", mask: "1234" }] }),
    }), url, url.pathname, { bankFeedFetchImpl: async () => { exchanges++; throw new Error("unexpected provider call"); } });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.deepEqual(body, { error: "conflict", code: "plaid_reconnect_support_required" });
    assert.equal(exchanges, 0);
    assert.ok(f.seen.sql.some(sql => sql.includes("FROM bank_feed_items") && sql.includes("institution_ref")));
    const message = bankFeedOwnerErrorMessage(body, response.status);
    assert.match(message, /disconnected.*saved history/i);
    assert.match(message, /support/i);
    assert.doesNotMatch(message, /repair|please try again/i);
    assert.doesNotMatch(bankFeedOwnerErrorMessage({ code: "plaid_duplicate_connection_review" }, 409), /use Repair connection/);
    const control = await handleBankFeed(f.env, new Request(url, {
      method: "POST", headers: { "Content-Type": "application/json", ...await f.ownerHeaders() },
      body: JSON.stringify({ session_ref: "reconnect-session-001", public_token: "synthetic-public",
        institution_ref: "different-bank", accounts: [{ id: "different-account", name: "Operating", mask: "9876" }] }),
    }), url, url.pathname, { bankFeedFetchImpl: async () => {
      exchanges++;
      return json({ item_id: "control-item", access_token: "synthetic-access" });
    } });
    assert.equal(control.status, 200);
    assert.equal((await control.json()).item_ref, "control-item");
    assert.equal(exchanges, 1, "the real owner route accepts a different institution");
  } finally { f.close(); }
});

test("an active duplicate still wins over an abandoned removed Item and leaves its staging intact", async () => {
  for (const status of ["connected", "error", "permission_revoked"]) {
    const f = await createProductFixture({ env: config });
    let exchanges = 0;
    try {
      savedAccount(f, { removed: true });
      f.raw("DELETE FROM fin_accounts");
      stageAbandonedWindow(f);
      savedAccount(f, { item: "active-item" });
      f.raw("UPDATE bank_feed_items SET status=?,status_detail='Synthetic connection state' WHERE item_ref='active-item'", status);
      await session(f, "reconnect-session-001");
      const fetchImpl = async () => { exchanges++; return json({ item_id: "control-item", access_token: "synthetic-access" }); };
      await assert.rejects(completePlaidLink(f.env, reconnectArgs(fetchImpl)), { code: "plaid_duplicate_connection_review" });
      assert.ok(f.seen.binds.some(values => values.includes("bank-feed:active-item")), "the active account inventory was reviewed");
      assert.equal(exchanges, 0);
      assert.equal(f.first("SELECT count(*) AS n FROM plaid_sync_stage_transactions").n, 1);
      assert.equal(f.first("SELECT count(*) AS n FROM fin_accounts").n, 1);
      const control = await completePlaidLink(f.env, reconnectArgs(fetchImpl, {
        accounts: [{ id: "separate-account", name: "Separate account", mask: "9876" }],
      }));
      assert.equal(control.item_ref, "control-item");
      assert.equal(exchanges, 1);
      assert.equal(f.first("SELECT count(*) AS n FROM plaid_sync_stage_transactions").n, 0);
    } finally { f.close(); }
  }
});

test("cleanup fails closed on unreadable proof, partial deletion or a change after review", async () => {
  for (const fault of ["proof-read", "cleanup-write", "history-race", "reactivation-race"]) {
    const f = await createProductFixture({ env: config });
    let exchanges = 0, guardBatches = 0;
    try {
      savedAccount(f, { removed: true });
      f.raw("DELETE FROM fin_accounts");
      stageAbandonedWindow(f);
      await session(f, "reconnect-session-001");
      if (fault === "proof-read") f.control.failOn = /AS never_promoted/;
      if (fault === "cleanup-write") f.control.failOn = /DELETE FROM plaid_sync_stage_accounts/;
      const batch = f.env.DB.batch.bind(f.env.DB);
      f.env.DB.batch = async (statements) => {
        if (statements.some(statement => statement.sql.includes("reconnect_cleanup_guard"))) {
          guardBatches++;
          if (fault === "history-race") f.raw("UPDATE bank_feed_items SET cursor='concurrent-progress'");
          if (fault === "reactivation-race") f.raw("UPDATE bank_feed_items SET removed_at=NULL");
        }
        return batch(statements);
      };
      const fetchImpl = async () => { exchanges++; return json({ item_id: "control-item", access_token: "synthetic-access" }); };
      await assert.rejects(completePlaidLink(f.env, reconnectArgs(fetchImpl)),
        /fixture database unavailable|malformed JSON/, fault);
      assert.ok(f.seen.sql.some(sql => sql.includes("AS never_promoted")), "the removed-history proof was reached");
      assert.equal(guardBatches, fault === "proof-read" ? 0 : 1);
      assert.equal(exchanges, 0);
      for (const table of ["plaid_sync_windows", "plaid_sync_stage_accounts", "plaid_sync_stage_transactions"]) {
        assert.equal(f.first(`SELECT count(*) AS n FROM ${table}`).n, 1, `${fault}: cleanup is atomic`);
      }
      assert.equal(f.first("SELECT public_token_fingerprint FROM plaid_link_operations WHERE session_ref='reconnect-session-001'").public_token_fingerprint, null);
      f.control.failOn = null;
      f.env.DB.batch = batch;
      f.raw("UPDATE bank_feed_items SET cursor=NULL,removed_at='2026-09-02'");
      assert.equal((await completePlaidLink(f.env, reconnectArgs(fetchImpl))).item_ref, "control-item");
      assert.equal(exchanges, 1, "the same session succeeds after the injected fault is cleared");
    } finally { f.close(); }
  }
});

test("an active duplicate keeps its original refusal even beside removed ledger history", async () => {
  const f = await createProductFixture({ env: config });
  let exchanges = 0;
  try {
    savedAccount(f, { removed: true });
    savedAccount(f, { item: "active-item" });
    await session(f, "reconnect-session-001");
    const fetchImpl = async () => { exchanges++; return json({ item_id: "control-item", access_token: "synthetic-access" }); };
    await assert.rejects(completePlaidLink(f.env, reconnectArgs(fetchImpl)), { code: "plaid_duplicate_connection_review" });
    assert.ok(f.seen.binds.some(values => values.includes("bank-feed:active-item")), "the active inventory decision was reached");
    assert.equal(exchanges, 0);
    assert.equal(f.first("SELECT count(*) AS n FROM fin_accounts").n, 2);
    assert.equal((await completePlaidLink(f.env, reconnectArgs(fetchImpl, { institutionRef: "different-bank" }))).item_ref, "control-item");
    assert.equal(exchanges, 1);
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

test("unknown inventory and retained disconnected history do not silently create another bank copy", async () => {
  for (const variant of ["missing-accounts", "missing-institution", "null-mask", "removed-history", "inventory-pending"]) {
    const f = await createProductFixture({ env: config });
    let calls = 0;
    try {
      savedAccount(f, { removed: variant === "removed-history" });
      if (variant === "inventory-pending") f.raw("DELETE FROM fin_accounts");
      await session(f, "review-session-00001");
      await assert.rejects(completePlaidLink(f.env, {
        sessionRef: "review-session-00001", publicToken: "synthetic-public",
        institutionRef: variant === "missing-institution" ? null : "synthetic-bank",
        accounts: variant === "missing-accounts" ? null : [{ id: "new-account", name: "Operating", mask: variant === "null-mask" ? null : "1234" }],
        fetchImpl: async () => { calls++; return json({ item_id: "new-item", access_token: "synthetic-access" }); },
      }), { code: variant === "removed-history" ? "plaid_reconnect_support_required" : "plaid_duplicate_connection_review" }, variant);
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
