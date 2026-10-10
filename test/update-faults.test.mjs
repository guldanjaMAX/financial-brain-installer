import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createFaultFixture, runFaultUpgrade } from "./update-faults-fixture.mjs";
import { saveUpgradeBookmark, secureWindowsUpgradeBookmarkPath } from "../operations/upgrade-bookmark.mjs";

function fixture(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "update-faults-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return createFaultFixture(root);
}

test("UF-01: a lost paused-upload reply never claims normal operation", async (t) => {
  const f = fixture(t);
  const result = await runFaultUpgrade(f, { fault: "paused-reply" });
  assert.ok(result.events.includes("deploy:paused:applied"), "the pause really took effect before the lost reply");
  assert.ok(result.error);
  assert.equal(result.events.includes("migration"), false);
  assert.doesNotMatch(result.error.message, /working normally/i);
  assert.match(result.error.message, /may.*(?:paused|documents)|paused.*may/i);
});

test("UF-02: orphan ALTER intent cannot be described as observed progress", async (t) => {
  const f = fixture(t);
  const crashed = await runFaultUpgrade(f, { fault: "orphan-intent" });
  assert.ok(crashed.events.includes("intent:persisted"));
  assert.equal(crashed.events.includes("alter:dispatched"), false);
  const retry = await runFaultUpgrade(f);
  assert.ok(retry.events.includes("intent:reopened"));
  assert.ok(retry.events.filter((event) => event === "column:absent").length >= 3);
  assert.equal(retry.events.includes("alter:dispatched"), false);
  assert.equal(retry.error?.supportCode, "MIGRATION_STILL_APPLYING");
  assert.doesNotMatch([retry.error.message, ...retry.lines].join("\n"), /still applying|still working|wait about 10 minutes/i);
  assert.match(retry.error.message, /unconfirmed|cannot confirm/i);
  assert.match(retry.error.message, /installer.*review|review.*installer/i);
});

test("untouched control completes the update and verifies the column and versions", async (t) => {
  const f = fixture(t);
  const result = await runFaultUpgrade(f);
  assert.equal(result.error, null);
  assert.ok(result.events.includes("alter:dispatched"));
  assert.ok(result.events.includes("column:present"));
  assert.ok(result.events.includes("health:active"));
  assert.equal(result.version, f.targetVersion);
  assert.equal(JSON.parse(readFileSync(f.manifestPath, "utf8")).brain.version, f.targetVersion);
  assert.equal(result.history.at(-1).status, "verified");
});

test("R152-01: a same-directory case spelling of HOME completes the update and retry", async (t) => {
  const f = fixture(t);
  const canonical = join(f.root, "CaseHome");
  fs.mkdirSync(canonical, { mode: 0o700 });
  const alias = join(dirname(canonical), basename(canonical).toLowerCase());
  if (!existsSync(alias)) return t.skip("requires a case-insensitive filesystem");
  assert.equal(fs.statSync(alias).ino, fs.statSync(canonical).ino);
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), false);
  const oldHome = process.env.HOME;
  const oldProfile = process.env.USERPROFILE;
  const results = [];
  try {
    for (const home of [alias, alias, canonical]) {
      process.env.HOME = process.env.USERPROFILE = home;
      results.push(await runFaultUpgrade(f, { bookmarkOptions: { directory: undefined } }));
    }
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
  }
  assert.equal(results[2].error, null, "canonical spelling is the green control");
  for (const result of results) {
    assert.ok(result.events.includes("bookmark:captured"), "the persistence decision was reached");
    assert.equal(result.error, null);
    assert.ok(result.events.includes("health:active"));
    assert.equal(result.history.at(-1).status, "verified");
  }
  assert.equal(readdirSync(join(canonical, ".brain", "upgrade-bookmarks")).length, 3);
});

const receipt = {
  account_id: "fixture-account", database_id: "fixture-db", bookmark: "fixture-before-update",
  from_version: "0.4.1", to_version: "0.4.11", manifest_sha256: "0".repeat(64),
};

test("R152-02: Windows establishes private ACLs before bytes and verifies them at readback", (t) => {
  const f = fixture(t);
  const directory = join(f.root, "public-bookmarks");
  fs.mkdirSync(directory, { mode: 0o755 });
  const secured = new Set();
  const calls = [];
  let writes = 0, privateAtWrite = false;
  const io = { ...fs, writeFileSync(fd, bytes) {
    writes++;
    privateAtWrite = secured.has(directory) && secured.size === 2;
    return fs.writeFileSync(fd, bytes);
  } };
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  let path;
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    path = saveUpgradeBookmark(receipt, {
      directory, io, now: () => new Date("2026-10-10T12:00:00.000Z"),
      windowsAcl(target, options) {
        calls.push(`${options.verifyOnly ? "verify" : "protect"}:${options.directory ? "directory" : "file"}`);
        if (options.verifyOnly) assert.ok(secured.has(target)); else secured.add(target);
      },
    });
  } finally { Object.defineProperty(process, "platform", originalPlatform); }
  assert.equal(writes, 1, "the identifying-byte write was reached");
  assert.equal(JSON.parse(readFileSync(path)).bookmark, receipt.bookmark, "exact receipt control");
  assert.equal(privateAtWrite, true, "inherited access must be removed before identifying bytes are written");
  assert.deepEqual(calls, ["protect:directory", "protect:file", "verify:file", "verify:directory"]);
});

test("R152-01: actual ancestor links are refused before creating receipt descendants", async (t) => {
  const f = fixture(t);
  const link = join(f.root, "linked-home");
  fs.symlinkSync(f.root, link, process.platform === "win32" ? "junction" : "dir");
  let linkChecks = 0;
  const io = { ...fs, lstatSync(path) {
    if (path === link) linkChecks++;
    return fs.lstatSync(path);
  } };
  const result = await runFaultUpgrade(f, { bookmarkOptions: { directory: join(link, "absent", "bookmarks"), io } });
  assert.equal(linkChecks, 1, "the linked ancestor was inspected");
  assert.deepEqual(result.events, ["bookmark:captured"]);
  assert.match(result.error?.message || "", /bookmark could not be saved and verified/);
  assert.equal(existsSync(join(f.root, "absent")), false);
  assert.equal((await runFaultUpgrade(f)).error, null, "real-directory control succeeds");
});

for (const failure of ["protect:directory", "protect:file", "verify:file", "verify:directory"]) {
  test(`R152-02: ${failure} refusal stops the update at the reached ACL gate`, async (t) => {
    const f = fixture(t);
    let reached = 0, writes = 0;
    const io = { ...fs, writeFileSync(...args) { writes++; return fs.writeFileSync(...args); } };
    const result = await runFaultUpgrade(f, { bookmarkOptions: {
      platform: "win32", io,
      windowsAcl(_path, options) {
        if (`${options.verifyOnly ? "verify" : "protect"}:${options.directory ? "directory" : "file"}` === failure) {
          reached++;
          throw new Error("fixture unverified ACL");
        }
      },
    } });
    assert.equal(reached, 1);
    assert.equal(writes, failure.startsWith("protect:") ? 0 : 1);
    assert.deepEqual(result.events, ["bookmark:captured"]);
    assert.equal(result.history.length, 0);
    assert.match(result.error?.message || "", /bookmark could not be saved and verified/);
    assert.equal((await runFaultUpgrade(f)).error, null, "private storage control succeeds");
  });
}

test("R152-02: Windows native ACL boundary requires proof and uses an allowlisted environment", () => {
  let calls = 0;
  for (const status of [1, 0]) {
    const invoke = () => secureWindowsUpgradeBookmarkPath("C:\\fixture\\receipt.json", {
      environment: { SystemRoot: "C:\\Windows", PRIVATE_FIXTURE_VALUE: "excluded" },
      run(command, args, options) {
        calls++;
        assert.equal(command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
        assert.equal(options.env.PRIVATE_FIXTURE_VALUE, undefined);
        assert.equal(options.shell, false);
        assert.equal(args.includes("-NonInteractive"), true);
        assert.deepEqual(JSON.parse(options.input), { path: "C:\\fixture\\receipt.json", directory: false, verifyOnly: false });
        const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
        assert.match(script, /SetAccessRuleProtection\(\$true, \$false\)/);
        assert.match(script, /GetAccessRules/);
        return { status, stdout: Buffer.from(status ? "" : "private"), stderr: Buffer.alloc(0) };
      },
    });
    if (status) assert.throws(invoke, /could not be protected and verified/); else invoke();
  }
  assert.equal(calls, 2, "both denied and verified ACL boundaries ran");
});

test("R152-03: non-UTF-8 Windows stdin preserves ASCII and Unicode receipt paths", async (t) => {
  for (const folder of ["ascii-home", "caf\u00e9-\u4e2d-\ud83d\udcc1"]) {
    const f = fixture(t);
    let calls = 0, lookups = 0, writes = 0;
    const result = await runFaultUpgrade(f, { bookmarkOptions: {
      directory: join(f.root, folder, "bookmarks"), platform: "win32",
      io: { ...fs, writeFileSync(...args) { writes++; return fs.writeFileSync(...args); } },
      windowsAcl(path, options) {
        secureWindowsUpgradeBookmarkPath(path, { ...options, environment: { SystemRoot: "C:\\Windows" },
          run(_command, _args, options) {
            calls++;
            // A non-UTF-8 console decodes high bytes differently. ASCII JSON
            // escapes retain the exact path under either console code page.
            const request = JSON.parse(Buffer.from(options.input, "utf8").toString("latin1"));
            lookups++;
            const found = fs.existsSync(request.path);
            return { status: found ? 0 : 1, stdout: Buffer.from(found ? "private" : ""), stderr: Buffer.alloc(0) };
          },
        });
      },
    } });
    assert.ok(calls > 0 && lookups > 0, "console decoding and filesystem lookup reached");
    assert.equal(result.error, null);
    assert.equal(calls, 4);
    assert.equal(writes, 1);
    assert.ok(result.events.includes("health:active"));
    assert.equal(result.history.at(-1).status, "verified");
  }
});

test("R152-02: replacing the receipt inode before readback is refused", async (t) => {
  const f = fixture(t);
  let swap = 0;
  const io = { ...fs, openSync(path, flags, mode) {
    if (typeof flags === "number" && path.endsWith(".json")) {
      const bytes = readFileSync(path);
      fs.renameSync(path, `${path}.original`);
      fs.writeFileSync(path, bytes, { mode: 0o600 });
      swap++;
    }
    return fs.openSync(path, flags, mode);
  } };
  const result = await runFaultUpgrade(f, { bookmarkOptions: { io } });
  assert.equal(swap, 1);
  assert.deepEqual(result.events, ["bookmark:captured"]);
  assert.match(result.error?.message || "", /bookmark could not be saved and verified/);
  assert.equal((await runFaultUpgrade(f)).error, null);
});

for (const fault of ["write", "file-flush", "directory-flush", "readback"]) {
  test(`UF-03: bookmark ${fault} failure stops before remote mutation`, async (t) => {
    const f = fixture(t);
    let reached = 0;
    const io = {
      ...fs,
      writeFileSync(...args) {
        if (fault === "write") { reached++; throw new Error("fixture ENOSPC"); }
        return fs.writeFileSync(...args);
      },
      fsyncSync(fd) {
        const directory = fs.fstatSync(fd).isDirectory();
        if ((fault === "file-flush" && !directory) || (fault === "directory-flush" && directory)) {
          reached++; throw new Error("fixture flush failed");
        }
        return fs.fsyncSync(fd);
      },
      readFileSync(...args) {
        if (fault === "readback") { reached++; return "{}\n"; }
        return fs.readFileSync(...args);
      },
    };
    // Windows has no directory-fsync primitive; refusal is proved at the
    // directory metadata read there, without claiming a Windows fsync occurred.
    if (fault === "directory-flush" && process.platform === "win32") io.lstatSync = () => {
      reached++; throw new Error("fixture directory read failed");
    };
    const result = await runFaultUpgrade(f, { bookmarkOptions: { io } });
    assert.equal(reached, 1, "the injected persistence decision was reached");
    assert.deepEqual(result.events, ["bookmark:captured"]);
    assert.match(result.error?.message || "", /bookmark could not be saved and verified/);
    assert.equal(result.history.length, 0);
    assert.equal(result.version, "0.4.1");
  });
}

test("UF-03: retries retain each attempt's independently readable bookmark", async (t) => {
  const f = fixture(t);
  const first = await runFaultUpgrade(f, { fault: "paused-reply" });
  assert.ok(first.events.includes("deploy:paused:applied"));
  const directory = join(f.root, "bookmarks");
  const [originalName] = readdirSync(directory);
  const original = readFileSync(join(directory, originalName), "utf8");
  const retry = await runFaultUpgrade(f);
  assert.equal(retry.error, null);
  assert.equal(readdirSync(directory).length, 2);
  assert.equal(readFileSync(join(directory, originalName), "utf8"), original);
});

test("UF-03: legacy databases without upgrade history still save the pre-change bookmark", async (t) => {
  const f = fixture(t);
  const db = new DatabaseSync(f.databasePath);
  db.exec("DROP TABLE install_state; DROP TABLE upgrade_runs");
  db.close();
  const result = await runFaultUpgrade(f, { fault: "paused-reply" });
  assert.ok(result.events.includes("deploy:paused:applied"));
  assert.match(result.error?.message || "", /pause upload did not return a confirmed result/i);
  assert.equal(result.history.length, 0);
  const directory = join(f.root, "bookmarks");
  const [name] = readdirSync(directory);
  const receipt = JSON.parse(readFileSync(join(directory, name), "utf8"));
  assert.equal(receipt.bookmark, "fixture-before-update");
  assert.equal(receipt.from_version, "0.4.1");
});

test("UF-03: SIGKILL after paused upload leaves the current pre-change bookmark durable", async (t) => {
  const f = fixture(t);
  if (process.env.BRAIN_TEST_QUIET_MARKER) assert.equal(existsSync(process.env.BRAIN_TEST_QUIET_MARKER), false,
    "quiet marker must be absent before starting Node");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./update-faults-child.mjs", import.meta.url)), f.root], {
    env: { HOME: f.root, USERPROFILE: f.root, TMPDIR: f.root, BRAIN_NO_WRANGLER_LOGIN: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  const exit = once(child, "exit");
  const marker = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child did not reach paused-upload marker")), 15_000);
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
      if (output.includes("PAUSE_APPLIED\n")) { clearTimeout(timer); resolve(true); }
    });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(`child exited before marker: ${stderr}`)); });
  });
  assert.equal(marker, true);
  child.kill("SIGKILL");
  const [code, signal] = await exit;
  assert.equal(code, null);
  assert.equal(signal, "SIGKILL");
  const directory = join(f.root, "bookmarks");
  assert.equal(existsSync(directory), true, "bookmark must be durable before deployment, without a catch or finally");
  const records = readdirSync(directory).map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")));
  assert.equal(records.length, 1);
  assert.equal(records[0].bookmark, "fixture-before-update");
  assert.equal(records[0].account_id, "fixture-account");
  assert.equal(records[0].database_id, "fixture-db");
  assert.equal(records[0].from_version, "0.4.1");
  assert.equal(records[0].to_version, f.targetVersion);
  assert.equal(records[0].manifest_sha256, createHash("sha256").update(readFileSync(f.manifestPath)).digest("hex"));
  assert.equal(records[0].captured_at, "2026-10-10T12:00:00.000Z");
});
