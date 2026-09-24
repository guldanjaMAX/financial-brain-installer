import assert from "node:assert/strict";
import test from "node:test";

import { CustomApiError, runCustomApiPull } from "../src/lib/custom-api.js";

const TOKEN = ["fixture", "scripted", "sentinel", "42"].join("-");
const AT = new Date("2026-09-24T15:30:00.000Z");

function config() {
  return {
    enabled: true,
    display_name: "store dashboard",
    source: "store-dashboard",
    base_url: "https://dashboard.invalid/api/",
    token_secret: "STORE_DASHBOARD_TOKEN",
    cadence_seconds: 86400,
    endpoints: [{
      name: "sales",
      path: "/sales",
      row_key: ["store", "period", "revenue_stream"],
      legacy_row_key: ["store", "period"],
      document: {
        group_by: ["store", "period"],
        title_template: "{{store}}, {{period}} sales",
        body_template: "Net sales {{sum.net_sales}} across {{row_count}} streams.\n\n{{rows_table}}",
        aggregates: { net_sales: "sum" },
        formats: { net_sales: "currency" },
      },
    }],
  };
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function memoryPersistence() {
  const rows = new Map();
  const documents = new Map();
  const revisions = [];
  return {
    rows, documents, revisions,
    async loadRows({ source, endpoint }) {
      const prefix = `${source}\u0000${endpoint}\u0000`;
      return [...rows.entries()].filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ row_key: key.slice(prefix.length), ...value }));
    },
    async persist({ source, endpoint, rowChanges, documentChanges }) {
      const prefix = `${source}\u0000${endpoint}\u0000`;
      for (const change of rowChanges) {
        const key = `${prefix}${change.row_key}`;
        const prior = rows.get(key);
        const revision = Number(prior?.revision || 0) + (change.action === "unchanged" ? 0 : 1);
        rows.set(key, { row_hash: change.row_hash, row: change.row, revision });
        if (change.action === "updated") revisions.push({ key, revision });
      }
      for (const document of documentChanges) documents.set(document.source_id, document);
    },
  };
}

test("scripted paging handles labeled and legacy sales and builds one readable store-month document", async () => {
  const calls = [];
  const persistence = memoryPersistence();
  const result = await runCustomApiPull(config(), {
    token: TOKEN,
    now: () => AT,
    sleep: async () => {},
    persistence,
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), authorized: new Headers(init.headers).get("Authorization") === `Bearer ${TOKEN}` });
      const url = new URL(input);
      return url.searchParams.get("page") === "2"
        ? json([{ store: "Store B", period: "2026-08-01", net_sales: 70, transactions: 2 }])
        : json({
          data: [
            { store: "Store A", period: "2026-08-01", revenue_stream: "live_animal", net_sales: 100, units: 1, puppies_sold: 1 },
            { store: "Store A", period: "2026-08-01", revenue_stream: "supplies", net_sales: 25, units: 3 },
          ],
          next_page: 2,
        });
    },
  });

  assert.deepEqual(result.rows, { created: 3, updated: 0, unchanged: 0 });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.authorized));
  assert.match(persistence.documents.get("sales:Store A:2026-08-01").content, /\$125\.00 across 2 streams/);
  assert.match(persistence.documents.get("sales:Store B:2026-08-01").content, /\$70\.00 across 1 streams/);
});

test("scripted reruns skip unchanged rows, revise a past month, add a store, and retain absent rows", async () => {
  let version = 1;
  const persistence = memoryPersistence();
  const fetchImpl = async () => json(version === 1
    ? [
      { store: "Store A", period: "2026-08-01", revenue_stream: "services", net_sales: 10 },
      { store: "Store B", period: "2026-08-01", revenue_stream: "other", net_sales: 5 },
    ]
    : [
      { store: "Store A", period: "2026-08-01", revenue_stream: "services", net_sales: 12 },
      { store: "Store C", period: "2026-08-01", revenue_stream: "other", net_sales: 7 },
    ]);
  const options = { token: TOKEN, now: () => AT, sleep: async () => {}, persistence, fetchImpl };
  const first = await runCustomApiPull(config(), options);
  const unchanged = await runCustomApiPull(config(), options);
  version = 2;
  const corrected = await runCustomApiPull(config(), options);

  assert.deepEqual(first.rows, { created: 2, updated: 0, unchanged: 0 });
  assert.deepEqual(unchanged.rows, { created: 0, updated: 0, unchanged: 2 });
  assert.deepEqual(corrected.rows, { created: 1, updated: 1, unchanged: 0 });
  assert.equal(corrected.retained_missing_rows, 1);
  assert.equal(persistence.rows.size, 3);
  assert.equal(persistence.revisions.length, 1);
  assert.match(persistence.documents.get("sales:Store A:2026-08-01").content, /\$12\.00/);
  assert.ok(persistence.documents.has("sales:Store C:2026-08-01"));
});

test("scripted provider failures are bounded, classified, and never reveal the bearer value", async () => {
  const scenarios = [
    ["AUTH_REQUIRED", async () => json({ detail: TOKEN }, 401)],
    ["REMOTE_UNAVAILABLE", async () => json({ detail: TOKEN }, 500)],
    ["INVALID_RESPONSE", async () => new Response("not-json", { headers: { "content-type": "application/json" } })],
    ["RESPONSE_TOO_LARGE", async () => new Response(JSON.stringify("x".repeat(2048)), {
      headers: { "content-type": "application/json", "content-length": "2050" },
    })],
    ["REDIRECT_REFUSED", async () => new Response(null, { status: 302, headers: { location: "https://other.invalid/private" } })],
    ["SECRET_IN_RESPONSE", async () => json([{ store: "Store A", period: "2026-08-01", note: TOKEN }])],
  ];
  for (const [code, fetchImpl] of scenarios) {
    let calls = 0;
    let caught;
    try {
      await runCustomApiPull({ ...config(), max_response_bytes: 1024 }, {
        token: TOKEN,
        now: () => AT,
        sleep: async () => {},
        persistence: memoryPersistence(),
        fetchImpl: async (...args) => { calls++; return fetchImpl(...args); },
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof CustomApiError, code);
    assert.equal(caught.code, code);
    assert.ok(calls > 0, `${code} reached the provider decision point`);
    assert.equal(`${caught.message}\n${JSON.stringify(caught)}`.includes(TOKEN), false);
  }

  let attempts = 0;
  const waits = [];
  const recovered = await runCustomApiPull(config(), {
    token: TOKEN,
    now: () => AT,
    persistence: memoryPersistence(),
    sleep: async (milliseconds) => waits.push(milliseconds),
    fetchImpl: async () => {
      attempts++;
      return attempts < 3
        ? json({ detail: TOKEN }, 429)
        : json([{ store: "Store A", period: "2026-08-01", net_sales: 1 }]);
    },
  });
  assert.equal(recovered.status, "completed");
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [250, 500]);
});
