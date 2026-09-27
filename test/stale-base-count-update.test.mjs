import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  cmdAcceleratedBootstrap,
  cmdHealth,
  cmdMigrate,
  cmdUpgrade,
  splitStatements,
} from "../brain.mjs";
import worker from "../worker/src/index.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MIGRATIONS = join(ROOT, "migrations", "d1");
const PACKAGE_VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const PRE_C1_SCHEMA = 46;
const ADMIN_LABEL = "fixture-admin-label";

const migrationFiles = readdirSync(MIGRATIONS)
  .filter((name) => /^\d+_.*\.sql$/.test(name))
  .sort();
const currentSchema = Math.max(...migrationFiles.map((name) => Number.parseInt(name, 10)));

function applyPrefix(db, maximum) {
  for (const file of migrationFiles) {
    const version = Number.parseInt(file, 10);
    if (version > maximum) continue;
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    for (const statement of splitStatements(sql)) db.exec(statement);
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?,?,?,?)",
    ).run(
      version,
      file.replace(/\.sql$/, ""),
      "2026-09-01T00:00:00Z",
      createHash("sha256").update(sql).digest("hex").slice(0, 16),
    );
  }
}

function d1Binding(db, statements) {
  const execute = (sql, params, mode) => {
    const statement = db.prepare(sql);
    if (mode === "all") return { results: statement.all(...params) };
    if (mode === "first") return statement.get(...params) ?? null;
    const result = statement.run(...params);
    return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
  };
  const prepared = (sql, params = []) => ({
    sql,
    params,
    bind: (...next) => prepared(sql, next),
    all: async () => { statements.push(sql); return execute(sql, params, "all"); },
    first: async () => { statements.push(sql); return execute(sql, params, "first"); },
    run: async () => { statements.push(sql); return execute(sql, params, "run"); },
  });
  return {
    prepare: (sql) => prepared(sql),
    async exec(sql) {
      statements.push(sql);
      db.exec(sql);
      return { count: 1, duration: 0 };
    },
    async batch(batch) {
      db.exec("BEGIN");
      try {
        const results = batch.map((statement) => {
          statements.push(statement.sql);
          const readOnly = /^\s*(?:SELECT|PRAGMA)\b/i.test(statement.sql) ||
            (/^\s*WITH\b/i.test(statement.sql) && !/\b(?:INSERT|UPDATE|DELETE)\b/i.test(statement.sql));
          return execute(statement.sql, statement.params || [], readOnly ? "all" : "run");
        });
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function d1QueryFor(db, statements) {
  return async (_account, _database, sql, params = []) => {
    statements.push(sql);
    const text = String(sql).trim();
    if (/^(?:SELECT|PRAGMA)\b/i.test(text) || /\bRETURNING\b/i.test(text)) {
      return { results: db.prepare(sql).all(...params) };
    }
    let result = null;
    if (params.length) result = db.prepare(sql).run(...params);
    else db.exec(sql);
    return { results: [], meta: { changes: Number(result?.changes || 0) } };
  };
}

function createPreC1Brain({ baseCount, vectors = 5 }) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyPrefix(db, PRE_C1_SCHEMA);
  db.prepare(
    `INSERT INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1,'fixture','0.4.8',?,0,'2026-09-01T00:00:00Z','test')`,
  ).run(PRE_C1_SCHEMA);
  db.prepare(
    "INSERT INTO sources (name, kind, status, created_at) VALUES ('synthetic','upload','ready','2026-09-01T00:00:00Z')",
  ).run();
  for (let index = 0; index < 5; index++) {
    const docUid = `synthetic:doc-${index}`;
    const chunkUid = `${docUid}#0`;
    db.prepare(
      `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash)
       VALUES (?, 'synthetic', ?, 'Fixture document', 1, ?)`,
    ).run(docUid, String(index), `fixture-hash-${index}`);
    db.prepare(
      `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, vector_id)
       VALUES (?, ?, 0, 'Synthetic fixture text', 'synthetic', ?)`,
    ).run(chunkUid, docUid, chunkUid);
  }
  db.prepare(
    `INSERT INTO corpus_stats (source, documents, chunks, last_ingest_at)
     VALUES ('synthetic', 5, 5, 1)`,
  ).run();
  // This is the durable state written by a pre-C1 drain: exact provider state
  // and an empty outbox, but only the verified flag was refreshed. The stored
  // base is either its fresh-install zero or an older pre-ingest cut.
  db.prepare(
    `UPDATE install_state
        SET vector_projection_status='verified',
            vector_projection_bootstrap_epoch=0,
            vector_projection_bootstrap_protocol='bootstrap-v2',
            vector_projection_bootstrap_cursor=(SELECT MAX(chunk_uid) FROM chunks),
            vector_projection_bootstrap_high_water=(SELECT MAX(chunk_uid) FROM chunks),
            vector_projection_bootstrap_base_count=?
      WHERE id=1`,
  ).run(baseCount);

  const statements = [];
  const visible = new Map();
  for (const row of db.prepare("SELECT chunk_uid FROM chunks ORDER BY chunk_uid").all()) {
    visible.set(row.chunk_uid, { id: row.chunk_uid, values: [0.1], metadata: {} });
  }
  for (let index = visible.size; index < vectors; index++) {
    visible.set(`fixture-excess-${index}`, { id: `fixture-excess-${index}`, values: [0.1], metadata: {} });
  }
  let mutationSequence = 0;
  let processedUpToMutation = null;
  let embeddingCalls = 0;
  const accept = (change) => {
    change();
    processedUpToMutation = `fixture-mutation-${++mutationSequence}`;
    return { mutationId: processedUpToMutation };
  };
  const env = {
    STORAGE: "d1",
    ADMIN_KEY: ADMIN_LABEL,
    BRAIN_NAME: "Synthetic update rehearsal",
    VECTOR_DRAIN_MODE: "active",
    DB: d1Binding(db, statements),
    VECTORIZE: {
      async describe() { return { vectorCount: visible.size, processedUpToMutation }; },
      async upsert(rows) {
        return accept(() => rows.forEach((row) => visible.set(row.id, structuredClone(row))));
      },
      async deleteByIds(ids) {
        return accept(() => ids.forEach((id) => visible.delete(id)));
      },
      async getByIds(ids) {
        return ids.map((id) => visible.get(id)).filter(Boolean).map((row) => structuredClone(row));
      },
      async query() { return { matches: [] }; },
    },
    AI: {
      async run() {
        embeddingCalls++;
        return { data: [[0.1]] };
      },
    },
  };
  return { db, env, statements, visible, embeddingCalls: () => embeddingCalls };
}

async function runUpdate({ baseCount, vectors = 5 }) {
  const brain = createPreC1Brain({ baseCount, vectors });
  const sandbox = mkdtempSync(join(tmpdir(), "stale-base-update-"));
  const manifestPath = join(sandbox, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    client: { slug: "fixture" },
    brain: { domain: "brain.invalid", worker_name: "fixture-brain", version: "0.4.8", ring: "test" },
    infrastructure: { cloudflare: {
      account_id: "fixture-account",
      d1_database_id: "fixture-database",
      storage: "d1",
    } },
    safety: { credential_scanner: { gate_version: 0 } },
  }));
  const events = [];
  const waits = [];
  let migrationsApplied = null;
  let bootstrapResult = null;
  const d1Query = d1QueryFor(brain.db, brain.statements);
  const request = (url, init = {}) => worker.fetch(
    new Request(url, { method: init.method || "GET", headers: init.headers || {}, body: init.body }),
    brain.env,
    { waitUntil() {}, passThroughOnException() {} },
  );
  const backlogReads = [];
  try {
    await cmdUpgrade(manifestPath, {
      // The pre-pause queue gate reads the real Worker's authenticated
      // documents aggregate through the same router as health.
      updateBacklogOptions: {
        resolveAdminKey: () => ADMIN_LABEL,
        http: async (url, init = {}) => {
          backlogReads.push(brain.env.VECTOR_DRAIN_MODE);
          return request(url, init);
        },
        sleep: async () => { throw new Error("a readable backlog receipt must not be retried"); },
      },
      resolveAccount: async () => ({ id: "fixture-account", name: "Fixture" }),
      d1Query,
      cf: async () => ({ bookmark: "fixture-bookmark" }),
      cmdDeploy: async (_path, options) => {
        brain.env.VECTOR_DRAIN_MODE = options.pauseVectorDrainForUpgrade
          ? "paused-for-upgrade"
          : "active";
        events.push(`deploy:${brain.env.VECTOR_DRAIN_MODE}`);
      },
      cmdHealth: async (path, options) => {
        events.push(`health:${options.expectDrainMode}:${options.requireProjectionReady === true}`);
        return cmdHealth(path, {
          ...options,
          request,
          resolveKey: () => ADMIN_LABEL,
          wait: async () => {},
        });
      },
      waitForVectorDrainQuiescence: async (milliseconds) => { waits.push(milliseconds); },
      cmdMigrate: async (path, options) => {
        events.push("migrate");
        const receipt = await cmdMigrate(path, {
          ...options,
          silent: true,
          resolveAccount: async () => ({ id: "fixture-account" }),
          d1Query,
        });
        migrationsApplied = receipt.applied;
        return receipt;
      },
      cmdBootstrap: async (path, options) => {
        events.push("bootstrap");
        let clock = 1_000;
        bootstrapResult = await cmdAcceleratedBootstrap(path, {
          ...options,
          baseUrl: "https://brain.invalid",
          adminKey: ADMIN_LABEL,
          http: request,
          now: () => ++clock,
          sleep: async (milliseconds) => { clock += milliseconds; },
        });
        return bootstrapResult;
      },
      reconcileWorkerProviderSecrets: async () => { events.push("reconcile"); },
      cmdDrain: async () => { events.push("drain"); },
      cmdTest: async () => { events.push("acceptance"); },
    });
    return { ...brain, sandbox, manifestPath, events, waits, backlogReads, migrationsApplied, bootstrapResult, error: null };
  } catch (error) {
    return { ...brain, sandbox, manifestPath, events, waits, backlogReads, migrationsApplied, bootstrapResult, error };
  }
}

for (const scenario of [
  { label: "zero base from an old fresh-install drain", baseCount: 0 },
  { label: "base made stale by later ingest", baseCount: 3 },
]) {
  test(`brain update repairs ${scenario.label} without re-embedding`, async () => {
    const result = await runUpdate(scenario);
    try {
      assert.equal(result.error, null, result.error?.stack || result.error?.message);
      assert.equal(result.migrationsApplied, currentSchema - PRE_C1_SCHEMA);
      assert.equal(result.bootstrapResult?.complete, true, JSON.stringify(result.bootstrapResult));
      assert.equal(result.embeddingCalls(), 0, "the verified cut must not re-embed any chunk");
      const state = result.db.prepare(
        `SELECT product_version, schema_version, vector_projection_status AS status,
                vector_projection_bootstrap_base_count AS base,
                (SELECT COUNT(*) FROM chunks) AS chunks
           FROM install_state WHERE id=1`,
      ).get();
      assert.equal(state.schema_version, currentSchema);
      assert.equal(state.product_version, PACKAGE_VERSION);
      assert.equal(state.status, "verified");
      assert.equal(state.base, state.chunks);
      assert.equal(result.env.VECTOR_DRAIN_MODE, "active");
      assert.deepEqual(result.backlogReads, ["active"],
        "the pre-pause queue gate must read the real active Worker exactly once");
      assert.ok(result.events.indexOf("migrate") > result.events.indexOf("health:paused-for-upgrade:true"),
        JSON.stringify(result.events));
      assert.ok(result.events.indexOf("bootstrap") > result.events.indexOf("migrate"),
        JSON.stringify(result.events));
      assert.ok(result.statements.some((sql) =>
        /SELECT COUNT\(\*\) AS expected_vectors FROM chunks/i.test(sql)),
      "the real paused Worker gate must reach the exact-count decision point");
    } finally {
      result.db.close();
      rmSync(result.sandbox, { recursive: true, force: true });
    }
  });
}

test("brain update still refuses a genuine provider excess before migration", async () => {
  const result = await runUpdate({ baseCount: 3, vectors: 6 });
  try {
    assert.ok(result.error, "a genuine mismatch must refuse");
    assert.match(String(result.error.message), /Vectorize holds 6 vector\(s\), but D1 requires 5/);
    assert.equal(result.migrationsApplied, null, "migration must not start after the gate refuses");
    assert.equal(result.bootstrapResult, null, "bootstrap must not start after the gate refuses");
    assert.equal(result.env.VECTOR_DRAIN_MODE, "paused-for-upgrade");
    assert.deepEqual(result.backlogReads, ["active"]);
    assert.ok(result.statements.some((sql) =>
      /SELECT COUNT\(\*\) AS expected_vectors FROM chunks/i.test(sql)),
    "the refusal must follow the exact-count decision point");
  } finally {
    result.db.close();
    rmSync(result.sandbox, { recursive: true, force: true });
  }
});
