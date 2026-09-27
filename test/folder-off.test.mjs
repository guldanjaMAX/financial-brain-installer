import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  classifyCliCredentialBoundary,
  cmdFolder,
  runCliCommandWithCredentialBoundary,
  supportErrorCode,
} from "../brain.mjs";
import {
  retiredIdentityOfPath,
  writeManifestAtomically,
} from "../operations/folder-retirement.mjs";
import {
  installFolderScheduler,
  runFolderIngest,
  statusFolderScheduler,
} from "../operations/folder-scheduler.mjs";
import { buildDriveSchedulerPlan as buildDrivePlan } from "../operations/drive-scheduler.mjs";
import { buildImessageSchedulerPlan } from "../operations/imessage-scheduler.mjs";
import { acquireSourceIngestLock } from "../operations/source-ingest-lock.mjs";
import { renderCliCommands } from "../operations/cli-guidance.mjs";

const FIXED_NOW = new Date("2026-09-28T16:36:00.000Z");
const ROOT = process.env.FOLDER_OFF_TEST_ROOT || tmpdir();
mkdirSync(ROOT, { recursive: true });
const sandbox = mkdtempSync(join(ROOT, "folder-off-test-"));

function manifestBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fixture({ mode = 0o600, createFolder = true, local = {}, upload = true } = {}) {
  const base = mkdtempSync(join(sandbox, "case-"));
  const home = join(base, "home");
  const watched = join(base, "Watched Files");
  const manifestPath = join(base, "Brain Settings", "brain.manifest.json");
  mkdirSync(home, { recursive: true });
  if (createFolder) mkdirSync(watched, { recursive: true });
  mkdirSync(dirname(manifestPath), { recursive: true });
  const manifest = {
    manifest_version: 1,
    client: { slug: "fixture-brain", display_name: "Fixture Brain" },
    brain: { version: "0.4.9", domain: "fixture.invalid" },
    infrastructure: { cloudflare: { account_id: "fixture-account", storage: "d1" } },
    corpora: {
      local_folder: { enabled: true, path: watched, source: "documents", ...local },
      google_drive: { enabled: true },
      imessage: { enabled: true },
      ...(upload ? { upload: { enabled: true, folders: [{ path: watched, source: "documents" }], keep: "same" } } : {}),
    },
    operations: {
      folder_ingest_cron: "0 9 * * *",
      ingest_cron: "0 * * * *",
      imessage_capture_cron: "* * * * *",
    },
  };
  const original = manifestBytes(manifest);
  writeFileSync(manifestPath, original, { mode });
  chmodSync(manifestPath, mode);
  const statePath = join(dirname(manifestPath), ".brain-ingest-documents.json");
  const stateBytes = `${JSON.stringify({ version: 1, done: { "one.txt": "hash-one" } }, null, 2)}\n`;
  writeFileSync(statePath, stateBytes, { mode: 0o600 });

  const dbPath = join(base, "fixture.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE documents (doc_uid TEXT PRIMARY KEY, content_hash TEXT NOT NULL, deleted_at TEXT)");
  db.prepare("INSERT INTO documents VALUES (?, ?, NULL)").run("documents:one.txt", "content-hash-one");
  db.prepare("INSERT INTO documents VALUES (?, ?, NULL)").run("documents:two.txt", "content-hash-two");
  db.close();
  return { base, home, watched, manifestPath, manifest, original, mode, statePath, stateBytes, dbPath };
}

function dbSnapshot(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  const rows = db.prepare("SELECT doc_uid, content_hash, deleted_at FROM documents ORDER BY doc_uid").all();
  db.close();
  return rows;
}

function launchctlHarness({ loaded = false, running = false } = {}) {
  const calls = [];
  let isLoaded = loaded;
  let isRunning = running;
  const launchctl = (args) => {
    calls.push([...args]);
    if (args[0] === "print") {
      return isLoaded
        ? { status: 0, stdout: `state = ${isRunning ? "running" : "waiting"}\nruns = 1\nlast exit code = 0\n` }
        : { status: 113, stdout: "", stderr: "not loaded" };
    }
    if (args[0] === "bootstrap") { isLoaded = true; isRunning = false; return { status: 0, stdout: "" }; }
    if (args[0] === "bootout") { isLoaded = false; isRunning = false; return { status: 0, stdout: "" }; }
    return { status: 0, stdout: "" };
  };
  return { calls, launchctl, loaded: () => isLoaded, setRunning: (value) => { isRunning = value; } };
}

function schedulerOptions(f, launchctl, extra = {}) {
  return {
    platform: "darwin",
    home: f.home,
    uid: 501,
    nodePath: "/opt/fixture/node",
    brainPath: "/opt/fixture/brain.mjs",
    launchctl,
    localTimeZone: "America/Phoenix",
    ...extra,
  };
}

function folderOptions(f, harness, extra = {}) {
  return {
    platform: "darwin",
    now: () => new Date(FIXED_NOW),
    schedulerOptions: schedulerOptions(f, harness.launchctl, {
      probeSchedulerLock: () => false,
    }),
    sourceIngestLockOptions: { home: f.home, platform: process.platform },
    resolveBaseUrl: async () => "https://fixture.invalid",
    resolveAdminKey: () => "fixture-admin-value",
    postSourceExpectation: async () => ({ ok: true }),
    ...extra,
  };
}

async function capture(task) {
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values) => lines.push(values.map(String).join(" "));
  console.error = (...values) => lines.push(values.map(String).join(" "));
  try {
    const result = await task();
    return { result, error: null, text: lines.join("\n") };
  } catch (error) {
    return { result: null, error, text: lines.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

try {
  assert.equal(classifyCliCredentialBoundary("folder", ["fixture.json", "off"]), "folder");
  assert.equal(await runCliCommandWithCredentialBoundary("folder", async () => "local", {
    withWranglerSession: () => { throw new Error("folder must not inspect a Wrangler login"); },
  }), "local");
  assert.equal(
    supportErrorCode(new Error("scheduler mutation failed"), { command: "folder" }),
    "COMMAND_FAILED",
  );

  {
    const f = fixture();
    const launch = launchctlHarness();
    const installed = installFolderScheduler(f.manifestPath, schedulerOptions(f, launch.launchctl));
    assert.equal(existsSync(installed.plistPath), true);
    const scheduledHash = installed.configHash;
    const beforeDb = dbSnapshot(f.dbPath);
    const expectationCalls = [];
    const networkCalls = [];
    const stateBefore = readFileSync(f.statePath);

    const off = await capture(() => cmdFolder(f.manifestPath, ["off"], folderOptions(f, launch, {
      fetchImpl: async (url) => { networkCalls.push(String(url)); throw new Error("unexpected request"); },
      postSourceExpectation: async (base, key, receipt) => {
        expectationCalls.push({ base, keyPresent: Boolean(key), receipt });
        return { ok: true };
      },
    })));
    assert.ifError(off.error);
    assert.equal(existsSync(installed.plistPath), false);
    assert.deepEqual(launch.calls.slice(-2).map((args) => args[0]), ["print", "bootout"]);
    assert.equal(networkCalls.length, 0, "folder off must not call ingest, forget, or count routes");
    assert.deepEqual(expectationCalls, [{
      base: "https://fixture.invalid",
      keyPresent: true,
      receipt: { source: "documents", kind: "upload", expected_refresh_seconds: null },
    }]);

    const folderStat = statSync(realpathSync.native(f.watched), { bigint: true });
    const expected = structuredClone(f.manifest);
    expected.corpora.local_folder.enabled = false;
    expected.corpora.local_folder.retired_at = FIXED_NOW.toISOString();
    expected.corpora.local_folder.retired_path = f.watched;
    expected.corpora.local_folder.retired_source = "documents";
    expected.corpora.local_folder.retired_identity = {
      realpath: realpathSync.native(f.watched),
      dev: String(folderStat.dev),
      ino: String(folderStat.ino),
    };
    expected.corpora.local_folder.retired_by = "brain folder off";
    expected.corpora.upload.enabled = false;
    expected.corpora.upload.retired_at = FIXED_NOW.toISOString();
    assert.deepEqual(JSON.parse(readFileSync(f.manifestPath, "utf8")), expected);
    const retiredText = readFileSync(f.manifestPath, "utf8");
    assert.ok(retiredText.indexOf('"retired_at"') < retiredText.indexOf('"retired_path"'));
    assert.ok(retiredText.indexOf('"retired_path"') < retiredText.indexOf('"retired_source"'));
    assert.ok(retiredText.indexOf('"retired_source"') < retiredText.indexOf('"retired_identity"'));
    assert.ok(retiredText.indexOf('"retired_identity"') < retiredText.indexOf('"retired_by"'));

    const backupPath = join(dirname(f.manifestPath), "brain.manifest.json.before-folder-off-20260928T163600Z");
    assert.equal(readFileSync(backupPath, "utf8"), f.original);
    assert.equal(lstatSync(backupPath).mode & 0o777, f.mode);
    assert.equal(lstatSync(f.manifestPath).mode & 0o777, f.mode);
    assert.deepEqual(readFileSync(f.statePath), stateBefore);
    assert.deepEqual(dbSnapshot(f.dbPath), beforeDb);
    assert.match(off.text, /Every document already loaded from it stays in your Brain/);
    assert.match(off.text, /Changes you make to files there will no longer reach your Brain/);
    assert.match(off.text, /anything that saved files into this folder for your Brain/);
    assert.ok(!off.text.includes(renderCliCommands(
      `brain schedule ${f.manifestPath} --install --folder`,
    )), "successful folder retirement must not print scheduler recovery guidance");

    const logBaseline = [installed.stdoutPath, installed.stderrPath].map((path) => {
      const state = statSync(path);
      return { path, size: state.size, mtimeMs: state.mtimeMs };
    });
    const afterOffDb = dbSnapshot(f.dbPath);
    const staleLog = [];
    assert.throws(() => runFolderIngest(f.manifestPath, schedulerOptions(f, launch.launchctl, {
      expectedConfigHash: scheduledHash,
      spawn: (...args) => { staleLog.push(args); return { status: 0 }; },
    })), /watched folder is retired and cannot have a scheduler installed/);
    assert.equal(staleLog.length, 0, "a stale scheduled tick reaches the retired-folder decision but never spawn");
    const nextDayStatus = statusFolderScheduler(f.manifestPath, schedulerOptions(f, launch.launchctl));
    assert.equal(nextDayStatus.loaded, false);
    assert.equal(existsSync(installed.plistPath), false);
    assert.deepEqual(logBaseline.map(({ path }) => {
      const state = statSync(path);
      return { path, size: state.size, mtimeMs: state.mtimeMs };
    }), logBaseline, "the simulated next-day tick changes neither folder log");
    assert.deepEqual(dbSnapshot(f.dbPath), afterOffDb, "the simulated next-day tick changes no document");
  }

  {
    const f = fixture();
    const launch = launchctlHarness();
    const installed = installFolderScheduler(f.manifestPath, schedulerOptions(f, launch.launchctl));
    let manifestWrites = 0;
    const failed = await capture(() => cmdFolder(f.manifestPath, ["off"], folderOptions(f, launch, {
      writeManifestAtomically: () => {
        manifestWrites += 1;
        throw new Error("injected manifest write failure");
      },
    })));
    const recoveryCommand = renderCliCommands(
      `brain schedule ${f.manifestPath} --install --folder`,
    );
    assert.equal(manifestWrites, 1,
      "the failure arm reaches the manifest write after scheduler removal");
    assert.equal(launch.calls.some((args) => args[0] === "bootout"), true,
      "the failure arm reaches scheduled-job removal before the write");
    assert.equal(existsSync(installed.plistPath), false,
      "the scheduled job remains removed after the manifest write fails");
    assert.match(failed.error?.message || "", /scheduled job is already removed/i);
    assert.ok((failed.error?.message || "").includes(recoveryCommand),
      "the write failure names the rendered command that restores the scheduled job");
    assert.deepEqual(readFileSync(f.manifestPath), Buffer.from(f.original),
      "the failed write leaves the original manifest bytes live");
  }

  {
    const f = fixture();
    const launch = launchctlHarness();
    const plan = installFolderScheduler(f.manifestPath, schedulerOptions(f, launch.launchctl));
    const spawns = [];
    const tick = runFolderIngest(f.manifestPath, schedulerOptions(f, launch.launchctl, {
      expectedConfigHash: plan.configHash,
      spawn: (command, args) => { spawns.push({ command, args }); return { status: 0 }; },
    }));
    assert.equal(tick.status, "complete");
    assert.equal(spawns.length, 1, "the enabled control reaches spawn exactly once");
    assert.deepEqual(spawns[0].args.slice(-6), [
      "/opt/fixture/node", "/opt/fixture/brain.mjs", "ingest", f.manifestPath,
      "--path", f.watched,
    ].concat(["--source", "documents"]).slice(-6));
    assert.deepEqual(spawns[0].args.slice(-4), ["--path", f.watched, "--source", "documents"]);
  }

  {
    const f = fixture();
    const launch = launchctlHarness();
    const first = await cmdFolder(f.manifestPath, ["off"], folderOptions(f, launch));
    const bytes = readFileSync(f.manifestPath);
    const backups = () => readdirSync(dirname(f.manifestPath)).filter((name) => name.includes("before-folder-off"));
    const firstBackups = backups();
    const second = await capture(() => cmdFolder(f.manifestPath, ["off"], folderOptions(f, launch, {
      now: () => new Date("2026-10-01T00:00:00.000Z"),
    })));
    assert.ifError(second.error);
    assert.deepEqual(readFileSync(f.manifestPath), bytes);
    assert.deepEqual(backups(), firstBackups);
    assert.match(second.text, /turned off on 2026-09-28T16:36:00\.000Z\. Nothing changed\./);
    assert.ok(first.backupPath);

    const edited = JSON.parse(bytes);
    edited.corpora.local_folder.enabled = true;
    writeFileSync(f.manifestPath, manifestBytes(edited));
    const repaired = await cmdFolder(f.manifestPath, ["off"], folderOptions(f, launch, {
      now: () => new Date("2026-10-01T00:00:00.000Z"),
    }));
    const fixed = JSON.parse(readFileSync(f.manifestPath, "utf8"));
    assert.equal(fixed.corpora.local_folder.enabled, false);
    assert.equal(fixed.corpora.local_folder.retired_at, FIXED_NOW.toISOString());
    assert.ok(repaired.backupPath.endsWith("before-folder-off-20261001T000000Z"));
  }

  {
    const notInstalled = fixture();
    const launch = launchctlHarness();
    const result = await capture(() => cmdFolder(notInstalled.manifestPath, ["off"], folderOptions(notInstalled, launch)));
    assert.ifError(result.error);
    assert.match(result.text, /scheduled job was not installed/i);
    assert.equal(JSON.parse(readFileSync(notInstalled.manifestPath, "utf8")).corpora.local_folder.enabled, false);

    const gone = fixture({ createFolder: false });
    const goneLaunch = launchctlHarness();
    await cmdFolder(gone.manifestPath, ["off"], folderOptions(gone, goneLaunch));
    assert.equal(JSON.parse(readFileSync(gone.manifestPath, "utf8")).corpora.local_folder.retired_identity, null);

    const noUpload = fixture({ upload: false });
    const noUploadLaunch = launchctlHarness();
    await cmdFolder(noUpload.manifestPath, ["off"], folderOptions(noUpload, noUploadLaunch));
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(noUpload.manifestPath, "utf8")).corpora, "upload"), false);
  }

  {
    const concurrent = fixture();
    const concurrentLaunch = launchctlHarness();
    const edited = structuredClone(concurrent.manifest);
    edited.concurrent_owner_edit = "preserve this exact edit";
    const editedBytes = Buffer.from(manifestBytes(edited));
    let concurrentEditWrites = 0;
    const refused = await capture(() => cmdFolder(
      concurrent.manifestPath,
      ["off"],
      folderOptions(concurrent, concurrentLaunch, {
        platform: "linux",
        writeManifestAtomically(path, intended, writeOptions) {
          concurrentEditWrites += 1;
          writeFileSync(path, editedBytes, { mode: concurrent.mode });
          return writeManifestAtomically(path, intended, writeOptions);
        },
      }),
    ));
    assert.equal(concurrentEditWrites, 1,
      "the concurrent-edit arm reaches the manifest write decision exactly once");
    assert.match(refused.error?.message || "", /manifest changed/i);
    assert.deepEqual(readFileSync(concurrent.manifestPath), editedBytes,
      "the concurrent owner edit remains the live manifest");
    const backupPath = `${concurrent.manifestPath}.before-folder-off-20260928T163600Z`;
    assert.match(refused.error.message, new RegExp(backupPath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.deepEqual(readFileSync(backupPath), editedBytes,
      "the named backup also preserves the concurrent edit exactly");

    const control = fixture();
    const controlLaunch = launchctlHarness();
    const written = await cmdFolder(control.manifestPath, ["off"], folderOptions(control, controlLaunch, {
      platform: "linux",
    }));
    assert.equal(written.changed, true);
    assert.equal(JSON.parse(readFileSync(control.manifestPath, "utf8")).corpora.local_folder.enabled, false,
      "the no-edit control reaches and completes the manifest replacement");
  }

  {
    const f = fixture();
    writeFileSync(join(f.watched, ".placeholder.icloud"), "fixture");
    writeFileSync(join(f.watched, "zero.txt"), "");
    let nestedReads = 0;
    const identity = retiredIdentityOfPath(f.watched, {
      fs: {
        lstatSync(path) { assert.equal(path, f.watched); return lstatSync(path); },
        realpathNative(path) { assert.equal(path, f.watched); return realpathSync.native(path); },
        statSync(path, options) { assert.equal(path, realpathSync.native(f.watched)); return statSync(path, options); },
        readFileSync() { nestedReads++; throw new Error("folder contents must not be opened"); },
      },
    });
    assert.equal(nestedReads, 0);
    assert.equal(identity.realpath, realpathSync.native(f.watched));
  }

  {
    for (const mode of [0o600, 0o644]) {
      const f = fixture({ mode });
      const intended = structuredClone(f.manifest);
      intended.marker = mode;
      const result = writeManifestAtomically(f.manifestPath, intended, { now: () => new Date(FIXED_NOW) });
      assert.equal(lstatSync(f.manifestPath).mode & 0o777, mode);
      assert.equal(lstatSync(result.backupPath).mode & 0o777, mode);
      assert.deepEqual(JSON.parse(readFileSync(f.manifestPath, "utf8")), intended);
    }

    const failure = fixture();
    const before = readFileSync(failure.manifestPath);
    assert.throws(() => writeManifestAtomically(failure.manifestPath, { changed: true }, {
      now: () => new Date(FIXED_NOW),
      beforeRename: () => { throw new Error("injected before rename"); },
    }), /injected before rename/);
    assert.deepEqual(readFileSync(failure.manifestPath), before);
    assert.equal(readdirSync(dirname(failure.manifestPath)).some((name) => name.endsWith(".tmp")), false);

    const writeFailure = fixture();
    const writeFailureBefore = readFileSync(writeFailure.manifestPath);
    assert.throws(() => writeManifestAtomically(writeFailure.manifestPath, { changed: true }, {
      now: () => new Date(FIXED_NOW),
      fs: { writeSync: () => { throw new Error("injected write failure"); } },
    }), /injected write failure/);
    assert.deepEqual(readFileSync(writeFailure.manifestPath), writeFailureBefore);
    assert.equal(
      readdirSync(dirname(writeFailure.manifestPath)).some((name) => name.includes("folder-off")),
      false,
      "a failed exclusive write leaves neither a temporary file nor a partial backup",
    );

    const postRenameFailure = fixture({ mode: 0o640 });
    const postRenameBytes = readFileSync(postRenameFailure.manifestPath);
    const postRenameMode = lstatSync(postRenameFailure.manifestPath).mode & 0o777;
    let postRenameDirectorySyncs = 0;
    assert.throws(() => writeManifestAtomically(postRenameFailure.manifestPath, { changed: true }, {
      now: () => new Date(FIXED_NOW),
      syncDirectory: () => {
        postRenameDirectorySyncs += 1;
        if (postRenameDirectorySyncs === 1) throw new Error("injected directory fsync failure after rename");
      },
    }), /injected directory fsync failure after rename/);
    assert.equal(
      postRenameDirectorySyncs,
      2,
      "the first call reaches the post-rename failpoint and the second reaches restoration durability",
    );
    assert.deepEqual(readFileSync(postRenameFailure.manifestPath), postRenameBytes);
    assert.equal(lstatSync(postRenameFailure.manifestPath).mode & 0o777, postRenameMode);
    const postRenameNames = readdirSync(dirname(postRenameFailure.manifestPath));
    assert.equal(
      postRenameNames.some((name) => name.includes(".folder-off-")),
      false,
      "post-rename restoration leaves neither temporary nor rollback residue",
    );
    assert.equal(
      postRenameNames.some((name) => name.includes(".before-folder-off-")),
      false,
      "the backup from the failed replacement is removed",
    );

    const restoreFailure = fixture({ mode: 0o640 });
    const restoreFailureBytes = readFileSync(restoreFailure.manifestPath);
    const restoreFailureBackup = `${restoreFailure.manifestPath}.before-folder-off-20260928T163600Z`;
    let restoreFailureRenames = 0;
    let restoreFailureDirectorySyncs = 0;
    let restoreError = null;
    try {
      writeManifestAtomically(
        restoreFailure.manifestPath,
        { changed: true },
        {
          now: () => new Date(FIXED_NOW),
          fs: {
            renameSync(from, to) {
              restoreFailureRenames += 1;
              if (restoreFailureRenames === 2) throw new Error("injected restoration rename failure");
              return renameSync(from, to);
            },
          },
          syncDirectory: () => {
            restoreFailureDirectorySyncs += 1;
            if (restoreFailureDirectorySyncs === 1) {
              throw new Error("injected post-replacement durability failure");
            }
          },
        },
      );
      assert.fail("the injected restoration failure must escape");
    } catch (error) {
      restoreError = error;
    }
    assert.equal(restoreFailureRenames, 2,
      `the failure reaches the restoration rename rather than stopping before rollback: ${restoreError.message}`);
    assert.match(restoreError.message, /injected restoration rename failure/);
    assert.match(restoreError.message, new RegExp(restoreFailureBackup.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.equal(existsSync(restoreFailureBackup), true,
      "a failed restoration keeps the verified backup");
    assert.deepEqual(readFileSync(restoreFailureBackup), restoreFailureBytes);

    const beforeSwapRace = fixture({ mode: 0o640 });
    const beforeSwapOriginal = readFileSync(beforeSwapRace.manifestPath);
    const beforeSwapEdited = Buffer.from(manifestBytes({
      ...beforeSwapRace.manifest,
      concurrent_owner_edit: "preserve the just-in-time edit",
    }));
    let beforeSwapHooks = 0;
    let beforeSwapError = null;
    try {
      writeManifestAtomically(beforeSwapRace.manifestPath, { changed: true }, {
        now: () => new Date(FIXED_NOW),
        expectedOriginalBytes: beforeSwapOriginal,
        beforeRename: () => {
          beforeSwapHooks += 1;
          writeFileSync(beforeSwapRace.manifestPath, beforeSwapEdited, { mode: beforeSwapRace.mode });
        },
      });
      assert.fail("the just-in-time concurrent edit must stop the swap");
    } catch (error) {
      beforeSwapError = error;
    }
    const beforeSwapBackup = `${beforeSwapRace.manifestPath}.before-folder-off-20260928T163600Z`;
    assert.equal(beforeSwapHooks, 1,
      "the race arm reaches the final pre-swap recheck exactly once");
    assert.match(beforeSwapError.message, /manifest changed/i);
    assert.match(beforeSwapError.message,
      new RegExp(beforeSwapBackup.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.deepEqual(readFileSync(beforeSwapRace.manifestPath), beforeSwapEdited,
      "the edit made immediately before the swap remains live");
    assert.deepEqual(readFileSync(beforeSwapBackup), beforeSwapOriginal,
      "the pre-swap backup keeps the bytes that the operation originally inspected");

    const postRenameControl = fixture({ mode: 0o640 });
    const controlIntended = { ...postRenameControl.manifest, post_rename_control: true };
    let controlDirectorySyncs = 0;
    writeManifestAtomically(postRenameControl.manifestPath, controlIntended, {
      now: () => new Date(FIXED_NOW),
      syncDirectory: () => { controlDirectorySyncs += 1; },
    });
    assert.equal(controlDirectorySyncs, 1, "the successful control reaches the directory fsync once");
    assert.deepEqual(readFileSync(postRenameControl.manifestPath), Buffer.from(manifestBytes(controlIntended)));
    assert.equal(lstatSync(postRenameControl.manifestPath).mode & 0o777, 0o640);

    const win = fixture();
    let directorySyncs = 0;
    writeManifestAtomically(win.manifestPath, { ...win.manifest, win: true }, {
      now: () => new Date(FIXED_NOW),
      platform: "win32",
      syncDirectory: () => { directorySyncs++; },
    });
    assert.equal(directorySyncs, 0, "win32 skips only the directory fsync");
  }

  {
    const original = fixture();
    const linkPath = join(original.base, "symlink-manifest.json");
    let symlinkCreated = false;
    try {
      symlinkSync(original.manifestPath, linkPath);
      symlinkCreated = true;
    } catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error?.code)) throw error;
      console.log("folder off: SKIP manifest symlink refusal, Windows runner denied file-symlink creation");
    }
    if (symlinkCreated) {
      assert.throws(() => writeManifestAtomically(linkPath, { changed: true }), /symbolic link/i);
      assert.equal(readFileSync(original.manifestPath, "utf8"), original.original);
    }

    const hard = fixture();
    const alias = join(hard.base, "hardlink-manifest.json");
    linkSync(hard.manifestPath, alias);
    assert.throws(() => writeManifestAtomically(hard.manifestPath, { changed: true }), /multiple filesystem links/i);
    assert.equal(readFileSync(hard.manifestPath, "utf8"), hard.original);
  }

  {
    const f = fixture();
    const launch = launchctlHarness({ loaded: true, running: true });
    const before = readFileSync(f.manifestPath);
    const refused = await capture(() => cmdFolder(f.manifestPath, ["off"], folderOptions(f, launch)));
    assert.match(refused.error?.message || "", /A folder read is running now/);
    assert.equal(supportErrorCode(refused.error, { command: "folder" }), "INPUT_REFUSED");
    assert.deepEqual(readFileSync(f.manifestPath), before);
    assert.equal(launch.calls.some((args) => args[0] === "bootout"), false);

    launch.setRunning(false);
    const control = await capture(() => cmdFolder(f.manifestPath, ["off"], folderOptions(f, launch)));
    assert.ifError(control.error);
    assert.equal(JSON.parse(readFileSync(f.manifestPath, "utf8")).corpora.local_folder.enabled, false);
  }

  {
    const f = fixture();
    const launch = launchctlHarness();
    const lease = acquireSourceIngestLock({
      manifestPath: f.manifestPath,
      sourceName: "documents",
      home: f.home,
      platform: process.platform,
    });
    try {
      const before = readFileSync(f.manifestPath);
      const refused = await capture(() => cmdFolder(f.manifestPath, ["off"], folderOptions(f, launch)));
      assert.match(refused.error?.message || "", /A folder read is running now/);
      assert.deepEqual(readFileSync(f.manifestPath), before);
    } finally {
      lease.release();
    }
    const control = await cmdFolder(f.manifestPath, ["off"], folderOptions(f, launch));
    assert.ok(control.backupPath, "the unlocked control reaches the manifest decision point");
  }

  {
    const f = fixture();
    const launch = launchctlHarness();
    const result = await cmdFolder(f.manifestPath, ["off"], folderOptions(f, launch, {
      schedulerOptions: schedulerOptions(f, launch.launchctl, { probeSchedulerLock: () => true }),
    })).then(() => null, (error) => error);
    assert.match(result?.message || "", /A folder read is running now/);
    assert.equal(JSON.parse(readFileSync(f.manifestPath, "utf8")).corpora.local_folder.enabled, true);
  }

  {
    const f = fixture();
    const launch = launchctlHarness();
    let schedulerCalls = 0;
    const result = await cmdFolder(f.manifestPath, ["off"], folderOptions(f, launch, {
      platform: "win32",
      schedulerOptions: {
        ...schedulerOptions(f, launch.launchctl),
        platform: "win32",
        launchctl: () => { schedulerCalls++; throw new Error("must not call launchctl"); },
      },
    }));
    assert.equal(schedulerCalls, 0);
    assert.equal(JSON.parse(readFileSync(f.manifestPath, "utf8")).corpora.local_folder.enabled, false);
    assert.equal(result.schedulerSkipped, true);
  }

  {
    const f = fixture();
    const launch = launchctlHarness();
    const options = schedulerOptions(f, launch.launchctl);
    const driveBefore = buildDrivePlan(f.manifestPath, options).configHash;
    const imessageBefore = buildImessageSchedulerPlan(f.manifestPath, options).configHash;
    await cmdFolder(f.manifestPath, ["off"], folderOptions(f, launch));
    assert.equal(buildDrivePlan(f.manifestPath, options).configHash, driveBefore);
    assert.equal(buildImessageSchedulerPlan(f.manifestPath, options).configHash, imessageBefore);
  }

  {
    const f = fixture();
    const launch = launchctlHarness();
    const oldBackup = join(dirname(f.manifestPath), "brain.manifest.json.before-folder-off-20260920T000000Z");
    writeFileSync(oldBackup, f.original);
    await cmdFolder(f.manifestPath, ["off"], folderOptions(f, launch));
    const shownUndo = renderCliCommands(`brain schedule ${f.manifestPath} --install --folder`);
    const status = await capture(() => cmdFolder(f.manifestPath, ["status"], folderOptions(f, launch)));
    assert.ifError(status.error);
    assert.match(status.text, /retired on 2026-09-28T16:36:00\.000Z/);
    assert.match(status.text, new RegExp(basename(status.result.backupPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(status.text.includes(shownUndo));
    const scheduler = statusFolderScheduler(f.manifestPath, schedulerOptions(f, launch.launchctl));
    assert.equal(scheduler.loaded, false);
  }

  console.log("folder off: PASS");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
