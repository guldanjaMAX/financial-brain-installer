import assert from "node:assert/strict";

import {
  assertDrainComplete,
  buildCompletedDrainResult,
  cmdDrain,
  renderDrainProgress,
  renderCompletedDrainResult,
  summariseResponseBody,
  validateDrainBusyReceipt,
  validateDrainReceipt,
  validateReindexReceipt,
  vectorCountMismatchFailure,
} from "../brain.mjs";

let propagationCalls = 0;
const propagationSleeps = [];
const propagationResult = await cmdDrain("fixture.manifest.json", {
  loadManifest: () => ({ m: { brain: { domain: "brain.example.invalid" } } }),
  resolveBaseUrl: async () => "https://brain.example.invalid",
  resolveAdminKey: () => "fixture-key",
  now: () => propagationSleeps.reduce((sum, value) => sum + value, 0),
  sleep: async (milliseconds) => propagationSleeps.push(milliseconds),
  http: async () => {
    propagationCalls += 1;
    const body = propagationCalls === 1
      ? { error: "vector drain is paused for a verified upgrade", paused: true }
      : { drained: 0, submitted: 0, waiting: 0, remaining: 0, vector_ready: true,
          expected_vectors: 4, actual_vectors: 4 };
    return {
      status: propagationCalls === 1 ? 503 : 200,
      ok: propagationCalls !== 1,
      text: async () => JSON.stringify(body),
    };
  },
});
assert.equal(propagationCalls, 2, "the exact paused 503 must reach a second convergence request");
assert.deepEqual(propagationSleeps, [5_000]);
assert.equal(propagationResult.vector_ready, true);

/* A paused update has a different command surface from an active Brain.
 * Preserve the useful active reindex remedy, but never send a paused operator
 * to an endpoint that the verified write barrier refuses. */
const activeMismatchGuidance = vectorCountMismatchFailure(10, 4);
assert.match(activeMismatchGuidance, /brain diagnose <manifest>.*brain reindex <manifest> --yes/s);

const pausedMismatchGuidance = vectorCountMismatchFailure(10, 4, {
  pausedForUpgrade: true,
});
assert.match(pausedMismatchGuidance, /paused.*brain update <manifest>/s);
assert.match(pausedMismatchGuidance, /Read-only evidence.*brain diagnose <manifest>/s);
assert.doesNotMatch(pausedMismatchGuidance, /\n\s*brain reindex <manifest>/);

const stoppedUpdateGuidance = vectorCountMismatchFailure(10, 4, {
  pausedForUpgrade: true,
  updateStalled: true,
});
assert.match(stoppedUpdateGuidance, /already stopped the paused bootstrap.*report this update failure/s);
assert.doesNotMatch(stoppedUpdateGuidance, /Run `brain update/);

const pausedExcessGuidance = vectorCountMismatchFailure(10, 13, {
  pausedForUpgrade: true,
  updateStalled: true,
});
assert.match(pausedExcessGuidance, /provider-only excess vectors.*reviewed recovery.*clean index/s);
assert.doesNotMatch(pausedExcessGuidance, /\n\s*brain reindex <manifest>/);

const healthyNoopResult = buildCompletedDrainResult({
  drained: 0,
  submitted: 0,
  remaining: 0,
  expectedVectors: 66,
  actualVectors: 66,
});
assert.deepEqual(healthyNoopResult, {
  drained: 0,
  submitted: 0,
  remaining: 0,
  confirmed_this_run: 0,
  expected_vectors: 66,
  actual_vectors: 66,
  vector_ready: true,
});
assert.equal(
  renderCompletedDrainResult(healthyNoopResult),
  "vector index is query-ready (66 total query-visible vector(s); 0 newly confirmed this run)",
);
assert.equal(
  renderCompletedDrainResult(buildCompletedDrainResult({
    drained: 0,
    submitted: 0,
    remaining: 0,
  })),
  "vector index is query-ready (total query-visible vector count unavailable; 0 newly confirmed this run)",
);

assert.deepEqual(validateDrainBusyReceipt({
  busy: true, remaining: 7, retry_after_seconds: 3,
}), { remaining: 7, retryAfterSeconds: 3 });
for (const body of [
  null,
  { busy: false, remaining: 7, retry_after_seconds: 3 },
  { busy: true, remaining: -1, retry_after_seconds: 3 },
  { busy: true, remaining: 7, retry_after_seconds: 0 },
  { busy: true, remaining: 7, retry_after_seconds: 1201 },
]) assert.throws(() => validateDrainBusyReceipt(body), /busy|receipt|delay/i);

/* A zero-work receipt is a real, successful drain. */
assert.deepEqual(validateDrainReceipt({
  drained: 0, submitted: 0, waiting: 0, remaining: 0, vector_ready: true,
}), {
  drained: 0,
  submitted: 0,
  waiting: 0,
  remaining: 0,
  vector_ready: true,
});
assert.deepEqual(validateDrainReceipt({
  drained: 25, submitted: 0, waiting: 0, remaining: 8, vector_ready: false,
}), {
  drained: 25,
  submitted: 0,
  waiting: 0,
  remaining: 8,
  vector_ready: false,
});
assert.deepEqual(validateDrainReceipt({
  drained: 0, submitted: 8, waiting: 8, remaining: 8, vector_ready: false,
}), {
  drained: 0,
  submitted: 8,
  waiting: 8,
  remaining: 8,
  vector_ready: false,
});
assert.deepEqual(validateDrainReceipt({
  drained: 1, submitted: 1, waiting: 0, remaining: 0, vector_ready: true,
}), {
  drained: 1,
  submitted: 1,
  waiting: 0,
  remaining: 0,
  vector_ready: true,
});

/* HTTP 200 without an exact receipt must never become a green exit. */
for (const body of [null, {}, [], { drained: "1", remaining: 0 }, { drained: 1 }, { drained: -1, remaining: 0 }]) {
  assert.throws(() => validateDrainReceipt(body), /valid|receipt/i);
}
assert.throws(
  () => validateDrainReceipt({
    drained: 0, submitted: 0, waiting: 0, remaining: 7, vector_ready: false,
  }),
  /stopped making progress.*7 vector operation/s
);
assert.throws(
  () => validateDrainReceipt({
    drained: 0, submitted: 0, waiting: 0, remaining: 0, vector_ready: false,
    readiness_reason: "vector_count_mismatch", expected_vectors: 10, actual_vectors: 0,
  }),
  /Vectorize holds 0 vector\(s\).*D1 requires 10.*diagnose.*reindex/s
);
assert.throws(
  () => validateDrainReceipt({
    drained: 0, submitted: 0, waiting: 0, remaining: 0, vector_ready: false,
    readiness_reason: "vector_count_mismatch", expected_vectors: 10, actual_vectors: 13,
  }),
  /Vectorize holds 13 vector\(s\).*D1 requires 10.*provider-only excess vectors.*reindex cannot enumerate or remove.*recreate\/rebind a clean/s
);
assert.throws(
  () => validateDrainReceipt({
    drained: 0, submitted: 1, waiting: 1, remaining: 0, vector_ready: true,
  }),
  /counts do not reconcile|waiting work after the queue was empty/i
);

assert.deepEqual(assertDrainComplete({ remaining: 0, rounds: 3 }), {
  remaining: 0,
  rounds: 3,
});
assert.throws(
  () => assertDrainComplete({ remaining: 9, rounds: 400, maxRounds: 400 }),
  /400-round safety limit.*9 vector operation/s
);
assert.throws(
  () => assertDrainComplete({
    remaining: 100,
    remainingIsLowerBound: true,
    rounds: 400,
    maxRounds: 400,
  }),
  /400-round safety limit.*more than 100 vector operation/s,
);
const boundedProgress = renderDrainProgress({
  actualVectors: 1_050,
  drained: 50,
  submitted: 100,
  remaining: 10_001,
  remainingIsLowerBound: true,
  rate: 50,
});
assert.match(boundedProgress, /more than 10001 to go/);
assert.doesNotMatch(boundedProgress, /min left/);
assert.match(renderDrainProgress({
  actualVectors: 1_050,
  drained: 50,
  submitted: 100,
  remaining: 100,
  rate: 50,
}), /100 to go.*about 2 min left/);

/* An empty outbox is not a populated index (field run A: 13,869 chunks, zero
 * vectors, and a green "query-ready (0 confirmed)"). */
assert.throws(
  () => assertDrainComplete({ remaining: 0, rounds: 1, expectedVectors: 13869, actualVectors: 0 }),
  /Vectorize holds 0 vector\(s\) while D1 requires 13869.*EMPTY, not ready/s
);
assert.throws(
  () => assertDrainComplete({ remaining: 0, rounds: 1, expectedVectors: 10, actualVectors: 4 }),
  /Vectorize holds 4 vector\(s\), but D1 requires 10/s
);
assert.deepEqual(
  assertDrainComplete({ remaining: 0, rounds: 2, expectedVectors: 7, actualVectors: 7 }),
  { remaining: 0, rounds: 2 }
);
/* A corpus that requires nothing is legitimately ready at zero. */
assert.deepEqual(
  assertDrainComplete({ remaining: 0, rounds: 1, expectedVectors: 0, actualVectors: 0 }),
  { remaining: 0, rounds: 1 }
);

/* Preview and confirmation are separate contracts, including source identity. */
const preview = {
  chunks: 12,
  queued: 0,
  already_queued: 3,
  dry_run: true,
  source: null,
};
assert.equal(validateReindexReceipt(preview), preview);

const confirmed = {
  chunks: 12,
  queued: 9,
  already_queued: 3,
  pending: 12,
  dry_run: false,
  source: null,
};
assert.equal(validateReindexReceipt(confirmed, { confirm: true }), confirmed);

for (const body of [
  null,
  {},
  { ...preview, dry_run: false },
  { ...preview, queued: 1 },
  { ...preview, source: "other" },
]) {
  assert.throws(() => validateReindexReceipt(body), /reindex|receipt|source/i);
}

for (const body of [
  { ...confirmed, dry_run: true },
  { ...confirmed, pending: undefined },
  { ...confirmed, pending: 11 },
  { ...confirmed, queued: "9" },
  { ...confirmed, pending: 0, queued: 0, already_queued: 0 },
]) {
  assert.throws(
    () => validateReindexReceipt(body, { confirm: true }),
    /reindex|receipt|counts|pending/i
  );
}

const scoped = { ...confirmed, source: "documents" };
assert.equal(
  validateReindexReceipt(scoped, { confirm: true, source: "documents" }),
  scoped
);

console.log("drain/reindex exit: all focused tests passed");

/* ---------------------------------------------------------------------------
 * A clean install once exited 1 with a Cloudflare error page pasted into the
 * terminal, starting `<!DOCTYPE html>` and three IE conditional comments. The
 * install was fine; /health returned ok seconds later. No failure path may put
 * an HTML body in front of a client again.
 */
const CLOUDFLARE_ERROR_PAGE = [
  "<!DOCTYPE html>",
  '<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->',
  '<!--[if IE 7]>    <html class="no-js ie7 oldie" lang="en-US"> <![endif]-->',
  "<head><title>404 Not Found</title></head>",
].join("\n");

const summarisedPage = summariseResponseBody(CLOUDFLARE_ERROR_PAGE);
assert.doesNotMatch(summarisedPage, /<!DOCTYPE|<html|<!--|<head/i,
  "an HTML body must never be echoed back to the terminal");
assert.match(summarisedPage, /not serving the worker yet|web page/i,
  "the summary has to say what actually happened");

/* JSON bodies still surface their real message. */
assert.match(summariseResponseBody('{"error":"vector index missing"}'), /vector index missing/);
assert.match(summariseResponseBody('{"errors":[{"message":"quota exceeded"}]}'), /quota exceeded/);

/* Neither an empty body nor junk may produce an empty or enormous line. */
assert.match(summariseResponseBody(""), /no body/i);
assert.ok(summariseResponseBody("x".repeat(5_000)).length <= 200);

// A wait that outlives the bounded command remains incomplete, with no retry loop remedy.
{
  let clock = 0;
  let decisions = 0;
  const output = [];
  const priorLog = console.log;
  let failure;
  try {
    console.log = (...parts) => output.push(parts.join(" "));
    await cmdDrain("fixture.manifest.json", {
      loadManifest: () => ({ m: { brain: { domain: "fixture.invalid" } } }),
      resolveBaseUrl: async () => "https://fixture.invalid",
      resolveAdminKey: () => "fixture-label",
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      maxDurationMs: 1_000,
      http: async () => {
        decisions += 1;
        return new Response(JSON.stringify({
          drained: 0, submitted: 0, waiting: 200, remaining: 1,
          remaining_is_lower_bound: true, vector_ready: false,
        }));
      },
    });
  } catch (error) { failure = error; }
  finally { console.log = priorLog; }
  assert.equal(decisions, 1, "the bounded wait must reach receipt validation");
  assert.equal(clock, 1_000, "the wait must exhaust the injected deadline");
  assert.match(failure?.message || "", /wall-clock safety limit/);
  assert.match(output.join("\n"), /200 waiting for index visibility/);
  assert.doesNotMatch(output.join("\n"), /query-ready/);
  assert.doesNotMatch(failure.message, /re-run|resume from|drain.*again/i);
  assert.match(failure.message, /scheduled background drain/);
}
console.log("drain bounded visibility wait: 7 assertions passed");

// Exercise the real Worker route, D1 outbox, and CLI together. Provider acceptance
// is delayed until the next command poll, with no network or re-embedding.
{
  const { createProductFixture } = await import("../worker/test/product-contract-fixture.mjs");
  const fixture = await createProductFixture();
  const visible = new Map();
  const pending = [];
  const receipts = [];
  let mutation = 0;
  let processed = null;
  let embedded = 0;
  let clock = Date.parse("2026-10-07T12:00:00Z");
  const priorNow = Date.now;
  const priorLog = console.log;
  const lines = [];
  try {
    Date.now = () => clock;
    console.log = (...parts) => lines.push(parts.join(" "));
    for (let index = 0; index < 318; index++) {
      const uid = `fixture:${index}`;
      fixture.raw("INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash) VALUES (?, 'fixture', ?, 'Synthetic', ?, 'fixture-hash')", uid, uid, clock);
      fixture.raw("INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, vector_id) VALUES (?, ?, 0, 'Synthetic', 'fixture', ?)", uid, uid, uid);
      if (index < 8) visible.set(uid, { id: uid });
      else fixture.raw("INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at) VALUES (?, ?, 'upsert', ?)", uid, uid, clock + index);
    }
    fixture.raw("INSERT INTO corpus_stats (source, documents, chunks) VALUES ('fixture', 318, 318)");
    fixture.raw("UPDATE install_state SET vector_projection_bootstrap_base_count = 8 WHERE id = 1");
    fixture.env.VECTORIZE = {
      upsert: async (rows) => {
        const mutationId = `fixture-mutation-${++mutation}`;
        pending.push({ mutationId, rows });
        return { mutationId };
      },
      getByIds: async (ids) => ids.map((id) => visible.get(id)).filter(Boolean),
      describe: async () => ({ vectorCount: visible.size, processedUpToMutation: processed }),
    };
    fixture.env.AI = { run: async (_model, { text }) => {
      embedded += text.length;
      return { data: text.map(() => [0.1, 0.2, 0.3]) };
    } };
    const result = await cmdDrain("fixture.manifest.json", {
      loadManifest: () => ({ m: { brain: { domain: "fixture.invalid" } } }),
      resolveBaseUrl: async () => "https://fixture.invalid",
      resolveAdminKey: () => fixture.env.ADMIN_KEY,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
        for (const accepted of pending.splice(0)) {
          for (const row of accepted.rows) visible.set(row.id, row);
          processed = accepted.mutationId;
        }
      },
      http: async () => {
        assert.ok(receipts.length < 5, "the real route must converge in bounded passes");
        const response = await fixture.post("/api/admin/brain/drain", {}, { "X-Admin-Key": fixture.env.ADMIN_KEY });
        receipts.push(await response.clone().json());
        return response;
      },
    });
    assert.deepEqual(receipts.map(({ drained, submitted, waiting, remaining, remaining_is_lower_bound, vector_ready }) =>
      ({ drained, submitted, waiting, remaining, remaining_is_lower_bound, vector_ready })), [
      { drained: 0, submitted: 200, waiting: 200, remaining: 100, remaining_is_lower_bound: true, vector_ready: false },
      { drained: 200, submitted: 0, waiting: 0, remaining: 1, remaining_is_lower_bound: true, vector_ready: false },
      { drained: 0, submitted: 110, waiting: 110, remaining: 10, remaining_is_lower_bound: true, vector_ready: false },
      { drained: 110, submitted: 0, waiting: 0, remaining: 0, remaining_is_lower_bound: false, vector_ready: true },
    ]);
    assert.deepEqual(receipts.map((receipt) => receipt.actual_vectors), [8, 208, 208, 318]);
    assert.equal(result.actual_vectors, 318);
    assert.equal(result.confirmed_this_run, 310);
    assert.equal(embedded, 310, "waiting must never re-embed accepted work");
    assert.equal(fixture.first("SELECT count(*) AS n FROM vector_outbox").n, 0);
    assert.equal(lines.filter((line) => /waiting for index visibility/.test(line)).length, 2);
  } finally {
    Date.now = priorNow;
    console.log = priorLog;
    fixture.close();
  }
}
console.log("drain real Worker field-sequence receipt: 7 result assertions and 4 request guards passed");
