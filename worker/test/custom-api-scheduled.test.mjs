import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { runCustomApiWorker } from "../src/lib/custom-api.js";
import { freshnessReport } from "../src/lib/store-d1.js";

const TOKEN = ["fixture", "scheduled", "sentinel", "42"].join("-");

function databaseBinding(database) {
  const wrap = (sql) => {
    let parameters = [];
    return {
      bind(...values) { parameters = values; return this; },
      async first() { return database.prepare(sql).get(...parameters) ?? null; },
      async all() { return { results: database.prepare(sql).all(...parameters) }; },
      async run() { return database.prepare(sql).run(...parameters); },
    };
  };
  return {
    prepare: wrap,
    async batch(statements) {
      return statements.map((statement) => statement.run());
    },
  };
}

function scheduledEnv() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE sources (
      name TEXT PRIMARY KEY, kind TEXT NOT NULL, zone TEXT, status TEXT NOT NULL,
      created_at TEXT NOT NULL, last_ingest_at TEXT, document_count INTEGER NOT NULL DEFAULT 0,
      last_complete_sweep_at TEXT, expected_refresh_seconds INTEGER, stale_reason TEXT
    );
    CREATE TABLE source_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_name TEXT NOT NULL, event TEXT NOT NULL,
      at TEXT NOT NULL, documents INTEGER, detail TEXT
    );
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT,
      meta TEXT, deleted_at TEXT
    );
    CREATE TABLE document_source_inventory (source TEXT PRIMARY KEY);
    CREATE TABLE sync_runs (
      run_id TEXT PRIMARY KEY, source TEXT, lane TEXT, started_at TEXT, finished_at TEXT,
      walk_complete INTEGER, files_seen INTEGER, docs_added INTEGER, docs_updated INTEGER,
      docs_unchanged INTEGER, docs_refused INTEGER, docs_failed INTEGER, metrics_version INTEGER,
      confirmed_from TEXT, confirmed_through TEXT, target_from TEXT, target_through TEXT,
      refusal_reason TEXT, error TEXT, failure_evidence TEXT
    );
  `);
  database.exec(readFileSync(new URL("../../migrations/d1/0048_custom_api_source.sql", import.meta.url), "utf8"));
  return {
    database,
    env: {
      STORAGE: "d1",
      DB: databaseBinding(database),
      CUSTOM_API_TOKEN_STORE_DASHBOARD: TOKEN,
      CUSTOM_API_CONFIG: JSON.stringify({
        enabled: true,
        display_name: "store dashboard",
        source: "store-dashboard",
        base_url: "https://dashboard.invalid/api/",
        token_secret: "CUSTOM_API_TOKEN_STORE_DASHBOARD",
        cadence_seconds: 86400,
        endpoints: [{
          name: "sales",
          path: "/sales",
          row_key: ["store", "period"],
          document: {
            group_by: ["store", "period"],
            title_template: "{{store}} {{period}} sales",
            body_template: "{{rows_table}}",
            fields: ["store", "period", "net_sales"],
          },
        }],
      }),
    },
  };
}

test("the every-minute Worker cron performs one due daily pull and skips early ticks", async (t) => {
  const { database, env } = scheduledEnv();
  t.after(() => database.close());
  let fetches = 0;
  const fetchImpl = async () => {
    fetches++;
    return new Response(JSON.stringify([{ store: "Store A", period: "2026-08-01", net_sales: 10 }]), {
      headers: { "content-type": "application/json" },
    });
  };
  const persistence = {
    async loadRows() { return []; },
    async persist() {},
  };
  const first = await runCustomApiWorker(env, {
    scheduled: true, now: () => new Date("2026-09-24T00:00:00.000Z"), fetchImpl, persistence,
  });
  const early = await runCustomApiWorker(env, {
    scheduled: true, now: () => new Date("2026-09-24T01:00:00.000Z"), fetchImpl, persistence,
  });
  const nextDay = await runCustomApiWorker(env, {
    scheduled: true, now: () => new Date("2026-09-25T00:00:00.000Z"), fetchImpl, persistence,
  });

  assert.equal(first.status, "completed");
  assert.equal(early.status, "not_due");
  assert.equal(nextDay.status, "completed");
  assert.equal(fetches, 2, "the due decision point fetched exactly twice across three cron ticks");
  assert.deepEqual(
    { ...database.prepare("SELECT status,expected_refresh_seconds FROM sources WHERE name='store-dashboard'").get() },
    { status: "ready", expected_refresh_seconds: 86400 },
  );
});

test("a source name already owned by another kind is refused before any fetch", async (t) => {
  const { database, env } = scheduledEnv();
  t.after(() => database.close());
  database.prepare(
    "INSERT INTO sources (name,kind,status,created_at) VALUES ('store-dashboard','upload','ready','2026-09-01T00:00:00.000Z')",
  ).run();
  let fetches = 0;
  let prepared = 0;
  const originalPrepare = env.DB.prepare;
  env.DB.prepare = (sql) => { prepared++; return originalPrepare(sql); };

  await assert.rejects(
    runCustomApiWorker(env, {
      scheduled: true,
      now: () => new Date("2026-09-24T00:00:00.000Z"),
      fetchImpl: async () => { fetches++; throw new Error("must not fetch"); },
      persistence: { async loadRows() { return []; }, async persist() {} },
    }),
    (error) => error?.code === "CONFIG_SOURCE_NAME_CLASH",
  );
  assert.ok(prepared >= 2, "the lease and source ownership decision points were reached");
  assert.equal(fetches, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM source_events").get().n, 0);
  assert.equal(database.prepare("SELECT lease_token FROM custom_api_schedule_state").get().lease_token, null);
});

test("a scheduled authorization failure keeps its closed detail in freshness", async (t) => {
  const { database, env } = scheduledEnv();
  t.after(() => database.close());
  let fetches = 0;
  await assert.rejects(
    runCustomApiWorker(env, {
      scheduled: true,
      now: () => new Date("2026-09-24T00:00:00.000Z"),
      fetchImpl: async () => {
        fetches++;
        return new Response(JSON.stringify({ error: "held" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      },
      persistence: { async loadRows() { return []; }, async persist() {} },
    }),
    (error) => error?.code === "AUTH_REQUIRED",
  );
  assert.equal(fetches, 1, "the scheduled pull reached provider authorization");
  const source = database.prepare(
    "SELECT status,stale_reason FROM sources WHERE name='store-dashboard'",
  ).get();
  assert.deepEqual({ ...source }, { status: "error", stale_reason: "AUTH_REQUIRED" });
  const freshness = await freshnessReport(env, { now: Date.parse("2026-09-24T00:00:00.000Z") });
  assert.equal(freshness.sources[0].state, "broken");
  assert.match(freshness.sources[0].reason, /store dashboard refused the key/i);
});

test("a configured custom API tick reserves the D1 budget by shrinking the vector drain", () => {
  const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  assert.match(
    source,
    /maxBatches:\s*env\.CUSTOM_API_CONFIG\s*\?\s*1\s*:\s*10/,
    "the scheduled decision point limits vector drain work on custom API ticks",
  );
});
test("source freshness shows setup failures even before the custom source can be registered", async (t) => {
  const { database, env } = scheduledEnv();
  t.after(() => database.close());
  const setting = env.CUSTOM_API_CONFIG;
  env.CUSTOM_API_CONFIG = "{";
  let freshness = await freshnessReport(env);
  assert.deepEqual(freshness.sources.map(({ kind, state, issue_code, reason }) => ({ kind, state, issue_code, reason })), [{
    kind: "custom_api", state: "broken", issue_code: "CONFIG_WORKER_SETTING_INVALID",
    reason: "The custom API Worker setting is invalid and needs to be redeployed.",
  }]);

  env.CUSTOM_API_CONFIG = setting;
  database.exec("INSERT INTO sources (name,kind,status,created_at) VALUES ('store-dashboard','upload','ready','2026-09-01')");
  freshness = await freshnessReport(env);
  const setup = freshness.sources.find((source) => source.kind === "custom_api");
  assert.equal(setup?.issue_code, "CONFIG_SOURCE_NAME_CLASH");
  assert.equal(setup.reason, "Another source type already uses the custom API source name.");
  assert.equal(freshness.sources.find((source) => source.kind === "upload").source_status, "ready");
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM sources").get().n, 1);
});

test("source freshness names a refused permanent redirect destination", async (t) => {
  const { database, env } = scheduledEnv();
  t.after(() => database.close());
  await assert.rejects(runCustomApiWorker(env, {
    fetchImpl: async () => new Response(null, {
      status: 308, headers: { Location: `https://redirect.invalid/private?key=${TOKEN}` },
    }),
  }), { code: "CONFIG_ENDPOINT_REDIRECT" });

  const { sources: [source] } = await freshnessReport(env);
  assert.equal(source.state, "broken");
  assert.equal(source.issue_code, "CONFIG_ENDPOINT_REDIRECT");
  assert.equal(source.reason, "The custom API moved to https://redirect.invalid/private. Review the new address before changing the setting.");
  assert.equal(JSON.stringify(database.prepare("SELECT detail FROM source_events").all()).includes(TOKEN), false);
});

test("an unverified source registration is visible and a verified retry clears it", async (t) => {
  const { database, env } = scheduledEnv();
  t.after(() => database.close());
  database.exec(`CREATE TRIGGER ignore_source_insert BEFORE INSERT ON sources
    BEGIN SELECT RAISE(IGNORE); END`);
  let fetches = 0;
  const options = {
    fetchImpl: async () => {
      fetches++;
      return Response.json([{ store: "Store A", period: "2026-08-01", net_sales: 10 }]);
    },
    persistence: { async loadRows() { return []; }, async persist() {} },
  };
  await assert.rejects(runCustomApiWorker(env, options), { code: "CONFIG_SOURCE_IDENTITY_UNVERIFIED" });
  assert.equal(fetches, 0);
  const { sources: [failed] } = await freshnessReport(env);
  assert.equal(failed.issue_code, "CONFIG_SOURCE_IDENTITY_UNVERIFIED");
  assert.equal(failed.reason, "The Brain could not verify that the custom API source was registered.");
  database.exec("DROP TRIGGER ignore_source_insert");
  assert.equal((await runCustomApiWorker(env, options)).status, "completed");
  assert.equal(fetches, 1);
  const { sources } = await freshnessReport(env);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].state, "ok");
  assert.equal(sources[0].issue_code, undefined);
});

test("the source checkup reports a followed move after a completed pull", async (t) => {
  const { database, env } = scheduledEnv();
  t.after(() => database.close());
  const result = await runCustomApiWorker(env, {
    now: () => new Date("2026-09-25T00:00:00.000Z"),
    fetchImpl: async (url) => new URL(url).pathname === "/api/sales"
      ? new Response(null, {status: 308, headers: {Location: "/v2/sales"}})
      : Response.json([{store: "Store A", period: "2026-08-01", net_sales: 10}]),
    persistence: { async loadRows() { return []; }, async persist() {} },
  });
  assert.equal(result.status, "completed");
  const { sources: [source] } = await freshnessReport(env, {now: Date.parse(result.fetched_at)});
  assert.equal(source.state, "ok");
  assert.match(source.reason, /sales moved from \/api\/sales to \/v2\/sales\. The Brain followed it/);
});
