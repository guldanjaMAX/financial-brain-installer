import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 as win32Path } from "node:path";
import test from "node:test";

import {
  buildDailyRefreshDefinition,
  createNativeDailyRefreshAdapter,
  parseWindowsTaskInventory,
  statusDailyRefreshSchedule,
} from "../operations/daily-refresh-scheduler.mjs";

test("real Windows schtasks inventory and absent XML query match the production parser", {
  skip: process.platform === "win32" ? false : "requires the real Windows Task Scheduler CLI",
}, () => {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.WINDIR;
  assert.ok(win32Path.isAbsolute(String(systemRoot || "")), "Windows exposed an absolute system root");
  const command = win32Path.join(systemRoot, "System32", "schtasks.exe");
  const environment = { SystemRoot: systemRoot, WINDIR: process.env.WINDIR || systemRoot };
  const inventory = spawnSync(command, ["/Query", "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    env: environment,
    windowsHide: true,
  });
  assert.equal(inventory.status, 0, "the read-only real inventory query completed");
  const names = parseWindowsTaskInventory(inventory.stdout);
  assert.ok(names.length > 0, "the production parser observed a non-empty real inventory");

  const plan = {
    identity: { id: "v1-0000000000000000", principal: "sid:S-1-0-0" },
    manifest_path: String.raw`C:\fixture\brain.manifest.json`,
    manifest_path_hash: "sha256:path",
    manifest_content_hash: "sha256:content",
    source_plan_hash: "sha256:sources",
    cron: "0 9 * * *",
    timezone: "Etc/UTC",
    max_runtime_minutes: 45,
    enabled: true,
    ready: true,
    sources: [],
  };
  const taskName = `\\Financial Brain\\Daily ${plan.identity.id}`;
  assert.equal(names.includes(taskName), false, "the synthetic absent-task control is genuinely absent");
  const definition = buildDailyRefreshDefinition(plan, { platform: "win32" });
  assert.equal(win32Path.basename(definition.node_path).toLowerCase(), "node.exe",
    "the production Windows path selects the real Node executable");
  const home = mkdtempSync(join(tmpdir(), "daily-real-windows-"));
  try {
    const adapter = createNativeDailyRefreshAdapter({
      platform: "win32",
      home,
      environment,
    });
    const status = statusDailyRefreshSchedule(plan, { platform: "win32", adapter });
    assert.equal(status.installed, false);
    assert.equal(status.verified, true, "targeted /XML failure plus complete inventory proves absence");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
