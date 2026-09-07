// A PENDING projection with a LARGE queued residue must be re-projected at bulk
// speed, walking only the queued rows, without deleting anything.
//
// Observed live 2026-09-07: a brain whose accelerated bootstrap had completed
// ('pending', base count frozen at that epoch, zero batches in the current
// epoch) then ingested hundreds of thousands of chunks by ordinary writes. Once
// paused for an upgrade the only path for those rows was the paused drain, one
// provider confirmation per hundred rows: days. The update's safety deadline
// ended it first and the brain stayed paused and mute.
//
// The fix opens a residue-only epoch: base count := chunks with no queued upsert
// row (the outbox is the transactional ledger of unprojected work, so every such
// chunk was confirmed by the bootstrap or the drain), and a fresh epoch pages the
// OUTBOX through the ordinary batch ledger. The walk is exactly the drain's own
// work done at bulk speed, so a small residue keeps the slow path and a modest
// one that trips the threshold merely finishes sooner. Rows the walk cannot page
// (deletes, rows already submitted) drain first so bulk work never regresses to
// cleanup. The exact verification cut is unchanged.
//
// Real SQLite: the property is a state transition across the outbox, the batch
// ledger, the install fence, the events receipt and the provider watermark.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as storeD1 from "../worker/src/lib/store-d1.js";

// Namespace import with fallbacks so this file also RUNS against a tree without
// the fix and fails on the assertions, not on a missing export.
const { acceleratedVectorBootstrap } = storeD1;
const openResidueReprojection = storeD1.openResidueReprojection ?? (async () => { throw new Error("openResidueReprojection is not exported by this tree"); });
const RESIDUE_REPROJECTION_MIN_ROWS = storeD1.RESIDUE_REPROJECTION_MIN_ROWS ?? 1000;
// Residue state lives in install_state.vector_projection_residue_epoch (0036),
// never in the protocol column, which older Workers branch on destructively.

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 400)));
  if (!condition) fail++;
};

function makeEnv({ visibilityLag = 0 } = {}) {
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

  const visible = new Map();
  let mutationSequence = 0;
  let processedUpToMutation = null;
  // Delayed visibility: an accepted mutation becomes "processed" only after
  // `visibilityLag` further REQUESTS (the runner calls env.__tick() before each
  // bootstrap call), so confirmation in the accepting request always waits and
  // the next request has to pick it up, the way the real index behaves. Reads
  // never advance the watermark. Lag 0 is synchronous.
  const pendingMutations = [];
  const accept = (apply) => {
    const mutationId = `fixture-mutation-${++mutationSequence}`;
    apply();
    if (visibilityLag === 0) processedUpToMutation = mutationId;
    else pendingMutations.push({ mutationId, ticksLeft: visibilityLag });
    return { mutationId };
  };
  const observe = () => {};
  const tick = () => {
    for (const pending of pendingMutations) pending.ticksLeft -= 1;
    while (pendingMutations.length && pendingMutations[0].ticksLeft <= 0) {
      processedUpToMutation = pendingMutations.shift().mutationId;
    }
  };
  // Largest number of rows any ONE statement writes. Production residues are
  // hundreds of thousands of rows and D1 bounds a single query, so unbounded
  // work in one statement is a defect no small fixture would otherwise show.
  const widest = { statement: 0 };
  const record = (changes) => { widest.statement = Math.max(widest.statement, Number(changes || 0)); return changes; };
  const prepare = (sql) => {
    const shape = (params = []) => ({
      bind: (...next) => shape(next),
      all: async () => ({ results: db.prepare(sql).all(...params) }),
      first: async () => db.prepare(sql).get(...params) ?? null,
      run: async () => {
        const result = db.prepare(sql).run(...params);
        return { success: true, results: [], meta: { changes: record(Number(result.changes || 0)) } };
      },
      _sql: sql,
      _params: params,
    });
    return shape();
  };
  const env = {
    VECTOR_DRAIN_MODE: "paused-for-upgrade",
    __tick: tick,
    DB: {
      prepare,
      batch: async (statements) => {
        db.exec("BEGIN");
        try {
          const results = statements.map((statement) => {
            const result = db.prepare(statement._sql).run(...statement._params);
            return { success: true, results: [], meta: { changes: record(Number(result.changes || 0)) } };
          });
          db.exec("COMMIT");
          return results;
        } catch (e) { db.exec("ROLLBACK"); throw e; }
      },
    },
    VECTORIZE: {
      upsert: async (vectors) => accept(() => {
        for (const vector of vectors) visible.set(vector.id, structuredClone(vector));
      }),
      deleteByIds: async (ids) => accept(() => { for (const id of ids) visible.delete(id); }),
      getByIds: async (ids) => { observe(); return ids.map((id) => visible.get(id)).filter(Boolean); },
      describe: async () => { observe(); return { vectorCount: visible.size, processedUpToMutation }; },
    },
  };
  return { env, db, visible, widest };
}

const addChunk = (db, uid) => {
  const doc = uid.replace(/#\d+$/, "");
  db.prepare(
    `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash)
     VALUES (?, 'drive', ?, ?, ?, ?)`
  ).run(doc, doc, doc, 1_000, `hash:${doc}`);
  db.prepare(
    `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, vector_id)
     VALUES (?, ?, 0, ?, 'drive', ?)`
  ).run(uid, doc, `text for ${uid}`, uid);
};

/**
 * The live shape. A brain whose bootstrap completed with 3 chunks (the frozen
 * base count), then had `drainedSince` chunks projected by the ordinary drain
 * (visible, no outbox row, NOT in the base count), then `stranded` chunks
 * arrive by ordinary ingest and are still queued when the upgrade pauses it.
 * Optional: some queued rows quarantined, some projected chunks since forgotten
 * (delete rows whose vectors are still visible), and confirmed batches in the
 * current epoch describing the drained chunks.
 */
function seedStaleBrain(db, visible, {
  epoch = 4, stranded = 1200, drainedSince = 10, quarantined = 0, deletes = 0, confirmedBatches = 0,
} = {}) {
  const projected = ["drive:old-a#0", "drive:old-b#0", "drive:old-c#0"];
  for (const uid of projected) {
    addChunk(db, uid);
    visible.set(uid, { id: uid, values: [0.1], metadata: {} });
  }
  db.prepare(
    `UPDATE install_state
        SET schema_version=36,
            vector_projection_status='pending',
            vector_projection_bootstrap_epoch=?1,
            vector_projection_bootstrap_cursor=(SELECT MAX(chunk_uid) FROM chunks),
            vector_projection_bootstrap_high_water=(SELECT MAX(chunk_uid) FROM chunks),
            vector_projection_bootstrap_protocol='bootstrap-v2',
            vector_projection_bootstrap_base_count=(SELECT count(*) FROM chunks)
      WHERE id=1`
  ).run(epoch);
  const drained = [];
  for (let i = 0; i < drainedSince; i++) {
    const uid = `drive:drained-${String(i).padStart(4, "0")}#0`;
    addChunk(db, uid);
    visible.set(uid, { id: uid, values: [0.1], metadata: {} });
    drained.push(uid);
  }
  if (confirmedBatches > 0) {
    const per = Math.ceil(drained.length / confirmedBatches);
    for (let b = 0; b < confirmedBatches; b++) {
      const slice = drained.slice(b * per, (b + 1) * per);
      if (!slice.length) break;
      db.prepare(
        `INSERT INTO vector_bootstrap_batches
           (epoch,batch_no,start_cursor,end_cursor,row_count,status,mutation_id,submitted_at,confirmed_at)
         VALUES (?1,?2,?3,?4,?5,'confirmed','fixture-mutation-0',2500,3000)`
      ).run(epoch, b + 1, b === 0 ? "" : drained[b * per - 1], slice.at(-1), slice.length);
    }
  }
  const uids = [];
  const insert = db.prepare(
    "INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at) VALUES (?1, ?1, 'upsert', 2000)"
  );
  for (let i = 0; i < stranded; i++) {
    const uid = `drive:stale-${String(i).padStart(5, "0")}#0`;
    addChunk(db, uid);
    insert.run(uid);
    uids.push(uid);
  }
  for (let i = 0; i < quarantined; i++) {
    db.prepare(
      `INSERT INTO vector_outbox_retry_state
         (chunk_uid, generation, attempts, next_attempt_at, last_attempt_at, quarantined_at, failure_code)
       SELECT chunk_uid, generation, 9, 0, 1900, 1950, 'fixture' FROM vector_outbox WHERE chunk_uid=?1`
    ).run(uids[i]);
  }
  const forgotten = [];
  for (let i = 0; i < deletes; i++) {
    const uid = `drive:gone-${String(i).padStart(4, "0")}#0`;
    visible.set(uid, { id: uid, values: [0.1], metadata: {} });
    db.prepare(
      "INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at) VALUES (?1, ?1, 'delete', 2100)"
    ).run(uid);
    forgotten.push(uid);
  }
  // The trigger flips a pending projection on every outbox insert; the fixture
  // asserts the field state it is modelling rather than trusting the seed.
  db.prepare("UPDATE install_state SET vector_projection_status='pending' WHERE id=1").run();
  return { stranded: uids, drained, forgotten };
}

const snapshot = (db) => db.prepare(
  `SELECT vector_projection_status AS status,
          vector_projection_bootstrap_base_count AS base,
          vector_projection_bootstrap_epoch AS epoch,
          vector_projection_bootstrap_protocol AS protocol,
          vector_projection_residue_epoch AS residue_epoch,
          vector_projection_bootstrap_cursor AS cursor,
          (SELECT count(*) FROM chunks) AS chunks,
          (SELECT count(*) FROM vector_outbox) AS outbox,
          (SELECT count(*) FROM vector_bootstrap_batches) AS batches,
          (SELECT count(*) FROM vector_projection_events) AS events
     FROM install_state WHERE id=1`
).get();
const events = (db) => db.prepare("SELECT * FROM vector_projection_events ORDER BY id").all();

/** Drive the paused bootstrap to completion, counting embeddings and phases. */
const runToCompletion = async (env, rounds = 400, { now = null } = {}) => {
  let clock = 100_000;
  let embeds = 0;
  const options = {
    contract: 2,
    now: now ?? (() => (clock += 60_000)),
    embed: async () => { embeds++; return [0.1]; },
    embedBatch: async (texts) => { embeds += texts.length; return texts.map(() => [0.1]); },
  };
  const phases = [];
  let receipt = null;
  let first = null;
  let used = 0;
  for (let round = 0; round < rounds && !receipt?.complete; round++) {
    env.__tick?.();
    receipt = await acceleratedVectorBootstrap(env, options);
    if (!first) first = receipt;
    phases.push(receipt.phase);
    used = round + 1;
  }
  return { receipt, first, phases, embeds, rounds_used: used };
};
const neverRegresses = (phases) => {
  let building = false;
  for (const phase of phases) {
    if (phase === "building") building = true;
    if (building && phase === "legacy_drain") return false;
  }
  return true;
};

// ---------------------------------------------------------------------------
// 1. The live shape: residue-only re-projection, terminal state independent of
//    any round cap, and only the queued rows re-embedded.
// ---------------------------------------------------------------------------
{
  const { env, db, visible } = makeEnv();
  const { stranded } = seedStaleBrain(db, visible, { epoch: 4, stranded: 1200, drainedSince: 10 });
  const before = snapshot(db);
  check("fixture precondition: pending, frozen base, big residue, no batches, no receipt, no residue epoch",
    before.status === "pending" && Number(before.base) === 3 && Number(before.chunks) === 1213 &&
      Number(before.outbox) === 1200 && Number(before.batches) === 0 && Number(before.events) === 0 &&
      before.residue_epoch === null && before.protocol === "bootstrap-v2",
    JSON.stringify(before));

  const run = await runToCompletion(env);
  const after = snapshot(db);
  console.log(`  [live shape] rounds_used=${run.rounds_used} embeds=${run.embeds} phases=${[...new Set(run.phases)].join(",")}`);
  check("the update completes and the projection ends verified",
    run.receipt?.complete === true && after.status === "verified", JSON.stringify({ receipt: run.receipt, after }));
  check("only the queued residue is re-embedded, not the whole corpus",
    run.embeds === 1200, `embeds=${run.embeds} (corpus 1213)`);
  check("every chunk is visible and nothing extra is",
    stranded.every((uid) => visible.has(uid)) && visible.size === 1213, `visible=${visible.size}`);
  // A residue epoch rebases in the request that verifies, not on the next call:
  // its base count cannot certify rows the ordinary drain projected after the
  // walk closed. So the terminal state is the whole corpus as the base.
  check("outbox empty, base count rebased to the whole corpus, counts exact",
    Number(after.outbox) === 0 && Number(after.base) === 1213 &&
      run.receipt.confirmed === 1213 && run.receipt.total === 1213 && run.receipt.remaining === 0 &&
      run.receipt.actual_vectors === 1213 && run.receipt.expected_vectors === 1213,
    JSON.stringify({ after, receipt: run.receipt }));
  check("one durable receipt records the bookkeeping change with both base counts",
    (() => {
      const ev = events(db);
      return ev.length === 1 && ev[0].kind === "residue-reprojection" &&
        Number(ev[0].epoch_before) === 4 && Number(ev[0].epoch_after) === 5 &&
        Number(ev[0].base_before) === 3 && Number(ev[0].base_after) === 13 &&
        Number(ev[0].rows) === 1200 && Number(ev[0].chunks) === 1213 && Number(ev[0].at) > 0;
    })(), JSON.stringify(events(db)));
  // The column keeps naming the epoch that WAS the residue epoch (it is the
  // durable fact the anti-reopen guard reads); what ends the walk is the status.
  check("the epoch advanced twice (open, then the verifying rebase) and no residue walk is open at the end",
    Number(after.epoch) === 6 && after.protocol === "bootstrap-v2" &&
      Number(after.residue_epoch) !== Number(after.epoch) && after.status === "verified",
    JSON.stringify(after));
  check("receipts name the residue-only re-projection while the epoch is open, not once it has verified",
    run.first?.reprojected_residue === 1200 && run.receipt?.reprojected_residue === undefined,
    JSON.stringify({ first: run.first?.reprojected_residue, last: run.receipt?.reprojected_residue }));
  check("the phase never falls back to cleanup after bulk work began", neverRegresses(run.phases), run.phases.join(","));
  check("latency: bulk walk finishes within a handful of rounds where the drain needed dozens",
    run.rounds_used <= 5, `rounds_used=${run.rounds_used}`);

  // -------------------------------------------------------------------------
  // 1a. THE CROSS-VERSION INVARIANT. An older Worker knows nothing of the
  //     residue column: it sees an ordinary v2 walk and pages the corpus from
  //     the cursor with a plain outbox INSERT, which collides with any queued
  //     row above it. The open therefore parks the cursor AT the high water, so
  //     an older Worker pages nothing and only submits, confirms and drains.
  //     Assert that on every round, together with the ledger invariant that no
  //     row is tagged for a page that has no ledger row: it is what keeps a
  //     re-run from a sealed kit from wedging on a UNIQUE collision.
  // -------------------------------------------------------------------------
  {
    const { env: env2, db: db2, visible: visible2 } = makeEnv();
    seedStaleBrain(db2, visible2, { epoch: 4, stranded: 3000, drainedSince: 10 });
    const invariant = () => db2.prepare(
      `SELECT (SELECT count(*) FROM chunks WHERE chunk_uid >
                 COALESCE((SELECT vector_projection_bootstrap_cursor FROM install_state WHERE id=1), '')) AS pageable_by_old,
              (SELECT count(*) FROM vector_outbox WHERE bootstrap_epoch IS NOT NULL
                 AND bootstrap_batch > COALESCE((SELECT MAX(batch_no) FROM vector_bootstrap_batches
                                                  WHERE epoch=(SELECT vector_projection_bootstrap_epoch FROM install_state WHERE id=1)), 0)) AS tagged_without_ledger,
              vector_projection_residue_epoch AS residue_epoch
         FROM install_state WHERE id=1`
    ).get();
    let worstUntagged = 0;
    let worstPageable = 0;
    let sawOpenWalk = false;
    let receipt2 = null;
    let clock2 = 100_000;
    for (let round = 0; round < 8 && !receipt2?.complete; round++) {
      env2.__tick?.();
      receipt2 = await acceleratedVectorBootstrap(env2, {
        contract: 2,
        now: () => (clock2 += 60_000),
        embed: async () => [0.1],
        embedBatch: async (texts) => texts.map(() => [0.1]),
      });
      const seen = invariant();
      if (seen.residue_epoch !== null) {
        sawOpenWalk = true;
        worstUntagged = Math.max(worstUntagged, Number(seen.tagged_without_ledger));
        worstPageable = Math.max(worstPageable, Number(seen.pageable_by_old));
      }
    }
    check("through every round of an open walk an older Worker would page nothing, and no row is tagged without its ledger row",
      sawOpenWalk && worstUntagged === 0 && worstPageable === 0 && receipt2?.complete === true,
      JSON.stringify({ sawOpenWalk, worstUntagged, worstPageable, complete: receipt2?.complete, state: invariant() }));
  }

  // -------------------------------------------------------------------------
  // 1b. The SECOND update. The brain keeps ingesting (40 rows, below the
  //     threshold) and is paused again. A residue marker left behind would make
  //     the residue-aware drain skip those rows forever; this must converge.
  // -------------------------------------------------------------------------
  for (let i = 0; i < 40; i++) {
    const uid = `drive:second-${String(i).padStart(3, "0")}#0`;
    addChunk(db, uid);
    db.prepare("INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at) VALUES (?1, ?1, 'upsert', 9000)").run(uid);
  }
  const between = snapshot(db);
  const second = await runToCompletion(env, 10);
  const afterSecond = snapshot(db);
  check("ingest after a completed residue walk flips the projection back to pending",
    between.status === "pending" && Number(between.outbox) === 40, JSON.stringify(between));
  check("a later small queue on the same brain drains and verifies (no residue marker left behind)",
    second.receipt?.complete === true && Number(afterSecond.outbox) === 0 && visible.size === 1253 &&
      second.embeds === 40 && Number(afterSecond.events) === 1 && afterSecond.status === "verified",
    JSON.stringify({ afterSecond, embeds: second.embeds, rounds: second.rounds_used, phases: second.phases }));
}

// ---------------------------------------------------------------------------
// 1c. The same regression from the other side: a residue epoch whose walk
//     finished but never verified leaves the marker with status pending. A
//     small queue must still drain the ordinary way.
// ---------------------------------------------------------------------------
{
  const { env, db, visible } = makeEnv();
  seedStaleBrain(db, visible, { epoch: 6, stranded: 40, drainedSince: 10 });
  db.prepare("UPDATE install_state SET vector_projection_residue_epoch=vector_projection_bootstrap_epoch WHERE id=1").run();
  const run = await runToCompletion(env, 10);
  const after = snapshot(db);
  check("a pending brain carrying the residue marker still drains a small queue and verifies",
    run.receipt?.complete === true && Number(after.outbox) === 0 && run.embeds === 40 && after.status === "verified",
    JSON.stringify({ after, embeds: run.embeds, phases: run.phases }));
}

// ---------------------------------------------------------------------------
// 1d. Delayed provider visibility: every accepted mutation becomes visible
//     only after a later read. Confirmation must wait and retry, and the
//     terminal state must be the same.
// ---------------------------------------------------------------------------
{
  const { env, db, visible } = makeEnv({ visibilityLag: 1 });
  seedStaleBrain(db, visible, { epoch: 4, stranded: 1200, drainedSince: 10 });
  const run = await runToCompletion(env, 40);
  const after = snapshot(db);
  check("with delayed visibility the residue walk still converges to the exact verified state",
    run.receipt?.complete === true && run.embeds === 1200 && Number(after.outbox) === 0 &&
      visible.size === 1213 && after.status === "verified" && Number(after.events) === 1 && neverRegresses(run.phases),
    JSON.stringify({ after, embeds: run.embeds, rounds: run.rounds_used, phases: [...new Set(run.phases)] }));
}

// ---------------------------------------------------------------------------
// 1e. SCALE. Production residues are hundreds of thousands of rows and D1
//     bounds what one query may do, so every request must do bounded work no
//     matter how large the residue. An earlier draft tagged the whole residue
//     in one statement: 20,000 rows took 4.7 s on local in-memory SQLite and
//     the cost was quadratic, which could never fit a real brain.
// ---------------------------------------------------------------------------
{
  const { env, db, visible, widest } = makeEnv();
  const RESIDUE = 5_000;
  seedStaleBrain(db, visible, { epoch: 4, stranded: RESIDUE, drainedSince: 10 });
  const started = performance.now();
  const run = await runToCompletion(env);
  const elapsed = performance.now() - started;
  const after = snapshot(db);
  const ledger = db.prepare("SELECT count(*) AS pages, MAX(row_count) AS widest_page FROM vector_bootstrap_batches WHERE epoch=5").get();
  check("a 5,000-row residue converges and every page is one bounded ledger row",
    run.receipt?.complete === true && after.status === "verified" && run.embeds === RESIDUE &&
      Number(ledger.pages) === RESIDUE / 1000 && Number(ledger.widest_page) === 1000,
    JSON.stringify({ ledger, embeds: run.embeds, rounds: run.rounds_used }));
  check("no single statement writes more than one page, so the work per request is bounded at any residue size",
    widest.statement <= 1000, `widest single statement wrote ${widest.statement} rows`);
  console.log(`  [scale] ${RESIDUE} rows: ${run.rounds_used} rounds, ${Math.round(elapsed)} ms, widest statement ${widest.statement} rows`);
}

// ---------------------------------------------------------------------------
// 1f. THE PARKED CURSOR MUST NOT STRAND ANY LATER WALK. The open parks
//     install_state's cursor at the high water for the life of the epoch, so
//     three later paths get checked here: a big release after the walk closed
//     must be able to open a FRESH residue epoch (not crawl at a hundred rows
//     per confirmation); an ordinary bootstrap after a reset must walk the
//     whole corpus; and a truncated ledger must restart the walk rather than
//     skip a range.
// ---------------------------------------------------------------------------
{
  // A big residue, half of it quarantined. The walk projects what it can, the
  // update refuses by name, then vector-retry releases 600 rows.
  const { env, db, visible } = makeEnv();
  // 1,500 pageable and 1,500 quarantined: both sides are above the threshold,
  // so the first walk opens and the release can open a second one.
  seedStaleBrain(db, visible, { epoch: 4, stranded: 3000, drainedSince: 10, quarantined: 1500 });
  await runToCompletion(env, 12);
  const closed = snapshot(db);
  check("after a walk closes with quarantined rows left the projection is pending, not stuck mid-walk",
    closed.status === "pending" && Number(closed.outbox) === 1500 && Number(closed.events) === 1,
    JSON.stringify(closed));
  db.prepare("DELETE FROM vector_outbox_retry_state WHERE quarantined_at IS NOT NULL").run();
  db.prepare("UPDATE vector_outbox SET attempts=0, last_error=NULL").run();
  const released = await runToCompletion(env, 20);
  const after = snapshot(db);
  const epochs = db.prepare("SELECT count(DISTINCT epoch) AS n FROM vector_bootstrap_batches").get();
  check("releasing 1,500 rows opens a FRESH residue epoch and converges at bulk speed, not a hundred at a time",
    released.receipt?.complete === true && after.status === "verified" && Number(after.outbox) === 0 &&
      visible.size === 3013 && Number(after.events) === 2 && Number(epochs.n) === 2 && released.rounds_used <= 6,
    JSON.stringify({ after, events: after.events, epochs: epochs.n, rounds: released.rounds_used }));
}
{
  // An ordinary bootstrap after the projection is reset: the reset clears the
  // cursor, so a parked cursor from a past residue epoch strands nothing.
  const { env, db, visible } = makeEnv();
  seedStaleBrain(db, visible, { epoch: 4, stranded: 1200, drainedSince: 10 });
  await runToCompletion(env);
  visible.clear();
  db.prepare(
    `UPDATE install_state SET vector_projection_status='bootstrap_required',
            vector_projection_bootstrap_epoch=vector_projection_bootstrap_epoch+1,
            vector_projection_bootstrap_cursor=NULL,
            vector_projection_bootstrap_high_water=(SELECT MAX(chunk_uid) FROM chunks),
            vector_projection_bootstrap_base_count=0 WHERE id=1`
  ).run();
  db.prepare("DELETE FROM vector_bootstrap_batches").run();
  const rebuilt = await runToCompletion(env);
  const after = snapshot(db);
  check("a later ordinary bootstrap walks the WHOLE corpus: the parked cursor is not inherited",
    rebuilt.receipt?.complete === true && rebuilt.embeds === 1213 && visible.size === 1213 && after.status === "verified",
    JSON.stringify({ embeds: rebuilt.embeds, visible: visible.size, after }));
}
{
  // The ledger is the walk's progress. If it is lost mid-walk (a restore that
  // replays install_state without the batch rows), the walk must restart from
  // the beginning of the residue and still converge: upserts are idempotent,
  // so re-walking a range is waste, never a skip.
  const { env, db, visible } = makeEnv();
  seedStaleBrain(db, visible, { epoch: 4, stranded: 2500, drainedSince: 10 });
  await runToCompletion(env, 1);
  const mid = db.prepare("SELECT count(*) AS pages, MAX(end_cursor) AS cursor FROM vector_bootstrap_batches").get();
  db.prepare("DELETE FROM vector_bootstrap_batches").run();
  db.prepare("UPDATE vector_outbox SET bootstrap_epoch=NULL, bootstrap_batch=NULL").run();
  const resumed = await runToCompletion(env, 30);
  const after = snapshot(db);
  // Rows already accepted by the index still carry their submission receipt, so
  // they confirm through the ordinary path; rows that had not been submitted are
  // pageable again and the walk re-claims them from the start of the residue.
  // Either way no range can be skipped, because a row leaves the outbox only on
  // proof, and re-walking one is waste rather than loss.
  check("a lost ledger cannot skip a range: every chunk still reaches the index and the projection verifies",
    Number(mid.pages) > 0 && resumed.receipt?.complete === true && after.status === "verified" &&
      Number(after.outbox) === 0 && visible.size === 2513,
    JSON.stringify({ mid, after, visible: visible.size }));
}

// ---------------------------------------------------------------------------
// 1g. TERMINATION. A closed walk leaves the projection pending, which is also
//     what opens one, so a walk that confirms nothing must not reopen itself
//     forever. Simulate the shape: the epoch is marked as a residue epoch that
//     confirmed no rows, with a residue still queued above the threshold.
// ---------------------------------------------------------------------------
{
  const { env, db, visible } = makeEnv();
  seedStaleBrain(db, visible, { epoch: 4, stranded: 1500, drainedSince: 10 });
  // The durable fact lives in install_state: this epoch WAS a residue epoch.
  db.prepare("UPDATE install_state SET vector_projection_residue_epoch=vector_projection_bootstrap_epoch WHERE id=1").run();
  db.prepare(
    `INSERT INTO vector_projection_events (at, kind, epoch_before, epoch_after, base_before, base_after, rows, chunks)
     VALUES (10, 'residue-reprojection', 3, 4, 3, 13, 1500, 1513)`
  ).run();
  const before = snapshot(db);
  const run = await runToCompletion(env, 3);
  const after = snapshot(db);
  check("an epoch that opened as a residue walk and confirmed nothing does not reopen another",
    Number(after.epoch) === Number(before.epoch) && Number(after.events) === 1,
    JSON.stringify({ before, after }));
  check("and the rows are not abandoned: the ordinary paused drain takes them",
    Number(after.outbox) < 1500 && run.phases.every((p) => p === "legacy_drain" || p === "waiting"),
    JSON.stringify({ outbox: after.outbox, phases: [...new Set(run.phases)] }));
}

{
  // The same, with the receipt row GONE (a lost write, a truncated table, a
  // restore that replayed install_state without it). The guard must still hold,
  // which is why the productivity fact lives in install_state, not in that row.
  const { env, db, visible } = makeEnv();
  seedStaleBrain(db, visible, { epoch: 4, stranded: 1500, drainedSince: 10 });
  db.prepare("UPDATE install_state SET vector_projection_residue_epoch=vector_projection_bootstrap_epoch WHERE id=1").run();
  const before = snapshot(db);
  await runToCompletion(env, 3);
  const after = snapshot(db);
  check("with no receipt row at all an unproductive residue epoch still cannot reopen",
    Number(after.epoch) === Number(before.epoch) && Number(after.events) === 0 && Number(before.events) === 0,
    JSON.stringify({ before, after }));
}

{
  // THE CONJUNCTION INVARIANT, through the real reset. The column stays set
  // after a close, so a full rebuild must not read it as an open residue walk:
  // if it did, the walk would page the OUTBOX and silently omit every chunk
  // with no queued row. resetVectorProjectionBootstrap advances the epoch in
  // the same statement, so the stale column cannot match.
  const { env, db, visible } = makeEnv();
  seedStaleBrain(db, visible, { epoch: 4, stranded: 1200, drainedSince: 10 });
  await runToCompletion(env);
  const closed = snapshot(db);
  check("after a completed residue walk the column still names its epoch, and that epoch is past",
    Number(closed.residue_epoch) === 5 && Number(closed.epoch) === 6 && closed.status === "verified",
    JSON.stringify(closed));

  // A full rebuild: a new provider index, nothing projected, no outbox at all.
  visible.clear();
  const reset = await storeD1.resetVectorProjectionBootstrap(env);
  const afterReset = snapshot(db);
  check("the reset advances the epoch past the stale column, so no residue walk can be open",
    afterReset.status === "bootstrap_required" && Number(afterReset.epoch) > Number(afterReset.residue_epoch) &&
      afterReset.cursor === null && Number(afterReset.outbox) === 0,
    JSON.stringify({ reset: reset ?? null, afterReset }));

  const rebuilt = await runToCompletion(env);
  const after = snapshot(db);
  const unqueued = db.prepare(
    "SELECT count(*) AS n FROM chunks WHERE chunk_uid NOT IN (SELECT chunk_uid FROM vector_outbox)"
  ).get();
  check("the rebuild pages the CORPUS: every chunk is projected, including the 1,213 with no queued row",
    rebuilt.receipt?.complete === true && rebuilt.embeds === 1213 && visible.size === 1213 &&
      Number(unqueued.n) === 1213 && after.status === "verified",
    JSON.stringify({ embeds: rebuilt.embeds, visible: visible.size, unqueued: unqueued.n, after }));
}

// ---------------------------------------------------------------------------
// 2. Threshold boundary: exactly the ceiling keeps the slow path, one more opens.
// ---------------------------------------------------------------------------
{
  const { env, db, visible } = makeEnv();
  seedStaleBrain(db, visible, { epoch: 6, stranded: RESIDUE_REPROJECTION_MIN_ROWS, drainedSince: 0 });
  const run = await runToCompletion(env);
  const after = snapshot(db);
  check(`a residue of exactly ${RESIDUE_REPROJECTION_MIN_ROWS} rows drains in place: no epoch opened, no receipt`,
    run.receipt?.complete === true && Number(after.events) === 0 && Number(after.epoch) === 6 &&
      run.embeds === RESIDUE_REPROJECTION_MIN_ROWS && after.status === "verified",
    JSON.stringify({ after, embeds: run.embeds }));
}
{
  const { env, db, visible } = makeEnv();
  seedStaleBrain(db, visible, { epoch: 6, stranded: RESIDUE_REPROJECTION_MIN_ROWS + 1, drainedSince: 0 });
  const run = await runToCompletion(env);
  const after = snapshot(db);
  check(`a residue of ${RESIDUE_REPROJECTION_MIN_ROWS + 1} rows opens a residue-only epoch and embeds exactly those`,
    run.receipt?.complete === true && Number(after.events) === 1 && run.embeds === RESIDUE_REPROJECTION_MIN_ROWS + 1,
    JSON.stringify({ after, embeds: run.embeds }));
}

// ---------------------------------------------------------------------------
// 3. Confirmed batches already in the current epoch are neither discarded nor
//    re-embedded: the residue epoch embeds only the queue.
// ---------------------------------------------------------------------------
{
  const { env, db, visible } = makeEnv();
  seedStaleBrain(db, visible, { epoch: 9, stranded: 1200, drainedSince: 10, confirmedBatches: 5 });
  const before = snapshot(db);
  const run = await runToCompletion(env);
  const after = snapshot(db);
  check("five confirmed batches plus a 1,200-row queue re-embed 1,200, not 1,210 and not the corpus",
    Number(before.batches) === 5 && run.receipt?.complete === true && run.embeds === 1200 &&
      after.status === "verified" && Number(after.outbox) === 0,
    JSON.stringify({ before, embeds: run.embeds, after }));
}

// ---------------------------------------------------------------------------
// 4. A bulk walk genuinely in progress is untouched: bootstrap_required never
//    opens a residue epoch.
// ---------------------------------------------------------------------------
{
  const { env, db, visible } = makeEnv();
  seedStaleBrain(db, visible, { epoch: 4, stranded: 0, drainedSince: 1200 });
  db.prepare(
    `UPDATE install_state SET vector_projection_status='bootstrap_required',
            vector_projection_bootstrap_cursor=NULL, vector_projection_bootstrap_base_count=0 WHERE id=1`
  ).run();
  const run = await runToCompletion(env);
  const after = snapshot(db);
  check("a mid-walk brain walks its whole corpus and never opens a residue epoch",
    run.receipt?.complete === true && Number(after.events) === 0 && run.embeds === 1203 && after.status === "verified",
    JSON.stringify({ after, embeds: run.embeds }));
}

// ---------------------------------------------------------------------------
// 5. Deletes drain BEFORE the residue epoch opens, reach the provider, leave no
//    ghost, and the phase order is cleanup then bulk, never the reverse.
// ---------------------------------------------------------------------------
{
  const { env, db, visible } = makeEnv();
  const { forgotten } = seedStaleBrain(db, visible, { epoch: 4, stranded: 1200, drainedSince: 10, deletes: 30 });
  const run = await runToCompletion(env);
  const after = snapshot(db);
  check("every forgotten chunk's vector is gone and every live chunk's vector is present",
    forgotten.every((uid) => !visible.has(uid)) && visible.size === 1213 && Number(after.outbox) === 0,
    `visible=${visible.size} outbox=${after.outbox}`);
  // Thirty deletes clear inside the first request's bounded drain, so the epoch
  // opens in that same request; a larger cleanup would show legacy_drain first.
  // Either way bulk work must never regress to cleanup once it has begun.
  check("cleanup completed before bulk work began and the phase never regressed",
    run.phases.includes("building") && neverRegresses(run.phases), run.phases.join(","));
  check("the residue epoch still opened and converged", Number(after.events) === 1 && run.receipt?.complete === true,
    JSON.stringify(after));
}

// ---------------------------------------------------------------------------
// 6. Quarantined queued rows are EXCLUDED from the walk, not blockers of it:
//    everything else is embedded, then the update ends by name with the count
//    and remedies, and a release (vector-retry) lets it finish.
// ---------------------------------------------------------------------------
{
  const { env, db, visible } = makeEnv();
  seedStaleBrain(db, visible, { epoch: 4, stranded: 1200, drainedSince: 10, quarantined: 50 });
  const run = await runToCompletion(env, 12);
  const mid = snapshot(db);
  check("with 50 quarantined rows the walk still embeds the other 1,150 and never regresses to cleanup",
    run.embeds === 1150 && visible.size === 1163 && neverRegresses(run.phases) && Number(mid.events) === 1,
    JSON.stringify({ embeds: run.embeds, visible: visible.size, phases: [...new Set(run.phases)] }));
  check("then the update ends by name: quarantine, 50 rows, phase waiting, walk exhausted and closed",
    run.receipt?.complete === false && run.receipt?.phase === "waiting" && run.receipt?.blocked_on === "quarantine" &&
      run.receipt?.blocked_rows === 50 && Number(mid.outbox) === 50 && mid.status === "pending",
    JSON.stringify({ receipt: run.receipt, mid }));
  // The remedy the refusal names: release the quarantined rows, re-run.
  db.prepare("DELETE FROM vector_outbox_retry_state WHERE quarantined_at IS NOT NULL").run();
  db.prepare("UPDATE vector_outbox SET attempts=0, last_error=NULL").run();
  const released = await runToCompletion(env, 20);
  const after = snapshot(db);
  check("after vector-retry the released rows drain and the projection verifies exactly",
    released.receipt?.complete === true && released.embeds === 50 && Number(after.outbox) === 0 &&
      visible.size === 1213 && after.status === "verified",
    JSON.stringify({ after, embeds: released.embeds, phases: [...new Set(released.phases)] }));
}

// ---------------------------------------------------------------------------
// 6c. Cause priority before the open: quarantined rows do not block it, rows the
//     drain had submitted but the index never processed do, and they are named
//     as the fence with THEIR count.
// ---------------------------------------------------------------------------
{
  const { env, db, visible } = makeEnv();
  const { stranded } = seedStaleBrain(db, visible, { epoch: 4, stranded: 1200, drainedSince: 10, quarantined: 5 });
  for (const uid of stranded.slice(100, 103)) {
    db.prepare("UPDATE vector_outbox SET submitted_mutation_id='fixture-mutation-stranded', submitted_at=2500 WHERE chunk_uid=?1").run(uid);
  }
  db.prepare("UPDATE install_state SET vector_projection_mutation_id='fixture-mutation-stranded', vector_projection_submitted_at=2500 WHERE id=1").run();
  const run = await runToCompletion(env, 2);
  const after = snapshot(db);
  check("three unprocessed submitted rows beside five quarantined ones report the fence with count 3",
    run.first?.phase === "legacy_drain" && run.first?.blocked_on === "fence" && run.first?.blocked_rows === 3 &&
      Number(after.events) === 0 && run.embeds === 0,
    JSON.stringify({ first: run.first, after }));
}

// ---------------------------------------------------------------------------
// 6b. A row the paused drain had already submitted, whose mutation the index has
//     not processed, is a FENCE blocker: named as such, nothing opened.
// ---------------------------------------------------------------------------
{
  const { env, db, visible } = makeEnv();
  const { stranded } = seedStaleBrain(db, visible, { epoch: 4, stranded: 1200, drainedSince: 10 });
  db.prepare(
    "UPDATE vector_outbox SET submitted_mutation_id='fixture-mutation-stranded', submitted_at=2500 WHERE chunk_uid=?1"
  ).run(stranded[0]);
  db.prepare(
    "UPDATE install_state SET vector_projection_mutation_id='fixture-mutation-stranded', vector_projection_submitted_at=2500 WHERE id=1"
  ).run();
  const run = await runToCompletion(env, 3);
  const after = snapshot(db);
  check("an unprocessed submitted row is reported as the fence on every receipt, with its count, and the open waits",
    run.phases.every((p) => p === "legacy_drain") && run.first?.blocked_on === "fence" && run.first?.blocked_rows === 1 &&
      run.receipt?.blocked_on === "fence" && after.status === "pending" && Number(after.events) === 0 && run.embeds === 0,
    JSON.stringify({ first: run.first, after, embeds: run.embeds }));
}

// ---------------------------------------------------------------------------
// 7. Idempotence under interruption: the open committed but the request died
//    before any page queued. The next request resumes the walk; the paused
//    drain does not eat the queue first.
// ---------------------------------------------------------------------------
{
  const { env, db, visible } = makeEnv();
  seedStaleBrain(db, visible, { epoch: 4, stranded: 1200, drainedSince: 10 });
  // The state an open leaves behind: cursor parked at the high water and the
  // residue column naming the epoch. Rows are tagged a page at a time as the
  // walk claims them, so nothing is tagged yet.
  db.prepare(
    `UPDATE install_state
        SET vector_projection_status='bootstrap_required',
            vector_projection_bootstrap_epoch=5,
            vector_projection_bootstrap_cursor=(SELECT MAX(chunk_uid) FROM vector_outbox WHERE op='upsert'),
            vector_projection_bootstrap_high_water=(SELECT MAX(chunk_uid) FROM vector_outbox WHERE op='upsert'),
            vector_projection_bootstrap_protocol='bootstrap-v2',
            vector_projection_residue_epoch=5,
            vector_projection_bootstrap_base_count=13
      WHERE id=1`
  ).run();

  db.prepare(
    `INSERT INTO vector_projection_events (at, kind, epoch_before, epoch_after, base_before, base_after, rows, chunks)
     VALUES (99, 'residue-reprojection', 4, 5, 3, 13, 1200, 1213)`
  ).run();
  const run = await runToCompletion(env);
  const after = snapshot(db);
  check("an opened-but-unpaged residue epoch resumes as a bulk walk of exactly the queue",
    run.receipt?.complete === true && run.embeds === 1200 && Number(after.outbox) === 0 &&
      after.status === "verified" && neverRegresses(run.phases) && run.rounds_used <= 5,
    JSON.stringify({ after, embeds: run.embeds, phases: run.phases }));
}

// ---------------------------------------------------------------------------
// 8. Atomicity: if the receipt cannot be written, the state transition does not
//    happen either. Nothing is half-opened, nothing is deleted.
// ---------------------------------------------------------------------------
{
  const { env, db, visible } = makeEnv();
  seedStaleBrain(db, visible, { epoch: 4, stranded: 1200, drainedSince: 10 });
  db.exec("DROP TABLE vector_projection_events");
  let error = null;
  try { await runToCompletion(env, 1); } catch (e) { error = e; }
  const after = db.prepare(
    `SELECT vector_projection_status AS status, vector_projection_bootstrap_epoch AS epoch,
            vector_projection_bootstrap_base_count AS base, (SELECT count(*) FROM vector_outbox) AS outbox
       FROM install_state WHERE id=1`
  ).get();
  check("a failed receipt write rolls the open back: still pending, same epoch, same base, queue intact",
    error !== null && after.status === "pending" && Number(after.epoch) === 4 && Number(after.base) === 3 &&
      Number(after.outbox) === 1200,
    JSON.stringify({ error: String(error?.message), after }));
}

// ---------------------------------------------------------------------------
// 9. Fencing: a caller without the drain lease cannot open the epoch.
// ---------------------------------------------------------------------------
{
  const { env, db, visible } = makeEnv();
  seedStaleBrain(db, visible, { epoch: 4, stranded: 1200, drainedSince: 10 });
  const state = { status: "pending", schema_version: 36, epoch: 4, baseCount: 3, protocol: "bootstrap-v2" };
  let error = null;
  try {
    await openResidueReprojection(env, state, { embed: async () => [0.1], embedBatch: async (t) => t.map(() => [0.1]) },
      { ownerToken: "not-the-lease-owner", now: () => 5_000_000 });
  } catch (e) { error = e; }
  const after = snapshot(db);
  check("a write without the lease changes nothing and says so",
    error !== null && /unchanged/.test(String(error?.message)) && after.status === "pending" &&
      Number(after.epoch) === 4 && Number(after.base) === 3 && Number(after.outbox) === 1200 && Number(after.events) === 0,
    JSON.stringify({ error: String(error?.message), after }));
}

// ---------------------------------------------------------------------------
// 9b. A lease held by SOMEONE ELSE, live, is refused the same way.
// ---------------------------------------------------------------------------
{
  const { env, db, visible } = makeEnv();
  seedStaleBrain(db, visible, { epoch: 4, stranded: 1200, drainedSince: 10 });
  db.prepare("UPDATE install_state SET vector_drain_lease_owner='someone-else', vector_drain_lease_expires_at=9999999999 WHERE id=1").run();
  const state = { status: "pending", schema_version: 36, epoch: 4, baseCount: 3, protocol: "bootstrap-v2" };
  let error = null;
  try {
    await openResidueReprojection(env, state, { embed: async () => [0.1], embedBatch: async (x) => x.map(() => [0.1]) },
      { ownerToken: "mine", now: () => 5_000_000 });
  } catch (e) { error = e; }
  const after = snapshot(db);
  check("a live lease owned by another holder refuses the open and changes nothing",
    error !== null && /unchanged/.test(String(error?.message)) && after.status === "pending" &&
      Number(after.epoch) === 4 && Number(after.outbox) === 1200 && Number(after.events) === 0,
    JSON.stringify({ error: String(error?.message), after }));
}

// ---------------------------------------------------------------------------
// 9c. The lease expires mid-request, after the open committed and before the
//     first page queues. No phantom batch row may commit; the next request,
//     with a fresh lease, resumes and converges.
// ---------------------------------------------------------------------------
{
  const { env, db, visible } = makeEnv();
  seedStaleBrain(db, visible, { epoch: 4, stranded: 1200, drainedSince: 10 });
  let clock = 100_000;
  let jumped = false;
  const now = () => {
    if (!jumped && db.prepare("SELECT count(*) AS n FROM vector_projection_events").get().n > 0) {
      jumped = true;
      clock += 30 * 60_000; // past the 20-minute lease TTL
    }
    return (clock += 60_000);
  };
  let error = null;
  try { await runToCompletion(env, 1, { now }); } catch (e) { error = e; }
  const batches = db.prepare("SELECT count(*) AS n FROM vector_bootstrap_batches WHERE epoch=5").get().n;
  const mid = snapshot(db);
  check("a lease lost between open and first page fails by name and commits no phantom batch row",
    error !== null && /lost its drain lease/.test(String(error?.message)) && Number(batches) === 0 &&
      mid.status === "bootstrap_required" && Number(mid.events) === 1,
    JSON.stringify({ error: String(error?.message), batches, mid }));
  const resumed = await runToCompletion(env);
  const after = snapshot(db);
  check("the next request resumes the opened epoch and converges",
    resumed.receipt?.complete === true && Number(after.outbox) === 0 && resumed.embeds === 1200 && after.status === "verified",
    JSON.stringify({ after, embeds: resumed.embeds }));
}

// ---------------------------------------------------------------------------
// 9d. Cleanup larger than one request drains: the receipt names cleanup with
//     the rows left, then bulk work follows, and nothing regresses.
// ---------------------------------------------------------------------------
{
  const { env, db, visible } = makeEnv();
  const { forgotten } = seedStaleBrain(db, visible, { epoch: 4, stranded: 1200, drainedSince: 10, deletes: 2500 });
  const run = await runToCompletion(env);
  const after = snapshot(db);
  // Cleanup that is still moving carries NO named cause: the drain is doing its
  // ordinary work and the CLI must not be told anything is in the way. Only a
  // cause nothing can clear (quarantine, a stranded fence) is named.
  check("a 2,500-row cleanup drains in the ordinary phase with no named cause",
    run.first?.phase === "legacy_drain" && run.first?.blocked_on === undefined &&
      run.first?.blocked_rows === undefined,
    JSON.stringify({ phase: run.first?.phase, blocked_on: run.first?.blocked_on, queued: run.first?.queued }));
  check("then the deletes finish, the residue epoch opens, and it converges with no ghost vector",
    run.receipt?.complete === true && forgotten.every((uid) => !visible.has(uid)) && visible.size === 1213 &&
      Number(after.events) === 1 && neverRegresses(run.phases) && Number(after.outbox) === 0,
    JSON.stringify({ after, phases: [...new Set(run.phases)] }));
}

// ---------------------------------------------------------------------------
// 10. Control: a SMALL residue keeps the existing drain path end to end.
// ---------------------------------------------------------------------------
{
  const { env, db, visible } = makeEnv();
  seedStaleBrain(db, visible, { epoch: 6, stranded: 5, drainedSince: 10 });
  const run = await runToCompletion(env, 20);
  const after = snapshot(db);
  check("a small residue is drained in place: no epoch opened, no receipt, verified, base rebased",
    run.receipt?.complete === true && Number(after.events) === 0 && Number(after.epoch) === 6 &&
      Number(after.outbox) === 0 && Number(after.base) === 18 && after.status === "verified",
    JSON.stringify({ after, receipt: run.receipt }));
}

console.log(`\n${ran - fail}/${ran} checks passed`);
process.exit(fail ? 1 : 0);
