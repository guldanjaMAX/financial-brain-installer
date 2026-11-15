import test from 'node:test';
import assert from 'node:assert/strict';
import { localLedgerWindow } from '../src/lib/ledger-intent.js';
import { setup, ask, intent, raw } from './c3-calendar-scope-fixture.mjs';

const today = '2025-07-16';
const february = ['2025-02-01', '2025-02-28'];
const june = ['2025-06-01', '2025-06-30'];
const ytd = ['2025-01-01', today];

function reachedPeriod(question, expected) {
  const value = localLedgerWindow(question, today, true);
  assert.ok(value, 'the actual period parser returned a decision');
  assert.deepEqual([value.from, value.to], expected, 'period branch reached');
  assert.ok(value.consumed?.length > 0, 'a real calendar span was consumed');
  return value;
}

function admitted(question, expected) {
  const value = reachedPeriod(question, expected);
  assert.notEqual(value.invalid, true);
  assert.deepEqual(value.unread || [], []);
  return value;
}

const regressions = [
  ['verb', 'did our business make money in February',
    'show business money in February', february],
  ['direction', 'how much did we pay toward cards last month vs what we put on them',
    'show card payments last month', june],
  ['count', 'top 5 vendors by spend this year',
    'show vendors by spend this year', ytd],
  ['description prose', 'anything showing as bank charges on the cards last month, what is the total',
    'show bank charges on the cards last month', june],
];

for (const [label, question, peer, expected] of regressions) {
  test(`ordinary prose preserves its calendar: ${label}`, () => {
    admitted(peer, expected); // Green peer uses the same actual parser.
    admitted(question, expected); // Predicted red on published 0.4.27.
  });
}

const restrictions = [
  ['Show expenses February before the 8th', /before the 8th/i],
  ['Show expenses February through the 8th', /through the 8th/i],
  ['Show expenses February only in its latter half', /half/i],
  ['Show expenses February for days 1-7 only', /days/i],
  ['For the opening seven days of February, show expenses', /days/i],
  ['Show expenses February on business days only', /business days/i],
  ['Show expenses February on weekends only', /weekends/i],
  ['Only at the end of February, show expenses', /end/i],
  ['Show expenses February with a custom cutoff', /cutoff/i],
  ['Show expenses not in February', /not in/i],
];

for (const [question, expectedUnread] of restrictions) {
  test(`unread temporal restriction remains closed: ${question}`, () => {
    admitted('Show expenses February', february); // Green control.
    // 0.4.28 date-word parser now consumes opening-day limits and leaves vague endings unresolved.
    if(question.startsWith('For the opening seven')) {
      admitted(question,['2025-02-01','2025-02-07']); return;
    }
    if(question.startsWith('Only at the end')) {
      const value=localLedgerWindow(question,today,true);
      assert.ok(value,'calendar decision reached');assert.equal(value.invalid,true);
      assert.deepEqual(value.unread,['at the end','February']);return;
    }
    const value = reachedPeriod(question, february);
    assert.equal(value.invalid, true);
    assert.ok(value.unread?.length > 0);
    assert.match(value.unread.join(' '), expectedUnread);
  });
}

for (const question of [
  'Could you make a list for expenses in February?',
  'Show expenses paid to vendors in February',
  'Show expenses between accounts in February',
]) {
  test(`ordinary verb or preposition is not a date: ${question}`, () => {
    admitted('Show expenses February', february);
    admitted(question, february);
  });
}

test('unread bound reaches extraction and returns a disclosed broader reading', async t => {
  const f = setup(t); // Existing fixture pins its own clock; no host credentials.
  const full = await ask(f, 'Show expenses from 2026-10-01 to 2026-10-31', raw(intent()));
  const bounded = await ask(f, 'Show expenses from 2026-10-01 to 2026-10-09', raw(intent()));
  for (const peer of [full, bounded]) {
    assert.equal(peer.extraction, 1);
    assert.equal(peer.documents, 0);
    assert.ok(peer.sql.some(sql => sql.includes('CROSS JOIN fin_transactions')));
    assert.ok(peer.body.ledger);
  }
  assert.ok(full.body.ledger.total_minor > 0);
  assert.equal(bounded.body.ledger.total_minor, 0);
  assert.notEqual(full.body.ledger.total_minor, bounded.body.ledger.total_minor);

  const bad = await ask(f, 'Show expenses Oct 2026 before the 10th', raw(intent()));
  assert.equal(bad.extraction, 1, 'the extraction/calendar decision was reached');
  assert.equal(bad.documents, 0);
  assert.ok(bad.sql.some(sql => sql.includes('CROSS JOIN fin_transactions')));
  assert.equal(bad.body.ledger.total_minor, 1700);
  assert.deepEqual(bad.body.ledger.unused_calendar_limits, ['before the 10th']);
  assert.equal(bad.body.evidence_gate.complete, false);
  assert.match(bad.body.answer, /I did not narrow it by 'before the 10th'/);
  assert.match(bad.body.answer, /before the 10th/);
});

const liveCases = [
  ['forward actuals', 'how much money am i going to make this month assuming all paying clients pay', 'totals', ['2026-11-01','2026-11-03']],
  ['so far', 'how much money came in this month so far, by payer', 'totals', ['2026-11-01','2026-11-03']],
  ['month list', 'money in by payer for August, September and October, month by month', 'totals', null],
  ['question word', 'who paid me in October', 'totals', ['2026-10-01','2026-10-31']],
  ['make', 'did our business make money in February', 'totals', ['2026-02-01','2026-02-28']],
  ['toward', 'how much did we pay toward cards last month vs what we put on them', 'expense_summary', ['2026-10-01','2026-10-31']],
  ['count', 'top 5 vendors by spend this year', 'largest', ['2026-01-01','2026-11-03']],
  ['description', 'anything showing as bank charges on the cards last month, what is the total', 'expense_summary', ['2026-10-01','2026-10-31']],
  ['to date', 'how much money came in this month to date, by payer', 'totals', ['2026-11-01','2026-11-03']],
];

// Calendar admission is checked independently of each operation's capabilities.
// Route cases below certify amounts only for supported actual-money readings.
for (const [label,q,,expected] of liveCases.filter(row => row[3])) test(`live calendar: ${label}`, () => {
  const p = localLedgerWindow(q, '2026-11-03', true);
  assert.ok(p?.consumed?.length, 'calendar decision reached');
  assert.deepEqual([p.from,p.to],expected);
  assert.notEqual(p.invalid,true,JSON.stringify(p.unread));
});

for (const [label,q] of liveCases.filter(row => ['forward actuals','so far','question word','to date','month list'].includes(row[0]))) {
  test(`live response: ${label}`, async t => {
    const f=setup(t);
    f.add('main','2026-11-02',731,'inflow','Client payment','Client Unit');
    f.add('main','2026-11-04',99999,'inflow','Client payment','Client Unit');
    f.add('main','2026-09-15',3100,'inflow','Client payment','Client Unit');
    const peer=await ask(f,'Show money in this month',raw(intent('totals')));
    assert.ok(peer.body.ledger); assert.ok(peer.sql.some(s=>s.includes('CROSS JOIN fin_transactions')));
    const r=await ask(f,q,raw(intent('totals')));
    assert.equal(r.documents,0);
    assert.ok(r.sql.some(s=>s.includes('CROSS JOIN fin_transactions')),JSON.stringify(r.body));
    assert.ok(r.body.ledger,JSON.stringify(r.body));
    assert.doesNotMatch(r.body.answer,/Unread calendar words|future balances are unknown/);
    if(label==='month list') {
      assert.deepEqual(r.body.ledger.parts.map(p=>[p.from,p.to]),[
        ['2026-08-01','2026-08-31'],['2026-09-01','2026-09-30'],['2026-10-01','2026-10-31']]);
      assert.deepEqual(r.body.ledger.parts.map(p=>p.combined_inflow_minor??p.total_minor),[2000,3100,5000]);
    } else {
      assert.deepEqual([r.body.ledger.from,r.body.ledger.to],label==='question word'?['2026-10-01','2026-10-31']:['2026-11-01','2026-11-03']);
      assert.equal(r.body.ledger.combined_inflow_minor??r.body.ledger.total_minor,label==='question word'?5000:731);
      assert.doesNotMatch(r.body.answer,/999\.99/);
    }
  });
}

test('contradictory calendar refuses after extraction with numeric green peer',async t=>{
 const f=setup(t);
 const peer=await ask(f,'Show expenses from 2026-10-01 to 2026-10-31',raw(intent()));
 assert.ok(peer.sql.some(s=>s.includes('CROSS JOIN fin_transactions')));
 assert.equal(peer.body.ledger.total_minor??peer.body.ledger.expense_total_minor,1700);
 const r=await ask(f,'Show expenses between March and last Tuesday of 1999 next year',raw(intent()));
 assert.equal(r.extraction,1);assert.equal(r.documents,0);
 assert.equal(r.sql.length,0);assert.equal(r.body.ledger,undefined);
 assert.ok(r.body.gaps.some(g=>g.scope==='calendar'));
});


test('forward wording coerces a forecast extraction to labeled current actuals', async t=>{
 const f=setup(t); f.add('main','2026-11-02',731,'inflow');
 const r=await ask(f,liveCases[0][1],raw(intent('forecast',{direction:null})));
 assert.equal(r.extraction,1); assert.ok(r.sql.some(s=>s.includes('CROSS JOIN fin_transactions')));
 assert.equal(r.body.ledger.combined_inflow_minor,731);
 assert.match(r.body.answer,/actuals only/i);
 assert.match(r.body.answer,/future.*(?:not included|excluded)/i);
 assert.equal(r.body.ledger.forecast_supported,undefined);
});

for(const ending of ['so far','to date']) test(`current progress uses certified coverage: ${ending}`,async t=>{
 const f=setup(t);
 f.raw("UPDATE fin_account_coverage SET covered_to='2026-11-02'");
 f.add('main','2026-11-02',731,'inflow');f.add('main','2026-11-03',99999,'inflow');
 const peer=await ask(f,'Show money in from 2026-11-01 to 2026-11-02',raw(intent('totals')));
 assert.ok(peer.sql.some(s=>s.includes('CROSS JOIN fin_transactions')));assert.equal(peer.body.ledger.combined_inflow_minor,731);
 const r=await ask(f,`how much money came in this month ${ending}, by payer`,raw(intent('totals')));
 assert.equal(r.extraction,1);assert.equal(r.documents,0);
 assert.ok(r.sql.some(s=>s.includes('CROSS JOIN fin_transactions')),JSON.stringify(r.body));
 assert.deepEqual([r.body.ledger.from,r.body.ledger.to],['2026-11-01','2026-11-02']);
 assert.equal(r.body.ledger.combined_inflow_minor,731);
 assert.match(r.body.answer,/covered.*(?:Nov|November).*2/i);
 assert.doesNotMatch(r.body.answer,/999\.99/);
});

for (const [q,dates,amounts] of [
 ['money in by payer for August, October and November, month by month', ['08','10','11'],[2000,5000,731]],
 ['money in by payer for October, August and September, month by month',['10','08','09'],[5000,2000,3100]],
 ['money in by payer for Aug 2026, Sept 2026 and Oct 2026, month by month',['08','09','10'],[2000,3100,5000]],
]) test(`month lists retain only named operands: ${q}`,async t=>{
 const f=setup(t);f.add('main','2026-11-02',731,'inflow');f.add('main','2026-09-15',3100,'inflow');
 const peer=await ask(f,'Show money in August',raw(intent('totals')));assert.ok(peer.body.ledger);
 const r=await ask(f,q,raw(intent('totals')));
 assert.equal(r.extraction,1);assert.equal(r.documents,0);
 assert.ok(r.sql.some(s=>s.includes('CROSS JOIN fin_transactions')),JSON.stringify(r.body));
 assert.deepEqual(r.body.ledger.parts.map(p=>p.from.slice(5,7)),dates);
 assert.deepEqual(r.body.ledger.parts.map(p=>p.combined_inflow_minor??p.total_minor),amounts);
});

for(const q of [
 'money in for August, September and October 2025, month by month',
 'money in for August, September and October before the 8th, month by month',
 'money in for August, September and October next year, month by month',
]) test(`month list cannot discard another calendar condition: ${q}`,async t=>{
 const f=setup(t);
 const peer=await ask(f,'Show money in August',raw(intent('totals')));assert.ok(peer.body.ledger);
 const r=await ask(f,q,raw(intent('totals')));
 assert.equal(r.extraction,1);assert.equal(r.documents,0);
 if (q.includes('before the 8th')) {
  assert.ok(r.sql.some(sql=>sql.includes('CROSS JOIN fin_transactions')));
  assert.deepEqual(r.body.ledger.parts.map(p=>p.combined_inflow_minor??p.total_minor),[2000,0,5000]);
  assert.ok(r.body.ledger.parts.every(p=>p.unused_calendar_limits.includes('before the 8th')));
  assert.match(r.body.answer,/I did not narrow it by 'before the 8th'/);
 } else {
  assert.equal(r.sql.length,0);assert.equal(r.body.ledger,undefined);assert.ok(r.body.gaps.some(g=>g.scope==='calendar'));
 }
});


for(const tail of ['on weekdays only','before noon','after lunch','during holidays']) test(`unsupported calendar qualifier is disclosed: ${tail}`,async t=>{
 const f=setup(t);
 const peer=await ask(f,'Show expenses from 2026-10-01 to 2026-10-31',raw(intent()));
 assert.equal(peer.body.ledger.total_minor,1700);assert.ok(peer.sql.some(s=>s.includes('CROSS JOIN fin_transactions')));
 const q=`Show expenses October 2026 ${tail}`;
 const period=localLedgerWindow(q,'2026-11-03',true);assert.ok(period?.invalid || period?.consumed?.length,'calendar decision reached');
 const r=await ask(f,q,raw(intent()));
 assert.equal(r.extraction,1);assert.equal(r.documents,0);
 assert.ok(r.sql.some(sql=>sql.includes('CROSS JOIN fin_transactions')));
 assert.equal(r.body.ledger.total_minor,1700);
 assert.ok(r.body.ledger.unused_calendar_limits.length);
 assert.match(r.body.answer,/I did not narrow it by/);
 assert.equal(r.body.evidence_gate.complete,false);
});


test('calendar exception cannot become a positive month',()=>{
 const peer=localLedgerWindow('Show expenses October 2026','2026-11-03',true);
 assert.ok(peer.consumed.length);assert.notEqual(peer.invalid,true);
 const p=localLedgerWindow('Show expenses October 2026 except October','2026-11-03',true);
 assert.equal(p.invalid,true,'strict multiple-month decision reached');
});
