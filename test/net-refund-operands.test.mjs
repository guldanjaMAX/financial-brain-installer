import './fixtures/net-refund/guards.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { refundBasisForOperand } from '../worker/src/lib/ledger-refund-basis.js';
import { readFileSync } from 'node:fs';
import { execute } from './fixtures/net-refund/execute.mjs';
import { cases, purchase, refund, reply } from './fixtures/net-refund/cases.mjs';

const periods = cases.find(c => c.twoPeriods);
const parts = body => body.ledger.parts || [body.ledger];
function reached(o, count = 1, transactionReads = count) {
  assert.equal(o.trace.model, 1);
  assert.equal(o.plan.intents.length, count);
  assert.ok(o.trace.inventory > 0);
  assert.equal(o.trace.transactions, transactionReads, 'every operand reached its expected transaction reads');
  assert.equal(o.trace.document, 0);
  assert.ok(o.body.citations.length);
  const offers = o.body.answer.match(/Want[^?\n]*\?/g) || [];
  assert.equal(offers.length, 1);
  assert.ok(o.body.answer.endsWith(offers[0]));
}

for (const kind of ['merchant', 'totals', 'expense_summary']) {
  for (const phrase of ['minus returns', 'less refunds', 'net of credits', 'net spending']) {
    test(`${kind}: overall ${phrase} with an answered gross control`, async () => {
      const input = { id: `${kind}_${phrase}`, rows: [purchase, refund],
        intents: [reply({ kind, vendor_text: null })],
        question: phrase === 'net spending' ? 'Could you retrieve net spending this month?'
          : `Could you retrieve spending this month ${phrase}?` };
      const gross = await execute({ ...input, question: 'Could you retrieve gross spending this month?' });
      reached(gross);
      assert.equal(gross.body.ledger.expense_total_minor, 12000);
      assert.equal(gross.body.ledger.net_refunds_unavailable, undefined);
      const net = await execute(input);
      reached(net);
      assert.equal(net.body.ledger.net_refunds_unavailable, true);
      assert.equal(net.body.ledger.net_expense_minor, undefined);
      assert.equal(net.body.ledger.amount_basis, 'gross_before_refunds');
      assert.equal(net.body.evidence_gate.complete, false);
      assert.equal(net.body.evidence_gate.partial, true);
    });
  }
}

for (const vendor of ['Vendor Unit', null]) for (const phrase of ['minus returns', 'less refunds', 'net of credits', 'net spending', 'after returns']) {
  for (const reverse of [false, true]) test(`mixed operands: ${vendor ? 'payee' : 'overall'} ${phrase} ${reverse}`, async () => {
    const subject = vendor ? 'Vendor Unit spending' : 'spending';
    const netSubject = phrase === 'net spending' ? `net ${subject}` : subject;
    const netClause = `${netSubject} ${reverse ? 'last' : 'this'} month${phrase === 'net spending' ? '' : ' ' + phrase}`;
    const grossClause = `gross ${subject} ${reverse ? 'this' : 'last'} month`;
    const input = { ...periods, id: 'mixed_operand',
      question: `Could you compare ${reverse ? grossClause : netClause} versus ${reverse ? netClause : grossClause}?`,
      intents: [reply({ kind: vendor ? 'merchant' : 'expense_summary', vendor_text: vendor }),
        reply({ kind: vendor ? 'merchant' : 'expense_summary', vendor_text: vendor, period: { type: 'last_month' } })] };
    const green = await execute({ ...input, question: `Could you compare gross ${subject} this month versus last month?` });
    reached(green, 2);
    assert.deepEqual(green.body.ledger.comparison, { figures_minor: [12000, 9000], difference_minor: 3000 });
    const net = await execute(input);
    reached(net, 2);
    const netIndex = reverse ? 1 : 0, grossIndex = 1 - netIndex;
    assert.equal(parts(net.body)[netIndex].net_refunds_unavailable, true);
    assert.equal(parts(net.body)[grossIndex].net_refunds_unavailable, undefined);
    assert.equal(parts(net.body)[grossIndex].complete, true);
    assert.equal(net.body.ledger.comparison, undefined);
    assert.equal(net.body.evidence_gate.partial, true);
  });
}

for (const label of ['Net Spending Unit', 'Credits Card', 'Investment Returns Unit']) test(`literal selector stays gross: ${label}`, async () => {
  const input = { id: 'literal_selector', rows: [purchase, refund].map(row => ({ ...row, payee: label })),
    question: `Could you retrieve spending at ${label} this month?`, intents: [reply({ vendor_text: label })] };
  const expectedReads = label === 'Credits Card' ? 2 : 1;
  const gross = await execute(input);
  reached(gross, 1, expectedReads);
  assert.equal(gross.body.ledger.total_minor, 12000);
  assert.equal(gross.body.ledger.net_refunds_unavailable, undefined);
  const net = await execute({ ...input, question: `Could you retrieve spending at ${label} this month less refunds?` });
  reached(net, 1, expectedReads);
  assert.equal(net.body.ledger.net_refunds_unavailable, true);
});

for (const [label, clause, selectors] of [
  ['card name', 'Could you retrieve Vendor Unit spending in Net of Credits Card this month?',
    { vendor_text: 'Vendor Unit', account_hint: 'Net of Credits Card' }],
  ['investment returns', 'Could you retrieve spending this month after investment returns?', {}],
  ['merchant name', 'Could you retrieve spending at Net Spending Unit this month?',
    { vendor_text: 'Net Spending Unit' }],
]) test(`basis decision distinguishes ${label} from its refund control`, () => {
  const input = { question: clause, clause, intents: [selectors], comparison: false };
  const gross = refundBasisForOperand(input);
  assert.deepEqual(gross, { requested: false, descriptionOnly: false }, 'basis decision returned an explicit gross result');
  const netClause = clause.replace('?', ' less refunds?');
  const net = refundBasisForOperand({ ...input, question: netClause, clause: netClause });
  assert.deepEqual(net, { requested: true, descriptionOnly: false }, 'same decision accepts the refund-adjusted control');
});

const answerUrl = new URL('../worker/src/lib/ledger-answer.js', import.meta.url);
async function answerWithReplacement(from, to) {
  const source = readFileSync(answerUrl, 'utf8');
  assert.equal(source.split(from).length - 1, 1, 'one injected decision site');
  const code = source.replace(from, to).replace(/from (["'])(\.[^"']+)\1/g,
    (_, q, path) => `from ${q}${new URL(path, answerUrl).href}${q}`);
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

test('requested-basis selector still withholds net if the metadata guard is removed', async () => {
  const implementation = await answerWithReplacement(' && !part.net_refunds_unavailable', '');
  const input = { ...periods, question: 'Could you compare spending this month versus last month net of refunds?',
    intents: [reply({ kind: 'expense_summary', vendor_text: null }),
      reply({ kind: 'expense_summary', vendor_text: null, period: { type: 'last_month' } })] };
  const gross = await execute({ ...input, question: 'Could you compare gross spending this month versus last month?' }, implementation);
  reached(gross, 2);
  assert.equal(gross.body.ledger.comparison.difference_minor, 3000);
  const net = await execute(input, implementation);
  reached(net, 2);
  assert.ok(parts(net.body).every(p => p.net_refunds_unavailable));
  assert.equal(net.body.ledger.comparison, undefined, 'missing supported net amount cannot fall through to gross');
});

test('injected description measure cannot create refund authority or compare gross as net', async () => {
  const from = '  const hasForecast = extracted.some(intent => intent.forecastRequested);';
  const implementation = await answerWithReplacement(from,
    '  for (const intent of extracted) { delete intent.refundsNotNetted; intent.netRefunds = true; }\n' + from);
  const input = { ...periods, question: 'Could you compare spending this month versus last month net of refunds?',
    intents: [reply({ kind: 'expense_summary', vendor_text: null }),
      reply({ kind: 'expense_summary', vendor_text: null, period: { type: 'last_month' } })] };
  const control = await execute(input);
  reached(control, 2);
  assert.equal(control.body.ledger.comparison, undefined);
  const measured = await execute(input, implementation);
  reached(measured, 2);
  assert.deepEqual(parts(measured.body).map(p => p.net_expense_minor), [undefined, undefined]);
  assert.ok(parts(measured.body).every(p => p.net_refunds_unavailable));
  assert.deepEqual(parts(measured.body).map(p => p.possible_refunds.length), [1, 1], 'candidate decision reached in both periods');
  assert.deepEqual(parts(measured.body).map(p => p.expense_total_minor), [12000, 9000]);
  assert.equal(measured.body.ledger.comparison, undefined, 'gross fields never stand in for an unavailable net');
});

for (const vendor of ['Vendor Unit', null]) test('net spending change retains its two gross numeric peers: ' + (vendor || 'overall'), async () => {
  const input = { ...periods, id: 'net_change_regression',
    question: 'How did our net spending' + (vendor ? ' at ' + vendor : '') + ' change this month versus last month?',
    intents: [reply({ kind: vendor ? 'merchant' : 'expense_summary', vendor_text: vendor }),
      reply({ kind: vendor ? 'merchant' : 'expense_summary', vendor_text: vendor, period: { type: 'last_month' } })] };
  const subject = vendor ? vendor + ' spending' : 'spending';
  const gross = await execute({ ...input, question: 'Could you compare gross ' + subject + ' this month versus last month?' });
  reached(gross, 2);
  assert.deepEqual(gross.body.ledger.comparison.figures_minor, [12000, 9000]);
  const net = await execute(input);
  reached(net, 2);
  assert.ok(parts(net.body).some(p => p.net_refunds_unavailable));
  assert.equal(net.body.ledger.comparison, undefined);
  assert.equal(net.body.evidence_gate.complete, false);
});
