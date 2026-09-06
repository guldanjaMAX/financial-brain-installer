import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";
import { handleBankFeed } from "../src/lib/bank-feed.js";
import {
  createPlaidLinkToken, completePlaidLink, handlePlaidWebhook,
  runPlaidFeedSlice, plaidFeedStatus,
} from "../src/lib/plaid-bank-feed.js";

// Every provider response and owner identity is synthetic. Any unintended
// external fetch fails; no credential lookup or remote service is reachable.
globalThis.fetch = async () => { throw new Error("Unexpected network access in private regression"); };
const json = value => Response.json(value);
const text = new TextEncoder();
const b64 = bytes => Buffer.from(bytes).toString("base64url");
const hash = async value => Buffer.from(await crypto.subtle.digest("SHA-256", text.encode(value))).toString("hex");

async function signedWebhook(body, issuedAt) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const key = await crypto.subtle.exportKey("jwk", pair.publicKey);
  key.kid = "synthetic-refresh-debt-key";
  const header = b64(text.encode(JSON.stringify({ alg: "ES256", kid: key.kid, typ: "JWT" })));
  const claims = b64(text.encode(JSON.stringify({ iat: issuedAt, request_body_sha256: await hash(body) })));
  const signingInput = header + "." + claims;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, text.encode(signingInput));
  return { jwt: signingInput + "." + b64(signature), key: { ...key, expired_at: null, created_at: issuedAt - 1 } };
}

const scenarioEvidence = [];
const evidencePath = process.env.REFRESH_DEBT_EVIDENCE_FILE || null;
function saveEvidence() {
  if (!evidencePath) return;
  writeFileSync(evidencePath, JSON.stringify({
    proof_level: "private synthetic real-SQLite and actual Worker owner route; real provider failure path",
    real_provider_calls: false, external_mutations: false, scenarios: scenarioEvidence,
  }, null, 2) + "\n", { mode: 0o600 });
}

// Drive a real connection to the ordinary steady state: one historical-complete
// window fetched for real, so the reconciliation queue holds the routine future
// poll (reason 'scheduled', state 'pending') and the owner is honestly current.
async function reachScheduledCurrent(name) {
  const fixture = await createProductFixture({ env: {
    BANK_FEED_PROVIDER: "plaid", BANK_FEED_ENV: "sandbox",
    BANK_FEED_CLIENT_ID: "fixture-client", BANK_FEED_SECRET: "fixture-secret",
    BANK_FEED_WRAPPING_KEY_V2: "v2." + "A".repeat(43),
    BANK_FEED_RECONCILE_MINUTES: "15",
    BRAIN_NAME: "Synthetic Refresh Debt Brain",
  } });
  const initialStamp = new Date(Date.now() - 120_000).toISOString();
  const syncCalls = [];
  let publicKey = null;
  let failSync = null;
  const transaction = id => ({
    transaction_id: id, account_id: "synthetic-account", amount: "1.00",
    iso_currency_code: "USD", date: "2026-09-05", pending: false,
    name: "Synthetic controlled expense",
  });
  const fetchImpl = async (url, init) => {
    const endpoint = new URL(url).pathname;
    const request = JSON.parse(init.body || "{}");
    if (endpoint === "/link/token/create") return json({ link_token: "synthetic-link", expiration: "2099-01-01T00:00:00Z" });
    if (endpoint === "/item/public_token/exchange") return json({ item_id: "synthetic-item", access_token: "synthetic-access-reference" });
    if (endpoint === "/item/get") return json({ item: { item_id: "synthetic-item", error: null } });
    if (endpoint === "/webhook_verification_key/get") { assert.ok(publicKey); return json({ key: publicKey }); }
    if (endpoint === "/accounts/get") return json({ accounts: [{
      account_id: "synthetic-account", name: "Synthetic checking", mask: "0001",
      type: "depository", subtype: "checking",
      balances: { current: "20.00", available: "20.00", iso_currency_code: "USD" },
    }] });
    assert.equal(endpoint, "/transactions/sync");
    syncCalls.push({ cursor: request.cursor ?? null, failing: failSync !== null });
    if (failSync !== null) {
      // An actual provider rate-limit response. Retry-After keeps the real
      // bounded-retry machinery in the path without a slow test.
      return new Response(JSON.stringify({ error_code: failSync, error_type: "RATE_LIMIT_EXCEEDED" }),
        { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "0" } });
    }
    return json({
      added: [transaction("synthetic-old")], modified: [], removed: [],
      has_more: false, next_cursor: "synthetic-cursor",
      transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
    });
  };
  const reconciliation = () => ({ ...fixture.first(
    "SELECT reason,state,due_at,attempts,last_error_code FROM plaid_reconciliation WHERE item_ref='synthetic-item'") });
  const ownerStatus = async headers => {
    const response = await fixture.worker.fetch(
      new Request("https://brain.invalid/api/bank-feed/accounts", { headers }), fixture.env, {});
    assert.equal(response.status, 200);
    return await response.json();
  };
  async function notifyHistorical(at) {
    const rawBody = JSON.stringify({
      webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "synthetic-item", environment: "sandbox",
      initial_update_complete: true, historical_update_complete: true,
    });
    const signed = await signedWebhook(rawBody, Math.floor(Date.parse(at) / 1000));
    publicKey = signed.key;
    const accepted = await handlePlaidWebhook(fixture.env, new Request("https://brain.invalid/api/webhooks/plaid", {
      method: "POST", body: rawBody,
      headers: { "Content-Type": "application/json", "Plaid-Verification": signed.jwt },
    }), { fetchImpl, now: at });
    assert.equal(accepted.status, 200);
    return reconciliation();
  }

  seedOwnedEntity(fixture, "synthetic-business", "Synthetic Business");
  const link = await createPlaidLinkToken(fixture.env, {
    url: "https://brain.invalid/app/connect/bank", sessionRef: "synthetic-refresh-debt-link",
    fetchImpl, now: initialStamp,
  });
  await completePlaidLink(fixture.env, {
    sessionRef: link.session_ref, publicToken: "synthetic-public", fetchImpl, now: initialStamp,
  });
  const initial = await runPlaidFeedSlice(fixture.env, { fetchImpl, now: initialStamp });
  assert.equal(initial.items[0].status, "assignment_required");

  const owner = await fixture.ownerHeaders();
  const ref = fixture.first("SELECT account_ref FROM plaid_account_entity_assignments").account_ref;
  const background = [];
  const assignUrl = new URL("https://brain.invalid/api/bank-feed/accounts/assign");
  const assigned = await handleBankFeed(fixture.env, new Request(assignUrl, {
    method: "POST", headers: { ...owner, "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: "synthetic-assignment", account_ref: ref, entity_slug: "synthetic-business" }),
  }), assignUrl, assignUrl.pathname, {
    bankFeedFetchImpl: fetchImpl,
    waitUntil(promise) { background.push(Promise.resolve(promise)); },
  });
  assert.equal(assigned.status, 201);
  await Promise.all(background);

  // The saved ready snapshot is published but still owes a real read. One
  // ordinary fresh window clears that debt and leaves the routine poll.
  const cursorUpdatedAt = fixture.first("SELECT cursor_updated_at FROM bank_feed_items").cursor_updated_at;
  const settled = await runPlaidFeedSlice(fixture.env,
    { fetchImpl, now: new Date(Date.parse(cursorUpdatedAt) + 1000).toISOString() });
  assert.equal(settled.items[0].ok, true, "the ordinary fresh window must actually succeed");

  syncCalls.length = 0;
  const scheduled = reconciliation();
  assert.equal(scheduled.reason, "scheduled", "steady state must be the routine future poll");
  assert.equal(scheduled.state, "pending");
  const current = await ownerStatus(owner);
  assert.equal(current.state, "current", "an actually fetched historical-complete feed is current");
  assert.equal(current.summary.refresh_pending, 0);

  return {
    fixture, fetchImpl, owner, reconciliation, ownerStatus, notifyHistorical, syncCalls,
    scheduled, current,
    armSyncFailure(code = "RATE_LIMIT_EXCEEDED") { failSync = code; },
    // Model an actual wrapping-key rotation mistake. The stored reference
    // stays exactly as written; only the declared key can no longer open it.
    rotateWrappingKey() { fixture.env.BANK_FEED_WRAPPING_KEY_V2 = "v2." + "B".repeat(43); },
    restoreWrappingKey() { fixture.env.BANK_FEED_WRAPPING_KEY_V2 = "v2." + "A".repeat(43); },
    record(evidence) { scenarioEvidence.push({ name, ...evidence }); saveEvidence(); },
  };
}

test("a failed scheduled refresh is never reported as current data", async () => {
  const run = await reachScheduledCurrent("scheduled-then-retryable");
  try {
    // A real operational fault that lands before a fresh window arms its
    // sync_fetch marker: the declared wrapping key no longer opens the stored
    // access reference. The routine poll comes due and genuinely fails. The
    // queue row below is written by the product catch path, not by this test.
    run.rotateWrappingKey();
    const dueAt = new Date(Date.parse(run.scheduled.due_at) + 1).toISOString();
    const failed = await runPlaidFeedSlice(run.fixture.env, { fetchImpl: run.fetchImpl, now: dueAt });
    assert.equal(failed.ran, 1, "the due scheduled poll must actually be attempted");
    assert.equal(failed.items[0].ok, false);
    assert.equal(failed.items[0].status, "retryable");
    assert.equal(failed.items[0].code, "BANK_ACCESS_REFERENCE_UNREADABLE");
    assert.equal(run.syncCalls.length, 0, "the failure must precede any provider read of this window");

    const after = run.reconciliation();
    // The failure upsert changes state without rewriting reason, so the queue
    // row is genuinely 'scheduled' + 'retryable'. That combination is the bug.
    assert.equal(after.state, "retryable");
    assert.equal(after.reason, "scheduled");
    assert.ok(after.attempts >= 1);
    assert.equal(run.fixture.first("SELECT status FROM bank_feed_items").status, "error");

    const owner = await run.ownerStatus(run.owner);
    const feed = await plaidFeedStatus(run.fixture.env);
    run.record({ scheduled: run.scheduled, after, owner_state: owner.state,
      account_freshness: owner.accounts[0].freshness, summary: owner.summary,
      feed_reconciliation: feed.connections[0].reconciliation,
      feed_needs_attention: feed.needs_attention.length });

    assert.equal(owner.accounts[0].freshness.refresh_pending, true,
      "a failed refresh must be owner-visible refresh debt");
    assert.equal(feed.connections[0].reconciliation.refresh_pending, true,
      "feed status must report the same refresh debt");
    assert.notEqual(owner.state, "current",
      "a connection whose last refresh failed must not read as current");
    assert.equal(owner.summary.refresh_pending, 1);
  } finally { run.fixture.close(); }
});

test("a provider failure after the sync_fetch marker is already refresh debt", async () => {
  const run = await reachScheduledCurrent("sync-fetch-then-retryable");
  try {
    run.armSyncFailure();
    const dueAt = new Date(Date.parse(run.scheduled.due_at) + 1).toISOString();
    const failed = await runPlaidFeedSlice(run.fixture.env, { fetchImpl: run.fetchImpl, now: dueAt });
    assert.equal(failed.items[0].ok, false);
    assert.equal(failed.items[0].status, "retryable");
    const after = run.reconciliation();
    assert.equal(after.state, "retryable");
    assert.equal(after.reason, "sync_fetch", "the fresh window armed its marker before the provider read");
    const owner = await run.ownerStatus(run.owner);
    const feed = await plaidFeedStatus(run.fixture.env);
    run.record({ scheduled: run.scheduled, after, owner_state: owner.state,
      account_freshness: owner.accounts[0].freshness, summary: owner.summary,
      feed_reconciliation: feed.connections[0].reconciliation });
    assert.equal(owner.accounts[0].freshness.refresh_pending, true);
    assert.equal(feed.connections[0].reconciliation.refresh_pending, true);
    assert.notEqual(owner.state, "current");
  } finally { run.fixture.close(); }
});

test("refresh debt clears once the connection actually recovers", async () => {
  const run = await reachScheduledCurrent("failed-then-recovered");
  try {
    run.rotateWrappingKey();
    const dueAt = new Date(Date.parse(run.scheduled.due_at) + 1).toISOString();
    const failed = await runPlaidFeedSlice(run.fixture.env, { fetchImpl: run.fetchImpl, now: dueAt });
    assert.equal(failed.items[0].ok, false);
    const broken = run.reconciliation();
    assert.equal(broken.state, "retryable");
    assert.equal(broken.reason, "scheduled");
    const during = await run.ownerStatus(run.owner);
    assert.notEqual(during.state, "current");

    // The operator repairs the wrapping key. The next due poll succeeds for
    // real, and the owner must be told the truth again rather than staying
    // permanently marked as owing a refresh.
    run.restoreWrappingKey();
    const retryAt = new Date(Date.parse(broken.due_at) + 1).toISOString();
    const recovered = await runPlaidFeedSlice(run.fixture.env, { fetchImpl: run.fetchImpl, now: retryAt });
    assert.equal(recovered.ran, 1);
    assert.equal(recovered.items[0].ok, true, "the repaired connection must actually sync");
    const settled = run.reconciliation();
    assert.equal(settled.state, "pending");
    assert.equal(settled.reason, "scheduled");
    const after = await run.ownerStatus(run.owner);
    const feed = await plaidFeedStatus(run.fixture.env);
    run.record({ after: settled, owner_state: after.state,
      account_freshness: after.accounts[0].freshness, summary: after.summary,
      feed_reconciliation: feed.connections[0].reconciliation });
    assert.equal(after.state, "current", "refresh debt must not be sticky after a real recovery");
    assert.notEqual(after.accounts[0].freshness.refresh_pending, true);
    assert.equal(feed.connections[0].reconciliation.refresh_pending, false);
    assert.equal(after.summary.refresh_pending, 0);
    assert.equal(run.fixture.first("SELECT status FROM bank_feed_items").status, "connected");
  } finally { run.fixture.close(); }
});

test("an ordinary future scheduled poll still leaves an actually fetched feed current", async () => {
  const run = await reachScheduledCurrent("scheduled-pending-stays-current");
  try {
    const owner = await run.ownerStatus(run.owner);
    const feed = await plaidFeedStatus(run.fixture.env);
    run.record({ scheduled: run.scheduled, owner_state: owner.state,
      account_freshness: owner.accounts[0].freshness,
      feed_reconciliation: feed.connections[0].reconciliation });
    assert.equal(run.scheduled.reason, "scheduled");
    assert.equal(run.scheduled.state, "pending");
    assert.equal(owner.state, "current");
    assert.equal(owner.accounts[0].freshness.state, "current");
    assert.notEqual(owner.accounts[0].freshness.refresh_pending, true);
    assert.equal(feed.connections[0].reconciliation.refresh_pending, false);
    assert.equal(owner.summary.refresh_pending, 0);
  } finally { run.fixture.close(); }
});

test("known webhook debt on a pending row stays refresh debt", async () => {
  const run = await reachScheduledCurrent("webhook-pending-is-debt");
  try {
    const notified = await run.notifyHistorical(new Date().toISOString());
    assert.equal(notified.reason, "webhook");
    assert.equal(notified.state, "pending");
    const owner = await run.ownerStatus(run.owner);
    const feed = await plaidFeedStatus(run.fixture.env);
    run.record({ after: notified, owner_state: owner.state,
      account_freshness: owner.accounts[0].freshness,
      feed_reconciliation: feed.connections[0].reconciliation });
    assert.equal(owner.accounts[0].freshness.refresh_pending, true);
    assert.equal(feed.connections[0].reconciliation.refresh_pending, true);
    assert.notEqual(owner.state, "current");
  } finally { run.fixture.close(); }
});
