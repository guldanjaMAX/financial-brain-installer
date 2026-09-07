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
const RESIDUE_REPROJECTION_PROTOCOL = storeD1.RESIDUE_REPROJECTION_PROTOCOL ?? "bootstrap-v2/residue";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 400)));
  if (!condition) fail++;
};

function makeEnv() {
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
  const accept = (apply) => {
    const mutationId = `fixture-mutation-${++mutationSequence}`;
    apply();
    processedUpToMutation = mutationId;
    return { mutationId };
  };
  const prepare = (sql) => {
    const shape = (params = []) => ({
      bind: (...next) => shape(next),
      all: async () => ({ results: db.prepare(sql).all(...params) }),
      first: async () => db.prepare(sql).get(...params) ?? null,
      run: async () => {
        const result = db.prepare(sql).run(...params);
        return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
      },
      _sql: sql,
      _params: params,
    });
    return shape();
  };
  const env = {
    VECTOR_DRAIN_MODE: "paused-for-upgrade",
    DB: {
      prepare,
      batch: async (statements) => {
        db.exec("BEGIN");
        try {
          const results = statements.map((statement) => {
            const result = db.prepare(statement._sql).run(...statement._params);
            return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
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
      getByIds: async (ids) => ids.map((id) => visible.get(id)).filter(Boolean),
      describe: async () => ({ vectorCount: visible.size, processedUpToMutation }),
    },
  };
  return { env, db, visible };
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
          (SELECT count(*) FROM chunks) AS chunks,
          (SELECT count(*) FROM vector_outbox) AS outbox,
          (SELECT count(*) FROM vector_bootstrap_batches) AS batches,
          (SELECT count(*) FROM vector_projection_events) AS events
     FROM install_state WHERE id=1`
).get();
const events = (db) => db.prepare("SELECT * FROM vector_projection_events ORDER BY id").all();

/** Drive the paused bootstrap to completion, counting embeddings and phases. */
const runToCompletion = async (env, rounds = 400) => {
  let clock = 100_000;
  let embeds = 0;
  const options = {
    now: () => (clock += 60_000),
    embed: async () => { embeds++; return [0.1]; },
    embedBatch: async (texts) => { embeds += texts.length; return texts.map(() => [0.1]); },
  };
  const phases = [];
  let receipt = null;
  let first = null;
  let used = 0;
  for (let round = 0; round < rounds && !receipt?.complete; round++) {
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
  check("fixture reproduces the live shape: pending, frozen base, big residue, no batches",
    before.status === "pending" && Number(before.base) === 3 && Number(before.chunks) === 1213 &&
      Number(before.outbox) === 1200 && Number(before.batches) === 0 && Number(before.events) === 0,
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
  // Completion is reached in the request that verifies; the rebase that resets
  // base_count to the corpus and the protocol to plain v2 runs on the NEXT call,
  // exactly as after a full walk. Until then base + confirmed(epoch) == chunks.
  check("outbox empty, base count is the chunks that had no queued row, counts exact",
    Number(after.outbox) === 0 && Number(after.base) === 13 &&
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
  check("the epoch advanced exactly once, to open, and the state names the residue protocol",
    Number(after.epoch) === 5 && after.protocol === RESIDUE_REPROJECTION_PROTOCOL, JSON.stringify(after));
  check("every receipt of the residue epoch names the residue-only re-projection, completion included",
    run.first?.reprojected_residue === 1200 && run.receipt?.reprojected_residue === 1200,
    JSON.stringify({ first: run.first?.reprojected_residue, last: run.receipt?.reprojected_residue }));
  check("the phase never falls back to cleanup after bulk work began", neverRegresses(run.phases), run.phases.join(","));
  check("latency: bulk walk finishes within a handful of rounds where the drain needed dozens",
    run.rounds_used <= 5, `rounds_used=${run.rounds_used}`);
  check("the pause on ordinary corpus writers is never lifted",
    env.VECTOR_DRAIN_MODE === "paused-for-upgrade", env.VECTOR_DRAIN_MODE);
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
// 6. Quarantined queued rows BLOCK the open. The receipt names the cause so the
//    CLI can refuse by name with the remedy; the base count is never recomputed.
// ---------------------------------------------------------------------------
{
  const { env, db, visible } = makeEnv();
  seedStaleBrain(db, visible, { epoch: 4, stranded: 1200, drainedSince: 10, quarantined: 50 });
  const run = await runToCompletion(env, 3);
  const after = snapshot(db);
  check("fifty quarantined queued rows keep every receipt in cleanup, naming quarantine and the row count",
    run.phases.every((p) => p === "legacy_drain") && run.first?.blocked_on === "quarantine" &&
      run.first?.blocked_rows === 50 && run.receipt?.blocked_on === "quarantine",
    JSON.stringify({ phases: run.phases, first: run.first }));
  check("and nothing was opened or recomputed over them",
    after.status === "pending" && Number(after.epoch) === 4 && Number(after.base) === 3 &&
      Number(after.events) === 0 && Number(after.outbox) === 1200 && run.embeds === 0,
    JSON.stringify({ after, embeds: run.embeds }));
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
  const run = await runToCompletion(env, 1);
  const after = snapshot(db);
  check("an unprocessed submitted row is reported as the fence, with its count, and the open waits",
    run.first?.phase === "legacy_drain" && run.first?.blocked_on === "fence" && run.first?.blocked_rows === 1 &&
      after.status === "pending" && Number(after.events) === 0 && run.embeds === 0,
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
  db.prepare(
    `UPDATE install_state
        SET vector_projection_status='bootstrap_required',
            vector_projection_bootstrap_epoch=5,
            vector_projection_bootstrap_cursor=NULL,
            vector_projection_bootstrap_high_water=(SELECT MAX(chunk_uid) FROM vector_outbox WHERE op='upsert'),
            vector_projection_bootstrap_protocol=?1,
            vector_projection_bootstrap_base_count=13
      WHERE id=1`
  ).run(RESIDUE_REPROJECTION_PROTOCOL);
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
