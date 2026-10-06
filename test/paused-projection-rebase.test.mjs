import assert from "node:assert/strict";
import test from "node:test";

import { rebasePausedVerifiedProjection } from "../brain.mjs";
import { vectorReadiness } from "../worker/src/lib/store-d1.js";

function rebaseFixture({ status = "verified", hasOutbox = 0, exact = 5, persist = true } = {}) {
  const calls = [];
  const queryDatabase = async (_accountId, _databaseId, sql, params = []) => {
    calls.push({ sql, params });
    if (/EXISTS\(SELECT 1 FROM vector_outbox/i.test(sql) && /^\s*SELECT/i.test(sql)) {
      return { results: [{ status, has_outbox: hasOutbox }] };
    }
    if (/^\s*SELECT COUNT\(\*\) AS expected_vectors FROM chunks/i.test(sql)) {
      return { results: [{ expected_vectors: exact }] };
    }
    if (/^\s*UPDATE install_state/i.test(sql)) {
      return { results: persist ? [{ expected_vectors: params[0] }] : [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return { calls, queryDatabase };
}

const exactCountCalls = (calls) => calls.filter(({ sql }) =>
  /^\s*SELECT COUNT\(\*\) AS expected_vectors FROM chunks/i.test(sql));

test("the paused update rebase counts once and persists the verified empty-queue cut", async () => {
  const fixture = rebaseFixture({ exact: 5 });

  const result = await rebasePausedVerifiedProjection({
    accountId: "fixture-account",
    databaseId: "fixture-database",
    queryDatabase: fixture.queryDatabase,
  });

  assert.deepEqual(result, { rebased: true, expectedVectors: 5 });
  assert.equal(exactCountCalls(fixture.calls).length, 1,
    "one update may perform exactly one full corpus count");
  assert.equal(fixture.calls.length, 3);
  assert.deepEqual(fixture.calls[2].params, [5]);
});

for (const scenario of [
  { label: "queued work", status: "verified", hasOutbox: 1, reason: "vector_work_queued" },
  { label: "bootstrap-required state", status: "bootstrap_required", hasOutbox: 0, reason: "projection_not_verified" },
]) {
  test(`the paused update does not count or rebase ${scenario.label}`, async () => {
    const fixture = rebaseFixture(scenario);

    const result = await rebasePausedVerifiedProjection({
      accountId: "fixture-account",
      databaseId: "fixture-database",
      queryDatabase: fixture.queryDatabase,
    });

    assert.deepEqual(result, { rebased: false, reason: scenario.reason });
    assert.equal(fixture.calls.length, 1,
      "the state decision point must be reached without a corpus count");
    assert.equal(exactCountCalls(fixture.calls).length, 0);
  });
}

test("the paused update fails closed if state changes before the exact cut is persisted", async () => {
  const fixture = rebaseFixture({ persist: false });

  await assert.rejects(
    rebasePausedVerifiedProjection({
      accountId: "fixture-account",
      databaseId: "fixture-database",
      queryDatabase: fixture.queryDatabase,
    }),
    /changed before its exact count could be recorded/,
  );

  assert.equal(exactCountCalls(fixture.calls).length, 1);
  assert.equal(fixture.calls.length, 3,
    "the refusal must follow both the exact-count and conditional-persist decision points");
});

const emptyOutbox = {
  pending: 0,
  pending_is_capped: false,
  pending_display: "0",
  upserts: 0,
  deletes: 0,
  submitted: 0,
  component_counts_exact: true,
  oldest_queued_at: null,
};

function readinessFixture(mode) {
  const statements = [];
  const state = {
    schema_version: 47,
    outbox_generation: 0,
    mutation_id: null,
    mutation_submitted_at: null,
    projection_status: "verified",
    bootstrap_epoch: 0,
    bootstrap_cursor: null,
    bootstrap_high_water: null,
    expected_vectors: 5,
    live_vectors: 5,
  };
  const env = {
    VECTOR_DRAIN_MODE: mode,
    VECTORIZE: { describe: async () => ({ vectorCount: 5, processedUpToMutation: null }) },
    DB: {
      prepare(sql) {
        statements.push(sql);
        const prepared = {
          bind: () => prepared,
          first: async () => state,
        };
        return prepared;
      },
    },
  };
  return { env, statements };
}

for (const mode of ["active", "paused-for-upgrade"]) {
  test(`ordinary ${mode} readiness never performs a full corpus count`, async () => {
    const fixture = readinessFixture(mode);

    const readiness = await vectorReadiness(fixture.env, { outbox: emptyOutbox });

    assert.equal(readiness.ready, true, JSON.stringify(readiness));
    assert.equal(fixture.statements.some((sql) =>
      /COUNT\(\*\)\s+AS\s+expected_vectors[\s\S]*FROM\s+chunks/i.test(sql)), false,
    "ordinary health/status must stay bounded");
  });
}
