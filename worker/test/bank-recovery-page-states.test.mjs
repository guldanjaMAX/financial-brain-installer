import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext, Script } from "node:vm";
import { replacementPage } from "../src/lib/bank-replacement-page.js";

async function pageFixture({ operation = false, reply }) {
  const response = replacementPage();
  const html = await response.text();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  const elements = new Map(), calls = [], storageWrites = [];
  const element = tag => ({ tag, children: [], textContent: "", hidden: false, className: "",
    append(...children) { this.children.push(...children); }, replaceChildren() { this.children = []; },
  });
  for (const id of ["message", "error-code", "content", "resume", "cancel"]) {
    const node = element(id === "resume" || id === "cancel" ? "button" : "div");
    const attrs = html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`))[0];
    node.hidden = /\bhidden\b/.test(attrs);
    node.className = attrs.match(/class="([^"]*)"/)?.[1] || "";
    elements.set(id, node);
  }
  const buttons = () => [...elements.values(), ...elements.get("content").children]
    .filter(node => node.tag === "button");
  let resolveResponse;
  const held = new Promise(resolve => { resolveResponse = resolve; });
  const sandbox = {
    URLSearchParams, location: { search: "?item_ref=fixture-item" + (operation ? "&operation_ref=fixture-operation" : "") },
    sessionStorage: { getItem: () => null, setItem(...args) { storageWrites.push(args); }, removeItem() {} },
    document: { getElementById: id => elements.get(id), createElement: element,
      createTextNode: textContent => ({ textContent }), querySelectorAll: () => buttons() },
    fetch: async (url, options) => {
      assert.match(url, /^\/api\/bank-feed\/replacement\//, "only the injected owner route is used");
      calls.push({ url, options });
      await held;
      return typeof reply === "function" ? reply(calls.length) : reply;
    },
  };
  assert.doesNotThrow(() => new Script(script));
  const task = runInNewContext(script, sandbox);
  assert.equal(calls.length, 1, "the recovery read decision was reached");
  return { html, response, elements, calls, storageWrites, buttons, task, resolve: () => resolveResponse() };
}

test("recovery starts with no premature actions, then exposes a single primary on a valid preview", async () => {
  const f = await pageFixture({ reply: Response.json({
    eligible: true, accounts: [], diagnostic: { detail: "Saved history is kept." }, detail: "Review this connection.",
  }) });
  const pendingActions = f.buttons().filter(button => !button.hidden);
  f.resolve(); await f.task;
  assert.equal(pendingActions.length, 0, "buttons stay hidden while the decision is pending");
  const primary = f.buttons().filter(button => !button.hidden && /\bbtn-primary\b/.test(button.className));
  assert.equal(primary.length, 1);
  assert.equal(primary[0].textContent, "Confirm and prepare sign-in");
  assert.equal(f.elements.get("cancel").hidden, true, "no cancellation action before an operation exists");
});

test("a recovery error without detail has a useful fallback, a code and no empty boxes", async () => {
  const f = await pageFixture({ reply: Response.json({ error: "unavailable" }, { status: 503 }) });
  f.resolve(); await f.task;
  assert.match(f.elements.get("message").textContent, /This recovery could not be read/);
  assert.match(f.elements.get("message").textContent, /saved history is kept/);
  assert.equal(f.elements.get("error-code").textContent, "Code BANK_RECOVERY_UNAVAILABLE");
  assert.equal(f.elements.get("error-code").hidden, false);
  assert.match(f.html, /#message:empty/);
  assert.match(f.html, /section:empty/);
  assert.equal(f.elements.get("content").children.length, 0);
  assert.equal(f.elements.get("cancel").hidden, true);
});

test("an existing masked detail remains visible and is never inserted as HTML", async () => {
  const detail = "The bank is unavailable. Reference ending 1234. <untrusted>";
  const f = await pageFixture({ reply: Response.json({ detail, code: "replacement_review_expired" }, { status: 409 }) });
  f.resolve(); await f.task;
  assert.equal(f.elements.get("message").textContent, detail);
  assert.equal(f.elements.get("message").children.length, 0);
  assert.equal(f.elements.get("error-code").textContent, "Code replacement_review_expired");
  assert.equal(f.elements.get("error-code").hidden, false);
});

test("a failed saved-status read exposes retry before any state-changing action", async () => {
  const f = await pageFixture({ operation: true, reply: () => Response.json({}, { status: 503 }) });
  f.resolve(); await f.task;
  assert.match(f.calls[0].url, /\/status\?operation_ref=fixture-operation$/);
  assert.equal(f.elements.get("resume").hidden, false, "a failed read keeps an in-page retry");
  assert.equal(f.elements.get("cancel").hidden, true);
  assert.equal(f.elements.get("content").children.length, 0);
  await f.elements.get("resume").onclick();
  assert.equal(f.calls.length, 2, "retry reaches the same read decision");
  assert.equal(f.calls[1].url, f.calls[0].url);
});

for (const status of [409, 503]) {
  test(`failed saved-recovery status ${status} keeps detail, code and a read-only retry`, async () => {
    const detail = "Saved history is kept. Continue the same recovery after reviewing this result. <untrusted>";
    const f = await pageFixture({ operation: true, reply: call => call === 1
      ? Response.json({ detail, code: "replacement_not_found" }, { status })
      : Response.json({ state: "owner_approved", detail: "Saved history is kept." }) });
    f.resolve(); await f.task;
    assert.equal(f.calls[0].url, "/api/bank-feed/replacement/status?operation_ref=fixture-operation");
    assert.equal(f.elements.get("message").textContent, detail);
    assert.equal(f.elements.get("message").children.length, 0);
    assert.equal(f.elements.get("error-code").textContent, "Code replacement_not_found");
    assert.equal(f.elements.get("error-code").hidden, false);
    assert.equal(f.elements.get("resume").hidden, false);
    assert.equal(f.elements.get("resume").disabled, false);
    assert.equal(f.elements.get("resume").textContent, "Retry recovery status");
    assert.equal(f.elements.get("cancel").hidden, true);
    assert.equal(f.elements.get("content").children.length, 0, "no state-changing actions without known status");
    const retry = f.elements.get("resume").onclick();
    assert.equal(f.calls.length, 2, "retry reaches a second status read");
    assert.equal(f.elements.get("cancel").hidden, true, "cancellation stays hidden during retry");
    await retry;
    assert.equal(f.calls[1].url, f.calls[0].url, "the same saved operation is read again");
    assert.ok(f.calls.every(call => (call.options.method || "GET") === "GET"));
    assert.ok(f.calls.every(call => call.options.credentials === "same-origin"));
    assert.deepEqual(f.storageWrites, [], "retry never creates or replaces a recovery reference");
    assert.equal(f.elements.get("cancel").hidden, false, "known safe status restores cancellation");
    assert.equal(f.elements.get("resume").textContent, "Continue this recovery");
    assert.equal(f.elements.get("error-code").hidden, true, "successful status clears the stale code");
  });
}

for (const [label, body] of [
  ["no detail or code", {}],
  ["a code only", { code: "replacement_review_required" }],
  ["a detail only", { detail: "Keep this saved recovery." }],
]) {
  test(`failed saved status with ${label} has fixed fallbacks and retries the same read`, async () => {
    const f = await pageFixture({ operation: true, reply: () => Response.json(body, { status: 503 }) });
    f.resolve(); await f.task;
    assert.match(f.calls[0].url, /\/status\?operation_ref=fixture-operation$/);
    assert.equal(f.elements.get("message").textContent,
      body.detail || "Recovery status could not be read. Keep this recovery and try again.");
    assert.equal(f.elements.get("error-code").textContent, "Code " + (body.code || "BANK_RECOVERY_UNAVAILABLE"));
    assert.equal(f.elements.get("error-code").hidden, false);
    assert.equal(f.elements.get("resume").hidden, false);
    assert.equal(f.elements.get("cancel").hidden, true);
    await f.elements.get("resume").onclick();
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].url, f.calls[0].url);
    assert.equal(f.elements.get("resume").hidden, false, "retry remains available after another failed read");
    assert.equal(f.elements.get("cancel").hidden, true);
    assert.equal(f.elements.get("content").children.length, 0);
  });
}

for (const operation of [false, true]) {
  for (const failure of ["network", "json"]) {
    test(`${operation ? "saved status" : "preview"} ${failure} failure uses a safe coded fallback`, async () => {
      const f = await pageFixture({ operation, reply: () => {
        if (failure === "network") throw new TypeError("Internal fixture transport detail");
        return new Response("not JSON", { status: 503 });
      } });
      f.resolve(); await f.task;
      assert.equal(f.calls.length, 1, "the read was attempted before failure");
      assert.equal(f.elements.get("message").textContent, operation
        ? "Recovery status could not be read. Keep this recovery and try again."
        : "This recovery could not be read. Reload the page once; your saved history is kept.");
      assert.equal(f.elements.get("error-code").textContent, "Code BANK_RECOVERY_UNAVAILABLE");
      assert.equal(f.elements.get("error-code").hidden, false);
      assert.equal(f.elements.get("cancel").hidden, true);
      assert.equal(f.elements.get("content").children.length, 0);
      if (operation) assert.equal(f.elements.get("resume").hidden, false);
    });
  }
}

for (const state of ["owner_approved", "outcome_unknown"]) {
  test(`recovery ${state} shows cancellation only at the existing safe decision`, async () => {
    const f = await pageFixture({ operation: true, reply: Response.json({ state, detail: "Saved history is kept." }) });
    f.resolve(); await f.task;
    assert.match(f.calls[0].url, /\/status\?/);
    assert.equal(f.elements.get("cancel").hidden, state !== "owner_approved");
    assert.equal(f.elements.get("resume").hidden, false);
    assert.match(f.elements.get("resume").className, /btn-secondary/);
    assert.match(f.elements.get("cancel").className, /btn-secondary/);
    assert.ok(f.buttons().filter(button => !button.hidden && /\bbtn-primary\b/.test(button.className)).length <= 1);
    assert.match(f.response.headers.get("Content-Security-Policy"), /script-src 'nonce-[^']+' https:\/\/cdn\.plaid\.com/);
    assert.doesNotMatch(f.response.headers.get("Content-Security-Policy"), /unsafe-inline/);
  });
}
