// The migration walk a real client brain has to survive: schema 22 -> 45.
//
// Every release published through v0.3.6 ships exactly 22 migrations, so both
// production-shaped v0.2.0 and v0.2.3 -> v0.3.5 fixtures are at schema 22
// with a POPULATED database. Migrations 0023..0046 have
// never been applied to a real client brain, and test/migrations.test.mjs only
// parses the SQL text; nothing here or anywhere else applies them to rows that
// already exist.
//
// This rehearses that walk on real SQLite, through the product's OWN applier:
// splitStatements + runRestartSafeMigrationStatements from brain.mjs, one
// independently-committed statement at a time, exactly as D1's REST query
// endpoint behaves. A rehearsal that used db.exec() would test the SQL and not
// the product.
//
// Same style as vector-drain-recovery.test.mjs / vector-bootstrap-history.test.mjs.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { splitStatements, runRestartSafeMigrationStatements } from "../brain.mjs";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 400)));
  if (!condition) fail++;
};

// A missing column or table must read as a FAILED assertion, not as a crashed
// harness. Mutating a migration to a no-op has to produce a legible failure
// list, otherwise this file cannot prove it is testing anything.
const probe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };

const REPO = fileURLToPath(new URL("../", import.meta.url));
const MIG_DIR = join(REPO, "migrations", "d1");

/* ------------------------------------------------------------------ files */

// The 22 migrations a shipped client brain actually has, read from the v0.2.0
// TAG rather than the working tree, so an in-place edit to a shipped file
// cannot make this rehearsal describe a database no client owns.
// Prefer the v0.2.0 TAG, because an in-place edit to a shipped file must not be
// able to make this rehearsal describe a database no client owns. CI checkouts
// are shallow and the CI-only repository carries no tags at all, so when the tag
// cannot be resolved this falls back to the working tree and pins it with the
// digest of the tag's own bytes. The guarantee survives either way: an edited
// shipped migration fails here, with or without git.
const SHIPPED_MIGRATIONS_DIGEST = "cd9010998d14097137500dabb8516f1d8901ae5c1d82dbfefa37b28f7fe51ecb";
function shippedMigrationFiles(repoRoot, migrationsDir) {
  const fromTag = (() => {
    try {
      const listing = execFileSync("git", ["ls-tree", "-r", "--name-only", "refs/tags/v0.2.0", "migrations/d1/"],
        { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        .trim().split("\n").filter(Boolean).sort();
      if (!listing.length) return null;
      return listing.map((path) => ({ path, sql: execFileSync("git", ["show", `refs/tags/v0.2.0:${path}`],
        { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }) }));
    } catch { return null; }
  })();
  const files = fromTag ?? readdirSync(migrationsDir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()
    .filter((f) => Number.parseInt(f.split("_")[0], 10) <= 22)
    .map((f) => ({ path: `migrations/d1/${f}`, sql: readFileSync(join(migrationsDir, f), "utf8") }));
  const digest = createHash("sha256");
  for (const file of files) { digest.update(file.path); digest.update("\0"); digest.update(file.sql); }
  const actual = digest.digest("hex");
  if (actual !== SHIPPED_MIGRATIONS_DIGEST) {
    throw new Error(`the 22 shipped migrations are not the published bytes (${actual} != ${SHIPPED_MIGRATIONS_DIGEST}); ` +
      `source=${fromTag ? "v0.2.0 tag" : "working tree"}`);
  }
  return files.map(({ path, sql }) => {
    const name = path.split("/").pop().replace(/\.sql$/, "");
    return {
      version: Number.parseInt(name.split("_")[0], 10),
      name,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex").slice(0, 16),
    };
  });
}
function shippedMigrations() { return shippedMigrationFiles(REPO, MIG_DIR); }

// Everything 0023 and later, from today's tree — the code under test.
function newMigrations() {
  return readdirSync(MIG_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()
    .map((f) => ({
      version: parseInt(f.split("_")[0], 10),
      name: f.replace(/\.sql$/, ""),
      sql: readFileSync(join(MIG_DIR, f), "utf8"),
    }))
    .filter((m) => m.version >= 23);
}

const SHIPPED = shippedMigrations();
const PENDING = newMigrations();

/* ---------------------------------------------------------------- applier */

// Mirrors cmdMigrate's inner loop: split, run each statement through the
// restart-safe runner as its own committed unit, then record the version.
function applyMigration(db, migration, { onStatement = null } = {}) {
  const statements = splitStatements(migration.sql);
  const results = [];
  return runRestartSafeMigrationStatements(
    statements,
    (statement) => {
      // D1 returns { results: [...] } per statement; PRAGMA reads come back the
      // same way, which is what the column-existence probe consumes.
      const rows = db.prepare(statement).all();
      results.push(statement);
      return { results: rows };
    },
    {
      afterStatement: async (info) => {
        if (onStatement) await onStatement(info, statements.length);
      },
    },
  ).then(() => {
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?,?,?,?)")
      .run(migration.version, migration.name, new Date().toISOString(),
        createHash("sha256").update(migration.sql).digest("hex").slice(0, 16));
    return results;
  });
}

/* --------------------------------------------------- a real v0.2.0 client */

// A populated brain, shaped like a real one: several ingest sources, live and
// soft-deleted documents, chunks under both, an FTS index built by the ORIGINAL
// 0004 chunks_ai trigger, corpus_stats already drifted (which is why 0034
// reconciles it), a queued vector_outbox row, and financial rows in the tables
// 0026/0029 later ALTER.
async function buildShippedBrain() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");   // D1 enforces these
  for (const migration of SHIPPED) await applyMigration(db, migration);

  db.prepare(
    `INSERT INTO install_state (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1,'example-owner','0.2.0',22,0,'2026-09-01T00:00:00Z','stable')`).run();

  const now = "2026-09-01T00:00:00Z";
  for (const [name, kind, zone] of [
    ["drive", "drive", "private"],
    ["gmail", "gmail", "private"],
    ["upload", "upload", null],
    ["calendar", "calendar", "shared"],
  ]) {
    db.prepare("INSERT INTO sources (name, kind, status, created_at, zone) VALUES (?,?,'ready',?,?)")
      .run(name, kind, now, zone);
  }

  // documents: drive x3 live, gmail x2 live, upload x1 SOFT DELETED (the only
  // document that source ever had), calendar x1 live.
  const docs = [
    ["doc-drive-1", "drive", "d1", "Retainer terms", null],
    ["doc-drive-2", "drive", "d2", "Install notes", null],
    ["doc-drive-3", "drive", "d3", "Zone policy", null],
    ["doc-gmail-1", "gmail", "g1", "Thread with Example Customer A", null],
    ["doc-gmail-2", "gmail", "g2", "Thread with Example Customer", null],
    // upload's ONLY document is soft-deleted: the source must leave the inventory.
    ["doc-upload-1", "upload", "u1", "Withdrawn upload", 1756684800],
    ["doc-cal-1", "calendar", "c1", "Kickoff call", null],
    // A source that is in `documents` but was never registered in `sources`,
    // and has no corpus_stats row either. Real brains accumulate these from
    // older ingest paths, and 0033's zone subquery and 0034's backfill both
    // have to survive one.
    ["doc-legacy-1", "legacy-import", "l1", "Unregistered source", null],
    // PARTIAL soft delete: one document gone, one alive, same source. The
    // inventory must KEEP this source; a naive backfill drops it.
    ["doc-gmail-3", "gmail", "g3", "Deleted thread", 1756684800],
  ];
  for (const [uid, source, sid, title, deleted] of docs) {
    db.prepare(
      `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash, deleted_at, zone)
       VALUES (?,?,?,?,1756684800,?,?,NULL)`
    ).run(uid, source, sid, title, "hash-" + uid, deleted);
  }
  // chunks, including two under the soft-deleted upload document.
  let chunkIx = 0;
  const chunkPlan = [
    ["doc-drive-1", 3], ["doc-drive-2", 2], ["doc-drive-3", 1],
    ["doc-gmail-1", 2], ["doc-gmail-2", 1], ["doc-gmail-3", 4],
    ["doc-upload-1", 2],
    ["doc-cal-1", 1],
    ["doc-legacy-1", 2],
  ];
  for (const [docUid, count] of chunkPlan) {
    const source = db.prepare("SELECT source FROM documents WHERE doc_uid = ?").get(docUid).source;
    for (let i = 0; i < count; i++) {
      db.prepare(
        `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, title, zone)
         VALUES (?,?,?,?,?,?,NULL)`
      ).run(`chunk-${++chunkIx}`, docUid, i, `body text ${docUid} part ${i} corpustoken`, source, docUid);
    }
  }

  // A chunk carrying a STALE denormalized zone. 0033 documents that existing
  // rows are deliberately left alone, and a separate bounded repair converges
  // them. Pinned so a future migration cannot start rewriting a million rows
  // in one D1 statement without this failing.
  db.prepare("UPDATE chunks SET zone = 'shared' WHERE chunk_uid = 'chunk-1'").run();

  // corpus_stats deliberately drifted, plus a stat row for a source whose only
  // document is now soft-deleted, and one for a source with no documents at all.
  db.prepare("INSERT INTO corpus_stats (source, documents, chunks, last_ingest_at) VALUES ('drive', 99, 999, 1756684800)").run();
  db.prepare("INSERT INTO corpus_stats (source, documents, chunks, last_ingest_at) VALUES ('gmail', 2, 3, 1756684801)").run();
  db.prepare("INSERT INTO corpus_stats (source, documents, chunks, last_ingest_at) VALUES ('upload', 1, 2, 1756684802)").run();
  db.prepare("INSERT INTO corpus_stats (source, documents, chunks, last_ingest_at) VALUES ('slack', 7, 40, 1756684803)").run();

  for (const uid of ["chunk-1", "chunk-2", "chunk-3"]) {
    db.prepare("INSERT INTO vector_outbox (chunk_uid, op, queued_at) VALUES (?,'upsert',1756684800)").run(uid);
  }
  // The synthetic stranded fixture has outbox residue queued before the pause. 0028
  // adds retry state on top of exactly this table; it must not disturb rows
  // that are mid-flight.
  db.prepare("UPDATE vector_outbox SET attempts = 4, last_error = 'visibility_mismatch' WHERE chunk_uid = 'chunk-3'").run();

  db.prepare(
    `INSERT INTO fin_accounts (account_slug, entity_slug, account_kind, balance_role, provenance, basis_state, recorded_at)
     VALUES ('example-checking','example-owner','checking','asset','owner_stated','confirmed',?)`).run(now);
  db.prepare(
    `INSERT INTO fin_transactions (txn_uid, account_slug, posted_on, amount_minor, direction, provenance, basis_state, recorded_at)
     VALUES ('txn-1','example-checking','2026-08-01',12345,'outflow','owner_stated','confirmed',?)`).run(now);
  db.prepare(
    `INSERT INTO bank_feed_backfill (item_ref, requested_days, state, queued_at)
     VALUES ('item-abc', 730, 'running', ?)`).run(now);

  return db;
}

const count = (db, sql) => probe(() => db.prepare(sql).get().c, -1);

// COUNT(*) on an external-content FTS5 table reads THROUGH to the content table
// (`chunks`), so it equals the chunk count whether or not the index holds a
// single row. Measuring the index means either matching a token every chunk
// carries, or asking FTS5 to verify itself. Both are used below; the first
// version of this file asserted COUNT(*) and was therefore vacuous.
const ftsIndexed = (db, token = "corpustoken") =>
  probe(() => db.prepare(`SELECT COUNT(*) c FROM chunks_fts WHERE chunks_fts MATCH '${token}'`).get().c, -1);
// rank=1 is load-bearing. The bare form ("integrity-check" with no rank, which
// defaults to 0) checks only that the index is internally well-formed and
// PASSES on an index that is simply missing rows. Verified on SQLite 3.51.2:
// with a chunk inserted while chunks_ai did not exist, the bare form returns
// OK and the rank=1 form raises "database disk image is malformed".
const ftsIntegrityOk = (db) =>
  probe(() => {
    db.prepare("INSERT INTO chunks_fts(chunks_fts, rank) VALUES('integrity-check', 1)").run();
    return true;
  }, false);
const snapshot = (db) => ({
  documents: count(db, "SELECT COUNT(*) c FROM documents"),
  liveDocuments: count(db, "SELECT COUNT(*) c FROM documents WHERE deleted_at IS NULL"),
  chunks: count(db, "SELECT COUNT(*) c FROM chunks"),
  ftsIndexed: ftsIndexed(db),
  outbox: count(db, "SELECT COUNT(*) c FROM vector_outbox"),
  finTxns: count(db, "SELECT COUNT(*) c FROM fin_transactions"),
  finAccounts: count(db, "SELECT COUNT(*) c FROM fin_accounts"),
  backfill: count(db, "SELECT COUNT(*) c FROM bank_feed_backfill"),
});

/* ================================================================== walk */

console.log("\n--- baseline: a shipped v0.2.0 brain builds and is at schema 22 ---");
const db = await buildShippedBrain();
check("v0.2.0 ships exactly 22 migrations", SHIPPED.length === 22, `got ${SHIPPED.length}`);
check("today's tree has 0023..0046 pending", PENDING.length === 24 && PENDING.at(-1).version === 46,
  `${PENDING.length} pending, last ${PENDING.at(-1)?.version}`);
check("baseline schema_migrations is contiguous 1..22",
  db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().every((r, i) => r.version === i + 1));

const before = snapshot(db);
check("baseline FTS index actually holds every chunk (MATCH, not COUNT(*))",
  before.ftsIndexed === before.chunks && before.chunks > 0, `${before.ftsIndexed} indexed vs ${before.chunks} chunks`);
check("baseline FTS passes FTS5's own integrity-check", ftsIntegrityOk(db));

console.log("\n--- the walk: apply 0023..0046 to that populated brain ---");
const applied = [];
const errors = [];
for (const migration of PENDING) {
  try {
    await applyMigration(db, migration);
    applied.push(migration.name);
  } catch (error) {
    errors.push(`${migration.name}: ${error?.message ?? error}`);
    break;   // cmdMigrate has no catch: the first failure aborts the upgrade
  }
}
check("all 24 pending migrations apply to a populated schema-22 brain",
  errors.length === 0 && applied.length === PENDING.length,
  errors.join(" | ") || `applied ${applied.length}`);

if (errors.length === 0) {
  const after = snapshot(db);

  console.log("\n--- data survival ---");
  for (const key of ["documents", "liveDocuments", "chunks", "outbox", "finTxns", "finAccounts", "backfill"]) {
    check(`no rows lost: ${key}`, after[key] === before[key], `${before[key]} -> ${after[key]}`);
  }
  check("FTS index still holds every chunk after the walk",
    after.ftsIndexed === after.chunks && after.chunks > 0, `${after.ftsIndexed} indexed vs ${after.chunks} chunks`);
  check("FTS still passes FTS5's own integrity-check after the walk", ftsIntegrityOk(db));
  check("0039 does not relabel pre-existing provenance as assessed",
    count(db, `SELECT COUNT(*) c FROM documents
                WHERE provenance_receipt_version IS NOT NULL
                   OR provenance_receipt_status IS NOT NULL
                   OR provenance_receipt_reason IS NOT NULL
                   OR provenance_receipt_digest IS NOT NULL`) === 0);

  console.log("\n--- 0029: NOT NULL columns land on already-populated tables ---");
  const backfillRow = probe(() => db.prepare("SELECT provider_history_state FROM bank_feed_backfill WHERE item_ref='item-abc'").get());
  check("0029 backfilled provider_history_state on the pre-existing bank_feed_backfill row",
    backfillRow && backfillRow.provider_history_state !== null && backfillRow.provider_history_state !== "",
    JSON.stringify(backfillRow));

  console.log("\n--- 0026: new columns land on populated fin_* tables, values intact ---");
  const txn = probe(() => db.prepare("SELECT txn_uid, amount_minor, pending_transaction_id, source_provider FROM fin_transactions WHERE txn_uid='txn-1'").get());
  check("0026 kept the pre-existing transaction's amount", txn?.amount_minor === 12345, JSON.stringify(txn));
  check("0026 added pending_transaction_id as NULL on the existing row",
    txn && "pending_transaction_id" in txn && txn.pending_transaction_id === null, JSON.stringify(txn));

  console.log("\n--- 0034: the source inventory reflects the EXISTING corpus ---");
  const inventory = probe(() => db.prepare("SELECT source FROM document_source_inventory ORDER BY source").all().map((r) => r.source), []);
  const liveSources = db.prepare("SELECT DISTINCT source FROM documents WHERE deleted_at IS NULL ORDER BY source").all().map((r) => r.source);
  check("0034 backfilled the inventory from pre-existing documents",
    JSON.stringify(inventory) === JSON.stringify(liveSources),
    `inventory ${JSON.stringify(inventory)} vs live ${JSON.stringify(liveSources)}`);
  check("0034 excluded the source whose only document is soft-deleted",
    !inventory.includes("upload"), JSON.stringify(inventory));

  console.log("\n--- 0034: corpus_stats reconciled from the authoritative rows ---");
  const statsAfter = Object.fromEntries(
    probe(() => db.prepare("SELECT source, documents, chunks, last_ingest_at FROM corpus_stats").all(), []).map((r) => [r.source, r]));
  check("0034 repaired the drifted drive counts (was 99/999)",
    statsAfter.drive?.documents === 3 && statsAfter.drive?.chunks === 6, JSON.stringify(statsAfter.drive));
  check("0034 zeroed the source whose only document is soft-deleted",
    statsAfter.upload?.documents === 0 && statsAfter.upload?.chunks === 0, JSON.stringify(statsAfter.upload));
  check("0034 zeroed a stats row for a source with no documents at all",
    statsAfter.slack?.documents === 0 && statsAfter.slack?.chunks === 0, JSON.stringify(statsAfter.slack));
  check("0034 preserved last_ingest_at rather than inventing a freshness time",
    statsAfter.drive?.last_ingest_at === 1756684800 && statsAfter.gmail?.last_ingest_at === 1756684801,
    JSON.stringify([statsAfter.drive?.last_ingest_at, statsAfter.gmail?.last_ingest_at]));

  check("0034 kept a source that still has one live document beside a deleted one",
    inventory.includes("gmail"), JSON.stringify(inventory));
  check("0034 included a source present in documents but never registered in `sources`",
    inventory.includes("legacy-import"), JSON.stringify(inventory));

  // 0034's reconcile has to mean the SAME thing as the worker's own
  // corpus_stats aggregate (sourceStatsCommitStatement in worker/src/lib/store.js:
  // COUNT(DISTINCT doc_uid) / COUNT(chunk_uid) over a LEFT JOIN, live docs only).
  // If the two ever diverge, the migration "repairs" the cache into numbers the
  // very next ingest overwrites, and the drift returns silently.
  const workerAggregate = db.prepare(
    `SELECT documents.source AS source,
            COUNT(DISTINCT documents.doc_uid) AS documents,
            COUNT(chunks.chunk_uid) AS chunks
       FROM documents LEFT JOIN chunks ON chunks.doc_uid = documents.doc_uid
      WHERE documents.deleted_at IS NULL
      GROUP BY documents.source`).all();
  const statsMismatch = workerAggregate.filter((row) =>
    statsAfter[row.source]?.documents !== row.documents || statsAfter[row.source]?.chunks !== row.chunks);
  check("0034 reconciles corpus_stats to the worker's own aggregate definition, for every source",
    workerAggregate.length > 0 && statsMismatch.length === 0,
    JSON.stringify(statsMismatch));
  check("0034 created a corpus_stats row for the unregistered source with a NULL freshness",
    statsAfter["legacy-import"]?.documents === 1 && statsAfter["legacy-import"]?.last_ingest_at === null,
    JSON.stringify(statsAfter["legacy-import"]));

  console.log("\n--- 0028: retry state added without disturbing in-flight outbox rows ---");
  const outboxRow = probe(() => db.prepare("SELECT attempts, last_error FROM vector_outbox WHERE chunk_uid='chunk-3'").get());
  check("0028 left a mid-flight outbox row's attempts and last_error intact",
    outboxRow?.attempts === 4 && outboxRow?.last_error === "visibility_mismatch", JSON.stringify(outboxRow));

  console.log("\n--- 0033: the replaced chunks_ai still maintains FTS, and now sets zone ---");
  db.prepare(
    `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash)
     VALUES ('doc-drive-new','drive','d-new','Post upgrade doc',1756771200,'hash-new')`).run();
  db.prepare(
    `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, title)
     VALUES ('chunk-new','doc-drive-new',0,'post upgrade keywordbeta','drive','Post upgrade doc')`).run();
  check("0033 chunks_ai still writes new chunks into the FTS index",
    ftsIndexed(db, "keywordbeta") === 1);
  check("0033 chunks_ai now inherits the source's zone onto a new chunk",
    probe(() => db.prepare("SELECT zone FROM chunks WHERE chunk_uid='chunk-new'").get())?.zone === "private");
  check("0033 documents_zone_ai inherits the source's zone onto a new document",
    probe(() => db.prepare("SELECT zone FROM documents WHERE doc_uid='doc-drive-new'").get())?.zone === "private");
  check("0033 left EXISTING rows' zone unrewritten (documented, and the reason a repair pass exists)",
    count(db, "SELECT COUNT(*) c FROM documents WHERE zone IS NULL AND deleted_at IS NULL") > 0);
  check("0033 left a STALE denormalized chunk zone in place rather than rewriting the corpus",
    probe(() => db.prepare("SELECT zone FROM chunks WHERE chunk_uid='chunk-1'").get())?.zone === "shared");
  check("0033 chunks_ai does not duplicate the FTS row despite its own zone UPDATE firing chunks_au",
    ftsIndexed(db, "keywordbeta") === 1 && ftsIntegrityOk(db));

  // A chunk on a source with NO zone is the case that actually tests chunks_ai.
  // When the source HAS a zone, the trigger's own `UPDATE chunks SET zone`
  // fires chunks_au, whose delete+insert puts the row into FTS anyway - so a
  // chunks_ai that lost its FTS insert would still look healthy. `upload` has
  // zone NULL, the zone UPDATE is a no-op, and only chunks_ai can index it.
  db.prepare(
    `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash)
     VALUES ('doc-upload-2','upload','u2','Unzoned post-upgrade doc',1756771200,'hash-u2')`).run();
  db.prepare(
    `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, title)
     VALUES ('chunk-unzoned','doc-upload-2',0,'unzoned keyworddelta','upload','Unzoned post-upgrade doc')`).run();
  check("0033 chunks_ai indexes a chunk whose source has no zone (chunks_au cannot cover here)",
    ftsIndexed(db, "keyworddelta") === 1 &&
    probe(() => db.prepare("SELECT zone FROM chunks WHERE chunk_uid='chunk-unzoned'").get())?.zone === null);
  check("the corpus FTS index still passes content-vs-index integrity after both inserts",
    ftsIntegrityOk(db));

  console.log("\n--- 0034: the inventory triggers track live changes after the walk ---");
  check("0034 trigger added the new document's source (already present)",
    count(db, "SELECT COUNT(*) c FROM document_source_inventory WHERE source='drive'") === 1);
  db.prepare("UPDATE documents SET deleted_at = 1756771200 WHERE source='calendar'").run();
  check("0034 trigger removed a source once its last live document was soft-deleted",
    count(db, "SELECT COUNT(*) c FROM document_source_inventory WHERE source='calendar'") === 0 &&
    inventory.includes("calendar"));
  db.prepare("UPDATE documents SET deleted_at = NULL WHERE source='calendar'").run();
  check("0034 trigger restored the source when the document came back",
    count(db, "SELECT COUNT(*) c FROM document_source_inventory WHERE source='calendar'") === 1);

  console.log("\n--- 0035 / 0028: defaults and indexes exist on the upgraded brain ---");
  const windowCols = probe(() => db.prepare("PRAGMA table_info(plaid_sync_windows)").all().map((r) => r.name), []);
  check("0035 added cursor_history_json to plaid_sync_windows", windowCols.includes("cursor_history_json"));
  check("0029 added provider_history_state to plaid_sync_windows", windowCols.includes("provider_history_state"));
  check("0028 created the retry-eligible outbox index",
    count(db, "SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name='idx_vector_outbox_retry_eligible'") === 1);

  // Every object and column each pending migration DECLARES must exist on the
  // upgraded brain. Derived from the migration files themselves, so a migration
  // silently reduced to a no-op fails here rather than passing unnoticed. This
  // is what makes 0023/0024/0025/0027/0030/0031/0032 load-bearing: they add
  // nothing to pre-existing rows, so nothing else in this file would notice.
  console.log("\n--- every final declared object of 0023..0046 exists after the walk ---");
  const objectsPresent = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE name IS NOT NULL").all().map((r) => r.name));
  const finalDeclaredObjects = new Set();
  for (const migration of PENDING) {
    for (const statement of splitStatements(migration.sql)) {
      const created = statement.match(
        /^\s*CREATE\s+(?:UNIQUE\s+)?(?:VIRTUAL\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/i);
      if (created) finalDeclaredObjects.add(created[1]);
      const dropped = statement.match(
        /^\s*DROP\s+(?:TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/i);
      if (dropped) finalDeclaredObjects.delete(dropped[1]);
    }
  }
  for (const migration of PENDING) {
    const declaredObjects = new Map();
    const declaredColumns = [];
    for (const statement of splitStatements(migration.sql)) {
      const object = statement.match(
        /^\s*CREATE\s+(?:UNIQUE\s+)?(?:VIRTUAL\s+)?(TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/i);
      if (object) {
        declaredObjects.set(object[2], { kind: "object", name: object[2] });
        continue;
      }
      const droppedObject = statement.match(
        /^\s*DROP\s+(?:TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/i);
      if (droppedObject) {
        // A migration may use a temporary guard while it replaces a live
        // trigger. Inventory only declarations whose final state is present;
        // the per-statement restart tests separately prove the temporary
        // object protects every independently committed boundary.
        declaredObjects.delete(droppedObject[1]);
        continue;
      }
      const column = statement.match(
        /^\s*ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)/i);
      if (column) declaredColumns.push({ kind: "column", table: column[1], name: column[2] });
    }
    const declared = [
      ...[...declaredObjects.values()].filter((item) => finalDeclaredObjects.has(item.name)),
      ...declaredColumns,
    ];
    const missing = declared.filter((item) => item.kind === "object"
      ? !objectsPresent.has(item.name)
      : !probe(() => db.prepare(`PRAGMA table_info(${item.table})`).all().some((r) => r.name === item.name), false));
    check(`${migration.name} declares ${declared.length} object(s)/column(s), all present`,
      declared.length > 0 && missing.length === 0,
      missing.length ? "missing " + missing.map((m) => m.name).join(", ") : "declared nothing");
  }

  // The last statement cmdMigrate runs. Its ON CONFLICT arm updates identity,
  // schema, gate, and the monotonic retrieval generation only: resetting vector_projection_status
  // would re-create the stranded-bootstrap regression on every upgrade, and a
  // migrate that advanced product_version would let a later failed stage leave
  // the database claiming a version it never verified.
  console.log("\n--- cmdMigrate's final install_state upsert, on the upgraded brain ---");
  db.prepare("UPDATE install_state SET vector_projection_status='bootstrap_required', vector_projection_bootstrap_epoch=7 WHERE id=1").run();
  const upsertError = probe(() => {
    db.prepare(
      `INSERT INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring,
          vector_projection_status, vector_projection_bootstrap_epoch,
          vector_projection_bootstrap_cursor, vector_projection_bootstrap_high_water,
          source_original_retrieval_generation)
       VALUES (
         1,?,?,?,?,?,?,
         CASE WHEN EXISTS (SELECT 1 FROM chunks) THEN 'bootstrap_required' ELSE 'verified' END,
         CASE WHEN EXISTS (SELECT 1 FROM chunks) THEN 1 ELSE 0 END,
         NULL,
         (SELECT MAX(chunk_uid) FROM chunks),
         COALESCE((SELECT source_original_retrieval_generation + 1
                     FROM install_state WHERE id=1), 0)
       )
       ON CONFLICT(id) DO UPDATE SET
         client_slug = excluded.client_slug,
         schema_version = excluded.schema_version,
         gate_version = excluded.gate_version,
         source_original_retrieval_generation = excluded.source_original_retrieval_generation`
    ).run("fixture-brain", "0.4.0", 46, 0, new Date().toISOString(), "stable");
    return null;
  }, "threw");
  check("cmdMigrate's install_state upsert runs against the upgraded schema", upsertError === null, String(upsertError));
  const state = probe(() => db.prepare("SELECT * FROM install_state WHERE id=1").get(), {});
  check("migrate records schema_version 46", state?.schema_version === 46, JSON.stringify(state?.schema_version));
  check("migrate does NOT advance product_version (only a verified upgrade does)",
    state?.product_version === "0.2.0", JSON.stringify(state?.product_version));
  check("migrate does NOT clobber an in-progress vector projection bootstrap",
    state?.vector_projection_status === "bootstrap_required" && state?.vector_projection_bootstrap_epoch === 7,
    JSON.stringify([state?.vector_projection_status, state?.vector_projection_bootstrap_epoch]));

  console.log("\n--- schema_migrations after the walk ---");
  const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r.version);
  check("schema_migrations is contiguous 1..46 after the upgrade",
    versions.length === 46 && versions.every((v, i) => v === i + 1), JSON.stringify(versions));
}

/* --------------------------------------- restart resume, per the runner's own promise */


/* ------------------------------------------ the walk on a mature corpus */

// 0033's own comment refuses to rewrite existing zones in one statement because
// "a mature brain can have millions of chunks". 0034 then reconciles
// corpus_stats with an UNBOUNDED aggregate over the same documents-to-chunks
// join, in a single independently committed D1 statement. This proves the walk
// still completes and stays correct at a corpus size a real client reaches; it
// cannot prove anything about D1's own per-query ceilings, which is why the
// row volume is asserted rather than assumed to be small.
console.log("\n--- the same walk on a mature corpus ---");
{
  const big = await buildShippedBrain();
  const DOCS = 600, CHUNKS_PER = 40;
  big.exec("BEGIN");
  for (let d = 0; d < DOCS; d++) {
    big.prepare(`INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash)
                 VALUES (?, 'drive', ?, ?, 1756684800, ?)`).run(`big-d${d}`, `bs${d}`, `Doc ${d}`, `bh${d}`);
    for (let c = 0; c < CHUNKS_PER; c++) {
      big.prepare(`INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, title)
                   VALUES (?, ?, ?, ?, 'drive', ?)`)
        .run(`big-c${d}-${c}`, `big-d${d}`, c, `bulk body ${d} ${c} corpustoken`, `Doc ${d}`);
    }
  }
  big.exec("COMMIT");
  const bigChunks = count(big, "SELECT COUNT(*) c FROM chunks");
  const bigDocs = count(big, "SELECT COUNT(*) c FROM documents WHERE deleted_at IS NULL");
  let walkError = null;
  try { for (const migration of PENDING) await applyMigration(big, migration); }
  catch (error) { walkError = error?.message ?? String(error); }
  check(`the walk completes on ${bigDocs} live documents / ${bigChunks} chunks`, walkError === null, walkError || "");
  check("the mature corpus keeps every chunk and its FTS index",
    count(big, "SELECT COUNT(*) c FROM chunks") === bigChunks &&
    ftsIndexed(big) === bigChunks && ftsIntegrityOk(big),
    `${ftsIndexed(big)} indexed vs ${bigChunks}`);
  const bigDrive = probe(() => big.prepare("SELECT documents, chunks FROM corpus_stats WHERE source='drive'").get());
  check("0034's aggregate is exact at scale, not approximate",
    bigDrive?.documents === 3 + DOCS && bigDrive?.chunks === 6 + DOCS * CHUNKS_PER, JSON.stringify(bigDrive));
  // What D1 is billed for: 0034's reconcile cannot read fewer rows than the
  // live documents plus every chunk hanging off them, in ONE statement.
  check("0034's reconcile is a single unbounded statement over documents x chunks",
    probe(() => big.prepare(
      `EXPLAIN QUERY PLAN
       SELECT documents.source, COUNT(DISTINCT documents.doc_uid), COUNT(chunks.chunk_uid)
         FROM documents LEFT JOIN chunks ON chunks.doc_uid = documents.doc_uid
        WHERE documents.deleted_at IS NULL GROUP BY documents.source`).all(), [])
      .some((row) => /SCAN documents/i.test(String(row.detail))),
    "expected a full scan of documents; if this changed, re-check the D1 row-read cost");
}

/* ------------------------------- why 0033 requires the paused write barrier */

console.log("\n--- 0033's DROP/CREATE window: the hazard the writer barrier exists to close ---");
{
  const live = await buildShippedBrain();
  for (const migration of PENDING) {
    if (migration.version === 33) break;
    await applyMigration(live, migration);
  }
  const statements = splitStatements(PENDING.find((m) => m.version === 33).sql);
  const dropAt = statements.findIndex((statement) => /DROP\s+TRIGGER\s+IF\s+EXISTS\s+chunks_ai/i.test(statement));
  check("0033 does drop and recreate chunks_ai as two independently committed statements",
    dropAt >= 0 && statements.slice(dropAt + 1).some((s2) => /CREATE\s+TRIGGER\s+chunks_ai/i.test(s2)));

  // D1's REST endpoint commits per statement, so this window is real wall-clock
  // time on a live database. Any chunk written inside it is invisible to
  // keyword search FOREVER, with every health probe green.
  await runRestartSafeMigrationStatements(statements, (statement) => {
    const rows = live.prepare(statement).all();
    if (/DROP\s+TRIGGER\s+IF\s+EXISTS\s+chunks_ai/i.test(statement)) {
      live.prepare(
        `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash)
         VALUES ('doc-window','drive','w1','Written mid-migration',1756771200,'hash-window')`).run();
      live.prepare(
        `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, title)
         VALUES ('chunk-window','doc-window',0,'written keywordgamma mid migration','drive','Written mid-migration')`).run();
    }
    return { results: rows };
  });
  check("a chunk written inside that window is PERMANENTLY missing from keyword search",
    ftsIndexed(live, "keywordgamma") === 0);
  check("...and the row count hides it: COUNT(*) on chunks_fts still equals the chunk count",
    count(live, "SELECT COUNT(*) c FROM chunks_fts") === count(live, "SELECT COUNT(*) c FROM chunks"));
  check("...only FTS5's integrity-check can see the loss",
    ftsIntegrityOk(live) === false);
  // The product's own defences against this, both asserted rather than assumed:
  check("cmdMigrate lists 33, 44, and 46 among the migrations requiring verified writer quiescence",
    /writerQuiescenceMigrations = new Set\(\[10, 11, 12, 13, 33, 44, 46\]\)/
      .test(readFileSync(join(REPO, "brain.mjs"), "utf8")));
  check("the Worker's paused mode refuses the corpus ingest paths (the write barrier)",
    /PAUSED_CORPUS_MUTATION_PATHS = new Set\(\[[\s\S]*?\/api\/admin\/brain\/ingest[\s\S]*?\]\)/
      .test(readFileSync(join(REPO, "worker", "src", "index.js"), "utf8")));
}

console.log("\n--- restart safety: killed and resumed at EVERY statement boundary ---");
// D1's REST endpoint commits each statement on its own and schema_migrations is
// written only after the last one, so a process killed mid-file re-runs the
// WHOLE file on the next `brain migrate`. Every statement in 0023..0046 must
// therefore be idempotent against its own partial application - at every
// possible kill point, not just a convenient one.
for (const target of PENDING) {
  const total = splitStatements(target.sql).length;
  const failures = [];
  for (let killAfter = 1; killAfter <= total; killAfter++) {
    const fresh = await buildShippedBrain();
    for (const earlier of PENDING) {
      if (earlier.version >= target.version) break;
      await applyMigration(fresh, earlier);
    }
    try {
      await applyMigration(fresh, target, {
        onStatement: async ({ index }) => {
          if (index + 1 === killAfter) throw new Error("__killed__");
        },
      });
    } catch (error) {
      if (!String(error?.message).includes("__killed__")) {
        failures.push(`stmt ${killAfter} first pass: ${error?.message}`);
        continue;
      }
    }
    try {
      await applyMigration(fresh, target);
    } catch (error) {
      failures.push(`stmt ${killAfter} resume: ${error?.message ?? error}`);
    }
  }
  check(`${target.name} resumes from any of its ${total} statement boundaries`,
    failures.length === 0, failures.slice(0, 3).join(" | "));
}

console.log(`\n${ran - fail}/${ran} passed`);
process.exit(fail ? 1 : 0);
