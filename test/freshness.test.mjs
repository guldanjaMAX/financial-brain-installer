// Coverage staleness: what the brain has not LOOKED at, as distinct from the age
// of what it retrieved.
//
// The two tests that matter most here are the ones asserting SILENCE. A warning
// that fires for something nobody can act on is how clients learn to ignore the
// warning that matters, and this feature only earns its place if it stays quiet
// when quiet is correct.

import { coverageGapReport, coverageGaps, freshnessReport } from "../worker/src/lib/store-d1.js";

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 200))); if (!c) fail++; };

const NOW = Date.parse("2026-08-19T00:00:00Z");
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();
const hoursAgo = (h) => NOW - h * 3600000;
const mk = (rows) => ({ DB: { prepare: () => ({ all: async () => ({ results: rows }), bind() { return this; } }) } });
const DAILY = 86400;

/* ---- it warns when a source we CAN refresh has gone unread ---- */
{
  const g = await coverageGaps(mk([{ name: "drive", kind: "drive", last_ingest_at: daysAgo(40), expected_refresh_seconds: DAILY }]), { now: NOW });
  check("an overdue connector produces a gap", g.length === 1 && g[0].type === "coverage_stale", JSON.stringify(g));
  check("and says how long it has been", g[0].days_since_ingest === 40, JSON.stringify(g[0]));
  check("and says material added since is invisible, not merely old",
    /not in the brain/.test(g[0].detail) && /would not show up as a missing answer/.test(g[0].detail), g[0].detail);
}

/* ---- SILENCE 1: a finished one-off load is not stale, it is done ---- */
{
  const g = await coverageGaps(mk([{
    name: "documents", kind: "upload", last_ingest_at: daysAgo(400),
    last_complete_sweep_at: daysAgo(400), expected_refresh_seconds: null,
  }]), { now: NOW });
  check("a source with no expected refresh makes NO claim, even after 400 days", g.length === 0, JSON.stringify(g));
}

/* ---- SILENCE 2: late is not broken ---- */
{
  const g = await coverageGaps(mk([{
    name: "drive", kind: "drive", last_ingest_at: daysAgo(1.25),
    last_complete_sweep_at: daysAgo(2), expected_refresh_seconds: DAILY,
  }]), { now: NOW });
  check("six hours late on a daily schedule does not warn", g.length === 0, JSON.stringify(g));
  const g2 = await coverageGaps(mk([{
    name: "drive", kind: "drive", last_ingest_at: daysAgo(2),
    last_complete_sweep_at: daysAgo(3), expected_refresh_seconds: DAILY,
  }]), { now: NOW });
  check("but twice the expected interval does", g2.length === 1, JSON.stringify(g2));
}

/* ---- a broken connector renders its reviewed recovery message ---- */
{
  const g = await coverageGaps(mk([{ name: "gmail", kind: "gmail", last_ingest_at: daysAgo(9), stale_reason: "auth_expired", expected_refresh_seconds: DAILY }]), { now: NOW });
  check("a broken sync is its own gap type", g[0]?.type === "sync_broken", JSON.stringify(g));
  check("and gives reviewed actionable guidance without exposing the stored code",
    /connection needs to be refreshed/i.test(g[0].detail) && !/auth_expired/i.test(g[0].detail),
    g[0].detail);
}

/* ---- connector-reported failure is broken immediately, schedule or not ---- */
{
  const rows = [{
    name: "drive", kind: "drive", status: "error", last_ingest_at: daysAgo(0.1),
    stale_reason: null, expected_refresh_seconds: null,
  }];
  const f = await freshnessReport(mk(rows), { now: NOW });
  check("source status=error is surfaced as broken", f.sources[0]?.state === "broken", JSON.stringify(f));
  check("a status-only error still has an actionable non-null reason",
    /last sync reported an error/.test(f.sources[0]?.reason || ""), JSON.stringify(f.sources[0]));
  check("the underlying source status is retained in the report",
    f.sources[0]?.source_status === "error", JSON.stringify(f.sources[0]));
  const g = await coverageGaps(mk(rows), { now: NOW });
  check("a connector-reported error also qualifies retrieved answers",
    g[0]?.type === "sync_broken" && /last sync reported an error/.test(g[0]?.detail || ""), JSON.stringify(g));
}

/* ---- a deliberate safety stop needs review; it is not a broken sync ---- */
{
  const rows = [{
    name: "drive", kind: "drive", status: "error", last_ingest_at: daysAgo(0.1),
    stale_reason: "SAFETY_REVIEW_REQUIRED", expected_refresh_seconds: DAILY,
  }];
  const f = await freshnessReport(mk(rows), { now: NOW });
  check("a safety-review receipt is surfaced as review instead of broken",
    f.sources[0]?.state === "review", JSON.stringify(f.sources[0]));
  check("a safety-review source carries reviewed owner guidance",
    /paused for a safety review/i.test(f.sources[0]?.reason || ""), JSON.stringify(f.sources[0]));
  const g = await coverageGaps(mk(rows), { now: NOW });
  check("a source awaiting review reports that review instead of inventing a broken sync",
    g.length === 1 && g[0].type === "sync_review" && /paused for safety review/i.test(g[0].detail || ""),
    JSON.stringify(g));
}

/* ---- a live run is distinct from a crashed or stuck run ---- */
{
  const active = {
    name: "drive", kind: "drive", status: "indexing", indexing_started_at: hoursAgo(5),
    last_ingest_at: daysAgo(1), expected_refresh_seconds: DAILY,
  };
  const atLimit = { ...active, name: "gmail", kind: "gmail", indexing_started_at: hoursAgo(6) };
  const stuck = { ...active, name: "calendar", kind: "calendar", indexing_started_at: hoursAgo(6.01) };
  const orphaned = { ...active, name: "drive-orphaned", indexing_started_at: null };
  const f = await freshnessReport(mk([active, atLimit, stuck, orphaned]), { now: NOW });
  const by = Object.fromEntries(f.sources.map((s) => [s.name, s]));
  check("an indexing run younger than six hours remains in progress",
    by.drive.state === "indexing" && by.drive.hours_indexing === 5, JSON.stringify(by.drive));
  check("six hours exactly is not called stuck", by.gmail.state === "indexing", JSON.stringify(by.gmail));
  check("an indexing run older than six hours is broken",
    by.calendar.state === "broken" && /6 hour/.test(by.calendar.reason || ""), JSON.stringify(by.calendar));
  check("an indexing row with no open run is treated as interrupted",
    by["drive-orphaned"].state === "broken" && /no open sync run/.test(by["drive-orphaned"].reason || ""), JSON.stringify(by["drive-orphaned"]));

  const g = await coverageGaps(mk([stuck]), { now: NOW });
  check("a stuck run becomes a sync_broken answer gap",
    g[0]?.type === "sync_broken" && /not completed/.test(g[0]?.detail || ""), JSON.stringify(g));
  const activeGaps = await coverageGaps(mk([{
    ...active,
    last_complete_sweep_at: daysAgo(1),
  }]), { now: NOW });
  check("a live sync keeps missing answers provisional even after a prior complete sweep",
    activeGaps.some((gap) => gap.type === "sync_in_progress" && /currently updating/i.test(gap.detail || "")),
    JSON.stringify(activeGaps));
}

/* ---- never synced is distinct from stale ---- */
{
  const g = await coverageGaps(mk([{ name: "drive", kind: "drive", last_ingest_at: null, expected_refresh_seconds: DAILY }]), { now: NOW });
  check("a source expected to refresh but never synced says so", g[0]?.type === "never_synced", JSON.stringify(g));
}

/* ---- live corpus rows outside the registry can never support an absence ---- */
{
  const rows = [{
    name: "drive", kind: "unregistered", status: "unregistered", registered: 0,
    document_count: 3, last_ingest_at: null, expected_refresh_seconds: null,
    last_complete_sweep_at: null,
  }];
  const g = await coverageGaps(mk(rows), { now: NOW });
  check("an unregistered document source keeps a missing answer provisional",
    g.length === 1 && g[0]?.type === "source_unregistered" &&
      /source-registry entry/.test(g[0]?.detail || "") &&
      /cannot be treated as proof/i.test(g[0]?.detail || ""), JSON.stringify(g));
  const f = await freshnessReport(mk(rows), { now: NOW });
  check("owner freshness exposes the unregistered source as a problem with unknown history",
    f.sources[0]?.state === "unregistered" && f.sources[0]?.kind === "unregistered" &&
      f.sources[0]?.coverage?.history?.state === "unknown", JSON.stringify(f));
}

/* ---- useful recent records never disguise unproven source history ---- */
{
  const g = await coverageGaps(mk([{
    name: "gmail", kind: "gmail", status: "ready", document_count: 66000,
    last_ingest_at: daysAgo(0.1), expected_refresh_seconds: null,
    last_complete_sweep_at: null,
  }]), { now: NOW });
  check("partial Gmail history qualifies a missing answer even without a scheduler",
    g[0]?.type === "history_unproven" && /missing result may still be outside confirmed coverage/i.test(g[0]?.detail || ""),
    JSON.stringify(g));
  const complete = await coverageGaps(mk([{
    name: "gmail", kind: "gmail", status: "ready", document_count: 66000,
    last_ingest_at: daysAgo(0.1), expected_refresh_seconds: null,
    last_complete_sweep_at: daysAgo(0.1),
  }]), { now: NOW });
  check("a completed but unscheduled Gmail sweep keeps post-snapshot absence provisional",
    complete.length === 1 && complete[0]?.type === "refresh_unscheduled" &&
      /no refresh schedule/i.test(complete[0]?.detail || ""), JSON.stringify(complete));
  const imap = await coverageGaps(mk([{
    name: "client-mail", kind: "imap", status: "ready", document_count: 1200,
    last_ingest_at: daysAgo(0.1), expected_refresh_seconds: null,
    last_complete_sweep_at: daysAgo(0.1),
  }]), { now: NOW });
  check("a completed but unscheduled IMAP sweep keeps post-snapshot absence provisional",
    imap.length === 1 && imap[0]?.type === "refresh_unscheduled" &&
      /email/i.test(imap[0]?.detail || ""), JSON.stringify(imap));
  const pointInTime = await coverageGaps(mk([{
    name: "documents", kind: "upload", status: "ready", document_count: 10,
    last_ingest_at: daysAgo(0.1), expected_refresh_seconds: null,
    last_complete_sweep_at: daysAgo(0.1),
  }]), { now: NOW });
  check("a completed point-in-time upload does not invent a live-refresh obligation",
    pointInTime.length === 0, JSON.stringify(pointInTime));
}

/* ---- every declared history source stays provisional until a complete sweep ---- */
{
  const g = await coverageGaps(mk([{
    name: "zoom", kind: "zoom", status: "ready", document_count: 4,
    last_ingest_at: daysAgo(0.1), expected_refresh_seconds: null,
    last_complete_sweep_at: null,
  }, {
    name: "whatsapp", kind: "whatsapp", status: "ready", document_count: 0,
    last_ingest_at: null, expected_refresh_seconds: null,
    last_complete_sweep_at: null,
  }]), { now: NOW });
  check("Zoom history is not treated as complete merely because new transcripts arrive",
    g.some((gap) => gap.source === "zoom" && gap.type === "history_unproven"), JSON.stringify(g));
  check("a registered zero-document message source blocks a categorical absence",
    g.some((gap) => gap.source === "whatsapp" && /no complete history sweep/i.test(gap.detail || "")),
    JSON.stringify(g));
}

/* ---- coverage reports obey an explicit authorized-source allowlist ---- */
{
  const report = await coverageGapReport(mk([{
    name: "books", kind: "quickbooks", status: "ready", document_count: 3,
    last_ingest_at: daysAgo(0.1), last_complete_sweep_at: null,
  }, {
    name: "medical-private", kind: "drive", status: "error", document_count: 8,
    stale_reason: "private failure", last_complete_sweep_at: null,
  }]), { now: NOW, allowedSources: ["books"] });
  check("an authorized-source report excludes every other source name and gap",
    report.gaps.length === 1 && report.gaps[0].source === "books" &&
      !JSON.stringify(report).includes("medical-private") &&
      !JSON.stringify(report).includes("private failure"), JSON.stringify(report));
}

/* ---- it must never break an answer ---- */
{
  const broken = { DB: { prepare: () => { throw new Error("no such table: sources"); } } };

  // Catch explicitly. An uncaught throw here would abort the whole file, which
  // reports as zero failures rather than one, so the assertion has to own the
  // error path itself.
  let g = null, threw = null;
  try { g = await coverageGaps(broken, { now: NOW }); } catch (e) { threw = e.message; }
  check("a database error returns no gaps rather than throwing into the answer path",
    threw === null && Array.isArray(g) && g.length === 0, threw ? `it threw: ${threw}` : JSON.stringify(g));
  const report = await coverageGapReport(broken, { now: NOW });
  check("the detailed coverage read preserves that the database check was unavailable",
    report.unavailable === true && report.gaps.length === 0, JSON.stringify(report));

  let f = null, threw2 = null;
  try { f = await freshnessReport(broken, { now: NOW }); } catch (e) { threw2 = e.message; }
  check("and the report degrades rather than throwing", threw2 === null && f?.unavailable === true,
    threw2 ? `it threw: ${threw2}` : JSON.stringify(f));
}

/* ---- the report distinguishes what we can fix from what we cannot ---- */
{
  const f = await freshnessReport(mk([
    { name: "drive", kind: "drive", status: "ready", last_ingest_at: daysAgo(40), expected_refresh_seconds: DAILY, document_count: 900 },
    { name: "documents", kind: "upload", status: "ready", last_ingest_at: daysAgo(400), document_count: 61 },
    { name: "gmail", kind: "gmail", status: "ready", last_ingest_at: daysAgo(2), document_count: 10 },
  ]), { now: NOW });
  const by = Object.fromEntries(f.sources.map((s) => [s.name, s]));
  check("an overdue connector reads stale", by.drive.state === "stale", JSON.stringify(by.drive));
  check("a laptop folder reads MANUAL, never stale", by.documents.state === "manual", JSON.stringify(by.documents));
  check("and is marked as one we cannot refresh ourselves", by.documents.automatable === false);
  check("a connector with no schedule reads unscheduled, not broken", by.gmail.state === "unscheduled", JSON.stringify(by.gmail));
  check("and IS marked automatable, because it could be scheduled", by.gmail.automatable === true);
}

console.log(`\nfreshness: ${ran - fail}/${ran} passed`);
if (fail) process.exit(1);
