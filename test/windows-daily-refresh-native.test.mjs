import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 as win32Path } from "node:path";
import test from "node:test";

import {
  buildDailyRefreshDefinition,
  createNativeDailyRefreshAdapter,
  parseWindowsTaskInventory,
  removeDailyRefreshSchedule,
  restoreDailyRefreshSchedule,
  statusDailyRefreshSchedule,
} from "../operations/daily-refresh-scheduler.mjs";

// The recorder retains bounded byte facts, never XML, task locators, argv,
// native errors or stderr. Record before cleanup can replace the failing read.
function taskXmlProbe(t, spawn = spawnSync) {
  const events = [];
  const record = event => { events.push(event); if (events.length > 12) events.shift(); };
  return {
    spawn(command, args, options) {
      const result = spawn(command, args, options);
      if ((args[0] === "/Query" && args.includes("/XML")) || args.includes("-EncodedCommand")) {
        record({ operation: args.includes("-EncodedCommand") ? "com-export" : "query-xml",
          exit_status: Number.isInteger(result?.status) ? result.status : null,
          interrupted: Boolean(result?.signal), process_error: Boolean(result?.error) });
      }
      return result;
    },
    onTaskXmlDecode: record,
    run(action) {
      try { return action(); }
      catch (error) {
        t.diagnostic(`Windows task XML byte facts: ${JSON.stringify(events)}`);
        throw error;
      }
    },
  };
}

test("real Windows schtasks inventory and absent XML query match the production parser", {
  skip: process.platform === "win32" ? false : "requires the real Windows Task Scheduler CLI",
}, t => {
  const probe = taskXmlProbe(t);
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
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "daily-real-windows-")));
  try {
    const adapter = createNativeDailyRefreshAdapter({
      platform: "win32",
      home,
      environment,
      spawn: probe.spawn,
      onTaskXmlDecode: probe.onTaskXmlDecode,
    });
    probe.run(() => {
      const status = statusDailyRefreshSchedule(plan, { platform: "win32", adapter });
      assert.equal(status.installed, false);
      assert.equal(status.verified, true, "targeted /XML failure plus complete inventory proves absence");
    });
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


for (const pathKind of ["ascii", "accented"]) test(`real Windows registers, verifies and removes the product daily XML without running it (${pathKind})`, {
  skip: process.platform === "win32" ? false : "requires real win32 schtasks registration; fixture readback is not host proof",
}, t => {
  const probe = taskXmlProbe(t);
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.WINDIR;
  const environment = { SystemRoot: systemRoot, WINDIR: systemRoot };
  const current = spawnSync(win32Path.join(systemRoot, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"],
    { encoding: "utf8", env: environment, windowsHide: true });
  assert.equal(current.status, 0, "current-user SID lookup succeeded");
  const sid = String(current.stdout).trim().match(/^"(?:[^"]|"")*","(S-1-\d+(?:-\d+)+)"$/u)?.[1];
  assert.ok(sid, "a current-user SID was observed");
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), pathKind === "accented"
    ? "daily-registration-probe-ownér-" : "daily-registration-probe-owner-")));
  const identity = { id: `v1-${randomBytes(16).toString("hex")}`, principal: `sid:${sid}` };
  const name = `\\Financial Brain Probe\\${identity.id}`;
  const plan = { identity, manifest_path: join(home, "synthetic.manifest.json"), manifest_path_hash: "sha256:path",
    manifest_content_hash: "sha256:content", source_plan_hash: "sha256:sources", cron: "0 9 * * *", timezone: "UTC",
    max_runtime_minutes: 45, enabled: true, ready: true, sources: [] };
  const adapter = createNativeDailyRefreshAdapter({ platform: "win32", home, environment, taskSpec: { name: () => name },
    spawn: probe.spawn, onTaskXmlDecode: probe.onTaskXmlDecode });
  const definition = buildDailyRefreshDefinition(plan, { platform: "win32", home });
  // Never execute even if this probe happens at the daily clock slot. Register
  // disabled; the full product StartBoundary must verify unchanged. Do not issue /Run.
  const serialized = definition.serialized
    .replace(/<Settings>([\s\S]*?)<\/Settings>/u, (_all, settings) =>
      `<Settings>${settings.replace("<Enabled>true</Enabled>", "<Enabled>false</Enabled>")}</Settings>`);
  let attempted = false;
  try {
    probe.run(() => {
      assert.equal(Boolean(adapter.read(identity)?.exists), false, "the isolated random task is absent before registration");
      attempted = true;
      adapter.install({ ...definition, serialized });
      const status = statusDailyRefreshSchedule(plan, { platform: "win32", home, adapter });
      assert.equal(status.installed, true, "registration reached the real OS");
      assert.equal(status.enabled, false, "the probe cannot execute");
      assert.equal(status.verified, true, "real schtasks /Query /XML passes the production projection");
      assert.equal(status.definition_matches_plan, true);
      // Replay the exact OS export, including a COM-produced BOM when the pipe
      // cannot represent this accented synthetic path. Keep the task disabled.
      const snapshot = { identity, exists: true, enabled: false, definition: status.state.definition };
      assert.equal(removeDailyRefreshSchedule(plan, { platform: "win32", home, adapter }).removed, true);
      assert.equal(restoreDailyRefreshSchedule(snapshot, { platform: "win32", home, adapter }).verified, true);
      assert.equal(adapter.read(identity).enabled, false, "readback replay stays disabled");
      assert.equal(removeDailyRefreshSchedule(plan, { platform: "win32", home, adapter }).removed, true);
      assert.equal(Boolean(adapter.read(identity)?.exists), false, "the real adapter proved deletion");
    });
  } finally {
    // Registration may have succeeded before readback failed. The unique probe
    // path is ours to clean even if verification itself is broken.
    if (attempted) {
      const command = win32Path.join(systemRoot, "System32", "schtasks.exe");
      const query = spawnSync(command, ["/Query", "/TN", name, "/XML"], { encoding: "utf8", env: environment, windowsHide: true });
      if (query.status === 0) {
        const removed = spawnSync(command, ["/Delete", "/F", "/TN", name], { encoding: "utf8", env: environment, windowsHide: true });
        assert.equal(removed.status, 0, "failure cleanup removed only the isolated probe task");
      }
      probe.run(() => assert.equal(Boolean(adapter.read(identity)?.exists), false, "cleanup readback proves the task is gone"));
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("native probe reports safe byte facts on decode and verification failure, with a silent green control", () => {
  const plan = { identity: { id: "v1-0123456789abcdef", principal: "sid:S-1-5-21-101-202-303-1001" },
    manifest_path: String.raw`C:\Fixture\private-task-body.json`, manifest_path_hash: "sha256:path",
    manifest_content_hash: "sha256:content", source_plan_hash: "sha256:sources", cron: "0 9 * * *",
    timezone: "UTC", max_runtime_minutes: 45, enabled: true, ready: true, sources: [] };
  const definition = buildDailyRefreshDefinition(plan, { platform: "win32",
    nodePath: String.raw`C:\Runtime\node.exe`, brainPath: String.raw`C:\Runtime\brain.mjs`,
    runnerPath: String.raw`C:\Runtime\daily-refresh-run.mjs` });
  for (const outcome of ["good", "decode", "verify"]) {
    const lines = [];
    let reads = 0;
    const probe = taskXmlProbe({ diagnostic: line => lines.push(line) }, () => {
      reads++;
      const text = definition.serialized.replaceAll("\n", "\r\r\n");
      return { status: 0, stdout: Buffer.from(outcome === "decode" ? [0xff, 0xfe, 0x3c]
        : outcome === "verify" ? text.replace("</Actions>", "<Exec/></Actions>") : text, "utf8") };
    });
    const adapter = createNativeDailyRefreshAdapter({ platform: "win32", home: "fixture-home",
      environment: { SystemRoot: String.raw`C:\Windows` }, spawn: probe.spawn, onTaskXmlDecode: probe.onTaskXmlDecode });
    const action = () => probe.run(() => {
      const state = adapter.read(plan.identity);
      assert.equal(state.exists, true);
      assert.equal(state.definition.native_contract_valid, true, "synthetic verification failure");
    });
    if (outcome === "good") action();
    else assert.throws(action, outcome === "decode" ? /decoded losslessly/u : /synthetic verification failure/u);
    assert.equal(reads, 1, "all arms reached the actual adapter read");
    assert.equal(lines.length, outcome === "good" ? 0 : 1);
    if (lines.length) {
      const events = JSON.parse(lines[0].slice("Windows task XML byte facts: ".length));
      assert.equal(events[0].operation, "query-xml");
      assert.equal(events[1].branch, outcome === "decode" ? "utf-16le" : "ascii");
      for (const key of ["byte_length", "first_16_hex", "bom", "nul_count", "cr_count", "crlf_count", "crcrlf_count", "declared_encoding"])
        assert.ok(Object.hasOwn(events[1], key), `failure includes ${key}`);
      assert.equal(lines[0].includes("private-task-body"), false);
      assert.equal(lines[0].includes(plan.identity.id), false);
    }
  }
});
