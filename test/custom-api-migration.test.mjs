import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  CustomApiError,
  customApiD1Persistence,
  runCustomApiPull,
  runCustomApiWorker,
} from "../worker/src/lib/custom-api.js";

const sql = readFileSync(new URL("../migrations/d1/0048_custom_api_source.sql", import.meta.url), "utf8");
const TOKEN = ["fixture", "durable", "sentinel", "42"].join("-");
const AT = new Date("2026-09-24T15:30:00.000Z");

function countedD1(database, hardLimit = 1_000) {
  let statements = 0;
  let highWater = 0;
  const charge = (count = 1) => {
    statements += count;
    highWater = Math.max(highWater, statements);
    if (statements > hardLimit) throw new Error(`synthetic D1 statement limit ${hardLimit} exceeded`);
  };
  const prepare = (statement) => {
    let parameters = [];
    return {
      statement,
      get parameters() { return parameters; },
      bind(...values) { parameters = values; return this; },
      async first() { charge(); return database.prepare(statement).get(...parameters) ?? null; },
      async all() { charge(); return { results: database.prepare(statement).all(...parameters) }; },
      async run() { charge(); return database.prepare(statement).run(...parameters); },
    };
  };
  return {
    prepare,
    async batch(entries) {
      charge(entries.length);
      return entries.map((entry) => /^\s*SELECT\b/i.test(entry.statement)
        ? { results: database.prepare(entry.statement).all(...entry.parameters) }
        : database.prepare(entry.statement).run(...entry.parameters));
    },
    resetInvocation() { statements = 0; },
    get invocationStatements() { return statements; },
    get highWater() { return highWater; },
  };
}

function setupDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  database.exec(`
    CREATE TABLE documents (
      doc_uid TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL,
      meta TEXT, deleted_at TEXT, UNIQUE(source,source_id)
    );
    CREATE TABLE chunks (chunk_uid TEXT PRIMARY KEY, source TEXT NOT NULL);
    CREATE TABLE vector_outbox (chunk_uid TEXT PRIMARY KEY);
    CREATE TABLE sources (
      name TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, last_ingest_at TEXT, document_count INTEGER NOT NULL DEFAULT 0,
      expected_refresh_seconds INTEGER, stale_reason TEXT
    );
    CREATE TABLE source_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_name TEXT NOT NULL, event TEXT NOT NULL,
      at TEXT NOT NULL, documents INTEGER, detail TEXT
    );
  `);
  database.exec(sql);
  return database;
}

function compactConfig() {
  return {
    enabled: true,
    source: "store-dashboard",
    base_url: "https://dashboard.invalid/api/",
    token_secret: "STORE_DASHBOARD_TOKEN",
    endpoints: [{
      name: "sales",
      path: "/sales",
      row_key: ["store", "period", "revenue_stream"],
      document: {
        group_by: ["period"],
        title_template: "{{period}} sales",
        body_template: "{{rows_table}}",
        fields: ["store", "revenue_stream", "net_sales"],
      },
    }],
  };
}

function documentWriter(DB) {
  return async (envelope) => {
    await DB.prepare(
      `INSERT INTO documents (doc_uid,source,source_id,meta,deleted_at)
       VALUES (?1,?2,?3,?4,NULL)
       ON CONFLICT(source,source_id) DO UPDATE SET meta=excluded.meta,deleted_at=NULL`
    ).bind(`${envelope.source_type}:${envelope.source_id}`, envelope.source_type, envelope.source_id, JSON.stringify(envelope.metadata)).run();
    return { action: "updated" };
  };
}

async function settlePull(sourceConfig, options) {
  let result = await runCustomApiPull(sourceConfig, options);
  while (result.status !== "completed") result = await runCustomApiPull(sourceConfig, options);
  return result;
}

function config() {
  const document = (name, groupBy, title, fields, aggregates = {}, formats = {}) => ({
    ...(name ? { name } : {}), group_by: groupBy, title_template: title,
    body_template: "{{rows_table}}", fields, aggregates, formats,
  });
  return {
    enabled: true, source: "store-dashboard", base_url: "https://dashboard.invalid/api/",
    token_secret: "STORE_DASHBOARD_TOKEN", max_rows: 10_000,
    endpoints: [
      {
        name: "sales", path: "/sales", row_key: ["store", "period", "revenue_stream"],
        documents: [
          document("monthly", ["period"], "{{period}} sales", ["store", "revenue_stream", "net_sales"], { net_sales: "sum" }, { net_sales: "currency" }),
          document("store-history", ["store"], "{{store}} sales", ["period", "net_sales"], { net_sales: "sum" }, { net_sales: "currency" }),
        ],
      },
      { name: "inventory", path: "/inventory", row_key: ["store", "breed"], document: document(null, ["store"], "{{store}} inventory", ["breed", "count"]) },
      { name: "costs", path: "/costs", row_key: ["store", "breed"], document: document(null, ["store"], "{{store}} costs", ["breed", "avg_cost", "received"], {}, { avg_cost: "currency" }) },
    ],
  };
}

function bodies() {
  const periods = Array.from({ length: 81 }, (_, index) => `${2019 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`);
  return {
    sales: { data: Array.from({ length: 1_612 }, (_, index) => ({
      store: `Store ${index % 20}`, period: periods[index % periods.length],
      revenue_stream: `stream_${Math.floor(index / (20 * periods.length))}`,
      net_sales: index / 100, transactions: 1, units: 1, puppies_sold: 0,
    })) },
    inventory: { data: Array.from({ length: 407 }, (_, index) => ({ store: `Store ${index % 16}`, breed: `Item ${index}`, count: index % 10 })) },
    costs: { data: Array.from({ length: 1_721 }, (_, index) => ({ store: `Store ${index % 20}`, breed: `Item ${index}`, avg_cost: index / 100, received: index % 5 })) },
  };
}

test("0048 accepts its compact job schema without any schema-47 table", () => {
  const database = setupDatabase();
  try {
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'custom_api_%' ORDER BY name").all();
    assert.deepEqual(tables.map((row) => row.name), [
      "custom_api_current_jobs", "custom_api_fetches", "custom_api_job_slices", "custom_api_jobs",
      "custom_api_row_chunks", "custom_api_schedule_state",
    ]);
  } finally { database.close(); }
});

test("real volume stays under 600 statements per invocation and resumes after every slice readback", async (t) => {
  const database = setupDatabase();
  t.after(() => database.close());
  const DB = countedD1(database, 1_000);
  const workerEnv = {
    STORAGE: "d1",
    DB,
    STORE_DASHBOARD_TOKEN: TOKEN,
    CUSTOM_API_CONFIG: JSON.stringify(config()),
  };
  const interrupted = new Set();
  let terminalInterrupted = false;
  let monthlyDocument = null;
  let storeHistoryDocument = null;
  const persistence = customApiD1Persistence(workerEnv, {
    ingestDocument: async (envelope) => {
      if (envelope.metadata.custom_api_source_id === "sales:monthly:2019-01-01") monthlyDocument = envelope;
      if (envelope.metadata.custom_api_source_id === "sales:store-history:Store 0") storeHistoryDocument = envelope;
      await DB.prepare(
        `INSERT INTO documents (doc_uid,source,source_id,meta,deleted_at)
         VALUES (?1,?2,?3,?4,NULL)
         ON CONFLICT(source,source_id) DO UPDATE SET meta=excluded.meta,deleted_at=NULL`
      ).bind(`${envelope.source_type}:${envelope.source_id}`, envelope.source_type, envelope.source_id, JSON.stringify(envelope.metadata)).run();
      return { action: "updated" };
    },
    afterSliceReadback: ({ sliceIndex }) => {
      if (!interrupted.has(sliceIndex)) {
        interrupted.add(sliceIndex);
        throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", `fault after slice ${sliceIndex} readback`);
      }
    },
    afterTerminalReadback: () => {
      if (!terminalInterrupted) {
        terminalInterrupted = true;
        throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", "fault after terminal readback");
      }
    },
  });
  const feed = bodies();
  let providerCalls = 0;
  const options = {
    token: TOKEN, now: () => AT, sleep: async () => {}, persistence,
    fetchImpl: async (input) => {
      providerCalls++;
      return new Response(JSON.stringify(feed[new URL(input).pathname.split("/").pop()]), { headers: { "content-type": "application/json" } });
    },
  };

  const advance = () => runCustomApiWorker(workerEnv, options);
  let result = await advance();
  assert.equal(result.status, "in_progress");
  assert.ok(DB.invocationStatements <= 600, `staging used ${DB.invocationStatements} statements`);
  assert.equal(providerCalls, 3, "the complete snapshot was fetched and validated before slices advanced");
  let completedBeforeTerminal = false;
  while (result.status !== "completed") {
    DB.resetInvocation();
    try {
      result = await advance();
      if (result.status === "completed" && !terminalInterrupted) completedBeforeTerminal = true;
    } catch (error) {
      assert.match(String(error.message), /fault after (?:slice|terminal)/);
    }
    assert.ok(DB.invocationStatements <= 600, `resume used ${DB.invocationStatements} statements`);
  }
  assert.equal(completedBeforeTerminal, false, "no identical body completed before terminal verification");
  assert.equal(providerCalls, 3, "resumes used the staged snapshot instead of refetching it");
  assert.equal(result.saved, true);
  assert.equal(result.meaning_search_ready, true);
  assert.equal(result.documents, 137, "81 monthly, 20 store-history, 16 inventory, and 20 cost documents were verified");
  assert.ok(monthlyDocument, "the real answer document for one month reached the document writer");
  for (let store = 0; store < 20; store++) {
    assert.match(monthlyDocument.content, new RegExp(`Store ${store}(?:\\s|\\|)`), `monthly answer evidence includes store ${store}`);
  }
  assert.match(monthlyDocument.content, /Store 0 total/);
  assert.match(monthlyDocument.content, /Grand total/);
  assert.ok(storeHistoryDocument, "one per-store history reached the document writer");
  assert.match(storeHistoryDocument.content, /\| period \| net_sales \|/);
  assert.doesNotMatch(storeHistoryDocument.content, /revenue_stream/);
  assert.ok(interrupted.size > 100, "the test interrupted every real row and document slice");
  assert.ok(DB.highWater <= 600, `high-water was ${DB.highWater} statements`);

  DB.resetInvocation();
  const identical = await advance();
  assert.equal(identical.status, "completed");
  assert.equal(identical.job_phase, "verified");
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM custom_api_jobs WHERE status='verified'").get().n, 1);
});

test("row history reads only chunks from the latest verified job after chunk compaction", async (t) => {
  const database = setupDatabase();
  t.after(() => database.close());
  const DB = countedD1(database);
  const persistence = customApiD1Persistence({ STORAGE: "d1", DB }, {
    ingestDocument: async (envelope) => {
      await DB.prepare(
        `INSERT INTO documents (doc_uid,source,source_id,meta,deleted_at)
         VALUES (?1,?2,?3,?4,NULL)
         ON CONFLICT(source,source_id) DO UPDATE SET meta=excluded.meta,deleted_at=NULL`
      ).bind(`${envelope.source_type}:${envelope.source_id}`, envelope.source_type, envelope.source_id, JSON.stringify(envelope.metadata)).run();
      return { action: "updated" };
    },
  });
  const sourceConfig = compactConfig();
  let padding = "x".repeat(2_000);
  let currentAt = AT;
  const options = {
    token: TOKEN,
    now: () => currentAt,
    sleep: async () => {},
    persistence,
    fetchImpl: async () => new Response(JSON.stringify({ data: Array.from({ length: 60 }, (_, index) => ({
      store: `Store ${index}`,
      period: "2026-09-01",
      revenue_stream: "services",
      net_sales: index,
      padding,
    })) }), { headers: { "content-type": "application/json" } }),
  };
  const settle = async () => {
    let result = await runCustomApiPull(sourceConfig, options);
    while (result.status !== "completed") result = await runCustomApiPull(sourceConfig, options);
    return result;
  };

  const first = await settle();
  assert.ok(database.prepare("SELECT COUNT(*) AS n FROM custom_api_row_chunks WHERE job_id=?1").get(first.job_id).n > 1);
  padding = "x";
  currentAt = new Date("2026-09-25T15:30:00.000Z");
  const second = await settle();
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM custom_api_row_chunks WHERE job_id=?1").get(second.job_id).n, 2);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM custom_api_row_chunks WHERE job_id<>?1").get(second.job_id).n, 0);
  const rows = await persistence.loadRows({ source: "store-dashboard", endpoint: "sales" });
  assert.equal(rows.length, 60, "stale physical chunks cannot re-enter the logical current history");
  assert.ok(rows.every((row) => row.row.padding === "x"));
  assert.ok(rows.every((row) => row.first_seen_at === AT.toISOString()));
  assert.ok(rows.every((row) => row.history_hashes.length === 1));
});

test("current rows and documents stay on the prior job through every slice and switch together at promotion", async (t) => {
  const database = setupDatabase();
  t.after(() => database.close());
  const DB = countedD1(database);
  const sourceConfig = compactConfig();
  const rows = (marker) => Array.from({ length: 60 }, (_, index) => ({
    store: `Store ${index}`,
    period: "2026-09-01",
    revenue_stream: "services",
    net_sales: marker,
    padding: "x".repeat(2_000),
  }));
  let feed = { data: rows(1) };
  let currentAt = AT;
  const fetchImpl = async () => new Response(JSON.stringify(feed), { headers: { "content-type": "application/json" } });
  const firstPersistence = customApiD1Persistence({ STORAGE: "d1", DB }, { ingestDocument: documentWriter(DB) });
  const first = await settlePull(sourceConfig, {
    token: TOKEN, now: () => currentAt, sleep: async () => {}, persistence: firstPersistence, fetchImpl,
  });

  feed = { data: rows(2) };
  currentAt = new Date("2026-09-25T15:30:00.000Z");
  let sliceChecks = 0;
  let stagedPlanChecks = 0;
  let terminalChecks = 0;
  let promotionChecks = 0;
  let documentWrites = 0;
  const faultedSlices = new Set();
  let stagedPlanFaulted = false;
  let terminalFaulted = false;
  let promotionFaulted = false;
  const priorVisible = async () => {
    const visibleRows = await secondPersistence.loadRows({ source: "store-dashboard", endpoint: "sales" });
    assert.equal(visibleRows.length, 60);
    assert.ok(visibleRows.every((row) => row.row.net_sales === 1));
    const document = database.prepare(
      `SELECT d.meta FROM documents d
        JOIN custom_api_current_jobs c
          ON c.source=d.source AND c.job_id=json_extract(d.meta,'$.custom_api_job_id')
       WHERE d.source='store-dashboard'
         AND json_extract(d.meta,'$.custom_api_source_id')='sales:2026-09-01'
       LIMIT 1`
    ).get();
    assert.ok(document, "the prior verified document remains visible before promotion");
    assert.equal(JSON.parse(document.meta).custom_api_job_id, first.job_id);
  };
  const secondPersistence = customApiD1Persistence({ STORAGE: "d1", DB }, {
    ingestDocument: async (envelope) => { documentWrites++; return documentWriter(DB)(envelope); },
    afterSliceReadback: async ({ kind, sliceIndex }) => {
      sliceChecks++;
      if (kind === "rows") assert.equal(documentWrites, 0, "live document ingest waits for staged-plan verification");
      await priorVisible();
      if (!faultedSlices.has(sliceIndex)) {
        faultedSlices.add(sliceIndex);
        throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", `synthetic fault after ${kind} slice`);
      }
    },
    afterStagedPlanReadback: async () => {
      stagedPlanChecks++;
      await priorVisible();
      if (!stagedPlanFaulted) {
        stagedPlanFaulted = true;
        throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", "synthetic fault after staged-plan readback");
      }
    },
    afterTerminalReadback: async () => {
      terminalChecks++;
      await priorVisible();
      if (!terminalFaulted) {
        terminalFaulted = true;
        throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", "synthetic fault before pointer flip");
      }
    },
    afterPromotionReadback: async ({ jobId }) => {
      promotionChecks++;
      const visibleRows = await secondPersistence.loadRows({ source: "store-dashboard", endpoint: "sales" });
      assert.equal(visibleRows.length, 60);
      assert.ok(visibleRows.every((row) => row.row.net_sales === 2));
      const current = database.prepare("SELECT job_id FROM custom_api_current_jobs WHERE source='store-dashboard'").get();
      assert.equal(current?.job_id, jobId);
      const document = database.prepare(
        `SELECT d.meta FROM documents d
          JOIN custom_api_current_jobs c
            ON c.source=d.source AND c.job_id=json_extract(d.meta,'$.custom_api_job_id')
         WHERE d.source='store-dashboard'
           AND json_extract(d.meta,'$.custom_api_source_id')='sales:2026-09-01'
         LIMIT 1`
      ).get();
      assert.equal(JSON.parse(document.meta).custom_api_job_id, jobId);
      if (!promotionFaulted) {
        promotionFaulted = true;
        throw new CustomApiError("PERSISTENCE_VERIFY_FAILED", "synthetic fault after pointer flip");
      }
    },
  });
  const secondOptions = {
    token: TOKEN, now: () => currentAt, sleep: async () => {}, persistence: secondPersistence, fetchImpl,
  };
  let second;
  while (!second || second.status !== "completed") {
    try {
      second = await runCustomApiPull(sourceConfig, secondOptions);
    } catch (error) {
      assert.match(String(error.message), /synthetic fault/);
    }
  }
  assert.notEqual(second.job_id, first.job_id);
  assert.ok(sliceChecks >= 3, "every row and document slice reached the visibility decision point");
  assert.equal(stagedPlanChecks, 2, "the complete staged plan survived an interrupted verification");
  assert.equal(terminalChecks, 2, "terminal pre-promotion visibility survived an interruption");
  assert.equal(promotionChecks, 1, "post-promotion completeness was checked");
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM custom_api_row_chunks WHERE job_id<>?1").get(second.job_id).n, 0);
});

for (const [label, body] of [
  ["empty first pull", { data: [] }],
  ["all-refused first pull", { data: [{ store: "Store 1", period: "2026-09-01" }] }],
]) {
  test(`${label} promotes atomically and repeated resumes stay idempotent`, async (t) => {
    const database = setupDatabase();
    t.after(() => database.close());
    const DB = countedD1(database);
    let terminalChecks = 0;
    let promotionChecks = 0;
    const persistence = customApiD1Persistence({ STORAGE: "d1", DB }, {
      ingestDocument: documentWriter(DB),
      afterTerminalReadback: () => { terminalChecks++; },
      afterPromotionReadback: () => { promotionChecks++; },
    });
    const options = {
      token: TOKEN,
      now: () => AT,
      sleep: async () => {},
      persistence,
      fetchImpl: async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
    };
    const staged = await runCustomApiPull(compactConfig(), options);
    assert.equal(staged.status, "in_progress");
    assert.equal(staged.slices_total, 0);
    const completed = await runCustomApiPull(compactConfig(), options);
    assert.equal(completed.status, "completed");
    assert.equal(completed.saved, true);
    const repeated = await runCustomApiPull(compactConfig(), options);
    assert.equal(repeated.status, "completed");
    assert.equal(repeated.job_id, completed.job_id);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM custom_api_fetches").get().n, 1);
    assert.equal(database.prepare("SELECT job_id FROM custom_api_current_jobs WHERE source='store-dashboard'").get().job_id, completed.job_id);
    assert.ok(terminalChecks >= 1, "the zero-slice terminal decision point was reached");
    assert.ok(promotionChecks >= 1, "the zero-slice promotion decision point was reached");
  });
}
