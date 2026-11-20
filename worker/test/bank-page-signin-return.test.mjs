import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createProductFixture } from "./product-contract-fixture.mjs";

const PAGE = "/app/connect/bank";
const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const READY_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
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

async function withPage(owner, check) {
  const fixture = await createProductFixture({ env: { BANK_FEED_PROVIDER: "plaid" } });
  let configReads = 0;
  Object.defineProperty(fixture.env, "BANK_FEED_CLIENT_ID", {
    get() { configReads++; return undefined; },
  });
  try {
    const headers = owner ? { Cookie: (await fixture.ownerHeaders()).Cookie } : {};
    const response = await fixture.worker.fetch(new Request(`https://brain.invalid${PAGE}`, { headers }), fixture.env, {});
    assert.ok(fixture.seen.sql.length > 0, "the real navigation/session decision was reached");
    assert.ok(fixture.seen.sql.every(sql => /^\s*(SELECT|WITH)/i.test(sql)), "navigation performs no writes");
    await check(response, configReads, fixture);
  } finally { fixture.close(); }
}

test("signed-out bank page offers one platform-neutral sign-in action with a fixed return token", async () => {
  await withPage(false, async (response, configReads) => {
    assert.equal(response.status, 401);
    assert.equal(configReads, 0);
    assert.match(response.headers.get("Content-Type"), /^text\/html\b/);
    const html = await response.text();
    assert.match(html, /<h1[^>]*>Sign in to connect your bank<\/h1>/);
    assert.match(html, /STEP 1 of 3/);
    assert.match(html, /<a[^>]*href="\/app\?then=connect-bank">Sign in with a passkey<\/a>/);
    assert.match(html, /--gutter:\s*16px/);
    assert.equal((html.match(/class="btn btn-primary"/g) || []).length, 1);
    assert.equal((html.match(/<a\b/g) || []).length, 1);
    assert.doesNotMatch(html, /Touch ID|Windows Hello|open .*page again|<script\b/i);
  });
});

test("signed-out control reveals no configuration detail and stays private", async () => {
  await withPage(false, async (response, configReads) => {
    assert.equal(response.status, 401);
    assert.equal(configReads, 0, "configuration remains behind the owner check");
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("Retry-After"), null);
    const html = await response.text();
    assert.match(html, /Sign in/);
    assert.doesNotMatch(html, /BANK_|not configured|Almost ready|brain secrets|brain connect|\{"error"|http-equiv="refresh"/i);
  });
});

test("CSP control preserves the signed-out header and the exact L1 readiness policy", async () => {
  await withPage(false, async (response) => {
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("Content-Security-Policy"), READY_CSP);
  });
  await withPage(true, async (response, configReads, fixture) => {
    assert.ok(configReads > 0, "the authenticated configuration decision was reached");
    assert.ok(fixture.seen.sql.some(sql => /FROM owner_passkeys/i.test(sql)), "the owner passkey was checked");
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Content-Security-Policy"), READY_CSP);
    assert.match(await response.text(), /Code: BANK_KEYS_NOT_SET/);
  });
});
