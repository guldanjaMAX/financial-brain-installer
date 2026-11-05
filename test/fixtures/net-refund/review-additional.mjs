import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, reached, safeBasis, surfaces, offer, save, purchase, refund, reply, parts } from './review-harness.mjs';
const rows = [purchase, refund, { ...purchase, id: 'prior_purchase', cents: 9000, date: '2026-09-05' },
  { ...purchase, id: 'older_purchase', cents: 6000, date: '2026-08-05' }];
const observations = [];
for (const vendor of ['Vendor Unit', null]) for (const phrase of ['net of refunds', 'after returns']) test(`three monthly amounts: ${vendor ? 'payee' : 'overall'} ${phrase}`, async t => {
  const subject = vendor ? 'at Vendor Unit ' : '';
  const intents = [reply({ kind: vendor ? 'merchant' : 'expense_summary', vendor_text: vendor,
    period: { type: 'between', from: 'August 1', to: 'October 12' } })];
  const grossQuestion = `Could you retrieve spending ${subject}by month from August 1 through October 12?`;
  const gross = await evaluate({ rows, intents, question: grossQuestion }); reached(gross);
  assert.deepEqual(gross.body.ledger.months.map(m => m.total_minor), [6000, 9000, 12000]);
  const question = `Could you retrieve spending ${subject}by month from August 1 through October 12 ${phrase}?`;
  const actual = await evaluate({ rows, intents, question }); reached(actual);
  assert.equal(actual.trace.model, 1);
  assert.equal(actual.trace.transactions, 3);
  assert.equal(actual.plan.intents[0].netRefunds, undefined);
  assert.equal(actual.plan.intents[0].refundsNotNetted, true);
  assert.deepEqual(actual.body.ledger.months.map(month => month.total_minor), [6000, 9000, 12000]);
  const views = await surfaces(t, actual, question), safe = safeBasis(actual);
  observations.push({ id: `monthly_${vendor ? 'payee' : 'overall'}_${phrase}`, question, safe, trace: actual.trace, plan: actual.plan, body: actual.body, surfaces: views }); save('additional-observations', observations);
  for (const text of Object.values(views)) offer(text);
  assert.equal(safe, true, 'monthly selection cannot discard the requested net basis');
});
for (const [id, suffix, vendor] of [
  ['store_credit_comparison', 'after receiving store credit', 'Vendor Unit'],
  ['refund_payee_comparison', 'after shopping at refund', 'refund'],
]) test(`ordinary gross comparison: ${id}`, async t => {
  const intents = [reply({ vendor_text: vendor }), reply({ vendor_text: vendor, period: { type: 'last_month' } })];
  const input = { rows: rows.map(r => ({ ...r, payee: vendor })), intents,
    question: `Could you compare gross spending at ${vendor} this month versus last month ${suffix}?` };
  const base = await evaluate(input, true); assert.equal(base.body.ledger.comparison.difference_minor, 3000);
  const current = await evaluate(input); reached(current);
  const views = await surfaces(t, current, input.question), safe = current.bytes === base.bytes;
  observations.push({ id, question: input.question, safe, trace: current.trace, plan: current.plan, body: current.body, baseline: base.body, surfaces: views }); save('additional-observations', observations);
  assert.equal(current.bytes, base.bytes, 'ordinary comparison must retain base bytes and arithmetic');
});
for (const question of [
  'How much did I spend at Vendor Unit this month after returns?',
  'How much did I spend this month with refunds taken off at Vendor Unit?',
  'What did I really spend after refunds?',
]) test(`alternate wording: ${question}`, async t => {
  const vendor = question.includes('Vendor Unit') ? 'Vendor Unit' : null;
  const intents = [reply({ kind: vendor ? 'merchant' : 'expense_summary', vendor_text: vendor })];
  const green = await evaluate({ rows, intents, question: vendor ? 'Could you retrieve gross Vendor Unit spending this month?' : 'Could you retrieve gross spending this month?' }); reached(green);
  const actual = await evaluate({ rows, intents, question }), views = await surfaces(t, actual, question), safe = safeBasis(actual);
  observations.push({ id: question, safe, trace: actual.trace, plan: actual.plan, body: actual.body, surfaces: views }); save('additional-observations', observations);
  assert.equal(safe, true, 'alternate wording must retain the requested basis');
});
