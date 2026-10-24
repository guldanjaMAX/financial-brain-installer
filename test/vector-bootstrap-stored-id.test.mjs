// Characterization of an existing defect, not the desired repair behavior.
// The whole-corpus bootstrap remaps a stored ID without retaining its delete.
// A future fix must deliberately update this characterization and its control.
import assert from "node:assert/strict";
import test from "node:test";
import { acceleratedVectorBootstrap } from "../worker/src/lib/store-d1.js";
import { makeEnv, seed, remaining } from "./fixtures/vector-fence-env.mjs";

const canonicalId = "drive:fence-0#0";
const oldId = "fixture-old-vector-0";

async function exerciseWholeCorpusBootstrap(t, storedId) {
  const { env, db, visible } = makeEnv();
  t.after(() => db.close());
  seed(db, 1);
  // This is synthetic pre-bootstrap state. No ordinary queued upsert can
  // account for the remap: the real whole-corpus walk must create its own row.
  db.exec("DELETE FROM vector_outbox");
  db.prepare("UPDATE chunks SET vector_id=? WHERE chunk_uid=?").run(storedId, canonicalId);
  db.exec(`UPDATE install_state SET schema_version=13,
    vector_projection_status='bootstrap_required',
    vector_projection_bootstrap_epoch=1,
    vector_projection_bootstrap_cursor='',
    vector_projection_bootstrap_high_water=NULL,
    vector_projection_bootstrap_protocol=NULL,
    vector_projection_bootstrap_base_count=0 WHERE id=1`);
  env.VECTOR_DRAIN_MODE = "paused-for-upgrade";
  const originalVector = {
    id: storedId, values: [0.7], metadata: { doc_uid: "drive:fence-0" },
  };
  visible.set(storedId, structuredClone(originalVector));
  const corpus = () => JSON.stringify({
    documents: db.prepare("SELECT * FROM documents ORDER BY doc_uid").all(),
    chunks: db.prepare("SELECT chunk_uid,doc_uid,chunk_ix,text,source FROM chunks ORDER BY chunk_uid").all(),
  });
  const beforeCorpus = corpus();
  assert.equal(remaining(db), 0);
  assert.deepEqual([...visible.keys()], [storedId]);

  const upserts = [], deletes = [], queuedAtSubmit = [];
  // All provider methods come from the in-memory fixture. The real bootstrap
  // accepts env.VECTORIZE plus options.embed/embedBatch; neither needs fetch.
  const upsert = env.VECTORIZE.upsert;
  env.VECTORIZE.upsert = async (vectors) => {
    upserts.push(vectors.map((vector) => vector.id));
    queuedAtSubmit.push(db.prepare(
      "SELECT chunk_uid,vector_id,op,bootstrap_epoch,bootstrap_batch FROM vector_outbox ORDER BY chunk_uid",
    ).all().map((row) => ({ ...row })));
    return upsert(vectors);
  };
  const deleteByIds = env.VECTORIZE.deleteByIds;
  env.VECTORIZE.deleteByIds = async (ids) => {
    deletes.push([...ids]);
    return deleteByIds(ids);
  };
  let clock = 100_000, embeds = 0;
  const options = {
    contract: 2,
    now: () => (clock += 10),
    embed: async () => { embeds++; return [0.1]; },
    embedBatch: async (texts) => { embeds += texts.length; return texts.map(() => [0.1]); },
  };
  const run = () => acceleratedVectorBootstrap(env, options);
  const submitted = await run();
  assert.deepEqual(queuedAtSubmit, [[{
    chunk_uid: canonicalId, vector_id: storedId, op: "upsert",
    bootstrap_epoch: 1, bootstrap_batch: 1,
  }]], "the whole-corpus batch first queues the stored provider ID");
  assert.deepEqual(upserts, [[canonicalId]], "bootstrap submits the recomputed canonical ID");
  assert.equal(db.prepare("SELECT vector_id FROM chunks").get().vector_id, canonicalId,
    "D1 moves to the canonical ID after provider acceptance");
  assert.equal(submitted.complete, false);
  assert.equal(submitted.submitted, 1);
  assert.equal(remaining(db), 1);
  assert.deepEqual([...visible.keys()], [storedId], "provider acceptance alone changes no visible IDs");

  const unprocessed = await run();
  assert.equal(unprocessed.complete, false);
  assert.equal(unprocessed.submitted, 1);
  assert.equal(remaining(db), 1, "the batch remains queued before provider processing");
  assert.equal(env._processNextVectorMutation(), "fixture-mutation-1");
  const settled = await run();
  assert.equal(remaining(db), 0);
  const batch = db.prepare("SELECT status,row_count FROM vector_bootstrap_batches").get();
  assert.equal(batch.status, "confirmed");
  assert.equal(batch.row_count, 1);
  assert.equal(settled.confirmed, 1);
  assert.equal(settled.remaining, 0);
  assert.equal(settled.in_flight_batches, 0);
  assert.equal(settled.expected_vectors, 1);
  assert.equal(settled.queued + settled.submitted + settled.failed + settled.retrying, 0);
  assert.equal(embeds, 1);
  assert.deepEqual(deletes, [], "no delete was submitted for the old mapping");
  assert.ok(visible.has(canonicalId));
  assert.ok(corpus() === beforeCorpus, "the retained document and chunk content are unchanged");
  const d1Ids = db.prepare("SELECT vector_id FROM chunks ORDER BY vector_id").all().map((row) => row.vector_id);
  assert.deepEqual(d1Ids, [canonicalId]);
  return { db, visible, originalVector, settled, d1Ids, run, upserts, deletes, env };
}

test("documents current defect: whole-corpus bootstrap strands the old stored provider ID", async (t) => {
  const { db, visible, originalVector, settled, d1Ids, run, upserts, deletes, env } =
    await exerciseWholeCorpusBootstrap(t, oldId);
  assert.equal(visible.has(oldId), true, "known defect: bootstrap leaves the old stored provider ID behind");
  assert.ok(JSON.stringify(visible.get(oldId)) === JSON.stringify(originalVector),
    "the old vector survives unchanged even though its document still exists");
  assert.deepEqual([...visible.keys()].sort(), [canonicalId, oldId].sort());
  assert.deepEqual([...visible.keys()].filter((id) => !d1Ids.includes(id)), [oldId]);
  assert.deepEqual(d1Ids.filter((id) => !visible.has(id)), []);
  assert.equal(settled.actual_vectors, 2);
  assert.equal(settled.complete, false);
  assert.equal(settled.vector_ready, false);
  assert.equal(db.prepare("SELECT vector_projection_status AS status FROM install_state").get().status, "pending");

  const repeated = await run();
  assert.equal(repeated.complete, false, "an empty outbox does not hide provider excess");
  assert.equal(repeated.actual_vectors, 2);
  assert.deepEqual(upserts, [[canonicalId]], "another bootstrap poll cannot discover the lost ID");
  assert.deepEqual(deletes, []);
  assert.equal(env._processNextVectorMutation(), null, "no old-ID cleanup is awaiting provider processing");
});

test("control: whole-corpus bootstrap with a canonical stored ID converges exactly", async (t) => {
  const { db, visible, settled, d1Ids, env } = await exerciseWholeCorpusBootstrap(t, canonicalId);
  assert.deepEqual([...visible.keys()], d1Ids);
  assert.equal(settled.actual_vectors, 1);
  assert.equal(settled.complete, true);
  assert.equal(settled.vector_ready, true);
  assert.equal(db.prepare("SELECT vector_projection_status AS status FROM install_state").get().status, "verified");
  assert.equal(env._processNextVectorMutation(), null);
});
