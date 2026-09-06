import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";
import { handleBankFeed } from "../src/lib/bank-feed.js";
import {
  createPlaidLinkToken, completePlaidLink, handlePlaidWebhook,
  runPlaidFeedSlice, plaidFeedStatus, syncPlaidItem,
} from "../src/lib/plaid-bank-feed.js";

// All provider responses and owner identity are synthetic. Any unintended
// external fetch fails; no credential lookup or remote service is reachable.
globalThis.fetch = async () => { throw new Error("Unexpected network access in private regression"); };
const json = value => Response.json(value);
const text = new TextEncoder();
const b64 = bytes => Buffer.from(bytes).toString("base64url");
const hash = async value => Buffer.from(await crypto.subtle.digest("SHA-256", text.encode(value))).toString("hex");

async function signedWebhook(body, issuedAt) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const key = await crypto.subtle.exportKey("jwk", pair.publicKey);
  key.kid = "synthetic-ready-window-key";
  const header = b64(text.encode(JSON.stringify({ alg: "ES256", kid: key.kid, typ: "JWT" })));
  const claims = b64(text.encode(JSON.stringify({ iat: issuedAt, request_body_sha256: await hash(body) })));
  const signingInput = header + "." + claims;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, text.encode(signingInput));
  return { jwt: signingInput + "." + b64(signature), key: { ...key, expired_at: null, created_at: issuedAt - 1 } };
}

const scenarioEvidence = [];
const evidencePath = process.env.READY_WINDOW_EVIDENCE_FILE || null;
function saveEvidence() {
  if (!evidencePath) return;
  writeFileSync(evidencePath, JSON.stringify({
    proof_level: "private synthetic real-SQLite and actual Worker/handler",
    real_provider_calls: false, external_mutations: false, scenarios: scenarioEvidence,
  }, null, 2) + "\n", { mode: 0o600 });
}

async function observe({ name, initialHistory, empty, webhook, raceStage = null, contaminatedReady = false, raceIncludesNew = false }) {
  const fixture = await createProductFixture({ env: {
    BANK_FEED_PROVIDER: "plaid", BANK_FEED_ENV: "sandbox",
    BANK_FEED_CLIENT_ID: "fixture-client", BANK_FEED_SECRET: "fixture-secret",
    BANK_FEED_WRAPPING_KEY_V2: "v2." + "A".repeat(43),
    BANK_FEED_RECONCILE_MINUTES: "15",
    BRAIN_NAME: "Synthetic Ready Window Brain",
  } });
  const initialStamp = new Date(Date.now() - 120_000).toISOString();
  const webhookStamp = new Date(Date.now() - 60_000).toISOString();
  const pageCalls = [];
  let providerHasNewData = false;
  let publicKey = null;
  const oldCursor = empty ? "" : "synthetic-initial-cursor";
  let expectedNewCursor = oldCursor;
  let raceArmed = false;
  let raceStamp = null;
  let raceNotification = null;
  let accountRacePagePending = false;
  let interruptSecondPage = false;
  let mutationSecondPage = false;
  let mutationOriginalPending = false;
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
    if (endpoint === "/accounts/get") {
      const accountSnapshot = { accounts: [{
        account_id: "synthetic-account", name: "Synthetic checking", mask: "0001",
        type: "depository", subtype: "checking",
        balances: { current: "20.00", available: "20.00", iso_currency_code: "USD" },
      }] };
      if (raceArmed && raceStage === "accounts") {
        raceArmed = false;
        raceNotification = await notifyHistorical(raceStamp);
        accountRacePagePending = true;
        providerHasNewData = true;
        expectedNewCursor = "synthetic-race-final";
      }
      return json(accountSnapshot);
    }
    if (endpoint === "/webhook_verification_key/get") {
      assert.ok(publicKey);
      return json({ key: publicKey });
    }
    assert.equal(endpoint, "/transactions/sync");
    pageCalls.push({ cursor: request.cursor ?? null, count: request.count });
    if (accountRacePagePending) {
      accountRacePagePending = false;
      return json({ added: [], modified: [], removed: [], next_cursor: "synthetic-race-final", has_more: false,
        transactions_update_status: "HISTORICAL_UPDATE_COMPLETE" });
    }
    if (mutationOriginalPending) {
      mutationOriginalPending = false;
      assert.equal(request.cursor, oldCursor);
      return json({ added: [], modified: [], removed: [], next_cursor: "synthetic-race-final", has_more: false,
        transactions_update_status: "HISTORICAL_UPDATE_COMPLETE" });
    }
    if (raceArmed) {
      raceArmed = false;
      const multiplePages = ["pagination", "interrupted-pagination", "mutation-restart"].includes(raceStage);
      interruptSecondPage = raceStage === "interrupted-pagination";
      mutationSecondPage = raceStage === "mutation-restart";
      const reply = {
        added: raceIncludesNew ? [transaction("synthetic-new")] : [], modified: [], removed: [],
        next_cursor: multiplePages ? "synthetic-race-middle" : "synthetic-race-final",
        has_more: multiplePages, transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
      };
      // Provider response snapshot precedes a webhook delivered while this
      // actual async request is unresolved. Its timestamp equals attempt start.
      raceNotification = await notifyHistorical(raceStamp);
      providerHasNewData = true;
      expectedNewCursor = "synthetic-race-final";
      return json(reply);
    }
    if (request.cursor === "synthetic-race-middle" && interruptSecondPage) {
      interruptSecondPage = false;
      return json({ added: null, modified: [], removed: [], next_cursor: "must-not-stage", has_more: false });
    }
    if (request.cursor === "synthetic-race-middle" && mutationSecondPage) {
      mutationSecondPage = false;
      mutationOriginalPending = true;
      return Response.json({ error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", error_type: "TRANSACTIONS_ERROR" }, { status: 400 });
    }
    if (request.cursor === "synthetic-race-middle") return json({
      added: [], modified: [], removed: [], next_cursor: "synthetic-race-final", has_more: false,
      transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
    });
    if (!providerHasNewData) return json({
      added: empty ? [] : [transaction("synthetic-old")], modified: [], removed: [],
      has_more: false, next_cursor: oldCursor, transactions_update_status: initialHistory,
    });
    if (request.cursor === "synthetic-after-new") return json({
      added: [], modified: [], removed: [], next_cursor: "synthetic-after-new", has_more: false,
      transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
    });
    assert.equal(request.cursor ?? "", expectedNewCursor);
    return json({
      added: [transaction("synthetic-new")], modified: [], removed: [],
      has_more: false, next_cursor: "synthetic-after-new",
      transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
    });
  };
  const window = () => {
    const row = fixture.first("SELECT state,original_cursor,resume_cursor,next_page_index,added_count,provider_history_state FROM plaid_sync_windows WHERE item_ref='synthetic-item'");
    return row ? { ...row } : null;
  };
  const reconciliation = () => ({ ...fixture.first("SELECT reason,state,due_at,updated_at FROM plaid_reconciliation WHERE item_ref='synthetic-item'") });
  const ledger = () => fixture.rows("SELECT external_id,source_window_ref,source_page_index FROM fin_transactions ORDER BY external_id").map(row => ({ ...row }));
  try {
    seedOwnedEntity(fixture, "synthetic-business", "Synthetic Business");
    const link = await createPlaidLinkToken(fixture.env, {
      url: "https://brain.invalid/app/connect/bank", sessionRef: "synthetic-ready-link",
      fetchImpl, now: initialStamp,
    });
    await completePlaidLink(fixture.env, {
      sessionRef: link.session_ref, publicToken: "synthetic-public", fetchImpl, now: initialStamp,
    });
    const initial = await runPlaidFeedSlice(fixture.env, { fetchImpl, now: initialStamp });
    assert.equal(initial.items[0].status, "assignment_required");
    assert.equal(pageCalls.length, 1);
    assert.equal(window().state, "ready");
    assert.equal(window().provider_history_state, initialHistory);
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items").cursor, null);
    assert.equal(ledger().length, 0);
    const stagedBefore = window();

    let notification = null;
    if (webhook && !raceStage) {
      providerHasNewData = true;
      notification = await notifyHistorical(webhookStamp);
      assert.equal(notification.reason, "webhook");
      assert.equal(notification.due_at, webhookStamp);
      const held = await runPlaidFeedSlice(fixture.env, { fetchImpl, now: webhookStamp });
      assert.equal(held.items[0].status, "assignment_required");
      assert.equal(pageCalls.length, 1, "ready branch did not fetch the new provider data");
    }
    if (contaminatedReady) {
      // Model the durable ready row already written by Candidate 2, not a new
      // provider result: its old snapshot has incorrectly inherited the hint.
      fixture.raw("UPDATE plaid_sync_windows SET provider_history_state='HISTORICAL_UPDATE_COMPLETE',updated_at=? WHERE item_ref='synthetic-item'", webhookStamp);
    }
    const afterNotification = window();

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
    assert.equal(background.length, 1);
    const continuation = await Promise.all(background);
    if (raceStage) {
      raceArmed = true;
      raceStamp = new Date().toISOString();
      continuation.push(await syncPlaidItem(fixture.env, "synthetic-item", { fetchImpl, now: raceStamp }));
      if (raceStage === "interrupted-pagination") {
        assert.equal(continuation.at(-1).code, "INVALID_SYNC_PAGE");
        assert.equal(continuation.at(-1).cursor_advanced, false);
        assert.equal(window().next_page_index, 1);
        assert.equal(window().resume_cursor, "synthetic-race-middle");
        assert.equal(reconciliation().reason, "webhook");
        assert.equal(fixture.first("SELECT cursor FROM bank_feed_items").cursor, oldCursor);
        continuation.push(await syncPlaidItem(fixture.env, "synthetic-item", { fetchImpl,
          now: new Date(Date.parse(raceStamp) + 1).toISOString() }));
      }
      notification = raceNotification;
      assert.equal(notification.reason, "webhook");
      assert.equal(notification.updated_at, raceStamp, "same-millisecond race actually reached the provider await");
    }
    const response = await fixture.worker.fetch(new Request("https://brain.invalid/api/bank-feed/accounts", { headers: owner }), fixture.env, {});
    assert.equal(response.status, 200);
    const ownerStatus = await response.json();
    const afterAssignment = {
      owner: ownerStatus,
      feed: await plaidFeedStatus(fixture.env),
      backfill: { ...fixture.first("SELECT state,provider_history_state,finished_at FROM bank_feed_backfill") },
      item: { ...fixture.first("SELECT cursor,cursor_updated_at,last_synced_at,status,status_detail FROM bank_feed_items") },
      reconciliation: reconciliation(), ledger: ledger(),
      page_calls: pageCalls.length, continuation,
    };
    const oneSecondLater = new Date(Date.parse(afterAssignment.item.cursor_updated_at) + 1000).toISOString();
    const earlyRetry = await runPlaidFeedSlice(fixture.env, { fetchImpl, now: oneSecondLater });
    let afterOrdinaryDue = null;
    if (webhook) {
      const due = afterAssignment.reconciliation.due_at;
      const eventual = earlyRetry.ran ? earlyRetry : await runPlaidFeedSlice(fixture.env, { fetchImpl, now: new Date(Date.parse(due) + 1).toISOString() });
      assert.equal(eventual.items[0].ok, true);
      assert.ok(ledger().some(row => row.external_id === "synthetic-new"));
      afterOrdinaryDue = { page_calls: pageCalls.length, ledger: ledger(), result: eventual.items[0] };
    }
    const finalResponse = await fixture.worker.fetch(new Request("https://brain.invalid/api/bank-feed/accounts", { headers: owner }), fixture.env, {});
    assert.equal(finalResponse.status, 200);
    const finalOwner = await finalResponse.json();
    const evidence = { name, initialHistory, empty, webhook, initialStamp, raceStage, stagedBefore, notification, afterNotification, afterAssignment,
      earlyRetry: { ran: earlyRetry.ran }, afterOrdinaryDue, finalOwner, finalReconciliation: reconciliation() };
    scenarioEvidence.push(evidence);
    saveEvidence();
    return evidence;
  } finally {
    fixture.close();
  }
}

test("control: no later webhook leaves an empty NOT_READY snapshot visibly partial", async () => {
  const result = await observe({ name: "control-no-later-webhook", initialHistory: "NOT_READY", empty: true, webhook: false });
  assert.equal(result.afterAssignment.owner.state, "partial");
  assert.equal(result.afterAssignment.backfill.state, "running");
  assert.equal(result.afterAssignment.owner.accounts[0].history.partial, true);
});

for (const [name, initialHistory, empty] of [
  ["empty NOT_READY", "NOT_READY", true],
  ["partial INITIAL", "INITIAL_UPDATE_COMPLETE", false],
  ["previous HISTORICAL", "HISTORICAL_UPDATE_COMPLETE", false],
]) {
  test("later webhook cannot make an unfetched " + name + " snapshot appear current", async () => {
    const result = await observe({ name, initialHistory, empty, webhook: true });
    assert.ok(
      result.afterAssignment.owner.state !== "current" || result.afterAssignment.ledger.some(row => row.external_id === "synthetic-new"),
      "owner API claims current before the webhook-announced provider change was fetched",
    );
  });
}

test("later webhook work remains promptly due after old ready-snapshot promotion", async () => {
  const result = await observe({ name: "due-now-overwritten", initialHistory: "INITIAL_UPDATE_COMPLETE", empty: false, webhook: true });
  assert.ok(
    result.afterAssignment.page_calls > 1 || result.earlyRetry.ran > 0,
    "known webhook debt was replaced by a 15-minute scheduled poll after promoting an old snapshot",
  );
});


for (const raceStage of ["accounts", "single-page", "pagination", "interrupted-pagination", "mutation-restart"]) {
  test("same-millisecond webhook during " + raceStage + " fetch stays pending through atomic promotion", async () => {
    const result = await observe({ name: "same-ms-" + raceStage, initialHistory: "HISTORICAL_UPDATE_COMPLETE", empty: false, webhook: true, raceStage });
    assert.equal(result.afterAssignment.reconciliation.reason, "refresh_pending");
    assert.equal(result.afterAssignment.owner.accounts[0].freshness.state, "pending");
    assert.notEqual(result.afterAssignment.owner.state, "current");
    assert.equal(result.earlyRetry.ran, 1);
    assert.equal(result.afterOrdinaryDue.result.ok, true);
    assert.equal(result.finalOwner.state, "current");
    assert.equal(result.finalReconciliation.reason, "scheduled");
    assert.equal(result.afterAssignment.ledger.some(row => row.external_id === "synthetic-new"), false);
  });
}

test("ready snapshot keeps fetched history and observation time while newer provider history remains available", async () => {
  const result = await observe({ name: "snapshot-history-and-observation", initialHistory: "INITIAL_UPDATE_COMPLETE", empty: false, webhook: true });
  assert.equal(result.afterNotification.provider_history_state, "INITIAL_UPDATE_COMPLETE");
  assert.equal(result.afterAssignment.backfill.provider_history_state, "HISTORICAL_UPDATE_COMPLETE");
  assert.equal(result.afterAssignment.backfill.state, "running");
  assert.equal(result.afterAssignment.item.last_synced_at, result.initialStamp);
  assert.equal(result.afterAssignment.owner.accounts[0].freshness.state, "pending");
  assert.equal(result.afterOrdinaryDue.result.ok, true);
});

test("ordinary successful provider fetch becomes current with a future scheduled poll", async () => {
  const result = await observe({ name: "normal-success", initialHistory: "HISTORICAL_UPDATE_COMPLETE", empty: false, webhook: false });
  assert.equal(result.earlyRetry.ran, 1, "ready resume must actually be followed by a fresh read");
  assert.equal(result.finalOwner.state, "current");
  assert.equal(result.finalOwner.summary.refresh_pending, 0);
  assert.equal(result.finalOwner.accounts[0].history.partial, false);
  assert.equal(result.finalReconciliation.reason, "scheduled");
  assert.ok(Date.parse(result.finalReconciliation.due_at) > Date.parse(result.afterAssignment.item.cursor_updated_at));
});

test("a Candidate 2 contaminated ready row remains pending until an actual new fetch", async () => {
  const result = await observe({ name: "legacy-contaminated-ready", initialHistory: "INITIAL_UPDATE_COMPLETE", empty: false, webhook: true, contaminatedReady: true });
  assert.equal(result.afterNotification.provider_history_state, "HISTORICAL_UPDATE_COMPLETE");
  assert.equal(result.afterAssignment.backfill.state, "running");
  assert.equal(result.afterAssignment.owner.accounts[0].history.partial, true);
  assert.equal(result.afterAssignment.owner.accounts[0].freshness.state, "pending");
  assert.equal(result.afterAssignment.item.last_synced_at, result.initialStamp);
  assert.equal(result.afterAssignment.reconciliation.reason, "refresh_pending");
  assert.equal(result.finalOwner.state, "current");
});

test("a webhook during pagination survives even when those pages happen to include its change", async () => {
  const result = await observe({ name: "same-ms-data-already-in-response", initialHistory: "HISTORICAL_UPDATE_COMPLETE", empty: false, webhook: true, raceStage: "pagination", raceIncludesNew: true });
  assert.ok(result.afterAssignment.ledger.some(row => row.external_id === "synthetic-new"));
  assert.equal(result.afterAssignment.reconciliation.reason, "refresh_pending");
  assert.equal(result.afterAssignment.owner.accounts[0].freshness.state, "pending");
  assert.equal(result.earlyRetry.ran, 1);
  assert.equal(result.finalOwner.state, "current");
});
