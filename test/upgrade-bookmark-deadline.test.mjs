import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { saveUpgradeBookmarkBounded, UPGRADE_BOOKMARK_TIMEOUT_MS } from "../operations/upgrade-bookmark-process.mjs";
import { installNativeTestWatchdog } from "./fixtures/native-test-watchdog.mjs";

installNativeTestWatchdog("bookmark deadline", 600_000);
const record = {
  account_id: "fixture-account", database_id: "fixture-db", bookmark: "fixture-before-update",
  from_version: "0.4.1", to_version: "0.4.11", manifest_sha256: "0".repeat(64),
};
const now = () => new Date("2026-10-10T12:00:00.000Z");
const rootFor = t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "receipt-deadline-")));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return root;
};

test("bounded writer preserves exact durable readback through its real child", async t => {
  const directory = join(rootFor(t), "bookmarks");
  let reached = 0;
  const path = await saveUpgradeBookmarkBounded(record, { directory, now,
    environment: { ...process.env, PRIVATE_FIXTURE_VALUE: "must not inherit", NODE_OPTIONS: "must not inherit" },
    run(command, args, options) {
      reached++;
      assert.equal(command, process.execPath);
      assert.equal(args.length, 1);
      assert.equal(options.env.PRIVATE_FIXTURE_VALUE, undefined);
      assert.equal(options.env.NODE_OPTIONS, undefined);
      return spawn(command, args, options);
    },
  });
  assert.equal(reached, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path)), { schema_version: 1, captured_at: now().toISOString(), ...record });
});

for (const step of ["acl", "open", "file-flush", "directory-flush", "readback"]) {
  test(`bounded writer kills a blocked ${step} without waiting for its event loop`, {
    skip: step === "directory-flush" && process.platform === "win32" ? "Windows has no directory fsync primitive" : false,
  }, async t => {
    const root = rootFor(t);
    let reached = false, child, exited;
    await assert.rejects(saveUpgradeBookmarkBounded(record, {
      directory: join(root, "bookmarks"), now, timeoutMs: 2_000,
      run(command, _args, options) {
        child = spawn(command, [fileURLToPath(new URL("./fixtures/upgrade-bookmark-hang-child.mjs", import.meta.url)), step], options);
        // AbortSignal.timeout is unreferenced on Node 22. Keep a real bounded
        // observer alive after the production supervisor detaches the child.
        let exitTimer;
        exited = Promise.race([
          once(child, "exit"),
          new Promise((_resolve, reject) => { exitTimer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`NATIVE_TEST_TIMEOUT: ${step} child exit`));
          }, 5_000); }),
        ]).finally(() => clearTimeout(exitTimer));
        exited.catch(() => {});
        child.stdout.on("data", chunk => { if (String(chunk).includes("REACHED")) reached = true; });
        t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
        return child;
      },
    }), { code: "UPGRADE_BOOKMARK_TIMEOUT" });
    assert.equal(reached, true, "the named native decision was entered");
    const [code, signal] = await exited;
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");
    // Native Windows directory flush is not supported, so the synthetic Linux
    // arm above proves the supervisor there. The control uses the real host.
    const path = await saveUpgradeBookmarkBounded(record, { directory: join(root, "control"), now });
    assert.equal(JSON.parse(fs.readFileSync(path)).bookmark, record.bookmark);
  });
}

test("Windows deadline requests bounded tree termination even if no exit arrives", async () => {
  let reached = 0, trees = 0, killed = 0;
  const result = saveUpgradeBookmarkBounded(record, {
    directory: "C:\\fixture\\bookmarks", now, platform: "win32", timeoutMs: 10,
    environment: { SystemRoot: "C:\\Windows" },
    run(command, args, options) {
      const child = new EventEmitter();
      child.unref = () => {};
      child.kill = signal => { assert.equal(signal, "SIGKILL"); killed++; };
      if (command.endsWith("taskkill.exe")) {
        trees++;
        assert.deepEqual(args, ["/PID", "42", "/T", "/F"]);
        assert.equal(options.timeout, 5_000);
        assert.equal(options.killSignal, "SIGKILL");
        queueMicrotask(() => child.emit("close", 0));
      } else {
        reached++;
        child.pid = 42;
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
      }
      return child;
    },
  });
  await assert.rejects(result, { code: "UPGRADE_BOOKMARK_TIMEOUT" });
  assert.equal(reached, 1);
  assert.equal(trees, 1);
  assert.equal(killed, 1, "root termination follows the tree operation");
});

test("invalid deadlines refuse before any process starts", () => {
  for (const timeoutMs of [0, -1, Infinity, UPGRADE_BOOKMARK_TIMEOUT_MS + 1]) {
    let calls = 0;
    assert.throws(() => saveUpgradeBookmarkBounded(record, { timeoutMs, run() { calls++; } }), { code: "UPGRADE_BOOKMARK_FAILED" });
    assert.equal(calls, 0);
  }
  assert.equal(UPGRADE_BOOKMARK_TIMEOUT_MS, 540_000, "finite production budget is the accepted control");
});

test("independent test watchdog names the blocked step and kills only its own process", async () => {
  const helper = new URL("./fixtures/native-test-watchdog.mjs", import.meta.url).href;
  for (const blocked of [true, false]) {
    const source = `import { installNativeTestWatchdog } from ${JSON.stringify(helper)};
      const step = installNativeTestWatchdog('fixture suite', 500);
      step('fixture file flush');
      ${blocked ? "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);" : "process.exit(0);"}`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      env: { HOME: process.env.HOME, BRAIN_NO_WRANGLER_LOGIN: "1" }, stdio: ["ignore", "ignore", "pipe"],
    });
    let diagnostic = "";
    child.stderr.on("data", data => { diagnostic += data; });
    const result = await once(child, "close", { signal: AbortSignal.timeout(5_000) })
      .catch(error => { child.kill("SIGKILL"); throw error; });
    if (blocked) {
      assert.deepEqual(result, [null, "SIGKILL"]);
      assert.match(diagnostic, /NATIVE_TEST_TIMEOUT: fixture suite: fixture file flush/);
    } else assert.deepEqual(result, [0, null], "completed fixture remains the green control");
  }
});

test("bookmark deadline: default update awaits the real isolated durable writer", async t => {
  const { createFaultFixture, runFaultUpgrade } = await import("./update-faults-fixture.mjs");
  const f = createFaultFixture(rootFor(t));
  let reached = 0;
  const result = await runFaultUpgrade(f, {
    saveUpgradeBookmark: null,
    afterPause() {
      reached++;
      const directory = join(f.root, "bookmarks");
      const names = fs.readdirSync(directory);
      assert.equal(names.length, 1, "receipt precedes the first deployment");
      assert.equal(JSON.parse(fs.readFileSync(join(directory, names[0]))).bookmark, "fixture-before-update");
    },
  });
  assert.equal(result.error, null);
  assert.equal(reached, 1);
  assert.equal(result.history.at(-1).status, "verified");
});
