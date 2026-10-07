/** Reversible coordination of temporary, current-user Windows daily tasks. */
import { spawnSync } from "node:child_process";
import { win32 } from "node:path";
import { parseWindowsTaskInventory } from "./daily-refresh-scheduler.mjs";

const BRIDGE_NAME = /^\\Financial Brain\\daily-refresh-[0-9a-f]{16}$/u;
const SID = /^S-1-\d+(?:-\d+)+$/u;
const repair = () => new Error("Check the old daily task in Task Scheduler, then retry the update.");
const decodeXml = (value) => value.replaceAll("&quot;", '"').replaceAll("&apos;", "'")
  .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
function singleTag(text, name) {
  const matches = [...String(text).matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "gu"))];
  return matches.length === 1 ? matches[0][1] : null;
}

function observe(taskName, serialized) {
  const principals = singleTag(serialized, "Principals");
  const principal = singleTag(principals, "Principal");
  const user = singleTag(principal, "UserId");
  const settings = singleTag(serialized, "Settings");
  const enabled = singleTag(settings, "Enabled");
  if (!user) throw repair();
  const actions = singleTag(serialized, "Actions") || "";
  let action = decodeXml(actions);
  const encoded = action.match(/(?:^|[>\s])-EncodedCommand\s+([A-Za-z0-9+/]+={0,2})(?=\s|<|$)/iu)?.[1];
  if (encoded) {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length % 2 === 0 && bytes.toString("base64") === encoded) action += ` ${bytes.toString("utf16le")}`;
  }
  // Keep a transient exact definition comparison across native mutations.
  // Never serialize raw actions or invent a legacy receipt/hash contract.
  const immutable = settings === null ? serialized
    : serialized.replace(settings, settings.replace(/<Enabled>(true|false)<\/Enabled>/u, "<Enabled/>"));
  return {
    task_name: taskName,
    principal: user,
    enabled: ["true", "false"].includes(enabled) ? enabled === "true" : null,
    definition: immutable,
    action_mentions_brain: /\bbrain\b/iu.test(action),
    action_mentions_load: /\bload\b/iu.test(action),
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
        if (typeof entry.enabled !== "boolean") throw repair();
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
      typeof entry?.prior_enabled !== "boolean" ||
      !Number.isFinite(Date.parse(entry?.recorded_at)) ||
      !["observed", "disabling", "paused", "restored", "retiring", "retired"].includes(entry?.state)) throw repair();
  return entry;
}

export function createWindowsUpdateBridgeGuard(options = {}) {
  const adapter = options.adapter || createNativeWindowsBridgeAdapter(options);
  const now = options.now || (() => new Date());
  let definitions = new Map();
  const checked = (entry, { absent = false } = {}) => {
    validateReceipt(entry);
    if (adapter.currentSid() !== entry.principal) throw repair();
    const current = adapter.read(entry.task_name);
    if (!current && absent) return null;
    if (!current || current.principal !== entry.principal ||
        (definitions.has(entry.task_name) && current.definition !== definitions.get(entry.task_name))) throw repair();
    return current;
  };
  return {
    inventory() {
      const inventory = adapter.inventory();
      definitions = new Map(inventory.entries.map((entry) => [entry.task_name, entry.definition]));
      return inventory;
    },
    capture(inventory, prior = []) {
      const receipts = prior.map((entry) => ({ ...validateReceipt(entry) }));
      if (new Set(receipts.map((entry) => entry.task_name)).size !== receipts.length) throw repair();
      for (const entry of inventory.entries) {
        const saved = receipts.find((receipt) => receipt.task_name === entry.task_name);
        if (saved) {
          if (saved.principal !== entry.principal || saved.state === "retired") throw repair();
        } else {
          const { enabled, definition: _privateDefinition, ...observed } = entry;
          receipts.push({ ...observed, prior_enabled: enabled, recorded_at: now().toISOString(), state: "observed" });
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
