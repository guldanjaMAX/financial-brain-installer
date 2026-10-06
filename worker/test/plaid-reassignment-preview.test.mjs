// Execute the actual hosted page generator and its inline script with the
// existing owner-flow fake-DOM pattern. No Worker imports, database, provider,
// credentials, browser, or network are used by these focused UI regressions.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(process.env.BANK_PREVIEW_SOURCE ||
  new URL("../src/lib/bank-feed.js", import.meta.url), "utf8");
const errorStart = source.indexOf("export function bankFeedOwnerErrorMessage(");
const errorEnd = source.indexOf("\n}\n", errorStart) + 3;
const pageStart = source.indexOf("export function connectPageHtml(");
const pageEnd = source.indexOf("\nasync function readJson(request)", pageStart);
assert.ok(errorStart >= 0 && errorEnd > errorStart && pageStart >= 0 && pageEnd > pageStart,
  "the reviewed page and error functions exist at their source boundaries");
const generator = vm.createContext({ FAVICON: "data:image/svg+xml,fixture" });
vm.runInContext(source.slice(errorStart, errorEnd).replace(/^export /, "") + "\n" +
  source.slice(pageStart, pageEnd).replace(/^export /, ""), generator, { timeout: 1000 });
const html = vm.runInContext(
  "connectPageHtml({ provider: 'plaid', environment: 'sandbox' }, { ownerEntityCount: 3 }).html",
  generator, { timeout: 1000 });
const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1]).filter(Boolean);
assert.equal(scripts.length, 1, "the hosted page supplies its actual inline script");

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
const findAll = (node, tag) => [...(node.tagName === tag ? [node] : []),
  ...node.children.flatMap((child) => findAll(child, tag))];
const button = (root, label) => findAll(root, "BUTTON").find((node) => node.textContent === label);
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status,
  json: async () => body });
const entities = ["household", "business-a", "business-b"].map((slug) => ({
  entity_slug: slug, label: slug, status: "active", relationship: "owned",
}));
const receipt = (body, extra = {}) => ({
  moved: true, changed: true, replayed: false, request_id: body.request_id,
  account_ref: body.account_ref,
  from_owner: { entity_slug: body.from_entity_slug, label: body.from_entity_slug },
  to_owner: { entity_slug: body.to_entity_slug, label: body.to_entity_slug },
  entity_scope: { entity_slug: body.to_entity_slug },
  history: { transactions: 2, balance_snapshots: 1 }, ...extra,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
async function tickUntil(check, message) {
  for (let tick = 0; tick < 50; tick += 1) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}
async function page({ onReassign = null, onAccountRead = null } = {}) {
  const ids = ["start", "status", "connections", "accounts", "account-status", "entity-create",
    "entity-name", "entity-kind", "entity-save", "entity-status", "refresh", "entity-details"];
  const nodes = new Map(ids.map((id) => [id, new FakeNode(id === "entity-details" ? "details" : "div", id)]));
  const account = {
    account_ref: "acct_00000000000000000000000000000001",
    masked_identifier: "Synthetic checking ending 0001",
    institution_label: "Synthetic Bank",
    assignment: { state: "assigned", entity_scope: { entity_slug: "household" }, entity_label: "household" },
  };
  const calls = [];
  const storage = new Map();
  let accountReads = 0;
  let uuid = 0;
  const context = vm.createContext({
    document: { getElementById: (id) => nodes.get(id) ?? null,
      createElement: (tag) => new FakeNode(tag) },
    fetch: async (path, init = {}) => {
      assert.equal(init.headers["X-Brain-App"], "1", "the real page retains its companion app header");
      if (path === "/api/bank-feed/accounts") {
        accountReads += 1;
        const override = onAccountRead && await onAccountRead(accountReads);
        return override || response({ state: "current", accounts: [account], summary: { assignment_required: 0 } });
      }
      if (path === "/api/fin/snapshot") return response({ entities });
      if (path === "/api/bank-feed/status") return response({ connections: [] });
      assert.equal(path, "/api/bank-feed/accounts/reassign", "only known synthetic relative routes are callable");
      const body = JSON.parse(init.body);
      calls.push(body);
      const override = onReassign && await onReassign(body, calls.length);
      if (override) return override;
      if (body.mode === "preview") return response({
        account_ref: body.account_ref,
        from_owner: { entity_slug: body.from_entity_slug, label: body.from_entity_slug },
        to_owner: { entity_slug: body.to_entity_slug, label: body.to_entity_slug },
        history: { transactions: 2, balance_snapshots: 1 }, can_apply: true,
      });
      account.assignment = { state: "assigned", entity_scope: { entity_slug: body.to_entity_slug },
        entity_label: body.to_entity_slug };
      return response(receipt(body), 201);
    },
    sessionStorage: { getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) },
    crypto: { randomUUID: () => "fixture-request-" + (++uuid) },
    location: { search: "", href: "https://brain.invalid/app/connect/bank" },
    URLSearchParams, setTimeout, console,
  });
  context.window = context;
  vm.runInContext(scripts[0], context, { timeout: 1000 });
  await tickUntil(() => findAll(nodes.get("accounts"), "ARTICLE").length === 1, "the actual page rendered an assigned account");
  const card = findAll(nodes.get("accounts"), "ARTICLE")[0];
  button(card, "Move to another owner").onclick();
  const select = findAll(card, "SELECT")[0];
  const review = button(card, "Review move");
  return { nodes, account, card, select, review, calls, storage,
    status: () => nodes.get("account-status").textContent,
    applies: () => calls.filter((body) => body.mode === "apply") };
}
async function reviewed(options) {
  const state = await page(options);
  state.select.value = "business-a";
  await state.review.onclick();
  assert.equal(state.calls[0].mode, "preview", "the real preview decision was reached");
  assert.match(textOf(state.card), /Move from household to business-a/);
  assert.ok(button(state.card, "Move account history"), "the actual preview enabled Apply");
  return state;
}
function changeSelection(state, value) {
  state.select.value = value;
  if (state.select.onchange) state.select.onchange();
}

test("the reviewed-move selector has a stable accessible label", async () => {
  const state = await page();
  const label = findAll(state.card, "LABEL")
    .find((node) => node.textContent === "Move this account to");
  assert.ok(label, "the visible move label reached the rendered decision panel");
  assert.equal(state.select.id, "reassign-entity-" + state.account.account_ref,
    "the select id remains stable for this account");
  assert.equal(label.htmlFor, state.select.id,
    "the visible label programmatically names the move selector");
});

test("changed destination invalidates the reviewed move before Apply", async () => {
  const state = await reviewed();
  const oldApply = button(state.card, "Move account history");
  changeSelection(state, "business-b");
  await oldApply.onclick();
  assert.equal(state.applies().length, 0, "the reached preview cannot apply a different selected owner");
  assert.equal(oldApply.disabled, true);
  assert.match(textOf(state.card), /Review.*again/i);
  await state.review.onclick();
  await button(state.card, "Move account history").onclick();
  assert.equal(state.applies().length, 1);
  assert.equal(state.applies()[0].from_entity_slug, "household");
  assert.equal(state.applies()[0].to_entity_slug, "business-b");
  assert.match(state.status(), /now belong to business-b/);
});

test("changing away and back still requires a fresh review", async () => {
  const state = await reviewed();
  const oldApply = button(state.card, "Move account history");
  changeSelection(state, "business-b");
  changeSelection(state, "business-a");
  await oldApply.onclick();
  assert.equal(state.applies().length, 0);
  await state.review.onclick();
  await button(state.card, "Move account history").onclick();
  assert.equal(state.calls.filter((body) => body.mode === "preview").length, 2);
  assert.equal(state.applies().length, 1);
});

test("a changed source owner invalidates Apply and requires refreshing the account", async () => {
  const state = await reviewed();
  const oldApply = button(state.card, "Move account history");
  state.account.assignment.entity_scope.entity_slug = "business-b";
  await oldApply.onclick();
  assert.equal(state.applies().length, 0);
  assert.match(textOf(state.card), /owner changed.*Refresh/i);
  await state.review.onclick();
  assert.equal(state.calls.length, 1, "the stale source cannot silently receive another preview");
});

test("a refreshed account list invalidates detached preview controls", async () => {
  const state = await reviewed();
  const oldApply = button(state.card, "Move account history");
  state.nodes.get("refresh").onclick();
  await tickUntil(() => findAll(state.nodes.get("accounts"), "ARTICLE")[0] !== state.card,
    "the real refresh replaced the account card");
  await oldApply.onclick();
  assert.equal(state.applies().length, 0);
});

test("an obsolete pending preview cannot revive Apply after the destination changes", async () => {
  const first = deferred();
  const second = deferred();
  const state = await page({ onReassign: async (body) => {
    if (body.mode === "preview") await (body.to_entity_slug === "business-a" ? first : second).promise;
  } });
  state.select.value = "business-a";
  const oldReview = state.review.onclick();
  await tickUntil(() => state.calls.length === 1, "the first pending preview reached the endpoint");
  changeSelection(state, "business-b");
  const newReview = state.review.onclick();
  await tickUntil(() => state.calls.length === 2, "the replacement preview reached the endpoint");
  first.resolve();
  await oldReview;
  assert.equal(button(state.card, "Move account history"), undefined);
  second.resolve();
  await newReview;
  await button(state.card, "Move account history").onclick();
  assert.equal(state.applies().length, 1);
  assert.equal(state.applies()[0].to_entity_slug, "business-b");
});

test("the exact approved path applies once and reports the confirmed receipt owner", async () => {
  const state = await reviewed({ onReassign: (body) => body.mode === "apply"
    ? response(receipt(body, { to_owner: { entity_slug: "business-a", label: "Confirmed Business" } }), 201)
    : null });
  const apply = button(state.card, "Move account history");
  await apply.onclick();
  await apply.onclick();
  assert.equal(state.applies().length, 1);
  assert.deepEqual(state.applies()[0], {
    mode: "apply", request_id: "fixture-request-1", account_ref: state.account.account_ref,
    from_entity_slug: "household", to_entity_slug: "business-a",
  });
  assert.match(state.status(), /now belong to Confirmed Business/);
  assert.equal(state.storage.size, 0, "only a verified receipt clears the retry identity");
});

test("an unverified successful HTTP response never reports a confirmed move", async (context) => {
  const changes = {
    missing: () => ({}),
    null: () => null,
    account: () => ({ account_ref: "acct_00000000000000000000000000000002" }),
    source: () => ({ from_owner: { entity_slug: "business-b", label: "business-b" } }),
    target: () => ({ to_owner: { entity_slug: "business-b", label: "business-b" } }),
    scope: () => ({ entity_scope: { entity_slug: "business-b" } }),
    request: () => ({ request_id: "other-request" }),
    moved: () => ({ moved: false }),
    changed: () => ({ changed: false }),
    label: () => ({ to_owner: { entity_slug: "business-a", label: "" } }),
  };
  for (const [name, change] of Object.entries(changes)) await context.test(name, async () => {
    const state = await reviewed({ onReassign: (body) => body.mode === "apply"
      ? response(name === "missing" ? {} : name === "null" ? null : receipt(body, change()), 201) : null });
    const apply = button(state.card, "Move account history");
    await apply.onclick();
    assert.equal(state.applies().length, 1, "the result-verification decision was reached");
    assert.doesNotMatch(state.status(), /now belong|Nothing was moved/);
    assert.match(state.status(), /could not be verified/);
    assert.equal(state.nodes.get("account-status").className, "err");
    assert.equal(apply.disabled, true);
    assert.equal(state.storage.size, 1, "an unknown outcome retains the exact retry identity");
  });
});

test("a server refusal for a stale source never becomes a success message", async () => {
  const state = await reviewed({ onReassign: (body) => body.mode === "apply"
    ? response({ code: "bank_account_reassignment_scope_changed" }, 409) : null });
  const apply = button(state.card, "Move account history");
  await apply.onclick();
  assert.equal(state.applies().length, 1, "the server source guard was reached");
  assert.match(state.status(), /owner changed/);
  assert.doesNotMatch(state.status(), /now belong/);
  assert.equal(apply.disabled, true);
});

test("a lost response permits only the same reviewed identity on manual retry", async () => {
  let attempts = 0;
  const state = await reviewed({ onReassign: (body) => {
    if (body.mode !== "apply") return null;
    attempts += 1;
    if (attempts === 1) throw new Error("The response was lost.");
    return response(receipt(body, { replayed: true }), 200);
  } });
  const apply = button(state.card, "Move account history");
  await apply.onclick();
  assert.doesNotMatch(state.status(), /now belong|Nothing was moved/);
  assert.equal(state.storage.size, 1);
  await apply.onclick();
  assert.equal(state.applies().length, 2);
  assert.deepEqual(state.applies()[1], state.applies()[0]);
  assert.match(state.status(), /now belong to business-a/);
});

test("a confirmed move remains truthful when the account-list refresh fails", async () => {
  const state = await reviewed({ onAccountRead: (count) => count > 1 ? response({}, 503) : null });
  await button(state.card, "Move account history").onclick();
  assert.match(state.status(), /now belong to business-a.*account list could not refresh/i);
  assert.equal(state.nodes.get("account-status").className, "err");
});

test("a pending Apply locks the selection and rejects duplicate clicks", async () => {
  const gate = deferred();
  const state = await reviewed({ onReassign: async (body) => {
    if (body.mode === "apply") await gate.promise;
  } });
  const apply = button(state.card, "Move account history");
  const pending = apply.onclick();
  await tickUntil(() => state.applies().length === 1, "Apply reached its pending request");
  assert.equal(state.select.disabled, true);
  changeSelection(state, "business-b");
  await apply.onclick();
  gate.resolve();
  await pending;
  assert.equal(state.applies().length, 1);
  assert.equal(state.applies()[0].to_entity_slug, "business-a");
  assert.match(state.status(), /now belong to business-a/);
});
