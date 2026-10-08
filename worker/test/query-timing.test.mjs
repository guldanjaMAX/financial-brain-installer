import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { fixture, ANCHOR } from './query-timing-fixture.mjs';
import { createQueryTiming, measureQueryStage, QUERY_STAGES } from '../src/lib/query-timing.js';
import { embedText } from '../src/lib/supabase.js';

const NativeDate = Date;
const nativeFetch = globalThis.fetch;
let networkCalls = 0;
before(() => {
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [ANCHOR])); }
    static now() { return ANCHOR; }
  };
  globalThis.fetch = async () => { networkCalls++; throw new Error('network forbidden'); };
});
after(() => { globalThis.Date = NativeDate; globalThis.fetch = nativeFetch; assert.equal(networkCalls, 0); });

test('real think route records stages after a supported answer and verifier decision', async () => {
  const f = fixture();
  const { response, body } = await f.request();
  assert.equal(response.status, 200);
  assert.equal(f.counts.answer, 1);
  assert.equal(f.counts.verifier, 1);
  assert.equal(body.evidence_gate.supported, true);
  assert.equal(body.citations.length, 1);
  assert.ok(body.timing, 'admin response carries bounded timing');
  assert.equal(body.timing.total_ms, 13500);
  const { stages, models } = body.timing;
  assert.equal(stages.embedding.ms, 800);
  assert.equal(stages.keyword.ms, 1200);
  assert.equal(stages.vector.ms, 700);
  assert.equal(stages.vector_query.ms, 600);
  assert.equal(stages.retrieval.ms, 2000);
  assert.equal(stages.coverage.ms, 500);
  assert.equal(stages.answer_llm.ms, 7000);
  assert.equal(stages.verifier_llm.ms, 4000);
  assert.equal(stages.evidence_gate.ms, 4000);
  assert.ok(stages.authority_lineage.calls >= 2);
  assert.ok(stages.premise_temporal.calls >= 2);
  assert.equal(models.reduce((n, model) => n + model.calls, 0), 3);
  assert.equal(models.find(model => model.stage === 'answer_llm').id, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  assertCoherent(body.timing);
});

function assertCoherent(timing) {
  assert.match(timing.request_id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.deepEqual(Object.keys(timing.stages), QUERY_STAGES);
  const total = Object.values(timing.stages).reduce((n, stage) => n + stage.ms, 0);
  assert.ok(Math.abs(total - timing.overlap_ms - timing.covered_ms) < 0.025);
  assert.ok(Math.abs(timing.covered_ms + timing.unattributed_ms - timing.total_ms) < 0.025);
  assert.ok(timing.overlap_ms >= 0);
  assert.ok(JSON.stringify(timing).length < 4096);
}

test('unified records the same concurrent retrieval, without answer-model work', async () => {
  const f = fixture();
  const { body } = await f.request('unified');
  assert.equal(body.results.length, 1);
  assert.equal(f.counts.keyword, 1);
  assert.equal(f.counts.vector, 1);
  assert.equal(f.counts.answer, 0);
  assert.equal(body.timing.total_ms, 2500);
  assert.equal(body.timing.stages.answer_llm.calls, 0);
  assert.equal(body.timing.route, 'unified');
  assertCoherent(body.timing);
});

test('refusal and provider errors retain spans after the actual decisions', async () => {
  for (const options of [{ approve: false }, { answerFails: true }, { verifierFails: true }]) {
    const f = fixture(options);
    const { body } = await f.request();
    assert.equal(f.counts.answer, 1);
    assert.equal(f.counts.verifier, options.answerFails ? 0 : 1);
    assert.equal(body.results.length, 1);
    assert.equal(body.citations.length, 0);
    assert.equal(body.answer, null);
    const failed = options.answerFails || options.verifierFails;
    assert.equal(body.timing.outcome, failed ? 'error' : 'refused');
    if (failed) {
      const stage = options.answerFails ? 'answer_llm' : 'verifier_llm';
      assert.equal(body.timing.stages[stage].errors, 1);
      assert.equal(body.timing.models.find(model => model.stage === stage).errors, 1);
    }
    assertCoherent(body.timing);
  }
  const control = fixture();
  assert.equal((await control.request()).body.evidence_gate.supported, true);
  assert.equal(control.counts.verifier, 1);
});

test('empty and degraded retrieval retain honest refusals and attempted modality counts', async () => {
  for (const options of [{ empty: true }, { keywordFails: true, vectorFails: true }]) {
    const f = fixture(options);
    const { body } = await f.request();
    assert.equal(f.counts.keyword, 1);
    assert.equal(f.counts.vector, options.vectorFails ? 2 : 1);
    assert.equal(body.timing.stages.vector_query.calls, f.counts.vector);
    assert.equal(body.timing.stages.keyword.errors, options.keywordFails ? 1 : 0);
    assert.equal(body.timing.stages.vector.errors, options.vectorFails ? 1 : 0);
    assert.equal(body.timing.stages.answer_llm.calls, 0);
    assert.equal(body.timing.outcome, 'refused');
    assert.equal(body.answer, null);
    assertCoherent(body.timing);
  }
  const control = fixture();
  assert.equal((await control.request()).body.citations.length, 1);
});

test('diagnostics are absent for a proxy and unauthorized caller, with admin control', async () => {
  const f = fixture();
  const proxy = await f.request('think', { credential: 'proxy' });
  assert.equal(f.counts.verifier, 1);
  assert.equal(proxy.body.evidence_gate.supported, true);
  assert.equal(Object.hasOwn(proxy.body, 'timing'), false);
  const unauthorized = await f.request('think', { credential: 'none' });
  assert.equal(unauthorized.response.status, 401);
  assert.equal(f.counts.verifier, 1);
  assert.equal(Object.hasOwn(unauthorized.body, 'timing'), false);
  const admin = await f.request();
  assert.equal(f.counts.verifier, 2);
  assert.ok(admin.body.timing);
});

test('early validation errors are timed without inventing retrieval work', async () => {
  const f = fixture();
  const { response, body } = await f.request('think', { body: { q: '' } });
  assert.equal(response.status, 400);
  assert.equal(body.timing.outcome, 'error');
  assert.equal(f.counts.keyword, 0);
  assert.equal(body.timing.stages.retrieval.calls, 0);
  assert.ok((await fixture().request()).body.timing.stages.retrieval.calls > 0);
});

test('actual remote MCP ask uses one backend and keeps diagnostics out of rendered content', async () => {
  for (const approve of [true, false]) {
    const f = fixture({ approve });
    const { response, body } = await f.request('mcp');
    assert.equal(response.status, 200);
    assert.equal(f.counts.auth, 1);
    assert.equal(f.counts.answer, 1);
    assert.equal(f.counts.verifier, 1);
    const timing = body.result._meta.timing;
    assert.equal(timing.route, 'mcp.ask');
    assert.equal(timing.total_ms, 13500);
    assert.equal(timing.stages.mcp_wrapping.calls, 2);
    assert.equal(timing.stages.mcp_wrapping.ms, 0);
    assert.equal(timing.outcome, approve ? 'ok' : 'refused');
    assert.ok(body.result.content[0].text.length > 0);
    assert.equal(body.result.content[0].text.includes(timing.request_id), false);
    assertCoherent(timing);
  }
});

test('MCP librarian still answers but cannot receive aggregate admin diagnostics', async () => {
  const f = fixture({ profile: 'librarian' });
  const { body } = await f.request('mcp');
  assert.equal(f.counts.auth, 1);
  assert.equal(f.counts.verifier, 1);
  assert.ok(body.result.content[0].text.includes('seven units'));
  assert.equal(body.result._meta, undefined);
  assert.ok((await fixture().request('mcp')).body.result._meta.timing);
});

test('remote MCP search and answer errors retain the actual backend spans', async () => {
  const search = fixture();
  const found = await search.request('mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'search', arguments: { query: 'What threshold was recorded?' } } } });
  assert.equal(search.counts.auth, 1);
  assert.equal(search.counts.keyword, 1);
  assert.equal(search.counts.answer, 0);
  assert.equal(found.body.result._meta.timing.route, 'mcp.search');
  assert.equal(found.body.result._meta.timing.total_ms, 2500);
  assert.equal(found.body.result._meta.timing.stages.mcp_wrapping.calls, 2);
  assert.equal(JSON.parse(found.body.result.content[0].text).results.length, 1);
  const failed = fixture({ verifierFails: true });
  const error = await failed.request('mcp');
  assert.equal(failed.counts.verifier, 1);
  assert.equal(error.body.result.isError, true);
  assert.equal(error.body.result._meta.timing.outcome, 'error');
  assert.equal(error.body.result._meta.timing.stages.verifier_llm.errors, 1);
  assert.equal(error.body.result._meta.timing.stages.evidence_gate.errors, 1);
  assertCoherent(error.body.result._meta.timing);
});

test('MCP protocol setup retains its existing envelope, with a timed query control', async () => {
  const f = fixture();
  const initialized = await f.request('mcp', { body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } });
  assert.equal(f.counts.auth, 1);
  assert.ok(initialized.body.result.serverInfo);
  assert.equal(initialized.body.result._meta, undefined);
  assert.equal(f.counts.answer, 0);
  const query = await f.request('mcp');
  assert.equal(f.counts.auth, 2);
  assert.equal(f.counts.answer, 1);
  assert.equal(query.body.result._meta.timing.route, 'mcp.ask');
});

test('clock rollback and invalid clock samples cannot produce negative durations', () => {
  let ms = 100;
  const timing = createQueryTiming({ route: 'think', now: () => ms });
  const end = timing.start('keyword');
  ms = 90; timing.start('vector')();
  ms = NaN; timing.start('coverage')();
  ms = 110; end();
  const receipt = timing.finish();
  assert.equal(receipt.total_ms, 10);
  assert.equal(receipt.stages.keyword.ms, 10);
  assert.equal(receipt.stages.vector.ms, 0);
  assertCoherent(receipt);
});

test('embedding retry counts both actual provider calls and includes the backoff', async () => {
  let ms = 0, calls = 0;
  const timing = createQueryTiming({ route: 'think', now: () => ms });
  const originalTimer = globalThis.setTimeout;
  globalThis.setTimeout = (fn, delay) => { ms += delay; queueMicrotask(fn); return 1; };
  try {
    const env = { AI: { run: async () => {
      calls++; ms += 10;
      if (calls === 1) throw new Error('synthetic retry');
      return { data: [[0.1]] };
    } } };
    assert.deepEqual(await embedText(env, 'synthetic threshold', timing), [0.1]);
    const receipt = timing.finish();
    assert.equal(calls, 2);
    assert.equal(receipt.stages.embedding.calls, 1);
    assert.equal(receipt.stages.embedding.ms, 320);
    assert.equal(receipt.models[0].calls, 2);
    assert.equal(receipt.models[0].errors, 1);
    assert.equal(receipt.models[0].ms, 20);
    assertCoherent(receipt);
    // A fresh call with the same provider is a successful no-retry control.
    const control = createQueryTiming({ route: 'think', now: () => ms });
    assert.deepEqual(await embedText(env, 'synthetic threshold', control), [0.1]);
    assert.equal(control.finish().models[0].calls, 1);
    assert.equal(control.finish().models[0].errors, 0);
  } finally { globalThis.setTimeout = originalTimer; }
});

test('request-local aggregates account for parallel and nested spans, with no wall-clock dependency', async () => {
  let now = 0;
  const timing = createQueryTiming({ route: 'think', now: () => now });
  const outer = timing.start('retrieval');
  const keyword = timing.start('keyword');
  now = 2;
  const vector = timing.start('vector');
  now = 5; keyword();
  now = 8; vector(); outer();
  now = 11;
  const receipt = timing.finish();
  assert.equal(receipt.covered_ms, 8);
  assert.equal(receipt.overlap_ms, 11);
  assert.equal(receipt.unattributed_ms, 3);
  assertCoherent(receipt);
  assert.notEqual(createQueryTiming().finish().request_id, receipt.request_id);
  const frozen = JSON.stringify(receipt);
  now = 90; vector(true); timing.start('coverage')();
  assert.equal(JSON.stringify(timing.finish()), frozen);
});

test('untrusted labels, identifiers and error text cannot enter timing', async () => {
  const f = fixture({ answerFails: true });
  const { body } = await f.request('think', {
    body: { q: 'synthetic-private-query-marker' }, requestHeaders: { 'X-Request-ID': 'untrusted-request' },
  });
  assert.equal(f.counts.answer, 1);
  assert.equal(body.timing.stages.answer_llm.errors, 1);
  const serialized = JSON.stringify(body.timing);
  for (const forbidden of [f.env.ADMIN_KEY, f.env.RAG_PROXY_KEY, 'synthetic-private-query-marker',
    'untrusted-request', 'synthetic provider failure', 'Recorded threshold', 'curated:fixture']) {
    assert.equal(serialized.includes(forbidden), false);
  }
  const timing = createQueryTiming({ route: 'think', now: () => 10 });
  timing.start('synthetic-private-query-marker')();
  timing.start('__proto__')();
  assert.equal(Object.hasOwn(Object.prototype, 'calls'), false);
  timing.model('answer_llm', 'anthropic', 'untrusted-model')();
  assert.equal(timing.finish().models[0].id, 'unrecognized');
  assert.equal(JSON.stringify(timing.finish()).includes('untrusted-model'), false);
  assertCoherent(timing.finish());
});

test('thrown and rejected operations count errors and preserve the original failure', async () => {
  const timing = createQueryTiming({ route: 'think', now: () => 0 });
  const failure = new Error('synthetic failure');
  assert.throws(() => measureQueryStage(timing, 'keyword', () => { throw failure; }), error => error === failure);
  await assert.rejects(measureQueryStage(timing, 'vector', async () => { throw failure; }), error => error === failure);
  assert.equal(measureQueryStage(timing, 'keyword', () => 7), 7);
  const receipt = timing.finish();
  assert.equal(receipt.stages.keyword.calls, 2);
  assert.equal(receipt.stages.keyword.errors, 1);
  assert.equal(receipt.stages.vector.calls, 1);
  assert.equal(receipt.stages.vector.errors, 1);
});
