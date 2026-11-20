// A local Brain for "Clean my Brain" tests: the real D1 migrations on node:sqlite,
// the real Worker code, and a fetch that routes to it. No live Brain, no network.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import worker from "../../worker/src/index.js";

const MIGRATIONS = fileURLToPath(new URL("../../migrations/d1/", import.meta.url));
export const ADMIN_KEY = "synthetic-clean-key";
export const BASE = "https://brain.invalid";

export function makeBrain({ schema = 70, dropTriggers = [] } = {}) {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  db.exec(`INSERT INTO install_state (id, client_slug, product_version, schema_version, installed_at)
           VALUES (1, 'fixture', '0.4.30', ${schema}, '2026-11-17T00:00:00Z')`);
  for (const name of dropTriggers) db.exec(`DROP TRIGGER ${name}`);

  const brain = {
    db, statements: [], batches: [], requests: [],
    // One-shot faults. failOnSql throws inside the transaction (rolls back);
    // failAfterCommit throws once the batch has committed, like a lost receipt.
    hooks: { failOnSql: null, failAlways: null, failAfterCommit: null, failReadback: null, beforeRequest: null, network: null },
    health: { ok: true, status: "ok", accepting_documents: true, rollback_write_fence: false, vector_drain_mode: "active", version: "0.4.30" },
  };
  const run = (sql, params, mode) => {
    brain.statements.push(sql);
    const statement = db.prepare(sql);
    if (mode === "all") return { results: statement.all(...params) };
    if (mode === "first") return statement.get(...params) ?? null;
    const before = db.prepare("SELECT total_changes() AS n").get().n;
    const results = statement.all(...params);
    return { results, changes: db.prepare("SELECT total_changes() AS n").get().n - before };
  };
  const prepared = (sql, params = []) => ({
    sql, params,
    bind: (...next) => prepared(sql, next),
    all: async () => {
      if (brain.hooks.failReadback && /SELECT doc_uid FROM documents WHERE doc_uid IN/.test(sql)) {
        const error = brain.hooks.failReadback; brain.hooks.failReadback = null; throw error;
      }
      return run(sql, params, "all");
    },
    first: async () => run(sql, params, "first"),
    run: async () => {
      const result = run(sql, params, "run");
      return { success: true, results: result.results, meta: { changes: result.changes } };
    },
  });
  const DB = {
    prepare: (sql) => prepared(sql),
    async batch(statements) {
      brain.batches.push(statements.map((statement) => statement.sql));
      db.exec("BEGIN");
      try {
        const results = statements.map((statement) => {
          if (brain.hooks.failAlways && brain.hooks.failAlways.test(statement.sql)) {
            throw new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long.");
          }
          if (brain.hooks.failOnSql && brain.hooks.failOnSql.test(statement.sql)) {
            const error = new Error("D1_ERROR: synthetic failure inside the transaction");
            brain.hooks.failOnSql = null;
            throw error;
          }
          const readOnly = /^\s*(SELECT|PRAGMA)\b/i.test(statement.sql);
          if (readOnly) return { success: true, results: run(statement.sql, statement.params, "all").results };
          const result = run(statement.sql, statement.params, "run");
          return { success: true, results: result.results, meta: { changes: result.changes } };
        });
        db.exec("COMMIT");
        if (brain.hooks.failAfterCommit) {
          const error = brain.hooks.failAfterCommit; brain.hooks.failAfterCommit = null; throw error;
        }
        return results;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* already committed */ }
        throw error;
      }
    },
  };
  brain.env = { STORAGE: "d1", ADMIN_KEY, DB, VECTORIZE: {}, INGEST_VERSION: { id: "fixture-runtime" } };

  /** Bulk-load documents the fast way; triggers (counters, family index, FTS) all fire. */
  brain.load = (source, ids, { chunks = 1, partOf = null } = {}) => {
    const insertDocument = db.prepare(
      `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash, meta)
       VALUES (?1, ?2, ?3, 'Synthetic', 1, ?4, ?5)`);
    const insertChunk = db.prepare(
      `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, title, vector_id)
       VALUES (?1, ?2, ?3, 'ordinary synthetic text', ?4, 'Synthetic', NULL)`);
    db.exec("BEGIN");
    for (const id of ids) {
      const uid = `${source}:${id}`;
      insertDocument.run(uid, source, id, `h-${id}`, partOf?.[id] ? JSON.stringify({ part_of: partOf[id] }) : "{}");
      for (let ix = 0; ix < chunks; ix++) insertChunk.run(`${uid}#${ix}`, uid, ix, source);
    }
    db.exec("COMMIT");
  };
  /** Same, at scale: one statement per table (a recursive series). */
  brain.loadMany = (source, prefix, count, chunks = 1) => {
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
      INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash, meta)
      SELECT '${source}:${prefix}' || i, '${source}', '${prefix}' || i, 'Synthetic', 1, 'h', '{}' FROM n`);
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count}),
      c(k) AS (SELECT 0 UNION ALL SELECT k + 1 FROM c WHERE k < ${chunks - 1})
      INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, title, vector_id)
      SELECT '${source}:${prefix}' || i || '#' || k, '${source}:${prefix}' || i, k, 'ordinary synthetic text', '${source}', 'Synthetic', NULL FROM n, c`);
  };
  /** Put n vector clean-up items on the queue, the way removed chunks do. */
  brain.queue = (count) => db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
    INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at, attempts, last_error)
    SELECT 'queued#' || i, 'queued#' || i, 'delete', i, 0, NULL FROM n`);
  brain.stats = (source) => ({ ...db.prepare("SELECT documents, chunks FROM corpus_stats WHERE source = ?").get(source) });
  brain.truth = (source) => ({ ...db.prepare(
    `SELECT (SELECT COUNT(*) FROM documents WHERE source = ?1 AND deleted_at IS NULL) AS documents,
            (SELECT COUNT(*) FROM chunks WHERE source = ?1) AS chunks`).get(source) });
  brain.liveUids = (source) => db.prepare("SELECT doc_uid FROM documents WHERE source = ? ORDER BY doc_uid").all(source).map((row) => row.doc_uid);
  brain.ledger = () => db.prepare("SELECT * FROM owner_removals ORDER BY family_uid").all().map((row) => ({ ...row }));
  brain.totalDocuments = () => db.prepare("SELECT COALESCE(SUM(documents), 0) AS n FROM corpus_stats").get().n;

  /** A fetch that answers /health itself and routes everything else to the real Worker. */
  brain.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    brain.requests.push({ method: options.method || "GET", path, body });
    brain.hooks.beforeRequest?.(path, body);
    if (brain.hooks.network?.test(path)) { const error = new Error("fetch failed"); brain.hooks.network = null; throw error; }
    if (path === "/health") return Response.json(brain.health, { status: brain.health.ok ? 200 : 503 });
    return worker.fetch(new Request(url, { method: options.method || "GET", headers: options.headers, body: options.body }), brain.env, {});
  };
  return brain;
}

/** `gmail:m1` ... as the reviewed list a person would hand over, with its .meta.json. */
export async function writeReviewedList(directory, name, ids) {
  const { writeFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const text = ids.join("\n") + "\n";
  const listPath = join(directory, `${name}.ids`);
  writeFileSync(listPath, text);
  writeFileSync(join(directory, `${name}.meta.json`), JSON.stringify({
    ids_sha256: createHash("sha256").update(text).digest("hex"), count: ids.length }));
  return listPath;
}
