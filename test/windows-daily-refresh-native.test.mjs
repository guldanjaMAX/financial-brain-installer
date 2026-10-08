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

test("Windows daily runtime uses exact native task info and reports denied inspection", () => {
  const calls = [];
  let response = { status: 0, stdout: JSON.stringify({ known: true, running: false, exit_code: 5,
    last_run_at: "2026-10-07T16:00:00.000Z", next_run_at: "2026-10-08T16:00:00.000Z" }) };
  const adapter = createNativeDailyRefreshAdapter({ platform: "win32", home: "fixture-home",
    environment: { SystemRoot: String.raw`C:\Windows`, UNRELATED_VALUE: "must-not-reach-child" },
    spawn: (command, args, options) => { calls.push({ command, args, options }); return response; },
  });
  const identity = { id: "v1-fixture" };
  assert.equal(adapter.runtime(identity).exit_code, 5, "a process authorization failure is retained");
  assert.equal(calls[0].command, String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
  assert.ok(calls[0].args.at(-1).includes(String.raw`-TaskPath '\Financial Brain\'`));
  assert.ok(calls[0].args.at(-1).includes("-TaskName 'Daily v1-fixture'"));
  assert.deepEqual(calls[0].options.env, { SystemRoot: String.raw`C:\Windows` });
  response = { status: 5, stderr: "private native error" };
  assert.deepEqual(adapter.runtime(identity), { known: false });
  response = { status: 0, stdout: JSON.stringify({ known: true, running: false, exit_code: 0 }) };
  assert.equal(adapter.runtime(identity).exit_code, 0, "the identical inspection has a green control");
  response = { status: 0, stdout: "not JSON" };
  assert.deepEqual(adapter.runtime(identity), { known: false });
  assert.equal(calls.length, 4, "every outcome reached native inspection");
});
