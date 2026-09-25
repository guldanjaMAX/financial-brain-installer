import assert from "node:assert/strict";
import test from "node:test";

import {
  CustomApiError,
  customApiOwnerMessage,
  runCustomApiPull,
  validateCustomApiConfig,
} from "../src/lib/custom-api.js";

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
      document: {
        group_by: ["store", "period"],
        title_template: "{{store}}, {{period}} sales",
        body_template: "Net sales {{sum.net_sales}} across {{row_count}} streams.\n\n{{rows_table}}",
        aggregates: { net_sales: "sum" },
        formats: { net_sales: "currency" },
        fields: ["store", "period", "revenue_stream", "net_sales", "transactions", "units", "puppies_sold"],
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
  const responseHashes = new Map();
  const writes = [];
  return {
    rows, documents, revisions, responseHashes, writes,
    async loadRows({ source, endpoint }) {
      const prefix = `${source}\u0000${endpoint}\u0000`;
      return [...rows.entries()].filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ row_key: key.slice(prefix.length), ...value }));
    },
    async loadResponseHash({ source, endpoint }) {
      return responseHashes.get(`${source}\u0000${endpoint}`) || null;
    },
    async persist({ source, endpoint, rowChanges, documentChanges, responseHash }) {
      const prefix = `${source}\u0000${endpoint}\u0000`;
      for (const change of rowChanges) {
        const key = `${prefix}${change.row_key}`;
        const prior = rows.get(key);
        const revision = Number(prior?.revision || 0) + (change.action === "unchanged" ? 0 : 1);
        rows.set(key, {
          row_hash: change.row_hash, row: change.row, revision,
          present: !["missing", "unchanged_missing"].includes(change.action),
        });
        if (change.action === "updated") revisions.push({ key, revision });
      }
      for (const document of documentChanges) documents.set(document.source_id, document);
      responseHashes.set(`${source}\u0000${endpoint}`, responseHash);
      writes.push({ endpoint, documents: documentChanges.map((document) => document.source_id) });
    },
  };
}

function realShapeConfig() {
  return {
    ...config(),
    endpoints: [
      {
        ...config().endpoints[0],
        document: {
          ...config().endpoints[0].document,
          body_template: "Net sales {{sum.net_sales}}. {{missing.revenue_stream}}\n\n{{rows_table}}",
          fields: ["store", "period", "revenue_stream", "net_sales", "transactions", "units", "puppies_sold"],
          expected_values: {
            revenue_stream: ["live_animal", "supplies", "services", "other"],
          },
        },
      },
      {
        name: "inventory",
        path: "/inventory",
        row_key: ["store", "breed"],
        document: {
          group_by: [],
          title_template: "Inventory {{fetched_date}}",
          body_template: "{{rows_table}}",
          fields: ["store", "breed", "count"],
        },
      },
      {
        name: "costs",
        path: "/costs",
        row_key: ["store", "breed"],
        document: {
          group_by: [],
          title_template: "Costs {{fetched_date}}",
          body_template: "{{rows_table}}",
          fields: ["store", "breed", "avg_cost", "received"],
          formats: { avg_cost: "currency" },
        },
      },
    ],
  };
}

test("real-feed defaults allow a slow five-megabyte full-history snapshot", () => {
  const parsed = validateCustomApiConfig(config());
  assert.equal(parsed.timeout_ms, 30_000);
  assert.ok(parsed.max_response_bytes >= 5 * 1024 * 1024);
  assert.equal(parsed.max_rows, 10_000);
});

test("the row ceiling accepts 2,001 and 10,000, refuses 10,001, and leaves the refused endpoint unchanged", async () => {
  const salesOnly = { ...realShapeConfig(), endpoints: [realShapeConfig().endpoints[0]] };
  const row = (index) => ({
    store: `Store ${index}`, period: "2026-09-01", revenue_stream: "services",
    net_sales: index, transactions: 1, units: 1, puppies_sold: 0,
  });
  for (const rowCount of [2_001, 10_000]) {
    const accepted = memoryPersistence();
    const result = await runCustomApiPull(salesOnly, {
      token: TOKEN, now: () => AT, sleep: async () => {}, persistence: accepted,
      fetchImpl: async () => json({ data: Array.from({ length: rowCount }, (_, index) => row(index)) }),
    });
    assert.equal(result.endpoint_results[0].rows_accepted, rowCount);
    assert.ok(accepted.rows.size > 0, `the ${rowCount}-row decision reached persistence`);
  }
  const refused = memoryPersistence();
  await assert.rejects(
    runCustomApiPull(salesOnly, {
      token: TOKEN, now: () => AT, sleep: async () => {}, persistence: refused,
      fetchImpl: async () => json({ data: Array.from({ length: 10_001 }, (_, index) => row(index)) }),
    }),
    (error) => error?.code === "RESPONSE_TOO_LARGE" && /left unchanged/i.test(customApiOwnerMessage(error.code)),
  );
  assert.equal(refused.rows.size, 0, "the refused endpoint did not reach persistence");
});

test("socket-free real-shape fixtures preserve numeric quirks and null stores while keeping extras out of prose", async () => {
  const persistence = memoryPersistence();
  const bodies = {
    sales: { data: [
      {
        store: "Store A", period: "2026-09-01", revenue_stream: "live_animal",
        net_sales: 100, transactions: 2, units: 1, puppies_sold: 1, extra_metric: 99,
      },
      {
        store: "Store A", period: "2026-09-01", revenue_stream: "supplies",
        net_sales: -1.25, transactions: 1, units: -1,
      },
    ] },
    inventory: { data: [{ store: null, breed: "Item 1", count: 2 }] },
    costs: { data: [{ store: null, breed: "Item 1", avg_cost: 700, received: 3 }] },
  };
  const result = await runCustomApiPull(realShapeConfig(), {
    token: TOKEN,
    now: () => AT,
    sleep: async () => {},
    persistence,
    fetchImpl: async (input) => json(bodies[new URL(input).pathname.split("/").pop()]),
  });

  assert.deepEqual(result.rows, { created: 4, updated: 0, unchanged: 0 });
  assert.equal(result.refused_rows, 0);
  assert.equal(result.endpoint_results.length, 3);
  assert.ok(persistence.rows.has("store-dashboard\u0000inventory\u0000store=null|breed=\"Item 1\""));
  assert.ok(persistence.rows.has("store-dashboard\u0000costs\u0000store=null|breed=\"Item 1\""));
  assert.equal(
    persistence.rows.get("store-dashboard\u0000sales\u0000store=\"Store A\"|period=\"2026-09-01\"|revenue_stream=\"live_animal\"").row.extra_metric,
    99,
  );
  const sales = persistence.documents.get("sales:Store A:2026-09-01").content;
  assert.match(sales, /\$98\.75/);
  assert.match(sales, /no services sales recorded/i);
  assert.match(sales, /no other sales recorded/i);
  assert.doesNotMatch(sales, /\$0\.00/);
  assert.doesNotMatch(sales, /extra_metric/);
  assert.match(persistence.documents.get("inventory:2026-09-24").content, /unassigned/);
});

test("only the changed current-month document is revised and an identical body skips all writes", async () => {
  let currentNetSales = 10;
  const persistence = memoryPersistence();
  const options = {
    token: TOKEN,
    now: () => AT,
    sleep: async () => {},
    persistence,
    fetchImpl: async () => json({ data: [
      { store: "Store A", period: "2026-08-01", revenue_stream: "services", net_sales: 20, transactions: 1, units: 1, puppies_sold: 0 },
      { store: "Store A", period: "2026-09-01", revenue_stream: "services", net_sales: currentNetSales, transactions: 1, units: 1, puppies_sold: 0 },
    ] }),
  };
  const salesOnly = { ...realShapeConfig(), endpoints: [realShapeConfig().endpoints[0]] };
  await runCustomApiPull(salesOnly, options);
  currentNetSales = 12.5;
  const changed = await runCustomApiPull(salesOnly, options);
  const writesBeforeIdentical = persistence.writes.length;
  const identical = await runCustomApiPull(salesOnly, options);

  assert.deepEqual(persistence.writes[1].documents, ["sales:Store A:2026-09-01"]);
  assert.equal(changed.documents, 1);
  assert.equal(identical.documents, 0);
  assert.equal(identical.endpoint_results[0].body_unchanged, true);
  assert.equal(persistence.writes.length, writesBeforeIdentical, "the identical body made no persistence call");
});

test("a three-decimal sale refuses only that row and reports the endpoint count", async () => {
  const persistence = memoryPersistence();
  const salesOnly = { ...realShapeConfig(), endpoints: [realShapeConfig().endpoints[0]] };
  const result = await runCustomApiPull(salesOnly, {
    token: TOKEN,
    now: () => AT,
    sleep: async () => {},
    persistence,
    fetchImpl: async () => json({ data: [
      { store: "Store A", period: "2026-09-01", revenue_stream: "services", net_sales: 1.234, transactions: 1, units: 1, puppies_sold: 0 },
      { store: "Store A", period: "2026-09-01", revenue_stream: "other", net_sales: -2.5, transactions: 1, units: -1, puppies_sold: 0 },
    ] }),
  });

  assert.deepEqual(result.rows, { created: 1, updated: 0, unchanged: 0 });
  assert.equal(result.refused_rows, 1);
  assert.equal(result.endpoint_results[0].rows_received, 2);
  assert.equal(result.endpoint_results[0].rows_refused, 1);
  assert.equal(persistence.rows.size, 1, "the valid row reached the persistence decision point");
});

test("known default schemas refuse only invalid rows and count each reason", async () => {
  const persistence = memoryPersistence();
  const bodies = {
    sales: { data: [
      { store: "Store A", period: "2026-09-01", revenue_stream: "services", transactions: 1, units: 1, puppies_sold: 0 },
      { store: "Store A", period: "2026-09-01", revenue_stream: "unconfigured", net_sales: 2, transactions: 1, units: 1, puppies_sold: 0 },
      { store: "Store A", period: "2026-09-01", revenue_stream: "other", net_sales: 2, transactions: 1, units: 1, puppies_sold: 0 },
    ] },
    inventory: { data: [
      { store: "Store A", breed: "Item 1", count: 1.5 },
      { store: "Store A", breed: " Item 1 ", count: 1 },
      { store: "Store A", breed: "Item 2", count: 2 },
    ] },
    costs: { data: [
      { store: "Store A", breed: "Item 1", received: 2 },
      { store: "Store A", breed: 7, avg_cost: 12.5, received: 2 },
      { store: "Store A", breed: "Item 2", avg_cost: 12.5, received: 2 },
    ] },
  };
  const result = await runCustomApiPull(realShapeConfig(), {
    token: TOKEN, now: () => AT, sleep: async () => {}, persistence,
    fetchImpl: async (input) => json(bodies[new URL(input).pathname.split("/").pop()]),
  });
  assert.equal(result.refused_rows, 6);
  assert.deepEqual(result.endpoint_results.map((endpoint) => endpoint.refusal_reasons), [
    { invalid_net_sales: 1, invalid_revenue_stream: 1 },
    { invalid_inventory_count: 1, invalid_breed: 1 },
    { invalid_avg_cost: 1, invalid_breed: 1 },
  ]);
  assert.equal(persistence.rows.size, 3, "all three valid neighbors reached persistence");
});

test("deletion-only snapshots keep row history and stage no replacement for disappeared document groups", async () => {
  let second = false;
  let fetches = 0;
  const persistence = memoryPersistence();
  const bodies = () => ({
    sales: { data: second ? [] : [{ store: "Store A", period: "2026-09-01", revenue_stream: "services", net_sales: 9, transactions: 1, units: 1, puppies_sold: 0 }] },
    inventory: { data: second ? [] : [{ store: "Store A", breed: "Item 1", count: 2 }] },
    costs: { data: second ? [] : [{ store: "Store A", breed: "Item 1", avg_cost: 12.5, received: 2 }] },
  });
  const options = {
    token: TOKEN, now: () => AT, sleep: async () => {}, persistence,
    fetchImpl: async (input) => {
      fetches++;
      return json(bodies()[new URL(input).pathname.split("/").pop()]);
    },
  };
  await runCustomApiPull(realShapeConfig(), options);
  second = true;
  const result = await runCustomApiPull(realShapeConfig(), options);
  assert.equal(result.retained_missing_rows, 3);
  assert.equal(result.documents, 0);
  assert.equal(fetches, 6, "all three deletion-only endpoints reached the document decision point");
  assert.deepEqual(persistence.writes.slice(-3), [
    { endpoint: "sales", documents: [] },
    { endpoint: "inventory", documents: [] },
    { endpoint: "costs", documents: [] },
  ]);
  assert.equal([...persistence.rows.values()].every((entry) => entry.present === false), true);
  assert.match(persistence.documents.get("sales:Store A:2026-09-01").content, /\$9\.00/);
  assert.match(persistence.documents.get("inventory:2026-09-24").content, /Item 1/);
  assert.match(persistence.documents.get("costs:2026-09-24").content, /\$12\.50/);
});

test("a 308 canonical-path redirect is a plain configuration error and is never followed", async () => {
  let calls = 0;
  await assert.rejects(
    runCustomApiPull(config(), {
      token: TOKEN,
      now: () => AT,
      sleep: async () => {},
      persistence: memoryPersistence(),
      fetchImpl: async () => {
        calls++;
        return json({ error: "canonical path has no trailing slash" }, 308, { location: "https://dashboard.invalid/api/sales" });
      },
    }),
    (error) => error instanceof CustomApiError &&
      error.code === "CONFIG_INVALID" &&
      /setup is not valid/i.test(customApiOwnerMessage(error.code, "dashboard")),
  );
  assert.equal(calls, 1, "the 308 decision point was reached without following it");
});

test("scripted paging handles labeled sales and builds one readable store-month document", async () => {
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
        ? json([{ store: "Store B", period: "2026-08-01", revenue_stream: "services", net_sales: 70, transactions: 2 }])
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
        : json([{ store: "Store A", period: "2026-08-01", revenue_stream: "services", net_sales: 1 }]);
    },
  });
  assert.equal(recovered.status, "completed");
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [250, 500]);
});
