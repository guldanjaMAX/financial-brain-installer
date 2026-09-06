import { describe, expect, it } from "vitest";
import type { SourceCoverageDetail } from "./api";
import {
  accessZonePresentation, coverageCaveat, coverageFacts, coveragePresentation,
} from "./source-coverage";
import { answersMayBeIncomplete, derivePhase, phraseFor } from "./phase";

const coverage = (overrides: Partial<SourceCoverageDetail> = {}): SourceCoverageDetail => ({
  starter_context: { state: "ready" },
  live_updates: { state: "current" },
  history: { state: "running" },
  meaning_search: { state: "projecting" },
  confirmed_range: { from: null, through: null },
  target_range: { from: null, through: null },
  current_window: null,
  counts: { seen: 66000, accepted: 65000, refused: 0, failed: 0 },
  last_progress_at: null,
  projection_pending: 1000,
  waiting_on_owner_machine: false,
  ...overrides,
});

describe("source coverage presentation", () => {
  it("keeps the four progress dimensions independent", () => {
    expect(coveragePresentation("ready").text).toBe("Ready");
    expect(coveragePresentation("running").text).toBe("Loading");
    expect(coveragePresentation("projecting").text).toBe("Indexing");
    expect(coveragePresentation("unexpected_state").text).toBe("Not yet proven");
  });

  it("renders assigned, owner-only, unregistered, and unavailable zone truth", () => {
    expect(accessZonePresentation({ state: "assigned", label: "Household Records" }).text)
      .toBe("Access zone: Household Records");
    expect(accessZonePresentation({ state: "unassigned", label: null }).text)
      .toBe("Access zone not assigned · owner only");
    expect(accessZonePresentation({ state: "unregistered", label: null }).text)
      .toBe("Source registration needs review · owner only");
    expect(accessZonePresentation(undefined).text)
      .toBe("Access zone could not be verified");
  });

  it("names incomplete history instead of turning absence into a fact", () => {
    expect(coverageCaveat("Email", coverage())).toMatch(/not yet proven complete/i);
    expect(coverageCaveat("Email", coverage({ history: { state: "complete" } }))).toBeNull();
  });

  it("shows useful progress without inventing unavailable counts", () => {
    expect(coverageFacts(coverage())).toEqual([
      "66,000 checked in the latest run",
      "65,000 accepted",
      "1,000 waiting for meaning search",
    ]);
  });

  it("keeps UTC source boundaries on their recorded calendar date", () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "America/Phoenix";
    try {
      expect(coverageFacts(coverage({
        confirmed_range: {
          from: "2024-01-01T00:00:00.000Z",
          through: "2026-09-06T00:00:00.000Z",
        },
      }))[0]).toBe("Confirmed Jan 1, 2024 to Sep 6, 2026");
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it("does not call the whole brain ready while source history is still loading", () => {
    const status = {
      accepting_documents: true,
      status: "ok",
      drain_mode: "active",
      documents: 66000,
      chunks: 100000,
      problem_counts: { crit: 0, warn: 0, info: 0 },
      sources: [{
        label: "Email", kind: "gmail", state: "ok", documents: 66000,
        days_since_ingest: 0, reason: null, automatable: true, coverage: coverage(),
      }],
      vectors: { ready: true, expected: 100000, visible: 100000, pending: 0, percent_visible: 100 },
      unavailable: [],
    };
    const phase = derivePhase(status);
    expect(phase).toBe("backfilling");
    expect(answersMayBeIncomplete(phase)).toBe(true);
    expect(phraseFor(phase, status)).toMatch(/missing results remain provisional/i);
  });

  it("does not call a source ready while live updates are catching up or unscheduled", () => {
    const base = {
      accepting_documents: true,
      status: "ok",
      drain_mode: "active",
      documents: 12,
      chunks: 12,
      problem_counts: { crit: 0, warn: 0, info: 0 },
      problems: [],
      vectors: { ready: true, expected: 12, visible: 12, pending: 0, percent_visible: 100 },
      unavailable: [] as string[],
    };
    const complete = coverage({ history: { state: "complete" }, meaning_search: { state: "ready" } });
    const catchingUp = {
      label: "Email", kind: "gmail", state: "indexing", documents: 12,
      days_since_ingest: 0, reason: null, automatable: true,
      coverage: { ...complete, live_updates: { state: "catching_up" as const } },
    };
    const unscheduled = {
      ...catchingUp,
      state: "unscheduled",
      coverage: { ...complete, live_updates: { state: "unavailable" as const } },
    };

    expect(derivePhase({ ...base, sources: [catchingUp] })).toBe("backfilling");
    expect(derivePhase({ ...base, sources: [unscheduled] })).toBe("backfilling");
    expect(phraseFor("backfilling", { ...base, sources: [unscheduled] })).toMatch(/unscheduled/i);
  });

  it("does not call records ready when source or vector coverage is unavailable", () => {
    const base = {
      accepting_documents: true,
      status: "ok",
      drain_mode: "active",
      documents: 12,
      chunks: 18,
      problem_counts: { crit: 0, warn: 0, info: 0 },
      sources: [],
      vectors: { ready: true, expected: 18, visible: 18, pending: 0, percent_visible: 100 },
      unavailable: [] as string[],
    };
    const missingSources = { ...base, unavailable: ["freshness"] };
    delete (missingSources as Partial<typeof base>).sources;
    const missingVectors = { ...base, unavailable: ["vectors"] };
    delete (missingVectors as Partial<typeof base>).vectors;

    expect(derivePhase(missingSources)).toBe("coverage_unknown");
    expect(derivePhase(missingVectors)).toBe("coverage_unknown");
    expect(answersMayBeIncomplete("coverage_unknown")).toBe(true);
    expect(phraseFor("coverage_unknown", missingSources)).toMatch(/missing results as unproven/i);
  });

  it("fails closed when any returned source lacks its coverage evidence", () => {
    const base = {
      accepting_documents: true,
      status: "ok",
      drain_mode: "active",
      documents: 12,
      chunks: 18,
      problem_counts: { crit: 0, warn: 0, info: 0 },
      vectors: { ready: true, expected: 18, visible: 18, pending: 0, percent_visible: 100 },
      unavailable: [] as string[],
    };
    const missing = { label: "Email", kind: "gmail", state: "ok", documents: 12,
      days_since_ingest: 0, reason: null, automatable: true };
    const present = { ...missing, label: "Drive", kind: "drive", coverage: coverage() };

    expect(derivePhase({ ...base, sources: [missing] })).toBe("coverage_unknown");
    expect(derivePhase({ ...base, sources: [present, missing] })).toBe("coverage_unknown");
  });
});
