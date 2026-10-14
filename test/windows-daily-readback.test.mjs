import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cmdDaily } from "../brain.mjs";
import { reregisterAfterManifestChange } from "../operations/quickbooks-schedule.mjs";
import { randomBytes } from "node:crypto";
import {
  buildDailyRefreshDefinition, createNativeDailyRefreshAdapter, installDailyRefreshSchedule,
  statusDailyRefreshSchedule, removeDailyRefreshSchedule, pauseDailyRefreshSchedule, restoreDailyRefreshSchedule,
} from "../operations/daily-refresh-scheduler.mjs";
import { runDailyRefreshCli } from "../operations/daily-refresh-run.mjs";

const SID = "S-1-5-21-101-202-303-1001";
const plan = {
  identity: { id: "v1-0123456789abcdef", principal: `sid:${SID}` },
  manifest_path: String.raw`C:\Fixture\brain.manifest.json`,
  manifest_path_hash: "sha256:path", manifest_content_hash: "sha256:content", source_plan_hash: "sha256:sources",
  cron: "0 9 * * *", timezone: "UTC", max_runtime_minutes: 45, enabled: true, ready: true,
  sources: [{ key: "drive", class: "machine-pull", owner: "daily-task", status: "ready", run_key: "google_drive" }],
};
const options = {
  platform: "win32", nodePath: String.raw`C:\Runtime\node.exe`, brainPath: String.raw`C:\Runtime\brain.mjs`,
  runnerPath: String.raw`C:\Runtime\daily-refresh-run.mjs`, nodePathExists: () => true,
  nodeRealpath: path => path, nodePathStat: () => ({ isFile: () => true }), nodePathAccess: () => {}, runnerPathUsable: () => true,
};

// Synthetic Windows 10/11 query shape: scheduler metadata, reordered settings,
// principal context, schema-default omissions and idle defaults. No field data.
function windowsReadback(definition, user = SID) {
  const xml = definition.serialized;
  const value = name => xml.match(new RegExp(`<${name}>(.*?)</${name}>`))[1];
  return `\ufeff<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Date>2026-10-14T08:00:00</Date><Author>FIXTURE\\owner</Author>
    <Description>${value("Description")}</Description><URI>${definition.name}</URI><Version>1.0</Version></RegistrationInfo>
  <Triggers><CalendarTrigger><StartBoundary>2000-01-01T09:00:00</StartBoundary>
    <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers>
  <Principals><Principal id="Author"><RunLevel>LeastPrivilege</RunLevel><UserId>${user}</UserId>
    <LogonType>InteractiveToken</LogonType></Principal></Principals>
  <Settings><Enabled>true</Enabled><Priority>7</Priority><ExecutionTimeLimit>PT0H45M0S</ExecutionTimeLimit>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable>
    <IdleSettings><Duration>PT10M</Duration><WaitTimeout>PT1H</WaitTimeout><StopOnIdleEnd>true</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession><UseUnifiedSchedulingEngine>false</UseUnifiedSchedulingEngine>
    <WakeToRun>true</WakeToRun></Settings>
  <Actions Context="Author"><Exec><Arguments>${value("Arguments")}</Arguments><Command>${value("Command")}</Command></Exec></Actions>
</Task>`;
}

function harness(t, { initial = null, transform = windowsReadback, changingMetadata = false, beforeQuery = value => value, pipeEncoding = null, unicodeReadFailure = false, unicodeStatus = null, strictRegistration = false } = {}) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "daily-readback-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let native = initial;
  const calls = [];
  const registrations = [];
  const adapter = createNativeDailyRefreshAdapter({ platform: "win32", home,
    environment: { SystemRoot: String.raw`C:\Windows` },
    spawn: (command, args, child) => {
      calls.push(args);
      assert.deepEqual(child.env, { SystemRoot: String.raw`C:\Windows` });
      if (command.endsWith("powershell.exe")) {
        assert.ok(args.includes("-EncodedCommand"), "lossless read uses a literal encoded program");
        const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
        assert.ok(script.includes("Schedule.Service") && script.includes("OpenStandardOutput"), "read requests native Unicode XML");
        assert.ok(script.includes("GetTask") && script.includes("FromBase64String"), "task locator is passed as data");
        assert.ok(script.indexOf("LanguageMode") < script.indexOf("New-Object"), "policy check precedes restricted operations");
        assert.match(script, /LanguageMode -ne 'FullLanguage'\) \{ exit 73 \}/u);
        assert.equal(child.timeout, 15000, "Unicode export is bounded");
        if (unicodeStatus !== null) return { status: unicodeStatus };
        if (unicodeReadFailure) return { status: 5 };
        return { status: 0, stdout: Buffer.from(`\ufeff${native.replace(/^\ufeff/u, "")}`, "utf16le") };
      }
      if (command.endsWith("whoami.exe")) return { status: 0, stdout: `"fixture\\owner","${SID}"\r\n` };
      if (args.includes("/FO")) return { status: 0, stdout: '"\\Other\\Control","N/A","Ready"\r\n' };
      if (args[0] === "/Query") native = beforeQuery(native);
      if (args[0] === "/Query" && pipeEncoding && native !== null) {
        const xml = native.replace(/^\ufeff/u, "");
        const text = pipeEncoding === "ascii-lossy" ? xml.replaceAll("é", "?") : xml;
        const bytes = Buffer.from(text, pipeEncoding === "utf8" ? "utf8" : "latin1");
        if (pipeEncoding === "oem") for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0xe9) bytes[i] = 0x82;
        return { status: 0, stdout: bytes };
      }
      if (args[0] === "/Query") return native === null ? { status: 1 } : { status: 0, stdout: changingMetadata
        ? native.replace("<Version>1.0</Version>", `<Version>${calls.length}</Version>`) : native };
      if (args[0] === "/Create") {
        const bytes = readFileSync(args[args.indexOf("/XML") + 1]);
        registrations.push(bytes);
        const serialized = bytes.toString("utf16le").replace(/^\ufeff/u, "");
        if (strictRegistration && !serialized.startsWith("<?xml")) return { status: 1 };
        native = transform({ ...buildDailyRefreshDefinition(plan, options), serialized });
      } else if (args[0] === "/Delete") native = null;
      else if (args[0] === "/Change") native = native.replace(/<Settings>([\s\S]*?)<\/Settings>/u,
        (_all, settings) => {
          const enabled = `<Enabled>${args.includes("/ENABLE")}</Enabled>`;
          return `<Settings>${settings.includes("<Enabled>")
            ? settings.replace(/<Enabled>.*?<\/Enabled>/u, enabled) : enabled + settings}</Settings>`;
        });
      else assert.fail("unexpected native call");
      return { status: 0, stdout: "" };
    },
  });
  return { home, adapter, calls, registrations, get native() { return native; }, set native(value) { native = value; } };
}

for (const user of [SID, "FIXTURE\\owner"]) {
  test(`Windows query normalization verifies the same owner (${user === SID ? "SID" : user.includes("\\") ? "qualified" : "short"})`, t => {
    const definition = buildDailyRefreshDefinition(plan, options);
    const h = harness(t, { initial: windowsReadback(definition, user) });
    const status = statusDailyRefreshSchedule(plan, { ...options, adapter: h.adapter });
    assert.ok(h.calls.some(args => args.includes("/XML")), "the native readback decision was reached");
    assert.equal(status.verified, true);
    assert.equal(status.definition_matches_plan, true);
    assert.equal(status.plan_matches_registered_definition, true);
  });
}

test("normalized install, pause, restore and off use the same projection despite metadata changes", t => {
  const h = harness(t, { changingMetadata: true });
  assert.equal(installDailyRefreshSchedule(plan, { ...options, adapter: h.adapter }).verified, true);
  assert.equal(h.calls.filter(args => args[0] === "/Create").length, 1);
  const snapshot = pauseDailyRefreshSchedule(plan, { ...options, adapter: h.adapter });
  assert.equal(h.adapter.read(plan.identity).enabled, false);
  assert.equal(restoreDailyRefreshSchedule(snapshot, { ...options, adapter: h.adapter }).verified, true);
  assert.equal(removeDailyRefreshSchedule(plan, { ...options, adapter: h.adapter }).verified, true);
  assert.equal(h.native, null);
  assert.equal(h.calls.filter(args => args[0] === "/Delete").length, 1);
});

test("daily on recovers an owned failed-version task and reconciles the current definition", t => {
  const prior = buildDailyRefreshDefinition({ ...plan, source_plan_hash: "sha256:previous" }, options);
  const h = harness(t, { initial: windowsReadback(prior) });
  assert.equal(statusDailyRefreshSchedule(plan, { ...options, adapter: h.adapter }).verified, false);
  assert.equal(installDailyRefreshSchedule(plan, { ...options, adapter: h.adapter }).verified, true);
  assert.ok(h.calls.some(args => args[0] === "/Create" && args.includes("/F")), "the marked task was replaced");
  assert.equal(removeDailyRefreshSchedule(plan, { ...options, adapter: h.adapter }).removed, true);
});

test("failed fresh install rollback passes the observed snapshot to native removal", t => {
  const h = harness(t, { transform: definition => definition.serialized.replace("<Priority>7</Priority>", "<Priority>6</Priority>") });
  assert.throws(() => installDailyRefreshSchedule(plan, { ...options, adapter: h.adapter }), error => {
    assert.match(error.message, /exact readback/);
    assert.doesNotMatch(error.message, /rollback also failed/);
    return true;
  });
  assert.equal(h.calls.filter(args => args[0] === "/Create").length, 1, "the install decision was reached");
  assert.equal(h.calls.filter(args => args[0] === "/Delete").length, 1, "cleanup reached native deletion");
  assert.equal(h.native, null);
});

test("required fields and extra execution remain refused with unchanged ownership marker", t => {
  const definition = buildDailyRefreshDefinition(plan, options);
  const original = windowsReadback(definition);
  const h = harness(t, { initial: original });
  assert.equal(statusDailyRefreshSchedule(plan, { ...options, adapter: h.adapter }).verified, true, "green control");
  const mutations = [
    ["command", s => s.replace("C:\\Runtime\\node.exe", "C:\\Foreign\\node.exe")],
    ["arguments", s => s.replace('&quot;run&quot;', '&quot;other&quot;')],
    ["argument whitespace", s => s.replace("<Arguments>", "<Arguments> ")],
    ["kind", s => s.replaceAll("CalendarTrigger", "LogonTrigger")],
    ["clock", s => s.replace("T09:00:00", "T10:00:00")],
    ["interval", s => s.replace("<DaysInterval>1", "<DaysInterval>2")],
    ["trigger enabled", s => s.replace("<CalendarTrigger>", "<CalendarTrigger><Enabled>false</Enabled>")],
    ["principal", s => s.replace(SID, "S-1-5-21-101-202-303-9999")],
    ["foreign domain", s => s.replace(SID, "OTHER\\owner")],
    ["logon", s => s.replace("InteractiveToken", "Password")],
    ["run level", s => s.replace("LeastPrivilege", "HighestAvailable")],
    ["limit", s => s.replace("PT0H45M0S", "PT1H")],
    ["instances", s => s.replace("IgnoreNew", "Parallel")],
    ["start available", s => s.replace("<StartWhenAvailable>true", "<StartWhenAvailable>false")],
    ["marker", s => s.replace(definition.definition_hash, `sha256:${"0".repeat(64)}`)],
    ["extra action", s => s.replace("</Actions>", "<Exec><Command>extra.exe</Command></Exec></Actions>")],
    ["extra trigger", s => s.replace("</Triggers>", "<LogonTrigger/></Triggers>")],
    ["repetition", s => s.replace("<CalendarTrigger>", "<CalendarTrigger><Repetition><Interval>PT1M</Interval></Repetition>")],
    ["duplicate enabled", s => s.replace("<Settings>", "<Settings><Enabled>true</Enabled>")],
    ["duplicate command", s => s.replace("</Exec>", "<Command>extra.exe</Command></Exec>")],
    ["working directory", s => s.replace("</Exec>", "<WorkingDirectory>C:\\Foreign</WorkingDirectory></Exec>")],
    ["invalid boolean", s => s.replace("<StartWhenAvailable>true", "<StartWhenAvailable>maybe")],
    ["unsafe default", s => s.replace("<DisallowStartOnRemoteAppSession>false", "<DisallowStartOnRemoteAppSession>true")],
  ];
  for (const [label, mutate] of mutations) {
    h.native = mutate(original);
    assert.notEqual(h.native, original, `${label} fixture exercised its decision`);
    const reads = h.calls.length;
    if (label === "duplicate enabled") assert.throws(() => statusDailyRefreshSchedule(plan, { ...options, adapter: h.adapter }), /enabled state could not be inspected/);
    else assert.equal(statusDailyRefreshSchedule(plan, { ...options, adapter: h.adapter }).verified, false, label);
    assert.ok(h.calls.length > reads, `${label} reached native inspection`);
  }
});

test("the scheduled runner accepts normalized readback and refuses drift before any source write", async t => {
  for (const readback of [windowsReadback, fieldReadback]) for (const changed of [false, "clock", "date", "disabled"]) {
    const h = harness(t);
    const path = join(h.home, "brain.manifest.json");
    writeFileSync(path, JSON.stringify({ brain: { domain: "fixture.invalid" } }));
    const activePlan = { ...plan, manifest_path: path };
    const definition = buildDailyRefreshDefinition(activePlan, options);
    h.native = readback(definition);
    if (changed === "clock") h.native = h.native.replace("T09:00:00", "T10:00:00");
    if (changed === "date") h.native = h.native.replace("2000-01-01T", "2099-01-01T");
    if (changed === "disabled") h.native = h.native.replace(/<Settings>([\s\S]*?)<\/Settings>/u,
      (_all, settings) => `<Settings><Enabled>false</Enabled>${settings.replace(/<Enabled>.*?<\/Enabled>/u, "")}</Settings>`);
    let writes = 0;
    let reads = 0;
    const invoke = () => runDailyRefreshCli(path, {
      brainModule: {}, buildPlan: async () => activePlan, expectedDefinitionHash: definition.definition_hash,
      platform: "win32", home: h.home, principal: `sid:${SID}`, appendObservation() {}, schedulerAdapter: h.adapter,
      definitionOptions: options, readUpdateTransaction: () => null, withLifecycleLock: async (_m, _p, run) => run(),
      acquireLock: () => ({ assertOwned() {}, release() {} }), writeReceipt() {}, silent: true,
      now: () => new Date("2026-10-14T16:00:00Z"),
      runSource: async () => { writes++; return { status: "complete" }; },
      readFreshness: async () => ({ drive: { last_successful_run_at: ++reads === 1 ? "2026-10-13T16:00:00Z" : "2026-10-14T16:00:00Z" } }),
    });
    if (changed) await assert.rejects(invoke, /plan changed/);
    else assert.equal((await invoke()).status, "complete");
    assert.ok(h.calls.some(args => args.includes("/XML")), "runner reached native verification");
    assert.equal(writes, changed ? 0 : 1);
  }
});

for (const encoding of ["utf8", "utf16le", "utf16be"]) {
  test(`native XML pipe bytes decode ${encoding} before projection`, t => {
    const xml = windowsReadback(buildDailyRefreshDefinition(plan, options));
    const bytes = Buffer.from(xml, encoding === "utf16be" ? "utf16le" : encoding);
    if (encoding === "utf16be") bytes.swap16();
    const h = harness(t, { initial: bytes });
    assert.equal(statusDailyRefreshSchedule(plan, { ...options, adapter: h.adapter }).verified, true);
    assert.ok(h.calls.some(args => args.includes("/XML")), "byte readback reached native inspection");
    assert.equal(h.calls.filter(args => args.includes("-EncodedCommand")).length, 0, "Unicode BOMs need no COM export");
  });
}


function fieldReadback(definition) {
  const xml = readFileSync(new URL("./fixtures/windows-daily-field-readback.xml", import.meta.url), "utf8");
  const value = name => definition.serialized.match(new RegExp(`<${name}>(.*?)</${name}>`))[1];
  return xml.replace("__MARKER__", value("Description")).replace("__TASK_NAME__", definition.name)
    .replace("__USER_ID__", SID).replace("__COMMAND__", value("Command")).replace("__ARGUMENTS__", value("Arguments"));
}

test("field Windows 11 default omissions and unified engine verify, install and remove", t => {
  const definition = buildDailyRefreshDefinition(plan, options);
  const h = harness(t, { transform: fieldReadback, initial: fieldReadback(definition) });
  assert.equal(statusDailyRefreshSchedule(plan, { ...options, adapter: h.adapter }).verified, true,
    "the field XML shape is accepted for the current authorization");
  const paused = pauseDailyRefreshSchedule(plan, { ...options, adapter: h.adapter });
  assert.equal(h.adapter.read(plan.identity).enabled, false, "native pause can add an omitted default");
  assert.equal(restoreDailyRefreshSchedule(paused, { ...options, adapter: h.adapter }).verified, true);
  assert.equal(installDailyRefreshSchedule(plan, { ...options, adapter: h.adapter }).verified, true);
  assert.equal(removeDailyRefreshSchedule(plan, { ...options, adapter: h.adapter }).removed, true);
  assert.equal(installDailyRefreshSchedule(plan, { ...options, adapter: h.adapter }).verified, true);
  assert.equal(removeDailyRefreshSchedule(plan, { ...options, adapter: h.adapter }).removed, true);
  assert.equal(h.calls.filter(args => args[0] === "/Create").length, 1, "fresh install used real adapter registration");
  assert.equal(h.calls.filter(args => args[0] === "/Delete").length, 2, "both old and new tasks were removable");
});


test("task Enabled is scoped separately from trigger Enabled and schema defaults", t => {
  const definition = buildDailyRefreshDefinition(plan, options);
  const h = harness(t, { initial: fieldReadback(definition) });
  assert.equal(h.adapter.read(plan.identity).enabled, true, "omitted task Enabled defaults to true");
  h.native = h.native.replace("<Settings>", "<Settings><Enabled>false</Enabled>");
  assert.equal(h.adapter.read(plan.identity).enabled, false, "task disabled state is read from Settings");
  h.native = fieldReadback(definition).replace("<CalendarTrigger>", "<CalendarTrigger><Enabled>false</Enabled>");
  assert.equal(h.adapter.read(plan.identity).enabled, true, "trigger false cannot hide task true");
  assert.equal(statusDailyRefreshSchedule(plan, { ...options, adapter: h.adapter }).verified, false);
  assert.ok(h.calls.filter(args => args.includes("/XML")).length >= 4, "all enabled-state decisions were inspected");
});

test("pre-removal comparison refuses a semantic edit after observation, while metadata changes pass", t => {
  const definition = buildDailyRefreshDefinition(plan, options);
  for (const changed of [false, true]) {
    const h = harness(t, { initial: fieldReadback(definition) });
    const observed = h.adapter.read(plan.identity);
    h.native = changed ? h.native.replace("T09:00:00", "T10:00:00") : h.native.replace("<URI>", "<URI>metadata-");
    if (changed) assert.throws(() => h.adapter.remove(plan.identity, { expected: observed }), /changed before removal/);
    else h.adapter.remove(plan.identity, { expected: observed });
    assert.ok(h.calls.filter(args => args.includes("/XML")).length >= 2, "mutation boundary was reached");
    assert.equal(h.calls.filter(args => args[0] === "/Delete").length, changed ? 0 : 1);
  }
});

test("invalid execution projection cannot hide an enabled owned task from pause", t => {
  const definition = buildDailyRefreshDefinition(plan, options);
  const h = harness(t, { initial: windowsReadback(definition).replace("</Actions>", "<Exec><Command>extra.exe</Command></Exec></Actions>") });
  const state = h.adapter.read(plan.identity);
  assert.equal(state.definition.native_contract_valid, false, "the extra execution reaches and fails validation");
  assert.equal(state.enabled, true, "an invalid action does not imply the task is disabled");
  pauseDailyRefreshSchedule(plan, { ...options, adapter: h.adapter });
  assert.ok(h.calls.some(args => args[0] === "/Change" && args.includes("/DISABLE")), "pause reached its native mutation");
  assert.equal(h.adapter.read(plan.identity).enabled, false);
});


test("daily on replaces the failed version-1 field task once and remains idempotent", t => {
  // Pinned 0.4.15 definition hash for this synthetic plan and these runtime paths.
  const priorHash = "sha256:4bdcbbdb4e6093aca98405fd19d5e934ec94a617222ba6e61deaa0c0b3f39e13";
  const definition = buildDailyRefreshDefinition(plan, options);
  const h = harness(t, { initial: fieldReadback(definition).replaceAll(definition.definition_hash, priorHash), transform: fieldReadback });
  const before = statusDailyRefreshSchedule(plan, { ...options, adapter: h.adapter });
  assert.equal(before.state.definition.native_contract_valid, true, "the old field shape is understood");
  assert.equal(before.verified, false, "the old authorization still requires its one replacement");
  const installed = installDailyRefreshSchedule(plan, { ...options, adapter: h.adapter });
  assert.equal(installed.changed, true, "fixed daily on replaces the old authorization, even if its fields now parse");
  assert.equal(installed.verified, true);
  assert.equal(h.calls.filter(args => args[0] === "/Create" && args.includes("/F")).length, 1);
  assert.equal(installDailyRefreshSchedule(plan, { ...options, adapter: h.adapter }).changed, false, "second daily on is idempotent");
  assert.equal(h.calls.filter(args => args[0] === "/Create").length, 1);
  assert.equal(removeDailyRefreshSchedule(plan, { ...options, adapter: h.adapter }).removed, true);
});


test("install refuses a marked semantic edit at the mutation boundary without rollback overwriting it", t => {
  const prior = buildDailyRefreshDefinition({ ...plan, source_plan_hash: "sha256:prior" }, options);
  for (const changed of [false, true]) {
    let queries = 0;
    const h = harness(t, { initial: fieldReadback(prior), transform: fieldReadback, beforeQuery: xml => {
      queries++;
      return changed && queries === 2 ? xml.replace("C:\\Runtime\\node.exe", "C:\\Foreign\\node.exe") : xml;
    } });
    const install = () => installDailyRefreshSchedule(plan, { ...options, adapter: h.adapter });
    if (changed) assert.throws(install, /changed before installation/);
    else assert.equal(install().verified, true, "unchanged green control replaces the old definition");
    assert.ok(queries >= 2, "both arms reached the mutation boundary");
    assert.equal(h.calls.filter(args => args[0] === "/Create").length, changed ? 0 : 1,
      "a concurrent semantic edit must not be overwritten by either install or rollback");
    if (changed) assert.ok(h.native.includes("C:\\Foreign\\node.exe"));
  }
});


// WIN-DAILY-FIX-2 regressions run through the native adapter, not a parallel parser.
test("FIX-2 full start boundary is verified and daily on repairs a future date", t => {
  const definition = buildDailyRefreshDefinition(plan, options);
  const h = harness(t, { initial: fieldReadback(definition), transform: fieldReadback });
  for (const boundary of ["2000-01-01T09:00:00", "2000-01-01T09:00:00.000"]) {
    h.native = fieldReadback(definition).replace("2000-01-01T09:00:00", boundary);
    assert.equal(statusDailyRefreshSchedule(plan, { ...options, adapter: h.adapter }).verified, true, "equivalent precision control");
  }
  h.native = fieldReadback(definition).replace("2000-01-01T", "2099-01-01T");
  assert.equal(statusDailyRefreshSchedule(plan, { ...options, adapter: h.adapter }).verified, false);
  assert.ok(h.calls.filter(args => args.includes("/XML")).length >= 3, "boundary comparison was reached");
  const repaired = installDailyRefreshSchedule(plan, { ...options, adapter: h.adapter });
  assert.equal(repaired.changed, true);
  assert.equal(repaired.verified, true);
  assert.equal(h.calls.filter(args => args[0] === "/Create").length, 1);
});

test("FIX-2 task security descriptors are refused even with an intact marker", t => {
  const definition = buildDailyRefreshDefinition(plan, options);
  const h = harness(t, { initial: fieldReadback(definition) });
  assert.equal(statusDailyRefreshSchedule(plan, { ...options, adapter: h.adapter }).verified, true, "default ACL control");
  for (const descriptor of ["<SecurityDescriptor>D:(A;;FA;;;WD)</SecurityDescriptor>", "<SecurityDescriptor/>"]) {
    h.native = fieldReadback(definition).replace("</RegistrationInfo>", `${descriptor}</RegistrationInfo>`);
    const before = h.calls.length;
    assert.equal(statusDailyRefreshSchedule(plan, { ...options, adapter: h.adapter }).verified, false);
    assert.ok(h.calls.length > before, "ACL decision reached the native read");
    assert.equal(h.calls.filter(args => ["/Create", "/Change", "/Delete"].includes(args[0])).length, 0);
  }
});

test("FIX-2 isolated account names cannot inherit a qualified account SID", t => {
  const definition = buildDailyRefreshDefinition(plan, options);
  const h = harness(t, { initial: windowsReadback(definition, "FIXTURE\\owner") });
  assert.equal(statusDailyRefreshSchedule(plan, { ...options, adapter: h.adapter }).verified, true, "qualified current-user control");
  for (const user of ["owner", "OTHER\\owner"]) {
    h.native = windowsReadback(definition, user);
    const before = h.calls.length;
    assert.equal(statusDailyRefreshSchedule(plan, { ...options, adapter: h.adapter }).verified, false);
    assert.ok(h.calls.length > before, "principal decision reached native inspection");
  }
  assert.equal(h.calls.filter(args => ["/Create", "/Change", "/Delete"].includes(args[0])).length, 0);
});

test("FIX-2 restore refuses paused command edits before any enable or replacement", t => {
  for (const changed of [false, true]) {
    const h = harness(t, { initial: fieldReadback(buildDailyRefreshDefinition(plan, options)) });
    const snapshot = pauseDailyRefreshSchedule(plan, { ...options, adapter: h.adapter });
    assert.equal(h.adapter.read(plan.identity).enabled, false, "pause decision reached native disable");
    if (changed) h.native = h.native.replace("C:\\Runtime\\node.exe", "C:\\Foreign\\node.exe");
    const before = h.calls.length;
    const restore = () => restoreDailyRefreshSchedule(snapshot, { ...options, adapter: h.adapter });
    if (changed) assert.throws(restore, /restore|changed/);
    else assert.equal(restore().verified, true, "unchanged restore control");
    assert.ok(h.calls.length > before, "restore reached native projection");
    assert.equal(h.calls.slice(before).filter(args => ["/Create", "/Change", "/Delete"].includes(args[0])).length, changed ? 0 : 1);
    assert.equal(h.adapter.read(plan.identity).enabled, !changed);
  }
});

for (const pipeEncoding of ["latin1", "oem", "utf8"]) {
test(`FIX-2 ${pipeEncoding} XML preserves accented paths through verification and rollback`, t => {
  const unicodeOptions = { ...options, nodePath: String.raw`C:\Profiles\ownér\node.exe` };
  const definition = buildDailyRefreshDefinition(plan, unicodeOptions);
  let creates = 0;
  const h = harness(t, { initial: fieldReadback(definition), pipeEncoding, transform: value => {
    const result = fieldReadback(value);
    return ++creates === 1 ? result.replace("<WakeToRun>true", "<WakeToRun>false") : result;
  } });
  assert.equal(statusDailyRefreshSchedule(plan, { ...unicodeOptions, adapter: h.adapter }).verified, true);
  assert.ok(h.calls.some(args => args.includes("-EncodedCommand")), "ambiguous bytes reached lossless native export");
  assert.throws(() => installDailyRefreshSchedule({ ...plan, source_plan_hash: "sha256:new" }, { ...unicodeOptions, adapter: h.adapter }), error => {
    assert.match(error.message, /exact readback/);
    assert.doesNotMatch(error.message, /rollback also failed/);
    return true;
  });
  assert.equal(creates, 2, "replacement and rollback both reached registration");
  assert.ok(h.native.includes("ownér"));
  assert.ok(!h.native.includes("\ufffd"));
  assert.equal(statusDailyRefreshSchedule(plan, { ...unicodeOptions, adapter: h.adapter }).verified, true);
});
}


test("FIX-2 restore rejects an edit that arrives inside the enable mutation lock", t => {
  for (const changed of [false, true]) {
    let restoring = false;
    let reads = 0;
    const h = harness(t, { initial: fieldReadback(buildDailyRefreshDefinition(plan, options)), beforeQuery: value => {
      if (restoring && ++reads === 3 && changed) return value.replace("C:\\Runtime\\node.exe", "C:\\Foreign\\node.exe");
      return value;
    } });
    const snapshot = pauseDailyRefreshSchedule(plan, { ...options, adapter: h.adapter });
    restoring = true;
    const before = h.calls.length;
    const restore = () => restoreDailyRefreshSchedule(snapshot, { ...options, adapter: h.adapter });
    if (changed) assert.throws(restore, /changed before restore/);
    else assert.equal(restore().verified, true);
    assert.ok(reads >= 3, "both arms reached the locked read immediately before enabling");
    assert.equal(h.calls.slice(before).filter(args => args[0] === "/Change").length, changed ? 0 : 1);
    assert.equal(h.adapter.read(plan.identity).enabled, !changed);
  }
});


test("FIX-2 intentional replacement rollback requires its saved verified readback", t => {
  for (const changed of [false, true]) {
    const oldDefinition = buildDailyRefreshDefinition(plan, options);
    const h = harness(t, { initial: fieldReadback(oldDefinition), transform: fieldReadback });
    const snapshot = { identity: plan.identity, exists: true, enabled: true, definition: h.adapter.read(plan.identity).definition };
    const replacement = installDailyRefreshSchedule({ ...plan, source_plan_hash: "sha256:replacement" }, { ...options, adapter: h.adapter });
    assert.equal(replacement.verified, true, "intentional replacement reached exact readback");
    if (changed) h.native = h.native.replace("C:\\Runtime\\node.exe", "C:\\Foreign\\node.exe");
    const before = h.calls.length;
    const restore = () => restoreDailyRefreshSchedule(snapshot, { ...options, adapter: h.adapter, expectedReplacement: replacement.readback });
    if (changed) assert.throws(restore, /changed before restore/);
    else assert.equal(restore().verified, true);
    assert.ok(h.calls.length > before, "rollback compared the saved replacement with current XML");
    assert.equal(h.calls.slice(before).filter(args => ["/Create", "/Change", "/Delete"].includes(args[0])).length, changed ? 0 : 1);
    if (!changed) assert.equal(statusDailyRefreshSchedule(plan, { ...options, adapter: h.adapter }).verified, true);
  }
});


test("FIX-2 lossless export failure refuses install before any native mutation", t => {
  const unicodeOptions = { ...options, nodePath: String.raw`C:\Profiles\ownér\node.exe` };
  for (const denied of [false, true]) {
    const h = harness(t, { initial: fieldReadback(buildDailyRefreshDefinition(plan, unicodeOptions)), pipeEncoding: "latin1", unicodeReadFailure: denied });
    const install = () => installDailyRefreshSchedule(plan, { ...unicodeOptions, adapter: h.adapter });
    if (denied) assert.throws(install, /decoded losslessly/);
    else assert.equal(install().verified, true, "readable Unicode export control");
    assert.ok(h.calls.some(args => args.includes("-EncodedCommand")), "lossless export was attempted");
    assert.equal(h.calls.filter(args => ["/Create", "/Change", "/Delete"].includes(args[0])).length, 0);
  }
});


for (const action of ["rollback", "restore"]) test(`FIX-3 COM ${action} registers exactly one BOM`, t => {
  const unicodeOptions = { ...options, nodePath: String.raw`C:\Profiles\ownér\node.exe` };
  const definition = buildDailyRefreshDefinition(plan, unicodeOptions);
  let creates = 0;
  const h = harness(t, { initial: fieldReadback(definition), pipeEncoding: "latin1", strictRegistration: true,
    transform: value => {
      const xml = fieldReadback(value);
      return action === "rollback" && ++creates === 1 ? xml.replace("<WakeToRun>true", "<WakeToRun>false") : xml;
    } });
  assert.equal(statusDailyRefreshSchedule(plan, { ...unicodeOptions, adapter: h.adapter }).verified, true, "green read control");
  if (action === "rollback") {
    assert.throws(() => installDailyRefreshSchedule({ ...plan, source_plan_hash: "sha256:new" }, { ...unicodeOptions, adapter: h.adapter }), error => {
      assert.match(error.message, /exact readback/);
      assert.doesNotMatch(error.message, /rollback also failed/);
      return true;
    });
  } else {
    const snapshot = pauseDailyRefreshSchedule(plan, { ...unicodeOptions, adapter: h.adapter });
    h.native = null;
    assert.equal(restoreDailyRefreshSchedule(snapshot, { ...unicodeOptions, adapter: h.adapter }).verified, true);
  }
  assert.ok(h.calls.some(args => args.includes("-EncodedCommand")), "COM read was reached");
  assert.equal(h.registrations.length, action === "rollback" ? 2 : 1, "re-registration was reached");
  for (const bytes of h.registrations) assert.equal(bytes.subarray(0, 4).toString("hex"), "fffe3c00");
  assert.equal(statusDailyRefreshSchedule(plan, { ...unicodeOptions, adapter: h.adapter }).verified, true);
});

test("FIX-3 restricted PowerShell has specific refusal and never verifies", t => {
  const unicodeOptions = { ...options, nodePath: String.raw`C:\Profiles\ownér\node.exe` };
  for (const restricted of [false, true]) {
    const h = harness(t, { initial: fieldReadback(buildDailyRefreshDefinition(plan, unicodeOptions)), pipeEncoding: "latin1", unicodeStatus: restricted ? 73 : null });
    const inspect = () => statusDailyRefreshSchedule(plan, { ...unicodeOptions, adapter: h.adapter });
    if (restricted) assert.throws(inspect, error => {
      assert.equal(error.code, "DAILY_REFRESH_INSPECTION_UNKNOWN");
      assert.equal(error.message, "PowerShell is restricted on this PC, so daily refresh can't verify its task here");
      return true;
    });
    else assert.equal(inspect().verified, true);
    assert.equal(h.calls.filter(args => args.includes("-EncodedCommand")).length, 1);
    assert.equal(h.calls.filter(args => ["/Create", "/Change", "/Delete"].includes(args[0])).length, 0);
  }
});

test("FIX-3 ASCII XML inspection spawns only schtasks; ambiguous bytes use COM", t => {
  for (const unicode of [false, true]) {
    const definitionOptions = unicode ? { ...options, nodePath: String.raw`C:\Profiles\ownér\node.exe` } : options;
    const h = harness(t, { initial: fieldReadback(buildDailyRefreshDefinition(plan, definitionOptions)), pipeEncoding: "latin1" });
    assert.equal(h.adapter.read(plan.identity).definition.native_contract_valid, true);
    assert.equal(h.calls.filter(args => args.includes("/XML")).length, 1);
    assert.equal(h.calls.filter(args => args.includes("-EncodedCommand")).length, unicode ? 1 : 0);
    assert.equal(h.calls.length, unicode ? 2 : 1, "all child spawns counted");
  }
});

for (const prior of [false, true]) for (const edit of [false, true]) {
  test(`FIX-3 daily on expectation failure rolls back its captured replacement (${prior}, ${edit})`, async t => {
    const h = harness(t, { transform: fieldReadback });
    const path = join(h.home, "brain.manifest.json");
    const fixture = { brain: { domain: "brain.example.invalid" }, corpora: { google_drive: { enabled: true } },
      operations: { daily_refresh: { enabled: false, timezone: "UTC" } } };
    writeFileSync(path, JSON.stringify(fixture));
    writeFileSync(join(h.home, ".brain-admin-key"), randomBytes(32).toString("hex"), { mode: 0o600 });
    const activePlan = { ...plan, manifest_path: path, timezone_matches_machine: true, unsupported_sources: 0 };
    const old = buildDailyRefreshDefinition({ ...activePlan, source_plan_hash: "sha256:old" }, options);
    h.native = prior ? fieldReadback(old) : null;
    let expectations = 0;
    await assert.rejects(() => cmdDaily(["on", path], {
      platform: "win32", home: h.home, lifecycleLockHeld: true, quiet: true,
      planDailyRefresh: async () => activePlan, schedulerAdapter: h.adapter, schedulerOptions: options,
      resolveAdminKey: () => readFileSync(join(h.home, ".brain-admin-key"), "utf8"),
      resolveBaseUrl: async () => "https://brain.example.invalid",
      postSourceExpectation: async () => { expectations++; if (edit) h.native = h.native.replace(String.raw`C:\Runtime\node.exe`, String.raw`C:\Foreign\node.exe`); throw new Error("synthetic expectation failure"); },
      readSourceInventory: async () => ({ sources: [] }),
    }), error => {
      assert.match(error.message, /synthetic expectation failure/);
      if (edit) assert.match(error.message, /could not be restored/);
      else assert.doesNotMatch(error.message, /could not be restored|outside edit/);
      return true;
    });
    assert.equal(expectations, 1, "mid-install failure happened after native install and readback");
    assert.equal(h.registrations.length, prior && !edit ? 2 : 1);
    assert.equal(h.calls.filter(args => args[0] === "/Delete").length, !prior && !edit ? 1 : 0);
    if (edit) assert.ok(h.native.includes(String.raw`C:\Foreign\node.exe`));
    else if (prior) assert.equal(h.adapter.read(plan.identity).definition.definition_hash, old.definition_hash);
    else assert.equal(h.native, null);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).operations.daily_refresh.enabled, false);
  });
}


test("FIX-3 lossy ASCII paths cannot verify a different Unicode action", t => {
  const unicodeOptions = { ...options, nodePath: String.raw`C:\Profiles\ownér\node.exe` };
  for (const lossy of [false, true]) {
    const h = harness(t, { initial: fieldReadback(buildDailyRefreshDefinition(plan, unicodeOptions)),
      pipeEncoding: lossy ? "ascii-lossy" : "latin1" });
    assert.equal(statusDailyRefreshSchedule(plan, { ...unicodeOptions, adapter: h.adapter }).verified, !lossy);
    assert.equal(h.calls.filter(args => args.includes("/XML")).length, 1, "both arms reached the projection");
    assert.equal(h.calls.filter(args => args.includes("-EncodedCommand")).length, lossy ? 0 : 1);
    assert.equal(h.calls.filter(args => ["/Create", "/Change", "/Delete"].includes(args[0])).length, 0);
  }
});


test("FIX-3 QuickBooks recovery preserves the prior daily task when daily on itself fails", async t => {
  for (const fail of [false, true]) {
    const h = harness(t, { transform: fieldReadback, strictRegistration: true, pipeEncoding: "latin1" });
    const path = join(h.home, "brain.manifest.json");
    writeFileSync(path, JSON.stringify({ client: { slug: "fixture", timezone: "UTC" },
      brain: { domain: "brain.example.invalid" }, corpora: { google_drive: { enabled: true }, quickbooks: { enabled: true } },
      operations: { daily_refresh: { enabled: true, timezone: "UTC" }, quickbooks_schedule: { enabled: true } } }));
    const keyFile = join(h.home, ".brain-admin-key");
    writeFileSync(keyFile, randomBytes(32).toString("hex"), { mode: 0o600 });
    const activePlan = { ...plan, manifest_path: path, timezone_matches_machine: true, unsupported_sources: 0 };
    const prior = buildDailyRefreshDefinition({ ...activePlan, source_plan_hash: "sha256:prior" }, options);
    h.native = fieldReadback(prior);
    let posted = 0; let registered = 0;
    const run = () => reregisterAfterManifestChange(path, {
      platform: "win32", home: h.home, principal: `sid:${SID}`, localTimezone: "UTC",
      now: new Date("2026-10-14T09:00:00Z"), lifecycleLockHeld: true,
      cli: { buildConfiguredDailyPlan: async () => activePlan, cmdDaily },
      planDailyRefresh: async () => activePlan, schedulerAdapter: h.adapter, schedulerOptions: options,
      resolveAdminKey: () => readFileSync(keyFile, "utf8"), resolveBaseUrl: async () => "https://brain.example.invalid",
      postSourceExpectation: async () => { posted++; if (fail) throw new Error("synthetic expectation failure"); },
      readSourceInventory: async () => ({ sources: [] }),
      quickBooksStatus: () => ({ installed: false }),
      quickBooksRegister: () => { registered++; return { installed: true, verified: true }; },
      syncExpectations: async () => {},
    });
    if (fail) await assert.rejects(run, error => {
      assert.equal(error.code, "SCHEDULE_INSTALL_FAILED");
      assert.equal(error.rollback_verified, true);
      return true;
    });
    else assert.equal((await run()).verified, true);
    assert.equal(posted, 1, "failure is after the real daily command registered its replacement");
    assert.equal(registered, fail ? 0 : 1);
    assert.equal(h.registrations.length, fail ? 2 : 1);
    if (fail) assert.equal(h.adapter.read(plan.identity).definition.definition_hash, prior.definition_hash);
  }
});
