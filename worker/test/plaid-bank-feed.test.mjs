import test from "node:test";
import assert from "node:assert/strict";
import { createProductFixture, seedCounterparty, seedOwnedEntity } from "./product-contract-fixture.mjs";
import { handleBankFeed } from "../src/lib/bank-feed.js";
import {
  completePlaidLink,
  createPlaidLinkToken,
  disconnectPlaidItem,
  drainPlaidRevocations,
  handlePlaidWebhook,
  plaidFeedStatus,
  runPlaidFeedSlice,
  syncPlaidItem,
} from "../src/lib/plaid-bank-feed.js";

const encoder = new TextEncoder();

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlJson(value) {
  return base64Url(encoder.encode(JSON.stringify(value)));
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signedWebhook(rawBody, issuedAt) {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  publicJwk.kid = "fixture-plaid-key";
  const header = base64UrlJson({ alg: "ES256", kid: publicJwk.kid, typ: "JWT" });
  const claims = base64UrlJson({ iat: issuedAt, request_body_sha256: await sha256Hex(rawBody) });
  const input = `${header}.${claims}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    encoder.encode(input),
  ));
  return { jwt: `${input}.${base64Url(signature)}`, publicJwk };
}

class PlaidSandboxFake {
  constructor() {
    this.calls = new Map();
    this.mutationRaised = false;
    this.exchangeAvailable = true;
    this.exchangeDelayMs = 0;
    this.healthAvailable = true;
    this.historySequence = null;
    this.removeAvailable = false;
    this.publicJwk = null;
  }

  count(path) {
    return this.calls.get(path) || 0;
  }

  async fetch(url, init) {
    const path = new URL(url).pathname;
    this.calls.set(path, this.count(path) + 1);
    const body = JSON.parse(init.body || "{}");
    if (path === "/link/token/create") {
      if (body.access_token) {
        assert.equal(body.access_token, "access-sandbox-secret");
        assert.equal(Object.hasOwn(body, "products"), false);
        assert.equal(Object.hasOwn(body, "transactions"), false);
        assert.equal(Object.hasOwn(body, "webhook"), false);
      } else {
        assert.deepEqual(body.products, ["transactions"]);
        assert.equal(body.webhook, "https://brain.invalid/api/webhooks/plaid");
      }
      return jsonResponse({
        link_token: "link-sandbox-short-lived",
        expiration: "2099-08-30T13:30:00.000Z",
      });
    }
    if (path === "/item/public_token/exchange") {
      assert.equal(body.public_token, "public-sandbox-once");
      if (this.exchangeDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.exchangeDelayMs));
      }
      return this.exchangeAvailable
        ? jsonResponse({ item_id: "item-sandbox-1", access_token: "access-sandbox-secret" })
        : jsonResponse({ error_code: "INTERNAL_SERVER_ERROR" }, 500);
    }
    if (path === "/item/get") {
      assert.equal(body.access_token, "access-sandbox-secret");
      return this.healthAvailable
        ? jsonResponse({ item: { item_id: "item-sandbox-1", error: null } })
        : jsonResponse({ error_code: "ITEM_LOGIN_REQUIRED" }, 401);
    }
    if (path === "/accounts/get") {
      return jsonResponse({ accounts: [{
        account_id: "account-1",
        name: "Sandbox checking",
        official_name: "Sandbox Checking",
        mask: "1234",
        type: "depository",
        subtype: "checking",
        balances: { current: "100.00", available: "88.00", iso_currency_code: "USD" },
      }] });
    }
    if (path === "/transactions/sync") {
      if (Array.isArray(this.historySequence) && this.historySequence.length > 0) {
        const state = this.historySequence.shift();
        return jsonResponse({
          added: [],
          modified: [],
          removed: [],
          next_cursor: `history-${this.count("/transactions/sync")}`,
          has_more: false,
          transactions_update_status: state,
        });
      }
      if (!body.cursor) return jsonResponse({
        added: [{
          transaction_id: "pending-1",
          account_id: "account-1",
          amount: "12.34",
          iso_currency_code: "USD",
          date: "2026-08-28",
          pending: true,
          name: "Pending purchase",
        }],
        modified: [],
        removed: [],
        next_cursor: "page-2",
        has_more: true,
        transactions_update_status: "INITIAL_UPDATE_COMPLETE",
      });
      if (body.cursor === "page-2" && !this.mutationRaised) {
        this.mutationRaised = true;
        return jsonResponse({
          error_type: "TRANSACTIONS_ERROR",
          error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
          error_message: "mutation",
        }, 400);
      }
      if (body.cursor === "page-2") return jsonResponse({
        added: [{
          transaction_id: "posted-1",
          pending_transaction_id: "pending-1",
          account_id: "account-1",
          amount: "12.34",
          iso_currency_code: "USD",
          date: "2026-08-29",
          authorized_date: "2026-08-28",
          pending: false,
          name: "Posted purchase",
          merchant_name: "Sandbox Merchant",
        }],
        modified: [],
        removed: [{ transaction_id: "withdrawn-1" }],
        next_cursor: "complete-1",
        has_more: false,
        transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
      });
      if (body.cursor === "complete-1") return jsonResponse({
        added: [], modified: [], removed: [], next_cursor: "complete-2", has_more: false,
        transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
      });
      throw new Error(`unexpected sync cursor ${body.cursor}`);
    }
    if (path === "/webhook_verification_key/get") {
      return jsonResponse({ key: this.publicJwk });
    }
    if (path === "/item/remove") {
      return this.removeAvailable
        ? jsonResponse({ request_id: "removed" })
        : jsonResponse({ error_code: "INTERNAL_SERVER_ERROR" }, 500);
    }
    throw new Error(`unexpected Plaid path ${path}`);
  }
}

class MultiEntityPlaidFake extends PlaidSandboxFake {
  async fetch(url, init) {
    const path = new URL(url).pathname;
    if (path !== "/accounts/get" && path !== "/transactions/sync") {
      return super.fetch(url, init);
    }
    this.calls.set(path, this.count(path) + 1);
    if (path === "/accounts/get") {
      return jsonResponse({ accounts: [
        {
          account_id: "household-account-internal",
          name: "Household checking",
          mask: "1111",
          type: "depository",
          subtype: "checking",
          balances: { current: "1000.00", available: "900.00", iso_currency_code: "USD" },
        },
        {
          account_id: "business-account-internal",
          name: "Business card",
          mask: "2222",
          type: "credit",
          subtype: "credit card",
          balances: { current: "200.00", available: "800.00", iso_currency_code: "USD" },
        },
      ] });
    }
    return jsonResponse({
      added: [
        {
          transaction_id: "household-transaction-internal",
          account_id: "household-account-internal",
          amount: "20.00",
          iso_currency_code: "USD",
          date: "2026-08-30",
          pending: false,
          name: "Household fixture",
        },
        {
          transaction_id: "business-transaction-internal",
          account_id: "business-account-internal",
          amount: "30.00",
          iso_currency_code: "USD",
          date: "2026-08-30",
          pending: false,
          name: "Business fixture",
        },
      ],
      modified: [],
      removed: [],
      next_cursor: "multi-entity-complete",
      has_more: false,
      transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
    });
  }
}

test("bank connect navigation accepts the owner cookie while every API still requires the app header", async () => {
  const fixture = await createProductFixture({
    env: {
      BANK_FEED_PROVIDER: "plaid",
      BANK_FEED_ENV: "sandbox",
      BANK_FEED_CLIENT_ID: "fixture-client-id",
      BANK_FEED_SECRET: "fixture-secret",
      BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
      BRAIN_NAME: "Sandbox Brain",
    },
  });
  try {
    const ownerHeaders = await fixture.ownerHeaders();
    const navigationHeaders = { Cookie: ownerHeaders.Cookie };
    const pageUrl = new URL("https://brain.invalid/app/connect/bank");
    const page = await handleBankFeed(fixture.env, new Request(pageUrl, {
      headers: navigationHeaders,
    }), pageUrl, pageUrl.pathname, {});
    assert.equal(page.status, 200);
    assert.match(page.headers.get("cache-control"), /private, no-store/);
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    const html = await page.text();
    assert.match(html, /X-Brain-App/);
    assert.match(html, /Choose where each account belongs/);

    const accountsUrl = new URL("https://brain.invalid/api/bank-feed/accounts");
    const cookieOnlyApi = await handleBankFeed(fixture.env, new Request(accountsUrl, {
      headers: navigationHeaders,
    }), accountsUrl, accountsUrl.pathname, {});
    assert.equal(cookieOnlyApi.status, 401);
    assert.equal((await cookieOnlyApi.json()).code, "session_required");

    const authenticatedApi = await handleBankFeed(fixture.env, new Request(accountsUrl, {
      headers: ownerHeaders,
    }), accountsUrl, accountsUrl.pathname, {});
    assert.equal(authenticatedApi.status, 200);
    assert.deepEqual((await authenticatedApi.json()).accounts, []);

    const scopedHeaders = await fixture.ownerHeaders({ grantId: "grant-fixture" });
    const scopedPage = await handleBankFeed(fixture.env, new Request(pageUrl, {
      headers: { Cookie: scopedHeaders.Cookie },
    }), pageUrl, pageUrl.pathname, {});
    assert.equal(scopedPage.status, 403);
    assert.match(await scopedPage.text(), /Only the owner/);
  } finally {
    fixture.close();
  }
});

test("the final owner account assignment immediately resumes the staged Plaid import", async () => {
  const fixture = await createProductFixture({
    env: {
      BANK_FEED_PROVIDER: "plaid",
      BANK_FEED_ENV: "sandbox",
      BANK_FEED_CLIENT_ID: "fixture-client-id",
      BANK_FEED_SECRET: "fixture-secret",
      BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
      BRAIN_NAME: "Sandbox Brain",
    },
  });
  const provider = new PlaidSandboxFake();
  const fetchImpl = provider.fetch.bind(provider);
  const stamp = "2026-08-30T13:00:00.000Z";
  try {
    seedOwnedEntity(fixture, "fixture-company", "Fixture Company");
    const link = await createPlaidLinkToken(fixture.env, {
      url: "https://brain.invalid/app/connect/bank",
      sessionRef: "assignment-resume-link-0001",
      fetchImpl,
      now: stamp,
    });
    await completePlaidLink(fixture.env, {
      sessionRef: link.session_ref,
      publicToken: "public-sandbox-once",
      fetchImpl,
      now: stamp,
    });
    const staged = await runPlaidFeedSlice(fixture.env, { maxItems: 1, fetchImpl, now: stamp });
    assert.equal(staged.items[0].status, "assignment_required");
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 0);
    const accountRef = fixture.first(
      "SELECT account_ref FROM plaid_account_entity_assignments WHERE item_ref='item-sandbox-1'",
    ).account_ref;
    const ownerHeaders = await fixture.ownerHeaders();
    const assignUrl = new URL("https://brain.invalid/api/bank-feed/accounts/assign");
    const assignmentBody = {
      request_id: "assignment-resume-request-0001",
      account_ref: accountRef,
      entity_slug: "fixture-company",
    };
    const background = [];
    const response = await handleBankFeed(fixture.env, new Request(assignUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ownerHeaders },
      body: JSON.stringify(assignmentBody),
    }), assignUrl, assignUrl.pathname, {
      bankFeedFetchImpl: fetchImpl,
      waitUntil(promise) { background.push(Promise.resolve(promise)); },
    });
    assert.equal(response.status, 201);
    assert.equal(background.length, 1);
    const replayBackground = [];
    const replay = await handleBankFeed(fixture.env, new Request(assignUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ownerHeaders },
      body: JSON.stringify(assignmentBody),
    }), assignUrl, assignUrl.pathname, {
      bankFeedFetchImpl: fetchImpl,
      waitUntil(promise) { replayBackground.push(Promise.resolve(promise)); },
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).replayed, true);
    assert.equal(replayBackground.length, 0);
    await Promise.all(background);
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items WHERE item_ref='item-sandbox-1'").cursor, "complete-1");
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 2);
    assert.equal(fixture.first(
      "SELECT entity_slug FROM fin_accounts WHERE external_ref='account-1'",
    ).entity_slug, "fixture-company");
  } finally {
    fixture.close();
  }
});

test("Plaid webhook streaming stops at the byte limit and preserves the exact signed body bytes", async () => {
  const fixture = await createProductFixture({
    env: {
      BANK_FEED_PROVIDER: "plaid",
      BANK_FEED_ENV: "sandbox",
      BANK_FEED_CLIENT_ID: "fixture-client-id",
      BANK_FEED_SECRET: "fixture-secret",
      BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
      BRAIN_NAME: "Sandbox Brain",
    },
  });
  const provider = new PlaidSandboxFake();
  const fetchImpl = provider.fetch.bind(provider);
  const stamp = "2026-08-30T13:00:00.000Z";
  try {
    let produced = 0;
    let cancelled = false;
    const oversizedStream = new ReadableStream({
      pull(controller) {
        produced += 1;
        if (produced > 20) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() { cancelled = true; },
    });
    const oversized = await handlePlaidWebhook(fixture.env, new Request(
      "https://brain.invalid/api/webhooks/plaid",
      { method: "POST", body: oversizedStream, duplex: "half" },
    ), { fetchImpl, now: stamp });
    assert.equal(oversized.status, 413);
    assert.equal(await oversized.text(), "payload too large");
    assert.equal(cancelled, true, "the reader must cancel the remainder of an oversized stream");
    assert.ok(produced < 10, "the handler must not consume the complete unbounded stream");
    assert.equal(provider.count("/webhook_verification_key/get"), 0);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM plaid_webhook_events").n, 0);

    const rawBody = JSON.stringify({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      exact_fixture_text: "Café",
    });
    const issuedAt = Math.floor(Date.parse(stamp) / 1000);
    const signed = await signedWebhook(rawBody, issuedAt);
    signed.publicJwk.expired_at = issuedAt + 60;
    provider.publicJwk = signed.publicJwk;
    const bodyBytes = encoder.encode(rawBody);
    const multibyteStart = bodyBytes.indexOf(0xc3);
    assert.ok(multibyteStart > 0, "fixture must contain a split UTF-8 sequence");
    const chunks = [
      bodyBytes.slice(0, multibyteStart + 1),
      bodyBytes.slice(multibyteStart + 1),
    ];
    const exactStream = new ReadableStream({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const accepted = await handlePlaidWebhook(fixture.env, new Request(
      "https://brain.invalid/api/webhooks/plaid",
      {
        method: "POST",
        headers: { "Plaid-Verification": signed.jwt, "Content-Type": "application/json" },
        body: exactStream,
        duplex: "half",
      },
    ), { fetchImpl, now: stamp });
    assert.equal(accepted.status, 200);
    assert.equal(await accepted.text(), "accepted");
    assert.equal(fixture.first("SELECT body_sha256 FROM plaid_webhook_events").body_sha256,
      await sha256Hex(rawBody));
    assert.equal(provider.count("/webhook_verification_key/get"), 1);
  } finally {
    fixture.close();
  }
});

test("Plaid durable runtime closes response-loss, sync, webhook, fallback, and revocation boundaries", async () => {
  const fixture = await createProductFixture({
    env: {
      BANK_FEED_PROVIDER: "plaid",
      BANK_FEED_ENV: "sandbox",
      BANK_FEED_CLIENT_ID: "fixture-client-id",
      BANK_FEED_SECRET: "fixture-secret",
      BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
      BANK_FEED_ENTITY: "primary",
      BANK_FEED_RECONCILE_MINUTES: "360",
      BRAIN_NAME: "Sandbox Brain",
    },
  });
  const provider = new PlaidSandboxFake();
  const fetchImpl = provider.fetch.bind(provider);
  const stamp = "2026-08-30T13:00:00.000Z";
  try {
    seedOwnedEntity(fixture, "fixture-company", "Fixture Company");
    const ownerHeaders = await fixture.ownerHeaders();
    const linkUrl = new URL("https://brain.invalid/api/bank-feed/link-token");
    const linkRoute = (body) => handleBankFeed(fixture.env, new Request(linkUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ownerHeaders },
      body: JSON.stringify(body),
    }), linkUrl, linkUrl.pathname, { bankFeedFetchImpl: fetchImpl });
    const missingIdentity = await linkRoute({ mode: "connect" });
    assert.equal(missingIdentity.status, 400);
    assert.equal((await missingIdentity.json()).code, "plaid_link_request_id_required");
    assert.equal(provider.count("/link/token/create"), 0);

    // Ignore the first HTTP body to model the provider and D1 commit succeeding
    // while the browser loses the response. The same client identity must replay
    // the exact Link token without a second provider creation.
    const firstLinkResponse = await linkRoute({ request_id: "link-route-retry-0001", mode: "connect" });
    assert.equal(firstLinkResponse.status, 200);
    const firstLink = await firstLinkResponse.json();
    const replayedLinkResponse = await linkRoute({ request_id: "link-route-retry-0001", mode: "connect" });
    assert.equal(replayedLinkResponse.status, 200);
    const replayedLink = await replayedLinkResponse.json();
    assert.equal(firstLink.link_token, replayedLink.link_token);
    assert.equal(replayedLink.replayed, true);
    assert.equal(provider.count("/link/token/create"), 1);
    assert.equal(fixture.first("SELECT link_ciphertext LIKE '%link-sandbox%' AS leaked FROM plaid_link_operations").leaked, 0);

    const exchange = await completePlaidLink(fixture.env, {
      sessionRef: firstLink.session_ref,
      publicToken: "public-sandbox-once",
      institutionRef: "ins_fixture",
      institutionLabel: "Sandbox Bank",
      fetchImpl,
      now: stamp,
    });
    const replayedExchange = await completePlaidLink(fixture.env, {
      sessionRef: firstLink.session_ref,
      publicToken: "public-sandbox-once",
      fetchImpl,
      now: stamp,
    });
    assert.equal(exchange.item_ref, "item-sandbox-1");
    assert.deepEqual(replayedExchange, exchange);
    assert.equal(provider.count("/item/public_token/exchange"), 1);
    assert.equal(fixture.first("SELECT access_ciphertext LIKE '%access-sandbox%' AS leaked FROM bank_feed_items").leaked, 0);

    const ciphertextBeforeUpdate = fixture.first(
      "SELECT access_ciphertext FROM bank_feed_items WHERE item_ref='item-sandbox-1'",
    ).access_ciphertext;
    await createPlaidLinkToken(fixture.env, {
      url: "https://brain.invalid/app/connect/bank",
      mode: "reauthorise",
      itemRef: "item-sandbox-1",
      sessionRef: "session-update-request-1",
      fetchImpl,
      now: stamp,
    });
    provider.healthAvailable = false;
    await assert.rejects(completePlaidLink(fixture.env, {
      sessionRef: "session-update-request-1",
      publicToken: "ignored-update-public-token",
      fetchImpl,
      now: stamp,
    }));
    assert.equal(fixture.first(
      "SELECT status FROM bank_feed_items WHERE item_ref='item-sandbox-1'",
    ).status, "reauth_required");
    assert.equal(fixture.first(
      "SELECT state FROM plaid_link_operations WHERE session_ref='session-update-request-1'",
    ).state, "link_completed");
    provider.healthAvailable = true;
    const updateReceipt = await completePlaidLink(fixture.env, {
      sessionRef: "session-update-request-1",
      publicToken: "ignored-update-public-token",
      fetchImpl,
      now: stamp,
    });
    assert.equal(updateReceipt.exchanged, false);
    assert.equal(updateReceipt.health_verified, true);
    assert.equal(provider.count("/item/get"), 2);
    assert.equal(provider.count("/item/public_token/exchange"), 1);
    assert.equal(fixture.first(
      "SELECT access_ciphertext FROM bank_feed_items WHERE item_ref='item-sandbox-1'",
    ).access_ciphertext, ciphertextBeforeUpdate);

    const unassigned = await syncPlaidItem(fixture.env, "item-sandbox-1", { fetchImpl, now: stamp });
    assert.equal(unassigned.ok, false);
    assert.equal(unassigned.status, "assignment_required");
    assert.equal(unassigned.cursor_advanced, false);
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items WHERE item_ref='item-sandbox-1'").cursor, null);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 0);

    assert.equal(fixture.first("SELECT state FROM plaid_sync_windows WHERE item_ref='item-sandbox-1'").state, "ready");
    const accountRef = fixture.first(
      "SELECT account_ref FROM plaid_account_entity_assignments WHERE item_ref='item-sandbox-1'",
    ).account_ref;

    const statusUrl = new URL("https://brain.invalid/api/bank-feed/accounts");
    const statusResponse = await handleBankFeed(fixture.env, new Request(statusUrl, {
      headers: ownerHeaders,
    }), statusUrl, statusUrl.pathname, {});
    assert.equal(statusResponse.status, 200);
    const ownerStatus = await statusResponse.json();
    assert.equal(ownerStatus.state, "assignment_required");
    assert.equal(ownerStatus.accounts[0].account_ref, accountRef);
    assert.equal(ownerStatus.accounts[0].assignment.state, "assignment_required");
    assert.match(ownerStatus.accounts[0].masked_identifier, /ending 1234/);
    assert.equal(JSON.stringify(ownerStatus).includes("item-sandbox-1"), false);
    assert.equal(JSON.stringify(ownerStatus).includes("account-1"), false);

    const assignUrl = new URL("https://brain.invalid/api/bank-feed/accounts/assign");
    const assign = (body, headers = ownerHeaders) => handleBankFeed(fixture.env, new Request(assignUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }), assignUrl, assignUrl.pathname, {});
    const noAdminFallback = await assign({
      request_id: "assign-account-request-0001",
      account_ref: accountRef,
      entity_slug: "fixture-company",
    }, { "X-Admin-Key": fixture.env.ADMIN_KEY });
    assert.equal(noAdminFallback.status, 401);
    const assignment = await assign({
      request_id: "assign-account-request-0001",
      account_ref: accountRef,
      entity_slug: "fixture-company",
    });
    assert.equal(assignment.status, 201);
    assert.equal((await assignment.json()).changed, true);
    const assignmentReplay = await assign({
      request_id: "assign-account-request-0001",
      account_ref: accountRef,
      entity_slug: "fixture-company",
    });
    assert.equal(assignmentReplay.status, 200);
    assert.equal((await assignmentReplay.json()).replayed, true);
    assert.equal(fixture.first(
      "SELECT COUNT(*) AS n FROM owner_activity_events WHERE event_type='bank_account_entity_assigned'",
    ).n, 1);

    fixture.control.failOn = /UPDATE bank_feed_items SET cursor=/;
    const interrupted = await syncPlaidItem(fixture.env, "item-sandbox-1", { fetchImpl, now: stamp });
    assert.equal(interrupted.ok, false);
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items WHERE item_ref='item-sandbox-1'").cursor, null);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 0);
    assert.equal(fixture.first("SELECT state FROM plaid_sync_windows WHERE item_ref='item-sandbox-1'").state, "ready");
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM plaid_sync_stage_transactions").n, 3);
    fixture.control.failOn = null;
    const synced = await syncPlaidItem(fixture.env, "item-sandbox-1", { fetchImpl, now: stamp });
    assert.equal(synced.ok, true);
    assert.equal(synced.mutationRestarts, 1);
    assert.equal(synced.resumed_promotion, true);
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items WHERE item_ref='item-sandbox-1'").cursor, "complete-1");
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM plaid_sync_windows").n, 0);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM plaid_sync_stage_transactions").n, 0);
    const pending = fixture.first("SELECT pending,removed_at FROM fin_transactions WHERE external_id='pending-1'");
    const posted = fixture.first(
      `SELECT pending_transaction_id,source_iso_currency_code,source_unofficial_currency_code,
              source_provider,source_window_ref,source_page_index
         FROM fin_transactions WHERE external_id='posted-1'`,
    );
    assert.equal(pending.pending, 1);
    assert.ok(pending.removed_at);
    assert.equal(posted.pending_transaction_id, "pending-1");
    assert.equal(posted.source_unofficial_currency_code, null);
    assert.equal(posted.source_iso_currency_code, "USD");
    assert.equal(posted.source_provider, "plaid");
    assert.ok(posted.source_window_ref);
    assert.equal(posted.source_page_index, 1);
    assert.equal(fixture.first(
      "SELECT entity_slug FROM fin_accounts WHERE external_ref='account-1'",
    ).entity_slug, "fixture-company");

    const rawBody = JSON.stringify({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "item-sandbox-1",
    });
    const issuedAt = Math.floor(Date.parse(stamp) / 1000);
    const publicRouteRefusal = await fixture.worker.fetch(new Request(
      "https://brain.invalid/api/webhooks/plaid",
      { method: "POST", body: rawBody },
    ), fixture.env, { waitUntil() {} });
    assert.equal(publicRouteRefusal.status, 401);
    const signed = await signedWebhook(rawBody, issuedAt);
    signed.publicJwk.expired_at = issuedAt + 60;
    provider.publicJwk = signed.publicJwk;
    const request = () => new Request("https://brain.invalid/api/webhooks/plaid", {
      method: "POST",
      headers: { "Plaid-Verification": signed.jwt, "Content-Type": "application/json" },
      body: rawBody,
    });
    fixture.raw("DELETE FROM plaid_reconciliation WHERE item_ref='item-sandbox-1'");
    fixture.control.failNextBatch = true;
    await assert.rejects(handlePlaidWebhook(fixture.env, request(), { fetchImpl, now: stamp }));
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM plaid_webhook_events").n, 0);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM plaid_reconciliation").n, 0);

    assert.equal((await handlePlaidWebhook(fixture.env, request(), { fetchImpl, now: stamp })).status, 200);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM plaid_webhook_events").n, 1);
    assert.equal(fixture.first("SELECT state FROM plaid_reconciliation WHERE item_ref='item-sandbox-1'").state, "pending");
    assert.equal(fixture.first(
      "SELECT expires_at FROM plaid_webhook_keys WHERE key_id='fixture-plaid-key'",
    ).expires_at, new Date((issuedAt + 60) * 1000).toISOString());
    assert.equal(provider.count("/webhook_verification_key/get"), 1);

    fixture.raw("DELETE FROM plaid_reconciliation WHERE item_ref='item-sandbox-1'");
    assert.equal((await handlePlaidWebhook(fixture.env, request(), { fetchImpl, now: stamp })).status, 200);
    assert.equal(fixture.first(
      "SELECT reason FROM plaid_reconciliation WHERE item_ref='item-sandbox-1'",
    ).reason, "webhook_replay_repair");
    assert.equal(provider.count("/webhook_verification_key/get"), 1);

    fixture.raw(
      "UPDATE plaid_webhook_keys SET expires_at='2026-08-30T12:59:59.000Z' WHERE key_id='fixture-plaid-key'",
    );
    assert.equal((await handlePlaidWebhook(fixture.env, request(), { fetchImpl, now: stamp })).status, 200);
    assert.equal(provider.count("/webhook_verification_key/get"), 2);

    fixture.raw("DELETE FROM plaid_webhook_keys WHERE key_id='fixture-plaid-key'");
    provider.publicJwk.expired_at = issuedAt - 1;
    assert.equal((await handlePlaidWebhook(fixture.env, request(), { fetchImpl, now: stamp })).status, 401);
    assert.equal(provider.count("/webhook_verification_key/get"), 3);
    provider.publicJwk.expired_at = issuedAt + 60;

    const scheduled = await runPlaidFeedSlice(fixture.env, { maxItems: 1, fetchImpl, now: stamp });
    assert.equal(scheduled.ran, 1);
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items WHERE item_ref='item-sandbox-1'").cursor, "complete-2");

    const firstDisconnect = await disconnectPlaidItem(fixture.env, "item-sandbox-1", { fetchImpl, now: stamp });
    assert.equal(firstDisconnect.revocation_state, "unknown");
    assert.equal(firstDisconnect.outcome_unknown, true);
    assert.equal(firstDisconnect.retry_safe, false);
    assert.equal(provider.count("/item/remove"), 1);
    assert.equal(fixture.first(
      "SELECT outcome_state FROM plaid_revocation_outbox WHERE item_ref='item-sandbox-1'",
    ).outcome_state, "unknown");
    assert.notEqual(fixture.first("SELECT access_ciphertext FROM bank_feed_items WHERE item_ref='item-sandbox-1'").access_ciphertext,
      "REMOVED0000000000000000");
    provider.healthAvailable = false;
    fixture.raw("UPDATE plaid_revocation_outbox SET next_attempt_at=? WHERE item_ref='item-sandbox-1'", stamp);
    const unresolved = await drainPlaidRevocations(fixture.env, { maxItems: 1, fetchImpl, now: stamp });
    assert.equal(unresolved.items[0].outcome_unknown, true);
    assert.equal(provider.count("/item/remove"), 1);
    provider.healthAvailable = true;
    provider.removeAvailable = true;
    fixture.raw("UPDATE plaid_revocation_outbox SET next_attempt_at=? WHERE item_ref='item-sandbox-1'", stamp);
    const drained = await drainPlaidRevocations(fixture.env, { maxItems: 1, fetchImpl, now: stamp });
    assert.equal(drained.items[0].confirmed, true);
    assert.equal(drained.items[0].outcome_state, "confirmed");
    assert.equal(provider.count("/item/remove"), 2);
    assert.equal(provider.count("/item/get"), 4);
    assert.equal(fixture.first("SELECT access_ciphertext FROM bank_feed_items WHERE item_ref='item-sandbox-1'").access_ciphertext,
      "REMOVED0000000000000000");
    const status = await plaidFeedStatus(fixture.env);
    assert.equal(status.provider, "plaid");
    assert.equal(status.environment, "sandbox");
  } finally {
    fixture.close();
  }
});

test("a lost public-token exchange response is single-shot and explicitly recoverable", async () => {
  const fixture = await createProductFixture({
    env: {
      BANK_FEED_PROVIDER: "plaid",
      BANK_FEED_ENV: "sandbox",
      BANK_FEED_CLIENT_ID: "fixture-client-id",
      BANK_FEED_SECRET: "fixture-secret",
      BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
      BRAIN_NAME: "Sandbox Brain",
    },
  });
  const provider = new PlaidSandboxFake();
  provider.exchangeAvailable = false;
  const fetchImpl = provider.fetch.bind(provider);
  const ownerHeaders = await fixture.ownerHeaders();
  const route = async (path, body) => {
    const url = new URL(`https://brain.invalid${path}`);
    return handleBankFeed(fixture.env, new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ownerHeaders },
      body: JSON.stringify(body),
    }), url, path, { bankFeedFetchImpl: fetchImpl });
  };
  try {
    const link = await (await route("/api/bank-feed/link-token", {
      request_id: "lost-exchange-route-0001",
      mode: "connect",
    })).json();
    const exchangeBody = {
      session_ref: link.session_ref,
      public_token: "public-sandbox-once",
    };
    const first = await route("/api/bank-feed/exchange", exchangeBody);
    assert.equal(first.status, 503);
    const firstBody = await first.json();
    assert.equal(firstBody.code, "PLAID_EXCHANGE_OUTCOME_UNKNOWN");
    assert.equal(firstBody.outcome_unknown, true);
    assert.equal(firstBody.retry_safe, false);
    assert.match(firstBody.recovery, /review this connection/);
    assert.equal(provider.count("/item/public_token/exchange"), 1);

    const replay = await route("/api/bank-feed/exchange", exchangeBody);
    assert.equal(replay.status, 503);
    assert.equal((await replay.json()).outcome_unknown, true);
    assert.equal(provider.count("/item/public_token/exchange"), 1);
    assert.equal(fixture.first(
      "SELECT state FROM plaid_link_operations WHERE session_ref='lost-exchange-route-0001'",
    ).state, "exchange_started");
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM bank_feed_items").n, 0);
  } finally {
    fixture.close();
  }
});

test("concurrent exchange retries atomically claim one single-use public token", async () => {
  const fixture = await createProductFixture({
    env: {
      BANK_FEED_PROVIDER: "plaid",
      BANK_FEED_ENV: "sandbox",
      BANK_FEED_CLIENT_ID: "fixture-client-id",
      BANK_FEED_SECRET: "fixture-secret",
      BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
      BRAIN_NAME: "Sandbox Brain",
    },
  });
  const provider = new PlaidSandboxFake();
  provider.exchangeDelayMs = 25;
  const fetchImpl = provider.fetch.bind(provider);
  const ownerHeaders = await fixture.ownerHeaders();
  const route = (path, body) => {
    const url = new URL(`https://brain.invalid${path}`);
    return handleBankFeed(fixture.env, new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ownerHeaders },
      body: JSON.stringify(body),
    }), url, path, { bankFeedFetchImpl: fetchImpl });
  };
  try {
    const link = await (await route("/api/bank-feed/link-token", {
      request_id: "concurrent-exchange-0001",
      mode: "connect",
    })).json();
    const exchangeBody = {
      session_ref: link.session_ref,
      public_token: "public-sandbox-once",
    };
    const responses = await Promise.all([
      route("/api/bank-feed/exchange", exchangeBody),
      route("/api/bank-feed/exchange", exchangeBody),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 503]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    const unknown = bodies.find((body) => body.outcome_unknown === true);
    assert.equal(unknown.code, "PLAID_EXCHANGE_OUTCOME_UNKNOWN");
    assert.equal(unknown.retry_safe, false);
    assert.equal(provider.count("/item/public_token/exchange"), 1);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM bank_feed_items").n, 1);

    const durableReplay = await route("/api/bank-feed/exchange", exchangeBody);
    assert.equal(durableReplay.status, 200);
    assert.equal((await durableReplay.json()).item_ref, "item-sandbox-1");
    assert.equal(provider.count("/item/public_token/exchange"), 1);
  } finally {
    fixture.close();
  }
});

test("empty Transactions Sync stays partial through NOT_READY and INITIAL provider states", async () => {
  const fixture = await createProductFixture({
    env: {
      BANK_FEED_PROVIDER: "plaid",
      BANK_FEED_ENV: "sandbox",
      BANK_FEED_CLIENT_ID: "fixture-client-id",
      BANK_FEED_SECRET: "fixture-secret",
      BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
      BRAIN_NAME: "Sandbox Brain",
    },
  });
  const provider = new PlaidSandboxFake();
  provider.historySequence = [
    "NOT_READY",
    "INITIAL_UPDATE_COMPLETE",
    "HISTORICAL_UPDATE_COMPLETE",
  ];
  const fetchImpl = provider.fetch.bind(provider);
  const stamp = "2026-08-30T13:00:00.000Z";
  try {
    seedOwnedEntity(fixture, "fixture-company", "Fixture Company");
    const link = await createPlaidLinkToken(fixture.env, {
      url: "https://brain.invalid/app/connect/bank",
      sessionRef: "empty-history-link-0001",
      fetchImpl,
      now: stamp,
    });
    await completePlaidLink(fixture.env, {
      sessionRef: link.session_ref,
      publicToken: "public-sandbox-once",
      fetchImpl,
      now: stamp,
    });
    fixture.raw(
      `INSERT INTO bank_feed_backfill
         (tenant_id,item_ref,requested_days,state,queued_at,started_at,provider_history_state)
       VALUES ('primary','item-sandbox-2',730,'running',?,?,?)`,
      stamp, stamp, "NOT_READY",
    );

    const firstSlice = await runPlaidFeedSlice(fixture.env, { maxItems: 1, fetchImpl, now: stamp });
    assert.equal(firstSlice.ran, 1);
    assert.equal(firstSlice.items[0].status, "assignment_required");
    assert.equal(firstSlice.items[0].cursor_advanced, false);
    const accountRef = fixture.first(
      "SELECT account_ref FROM plaid_account_entity_assignments WHERE item_ref='item-sandbox-1'",
    ).account_ref;
    const ownerHeaders = await fixture.ownerHeaders();
    const assignUrl = new URL("https://brain.invalid/api/bank-feed/accounts/assign");
    const assigned = await handleBankFeed(fixture.env, new Request(assignUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ownerHeaders },
      body: JSON.stringify({
        request_id: "empty-history-assignment-0001",
        account_ref: accountRef,
        entity_slug: "fixture-company",
      }),
    }), assignUrl, assignUrl.pathname, {});
    assert.equal(assigned.status, 201);

    const notReady = await syncPlaidItem(fixture.env, "item-sandbox-1", { fetchImpl, now: stamp });
    assert.equal(notReady.ok, false);
    assert.equal(notReady.partial, true);
    assert.equal(notReady.history_state, "running");
    assert.equal(notReady.provider_history_state, "NOT_READY");
    const notReadyBackfill = fixture.first(
      "SELECT state,provider_history_state,finished_at FROM bank_feed_backfill WHERE item_ref='item-sandbox-1'",
    );
    assert.equal(notReadyBackfill.state, "running");
    assert.equal(notReadyBackfill.provider_history_state, "NOT_READY");
    assert.equal(notReadyBackfill.finished_at, null);
    assert.equal(fixture.first(
      "SELECT reason FROM plaid_reconciliation WHERE item_ref='item-sandbox-1'",
    ).reason, "history_pending");
    const partialStatus = await plaidFeedStatus(fixture.env);
    assert.equal(partialStatus.connections[0].history.state, "running");
    assert.equal(partialStatus.connections[0].history.provider_history_state, "NOT_READY");
    assert.equal(partialStatus.connections[0].history.partial, true);

    const initial = await syncPlaidItem(fixture.env, "item-sandbox-1", { fetchImpl, now: stamp });
    assert.equal(initial.ok, false);
    assert.equal(initial.partial, true);
    assert.equal(initial.history_state, "running");
    assert.equal(initial.provider_history_state, "INITIAL_UPDATE_COMPLETE");
    assert.equal(fixture.first(
      "SELECT provider_history_state FROM bank_feed_backfill WHERE item_ref='item-sandbox-1'",
    ).provider_history_state, "INITIAL_UPDATE_COMPLETE");

    const historical = await syncPlaidItem(fixture.env, "item-sandbox-1", { fetchImpl, now: stamp });
    assert.equal(historical.ok, true);
    assert.equal(historical.partial, false);
    assert.equal(historical.history_state, "complete");
    assert.equal(historical.provider_history_state, "HISTORICAL_UPDATE_COMPLETE");
    const completeBackfill = fixture.first(
      "SELECT state,provider_history_state,finished_at FROM bank_feed_backfill WHERE item_ref='item-sandbox-1'",
    );
    assert.equal(completeBackfill.state, "complete");
    assert.equal(completeBackfill.provider_history_state, "HISTORICAL_UPDATE_COMPLETE");
    assert.equal(completeBackfill.finished_at, stamp);
    const untouchedItem = fixture.first(
      "SELECT state,provider_history_state,finished_at FROM bank_feed_backfill WHERE item_ref='item-sandbox-2'",
    );
    assert.equal(untouchedItem.state, "running");
    assert.equal(untouchedItem.provider_history_state, "NOT_READY");
    assert.equal(untouchedItem.finished_at, null);
  } finally {
    fixture.close();
  }
});

test("scheduled promotion keeps two Plaid accounts in their exact owner-confirmed entities", async () => {
  const fixture = await createProductFixture({
    env: {
      BANK_FEED_PROVIDER: "plaid",
      BANK_FEED_ENV: "sandbox",
      BANK_FEED_CLIENT_ID: "fixture-client-id",
      BANK_FEED_SECRET: "fixture-secret",
      BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
      // This legacy Item-level value is intentionally wrong. Promotion must
      // never consult it or fall back to primary.
      BANK_FEED_ENTITY: "wrong-default",
      BRAIN_NAME: "Sandbox Brain",
    },
  });
  const provider = new MultiEntityPlaidFake();
  const fetchImpl = provider.fetch.bind(provider);
  const stamp = new Date().toISOString();
  const later = minutes => new Date(Date.parse(stamp) + minutes * 60_000).toISOString();
  try {
    seedOwnedEntity(fixture, "household", "Household");
    seedOwnedEntity(fixture, "operating-company", "Operating Company");
    seedOwnedEntity(fixture, "closed-company", "Closed Company");
    seedCounterparty(fixture, "outside-buyer");
    fixture.raw("UPDATE fin_entities SET status='closed' WHERE entity_slug='closed-company'");
    const link = await createPlaidLinkToken(fixture.env, {
      url: "https://brain.invalid/app/connect/bank",
      sessionRef: "multi-entity-link-0001",
      fetchImpl,
      now: stamp,
    });
    await completePlaidLink(fixture.env, {
      sessionRef: link.session_ref,
      publicToken: "public-sandbox-once",
      institutionLabel: "Two-Scope Bank",
      fetchImpl,
      now: stamp,
    });

    const staged = await runPlaidFeedSlice(fixture.env, { maxItems: 1, fetchImpl, now: stamp });
    assert.equal(staged.items[0].status, "assignment_required");
    assert.equal(staged.items[0].assignments_remaining, 2);
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items").cursor, null);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_accounts").n, 0);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 0);

    // Schema 30 can arrive after an older Worker has staged a ready window.
    // Rebuild only the opaque owner refs from D1, without another provider read,
    // and keep the cursor blocked for assignment.
    const accountReadsBeforeResume = provider.count("/accounts/get");
    fixture.raw("DELETE FROM plaid_account_entity_assignments");
    const resumedInventory = await runPlaidFeedSlice(fixture.env, { maxItems: 1, fetchImpl, now: later(6) });
    assert.equal(resumedInventory.items[0].status, "assignment_required");
    assert.equal(resumedInventory.items[0].assignments_remaining, 2);
    assert.equal(provider.count("/accounts/get"), accountReadsBeforeResume);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM plaid_account_entity_assignments").n, 2);
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items").cursor, null);

    const refs = fixture.rows(
      "SELECT provider_account_id,account_ref FROM plaid_account_entity_assignments ORDER BY provider_account_id",
    );
    const byProvider = Object.fromEntries(refs.map((row) => [row.provider_account_id, row.account_ref]));
    const ownerHeaders = await fixture.ownerHeaders();
    const assignUrl = new URL("https://brain.invalid/api/bank-feed/accounts/assign");
    const assign = (requestId, accountRef, entitySlug) => handleBankFeed(
      fixture.env,
      new Request(assignUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...ownerHeaders },
        body: JSON.stringify({ request_id: requestId, account_ref: accountRef, entity_slug: entitySlug }),
      }),
      assignUrl,
      assignUrl.pathname,
      {},
    );

    const closed = await assign(
      "multi-entity-closed-0001",
      byProvider["business-account-internal"],
      "closed-company",
    );
    assert.equal(closed.status, 404);
    const counterparty = await assign(
      "multi-entity-counterparty-0001",
      byProvider["business-account-internal"],
      "outside-buyer",
    );
    assert.equal(counterparty.status, 403);
    assert.equal((await counterparty.json()).code, "entity_not_owned");

    const household = await assign(
      "multi-entity-household-0001",
      byProvider["household-account-internal"],
      "household",
    );
    assert.equal(household.status, 201);
    const requestConflict = await assign(
      "multi-entity-household-0001",
      byProvider["household-account-internal"],
      "operating-company",
    );
    assert.equal(requestConflict.status, 409);
    assert.equal((await requestConflict.json()).code, "request_id_conflict");
    const unchanged = await assign(
      "multi-entity-household-unchanged-0001",
      byProvider["household-account-internal"],
      "household",
    );
    assert.equal(unchanged.status, 200);
    assert.deepEqual(await unchanged.json(), {
      assigned: true,
      request_id: "multi-entity-household-unchanged-0001",
      account_ref: byProvider["household-account-internal"],
      masked_identifier: "Household checking ending 1111",
      entity_scope: { entity_slug: "household" },
      entity_label: "Household",
      changed: false,
      activity_event_id: null,
      replayed: false,
    });

    // Model a commit failure before any assignment/event/receipt can land,
    // followed by an unchanged retry carrying the same identity.
    fixture.control.failNextBatch = true;
    const lost = await assign(
      "multi-entity-business-0001",
      byProvider["business-account-internal"],
      "operating-company",
    );
    assert.equal(lost.status, 503);
    assert.equal(fixture.first(
      "SELECT entity_slug FROM plaid_account_entity_assignments WHERE provider_account_id='business-account-internal'",
    ).entity_slug, null);
    const business = await assign(
      "multi-entity-business-0001",
      byProvider["business-account-internal"],
      "operating-company",
    );
    assert.equal(business.status, 201);
    const businessBody = await business.json();
    assert.equal(businessBody.account_ref, byProvider["business-account-internal"]);
    assert.equal(JSON.stringify(businessBody).includes("business-account-internal"), false);

    // A scope that becomes non-live after assignment blocks the already-ready
    // window. Restoring that reviewed entity lets the same scheduled debt
    // promote without asking Plaid for another page.
    fixture.raw("UPDATE fin_entities SET status='closed' WHERE entity_slug='operating-company'");
    const invalidScope = await runPlaidFeedSlice(fixture.env, { maxItems: 1, fetchImpl, now: later(12) });
    assert.equal(invalidScope.items[0].status, "assignment_required");
    assert.equal(invalidScope.items[0].invalid_assignments, 1);
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items").cursor, null);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 0);
    fixture.raw("UPDATE fin_entities SET status='active' WHERE entity_slug='operating-company'");

    const promoted = await runPlaidFeedSlice(fixture.env, { maxItems: 1, fetchImpl, now: later(18) });
    assert.equal(promoted.items[0].ok, true);
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items").cursor, "multi-entity-complete");
    const assignments = fixture.rows(
      `SELECT f.external_ref,f.entity_slug,t.external_id
         FROM fin_accounts f JOIN fin_transactions t
           ON t.tenant_id=f.tenant_id AND t.account_slug=f.account_slug
        ORDER BY f.external_ref`,
    ).map((row) => ({ ...row }));
    assert.deepEqual(assignments, [
      {
        external_ref: "business-account-internal",
        entity_slug: "operating-company",
        external_id: "business-transaction-internal",
      },
      {
        external_ref: "household-account-internal",
        entity_slug: "household",
        external_id: "household-transaction-internal",
      },
    ]);
    assert.equal(assignments.some((row) => row.entity_slug === "wrong-default" || row.entity_slug === "primary"), false);
    assert.equal(fixture.first(
      "SELECT COUNT(*) AS n FROM owner_activity_events WHERE event_type='bank_account_entity_assigned'",
    ).n, 2);

    // A ledger row lands after preflight but before the assignment batch. The
    // in-batch guard refuses historical reclassification. A retry gives the
    // same stable code and neither attempt creates a receipt or human event.
    fixture.raw("DELETE FROM fin_transactions WHERE external_id='business-transaction-internal'");
    fixture.raw("DELETE FROM fin_balance_snapshots WHERE account_slug IN (SELECT account_slug FROM fin_accounts WHERE external_ref='business-account-internal')");
    const originalDb = fixture.env.DB;
    let injectedHistory = false;
    fixture.env.DB = {
      ...originalDb,
      async batch(statements) {
        if (!injectedHistory) {
          injectedHistory = true;
          const businessAccountSlug = fixture.first(
            "SELECT account_slug FROM fin_accounts WHERE external_ref='business-account-internal'",
          ).account_slug;
          fixture.raw(
            `INSERT INTO fin_transactions
               (tenant_id,txn_uid,account_slug,posted_on,amount_minor,direction,currency,
                description,provenance,source_feed,basis_state,recorded_at)
             VALUES ('primary','plaid:assignment-race',?,'2026-08-30',100,'outflow','USD',
                     'Synthetic assignment race','feed','bank-feed:item-sandbox-1','confirmed',?)`,
            businessAccountSlug,
            stamp,
          );
        }
        return originalDb.batch(statements);
      },
    };
    let raced;
    try {
      raced = await assign(
        "multi-entity-race-0001",
        byProvider["business-account-internal"],
        "household",
      );
    } finally {
      fixture.env.DB = originalDb;
    }
    assert.equal(injectedHistory, true);
    assert.equal(raced.status, 409);
    assert.equal((await raced.json()).code, "bank_account_reassignment_requires_review");
    const racedRetry = await assign(
      "multi-entity-race-0001",
      byProvider["business-account-internal"],
      "household",
    );
    assert.equal(racedRetry.status, 409);
    assert.equal((await racedRetry.json()).code, "bank_account_reassignment_requires_review");
    assert.equal(fixture.first(
      "SELECT entity_slug FROM plaid_account_entity_assignments WHERE provider_account_id='business-account-internal'",
    ).entity_slug, "operating-company");
    assert.equal(fixture.first(
      "SELECT COUNT(*) AS n FROM owner_action_requests WHERE request_id='multi-entity-race-0001'",
    ).n, 0);
    assert.equal(fixture.first(
      "SELECT COUNT(*) AS n FROM owner_activity_events WHERE request_id='multi-entity-race-0001'",
    ).n, 0);
  } finally {
    fixture.close();
  }
});

test("owner account status reports D1 failure as unavailable instead of empty", async () => {
  const fixture = await createProductFixture({
    env: {
      BANK_FEED_PROVIDER: "plaid",
      BANK_FEED_ENV: "sandbox",
      BANK_FEED_CLIENT_ID: "fixture-client-id",
      BANK_FEED_SECRET: "fixture-secret",
      BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
    },
  });
  try {
    const ownerHeaders = await fixture.ownerHeaders();
    fixture.control.failOn = /FROM bank_feed_items i\s+WHERE i\.tenant_id=\?/;
    const response = await fixture.worker.fetch(new Request(
      "https://brain.invalid/api/bank-feed/accounts",
      { headers: ownerHeaders },
    ), fixture.env, { waitUntil() {} });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error, "unavailable");
    assert.equal(body.code, "bank_account_status_unavailable");
    assert.equal(body.unavailable, true);
    assert.equal(Object.hasOwn(body, "accounts"), false);
  } finally {
    fixture.close();
  }
});

test("owner account status refuses a partial inventory that could hide another Item", async () => {
  const fixture = await createProductFixture({
    env: {
      BANK_FEED_PROVIDER: "plaid",
      BANK_FEED_ENV: "sandbox",
      BANK_FEED_CLIENT_ID: "fixture-client-id",
      BANK_FEED_SECRET: "fixture-secret",
      BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
    },
  });
  try {
    for (const [itemRef, label] of [
      ["item-with-inventory", "Visible fixture bank"],
      ["item-without-inventory", "Missing fixture bank"],
    ]) {
      fixture.raw(
        `INSERT INTO bank_feed_items
           (tenant_id,item_ref,institution_label,access_ciphertext,access_iv,key_version,
            environment,status,connected_at)
         VALUES ('primary',?,?,'AAAAAAAAAAAAAAAA','BBBBBBBB',2,
                 'sandbox','connected','2026-08-30T00:00:00Z')`,
        itemRef,
        label,
      );
    }
    fixture.raw(
      `INSERT INTO plaid_account_entity_assignments
         (tenant_id,item_ref,provider_account_id,account_ref,entity_slug,
          discovered_at,last_seen_at,assigned_at,updated_at)
       VALUES ('primary','item-with-inventory','provider-account-private',
               'acct_0123456789abcdef0123456789abcdef',NULL,
               '2026-08-30T00:00:00Z','2026-08-30T00:00:00Z',NULL,
               '2026-08-30T00:00:00Z')`,
    );
    const ownerHeaders = await fixture.ownerHeaders();
    const response = await fixture.worker.fetch(new Request(
      "https://brain.invalid/api/bank-feed/accounts",
      { headers: ownerHeaders },
    ), fixture.env, { waitUntil() {} });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error, "unavailable");
    assert.equal(body.code, "plaid_account_inventory_unavailable");
    assert.equal(body.unavailable, true);
    assert.equal(Object.hasOwn(body, "accounts"), false);
    assert.equal(JSON.stringify(body).includes("item-without-inventory"), false);
  } finally {
    fixture.close();
  }
});

// Adversarial provider identities and staged-window containment use the actual
// runtime and SQLite. Every identifier and financial row here is synthetic.
async function containmentFixture(accountIds, page = {}) {
  const fixture = await createProductFixture({ env: {
    BANK_FEED_PROVIDER: "plaid", BANK_FEED_ENV: "sandbox",
    BANK_FEED_CLIENT_ID: "fixture-client-id", BANK_FEED_SECRET: "fixture-secret",
    BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`, BRAIN_NAME: "Sandbox Brain",
  } });
  seedOwnedEntity(fixture, "household", "Household");
  seedOwnedEntity(fixture, "business", "Business");
  const provider = new PlaidSandboxFake();
  const state = { page: {
    added: accountIds.map((account_id, index) => ({
      transaction_id: `identity-transaction-${index}`, account_id, amount: "12.00",
      iso_currency_code: "USD", date: "2026-08-30", pending: false, name: "Synthetic identity fixture",
    })), modified: [], removed: [], next_cursor: "identity-complete", has_more: false,
    transactions_update_status: "HISTORICAL_UPDATE_COMPLETE", ...page,
  }, now: "2026-08-30T13:00:00.000Z", accounts: accountIds.map((account_id, index) => ({
    account_id, name: `Synthetic account ${index}`, mask: String(1000 + index),
    type: "depository", subtype: "checking", balances: { current: "100.00", iso_currency_code: "USD" },
  })) };
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/accounts/get") return jsonResponse({ accounts: state.accounts });
    if (path === "/transactions/sync") return jsonResponse(state.page);
    return provider.fetch(url, init);
  };
  const now = "2026-08-30T13:00:00.000Z";
  const link = await createPlaidLinkToken(fixture.env, {
    url: "https://brain.invalid/app/connect/bank", sessionRef: "identity-contained-link-0001", fetchImpl, now,
  });
  await completePlaidLink(fixture.env, {
    sessionRef: link.session_ref, publicToken: "public-sandbox-once", fetchImpl, now,
  });
  const run = () => syncPlaidItem(fixture.env, "item-sandbox-1", { fetchImpl, now: state.now });
  const assignAll = async () => {
    const { assignPlaidAccountEntity } = await import("../src/lib/plaid-account-entities.js");
    for (const [index, account] of fixture.rows(
      "SELECT account_ref FROM plaid_account_entity_assignments ORDER BY provider_account_id",
    ).entries()) {
      await assignPlaidAccountEntity(fixture.env, {
        request_id: `identity-assignment-${index}`, account_ref: account.account_ref,
        entity_slug: index % 2 ? "business" : "household",
      }, { now });
    }
  };
  return { fixture, state, run, assignAll };
}

function seedIdentityLedgerAccount(fixture, { slug, external, source = "bank-feed:item-sandbox-1", entity = "household" }) {
  fixture.raw(`INSERT INTO fin_accounts
    (tenant_id,account_slug,entity_slug,label,account_kind,balance_role,external_ref,
     provenance,source_feed,basis_state,recorded_at)
    VALUES ('primary',?,?,'Synthetic existing account','checking','asset',?,'feed',?,'confirmed','2026-08-01')`,
  slug, entity, external, source);
}
function seedIdentityLedgerTransaction(fixture, { uid, external, account, source, pending = 0 }) {
  fixture.raw(`INSERT INTO fin_transactions
    (tenant_id,txn_uid,account_slug,posted_on,amount_minor,direction,currency,description,
     external_id,pending,provenance,source_feed,basis_state,recorded_at)
    VALUES ('primary',?,?,'2026-08-01',100,'outflow','USD','Synthetic existing history',?,?,
            'feed',?,'confirmed','2026-08-01')`, uid, account, external, pending, source);
}
const oldAccountSlug = (accountId) => `plaid-item-sandbox-1-${accountId}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 64);

test("long and case-sensitive Plaid identities retain four distinct account scopes", async () => {
  const ids = [`${"shared-prefix-".repeat(5)}a`, `${"shared-prefix-".repeat(5)}b`, "CaseSensitive", "casesensitive"];
  const { fixture, run, assignAll } = await containmentFixture(ids);
  try {
    assert.equal((await run()).status, "assignment_required");
    await assignAll();
    assert.equal((await run()).ok, true);
    const accounts = fixture.rows("SELECT account_slug,external_ref,entity_slug FROM fin_accounts ORDER BY external_ref");
    assert.equal(accounts.length, 4);
    assert.equal(new Set(accounts.map(row => row.account_slug)).size, 4);
    assert.deepEqual(accounts.map(row => row.external_ref).sort(), [...ids].sort());
    assert.equal(fixture.first(`SELECT COUNT(*) AS n FROM fin_transactions t
      JOIN fin_accounts f ON f.tenant_id=t.tenant_id AND f.account_slug=t.account_slug
      JOIN plaid_account_entity_assignments a ON a.tenant_id=f.tenant_id AND a.provider_account_id=f.external_ref
       AND a.item_ref='item-sandbox-1' AND a.entity_slug=f.entity_slug`).n, 4);
  } finally { fixture.close(); }
});

test("legacy ledger mapping survives a stored ready window without moving history", async () => {
  const { fixture, run, assignAll } = await containmentFixture(["legacy-account"]);
  try {
    assert.equal((await run()).status, "assignment_required");
    const legacy = oldAccountSlug("legacy-account");
    seedIdentityLedgerAccount(fixture, { slug: legacy, external: "legacy-account" });
    seedIdentityLedgerTransaction(fixture, { uid: "existing-legacy-history", external: "older", account: legacy, source: "bank-feed:item-sandbox-1" });
    fixture.raw("UPDATE plaid_sync_stage_accounts SET account_slug=?", legacy);
    fixture.raw("UPDATE plaid_sync_stage_transactions SET account_slug=?", legacy);
    await assignAll();
    assert.equal((await run()).ok, true);
    assert.deepEqual(fixture.rows("SELECT DISTINCT account_slug FROM fin_transactions").map(row => row.account_slug), [legacy]);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_accounts").n, 1);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions WHERE txn_uid='existing-legacy-history'").n, 1);
  } finally { fixture.close(); }
});

test("an existing lossy Plaid collision is held without reassigning its ledger", async () => {
  const ids = [`${"shared-prefix-".repeat(5)}a`, `${"shared-prefix-".repeat(5)}b`];
  const { fixture, run } = await containmentFixture(ids);
  try {
    const legacy = oldAccountSlug(ids[0]);
    assert.equal(legacy, oldAccountSlug(ids[1]));
    seedIdentityLedgerAccount(fixture, { slug: legacy, external: ids[0] });
    seedIdentityLedgerTransaction(fixture, { uid: "existing-collision-history", external: "older", account: legacy, source: "bank-feed:item-sandbox-1" });
    const result = await run();
    assert.equal(result.ok, false);
    assert.equal(result.code, "plaid_account_identity_conflict");
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items").cursor, null);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_accounts").n, 1);
    assert.equal(fixture.first("SELECT entity_slug FROM fin_accounts").entity_slug, "household");
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 1);
  } finally { fixture.close(); }
});

test("an unknown transaction account cannot promote a reviewed Plaid window", async () => {
  const { fixture, run, assignAll } = await containmentFixture(["known-account"], { added: [{
    transaction_id: "orphan-transaction", account_id: "absent-account", amount: "12.00",
    iso_currency_code: "USD", date: "2026-08-30", pending: false, name: "Synthetic unknown account",
  }] });
  try {
    await run();
    await assignAll();
    const result = await run();
    assert.equal(result.ok, false);
    assert.equal(result.code, "plaid_transaction_account_unreviewed");
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items").cursor, null);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_accounts").n, 0);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 0);
  } finally { fixture.close(); }
});

test("Plaid removal and pending replacement never tombstone another feed's external ID", async () => {
  const transaction = (id, pending = false) => ({ transaction_id: id, account_id: "account-contained",
    amount: "12.00", iso_currency_code: "USD", date: "2026-08-30", pending, name: "Synthetic source containment" });
  const { fixture, state, run, assignAll } = await containmentFixture(["account-contained"], {
    added: [transaction("shared-removed"), transaction("shared-pending", true)],
  });
  try {
    await run(); await assignAll(); assert.equal((await run()).ok, true);
    seedIdentityLedgerAccount(fixture, { slug: "unrelated-account", external: "other-account", source: "other-feed:item-2" });
    for (const [id, pending] of [["shared-removed", 0], ["shared-pending", 1]]) {
      seedIdentityLedgerTransaction(fixture, { uid: `other:${id}`, external: id, account: "unrelated-account", source: "other-feed:item-2", pending });
    }
    state.page = { ...state.page, next_cursor: "contained-after-removal", added: [{ ...transaction("posted-new"), pending_transaction_id: "shared-pending" }], removed: [{ transaction_id: "shared-removed" }] };
    assert.equal((await run()).ok, true);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions WHERE source_feed='other-feed:item-2' AND removed_at IS NULL").n, 2);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions WHERE source_feed='bank-feed:item-sandbox-1' AND removed_at IS NOT NULL").n, 2);
    assert.equal(fixture.first("SELECT recorded_at FROM fin_accounts WHERE account_slug='unrelated-account'").recorded_at, "2026-08-01");
  } finally { fixture.close(); }
});

test("Plaid incremental and empty windows preserve the historical coverage start", async () => {
  const { fixture, state, run, assignAll } = await containmentFixture(["coverage-account"]);
  try {
    state.page.added[0].date = "2024-01-02";
    await run(); await assignAll(); assert.equal((await run()).ok, true);
    state.page = { ...state.page, next_cursor: "later-incremental", added: [{ ...state.page.added[0], transaction_id: "later-transaction", date: "2026-08-29" }] };
    assert.equal((await run()).ok, true);
    assert.equal(fixture.first("SELECT covered_from FROM fin_account_coverage").covered_from, "2024-01-02");
    state.page = { ...state.page, next_cursor: "empty-incremental", added: [] };
    assert.equal((await run()).ok, true);
    assert.equal(fixture.first("SELECT covered_from FROM fin_account_coverage").covered_from, "2024-01-02");
  } finally { fixture.close(); }
});

test("Plaid promotes observed nullable balances with exact currency and liability signs", async () => {
  const { fixture, state, run, assignAll } = await containmentFixture(["usd-liability", "jpy-balance", "bhd-balance"], { added: [] });
  try {
    state.accounts[0] = { ...state.accounts[0], type: "credit", subtype: "credit card", balances: { current: "-12.34", available: null, iso_currency_code: "USD" } };
    state.accounts[1].balances = { current: "125", available: "0", iso_currency_code: "JPY" };
    state.accounts[2].balances = { current: "1.234", available: null, iso_currency_code: "BHD" };
    await run(); await assignAll(); assert.equal((await run()).ok, true);
    const rows = fixture.rows(`SELECT f.external_ref,f.balance_role,b.current_minor,b.available_minor,b.currency,b.recorded_at
      FROM fin_balance_snapshots b JOIN fin_accounts f ON f.account_slug=b.account_slug AND f.tenant_id=b.tenant_id ORDER BY f.external_ref`).map(row => ({ ...row }));
    assert.deepEqual(rows, [
      { external_ref: "bhd-balance", balance_role: "asset", current_minor: 1234, available_minor: null, currency: "BHD", recorded_at: state.now },
      { external_ref: "jpy-balance", balance_role: "asset", current_minor: 125, available_minor: 0, currency: "JPY", recorded_at: state.now },
      { external_ref: "usd-liability", balance_role: "liability", current_minor: -1234, available_minor: null, currency: "USD", recorded_at: state.now },
    ]);
  } finally { fixture.close(); }
});

test("Plaid missing balances stay null and an older same-day observation cannot overwrite a newer one", async () => {
  const { fixture, state, run, assignAll } = await containmentFixture(["observation-account"], { added: [] });
  try {
    state.accounts[0].balances.available = "90.00";
    await run(); await assignAll(); assert.equal((await run()).ok, true);
    state.now = "2026-08-30T15:00:00.000Z";
    state.accounts[0].balances = { current: null, available: null, iso_currency_code: "USD" };
    state.page.next_cursor = "newer-empty-balances";
    assert.equal((await run()).ok, true);
    const newer = { ...fixture.first("SELECT current_minor,available_minor,recorded_at FROM fin_balance_snapshots") };
    assert.deepEqual(newer, { current_minor: null, available_minor: null, recorded_at: state.now });
    state.now = "2026-08-30T14:00:00.000Z";
    state.accounts[0].balances = { current: "999.00", available: "999.00", iso_currency_code: "USD" };
    state.page.next_cursor = "older-observation";
    assert.equal((await run()).ok, true);
    assert.deepEqual({ ...fixture.first("SELECT current_minor,available_minor,recorded_at FROM fin_balance_snapshots") }, newer);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_balance_snapshots").n, 1);
  } finally { fixture.close(); }
});

test("Plaid refuses nonrepresentable balances and transactions instead of truncating or assuming USD", async () => {
  for (const [currency, value] of [["USD", "12.001"], ["JPY", "1.5"], ["USD", "90071992547409.92"], ["ZZZ", "10.00"], [null, "10.00"]]) {
    const { fixture, state, run } = await containmentFixture(["invalid-balance"], { added: [] });
    try {
      state.accounts[0].balances = { current: value, iso_currency_code: currency };
      const result = await run();
      assert.equal(result.ok, false);
      assert.match(result.code, /^plaid_(?:currency_unsupported|amount_not_representable)$/);
      assert.equal(fixture.first("SELECT cursor FROM bank_feed_items").cursor, null);
      assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_balance_snapshots").n, 0);
    } finally { fixture.close(); }
  }
  const { fixture, state, run, assignAll } = await containmentFixture(["invalid-transaction"]);
  try {
    state.page.added[0].amount = "12.001";
    await run(); await assignAll();
    const result = await run();
    assert.equal(result.ok, false);
    assert.equal(result.code, "plaid_amount_not_representable");
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items").cursor, null);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 0);
  } finally { fixture.close(); }
});

test("Plaid preserves the largest safe exact minor amount and accepts insignificant trailing zeroes", async () => {
  const { fixture, state, run, assignAll } = await containmentFixture(["exact-limit"]);
  try {
    state.accounts[0].balances = { current: "90071992547409.91", available: "12.3400", iso_currency_code: "USD" };
    state.page.added[0].amount = "-90071992547409.91";
    await run(); await assignAll(); assert.equal((await run()).ok, true);
    assert.equal(fixture.first("SELECT current_minor FROM fin_balance_snapshots").current_minor, Number.MAX_SAFE_INTEGER);
    assert.equal(fixture.first("SELECT available_minor FROM fin_balance_snapshots").available_minor, 1234);
    assert.deepEqual({ ...fixture.first("SELECT amount_minor,raw_amount_minor,direction FROM fin_transactions") },
      { amount_minor: Number.MAX_SAFE_INTEGER, raw_amount_minor: -Number.MAX_SAFE_INTEGER, direction: "inflow" });
    state.page = { ...state.page, next_cursor: "same-observation-retry", added: [] };
    assert.equal((await run()).ok, true);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_balance_snapshots").n, 1);
  } finally { fixture.close(); }
});

test("Plaid refuses old ready-window truncated amounts before any ledger or cursor promotion", async () => {
  for (const table of ["plaid_sync_stage_accounts", "plaid_sync_stage_transactions"]) {
    const { fixture, run, assignAll } = await containmentFixture(["stored-exactness"]);
    try {
      assert.equal((await run()).status, "assignment_required");
      if (table === "plaid_sync_stage_accounts") fixture.raw("UPDATE plaid_sync_stage_accounts SET current_balance_decimal='12.001',current_balance_minor=1200");
      else fixture.raw("UPDATE plaid_sync_stage_transactions SET amount_decimal='12.001',amount_minor=1200");
      await assignAll();
      const result = await run();
      assert.equal(result.ok, false);
      assert.equal(result.code, "plaid_amount_not_representable");
      assert.equal(fixture.first("SELECT cursor FROM bank_feed_items").cursor, null);
      assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_accounts").n, 0);
      assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 0);
      assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_balance_snapshots").n, 0);
    } finally { fixture.close(); }
  }
});

test("Plaid ready-window balances keep their observation time and reject future observation claims", async () => {
  for (const future of [false, true]) {
    const { fixture, state, run, assignAll } = await containmentFixture(["staged-observation"], { added: [] });
    try {
      assert.equal((await run()).status, "assignment_required");
      const original = state.now;
      // The prior Worker had no explicit observation field; its window start
      // is conservative evidence and must not become the later promotion time.
      fixture.raw("UPDATE plaid_sync_stage_accounts SET provenance_json=json_remove(provenance_json,'$.observedAt')");
      state.now = "2026-08-31T13:00:00.000Z";
      if (future) fixture.raw("UPDATE plaid_sync_stage_accounts SET provenance_json=json_set(provenance_json,'$.observedAt','2026-09-01T13:00:00.000Z')");
      await assignAll();
      const result = await run();
      assert.equal(result.ok, !future);
      if (future) {
        assert.equal(result.code, "plaid_balance_observation_invalid");
        assert.equal(fixture.first("SELECT cursor FROM bank_feed_items").cursor, null);
        assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_balance_snapshots").n, 0);
      } else {
        assert.deepEqual({ ...fixture.first("SELECT as_of_date,recorded_at FROM fin_balance_snapshots") },
          { as_of_date: "2026-08-30", recorded_at: original });
      }
    } finally { fixture.close(); }
  }
});

test("Plaid cannot overwrite another feed's existing transaction identity or balance snapshot", async () => {
  for (const target of ["transaction", "balance"]) {
    const { fixture, state, run, assignAll } = await containmentFixture(["foreign-collision"]);
    try {
      await run(); await assignAll();
      const slug = fixture.first("SELECT account_slug FROM plaid_sync_stage_accounts").account_slug;
      if (target === "transaction") {
        seedIdentityLedgerAccount(fixture, { slug: "other-feed-account", external: "other-account", source: "other-feed:item-2" });
        seedIdentityLedgerTransaction(fixture, { uid: "plaid:identity-transaction-0", external: "identity-transaction-0", account: "other-feed-account", source: "other-feed:item-2" });
      } else {
        fixture.raw(`INSERT INTO fin_balance_snapshots
          (tenant_id,account_slug,as_of_date,current_minor,currency,provenance,source_feed,basis_state,recorded_at)
          VALUES ('primary',?,'2026-08-30',777,'USD','feed','other-feed:item-2','confirmed',?)`, slug, state.now);
      }
      const result = await run();
      assert.equal(result.ok, false);
      assert.equal(fixture.first("SELECT cursor FROM bank_feed_items").cursor, null);
      assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions WHERE source_feed='bank-feed:item-sandbox-1'").n, 0);
      assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_accounts WHERE source_feed='bank-feed:item-sandbox-1'").n, 0);
      if (target === "transaction") assert.equal(fixture.first("SELECT source_feed FROM fin_transactions").source_feed, "other-feed:item-2");
      else assert.equal(fixture.first("SELECT current_minor FROM fin_balance_snapshots").current_minor, 777);
    } finally { fixture.close(); }
  }
});

test("Plaid unofficial transaction currency is held without assuming USD", async () => {
  const { fixture, state, run, assignAll } = await containmentFixture(["unofficial-transaction"]);
  try {
    state.page.added[0].iso_currency_code = null;
    state.page.added[0].unofficial_currency_code = "XBT";
    await run(); await assignAll();
    const result = await run();
    assert.equal(result.ok, false);
    assert.equal(result.code, "plaid_currency_unsupported");
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items").cursor, null);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 0);
  } finally { fixture.close(); }
});

test("Plaid account reassignment cannot silently move balance-only history", async () => {
  const { fixture, run, assignAll } = await containmentFixture(["balance-only-history"], { added: [] });
  try {
    await run(); await assignAll(); assert.equal((await run()).ok, true);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 0);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_balance_snapshots").n, 1);
    const { assignPlaidAccountEntity } = await import("../src/lib/plaid-account-entities.js");
    await assert.rejects(assignPlaidAccountEntity(fixture.env, {
      request_id: "balance-history-reassignment-0001",
      account_ref: fixture.first("SELECT account_ref FROM plaid_account_entity_assignments").account_ref,
      entity_slug: "business",
    }), error => error.code === "bank_account_reassignment_requires_review");
    assert.equal(fixture.first("SELECT entity_slug FROM fin_accounts").entity_slug, "household");
    assert.equal(fixture.first("SELECT entity_slug FROM plaid_account_entity_assignments").entity_slug, "household");
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM owner_action_requests WHERE request_id='balance-history-reassignment-0001'").n, 0);
  } finally { fixture.close(); }
});

test("Plaid assignment guard also catches a first balance that races the owner preflight", async () => {
  const { fixture, run, assignAll } = await containmentFixture(["balance-race"], { added: [] });
  try {
    await run(); await assignAll(); assert.equal((await run()).ok, true);
    const snapshot = { ...fixture.first("SELECT * FROM fin_balance_snapshots") };
    fixture.raw("DELETE FROM fin_balance_snapshots");
    const originalDb = fixture.env.DB;
    let inserted = false;
    fixture.env.DB = { ...originalDb, async batch(statements) {
      if (!inserted) {
        inserted = true;
        fixture.raw(`INSERT INTO fin_balance_snapshots
          (tenant_id,account_slug,as_of_date,current_minor,currency,provenance,source_feed,basis_state,recorded_at)
          VALUES ('primary',?,?,?,'USD','feed','bank-feed:item-sandbox-1','confirmed',?)`,
        snapshot.account_slug, snapshot.as_of_date, snapshot.current_minor, snapshot.recorded_at);
      }
      return originalDb.batch(statements);
    } };
    const { assignPlaidAccountEntity } = await import("../src/lib/plaid-account-entities.js");
    try {
      await assert.rejects(assignPlaidAccountEntity(fixture.env, {
        request_id: "balance-race-reassignment-0001",
        account_ref: fixture.first("SELECT account_ref FROM plaid_account_entity_assignments").account_ref,
        entity_slug: "business",
      }), error => error.code === "bank_account_reassignment_requires_review");
    } finally { fixture.env.DB = originalDb; }
    assert.equal(inserted, true);
    assert.equal(fixture.first("SELECT entity_slug FROM fin_accounts").entity_slug, "household");
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM owner_action_requests WHERE request_id='balance-race-reassignment-0001'").n, 0);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_balance_snapshots").n, 1);
  } finally { fixture.close(); }
});

test("two banks and four accounts promote only after owner routing and retain separate balances, cursors, and history", async () => {
  const fixture = await createProductFixture({ env: {
    BANK_FEED_PROVIDER: "plaid", BANK_FEED_ENV: "sandbox",
    BANK_FEED_CLIENT_ID: "fixture-client-id", BANK_FEED_SECRET: "fixture-secret",
    BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
  } });
  const previousFetch = globalThis.fetch;
  const states = [
    { item: "multi-bank-alpha", institution: "fixture-institution-alpha", phase: 0, accounts: [
      { id: "alpha-household", entity: "household", mask: "3101", currency: "USD", current: "2000.25", minor: 200025, type: "depository", subtype: "checking" },
      { id: "alpha-company", entity: "company-alpha", mask: "3102", currency: "USD", current: "4000.50", minor: 400050, type: "depository", subtype: "checking" },
    ] },
    { item: "multi-bank-beta", institution: "fixture-institution-beta", phase: 0, accounts: [
      { id: "beta-company", entity: "company-beta", mask: "4201", currency: "JPY", current: "3500", minor: 3500, type: "depository", subtype: "savings" },
      { id: "beta-household-credit", entity: "household", mask: "4202", currency: "USD", current: "-90.50", minor: -9050, type: "credit", subtype: "credit card" },
    ] },
  ];
  const providerCalls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    if (path === "/link/token/create") return jsonResponse({ link_token: "link-multi-bank", expiration: "2099-01-01T00:00:00.000Z" });
    if (path === "/item/public_token/exchange") {
      const state = states.find(row => body.public_token === `public-${row.item}`);
      assert.ok(state);
      return jsonResponse({ item_id: state.item, access_token: `access-${state.item}` });
    }
    const state = states.find(row => body.access_token === `access-${row.item}`);
    assert.ok(state, `unrecognized synthetic call ${path}`);
    providerCalls.push({ item: state.item, path, cursor: body.cursor ?? null });
    if (path === "/accounts/get") return jsonResponse({ accounts: state.accounts.map(account => ({
      account_id: account.id, name: `Synthetic ${account.id}`, mask: account.mask,
      type: account.type, subtype: account.subtype,
      balances: { current: account.current, available: null, iso_currency_code: account.currency },
    })) });
    assert.equal(path, "/transactions/sync");
    const transaction = (account, suffix, date) => ({
      transaction_id: `${account.id}-${suffix}`, account_id: account.id, amount: account.currency === "JPY" ? "100" : "12.50",
      iso_currency_code: account.currency, date, pending: false, name: "Synthetic multi-bank expense",
    });
    return jsonResponse({
      added: state.phase === 0 ? state.accounts.map(account => transaction(account, "original", "2024-02-03"))
        : [transaction(state.accounts[1], "incremental", "2026-08-30")],
      modified: [], removed: state.phase === 0 ? [] : [{ transaction_id: `${state.accounts[0].id}-original` }],
      next_cursor: `${state.item}-cursor-${state.phase}`, has_more: false,
      transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
    });
  };
  const drain = async () => {
    while (fixture.waitUntil.length) await Promise.all(fixture.waitUntil.splice(0));
  };
  try {
    for (const [slug, label] of [["household", "Household"], ["company-alpha", "Company Alpha"], ["company-beta", "Company Beta"]]) seedOwnedEntity(fixture, slug, label);
    fixture.raw("UPDATE fin_entities SET kind='household' WHERE entity_slug='household'");
    globalThis.fetch = fetchImpl;
    const owner = await fixture.ownerHeaders();
    for (const state of states) {
      const linked = await fixture.post("/api/bank-feed/link-token", { request_id: `connect-${state.item}`, mode: "connect" }, owner);
      assert.equal(linked.status, 200);
      const link = await linked.json();
      const exchanged = await fixture.post("/api/bank-feed/exchange", {
        session_ref: link.session_ref, public_token: `public-${state.item}`,
        institution_ref: state.institution, institution_label: `Synthetic ${state.item}`,
        accounts: state.accounts.map(account => ({ id: account.id, name: `Synthetic ${account.id}`, mask: account.mask })),
      }, owner);
      assert.equal(exchanged.status, 200);
      await drain();
    }
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM bank_feed_items").n, 2);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM plaid_account_entity_assignments WHERE entity_slug IS NULL").n, 4);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_accounts").n, 0);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 0);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM bank_feed_items WHERE cursor IS NULL").n, 2);
    const accounts = states.flatMap(state => state.accounts);
    for (const [index, account] of accounts.entries()) {
      const assigned = await fixture.post("/api/bank-feed/accounts/assign", {
        request_id: `multi-bank-owner-choice-${index}`,
        account_ref: fixture.first("SELECT account_ref FROM plaid_account_entity_assignments WHERE provider_account_id=?", account.id).account_ref,
        entity_slug: account.entity,
      }, owner);
      assert.equal(assigned.status, 201);
      await drain();
      if (index < accounts.length - 1) assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 0);
    }
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_accounts").n, 4);
    assert.equal(fixture.first("SELECT COUNT(DISTINCT account_slug) AS n FROM fin_accounts").n, 4);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 4);
    for (const state of states) {
      assert.equal(fixture.first("SELECT cursor FROM bank_feed_items WHERE item_ref=?", state.item).cursor, `${state.item}-cursor-0`);
      for (const account of state.accounts) {
        const ledger = fixture.first(`SELECT f.entity_slug,f.currency,f.balance_role,b.current_minor,b.available_minor
          FROM fin_accounts f JOIN fin_balance_snapshots b ON b.tenant_id=f.tenant_id AND b.account_slug=f.account_slug
          WHERE f.source_feed=? AND f.external_ref=?`, `bank-feed:${state.item}`, account.id);
        assert.deepEqual({ ...ledger }, { entity_slug: account.entity, currency: account.currency,
          balance_role: account.type === "credit" ? "liability" : "asset", current_minor: account.minor, available_minor: null });
      }
    }
    const betaBefore = fixture.rows("SELECT * FROM fin_transactions WHERE source_feed='bank-feed:multi-bank-beta' ORDER BY txn_uid").map(row => ({ ...row }));
    const betaBalancesBefore = fixture.rows("SELECT * FROM fin_balance_snapshots WHERE source_feed='bank-feed:multi-bank-beta' ORDER BY account_slug").map(row => ({ ...row }));
    states[0].phase = 1;
    states[0].accounts[1].current = "4100.50";
    const next = await syncPlaidItem(fixture.env, states[0].item, { fetchImpl, now: new Date(Date.now() + 60_000).toISOString() });
    assert.equal(next.ok, true);
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items WHERE item_ref='multi-bank-alpha'").cursor, "multi-bank-alpha-cursor-1");
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items WHERE item_ref='multi-bank-beta'").cursor, "multi-bank-beta-cursor-0");
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions WHERE source_feed='bank-feed:multi-bank-alpha' AND removed_at IS NOT NULL").n, 1);
    assert.deepEqual(fixture.rows("SELECT * FROM fin_transactions WHERE source_feed='bank-feed:multi-bank-beta' ORDER BY txn_uid").map(row => ({ ...row })), betaBefore);
    assert.deepEqual(fixture.rows("SELECT * FROM fin_balance_snapshots WHERE source_feed='bank-feed:multi-bank-beta' ORDER BY account_slug").map(row => ({ ...row })), betaBalancesBefore);
    assert.equal(fixture.first("SELECT current_minor FROM fin_balance_snapshots WHERE account_slug=(SELECT account_slug FROM fin_accounts WHERE external_ref='alpha-company') ORDER BY recorded_at DESC LIMIT 1").current_minor, 410050);
    assert.equal(fixture.first("SELECT covered_from FROM fin_account_coverage WHERE account_slug=(SELECT account_slug FROM fin_accounts WHERE external_ref='alpha-company')").covered_from, "2024-02-03");
    assert.deepEqual(providerCalls.filter(call => call.path === "/transactions/sync").map(call => [call.item, call.cursor]),
      [["multi-bank-alpha", null], ["multi-bank-beta", null], ["multi-bank-alpha", "multi-bank-alpha-cursor-0"]]);
  } finally { globalThis.fetch = previousFetch; fixture.close(); }
});
