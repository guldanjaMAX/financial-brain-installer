/**
 * Migrations, against a REAL SQLite database.
 *
 * This file exists because 0004 shipped broken and nothing noticed. The store
 * tests use hand-rolled `{DB:{prepare}}` mocks, so no test had ever executed a
 * migration file, and the splitter shredded the FTS5 triggers into invalid SQL.
 * A mock cannot catch that. Only running the SQL can.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cmdMigrate,
  PROVIDER_CONNECTOR_IDS,
  runRestartSafeMigrationStatements,
  splitStatements,
} from "../brain.mjs";
import worker from "../worker/src/index.js";
import {
  acquireDrainLease,
  bootstrapVectorProjectionPage,
  coverageGapReport,
  releaseDrainLease,
  resetVectorProjectionBootstrap,
  VECTOR_BOOTSTRAP_PAGE_SIZE,
} from "../worker/src/lib/store-d1.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "..", "migrations", "d1");
// The terminal schema version is whatever the newest migration file says, so
// adding 00NN never breaks a hardcoded pin here (found at 13 -> 14).
const LATEST_SCHEMA = Math.max(
  ...readdirSync(DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).map((f) => Number(f.slice(0, 4))),
);

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 300))); if (!c) fail++; };

/* ---- the splitter, on the shapes that actually broke ---- */
{
  const one = splitStatements("CREATE TABLE a (x INT); CREATE TABLE b (y INT);");
  check("plain DDL splits into two", one.length === 2, JSON.stringify(one));

  const trig = splitStatements(`
CREATE TRIGGER t AFTER INSERT ON a BEGIN
  INSERT INTO b(y) VALUES (new.x);
  INSERT INTO c(z) VALUES (new.x);
END;
CREATE TABLE d (w INT);`);
  check("a trigger with two body statements stays ONE statement", trig.length === 2, JSON.stringify(trig.map(t => t.slice(0, 40))));
  check("and it keeps its END", /END$/i.test(trig[0].trim()), trig[0]);
  check("the statement after the trigger survives", /CREATE TABLE d/i.test(trig[1]), trig[1]);

  const str = splitStatements("INSERT INTO a VALUES ('semi; colon'); SELECT 1;");
  check("a semicolon inside a string is not a boundary", str.length === 2, JSON.stringify(str));

  const esc = splitStatements("INSERT INTO a VALUES ('it''s; fine'); SELECT 2;");
  check("an escaped quote does not desync the scanner", esc.length === 2, JSON.stringify(esc));

  check("comments are stripped", !splitStatements("-- drop; everything\nSELECT 1;").join("").includes("drop"));

  // An unterminated trigger must surface, not vanish. Swallowing it would make a
  // broken migration look like it applied.
  check("an unterminated trigger is emitted, not dropped",
    splitStatements("CREATE TRIGGER t AFTER INSERT ON a BEGIN INSERT INTO b VALUES (1);").length === 1);
}

/* ---- every migration, applied for real, in order ---- */
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
check("migration files were found", files.length > 0, DIR);

const db = new DatabaseSync(":memory:");
let applied = 0;
for (const f of files) {
  const stmts = splitStatements(readFileSync(join(DIR, f), "utf-8"));
  for (const st of stmts) {
    try { db.exec(st); applied++; }
    catch (e) { check(`${f} applies cleanly`, false, `${e.message} :: ${st.slice(0, 120)}`); }
  }
}
check(`all ${applied} statements across ${files.length} files applied`, true);
db.prepare(
  `INSERT INTO install_state
     (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
   VALUES (1, 'fixture', '0.0.0', 12, 0, '2026-01-01T00:00:00Z', 'test')`,
).run();

/* ---- provenance assessment markers are new proof, never a legacy backfill ---- */
{
  const documentColumns = new Set(db.prepare("PRAGMA table_info(documents)").all().map((row) => row.name));
  check("0039 adds the complete provenance assessment marker",
    ["provenance_receipt_version", "provenance_receipt_status", "provenance_receipt_reason",
      "provenance_receipt_digest"].every((column) => documentColumns.has(column)));
  db.exec("SAVEPOINT provenance_marker_fixture");
  db.prepare(
    `INSERT INTO documents (doc_uid,source,source_id,ingested_at,content_hash,meta,text_source,text_reliable)
     VALUES ('marker:test','marker','test',1,'fixture-hash','{}','native',1)`,
  ).run();
  const legacy = db.prepare(
    `SELECT provenance_receipt_version,provenance_receipt_status,
            provenance_receipt_reason,provenance_receipt_digest
       FROM documents WHERE doc_uid='marker:test'`,
  ).get();
  check("0039 leaves a legacy native/1 row explicitly unassessed",
    Object.values(legacy).every((value) => value === null), JSON.stringify(legacy));
  db.prepare(
    `UPDATE documents
        SET provenance_receipt_version=1,
            provenance_receipt_status='partial',
            provenance_receipt_reason='lineage_unavailable',
            provenance_receipt_digest=?
      WHERE doc_uid='marker:test'`,
  ).run("a".repeat(64));
  db.prepare("UPDATE documents SET text_source='ocr' WHERE doc_uid='marker:test'").run();
  const invalidated = db.prepare(
    `SELECT provenance_receipt_version,provenance_receipt_status,
            provenance_receipt_reason,provenance_receipt_digest
       FROM documents WHERE doc_uid='marker:test'`,
  ).get();
  check("0039 invalidates a marker when low-level provenance changes without a matching marker",
    Object.values(invalidated).every((value) => value === null), JSON.stringify(invalidated));
  db.exec("ROLLBACK TO provenance_marker_fixture");
  db.exec("RELEASE provenance_marker_fixture");
}

/* ---- a populated schema-36 sync history survives every later additive migration ---- */
{
  const schema36 = new DatabaseSync(":memory:");
  for (const file of files.filter((name) => Number(name.slice(0, 4)) <= 36)) {
    for (const statement of splitStatements(readFileSync(join(DIR, file), "utf-8"))) schema36.exec(statement);
  }
  schema36.prepare(
    `INSERT INTO sync_runs
       (run_id,source,lane,started_at,finished_at,walk_complete,files_seen,
        docs_added,docs_updated,docs_unchanged,proposed_deletes,delete_action,refusal_reason,error)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run("schema36_run", "drive", "sweep", 10, 20, 1, 7, 2, 3, 2, 0, "applied", null, null);
  for (const file of files.filter((name) => Number(name.slice(0, 4)) > 36)) {
    for (const statement of splitStatements(readFileSync(join(DIR, file), "utf-8"))) schema36.exec(statement);
  }
  const upgradedRun = schema36.prepare(
    `SELECT run_id,files_seen,docs_added,docs_updated,docs_unchanged,
            docs_refused,docs_failed,metrics_version,
            confirmed_from,confirmed_through,target_from,target_through
       FROM sync_runs WHERE run_id='schema36_run'`,
  ).get();
  check("a populated schema-36 sync run survives the coverage telemetry migration",
    upgradedRun?.run_id === "schema36_run" && upgradedRun.files_seen === 7 &&
      upgradedRun.docs_added === 2 && upgradedRun.docs_updated === 3 && upgradedRun.docs_unchanged === 2,
    JSON.stringify(upgradedRun));
  check("legacy refusal counts remain explicitly unmeasured after upgrade",
    upgradedRun?.docs_refused === 0 && upgradedRun?.docs_failed === 0 && upgradedRun?.metrics_version === 0 &&
      upgradedRun?.confirmed_from === null && upgradedRun?.confirmed_through === null &&
      upgradedRun?.target_from === null && upgradedRun?.target_through === null,
    JSON.stringify(upgradedRun));
  schema36.close();
}

/* ---- the objects the worker hard-depends on must exist ---- */
const names = new Set(db.prepare("SELECT name FROM sqlite_master").all().map((r) => r.name));
for (const t of [
  "documents",
  "document_source_inventory",
  "chunks",
  "chunks_fts",
  "vector_outbox",
  "vector_bootstrap_batches",
  "corpus_stats",
  "schema_migrations",
  "install_state",
  "source_original_id_key_state",
  "source_original_observations",
  "source_original_result_bindings",
  "source_original_result_family_members",
  "source_original_result_family_receipts",
  "source_original_result_family_verifications",
  "source_original_result_family_recovery_state",
  "source_original_accepted_resolution_admissions",
  "source_original_accepted_resolutions",
  "source_original_accepted_resolution_activations",
]) {
  check(`${t} exists`, names.has(t), [...names].join(", "));
}
{
  const documentColumns = new Set(db.prepare("PRAGMA table_info(documents)").all().map((row) => row.name));
  check("0043 adds nullable document revision and raw-original binding pointers",
    documentColumns.has("document_revision_id") && documentColumns.has("source_original_binding_hash"));
}
{
  const chunkColumns = new Set(db.prepare("PRAGMA table_info(chunks)").all().map((row) => row.name));
  check("0044 adds nullable exact revision and stored-chunk receipt pointers",
    chunkColumns.has("bound_document_revision_id") && chunkColumns.has("result_chunk_receipt_hash"));
}
{
  const installColumns = new Set(db.prepare("PRAGMA table_info(install_state)").all().map((row) => row.name));
  const verificationColumns = new Set(db.prepare(
    "PRAGMA table_info(source_original_result_family_verifications)",
  ).all().map((row) => row.name));
  check("0045 adds deployment-local full-result retrieval generations",
    installColumns.has("source_original_retrieval_generation") &&
      verificationColumns.has("retrieval_generation"));
}
{
  const observationColumns = new Set(db.prepare(
    "PRAGMA table_info(source_original_observations)",
  ).all().map((row) => row.name));
  check("0046 adds append-only per-original authority predecessor bindings",
    observationColumns.has("authority_chain_version") &&
      observationColumns.has("predecessor_observation_hash"));
}
for (const object of [
  "idx_source_original_result_family_members_revision",
  "idx_source_original_result_family_receipts_original_sequence",
  "idx_source_original_result_family_verifications_family_sequence",
  "chunks_source_original_receipt_insert",
  "chunks_source_original_receipt_update",
  "chunks_source_original_receipt_no_stale_update",
  "chunks_source_original_receipt_no_stale_replace",
  "source_original_result_family_recovery_state_validate_insert",
  "source_original_result_family_member_no_duplicate_insert",
  "source_original_result_family_member_after_seal_insert",
  "source_original_result_family_member_no_update",
  "source_original_result_family_member_no_sealed_delete",
  "source_original_result_family_receipt_no_duplicate_insert",
  "source_original_result_family_receipt_validate_insert",
  "source_original_result_family_receipt_no_update",
  "source_original_result_family_receipt_no_delete",
  "source_original_result_family_verification_no_duplicate_insert",
  "source_original_result_family_verification_validate_insert",
  "source_original_result_family_verification_no_update",
  "source_original_result_family_verification_no_delete",
  "idx_source_original_accepted_resolutions_original_sequence",
  "idx_source_original_accepted_resolution_activations_resolution_sequence",
  "source_original_current_result_family_verifications",
  "source_original_current_accepted_resolutions",
  "source_original_result_family_verification_recovery_block",
  "source_original_result_family_verification_retrieval_generation_validate",
  "source_original_retrieval_generation_no_reset_update",
  "source_original_retrieval_generation_no_replace_insert",
  "source_original_retrieval_generation_no_singleton_delete",
  "source_original_retrieval_generation_documents_ai",
  "source_original_retrieval_generation_documents_ad",
  "source_original_retrieval_generation_documents_au",
  "source_original_retrieval_generation_chunks_ai",
  "source_original_retrieval_generation_chunks_ad",
  "source_original_retrieval_generation_chunks_au",
  "source_original_retrieval_generation_sources_ai",
  "source_original_retrieval_generation_sources_ad",
  "source_original_retrieval_generation_sources_au",
  "source_original_retrieval_generation_memory_ai",
  "source_original_retrieval_generation_memory_ad",
  "source_original_retrieval_generation_memory_au",
  "chunks_source_original_sealed_receipt_no_revival_update",
  "chunks_source_original_sealed_receipt_no_revival_insert",
  "documents_source_original_sealed_evidence_no_revival_update",
  "documents_source_original_sealed_evidence_no_revival_insert",
  "source_original_accepted_resolution_no_duplicate_insert",
  "source_original_accepted_resolution_requires_admission",
  "source_original_accepted_resolution_validate_recovery_insert",
  "source_original_accepted_resolution_no_update",
  "source_original_accepted_resolution_no_delete",
  "source_original_accepted_resolution_activation_no_duplicate_insert",
  "source_original_accepted_resolution_activation_validate_insert",
  "source_original_accepted_resolution_activation_no_update",
  "source_original_accepted_resolution_activation_no_delete",
  "source_original_accepted_resolution_admission_validate_insert",
  "source_original_accepted_resolution_admission_no_update",
  "source_original_accepted_resolution_admission_commit",
  "source_original_accepted_resolution_recovery_close_validate",
  "source_original_accepted_resolution_recovery_state_validate_insert",
  "source_original_observation_accepted_admission_required",
  "idx_source_original_observation_authority_predecessor",
  "source_original_observation_authority_head_insert",
  "source_original_accepted_resolution_authority_head_insert",
  "source_original_observation_authority_recovery_close_validate",
]) {
  check(`${object} exists`, names.has(object));
}
{
  const currentAcceptedSql = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='view' AND name='source_original_current_accepted_resolutions'",
  ).get()?.sql || "";
  const admissionCommitSql = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='source_original_accepted_resolution_admission_commit'",
  ).get()?.sql || "";
  check("0046 current accepted authority joins observations inside the tenant",
    /accepted\.tenant_id\s*=\s*resolution\.tenant_id/i.test(currentAcceptedSql));
  check("0046 accepted observation replay lookup remains inside the tenant",
    /accepted\.tenant_id\s*=\s*NEW\.tenant_id/i.test(admissionCommitSql));
}
for (const t of ["chunks_ai", "chunks_ad", "chunks_au"]) {
  check(`trigger ${t} exists`, names.has(t), "MISSING — keyword search would silently return nothing forever");
}

for (const table of ["documents", "chunks"]) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
  for (const column of ["client", "category", "top_folder", "platform", "document_date"]) {
    check(`${table}.${column} exists for the retrieval filter contract`, columns.has(column), [...columns].join(", "));
  }
}
for (const index of ["idx_chunks_category", "idx_chunks_top_folder", "idx_chunks_platform"]) {
  check(`${index} exists`, names.has(index), "filtered hydration would otherwise scan the chunk table");
}
check("idx_documents_live_content_hash exists",
  names.has("idx_documents_live_content_hash"),
  "exact duplicate diagnosis would otherwise group an unindexed document table");
check("idx_vector_outbox_generation exists",
  names.has("idx_vector_outbox_generation"),
  "the durable generation clock must not scan an entire replay backlog per enqueue");
check("vector_outbox retains vector_id after a chunk row is gone",
  new Set(db.prepare("PRAGMA table_info(vector_outbox)").all().map((r) => r.name)).has("vector_id"));
check("vector_outbox has a durable drain CAS generation",
  new Set(db.prepare("PRAGMA table_info(vector_outbox)").all().map((r) => r.name)).has("generation"));
{
  const outboxColumns = new Set(db.prepare("PRAGMA table_info(vector_outbox)").all().map((r) => r.name));
  check("vector_outbox retains an accepted async mutation receipt",
    outboxColumns.has("submitted_mutation_id") && outboxColumns.has("submitted_at"));
  check("vector_outbox can join an exact row generation to one bootstrap batch",
    outboxColumns.has("bootstrap_epoch") && outboxColumns.has("bootstrap_batch"));
}
check("install_state owns the monotonic outbox clock",
  new Set(db.prepare("PRAGMA table_info(install_state)").all().map((r) => r.name)).has("outbox_generation"));
{
  const installColumns = new Set(db.prepare("PRAGMA table_info(install_state)").all().map((r) => r.name));
  check("install_state has an exclusive vector drain owner",
    installColumns.has("vector_drain_lease_owner"));
  check("the vector drain owner has a bounded crash expiry",
    installColumns.has("vector_drain_lease_expires_at"));
  check("install_state owns the latest Vectorize processing fence",
    installColumns.has("vector_projection_mutation_id") &&
      installColumns.has("vector_projection_submitted_at"));
  check("install_state owns the accelerated bootstrap protocol and verified base",
    installColumns.has("vector_projection_bootstrap_protocol") &&
      installColumns.has("vector_projection_bootstrap_base_count"));
}
for (const trigger of ["vector_outbox_generation_ai", "vector_outbox_generation_au"]) {
  check(`trigger ${trigger} exists`, names.has(trigger), "outbox generations could reuse a stale drain token");
}

for (const trigger of [
  "documents_source_inventory_ai",
  "documents_source_inventory_ad",
  "documents_source_inventory_remove_au",
  "documents_source_inventory_add_au",
]) {
  check(`trigger ${trigger} exists`, names.has(trigger), "answer coverage could miss an unregistered source");
}

/* The hot answer check must scale with source namespaces, not corpus rows. */
{
  let coverageSql = null;
  await coverageGapReport({ DB: { prepare(sql) {
    coverageSql = sql;
    return { all: async () => ({ results: [] }) };
  } } });
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${coverageSql}`).all().map((row) => row.detail);
  check("answer coverage reads the materialized source inventory instead of scanning live documents",
    plan.some((detail) => /SCAN source_inventory/.test(detail)) &&
      !plan.some((detail) => /SCAN d(?: |$)/.test(detail) || /documents/.test(detail)),
    JSON.stringify(plan));
}

/* Every document lifecycle transition keeps that inventory exact. */
{
  const add = db.prepare(
    `INSERT INTO documents (doc_uid,source,source_id,ingested_at,content_hash,deleted_at)
     VALUES (?,?,?,?,?,?)`,
  );
  add.run("inventory:a-live", "inventory-a", "a-live", 1, "inventory-a-live", null);
  add.run("inventory:a-restorable", "inventory-a", "a-restorable", 1, "inventory-a-restorable", 1);
  check("inventory ignores an inserted tombstone",
    db.prepare("SELECT count(*) n FROM document_source_inventory WHERE source='inventory-a'").get()?.n === 1);

  db.prepare("UPDATE documents SET deleted_at=NULL WHERE doc_uid='inventory:a-restorable'").run();
  check("inventory retains one source row when a document is restored",
    db.prepare("SELECT count(*) n FROM document_source_inventory WHERE source='inventory-a'").get()?.n === 1);

  db.prepare("UPDATE documents SET source='inventory-b' WHERE doc_uid='inventory:a-restorable'").run();
  const moved = db.prepare(
    "SELECT source FROM document_source_inventory WHERE source LIKE 'inventory-%' ORDER BY source",
  ).all();
  check("inventory records both live source namespaces after a document moves",
    JSON.stringify(moved) === JSON.stringify([
      { source: "inventory-a" },
      { source: "inventory-b" },
    ]), JSON.stringify(moved));

  const sqliteEnv = { DB: { prepare(sql) {
    const statement = db.prepare(sql);
    return { all: async () => ({ results: statement.all() }) };
  } } };
  const report = await coverageGapReport(sqliteEnv);
  check("the real coverage query still detects each unregistered live source",
    report.gaps.some((gap) => gap.type === "source_unregistered" && gap.source === "inventory-a") &&
      report.gaps.some((gap) => gap.type === "source_unregistered" && gap.source === "inventory-b"),
    JSON.stringify(report));

  db.prepare("UPDATE documents SET deleted_at=2 WHERE doc_uid='inventory:a-live'").run();
  db.prepare("DELETE FROM documents WHERE doc_uid='inventory:a-restorable'").run();
  db.prepare("DELETE FROM documents WHERE doc_uid='inventory:a-live'").run();
  check("inventory removes empty source namespaces after soft and physical deletion",
    db.prepare("SELECT count(*) n FROM document_source_inventory WHERE source LIKE 'inventory-%'").get()?.n === 0);
}

/* queued_at is allowed to collide; the database-owned generation is not. */
{
  db.prepare(
    `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
     VALUES ('race#0', 'race#0', 'upsert', 1000)`
  ).run();
  const firstGeneration = db.prepare(
    "SELECT generation FROM vector_outbox WHERE chunk_uid = 'race#0'"
  ).get().generation;
  db.prepare(
    `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
     VALUES ('race#0', 'race#0', 'upsert', 1000)
     ON CONFLICT(chunk_uid) DO UPDATE SET
       vector_id=excluded.vector_id, op=excluded.op, queued_at=excluded.queued_at`
  ).run();
  const secondGeneration = db.prepare(
    "SELECT generation FROM vector_outbox WHERE chunk_uid = 'race#0'"
  ).get().generation;
  check("same-millisecond requeues receive a strictly newer generation",
    secondGeneration > firstGeneration, `${firstGeneration} -> ${secondGeneration}`);
  const staleDelete = db.prepare(
    "DELETE FROM vector_outbox WHERE chunk_uid = 'race#0' AND generation = ?"
  ).run(firstGeneration);
  check("a stale generation cannot clear the newly queued row",
    staleDelete.changes === 0 && db.prepare("SELECT count(*) n FROM vector_outbox WHERE chunk_uid = 'race#0'").get().n === 1);
  db.prepare("DELETE FROM vector_outbox WHERE chunk_uid = 'race#0'").run();
}

/* ---- real upgrade path: an existing backlog crosses 0009 -> 0012 ---- */
{
  const upgraded = new DatabaseSync(":memory:");
  for (const file of files.filter((name) => name < "0010_")) {
    for (const statement of splitStatements(readFileSync(join(DIR, file), "utf-8"))) {
      upgraded.exec(statement);
    }
  }
  upgraded.exec(
    `INSERT INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1, 'upgrade-fixture', '0.1.14', 9, 0, '2026-01-01T00:00:00Z', 'test');
     INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at, attempts, last_error)
     VALUES ('legacy#0', 'legacy#0', 'upsert', 1234, 2, 'retry me');`
  );
  for (const file of [
    "0010_vector_outbox_generation.sql",
    "0011_vector_drain_lease.sql",
    "0012_vector_visibility_receipts.sql",
  ]) {
    for (const statement of splitStatements(readFileSync(join(DIR, file), "utf-8"))) {
      upgraded.exec(statement);
    }
  }
  upgraded.prepare("UPDATE install_state SET schema_version = 12 WHERE id = 1").run();

  const oldQueue = upgraded.prepare(
    `SELECT generation, attempts, last_error, submitted_mutation_id, submitted_at
       FROM vector_outbox WHERE chunk_uid = 'legacy#0'`
  ).get();
  const upgradedState = upgraded.prepare(
    `SELECT schema_version, outbox_generation,
            vector_drain_lease_owner owner, vector_drain_lease_expires_at expires,
            vector_projection_mutation_id mutation_id,
            vector_projection_submitted_at mutation_submitted_at
     FROM install_state WHERE id = 1`
  ).get();
  check("the real upgrade backfills a stable generation without losing retry state",
    oldQueue.generation > 0 && oldQueue.attempts === 2 && oldQueue.last_error === "retry me" &&
      oldQueue.submitted_mutation_id === null && oldQueue.submitted_at === null,
    JSON.stringify(oldQueue));
  check("the real upgrade starts with an unlocked lease and aligned generation clock",
    upgradedState.schema_version === 12 && upgradedState.outbox_generation >= oldQueue.generation &&
      upgradedState.owner === null && upgradedState.expires === null &&
      upgradedState.mutation_id === null && upgradedState.mutation_submitted_at === null,
    JSON.stringify(upgradedState));

  const upgradedEnv = {
    DB: {
      prepare(sql) {
        const shape = (params = []) => ({
          bind: (...next) => shape(next),
          run: async () => {
            const result = upgraded.prepare(sql).run(...params);
            return { meta: { changes: Number(result.changes || 0) } };
          },
          first: async () => upgraded.prepare(sql).get(...params) ?? null,
        });
        return shape();
      },
    },
  };
  const lease = await acquireDrainLease(upgradedEnv, {
    ownerToken: "upgraded-worker", now: 50_000, ttlMs: 5_000,
  });
  check("the deployed lease code operates against the actually upgraded schema",
    lease.acquired === true && await releaseDrainLease(upgradedEnv, "upgraded-worker") === true);
}

/* ---- 0010-0013 resume after every independently committed statement ---- */
{
  const restartStatements = [
    ...splitStatements(readFileSync(join(DIR, "0010_vector_outbox_generation.sql"), "utf-8")),
    ...splitStatements(readFileSync(join(DIR, "0011_vector_drain_lease.sql"), "utf-8")),
    ...splitStatements(readFileSync(join(DIR, "0012_vector_visibility_receipts.sql"), "utf-8")),
    ...splitStatements(readFileSync(join(DIR, "0013_accelerated_vector_bootstrap.sql"), "utf-8")),
  ];
  const makeLegacy = () => {
    const candidate = new DatabaseSync(":memory:");
    for (const file of files.filter((name) => name < "0010_")) {
      for (const statement of splitStatements(readFileSync(join(DIR, file), "utf-8"))) {
        candidate.exec(statement);
      }
    }
    candidate.exec(
      `INSERT INTO install_state
         (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
       VALUES (1, 'restart-fixture', '0.1.14', 9, 0, '2026-01-01T00:00:00Z', 'test');
       INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at, attempts, last_error)
       VALUES ('restart#0', 'restart#0', 'upsert', 1234, 3, 'preserve me');`,
    );
    return candidate;
  };
  const queryFor = (candidate) => async (sql) => {
    if (/^PRAGMA\s+table_info/i.test(sql)) {
      return { results: candidate.prepare(sql).all() };
    }
    candidate.exec(sql);
    return { results: [] };
  };

  let everyResumePassed = true;
  let resumeDetail = "";
  for (let faultAfter = 0; faultAfter < restartStatements.length; faultAfter++) {
    const candidate = makeLegacy();
    const query = queryFor(candidate);
    try {
      await runRestartSafeMigrationStatements(restartStatements, query, {
        afterStatement: ({ index }) => {
          if (index === faultAfter) throw new Error(`synthetic crash after ${index}`);
        },
      });
    } catch (error) {
      if (!/synthetic crash/.test(error.message)) {
        everyResumePassed = false;
        resumeDetail = `fault ${faultAfter}: ${error.message}`;
      }
    }
    try {
      await runRestartSafeMigrationStatements(restartStatements, query);
      const state = candidate.prepare(
        `SELECT outbox_generation,
                vector_drain_lease_owner owner,
                vector_drain_lease_expires_at expires,
                vector_projection_mutation_id mutation_id,
                vector_projection_submitted_at mutation_submitted_at,
                vector_projection_bootstrap_protocol bootstrap_protocol,
                vector_projection_bootstrap_base_count bootstrap_base_count
         FROM install_state WHERE id = 1`,
      ).get();
      const queue = candidate.prepare(
        `SELECT generation, attempts, last_error, submitted_mutation_id, submitted_at,
                bootstrap_epoch, bootstrap_batch FROM vector_outbox
         WHERE chunk_uid = 'restart#0'`,
      ).get();
      const objects = new Set(candidate.prepare("SELECT name FROM sqlite_master").all().map((row) => row.name));
      if (!(queue.generation > 0 && queue.attempts === 3 && queue.last_error === "preserve me" &&
            state.outbox_generation >= queue.generation && state.owner === null && state.expires === null &&
            state.mutation_id === null && state.mutation_submitted_at === null &&
            state.bootstrap_protocol === null && state.bootstrap_base_count === 0 &&
            queue.submitted_mutation_id === null && queue.submitted_at === null &&
            queue.bootstrap_epoch === null && queue.bootstrap_batch === null &&
            objects.has("vector_bootstrap_batches") &&
            objects.has("vector_outbox_generation_ai") && objects.has("vector_outbox_generation_au"))) {
        everyResumePassed = false;
        resumeDetail = `fault ${faultAfter}: ${JSON.stringify({ state, queue, objects: [...objects] })}`;
      }
    } catch (error) {
      everyResumePassed = false;
      resumeDetail = `fault ${faultAfter} resume: ${error.message}`;
    }
    candidate.close();
    if (!everyResumePassed) break;
  }
  check("0010-0013 resume safely after every independently committed statement",
    everyResumePassed, resumeDetail);

  const incompatible = makeLegacy();
  incompatible.exec("ALTER TABLE install_state ADD COLUMN vector_drain_lease_owner INTEGER");
  let refused = null;
  try {
    await runRestartSafeMigrationStatements(restartStatements, queryFor(incompatible));
  } catch (error) { refused = error; }
check("restart guard refuses an existing migration column with the wrong contract",
    /incompatible schema/.test(refused?.message || ""), refused?.message);
  incompatible.close();
}

/* ---- 0013 adopts only a quiescent schema-12 verified cut ---- */
{
  const makeVerified12 = ({ pending = false } = {}) => {
    const candidate = new DatabaseSync(":memory:");
    for (const file of files.filter((name) => name < "0013_")) {
      for (const statement of splitStatements(readFileSync(join(DIR, file), "utf-8"))) {
        candidate.exec(statement);
      }
    }
    candidate.exec(
      `INSERT INTO install_state
         (id,client_slug,product_version,schema_version,gate_version,installed_at,ring,
          vector_projection_status,vector_projection_bootstrap_epoch,
          vector_projection_bootstrap_cursor,vector_projection_bootstrap_high_water)
       VALUES (1,'verified-12','0.1.14',12,0,'2026-01-01T00:00:00Z','test',
               'verified',1,'legacy:verified#0','legacy:verified#0');
       INSERT INTO documents (doc_uid,source,source_id,title,ingested_at,content_hash)
       VALUES ('legacy:verified','legacy','verified','Verified',1,'verified-hash');
       INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title,vector_id)
       VALUES ('legacy:verified#0','legacy:verified',0,'verified text','legacy','Verified','legacy:verified#0');`,
    );
    if (pending) {
      candidate.exec(
        `INSERT INTO vector_outbox (chunk_uid,vector_id,op,queued_at)
         VALUES ('legacy:pending-delete','legacy:pending-delete','delete',2);
         UPDATE install_state SET vector_projection_status='verified' WHERE id=1;`,
      );
    }
    for (const statement of splitStatements(
      readFileSync(join(DIR, "0013_accelerated_vector_bootstrap.sql"), "utf-8"),
    )) candidate.exec(statement);
    candidate.prepare("UPDATE install_state SET schema_version=13 WHERE id=1").run();
    return candidate;
  };

  const quiescent = makeVerified12();
  const adopted = quiescent.prepare(
    `SELECT vector_projection_bootstrap_protocol protocol,
            vector_projection_bootstrap_base_count base_count
       FROM install_state WHERE id=1`,
  ).get();
  check("0013 adopts an already exact schema-12 projection without re-embedding",
    adopted.protocol === "bootstrap-v2" && adopted.base_count === 1,
    JSON.stringify(adopted));
  quiescent.close();

  const pending = makeVerified12({ pending: true });
  const deferred = pending.prepare(
    `SELECT vector_projection_bootstrap_protocol protocol,
            vector_projection_bootstrap_base_count base_count,
            (SELECT count(*) FROM vector_outbox) pending
       FROM install_state WHERE id=1`,
  ).get();
  check("0013 defers adoption while an older outbox receipt still needs confirmation",
    deferred.protocol === null && deferred.base_count === 1 && deferred.pending === 1,
    JSON.stringify(deferred));
  pending.close();
}

/* ---- 0012 bootstraps large legacy corpora in bounded resumable pages ---- */
{
  const candidate = new DatabaseSync(":memory:");
  for (const file of files.filter((name) => name < "0012_")) {
    for (const statement of splitStatements(readFileSync(join(DIR, file), "utf-8"))) {
      candidate.exec(statement);
    }
  }
  candidate.exec(
    `INSERT INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1, 'bootstrap-fixture', '0.1.14', 11, 0, '2026-01-01T00:00:00Z', 'test');
     INSERT INTO documents (doc_uid,source,source_id,title,ingested_at,content_hash)
     VALUES ('legacy:bootstrap','legacy','bootstrap','Bootstrap',1,'legacy-bootstrap-hash');`,
  );
  const insertChunk = candidate.prepare(
    `INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title)
     VALUES (?,?,?,?,?,?)`,
  );
  for (let index = 0; index < 201; index++) {
    const uid = `legacy:bootstrap#${String(index).padStart(4, "0")}`;
    insertChunk.run(uid, "legacy:bootstrap", index, `legacy text ${index}`, "legacy", "Bootstrap");
  }
  const migration12 = splitStatements(
    readFileSync(join(DIR, "0012_vector_visibility_receipts.sql"), "utf-8"),
  );
  for (const statement of migration12) candidate.exec(statement);
  candidate.prepare("UPDATE install_state SET schema_version=12 WHERE id=1").run();
  const migrated = candidate.prepare(
    `SELECT vector_projection_status status,
            vector_projection_bootstrap_epoch epoch,
            vector_projection_bootstrap_cursor cursor,
            vector_projection_bootstrap_high_water high_water,
            (SELECT count(*) FROM vector_outbox) pending
       FROM install_state WHERE id=1`,
  ).get();
  check("0012 marks a legacy corpus unverified without materializing its queue",
    migrated.status === "bootstrap_required" && migrated.epoch === 1 &&
      migrated.cursor === null && migrated.high_water === "legacy:bootstrap#0200" &&
      migrated.pending === 0,
    JSON.stringify(migrated));
  check("0012 migration has no trigger-amplified corpus INSERT",
    migration12.every((statement) =>
      !/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+vector_outbox/i.test(statement)),
    migration12.join("\n"));

  const observed = { maxBinds: 0, batchWidths: [] };
  const prepare = (sql) => {
    const shape = (params = []) => ({
      bind: (...next) => shape(next),
      all: async () => ({ results: candidate.prepare(sql).all(...params) }),
      first: async () => candidate.prepare(sql).get(...params) ?? null,
      run: async () => {
        const result = candidate.prepare(sql).run(...params);
        return { meta: { changes: Number(result.changes || 0) } };
      },
      _sql: sql,
      _params: params,
    });
    return shape();
  };
  const env = {
    DB: {
      prepare,
      batch: async (statements) => {
        observed.batchWidths.push(statements.length);
        observed.maxBinds = Math.max(observed.maxBinds,
          ...statements.map((statement) => statement._params.length));
        candidate.exec("BEGIN");
        try {
          const results = statements.map((statement) => {
            const result = candidate.prepare(statement._sql).run(...statement._params);
            return { meta: { changes: Number(result.changes || 0) } };
          });
          candidate.exec("COMMIT");
          return results;
        } catch (error) {
          candidate.exec("ROLLBACK");
          throw error;
        }
      },
    },
  };
  const pages = [];
  let durableResume = null;
  for (;;) {
    const page = await bootstrapVectorProjectionPage(env, { now: 1_000 + pages.length });
    pages.push(page.page_chunks);
    if (pages.length === 1) {
      const beforeResume = candidate.prepare(
        `SELECT vector_projection_bootstrap_epoch epoch,
                vector_projection_bootstrap_cursor cursor
           FROM install_state WHERE id=1`,
      ).get();
      const receipt = await resetVectorProjectionBootstrap(env);
      const afterResume = candidate.prepare(
        `SELECT vector_projection_bootstrap_epoch epoch,
                vector_projection_bootstrap_cursor cursor
           FROM install_state WHERE id=1`,
      ).get();
      durableResume = { beforeResume, receipt, afterResume };
    }
    const queued = candidate.prepare("SELECT count(*) n FROM vector_outbox").get().n;
    if (queued > VECTOR_BOOTSTRAP_PAGE_SIZE) throw new Error(`bootstrap queue exceeded cap: ${queued}`);
    candidate.prepare("DELETE FROM vector_outbox").run();
    if (page.complete) break;
  }
  const finished = candidate.prepare(
    `SELECT vector_projection_status status,
            vector_projection_bootstrap_cursor cursor,
            vector_projection_bootstrap_high_water high_water
       FROM install_state WHERE id=1`,
  ).get();
  check("201 legacy chunks resume as exact 99/99/3 pages with no transient full queue",
    JSON.stringify(pages) === JSON.stringify([99, 99, 3]) &&
      finished.status === "pending" && finished.cursor === finished.high_water,
    JSON.stringify({ pages, finished }));
  check("re-running whole-corpus reindex preserves a progressed bootstrap epoch and cursor",
    durableResume?.receipt?.resumed === true &&
      durableResume.beforeResume.epoch === durableResume.afterResume.epoch &&
      durableResume.beforeResume.cursor === durableResume.afterResume.cursor,
    JSON.stringify(durableResume));
  check("a full bootstrap page respects the shared 100-bind D1 ceiling",
    observed.maxBinds === 100 && observed.batchWidths.every((width) => width <= 2),
    JSON.stringify(observed));
  check("a synthetic million-chunk projection has a finite resumable page plan",
    Math.ceil(1_000_000 / VECTOR_BOOTSTRAP_PAGE_SIZE) === 10_102,
    String(Math.ceil(1_000_000 / VECTOR_BOOTSTRAP_PAGE_SIZE)));
  candidate.close();
}

/* ---- the actual command resumes SQL, receipts, and final install-state seed ---- */
{
  const sandbox = mkdtempSync(join(tmpdir(), "brain-migrate-restart-"));
  const manifestPath = join(sandbox, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    client: { slug: "restart-fixture" },
    brain: { version: "0.1.14", ring: "test" },
    infrastructure: { cloudflare: {
      account_id: "fixture-account",
      d1_database_id: "fixture-database",
      storage: "d1",
    } },
    safety: { credential_scanner: { gate_version: 0 } },
  }));

  const makeCommandLegacy = () => {
    const candidate = new DatabaseSync(":memory:");
    for (const file of files.filter((name) => name < "0010_")) {
      const sql = readFileSync(join(DIR, file), "utf8");
      for (const statement of splitStatements(sql)) candidate.exec(statement);
      candidate.prepare(
        `INSERT INTO schema_migrations (version,name,applied_at,checksum)
         VALUES (?,?,?,?)`,
      ).run(
        Number.parseInt(file.split("_")[0], 10),
        file.replace(/\.sql$/, ""),
        "2026-01-01T00:00:00Z",
        createHash("sha256").update(sql).digest("hex").slice(0, 16),
      );
    }
    candidate.exec(
      `INSERT INTO install_state
         (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
       VALUES (1, 'restart-fixture', '0.1.14', 9, 0, '2026-01-01T00:00:00Z', 'test');
       INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at, attempts, last_error)
       VALUES ('command-legacy#0', 'command-legacy#0', 'upsert', 1234, 4, 'keep retry');`,
    );
    return candidate;
  };

  const adapterFor = (candidate, fault = { after: null, mutations: 0 }) =>
    async (_account, _database, sql, params = []) => {
      const text = String(sql).trim();
      if (/^(?:SELECT|PRAGMA)\b/i.test(text)) {
        return { results: candidate.prepare(sql).all(...params) };
      }
      let result = null;
      if (params.length) result = candidate.prepare(sql).run(...params);
      else candidate.exec(sql);
      fault.mutations++;
      if (fault.after === fault.mutations) {
        throw new Error(`synthetic committed migration crash ${fault.after}`);
      }
      return { results: [], meta: { changes: Number(result?.changes || 0) } };
    };

  // Count the exact mutating boundaries exercised by cmdMigrate: both SQL
  // files, both schema_migrations receipts, and the final install_state seed.
  const probe = makeCommandLegacy();
  const probeFault = { after: null, mutations: 0 };
  await cmdMigrate(manifestPath, {
    silent: true,
    resolveAccount: async () => ({ id: "fixture-account" }),
    d1Query: adapterFor(probe, probeFault),
    vectorDrainQuiesced: true,
  });
  const commandMutationCount = probeFault.mutations;
  probe.close();

  let commandResumePassed = commandMutationCount > 0;
  let commandResumeDetail = `mutations=${commandMutationCount}`;
  for (let faultAfter = 1; faultAfter <= commandMutationCount && commandResumePassed; faultAfter++) {
    const candidate = makeCommandLegacy();
    const fault = { after: faultAfter, mutations: 0 };
    try {
      await cmdMigrate(manifestPath, {
        silent: true,
        resolveAccount: async () => ({ id: "fixture-account" }),
        d1Query: adapterFor(candidate, fault),
        vectorDrainQuiesced: true,
      });
      commandResumePassed = false;
      commandResumeDetail = `fault ${faultAfter} did not interrupt`;
    } catch (error) {
      if (!/synthetic committed migration crash/.test(error.message)) {
        commandResumePassed = false;
        commandResumeDetail = `fault ${faultAfter}: ${error.message}`;
      }
    }

    let interveningGeneration = null;
    const generationTrigger = candidate.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name='vector_outbox_generation_ai'",
    ).get();
    if (generationTrigger) {
      candidate.prepare(
        `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
         VALUES ('intervening#0', 'intervening#0', 'upsert', 9999)`,
      ).run();
      interveningGeneration = candidate.prepare(
        "SELECT generation FROM vector_outbox WHERE chunk_uid='intervening#0'",
      ).get().generation;
    }

    try {
      await cmdMigrate(manifestPath, {
        silent: true,
        resolveAccount: async () => ({ id: "fixture-account" }),
        d1Query: adapterFor(candidate),
        vectorDrainQuiesced: true,
      });
      const state = candidate.prepare(
        `SELECT schema_version, outbox_generation,
                vector_drain_lease_owner owner,
                vector_drain_lease_expires_at expires,
                vector_projection_mutation_id mutation_id,
                vector_projection_submitted_at mutation_submitted_at
         FROM install_state WHERE id=1`,
      ).get();
      const queue = candidate.prepare(
        `SELECT generation, attempts, last_error, submitted_mutation_id, submitted_at
           FROM vector_outbox WHERE chunk_uid='command-legacy#0'`,
      ).get();
      const receipts = candidate.prepare(
        "SELECT version,checksum FROM schema_migrations WHERE version IN (10,11,12,13) ORDER BY version",
      ).all();
      const interveningAfter = interveningGeneration === null ? null : candidate.prepare(
        "SELECT generation FROM vector_outbox WHERE chunk_uid='intervening#0'",
      ).get().generation;
      const objects = new Set(candidate.prepare("SELECT name FROM sqlite_master").all().map((row) => row.name));
      if (!(receipts.length === 4 && state.schema_version === LATEST_SCHEMA &&
            state.outbox_generation >= queue.generation && state.owner === null && state.expires === null &&
            state.mutation_id === null && state.mutation_submitted_at === null &&
            queue.submitted_mutation_id === null && queue.submitted_at === null &&
            queue.generation > 0 && queue.attempts === 4 && queue.last_error === "keep retry" &&
            (interveningGeneration === null || interveningAfter === interveningGeneration) &&
            objects.has("idx_vector_outbox_generation") &&
            objects.has("vector_outbox_generation_ai") && objects.has("vector_outbox_generation_au"))) {
        commandResumePassed = false;
        commandResumeDetail = `fault ${faultAfter}: ${JSON.stringify({ state, queue, receipts, interveningGeneration, interveningAfter })}`;
      }
    } catch (error) {
      commandResumePassed = false;
      commandResumeDetail = `fault ${faultAfter} rerun: ${error.message}`;
    }
    candidate.close();
  }
  check("cmdMigrate resumes after every committed SQL, receipt, and seed boundary",
    commandResumePassed, commandResumeDetail);

  // v0.1.23 publicly shipped grants and zones as schema 15 and 16. The 0.2.0
  // product tables must therefore begin at 17: changing an already-receipted
  // migration in place would turn a routine update into a checksum conflict.
  const publishedSchema16 = new DatabaseSync(":memory:");
  for (const file of files.filter((name) => Number.parseInt(name, 10) <= 16)) {
    const sql = readFileSync(join(DIR, file), "utf8");
    for (const statement of splitStatements(sql)) publishedSchema16.exec(statement);
    publishedSchema16.prepare(
      `INSERT INTO schema_migrations (version,name,applied_at,checksum)
       VALUES (?,?,?,?)`,
    ).run(
      Number.parseInt(file, 10),
      file.replace(/\.sql$/, ""),
      "2026-01-01T00:00:00Z",
      createHash("sha256").update(sql).digest("hex").slice(0, 16),
    );
  }
  publishedSchema16.prepare(
    "UPDATE install_state SET schema_version=16 WHERE id=1",
  ).run();
  await cmdMigrate(manifestPath, {
    silent: true,
    resolveAccount: async () => ({ id: "fixture-account" }),
    d1Query: adapterFor(publishedSchema16),
    vectorDrainQuiesced: true,
  });
  const publishedUpgrade = publishedSchema16.prepare(
    `SELECT
       (SELECT schema_version FROM install_state WHERE id=1) schema_version,
       (SELECT count(*) FROM schema_migrations) receipts,
       (SELECT count(*) FROM sqlite_master WHERE type='table' AND name='grants') grants_table,
       (SELECT count(*) FROM sqlite_master WHERE type='table' AND name='fin_transactions') ledger_table,
       (SELECT count(*) FROM sqlite_master WHERE type='table' AND name='document_access_grants') document_grants_table`,
  ).get();
  // The receipt count is "every migration in this tree", not a fixed 22. The
  // port raised it to 32; pinning the literal would make this assertion a
  // record of what the tree used to hold rather than a check that a published
  // schema-16 brain arrives at the current one.
  check("the published schema-16 access release upgrades cleanly to the current schema",
    publishedUpgrade?.schema_version === LATEST_SCHEMA &&
      publishedUpgrade.receipts === LATEST_SCHEMA &&
      publishedUpgrade.grants_table === 1 &&
      publishedUpgrade.ledger_table === 1 &&
      publishedUpgrade.document_grants_table === 1,
    JSON.stringify(publishedUpgrade));
  publishedSchema16.close();

  const direct = makeCommandLegacy();
  const directFault = { after: null, mutations: 0 };
  let directError = null;
  try {
    await cmdMigrate(manifestPath, {
      silent: true,
      resolveAccount: async () => ({ id: "fixture-account" }),
      d1Query: adapterFor(direct, directFault),
    });
  } catch (error) { directError = error; }
  check("direct migrate refuses a live pre-lease brain before every mutation",
    /run `brain update` instead/i.test(directError?.message || "") && directFault.mutations === 0,
    `${directError?.message}; mutations=${directFault.mutations}`);
  direct.close();

  // 0033 replaces chunks_ai as two independently committed REST statements.
  // A schema-32 Worker must therefore be behind the same whole-corpus write
  // barrier as the older vector protocol migrations before direct migration is
  // allowed to open the DROP/CREATE interval.
  const makeSchema32 = () => {
    const candidate = new DatabaseSync(":memory:");
    for (const file of files.filter((name) => Number.parseInt(name, 10) <= 32)) {
      const sql = readFileSync(join(DIR, file), "utf8");
      for (const statement of splitStatements(sql)) candidate.exec(statement);
      candidate.prepare(
        `INSERT INTO schema_migrations (version,name,applied_at,checksum)
         VALUES (?,?,?,?)`,
      ).run(
        Number.parseInt(file, 10),
        file.replace(/\.sql$/, ""),
        "2026-01-01T00:00:00Z",
        createHash("sha256").update(sql).digest("hex").slice(0, 16),
      );
    }
    candidate.exec(
      `INSERT INTO install_state
         (id,client_slug,product_version,schema_version,gate_version,installed_at,ring)
       VALUES (1,'schema-32-fixture','0.4.0',32,0,'2026-01-01T00:00:00Z','test');
       INSERT INTO sources (name,kind,status,created_at)
       VALUES ('live','upload','ready','2026-01-01T00:00:00Z');
       INSERT INTO documents (doc_uid,source,source_id,title,ingested_at,content_hash)
       VALUES ('live:one','live','one','Live',1,'live-hash');
       INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title)
       VALUES ('live:one#0','live:one',0,'live text','live','Live');
       INSERT INTO corpus_stats (source,documents,chunks,last_ingest_at)
       VALUES ('live',99,48,111),('gone',7,48,222);`,
    );
    return candidate;
  };

  const schema32 = makeSchema32();
  const schema32Fault = { after: null, mutations: 0 };
  let schema32Error = null;
  try {
    await cmdMigrate(manifestPath, {
      silent: true,
      resolveAccount: async () => ({ id: "fixture-account" }),
      d1Query: adapterFor(schema32, schema32Fault),
    });
  } catch (error) { schema32Error = error; }
  check("direct migrate refuses a live schema-32 brain before dropping its FTS writer",
    /0010-0013, 0033, or 0044.*brain update/is.test(schema32Error?.message || "") &&
      schema32Fault.mutations === 0 &&
      schema32.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name='chunks_ai'").get().n === 1,
    `${schema32Error?.message}; mutations=${schema32Fault.mutations}`);

  const schema32QuiescedFault = { after: null, mutations: 0 };
  await cmdMigrate(manifestPath, {
    silent: true,
    resolveAccount: async () => ({ id: "fixture-account" }),
    d1Query: adapterFor(schema32, schema32QuiescedFault),
    vectorDrainQuiesced: true,
  });
  const schema33Receipt = schema32.prepare(
    "SELECT version FROM schema_migrations WHERE version=33",
  ).get();
  check("verified writer quiescence allows schema 33 and restores the FTS writer",
    schema33Receipt?.version === 33 && schema32QuiescedFault.mutations > 0 &&
      schema32.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name='chunks_ai'").get().n === 1,
    JSON.stringify({ schema33Receipt, mutations: schema32QuiescedFault.mutations }));
  check("schema 34 backfills source inventory for documents written by the prior Worker",
    schema32.prepare(
      "SELECT count(*) AS n FROM document_source_inventory WHERE source='live'",
    ).get()?.n === 1,
    JSON.stringify(schema32.prepare("SELECT source FROM document_source_inventory ORDER BY source").all()));
  const reconciledStats = schema32.prepare(
    "SELECT source,documents,chunks,last_ingest_at FROM corpus_stats WHERE source IN ('live','gone') ORDER BY source",
  ).all();
  check("schema 34 repairs dirty cached counts from authoritative live D1 rows",
    JSON.stringify(reconciledStats) === JSON.stringify([
      { source: "gone", documents: 0, chunks: 0, last_ingest_at: 222 },
      { source: "live", documents: 1, chunks: 1, last_ingest_at: 111 },
    ]), JSON.stringify(reconciledStats));
  schema32.close();

  const noStateTable = new DatabaseSync(":memory:");
  noStateTable.exec("CREATE TABLE legacy_live_corpus (id INTEGER PRIMARY KEY, body TEXT)");
  const noStateFault = { after: null, mutations: 0 };
  let noStateError = null;
  try {
    await cmdMigrate(manifestPath, {
      silent: true,
      resolveAccount: async () => ({ id: "fixture-account" }),
      d1Query: adapterFor(noStateTable, noStateFault),
    });
  } catch (error) { noStateError = error; }
  check("absence of install_state cannot bypass cutover on a nonempty legacy database",
    /not provably fresh.*brain update/is.test(noStateError?.message || "") &&
      noStateFault.mutations === 0,
    `${noStateError?.message}; mutations=${noStateFault.mutations}`);
  noStateTable.close();

  const missingSingleton = makeCommandLegacy();
  missingSingleton.exec(
    `DELETE FROM vector_outbox;
     DELETE FROM install_state;
     INSERT INTO documents (doc_uid,source,source_id,title,ingested_at,content_hash)
     VALUES ('legacy:missing-row','legacy','missing-row','Missing row',1,'missing-row-hash');
     INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title)
     VALUES ('legacy:missing-row#0','legacy:missing-row',0,'legacy text','legacy','Missing row');`,
  );
  await cmdMigrate(manifestPath, {
    silent: true,
    resolveAccount: async () => ({ id: "fixture-account" }),
    d1Query: adapterFor(missingSingleton),
    vectorDrainQuiesced: true,
  });
  const seededSingleton = missingSingleton.prepare(
    `SELECT schema_version,
            vector_projection_status status,
            vector_projection_bootstrap_epoch epoch,
            vector_projection_bootstrap_cursor cursor,
            vector_projection_bootstrap_high_water high_water
       FROM install_state WHERE id=1`,
  ).get();
  check("migration seeds a missing singleton as an unverified nonempty projection",
    seededSingleton?.schema_version === LATEST_SCHEMA &&
      seededSingleton.status === "bootstrap_required" && seededSingleton.epoch === 1 &&
      seededSingleton.cursor === null && seededSingleton.high_water === "legacy:missing-row#0",
    JSON.stringify(seededSingleton));
  check("fresh migration completion seeds one durable owner financial map key",
    missingSingleton.prepare(
      "SELECT count(*) AS n FROM owner_financial_map_key_state WHERE tenant_id='primary'",
    ).get()?.n === 1);
  missingSingleton.close();

  const fresh = new DatabaseSync(":memory:");
  const freshFault = { after: null, mutations: 0 };
  await cmdMigrate(manifestPath, {
    silent: true,
    resolveAccount: async () => ({ id: "fixture-account" }),
    d1Query: adapterFor(fresh, freshFault),
  });
  const freshOriginalKey = fresh.prepare(
    "SELECT signing_salt FROM source_original_id_key_state WHERE tenant_id='primary'",
  ).get();
  check("fresh cmdMigrate completion seeds one durable source-original identity key",
    fresh.prepare("SELECT schema_version FROM install_state WHERE id=1").get()?.schema_version === LATEST_SCHEMA &&
      fresh.prepare("SELECT count(*) AS n FROM source_original_id_key_state").get()?.n === 1 &&
      /^[a-f0-9]{64}$/.test(freshOriginalKey?.signing_salt || ""),
    JSON.stringify(freshOriginalKey));
  fresh.close();
  rmSync(sandbox, { recursive: true, force: true });
}

/* ---- and the triggers must actually keep the FTS index in step ---- */
{
  db.exec(`INSERT INTO documents (doc_uid,source,source_id,title,ingested_at,content_hash)
           VALUES ('m:1','meeting','1','T',1,'h')`);
  db.exec(`INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title)
           VALUES ('m:1#0','m:1',0,'the retainer was deferred','meeting','T')`);
  const hit = (q) => db.prepare("SELECT c.chunk_uid FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid WHERE chunks_fts MATCH ?").all(q);
  check("insert trigger populates the FTS index", hit('"retainer"').length === 1);
  check("porter stemming is active (defer -> deferred)", hit('"defer"').length === 1);

  db.exec("UPDATE chunks SET text='the retainer was increased' WHERE chunk_uid='m:1#0'");
  check("update trigger leaves no stale ghost", hit('"deferred"').length === 0);
  check("and indexes the new text", hit('"increased"').length === 1);

  db.exec("DELETE FROM chunks WHERE chunk_uid='m:1#0'");
  check("delete trigger removes it from the index", hit('"increased"').length === 0);
}

/* ---- source lifecycle SQL is executed, not merely inspected by a mock ---- */
{
  const d1 = {
    prepare(sql) {
      const statement = (params = []) => ({
        bind: (...next) => statement(next),
        first: async () => db.prepare(sql).get(...params) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...params) }),
        run: async () => db.prepare(sql).run(...params),
      });
      return statement();
    },
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const env = { STORAGE: "d1", ADMIN_KEY: "k", DB: d1 };
  const post = (body) => worker.fetch(new Request("https://brain.example/api/admin/brain/source-receipt", {
    method: "POST",
    headers: { "X-Admin-Key": "k", "content-type": "application/json" },
    body: JSON.stringify(body),
  }), env, {});

  const oldStart = new Date(Date.now() - 7 * 3600000).toISOString();
  const opened = await (await post({
    source: "drive", kind: "drive", status: "indexing", run_id: "real_run_1",
    lane: "sweep", started_at: oldStart,
  })).json();
  check("real SQLite accepts an indexing source receipt", opened.status === "indexing", JSON.stringify(opened));

  const insertDoc = db.prepare(
    `INSERT INTO documents (doc_uid,source,source_id,title,ingested_at,content_hash,meta)
     VALUES (?,?,?,?,?,?,?)`
  );
  insertDoc.run("drive:big#part1of2", "drive", "big#part1of2", "Big 1", 1, "h1", JSON.stringify({ part_of: "big" }));
  insertDoc.run("drive:big#part2of2", "drive", "big#part2of2", "Big 2", 1, "h2", JSON.stringify({ part_of: "big" }));
  insertDoc.run("drive:small", "drive", "small", "Small", 1, "h3", "{}");

  const stuck = await (await worker.fetch(new Request("https://brain.example/api/admin/brain/freshness", {
    headers: { "X-Admin-Key": "k" },
  }), env, {})).json();
  check("the real sync_runs join detects a seven-hour stuck run",
    stuck.sources?.[0]?.state === "broken" && /7 hour/.test(stuck.sources[0].reason || ""), JSON.stringify(stuck));

  const ready = await (await post({
    source: "drive", kind: "drive", status: "ready", run_id: "real_run_1",
    lane: "sweep", started_at: oldStart, complete_sweep: true, walk_complete: true,
    files_seen: 4, docs_added: 1, docs_updated: 1, docs_unchanged: 1,
    docs_refused: 1, docs_failed: 0,
    confirmed_range: { from: "2025-01-01T00:00:00.000Z", through: "2026-09-06T00:00:00.000Z" },
    target_range: { from: "2025-01-01T00:00:00.000Z", through: null },
  })).json();
  check("a real completion counts one split family as one logical document",
    ready.documents === 2 && ready.stored_documents === 3, JSON.stringify(ready));
  const measuredRun = db.prepare(
    `SELECT files_seen,docs_added,docs_updated,docs_unchanged,docs_refused,docs_failed,metrics_version,
            confirmed_from,confirmed_through,target_from,target_through
       FROM sync_runs WHERE run_id='real_run_1'`,
  ).get();
  check("a terminal receipt durably stores measured refusal counts and claimed ranges",
    measuredRun?.files_seen === 4 && measuredRun?.docs_refused === 1 && measuredRun?.docs_failed === 0 &&
      measuredRun?.metrics_version === 1 && measuredRun?.confirmed_from === "2025-01-01T00:00:00.000Z" &&
      measuredRun?.confirmed_through === "2026-09-06T00:00:00.000Z" &&
      measuredRun?.target_from === "2025-01-01T00:00:00.000Z" && measuredRun?.target_through === null,
    JSON.stringify(measuredRun));
  const invalidRange = await post({
    source: "drive", kind: "drive", status: "ready", run_id: "invalid_range_run",
    lane: "sweep", confirmed_range: { from: "2026-01-02", through: "2026-01-01" },
  });
  check("an inverted claimed range is refused before a sync run is written",
    invalidRange.status === 400 &&
      db.prepare("SELECT count(*) AS n FROM sync_runs WHERE run_id='invalid_range_run'").get().n === 0,
    await invalidRange.text());
  const successfulAt = db.prepare("SELECT last_ingest_at FROM sources WHERE name='drive'").get().last_ingest_at;

  await post({ source: "drive", kind: "drive", status: "indexing", run_id: "real_run_2", lane: "incremental" });
  const privateFailureSentinel = "SYNTHETIC_PRIVATE_SENTINEL";
  const failedResponse = await post({
    source: "drive", kind: "drive", status: "error", run_id: "real_run_2",
    lane: "incremental",
    error: `${privateFailureSentinel} /fixture/private/path`,
    reason: `${privateFailureSentinel} account@example.invalid`,
    detail: `${privateFailureSentinel} https://provider.invalid/private`,
  });
  const failed = await failedResponse.json();
  const failedSource = db.prepare("SELECT status,last_ingest_at,stale_reason,document_count FROM sources WHERE name='drive'").get();
  const failedRun = db.prepare("SELECT error FROM sync_runs WHERE run_id='real_run_2'").get();
  const failedEvent = db.prepare(
    "SELECT detail FROM source_events WHERE source_name='drive' AND event='error' ORDER BY id DESC LIMIT 1",
  ).get();
  check("a real failed receipt is stored as an error without advancing last success",
    failed.status === "error" && failedSource.status === "error" && failedSource.last_ingest_at === successfulAt,
    JSON.stringify({ failed, failedSource, successfulAt }));
  check("the real source registry keeps the logical count and stable failure code",
    failedSource.document_count === 2 && failed.issue_code === "INGEST_FAILED" &&
      failedSource.stale_reason === "INGEST_FAILED" && failedRun.error === "INGEST_FAILED",
    JSON.stringify({ failed, failedSource, failedRun }));
  check("private connector failure text reaches no stored receipt or response surface",
    !JSON.stringify({ failed, failedSource, failedRun, failedEvent }).includes(privateFailureSentinel) &&
      /latest update did not finish/i.test(failedEvent.detail || ""),
    JSON.stringify({ failed, failedSource, failedRun, failedEvent }));

  const review = await (await post({
    source: "drive", kind: "drive", status: "error", run_id: "real_run_review",
    lane: "incremental", issue_code: "SAFETY_REVIEW_REQUIRED",
  })).json();
  const reviewFreshness = await (await worker.fetch(new Request("https://brain.example/api/admin/brain/freshness", {
    headers: { "X-Admin-Key": "k" },
  }), env, {})).json();
  check("a real safety-review receipt retains its stable issue code",
    review.issue_code === "SAFETY_REVIEW_REQUIRED" &&
      db.prepare("SELECT stale_reason FROM sources WHERE name='drive'").get().stale_reason === "SAFETY_REVIEW_REQUIRED",
    JSON.stringify(review));
  check("the real freshness route presents a safety stop as review instead of broken",
    reviewFreshness.sources?.[0]?.state === "review" &&
      /paused for a safety review/i.test(reviewFreshness.sources[0].reason || ""),
    JSON.stringify(reviewFreshness));

  db.prepare(
    `INSERT INTO sources (name,kind,status,created_at)
     VALUES ('legacy-kind-case',' Drive ','pending','2026-01-01T00:00:00.000Z')`,
  ).run();
  const legacyKindReceipt = await post({
    source: "legacy-kind-case", kind: "drive", status: "indexing",
    run_id: "legacy_kind_case", lane: "incremental",
  });
  const legacyKindBody = await legacyKindReceipt.json();
  const legacyKindRow = db.prepare(
    "SELECT kind,status FROM sources WHERE name='legacy-kind-case'",
  ).get();
  check("a semantically matching legacy kind is canonicalized before exact lifecycle guards",
    legacyKindReceipt.status === 200 && legacyKindBody.kind === "drive" &&
      legacyKindRow.kind === "drive" && legacyKindRow.status === "indexing" &&
      db.prepare("SELECT count(*) AS n FROM sync_runs WHERE run_id='legacy_kind_case'").get().n === 1,
    JSON.stringify({ legacyKindBody, legacyKindRow }));

  // Every provider runner opens this receipt before it reads remote data. Keep
  // the Worker's closed kind allowlist in step with every advertised runner,
  // plus the dedicated Plaid, Zoom, and IMAP paths that use the same source
  // registry contract.
  const advertisedReceiptKinds = [...PROVIDER_CONNECTOR_IDS, "plaid", "zoom", "imap"];
  const providerReceipts = [];
  for (const kind of advertisedReceiptKinds) {
    const runId = `provider_contract_${kind}`;
    const openedResponse = await post({
      source: kind, kind, status: "indexing", run_id: runId,
      lane: "incremental", started_at: "2026-09-06T12:00:00.000Z",
    });
    const openedBody = await openedResponse.json();
    const closedResponse = await post({
      source: kind, kind, status: "ready", run_id: runId,
      lane: "incremental", started_at: "2026-09-06T12:00:00.000Z",
      completed_at: "2026-09-06T12:01:00.000Z", walk_complete: true,
    });
    const closedBody = await closedResponse.json();
    const sourceRow = db.prepare(
      "SELECT name,kind,status,last_ingest_at FROM sources WHERE name=?",
    ).get(kind);
    const runRow = db.prepare(
      "SELECT source,lane,started_at,finished_at,walk_complete,error FROM sync_runs WHERE run_id=?",
    ).get(runId);
    providerReceipts.push({
      kind,
      openedStatus: openedResponse.status,
      openedBody,
      closedStatus: closedResponse.status,
      closedBody,
      sourceRow,
      runRow,
    });
  }
  check("every advertised provider kind can open and close the real Worker receipt contract",
    providerReceipts.every(({ kind, openedStatus, openedBody, closedStatus, closedBody, sourceRow, runRow }) =>
      openedStatus === 200 && openedBody.kind === kind && openedBody.status === "indexing" &&
      closedStatus === 200 && closedBody.kind === kind && closedBody.status === "ready" &&
      sourceRow?.name === kind && sourceRow?.kind === kind && sourceRow?.status === "ready" &&
      sourceRow?.last_ingest_at === "2026-09-06T12:01:00.000Z" &&
      runRow?.source === kind && runRow?.lane === "incremental" &&
      runRow?.started_at === Date.parse("2026-09-06T12:00:00.000Z") &&
      runRow?.finished_at === Date.parse("2026-09-06T12:01:00.000Z") &&
      runRow?.walk_complete === 1 && runRow?.error === null),
    JSON.stringify(providerReceipts));

  const unsupported = await post({
    source: "salesforce", kind: "salesforce", status: "indexing",
    run_id: "provider_contract_salesforce", lane: "incremental",
  });
  check("the provider receipt kind allowlist remains closed",
    unsupported.status === 400 && (await unsupported.json()).error === "unsupported source kind",
    String(unsupported.status));

  insertDoc.run(
    "collision:historical", "collision", "historical", "Historical upload", 2,
    "historical-hash", "{}",
  );
  const historicalClaim = await post({
    source: "collision", kind: "plaid", status: "indexing",
    run_id: "historical_claim", lane: "incremental",
  });
  const historicalBody = await historicalClaim.json();
  check("a first connector claim cannot relabel pre-existing unregistered documents",
    historicalClaim.status === 409 && historicalBody.code === "source_kind_conflict" &&
      db.prepare("SELECT count(*) AS n FROM sources WHERE name='collision'").get().n === 0 &&
      db.prepare("SELECT count(*) AS n FROM sync_runs WHERE run_id='historical_claim'").get().n === 0 &&
      db.prepare("SELECT count(*) AS n FROM source_events WHERE source_name='collision'").get().n === 0,
    JSON.stringify({ status: historicalClaim.status, historicalBody }));

  const raceSource = "first-claim-race";
  const raced = await Promise.all([
    post({
      source: raceSource, kind: "gmail", status: "indexing",
      run_id: "first_claim_gmail", lane: "incremental",
    }),
    post({
      source: raceSource, kind: "slack", status: "indexing",
      run_id: "first_claim_slack", lane: "incremental",
    }),
  ]);
  const racedBodies = await Promise.all(raced.map((response) => response.json()));
  const winnerIndex = raced.findIndex((response) => response.status === 200);
  const winner = racedBodies[winnerIndex];
  check("concurrent first claims choose one connector kind and fail the loser closed",
    raced.map((response) => response.status).sort().join(",") === "200,409" &&
      db.prepare("SELECT kind FROM sources WHERE name=?").get(raceSource)?.kind === winner?.kind &&
      db.prepare("SELECT count(*) AS n FROM sync_runs WHERE source=?").get(raceSource).n === 1 &&
      db.prepare("SELECT count(*) AS n FROM source_events WHERE source_name=?").get(raceSource).n === 1,
    JSON.stringify({ statuses: raced.map((response) => response.status), racedBodies }));
}

console.log(fail ? `\n${fail} FAILURES` : `\nmigrations: all ${ran} checks passed`);
process.exit(fail ? 1 : 0);
