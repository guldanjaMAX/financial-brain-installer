// Coverage staleness: what the brain has not LOOKED at, as distinct from the age
// of what it retrieved.
//
// The two tests that matter most here are the ones asserting SILENCE. A warning
// that fires for something nobody can act on is how clients learn to ignore the
// warning that matters, and this feature only earns its place if it stays quiet
// when quiet is correct.

import assert from "node:assert/strict";

import {
  coverageGapReport,
  coverageGaps,
  freshnessReport,
  sourceFreshnessCounts,
} from "../worker/src/lib/store-d1.js";

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
  check("an overdue connector exposes both stale updates and unproven history",
    g.length === 2 && g[0].type === "coverage_stale" && g[1].type === "history_unproven",
    JSON.stringify(g));
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
    g.length === 2 && g[0].type === "sync_review" && g[1].type === "history_unproven" &&
      /paused for safety review/i.test(g[0].detail || ""),
    JSON.stringify(g));
}

/* ---- operational failures cannot hide a separate historical coverage gap ---- */
{
  const g = await coverageGaps(mk([{
    name: "gmail", kind: "gmail", status: "error", document_count: 57552,
    last_ingest_at: daysAgo(9), expected_refresh_seconds: DAILY,
    last_complete_sweep_at: null,
  }, {
    name: "drive", kind: "drive", status: "ready", document_count: 24000,
    last_ingest_at: daysAgo(40), expected_refresh_seconds: DAILY,
    last_complete_sweep_at: null,
  }]), { now: NOW });
  const types = (source) => g.filter((gap) => gap.source === source).map((gap) => gap.type);
  check("a broken source still reports its unproven history",
    types("gmail").join(",") === "sync_broken,coverage_stale,history_unproven", JSON.stringify(g));
  check("a stale source still reports its unproven history",
    types("drive").join(",") === "coverage_stale,history_unproven", JSON.stringify(g));
  check("every source gap carries a direct owner remedy",
    g.every((gap) => typeof gap.remedy === "string" && gap.remedy.length > 0 && / Next: /.test(gap.detail)),
    JSON.stringify(g));
}

/* ---- bounded connectors explain their permanent history limitations honestly ---- */
{
  const g = await coverageGaps(mk([{
    name: "slack", kind: "slack", status: "ready", document_count: 12,
    last_ingest_at: daysAgo(0.1), expected_refresh_seconds: null,
    last_complete_sweep_at: null,
  }, {
    name: "whatsapp", kind: "whatsapp", status: "ready", document_count: 12,
    last_ingest_at: daysAgo(0.1), expected_refresh_seconds: null,
    last_complete_sweep_at: null,
  }]), { now: NOW });
  const by = Object.fromEntries(g.map((gap) => [gap.source, gap]));
  check("Slack's remedy declares inaccessible-history limits",
    /inaccessible conversations remain an explicit connector limitation/i.test(by.slack?.remedy || ""),
    JSON.stringify(by.slack));
  check("WhatsApp's remedy asks for an export instead of promising all-time coverage",
    /owner-provided export/i.test(by.whatsapp?.remedy || "") &&
      !/complete all-time|all-time complete/i.test(by.whatsapp?.remedy || ""),
    JSON.stringify(by.whatsapp));
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

/* ---- a durable custom API job is the active-run receipt for that source ---- */
{
  const rows = [{
    name: "store-dashboard", kind: "custom_api", status: "indexing", indexing_started_at: null,
    last_ingest_at: daysAgo(1), expected_refresh_seconds: DAILY, registered: 1,
  }];
  let activeJobReads = 0;
  const env = {
    DB: {
      prepare(sql) {
        if (/SELECT inventory\.\*/.test(sql)) return { all: async () => ({ results: rows }) };
        if (/FROM custom_api_jobs/.test(sql)) {
          activeJobReads++;
          return { all: async () => ({ results: [{ source: "store-dashboard", started_at: new Date(hoursAgo(2)).toISOString() }] }) };
        }
        if (/FROM sync_runs sr/.test(sql)) return { all: async () => ({ results: [] }) };
        throw new Error("unexpected SQL");
      },
    },
  };
  const f = await freshnessReport(env, { now: NOW });
  assert.equal(activeJobReads, 1, "the durable active-job decision point was reached");
  check("an active custom API job reports indexing instead of a broken orphan",
    f.sources[0]?.state === "indexing" && f.sources[0]?.hours_indexing === 2,
    JSON.stringify(f.sources[0]));
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

/* ---- only known compatibility gaps may fall back to the legacy run query ---- */
{
  const sourceRows = [{
    name: "drive", kind: "drive", status: "ready", registered: 1,
    document_count: 2, last_ingest_at: daysAgo(0.1),
    last_complete_sweep_at: null, expected_refresh_seconds: null,
  }];
  const db = {
    DB: {
      prepare(sql) {
        if (/SELECT inventory\.\*/.test(sql)) {
          return { all: async () => ({ results: sourceRows }) };
        }
        if (/docs_refused/.test(sql) && /FROM sync_runs sr/.test(sql)) {
          throw new Error("D1 transport timeout");
        }
        throw new Error("unexpected SQL");
      },
    },
  };
  let error = null;
  try { await freshnessReport(db, { now: NOW }); } catch (caught) { error = caught; }
  check("a non-schema latest-run failure is not hidden by the compatibility fallback",
    /D1 transport timeout/.test(error?.message || ""), error?.message || "no error");
}
{
  const sourceRows = [{
    name: "drive", kind: "drive", status: "ready", registered: 1,
    document_count: 2, last_ingest_at: daysAgo(0.1),
    last_complete_sweep_at: null, expected_refresh_seconds: null,
  }];
  let legacyRead = false;
  const db = {
    DB: {
      prepare(sql) {
        if (/SELECT inventory\.\*/.test(sql)) {
          return { all: async () => ({ results: sourceRows }) };
        }
        if (/docs_refused/.test(sql) && /FROM sync_runs sr/.test(sql)) {
          throw new Error("no such column: sr.docs_refused");
        }
        if (/ROW_NUMBER\(\) OVER \(PARTITION BY source/.test(sql)) {
          legacyRead = true;
          return { all: async () => ({ results: [{
            source: "drive", files_seen: 2, docs_added: 2, docs_updated: 0,
            docs_unchanged: 0, walk_complete: 1, finished_at: daysAgo(0.1),
          }] }) };
        }
        throw new Error("unexpected SQL");
      },
    },
  };
  const f = await freshnessReport(db, { now: NOW });
  check("a known missing coverage column uses the legacy read without inventing new telemetry",
    legacyRead && f.sources[0]?.coverage?.counts?.accepted === 2 &&
      f.sources[0]?.coverage?.counts?.refused === null &&
      f.sources[0]?.coverage?.confirmed_range?.from === null,
    JSON.stringify(f));
}

/* ---- latest Gmail failure evidence remains closed across schema versions ---- */
const GMAIL_FAILURE_EVIDENCE_FIXTURE = {
  version: 1,
  operation_class: "gmail_message_read",
  http_status: 400,
  provider_reason: "failed_precondition",
  checkpoint_readback: "verified",
  checkpoint_done: 55,
  checkpoint_skipped: 3,
  cursor_preservation: "absent_preserved",
};
{
  const sourceRows = [{
    name: "gmail", kind: "gmail", status: "error", registered: 1,
    document_count: 55, last_ingest_at: daysAgo(0.1),
    last_complete_sweep_at: null, expected_refresh_seconds: DAILY,
  }];
  const db = {
    DB: {
      prepare(sql) {
        if (/SELECT inventory\.\*/.test(sql)) return { all: async () => ({ results: sourceRows }) };
        if (/failure_evidence/.test(sql) && /FROM sync_runs sr/.test(sql)) {
          return { all: async () => ({ results: [{
            source: "gmail", error: "INGEST_FAILED", finished_at: daysAgo(0.1),
            docs_refused: 0, docs_failed: 1, metrics_version: 1,
            failure_evidence: JSON.stringify(GMAIL_FAILURE_EVIDENCE_FIXTURE),
          }] }) };
        }
        throw new Error("unexpected SQL");
      },
    },
  };
  const f = await freshnessReport(db, { now: NOW });
  check("authenticated freshness exposes only the revalidated latest Gmail failure evidence",
    JSON.stringify(f.sources[0]?.last_failure) === JSON.stringify(GMAIL_FAILURE_EVIDENCE_FIXTURE), JSON.stringify(f));
}

{
  const sourceRows = [{
    name: "gmail", kind: "gmail", status: "error", registered: 1,
    document_count: 55, last_ingest_at: daysAgo(0.1), expected_refresh_seconds: DAILY,
  }];
  const db = {
    DB: {
      prepare(sql) {
        if (/SELECT inventory\.\*/.test(sql)) return { all: async () => ({ results: sourceRows }) };
        if (/failure_evidence/.test(sql) && /FROM sync_runs sr/.test(sql)) {
          return { all: async () => ({ results: [{
            source: "gmail", error: "INGEST_FAILED", docs_refused: 0,
            docs_failed: 0, metrics_version: 1,
            failure_evidence: JSON.stringify(GMAIL_FAILURE_EVIDENCE_FIXTURE),
          }] }) };
        }
        throw new Error("unexpected SQL");
      },
    },
  };
  const f = await freshnessReport(db, { now: NOW });
  check("freshness suppresses a measured document failure that contradicts a zero failed count",
    f.sources[0]?.last_failure === null, JSON.stringify(f));
}

{
  const sourceRows = [{
    name: "gmail", kind: "gmail", status: "error", registered: 1,
    document_count: 2, last_ingest_at: daysAgo(0.1),
    last_complete_sweep_at: null, expected_refresh_seconds: DAILY,
  }];
  let schema38Read = false;
  const db = {
    DB: {
      prepare(sql) {
        if (/SELECT inventory\.\*/.test(sql)) return { all: async () => ({ results: sourceRows }) };
        if (/failure_evidence/.test(sql) && /FROM sync_runs sr/.test(sql)) {
          throw new Error("no such column: sr.failure_evidence");
        }
        if (/docs_refused/.test(sql) && /FROM sync_runs sr/.test(sql)) {
          schema38Read = true;
          return { all: async () => ({ results: [{
            source: "gmail", error: "INGEST_FAILED", files_seen: 2,
            walk_complete: 1, finished_at: daysAgo(0.1),
            docs_added: 1, docs_updated: 0, docs_unchanged: 1,
            docs_refused: 0, docs_failed: 0, metrics_version: 1,
          }] }) };
        }
        throw new Error("unexpected SQL");
      },
    },
  };
  const f = await freshnessReport(db, { now: NOW });
  check("a missing 0040 column falls back only one schema level and preserves schema-38 coverage",
    schema38Read && f.sources[0]?.last_failure === null &&
      f.sources[0]?.coverage?.counts?.accepted === 2 &&
      f.sources[0]?.coverage?.counts?.refused === 0,
    JSON.stringify(f));
}

/* ---- counters and claimed ranges must come from the same latest receipt ---- */
{
  const sourceRows = [{
    name: "drive", kind: "drive", status: "ready", registered: 1,
    document_count: 2, last_ingest_at: daysAgo(0.1),
    last_complete_sweep_at: null, expected_refresh_seconds: null,
  }];
  let joinedAnOlderRange = false;
  const db = {
    DB: {
      prepare(sql) {
        if (/SELECT inventory\.\*/.test(sql)) {
          return { all: async () => ({ results: sourceRows }) };
        }
        if (/docs_refused/.test(sql) && /FROM sync_runs sr/.test(sql)) {
          joinedAnOlderRange = /ranged\s+AS|JOIN\s+ranged/i.test(sql);
          return { all: async () => ({ results: [{
            source: "drive", files_seen: 2, docs_added: 0, docs_updated: 0,
            docs_unchanged: 2, docs_refused: 0, docs_failed: 0,
            metrics_version: 1, walk_complete: 1, finished_at: daysAgo(0.1),
            // The newest receipt has no range. The fake exposes the older range
            // only if the query performs the unsafe cross-receipt join.
            confirmed_from: joinedAnOlderRange ? daysAgo(30) : null,
            confirmed_through: joinedAnOlderRange ? daysAgo(20) : null,
          }] }) };
        }
        throw new Error("unexpected SQL");
      },
    },
  };
  const f = await freshnessReport(db, { now: NOW });
  check("freshness never pairs the latest clean counters with an older run's range",
    !joinedAnOlderRange && f.sources[0]?.coverage?.confirmed_range?.from === null &&
      f.sources[0]?.coverage?.confirmed_range?.through === null,
    JSON.stringify(f));
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

/* ---- public freshness counts reuse the detailed gap classification ---- */
{
  const timestamp = (hours) => new Date(NOW - hours * 3600000).toISOString();
  const rows = [
    { name: "alpha-mail", kind: "imap", status: "ready", registered: 1, last_ingest_at: timestamp(35), last_complete_sweep_at: timestamp(35), expected_refresh_seconds: DAILY, indexing_started_at: null },
    { name: "beta-calendar", kind: "calendar", status: "ready", registered: 1, last_ingest_at: timestamp(37), last_complete_sweep_at: timestamp(37), expected_refresh_seconds: DAILY, indexing_started_at: null },
    { name: "gamma-notes", kind: "owner_notes", status: "ready", registered: 1, last_ingest_at: timestamp(1), last_complete_sweep_at: timestamp(1), expected_refresh_seconds: 3600, indexing_started_at: null },
    { name: "delta-drive", kind: "drive", status: "pending", registered: 1, last_ingest_at: null, last_complete_sweep_at: null, expected_refresh_seconds: DAILY, indexing_started_at: null },
    { name: "epsilon-bank", kind: "bank", status: "error", registered: 1, last_ingest_at: timestamp(2), last_complete_sweep_at: timestamp(2), expected_refresh_seconds: null, stale_reason: "AUTH_EXPIRED", indexing_started_at: null },
    { name: "zeta-files", kind: "upload", status: "ready", registered: 1, last_ingest_at: timestamp(40 * 24), last_complete_sweep_at: timestamp(40 * 24), expected_refresh_seconds: null, indexing_started_at: null },
    { name: "eta-chat", kind: "chat", status: "indexing", registered: 1, last_ingest_at: timestamp(2), last_complete_sweep_at: timestamp(2), expected_refresh_seconds: DAILY, indexing_started_at: timestamp(1 / 6) },
    { name: "omega-legacy", kind: "unregistered", status: "unregistered", registered: 0, last_ingest_at: null, last_complete_sweep_at: null, expected_refresh_seconds: null, indexing_started_at: null },
  ];
  const recordedSql = [];
  const fixture = {
    DB: {
      prepare(sql) {
        recordedSql.push(sql);
        return { all: async () => ({ results: rows }) };
      },
    },
  };
  const counts = await sourceFreshnessCounts(fixture, { now: NOW });
  check("T1 mixed registry counts registered, stale, and unscheduled sources",
    JSON.stringify(counts) === JSON.stringify({ total: 7, stale: 3, unscheduled: 1 }),
    JSON.stringify(counts));

  const report = await coverageGapReport(fixture, { now: NOW });
  const staleTypes = new Set(["sync_broken", "never_synced", "coverage_stale"]);
  const staleSources = new Set(report.gaps.filter((gap) => staleTypes.has(gap.type)).map((gap) => gap.source));
  check("T2 detailed gaps contain exactly the sources counted stale",
    staleSources.size === counts.stale &&
      ["beta-calendar", "delta-drive", "epsilon-bank"].every((source) => staleSources.has(source)) &&
      ["alpha-mail", "gamma-notes", "eta-chat"].every((source) => !staleSources.has(source)),
    JSON.stringify([...staleSources]));
  check("T2 in-progress control reaches the classification decision",
    report.gaps.some((gap) => gap.source === "eta-chat" && gap.type === "sync_in_progress"),
    JSON.stringify(report.gaps));

  const costSql = [];
  const costFixture = {
    DB: {
      prepare(sql) {
        costSql.push(sql);
        return { all: async () => ({ results: rows }) };
      },
    },
  };
  await sourceFreshnessCounts(costFixture, { now: NOW });
  check("T5 ordinary public counts use one cheap registry statement",
    costSql.length === 1 && /FROM sources s/.test(costSql[0]) &&
      /document_source_inventory/.test(costSql[0]) &&
      !/COUNT\(/.test(costSql[0]) && !/ROW_NUMBER/.test(costSql[0]),
    JSON.stringify(costSql));
}

/* ---- custom API state stays inside the one-statement public count read ---- */
{
  const timestamp = (hours) => new Date(NOW - hours * 3600000).toISOString();
  const rows = [
    {
      name: "inventory-feed", kind: "custom_api", status: "indexing", registered: 1,
      last_ingest_at: timestamp(1), last_complete_sweep_at: timestamp(1),
      expected_refresh_seconds: DAILY, indexing_started_at: null,
    },
    {
      name: "orders-feed", kind: "custom_api", status: "ready", registered: 1,
      last_ingest_at: timestamp(1), last_complete_sweep_at: timestamp(1),
      expected_refresh_seconds: DAILY, stale_reason: "INPUT_REFUSED", indexing_started_at: null,
    },
  ];
  const statements = [];
  const result = await sourceFreshnessCounts({
    DB: {
      prepare(sql) {
        statements.push(sql);
        if (/SELECT inventory\.\*/.test(sql)) {
          const joinedActiveJobs = /FROM custom_api_jobs/.test(sql);
          return {
            all: async () => ({
              results: rows.map((row) => row.name === "inventory-feed" && joinedActiveJobs
                ? { ...row, indexing_started_at: timestamp(2) }
                : row),
            }),
          };
        }
        if (/FROM custom_api_jobs/.test(sql)) {
          return { all: async () => ({ results: [{ source: "inventory-feed", started_at: timestamp(2) }] }) };
        }
        if (/FROM custom_api_schedule_state/.test(sql)) {
          return {
            all: async () => ({
              results: [{
                source: "orders-feed", display_name: "Orders feed",
                last_issue_code: "INPUT_REFUSED", last_refused_rows: 2,
              }],
            }),
          };
        }
        throw new Error("unexpected SQL");
      },
    },
  }, { now: NOW });
  check("T6 custom API count control reaches active-job and refusal classification",
    JSON.stringify(result) === JSON.stringify({ total: 2, stale: 1, unscheduled: 0 }),
    JSON.stringify(result));
  check("T6 custom API mutation remains one current-schema statement",
    statements.length === 1 && /FROM sources s/.test(statements[0]) &&
      /FROM custom_api_jobs/.test(statements[0]) &&
      !/FROM custom_api_schedule_state/.test(statements[0]),
    JSON.stringify(statements));

  let legacyStatements = 0;
  const legacyResult = await sourceFreshnessCounts({
    DB: {
      prepare(sql) {
        legacyStatements++;
        if (/FROM custom_api_jobs/.test(sql)) throw new Error("no such table: custom_api_jobs");
        return { all: async () => ({ results: [] }) };
      },
    },
  }, { now: NOW });
  check("T6 pre-custom-API schema uses one bounded compatibility retry",
    legacyStatements === 2 &&
      JSON.stringify(legacyResult) === JSON.stringify({ total: 0, stale: 0, unscheduled: 0 }),
    JSON.stringify({ legacyStatements, legacyResult }));
}

/* ---- retirement wins before operational and schedule count classification ---- */
{
  const active = {
    name: "archive-upload", kind: "upload", status: "error", registered: 1,
    last_ingest_at: daysAgo(4), last_complete_sweep_at: null,
    expected_refresh_seconds: null, document_count: 4,
  };
  const activeCounts = await sourceFreshnessCounts(mk([active]), { now: NOW });
  const activeGaps = await coverageGapReport(mk([active]), { now: NOW });
  check("T7 active upload control reaches broken classification",
    JSON.stringify(activeCounts) === JSON.stringify({ total: 1, stale: 1, unscheduled: 0 }) &&
      activeGaps.gaps.some((gap) => gap.type === "sync_broken"),
    JSON.stringify({ activeCounts, gaps: activeGaps.gaps }));

  const retired = { ...active, retired_at: "2026-08-18T12:00:00.000Z" };
  const retiredCounts = await sourceFreshnessCounts(mk([retired]), { now: NOW });
  const retiredGaps = await coverageGapReport(mk([retired]), { now: NOW });
  check("T7 retired mutation stays total but is neither stale nor unscheduled",
    JSON.stringify(retiredCounts) === JSON.stringify({ total: 1, stale: 0, unscheduled: 0 }),
    JSON.stringify(retiredCounts));
  check("T7 retired mutation preserves history without a sync-broken decision",
    retiredGaps.gaps.length === 1 && retiredGaps.gaps[0]?.type === "history_unproven" &&
      retiredGaps.gaps[0]?.remedy === "No action needed." &&
      !retiredGaps.gaps.some((gap) => gap.type === "sync_broken"),
    JSON.stringify(retiredGaps.gaps));
}

/* ---- failed reads are absent while a successful empty read is a real zero ---- */
{
  const failures = [
    { label: "prepare throws", statement: () => { throw new Error("fixture prepare failure"); } },
    { label: "all rejects", statement: () => ({ all: async () => { throw new Error("fixture all failure"); } }) },
    { label: "all missing", statement: () => ({ first: async () => null }) },
  ];
  for (const failure of failures) {
    let prepareCalls = 0;
    const result = await sourceFreshnessCounts({
      DB: {
        prepare(sql) {
          prepareCalls++;
          return failure.statement(sql);
        },
      },
    }, { now: NOW });
    check(`T3 ${failure.label} makes public counts unavailable`,
      prepareCalls > 0 && result?.unavailable === true &&
        !("total" in result) && !("stale" in result) && !("unscheduled" in result),
      JSON.stringify({ prepareCalls, result }));
  }

  const empty = await sourceFreshnessCounts({
    DB: { prepare: () => ({ all: async () => ({ results: [] }) }) },
  }, { now: NOW });
  check("T4 a successful empty registry returns exact zero counts",
    JSON.stringify(empty) === JSON.stringify({ total: 0, stale: 0, unscheduled: 0 }),
    JSON.stringify(empty));
}

console.log(`\nfreshness: ${ran - fail}/${ran} passed`);
if (fail) process.exit(1);
