import test from 'node:test';
import assert from 'node:assert/strict';
import { search } from '../src/lib/store-d1.js';
import { searchFailureLogging, privacyCounterexamples, numericContentCarrier, keywordFailureProbe } from './fixtures/search-failure-logging.mjs';

test('provider document, normalized date and escaped query never enter warnings', async () => {
  assert.equal(await privacyCounterexamples(search), 3);
});

for (const carrier of ['document', 'bound', 'sql', 'query']) {
  test(`numeric content markers never enter warnings from ${carrier}`, async () => {
    await numericContentCarrier(search, carrier);
  });
}

test('only closed categories, fixed messages and reviewed provider codes enter warnings', async () => {
  const messages = {
    d1_overloaded: 'D1 refused the search because it is overloaded.',
    d1_timeout: 'D1 search timed out.',
    d1_sql_error: 'D1 search failed because of a SQL or schema error.',
    d1_bind_limit: 'D1 search exceeded the parameter limit.',
    vectorize_error: 'The vector index could not complete the search stage.',
    network: 'A network failure interrupted the search stage.',
    unknown: 'The search stage failed for an unclassified reason.',
  };
  const cases = [
    ['d1_overloaded', { message: 'D1_ERROR: overloaded with synthetic payload [code: 7429]' }, 7429],
    ['d1_overloaded', { code: 7429, name: 'SyntheticPrivateName', message: 'synthetic payload' }, 7429],
    ['d1_overloaded', { code: '7429' }, 7429],
    ['d1_overloaded', { message: 'D1 DB is overloaded' }, 7429],
    ['d1_overloaded', { message: '[code: 876543210] D1 DB is overloaded [code: 987654321]' }, 7429],
    ['d1_timeout', { message: 'D1_ERROR: query timed out with synthetic payload' }],
    ['d1_timeout', { name: 'D1TimeoutError' }],
    ['d1_timeout', { code: 'D1_TIMEOUT' }],
    ['d1_sql_error', { message: 'D1_ERROR: near synthetic payload: syntax error' }],
    ['d1_sql_error', { message: 'no such table: synthetic_payload', code: 1 }, 1],
    ['d1_sql_error', { name: 'SqliteError', code: 17 }, 17],
    ['d1_sql_error', { name: 'SqliteError', code: 'SQLITE_SCHEMA' }],
    ['d1_bind_limit', { message: 'D1_ERROR: too many SQL variables for synthetic payload' }],
    ['d1_bind_limit', { message: 'variable number must be between ?1 and ?100' }],
    ['vectorize_error', { message: 'VECTORIZE_ERROR: synthetic payload' }],
    ['vectorize_error', { name: 'VectorizeError', code: 123 }],
    ['network', { name: 'TypeError', message: 'fetch failed: synthetic payload' }],
    ['network', { code: 'ECONNRESET', message: 'synthetic payload' }],
    ['network', { name: 'NetworkError' }],
    ['unknown', { name: 'SyntheticPrivateName', message: 'synthetic payload', code: 'private_code' }],
    ['unknown', { message: '[code: 7429]' }],
    ['unknown', { message: 'overloaded [code: 7429]' }],
    ['unknown', { code: 314159265 }],
    ['unknown', { code: '314159265' }],
    ['unknown', { code: '1' }],
    ['unknown', { code: '17' }],
    ['unknown', { code: -1 }],
    ['unknown', { code: 7429.5 }],
    ['unknown', { code: NaN }],
    ['unknown', { code: Infinity }],
    ['unknown', { code: Number.MAX_SAFE_INTEGER }],
    ['unknown', { message: 'x'.repeat(1024) + 'D1_ERROR: syntax error' }],
    ['unknown', { code: { toString() { throw new Error('must not coerce provider objects'); } } }],
  ];
  await keywordFailureProbe(search);
  for (const [category, failure, code] of cases) {
    const [entry] = await keywordFailureProbe(search, { failure: () => failure });
    assert.deepEqual(entry, { event: 'search_stage_failed', stage: 'keyword', error: {
      category, message: messages[category], ...(code === undefined ? {} : { code }),
    } }, `closed warning shape for ${category}`);
  }
});

test('swallowed search failures retain bounded causes without private query or bindings', async () => {
  await searchFailureLogging(search);
});

test('readiness logs distinguish provider, bounded-outbox, state and receipt failures', async () => {
  const cases = [
    { name: 'describe refusal', describeError: 'provider refused readiness', category: 'vectorize_error', reads: [1, 0, 0] },
    { name: 'invalid provider count', description: {}, category: 'vectorize_error', reads: [1, 0, 0] },
    { name: 'bounded outbox refusal', outboxError: 'D1 bounded outbox refused', category: 'unknown', reads: [1, 1, 0] },
    { name: 'install state refusal', stateError: 'D1 install state refused', category: 'unknown', reads: [1, 1, 1] },
    { name: 'schema not active', state: { schema_version: 11 }, category: 'unknown', reads: [1, 1, 1] },
    { name: 'invalid D1 count', state: { expected_vectors: -1 }, category: 'unknown', reads: [1, 1, 1] },
    { name: 'invalid projection status', state: { projection_status: 'invalid' }, category: 'unknown', reads: [1, 1, 1] },
    { name: 'healthy control', reads: [1, 1, 1] },
  ];
  const saved = console.warn;
  try {
    for (const c of cases) {
      const warnings = [], reads = [0, 0, 0];
      console.warn = line => warnings.push(JSON.parse(line));
      const env = {
        VECTORIZE: {
          query: async () => ({ matches: [] }),
          async describe() {
            reads[0]++;
            if (c.describeError) throw new Error(c.describeError);
            return c.description || { vectorCount: 0 };
          },
        },
        DB: { prepare(sql) {
          const statement = {
            bind: () => statement,
            all: async () => ({ results: /sqlite_master/.test(sql)
              ? [{ name: 'custom_api_current_jobs' }, { name: 'custom_api_document_versions' }] : [] }),
            async first() {
              if (/WITH bounded AS MATERIALIZED/.test(sql)) {
                reads[1]++;
                if (c.outboxError) throw new Error(c.outboxError);
                return { n: 0, oldest: null, upserts: 0, deletes: 0, submitted: 0 };
              }
              reads[2]++;
              if (c.stateError) throw new Error(c.stateError);
              return { schema_version: 48, expected_vectors: 0, live_vectors: 0,
                projection_status: 'verified', bootstrap_epoch: 0, ...c.state };
            },
          };
          return statement;
        } },
      };
      const result = await search(env, { query: 'syntheticprobe', embedding: [0.1], now: 0 });
      assert.deepEqual(reads, c.reads, `${c.name}: exact readiness decision reached`);
      if (c.category) {
        assert.equal(result.degraded_reason, 'projection-incomplete', c.name);
        assert.equal(warnings.length, 1, c.name);
        assert.equal(warnings[0].stage, 'projection_readiness', c.name);
        assert.equal(warnings[0].error.category, c.category, c.name);
      } else {
        assert.equal(result.degraded, null, 'valid readiness still succeeds');
        assert.equal(warnings.length, 0, 'healthy control has no warning');
      }
    }
  } finally { console.warn = saved; }
});
