import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptanceFixture, addressWorld, assertAddress, reachedRetrieval, WRONG_SCOPE } from './gaps-acceptance-fixture.mjs';

for (const arm of ['recent', 'request', 'correction']) {
  for (const scope of ['wrong-system', 'scoped']) test(`T1 ${arm}: ${scope} verification replay`, async t => {
    const gold = addressWorld(1701, arm);
    const f = await acceptanceFixture(t, { verdict: scope === 'wrong-system' ? WRONG_SCOPE
      : { supported: true, complete: true, evidence: [1], reason: 'The dated email reports an address.' } });
    await f.ingest(gold.docs);
    await f.drain();
    const result = await f.request();
    assertAddress(result, gold);
    assert.equal(result.counts.answer + result.counts.verifier, 0, 'bounded fact does not override a model rejection');
    const span = result.body.evidence_gate.fact_span;
    assert.equal(result.body.results[span.n - 1].snippet.slice(span.start, span.end), gold.expected);
    if (arm === 'request') {
      assert.ok(result.body.results.some(row => row.source_id === 'change-request'));
      assert.ok(result.body.results.some(row => row.source_id === 'postal-confirmation'));
      assert.ok(result.body.citations.some(row => row.ref === 'postal-confirmation'));
      assert.match(result.body.answer, /does not establish.*(?:system|completion)/i);
      assert.ok(!gold.docs.filter(row => row.source_id !== 'change-request').some(row => row.content.includes(gold.value)),
        'gold address exists only in the owner message');
    }
    t.diagnostic(JSON.stringify({ arm, ...result.counts, result: 'dated_answer' }));
  });
}

for (const arm of ['other', 'hypothetical']) test(`T1 ${arm}: retrieved evidence declines owner assignment with green control`, async t => {
  const gold = addressWorld(1701, arm);
  const f = await acceptanceFixture(t);
  await f.ingest(gold.docs); await f.drain();
  const result = await f.request();
  reachedRetrieval(result);
  assert.equal(result.counts.answer, 1);
  assert.equal(result.counts.verifier, 1, 'subject/temporal refusal reached ordinary verification');
  assert.equal(result.body.answer, null);
  assert.equal(result.body.citations.length, 0);
  const control = addressWorld(1701, 'recent');
  await f.ingest(control.docs); await f.drain();
  assertAddress(await f.request(), control);
});

test('T1 scoped and wrong-system transcripts both reach the verifier on ordinary history wording', async t => {
  const gold = addressWorld(1701, 'recent');
  for (const reject of [false, true]) {
    const f = await acceptanceFixture(t, {
      draft: `As of ${gold.day}, the owner email reports ${gold.value}. [1]`,
      verdict: reject ? WRONG_SCOPE : { supported: true, complete: true, evidence: [1], conflicts: [], reason: 'Dated owner report only.' },
    });
    await f.ingest(gold.docs); await f.drain();
    const result = await f.request('think', 'What address was recorded?');
    reachedRetrieval(result);
    assert.equal(result.counts.answer, 1); assert.equal(result.counts.verifier, 1);
    if (reject) assert.equal(result.body.answer, null, 'real rejection is never overridden');
    else assertAddress(result, gold);
  }
});

for (const change of ['sender-only', 'wrong-effective-day', 'unreliable-confirmation', 'same-day-conflict'])
test(`T1 ${change}: ambiguous email corpus falls back with direct green control`, async t => {
  const gold = addressWorld();
  const f = await acceptanceFixture(t);
  const control = addressWorld(1701, 'recent');
  await f.ingest(control.docs); await f.drain();
  assertAddress(await f.request(), control);
  const other = await acceptanceFixture(t);
  if (change === 'sender-only') gold.docs[1].content = gold.docs[1].content.replace('From: Record Owner', 'From: Other Sender');
  if (change === 'wrong-effective-day') gold.docs[2].content = gold.docs[2].content.replace('effective 2034-03-04', 'effective 2034-03-03');
  if (change === 'unreliable-confirmation') gold.docs[2].date_reliable = false;
  if (change === 'same-day-conflict') gold.docs.push({ ...gold.docs[1], source_id: 'conflict', content: gold.docs[1].content.replace(gold.value, gold.previous) });
  await other.ingest(gold.docs); await other.drain();
  const result = await other.request();
  reachedRetrieval(result);
  assert.equal(result.counts.answer, 1); assert.equal(result.counts.verifier, 1);
  assert.equal(result.body.answer, null);
});
