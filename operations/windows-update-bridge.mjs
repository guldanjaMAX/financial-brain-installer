/** Reversible coordination of temporary, current-user Windows daily tasks. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { win32 } from "node:path";
import { parseWindowsTaskInventory } from "./daily-refresh-scheduler.mjs";

import { decodeWindowsTaskXml, withWindowsTaskMutationLock } from "./windows-task-contract.mjs";

const BRIDGE_NAME = /^\\Financial Brain\\daily-refresh-[0-9a-f]{16}$/u;
const SID = /^S-1-\d+(?:-\d+)+$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
export class WindowsDailyTaskRepairRequired extends Error {
  constructor(taskName = null, { unrecognized = false } = {}) {
    const exactTask = BRIDGE_NAME.test(taskName || "") ? `Task Scheduler task "${taskName}"` : "The old daily task in Task Scheduler";
    super(unrecognized
      ? `${exactTask} binds this Brain but was not created by the installer. ` +
        "Back up its XML in Task Scheduler, remove only this task, then rerun the update. Nothing was changed."
      : `Check ${exactTask}, then retry the update.`);
    this.name = "WindowsDailyTaskRepairRequired";
    this.supportCode = "SAFETY_REVIEW_REQUIRED";
  }
}
const repair = (taskName, options) => new WindowsDailyTaskRepairRequired(taskName, options);
const decodeXml = (value) => value.replaceAll("&quot;", '"').replaceAll("&apos;", "'")
  .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
function singleTag(text, name) {
  const matches = [...String(text).matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "gu"))];
  return matches.length === 1 ? matches[0][1] : null;
}

const digest = (...fields) => createHash("sha256").update(fields.map((value) =>
  `${Buffer.byteLength(value, "utf8")}:${value},`).join(""), "utf8").digest("hex");

function binding(domain, manifestPath, sid) {
  // The prose producer did not define normalization. Only accept its already
  // canonical hostname input, rather than guess aliases into ownership.
  if (typeof domain !== "string" || domain.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(domain) ||
      typeof manifestPath !== "string" || !manifestPath || !SID.test(sid)) throw repair();
  const name = `\\Financial Brain\\daily-refresh-${digest("daily-refresh-v1", domain, sid).slice(0, 16)}`;
  return { name, hash: `sha256:${digest("bridge-binding-v1", domain, manifestPath, sid, name)}` };
}

export function sameManifestFile(taskPath, manifestPath, { platform = process.platform, realpath = realpathSync.native } = {}) {
  if (typeof taskPath !== "string" || !taskPath || typeof manifestPath !== "string" || !manifestPath) return false;
  if (taskPath === manifestPath) return true;
  // Resolve both spellings before comparing: aliases include directory links,
  // Windows short names and redirected folders. An unresolved alias is no proof.
  try {
    const taskFile = realpath(taskPath);
    const manifestFile = realpath(manifestPath);
    return platform === "win32"
      ? taskFile.toLowerCase() === manifestFile.toLowerCase()
      : taskFile === manifestFile;
  } catch { return false; }
}

function actionBinds(entry, manifestPath) {
  // A substring in a comment, string, or opaque PowerShell program is not
  // execution proof. Recognize only a complete literal load invocation; an
  // unrecognized prose-generated program needs explicit supervised repair.
  if (typeof entry.action !== "string" || /[\r\n\0]/u.test(entry.action)) return false;
  let rest = entry.action.trim();
  const invocation = rest.startsWith("& ");
  if (invocation) rest = rest.slice(2).trimStart();
  const tokens = [];
  while (rest) {
    const match = rest.match(/^(?:'((?:[^']|'')*)'|"([^"$`]*)"|([A-Za-z0-9_./\\:,\-]+))(?=\s|$)/u);
    if (!match || (tokens.length === 0 && match[3] === undefined && !invocation)) return false;
    tokens.push(match[1]?.replaceAll("''", "'") ?? match[2] ?? match[3]);
    rest = rest.slice(match[0].length).trimStart();
  }
  return tokens.length === 5 &&
    (tokens[0] === "brain" || (win32.isAbsolute(tokens[0]) && /^brain\.(?:cmd|exe)$/iu.test(win32.basename(tokens[0])))) &&
    tokens[1] === "load" && sameManifestFile(tokens[2], manifestPath) && tokens[3] === "--only" &&
    /^[a-z][a-z0-9_]*(?:,[a-z][a-z0-9_]*)*$/u.test(tokens[4]);
}

function observe(taskName, serialized) {
  const principals = singleTag(serialized, "Principals");
  const principal = singleTag(principals, "Principal");
  const user = singleTag(principal, "UserId");
  const settings = singleTag(serialized, "Settings");
  // Missing is the schema default, but malformed and duplicate values must
  // never be mistaken for that omission.
  const enabledCount = settings === null ? 0 : [...settings.matchAll(/<Enabled[\s/>]/gu)].length;
  const enabledText = enabledCount === 1 ? singleTag(settings, "Enabled") : null;
  const enabled = settings === null || enabledCount > 1 ? null
    : enabledCount === 0 ? true
      : ["true", "false"].includes(enabledText) ? enabledText === "true" : null;
  if (!user) throw repair();
  const actions = singleTag(serialized, "Actions") || "";
  let action = null;
  const exec = actions.match(/^\s*<Exec>\s*<Command>([^<]*)<\/Command>\s*<Arguments>([^<]*)<\/Arguments>\s*<\/Exec>\s*$/u);
  const command = exec ? decodeXml(exec[1]) : "";
  const args = exec ? decodeXml(exec[2]) : "";
  const encoded = /^(?:powershell\.exe|[A-Za-z]:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe)$/iu.test(command)
    ? args.match(/^(?:(?:-NoProfile|-NonInteractive|-NoLogo|-ExecutionPolicy\s+Bypass)\s+)*-EncodedCommand\s+([A-Za-z0-9+/]+={0,2})\s*$/iu)?.[1] : null;
  if (encoded) {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length % 2 === 0 && bytes.toString("base64") === encoded) action = bytes.toString("utf16le");
  }
  // Exclude only Settings/Enabled. Trigger enablement and every other byte
  // remain part of the recovery fingerprint, including across process restart.
  const strip = (transform) => settings === null ? serialized
    : serialized.replace(/<Settings(?:\s[^>]*)?>[\s\S]*?<\/Settings>/u, transform);
  return {
    task_name: taskName,
    principal: user,
    enabled,
    definition: strip(section => section.replace(/\s*<Enabled>(?:true|false)<\/Enabled>/u, "")),
    legacy_definition: strip(section => section.replace(/<Enabled>(true|false)<\/Enabled>/u, "<Enabled/>")),
    action,
    action_mentions_brain: /\bbrain\b/iu.test(action || ""),
    action_mentions_load: /\bload\b/iu.test(action || ""),
  };
}

export function createNativeWindowsBridgeAdapter({ spawn = spawnSync, environment = process.env, home = homedir() } = {}) {
  const systemRoot = environment.SystemRoot || environment.SYSTEMROOT || environment.WINDIR;
  if (!win32.isAbsolute(String(systemRoot || ""))) throw repair();
  const env = { SystemRoot: systemRoot, ...(environment.WINDIR ? { WINDIR: environment.WINDIR } : {}) };
  const run = (exe, args) => {
    let result;
    try { result = spawn(win32.join(systemRoot, "System32", exe), args, {
      encoding: args.includes("/XML") ? null : "utf8", windowsHide: true, env,
      timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    }); } catch { throw repair(); }
    if (!result || result.error || result.signal || result.status === null) {
      const error = repair();
      error.message = "The Windows bridge operation timed out or was interrupted; its outcome is unknown. Keep the recovery receipt and inspect the task before retrying.";
      throw error;
    }
    return result;
  };
  const tasks = (args) => run("schtasks.exe", args);
  const names = () => {
    const result = tasks(["/Query", "/FO", "CSV", "/NH"]);
    if (result?.status !== 0) throw repair();
    try { return [...new Set(parseWindowsTaskInventory(result.stdout))]; } catch { throw repair(); }
  };
  const currentSid = () => {
    const result = run("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
    const match = String(result?.stdout || "").trim().match(/^"(?:[^"]|"")*","(S-1-\d+(?:-\d+)+)"$/u);
    if (result?.status !== 0 || !match) throw repair();
    return match[1];
  };
  const read = (name) => {
    if (!BRIDGE_NAME.test(name)) throw repair();
    const result = tasks(["/Query", "/TN", name, "/XML"]);
    if (result?.status !== 0) {
      if (!names().includes(name)) return null;
      throw repair();
    }
    try {
      let usedUnicode = false;
      const unicodeSpawn = (...args) => { usedUnicode = true; return spawn(...args); };
      const entry = observe(name, decodeWindowsTaskXml(result.stdout, { spawn: unicodeSpawn, systemRoot, environment: env, taskName: name }));
      // A legacy receipt hashes console bytes. Bracket the separate COM read
      // so its action/principal cannot borrow authorization from an older task.
      if (usedUnicode) {
        const after = tasks(["/Query", "/TN", name, "/XML"]);
        if (after?.status !== 0 || !Buffer.isBuffer(after.stdout) || !result.stdout.equals(after.stdout)) throw repair();
      }
      // The Unicode export may format XML differently from the original
      // console pipe. Keep the old byte decoder ONLY for comparing saved v1
      // hashes, never for principal/action decisions or replaying a definition.
      if (Buffer.isBuffer(result.stdout) && !result.stdout.includes(0) &&
          !(result.stdout[0] === 0xff && result.stdout[1] === 0xfe) &&
          !(result.stdout[0] === 0xfe && result.stdout[1] === 0xff)) {
        entry.legacy_definition = observe(name, result.stdout.toString("utf8")).legacy_definition;
      }
      return entry;
    } catch { throw repair(); }
  };
  const mutate = (name, expected, args) => withWindowsTaskMutationLock(home,
    { id: `bridge-${digest(name)}` }, () => {
      if (!expected) throw repair();
      const current = read(name);
      if (!current || ["task_name", "principal", "enabled", "definition", "legacy_definition", "action"]
        .some(key => current[key] !== expected[key])) throw repair();
      // Task Scheduler has no atomic compare-and-change/delete. This fresh
      // comparison runs under our lock immediately before the native action.
      if (tasks(args)?.status !== 0) throw repair();
    });
  return {
    currentSid,
    inventory() {
      const sid = currentSid();
      const entries = [];
      let ignored = 0;
      for (const name of names()) {
        if (!name.startsWith("\\Financial Brain\\")) continue;
        if (!BRIDGE_NAME.test(name)) { ignored += 1; continue; }
        const entry = read(name);
        if (!entry) throw repair();
        if (entry.principal !== sid) { ignored += 1; continue; }
        entries.push(entry);
      }
      return { entries, ignored };
    },
    read,
    setEnabled(name, enabled, { expected } = {}) {
      return mutate(name, expected, ["/Change", "/TN", name, enabled ? "/ENABLE" : "/DISABLE"]);
    },
    remove(name, { expected } = {}) {
      return mutate(name, expected, ["/Delete", "/F", "/TN", name]);
    },
  };
}

function validateReceipt(entry) {
  if (!BRIDGE_NAME.test(entry?.task_name) || !SID.test(entry?.principal) ||
      !HASH.test(entry?.binding_hash) || !HASH.test(entry?.definition_hash) ||
      typeof entry?.prior_enabled !== "boolean" ||
      !Number.isFinite(Date.parse(entry?.recorded_at)) ||
      !["observed", "disabling", "paused", "restored", "retiring", "retired"].includes(entry?.state)) throw repair();
  return entry;
}

export function createWindowsUpdateBridgeGuard(options = {}) {
  const adapter = options.adapter || createNativeWindowsBridgeAdapter(options);
  const now = options.now || (() => new Date());
  const target = () => binding(options.domain, options.manifestPath, adapter.currentSid());
  const fingerprint = (entry, bound) => {
    if (typeof entry.definition !== "string" || !entry.definition) throw repair();
    return `sha256:${digest("bridge-definition-v2", bound.hash, entry.task_name, entry.principal, entry.definition)}`;
  };
  const checked = (entry, { absent = false } = {}) => {
    validateReceipt(entry);
    const bound = target();
    if (bound.name !== entry.task_name || bound.hash !== entry.binding_hash) throw repair();
    const current = adapter.read(entry.task_name);
    if (!current && absent) return null;
    if (!current || current.principal !== entry.principal || typeof current.enabled !== "boolean" ||
        !actionBinds(current, options.manifestPath)) throw repair();
    // Old receipts remain exact-byte bound to their v1 placeholder. Never
    // upgrade their authorization from a freshly observed replacement task.
    const legacyHash = typeof current.legacy_definition === "string"
      ? `sha256:${digest("bridge-definition-v1", bound.hash, current.task_name, current.principal, current.legacy_definition)}` : null;
    if (fingerprint(current, bound) !== entry.definition_hash && legacyHash !== entry.definition_hash) throw repair();
    return current;
  };
  return {
    inventory() {
      const inventory = adapter.inventory();
      if (!inventory.entries.length) return inventory;
      const bound = target();
      const entries = [];
      let ignored = inventory.ignored;
      for (const entry of inventory.entries) {
        if (entry.task_name !== bound.name) {
          // Even a differently named task cannot be silently ignored if its
          // literal action points at this manifest or Brain.
          if (actionBinds(entry, options.manifestPath) ||
              entry.action?.includes(options.manifestPath) || entry.action?.includes(options.domain)) throw repair(entry.task_name, { unrecognized: true });
          ignored += 1;
          continue;
        }
        if (entry.principal !== adapter.currentSid() || typeof entry.enabled !== "boolean") throw repair();
        entries.push(entry);
      }
      return { entries, ignored };
    },
    capture(inventory, prior = []) {
      const receipts = prior.map((entry) => ({ ...validateReceipt(entry) }));
      if (new Set(receipts.map((entry) => entry.task_name)).size !== receipts.length) throw repair();
      // Never replace an old authorization with the freshly inventoried task.
      for (const saved of receipts) checked(saved, { absent: ["retiring", "retired"].includes(saved.state) });
      for (const entry of inventory.entries) {
        const saved = receipts.find((receipt) => receipt.task_name === entry.task_name);
        if (saved) {
          if (saved.principal !== entry.principal || saved.state === "retired") throw repair();
        } else {
          if (!actionBinds(entry, options.manifestPath)) throw repair(entry.task_name, { unrecognized: true });
          const bound = target();
          if (entry.task_name !== bound.name || entry.principal !== adapter.currentSid()) throw repair();
          receipts.push({ task_name: entry.task_name, principal: entry.principal,
            binding_hash: bound.hash, definition_hash: fingerprint(entry, bound),
            action_mentions_brain: entry.action_mentions_brain, action_mentions_load: entry.action_mentions_load,
            prior_enabled: entry.enabled, recorded_at: now().toISOString(), state: "observed" });
        }
      }
      return receipts;
    },
    pause(receipts, persist) {
      for (const entry of receipts) {
        if (entry.state === "retired") continue;
        const current = checked(entry, { absent: entry.state === "retiring" });
        if (!current) { entry.state = "retired"; persist(); continue; }
        // Inventory is not a disable receipt. An owner or another updater may
        // pause the task before our decision; do not acquire deletion rights.
        if (!current.enabled && ["observed", "restored"].includes(entry.state)) {
          entry.prior_enabled = false;
          entry.state = "observed";
          persist();
        }
        if (!entry.prior_enabled) {
          if (current.enabled) throw repair();
          continue; // A task already disabled before this transaction is never adopted for deletion.
        }
        if (current.enabled) {
          entry.state = "disabling";
          persist(); // Write intent before even an ambiguously successful native call.
          const expected = checked(entry);
          adapter.setEnabled(entry.task_name, false, { expected });
        }
        if (checked(entry).enabled !== false) throw repair();
        entry.state = "paused";
        persist();
      }
    },
    restore(receipts, persist) {
      let failed = false;
      for (const entry of receipts) {
        if (!entry.prior_enabled || !["disabling", "paused"].includes(entry.state)) continue;
        try {
          const expected = checked(entry);
          if (expected.enabled === false) adapter.setEnabled(entry.task_name, true, { expected });
          if (checked(entry).enabled !== true) throw repair();
          entry.state = "restored";
          persist();
        } catch { failed = true; }
      }
      if (failed) throw new Error("Restore the old daily task in Task Scheduler, then retry the update.");
    },
    retire(receipts, persist) {
      for (const entry of receipts) {
        if (!entry.prior_enabled || !["paused", "retiring"].includes(entry.state)) continue;
        const current = checked(entry, { absent: entry.state === "retiring" });
        if (current) {
          if (current.enabled !== false) throw repair();
          entry.state = "retiring";
          persist();
          const expected = checked(entry);
          if (expected.enabled !== false) throw repair();
          adapter.remove(entry.task_name, { expected });
          if (checked(entry, { absent: true }) !== null) throw repair();
        }
        entry.state = "retired";
        persist();
      }
    },
  };
}
