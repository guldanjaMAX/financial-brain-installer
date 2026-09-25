/**
 * acceptance — prove a live brain install actually works.
 *
 * Run against ANY install, at any time, by anyone holding the admin key:
 *
 *   brain test <manifest>
 *
 * This is deliberately two things at once.
 *
 * As a TEST it is the gate on an install and on every upgrade: it is what
 * turns "deployed" into "working", and an upgrade that has not passed it is a
 * belief rather than a release.
 *
 * As a PRODUCT FEATURE it is the artifact a client can run themselves, on
 * their own infrastructure, without asking us anything. That matters more than
 * it sounds: the whole promise is that they own this. An install they cannot
 * independently verify is one they have to trust us about, which is exactly
 * the dependency the custody model exists to remove.
 *
 * TIERS, in dependency order. A failure in an early tier makes later tiers
 * meaningless, so the run reports which tier broke rather than dumping a wall
 * of consequential failures.
 *
 *   1 reach      is it up, is auth enforced
 *   2 data       is anything in it, and is EVERY source that should be
 *                refreshing still refreshing
 *   3 retrieval  does a real question return real sources
 *   4 safety     does the credential gate actually refuse
 *   5 operations schema version, migrations, spend cap
 *
 * Every check is READ-ONLY except the credential-gate probe, which attempts an
 * ingest that MUST be refused. If that probe ever succeeds, the test fails
 * loudly and the content it wrote is reported for removal.
 */

import { fetchBrainWithAdminKey } from "./components/brain-http.mjs";
import { safeAnswerErrorText } from "./worker/src/lib/answer-render.js";

const PASS = "pass";
const FAIL = "fail";
const WARN = "warn";
const SKIP = "skip";

const CREDENTIAL_GATE_ERROR = "refused: content carries live credential(s)";
const CREDENTIAL_GATE_DETAIL =
  "Rotate them, strip them from the source, then re-ingest. Nothing was written.";

const CANONICAL_REFUSAL = "The documents do not answer the question.";
const answerIsRefusal = (answer) => String(answer || "").trim() === CANONICAL_REFUSAL;
const responseObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const nonemptyResponseText = (value) => typeof value === "string" && value.trim().length > 0;
const ANSWER_UNAVAILABLE_STATUSES = new Set(["search_unavailable", "coverage_incomplete"]);

function normalizedEvidenceNumbers(value, resultCount) {
  if (!Array.isArray(value)) return false;
  const seen = new Set();
  for (const number of value) {
    if (!Number.isInteger(number) || number < 1 || number > resultCount || seen.has(number)) {
      return false;
    }
    seen.add(number);
  }
  return true;
}

/**
 * Refuse a 200-shaped answer whose fields contradict each other.
 *
 * Type checks alone are insufficient here: plausible answer text paired with
 * no candidates, no citations, or an unavailable/error state is not evidence
 * that the reviewed answer path ran. All returned details stay fixed public
 * copy so a malformed older Worker cannot leak provider or private text.
 */
export function answerResponseContractDiagnostic(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "the Worker returned no structured answer response";
  }

  const owns = (field) => Object.prototype.hasOwnProperty.call(payload, field);
  if (payload.mode !== "think" || !owns("answer") ||
      !(payload.answer === null || typeof payload.answer === "string") ||
      !Array.isArray(payload.results) || !Array.isArray(payload.gaps) ||
      !Array.isArray(payload.citations)) {
    return "the Worker returned an incomplete or incompatible answer response";
  }

  const hasTopLevelError = owns("error") && payload.error !== undefined && payload.error !== null;
  const hasStatus = owns("status") && payload.status !== undefined && payload.status !== null;
  if (hasTopLevelError || (hasStatus && !ANSWER_UNAVAILABLE_STATUSES.has(payload.status))) {
    return "the Worker returned an incompatible answer error or status";
  }
  if (owns("evidence_gate") && payload.evidence_gate !== undefined &&
      payload.evidence_gate !== null && !responseObject(payload.evidence_gate)) {
    return "the Worker returned an incomplete or incompatible evidence gate";
  }
  const evidenceGate = responseObject(payload.evidence_gate) ? payload.evidence_gate : null;
  if (payload.results.some((result) =>
    !responseObject(result) || !nonemptyResponseText(result.chunk_uid) ||
    !(result.title === null || result.title === undefined || typeof result.title === "string") ||
    !(result.source === null || result.source === undefined || typeof result.source === "string"))) {
    return "the Worker returned an incomplete or incompatible candidate result";
  }
  if (evidenceGate && Object.prototype.hasOwnProperty.call(evidenceGate, "partial") &&
      typeof evidenceGate.partial !== "boolean") {
    return "the Worker returned an incomplete or incompatible evidence gate";
  }
  if (evidenceGate && Object.prototype.hasOwnProperty.call(evidenceGate, "error") &&
      !nonemptyResponseText(evidenceGate.error)) {
    return "the Worker returned an incomplete or incompatible evidence gate";
  }
  const evidenceGateHasError = Boolean(evidenceGate) &&
    Object.prototype.hasOwnProperty.call(evidenceGate, "error");

  if (payload.answer === null) {
    if (payload.citations.length > 0) {
      return "the Worker returned citations without an answer";
    }
    if (evidenceGate?.supported === true) {
      return "the Worker withheld answer text despite a supported evidence gate";
    }
    if (evidenceGate) {
      const ownsEvidence = Object.prototype.hasOwnProperty.call(evidenceGate, "evidence");
      const normalizedEvidence = ownsEvidence &&
        normalizedEvidenceNumbers(evidenceGate.evidence, payload.results.length);
      const invalidErrorGate = evidenceGateHasError &&
        (evidenceGate.supported !== false || evidenceGate.complete !== false ||
         evidenceGate.partial === true || (ownsEvidence &&
           (!normalizedEvidence || evidenceGate.evidence.length !== 0)));
      const invalidOrdinaryGate = !evidenceGateHasError && !normalizedEvidence;
      if (typeof evidenceGate.supported !== "boolean" ||
          typeof evidenceGate.complete !== "boolean" ||
          evidenceGate.partial === true || invalidErrorGate || invalidOrdinaryGate) {
        return "the Worker returned an incomplete or incompatible evidence gate";
      }
    }
    if (owns("answer_error") && payload.answer_error !== undefined &&
        payload.answer_error !== null && !nonemptyResponseText(payload.answer_error)) {
      return "the Worker returned an incomplete or incompatible answer error";
    }
    return null;
  }

  const answer = payload.answer.trim();
  if (!answer) return "the Worker returned empty answer text instead of null";

  if (ANSWER_UNAVAILABLE_STATUSES.has(payload.status) ||
      owns("answer_error") ||
      evidenceGateHasError) {
    return "the Worker returned answer text alongside an unavailable or error state";
  }

  if (answerIsRefusal(answer)) {
    if (payload.citations.length > 0 || !evidenceGate ||
        evidenceGate.supported !== false || typeof evidenceGate.complete !== "boolean" ||
        evidenceGate.partial === true ||
        !normalizedEvidenceNumbers(evidenceGate.evidence, payload.results.length)) {
      return "the Worker's refusal contradicted its citation or evidence receipt";
    }
    return null;
  }
  if (payload.results.length === 0) {
    return "the Worker returned a factual answer without candidate evidence";
  }

  const markers = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])));
  const cited = new Map();
  for (const citation of payload.citations) {
    if (!responseObject(citation) || !Number.isInteger(citation.n) ||
        citation.n < 1 || citation.n > payload.results.length ||
        !nonemptyResponseText(citation.title) || !nonemptyResponseText(citation.source) ||
        cited.has(citation.n)) {
      return "the Worker's factual answer and citation evidence did not agree";
    }
    const result = payload.results[citation.n - 1];
    const resultTitle = String(result.title || "untitled").slice(0, 140);
    const resultSource = String(result.source || "?");
    if (citation.title !== resultTitle || citation.source !== resultSource) {
      return "the Worker's citation did not identify its numbered candidate result";
    }
    cited.set(citation.n, citation);
  }
  if (!markers.size || !cited.size || markers.size !== cited.size ||
      [...markers].some((n) => !cited.has(n))) {
    return "the Worker's factual answer and citation evidence did not agree";
  }
  if (!evidenceGate || evidenceGate.supported !== true ||
      !Array.isArray(evidenceGate.evidence) ||
      !(evidenceGate.complete === true ||
        (evidenceGate.complete === false && evidenceGate.partial === true)) ||
      (evidenceGate.complete === true && evidenceGate.partial === true)) {
    return "the Worker returned a factual answer its evidence gate did not support";
  }
  const approved = new Set();
  for (const number of evidenceGate.evidence) {
    if (!Number.isInteger(number) || approved.has(number)) {
      return "the Worker's factual answer carried an invalid evidence receipt";
    }
    approved.add(number);
  }
  if (approved.size !== cited.size || [...approved].some((n) => !cited.has(n))) {
    return "the Worker's factual answer and evidence receipt did not agree";
  }
  return null;
}

/**
 * Name the exact stage that left `/api/rag/think` without an answer.
 *
 * A null answer is not one condition. It can mean retrieval was unavailable,
 * declared source coverage is still incomplete, the evidence verifier refused
 * an unsupported draft, or the answer model itself returned nothing. Those
 * states require different next actions, and collapsing them into "unknown"
 * made a live acceptance warning impossible to investigate.
 *
 * Only bounded, already-public response fields enter the detail. Provider
 * errors are sanitized by the Worker before this function sees them.
 */
export function answerUnavailableDiagnostic(payload) {
  const contractDiagnostic = answerResponseContractDiagnostic(payload);
  if (contractDiagnostic) {
    return {
      stage: "response_contract",
      detail: contractDiagnostic,
    };
  }

  const results = payload.results;
  const gaps = payload.gaps;
  const evidenceGate = payload.evidence_gate && typeof payload.evidence_gate === "object" &&
    !Array.isArray(payload.evidence_gate)
    ? payload.evidence_gate
    : null;

  if (payload.status === "search_unavailable" ||
      (results.length === 0 && payload.degraded)) {
    return {
      stage: "retrieval",
      detail: "search was incomplete, so no absence claim was accepted",
    };
  }

  const coverageGap = gaps.find((gap) =>
    gap && typeof gap === "object" && ["coverage_stale", "coverage_unavailable"].includes(gap.type)
  );
  if (payload.status === "coverage_incomplete" || coverageGap) {
    return {
      stage: "source_coverage",
      detail: "one or more declared sources are not yet proven complete",
    };
  }

  if (evidenceGate?.error) {
    return {
      stage: "answer_verification",
      // Modern Workers emit a fixed public token here, but an acceptance
      // runner can be newer than the Worker it probes. Never carry an older
      // raw verifier/provider error into the local report.
      detail: "the evidence verifier was unavailable; no answer was accepted",
    };
  }

  if (payload.answer_error) {
    return {
      stage: "answer_model",
      detail: safeAnswerErrorText(payload.answer_error),
    };
  }
  if (evidenceGate && (evidenceGate.supported === false || evidenceGate.complete === false)) {
    return {
      stage: "answer_verification",
      // The verifier reason is model-generated from the private question,
      // draft, and citations. It is diagnostic evidence, not public copy.
      detail: evidenceGate.supported === false
        ? "the generated draft was not accepted because its cited evidence did not support it"
        : "the generated draft was not accepted because it did not cover the complete question",
    };
  }

  if (results.length === 0) {
    return {
      stage: "retrieval",
      detail: "search completed but returned no candidate evidence for the probe",
    };
  }

  if (payload.model) {
    return {
      stage: "answer_model",
      detail: `the configured answer model returned no answer text from ${results.length} candidate result(s)`,
    };
  }

  return {
    stage: "answer_model_dispatch",
    detail: `${results.length} candidate result(s) were present, but the Worker reported neither a model nor an answer error`,
  };
}

/**
 * Accept only the credential scanner's production refusal contract.
 *
 * A bare 422 can be a validation error, and a response that merely contains
 * the word "refused" can come from a proxy or an unrelated guard. Neither is
 * proof that credential-shaped content was recognized before storage.
 */
export function credentialGateRefusalVerdict({ status, text }) {
  if (status !== 422) return { accepted: false, reason: `expected HTTP 422, received ${status}` };
  let payload;
  try {
    payload = JSON.parse(String(text || ""));
  } catch {
    return { accepted: false, reason: "HTTP 422 did not carry JSON" };
  }
  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    return { accepted: false, reason: "HTTP 422 did not carry an error object" };
  }
  if (payload.error !== CREDENTIAL_GATE_ERROR) {
    return { accepted: false, reason: "HTTP 422 was not the credential-gate error" };
  }
  if (!Array.isArray(payload.labels) || !payload.labels.includes("cloudflare_token_new")) {
    return { accepted: false, reason: "credential-gate response did not name the canary provider" };
  }
  if (payload.detail !== CREDENTIAL_GATE_DETAIL) {
    return { accepted: false, reason: "credential-gate response did not confirm that nothing was written" };
  }
  return { accepted: true, reason: "structured credential refusal confirmed" };
}

/**
 * States the Worker reports for a source that WAS expected to keep itself
 * current and has not. Each one is a FAILURE, not a warning: a client reading
 * a green acceptance report is being told their brain is current, and a source
 * in one of these states makes that sentence false.
 */
const FRESHNESS_DEAD = new Set(["stale", "broken", "never_synced"]);

/** One sentence a person can act on at 9pm, per dead state. */
const FRESHNESS_SENTENCE = {
  stale: (s) =>
    `last read ${s.days_since_ingest ?? "?"} day(s) ago but expected to refresh about every ` +
    `${s.expected_every_days ?? "?"} day(s); anything added since is not in the brain`,
  broken: (s) => s.reason || "the last sync failed",
  never_synced: () =>
    "expected to refresh but has never completed a sync, so its contents may be missing entirely",
};

const shortLabel = (s) =>
  s.state === "stale" && Number.isFinite(Number(s.days_since_ingest))
    ? `${s.name} (${s.days_since_ingest}d)`
    : s.name;

/**
 * Judge freshness PER SOURCE, against what each source was actually expected
 * to do.
 *
 * This replaces a check that took the newest ingest timestamp across every
 * source and called the whole corpus fresh if that single value was recent. On
 * any install with one fast source — message capture runs every minute — that
 * check passed forever, including while the client's most important corpus had
 * been dead for months. It was a corpus-wide claim supported by one source.
 *
 * The expectation itself is NOT reinvented here. `/api/admin/brain/freshness`
 * already owns it: a schedule is recorded when a connector's scheduler is
 * installed, a source with no expectation is never called stale because it was
 * never going to update, and a source we cannot reach on our own reads
 * "manual" rather than being blamed for a limit of the architecture. Deriving a
 * second notion of staleness in the test would let the acceptance report and
 * `brain sources` disagree about the same install, and the client would have no
 * way to tell which one was lying.
 *
 * Returns records rather than recording them, so the judgement is testable
 * without a Worker.
 */
export function freshnessVerdicts({ ok, status, payload, expectedBackend = "d1" } = {}) {
  const HEADLINE = "every source expected to refresh is current";

  // A check that cannot run says so. It never passes.
  if (String(expectedBackend || "").toLowerCase() !== "d1") {
    return [{
      name: HEADLINE,
      status: SKIP,
      detail:
        `per-source freshness is implemented for the d1 backend and this install declares ` +
        `${expectedBackend || "no"} storage, so no freshness claim is made either way`,
    }];
  }
  if (!ok) {
    return [{
      name: HEADLINE,
      status: FAIL,
      detail:
        `the freshness endpoint did not answer (HTTP ${status ?? "?"}). Freshness is UNVERIFIED: ` +
        `this install cannot tell you whether any source has stopped updating. Upgrade the ` +
        `Worker, then re-run.`,
    }];
  }
  if (payload?.unavailable) {
    return [{
      name: HEADLINE,
      status: FAIL,
      detail: "the Worker could not read its sources table, so no source's freshness could be checked",
    }];
  }
  const sources = Array.isArray(payload?.sources) ? payload.sources : null;
  if (!sources) {
    return [{
      name: HEADLINE,
      status: FAIL,
      detail: "the freshness endpoint returned no per-source list, so freshness is unverified",
    }];
  }
  if (!sources.length) {
    return [{
      name: HEADLINE,
      status: WARN,
      detail:
        "no sources are registered in this install, so nothing here can be judged fresh or stale. " +
        "Register the corpora with `brain sources <manifest> --add <name>`.",
    }];
  }

  const dead = sources.filter((s) => FRESHNESS_DEAD.has(s.state));
  const unscheduled = sources.filter((s) => s.state === "unscheduled");
  const manual = sources.filter((s) => s.state === "manual");
  const indexing = sources.filter((s) => s.state === "indexing");
  const current = sources.filter((s) => s.state === "ok");
  const judged = dead.length + current.length + indexing.length;

  const aside = [
    unscheduled.length ? `${unscheduled.length} unscheduled` : null,
    manual.length ? `${manual.length} loaded by hand and never judged stale` : null,
    indexing.length ? `${indexing.length} mid-sync` : null,
  ].filter(Boolean);

  // "0 of 0 current" is a vacuous green, and a vacuous green is the same lie
  // in a smaller font. When nothing in the install is expected to refresh, say
  // that instead of reporting a perfect score over an empty set.
  const headline = judged === 0
    ? {
        name: HEADLINE,
        status: WARN,
        detail:
          `no source in this install is expected to refresh, so nothing here is being kept ` +
          `current${aside.length ? ` (${aside.join("; ")})` : ""}`,
      }
    : {
        name: HEADLINE,
        status: dead.length ? FAIL : PASS,
        detail: dead.length
          ? `${dead.length} of ${judged} scheduled source(s) have stopped updating: ` +
            `${dead.map(shortLabel).join(", ")}` +
            (aside.length ? ` (${aside.join("; ")})` : "")
          : `${current.length + indexing.length} of ${judged} scheduled source(s) current` +
            (aside.length ? ` (${aside.join("; ")})` : ""),
      };
  const out = [headline];

  // One line per source that is not current, because "something is stale" is
  // not something anyone can act on.
  for (const s of dead) {
    out.push({
      name: `freshness: ${s.name}`,
      status: FAIL,
      detail: `${String(s.state).toUpperCase().replace(/_/g, " ")} — ` +
        `${(FRESHNESS_SENTENCE[s.state] || (() => s.state))(s)}`,
    });
  }
  // Not a failure and not a pass. Nothing on this machine refreshes this
  // source, which is the honest state on a platform where the product installs
  // no scheduler at all, and it must be visible rather than quietly green.
  for (const s of unscheduled) {
    out.push({
      name: `freshness: ${s.name}`,
      status: WARN,
      detail:
        "NO REFRESH IS SCHEDULED. It can be refreshed automatically but nothing on this " +
        "install does, so it will not update until a schedule is set, and no staleness " +
        "claim is made about it either way.",
    });
  }
  return out;
}

/**
 * How long acceptance waits out a transient retrieval failure before failing.
 *
 * Measured on 2026-09-17 against a 192,082-document / 1,700,842-chunk brain
 * whose vector projection was verified complete (expected_vectors ==
 * actual_vectors, backlog 0). Sustained or concurrent request streams saturate
 * D1, which is single-threaded per database, and the Worker then fast-fails:
 * 246-606 ms, `degraded: "retrieval"`, `degraded_reason:
 * "keyword-and-vector-query-failed"`, `status: "search_unavailable"`. Healthy
 * calls on the same brain cost 2.5-17.3 s. The failures are POSITIONAL, not
 * probe-bound: three failing runs that morning hit three different probe sets,
 * and the only constant was position at the tail of a sustained run. Run alone,
 * the same fifteen saved probes passed 15/15, twice.
 *
 * The acceptance suite runs those fifteen probes back-to-back immediately after
 * activation inside `brain update`, which is the most sustained sequence the
 * brain ever sees, and it produced a false FAIL twice that day on a brain that
 * was healthy. That false FAIL stops the update in front of the customer.
 *
 * Two properties are load-bearing and neither is negotiable:
 *
 *  - SPACED. A deliberate four-way burst went healthy -> partial -> total
 *    fast-fail in three rounds over ~50 s. Retrying immediately into a
 *    saturated D1 fails too, and adds to the load that caused the failure.
 *  - SEQUENTIAL. One call at a time, one probe at a time. Concurrency is the
 *    thing being worked around; a parallel retry would recreate it.
 *
 * The budget is fixed, and it is sized to the ONE recovery interval anyone has
 * actually measured. A301BB4-DECISION-2026-09-17 §4 condition 1: burst round 3
 * fast-failed 4/4 at 249-383 ms, and "60 s is empirically sufficient (r2 tail ->
 * r3 fully clean)". A 30 s per-probe ceiling is therefore below the only
 * interval the retry was built to cover, and would give up exactly one attempt
 * short of the evidence. Four attempts 15 s apart spans that 60 s and keeps the
 * spacing well clear of the tight-loop failure mode.
 *
 * Anything longer than that is a real fault and must still FAIL, because "wait
 * long enough and it turns green" is how a tolerance becomes a cover-up.
 *
 * THE WORST CASE, stated honestly, because the first version of this comment
 * understated it by counting only the sleeping. Two things are bounded here and
 * only one of them is sleep:
 *
 *  - SLEEPING is capped by `tierBudgetMs` at 240 s across the whole tier.
 *  - EXTRA REQUESTS are capped at tierBudgetMs / spacingMs = 16, because every
 *    retry costs one full spacing interval out of the same tier budget. Each of
 *    those requests is itself a live call that can take as long as a healthy
 *    call took on the measured brain: 2.5-17.3 s (§1(b)).
 *
 * So the true ceiling is 240 s of sleeping + 16 x 17.3 s = ~277 s of requests,
 * about 8.6 minutes added to an install. The realistic figure is far smaller,
 * and it is the one this is designed around: a retry only fires because D1 is
 * fast-failing, and a fast-fail costs 246-606 ms, so 240 s of sleeping + 16 x
 * 0.6 s = ~10 s of requests, a little over 4 minutes. The 8.6 minute number is
 * the case where every retried call is slow AND still wrong, which is a brain
 * that is going to FAIL anyway.
 */
export const RETRIEVAL_RETRY_DEFAULTS = Object.freeze({
  /** Retries after the first attempt, per probe. */
  attempts: 4,
  /** Wait between attempts. Spaced, never immediate. */
  spacingMs: 15_000,
  /** Ceiling on waiting for ONE probe: 4 x 15 s, spanning the measured 60 s. */
  probeBudgetMs: 60_000,
  /** Ceiling on waiting across the WHOLE tier, however many probes there are. */
  tierBudgetMs: 240_000,
});

/**
 * Waiting budget shared by every probe in one tier.
 *
 * Counts time spent WAITING, not wall clock, so the budget is exactly the
 * arithmetic the policy above describes and a test with an injected sleep
 * observes it directly instead of racing a timer. Fifteen probes cannot turn
 * into fifteen separate half-minutes of hope: the tier ceiling binds first.
 */
export function retrievalRetryBudget(policy = RETRIEVAL_RETRY_DEFAULTS) {
  let tierSpent = 0;
  return {
    get tierSpentMs() { return tierSpent; },
    probe() {
      let probeSpent = 0;
      return {
        get spentMs() { return probeSpent; },
        allows(ms) {
          return probeSpent + ms <= policy.probeBudgetMs && tierSpent + ms <= policy.tierBudgetMs;
        },
        take(ms) { probeSpent += ms; tierSpent += ms; },
      };
    },
  };
}

/**
 * "; recovered after 2 retries" / "; still degraded after 4 retries" /
 * "; still empty after 4 retries".
 *
 * `outcome` is explicit rather than a boolean pair because the three endings
 * are three different findings. A probe that came back empty from a Worker
 * that reported NO degradation did not stay degraded -- it stayed empty, and
 * saying "still degraded" there invents a Worker report that never happened.
 */
function retryNote(retries, outcome) {
  if (!retries) return "";
  const plural = retries === 1 ? "retry" : "retries";
  const ending = outcome === "recovered"
    ? "recovered"
    : outcome === "empty" ? "still empty" : "still degraded";
  return `; ${ending} after ${retries} ${plural}`;
}

/**
 * Every `degraded` token the Worker can put on the wire, classified.
 *
 * This table exists because "any non-null `degraded`" is not the same question
 * as "did semantic retrieval fail", and conflating them is a false-FAIL source.
 * The Worker emits six distinct tokens from two sites -- `store-d1.js` (the D1
 * backend, five tokens) and `store.js` (the legacy Supabase backend, two) --
 * and most of them describe a state that is expected, deliberate, or simply not
 * about the vector path at all. Failing acceptance on `scoped-vector`, which
 * means "an exact-document scope was applied so the unscoped index was
 * deliberately not queried", would fail a brain for behaving correctly.
 *
 * So only the tokens that mean a retrieval path FAILED are counted, and that
 * set is exactly what commit a301bb4 counted (`vector`) plus the one token
 * added since to name the worse case explicitly (`retrieval`).
 *
 * `vector` is kept a failure even though two of its three reasons
 * (`projection-incomplete`, `entity-vector-authority-unindexed`) are ordinary
 * states of a young or entity-filtered brain: that is the behaviour a301bb4
 * shipped and this change is not the place to narrow it. The reason rides the
 * detail text either way, so the reader can tell which one they have.
 *
 * `test/acceptance-verdict.test.mjs` pins these keys against the Worker source,
 * so a seventh token cannot silently become either a failure or a benign state.
 */
export const RETRIEVAL_FAILURE_DEGRADED = Object.freeze({
  vector: "the vector modality did not serve this request",
  retrieval: "both keyword and vector retrieval failed",
});

/** Degraded tokens that are expected states, not retrieval failures. */
export const EXPECTED_DEGRADED = Object.freeze({
  fts: "keyword search was unavailable; the semantic modality still ran",
  "scoped-vector": "a document or zone scope was applied, so the unscoped semantic index was deliberately not queried",
  "no-embedding": "the embedding model did not answer, so this request was keyword-only",
  "document-access-unavailable": "the legacy Supabase backend cannot serve a scoped request",
});

/** The whole vocabulary, token -> "failure" | "expected". Pinned by test. */
export const DEGRADED_CLASSIFICATION = Object.freeze({
  ...Object.fromEntries(Object.keys(RETRIEVAL_FAILURE_DEGRADED).map((k) => [k, "failure"])),
  ...Object.fromEntries(Object.keys(EXPECTED_DEGRADED).map((k) => [k, "expected"])),
});

/** The wire value as a bounded token, or null when nothing was reported. */
export function degradedToken(value) {
  if (value === null || value === undefined || value === false) return null;
  const token = String(value).trim().slice(0, 40);
  return token || null;
}

/**
 * Did semantic retrieval actually fail?
 *
 * An unknown token answers NO. A token this file has never seen is a Worker
 * change, and the honest response to a Worker change is a failing pin test in
 * development, not a FAIL invented in front of a customer during an install.
 */
export function isRetrievalFailureDegradation(value) {
  const token = degradedToken(value);
  return token !== null && DEGRADED_CLASSIFICATION[token] === "failure";
}

/**
 * What the WORKER said about a search it could not complete, or null.
 *
 * The text this replaces asserted a cause acceptance never measured. It counted
 * `degraded === "vector"` and then blamed an empty vector index — provably the
 * one condition that CANNOT produce that value, because `searchVector` returns
 * `[]` on an empty Vectorize result without setting `vectorFailed`, so an empty
 * index degrades nothing. Meanwhile the real reasons (`projection-incomplete`,
 * `vector-query-failed`, `keyword-and-vector-query-failed`) already ride the
 * wire as `degraded_reason`, beside `status`, and were simply never read.
 *
 * So: report the Worker's own vocabulary, verbatim and bounded. These are fixed
 * tokens from `retrieval-status.js`, not free text, and slicing keeps a future
 * one from turning a check detail into a payload.
 */
export function workerDegradationDetail(json) {
  const token = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  const degraded = json?.degraded === null || json?.degraded === undefined || json?.degraded === false
    ? ""
    : token(String(json.degraded), 40);
  const status = token(json?.status, 40);
  const reason = token(json?.degraded_reason, 80);
  const head = status || degraded;
  if (head && reason) return `${head}: ${reason}`;
  return head || reason || null;
}

/**
 * The Worker's `status` alone, bounded the same way.
 *
 * Needed on the one path where there is no degradation to describe: a response
 * that returned zero rows and reported no `degraded` field at all. That shape
 * is healthy in structure -- `coverage_incomplete` with no degradation is the
 * ordinary state of a brain whose declared source history is partial -- and the
 * detail has to say what the Worker actually said rather than borrowing the
 * vocabulary of a degradation that was never reported.
 */
export function workerStatusToken(json) {
  const status = typeof json?.status === "string" ? json.status.trim().slice(0, 40) : "";
  return status || null;
}

export class Acceptance {
  constructor({
    base, adminKey, manifest, expectVersion = null, fetchImpl = fetch, tolerateStaleSources = false,
    sleepImpl = null, retrievalRetry = null,
  }) {
    this.base = String(base).replace(/\/+$/, "");
    this.key = adminKey;
    this.m = manifest || {};
    this.fetch = fetchImpl;
    this.expectVersion = expectVersion;
    // Freshness is a fact about a SOURCE, not about the brain or a release.
    // An update runs this suite after the new code is already live, and a
    // Google grant that lapsed last week made every such update report
    // UPGRADE_FAILED and leave the version stamp unrecorded. The update asks
    // for stale sources as warnings; a standalone `brain test` keeps them as
    // failures, because there the question is "is this brain proven".
    this.tolerateStaleSources = tolerateStaleSources === true;
    this.results = [];
    // The first failed tier and an intentional early stop are different facts.
    // Tier 2+ failures stay recorded while the independent later tiers run.
    this.tierFailed = null;
    this.stoppedAtTier = null;
    // Capabilities the run could not exercise at all. A skip inside a tier is
    // a detail; a whole capability going untested changes what "passed" means,
    // so the summary carries it and the verdict has to say it.
    this.untested = [];
    // Injectable so the retry tests are arithmetic rather than minutes of real
    // waiting. Nothing else in this suite sleeps.
    this.sleep = sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.retrievalRetry = Object.freeze({ ...RETRIEVAL_RETRY_DEFAULTS, ...(retrievalRetry || {}) });
  }

  /**
   * Run one retrieval probe, repeating it only while it is still failing and
   * only while the budget allows. Strictly sequential: one call in flight at a
   * time, and the next probe does not start until this one is finished.
   *
   * `run` returns { failing, value }. The retry changes nothing about what
   * counts as a pass — the LAST attempt is judged exactly as the only attempt
   * was before this existed — so a probe that never recovers fails identically
   * to today, with the same check name and the same status.
   */
  async retryTransientProbe(budget, run) {
    const spend = budget.probe();
    let outcome = await run();
    let retries = 0;
    while (
      outcome.failing &&
      retries < this.retrievalRetry.attempts &&
      spend.allows(this.retrievalRetry.spacingMs)
    ) {
      spend.take(this.retrievalRetry.spacingMs);
      await this.sleep(this.retrievalRetry.spacingMs);
      outcome = await run();
      retries += 1;
    }
    return { ...outcome, retries, waitedMs: spend.spentMs, recovered: retries > 0 && !outcome.failing };
  }

  static isFreshnessCheck(name) {
    return name === "every source expected to refresh is current" || String(name).startsWith("freshness: ");
  }

  record(tier, name, status, detail) {
    let downgraded = false;
    if (status === FAIL && this.tolerateStaleSources && Acceptance.isFreshnessCheck(name)) {
      status = WARN;
      downgraded = true;
    }
    this.results.push(downgraded ? { tier, name, status, detail, downgraded } : { tier, name, status, detail });
    if (status === FAIL && this.tierFailed === null) this.tierFailed = tier;
    return status;
  }

  async request(path, { auth = true, method = "GET", body } = {}) {
    const init = {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    const res = auth
      ? await fetchBrainWithAdminKey(this.fetch, this.base + path, init, () => this.key)
      : await this.fetch(this.base + path, init);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON is itself a finding */
    }
    return { status: res.status, ok: res.ok, json, text };
  }

  async get(path, options = {}) {
    return this.request(path, options);
  }

  async post(path, body, options = {}) {
    return this.request(path, { ...options, method: "POST", body });
  }

  /* ------------------------------------------------------- tier 1: reach */

  async tierReach() {
    const t = 1;
    try {
      const h = await this.get("/health", { auth: false });
      if (!h.ok) return this.record(t, "health responds", FAIL, `HTTP ${h.status}`);
      const observedVersion = h.json?.version ?? null;
      this.observedVersion = observedVersion;
      if (this.expectVersion && observedVersion !== this.expectVersion) {
        return this.record(
          t,
          "health responds",
          FAIL,
          `expected version ${this.expectVersion}, received ${observedVersion || "none"}`,
        );
      }
      this.record(t, "health responds", PASS, `version ${observedVersion ?? "?"}`);
    } catch (e) {
      return this.record(t, "health responds", FAIL, e.message);
    }

    // Auth must actually be enforced. An install that answers without a key is
    // a public copy of the client's private records, which is the single worst
    // outcome this system can produce.
    const noKey = await this.post("/api/rag/unified", { q: "test" }, { auth: false });
    this.record(
      t,
      "unauthenticated request is refused",
      noKey.status === 401 ? PASS : FAIL,
      `HTTP ${noKey.status}${noKey.status !== 401 ? " — THE BRAIN IS ANSWERING WITHOUT A KEY" : ""}`
    );

    const badKey = await fetchBrainWithAdminKey(this.fetch, `${this.base}/api/rag/unified`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "test" }),
    }, () => "definitely-not-the-key");
    this.record(
      t,
      "wrong key is refused",
      badKey.status === 401 ? PASS : FAIL,
      `HTTP ${badKey.status}`
    );

    const good = await this.get("/api/admin/brain/documents");
    this.record(t, "correct key is accepted", good.ok ? PASS : FAIL, `HTTP ${good.status}`);
  }

  /* -------------------------------------------------------- tier 2: data */

  async tierData() {
    const t = 2;
    const docs = await this.get("/api/admin/brain/documents");
    if (!docs.ok) return this.record(t, "corpus summary", FAIL, `HTTP ${docs.status}`);

    const rows = docs.json?.rows || [];
    const informational = docs.json?.summary?.status === "informational";
    const total = informational
      ? null
      : rows.reduce((a, r) => a + Number(r.total || 0), 0);
    const hasDocuments = informational
      ? rows.some((row) => row?.has_documents === true)
      : total > 0;
    this.record(
      t,
      "corpus is not empty",
      hasDocuments ? PASS : FAIL,
      informational
        ? `${rows.length} source type(s); exact size is not counted on large Brains; run \`brain report\` for the full count`
        : `${total} document(s) across ${rows.length} source type(s)`
    );

    const unembedded = informational
      ? Number(docs.json?.vector_backlog?.pending)
      : rows.reduce(
        (a, r) => a + (Number(r.total || 0) - Number(r.embedded || 0)),
        0
      );
    // A backlog is normal mid-ingest; a large one means the embedder is stuck,
    // and the symptom a user sees is simply "search does not find my document".
    this.record(
      t,
      "embedding backlog is small",
      Number.isSafeInteger(unembedded) && unembedded >= 0
        ? unembedded === 0 ? PASS : unembedded < 1000 ? WARN : FAIL
        : FAIL,
      Number.isSafeInteger(unembedded) && unembedded >= 0
        ? `${unembedded} vector operation(s) awaiting visibility`
        : "the exact vector backlog was unavailable"
    );

    // D1 is the product default everywhere else (setup, update, and health).
    // Do not let an endpoint choose its own expected backend here: a misbound
    // Supabase Worker could otherwise make a manifest with omitted storage
    // silently skip every exact Vectorize readiness check.
    const expectedBackend = String(
      this.m.infrastructure?.cloudflare?.storage || "d1",
    ).trim().toLowerCase();
    const actualBackend = String(docs.json?.backend || "").trim().toLowerCase();
    this.record(
      t,
      "storage backend matches manifest",
      actualBackend === expectedBackend ? PASS : FAIL,
      `expected ${expectedBackend || "an explicit backend"}, received ${actualBackend || "none"}`,
    );
    if (expectedBackend === "d1") {
      const readiness = docs.json?.vector_readiness;
      const valid = readiness && typeof readiness === "object" && !Array.isArray(readiness) &&
        !Object.hasOwn(readiness, "error") && typeof readiness.ready === "boolean" &&
        Number.isSafeInteger(readiness.expected_vectors) && readiness.expected_vectors >= 0 &&
        Number.isSafeInteger(readiness.actual_vectors) && readiness.actual_vectors >= 0 &&
        Number.isSafeInteger(readiness.pending) && readiness.pending >= 0 &&
        Number.isSafeInteger(readiness.submitted) && readiness.submitted >= 0 &&
        readiness.submitted <= readiness.pending;
      const ready = valid && readiness.ready === true && readiness.pending === 0 &&
        readiness.submitted === 0 && readiness.actual_vectors === readiness.expected_vectors;
      this.record(
        t,
        "semantic index is query-ready",
        ready ? PASS : FAIL,
        valid
          ? `${readiness.actual_vectors}/${readiness.expected_vectors} vector(s), ${readiness.pending} operation(s) pending` +
            (ready ? "" : `; ${readiness.action || "run brain drain, then brain diagnose"}`)
          : "the Worker did not provide a valid Vectorize visibility receipt",
      );
    }

    // Freshness is a PER-SOURCE claim and never a corpus-wide one. Ask the
    // Worker's expectation-aware surface rather than re-deriving staleness
    // here, so this check and `brain sources` can never disagree about which
    // source is dead.
    const freshness = await this.get("/api/admin/brain/freshness");
    for (const verdict of freshnessVerdicts({
      ok: freshness.ok,
      status: freshness.status,
      payload: freshness.json,
      expectedBackend,
    })) {
      this.record(t, verdict.name, verdict.status, verdict.detail);
    }
  }

  /* ---------------------------------- tier 3: optional owner-question checks */

  async tierRetrieval(probes) {
    const t = 3;
    // Saved owner questions are an optional regression aid. Setup and handoff
    // do not depend on the owner preparing a question list: the technician
    // proves one real item separately through accepted, stored with provenance,
    // projected, and query-visible with citation. When questions are present,
    // keep exercising the full retrieval and answer contracts below.
    const savedQuestions = Array.isArray(probes)
      ? probes.filter((question) => String(question || "").trim())
      : [];
    if (!savedQuestions.length) {
      this.untested.push("optional_owner_questions");
      return this.record(
        t,
        "optional owner-question checks",
        SKIP,
        "none saved; zero are required for setup, adaptive acceptance, or handoff"
      );
    }

    // One waiting budget for the whole tier, spent strictly sequentially.
    const budget = retrievalRetryBudget(this.retrievalRetry);
    let answered = 0;
    let degradedProbes = 0;
    let recoveredProbes = 0;
    const finalReasons = new Set();
    const expectedStates = new Set();
    for (const q of savedQuestions) {
      // Zero results and a degradation that means a retrieval path FAILED are
      // the two shapes the transient D1 saturation takes, and both clear on
      // their own within a minute on a brain that is actually healthy.
      //
      // An expected degradation is neither. `scoped-vector` will still be
      // `scoped-vector` after four retries and a minute of waiting, because it
      // is a description of the request, not a fault -- retrying it buys an
      // extra minute of install time and then fails the brain anyway. It is
      // recorded in the detail and nothing else. Everything else is judged on
      // the first answer, exactly as before.
      const attempt = await this.retryTransientProbe(budget, async () => {
        const r = await this.post("/api/rag/unified", { q, limit: 5, rerank: 0 });
        const n = r.json?.results?.length || 0;
        const degraded = degradedToken(r.json?.degraded);
        return {
          failing: n === 0 || isRetrievalFailureDegradation(degraded),
          value: {
            n,
            degraded,
            failure: isRetrievalFailureDegradation(degraded),
            why: workerDegradationDetail(r.json),
            status: workerStatusToken(r.json),
          },
        };
      });
      const { n, degraded, failure, why, status } = attempt.value;
      if (n > 0) answered++;
      // Only the LAST attempt counts. A probe that recovered was a stall, not
      // a degraded brain, and must not be reported as one.
      if (failure) {
        degradedProbes++;
        if (why) finalReasons.add(why);
      } else if (degraded !== null && why) {
        expectedStates.add(why);
      }
      if (attempt.recovered) recoveredProbes++;
      // Three different findings, three different sentences. The last one is
      // the zero-result response that reported NO degradation: it must say so,
      // because claiming a degradation the Worker never reported sends the
      // reader to look for an outage that does not exist.
      let observed = "";
      if (failure && why) observed = `; the Worker reported ${why}`;
      else if (degraded !== null) observed = `; the Worker reported the expected state ${why || degraded}, not a retrieval failure`;
      else if (n === 0) {
        observed = status
          ? `; the Worker reported status ${status} with no degradation`
          : "; the Worker reported no degradation";
      }
      this.record(
        t,
        `probe: ${q.slice(0, 48)}`,
        n > 0 ? PASS : FAIL,
        `${n} result(s)` +
          observed +
          retryNote(attempt.retries, attempt.recovered ? "recovered" : failure ? "degraded" : "empty")
      );
    }
    this.record(
      t,
      "probe coverage",
      answered === savedQuestions.length ? PASS : answered > 0 ? WARN : FAIL,
      `${answered}/${savedQuestions.length} probes returned sources` +
        (recoveredProbes ? `; ${recoveredProbes} recovered after a retry` : "")
    );
    // The retry never softens this verdict; it only decides WHEN the verdict is
    // taken. What changed is that the detail now names the reason the Worker
    // itself gave instead of asserting a Vectorize cause acceptance never read,
    // and that the tally counts only degradations that mean a retrieval path
    // failed. Expected states are reported here and fail nothing.
    const expectedNote = expectedStates.size
      ? `; expected states reported, none of them a retrieval failure: ${[...expectedStates].join(", ")}`
      : "";
    this.record(
      t,
      "semantic retrieval is active",
      degradedProbes === 0 ? PASS : FAIL,
      (degradedProbes === 0
        ? "no probe degraded to keyword-only retrieval" +
          (recoveredProbes ? `; ${recoveredProbes} probe(s) recovered after a retry` : "")
        : `${degradedProbes}/${savedQuestions.length} probe(s) were still degraded after the retry budget; ` +
          (finalReasons.size
            ? `the Worker reported ${[...finalReasons].join(", ")}`
            : "the Worker reported no reason")) + expectedNote,
    );

    // `think` must degrade rather than 500. This is the path most likely to
    // break quietly, because it only fails when the LLM key, the spend cap or
    // the model name is wrong, none of which show up until someone asks a
    // question.
    const thinkAttempt = await this.retryTransientProbe(budget, async () => {
      const r = await this.post("/api/rag/think", { q: savedQuestions[0], limit: 5 });
      // Same classification as the probes above: retry a failed retrieval path,
      // never an expected state that a retry cannot change.
      return { failing: isRetrievalFailureDegradation(r.json?.degraded), value: r };
    });
    const think = thinkAttempt.value;
    if (isRetrievalFailureDegradation(think.json?.degraded)) {
      const why = workerDegradationDetail(think.json);
      // `retrieval` means NEITHER modality ran. Calling that "keyword-only"
      // would describe a fallback that did not happen.
      const headline = degradedToken(think.json?.degraded) === "retrieval"
        ? "the answer path completed no retrieval at all"
        : "the answer path degraded to keyword-only retrieval";
      this.record(
        t,
        "think uses semantic retrieval",
        FAIL,
        headline +
          (why ? `; the Worker reported ${why}` : "") +
          retryNote(thinkAttempt.retries, "degraded"),
      );
    } else if (thinkAttempt.recovered) {
      // Recorded only when it actually had to recover, so a healthy run's
      // result list is byte-for-byte what it was before this change.
      this.record(
        t,
        "think uses semantic retrieval",
        PASS,
        `the answer path used semantic retrieval${retryNote(thinkAttempt.retries, "recovered")}`,
      );
    }
    if (!think.ok) {
      this.record(t, "think endpoint", FAIL, `HTTP ${think.status}`);
    } else {
      // Validate the complete public response envelope before trusting answer
      // text. A malformed 200 containing plausible prose is not proof that the
      // Worker ran the reviewed answer path, and must never turn acceptance
      // green merely because `answer` is truthy.
      const diagnostic = answerUnavailableDiagnostic(think.json);
      if (diagnostic.stage === "response_contract") {
        this.record(t, "think response contract", FAIL, diagnostic.detail);
      } else if (think.json?.answer) {
        const answer = think.json.answer;
        this.record(t, "think returns an answer", PASS, `${answer.length} chars`);
        // A refusal ("the documents do not answer this") correctly carries no
        // citations, because it makes no factual claim to cite. Requiring
        // markers unconditionally fails the brain for behaving honestly, which
        // is the opposite of what this check is for.
        const isRefusal = answerIsRefusal(answer);
        const cited = /\[\d+\]/.test(answer);
        if (isRefusal && !cited) {
          this.record(t, "answer citation discipline", PASS, "honest refusal, nothing to cite");
        } else {
          this.record(
            t,
            "answer carries inline citations",
            cited ? PASS : FAIL,
            cited ? "found [n] markers" : "the answer makes claims but cites nothing"
          );
        }
      } else {
        // A complete null-answer response proves the endpoint degraded rather
        // than crashed. Its reviewed fields identify the stage without
        // exposing model- or provider-generated private text.
        this.record(
          t,
          "think degrades cleanly",
          PASS,
          `no answer; stage ${diagnostic.stage}: ${diagnostic.detail}`
        );
        this.record(
          t,
          `answer unavailable at ${diagnostic.stage}`,
          WARN,
          diagnostic.detail
        );
      }
    }
    this.record(
      t,
      "gap analysis present",
      Array.isArray(think.json?.gaps) ? PASS : FAIL,
      `${think.json?.gaps?.length ?? 0} gap(s) reported`
    );
  }

  /* ------------------------------------------------------ tier 4: safety */

  async tierSafety() {
    const t = 4;
    // Synthetic, never a live key. Shaped like a real Cloudflare token so the
    // CONFIRMED tier fires.
    const canary = "cfut_" + "Kd9Xm2Pq7Rv4Tz8Ly6Wn3Bc5Hj1Gs0Ae4Uf7Yx2Mq";
    const sourceId = "acceptance/credential-gate-probe";
    const res = await fetchBrainWithAdminKey(this.fetch, `${this.base}/api/admin/brain/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_type: "curated",
        source_id: sourceId,
        title: "acceptance probe",
        content: `Acceptance probe. Deploy with CLOUDFLARE_API_TOKEN=${canary} and it works.`,
      }),
    }, () => this.key);
    const text = await res.text();

    const gate = credentialGateRefusalVerdict({ status: res.status, text });

    if (gate.accepted) {
      this.record(t, "credential gate refuses a token", PASS, `HTTP ${res.status}, ${gate.reason}`);
    } else if (res.ok) {
      // The probe just wrote a synthetic credential into a live brain, because
      // the gate that should have stopped it is not running. There is no
      // delete endpoint to undo it with, so the only honest thing is to shout
      // the exact identifier needed to remove it by hand. A test that
      // pollutes a corpus and stays quiet about it is worse than no test.
      this.record(
        t,
        "credential gate refuses a token",
        FAIL,
        `THE GATE IS NOT ACTIVE — this probe was STORED. Remove it now:\n` +
          `        delete from brain.documents where source_type='curated' and source_id='${sourceId}';\n` +
          `        delete from public.notes_rag_documents where source_id='${sourceId}';\n` +
          `        Then deploy a build with the credential scanner enabled.`
      );
    } else {
      this.record(
        t,
        "credential gate refuses a token",
        FAIL,
        `the exact refusal contract was not observed: ${gate.reason}`,
      );
    }

    // The refusal must name the provider without quoting the secret, or the
    // error message becomes its own leak.
    if (text.includes(canary)) {
      this.record(
        t,
        "refusal does not echo the secret",
        FAIL,
        "the error response contained the credential value"
      );
    } else {
      this.record(t, "refusal does not echo the secret", PASS, "value not present in the response");
    }
  }

  /* -------------------------------------------------- tier 5: operations */

  async tierOperations(installState) {
    const t = 5;
    if (!installState) {
      return this.record(t, "install_state", SKIP, "not readable from here");
    }
    this.record(
      t,
      "schema is migrated",
      Number(installState.schema_version) > 0 ? PASS : FAIL,
      `schema version ${installState.schema_version}`
    );
    this.record(
      t,
      "credential gate version recorded",
      Number(installState.gate_version) >= 2 ? PASS : WARN,
      `gate version ${installState.gate_version}`
    );
    // Compare what is LIVE against what the operator asked for. On 2026-09-03 a
    // 0.2.0 -> 0.3.4 update printed "install 0.2.0, manifest 0.2.0" as a PASS
    // because both values were read before the update; the live Worker said
    // 0.3.4. A check that never looks at the artifact certifies nothing.
    const target = this.expectVersion || this.m.brain?.version || null;
    const live = this.observedVersion ?? null;
    if (target) {
      this.record(
        t,
        "deployed version matches the manifest",
        live && live === target ? PASS : WARN,
        `live ${live ?? "unknown"}, expected ${target}`
      );
    }
    if (live && installState.product_version && installState.product_version !== live) {
      this.record(
        t,
        "install state records the running version",
        WARN,
        `install state ${installState.product_version}, live ${live}; the version commit has not landed yet`
      );
    }
    const cap = this.m.safety?.daily_llm_spend_cap_usd;
    this.record(
      t,
      "daily spend cap configured",
      cap ? PASS : WARN,
      cap ? `$${cap}/day` : "no cap set, a runaway loop is a billing incident"
    );
  }

  /* ---------------------------------------------------------------- run */

  async run({ probes, installState } = {}) {
    await this.tierReach();
    // Everything downstream reads the brain, so a broken tier 1 makes the rest
    // noise rather than signal.
    if (this.tierFailed === 1) {
      this.stoppedAtTier = 1;
      return this.summary();
    }
    await this.tierData();
    await this.tierRetrieval(probes);
    await this.tierSafety();
    await this.tierOperations(installState);
    return this.summary();
  }

  summary() {
    const counts = { pass: 0, fail: 0, warn: 0, skip: 0 };
    for (const r of this.results) counts[r.status]++;
    return {
      results: this.results,
      counts,
      passed: counts.fail === 0,
      firstFailedTier: this.tierFailed,
      stoppedAtTier: this.stoppedAtTier,
      untested: [...this.untested],
    };
  }
}

/**
 * The one-line verdict a person reads last, with any honesty qualifiers.
 *
 * Saved owner questions are optional. Their absence is reported without
 * turning onboarding into homework. The separate same-item evidence gate is
 * what proves retrieval before handoff. A legacy summary that says the whole
 * retrieval capability went untested remains qualified so old results cannot
 * be mistaken for evidence.
 *
 * Exit semantics are the caller's and stay unchanged: a failed suite still
 * fails, a passed-but-unqualified suite still exits clean.
 */
export function acceptanceVerdict(summary) {
  if (!summary?.passed) return { headline: "acceptance suite FAILED", warnings: [], notes: [] };
  const untested = Array.isArray(summary.untested) ? summary.untested : [];
  if (untested.includes("retrieval")) {
    return {
      headline: "automated checks passed; query-visible retrieval still needs evidence",
      warnings: [
        "This older result did not include query-visible retrieval proof.",
        "Do not ask the owner to prepare a question list. Prove one approved",
        "low-sensitivity item as accepted, stored with provenance, projected,",
        "and query-visible with a citation before handoff.",
      ],
      notes: [],
    };
  }
  const notes = untested.includes("optional_owner_questions")
    ? [
        "No owner-authored regression questions were run. Zero are required for setup, adaptive acceptance, or handoff.",
        "Owner handoff still requires the separate same-item evidence gate: accepted, stored with provenance, projected, and query-visible with a citation.",
        "Add saved owner questions later only if they would be useful for repeatable regression checks.",
      ]
    : [];
  return { headline: "automated acceptance checks passed", warnings: [], notes };
}
