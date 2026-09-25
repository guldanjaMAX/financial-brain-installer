import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { splitStatements } from "../../brain.mjs";
import {
  DOCUMENT_COUNT_NOTE,
  documentsSummarySqlForTest,
  readDocumentSummary,
  readExactDocumentReport,
  readExactSourceDocumentCount,
} from "../src/lib/documents-summary.js";

const DOCUMENTS = 96_011;
const CHUNKS = 1_151_274;
const SOURCES = ["drive", "calendar", "gmail", "imap", "zoom", "upload", "message", "curated"];
const migrationDirectory = join(process.cwd(), "migrations", "d1");
const migrationFiles = readdirSync(migrationDirectory)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();
assert.ok(!migrationFiles.some((name) => name.startsWith("0049_")), "the cache migration was removed");

const scratch = mkdtempSync(join(process.env.HOME, "documents-summary-scale-"));
const database = new DatabaseSync(join(scratch, "scale.sqlite"));

const applyMigration = (name) => {
  for (const statement of splitStatements(readFileSync(join(migrationDirectory, name), "utf8"))) {
    database.exec(statement);
  }
};

const statementTimings = [];
const d1 = (sqlite) => {
  const execute = (sql, params, mode) => {
    const started = performance.now();
    const statement = sqlite.prepare(sql);
    let value;
    if (mode === "all") value = { results: statement.all(...params) };
    else if (mode === "first") value = statement.get(...params) ?? null;
    else {
      const result = statement.run(...params);
      value = { results: [], changes: Number(result.changes || 0) };
    }
    statementTimings.push({ sql, ms: performance.now() - started });
    return value;
  };
  const prepared = (sql, params = []) => ({
    bind: (...next) => prepared(sql, next),
    all: async () => execute(sql, params, "all"),
    first: async () => execute(sql, params, "first"),
    run: async () => {
      const result = execute(sql, params, "run");
      return { success: true, results: result.results, meta: { changes: result.changes } };
    },
  });
  return { prepare: (sql) => prepared(sql) };
};

const measured = (sqlite, sql) => {
  const started = performance.now();
  const rows = sqlite.prepare(sql).all();
  const ms = performance.now() - started;
  const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()
    .map((row) => String(row.detail)).join(" | ");
  return { ms, rows, plan };
};

const originalComponents = (sqlite) => ({
  per_source_stored_documents: measured(sqlite, `
    SELECT source, COUNT(*) AS stored_documents
      FROM documents
     WHERE deleted_at IS NULL
     GROUP BY source`),
  per_source_chunk_join: measured(sqlite, `
    SELECT d.source, COUNT(c.chunk_uid) AS chunks
      FROM documents d
      LEFT JOIN chunks c ON c.doc_uid=d.doc_uid
     WHERE d.deleted_at IS NULL
     GROUP BY d.source`),
  json_logical_document_families: measured(sqlite, `
    SELECT source,
           COUNT(DISTINCT COALESCE(
             CASE WHEN json_valid(meta) THEN json_extract(meta,'$.part_of') END,
             source_id
           )) AS logical_documents
      FROM documents
     WHERE deleted_at IS NULL
     GROUP BY source`),
  per_source_pending_join: measured(sqlite, `
    SELECT c.source, COUNT(*) AS pending
      FROM vector_outbox v
      JOIN chunks c ON c.chunk_uid=v.chunk_uid
     GROUP BY c.source`),
});

const compactTimings = (components) => Object.fromEntries(Object.entries(components)
  .map(([name, result]) => [name, Number(result.ms.toFixed(3))]));

const explainUsesBoundedPlans = (sqlite) => {
  const hot = sqlite.prepare(`EXPLAIN QUERY PLAN ${documentsSummarySqlForTest.hot}`).all()
    .map((row) => String(row.detail)).join(" | ");
  assert.doesNotMatch(hot, /SCAN documents|SCAN chunks/i);
  const documentPage = sqlite.prepare(
    `EXPLAIN QUERY PLAN ${documentsSummarySqlForTest.documentPage}`,
  ).all(0, DOCUMENTS, 5_000).map((row) => String(row.detail)).join(" | ");
  const chunkPage = sqlite.prepare(
    `EXPLAIN QUERY PLAN ${documentsSummarySqlForTest.chunkPage}`,
  ).all(0, CHUNKS, 5_000).map((row) => String(row.detail)).join(" | ");
  const sourceCount = sqlite.prepare(
    `EXPLAIN QUERY PLAN ${documentsSummarySqlForTest.sourceCount}`,
  ).all("drive").map((row) => String(row.detail)).join(" | ");
  assert.match(documentPage, /INTEGER PRIMARY KEY|rowid/i);
  assert.match(chunkPage, /INTEGER PRIMARY KEY|SEARCH chunks/i);
  assert.match(sourceCount, /SEARCH documents USING COVERING INDEX idx_documents_live/i);
  return { hot, documentPage, chunkPage, sourceCount };
};

const expectedSummary = (sqlite) => sqlite.prepare(`
  WITH documents_exact AS (
    SELECT source,
           COUNT(*) AS stored_documents,
           COUNT(DISTINCT COALESCE(
             CASE WHEN json_valid(meta) THEN json_extract(meta,'$.part_of') END,
             source_id
           )) AS logical_documents
      FROM documents
     WHERE deleted_at IS NULL
     GROUP BY source
  ), chunks_exact AS (
    SELECT d.source, COUNT(*) AS chunks,
           SUM(CASE WHEN v.chunk_uid IS NULL THEN 0 ELSE 1 END) AS pending_vectors
      FROM chunks c
      JOIN documents d ON d.doc_uid=c.doc_uid AND d.deleted_at IS NULL
      LEFT JOIN vector_outbox v ON v.chunk_uid=c.chunk_uid
     GROUP BY d.source
  )
  SELECT d.source AS source_type, d.stored_documents, d.logical_documents,
         COALESCE(c.chunks,0) AS chunks, COALESCE(c.pending_vectors,0) AS pending_vectors
    FROM documents_exact d LEFT JOIN chunks_exact c ON c.source=d.source
   ORDER BY d.source`).all().map((row) => ({ ...row }));

const normalizedReportRows = (rows) => rows.filter((row) => row.stored_documents > 0)
  .map((row) => ({
    source_type: row.source_type,
    stored_documents: row.stored_documents,
    logical_documents: row.logical_documents,
    chunks: row.chunks,
    pending_vectors: row.pending_vectors,
  }));

const runVariant = async (name) => {
  statementTimings.length = 0;
  const components = originalComponents(database);
  const plans = explainUsesBoundedPlans(database);
  const env = { DB: d1(database) };
  const hotStarted = performance.now();
  const hot = await readDocumentSummary(env);
  const hotMs = performance.now() - hotStarted;
  assert.ok(hotMs <= 100, `${name} hot summary took ${hotMs.toFixed(3)} ms`);
  assert.equal(hot.summary.status, "informational");
  assert.ok(hot.rows.every((row) => row.documents === null && row.chunks === null &&
    row.count_note === DOCUMENT_COUNT_NOTE));

  const sourceCountStarted = performance.now();
  const sourceCount = await readExactSourceDocumentCount(env, "drive");
  const sourceCountMs = performance.now() - sourceCountStarted;
  const expectedSourceCount = Number(database.prepare(
    "SELECT COUNT(*) AS n FROM documents WHERE source=? AND deleted_at IS NULL",
  ).get("drive").n);
  assert.equal(sourceCount, expectedSourceCount);
  assert.ok(sourceCountMs <= 100,
    `${name} exact source count took ${sourceCountMs.toFixed(3)} ms`);

  const report = await readExactDocumentReport(env, { now: () => 1_760_000_000_000 });
  assert.deepEqual(normalizedReportRows(report.rows), expectedSummary(database));
  assert.equal(report.summary.exact, true);
  assert.ok(report.summary.document_pages > 1 && report.summary.chunk_pages > 1,
    JSON.stringify(report.summary));
  const corpusStatements = statementTimings.filter(({ sql }) =>
    /WITH page AS MATERIALIZED/i.test(sql));
  assert.ok(corpusStatements.length > 2, "the paged report decision point was not reached");
  const slowestStatement = statementTimings.toSorted((a, b) => b.ms - a.ms)[0];
  const maxStatementMs = slowestStatement.ms;
  assert.ok(maxStatementMs <= 100,
    `${name} report statement took ${maxStatementMs.toFixed(3)} ms: ` +
      slowestStatement.sql.replace(/\s+/g, " ").slice(0, 240));
  return {
    component_ms: compactTimings(components),
    component_plans: Object.fromEntries(Object.entries(components)
      .map(([component, result]) => [component, result.plan])),
    bounded_plans: plans,
    hot_ms: Number(hotMs.toFixed(3)),
    source_count_ms: Number(sourceCountMs.toFixed(3)),
    report_statement_max_ms: Number(maxStatementMs.toFixed(3)),
    document_pages: report.summary.document_pages,
    chunk_pages: report.summary.chunk_pages,
  };
};

try {
  database.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY;");
  for (const name of migrationFiles.filter((file) => Number(file.slice(0, 4)) <= 46)) {
    applyMigration(name);
  }
  database.prepare(
    `INSERT INTO install_state
       (id,client_slug,product_version,schema_version,gate_version,installed_at,ring)
     VALUES (1,'synthetic','0.0.0',46,0,'2026-01-01T00:00:00.000Z','test')`,
  ).run();
  for (const row of database.prepare(
    `SELECT name FROM sqlite_master
      WHERE type='trigger' AND tbl_name IN ('documents','chunks','vector_outbox')`,
  ).all()) {
    database.exec(`DROP TRIGGER IF EXISTS "${String(row.name).replaceAll('"', '""')}"`);
  }

  const insertDocument = database.prepare(
    `INSERT INTO documents
       (doc_uid,source,source_id,title,ingested_at,content_hash,meta,deleted_at)
     VALUES (?,?,?,?,?,?,?,NULL)`,
  );
  const insertChunk = database.prepare(
    `INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,vector_id)
     VALUES (?,?,?,?,?,?)`,
  );
  const insertOutbox = database.prepare(
    `INSERT INTO vector_outbox (chunk_uid,vector_id,op,queued_at,attempts,last_error)
     VALUES (?,?,'upsert',1,0,NULL)`,
  );
  const metadataBase = { platform: "synthetic", padding: "p".repeat(300) };
  const body = "x".repeat(200);
  let chunkNumber = 0;
  database.exec("BEGIN");
  for (let documentNumber = 0; documentNumber < DOCUMENTS; documentNumber++) {
    const source = documentNumber < 5_001
      ? "drive"
      : SOURCES[documentNumber % SOURCES.length];
    const sourceId = `document-${String(documentNumber).padStart(6, "0")}`;
    const docUid = `${source}:${sourceId}`;
    let meta = metadataBase;
    if (documentNumber < 5_001) meta = { ...metadataBase, part_of: "large-family" };
    else if (documentNumber < 13_001) {
      meta = { ...metadataBase, part_of: `family-${Math.floor((documentNumber - 5_001) / 8)}` };
    }
    insertDocument.run(docUid, source, sourceId, `Synthetic ${documentNumber}`,
      1_750_000_000_000, String(documentNumber).padStart(64, "0"), JSON.stringify(meta));
    const count = documentNumber < 858 ? 11 : 12;
    for (let chunkIndex = 0; chunkIndex < count; chunkIndex++) {
      const chunkUid = `chunk-${String(chunkNumber++).padStart(7, "0")}`;
      insertChunk.run(chunkUid, docUid, chunkIndex, body, source, chunkUid);
      insertOutbox.run(chunkUid, chunkUid);
    }
  }
  database.exec("COMMIT");
  assert.equal(chunkNumber, CHUNKS);

  const register = database.prepare(
    "INSERT INTO corpus_stats (source,documents,chunks,last_ingest_at) VALUES (?,?,?,?)",
  );
  const inventory = database.prepare(
    "INSERT INTO document_source_inventory (source) VALUES (?)",
  );
  database.exec("BEGIN");
  for (const source of SOURCES) {
    const row = database.prepare(`
      SELECT COUNT(DISTINCT d.doc_uid) AS documents, COUNT(c.chunk_uid) AS chunks
        FROM documents d LEFT JOIN chunks c ON c.doc_uid=d.doc_uid
       WHERE d.source=? AND d.deleted_at IS NULL`).get(source);
    register.run(source, row.documents, row.chunks, 1_750_000_000_000);
    inventory.run(source);
  }
  database.exec("COMMIT");

  const normal = await runVariant("full-size");

  // Keep the same 1,151,274 chunk rows but concentrate them on 1,000 documents.
  // Each of those documents now owns more than one thousand chunks, which
  // catches a document-page design whose real work is secretly chunk-unbounded.
  database.exec("UPDATE chunks SET chunk_ix = id + 2000000");
  database.exec(`
    UPDATE chunks
       SET doc_uid = 'drive:document-' || printf('%06d', (id - 1) % 1000),
           chunk_ix = CAST((id - 1) / 1000 AS INTEGER)
  `);
  const skewed = await runVariant("skewed");

  console.log("documents summary full-size and skewed timing: 23 assertions passed");
  console.log(JSON.stringify({ documents: DOCUMENTS, chunks: CHUNKS, normal, skewed }));
} finally {
  database.close();
  rmSync(scratch, { recursive: true, force: true });
}
