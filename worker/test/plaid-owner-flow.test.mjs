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
import { FAVICON } from "../src/lib/app-page.js";
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

async function pageResponse(fixture) {
  const ownerHeaders = await fixture.ownerHeaders();
  const pageUrl = new URL("https://brain.invalid/app/connect/bank");
  const response = await handleBankFeed(fixture.env, new Request(pageUrl, {
    headers: { Cookie: ownerHeaders.Cookie },
  }), pageUrl, pageUrl.pathname, {});
  assert.equal(response.status, 200);
  return response;
}

async function pageHtml(fixture) {
  return (await pageResponse(fixture)).text();
}

/** Execute the page's own inline script against a minimal DOM and API. */
async function runPage(html, { entities, accounts, connections = [], onAssign = null, onReassign = null }) {
  const script = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1]).filter(Boolean);
  assert.equal(script.length, 1);
  const ids = ["start", "status", "connections", "accounts", "account-status", "entity-create",
    "entity-name", "entity-kind", "entity-save", "entity-status", "refresh", "entity-details"];
  const nodes = new Map(ids.map((id) => [id, new FakeNode(id === "entity-details" ? "details" : "div", id)]));
  const responses = {
    "/api/fin/snapshot": { entities },
    "/api/bank-feed/status": { connections },
  };
  const storage = new Map();
  const assignments = [];
  const reassignments = [];
  let accountLoads = 0;
  const context = vm.createContext({
    document: {
      getElementById: (id) => nodes.get(id) ?? null,
      createElement: (tag) => new FakeNode(tag),
    },
    fetch: async (path, init = {}) => {
      if (path === "/api/bank-feed/accounts") {
        accountLoads += 1;
        const assignmentRequired = accounts.filter((row) => row.assignment.state !== "assigned").length;
        return {
          ok: true, status: 200,
          json: async () => ({
            provider: "plaid", state: assignmentRequired ? "assignment_required" : "current", accounts,
            summary: { assignment_required: assignmentRequired },
          }),
        };
      }
      if (path === "/api/bank-feed/accounts/assign") {
        const body = JSON.parse(init.body);
        assignments.push(body);
        if (onAssign) await onAssign(body, assignments.length);
        const account = accounts.find((row) => row.account_ref === body.account_ref);
        assert.ok(account, "the page posted a fixture account ref");
        account.assignment = { state: "assigned", entity_label: body.entity_slug };
        return { ok: true, status: 200, json: async () => ({ changed: true }) };
      }
      if (path === "/api/bank-feed/accounts/reassign") {
        const body = JSON.parse(init.body);
        reassignments.push(body);
        if (onReassign) await onReassign(body, reassignments.length);
        const account = accounts.find((row) => row.account_ref === body.account_ref);
        assert.ok(account, "the page posted a fixture account ref for reviewed reassignment");
        const from = entities.find((row) => row.entity_slug === body.from_entity_slug);
        const to = entities.find((row) => row.entity_slug === body.to_entity_slug);
        if (body.mode === "apply") {
          account.assignment = {
            state: "assigned",
            entity_scope: { entity_slug: body.to_entity_slug },
            entity_label: to?.label || body.to_entity_slug,
          };
        }
        return { ok: true, status: body.mode === "apply" ? 201 : 200, json: async () => body.mode === "apply"
          ? { changed: true, replayed: false, entity_scope: { entity_slug: body.to_entity_slug } }
          : {
              account_ref: body.account_ref,
              from_owner: { entity_slug: body.from_entity_slug, label: from?.label || body.from_entity_slug },
              to_owner: { entity_slug: body.to_entity_slug, label: to?.label || body.to_entity_slug },
              history: { transactions: 2, balance_snapshots: 1 },
              can_apply: true,
            } };
      }
      return { ok: true, status: 200, json: async () => responses[path] };
    },
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
  nodes.assignments = assignments;
  nodes.reassignments = reassignments;
  nodes.accountLoads = () => accountLoads;
  return nodes;
}

async function until(check, message) {
  for (let tick = 0; tick < 50; tick += 1) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
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
    const cards = findAll(nodes.get("accounts"), "ARTICLE");
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
    const [card] = findAll(nodes.get("accounts"), "ARTICLE");
    assert.equal(textOf(card).includes(NO_OWNER_LINE), false);
    const [select] = findAll(card, "SELECT");
    assert.deepEqual(select.options.map((option) => option.value), ["", "fixture-household"]);
    assert.equal(findAll(card, "BUTTON")[0].disabled, false);
  } finally { fixture.close(); }
});

test("a second picked account queues during the first save and both choices survive redraws", async () => {
  const fixture = await createProductFixture({ env: ENV });
  let releaseFirst;
  const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
  try {
    seedOwnedEntity(fixture, "fixture-household", "Fixture Household");
    const html = await pageHtml(fixture);
    const nodes = await runPage(html, {
      entities: [{ entity_slug: "fixture-household", label: "Fixture Household", status: "active", relationship: "owned" }],
      accounts: [unassigned(1), unassigned(2)],
      onAssign: async (_body, number) => { if (number === 1) await firstPending; },
    });
    const cards = findAll(nodes.get("accounts"), "ARTICLE");
    const [firstSelect] = findAll(cards[0], "SELECT");
    const [firstButton] = findAll(cards[0], "BUTTON");
    firstSelect.value = "fixture-household";
    firstButton.onclick();
    await until(() => nodes.assignments.length === 1, "the first assignment reached the decision point");

    const [secondSelect] = findAll(cards[1], "SELECT");
    const [secondButton] = findAll(cards[1], "BUTTON");
    secondSelect.value = "fixture-household";
    secondSelect.onchange();
    secondButton.onclick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(nodes.assignments.length, 1, "the second assignment is queued behind the pending request");
    assert.equal(secondButton.disabled, true);
    assert.equal(secondButton.textContent, "Queued…");
    releaseFirst();
    await until(() => nodes.assignments.length === 2, "the preserved second choice reached the assignment endpoint");
    assert.deepEqual(nodes.assignments.map((row) => row.account_ref), [
      "acct_00000000000000000000000000000001",
      "acct_00000000000000000000000000000002",
    ]);
  } finally { fixture.close(); }
});

test("a whole-bank choice shares the queue and never overwrites a per-account choice already in flight", async () => {
  const fixture = await createProductFixture({ env: ENV });
  let releaseFirst;
  const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
  let active = 0;
  let maximumActive = 0;
  try {
    seedOwnedEntity(fixture, "fixture-business", "Fixture Business");
    seedOwnedEntity(fixture, "fixture-household", "Fixture Household");
    const html = await pageHtml(fixture);
    const accounts = [unassigned(1), unassigned(2), unassigned(3)];
    const nodes = await runPage(html, {
      entities: [
        { entity_slug: "fixture-business", label: "Fixture Business", status: "active", relationship: "owned" },
        { entity_slug: "fixture-household", label: "Fixture Household", status: "active", relationship: "owned" },
      ],
      accounts,
      onAssign: async (_body, number) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (number === 1) await firstPending;
        active -= 1;
      },
    });
    const [firstCard] = findAll(nodes.get("accounts"), "ARTICLE");
    const [firstSelect] = findAll(firstCard, "SELECT");
    const [firstButton] = findAll(firstCard, "BUTTON");
    firstSelect.value = "fixture-business";
    firstButton.onclick();
    await until(() => nodes.assignments.length === 1, "the per-account choice reached the assignment decision point");

    const bankSelect = findAll(nodes.get("accounts"), "SELECT")
      .find((node) => node.className === "bank-owner-select");
    const bankButton = findAll(nodes.get("accounts"), "BUTTON")
      .find((node) => node.textContent === "Assign this bank");
    assert.ok(bankSelect && bankButton, "the whole-bank control reached its decision point");
    bankSelect.value = "fixture-household";
    bankButton.onclick();
    for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setImmediate(resolve));
    const requestsBeforeRelease = nodes.assignments.length;
    releaseFirst();
    await until(() => nodes.assignments.length >= 3, "the queued bank choices reached the assignment endpoint");

    assert.equal(requestsBeforeRelease, 1, "the bank action does not post alongside the in-flight per-account choice");
    assert.equal(maximumActive, 1, "all assignment requests share one serial queue");
    assert.deepEqual(nodes.assignments.map(({ account_ref, entity_slug }) => ({ account_ref, entity_slug })), [
      { account_ref: accounts[0].account_ref, entity_slug: "fixture-business" },
      { account_ref: accounts[1].account_ref, entity_slug: "fixture-household" },
      { account_ref: accounts[2].account_ref, entity_slug: "fixture-household" },
    ]);
  } finally {
    releaseFirst?.();
    fixture.close();
  }
});

test("a failed per-account save keeps its reason visible without reloading the account list", async () => {
  const fixture = await createProductFixture({ env: ENV });
  const reason = "This account already has financial history. Review its owner before changing it.";
  try {
    seedOwnedEntity(fixture, "fixture-household", "Fixture Household");
    const html = await pageHtml(fixture);
    const nodes = await runPage(html, {
      entities: [{ entity_slug: "fixture-household", label: "Fixture Household", status: "active", relationship: "owned" }],
      accounts: [unassigned(1)],
      onAssign: async () => { throw new Error(reason); },
    });
    const initialLoads = nodes.accountLoads();
    const [card] = findAll(nodes.get("accounts"), "ARTICLE");
    const [select] = findAll(card, "SELECT");
    const [button] = findAll(card, "BUTTON");
    select.value = "fixture-household";
    button.onclick();
    await until(() => nodes.assignments.length === 1, "the rejected per-account choice reached the assignment endpoint");
    for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setImmediate(resolve));

    assert.equal(nodes.accountLoads(), initialLoads, "a rejected save does not replace its reason with a reload summary");
    assert.equal(nodes.get("account-status").textContent, reason);
    const [retryCard] = findAll(nodes.get("accounts"), "ARTICLE");
    const [retrySelect] = findAll(retryCard, "SELECT");
    const [retryButton] = findAll(retryCard, "BUTTON");
    assert.equal(retrySelect.value, "fixture-household", "the rejected owner choice remains selected");
    assert.equal(retryButton.disabled, false, "the rejected save can be retried");
    assert.equal(retryButton.textContent, "Assign account");
  } finally { fixture.close(); }
});

test("a single account choice still makes exactly one assignment request", async () => {
  const fixture = await createProductFixture({ env: ENV });
  try {
    seedOwnedEntity(fixture, "fixture-household", "Fixture Household");
    const html = await pageHtml(fixture);
    const nodes = await runPage(html, {
      entities: [{ entity_slug: "fixture-household", label: "Fixture Household", status: "active", relationship: "owned" }],
      accounts: [unassigned(1)],
    });
    const [card] = findAll(nodes.get("accounts"), "ARTICLE");
    const [select] = findAll(card, "SELECT");
    const [button] = findAll(card, "BUTTON");
    select.value = "fixture-household";
    button.onclick();
    await until(() => nodes.assignments.length === 1, "the single assignment reached the endpoint");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(nodes.assignments.length, 1);
  } finally { fixture.close(); }
});

test("an assigned account offers a reviewed move preview before one idempotent apply", async () => {
  const fixture = await createProductFixture({ env: ENV });
  try {
    seedOwnedEntity(fixture, "fixture-household", "Fixture Household");
    seedOwnedEntity(fixture, "fixture-business", "Fixture Business");
    const html = await pageHtml(fixture);
    const account = {
      ...unassigned(1),
      assignment: {
        state: "assigned",
        entity_scope: { entity_slug: "fixture-household" },
        entity_label: "Fixture Household",
      },
    };
    const nodes = await runPage(html, {
      entities: [
        { entity_slug: "fixture-household", label: "Fixture Household", status: "active", relationship: "owned" },
        { entity_slug: "fixture-business", label: "Fixture Business", status: "active", relationship: "owned" },
      ],
      accounts: [account],
    });
    const [card] = findAll(nodes.get("accounts"), "ARTICLE");
    const move = findAll(card, "BUTTON").find((button) => button.textContent === "Move to another owner");
    assert.ok(move, "the assigned-account move decision point is visible behind the owner session");
    move.onclick();
    const [select] = findAll(card, "SELECT");
    assert.deepEqual(select.options.map((option) => option.value), ["", "fixture-business"]);
    select.value = "fixture-business";
    const review = findAll(card, "BUTTON").find((button) => button.textContent === "Review move");
    review.onclick();
    await until(() => nodes.reassignments.length === 1, "the preview reached the reviewed-move route");
    assert.deepEqual(nodes.reassignments[0], {
      mode: "preview",
      account_ref: account.account_ref,
      from_entity_slug: "fixture-household",
      to_entity_slug: "fixture-business",
    });
    await until(() => /2 transactions and 1 balance snapshot/.test(textOf(card)), "the reviewed counts became visible before apply");
    assert.match(textOf(card), /2 transactions and 1 balance snapshot/);
    const apply = findAll(card, "BUTTON").find((button) => button.textContent === "Move account history");
    assert.ok(apply, "apply is unavailable until the preview has been shown");
    apply.onclick();
    await until(() => nodes.reassignments.length === 2, "the apply reached the reviewed-move route");
    assert.equal(nodes.reassignments[1].mode, "apply");
    assert.match(nodes.reassignments[1].request_id, /^[A-Za-z0-9_-]{1,128}$/);
    assert.equal(nodes.reassignments[1].request_id,
      "00000000-0000-4000-8000-000000000000",
      "the apply retry identity is created once and kept in session storage");
    await until(() => account.assignment.entity_scope.entity_slug === "fixture-business", "the green control applies the reviewed move");
  } finally { fixture.close(); }
});

test("one bank action assigns all 14 unassigned accounts sequentially and reloads once", async () => {
  const fixture = await createProductFixture({ env: ENV });
  let active = 0;
  let maximumActive = 0;
  try {
    seedOwnedEntity(fixture, "fixture-household", "Fixture Household");
    const html = await pageHtml(fixture);
    const accounts = Array.from({ length: 14 }, (_value, index) => unassigned(index + 1));
    const nodes = await runPage(html, {
      entities: [{ entity_slug: "fixture-household", label: "Fixture Household", status: "active", relationship: "owned" }],
      accounts,
      onAssign: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
      },
    });
    const initialLoads = nodes.accountLoads();
    const bankSelect = findAll(nodes.get("accounts"), "SELECT")
      .find((node) => node.className === "bank-owner-select");
    const bankButton = findAll(nodes.get("accounts"), "BUTTON")
      .find((node) => node.textContent === "Assign this bank");
    assert.ok(bankSelect && bankButton, "the 14-account bank reached the bulk-assignment decision point");
    bankSelect.value = "fixture-household";
    bankButton.onclick();
    await until(() => nodes.assignments.length === 14, "all bank accounts reached the assignment endpoint");
    await until(() => nodes.accountLoads() === initialLoads + 1, "the bulk action performed its one final reload");
    assert.equal(maximumActive, 1, "bank assignments are sequential");
    assert.equal(nodes.accountLoads(), initialLoads + 1);
    assert.deepEqual(nodes.assignments.map((row) => row.account_ref), accounts.map((row) => row.account_ref));
    assert.equal(findAll(nodes.get("accounts"), "P").filter((node) => /: Saved\.$/.test(node.textContent)).length, 14,
      "the final bank view reports one successful result per account");
  } finally { fixture.close(); }
});

test("the whole-bank action never changes an account that already has an owner", async () => {
  const fixture = await createProductFixture({ env: ENV });
  try {
    seedOwnedEntity(fixture, "fixture-household", "Fixture Household");
    const html = await pageHtml(fixture);
    const assigned = {
      ...unassigned(1),
      assignment: { state: "assigned", entity_scope: { entity_slug: "existing-owner" }, entity_label: "Existing Owner" },
    };
    const pending = unassigned(2);
    const nodes = await runPage(html, {
      entities: [{ entity_slug: "fixture-household", label: "Fixture Household", status: "active", relationship: "owned" }],
      accounts: [assigned, pending],
    });
    const bankSelect = findAll(nodes.get("accounts"), "SELECT")
      .find((node) => node.className === "bank-owner-select");
    const bankButton = findAll(nodes.get("accounts"), "BUTTON")
      .find((node) => node.textContent === "Assign this bank");
    assert.ok(bankSelect && bankButton, "the bank with one pending account offers the bulk action");
    bankSelect.value = "fixture-household";
    bankButton.onclick();
    await until(() => nodes.assignments.length === 1, "the unassigned control account reached the endpoint");
    assert.equal(nodes.assignments[0].account_ref, pending.account_ref);
    assert.deepEqual(assigned.assignment, {
      state: "assigned", entity_scope: { entity_slug: "existing-owner" }, entity_label: "Existing Owner",
    });
  } finally { fixture.close(); }
});

test("a whole-bank failure keeps its reason in the account result after the final reload", async () => {
  const fixture = await createProductFixture({ env: ENV });
  const reason = "This account already has financial history. Review its owner before changing it.";
  try {
    seedOwnedEntity(fixture, "fixture-household", "Fixture Household");
    const html = await pageHtml(fixture);
    const accounts = [unassigned(1), unassigned(2)];
    const nodes = await runPage(html, {
      entities: [{ entity_slug: "fixture-household", label: "Fixture Household", status: "active", relationship: "owned" }],
      accounts,
      onAssign: async (body) => {
        if (body.account_ref === accounts[0].account_ref) throw new Error(reason);
      },
    });
    const initialLoads = nodes.accountLoads();
    const bankSelect = findAll(nodes.get("accounts"), "SELECT")
      .find((node) => node.className === "bank-owner-select");
    const bankButton = findAll(nodes.get("accounts"), "BUTTON")
      .find((node) => node.textContent === "Assign this bank");
    assert.ok(bankSelect && bankButton, "the bank failure scenario reached the bulk-assignment decision point");
    bankSelect.value = "fixture-household";
    bankButton.onclick();
    await until(() => nodes.assignments.length === 2, "the failed and green-control accounts both reached the endpoint");
    await until(() => nodes.accountLoads() === initialLoads + 1, "the bank action reached its final reload");

    assert.equal(accounts[1].assignment.state, "assigned", "the green-control account was saved");
    const failureLine = findAll(nodes.get("accounts"), "P")
      .find((node) => node.textContent.includes(accounts[0].masked_identifier + ": Not saved."));
    assert.ok(failureLine, "the failed account has a durable result line");
    assert.ok(failureLine.textContent.includes(reason), failureLine.textContent);
    assert.equal(nodes.get("account-status").textContent, reason);
  } finally { fixture.close(); }
});

test("every account load shows waiting progress per bank and for the whole page", async () => {
  const fixture = await createProductFixture({ env: ENV });
  try {
    seedOwnedEntity(fixture, "fixture-household", "Fixture Household");
    const html = await pageHtml(fixture);
    const assigned = {
      ...unassigned(1),
      assignment: { state: "assigned", entity_scope: { entity_slug: "fixture-household" }, entity_label: "Fixture Household" },
    };
    const secondBank = { ...unassigned(4), institution_label: "Example Credit Union" };
    const nodes = await runPage(html, {
      entities: [{ entity_slug: "fixture-household", label: "Fixture Household", status: "active", relationship: "owned" }],
      accounts: [assigned, unassigned(2), unassigned(3), secondBank],
    });
    const groups = findAll(nodes.get("accounts"), "SECTION");
    assert.equal(groups.length, 2, "both bank groups reached the progress decision point");
    assert.ok(textOf(groups[0]).includes("2 of 3 accounts still need an owner."), textOf(groups[0]));
    assert.ok(textOf(groups[1]).includes("1 of 1 account still needs an owner."), textOf(groups[1]));
    assert.equal(nodes.get("account-status").textContent, "3 of 4 accounts still need an owner.");
    const cards = findAll(nodes.get("accounts"), "ARTICLE");
    assert.equal(cards.filter((card) => card.className.includes("waiting")).length, 3);
    assert.equal(cards.filter((card) => !card.className.includes("waiting")).length, 1);
  } finally { fixture.close(); }
});

test("saved connection copy names pending owners and keeps the completed-history copy at zero", async () => {
  const fixture = await createProductFixture({ env: ENV });
  try {
    const html = await pageHtml(fixture);
    const nodes = await runPage(html, {
      entities: [],
      accounts: [],
      connections: [
        { item_ref: "fixture-pending", institution_label: "Pending Bank", status: "connected", accounts_needing_owner: 2 },
        { item_ref: "fixture-ready", institution_label: "Ready Bank", status: "connected", accounts_needing_owner: 0 },
      ],
    });
    const rows = nodes.get("connections").children;
    assert.equal(rows.length, 2, "both connection-message arms were rendered");
    assert.ok(textOf(rows[0]).includes("Connected. 2 accounts need an owner below before history can load."), textOf(rows[0]));
    assert.ok(textOf(rows[1]).includes("Connection saved. Account history may still be loading."), textOf(rows[1]));
  } finally { fixture.close(); }
});

test("the connect page says where disconnecting actually happens", async () => {
  const fixture = await createProductFixture({ env: ENV });
  try {
    const html = await pageHtml(fixture);
    assert.doesNotMatch(html, /You can disconnect at any time/);
    assert.match(html, /To disconnect a bank later, open your Brain and go to Access &gt; Banks &gt; Disconnect\./);
  } finally { fixture.close(); }
});

test("the bank connection head uses the owner app favicon", async () => {
  const fixture = await createProductFixture({ env: ENV });
  try {
    const response = await pageResponse(fixture);
    const csp = response.headers.get("Content-Security-Policy") || "";
    const html = await response.text();
    assert.ok(html.includes(`<link rel="icon" href="${FAVICON}">`), "the bank page uses the shared tab icon");
    assert.ok(html.includes(`<link rel="apple-touch-icon" href="${FAVICON}">`), "the bank page uses the shared touch icon");
    assert.match(csp, /(?:^|; )img-src data:(?:;|$)/, "the page policy permits its data-URL icons");
  } finally { fixture.close(); }
});

test("a signed-out connect page provides a real sign-in link back to the owner app", async () => {
  const fixture = await createProductFixture({ env: ENV });
  try {
    const pageUrl = new URL("https://brain.invalid/app/connect/bank");
    const response = await handleBankFeed(fixture.env, new Request(pageUrl), pageUrl, pageUrl.pathname, {});
    const body = await response.text();
    assert.equal(response.status, 401, "the anonymous navigation reached the sign-in decision point");
    assert.match(response.headers.get("Content-Type") || "", /^text\/html/);
    assert.match(body, /<a href="\/app">Sign in to your Brain<\/a>/);
    assert.doesNotMatch(body, /return[_-]?to|redirect=/i, "the app has no supported return-path parameter to promise");
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
