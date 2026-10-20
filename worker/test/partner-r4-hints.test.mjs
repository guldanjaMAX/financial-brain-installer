import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceFixture } from './gaps-acceptance-fixture.mjs';

const now = Date.parse('2034-07-15T12:00:00Z');
const verdict = input => {
  const answer = /PROPOSED ANSWER:\n([\s\S]*?)\n\nCITED DOCUMENTS:/.exec(input.messages.at(-1).content)?.[1] || '';
  return { supported: true, complete: true, conflicts: [],
    evidence: [...answer.matchAll(/\[(\d+)\]/g)].map(match => Number(match[1])), reason: 'Synthetic approval.' };
};
const faults = [
  [/chunks_fts MATCH[\s\S]*c\.(?:category|platform)\s*=/, 'fts', 'keyword_unavailable'],
  [/c\.chunk_uid IN \([\s\S]*c\.(?:category|platform)\s*=/, 'vector', 'vector_unavailable'],
  [/(?:chunks_fts MATCH|c\.chunk_uid IN \()[\s\S]*c\.(?:category|platform)\s*=/, 'retrieval', null],
];
for (const topic of ['meeting notes', 'calendar entries', 'text messages']) for (const [pattern, degraded, gap] of faults) for (const draft of [
  'No deposits from Fixture Payer are recorded [1].', 'Fixture Payer discussed the deposit schedule [1].',
]) {
  test(`R4 ${topic} ${degraded} hint fault drops completeness and keeps ${draft.startsWith('No') ? 'approved absence text' : 'supported facts'}; healthy retrieval is unchanged`, async t => {
    const f = await acceptanceFixture(t, { now, verdict, draft: () => draft });
    await f.ingest([{ source_type: 'gmail', source_id: 'record', title: 'Schedule record',
      content: 'Fixture Payer meeting calendar text messages discuss the deposit schedule.',
      occurred_at: '2034-06-15', date_reliable: true, date_source: 'email_header', text_source: 'native', text_reliable: true,
      metadata: { evidence_lineage: { version: 1, kind: 'source_record' } } }]);
    await f.drain();
    const question = `What did the ${topic} say about deposits from Fixture Payer?`;
    const healthy = (await f.request('think', question)).body;
    assert.equal(healthy.degraded ?? null, null);
    assert.equal(healthy.evidence_gate.complete, true, 'healthy evidence decision reached');
    let hits = 0;
    f.dbControl.failOn = { lastIndex: 0, test: sql => { if (!pattern.test(sql)) return false; hits++; return true; } };
    const body = (await f.request('think', question)).body;
    f.dbControl.failOn = null;
    assert.equal(hits, degraded === 'retrieval' ? 2 : 1, 'exact hint decisions failed');
    assert.equal(body.degraded, degraded);
    if (gap) assert.ok(body.gaps.some(item => item.type === gap));
    assert.notEqual(body.evidence_gate?.complete, true);
    assert.equal(body.evidence_gate.supported, true, 'surviving evidence stays supported');
    assert.equal(body.evidence_gate.partial, true);
    assert.equal(body.evidence_gate.reason, 'retrieval incomplete');
    assert.equal(body.answer, healthy.answer, 'supported answer is preserved');
    assert.deepEqual(body.citations, healthy.citations, 'supported citations are preserved');
    // Combined failures have a dedicated marker, not the single-arm gap types.
    if (degraded === 'retrieval') assert.equal(body.degraded_reason, 'keyword-and-vector-query-failed');
    const recovered = (await f.request('think', question)).body;
    assert.equal(recovered.degraded ?? null, null);
    assert.equal(recovered.evidence_gate.complete, healthy.evidence_gate.complete);
    assert.equal(recovered.answer, healthy.answer);
  });
}

test('R4B degraded retrieval preserves the specific reason for an already rejected draft', async t => {
  const f = await acceptanceFixture(t, { now,
    verdict: { supported: true, complete: true, evidence: [1], reason: 'Only the first citation is supported.' },
    draft: 'Fixture Payer discussed the schedule [1]. Another claim cites a second record [2].' });
  await f.ingest([1, 2].map(i => ({ source_type: 'gmail', source_id: `record-${i}`, title: `Schedule record ${i}`,
    content: `Fixture Payer meeting notes discuss the deposit schedule, record ${i}.`,
    occurred_at: '2034-06-15', date_reliable: true, date_source: 'email_header', text_source: 'native', text_reliable: true,
    metadata: { evidence_lineage: { version: 1, kind: 'source_record' } } })));
  await f.drain();
  const question = 'What did the meeting notes say about deposits from Fixture Payer?';
  const healthy = await f.request('think', question);
  assert.equal(healthy.counts.verifier, 1, 'real verifier decision reached');
  assert.equal(healthy.body.results.length, 2);
  assert.equal(healthy.body.degraded ?? null, null);
  assert.equal(healthy.body.evidence_gate.supported, false);
  assert.equal(healthy.body.evidence_gate.complete, true, 'later completeness guard is exercised');
  assert.match(healthy.body.evidence_gate.reason, /every citation/);
  let hits = 0;
  f.dbControl.failOn = { lastIndex: 0, test: sql => { if (!faults[0][0].test(sql)) return false; hits++; return true; } };
  const degraded = await f.request('think', question);
  assert.equal(hits, 1, 'the keyword hint fault reached the retrieval decision');
  assert.equal(degraded.body.degraded, 'fts');
  assert.equal(degraded.body.evidence_gate.complete, false);
  assert.equal(degraded.body.evidence_gate.supported, false);
  assert.equal(degraded.body.evidence_gate.reason, healthy.body.evidence_gate.reason);
  assert.equal(degraded.body.evidence_gate.partial, healthy.body.evidence_gate.partial);
  assert.equal(degraded.body.answer, null);
});
