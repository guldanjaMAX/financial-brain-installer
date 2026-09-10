/**
 * The owner's view of their brain's condition.
 *
 * Two traps this file exists for.
 *
 * 1. `documents: 0` is the most dangerous number here. An empty corpus and an
 *    unreachable diagnose look identical the moment a failure is flattened to
 *    zero, and "your brain holds nothing" is a very different sentence from
 *    "we could not check". A failed read must name itself and omit its keys.
 *
 * 2. The operator remedy must not reach the owner as their to-do. Every
 *    diagnose `action` is a `brain` CLI command they cannot run.
 */
import { ownerSystemStatus } from "../src/lib/system-status.js";
import {
  provisionalCoverageNotice,
  settleMeaningSearch,
  sourceCoverageFromEvidence,
} from "../src/lib/source-coverage.js";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 200)));
  if (!c) fail++;
};

const okHealth = () => ({ status: "ok", accepting_documents: true, vector_drain_mode: "active" });
const okDiagnose = async () => ({
  complete: true,
  totals: { documents: 70844, chunks: 876761, sources: 3 },
  unavailable_checks: [],
  summary: { crit: 2, warn: 1, info: 2, ok: 1, unavailable: 0 },
  findings: [
    { id: "empty_documents", area: "coverage", severity: "crit", count: 1,
      title: "1 document(s) hold no text", detail: "d",
      action: "Re-ingest with OCR, or remove them", samples: ["private-file.pdf"] },
    { id: "undated", area: "coverage", severity: "info", count: 931, title: "no date", action: "x" },
  ],
});
const okFresh = async () => ({ sources: [
  { name: "drive", kind: "drive", zone: "household_records", state: "broken", documents: 24104, days_since_ingest: 5,
    reason: "indexing has not completed for 21 hour(s)", automatable: true },
  { name: "wildcard_slug", kind: "upload", zone: null, state: "manual", documents: 3, days_since_ingest: 1 },
] });
const okVectors = async () => ({ ready: false, expected_vectors: 1000, actual_vectors: 895, pending: 105 });
const deps = { health: okHealth, diagnose: okDiagnose, freshness: okFresh, vectorReadiness: okVectors };

/* --------------------------------------------------------------- happy path */
{
  const s = await ownerSystemStatus({}, deps);
  check("documents come through", s.documents === 70844, String(s.documents));
  check("percent visible is computed", s.vectors.percent_visible === 89, String(s.vectors.percent_visible));
  check("nothing is unavailable", s.unavailable.length === 0, JSON.stringify(s.unavailable));
  check("crit and warn are surfaced as problems", s.problems.length === 1, JSON.stringify(s.problems.map(p=>p.id)));
  check("info findings are not problems", !s.problems.some((p) => p.id === "undated"));
  check("every source carries separate starter, live, history, and meaning-search truth",
    s.sources.every((source) => source.coverage?.starter_context?.state &&
      source.coverage?.live_updates?.state && source.coverage?.history?.state &&
      source.coverage?.meaning_search?.state), JSON.stringify(s.sources));
  check("whole-brain vector debt conservatively marks unknown per-source projection as working",
    s.sources.every((source) => source.coverage.meaning_search.state === "projecting"), JSON.stringify(s.sources));
  check("assigned and owner-only zone states are explicit per source",
    s.sources[0].access_zone?.state === "assigned" &&
      s.sources[0].access_zone?.label === "Household Records" &&
      s.sources[1].access_zone?.state === "unassigned" &&
      s.sources[1].access_zone?.label === null,
    JSON.stringify(s.sources.map((source) => source.access_zone)));
}

/* ---------------------------------------------- the operator remedy is withheld */
{
  const s = await ownerSystemStatus({}, deps);
  const text = JSON.stringify(s);
  check("the CLI remedy never reaches the owner", !/Re-ingest with OCR/.test(text));
  check("and the problem says whose fix it is", s.problems[0].fix_owner === "installer", s.problems[0].fix_owner);
  check("document samples are not dumped into a status summary", !/private-file\.pdf/.test(text));
}

/* ------------------------------------------------------- slugs are never shown */
{
  const s = await ownerSystemStatus({}, deps);
  const text = JSON.stringify(s.sources);
  check("a known slug becomes a label", s.sources[0].label === "Google Drive", s.sources[0].label);
  check("an unknown slug is NOT printed", !/wildcard_slug/.test(text), text);
  check("and falls back to something readable", s.sources[1].label === "Files you uploaded", s.sources[1].label);
}

/* ------------------------------ provider labels stay human without slug leaks */
{
  const providerFresh = async () => ({ sources: [
    { name: "dropbox", kind: "dropbox", zone: "business", state: "ok", documents: 12, days_since_ingest: 0, automatable: true },
    { name: "box", kind: "box", zone: null, state: "manual", documents: 4, days_since_ingest: 0, automatable: false },
    { name: "client-mail", kind: "gmail", zone: "business", state: "ok", documents: 18, days_since_ingest: 0, automatable: true },
    { name: "client-calls", kind: "zoom", zone: "business", state: "ok", documents: 7, days_since_ingest: 0, automatable: true },
  ] });
  const s = await ownerSystemStatus({}, { ...deps, freshness: providerFresh });
  check("provider and custom Gmail or Zoom sources receive reviewed owner labels",
    s.sources.map((source) => source.label).join(",") ===
      "Dropbox,Box,Email,Meeting recordings", JSON.stringify(s.sources));
}

/* ------------------------ source-name collisions cannot rewrite provenance */
{
  const collisionFresh = async () => ({ sources: [
    { name: "drive", kind: "upload", zone: null, state: "manual", documents: 2, days_since_ingest: 0, automatable: false },
    { name: "drive", kind: "future-provider", zone: null, state: "manual", documents: 1, days_since_ingest: 0, automatable: false },
  ] });
  const s = await ownerSystemStatus({}, { ...deps, freshness: collisionFresh });
  check("connector kind wins when a custom source name collides with a provider slug",
    s.sources[0]?.label === "Files you uploaded" && s.sources[0]?.kind === "upload",
    JSON.stringify(s.sources));
  check("an explicit unknown connector kind cannot inherit a familiar source-name label",
    s.sources[1]?.label === "Another source" && s.sources[1]?.kind === "future-provider",
    JSON.stringify(s.sources));
}

/* ----------------------- missing registry authority stays visibly generic */
{
  const unregisteredFresh = async () => ({ sources: [
    {
      name: "drive", kind: "unregistered", zone: null, state: "unregistered", documents: 2,
      days_since_ingest: null, reason: "the source registry entry is missing", automatable: false,
    },
  ] });
  const s = await ownerSystemStatus({}, { ...deps, freshness: unregisteredFresh });
  check("an unregistered source cannot borrow a familiar provider label",
    s.sources[0]?.label === "Another source" && s.sources[0]?.state === "unregistered",
    JSON.stringify(s.sources));
  check("an unregistered source stays owner-only and visibly needs registration review",
    s.sources[0]?.access_zone?.state === "unregistered" && s.sources[0]?.access_zone?.label === null,
    JSON.stringify(s.sources));
}

/* ---------------------- missing zone projection is unavailable, not unassigned */
{
  const legacyFresh = async () => ({ sources: [
    { name: "drive", kind: "drive", state: "ok", documents: 2, days_since_ingest: 0, automatable: true },
  ] });
  const s = await ownerSystemStatus({}, { ...deps, freshness: legacyFresh });
  check("a freshness response without zone proof names zones as unavailable",
    s.unavailable.includes("zones"), JSON.stringify(s.unavailable));
  check("missing zone proof is omitted instead of rendered as owner-only",
    !Object.hasOwn(s.sources[0], "access_zone"), JSON.stringify(s.sources[0]));
}

/* ------------------------------------ a failed read is not a zero, and says so */
{
  const s = await ownerSystemStatus({}, { ...deps, diagnose: async () => { throw new Error("down"); } });
  check("a broken diagnose is NAMED", s.unavailable.includes("diagnose"), JSON.stringify(s.unavailable));
  check("documents is ABSENT, not 0", !("documents" in s), String(s.documents));
  check("problems is ABSENT, not []", !("problems" in s), JSON.stringify(s.problems));
  check("the working reads still come through", s.sources.length === 2 && !!s.vectors);
}
{
  const incomplete = async () => ({
    complete: false,
    totals: { documents: null, chunks: null, sources: null },
    unavailable_checks: ["totals"],
    summary: { crit: 0, warn: 19, info: 0, ok: 0, unavailable: 19 },
    findings: [{ id: "totals", severity: "warn", title: "check could not run" }],
    verdict: "incomplete",
  });
  const s = await ownerSystemStatus({}, { ...deps, diagnose: incomplete });
  check("an incomplete diagnose report is NAMED as unavailable",
    s.unavailable.includes("diagnose"), JSON.stringify(s.unavailable));
  check("an incomplete report cannot recreate false zero corpus counts",
    !("documents" in s) && !("chunks" in s), JSON.stringify(s));
  check("an incomplete report cannot project a seemingly available problem list",
    !("problems" in s) && !("problem_counts" in s), JSON.stringify(s));
}
{
  const partial = async () => ({
    complete: false,
    totals: { documents: 12, chunks: null, sources: 1 },
    unavailable_checks: ["chunk_scan"],
    summary: { crit: 0, warn: 2, info: 0, ok: 0, unavailable: 1 },
    findings: [
      { id: "source_mismatch", area: "integrity", severity: "warn", count: 1,
        title: "one source mismatch was confirmed" },
      { id: "chunk_scan", area: "meta", severity: "warn", observable: false,
        incomplete: true, title: "scan incomplete" },
    ],
  });
  const s = await ownerSystemStatus({}, { ...deps, diagnose: partial });
  check("a partial diagnosis is named as unavailable even when it found a problem",
    s.unavailable.includes("diagnose") && s.problems.length === 1, JSON.stringify(s));
  check("a verified document total survives while an unverified chunk total stays absent",
    s.documents === 12 && !("chunks" in s), JSON.stringify(s));
}
{
  const s = await ownerSystemStatus({}, { ...deps, freshness: async () => { throw new Error("down"); } });
  check("a broken freshness is NAMED", s.unavailable.includes("freshness"));
  check("a broken freshness also leaves access zones unavailable", s.unavailable.includes("zones"));
  check("sources is ABSENT, not []", !("sources" in s));
}
{
  const s = await ownerSystemStatus({}, {
    ...deps,
    freshness: async () => ({ sources: [], unavailable: true }),
  });
  check("a degraded freshness sentinel is NAMED",
    s.unavailable.includes("freshness"), JSON.stringify(s.unavailable));
  check("a degraded freshness sentinel also names zones as unavailable",
    s.unavailable.includes("zones"), JSON.stringify(s.unavailable));
  check("a degraded freshness sentinel cannot become an empty source list",
    !("sources" in s), JSON.stringify(s.sources));
}
{
  const s = await ownerSystemStatus({}, { ...deps, vectorReadiness: async () => { throw new Error("down"); } });
  check("broken vectors are NAMED", s.unavailable.includes("vectors"));
  check("vectors is ABSENT, so no false 0%", !("vectors" in s));
}

/* ------------------------------------------ coverage never becomes one percent */
{
  const coverage = sourceCoverageFromEvidence({
    kind: "gmail", state: "indexing", documents: 66000, expected_every_days: 1,
    last_complete_sweep_at: null, indexing_started_at: "2026-09-06T10:00:00.000Z",
  }, {
    latestRun: {
      files_seen: 66500, docs_added: 300, docs_updated: 20,
      docs_unchanged: 65680, finished_at: null,
    },
    projectionPending: 1200,
  });
  check("starter context can be ready while history and meaning search continue",
    coverage.starter_context.state === "ready" && coverage.history.state === "running" &&
      coverage.meaning_search.state === "projecting", JSON.stringify(coverage));
  check("an unfinished run never presents default counters as measured progress",
    coverage.counts.seen === null && coverage.counts.accepted === null &&
      coverage.counts.refused === null && coverage.counts.failed === null,
    JSON.stringify(coverage.counts));
  const closedCoverage = sourceCoverageFromEvidence({
    kind: "gmail", state: "ok", documents: 66000,
  }, {
    latestRun: {
      files_seen: 66500, docs_added: 300, docs_updated: 20,
      docs_unchanged: 65680, walk_complete: 1,
      finished_at: "2026-09-06T11:00:00.000Z",
    },
    projectionPending: 0,
  });
  check("a closed run exposes its accepted progress without guessing refusal counts",
    closedCoverage.counts.seen === 66500 && closedCoverage.counts.accepted === 66000 &&
      closedCoverage.counts.refused === null && closedCoverage.counts.failed === null,
    JSON.stringify(closedCoverage.counts));
  const unmeasuredCoverage = sourceCoverageFromEvidence({
    kind: "zoom", state: "manual", documents: 4,
  }, {
    latestRun: {
      files_seen: 0, docs_added: 0, docs_updated: 0, docs_unchanged: 0,
      walk_complete: 0, error: "delivery failed", finished_at: "2026-09-06T11:00:00.000Z",
    },
    projectionPending: 0,
  });
  check("a closed error receipt never presents default zero counters as measured",
    Object.values(unmeasuredCoverage.counts).every((value) => value === null),
    JSON.stringify(unmeasuredCoverage.counts));
  check("partial history produces provisional absence language",
    /not yet proven complete/i.test(provisionalCoverageNotice("Email", coverage) || ""));
  check("a complete history produces no provisional warning",
    provisionalCoverageNotice("Email", { ...coverage, history: { state: "complete" } }) === null);
}
{
  const unknown = sourceCoverageFromEvidence({ kind: "gmail", state: "ok", documents: 10 });
  check("unknown per-source meaning search follows exact whole-brain debt conservatively",
    settleMeaningSearch(unknown, { ready: false }).meaning_search.state === "projecting" &&
      settleMeaningSearch(unknown, null).meaning_search.state === "degraded");
}

/* ------------------------------------- 'cannot tell' is a third answer, not yes */
{
  const s = await ownerSystemStatus({}, { ...deps, health: () => ({ status: "ok" }) });
  check("absent accepting_documents is null, NOT true", s.accepting_documents === null, String(s.accepting_documents));
}
{
  const s = await ownerSystemStatus({}, { ...deps, health: () => { throw new Error("down"); } });
  check("a broken health is named", s.unavailable.includes("health"));
  check("and does not claim the brain accepts documents", s.accepting_documents === null, String(s.accepting_documents));
}
{
  const paused = () => ({ status: "paused-for-upgrade", accepting_documents: false, vector_drain_mode: "paused-for-upgrade" });
  const s = await ownerSystemStatus({}, { ...deps, health: paused });
  check("a paused brain says so", s.accepting_documents === false && s.status === "paused-for-upgrade");
}

/* ------------------------------------------------ an empty brain is not a broken one */
{
  const empty = async () => ({
    complete: true,
    totals: { documents: 0, chunks: 0, sources: 0 },
    unavailable_checks: [],
    summary: { crit: 0, warn: 0, info: 0, ok: 0, unavailable: 0 },
    findings: [],
  });
  const s = await ownerSystemStatus({}, { ...deps, diagnose: empty });
  check("an EMPTY brain reports 0 documents present", s.documents === 0 && !s.unavailable.includes("diagnose"));
  check("which is distinguishable from a broken read", "documents" in s);
}

console.log(`\n${ran - fail}/${ran} passed`);
process.exit(fail ? 1 : 0);
