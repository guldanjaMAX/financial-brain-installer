/**
 * Zero results plus a degraded index must never instruct anyone to state an
 * absence.
 *
 * The failure this pins was field-observed on a fresh install: 61 documents and
 * 1,001 chunks in the store, every query returning zero rows with
 * degraded="vector" while the index projected, and /think answering with a gap
 * that read "The brain has nothing on this query. Say so plainly rather than
 * inferring." A consumer that followed that instruction told the owner they had
 * nothing on file about their own records. Honest in form, false in fact, and
 * indistinguishable from a correct answer.
 *
 * Three properties are pinned here, and the third is what makes the first two
 * worth anything:
 *
 *   (a) empty + degraded emits no absence instruction, and names the cause.
 *   (b) empty + healthy still emits the ordinary refusal, byte for byte. The
 *       honest "nothing recorded" answer is the product working, and a fix that
 *       softened it would have traded one dishonesty for another.
 *   (c) the MCP surface — the place the client actually asks — carries the
 *       signal through, proven against a real spawned server, not a stub.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import worker from "../src/index.js";
import {
  ANSWER_WITHHELD, COVERAGE_INCOMPLETE, LEDGER_REFUSAL_POLICIES, NO_RESULTS_GAP, REFUSAL_NEXT_ACTIONS,
  SEARCH_UNAVAILABLE, absenceUnproven, answerWithheldNotice,
  coverageIncompleteNotice, degradedCause, emptyRetrievalDisclosure,
  meaningSearchLine, projectionPending, refusalNextAction, retrievalUnavailable, unavailableNotice,
} from "../src/lib/retrieval-status.js";
import {
  PROJECTION_CATCHUP_MAX_AGE_MS,
  PROJECTION_CATCHUP_MAX_PENDING,
  PROJECTION_CATCHUP_MAX_PENDING_RATIO,
  projectionCatchupEligible,
  search,
  vectorReadiness,
} from "../src/lib/store-d1.js";
import { storeFor } from "../src/lib/store.js";
import { looksLikeRefusal } from "../../eval/scorer.mjs";
import { cmdAsk } from "../../brain.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + d)); if (!c) fail++; };

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

/* The exact sentence the honest no-match path is contracted to emit. Spelled
   out rather than imported so a change to the constant cannot quietly rewrite
   what this test claims to be checking. */
const HONEST_REFUSAL_DETAIL =
  "The brain has nothing on this query. Say so plainly rather than inferring.";

/* Phrasings that assert the corpus is empty. An unavailable-search response
   ASSERTING any of these is the bug. */
const ABSENCE_CLAIM =
  /has nothing on|nothing recorded|no record|not recorded|nothing matched|say so plainly rather than inferring/i;

/* A prohibition against the claim is the fix, and it necessarily quotes the
   claim it forbids. Matching the phrase alone would therefore fail the very
   text that closes the defect, so the scan is per sentence and skips any
   sentence that negates. */
const PROHIBITION = /\b(do not|don't|never|rather than|instead of)\b|nothing here means/i;

function assertsAbsence(text) {
  return String(text ?? "")
    .split(/(?<=[.!?])\s+/)
    .some((sentence) => ABSENCE_CLAIM.test(sentence) && !PROHIBITION.test(sentence));
}

{
  check("meaning-search progress names visible and total chunks instead of a percentage",
    meaningSearchLine({ visible: 12_400, total: 48_000 }) ===
      "Meaning search covers 12,400 of 48,000 chunks; keyword search covers all");
  check("an unknown meaning-search total stays a counting state",
    meaningSearchLine({ visible: 12_400, total: null }) ===
      "Meaning search is still counting chunks; keyword search covers all");
  check("a ready meaning-search projection needs no catch-up line",
    meaningSearchLine({ visible: 48_000, total: 48_000 }) === null);
}

/* Everything in a response that a model or a human actually reads as prose. */
const proseOf = (obj) => [
  obj?.note, obj?.notice, obj?.answer,
  ...(Array.isArray(obj?.gaps) ? obj.gaps.map((g) => g?.detail) : []),
].filter((v) => typeof v === "string").join("\n");

/* The helper has to discriminate, or every check built on it is theatre. */
{
  check("SELF-CHECK: the scanner catches a bare absence claim",
    assertsAbsence("The brain has nothing on this query. Say so plainly rather than inferring.") === true);
  check("SELF-CHECK: and does not fire on a prohibition against it",
    assertsAbsence("Do NOT say or imply that the brain has nothing on this question.") === false);
}

for (const gate of [
  "uncited_draft", "money_check", "date_check", "conflicting_records",
  "unreadable_check_reply", "unsupported",
]) {
  const notice = answerWithheldNotice(gate);
  check(`answer-withheld ${gate} notice does not score as a refusal`,
    looksLikeRefusal(notice) === false, notice);
}

const WORKER_NEXT_ACTIONS = [
  [undefined, null, 'Next: ask again with a name, date or exact phrase the record would contain.'],
  [COVERAGE_INCOMPLETE, null, 'Next: say "check my Brain" to see which source is still loading, then ask again.'],
  [SEARCH_UNAVAILABLE, null, 'Next: ask again in a minute; if it fails twice, say "check my Brain".'],
  [ANSWER_WITHHELD, "uncited_draft", "Next: ask about one record at a time, naming its title or date."],
  [ANSWER_WITHHELD, "unsupported", "Next: ask about one record at a time, naming its title or date."],
  [ANSWER_WITHHELD, "money_check", "Next: ask for one amount with its payer, payee and date."],
  [ANSWER_WITHHELD, "date_check", "Next: ask again with the exact date range you mean."],
  [ANSWER_WITHHELD, "conflicting_records", "Next: ask which record is newest on this; the records found disagree."],
  [ANSWER_WITHHELD, "unreadable_check_reply", "Next: ask the same question again in a minute."],
];
{
  const expectedActionKeys = [
    "answer_withheld:conflicting_records", "answer_withheld:date_check",
    "answer_withheld:money_check", "answer_withheld:uncited_draft",
    "answer_withheld:unreadable_check_reply", "answer_withheld:unsupported",
    "coverage_incomplete", "no_results", "search_unavailable",
    "ledger:ambiguous_account", "ledger:balance_unavailable",
    "ledger:bank_export_overlap_review_required", "ledger:cash_flow_unsupported",
    "ledger:coverage_review_required", "ledger:ledger_account_link_required",
    "ledger:ledger_unavailable", "ledger:live_feed_never_synced", "ledger:merchant_selector_ambiguous",
    "ledger:merchant_selector_unsupported", "ledger:no_accounts", "ledger:period_outside_coverage",
    "ledger:retrieval_scope_restricted", "ledger:unreadable_transactions",
    "ledger:unsupported_currency", "ledger:unsupported_question",
  ].sort();
  check("the refusal next-action map is closed and complete",
    Object.isFrozen(REFUSAL_NEXT_ACTIONS) &&
      Object.keys(REFUSAL_NEXT_ACTIONS).sort().join(",") === expectedActionKeys.join(","));
  for (const [reason, policy] of Object.entries(LEDGER_REFUSAL_POLICIES)) {
    const action = refusalNextAction({ ledgerReason: reason });
    check(`the ledger:${reason} refusal has its exact reviewed next action`,
      REFUSAL_NEXT_ACTIONS[`ledger:${reason}`] === policy.next_action && action === policy.next_action &&
        looksLikeRefusal(action) === false,
      String(action));
  }
  for (const [status, withheldGate, expected] of WORKER_NEXT_ACTIONS) {
    const action = refusalNextAction({ status, withheldGate });
    check(`the ${status || "no_results"}:${withheldGate || "default"} refusal has its exact next action`,
      action === expected && looksLikeRefusal(action) === false && !/%|brain (?:drain|health)/i.test(action),
      String(action));
  }
  check("an unmapped refusal status has no invented next action",
    refusalNextAction({ status: "future_refusal" }) === null);
}

/* ------------------------------------------------------------------ */
/* a worker env whose vector projection is not finished                */
/* ------------------------------------------------------------------ */

function mkEnv({
  rows = [], keywordRows = rows, coverageRows = [], coverageUnavailable = false,
  vectorIds = [], projectionReady = true, embeds = true,
  expectedVectors = vectorIds.length, actualVectors = vectorIds.length,
  pending = 0, oldestQueuedAt = null, supportedAnswer = false, embeddingGate = null,
  vectorThrows = false,
} = {}) {
  const retrievalCalls = { keyword: 0, vector: 0, embedding: 0, events: [] };
  const env = {
    STORAGE: "d1",
    ADMIN_KEY: "k",
    DB: {
      prepare(sql) {
        return {
          bind() { return this; },
          all: async () => {
            if (/FROM sources s/.test(sql)) {
              if (coverageUnavailable) throw new Error("coverage read unavailable");
              return { results: coverageRows };
            }
            if (/chunks_fts MATCH/.test(sql)) {
              retrievalCalls.keyword++;
              retrievalCalls.events.push("keyword");
              return { results: keywordRows };
            }
            return { results: rows };
          },
          first: async () => {
            if (/proportional-projection-backlog/.test(sql)) {
              return { n: pending };
            }
            if (/vector_projection_mutation_id AS mutation_id/.test(sql)) {
              return {
                schema_version: 12,
                // A submitted mutation the index has not processed yet is the
                // ordinary state of a brain in the hours after install.
                mutation_id: projectionReady ? null : "mutation-in-flight",
                mutation_submitted_at: null,
                projection_status: projectionReady ? "verified" : "pending",
                bootstrap_epoch: 0,
                bootstrap_cursor: null,
                bootstrap_high_water: null,
                expected_vectors: expectedVectors,
                live_vectors: expectedVectors,
                pending: 0,
                submitted: 0,
                oldest_queued_at: null,
              };
            }
            if (/FROM vector_outbox/.test(sql) && /submitted_mutation_id/.test(sql)) {
              return { n: pending, oldest: oldestQueuedAt, upserts: pending, deletes: 0, submitted: 0 };
            }
            return /count\(\*\)/i.test(sql)
              ? { n: 0, stored_documents: 0, logical_documents: 0 }
              : null;
          },
          run: async () => ({}),
        };
      },
      batch: async () => {},
    },
    VECTORIZE: {
      query: async () => {
        retrievalCalls.vector++;
        retrievalCalls.events.push("vector");
        if (vectorThrows) throw new Error("synthetic vector failure");
        return { matches: vectorIds.map((id) => ({ id })) };
      },
      upsert: async () => {},
      describe: async () => ({ vectorCount: actualVectors, processedUpToMutation: null }),
    },
    AI: {
      run: async (model, input) => {
        if (model.includes("bge-")) {
          retrievalCalls.embedding++;
          retrievalCalls.events.push("embedding");
          if (embeddingGate) await embeddingGate;
          return embeds ? { data: [[0.1, 0.2, 0.3]] } : (() => { throw new Error("embedder down"); })();
        }
        const system = String(input?.messages?.[0]?.content || "");
        if (supportedAnswer && /verify a proposed answer/.test(system)) {
          return { response: { supported: true, complete: true, evidence: [1], reason: "direct support" }, usage: {} };
        }
        return {
          response: supportedAnswer ? "The retrieved record supports the answer [1]." : "unused",
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
      },
    },
  };
  env.__retrievalCalls = retrievalCalls;
  return env;
}

const think = async (env, q = "what do my records say") => {
  const res = await worker.fetch(new Request("https://b.example/api/rag/think", {
    method: "POST",
    headers: { "X-Admin-Key": "k", "Content-Type": "application/json" },
    body: JSON.stringify({ q, limit: 8 }),
  }), env, { waitUntil() {}, passThroughOnException() {} });
  return { res, body: await res.json() };
};

const unified = async (env, q = "the") => {
  const res = await worker.fetch(new Request("https://b.example/api/rag/unified", {
    method: "POST",
    headers: { "X-Admin-Key": "k", "Content-Type": "application/json" },
    body: JSON.stringify({ q, limit: 8, rerank: 0 }),
  }), env, { waitUntil() {}, passThroughOnException() {} });
  return { res, body: await res.json() };
};

/* ---- the store still separates the two cases, and now says which fault ---- */
{
  const env = mkEnv({ projectionReady: false });
  const r = await search(env, { query: "records", embedding: [0.1], limit: 5 });
  check("a still-building projection is degraded even with zero rows on both sides",
    r.results.length === 0 && r.degraded === "vector", JSON.stringify({ n: r.results.length, d: r.degraded }));
  check("and it says WHICH degradation, so the sentence downstream can name it",
    r.degraded_reason === "projection-incomplete", String(r.degraded_reason));

  const healthy = await search(mkEnv({}), { query: "records", embedding: [0.1], limit: 5 });
  check("a healthy empty corpus is still not degraded",
    healthy.results.length === 0 && healthy.degraded === null && healthy.degraded_reason === null,
    JSON.stringify({ d: healthy.degraded, r: healthy.degraded_reason }));
}

{
  check("only the two indexing reasons are pending projection states",
    projectionPending("vector", "projection-catching-up") === true &&
      projectionPending("vector", "projection-incomplete") === true &&
      projectionPending("vector", "vector-query-failed") === false &&
      projectionPending("no-embedding", "embedding-unavailable") === false &&
      projectionPending("vector", "projection-count-mismatch") === false);
}

/* ---- keyword retrieval starts while the embedding provider is pending ---- */
{
  let releaseEmbedding;
  const embeddingGate = new Promise((resolve) => { releaseEmbedding = resolve; });
  const row = {
    chunk_uid: "drive:vector-only#0", doc_uid: "drive:vector-only", source: "drive",
    source_id: "vector-only", title: "Vector-only record", text: "A differently worded fact.",
    document_date: Date.parse("2026-09-28T00:00:00.000Z"),
    date_source: "fixture:date", date_reliable: 1, text_source: "native", text_reliable: 1,
  };
  const env = mkEnv({
    rows: [row], keywordRows: [], vectorIds: [row.chunk_uid], embeddingGate,
  });
  const searchPromise = storeFor(env).search(env, { query: "alternate phrase", limit: 5 });
  await new Promise((resolve) => setImmediate(resolve));
  check("deferred embedding: FTS reaches its decision point before the embedding resolves",
    env.__retrievalCalls.keyword > 0 && env.__retrievalCalls.vector === 0,
    JSON.stringify(env.__retrievalCalls));
  releaseEmbedding();
  const result = await searchPromise;
  check("deferred embedding: the late vector lane still contributes its record",
    env.__retrievalCalls.vector > 0 && result.results.some((candidate) => candidate.doc_uid === row.doc_uid),
    JSON.stringify({ calls: env.__retrievalCalls, results: result.results.map((candidate) => candidate.doc_uid) }));
}

{
  let rejectEmbedding;
  const embeddingGate = new Promise((_, reject) => { rejectEmbedding = reject; });
  const row = {
    chunk_uid: "drive:keyword#0", doc_uid: "drive:keyword", source: "drive",
    source_id: "keyword", title: "Keyword record", text: "Exact fixture wording.",
    document_date: Date.parse("2026-09-28T00:00:00.000Z"),
    date_source: "fixture:date", date_reliable: 1, text_source: "native", text_reliable: 1,
  };
  const env = mkEnv({ rows: [row], keywordRows: [row], embeddingGate });
  const searchPromise = storeFor(env).search(env, { query: "fixture wording", limit: 5 });
  await new Promise((resolve) => setImmediate(resolve));
  check("failed embedding: FTS runs while the provider call is still pending",
    env.__retrievalCalls.keyword > 0 && env.__retrievalCalls.vector === 0,
    JSON.stringify(env.__retrievalCalls));
  rejectEmbedding(new Error("synthetic embedding failure"));
  const result = await searchPromise;
  check("failed embedding: keyword evidence answers with the existing no-embedding state and no indexing receipt",
    result.results.some((candidate) => candidate.doc_uid === row.doc_uid) &&
      result.degraded === "no-embedding" && result.degraded_reason === "embedding-unavailable" &&
      result.retrieval_receipt === undefined && result.meaning_search === undefined,
    JSON.stringify(result));
}

{
  const row = {
    chunk_uid: "drive:ready#0", doc_uid: "drive:ready", source: "drive",
    source_id: "ready", title: "Ready record", text: "Ready fixture wording.",
    document_date: Date.parse("2026-09-28T00:00:00.000Z"),
    date_source: "fixture:date", date_reliable: 1, text_source: "native", text_reliable: 1,
  };
  const ready = mkEnv({ rows: [row], vectorIds: [row.chunk_uid] });
  const baseline = await storeFor(ready).search(ready, { query: "ready wording", limit: 5 });
  check("control: ready hybrid ranking has no indexing receipt",
    baseline.results[0]?.doc_uid === row.doc_uid && baseline.retrieval_receipt === undefined &&
      baseline.meaning_search === undefined,
    JSON.stringify(baseline));

  const grant = mkEnv({ rows: [row], vectorIds: [row.chunk_uid] });
  await storeFor(grant).search(grant, {
    query: "ready wording", limit: 5,
    access: { kind: "grant", grantId: "fixture-grant", entitySlug: "fixture-entity" },
  });
  check("control: an exact-document grant never calls the embedding provider",
    grant.__retrievalCalls.keyword > 0 && grant.__retrievalCalls.embedding === 0 &&
      grant.__retrievalCalls.vector === 0,
    JSON.stringify(grant.__retrievalCalls));
}

/* ---- (a) empty + degraded: no absence instruction, cause named ---- */
{
  const { res, body } = await think(mkEnv({
    projectionReady: false,
    expectedVectors: 48_000,
    actualVectors: 12_400,
  }));
  check("the route still answers 200", res.status === 200, String(res.status));
  check("projection-incomplete zero results are provisional coverage, not a failed search",
    body.status === COVERAGE_INCOMPLETE, JSON.stringify(body.status));
  check("degraded is still on the wire", body.degraded === "vector", String(body.degraded));

  const gapTypes = (body.gaps || []).map((g) => g.type);
  check("no no_results gap survives", !gapTypes.includes("no_results"), JSON.stringify(gapTypes));
  check("the gap is typed as keyword-only indexing",
    gapTypes.includes("keyword_only_indexing"), JSON.stringify(gapTypes));
  check("exactly one keyword-only indexing gap (no duplicate from the refusal disclosure)",
    gapTypes.filter((type) => type === "keyword_only_indexing").length === 1, JSON.stringify(gapTypes));

  const gapText = (body.gaps || []).map((g) => g.detail).join(" ");
  check("THE DEFECT: the gap must not instruct anyone to state an absence",
    !assertsAbsence(gapText), gapText);
  check("the gap names exact indexing coverage and why a miss remains provisional",
    gapText === "Meaning search covers 12,400 of 48,000 chunks; keyword search covers all. Cited answers rest on keyword evidence; a record worded differently may not be found yet, so a missing result is provisional.",
    gapText);

  check("a human-readable notice rides along", typeof body.notice === "string" && body.notice.length > 40,
    String(body.notice));
  check("the notice does not assert an absence either",
    !assertsAbsence(body.notice), String(body.notice));
  check("the notice does not read as a refusal to the eval scorer",
    !looksLikeRefusal(body.notice), String(body.notice));
  check("the notice reports the completed zero-match and exact two-count state",
    body.notice === "The search completed with zero matches. Meaning search covers 12,400 of 48,000 chunks; keyword search covers all, so treat this result as provisional.",
    String(body.notice));
  check("projection-incomplete gives the exact coverage next action",
    body.next_action === WORKER_NEXT_ACTIONS[1][2], String(body.next_action));

  check("no refusal confidence is published for a search that never ran",
    body.confidence === undefined, JSON.stringify(body.confidence));
  check("no answer is fabricated", body.answer === null && (body.citations || []).length === 0,
    JSON.stringify({ a: body.answer, c: body.citations }));
}

/* ---- observed small/recent backlog: completed search is provisional, not failed ---- */
{
  const now = Date.parse("2026-09-28T18:00:00.000Z");
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const recent = mkEnv({
      projectionReady: false,
      expectedVectors: 1_795_309,
      actualVectors: 1_793_009,
      pending: 10_001,
      oldestQueuedAt: now - 60 * 60 * 1000,
    });
    const { body } = await think(recent);
    const readiness = await vectorReadiness(recent);
    const serializedReadiness = JSON.stringify(readiness);
    check("the capped backlog has an exact bounded proportional proof",
      readiness.proportional_pending === 10_001 &&
        readiness.proportional_pending_exact === true,
      JSON.stringify({
        proportional_pending: readiness.proportional_pending,
        proportional_pending_exact: readiness.proportional_pending_exact,
      }));
    check("the internal proportional proof does not expand the public inventory contract",
      !serializedReadiness.includes("proportional_pending"), serializedReadiness);
    check("probe: both keyword and vector retrieval reached their decision points",
      recent.__retrievalCalls.keyword > 0 && recent.__retrievalCalls.vector > 0,
      JSON.stringify(recent.__retrievalCalls));
    check("a completed search during the observed small recent backlog is coverage-incomplete",
      body.status === COVERAGE_INCOMPLETE && body.degraded_reason === "projection-catching-up",
      JSON.stringify({ status: body.status, reason: body.degraded_reason }));
    check("the pending Think response carries its keyword-only receipt and exact search counts",
      body.retrieval_receipt === "keyword_only_indexing" &&
        body.meaning_search?.visible === 1_793_009 && body.meaning_search?.total === 1_795_309 &&
        body.meaning_search?.line ===
          "Meaning search covers 1,793,009 of 1,795,309 chunks; keyword search covers all",
      JSON.stringify({ receipt: body.retrieval_receipt, meaning_search: body.meaning_search }));
    check("a provisional zero-result search still refuses an absence claim",
      body.answer === null && body.confidence === undefined &&
        !body.gaps?.some((gap) => gap.type === "no_results") && !assertsAbsence(proseOf(body)),
      JSON.stringify(body));
    const rawBody = (await unified(recent, "what do my records say")).body;
    check("raw retrieval reports the same completed catch-up state",
      rawBody.status === COVERAGE_INCOMPLETE &&
        rawBody.degraded_reason === "projection-catching-up" &&
        retrievalUnavailable(rawBody) === false,
      JSON.stringify(rawBody));

    const supportedRow = {
      chunk_uid: "drive:fixture#0", doc_uid: "drive:fixture", source: "drive",
      source_id: "fixture", title: "Synthetic record", text: "The synthetic fact is supported.",
      document_date: Date.parse("2026-09-28T00:00:00.000Z"),
      date_source: "fixture:date", date_reliable: 1, text_source: "native", text_reliable: 1,
    };
    const supported = mkEnv({
      rows: [supportedRow],
      vectorIds: [supportedRow.chunk_uid],
      projectionReady: false,
      expectedVectors: 1_795_309,
      actualVectors: 1_793_009,
      pending: 10_001,
      oldestQueuedAt: now - 60 * 60 * 1000,
      supportedAnswer: true,
    });
    const refusedWithCandidates = mkEnv({
      rows: [supportedRow],
      vectorIds: [supportedRow.chunk_uid],
      projectionReady: false,
      expectedVectors: 1_795_309,
      actualVectors: 1_793_009,
      pending: 10_001,
      oldestQueuedAt: now - 60 * 60 * 1000,
    });
    const refusedWithCandidatesBody = (await think(refusedWithCandidates, "what does the synthetic record support")).body;
    const refusedGapTypes = (refusedWithCandidatesBody.gaps || []).map((gap) => gap.type);
    check("probe: a refusal with candidates during catch-up reached the refusal path",
      refusedWithCandidatesBody.answer === null && refusedWithCandidatesBody.degraded_reason === "projection-catching-up",
      JSON.stringify({ answer: refusedWithCandidatesBody.answer, reason: refusedWithCandidatesBody.degraded_reason }));
    check("a refusal during catch-up carries exactly one keyword-only indexing gap",
      refusedGapTypes.filter((type) => type === "keyword_only_indexing").length === 1,
      JSON.stringify(refusedGapTypes));
    const supportedBody = (await think(supported, "what does the synthetic record support")).body;
    const healthySupported = mkEnv({
      rows: [supportedRow], vectorIds: [supportedRow.chunk_uid], supportedAnswer: true,
    });
    const healthySupportedBody = (await think(
      healthySupported, "what does the synthetic record support",
    )).body;
    check("an evidence-gated answer survives proportional projection catch-up",
      supported.__retrievalCalls.keyword > 0 && supported.__retrievalCalls.vector > 0 &&
        supportedBody.answer === "The retrieved record supports the answer [1]." &&
        supportedBody.evidence_gate?.supported === true && supportedBody.evidence_gate?.complete === true &&
        supportedBody.evidence_gate?.partial !== true && supportedBody.citations?.length === 1 &&
        supportedBody.status === undefined && supportedBody.degraded_reason === "projection-catching-up",
      JSON.stringify(supportedBody));
    check("a cited answer gets no refusal next action",
      supportedBody.next_action === undefined, String(supportedBody.next_action));
    check("pending cited keyword evidence keeps the healthy confidence score",
      supportedBody.confidence?.percent === healthySupportedBody.confidence?.percent &&
        !supportedBody.confidence?.basis?.includes("vector index not fully query-ready"),
      JSON.stringify({ pending: supportedBody.confidence, healthy: healthySupportedBody.confidence }));
    const pendingGap = supportedBody.gaps?.find((gap) => gap.type === "keyword_only_indexing");
    check("pending cited evidence gets the exact keyword-only indexing gap",
      pendingGap?.detail ===
        "Meaning search covers 1,793,009 of 1,795,309 chunks; keyword search covers all. Cited answers rest on keyword evidence; a record worded differently may not be found yet, so a missing result is provisional." &&
        !/brain drain|try again shortly/i.test(pendingGap.detail),
      JSON.stringify(supportedBody.gaps));

    const old = mkEnv({
      projectionReady: false,
      expectedVectors: 1_795_309,
      actualVectors: 1_793_009,
      pending: 10_001,
      oldestQueuedAt: now - 25 * 60 * 60 * 1000,
    });
    const oldBody = (await think(old)).body;
    check("the same completed search with an old backlog remains provisional while indexing",
      old.__retrievalCalls.keyword > 0 && old.__retrievalCalls.vector > 0 &&
        oldBody.status === COVERAGE_INCOMPLETE && oldBody.degraded_reason === "projection-incomplete" &&
        absenceUnproven(oldBody) === true,
      JSON.stringify({ calls: old.__retrievalCalls, status: oldBody.status, reason: oldBody.degraded_reason }));
  } finally {
    Date.now = realNow;
  }
}

/* The strict boundaries use an injected clock. A value on either threshold is
   not "under" it and therefore stays fail-closed. */
{
  const now = Date.parse("2026-09-28T18:00:00.000Z");
  const base = {
    ready: false,
    reason: "vector_work_queued",
    projection_status: "pending",
    expected_vectors: 10_000,
    actual_vectors: 9_999,
    pending: 10,
    pending_is_capped: false,
    oldest_queued_at: now - 60_000,
  };
  check("the proportional readiness constants stay explicit and reviewable",
    PROJECTION_CATCHUP_MAX_PENDING_RATIO === 0.01 &&
      PROJECTION_CATCHUP_MAX_PENDING === 50_000 &&
      PROJECTION_CATCHUP_MAX_AGE_MS === 24 * 60 * 60 * 1000);
  check("a backlog strictly inside every bound is proportional catch-up",
    projectionCatchupEligible(base, { now }) === true);
  check("the one-percent pending boundary is not classified as small",
    projectionCatchupEligible({ ...base, pending: 100 }, { now }) === false);
  check("the one-percent missing-vector boundary is not classified as small",
    projectionCatchupEligible({ ...base, actual_vectors: 9_900 }, { now }) === false);
  check("the 24-hour boundary is not classified as recent",
    projectionCatchupEligible({ ...base, oldest_queued_at: now - PROJECTION_CATCHUP_MAX_AGE_MS }, { now }) === false);
  check("the absolute pending boundary fails closed above its cap",
    projectionCatchupEligible({
      ...base,
      expected_vectors: 10_000_000,
      actual_vectors: 9_999_999,
      pending: PROJECTION_CATCHUP_MAX_PENDING + 1,
    }, { now }) === false);
  check("a capped display without an exact proportional proof fails closed",
    projectionCatchupEligible({ ...base, pending: 10_001, pending_is_capped: true }, { now }) === false);
}

/* ---- the notice must not send an assistant back to a manual `brain drain`
   loop while the index is simply still projecting.

   A looped `brain drain` measured 31/min against 61/min sustained idle,
   because it competes for the server's own drain lease instead of helping
   it. The old remedy read "Try again once `brain drain` reports the
   projection complete", which pointed the reader at `brain drain` as though
   running it would confirm or hasten completion; it does neither. This is
   the sibling fix to the vector_unavailable gap in handleThink pinned by
   worker/test/routes.test.mjs -- that test pins the populated-results gap
   text in index.js, this one pins the zero-result notice built by
   worker/src/lib/retrieval-status.js, which is what an owner's assistant
   actually reads when a degraded search returns nothing. */
{
  const notice = unavailableNotice("vector");
  check("the assistant-facing notice says the index finishes on its own",
    /on its own/i.test(notice), notice);
  check("the assistant-facing notice says a manual `brain drain` does not speed it up",
    /brain drain.*does not speed it up/i.test(notice), notice);
  check("the old guidance that `brain drain` reports the projection complete is gone",
    !/reports the projection complete/i.test(notice), notice);

  const { body } = await think(mkEnv({ projectionReady: false }));
  check("the live /think notice treats pending projection as provisional keyword coverage",
    /search completed with zero matches/i.test(body.notice || "") &&
      /keyword search covers all/i.test(body.notice || "") &&
      !/brain drain|try again shortly/i.test(body.notice || ""),
    String(body.notice));
}

/* ---- the same protection when the embedder, not the index, is the fault ---- */
{
  const { body } = await think(mkEnv({ embeds: false }));
  check("a dead embedder also produces an unavailable search, not an absence",
    body.status === SEARCH_UNAVAILABLE && body.degraded === "no-embedding",
    JSON.stringify({ s: body.status, d: body.degraded }));
  check("a dead embedder gives the exact unavailable-search next action",
    body.next_action === WORKER_NEXT_ACTIONS[2][2], String(body.next_action));
  check("its gap names ITS cause, not the vector index",
    /embedding model did not answer/i.test((body.gaps || []).map((g) => g.detail).join(" ")),
    JSON.stringify(body.gaps));
  check("a missing embedding is not misclassified as pending projection",
    projectionPending(body.degraded, body.degraded_reason) === false &&
      body.retrieval_receipt === undefined, JSON.stringify(body));
}

/* ---- a real vector-query failure keeps its confidence penalty and failure gap ---- */
{
  const row = {
    chunk_uid: "drive:failure-control#0", doc_uid: "drive:failure-control", source: "drive",
    source_id: "failure-control", title: "Failure control", text: "The supported fixture fact.",
    document_date: Date.parse("2026-09-28T00:00:00.000Z"),
    date_source: "fixture:date", date_reliable: 1, text_source: "native", text_reliable: 1,
  };
  const healthyBody = (await think(mkEnv({
    rows: [row], vectorIds: [row.chunk_uid], supportedAnswer: true,
  }), "what is the supported fixture fact")).body;
  const failedBody = (await think(mkEnv({
    rows: [row], vectorIds: [row.chunk_uid], vectorThrows: true, supportedAnswer: true,
  }), "what is the supported fixture fact")).body;
  const failureGap = failedBody.gaps?.find((gap) => gap.type === "vector_unavailable");
  check("control: vector-query-failed keeps the 15-point confidence penalty",
    healthyBody.confidence?.percent - failedBody.confidence?.percent === 15 &&
      failedBody.confidence?.basis?.includes("vector index not fully query-ready"),
    JSON.stringify({ healthy: healthyBody.confidence, failed: failedBody.confidence }));
  check("control: vector-query-failed keeps the failure gap and receives no indexing receipt",
    failedBody.degraded_reason === "vector-query-failed" &&
      /Meaning-based search failed/.test(failureGap?.detail || "") &&
      failedBody.retrieval_receipt === undefined &&
      projectionPending(failedBody.degraded, failedBody.degraded_reason) === false,
    JSON.stringify(failedBody));
}

/* ---- (b) empty + healthy: the honest refusal, unchanged ---- */
{
  const { res, body } = await think(mkEnv({}));
  check("a healthy empty search still returns 200", res.status === 200, String(res.status));
  check("REGRESSION GUARD: the honest no_results gap is untouched",
    body.gaps.length === 1 && body.gaps[0].type === "no_results" &&
      body.gaps[0].detail === HONEST_REFUSAL_DETAIL,
    JSON.stringify(body.gaps));
  check("no unavailable status is invented for a search that completed",
    body.status === undefined && body.notice === undefined,
    JSON.stringify({ s: body.status, n: body.notice }));
  check("degraded is absent", body.degraded === undefined, String(body.degraded));
  check("and the refusal confidence is still published",
    body.confidence && body.confidence.percent >= 80, JSON.stringify(body.confidence));
  check("a healthy no-match gives the exact search-refinement action without adding status",
    body.status === undefined && body.next_action === WORKER_NEXT_ACTIONS[0][2],
    JSON.stringify({ status: body.status, next_action: body.next_action }));
  check("the honest path is not treated as unavailable by clients",
    retrievalUnavailable(body) === false, JSON.stringify(body));
}

/* ---- a healthy no-match is still provisional when source coverage is partial ---- */
{
  const { body } = await think(mkEnv({ coverageRows: [{
    name: "gmail", kind: "gmail", status: "ready", document_count: 66000,
    last_ingest_at: new Date().toISOString(), expected_refresh_seconds: null,
    last_complete_sweep_at: null, indexing_started_at: null,
  }] }));
  const gapText = (body.gaps || []).map((gap) => gap.detail).join(" ");
  check("a healthy no-match keeps partial Gmail history visible",
    body.gaps?.some((gap) => gap.type === "history_unproven"), JSON.stringify(body.gaps));
  check("partial history replaces the categorical no-results claim",
    !body.gaps?.some((gap) => gap.type === "no_results") && !assertsAbsence(gapText), gapText);
  check("partial history has an explicit provisional response contract",
    body.status === COVERAGE_INCOMPLETE && body.answer === null &&
      body.confidence === undefined && /provisional/i.test(body.notice || ""),
    JSON.stringify(body));
}


/* ---- unregistered live corpus rows are a coverage gap, not a clean no-match ---- */
{
  const { body } = await think(mkEnv({ coverageRows: [{
    name: "drive", kind: "unregistered", status: "unregistered", registered: 0,
    document_count: 4, last_ingest_at: null, expected_refresh_seconds: null,
    last_complete_sweep_at: null, indexing_started_at: null,
  }] }));
  const gapText = (body.gaps || []).map((gap) => gap.detail).join(" ");
  check("a healthy no-match names the missing source-registry authority",
    body.gaps?.some((gap) => gap.type === "source_unregistered"), JSON.stringify(body.gaps));
  check("an unregistered source replaces categorical absence and confidence",
    body.status === COVERAGE_INCOMPLETE && body.answer === null &&
      body.confidence === undefined && !body.gaps?.some((gap) => gap.type === "no_results") &&
      !assertsAbsence(gapText), JSON.stringify(body));
}

/* ---- a failed source-coverage read is an explicit unknown, never an empty list ---- */
{
  const { body } = await think(mkEnv({ coverageUnavailable: true }));
  const gapText = (body.gaps || []).map((gap) => gap.detail).join(" ");
  check("a healthy no-match names unavailable source coverage",
    body.gaps?.some((gap) => gap.type === "coverage_unavailable"), JSON.stringify(body.gaps));
  check("unavailable coverage cannot survive as a no-results claim",
    !body.gaps?.some((gap) => gap.type === "no_results") && !assertsAbsence(gapText), gapText);
  check("an unavailable coverage read has the same fail-closed wire contract",
    body.status === COVERAGE_INCOMPLETE && body.answer === null &&
      body.confidence === undefined && /could not be checked/i.test(body.notice || ""),
    JSON.stringify(body));
}

/* ---- /unified carries the same distinction on its own shape ---- */
{
  const { body: broken } = await unified(mkEnv({ projectionReady: false }));
  check("unified marks zero rows during pending projection as provisional coverage",
    broken.results.length === 0 && broken.status === COVERAGE_INCOMPLETE &&
      broken.gaps?.some((gap) => gap.type === "keyword_only_indexing"),
    JSON.stringify(broken).slice(0, 200));
  check("unified's notice does not assert an absence",
    typeof broken.notice === "string" && !assertsAbsence(broken.notice), String(broken.notice));

  const { body: healthy } = await unified(mkEnv({}));
  check("a healthy zero-row unified response gains no status",
    healthy.results.length === 0 && healthy.status === undefined && healthy.notice === undefined,
    JSON.stringify(healthy).slice(0, 200));
}

/* ---- /unified also qualifies healthy retrieval by declared source history ---- */
{
  const { body } = await unified(mkEnv({ coverageRows: [{
    name: "gmail", kind: "gmail", status: "ready", document_count: 66000,
    last_ingest_at: new Date().toISOString(), expected_refresh_seconds: null,
    last_complete_sweep_at: null, indexing_started_at: null,
  }] }));
  check("unified marks partial source history instead of reporting a completed no-match",
    body.status === COVERAGE_INCOMPLETE &&
      body.gaps?.some((gap) => gap.type === "history_unproven") &&
      /provisional/i.test(body.notice || ""), JSON.stringify(body));
}

{
  const { body } = await unified(mkEnv({ coverageRows: [{
    name: "legacy-import", kind: "unregistered", status: "unregistered", registered: 0,
    document_count: 4, last_ingest_at: null, expected_refresh_seconds: null,
    last_complete_sweep_at: null, indexing_started_at: null,
  }] }));
  check("unified keeps unregistered live records visible as a coverage gap",
    body.status === COVERAGE_INCOMPLETE &&
      body.gaps?.some((gap) => gap.type === "source_unregistered") &&
      !assertsAbsence(proseOf(body)), JSON.stringify(body));
}

{
  const { body } = await unified(mkEnv({ coverageUnavailable: true }));
  check("unified fails closed when source coverage itself cannot be read",
    body.status === COVERAGE_INCOMPLETE &&
      body.gaps?.some((gap) => gap.type === "coverage_unavailable") &&
      /could not be checked/i.test(body.notice || ""), JSON.stringify(body));
}

/* ---- the shared rule, including the version-skew defence ---- */
{
  const healthy = emptyRetrievalDisclosure(null);
  check("the disclosure for a healthy empty search is exactly the old gap",
    healthy.unavailable === false && healthy.gaps.length === 1 &&
      healthy.gaps[0].detail === NO_RESULTS_GAP.detail, JSON.stringify(healthy));

  check("an unrecognised degradation still refuses to mean absence",
    emptyRetrievalDisclosure("something-new-in-2027").unavailable === true &&
      !assertsAbsence(unavailableNotice("something-new-in-2027")),
    unavailableNotice("something-new-in-2027"));
  check("the unavailable notice states the non-empty conclusion in the right direction",
    /This does not mean your brain is empty/.test(unavailableNotice("vector")) &&
      !/Nothing here means your brain is empty/.test(unavailableNotice("vector")),
    unavailableNotice("vector"));
  check("and its cause names the unknown subsystem rather than guessing",
    /reported "something-new-in-2027"/.test(degradedCause("something-new-in-2027")),
    String(degradedCause("something-new-in-2027")));

  // A client can be newer than the worker it talks to. A pre-fix worker sends
  // `degraded` and the old gap; the client must still refuse to state absence.
  check("VERSION SKEW: an old worker's body is still recognised as unavailable",
    retrievalUnavailable({ degraded: "vector", answer: null, citations: [], results: [],
      gaps: [NO_RESULTS_GAP] }) === true);
  check("a degraded response that DID return evidence is not unavailable",
    retrievalUnavailable({ degraded: "vector", answer: null, citations: [], results: [{ title: "x" }] }) === false);
  check("an answered degraded response is not unavailable",
    retrievalUnavailable({ degraded: "vector", answer: "Something [1].", citations: [{ n: 1 }], results: [] }) === false);
  check("coverage-incomplete wins over the legacy degraded fallback",
    retrievalUnavailable({
      status: COVERAGE_INCOMPLETE, degraded: "vector", degraded_reason: "projection-catching-up",
      answer: null, citations: [], results: [],
    }) === false);
  check("a malformed body is not unavailable", retrievalUnavailable(null) === false);
}

/* ---- the CLI, the fourth consumer of this path ---- */
{
  const sandbox = mkdtempSync(join(tmpdir(), "brain-degraded-ask-"));
  try {
    const manifest = join(sandbox, "brain.manifest.json");
    writeFileSync(manifest, JSON.stringify({
      client: { slug: "fixture" },
      brain: { domain: "fixture.example", worker_name: "fixture-brain" },
      infrastructure: { cloudflare: { account_id: "not-needed-with-a-domain" } },
    }));
    const printed = [];
    const realLog = console.log;
    console.log = (...a) => printed.push(a.join(" "));
    try {
      await cmdAsk(manifest, {
        ask: async () => "What do my records say?",
        adminKey: `fixture-${"k".repeat(40)}`,
        http: async () => new Response(JSON.stringify({
          mode: "think", degraded: "vector", status: SEARCH_UNAVAILABLE,
          notice: unavailableNotice("vector"),
          meaning_search: {
            visible: 12_400,
            total: 48_000,
            line: "Meaning search covers 12,400 of 48,000 chunks; keyword search covers all",
          },
          next_action: WORKER_NEXT_ACTIONS[2][2],
          answer: null, citations: [], results: [],
          gaps: [{ type: SEARCH_UNAVAILABLE, detail: "x" }],
        }), { status: 200, headers: { "content-type": "application/json" } }),
      });
    } finally { console.log = realLog; }
    const out = printed.join("\n");
    check("CLI: an unavailable search does not print the refusal sentence",
      !/The documents do not answer the question/.test(out), out);
    check("CLI: it prints the notice instead", /could not be completed/i.test(out), out);
    check("CLI: it prints exact meaning-search counts instead of the vector degradation token",
      /Meaning search covers 12,400 of 48,000 chunks; keyword search covers all/.test(out) &&
        !/search is degraded: vector/.test(out), out);
    check("CLI: Next follows the refusal explanation verbatim",
      out.includes(WORKER_NEXT_ACTIONS[2][2]), out);
    check("CLI: it does not print a confidence-in-absence line",
      !/Confidence nothing is recorded/.test(out), out);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ---- answer withholding reaches the unchanged CLI renderer honestly ---- */
{
  const sandbox = mkdtempSync(join(tmpdir(), "brain-withheld-ask-"));
  try {
    const manifest = join(sandbox, "brain.manifest.json");
    writeFileSync(manifest, JSON.stringify({
      client: { slug: "fixture" },
      brain: { domain: "fixture.example", worker_name: "fixture-brain" },
      infrastructure: { cloudflare: { account_id: "not-needed-with-a-domain" } },
    }));
    const printed = [];
    const realLog = console.log;
    console.log = (...a) => printed.push(a.join(" "));
    try {
      await cmdAsk(manifest, {
        ask: async () => "How much is the monthly payment?",
        adminKey: `fixture-${"k".repeat(40)}`,
        http: async () => new Response(JSON.stringify({
          mode: "think", status: ANSWER_WITHHELD,
          notice: answerWithheldNotice("money_check"),
          answer: null,
          confidence: { percent: 77, band: "moderate", basis: ["must not print"] },
          evidence_gate: { supported: false, reason: "amount did not match its cited span" },
          citations: [], results: [{ title: "Synthetic payment record" }], gaps: [],
        }), { status: 200, headers: { "content-type": "application/json" } }),
      });
    } finally { console.log = realLog; }
    const out = printed.join("\n");
    check("CLI: answer_withheld prints the reviewed notice",
      /money evidence check/i.test(out), out);
    check("CLI: answer_withheld prints Why from evidence_gate",
      /Why.*amount did not match its cited span/is.test(out), out);
    check("CLI: answer_withheld prints no confidence percentage",
      !/77%/.test(out), out);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ---- the CLI also gives source coverage priority over a categorical refusal ---- */
{
  const sandbox = mkdtempSync(join(tmpdir(), "brain-coverage-ask-"));
  try {
    const manifest = join(sandbox, "brain.manifest.json");
    writeFileSync(manifest, JSON.stringify({
      client: { slug: "fixture" },
      brain: { domain: "fixture.example", worker_name: "fixture-brain" },
      infrastructure: { cloudflare: { account_id: "not-needed-with-a-domain" } },
    }));
    const printed = [];
    const realLog = console.log;
    console.log = (...a) => printed.push(a.join(" "));
    try {
      await cmdAsk(manifest, {
        ask: async () => "Do my records contain this?",
        adminKey: `fixture-${"k".repeat(40)}`,
        http: async () => new Response(JSON.stringify({
          mode: "think", status: COVERAGE_INCOMPLETE,
          notice: coverageIncompleteNotice(false, true),
          answer: "The documents do not answer the question.",
          confidence: { percent: 99, band: "high", basis: ["fixture"] },
          evidence_gate: { supported: false, reason: "candidate did not support the claim" },
          citations: [], results: [{ title: "Candidate" }],
          gaps: [{ type: "history_unproven", source: "gmail", detail: "Gmail history is still loading." }],
        }), { status: 200, headers: { "content-type": "application/json" } }),
      });
    } finally { console.log = realLog; }
    const out = printed.join("\n");
    check("CLI: incomplete coverage prints the provisional notice before any categorical refusal",
      /found candidate records/i.test(out) && /provisional/i.test(out) &&
        !/The documents do not answer the question/.test(out), out);
    check("CLI: incomplete coverage suppresses confidence in absence",
      !/Confidence nothing is recorded/.test(out) && !/99%/.test(out), out);
    check("CLI: incomplete coverage still explains the evidence-gate refusal",
      /candidate did not support the claim/.test(out), out);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* (c) the MCP surface — spawned for real, against a stub brain        */
/* ------------------------------------------------------------------ */

async function mcpCall(responder, toolCalls) {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = responder(req.url, raw ? JSON.parse(raw) : {});
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const child = spawn(process.execPath, [join(ROOT, "components", "brain-mcp.mjs")], {
    env: {
      ...process.env,
      BRAIN_URL: `http://127.0.0.1:${port}`,
      BRAIN_KEY: `fixture-${"k".repeat(40)}`,
      BRAIN_NAME: "fixture",
      BRAIN_MANIFEST: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const lines = [];
  let buf = "";
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) lines.push(JSON.parse(line));
    }
  });

  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" },
  }) + "\n");
  toolCalls.forEach((tc, i) => {
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: i + 2, method: "tools/call", params: tc,
    }) + "\n");
  });
  child.stdin.end();

  await new Promise((resolve) => child.on("exit", resolve));
  await new Promise((resolve) => server.close(resolve));
  return lines;
}

const EMPTY_DEGRADED_THINK = {
  mode: "think", degraded: "vector", status: SEARCH_UNAVAILABLE,
  notice: unavailableNotice("vector"),
  meaning_search: {
    visible: 12_400,
    total: 48_000,
    line: "Meaning search covers 12,400 of 48,000 chunks; keyword search covers all",
  },
  next_action: WORKER_NEXT_ACTIONS[2][2],
  answer: null, citations: [], results: [],
  gaps: [{ type: SEARCH_UNAVAILABLE, detail: "the search could not be completed" }],
};

/* Coverage-incomplete is distinct from both a failed search and a proven empty
   result. A categorical answer from an older or buggy worker must not survive
   the current MCP boundary. */
{
  const lines = await mcpCall(
    (url) => ({
      mode: "think", status: COVERAGE_INCOMPLETE,
      notice: coverageIncompleteNotice(false, true),
      answer: "The documents do not answer the question.",
      confidence: { percent: 99, band: "high", basis: ["fixture"] },
      evidence_gate: { supported: false, reason: "candidate did not support the claim" },
      citations: [],
      results: [{ source: "client-mail", source_kind: "gmail", source_id: "m-1", title: "Candidate", snippet: "possible match" }],
      gaps: [{ type: "history_unproven", source: "gmail", detail: "Gmail history is still loading." }],
    }),
    [
      { name: "brain_think", arguments: { q: "do my records contain this" } },
      { name: "brain_search", arguments: { q: "do my records contain this" } },
    ],
  );
  const thought = JSON.parse(lines.find((line) => line.id === 2).result.content[0].text);
  check("MCP: incomplete coverage nulls a categorical answer and its confidence",
    thought.search_status === COVERAGE_INCOMPLETE && thought.answer === null &&
      thought.confidence === undefined, JSON.stringify(thought));
  check("MCP: candidate evidence survives while the note stays provisional",
    thought.results?.length === 1 && /found candidate records/i.test(thought.note || "") &&
      /provisional/i.test(thought.note || "") && !/zero-match/i.test(thought.note || ""),
    JSON.stringify(thought));
  const searched = JSON.parse(lines.find((line) => line.id === 3).result.content[0].text);
  check("MCP brain_search carries coverage status, gaps, and connector kind",
    searched.search_status === COVERAGE_INCOMPLETE &&
      searched.gaps?.some((gap) => gap.type === "history_unproven") &&
      searched.results?.[0]?.source_kind === "gmail" &&
      /provisional/i.test(searched.note || ""), JSON.stringify(searched));
}

{
  const lines = await mcpCall(
    (url) => (url.includes("/think")
      ? EMPTY_DEGRADED_THINK
      : { mode: "unified", degraded: "vector", status: SEARCH_UNAVAILABLE,
        notice: unavailableNotice("vector"), results: [] }),
    [
      { name: "brain_think", arguments: { q: "what do my records say" } },
      { name: "brain_search", arguments: { q: "records" } },
    ],
  );

  const init = lines.find((l) => l.id === 1);
  check("MCP: the server instructions name the degraded exception",
    /search_unavailable/.test(init?.result?.instructions || "") &&
      /the search did not complete/i.test(init?.result?.instructions || ""),
    String(init?.result?.instructions || "").slice(0, 200));

  const thought = JSON.parse(lines.find((l) => l.id === 2).result.content[0].text);
  check("MCP brain_think: degraded reaches the client's model",
    thought.degraded === "vector", JSON.stringify(thought).slice(0, 200));
  check("MCP brain_think: search_status is carried",
    thought.search_status === "search_unavailable", JSON.stringify(thought.search_status));
  check("THE DEFECT AT THE MCP LAYER: no absence instruction in the note",
    typeof thought.note === "string" && !assertsAbsence(thought.note), String(thought.note));
  check("MCP brain_think: the note tells the model what actually happened",
    /could not be completed/i.test(thought.note), String(thought.note));
  check("MCP brain_think: exact meaning-search counts pass through",
    thought.meaning_search?.line ===
      "Meaning search covers 12,400 of 48,000 chunks; keyword search covers all",
    JSON.stringify(thought.meaning_search));
  check("MCP brain_think: the exact next action passes through",
    thought.next_action === WORKER_NEXT_ACTIONS[2][2], String(thought.next_action));

  const searched = JSON.parse(lines.find((l) => l.id === 3).result.content[0].text);
  check("MCP brain_search: degraded reaches the client's model",
    searched.degraded === "vector" && searched.search_status === "search_unavailable",
    JSON.stringify(searched).slice(0, 200));
  check("MCP brain_search: zero hits during a degraded search is not 'nothing recorded'",
    typeof searched.note === "string" && !assertsAbsence(searched.note), String(searched.note));
}

/* An MCP pointed at a worker that predates this fix: `degraded` but the old
   gap and no status. The client must still not relay an absence. */
{
  const lines = await mcpCall(
    (url) => (url.includes("/think")
      ? { mode: "think", degraded: "vector", answer: null, citations: [], results: [],
        gaps: [NO_RESULTS_GAP] }
      : { mode: "unified", degraded: "vector", results: [] }),
    [
      { name: "brain_think", arguments: { q: "what do my records say" } },
      { name: "brain_search", arguments: { q: "records" } },
    ],
  );
  const thought = JSON.parse(lines.find((l) => l.id === 2).result.content[0].text);
  check("VERSION SKEW at the MCP: an old worker's no_results gap is replaced, not relayed",
    !thought.gaps.some((g) => g.type === "no_results") &&
      thought.gaps.some((g) => g.type === SEARCH_UNAVAILABLE), JSON.stringify(thought.gaps));
  check("VERSION SKEW at the MCP: and no absence instruction reaches the model",
    !assertsAbsence(proseOf(thought)), proseOf(thought));

  const searched = JSON.parse(lines.find((l) => l.id === 3).result.content[0].text);
  check("VERSION SKEW at the MCP: brain_search is protected the same way",
    !assertsAbsence(proseOf(searched)), proseOf(searched));
}

/* MCP against a HEALTHY brain: the honest refusal must survive intact. */
{
  const lines = await mcpCall(
    (url) => (url.includes("/think")
      ? { mode: "think", answer: null, citations: [], results: [], gaps: [NO_RESULTS_GAP],
        confidence: { percent: 80, band: "high", basis: ["retrieval found no candidates at all"] } }
      : { mode: "unified", results: [] }),
    [
      { name: "brain_think", arguments: { q: "a question about nothing" } },
      { name: "brain_search", arguments: { q: "nothing" } },
    ],
  );
  const thought = JSON.parse(lines.find((l) => l.id === 2).result.content[0].text);
  check("REGRESSION GUARD at the MCP: a healthy empty answer scopes its finding to this search",
    thought.note === 'No match in this search. Search again with different wording, or sort "newest" for status, before saying "I didn\'t find a matching record in these searches". Name both searches and the next place you would check (another source, a wider date window, or a distinctive name or number). Do not turn those searches into a claim that no such record exists. Say nothing is recorded only when a response explicitly establishes a complete search. Do not substitute inference.' &&
      thought.gaps.some((g) => g.type === "no_results"), JSON.stringify(thought));
  check("REGRESSION GUARD at the MCP: healthy empty think makes no global absence claim",
    !assertsAbsence(proseOf(thought)), proseOf(thought));
  check("REGRESSION GUARD at the MCP: no degraded or status is invented",
    thought.degraded === undefined && thought.search_status === undefined, JSON.stringify(thought));

  const searched = JSON.parse(lines.find((l) => l.id === 3).result.content[0].text);
  check("REGRESSION GUARD at the MCP: healthy brain_search keeps its honest note",
    searched.note === 'No hits in this search. This is not proof that no such record exists. Search again with different wording, or sort "newest" for status, before saying "I didn\'t find a matching record in these searches". Name both searches and the next place you would check.', String(searched.note));
  check("REGRESSION GUARD at the MCP: healthy empty search makes no global absence claim",
    !assertsAbsence(proseOf(searched)), proseOf(searched));
}

/* ---- the /app page renders the notice, not the refusal ---- */
/* These call the REAL shipped functions, which is the point: an earlier
   version grepped the source for a pattern and would have passed with the
   branch disabled by `false &&`.

   They used to be lifted out of the served HTML by sentinel comments, because
   the page was hand-written JavaScript inside a template string. The app is now
   a built bundle, so there is no page to lift them from; they live in
   answer-render.js, which the Worker page and the React app both import. The
   assertions below are unchanged, and the mechanism is stricter than before:
   this imports the module the product actually runs rather than re-evaluating
   a copy of it. */
{
  const render = await import("../src/lib/answer-render.js");
  check("/app exposes its render contract to this test",
    typeof render.answerText === "function" && typeof render.confidenceText === "function" &&
      typeof render.unavailableSearch === "function",
    "answer-render.js must export the three render functions");

  const degradedBody = {
    status: SEARCH_UNAVAILABLE, degraded: "vector", notice: unavailableNotice("vector"),
    answer: null, citations: [], results: [],
    // A current worker omits this. An older one sends it, and rendering it
    // would put a percentage on an absence nobody measured, so the page has to
    // suppress it rather than trust the field's presence.
    confidence: { percent: 58, band: "moderate", basis: ["vector index not fully query-ready"] },
  };
  check("/app: a degraded empty result does NOT render the refusal sentence",
    !/The documents do not answer the question/.test(render.answerText(degradedBody)),
    render.answerText(degradedBody));
  check("/app: it renders the notice instead",
    /could not be completed/i.test(render.answerText(degradedBody)), render.answerText(degradedBody));
  check("/app: and asserts no absence",
    !assertsAbsence(render.answerText(degradedBody)), render.answerText(degradedBody));
  check("/app: the confidence line does not claim confidence in an absence",
    !/Confidence nothing is recorded/.test(render.confidenceText(degradedBody)),
    render.confidenceText(degradedBody));

  const coverageBody = {
    status: COVERAGE_INCOMPLETE,
    notice: coverageIncompleteNotice(false, true),
    answer: "The documents do not answer the question.",
    confidence: { percent: 99, band: "high", basis: ["fixture"] },
    results: [{ title: "Candidate" }],
  };
  check("/app: incomplete coverage takes priority over a categorical answer",
    render.answerText(coverageBody) === coverageBody.notice &&
      !/The documents do not answer the question/.test(render.answerText(coverageBody)),
    render.answerText(coverageBody));
  check("/app: incomplete coverage renders provisional trust instead of a percentage",
    /provisional/i.test(render.confidenceText(coverageBody)) &&
      !/99%/.test(render.confidenceText(coverageBody)),
    render.confidenceText(coverageBody));

  const rawProviderFailure = "Workers AI request failed with private upstream trace fixture-123";
  check("/app: an older Worker's raw model error is replaced with reviewed copy",
    render.answerText({ answer: null, answer_error: rawProviderFailure }) ===
      render.ANSWER_ERROR_MESSAGES.unavailable &&
      !render.answerText({ answer: null, answer_error: rawProviderFailure }).includes(rawProviderFailure),
    render.answerText({ answer: null, answer_error: rawProviderFailure }));
  check("/app: a reviewed model error keeps its specific recovery message",
    render.answerText({ answer: null, answer_error: render.ANSWER_ERROR_MESSAGES.dailyLimit }) ===
      render.ANSWER_ERROR_MESSAGES.dailyLimit,
    render.answerText({ answer: null, answer_error: render.ANSWER_ERROR_MESSAGES.dailyLimit }));

  // Version skew again: a page cached from a newer worker, talking to an older
  // one that sends `degraded` but no status or notice.
  const oldWorkerBody = { degraded: "vector", answer: null, citations: [], results: [] };
  check("/app: an older worker's degraded empty body still avoids the refusal sentence",
    !/The documents do not answer the question/.test(render.answerText(oldWorkerBody)),
    render.answerText(oldWorkerBody));

  const healthyEmpty = {
    answer: null, citations: [], results: [],
    confidence: { percent: 80, band: "high", basis: ["retrieval found no candidates at all"] },
  };
  check("REGRESSION GUARD at /app: a healthy empty result keeps its search scope",
    render.answerText(healthyEmpty) === "I didn't find a matching record in this search.",
    render.answerText(healthyEmpty));
  check("REGRESSION GUARD at /app: labels its confidence in this search result",
    /^Confidence in this search result: 80%/.test(render.confidenceText(healthyEmpty)),
    render.confidenceText(healthyEmpty));

  const answered = {
    answer: "The retainer was deferred [1].", citations: [{ n: 1 }], results: [{ title: "x" }],
    confidence: { percent: 75, band: "moderate", basis: ["evidence gate approved 1 citation"] },
  };
  check("REGRESSION GUARD at /app: a real answer is untouched",
    render.answerText(answered) === answered.answer &&
      /^Confidence: 75%/.test(render.confidenceText(answered)),
    render.confidenceText(answered));
}

console.log(`\ndegraded absence: ${ran - fail}/${ran} checks passed`);
if (fail) process.exit(1);
