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
          fields: ["store", "period", "net_sales"],
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
    return new Response(JSON.stringify({ data: [{ store: "Store A", period: "2026-08-01", net_sales: 10 }] }), {
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
    assert.deepEqual(body.endpoint_results.map(({ name, rows_received, rows_refused, documents }) => ({
      name, rows_received, rows_refused, documents,
    })), [{ name: "sales", rows_received: 1, rows_refused: 0, documents: 1 }]);
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

test("a monthly answer document carries more than eight stores through the real think route", async () => {
  const documents = [];
  const config = {
    enabled: true,
    source: "store-dashboard",
    base_url: "https://dashboard.invalid/api/",
    token_secret: "STORE_DASHBOARD_TOKEN",
    endpoints: [{
      name: "sales",
      path: "/sales",
      row_key: ["store", "period", "revenue_stream"],
      documents: [{
        name: "monthly",
        group_by: ["period"],
        title_template: "{{period}} sales",
        body_template: "{{rows_table}}",
        fields: ["store", "revenue_stream", "net_sales"],
        aggregates: { net_sales: "sum" },
      }],
    }],
  };
  const result = await runCustomApiPull(config, {
    token: TOKEN,
    now: () => new Date("2026-09-24T15:30:00.000Z"),
    sleep: async () => {},
    fetchImpl: async () => new Response(JSON.stringify({
      data: Array.from({ length: 12 }, (_, index) => ({
        store: `Store ${index}`,
        period: "2026-09-01",
        revenue_stream: "services",
        net_sales: index + 1,
      })),
    }), { headers: { "content-type": "application/json" } }),
    persistence: {
      async loadRows() { return []; },
      async loadResponseHash() { return null; },
      async persist({ documentChanges }) { documents.push(...documentChanges); },
    },
  });
  assert.equal(result.documents, 1);
  assert.equal(documents.length, 1, "the cross-store document reached persistence");

  const document = documents[0];
  const row = {
    chunk_uid: `store-dashboard:${document.source_id}#0`,
    doc_uid: `store-dashboard:${document.source_id}`,
    text: document.content,
    source: "store-dashboard",
    source_kind: "custom-api",
    source_id: document.source_id,
    uri: null,
    title: document.title,
    document_date: Date.parse("2026-09-01T00:00:00.000Z"),
    client: null,
    category: "operations",
    date_reliable: 1,
    date_source: "custom-api:period",
    top_folder: null,
    platform: "custom-api",
    text_source: "native",
    text_reliable: 1,
  };
  const sourceRow = {
    name: "store-dashboard",
    kind: "custom-api",
    zone: null,
    status: "ready",
    last_ingest_at: "2026-09-24T15:30:00.000Z",
    last_complete_sweep_at: "2026-09-24T15:30:00.000Z",
    expected_refresh_seconds: 86400,
    stale_reason: null,
    document_count: 1,
    indexing_started_at: null,
    registered: 1,
  };
  let answerPrompt = "";
  const answerEnv = {
    STORAGE: "d1",
    ADMIN_KEY: "fixture-admin-key",
    DB: {
      prepare(sql) {
        return {
          bind() { return this; },
          async all() {
            if (/FROM sources s/.test(sql)) return { results: [sourceRow] };
            if (/unchunked-tax-document-candidates/.test(sql)) return { results: [] };
            return { results: [row] };
          },
          async first() {
            if (/vector_projection_mutation_id AS mutation_id/.test(sql)) {
              return {
                schema_version: 48,
                mutation_id: null,
                mutation_submitted_at: null,
                projection_status: "verified",
                bootstrap_epoch: 0,
                bootstrap_cursor: null,
                bootstrap_high_water: null,
                expected_vectors: 0,
                pending: 0,
                submitted: 0,
                oldest_queued_at: null,
              };
            }
            if (/FROM vector_outbox/.test(sql)) return { n: 0, oldest: null, upserts: 0, deletes: 0, submitted: 0 };
            if (/count\(\*\)/i.test(sql)) return { n: 0, stored_documents: 0, logical_documents: 0 };
            return null;
          },
          async run() { return {}; },
        };
      },
    },
    VECTORIZE: {
      async query() { return { matches: [] }; },
      async describe() { return { vectorCount: 0, processedUpToMutation: null }; },
    },
    AI: {
      async run(model, input) {
        if (String(model).includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
        const system = String(input?.messages?.find((message) => message.role === "system")?.content || "");
        if (/verify a proposed answer/i.test(system)) {
          return { response: { supported: true, complete: true, evidence: [1], reason: "direct support" } };
        }
        answerPrompt = String(input?.messages?.find((message) => message.role === "user")?.content || "");
        return { response: "The monthly record includes all 12 stores [1]." };
      },
    },
  };
  const response = await worker.fetch(new Request("https://brain.invalid/api/rag/think", {
    method: "POST",
    headers: { "X-Admin-Key": "fixture-admin-key", "Content-Type": "application/json" },
    body: JSON.stringify({ q: "Which stores are in the September sales record?", rerank: 0 }),
  }), answerEnv, { waitUntil() {} });
  const body = await response.json();

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.match(body.answer || "", /all 12 stores/i);
  assert.equal(body.citations?.[0]?.source_kind, "custom-api");
  for (let index = 0; index < 12; index++) {
    assert.match(answerPrompt, new RegExp(`Store ${index}(?:\\s|\\|)`), `answer prompt includes store ${index}`);
  }
});
