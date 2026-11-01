import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { cmdUpdate } from "../brain.mjs";
import { buildWhatsappDrainSchedulerPlan } from "../operations/whatsapp-drain-scheduler.mjs";
import { renderLaunchAgentPlist } from "../operations/drive-scheduler.mjs";
import { buildCuratedSchedulerPlan, renderCuratedLaunchAgentPlist } from "../operations/curated-sync-scheduler.mjs";
import * as quickbooks from "../operations/quickbooks-schedule.mjs";
import { buildWhatsappDaemonPlan, renderDaemonPlist } from "../operations/whatsapp-daemon.mjs";
import { dailyRefreshIdentity } from "../operations/daily-refresh-plan.mjs";
import { buildDailyRefreshDefinition } from "../operations/daily-refresh-scheduler.mjs";
import { captureAdditionalUpdateSchedulers, pauseAdditionalUpdateScheduler, reconcileAdditionalUpdateScheduler } from "../operations/update-scheduler-inventory.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const uid = process.getuid?.() ?? 501;
const macTest = (name, body) => test(name, { skip: process.platform === "win32" && "macOS simulation requires POSIX ownership and file modes" }, body);
// HOME alone does not isolate launchd's GUI domain. Fail before any host
// scheduler or credential helper can run if an injected adapter is lost.
const hostCalls = [];
test.before(() => {
  for (const method of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"]) {
    const original = childProcess[method];
    test.mock.method(childProcess, method, (command, ...args) => {
      if (/^(?:launchctl|security|wrangler|schtasks|powershell|pwsh)(?:\.exe)?$/u.test(basename(String(command))) ||
          (method.startsWith("exec") && /\b(?:launchctl|security|wrangler|schtasks)\b/u.test(String(command)))) {
        hostCalls.push(method);
        throw new Error("host scheduler or credential helper reached instead of the fixture adapter");
      }
      return original(command, ...args);
    });
  }
  syncBuiltinESMExports();
});
test.after(() => {
  test.mock.restoreAll();
  syncBuiltinESMExports();
  assert.deepEqual(hostCalls, [], "all scheduler and credential boundaries stayed injected");
});
const decode = value => value.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'");
function parsePlist(bytes) {
  const text = String(bytes);
  const field = name => decode(text.match(new RegExp(`<key>${name}</key>\\s*<string>([^<]*)</string>`))?.[1] ?? "");
  const args = text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? "";
  return { Label: field("Label"), WorkingDirectory: field("WorkingDirectory"),
    EnvironmentVariables: { BRAIN_MANIFEST_PATH: field("BRAIN_MANIFEST_PATH"), WA_DATA_DIR: field("WA_DATA_DIR") },
    ProgramArguments: [...args.matchAll(/<string>([^<]*)<\/string>/g)].map(match => decode(match[1])) };
}

function fixture({ aliasHome = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "scheduler-case-"));
  const requestedHome = aliasHome ? join(directory, "alias") : directory;
  if (aliasHome) symlinkSync(".", requestedHome, "dir");
  // Update resolves the manifest to its physical path before capture. Keep
  // saved argv, WorkingDirectory and loaded paths on that same fixture path,
  // including macOS temporary directories reached through /var aliases.
  const home = realpathSync(requestedHome);
  const manifestPath = join(home, "brain.manifest.json");
  const keyPath = join(home, "fixture-admin");
  writeFileSync(keyPath, randomBytes(32).toString("hex"), { mode: 0o600 });
  const m = { client: { slug: "fixture", timezone: "UTC" },
    brain: { version: "0.4.18", domain: "brain.example.invalid", worker_name: "fixture-brain" },
    infrastructure: { cloudflare: { storage: "d1", account_id: "1".repeat(32), d1_database_id: "11111111-2222-4333-8444-555555555555" } },
    corpora: { whatsapp: { enabled: true } }, operations: { admin_key_secret: `file://${keyPath}` } };
  writeFileSync(manifestPath, JSON.stringify(m), { mode: 0o600 });
  const loaded = new Map();
  const disabled = new Set();
  const calls = [], finish = [], reports = [];
  const native = { platform: "darwin", uid, home, nodePath: process.execPath,
    brainPath: join(ROOT, "brain.mjs"), parseInstalledPlist: parsePlist };
  const launchctl = args => {
    calls.push(args);
    if (args[0] === "list") return { status: 0, stdout: `PID Status Label\n${[...loaded.keys()].map(service => `- 0 ${service.split("/").at(-1)}`).join("\n")}\n` };
    if (args[0] === "print-disabled") return { status: 0, stdout: `disabled services = {\n${[...disabled].map(service => `"${service.split("/").at(-1)}" => true`).join("\n")}\n}` };
    if (args[0] === "disable") disabled.add(args[1]);
    if (args[0] === "enable") disabled.delete(args[1]);
    if (args[0] === "print") {
      const item = loaded.get(args[1]);
      if (!item) return { status: 113, stderr: "not found" };
      return { status: 0, stdout: `path = ${item.path}\nstate = waiting\narguments = {\n${item.args.join("\n")}\n}\n` };
    }
    if (args[0] === "bootout") loaded.delete(args[1]);
    if (args[0] === "bootstrap") {
      const definition = parsePlist(readFileSync(args[2]));
      loaded.set(`${args[1]}/${definition.Label}`, { path: args[2], args: definition.ProgramArguments });
    }
    return { status: 0, stdout: "" };
  };
  native.launchctl = launchctl;
  const plan = { identity: { id: "v1-0123456789abcdef", principal: `uid:${uid}` },
    manifest_path: manifestPath, platform: "darwin", enabled: false, ready: true, sources: [] };
  let upgrades = 0;
  const options = {
    interactive: false, discoverInstalledManifest: () => ({ path: manifestPath }),
    answerSetupNeedsRecovery: () => false, adoptCloudflareAuthProfile: async () => {},
    readUpdateBacklog: async () => ({ pending: 0 }), withCloudflareControl: async action => action(),
    cmdVerify: async () => {}, cmdUpgrade: async () => { upgrades++; return { daily_final_state: { active: true, query_ready: true, pending: 0 } }; },
    lifecycleLockOptions: { platform: "darwin", machineLockRoot: join(home, "machine-locks") },
    reconcileExistingOwnerAgents: null, writeClaudeWorkspaceGuideAfterUpdate: null,
    installTechnicianSkills: () => [{ root: ".codex", status: "verified" }],
    reportSkillRefreshOk: () => {}, reportSkillRefreshWarning: () => {},
    reportUpdateFinish: text => finish.push(text), reportUpdateSchedulers: rows => reports.push(rows),
    dailyRefreshOptions: { platform: "darwin", existingSchedulerOwners: [], planDailyRefresh: async () => plan,
      schedulerAdapter: { read: () => ({ exists: false, owned: false, enabled: false }) },
      schedulerOptions: { ...native, machineLockRoot: join(home, "machine-locks") },
      legacySchedulerOptions: native, syncSourceExpectations: false },
  };
  function installFile(plan, text) {
    mkdirSync(dirname(plan.plistPath), { recursive: true, mode: 0o700 });
    writeFileSync(plan.plistPath, text, { mode: 0o600 });
    loaded.set(plan.service, { path: plan.plistPath, args: plan.programArguments });
  }
  return { home, requestedHome, manifestPath, m, native, options, calls, finish, reports, loaded, disabled, installFile,
    upgrades: () => upgrades, close: () => rmSync(directory, { recursive: true, force: true }) };
}

macTest("temporary home aliases and physical homes exercise the same update proof", async () => {
  for (const aliasHome of [false, true]) for (const state of ["stale", "current", "disabled"]) {
    const f = fixture({ aliasHome });
    try {
      if (aliasHome) assert.notEqual(f.requestedHome, realpathSync(f.requestedHome), "the alias arm reaches physical path resolution");
      const old = buildWhatsappDrainSchedulerPlan(f.manifestPath, { ...f.native,
        ...(state !== "current" ? { brainPath: join(f.home, "old", "brain.mjs") } : {}) });
      f.installFile(old, renderLaunchAgentPlist(old));
      if (state === "disabled") { f.loaded.delete(old.service); f.disabled.add(old.service); }
      let failure;
      try { await cmdUpdate(f.manifestPath, f.options); } catch (error) { failure = error; }
      assert.ok(f.calls.some(call => call[0] === "print" && call[1] === old.service), "every arm reached installed ownership inspection");
      assert.ifError(failure);
      assert.equal(f.home, realpathSync(f.requestedHome));
      assert.equal(f.upgrades(), 1);
      assert.equal(f.reports.flat().find(row => row.kind === "whatsapp-drain")?.state, state === "current" ? "already current" : "moved");
      assert.equal(f.loaded.has(old.service), state !== "disabled");
      if (state === "disabled") assert.ok(f.calls.every(call => call[0] !== "bootstrap"));
    } finally { f.close(); }
  }
});

macTest("inventory names the failed proof without exposing the native error", async () => {
  for (const defect of [null, "launch state", "idle state", "saved definition", "manifest binding", "loaded definition"]) {
    const f = fixture();
    try {
      const plan = buildWhatsappDrainSchedulerPlan(f.manifestPath, f.native);
      f.installFile(plan, renderLaunchAgentPlist(plan));
      const nativeLaunch = f.native.launchctl;
      f.native.launchctl = args => {
        const result = nativeLaunch(args);
        if (args[0] !== "print" || args[1] !== plan.service) return result;
        if (defect === "launch state") return { status: 77, stderr: "private native diagnostic" };
        if (defect === "idle state") return { ...result, stdout: result.stdout.replace("state = waiting", "state = running\npid = 2468") };
        return result;
      };
      if (defect === "saved definition") chmodSync(plan.plistPath, 0o644);
      if (defect === "manifest binding") writeFileSync(plan.plistPath,
        renderLaunchAgentPlist(plan).replace(`<string>${plan.path}</string>`, `<string>${join(f.home, "other.manifest.json")}</string>`));
      if (defect === "loaded definition") f.loaded.set(plan.service, { path: plan.plistPath, args: [...plan.programArguments, "foreign-argument"] });
      let entries, failure;
      try { entries = await captureAdditionalUpdateSchedulers(f.m, f.manifestPath, f.options.dailyRefreshOptions); } catch (error) { failure = error; }
      assert.ok(f.calls.some(call => call[0] === "print" && call[1] === plan.service), "every proof arm reached native inspection");
      assert.ok(f.calls.every(call => ["print", "list", "print-disabled"].includes(call[0])), "capture is read only");
      if (defect) {
        assert.equal(failure?.code, "UPDATE_SCHEDULERS_INCOMPLETE");
        assert.ok(failure.message.includes(`${defect} proof failed`), `missing ${defect} diagnostic: ${failure.message}`);
        const reason = failure.scheduler_results.find(row => row.kind === "whatsapp-drain").reason;
        assert.ok(!reason.includes(f.home) && !reason.includes("private native diagnostic"), "proof reasons contain only fixed public text");
      } else {
        assert.ifError(failure);
        assert.equal(entries.length, 1, "the healthy control produces an owned snapshot");
      }
    } finally { f.close(); }
  }
});

macTest("real update moves a stale drain and accepts a current drain control", async () => {
  for (const stale of [true, false]) {
    const f = fixture();
    try {
      const old = buildWhatsappDrainSchedulerPlan(f.manifestPath, { ...f.native,
        ...(stale ? { brainPath: join(f.home, "old-runtime", "brain.mjs"), schedulerPath: join(f.home, "old-runtime", "whatsapp-drain-scheduler.mjs") } : {}) });
      f.installFile(old, renderLaunchAgentPlist(old));
      await cmdUpdate(f.manifestPath, f.options);
      assert.equal(f.upgrades(), 1, "the real update dispatched the injected remote boundary");
      assert.ok(f.calls.some(call => call[0] === "print" && call[1] === old.service), "inventory inspected this job");
      const expected = buildWhatsappDrainSchedulerPlan(f.manifestPath, f.native);
      assert.deepEqual(f.loaded.get(old.service)?.args, expected.programArguments);
      const row = f.reports.flat().find(row => row.kind === "whatsapp-drain");
      assert.equal(row?.state, stale ? "moved" : "already current");
      assert.match(f.finish.join("\n"), /WhatsApp drain: (moved|already current)/);
    } finally { f.close(); }
  }
});

macTest("similar foreign label is inspected and left untouched beside an owned drain", async () => {
  const f = fixture();
  try {
    const own = buildWhatsappDrainSchedulerPlan(f.manifestPath, f.native);
    f.installFile(own, renderLaunchAgentPlist(own));
    const foreignPath = join(dirname(own.plistPath), "com.brain-installer.fixture-other.whatsapp-drain.plist");
    const foreign = renderLaunchAgentPlist(own).replaceAll(own.label, "com.brain-installer.fixture-other.whatsapp-drain");
    writeFileSync(foreignPath, foreign, { mode: 0o600 });
    await cmdUpdate(f.manifestPath, f.options);
    assert.ok(f.calls.some(call => call[0] === "print" && call[1] === own.service), "owned control reached the decision");
    assert.equal(readFileSync(foreignPath, "utf8"), foreign);
    assert.ok(f.reports.flat().some(row => row.kind === "whatsapp-drain"));
    assert.ok(f.calls.every(call => !call.some(arg => arg.includes("fixture-other"))));
  } finally { f.close(); }
});

function curated(f, stale) {
  const planPath = join(f.home, "curated-plan.json");
  writeFileSync(planPath, JSON.stringify({ schema_version: 1, root: "corpus", expected_documents: 1,
    expected_roles: { authoritative: 1, superseded: 0, plain: 0 }, ledger_namespace: "fixture-curated-namespace",
    documents: [{ relative_path: "fixture.md", role: "authoritative", legacy_source_type: "curated", legacy_source_id: "fixture-id", metadata: {} }],
    transforms: { authoritative: { content_prefix: "", title_prefix: "" }, superseded: { content_prefix: "", title_prefix: "" }, plain: { content_prefix: "", title_prefix: "" } },
    common_metadata: {}, cloudflare_target: { manifest: f.manifestPath, backend: "cloudflare_d1" },
    ledger_file: "curated-ledger.json", scheduler: { slug: "fixture-curated", cron: "10 7 * * *", timezone: "UTC" } }), { mode: 0o600 });
  const plan = buildCuratedSchedulerPlan(planPath, { ...f.native,
    ...(stale ? { schedulerPath: join(f.home, "old-runtime", "curated-sync-scheduler.mjs") } : {}) });
  f.installFile(plan, renderCuratedLaunchAgentPlist(plan));
  return { planPath, plan };
}

macTest("older curated runtime moves through reviewed reinstall; current control passes", async () => {
  for (const stale of [true, false]) {
    const f = fixture();
    try {
      const { plan } = curated(f, stale);
      let failure;
      try { await cmdUpdate(f.manifestPath, f.options); } catch (error) { failure = error; }
      assert.ok(f.calls.some(call => call[0] === "print" && call[1] === plan.service), "curated ownership reached native inspection");
      const row = f.reports.flat().find(row => row.kind === "curated-sync");
      assert.ok(row, "curated job is in the update result");
      if (failure) {
        assert.equal(row.state, "COULD NOT MOVE");
        assert.ok(row.fix.includes("reinstall"));
        assert.match(failure.message, /COULD NOT MOVE/);
        assert.equal(f.finish.length, 0, "failure has no completion headline");
      } else assert.equal(row.state, stale ? "moved" : "already current");
      assert.equal(failure, undefined, "the bound plan permits both old and current runtimes");
    } finally { f.close(); }
  }
});

test("Windows task uses stable manifest identity and exact new runtime readback", async () => {
  for (const foreign of ["owner", "action", null]) {
    const f = fixture();
    try {
      f.m.corpora = { quickbooks: { enabled: true } };
      f.m.operations.quickbooks_schedule = { enabled: true, timezone: "UTC" };
      writeFileSync(f.manifestPath, JSON.stringify(f.m), { mode: 0o600 });
      const options = { platform: "win32", principal: "sid:S-1-5-21-100-200-300-1001", localTimezone: "UTC", now: new Date("2026-01-01T00:00:00Z") };
      const plan = quickbooks.planQuickBooksSchedule({ m: f.m, manifestPath: f.manifestPath, ...options });
      const paths = { platform: "win32", nodePath: String.raw`C:\Runtime\node.exe`, brainPath: String.raw`C:\Runtime\brain.mjs`, runnerPath: String.raw`C:\Runtime\quickbooks-schedule.mjs` };
      const old = quickbooks.buildQuickBooksScheduleDefinition(plan, { ...paths, nodePath: String.raw`C:\OldRuntime\node.exe`,
        ...(foreign === "action" ? { runnerPath: String.raw`C:\Other\unrelated.mjs` } : {}) });
      let state = { exists: true, owned: foreign !== "owner", enabled: true, definition: old };
      const events = [];
      const adapter = { read: () => { events.push("read"); return state; },
        setEnabled: (_identity, enabled) => { events.push(`enabled:${enabled}`); state = { ...state, enabled }; },
        install: definition => { events.push("install"); state = { exists: true, owned: true, enabled: true, definition }; } };
      options.quickBooksSchedulerOptions = { ...paths, adapter, runtimeUsable: () => true };
      let entries, failure;
      try { entries = await captureAdditionalUpdateSchedulers(f.m, f.manifestPath, options); } catch (error) { failure = error; }
      assert.ok(events.includes("read"), "both arms reached native ownership inspection");
      if (foreign) {
        assert.match(failure?.message ?? "", /COULD NOT MOVE/);
        assert.ok(events.every(event => event === "read"), "foreign task was never mutated");
      } else {
        assert.ifError(failure);
        assert.equal(entries.length, 1);
        await pauseAdditionalUpdateScheduler(f.m, f.manifestPath, entries[0], options);
        const row = await reconcileAdditionalUpdateScheduler(f.m, f.manifestPath, entries[0], options);
        assert.equal(row.state, "moved");
        assert.ok(events.includes("install"), "control reached reviewed registration");
        assert.equal(quickbooks.statusQuickBooksSchedule(plan, options.quickBooksSchedulerOptions).verified, true);
      }
    } finally { f.close(); }
  }
});

macTest("same exact label with another manifest refuses before update and never mutates", async () => {
  const f = fixture();
  try {
    const other = join(f.home, "other.manifest.json");
    writeFileSync(other, JSON.stringify(f.m), { mode: 0o600 });
    const foreign = buildWhatsappDrainSchedulerPlan(other, f.native);
    const original = renderLaunchAgentPlist(foreign);
    f.installFile(foreign, original);
    await assert.rejects(cmdUpdate(f.manifestPath, f.options), /COULD NOT MOVE/);
    assert.ok(f.calls.some(call => call[0] === "print" && call[1] === foreign.service));
    assert.ok(f.calls.every(call => ["print", "list", "print-disabled"].includes(call[0])));
    assert.equal(readFileSync(foreign.plistPath, "utf8"), original);
    assert.equal(f.upgrades(), 0);
    assert.equal(f.finish.length, 0);
  } finally { f.close(); }
});

macTest("a disabled drain keeps its disabled intent without launching even once", async () => {
  for (const word of ["true", "disabled"]) {
  const f = fixture();
  try {
    const plan = buildWhatsappDrainSchedulerPlan(f.manifestPath, { ...f.native, brainPath: join(f.home, "old", "brain.mjs") });
    f.installFile(plan, renderLaunchAgentPlist(plan));
    f.loaded.delete(plan.service);
    f.disabled.add(plan.service);
    const nativeLaunch = f.native.launchctl;
    f.native.launchctl = args => {
      const result = nativeLaunch(args);
      return args[0] === "print-disabled" ? { ...result, stdout: result.stdout.replaceAll("=> true", `=> ${word}`) } : result;
    };
    await cmdUpdate(f.manifestPath, f.options);
    assert.ok(f.calls.some(call => call[0] === "print" && call[1] === plan.service));
    assert.ok(f.calls.every(call => call[0] !== "bootstrap"), "disabled intent cannot allow a transient ingest");
    assert.equal(f.loaded.has(plan.service), false);
    assert.equal(f.reports.flat().find(row => row.kind === "whatsapp-drain")?.state, "moved");
  } finally { f.close(); }
  }
});

macTest("a disabled but still loaded job is refused before mutation", async () => {
  const f = fixture();
  try {
    const plan = buildWhatsappDrainSchedulerPlan(f.manifestPath, f.native);
    f.installFile(plan, renderLaunchAgentPlist(plan));
    f.disabled.add(plan.service);
    await assert.rejects(cmdUpdate(f.manifestPath, f.options), /COULD NOT MOVE/);
    assert.ok(f.calls.some(call => call[0] === "print-disabled"), "native enablement was inspected");
    assert.equal(f.upgrades(), 0);
    assert.ok(f.calls.every(call => ["print", "list", "print-disabled"].includes(call[0])));
  } finally { f.close(); }
});

macTest("a new owned job appearing after the snapshot blocks completion", async () => {
  const f = fixture();
  try {
    const originalUpgrade = f.options.cmdUpgrade;
    f.options.cmdUpgrade = async (...args) => {
      const result = await originalUpgrade(...args);
      curated(f, true);
      return result;
    };
    await assert.rejects(cmdUpdate(f.manifestPath, f.options), /COULD NOT MOVE/);
    assert.equal(f.upgrades(), 1, "race is injected after the initial inventory");
    assert.equal(f.finish.length, 0);
  } finally { f.close(); }
});

macTest("daemon ownership needs a manifest marker, with a bound daemon control", async () => {
  for (const bound of [false, true]) {
    const f = fixture();
    try {
      f.options.dailyRefreshOptions.whatsappDaemonOptions = { binaryPath: process.execPath };
      const plan = buildWhatsappDaemonPlan(f.manifestPath, { ...f.native, binaryPath: process.execPath });
      let text = renderDaemonPlist(plan);
      if (!bound) text = text.replace(/\s*<key>BRAIN_MANIFEST_PATH<\/key><string>[^<]*<\/string>/u, "");
      f.installFile(plan, text);
      let failure;
      try { await cmdUpdate(f.manifestPath, f.options); } catch (error) { failure = error; }
      if (bound) {
        assert.ifError(failure);
        assert.ok(f.calls.some(call => call[0] === "print" && call[1] === plan.service));
        assert.equal(f.reports.flat().find(row => row.kind === "whatsapp-daemon")?.state, "already current");
      } else {
        assert.match(failure?.message ?? "", /COULD NOT MOVE/);
        assert.ok(f.reports.flat().some(row => row.kind === "whatsapp-daemon"), "unbound job reached the ownership refusal");
        assert.ok(f.calls.every(call => ["print", "list", "print-disabled"].includes(call[0])));
        assert.equal(f.upgrades(), 0);
      }
    } finally { f.close(); }
  }
});

macTest("failed drain readback is nonzero, reports every repair, and a retry uses the receipt", async () => {
  const f = fixture();
  try {
    const old = buildWhatsappDrainSchedulerPlan(f.manifestPath, { ...f.native, brainPath: join(f.home, "old", "brain.mjs") });
    f.installFile(old, renderLaunchAgentPlist(old));
    curated(f, true);
    const nativeLaunch = f.native.launchctl;
    let fail = true;
    f.native.launchctl = args => {
      const result = nativeLaunch(args);
      if (fail && args[0] === "bootstrap" && args[2].endsWith("whatsapp-drain.plist")) {
        const active = f.loaded.get(old.service);
        f.loaded.set(old.service, { ...active, args: [...active.args, "foreign-argument"] });
      }
      return result;
    };
    await assert.rejects(cmdUpdate(f.manifestPath, f.options), /COULD NOT MOVE/);
    assert.equal(f.upgrades(), 1);
    assert.ok(f.calls.some(call => call[0] === "bootstrap"), "failure reached real scheduler registration");
    assert.equal(f.finish.length, 0);
    assert.equal(f.reports.flat().find(row => row.kind === "whatsapp-drain")?.state, "COULD NOT MOVE");
    assert.equal(f.reports.flat().find(row => row.kind === "curated-sync")?.state, "moved");
    const receiptPath = join(f.home, ".brain", "daily-update-transactions", "v1-0123456789abcdef.json");
    assert.equal(JSON.parse(readFileSync(receiptPath)).phase, "recovery_required");
    fail = false;
    // An attended native repair restores a provable definition before retry.
    const current = buildWhatsappDrainSchedulerPlan(f.manifestPath, f.native);
    f.loaded.set(old.service, { path: old.plistPath, args: current.programArguments });
    await cmdUpdate(f.manifestPath, f.options);
    assert.equal(f.finish.length, 1);
  } finally { f.close(); }
});

macTest("a recovered curated snapshot cannot move a different manifest's job", async () => {
  const f = fixture(), other = fixture();
  try {
    curated(f, false);
    const options = f.options.dailyRefreshOptions;
    const entries = await captureAdditionalUpdateSchedulers(f.m, f.manifestPath, options);
    assert.equal(entries.length, 1, "the plan ownership decision produced a real snapshot");
    await pauseAdditionalUpdateScheduler(f.m, f.manifestPath, entries[0], options);
    const mutations = () => f.calls.filter(call => !["print", "list", "print-disabled"].includes(call[0])).length;
    const before = mutations();
    const foreign = await reconcileAdditionalUpdateScheduler(other.m, other.manifestPath, entries[0], options);
    assert.equal(foreign.state, "COULD NOT MOVE");
    assert.equal(mutations(), before, "the refused recovery cannot mutate the other job");
    const control = await reconcileAdditionalUpdateScheduler(f.m, f.manifestPath, entries[0], options);
    assert.equal(control.state, "already current");
    assert.ok(mutations() > before, "the exact-manifest control reached reinstall");
  } finally { f.close(); other.close(); }
});

macTest("a loaded-only daily job blocks update, with an absent-job control", async () => {
  for (const loadedOnly of [true, false]) {
    const f = fixture();
    try {
      const identity = dailyRefreshIdentity(f.m, `uid:${uid}`);
      const label = `com.financialbrain.daily.${identity.id}`;
      const directory = join(f.home, "Library", "LaunchAgents");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (loadedOnly) f.loaded.set(`gui/${uid}/${label}`, { path: join(directory, `${label}.plist`), args: ["fixture"] });
      let failure;
      try { await cmdUpdate(f.manifestPath, f.options); } catch (error) { failure = error; }
      assert.ok(f.calls.some(call => call[0] === "list"), "both arms reached native inventory");
      if (loadedOnly) {
        assert.match(failure?.message ?? "", /COULD NOT MOVE/);
        assert.equal(f.upgrades(), 0);
      } else {
        assert.ifError(failure);
        assert.equal(f.upgrades(), 1);
      }
    } finally { f.close(); }
  }
});

macTest("final inventory cannot replace captured disabled intent with a concurrent native edit", async () => {
  for (const changed of [false, true]) {
    const f = fixture();
    try {
      const plan = buildWhatsappDrainSchedulerPlan(f.manifestPath, { ...f.native, brainPath: join(f.home, "old", "brain.mjs") });
      f.installFile(plan, renderLaunchAgentPlist(plan));
      f.loaded.delete(plan.service); f.disabled.add(plan.service);
      const nativeLaunch = f.native.launchctl;
      let inventories = 0;
      f.native.launchctl = args => {
        if (args[0] === "list" && ++inventories === 2 && changed) {
          f.disabled.delete(plan.service);
          const current = buildWhatsappDrainSchedulerPlan(f.manifestPath, f.native);
          f.loaded.set(plan.service, { path: plan.plistPath, args: current.programArguments });
        }
        return nativeLaunch(args);
      };
      let failure;
      try { await cmdUpdate(f.manifestPath, f.options); } catch (error) { failure = error; }
      assert.ok(inventories >= 2, "both arms reached final inventory");
      if (changed) {
        assert.match(failure?.message ?? "", /COULD NOT MOVE/);
        assert.equal(f.finish.length, 0);
      } else assert.ifError(failure);
    } finally { f.close(); }
  }
});

macTest("an installed daily job with imports off reports a moved runtime", async () => {
  const f = fixture();
  try {
    f.m.operations.daily_refresh = { enabled: false, timezone: "UTC" };
    writeFileSync(f.manifestPath, JSON.stringify(f.m), { mode: 0o600 });
    const plan = { identity: { id: "v1-0123456789abcdef", principal: `uid:${uid}` },
      manifest_path: f.manifestPath, platform: "darwin", enabled: false, ready: true, sources: [],
      cron: "0 9 * * *", timezone: "UTC", max_runtime_minutes: 45,
      manifest_path_hash: "sha256:path", manifest_content_hash: "sha256:content", source_plan_hash: "sha256:sources" };
    const old = buildDailyRefreshDefinition(plan, { platform: "darwin", nodePath: process.execPath,
      brainPath: join(f.home, "old", "brain.mjs"), runnerPath: join(f.home, "old", "daily-refresh-run.mjs") });
    let state = { exists: true, owned: true, enabled: false, definition: old };
    let installs = 0;
    f.options.dailyRefreshOptions.planDailyRefresh = async () => plan;
    f.options.dailyRefreshOptions.schedulerAdapter = {
      read: () => state,
      setEnabled: (_identity, enabled) => { state = { ...state, enabled }; },
      install: definition => { installs++; state = { exists: true, owned: true, enabled: false, definition }; },
    };
    await cmdUpdate(f.manifestPath, f.options);
    assert.equal(installs, 1, "the reviewed daily reconcile installed a new definition");
    assert.equal(state.enabled, false);
    assert.notEqual(state.definition.definition_hash, old.definition_hash);
    assert.equal(f.reports.flat().find(row => row.kind === "daily")?.state, "moved");
  } finally { f.close(); }
});
