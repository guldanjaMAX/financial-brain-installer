// The owner's first bank connection, end to end, as the owner and the status
// endpoint see it. Field evidence from two sandbox rehearsals: a Link refusal
// shown only as "Reference code: INVALID_FIELD", an account-assignment page with
// empty owner lists and the fix hidden in a collapsed section, and a status
// endpoint that reported zero progress and nothing needing attention while a
// sync sat waiting for owner choices. Every identifier here is synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";
import { bankFeedOwnerErrorMessage, handleBankFeed } from "../src/lib/bank-feed.js";
import { completePlaidLink, createPlaidLinkToken, plaidFeedStatus, syncPlaidItem } from "../src/lib/plaid-bank-feed.js";
import { assignPlaidAccountEntity } from "../src/lib/plaid-account-entities.js";

const NOW = "2026-09-21T15:00:00.000Z";
const ITEM = "item-owner-flow-1";
const ENV = {
  BANK_FEED_PROVIDER: "plaid",
  BANK_FEED_ENV: "sandbox",
  BANK_FEED_CLIENT_ID: "fixture-client-id",
  BANK_FEED_SECRET: "fixture-secret",
  BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
  BRAIN_NAME: "Owner Flow Fixture Brain",
};
const NO_OWNER_LINE = "Add an owner first. Choose who each account belongs to.";

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});

// Plaid's documented error shape. documentation_url sorts ahead of the
// message, which is why the owner mapping must not depend on raw JSON order.
const plaidError = (code, type, message) => json({
  display_message: null,
  documentation_url: `https://plaid.com/docs/errors/${type.toLowerCase().replace(/_/g, "-")}/#${code.toLowerCase()}`,
  error_code: code, error_message: message, error_type: type,
  request_id: "fixture-request-0001", suggested_action: null,
}, 400);

async function postLinkToken(fixture, fetchImpl) {
  const ownerHeaders = await fixture.ownerHeaders();
  const linkUrl = new URL("https://brain.invalid/api/bank-feed/link-token");
  const response = await handleBankFeed(fixture.env, new Request(linkUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ownerHeaders },
    body: JSON.stringify({ request_id: "owner-flow-link-request-0001", mode: "connect" }),
  }), linkUrl, linkUrl.pathname, { bankFeedFetchImpl: fetchImpl });
  return { status: response.status, body: await response.json() };
}

test("a redirect URI missing from the Plaid allowed list is explained with the exact address to add", async () => {
  const fixture = await createProductFixture({ env: ENV });
  try {
    const { status, body } = await postLinkToken(fixture, async () => plaidError(
      "INVALID_FIELD", "INVALID_REQUEST",
      "OAuth redirect URI must be configured in the developer dashboard. See https://dashboard.plaid.com/team/api",
    ));
    assert.equal(status, 502);
    assert.equal(body.code, "INVALID_FIELD");
    assert.equal(body.reason, "redirect_uri_not_allowed");
    assert.equal(body.redirect_uri, "https://brain.invalid/app/connect/bank");
    const message = bankFeedOwnerErrorMessage(body, status);
    assert.match(message, /not on the Allowed redirect URIs list/);
    assert.ok(message.includes("add exactly https://brain.invalid/app/connect/bank"), message);
    assert.match(message, /Reference code: INVALID_FIELD\.$/);
    assert.doesNotMatch(message, /Please try again/);
  } finally { fixture.close(); }
});

test("keys from the wrong Plaid environment are explained with the --replace-keys fix", async () => {
  const fixture = await createProductFixture({ env: ENV });
  try {
    const { status, body } = await postLinkToken(fixture, async () => plaidError(
      "INVALID_API_KEYS", "INVALID_INPUT", "invalid client_id or secret provided",
    ));
    assert.equal(body.code, "INVALID_API_KEYS");
    assert.equal(body.reason, "invalid_api_keys");
    assert.equal(body.environment, "sandbox");
    const message = bankFeedOwnerErrorMessage(body, status);
    assert.match(message, /do not match|did not accept the keys saved on this Brain for its sandbox environment/);
    assert.match(message, /brain connect bank <your manifest file> --replace-keys/);
    assert.match(message, /Reference code: INVALID_API_KEYS\.$/);
  } finally { fixture.close(); }
});

test("an unrelated invalid field keeps the generic retry message and its reference code", async () => {
  const fixture = await createProductFixture({ env: ENV });
  try {
    const { status, body } = await postLinkToken(fixture, async () => plaidError(
      "INVALID_FIELD", "INVALID_REQUEST", "client_name must be a non-empty string",
    ));
    assert.equal(body.code, "INVALID_FIELD");
    assert.equal(Object.hasOwn(body, "reason"), false);
    assert.equal(Object.hasOwn(body, "redirect_uri"), false);
    assert.match(bankFeedOwnerErrorMessage(body, status), /That step did not finish.*Reference code: INVALID_FIELD\.$/);
  } finally { fixture.close(); }
});

test("a safe route failure without a provider code remains visible with a stable reference", async () => {
  const fixture = await createProductFixture({ env: { ...ENV, BANK_FEED_CLIENT_ID: "" } });
  try {
    const { status, body } = await postLinkToken(fixture, async () => {
      throw new Error("the provider must not be contacted without configuration");
    });
    assert.equal(status, 503);
    assert.equal(Object.hasOwn(body, "code"), false);
    assert.match(body.error, /not configured/);
    const message = bankFeedOwnerErrorMessage(body, status);
    assert.match(message, /^This step is temporarily unavailable\. Your earlier progress is safe\. Please try again\./);
    assert.match(message, /the bank feed is not configured on this brain/);
    assert.match(message, /Reference code: BANK_FEED_REQUEST_FAILED\.$/);
  } finally { fixture.close(); }
});

test("a removed legacy reconnect refusal tells the owner to contact support before retrying", () => {
  const message = bankFeedOwnerErrorMessage({
    error: "conflict",
    code: "plaid_legacy_reconnect_support_required",
  }, 409);
  assert.match(message, /predates the identity proof/);
  assert.match(message, /No replacement was exchanged and nothing was moved/);
  assert.match(message, /Contact support before trying again/);
  assert.match(message, /Reference code: plaid_legacy_reconnect_support_required\.$/);
});

/* ------------------------------------------------------------ the owner page */

class FakeNode {
  constructor(tag, id = "") {
    this.tagName = String(tag).toUpperCase();
    this.id = id;
    this.children = [];
    this.textContent = "";
    this.className = "";
    this.disabled = false;
    this.value = "";
    this.open = false;
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  get options() { return this.children.filter((node) => node.tagName === "OPTION"); }
}
const textOf = (node) => [node.textContent, ...node.children.map(textOf)].filter(Boolean).join(" ");
const findAll = (node, tag) => [...(node.tagName === tag ? [node] : []), ...node.children.flatMap((child) => findAll(child, tag))];

async function pageHtml(fixture) {
  const ownerHeaders = await fixture.ownerHeaders();
  const pageUrl = new URL("https://brain.invalid/app/connect/bank");
  const response = await handleBankFeed(fixture.env, new Request(pageUrl, {
    headers: { Cookie: ownerHeaders.Cookie },
  }), pageUrl, pageUrl.pathname, {});
  assert.equal(response.status, 200);
  return response.text();
}

/** Execute the page's own inline script against a minimal DOM and API. */
async function runPage(html, { entities, accounts }) {
  const script = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1]).filter(Boolean);
  assert.equal(script.length, 1);
  const ids = ["start", "status", "connections", "accounts", "account-status", "entity-create",
    "entity-name", "entity-kind", "entity-save", "entity-status", "refresh", "entity-details"];
  const nodes = new Map(ids.map((id) => [id, new FakeNode(id === "entity-details" ? "details" : "div", id)]));
  const responses = {
    "/api/bank-feed/accounts": {
      provider: "plaid", state: "assignment_required", accounts,
      summary: { assignment_required: accounts.filter((row) => row.assignment.state !== "assigned").length },
    },
    "/api/fin/snapshot": { entities },
    "/api/bank-feed/status": { connections: [] },
  };
  const storage = new Map();
  const context = vm.createContext({
    document: {
      getElementById: (id) => nodes.get(id) ?? null,
      createElement: (tag) => new FakeNode(tag),
    },
    fetch: async (path) => ({ ok: true, status: 200, json: async () => responses[path] }),
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
    location: { search: "", href: "https://brain.invalid/app/connect/bank" },
    URLSearchParams,
    setTimeout,
    console,
  });
  context.window = context;
  vm.runInContext(script[0], context);
  for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  return nodes;
}

async function runDuplicateRefusalPage(html) {
  const script = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1]).filter(Boolean);
  assert.equal(script.length, 1);
  const ids = ["start", "status", "connections", "accounts", "account-status", "entity-create",
    "entity-name", "entity-kind", "entity-save", "entity-status", "refresh", "entity-details"];
  const nodes = new Map(ids.map((id) => [id, new FakeNode(id === "entity-details" ? "details" : "div", id)]));
  const storage = new Map();
  const linkRequests = [];
  let exchangeCalls = 0;
  let opened = 0;
  let nextId = 0;
  const response = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  const context = vm.createContext({
    document: {
      getElementById: (id) => nodes.get(id) ?? null,
      createElement: (tag) => new FakeNode(tag),
    },
    fetch: async (path, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      if (path === "/api/bank-feed/link-token") {
        linkRequests.push(body);
        return response({
          link_token: `fixture-link-${linkRequests.length}`,
          session_ref: `fixture-session-${linkRequests.length}`,
        });
      }
      if (path === "/api/bank-feed/exchange") {
        exchangeCalls += 1;
        return response({ error: "conflict", code: "plaid_duplicate_connection_review" }, 409);
      }
      if (path === "/api/bank-feed/accounts") {
        return response({ provider: "plaid", state: "current", accounts: [], summary: { assignment_required: 0 } });
      }
      if (path === "/api/fin/snapshot") return response({ entities: [] });
      if (path === "/api/bank-feed/status") return response({ connections: [] });
      throw new Error(`unexpected owner-page path ${path}`);
    },
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    crypto: { randomUUID: () => `fixture-request-${String(++nextId).padStart(4, "0")}` },
    location: { search: "", href: "https://brain.invalid/app/connect/bank" },
    URLSearchParams,
    setTimeout,
    console,
  });
  context.Plaid = {
    create(config) {
      return {
        open() {
          opened += 1;
          if (opened === 1) void config.onSuccess("fixture-public-token", {
            institution: { institution_id: "fixture-institution", name: "Synthetic Bank" },
            accounts: [{ id: "fixture-account", name: "Synthetic checking", mask: "1234" }],
          });
        },
      };
    },
  };
  context.window = context;
  vm.runInContext(script[0], context);
  for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  nodes.get("start").onclick();
  for (let tick = 0; tick < 50 && nodes.get("start").disabled; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(exchangeCalls, 1, "the duplicate decision point must be reached");
  nodes.get("start").onclick();
  for (let tick = 0; tick < 50 && linkRequests.length < 2; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { linkRequests, exchangeCalls, opened, storage };
}

const unassigned = (index) => ({
  account_ref: `acct_${String(index).padStart(32, "0")}`,
  masked_identifier: `Synthetic checking ending 000${index}`,
  institution_label: "Synthetic Bank",
  assignment: { state: "assignment_required" },
});

test("with no owner yet, the add-owner section opens and each account says to add an owner first", async () => {
  const fixture = await createProductFixture({ env: ENV });
  try {
    const html = await pageHtml(fixture);
    assert.match(html, /<details id="entity-details" open>/, "the server opens the section when no owner exists");
    const nodes = await runPage(html, { entities: [], accounts: [unassigned(1), unassigned(2)] });
    assert.equal(nodes.get("entity-details").open, true);
    const cards = nodes.get("accounts").children;
    assert.equal(cards.length, 2);
    for (const card of cards) {
      assert.ok(textOf(card).includes(NO_OWNER_LINE), textOf(card));
      assert.equal(findAll(card, "SELECT").length, 0, "no empty owner list is rendered");
      assert.equal(findAll(card, "BUTTON").length, 0, "no disabled assign button is rendered");
    }
    assert.ok(nodes.get("account-status").textContent.includes(NO_OWNER_LINE));
  } finally { fixture.close(); }
});

test("once an owner exists, the section starts closed and every account offers the owner list", async () => {
  const fixture = await createProductFixture({ env: ENV });
  try {
    seedOwnedEntity(fixture, "fixture-household", "Fixture Household");
    const html = await pageHtml(fixture);
    assert.match(html, /<details id="entity-details">/);
    const nodes = await runPage(html, {
      entities: [{ entity_slug: "fixture-household", label: "Fixture Household", status: "active", relationship: "owned" }],
      accounts: [unassigned(1)],
    });
    assert.equal(nodes.get("entity-details").open, false);
    const [card] = nodes.get("accounts").children;
    assert.equal(textOf(card).includes(NO_OWNER_LINE), false);
    const [select] = findAll(card, "SELECT");
    assert.deepEqual(select.options.map((option) => option.value), ["", "fixture-household"]);
    assert.equal(findAll(card, "BUTTON")[0].disabled, false);
  } finally { fixture.close(); }
});

test("the connect page states the disconnect location and reconnect review boundary", async () => {
  const fixture = await createProductFixture({ env: ENV });
  try {
    const html = await pageHtml(fixture);
    assert.doesNotMatch(html, /You can disconnect at any time/);
    assert.match(html, /To disconnect a bank later, open your Brain and go to Access &gt; Banks &gt; Disconnect\./);
    assert.match(html, /Disconnecting removes the bank connection and any bank data still waiting for an owner choice\./);
    assert.match(html, /Ledger history already saved stays\./);
    assert.match(html, /A reconnect resumes only an exact saved account match\./);
    assert.match(html, /Replacement history stays waiting until each retained transaction is matched without ambiguity\./);
  } finally { fixture.close(); }
});

test("a duplicate-review refusal discards that Link request before the next click", async () => {
  const fixture = await createProductFixture({ env: ENV });
  try {
    const result = await runDuplicateRefusalPage(await pageHtml(fixture));
    assert.equal(result.exchangeCalls, 1, "the first Link session must reach duplicate review");
    assert.equal(result.linkRequests.length, 2, "the next click must create another Link operation");
    assert.notEqual(result.linkRequests[0].request_id, result.linkRequests[1].request_id);
  } finally { fixture.close(); }
});

/* ------------------------------------------------------ status tells the truth */

async function statusFixture() {
  const fixture = await createProductFixture({ env: ENV });
  seedOwnedEntity(fixture, "fixture-household", "Fixture Household");
  const line = (id, account, amount) => ({
    transaction_id: id, account_id: account, amount, iso_currency_code: "USD",
    date: "2026-09-19", pending: false, name: "Synthetic status fixture",
  });
  const state = { mutateOnce: true, keysRejected: false, incremental: [] };
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init?.body || "{}");
    if (path === "/link/token/create") return json({ link_token: "link-sandbox-status", expiration: "2099-01-01T00:00:00.000Z" });
    if (path === "/item/public_token/exchange") return json({ item_id: ITEM, access_token: "access-sandbox-status" });
    if (state.keysRejected) return plaidError("INVALID_API_KEYS", "INVALID_INPUT", "invalid client_id or secret provided");
    if (path === "/accounts/get") {
      return json({ accounts: ["status-checking", "status-savings"].map((id, index) => ({
        account_id: id, name: `Synthetic ${id}`, mask: `000${index}`, type: "depository",
        subtype: index ? "savings" : "checking", balances: { current: "100.00", iso_currency_code: "USD" },
      })) });
    }
    if (path === "/transactions/sync") {
      if (!body.cursor) {
        return json({
          added: [line("status-1", "status-checking", "10.00"), line("status-2", "status-savings", "20.00")],
          modified: [], removed: [], next_cursor: "status-page-2", has_more: true,
          transactions_update_status: "INITIAL_UPDATE_COMPLETE",
        });
      }
      if (body.cursor === "status-page-2") {
        if (state.mutateOnce) {
          state.mutateOnce = false;
          return json({ error_type: "TRANSACTIONS_ERROR", error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", error_message: "mutation" }, 400);
        }
        return json({
          added: [line("status-3", "status-checking", "30.00")],
          modified: [line("status-1", "status-checking", "11.00")], removed: [],
          next_cursor: "status-committed-1", has_more: false,
          transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
        });
      }
      return json({
        added: state.incremental, modified: [], removed: [],
        next_cursor: `status-committed-${Date.now()}-${state.incremental.length}`, has_more: false,
        transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
      });
    }
    throw new Error(`unexpected Plaid path ${path}`);
  };
  const link = await createPlaidLinkToken(fixture.env, {
    url: "https://brain.invalid/app/connect/bank", sessionRef: "status-link-session-0001", fetchImpl, now: NOW,
  });
  await completePlaidLink(fixture.env, {
    sessionRef: link.session_ref, publicToken: "public-sandbox-status", fetchImpl, now: NOW,
  });
  let clock = Date.parse(NOW);
  const run = () => syncPlaidItem(fixture.env, ITEM, { fetchImpl, now: new Date(clock += 60_000).toISOString() });
  const assignAll = async () => {
    for (const [index, row] of fixture.rows("SELECT account_ref FROM plaid_account_entity_assignments ORDER BY provider_account_id").entries()) {
      await assignPlaidAccountEntity(fixture.env, {
        request_id: `status-assignment-${index}`, account_ref: row.account_ref, entity_slug: "fixture-household",
      }, { now: NOW });
    }
  };
  return { fixture, state, run, assignAll };
}

test("a sync waiting on owner choices is visible in needs_attention with the count, and clears a stale error", async () => {
  const { fixture, run } = await statusFixture();
  try {
    // A prior failure from an earlier build is still on the connection row.
    fixture.raw(`UPDATE bank_feed_items SET status='error',
      status_detail='the bank feed could not be reached (plaid_amount_not_representable): stale' WHERE item_ref=?`, ITEM);
    const staged = await run();
    assert.equal(staged.status, "assignment_required");
    const status = await plaidFeedStatus(fixture.env);
    const [connection] = status.connections;
    assert.equal(connection.status, "connected", "every provider read succeeded, so the stale error is gone");
    assert.match(connection.status_detail, /^2 accounts need an owner choice before their transactions can load\./);
    assert.equal(connection.accounts_needing_owner, 2);
    assert.equal(connection.history.staged_pages, 2);
    assert.equal(connection.history.staged_transactions, 4);
    assert.deepEqual(status.needs_attention, [{
      item_ref: ITEM,
      status: "connected",
      detail: "2 accounts need an owner choice before their transactions can load. Choose who owns each account on the Connect a bank page.",
      reconciliation_state: "pending",
      revocation_state: null,
      revocation_outcome_state: null,
      code: "plaid_account_assignment_required",
      accounts_needing_owner: 2,
      staged_transactions: 4,
    }]);
    // A sync that reached the guard but lost its lease before writing that
    // sentence still reads as waiting on choices, never as "stopped working".
    fixture.raw("UPDATE bank_feed_items SET status_detail=NULL WHERE item_ref=?", ITEM);
    const unwritten = await plaidFeedStatus(fixture.env);
    assert.equal(unwritten.connections[0].status_detail, status.needs_attention[0].detail);
    assert.equal(unwritten.needs_attention[0].detail, status.needs_attention[0].detail);
  } finally { fixture.close(); }
});

test("history counters are written on the Plaid path from the promoted window, once, and stop when complete", async () => {
  const { fixture, state, run, assignAll } = await statusFixture();
  try {
    assert.equal((await run()).status, "assignment_required");
    await assignAll();
    await run();
    const counters = () => ({ ...fixture.first(
      "SELECT pages_done,transactions_seen,unread_lines,state FROM bank_feed_backfill WHERE item_ref=?", ITEM) });
    // Two pages, three added and one modified, even though the first attempt
    // at page two was restarted by a provider mutation.
    assert.deepEqual(counters(), { pages_done: 2, transactions_seen: 4, unread_lines: 0, state: "running" });
    let status = await plaidFeedStatus(fixture.env);
    assert.equal(status.connections[0].history.pages_done, 2);
    assert.equal(status.connections[0].history.transactions_seen, 4);
    assert.equal(status.connections[0].history.staged_pages, 0);
    assert.equal(status.connections[0].accounts_needing_owner, 0);
    assert.equal(status.needs_attention.length, 0);

    // The confirming fresh read completes the history load and is counted.
    await run();
    assert.deepEqual(counters(), { pages_done: 3, transactions_seen: 4, unread_lines: 0, state: "complete" });
    // Routine refreshes after completion are not history progress.
    state.incremental = [{
      transaction_id: "status-later", account_id: "status-checking", amount: "5.00", iso_currency_code: "USD",
      date: "2026-09-20", pending: false, name: "Synthetic later fixture",
    }];
    await run();
    assert.deepEqual(counters(), { pages_done: 3, transactions_seen: 4, unread_lines: 0, state: "complete" });
    status = await plaidFeedStatus(fixture.env);
    assert.equal(status.connections[0].history.state, "complete");
  } finally { fixture.close(); }
});

test("rejected keys during a scheduled sync leave a plain owner fix on the connection", async () => {
  const { fixture, state, run } = await statusFixture();
  try {
    state.keysRejected = true;
    const result = await run();
    assert.equal(result.ok, false);
    assert.equal(result.code, "INVALID_API_KEYS");
    const item = fixture.first("SELECT status,status_detail FROM bank_feed_items WHERE item_ref=?", ITEM);
    assert.equal(item.status, "error");
    assert.match(item.status_detail, /did not accept the keys saved on this Brain/);
    assert.match(item.status_detail, /brain connect bank <manifest> --replace-keys/);
  } finally { fixture.close(); }
});
