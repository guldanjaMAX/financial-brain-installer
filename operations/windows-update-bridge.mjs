/** Reversible coordination of temporary, current-user Windows daily tasks. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { parseWindowsTaskInventory } from "./daily-refresh-scheduler.mjs";

const BRIDGE_NAME = /^\\Financial Brain\\daily-refresh-[0-9a-f]{16}$/u;
const SID = /^S-1-\d+(?:-\d+)+$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const repair = () => new Error("Check the old daily task in Task Scheduler, then retry the update.");
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
    tokens[1] === "load" && tokens[2] === manifestPath && tokens[3] === "--only" &&
    /^[a-z][a-z0-9_]*(?:,[a-z][a-z0-9_]*)*$/u.test(tokens[4]);
}

function observe(taskName, serialized) {
  const principals = singleTag(serialized, "Principals");
  const principal = singleTag(principals, "Principal");
  const user = singleTag(principal, "UserId");
  const settings = singleTag(serialized, "Settings");
  const enabled = singleTag(settings, "Enabled");
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
  const immutable = settings === null ? serialized
    : serialized.replace(/<Settings(?:\s[^>]*)?>[\s\S]*?<\/Settings>/u,
      (section) => section.replace(/<Enabled>(true|false)<\/Enabled>/u, "<Enabled/>"));
  return {
    task_name: taskName,
    principal: user,
    enabled: ["true", "false"].includes(enabled) ? enabled === "true" : null,
    definition: immutable,
    action,
    action_mentions_brain: /\bbrain\b/iu.test(action || ""),
    action_mentions_load: /\bload\b/iu.test(action || ""),
  };
}

export function createNativeWindowsBridgeAdapter({ spawn = spawnSync, environment = process.env } = {}) {
  const systemRoot = environment.SystemRoot || environment.SYSTEMROOT || environment.WINDIR;
  if (!win32.isAbsolute(String(systemRoot || ""))) throw repair();
  const env = { SystemRoot: systemRoot, ...(environment.WINDIR ? { WINDIR: environment.WINDIR } : {}) };
  const run = (exe, args) => {
    try { return spawn(win32.join(systemRoot, "System32", exe), args, { encoding: "utf8", windowsHide: true, env }); }
    catch { throw repair(); }
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
    return observe(name, String(result.stdout || ""));
  };
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
    setEnabled(name, enabled) {
      if (tasks(["/Change", "/TN", name, enabled ? "/ENABLE" : "/DISABLE"])?.status !== 0) throw repair();
    },
    remove(name) {
      if (tasks(["/Delete", "/F", "/TN", name])?.status !== 0) throw repair();
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
    return `sha256:${digest("bridge-definition-v1", bound.hash, entry.task_name, entry.principal, entry.definition)}`;
  };
  const checked = (entry, { absent = false } = {}) => {
    validateReceipt(entry);
    const bound = target();
    if (bound.name !== entry.task_name || bound.hash !== entry.binding_hash) throw repair();
    const current = adapter.read(entry.task_name);
    if (!current && absent) return null;
    if (!current || current.principal !== entry.principal || typeof current.enabled !== "boolean" ||
        !actionBinds(current, options.manifestPath) || fingerprint(current, bound) !== entry.definition_hash) throw repair();
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
          if (entry.action?.includes(options.manifestPath) || entry.action?.includes(options.domain)) throw repair();
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
          if (!actionBinds(entry, options.manifestPath)) throw repair();
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
          checked(entry);
          adapter.setEnabled(entry.task_name, false);
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
          if (checked(entry).enabled === false) adapter.setEnabled(entry.task_name, true);
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
          if (checked(entry).enabled !== false) throw repair();
          adapter.remove(entry.task_name);
          if (checked(entry, { absent: true }) !== null) throw repair();
        }
        entry.state = "retired";
        persist();
      }
    },
  };
}
