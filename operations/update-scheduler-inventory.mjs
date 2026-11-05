/** Local update inventory. File locators are private recovery material, never telemetry. */
import { spawnSync } from "node:child_process";
import { constants, existsSync, fstatSync, lstatSync, openSync, closeSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "./drive-scheduler.mjs";
import { FOLDER_SCHEDULER_SPEC } from "./folder-scheduler.mjs";
import { IMESSAGE_SCHEDULER_SPEC } from "./imessage-scheduler.mjs";
import { WHATSAPP_DRAIN_SCHEDULER_SPEC } from "./whatsapp-drain-scheduler.mjs";
import { SCHEDULED_PROVIDER_IDS, createProviderSchedulerSpec } from "./provider-scheduler.mjs";
import * as curated from "./curated-sync-scheduler.mjs";
import { curatedSourceLeaseOptions, inspectCuratedTargetContracts } from "./curated-dual-sync.mjs";
import { acquireSourceIngestLock } from "./source-ingest-lock.mjs";
import * as quickbooks from "./quickbooks-schedule.mjs";
import * as daemon from "./whatsapp-daemon.mjs";
import { quotePosixArgument, quotePowerShellArgument } from "./command-display.mjs";
import { quoteWindowsTaskArgument } from "./daily-refresh-scheduler.mjs";
import { dailyRefreshIdentity } from "./daily-refresh-plan.mjs";
import { renderCliCommands } from "./cli-guidance.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const nativeOptions = options => ({ platform: options.platform ?? process.platform,
  home: options.schedulerOptions?.home ?? homedir(), ...(options.legacySchedulerOptions || {}) });
const launch = options => options.launchctl ?? (args => spawnSync("/bin/launchctl", args, {
  encoding: "utf8", env: core.launchctlChildEnvironment(), timeout: 15_000, maxBuffer: 1024 * 1024,
}));
const desiredLoaded = snapshot => typeof snapshot.wasDisabled === "boolean" ? !snapshot.wasDisabled : snapshot.wasLoaded;
// Handles stay outside the durable snapshots. A retry reacquires them before
// mutation; a live update retains them until acceptance or recovery handoff.
const reservations = new WeakMap();

export function releaseUpdateSchedulerReservations(entries) {
  for (const entry of entries) {
    reservations.get(entry.snapshot)?.release();
    reservations.delete(entry.snapshot);
  }
}

export function reserveUpdateSchedulerWriters(entries, options = {}) {
  const native = nativeOptions(options);
  try {
    for (const entry of entries) {
      const snapshot = entry.snapshot;
      if (!snapshot?.exists) continue;
      const held = reservations.get(snapshot);
      if (held) { held.assertOwned(); continue; }
      const kind = snapshot.jobKind ?? ({ drive: "drive-ingest", folder: "folder-ingest", imessage: "imessage-capture" })[entry.kind] ??
        (entry.kind === "provider" ? `${entry.provider}-ingest` : null);
      const spec = genericJobs(native).find(([, item]) => item.kind === kind)?.[1];
      if (snapshot.jobKind !== "curated-sync" && !spec) continue;
      const plan = spec ? core.schedulerIdentity(options.manifestPath, { ...native, spec })
        : curated.buildCuratedSchedulerPlan(snapshot.planPath, native);
      if (core.schedulerLockHeld({ ...plan, spec: spec || { schedulerNoun: "curated scheduler" } }, native)) {
        throw new Error("scheduler writer is busy");
      }
      if (!spec) reservations.set(snapshot, acquireSourceIngestLock(curatedSourceLeaseOptions(plan.curatedPlan, {
        planDirectory: plan.planDirectory, home: native.home,
      })));
    }
  } catch {
    releaseUpdateSchedulerReservations(entries);
    throw new Error("scheduler writer is busy or its reservation could not be proved");
  }
}

function disabledLabels(options) {
  const result = launch(options)(["print-disabled", `gui/${options.uid ?? process.getuid?.()}`]);
  if (!result || result.error || result.signal || result.status !== 0 || !/disabled services\s*=\s*\{/u.test(String(result.stdout))) {
    throw new Error("native enablement could not be inspected");
  }
  const lines = String(result.stdout).split(/\r?\n/u).filter(line => line.includes("=>"));
  const values = lines.map(line => line.match(/^\s*"?([^"\s]+)"?\s*=>\s*(true|false|disabled|enabled)\s*$/u));
  if (values.some(value => !value)) throw new Error("native enablement has an unknown value");
  // macOS 27 uses words where earlier versions emitted boolean values.
  return new Set(values.filter(value => ["true", "disabled"].includes(value[2])).map(value => value[1]));
}
const genericJobs = options => [
  ["google_drive", core.DRIVE_SCHEDULER_SPEC], ["local_folder", FOLDER_SCHEDULER_SPEC],
  ["imessage", IMESSAGE_SCHEDULER_SPEC], ["whatsapp", WHATSAPP_DRAIN_SCHEDULER_SPEC],
  ...SCHEDULED_PROVIDER_IDS.map(key => [key, createProviderSchedulerSpec(key, options)]),
];
const sameFile = (a, b) => { try { return realpathSync(a) === realpathSync(b); } catch { return false; } };
const command = (script, action, path) => [quotePosixArgument(process.execPath), quotePosixArgument(join(ROOT, "operations", script)), action, quotePosixArgument(path)].join(" ");

const displayablePath = path => typeof path === "string" && path.length > 0 && !/[\u0000-\u001f\u007f]/u.test(path);

function fixFor(kind, manifestPath, planPath, jobPath) {
  if (kind === "curated-sync") {
    if (displayablePath(planPath) && isAbsolute(planPath)) return command("curated-sync-scheduler.mjs", "reinstall", planPath);
    // Discovery can refuse before a plan locator is known. Never fabricate a
    // runnable reinstall argument from an unreadable or unbound definition.
    const job = displayablePath(jobPath) ? quotePosixArgument(jobPath) : "the local curated-sync job file";
    return `Inspect ${job}; recover its reviewed private plan, then use curated-sync-scheduler.mjs reinstall with that plan before retrying the update.`;
  }
  if (!displayablePath(manifestPath)) return "Inspect the local scheduler definition and recover its reviewed manifest before retrying the update.";
  if (kind === "whatsapp-daemon") return command("whatsapp-daemon.mjs", "install", manifestPath);
  if (kind === "quickbooks-task") return `${renderCliCommands("brain update", { platform: "win32" })} ${quotePowerShellArgument(manifestPath)}`;
  if (kind === "daily") return `${renderCliCommands("brain update")} ${(process.platform === "win32" ? quotePowerShellArgument : quotePosixArgument)(manifestPath)}`;
  const script = kind === "drive-ingest" ? "drive-scheduler.mjs" : kind === "folder-ingest" ? "folder-scheduler.mjs"
    : kind === "imessage-capture" ? "imessage-scheduler.mjs" : kind === "whatsapp-drain" ? "whatsapp-drain-scheduler.mjs" : "provider-scheduler.mjs";
  const provider = kind.endsWith("-ingest") && !["drive-ingest", "folder-ingest"].includes(kind) ? `${kind.slice(0, -7)} ` : "";
  return command(script, `${provider}install`, manifestPath);
}
export { fixFor as updateSchedulerFix };

export function schedulerUpdateRow(kind, state, reason = null, fix = null) {
  const label = ({ "drive-ingest": "Drive", "folder-ingest": "Folder", "imessage-capture": "iMessage capture",
    "whatsapp-drain": "WhatsApp drain", "whatsapp-daemon": "WhatsApp capture", "curated-sync": "Curated sync",
    "quickbooks-task": "QuickBooks", daily: "Daily imports" })[kind] ?? kind;
  return { kind, label, state, ...(reason ? { reason } : {}), ...(fix ? { fix } : {}) };
}

export function renderUpdateSchedulerRows(rows) {
  return rows.map(row => `${row.label}: ${row.state}${row.reason ? ` (${row.reason})` : ""}${row.fix ? `\nFix: ${row.fix}` : ""}`).join("\n");
}

export function requireUpdateSchedulers(rows) {
  if (rows.some(row => row.state === "COULD NOT MOVE")) {
    const error = new Error(`Update incomplete.\n${renderUpdateSchedulerRows(rows)}`);
    error.code = "UPDATE_SCHEDULERS_INCOMPLETE";
    error.scheduler_results = rows;
    throw error;
  }
}

function failed(kind, manifestPath, reason, planPath) {
  const row = schedulerUpdateRow(kind, "COULD NOT MOVE", reason, fixFor(kind, manifestPath, planPath));
  requireUpdateSchedulers([row]);
}

function captureProofFailure(error, spec) {
  // Native errors and filesystem errors can contain private paths or output.
  // Project only the failed proof; retain the exact capture checks underneath.
  const message = typeof error?.message === "string" ? error.message : "";
  const proof = new Map([
    [`the installed ${spec.schedulerNoun} launch state could not be inspected`, "launch state"],
    [`the installed ${spec.schedulerNoun} is running or its run state is unknown`, "idle state"],
    ["the installed scheduler definition does not match the stable owner argument contract", "manifest binding"],
    [`the loaded ${spec.schedulerNoun} does not match its installed definition`, "loaded definition"],
    [`the loaded ${spec.schedulerNoun} has no readable installed definition`, "saved definition"],
  ]).get(message) ?? (/^the loaded scheduler /u.test(message) ? "loaded definition"
    : /^the installed scheduler definition /u.test(message) ? "saved definition" : "scheduler inspection");
  return `${proof} proof failed`;
}

// Use the same bounded, owner-only input boundary for discovery as for capture.
// Reading a label must never turn a symlink or a file swap into authority.
function readPlist(path, options) {
  const before = lstatSync(path);
  const uid = options.uid ?? process.getuid?.();
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== uid ||
      (before.mode & 0o177) || before.size < 1 || before.size > 256 * 1024) throw new Error("unsafe scheduler definition");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd);
    const bytes = readFileSync(fd);
    const after = lstatSync(path);
    if ([opened, after].some(info => info.ino !== before.ino || info.dev !== before.dev || info.size !== before.size || info.mtimeMs !== before.mtimeMs)) {
      throw new Error("scheduler definition changed during inspection");
    }
    let plist;
    if (options.parseInstalledPlist) plist = options.parseInstalledPlist(bytes);
    else {
      const parsed = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], {
        input: bytes, encoding: "utf8", env: { LC_ALL: "C" }, timeout: 15_000, maxBuffer: 1024 * 1024,
      });
      if (parsed.error || parsed.status !== 0) throw new Error("unreadable scheduler definition");
      plist = JSON.parse(parsed.stdout);
    }
    if (!plist || typeof plist.Label !== "string" || !Array.isArray(plist.ProgramArguments) ||
        plist.ProgramArguments.some(arg => typeof arg !== "string" || !arg || /[\r\n\0]/u.test(arg))) throw new Error("unsafe scheduler arguments");
    return { plist, serialized: bytes.toString("utf8") };
  } finally { closeSync(fd); }
}

function loadedArguments(text) {
  const blocks = [...String(text ?? "").matchAll(/^\s*arguments\s*=\s*\{\r?\n([\s\S]*?)^\s*\}/gmu)];
  if (blocks.length !== 1) throw new Error("loaded arguments are unknown");
  return blocks[0][1].split(/\r?\n/u).map(line => line.trim()).filter(Boolean).map(line => line.startsWith('"') ? JSON.parse(line) : line);
}

function inspectNative(snapshot, options, { allowRunning = false } = {}) {
  const installed = readPlist(snapshot.path, options);
  const result = launch(options)(["print", snapshot.service]);
  if (!result || result.error || result.signal || ![0, 113].includes(result.status)) throw new Error("native inspection failed");
  if (result.status === 0) {
    const paths = [...String(result.stdout).matchAll(/^\s*path\s*=\s*(.+?)\s*$/gmu)];
    if (paths.length !== 1 || paths[0][1] !== snapshot.path ||
        JSON.stringify(loadedArguments(result.stdout)) !== JSON.stringify(installed.plist.ProgramArguments)) throw new Error("loaded definition differs from saved definition");
    if (!allowRunning && /\bstate\s*=\s*running\b|\bpid\s*=\s*[1-9][0-9]*/u.test(result.stdout)) throw new Error("job is running; wait for it to finish");
  }
  return { ...installed, wasLoaded: result.status === 0,
    loadedPolicyKnown: result.status === 0 && [...String(result.stdout).matchAll(/^\s*properties\s*=/gmu)].length === 1,
    loadedRunAtLoad: result.status === 0 && /\brunatload\b/iu.test(String(result.stdout)) };
}

export function verifyUpdateSchedulerDefinition(plan, expected, options = {}, enabled = true) {
  const readback = inspectNative({ path: plan.plistPath, service: plan.service }, options, { allowRunning: true });
  if (readback.serialized !== expected || readback.wasLoaded !== enabled ||
      (enabled && (!readback.loadedPolicyKnown || readback.loadedRunAtLoad) && /<key>RunAtLoad<\/key>\s*<false\s*\/>/u.test(expected)) ||
      JSON.stringify(readback.plist.ProgramArguments) !== JSON.stringify(plan.programArguments)) throw new Error("saved and loaded definitions did not read back exactly");
  if (!existsSync(plan.nodePath) || !existsSync(plan.schedulerPath) || (plan.brainPath && !existsSync(plan.brainPath))) throw new Error("new runtime is missing");
  if (disabledLabels(options).has(plan.label) === enabled) throw new Error("native enablement did not read back exactly");
  return true;
}

function qbContext(m, manifestPath, options) {
  const module = options.quickBooksScheduler ?? quickbooks;
  const schedulerOptions = { ...(options.schedulerOptions || {}), ...(options.quickBooksSchedulerOptions || {}) };
  const plan = module.planQuickBooksSchedule({ m, manifestPath, ...options, platform: "win32" });
  const adapter = schedulerOptions.adapter ?? module.createQuickBooksScheduleAdapter(schedulerOptions);
  return { module, plan, adapter, schedulerOptions: { ...schedulerOptions, adapter } };
}

function ownedQuickBooksState(state, plan, manifestPath) {
  const definition = state?.definition;
  const contract = definition?.native_contract;
  const runner = typeof contract?.arguments === "string" ? contract.arguments.match(/^"([^"]+)" /u)?.[1] : null;
  const tail = ["quickbooks-run", manifestPath, "--definition-hash", definition?.definition_hash ?? ""].map(quoteWindowsTaskArgument).join(" ");
  return state?.owned === true && definition?.native_contract_valid === true &&
    definition.identity?.id === plan.identity.id && definition.identity?.principal === plan.identity.principal &&
    contract?.user_id === plan.identity.principal.slice(4) &&
    win32.isAbsolute(contract.command) && win32.basename(contract.command).toLowerCase() === "node.exe" &&
    win32.isAbsolute(runner || "") && win32.basename(runner).toLowerCase() === "quickbooks-schedule.mjs" &&
    contract.arguments === `${quoteWindowsTaskArgument(runner)} ${tail}` && Boolean(definition.serialized);
}

function sameQuickBooksContract(state, expected, plan, manifestPath) {
  return ownedQuickBooksState(state, plan, manifestPath) && ownedQuickBooksState(expected, plan, manifestPath) &&
    /^sha256:[a-f0-9]{64}$/u.test(String(state.definition.native_definition_hash)) &&
    state.definition.native_definition_hash === expected.definition.native_definition_hash &&
    state.definition.definition_hash === expected.definition.definition_hash;
}

export function validateUpdateSchedulerSnapshot(m, manifestPath, entry, options = {}) {
  const snapshot = entry.snapshot;
  if (!snapshot?.exists || typeof snapshot.serialized !== "string" || typeof snapshot.wasLoaded !== "boolean") throw new Error("scheduler recovery snapshot is malformed");
  if (snapshot.jobKind === "quickbooks-task") {
    const q = qbContext(m, manifestPath, options);
    if (snapshot.service !== q.plan.identity.id || !sameFile(snapshot.path, manifestPath) || !ownedQuickBooksState(snapshot.state, q.plan, manifestPath)) throw new Error("task recovery ownership changed");
    return;
  }
  const native = nativeOptions(options);
  if (snapshot.jobKind === "curated-sync") {
    const plan = curated.buildCuratedSchedulerPlan(snapshot.planPath, native);
    const contracts = inspectCuratedTargetContracts(plan.curatedPlan, { planDirectory: plan.planDirectory });
    if (Object.keys(contracts).length !== 1 || !sameFile(contracts.cloudflare.manifestPath, manifestPath) ||
        snapshot.path !== plan.plistPath || snapshot.service !== plan.service) throw new Error("curated recovery manifest ownership changed");
    return;
  }
  if (snapshot.jobKind === "whatsapp-daemon") {
    const reference = daemon.whatsappDaemonReference(manifestPath, { ...native, ...(options.whatsappDaemonOptions || {}) });
    if (snapshot.path !== reference.plistPath || snapshot.service !== reference.service ||
        readPlist(snapshot.path, native).plist.EnvironmentVariables?.BRAIN_MANIFEST_PATH !== resolve(manifestPath)) throw new Error("capture recovery manifest ownership changed");
    return;
  }
  const spec = genericJobs(native).find(([, item]) => item.kind === snapshot.jobKind)?.[1];
  if (!spec) throw new Error("scheduler recovery kind is unknown");
  const identity = core.schedulerIdentity(manifestPath, { ...native, spec });
  if (snapshot.path !== identity.plistPath || snapshot.service !== `gui/${native.uid ?? process.getuid?.()}/${identity.label}`) throw new Error("scheduler recovery identity changed");
}

export async function captureAdditionalUpdateSchedulers(m, manifestPath, options = {}, captured = []) {
  const platform = options.platform ?? process.platform;
  const entries = [];
  const refusals = [];
  const refuse = (kind, reason, planPath, jobPath) => refusals.push(schedulerUpdateRow(kind, "COULD NOT MOVE", reason, fixFor(kind, manifestPath, planPath, jobPath)));
  if (platform === "win32") {
    // Permanent daily and historical bridge tasks are inventoried by their
    // existing transaction. This is the remaining product Scheduled Task kind.
    if (!m.operations?.quickbooks_schedule && !m.corpora?.quickbooks && !m.corpora?.quickbooks_desktop && !options.quickBooksSchedulerOptions?.adapter && !options.nativeSchedulerInventory) return entries;
    const q = qbContext(m, manifestPath, options);
    const state = q.adapter.read(q.plan.identity);
    if (state?.exists) {
      const definition = state.definition;
      if (!ownedQuickBooksState(state, q.plan, manifestPath)) {
        failed("quickbooks-task", manifestPath, "task ownership or manifest binding could not be proved");
      }
      entries.push({ kind: "inventory", sourceKey: "quickbooks", snapshot: { jobKind: "quickbooks-task", exists: true,
        wasLoaded: state.enabled === true, path: manifestPath, service: q.plan.identity.id,
        serialized: definition.serialized, state } });
    }
    return entries;
  }
  if (platform !== "darwin") return entries;
  const native = nativeOptions(options);
  const directory = join(native.home, "Library", "LaunchAgents");
  const files = existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith(".plist")) : [];
  const loadedLabels = new Set();
  let disabled = new Set();
  if (existsSync(directory) || native.launchctl || options.nativeSchedulerInventory) {
    const listing = launch(native)(["list"]);
    if (!listing || listing.error || listing.signal || listing.status !== 0) {
      failed("daily", manifestPath, "native job inventory could not be read");
    }
    for (const match of String(listing.stdout).matchAll(/^\s*(?:-|\d+)\s+-?\d+\s+(com\.(?:brain-installer\.[a-z0-9.-]+|financialbrain\.daily\.v1-[a-f0-9]+))\s*$/gmu)) loadedLabels.add(match[1]);
    try { disabled = disabledLabels(native); } catch { failed("daily", manifestPath, "native enablement inventory could not be read"); }
    for (const entry of captured) {
      if (options.preserveSnapshotIntent) continue;
      if (!entry.snapshot?.exists) continue;
      const label = entry.snapshot.service?.split("/").at(-1);
      if (entry.snapshot.wasLoaded && disabled.has(label)) refuse(entry.snapshot.jobKind ?? label,
        "job is disabled but still loaded; inspect it before retrying", entry.snapshot.planPath, entry.snapshot.path);
      entry.snapshot = { ...entry.snapshot, wasDisabled: disabled.has(label) };
    }
  }
  const dailyLabel = `com.financialbrain.daily.${dailyRefreshIdentity(m, `uid:${native.uid ?? process.getuid?.()}`).id}`;
  if (loadedLabels.has(dailyLabel) && !files.includes(`${dailyLabel}.plist`)) refuse("daily", "loaded daily job has no readable saved definition; inspect it before retrying");
  const alreadyCaptured = new Set(captured.filter(entry => entry.snapshot?.exists).map(entry => entry.snapshot.path));
  for (const [sourceKey, spec] of genericJobs(native)) {
    const identity = core.schedulerIdentity(manifestPath, { ...native, spec });
    if (alreadyCaptured.has(identity.plistPath)) continue;
    if (!files.includes(basename(identity.plistPath))) {
      if (loadedLabels.has(identity.label)) refuse(spec.kind, "loaded job has no readable saved definition; inspect it before retrying");
      continue;
    }
    try {
      const snapshot = core.captureInstalledSchedulerDefinition(manifestPath, { ...native, spec });
      if (snapshot.wasLoaded && disabled.has(identity.label)) { refuse(spec.kind, "job is disabled but still loaded; inspect it before retrying"); continue; }
      entries.push({ kind: "inventory", sourceKey, snapshot: { ...snapshot, jobKind: spec.kind, wasDisabled: disabled.has(identity.label) } });
    } catch (error) {
      refuse(spec.kind, captureProofFailure(error, spec));
    }
  }
  for (const file of files) {
    if (!/^com\.brain-installer\.[a-z0-9-]+\.curated-sync\.plist$/u.test(file)) continue;
    const path = join(directory, file);
    if (alreadyCaptured.has(path)) continue;
    let observed;
    try { observed = readPlist(path, native); } catch { refuse("curated-sync", "candidate definition could not be read safely; inspect the local job", undefined, path); continue; }
    const args = observed.plist.ProgramArguments;
    // Inspect the private plan's target locators before claiming this job.
    // A foreign plan is ignored even when its label resembles this Brain.
    if (args.length !== 6 || args[2] !== "run" || !isAbsolute(args[3])) { refuse("curated-sync", "candidate plan binding could not be proved; inspect the local job", undefined, path); continue; }
    let plan;
    let contracts;
    try {
      plan = curated.buildCuratedSchedulerPlan(args[3], native);
      contracts = inspectCuratedTargetContracts(plan.curatedPlan, { planDirectory: plan.planDirectory });
    } catch { refuse("curated-sync", "candidate plan ownership could not be proved", args[3], path); continue; }
    if (!Object.values(contracts).some(target => sameFile(target.manifestPath, manifestPath))) continue;
    if (Object.keys(contracts).length !== 1) { refuse("curated-sync", "multiple target Brains require a coordinated repair", args[3], path); continue; }
    if (observed.plist.Label !== plan.label || path !== plan.plistPath || !isAbsolute(args[0]) || basename(args[0]) !== "node" ||
        !isAbsolute(args[1]) || basename(args[1]) !== "curated-sync-scheduler.mjs" || args[4] !== "--config-hash" || !/^[a-f0-9]{64}$/u.test(args[5])) {
      refuse("curated-sync", "stable plan and argument ownership could not be proved", args[3], path); continue;
    }
    const snapshot = { exists: true, path, service: plan.service, jobKind: "curated-sync", planPath: args[3] };
    try { Object.assign(snapshot, inspectNative(snapshot, native)); } catch { refuse("curated-sync", "native ownership or idle state could not be proved", args[3], path); continue; }
    delete snapshot.plist;
    snapshot.wasDisabled = disabled.has(plan.label);
    if (snapshot.wasLoaded && snapshot.wasDisabled) { refuse("curated-sync", "job is disabled but still loaded; inspect it before retrying", args[3], path); continue; }
    entries.push({ kind: "inventory", sourceKey: "curated", snapshot });
  }
  for (const label of loadedLabels) {
    if (label.endsWith(".curated-sync") && !files.includes(`${label}.plist`)) refuse("curated-sync",
      "loaded job has no readable plan definition; inspect it before retrying", undefined, join(directory, `${label}.plist`));
  }
  const daemonReference = daemon.whatsappDaemonReference(manifestPath, { ...native, ...(options.whatsappDaemonOptions || {}) });
  if (files.includes(basename(daemonReference.plistPath)) && !alreadyCaptured.has(daemonReference.plistPath)) {
    // Shipped daemon plists have no manifest locator. A slug/data-directory
    // coincidence cannot authorize stopping another Brain's resident process.
    let observed;
    try { observed = readPlist(daemonReference.plistPath, native); } catch { refuse("whatsapp-daemon", "capture definition could not be read safely"); }
    if (observed && (observed.plist.Label !== daemonReference.label ||
        observed.plist.EnvironmentVariables?.BRAIN_MANIFEST_PATH !== resolve(manifestPath) ||
        observed.plist.EnvironmentVariables?.WA_DATA_DIR !== daemonReference.dataDir ||
        observed.plist.WorkingDirectory !== daemonReference.dataDir ||
        observed.plist.ProgramArguments.length !== 1 || !isAbsolute(observed.plist.ProgramArguments[0]))) {
      refuse("whatsapp-daemon", "capture definition has no matching manifest identity; review and reinstall this job explicitly");
      observed = null;
    }
    const snapshot = { exists: true, path: daemonReference.plistPath, service: daemonReference.service, jobKind: "whatsapp-daemon" };
    if (observed) try { Object.assign(snapshot, inspectNative(snapshot, native, { allowRunning: true })); } catch { refuse("whatsapp-daemon", "native capture identity could not be proved"); observed = null; }
    delete snapshot.plist;
    snapshot.wasDisabled = disabled.has(daemonReference.label);
    if (snapshot.wasLoaded && snapshot.wasDisabled) { refuse("whatsapp-daemon", "capture is disabled but still loaded; inspect it before retrying"); observed = null; }
    if (observed) entries.push({ kind: "inventory", sourceKey: "whatsapp", snapshot });
  }
  if (loadedLabels.has(daemonReference.label) && !files.includes(basename(daemonReference.plistPath))) refuse("whatsapp-daemon", "loaded capture has no readable saved definition");
  if (refusals.length) requireUpdateSchedulers([...refusals, ...entries.map(entry => schedulerUpdateRow(entry.snapshot.jobKind,
    "COULD NOT MOVE", "update did not start because another job needs repair", fixFor(entry.snapshot.jobKind, manifestPath, entry.snapshot.planPath, entry.snapshot.path)))]);
  try { reserveUpdateSchedulerWriters(entries, { ...options, manifestPath }); } catch {
    failed("daily", manifestPath, "scheduler writer is busy or its reservation could not be proved");
  }
  return entries;
}

export async function pauseAdditionalUpdateScheduler(m, manifestPath, entry, options = {}) {
  validateUpdateSchedulerSnapshot(m, manifestPath, entry, options);
  const snapshot = entry.snapshot;
  if (snapshot.jobKind === "quickbooks-task") {
    const q = qbContext(m, manifestPath, options);
    const current = q.adapter.read(q.plan.identity);
    if (JSON.stringify(current) !== JSON.stringify(snapshot.state)) throw new Error("QuickBooks task changed after capture");
    q.adapter.setEnabled(q.plan.identity, false, { expected: current });
    const paused = q.adapter.read(q.plan.identity);
    if (paused.enabled !== false || !sameQuickBooksContract(paused, snapshot.state, q.plan, manifestPath)) throw new Error("QuickBooks pause readback failed");
    return snapshot;
  }
  const native = nativeOptions(options);
  const spec = genericJobs(native).find(([, item]) => item.kind === snapshot.jobKind)?.[1];
  if (spec) return core.pauseScheduler(manifestPath, { ...native, spec, authorizedSnapshot: snapshot });
  const current = inspectNative(snapshot, native, { allowRunning: snapshot.jobKind === "whatsapp-daemon" });
  if (current.serialized !== snapshot.serialized || current.wasLoaded !== snapshot.wasLoaded) throw new Error("curated job changed after capture");
  for (const args of [["disable", snapshot.service], ...(snapshot.wasLoaded ? [["bootout", snapshot.service]] : [])]) {
    if (launch(native)(args)?.status !== 0) throw new Error("curated pause failed");
  }
  const paused = inspectNative(snapshot, native);
  if (paused.wasLoaded || paused.serialized !== snapshot.serialized) throw new Error("curated pause readback failed");
  return snapshot;
}

export async function restoreAdditionalUpdateScheduler(m, manifestPath, entry, options = {}) {
  validateUpdateSchedulerSnapshot(m, manifestPath, entry, options);
  const snapshot = entry.snapshot;
  if (snapshot.jobKind === "quickbooks-task") {
    const q = qbContext(m, manifestPath, options);
    return q.module.restoreQuickBooksSchedule(q.plan, snapshot.state, q.schedulerOptions);
  }
  const native = nativeOptions(options);
  const spec = genericJobs(native).find(([, item]) => item.kind === snapshot.jobKind)?.[1];
  if (spec) return core.restoreScheduler(manifestPath, snapshot, { ...native, spec });
  const current = inspectNative(snapshot, native, { allowRunning: true });
  if (current.serialized !== snapshot.serialized || (current.wasLoaded && !snapshot.wasLoaded)) throw new Error("curated job changed while paused");
  if (launch(native)([snapshot.wasDisabled === true ? "disable" : "enable", snapshot.service])?.status !== 0) throw new Error("curated restore failed");
  if (snapshot.wasLoaded && !current.wasLoaded && launch(native)(["bootstrap", `gui/${native.uid ?? process.getuid?.()}`, snapshot.path])?.status !== 0) throw new Error("curated restore failed");
  const restored = inspectNative(snapshot, native, { allowRunning: true });
  if (restored.wasLoaded !== snapshot.wasLoaded || restored.serialized !== snapshot.serialized ||
      disabledLabels(native).has(snapshot.service.split("/").at(-1)) !== (snapshot.wasDisabled === true)) throw new Error("curated restore readback failed");
}

export async function reconcileAdditionalUpdateScheduler(m, manifestPath, entry, options = {}) {
  const snapshot = entry.snapshot;
  const kind = snapshot.jobKind;
  try {
    validateUpdateSchedulerSnapshot(m, manifestPath, entry, options);
    if (kind === "quickbooks-task") {
      const q = qbContext(m, manifestPath, options);
      const state = q.adapter.read(q.plan.identity);
      const desired = q.module.buildQuickBooksScheduleDefinition(q.plan, q.schedulerOptions);
      if (!sameQuickBooksContract(state, snapshot.state, q.plan, manifestPath) &&
          !sameQuickBooksContract(state, { exists: true, owned: true, definition: desired }, q.plan, manifestPath)) throw new Error("task changed while paused");
      const installed = q.module.registerQuickBooksSchedule(q.plan, { ...q.schedulerOptions, enabled: snapshot.wasLoaded });
      const checked = q.module.statusQuickBooksSchedule(q.plan, q.schedulerOptions);
      if (!installed.verified || !checked.definitionValid || checked.enabled !== snapshot.wasLoaded) throw new Error("task exact readback failed");
      return schedulerUpdateRow(kind, installed.definition.definition_hash === snapshot.state.definition.definition_hash ? "already current" : "moved");
    }
    const native = nativeOptions(options);
    if (kind === "whatsapp-daemon") {
      const daemonOptions = { ...native, ...(options.whatsappDaemonOptions || {}) };
      const plan = daemon.buildWhatsappDaemonPlan(manifestPath, daemonOptions);
      const desired = daemon.renderDaemonPlist(plan);
      const current = inspectNative(snapshot, native, { allowRunning: true });
      if (![snapshot.serialized, desired].includes(current.serialized) || (current.wasLoaded && current.serialized !== desired)) throw new Error("capture changed while paused");
      if (!current.wasLoaded && desiredLoaded(snapshot)) daemon.installWhatsappDaemon(manifestPath, daemonOptions);
      else if (!desiredLoaded(snapshot) && current.serialized !== desired) throw new Error("disabled capture needs an attended reinstall");
      const checked = inspectNative(snapshot, native, { allowRunning: true });
      if (checked.serialized !== desired || checked.wasLoaded !== desiredLoaded(snapshot) || !existsSync(plan.binaryPath)) throw new Error("capture exact runtime readback failed");
      return schedulerUpdateRow(kind, snapshot.serialized === desired ? "already current" : "moved");
    }
    const spec = genericJobs(native).find(([, item]) => item.kind === kind)?.[1];
    const plan = spec ? core.buildSchedulerPlan(manifestPath, { ...native, spec }) : curated.buildCuratedSchedulerPlan(snapshot.planPath, native);
    const render = spec ? core.renderLaunchAgentPlist : curated.renderCuratedLaunchAgentPlist;
    const desired = render(plan, { registrationOnly: true });
    const current = inspectNative(snapshot, native, { allowRunning: true });
    if (current.serialized !== snapshot.serialized && current.serialized !== desired) throw new Error("definition changed while update held it paused");
    if (current.wasLoaded && current.serialized !== desired) throw new Error("old definition unexpectedly resumed");
    if (!current.wasLoaded) {
      if (spec) core.installScheduler(manifestPath, { ...native, spec, enabled: desiredLoaded(snapshot), registrationOnly: true });
      else curated.reinstallScheduledCuratedSync(snapshot.planPath, { ...native, enabled: desiredLoaded(snapshot), registrationOnly: true });
    }
    verifyUpdateSchedulerDefinition(plan, desired, native, desiredLoaded(snapshot));
    return schedulerUpdateRow(kind, [desired, render(plan)].includes(snapshot.serialized) ? "already current" : "moved");
  } catch {
    return schedulerUpdateRow(kind, "COULD NOT MOVE", "reviewed install or exact runtime readback failed; imports remain paused or unverified", fixFor(kind, manifestPath, snapshot.planPath, snapshot.path));
  }
}

/** A second inventory is part of local acceptance, before releasing recovery. */
export async function verifyUpdateSchedulerInventory(m, manifestPath, entries, options = {}) {
  reserveUpdateSchedulerWriters(entries, { ...options, manifestPath });
  const added = await captureAdditionalUpdateSchedulers(m, manifestPath, { ...options, preserveSnapshotIntent: true }, entries);
  try {
    const known = new Set(entries.filter(entry => entry.snapshot?.exists).map(entry => entry.snapshot.service));
    const rows = added.filter(entry => !known.has(entry.snapshot.service)).map(entry => schedulerUpdateRow(
      entry.snapshot.jobKind, "COULD NOT MOVE", "job appeared after the pre-update snapshot; retry the update",
      fixFor(entry.snapshot.jobKind, manifestPath, entry.snapshot.planPath, entry.snapshot.path),
    ));
    for (const entry of entries) {
      if (!entry.snapshot?.exists) continue;
      const native = nativeOptions(options);
      const kind = entry.snapshot.jobKind ?? entry.module?.[entry.kind === "drive" ? "DRIVE_SCHEDULER_SPEC" : entry.kind === "folder"
        ? "FOLDER_SCHEDULER_SPEC" : entry.kind === "imessage" ? "IMESSAGE_SCHEDULER_SPEC" : ""]?.kind ??
        entry.module?.createProviderSchedulerSpec?.(entry.provider, native)?.kind;
      if (!kind) continue;
      try {
        if (kind === "quickbooks-task") {
          const q = qbContext(m, manifestPath, options);
          const checked = q.module.statusQuickBooksSchedule(q.plan, q.schedulerOptions);
          if (!checked.definitionValid || checked.enabled !== entry.snapshot.wasLoaded) throw new Error("task drift");
        } else if (kind === "whatsapp-daemon") {
          const plan = daemon.buildWhatsappDaemonPlan(manifestPath, { ...native, ...(options.whatsappDaemonOptions || {}) });
          const checked = inspectNative(entry.snapshot, native, { allowRunning: true });
          if (checked.serialized !== daemon.renderDaemonPlist(plan) || checked.wasLoaded !== desiredLoaded(entry.snapshot) ||
              disabledLabels(native).has(plan.label) === desiredLoaded(entry.snapshot) || !existsSync(plan.binaryPath)) throw new Error("capture drift");
        } else {
          const spec = genericJobs(native).find(([, item]) => item.kind === kind)?.[1];
          const plan = spec ? core.buildSchedulerPlan(manifestPath, { ...native, spec }) : curated.buildCuratedSchedulerPlan(entry.snapshot.planPath, native);
          verifyUpdateSchedulerDefinition(plan, spec ? core.renderLaunchAgentPlist(plan, { registrationOnly: true }) : curated.renderCuratedLaunchAgentPlist(plan, { registrationOnly: true }), native, desiredLoaded(entry.snapshot));
        }
      } catch {
        rows.push(schedulerUpdateRow(kind, "COULD NOT MOVE", "final local acceptance found an unverified definition or runtime", fixFor(kind, manifestPath, entry.snapshot.planPath, entry.snapshot.path)));
      }
    }
    requireUpdateSchedulers(rows);
    return rows;
  } finally {
    releaseUpdateSchedulerReservations(added);
  }
}
