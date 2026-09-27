/**
 * A Worker paused on an OLDER release that the manifest still records is a
 * resumable paused generation once the owner installs a newer CLI.
 *
 * `brain rollback --yes` from the older kit, or a same-version update from it
 * that stopped inside its pause window, leaves the Worker paused on the version
 * the manifest records. The owner then installs the next release and runs
 * `brain update` (or `--force`, or `brain doctor --repair --yes`). That must
 * resume, not refuse with "if the Worker is newer than this CLI, install that
 * release": the Worker is older, and nothing else can un-pause it.
 *
 * Two genuine releases are driven here. The checked-out tree is one; the other
 * is a scratch copy of the same tree whose package version and Worker version
 * constant are moved one patch release away, so each release's CLI, Worker and
 * PRODUCT_VERSION agree exactly as a published kit's do. The older release's
 * real cmdRollback/cmdUpdate leaves the pause, and the newer release's real
 * cmdUpdate, cmdUpgrade, cmdMigrate, cmdDoctorRepair and readUpdateBacklog
 * resume it. Every backlog and /health read is answered by the real router of
 * whichever release's Worker is currently deployed, over one sqlite database
 * at the head schema. Only the HTTP transport, the Cloudflare control plane,
 * the Worker upload and the provider-side bootstrap are stand-ins.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as checkedOutCli from "../brain.mjs";
import checkedOutWorker from "../worker/src/index.js";
import * as ingestRuntime from "../ingest/run.mjs";
import { renderCliCommands } from "../operations/cli-guidance.mjs";
import { installFolderScheduler } from "../operations/folder-scheduler.mjs";

const ROOT = realpathSync.native(fileURLToPath(new URL("../", import.meta.url)));
const PRODUCT_VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const [MAJOR, MINOR, PATCH] = PRODUCT_VERSION.split(".").map((part) => Number.parseInt(part, 10));
assert.ok(PATCH >= 1, "the fixture needs a previous patch release to exist");
const NEXT_VERSION = `${MAJOR}.${MINOR}.${PATCH + 1}`;
const PREVIOUS_VERSION = `${MAJOR}.${MINOR}.${PATCH - 1}`;

const ACCOUNT_ID = "4".repeat(32);
const DATABASE_ID = "44444444-2222-4333-8444-555555555555";
const ADMIN_KEY = "rehearsal-admin-key";
const BOOKMARK = "00000085-00000002-00004e1e-aaaaaaaabbbbccccddddeeeeffff0000";
const EXCLUDED_FROM_RELEASE_COPY = new Set([".git", "node_modules", "test", "docs", "frontend", "onboarding", "evidence"]);

const scratchReleases = [];
after(() => {
  for (const directory of scratchReleases) rmSync(directory, { recursive: true, force: true });
});

/**
 * A scratch copy of this tree published as `version`: package.json and the
 * Worker's compiled-in version constant both move, nothing else does.
 */
async function scratchRelease(version) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), `older-release-${version}-`)));
  scratchReleases.push(directory);
  for (const entry of readdirSync(ROOT)) {
    if (EXCLUDED_FROM_RELEASE_COPY.has(entry)) continue;
    cpSync(join(ROOT, entry), join(directory, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, "node_modules"), join(directory, "node_modules"), "dir");
  const packagePath = join(directory, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  writeFileSync(packagePath, `${JSON.stringify({ ...packageJson, version }, null, 2)}\n`);
  const versionPath = join(directory, "worker", "src", "lib", "version.js");
  const source = readFileSync(versionPath, "utf8");
  const relabeled = source.replace(
    `export const WORKER_VERSION = "${PRODUCT_VERSION}";`,
    `export const WORKER_VERSION = "${version}";`,
  );
  assert.notEqual(relabeled, source, "the Worker version constant must move with the package version");
  writeFileSync(versionPath, relabeled);
  const cli = await import(pathToFileURL(join(directory, "brain.mjs")).href);
  const worker = (await import(pathToFileURL(join(directory, "worker", "src", "index.js")).href)).default;
  return { version, cli, worker };
}

const CHECKED_OUT = { version: PRODUCT_VERSION, cli: checkedOutCli, worker: checkedOutWorker };
const NEXT = await scratchRelease(NEXT_VERSION);
const PREVIOUS = await scratchRelease(PREVIOUS_VERSION);

const migrationDir = join(ROOT, "migrations", "d1");
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

/** A Brain installed from `version`: head schema, one chunk, verified projection. */
function brainDatabase(version) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL,
    applied_at TEXT NOT NULL, checksum TEXT NOT NULL)`);
  for (const migration of migrations) {
    for (const statement of checkedOutCli.splitStatements(migration.sql)) db.exec(statement);
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?,?,?,?)")
      .run(migration.version, migration.name, "2026-09-01T00:00:00Z", migration.checksum);
  }
  db.prepare(
    `INSERT INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring,
        vector_drain_lease_owner, vector_drain_lease_expires_at, vector_projection_status,
        vector_projection_bootstrap_base_count)
     VALUES (1, 'harbor', ?, ?, 4, '2026-09-01T00:00:00Z', 'stable', NULL, NULL, 'verified', 1)`,
  ).run(version, HEAD_SCHEMA);
  db.prepare(
    `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash)
     VALUES ('drive:doc-1', 'drive', 'doc-1', 'Synthetic operating agreement', ?, 'hash:doc-1')`,
  ).run(Date.now());
  db.prepare(
    `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, vector_id)
     VALUES ('drive:doc-1#0', 'drive:doc-1', 0, 'the owner holds the brain', 'drive', 'drive:doc-1#0')`,
  ).run();
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

function manifestFor(version, { watchedPath = null } = {}) {
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
    corpora: {
      ...(watchedPath ? {
        local_folder: { enabled: true, path: watchedPath, source: "documents" },
      } : {}),
      upload: {
        enabled: true,
        ...(watchedPath ? { folders: [{ path: watchedPath, source: "documents" }] } : {}),
      },
    },
    ...(watchedPath ? { operations: { folder_ingest_cron: "0 9 * * *" } } : {}),
  };
}

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
 * One owner's installation of `installed`: the database, the deployed Worker
 * (its release, drain mode and provider vector count) and the manifest.
 */
function installation(installed, { activeFolder = false } = {}) {
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "older-release-paused-")));
  const watchedPath = activeFolder ? join(sandbox, "Watched Files") : null;
  if (watchedPath) {
    mkdirSync(watchedPath);
    writeFileSync(
      join(watchedPath, "fixture.txt"),
      "synthetic watched-folder text with enough words for the real dry-run walker\n",
    );
  }
  const manifestPath = join(sandbox, "brain.manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifestFor(installed.version, { watchedPath }), null, 2)}\n`);
  const db = brainDatabase(installed.version);
  const live = { release: installed, mode: "active", vectors: 1 };
  const events = [];
  const restore = { beforeFirstIngest: false };
  const reads = { backlog: 0, probe: 0 };
  const failures = { bootstrap: false };
  const env = () => ({
    STORAGE: "d1",
    ADMIN_KEY,
    DB: workerD1(db),
    VECTORIZE: { describe: async () => ({ vectorCount: live.vectors }) },
    ...(live.mode === "paused-for-upgrade" ? { VECTOR_DRAIN_MODE: "paused-for-upgrade" } : {}),
  });
  // Every request reaches the real router of the release deployed right now.
  const http = async (url, init = {}, requestOptions = {}) => {
    const target = new URL(url);
    if (requestOptions?.what === "the update backlog check") reads.backlog += 1;
    if (target.pathname === "/health" && !target.search) reads.probe += 1;
    return live.release.worker.fetch(new Request(url, init), env(), { waitUntil() {} });
  };
  const d1Query = async (account, database, sql, params = []) => {
    assert.equal(account, ACCOUNT_ID);
    assert.equal(database, DATABASE_ID);
    const statement = db.prepare(sql);
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
        db.prepare("DELETE FROM chunks").run();
        db.prepare("DELETE FROM documents").run();
        db.prepare("DELETE FROM vector_outbox").run();
        live.vectors = 0;
      }
      return { bookmark: BOOKMARK };
    }
    throw new Error(`unexpected Cloudflare call ${path}`);
  };

  /** The control-plane stand-ins a given release's CLI runs with. */
  function kit(release) {
    // A deploy uploads the Worker of the kit that runs it.
    const cmdDeploy = async (_path, options = {}) => {
      live.release = release;
      live.mode = options.pauseVectorDrainForUpgrade === true ? "paused-for-upgrade" : "active";
      events.push(`deploy:${release.version}:${live.mode}`);
      return { ok: true };
    };
    const cmdHealth = async (path, options = {}) => {
      events.push(`health:${options.expectDrainMode || "none"}`);
      return release.cli.cmdHealth(path, {
        ...options,
        request: http,
        resolveKey: () => ADMIN_KEY,
        wait: async () => {},
      });
    };
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
        return release.cli.cmdMigrate(path, {
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
      commitManifestVersion: release.cli.commitManifestVersion,
      waitForVectorDrainQuiescence: async () => {},
      readUpdateBacklog: release.cli.readUpdateBacklog,
      updateBacklogOptions: {
        resolveAdminKey: () => ADMIN_KEY,
        http,
        sleep: async () => { throw new Error("a readable receipt must not be retried"); },
      },
    };
    return { release, cmdDeploy, cmdHealth, upgradeOptions };
  }

  return {
    sandbox, manifestPath, watchedPath, db, live, events, reads, failures, restore, http, d1Query, cf, kit,
    manifestVersion: () => JSON.parse(readFileSync(manifestPath, "utf8")).brain.version,
    recordedVersion: () => db.prepare("SELECT product_version AS v FROM install_state WHERE id = 1").get().v,
    close() {
      db.close();
      rmSync(sandbox, { recursive: true, force: true });
    },
  };
}

async function quietly(run) {
  const priorLog = console.log;
  const output = [];
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

/**
 * `duringAcceptance` runs inside the acceptance stand-in, a stage every
 * completed update reaches, so a control can make something happen within a
 * real update run without replacing any product step.
 */
async function update(brain, release, { force = false, duringAcceptance = null } = {}) {
  const kit = brain.kit(release);
  const upgradeOptions = duringAcceptance
    ? {
      ...kit.upgradeOptions,
      cmdTest: async (...args) => {
        const accepted = await kit.upgradeOptions.cmdTest(...args);
        await duringAcceptance();
        return accepted;
      },
    }
    : kit.upgradeOptions;
  return quietly(() => release.cli.cmdUpdate(brain.manifestPath, {
    discoverInstalledManifest: () => ({ path: brain.manifestPath, source: "remembered" }),
    readUpdateBacklog: release.cli.readUpdateBacklog,
    updateBacklogOptions: upgradeOptions.updateBacklogOptions,
    ...(force ? { forceQueuedUpdate: true } : {}),
    adoptCloudflareAuthProfile: async () => {},
    withCloudflareControl: async (action) => action(),
    cmdVerify: async () => {},
    upgradeOptions,
    reconcileExistingOwnerAgents: null,
    writeClaudeWorkspaceGuideAfterUpdate: null,
  }));
}

async function rollback(brain, release) {
  const { cmdDeploy, cmdHealth, upgradeOptions } = brain.kit(release);
  return quietly(() => release.cli.cmdRollback(brain.manifestPath, BOOKMARK, {
    confirmed: true,
    resolveAccount: upgradeOptions.resolveAccount,
    cf: brain.cf,
    d1Query: brain.d1Query,
    cmdDeploy,
    cmdHealth,
    waitForVectorDrainQuiescence: async () => {},
  }));
}

async function doctorRepair(brain, release) {
  const { upgradeOptions } = brain.kit(release);
  return quietly(() => release.cli.cmdDoctorRepair(brain.manifestPath, {
    confirmed: true,
    diagnoseOptions: {
      http: brain.http,
      resolveAccount: upgradeOptions.resolveAccount,
      d1Query: brain.d1Query,
    },
    upgradeOptions,
  }));
}

/** The older kit's own `brain rollback --yes` leaves its Worker paused. */
async function pausedByOlderRollback(older) {
  const brain = installation(older);
  brain.restore.beforeFirstIngest = true;
  const rolledBack = await rollback(brain, older);
  assert.equal(rolledBack.error, null, rolledBack.error?.message);
  assert.equal(brain.live.mode, "paused-for-upgrade");
  assert.equal(brain.live.release, older);
  assert.equal(brain.manifestVersion(), older.version);
  brain.events.length = 0;
  brain.reads.backlog = 0;
  brain.reads.probe = 0;
  return brain;
}

/** The older kit's same-version update stops inside its pause window. */
async function pausedByOlderStoppedUpdate(older) {
  const brain = installation(older);
  brain.failures.bootstrap = true;
  const stopped = await update(brain, older);
  assert.match(String(stopped.error?.message || ""), /CANNOT ACCEPT DOCUMENTS RIGHT NOW/u);
  assert.equal(brain.live.mode, "paused-for-upgrade");
  assert.equal(brain.live.release, older);
  assert.equal(brain.manifestVersion(), older.version);
  brain.failures.bootstrap = false;
  brain.events.length = 0;
  brain.reads.backlog = 0;
  brain.reads.probe = 0;
  return brain;
}

function upgradeStages(brain) {
  return brain.events.filter((event) => /^deploy:|^bootstrap$|^migrate$/u.test(event));
}

function assertResumedTo(brain, newer) {
  assert.deepEqual(upgradeStages(brain), [
    `deploy:${newer.version}:paused-for-upgrade`,
    "migrate",
    "bootstrap",
    `deploy:${newer.version}:active`,
  ]);
  assert.ok(brain.events.includes("acceptance"), JSON.stringify(brain.events));
  assert.equal(brain.live.release, newer);
  assert.equal(brain.live.mode, "active");
  assert.equal(brain.manifestVersion(), newer.version);
  assert.equal(brain.recordedVersion(), newer.version);
}

function folderLaunchctlHarness() {
  const calls = [];
  let loaded = false;
  let mutations = 0;
  return {
    calls,
    mutationCount: () => mutations,
    launchctl(args) {
      calls.push([...args]);
      if (args[0] === "print") {
        return loaded
          ? { status: 0, stdout: "state = waiting\nruns = 1\nlast exit code = 0\n" }
          : { status: 113, stdout: "", stderr: "not loaded" };
      }
      if (args[0] === "bootstrap") {
        mutations += 1;
        loaded = true;
        return { status: 0, stdout: "" };
      }
      if (args[0] === "bootout") {
        mutations += 1;
        loaded = false;
        return { status: 0, stdout: "" };
      }
      return { status: 0, stdout: "" };
    },
  };
}

/**
 * The folder-walk boundary itself. The real walker lists each directory through
 * `readdirSync` imported from node:fs, and no update option reaches the ingest
 * library, so a wrapper handed to a later command cannot see what an update
 * does. Replacing the builtin listing calls and syncing their ESM bindings
 * reaches every module already loaded, including each scratch release's own
 * ingest module. Only listings of a watched root, or of a path under it, are
 * recorded.
 */
function observeFolderListings(roots) {
  const watched = roots.map((root) => realpathSync.native(root));
  const isUnder = (path, root) => path === root || path.startsWith(`${root}${sep}`);
  const listings = [];
  const originals = [];
  const wrap = (owner, name) => {
    const original = owner[name];
    if (typeof original !== "function") return;
    originals.push([owner, name, original]);
    owner[name] = function observedListing(target, ...rest) {
      let path = null;
      try {
        path = target instanceof URL ? fileURLToPath(target) : resolve(String(target));
      } catch {
        path = null;
      }
      if (path && watched.some((root) => isUnder(path, root))) listings.push({ call: name, path });
      return original.call(this, target, ...rest);
    };
  };
  for (const name of ["readdirSync", "readdir", "opendirSync", "opendir"]) wrap(fs, name);
  for (const name of ["readdir", "opendir"]) wrap(fsPromises, name);
  syncBuiltinESMExports();
  return {
    under: (root) => listings.filter(({ path }) => isUnder(path, realpathSync.native(root))),
    restore() {
      for (const [owner, name, original] of originals.reverse()) owner[name] = original;
      syncBuiltinESMExports();
    },
  };
}

test("the documented 0.4.8 active folder updates, retires, and refuses both legacy walks", async () => {
  assert.equal(PREVIOUS_VERSION, "0.4.8", "this regression is pinned to the documented 0.4.8 shape");
  const brain = installation(PREVIOUS, { activeFolder: true });
  const walkedControl = installation(PREVIOUS, { activeFolder: true });
  // One hook, connected before either update starts and removed only at the
  // end, so the zero below and the control's count come from the same observer.
  const folderListings = observeFolderListings([brain.watchedPath, walkedControl.watchedPath]);
  const home = join(brain.sandbox, "home");
  mkdirSync(home);
  const launch = folderLaunchctlHarness();
  const schedulerOptions = {
    platform: "darwin",
    home,
    uid: 501,
    nodePath: "/opt/fixture/node",
    brainPath: "/opt/fixture/brain.mjs",
    launchctl: launch.launchctl,
    localTimeZone: "America/Phoenix",
    probeSchedulerLock: () => false,
  };

  try {
    const installed = installFolderScheduler(brain.manifestPath, schedulerOptions);
    const schedulerBytes = readFileSync(installed.plistPath);
    const schedulerMutationsBeforeUpdate = launch.mutationCount();

    const run = await update(brain, CHECKED_OUT);
    assert.equal(run.error, null, run.error?.message);
    assertResumedTo(brain, CHECKED_OUT);
    assert.equal(
      launch.mutationCount(),
      schedulerMutationsBeforeUpdate,
      "the completed update reaches every remote stage without changing the local folder scheduler",
    );
    assert.deepEqual(readFileSync(installed.plistPath), schedulerBytes);
    assert.deepEqual(
      folderListings.under(brain.watchedPath),
      [],
      "the completed update never lists the active folder",
    );

    // Control: the same hook, across the same real update path, counts a walk
    // that does happen inside it. Without this the zero above could come from
    // a hook that sees nothing.
    let controlWalk = null;
    const walkedRun = await update(walkedControl, CHECKED_OUT, {
      duringAcceptance: () => { controlWalk = ingestRuntime.walk(walkedControl.watchedPath); },
    });
    assert.equal(walkedRun.error, null, walkedRun.error?.message);
    assertResumedTo(walkedControl, CHECKED_OUT);
    assert.equal(controlWalk?.complete, true);
    assert.deepEqual(controlWalk.files.map((file) => file.rel), ["fixture.txt"]);
    assert.deepEqual(
      folderListings.under(walkedControl.watchedPath).map(({ path }) => path),
      [walkedControl.watchedPath],
      "the same hook records the walk made inside the control's real update",
    );
    assert.deepEqual(folderListings.under(brain.watchedPath), []);

    let remoteExpectationCalls = 0;
    const retired = await quietly(() => checkedOutCli.cmdFolder(brain.manifestPath, ["off"], {
      platform: "darwin",
      now: () => new Date("2026-09-28T16:36:00.000Z"),
      schedulerOptions,
      probeSourceIngestLock: () => ({ busy: false }),
      resolveAdminKey: () => "fixture-admin-value",
      resolveBaseUrl: async () => "https://fixture.invalid",
      postSourceExpectation: async () => { remoteExpectationCalls += 1; return { ok: true }; },
    }));
    assert.equal(retired.error, null, retired.error?.message);
    assert.equal(retired.result?.changed, true);
    assert.equal(launch.mutationCount(), schedulerMutationsBeforeUpdate + 1);
    assert.equal(existsSync(installed.plistPath), false);
    assert.equal(remoteExpectationCalls, 1, "product retirement reaches the freshness decision point");

    const retiredManifest = JSON.parse(readFileSync(brain.manifestPath, "utf8"));
    assert.equal(retiredManifest.brain.version, PRODUCT_VERSION);
    assert.equal(retiredManifest.corpora.local_folder.retired_source, "documents");

    let walks = 0;
    const ingest = async (manifest, flags) => quietly(() => checkedOutCli.cmdIngestLocal(
      manifest,
      brain.manifestPath,
      { ...flags, "dry-run": true },
      {
        sourceIngestLockOptions: { home, platform: process.platform },
        ingestLib: async () => ({
          ...ingestRuntime,
          walk(root, options) {
            walks += 1;
            return ingestRuntime.walk(root, options);
          },
        }),
      },
    ));

    const retiredSource = await ingest(retiredManifest, {
      path: brain.watchedPath,
      source: "documents",
    });
    assert.equal(retiredSource.error?.reason, "LOCAL_FOLDER_RETIRED:retired_source");
    const barePath = await ingest(retiredManifest, { path: brain.watchedPath });
    assert.equal(barePath.error?.reason, "LOCAL_FOLDER_RETIRED:bare_path_after_retirement");
    assert.equal(walks, 0, "both retired-folder decisions are reached before the walker");
    assert.deepEqual(folderListings.under(brain.watchedPath), []);

    const activeControl = structuredClone(retiredManifest);
    activeControl.corpora.local_folder = {
      enabled: true,
      path: brain.watchedPath,
      source: "documents",
    };
    activeControl.corpora.upload.enabled = true;
    delete activeControl.corpora.upload.retired_at;
    const allowed = await ingest(activeControl, {
      path: brain.watchedPath,
      source: "documents",
    });
    assert.equal(allowed.error, null, allowed.error?.message);
    assert.equal(walks, 1, "the non-retired control reaches the real walker exactly once");
    assert.ok(allowed.result?.would_send >= 1);
    assert.deepEqual(
      folderListings.under(brain.watchedPath).map(({ path }) => path),
      [brain.watchedPath],
      "the folder-walk hook agrees with the ingest wrapper: one walk, made by the non-retired control",
    );
  } finally {
    folderListings.restore();
    walkedControl.close();
    brain.close();
  }
});

// Each release's CLI renders its own guidance: on Windows a command names the
// node executable and that release's brain.mjs, so the expectation must go
// through the renderer of the release that actually ran.
const PAUSED_QUEUED_MESSAGE = (release, pending, consequence) => release.cli.renderCliCommands(
  `This Brain is still paused for an update that has not finished, and it has ${pending} queued search ` +
    "update(s). A paused Brain does not process its queue, so waiting will not clear it, and this update will " +
    `not continue over queued work. ${consequence} Do not run \`brain drain\` or clear VECTOR_DRAIN_MODE by hand. ` +
    "Run `brain health` and keep its output for support.",
);

for (const [older, newer] of [[CHECKED_OUT, NEXT], [PREVIOUS, CHECKED_OUT]]) {
  const pair = `Worker ${older.version} paused, manifest ${older.version}, CLI ${newer.version}`;

  test(`${pair}: the older kit's rollback, then brain update resumes and completes`, async () => {
    const brain = await pausedByOlderRollback(older);
    try {
      const run = await update(brain, newer);
      assert.equal(run.error, null, run.error?.message);
      // Both gates read the older paused Worker's real receipt once each.
      assert.equal(brain.reads.backlog, 2);
      assertResumedTo(brain, newer);
    } finally {
      brain.close();
    }
  });

  test(`${pair}: the older kit's rollback, then brain update --force resumes and completes`, async () => {
    const brain = await pausedByOlderRollback(older);
    try {
      const run = await update(brain, newer, { force: true });
      assert.equal(run.error, null, run.error?.message);
      assert.equal(brain.reads.backlog, 2);
      assertResumedTo(brain, newer);
    } finally {
      brain.close();
    }
  });

  test(`${pair}: the older kit's rollback, then doctor --repair --yes resumes and completes`, async () => {
    const brain = await pausedByOlderRollback(older);
    try {
      const repaired = await doctorRepair(brain, newer);
      assert.equal(repaired.error, null, repaired.error?.message);
      // The diagnosis read the paused older Worker's /health, and the
      // pre-pause gate read its real backlog receipt.
      assert.equal(brain.reads.probe, 1);
      assert.equal(brain.reads.backlog, 1);
      assertResumedTo(brain, newer);
    } finally {
      brain.close();
    }
  });

  test(`${pair}: a stopped older same-version update resumes through brain update and doctor --repair`, async () => {
    const viaUpdate = await pausedByOlderStoppedUpdate(older);
    try {
      const run = await update(viaUpdate, newer);
      assert.equal(run.error, null, run.error?.message);
      assert.equal(viaUpdate.reads.backlog, 2);
      assertResumedTo(viaUpdate, newer);
    } finally {
      viaUpdate.close();
    }
    const viaDoctor = await pausedByOlderStoppedUpdate(older);
    try {
      const repaired = await doctorRepair(viaDoctor, newer);
      assert.equal(repaired.error, null, repaired.error?.message);
      assert.equal(viaDoctor.reads.backlog, 1);
      assertResumedTo(viaDoctor, newer);
    } finally {
      viaDoctor.close();
    }
  });

  test(`${pair}: 3 queued updates refuse truthfully at both gates`, async () => {
    const brain = await pausedByOlderRollback(older);
    try {
      queueVectorWork(brain.db, 3);
      const run = await update(brain, newer);
      assert.equal(run.error?.message, PAUSED_QUEUED_MESSAGE(newer, 3, "Nothing was changed."));
      assert.doesNotMatch(run.error?.message || "", /not an earlier update|install that release|few minutes/u);
      assert.equal(brain.reads.backlog, 1);
      assert.deepEqual(brain.events, []);

      brain.reads.backlog = 0;
      const forced = await update(brain, newer, { force: true });
      assert.ok(String(forced.error?.message || "").includes(
        PAUSED_QUEUED_MESSAGE(newer, 3, "The paused deployment was not started."),
      ), forced.error?.message);
      assert.equal(brain.reads.backlog, 2);
      assert.equal(brain.events.some((event) => event.startsWith("deploy:")), false);
      assert.equal(brain.live.release, older);
      assert.equal(brain.live.mode, "paused-for-upgrade");
      assert.equal(brain.manifestVersion(), older.version);
    } finally {
      brain.close();
    }
  });
}

test(`a Worker paused on ${NEXT_VERSION} that the manifest records is still refused by CLI ${PRODUCT_VERSION}`, async () => {
  const brain = await pausedByOlderRollback(NEXT);
  try {
    const generation = renderCliCommands(
      `This Brain's Worker reports version ${NEXT_VERSION} (paused-for-upgrade), but this manifest records ` +
        `${NEXT_VERSION} and this CLI is ${PRODUCT_VERSION}. That is not an earlier update of this CLI to resume, ` +
        "so its queued search updates cannot be bound to this manifest. Nothing was changed. Run `brain health` " +
        "to see what is serving; if the Worker is newer than this CLI, install that release, then run " +
        "`brain update` again.",
    );
    const run = await update(brain, CHECKED_OUT);
    assert.equal(run.error?.message, generation);
    assert.equal(brain.reads.backlog, 1);
    assert.deepEqual(brain.events, []);

    // `--force` passes only the first queue gate; update's downgrade guard
    // then refuses before the pre-pause gate or any deployment.
    const forced = await update(brain, CHECKED_OUT, { force: true });
    assert.match(String(forced.error?.message || ""), new RegExp(
      `^update refused to downgrade this brain from ${NEXT_VERSION.replaceAll(".", "\\.")} to ` +
        `${PRODUCT_VERSION.replaceAll(".", "\\.")}\\. Nothing was changed\\.`, "u"));
    // One more backlog read (the forced first gate), none at the pre-pause gate.
    assert.equal(brain.reads.backlog, 2);
    assert.equal(brain.events.some((event) => event.startsWith("deploy:")), false);

    const repaired = await doctorRepair(brain, CHECKED_OUT);
    assert.ok(repaired.error, "doctor must not resume a Worker newer than this CLI");
    assert.equal(brain.events.some((event) => event.startsWith("deploy:")), false);
    assert.equal(brain.live.release, NEXT);
    assert.equal(brain.live.mode, "paused-for-upgrade");
    assert.equal(brain.manifestVersion(), NEXT_VERSION);
  } finally {
    brain.close();
  }
});

/* ---- a stale deploy: the Worker is OLDER than the release the manifest records ---- */

/**
 * The manifest already records `recorded` (an update finished), and then the
 * older kit's `brain deploy` or `brain rollback --yes` put its own Worker back:
 * Worker `older`, active or paused, manifest and CLI `recorded`. That Worker
 * is a stale deploy this CLI's update replaces, not a generation it cannot
 * bind. Its queue is still read in the mode it reports.
 */
async function staleOlderWorker(recorded, older, mode) {
  const brain = installation(recorded);
  await brain.kit(older).cmdDeploy(brain.manifestPath, {
    pauseVectorDrainForUpgrade: mode === "paused-for-upgrade",
  });
  assert.equal(brain.live.release, older);
  assert.equal(brain.live.mode, mode);
  assert.equal(brain.manifestVersion(), recorded.version);
  brain.events.length = 0;
  brain.reads.backlog = 0;
  brain.reads.probe = 0;
  return brain;
}

const ACTIVE_QUEUED_MESSAGE = (release, pending) => release.cli.renderCliCommands(
  `This Brain is still processing ${pending} queued search update(s). Updating now would pause it mid-queue. ` +
    "Nothing was changed. Wait until `brain health` says query-ready, then run the update again.",
);

for (const [recorded, older] of [[CHECKED_OUT, PREVIOUS], [NEXT, CHECKED_OUT]]) {
  for (const mode of ["active", "paused-for-upgrade"]) {
    const stale = `Worker ${older.version} ${mode}, manifest ${recorded.version}, CLI ${recorded.version}`;

    test(`${stale}: an empty queue lets brain update replace the stale Worker`, async () => {
      const brain = await staleOlderWorker(recorded, older, mode);
      try {
        const run = await update(brain, recorded);
        assert.equal(run.error, null, run.error?.message);
        assert.equal(brain.reads.backlog, 2);
        assertResumedTo(brain, recorded);
      } finally {
        brain.close();
      }
    });

    test(`${stale}: an empty queue lets brain update --force replace the stale Worker`, async () => {
      const brain = await staleOlderWorker(recorded, older, mode);
      try {
        const run = await update(brain, recorded, { force: true });
        assert.equal(run.error, null, run.error?.message);
        assert.equal(brain.reads.backlog, 2);
        assertResumedTo(brain, recorded);
      } finally {
        brain.close();
      }
    });

    test(`${stale}: an empty queue and doctor --repair --yes`, async () => {
      const brain = await staleOlderWorker(recorded, older, mode);
      try {
        const repaired = await doctorRepair(brain, recorded);
        assert.equal(repaired.error, null, repaired.error?.message);
        if (mode === "paused-for-upgrade") {
          assert.equal(brain.reads.backlog, 1);
          assertResumedTo(brain, recorded);
        } else {
          // doctor --repair resumes only a paused Brain (origin/main as well);
          // an active stale Worker is diagnosed as accepting documents and
          // left alone. `brain update` above is its remedy.
          assert.deepEqual(repaired.result, { paused: false });
          assert.equal(brain.reads.backlog, 0);
          assert.deepEqual(brain.events, []);
          assert.equal(brain.live.release, older);
        }
      } finally {
        brain.close();
      }
    });

    test(`${stale}: 3 queued updates refuse truthfully with drain or recovery advice`, async () => {
      const brain = await staleOlderWorker(recorded, older, mode);
      try {
        queueVectorWork(brain.db, 3);
        const run = await update(brain, recorded);
        // An active stale Worker drains its own queue; a paused one never does.
        assert.equal(run.error?.message, mode === "active"
          ? ACTIVE_QUEUED_MESSAGE(recorded, 3)
          : PAUSED_QUEUED_MESSAGE(recorded, 3, "Nothing was changed."));
        assert.doesNotMatch(run.error?.message || "", /not an earlier update|install that release|few minutes/u);
        assert.equal(brain.reads.backlog, 1);
        assert.deepEqual(brain.events, []);

        brain.reads.backlog = 0;
        const forced = await update(brain, recorded, { force: true });
        assert.ok(forced.error, "queued work must still refuse at the pre-pause gate");
        assert.doesNotMatch(String(forced.error?.message || ""), /not an earlier update|install that release/u);
        assert.equal(brain.reads.backlog, 2);

        const repaired = await doctorRepair(brain, recorded);
        if (mode === "paused-for-upgrade") {
          assert.ok(String(repaired.error?.message || "").includes(
            PAUSED_QUEUED_MESSAGE(recorded, 3, "The paused deployment was not started."),
          ), repaired.error?.message);
        } else {
          assert.deepEqual(repaired.result, { paused: false });
        }

        assert.equal(brain.events.some((event) => event.startsWith("deploy:")), false);
        assert.equal(brain.live.release, older);
        assert.equal(brain.live.mode, mode);
        assert.equal(brain.manifestVersion(), recorded.version);
      } finally {
        brain.close();
      }
    });
  }
}

for (const mode of ["active", "paused-for-upgrade"]) {
  test(`a ${mode} Worker on ${NEXT_VERSION} over a ${PRODUCT_VERSION} manifest is still refused by CLI ${PRODUCT_VERSION}`, async () => {
    const brain = installation(CHECKED_OUT);
    try {
      await brain.kit(NEXT).cmdDeploy(brain.manifestPath, {
        pauseVectorDrainForUpgrade: mode === "paused-for-upgrade",
      });
      brain.events.length = 0;
      const run = await update(brain, CHECKED_OUT);
      assert.equal(run.error?.message, renderCliCommands(
        `This Brain's Worker reports version ${NEXT_VERSION} (${mode}), but this manifest records ` +
          `${PRODUCT_VERSION} and this CLI is ${PRODUCT_VERSION}. That is not an earlier update of this CLI to ` +
          "resume, so its queued search updates cannot be bound to this manifest. Nothing was changed. Run " +
          "`brain health` to see what is serving; if the Worker is newer than this CLI, install that release, " +
          "then run `brain update` again.",
      ));
      const forced = await update(brain, CHECKED_OUT, { force: true });
      assert.ok(forced.error, "--force must not replace a Worker newer than this CLI");
      const repaired = await doctorRepair(brain, CHECKED_OUT);
      if (mode === "paused-for-upgrade") {
        assert.ok(repaired.error, "doctor must not resume a Worker newer than this CLI");
      } else {
        assert.deepEqual(repaired.result, { paused: false });
      }
      assert.equal(brain.events.some((event) => event.startsWith("deploy:")), false);
      assert.equal(brain.live.release, NEXT);
      assert.equal(brain.live.mode, mode);
      assert.equal(brain.manifestVersion(), PRODUCT_VERSION);
    } finally {
      brain.close();
    }
  });
}
