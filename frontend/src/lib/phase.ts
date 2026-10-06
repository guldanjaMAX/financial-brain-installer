import type { SystemStatus } from "./api";

const REFRESHABLE_SOURCE_KINDS = new Set([
  "drive", "gmail", "imap", "calendar", "imessage", "whatsapp", "zoom",
  "quickbooks", "slack", "notion", "microsoft", "dropbox", "hubspot", "plaid",
]);

// Undated records reduce time-based coverage, but do not mean the Brain's
// integrity needs repair. Every other warning remains installer-owned. If the
// finding register is missing or disagrees with its counts, fail closed.
const BENIGN_WARNING_IDS = new Set(["undated"]);

/** What state this brain is actually in, derived in exactly one place.
 *
 *  Centralised because the derivation has a trap in it. An empty corpus
 *  computes a HEALTHY verdict — the verdict only counts crit and warn findings,
 *  and a brain that has read nothing has nothing to complain about. Rendering
 *  that literally puts "everything checked came back clean" over a brain that
 *  knows nothing. Emptiness must therefore be tested BEFORE any verdict is
 *  read, and if every screen derived its own phase, one of them would
 *  eventually get that order wrong. */
export type BrainPhase =
  | "unreachable"   // we could not check; say nothing about contents
  | "paused"        // reading works, adding does not
  | "unknown"       // it would not say whether it accepts documents
  | "empty"         // it holds nothing yet
  | "coverage_unknown" // source or semantic coverage could not be checked
  | "preparing"     // one or more sources have not reached starter context
  | "indexing"      // it holds things it cannot all search yet
  | "problems"      // it works, and something is wrong that the installer owns
  | "backfilling"   // starter context works, but declared history is incomplete
  | "ready";

export function derivePhase(s: SystemStatus | null): BrainPhase {
  if (!s) return "unreachable";

  // Order matters from here down. Each test is only meaningful once the ones
  // above it have been ruled out.
  const lostTheContents = !("documents" in s);
  if (lostTheContents) return "unreachable";

  if (s.status === "paused-for-upgrade" || s.accepting_documents === false) return "paused";
  // Not a default to yes. A brain that would not say has not said yes.
  if (s.accepting_documents === null) return "unknown";

  // BEFORE any verdict. See the note above.
  if ((s.documents ?? 0) === 0) return "empty";

  const coverageUnavailable = s.unavailable?.includes("diagnose") ||
    s.unavailable?.includes("freshness") ||
    s.unavailable?.includes("vectors") || !Array.isArray(s.sources) || !s.vectors ||
    s.sources.some((source) => !source.coverage);
  if (coverageUnavailable) return "coverage_unknown";

  const coveredSources = (s.sources || []).filter((source) => source.coverage);
  if (coveredSources.some((source) => source.coverage?.starter_context.state === "preparing")) {
    return "preparing";
  }

  if (s.vectors && !s.vectors.ready) return "indexing";
  const warningCount = s.problem_counts?.warn ?? 0;
  const explainedBenignWarnings = (s.problems || []).filter((problem) =>
    problem.severity === "warn" && BENIGN_WARNING_IDS.has(problem.id)).length;
  const actionableProblemInRegister = (s.problems || []).some((problem) =>
    problem.severity === "crit" ||
    (problem.severity === "warn" && !BENIGN_WARNING_IDS.has(problem.id)));
  if ((s.problem_counts?.crit ?? 0) > 0 || actionableProblemInRegister ||
      warningCount > explainedBenignWarnings) return "problems";
  if (coveredSources.some((source) => source.coverage?.history.state !== "complete" ||
      source.coverage?.meaning_search.state !== "ready" ||
      (REFRESHABLE_SOURCE_KINDS.has(source.kind) &&
        source.coverage?.live_updates.state !== "current"))) return "backfilling";
  return "ready";
}

/** One sentence per phase, in the owner's terms, said identically everywhere. */
export function phraseFor(phase: BrainPhase, s: SystemStatus | null): string {
  const pct = s?.vectors?.percent_visible;
  switch (phase) {
    case "unreachable":
      return "The brain's document and source status could not be reached. Financial sections below still say whether their own reads succeeded.";
    case "paused":
      return "Your Brain is in the middle of an update, so it isn't taking new documents yet. Asking questions still works. If you're not updating right now, open Claude Code and say: finish my Brain update.";
    case "unknown":
      return "Your brain would not say whether it is accepting documents. Reading still works. This is worth reporting.";
    case "empty":
      return "Your brain has not read anything yet. Once records are loaded, it can begin answering from them.";
    case "coverage_unknown":
      if (s?.unavailable?.includes("diagnose")) {
        return "Your brain is still loading. Its status check will finish once loading settles. You can already ask questions.";
      }
      return "Your brain has records, but source or meaning-search coverage could not be checked. Treat missing results as unproven until that status is available.";
    case "preparing":
      return "Your brain is preparing starter context. Useful questions can begin before every source finishes loading its history.";
    case "indexing":
      return pct === null || pct === undefined
        ? "Your brain is still working through what it has been given. Answers will be incomplete until it finishes."
        : `Your brain can search ${pct}% of what it holds. It is still working through the rest, so an answer may be missing things it already has.`;
    case "problems":
      return "Your brain is working, and there is something your installer should look at.";
    case "backfilling":
      return "Starter context is available. Some source history or live updates are still loading, unproven, or unscheduled, so missing results remain provisional.";
    case "ready":
      return "Your brain has read everything it has been given and can search all of it.";
  }
}

/** Whether this phase means an answer could be missing things. The Ask screen
 *  needs this so a partial index never renders as a confident absence. */
export const answersMayBeIncomplete = (p: BrainPhase) =>
  p === "coverage_unknown" || p === "preparing" || p === "indexing" || p === "backfilling" ||
  p === "unreachable" || p === "empty";
