/**
 * What the owner is allowed to know about their own brain's condition.
 *
 * WHY A PROJECTION AND NOT A PROXY
 *
 * `diagnose`, `freshness` and `vectorReadiness` are admin-key routes, and the
 * key that reads them can also ingest, purge, reindex and drain. A client-facing
 * page that asked for it would be training people to hand out that credential,
 * which is the same reasoning that put the bank feed and the ledger in front of
 * the key gate. So the owner gets a curated view, composed here, over their
 * passkey session.
 *
 * Three things are deliberately NOT passed through:
 *
 *  - `finding.action`. Every diagnose remedy is a `brain` CLI command the owner
 *    cannot run. Showing it as their to-do makes the product look broken and
 *    them look responsible. Each problem carries `fix_owner: "installer"`
 *    instead, which is the true answer.
 *  - `source.name`. It is a slug constrained to [a-z0-9_-], not a label. It is
 *    translated here so no surface has to guess.
 *  - `finding.samples`. The owner may see their own documents elsewhere; a
 *    status summary is not where a list of filenames belongs.
 *
 * THE INVARIANT, same as the ledger transport
 *
 * A sub-read that failed must not appear as a zero. `documents: 0` is the most
 * dangerous number in this file: an empty corpus and an unreachable diagnose
 * look identical once a failure is flattened, and "your brain holds nothing" is
 * a very different sentence from "we could not check". A failed read names
 * itself in `unavailable` and its keys are ABSENT.
 */

import { settleMeaningSearch, sourceCoverageFromEvidence } from "./source-coverage.js";

/** Slug to something a person can read. The slug is never rendered. */
const SOURCE_LABELS = {
  curated: "Files you uploaded",
  drive: "Google Drive",
  message: "Messages",
  gmail: "Email",
  calendar: "Calendar",
  zoom: "Meeting recordings",
  imap: "Email",
  imessage: "Messages",
  whatsapp: "Messages",
  "iphone-backup": "Messages",
  dropbox: "Dropbox",
  box: "Box",
  microsoft: "Microsoft 365",
  notion: "Notion",
  slack: "Slack",
  hubspot: "HubSpot",
  quickbooks: "QuickBooks Online",
  plaid: "Banking transactions",
};

/** Kinds are a small closed set and make a better fallback than a slug. */
const KIND_LABELS = {
  upload: "Files you uploaded",
  drive: "Google Drive",
  message: "Messages",
  email: "Email",
  gmail: "Email",
  calendar: "Calendar",
  zoom: "Meeting recordings",
  imap: "Email",
  imessage: "Messages",
  whatsapp: "Messages",
  "iphone-backup": "Messages",
  dropbox: "Dropbox",
  box: "Box",
  microsoft: "Microsoft 365",
  notion: "Notion",
  slack: "Slack",
  hubspot: "HubSpot",
  quickbooks: "QuickBooks Online",
  plaid: "Banking transactions",
};

const COVERAGE_STATES = Object.freeze({
  starter_context: new Set(["preparing", "ready", "degraded"]),
  live_updates: new Set(["catching_up", "current", "stale", "unavailable"]),
  history: new Set(["not_started", "running", "complete", "needs_attention", "unknown"]),
  meaning_search: new Set(["projecting", "ready", "degraded", "unknown"]),
});

const COVERAGE_FALLBACK = Object.freeze({
  starter_context: "degraded",
  live_updates: "unavailable",
  history: "unknown",
  meaning_search: "degraded",
});

const ownerCount = (value) => {
  if (value === null || value === undefined || value === "") return null;
  return Number.isFinite(Number(value)) && Number(value) >= 0
    ? Math.floor(Number(value))
    : null;
};

const ownerDate = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

function ownerCoverageFor(source, vectors) {
  const raw = settleMeaningSearch(
    source.coverage || sourceCoverageFromEvidence(source),
    vectors,
  );
  const dimension = (name) => {
    const value = String(raw?.[name]?.state || "");
    return { state: COVERAGE_STATES[name].has(value) ? value : COVERAGE_FALLBACK[name] };
  };
  return {
    starter_context: dimension("starter_context"),
    live_updates: dimension("live_updates"),
    history: dimension("history"),
    meaning_search: dimension("meaning_search"),
    confirmed_range: {
      from: ownerDate(raw?.confirmed_range?.from),
      through: ownerDate(raw?.confirmed_range?.through),
    },
    target_range: {
      from: ownerDate(raw?.target_range?.from),
      through: ownerDate(raw?.target_range?.through),
    },
    current_window: raw?.current_window && typeof raw.current_window === "object"
      ? { from: ownerDate(raw.current_window.from), through: ownerDate(raw.current_window.through) }
      : null,
    counts: {
      seen: ownerCount(raw?.counts?.seen),
      accepted: ownerCount(raw?.counts?.accepted),
      refused: ownerCount(raw?.counts?.refused),
      failed: ownerCount(raw?.counts?.failed),
    },
    last_progress_at: ownerDate(raw?.last_progress_at),
    projection_pending: ownerCount(raw?.projection_pending),
    waiting_on_owner_machine: raw?.waiting_on_owner_machine === true,
  };
}

function labelFor(source) {
  // Kind is the connector authority. A customer may choose a source name that
  // collides with a built-in slug, so name-first lookup can turn a local upload
  // called "drive" into a false Google Drive provenance claim.
  if (source.kind) return KIND_LABELS[source.kind] || "Another source";
  return SOURCE_LABELS[source.name] || "Another source";
}

const zoneLabel = (value) => String(value || "")
  .trim()
  .replace(/[_-]+/g, " ")
  .replace(/\b\w/g, (letter) => letter.toUpperCase())
  .slice(0, 80);

function ownerAccessZone(source) {
  if (source.state === "unregistered" || source.kind === "unregistered") {
    return { state: "unregistered", label: null };
  }
  const label = zoneLabel(source.zone);
  return label
    ? { state: "assigned", label }
    : { state: "unassigned", label: null };
}

const exactNonnegativeCount = (value) =>
  Number.isSafeInteger(value) && value >= 0;

/**
 * A diagnose object is not proof merely because the call returned an object.
 * In particular, diagnose deliberately returns `complete:false` with null
 * totals when D1 could not run its checks. Projecting that report would turn
 * "unknown" back into the customer-visible zero counts this status endpoint
 * exists to prevent.
 */
function completeDiagnoseProjection(report) {
  return report?.complete === true &&
    Array.isArray(report.findings) &&
    Array.isArray(report.unavailable_checks) &&
    report.unavailable_checks.length === 0 &&
    ["documents", "chunks", "sources"].every((key) =>
      exactNonnegativeCount(report.totals?.[key])) &&
    ["crit", "warn", "info", "ok", "unavailable"].every((key) =>
      exactNonnegativeCount(report.summary?.[key])) &&
    report.summary.unavailable === 0;
}

export async function ownerSystemStatus(env, deps) {
  const unavailable = [];
  const out = {};

  const [health, diag, fresh, vectors] = await Promise.all([
    (async () => deps.health(env))().catch(() => null),
    deps.diagnose(env).catch(() => null),
    deps.freshness(env).catch(() => null),
    deps.vectorReadiness(env).catch(() => null),
  ]);

  // `accepting_documents` absent is a third answer, not a default to yes. A
  // brain that cannot say whether it is accepting documents has not said yes.
  out.accepting_documents = typeof health?.accepting_documents === "boolean"
    ? health.accepting_documents
    : null;
  out.status = health?.status ?? null;
  out.drain_mode = health?.vector_drain_mode ?? null;
  if (!health) unavailable.push("health");

  if (completeDiagnoseProjection(diag)) {
    out.documents = diag.totals.documents;
    out.chunks = diag.totals.chunks;
    out.problem_counts = {
      crit: diag.summary.crit,
      warn: diag.summary.warn,
      info: diag.summary.info,
    };
    out.problems = (diag.findings || [])
      .filter((f) => f.severity === "crit" || f.severity === "warn")
      .map((f) => ({
        id: f.id,
        area: f.area,
        severity: f.severity,
        count: Number(f.count || 0),
        title: f.title,
        detail: f.detail,
        // Every diagnose remedy is an operator command. Saying so is the
        // difference between "you have a task" and "someone owes you a fix".
        fix_owner: "installer",
      }));
  } else if (diag?.complete === false) {
    // A bounded partial report can carry counts and problems that were
    // positively observed. It cannot turn an unknown count into zero, surface
    // the meta warning itself as a corpus defect, or publish a clean problem
    // register while some checks remain unavailable.
    if (exactNonnegativeCount(diag.totals?.documents)) out.documents = diag.totals.documents;
    if (exactNonnegativeCount(diag.totals?.chunks)) out.chunks = diag.totals.chunks;
    const unavailableIds = new Set(Array.isArray(diag.unavailable_checks)
      ? diag.unavailable_checks.map(String)
      : []);
    const confirmedFindings = Array.isArray(diag.findings)
      ? diag.findings.filter((finding) =>
          finding?.incomplete !== true && finding?.observable !== false &&
          ["coverage", "integrity", "efficiency"].includes(finding?.area) &&
          !unavailableIds.has(String(finding?.id || "")))
      : [];
    const confirmedProblems = confirmedFindings
      .filter((finding) => finding.severity === "crit" || finding.severity === "warn");
    if (confirmedProblems.length) {
      out.problem_counts = {
        crit: confirmedFindings.filter((finding) => finding.severity === "crit").length,
        warn: confirmedFindings.filter((finding) => finding.severity === "warn").length,
        info: confirmedFindings.filter((finding) => finding.severity === "info").length,
      };
      out.problems = confirmedProblems.map((finding) => ({
        id: finding.id,
        area: finding.area,
        severity: finding.severity,
        count: Number(finding.count || 0),
        title: finding.title,
        detail: finding.detail,
        fix_owner: "installer",
      }));
    }
    unavailable.push("diagnose");
  } else {
    unavailable.push("diagnose");
  }

  if (fresh && fresh.unavailable !== true && Array.isArray(fresh.sources)) {
    // Older or partially migrated freshness projections do not carry zone at
    // all. Treat that as one unavailable sub-read and omit every per-source
    // access_zone field; mixing known-looking nulls with missing proof would
    // turn "could not check" into "owner-only".
    const zonesAvailable = fresh.sources.every((source) => Object.hasOwn(source, "zone"));
    if (!zonesAvailable) unavailable.push("zones");
    out.sources = (fresh.sources || []).map((s) => ({
      label: labelFor(s),
      kind: s.kind,
      state: s.state,
      documents: Number(s.documents || 0),
      days_since_ingest: s.days_since_ingest ?? null,
      reason: s.reason ?? null,
      automatable: !!s.automatable,
      coverage: ownerCoverageFor(s, vectors),
      ...(zonesAvailable ? { access_zone: ownerAccessZone(s) } : {}),
    }));
  } else {
    unavailable.push("freshness");
    unavailable.push("zones");
  }

  if (vectors) {
    const expected = Number(vectors.expected_vectors || 0);
    const visible = Number(vectors.actual_vectors || 0);
    out.vectors = {
      ready: !!vectors.ready,
      expected,
      visible,
      pending: Number(vectors.pending || 0),
      // The one number an owner actually asks for on install day.
      percent_visible: expected > 0 ? Math.floor((visible / expected) * 100) : null,
    };
  } else {
    unavailable.push("vectors");
  }

  out.unavailable = unavailable;
  return out;
}
