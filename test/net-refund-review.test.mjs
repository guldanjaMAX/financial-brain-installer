import './fixtures/net-refund/review-controls.mjs';
import './fixtures/net-refund/review-net.mjs';
import './fixtures/net-refund/review-category.mjs';
import './fixtures/net-refund/review-additional.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, reached, surfaces, purchase, refund, reply, parts } from './fixtures/net-refund/review-harness.mjs';

for (const vendor of ['Vendor Unit', null]) test(`plain refund wording: ${vendor ? 'single business' : 'overall'}`, async t => {
  const subject = vendor ? 'at Vendor Unit ' : '';
  const input = { rows: [purchase, refund], intents: [reply({ kind: vendor ? 'merchant' : 'expense_summary', vendor_text: vendor })],
    question: `Could you retrieve spending ${subject}this month?` };
  const gross = await evaluate(input); reached(gross);
  assert.ok(parts(gross.body).every(p => !p.net_refunds_unavailable));
  const question = input.question.replace('?', ' with refunds taken off?');
  const actual = await evaluate({ ...input, question }); reached(actual);
  const notice = 'I cannot confirm spending after refunds because the bank feed does not supply a refund or reversal type; the amounts below are before subtracting refunds.';
  const offer = vendor ? 'Want to review the deposits for possible refunds from this business?'
    : 'Want to review the deposits for possible refunds?';
  const outputs = await surfaces(t, actual, question);
  for (const text of Object.values(outputs)) {
    assert.ok(text.includes(notice));
    assert.ok(text.includes('; refunds have not been subtracted, so spending after refunds is unconfirmed.'));
    assert.ok(text.trim().endsWith(offer));
    assert.equal(text.split(offer).length - 1, 1);
  }
});

import { refundBasisForOperand } from '../worker/src/lib/ledger-refund-basis.js';
const basisPairs = [
  ['after refunds', 'after shopping at refund', 'refund'],
  ['after returns', 'after investment returns', null],
  ['after credits', 'after receiving store credit', null],
  ['net of refunds', 'at Net of Refunds Unit', 'Net of Refunds Unit'],
  ['minus returns', 'at Minus Returns Unit', 'Minus Returns Unit'],
  ['less refunds', 'at Less Refunds Unit', 'Less Refunds Unit'],
  ['net of credits', 'at Net of Credits Unit', 'Net of Credits Unit'],
  ['with refunds taken off', 'with refunds taken offline', null],
  ['once refunds are netted out', 'at Refunds Are Netted Out Unit', 'Refunds Are Netted Out Unit'],
  ['net spending', 'at Net Spending Unit', 'Net Spending Unit'],
];
for (const [phrase, control, selector] of basisPairs) test(`closed refund grammar: ${phrase}`, () => {
  const decide = text => refundBasisForOperand({ question: text, clause: text,
    intents: [{ vendor_text: selector }], operand: { kind: 'merchant', direction: 'outflow', vendor: selector, count: 1 } });
  assert.equal(decide(`Could you retrieve spending this month ${control}?`).requested, false,
    'nonmatching control reached the shared decision');
  assert.equal(decide(`Could you retrieve ${phrase === 'net spending' ? 'net spending' : 'spending'} this month${phrase === 'net spending' ? '' : ' ' + phrase}?`).requested, true,
    'paired amount adjustment reached the same decision');
  assert.equal(decide(`Could you retrieve gross spending this month ${phrase}?`).requested, false,
    'explicit gross operand remains independently answerable');
});

test('monthly category alias keeps the requested basis after direction selection', async () => {
  const rows = [purchase, refund, { ...purchase, id: 'prior_purchase', cents: 9000, date: '2026-09-05' },
    { ...purchase, id: 'older_purchase', cents: 6000, date: '2026-08-05' }];
  const question = 'Could you retrieve spending by month from August 1 through October 12';
  const intent = reply({ kind: 'category', vendor_text: null, direction: 'outflow',
    period: { type: 'between', from: 'August 1', to: 'October 12' } });
  const gross = await evaluate({ rows, question: question + '?', intents: [intent] }); reached(gross);
  assert.deepEqual(gross.body.ledger.months.map(month => month.total_minor), [6000, 9000, 12000]);
  const actual = await evaluate({ rows, question: question + ' net of refunds?', intents: [{ ...intent, direction: 'both' }] }); reached(actual);
  assert.equal(actual.plan.intents[0].monthlyBreakdown, true);
  assert.equal(actual.plan.intents[0].netRefunds, undefined);
  assert.equal(actual.plan.intents[0].refundsNotNetted, true);
  assert.equal(actual.trace.transactions, 3);
  assert.deepEqual(actual.body.ledger.months.map(month => month.total_minor), [6000, 9000, 12000]);
  assert.equal(actual.body.ledger.net_refunds_unavailable, true);
});
