/** Pure manifest-derived daily-refresh planning. */
import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { resolve, win32 as win32Path } from "node:path";
import { spawnSync } from "node:child_process";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  const bytes = typeof value === "string" ? value : JSON.stringify(canonical(value));
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function dailyRefreshPrincipal({
  platform = process.platform,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  username = userInfo().username,
  home = homedir(),
  windowsSid = null,
  spawn = spawnSync,
  environment = process.env,
} = {}) {
  if (platform === "win32") {
    let sid = windowsSid;
    if (!sid) {
      const systemRoot = environment.SystemRoot || environment.SYSTEMROOT || environment.WINDIR;
      if (!win32Path.isAbsolute(String(systemRoot || ""))) {
        throw new Error("the current Windows user SID is unavailable; daily scheduling stopped before mutation");
      }
      const command = win32Path.join(systemRoot, "System32", "whoami.exe");
      const childEnvironment = {};
      if (systemRoot) childEnvironment.SystemRoot = systemRoot;
      if (environment.WINDIR) childEnvironment.WINDIR = environment.WINDIR;
      const result = spawn(command, ["/user", "/fo", "csv", "/nh"], {
        encoding: "utf8",
        windowsHide: true,
        env: childEnvironment,
      });
      const fields = String(result?.stdout || "").match(/"([^"]*)"\s*,\s*"(S-1-[0-9-]+)"/u);
      if (result?.status !== 0 || !fields) {
        throw new Error("the current Windows user SID is unavailable; daily scheduling stopped before mutation");
      }
      sid = fields[2];
    }
    if (!/^S-1-[0-9-]+$/u.test(String(sid))) {
      throw new Error("the current Windows user SID is unavailable; daily scheduling stopped before mutation");
    }
    return `sid:${sid}`;
  }
  if (Number.isInteger(uid) && uid >= 0) return `uid:${uid}`;
  const fallback = digest({ username: String(username || ""), home: resolve(home || ".") }).slice(7, 39);
  return `user:${fallback}`;
}

function brainIdentity(m) {
  const cloudflare = m?.infrastructure?.cloudflare || {};
  if (cloudflare.d1_database_id) {
    return { kind: "d1", account_id: cloudflare.account_id || null, d1_database_id: cloudflare.d1_database_id };
  }
  if (m?.brain?.worker_name) {
    return { kind: "worker", account_id: cloudflare.account_id || null, worker_name: m.brain.worker_name };
  }
  if (m?.brain?.domain) return { kind: "domain", domain: m.brain.domain };
  if (m?.client?.slug) return { kind: "prepared-manifest", slug: m.client.slug };
  throw new Error("the manifest needs a canonical Brain identity before daily refresh can be planned");
}

export function dailyRefreshIdentity(m, principal) {
  const normalized = String(principal || "");
  if (!normalized || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error("the operating-system user identity is unavailable");
  }
  const brain = brainIdentity(m);
  const hash = createHash("sha256").update(JSON.stringify({ version: 1, brain, principal: normalized })).digest("hex");
  return Object.freeze({ version: 1, id: `v1-${hash.slice(0, 24)}`, principal: normalized, brain_hash: `sha256:${hash}` });
}

function classify(entry, configured) {
  if (configured?.enabled !== true) {
    return { class: "disabled", owner: "none", status: "skipped", reason: entry?.reason || "not enabled in this manifest" };
  }
  if (!entry) {
    return { class: "unsupported", owner: "none", status: "unavailable", reason: "enabled in this manifest, but this build has no source descriptor" };
  }
  if (entry.daily_class) {
    return {
      class: entry.daily_class,
      owner: entry.daily_owner || (entry.daily_class === "machine-pull" ? "daily-task" : "none"),
      status: entry.status,
      reason: entry.reason || null,
    };
  }
  if (entry.status === "unavailable") {
    return { class: "unsupported", owner: "none", status: "unavailable", reason: entry.reason || "source is unavailable" };
  }
  return {
    class: "machine-pull",
    owner: entry.daily_owner || "daily-task",
    status: entry.status,
    reason: entry.reason || null,
  };
}

function dailyConfiguration(m, localTimezone) {
  const raw = m.operations?.daily_refresh;
  const configured = raw === undefined ? {} : raw;
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) {
    return { configured: {}, error: "operations.daily_refresh must be one object" };
  }
  if (configured.enabled !== undefined && typeof configured.enabled !== "boolean") {
    return { configured, error: "operations.daily_refresh.enabled must be true or false" };
  }
  const cron = configured.cron ?? "0 9 * * *";
  const match = typeof cron === "string" && cron.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/u);
  if (!match || Number(match[1]) > 59 || Number(match[2]) > 23) {
    return { configured, error: "operations.daily_refresh.cron must be one valid numeric minute/hour daily schedule" };
  }
  const timezone = configured.timezone ?? m.client?.timezone ?? localTimezone ?? "UTC";
  if (typeof timezone !== "string" || !timezone || timezone !== timezone.trim() || /[\u0000-\u001f\u007f]/u.test(timezone)) {
    return { configured, error: "operations.daily_refresh.timezone must be one non-empty IANA timezone name" };
  }
  const maxRuntime = configured.max_runtime_minutes ?? 45;
  if (!Number.isInteger(maxRuntime) || maxRuntime < 1 || maxRuntime > 720) {
    return { configured, error: "operations.daily_refresh.max_runtime_minutes must be an integer from 1 through 720" };
  }
  return { configured, cron, timezone, maxRuntime, error: null };
}

function selectDailySources(sources, configured) {
  if (configured.sources === undefined) return { sources, error: null };
  const selection = configured.sources;
  const refuse = (reason) => ({ sources, error: `operations.daily_refresh.sources ${reason}` });
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
    return refuse("must be an object of exact manifest source keys");
  }
  const byKey = new Map(sources.map((source) => [source.key, source]));
  for (const [key, choice] of Object.entries(selection)) {
    const source = byKey.get(key);
    if (!source) return refuse("contains an unknown source key; aliases and whitespace are not accepted");
    // Selection cannot adopt unsupported, disabled, or independently managed
    // sources, nor claim to hold a writer owned by another scheduler.
    if (!source.enabled || source.class !== "machine-pull" || source.owner !== "daily-task") {
      return refuse("can select or hold only enabled machine-pull sources owned by the daily task");
    }
    if (!choice || typeof choice !== "object" || Array.isArray(choice) ||
        Object.keys(choice).some((field) => !["state", "reason"].includes(field)) ||
        !["selected", "held"].includes(choice.state)) {
      return refuse("entries require state selected or held and no unknown properties");
    }
    if (choice.state === "held") {
      if (typeof choice.reason !== "string" || !choice.reason || choice.reason.length > 240 ||
          choice.reason !== choice.reason.trim() || /[\u0000-\u001f\u007f]/u.test(choice.reason)) {
        return refuse("held entries require a non-empty, single-line reason of at most 240 characters without surrounding whitespace");
      }
    } else if (Object.hasOwn(choice, "reason")) {
      return refuse("selected entries cannot carry a hold reason");
    }
  }
  if (sources.some((source) => source.enabled && source.class === "machine-pull" &&
      source.owner === "daily-task" && !Object.hasOwn(selection, source.key))) {
    return refuse("must explicitly select or hold every enabled daily-owned machine-pull source");
  }
  return {
    error: null,
    sources: sources.map((source) => {
      const choice = selection[source.key];
      if (!Object.hasOwn(selection, source.key)) return source;
      return Object.freeze({
        ...source,
        selection: choice.state,
        hold_reason: choice.state === "held" ? choice.reason : null,
        ...(choice.state === "held"
          ? { class: "held", owner: "none", status: "held", run_key: null, reason: choice.reason }
          : {}),
      });
    }),
  };
}

export async function planDailyRefresh({
  m,
  manifestPath,
  platform = process.platform,
  principal = dailyRefreshPrincipal({ platform }),
  localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || null,
  planLoadFn,
  planLoadOptions = {},
  existingSchedulerOwners,
} = {}) {
  if (!m || typeof m !== "object" || Array.isArray(m)) throw new TypeError("a manifest is required");
  if (typeof planLoadFn !== "function") throw new TypeError("the daily plan requires the shared load planner");
  const loadEntries = await planLoadFn({
    m,
    manifestPath,
    flags: {},
    platform,
    ...planLoadOptions,
  });
  const byKey = new Map((loadEntries || []).map((entry) => [entry.key, entry]));
  const classified = Object.entries(m.corpora || {})
    .filter(([key]) => !key.startsWith("_"))
    .map(([key, configured]) => {
      const entry = byKey.get(key);
      const decision = classify(entry, configured);
      // Configuration alone is not a connection. Keep an unconnected leg
      // visible without withholding other imports. The full manifest still
      // participates in the daily definition's owner approval.
      const quickBooks = key === "quickbooks" || key === "quickbooks_desktop";
      if (quickBooks && configured?.enabled === true && (
        entry?.connection_required === true ||
        entry?.reason?.startsWith("enabled, but not connected on this machine:") ||
        (key === "quickbooks_desktop" && !entry?.daily_class && entry?.status !== "ready")
      )) {
        Object.assign(decision, { class: "connect-required", owner: "none", status: "skipped", reason: "not connected on this machine" });
      }
      if (quickBooks && configured?.enabled === true && new Set(existingSchedulerOwners || []).has(key)) {
        Object.assign(decision, { class: "machine-pull", owner: "existing-local-scheduler", status: "skipped", reason: "owned by the QuickBooks schedule" });
      }
      if (decision.class === "machine-pull" && existingSchedulerOwners !== undefined) {
        decision.owner = new Set(existingSchedulerOwners).has(key)
          ? "existing-local-scheduler"
          : "daily-task";
      }
      return Object.freeze({
        key,
        run_key: decision.class === "machine-pull" ? key : null,
        enabled: configured?.enabled === true,
        ...decision,
        source_names: (entry?.legs || []).length
          ? entry.legs.map((leg) => String(leg.source || key))
          : [String(configured?.source || key)],
      });
    });
  const daily = dailyConfiguration(m, localTimezone);
  const configured = daily.configured;
  const selected = selectDailySources(classified, configured);
  const sources = selected.sources;
  const eligible = sources.some((source) => source.class === "machine-pull" && source.owner === "daily-task" && source.status === "ready");
  const enabled = configured.enabled === undefined ? eligible : configured.enabled === true;
  const timezone = daily.timezone || "UTC";
  const timezoneMatches = !localTimezone || timezone === localTimezone;
  const unsupported = sources.filter((source) => source.class === "unsupported");
  const unavailableDaily = sources.filter((source) =>
    source.class === "machine-pull" && source.owner === "daily-task" && source.status !== "ready"
  );
  const sourcePlanHash = digest(sources.filter((source) => source.class !== "connect-required").map(({ key, run_key, enabled, class: sourceClass, owner, status, source_names, selection, hold_reason }) => ({
    key, run_key, enabled, class: sourceClass, owner, status,
    // A held connector's local readiness may change its discovered legs. It
    // has no authorized work, so that observation cannot block selected work.
    source_names: selection === "held" ? [] : source_names,
    ...(selection === undefined ? {} : { selection, hold_reason }),
  })));
  return Object.freeze({
    schema_version: 1,
    identity: dailyRefreshIdentity(m, principal),
    manifest_path: resolve(String(manifestPath || "")),
    manifest_path_hash: digest(resolve(String(manifestPath || ""))),
    manifest_content_hash: digest(m),
    source_plan_hash: sourcePlanHash,
    platform,
    enabled,
    cron: daily.cron || "0 9 * * *",
    timezone,
    local_timezone: localTimezone,
    timezone_matches_machine: timezoneMatches,
    max_runtime_minutes: daily.maxRuntime || 45,
    ready: unsupported.length === 0 && unavailableDaily.length === 0 && timezoneMatches && !daily.error && !selected.error,
    unsupported_sources: unsupported.length,
    configuration_error: daily.error || selected.error || (unsupported.length
      ? null
      : unavailableDaily.length
        ? `enabled daily source(s) are unavailable: ${unavailableDaily.map((source) => source.key).join(", ")}`
        : timezoneMatches
          ? null
          : `manifest timezone ${timezone} does not match this machine's ${localTimezone}`),
    sources: Object.freeze(sources),
  });
}
