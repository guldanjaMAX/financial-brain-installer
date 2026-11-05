import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveNpmCliPath } from "../operations/npm-cli-runtime.mjs";
import { isolatedUpdateSchedulerOptions } from "./fixtures/isolated-update-schedulers.mjs";
import { captureAdditionalUpdateSchedulers } from "../operations/update-scheduler-inventory.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
test("simulated Darwin inventory stays isolated without process.getuid on any OS", async t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "scheduler-no-uid-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const getuid = Object.getOwnPropertyDescriptor(process, "getuid");
  delete process.getuid;
  t.after(() => {
    if (getuid) Object.defineProperty(process, "getuid", getuid);
  });
  let listings = 0;
  let inventories = 0;
  const fallback = join(root, "fallback-home");
  const poisoned = join(fallback, "Library", "LaunchAgents");
  mkdirSync(poisoned, { recursive: true });
  writeFileSync(join(poisoned, "com.brain-installer.sentinel.curated-sync.plist"), "{}");
  const readDirectory = fs.readdirSync;
  const homeMock = t.mock.method(os, "homedir", () => fallback);
  const inventoryMock = t.mock.method(fs, "readdirSync", (path, ...args) => {
    assert.notEqual(resolve(String(path)), poisoned, "the poisoned fallback inventory must never be read");
    if (resolve(String(path)) === join(root, "Library", "LaunchAgents")) inventories++;
    return readDirectory(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    homeMock.mock.restore();
    inventoryMock.mock.restore();
    syncBuiltinESMExports();
  });
  const options = isolatedUpdateSchedulerOptions(root, { platform: "darwin" });
  const launchctl = options.legacySchedulerOptions.launchctl;
  options.legacySchedulerOptions.launchctl = args => { listings++; return launchctl(args); };
  const manifestPath = join(root, "brain.manifest.json");
  const manifest = { client: { slug: "owner" }, corpora: {} };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const entries = await captureAdditionalUpdateSchedulers(manifest, manifestPath, options);
  assert.deepEqual(entries, [], "the real simulated-Darwin inventory found no fixture jobs");
  assert.ok(listings >= 2, "list and disabled inventory reached the injected launchctl");
  assert.ok(inventories > 0, "the real inventory reached the disposable home beside the poisoned fallback");
  assert.equal(options.schedulerOptions.uid, 501);
  assert.equal(options.legacySchedulerOptions.uid, 501);
  const override = isolatedUpdateSchedulerOptions(root, { schedulerOptions: { uid: 702 }, legacySchedulerOptions: { uid: 703 } });
  assert.equal(override.schedulerOptions.uid, 702, "native caller overrides survive");
  assert.equal(override.legacySchedulerOptions.uid, 703, "legacy caller overrides survive");
});
for (const file of ["update-pending-refusal", "same-version-paused-resume", "upgrade-verify",
  "cloudflare-oauth-session", "windows-keyring-console", "legacy-manifest-auth-profile"])
test(`${file} ignores an unreadable job in the fallback home`, { timeout: 300_000,
  skip: process.platform !== "darwin" && "LaunchAgents fallback is a macOS path" }, () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "scheduler-isolation-")));
  try {
    const home = join(root, "fallback-home");
    const directory = join(home, "Library", "LaunchAgents");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "com.brain-installer.sentinel.curated-sync.plist"), "{}", { mode: 0o600 });
    const result = spawnSync(process.execPath, ["--import", "./test/fixtures/scheduler-inventory-sentinel.mjs", `test/${file}.test.mjs`], {
      cwd: ROOT, encoding: "utf8", timeout: 280_000, maxBuffer: 8 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, TMPDIR: root,
        BRAIN_NO_WRANGLER_LOGIN: "1", BRAIN_TEST_SCHEDULER_SENTINEL_HOME: home,
        npm_config_cache: process.env.npm_config_cache ?? join(root, "npm-cache"), npm_config_offline: "true",
        npm_execpath: resolveNpmCliPath() },
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    assert.doesNotMatch(output, /HOST_HELPER_REFUSED/u, "every host helper stayed injected");
    assert.doesNotMatch(output, /SCHEDULER_SENTINEL_REACHED/u, "the poisoned fallback inventory must never be read");
    assert.match(output, /SCHEDULER_FIXTURE_INVENTORY_REACHED/u, "the child reached its injected scheduler inventory");
    assert.equal(result.status, 0, `${file} child failed: ${result.error?.message ?? ""}\n${output}`);
    assert.match(output, /(?:\bPASS\b|\bpass [1-9])/u, "the child reached its assertions");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
