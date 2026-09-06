import test from "node:test";
import assert from "node:assert/strict";
import { createProductFixture } from "./product-contract-fixture.mjs";
import { createPlaidLinkToken, completePlaidLink } from "../src/lib/plaid-bank-feed.js";
import { handleBankFeed } from "../src/lib/bank-feed.js";
import Worker from "../src/index.js";

const config = {
  BANK_FEED_PROVIDER: "plaid", BANK_FEED_ENV: "sandbox",
  BANK_FEED_CLIENT_ID: "synthetic-client", BANK_FEED_SECRET: "synthetic-secret",
  BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
};
const json = (data) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
function savedAccount(f, { item = "existing-item", institution = "synthetic-bank", name = "Operating", mask = "1234", removed = false } = {}) {
  f.raw(`INSERT INTO bank_feed_items (tenant_id,item_ref,institution_ref,access_ciphertext,access_iv,key_version,environment,status,connected_at,removed_at)
    VALUES ('primary',?,?, 'c2VhbGVkY2lwaGVydGV4dA==','AAAAAAAAAAAAAAAA',2,'sandbox','connected','2026-09-01',?)`, item, institution, removed ? "2026-09-02" : null);
  f.raw(`INSERT INTO fin_accounts (tenant_id,account_slug,entity_slug,institution,label,account_kind,balance_role,mask,feed_mode,external_ref,provenance,source_feed,basis_state,recorded_at)
    VALUES ('primary',?,'primary','Synthetic Bank',?,'checking','asset',?,'live',?,'feed',?,'confirmed','2026-09-01')`,
  `ledger-${item}`, name, mask, `account-${item}`, `bank-feed:${item}`);
}
async function session(f, ref, extra = {}) {
  return createPlaidLinkToken(f.env, { url: "https://brain.invalid/app/connect/bank", sessionRef: ref,
    fetchImpl: async () => json({ link_token: "link-synthetic", expiration: "2099-01-01T00:00:00Z" }), ...extra });
}

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
