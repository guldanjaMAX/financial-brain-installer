import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTemporalVeto as headTemporal } from '../src/lib/temporal-guard.js';
import { applyMoneyVeto as headMoney } from '../src/lib/money-veto.js';
const guards = { temporal: headTemporal, money: headMoney };
const now = Date.parse('2038-08-17T16:00:00Z');
const record = (n, snippet, ts = '2038-08-15', extra = {}) => ({
  n, snippet, ts, title: 'Synthetic record', date_reliable: true,
  text_reliable: true, ...extra,
});
const input = (question, answer, docs, extra = {}) => ({
  question, answer, docs, evidenceGate: { supported: true, complete: true,
    evidence: docs.map(doc => doc.n) }, now, timeZone: 'UTC', owner: 'Fixture Owner', ...extra,
});
const appointment = (question, day) => input(question,
  `Your next appointment is ${day} [1].`,
  [record(1, `Appointment with Orvex on ${day}.`, day, {
    title: 'Appointment with Orvex', occurred_at: day, date_source: 'calendar:event_start',
  })]);
const status = (stop, restart) => input('What medications am I taking right now?',
  restart ? 'You take Lunavex [1] [3].' : 'You take Lunavex [1].',
  [record(1, 'Owner takes Lunavex for sleep.', '2038-07-03'),
    record(2, stop, '2038-08-02'),
    ...(restart ? [record(3, restart, '2038-08-16')] : [])]);

const cases = [
  {
    id: 'C01a', kind: 'temporal', title: 'next-week wording still guards a dated event',
    green: appointment("What is next week's appointment with Orvex?", '2038-08-23'),
    probe: appointment("What is next week's appointment with Orvex?", '2038-08-16'),
    expected: 'refused',
  },
  {
    id: 'C01b', kind: 'temporal', title: 'procedural clause cannot disable explicit event intent',
    green: appointment('What are the next steps, and when is my next appointment with Orvex?', '2038-08-23'),
    probe: appointment('What are the next steps, and when is my next appointment with Orvex?', '2038-08-16'),
    expected: 'refused',
  },
  {
    id: 'C01c', kind: 'temporal', title: 'who-see-next wording still guards a dated event',
    green: appointment('Who do I see next?', '2038-08-23'),
    probe: appointment('Who do I see next?', '2038-08-16'),
    expected: 'refused',
  },
  {
    id: 'C02', kind: 'temporal', title: 'future restart plan cannot establish current use',
    green: status('Owner stopped Lunavex.', 'Owner is back on Lunavex.'),
    probe: status('Owner stopped Lunavex.', 'Owner will be back on Lunavex next month.'),
    expected: 'refused',
  },
  {
    id: 'C03', kind: 'temporal', title: 'fronted purpose cannot erase an explicit same-item stop',
    green: status('For sleep, owner stopped Doravex.'),
    probe: status('For sleep, owner stopped Lunavex.'),
    expected: 'refused',
  },
  {
    id: 'C04', kind: 'money', title: 'month-list conjunction retains its single account',
    green: input('Which statement months are recorded?',
      'Card ending 6832 statement months: June through August [1].',
      [record(1, 'Card ending 6832 statement months: June, July, August.')]),
    probe: input('Which statement months are recorded?',
      'Card ending 6832 statement months: June through August [1].',
      [record(1, 'Card ending 6832 statement months: June, July and August.')]),
    expected: 'preserved',
  },
  {
    id: 'C05', kind: 'money', title: 'annual plan cannot erase its monthly fee interval',
    green: input('What does the money record say?',
      'Annual plan with monthly fee of USD 480 [1].',
      [record(1, 'Annual plan with monthly fee of USD 480.')]),
    probe: input('What does the money record say?',
      'Annual plan with monthly fee of USD 480 [1].',
      [record(1, 'USD 480 per year fee for annual plan.')]),
    expected: 'refused',
  },
];

let calls = 0;
function invoke(fn, value) {
  assert.ok(value.answer.length, 'nonempty draft');
  assert.equal(value.evidenceGate.supported, true, 'approved upstream draft reaches veto');
  assert.ok(value.docs.length, 'nonempty evidence');
  assert.ok(value.docs.some(doc => value.answer.includes(`[${doc.n}]`) &&
    value.evidenceGate.evidence.includes(doc.n)), 'authorized cited record reaches veto');
  const before = calls;
  calls++;
  const result = fn(structuredClone(value));
  assert.equal(calls, before + 1, 'real exported guard invoked');
  return result;
}
function outcome(result, value, expected) {
  if (expected === 'preserved') {
    assert.deepEqual(result, { answer: value.answer, evidenceGate: value.evidenceGate });
  } else {
    assert.equal(result.answer, null, 'unsafe draft must be refused');
    assert.equal(result.evidenceGate.supported, false);
    assert.equal(result.evidenceGate.complete, false);
    assert.deepEqual(result.evidenceGate.evidence, []);
    assert.ok(result.gap, 'actual refusal diagnostic');
  }
}

for (const row of cases) {
  test(`${row.id}: ${row.title}`, () => {
    const fn = guards[row.kind];
    outcome(invoke(fn, row.green), row.green, 'preserved');
    outcome(invoke(fn, row.probe), row.probe, row.expected);
  });
}

for (const restart of [
  'Owner would be back on Lunavex if symptoms returned.',
  'If cleared, owner is back on Lunavex next month.',
  'Owner may have restarted Lunavex.',
  'Owner plans to have resumed Lunavex next month.',
  'The plan says "Owner is back on Lunavex."',
  'Owner restarted Lunavex only in a hypothetical example.',
  "Owner hasn't restarted Lunavex.",
  "The plan says 'Owner is back on Lunavex.'",
]) test(`C02 boundary: unproven restart cannot clear a stop: ${restart}`, () => {
  const green = status('Owner stopped Lunavex.', 'Owner is back on Lunavex.');
  outcome(invoke(headTemporal, green), green, 'preserved');
  const probe = status('Owner stopped Lunavex.', restart);
  outcome(invoke(headTemporal, probe), probe, 'refused');
});

for (const stop of [
  'Owner, for sleep, stopped Lunavex.',
  'For sleep, Lunavex was discontinued.',
  'For sleep owner stopped Lunavex.',
  'For sleep Lunavex was discontinued.',
  'Owner stopped Lunavex for sleep.',
]) test(`C03 boundary: purpose placement retains the stopped item: ${stop}`, () => {
  const green = status(stop.replace('Lunavex', 'Doravex'));
  outcome(invoke(headTemporal, green), green, 'preserved');
  const probe = status(stop);
  outcome(invoke(headTemporal, probe), probe, 'refused');
});

test('C04 boundary: a month beginning another account clause cannot borrow its predecessor', () => {
  const green = cases.find(row => row.id === 'C04').probe;
  outcome(invoke(headMoney, green), green, 'preserved');
  for (const snippet of [
    'Card ending 6832 statement months: June, July and August for card ending 7954.',
    'Card ending 6832 statement months: June, August and card ending 7954 statement month: July.',
  ]) {
    const probe = { ...green, docs: [record(1, snippet)] };
    outcome(invoke(headMoney, probe), probe, 'refused');
  }
});

test('C05 boundary: the monthly fee binds symmetrically and competing fee units refuse', () => {
  const answer = 'Monthly fee of USD 480 [1].';
  const green = input('What does the money record say?', answer,
    [record(1, 'Annual plan with monthly fee of USD 480.')]);
  outcome(invoke(headMoney, green), green, 'preserved');
  for (const snippet of ['Annual monthly fee of USD 480.', 'Monthly fee of USD 480 per year.']) {
    const probe = { ...green, docs: [record(1, snippet)] };
    outcome(invoke(headMoney, probe), probe, 'refused');
  }
});
