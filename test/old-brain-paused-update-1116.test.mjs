/**
 * A 0.3.5 Brain (schema 22) through `brain update`, with the REAL Worker
 * answering the REAL health check, over one sqlite database.
 *
 * Field fact, 2026-11-16 Pro rehearsal (test account): a fresh 0.3.5 Brain was
 * updated with the 0.4.28 CLI and stopped at "paused vector-drain health
 * verification: documents endpoint 500, so authenticated access was not
 * proven". The paused 0.4.28 Worker read document_source_inventory, which only
 * migration 0034 creates, and update deploys that Worker before it migrates.
 * The Brain was left paused, and a rerun died at its first backlog read on the
 * same 500 ("database busy"), so no rerun could ever finish it.
 *
 * test/healthy-schema22-update-rehearsal.test.mjs fakes cmdHealth, which is why
 * nothing caught this. Here cmdUpgrade, cmdMigrate, cmdHealth and
 * readUpdateBacklog are the real ones, the Worker is the real worker.fetch,
 * and Cloudflare is replaced only at the transport: Worker uploads switch which
 * in-process build answers and its VECTOR_DRAIN_MODE, and D1 queries run on
 * the same database the Worker reads.
 *
 * "The Worker before this fix" is the real Worker with its pre-0034 fallback
 * statement refused, so this route behaves exactly as 0.4.22 through 0.4.28 rc4
 * do on an old schema; every other read is the real code.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { isolateUpdateSchedulers, isolatedUpdateSchedulerOptions } from "./fixtures/isolated-update-schedulers.mjs";
import { createUpgradeBookmarkWriter } from "./fixtures/upgrade-bookmark-writer.mjs";
import {
  cmdHealth,
  cmdMigrate,
  cmdUpdate as cmdUpdateWithNativeSchedulers,
  cmdUpgrade,
  commitManifestVersion,
  readUpdateBacklog,
  splitStatements,
} from "../brain.mjs";
import worker from "../worker/src/index.js";
import { documentSourceInventoryMissing, documentsSummarySqlForTest } from "../worker/src/lib/documents-summary.js";

const cmdUpdate = isolateUpdateSchedulers(cmdUpdateWithNativeSchedulers);

const PRODUCT_VERSION = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
).version;
const ACCOUNT_ID = "3c9a71b0e4d5426f8a1b7c0d9e2f3a4b";
const DATABASE_ID = "8f2b1c4d-5e6a-4b7c-9d0e-1f2a3b4c5d6e";
const DOMAIN = "riverbend-brain.owner-subdomain.workers.dev";
const ADMIN_KEY = randomBytes(32).toString("hex");
const V035_SCHEMA = 22;
// sha256 over "<file name>\0<bytes>\0" for migrations/d1/0001..0022 at the
// v0.3.5 tag (3460e8f357b7fc9f9f9cfd81708464da828da93b), read 2026-11-16.
const V035_MIGRATION_SET_SHA256 = "9013b152b7865d3fac8d50d8586e0b5cdea4ff3dcf2f5057e3533a5cb482f927";
// The stop the Pro rehearsal printed, word for word after the stage name.
const FIELD_STOP = "update stopped during paused vector-drain health verification: documents endpoint 500, so authenticated access was not proven.";

const migrationDir = fileURLToPath(new URL("../migrations/d1/", import.meta.url));
const migrations = readdirSync(migrationDir)
  .filter((name) => /^\d{4}_.*\.sql$/.test(name))
  .sort()
  .map((name) => {
    const bytes = readFileSync(join(migrationDir, name));
    const sql = bytes.toString("utf8");
    return {
      name,
      bytes,
      version: Number(name.slice(0, 4)),
      ledgerName: name.replace(/\.sql$/, ""),
      sql,
      checksum: createHash("sha256").update(sql).digest("hex").slice(0, 16),
    };
  });
const LATEST_SCHEMA = migrations.at(-1).version;

function silently(run) {
  const prior = { log: console.log, warn: console.warn, error: console.error };
  const output = [];
  const capture = (...values) => output.push(values.map(String).join(" ").replace(/\x1b\[[0-9;]*m/g, ""));
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  return Promise.resolve()
    .then(run)
    .finally(() => Object.assign(console, prior))
    .then((value) => ({ value, output }), (error) => { error.output = output; throw error; });
}

/** A 0.3.5 Brain as it stands: 22 migrations, a drained corpus, a verified projection. */
function v035Brain({ schema = V035_SCHEMA, productVersion = "0.3.5", queuedOutboxRow = false } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL,
    applied_at TEXT NOT NULL, checksum TEXT NOT NULL)`);
  for (const migration of migrations.filter((m) => m.version <= schema)) {
    for (const statement of splitStatements(migration.sql)) db.exec(statement);
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?,?,?,?)")
      .run(migration.version, migration.ledgerName, "2026-09-01T00:00:00Z", migration.checksum);
  }
  db.prepare(
    `INSERT INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring,
        vector_drain_lease_owner, vector_drain_lease_expires_at, vector_projection_status)
     VALUES (1, 'riverbend', ?, ?, 4, '2026-09-01T00:00:00Z', 'stable', NULL, NULL, 'verified')`,
  ).run(productVersion, schema);
  const now = Date.now();
  const insertDocument = db.prepare(
    `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertDocument.run("drive:inv-4471", "drive", "inv-4471", "Harbor Lane Plumbing invoice INV-4471", now, "h:1", null);
  insertDocument.run("drive:tax-2025", "drive", "tax-2025", "Orchard Way 2025 property tax bill", now, "h:2", null);
  // A source whose only document was forgotten: it keeps a corpus_stats row
  // but has no live documents, so the summary must say so.
  insertDocument.run("upload:old", "upload", "old", "A forgotten upload", now - 86_400_000, "h:3", now - 3_600_000);
  const insertChunk = db.prepare(
    `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, vector_id) VALUES (?, ?, 0, ?, ?, ?)`,
  );
  insertChunk.run("drive:inv-4471#0", "drive:inv-4471", "Invoice INV-4471 total due $1,284.50", "drive", "drive:inv-4471#0");
  insertChunk.run("drive:tax-2025#0", "drive:tax-2025", "Property tax 2025 amount $3,912.00", "drive", "drive:tax-2025#0");
  // Later schemas keep corpus_stats by trigger; a 0.3.5 Worker wrote it itself.
  const stats = db.prepare(
    `INSERT INTO corpus_stats (source, documents, chunks, last_ingest_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (source) DO UPDATE SET documents = excluded.documents, chunks = excluded.chunks,
                                        last_ingest_at = excluded.last_ingest_at`,
  );
  stats.run("drive", 2, 2, now);
  stats.run("upload", 0, 0, now - 86_400_000);
  if (schema >= 13) {
    db.prepare("UPDATE install_state SET vector_projection_bootstrap_base_count = 2 WHERE id = 1").run();
  }
  if (queuedOutboxRow) {
    db.prepare(
      `INSERT INTO vector_outbox (chunk_uid, op, queued_at, attempts, vector_id, generation)
       VALUES ('drive:tax-2025#0', 'upsert', ?, 0, 'drive:tax-2025#0', 1)`,
    ).run(now);
  }
  return db;
}

/** The Worker's D1 binding over sqlite; every prepared statement is recorded. */
function d1Binding(db, preparedSql = []) {
  const execute = (sql, params, mode) => {
    const statement = db.prepare(sql);
    if (mode === "first") return statement.get(...params) ?? null;
    if (statement.columns().length) return { results: statement.all(...params), success: true, meta: { changes: 0 } };
    const result = statement.run(...params);
    return { results: [], success: true, meta: { changes: Number(result.changes || 0) } };
  };
  const prepared = (sql, params = []) => ({
    bind: (...next) => prepared(sql, next),
    all: async () => execute(sql, params, "all"),
    first: async () => execute(sql, params, "first"),
    run: async () => execute(sql, params, "run"),
    raw: async () => execute(sql, params, "all").results.map((row) => Object.values(row)),
    execute: () => execute(sql, params, "all"),
  });
  return {
    prepare(sql) {
      preparedSql.push(sql);
      return prepared(sql);
    },
    async batch(statements) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => statement.execute());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/** The Worker before this fix: its pre-0034 fallback is not there, so the 0034 error reaches the router. */
function withoutPreInventoryFallback(binding) {
  return {
    ...binding,
    prepare(sql) {
      if (sql === documentsSummarySqlForTest.preInventoryHot) {
        const refused = async () => {
          throw new Error("D1_ERROR: no such table: document_source_inventory: SQLITE_ERROR");
        };
        return { bind: () => ({ all: refused, first: refused, run: refused }), all: refused, first: refused, run: refused };
      }
      return binding.prepare(sql);
    },
  };
}

const BUILDS = Object.freeze({ fixed: "fixed", beforeFix: "before-fix" });

/** One Brain's Cloudflare side: the database, and whichever Worker build is deployed. */
function brainHost(db) {
  const preparedSql = [];
  const deployment = { build: null, mode: "active", uploads: [] };
  const env = () => {
    const binding = d1Binding(db, preparedSql);
    return {
      STORAGE: "d1",
      ADMIN_KEY,
      BRAIN_OWNER: "Fixture Owner",
      ANSWER_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      ...(deployment.mode === "paused-for-upgrade" ? { VECTOR_DRAIN_MODE: "paused-for-upgrade" } : {}),
      DB: deployment.build === BUILDS.beforeFix ? withoutPreInventoryFallback(binding) : binding,
      VECTORIZE: {
        describe: async () => ({ vectorCount: db.prepare("SELECT COUNT(*) AS n FROM chunks").get().n }),
        query: async () => ({ matches: [] }),
      },
      AI: { run: async () => ({ data: [[0.1]] }) },
    };
  };
  const requests = [];
  const transport = async (url, init = {}) => {
    const target = new URL(url);
    if (target.hostname !== DOMAIN) throw new Error(`unexpected host ${target.hostname}`);
    if (deployment.build === null) throw new Error("the 0.3.5 Worker is not simulated; inject that read");
    requests.push(`${init.method || "GET"} ${target.pathname} (${deployment.build}/${deployment.mode})`);
    return worker.fetch(new Request(target.href, {
      method: init.method || "GET",
      headers: init.headers,
      ...(init.body ? { body: init.body } : {}),
    }), env(), { waitUntil() {} });
  };
  return { db, deployment, env, transport, requests, preparedSql };
}

function v035Manifest() {
  return {
    $schema: "../manifest.schema.json",
    manifest_version: 1,
    client: { slug: "riverbend", display_name: "Riverbend Studio, Inc", primary_contact: "", timezone: "America/Chicago" },
    brain: { version: "0.3.5", domain: DOMAIN, worker_name: "riverbend-brain" },
    infrastructure: {
      cloudflare: {
        account_id: ACCOUNT_ID,
        storage: "d1",
        d1_database_name: "riverbend-brain",
        d1_database_id: DATABASE_ID,
        vectorize_index: "riverbend-brain",
        drain_cron: "* * * * *",
        kv_namespace: "BRAIN_KV",
        kv_namespace_id: "0123456789abcdef0123456789abcdef",
      },
    },
    corpora: { google_drive: { enabled: true }, upload: { enabled: true } },
    retrieval: { answer_model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", rerank: false, chunk_size: 1500, chunk_overlap: 300 },
    safety: { credential_scanner: { enabled: true, gate_version: 4, mode: "refuse" }, daily_llm_spend_cap_usd: 10 },
    operations: { admin_key_secret: "keychain://financial-brain-fixture/admin-key", ingest_cron: "0 9 * * *" },
    access: { model: "single_tenant_all_access", authorized_emails: [] },
  };
}

function sandboxManifest() {
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "old-brain-paused-update-")));
  const manifestPath = join(sandbox, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify(v035Manifest(), null, 2) + "\n");
  return { sandbox, manifestPath, cleanup: () => rmSync(sandbox, { recursive: true, force: true }) };
}

/** The CLI's D1 query over the same database. */
function cliD1(db, sqlLog = []) {
  return async (accountId, databaseId, sql, params = []) => {
    assert.equal(accountId, ACCOUNT_ID);
    assert.equal(databaseId, DATABASE_ID);
    sqlLog.push(sql.replace(/\s+/g, " ").trim());
    const statement = db.prepare(sql);
    if (statement.columns().length) return { results: statement.all(...params), success: true };
    const result = statement.run(...params);
    return { results: [], success: true, meta: { changes: Number(result.changes || 0) } };
  };
}

/** The real cmdHealth, bound to the in-process Worker. */
function healthAgainst(host) {
  return (path, options = {}) => cmdHealth(path, {
    ...options,
    request: host.transport,
    resolveKey: () => ADMIN_KEY,
    wait: async () => {},
  });
}

function upgradeOptions(host, { uploadedBuild, readUpdateBacklog: backlogReader, sqlLog = [], timeline = [] }) {
  const d1Query = cliD1(host.db, sqlLog);
  const bookmarkWriter = createUpgradeBookmarkWriter();
  const options = {
    saveUpgradeBookmark: bookmarkWriter.saveUpgradeBookmark,
    resolveAccount: async () => ({ id: ACCOUNT_ID, name: "Riverbend Studio" }),
    d1Query,
    cf: async (path) => {
      if (path.endsWith("/time_travel/bookmark")) {
        return { bookmark: "00000085-00000002-00004e1e-aaaaaaaabbbbccccddddeeeeffff0000" };
      }
      throw new Error(`unexpected Cloudflare call ${path}`);
    },
    cmdMigrate: async (path, migrateOptions = {}) => {
      timeline.push("migrate");
      return cmdMigrate(path, {
        ...migrateOptions,
        silent: true,
        resolveAccount: async () => ({ id: ACCOUNT_ID, name: "Riverbend Studio" }),
        d1Query,
      });
    },
    // A Worker upload switches which in-process build answers, and its mode.
    cmdDeploy: async (_path, deployOptions = {}) => {
      const mode = deployOptions.pauseVectorDrainForUpgrade === true ? "paused-for-upgrade" : "active";
      host.deployment.build = uploadedBuild;
      host.deployment.mode = mode;
      host.deployment.uploads.push(`${uploadedBuild}/${mode}`);
      timeline.push(`deploy:${mode}`);
      return { ok: true };
    },
    readUpdateBacklog: backlogReader,
    updateBacklogOptions: {
      http: host.transport,
      resolveAdminKey: () => ADMIN_KEY,
      sleep: async () => { timeline.push("backlog retry sleep"); },
    },
    cmdHealth: async (path, healthOptions = {}) => {
      timeline.push(`health:${healthOptions.expectDrainMode || "none"}`);
      return healthAgainst(host)(path, healthOptions);
    },
    cmdBootstrap: async () => {
      timeline.push("bootstrap");
      return { epoch: 0, total: 0, confirmed: 0, remaining: 0, rounds: 1, complete: true, vector_ready: true };
    },
    reconcileWorkerProviderSecrets: async () => ({ reconciled: 0 }),
    cmdDrain: async () => { timeline.push("drain"); return { remaining: 0 }; },
    cmdTest: async () => { timeline.push("acceptance"); return { ok: true }; },
    commitManifestVersion,
    waitForVectorDrainQuiescence: async () => {},
  };
  return { options, bookmarkWriter };
}

async function runUpgrade(host, manifestPath, settings) {
  const timeline = [];
  const sqlLog = [];
  const { options } = upgradeOptions(host, { ...settings, timeline, sqlLog });
  let error = null;
  let output = [];
  try {
    ({ output } = await silently(() => cmdUpgrade(manifestPath, options)));
  } catch (caught) {
    error = caught;
    output = caught.output || [];
  }
  return { error, timeline, sqlLog, output };
}

function brainState(db) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  return {
    ...db.prepare("SELECT product_version, schema_version FROM install_state WHERE id = 1").get(),
    ledger: db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n,
    hasInventory: tables.has("document_source_inventory"),
    documents: db.prepare("SELECT COUNT(*) AS n FROM documents").get().n,
    chunks: db.prepare("SELECT COUNT(*) AS n FROM chunks").get().n,
    runs: db.prepare("SELECT status, detail FROM upgrade_runs ORDER BY id").all().map((row) => ({ ...row })),
  };
}

const getDocuments = (host) => host.transport(`https://${DOMAIN}/api/admin/brain/documents`, {
  headers: { "X-Admin-Key": ADMIN_KEY },
});

/* ------------------------------------------------------------- the schema -- */

test("the fixture schema is byte-for-byte the v0.3.5 migration set, and it has no source inventory", () => {
  const set = migrations.filter((m) => m.version <= V035_SCHEMA);
  assert.equal(set.length, 22);
  const hash = createHash("sha256");
  for (const migration of set) {
    hash.update(`${migration.name}\0`);
    hash.update(migration.bytes);
    hash.update("\0");
  }
  assert.equal(hash.digest("hex"), V035_MIGRATION_SET_SHA256);
  const db = v035Brain();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
  assert.equal(tables.includes("document_source_inventory"), false);
  // The field cause, reproduced: the 0034-era hot summary cannot run here.
  let missing = null;
  try { db.prepare(documentsSummarySqlForTest.hot).all(); } catch (error) { missing = error; }
  assert.match(String(missing?.message), /no such table: document_source_inventory/);
  db.close();
  // The Worker recognizes both this sqlite text and D1's wrapped form, and nothing else.
  assert.equal(documentSourceInventoryMissing(missing), true);
  assert.equal(documentSourceInventoryMissing(new Error("D1_ERROR: no such table: document_source_inventory: SQLITE_ERROR")), true);
  assert.equal(documentSourceInventoryMissing(new Error("D1_ERROR: no such table: documents: SQLITE_ERROR")), false);
  assert.equal(documentSourceInventoryMissing(new Error("D1_ERROR: no such column: inventory.source")), false);
});

/* -------------------------------------------------------- the Worker route -- */

test("the paused Worker serves its authenticated documents receipt over a schema-22 Brain", async () => {
  const host = brainHost(v035Brain());
  host.deployment.build = BUILDS.fixed;
  host.deployment.mode = "paused-for-upgrade";
  const response = await getDocuments(host);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.version, PRODUCT_VERSION);
  assert.equal(body.backend, "d1");
  assert.equal(body.vector_drain_mode, "paused-for-upgrade");
  assert.deepEqual(body.rows.map((row) => [row.source_type, row.has_documents]), [["drive", true], ["upload", false]]);
  assert.ok(body.rows.every((row) => row.documents === null && row.document_counts_exact === false));
  assert.equal(body.summary.status, "informational");
  assert.equal(body.vector_backlog.pending, 0);
  assert.equal(body.vector_readiness.ready, true, JSON.stringify(body.vector_readiness));
  assert.equal(body.vector_readiness.expected_vectors, 2);
  assert.ok(host.preparedSql.includes(documentsSummarySqlForTest.preInventoryHot));
  host.db.close();
});

test("before this fix the same paused route answered the field 500", async () => {
  const host = brainHost(v035Brain());
  host.deployment.build = BUILDS.beforeFix;
  host.deployment.mode = "paused-for-upgrade";
  const response = await getDocuments(host);
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /no such table: document_source_inventory/);
  host.db.close();
});

test("the exact documents report also counts a schema-22 Brain", async () => {
  const host = brainHost(v035Brain());
  host.deployment.build = BUILDS.fixed;
  host.deployment.mode = "paused-for-upgrade";
  const response = await host.transport(`https://${DOMAIN}/api/admin/brain/documents/report`, {
    method: "POST",
    headers: { "X-Admin-Key": ADMIN_KEY, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  const drive = body.rows.find((row) => row.source_type === "drive");
  const upload = body.rows.find((row) => row.source_type === "upload");
  assert.equal(drive.documents, 2);
  assert.equal(drive.chunks, 2);
  assert.equal(upload.documents, 0);
  assert.ok(host.preparedSql.includes(documentsSummarySqlForTest.preInventoryReportSourceNames));
  host.db.close();
});

test("a current schema never takes the fallback and reports the same sources", async () => {
  const db = v035Brain({ schema: LATEST_SCHEMA, productVersion: PRODUCT_VERSION });
  const host = brainHost(db);
  host.deployment.build = BUILDS.fixed;
  const response = await getDocuments(host);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body.rows.map((row) => [row.source_type, row.has_documents]), [["drive", true], ["upload", false]]);
  assert.ok(host.preparedSql.includes(documentsSummarySqlForTest.hot));
  assert.equal(host.preparedSql.includes(documentsSummarySqlForTest.preInventoryHot), false);
  db.close();
});

test("the pre-0034 summary is source-sized: one live-document index seek per source", () => {
  const db = v035Brain();
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${documentsSummarySqlForTest.preInventoryHot}`).all()
    .map((row) => row.detail).join("\n");
  assert.match(plan, /SCAN stats|SCAN corpus_stats/);
  assert.match(plan, /SEARCH live USING (?:COVERING )?INDEX idx_documents_(?:live|source)/, plan);
  assert.doesNotMatch(plan, /SCAN live\b|SCAN documents\b/, plan);
  db.close();
});

/* ---------------------------------------------------------- the real health -- */

test("real paused health verification passes on schema 22 and failed there before this fix", async () => {
  const { manifestPath, cleanup } = sandboxManifest();
  try {
    const fixed = brainHost(v035Brain());
    fixed.deployment.build = BUILDS.fixed;
    fixed.deployment.mode = "paused-for-upgrade";
    await silently(() => healthAgainst(fixed)(manifestPath, {
      expectVersion: PRODUCT_VERSION,
      expectDrainMode: "paused-for-upgrade",
      reachOnly: true,
      requireProjectionReady: true,
    }));
    fixed.db.close();

    const before = brainHost(v035Brain());
    before.deployment.build = BUILDS.beforeFix;
    before.deployment.mode = "paused-for-upgrade";
    await assert.rejects(silently(() => healthAgainst(before)(manifestPath, {
      expectVersion: PRODUCT_VERSION,
      expectDrainMode: "paused-for-upgrade",
      reachOnly: true,
      requireProjectionReady: true,
    })), (error) => error.message.startsWith("documents endpoint 500, so authenticated access was not proven."));
    before.db.close();
  } finally {
    cleanup();
  }
});

/* --------------------------------------------------------- the real update -- */

test("a 0.3.5 Brain updates to this release with the real paused Worker proving the gate", async () => {
  const { manifestPath, cleanup } = sandboxManifest();
  const host = brainHost(v035Brain());
  try {
    const run = await runUpgrade(host, manifestPath, {
      uploadedBuild: BUILDS.fixed,
      // The 0.3.5 Worker's own empty receipt is not simulated here.
      readUpdateBacklog: async () => ({ pending: 0 }),
    });
    assert.equal(run.error, null, run.error?.message);
    assert.deepEqual(run.timeline.slice(0, 4), [
      "deploy:paused-for-upgrade",
      "health:paused-for-upgrade",
      "migrate",
      "bootstrap",
    ]);
    assert.ok(run.timeline.indexOf("deploy:active") > run.timeline.indexOf("migrate"));
    assert.ok(run.timeline.includes("health:active"));
    const state = brainState(host.db);
    assert.equal(state.product_version, PRODUCT_VERSION);
    assert.equal(state.schema_version, LATEST_SCHEMA);
    assert.equal(state.ledger, migrations.length);
    assert.equal(state.hasInventory, true);
    assert.deepEqual([state.documents, state.chunks], [3, 2]);
    assert.deepEqual(state.runs.map((row) => row.status), ["verified"]);
    assert.equal(host.deployment.mode, "active");
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).brain.version, PRODUCT_VERSION);
  } finally {
    host.db.close();
    cleanup();
  }
});

test("the field stop, reproduced, and a rerun of the fixed update finishes the Brain it left paused", async () => {
  const { manifestPath, cleanup } = sandboxManifest();
  const host = brainHost(v035Brain());
  try {
    // 1. The Pro rehearsal: the uploaded paused Worker cannot read schema 22.
    const failed = await runUpgrade(host, manifestPath, {
      uploadedBuild: BUILDS.beforeFix,
      readUpdateBacklog: async () => ({ pending: 0 }),
    });
    assert.ok(failed.error?.message.includes(FIELD_STOP), failed.error?.message);
    assert.ok(failed.error.message.includes("THIS BRAIN CANNOT ACCEPT DOCUMENTS RIGHT NOW."));
    assert.equal(failed.timeline.includes("migrate"), false);
    let state = brainState(host.db);
    assert.equal(state.schema_version, V035_SCHEMA);
    assert.equal(state.product_version, "0.3.5");
    assert.equal(state.hasInventory, false);
    assert.deepEqual(state.runs, [{ status: "failed", detail: "stage:paused vector-drain health verification" }]);
    assert.deepEqual([host.deployment.build, host.deployment.mode], [BUILDS.beforeFix, "paused-for-upgrade"]);
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).brain.version, "0.3.5");

    // 2. The rerun with the fixed release. Its pre-pause backlog read is the
    //    real reader against the stuck Worker: one 500, then the public health
    //    receipt and the D1 queue, with no busy-database retries.
    const firstRunRequests = host.requests.length;
    const rerun = await runUpgrade(host, manifestPath, {
      uploadedBuild: BUILDS.fixed,
      readUpdateBacklog,
    });
    assert.equal(rerun.error, null, rerun.error?.message);
    assert.equal(rerun.timeline.includes("backlog retry sleep"), false);
    const rerunRequests = host.requests.slice(firstRunRequests);
    assert.deepEqual(rerunRequests.filter((line) => line.includes("(before-fix/")), [
      "GET /api/admin/brain/documents (before-fix/paused-for-upgrade)",
      "GET /health (before-fix/paused-for-upgrade)",
    ]);
    assert.ok(rerun.sqlLog.some((sql) => sql.includes("FROM (SELECT 1 FROM vector_outbox LIMIT 10001)")));
    state = brainState(host.db);
    assert.equal(state.product_version, PRODUCT_VERSION);
    assert.equal(state.schema_version, LATEST_SCHEMA);
    assert.deepEqual([state.documents, state.chunks], [3, 2]);
    assert.deepEqual(state.runs.map((row) => row.status), ["failed", "verified"]);
    assert.deepEqual(host.deployment.uploads.slice(-2), ["fixed/paused-for-upgrade", "fixed/active"]);
    assert.equal(host.deployment.mode, "active");
  } finally {
    host.db.close();
    cleanup();
  }
});

test("a stuck Brain with queued work refuses before any upload instead of entering paused custody", async () => {
  const { manifestPath, cleanup } = sandboxManifest();
  const host = brainHost(v035Brain({ queuedOutboxRow: true }));
  host.deployment.build = BUILDS.beforeFix;
  host.deployment.mode = "paused-for-upgrade";
  try {
    const run = await runUpgrade(host, manifestPath, { uploadedBuild: BUILDS.fixed, readUpdateBacklog });
    assert.match(run.error?.message || "", /still paused for an update that has not finished, and it has 1 queued/);
    assert.match(run.error.message, /The paused deployment was not started\./);
    assert.equal(run.error.supportCode, "UPGRADE_FAILED");
    assert.deepEqual(host.deployment.uploads, []);
    const state = brainState(host.db);
    assert.equal(state.schema_version, V035_SCHEMA);
    assert.deepEqual(state.runs, []);
  } finally {
    host.db.close();
    cleanup();
  }
});

/* --------------------------------------------------------- the backlog read -- */

test("the backlog reader treats the stuck Worker's 500 as an answer, not a busy database", async () => {
  const { manifestPath, cleanup } = sandboxManifest();
  const host = brainHost(v035Brain());
  host.deployment.build = BUILDS.beforeFix;
  host.deployment.mode = "paused-for-upgrade";
  const sleeps = [];
  const base = { http: host.transport, resolveAdminKey: () => ADMIN_KEY, sleep: async (ms) => { sleeps.push(ms); } };
  try {
    // No database access (the first gate): one read, no retries, deferred.
    await assert.rejects(readUpdateBacklog(manifestPath, base), (error) =>
      error.attempts === 1 && error.preInventoryWorker === true && error.deferred === true);
    assert.deepEqual(sleeps, []);

    // With database access (the pre-pause gate): the D1 queue is the receipt.
    const receipt = await readUpdateBacklog(manifestPath, {
      ...base,
      readDatabaseQueue: async () => ({ pending: 0 }),
    });
    assert.deepEqual({ ...receipt }, { pending: 0, paused_for_upgrade: true, queue_read_from_database: true });

    // A database read that fails keeps the stuck-Brain refusal, never a zero.
    await assert.rejects(readUpdateBacklog(manifestPath, {
      ...base,
      readDatabaseQueue: async () => { throw new Error("D1 unavailable"); },
    }), (error) => error.preInventoryWorker === true && error.deferred !== true);

    // The same 500 from an ACTIVE Worker is not a resumable pause: ordinary failure.
    host.deployment.mode = "active";
    await assert.rejects(readUpdateBacklog(manifestPath, {
      ...base,
      readDatabaseQueue: async () => ({ pending: 0 }),
    }), (error) => error.preInventoryWorker !== true);
    assert.deepEqual(sleeps, []);
  } finally {
    host.db.close();
    cleanup();
  }
});

test("a stuck Worker newer than this CLI is never resumed from the database", async () => {
  const { manifestPath, cleanup } = sandboxManifest();
  const host = brainHost(v035Brain());
  host.deployment.build = BUILDS.beforeFix;
  host.deployment.mode = "paused-for-upgrade";
  const newer = async (url, init) => {
    const response = await host.transport(url, init);
    if (new URL(url).pathname !== "/health") return response;
    const body = await response.json();
    return new Response(JSON.stringify({ ...body, version: "9.9.9" }), { status: 200 });
  };
  try {
    await assert.rejects(readUpdateBacklog(manifestPath, {
      http: newer,
      resolveAdminKey: () => ADMIN_KEY,
      sleep: async () => {},
      readDatabaseQueue: async () => ({ pending: 0 }),
    }), (error) => error.preInventoryWorker !== true);
  } finally {
    host.db.close();
    cleanup();
  }
});

test("a paused Worker reporting a rollback write fence is refused with no database queue read", async () => {
  const { manifestPath, cleanup } = sandboxManifest();
  const host = brainHost(v035Brain());
  host.deployment.build = BUILDS.beforeFix;
  host.deployment.mode = "paused-for-upgrade";
  const fenced = async (url, init) => {
    const response = await host.transport(url, init);
    if (new URL(url).pathname !== "/health") return response;
    const body = await response.json();
    return new Response(JSON.stringify({ ...body, rollback_write_fence: true }), { status: 200 });
  };
  let queueReads = 0;
  try {
    await assert.rejects(readUpdateBacklog(manifestPath, {
      http: fenced,
      resolveAdminKey: () => ADMIN_KEY,
      sleep: async () => {},
      readDatabaseQueue: async () => { queueReads += 1; return { pending: 0 }; },
    }), (error) => error.preInventoryWorker !== true);
    assert.equal(queueReads, 0);
  } finally {
    host.db.close();
    cleanup();
  }
});

/* ------------------------------------------------ the command, both gates -- */

test("brain update on a stuck Brain defers its first read to the pre-pause gate and proceeds", async () => {
  const { manifestPath, cleanup } = sandboxManifest();
  const host = brainHost(v035Brain());
  host.deployment.build = BUILDS.beforeFix;
  host.deployment.mode = "paused-for-upgrade";
  const events = [];
  const { options: upgrade } = upgradeOptions(host, { uploadedBuild: BUILDS.fixed, readUpdateBacklog });
  upgrade.cmdDeploy = async (_path, deployOptions = {}) => {
    events.push(deployOptions.pauseVectorDrainForUpgrade === true ? "paused deployment" : "active deployment");
    throw new Error("fixture stop after the paused deployment started");
  };
  try {
    const { output } = await silently(() => cmdUpdate(manifestPath, {
      discoverInstalledManifest: () => ({ path: manifestPath, source: "remembered" }),
      dailyRefreshOptions: isolatedUpdateSchedulerOptions(dirname(manifestPath)),
      readUpdateBacklog: async (...args) => {
        events.push("initial backlog read");
        return readUpdateBacklog(...args);
      },
      updateBacklogOptions: { http: host.transport, resolveAdminKey: () => ADMIN_KEY, sleep: async () => events.push("sleep") },
      adoptCloudflareAuthProfile: async () => events.push("profile adoption"),
      withCloudflareControl: async (action) => action(),
      cmdVerify: async () => events.push("verification"),
      upgradeOptions: upgrade,
      reconcileExistingOwnerAgents: null,
      writeClaudeWorkspaceGuideAfterUpdate: null,
    })).catch((error) => ({ output: error.output, error }));
    assert.deepEqual(events, ["initial backlog read", "profile adoption", "verification", "paused deployment"],
      output.join("\n"));
    assert.ok(output.some((line) => line.includes(
      "This Brain is still paused by an earlier update whose Worker cannot read this Brain's older database layout",
    )), output.join("\n"));
    assert.equal(host.requests.filter((line) => line.startsWith("GET /api/admin/brain/documents")).length, 2);
  } finally {
    host.db.close();
    cleanup();
  }
});
