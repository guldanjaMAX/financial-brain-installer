import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeRefusal } from "../../eval/scorer.mjs";
import { REFUSAL_NEXT_ACTIONS, absenceUnproven } from "../src/lib/retrieval-status.js";
import { coverageGapReport } from "../src/lib/store-d1.js";
import { createProductFixture } from "./product-contract-fixture.mjs";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const record = (content, {
  source = "records",
  kind = "gmail",
  date = "2026-10-10",
  dateSource = "fixture:record_date",
} = {}) => ({ content, source, kind, date, dateSource });

const quickBooksCandidate = record(
  "QuickBooks Invoice. Customer: Payer North. Total: USD 120.00. Transaction Date: 2026-10-10.",
  { source: "books", kind: "quickbooks", dateSource: "quickbooks:provider_timestamp" },
);

async function runThink(t, {
  question,
  records,
  drafts,
  verifierReplies = null,
  projection = null,
  readAdmin = false,
  empty = false,
} = {}) {
  t.mock.method(Date, "now", () => NOW);
  let draftCalls = 0;
  let verifierCalls = 0;
  let searches = 0;
  let network = 0;
  const documentNumbers = new Map();
  const replies = Array.isArray(drafts) ? drafts : [drafts];
  const render = (text) => String(text).replace(/\[r(\d+)\]/g, (_, index) => {
    const n = documentNumbers.get(Number(index));
    assert.ok(Number.isInteger(n), `record ${index} was not rendered into the model prompt`);
    return `[${n}]`;
  });
  t.mock.method(globalThis, "fetch", async () => {
    network++;
    throw new Error("network forbidden");
  });

  const fixture = await createProductFixture({ env: { AI: { async run(model, input) {
    if (String(model).includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
    const system = String(input.messages?.[0]?.content || "");
    const prompt = String(input.messages?.at(-1)?.content || "");
    if (system.includes("verify a proposed answer")) {
      const reply = verifierReplies?.[verifierCalls] ?? verifierReplies?.at(-1);
      verifierCalls++;
      if (reply instanceof Error) throw reply;
      if (reply !== undefined && reply !== null) return { response: reply };
      const proposed = /PROPOSED ANSWER:\n([\s\S]*?)\n\nCITED DOCUMENTS:/.exec(prompt)?.[1] || "";
      const evidence = [...new Set([...proposed.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])))];
      return { response: { supported: true, complete: true, evidence, conflicts: [], reason: "synthetic support" } };
    }
    draftCalls++;
    records.forEach((row, index) => {
      const at = prompt.indexOf(row.content);
      if (at < 0) return;
      const preceding = [...prompt.slice(0, at).matchAll(/^\[(\d+)\] \(/gm)];
      documentNumbers.set(index, Number(preceding.at(-1)?.[1]));
    });
    return { response: render(replies[Math.min(draftCalls - 1, replies.length - 1)]) };
  } } } });

  try {
    for (const row of records) {
      fixture.raw(
        "INSERT OR IGNORE INTO sources(name,kind,status,created_at,last_ingest_at,last_complete_sweep_at,expected_refresh_seconds) VALUES (?,?, 'ready','2026-10-10','2026-10-12T12:00:00Z','2026-10-12T12:00:00Z',86400)",
        row.source,
        row.kind,
      );
    }
    for (let index = 0; index < records.length; index++) {
      const row = records[index];
      const response = await fixture.post("/api/admin/brain/ingest/batch", { docs: [{
        source_type: row.source,
        source_id: `record-${index}`,
        title: `Synthetic record ${index}`,
        content: row.content,
        occurred_at: row.date,
        date_reliable: true,
        date_source: row.dateSource,
        text_source: "native",
        text_reliable: true,
        metadata: { evidence_lineage: { version: 1, kind: "source_record" } },
      }] }, { "X-Admin-Key": fixture.env.ADMIN_KEY });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).results[0].status, "created");
    }
    fixture.raw("DELETE FROM vector_outbox");
    const storedVectorCount = fixture.first("SELECT COUNT(*) AS n FROM chunks").n;
    const expectedVectorCount = projection?.expected ?? storedVectorCount;
    const actualVectorCount = projection?.actual ?? storedVectorCount;
    const projectionStatus = projection?.status ?? "verified";
    fixture.raw(
      "UPDATE install_state SET vector_projection_status=?, vector_projection_bootstrap_base_count=?, vector_projection_mutation_id=NULL, vector_projection_submitted_at=NULL WHERE id=1",
      projectionStatus,
      expectedVectorCount,
    );
    if ((projection?.pending ?? 0) > 0) {
      const chunk = fixture.first("SELECT chunk_uid, vector_id FROM chunks LIMIT 1");
      fixture.raw(
        "INSERT INTO vector_outbox (chunk_uid,vector_id,op,queued_at) VALUES (?,?, 'upsert',?)",
        chunk.chunk_uid,
        chunk.vector_id,
        NOW,
      );
    }
    fixture.env.VECTORIZE.describe = async () => ({
      vectorCount: actualVectorCount,
      processedUpToMutation: null,
    });
    fixture.env.VECTORIZE.query = async () => {
      searches++;
      return { matches: empty ? [] : fixture.rows("SELECT chunk_uid AS id FROM chunks") };
    };
    const response = await fixture.post("/api/rag/think", { q: question }, {
      "X-Admin-Key": fixture.env.ADMIN_KEY,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(searches > 0, "the real retrieval decision was reached");
    if (!empty) {
      assert.ok(body.results.length > 0, "stored evidence was retrieved");
      assert.ok(draftCalls > 0, "the real draft decision was reached");
    }
    assert.equal(network, 0, "no external fetch was attempted");
    let adminBody = null;
    if (readAdmin) {
      const adminResponse = await fixture.worker.fetch(new Request("https://brain.invalid/api/admin/brain/documents", {
        headers: { "X-Admin-Key": fixture.env.ADMIN_KEY },
      }), fixture.env, { waitUntil() {}, passThroughOnException() {} });
      assert.equal(adminResponse.status, 200);
      adminBody = await adminResponse.json();
    }
    return { body, adminBody, draftCalls, verifierCalls, render };
  } finally {
    fixture.close();
  }
}

for (const scenario of [
  {
    label: "final order date",
    question: "When was the final order entered?",
    evidence: "The final order was entered on 2026-10-10.",
    draft: "The final order was entered on 2026-10-10 [r0].",
  },
  {
    label: "maintenance terms",
    question: "What are the maintenance terms in the order?",
    evidence: "The final maintenance order requires quarterly inspection.",
    draft: "The order requires quarterly inspection [r0].",
  },
  {
    label: "client contract delivery",
    question: "What does the client contract say about delivery?",
    evidence: "The final client contract requires delivery at the north entrance.",
    draft: "The client contract requires delivery at the north entrance [r0].",
  },
  {
    label: "meeting topics",
    question: "What topics did the team meeting cover?",
    evidence: "The team meeting covered staffing and delivery timing.",
    draft: "The team meeting covered staffing and delivery timing [r0].",
  },
]) test(`AR-01 answers a non-money ${scenario.label} question despite a QuickBooks candidate`, async (t) => {
  const result = await runThink(t, {
    question: scenario.question,
    records: [record(scenario.evidence), quickBooksCandidate],
    drafts: scenario.draft,
  });
  assert.equal(result.body.answer, result.render(scenario.draft), result.body.evidence_gate?.reason);
  assert.equal(result.body.evidence_gate?.supported, true);
  assert.equal(result.draftCalls, 1);
  assert.equal(result.verifierCalls, 1, "the supporting draft reached the verifier");
});

test("AR-01 refuses a past date presented as the next site visit", async (t) => {
  const evidence = "Vendor North's site visit occurred on 2026-10-11, and the visit fee is paid.";
  const result = await runThink(t, {
    question: "When is my next site visit with Vendor North?",
    records: [record(evidence)],
    drafts: "The next site visit with Vendor North is 2026-10-11, and the visit fee is paid [r0].",
  });
  assert.equal(result.body.answer, null);
  assert.equal(result.body.evidence_gate?.supported, false);
  assert.equal(result.draftCalls, 1);
  assert.equal(result.verifierCalls, 1, "the temporal refusal followed verification");
  assert.ok(result.body.gaps.some((gap) => gap.type === "temporal_conflict"));
  assert.equal(result.body.next_action, REFUSAL_NEXT_ACTIONS["answer_withheld:date_check"]);
});

test("AR-01 control: how much keeps the money checks", async (t) => {
  const result = await runThink(t, {
    question: "How much is the monthly payment?",
    records: [record("The monthly payment is USD 120.00.")],
    drafts: "The monthly payment is USD 121.00 [r0].",
  });
  assert.equal(result.body.answer, null);
  assert.equal(result.body.evidence_gate?.supported, false);
  assert.ok(result.draftCalls >= 1, "the draft decision was reached");
  assert.equal(result.verifierCalls, 1, "the money refusal followed verification");
  assert.ok(result.body.gaps.some((gap) => gap.type === "money_veto"));
  assert.equal(result.body.next_action, REFUSAL_NEXT_ACTIONS["answer_withheld:money_check"]);
});

test("AR-01 mutation guard: how much alone identifies a money question", async (t) => {
  const result = await runThink(t, {
    question: "How much is it?",
    records: [record("The total is USD 120.00.")],
    drafts: "It is USD 121.00 [r0].",
  });
  assert.equal(result.body.answer, null);
  assert.equal(result.body.evidence_gate?.supported, false);
  assert.equal(result.draftCalls, 1, "the draft decision was reached");
  assert.equal(result.verifierCalls, 1, "the money refusal followed verification");
  assert.ok(result.body.gaps.some((gap) => gap.type === "money_veto"));
});

test("AR-01 control: payer-month mismatch keeps the money checks", async (t) => {
  const result = await runThink(t, {
    question: "Which months for Payer North?",
    records: [record("Payer North's payment month is October.")],
    drafts: "Payer North's payment month is September [r0].",
  });
  assert.equal(result.body.answer, null);
  assert.equal(result.body.evidence_gate?.supported, false);
  assert.ok(result.draftCalls >= 1, "the draft decision was reached");
  assert.equal(result.verifierCalls, 1, "the money refusal followed verification");
  assert.ok(result.body.gaps.some((gap) => ["money_veto", "money_recall_veto"].includes(gap.type)));
});

test("AR-01 control: a cited QuickBooks draft keeps the contract", async (t) => {
  const result = await runThink(t, {
    question: "When was the final order entered?",
    records: [quickBooksCandidate],
    drafts: "The final order was entered on 2026-10-10 for USD 999.00 [r0].",
  });
  assert.equal(result.body.answer, null);
  assert.equal(result.body.evidence_gate?.supported, false);
  assert.equal(result.draftCalls, 1);
  assert.equal(result.verifierCalls, 1, "the cited QuickBooks draft reached the verifier");
  assert.match(result.body.evidence_gate?.reason || "", /QuickBooks money/);
});

test("AR-02 retries an uncited non-money draft once and accepts the cited repair", async (t) => {
  const cited = "The final order was entered on 2026-10-10 [r0].";
  const result = await runThink(t, {
    question: "When was the final order entered?",
    records: [record("The final order was entered on 2026-10-10.")],
    drafts: ["The final order was entered on 2026-10-10.", cited],
  });
  assert.equal(result.body.answer, result.render(cited), result.body.evidence_gate?.reason);
  assert.equal(result.draftCalls, 2, "the uncited draft reached the bounded retry decision");
  assert.equal(result.verifierCalls, 1, "the repaired draft reached verification");
});

test("AR-02 refuses after two uncited non-money drafts", async (t) => {
  const result = await runThink(t, {
    question: "When was the final order entered?",
    records: [record("The final order was entered on 2026-10-10.")],
    drafts: ["The final order was entered on 2026-10-10.", "The final order was entered on 2026-10-10."],
  });
  assert.equal(result.body.answer, null);
  assert.equal(result.body.evidence_gate?.supported, false);
  assert.match(result.body.evidence_gate?.reason || "", /draft made claims without document citations/);
  assert.equal(result.draftCalls, 2, "both allowed draft decisions were reached");
  assert.equal(result.verifierCalls, 0, "an uncited draft never reaches the verifier");
  assert.equal(result.body.next_action, REFUSAL_NEXT_ACTIONS["answer_withheld:uncited_draft"]);
});

test("AR-02 control: a cited first draft is not retried", async (t) => {
  const cited = "The final order was entered on 2026-10-10 [r0].";
  const result = await runThink(t, {
    question: "When was the final order entered?",
    records: [record("The final order was entered on 2026-10-10.")],
    drafts: cited,
  });
  assert.equal(result.body.answer, result.render(cited), result.body.evidence_gate?.reason);
  assert.equal(result.draftCalls, 1);
  assert.equal(result.verifierCalls, 1);
});

test("AR-02 control: moneyDraftRepair and citation repair share the same two-draft bound", async (t) => {
  const cited = "The monthly payment is USD 120.00 [r0].";
  const result = await runThink(t, {
    question: "How much is the monthly payment?",
    records: [record("The monthly payment is USD 120.00.")],
    drafts: ["The monthly payment is USD 120.00.", cited],
  });
  assert.equal(result.body.answer, result.render(cited), result.body.evidence_gate?.reason);
  assert.equal(result.draftCalls, 2);
  assert.ok(result.draftCalls <= 2, "repair did not create a third draft");
  assert.equal(result.verifierCalls, 1);
});

test("AR-13 retries one unreadable verifier reply and accepts valid JSON", async (t) => {
  const cited = "The final order was entered on 2026-10-10 [r0].";
  const result = await runThink(t, {
    question: "When was the final order entered?",
    records: [record("The final order was entered on 2026-10-10.")],
    drafts: cited,
    verifierReplies: ["!!!!", { supported: true, complete: true, evidence: [1], reason: "synthetic support" }],
  });
  assert.equal(result.body.answer, result.render(cited), result.body.evidence_gate?.reason);
  assert.equal(result.draftCalls, 1);
  assert.equal(result.verifierCalls, 2, "both verifier decisions were reached");
});

test("AR-13 refuses honestly after two unreadable verifier replies", async (t) => {
  const result = await runThink(t, {
    question: "When was the final order entered?",
    records: [record("The final order was entered on 2026-10-10.")],
    drafts: "The final order was entered on 2026-10-10 [r0].",
    verifierReplies: ["!!!!", "!!!!"],
  });
  assert.equal(result.body.answer, null);
  assert.equal(result.body.evidence_gate?.supported, false);
  assert.equal(result.body.evidence_gate?.complete, false);
  assert.deepEqual(result.body.evidence_gate?.evidence, []);
  assert.equal(result.body.evidence_gate?.reason, "The evidence check reply could not be read, twice.");
  assert.equal(result.body.evidence_gate?.invalid_response, "!!!!");
  assert.equal(result.body.answer_error, undefined);
  assert.equal(result.draftCalls, 1);
  assert.equal(result.verifierCalls, 2, "both verifier decisions were reached");
  assert.equal(result.body.next_action, REFUSAL_NEXT_ACTIONS["answer_withheld:unreadable_check_reply"]);
});

test("AR-13 malformed JSON twice is a gate refusal, not answer_error", async (t) => {
  const result = await runThink(t, {
    question: "When was the final order entered?",
    records: [record("The final order was entered on 2026-10-10.")],
    drafts: "The final order was entered on 2026-10-10 [r0].",
    verifierReplies: ["{\"supported\": tru", "{\"supported\": tru"],
  });
  assert.equal(result.body.answer, null);
  assert.equal(result.body.evidence_gate?.supported, false);
  assert.equal(result.body.evidence_gate?.reason, "The evidence check reply could not be read, twice.");
  assert.equal(result.body.answer_error, undefined);
  assert.equal(result.draftCalls, 1);
  assert.equal(result.verifierCalls, 2, "both malformed replies reached the gate");
});

test("AR-13 control: valid first verifier reply is not retried", async (t) => {
  const cited = "The final order was entered on 2026-10-10 [r0].";
  const result = await runThink(t, {
    question: "When was the final order entered?",
    records: [record("The final order was entered on 2026-10-10.")],
    drafts: cited,
    verifierReplies: [{ supported: true, complete: true, evidence: [1], reason: "synthetic support" }],
  });
  assert.equal(result.body.answer, result.render(cited), result.body.evidence_gate?.reason);
  assert.equal(result.draftCalls, 1);
  assert.equal(result.verifierCalls, 1);
});

test("AR-13 control: a verifier provider throw is not retried", async (t) => {
  const result = await runThink(t, {
    question: "When was the final order entered?",
    records: [record("The final order was entered on 2026-10-10.")],
    drafts: "The final order was entered on 2026-10-10 [r0].",
    verifierReplies: [new Error("synthetic verifier unavailable")],
  });
  assert.equal(result.body.answer, null);
  assert.equal(result.body.evidence_gate?.supported, false);
  assert.ok(result.body.answer_error);
  assert.equal(result.draftCalls, 1);
  assert.equal(result.verifierCalls, 1, "the provider throw was attempted once");
});

for (const status of ["verified", "pending"]) {
  test(`AR-03 treats a small provider-vector excess as query-ready while ${status}`, async (t) => {
    const cited = "The final order was entered on 2026-10-10 [r0].";
    const result = await runThink(t, {
      question: "When was the final order entered?",
      records: [record("The final order was entered on 2026-10-10.")],
      drafts: cited,
      projection: { expected: 2_000_000, actual: 2_000_150, status },
      readAdmin: true,
    });
    assert.equal(result.body.answer, result.render(cited), result.body.evidence_gate?.reason);
    assert.equal(result.draftCalls, 1);
    assert.equal(result.verifierCalls, 1, "the query-ready result reached verification");
    assert.equal(result.body.degraded, undefined);
    assert.equal(result.body.gaps.some((gap) => gap.type === "vector_unavailable"), false);
    assert.equal(result.body.confidence?.basis?.includes("vector index not fully query-ready"), false);
    assert.equal(result.adminBody.vector_readiness.ready, false);
    assert.equal(result.adminBody.vector_readiness.query_ready, true);
    assert.equal(result.adminBody.vector_readiness.reason, "vector_count_mismatch");
    assert.equal(result.adminBody.vector_readiness.provider_orphans, 150);
  });
}

for (const scenario of [
  {
    label: "an excess exactly at the ratio",
    projection: { expected: 2_000_000, actual: 2_000_200, status: "verified" },
    reason: "vector_count_mismatch",
  },
  {
    label: "a one-vector shortfall",
    projection: { expected: 2_000_000, actual: 1_999_999, status: "verified" },
    reason: "vector_count_mismatch",
  },
  {
    label: "one queued vector",
    projection: { expected: 2_000_000, actual: 2_000_150, status: "verified", pending: 1 },
    reason: "vector_work_queued",
    pendingProjection: true,
  },
  {
    label: "bootstrap-required status",
    projection: { expected: 2_000_000, actual: 2_000_150, status: "bootstrap_required" },
    reason: "projection_bootstrap_required",
    pendingProjection: true,
  },
]) test(`AR-03 control: ${scenario.label} remains degraded`, async (t) => {
  const result = await runThink(t, {
    question: "When was the final order entered?",
    records: [record("The final order was entered on 2026-10-10.")],
    drafts: "The final order was entered on 2026-10-10 [r0].",
    projection: scenario.projection,
    readAdmin: true,
  });
  assert.equal(result.draftCalls, 1, "the degraded path still reached a draft decision");
  assert.equal(result.verifierCalls, 1, "the degraded path still reached verification");
  assert.equal(result.body.degraded, "vector");
  assert.equal(result.body.gaps.some((gap) => gap.type === "keyword_only_indexing"),
    scenario.pendingProjection === true);
  assert.equal(result.body.gaps.some((gap) => gap.type === "vector_unavailable"),
    scenario.pendingProjection !== true);
  assert.equal(result.body.confidence?.basis?.includes("vector index not fully query-ready"),
    scenario.pendingProjection !== true);
  assert.equal(result.adminBody.vector_readiness.ready, false);
  assert.notEqual(result.adminBody.vector_readiness.query_ready, true);
  assert.equal(result.adminBody.vector_readiness.error, undefined);
  assert.equal(result.adminBody.vector_readiness.reason, scenario.reason);
});

test("AR-04 a degraded money-check refusal reports answer_withheld and keeps its retrieval gap", async (t) => {
  const result = await runThink(t, {
    question: "How much is the monthly payment?",
    records: [record("The monthly payment is USD 120.00.")],
    drafts: "The monthly payment is USD 121.00 [r0].",
    projection: { expected: 2, actual: 1, status: "verified" },
  });
  assert.equal(result.body.answer, null);
  assert.equal(result.body.status, "answer_withheld");
  assert.equal(result.body.confidence, undefined);
  assert.match(result.body.notice || "", /money evidence check/i);
  assert.equal(looksLikeRefusal(result.body.notice), false);
  assert.equal(result.body.evidence_gate?.supported, false);
  assert.ok(result.draftCalls >= 1, "the draft decision was reached");
  assert.equal(result.verifierCalls, 1, "the money refusal followed verification");
  const vectorGap = result.body.gaps.find((gap) => gap.type === "vector_unavailable");
  assert.ok(vectorGap);
  assert.equal(result.body.degraded_reason, "projection-count-mismatch");
  assert.match(vectorGap.detail, /brain health/);
  assert.doesNotMatch(vectorGap.detail, /finishes on its own|try again shortly/i);
});

test("AR-04 a healthy uncited draft reports answer_withheld", async (t) => {
  const result = await runThink(t, {
    question: "When was the final order entered?",
    records: [record("The final order was entered on 2026-10-10.")],
    drafts: ["The final order was entered on 2026-10-10.", "The final order was entered on 2026-10-10."],
  });
  assert.equal(result.body.answer, null);
  assert.equal(result.body.status, "answer_withheld");
  assert.equal(result.body.confidence, undefined);
  assert.match(result.body.notice || "", /did not cite/i);
  assert.equal(looksLikeRefusal(result.body.notice), false);
  assert.equal(result.body.evidence_gate?.reason, "draft made claims without document citations");
  assert.equal(result.draftCalls, 2, "both draft decisions were reached");
  assert.equal(result.verifierCalls, 0, "the citation gate stopped the verifier");
});

test("AR-04 control: model-declared no evidence on a degraded search stays search_unavailable", async (t) => {
  const result = await runThink(t, {
    question: "What color was selected?",
    records: [record("The final order was entered on 2026-10-10.")],
    drafts: "The documents do not answer the question.",
    projection: { expected: 2, actual: 1, status: "verified" },
  });
  assert.equal(result.body.answer, null);
  assert.equal(result.body.status, "search_unavailable");
  assert.equal(result.body.evidence_gate?.reason, "answer model found no direct support");
  assert.equal(result.draftCalls, 1, "the no-evidence draft decision was reached");
  assert.equal(result.verifierCalls, 0);
});

test("AR-04 control: a healthy zero-result search has only the no_results gap", async (t) => {
  const result = await runThink(t, {
    question: "What color was selected?",
    records: [record("The final order was entered on 2026-10-10.")],
    drafts: "unused",
    empty: true,
  });
  assert.equal(result.body.answer, null);
  assert.equal(result.body.status, undefined);
  assert.deepEqual(result.body.gaps.map((gap) => gap.type), ["no_results"]);
  assert.equal(result.draftCalls, 0);
  assert.equal(result.verifierCalls, 0);
});

test("AR-04 mutation guard: answer_withheld always marks absence unproven", () => {
  assert.equal(absenceUnproven({
    status: "answer_withheld",
    answer: null,
    results: [{ title: "Synthetic record" }],
  }), true);
});

const daysAgo = (days) => new Date(NOW - days * 86_400_000).toISOString();
const coverageEnv = (row) => ({
  DB: {
    prepare() {
      return {
        bind() { return this; },
        async all() { return { results: [row] }; },
      };
    },
  },
});

test("AR-15 marks an overdue Drive source held for safety review", async () => {
  const report = await coverageGapReport(coverageEnv({
    name: "drive-records",
    kind: "drive",
    status: "error",
    registered: 1,
    stale_reason: "SAFETY_REVIEW_REQUIRED",
    last_ingest_at: daysAgo(58),
    last_complete_sweep_at: daysAgo(58),
    expected_refresh_seconds: 86_400,
  }), { now: NOW });
  const gap = report.gaps.find((candidate) => candidate.type === "coverage_stale");
  assert.ok(report.gaps.some((candidate) => candidate.type === "sync_review"),
    "the operational review decision was reached");
  assert.ok(gap, "the stale coverage decision was reached");
  assert.equal(gap.held_for_review, true);
  assert.equal(gap.days_since_ingest, 58);
  assert.equal(gap.expected_every_days, 1);
  assert.match(gap.detail,
    /^The "drive-records" source is held for review\. Its last complete refresh finished 58 day\(s\) ago\. Records loaded since then may already be in the brain, but newer material is not guaranteed until the review is resolved\./);
  assert.doesNotMatch(gap.detail, /Material added since then is not in the brain/);
});

for (const scenario of [
  { label: "no stale reason", staleReason: null },
  { label: "NO_VERIFIED_WORK", staleReason: "NO_VERIFIED_WORK" },
]) test(`AR-15 control: ${scenario.label} keeps the ordinary stale text`, async () => {
  const report = await coverageGapReport(coverageEnv({
    name: "drive-records",
    kind: "drive",
    status: "ready",
    registered: 1,
    stale_reason: scenario.staleReason,
    last_ingest_at: daysAgo(58),
    last_complete_sweep_at: daysAgo(58),
    expected_refresh_seconds: 86_400,
  }), { now: NOW });
  const gap = report.gaps.find((candidate) => candidate.type === "coverage_stale");
  assert.ok(gap, "the stale coverage decision was reached");
  assert.equal(gap.held_for_review, undefined);
  assert.match(gap.detail, /Material added since then is not in the brain/);
  assert.match(gap.detail, /would not show up as a missing answer/);
});
