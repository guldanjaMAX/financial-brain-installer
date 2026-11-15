import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pauseDailyRefreshSchedule } from "../operations/daily-refresh-scheduler.mjs";
import { cmdRollback, healthProbeVerdict } from "../brain.mjs";
import { makeEnv } from "./fixtures/vector-fence-env.mjs";
import { drainOutbox } from "../worker/src/lib/store-d1.js";
import { requireRollbackWriterQuiescence } from "../operations/rollback-cutover.mjs";

test("GMAIL-06: the apply procedure requires verified backup before dry run and explicit rollback", () => {
  const text = readFileSync(new URL(process.env.GMAIL_ROLLOUT_BEFORE
    ? "../gmail-batch-r2-evidence/apply-before.txt" : "../docs/gmail-bounded-rollout.md", import.meta.url), "utf8");
  assert.ok(text.length > 100, "nonempty apply procedure reached");
  const backup = text.indexOf("Backup verified");
  const firstRun = text.indexOf("First dry run");
  assert.ok(backup >= 0 && firstRun > backup, "a verified backup must precede the first run");
  assert.ok(text.includes("Post-backup writes") && text.includes("Rollback rehearsal"), "later writes and rollback rehearsal must be explicit");
});

test("GMAIL-06: shipped rollback previews without writes, then restores only with confirmation and remains paused", async () => {
  const root = mkdtempSync(join(tmpdir(), "gmail-rollback-"));
  const manifest = join(root, "fixture.manifest.json");
  writeFileSync(manifest, JSON.stringify({ client: { slug: "fixture" }, infrastructure: { cloudflare: {
    account_id: "fixture-account", d1_database_id: "fixture-database", storage: "d1", vectorize_index: "fixture-index" } } }));
  const calls = []; const log = console.log; const warn = console.warn;
  console.log = console.warn = () => {};
  const dependencies = {
    dailyRefreshOptions: { platform: "linux" },
    withBrainLifecycleLock: async (_opts, task) => { calls.push("idle-fence"); return task({ assertOwned() {} }); },
    resolveAccount: async () => { calls.push("account"); return { id: "fixture-account" }; },
    cmdDeploy: async (_path, opts) => { assert.equal(opts.pauseVectorDrainForUpgrade, true); assert.equal(opts.rollbackWriteFence, true); calls.push("pause"); },
    cmdHealth: async (_path, opts) => { assert.equal(opts.expectDrainMode, "paused-for-upgrade"); assert.equal(opts.expectRollbackFence, true); calls.push("health"); },
    waitForVectorDrainQuiescence: async () => { calls.push("quiesce"); },
    cf: async (path, opts) => { if (path.endsWith("/fixture-index/info")) { calls.push("provider-proof"); return { vectorCount: 0, processedUpToMutation: null }; } assert.ok(path.endsWith("/time_travel/restore?bookmark=fixture-bookmark")); assert.equal(opts.method, "POST"); calls.push("restore"); },
    rollbackCutoverOptions: { pollMs: 1 },
    d1Query: async (_account, _db, sql) => {
      calls.push("sql");
      if (sql.includes("AS in_flight")) return { results: [{ schema_version: 65, owner: null, expires_at: null, in_flight: 0, pending: 0, ambiguous: 0, bootstrap_pending: 0,
        projection_status: "verified", mutation_id: null, submitted_at: null }] };
      if (sql.includes("SELECT schema_version")) return { results: [{ schema_version: 59 }] };
      if (sql.includes("SELECT vector_projection_status")) return { results: [{ status: "bootstrap_required", lease_owner: null,
        lease_expires_at: null, mutation_id: null, mutation_submitted_at: null, cursor: null,
        high_water: "fixture-chunk", chunk_high_water: "fixture-chunk", submitted_rows: 0,
        bootstrap_protocol: null, bootstrap_base_count: 0, bootstrap_batch_count: 0, tagged_rows: 0 }] };
      return { results: [] };
    },
  };
  try {
    const preview = await cmdRollback(manifest, "fixture-bookmark", dependencies);
    assert.equal(preview.restored, false);
    assert.equal(calls.length, 0, "real preview decision reached before any account or write dependency");
    let enabled = true;
    const scheduler = { read: () => ({ exists: true, owned: true, enabled, definition: { definition_hash: "fixture" } }),
      setEnabled: (_identity, value) => { calls.push("stop-schedule"); enabled = value; } };
    const snapshot = pauseDailyRefreshSchedule({ identity: { id: "fixture" } }, { adapter: scheduler });
    assert.equal(snapshot.enabled, true); assert.equal(enabled, false, "supported stop is read back before idle decision");
    await assert.rejects(cmdRollback(manifest, "fixture-bookmark", { ...dependencies, confirmed: true,
      withBrainLifecycleLock: async () => { calls.push("busy-fence"); throw new Error("synthetic sync is running"); },
    }), /sync is running/);
    assert.deepEqual(calls, ["stop-schedule", "busy-fence"], "running sync stops before account, pause or restore");
    calls.length = 0;
    let probes = 0;
    await assert.rejects(cmdRollback(manifest, "fixture-bookmark", { ...dependencies, confirmed: true,
      rollbackCutoverOptions: { probeErrorLimit: 1 },
      d1Query: async () => { probes++; throw new Error("synthetic unreadable writers"); },
    }), /quiescence.*not verified/i);
    assert.equal(probes, 1, "actual cutover decision reached");
    assert.equal(calls.includes("restore"), false, "unverified writers forbid restore");
    assert.equal(calls.filter(call => call === "pause").length, 1, "paused generation retained");
    calls.length = 0;
    let time = 0; let busyReads = 0;
    await assert.rejects(cmdRollback(manifest, "fixture-bookmark", { ...dependencies, confirmed: true,
      rollbackCutoverOptions: { now: () => time, pollMs: 1200000 },
      waitForVectorDrainQuiescence: async ms => { time += ms; },
      d1Query: async () => { busyReads++; return { results: [{ schema_version: 65, owner: "fixture-writer", expires_at: 1, in_flight: 1, pending: 1, ambiguous: 0, bootstrap_pending: 0,
        projection_status: "pending", mutation_id: null, submitted_at: null }] }; },
    }), /quiescence.*not verified/i);
    assert.equal(busyReads, 2, "busy writer reaches the bounded cutover deadline");
    assert.equal(calls.includes("restore"), false);
    assert.equal(calls.filter(call => call === "pause").length, 1, "busy boundary also leaves the Worker paused");
    calls.length = 0;
    let malformedReads = 0;
    await assert.rejects(cmdRollback(manifest, "fixture-bookmark", { ...dependencies, confirmed: true,
      rollbackCutoverOptions: { probeErrorLimit: 1 },
      d1Query: async () => { malformedReads++; return { results: [{ owner: null, expires_at: null, in_flight: null }] }; },
    }), /quiescence.*not verified/i);
    assert.equal(malformedReads, 1, "unknown mutation count reaches strict readback validation");
    assert.equal(calls.includes("restore"), false, "null is not a proven zero mutation count");
    calls.length = 0;
    time = 0;
    await assert.rejects(cmdRollback(manifest, "fixture-bookmark", { ...dependencies, confirmed: true,
      rollbackCutoverOptions: { now: () => time, pollMs: 1200000 },
      waitForVectorDrainQuiescence: async ms => { time += ms; },
      d1Query: async () => ({ results: [{ schema_version: 65, owner: null, expires_at: null, in_flight: 0,
        pending: 0, ambiguous: 0, bootstrap_pending: 0, projection_status: "verified",
        mutation_id: "fixture-unconfirmed", submitted_at: 0 }] }),
    }), /quiescence.*not verified/i);
    assert.equal(calls.filter(call => call === "provider-proof").length, 2,
      "an empty queue still reaches the provider completion decision twice");
    assert.equal(calls.includes("restore"), false, "unknown provider watermark cannot authorize restore");
    assert.equal(calls.filter(call => call === "pause").length, 1);
    calls.length = 0;
    const applied = await cmdRollback(manifest, "fixture-bookmark", { ...dependencies, confirmed: true });
    assert.equal(applied.restored, true);
    assert.equal(applied.requiresVectorizeRecreation, true);
    assert.deepEqual(calls.slice(0, 10), ["idle-fence", "account", "pause", "health", "sql", "provider-proof", "quiesce", "sql", "provider-proof", "restore"]);
    assert.equal(calls.filter(call => call === "pause").length, 1, "rollback never deploys active mode");
  } finally { console.log = log; console.warn = warn; rmSync(root, { recursive: true, force: true }); }
});

for (const fault of ["row-receipt", "global-fence", "failure-bookkeeping", "ordering-probe"]) test(`R4 GMAIL-06: accepted mutation with ${fault} failure cannot authorize rollback`, async () => {
  const { db, env } = makeEnv();
  const root = mkdtempSync(join(tmpdir(), "gmail-rollback-r4-"));
  const path = join(root, "fixture.manifest.json");
  writeFileSync(path, JSON.stringify({ client: { slug: "fixture" }, infrastructure: { cloudflare: {
    account_id: "fixture-account", d1_database_id: "fixture-database", vectorize_index: "fixture-index", storage: "d1", vectorize_index: "fixture-index" } } }));
  const origin = Date.parse("2026-01-01T12:00:00Z");
  db.prepare("INSERT INTO documents(doc_uid,source,source_id,title,ingested_at,content_hash) VALUES(?,?,?,?,?,?)")
    .run("gmail:entry", "gmail", "entry", "Synthetic correspondence", origin, "fixture-hash");
  db.prepare("INSERT INTO chunks(chunk_uid,doc_uid,chunk_ix,text,source,vector_id) VALUES(?,?,?,?,?,?)")
    .run("gmail:entry#0", "gmail:entry", 0, "Synthetic correspondence", "gmail", "gmail:entry#0");
  db.prepare("INSERT INTO vector_outbox(chunk_uid,vector_id,op,queued_at) VALUES(?,?,?,?)")
    .run("gmail:entry#0", "gmail:entry#0", "upsert", origin);
  if (fault === "ordering-probe") {
    db.prepare("UPDATE install_state SET vector_projection_status='verified',vector_projection_mutation_id=?,vector_projection_submitted_at=?")
      .run("fixture-prior-fence", origin - 1200000);
    db.exec("DELETE FROM vector_outbox");
    assert.deepEqual({ ...db.prepare("SELECT documents,chunks FROM corpus_stats WHERE source='gmail'").get() },
      { documents: 1, chunks: 1 }, "schema-65 triggers already maintain the fixture counters");
  }
  const originalPrepare = env.DB.prepare;
  const originalBatch = env.DB.batch;
  env.DB.batch = async statements => {
    if (fault !== "global-fence") throw new Error("synthetic receipt or bookkeeping failure");
    return originalBatch(statements);
  };
  env.DB.prepare = sql => {
    const statement = originalPrepare(sql);
    if (fault !== "row-receipt" && sql.includes("SET vector_projection_mutation_id")) {
      statement.bind = () => ({ run: async () => { throw new Error("synthetic global receipt failure"); } });
    }
    return statement;
  };
  const originalLog = console.log; const originalWarn = console.warn;
  console.log = console.warn = () => {};
  let accepted = 0; let restores = 0; let paused = false; let cutovers = 0; let time = origin;
  const upsert = env.VECTORIZE.upsert;
  env.VECTORIZE.upsert = async vectors => { accepted++; return upsert(vectors); };
  if (fault === "ordering-probe") {
    const remove = env.VECTORIZE.deleteByIds;
    env.VECTORIZE.deleteByIds = async ids => { accepted++; return remove(ids); };
    env.VECTORIZE.describe = async () => ({ vectorCount: 1,
      processedUpToMutation: accepted ? "fixture-prior-fence" : "fixture-stale-watermark",
      processedUpToDatetime: new Date(origin - 1199999).toISOString() });
  }
  const options = {
    confirmed: true,
    withBrainLifecycleLock: async (_opts, task) => task({ assertOwned() {} }),
    resolveAccount: async () => ({ id: "fixture-account" }),
    cmdDeploy: async () => { paused = true; }, cmdHealth: async () => {},
    rollbackCutoverOptions: { now: () => time, pollMs: 1200000, probeErrorLimit: 1 },
    waitForVectorDrainQuiescence: async ms => { time += ms; },
    d1Query: async (_acct, _database, sql) => {
      if (sql.includes("AS in_flight")) cutovers++;
      return { results: db.prepare(sql).all() };
    },
    cf: async (url, request) => {
      if (request?.method === "POST") { restores++; throw new Error("unexpected restore reached"); }
      assert.ok(url.endsWith("/fixture-index/info"));
      return env.VECTORIZE.describe();
    },
  };
  try {
    await assert.rejects(drainOutbox(env, { now: () => origin, embed: async () => [0.1], disableBootstrapAdvance: true }),
      error => fault === "ordering-probe" ? /synthetic global receipt failure/.test(error.message) : error.code === "receipt_write_incomplete");
    assert.equal(accepted, 1, "actual provider acceptance reached before receipt failure");
    assert.equal(db.prepare("SELECT vector_drain_lease_owner AS owner FROM install_state").get().owner, null,
      "normal writer error path released its lease");
    assert.equal(db.prepare("SELECT count(*) AS n FROM vector_outbox WHERE submitted_mutation_id IS NOT NULL").get().n, 0);
    if (fault === "ordering-probe") {
      await assert.rejects(drainOutbox(env, { now: () => origin + 1, embed: async () => [0.1], disableBootstrapAdvance: true }),
        /probe submission is unconfirmed/);
      assert.equal(accepted, 1, "a later ordinary drain cannot erase the unknown submission");
    }
    await assert.rejects(cmdRollback(path, "fixture-bookmark", options), /quiescence.*NOT verified/i);
    assert.ok(cutovers > 0, "actual rollback cutover reached after normal writer release");
    assert.equal(restores, 0); assert.equal(paused, true);
  } finally { console.log = originalLog; console.warn = originalWarn; db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("R4 GMAIL-06: a real settled writer permits confirmed restore with the rollback fence retained", async () => {
  const { db, env } = makeEnv();
  const root = mkdtempSync(join(tmpdir(), "gmail-rollback-settled-"));
  const manifest = join(root, "fixture.manifest.json");
  writeFileSync(manifest, JSON.stringify({ client: { slug: "fixture" }, infrastructure: { cloudflare: {
    account_id: "fixture-account", d1_database_id: "fixture-database", vectorize_index: "fixture-index", storage: "d1" } } }));
  const origin = Date.parse("2026-01-01T12:00:00Z");
  db.prepare("INSERT INTO documents(doc_uid,source,source_id,title,ingested_at,content_hash) VALUES(?,?,?,?,?,?)")
    .run("gmail:settled", "gmail", "settled", "Synthetic correspondence", origin, "fixture-hash");
  db.prepare("INSERT INTO chunks(chunk_uid,doc_uid,chunk_ix,text,source,vector_id) VALUES(?,?,?,?,?,?)")
    .run("gmail:settled#0", "gmail:settled", 0, "Synthetic correspondence", "gmail", "gmail:settled#0");
  db.prepare("INSERT INTO vector_outbox(chunk_uid,vector_id,op,queued_at) VALUES(?,?,?,?)")
    .run("gmail:settled#0", "gmail:settled#0", "upsert", origin);
  db.exec("UPDATE install_state SET schema_version=59, vector_projection_status='pending'");
  assert.deepEqual({ ...db.prepare("SELECT documents,chunks FROM corpus_stats WHERE source='gmail'").get() },
    { documents: 1, chunks: 1 }, "schema-65 triggers already maintain the fixture counters");
  let restores = 0; let proofs = 0;
  const log = console.log; const warn = console.warn; console.log = console.warn = () => {};
  try {
    const sent = await drainOutbox(env, { now: () => origin, embed: async () => [0.1], disableBootstrapAdvance: true });
    assert.equal(sent.submitted, 1, "actual writer acceptance control reached");
    assert.ok(env._processNextVectorMutation(), "provider applied the accepted mutation");
    const settled = await drainOutbox(env, { now: () => origin + 1, embed: async () => [0.1], disableBootstrapAdvance: true });
    assert.equal(settled.drained, 1);
    assert.equal(db.prepare("SELECT vector_projection_status AS status FROM install_state").get().status, "verified");
    const result = await cmdRollback(manifest, "fixture-bookmark", {
      confirmed: true,
      withBrainLifecycleLock: async (_options, task) => task({ assertOwned() {} }),
      resolveAccount: async () => ({ id: "fixture-account" }),
      cmdDeploy: async (_path, options) => { assert.equal(options.rollbackWriteFence, true); env.VECTOR_ROLLBACK_FENCE = "1"; },
      cmdHealth: async (_path, options) => { assert.equal(options.expectRollbackFence, true); },
      waitForVectorDrainQuiescence: async () => {},
      d1Query: async (_account, _database, sql) => ({ results: db.prepare(sql).all() }),
      cf: async (path, request) => {
        if (request?.method === "POST") { restores++; return {}; }
        assert.ok(path.endsWith("/fixture-index/info")); proofs++; return env.VECTORIZE.describe();
      },
    });
    assert.equal(result.restored, true); assert.equal(restores, 1); assert.equal(proofs, 2);
    assert.equal(env.VECTOR_ROLLBACK_FENCE, "1");
    assert.equal(result.requiresVectorizeRecreation, true);
  } finally { console.log = log; console.warn = warn; db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("R4 GMAIL-06: upgrade-pause health cannot stand in for the rollback fence", () => {
  const receipt = { ok: false, status: "paused-for-upgrade", accepting_documents: false,
    version: "fixture", vector_writer_protocol: "lease-v1", vector_drain_mode: "paused-for-upgrade" };
  const probe = body => healthProbeVerdict({ ok: true, body: JSON.stringify(body),
    expectVersion: "fixture", expectDrainMode: "paused-for-upgrade", expectRollbackFence: true, attempt: 1, attempts: 1 });
  assert.equal(probe(receipt), "fail", "rollback decision rejects the still-reachable bootstrap generation");
  assert.equal(probe({ ...receipt, rollback_write_fence: true }), "accept");
});

for (const gap of ['pending', 'ambiguous', 'bootstrap_pending', 'provider', 'none']) {
  test(`combined rollback proof: ${gap}`, async () => {
    let queries = 0, providerReads = 0, decisions = 0;
    const row = { schema_version: 65, owner: null, expires_at: null, in_flight: 0,
      pending: 0, ambiguous: 0, bootstrap_pending: 0, projection_status: 'verified',
      mutation_id: null, submitted_at: null };
    if (gap in row) row[gap] = 1;
    const result = await requireRollbackWriterQuiescence({
      accountId: 'fixture-account', databaseId: 'fixture-database', now: () => 0,
      queryDatabase: async () => { queries++; return { results: [row] }; },
      readProvider: async () => { providerReads++; return { vectorCount: gap === 'provider' ? 1 : 0, processedUpToMutation: null }; },
      waitForCutover: async (_wait, { probe }) => {
        decisions++;
        const reading = await probe();
        return { proven: reading.leaseFree && reading.inFlight === 0 };
      },
      wait: async () => {},
    }).then(() => true, () => false);
    assert.equal(queries, 1, 'real durable writer decision reached');
    assert.equal(decisions, 1, 'real cutover callback reached');
    assert.equal(result, gap === 'none');
    if (gap === 'provider' || gap === 'none') assert.equal(providerReads, 1, 'exact provider proof reached');
  });
}
