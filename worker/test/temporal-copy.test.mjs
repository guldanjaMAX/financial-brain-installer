import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTemporalVeto } from '../src/lib/temporal-guard.js';

const input = () => ({
  question: 'When is my next appointment with the store owner?',
  answer: 'Your next appointment with the store owner is April 12, 2031 [1].',
  now: Date.parse('2031-04-07T12:00:00Z'), timeZone: 'UTC',
  evidenceGate: { supported: true, complete: true, evidence: [1] },
  docs: [{ n: 1, ts: '2031-04-12', date_reliable: true, text_reliable: true,
    title: 'Store owner appointment', snippet: 'Store owner appointment on April 12, 2031.' }],
});

for (const [kind, mutate, expected] of [
  ['missing records', value => { value.docs = []; },
    'I can help check the event, but its subject is unclear, so the next occurrence is unconfirmed. Want to narrow down which event?'],
  ['unsupported past date', value => { value.answer = value.answer.replace('April 12', 'April 1'); },
    'I can check later dates, but this answer treats a past appointment or event as upcoming. Want to look for a later dated event?'],
]) test(`temporal copy does not claim a source discovery: ${kind}`, () => {
  const peer = input();
  assert.deepEqual(applyTemporalVeto(peer), { answer: peer.answer, evidenceGate: peer.evidenceGate });
  assert.equal(peer.docs.length, 1, 'nonempty dated source passes the same decision');
  const value = input(); mutate(value);
  const result = applyTemporalVeto(value);
  assert.equal(result.answer, null, 'the temporal veto was reached');
  assert.equal(result.gap.type, 'temporal_conflict');
  assert.equal(result.evidenceGate.supported, false);
  assert.equal(result.evidenceGate.complete, false);
  assert.deepEqual(result.evidenceGate.evidence, []);
  assert.equal(result.gap.detail, expected);
});
