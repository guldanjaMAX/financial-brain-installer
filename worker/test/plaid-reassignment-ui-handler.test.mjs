// Bounded local rehearsal: the actual generated owner-page script sends every
// request through the actual Worker/router/handler and real migrated SQLite.
// No HTTP socket, provider request, client account, or deployed endpoint exists.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";

const STAMP = "2026-08-31T12:00:00.000Z";
const ACCOUNT_REF = "acct_00000000000000000000000000000001";
const ACCOUNT_SLUG = "ui-reviewed-account";
const ITEM = "item-ui-review";
const ENV = { BANK_FEED_PROVIDER: "plaid", BANK_FEED_ENV: "sandbox",
  BANK_FEED_CLIENT_ID: "fixture-client-id", BANK_FEED_SECRET: "fixture-secret",
  BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}` };

class FakeNode {
  constructor(tag, id = "") {
    this.tagName = String(tag).toUpperCase(); this.id = id; this.children = [];
    this.textContent = ""; this.className = ""; this.disabled = false;
    this.value = ""; this.open = false;
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; this.textContent = ""; }
  get options() { return this.children.filter((node) => node.tagName === "OPTION"); }
}
const findAll = (node, tag) => [...(node.tagName === tag ? [node] : []),
  ...node.children.flatMap((child) => findAll(child, tag))];
const textOf = (node) => [node.textContent, ...node.children.map(textOf)].filter(Boolean).join(" ");
const button = (node, label) => findAll(node, "BUTTON").find((value) => value.textContent === label);
const jsonCopy = (value) => JSON.parse(JSON.stringify(value));
async function until(check, message) {
  for (let tick = 0; tick < 100; tick += 1) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

async function connectedPage({ onReply = null } = {}) {
  const fixture = await createProductFixture({ env: ENV });
  seedOwnedEntity(fixture, "household", "Household");
  seedOwnedEntity(fixture, "business-a", "Business A");
  seedOwnedEntity(fixture, "business-b", "Business B");
  fixture.raw(`INSERT INTO bank_feed_items
    (tenant_id,item_ref,institution_label,access_ciphertext,access_iv,key_version,
     environment,status,connected_at)
    VALUES ('primary',?,'Synthetic Bank','AAAAAAAAAAAAAAAA','BBBBBBBB',2,
            'sandbox','connected',?)`, ITEM, STAMP);
  fixture.raw(`INSERT INTO plaid_account_entity_assignments
    (tenant_id,item_ref,provider_account_id,account_ref,entity_slug,
     discovered_at,last_seen_at,assigned_at,updated_at)
    VALUES ('primary',?,'ui-provider-account',?,'household',?,?,?,?)`,
    ITEM, ACCOUNT_REF, STAMP, STAMP, STAMP, STAMP);
  fixture.raw(`INSERT INTO fin_accounts
    (tenant_id,account_slug,entity_slug,label,mask,account_kind,balance_role,
     external_ref,provenance,source_feed,basis_state,recorded_at)
    VALUES ('primary',?,'household','Synthetic checking','0001','checking','asset',
            'ui-provider-account','feed',?,'confirmed',?)`, ACCOUNT_SLUG, "bank-feed:" + ITEM, STAMP);
  for (const index of [1, 2]) fixture.raw(`INSERT INTO fin_transactions
    (tenant_id,txn_uid,account_slug,posted_on,amount_minor,direction,currency,
     description,external_id,provenance,source_feed,basis_state,recorded_at)
    VALUES ('primary',?,?,'2026-08-31',?,'outflow','USD','Synthetic fixture history',?,
            'feed',?,'confirmed',?)`, "plaid:ui-" + index, ACCOUNT_SLUG,
    index * 100, "ui-" + index, "bank-feed:" + ITEM, STAMP);
  fixture.raw(`INSERT INTO fin_balance_snapshots
    (tenant_id,account_slug,as_of_date,current_minor,available_minor,currency,
     provenance,source_feed,basis_state,recorded_at)
    VALUES ('primary',?,'2026-08-31',12300,12000,'USD','feed',?,'confirmed',?)`,
    ACCOUNT_SLUG, "bank-feed:" + ITEM, STAMP);
  const owner = await fixture.ownerHeaders();
  const ctx = { waitUntil(promise) { fixture.waitUntil.push(Promise.resolve(promise)); },
    passThroughOnException() {} };
  const pageResponse = await fixture.worker.fetch(new Request("https://brain.invalid/app/connect/bank", {
    headers: { Cookie: owner.Cookie },
  }), fixture.env, ctx);
  assert.equal(pageResponse.status, 200, "the actual owner navigation gate accepted its fixture cookie");
  const html = await pageResponse.text();
  const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1]).filter(Boolean);
  assert.equal(scripts.length, 1);
  const ids = ["start", "status", "connections", "accounts", "account-status", "entity-create",
    "entity-name", "entity-kind", "entity-save", "entity-status", "refresh", "entity-details"];
  const nodes = new Map(ids.map((id) => [id, new FakeNode(id === "entity-details" ? "details" : "div", id)]));
  const calls = [];
  const storage = new Map();
  let uuid = 0;
  const context = vm.createContext({
    document: { getElementById: (id) => nodes.get(id) ?? null, createElement: (tag) => new FakeNode(tag) },
    fetch: async (path, init = {}) => {
      assert.ok(path.startsWith("/api/"), "all page requests remain local relative API paths");
      const request = new Request("https://brain.invalid" + path, {
        method: init.method || "GET", headers: { Cookie: owner.Cookie, ...init.headers }, body: init.body,
      });
      const body = path.endsWith("/reassign") ? JSON.parse(init.body) : null;
      const response = await fixture.worker.fetch(request, fixture.env, ctx);
      if (body) {
        const reply = await response.clone().json();
        const call = { request: body, status: response.status, receipt: reply };
        calls.push(call);
        if (onReply) await onReply(call);
      }
      return response;
    },
    sessionStorage: { getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) },
    crypto: { randomUUID: () => "ui-handler-request-" + (++uuid) },
    location: { search: "", href: "https://brain.invalid/app/connect/bank" },
    URLSearchParams, setTimeout, console,
  });
  context.window = context;
  vm.runInContext(scripts[0], context, { timeout: 1000 });
  await until(() => findAll(nodes.get("accounts"), "ARTICLE").length === 1,
    "real account and financial-snapshot handlers populated the owner page");
  const card = findAll(nodes.get("accounts"), "ARTICLE")[0];
  button(card, "Move to another owner").onclick();
  const select = findAll(card, "SELECT")[0];
  const review = button(card, "Review move");
  const history = () => jsonCopy({
    transactions: fixture.rows("SELECT * FROM fin_transactions WHERE account_slug=? ORDER BY txn_uid", ACCOUNT_SLUG),
    balances: fixture.rows("SELECT * FROM fin_balance_snapshots WHERE account_slug=? ORDER BY id", ACCOUNT_SLUG),
  });
  const owners = () => ({
    assignment: fixture.first("SELECT entity_slug FROM plaid_account_entity_assignments WHERE account_ref=?", ACCOUNT_REF).entity_slug,
    ledger: fixture.first("SELECT entity_slug FROM fin_accounts WHERE account_slug=?", ACCOUNT_SLUG).entity_slug,
  });
  return { fixture, nodes, card, select, review, calls, history, owners,
    status: () => nodes.get("account-status").textContent,
    applies: () => calls.filter((call) => call.request.mode === "apply") };
}
async function reviewA(state) {
  state.select.value = "business-a";
  await state.review.onclick();
  assert.equal(state.calls[0].status, 200);
  assert.deepEqual(state.calls[0].receipt.history, { transactions: 2, balance_snapshots: 1 });
  assert.match(textOf(state.card), /Move from Household to Business A/);
  assert.ok(button(state.card, "Move account history"));
}
function changeChoice(state, target) {
  state.select.value = target;
  state.select.onchange();
}
function assertReceiptMatches(call, target) {
  assert.equal(call.status, call.receipt.replayed ? 200 : 201);
  assert.equal(call.request.account_ref, ACCOUNT_REF);
  assert.equal(call.request.from_entity_slug, "household");
  assert.equal(call.request.to_entity_slug, target);
  assert.equal(call.receipt.account_ref, call.request.account_ref);
  assert.equal(call.receipt.request_id, call.request.request_id);
  assert.equal(call.receipt.from_owner.entity_slug, call.request.from_entity_slug);
  assert.equal(call.receipt.to_owner.entity_slug, call.request.to_entity_slug);
  assert.equal(call.receipt.entity_scope.entity_slug, call.request.to_entity_slug);
  assert.equal(call.receipt.moved, true);
  assert.equal(call.receipt.changed, true);
}
function assertOneMove(state, target) {
  assert.deepEqual(state.owners(), { assignment: target, ledger: target });
  assert.equal(state.fixture.first("SELECT COUNT(*) AS n FROM owner_action_requests WHERE action_type='plaid_account_entity_reassignment'").n, 1);
  assert.equal(state.fixture.first("SELECT COUNT(*) AS n FROM owner_activity_events WHERE event_type='bank_account_entity_reassigned'").n, 1);
  assert.equal(state.fixture.first("SELECT reason FROM plaid_reconciliation WHERE item_ref=?", ITEM).reason, "owner_assignment");
}

test("Apply sends only the reviewed owner", async (t) => {
  await t.test("control applies the reviewed owner when the choice is unchanged", async () => {
    const state = await connectedPage();
    try {
      state.select.value = "business-a";
      await state.review.onclick();
      assert.equal(state.calls.length, 1, "the preview reached the real handler");
      assert.equal(state.calls[0].request.mode, "preview");
      assert.equal(state.calls[0].request.to_entity_slug, "business-a");
      assert.equal(state.calls[0].status, 200);
      const apply = button(state.card, "Move account history");
      assert.ok(apply, "the reviewed move exposed its Apply decision point");
      let clicks = 0;
      clicks += 1;
      await apply.onclick();
      assert.deepEqual({
        clicks,
        applyCalls: state.applies().length,
        appliedTarget: state.applies()[0]?.request.to_entity_slug ?? null,
        owners: state.owners(),
        receipts: state.fixture.first(
          "SELECT COUNT(*) AS n FROM owner_action_requests WHERE action_type='plaid_account_entity_reassignment'",
        ).n,
      }, {
        clicks: 1,
        applyCalls: 1,
        appliedTarget: "business-a",
        owners: { assignment: "business-a", ledger: "business-a" },
        receipts: 1,
      });
    } finally { state.fixture.close(); }
  });

  await t.test("changed choice cannot reuse the reviewed Apply", async () => {
    const state = await connectedPage();
    try {
      state.select.value = "business-a";
      await state.review.onclick();
      assert.equal(state.calls.length, 1, "the preview reached the real handler");
      assert.equal(state.calls[0].request.mode, "preview");
      assert.equal(state.calls[0].request.to_entity_slug, "business-a");
      assert.equal(state.calls[0].status, 200);
      const apply = button(state.card, "Move account history");
      assert.ok(apply, "the reviewed move exposed its Apply decision point");
      state.select.value = "business-b";
      state.select.onchange?.();
      let clicks = 0;
      clicks += 1;
      await apply.onclick();
      assert.deepEqual({
        clicks,
        applyCalls: state.applies().length,
        appliedTarget: state.applies()[0]?.request.to_entity_slug ?? null,
        owners: state.owners(),
        receipts: state.fixture.first(
          "SELECT COUNT(*) AS n FROM owner_action_requests WHERE action_type='plaid_account_entity_reassignment'",
        ).n,
      }, {
        clicks: 1,
        applyCalls: 0,
        appliedTarget: null,
        owners: { assignment: "household", ledger: "household" },
        receipts: 0,
      }, "the changed choice cannot reach the handler or move either owner");
    } finally { state.fixture.close(); }
  });
});

test("real UI and handler agree on the exact approved account/source/target and preserve history", async () => {
  const state = await connectedPage();
  try {
    const before = state.history();
    await reviewA(state);
    await button(state.card, "Move account history").onclick();
    assert.equal(state.applies().length, 1);
    assertReceiptMatches(state.applies()[0], "business-a");
    assertOneMove(state, "business-a");
    assert.deepEqual(state.history(), before, "every transaction and balance row remains byte-for-value identical");
    assert.match(state.status(), /now belong to Business A/);
  } finally { state.fixture.close(); }
});

test("wrong-owner selection fails before handler Apply; a new review applies only the new owner", async () => {
  const state = await connectedPage();
  try {
    const before = state.history();
    await reviewA(state);
    const oldApply = button(state.card, "Move account history");
    changeChoice(state, "business-b");
    await oldApply.onclick();
    assert.equal(state.applies().length, 0, "the actual preview was reached; invalidated Apply sent no mutation request");
    assert.deepEqual(state.owners(), { assignment: "household", ledger: "household" });
    assert.equal(state.fixture.first("SELECT COUNT(*) AS n FROM owner_action_requests").n, 0);
    await state.review.onclick();
    await button(state.card, "Move account history").onclick();
    assertReceiptMatches(state.applies()[0], "business-b");
    assertOneMove(state, "business-b");
    assert.deepEqual(state.history(), before);
    assert.match(state.status(), /now belong to Business B/);
  } finally { state.fixture.close(); }
});

test("a source-owner change after preview reaches the real refusal guard and writes no move", async () => {
  const state = await connectedPage();
  try {
    await reviewA(state);
    state.fixture.raw("UPDATE plaid_account_entity_assignments SET entity_slug='business-b' WHERE account_ref=?", ACCOUNT_REF);
    state.fixture.raw("UPDATE fin_accounts SET entity_slug='business-b' WHERE account_slug=?", ACCOUNT_SLUG);
    const before = state.history();
    const apply = button(state.card, "Move account history");
    await apply.onclick();
    assert.equal(state.applies().length, 1, "the reached Apply request exercised the actual handler source guard");
    assert.equal(state.applies()[0].status, 409);
    assert.equal(state.applies()[0].receipt.code, "bank_account_reassignment_scope_changed");
    assert.deepEqual(state.owners(), { assignment: "business-b", ledger: "business-b" });
    assert.equal(state.fixture.first("SELECT COUNT(*) AS n FROM owner_action_requests").n, 0);
    assert.equal(state.fixture.first("SELECT COUNT(*) AS n FROM owner_activity_events").n, 0);
    assert.deepEqual(state.history(), before);
    assert.equal(apply.disabled, true);
    assert.match(state.status(), /owner changed/);
    assert.doesNotMatch(state.status(), /now belong/);
  } finally { state.fixture.close(); }
});

test("a delayed real preview cannot replace a later reviewed target", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const state = await connectedPage({ onReply: async (call) => {
    if (call.request.mode === "preview" && call.request.to_entity_slug === "business-a") await gate;
  } });
  try {
    state.select.value = "business-a";
    const oldReview = state.review.onclick();
    await until(() => state.calls.length === 1, "the real first preview reached the handler");
    changeChoice(state, "business-b");
    await state.review.onclick();
    release();
    await oldReview;
    assert.match(textOf(state.card), /Move from Household to Business B/);
    await button(state.card, "Move account history").onclick();
    assert.equal(state.applies().length, 1);
    assertReceiptMatches(state.applies()[0], "business-b");
    assertOneMove(state, "business-b");
  } finally { release(); state.fixture.close(); }
});

test("a lost committed Apply response replays the exact reviewed receipt without a second move", async () => {
  let lost = false;
  const state = await connectedPage({ onReply: (call) => {
    if (call.request.mode === "apply" && !lost) {
      lost = true;
      assert.equal(call.status, 201, "the actual handler committed before response loss");
      throw new Error("The response was lost.");
    }
  } });
  try {
    const before = state.history();
    await reviewA(state);
    const apply = button(state.card, "Move account history");
    await apply.onclick();
    assertOneMove(state, "business-a");
    assert.doesNotMatch(state.status(), /now belong|Nothing was moved/);
    await apply.onclick();
    assert.equal(state.applies().length, 2);
    assert.deepEqual(state.applies()[1].request, state.applies()[0].request);
    assertReceiptMatches(state.applies()[1], "business-a");
    assert.equal(state.applies()[1].receipt.replayed, true);
    assertOneMove(state, "business-a");
    assert.deepEqual(state.history(), before);
    assert.match(state.status(), /now belong to Business A/);
  } finally { state.fixture.close(); }
});
