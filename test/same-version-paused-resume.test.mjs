/**
 * A Worker paused on the SAME version the manifest records is a resumable
 * paused generation, not a foreign one.
 *
 * Two ordinary paths leave that state: `brain rollback --yes` redeploys this
 * CLI's Worker paused and tells the owner to run `brain update`, and any
 * same-version `brain update` that stops inside its pause window leaves the
 * Worker paused on the version the manifest already records. Both must resume
 * through `brain update` and `brain doctor --repair --yes`.
 *
 * Every run below drives the real cmdRollback, cmdUpdate, cmdUpgrade,
 * cmdMigrate, cmdDoctorRepair and readUpdateBacklog. The backlog and /health
 * reads are answered by the real Worker router over a real sqlite database at
 * the head schema; only the HTTP transport, the Cloudflare control plane, the
 * Worker upload and the provider-side bootstrap are stand-ins, and each of
 * those mutates the same simulated Worker the router reads from.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  cmdDoctorRepair,
  cmdHealth as realCmdHealth,
  cmdMigrate,
  cmdRollback,
  cmdUpdate,
  commitManifestVersion,
  readUpdateBacklog,
  splitStatements,
} from "../brain.mjs";
import { renderCliCommands } from "../operations/cli-guidance.mjs";
import worker from "../worker/src/index.js";

const PRODUCT_VERSION = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
).version;
const ACCOUNT_ID = "4".repeat(32);
const DATABASE_ID = "44444444-2222-4333-8444-555555555555";
const ADMIN_KEY = "rehearsal-admin-key";
const BOOKMARK = "00000085-00000002-00004e1e-aaaaaaaabbbbccccddddeeeeffff0000";

const migrationDir = fileURLToPath(new URL("../migrations/d1/", import.meta.url));
const migrations = readdirSync(migrationDir)
  .filter((name) => /^\d+_.*\.sql$/u.test(name))
  .sort()
  .map((name) => {
    const sql = readFileSync(join(migrationDir, name), "utf8");
    return {
      version: Number.parseInt(name.split("_")[0], 10),
      name: name.replace(/\.sql$/u, ""),
      sql,
      checksum: createHash("sha256").update(sql).digest("hex").slice(0, 16),
    };
  });
const HEAD_SCHEMA = migrations.at(-1).version;

/** A Brain already on this release: head schema, one chunk, verified projection. */
function currentBrainDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL,
    applied_at TEXT NOT NULL, checksum TEXT NOT NULL)`);
  for (const migration of migrations) {
    for (const statement of splitStatements(migration.sql)) db.exec(statement);
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?,?,?,?)")
      .run(migration.version, migration.name, "2026-09-01T00:00:00Z", migration.checksum);
  }
  db.prepare(
    `INSERT INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring,
        vector_drain_lease_owner, vector_drain_lease_expires_at, vector_projection_status,
        vector_projection_bootstrap_base_count)
     VALUES (1, 'harbor', ?, ?, 4, '2026-09-01T00:00:00Z', 'stable', NULL, NULL, 'verified', 1)`,
  ).run(PRODUCT_VERSION, HEAD_SCHEMA);
  db.prepare(
    `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash)
     VALUES ('drive:doc-1', 'drive', 'doc-1', 'Synthetic operating agreement', ?, 'hash:doc-1')`,
  ).run(Date.now());
  db.prepare(
    `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, vector_id)
     VALUES ('drive:doc-1#0', 'drive:doc-1', 0, 'the owner holds the brain', 'drive', 'drive:doc-1#0')`,
  ).run();
  // Ingest enqueues projection work; this Brain has already drained it.
  db.prepare("DELETE FROM vector_outbox").run();
  return db;
}

function queueVectorWork(db, count) {
  for (let index = 0; index < count; index += 1) {
    db.prepare(
      `INSERT INTO vector_outbox (chunk_uid, op, queued_at, attempts, vector_id, generation)
       VALUES (?, 'upsert', ?, 0, ?, 1)`,
    ).run(`drive:doc-1#q${index}`, 1_750_000_000_000 + index, `drive:doc-1#q${index}`);
  }
}

function manifestFor(version) {
  return {
    manifest_version: 1,
    client: { slug: "harbor", display_name: "Harbor Fixture", primary_contact: "", timezone: "UTC" },
    brain: { version, domain: "harbor-brain.fixture.invalid", worker_name: "harbor-brain" },
    infrastructure: {
      cloudflare: {
        account_id: ACCOUNT_ID,
        storage: "d1",
        d1_database_name: "harbor-brain",
        d1_database_id: DATABASE_ID,
        vectorize_index: "harbor-brain",
        drain_cron: "* * * * *",
      },
    },
    corpora: { upload: { enabled: true } },
  };
}

/** D1 as the Worker sees it, over the same sqlite handle the CLI migrates. */
function workerD1(db) {
  const prepared = (sql, params = []) => ({
    bind: (...next) => prepared(sql, next),
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    first: async () => db.prepare(sql).get(...params) ?? null,
    run: async () => {
      const result = db.prepare(sql).run(...params);
      return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
    },
  });
  return { prepare: (sql) => prepared(sql), batch: async (list) => Promise.all(list.map((s) => s.run())) };
}

/**
 * One owner's installation: the database, the live Worker (its drain mode and
 * the provider vector count) and the manifest on disk.
 */
function installation({ manifestVersion = PRODUCT_VERSION } = {}) {
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "same-version-paused-")));
  const manifestPath = join(sandbox, "brain.manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifestFor(manifestVersion), null, 2)}\n`);
  const db = currentBrainDatabase();
  const live = { mode: "active", vectors: 1 };
  const events = [];
  const restore = { beforeFirstIngest: false };
  // backlog: update's queue gates; probe: doctor's paused-state /health read.
  const reads = { backlog: 0, probe: 0 };
  const env = () => ({
    STORAGE: "d1",
    ADMIN_KEY,
    DB: workerD1(db),
    VECTORIZE: { describe: async () => ({ vectorCount: live.vectors }) },
    ...(live.mode === "paused-for-upgrade" ? { VECTOR_DRAIN_MODE: "paused-for-upgrade" } : {}),
  });
  // The transport: every request reaches the real Worker router.
  const http = async (url, init = {}, requestOptions = {}) => {
    const target = new URL(url);
    if (requestOptions?.what === "the update backlog check") reads.backlog += 1;
    if (target.pathname === "/health" && !target.search) reads.probe += 1;
    return worker.fetch(new Request(url, init), env(), { waitUntil() {} });
  };
  const d1Query = async (account, database, sql, params = []) => {
    assert.equal(account, ACCOUNT_ID);
    assert.equal(database, DATABASE_ID);
    const statement = db.prepare(sql);
    // D1 returns the rows of a write's RETURNING clause; the paused exact-count
    // rebase reads its persisted count back through it.
    if (/^\s*(SELECT|PRAGMA|WITH)/iu.test(sql) || /\bRETURNING\b/iu.test(sql)) {
      return { results: statement.all(...params), success: true };
    }
    const result = statement.run(...params);
    return { results: [], success: true, meta: { changes: Number(result.changes || 0) } };
  };
  const cf = async (path) => {
    if (path.endsWith("/time_travel/bookmark")) return { bookmark: BOOKMARK };
    if (path.includes("/time_travel/restore")) {
      events.push("d1-restore");
      if (restore.beforeFirstIngest) {
        // The bookmark predates the first ingest, and supervised recovery
        // rebinds a clean, empty index.
        db.prepare("DELETE FROM chunks").run();
        db.prepare("DELETE FROM documents").run();
        db.prepare("DELETE FROM vector_outbox").run();
        live.vectors = 0;
      }
      return { bookmark: BOOKMARK };
    }
    throw new Error(`unexpected Cloudflare call ${path}`);
  };
  const cmdDeploy = async (_path, options = {}) => {
    live.mode = options.pauseVectorDrainForUpgrade === true ? "paused-for-upgrade" : "active";
    events.push(`deploy:${live.mode}`);
    return { ok: true };
  };
  // The real health check, answered by the real Worker router, so every
  // paused and active gate (exact version, drain mode, projection readiness)
  // is judged by the production code.
  const cmdHealth = async (path, options = {}) => {
    events.push(`health:${options.expectDrainMode || "none"}`);
    return realCmdHealth(path, { ...options, request: http, resolveKey: () => ADMIN_KEY, wait: async () => {} });
  };
  const failures = { bootstrap: false };
  const cmdBootstrap = async () => {
    events.push("bootstrap");
    if (failures.bootstrap) throw new Error("synthetic: the provider stopped answering mid-bootstrap");
    const chunks = db.prepare("SELECT count(*) AS n FROM chunks").get().n;
    db.prepare(
      `UPDATE install_state SET vector_projection_status = 'verified',
         vector_projection_bootstrap_base_count = ?, vector_projection_bootstrap_cursor = NULL
       WHERE id = 1`,
    ).run(chunks);
    live.vectors = chunks;
    return { epoch: 1, total: chunks, confirmed: chunks, remaining: 0, rounds: 1, complete: true, vector_ready: true };
  };
  const upgradeOptions = {
    resolveAccount: async () => ({ id: ACCOUNT_ID, name: "Harbor Fixture" }),
    d1Query,
    cf,
    cmdMigrate: async (path, migrateOptions = {}) => {
      events.push("migrate");
      return cmdMigrate(path, {
        ...migrateOptions,
        silent: true,
        resolveAccount: async () => ({ id: ACCOUNT_ID }),
        d1Query,
      });
    },
    cmdDeploy,
    cmdHealth,
    cmdBootstrap,
    reconcileWorkerProviderSecrets: async () => ({ reconciled: 0 }),
    cmdDrain: async () => { events.push("drain"); return { remaining: 0 }; },
    cmdTest: async () => { events.push("acceptance"); return { ok: true }; },
    commitManifestVersion,
    waitForVectorDrainQuiescence: async () => {},
    readUpdateBacklog,
    updateBacklogOptions: {
      resolveAdminKey: () => ADMIN_KEY,
      http,
      sleep: async () => { throw new Error("a readable receipt must not be retried"); },
    },
  };
  return {
    sandbox, manifestPath, db, live, events, reads, failures, restore, http, d1Query, cf, cmdDeploy, cmdHealth,
    upgradeOptions,
    manifestVersion: () => JSON.parse(readFileSync(manifestPath, "utf8")).brain.version,
    close() {
      db.close();
      rmSync(sandbox, { recursive: true, force: true });
    },
  };
}

async function quietly(run) {
  const output = [];
  const priorLog = console.log;
  console.log = (...values) => output.push(values.map(String).join(" ").replace(/\x1b\[[0-9;]*m/gu, ""));
  let error = null;
  let result;
  try {
    result = await run();
  } catch (caught) {
    error = caught;
  } finally {
    console.log = priorLog;
  }
  return { error, result, output };
}

async function update(brain) {
  return quietly(() => cmdUpdate(brain.manifestPath, {
    discoverInstalledManifest: () => ({ path: brain.manifestPath, source: "remembered" }),
    readUpdateBacklog,
    updateBacklogOptions: brain.upgradeOptions.updateBacklogOptions,
    adoptCloudflareAuthProfile: async () => {},
    withCloudflareControl: async (action) => action(),
    cmdVerify: async () => {},
    upgradeOptions: brain.upgradeOptions,
    reconcileExistingOwnerAgents: null,
    writeClaudeWorkspaceGuideAfterUpdate: null,
  }));
}

async function rollback(brain) {
  return quietly(() => cmdRollback(brain.manifestPath, BOOKMARK, {
    confirmed: true,
    resolveAccount: brain.upgradeOptions.resolveAccount,
    cf: brain.cf,
    d1Query: brain.d1Query,
    cmdDeploy: brain.cmdDeploy,
    cmdHealth: brain.cmdHealth,
    waitForVectorDrainQuiescence: async () => {},
  }));
}

function projectionStatus(brain) {
  return brain.db.prepare("SELECT vector_projection_status AS status FROM install_state WHERE id = 1").get().status;
}

const PAUSED_QUEUED_MESSAGE = (pending, consequence) => renderCliCommands(
  `This Brain is still paused for an update that has not finished, and it has ${pending} queued search ` +
    "update(s). A paused Brain does not process its queue, so waiting will not clear it, and this update will " +
    `not continue over queued work. ${consequence} Do not run \`brain drain\` or clear VECTOR_DRAIN_MODE by hand. ` +
    "Run `brain health` and keep its output for support.",
);

function upgradeStages(brain) {
  return brain.events.filter((event) => /^deploy:|^bootstrap$|^migrate$/u.test(event));
}

test("rollback then update: the paused same-version Worker resumes and the update completes", async () => {
  const brain = installation();
  try {
    brain.restore.beforeFirstIngest = true;
    const rolledBack = await rollback(brain);
    assert.equal(rolledBack.error, null, rolledBack.error?.message);
    assert.equal(rolledBack.result?.restored, true);
    // The state rollback promises `brain update` will fix.
    assert.equal(brain.live.mode, "paused-for-upgrade");
    assert.ok(rolledBack.output.some((line) => line.includes("then run `brain update <manifest>`")),
      rolledBack.output.join("\n"));
    assert.equal(brain.manifestVersion(), PRODUCT_VERSION);

    brain.events.length = 0;
    const run = await update(brain);
    assert.equal(run.error, null, run.error?.message);
    // Both backlog gates read the real receipt of the paused Worker once each.
    assert.equal(brain.reads.backlog, 2);
    assert.deepEqual(upgradeStages(brain), ["deploy:paused-for-upgrade", "migrate", "bootstrap", "deploy:active"]);
    assert.ok(brain.events.includes("acceptance"), JSON.stringify(brain.events));
    assert.equal(brain.live.mode, "active");
    assert.equal(projectionStatus(brain), "verified");
    assert.equal(brain.manifestVersion(), PRODUCT_VERSION);
  } finally {
    brain.close();
  }
});

/*
 * RECORDED FINDING, not desired behaviour. With a corpus, rollback leaves the
 * projection `bootstrap_required`. Both backlog gates now resume that paused
 * Worker, but the separate paused pre-migration readiness gate in cmdHealth
 * (requireProjectionReady) still refuses a not-ready projection before this
 * update's own bootstrap stage can rebuild it. That gate is unchanged here and
 * behaves the same on main. If it learns to hand a bootstrap_required
 * projection to the bootstrap stage, update this test deliberately.
 */
test("rollback with a corpus: both backlog gates resume, then the pre-migration readiness gate stops", async () => {
  const brain = installation();
  try {
    const rolledBack = await rollback(brain);
    assert.equal(rolledBack.error, null, rolledBack.error?.message);
    assert.equal(projectionStatus(brain), "bootstrap_required");

    brain.events.length = 0;
    const run = await update(brain);
    assert.equal(brain.reads.backlog, 2);
    assert.doesNotMatch(run.error?.message || "", /not an earlier update|install that release/u);
    assert.match(run.error?.message || "",
      /^update stopped during paused vector-drain health verification: Vectorize has accepted work that is not query-visible yet while this Brain is paused for an update\./u);
    assert.deepEqual(upgradeStages(brain), ["deploy:paused-for-upgrade"]);
    assert.equal(brain.live.mode, "paused-for-upgrade");
    assert.equal(brain.manifestVersion(), PRODUCT_VERSION);
  } finally {
    brain.close();
  }
});

test("a same-version update that stopped inside its pause window resumes on the rerun", async () => {
  const brain = installation();
  try {
    brain.failures.bootstrap = true;
    const stopped = await update(brain);
    assert.match(String(stopped.error?.message || ""), /CANNOT ACCEPT DOCUMENTS RIGHT NOW/u);
    assert.equal(brain.live.mode, "paused-for-upgrade");
    assert.equal(brain.manifestVersion(), PRODUCT_VERSION);

    brain.failures.bootstrap = false;
    brain.events.length = 0;
    brain.reads.backlog = 0;
    const rerun = await update(brain);
    assert.equal(rerun.error, null, rerun.error?.message);
    assert.equal(brain.reads.backlog, 2);
    assert.deepEqual(upgradeStages(brain), ["deploy:paused-for-upgrade", "migrate", "bootstrap", "deploy:active"]);
    assert.ok(brain.events.includes("acceptance"), JSON.stringify(brain.events));
    assert.equal(brain.live.mode, "active");
    assert.equal(brain.manifestVersion(), PRODUCT_VERSION);
  } finally {
    brain.close();
  }
});

async function doctorRepair(brain) {
  return quietly(() => cmdDoctorRepair(brain.manifestPath, {
    confirmed: true,
    diagnoseOptions: {
      http: brain.http,
      resolveAccount: brain.upgradeOptions.resolveAccount,
      d1Query: brain.d1Query,
    },
    upgradeOptions: brain.upgradeOptions,
  }));
}

test("doctor --repair --yes resumes a same-version update that stopped paused", async () => {
  const brain = installation();
  try {
    brain.failures.bootstrap = true;
    await update(brain);
    assert.equal(brain.live.mode, "paused-for-upgrade");
    brain.failures.bootstrap = false;
    brain.events.length = 0;
    brain.reads.backlog = 0;
    const repaired = await doctorRepair(brain);
    assert.equal(repaired.error, null, repaired.error?.message);
    // The diagnosis really read the paused Worker's /health before resuming,
    // and the pre-pause gate read its real backlog receipt.
    assert.equal(brain.reads.probe, 1);
    assert.equal(brain.reads.backlog, 1);
    assert.deepEqual(upgradeStages(brain), ["deploy:paused-for-upgrade", "migrate", "bootstrap", "deploy:active"]);
    assert.equal(brain.live.mode, "active");
    assert.equal(brain.manifestVersion(), PRODUCT_VERSION);
  } finally {
    brain.close();
  }
});

test("doctor --repair --yes resumes a Brain rollback left paused on this version", async () => {
  const brain = installation();
  try {
    brain.restore.beforeFirstIngest = true;
    const rolledBack = await rollback(brain);
    assert.equal(rolledBack.error, null, rolledBack.error?.message);
    brain.events.length = 0;
    const repaired = await doctorRepair(brain);
    assert.equal(repaired.error, null, repaired.error?.message);
    assert.equal(brain.reads.probe, 1);
    assert.equal(brain.reads.backlog, 1);
    assert.deepEqual(upgradeStages(brain), ["deploy:paused-for-upgrade", "migrate", "bootstrap", "deploy:active"]);
    assert.equal(brain.live.mode, "active");
    assert.equal(projectionStatus(brain), "verified");
  } finally {
    brain.close();
  }
});

test("a paused same-version Worker with 3 queued updates refuses truthfully at both gates", async () => {
  const brain = installation();
  try {
    brain.live.mode = "paused-for-upgrade";
    queueVectorWork(brain.db, 3);
    const run = await update(brain);
    assert.equal(run.error?.message, PAUSED_QUEUED_MESSAGE(3, "Nothing was changed."));
    assert.doesNotMatch(run.error?.message || "", /not an earlier update|install that release|few minutes/u);
    // The decision point was reached: one real receipt was read and classified.
    assert.equal(brain.reads.backlog, 1);
    assert.deepEqual(brain.events, []);

    brain.reads.backlog = 0;
    const forced = await quietly(() => cmdUpdate(brain.manifestPath, {
      discoverInstalledManifest: () => ({ path: brain.manifestPath, source: "remembered" }),
      readUpdateBacklog,
      updateBacklogOptions: brain.upgradeOptions.updateBacklogOptions,
      forceQueuedUpdate: true,
      adoptCloudflareAuthProfile: async () => {},
      withCloudflareControl: async (action) => action(),
      cmdVerify: async () => {},
      upgradeOptions: brain.upgradeOptions,
      reconcileExistingOwnerAgents: null,
      writeClaudeWorkspaceGuideAfterUpdate: null,
    }));
    assert.ok(String(forced.error?.message || "").includes(
      PAUSED_QUEUED_MESSAGE(3, "The paused deployment was not started."),
    ), forced.error?.message);
    assert.equal(brain.reads.backlog, 2);
    assert.equal(brain.events.some((event) => event.startsWith("deploy:")), false);
    assert.equal(brain.manifestVersion(), PRODUCT_VERSION);
  } finally {
    brain.close();
  }
});

test("a paused Worker newer than this CLI is not resumed, even when the manifest records it", async () => {
  const newer = "9.9.9";
  const brain = installation({ manifestVersion: newer });
  try {
    brain.live.mode = "paused-for-upgrade";
    const body = await (await brain.http("https://harbor-brain.fixture.invalid/api/admin/brain/documents", {
      headers: { "X-Admin-Key": ADMIN_KEY },
    })).json();
    let reads = 0;
    // Present the same live receipt as a newer Worker generation.
    const newerHttp = async () => {
      reads += 1;
      return new Response(JSON.stringify({ ...body, version: newer }), { status: 200 });
    };
    const run = await quietly(() => cmdUpdate(brain.manifestPath, {
      discoverInstalledManifest: () => ({ path: brain.manifestPath, source: "remembered" }),
      readUpdateBacklog,
      updateBacklogOptions: { ...brain.upgradeOptions.updateBacklogOptions, http: newerHttp },
      adoptCloudflareAuthProfile: async () => {},
      withCloudflareControl: async (action) => action(),
      cmdVerify: async () => {},
      upgradeOptions: brain.upgradeOptions,
      reconcileExistingOwnerAgents: null,
      writeClaudeWorkspaceGuideAfterUpdate: null,
    }));
    assert.match(run.error?.message || "", new RegExp(
      `reports version 9\\.9\\.9 \\(paused-for-upgrade\\), but this manifest records 9\\.9\\.9 and this CLI is ${
        PRODUCT_VERSION.replaceAll(".", "\\.")}`, "u"));
    // The generation decision was reached on one real read, with no retry.
    assert.equal(reads, 1);
    assert.deepEqual(brain.events, []);
  } finally {
    brain.close();
  }
});
