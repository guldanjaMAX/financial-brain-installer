import type { SourceCoverageDetail } from "./api";
import type { SourceRow } from "./api";

export type CoverageDimension = "starter_context" | "live_updates" | "history" | "meaning_search";

export const COVERAGE_DIMENSIONS: Array<{ key: CoverageDimension; label: string }> = [
  { key: "starter_context", label: "Starter" },
  { key: "live_updates", label: "Live" },
  { key: "history", label: "History" },
  { key: "meaning_search", label: "Search" },
];

const PRESENTATION: Record<string, { text: string; glyph: string; tone: "good" | "work" | "attention" | "quiet" }> = {
  preparing: { text: "Preparing", glyph: "○", tone: "work" },
  ready: { text: "Ready", glyph: "●", tone: "good" },
  degraded: { text: "Needs attention", glyph: "✕", tone: "attention" },
  catching_up: { text: "Catching up", glyph: "○", tone: "work" },
  current: { text: "Current", glyph: "●", tone: "good" },
  stale: { text: "Stale", glyph: "✕", tone: "attention" },
  unavailable: { text: "Not live", glyph: "■", tone: "quiet" },
  not_started: { text: "Not started", glyph: "■", tone: "quiet" },
  running: { text: "Loading", glyph: "○", tone: "work" },
  complete: { text: "Complete", glyph: "●", tone: "good" },
  needs_attention: { text: "Needs attention", glyph: "✕", tone: "attention" },
  projecting: { text: "Indexing", glyph: "○", tone: "work" },
  unknown: { text: "Not yet proven", glyph: "△", tone: "attention" },
};

export function coveragePresentation(state: string) {
  return PRESENTATION[state] || PRESENTATION.unknown;
}

const shortDate = (value: string) => new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "short", day: "numeric", timeZone: "UTC",
}).format(new Date(value));

export function coverageFacts(coverage: SourceCoverageDetail): string[] {
  const facts: string[] = [];
  const from = coverage.confirmed_range.from;
  const through = coverage.confirmed_range.through;
  if (from && through) facts.push(`Confirmed ${shortDate(from)} to ${shortDate(through)}`);
  else if (from) facts.push(`Confirmed since ${shortDate(from)}`);

  if (coverage.counts.seen !== null) facts.push(`${coverage.counts.seen.toLocaleString()} checked in the latest run`);
  if (coverage.counts.accepted !== null) facts.push(`${coverage.counts.accepted.toLocaleString()} accepted`);
  if (coverage.counts.refused !== null && coverage.counts.refused > 0) {
    facts.push(`${coverage.counts.refused.toLocaleString()} refused`);
  }
  if (coverage.counts.failed !== null && coverage.counts.failed > 0) {
    facts.push(`${coverage.counts.failed.toLocaleString()} failed`);
  }
  if (coverage.projection_pending !== null && coverage.projection_pending > 0) {
    facts.push(`${coverage.projection_pending.toLocaleString()} waiting for meaning search`);
  }
  if (coverage.waiting_on_owner_machine) facts.push("Waiting for the owner computer");
  return facts;
}

export function coverageCaveat(label: string, coverage: SourceCoverageDetail): string | null {
  if (coverage.history.state === "complete") return null;
  const from = coverage.confirmed_range.from;
  return from
    ? `${label} is confirmed from ${shortDate(from)} onward. Older material may still be loading.`
    : `${label} history is not yet proven complete. A missing result may still be outside the confirmed coverage.`;
}

export function accessZonePresentation(accessZone: SourceRow["access_zone"]): {
  text: string;
  tone: "good" | "attention" | "quiet";
} {
  if (!accessZone || accessZone.state === "unknown") {
    return { text: "Access zone could not be verified", tone: "attention" };
  }
  if (accessZone.state === "assigned" && accessZone.label) {
    return { text: `Access zone: ${accessZone.label}`, tone: "good" };
  }
  if (accessZone.state === "unregistered") {
    return { text: "Source registration needs review · owner only", tone: "attention" };
  }
  return { text: "Access zone not assigned · owner only", tone: "quiet" };
}
