import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveUpgradeBookmark, secureMacUpgradeBookmarkPath } from "../operations/upgrade-bookmark.mjs";

const native = { skip: process.platform !== "darwin" ? "requires native macOS ACLs" : false };
const record = {
  account_id: "fixture-account", database_id: "fixture-db", bookmark: "fixture-before-update",
  from_version: "0.4.1", to_version: "0.4.11", manifest_sha256: "0".repeat(64),
};
const now = () => new Date("2026-10-10T12:00:00.000Z");
function run(command, args) {
  const result = spawnSync(command, args, { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, encoding: "utf8" });
  assert.equal(result.status, 0, "native synthetic ACL operation completed");
  return result.stdout;
}
function grants(path) { return run("/bin/ls", ["-lde", path]).split("\n").filter((line) => /^\s+\d+:/.test(line)); }
function rootFor(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "receipt-acl-")));
  t.after(() => { run("/bin/chmod", ["-N", root]); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
function broaden(path, rights) { run("/bin/chmod", ["+a", `everyone allow ${rights}`, path]); }
const readInheritance = "read,execute,readattr,readextattr,readsecurity,file_inherit,directory_inherit";

test("R152-04 native macOS: inherited read access is removed before receipt bytes", native, (t) => {
  const root = rootFor(t);
  const control = saveUpgradeBookmark(record, { directory: join(root, "control"), now });
  assert.equal(JSON.parse(fs.readFileSync(control)).bookmark, record.bookmark);
  const parent = join(root, "broad-parent");
  fs.mkdirSync(parent, { mode: 0o700 });
  broaden(parent, readInheritance);
  assert.ok(grants(parent).some((line) => / allow/.test(line)), "broad ancestor grant is real");
  const directory = join(parent, "bookmarks");
  fs.mkdirSync(directory, { mode: 0o700 });
  assert.ok(grants(directory).some((line) => /inherited allow/.test(line)), "inheritance reached the receipt directory");
  let writes = 0, privateAtWrite = false;
  const path = saveUpgradeBookmark(record, { directory, now, io: { ...fs, writeFileSync(fd, bytes) {
    writes++;
    const [name] = fs.readdirSync(directory);
    privateAtWrite = grants(directory).length === 0 && grants(join(directory, name)).length === 0;
    return fs.writeFileSync(fd, bytes);
  } } });
  assert.equal(writes, 1, "identifying-byte decision reached");
  assert.equal(privateAtWrite, true, "no ACL grant can accompany the first receipt byte");
  assert.equal(grants(path).length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path)).bookmark, record.bookmark);
  assert.ok(grants(parent).length > 0, "ancestor ACL is never rewritten");
});

test("R152-04 native macOS: ancestor write ACL refuses before descendant creation", native, (t) => {
  const root = rootFor(t);
  assert.ok(saveUpgradeBookmark(record, { directory: join(root, "control"), now }));
  const parent = join(root, "writable-parent");
  fs.mkdirSync(parent, { mode: 0o700 });
  broaden(parent, "add_file,add_subdirectory,delete_child");
  assert.ok(grants(parent).some((line) => /add_file/.test(line)));
  let checks = 0, writes = 0;
  const directory = join(parent, "absent", "bookmarks");
  assert.throws(() => saveUpgradeBookmark(record, { directory, now, io: { ...fs,
    lstatSync(path) { if (path === parent) checks++; return fs.lstatSync(path); },
    writeFileSync(...args) { writes++; return fs.writeFileSync(...args); },
  } }), /ACL|ancestor/);
  assert.ok(checks > 0, "unsafe ancestor decision reached");
  assert.equal(writes, 0);
  assert.equal(fs.existsSync(join(parent, "absent")), false);
});

for (const target of ["file", "directory"]) {
  test(`R152-04 native macOS: ${target} grant added during readback refuses`, native, (t) => {
    const root = rootFor(t);
    assert.ok(saveUpgradeBookmark(record, { directory: join(root, "control"), now }));
    const directory = join(root, "bookmarks");
    let reads = 0;
    assert.throws(() => saveUpgradeBookmark(record, { directory, now, io: { ...fs, readFileSync(fd) {
      reads++;
      const bytes = fs.readFileSync(fd);
      const path = target === "directory" ? directory : join(directory, fs.readdirSync(directory)[0]);
      broaden(path, "read");
      assert.ok(grants(path).length > 0);
      return bytes;
    } } }), /ACL/);
    assert.equal(reads, 1, "readback decision reached");
  });
}

test("R152-04 native macOS: ordinary ancestor deny-delete ACL remains supported", native, (t) => {
  const root = rootFor(t);
  run("/bin/chmod", ["+a", "everyone deny delete", root]);
  assert.ok(grants(root).some((line) => /deny delete/.test(line)));
  const path = saveUpgradeBookmark(record, { directory: join(root, "bookmarks"), now });
  assert.equal(JSON.parse(fs.readFileSync(path)).bookmark, record.bookmark);
  assert.ok(grants(root).length > 0);
});

test("R152-04: native ACL denial and ambiguous listings fail closed with clean controls", () => {
  const header = "drwx------ 2 fixture staff 64 Oct 10 12:00 /fixture\n";
  for (const fault of ["denied-chmod", "denied-ls", "malformed-listing", "missing-entries"]) {
    let calls = 0;
    const run = (command, _args, options) => {
      calls++;
      assert.deepEqual(options.env, { PATH: "/usr/bin:/bin", LC_ALL: "C" });
      assert.equal(options.shell, false);
      const denied = command.endsWith(fault === "denied-chmod" ? "chmod" : fault === "denied-ls" ? "ls" : "unused");
      const output = fault === "malformed-listing" ? "unexpected" : fault === "missing-entries" ? header.replace("------ ", "------+ ") : header;
      return { status: denied ? 1 : 0, stdout: Buffer.from(output), stderr: Buffer.from("suppressed native detail") };
    };
    assert.throws(() => secureMacUpgradeBookmarkPath("/fixture", { run }), /^Error: recovery receipt macOS ACL could not be protected and verified$/);
    assert.equal(calls, fault === "denied-chmod" ? 1 : 2, "intended native gate reached");
    let controlCalls = 0;
    secureMacUpgradeBookmarkPath("/fixture", { run() {
      controlCalls++;
      return { status: 0, stdout: Buffer.from(header), stderr: Buffer.alloc(0) };
    } });
    assert.equal(controlCalls, 2, "clean native proof succeeds");
  }
});
