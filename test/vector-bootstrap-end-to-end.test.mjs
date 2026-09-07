// The REAL CLI loop (runAcceleratedBootstrap in brain.mjs) driven by the REAL
// Worker module (acceleratedVectorBootstrap in store-d1.js) over real SQLite
// and the real migrations. Every receipt the CLI validates here is one the
// Worker actually produced, round after round, so a receipt the Worker can emit
// but the CLI refuses (an epoch that advances when the residue re-projection
// opens on a late round; a quarantine count that also lands in `failed`) fails
// HERE instead of on a client.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acceleratedVectorBootstrap } from "../worker/src/lib/store-d1.js";
import { runAcceleratedBootstrap } from "../brain.mjs";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 400)));
  if (!condition) fail++;
};

function makeEnv({ visibilityLag = 0 } = {}) {
  const db = new DatabaseSync(":memory:");
  const dir = fileURLToPath(new URL("../migrations/d1/", import.meta.url));
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(join(dir, file), "utf-8"));
  db.prepare(`INSERT INTO install_state (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
              VALUES (1, 'fixture', '0.0.0', 36, 0, '2026-01-01T00:00:00Z', 'test')`).run();
  const visible = new Map();
  let mutationSequence = 0;
  let processedUpToMutation = null;
  const pendingMutations = [];
  const accept = (apply) => {
    const mutationId = `fixture-mutation-${++mutationSequence}`;
    apply();
    if (visibilityLag === 0) processedUpToMutation = mutationId;
    else pendingMutations.push({ mutationId, ticksLeft: visibilityLag });
    return { mutationId };
  };
  const tick = () => {
    for (const p of pendingMutations) p.ticksLeft -= 1;
    while (pendingMutations.length && pendingMutations[0].ticksLeft <= 0) processedUpToMutation = pendingMutations.shift().mutationId;
  };
  const prepare = (sql) => {
    const shape = (params = []) => ({
      bind: (...next) => shape(next),
      all: async () => ({ results: db.prepare(sql).all(...params) }),
      first: async () => db.prepare(sql).get(...params) ?? null,
      run: async () => ({ success: true, results: [], meta: { changes: Number(db.prepare(sql).run(...params).changes || 0) } }),
      _sql: sql, _params: params,
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
          const results = statements.map((st) => ({ success: true, results: [], meta: { changes: Number(db.prepare(st._sql).run(...st._params).changes || 0) } }));
          db.exec("COMMIT"); return results;
        } catch (e) { db.exec("ROLLBACK"); throw e; }
      },
    },
    VECTORIZE: {
      upsert: async (vectors) => accept(() => { for (const v of vectors) visible.set(v.id, structuredClone(v)); }),
      deleteByIds: async (ids) => accept(() => { for (const id of ids) visible.delete(id); }),
      getByIds: async (ids) => ids.map((id) => visible.get(id)).filter(Boolean),
      describe: async () => ({ vectorCount: visible.size, processedUpToMutation }),
    },
  };
  return { env, db, visible };
}
const addChunk = (db, uid) => {
  const doc = uid.replace(/#\d+$/, "");
  db.prepare(`INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash) VALUES (?, 'drive', ?, ?, ?, ?)`).run(doc, doc, doc, 1_000, `hash:${doc}`);
  db.prepare(`INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, vector_id) VALUES (?, ?, 0, ?, 'drive', ?)`).run(uid, doc, `text for ${uid}`, uid);
};
function seedStaleBrain(db, visible, { epoch = 4, stranded = 1200, drainedSince = 10, quarantined = 0, deletes = 0 } = {}) {
  for (const uid of ["drive:old-a#0", "drive:old-b#0", "drive:old-c#0"]) { addChunk(db, uid); visible.set(uid, { id: uid, values: [0.1], metadata: {} }); }
  db.prepare(`UPDATE install_state SET vector_projection_status='pending', vector_projection_bootstrap_epoch=?1,
       vector_projection_bootstrap_cursor=(SELECT MAX(chunk_uid) FROM chunks), vector_projection_bootstrap_high_water=(SELECT MAX(chunk_uid) FROM chunks),
       vector_projection_bootstrap_protocol='bootstrap-v2', vector_projection_bootstrap_base_count=(SELECT count(*) FROM chunks) WHERE id=1`).run(epoch);
  for (let i = 0; i < drainedSince; i++) { const uid = `drive:drained-${String(i).padStart(4, "0")}#0`; addChunk(db, uid); visible.set(uid, { id: uid, values: [0.1], metadata: {} }); }
  const uids = [];
  const insert = db.prepare("INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at) VALUES (?1, ?1, 'upsert', 2000)");
  for (let i = 0; i < stranded; i++) { const uid = `drive:stale-${String(i).padStart(5, "0")}#0`; addChunk(db, uid); insert.run(uid); uids.push(uid); }
  for (let i = 0; i < quarantined; i++) {
    db.prepare(`INSERT INTO vector_outbox_retry_state (chunk_uid, generation, attempts, next_attempt_at, last_attempt_at, quarantined_at, failure_code)
                SELECT chunk_uid, generation, 9, 0, 1900, 1950, 'fixture' FROM vector_outbox WHERE chunk_uid=?1`).run(uids[i]);
  }
  const forgotten = [];
  for (let i = 0; i < deletes; i++) {
    const uid = `drive:gone-${String(i).padStart(4, "0")}#0`;
    visible.set(uid, { id: uid, values: [0.1], metadata: {} });
    db.prepare("INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at) VALUES (?1, ?1, 'delete', 2100)").run(uid);
    forgotten.push(uid);
  }
  db.prepare("UPDATE install_state SET vector_projection_status='pending' WHERE id=1").run();
  return { stranded: uids, forgotten };
}
const snapshot = (db) => db.prepare(`SELECT vector_projection_status AS status, vector_projection_bootstrap_epoch AS epoch,
  vector_projection_residue_epoch AS residue_epoch, (SELECT count(*) FROM vector_outbox) AS outbox,
  (SELECT count(*) FROM vector_projection_events) AS events FROM install_state WHERE id=1`).get();

/**
 * One shared clock. The CLI's `now`/`sleep` and the Worker's `now` read it, so
 * the CLI's deadlines, the Worker's lease fences and the provider's visibility
 * lag all move together, as they do in production.
 */
function drive(env, { maxDurationMs = 3_600_000, contract = 2 } = {}) {
  let clock = 100_000;
  let embeds = 0;
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(" ")); };
  const workerOptions = {
    contract,
    now: () => (clock += 1_000),
    embed: async () => { embeds++; return [0.1]; },
    embedBatch: async (texts) => { embeds += texts.length; return texts.map(() => [0.1]); },
  };
  let polls = 0;
  const request = async () => {
    polls++;
    env.__tick?.();
    const receipt = await acceleratedVectorBootstrap(env, workerOptions);
    if (receipt.busy) {
      return { status: 409, ok: false, text: async () => JSON.stringify({ protocol: receipt.protocol, busy: true, remaining: receipt.remaining, retry_after_seconds: receipt.retry_after_seconds }) };
    }
    return { status: 200, ok: true, text: async () => JSON.stringify(receipt) };
  };
  return runAcceleratedBootstrap({ request, now: () => clock, sleep: async (ms) => { clock += ms; }, maxDurationMs })
    .then((result) => ({ result, error: null, polls, embeds: () => embeds, lines, clock: () => clock }))
    .catch((error) => ({ result: null, error, polls, embeds: () => embeds, lines, clock: () => clock }))
    .finally(() => { console.log = original; });
}

// 1. The live shape end to end: real receipts, real CLI validation, completion.
{
  const { env, db, visible } = makeEnv();
  seedStaleBrain(db, visible, { epoch: 4, stranded: 1200, drainedSince: 10 });
  const run = await drive(env);
  const after = snapshot(db);
  check("live shape: the CLI completes on the Worker's own receipts",
    run.error === null && run.result?.complete === true && after.status === "verified" && Number(after.outbox) === 0 &&
      visible.size === 1213 && run.embeds() === 1200,
    JSON.stringify({ error: String(run.error?.message), result: run.result, after, embeds: run.embeds() }));
  check("and it announces the residue-only re-projection once",
    run.lines.filter((l) => /residue-only re-projection: 1200 queued chunk/.test(l)).length === 1,
    run.lines.filter((l) => /residue-only/.test(l)).join(" | "));
}

// 2. A multi-round pre-open cleanup (2,500 deletes) opens the epoch on a LATE
//    round. The CLI must accept that epoch change, not read it as corruption.
{
  const { env, db, visible } = makeEnv();
  const { forgotten } = seedStaleBrain(db, visible, { epoch: 4, stranded: 1200, drainedSince: 10, deletes: 2500 });
  const run = await drive(env);
  const after = snapshot(db);
  check("2,500 deletes then the open on a later round: the CLI completes instead of dying on the epoch change",
    run.error === null && run.result?.complete === true && after.status === "verified" &&
      forgotten.every((uid) => !visible.has(uid)) && visible.size === 1213 && run.polls > 2,
    JSON.stringify({ error: String(run.error?.message), polls: run.polls, after }));
}

// 3. Fifty quarantined rows: everything else is embedded, then the CLI refuses
//    BY NAME with the remedy on a receipt the Worker really emits (failed > 0).
{
  const { env, db, visible } = makeEnv();
  seedStaleBrain(db, visible, { epoch: 4, stranded: 1200, drainedSince: 10, quarantined: 50 });
  const run = await drive(env);
  const after = snapshot(db);
  check("quarantine: 1,150 embedded, then refused by name with the count and both remedies, before the movement budget",
    run.error !== null && /50 quarantined row\(s\)/.test(String(run.error?.message)) && /vector-retry/.test(String(run.error?.message)) &&
      /brain forget/.test(String(run.error?.message)) && !/reindex/.test(String(run.error?.message)) &&
      run.embeds() === 1150 && Number(after.outbox) === 50 && after.residue_epoch === null,
    JSON.stringify({ error: String(run.error?.message).slice(0, 200), embeds: run.embeds(), after }));
  // The remedy the refusal names, then the same update again.
  db.prepare("DELETE FROM vector_outbox_retry_state WHERE quarantined_at IS NOT NULL").run();
  db.prepare("UPDATE vector_outbox SET attempts=0, last_error=NULL").run();
  const released = await drive(env);
  const done = snapshot(db);
  check("after vector-retry the next update completes and verifies exactly",
    released.error === null && released.result?.complete === true && done.status === "verified" && Number(done.outbox) === 0 && visible.size === 1213,
    JSON.stringify({ error: String(released.error?.message), done }));
}

// 4. Delayed provider visibility through the real CLI: completes, no false stall.
{
  const { env, db, visible } = makeEnv({ visibilityLag: 1 });
  seedStaleBrain(db, visible, { epoch: 4, stranded: 1200, drainedSince: 10 });
  const run = await drive(env);
  const after = snapshot(db);
  check("delayed visibility: the CLI waits for the index and completes",
    run.error === null && run.result?.complete === true && after.status === "verified" && visible.size === 1213,
    JSON.stringify({ error: String(run.error?.message), polls: run.polls, after }));
}

// 5. A 0.4.1-kit CLI (contract 1) against this Worker: receipts stay in the exact
//    old shape, so the old validator accepts them and the update completes.
{
  const { env, db, visible } = makeEnv();
  seedStaleBrain(db, visible, { epoch: 4, stranded: 1200, drainedSince: 10 });
  const run = await drive(env, { contract: 1 });
  check("an older CLI contract gets old-shaped receipts and still completes",
    run.error === null && run.result?.complete === true && visible.size === 1213 &&
      !run.lines.some((l) => /residue-only re-projection/.test(l)),
    JSON.stringify({ error: String(run.error?.message), lines: run.lines.filter((l) => /residue/.test(l)) }));
}

console.log(`\n${ran - fail}/${ran} checks passed`);
process.exit(fail ? 1 : 0);
