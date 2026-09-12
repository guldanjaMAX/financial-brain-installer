// A synthetic stranded-upgrade fixture, rehearsed on the REAL published schema prefix.
//
// It models a 0.2.3 -> 0.3.5 upgrade that is paused and cannot accept
// documents. The audited defect mechanism was that the bootstrap-v2 branch of
// acceleratedVectorBootstrap did not clear outbox
// residue while paused, so ONE chunk queued by ordinary ingest in the seconds
// before the pause could never be projected.
//
// test/vector-bootstrap-paused-strand.test.mjs already pins that fix, but it
// builds its fixture by applying ALL 35 migrations and then writing
// schema_version=22 into install_state. The production-shaped fixture is the other way round:
// every shipped release through v0.3.6 carries only migrations 0001-0022, so
// the tables 0023-0035 create do not exist on it at all. This file rehearses
// the composition nobody had executed: the real 22-migration prefix, seeded
// into the stranded regression shape, taken across the 22 -> 35 jump the way
// cmdMigrate does it, and only then handed to today's bootstrap.
//
// It is deliberately not vacuous. Block 1 proves the jump is load-bearing:
// the recovery path reads vector_outbox_retry_state, which migration 0028
// creates, so a brain that skipped 0023-0035 cannot recover at all.
//
// Block 4 measures what a RE-RUN costs. That is the half of the stranded-upgrade path
// no test covered: upgrade-verify.test.mjs drives waitForVectorDrainCutover
// with hand-written {leaseFree, inFlight} objects, never with the SQL
// cmdUpdate actually issues against a real stranded database.

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  splitStatements,
  waitForVectorDrainCutover,
  runAcceleratedBootstrap,
  VECTOR_DRAIN_CUTOVER_QUIESCENCE_MS,
  ACCELERATED_BOOTSTRAP_STALL_MS,
} from "../brain.mjs";
import { acceleratedVectorBootstrap } from "../worker/src/lib/store-d1.js";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 400)));
  if (!condition) fail++;
};

// Every release through v0.3.6 ships exactly this prefix, so it is what is in
// the field. Everything past it is the upgrade under rehearsal.
const SHIPPED_PREFIX = 22;

const dir = fileURLToPath(new URL("../migrations/d1/", import.meta.url));
const migrations = readdirSync(dir)
  .filter((f) => /^\d+_.*\.sql$/.test(f))
  .sort()
  .map((f) => {
    const sql = readFileSync(join(dir, f), "utf-8");
    return {
      version: parseInt(f.split("_")[0], 10),
      name: f.replace(/\.sql$/, ""),
      sql,
      checksum: createHash("sha256").update(sql).digest("hex").slice(0, 16),
    };
  });

// cmdMigrate's own apply step: split the file the way the CLI splits it, run
// each statement, then record the ledger row.
const applyMigration = (db, migration) => {
  for (const statement of splitStatements(migration.sql)) db.exec(statement);
  db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?,?,?,?)"
  ).run(migration.version, migration.name, new Date().toISOString(), migration.checksum);
};

function d1Adapter(db) {
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
  return {
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
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
}

/**
 * A brain as a client actually has one: migrations 0001-0022 and nothing else.
 *
 * `deferProvider` holds accepted Vectorize mutations unapplied, which is how a
 * run that dies between submission and confirmation is reproduced.
 */
function makeShippedClientBrain({ deferProvider = false } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL,
    applied_at TEXT NOT NULL, checksum TEXT NOT NULL)`);
  for (const migration of migrations.filter((m) => m.version <= SHIPPED_PREFIX)) {
    applyMigration(db, migration);
  }
  db.prepare(
    `INSERT INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1, 'example-paused-brain', '0.2.3', ?, 0, '2026-08-01T00:00:00Z', 'stable')`
  ).run(SHIPPED_PREFIX);

  const visible = new Map();
  const held = [];
  let sequence = 0;
  let processedUpToMutation = null;
  const accept = (apply) => {
    const mutationId = `fixture-mutation-${++sequence}`;
    if (deferProvider) held.push({ mutationId, apply });
    else { apply(); processedUpToMutation = mutationId; }
    return { mutationId };
  };
  const env = {
    VECTOR_DRAIN_MODE: "paused-for-upgrade",
    DB: d1Adapter(db),
    _processHeldMutation: () => {
      const mutation = held.shift();
      if (!mutation) return null;
      mutation.apply();
      processedUpToMutation = mutation.mutationId;
      return mutation.mutationId;
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
  return { db, env, visible };
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
 * The synthetic stranded shape: a finished bootstrap epoch, then one more chunk ingested, then
 * the upgrade pause landing while that chunk's outbox row is still queued.
 * base_count is the stale value from the finished epoch; chunks has grown past
 * it; the current epoch owns no batches.
 */
function seedStrandedPausedClient(db, visible, { epoch = 7, projected = 12 } = {}) {
  for (let i = 0; i < projected; i++) {
    const uid = `drive:example-paused-${String(i).padStart(3, "0")}#0`;
    addChunk(db, uid);
    visible.set(uid, { id: uid, values: [0.1], metadata: {} });
  }
  db.prepare(
    `UPDATE install_state
        SET vector_projection_status='verified',
            vector_projection_bootstrap_epoch=?1,
            vector_projection_bootstrap_cursor=(SELECT MAX(chunk_uid) FROM chunks),
            vector_projection_bootstrap_high_water=(SELECT MAX(chunk_uid) FROM chunks),
            vector_projection_bootstrap_protocol='bootstrap-v2',
            vector_projection_bootstrap_base_count=(SELECT count(*) FROM chunks)
      WHERE id=1`
  ).run(epoch);
  const stranded = "drive:example-paused-late#0";
  addChunk(db, stranded);
  db.prepare(
    "INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at) VALUES (?1, ?1, 'upsert', 2000)"
  ).run(stranded);
  return stranded;
}

/** The 22 -> 35 jump, applied exactly as cmdMigrate applies it. */
function migrateToHead(db) {
  for (const migration of migrations.filter((m) => m.version > SHIPPED_PREFIX)) {
    applyMigration(db, migration);
  }
  // cmdMigrate's install_state upsert. On an existing row its ON CONFLICT
  // clause touches client_slug, schema_version and gate_version only, so a
  // stranded projection fence must survive the migration untouched.
  db.prepare(
    `INSERT INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring,
        vector_projection_status, vector_projection_bootstrap_epoch,
        vector_projection_bootstrap_cursor, vector_projection_bootstrap_high_water,
        source_original_retrieval_generation)
     VALUES (1,?,?,?,?,?,?,
       CASE WHEN EXISTS (SELECT 1 FROM chunks) THEN 'bootstrap_required' ELSE 'verified' END,
       CASE WHEN EXISTS (SELECT 1 FROM chunks) THEN 1 ELSE 0 END,
       NULL,
       (SELECT MAX(chunk_uid) FROM chunks),
       COALESCE((SELECT source_original_retrieval_generation + 1
                   FROM install_state WHERE id=1), 0))
     ON CONFLICT(id) DO UPDATE SET
       client_slug = excluded.client_slug,
       schema_version = excluded.schema_version,
       gate_version = excluded.gate_version,
       source_original_retrieval_generation = excluded.source_original_retrieval_generation`
  ).run("example-paused-brain", "0.4.0", Math.max(...migrations.map((m) => m.version)), 0,
    new Date().toISOString(), "stable");
}

const projection = (db) => db.prepare(
  `SELECT schema_version AS schema,
          vector_projection_status AS status,
          vector_projection_bootstrap_epoch AS epoch,
          vector_projection_bootstrap_cursor AS cursor,
          vector_projection_bootstrap_high_water AS high_water,
          vector_projection_bootstrap_protocol AS protocol,
          vector_projection_bootstrap_base_count AS base,
          (SELECT count(*) FROM chunks) AS chunks,
          (SELECT count(*) FROM vector_outbox) AS outbox,
          (SELECT count(*) FROM vector_outbox WHERE submitted_mutation_id IS NOT NULL) AS submitted,
          (SELECT count(*) FROM vector_bootstrap_batches) AS batches
     FROM install_state WHERE id=1`
).get();

const bootstrapOptions = () => {
  let clock = 100_000;
  return {
    now: () => (clock += 60_000),
    embed: async () => [0.1],
    embedBatch: async (texts) => texts.map(() => [0.1]),
  };
};

/**
 * The quiescence probe cmdUpdate builds for a lease-aware brain, verbatim,
 * driven against a real database instead of a hand-written reading.
 */
const cutoverProbe = (db) => async () => {
  const row = db.prepare(
    `SELECT vector_drain_lease_owner AS owner,
            vector_drain_lease_expires_at AS expires_at,
            (SELECT COUNT(*) FROM vector_outbox
              WHERE submitted_mutation_id IS NOT NULL) AS in_flight
       FROM install_state WHERE id = 1`
  ).get();
  if (!row) throw new Error("install_state row missing");
  const expires = Number(row.expires_at || 0);
  return {
    leaseFree: row.owner === null || row.owner === undefined || row.owner === "" ||
      (Number.isFinite(expires) && expires > 0 && expires < Date.now()),
    inFlight: Number(row.in_flight || 0),
  };
};

async function measureCutover(db) {
  const priorLog = console.log;
  console.log = () => {};
  let clock = 0;
  try {
    return await waitForVectorDrainCutover(async (ms) => { clock += ms; }, {
      probe: cutoverProbe(db),
      now: () => clock,
      pollMs: 15_000,
    });
  } finally { console.log = priorLog; }
}

// --- 1. The 22 -> 35 jump is load-bearing, and refusing is not destructive ---
{
  const { db, env, visible } = makeShippedClientBrain();
  const stranded = seedStrandedPausedClient(db, visible);
  const before = projection(db);
  check("the fixture is a real shipped brain: 22 migrations, stale base, one queued row",
    db.prepare("SELECT count(*) AS n FROM schema_migrations").get().n === SHIPPED_PREFIX &&
      before.schema === 22 && before.status === "pending" && Number(before.base) === 12 &&
      Number(before.chunks) === 13 && Number(before.outbox) === 1 && Number(before.batches) === 0,
    JSON.stringify(before));

  let error = null;
  try { await acceleratedVectorBootstrap(env, bootstrapOptions()); } catch (caught) { error = caught; }
  check("an unmigrated schema-22 brain refuses the bootstrap by name instead of half-recovering",
    error !== null && /migrate/i.test(String(error?.message || "")),
    JSON.stringify({ message: error?.message ?? null }));
  const after = projection(db);
  check("and that refusal changed nothing: the strand and its fence are intact",
    JSON.stringify(after) === JSON.stringify(before) && !visible.has(stranded),
    JSON.stringify({ before, after }));
}

// --- 2. The migration preserves the stranded fence exactly -------------------
let strandedFenceBeforeMigration = null;
{
  const { db, visible } = makeShippedClientBrain();
  seedStrandedPausedClient(db, visible);
  const before = projection(db);
  strandedFenceBeforeMigration = before;
  migrateToHead(db);
  const after = projection(db);
  check(`migrations ${SHIPPED_PREFIX + 1}-${migrations.at(-1).version} apply over the stranded brain`,
    after.schema === migrations.at(-1).version &&
      db.prepare("SELECT count(*) AS n FROM schema_migrations").get().n === migrations.length,
    JSON.stringify(after));
  check("the migration does not touch the stranded projection fence",
    after.status === before.status && after.epoch === before.epoch &&
      after.cursor === before.cursor && after.high_water === before.high_water &&
      after.protocol === before.protocol && Number(after.base) === Number(before.base) &&
      Number(after.outbox) === Number(before.outbox) && Number(after.chunks) === Number(before.chunks),
    JSON.stringify({ before, after }));
  check("so a migrated brain is still stranded until the bootstrap runs",
    after.status === "pending" && Number(after.base) < Number(after.chunks) && Number(after.outbox) === 1,
    JSON.stringify(after));
}

// --- 3. On the migrated brain the strand clears while the pause holds --------
{
  const { db, env, visible } = makeShippedClientBrain();
  const stranded = seedStrandedPausedClient(db, visible);
  migrateToHead(db);
  let receipt = null, rounds = 0;
  for (; rounds < 10 && !receipt?.complete; rounds++) {
    receipt = await acceleratedVectorBootstrap(env, bootstrapOptions());
  }
  const after = projection(db);
  check("the chunk queued before the pause is projected once the schema is current",
    Number(after.outbox) === 0 && visible.has(stranded),
    JSON.stringify({ after, visible: [...visible.keys()] }));
  check("the stale base refreshes to the whole corpus and the projection verifies",
    Number(after.base) === Number(after.chunks) && after.status === "verified",
    JSON.stringify(after));
  check("the receipt completes instead of repeating a never-moving count",
    receipt?.complete === true && receipt.confirmed === receipt.total && receipt.remaining === 0,
    JSON.stringify(receipt));
  check("the corpus-write pause is never lifted to achieve any of that",
    env.VECTOR_DRAIN_MODE === "paused-for-upgrade", env.VECTOR_DRAIN_MODE);
}

// --- 4. What the safety pause costs, first run versus re-run ----------------
{
  const { db, env, visible } = makeShippedClientBrain({ deferProvider: true });
  seedStrandedPausedClient(db, visible);
  migrateToHead(db);

  const first = await measureCutover(db);
  check("a queued-only strand reads quiet, so the first run pays ~15s, not 20 minutes",
    first.proven === true && first.waitedMs === 15_000, JSON.stringify(first));

  // One bootstrap round submits the residue row. The provider has accepted it
  // but not yet applied it, which is exactly the state a run that dies (or is
  // interrupted) between submission and confirmation leaves behind.
  await acceleratedVectorBootstrap(env, bootstrapOptions());
  const midRun = projection(db);
  check("an interrupted run leaves the residue row submitted and unconfirmed",
    Number(midRun.outbox) === 1 && Number(midRun.submitted) === 1,
    JSON.stringify(midRun));

  const rerun = await measureCutover(db);
  // Documented cost, not an endorsement: cmdUpdate's probe counts the paused
  // bootstrap's OWN accepted-but-unconfirmed residue as "an older writer is
  // still active", and only the bootstrap stage (which runs after this wait)
  // can clear it. Every re-run in that state therefore pays the full grace.
  check("a re-run over a submitted-but-unconfirmed residue row pays the FULL 20-minute grace",
    rerun.proven === false && rerun.waitedMs === VECTOR_DRAIN_CUTOVER_QUIESCENCE_MS,
    JSON.stringify({ rerun, fullGraceMs: VECTOR_DRAIN_CUTOVER_QUIESCENCE_MS }));

  // Once the provider catches up, the same durable state finishes.
  while (env._processHeldMutation()) { /* drain the provider's queue */ }
  let receipt = null, rounds = 0;
  for (; rounds < 10 && !receipt?.complete; rounds++) {
    receipt = await acceleratedVectorBootstrap(env, bootstrapOptions());
    while (env._processHeldMutation()) { /* provider catches up between rounds */ }
  }
  check("and the interrupted run resumes from durable state to completion",
    receipt?.complete === true && Number(projection(db).outbox) === 0,
    JSON.stringify({ receipt, after: projection(db) }));
}

// --- 5. Control: a healthy shipped brain crosses the same jump untouched ----
// A synthetic healthy v0.2.0 macOS arm64 fixture reports "brain health
// passing all checks". It has the same 22-migration prefix and no strand, so
// its update must not acquire one.
{
  const { db, env, visible } = makeShippedClientBrain();
  for (let i = 0; i < 6; i++) {
    const uid = `drive:example-owner-${i}#0`;
    addChunk(db, uid);
    visible.set(uid, { id: uid, values: [0.1], metadata: {} });
  }
  db.prepare(
    `UPDATE install_state
        SET vector_projection_status='verified',
            vector_projection_bootstrap_epoch=3,
            vector_projection_bootstrap_cursor=(SELECT MAX(chunk_uid) FROM chunks),
            vector_projection_bootstrap_high_water=(SELECT MAX(chunk_uid) FROM chunks),
            vector_projection_bootstrap_protocol='bootstrap-v2',
            vector_projection_bootstrap_base_count=(SELECT count(*) FROM chunks)
      WHERE id=1`
  ).run();
  migrateToHead(db);
  const cutover = await measureCutover(db);
  let receipt = null, rounds = 0;
  for (; rounds < 10 && !receipt?.complete; rounds++) {
    receipt = await acceleratedVectorBootstrap(env, bootstrapOptions());
  }
  const after = projection(db);
  check("a healthy schema-22 brain proves quiescence immediately and completes in one round",
    cutover.proven === true && cutover.waitedMs === 15_000 && rounds === 1 &&
      receipt?.complete === true,
    JSON.stringify({ cutover, rounds, receipt }));
  check("and it neither queues residue nor loses its epoch",
    Number(after.outbox) === 0 && Number(after.epoch) === 3 && after.status === "verified" &&
      Number(after.base) === Number(after.chunks),
    JSON.stringify(after));
}

// --- 6. End to end: the real CLI runner against the real Worker -------------
// Everything above exercises the Worker function. This drives brain.mjs's own
// runAcceleratedBootstrap against it, covering the complete stranded-upgrade path:
// the poll loop, the "N/M legacy vector(s) confirmed" line, and the stall rule.
const driveCli = async (env, db) => {
  let clock = 0;
  const priorLog = console.log;
  const printed = [];
  console.log = (...args) => printed.push(args.join(" ").replace(/\u001b\[[0-9;]*m/g, "").trim());
  let completion = null, died = null;
  try {
    completion = await runAcceleratedBootstrap({
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      maxDurationMs: 3_600_000,
      request: async () => {
        const receipt = await acceleratedVectorBootstrap(env, bootstrapOptions());
        return { status: 200, ok: true, text: async () => JSON.stringify(receipt) };
      },
    });
  } catch (error) { died = error; } finally { console.log = priorLog; }
  return { completion, died, printed, after: projection(db) };
};

{
  const { db, env, visible } = makeShippedClientBrain();
  seedStrandedPausedClient(db, visible);
  migrateToHead(db);
  const run = await driveCli(env, db);
  check("the CLI takes the synthetic stranded brain to a completed bootstrap in one round",
    run.died === null && run.completion?.complete === true && run.completion.rounds === 1 &&
      run.completion.remaining === 0 && run.after.status === "verified",
    JSON.stringify({ died: run.died?.message ?? null, completion: run.completion, after: run.after }));
  check("and it says so, rather than repeating a never-moving count",
    run.printed.some((line) => /13\/13 legacy vector\(s\) confirmed; 0 remain/.test(line)),
    JSON.stringify(run.printed.slice(-3)));
}

// --- 6b. OPEN DEFECT: excess provider vectors reproduce the same deadlock ----
//
// The 0.3.6 residue fix makes the OUTBOX reachable again. It does not make
// markProjectionVerifiedIfExact's other precondition reachable: that cut also
// requires `(SELECT count(*) FROM chunks) = VECTORIZE.describe().vectorCount`.
// One vector the provider still holds with no D1 chunk behind it therefore
// deadlocks the paused bootstrap in the same synthetic regression shape, with an EMPTY
// outbox, so there is nothing left for an operator to act on. RECOVERY.md
// already states that provider-only excess vectors cannot be enumerated from
// D1, so this is a known class, not a hypothetical one.
//
// This check is written to stay true if that is fixed: either the run
// completes, or it stalls AND the receipt carries the count mismatch that the
// stall message omits.
{
  const { db, env, visible } = makeShippedClientBrain();
  const stranded = seedStrandedPausedClient(db, visible);
  visible.set("drive:forgotten-doc#0", { id: "drive:forgotten-doc#0", values: [0.1], metadata: {} });
  migrateToHead(db);

  let receipt = null;
  for (let round = 0; round < 6 && !receipt?.complete; round++) {
    receipt = await acceleratedVectorBootstrap(env, bootstrapOptions());
  }
  const after = projection(db);
  check("the residue fix still projects the stranded chunk and empties the outbox",
    Number(after.outbox) === 0 && visible.has(stranded), JSON.stringify(after));

  const stalled = receipt?.complete !== true;
  check("excess provider vectors either resolve, or stall WITH the mismatch on the receipt",
    !stalled || (receipt.actual_vectors > receipt.expected_vectors &&
      receipt.vector_ready === false && after.status === "pending"),
    JSON.stringify({ receipt, after }));

  const run = await driveCli(env, db);
  const stallMessage = String(run.died?.message || "");
  check("today that stall ends the update on the movement budget, leaving the brain paused",
    !stalled || (run.completion === null &&
      new RegExp(`has not moved for ${Math.round(ACCELERATED_BOOTSTRAP_STALL_MS / 60_000)} minutes`).test(stallMessage) &&
      run.after.status === "pending"),
    JSON.stringify({ stallMessage, after: run.after }));
  // This was the operator-facing half of the defect: the message named an
  // outbox/batch shape that is already empty and prescribed a re-run that
  // cannot change the vector count, while holding both numbers on the receipt.
  // Now closed. The stall must name the real cause and must not tell the
  // operator to do the one thing that provably cannot help.
  check("the stall names the excess-vector cause it has in hand, with both counts",
    !stalled || (/Vectorize holds \d+ vector\(s\), but D1 requires \d+/.test(stallMessage) &&
      /excess vectors/i.test(stallMessage)),
    stallMessage);
  check("the stall no longer prescribes a re-run that cannot change the vector count",
    !stalled || (/already stopped the paused bootstrap/i.test(stallMessage) &&
      /report this update failure for reviewed repair before retrying/i.test(stallMessage) &&
      !/Re-run `brain update/.test(stallMessage)),
    stallMessage);
  check("the stall still reports the movement budget and that the brain stays paused",
    !stalled || (/has not moved for \d+ minutes/.test(stallMessage) &&
      /Keep the Worker paused/i.test(stallMessage)),
    stallMessage);
  if (stalled) {
    console.log("      ^ open defect: receipt had expected_vectors=" +
      receipt.expected_vectors + " actual_vectors=" + receipt.actual_vectors +
      "; the CLI printed \"" + (run.printed.filter((l) => /legacy vector/.test(l)).at(-1) || "") + "\" and then died.");
  }
}

console.log(`\nThe paused-client stranded upgrade, rehearsed on the shipped ${SHIPPED_PREFIX}-migration prefix: ${ran - fail}/${ran} passed`);
process.exit(fail ? 1 : 0);
