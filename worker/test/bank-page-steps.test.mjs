import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { connectPageHtml } from "../src/lib/bank-feed.js";

const NOW = "2026-11-01T12:00:00.000Z";
const config = {
  provider: "plaid", environment: "sandbox", linkGlobal: "Plaid",
  linkSdkUrl: "https://cdn.plaid.com/link/v2/stable/link-initialize.js",
  apiBase: "https://sandbox.plaid.com",
};
const page = () => connectPageHtml(config, { ownerEntityCount: 0 });

// A small DOM runs the shipped inline script, including visibility inherited
// from collapsed steps. No browser, provider, credentials or CLI is involved.
class Node {
  constructor(tag, attrs = {}) {
    this.tagName = tag.toUpperCase(); this.children = []; this.parent = null;
    this.id = attrs.id || ""; this.className = attrs.class || "";
    this.hidden = "hidden" in attrs; this.open = "open" in attrs;
    this.disabled = "disabled" in attrs; this.value = attrs.value || "";
    this.text = "";
  }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map((node) => node.textContent).join(""); }
  get options() { return this.children.filter((node) => node.tagName === "OPTION"); }
  querySelectorAll(selector) {
    const [tag, ...classes] = selector.split(".");
    return this.children.flatMap((node) => [
      ...((!tag || node.tagName === tag.toUpperCase()) && classes.every((name) => node.className.split(" ").includes(name)) ? [node] : []),
      ...node.querySelectorAll(selector),
    ]);
  }
}
function parseBody(html) {
  const root = new Node("body"); const stack = [root]; const nodes = new Map();
  const body = html.split("<body>")[1].split("<script")[0];
  for (const token of body.matchAll(/<\/(\w+)>|<(\w+)\b([^>]*)>|([^<]+)/g)) {
    if (token[1]) { if (stack.at(-1).tagName === token[1].toUpperCase()) stack.pop(); }
    else if (token[2]) {
      const attrs = Object.fromEntries([...token[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map((m) => [m[1], m[2] || ""]));
      const node = new Node(token[2], attrs); stack.at(-1).append(node);
      if (node.id) nodes.set(node.id, node);
      if (!["input", "br", "meta", "link"].includes(token[2])) stack.push(node);
    } else stack.at(-1).text += token[4];
  }
  return { root, nodes };
}
const visible = (node) => Boolean(node) && !node.hidden && (!node.parent ||
  (visible(node.parent) && (node.parent.tagName !== "DETAILS" || node.parent.open || node.tagName === "SUMMARY")));
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(setImmediate); };
const account = (assigned = false) => ({ account_ref: "fixture-account", institution_label: "Example Bank",
  masked_identifier: "Checking ending 0001", assignment: { state: assigned ? "assigned" : "assignment_required", entity_label: "Owner" } });
const bank = (overrides = {}) => ({ item_ref: "fixture-bank", institution_label: "Example Bank", status: "connected",
  connected_at: "2026-11-01T11:00:00.000Z", accounts_needing_owner: 0,
  health: { state: "never_synced", last_successful_sync_at: null }, ...overrides });
const currentBank = () => bank({ health: { state: "healthy", last_successful_sync_at: "2026-11-01T11:30:00.000Z" } });
async function run({ accounts = [], connections = [], entities = [], failAccounts = false, failStatus = false,
  hash = "", search = "", onExchange = () => ({}) } = {}) {
  const { html } = page(); const { root, nodes } = parseBody(html);
  const state = { accounts, connections, failAccounts, failStatus }; const calls = []; const timers = [];
  const location = new URL("https://brain.invalid/app/connect/bank" + search + hash);
  const storage = new Map(); const links = [];
  let requestNumber = 0;
  const context = vm.createContext({
    document: { getElementById: (id) => nodes.get(id), createElement: (tag) => new Node(tag), visibilityState: "visible" },
    location,
    history: { replaceState(_state, _title, url) { location.href = new URL(url, location).href; } },
    crypto: { randomUUID: () => "fixture-request-" + (++requestNumber).toString().padStart(4, "0") },
    Plaid: { create(link) { return { open() { links.push(link); } }; } },
    URL, URLSearchParams, Date: class extends Date { static now() { return Date.parse(NOW); } },
    sessionStorage: { getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); },
    fetch: async (path, init) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ path, method: init.method, body });
      let data;
      if (path === "/api/bank-feed/accounts") {
        if (state.failAccounts) return { ok: false, status: 503, json: async () => ({ code: "BANK_SYNC_FAILED" }) };
        data = { accounts: state.accounts, summary: { assignment_required: state.accounts.filter((a) => a.assignment.state !== "assigned").length } };
      } else if (path === "/api/bank-feed/status") {
        if (state.failStatus) return { ok: false, status: 503, json: async () => ({ code: "BANK_SYNC_FAILED" }) };
        data = { connections: state.connections };
      } else if (path === "/api/fin/snapshot") data = { entities };
      else if (path === "/api/bank-feed/link-token") data = { link_token: "fixture-link", session_ref: "fixture-session-" + links.length };
      else if (path === "/api/bank-feed/exchange") data = onExchange(state, body);
      else if (path === "/api/bank-feed/accounts/assign") {
        const target = state.accounts.find((value) => value.account_ref === body.account_ref);
        assert.ok(target, "the owner choice names a rendered account");
        assert.ok(entities.some((entity) => entity.entity_slug === body.entity_slug), "the owner choice comes from the loaded list");
        target.assignment = { state: "assigned", entity_label: "Owner", entity_scope: { entity_slug: body.entity_slug } };
        for (const connection of state.connections) connection.accounts_needing_owner = state.accounts.filter((value) => value.assignment.state !== "assigned").length;
        data = { changed: true };
      }
      else throw new Error("Unexpected route in page probe");
      return { ok: true, status: 200, json: async () => data };
    },
  });
  context.window = context;
  const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter(Boolean);
  assert.equal(scripts.length, 1, "the real page script was found");
  vm.runInContext(scripts[0], context); await flush();
  return { nodes, root, state, calls, context, timers, links, async reload() { await vm.runInContext("loadConnections()", context); await flush(); } };
}

const ownedEntity = { entity_slug: "fixture-owner", label: "Owner", status: "active", relationship: "owned" };
const repairSearch = "?mode=reauthorise&item_ref=fixture-bank";
const repairReceipt = { item_ref: "fixture-bank", updated: true, exchanged: false, health_verified: true };
async function completeLink(p, mode) {
  const start = p.nodes.get("start");
  assert.ok(visible(start) && !start.disabled, "the real Link action can be clicked");
  const before = p.links.length;
  await start.onclick(); await flush();
  assert.equal(p.links.length, before + 1, "the Link action reached the SDK");
  const request = p.calls.filter((call) => call.path === "/api/bank-feed/link-token").at(-1);
  assert.equal(request.body.mode, mode);
  assert.equal(request.body.item_ref, mode === "reauthorise" ? "fixture-bank" : null);
  await p.links.at(-1).onSuccess("fixture-public", {}); await flush();
  assert.equal(p.calls.filter((call) => call.path === "/api/bank-feed/exchange").length, before + 1,
    "successful Link reached the real exchange callback");
}

async function chooseAccountOwner(p) {
  const radio = p.nodes.get("accounts").querySelectorAll("input").find((node) => node.type === "radio" && node.value === "mixed");
  assert.ok(visible(radio), "the bank owner question is reachable");
  radio.checked = true; radio.onchange();
  const card = p.nodes.get("accounts").querySelectorAll("article")[0];
  assert.ok(card, "the account reached the real owner renderer");
  const select = card.querySelectorAll("select")[0];
  const button = card.querySelectorAll("button").find((node) => node.textContent === "Assign account");
  assert.ok(visible(select) && visible(button) && !button.disabled, "the owner pick and save are reachable");
  assert.equal(select.value, "", "the owner was not chosen automatically");
  select.value = ownedEntity.entity_slug; select.onchange(); button.onclick(); await flush();
  assert.equal(p.calls.filter((call) => call.path === "/api/bank-feed/accounts/assign").length, 1,
    "the owner's explicit pick reached the assignment route");
  await p.reload();
}

test("STEP 1 has one primary action before accounts exist; later steps and saved connections stay hidden", async () => {
  const p = await run();
  assert.ok(p.calls.some((c) => c.path === "/api/bank-feed/accounts"), "the empty-account decision was reached");
  assert.ok(p.nodes.get("connect-heading")?.textContent.includes("STEP 1 of 3"), "the first step has its number");
  const primary = p.root.querySelectorAll("button").filter((n) => visible(n) && !n.className.includes("secondary"));
  assert.deepEqual(primary.map((n) => n.id), ["start"]);
  assert.equal(visible(p.nodes.get("account-step")), false);
  assert.equal(visible(p.nodes.get("sync-step")), false);
  assert.equal(visible(p.nodes.get("saved-connections")), false);
  assert.ok(p.nodes.get("connect-body").textContent.includes("⏱ About 2 minutes"));
});

test("accounts reveal STEP 2 and preserve the accounts anchor and today's assignment UI", async () => {
  const p = await run({ accounts: [account()], connections: [bank({ accounts_needing_owner: 1 })] });
  assert.equal(p.nodes.get("accounts").querySelectorAll("article").length, 1, "an account reached the real renderer");
  assert.equal(visible(p.nodes.get("account-step")), true);
  assert.ok(p.nodes.get("accounts-heading").textContent.includes("STEP 2 of 3 · Whose accounts are these?"));
  assert.equal(visible(p.nodes.get("accounts")), true, "the Choose owners anchor is inside the visible second step");
  assert.ok(p.nodes.get("account-step").querySelectorAll("div").includes(p.nodes.get("accounts")), "STEP 2 retains id=accounts");
  assert.equal(visible(p.nodes.get("sync-step")), false);
  assert.equal(visible(p.nodes.get("connect-body")), false);
  assert.ok(p.nodes.get("connect-heading").textContent.includes("✓"));
  assert.ok(p.nodes.get("connect-heading").className.includes("ok"));
});

test("assigned accounts collapse STEP 2; first sync is Working on it until exact success readback", async () => {
  const p = await run({ accounts: [account(true)], connections: [bank()] });
  assert.equal(p.calls.filter((c) => c.path === "/api/bank-feed/status").length, 1);
  assert.equal(p.nodes.get("account-step").open, false);
  assert.ok(p.nodes.get("accounts-heading").textContent.includes("✓"));
  assert.equal(visible(p.nodes.get("sync-step")), true);
  assert.ok(p.nodes.get("sync-status").textContent.includes("Working on it · Loading your transactions."));
  assert.ok(!p.nodes.get("sync-heading").textContent.includes("✓"));
  p.state.connections = [currentBank()]; await p.reload();
  assert.ok(p.nodes.get("sync-heading").textContent.includes("STEP 3 of 3 · Done ✓"));
  assert.ok(p.nodes.get("sync-heading").className.includes("ok"));
  assert.equal(visible(p.nodes.get("another")), true);
  assert.ok(p.calls.every((c) => c.method === "GET" || c.path === "/api/fin/snapshot"), "progress only reads data");
});

test("an arriving bank waits in calm words with no owner step until accounts arrive, then advances on refresh", async () => {
  const p = await run({ connections: [bank()] });
  assert.equal(p.nodes.get("connections").children.length, 1, "the arriving bank reached the list");
  assert.ok(p.nodes.get("arrival-status")?.textContent.includes("Working on it · Plaid is sending your accounts."));
  assert.equal(visible(p.nodes.get("account-step")), false);
  p.state.accounts = [account()]; p.state.connections = [bank({ accounts_needing_owner: 1 })]; await p.reload();
  assert.equal(visible(p.nodes.get("accounts")), true);
  assert.equal(p.nodes.get("accounts").querySelectorAll("article").length, 1);
});

test("L2 mapping keeps new partial sync calm and real errors or overdue banks as Problem", async () => {
  const p = await run({ accounts: [account(true)], connections: [bank()] });
  const outcome = (value) => vm.runInContext("bankRowOutcome(" + JSON.stringify(value) + ", Date.now())", p.context);
  assert.ok(outcome(bank({ accounts_needing_owner: 2 })).line.includes("2 accounts need an owner"));
  assert.equal(outcome(bank({ health: { state: "error", last_error_code: "BANK_SYNC_PARTIAL" } })).kind, "working");
  assert.equal(outcome(currentBank()).kind, "current");
  for (const value of [
    bank({ connected_at: "2026-10-30T11:00:00.000Z", health: { state: "error", last_error_code: "BANK_SYNC_PARTIAL" } }),
    bank({ status: "reauth_required" }), bank({ status: "permission_revoked" }),
    bank({ health: { needs_reconnect: true } }), bank({ health: { overdue: true } }),
    bank({ health: { last_error_code: "ITEM_LOGIN_REQUIRED", needs_sign_in: true } }),
    bank({ health: { last_error_code: "BANK_SYNC_FAILED" } }),
  ]) assert.equal(outcome(value).kind, "problem");
});

test("failed progress reads cannot report Done; the healthy readback is the green control", async () => {
  const p = await run({ accounts: [account(true)], connections: [currentBank()] });
  assert.ok(p.nodes.get("sync-heading")?.textContent.includes("Done ✓"), "healthy control reached Done");
  p.state.failAccounts = true; await p.reload();
  assert.ok(p.calls.filter((c) => c.path === "/api/bank-feed/accounts").length >= 3, "the failed read was attempted");
  assert.ok(!p.nodes.get("sync-heading").textContent.includes("Done ✓"));
  p.state.failAccounts = false; await p.reload();
  assert.ok(p.nodes.get("sync-heading").textContent.includes("Done ✓"));
  p.state.failStatus = true; await p.reload();
  assert.ok(!p.nodes.get("sync-heading").textContent.includes("Done ✓"));
});

test("CSP remains byte-identical and the disconnect location and saved-history promise stay in a small footer (controls)", () => {
  const { html, csp } = page();
  assert.equal(csp, "default-src 'none'; script-src 'unsafe-inline' https://cdn.plaid.com; style-src 'unsafe-inline'; img-src data:; connect-src 'self' https://sandbox.plaid.com https://cdn.plaid.com; frame-src https://cdn.plaid.com; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  assert.ok(html.includes("To disconnect a bank later, open your Brain and go to Access &gt; Banks &gt; Disconnect."));
  assert.ok(html.includes("Disconnecting is not done on this page, and your saved history stays."));
});

test("the environment and disconnect notes live in a small footer", () => {
  const { root } = parseBody(page().html);
  const footer = root.querySelectorAll("footer")[0];
  assert.ok(footer, "the footer exists");
  assert.ok(footer.className.includes("note"));
  assert.ok(footer.textContent.includes("Test mode: practice banks, no real money."));
  assert.ok(footer.textContent.includes("Access &gt; Banks &gt; Disconnect."));
});


test("a repair deep link keeps its Link action reachable (healthy and sign-in controls)", async () => {
  for (const connection of [bank({ status: "reauth_required", health: { needs_sign_in: true } }), currentBank()]) {
    const p = await run({ accounts: [account(true)], connections: [connection], search: "?mode=reauthorise&item_ref=fixture-bank" });
    assert.ok(p.calls.some((c) => c.path === "/api/bank-feed/status"), "repair navigation reached status readback");
    assert.equal(visible(p.nodes.get("start")), true, "the existing repair action remains reachable");
    assert.equal(p.nodes.get("start").textContent, "Repair connection");
  }
});

test("repair completion leaves the owner pick reachable before a missing or unchanged sync can finish", async () => {
  for (const previousSync of [undefined, null, "2026-11-01T11:30:00.000Z"]) {
    const p = await run({ accounts: [account()], entities: [ownedEntity], search: repairSearch,
      connections: [bank({ status: "reauth_required", accounts_needing_owner: 1,
        health: { needs_sign_in: true, last_successful_sync_at: previousSync } })],
      onExchange(state) {
        state.connections = [bank({ accounts_needing_owner: 1,
          health: { state: "never_synced", last_successful_sync_at: previousSync } })];
        return repairReceipt;
      } });
    const statusReads = p.calls.filter((call) => call.path === "/api/bank-feed/status").length;
    const accountReads = p.calls.filter((call) => call.path === "/api/bank-feed/accounts").length;
    await completeLink(p, "reauthorise");
    assert.ok(p.calls.filter((call) => call.path === "/api/bank-feed/status").length > statusReads,
      "repair completion reached the status readback");
    assert.ok(p.calls.filter((call) => call.path === "/api/bank-feed/accounts").length > accountReads,
      "repair completion reached the account readback");
    assert.equal(p.state.connections[0].health.last_successful_sync_at, previousSync, "sign-in did not invent a successful sync");
    assert.equal(visible(p.nodes.get("accounts")), true, "repair must not hide the choice that unblocks sync");
    assert.equal(visible(p.nodes.get("start")), false, "verified sign-in completes STEP 1 without waiting for transactions");
    await chooseAccountOwner(p);
    assert.equal(visible(p.nodes.get("sync-step")), true, "the owner pick advanced the real page to loading");
    assert.ok(!p.nodes.get("sync-heading").textContent.includes("Done ✓"), "owner assignment alone cannot prove a sync");
    p.state.connections = [bank({ health: { state: "healthy", last_successful_sync_at: "2026-11-01T11:45:00.000Z" } })];
    await p.reload();
    assert.ok(p.nodes.get("sync-heading").textContent.includes("Done ✓"), "a fresh successful sync finishes the repair");
  }
});

test("a reopened repair keeps an existing unassigned account reachable without a new sync", async () => {
  const p = await run({ accounts: [account()], entities: [ownedEntity], search: repairSearch,
    connections: [bank({ accounts_needing_owner: 1 })] });
  assert.ok(p.calls.some((call) => call.path === "/api/bank-feed/status"));
  assert.ok(p.calls.some((call) => call.path === "/api/bank-feed/accounts"));
  await chooseAccountOwner(p);
  assert.equal(p.state.accounts[0].assignment.state, "assigned");
  assert.ok(!p.nodes.get("sync-heading").textContent.includes("Done ✓"));
});

test("normal first connect still reaches an explicit owner pick and verified Done (green control)", async () => {
  const p = await run({ entities: [ownedEntity], onExchange(state) {
    state.accounts = [account()]; state.connections = [bank({ accounts_needing_owner: 1 })];
    return { item_ref: "fixture-bank", exchanged: true };
  } });
  await completeLink(p, "connect");
  await chooseAccountOwner(p);
  assert.equal(visible(p.nodes.get("sync-step")), true);
  assert.ok(!p.nodes.get("sync-heading").textContent.includes("Done ✓"));
  p.state.connections = [currentBank()]; await p.reload();
  assert.equal(visible(p.nodes.get("another")), true);
});

test("normal repair of assigned accounts still requires a fresh sync for Done (green control)", async () => {
  const p = await run({ accounts: [account(true)], connections: [currentBank()], search: repairSearch,
    onExchange: () => repairReceipt });
  await completeLink(p, "reauthorise");
  assert.ok(!p.nodes.get("sync-heading").textContent.includes("Done ✓"), "an unchanged old healthy receipt is not repair completion");
  p.state.connections = [bank({ health: { state: "healthy", last_successful_sync_at: "2026-11-01T11:45:00.000Z" } })];
  await p.reload();
  assert.equal(visible(p.nodes.get("another")), true);
});

test("Connect another bank after a completed repair requests a fresh connect without the old item", async () => {
  let exchanges = 0;
  const p = await run({ accounts: [account(true)], connections: [currentBank()], search: repairSearch,
    onExchange(state) {
      exchanges++;
      state.connections = [bank({ health: { state: "healthy", last_successful_sync_at: "2026-11-01T11:45:00.000Z" } })];
      if (exchanges === 1) return repairReceipt;
      state.accounts.push({ ...account(true), account_ref: "fixture-second-account" });
      state.connections.push({ ...currentBank(), item_ref: "fixture-second-bank" });
      return { item_ref: "fixture-second-bank", exchanged: true };
    } });
  await completeLink(p, "reauthorise");
  assert.ok(p.nodes.get("sync-heading").textContent.includes("Done ✓"), "the repair reached its completed page");
  assert.equal(visible(p.nodes.get("another")), true);
  p.nodes.get("another").onclick();
  await completeLink(p, "connect");
  assert.equal(p.nodes.get("start").textContent, "Connect my bank");
  assert.equal(p.context.location.search, "", "the old repair URL state was cleared");
  assert.equal(exchanges, 2, "both the repair and new connect reached completion");
  assert.equal(p.state.connections.length, 2, "the fresh connect added a different bank");
  assert.equal(visible(p.nodes.get("start")), false, "the new connection count released the adding-bank step");
  assert.equal(visible(p.nodes.get("another")), true, "the second bank completed the normal flow");
});

test("loading and owner-waiting banks do not invite Repair; a sign-in error retains its Repair link", async () => {
  const p = await run({ accounts: [account()], connections: [bank(), bank({ accounts_needing_owner: 1 }),
    bank({ status: "reauth_required", health: { needs_sign_in: true } })] });
  const rows = p.nodes.get("connections").children;
  assert.equal(rows.length, 3, "loading, waiting and sign-in arms all reached the renderer");
  assert.equal(rows[0].querySelectorAll("a").length, 0);
  assert.equal(rows[1].querySelectorAll("a").length, 0);
  assert.equal(rows[2].querySelectorAll("a")[0].textContent, "Repair connection");
});

test("Done needs a valid successful sync date, including when a health label says healthy", async () => {
  const p = await run({ accounts: [account(true)], connections: [currentBank()] });
  assert.ok(p.nodes.get("sync-heading").textContent.includes("Done ✓"), "valid receipt control completed");
  for (const stamp of [null, "not-a-date", "2026-11-02T12:00:00.000Z", "2026-10-29T12:00:00.000Z"]) {
    p.state.connections = [bank({ health: { state: "healthy", last_successful_sync_at: stamp } })]; await p.reload();
    assert.ok(!p.nodes.get("sync-heading").textContent.includes("Done ✓"), "a missing, malformed, future or overdue receipt cannot complete the step");
  }
});

test("progress polling preserves owner choices, stops after 30 minutes and keeps completed accounts reachable by anchor", async () => {
  const p = await run({ accounts: [account()], connections: [bank({ accounts_needing_owner: 1 })] });
  const originalCard = p.nodes.get("accounts").children[0];
  assert.ok(originalCard, "the account UI was rendered before the poll");
  assert.equal(p.timers.length, 1, "a progress poll was scheduled");
  assert.equal(p.timers[0].delay, 5000);
  p.timers.shift().fn(); await flush();
  assert.equal(p.nodes.get("accounts").children[0], originalCard, "status polling did not replace unsaved owner controls");
  vm.runInContext("Date.now = () => " + (Date.parse(NOW) + 30 * 60 * 1000), p.context);
  p.timers.shift().fn(); await flush();
  assert.equal(p.timers.length, 0, "the polling deadline was reached and stopped scheduling");
  const done = await run({ accounts: [account(true)], connections: [currentBank()], hash: "#accounts" });
  assert.equal(visible(done.nodes.get("accounts")), true, "Choose owners can reopen a completed step");
  done.nodes.get("another").onclick();
  assert.equal(visible(done.nodes.get("start")), true, "a completed bank can start another connection");
  done.state.accounts.push({ ...account(), account_ref: "fixture-second-account" });
  done.state.connections.push(bank({ item_ref: "fixture-second-bank", accounts_needing_owner: 1 }));
  await done.reload();
  assert.equal(visible(done.nodes.get("accounts")), true, "the new bank advanced to owners after connection readback");
});
