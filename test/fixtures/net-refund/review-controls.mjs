import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, reached, surfaces, save, purchase, refund, reply, parts, digest } from './review-harness.mjs';
const controls = [
  ['net_worth', 'Could you retrieve my net worth?', { kind: 'balance', vendor_text: null, direction: null, period: { type: 'none' } }],
  ['investment_returns', 'Could you retrieve my investment returns this month?', { kind: 'totals', vendor_text: null, direction: 'inflow' }],
  ['after_investment_returns', 'Could you retrieve spending this month after investment returns?', { kind: 'expense_summary', vendor_text: null }],
  ['tax_returns', 'Could you retrieve my tax returns this month?', { kind: 'not_money', vendor_text: null }],
  ['credit_card', 'Could you retrieve posted spending on my credit card this month?', { kind: 'expense_summary', vendor_text: null, account_hint: 'credit card' }],
  ['store_credit', 'Could you retrieve deposits labelled store credit this month?', { kind: 'deposits', vendor_text: 'store credit', direction: 'inflow' }],
  ['after_store_credit', 'Could you retrieve Vendor Unit spending this month after receiving store credit?', {}],
  ['gross_after_store_credit', 'Could you retrieve gross Vendor Unit spending this month after receiving store credit?', {}],
  ['gross_refund_payee_after_purchase', 'Could you retrieve gross spending this month after shopping at refund?', { vendor_text: 'refund' }],
  ['tax_return_merchant', 'Could you retrieve spending at Tax Returns Unit this month?', { vendor_text: 'Tax Returns Unit' }],
  ['netflix', 'Could you retrieve spending at Netflix this month?', { vendor_text: 'Netflix' }],
  ['network_merchant', 'Could you retrieve spending at Network Unit this month?', { vendor_text: 'Network Unit' }],
  ['internet_merchant', 'Could you retrieve spending at Internet Unit this month?', { vendor_text: 'Internet Unit' }],
  ['refund_payee', 'Could you retrieve spending at refund this month?', { vendor_text: 'refund' }],
  ['refund_payee_after_purchase', 'Could you retrieve spending this month after shopping at refund?', { vendor_text: 'refund' }],
];
const observations = [];
for (const [id, question, change] of controls) test(`ordinary control: ${id}`, async t => {
  const vendor = change.vendor_text ?? (Object.hasOwn(change, 'vendor_text') ? 'Vendor Unit' : 'Vendor Unit');
  const c = { question, intents: [reply(change)], rows: [purchase, refund].map(row => ({ ...row, payee: vendor })) };
  const green = await evaluate({ rows: [purchase, refund], question: 'Could you retrieve Vendor Unit spending this month after returns?', intents: [reply()] }); reached(green);
  assert.equal(green.body.ledger.net_refunds_unavailable, true, 'same path can reach the refund limitation');
  const current = await evaluate(c), baseline = await evaluate(c, true);
  assert.equal(current.trace.validation, 1);
  if (current.body.ledger) { assert.ok(current.trace.inventory > 0); assert.ok(current.body.citations.length || current.body.ledger.accounts.length); }
  else assert.equal(current.trace.document, 1, 'actual fallback decision reached');
  const view = await surfaces(t, current, question), baseView = await surfaces(t, baseline, question);
  const same = current.bytes === baseline.bytes && JSON.stringify(view) === JSON.stringify(baseView);
  observations.push({ id, question, same, trace: current.trace, 
    surfaceEquality: Object.fromEntries(Object.keys(view).map(key => [key, view[key] === baseView[key]])),
    currentSha256: digest(current.bytes), baselineSha256: digest(baseline.bytes), plan: current.plan, body: current.body }); save('control-observations', observations);
  assert.equal(current.bytes, baseline.bytes, 'entire actual response bytes must equal the pinned base');
  assert.deepEqual(view, baseView, 'all five presentation surfaces must equal the pinned base');
  assert.ok(parts(current.body).every(p => !p.net_refunds_unavailable), 'ordinary question retains its amount basis');
});
