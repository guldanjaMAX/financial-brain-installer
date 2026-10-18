import assert from 'node:assert/strict';
import { test } from 'node:test';
import { search, searchKeyword, searchVector, vectorReadiness } from '../src/lib/store-d1.js';
import { createProductFixture } from './product-contract-fixture.mjs';
import { createQueryTiming } from '../src/lib/query-timing.js';

function projectionFixture() {
  let clock = 1000;
  const state = { schema_version: 53, outbox_generation: 1, mutation_id: null,
    mutation_submitted_at: null, projection_status: 'verified', bootstrap_epoch: 0,
    bootstrap_cursor: null, bootstrap_high_water: null, expected_vectors: 1, live_vectors: 1 };
  const calls = { describe: 0, marker: 0, outbox: 0, keyword: 0, vector: 0 };
  const control = { pending: 0, count: 1, markerFails: false, describeFails: false, afterDescribe: null, afterState: null };
  const env = {
    DB: { prepare(sql) {
      const statement = {
        bind() { return statement; },
        async all() { if (/chunks_fts MATCH/.test(sql)) calls.keyword++; return { results: [] }; },
        async first() {
          if (/search-projection-marker/.test(sql)) {
            calls.marker++; clock += 10;
            if (control.markerFails) throw new Error('synthetic marker failure');
            return { ...state, has_pending: control.pending ? 1 : 0 };
          }
          if (/vector_projection_mutation_id AS mutation_id/.test(sql)) {
            const snapshot = { ...state };
            control.afterState?.();
            return snapshot;
          }
          if (/FROM vector_outbox/.test(sql)) { calls.outbox++; return { n: control.pending, upserts: control.pending, deletes: 0, submitted: 0 }; }
          return null;
        },
      };
      return statement;
    } },
    VECTORIZE: {
      async query() { calls.vector++; return { matches: [] }; },
      async describe() {
        calls.describe++; clock += 5600;
        if (control.describeFails) throw new Error('synthetic describe failure');
        control.afterDescribe?.();
        return { vectorCount: control.count };
      },
    },
  };
  async function query() {
    const start = clock;
    const timing = createQueryTiming({ route: 'think', now: () => clock });
    const result = await search(env, { query: 'address', embedding: [0.1], timing, now: clock });
    return { ...result, elapsed: clock - start, timing: timing.finish() };
  }
  return { env, state, calls, control, query, advance(ms) { clock += ms; } };
}

test('verified search projection is reused briefly, with an exact generation read on every hit', async () => {
  const f = projectionFixture();
  const cold = await f.query();
  assert.equal(cold.degraded, null);
  assert.equal(f.calls.describe, 1, 'cold verification reached Vectorize');
  const warm = await f.query();
  assert.equal(f.calls.keyword, 2);
  assert.equal(f.calls.vector, 2);
  assert.equal(f.calls.describe, 1, 'warm search must avoid repeated provider readiness');
  assert.ok(f.calls.marker >= 2, 'warm readiness must reach the mutation fence');
  assert.ok(warm.timing.stages.projection_readiness.ms <= 10);
  assert.ok(cold.timing.stages.projection_readiness.ms >= 5600);
  f.state.outbox_generation++;
  f.control.pending = 1;
  const changed = await f.query();
  assert.equal(f.calls.describe, 2);
  assert.equal(changed.degraded_reason, 'projection-incomplete');
  f.control.pending = 0;
  assert.equal((await f.query()).degraded, null);
  assert.equal(f.calls.describe, 3, 'unready result was not cached');
  f.advance(15001);
  await f.query();
  assert.equal(f.calls.describe, 4, 'TTL rechecks provider drift');
  await vectorReadiness(f.env);
  assert.equal(f.calls.describe, 5, 'health and lifecycle exact readiness stays uncached');
});

test('cache is scoped to both bindings and invalidates on failure, pending, bootstrap and concurrent writes', async () => {
  for (const arm of ['marker', 'pending', 'bootstrap', 'binding', 'race']) {
    const f = projectionFixture();
    await f.query();
    assert.equal(f.calls.describe, 1);
    if (arm === 'marker') f.control.markerFails = true;
    if (arm === 'pending') f.control.pending = 1;
    if (arm === 'bootstrap') f.state.bootstrap_epoch++;
    if (arm === 'binding') f.env.VECTORIZE = { ...f.env.VECTORIZE };
    if (arm === 'race') {
      f.advance(15001);
      f.control.afterDescribe = () => { f.state.outbox_generation++; f.control.pending = 1; };
    }
    const result = await f.query();
    assert.ok(f.calls.keyword >= 2, `${arm}: real search reached`);
    if (['pending', 'race'].includes(arm)) assert.equal(result.degraded_reason, 'projection-incomplete');
    else if (arm === 'marker') assert.notEqual(result.degraded, null);
    else assert.equal(f.calls.describe, 2, `${arm}: full proof repeated`);
  }
  const isolated = projectionFixture();
  await isolated.query();
  assert.equal(isolated.calls.describe, 1, 'separate database has a cold proof');
});

test('unfiltered vector failure makes one attempt; filtered failure retains the widening retry', async () => {
  for (const filters of [{}, { source: 'files' }]) {
    let queries = 0;
    const env = { VECTORIZE: { async query() { queries++; throw new Error('synthetic outage'); } } };
    await assert.rejects(searchVector(env, [0.1], { limit: 5, filters }), /synthetic outage/);
    assert.equal(queries, Object.keys(filters).length ? 2 : 1, 'provider decision reached');
  }
  let queries = 0;
  const good = { VECTORIZE: { async query() { queries++; return { matches: [] }; } } };
  assert.deepEqual(await searchVector(good, [0.1], { limit: 5 }), []);
  assert.equal(queries, 1);
});

test('a mutation after full readiness cannot seed a stale ready receipt; failed proofs are never reused', async () => {
  const f = projectionFixture();
  f.control.afterState = () => { f.state.outbox_generation++; };
  assert.equal((await f.query()).degraded_reason, 'projection-incomplete');
  assert.equal(f.calls.describe, 1, 'full verification reached the race');
  f.control.afterState = null;
  assert.equal((await f.query()).degraded, null);
  assert.equal(f.calls.describe, 2, 'racing ready proof was not cached');
  f.advance(15001);
  f.control.describeFails = true;
  assert.equal((await f.query()).degraded_reason, 'projection-incomplete');
  assert.equal(f.calls.describe, 3);
  f.control.describeFails = false;
  assert.equal((await f.query()).degraded, null);
  assert.equal(f.calls.describe, 4);
  assert.equal((await f.query()).degraded, null);
  assert.equal(f.calls.describe, 4, 'fresh green control is cached');
});

test('keyword retrieval uses FTS ordered rank with identical scores and authorized candidates', async t => {
  const f = await createProductFixture();
  t.after(() => f.close());
  for (let i = 0; i < 80; i++) {
    const source = i % 2 ? 'files' : 'other';
    const id = `${source}:fixture-${i}`;
    f.raw('INSERT INTO documents(doc_uid,source,source_id,ingested_at,content_hash) VALUES(?,?,?,?,?)', id, source, `fixture-${i}`, 1, `hash-${i}`);
    f.raw('INSERT INTO chunks(chunk_uid,doc_uid,chunk_ix,text,source) VALUES(?,?,?,?,?)', `${id}#0`, id, 0,
      `${'address '.repeat(i + 1)} ${'record '.repeat(81 - i)}`, source);
  }
  const actual = await searchKeyword(f.env, 'address', { limit: 7, filters: { source: 'files' } });
  assert.equal(actual.length, 7, 'nonempty result reached ranking and filters');
  assert.ok(actual.every(row => row.source === 'files'));
  const index = f.seen.sql.findLastIndex(sql => /chunks_fts MATCH/.test(sql));
  const sql = f.seen.sql[index], binds = f.seen.binds[index];
  const baseline = sql.replace(/ORDER BY chunks_fts\.rank/, 'ORDER BY bm25(chunks_fts)').replace('CROSS JOIN chunks c', 'JOIN chunks c');
  const expected = f.rows(baseline, ...binds);
  assert.deepEqual(actual.map(row => [row.chunk_uid, row.score]), expected.map(row => [row.chunk_uid, row.score]));
  const plan = f.rows(`EXPLAIN QUERY PLAN ${sql}`, ...binds).map(row => row.detail).join('\n');
  t.diagnostic(plan);
  assert.doesNotMatch(plan, /USE TEMP B-TREE FOR ORDER BY/, 'FTS must supply ordered rank without a temp sort');
  assert.match(plan, /SEARCH old_memory USING INDEX/);
  assert.match(plan, /SEARCH current_memory USING INDEX/);
});
