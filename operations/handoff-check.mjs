const PROVIDERS = new Set(["quickbooks", "slack", "notion", "microsoft", "dropbox", "hubspot"]);
const SOURCE_LANES = new Set(["gmail", "calendar", "imap"]);

const DESCRIPTORS = Object.freeze({
  google_drive: { kind: "drive", lane: "drive", defaultName: "drive" },
  gmail: { kind: "gmail", lane: "source", defaultName: "gmail" },
  calendar: { kind: "calendar", lane: "source", defaultName: "calendar" },
  imap: { kind: "imap", lane: "source", defaultName: "imap" },
  imessage: { kind: "imessage", lane: "imessage", defaultName: "imessage" },
  zoom: { kind: "zoom", lane: "unsupported", defaultName: "zoom" },
  slack: { kind: "slack", lane: "provider", defaultName: "slack" },
  notion: { kind: "notion", lane: "provider", defaultName: "notion" },
  quickbooks: { kind: "quickbooks", lane: "provider", defaultName: "quickbooks" },
  microsoft: { kind: "microsoft", lane: "provider", defaultName: "microsoft" },
  dropbox: { kind: "dropbox", lane: "provider", defaultName: "dropbox" },
  hubspot: { kind: "hubspot", lane: "provider", defaultName: "hubspot" },
  upload: { kind: "upload", lane: "unsupported", defaultName: "upload" },
  local_folder: { kind: "upload", lane: "folder", defaultName: "documents" },
  bank_feed: { kind: "plaid", lane: "unsupported", defaultName: "plaid" },
  whatsapp: { kind: "whatsapp", lane: "whatsapp", defaultName: "whatsapp" },
});

function sourceName(key, config, descriptor) {
  if (typeof config?.source === "string" && config.source) return config.source;
  if (key === "bank_feed" && typeof config?.provider === "string" && config.provider) return config.provider;
  return descriptor.defaultName;
}

/** Manifest-only handoff scope. Enabled means in scope unless explicitly excluded. */
export function configuredHandoffSources(manifest) {
  const exclusions = manifest?.operations?.handoff_out_of_scope_sources;
  if (exclusions !== undefined && !Array.isArray(exclusions)) {
    throw new TypeError("operations.handoff_out_of_scope_sources must be an array of source names");
  }
  const excluded = new Set((exclusions || []).map((value) => String(value)));
  const enabled = [];
  for (const [key, config] of Object.entries(manifest?.corpora || {})) {
    if (key.startsWith("_") || config?.enabled !== true) continue;
    const base = DESCRIPTORS[key] || {
      kind: key,
      lane: PROVIDERS.has(key) ? "provider" : SOURCE_LANES.has(key) ? "source" : "unsupported",
      defaultName: key,
    };
    enabled.push(Object.freeze({
      manifest_key: key,
      name: sourceName(key, config, base),
      kind: base.kind,
      lane: base.lane,
    }));
  }
  const names = new Set();
  for (const source of enabled) {
    if (names.has(source.name)) throw new TypeError(`handoff scope contains duplicate source name ${source.name}`);
    names.add(source.name);
  }
  const unknownExclusion = [...excluded].find((name) => !names.has(name));
  if (unknownExclusion) {
    throw new TypeError(`handoff out-of-scope source is not enabled: ${unknownExclusion}`);
  }
  return {
    in_scope: enabled.filter((source) => !excluded.has(source.name)),
    out_of_scope: enabled.filter((source) => excluded.has(source.name)),
  };
}

function macScheduleHealthy(status) {
  return status?.installed === true && status?.loaded === true &&
    status?.definitionDrift !== true && status?.definitionMatches !== false &&
    status?.loadedDefinitionMatches === true && status?.enabled === true &&
    status?.interpreterPresent !== false && !status?.scheduleError;
}

/** Inspect only machine-local schedule definitions. No install or repair occurs. */
export async function inspectHandoffSchedule(manifestPath, source, options = {}) {
  const platform = options.platform || process.platform;
  const schedulerOptions = options.schedulerOptions || {};
  try {
    if (platform === "win32" && ["drive", "folder", "source", "provider"].includes(source.lane)) {
      const scheduler = options.windowsScheduler ?? await import("./windows-task-scheduler.mjs");
      const status = scheduler.statusWindowsScheduler(manifestPath, {
        ...schedulerOptions,
        action: "status",
        folder: source.lane === "folder",
        provider: source.lane === "provider" ? source.kind : null,
        source: source.lane === "source" ? source.kind : null,
      });
      return {
        installed: status?.installed === true,
        last_error: status?.scheduleError || null,
      };
    }
    if (platform !== "darwin") {
      return { installed: false, last_error: "this source has no packaged schedule on this operating system" };
    }
    let status;
    if (source.lane === "drive") {
      const scheduler = options.driveScheduler ?? await import("./drive-scheduler.mjs");
      status = scheduler.statusDriveScheduler(manifestPath, schedulerOptions);
    } else if (source.lane === "folder") {
      const scheduler = options.folderScheduler ?? await import("./folder-scheduler.mjs");
      status = scheduler.statusFolderScheduler(manifestPath, schedulerOptions);
    } else if (source.lane === "source") {
      const scheduler = options.sourceScheduler ?? await import("./source-scheduler.mjs");
      status = scheduler.statusSourceScheduler(source.kind, manifestPath, schedulerOptions);
    } else if (source.lane === "provider") {
      const scheduler = options.providerScheduler ?? await import("./provider-scheduler.mjs");
      status = scheduler.statusProviderScheduler(source.kind, manifestPath, schedulerOptions);
    } else if (source.lane === "imessage") {
      const scheduler = options.imessageScheduler ?? await import("./imessage-scheduler.mjs");
      status = scheduler.statusImessageScheduler(manifestPath, schedulerOptions);
    } else if (source.lane === "whatsapp") {
      const daemon = options.whatsappDaemon ?? await import("./whatsapp-daemon.mjs");
      const drain = options.whatsappDrainScheduler ?? await import("./whatsapp-drain-scheduler.mjs");
      const daemonStatus = daemon.statusWhatsappDaemon(manifestPath, schedulerOptions);
      const drainStatus = drain.statusWhatsappDrainScheduler(manifestPath, schedulerOptions);
      const daemonHealthy = daemonStatus?.installed === true && daemonStatus?.loaded === true &&
        daemonStatus?.definitionDrift !== true && daemonStatus?.definitionMatches !== false &&
        !daemonStatus?.planError;
      return {
        installed: daemonHealthy && macScheduleHealthy(drainStatus),
        last_error: daemonStatus?.planError ||
          (!daemonHealthy ? "the WhatsApp capture daemon is unloaded or its definition has changed" : null) ||
          drainStatus?.scheduleError ||
          (drainStatus?.lastRunSucceeded === false ? `last scheduled run failed with exit code ${drainStatus.lastExitCode}` : null),
      };
    } else {
      return { installed: false, last_error: "this enabled source has no packaged unattended schedule" };
    }
    return {
      installed: macScheduleHealthy(status),
      last_error: status?.scheduleError ||
        (status?.lastRunSucceeded === false ? `last scheduled run failed with exit code ${status.lastExitCode}` : null),
    };
  } catch {
    return { installed: false, last_error: "the local schedule could not be inspected" };
  }
}

export async function collectHandoffCheck(manifestPath, options = {}) {
  const manifest = options.manifest;
  if (!manifest || typeof manifest !== "object") throw new TypeError("handoff check requires the parsed manifest");
  if (typeof options.readFreshness !== "function") throw new TypeError("handoff check requires a read-only freshness reader");
  const scope = configuredHandoffSources(manifest);
  const freshness = await options.readFreshness();
  const remote = new Map((freshness?.sources || []).map((source) => [source.name, source]));
  const scheduleStatus = options.scheduleStatus ?? ((source) =>
    inspectHandoffSchedule(manifestPath, source, options));
  const sources = [];

  for (const source of scope.in_scope) {
    const observed = remote.get(source.name) || null;
    const local = await scheduleStatus(source);
    const schedule = observed?.schedule || null;
    const connected = Boolean(observed) && ["ready", "indexing", "error"].includes(String(observed.source_status || ""));
    const firstRun = Boolean(schedule?.first_run_at);
    const secondRun = schedule?.second_run_observed === true;
    const operationalError = ["broken", "review", "missed"].includes(String(observed?.state || ""))
      ? observed?.reason || "the source needs attention"
      : null;
    const lastError = local?.last_error || operationalError || null;
    const row = {
      name: source.name,
      kind: source.kind,
      connected,
      schedule_installed: local?.installed === true,
      first_run: firstRun,
      first_run_at: schedule?.first_run_at || null,
      second_run_observed: secondRun,
      next_run: schedule?.next_run_at || null,
      last_error: lastError,
      green: connected && local?.installed === true && firstRun && secondRun &&
        schedule?.state === "proven" && lastError === null,
    };
    sources.push(Object.freeze(row));
  }
  return Object.freeze({
    complete: sources.every((source) => source.green),
    sources: Object.freeze(sources),
    out_of_scope: Object.freeze(scope.out_of_scope),
  });
}

const yesNo = (value) => value ? "yes" : "no";

export function renderHandoffCheck(result) {
  const lines = [`Handoff check: ${result.complete ? "READY" : "NOT READY"}`];
  for (const source of result.sources) {
    const waiting = !source.first_run
      ? "waiting for first run"
      : !source.second_run_observed
        ? "waiting for second run"
        : source.green
          ? "green"
          : "needs attention";
    lines.push(
      `${source.name}: connected ${yesNo(source.connected)}; schedule installed ${yesNo(source.schedule_installed)}; ` +
      `first run ${yesNo(source.first_run)}; second run ${yesNo(source.second_run_observed)}; ${waiting}; ` +
      `next run ${source.next_run || "unknown"}; last error ${source.last_error || "none"}`,
    );
  }
  if (result.out_of_scope.length) {
    lines.push(`Explicitly out of scope: ${result.out_of_scope.map((source) => source.name).join(", ")}`);
  }
  if (!result.complete) lines.push("Next: fix each named source or explicitly mark it out of scope before handoff.");
  return `${lines.join("\n")}\n`;
}
