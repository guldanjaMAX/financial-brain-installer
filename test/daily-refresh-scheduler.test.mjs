import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as dailySchedulerModule from "../operations/daily-refresh-scheduler.mjs";

import {
  buildDailyRefreshDefinition,
  createNativeDailyRefreshAdapter,
  installDailyRefreshSchedule,
  pauseDailyRefreshSchedule,
  parseWindowsTaskInventory,
  removeDailyRefreshSchedule,
  restoreDailyRefreshSchedule,
  runUpdateWithDailyRefreshPaused,
  statusDailyRefreshSchedule,
} from "../operations/daily-refresh-scheduler.mjs";
import { runDailyRefreshCli } from "../operations/daily-refresh-run.mjs";
import { cmdScheduleAllConfigured, dailyFreshnessRows } from "../brain.mjs";

const basePlan = Object.freeze({
  identity: { id: "v1-0123456789abcdef", principal: "uid:501" },
  manifest_path: "/fixtures/brain.manifest.json",
  manifest_path_hash: "sha256:path",
  manifest_content_hash: "sha256:content",
  source_plan_hash: "sha256:sources",
  cron: "0 9 * * *",
  timezone: "America/Phoenix",
  max_runtime_minutes: 45,
  enabled: true,
  ready: true,
  sources: [],
});

const DARWIN_DEFINITION_OPTIONS = Object.freeze({
  platform: "darwin",
  nodePath: "/fixture/runtime/node",
  brainPath: "/fixture/runtime/brain.mjs",
  runnerPath: "/fixture/runtime/daily-refresh-run.mjs",
});

const WINDOWS_DEFINITION_OPTIONS = Object.freeze({
  platform: "win32",
  nodePath: String.raw`C:\Fixture\Runtime\node.exe`,
  brainPath: String.raw`C:\Fixture\Runtime\brain.mjs`,
  runnerPath: String.raw`C:\Fixture\Runtime\daily-refresh-run.mjs`,
});

function memoryAdapter(initial = null) {
  let value = initial;
  const calls = [];
  return {
    calls,
    read(identity) { calls.push(["read", identity.id]); return value; },
    install(definition) { calls.push(["install", definition.identity.id]); value = { exists: true, owned: true, enabled: true, definition }; },
    setEnabled(identity, enabled) { calls.push(["setEnabled", identity.id, enabled]); value = { ...value, enabled }; },
    remove(identity) { calls.push(["remove", identity.id]); value = null; },
  };
}

for (const platform of ["darwin", "win32"]) {
  test(`${platform} definition binds one Brain, one user, and no secret`, () => {
    const definition = buildDailyRefreshDefinition(basePlan, {
      platform,
      nodePath: platform === "win32" ? String.raw`C:\Program Files\nodejs\node.exe` : "/usr/local/bin/node",
      brainPath: platform === "win32" ? String.raw`C:\FinancialBrain\brain.mjs` : "/opt/brain/brain.mjs",
      runnerPath: platform === "win32" ? String.raw`C:\FinancialBrain\operations\daily-refresh-run.mjs` : "/opt/brain/operations/daily-refresh-run.mjs",
    });
    assert.match(definition.name, /0123456789abcdef/);
    assert.match(definition.serialized, /daily-refresh-run\.mjs/);
    assert.doesNotMatch(definition.serialized, /admin.?key|api.?token|secret/i);
    assert.equal(definition.receipt.manifest_content_hash, "sha256:content");
    assert.equal(definition.receipt.source_plan_hash, "sha256:sources");
  });
}

test("daily definitions prefer the PATH launcher while keeping the real binary diagnostic-only", () => {
  const launcher = "/opt/homebrew/bin/node";
  const versioned = "/opt/homebrew/Cellar/node/25.6.1/bin/node";
  const replacement = "/opt/homebrew/Cellar/node/26.0.0/bin/node";
  const options = {
    platform: "darwin",
    execPath: versioned,
    pathValue: "/opt/homebrew/bin:/usr/bin:/bin",
    nodePathExists: (path) => path === launcher || path === versioned,
    nodeRealpath: (path) => path === launcher ? versioned : path,
    nodePathStat: () => ({ isFile: () => true }),
    nodePathAccess: () => {},
    brainPath: "/opt/brain/brain.mjs",
    runnerPath: "/opt/brain/operations/daily-refresh-run.mjs",
  };
  const definition = buildDailyRefreshDefinition(basePlan, options);
  assert.equal(definition.node_path, launcher, "the stable PATH launcher is the native execution path");
  assert.equal(definition.node_realpath, versioned, "the current binary is retained for diagnostics");
  assert.equal(definition.native_contract.arguments[0], launcher);

  const afterUpgrade = buildDailyRefreshDefinition(basePlan, {
    ...options,
    execPath: replacement,
    nodePathExists: (path) => path === launcher || path === replacement,
    nodeRealpath: (path) => path === launcher ? replacement : path,
  });
  assert.equal(afterUpgrade.node_realpath, replacement, "the diagnostic follows the replacement binary");
  assert.equal(afterUpgrade.definition_hash, definition.definition_hash,
    "a realpath-only Node upgrade cannot change the owned schedule contract");
  assert.equal(afterUpgrade.native_definition_hash, definition.native_definition_hash);
});

test("daily definitions retain a stable PATH shim whose realpath is not the launched binary", () => {
  const shim = "/home/owner/.volta/bin/node";
  const versioned = "/home/owner/.volta/tools/image/node/25.6.1/bin/node";
  const definition = buildDailyRefreshDefinition(basePlan, {
    platform: "darwin",
    execPath: versioned,
    pathValue: "/home/owner/.volta/bin:/usr/bin:/bin",
    nodePathExists: (path) => path === shim || path === versioned,
    nodeRealpath: (path) => path,
    nodePathStat: () => ({ isFile: () => true }),
    nodePathAccess: () => {},
    brainPath: "/opt/brain/brain.mjs",
    runnerPath: "/opt/brain/operations/daily-refresh-run.mjs",
  });
  assert.equal(definition.node_path, shim,
    "an executable PATH shim remains the stable native launcher");
  assert.equal(definition.node_realpath, shim,
    "the shim's own resolved path remains diagnostic-only");
});

test("daily launcher selection and status require a regular executable file", () => {
  const stable = "/opt/homebrew/bin/node";
  const shadow = "/shadow/bin/node";
  const directory = "/directory/bin/node";
  const versioned = "/opt/homebrew/Cellar/node/25.6.1/bin/node";
  const launcherOptions = ({ present, files, executable, pathValue }) => ({
    platform: "darwin",
    execPath: versioned,
    pathValue,
    nodePathExists: (path) => present.has(path),
    nodeRealpath: (path) => path,
    nodePathStat: (path) => ({ isFile: () => files.has(path) }),
    nodePathAccess: (path) => {
      if (!executable.has(path)) throw Object.assign(new Error("not executable"), { code: "EACCES" });
    },
    brainPath: "/opt/brain/brain.mjs",
    runnerPath: "/opt/brain/operations/daily-refresh-run.mjs",
  });
  const stableState = {
    present: new Set([stable, versioned]),
    files: new Set([stable, versioned]),
    executable: new Set([stable, versioned]),
  };

  const stableControl = buildDailyRefreshDefinition(basePlan, launcherOptions({
    ...stableState,
    pathValue: "/opt/homebrew/bin:/usr/bin",
  }));
  assert.equal(stableControl.node_path, stable, "the executable stable launcher is selected");

  const nonExecutableShadow = buildDailyRefreshDefinition(basePlan, launcherOptions({
    present: new Set([shadow, stable, versioned]),
    files: new Set([shadow, stable, versioned]),
    executable: new Set([stable, versioned]),
    pathValue: "/shadow/bin:/opt/homebrew/bin:/usr/bin",
  }));
  assert.equal(nonExecutableShadow.node_path, stable,
    "a non-executable PATH shadow cannot become the scheduled launcher");

  const directoryShadow = buildDailyRefreshDefinition(basePlan, launcherOptions({
    present: new Set([directory, stable, versioned]),
    files: new Set([stable, versioned]),
    executable: new Set([directory, stable, versioned]),
    pathValue: "/directory/bin:/opt/homebrew/bin:/usr/bin",
  }));
  assert.equal(directoryShadow.node_path, stable,
    "a directory named node cannot become the scheduled launcher");

  const absentShadow = buildDailyRefreshDefinition(basePlan, launcherOptions({
    ...stableState,
    pathValue: "/shadow/bin:/opt/homebrew/bin:/usr/bin",
  }));
  assert.equal(absentShadow.node_path, stable, "an absent first PATH entry remains a green control");

  const registered = buildDailyRefreshDefinition(basePlan, {
    platform: "darwin",
    nodePath: shadow,
    brainPath: "/opt/brain/brain.mjs",
    runnerPath: "/opt/brain/operations/daily-refresh-run.mjs",
  });
  const status = statusDailyRefreshSchedule(basePlan, {
    ...launcherOptions({
      present: new Set([shadow, stable, versioned]),
      files: new Set([shadow, stable, versioned]),
      executable: new Set([stable, versioned]),
      pathValue: "/opt/homebrew/bin:/usr/bin",
    }),
    adapter: memoryAdapter({ exists: true, owned: true, enabled: true, definition: registered }),
  });
  assert.equal(status.registered_node_present, true, "the registered shadow still exists");
  assert.equal(status.registered_node_usable, false,
    "status reaches the executable decision instead of treating existence as runnable");
  assert.match(status.attention, /not executable/i);
  const [freshness] = dailyFreshnessRows({
    ...basePlan,
    sources: [{
      key: "google_drive", class: "machine-pull", owner: "daily-task", status: "ready",
      run_key: "google_drive", source_names: ["drive"],
    }],
  }, { sources: [] }, status);
  assert.equal(freshness.owner, "none",
    "an existing but unusable launcher cannot advertise a runnable daily owner");
  assert.equal(freshness.next_run, "not scheduled");
});

test("Node-only schedule drift stays runnable in owner freshness while requesting refresh", () => {
  const source = {
    key: "google_drive", class: "machine-pull", owner: "daily-task", status: "ready",
    run_key: "google_drive", source_names: ["drive"],
  };
  const plan = { ...basePlan, sources: [source] };
  const registered = buildDailyRefreshDefinition(plan, {
    platform: "darwin",
    nodePath: "/old/runtime/node",
    brainPath: "/runtime/brain.mjs",
    runnerPath: "/runtime/daily-refresh-run.mjs",
  });
  const schedule = statusDailyRefreshSchedule(plan, {
    platform: "darwin",
    adapter: memoryAdapter({ exists: true, owned: true, enabled: true, definition: registered }),
    nodePath: "/current/runtime/node",
    brainPath: registered.brain_path,
    runnerPath: registered.runner_path,
    nodePathExists: () => true,
    nodeRealpath: (path) => path,
    nodePathStat: () => ({ isFile: () => true }),
    nodePathAccess: () => {},
  });
  assert.equal(schedule.plan_matches_registered_definition, true);
  assert.equal(schedule.node_path_changed, true);
  assert.equal(schedule.attention, "daily schedule needs refresh (Node changed)");
  const [row] = dailyFreshnessRows(plan, { sources: [] }, schedule);
  assert.equal(row.owner, "daily-task",
    "the runnable Node-only drift retains the daily owner in freshness");
  assert.equal(row.next_run, "0 9 * * * America/Phoenix");
});

test("install refuses a foreign collision and exact readback failure", () => {
  const foreign = memoryAdapter({ exists: true, owned: false, enabled: true, definition: { name: "foreign" } });
  assert.throws(
    () => installDailyRefreshSchedule(basePlan, { ...DARWIN_DEFINITION_OPTIONS, adapter: foreign }),
    /foreign schedule/i,
  );
  assert.deepEqual(foreign.calls, [["read", basePlan.identity.id]], "collision decision was reached before mutation");

  const priorDefinition = buildDailyRefreshDefinition(
    { ...basePlan, source_plan_hash: "sha256:prior" },
    WINDOWS_DEFINITION_OPTIONS,
  );
  const drift = memoryAdapter({ exists: true, owned: true, enabled: false, definition: priorDefinition });
  drift._changed = priorDefinition;
  drift._enabled = false;
  let installCalls = 0;
  drift.install = function install(definition) {
    this.calls.push(["install", definition.identity.id]);
    installCalls += 1;
    this._changed = installCalls === 1
      ? { ...definition, definition_hash: "sha256:changed" }
      : definition;
    this._enabled = true;
  };
  drift.read = function read(identity) {
    this.calls.push(["read", identity.id]);
    return this._changed ? { exists: true, owned: true, enabled: this._enabled, definition: this._changed } : null;
  };
  drift.setEnabled = function setEnabled(identity, enabled) {
    this.calls.push(["setEnabled", identity.id, enabled]);
    this._enabled = enabled;
  };
  assert.throws(
    () => installDailyRefreshSchedule(basePlan, { ...WINDOWS_DEFINITION_OPTIONS, adapter: drift }),
    /exact readback/i,
  );
  assert.ok(drift.calls.some(([name]) => name === "install"), "readback refusal is not vacuous");
  assert.equal(drift.read(basePlan.identity).definition.definition_hash, priorDefinition.definition_hash,
    "the prior owned definition was restored after failed readback");
  assert.equal(drift.read(basePlan.identity).enabled, false, "the prior disabled state was restored exactly");

  const clean = memoryAdapter();
  const installed = installDailyRefreshSchedule(basePlan, { ...WINDOWS_DEFINITION_OPTIONS, adapter: clean });
  assert.equal(installed.verified, true, "green control installs and reads back exactly");
});

test("native Windows readback verifies execution fields and distinguishes query failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "daily-native-win-"));
  const definition = buildDailyRefreshDefinition(basePlan, {
    platform: "win32",
    nodePath: String.raw`C:\Runtime\node.exe`,
    brainPath: String.raw`C:\Runtime\brain.mjs`,
    runnerPath: String.raw`C:\Runtime\daily-refresh-run.mjs`,
  });
  let queryCalls = 0;
  let response = { status: 0, stdout: definition.serialized };
  const adapter = createNativeDailyRefreshAdapter({
    platform: "win32",
    home: directory,
    spawn: (_command, args) => {
      assert.equal(args[0], "/Query");
      queryCalls += 1;
      return response;
    },
  });
  const exact = statusDailyRefreshSchedule(basePlan, {
    platform: "win32", adapter,
    nodePath: definition.node_path, brainPath: definition.brain_path, runnerPath: definition.runner_path,
  });
  assert.equal(exact.verified, true, "the exact native definition is the green control");

  response = { status: 0, stdout: definition.serialized.replace(definition.node_path, String.raw`C:\Foreign\node.exe`) };
  assert.equal(statusDailyRefreshSchedule(basePlan, {
    platform: "win32", adapter,
    nodePath: definition.node_path, brainPath: definition.brain_path, runnerPath: definition.runner_path,
  }).verified, false, "a changed action is not authorized by an unchanged comment marker");

  response = {
    status: 0,
    stdout: definition.serialized.replace(
      "</Actions>",
      "<Exec><Command>C:\\Foreign\\extra.exe</Command><Arguments>extra</Arguments></Exec></Actions>",
    ),
  };
  assert.equal(statusDailyRefreshSchedule(basePlan, {
    platform: "win32", adapter,
    nodePath: definition.node_path, brainPath: definition.brain_path, runnerPath: definition.runner_path,
  }).verified, false, "an extra native action is execution drift, even when the first action and marker match");

  response = {
    status: 0,
    stdout: definition.serialized.replace("</Triggers>", "<LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>"),
  };
  assert.equal(statusDailyRefreshSchedule(basePlan, {
    platform: "win32", adapter,
    nodePath: definition.node_path, brainPath: definition.brain_path, runnerPath: definition.runner_path,
  }).verified, false, "an additional trigger is rejected instead of being projected away");

  response = { status: 5, stdout: "", stderr: "access denied" };
  assert.throws(
    () => statusDailyRefreshSchedule(basePlan, { platform: "win32", adapter }),
    /could not be inspected/i,
  );
  assert.equal(queryCalls, 6, "the failure arm also reached the locale-independent inventory check");
});

test("native Windows absence requires a successful complete task inventory", () => {
  const directory = mkdtempSync(join(tmpdir(), "daily-native-absence-"));
  let calls = 0;
  const adapter = createNativeDailyRefreshAdapter({
    platform: "win32",
    home: directory,
    spawn: (_command, args) => {
      calls += 1;
      if (args.includes("/FO")) return { status: 0, stdout: `"\\Other Folder\\Other Task","N/A","Ready"\r\n` };
      return { status: 1, stdout: "", stderr: "localized native error" };
    },
  });
  const status = statusDailyRefreshSchedule(basePlan, { platform: "win32", adapter });
  assert.equal(status.installed, false);
  assert.equal(status.verified, true);
  assert.equal(calls, 2, "absence was proved by a successful inventory after the targeted query failed");

  let malformedCalls = 0;
  const malformed = createNativeDailyRefreshAdapter({
    platform: "win32",
    home: directory,
    spawn: (_command, args) => {
      malformedCalls += 1;
      return args.includes("/FO")
        ? { status: 0, stdout: "MALFORMED INVENTORY" }
        : { status: 1, stdout: "", stderr: "localized native error" };
    },
  });
  assert.throws(
    () => statusDailyRefreshSchedule(basePlan, { platform: "win32", adapter: malformed }),
    /could not be inspected/i,
  );
  assert.equal(malformedCalls, 2, "malformed inventory reached the ambiguity decision and never proved absence");
});

test("Windows task inventory accepts complete localized rows with empty status fields", () => {
  const inventory = [
    "\ufeff\"TaskName\",\"Next Run Time\",\"Status\"",
    "   ",
    String.raw`"\Other Folder\Quoted ""Task""","","N/A"`,
    String.raw`"\Other Folder\Empty State","N/A",""`,
    "",
  ].join("\r\n");
  assert.deepEqual(parseWindowsTaskInventory(inventory), [
    "TaskName",
    String.raw`\Other Folder\Quoted "Task"`,
    String.raw`\Other Folder\Empty State`,
  ]);
  assert.deepEqual(
    parseWindowsTaskInventory(String.raw`"\Other Folder\Trailing CR","N/A","Ready"` + "\r"),
    [String.raw`\Other Folder\Trailing CR`],
  );
});

test("native Windows scheduler resolves schtasks from SystemRoot without PATH", () => {
  const directory = mkdtempSync(join(tmpdir(), "daily-native-system-tool-"));
  const commands = [];
  const adapter = createNativeDailyRefreshAdapter({
    platform: "win32",
    home: directory,
    environment: { SystemRoot: String.raw`C:\Windows`, WINDIR: String.raw`C:\Windows` },
    spawn: (command, args) => {
      commands.push({ command, args });
      return args.includes("/FO")
        ? { status: 0, stdout: String.raw`"\Other\Task","N/A","Ready"` }
        : { status: 1, stdout: "", stderr: "localized native error" };
    },
  });
  const status = statusDailyRefreshSchedule(basePlan, { platform: "win32", adapter });
  assert.equal(status.installed, false, "the green control proves the absence decision was reached");
  assert.equal(commands.length, 2);
  assert.ok(commands.every(({ command }) => command === String.raw`C:\Windows\System32\schtasks.exe`));
});

test("macOS native readback compares the loaded program to the plist", () => {
  const home = mkdtempSync(join(tmpdir(), "daily-native-mac-readback-"));
  const definition = buildDailyRefreshDefinition(basePlan, {
    platform: "darwin", nodePath: "/runtime/node", brainPath: "/runtime/brain.mjs",
    runnerPath: "/runtime/operations/daily-refresh-run.mjs",
  });
  const plist = join(home, "Library", "LaunchAgents", `com.financialbrain.daily.${basePlan.identity.id}.plist`);
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plist, definition.serialized);
  let program = definition.node_path;
  let printCalls = 0;
  const adapter = createNativeDailyRefreshAdapter({
    platform: "darwin", home, uid: 501,
    spawn: (_command, args) => {
      if (args[0] === "print") {
        printCalls += 1;
        return {
          status: 0,
          stdout: `program = ${program}\narguments = {\n${definition.native_contract.arguments.join("\n")}\n}\n`,
        };
      }
      if (args[0] === "print-disabled") return { status: 0, stdout: "" };
      return { status: 0, stdout: "" };
    },
  });
  const options = {
    platform: "darwin", adapter, nodePath: definition.node_path,
    brainPath: definition.brain_path, runnerPath: definition.runner_path,
  };
  assert.equal(statusDailyRefreshSchedule(basePlan, options).verified, true, "the loaded-program control verifies");
  program = "/foreign/node";
  assert.equal(statusDailyRefreshSchedule(basePlan, options).verified, false,
    "a foreign loaded program cannot borrow the exact plist and ownership marker");
  assert.equal(printCalls, 2, "both loaded-service decision points were inspected");
});

test("native removal refuses a replacement that appears at its mutation boundary", () => {
  const directory = mkdtempSync(join(tmpdir(), "daily-native-race-"));
  const definition = buildDailyRefreshDefinition(basePlan, {
    platform: "win32",
    nodePath: String.raw`C:\Runtime\node.exe`,
    brainPath: String.raw`C:\Runtime\brain.mjs`,
    runnerPath: String.raw`C:\Runtime\daily-refresh-run.mjs`,
  });
  let queries = 0;
  let deletes = 0;
  const adapter = createNativeDailyRefreshAdapter({
    platform: "win32",
    home: directory,
    spawn: (_command, args) => {
      if (args[0] === "/Query") {
        queries += 1;
        return { status: 0, stdout: queries === 1 ? definition.serialized : "<Task><RegistrationInfo><Description>foreign</Description></RegistrationInfo></Task>" };
      }
      deletes += 1;
      return { status: 0 };
    },
  });
  assert.throws(
    () => removeDailyRefreshSchedule(basePlan, {
      platform: "win32", adapter,
      nodePath: definition.node_path, brainPath: definition.brain_path, runnerPath: definition.runner_path,
    }),
    /changed before removal|foreign schedule/i,
  );
  assert.equal(queries, 2, "ownership was re-read at the mutation boundary");
  assert.equal(deletes, 0, "the replacement was never deleted");
});

test("native removal preserves a foreign replacement injected after the prior ownership read", () => {
  const definition = buildDailyRefreshDefinition(basePlan, {
    platform: "win32",
    nodePath: String.raw`C:\Runtime\node.exe`,
    brainPath: String.raw`C:\Runtime\brain.mjs`,
    runnerPath: String.raw`C:\Runtime\daily-refresh-run.mjs`,
  });
  for (const arm of ["owned", "early-foreign", "late-foreign"]) {
    const home = mkdtempSync(join(tmpdir(), `daily-native-late-race-${arm}-`));
    let native = definition.serialized;
    let queries = 0;
    let deletes = 0;
    let deletedForeign = false;
    const adapter = createNativeDailyRefreshAdapter({
      platform: "win32",
      home,
      spawn: (_command, args) => {
        if (args.includes("/FO")) return { status: 0, stdout: '"\\Other\\Task","N/A","Ready"\r\n' };
        if (args[0] === "/Query") {
          queries += 1;
          if (queries === 2 && arm === "early-foreign") native = "<Task>foreign</Task>";
          const observed = native;
          if (queries === 2 && arm === "late-foreign") native = "<Task>foreign</Task>";
          return observed === null ? { status: 1 } : { status: 0, stdout: observed };
        }
        assert.equal(args[0], "/Delete");
        assert.ok(args.includes("/F"));
        deletes += 1;
        deletedForeign = native === "<Task>foreign</Task>";
        native = null;
        return { status: 0 };
      },
    });
    const action = () => removeDailyRefreshSchedule(basePlan, {
      platform: "win32",
      adapter,
      nodePath: definition.node_path,
      brainPath: definition.brain_path,
      runnerPath: definition.runner_path,
    });
    if (arm === "owned") {
      assert.equal(action().verified, true, "the unchanged owned task is the green control");
      assert.equal(deletes, 1);
      assert.equal(deletedForeign, false);
    } else {
      assert.throws(action, /foreign schedule|changed before removal/);
      assert.equal(deletes, 0, `${arm} replacement was not deleted`);
    }
    assert.ok(queries >= 2, `${arm} reached the native ownership decision`);
  }
});

test("native pause preserves a foreign replacement injected after the prior ownership read", () => {
  const home = mkdtempSync(join(tmpdir(), "daily-native-late-pause-"));
  const definition = buildDailyRefreshDefinition(basePlan, {
    platform: "win32",
    nodePath: String.raw`C:\Runtime\node.exe`,
    brainPath: String.raw`C:\Runtime\brain.mjs`,
    runnerPath: String.raw`C:\Runtime\daily-refresh-run.mjs`,
  });
  let native = definition.serialized;
  let queries = 0;
  let changes = 0;
  let changedForeign = false;
  const adapter = createNativeDailyRefreshAdapter({
    platform: "win32",
    home,
    spawn: (_command, args) => {
      if (args[0] === "/Query") {
        queries += 1;
        const observed = native;
        if (queries === 2) native = "<Task>foreign</Task>";
        return { status: 0, stdout: observed };
      }
      assert.equal(args[0], "/Change");
      changes += 1;
      changedForeign = native === "<Task>foreign</Task>";
      return { status: 0 };
    },
  });
  assert.throws(() => pauseDailyRefreshSchedule(basePlan, {
    platform: "win32",
    adapter,
    nodePath: definition.node_path,
    brainPath: definition.brain_path,
    runnerPath: definition.runner_path,
  }), /foreign schedule|changed before/);
  assert.ok(queries >= 2, "pause reached the native ownership decision");
  assert.equal(changes, 0);
  assert.equal(changedForeign, false);
});

test("native replacement preserves a foreign replacement injected after the prior ownership read", () => {
  const home = mkdtempSync(join(tmpdir(), "daily-native-late-replace-"));
  const priorPlan = { ...basePlan, source_plan_hash: "sha256:prior" };
  const options = {
    platform: "win32",
    nodePath: String.raw`C:\Runtime\node.exe`,
    brainPath: String.raw`C:\Runtime\brain.mjs`,
    runnerPath: String.raw`C:\Runtime\daily-refresh-run.mjs`,
  };
  const prior = buildDailyRefreshDefinition(priorPlan, options);
  let native = prior.serialized;
  let queries = 0;
  let creates = 0;
  let replacedForeign = false;
  const adapter = createNativeDailyRefreshAdapter({
    platform: "win32",
    home,
    spawn: (_command, args) => {
      if (args[0] === "/Query") {
        queries += 1;
        const observed = native;
        if (queries === 2) native = "<Task>foreign</Task>";
        return { status: 0, stdout: observed };
      }
      assert.equal(args[0], "/Create");
      creates += 1;
      replacedForeign = native === "<Task>foreign</Task>";
      return { status: 0 };
    },
  });
  assert.throws(() => installDailyRefreshSchedule(basePlan, { ...options, adapter }), /foreign schedule|changed before/);
  assert.ok(queries >= 2, "replacement reached the native ownership decision");
  assert.equal(creates, 0);
  assert.equal(replacedForeign, false);
});

test("native Windows mutations keep the final ownership read adjacent to the mutation", () => {
  const options = {
    platform: "win32",
    nodePath: String.raw`C:\Runtime\node.exe`,
    brainPath: String.raw`C:\Runtime\brain.mjs`,
    runnerPath: String.raw`C:\Runtime\daily-refresh-run.mjs`,
  };
  const desired = buildDailyRefreshDefinition(basePlan, options);
  const prior = buildDailyRefreshDefinition({
    ...basePlan,
    source_plan_hash: "sha256:prior-sequence",
  }, options);
  const assertAdjacent = (calls, mutation) => {
    const commands = calls.map((args) => args[0]);
    const mutationIndex = commands.lastIndexOf(mutation);
    assert.ok(mutationIndex > 0, `${mutation} reached its native decision point`);
    assert.equal(commands[mutationIndex - 1], "/Query",
      `${mutation} has no native call between the final owned-definition read and mutation`);
  };

  const mutationTrace = [["/Query"], ["/Query"], ["/FO"], ["/Delete"]];
  assert.throws(
    () => assertAdjacent(mutationTrace, "/Delete"),
    /no native call between/,
    "the assertion turns red when any native call is inserted at the boundary",
  );

  {
    const home = mkdtempSync(join(tmpdir(), "daily-native-replace-sequence-"));
    let serialized = prior.serialized;
    const calls = [];
    const adapter = createNativeDailyRefreshAdapter({
      platform: "win32", home,
      spawn: (_command, args) => {
        calls.push([...args]);
        if (args[0] === "/Query") return { status: 0, stdout: serialized };
        assert.equal(args[0], "/Create");
        serialized = desired.serialized;
        return { status: 0 };
      },
    });
    const expected = adapter.read(basePlan.identity);
    adapter.install(desired, { replaceOwned: true, expected });
    assert.deepEqual(calls.slice(-3).map((args) => args[0]), ["/Query", "/Query", "/Create"]);
    assert.ok(calls.at(-1).includes("/F"), "owned replacement uses the explicit replace switch");
    assertAdjacent(calls, "/Create");
  }

  {
    const home = mkdtempSync(join(tmpdir(), "daily-native-enable-sequence-"));
    let serialized = desired.serialized;
    const calls = [];
    const adapter = createNativeDailyRefreshAdapter({
      platform: "win32", home,
      spawn: (_command, args) => {
        calls.push([...args]);
        if (args[0] === "/Query") return { status: 0, stdout: serialized };
        assert.equal(args[0], "/Change");
        serialized = serialized.replace(
          "<AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled>",
          "<AllowStartOnDemand>true</AllowStartOnDemand><Enabled>false</Enabled>",
        );
        return { status: 0 };
      },
    });
    adapter.setEnabled(basePlan.identity, false);
    assert.deepEqual(calls.map((args) => args[0]), ["/Query", "/Query", "/Change"]);
    assertAdjacent(calls, "/Change");
  }

  {
    const home = mkdtempSync(join(tmpdir(), "daily-native-remove-sequence-"));
    let serialized = desired.serialized;
    const calls = [];
    const adapter = createNativeDailyRefreshAdapter({
      platform: "win32", home,
      spawn: (_command, args) => {
        calls.push([...args]);
        if (args[0] === "/Query") return { status: 0, stdout: serialized };
        assert.equal(args[0], "/Delete");
        serialized = null;
        return { status: 0 };
      },
    });
    const expected = adapter.read(basePlan.identity);
    adapter.remove(basePlan.identity, { expected });
    assert.deepEqual(calls.slice(-3).map((args) => args[0]), ["/Query", "/Query", "/Delete"]);
    assertAdjacent(calls, "/Delete");
  }

  {
    const home = mkdtempSync(join(tmpdir(), "daily-native-create-sequence-"));
    let serialized = null;
    const calls = [];
    const adapter = createNativeDailyRefreshAdapter({
      platform: "win32", home,
      spawn: (_command, args) => {
        calls.push([...args]);
        if (args[0] === "/Query" && args.includes("/FO")) {
          return { status: 0, stdout: '"\\Other\\Task","N/A","Ready"' };
        }
        if (args[0] === "/Query") return { status: 1, stdout: "" };
        assert.equal(args[0], "/Create");
        serialized = desired.serialized;
        return { status: 0 };
      },
    });
    adapter.install(desired, { replaceOwned: false, expected: null });
    assert.ok(serialized, "the green control reached native create");
    assert.equal(calls.at(-1)[0], "/Create");
    assert.equal(calls.at(-1).includes("/F"), false,
      "create-if-absent lets Task Scheduler refuse a foreign arrival");
  }
});

test("native Windows absence rejects incomplete quoted inventory rows", () => {
  const directory = mkdtempSync(join(tmpdir(), "daily-native-incomplete-inventory-"));
  for (const [inventory, shouldRefuse] of [
    ["MALFORMED INVENTORY", true],
    ['"\\Other\\Task",', true],
    ['"\\Other\\Task"', true],
    ['"\\Other\\Task","N/A","Ready",', true],
    ['"\\Other\\Task","",""', false],
    ['"\\Other\\Task","N/A","Ready"', false],
  ]) {
    let calls = 0;
    const adapter = createNativeDailyRefreshAdapter({
      platform: "win32",
      home: directory,
      spawn: (_command, args) => {
        calls += 1;
        return args.includes("/FO")
          ? { status: 0, stdout: inventory }
          : { status: 1, stdout: "", stderr: "localized native error" };
      },
    });
    const action = () => statusDailyRefreshSchedule(basePlan, { platform: "win32", adapter });
    if (shouldRefuse) {
      assert.throws(action, /could not be inspected/);
    } else {
      const status = action();
      assert.equal(status.installed, false, "a complete absent row is the green control");
      assert.equal(status.verified, true);
    }
    assert.equal(calls, 2, "each arm reached both native inspection decisions");
  }
});

test("native Windows disabled state keeps the immutable execution authorization", () => {
  const home = mkdtempSync(join(tmpdir(), "daily-native-disabled-authorization-"));
  const definition = buildDailyRefreshDefinition(basePlan, {
    platform: "win32",
    nodePath: String.raw`C:\Runtime\node.exe`,
    brainPath: String.raw`C:\Runtime\brain.mjs`,
    runnerPath: String.raw`C:\Runtime\daily-refresh-run.mjs`,
  });
  let serialized = definition.serialized;
  let disables = 0;
  let enables = 0;
  let reads = 0;
  const adapter = createNativeDailyRefreshAdapter({
    platform: "win32",
    home,
    spawn: (_command, args) => {
      if (args[0] === "/Query") {
        reads += 1;
        return { status: 0, stdout: serialized };
      }
      assert.equal(args[0], "/Change");
      if (args.includes("/DISABLE")) {
        disables += 1;
        serialized = serialized.replace(
          "<AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled>",
          "<AllowStartOnDemand>true</AllowStartOnDemand><Enabled>false</Enabled>",
        );
      } else {
        enables += 1;
        serialized = serialized.replace(
          "<AllowStartOnDemand>true</AllowStartOnDemand><Enabled>false</Enabled>",
          "<AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled>",
        );
      }
      return { status: 0 };
    },
  });
  const options = {
    platform: "win32",
    adapter,
    nodePath: definition.node_path,
    brainPath: definition.brain_path,
    runnerPath: definition.runner_path,
  };
  const snapshot = pauseDailyRefreshSchedule(basePlan, options);
  assert.equal(disables, 1, "the first pause reached the native disable decision");
  assert.equal(statusDailyRefreshSchedule(basePlan, options).verified, true,
    "mutable disabled state does not invalidate the execution definition");
  const repeated = pauseDailyRefreshSchedule(basePlan, { ...options, authorizedDefinition: snapshot.definition });
  assert.equal(repeated.enabled, false, "restart recovery observes the already-paused state");
  assert.equal(disables, 1, "restart recovery does not disable twice");
  assert.equal(restoreDailyRefreshSchedule(snapshot, { adapter }).verified, true);
  assert.equal(enables, 1, "the enabled snapshot is restored by the green control");
  assert.ok(reads >= 6, "pause, restart, and restore all reached native readback");
});

test("native task mutations serialize the ownership read and mutation boundary", () => {
  const home = mkdtempSync(join(tmpdir(), "daily-native-serialize-"));
  const definition = buildDailyRefreshDefinition(basePlan, {
    platform: "win32",
    nodePath: String.raw`C:\Runtime\node.exe`,
    brainPath: String.raw`C:\Runtime\brain.mjs`,
    runnerPath: String.raw`C:\Runtime\daily-refresh-run.mjs`,
  });
  let adapter;
  let gone = false;
  let deletes = 0;
  let concurrentRefusals = 0;
  const spawn = (_command, args) => {
    if (args.includes("/FO")) return { status: 0, stdout: `"\\Other\\Task","N/A","Ready"\n` };
    if (args[0] === "/Query") return gone ? { status: 1, stdout: "" } : { status: 0, stdout: definition.serialized };
    if (args[0] === "/Delete") {
      deletes += 1;
      assert.throws(
        () => adapter.remove(basePlan.identity, { expected: { exists: true, owned: true, enabled: true, definition } }),
        /already being changed/i,
      );
      concurrentRefusals += 1;
      gone = true;
      return { status: 0, stdout: "" };
    }
    assert.fail(`unexpected native operation ${args[0]}`);
  };
  adapter = createNativeDailyRefreshAdapter({ platform: "win32", home, spawn });
  const result = removeDailyRefreshSchedule(basePlan, {
    platform: "win32", adapter,
    nodePath: definition.node_path, brainPath: definition.brain_path, runnerPath: definition.runner_path,
  });
  assert.equal(result.verified, true);
  assert.equal(deletes, 1);
  assert.equal(concurrentRefusals, 1, "the competing product mutation reached and lost the serialization boundary");
});

test("macOS pause persists disabled state across a simulated new login", () => {
  const home = mkdtempSync(join(tmpdir(), "daily-native-mac-"));
  const definition = buildDailyRefreshDefinition(basePlan, {
    platform: "darwin", nodePath: "/runtime/node", brainPath: "/runtime/brain.mjs",
    runnerPath: "/runtime/operations/daily-refresh-run.mjs",
  });
  const plist = join(home, "Library", "LaunchAgents", `com.financialbrain.daily.${basePlan.identity.id}.plist`);
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plist, definition.serialized);
  let loaded = true;
  let disabled = false;
  const calls = [];
  const spawn = (_command, args) => {
    calls.push(args[0]);
    if (args[0] === "print") return { status: loaded ? 0 : 113, stderr: loaded ? "" : "Could not find service" };
    if (args[0] === "print-disabled") {
      return { status: 0, stdout: disabled ? `\"com.financialbrain.daily.${basePlan.identity.id}\" => true` : "" };
    }
    if (args[0] === "bootout") loaded = false;
    if (args[0] === "disable") disabled = true;
    if (args[0] === "enable") disabled = false;
    if (args[0] === "bootstrap") loaded = true;
    return { status: 0 };
  };
  const adapter = createNativeDailyRefreshAdapter({ platform: "darwin", home, uid: 501, spawn });
  adapter.setEnabled(basePlan.identity, false);
  assert.equal(adapter.read(basePlan.identity).enabled, false);
  assert.ok(calls.includes("disable"), "pause reached launchd's persistent disable decision");

  loaded = false;
  const afterLogin = createNativeDailyRefreshAdapter({ platform: "darwin", home, uid: 501, spawn });
  assert.equal(afterLogin.read(basePlan.identity).enabled, false, "a new login cannot reload the disabled service");
  afterLogin.setEnabled(basePlan.identity, true);
  assert.equal(afterLogin.read(basePlan.identity).enabled, true, "verified restore is the green control");
});

test("update recovery state is durable, private, and readable after restart", () => {
  const home = mkdtempSync(join(tmpdir(), "daily-update-transaction-"));
  const otherHome = join(home, "other-home");
  const machineLockRoot = join(home, "machine-locks");
  const manifestPath = join(home, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    client: { slug: "fixture" },
    infrastructure: { cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-database" } },
  }));
  const transactionPlan = { ...basePlan, manifest_path: manifestPath };
  assert.equal(typeof dailySchedulerModule.writeDailyRefreshUpdateTransaction, "function");
  assert.equal(typeof dailySchedulerModule.readDailyRefreshUpdateTransaction, "function");
  assert.equal(typeof dailySchedulerModule.clearDailyRefreshUpdateTransaction, "function");
  const definition = buildDailyRefreshDefinition(basePlan, {
    platform: "darwin", nodePath: "/runtime/node", brainPath: "/runtime/brain.mjs",
    runnerPath: "/runtime/operations/daily-refresh-run.mjs",
  });
  const transaction = dailySchedulerModule.writeDailyRefreshUpdateTransaction({
    plan: transactionPlan,
    snapshot: { exists: true, enabled: true, identity: basePlan.identity, definition },
    phase: "recovery_required",
    legacySnapshots: [{
      kind: "drive", sourceKey: "google_drive", module: { should_not_serialize: true },
      snapshot: { exists: true, wasLoaded: true, serialized: "fixture plist" },
    }],
  }, { home, machineLockRoot, now: () => new Date("2026-10-06T18:00:00.000Z") });
  assert.equal(transaction.phase, "recovery_required");
  const afterRestart = dailySchedulerModule.readDailyRefreshUpdateTransaction(basePlan.identity, {
    home, machineLockRoot, manifestPath,
  });
  assert.equal(afterRestart.snapshot.enabled, true);
  assert.equal(afterRestart.snapshot.definition.definition_hash, definition.definition_hash);
  assert.equal(afterRestart.legacy_snapshots[0].snapshot.wasLoaded, true);
  assert.equal(Object.hasOwn(afterRestart.legacy_snapshots[0], "module"), false,
    "durable recovery carries legacy state without serializing executable dependencies");
  assert.doesNotMatch(JSON.stringify(afterRestart), /admin.?key|api.?token|secret/i);
  const crossUser = dailySchedulerModule.readDailyRefreshUpdateTransaction(basePlan.identity, {
    home: otherHome, machineLockRoot, manifestPath,
  });
  assert.equal(crossUser.shared_fence, true, "another user sees the canonical Brain recovery fence without the private snapshot");
  assert.equal(dailySchedulerModule.clearDailyRefreshUpdateTransaction(basePlan.identity, {
    home, machineLockRoot, manifestPath,
  }), true);
  assert.equal(dailySchedulerModule.readDailyRefreshUpdateTransaction(basePlan.identity, {
    home, machineLockRoot, manifestPath,
  }), null);
});

test("module URL defaults decode spaces before building a native definition", () => {
  const definition = buildDailyRefreshDefinition(basePlan, {
    platform: "win32",
    nodePath: String.raw`C:\Runtime\node.exe`,
    brainUrl: new URL("file:///C:/Program%20Files/Financial%20Brain/brain.mjs"),
    runnerUrl: new URL("file:///C:/Program%20Files/Financial%20Brain/operations/daily-refresh-run.mjs"),
  });
  assert.equal(definition.brain_path, String.raw`C:\Program Files\Financial Brain\brain.mjs`);
  assert.equal(definition.runner_path, String.raw`C:\Program Files\Financial Brain\operations\daily-refresh-run.mjs`);
  assert.doesNotMatch(definition.serialized, /%20/);
});

test("pause, restore, status, and remove operate only on the owned identity", () => {
  const adapter = memoryAdapter();
  installDailyRefreshSchedule(basePlan, { ...DARWIN_DEFINITION_OPTIONS, adapter });
  const snapshot = pauseDailyRefreshSchedule(basePlan, { ...DARWIN_DEFINITION_OPTIONS, adapter });
  assert.equal(snapshot.enabled, true);
  assert.equal(statusDailyRefreshSchedule(basePlan, { ...DARWIN_DEFINITION_OPTIONS, adapter }).enabled, false);
  restoreDailyRefreshSchedule(snapshot, { adapter });
  assert.equal(statusDailyRefreshSchedule(basePlan, { ...DARWIN_DEFINITION_OPTIONS, adapter }).enabled, true);
  removeDailyRefreshSchedule(basePlan, { ...DARWIN_DEFINITION_OPTIONS, adapter });
  assert.equal(statusDailyRefreshSchedule(basePlan, { ...DARWIN_DEFINITION_OPTIONS, adapter }).installed, false);
});

test("restoring a definition that was already paused is an exact no-op", () => {
  const definition = buildDailyRefreshDefinition(basePlan, DARWIN_DEFINITION_OPTIONS);
  const adapter = memoryAdapter({ exists: true, owned: true, enabled: false, definition });
  const snapshot = pauseDailyRefreshSchedule(basePlan, { ...DARWIN_DEFINITION_OPTIONS, adapter });
  const beforeRestoreMutations = adapter.calls.filter(([name]) => name === "setEnabled").length;
  const restored = restoreDailyRefreshSchedule(snapshot, { adapter });
  const afterRestoreMutations = adapter.calls.filter(([name]) => name === "setEnabled").length;
  assert.equal(snapshot.enabled, false, "the pause decision observed the already-disabled control state");
  assert.equal(restored.verified, true);
  assert.equal(afterRestoreMutations, beforeRestoreMutations, "restore did not mutate an already-matching disabled definition");
});

test("manifest source-plan drift is visible without overwriting the owned task", () => {
  const adapter = memoryAdapter();
  installDailyRefreshSchedule(basePlan, { ...DARWIN_DEFINITION_OPTIONS, adapter });
  const changed = { ...basePlan, source_plan_hash: "sha256:changed" };
  const status = statusDailyRefreshSchedule(changed, { ...DARWIN_DEFINITION_OPTIONS, adapter });
  assert.equal(status.installed, true);
  assert.equal(status.verified, false);
  assert.equal(adapter.calls.filter(([name]) => name === "install").length, 1,
    "status reached the drift decision without mutating the definition");
});

test("owned definition drift stays removable and pausable while a foreign task stays read-only", () => {
  const registered = buildDailyRefreshDefinition({
    ...basePlan,
    source_plan_hash: "sha256:registered-plan",
  }, {
    platform: "win32",
    nodePath: String.raw`C:\OldRuntime\node.exe`,
    brainPath: String.raw`C:\Runtime\brain.mjs`,
    runnerPath: String.raw`C:\Runtime\daily-refresh-run.mjs`,
  });

  const pauseAdapter = memoryAdapter({ exists: true, owned: true, enabled: true, definition: registered });
  const snapshot = pauseDailyRefreshSchedule(basePlan, { platform: "win32", adapter: pauseAdapter });
  assert.equal(snapshot.definition.definition_hash, registered.definition_hash,
    "update pause snapshots the exact observed owned definition");
  assert.equal(pauseAdapter.calls.filter(([name]) => name === "setEnabled").length, 1,
    "the owned-drift pause decision reached its mutation");

  const removeAdapter = memoryAdapter({ exists: true, owned: true, enabled: true, definition: registered });
  assert.equal(removeDailyRefreshSchedule(basePlan, { platform: "win32", adapter: removeAdapter }).removed, true);
  assert.equal(removeAdapter.calls.filter(([name]) => name === "remove").length, 1,
    "the owned-drift removal decision reached its mutation");

  for (const action of [pauseDailyRefreshSchedule, removeDailyRefreshSchedule]) {
    const foreign = memoryAdapter({ exists: true, owned: false, enabled: true, definition: registered });
    assert.throws(() => action(basePlan, { platform: "win32", adapter: foreign }), /foreign schedule/i);
    assert.equal(foreign.calls.some(([name]) => name === "setEnabled" || name === "remove"), false,
      "the foreign control reached ownership readback without mutation");
  }
});

test("status reports a missing registered Node binary and daily on repairs its owned definition", async () => {
  const directory = mkdtempSync(join(tmpdir(), "daily-node-repair-"));
  const manifestPath = join(directory, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    client: { slug: "fixture", timezone: "America/Phoenix" },
    infrastructure: { cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-database" } },
    corpora: { google_drive: { enabled: true } },
    operations: { daily_refresh: { enabled: true, timezone: "America/Phoenix" } },
  }));
  const registered = buildDailyRefreshDefinition(basePlan, {
    platform: "darwin",
    nodePath: "/old/runtime/node",
    brainPath: "/runtime/brain.mjs",
    runnerPath: "/runtime/daily-refresh-run.mjs",
  });
  const adapter = memoryAdapter({ exists: true, owned: true, enabled: true, definition: registered });
  let legacySchedulerReads = 0;
  const missing = statusDailyRefreshSchedule(basePlan, {
    platform: "darwin",
    adapter,
    nodePath: "/current/runtime/node",
    brainPath: registered.brain_path,
    runnerPath: registered.runner_path,
    nodePathExists: () => false,
  });
  assert.equal(missing.registered_node_present, false);
  assert.match(missing.attention, /Node binary is missing/i);

  const plan = {
    ...basePlan,
    timezone_matches_machine: true,
    unsupported_sources: 0,
    sources: [{
      key: "google_drive", class: "machine-pull", owner: "daily-task", status: "ready",
      source_names: ["drive"],
    }],
  };
  const repaired = await cmdScheduleAllConfigured(manifestPath, "install", {
    platform: "darwin",
    planDailyRefresh: async () => plan,
    schedulerAdapter: adapter,
    existingSchedulerOwners: [],
    driveScheduler: {
      statusDriveScheduler: () => {
        legacySchedulerReads += 1;
        return { installed: false };
      },
    },
    schedulerOptions: {
      nodePath: "/current/runtime/node",
      brainPath: registered.brain_path,
      runnerPath: registered.runner_path,
      nodePathExists: (path) => path === "/current/runtime/node",
      nodePathStat: () => ({ isFile: () => true }),
      nodePathAccess: () => {},
    },
    syncSourceExpectations: false,
    readSourceInventory: async () => ({ sources: [] }),
    withBrainLifecycleLock: async (_options, task) => task(),
    log: () => {},
  });
  assert.equal(repaired.schedule.verified, true);
  assert.equal(repaired.schedule.definition.node_path, "/current/runtime/node");
  assert.equal(adapter.calls.some(([name]) => name === "install"), true,
    "daily on reached native replacement instead of refusing owned drift");
  assert.equal(legacySchedulerReads, 0,
    "the focused missing-Node repair never inspects a native legacy scheduler");
});

test("the public all-configured command installs on Windows and prints stable freshness", async () => {
  const directory = mkdtempSync(join(tmpdir(), "daily-cli-"));
  const manifestPath = join(directory, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    client: { slug: "owner-brain", timezone: "America/Phoenix" },
    brain: { worker_name: "owner-brain", domain: "brain.example.invalid" },
    infrastructure: { cloudflare: { account_id: "account", d1_database_id: "database" } },
    corpora: { google_drive: { enabled: true } },
    operations: { daily_refresh: { enabled: true, cron: "0 9 * * *", max_runtime_minutes: 45 } },
  }));
  const adapter = memoryAdapter();
  const lines = [];
  const plan = {
    ...basePlan,
    platform: "win32",
    timezone_matches_machine: true,
    unsupported_sources: 0,
    sources: [{
      key: "google_drive", class: "machine-pull", owner: "daily-task", status: "ready",
      source_names: ["drive"],
    }],
  };
  const result = await cmdScheduleAllConfigured(manifestPath, "install", {
    platform: "win32",
    planDailyRefresh: async () => plan,
    schedulerAdapter: adapter,
    schedulerOptions: WINDOWS_DEFINITION_OPTIONS,
    syncSourceExpectations: false,
    readSourceInventory: async () => ({
      sources: [{
        name: "drive",
        freshness: { state: "current" },
        receipt: { last_successful_run_at: "2026-10-06T16:00:00.000Z" },
      }],
    }),
    log: (line) => lines.push(line),
  });
  assert.equal(result.schedule.verified, true);
  assert.deepEqual(lines, [
    "google_drive | current | 2026-10-06T16:00:00.000Z | 0 9 * * * America/Phoenix | daily-task",
  ]);
  assert.ok(adapter.calls.some(([name]) => name === "install"), "the native install decision point was reached");
});

test("status aggregates missing or unknown legs and does not predict an absent native run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "daily-status-"));
  const manifestPath = join(directory, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    client: { slug: "fixture", timezone: "America/Phoenix" },
    infrastructure: { cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-database" } },
    corpora: { provider: { enabled: true } },
    operations: { daily_refresh: { enabled: true, timezone: "America/Phoenix" } },
  }));
  const result = await cmdScheduleAllConfigured(manifestPath, "status", {
    platform: "win32",
    planDailyRefresh: async () => ({
      ...basePlan,
      timezone_matches_machine: true,
      unsupported_sources: 0,
      sources: [{
        key: "provider", class: "machine-pull", owner: "daily-task", status: "ready",
        source_names: ["mail", "files"],
      }],
    }),
    schedulerAdapter: memoryAdapter(),
    readSourceInventory: async () => ({ sources: [{
      name: "mail",
      freshness: { state: "current" },
      receipt: { last_successful_run_at: "2026-10-06T16:00:00.000Z" },
    }] }),
    log: () => {},
  });
  assert.equal(result.sources[0].current_state, "unknown");
  assert.equal(result.sources[0].next_run, "not scheduled");
  assert.equal(result.sources[0].owner, "none");
});

test("an unloaded or interpreter-missing legacy scheduler does not suppress daily work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "daily-owner-health-"));
  const manifestPath = join(directory, "brain.manifest.json");
  const manifest = {
    client: { slug: "fixture" },
    infrastructure: { cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-database" } },
    corpora: { google_drive: { enabled: true } },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const observedOwners = [];
  await cmdScheduleAllConfigured(manifestPath, "status", {
    platform: "darwin",
    driveScheduler: {
      statusDriveScheduler: () => ({
        installed: true, definitionMatches: true, loaded: false, running: false,
        interpreterPresent: true, scheduleError: null,
      }),
    },
    planDailyRefresh: async ({ existingSchedulerOwners }) => {
      observedOwners.push([...existingSchedulerOwners]);
      return { ...basePlan, timezone_matches_machine: true, unsupported_sources: 0, sources: [] };
    },
    schedulerAdapter: memoryAdapter(),
    readSourceInventory: async () => ({ sources: [] }),
    log: () => {},
  });
  assert.deepEqual(observedOwners, [[]], "the inert definition reached and failed the ownership-health decision");
});

test("daily off persists owner intent and takes the lifecycle boundary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "daily-intent-"));
  const manifestPath = join(directory, "brain.manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    client: { slug: "fixture", timezone: "America/Phoenix" },
    infrastructure: { cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-database" } },
    corpora: { google_drive: { enabled: true } },
    operations: { daily_refresh: { enabled: true, timezone: "America/Phoenix" } },
  }, null, 2)}\n`);
  const adapter = memoryAdapter();
  installDailyRefreshSchedule({ ...basePlan, source_plan_hash: "sha256:registered-drift", sources: [{
    key: "google_drive", class: "machine-pull", owner: "daily-task", status: "ready", source_names: ["drive"],
  }] }, { ...WINDOWS_DEFINITION_OPTIONS, adapter });
  let locks = 0;
  await cmdScheduleAllConfigured(manifestPath, "remove", {
    platform: "win32",
    planDailyRefresh: async () => ({
      ...basePlan,
      timezone_matches_machine: true,
      unsupported_sources: 0,
      sources: [{ key: "google_drive", class: "machine-pull", owner: "daily-task", status: "ready", source_names: ["drive"] }],
    }),
    schedulerAdapter: adapter,
    schedulerOptions: WINDOWS_DEFINITION_OPTIONS,
    syncSourceExpectations: false,
    readSourceInventory: async () => ({ sources: [] }),
    withBrainLifecycleLock: async (_options, task) => { locks += 1; return task(); },
    log: () => {},
  });
  assert.equal(locks, 1, "schedule mutation entered the shared lifecycle boundary");
  assert.equal(adapter.calls.some(([name]) => name === "remove"), true,
    "daily off removed the identity-owned drifted definition");
  assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).operations.daily_refresh.enabled, false);
});

test("scheduled execution reuses the installed ownership plan before checking its hash", async () => {
  const directory = mkdtempSync(join(tmpdir(), "daily-shared-plan-"));
  const manifestPath = join(directory, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify({ client: { slug: "fixture" }, corpora: {} }));
  let planCalls = 0;
  const definition = buildDailyRefreshDefinition(basePlan, DARWIN_DEFINITION_OPTIONS);
  const schedulerAdapter = memoryAdapter({ exists: true, owned: true, enabled: true, definition });
  const result = await runDailyRefreshCli(manifestPath, {
    brainModule: {},
    buildPlan: async () => { planCalls += 1; return basePlan; },
    expectedDefinitionHash: definition.definition_hash,
    platform: "darwin",
    definitionOptions: {
      ...DARWIN_DEFINITION_OPTIONS,
      nodePathExists: () => true,
      nodeRealpath: (path) => path,
      nodePathStat: () => ({ isFile: () => true }),
      nodePathAccess: () => {},
    },
    schedulerAdapter,
    acquireLock: () => ({ assertOwned: () => true, release: () => {} }),
    runSource: async () => assert.fail("the fixture has no daily-owned source"),
    readFreshness: async () => ({}),
    writeReceipt: () => {},
    silent: true,
  });
  assert.equal(planCalls, 1, "execution reached the same shared planning decision used by installation");
  assert.equal(result.status, "complete");
});

test("update restores only after active, query-ready, queue-zero verification", async () => {
  const events = [];
  const prior = { identity: basePlan.identity, enabled: true, definition: { identity: basePlan.identity } };
  const scheduler = {
    snapshotAndPause: () => { events.push("pause"); return prior; },
    reconcile: (plan) => { events.push(`reconcile:${plan.source_plan_hash}`); return { verified: true }; },
    restore: () => events.push("restore"),
    leavePaused: () => events.push("leave-paused"),
  };
  const updatedPlan = { ...basePlan, source_plan_hash: "sha256:updated" };
  await runUpdateWithDailyRefreshPaused({
    scheduler,
    plan: basePlan,
    runUpdate: async () => { events.push("update"); return { status: "updated" }; },
    verifyFinal: async () => ({ active: true, query_ready: true, pending: 0 }),
    recomputePlan: async () => updatedPlan,
  });
  assert.deepEqual(events, ["pause", "update", "reconcile:sha256:updated"]);

  events.length = 0;
  await assert.rejects(() => runUpdateWithDailyRefreshPaused({
    scheduler,
    plan: basePlan,
    runUpdate: async () => { events.push("update"); return { status: "updated" }; },
    verifyFinal: async () => ({ active: true, query_ready: false, pending: 0 }),
    recomputePlan: async () => updatedPlan,
  }), /query-ready/i);
  assert.deepEqual(events, ["pause", "update", "leave-paused"], "failed final health leaves imports paused");

  events.length = 0;
  await runUpdateWithDailyRefreshPaused({
    scheduler,
    plan: basePlan,
    runUpdate: async () => { events.push("update"); return { status: "noop" }; },
    verifyFinal: async () => ({ active: true, query_ready: true, pending: 0 }),
    recomputePlan: async () => assert.fail("a no-op update does not replace the schedule"),
  });
  assert.deepEqual(events, ["pause", "update", "restore"], "a verified no-op path restores the exact prior state");

  events.length = 0;
  await assert.rejects(() => runUpdateWithDailyRefreshPaused({
    scheduler,
    plan: basePlan,
    runUpdate: async () => { events.push("update"); return { status: "rolled-back" }; },
    verifyFinal: async () => ({ active: false, query_ready: false, pending: 0 }),
    recomputePlan: async () => updatedPlan,
  }), /active, query-ready/i);
  assert.deepEqual(events, ["pause", "update", "leave-paused"], "an unverified rollback stays paused");
});

for (const platform of ["darwin", "win32"]) {
  test(`${platform} daily status reports process failure and missing runner without inventing success`, () => {
    const home = mkdtempSync(join(tmpdir(), "daily-observation-status-"));
    const options = {
      ...(platform === "darwin" ? DARWIN_DEFINITION_OPTIONS : WINDOWS_DEFINITION_OPTIONS),
      home, now: () => new Date("2026-10-07T16:30:00.000Z"),
      nodePathExists: () => true, nodeRealpath: (path) => path,
      nodePathStat: () => ({ isFile: () => true }), nodePathAccess: () => {},
    };
    const definition = buildDailyRefreshDefinition(basePlan, options);
    const adapter = memoryAdapter({ exists: true, owned: true, enabled: true, definition });
    let runtimeReads = 0;
    let runtime = { known: true, running: false, exit_code: 1, last_run_at: "2026-10-07T16:00:00.000Z", next_run_at: "2026-10-08T16:00:00.000Z" };
    adapter.runtime = () => { runtimeReads += 1; return runtime; };
    let runnerReads = 0;
    const inspect = (present) => statusDailyRefreshSchedule(basePlan, {
      ...options, adapter, runnerPathUsable: () => { runnerReads += 1; return present; },
    });
    const failed = inspect(true);
    assert.equal(failed.last_result, "failed");
    assert.equal(failed.last_run_at, runtime.last_run_at);
    assert.match(failed.last_error_line, /code 1/);
    runtime = { ...runtime, exit_code: 0 };
    assert.equal(inspect(false).last_result, "failed", "a missing runner cannot inherit an earlier zero exit");
    const directory = join(home, ".brain", "logs", basePlan.identity.id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "daily.log"), `${JSON.stringify({
      schema_version: 1, started_at: runtime.last_run_at, completed_at: "2026-10-07T16:01:00.000Z",
      result: "complete", error: null,
    })}\n`, { mode: 0o600 });
    const green = inspect(true);
    assert.equal(green.last_result, "complete", "native zero plus a completion receipt is the green control");
    assert.ok(green.next_run);
    assert.equal(green.next_run_at, "2026-10-08T16:00:00.000Z");
    assert.equal(runtimeReads, 3);
    assert.equal(runnerReads, 3);
    assert.equal(buildDailyRefreshDefinition(basePlan, { ...options, home: join(home, "relocated") }).definition_hash, definition.definition_hash,
      "diagnostic storage cannot change execution authorization");
  });
}

test("macOS daily runtime exposes exit and signal failures from the loaded service", () => {
  const home = mkdtempSync(join(tmpdir(), "daily-native-runtime-"));
  const definition = buildDailyRefreshDefinition(basePlan, DARWIN_DEFINITION_OPTIONS);
  const directory = join(home, "Library", "LaunchAgents");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${definition.name}.plist`), definition.serialized);
  let evidence = "state = not running\nlast exit code = 7\n";
  let reads = 0;
  const adapter = createNativeDailyRefreshAdapter({ platform: "darwin", home, uid: 501,
    spawn: (_command, args) => {
      if (args[0] === "print") { reads += 1; return { status: 0, stdout: evidence }; }
      return { status: 0, stdout: "" };
    },
  });
  assert.equal(adapter.read(basePlan.identity).runtime.exit_code, 7);
  evidence = "state = not running\nlast terminating signal = Terminated: 15\n";
  assert.equal(adapter.read(basePlan.identity).runtime.signal, 15);
  evidence = "state = not running\nlast exit code = 0\n";
  assert.equal(adapter.read(basePlan.identity).runtime.exit_code, 0);
  assert.equal(reads, 3);
});

test("daily status renders the observed run fields through the public command", async () => {
  const { cmdDaily } = await import("../brain.mjs");
  const home = mkdtempSync(join(tmpdir(), "daily-status-output-"));
  const manifestPath = join(home, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify({ client: { slug: "fixture" }, corpora: {} }));
  const definition = buildDailyRefreshDefinition(basePlan, DARWIN_DEFINITION_OPTIONS);
  const adapter = memoryAdapter({ exists: true, owned: true, enabled: true, definition });
  adapter.runtime = () => ({ known: true, running: false, exit_code: 5, last_run_at: "2026-10-07T16:00:00.000Z" });
  const lines = [];
  const result = await cmdDaily(["status", manifestPath], {
    platform: "darwin", schedulerAdapter: adapter,
    schedulerOptions: { ...DARWIN_DEFINITION_OPTIONS, home, runnerPathUsable: () => true,
      nodePathExists: () => true, nodeRealpath: (path) => path, nodePathStat: () => ({ isFile: () => true }), nodePathAccess() {} },
    planDailyRefresh: async () => ({ ...basePlan, timezone_matches_machine: true, unsupported_sources: 0 }),
    readSourceInventory: async () => ({ sources: [] }), log: (line) => lines.push(line),
  });
  assert.equal(result.schedule.last_result, "failed");
  assert.ok(lines.includes("Last daily run: 2026-10-07T16:00:00.000Z"));
  assert.ok(lines.includes("Last daily result: failed"));
  assert.ok(lines.some((line) => line.startsWith("Next daily run: ")));
  assert.ok(lines.includes("Last daily error: Daily process exited with code 5."));
  assert.ok(adapter.calls.length > 0);
});

test("daily execution hashes retain the pre-observability contract", () => {
  const mac = buildDailyRefreshDefinition(basePlan, DARWIN_DEFINITION_OPTIONS);
  const windows = buildDailyRefreshDefinition(basePlan, WINDOWS_DEFINITION_OPTIONS);
  assert.equal(mac.definition_hash, "sha256:fa20159bef67f028755af04241d7603c4949f1add0fec8792e908fcb7835387c");
  assert.equal(windows.definition_hash, "sha256:7c56a91ee26964d1946a1ea03d00d9240820c7281454c9596a82aa1529998527");
  assert.ok(mac.log_path.endsWith("daily.log"));
  assert.ok(windows.log_path.endsWith("daily.log"));
});

test("daily status distinguishes absent, stale, interrupted, and unreadable run evidence", async () => {
  const { appendDailyObservation, dailyObservationStatus } = await import("../operations/daily-refresh-observation.mjs");
  const home = mkdtempSync(join(tmpdir(), "daily-evidence-states-"));
  const options = { home, platform: "darwin", now: () => new Date("2026-10-07T16:30:00.000Z") };
  const schedule = { enabled: true, plan_matches_registered_definition: true, registered_node_usable: true };
  const native = { known: true, running: false, exit_code: 0, last_run_at: "2026-10-07T16:00:00.000Z" };
  const status = (runtime = native) => dailyObservationStatus(basePlan, schedule, runtime, true, options);
  assert.equal(status().last_result, "unknown", "native zero alone has no completion proof");
  const row = { started_at: "2026-10-07T16:00:00.000Z", completed_at: "2026-10-07T16:01:00.000Z", result: "complete", error: null };
  const paths = appendDailyObservation(basePlan.identity, row, options);
  assert.equal(status().last_result, "complete", "matching completion is the green control");
  assert.equal(status({ ...native, last_run_at: "2026-10-08T16:00:00.000Z" }).last_result, "unknown", "a later native attempt cannot reuse old success");
  assert.equal(status({ known: false }).last_result, "unknown", "denied runtime inspection cannot report success");
  assert.equal(status({ ...native, signal: 15 }).last_result, "failed");
  appendDailyObservation(basePlan.identity, { ...row, result: "running", completed_at: null }, options);
  assert.equal(status().last_result, "unknown", "an interrupted run did not complete");
  assert.equal(status({ ...native, running: true }).last_result, "running");
  writeFileSync(paths.log_path, "{broken journal\n");
  assert.equal(status().last_result, "unknown");
  assert.match(status().last_error_line, /could not be read safely/);
});

test("Mac next-run calculation uses the local calendar slot and respects pause", async () => {
  const { dailyObservationStatus } = await import("../operations/daily-refresh-observation.mjs");
  const home = mkdtempSync(join(tmpdir(), "daily-next-run-"));
  const priorTimezone = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    const plan = { ...basePlan, timezone: "UTC" };
    const schedule = { enabled: true, plan_matches_registered_definition: true, registered_node_usable: true };
    const options = { home, platform: "darwin", now: () => new Date("2026-10-07T08:30:00.000Z") };
    const today = dailyObservationStatus(plan, schedule, { known: true }, true, options);
    assert.equal(today.next_run_at, "2026-10-07T09:00:00.000Z");
    const tomorrow = dailyObservationStatus(plan, schedule, { known: true }, true, {
      ...options, now: () => new Date("2026-10-07T09:00:00.000Z"),
    });
    assert.equal(tomorrow.next_run_at, "2026-10-08T09:00:00.000Z");
    const paused = dailyObservationStatus(plan, { ...schedule, enabled: false }, { known: true }, true, options);
    assert.equal(paused.next_run_at, null);
    assert.equal(paused.next_run, "not scheduled");
  } finally {
    if (priorTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = priorTimezone;
  }
});


test("update remote mutation intent is monotonic and older or malformed receipts cannot authorize restore", () => {
  const home = mkdtempSync(join(tmpdir(), "daily-mutation-intent-"));
  try {
    const manifestPath = join(home, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ client: { slug: "fixture" } }));
    const plan = { ...basePlan, manifest_path: manifestPath };
    const options = { home, manifestPath, machineLockRoot: join(home, "locks"), now: () => new Date("2026-10-07T15:00:00.000Z") };
    const input = { plan, phase: "paused", snapshot: { identity: plan.identity, exists: false, enabled: false } };
    const save = (overrides = {}) => dailySchedulerModule.writeDailyRefreshUpdateTransaction({ ...input, ...overrides }, options);
    const read = () => dailySchedulerModule.readDailyRefreshUpdateTransaction(plan.identity, options);
    const initial = save();
    assert.equal(initial.remote_mutation_may_have_started, false, "fresh transaction is the pre-change control");
    assert.equal(read().remote_mutation_may_have_started, false);
    save({ remoteMutationMayHaveStarted: true });
    assert.equal(read().remote_mutation_may_have_started, true);
    save({ phase: "preparing", remoteMutationMayHaveStarted: false });
    assert.equal(read().remote_mutation_may_have_started, true, "a retry cannot erase durable dispatch intent");
    assert.equal(read().transaction_id, initial.transaction_id);

    const path = join(home, ".brain", "daily-update-transactions", `${plan.identity.id}.json`);
    const legacy = JSON.parse(readFileSync(path, "utf8"));
    delete legacy.remote_mutation_may_have_started;
    writeFileSync(path, JSON.stringify(legacy)); // Synthetic receipt from a version without dispatch intent.
    assert.equal(read().remote_mutation_may_have_started, true, "missing intent is not evidence of a pre-change refusal");
    save({ remoteMutationMayHaveStarted: false });
    assert.equal(read().remote_mutation_may_have_started, true);

    writeFileSync(path, JSON.stringify({ ...legacy, remote_mutation_may_have_started: "false" }));
    assert.throws(read, /malformed/, "a malformed marker cannot grant restore authority");
    for (const bytes of ["{", "null"]) {
      writeFileSync(path, bytes);
      assert.throws(save, /malformed/, "unreadable prior state must not become a fresh pre-change transaction");
      assert.equal(readFileSync(path, "utf8"), bytes, "refused write preserves recovery evidence");
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
