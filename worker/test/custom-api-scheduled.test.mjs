import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { runCustomApiWorker } from "../src/lib/custom-api.js";

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
      name TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, last_ingest_at TEXT, document_count INTEGER NOT NULL DEFAULT 0,
      expected_refresh_seconds INTEGER, stale_reason TEXT
    );
    CREATE TABLE source_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_name TEXT NOT NULL, event TEXT NOT NULL,
      at TEXT NOT NULL, documents INTEGER, detail TEXT
    );
    CREATE TABLE documents (id TEXT PRIMARY KEY, source TEXT NOT NULL, deleted_at TEXT);
  `);
  database.exec(readFileSync(new URL("../../migrations/d1/0047_custom_api_source.sql", import.meta.url), "utf8"));
  return {
    database,
    env: {
      STORAGE: "d1",
      DB: databaseBinding(database),
      STORE_DASHBOARD_TOKEN: TOKEN,
      CUSTOM_API_CONFIG: JSON.stringify({
        enabled: true,
        display_name: "store dashboard",
        source: "store-dashboard",
        base_url: "https://dashboard.invalid/api/",
        token_secret: "STORE_DASHBOARD_TOKEN",
        cadence_seconds: 86400,
        endpoints: [{
          name: "sales",
          path: "/sales",
          row_key: ["store", "period"],
          document: {
            group_by: ["store", "period"],
            title_template: "{{store}} {{period}} sales",
            body_template: "{{rows_table}}",
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
    (error) => error?.code === "CONFIG_INVALID",
  );
  assert.ok(prepared >= 2, "the lease and source ownership decision points were reached");
  assert.equal(fetches, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM source_events").get().n, 0);
});
