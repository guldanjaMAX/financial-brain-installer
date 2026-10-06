import assert from "node:assert/strict";
import worker from "../src/index.js";
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

  let sourceAttempts = 0;
  const failed = await health({
    ...base,
    STORAGE: "d1",
    DB: {
      prepare(sql) {
        if (/install_state/.test(sql)) return { first: async () => ({ schema_version: 48 }) };
        sourceAttempts++;
        return { all: async () => { throw new Error("fixture source read failed"); } };
      },
    },
  });
  assert.equal(failed.res.status, 200, "R4 source-count failure keeps health reachable");
  assert.equal(failed.body.ok, true);
  assert.equal(failed.body.schema_version, 48, "R4 schema evidence survives a source read failure");
  assert.ok(sourceAttempts > 0, "R4 source query decision point was reached");
  assert.equal("sources_total" in failed.body, false);
  assert.equal("sources_stale" in failed.body, false);
  assert.equal("sources_unscheduled" in failed.body, false);

  const nonD1 = await health({ ...base });
  assert.equal("sources_total" in nonD1.body, false, "R5 non-D1 health has no source counts");
  assert.equal("sources_stale" in nonD1.body, false);
  assert.equal("sources_unscheduled" in nonD1.body, false);
}

console.log("health honesty: all focused offline tests passed");
