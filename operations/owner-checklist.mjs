import { customApiMoveMessage, customApiRedirectMessage } from "../worker/src/lib/custom-api-visibility.js";

const sourceLabels = {
  gmail: "Gmail", drive: "Google Drive", calendar: "Calendar", imap: "Email",
  outlook: "Outlook", folder: "Watched folder", zoom: "Zoom", quickbooks: "QuickBooks",
  whatsapp: "WhatsApp", imessage: "iMessage", custom_api: "Business data connection",
};

const installer = "Ask your installer to check it.";
const pass = label => `✔ ${label}`;
const attention = label => `${label} needs attention. ${installer}`;
const singleLine = value => String(value ?? "").replace(/[\x00-\x1f\x7f]/gu, " ").trim();

function checksFirst(rows) {
  return [...new Set([...rows.filter(row => row.startsWith("✔ ")), ...rows.filter(row => !row.startsWith("✔ "))])];
}

const selfcheckLabels = {
  bank: "Bank access", secrets: "Brain service connections", sources: "Saved source connections",
  daily: "Daily update", claude: "Claude Code connection",
};

export function ownerSelfcheckRows(report) {
  return (report?.checks ?? []).filter(check => check.status !== "passed").map(check =>
    attention(selfcheckLabels[check.category] ?? "A Brain verification check"));
}

export function ownerSourceRows(sources, { dailyEnabled } = {}) {
  return checksFirst(sources.flatMap(source => {
    const name = singleLine(source.name);
    const kind = source.kind;
    const label = Object.hasOwn(sourceLabels, kind) ? sourceLabels[kind] : "Source";
    const subject = name && name !== kind ? `${label} (${name})` : label;
    if (source.state === "manual") return [];
    if (source.state === "unscheduled" && dailyEnabled !== true) return [];
    const scheduled = dailyEnabled !== false && Number.isFinite(source.expected_every_days) &&
      source.expected_every_days > 0;
    if (scheduled && source.continuation === "rate_limited") {
      return [`${subject} will continue on its next scheduled run.`];
    }
    if (source.state === "indexing" || (scheduled && source.continuation === "catching_up")) {
      return [scheduled ? `${subject} is catching up and will finish on its own.`
        : `${subject} is updating now.`];
    }
    const moves = kind === "custom_api" && Array.isArray(source.endpoint_moves)
      ? source.endpoint_moves.map((move) => singleLine(customApiMoveMessage(move))) : [];
    if (source.state === "ok" && !source.continuation && source.source_status !== "ready_with_warnings" &&
        source.coverage?.history?.state !== "needs_attention") return [pass(`${subject} is up to date`), ...moves];
    if (kind === "custom_api" && typeof source.redirect_address === "string") {
      return [singleLine(customApiRedirectMessage(source.redirect_address)), ...moves];
    }
    return [`${subject} could not finish updating. ${installer}`, ...moves];
  }));
}

const access = "Brain access protection";
const retrieval = ["Document search", "Document search is working"];
const answer = ["Document answers", "The Brain answered the document check"];
const model = ["The configured answer model", "The configured answer model is working"];
const acceptanceLabels = new Map([
  ["health responds", ["Brain connection", "Brain is online"]],
  ["unauthenticated request is refused", [access, "Private records require authorized access"]],
  ["wrong key is refused", [access, "Invalid access is blocked"]],
  ["correct key is accepted", [access, "Authorized access works"]],
  ["credential gate refuses a token", [access, "Credentials are blocked from storage"]],
  ["refusal does not echo the secret", [access, "Credentials are kept out of responses"]],
  ["corpus summary", ["Saved records", "Saved records are available"]],
  ["corpus is not empty", ["Saved records", "Saved records are available"]],
  ["embedding backlog is small", ["Search indexing", "No records are waiting to be indexed"]],
  ["storage backend matches manifest", ["Brain storage", "Brain storage is connected"]],
  ["semantic index is query-ready", retrieval],
  ["semantic retrieval is active", retrieval],
  ["think uses semantic retrieval", retrieval],
  ["probe coverage", retrieval],
  ["think endpoint", answer],
  ["think response contract", answer],
  ["think returns an answer", answer],
  ["answer carries inline citations", ["Answer sources", "Answers cite their sources"]],
  ["schema is migrated", ["Brain database", "Brain database setup is recorded"]],
  ["deployed version matches the manifest", ["Installed version", "The expected version is online"]],
  ["daily spend cap configured", ["Daily spending limit", "Daily spending limit is set"]],
  ["every source expected to refresh is current", ["Source updates", "Sources are up to date"]],
  ["install state records the running version", ["Local version record", "The local version record is current"]],
  ["configured answer model returned an answer", model],
  ["configured answer model matches", model],
]);

const internalChecks = new Set([
  "document boundary reading", "document answer probe", "think money hand-off",
  "answer citation discipline", "gap analysis present", "think degrades cleanly",
  "credential gate version recorded",
  "configured answer model ran",
]);

export function acceptanceDiagnostics({ results }) {
  // Keep the reviewed diagnostic copy only. Probe names can contain questions.
  return results.filter(row => internalChecks.has(row.name) && row.status !== "fail");
}

export function ownerAcceptanceRows({ results, sources }, { dailyEnabled } = {}) {
  const rows = [];
  const failed = new Set();
  for (const row of results) {
    if (row.status === "skip" || (internalChecks.has(row.name) && row.status !== "fail")) continue;
    if (Array.isArray(sources) && (row.name.startsWith("freshness: ") ||
        (sources.length > 0 && row.name === "every source expected to refresh is current"))) continue;
    const [label, passed] = acceptanceLabels.get(row.name) ??
      (row.name.startsWith("probe: ") ? retrieval
        : row.name.startsWith("answer unavailable at ") || internalChecks.has(row.name) ? answer
        : ["A Brain verification check", ""]);
    if (row.status === "pass") {
      if (passed) rows.push({ label, text: pass(passed) });
    } else if (row.name === "embedding backlog is small" && row.status === "warn") {
      rows.push({ label, text: "Search indexing is still in progress." });
    } else {
      failed.add(label);
    }
  }
  return checksFirst([
    ...rows.filter(row => !failed.has(row.label)).map(row => row.text),
    ...(Array.isArray(sources) ? ownerSourceRows(sources, { dailyEnabled }) : []),
    ...[...failed].map(attention),
  ]);
}

const doctorLabels = new Map([
  ["Node", "Local runtime"], ["wrangler", "Update tools"], ["Vectorize", "Search service"],
  ["Cloudflare plan:", "Cloudflare plan"], ["priority slice", "First import setup"],
  ["Anthropic Worker key", "Answer model connection"], ["Claude Code", "Claude Code sign-in"],
  ["wrangler login", "Cloudflare sign-in"], ["migration checksums", "Brain database"],
]);

export function ownerDoctorRow(check, { googleExpected = true } = {}) {
  const label = doctorLabels.get(check.name) || singleLine(check.name).replace(/:$/u, "");
  if (!googleExpected && check.name === "Google connection" &&
      check.status === "warn" && check.detail === "not connected") return null;
  if (check.status === "ok") {
    if (check.available === false ||
        /^(?:not (?:in use|required|checked)|isn't installed|setup asks|handoff is complete)/iu.test(check.detail || "")) return null;
    if (check.name === "upgrade state") {
      return check.version ? pass(`Version ${check.version}`) : pass("Brain accepts new records");
    }
    if (check.name === "Claude Code" || check.name === "Codex") return pass(`${label.replace(/ sign-in$/u, "")} is signed in`);
    return pass(`${label} checked`);
  }
  if (check.name === "upgrade state" && check.status === "fail") {
    return "The Brain update is paused. Ask your installer to finish it.";
  }
  return attention(label);
}

export function ownerDailyRow(job) {
  if (!job) return null;
  if (!job.present) return null;
  if (!job.enabled) return "Daily update is off.";
  const start = job.schedule?.[0];
  const time = start?.split("T").at(-1);
  if (!time || job.schedule[1] !== 1) return pass("Daily update is on");
  const [hours, minutes] = time.split(":");
  const localTime = `${Number(hours) % 12 || 12}:${minutes} ${Number(hours) < 12 ? "AM" : "PM"}`;
  return pass(`Daily update on, scheduled for ${localTime}`);
}

export function ownerUpdateRows({ version, acceptance, daily, bank, schedulers = [], wired = [], attentionItems = [] }) {
  const connections = bank?.filter(row => row.state !== "removed") ?? [];
  const bankConnected = connections.length > 0 && connections.every(row => row.ok === true && row.state === "connected");
  const bankNeedsAttention = connections.some(row =>
    row.ok === false || ["reauth_required", "permission_revoked", "login_required", "error"].includes(row.state));
  const pendingDailyChoice = !daily?.enabled && schedulers.some(row =>
    row.kind === "daily-bridge" && row.state === "COULD NOT MOVE");
  return checksFirst([
    pass(`Version ${version}`),
    ...(acceptance ? ownerAcceptanceRows(acceptance, { dailyEnabled: daily?.enabled }) : []),
    pendingDailyChoice ? null : ownerDailyRow(daily),
    ...schedulers.filter(row => !["daily", "daily-bridge"].includes(row.kind) &&
      ["moved", "already current"].includes(row.state)).map(row => pass(`${row.label} schedule verified`)),
    bankConnected && pass("Bank connected"),
    bankNeedsAttention && attention("Bank access"),
    ...wired.map(name => pass(`${name} connection verified`)),
    ...attentionItems,
  ].filter(Boolean));
}
