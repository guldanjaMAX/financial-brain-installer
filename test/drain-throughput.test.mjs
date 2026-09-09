// Throughput, from the reporter's finding 6j: 1,200 chunks/hour while the message said
// "a few minutes". The fix is embedding in groups instead of one call per chunk.
//
// The dangerous part of batching is ALIGNMENT: if a batch call returns fewer
// vectors than texts and the caller does not notice, every chunk after the gap
// gets somebody else's vector. That is silent and permanent, so it is the thing
// most heavily tested here.

import { drainOutbox, drainBatchQueryUpperBound, DRAIN_D1_QUERY_BUDGET } from "../worker/src/lib/store-d1.js";

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 200))); if (!c) fail++; };

const mkEnv = (rows, upserted, deleted = [], updates = []) => ({
  DB: {
    prepare(q) {
      const shape = (b = []) => ({
        all: async () => ({ results:
          /submitted_mutation_id IS NOT NULL/.test(q) || /WHERE (?:o\.)?op = 'delete'/.test(q) ? [] : rows }),
        first: async () => ({ n: 1 }),
        run: async () => /UPDATE install_state/.test(q)
          ? ({ meta: { changes: 1 } })
          : ({}),
        _q: q, _b: b,
      });
      const o = shape(); o.bind = (...b) => shape(b); return o;
    },
    batch: async (stmts) => {
      for (const s of stmts) {
        if (/DELETE FROM vector_outbox/.test(s._q)) deleted.push(s._b[0]);
        if (/UPDATE vector_outbox SET attempts/.test(s._q)) updates.push(s._b[2]);
        else if (/UPDATE vector_outbox/.test(s._q)) updates.push(s._b[0]);
      }
      return stmts.map(() => ({ meta: { changes: 1 } }));
    },
  },
  VECTORIZE: { upsert: async (v) => { upserted.push(...v); return { mutationId: "fixture-throughput" }; } },
});

const rows = (n) => Array.from({ length: n }, (_, i) => ({
  chunk_uid: `c${i}#0`, text: `text ${i}`, source: "s", doc_uid: `c${i}`,
  client: "Acme", category: "note", top_folder: "Clients", platform: "drive",
  document_date: 1750000000000, generation: i + 1,
}));

/* ---- the round trips actually collapse ---- */
{
  const up = []; let batchCalls = 0, singleCalls = 0;
  const r = await drainOutbox(mkEnv(rows(100), up), {
    embed: async () => { singleCalls++; return [0.1]; },
    embedBatch: async (texts) => { batchCalls++; return texts.map((_, i) => [i]); },
    embedGroup: 50,
  });
  check("100 chunks embed in 2 calls, not 100", batchCalls === 2 && singleCalls === 0, `batch=${batchCalls} single=${singleCalls}`);
  check("and all 100 are durably submitted for later visibility confirmation",
    r.submitted === 100 && r.drained === 0 && r.waiting === 100, JSON.stringify(r));
  check("every vector carries the full pre-filter metadata contract",
    up.every((v) => v.metadata.source === "s" && v.metadata.client === "Acme" &&
      v.metadata.category === "note" && v.metadata.top_folder === "Clients" &&
      v.metadata.platform === "drive" && v.metadata.document_date === 1750000000000),
    JSON.stringify(up[0]?.metadata));
}

/* ---- alignment: the vector a chunk gets must be ITS OWN ---- */
{
  const up = [];
  await drainOutbox(mkEnv(rows(4), up), {
    embed: async () => [999],
    embedBatch: async (texts) => texts.map((t) => [Number(t.split(" ")[1])]),
    embedGroup: 2,
  });
  check("each chunk keeps the vector made from its own text",
    up.length === 4 && up.every((v, i) => v.values[0] === i), JSON.stringify(up.map((v) => v.values[0])));
}

/* ---- a SHORT batch response must never be accepted ---- */
{
  const up = [];
  const r = await drainOutbox(mkEnv(rows(4), up), {
    embed: async (t) => [Number(t.split(" ")[1])],
    // Returns 1 vector for 4 texts, and a value that is WRONG for every chunk,
    // so a passing test cannot be a coincidence of the right number appearing.
    embedBatch: async () => [[999]],
    embedGroup: 4,
  });
  check("a short batch response is rejected, not misaligned", up.every((v, i) => v.values[0] === i),
    JSON.stringify(up.map((v) => v.values[0])));
  check("and every chunk still submits via the per-item fallback", r.submitted === 4, JSON.stringify(r));
}

/* ---- poison isolation survives batching ---- */
{
  const up = [], del = [], upd = [];
  const r = await drainOutbox(mkEnv([
    { chunk_uid: "ok1#0", text: "fine", source: "s", doc_uid: "a" },
    { chunk_uid: "poison#0", text: "BAD", source: "s", doc_uid: "p" },
    { chunk_uid: "ok2#0", text: "also fine", source: "s", doc_uid: "b" },
  ], up, del, upd), {
    embed: async (t) => { if (t === "BAD") throw new Error("no embedding"); return [0.1]; },
    embedBatch: async (texts) => { if (texts.includes("BAD")) throw new Error("group failed"); return texts.map(() => [0.1]); },
    embedGroup: 50,
  });
  check("a failed group does NOT poison its innocent members", r.submitted === 2, JSON.stringify(r));
  check("only the genuinely bad chunk is scheduled for bounded retry", r.failed === 1 && upd.includes("poison#0"), JSON.stringify(upd));
  check("and accepted rows stay queued until their exact generation is visible",
    del.length === 0 && upd.includes("ok1#0") && upd.includes("ok2#0"), JSON.stringify({ del, upd }));
}

/* ---- without embedBatch, behaviour is exactly as before ---- */
{
  const up = []; let single = 0;
  const r = await drainOutbox(mkEnv(rows(3), up), { embed: async () => { single++; return [0.1]; } });
  check("a caller that passes no embedBatch still works", r.submitted === 3 && single === 3, `single=${single}`);
}


/* ------------------------------------------------------------------ *
 * The reserved query budget must cover the path that actually costs
 * the most, which is CONFIRMATION, not submission.
 *
 * drainBatchQueryUpperBound's comment says "Confirmation needs only one
 * CAS statement per row." That is true only of the confirmed arm. The
 * retrying arm is three: the clear-receipt UPDATE, plus the two
 * statements scheduleVectorFailures pushes per row (retry-state upsert
 * and the outbox attempts bump). A mass visibility_mismatch is the
 * ordinary shape of a stalled fence, not an exotic one, so the bound is
 * measured against a batch where every row misses.
 *
 * Cloudflare counts each statement inside DB.batch() toward the 1,000
 * query invocation limit, so an under-reserved bound can let a Vectorize
 * mutation land and then fail to record its durable receipt.
 * ------------------------------------------------------------------ */
{
  const BASE_RESERVED = 8; // acquire+release+verify(3)+depth+retry-state(2)
  let queries = 0;
  const countingEnv = (submittedRows, pendingRows) => {
    const mk = (q, b = []) => ({
      _q: q, _b: b,
      bind: (...nb) => mk(q, nb),
      all: async () => {
        queries++;
        if (/submitted_mutation_id IS NOT NULL/.test(q)) return { results: submittedRows.slice(0, b[0]) };
        if (/o\.op = 'delete'/.test(q)) return { results: [] };
        if (/o\.op = 'upsert'/.test(q)) return { results: pendingRows.slice(0, b[1]) };
        return { results: [] };
      },
      first: async () => {
        queries++;
        if (/vector_projection_mutation_id AS mutation_id/.test(q)) return { mutation_id: "M1", submitted_at: 1 };
        return { n: submittedRows.length + pendingRows.length };
      },
      run: async () => { queries++; return { meta: { changes: 1 } }; },
    });
    return {
      DB: {
        prepare: (q) => mk(q),
        // Every statement in a batch is billed individually.
        batch: async (s) => { queries += s.length; return s.map(() => ({ meta: { changes: 1 } })); },
      },
      VECTORIZE: {
        upsert: async () => ({ mutationId: "M2" }),
        deleteByIds: async () => ({ mutationId: "M3" }),
        getByIds: async () => [],           // nothing is query-visible: every row retries
        describe: async () => ({ processedUpToMutation: "M1",
          processedUpToDatetime: new Date().toISOString(), vectorCount: 0 }),
      },
    };
  };

  // Discover the shipped ceiling by observation rather than importing a
  // private const, so this test keeps measuring the real batch after the
  // constant is retuned. The counting env honours the LIMIT bind, so what
  // comes back is the drain's actual per-batch appetite.
  const probeRows = Array.from({ length: 4000 }, (_, i) => ({
    chunk_uid: `p${i}#0`, text: `t${i}`, source: "s", doc_uid: `p${i}`,
    generation: 1, attempts: 0, failure_code: null, queued_at: i,
  }));
  let maxBatch = 0;
  await drainOutbox({
    ...countingEnv([], probeRows),
    VECTORIZE: {
      upsert: async (v) => { maxBatch = Math.max(maxBatch, v.length); return { mutationId: "M2" }; },
      deleteByIds: async () => ({ mutationId: "M3" }),
      getByIds: async () => [],
      describe: async () => ({ processedUpToMutation: "M1",
        processedUpToDatetime: new Date().toISOString(), vectorCount: 0 }),
    },
  }, { embed: async () => [0.1], embedBatch: async (t) => t.map(() => [0.1]), embedGroup: 50, maxBatches: 10 });
  check("the drain still accepts a full batch of work, and never a silent no-op",
    maxBatch > 0, `submitted ${maxBatch} vectors from a 4000-row queue`);

  const submittedRows = Array.from({ length: maxBatch }, (_, i) => ({
    chunk_uid: `s${i}#0`, vector_id: `s${i}#0`, op: "upsert", queued_at: i,
    generation: 1, submitted_mutation_id: "M1", submitted_at: 1, attempts: 0,
  }));
  queries = 0;
  await drainOutbox(countingEnv(submittedRows, []), {
    embed: async () => [0.1], embedBatch: async (t) => t.map(() => [0.1]), embedGroup: 50, maxBatches: 10,
  });
  const reserved = BASE_RESERVED + drainBatchQueryUpperBound(maxBatch);
  check("a batch where every row misses visibility stays inside its reserved budget",
    queries <= reserved,
    `spent ${queries} D1 statements, reserved ${reserved} (batch ${maxBatch})`);

  check("and the reserved budget itself fits the invocation budget, so the drain is never silently a no-op",
    BASE_RESERVED + drainBatchQueryUpperBound(maxBatch) <= DRAIN_D1_QUERY_BUDGET,
    `reserved ${reserved} vs budget ${DRAIN_D1_QUERY_BUDGET}`);

  check("the worst confirmation also fits Cloudflare's hard 1,000-query invocation limit",
    queries <= 1000, `spent ${queries}`);
}

console.log(`\ndrain throughput: ${ran - fail}/${ran} passed`);
if (fail) process.exit(1);
