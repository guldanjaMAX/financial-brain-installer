import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildDailyRefreshDefinition, createNativeDailyRefreshAdapter } from "../operations/daily-refresh-scheduler.mjs";

const plan = { identity: { id: "v1-0123456789abcdef", principal: "sid:S-1-5-21-101-202-303-1001" },
  manifest_path: String.raw`C:\Fixture\brain.manifest.json`, manifest_path_hash: "sha256:path",
  manifest_content_hash: "sha256:content", source_plan_hash: "sha256:sources", cron: "0 9 * * *",
  timezone: "UTC", max_runtime_minutes: 45, enabled: true, ready: true, sources: [] };
const definition = buildDailyRefreshDefinition(plan, { platform: "win32", nodePath: String.raw`C:\ownér\node.exe`,
  brainPath: String.raw`C:\Runtime\brain.mjs`, runnerPath: String.raw`C:\Runtime\daily-refresh-run.mjs` });
const systemRoot = String.raw`C:\Windows`;

function adapter(home, result) {
  let mutations = 0; let exports = 0;
  return { get mutations() { return mutations; }, get exports() { return exports; },
    native: createNativeDailyRefreshAdapter({ platform: "win32", home, environment: { SystemRoot: systemRoot },
      spawn: (command, args, child) => {
        if (command.endsWith("powershell.exe")) {
          exports++;
          assert.equal(child.timeout, 60000);
          assert.equal(child.killSignal, "SIGKILL");
          if (typeof result === "function") return result();
          return result || { status: 0, stdout: Buffer.from(`\ufeff${definition.serialized}`, "utf16le") };
        }
        if (args[0] === "/Query") return { status: 0, stdout: Buffer.from(definition.serialized, "latin1") };
        assert.equal(args[0], "/Change"); mutations++; return { status: 0 };
      } }),
  };
}

for (const outcome of ["timeout", "killed", "throw"]) test(`FIX-3 ${outcome} Unicode child releases the mutation lock`, t => {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "daily-interrupt-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const response = outcome === "timeout" ? { status: null, error: { code: "ETIMEDOUT" }, signal: "SIGKILL" }
    : { status: null, signal: "SIGKILL" };
  const failed = adapter(home, outcome === "throw" ? () => { throw new Error("synthetic interrupted child"); } : response);
  assert.throws(() => failed.native.setEnabled(plan.identity, true), /decoded losslessly/);
  assert.equal(failed.exports, 1, "read was interrupted inside the lock");
  assert.equal(failed.mutations, 0);
  const healthy = adapter(home);
  healthy.native.setEnabled(plan.identity, true);
  assert.equal(healthy.exports, 2, "green control reached both guarded reads");
  assert.equal(healthy.mutations, 1);
  assert.equal(existsSync(join(home, ".brain", "schedule-mutations", `${plan.identity.id}.lock`)), false);
});

test("FIX-3 killed lock owner can be recovered, while a live owner cannot be displaced", { timeout: 15000 }, async t => {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "daily-killed-owner-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const moduleUrl = new URL("../operations/daily-refresh-scheduler.mjs", import.meta.url).href;
  const script = `import { createNativeDailyRefreshAdapter } from ${JSON.stringify(moduleUrl)};
    import { writeSync } from "node:fs";
    const definition = ${JSON.stringify(definition)};
    createNativeDailyRefreshAdapter({ platform: 'win32', home: process.env.HOME,
      environment: { SystemRoot: ${JSON.stringify(systemRoot)} }, spawn(command, args, child) {
        if (command.endsWith('powershell.exe')) {
          writeSync(1, 'locked\\n');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
          return { status: null, signal: 'SIGKILL' };
        }
        return { status: 0, stdout: Buffer.from(definition.serialized, 'latin1') };
      } }).setEnabled(definition.identity, true);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { HOME: home, BRAIN_NO_WRANGLER_LOGIN: "1", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const closed = once(child, "close");
  const [ready] = await once(child.stdout, "data");
  assert.equal(String(ready), "locked\n", "child reached the slow COM read while holding the actual lock");
  const contender = adapter(home);
  assert.throws(() => contender.native.setEnabled(plan.identity, true), /already being changed/);
  assert.equal(contender.exports, 0, "live lock refuses before any scheduler read");
  child.kill("SIGKILL");
  await closed;
  contender.native.setEnabled(plan.identity, true);
  assert.equal(contender.mutations, 1, "dead-owner recovery reaches native mutation");
  assert.equal(existsSync(join(home, ".brain", "schedule-mutations", `${plan.identity.id}.lock`)), false);
});
