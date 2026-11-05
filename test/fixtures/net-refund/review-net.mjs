import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, reached, safeBasis, surfaces, offer, save, purchase, refund, reply, parts } from './review-harness.mjs';
const rows = [purchase, refund, { ...purchase, id: 'prior_purchase', cents: 9000, date: '2026-09-05' },
  { ...purchase, id: 'older_purchase', cents: 6000, date: '2026-08-05' },
  { ...refund, id: 'older_refund', cents: 500, date: '2026-08-06' }];
const observations = [];
for (const vendor of ['Vendor Unit', null]) for (const phrase of ['after returns', 'net of returns', 'excluding refunds', 'with refunds taken off', 'really spend after refunds']) {
  const subject = vendor ? 'at Vendor Unit ' : '';
  const question = phrase === 'really spend after refunds' ? `What did I really spend ${subject}this month after refunds?`
    : `Could you retrieve spending ${subject}this month ${phrase}?`;
  const c = { id: `${vendor ? 'payee' : 'overall'}_${phrase}`, question, rows, intents: [reply({ kind: vendor ? 'merchant' : 'expense_summary', vendor_text: vendor })] };
  test(c.id, async t => {
    const gross = await evaluate({ ...c, question: `Could you retrieve gross spending ${subject}this month?` }); reached(gross);
    const baseGross = await evaluate({ ...c, question: `Could you retrieve gross spending ${subject}this month?` }, true);
    assert.equal(gross.bytes, baseGross.bytes, 'reached gross peer is byte-identical to base');
    assert.equal(parts(gross.body)[0].total_minor, 12000);
    const actual = await evaluate(c), views = await surfaces(t, actual, c.question);
    const safe = safeBasis(actual);
    observations.push({ id: c.id, question, safe, trace: actual.trace, plan: actual.plan, body: actual.body, surfaces: views }); save('net-observations', observations);
    if (actual.body.ledger) for (const text of Object.values(views)) offer(text);
    assert.equal(safe, true, 'requested basis is refused or explicitly limited to a supported description measure');
    if (parts(actual.body).some(p => p.net_refunds_unavailable)) for (const text of Object.values(views)) assert.match(text, /before subtracting refunds/);
  });
}
for (const phrase of ['after returns', 'with refunds taken off']) test(`payee comparison with only one refund month: ${phrase}`, async t => {
  const intents = [reply(), reply({ period: { type: 'last_month' } })];
  const gross = await evaluate({ rows, intents, question: 'Could you compare gross Vendor Unit spending this month versus last month?' }); reached(gross);
  assert.deepEqual(gross.body.ledger.comparison, { figures_minor: [12000, 9000], difference_minor: 3000 });
  const question = `Could you compare Vendor Unit spending this month versus last month ${phrase}?`;
  const actual = await evaluate({ rows, intents, question }); reached(actual);
  const views = await surfaces(t, actual, question), safe = safeBasis(actual) && !actual.body.ledger.comparison;
  observations.push({ id: `asymmetric_${phrase}`, question, safe, trace: actual.trace, plan: actual.plan, body: actual.body, surfaces: views }); save('net-observations', observations);
  for (const text of Object.values(views)) offer(text);
  assert.equal(safe, true, 'one refund month cannot turn a gross difference into a requested net difference');
});
for (const vendor of ['Vendor Unit', null]) test(`accepted category alias: ${vendor ? 'payee' : 'overall'}`, async t => {
  const subject = vendor ? 'at Vendor Unit ' : '', intents = [reply({ kind: 'category', vendor_text: vendor })];
  const gross = await evaluate({ rows, intents, question: `Could you retrieve spending ${subject}this month?` }); reached(gross);
  const question = `Could you retrieve spending ${subject}this month after returns?`;
  const actual = await evaluate({ rows, intents, question }); reached(actual);
  const views = await surfaces(t, actual, question), safe = safeBasis(actual);
  observations.push({ id: `category_${vendor ? 'payee' : 'overall'}`, question, safe, trace: actual.trace, plan: actual.plan, body: actual.body, surfaces: views }); save('net-observations', observations);
  assert.equal(safe, true, 'every admitted expense amount kind must preserve requested refund basis');
});
for (const mode of ['three_intents', 'two_intents', 'monthly_overall', 'monthly_payee']) test(`three-period comparison: ${mode}`, async t => {
  const monthly = mode.startsWith('monthly');
  const vendor = mode === 'monthly_payee' ? 'Vendor Unit' : null;
  const intents = monthly ? [reply({ kind: vendor ? 'merchant' : 'expense_summary', vendor_text: vendor,
    period: { type: 'between', from: 'August 1', to: 'October 12' } })]
    : ['August', 'September', ...(mode === 'three_intents' ? ['October'] : [])].map(month => reply({ kind: 'expense_summary', vendor_text: null, period: { type: 'none' }, date_text: month }));
  const question = monthly ? `Could you compare spending ${vendor ? 'at Vendor Unit ' : ''}by month from August 1 through October 12 net of refunds?`
    : 'Could you compare spending in August versus September versus October net of refunds?';
  const green = await evaluate({ rows, intents: [reply(), reply({ period: { type: 'last_month' } })], question: 'Could you compare gross Vendor Unit spending this month versus last month?' }); reached(green);
  assert.equal(green.body.ledger.comparison.difference_minor, 3000);
  const actual = await evaluate({ rows, intents, question }), views = await surfaces(t, actual, question), safe = safeBasis(actual);
  observations.push({ id: mode, question, safe, trace: actual.trace, plan: actual.plan, body: actual.body, surfaces: views }); save('net-observations', observations);
  assert.equal(safe, true, 'three requested periods cannot expose an unqualified gross amount as net');
});
