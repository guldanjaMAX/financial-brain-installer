import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptanceFixture, reachedRetrieval } from './gaps-acceptance-fixture.mjs';

// Freeze event truth and quotation offsets before invoking product code.
const truth = Object.freeze({ day: '2034-06-15', cents: 81327, sender: 'Payer One',
  text: 'Payer One wired USD 813.27 on 2034-06-15.' });
const altered = Object.freeze([
  ['amount', truth.text.replace('813.27', '831.27')],
  ['negation', truth.text.replace('wired', 'did not wire')],
  ['date', truth.text.replace('2034-06-15', '2034-06-16')],
  ['payer', truth.text.replace('Payer One', 'Payer Two')],
  ['direction', truth.text.replace('wired', 'was refunded')],
  ['future', truth.text.replace('wired', 'will wire')],
]);
function record(id, text, day, metadata = {}) {
  return { source_type: 'gmail', source_id: id, title: 'Payment record', content: text,
    occurred_at: day, date_reliable: true, date_source: 'email_header',
    text_source: 'native', text_reliable: true,
    metadata: { evidence_lineage: { version: 1, kind: 'source_record' }, ...metadata } };
}
const approve = input => {
  const proposed = /PROPOSED ANSWER:\n([\s\S]*?)\n\nCITED DOCUMENTS:/.exec(input.messages.at(-1).content)?.[1] || '';
  return { supported: true, complete: true, conflicts: [],
    evidence: [...proposed.matchAll(/\[(\d+)\]/g)].map(match => Number(match[1])), reason: 'Adversarial approval replay.' };
};
async function replay(t, { source = truth.text, statement = source, day = truth.day,
  q = 'How much did Payer One pay?', now = Date.parse('2034-07-15T12:00:00Z'),
  quote = true, extra = [] } = {}) {
  const f = await acceptanceFixture(t, { now, verdict: approve, draft(input) {
    const prompt = input.messages.at(-1).content;
    const at = prompt.indexOf(source);
    assert.ok(at >= 0, 'primary source reached draft context');
    const n = [...prompt.slice(0, at).matchAll(/^\[(\d+)\] \(/gm)].at(-1)?.[1];
    assert.ok(n);
    return quote ? `As of ${day}, the record states "${statement}" [${n}]. Current status is unknown.` : `${statement} [${n}].`;
  } });
  f.env.BRAIN_TIMEZONE = 'Pacific/Honolulu';
  await f.ingest([record('event', source, day), ...extra]); await f.drain();
  const result = await f.request('think', q);
  reachedRetrieval(result);
  assert.ok(result.counts.answer >= 1 && result.counts.answer <= 2, 'bounded draft/repair path reached');
  assert.equal(result.counts.verifier, 1, 'affirmative verifier reached');
  assert.ok(result.body.timing.stages.premise_temporal.calls > 0);
  return result;
}
for (const [label, statement] of altered) test(`T4 document ${label}: exact quote survives, changed event fails approving verifier`, async t => {
  const good = await replay(t);
  assert.ok(good.body.answer?.includes(`"${truth.text}"`), 'correct dated quotation is useful');
  assert.ok(good.body.answer.includes(truth.day));
  const snippet = good.body.results.find(row => row.source_id === 'event').snippet;
  const start = snippet.indexOf(truth.text);
  assert.ok(start >= 0);
  assert.equal(snippet.slice(start, start + truth.text.length), truth.text, 'independent exact quote offsets');
  const bad = await replay(t, { statement });
  assert.equal(bad.body.answer, null, 'changed event must not survive an approving verifier');
  assert.equal(bad.body.citations.length, 0);
});

for (const currency of ['USD ', '']) test(`T4 document bare-currency=${!currency}: amount remains exact`, async t => {
  const source = `Payer One wired ${currency}813.27 on 2034-06-15.`;
  const good = await replay(t, { source, quote: false });
  assert.ok(good.body.answer?.includes('813.27'));
  const bad = await replay(t, { source, statement: source.replace('813.27', '831.27'), quote: false });
  assert.equal(bad.body.answer, null);
});

test('T4 a forwarded cancellation does not establish a future completed payment', async t => {
  const source = 'Payer One subscription is cancelled.';
  const extra = [record('forward', `Forwarded message from Payer One dated 2034-06-15: ${source}`, '2034-06-17',
    { evidence_lineage: { version: 1, kind: 'derived_record', root_ids: ['gmail:event'] } })];
  const good = await replay(t, { source, q: 'What subscription payment status did Payer One record?', extra });
  assert.ok(good.body.answer?.includes(`"${source}"`));
  const bad = await replay(t, { source, statement: 'Payer One will pay USD 813.27 on 2034-07-16.',
    q: 'When is my next subscription payment for Payer One?', quote: false, extra });
  assert.ok(bad.body.results.some(row => row.source_id === 'forward'));
  assert.equal(bad.body.answer, null);
});

for (const instant of ['2034-07-01T00:00:01Z', '2034-07-01T09:59:59Z'])
test(`T4 local-day boundary at ${instant}: completed quotation is stable`, async t => {
  const source = 'Payer One wired USD 813.27 on 2034-06-30.';
  const good = await replay(t, { source, day: '2034-06-30', now: Date.parse(instant) });
  assert.ok(good.body.answer?.includes(`"${source}"`));
  const bad = await replay(t, { source, statement: source.replace('2034-06-30', '2034-07-01'),
    day: '2034-06-30', now: Date.parse(instant) });
  assert.equal(bad.body.answer, null);
});
