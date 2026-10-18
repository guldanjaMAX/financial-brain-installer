import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptanceFixture, addressWorld, assertAddress, reachedRetrieval } from './gaps-acceptance-fixture.mjs';
import { search, vectorReadiness } from '../src/lib/store-d1.js';
import { createQueryTiming } from '../src/lib/query-timing.js';
import { createMcpQueryTiming } from '../../components/brain-mcp-timing.mjs';

// Proposed local regression targets, not production SLAs. Keep budget scoring
// independent of timing coherence and of the answer's correctness oracle.
const budgets = Object.freeze({ think: 10000, unified: 3000, retrieval: 3000, answer_llm: 5500, verifier_llm: 1500 });
function budgetFailures(result, route) {
  const failed = [];
  if (result.elapsed > budgets[route]) failed.push(route);
  for (const stage of ['retrieval', 'answer_llm', 'verifier_llm'])
    if (result.body.timing.stages[stage].ms > budgets[stage]) failed.push(stage);
  return failed;
}
function budget(result, route) { assert.deepEqual(budgetFailures(result, route), [], 'proposed latency budget exceeded'); }
const measured = { embedding: 100, keyword: 5700, vector: 5900, readiness: 5600, answer: 12200, verifier: 1800 };
function scopedModel(gold) {
  return {
    draft(input) {
      const prompt = input.messages.at(-1).content;
      const at = prompt.indexOf(gold.value);
      assert.ok(at > 0, 'draft sees stored address evidence');
      const n = [...prompt.slice(0, at).matchAll(/^\[(\d+)\] \(/gm)].at(-1)?.[1];
      assert.ok(n, 'citation numbering comes from actual retrieval');
      return `As of ${gold.day}, the owner email reports ${gold.value}. [${n}]`;
    },
    verdict(input) {
      const answer = /PROPOSED ANSWER:\n([\s\S]*?)\n\nCITED DOCUMENTS:/.exec(input.messages.at(-1).content)?.[1];
      const evidence = [...(answer || '').matchAll(/\[(\d+)\]/g)].map(m => Number(m[1]));
      return { supported: true, complete: true, evidence, reason: 'Scoped dated-report replay.' };
    },
  };
}

test('T5 fast healthy Ask is useful inside budget; search returns gold without answer calls', async t => {
  const gold = addressWorld();
  const f = await acceptanceFixture(t, { delays: { embedding: 50, keyword: 200, vector: 300, readiness: 100 } });
  await f.ingest(gold.docs); await f.drain();
  const answer = await f.request();
  assertAddress(answer, gold); budget(answer, 'think');
  assert.equal(answer.elapsed, 350);
  assert.equal(answer.counts.answer + answer.counts.verifier, 0);
  const result = await f.request('unified');
  budget(result, 'unified');
  assert.equal(result.elapsed, 350);
  assert.ok(result.body.results.some(row => row.source_id === 'change-request'));
  assert.equal(result.counts.keyword, 1); assert.equal(result.counts.vector, 1);
  assert.equal(result.counts.answer + result.counts.verifier, 0);
});

test('T5 measured 6 / 12.2 / 1.8 second replay fails budgets despite coherent spans and a correct answer', async t => {
  const gold = addressWorld();
  const f = await acceptanceFixture(t, { delays: measured, ...scopedModel(gold) });
  await f.ingest(gold.docs); await f.drain();
  // This natural history wording intentionally exercises both inference stages.
  const result = await f.request('think', 'What address was recorded?');
  assertAddress(result, gold);
  assert.equal(result.counts.answer, 1); assert.equal(result.counts.verifier, 1);
  assert.equal(result.counts.readiness, 1);
  assert.equal(result.body.timing.stages.retrieval.ms, 6000);
  assert.equal(result.body.timing.stages.answer_llm.ms, 12200);
  assert.equal(result.body.timing.stages.verifier_llm.ms, 1800);
  assert.equal(result.elapsed, 20000);
  assert.equal(result.body.timing.total_ms, result.elapsed);
  assert.deepEqual(budgetFailures(result, 'think'), ['think', 'retrieval', 'answer_llm', 'verifier_llm']);
  assert.throws(() => budget(result, 'think'), /proposed latency budget exceeded/);
  const searchResult = await f.request('unified');
  assert.ok(searchResult.body.results.some(row => row.source_id === 'change-request'));
  assert.equal(searchResult.counts.answer + searchResult.counts.verifier, 0);
  assert.equal(searchResult.elapsed, 6000);
  assert.throws(() => budget(searchResult, 'unified'), /proposed latency budget exceeded/);
  t.diagnostic(JSON.stringify({ correctness: 'pass', budget: 'fail', ask_ms: result.elapsed, search_ms: searchResult.elapsed }));
});

test('T5 parallel keyword, vector and readiness spans follow longest dependency rather than sum', async t => {
  const f = await acceptanceFixture(t, { delays: measured });
  await f.ingest(addressWorld().docs); await f.drain();
  const result = await f.request('unified');
  const stages = result.body.timing.stages;
  for (const stage of ['keyword', 'vector', 'projection_readiness']) assert.equal(stages[stage].calls, 1);
  assert.equal(stages.keyword.ms, 5700); assert.equal(stages.vector.ms, 5900);
  assert.equal(stages.projection_readiness.ms, 5600);
  assert.equal(result.elapsed, 100 + Math.max(5700, 5900, 5600));
  assert.ok(stages.keyword.ms + stages.vector.ms + stages.projection_readiness.ms > 2 * result.elapsed);
  const events = f.clock.events.filter(event => ['keyword', 'vector', 'readiness'].includes(event.stage));
  assert.equal(new Set(events.map(event => event.start)).size, 1, 'independent promises start together');
  assert.equal(result.counts.answer + result.counts.verifier, 0);
  assert.ok(result.body.results.length > 0);
});

test('T5 generation-bound readiness is reused, invalidated by real ingest, and never reused while pending', async t => {
  const f = await acceptanceFixture(t, { delays: { readiness: 5600 } });
  const gold = addressWorld();
  await f.ingest(gold.docs); await f.drain();
  const cold = await f.request(); assertAddress(cold, gold);
  assert.equal(cold.counts.readiness, 1);
  const warm = await f.request(); assertAddress(warm, gold);
  assert.equal(warm.counts.readiness, 0, 'ready index avoids repeated provider proof');
  assert.equal(warm.counts.marker, 1, 'generation fence still read');
  const generation = f.first('SELECT outbox_generation n FROM install_state').n;
  await f.ingest([{ ...gold.docs[3], source_id: 'new-generation' }]);
  assert.ok(f.first('SELECT outbox_generation n FROM install_state').n > generation);
  for (let attempt = 0; attempt < 2; attempt++) {
    const pending = await f.request('unified');
    assert.equal(pending.counts.readiness, 1, 'pending proof never cached');
    assert.equal(pending.body.degraded_reason, 'projection-incomplete');
    assert.ok(pending.counts.keyword > 0 && pending.counts.vector > 0);
    assert.ok(pending.body.results.length > 0, 'unavailable coverage is not absence');
  }
  await f.drain();
  const changed = await f.request(); assertAddress(changed, gold);
  assert.equal(changed.counts.readiness, 1, 'changed generation requires fresh proof');
  const reused = await f.request(); assertAddress(reused, gold);
  assert.equal(reused.counts.readiness, 0);
});

test('T5 a supplied request-local readiness proof is not recomputed downstream', async t => {
  const f = await acceptanceFixture(t);
  await f.ingest(addressWorld().docs); await f.drain();
  const proof = await vectorReadiness(f.env);
  assert.equal(proof.ready, true);
  const before = f.counts.readiness;
  const timing = createQueryTiming({ route: 'think', now: f.clock.now });
  const result = await search(f.env, { query: 'address', embedding: [0.1], projectionReadiness: proof, timing });
  assert.ok(result.results.length > 0);
  assert.equal(f.counts.readiness, before);
  assert.equal(timing.finish().stages.projection_readiness.calls, 0);
  assert.ok(f.counts.keyword > 0 && f.counts.vector > 0);
});

test('T5 65-second provider delay is measured outside Worker timing; errors retain unavailable meaning', async t => {
  const gold = addressWorld();
  const f = await acceptanceFixture(t, { delays: { vector: 65000 } });
  await f.ingest(gold.docs); await f.drain();
  const wrapper = createMcpQueryTiming({ route: 'mcp.brain_search', now: f.clock.now });
  const start = f.clock.ms;
  let result;
  await wrapper.backend(async () => { result = await f.request('unified'); return result.body; });
  assert.equal(result.counts.vector, 1, 'slow provider reached');
  assert.ok(result.body.results.some(row => row.source_id === 'change-request'));
  assert.equal(f.clock.ms - start, 65000);
  assert.equal(wrapper.finish().total_ms, 65000);
  assert.throws(() => budget(result, 'unified'), /proposed latency budget exceeded/);
  f.control.vectorFails = true;
  f.dbControl.failOn = /chunks_fts MATCH/;
  const failed = await f.request();
  assert.equal(failed.counts.vector, 1, 'unfiltered error has exactly one attempt');
  assert.equal(failed.counts.keyword, 1);
  assert.equal(failed.body.answer, null);
  assert.ok(failed.body.degraded || failed.body.status === 'search_unavailable');
  assert.doesNotMatch(failed.body.notice || '', /no records|nothing recorded/i);
  assert.equal(failed.body.timing.stages.vector_query.errors, 1);
});

for (const stage of ['answer', 'verifier']) test(`T5 ${stage} error reaches the model and cannot become absence`, async t => {
  const gold = addressWorld(1701, 'recent');
  const f = await acceptanceFixture(t, { ...scopedModel(gold), delays: { answer: 200, verifier: 100 } });
  await f.ingest(gold.docs); await f.drain();
  const good = await f.request('think', 'What address was recorded?');
  assertAddress(good, gold); budget(good, 'think');
  f.control[`${stage}Fails`] = true;
  const bad = await f.request('think', 'What address was recorded?');
  assert.equal(bad.response.status, 200);
  assert.ok(bad.counts.keyword > 0 && bad.counts.vector > 0);
  if (stage === 'verifier') reachedRetrieval(bad);
  else assert.ok(bad.body.answer_error, 'failed generation reaches the explicit answer-error decision');
  assert.equal(bad.counts.answer, 1);
  assert.equal(bad.counts.verifier, stage === 'answer' ? 0 : 1);
  assert.equal(bad.body.answer, null);
  assert.equal(bad.body.timing.stages[`${stage}_llm`].errors, 1);
  assert.equal(bad.body.timing.outcome, 'error');
  assert.ok(bad.body.results.length > 0, 'failure retains candidates instead of claiming absence');
});
