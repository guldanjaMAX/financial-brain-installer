/** Semantic Task Scheduler readback. No DTDs, loose descendant lookups or XML execution. */
const NS = "http://schemas.microsoft.com/windows/2004/02/mit/task";
const SID = /^S-1-\d+(?:-\d+)+$/u;
const invalid = () => { throw new Error("invalid task XML contract"); };

/** schtasks XML pipes may carry UTF-16 bytes despite the console code page. */
export function decodeWindowsTaskXml(value) {
  if (!Buffer.isBuffer(value)) return String(value || "");
  if (value[0] === 0xff && value[1] === 0xfe) return value.toString("utf16le");
  if (value[0] === 0xfe && value[1] === 0xff) return Buffer.from(value).swap16().toString("utf16le");
  if (value[0] === 0x3c && value[1] === 0) return value.toString("utf16le");
  return value.toString("utf8");
}

function decode(value) {
  return value.replace(/&([^;]+);/gu, (_entity, name) => {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (Object.hasOwn(named, name)) return named[name];
    if (/^#(?:[0-9]+|x[0-9a-f]+)$/iu.test(name)) {
      const code = name[1] === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      if (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) return String.fromCodePoint(code);
    }
    return invalid();
  });
}

// The OS has already validated this XML, but fixtures, damaged definitions and
// duplicate fields must still fail closed. Preserve leaf whitespace: argv is exact.
function parse(serialized) {
  const text = String(serialized || "").replace(/^\ufeff/u, "");
  if (text.length > 262144 || /<!DOCTYPE|<!ENTITY/iu.test(text)) return invalid();
  const document = { children: [], text: "" };
  const stack = [document];
  const tokens = text.match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<[^>]*>|[^<]+/gu) || [];
  if (tokens.join("") !== text) return invalid();
  for (const token of tokens) {
    if (token.startsWith("<!--") || /^<\?xml\s/u.test(token)) continue;
    const parent = stack.at(-1);
    if (!token.startsWith("<")) { parent.text += decode(token); continue; }
    const closing = token.match(/^<\/([A-Za-z][A-Za-z0-9]*)\s*>$/u);
    if (closing) {
      if (stack.length < 2 || parent.name !== closing[1]) return invalid();
      stack.pop(); continue;
    }
    const opening = token.match(/^<([A-Za-z][A-Za-z0-9]*)([\s\S]*?)(\/?)>$/u);
    if (!opening) return invalid();
    const attributes = {};
    let rest = opening[2];
    while (rest.trim()) {
      const attr = rest.match(/^\s+([A-Za-z][A-Za-z0-9:]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/u);
      if (!attr || Object.hasOwn(attributes, attr[1])) return invalid();
      attributes[attr[1]] = decode(attr[2] ?? attr[3]);
      rest = rest.slice(attr[0].length);
    }
    const allowedAttributes = { Task: ["xmlns", "version"], Principal: ["id"], Actions: ["Context"], CalendarTrigger: ["id"], Exec: ["id"] };
    if (Object.keys(attributes).some(name => !(allowedAttributes[opening[1]] || []).includes(name))) return invalid();
    const node = { name: opening[1], attributes, children: [], text: "" };
    parent.children.push(node);
    if (!opening[3]) stack.push(node);
  }
  if (stack.length !== 1 || document.text.trim() || document.children.length !== 1) return invalid();
  const root = document.children[0];
  if (root.name !== "Task" || root.attributes.xmlns !== NS) return invalid();
  return root;
}

function children(node, allowed, required = []) {
  if (!node || node.text.trim()) return invalid();
  const found = {};
  for (const child of node.children) {
    if (!allowed.includes(child.name) || Object.hasOwn(found, child.name)) return invalid();
    found[child.name] = child;
  }
  if (required.some(name => !found[name])) return invalid();
  return found;
}
function leaf(node, fallback = null) {
  if (!node) return fallback;
  if (node.children.length || Object.keys(node.attributes).length) return invalid();
  return node.text;
}
function bool(node, fallback) {
  const value = leaf(node);
  if (value === null) return fallback;
  if (["true", "1"].includes(value)) return true;
  if (["false", "0"].includes(value)) return false;
  return invalid();
}
function integer(node, fallback) {
  const value = leaf(node);
  if (value === null) return fallback;
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) return invalid();
  return Number(value);
}
function duration(value) {
  const match = String(value).match(/^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/u);
  if (!match || !match.slice(1).some(Boolean)) return invalid();
  const seconds = Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3] || 0) * 60 + Number(match[4] || 0);
  if (!Number.isSafeInteger(seconds)) return invalid();
  return seconds % 60 === 0 ? `PT${seconds / 60}M` : `PT${seconds}S`;
}

export function windowsTaskDescription(serialized) {
  try {
    const root = parse(serialized);
    const registrations = root.children.filter(node => node.name === "RegistrationInfo");
    if (registrations.length !== 1) return null;
    const descriptions = registrations[0].children.filter(node => node.name === "Description");
    return descriptions.length === 1 ? leaf(descriptions[0]) : null;
  } catch { return null; }
}

function taskEnabled(serialized) {
  try {
    const root = parse(serialized);
    const settings = root.children.filter(node => node.name === "Settings");
    if (settings.length !== 1) return null;
    const enabled = settings[0].children.filter(node => node.name === "Enabled");
    if (enabled.length > 1) return null;
    return bool(enabled[0], true);
  } catch { return null; }
}

export function observedWindowsContract(serialized, { repetition = false, resolveUserId = value => value } = {}) {
  try {
    const root = parse(serialized);
    const task = children(root, ["RegistrationInfo", "Triggers", "Principals", "Settings", "Actions"], ["Triggers", "Principals", "Settings", "Actions"]);
    const registration = task.RegistrationInfo && children(task.RegistrationInfo,
      ["Description", "URI", "Date", "Author", "Version", "Source", "Documentation", "SecurityDescriptor"]);
    // Metadata never authorizes execution. A marker is accepted only from the
    // single Description, not a comment, action argument, or extra sibling.
    const description = registration ? leaf(registration.Description) : null;
    const actions = children(task.Actions, ["Exec"], ["Exec"]);
    const exec = children(actions.Exec, ["Command", "Arguments", "WorkingDirectory"], ["Command", "Arguments"]);
    if (leaf(exec.WorkingDirectory, "") !== "") return invalid();
    const triggers = children(task.Triggers, ["CalendarTrigger"], ["CalendarTrigger"]);
    const calendar = children(triggers.CalendarTrigger, ["StartBoundary", "Enabled", "ScheduleByDay", ...(repetition ? ["Repetition"] : [])], ["StartBoundary", "ScheduleByDay", ...(repetition ? ["Repetition"] : [])]);
    const day = children(calendar.ScheduleByDay, ["DaysInterval"], ["DaysInterval"]);
    const boundary = leaf(calendar.StartBoundary)?.match(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.0+)?$/u);
    if (!boundary) return invalid();
    const principals = children(task.Principals, ["Principal"], ["Principal"]);
    const principal = children(principals.Principal, ["UserId", "LogonType", "RunLevel", "ProcessTokenSidType"], ["LogonType"]);
    if (leaf(principal.ProcessTokenSidType, "Default") !== "Default") return invalid();
    if (task.Actions.attributes.Context && task.Actions.attributes.Context !== principals.Principal.attributes.id) return invalid();
    const user = leaf(principal.UserId);
    // Resolve aliases from OS evidence. Never equate two domains by stripping
    // their prefixes, or infer an owner from the desktop environment.
    const resolvedUser = user === null || SID.test(user) ? user : resolveUserId(user);
    const settings = children(task.Settings, [
      "MultipleInstancesPolicy", "DisallowStartIfOnBatteries", "StopIfGoingOnBatteries", "AllowHardTerminate",
      "StartWhenAvailable", "RunOnlyIfNetworkAvailable", "IdleSettings", "AllowStartOnDemand", "Enabled",
      "Hidden", "RunOnlyIfIdle", "WakeToRun", "ExecutionTimeLimit", "Priority",
      "DisallowStartOnRemoteAppSession", "UseUnifiedSchedulingEngine", "Volatile",
    ]);
    for (const name of ["DisallowStartOnRemoteAppSession", "Volatile"]) {
      if (bool(settings[name], false) !== false) return invalid();
    }
    // Windows 11 selects the unified engine when it registers this definition.
    // The engine is not an execution permission; both native boolean forms
    // retain the same action, cadence, principal and runtime limits below.
    bool(settings.UseUnifiedSchedulingEngine, false);
    const idle = settings.IdleSettings ? children(settings.IdleSettings, ["Duration", "WaitTimeout", "StopOnIdleEnd", "RestartOnIdle"]) : {};
    const contract = {
      command: leaf(exec.Command), arguments: leaf(exec.Arguments),
      start_boundary: `2000-01-01T${boundary[1]}:${boundary[2]}:${boundary[3]}`,
      trigger_enabled: bool(calendar.Enabled, true), days_interval: integer(day.DaysInterval),
      user_id: resolvedUser, logon_type: leaf(principal.LogonType), run_level: leaf(principal.RunLevel, "LeastPrivilege"),
      start_when_available: bool(settings.StartWhenAvailable, false),
      multiple_instances_policy: leaf(settings.MultipleInstancesPolicy, "IgnoreNew"),
      execution_time_limit: duration(leaf(settings.ExecutionTimeLimit, "PT72H")), task_enabled: bool(settings.Enabled, true),
      disallow_start_on_batteries: bool(settings.DisallowStartIfOnBatteries, true),
      stop_on_batteries: bool(settings.StopIfGoingOnBatteries, true), allow_hard_terminate: bool(settings.AllowHardTerminate, true),
      run_only_if_network_available: bool(settings.RunOnlyIfNetworkAvailable, false),
      stop_on_idle_end: bool(idle.StopOnIdleEnd, true), restart_on_idle: bool(idle.RestartOnIdle, false),
      allow_start_on_demand: bool(settings.AllowStartOnDemand, true), hidden: bool(settings.Hidden, false),
      run_only_if_idle: bool(settings.RunOnlyIfIdle, false), wake_to_run: bool(settings.WakeToRun, false), priority: integer(settings.Priority, 7),
    };
    if (repetition) {
      const repeat = children(calendar.Repetition, ["Interval", "Duration", "StopAtDurationEnd"], ["Interval", "Duration"]);
      // Preserve the public repetition shape used by the QuickBooks scheduler.
      Object.assign(contract, { repetition_interval: leaf(repeat.Interval), repetition_duration: leaf(repeat.Duration), stop_at_duration_end: bool(repeat.StopAtDurationEnd, false) });
    }
    return { valid: true, contract, description };
  } catch {
    // Execution drift must not masquerade as a disabled task during update
    // pause. Read this independent state even when another field is invalid.
    return { valid: false, contract: { task_enabled: taskEnabled(serialized) }, description: windowsTaskDescription(serialized) };
  }
}
