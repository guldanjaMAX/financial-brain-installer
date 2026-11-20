import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { connectPageHtml, bankFeedOwnerErrorMessage } from "../src/lib/bank-feed.js";
import { FAVICON } from "../src/lib/app-page.js";
import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";
import { completePlaidLink, createPlaidLinkToken, syncPlaidItem } from "../src/lib/plaid-bank-feed.js";
import { handleBankFeed } from "../src/lib/bank-feed.js";

// Optional archived source makes the same desired-behavior probes reproducible
// against a pinned base without editing the reviewed product source.
function pageRenderer() {
  if (!process.env.BANK_OWNER_PICK_BASE) return connectPageHtml;
  const source = readFileSync(process.env.BANK_OWNER_PICK_BASE, "utf8");
  const start = source.indexOf("export function connectPageHtml(");
  const ending = "\n  return { html, csp };\n}";
  const end = source.indexOf(ending, start);
  assert.ok(start >= 0 && end > start, "the archived page function is complete");
  return vm.runInNewContext("(" + source.slice(start + 7, end + ending.length) + ")", { FAVICON, bankFeedOwnerErrorMessage, URL });
}
const renderPage = pageRenderer();

// Execute the shipped script with isolated fake routes. There is no CLI,
// browser, provider request, credential lookup, or real owner data here.
class Node {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.text = "";
    this.value = ""; this.className = ""; this.disabled = false;
    this.hidden = false; this.checked = false;
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = []; this.text = ""; this.append(...nodes); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map((n) => n.textContent).join(" "); }
  get options() { return this.children.filter((n) => n.tagName === "OPTION"); }
  querySelectorAll(selector) {
    const [tag, cls] = selector.split(".");
    return this.children.flatMap((n) => [
      ...((!tag || n.tagName === tag.toUpperCase()) && (!cls || n.className.split(" ").includes(cls)) ? [n] : []),
      ...n.querySelectorAll(selector),
    ]);
  }
}
const person = { entity_slug: "owner-person", label: "Owner", kind: "person", status: "active", relationship: "owned" };
const business = { ...person, entity_slug: "owner-business", label: "Owner Business", kind: "business" };
const account = (n, name = "Checking") => ({ account_ref: "acct_" + String(n).padStart(32, "0"),
  institution_label: "Example Bank", masked_identifier: name + " ending " + String(n).padStart(4, "0"),
  assignment: { state: "assignment_required" } });
const flush = async () => { for (let i = 0; i < 35; i++) await new Promise(setImmediate); };
const all = (p, tag) => p.nodes.get("accounts").querySelectorAll(tag);
const byClass = (p, tag, cls) => all(p, tag).filter((n) => n.className.split(" ").includes(cls));
const button = (p, label) => all(p, "button").find((n) => n.textContent === label);
const writes = (p, suffix) => p.calls.filter((c) => c.path.endsWith(suffix));
async function run({ accounts = [account(1)], entities = [], failRef = null, holdAssign = null, failCreate = false, omitCreatedOwner = false } = {}) {
  const { html } = renderPage({ provider: "plaid", environment: "sandbox", linkGlobal: "Plaid",
    linkSdkUrl: "https://cdn.plaid.com/link/v2/stable/link-initialize.js", apiBase: "https://sandbox.plaid.com" }, { ownerEntityCount: entities.length });
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => [m[1], new Node("div")]));
  const calls = []; const storage = new Map(); const state = { accounts, entities, failRef };
  let counter = 0; let active = 0; let maxActive = 0;
  const context = vm.createContext({
    document: { getElementById: (id) => nodes.get(id), createElement: (tag) => new Node(tag), visibilityState: "hidden" },
    location: new URL("https://brain.invalid/app/connect/bank"), URL, URLSearchParams,
    Date: class extends Date { static now() { return Date.parse("2026-11-01T12:00:00.000Z"); } },
    crypto: { randomUUID: () => "fixture-request-" + String(++counter).padStart(8, "0") },
    sessionStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
    setTimeout: () => {},
    fetch: async (path, init) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ path, body });
      let data;
      if (path === "/api/fin/snapshot") data = { entities: structuredClone(state.entities) };
      else if (path === "/api/bank-feed/accounts") data = { accounts: structuredClone(state.accounts),
        summary: { assignment_required: state.accounts.filter((a) => a.assignment.state !== "assigned").length } };
      else if (path === "/api/bank-feed/status") data = { connections: [{ item_ref: "fixture-bank", institution_label: "Example Bank",
        status: "connected", connected_at: "2026-11-01T11:00:00Z",
        accounts_needing_owner: state.accounts.filter((a) => a.assignment.state !== "assigned").length,
        health: { state: "never_synced" } }] };
      else if (path === "/api/owner/entities/create") {
        assert.ok(body.legal_name, "a create requires a typed name");
        if (failCreate) return { ok: false, status: 503, json: async () => ({ code: "owner_workspace_unavailable" }) };
        if (!omitCreatedOwner) state.entities.push({ entity_slug: body.entity_slug, label: body.legal_name, legal_name: body.legal_name,
          kind: body.kind, status: "active", relationship: "owned" });
        data = { created: true, entity_slug: body.entity_slug };
      } else if (path === "/api/bank-feed/accounts/assign") {
        active++; maxActive = Math.max(maxActive, active);
        if (holdAssign) await holdAssign(body);
        active--;
        if (body.account_ref === state.failRef) return { ok: false, status: 409,
          json: async () => ({ code: "bank_account_reassignment_requires_review", message: "Review this account before moving it." }) };
        const target = state.accounts.find((a) => a.account_ref === body.account_ref);
        const entity = state.entities.find((e) => e.entity_slug === body.entity_slug);
        assert.ok(target && entity, "assign uses a rendered account and a read-back owner");
        target.assignment = { state: "assigned", entity_scope: { entity_slug: entity.entity_slug }, entity_label: entity.label };
        data = { assigned: true, changed: true, account_ref: target.account_ref, entity_scope: { entity_slug: entity.entity_slug } };
      } else throw new Error("Unexpected fake route: " + path);
      return { ok: true, status: 200, json: async () => data };
    },
  });
  context.window = context;
  const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter(Boolean);
  assert.equal(scripts.length, 1);
  vm.runInContext(scripts[0], context); await flush();
  return { nodes, state, calls, context, maxActive: () => maxActive,
    async reload() { await vm.runInContext("loadAccounts({ quiet: true })", context); await flush(); } };
}
async function pick(p, mode) {
  const radio = all(p, "input").find((n) => n.type === "radio" && n.value === mode);
  assert.ok(radio, "the bank question offers " + mode);
  radio.checked = true; await radio.onchange(); await flush();
}
async function choose(p, entitySlug) {
  const select = byClass(p, "select", "bank-owner-select")[0];
  assert.ok(select, "the explicit bank owner list is present");
  select.value = entitySlug; await select.onchange(); await flush();
}
async function save(p) {
  const action = button(p, "Save accounts");
  assert.ok(action && !action.disabled, "the reviewed bank choice is ready to save");
  await action.onclick(); await flush();
}

test("zero owners: All mine plus one typed name creates a Person then files 14 accounts serially", async () => {
  const p = await run({ accounts: Array.from({ length: 14 }, (_, i) => account(i + 1)) });
  await pick(p, "person");
  const name = byClass(p, "input", "bank-owner-name")[0];
  assert.ok(name, "All mine opens the name box"); assert.equal(name.value, "");
  assert.ok(p.nodes.get("accounts").textContent.includes("Person"));
  name.value = "Owner"; name.oninput(); await save(p);
  const creates = writes(p, "/entities/create"); const assigns = writes(p, "/accounts/assign");
  assert.equal(creates.length, 1); assert.equal(creates[0].body.kind, "person");
  assert.equal(creates[0].body.legal_name, "Owner"); assert.equal(assigns.length, 14);
  assert.ok(assigns.every((c) => c.body.entity_slug === creates[0].body.entity_slug));
  assert.ok(p.calls.indexOf(creates[0]) < p.calls.indexOf(assigns[0])); assert.equal(p.maxActive(), 1);
  assert.ok(p.nodes.get("accounts").textContent.includes("✅ 14 accounts filed under Owner."));
  assert.ok(button(p, "Change one"));
});

test("the initial bank question and every newly opened owner list start without an owner selected", async () => {
  const p = await run({ entities: [person, business] });
  assert.equal(writes(p, "/accounts/assign").length, 0);
  const radios = all(p, "input").filter((n) => n.type === "radio");
  assert.equal(radios.length, 3, "all three bank decisions were rendered");
  assert.ok(radios.every((n) => !n.checked));
  for (const mode of ["person", "business", "mixed"]) {
    await pick(p, mode);
    for (const select of all(p, "select")) {
      assert.equal(select.value, ""); assert.equal(select.options[0].value, "");
      assert.match(select.options[0].textContent, /^Choose/);
    }
  }
});

test("a single existing owner still requires the named All owner's pick", async () => {
  const p = await run({ entities: [person] });
  assert.ok(p.nodes.get("accounts").textContent.includes("All Owner's"));
  assert.equal(writes(p, "/accounts/assign").length, 0);
  await pick(p, "person"); await choose(p, person.entity_slug);
  assert.equal(writes(p, "/accounts/assign").length, 0, "choosing still waits for the visible confirmation");
  await save(p); assert.equal(writes(p, "/accounts/assign").length, 1);
});

test("All my business starts with an empty typed name and a Business kind", async () => {
  const p = await run(); await pick(p, "business");
  const name = byClass(p, "input", "bank-owner-name")[0]; assert.equal(name.value, "");
  assert.ok(p.nodes.get("accounts").textContent.includes("Business"));
  name.value = "Owner Business"; name.oninput(); await save(p);
  assert.equal(writes(p, "/entities/create")[0].body.kind, "business");
});

test("Some of each saves unsent exceptions before the majority and never bulk-overwrites them", async () => {
  const p = await run({ accounts: [account(1), account(2), account(3)], entities: [person, business] });
  await pick(p, "mixed"); await choose(p, person.entity_slug);
  const cards = all(p, "article"); assert.equal(cards.length, 3, "mixed opens the account cards");
  const exception = cards[2].querySelectorAll("select")[0];
  exception.value = business.entity_slug; exception.onchange();
  assert.equal(writes(p, "/accounts/assign").length, 0, "exception is saved with the bank decision");
  await save(p);
  assert.deepEqual(writes(p, "/accounts/assign").map((c) => [c.body.account_ref, c.body.entity_slug]), [
    [p.state.accounts[2].account_ref, business.entity_slug],
    [p.state.accounts[0].account_ref, person.entity_slug], [p.state.accounts[1].account_ref, person.entity_slug],
  ]);
});

test("All mine lists every name and mask first, and holds Business Checking out for its own question", async () => {
  const accounts = [account(1, "Business Checking"), account(2, "Personal Checking"), account(3, "Personal Savings")];
  const p = await run({ accounts, entities: [person, business] });
  await pick(p, "person"); await choose(p, person.entity_slug);
  assert.equal(writes(p, "/accounts/assign").length, 0);
  for (const a of accounts) assert.ok(p.nodes.get("accounts").textContent.includes(a.masked_identifier), "confirmation names " + a.masked_identifier);
  assert.ok(p.nodes.get("accounts").textContent.includes("Is this one Owner's too?"));
  await save(p);
  assert.deepEqual(writes(p, "/accounts/assign").map((c) => c.body.account_ref), accounts.slice(1).map((a) => a.account_ref));
  assert.equal(p.state.accounts[0].assignment.state, "assignment_required");
  assert.ok(p.nodes.get("accounts").textContent.includes("Is this one Owner's too?"));
  const held = all(p, "article").find((n) => n.textContent.includes("Business Checking"));
  const select = held.querySelectorAll("select")[0]; select.value = business.entity_slug; select.onchange();
  await held.querySelectorAll("button")[0].onclick(); await flush();
  assert.equal(p.state.accounts[0].assignment.entity_scope.entity_slug, business.entity_slug, "a separate explicit choice unblocks it");
});

test("business words for Person/Household and Personal for Business always ask rather than label", async () => {
  for (const owner of [person, { ...person, kind: "household" }, business]) {
    const labels = owner.kind === "business" ? ["Personal Checking"] : ["Business Checking", "Store LLC", "Store Inc.", "Store Corp", "Store Company"];
    const p = await run({ entities: [owner], accounts: [...labels.map((n, i) => account(i + 1, n)), account(20, "Checking")] });
    await pick(p, owner.kind === "business" ? "business" : "person"); await choose(p, owner.entity_slug); await save(p);
    assert.equal(writes(p, "/accounts/assign").length, 1, "the ordinary account is the green bulk control");
    assert.equal(writes(p, "/accounts/assign")[0].body.account_ref, p.state.accounts.at(-1).account_ref);
    assert.ok(p.state.accounts.slice(0, -1).every((a) => a.assignment.state === "assignment_required"));
  }
});

// Drive provider labels through discovery, staging and the owner account route
// before running the shipped page. Hand-built display strings miss truncation.
async function providerInventory(t, labels, masks) {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-01T12:02:00.000Z") });
  const env = { BANK_FEED_PROVIDER: "plaid", BANK_FEED_ENV: "sandbox", BANK_FEED_CLIENT_ID: "fixture-client-id",
    BANK_FEED_SECRET: "fixture-secret", BANK_FEED_WRAPPING_KEY_V2: ["v2", "A".repeat(43)].join(".") };
  const fixture = await createProductFixture({ env });
  const calls = [];
  const provider = async (url) => {
    const path = new URL(url).pathname; calls.push(path);
    if (path === "/link/token/create") return Response.json({ link_token: "fixture-link", expiration: "2026-11-01T13:00:00.000Z" });
    if (path === "/item/public_token/exchange") return Response.json({ access_token: "fixture-access", item_id: "fixture-item" });
    if (path === "/accounts/get") return Response.json({ accounts: labels.map((name, i) => ({
      account_id: "fixture-account-" + i, name, mask: masks[i], type: "depository", subtype: "checking",
      balances: { current: "100.00", iso_currency_code: "USD" },
    })) });
    if (path === "/transactions/sync") return Response.json({ added: [], modified: [], removed: [], has_more: false,
      next_cursor: "fixture-cursor", transactions_update_status: "HISTORICAL_UPDATE_COMPLETE" });
    throw new Error("Unexpected synthetic provider path");
  };
  try {
    const link = await createPlaidLinkToken(fixture.env, { url: "https://brain.invalid/app/connect/bank", sessionRef: "fixture-link-request", fetchImpl: provider, now: "2026-11-01T12:00:00.000Z" });
    await completePlaidLink(fixture.env, { requestId: "fixture-link-complete", sessionRef: link.session_ref, publicToken: "fixture-public", fetchImpl: provider, now: "2026-11-01T12:01:00.000Z" });
    const staged = await syncPlaidItem(fixture.env, "fixture-item", { fetchImpl: provider, now: "2026-11-01T12:02:00.000Z" });
    assert.equal(staged.status, "assignment_required", "the real sync reached the assignment guard");
    assert.ok(calls.includes("/accounts/get") && calls.includes("/transactions/sync"), "provider discovery and staging were reached");
    const url = new URL("https://brain.invalid/api/bank-feed/accounts");
    const response = await handleBankFeed(fixture.env, new Request(url, { headers: await fixture.ownerHeaders() }), url, url.pathname);
    assert.equal(response.status, 200, "the real account-status route read the staged inventory");
    const status = await response.json();
    assert.equal(status.accounts.length, labels.length);
    assert.equal(status.summary.assignment_required, labels.length);
    return status.accounts;
  } finally { fixture.close(); }
}

for (const [kind, suffix] of [["person", "LLC"], ["household", "Company"], ["business", "Personal"]]) {
  test("truncated provider labels need separate confirmation for a " + kind + " bulk pick", async (t) => {
    const prefix = "Regional operating account for customer receipts, vendor payments and reserve transfers";
    assert.ok(prefix.length > 80, "the distinguishing word is beyond the producer limit");
    const accounts = await providerInventory(t, [prefix + " " + suffix, prefix + " other " + suffix, "Checking"], ["0001", "0001", "0003"]);
    const heldAccounts = accounts.filter((a) => a.masked_identifier !== "Checking ending 0003");
    const ordinary = accounts.find((a) => a.masked_identifier === "Checking ending 0003");
    assert.equal(heldAccounts.length, 2);
    assert.equal(heldAccounts[0].masked_identifier, heldAccounts[1].masked_identifier, "similar names and masks lose their distinguishing suffixes");
    assert.equal(heldAccounts[0].masked_identifier, prefix.slice(0, 80) + " ending 0001");
    assert.doesNotMatch(heldAccounts[0].masked_identifier, /\b(LLC|Company|Personal)\b/i);
    const owner = kind === "business" ? business : { ...person, kind };
    const other = kind === "business" ? person : business;
    const p = await run({ accounts, entities: [owner, other] });
    await pick(p, kind === "business" ? "business" : "person"); await choose(p, owner.entity_slug);
    const preview = byClass(p, "div", "bank-owner-review")[0];
    assert.equal(preview.querySelectorAll("li").filter((n) => n.textContent.endsWith("Choose separately")).length, 2, "ambiguous labels cannot preview the bulk owner");
    assert.equal(all(p, "article").filter((n) => n.textContent.includes("Choose its owner separately.")).length, 2);
    await save(p);
    assert.deepEqual(writes(p, "/accounts/assign").map((c) => c.body.account_ref), [ordinary.account_ref], "the ordinary account reached and passed the bulk decision");
    assert.ok(heldAccounts.every((a) => p.state.accounts.find((v) => v.account_ref === a.account_ref).assignment.state === "assignment_required"));
    // Identical display strings must still save the distinct refs and choices.
    for (const [i, held] of heldAccounts.entries()) {
      const card = all(p, "article").find((n) => n.querySelectorAll("select").some((s) => s.id === "entity-" + held.account_ref));
      assert.ok(card, "the held account retains its own explicit owner control");
      const select = card.querySelectorAll("select")[0]; select.value = i === 0 ? other.entity_slug : owner.entity_slug; select.onchange();
      await card.querySelectorAll("button")[0].onclick(); await flush();
      assert.equal(p.state.accounts.find((a) => a.account_ref === held.account_ref).assignment.entity_scope.entity_slug, select.value);
    }
    assert.equal(writes(p, "/accounts/assign").length, 3, "explicit choices complete both held accounts");
    assert.ok(p.state.accounts.every((a) => a.assignment.state === "assigned"));
  });
}

for (const length of [79, 80, 81]) {
  test("unmasked provider label boundary " + length + " keeps the owner decision explicit", async (t) => {
    const label = "Account ".padEnd(length, "x");
    const accounts = await providerInventory(t, [label, "Checking"], [null, null]);
    const held = accounts.find((a) => a.masked_identifier === label.slice(0, 80));
    const ordinary = accounts.find((a) => a.masked_identifier === "Checking");
    assert.ok(held && ordinary, "the real producer returned the bounded label and ordinary control without masks");
    const p = await run({ accounts, entities: [person] });
    await pick(p, "person"); await choose(p, person.entity_slug); await save(p);
    const saved = writes(p, "/accounts/assign").map((c) => c.body.account_ref);
    assert.ok(saved.includes(ordinary.account_ref), "ordinary control reached the bulk assignment");
    assert.equal(saved.includes(held.account_ref), length < 80, "a label at the cap may have lost a distinguishing word");
    assert.equal(p.state.accounts.find((a) => a.account_ref === held.account_ref).assignment.state,
      length < 80 ? "assigned" : "assignment_required");
  });
}

test("a rejected assignment stays waiting with a line and stable code while the green account saves", async () => {
  const accounts = [account(1), account(2)];
  const p = await run({ accounts, entities: [person], failRef: accounts[0].account_ref });
  await pick(p, "person"); await choose(p, person.entity_slug); await save(p);
  assert.equal(writes(p, "/accounts/assign").length, 2, "both decision points were reached");
  assert.equal(p.state.accounts[0].assignment.state, "assignment_required");
  assert.equal(p.state.accounts[1].assignment.state, "assigned", "green control");
  assert.ok(p.nodes.get("accounts").textContent.includes("bank_account_reassignment_requires_review"));
  assert.ok(p.nodes.get("accounts").textContent.includes("Not saved."));
});

test("bulk queue control skips an already assigned account and an unsent per-account choice", async () => {
  const accounts = [account(1), account(2), account(3)];
  accounts[0].assignment = { state: "assigned", entity_scope: { entity_slug: business.entity_slug }, entity_label: business.label };
  const p = await run({ accounts, entities: [person, business] });
  await vm.runInContext("pendingAccountChoices.set('" + accounts[1].account_ref + "', 'owner-business')", p.context);
  await vm.runInContext("assignBankAccounts('Example Bank', " + JSON.stringify(accounts) + ", 'owner-person', document.createElement('button'), document.createElement('div'))", p.context);
  assert.equal(writes(p, "/accounts/assign").length, 1, "eligible account reached the bulk decision point");
  assert.equal(writes(p, "/accounts/assign")[0].body.account_ref, accounts[2].account_ref);
  assert.equal(p.state.accounts[0].assignment.entity_scope.entity_slug, business.entity_slug);
  assert.equal(p.state.accounts[1].assignment.state, "assignment_required");
});

test("a failed exception stops the majority, stays waiting with its code, and can retry without changing its owner", async () => {
  const accounts = [account(1), account(2)];
  const p = await run({ accounts, entities: [person, business], failRef: accounts[1].account_ref });
  await pick(p, "mixed"); await choose(p, person.entity_slug);
  const select = all(p, "article")[1].querySelectorAll("select")[0];
  select.value = business.entity_slug; select.onchange(); await save(p);
  assert.equal(writes(p, "/accounts/assign").length, 1, "the exception reached its decision before bulk work");
  assert.ok(p.state.accounts.every((a) => a.assignment.state === "assignment_required"));
  assert.ok(p.nodes.get("accounts").textContent.includes("bank_account_reassignment_requires_review"));
  p.state.failRef = null; await save(p);
  assert.deepEqual(writes(p, "/accounts/assign").map((c) => c.body.entity_slug), [business.entity_slug, business.entity_slug, person.entity_slug]);
  assert.equal(p.state.accounts[1].assignment.entity_scope.entity_slug, business.entity_slug, "retry control keeps the exception owner");
  assert.equal(p.state.accounts[0].assignment.entity_scope.entity_slug, person.entity_slug);
});

test("failed or unreadable owner creation never files an account; a confirmed create is the control", async () => {
  for (const options of [{ failCreate: true }, { omitCreatedOwner: true }, {}]) {
    const p = await run(options); await pick(p, "person");
    const name = byClass(p, "input", "bank-owner-name")[0]; name.value = "Owner"; name.oninput();
    await save(p);
    assert.equal(writes(p, "/entities/create").length, 1, "create decision was reached");
    const failed = options.failCreate || options.omitCreatedOwner;
    assert.equal(writes(p, "/accounts/assign").length, failed ? 0 : 1);
    if (failed) assert.match(p.nodes.get("account-status").textContent, /code:/i);
  }
});

test("a redraw preserves a typed name and rejects a stale save; the current save still works", async () => {
  const p = await run(); await pick(p, "person");
  const name = byClass(p, "input", "bank-owner-name")[0]; name.value = "Owner"; name.oninput();
  const stale = button(p, "Save accounts");
  await p.reload();
  assert.equal(byClass(p, "input", "bank-owner-name")[0].value, "Owner", "only owner input survives the redraw");
  await stale.onclick();
  assert.ok(p.nodes.get("account-status").textContent.includes("bank_account_status_unavailable"), "stale action reached its guard");
  assert.equal(writes(p, "/entities/create").length, 0);
  await save(p); assert.equal(writes(p, "/accounts/assign").length, 1);
});

test("each bank gets one question and a redraw cannot hide another bank's missing-owner form", async () => {
  const p = await run({ accounts: [account(1), { ...account(2), institution_label: "Example Credit Union" }] });
  assert.equal(all(p, "input").filter((n) => n.type === "radio").length, 6, "both bank questions reached the page");
  await pick(p, "mixed");
  assert.equal(p.nodes.get("entity-details").hidden, false, "mixed with no owners exposes the add-owner action");
  await p.reload();
  assert.equal(p.nodes.get("entity-details").hidden, false, "the untouched second bank cannot hide that action");
  assert.equal(writes(p, "/accounts/assign").length, 0);
});

test("server control: assignment resumes sync only after the last owner-confirmed choice", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-01T12:02:00.000Z") });
  const env = { BANK_FEED_PROVIDER: "plaid", BANK_FEED_ENV: "sandbox", BANK_FEED_CLIENT_ID: "fixture-client-id",
    BANK_FEED_SECRET: "fixture-secret", BANK_FEED_WRAPPING_KEY_V2: ["v2", "A".repeat(43)].join(".") };
  const fixture = await createProductFixture({ env });
  const providerCalls = []; const work = [];
  const provider = async (url) => {
    const path = new URL(url).pathname; providerCalls.push(path);
    if (path === "/link/token/create") return Response.json({ link_token: "fixture-link", expiration: "2026-11-01T13:00:00.000Z" });
    if (path === "/item/public_token/exchange") return Response.json({ access_token: "fixture-access", item_id: "fixture-item" });
    if (path === "/accounts/get") return Response.json({ accounts: [1, 2].map((i) => ({ account_id: "fixture-account-" + i, name: "Checking", mask: "000" + i, type: "depository", subtype: "checking", balances: { current: "100.00", iso_currency_code: "USD" } })) });
    if (path === "/transactions/sync") return Response.json({ added: [{ transaction_id: "fixture-row", account_id: "fixture-account-1", amount: "10.00", iso_currency_code: "USD", date: "2026-10-31", pending: false, name: "Fixture purchase" }], modified: [], removed: [], has_more: false, next_cursor: "fixture-cursor", transactions_update_status: "HISTORICAL_UPDATE_COMPLETE" });
    throw new Error("Unexpected synthetic provider path");
  };
  try {
    seedOwnedEntity(fixture, person.entity_slug, person.label);
    const link = await createPlaidLinkToken(fixture.env, { url: "https://brain.invalid/app/connect/bank", sessionRef: "fixture-link-request", fetchImpl: provider, now: "2026-11-01T12:00:00.000Z" });
    await completePlaidLink(fixture.env, { requestId: "fixture-link-complete", sessionRef: link.session_ref, publicToken: "fixture-public", fetchImpl: provider, now: "2026-11-01T12:01:00.000Z" });
    const staged = await syncPlaidItem(fixture.env, "fixture-item", { fetchImpl: provider, now: "2026-11-01T12:02:00.000Z" });
    assert.equal(staged.status, "assignment_required", "sync reached the owner-assignment guard; code=" + staged.code);
    const syncCallsBeforeChoices = providerCalls.filter((p) => p === "/transactions/sync").length;
    const rows = fixture.rows("SELECT account_ref FROM plaid_account_entity_assignments ORDER BY account_ref");
    assert.equal(rows.length, 2, "both accounts were discovered through the real link path");
    const headers = await fixture.ownerHeaders();
    for (let i = 0; i < rows.length; i++) {
      const url = new URL("https://brain.invalid/api/bank-feed/accounts/assign");
      const response = await handleBankFeed(fixture.env, new Request(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: "fixture-assign-" + i, account_ref: rows[i].account_ref, entity_slug: person.entity_slug }) }), url, url.pathname,
      { waitUntil: (promise) => work.push(promise), bankFeedFetchImpl: provider, bankFeedNow: "2026-11-01T12:02:00.000Z" });
      assert.equal(response.status, 201, "the real assignment decision committed");
      assert.equal(work.length, i === 0 ? 0 : 1);
      if (i === 0) {
        assert.equal(providerCalls.filter((p) => p === "/transactions/sync").length, syncCallsBeforeChoices, "no early sync");
        assert.equal(fixture.rows("SELECT txn_uid FROM fin_transactions").length, 0, "staged activity is still paused");
      }
    }
    await Promise.all(work);
    assert.equal(fixture.rows("SELECT txn_uid FROM fin_transactions").length, 1, "green control promotes the retained window after all choices");
  } finally { fixture.close(); }
});
