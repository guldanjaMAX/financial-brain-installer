// The upgrade two real field installs are about to be taken through, rehearsed
// end to end on a real SQLite database built from the migration files.
//
// WHY THIS FILE EXISTS. Every release published through v0.3.6 ships exactly 22
// migrations. Both brains in the field are therefore at schema 22 with a
// POPULATED database, and migrations 0023 through the current head have never
// been applied to a real one. test/migrations.test.mjs only PARSES the migration SQL and asserts
// that indexes and columns appear in the file text; nothing applied them to
// rows that already exist. That was the gap.
//
// TWO PERSONAS, both drawn from field reports and both deliberately unnamed
// here (this repository is public):
//
//   FIELD-HEALTHY  a v0.2.0 install whose health check passes. Schema 22, live
//                  documents, chunks, an FTS index, financial rows, drifted
//                  corpus_stats. It must cross 22 -> current head without
//                  losing a row.
//   FIELD-STRANDED the same schema prefix, but PAUSED for an upgrade with one
//                  chunk queued by ordinary ingest in the seconds before the
//                  pause landed, and a projection fence left over from an
//                  earlier verified epoch. It must actually get out.
//
// WHAT MAKES IT A REHEARSAL RATHER THAN A RESTATEMENT:
//
//  * The 22-migration base comes from `git show refs/tags/v0.2.0:`, not the
//    working tree. An in-place edit to a shipped migration cannot make this
//    file describe a database no client owns; it makes it fail.
//  * The walk is driven by the REAL `cmdMigrate`, not a local copy of its
//    loop, so its checksum guard, its pending filter, its writer-quiescence
//    refusal and its install_state upsert are all under test.
//  * Block 3 is a negative control. Every migration after the shipped schema
//    22 prefix is neutered in
//    turn -- its statements are swallowed while the ledger row is still
//    written, which is exactly "the migration silently did nothing" -- and the
//    same assertion battery must fail for each. A rehearsal that still passes
//    when the code under test is removed is worth nothing.
//
// Style follows test/vector-bootstrap-history.test.mjs and
// test/vector-drain-recovery.test.mjs: real SQLite, real product functions,
// one flat check() list.

import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdMigrate, splitStatements } from "../brain.mjs";
import { acceleratedVectorBootstrap, vectorReadiness } from "../worker/src/lib/store-d1.js";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 400)));
  if (!condition) fail++;
};

// A missing table or column has to read as a FAILED assertion, not a crashed
// harness: the negative control deliberately produces databases where half of
// these reads are illegal, and it can only count failures if they are legible.
const probe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };

const REPO = fileURLToPath(new URL("../", import.meta.url));
const MIG_DIR = join(REPO, "migrations", "d1");
const FIELD_TAG = "refs/tags/v0.2.0";
const SHIPPED_PREFIX = 22;

const workDir = mkdtempSync(join(tmpdir(), "client-upgrade-rehearsal-"));

try {

/* ----------------------------------------------------------------- files */

// The migrations a shipped brain actually has, read from the TAG.
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

function headMigrations() {
  return readdirSync(MIG_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()
    .map((f) => {
      const sql = readFileSync(join(MIG_DIR, f), "utf8");
      return {
        version: Number.parseInt(f.split("_")[0], 10),
        name: f.replace(/\.sql$/, ""),
        sql,
        checksum: createHash("sha256").update(sql).digest("hex").slice(0, 16),
      };
    });
}

const SHIPPED = shippedMigrations();
const HEAD = headMigrations();
const HEAD_MAX = Math.max(...HEAD.map((m) => m.version));
const PENDING = HEAD.filter((m) => m.version > SHIPPED_PREFIX);

check(`the field base is the real published prefix: ${SHIPPED.length} migrations at ${FIELD_TAG}`,
  SHIPPED.length === SHIPPED_PREFIX &&
    SHIPPED.at(-1).name === "0022_document_access_passkey_observability",
  JSON.stringify({ count: SHIPPED.length, last: SHIPPED.at(-1)?.name }));

check(`and this release adds ${HEAD_MAX - SHIPPED_PREFIX}: schema ${SHIPPED_PREFIX} -> ${HEAD_MAX}`,
  PENDING.length === HEAD_MAX - SHIPPED_PREFIX && PENDING.length > 0 &&
    HEAD.map((m) => m.version).join() === HEAD.map((_, i) => i + 1).join(),
  JSON.stringify({ pending: PENDING.length, headMax: HEAD_MAX }));

// The ledger a field brain carries was written from the TAG's bytes. cmdMigrate
// refuses to continue when an applied migration's content has changed since,
// so this equality is the reason the upgrade is possible at all -- and editing
// any shipped file breaks it here rather than on a client's brain.
{
  const drifted = SHIPPED.filter((shipped) => {
    const current = HEAD.find((m) => m.version === shipped.version);
    return !current || current.checksum !== shipped.checksum;
  }).map((m) => m.name);
  check("no shipped migration has drifted, so cmdMigrate's checksum guard cannot trip in the field",
    drifted.length === 0, JSON.stringify(drifted));
}

/* -------------------------------------------------------------- fixtures */

/** cmdMigrate's transport, against real SQLite instead of D1's REST endpoint. */
function d1QueryFor(db, { swallow = null } = {}) {
  return async (_account, _database, sql, params = []) => {
    const text = String(sql).trim();
    if (swallow && swallow.has(text)) return { results: [], meta: { changes: 0 } };
    if (/^(?:SELECT|PRAGMA)\b/i.test(text)) {
      return { results: db.prepare(sql).all(...params) };
    }
    let result = null;
    if (params.length) result = db.prepare(sql).run(...params);
    else db.exec(sql);
    return { results: [], meta: { changes: Number(result?.changes || 0) } };
  };
}

const manifestPath = join(workDir, "brain.manifest.json");
writeFileSync(manifestPath, JSON.stringify({
  client: { slug: "field-rehearsal" },
  brain: { version: "0.2.0", ring: "stable" },
  infrastructure: { cloudflare: {
    account_id: "fixture-account",
    d1_database_id: "fixture-database",
    storage: "d1",
  } },
  safety: { credential_scanner: { gate_version: 0 } },
}));

const migrate = (db, options = {}) => cmdMigrate(manifestPath, {
  silent: true,
  resolveAccount: async () => ({ id: "fixture-account" }),
  d1Query: d1QueryFor(db, options),
  vectorDrainQuiesced: options.vectorDrainQuiesced !== false,
});

/**
 * A populated brain as a v0.2.0 install actually has one.
 *
 * The rows are chosen to break a careless backfill, because a fixture of tidy
 * rows would let 0034 look correct while being wrong on every real corpus:
 *
 *   - `upload` is registered with NO zone, which is the only shape that can
 *     prove 0033's replacement chunks_ai still writes the FTS row. On a zoned
 *     source the trigger's own zone UPDATE fires the pre-existing chunks_au,
 *     whose delete+insert re-indexes the row and hides a broken chunks_ai.
 *   - `legacy` appears in `documents` but was never registered in `sources`
 *     and has no corpus_stats row at all.
 *   - `mail` has one live and one soft-deleted document (a PARTIAL delete: it
 *     must stay in the inventory).
 *   - `upload`'s only document is soft-deleted, so it must LEAVE the inventory.
 *   - corpus_stats for `drive` is drifted to 99/999, and `archive` has a
 *     corpus_stats row with no live documents behind it.
 */
function buildFieldBrain() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of SHIPPED) {
    for (const statement of splitStatements(migration.sql)) db.exec(statement);
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?,?,?,?)",
    ).run(migration.version, migration.name, "2026-09-01T00:00:00Z", migration.checksum);
  }
  db.prepare(
    `INSERT INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1,'field-rehearsal','0.2.0',?,0,'2026-09-01T00:00:00Z','stable')`,
  ).run(SHIPPED_PREFIX);

  for (const [zone, label] of [["private", "Private"], ["shared", "Shared"]]) {
    db.prepare("INSERT INTO zones (zone, label, created_at) VALUES (?,?,1756684800)").run(zone, label);
  }
  for (const [name, kind, zone] of [
    ["drive", "drive", "private"],
    ["mail", "gmail", "private"],
    ["upload", "upload", null],          // unzoned on purpose, see above
    ["archive", "upload", "shared"],
  ]) {
    db.prepare(
      "INSERT INTO sources (name, kind, status, created_at, zone) VALUES (?,?,'ready','2026-09-01T00:00:00Z',?)",
    ).run(name, kind, zone);
  }

  const addDocument = (docUid, source, title, deletedAt = null) => {
    db.prepare(
      `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash, deleted_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(docUid, source, docUid, title, 1_756_684_800, `hash:${docUid}`, deletedAt);
  };
  addDocument("drive:policy", "drive", "Retention policy");
  addDocument("drive:terms", "drive", "Engagement terms");
  addDocument("drive:handbook", "drive", "Operating handbook");
  addDocument("mail:live", "mail", "An open thread");
  addDocument("mail:removed", "mail", "A withdrawn thread", 1_756_771_200);
  addDocument("upload:withdrawn", "upload", "A withdrawn upload", 1_756_771_200);
  addDocument("legacy:orphan", "legacy", "Written before the source registry");

  let ix = 0;
  for (const [docUid, source] of [
    ["drive:policy", "drive"], ["drive:policy", "drive"], ["drive:terms", "drive"],
    ["drive:handbook", "drive"], ["mail:live", "mail"], ["mail:removed", "mail"],
    ["upload:withdrawn", "upload"], ["legacy:orphan", "legacy"],
  ]) {
    const chunkUid = `${source}:corpus-${String(ix).padStart(3, "0")}#0`;
    db.prepare(
      `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, title, vector_id)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(chunkUid, docUid, ix, `corpusprobe body for ${chunkUid}`, source, docUid, chunkUid);
    ix++;
  }

  // Drifted cache, exactly what 0034 exists to repair.
  db.prepare("INSERT INTO corpus_stats (source, documents, chunks, last_ingest_at) VALUES ('drive',99,999,1756684800)").run();
  db.prepare("INSERT INTO corpus_stats (source, documents, chunks, last_ingest_at) VALUES ('mail',1,1,1756684801)").run();
  db.prepare("INSERT INTO corpus_stats (source, documents, chunks, last_ingest_at) VALUES ('upload',1,1,1756684802)").run();
  db.prepare("INSERT INTO corpus_stats (source, documents, chunks, last_ingest_at) VALUES ('archive',7,7,1756684803)").run();
  // `legacy` deliberately has NO corpus_stats row.

  // Financial rows in the tables 0026/0029 later ALTER.
  db.prepare(
    `INSERT INTO fin_accounts
       (account_slug, entity_slug, account_kind, balance_role, provenance, basis_state, recorded_at)
     VALUES ('operating','primary','checking','asset','owner_stated','confirmed','2026-09-01T00:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO fin_transactions
       (txn_uid, account_slug, posted_on, amount_minor, direction, provenance, basis_state, recorded_at)
     VALUES ('txn-0001','operating','2026-08-01',12500,'outflow','owner_stated','confirmed','2026-09-01T00:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO bank_feed_backfill (item_ref, requested_days, state, queued_at)
     VALUES ('item-0001', 720, 'running', '2026-09-01T00:00:00Z')`,
  ).run();

  return db;
}

/* ---------------------------------------------------------- row snapshots */

const userTables = (db) => probe(() => db.prepare(
  `SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'chunks_fts%'
    ORDER BY name`,
).all().map((row) => row.name), []);

const columnsOf = (db, table) => probe(
  () => db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name), []);

/** Every row of every table, projected onto the columns that existed at 22. */
function snapshotRows(db, tables = null) {
  const out = {};
  for (const table of tables ? Object.keys(tables) : userTables(db)) {
    const cols = tables ? tables[table] : columnsOf(db, table);
    if (!cols.length) { out[table] = null; continue; }
    const projection = cols.map((c) => `"${c}"`).join(",");
    out[table] = probe(
      () => db.prepare(`SELECT ${projection} FROM "${table}"`).all()
        .map((row) => JSON.stringify(cols.map((c) => row[c])))
        .sort(),
      null,
    );
  }
  return out;
}

/* ---------------------------------------------- what each migration DECLARES */

// Parsed from the migration's own SQL, so a new migration is covered the day it
// lands and the pure new-table files (0023, 0024, 0025, 0027, 0030, 0031, 0032)
// are not silently untested.
function declarationsOf(sql) {
  const objects = new Map();
  const columns = [];
  for (const statement of splitStatements(sql)) {
    const created = statement.match(
      /^\s*CREATE\s+(?:UNIQUE\s+)?(?:VIRTUAL\s+)?(TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)/i,
    );
    if (created) {
      const value = { kind: created[1].toLowerCase(), name: created[2] };
      objects.set(`${value.kind}:${value.name}`, value);
      continue;
    }
    const dropped = statement.match(
      /^\s*DROP\s+(TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+EXISTS\s+)?([A-Za-z0-9_]+)/i,
    );
    if (dropped) {
      // Temporary guards are tested at the independent statement boundaries,
      // but they are not part of the migration's final declared inventory.
      objects.delete(`${dropped[1].toLowerCase()}:${dropped[2]}`);
      continue;
    }
    const altered = statement.match(
      /^\s*ALTER\s+TABLE\s+([A-Za-z0-9_]+)\s+ADD\s+COLUMN\s+([A-Za-z0-9_]+)/i,
    );
    if (altered) columns.push({ table: altered[1], column: altered[2] });
  }
  return {
    objects: [...objects.values()],
    columns,
  };
}

const finalDeclaredObjects = new Set();
for (const migration of PENDING) {
  for (const statement of splitStatements(migration.sql)) {
    const created = statement.match(
      /^\s*CREATE\s+(?:UNIQUE\s+)?(?:VIRTUAL\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)/i,
    );
    if (created) finalDeclaredObjects.add(created[1]);
    const dropped = statement.match(
      /^\s*DROP\s+(?:TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+EXISTS\s+)?([A-Za-z0-9_]+)/i,
    );
    if (dropped) finalDeclaredObjects.delete(dropped[1]);
  }
}
const DECLARED = new Map(PENDING.map((m) => {
  const declarations = declarationsOf(m.sql);
  return [m.version, {
    ...declarations,
    objects: declarations.objects.filter((object) => finalDeclaredObjects.has(object.name)),
  }];
}));

check("every pending migration declares something this file can look for",
  [...DECLARED.values()].every((d) => d.objects.length + d.columns.length > 0),
  JSON.stringify([...DECLARED].map(([v, d]) => [v, d.objects.length, d.columns.length])));

/* ------------------------------------------------------- the battery */

/**
 * Everything that must be true of a field brain AFTER the walk.
 *
 * Returns results instead of calling check() directly so the negative control
 * can run the identical battery against a neutered walk and count failures.
 */
function evaluate(db, baseline) {
  const results = [];
  const add = (name, ok, detail = "") => results.push({ name, ok: ok === true, detail: String(detail).slice(0, 300) });

  const objects = new Set(probe(
    () => db.prepare("SELECT type||':'||name AS k FROM sqlite_master").all().map((r) => r.k), []));

  // --- every pending migration is individually load-bearing ----------------
  for (const migration of PENDING) {
    const declared = DECLARED.get(migration.version);
    const missingObjects = declared.objects
      .filter((o) => !objects.has(`${o.kind}:${o.name}`)).map((o) => `${o.kind} ${o.name}`);
    const missingColumns = declared.columns
      .filter((c) => !columnsOf(db, c.table).includes(c.column)).map((c) => `${c.table}.${c.column}`);
    add(`${migration.name} really created what it declares`,
      missingObjects.length === 0 && missingColumns.length === 0,
      JSON.stringify({ missingObjects, missingColumns }));
  }

  // --- ledger and version --------------------------------------------------
  const versions = probe(
    () => db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r.version), []);
  add(`schema_migrations is contiguous 1..${HEAD_MAX}`,
    versions.length === HEAD_MAX && versions.every((v, i) => v === i + 1),
    JSON.stringify({ count: versions.length, first: versions[0], last: versions.at(-1) }));

  const install = probe(() => db.prepare("SELECT * FROM install_state WHERE id=1").get(), null);
  add(`install_state records schema ${HEAD_MAX}`, Number(install?.schema_version) === HEAD_MAX,
    JSON.stringify({ schema_version: install?.schema_version }));
  // Migrating is not shipping. Only `upgrade` advances product_version, and
  // only after verification; a migrate that moved it would let a half-finished
  // upgrade claim the new release.
  add("cmdMigrate does NOT advance product_version", install?.product_version === "0.2.0",
    JSON.stringify({ product_version: install?.product_version }));

  // --- no pre-existing row lost or mutated ---------------------------------
  // Compared on the schema-22 column list only: the ALTERs deliberately widen
  // rows, and a new column reading NULL is not a mutated row.
  const after = snapshotRows(db, baseline.columns);
  const DELIBERATE = new Set(["install_state", "schema_migrations", "corpus_stats"]);
  const changed = Object.keys(baseline.rows).filter((table) =>
    !DELIBERATE.has(table) && JSON.stringify(after[table]) !== JSON.stringify(baseline.rows[table]));
  add("no pre-existing row is lost or mutated outside the tables a migration deliberately writes",
    changed.length === 0, JSON.stringify(changed));

  const counts = probe(() => db.prepare(
    `SELECT (SELECT count(*) FROM documents) AS documents,
            (SELECT count(*) FROM documents WHERE deleted_at IS NULL) AS live,
            (SELECT count(*) FROM chunks) AS chunks,
            (SELECT count(*) FROM vector_outbox) AS outbox,
            (SELECT count(*) FROM fin_transactions) AS txns,
            (SELECT count(*) FROM bank_feed_backfill) AS backfill`).get(), null);
  add("document, chunk, outbox and financial row counts are unchanged",
    counts !== null && JSON.stringify(counts) === JSON.stringify(baseline.counts),
    JSON.stringify({ before: baseline.counts, after: counts }));

  // --- FTS survived --------------------------------------------------------
  // Measured with MATCH and with the STRICT integrity-check. `SELECT COUNT(*)
  // FROM chunks_fts` reads through to the content table and would be green on
  // an index holding nothing; the bare integrity-check (rank 0) only proves the
  // index is well formed and also passes on an index missing rows.
  const matched = probe(
    () => db.prepare("SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'corpusprobe'").get()?.n, null);
  add("keyword search still finds every pre-existing chunk",
    Number(matched) === Number(baseline.counts?.chunks), JSON.stringify({ matched }));
  const integrity = probe(() => {
    db.exec("INSERT INTO chunks_fts(chunks_fts, rank) VALUES('integrity-check', 1)");
    return "ok";
  }, "malformed");
  add("the FTS index passes the strict content-vs-index integrity check",
    integrity === "ok", integrity);

  // --- 0034: the inventory and the reconciled cache ------------------------
  const inventory = probe(
    () => db.prepare("SELECT source FROM document_source_inventory ORDER BY source").all().map((r) => r.source),
    null);
  const liveSources = probe(
    () => db.prepare("SELECT DISTINCT source FROM documents WHERE deleted_at IS NULL ORDER BY source")
      .all().map((r) => r.source), null);
  add("document_source_inventory equals the live document sources, including one never registered in `sources`",
    inventory !== null && JSON.stringify(inventory) === JSON.stringify(liveSources) &&
      inventory.includes("legacy") && !inventory.includes("upload"),
    JSON.stringify({ inventory, liveSources }));

  // The reconcile must land on the SAME number the next ordinary ingest would
  // write, or it repairs the cache into a value the next write overwrites.
  // This is sourceStatsCommitStatement's own aggregate, from worker/src/lib/store.js.
  const cacheDrift = probe(() => db.prepare(
    `SELECT c.source AS source, c.documents AS cached_documents, c.chunks AS cached_chunks,
            COALESCE(w.documents,0) AS worker_documents, COALESCE(w.chunks,0) AS worker_chunks
       FROM corpus_stats c
       LEFT JOIN (
         SELECT documents.source AS source,
                COUNT(DISTINCT documents.doc_uid) AS documents,
                COUNT(chunks.chunk_uid) AS chunks
           FROM documents LEFT JOIN chunks ON chunks.doc_uid = documents.doc_uid
          WHERE documents.deleted_at IS NULL
          GROUP BY documents.source
       ) w ON w.source = c.source
      WHERE c.documents <> COALESCE(w.documents,0) OR c.chunks <> COALESCE(w.chunks,0)`).all(), null);
  add("corpus_stats now equals the worker's own aggregate for every source",
    Array.isArray(cacheDrift) && cacheDrift.length === 0, JSON.stringify(cacheDrift));

  const stats = probe(
    () => Object.fromEntries(db.prepare("SELECT * FROM corpus_stats").all().map((r) => [r.source, r])), null);
  add("the reconcile preserves last_ingest_at instead of inventing a freshness timestamp",
    stats?.drive?.last_ingest_at === 1756684800 && stats?.mail?.last_ingest_at === 1756684801,
    JSON.stringify({ drive: stats?.drive, mail: stats?.mail }));
  add("a source with no corpus_stats row gets one, with NULL freshness",
    stats?.legacy !== undefined && Number(stats?.legacy?.documents) === 1 &&
      (stats?.legacy?.last_ingest_at === null || stats?.legacy?.last_ingest_at === undefined),
    JSON.stringify({ legacy: stats?.legacy }));
  add("a source whose live documents are all gone is zeroed rather than left claiming a corpus",
    Number(stats?.archive?.documents) === 0 && Number(stats?.archive?.chunks) === 0 &&
      Number(stats?.upload?.documents) === 0 && Number(stats?.upload?.chunks) === 0,
    JSON.stringify({ archive: stats?.archive, upload: stats?.upload }));

  // --- 0029: three NOT NULL columns over a populated table -----------------
  const backfillCols = probe(() => db.prepare("PRAGMA table_info(bank_feed_backfill)").all(), []);
  const providerState = backfillCols.find((c) => c.name === "provider_history_state");
  add("0029's NOT NULL column landed on the populated table WITH its default",
    providerState !== undefined && Number(providerState.notnull) === 1 &&
      String(providerState.dflt_value || "").length > 0,
    JSON.stringify(providerState ?? null));
  const nulls = probe(
    () => db.prepare("SELECT count(*) AS n FROM bank_feed_backfill WHERE provider_history_state IS NULL").get()?.n,
    null);
  // `nulls` falls back to null when the probe throws, which is exactly what
  // happens if 0029 never ran and the column is absent. Number(null) === 0, so
  // the obvious form of this assertion passes when the migration does nothing.
  // Require a real count.
  add("and the pre-existing backfill row carries that default, not NULL",
    nulls !== null && nulls !== undefined && Number(nulls) === 0, JSON.stringify({ nulls }));

  // --- 0035 ---------------------------------------------------------------
  const cursorHistory = probe(
    () => db.prepare("PRAGMA table_info(plaid_sync_windows)").all().find((c) => c.name === "cursor_history_json"),
    undefined);
  add("0035's cursor_history_json is NOT NULL with a JSON default",
    cursorHistory !== undefined && Number(cursorHistory.notnull) === 1 &&
      String(cursorHistory.dflt_value || "").includes("["),
    JSON.stringify(cursorHistory ?? null));

  // The write probes come LAST on purpose: they add rows, and every reconcile
  // assertion above is a statement about the corpus as the migration found it.
  // --- 0033: new rows inherit their source's zone at the DB boundary -------
  const zoneInherit = probe(() => {
    db.prepare(
      `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash)
       VALUES ('drive:zoneprobe','drive','drive:zoneprobe','Zone probe',1756944000,'hash:zoneprobe')`).run();
    return db.prepare("SELECT zone FROM documents WHERE doc_uid='drive:zoneprobe'").get()?.zone ?? null;
  }, "threw");
  add("a document written after the walk inherits its source's zone (0033)",
    zoneInherit === "private", JSON.stringify({ zone: zoneInherit }));

  // The chunks_ai replacement, exercised on the UNZONED source. On a zoned one
  // the trigger's zone UPDATE fires chunks_au, which re-indexes the row and
  // would hide a chunks_ai that lost its FTS insert entirely.
  const unzonedIndexed = probe(() => {
    db.prepare(
      `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash)
       VALUES ('upload:ftsprobe','upload','upload:ftsprobe','FTS probe',1756944000,'hash:ftsprobe')`).run();
    db.prepare(
      `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, title, vector_id)
       VALUES ('upload:ftsprobe#0','upload:ftsprobe',0,'unzonedprobe body','upload','FTS probe','upload:ftsprobe#0')`).run();
    return db.prepare(
      "SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'unzonedprobe'").get()?.n ?? null;
  }, "threw");
  add("a chunk on an UNZONED source still reaches the FTS index (chunks_ai)",
    Number(unzonedIndexed) === 1, JSON.stringify({ found: unzonedIndexed }));

  return results;
}

function baselineOf(db) {
  const columns = Object.fromEntries(userTables(db).map((t) => [t, columnsOf(db, t)]));
  return {
    columns,
    rows: snapshotRows(db, columns),
    counts: db.prepare(
      `SELECT (SELECT count(*) FROM documents) AS documents,
              (SELECT count(*) FROM documents WHERE deleted_at IS NULL) AS live,
              (SELECT count(*) FROM chunks) AS chunks,
              (SELECT count(*) FROM vector_outbox) AS outbox,
              (SELECT count(*) FROM fin_transactions) AS txns,
              (SELECT count(*) FROM bank_feed_backfill) AS backfill`).get(),
  };
}

/* ===================================================================== 1 ==
 * FIELD-HEALTHY: a passing v0.2.0 brain crosses schema 22 to the current head.
 * ======================================================================== */
{
  const db = buildFieldBrain();
  const baseline = baselineOf(db);

  check("the fixture really is a shipped brain: schema 22, live and deleted documents, drifted cache",
    db.prepare("SELECT count(*) AS n FROM schema_migrations").get().n === SHIPPED_PREFIX &&
      Number(baseline.counts.documents) === 7 && Number(baseline.counts.live) === 5 &&
      Number(baseline.counts.chunks) === 8 &&
      db.prepare("SELECT documents FROM corpus_stats WHERE source='drive'").get().documents === 99 &&
      probe(() => db.prepare("SELECT 1 FROM document_source_inventory").get(), "absent") === "absent",
    JSON.stringify(baseline.counts));

  // The write barrier is not decorative. 0033 replaces the live FTS insert
  // trigger across two independently committed statements, so a direct migrate
  // against a brain whose Worker is still serving must be refused.
  let refusal = null;
  try {
    await migrate(db, { vectorDrainQuiesced: false });
  } catch (error) { refusal = error; }
  check("a direct `brain migrate` on a live field brain is refused and points at `brain update`",
    refusal !== null && /brain update/.test(String(refusal?.message || "")) &&
      db.prepare("SELECT count(*) AS n FROM schema_migrations").get().n === SHIPPED_PREFIX,
    JSON.stringify({ message: String(refusal?.message || "").slice(0, 200) }));

  // What `brain update` does after it has deployed the paused Worker and waited
  // out older invocations.
  const receipt = await migrate(db);
  check(`the walk applies all ${PENDING.length} pending migrations in one pass`,
    receipt.applied === PENDING.length && receipt.schemaVersion === HEAD_MAX,
    JSON.stringify(receipt));

  const results = evaluate(db, baseline);
  for (const result of results) check(result.name, result.ok, result.detail);

  // A second run must be a no-op, because a re-run is what an operator does
  // after any interrupted upgrade.
  const again = await migrate(db);
  check(`re-running the walk applies nothing and leaves the ledger at ${HEAD_MAX}`,
    again.applied === 0 && again.schemaVersion === HEAD_MAX &&
      db.prepare("SELECT count(*) AS n FROM schema_migrations").get().n === HEAD_MAX,
    JSON.stringify(again));
  db.close();
}

/* ===================================================================== 2 ==
 * FIELD-STRANDED: paused, one chunk queued before the pause. Does it get out?
 * ======================================================================== */

const addChunkFor = (db, chunkUid, source = "drive") => {
  const docUid = chunkUid.replace(/#\d+$/, "");
  db.prepare(
    `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash)
     VALUES (?,?,?,?,?,?)`).run(docUid, source, docUid, docUid, 1_756_684_800, `hash:${docUid}`);
  db.prepare(
    `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, title, vector_id)
     VALUES (?,?,0,?,?,?,?)`).run(chunkUid, docUid, `strandprobe ${chunkUid}`, source, docUid, chunkUid);
};

/**
 * The reported shape: a FINISHED bootstrap epoch, then one more chunk arriving
 * by ordinary ingest, then the upgrade pause landing while that chunk's outbox
 * row is still queued. base_count is the stale count from the finished epoch,
 * chunks has grown past it, and the current epoch owns no batches -- so
 * convergence compares a stale base against a grown corpus forever.
 */
function seedStrand(db, visible, { projected = 12, epoch = 7 } = {}) {
  for (let i = 0; i < projected; i++) {
    const chunkUid = `drive:projected-${String(i).padStart(3, "0")}#0`;
    addChunkFor(db, chunkUid);
  }
  // The earlier epoch finished, so the provider holds a vector for every chunk
  // that existed when it did -- the ones this fixture just added AND the
  // brain's original corpus. Seeding only the new ones would fake a second,
  // unrelated shortfall and let the assertions below pass for the wrong reason.
  for (const row of db.prepare("SELECT chunk_uid FROM chunks").all()) {
    visible.set(row.chunk_uid, { id: row.chunk_uid, values: [0.1], metadata: {} });
  }
  db.prepare(
    `UPDATE install_state
        SET vector_projection_status='verified',
            vector_projection_bootstrap_epoch=?1,
            vector_projection_bootstrap_cursor=(SELECT MAX(chunk_uid) FROM chunks),
            vector_projection_bootstrap_high_water=(SELECT MAX(chunk_uid) FROM chunks),
            vector_projection_bootstrap_protocol='bootstrap-v2',
            vector_projection_bootstrap_base_count=(SELECT count(*) FROM chunks)
      WHERE id=1`).run(epoch);
  const stranded = "drive:queued-before-the-pause#0";
  addChunkFor(db, stranded);
  db.prepare(
    "INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at) VALUES (?1,?1,'upsert',2000)").run(stranded);
  return stranded;
}

function pausedEnvFor(db) {
  const visible = new Map();
  let sequence = 0;
  let processedUpToMutation = null;
  const accept = (apply) => {
    const mutationId = `rehearsal-mutation-${++sequence}`;
    apply();
    processedUpToMutation = mutationId;
    return { mutationId };
  };
  const prepare = (sql) => {
    const shape = (params = []) => ({
      bind: (...next) => shape(next),
      all: async () => ({ results: db.prepare(sql).all(...params) }),
      first: async () => db.prepare(sql).get(...params) ?? null,
      run: async () => {
        const result = db.prepare(sql).run(...params);
        return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
      },
      _sql: sql,
      _params: params,
    });
    return shape();
  };
  const env = {
    VECTOR_DRAIN_MODE: "paused-for-upgrade",
    DB: {
      prepare,
      batch: async (statements) => {
        db.exec("BEGIN");
        try {
          const out = statements.map((statement) => {
            const result = db.prepare(statement._sql).run(...statement._params);
            return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
          });
          db.exec("COMMIT");
          return out;
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      },
    },
    VECTORIZE: {
      upsert: async (vectors) => accept(() => {
        for (const vector of vectors) visible.set(vector.id, structuredClone(vector));
      }),
      deleteByIds: async (ids) => accept(() => { for (const id of ids) visible.delete(id); }),
      getByIds: async (ids) => ids.map((id) => visible.get(id)).filter(Boolean),
      describe: async () => ({ vectorCount: visible.size, processedUpToMutation }),
    },
  };
  return { env, visible };
}

const bootstrapOptions = () => {
  let clock = 100_000;
  return {
    now: () => (clock += 60_000),
    embed: async () => [0.1],
    embedBatch: async (texts) => texts.map(() => [0.1]),
  };
};

const projectionOf = (db) => probe(() => db.prepare(
  `SELECT schema_version AS schema,
          vector_projection_status AS status,
          vector_projection_bootstrap_epoch AS epoch,
          vector_projection_bootstrap_cursor AS cursor,
          vector_projection_bootstrap_high_water AS high_water,
          vector_projection_bootstrap_protocol AS protocol,
          vector_projection_bootstrap_base_count AS base,
          (SELECT count(*) FROM chunks) AS chunks,
          (SELECT count(*) FROM vector_outbox) AS outbox
     FROM install_state WHERE id=1`).get(), null);

{
  const db = buildFieldBrain();
  const { env, visible } = pausedEnvFor(db);
  const stranded = seedStrand(db, visible);
  const before = projectionOf(db);

  // status is 'pending', not 'verified': the late ingest's own trigger moved it
  // there. That is precisely the reported shape -- an unverifiable projection
  // whose base_count belongs to an epoch that closed before the late chunk.
  check("the stranded fixture is the reported shape: stale base, grown corpus, one queued row",
    before.schema === SHIPPED_PREFIX && before.status === "pending" &&
      before.protocol === "bootstrap-v2" &&
      Number(before.base) === Number(before.chunks) - 1 && Number(before.outbox) === 1,
    JSON.stringify(before));

  // The recovery is migration-dependent, which nothing had tested: every drain
  // candidate query LEFT JOINs vector_outbox_retry_state, and migration 0028
  // creates it. On the schema the brain actually has, the fix is inert.
  let unmigrated = null;
  try { await acceleratedVectorBootstrap(env, bootstrapOptions()); } catch (error) { unmigrated = error; }
  check("on the un-migrated schema the recovery refuses by name instead of half-running",
    unmigrated !== null && /migrate/i.test(String(unmigrated?.message || "")),
    JSON.stringify({ message: String(unmigrated?.message || "").slice(0, 200) }));
  check("and the refusal is non-destructive: the fence and the queued row are untouched",
    JSON.stringify(projectionOf(db)) === JSON.stringify(before) && !visible.has(stranded),
    JSON.stringify(projectionOf(db)));

  await migrate(db);
  const migrated = projectionOf(db);
  // cmdMigrate's ON CONFLICT advances the independent retrieval generation in
  // addition to client/schema/gate identity. It still leaves the Vectorize
  // bootstrap fields untouched, preserving the mid-recovery fence.
  check(`the 22 -> ${HEAD_MAX} walk leaves the stranded projection fence byte-identical`,
    migrated.status === before.status && migrated.epoch === before.epoch &&
      migrated.cursor === before.cursor && migrated.high_water === before.high_water &&
      migrated.protocol === before.protocol && Number(migrated.base) === Number(before.base) &&
      Number(migrated.outbox) === Number(before.outbox) && Number(migrated.chunks) === Number(before.chunks),
    JSON.stringify({ before, migrated }));

  let receipt = null, rounds = 0;
  for (; rounds < 12 && receipt?.complete !== true; rounds++) {
    receipt = await acceleratedVectorBootstrap(env, bootstrapOptions());
  }
  const recovered = projectionOf(db);

  check("the chunk queued in the seconds before the pause is finally projected",
    Number(recovered.outbox) === 0 && visible.has(stranded),
    JSON.stringify({ recovered, visible: visible.size }));
  check("the stale base is refreshed to the whole corpus and the projection verifies",
    Number(recovered.base) === Number(recovered.chunks) && recovered.status === "verified",
    JSON.stringify(recovered));
  check("the receipt completes instead of repeating a count that never moves",
    receipt?.complete === true && receipt.confirmed === receipt.total && receipt.remaining === 0,
    JSON.stringify(receipt));
  check("the corpus-write pause is never lifted to achieve that",
    env.VECTOR_DRAIN_MODE === "paused-for-upgrade", String(env.VECTOR_DRAIN_MODE));

  // Reaching an accepting state is the point: `brain update` only deploys the
  // ACTIVE Worker (the one whose /health reports accepting_documents: true)
  // after this readiness is exact.
  env.VECTOR_DRAIN_MODE = "active";
  const readiness = await vectorReadiness(env);
  check("readiness is exact, which is what gates the active deploy that reopens document writes",
    readiness.ready === true && readiness.pending === 0 &&
      readiness.expected_vectors === readiness.actual_vectors &&
      readiness.expected_vectors === Number(recovered.chunks),
    JSON.stringify(readiness));
  db.close();
}

/* --- 2b: the adjacent shape that does NOT get out ------------------------ */
//
// KNOWN OPEN DEFECT, pinned here rather than asserted away. The residue fix
// makes the outbox reachable, but markProjectionVerifiedIfExact needs an empty
// outbox AND count(chunks) == VECTORIZE.describe().vectorCount. One vector the
// provider holds with no D1 chunk behind it therefore freezes the same brain in
// the same visible way, and docs/RECOVERY.md says provider-only excess vectors
// cannot be enumerated from D1. Measured non-convergent over 60 rounds, so this
// is a standstill and not a slow finish.
//
// TO WHOEVER SEES THIS CHECK GO RED: that means the freeze is fixed. INVERT the
// assertion to demand convergence. Do not loosen it, and do not delete it.
{
  const db = buildFieldBrain();
  const { env, visible } = pausedEnvFor(db);
  const stranded = seedStrand(db, visible);
  visible.set("provider-only-excess", { id: "provider-only-excess", values: [0.1], metadata: {} });
  await migrate(db);

  let receipt = null;
  for (let round = 0; round < 6 && receipt?.complete !== true; round++) {
    receipt = await acceleratedVectorBootstrap(env, bootstrapOptions());
  }
  const frozen = projectionOf(db);
  check("DEFECT (open): one provider-only excess vector refreezes the same brain after the residue drains",
    receipt?.complete === false && Number(frozen.outbox) === 0 && visible.has(stranded) &&
      frozen.status === "pending" && Number(frozen.base) < Number(frozen.chunks),
    JSON.stringify({ receipt, frozen }));
  check("the receipt carries the evidence (expected < actual) even though the stall message does not",
    Number(receipt?.expected_vectors) === Number(frozen.chunks) &&
      Number(receipt?.actual_vectors) === Number(frozen.chunks) + 1 &&
      receipt?.vector_ready === false,
    JSON.stringify({
      expected: receipt?.expected_vectors, actual: receipt?.actual_vectors,
      ready: receipt?.vector_ready,
    }));
  db.close();
}

/* ===================================================================== 3 ==
 * NEGATIVE CONTROL. If every pending migration silently did nothing, this
 * file must FAIL.
 * ======================================================================== */

// "Did nothing" is modelled honestly: the real cmdMigrate runs, the ledger row
// is still written and install_state still moves to the derived current head,
// but the neutered file's
// own statements are swallowed on the way to the database. That is exactly the
// state a migration that ran and had no effect would leave behind, and it is
// the state a ledger-only assertion cannot see.
const STATEMENT_OWNERS = new Map();
for (const migration of PENDING) {
  for (const statement of splitStatements(migration.sql)) {
    const text = statement.trim();
    const owners = STATEMENT_OWNERS.get(text) || new Set();
    owners.add(migration.version);
    STATEMENT_OWNERS.set(text, owners);
  }
}

function statementsOf(versions) {
  const set = new Set();
  for (const migration of PENDING.filter((m) => versions.has(m.version))) {
    for (const statement of splitStatements(migration.sql)) {
      const text = statement.trim();
      const owners = STATEMENT_OWNERS.get(text);
      // A shared idempotent guard is not uniquely owned by either migration.
      // Swallow it only when every migration that contains it is being
      // neutered; otherwise a single-file mutation would also alter a later
      // migration and falsely attribute that failure to the selected file.
      if ([...owners].every((version) => versions.has(version))) set.add(text);
    }
  }
  return set;
}

{
  // A statement shared verbatim by two pending migrations would neuter both and
  // make the per-migration control lie about which one is load-bearing.
  const seen = new Map();
  const collisions = [];
  for (const migration of PENDING) {
    for (const statement of splitStatements(migration.sql)) {
      const text = statement.trim();
      if (seen.has(text) && seen.get(text) !== migration.version) collisions.push(text.slice(0, 60));
      seen.set(text, migration.version);
    }
  }
  const unsafeCollisions = [...STATEMENT_OWNERS.entries()]
    .filter(([, owners]) => owners.size > 1)
    .map(([text]) => text)
    .filter((text) => !/^DROP\s+(?:TABLE|INDEX|TRIGGER|VIEW)\s+IF\s+EXISTS\b/i.test(text));
  check("shared migration statements are only idempotent drop guards and single-migration neutering stays exact",
    unsafeCollisions.length === 0, JSON.stringify({ collisions, unsafeCollisions }));
}

// Neutering a migration that a later one builds on makes the WALK itself throw
// (0029 alters a table 0026 creates). That is a load-bearing signal too. Keep
// the read-only state battery as well: a late post-migration finalizer can fail
// after the ledger reaches the head, and the negative control must still prove
// that the schema itself is absent rather than treating that finalizer as the
// only failure.
async function walkSwallowing(swallow) {
  const db = buildFieldBrain();
  try {
    const baseline = baselineOf(db);
    let walkError = null;
    try {
      await migrate(db, { swallow });
    } catch (error) {
      walkError = { name: "the walk itself could not complete", ok: false,
        detail: String(error?.message || error).slice(0, 200) };
    }
    const results = evaluate(db, baseline);
    if (walkError) results.push(walkError);
    return results;
  } finally { db.close(); }
}

const neuteredWalk = (versions) => walkSwallowing(statementsOf(versions));

/** Swallow only the pending statements matching a predicate. */
function statementsMatching(predicate) {
  const set = new Set();
  for (const migration of PENDING) {
    for (const statement of splitStatements(migration.sql)) {
      const text = statement.trim();
      if (predicate(text, migration)) set.add(text);
    }
  }
  return set;
}

{
  const all = new Set(PENDING.map((m) => m.version));
  const results = await neuteredWalk(all);
  const failed = results.filter((r) => !r.ok);
  check(`negative control: with all ${all.size} pending migrations neutered, the battery FAILS`,
    failed.length > 0,
    `${failed.length}/${results.length} failed`);
  // Older heads can still report success and advance the ledger even when all
  // migration statements were swallowed. The current head adds a post-migration
  // key finalizer, so a missing map table instead stops the walk before it can
  // make that false claim. Both outcomes prove that ledger rows alone are not
  // accepted as real state.
  const ledgerChecks = results.filter((r) => /contiguous|records schema/.test(r.name));
  const finalizerRefusal = results.find((r) => r.name === "the walk itself could not complete");
  check("and it fails on real state instead of trusting the migration ledger alone",
    (ledgerChecks.length === 2 && ledgerChecks.every((r) => r.ok)) ||
      /owner_financial_map_key_state|source_original_retrieval_generation/.test(finalizerRefusal?.detail || ""),
    JSON.stringify(finalizerRefusal || ledgerChecks));

  const silent = [];
  const howItBreaks = {};
  for (const migration of PENDING) {
    const single = await neuteredWalk(new Set([migration.version]));
    const broke = single.filter((r) => !r.ok);
    if (!broke.length) silent.push(migration.name);
    else howItBreaks[migration.version] = broke.length === 1 &&
      broke[0].name === "the walk itself could not complete"
      ? "a later migration cannot even apply without it"
      : `${broke.length} assertion(s) fail`;
  }
  check(`every one of the ${PENDING.length} pending migrations is individually load-bearing`,
    silent.length === 0, JSON.stringify({ silent, howItBreaks }));
}

// Whole-file neutering can fail for a shallow reason: 0034 declares a table, so
// removing the file removes the table and every assertion about it collapses
// together. These three mutations keep each file's DDL and remove only the
// behaviour, which is the only way to know the BEHAVIOURAL assertions above are
// load-bearing rather than riding on an existence check.
{
  const named = (results, needle) => results.find((r) => r.name.includes(needle));

  const cacheOnly = await walkSwallowing(statementsMatching(
    (text, m) => m.version === 34 && /corpus_stats/.test(text) && /^(?:UPDATE|INSERT)\b/i.test(text)));
  check("mutation: drop only 0034's corpus_stats reconcile and the cache assertion is the one that fails",
    named(cacheOnly, "equals the worker's own aggregate")?.ok === false &&
      named(cacheOnly, "really created what it declares")?.ok === true,
    JSON.stringify(cacheOnly.filter((r) => !r.ok).map((r) => r.name)));

  const inventoryOnly = await walkSwallowing(statementsMatching(
    (text, m) => m.version === 34 && /document_source_inventory/.test(text) &&
      /^(?:DELETE|INSERT)\b/i.test(text)));
  check("mutation: drop only 0034's inventory backfill and the inventory assertion is the one that fails",
    named(inventoryOnly, "document_source_inventory equals")?.ok === false,
    JSON.stringify(inventoryOnly.filter((r) => !r.ok).map((r) => r.name)));

  // 0033 DROPs the original chunks_ai and creates its own. Swallow only the
  // CREATE and the brain keeps its FTS triggers for updates and deletes while
  // silently indexing nothing new -- the exact failure 0004's own comment warns
  // about, and the one `SELECT COUNT(*) FROM chunks_fts` cannot see.
  const noChunksAi = await walkSwallowing(statementsMatching(
    (text, m) => m.version === 33 && /^CREATE\s+TRIGGER\s+chunks_ai\b/i.test(text)));
  check("mutation: drop only 0033's chunks_ai and the unzoned FTS probe is the one that fails",
    named(noChunksAi, "UNZONED source still reaches the FTS index")?.ok === false &&
      named(noChunksAi, "keyword search still finds every pre-existing chunk")?.ok === true,
    JSON.stringify(noChunksAi.filter((r) => !r.ok).map((r) => r.name)));
}

// 0029 adds three NOT NULL columns to a table that already has rows. That is
// legal only because each carries a DEFAULT on the following line. Strip one
// and SQLite refuses, which is the proof that the DEFAULT is load-bearing
// rather than decorative.
{
  const db = buildFieldBrain();
  const source = PENDING.find((m) => m.version === 29);
  const statements = splitStatements(source.sql);
  const target = statements.find((s) => /bank_feed_backfill\s+ADD\s+COLUMN/i.test(s));
  const stripped = target.replace(/DEFAULT\s+'[^']*'/i, "");
  // Everything 0023..0028 first, so 0029 lands on the schema it expects.
  for (const migration of PENDING.filter((m) => m.version < 29)) {
    for (const statement of splitStatements(migration.sql)) db.exec(statement);
  }
  let error = null;
  try { db.exec(stripped); } catch (caught) { error = caught; }
  check("0029's NOT NULL columns are safe BECAUSE of their defaults: removing one is refused on a populated table",
    error !== null && /NOT NULL column with default value NULL/i.test(String(error?.message || "")),
    JSON.stringify({ statement: stripped.trim().slice(0, 90), message: String(error?.message || "") }));
  db.close();
}

console.log(`\n${ran - fail}/${ran} checks passed`);
if (fail) process.exitCode = 1;

} finally {
  rmSync(workDir, { recursive: true, force: true });
}
