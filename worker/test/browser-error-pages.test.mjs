import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createProductFixture } from "./product-contract-fixture.mjs";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const ambientFetch = globalThis.fetch;
let unexpectedFetches = 0;
test.before(() => {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  globalThis.fetch = async () => { unexpectedFetches++; throw Error("ambient network forbidden"); };
});
test.after(() => {
  globalThis.fetch = ambientFetch;
  mock.timers.reset();
  assert.equal(unexpectedFetches, 0);
});

async function withFixture(check) {
  const fixture = await createProductFixture();
  try { await check(fixture); } finally { fixture.close(); }
}
const request = (fixture, path, { accept, method = "GET", headers = {} } = {}) => fixture.worker.fetch(
  new Request(`https://brain.invalid${path}`, {
    method, headers: { ...headers, ...(accept === undefined ? {} : { Accept: accept }) },
  }), fixture.env, {},
);

async function assertHtml(response, status, code, title) {
  assert.equal(response.status, status);
  assert.match(response.headers.get("Content-Type"), /^text\/html\b/);
  assert.match(response.headers.get("Cache-Control"), /private, no-store/);
  assert.match(response.headers.get("Content-Security-Policy"), /script-src 'none'/);
  assert.match(response.headers.get("Content-Security-Policy"), /style-src 'unsafe-inline'/);
  const html = await response.text();
  assert.match(html, /name="viewport"/);
  assert.match(html, /--gutter:\s*16px/);
  assert.match(html, new RegExp(`Code ${code}\\b`));
  assert.match(html, new RegExp(title));
  assert.doesNotMatch(html, /<script\b/i);
  assert.equal((html.match(/class="btn btn-primary"/g) || []).length, 1);
  return html;
}
async function assertJson(response, status, bytes) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("Content-Type"), "application/json");
  assert.equal(await response.text(), bytes, "API bytes remain unchanged");
}

test("browser MCP navigation has a coded page and retains OAuth discovery", async () => withFixture(async fixture => {
  const response = await request(fixture, "/mcp", { accept: "text/html,application/json;q=0.9" });
  assert.equal(response.headers.get("WWW-Authenticate"),
    'Bearer resource_metadata="https://brain.invalid/.well-known/oauth-protected-resource"',
    "the connector authentication decision was reached");
  await assertHtml(response, 401, "CONNECTOR_ADDRESS", "connector address");
}));

for (const options of [{ accept: "application/json" }, {}, { accept: "*/*" },
  { accept: "text/html", method: "POST" }, { accept: "text/html", method: "HEAD" }]) {
  test(`MCP API control ${JSON.stringify(options)}`, async () => withFixture(async fixture => {
    const response = await request(fixture, "/mcp", options);
    assert.ok(response.headers.has("WWW-Authenticate"), "authentication decision reached");
    await assertJson(response, 401, '{"error":"unauthorized"}');
  }));
}

for (const path of ["/", "/app/"]) {
  test(`browser ${path} opens the owner workspace`, async () => withFixture(async fixture => {
    for (const headers of [{}, { "X-Admin-Key": fixture.env.ADMIN_KEY }]) {
      const response = await request(fixture, `${path}?unused=fixture`, { accept: "text/html", headers });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("Location"), "/app");
      assert.equal(fixture.seen.sql.length, 0, "redirect needs no storage or credential lookup");
    }
  }));
  for (const options of [{ accept: "application/json" }, {}, { accept: "text/html", method: "POST" }]) {
    test(`root API control ${path} ${JSON.stringify(options)}`, async () => withFixture(async fixture => {
      await assertJson(await request(fixture, path, options), 401, '{"error":"unauthorized"}');
      const response = await request(fixture, path, { ...options, headers: { "X-Admin-Key": fixture.env.ADMIN_KEY } });
      await assertJson(response, 404, '{"error":"not found"}');
    }));
  }
}

test("authorized browser not-found reaches the coded 404 without bypassing authentication", async () => withFixture(async fixture => {
  const html = await assertHtml(await request(fixture, "/missing-page", {
    accept: "text/html", headers: { "X-Admin-Key": fixture.env.ADMIN_KEY },
  }), 404, "PAGE_NOT_FOUND", "page could not be found");
  assert.match(html, /href="\/app"/);
  await assertJson(await request(fixture, "/missing-page", { accept: "text/html" }), 401, '{"error":"unauthorized"}');
  assert.equal((await request(fixture, "/health")).status, 200, "a known route is the green routing control");
}));
for (const options of [{ accept: "application/json" }, {}, { accept: "text/html", method: "POST" }]) {
  test(`not-found API control ${JSON.stringify(options)}`, async () => withFixture(async fixture => {
    await assertJson(await request(fixture, "/missing-page", {
      ...options, headers: { "X-Admin-Key": fixture.env.ADMIN_KEY },
    }), 404, '{"error":"not found"}');
  }));
}

const staleLink = "/oauth/authorize?client_id=fixture-missing&redirect_uri=https%3A%2F%2Fconnector.invalid%2Freturn";
test("stale browser approval stays a non-redirecting coded 400", async () => withFixture(async fixture => {
  const response = await request(fixture, staleLink, { accept: "text/html" });
  assert.ok(fixture.seen.sql.some(sql => /FROM oauth_clients/i.test(sql)), "client validation was reached");
  assert.equal(response.headers.has("Location"), false, "unvalidated destinations never receive a redirect");
  const html = await assertHtml(response, 400, "APPROVAL_LINK_OUT_OF_DATE", "This link is out of date");
  assert.doesNotMatch(html, /connector\.invalid|fixture-missing/);
}));
for (const options of [{ accept: "application/json" }, {}]) {
  test(`stale approval API control ${JSON.stringify(options)}`, async () => withFixture(async fixture => {
    const response = await request(fixture, staleLink, options);
    assert.ok(fixture.seen.sql.some(sql => /FROM oauth_clients/i.test(sql)), "client validation was reached");
    assert.equal(response.headers.has("Location"), false);
    await assertJson(response, 400, '{"error":"unknown client or redirect_uri"}');
  }));
}

for (const accept of ["text/html", "application/json", undefined]) {
  test(`scoped bank navigation ${String(accept)} retains the owner-only boundary`, async () => withFixture(async fixture => {
    const { Cookie } = await fixture.ownerHeaders({ grantId: "fixture-scoped-grant" });
    const response = await request(fixture, "/app/connect/bank", { accept, headers: { Cookie } });
    assert.ok(fixture.seen.sql.some(sql => /FROM owner_passkeys/i.test(sql)), "registered scoped passkey decision reached");
    if (accept === "text/html") {
      const html = await assertHtml(response, 403, "OWNER_REQUIRED", "Only the owner can connect a bank");
      assert.match(html, /href="\/app"/);
    } else {
      assert.equal(response.status, 403);
      assert.equal(await response.text(), "Only the owner can connect a bank.", "existing non-browser text is unchanged");
    }
  }));
}
