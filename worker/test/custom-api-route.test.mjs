import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";
import { CUSTOM_API_RUN_PATH, CustomApiError, runCustomApiPull } from "../src/lib/custom-api.js";

const TOKEN = ["fixture", "worker", "sentinel", "42"].join("-");

function env() {
  return {
    STORAGE: "d1",
    ADMIN_KEY: "fixture-admin-key",
    STORE_DASHBOARD_TOKEN: TOKEN,
    CUSTOM_API_CONFIG: JSON.stringify({
      enabled: true,
      display_name: "store dashboard",
      source: "store-dashboard",
      base_url: "https://dashboard.invalid/api/",
      token_secret: "STORE_DASHBOARD_TOKEN",
      cadence_seconds: 86400,
      endpoints: [{
        name: "sales", path: "/sales", row_key: ["store", "period"],
        document: {
          group_by: ["store", "period"],
          title_template: "{{store}} {{period}} sales",
          body_template: "{{rows_table}}",
        },
      }],
    }),
    DB: {
      prepare() {
        return {
          bind() { return this; },
          async all() { return { results: [] }; },
          async first() { return null; },
          async run() { return {}; },
        };
      },
    },
  };
}

test("admin-only dry run executes in the Worker, fetches the declared host, and performs no D1 write", async () => {
  const original = globalThis.fetch;
  let fetches = 0;
  let authorized = false;
  globalThis.fetch = async (input, init) => {
    fetches++;
    authorized = String(input) === "https://dashboard.invalid/api/sales" &&
      new Headers(init.headers).get("Authorization") === `Bearer ${TOKEN}`;
    return new Response(JSON.stringify([{ store: "Store A", period: "2026-08-01", net_sales: 10 }]), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const response = await worker.fetch(new Request(`https://brain.invalid${CUSTOM_API_RUN_PATH}`, {
      method: "POST",
      headers: { "X-Admin-Key": "fixture-admin-key", "Content-Type": "application/json" },
      body: JSON.stringify({ dry_run: true }),
    }), env(), { waitUntil() {} });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.status, "completed");
    assert.equal(body.dry_run, true);
    assert.equal(fetches, 1, "the route reached the configured fetch decision point");
    assert.equal(authorized, true);
    assert.equal(JSON.stringify(body).includes(TOKEN), false);
  } finally {
    globalThis.fetch = original;
  }
});

test("the custom API run route refuses a missing admin key before any fetch", async () => {
  const original = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error("must not run"); };
  try {
    const response = await worker.fetch(new Request(`https://brain.invalid${CUSTOM_API_RUN_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dry_run: true }),
    }), env(), { waitUntil() {} });
    assert.equal(response.status, 401);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("a provider authorization body and bearer value never reach the Worker response or log", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const originalLog = console.log;
  const logs = [];
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    return new Response(JSON.stringify({ detail: TOKEN }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  };
  console.warn = (...parts) => logs.push(parts.join(" "));
  console.log = (...parts) => logs.push(parts.join(" "));
  try {
    const response = await worker.fetch(new Request(`https://brain.invalid${CUSTOM_API_RUN_PATH}`, {
      method: "POST",
      headers: { "X-Admin-Key": "fixture-admin-key", "Content-Type": "application/json" },
      body: JSON.stringify({ dry_run: true }),
    }), env(), { waitUntil() {} });
    const text = await response.text();
    assert.equal(response.status, 401);
    assert.equal(fetches, 1, "the provider authorization decision point was reached");
    assert.match(text, /refused the key/i);
    assert.equal(`${text}\n${logs.join("\n")}`.includes(TOKEN), false);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    console.log = originalLog;
  }
});

test("a request that never returns is aborted at the configured bound", async () => {
  let attempts = 0;
  const config = JSON.parse(env().CUSTOM_API_CONFIG);
  config.timeout_ms = 250;
  config.retries = 1;
  await assert.rejects(
    runCustomApiPull(config, {
      token: TOKEN,
      dryRun: true,
      persistence: { async loadRows() { return []; }, async persist() {} },
      fetchImpl: async (_url, init) => {
        attempts++;
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    }),
    (error) => error instanceof CustomApiError && error.code === "NETWORK_UNREACHABLE",
  );
  assert.equal(attempts, 1, "the bounded request decision point was reached once");
});
