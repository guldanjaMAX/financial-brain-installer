import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createFaultFixture, runFaultUpgrade } from "./update-faults-fixture.mjs";

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
