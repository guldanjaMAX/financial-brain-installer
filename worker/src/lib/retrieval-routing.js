/**
 * Supplemental candidate scopes for questions that explicitly name a source.
 *
 * These are hints, not authorization or hard filters. The ordinary cross-source
 * search still runs, then each hint gets its own metadata-prefiltered candidate
 * lane before Vectorize's top-K cutoff and D1's keyword limit.
 */

const CALENDAR_INTENT = /\bcalendars?\b/i;
const MEETING_INTENT = /\b(?:meetings?|zoom|meeting transcripts?)\b/i;
const IMESSAGE_INTENT = /\bimessages?\b|\b(?:text|sms) messages?\b|\b(?:texts|texted)\b/i;

export const RETRIEVAL_HINT_MAX = 3;

export function supplementalRetrievalFilters(query, filters = {}) {
  const text = String(query || "");
  const base = filters && typeof filters === "object" && !Array.isArray(filters)
    ? filters
    : {};
  const hints = [];
  if (!base.category && CALENDAR_INTENT.test(text)) {
    hints.push({ ...base, category: "calendar" });
  }
  if (!base.category && MEETING_INTENT.test(text)) {
    hints.push({ ...base, category: "meeting" });
  }
  if (!base.platform && IMESSAGE_INTENT.test(text)) {
    hints.push({ ...base, platform: "imessage" });
  }

  const seen = new Set();
  return hints.filter((hint) => {
    const key = JSON.stringify(Object.keys(hint).sort().map((name) => [name, hint[name]]));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, RETRIEVAL_HINT_MAX);
}
