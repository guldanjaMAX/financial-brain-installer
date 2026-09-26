import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  CustomApiError,
  customApiOwnerMessage,
  runCustomApiPull,
  validateCustomApiConfig,
} from "../src/lib/custom-api.js";

const TOKEN = ["fixture", "bearer", "sentinel", "42"].join("-");
const AT = new Date("2026-09-24T15:30:00.000Z");

const configuration = (baseUrl) => ({
  enabled: true,
  source: "store-dashboard",
  base_url: baseUrl,
  token_secret: "CUSTOM_API_TOKEN_STORE_DASHBOARD",
  cadence_seconds: 86400,
  endpoints: [
    {
      name: "sales",
      path: "/sales",
      row_key: ["store", "period", "revenue_stream"],
      document: {
        group_by: ["store", "period"],
        title_template: "{{store}}, {{period}} sales",
        body_template: "{{store}}, {{period}}: net sales {{sum.net_sales}} across {{row_count}} streams. {{missing.revenue_stream}}\n\n{{rows_table}}",
        aggregates: { net_sales: "sum", transactions: "sum", units: "sum", puppies_sold: "sum" },
        formats: { net_sales: "currency", avg_cost: "currency" },
        fields: ["store", "period", "revenue_stream", "net_sales", "transactions", "units", "puppies_sold"],
        expected_values: { revenue_stream: ["live_animal", "supplies", "services", "other"] },
      },
    },
    {
      name: "inventory",
      path: "/inventory",
      row_key: ["store", "breed"],
      document: {
        group_by: [],
        title_template: "Inventory snapshot {{fetched_date}}",
        body_template: "Inventory snapshot for {{fetched_date}}.\n\n{{rows_table}}",
        fields: ["store", "breed", "count"],
      },
    },
    {
      name: "costs",
      path: "/costs",
      row_key: ["store", "breed"],
      document: {
        group_by: [],
        title_template: "Cost table {{fetched_date}}",
        body_template: "Average costs received through {{fetched_date}}.\n\n{{rows_table}}",
        formats: { avg_cost: "currency" },
        fields: ["store", "breed", "avg_cost", "received"],
      },
    },
  ],
});

async function mockServer(handler) {
  const calls = [];
  const server = createServer(async (request, response) => {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    calls.push({
      method: request.method,
      url: request.url,
      authorizationOkay: request.headers.authorization === `Bearer ${TOKEN}`,
      body: Buffer.concat(body),
    });
    await handler(request, response, calls.length);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const localBase = `http://127.0.0.1:${address.port}`;
  const publicBase = "https://dashboard.invalid/api/";
  const fetchImpl = (input, init) => {
    const requested = new URL(String(input));
    return fetch(`${localBase}${requested.pathname}${requested.search}`, {
      ...init,
      redirect: "manual",
    });
  };
  return {
    publicBase,
    fetchImpl,
    calls,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function json(response, value, status = 200, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(body);
}

function memoryPersistence() {
  const rows = new Map();
  const documents = new Map();
  const revisions = [];
  const receipts = [];
  return {
    rows,
    documents,
    revisions,
    receipts,
    async loadRows({ source, endpoint }) {
      const prefix = `${source}\u0000${endpoint}\u0000`;
      return [...rows.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ row_key: key.slice(prefix.length), ...value }));
    },
    async persist({ source, endpoint, rowChanges, documentChanges, fetchedAt, responseHash }) {
      for (const change of rowChanges) {
        const key = `${source}\u0000${endpoint}\u0000${change.row_key}`;
        const prior = rows.get(key);
        const revision = (prior?.revision || 0) + (change.action === "unchanged" ? 0 : 1);
        rows.set(key, {
          row_hash: change.row_hash, row: change.row, revision,
          present: !["missing", "unchanged_missing"].includes(change.action),
        });
        if (change.action === "updated") revisions.push({ endpoint, row_key: change.row_key, revision });
      }
      for (const document of documentChanges) documents.set(document.source_id, document);
      receipts.push({ endpoint, fetchedAt, responseHash });
    },
  };
}

test("config is declarative, HTTPS-only, and names rather than contains its secret", () => {
  const parsed = validateCustomApiConfig(configuration("https://dashboard.invalid/api/"));
  assert.equal(parsed.token_secret, "CUSTOM_API_TOKEN_STORE_DASHBOARD");
  assert.equal(JSON.stringify(parsed).includes(TOKEN), false);
  assert.throws(
    () => validateCustomApiConfig(configuration("http://dashboard.invalid/api/")),
    /HTTPS/i,
  );
  assert.throws(
    () => validateCustomApiConfig({ ...configuration("https://dashboard.invalid/api/"), token_secret: "ADMIN_KEY" }),
    /CUSTOM_API_TOKEN_/i,
  );
});

test("every non-custom secret family is refused before a provider request", async () => {
  const firstPartySecrets = [
    "ADMIN_KEY",
    "SESSION_SIGNING_KEY",
    "RAG_PROXY_KEY",
    "ANTHROPIC_API_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "PLAID_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "ZOOM_CLIENT_SECRET",
    "RESEND_API_KEY",
    "CLOUDFLARE_API_TOKEN",
    "CUSTOM_API_CONFIG",
    "OTHER_VENDOR_TOKEN",
  ];
  let refusalDecisions = 0;
  let providerRequests = 0;
  for (const tokenSecret of firstPartySecrets) {
    await assert.rejects(
      runCustomApiPull({
        ...configuration("https://dashboard.invalid/api/"),
        token_secret: tokenSecret,
      }, {
        token: TOKEN,
        fetchImpl: async () => {
          providerRequests++;
          throw new Error("provider fetch must not run");
        },
        persistence: memoryPersistence(),
      }),
      (error) => {
        refusalDecisions++;
        return error instanceof TypeError && /CUSTOM_API_TOKEN_/i.test(error.message);
      },
      tokenSecret,
    );
  }
  assert.equal(refusalDecisions, firstPartySecrets.length, "every secret family reached the namespace refusal");
  assert.equal(providerRequests, 0, "no refused binding reached the provider");
});

test("the mock serves the real data envelopes and numeric, missing-stream, null-store, and extra-field quirks", async (t) => {
  const mock = await mockServer((request, response) => {
    const url = new URL(request.url, "http://mock.invalid");
    if (url.pathname === "/api/sales") {
      return json(response, {
        data: [
          { store: "Store A", period: "2026-09-01", revenue_stream: "live_animal", net_sales: 100, transactions: 1, units: 1, puppies_sold: 1, extra_metric: 99 },
          { store: "Store A", period: "2026-09-01", revenue_stream: "supplies", net_sales: -1.25, transactions: 2, units: -1 },
        ],
      });
    }
    if (url.pathname === "/api/inventory") {
      return json(response, { data: [{ store: null, breed: "Item 1", count: 2 }] });
    }
    if (url.pathname === "/api/costs") {
      return json(response, { data: [{ store: null, breed: "Item 1", avg_cost: 50, received: 2 }] });
    }
    return json(response, { error: "not found" }, 404);
  });
  t.after(mock.close);
  const persistence = memoryPersistence();
  const result = await runCustomApiPull(configuration(mock.publicBase), {
    token: TOKEN,
    fetchImpl: mock.fetchImpl,
    now: () => AT,
    sleep: async () => {},
    persistence,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.endpoints, 3);
  assert.equal(result.rows.created, 4);
  assert.equal(mock.calls.length, 3);
  assert.ok(mock.calls.every((call) => call.authorizationOkay));
  assert.match(persistence.documents.get("sales:Store A:2026-09-01").content, /\$98\.75 across 2 streams/);
  assert.match(persistence.documents.get("sales:Store A:2026-09-01").content, /no services sales recorded/i);
  assert.doesNotMatch(persistence.documents.get("sales:Store A:2026-09-01").content, /extra_metric/);
  assert.match(persistence.documents.get("inventory:2026-09-24").content, /unassigned/);
  assert.ok(persistence.documents.has("inventory:2026-09-24"));
  assert.ok(persistence.documents.has("costs:2026-09-24"));
  for (const document of persistence.documents.values()) {
    assert.equal(document.metadata.endpoint.startsWith("/"), true);
    assert.equal(document.metadata.fetched_at, AT.toISOString());
    assert.match(document.metadata.response_hash, /^[a-f0-9]{64}$/);
  }
});

test("unchanged rows skip, corrections revise, and a new store is added without deletion", async (t) => {
  let version = 1;
  const mock = await mockServer((request, response) => {
    if (!request.url.startsWith("/api/sales")) return json(response, []);
    const rows = [
      { store: "Store A", period: "2026-08-01", revenue_stream: "services", net_sales: version === 1 ? 10 : 12, transactions: 1, units: 1 },
    ];
    if (version === 2) rows.push({ store: "Store C", period: "2026-08-01", revenue_stream: "other", net_sales: 7, transactions: 1, units: 1 });
    return json(response, rows);
  });
  t.after(mock.close);
  const persistence = memoryPersistence();
  const config = { ...configuration(mock.publicBase), endpoints: [configuration(mock.publicBase).endpoints[0]] };
  const first = await runCustomApiPull(config, { token: TOKEN, fetchImpl: mock.fetchImpl, now: () => AT, sleep: async () => {}, persistence });
  const second = await runCustomApiPull(config, { token: TOKEN, fetchImpl: mock.fetchImpl, now: () => AT, sleep: async () => {}, persistence });
  version = 2;
  const third = await runCustomApiPull(config, { token: TOKEN, fetchImpl: mock.fetchImpl, now: () => AT, sleep: async () => {}, persistence });

  assert.deepEqual(first.rows, { created: 1, updated: 0, unchanged: 0 });
  assert.deepEqual(second.rows, { created: 0, updated: 0, unchanged: 1 });
  assert.deepEqual(third.rows, { created: 1, updated: 1, unchanged: 0 });
  assert.equal(persistence.revisions.length, 1);
  assert.equal(persistence.rows.size, 2);
  assert.match(persistence.documents.get("sales:Store A:2026-08-01").content, /\$12\.00/);
  assert.ok(persistence.documents.has("sales:Store C:2026-08-01"));
});

test("dry run reaches the source and plans work without any persistence", async (t) => {
  const mock = await mockServer((request, response) => json(response, request.url.includes("sales")
    ? [{ store: "Store A", period: "2026-08-01", net_sales: 8, transactions: 1 }]
    : []));
  t.after(mock.close);
  const persistence = memoryPersistence();
  const result = await runCustomApiPull(configuration(mock.publicBase), {
    token: TOKEN, fetchImpl: mock.fetchImpl, now: () => AT, sleep: async () => {}, persistence, dryRun: true,
  });
  assert.equal(result.dry_run, true);
  assert.ok(mock.calls.length > 0, "the decision point was reached");
  assert.equal(persistence.receipts.length, 0);
  assert.equal(persistence.rows.size, 0);
});

test("401, exhausted 500, malformed, oversized, and cross-host redirect failures are sanitized", async (t) => {
  const scenarios = [
    ["unauthorized", 401, { provider_detail: TOKEN }, "AUTH_REQUIRED"],
    ["server-error", 500, { provider_detail: TOKEN }, "REMOTE_UNAVAILABLE"],
    ["malformed", 200, "not-json", "INVALID_RESPONSE"],
    ["oversized", 200, "x".repeat(2048), "RESPONSE_TOO_LARGE"],
    ["redirect", 302, "", "REDIRECT_REFUSED"],
    ["trailing-slash", 308, { error: "unknown endpoint" }, "CONFIG_INVALID"],
  ];
  let scenario = scenarios[0];
  const mock = await mockServer((_request, response) => {
    const [name, status, body] = scenario;
    if (name === "redirect" || name === "trailing-slash") {
      response.writeHead(status, {
        "content-type": "application/json",
        location: name === "redirect" ? "https://other.invalid/private" : "/api/sales",
      });
      return response.end();
    }
    if (name === "oversized") {
      response.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
      return response.end(body);
    }
    if (name === "malformed") {
      response.writeHead(status, { "content-type": "application/json" });
      return response.end(body);
    }
    return json(response, body, status);
  });
  t.after(mock.close);
  for (const current of scenarios) {
    scenario = current;
    const before = mock.calls.length;
    const config = { ...configuration(mock.publicBase), max_response_bytes: 1024, endpoints: [configuration(mock.publicBase).endpoints[0]] };
    let caught;
    try {
      await runCustomApiPull(config, {
        token: TOKEN, fetchImpl: mock.fetchImpl, now: () => AT, sleep: async () => {}, persistence: memoryPersistence(),
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof CustomApiError, current[0]);
    assert.equal(caught.code, current[3], current[0]);
    assert.equal(JSON.stringify(caught).includes(TOKEN), false, current[0]);
    assert.equal(String(caught.message).includes(TOKEN), false, current[0]);
    assert.equal(String(customApiOwnerMessage(caught.code)).includes(TOKEN), false, current[0]);
    assert.ok(mock.calls.length > before, `${current[0]} reached the request decision point`);
  }
});

test("429 retries with backoff and never exposes the bearer sentinel", async (t) => {
  let attempts = 0;
  const mock = await mockServer((request, response) => {
    if (!request.url.includes("sales")) return json(response, []);
    attempts++;
    if (attempts < 3) return json(response, { provider_detail: TOKEN }, 429);
    return json(response, [{ store: "Store A", period: "2026-08-01", revenue_stream: "supplies", net_sales: 1, transactions: 1 }]);
  });
  t.after(mock.close);
  const messages = [];
  const config = { ...configuration(mock.publicBase), endpoints: [configuration(mock.publicBase).endpoints[0]] };
  const result = await runCustomApiPull(config, {
    token: TOKEN,
    fetchImpl: mock.fetchImpl,
    now: () => AT,
    sleep: async (milliseconds) => messages.push(`wait:${milliseconds}`),
    persistence: memoryPersistence(),
    logger: { info: (message) => messages.push(message), warn: (message) => messages.push(message) },
  });
  assert.equal(result.status, "completed");
  assert.equal(attempts, 3);
  assert.deepEqual(messages.filter((message) => message.startsWith("wait:")), ["wait:250", "wait:500"]);
  assert.equal(messages.join("\n").includes(TOKEN), false);
});

test("unexpected envelope keys, duplicate row identities, and token reflection fail closed", async (t) => {
  let body = { error: "provider-shaped success" };
  const mock = await mockServer((_request, response) => json(response, body));
  t.after(mock.close);
  const config = { ...configuration(mock.publicBase), endpoints: [configuration(mock.publicBase).endpoints[0]] };
  for (const [value, code] of [
    [{ data: [], unexpected: true }, "INVALID_RESPONSE"],
    [[
      { store: "Store A", period: "2026-08-01", revenue_stream: "supplies", net_sales: 1 },
      { store: "Store A", period: "2026-08-01", revenue_stream: "supplies", net_sales: 2 },
    ], "DUPLICATE_ROW_KEY"],
    [[{ store: "Store A", period: "2026-08-01", revenue_stream: "supplies", net_sales: 1, note: TOKEN }], "SECRET_IN_RESPONSE"],
  ]) {
    body = value;
    const before = mock.calls.length;
    await assert.rejects(
      runCustomApiPull(config, { token: TOKEN, fetchImpl: mock.fetchImpl, now: () => AT, sleep: async () => {}, persistence: memoryPersistence() }),
      (error) => error instanceof CustomApiError && error.code === code && !String(error.message).includes(TOKEN),
    );
    assert.ok(mock.calls.length > before, `${code} reached the request decision point`);
  }
});
