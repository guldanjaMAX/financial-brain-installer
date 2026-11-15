import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ask, intent, raw } from './c3-calendar-scope-fixture.mjs';
import { facts, disclosed, comparisonSetup, aligned } from './date-word-review-fixture.mjs';

for (const [question, words] of [
  ['Show expenses late October 2026', 'late'],
  ['Show expenses early October 2026', 'early'],
  ['Show expenses October 2026 before 10:00', 'before 10:00'],
  ['Show expenses outside October 2026', 'outside'],
  ['Show expenses October 2026 so far', 'so far'],
]) test(`R1 readable dates with an explicit unused limit: ${question}`, async t => {
  const f = setup(t);
  const full = await ask(f, 'Show expenses from 2026-10-01 to 2026-10-31', raw(intent()));
  const narrow = await ask(f, 'Show expenses from 2026-10-20 to 2026-10-31', raw(intent()));
  facts(full); facts(narrow);
  assert.equal(full.body.ledger.total_minor, 1700);
  assert.equal(narrow.body.ledger.total_minor, 0);
  disclosed(await ask(f, question, raw(intent())), words);
});

for (const reverse of [false, true]) test(`R2 coverage-bounded same-days comparison, reverse=${reverse}`, async t => {
  const f = comparisonSetup(t);
  const peer = await ask(f, 'Show expenses from 2026-10-01 to 2026-10-02', raw(intent()));
  facts(peer); assert.equal(peer.body.ledger.total_minor, 500);
  const q = reverse ? 'Compare expenses the same days last month versus this month so far'
    : 'Compare expenses this month so far versus the same days last month';
  aligned(await ask(f, q, raw(intent(), intent())), reverse);
});

test('R3 headline, clarification and figure share the final covered range', async t => {
  const f = setup(t);
  f.raw("UPDATE fin_account_coverage SET covered_to='2026-11-02'");
  f.add('main', '2026-11-02', 731, 'inflow'); f.add('main', '2026-11-03', 99999, 'inflow');
  const peer = await ask(f, 'Show money in from 2026-11-01 to 2026-11-02', raw(intent('totals')));
  facts(peer); assert.equal(peer.body.ledger.combined_inflow_minor, 731);
  const r = await ask(f, 'how much money came in this month so far, by payer', raw(intent('totals')));
  facts(r); assert.equal(r.body.ledger.combined_inflow_minor, 731);
  assert.equal(r.body.ledger.to, '2026-11-02');
  assert.doesNotMatch(r.body.answer, /for November 1 to 3/);
  assert.match(r.body.answer.split('\n')[0], /for November 1 to 2/);
  assert.match(r.body.clarification.best_reading, /for November 1 to 2/);
});

test('R2 month-length clipping retains figures but cannot certify equal days', async t => {
  const f = setup(t);
  f.raw("UPDATE fin_account_coverage SET covered_to='2026-03-30'");
  f.add('main', '2026-03-02', 900); f.add('main', '2026-03-30', 8000);
  f.add('main', '2026-02-02', 500);
  const clock = { now: Date.parse('2026-03-31T12:00:00Z') };
  const peer = await ask(f, 'Show expenses from 2026-02-01 to 2026-02-28', raw(intent()), undefined, clock);
  facts(peer); assert.equal(peer.body.ledger.total_minor, 500);
  const r = await ask(f, 'Compare expenses this month so far versus the same days last month', raw(intent(), intent()), undefined, clock);
  facts(r);
  assert.deepEqual(r.body.ledger.parts.map(p => p.expense_total_minor), [8900, 500]);
  assert.equal(r.body.ledger.comparison, undefined, 'a shorter month is not the same number of days');
  assert.equal(r.body.ledger.comparison_unavailable.reason, 'period_alignment');
  assert.match(r.body.answer, /same number of days/);
});
