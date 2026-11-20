import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createProductFixture } from "./product-contract-fixture.mjs";
import { bankFeedConfig, handleBankFeed } from "../src/lib/bank-feed.js";
import { PlaidAccountEntityError } from "../src/lib/plaid-account-entities.js";
import { renderCliCommands } from "../../operations/cli-guidance.mjs";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const PAGE = "/app/connect/bank";
const READY_TEXT = "STEP 1 of 3 · Getting your bank page ready ○ Almost ready. Your Brain is getting its bank keys. This page refreshes by itself; it usually takes under a minute. If it isn't ready in 10 minutes, tell your installer. Code: BANK_KEYS_NOT_SET";
const ambientFetch = globalThis.fetch;
let unexpectedFetches = 0;

test.before(() => {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  globalThis.fetch = async () => {
    unexpectedFetches++;
    throw new Error("ambient network forbidden");
  };
});
test.after(() => {
  globalThis.fetch = ambientFetch;
  mock.timers.reset();
  assert.equal(unexpectedFetches, 0, "no provider or other network contact");
});

async function fixtureWithoutKeys() {
  const fixture = await createProductFixture({ env: { BANK_FEED_PROVIDER: "plaid" } });
  let configReads = 0;
  Object.defineProperty(fixture.env, "BANK_FEED_CLIENT_ID", {
    get() { configReads++; return undefined; },
  });
  return Object.assign(fixture, { configReads: () => configReads });
}

async function pageRequest(fixture, suffix = "") {
  const { Cookie } = await fixture.ownerHeaders();
  const url = new URL(`https://brain.invalid${PAGE}${suffix}`);
  // Address-bar navigation has a cookie but cannot add the API CSRF header.
  return handleBankFeed(fixture.env, new Request(url, { headers: { Cookie } }), url, PAGE, {});
}

function assertPrivateHtml(response) {
  assert.match(response.headers.get("Content-Type"), /^text\/html\b/);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  const csp = response.headers.get("Content-Security-Policy");
  assert.match(csp, /(?:^|;\s*)default-src 'none'(?:;|$)/);
  assert.match(csp, /(?:^|;\s*)script-src 'none'(?:;|$)/);
  assert.match(csp, /(?:^|;\s*)frame-ancestors 'none'(?:;|$)/);
  assert.match(csp, /(?:^|;\s*)base-uri 'none'(?:;|$)/);
  assert.match(csp, /(?:^|;\s*)form-action 'none'(?:;|$)/);
}

function assertOwnerDecision(fixture) {
  assert.ok(fixture.seen.sql.some(sql => /SELECT.*FROM owner_passkeys/is.test(sql)),
    "the real owner navigation check reached the registered passkey");
  assert.ok(fixture.configReads() > 0, "the missing-configuration decision was reached");
  assert.ok(fixture.seen.sql.every(sql => /^\s*(SELECT|WITH)/i.test(sql)), "page handling never writes");
}

test("signed-in owner without keys sees the exact calm HTML, never configuration JSON", async () => {
  const fixture = await fixtureWithoutKeys();
  try {
    const response = await pageRequest(fixture);
    assertOwnerDecision(fixture);
    assert.equal(response.status, 503);
    assertPrivateHtml(response);
    const html = await response.text();
    const text = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, "")
      .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    assert.equal(text, READY_TEXT);
    assert.doesNotMatch(html, /BANK_FEED_|brain secrets|brain connect|\{"error"|<script\b/i);
  } finally { fixture.close(); }
});

test("the missing-key page refreshes without script or owner inventory", async () => {
  const fixture = await fixtureWithoutKeys();
  try {
    const response = await pageRequest(fixture);
    assertOwnerDecision(fixture);
    assert.equal(response.status, 503);
    assert.equal(fixture.seen.sql.some(sql => /FROM fin_entities/i.test(sql)), false,
      "missing keys do not need an owner-inventory query");
    assert.equal(response.headers.get("Retry-After"), "10");
    const html = await response.text();
    assert.match(html, /<meta http-equiv="refresh" content="10">/);
    assert.doesNotMatch(html, /<script\b/i);
  } finally { fixture.close(); }
});

test("missing keys are checked before replacement mode", async () => {
  const fixture = await fixtureWithoutKeys();
  try {
    const response = await pageRequest(fixture, "?mode=replace");
    assert.ok(fixture.seen.sql.some(sql => /FROM owner_passkeys/i.test(sql)), "owner decision reached");
    assert.equal(response.status, 503);
    assertOwnerDecision(fixture);
    assert.match(await response.text(), /Code: BANK_KEYS_NOT_SET/);
  } finally { fixture.close(); }
});

test("signed-out control stays a 401 sign-in page without reading configuration", async () => {
  const fixture = await fixtureWithoutKeys();
  try {
    const url = new URL(`https://brain.invalid${PAGE}`);
    const response = await handleBankFeed(fixture.env, new Request(url), url, PAGE, {});
    assert.ok(fixture.seen.sql.length > 0, "the real session-generation check was reached");
    assert.equal(fixture.configReads(), 0, "configuration stays behind owner authentication");
    assert.equal(response.status, 401);
    assert.match(response.headers.get("Content-Type"), /^text\/html\b/);
    const html = await response.text();
    assert.match(html, /Sign in/);
    assert.doesNotMatch(html, /BANK_|Almost ready|not configured|brain secrets|\{"error"/i);
    assert.equal(response.headers.get("Retry-After"), null);
    assert.doesNotMatch(html, /http-equiv="refresh"/);
  } finally { fixture.close(); }
});

test("link-token without keys remains JSON 503 and supplies BANK_KEYS_NOT_SET", async () => {
  const fixture = await fixtureWithoutKeys();
  try {
    const path = "/api/bank-feed/link-token";
    const url = new URL(`https://brain.invalid${path}`);
    const response = await handleBankFeed(fixture.env, new Request(url, {
      method: "POST", headers: { ...await fixture.ownerHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: "fixture-request-0001" }),
    }), url, path, {});
    assertOwnerDecision(fixture);
    assert.equal(response.status, 503);
    assert.match(response.headers.get("Content-Type"), /^application\/json\b/);
    const body = await response.json();
    assert.match(body.error, /not configured/);
    assert.equal(body.code, "BANK_KEYS_NOT_SET");
    assert.doesNotMatch(body.error, /brain secrets/);
  } finally { fixture.close(); }
});

for (const kind of ["generic", "simplefin", "assignment"]) {
  test(`${kind} thrown page error becomes private HTML without raw provider detail`, async () => {
    const fixture = await createProductFixture();
    const marker = "fixture-provider-detail";
    const error = kind === "assignment"
      ? new PlaidAccountEntityError("bank_account_status_unavailable", marker, 503)
      : Object.assign(new Error(marker), {
        code: ["<img", "src=fixture>"].join(" "),
        ...(kind === "simplefin" ? { provider: "simplefin", status: 502 } : {}),
      });
    let throws = 0;
    Object.defineProperty(fixture.env, "BANK_FEED_ENV", { get() { throws++; throw error; } });
    try {
      const response = await pageRequest(fixture);
      assert.ok(throws > 0, "the injected failure was reached after owner authentication");
      assert.ok(fixture.seen.sql.some(sql => /FROM owner_passkeys/i.test(sql)), "owner check completed");
      assertPrivateHtml(response);
      const html = await response.text();
      assert.match(html, /STEP 1 of 3/);
      assert.match(html, /Code: BANK_FEED_REQUEST_FAILED/);
      assert.equal(html.includes(marker), false);
      assert.equal(html.includes(error.code), false, "untrusted error codes are never interpolated into HTML");
      assert.doesNotMatch(html, /\{"error"|<script\b|http-equiv="refresh"/i);
    } finally { fixture.close(); }
  });
}

test("configured control still opens the bank page and has no readiness refresh", async () => {
  const fixture = await createProductFixture({ env: {
    BANK_FEED_PROVIDER: "plaid", BANK_FEED_ENV: "sandbox",
    BANK_FEED_CLIENT_ID: "fixture-client", BANK_FEED_SECRET: "fixture-secret",
    BANK_FEED_WRAPPING_KEY_V2: ["v2.", "A".repeat(43)].join(""),
  } });
  try {
    const response = await pageRequest(fixture);
    assert.equal(response.status, 200);
    assert.ok(fixture.seen.sql.some(sql => /FROM fin_entities/i.test(sql)), "configured page rendering reached");
    const html = await response.text();
    assert.match(html, /Connect a bank/);
    assert.doesNotMatch(html, /BANK_KEYS_NOT_SET|http-equiv="refresh"/);
  } finally { fixture.close(); }
});

test("operator advice keeps the not-configured diagnosis and names the bank connection command", () => {
  assert.throws(() => bankFeedConfig({ BANK_FEED_PROVIDER: "plaid" }), error => {
    assert.match(error.message, /not configured/);
    // This is a structured Worker error, before any host CLI rendering.
    assert.ok(error.message.includes(renderCliCommands("brain connect bank", { platform: "darwin" })));
    assert.doesNotMatch(error.message, /brain secrets/);
    return true;
  });
});
