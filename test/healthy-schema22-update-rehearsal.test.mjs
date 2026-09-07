/**
 * THE OLDEST HEALTHY INSTALL: a brain from v0.2.0, schema 22, Apple Silicon macOS.
 *
 * That brain's case is the clean one, which is exactly why it gets assumed instead of
 * proven. This drives the REAL cmdUpgrade over the REAL cmdMigrate against a
 * REAL sqlite database standing where such a brain actually stands, so three
 * questions are measured rather than believed:
 *
 *   1. does `brain update` pause the brain's document writes at all, and in what order
 *      relative to the schema change,
 *   2. for HOW LONG the pause lasts on an idle brain, and
 *   3. whether the quiescence probe's SQL is even legal at schema 22 -- if it
 *      is not, the probe throws, the code silently falls back to the full
 *      twenty-minute fixed grace, and nothing anywhere reports the difference.
 *
 * Non-vacuity is enforced two ways. cmdMigrate is the real one, so migrations
 * 0023..0035 genuinely execute against populated schema-22 tables and the
 * ledger is read back. And the idle run is paired with a BUSY run whose only
 * difference is one in-flight vector_outbox row: if the probe result were
 * ignored, both would wait the same amount of time.
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cmdMigrate,
  cmdUpgrade,
  commitManifestVersion,
  splitStatements,
  VECTOR_DRAIN_CUTOVER_QUIESCENCE_MS,
  VECTOR_DRAIN_CUTOVER_POLL_MS,
  waitForVectorDrainCutover,
} from "../brain.mjs";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 400)));
  if (!condition) fail++;
};

const PRODUCT_VERSION = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
).version;

/* that install's brain: every release through v0.3.6 ships exactly 22 migrations. */
const PUBLISHED_SCHEMA = 22;
const ACCOUNT_ID = "3c9a71b0e4d5426f8a1b7c0d9e2f3a4b";
const DATABASE_ID = "8f2b1c4d-5e6a-4b7c-9d0e-1f2a3b4c5d6e";

const migrationDir = fileURLToPath(new URL("../migrations/d1/", import.meta.url));
const migrations = readdirSync(migrationDir)
  .filter((f) => /^\d+_.*\.sql$/.test(f))
  .sort()
  .map((f) => {
    const sql = readFileSync(join(migrationDir, f), "utf-8");
    return {
      version: parseInt(f.split("_")[0], 10),
      name: f.replace(/\.sql$/, ""),
      sql,
      checksum: createHash("sha256").update(sql).digest("hex").slice(0, 16),
    };
  });

/** That brain's brain as it stands today: 22 migrations applied, a real corpus, drained. */
function publishedReleaseDatabase({ inFlightOutboxRow = false, startAtVersion = "0.2.0", startAtSchema = PUBLISHED_SCHEMA } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL,
    applied_at TEXT NOT NULL, checksum TEXT NOT NULL)`);
  for (const migration of migrations.filter((m) => m.version <= startAtSchema)) {
    for (const statement of splitStatements(migration.sql)) db.exec(statement);
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?,?,?,?)")
      .run(migration.version, migration.name, "2026-09-01T00:00:00Z", migration.checksum);
  }
  // A v0.2.0 install records the version it was installed by; a healthy brain
  // holds no lease and has nothing in flight.
  db.prepare(
    `INSERT INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring,
        vector_drain_lease_owner, vector_drain_lease_expires_at, vector_projection_status)
     VALUES (1, 'riverbend', ?, ?, 4, '2026-09-01T00:00:00Z', 'stable', NULL, NULL, 'verified')`
  ).run(startAtVersion, startAtSchema);
  db.prepare(
    `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash)
     VALUES ('drive:doc-1', 'drive', 'doc-1', 'Riverbend Studio operating agreement', ?, 'hash:doc-1')`
  ).run(Date.now());
  db.prepare(
    `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, vector_id)
     VALUES ('drive:doc-1#0', 'drive:doc-1', 0, 'the client owns the brain', 'drive', 'drive:doc-1#0')`
  ).run();
  if (inFlightOutboxRow) {
    // One batch Vectorize has ACCEPTED but not yet confirmed, exactly the way
    // the drain writes it: the row is queued first, then stamped. Stamping in
    // the INSERT would be erased by vector_outbox_generation_ai, which nulls
    // submitted_mutation_id on every insert.
    db.prepare(
      `INSERT INTO vector_outbox (chunk_uid, op, queued_at, attempts, vector_id, generation)
       VALUES ('drive:doc-1#0', 'upsert', ?, 1, 'drive:doc-1#0', 1)`
    ).run(Date.now());
    db.prepare(
      "UPDATE vector_outbox SET submitted_mutation_id = 'mutation-in-flight', submitted_at = ? WHERE chunk_uid = 'drive:doc-1#0'"
    ).run(Date.now());
    const stamped = db.prepare(
      "SELECT count(*) AS n FROM vector_outbox WHERE submitted_mutation_id IS NOT NULL"
    ).get().n;
    if (stamped !== 1) throw new Error("the busy fixture did not actually record an in-flight batch");
  }
  return db;
}

/** The v0.2.0-era manifest shape, with a workers.dev domain and a keychain key locator. */
function publishedReleaseManifest() {
  return {
    $schema: "../manifest.schema.json",
    manifest_version: 1,
    client: { slug: "riverbend", display_name: "Riverbend Studio, Inc", primary_contact: "", timezone: "America/Chicago" },
    brain: { version: "0.2.0", domain: "riverbend-brain.owner-subdomain.workers.dev", worker_name: "riverbend-brain" },
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

/**
 * One full update run. Every Cloudflare call is a recording stub; D1 is the
 * real sqlite handle; cmdMigrate is the real cmdMigrate.
 */
async function runUpdate({
  inFlightOutboxRow = false,
  releaseInFlightAfterMs = null,
  startAtVersion = "0.2.0",
  startAtSchema = PUBLISHED_SCHEMA,
  failBootstrap = false,
} = {}) {
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "oldest-install-update-")));
  const manifestPath = join(sandbox, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify(publishedReleaseManifest(), null, 2) + "\n");

  const db = publishedReleaseDatabase({ inFlightOutboxRow, startAtVersion, startAtSchema });
  const timeline = [];
  const sqlLog = [];
  let clock = 1_700_000_000_000;
  const now = () => clock;
  const mark = (event, extra = {}) => timeline.push({ at: clock - 1_700_000_000_000, event, ...extra });

  const waits = [];
  const waiter = async (ms) => {
    waits.push(ms);
    clock += ms;
    if (releaseInFlightAfterMs !== null && clock - 1_700_000_000_000 >= releaseInFlightAfterMs) {
      db.prepare("DELETE FROM vector_outbox WHERE submitted_mutation_id IS NOT NULL").run();
    }
  };

  const d1Query = async (acctId, dbId, sql, params = []) => {
    if (acctId !== ACCOUNT_ID) throw new Error(`unexpected account ${acctId}`);
    if (dbId !== DATABASE_ID) throw new Error(`unexpected database ${dbId}`);
    sqlLog.push({ at: clock - 1_700_000_000_000, sql: sql.replace(/\s+/g, " ").trim() });
    const statement = db.prepare(sql);
    const isRead = /^\s*(SELECT|PRAGMA)/i.test(sql);
    if (isRead) return { results: statement.all(...params), success: true };
    const result = statement.run(...params);
    return { results: [], success: true, meta: { changes: Number(result.changes || 0) } };
  };

  const options = {
    resolveAccount: async () => ({ id: ACCOUNT_ID, name: "Riverbend Studio" }),
    d1Query,
    cf: async (path) => {
      if (path.endsWith("/time_travel/bookmark")) {
        mark("bookmark");
        return { bookmark: "00000085-00000002-00004e1e-aaaaaaaabbbbccccddddeeeeffff0000" };
      }
      throw new Error(`unexpected Cloudflare call ${path}`);
    },
    // The REAL migrate, wired to the REAL database.
    cmdMigrate: async (path, migrateOptions = {}) => {
      mark("migrate:start", { quiesced: migrateOptions.vectorDrainQuiesced === true });
      const result = await cmdMigrate(path, {
        ...migrateOptions,
        silent: true,
        resolveAccount: async () => ({ id: ACCOUNT_ID, name: "Riverbend Studio" }),
        d1Query,
      });
      mark("migrate:done", result);
      return result;
    },
    cmdDeploy: async (path, deployOptions = {}) => {
      clock += 8_000; // a real worker upload
      mark(deployOptions.pauseVectorDrainForUpgrade === true ? "deploy:PAUSED" : "deploy:active");
      return { ok: true };
    },
    cmdHealth: async (path, healthOptions = {}) => {
      clock += 1_000;
      mark(`health:${healthOptions.expectDrainMode || "none"}`, { expectVersion: healthOptions.expectVersion });
      return { ok: true };
    },
    cmdBootstrap: async () => {
      clock += 2_000;
      mark("bootstrap");
      if (failBootstrap) throw new Error("synthetic: one chunk queued before the pause never projected");
      return { epoch: 0, total: 0, confirmed: 0, remaining: 0, rounds: 1, complete: true, vector_ready: true };
    },
    reconcileWorkerProviderSecrets: async () => { mark("provider-secrets"); return { reconciled: 0 }; },
    cmdDrain: async () => { clock += 3_000; mark("drain"); return { remaining: 0 }; },
    cmdTest: async (path, testOptions = {}) => {
      clock += 5_000;
      mark("acceptance", { expectVersion: testOptions.expectVersion });
      return { ok: true };
    },
    commitManifestVersion,
    waitForVectorDrainQuiescence: waiter,
  };

  let error = null;
  const priorLog = console.log;
  console.log = () => {};
  try {
    await cmdUpgrade(manifestPath, options);
  } catch (thrown) {
    error = thrown;
  } finally {
    console.log = priorLog;
  }
  const state = db.prepare("SELECT product_version, schema_version FROM install_state WHERE id = 1").get();
  const ledger = db.prepare("SELECT count(*) AS n, max(version) AS top FROM schema_migrations").get();
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name)
  );
  const corpus = db.prepare("SELECT (SELECT count(*) FROM documents) AS documents, (SELECT count(*) FROM chunks) AS chunks").get();
  const manifestAfter = JSON.parse(readFileSync(manifestPath, "utf8"));
  rmSync(sandbox, { recursive: true, force: true });
  db.close();
  return { error, timeline, waits, sqlLog, state, ledger, manifestAfter, tables, corpus };
}

/* ---------------------------------------------------------------- 1. idle -- */
const idle = await runUpdate();
check("the update completes on a healthy schema-22 brain", idle.error === null,
  idle.error && String(idle.error.message || idle.error));

const events = idle.timeline.map((entry) => entry.event);
check("document writes ARE paused, and the pause is deployed BEFORE the schema changes",
  events.indexOf("deploy:PAUSED") >= 0 &&
  events.indexOf("deploy:PAUSED") < events.indexOf("migrate:start"),
  JSON.stringify(events));
check("the pause is proven live before anything is migrated",
  events.indexOf("health:paused-for-upgrade") > events.indexOf("deploy:PAUSED") &&
  events.indexOf("health:paused-for-upgrade") < events.indexOf("migrate:start"),
  JSON.stringify(events));
check("writes resume only after migration, bootstrap and an exact active-mode health check",
  events.indexOf("deploy:active") > events.indexOf("migrate:done") &&
  events.indexOf("bootstrap") > events.indexOf("migrate:done") &&
  events.indexOf("bootstrap") < events.indexOf("deploy:active") &&
  events.indexOf("health:active") > events.indexOf("deploy:active"),
  JSON.stringify(events));

const pausedAt = idle.timeline.find((entry) => entry.event === "deploy:PAUSED").at;
const resumedAt = idle.timeline.find((entry) => entry.event === "deploy:active").at;
const pauseWindowMs = resumedAt - pausedAt;
console.log(`\n      measured pause window, idle brain: ${Math.round(pauseWindowMs / 1000)}s ` +
  `(waits: ${JSON.stringify(idle.waits)})\n`);
check("the pause on an idle schema-22 brain is well under the twenty-minute fixed grace",
  pauseWindowMs < VECTOR_DRAIN_CUTOVER_QUIESCENCE_MS / 4,
  `${pauseWindowMs}ms`);
check("the quiescence wait is exactly one poll interval, so the probe was READ, not skipped",
  idle.waits.length === 1 && idle.waits[0] === VECTOR_DRAIN_CUTOVER_POLL_MS,
  JSON.stringify(idle.waits));

/* the probe SQL has to be legal at schema 22 or the fallback is silent */
const probeSql = idle.sqlLog.filter((entry) => /vector_drain_lease_owner/.test(entry.sql));
check("the quiescence probe really ran against its schema-22 tables (twice, as required)",
  probeSql.length === 2, JSON.stringify(probeSql));

/* the migration really happened */
check("the real cmdMigrate applied every migration past 22",
  idle.ledger.n === migrations.length && idle.ledger.top === migrations.at(-1).version,
  JSON.stringify(idle.ledger));
check("cmdMigrate was told the writers were quiesced, which is what lets 0033 swap the live FTS trigger",
  idle.timeline.find((entry) => entry.event === "migrate:start")?.quiesced === true);
check(`D1 records the new version only after acceptance passed`,
  idle.state.product_version === PRODUCT_VERSION && idle.state.schema_version === migrations.at(-1).version,
  JSON.stringify(idle.state));
/* A ledger row is cheap to write; the tables the new migrations promise are not.
   Name two that exist nowhere in a shipped release, so an update that walked
   the loop without executing the SQL cannot pass this file. */
const postPublishedTables = ["document_source_inventory", "plaid_sync_custody_state", "support_sessions"];
const beforeTables = new Set(
  (() => { const d = publishedReleaseDatabase(); const names = d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name); d.close(); return names; })()
);
check("none of the post-22 tables exist on a schema-22 brain today",
  postPublishedTables.every((name) => !beforeTables.has(name)),
  JSON.stringify(postPublishedTables.filter((name) => beforeTables.has(name))));
check("and the update actually created them, so the migration step was not a no-op loop",
  postPublishedTables.filter((name) => !idle.tables.has(name)).length <= 1 &&
  idle.tables.has("document_source_inventory") && idle.tables.has("support_sessions"),
  JSON.stringify([...idle.tables].filter((n) => !beforeTables.has(n))));
check("the corpus rows survived the upgrade",
  idle.corpus.documents === 1 && idle.corpus.chunks === 1, JSON.stringify(idle.corpus));

check("the local manifest is advanced to the same version",
  idle.manifestAfter.brain.version === PRODUCT_VERSION &&
  idle.manifestAfter.brain.domain === "riverbend-brain.owner-subdomain.workers.dev",
  JSON.stringify(idle.manifestAfter.brain));

/* ------------------------------------------------- 2. the busy control run -- */
/*
 * cmdUpgrade budgets the quiescence loop against real wall-clock time and
 * exposes no clock seam, so a busy brain cannot be driven through cmdUpgrade
 * inside a test without waiting twenty real minutes. Take the EXACT probe SQL
 * that the idle run just executed, point it at an otherwise identical brain
 * that has one accepted-but-unconfirmed batch, and run the real
 * waitForVectorDrainCutover over it with an injected clock. Same SQL, same
 * loop, one row of difference.
 */
const probeStatement = idle.sqlLog.find((entry) => /vector_drain_lease_owner/.test(entry.sql)).sql;
check("the probe cmdUpgrade runs is a single read of install_state plus the outbox in-flight count",
  /^SELECT vector_drain_lease_owner AS owner/.test(probeStatement) &&
  /FROM vector_outbox WHERE submitted_mutation_id IS NOT NULL/.test(probeStatement) &&
  /FROM install_state WHERE id = 1$/.test(probeStatement),
  probeStatement);

/** cmdUpgrade's own reading, rebuilt over a database handle. */
function readingFrom(db) {
  const row = db.prepare(probeStatement).get();
  if (!row) throw new Error("install_state row missing");
  const expires = Number(row.expires_at || 0);
  return {
    leaseFree: row.owner === null || row.owner === undefined || row.owner === "" ||
      (Number.isFinite(expires) && expires > 0 && expires < Date.now()),
    inFlight: Number(row.in_flight || 0),
  };
}

const idleDb = publishedReleaseDatabase();
const busyDb = publishedReleaseDatabase({ inFlightOutboxRow: true });
check("the same probe reads QUIET on its healthy brain and BUSY on the one-row-different one",
  readingFrom(idleDb).inFlight === 0 && readingFrom(idleDb).leaseFree === true &&
  readingFrom(busyDb).inFlight === 1,
  JSON.stringify({ idle: readingFrom(idleDb), busy: readingFrom(busyDb) }));

async function cutover(db, { clearAfterMs = null, probeThrows = false } = {}) {
  let clock = 5_000_000;
  let waited = 0;
  const priorLog = console.log;
  console.log = () => {};
  try {
    return await waitForVectorDrainCutover(async (ms) => {
      clock += ms;
      waited += ms;
      if (clearAfterMs !== null && waited >= clearAfterMs) {
        db.prepare("UPDATE vector_outbox SET submitted_mutation_id = NULL, submitted_at = NULL").run();
      }
    }, {
      probe: probeThrows
        ? async () => { throw new Error("no such column: vector_drain_lease_owner"); }
        : async () => readingFrom(db),
      now: () => clock,
    });
  } finally {
    console.log = priorLog;
  }
}

const busyCutover = await cutover(busyDb);
check("a brain with an accepted-but-unconfirmed batch is held for the FULL twenty-minute grace",
  busyCutover.proven === false && busyCutover.waitedMs >= VECTOR_DRAIN_CUTOVER_QUIESCENCE_MS -
    VECTOR_DRAIN_CUTOVER_POLL_MS,
  JSON.stringify(busyCutover));
check("so the probe result is genuinely read: one outbox row is the whole difference between 15s and 20min",
  busyCutover.waitedMs > pauseWindowMs * 20, `idle window=${pauseWindowMs}ms busy wait=${busyCutover.waitedMs}ms`);

const settledCutover = await cutover(publishedReleaseDatabase({ inFlightOutboxRow: true }), { clearAfterMs: 30_000 });
check("a writer that finishes mid-pause releases the cutover early instead of serving the full grace",
  settledCutover.proven === true &&
  settledCutover.waitedMs < VECTOR_DRAIN_CUTOVER_QUIESCENCE_MS / 4,
  JSON.stringify(settledCutover));

/*
 * The fallback. If the probe SQL were ever illegal on the schema in the field,
 * the loop retries it across the window, then serves the full fixed grace and
 * reports that quiescence was NOT verified. Pin the cost of getting that SQL
 * wrong here rather than in a client's twenty-minute outage, and pin that the
 * outcome is distinguishable from a proven-quiet one.
 */
const blindCutover = await cutover(publishedReleaseDatabase(), { probeThrows: true });
check("a probe that cannot read the schema falls back to the full grace and says it proved nothing",
  blindCutover.proven === false && blindCutover.reason === "probe-unreadable" &&
    blindCutover.waitedMs >= VECTOR_DRAIN_CUTOVER_QUIESCENCE_MS,
  JSON.stringify(blindCutover));

idleDb.close();
busyDb.close();

/* ------------------------------------------- 3. what a failed run leaves -- */
/* That brain's clean case is only clean until a stage inside the pause window fails.
   Name the exact state the brain is left in, because "healthy install" is not
   a defence against it. */
const stranded = await runUpdate({ failBootstrap: true });
const strandedEvents = stranded.timeline.map((entry) => entry.event);
check("a failure inside the pause window leaves the brain PAUSED, with no active deploy",
  stranded.error !== null && strandedEvents.includes("deploy:PAUSED") &&
  !strandedEvents.includes("deploy:active"),
  JSON.stringify(strandedEvents));
check("and the operator is told in plain words that documents are being refused, not queued",
  /CANNOT ACCEPT DOCUMENTS RIGHT NOW/.test(String(stranded.error?.message || "")) &&
  /refused, not queued/.test(String(stranded.error?.message || "")) &&
  /D1 recovery bookmark/.test(String(stranded.error?.message || "")),
  String(stranded.error?.message || "").slice(0, 300));
check("the schema has already moved but the recorded product version has NOT, which is the state a rerun resumes from",
  stranded.state.schema_version === migrations.at(-1).version &&
  stranded.state.product_version === "0.2.0" &&
  stranded.ledger.n === migrations.length,
  JSON.stringify({ state: stranded.state, ledger: stranded.ledger }));

/* -------------------------------- 4. RECORDED FINDING, not desired behaviour --
 * `brain setup` learned to refuse a brain that is already live on this release
 * ("already installed and live on version X"). `brain update` has no matching
 * fast path: run it again on a brain that is already current with nothing to
 * migrate and it still deploys the paused compatibility Worker, waits out the
 * cutover, runs a no-op migration and redeploys. Nothing warns that a working
 * brain is about to stop accepting documents for a job with no work in it.
 * This check RECORDS that. If someone adds the missing "nothing to do" path,
 * this is the test to update, deliberately. */
const alreadyCurrent = await runUpdate({
  startAtVersion: PRODUCT_VERSION,
  startAtSchema: migrations.at(-1).version,
});
const currentEvents = alreadyCurrent.timeline.map((entry) => entry.event);
check("FINDING: update on an already-current brain still pauses it and migrates nothing",
  alreadyCurrent.error === null &&
  currentEvents.indexOf("deploy:PAUSED") === currentEvents.indexOf("bookmark") + 1 &&
  currentEvents.includes("deploy:active") &&
  alreadyCurrent.timeline.find((entry) => entry.event === "migrate:done")?.applied === 0,
  JSON.stringify(currentEvents));

console.log(`\nhealthy schema-22 update rehearsal: ${ran - fail}/${ran} passed`);
process.exit(fail ? 1 : 0);
