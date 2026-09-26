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
import { currentCustomApiDocumentSql } from "../worker/src/lib/custom-api-visibility.js";
import {
  coverageGaps,
  forget,
  freshnessReport,
  RETRIEVAL_CANDIDATE_DEPTH,
  searchVector,
} from "../worker/src/lib/store-d1.js";

const sql = readFileSync(new URL("../migrations/d1/0048_custom_api_source.sql", import.meta.url), "utf8");
const TOKEN = ["fixture", "durable", "sentinel", "42"].join("-");
const AT = new Date("2026-09-24T15:30:00.000Z");

async function hashText(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

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
      content TEXT, title TEXT, uri TEXT, document_date INTEGER, date_source TEXT,
      date_reliable INTEGER, entity_slug TEXT, client TEXT, category TEXT,
      top_folder TEXT, platform TEXT, text_source TEXT, text_reliable INTEGER,
      content_hash TEXT, ingested_at INTEGER, meta TEXT, deleted_at TEXT,
      UNIQUE(source,source_id)
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, chunk_uid TEXT NOT NULL UNIQUE,
      doc_uid TEXT NOT NULL, chunk_ix INTEGER NOT NULL DEFAULT 0, text TEXT, source TEXT NOT NULL, title TEXT,
      document_date INTEGER, client TEXT, category TEXT, top_folder TEXT,
      platform TEXT, vector_id TEXT
    );
    CREATE TABLE vector_outbox (
      chunk_uid TEXT PRIMARY KEY, vector_id TEXT, op TEXT, queued_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT
    );
    CREATE TABLE corpus_stats (
      source TEXT PRIMARY KEY, documents INTEGER NOT NULL DEFAULT 0,
      chunks INTEGER NOT NULL DEFAULT 0, last_ingest_at INTEGER
    );
    CREATE TABLE memory_supersessions (
      predecessor_doc_uid TEXT, predecessor_content_hash TEXT,
      successor_doc_uid TEXT, successor_content_hash TEXT, channel TEXT
    );
    CREATE TABLE install_state (id INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL);
    INSERT INTO install_state (id,schema_version) VALUES (1,48);
    CREATE TABLE sources (
      name TEXT PRIMARY KEY, kind TEXT NOT NULL, zone TEXT, status TEXT NOT NULL,
      created_at TEXT NOT NULL, last_ingest_at TEXT, document_count INTEGER NOT NULL DEFAULT 0,
      last_complete_sweep_at TEXT, expected_refresh_seconds INTEGER, stale_reason TEXT
    );
    CREATE TABLE source_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_name TEXT NOT NULL, event TEXT NOT NULL,
      at TEXT NOT NULL, documents INTEGER, detail TEXT
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
  database.exec(sql);
  return database;
}

function compactConfig() {
  return {
    enabled: true,
    source: "store-dashboard",
    base_url: "https://dashboard.invalid/api/",
    token_secret: "CUSTOM_API_TOKEN_STORE_DASHBOARD",
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
      `INSERT INTO documents (doc_uid,source,source_id,content,meta,deleted_at)
       VALUES (?1,?2,?3,?4,?5,NULL)
       ON CONFLICT(source,source_id) DO UPDATE SET content=excluded.content,meta=excluded.meta,deleted_at=NULL`
    ).bind(
      `${envelope.source_type}:${envelope.source_id}`,
      envelope.source_type,
      envelope.source_id,
      envelope.content,
      JSON.stringify(envelope.metadata),
    ).run();
    return { action: "updated" };
  };
}

async function settlePull(sourceConfig, options) {
  let result = await runCustomApiPull(sourceConfig, options);
  while (result.status !== "completed") result = await runCustomApiPull(sourceConfig, options);
  return result;
}

async function settleWorker(env, options) {
  let result = await runCustomApiWorker(env, options);
  while (result.status === "in_progress") result = await runCustomApiWorker(env, options);
  return result;
}

function config() {
  const document = (name, groupBy, title, fields, aggregates = {}, formats = {}) => ({
    ...(name ? { name } : {}), group_by: groupBy, title_template: title,
    body_template: "{{rows_table}}", fields, aggregates, formats,
  });
  return {
    enabled: true, source: "store-dashboard", base_url: "https://dashboard.invalid/api/",
    token_secret: "CUSTOM_API_TOKEN_STORE_DASHBOARD", max_rows: 10_000,
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
      "custom_api_current_jobs", "custom_api_document_versions", "custom_api_fetches",
      "custom_api_job_slices", "custom_api_jobs", "custom_api_row_chunks", "custom_api_schedule_state",
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
    CUSTOM_API_TOKEN_STORE_DASHBOARD: TOKEN,
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

test("promotion keeps unchanged logical documents, replaces one changed group, and omits a disappeared group", async (t) => {
  const database = setupDatabase();
  t.after(() => database.close());
  const DB = countedD1(database);
  const document = (groupBy, title, fields) => ({
    group_by: groupBy,
    title_template: title,
    body_template: "{{rows_table}}",
    fields,
  });
  const sourceConfig = {
    enabled: true,
    source: "store-dashboard",
    base_url: "https://dashboard.invalid/api/",
    token_secret: "CUSTOM_API_TOKEN_STORE_DASHBOARD",
    endpoints: [
      {
        name: "sales",
        path: "/sales",
        row_key: ["store", "period"],
        document: document(["period"], "{{period}} sales", ["store", "net_sales"]),
      },
      {
        name: "inventory",
        path: "/inventory",
        row_key: ["store", "item"],
        document: document(["store"], "{{store}} inventory", ["item", "count"]),
      },
    ],
  };
  let feeds = {
    sales: { data: [
      { store: "Store 1", period: "2026-08-01", net_sales: 10 },
      { store: "Store 1", period: "2026-09-01", net_sales: 20 },
    ] },
    inventory: { data: [
      { store: "Store 1", item: "Item 1", count: 2 },
      { store: "Store 2", item: "Item 2", count: 3 },
    ] },
  };
  let currentAt = AT;
  const persistence = customApiD1Persistence({ STORAGE: "d1", DB }, {
    ingestDocument: documentWriter(DB),
  });
  const options = {
    token: TOKEN,
    now: () => currentAt,
    sleep: async () => {},
    persistence,
    fetchImpl: async (input) => new Response(
      JSON.stringify(feeds[new URL(input).pathname.split("/").pop()]),
      { headers: { "content-type": "application/json" } },
    ),
  };
  const first = await settlePull(sourceConfig, options);
  feeds = {
    sales: { data: [
      { store: "Store 1", period: "2026-08-01", net_sales: 11 },
      { store: "Store 1", period: "2026-09-01", net_sales: 20 },
    ] },
    inventory: { data: [
      { store: "Store 1", item: "Item 1", count: 2 },
    ] },
  };
  currentAt = new Date("2026-09-25T15:30:00.000Z");
  let promotionChecks = 0;
  const secondPersistence = customApiD1Persistence({ STORAGE: "d1", DB }, {
    ingestDocument: documentWriter(DB),
    afterPromotionReadback: ({ jobId }) => {
      promotionChecks++;
      assert.equal(jobId === first.job_id, false);
    },
  });
  const second = await settlePull(sourceConfig, { ...options, persistence: secondPersistence });

  const versionMap = database.prepare(
    `SELECT logical_source_id,document_source_id
       FROM custom_api_document_versions WHERE job_id=?1 ORDER BY logical_source_id`
  ).all(second.job_id).map((row) => ({ ...row }));
  assert.deepEqual(versionMap, [
    {
      logical_source_id: "inventory:Store 1",
      document_source_id: `inventory:Store 1:job:${first.job_id}`,
    },
    {
      logical_source_id: "sales:2026-08-01",
      document_source_id: `sales:2026-08-01:job:${second.job_id}`,
    },
    {
      logical_source_id: "sales:2026-09-01",
      document_source_id: `sales:2026-09-01:job:${first.job_id}`,
    },
  ]);
  const visible = database.prepare(
    `SELECT d.source_id,d.content,d.meta FROM documents d
      WHERE d.source='store-dashboard' AND d.deleted_at IS NULL${currentCustomApiDocumentSql("d")}
      ORDER BY json_extract(d.meta,'$.custom_api_source_id')`
  ).all();
  const byLogicalId = new Map(visible.map((row) => [
    JSON.parse(row.meta).custom_api_source_id,
    { ...row, metadata: JSON.parse(row.meta) },
  ]));

  assert.equal(promotionChecks, 1, "terminal promotion was reached exactly once");
  assert.equal(second.status, "completed");
  assert.deepEqual([...byLogicalId.keys()], [
    "inventory:Store 1",
    "sales:2026-08-01",
    "sales:2026-09-01",
  ]);
  assert.match(byLogicalId.get("sales:2026-08-01").content, /\| Store 1 \| 11 \|/);
  assert.equal(byLogicalId.get("sales:2026-08-01").metadata.custom_api_job_id, second.job_id);
  assert.equal(byLogicalId.get("sales:2026-09-01").metadata.custom_api_job_id, first.job_id);
  assert.equal(byLogicalId.get("inventory:Store 1").metadata.custom_api_job_id, first.job_id);
  assert.equal(byLogicalId.has("inventory:Store 2"), false);
});

test("a forgotten current document is regenerated and terminal map failure cannot strand the next pull", async (t) => {
  const database = setupDatabase();
  t.after(() => database.close());
  const DB = countedD1(database);
  const sourceConfig = compactConfig();
  let currentAt = AT;
  let feed = { data: [
    { store: "Store 1", period: "2026-08-01", revenue_stream: "services", net_sales: 10 },
    { store: "Store 1", period: "2026-09-01", revenue_stream: "services", net_sales: 20 },
  ] };
  let providerFetches = 0;
  const persistence = customApiD1Persistence({ STORAGE: "d1", DB }, { ingestDocument: documentWriter(DB) });
  const options = {
    token: TOKEN,
    now: () => currentAt,
    sleep: async () => {},
    persistence,
    fetchImpl: async () => {
      providerFetches++;
      return new Response(JSON.stringify(feed), { headers: { "content-type": "application/json" } });
    },
  };
  const currentDocument = (logicalSourceId) => database.prepare(
    `SELECT d.doc_uid,d.source_id,d.content
       FROM custom_api_current_jobs c
       JOIN custom_api_document_versions v ON v.source=c.source AND v.job_id=c.job_id
       JOIN documents d ON d.source=v.source AND d.source_id=v.document_source_id
      WHERE c.source='store-dashboard' AND v.logical_source_id=?1 AND d.deleted_at IS NULL`,
  ).get(logicalSourceId);

  const first = await settlePull(sourceConfig, options);
  const forgottenLogicalId = "sales:2026-08-01";
  const firstDocument = currentDocument(forgottenLogicalId);
  assert.ok(firstDocument, "the first pull reached the mapped live-document decision point");
  const forgotten = await forget({ STORAGE: "d1", DB }, { docUids: [firstDocument.doc_uid], dryRun: false });
  assert.equal(forgotten.documents, 1, "the confirmed forget path removed one current document");
  assert.equal(currentDocument(forgottenLogicalId), undefined);

  currentAt = new Date("2026-09-25T15:30:00.000Z");
  const repaired = await settlePull(sourceConfig, options);
  assert.equal(providerFetches, 2, "the identical response was fetched before integrity recovery");
  assert.notEqual(repaired.job_id, first.job_id, "a hash match did not reuse an incomplete snapshot");
  const repairedDocument = currentDocument(forgottenLogicalId);
  assert.ok(repairedDocument, "the identical pull restored the exact missing logical document");
  assert.notEqual(repairedDocument.source_id, firstDocument.source_id);

  database.prepare(
    "DELETE FROM custom_api_row_chunks WHERE source='store-dashboard' AND job_id=?1 AND endpoint='sales'",
  ).run(repaired.job_id);
  currentAt = new Date("2026-09-26T15:30:00.000Z");
  const rowRepaired = await settlePull(sourceConfig, options);
  assert.notEqual(rowRepaired.job_id, repaired.job_id, "a missing current row chunk also invalidated the hash shortcut");
  assert.equal((await persistence.loadRows({ source: "store-dashboard", endpoint: "sales" })).length, 2,
    "the identical response restored every current structured row");

  feed = { data: [
    { store: "Store 1", period: "2026-08-01", revenue_stream: "services", net_sales: 10 },
    { store: "Store 1", period: "2026-09-01", revenue_stream: "services", net_sales: 21 },
  ] };
  currentAt = new Date("2026-09-27T15:30:00.000Z");
  const staged = await runCustomApiPull(sourceConfig, options);
  assert.equal(staged.status, "in_progress");
  const carriedDocument = currentDocument(forgottenLogicalId);
  await forget({ STORAGE: "d1", DB }, { docUids: [carriedDocument.doc_uid], dryRun: false });

  let terminalFailure = null;
  for (let attempt = 0; attempt < 20 && !terminalFailure; attempt++) {
    try {
      await runCustomApiPull(sourceConfig, options);
    } catch (error) {
      terminalFailure = error;
    }
  }
  assert.match(terminalFailure?.message || "", /terminal version map/i,
    "the missing carried version reached terminal verification");
  assert.equal(database.prepare("SELECT status FROM custom_api_jobs WHERE job_id=?1").get(staged.job_id).status, "failed");
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS n FROM custom_api_jobs WHERE source='store-dashboard' AND status IN ('staged','applying','promoting','promoted')",
  ).get().n, 0, "terminal failure released the active-job uniqueness boundary");

  const recovered = await settlePull(sourceConfig, options);
  assert.equal(recovered.status, "completed");
  assert.equal(providerFetches, 5, "the failed job forced one fresh provider pull");
  assert.ok(currentDocument(forgottenLogicalId), "the fresh pull regenerated the document missing from the failed map");
  assert.ok(currentDocument("sales:2026-09-01"), "the unrelated changed document also completed");
});

test("sales absence statements stay scoped to each store and month in both layouts", async () => {
  const sourceConfig = config();
  sourceConfig.endpoints = [sourceConfig.endpoints[0]];
  for (const document of sourceConfig.endpoints[0].documents) {
    document.expected_values = { revenue_stream: ["live_animal", "supplies", "services", "other"] };
    document.body_template = "{{missing.revenue_stream}}\n\n{{rows_table}}";
  }
  const documents = [];
  let providerFetches = 0;
  const result = await runCustomApiPull(sourceConfig, {
    token: TOKEN,
    now: () => AT,
    sleep: async () => {},
    fetchImpl: async () => {
      providerFetches++;
      return new Response(JSON.stringify({ data: [
        { store: "Store 1", period: "2026-09-01", revenue_stream: "live_animal", net_sales: 100 },
        { store: "Store 1", period: "2026-09-01", revenue_stream: "supplies", net_sales: 10 },
        { store: "Store 2", period: "2026-09-01", revenue_stream: "services", net_sales: 20 },
        { store: "Store 2", period: "2026-09-01", revenue_stream: "other", net_sales: 5 },
      ] }), { headers: { "content-type": "application/json" } });
    },
    persistence: {
      async loadRows() { return []; },
      async persist({ documentChanges }) { documents.push(...documentChanges); },
    },
  });
  assert.equal(providerFetches, 1, "the complementary-stream fixture reached the provider decision point");
  assert.equal(result.documents, 3);
  assert.equal(documents.length, 3, "both document layouts reached persistence");
  const byId = new Map(documents.map((document) => [document.source_id, document.content]));
  const expected = [
    ["Store 1", "services"],
    ["Store 1", "other"],
    ["Store 2", "live_animal"],
    ["Store 2", "supplies"],
  ];
  for (const [store, stream] of expected) {
    const statement = `${store}, 2026-09-01: no ${stream.replaceAll("_", " ")} sales recorded`;
    assert.match(byId.get("sales:monthly:2026-09-01"), new RegExp(statement));
    assert.match(byId.get(`sales:store-history:${store}`), new RegExp(statement));
  }
  for (const content of byId.values()) {
    assert.doesNotMatch(content, /\|\s*(?:live_animal|supplies|services|other)\s*\|\s*\$?0(?:\.00)?\s*\|/,
      "an absent stream is prose, never an invented zero row");
  }
});

for (const [label, body] of [
  ["empty first pull", { data: [] }],
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

test("first-pull refusal creates no snapshot and leaves an owner-visible refusal state", async (t) => {
  const database = setupDatabase();
  t.after(() => database.close());
  const DB = countedD1(database);
  const env = {
    STORAGE: "d1", DB, CUSTOM_API_TOKEN_STORE_DASHBOARD: TOKEN,
    CUSTOM_API_CONFIG: JSON.stringify(compactConfig()),
  };
  let fetches = 0;
  const result = await runCustomApiWorker(env, {
    now: () => AT,
    sleep: async () => {},
    persistence: customApiD1Persistence(env, { ingestDocument: documentWriter(DB) }),
    fetchImpl: async () => {
      fetches++;
      return new Response(JSON.stringify({ data: [{
        store: "Store 1", period: "2026-09-01", revenue_stream: "services",
      }] }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(fetches, 1, "the refused provider row reached row validation");
  assert.equal(result.status, "refused");
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM custom_api_jobs").get().n, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM custom_api_current_jobs").get().n, 0);
  const source = database.prepare(
    "SELECT status,last_ingest_at,document_count,stale_reason FROM sources WHERE name='store-dashboard'",
  ).get();
  assert.equal(source.status, "error");
  assert.equal(source.last_ingest_at, null);
  assert.equal(source.document_count, 0);
  assert.equal(source.stale_reason, "INPUT_REFUSED");
});

test("a partial refusal is marked in the document and source until a clean pull clears it", async (t) => {
  const database = setupDatabase();
  t.after(() => database.close());
  const DB = countedD1(database);
  const sourceConfig = { ...compactConfig(), display_name: "store dashboard" };
  const env = {
    STORAGE: "d1", DB, CUSTOM_API_TOKEN_STORE_DASHBOARD: TOKEN,
    CUSTOM_API_CONFIG: JSON.stringify(sourceConfig),
  };
  const persistence = customApiD1Persistence(env, { ingestDocument: documentWriter(DB) });
  let currentAt = AT;
  let feed = { data: [
    { store: "Store 1", period: "2026-09-01", revenue_stream: "services", net_sales: 10 },
    { store: "Store 2", period: "2026-09-01", revenue_stream: "services", net_sales: 20 },
  ] };
  let fetches = 0;
  const options = {
    token: TOKEN, now: () => currentAt, sleep: async () => {}, persistence,
    fetchImpl: async () => {
      fetches++;
      return new Response(JSON.stringify(feed), { headers: { "content-type": "application/json" } });
    },
  };
  const first = await settleWorker(env, options);
  feed = { data: [
    { store: "Store 1", period: "2026-09-01", revenue_stream: "services", net_sales: 11 },
    { store: "Store 2", period: "2026-09-01", revenue_stream: "services" },
  ] };
  currentAt = new Date("2026-09-25T15:30:00.000Z");
  const second = await settleWorker(env, options);
  assert.ok(fetches >= 2, "both provider snapshots reached the refusal decision point");
  assert.notEqual(second.job_id, first.job_id);
  const rows = await persistence.loadRows({ source: "store-dashboard", endpoint: "sales" });
  const carried = rows.find((row) => row.row.store === "Store 2");
  assert.equal(carried.present, true);
  assert.equal(carried.row.net_sales, 20);
  assert.equal(carried.refresh_status, "not refreshed (refused)");
  assert.equal(carried.refusal_reason, "invalid_net_sales");
  assert.equal(carried.last_seen_at, AT.toISOString(), "a refused carry preserves the last accepted observation time");
  const visible = database.prepare(
    `SELECT content,meta FROM documents d
      WHERE d.source='store-dashboard' AND d.deleted_at IS NULL${currentCustomApiDocumentSql("d")}`,
  ).get();
  assert.match(visible.content, /Store 2/);
  assert.match(visible.content, /20/);
  assert.match(visible.content, /not refreshed on 2026-09-25: the store dashboard sent a row the Brain could not read/i);
  assert.equal(JSON.parse(visible.meta).not_refreshed_rows, 1);
  assert.equal(second.refused_rows, 1);
  assert.equal(second.source_status, "ready_with_warnings");
  const warnedSource = database.prepare(
    "SELECT status,last_ingest_at,document_count,stale_reason FROM sources WHERE name='store-dashboard'",
  ).get();
  assert.equal(warnedSource.status, "ready");
  assert.equal(warnedSource.last_ingest_at, second.fetched_at);
  assert.equal(warnedSource.stale_reason, "INPUT_REFUSED");
  const warnedFreshness = await freshnessReport(env, { now: Date.parse(second.fetched_at) });
  assert.equal(warnedFreshness.sources[0].source_status, "ready_with_warnings");
  assert.equal(warnedFreshness.sources[0].refused_rows, 1);
  assert.match(warnedFreshness.sources[0].reason, /1 row.*not refreshed/i);
  const warnedGaps = await coverageGaps(env, { now: Date.parse(second.fetched_at) });
  assert.ok(warnedGaps.some((gap) => gap.type === "sync_broken" && /1 row.*not refreshed/i.test(gap.detail)));

  feed = { data: [
    { store: "Store 1", period: "2026-09-01", revenue_stream: "services", net_sales: 11 },
    { store: "Store 2", period: "2026-09-01", revenue_stream: "services", net_sales: 20 },
  ] };
  currentAt = new Date("2026-09-26T15:30:00.000Z");
  const clean = await settleWorker(env, options);
  assert.equal(clean.source_status, "ready");
  const cleanRows = await persistence.loadRows({ source: "store-dashboard", endpoint: "sales" });
  const cleanCarried = cleanRows.find((row) => row.row.store === "Store 2");
  assert.equal(cleanCarried.refresh_status, undefined);
  assert.equal(cleanCarried.last_seen_at, currentAt.toISOString(), "the next accepted row advances its observation time");
  const cleanVisible = database.prepare(
    `SELECT content,meta FROM documents d
      WHERE d.source='store-dashboard' AND d.deleted_at IS NULL${currentCustomApiDocumentSql("d")}`,
  ).get();
  assert.doesNotMatch(cleanVisible.content, /not refreshed/i);
  assert.equal(JSON.parse(cleanVisible.meta).not_refreshed_rows, 0);
  const cleanSource = database.prepare(
    "SELECT status,last_ingest_at,stale_reason FROM sources WHERE name='store-dashboard'",
  ).get();
  assert.equal(cleanSource.status, "ready");
  assert.equal(cleanSource.last_ingest_at, clean.fetched_at);
  assert.equal(cleanSource.stale_reason, null);

  const pointerBeforeAllRefused = database.prepare(
    "SELECT job_id FROM custom_api_current_jobs WHERE source='store-dashboard'",
  ).get().job_id;
  feed = { data: [
    { store: "Store 1", period: "2026-09-01", revenue_stream: "services" },
    { store: "Store 2", period: "2026-09-01", revenue_stream: "services" },
  ] };
  currentAt = new Date("2026-09-27T15:30:00.000Z");
  const refused = await runCustomApiWorker(env, {
    now: () => currentAt,
    sleep: async () => {},
    persistence,
    fetchImpl: options.fetchImpl,
  });
  assert.equal(refused.status, "refused");
  assert.equal(
    database.prepare("SELECT job_id FROM custom_api_current_jobs WHERE source='store-dashboard'").get().job_id,
    pointerBeforeAllRefused,
  );
  assert.equal(database.prepare(
    `SELECT COUNT(*) AS n FROM documents d
      WHERE d.source='store-dashboard' AND d.deleted_at IS NULL${currentCustomApiDocumentSql("d")}`,
  ).get().n, 1);
  const source = database.prepare(
    "SELECT status,last_ingest_at,document_count,stale_reason FROM sources WHERE name='store-dashboard'",
  ).get();
  assert.equal(source.status, "error");
  assert.equal(source.last_ingest_at, clean.fetched_at);
  assert.equal(source.document_count, 1);
  assert.equal(source.stale_reason, "INPUT_REFUSED");
  const refusedFreshness = await freshnessReport(env, { now: Date.parse(refused.fetched_at) });
  assert.equal(refusedFreshness.sources[0].refused_rows, 2);
  assert.match(refusedFreshness.sources[0].reason, /2 rows.*not refreshed/i);
});

test("a missing sales stream refuses one provider row without hiding other store-month keys", async (t) => {
  const database = setupDatabase();
  t.after(() => database.close());
  const DB = countedD1(database);
  const sourceConfig = compactConfig();
  sourceConfig.endpoints[0].document.expected_values = {
    revenue_stream: ["live_animal", "services", "other"],
  };
  const persistence = customApiD1Persistence({ STORAGE: "d1", DB }, { ingestDocument: documentWriter(DB) });
  let currentAt = AT;
  let feed = { data: [
    { store: "Store 1", period: "2026-09-01", revenue_stream: "live_animal", net_sales: 10 },
    { store: "Store 1", period: "2026-09-01", revenue_stream: "services", net_sales: 20 },
    { store: "Store 2", period: "2026-09-01", revenue_stream: "other", net_sales: 30 },
    { store: "Store 3", period: "2026-09-01", revenue_stream: "services", net_sales: 40 },
  ] };
  let fetches = 0;
  const options = {
    token: TOKEN, now: () => currentAt, sleep: async () => {}, persistence,
    fetchImpl: async () => {
      fetches++;
      return new Response(JSON.stringify(feed), { headers: { "content-type": "application/json" } });
    },
  };
  await settlePull(sourceConfig, options);
  feed = { data: [
    { store: "Store 1", period: "2026-09-01", net_sales: 99 },
    { store: "Store 2", period: "2026-09-01", revenue_stream: "other", net_sales: 31 },
  ] };
  currentAt = new Date("2026-09-25T15:30:00.000Z");
  const second = await settlePull(sourceConfig, options);

  assert.ok(fetches >= 2, "the unlabeled row reached known sales identity validation");
  assert.equal(second.refused_rows, 1, "one malformed provider row remains one refusal");
  const rows = await persistence.loadRows({ source: "store-dashboard", endpoint: "sales" });
  const byStoreAndStream = new Map(rows.map((item) => [
    `${item.row.store}:${item.row.revenue_stream}`,
    item,
  ]));
  for (const stream of ["live_animal", "services"]) {
    const carried = byStoreAndStream.get(`Store 1:${stream}`);
    assert.equal(carried.present, true);
    assert.equal(carried.refresh_status, "not refreshed (refused)");
  }
  assert.equal(byStoreAndStream.get("Store 2:other").row.net_sales, 31);
  assert.equal(byStoreAndStream.get("Store 3:services").present, false,
    "the scoped refusal cannot preserve an unrelated key");
  const visible = database.prepare(
    `SELECT content,meta FROM documents d
      WHERE d.source='store-dashboard' AND d.deleted_at IS NULL${currentCustomApiDocumentSql("d")}`,
  ).get();
  assert.match(visible.content, /Some rows weren't refreshed on 2026-09-25: 1 row the custom business API sent couldn't be read\./);
  assert.match(visible.content, /Store 1/);
  assert.doesNotMatch(visible.content, /Store 3/);
});

test("a configured legacy refusal carries only its exact legacy key", async (t) => {
  const database = setupDatabase();
  t.after(() => database.close());
  const DB = countedD1(database);
  const sourceConfig = compactConfig();
  sourceConfig.endpoints[0].legacy_row_key = ["store", "period"];
  const persistence = customApiD1Persistence({ STORAGE: "d1", DB }, { ingestDocument: documentWriter(DB) });
  let currentAt = AT;
  let feed = { data: [
    { store: "Store 1", period: "2026-09-01", revenue_stream: "live_animal", net_sales: 10 },
    { store: "Store 1", period: "2026-09-01", revenue_stream: "services", net_sales: 20 },
    { store: "Store 1", period: "2026-09-01", net_sales: 5 },
  ] };
  let fetches = 0;
  const options = {
    token: TOKEN, now: () => currentAt, sleep: async () => {}, persistence,
    fetchImpl: async () => {
      fetches++;
      return new Response(JSON.stringify(feed), { headers: { "content-type": "application/json" } });
    },
  };
  await settlePull(sourceConfig, options);
  feed = { data: [
    { store: "Store 1", period: "2026-09-01", revenue_stream: "services", net_sales: 21 },
    { store: "Store 1", period: "2026-09-01" },
  ] };
  currentAt = new Date("2026-09-25T15:30:00.000Z");
  const second = await settlePull(sourceConfig, options);

  assert.ok(fetches >= 2, "the legacy-shaped row reached value refusal");
  assert.equal(second.refused_rows, 1);
  const rows = await persistence.loadRows({ source: "store-dashboard", endpoint: "sales" });
  const exactLegacy = rows.find((row) => row.row_key === 'store="Store 1"|period="2026-09-01"');
  const missingLabeled = rows.find((row) => row.row.revenue_stream === "live_animal");
  assert.equal(exactLegacy.present, true);
  assert.equal(exactLegacy.refresh_status, "not refreshed (refused)");
  assert.equal(missingLabeled.present, false, "a legacy refusal cannot preserve a different labeled key");
});

test("a carried refusal adds the fixed envelope warning without a rows table", async (t) => {
  const database = setupDatabase();
  t.after(() => database.close());
  const DB = countedD1(database);
  const sourceConfig = compactConfig();
  sourceConfig.display_name = "dashboard";
  sourceConfig.endpoints[0].document = {
    ...sourceConfig.endpoints[0].document,
    body_template: "Net sales: {{sum.net_sales}}",
    aggregates: { net_sales: "sum" },
    formats: { net_sales: "currency" },
  };
  const persistence = customApiD1Persistence({ STORAGE: "d1", DB }, { ingestDocument: documentWriter(DB) });
  let currentAt = AT;
  let feed = { data: [
    { store: "Store 1", period: "2026-09-01", revenue_stream: "services", net_sales: 100 },
    { store: "Store 2", period: "2026-09-01", revenue_stream: "services", net_sales: 50 },
  ] };
  let fetches = 0;
  const options = {
    token: TOKEN, now: () => currentAt, sleep: async () => {}, persistence,
    fetchImpl: async () => {
      fetches++;
      return new Response(JSON.stringify(feed), { headers: { "content-type": "application/json" } });
    },
  };
  await settlePull(sourceConfig, options);
  feed = { data: [
    { store: "Store 1", period: "2026-09-01", revenue_stream: "services", net_sales: 100 },
    { store: "Store 2", period: "2026-09-01", revenue_stream: "services" },
  ] };
  currentAt = new Date("2026-09-25T15:30:00.000Z");
  await settlePull(sourceConfig, options);
  assert.ok(fetches >= 2, "the refusal reached the durable document planner");
  const visible = database.prepare(
    `SELECT content,meta FROM documents d
      WHERE d.source='store-dashboard' AND d.deleted_at IS NULL${currentCustomApiDocumentSql("d")}`,
  ).get();
  assert.match(visible.content, /^Some rows weren't refreshed on 2026-09-25: 1 row the dashboard sent couldn't be read\. Figures below may include earlier values\./);
  assert.match(visible.content, /Net sales: \$150\.00/);
  assert.doesNotMatch(sourceConfig.endpoints[0].document.body_template, /rows_table/);
  assert.equal(JSON.parse(visible.meta).not_refreshed_rows, 1);
});

test("changed inventory and costs keep prior structured values while search exposes only current values", async (t) => {
  const database = setupDatabase();
  t.after(() => database.close());
  const DB = countedD1(database);
  const sourceConfig = {
    ...config(),
    endpoints: config().endpoints.filter((endpoint) => ["inventory", "costs"].includes(endpoint.name)),
  };
  const persistence = customApiD1Persistence({ STORAGE: "d1", DB }, { ingestDocument: documentWriter(DB) });
  let currentAt = AT;
  let feeds = {
    inventory: { data: [{ store: "Store 1", breed: "Item 1", count: 3 }] },
    costs: { data: [{ store: "Store 1", breed: "Item 1", avg_cost: 10, received: 2 }] },
  };
  let providerCalls = 0;
  const options = {
    token: TOKEN, now: () => currentAt, sleep: async () => {}, persistence,
    fetchImpl: async (input) => {
      providerCalls++;
      return new Response(JSON.stringify(feeds[new URL(input).pathname.split("/").pop()]), {
        headers: { "content-type": "application/json" },
      });
    },
  };
  const first = await settlePull(sourceConfig, options);
  feeds = {
    inventory: { data: [{ store: "Store 1", breed: "Item 1", count: 4 }] },
    costs: { data: [{ store: "Store 1", breed: "Item 1", avg_cost: 11, received: 3 }] },
  };
  currentAt = new Date("2026-09-25T15:30:00.000Z");
  const second = await settlePull(sourceConfig, options);
  assert.ok(providerCalls >= 4, "both dated snapshots reached both endpoint decision points");
  assert.notEqual(second.job_id, first.job_id);

  const inventoryRows = await persistence.loadRows({ source: "store-dashboard", endpoint: "inventory" });
  const costRows = await persistence.loadRows({ source: "store-dashboard", endpoint: "costs" });
  assert.equal(inventoryRows[0].row.count, 4);
  assert.deepEqual(inventoryRows[0].history_rows, [{
    row_hash: inventoryRows[0].history_rows[0].row_hash,
    row: { store: "Store 1", breed: "Item 1", count: 3 },
    effective_from: AT.toISOString(),
    effective_to: currentAt.toISOString(),
  }]);
  assert.equal(costRows[0].row.avg_cost, 11);
  assert.deepEqual(costRows[0].history_rows, [{
    row_hash: costRows[0].history_rows[0].row_hash,
    row: { store: "Store 1", breed: "Item 1", avg_cost: 10, received: 2 },
    effective_from: AT.toISOString(),
    effective_to: currentAt.toISOString(),
  }]);

  const visible = database.prepare(
    `SELECT d.content,json_extract(d.meta,'$.custom_api_source_id') AS logical_id
       FROM documents d
      WHERE d.source='store-dashboard' AND d.deleted_at IS NULL${currentCustomApiDocumentSql("d")}
      ORDER BY logical_id`,
  ).all();
  assert.equal(visible.length, 2, "search keeps one current inventory and cost document per store");
  const documents = new Map(visible.map((row) => [row.logical_id, row.content]));
  assert.match(documents.get("inventory:Store 1"), /\| Item 1 \| 4 \|/);
  assert.doesNotMatch(documents.get("inventory:Store 1"), /\| Item 1 \| 3 \|/);
  assert.match(documents.get("costs:Store 1"), /\| Item 1 \| \$11\.00 \| 3 \|/);
  assert.doesNotMatch(documents.get("costs:Store 1"), /\$10\.00/);
});

test("inventory and cost history close at disappearance and reopen after the gap", async (t) => {
  const database = setupDatabase();
  t.after(() => database.close());
  const DB = countedD1(database);
  const sourceConfig = {
    ...config(),
    endpoints: config().endpoints.filter((endpoint) => ["inventory", "costs"].includes(endpoint.name)),
  };
  const persistence = customApiD1Persistence({ STORAGE: "d1", DB }, { ingestDocument: documentWriter(DB) });
  let currentAt = AT;
  let feeds = {
    inventory: { data: [{ store: "Store 1", breed: "Item 1", count: 3 }] },
    costs: { data: [{ store: "Store 1", breed: "Item 1", avg_cost: 10, received: 2 }] },
  };
  let providerCalls = 0;
  const options = {
    token: TOKEN, now: () => currentAt, sleep: async () => {}, persistence,
    fetchImpl: async (input) => {
      providerCalls++;
      return new Response(JSON.stringify(feeds[new URL(input).pathname.split("/").pop()]), {
        headers: { "content-type": "application/json" },
      });
    },
  };
  await settlePull(sourceConfig, options);
  const absentAt = new Date("2026-09-25T15:30:00.000Z");
  currentAt = absentAt;
  feeds = { inventory: { data: [] }, costs: { data: [] } };
  await settlePull(sourceConfig, options);
  for (const endpoint of ["inventory", "costs"]) {
    const [absent] = await persistence.loadRows({ source: "store-dashboard", endpoint });
    assert.equal(absent.present, false, `${endpoint} reached the disappearance decision`);
    assert.equal(absent.effective_from, absentAt.toISOString());
    assert.equal(absent.history_rows[0].effective_to, absentAt.toISOString());
  }

  const reappearedAt = new Date("2026-09-26T15:30:00.000Z");
  currentAt = reappearedAt;
  feeds = {
    inventory: { data: [{ store: "Store 1", breed: "Item 1", count: 3 }] },
    costs: { data: [{ store: "Store 1", breed: "Item 1", avg_cost: 11, received: 3 }] },
  };
  await settlePull(sourceConfig, options);
  assert.ok(providerCalls >= 6, "all three snapshots reached both endpoint decisions");
  for (const endpoint of ["inventory", "costs"]) {
    const [row] = await persistence.loadRows({ source: "store-dashboard", endpoint });
    assert.equal(row.present, true);
    assert.equal(row.effective_from, reappearedAt.toISOString(), `${endpoint} opened a new value interval`);
    assert.deepEqual(row.history_rows.map((history) => ({
      effective_from: history.effective_from,
      effective_to: history.effective_to,
    })), [{
      effective_from: AT.toISOString(),
      effective_to: absentAt.toISOString(),
    }]);
  }
});

test("malformed known identities are refused without hiding prior keys and unknown fields remain allowed", async (t) => {
  const database = setupDatabase();
  t.after(() => database.close());
  const DB = countedD1(database);
  const sourceConfig = compactConfig();
  sourceConfig.endpoints[0].document.expected_values = { revenue_stream: ["services"] };
  const persistence = customApiD1Persistence({ STORAGE: "d1", DB }, { ingestDocument: documentWriter(DB) });
  let currentAt = AT;
  let feed = { data: [
    { store: "Store 1", period: "2026-09-01", revenue_stream: "services", net_sales: 10 },
    { store: "Store 2", period: "2026-09-01", revenue_stream: "services", net_sales: 20 },
    { store: "Store 3", period: "2026-09-01", revenue_stream: "services", net_sales: 30 },
  ] };
  let fetches = 0;
  const options = {
    token: TOKEN, now: () => currentAt, sleep: async () => {}, persistence,
    fetchImpl: async () => {
      fetches++;
      return new Response(JSON.stringify(feed), { headers: { "content-type": "application/json" } });
    },
  };
  await settlePull(sourceConfig, options);
  feed = { data: [
    { store: "Store 1", period: "2026-09-01", revenue_stream: "services", net_sales: 11, harmless_extra: "kept" },
    { store: false, period: "2026-09-01", revenue_stream: "services", net_sales: 20 },
    { store: "Store 3", period: 20260901, revenue_stream: "services", net_sales: 30 },
  ] };
  currentAt = new Date("2026-09-25T15:30:00.000Z");
  const result = await settlePull(sourceConfig, options);
  assert.ok(fetches >= 2, "the malformed identities reached provider row validation");
  assert.equal(result.refused_rows, 2);
  assert.equal(result.endpoint_results[0].refusal_reasons.invalid_store, 1);
  assert.equal(result.endpoint_results[0].refusal_reasons.invalid_period, 1);
  const rows = await persistence.loadRows({ source: "store-dashboard", endpoint: "sales" });
  assert.equal(rows.length, 3);
  assert.equal(rows.find((row) => row.row.store === "Store 1").row.harmless_extra, "kept");
  for (const store of ["Store 2", "Store 3"]) {
    const carried = rows.find((row) => row.row.store === store);
    assert.equal(carried.present, true);
    assert.equal(carried.refresh_status, "not refreshed (refused)");
  }
  const visible = database.prepare(
    `SELECT content FROM documents d
      WHERE d.source='store-dashboard' AND d.deleted_at IS NULL${currentCustomApiDocumentSql("d")}`,
  ).get();
  assert.match(visible.content, /Store 2/);
  assert.match(visible.content, /Store 3/);
});

test("an invalid sales period creates no active job and a corrected pull can finish", async (t) => {
  const database = setupDatabase();
  t.after(() => database.close());
  const DB = countedD1(database);
  const persistence = customApiD1Persistence({ STORAGE: "d1", DB }, { ingestDocument: documentWriter(DB) });
  let feed = { data: [{ store: "Store 1", period: "not-a-month", revenue_stream: "services", net_sales: 10 }] };
  let fetches = 0;
  const options = {
    token: TOKEN, now: () => AT, sleep: async () => {}, persistence,
    fetchImpl: async () => {
      fetches++;
      return new Response(JSON.stringify(feed), { headers: { "content-type": "application/json" } });
    },
  };
  const invalid = await runCustomApiPull(compactConfig(), options);
  assert.equal(fetches, 1, "the malformed period reached row validation");
  assert.equal(invalid.status, "refused");
  assert.equal(invalid.endpoint_results[0].refusal_reasons.invalid_period, 1);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS n FROM custom_api_jobs WHERE status IN ('staged','applying','promoting','promoted')",
  ).get().n, 0);

  feed = { data: [{ store: "Store 1", period: "2026-09-01", revenue_stream: "services", net_sales: 10 }] };
  const corrected = await settlePull(compactConfig(), options);
  assert.equal(corrected.status, "completed");
  assert.equal(fetches, 2, "the corrected pull fetched fresh provider data");
});

test("a permanently invalid staged document is failed once and the next pull refetches", async (t) => {
  const database = setupDatabase();
  t.after(() => database.close());
  const DB = countedD1(database);
  const persistence = customApiD1Persistence({ STORAGE: "d1", DB }, { ingestDocument: documentWriter(DB) });
  let fetches = 0;
  const options = {
    token: TOKEN, now: () => AT, sleep: async () => {}, persistence,
    fetchImpl: async () => {
      fetches++;
      return new Response(JSON.stringify({ data: [
        { store: "Store 1", period: "2026-09-01", revenue_stream: "services", net_sales: 10 },
      ] }), { headers: { "content-type": "application/json" } });
    },
  };
  const staged = await runCustomApiPull(compactConfig(), options);
  assert.equal(staged.status, "in_progress");
  await runCustomApiPull(compactConfig(), options);
  const documentSlice = database.prepare(
    "SELECT job_id,slice_index,kind,endpoint,target_key,payload_json FROM custom_api_job_slices WHERE job_id=?1 AND kind='document'",
  ).get(staged.job_id);
  assert.ok(documentSlice, "the staged document decision point exists");
  const payload = JSON.parse(documentSlice.payload_json);
  payload.occurred_at = "not-a-date";
  const payloadJson = JSON.stringify(payload);
  const payloadHash = await hashText(
    `${documentSlice.kind}:${documentSlice.endpoint}:${documentSlice.target_key}:${payloadJson}`,
  );
  database.prepare(
    "UPDATE custom_api_job_slices SET payload_json=?1,payload_hash=?2 WHERE job_id=?3 AND slice_index=?4",
  ).run(payloadJson, payloadHash, staged.job_id, documentSlice.slice_index);
  const hashes = database.prepare(
    "SELECT payload_hash FROM custom_api_job_slices WHERE job_id=?1 ORDER BY slice_index",
  ).all(staged.job_id).map((row) => row.payload_hash);
  const versions = database.prepare(
    "SELECT logical_source_id,document_source_id FROM custom_api_document_versions WHERE job_id=?1 ORDER BY logical_source_id",
  ).all(staged.job_id);
  database.prepare("UPDATE custom_api_jobs SET job_hash=?1 WHERE job_id=?2").run(
    await hashText(canonicalJson({ slice_hashes: hashes, document_versions: versions })),
    staged.job_id,
  );

  await assert.rejects(runCustomApiPull(compactConfig(), options), /staged custom API document is invalid/i);
  assert.equal(database.prepare("SELECT status FROM custom_api_jobs WHERE job_id=?1").get(staged.job_id).status, "failed");
  const corrected = await settlePull(compactConfig(), options);
  assert.equal(corrected.status, "completed");
  assert.equal(fetches, 2, "the failed staged job did not suppress a fresh provider pull");
});

test("promotion queues more than one candidate page of stale vectors before the current document is searched", async (t) => {
  const database = setupDatabase();
  t.after(() => database.close());
  const DB = countedD1(database);
  const writeDocumentWithChunk = async (envelope) => {
    await documentWriter(DB)(envelope);
    const docUid = `${envelope.source_type}:${envelope.source_id}`;
    const chunkUid = `${docUid}:0`;
    await DB.prepare(
      `INSERT INTO chunks (chunk_uid,doc_uid,text,source,title,document_date,vector_id)
       VALUES (?1,?2,?3,?4,?5,?6,?1)
       ON CONFLICT(chunk_uid) DO UPDATE SET text=excluded.text,title=excluded.title`
    ).bind(chunkUid, docUid, envelope.content, envelope.source_type, envelope.title, Date.parse(envelope.occurred_at)).run();
    return { action: "updated" };
  };
  let cleanupSlices = 0;
  let maxCleanupSlice = 0;
  const persistence = customApiD1Persistence({ STORAGE: "d1", DB }, {
    ingestDocument: writeDocumentWithChunk,
    afterDocumentCleanupSlice: ({ queued }) => {
      cleanupSlices++;
      maxCleanupSlice = Math.max(maxCleanupSlice, queued);
    },
  });
  const sourceConfig = compactConfig();
  let currentAt = AT;
  let netSales = 10;
  const options = {
    token: TOKEN, now: () => currentAt, sleep: async () => {}, persistence,
    fetchImpl: async () => new Response(JSON.stringify({ data: [{
      store: "Store 1", period: "2026-09-01", revenue_stream: "services", net_sales: netSales,
    }] }), { headers: { "content-type": "application/json" } }),
  };
  const first = await settlePull(sourceConfig, options);
  database.prepare(
    "INSERT INTO sources (name,kind,status,created_at) VALUES ('store-dashboard','custom_api','ready',?1)",
  ).run(AT.toISOString());

  const staleVectorIds = [];
  for (let index = 0; index < RETRIEVAL_CANDIDATE_DEPTH + 5; index++) {
    const sourceId = `sales:2026-09-01:job:stale-${String(index).padStart(3, "0")}`;
    const docUid = `store-dashboard:${sourceId}`;
    const chunkUid = `${docUid}:0`;
    staleVectorIds.push(chunkUid);
    database.prepare(
      `INSERT INTO documents (doc_uid,source,source_id,content,title,document_date,date_source,date_reliable,
                              text_source,text_reliable,content_hash,meta,deleted_at)
       VALUES (?1,'store-dashboard',?2,'stale','stale',?3,'custom_api:period',1,
               'native',1,?4,?5,NULL)`,
    ).run(
      docUid,
      sourceId,
      Date.parse("2026-09-01T00:00:00.000Z"),
      "a".repeat(64),
      JSON.stringify({
        connector: "custom_api",
        custom_api_job_id: `stale-${index}`,
        custom_api_source_id: "sales:2026-09-01",
      }),
    );
    database.prepare(
      `INSERT INTO chunks (chunk_uid,doc_uid,text,source,title,document_date,vector_id)
       VALUES (?1,?2,'stale','store-dashboard','stale',?3,?1)`,
    ).run(chunkUid, docUid, Date.parse("2026-09-01T00:00:00.000Z"));
  }
  const firstCurrentVector = database.prepare(
    `SELECT c.chunk_uid FROM chunks c JOIN documents d ON d.doc_uid=c.doc_uid
      WHERE d.source='store-dashboard' AND d.source_id=?1`,
  ).get(`sales:2026-09-01:job:${first.job_id}`).chunk_uid;
  const providerIds = [...staleVectorIds, firstCurrentVector];
  const vectorEnv = {
    DB,
    VECTORIZE: {
      query: async (_embedding, { topK }) => ({ matches: providerIds.slice(0, topK).map((id) => ({ id })) }),
    },
  };
  const crowded = await searchVector(vectorEnv, [0.1], {
    limit: RETRIEVAL_CANDIDATE_DEPTH,
    filters: { source: "store-dashboard" },
  });
  assert.equal(crowded.length, 0, "the pre-cleanup control reproduced current-document crowd-out");

  netSales = 11;
  currentAt = new Date("2026-09-25T15:30:00.000Z");
  const second = await settlePull(sourceConfig, options);
  assert.ok(cleanupSlices >= 5, "obsolete documents crossed multiple bounded cleanup slices");
  assert.ok(maxCleanupSlice <= 25, "no cleanup slice crossed its document bound");
  assert.equal(database.prepare(
    "SELECT cleanup_documents_queued FROM custom_api_jobs WHERE job_id=?1",
  ).get(second.job_id).cleanup_documents_queued, RETRIEVAL_CANDIDATE_DEPTH + 6);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS n FROM documents WHERE source='store-dashboard' AND deleted_at IS NULL",
  ).get().n, 1);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS n FROM vector_outbox WHERE op='delete'",
  ).get().n, RETRIEVAL_CANDIDATE_DEPTH + 6);

  const queuedDeletes = new Set(database.prepare(
    "SELECT vector_id FROM vector_outbox WHERE op='delete'",
  ).all().map((row) => row.vector_id));
  providerIds.push(database.prepare(
    `SELECT c.chunk_uid FROM chunks c JOIN documents d ON d.doc_uid=c.doc_uid
      WHERE d.source='store-dashboard' AND d.source_id=?1`,
  ).get(`sales:2026-09-01:job:${second.job_id}`).chunk_uid);
  providerIds.splice(0, providerIds.length, ...providerIds.filter((id) => !queuedDeletes.has(id)));
  const current = await searchVector(vectorEnv, [0.1], {
    limit: RETRIEVAL_CANDIDATE_DEPTH,
    filters: { source: "store-dashboard" },
  });
  assert.equal(current.length, 1);
  assert.equal(JSON.parse(current[0].authority_meta).custom_api_job_id, second.job_id);
  assert.equal(JSON.parse(current[0].authority_meta).custom_api_source_id, "sales:2026-09-01");
});
