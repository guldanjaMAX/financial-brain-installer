import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquireBrainLifecycleLock } from "../operations/brain-lifecycle-lock.mjs";
import { installLifecycleLockTripwire } from "./fixtures/lifecycle-lock-tripwire.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
function sandbox(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "windows-harness-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("lifecycle tripwire refuses an escaped lock before writing and permits a real fixture lock", t => {
  const root = sandbox(t);
  const fixture = join(root, "fixture");
  mkdirSync(fixture);
  const manifestPath = join(fixture, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify({ client: { slug: "owner" } }));
  const guard = installLifecycleLockTripwire(fixture);
  t.after(() => guard.restore());
  const outside = join(root, "outside-locks");
  assert.throws(() => {
    // Release even in the red/mutated arm so the probe cannot leave a lock.
    const lock = acquireBrainLifecycleLock({ manifestPath, operation: "probe", machineLockRoot: outside });
    lock.release();
  }, /TEST_LIFECYCLE_LOCK_OUTSIDE_FIXTURE/u);
  assert.equal(guard.blocked, 1, "the escaped write reached the tripwire decision");
  assert.equal(existsSync(outside), false, "the refused directory was never created");
  const lock = acquireBrainLifecycleLock({ manifestPath, operation: "probe", machineLockRoot: join(fixture, "locks") });
  try {
    lock.assertOwned();
    assert.ok(guard.attempts >= 3, "the green control reached real root and lock-directory writes");
  } finally { lock.release(); }
});

for (const [file, pattern] of [
  ["worker/test/sensitive-fallback.test.mjs", "mixed candidates stay private"],
  ["test/private-ledger-replay.test.mjs", "in-memory worker executes|synthetic export is read"],
]) test(`${file} launches filesystem preloads as file URLs`, { timeout: file === 'test/private-ledger-replay.test.mjs' ? 500_000 : 120_000 }, t => {
  const root = sandbox(t);
  const home = join(root, "home");
  mkdirSync(home);
  const env = { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, TMPDIR: root,
    BRAIN_NO_WRANGLER_LOGIN: "1", PRIVATE_REPLAY_TEST_SCRATCH: join(root, "replay") };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const child = spawnSync(process.execPath, ["--import", pathToFileURL(join(ROOT, "test/fixtures/import-url-tripwire.mjs")).href,
    "--test", `--test-name-pattern=${pattern}`, join(ROOT, file)], {
    // The selected private tests can each run two 120 s child attempts.
    cwd: ROOT, env, encoding: "utf8", timeout: file === 'test/private-ledger-replay.test.mjs' ? 490_000 : 110_000, maxBuffer: 8 * 1024 * 1024,
  });
  const output = `${child.stdout ?? ""}\n${child.stderr ?? ""}`;
  assert.match(output, /IMPORT_ARGUMENT_REACHED/u, "the real launcher reached its preload argument");
  assert.equal(child.status, 0, `${child.error?.message ?? ""}\n${output}`);
  assert.match(output, /IMPORT_FILE_URL_REACHED/u, "the accepted file URL is the green control");
});
