/**
 * The end the two sweep repairs exist for: a Brain whose only sources are
 * `imessage` and `owner-notes` must be able to finish a record review.
 *
 * On the line before these changes it could not, and neither half was the
 * owner's fault. The iMessage capture receipt hardcoded `complete_sweep:
 * false`, so the remedy the Brain printed for the gap it created ("run
 * iMessage with --reset and no --limit") could never clear it. The owner-notes
 * source — the one behind `brain_remember` — had no code path that ever wrote
 * `last_complete_sweep_at` at all. Either one alone is enough: `coverageGaps`
 * walks every row of the source registry on an unrestricted owner read, so a
 * single unprovable source attaches a `history_unproven` gap to every query,
 * `/api/rag/unified` answers `coverage_incomplete`, and `brain check` marks
 * all fourteen categories provisional.
 *
 * This runs the real route against a real migrated D1 and then hands its real
 * responses to the real `brain check` gather/partition, so a regression shows
 * up as the sentence the owner reads rather than as a column.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { coverageGapReport } from "../src/lib/store-d1.js";
import { OWNER_NOTES_ROUTE, OWNER_NOTES_SOURCE } from "../src/lib/owner-note-contract.js";
import { COVERAGE_INCOMPLETE } from "../src/lib/retrieval-status.js";
import { PROBES } from "../../operations/check-probes.mjs";
import { gather, partition } from "../../operations/check-run.mjs";
import { renderLesson, validateLesson } from "../src/lib/remember-contract.js";
import { withFirstPartySourceProvenance } from "../src/lib/provenance-receipt.js";
import { createProductFixture } from "./product-contract-fixture.mjs";

const ORIGIN = "https://brain.invalid";
const ownerHeaders = (fixture) => ({ "X-Admin-Key": fixture.env.ADMIN_KEY });

/* A vector index that actually settles. The shared fixture's stub returns no
   mutation receipt, so a drain can never finish and every search stays
   degraded — which would mask source coverage behind an unavailable search
   and prove nothing about what this file is testing. */
function settlingVectorize() {
  const stored = new Map();
  let mutation = 0;
  const receipt = () => ({ mutationId: `fixture-mutation-${mutation += 1}` });
  return {
    async query() { return { matches: [] }; },
    async upsert(rows) {
      for (const row of rows) stored.set(row.id, row);
      return receipt();
    },
    async deleteByIds(ids) {
      for (const id of ids) stored.delete(id);
      return receipt();
    },
    async getByIds(ids) {
      return ids.map((id) => stored.get(id)).filter(Boolean);
    },
    async describe() {
      return {
        vectorCount: stored.size,
        processedUpToMutation: mutation ? `fixture-mutation-${mutation}` : null,
      };
    },
  };
}

const newBrain = () => createProductFixture({ env: { VECTORIZE: settlingVectorize() } });

async function ownerNote() {
  const checked = await validateLesson({
    title: "The owner keeps quarterly reviews on Thursday mornings",
    body: "The owner said directly that quarterly reviews belong on Thursday mornings, not Fridays.",
    confidence: "verified",
    verification: "stated directly by the owner in this conversation",
  }, {
    source_type: OWNER_NOTES_SOURCE,
    written_by: "owner_assistant",
    agent_profile: "owner-assistant",
    recorded_via: "local_mcp",
  });
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));
  const value = checked.value;
  return withFirstPartySourceProvenance({
    source_type: OWNER_NOTES_SOURCE,
    source_id: value.source_id,
    title: value.title,
    content: renderLesson(value),
    metadata: {
      category: "lesson",
      written_by: "owner_assistant",
      agent_profile: "owner-assistant",
      recorded_via: "local_mcp",
      confidence: value.confidence,
      verification: value.verification,
      evidence_lineage: { version: 1, kind: "agent_derived", root_ids: value.derived_from },
    },
  }, { textSource: "native", textReliable: true });
}

/* Exactly what `brain connect imessage` then an unbounded `--reset` capture
   post, in that order: the every-minute freshness expectation, then the ready
   receipt whose counters brain.mjs measured. Nothing here is invented for the
   test; the shape is asserted against the CLI in test/imessage-ingest.test.mjs. */
async function connectAndSweepImessage(fixture) {
  const expectation = await fixture.post("/api/admin/brain/source-expectation", {
    source: "imessage", kind: "imessage", expected_refresh_seconds: 60,
  }, ownerHeaders(fixture));
  assert.equal(expectation.status, 200, await expectation.text());

  const receipt = await fixture.post("/api/admin/brain/source-receipt", {
    source: "imessage", kind: "imessage", status: "ready",
    run_id: "run_imessage_reset_walk", lane: "manual",
    walk_complete: true, complete_sweep: true,
    files_seen: 4821, docs_added: 612, docs_updated: 0, docs_unchanged: 0,
    docs_refused: 0, docs_failed: 0,
    target_range: { from: "2019-02-03T00:00:00.000Z", through: "2026-09-16T00:00:00.000Z" },
    detail: "iMessage capture: 4821 new row(s) read; 37 without text (tapbacks/attachments), " +
      "0 unusable; this Mac's local Messages database is swept complete end to end",
  }, ownerHeaders(fixture));
  assert.equal(receipt.status, 200, await receipt.text());
}

/* An owner note queues a vector projection, and an unfinished projection is
   its own retrieval gap. Drain it so what the check path sees is source
   coverage and nothing else. */
async function settleProjection(fixture) {
  const drained = await fixture.post("/api/admin/brain/drain", {}, ownerHeaders(fixture));
  assert.equal(drained.status, 200, await drained.text());
  assert.equal(fixture.first("SELECT count(*) AS n FROM vector_outbox").n, 0);
}

/* The real `brain check` search callable, pointed at the real route cmdCheck
   uses. /api/rag/unified is the strict one: /think only withholds an answer
   when the model already refused. */
const checkSearch = (fixture) => async ({ q, limit }) => {
  const response = await worker.fetch(new Request(`${ORIGIN}/api/rag/unified`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ownerHeaders(fixture) },
    body: JSON.stringify({ q, limit, rerank: 0 }),
  }), fixture.env, { waitUntil() {}, passThroughOnException() {} });
  return response.json();
};

test("a Brain whose only sources are imessage and owner-notes can finish a record review", async (t) => {
  const fixture = await newBrain();
  t.after(() => fixture.close());

  const noteResponse = await fixture.post(OWNER_NOTES_ROUTE, await ownerNote(), ownerHeaders(fixture));
  const note = await noteResponse.json();
  assert.equal(noteResponse.status, 200, JSON.stringify(note));
  await connectAndSweepImessage(fixture);
  await settleProjection(fixture);

  const sources = fixture.rows(
    "SELECT name,kind,last_complete_sweep_at FROM sources ORDER BY name",
  );
  assert.deepEqual(sources.map((row) => row.name), ["imessage", OWNER_NOTES_SOURCE]);
  for (const row of sources) {
    assert.equal(typeof row.last_complete_sweep_at, "string",
      `${row.name} recorded no completed history sweep: ${JSON.stringify(row)}`);
  }
  // The direct-write source's stamp is its own accepted write, not a borrowed one.
  assert.equal(note.source.complete_history_through,
    sources.find((row) => row.name === OWNER_NOTES_SOURCE).last_complete_sweep_at);

  const report = await coverageGapReport(fixture.env);
  assert.equal(report.unavailable, false);
  assert.deepEqual(report.gaps, [], JSON.stringify(report.gaps));

  const probed = await checkSearch(fixture)({ q: "recurring monthly amounts", limit: 25 });
  assert.notEqual(probed.status, COVERAGE_INCOMPLETE, JSON.stringify(probed).slice(0, 400));

  const gathered = await gather(checkSearch(fixture), { probes: PROBES, limit: 25 });
  const grouped = partition(gathered);
  assert.equal(gathered.length, PROBES.length);
  assert.deepEqual(grouped.provisional.map((item) => item.name), []);
  assert.deepEqual(grouped.failed.map((item) => item.name), []);
  // The exact arithmetic renderCoverageSummary prints from.
  const completed = grouped.structured.length + grouped.freeform.length;
  assert.equal(completed, PROBES.length);
  assert.equal(completed > 0 && grouped.provisional.length === 0 && grouped.failed.length === 0, true);
});

test("clearing either sweep receipt puts every check category back to provisional", async (t) => {
  const fixture = await newBrain();
  t.after(() => fixture.close());

  const noteResponse = await fixture.post(OWNER_NOTES_ROUTE, await ownerNote(), ownerHeaders(fixture));
  assert.equal(noteResponse.status, 200, await noteResponse.text());
  await connectAndSweepImessage(fixture);
  await settleProjection(fixture);

  for (const source of ["imessage", OWNER_NOTES_SOURCE]) {
    fixture.raw("UPDATE sources SET last_complete_sweep_at=NULL WHERE name=?", source);

    const report = await coverageGapReport(fixture.env);
    assert.deepEqual(
      report.gaps.filter((gap) => gap.type === "history_unproven").map((gap) => gap.source),
      [source],
      JSON.stringify(report.gaps),
    );

    const gathered = await gather(checkSearch(fixture), { probes: PROBES, limit: 25 });
    const grouped = partition(gathered);
    assert.equal(grouped.provisional.length, PROBES.length,
      `one unproven source must make all ${PROBES.length} categories provisional`);
    assert.equal(grouped.structured.length + grouped.freeform.length, 0);

    fixture.raw(
      "UPDATE sources SET last_complete_sweep_at=last_ingest_at WHERE name=?", source,
    );
  }
});
