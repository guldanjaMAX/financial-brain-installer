// A later upgrade must preserve confirmed bootstrap history while converging
// changed corpus rows and respecting the shared writer lease.
//
// This runs against real SQLite because the important property is the state
// transition across INSERT...SELECT, ON CONFLICT, chunk deletion and retry.
// Hand-written SQL mocks cannot prove that those statements compose.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCELERATED_BOOTSTRAP_PAGE_SIZE,
  ACCELERATED_BOOTSTRAP_WINDOW,
  acceleratedVectorBootstrap,
  acquireDrainLease,
  DRAIN_D1_QUERY_BUDGET,
  drainBatchQueryUpperBound,
  releaseDrainLease,
  renewDrainLease,
  replaceDocumentChunks,
  upsertChunks,
  drainOutbox,
  forget,
  forgetFamilies,
  vectorReadiness,
} from "../worker/src/lib/store-d1.js";
import { storeFor } from "../worker/src/lib/store.js";
import {
  runAcceleratedBootstrap,
  validateAcceleratedBootstrapReceipt,
  validateAcceleratedBootstrapProgress,
} from "../brain.mjs";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 240)));
  if (!condition) fail++;
};

function makeEnv({
  acceleratedVectorIdReportedChanges = null,
  autoProcessVectorMutations = true,
  deleteThrows = false,
  enforceD1PatternLimit = false,
  getByIdsVisibilityLag = 0,
  invalidGetByIdsPage = null,
  malformedAcceleratedVectorIdReadback = false,
  skipAcceleratedVectorIdUpdate = false,
} = {}) {
  const db = new DatabaseSync(":memory:");
  const dir = fileURLToPath(new URL("../migrations/d1/", import.meta.url));
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(dir, file), "utf-8"));
  }
  db.prepare(
    `INSERT INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1, 'fixture', '0.0.0', 12, 0, '2026-01-01T00:00:00Z', 'test')`
  ).run();

  const deleted = [];
  const upserted = [];
  const upsertBatches = [];
  const visible = new Map();
  let mutationSequence = 0;
  let processedUpToMutation = null;
  let visibilityLagRemaining = getByIdsVisibilityLag;
  const pendingVectorMutations = [];
  const getByIdsCalls = [];
  const accept = (apply) => {
    const mutationId = `fixture-mutation-${++mutationSequence}`;
    if (autoProcessVectorMutations) {
      apply();
      processedUpToMutation = mutationId;
    } else {
      pendingVectorMutations.push({ mutationId, apply });
    }
    return { mutationId };
  };
  const d1Queries = { submitted: 0, maxBinds: 0 };
  const prepare = (sql) => {
    const shape = (params = []) => ({
      bind: (...next) => shape(next),
      all: async () => {
        d1Queries.submitted++;
        d1Queries.maxBinds = Math.max(d1Queries.maxBinds, params.length);
        if (enforceD1PatternLimit && /\b(?:LIKE|GLOB)\b/i.test(sql) &&
            params.some((value) => new TextEncoder().encode(String(value)).length > 50)) {
          throw new Error("LIKE or GLOB pattern too complex");
        }
        return { results: db.prepare(sql).all(...params) };
      },
      first: async () => {
        d1Queries.submitted++;
        d1Queries.maxBinds = Math.max(d1Queries.maxBinds, params.length);
        if (malformedAcceleratedVectorIdReadback &&
            /FROM json_each\(\?1\) m JOIN chunks c/.test(sql)) {
          return { n: "not-a-count" };
        }
        return db.prepare(sql).get(...params) ?? null;
      },
      run: async () => {
        d1Queries.submitted++;
        d1Queries.maxBinds = Math.max(d1Queries.maxBinds, params.length);
        const result = db.prepare(sql).run(...params);
        return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
      },
      _sql: sql,
      _params: params,
    });
    return shape();
  };
  const env = {
    _db: db,
    _acceptVectorMutation: accept,
    _visibleVectors: visible,
    _setGetByIdsVisibilityLag: (calls) => { visibilityLagRemaining = calls; },
    _setAutoProcessVectorMutations: (enabled) => { autoProcessVectorMutations = enabled; },
    _processNextVectorMutation: () => {
      const mutation = pendingVectorMutations.shift();
      if (!mutation) return null;
      mutation.apply();
      processedUpToMutation = mutation.mutationId;
      return mutation.mutationId;
    },
    _pendingVectorMutations: pendingVectorMutations,
    DB: {
      prepare,
      batch: async (statements) => {
        d1Queries.submitted += statements.length;
        d1Queries.maxBinds = Math.max(
          d1Queries.maxBinds,
          ...statements.map((statement) => statement._params.length),
        );
        db.exec("BEGIN");
        try {
          const results = statements.map((statement) => {
            if (skipAcceleratedVectorIdUpdate &&
                /UPDATE chunks AS c SET vector_id/.test(statement._sql)) {
              return { success: true, results: [], meta: { changes: 0 } };
            }
            const result = db.prepare(statement._sql).run(...statement._params);
            const changes = Number.isSafeInteger(acceleratedVectorIdReportedChanges) &&
                /UPDATE chunks AS c SET vector_id/.test(statement._sql)
              ? acceleratedVectorIdReportedChanges
              : Number(result.changes || 0);
            return { success: true, results: [], meta: { changes } };
          });
          db.exec("COMMIT");
          return results;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
    },
    VECTORIZE: {
      upsert: async (vectors) => {
        upsertBatches.push(vectors.map((vector) => vector.id));
        return accept(() => {
          upserted.push(...vectors);
          for (const vector of vectors) visible.set(vector.id, structuredClone(vector));
        });
      },
      deleteByIds: async (ids) => {
        if (deleteThrows) throw new Error("Vectorize temporarily unavailable");
        return accept(() => {
          deleted.push(...ids);
          for (const id of ids) visible.delete(id);
        });
      },
      getByIds: async (ids) => {
        getByIdsCalls.push([...ids]);
        if (ids.length > 20) throw new Error("Vectorize getByIds accepts at most 20 ids");
        if (getByIdsCalls.length === invalidGetByIdsPage) return { invalid: true };
        if (visibilityLagRemaining > 0) {
          visibilityLagRemaining--;
          return [];
        }
        return ids.map((id) => visible.get(id)).filter(Boolean);
      },
      describe: async () => ({
        vectorCount: visible.size,
        processedUpToMutation,
      }),
    },
  };
  return { env, db, deleted, upserted, upsertBatches, visible, d1Queries, getByIdsCalls };
}

const insertDocument = (db, uid, source = "drive") => db.prepare(
  `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash)
   VALUES (?, ?, ?, ?, ?, ?)`
).run(uid, source, uid, uid, Date.now(), `hash:${uid}`);

const insertChunk = (db, uid, doc, ix, vectorId = uid) => db.prepare(
  `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, vector_id)
   VALUES (?, ?, ?, ?, 'drive', ?)`
).run(uid, doc, ix, `old text ${ix}`, vectorId);

async function drainFully(env, options = {}, maxRounds = 20) {
  const total = { drained: 0, deleted: 0, upserted: 0, submitted: 0, failed: 0, remaining: null };
  for (let round = 0; round < maxRounds; round++) {
    const part = await drainOutbox(env, { maxBatches: 10, ...options });
    for (const field of ["drained", "deleted", "upserted", "submitted", "failed"]) {
      total[field] += Number(part[field] || 0);
    }
    total.remaining = part.remaining;
    if (part.remaining === 0) return total;
  }
  throw new Error(`fixture drain did not settle: ${JSON.stringify(total)}`);
}

const acceleratedOptions = (start = 50_000) => {
  let clock = start;
  return {
    now: () => ++clock,
    advanceTo: (time) => { clock = Math.max(clock, time); },
    embed: async () => [0.1],
    embedBatch: async (texts) => texts.map(() => [0.1]),
  };
};

async function completeRealAcceleratedBootstrap(env, db, {
  epoch = 20,
  options = acceleratedOptions(),
} = {}) {
  db.prepare(
    `UPDATE install_state
        SET schema_version=13,vector_projection_status='bootstrap_required',
            vector_projection_bootstrap_epoch=?1,
            vector_projection_bootstrap_cursor=NULL,
            vector_projection_bootstrap_high_water=(SELECT MAX(chunk_uid) FROM chunks),
            vector_projection_bootstrap_protocol=NULL,
            vector_projection_bootstrap_base_count=0,
            vector_projection_mutation_id=NULL,
            vector_projection_submitted_at=NULL
      WHERE id=1`,
  ).run(epoch);
  let receipt = null;
  for (let round = 0; round < 8 && !receipt?.complete; round++) {
    receipt = await acceleratedVectorBootstrap(env, options);
  }
  if (!receipt?.complete) throw new Error(`fixture bootstrap did not complete: ${JSON.stringify(receipt)}`);
  return { receipt, options };
}

const markAllOutboxSubmitted = (env, db, submittedAt = 1_000) => {
  const receipt = env._acceptVectorMutation(() => {});
  db.prepare(
    `UPDATE vector_outbox
        SET submitted_mutation_id=?, submitted_at=?`,
  ).run(receipt.mutationId, submittedAt);
  db.prepare(
    `UPDATE install_state
        SET vector_projection_mutation_id=?, vector_projection_submitted_at=?
      WHERE id=1`,
  ).run(receipt.mutationId, submittedAt);
  return receipt.mutationId;
};

/* Exact bulk visibility may precede the provider aggregate count. This is
   waiting in the current epoch, not a return from bulk to legacy cleanup. */
{
  const { env, db } = makeEnv({ autoProcessVectorMutations: false });
  env.VECTOR_DRAIN_MODE = "paused-for-upgrade";
  insertDocument(db, "drive:bulk-count-lag");
  insertChunk(db, "drive:bulk-count-lag#0", "drive:bulk-count-lag", 0);
  insertChunk(db, "drive:bulk-count-lag#1", "drive:bulk-count-lag", 1);
  db.prepare(`UPDATE install_state SET schema_version=13,
    vector_projection_status='bootstrap_required', vector_projection_bootstrap_epoch=10,
    vector_projection_bootstrap_cursor=NULL,
    vector_projection_bootstrap_high_water=(SELECT MAX(chunk_uid) FROM chunks),
    vector_projection_bootstrap_protocol=NULL, vector_projection_bootstrap_base_count=0
    WHERE id=1`).run();
  const options = acceleratedOptions(40_000);
  const building = await acceleratedVectorBootstrap(env, options);
  while (env._processNextVectorMutation()) { /* exact accepted generations visible */ }
  const describe = env.VECTORIZE.describe;
  let holdCount = true;
  env.VECTORIZE.describe = async () => ({ ...await describe(), ...(holdCount ? { vectorCount: 0 } : {}) });
  const waiting = await acceleratedVectorBootstrap(env, options);
  let failure = null;
  try {
    validateAcceleratedBootstrapReceipt(building);
    validateAcceleratedBootstrapReceipt(waiting);
    validateAcceleratedBootstrapProgress(building, waiting);
  } catch (error) { failure = error; }
  check("a confirmed bulk batch with a lagging count stays valid waiting progress",
    !failure && building.phase === "building" && waiting.phase === "waiting" &&
      waiting.confirmed === 2 && waiting.queued === 0 && waiting.submitted === 0 && !waiting.complete,
    failure?.message || JSON.stringify(waiting));
  holdCount = false;
  const complete = await acceleratedVectorBootstrap(env, options);
  validateAcceleratedBootstrapReceipt(complete);
  validateAcceleratedBootstrapProgress(waiting, complete);
  check("bulk count convergence completes through actual CLI validation", complete.complete === true);
}

/* A later upgrade must not count one completed bootstrap's durable batch
   history against a new exact verified cut. This fixture reaches the shape
   through the real coordinator first; a hand-seeded empty ledger missed the
   regression. */
{
  const { env, db } = makeEnv();
  env.VECTOR_DRAIN_MODE = "paused-for-upgrade";
  insertDocument(db, "drive:completed-history");
  insertChunk(db, "drive:completed-history#0", "drive:completed-history", 0);
  insertChunk(db, "drive:completed-history#1", "drive:completed-history", 1);
  const { receipt: completed, options } = await completeRealAcceleratedBootstrap(env, db, {
    epoch: 20,
    options: acceleratedOptions(50_000),
  });
  const confirmedHistory = db.prepare(
    "SELECT count(*) AS n FROM vector_bootstrap_batches WHERE epoch=20 AND status='confirmed'",
  ).get();

  insertDocument(db, "drive:after-completed-history");
  insertChunk(db, "drive:after-completed-history#0", "drive:after-completed-history", 0);
  db.prepare(
    `INSERT INTO vector_outbox (chunk_uid,vector_id,op,queued_at)
     VALUES ('drive:after-completed-history#0','drive:after-completed-history#0','upsert',51000)`,
  ).run();
  const upgraded = await acceleratedVectorBootstrap(env, options);
  const state = db.prepare(
    `SELECT vector_projection_status AS status,
            vector_projection_bootstrap_epoch AS epoch,
            vector_projection_bootstrap_base_count AS base,
            (SELECT count(*) FROM vector_bootstrap_batches
              WHERE epoch=vector_projection_bootstrap_epoch) AS current_batches,
            (SELECT count(*) FROM vector_bootstrap_batches) AS all_batches
       FROM install_state WHERE id=1`,
  ).get();
  check("a completed bootstrap fixture contains confirmed durable batch history",
    completed.complete === true && Number(confirmedHistory.n) > 0,
    JSON.stringify({ completed, confirmedHistory }));
  check("a later paused upgrade rebases completed history and converges",
    upgraded.complete === true && upgraded.total === 3 && upgraded.confirmed === 3 &&
      upgraded.remaining === 0 && state.status === "verified" && Number(state.epoch) === 21 &&
      Number(state.base) === 3 && Number(state.current_batches) === 0 &&
      Number(state.all_batches) === Number(confirmedHistory.n),
    JSON.stringify({ upgraded, state }));
}

/* Historical receipts cover the old corpus cut. A later overwrite/delete/add
   must survive more than one provider poll through the actual CLI validators.
   Immediate provider fixtures hid the invalid intermediate aggregate. */
for (const scenario of ["mixed", "overwrite", "delete", "delete_all", "rebased_overwrite"]) {
  const { env, db, visible, upsertBatches } = makeEnv();
  env.VECTOR_DRAIN_MODE = "paused-for-upgrade";
  const originalCount = scenario === "mixed" ? 1001 : 3;
  const doc = (i) => `drive:residue-${scenario}-${String(i).padStart(4, "0")}`;
  for (let i = 0; i < originalCount; i++) {
    insertDocument(db, doc(i));
    insertChunk(db, `${doc(i)}#0`, doc(i), 0);
  }
  const { options } = await completeRealAcceleratedBootstrap(env, db, {
    epoch: 60,
    options: acceleratedOptions(100_000),
  });
  if (scenario === "rebased_overwrite") await acceleratedVectorBootstrap(env, options);
  const history = db.prepare("SELECT * FROM vector_bootstrap_batches ORDER BY epoch,batch_no").all();
  const originalBatches = upsertBatches.length;
  env._setAutoProcessVectorMutations(false);

  if (["mixed", "overwrite", "rebased_overwrite"].includes(scenario)) {
    db.prepare("UPDATE chunks SET text='replacement fixture text' WHERE chunk_uid=?").run(`${doc(1)}#0`);
    db.prepare("INSERT INTO vector_outbox (chunk_uid,vector_id,op,queued_at) VALUES (?1,?1,'upsert',?2)")
      .run(`${doc(1)}#0`, 100_001);
  }
  if (scenario === "mixed") {
    insertDocument(db, doc(originalCount));
    insertChunk(db, `${doc(originalCount)}#0`, doc(originalCount), 0);
    db.prepare("INSERT INTO vector_outbox (chunk_uid,vector_id,op,queued_at) VALUES (?1,?1,'upsert',?2)")
      .run(`${doc(originalCount)}#0`, 100_002);
  }
  if (["mixed", "delete", "delete_all"].includes(scenario)) {
    await forget(env, { docUids: scenario === "delete_all"
      ? Array.from({ length: originalCount }, (_, i) => doc(i)) : [doc(0)], dryRun: false });
  }
  const expectedCount = Number(db.prepare("SELECT count(*) AS n FROM chunks").get().n);
  const changedUpserts = Number(db.prepare("SELECT count(*) AS n FROM vector_outbox WHERE op='upsert'").get().n);
  const expectedGenerations = db.prepare("SELECT vector_id,generation FROM vector_outbox WHERE op='upsert'").all();
  const receipts = [];
  let failure = null;
  let previous = null;
  let polls = 0;
  let cliClock = 1_000_000;
  let firstPendingAt = null;
  let result = null;
  let busyPolls = 0;
  let countHoldUntil = null;
  const describe = env.VECTORIZE.describe;
  env.VECTORIZE.describe = async () => {
    const observed = await describe();
    if (scenario === "delete" && visible.size === expectedCount) {
      if (countHoldUntil === null) countHoldUntil = polls + 2;
      // Exact delete lookup can be ahead of the provider's aggregate count.
      if (polls <= countHoldUntil) return { ...observed, vectorCount: originalCount };
    }
    return observed;
  };
  try {
    result = await runAcceleratedBootstrap({
      request: async () => {
        polls++;
        if (scenario === "delete_all" && polls === 2) {
          await acquireDrainLease(env, { ownerToken: "fixture-residue-busy", now: options.now(), ttlMs: 1000 });
        }
        const receipt = await acceleratedVectorBootstrap(env, options);
        if (receipt.busy) {
          busyPolls++;
          await releaseDrainLease(env, "fixture-residue-busy");
          // The real HTTP route exposes this bounded projection of a busy
          // coordinator receipt, not its internal counters or lease identity.
          return new Response(JSON.stringify({ protocol: receipt.protocol, busy: true,
            remaining: receipt.remaining, retry_after_seconds: receipt.retry_after_seconds }), { status: 409 });
        }
        validateAcceleratedBootstrapReceipt(receipt);
        validateAcceleratedBootstrapProgress(previous, receipt);
        receipts.push(receipt);
        previous = receipt;
        if (env._pendingVectorMutations.length && firstPendingAt === null) firstPendingAt = polls;
        // Accept the provider write, keep it invisible for at least two complete
        // HTTP receipts, then process it. Repeated updater calls reuse receipts.
        if (firstPendingAt !== null && polls - firstPendingAt >= 2) {
          while (env._processNextVectorMutation()) { /* process actual accepted work */ }
          firstPendingAt = null;
        }
        return new Response(JSON.stringify(receipt), { status: 200 });
      },
      now: () => cliClock,
      sleep: async (ms) => { cliClock += ms; },
      maxRounds: 30,
    });
  } catch (error) { failure = error; }
  const pending = Number(db.prepare("SELECT count(*) AS n FROM vector_outbox").get().n);
  check(`${scenario}: delayed real bootstrap receipts pass the actual CLI and converge`,
    !failure && result?.complete === true && result.total === expectedCount &&
      result.confirmed === expectedCount && pending === 0 && visible.size === expectedCount &&
      receipts.filter(r => r.phase === "legacy_drain" && !r.complete).length >= 2,
    JSON.stringify({ error: failure?.message, result, pending, receipts: receipts.slice(0, 3) }));
  check(`${scenario}: old batch history remains intact and only changed upserts are embedded`,
    JSON.stringify(db.prepare("SELECT * FROM vector_bootstrap_batches ORDER BY epoch,batch_no").all()) === JSON.stringify(history) &&
      upsertBatches.slice(originalBatches).reduce((sum, rows) => sum + rows.length, 0) === changedUpserts &&
      expectedGenerations.every(row => visible.get(row.vector_id)?.metadata?.outbox_generation === String(row.generation)),
    JSON.stringify({ historyRows: history.length, changedUpserts, newBatches: upsertBatches.length - originalBatches }));
  if (scenario === "delete") check("delete residue survives a lagging provider count after the queue clears",
    receipts.some(r => r.phase === "waiting" && r.queued === 0 && r.submitted === 0 &&
      r.actual_vectors > r.total && !r.complete), JSON.stringify(receipts));
  if (scenario === "delete_all") {
    check("zero-chunk deletion residue survives an intervening busy response", busyPolls === 1 && result?.complete === true);
    const residue = receipts.find(r => r.queued + r.submitted > r.remaining);
    let buildingRejected = false, falseCompleteRejected = false;
    try { validateAcceleratedBootstrapReceipt({ ...residue, phase: "building" }); }
    catch { buildingRejected = true; }
    try { validateAcceleratedBootstrapReceipt({ ...residue, phase: "complete", complete: true, vector_ready: true }); }
    catch { falseCompleteRejected = true; }
    check("the deletion exception cannot admit building work or false completion", Boolean(residue) && buildingRejected && falseCompleteRejected);
  }
}

/* A provider watermark can advance before getByIds exposes the accepted
   generation. That is retryable progress, including during supervised
   recovery; it must neither erase completed history nor strand the next cut. */
{
  const { env, db } = makeEnv();
  env.VECTOR_DRAIN_MODE = "paused-for-upgrade";
  insertDocument(db, "drive:visibility-history");
  insertChunk(db, "drive:visibility-history#0", "drive:visibility-history", 0);
  const { options } = await completeRealAcceleratedBootstrap(env, db, {
    epoch: 30,
    options: acceleratedOptions(60_000),
  });
  const history = db.prepare(
    "SELECT count(*) AS n FROM vector_bootstrap_batches WHERE epoch=30 AND status='confirmed'",
  ).get();

  insertDocument(db, "drive:visibility-lag");
  insertChunk(db, "drive:visibility-lag#0", "drive:visibility-lag", 0);
  db.prepare(
    `INSERT INTO vector_outbox (chunk_uid,vector_id,op,queued_at)
     VALUES ('drive:visibility-lag#0','drive:visibility-lag#0','upsert',61000)`,
  ).run();
  env._setGetByIdsVisibilityLag(1);
  const retrying = await acceleratedVectorBootstrap(env, options);
  const delayed = await acceleratedVectorBootstrap(env, options);
  const nextAttempt = db.prepare("SELECT min(next_attempt_at) AS at FROM vector_outbox_retry_state").get().at;
  check("visibility retries remain pending until their durable backoff expires",
    delayed.complete === false && delayed.queued === 1 && Number.isSafeInteger(nextAttempt));
  options.advanceTo(nextAttempt);
  const settled = await acceleratedVectorBootstrap(env, options);
  check("delayed exact visibility is reported as retryable aggregate progress",
    Number(history.n) > 0 && retrying.phase === "legacy_drain" && retrying.failed === 0 &&
      retrying.retrying === 1 && retrying.complete === false,
    JSON.stringify({ history, retrying }));
  check("a rerun after delayed visibility completes the next verified cut",
    settled.complete === true && settled.total === 2 && settled.confirmed === 2 &&
      settled.remaining === 0,
    JSON.stringify(settled));
}

/* Only current-generation retry authority may classify pending work. Old
   quarantine receipts cannot inflate failure counts or reset a verified cut. */
{
  const { env, db } = makeEnv();
  env.VECTOR_DRAIN_MODE = "paused-for-upgrade";
  insertDocument(db, "drive:retry-count-history");
  insertChunk(db, "drive:retry-count-history#0", "drive:retry-count-history", 0);
  const { options } = await completeRealAcceleratedBootstrap(env, db, { epoch: 35 });
  const history = JSON.stringify(db.prepare("SELECT * FROM vector_bootstrap_batches ORDER BY epoch,batch_no").all());
  const future = 1_000_000;
  for (const [name, quarantine] of [["backoff", null], ["quarantine", 0]]) {
    const doc = `drive:retry-count-${name}`, uid = `${doc}#0`;
    insertDocument(db, doc);
    insertChunk(db, uid, doc, 0);
    db.prepare("INSERT INTO vector_outbox (chunk_uid,vector_id,op,queued_at,attempts) VALUES (?,?,'upsert',60000,1)").run(uid, uid);
    const { generation } = db.prepare("SELECT generation FROM vector_outbox WHERE chunk_uid=?").get(uid);
    const retry = db.prepare(`INSERT INTO vector_outbox_retry_state
      (chunk_uid,generation,attempts,next_attempt_at,last_attempt_at,quarantined_at,failure_code,last_error)
      VALUES (?,?,1,?,60000,?,?,'synthetic vector retry')`);
    retry.run(uid, generation, future, quarantine, quarantine === null ? "visibility_mismatch" : "embedding_failure");
    // An older generation and a receipt without an outbox row have no current authority.
    retry.run(uid, generation - 1, future, 0, "embedding_failure");
  }
  db.prepare(`INSERT INTO vector_outbox_retry_state
    (chunk_uid,generation,attempts,next_attempt_at,last_attempt_at,quarantined_at,failure_code)
    VALUES ('already-confirmed',0,1,1000000,60000,0,'embedding_failure')`).run();
  const before = JSON.stringify(db.prepare("SELECT * FROM vector_outbox ORDER BY chunk_uid").all());
  const receipt = await acceleratedVectorBootstrap(env, options);
  validateAcceleratedBootstrapReceipt(receipt);
  check("bootstrap reports only current quarantine as failed and current backoff as retrying",
    receipt.phase === "legacy_drain" && receipt.failed === 1 && receipt.retrying === 1 &&
      receipt.queued === 2 && receipt.complete === false && receipt.vector_ready === false,
    JSON.stringify(receipt));
  check("retry reporting does not change queued work or completed bootstrap history",
    before === JSON.stringify(db.prepare("SELECT * FROM vector_outbox ORDER BY chunk_uid").all()) &&
      history === JSON.stringify(db.prepare("SELECT * FROM vector_bootstrap_batches ORDER BY epoch,batch_no").all()));
  db.close();
}

/* Contention while paused residue exists preserves its bounded busy receipt. */
{
  const { env, db } = makeEnv();
  env.VECTOR_DRAIN_MODE = "paused-for-upgrade";
  insertDocument(db, "drive:busy-history");
  insertChunk(db, "drive:busy-history#0", "drive:busy-history", 0);
  const { options } = await completeRealAcceleratedBootstrap(env, db, {
    epoch: 40,
    options: acceleratedOptions(70_000),
  });
  insertDocument(db, "drive:busy-residue");
  insertChunk(db, "drive:busy-residue#0", "drive:busy-residue", 0);
  db.prepare(
    `INSERT INTO vector_outbox (chunk_uid,vector_id,op,queued_at)
     VALUES ('drive:busy-residue#0','drive:busy-residue#0','upsert',71000)`,
  ).run();
  const held = await acquireDrainLease(env, {
    ownerToken: "accelerated-residue-owner",
    now: 80_000,
    ttlMs: 10_000,
  });
  const busy = await acceleratedVectorBootstrap(env, options);
  check("paused residue preserves the bounded busy retry delay",
    held.acquired === true && busy.busy === true && busy.retry_after_seconds >= 1 &&
      busy.retry_after_seconds <= 20 && busy.remaining === 1 &&
      !JSON.stringify(busy).includes("accelerated-residue-owner"),
    JSON.stringify({ held, busy }));
  await releaseDrainLease(env, "accelerated-residue-owner");
}

/* Two first calls can both observe the legacy protocol. The loser must acquire
   the writer lease and re-read that boundary before it can delete superseded
   upserts, or it can erase the winner's freshly queued bootstrap batch. */
{
  const { env, db, upsertBatches } = makeEnv({ autoProcessVectorMutations: false });
  env.VECTOR_DRAIN_MODE = "paused-for-upgrade";
  insertDocument(db, "drive:overlap-bootstrap");
  insertChunk(db, "drive:overlap-bootstrap#0", "drive:overlap-bootstrap", 0);
  db.prepare(
    `UPDATE install_state
        SET schema_version=13,vector_projection_status='bootstrap_required',
            vector_projection_bootstrap_epoch=50,
            vector_projection_bootstrap_cursor=NULL,
            vector_projection_bootstrap_high_water=(SELECT MAX(chunk_uid) FROM chunks),
            vector_projection_bootstrap_protocol=NULL,
            vector_projection_bootstrap_base_count=0
      WHERE id=1`,
  ).run();

  const originalPrepare = env.DB.prepare;
  let releaseStaleRead;
  let staleReadCaptured;
  const staleReadReady = new Promise((resolve) => { staleReadCaptured = resolve; });
  const staleReadBarrier = new Promise((resolve) => { releaseStaleRead = resolve; });
  let blockOneStateRead = true;
  env.DB.prepare = (sql) => {
    const statement = originalPrepare(sql);
    if (blockOneStateRead && /SELECT schema_version, vector_projection_status AS status/.test(sql)) {
      blockOneStateRead = false;
      return {
        ...statement,
        first: async () => {
          const stale = await statement.first();
          staleReadCaptured();
          await staleReadBarrier;
          return stale;
        },
      };
    }
    return statement;
  };

  const options = acceleratedOptions(80_000);
  const staleRequest = acceleratedVectorBootstrap(env, options);
  await staleReadReady;
  const winner = await acceleratedVectorBootstrap(env, options);
  releaseStaleRead();
  let overlapError = null;
  try { await staleRequest; } catch (error) { overlapError = error; }
  const ledger = db.prepare(
    `SELECT (SELECT count(*) FROM vector_bootstrap_batches WHERE epoch=50) AS batches,
            (SELECT count(*) FROM vector_outbox WHERE bootstrap_epoch=50) AS owned_rows,
            (SELECT COALESCE(sum(row_count),0) FROM vector_bootstrap_batches WHERE epoch=50) AS expected_rows
       FROM install_state WHERE id=1`,
  ).get();
  check("an overlapping legacy observer cannot erase a newly queued bootstrap batch",
    winner.submitted === 1 && overlapError === null && upsertBatches.length === 1 &&
      Number(ledger.batches) === 1 && Number(ledger.owned_rows) === Number(ledger.expected_rows) &&
      Number(ledger.owned_rows) === 1,
    JSON.stringify({ winner, message: overlapError?.message, ledger, upserts: upsertBatches.length }));
}


console.log(`\n${ran - fail}/${ran} bootstrap history checks passed`);
if (fail) process.exit(1);
