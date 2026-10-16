import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";
import { bankFeedConfig, connectPageHtml, handleBankFeed } from "../src/lib/bank-feed.js";
import { createPlaidLinkToken, completePlaidLink, syncPlaidItem, runPlaidFeedSlice, plaidFeedStatus } from "../src/lib/plaid-bank-feed.js";
import { discoverPlaidAccountAssignments } from "../src/lib/plaid-account-entities.js";
import { PLAID_HISTORY_STATE } from "../src/lib/plaid-protocol.js";

globalThis.fetch = async () => { throw new Error("Unexpected external fetch"); };
const NOW = "2026-10-01T00:00:00.000Z";
const CONFIG = {
  BANK_FEED_PROVIDER: "plaid", BANK_FEED_ENV: "sandbox",
  BANK_FEED_CLIENT_ID: "synthetic-client", BANK_FEED_SECRET: "synthetic-secret",
  BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`, BANK_FEED_RECONCILE_MINUTES: "360",
};
const json = value => Response.json(value);
const emptyPage = history => ({ added: [], modified: [], removed: [], next_cursor: "", has_more: false,
  transactions_update_status: history });
async function link(f, ref, fetchImpl) {
  return createPlaidLinkToken(f.env, { url: "https://brain.invalid/app/connect/bank", sessionRef: ref, now: NOW, fetchImpl });
}
function provider() {
  const calls = [];
  const fetchImpl = async url => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === "/link/token/create") return json({ link_token: "synthetic-link", expiration: "2099-01-01T00:00:00Z" });
    assert.equal(path, "/item/public_token/exchange");
    return json({ item_id: `item-${calls.filter(p => p === path).length}`, access_token: "synthetic-access" });
  };
  return { calls, fetchImpl };
}

class Node {
  constructor() { this.children = []; this.textContent = ""; this.disabled = false; this.value = ""; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
}
// Execute the shipped inline script and its actual owner mutation routes. Only
// unrelated read views and the provider SDK are fakes; storage survives reloads.
async function tab(f, fetchImpl, storage = new Map()) {
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const headers = await f.ownerHeaders();
  const requests = [], responses = [], opened = [];
  const context = vm.createContext({
    document: { getElementById: node, createElement: () => new Node() },
    crypto, URLSearchParams, location: { search: "", href: "https://brain.invalid/app/connect/bank" },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    Plaid: { create: config => ({ open: () => opened.push(config) }) },
    setTimeout: () => 0,
    fetch: async (path, init = {}) => {
      if (!["/api/bank-feed/link-token", "/api/bank-feed/exchange"].includes(path)) return json({ entities: [], accounts: [], connections: [], summary: {} });
      requests.push({ path, body: JSON.parse(init.body) });
      const url = new URL(path, "https://brain.invalid");
      const response = await handleBankFeed(f.env, new Request(url, { ...init, headers: { ...init.headers, ...headers } }), url, path, { bankFeedFetchImpl: fetchImpl });
      responses.push(await response.clone().json());
      return response;
    },
  });
  context.window = context;
  const { html } = connectPageHtml(bankFeedConfig(f.env));
  const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(Boolean);
  assert.equal(scripts.length, 1);
  vm.runInContext(scripts[0], context);
  return { storage, requests, responses, nodes, opened, connect: () => node("start").onclick(),
    finish: (institution = "synthetic-bank") => opened.at(-1).onSuccess("synthetic-public-next", {
      institution: { institution_id: institution, name: "Synthetic Bank" },
      accounts: [{ id: "incoming-account", name: "Operating", mask: "1234" }],
    }) };
}

test("clean tab control completes the actual owner exchange route", async () => {
  const f = await createProductFixture({ env: CONFIG });
  const p = provider();
  try {
    const page = await tab(f, p.fetchImpl);
    await page.connect();
    assert.equal(page.opened.length, 1);
    await page.finish();
    assert.equal(page.responses.at(-1).item_ref, "item-1");
    assert.match(page.nodes.get("status").textContent, /^Connected\./);
    assert.equal(p.calls.filter(path => path === "/item/public_token/exchange").length, 1);
  } finally { f.close(); }
});

for (const arm of ["duplicate", "review-error", "restored-stale"]) test(`same-tab Link recovery: ${arm}`, async () => {
  const f = await createProductFixture({ env: CONFIG });
  const p = provider();
  try {
    await link(f, "existing-session-0001", p.fetchImpl);
    await completePlaidLink(f.env, { sessionRef: "existing-session-0001", publicToken: "synthetic-public", institutionRef: "synthetic-bank", now: NOW, fetchImpl: p.fetchImpl });
    f.raw(`INSERT INTO fin_accounts (tenant_id,account_slug,entity_slug,institution,label,account_kind,balance_role,mask,feed_mode,external_ref,provenance,source_feed,basis_state,recorded_at)
      VALUES ('primary','existing-account','primary','Synthetic Bank','Operating','checking','asset','1234','live','existing-id','feed','bank-feed:item-1','confirmed',?)`, NOW);
    const storage = new Map();
    if (arm === "restored-stale") {
      const saved = await link(f, "restored-session-0001", p.fetchImpl);
      f.raw("UPDATE plaid_link_operations SET public_token_fingerprint='stale-fingerprint' WHERE session_ref=?", saved.session_ref);
      storage.set("bank_link_request_id:connect:", saved.session_ref);
      storage.set("bank_link_session", JSON.stringify(saved));
    }
    const page = await tab(f, p.fetchImpl, storage);
    await page.connect();
    const first = page.requests[0].body.request_id;
    assert.equal(page.opened.length, 1);
    const before = p.calls.length;
    if (arm === "review-error") f.control.failOn = /SELECT item_ref,institution_ref FROM bank_feed_items/;
    await page.finish();
    f.control.failOn = null;
    assert.equal(page.requests.at(-1).path, "/api/bank-feed/exchange", "the failing completion reached the real route");
    assert.equal(p.calls.length, before, "refusal must precede provider exchange");
    if (arm === "restored-stale") {
      assert.equal(page.responses.at(-1).code, "LINK_SESSION_STALE");
      assert.match(page.nodes.get("status").textContent, /start.*again/i);
    } else if (arm === "duplicate") {
      assert.equal(page.responses.at(-1).code, "plaid_duplicate_connection_review");
      assert.match(page.nodes.get("status").textContent, /already be connected/);
    } else {
      assert.ok(f.seen.sql.some(sql => /SELECT item_ref,institution_ref/.test(sql)), "database review failure was reached");
      assert.match(page.nodes.get("status").className, /err/);
    }
    assert.equal(storage.has("bank_link_request_id:connect:"), false);
    assert.equal(storage.has("bank_link_session"), false);
    assert.equal(f.first("SELECT public_token_fingerprint FROM plaid_link_operations WHERE session_ref=?", first).public_token_fingerprint, null);
    await page.connect();
    assert.notEqual(page.requests.at(-1).body.request_id, first, "next Connect gets a fresh session in the same tab");
    await page.finish("separate-bank");
    assert.equal(page.responses.at(-1).item_ref, "item-2");
    assert.match(page.nodes.get("status").textContent, /^Connected\./);
    assert.equal(p.calls.filter(path => path === "/item/public_token/exchange").length, 2);
  } finally { f.close(); }
});

test("review refusal clears its server fingerprint even when the client did not receive the response", async () => {
  const f = await createProductFixture({ env: CONFIG });
  const p = provider();
  try {
    await link(f, "review-retry-session", p.fetchImpl);
    f.control.failOn = /SELECT item_ref,institution_ref FROM bank_feed_items/;
    await assert.rejects(completePlaidLink(f.env, { sessionRef: "review-retry-session", publicToken: "synthetic-first", now: NOW, fetchImpl: p.fetchImpl }), /fixture database unavailable/);
    assert.ok(f.seen.sql.some(sql => /SELECT item_ref,institution_ref/.test(sql)));
    f.control.failOn = null;
    assert.equal(f.first("SELECT public_token_fingerprint FROM plaid_link_operations WHERE session_ref='review-retry-session'").public_token_fingerprint, null);
    const done = await completePlaidLink(f.env, { sessionRef: "review-retry-session", publicToken: "synthetic-second", now: NOW, fetchImpl: p.fetchImpl });
    assert.equal(done.item_ref, "item-1");
  } finally { f.close(); }
});

test("a mismatched completion cannot clear an in-flight or completed exchange binding", async () => {
  const f = await createProductFixture({ env: CONFIG });
  const p = provider();
  let release, arrived;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { arrived = resolve; });
  try {
    await link(f, "inflight-session-0001", p.fetchImpl);
    const completing = completePlaidLink(f.env, { sessionRef: "inflight-session-0001", publicToken: "synthetic-first", now: NOW,
      fetchImpl: async url => { arrived(); await held; return p.fetchImpl(url); } });
    await started;
    const fingerprint = () => f.first("SELECT public_token_fingerprint FROM plaid_link_operations WHERE session_ref='inflight-session-0001'").public_token_fingerprint;
    const heldFingerprint = fingerprint();
    assert.ok(heldFingerprint);
    try {
      await assert.rejects(completePlaidLink(f.env, { sessionRef: "inflight-session-0001", publicToken: "synthetic-other", now: NOW, fetchImpl: p.fetchImpl }), { code: "PLAID_EXCHANGE_OUTCOME_UNKNOWN" });
      assert.equal(fingerprint(), heldFingerprint);
      await link(f, "inflight-following-01", p.fetchImpl);
      await assert.rejects(completePlaidLink(f.env, { sessionRef: "inflight-following-01", publicToken: "synthetic-other", now: NOW, fetchImpl: p.fetchImpl }), { code: "plaid_connection_in_progress" });
    } finally { release(); await completing; }
    await assert.rejects(completePlaidLink(f.env, { sessionRef: "inflight-session-0001", publicToken: "synthetic-other", now: NOW, fetchImpl: p.fetchImpl }), { code: "LINK_SESSION_STALE" });
    assert.equal(fingerprint(), heldFingerprint);
    assert.equal((await completePlaidLink(f.env, { sessionRef: "inflight-session-0001", publicToken: "synthetic-first", now: NOW, fetchImpl: p.fetchImpl })).item_ref, "item-1");
    assert.equal(p.calls.filter(path => path === "/item/public_token/exchange").length, 1);
  } finally { f.close(); }
});

async function syncFixture(history) {
  const f = await createProductFixture({ env: CONFIG });
  const p = provider();
  await link(f, "sync-recovery-session", p.fetchImpl);
  await completePlaidLink(f.env, { sessionRef: "sync-recovery-session", publicToken: "synthetic-public", now: NOW, fetchImpl: p.fetchImpl });
  seedOwnedEntity(f, "synthetic-owner", "Synthetic Owner");
  await discoverPlaidAccountAssignments(f.env, { itemRef: "item-1", accounts: [{ providerAccountId: "synthetic-account" }], at: NOW });
  f.raw("UPDATE plaid_account_entity_assignments SET entity_slug='synthetic-owner',assigned_at=?", NOW);
  f.raw("UPDATE bank_feed_backfill SET provider_history_state=?", history);
  const state = { page: emptyPage(history), syncs: 0 };
  const fetchImpl = async (url, init) => {
    if (new URL(url).pathname === "/accounts/get") return json({ accounts: [{ account_id: "synthetic-account", name: "Checking", mask: "1234", type: "depository", subtype: "checking", balances: { current: "10.00", iso_currency_code: "USD" } }] });
    assert.equal(new URL(url).pathname, "/transactions/sync");
    state.syncs++;
    state.lastCursor = JSON.parse(init.body).cursor;
    return json(state.page);
  };
  const queue = () => f.first("SELECT * FROM plaid_reconciliation WHERE item_ref='item-1'");
  const run = now => runPlaidFeedSlice(f.env, { now, fetchImpl });
  return { f, state, queue, run, fetchImpl };
}

for (const history of Object.values(PLAID_HISTORY_STATE)) test(`empty initial cursor remains partial and recovers automatically: ${history}`, async () => {
  const { f, state, queue, run, fetchImpl } = await syncFixture(history);
  try {
    // Produce the exact durable retryable shape through the failing sync path.
    state.page.next_cursor = null;
    assert.equal((await syncPlaidItem(f.env, "item-1", { now: NOW, fetchImpl })).code, "INVALID_SYNC_PAGE");
    assert.equal(state.syncs, 1);
    assert.equal(queue().state, "retryable");
    state.page = emptyPage(history);
    const due = queue().due_at;
    const recovered = await run(due);
    assert.equal(recovered.ran, 1);
    assert.equal(state.syncs, 2);
    assert.equal(state.lastCursor, undefined);
    assert.equal(recovered.items[0].status, "partial");
    assert.equal(recovered.items[0].partial, true);
    const item = f.first("SELECT cursor,cursor_updated_at,status,last_error_at FROM bank_feed_items WHERE item_ref='item-1'");
    assert.equal(item.cursor, null, "empty is not durable cursor progress");
    assert.equal(item.cursor_updated_at, null);
    assert.equal(item.status, "connected");
    assert.equal(item.last_error_at, null);
    const backfill = f.first("SELECT state,finished_at,provider_history_state FROM bank_feed_backfill WHERE item_ref='item-1'");
    assert.equal(backfill.state, "running");
    assert.equal(backfill.finished_at, null);
    assert.equal(backfill.provider_history_state, history);
    assert.equal((await plaidFeedStatus(f.env)).connections[0].history.partial, true);
    assert.equal(queue().state, "pending");
    assert.equal(queue().last_error_code, null);
    assert.equal(queue().attempts, 0);
    assert.equal(Date.parse(queue().due_at) - Date.parse(due), 360 * 60_000);
    const next = queue().due_at;
    assert.equal((await run(new Date(Date.parse(next) - 1).toISOString())).ran, 0);
    assert.equal(state.syncs, 2, "normal poll is not due early");
    state.page = { ...emptyPage(PLAID_HISTORY_STATE.HISTORICAL), next_cursor: "real-progress" };
    const completed = await run(next);
    assert.equal(completed.items[0].status, "complete", "positive control: actual cursor can establish history completion");
    assert.equal(state.syncs, 3);
    assert.equal(f.first("SELECT cursor FROM bank_feed_items").cursor, "real-progress");
  } finally { f.close(); }
});

test("a staged empty historical page stays partial when owner assignment later permits promotion", async () => {
  const { f, state, fetchImpl } = await syncFixture(PLAID_HISTORY_STATE.HISTORICAL);
  try {
    f.raw("UPDATE plaid_account_entity_assignments SET entity_slug=NULL,assigned_at=NULL");
    const blocked = await syncPlaidItem(f.env, "item-1", { now: NOW, fetchImpl });
    assert.equal(blocked.status, "assignment_required");
    assert.equal(state.syncs, 1);
    assert.equal(f.first("SELECT state FROM plaid_sync_windows").state, "ready");
    f.raw("UPDATE plaid_account_entity_assignments SET entity_slug='synthetic-owner',assigned_at=?", NOW);
    const promoted = await syncPlaidItem(f.env, "item-1", { now: "2026-10-01T00:01:00.000Z", fetchImpl });
    assert.equal(promoted.resumed_promotion, true);
    assert.equal(promoted.status, "partial");
    assert.equal(state.syncs, 1, "ready promotion uses the already-fetched snapshot");
    assert.equal(f.first("SELECT cursor FROM bank_feed_items").cursor, null);
    assert.equal(f.first("SELECT state FROM bank_feed_backfill").state, "running");
  } finally { f.close(); }
});

test("identical invalid pages back off to a daily cap, remain visible, and reset after success", async () => {
  const { f, state, queue, run } = await syncFixture(PLAID_HISTORY_STATE.HISTORICAL);
  try {
    state.page.next_cursor = null;
    let at = NOW;
    for (const [index, minutes] of [5, 10, 20, 40, 80, 160, 320, 640, 1280, 1440, 1440].entries()) {
      const result = await run(at);
      assert.equal(result.ran, 1);
      assert.equal(result.items[0].code, "INVALID_SYNC_PAGE");
      assert.equal(state.syncs, index + 1);
      assert.equal(queue().attempts, index + 1);
      assert.equal(Date.parse(queue().due_at) - Date.parse(at), minutes * 60_000);
      const attention = (await plaidFeedStatus(f.env)).needs_attention;
      assert.equal(attention.length, 1);
      assert.match(attention[0].detail, /INVALID_SYNC_PAGE/);
      at = queue().due_at;
      assert.equal((await run(new Date(Date.parse(at) - 1).toISOString())).ran, 0);
      assert.equal(state.syncs, index + 1);
    }
    state.page = { ...emptyPage(PLAID_HISTORY_STATE.HISTORICAL), next_cursor: "recovered-cursor" };
    assert.equal((await run(at)).items[0].status, "complete");
    assert.equal(queue().attempts, 0);
    assert.equal(queue().last_error_code, null);
    state.page.next_cursor = null;
    at = queue().due_at;
    assert.equal((await run(at)).items[0].code, "INVALID_SYNC_PAGE");
    assert.equal(queue().attempts, 1);
    assert.equal(Date.parse(queue().due_at) - Date.parse(at), 5 * 60_000);
  } finally { f.close(); }
});
