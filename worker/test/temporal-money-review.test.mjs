import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTemporalVeto } from '../src/lib/temporal-guard.js';
import { applyMoneyVeto } from '../src/lib/money-veto.js';

const NOW = Date.parse('2036-05-20T15:00:00Z');
const gate = ids => ({ supported: true, complete: true, evidence: ids });
const record = (n, snippet, ts = '2036-05-18', extra = {}) => ({
  n, snippet, ts, title: 'Synthetic record', date_reliable: true,
  text_reliable: true, ...extra,
});
const event = (n, when, extra = {}) => record(n,
  `Appointment with Velora on ${when}.`, when.slice(0, 10), {
    title: 'Appointment with Velora', date_source: 'calendar:event_start',
    occurred_at: when, ...extra,
  });
const temporal = (answer, docs, extra = {}) => ({
  question: 'When is my next appointment with Velora?', answer, docs,
  evidenceGate: gate(docs.map(doc => doc.n)), now: NOW, timeZone: 'UTC',
  owner: 'Fixture Owner', ...extra,
});
const money = (answer, snippet, extra = {}) => ({
  question: 'What does the money record say?', answer,
  docs: [record(1, snippet)], evidenceGate: gate([1]), now: NOW, ...extra,
});
let calls = 0;
function run(fn, input) {
  assert.ok(input.answer, 'nonempty draft reaches the real guard');
  assert.equal(input.evidenceGate.supported, true, 'upstream approval reaches decision');
  assert.ok(input.docs.length > 0, 'nonempty evidence reaches decision');
  assert.ok(input.docs.some(doc => input.answer.includes(`[${doc.n}]`) &&
    input.evidenceGate.evidence.includes(doc.n)), 'a permitted citation reaches decision');
  calls++;
  return fn(input);
}
function preserved(fn, input) {
  const before = calls;
  const result = run(fn, input);
  assert.equal(calls, before + 1);
  assert.equal(result.answer, input.answer, result.evidenceGate.reason);
  assert.strictEqual(result.evidenceGate, input.evidenceGate);
  assert.equal(result.gap, undefined);
}
function refused(fn, input, rule) {
  const before = calls;
  const result = run(fn, input);
  assert.equal(calls, before + 1);
  assert.equal(result.answer, null, 'unsafe draft must be refused');
  assert.equal(result.evidenceGate.supported, false);
  assert.equal(result.evidenceGate.complete, false);
  assert.deepEqual(result.evidenceGate.evidence, []);
  if (rule) assert.equal(result.gap.rule, rule);
  else assert.equal(result.gap.type, 'temporal_conflict');
}

test('T01: procedural next steps must not require an upcoming occurrence', () => {
  const docs = [record(1, 'Schedule a review meeting.')];
  preserved(applyTemporalVeto, temporal('Schedule a review meeting [1].', docs,
    { question: 'What are the steps for the rollout?' }));
  preserved(applyTemporalVeto, temporal('Schedule a review meeting [1].', docs,
    { question: 'What are the next steps for the rollout?' }));
});

test('T02a: an elapsed timed event today must not remain upcoming', () => {
  preserved(applyTemporalVeto, temporal('Your next appointment is 2036-05-20 at 6 pm [1].',
    [event(1, '2036-05-20T18:00:00Z')]));
  refused(applyTemporalVeto, temporal('Your next appointment is 2036-05-20 at 9 am [1].',
    [event(1, '2036-05-20T09:00:00Z')]));
});

test('T02b: an elapsed event today must not veto the real next event', () => {
  const answer = 'Your next appointment is 2036-05-20 at 6 pm [2].';
  const later = event(2, '2036-05-20T18:00:00Z');
  preserved(applyTemporalVeto, temporal(answer, [later]));
  preserved(applyTemporalVeto, temporal(answer, [event(1, '2036-05-20T09:00:00Z'), later]));
});

test('T03: the latest restart supersedes the intermediate stop', () => {
  const docs = [record(1, 'Owner takes Velunex.', '2036-04-01'),
    record(2, 'Owner stopped Velunex.', '2036-05-01'),
    record(3, 'Owner restarted Velunex and takes it now.', '2036-05-19')];
  const extra = { question: 'What medications am I taking right now?' };
  preserved(applyTemporalVeto, temporal('You take Velunex [3].', docs, extra));
  preserved(applyTemporalVeto, temporal('You take Velunex [1] [3].', docs, extra));
});

test('T04: stopping another item for the same purpose must not veto current use', () => {
  const docs = [record(1, 'Owner takes Velunex for sleep.', '2036-04-01'),
    record(2, 'Owner stopped Dorunex for sleep.', '2036-05-19')];
  const extra = { question: 'What medications am I taking right now?' };
  preserved(applyTemporalVeto, temporal('You take Velunex [1].', docs, extra));
  preserved(applyTemporalVeto, temporal('You take Velunex for sleep [1].', docs, extra));
});

test('T05: an unnamed earlier appointment must not be skipped', () => {
  const make = (n, day) => event(n, day, { title: 'Appointment', snippet: `Appointment on ${day}.` });
  const docs = [make(1, '2036-05-22'), make(2, '2036-05-29')];
  const extra = { question: 'When is my next appointment?' };
  preserved(applyTemporalVeto, temporal('Your next appointment is 2036-05-22 [1].', docs, extra));
  refused(applyTemporalVeto, temporal('Your next appointment is 2036-05-29 [2].', docs, extra));
});

test('T05b: a lowercase provider after see must retain earliest-event checking', () => {
  const make = (n, day) => event(n, day, {
    title: 'velora appointment', snippet: `appointment: velora on ${day}.`,
  });
  const docs = [make(1, '2036-05-22'), make(2, '2036-05-29')];
  const soon = 'your next appointment is 2036-05-22 [1].';
  const later = 'your next appointment is 2036-05-29 [2].';
  const extra = { question: 'when do i see velora next?' };
  preserved(applyTemporalVeto, temporal(soon, docs, extra));
  refused(applyTemporalVeto, temporal(later, docs,
    { question: 'when is my next appointment with velora?' }));
  refused(applyTemporalVeto, temporal(later, docs, extra));
});

test('M01: a different financial claim cannot lend its date to an undated charge', () => {
  const answer = 'Card ending 2468 charged USD 137 [1].';
  const extra = snippet => ({ question: 'What charges were recorded in May 2036?',
    docs: [record(1, snippet, '', { date_reliable: false })] });
  const dated = 'Card ending 2468 charged USD 137 on 2036-05-18.';
  preserved(applyMoneyVeto, money(answer, dated, extra(dated)));
  const crossed = 'Card ending 2468 charged USD 137. Card ending 2468 refunded USD 137 on 2036-05-18.';
  refused(applyMoneyVeto, money(answer, crossed, extra(crossed)), 'unreliable_date');
});

test('M02: a longer bullet mask must not collapse to a shorter mask', () => {
  const answer = 'Card ending 2468 charged USD 137 [1].';
  preserved(applyMoneyVeto, money(answer, 'Card \u20222468 charged USD 137.'));
  refused(applyMoneyVeto, money(answer, 'Card \u2022\u20222468 charged USD 137.'), 'span_mismatch');
});

test('M03: month coverage must belong to the claimed account', () => {
  const answer = 'Card ending 2468 statement months: March through May [1].';
  preserved(applyMoneyVeto, money(answer, 'Card ending 2468 statement months: March, April, May.'));
  refused(applyMoneyVeto, money(answer,
    'Card ending 2468 statement months: March, May. Card ending 5791 statement months: April.'), 'span_mismatch');
});

test('M04: an annual fee must not match a monthly shorthand amount', () => {
  const answer = 'Annual fee of USD 6,200 [1].';
  preserved(applyMoneyVeto, money(answer, 'USD 6.2k per year fee.'));
  refused(applyMoneyVeto, money('Yearly fee of USD 6,200 [1].', 'USD 6.2k per month fee.'), 'span_mismatch');
  refused(applyMoneyVeto, money(answer, 'USD 6.2k per month fee.'), 'span_mismatch');
});

test('control: historical last-visit question preserves a historical answer', () => {
  preserved(applyTemporalVeto, temporal('Your last appointment was 2036-04-12 [1].',
    [event(1, '2036-04-12')], { question: 'When was my last visit?' }));
});

test('control: a past day is refused and a future day is preserved', () => {
  preserved(applyTemporalVeto, temporal('Your next appointment is 2036-05-22 [1].', [event(1, '2036-05-22')]));
  refused(applyTemporalVeto, temporal('Your next appointment is 2036-05-19 [1].', [event(1, '2036-05-19')]));
});

test('control: earlier matching future event is enforced', () => {
  const docs = [event(1, '2036-05-22'), event(2, '2036-05-29')];
  preserved(applyTemporalVeto, temporal('Your next appointment is 2036-05-22 [1].', docs));
  refused(applyTemporalVeto, temporal('Your next appointment is 2036-05-29 [2].', docs));
});

test('control: all-day dates retain their day west of UTC', () => {
  preserved(applyTemporalVeto, temporal('Your next appointment is 2036-05-20 [1].',
    [event(1, '2036-05-20', { date_source: 'calendar:all_day_start' })],
    { timeZone: 'Pacific/Honolulu', now: Date.parse('2036-05-21T05:00:00Z') }));
});

test('control: timestamp crossing midnight converts to the owner day', () => {
  const docs = [event(1, '2036-05-21T02:00:00Z')];
  const extra = { timeZone: 'Pacific/Honolulu', now: Date.parse('2036-05-20T23:00:00Z') };
  preserved(applyTemporalVeto, temporal('Your next appointment is 2036-05-20 at 4 pm [1].', docs, extra));
  refused(applyTemporalVeto, temporal('Your next appointment is 2036-05-21 [1].', docs, extra));
});

test('control: missing and invalid timezone refuse only after the guard is reached', () => {
  const input = temporal('Your next appointment is 2036-05-22 [1].', [event(1, '2036-05-22')]);
  preserved(applyTemporalVeto, input);
  for (const timeZone of [undefined, '', 'Invalid/Zone']) {
    refused(applyTemporalVeto, { ...input, timeZone });
  }
});

test('control: scale equivalence preserves magnitude', () => {
  preserved(applyMoneyVeto, money('USD 73,000 charged [1].', '$73k charged'));
  refused(applyMoneyVeto, money('USD 73 charged [1].', '$73k charged'), 'span_mismatch');
});

test('control: year and month rates cannot be exchanged', () => {
  preserved(applyMoneyVeto, money('$6,200/month charged [1].', '6.2k USD a month charged'));
  refused(applyMoneyVeto, money('$6,200/yr charged [1].', '6.2k USD a month charged'), 'span_mismatch');
});

test('control: a month range cannot fill an absent interior month', () => {
  preserved(applyMoneyVeto, money('Statement months: March through May [1].', 'Statement months: March, April, May'));
  refused(applyMoneyVeto, money('Statement months: March through May [1].', 'Statement months: March, May'), 'span_mismatch');
});

test('control: long account digits and star masks retain their length', () => {
  const answer = 'Card ending 2468 charged USD 137 [1].';
  preserved(applyMoneyVeto, money(answer, 'Card ****2468 charged USD 137'));
  for (const mask of ['*****2468', 'xx2468', '992468']) {
    refused(applyMoneyVeto, money(answer, `Card ${mask} charged USD 137`), 'span_mismatch');
  }
});

test('control: both guards preserve every upstream refusal and never invent a fact', () => {
  const inputs = [
    [applyTemporalVeto, temporal('Your next appointment is 2036-05-19 [1].', [event(1, '2036-05-19')])],
    [applyMoneyVeto, money('USD 73 charged [1].', '$73k charged')],
  ];
  for (const [fn, input] of inputs) {
    refused(fn, input, fn === applyMoneyVeto ? 'span_mismatch' : undefined);
    for (const supported of [false, undefined, null, 0]) {
      const evidenceGate = { ...input.evidenceGate, supported };
      const result = fn({ ...input, evidenceGate });
      assert.deepEqual(result, { answer: input.answer, evidenceGate });
      assert.strictEqual(result.evidenceGate, evidenceGate);
    }
  }
});

// Broaden the review probes with clause, identity and timezone boundaries.
for (const question of [
  'What is the next action for the rollout?', "What's next for the rollout?",
  'What is the next phase of the rollout?', 'What is the next step before the meeting?',
  'What are the next actions before the flight?', 'What is the next stage of the rollout?',
  'What is the next move for the rollout?', 'What is next for the rollout?',
]) {
  test(`R01 procedural control: ${question}`, () => {
    preserved(applyTemporalVeto, temporal('Schedule a review meeting [1].',
      [record(1, 'Schedule a review meeting.')], { question }));
  });
}
for (const noun of ['appointment', 'visit', 'meeting', 'call', 'session', 'flight', 'trip', 'deadline']) {
  test(`R01 event noun remains guarded: ${noun}`, () => {
    const question = `What is the next ${noun} with Velora?`;
    preserved(applyTemporalVeto, temporal(`The next ${noun} is 2036-05-22 [1].`,
      [event(1, '2036-05-22')], { question }));
    refused(applyTemporalVeto, temporal(`The next ${noun} is 2036-05-19 [1].`,
      [event(1, '2036-05-19')], { question }));
  });
}

test('R02 elapsed timed events use owner-local time, preserving all-day events', () => {
  const extra = { timeZone: 'Pacific/Honolulu', now: Date.parse('2036-05-21T05:00:01Z') };
  preserved(applyTemporalVeto, temporal('Your next appointment is 2036-05-20 [1].',
    [event(1, '2036-05-20', { date_source: 'calendar:all_day_start' })], extra));
  preserved(applyTemporalVeto, temporal('Your next appointment is 2036-05-20 at 8 pm [1].',
    [event(1, '2036-05-21T06:00:00Z')], extra));
  refused(applyTemporalVeto, temporal('Your next appointment is 2036-05-20 at 7 pm [1].',
    [event(1, '2036-05-21T05:00:00Z')], extra));
  refused(applyTemporalVeto, temporal('Your next appointment is 2036-05-20 [1].',
    [event(1, '2036-05-21T05:00:00Z')], extra));
});

test('R02 mail event clocks are checked without borrowing a sent timestamp', () => {
  const make = time => record(1, `Appointment with Velora on 2036-05-20 at ${time}.`, '2036-05-19');
  preserved(applyTemporalVeto, temporal('Your next appointment is 2036-05-20 at 6 pm [1].', [make('6 pm')]));
  refused(applyTemporalVeto, temporal('Your next appointment is 2036-05-20 at 9 am [1].', [make('9 am')]));
});

for (const signal of ['restarted', 'resumed', 'is back on']) {
  test(`R03 latest explicit ${signal} resolves only an earlier same-item stop`, () => {
    const question = 'What medications am I taking right now?';
    const docs = [record(1, 'Owner takes Velunex.', '2036-04-01'),
      record(2, 'Owner stopped Velunex.', '2036-05-01'),
      record(3, `Owner ${signal} Velunex.`, '2036-05-18')];
    const input = temporal('You take Velunex [1] [3].', docs, { question });
    preserved(applyTemporalVeto, input);
    refused(applyTemporalVeto, { ...input, docs: [...docs, record(4, 'Owner stopped Velunex.', '2036-05-19')] });
    refused(applyTemporalVeto, { ...input, answer: 'You take Velunex [1].' });
    refused(applyTemporalVeto, { ...input, docs: [...docs.slice(0, 2),
      record(3, `Owner ${signal} Dorunex.`, '2036-05-18')] });
  });
}

test('R03 a negated restart cannot resolve a stop', () => {
  const docs = [record(1, 'Owner takes Velunex.', '2036-04-01'),
    record(2, 'Owner stopped Velunex.', '2036-05-01'),
    record(3, 'Owner restarted Velunex.', '2036-05-19')];
  const input = temporal('You take Velunex [1] [3].', docs,
    { question: 'What medications am I taking right now?' });
  preserved(applyTemporalVeto, input);
  for (const snippet of ['Owner never restarted Velunex.', 'Owner has not resumed Velunex.', 'Owner is not back on Velunex.']) {
    refused(applyTemporalVeto, { ...input, docs: [...docs.slice(0, 2), { ...docs[2], snippet }] });
  }
});

for (const purpose of ['sleep', 'anxiety', 'blood pressure']) {
  test(`R04 specific item identity excludes shared purpose: ${purpose}`, () => {
    const input = temporal(`You take velunex for ${purpose} [1].`,
      [record(1, `Owner takes velunex for ${purpose}.`, '2036-04-01'),
        record(2, `Owner stopped dorunex for ${purpose}.`, '2036-05-19')],
      { question: 'What medications am I taking right now?' });
    preserved(applyTemporalVeto, input);
    refused(applyTemporalVeto, { ...input, docs: [input.docs[0],
      { ...input.docs[1], snippet: `Owner stopped velunex for ${purpose}.` }] });
  });
}

test('R05 unknown event identity cannot silently bypass chronology', () => {
  const docs = [record(1, 'The session with Velora is on 2036-05-22.'),
    record(2, 'The session with Velora is on 2036-05-29.')];
  preserved(applyTemporalVeto, temporal('Your next session is 2036-05-22 [1].', docs,
    { question: 'When do I see Velora next?' }));
  refused(applyTemporalVeto, temporal('It is on 2036-05-29 [2].',
    docs.map(doc => ({ ...doc, snippet: doc.snippet.replace('The session with Velora', 'It') })),
    { question: 'When is it next?' }));
});

for (const joiner of ['. ', '; ', ', and ', ' and ', ', while ']) {
  test(`R06 fallback dates stay in the financial claim clause: ${JSON.stringify(joiner)}`, () => {
    const answer = 'Card ending 2468 charged USD 137 [1].';
    const input = snippet => money(answer, snippet, { question: 'What charges were recorded in May 2036?',
      docs: [record(1, snippet, '', { date_reliable: false })] });
    preserved(applyMoneyVeto, input('Card ending 2468 charged USD 137 on 2036-05-18.'));
    refused(applyMoneyVeto, input(`Card ending 2468 charged USD 137${joiner}card ending 2468 refunded USD 137 on 2036-05-18.`), 'unreliable_date');
    refused(applyMoneyVeto, input(`Card ending 2468 charged USD 137${joiner}refunded USD 137 on 2036-05-18.`), 'unreliable_date');
  });
}

test('R06 another charge identity cannot lend its date even at the same amount', () => {
  const answer = 'Card ending 2468 charged USD 137 for a membership [1].';
  const input = snippet => money(answer, snippet,
    { docs: [record(1, snippet, '', { date_reliable: false })] });
  preserved(applyMoneyVeto, input('Card ending 2468 charged USD 137 for a membership on 2036-05-18.'));
  refused(applyMoneyVeto, input('Card ending 2468 charged USD 137 for a membership. Card ending 2468 charged USD 137 for a repair on 2036-05-18.'), 'unreliable_date');
});

for (const phrase of ['Annual fee', 'Annual membership fee', 'Yearly fee']) {
  test(`R07 rate words retain the interval: ${phrase}`, () => {
    const answer = `${phrase} of USD 120 [1].`;
    preserved(applyMoneyVeto, money(answer, 'USD 120 per year fee.'));
    for (const snippet of ['USD 120 per month fee.', 'USD 10 a month fee.', 'USD 120 fee.']) {
      refused(applyMoneyVeto, money(answer, snippet), 'span_mismatch');
    }
  });
}

test('R07 rates cannot disappear from the answer or disagree on the same amount', () => {
  preserved(applyMoneyVeto, money('USD 120 yearly charged [1].', 'USD 120 per annum charged.'));
  refused(applyMoneyVeto, money('USD 120 charged [1].', 'USD 120 a month charged.'), 'span_mismatch');
  refused(applyMoneyVeto, money('Annual fee of USD 120 per month [1].', 'USD 120 a month fee.'), 'span_mismatch');
});

test('R08 permitted bullet masks are whole bounded groups in both directions', () => {
  const answer = 'Card ending 2468 charged USD 137 [1].';
  for (const mask of ['•2468', '••••2468', '****2468', 'x2468']) {
    preserved(applyMoneyVeto, money(answer, `Card ${mask} charged USD 137.`));
    preserved(applyMoneyVeto, money(`Card ${mask} charged USD 137 [1].`, 'Card ending 2468 charged USD 137.'));
  }
  for (const mask of ['••2468', '•••2468', '•••••2468', '*•2468', '•****2468', '•x2468', '••••92468']) {
    refused(applyMoneyVeto, money(answer, `Card ${mask} charged USD 137.`), 'span_mismatch');
    refused(applyMoneyVeto, money(`Card ${mask} charged USD 137 [1].`, 'Card ending 2468 charged USD 137.'), 'span_mismatch');
  }
});

for (const joiner of ['. ', '; ', ', and ', ' and ', ', ']) {
  test(`R09 month coverage is account-bound across clauses: ${JSON.stringify(joiner)}`, () => {
    const answer = 'Card ending 2468 statement months: March through May [1].';
    preserved(applyMoneyVeto, money(answer, 'Card ending 2468 statement months: March, April, May.'));
    refused(applyMoneyVeto, money(answer,
      `Card ending 2468 statement months: March, May${joiner}Card ending 5791 statement months: April.`), 'span_mismatch');
  });
}

test('R09 the question account also binds coverage across multiple cited records', () => {
  const docs = [record(1, 'Card ending 2468 statement months: March, May.'),
    record(2, 'Card ending 2468 statement month: April.')];
  const input = money('Statement months: March through May [1][2].', '',
    { question: 'Which statement months are recorded for card ending 2468?', docs, evidenceGate: gate([1, 2]) });
  preserved(applyMoneyVeto, input);
  refused(applyMoneyVeto, { ...input, docs: [docs[0],
    { ...docs[1], snippet: 'Card ending 5791 statement month: April. Card ending 2468 has no listed month.' }] }, 'span_mismatch');
});

test('R01 general when questions without upcoming-event intent preserve their answer', () => {
  for (const [question, answer] of [
    ['When does onboarding start?', 'Onboarding starts the third Monday in September [1].'],
    ['When does the lease renew?', 'The lease renews on 2036-09-03 [1].'],
  ]) {
    preserved(applyTemporalVeto, temporal(answer, [record(1, answer)], { question, timeZone: undefined }));
  }
});

test('R07 unparsed explicit intervals must not become rate-free amounts', () => {
  preserved(applyMoneyVeto, money('USD 120 per year charged [1].', 'USD 120 per year charged.'));
  for (const [claim, span] of [
    ['USD 120 every two months charged', 'USD 120 charged'],
    ['120 per fortnight fee', '120 per year fee'],
    ['USD 120 membership fee per year', 'USD 120 membership fee per month'],
  ]) {
    refused(applyMoneyVeto, money(`${claim} [1].`, span), 'span_mismatch');
  }
});

test('R05 an extracted subject absent from cited events must qualify rather than bypass ordering', () => {
  const docs = [event(1, '2036-05-22'), event(2, '2036-05-29')];
  preserved(applyTemporalVeto, temporal('Your next appointment is 2036-05-22 [1].', docs));
  refused(applyTemporalVeto, temporal('Your next appointment is 2036-05-29 [2].', docs,
    { question: 'When do I see someone next?' }));
});
