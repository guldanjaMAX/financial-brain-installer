// Partner review, packet 7 round 2 (question grammar / long questions / speed
// lens). Every name, amount and description here is synthetic. Each
// R3-QUESTION-2-<n> repro is expected to FAIL on the reviewed HEAD (a299c22);
// each paired control is expected to PASS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, fixture, NOW } from './ledger-review-fixture.mjs';
import { seedKnownPayers } from './ledger-known-payers-fixture.mjs';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { search, retrievalFailed } from '../src/lib/store-d1.js';

const now = Date.parse(NOW);
const classify = question => classifyLedgerQuestion(question, { now });
const selectorOf = intent => intent.kind === 'payment' ? intent.counterparty : intent.match;

function registeredPayerFixture(t) {
  const f = ledgerFixture(t, { knownPayers: false });
  seedKnownPayers(f, ['Payer One', 'Vendor Alpha'], NOW);
  f.add('sep-in', 'ACH credit Payer One', 'Payer One', { date: '2026-09-10', cents: 10000 });
  f.add('oct-in', 'ACH credit Payer One', 'Payer One', { date: '2026-10-05', cents: 2500 });
  return f;
}

// ---------------------------------------------------------------- R3-QUESTION-2-1
// The plain grammar refuses a question with two period clauses ("exactly one
// supported period is removed ... a second scope cannot become a total"), and
// the payment, spend and totals forms of this wording are refused. The
// FROM-income form is not: the payer-span loop in classifyPayerQuestion admits
// "payer one in september 2026 and" as a payer label (its last word is not a
// terminal grammar word), the remaining text parses with the second period
// only, and the question reaches the ledger scoped to October alone. The
// answer then reports the October window and "1 candidate deposit" to an
// owner who asked about September and October.
const twoPeriodIncome = 'how much income from Payer One in September 2026 and October 2026?';

test('R3-QUESTION-2-1 a two-period income question is narrowed to the last period with the first period inside the payer name', async t => {
  const f = registeredPayerFixture(t);
  const intent = classify(twoPeriodIncome);
  const body = await f.ask(twoPeriodIncome);
  if (body.route !== 'documents') {
    assert.notEqual(body.ledger?.from, '2026-10-01',
      `asked about September and October, answered for ${body.ledger?.from}..${body.ledger?.to} with selector ${JSON.stringify(selectorOf(intent))}: ${body.answer}`);
    assert.doesNotMatch(body.answer || '', /between 2026-10-01 and 2026-10-12/);
  }
  assert.equal(intent.kind, null, `two-period wording routed as ${intent.kind} ${intent.from}..${intent.to} with selector ${JSON.stringify(selectorOf(intent))}`);
});

test('R3-QUESTION-2-1 control: one period answers September completely; the spend, payment and totals forms of the two-period wording refuse', async t => {
  const f = registeredPayerFixture(t);
  const one = await f.ask('how much income from Payer One in September 2026?');
  assert.equal(one.ledger?.kind, 'merchant');
  assert.equal(one.ledger.from, '2026-09-01');
  assert.equal(one.ledger.to, '2026-09-30');
  assert.equal(one.evidence_gate.complete, true);
  assert.equal(one.ledger.total_minor, 10000);
  for (const question of [
    'how much did I spend at Vendor Alpha in September 2026 and October 2026?',
    'did the payment from Payer One arrive in September 2026 and October 2026?',
    'how much money came in in September 2026 and October 2026?',
  ]) assert.equal(classify(question).kind, null, `${question} is refused`);
});

// ---------------------------------------------------------------- R3-QUESTION-2-2
// Contract question (needs_contract_decision). The "exact names only" flip is
// recognised only at the very end of the question (end-anchored regex). Placed
// before the final clause it is absorbed into the selector label, the flag is
// not set, and the owner's instruction disappears without a note: the payer
// form becomes "payer one, exact names only" and the spend form
// "vendor alpha, exact names only,".
const flipInside = [
  ['payment', 'did the payment from Payer One, exact names only, arrive?'],
  ['merchant', 'how much did I spend at Vendor Alpha, exact names only, in September 2026?'],
  ['merchant', 'how much income from Payer One, exact names only, in September 2026?'],
];

// Partner answer 5 (verbatim): "Support "exact names only" anywhere in the
// question: strip it and set exactNamesOnly=true."
test('R3-QUESTION-2-2 "exact names only" before the final clause is swallowed into the selector and silently dropped', () => {
  for (const [kind, question] of flipInside) {
    const intent = classify(question);
    const selector = String(selectorOf(intent) || '');
    assert.doesNotMatch(selector, /exact names only/, `${question}: selector became ${JSON.stringify(selector)}`);
    assert.ok(intent.kind === null || intent.exactNamesOnly === true,
      `${question}: routed as ${intent.kind} with exactNamesOnly=${intent.exactNamesOnly}`);
    assert.equal(intent.kind, kind, `${question}: supported anywhere in the question`);
    assert.equal(intent.exactNamesOnly, true, question);
    assert.equal(selector, kind === 'payment' || /income/.test(question) ? 'payer one' : 'vendor alpha', question);
  }
  for (const question of ['exact names only, did the payment from Payer One arrive?', 'did the payment, exact names only, from Payer One arrive?']) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', question);
    assert.equal(intent.exactNamesOnly, true, question);
    assert.equal(intent.counterparty, 'payer one', question);
  }
});

test('R3-QUESTION-2-2 control: the trailing flip sets exactNamesOnly and keeps the plain selector', () => {
  for (const [kind, question, selector] of [
    ['payment', 'did the payment from Payer One arrive, exact names only?', 'payer one'],
    ['merchant', 'how much did I spend at Vendor Alpha in September 2026, exact names only?', 'vendor alpha'],
    ['merchant', 'how much income from Payer One in September 2026, exact names only?', 'payer one'],
  ]) {
    const intent = classify(question);
    assert.equal(intent.kind, kind, question);
    assert.equal(intent.exactNamesOnly, true, question);
    assert.equal(selectorOf(intent), selector, question);
  }
});

// ---------------------------------------------------------------- R3-QUESTION-2-3
// stripNounPossessive removes a noun payer's 's only when "payment" follows it
// directly. With a date or period between them the possessive survives into
// the payer label: the span loop admits "payer one's" (the label pattern
// allows an internal apostrophe and a trailing letter), so the counterparty is
// "payer one's" with words [payer, one, s]. That label matches no registered
// spelling and no bank field, so a registered payer whose short form answers
// completely becomes "I can't confirm which payer you mean".
const datedNoun = [
  "did Payer One's September 2026 payment arrive?",
  "did Payer One's 2026-09-10 payment arrive?",
];

test("R3-QUESTION-2-3 a date between the noun possessive and \"payment\" keeps 's inside the payer name", async t => {
  const f = registeredPayerFixture(t);
  for (const question of datedNoun) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', question);
    assert.equal(intent.counterparty, 'payer one', `${question}: counterparty ${JSON.stringify(intent.counterparty)} words ${JSON.stringify(intent.counterpartyWords)}`);
  }
  const body = await f.ask(datedNoun[0]);
  assert.equal(body.evidence_gate?.complete, true, `registered payer, exact payee row, September window: ${body.answer}`);
  assert.equal(body.ledger?.found, true);
});

test('R3-QUESTION-2-3 control: the possessive directly before "payment", and the FROM form with the same date, name "payer one" and answer', async t => {
  const f = registeredPayerFixture(t);
  for (const [question, from, to] of [
    ["did Payer One's payment arrive in September 2026?", '2026-09-01', '2026-09-30'],
    ["did Payer One's payment arrive 2026-09-10?", '2026-09-03', '2026-09-17'],
    ['did the payment from Payer One arrive on 2026-09-10?', '2026-09-03', '2026-09-17'],
  ]) {
    const intent = classify(question);
    assert.equal(intent.kind, 'payment', question);
    assert.equal(intent.counterparty, 'payer one', question);
    assert.deepEqual(intent.counterpartyWords, ['payer', 'one'], question);
    assert.equal(intent.from, from, question);
    assert.equal(intent.to, to, question);
    const body = await f.ask(question);
    assert.equal(body.evidence_gate?.complete, true, `${question}: ${body.answer}`);
    assert.equal(body.ledger?.found, true, question);
    assert.ok(body.citations.some(c => c.posted_on === '2026-09-10' && c.amount_minor === 10000), question);
  }
});

// ---------------------------------------------------------------- R3-QUESTION-2-4
// Contract question (needs_contract_decision). R2-QF4 area. searchVector
// swallows a failed filtered Vectorize query whenever the lane carries a
// filter: it reruns the query unfiltered (global top 100) and lets D1 narrow
// the pool. Every supplemental hint lane carries a filter, so a Vectorize
// failure that affects filtered queries leaves the hint lane with a truncated
// global pool and no error. search() then reports degraded=null and the
// answer can be certified complete, although the lane whose job is to rescue
// evidence outside the ordinary pool never ran as requested. The same
// failure on the unfiltered base query is marked vector-query-failed.
const meetingQuestion = 'what did the meeting notes say about deposits from Fixture Payer';
function vectorSearch(f, mode, calls) {
  const env = { ...f.env, VECTORIZE: { async query(embedding, options) {
    calls.push(options.filter ? 'filtered' : 'unfiltered');
    if (mode === 'filtered-fails' && options.filter) throw new Error('synthetic: filtered vector query failed');
    if (mode === 'all-fail') throw new Error('synthetic: vector index unavailable');
    return { matches: [] };
  } } };
  return search(env, { query: meetingQuestion, embedding: [0.1, 0.2], limit: 10,
    supplementalFilters: [{ category: 'meeting' }], projectionReadiness: { ready: true } });
}

// Partner answer 6 (verbatim): "Yes. A failed filtered query counts as
// degraded (complete=false) even if the unfiltered retry succeeds, on the hint
// lanes and the base query alike."
test('R3-QUESTION-2-4 a failed filtered vector query on the hint lane is swallowed by the unfiltered fallback and leaves degraded=null', async t => {
  const f = fixture(t, { knownPayers: false });
  const calls = [];
  const result = await vectorSearch(f, 'filtered-fails', calls);
  assert.deepEqual(calls, ['filtered', 'unfiltered', 'unfiltered'], 'the hint lane failed once and was retried unfiltered');
  assert.notEqual(result.degraded, null, `hint lane vector query failed, yet degraded=${result.degraded} reason=${result.degraded_reason}`);
  assert.equal(result.degraded, 'vector');
  assert.equal(result.degraded_reason, 'vector-query-failed');
  assert.equal(retrievalFailed(result.degraded, result.degraded_reason), true, 'the answer cannot be certified complete');
  const baseCalls = [];
  const env = { ...f.env, VECTORIZE: { async query(embedding, options) {
    baseCalls.push(options.filter ? 'filtered' : 'unfiltered');
    if (options.filter) throw new Error('synthetic: filtered vector query failed');
    return { matches: [] };
  } } };
  const base = await search(env, { query: meetingQuestion, embedding: [0.1, 0.2], limit: 10,
    filters: { category: 'meeting' }, projectionReadiness: { ready: true } });
  assert.deepEqual(baseCalls, ['filtered', 'unfiltered'], 'the base query failed filtered and was retried unfiltered');
  assert.equal(base.degraded, 'vector', `base query: degraded=${base.degraded} reason=${base.degraded_reason}`);
  assert.equal(base.degraded_reason, 'vector-query-failed');
});

test('R3-QUESTION-2-4 control: healthy lanes are not degraded; a vector failure that also hits the base query is marked', async t => {
  const f = fixture(t, { knownPayers: false });
  const healthy = await vectorSearch(f, 'healthy', []);
  assert.equal(healthy.degraded, null);
  const calls = [];
  const failed = await vectorSearch(f, 'all-fail', calls);
  assert.equal(failed.degraded, 'vector');
  assert.equal(failed.degraded_reason, 'vector-query-failed');
  assert.ok(calls.includes('unfiltered'));
});
