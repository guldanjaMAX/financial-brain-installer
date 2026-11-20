import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../src/index.js";
import { BANK_ACCESS_WRAPPING_KEY_SECRET } from "../src/lib/bank-feed.js";
import { coverageGapReport } from "../src/lib/store-d1.js";
import { WORKER_VERSION } from "../src/lib/version.js";

/* A paused brain refuses ingest on eight write paths. Reporting ok:true through
   that is what turned one client's failed update into eight days of silence: they
   added nothing, and nothing told them anything was wrong. These tests exist so that
   cannot come back. */

const base = { BRAIN_NAME: "fixture-client", BRAIN_VERSION: "0.1.18" };
const health = async (env) => {
  const res = await worker.fetch(new Request("https://b.example/health"), env, {});
  return { res, body: await res.json() };
};

/* ---------------- an active brain reports ok */

{
  const { res, body } = await health({ ...base });
  assert.equal(res.status, 200);
  assert.equal(body.ok, true, "an unpaused brain is ok");
  assert.equal(body.status, "ok");
  assert.equal(body.accepting_documents, true);
  assert.equal(body.vector_drain_mode, "active");
}

/* ---------------- a paused brain says so, in the field that monitors read */

{
  const { res, body } = await health({ ...base, VECTOR_DRAIN_MODE: "paused-for-upgrade" });
  assert.equal(
    body.ok, false,
    "a brain that cannot accept a document must not report ok:true",
  );
  assert.equal(body.status, "paused-for-upgrade");
  assert.equal(body.accepting_documents, false);
  assert.match(body.reason, /cannot accept documents/i, "the reason is plain language");
  assert.match(body.reason, /did not finish/i, "it names the cause, a partial update");

  // Deliberate: update's own paused-mode probe must still succeed while the
  // pause is in force, so the HTTP status stays 200 and only the body tells
  // the truth. Changing this to 503 breaks brain update.
  assert.equal(
    res.status, 200,
    "HTTP stays 200 so update's paused-mode health probe still passes",
  );
}

/* ---------------- the fields update depends on survive both ways */

for (const env of [{ ...base }, { ...base, VECTOR_DRAIN_MODE: "paused-for-upgrade" }]) {
  const { body } = await health(env);
  // Health reports the version of the CODE answering, not the deploy-time
  // variable. The variable can outlive the code it described, and on one brain
  // it did so by two releases for months while every probe looked healthy. The
  // two callers that match on this field, setup's already-live refusal and
  // verifyRollbackHealth's expectVersion, both compare against the package
  // version, so reporting the code's own version is what makes them mean
  // anything.
  // Compared against the source constant, not a literal. A literal here has to be
  // hand-edited every release, which is the same drift class UPDATE-038 exists for,
  // and current-version.test.mjs already pins WORKER_VERSION to package.json.
  assert.equal(body.version, WORKER_VERSION, "health reports the worker's own version");
  assert.equal(body.configured_version, "0.1.18", "a disagreeing deploy-time variable is surfaced");
  assert.equal(body.version_mismatch, true, "and the disagreement is named rather than hidden");
  assert.equal(body.vector_writer_protocol, "lease-v1", "cmdHealth matches on protocol");
  assert.ok(body.vector_drain_mode, "cmdHealth matches on drain mode");
}

/* ---------------- an unknown drain mode is not treated as paused */

{
  const { body } = await health({ ...base, VECTOR_DRAIN_MODE: "something-else" });
  assert.equal(body.ok, true, "only the exact paused sentinel means paused");
  assert.equal(body.vector_drain_mode, "active");
}

/* ---------------- active D1 health publishes only aggregate source counts */

{
  const now = Date.parse("2026-10-05T12:00:00Z");
  const originalNow = Date.now;
  const sourceRows = [
    {
      name: "alpha-mail", kind: "mailbox_fixture", status: "ready", registered: 1,
      last_ingest_at: new Date(now - 12 * 3600000).toISOString(),
      last_complete_sweep_at: null,
      expected_refresh_seconds: 86400, indexing_started_at: null,
    },
    {
      name: "beta-calendar", kind: "calendar_fixture", status: "error", registered: 1,
      last_ingest_at: new Date(now - 12 * 3600000).toISOString(),
      last_complete_sweep_at: new Date(now - 12 * 3600000).toISOString(),
      expected_refresh_seconds: 86400, stale_reason: "FIXTURE_REFRESH_FAILED", indexing_started_at: null,
    },
    {
      name: "zeta-files", kind: "files_fixture", status: "ready", registered: 1,
      last_ingest_at: new Date(now - 20 * 86400000).toISOString(),
      last_complete_sweep_at: null,
      expected_refresh_seconds: null, indexing_started_at: null,
    },
  ];
  let schemaReads = 0;
  let sourceReads = 0;
  const env = {
    ...base,
    STORAGE: "d1",
    DB: {
      prepare(sql) {
        if (/install_state/.test(sql)) {
          schemaReads++;
          return { first: async () => ({ schema_version: 48 }) };
        }
        if (/FROM sources s/.test(sql)) {
          sourceReads++;
          return { all: async () => ({ results: sourceRows }) };
        }
        throw new Error(`unexpected fixture SQL: ${sql}`);
      },
    },
  };
  try {
    Date.now = () => now;
    const { res, body } = await health(env);
    assert.equal(res.status, 200, "R1 aggregate freshness keeps health reachable");
    assert.equal(body.ok, true, "R1 stale sources do not make health fail");
    assert.equal(body.status, "ok");
    assert.equal(body.accepting_documents, true);
    assert.equal(body.schema_version, 48);
    assert.deepEqual(
      {
        total: body.sources_total,
        stale: body.sources_stale,
        unscheduled: body.sources_unscheduled,
      },
      { total: 3, stale: 1, unscheduled: 1 },
      "R1 active D1 health publishes exact aggregate source counts",
    );
    assert.equal(schemaReads, 1, "R1 reached the schema decision point");
    assert.equal(sourceReads, 1, "R1 reached the source-count decision point");

    const serialized = JSON.stringify(body);
    for (const privateFixtureText of [
      "alpha-mail", "beta-calendar", "zeta-files",
      "mailbox_fixture", "calendar_fixture", "files_fixture", "FIXTURE_REFRESH_FAILED",
    ]) {
      assert.equal(serialized.includes(privateFixtureText), false, `R2 health omits ${privateFixtureText}`);
    }
    const detailed = await coverageGapReport(env, { now });
    assert.ok(
      ["alpha-mail", "beta-calendar", "zeta-files"].every((name) =>
        detailed.gaps.some((gap) => gap.source === name)),
      "R2 positive control proves the detailed report had fixture names available",
    );
  } finally {
    Date.now = originalNow;
  }
}

/* ---------------- unavailable, paused, and non-D1 counts remain absent */

{
  let prepareCalls = 0;
  const paused = await health({
    ...base,
    STORAGE: "d1",
    VECTOR_DRAIN_MODE: "paused-for-upgrade",
    DB: { prepare: () => { prepareCalls++; throw new Error("paused health touched D1"); } },
  });
  assert.equal(paused.res.status, 200, "R3 paused health remains reachable");
  assert.equal(prepareCalls, 0, "R3 paused health performs zero database calls");
  assert.equal("sources_total" in paused.body, false);
  assert.equal("sources_stale" in paused.body, false);
  assert.equal("sources_unscheduled" in paused.body, false);

  for (const failure of ["schema", "sources", "both"]) {
    let schemaAttempts = 0;
    let sourceAttempts = 0;
    const failed = await health({
      ...base,
      STORAGE: "d1",
      DB: {
        prepare(sql) {
          if (/install_state/.test(sql)) {
            schemaAttempts++;
            return {
              first: async () => {
                if (failure === "schema" || failure === "both") throw new Error("fixture schema read failed");
                return { schema_version: 48 };
              },
            };
          }
          if (/FROM sources s/.test(sql)) {
            sourceAttempts++;
            return {
              all: async () => {
                if (failure === "sources" || failure === "both") throw new Error("fixture source read failed");
                return { results: [] };
              },
            };
          }
          throw new Error(`unexpected fixture SQL: ${sql}`);
        },
      },
    });
    assert.equal(failed.res.status, 200, `R4 ${failure} failure keeps health reachable`);
    assert.equal(failed.body.ok, false, `R4 ${failure} failure cannot report a healthy database`);
    assert.equal(failed.body.status, "storage-unavailable");
    assert.match(failed.body.reason, /database.*could not be read/i);
    assert.equal(failed.body.accepting_documents, true,
      "storage availability does not change the pause-only accepting_documents field");
    assert.equal(failed.body.vector_drain_mode, "active");
    assert.equal(schemaAttempts, 1, `R4 ${failure} arm reached the schema decision point`);
    assert.equal(sourceAttempts, 1, `R4 ${failure} arm reached the source-count decision point`);
    if (failure === "sources") {
      assert.equal(failed.body.schema_version, 48, "R4 schema evidence survives a source read failure");
    } else {
      assert.equal("schema_version" in failed.body, false);
    }
    if (failure === "schema") {
      assert.deepEqual(
        [failed.body.sources_total, failed.body.sources_stale, failed.body.sources_unscheduled],
        [0, 0, 0],
        "R4 valid aggregate counts survive a schema read failure",
      );
    } else {
      assert.equal("sources_total" in failed.body, false);
      assert.equal("sources_stale" in failed.body, false);
      assert.equal("sources_unscheduled" in failed.body, false);
    }
  }

  const nonD1 = await health({ ...base });
  assert.equal("sources_total" in nonD1.body, false, "R5 non-D1 health has no source counts");
  assert.equal("sources_stale" in nonD1.body, false);
  assert.equal("sources_unscheduled" in nonD1.body, false);
}

const privateFixture = {
  owner: "sample-owner-fixture",
  id: "987654321",
  institution: "Synthetic Orchard Bank",
  email: "tester@example.invalid",
  opaque: Buffer.from("synthetic private fixture bytes").toString("base64"),
};

function flagFixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const migrations = new URL("../../migrations/d1/", import.meta.url);
  for (const file of readdirSync(migrations).filter(name => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(file, migrations), "utf8"));
  }
  db.exec(`INSERT INTO install_state(id,client_slug,product_version,schema_version,installed_at)
    VALUES (1,'synthetic','0.0.0',69,'2026-11-17T00:00:00Z')`);
  const reads = { bank: 0, answers: 0 };
  const failures = new Set();
  const env = {
    ...base,
    BRAIN_NAME: privateFixture.owner,
    ADMIN_KEY: crypto.randomUUID(),
    STORAGE: "d1",
    [BANK_ACCESS_WRAPPING_KEY_SECRET]: `v2.${Buffer.alloc(32).toString("base64url")}`,
    DB: {
      exec: async sql => db.exec(sql),
      prepare(sql) {
        const flag = /FROM bank_feed_items\b/i.test(sql) ? "bank"
          : /FROM llm_call_log\b/i.test(sql) && !/SUM\(/i.test(sql) ? "answers" : null;
        const statement = db.prepare(sql);
        const query = (...args) => ({
          async run() { return statement.run(...args); },
          async first() {
            if (flag) {
              reads[flag]++;
              if (failures.has(flag)) throw new Error(privateFixture.opaque);
            }
            return statement.get(...args) ?? null;
          },
          async all() {
            if (flag) {
              reads[flag]++;
              if (failures.has(flag)) throw new Error(privateFixture.opaque);
            }
            return { results: statement.all(...args) };
          },
        });
        return { ...query(), bind: query };
      },
    },
  };
  // Read the success time from Date.now(), not new Date(): a test that pins
  // Date.now must see a sync that happened at its pinned time, never one a
  // real-clock millisecond later, which the flag rightly treats as future.
  const addBank = (id = privateFixture.id, success = new Date(Date.now()).toISOString()) => {
    db.prepare(`INSERT INTO bank_feed_items
      (item_ref,institution_label,access_ciphertext,access_iv,environment,connected_at)
      VALUES (?,?,?,?,'production',?)`)
      .run(id, privateFixture.institution, privateFixture.opaque, "Zml4dHVyZQ", success);
    db.prepare(`INSERT INTO bank_feed_health (tenant_id,item_ref,last_successful_sync_at)
      VALUES ('primary',?,?)`).run(id, success);
  };
  env.ANSWER_MODEL = privateFixture.email;
  const addAnswer = (status, label = "answer-check-outcome") =>
    db.prepare(`INSERT INTO llm_call_log (ts,day,label,model,status)
      VALUES ('2026-11-17','2026-11-17',?,?,?)`)
      .run(label, JSON.stringify([env.ANSWER_MODEL, env.GATE_MODEL || env.ANSWER_MODEL]), status);
  return { db, env, reads, failures, addBank, addAnswer };
}

test("public flags distinguish no live bank and no recorded answer check", async t => {
  const { db, env, addBank, addAnswer } = flagFixture(t);
  addAnswer("ok", "answer-model-check");
  addAnswer("ok", "unrelated");
  delete env[BANK_ACCESS_WRAPPING_KEY_SECRET];
  const { body, res } = await health(env);
  assert.equal(res.status, 200);
  assert.deepEqual([body.bank, body.answers], ["none", "unknown"]);
  addBank();
  db.exec("UPDATE bank_feed_items SET removed_at=connected_at");
  t.mock.method(Date, "now", () => Date.parse(body.ts) + 60_001);
  assert.equal((await health(env)).body.bank, "none");
});

test("healthy bank and latest answer check are ok, and the entire JSON omits private values", async t => {
  const { env, addBank, addAnswer } = flagFixture(t);
  addBank();
  addAnswer("error");
  addAnswer("ok");
  addAnswer("error", "unrelated");
  const { body } = await health(env);
  const serialized = JSON.stringify(body);
  assert.equal(/\d{6,}|[A-Za-z0-9+/_-]{32,}={0,2}|Synthetic Orchard Bank|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/i.test(serialized),
    false, "public response contains a forbidden shape");
  const { owner, ...storedPrivateValues } = privateFixture;
  assert.equal(Object.values(storedPrivateValues).some(value => serialized.includes(value)), false);
  // MAIN's open compatibility decision: the inherited brain and ts fields.
  assert.equal(body.brain, owner);
  assert.match(body.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(new Date(body.ts).toISOString(), body.ts);
  assert.deepEqual(body, {
    ok: true,
    status: "ok",
    accepting_documents: true,
    brain: owner,
    version: WORKER_VERSION,
    configured_version: base.BRAIN_VERSION,
    version_mismatch: true,
    schema_version: 69,
    sources_total: 0,
    sources_stale: 0,
    sources_unscheduled: 0,
    vector_writer_protocol: "lease-v1",
    vector_drain_mode: "active",
    rollback_write_fence: false,
    bank: "ok",
    answers: "ok",
    ts: body.ts,
  });
  assert.deepEqual([body.bank, body.answers], ["ok", "ok"]);
});

for (const fault of ["stored bank error", "missing wrapping key", "stale sync", "malformed sync"]) {
  test(`public flags surface ${fault} and a failing answer check`, async t => {
    const { db, env, addBank, addAnswer } = flagFixture(t);
    addBank("healthy-item");
    addBank(undefined, fault === "stale sync" ? "2026-01-01T00:00:00Z"
      : fault === "malformed sync" ? privateFixture.email : undefined);
    if (fault === "stored bank error") {
      db.prepare("UPDATE bank_feed_health SET last_error_code=?,last_error_meaning=? WHERE item_ref=?")
        .run("BANK_ACCESS_REFERENCE_UNREADABLE", privateFixture.email, privateFixture.id);
    }
    if (fault === "missing wrapping key") delete env[BANK_ACCESS_WRAPPING_KEY_SECRET];
    addAnswer("ok");
    addAnswer("blocked");
    const { body, res } = await health(env);
    assert.equal(res.status, 200);
    assert.equal(body.ok, true, "flags leave overall storage health independent");
    assert.deepEqual([body.bank, body.answers], ["needs_attention", "needs_attention"]);
  });
}

test("read failures stay unknown independently, and paused health performs no flag reads", async t => {
  const { env, reads, failures, addBank, addAnswer } = flagFixture(t);
  addBank();
  addAnswer("ok");
  failures.add("bank");
  const { body, res } = await health(env);
  assert.equal(res.status, 200);
  assert.deepEqual([body.bank, body.answers], ["unknown", "ok"]);
  assert.equal(JSON.stringify(body).includes(privateFixture.opaque), false);
  const paused = await health({ ...env, VECTOR_DRAIN_MODE: "paused-for-upgrade" });
  assert.deepEqual([paused.body.bank, paused.body.answers], ["unknown", "unknown"]);
  assert.deepEqual(reads, { bank: 1, answers: 1 });
  const other = flagFixture(t);
  other.addBank();
  other.failures.add("answers");
  const unreadable = await health(other.env);
  assert.deepEqual([unreadable.body.bank, unreadable.body.answers], ["ok", "unknown"]);
});

test("an invalid D1 binding keeps the public page reachable", async () => {
  const { body, res } = await health({ ...base, STORAGE: "d1", DB: "fixture binding" });
  assert.equal(res.status, 200);
  assert.equal(body.status, "storage-unavailable");
  assert.deepEqual([body.bank, body.answers], ["unknown", "unknown"]);
});

test("each flag reads once per minute and refreshes after expiry", async t => {
  const { env, reads, addBank, addAnswer } = flagFixture(t);
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  addBank();
  addAnswer("ok");
  const { body: first } = await health(env);
  assert.deepEqual([first.bank, first.answers], ["ok", "ok"]);
  assert.deepEqual(reads, { bank: 1, answers: 1 });
  addAnswer("error");
  Date.now.mock.mockImplementation(() => now + 59_999);
  const { body: cached } = await health({ ...env });
  assert.equal(cached.answers, "ok");
  assert.deepEqual(reads, { bank: 1, answers: 1 });
  Date.now.mock.mockImplementation(() => now + 60_000);
  const { body: refreshed } = await health(env);
  assert.equal(refreshed.answers, "needs_attention");
  assert.deepEqual(reads, { bank: 2, answers: 2 });
});

test("fresh cached flags never cross D1 bindings or bank tenants", async t => {
  const first = flagFixture(t);
  const second = flagFixture(t);
  first.addBank();
  first.addAnswer("ok");
  second.addAnswer("error");
  assert.deepEqual(await readFlags(first.env), ["ok", "ok"]);
  assert.deepEqual(await readFlags(second.env), ["none", "needs_attention"]);
  assert.deepEqual(await readFlags({ ...first.env, BANK_FEED_TENANT: "another-tenant" }), ["none", "ok"]);
  assert.deepEqual(first.reads, { bank: 2, answers: 2 });
  assert.deepEqual(second.reads, { bank: 1, answers: 1 });

  async function readFlags(env) {
    const { body, res } = await health(env);
    assert.equal(res.status, 200);
    return [body.bank, body.answers];
  }
});

test("old or unrecognized model checks cannot establish answer health", async t => {
  const old = flagFixture(t);
  old.addAnswer("ok");
  old.db.exec(`
    WITH RECURSIVE tail(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM tail WHERE n<256)
    INSERT INTO llm_call_log (ts,day,label,status)
    SELECT '2026-11-17','2026-11-17','unrelated','ok' FROM tail
  `);
  assert.equal((await health(old.env)).body.answers, "unknown");
  const unrecognized = flagFixture(t);
  unrecognized.addAnswer("ok");
  unrecognized.addAnswer(privateFixture.opaque);
  assert.equal((await health(unrecognized.env)).body.answers, "unknown");
});

// Vary valid fixture timestamps using a fixed seed so every case is reproducible.
const evidenceSeed = 0x713b260d;
function evidenceOffset(index) {
  return 1000 + ((Math.imul(index + 1, 1664525) + evidenceSeed) >>> 0) % 3_600_000;
}

for (const [index, fault] of ["future", "invalid calendar", "missing"].entries()) {
  test(`bank rejects ${fault} success evidence`, async t => {
    const { db, env, reads, addBank } = flagFixture(t);
    const now = fault === "invalid calendar" ? Date.parse("2026-03-01T12:00:00Z") : Date.now();
    t.mock.method(Date, "now", () => now);
    addBank(undefined, new Date(now - evidenceOffset(index)).toISOString());
    assert.equal((await health(env)).body.bank, "ok");
    const invalid = fault === "future" ? new Date(now + evidenceOffset(index)).toISOString()
      : fault === "invalid calendar" ? "2026-02-30T00:00:00Z" : null;
    db.prepare("UPDATE bank_feed_health SET last_successful_sync_at=?").run(invalid);
    Date.now.mock.mockImplementation(() => now + 60_000);
    // Keep the generated future evidence ahead of the refreshed clock.
    assert.ok(fault !== "future" || Date.parse(invalid) > Date.now());
    const { body, res } = await health(env);
    assert.equal(res.status, 200);
    assert.equal(reads.bank, 2);
    assert.equal(body.bank, "needs_attention");
  });
}

const schedules = [
  ...["pending", "retryable", "running"].flatMap(state =>
    ["due_at", "provider_retry_not_before"].map(field => [state, field])),
  ["simplefin", "next_pull_at"],
];
for (const [index, [state, field]] of schedules.entries()) {
  test(`bank rejects unusable ${state} ${field} despite a recent sync`, async t => {
    const { db, env, reads, addBank } = flagFixture(t);
    const now = Date.now();
    t.mock.method(Date, "now", () => now);
    const stamp = new Date(now - evidenceOffset(index)).toISOString();
    addBank(undefined, stamp);
    const simplefin = state === "simplefin";
    const table = simplefin ? "simplefin_connections" : "plaid_reconciliation";
    if (simplefin) {
      db.prepare(`INSERT INTO simplefin_connections
        (item_ref,backfill_start,backfill_next,backfill_end,next_pull_at,updated_at)
        VALUES (?,'2026-11-01','2026-11-01','2026-11-01',?,?)`).run(privateFixture.id, stamp, stamp);
    } else {
      db.prepare(`INSERT INTO plaid_reconciliation
        (item_ref,reason,state,due_at,provider_retry_not_before,updated_at)
        VALUES (?,'fixture',?,?,?,?)`).run(privateFixture.id, state, stamp, stamp, stamp);
    }
    assert.equal((await health(env)).body.bank, "ok");
    // A lexically low malformed field used to disappear behind the other valid due time.
    db.prepare(`UPDATE ${table} SET ${field}=?`).run(index % 2 ? " " : "");
    Date.now.mock.mockImplementation(() => now + 60_000);
    const { body, res } = await health(env);
    assert.equal(res.status, 200);
    assert.equal(reads.bank, 2);
    assert.equal(body.bank, "needs_attention");
  });
}

const providerReply = () => Response.json({
  content: [{ type: "text", text: "OK" }], model: "provider-fixture-alias", usage: {}, stop_reason: "end_turn",
});

async function answerCheck(env) {
  const res = await worker.fetch(new Request("https://b.example/api/admin/brain/answer-check", {
    method: "POST", headers: { "X-Admin-Key": env.ADMIN_KEY },
  }), env, {});
  assert.equal(res.status, 200);
  return res.json();
}

test("a model configuration change cannot reuse the cached or persisted answer success", async t => {
  const { env, reads } = flagFixture(t);
  env.ANTHROPIC_API_KEY = "fixture";
  env.ANSWER_MODEL = "fixture-answer";
  const calls = t.mock.method(globalThis, "fetch", async () => providerReply());
  assert.equal((await answerCheck(env)).answer.status, "ok");
  assert.equal(calls.mock.callCount(), 1);
  assert.equal((await health(env)).body.answers, "ok");
  const changed = { ...env, ANSWER_MODEL: "@cf/fixture" };
  assert.equal((await health(changed)).body.answers, "unknown");
  assert.equal(reads.answers, 2);
  assert.equal((await answerCheck(changed)).answer.status, "built_in");
  assert.equal(calls.mock.callCount(), 1);
  assert.equal((await health(env)).body.answers, "unknown", "a newer untested configuration supersedes old success");
  assert.equal(reads.answers, 3);
});

test("an unavailable aggregate write reports a safe error and leaves public health reachable", async t => {
  const { env, reads } = flagFixture(t);
  env.ANSWER_MODEL = "@cf/fixture";
  const prepare = env.DB.prepare;
  let writes = 0;
  env.DB.prepare = sql => {
    if (/INSERT INTO llm_call_log/.test(sql)) {
      writes++;
      throw new Error(privateFixture.opaque);
    }
    return prepare(sql);
  };
  const res = await worker.fetch(new Request("https://b.example/api/admin/brain/answer-check", {
    method: "POST", headers: { "X-Admin-Key": env.ADMIN_KEY },
  }), env, {});
  assert.equal(writes, 1);
  const { body, res: publicRes } = await health(env);
  assert.equal(publicRes.status, 200);
  assert.equal(reads.answers, 1);
  assert.equal(body.answers, "unknown");
  assert.equal((await res.text()).includes(privateFixture.opaque), false);
  assert.equal(res.status, 503);
});

for (const [index, [role, outcome]] of ["answer", "check"].flatMap(role =>
  ["rejected", "unreadable", "built_in", "built_in_with_failure"].map(outcome => [role, outcome])).entries()) {
  test(`answer health aggregates the ${role} ${outcome} outcome`, async t => {
    const { db, env, reads } = flagFixture(t);
    env.ANTHROPIC_API_KEY = "fixture";
    env.ANSWER_MODEL = `fixture-answer-${evidenceOffset(index)}`;
    env.GATE_MODEL = `fixture-gate-${evidenceOffset(index)}`;
    let fault;
    const calls = [];
    t.mock.method(globalThis, "fetch", async (_url, request) => {
      const { model } = JSON.parse(request.body);
      calls.push(model);
      if (model !== fault) return providerReply();
      return outcome === "unreadable" ? Response.json({ content: [] }) : Response.json({}, { status: 401 });
    });
    const models = [env.ANSWER_MODEL, env.GATE_MODEL];
    const selected = role === "answer" ? 0 : 1;
    const check = () => answerCheck(env);
    const good = await check();
    assert.deepEqual([good.answer.status, good.check.status], ["ok", "ok"]);
    assert.deepEqual(calls.splice(0), models);
    const now = Date.now();
    t.mock.method(Date, "now", () => now);
    assert.equal((await health(env)).body.answers, "ok");
    const builtIn = outcome.startsWith("built_in");
    if (builtIn) env[selected === 0 ? "ANSWER_MODEL" : "GATE_MODEL"] = "@cf/fixture";
    if (outcome !== "built_in") fault = models[builtIn ? 1 - selected : selected];
    const broken = await check();
    assert.equal(broken[role].status,
      { rejected: "key_rejected", unreadable: "check_problem", built_in: "built_in", built_in_with_failure: "built_in" }[outcome]);
    assert.equal(broken[role === "answer" ? "check" : "answer"].status,
      outcome === "built_in_with_failure" ? "key_rejected" : "ok");
    assert.deepEqual(calls.splice(0), builtIn ? [models[1 - selected]] : models);
    assert.deepEqual(db.prepare(`SELECT status FROM llm_call_log
      WHERE label='answer-check-outcome' ORDER BY id`).all().map(row => row.status),
    ["ok", outcome === "built_in" ? "unknown" : "error"]);
    Date.now.mock.mockImplementation(() => now + 60_000);
    const { body, res } = await health(env);
    assert.equal(res.status, 200);
    assert.equal(reads.answers, 2);
    assert.deepEqual(calls, [], "public polling makes no provider calls");
    assert.equal(body.answers, outcome === "built_in" ? "unknown" : "needs_attention");
  });
}
