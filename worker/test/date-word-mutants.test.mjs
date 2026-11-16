import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { localLedgerWindow } from '../src/lib/ledger-intent.js';
import { setup, ask, intent, raw } from './c3-calendar-scope-fixture.mjs';

// Data modules keep mutants request-local and leave product sources intact.
// Every replacement must match, and every killed oracle has a green peer.
async function moduleCopy(file, replacements = [], links = {}) {
  const url = new URL(`../src/lib/${file}`, import.meta.url);
  let source = readFileSync(url, 'utf8');
  for (const [before, after] of replacements) {
    assert.equal(source.split(before).length - 1, 1, 'unique mutation target reached');
    source = source.replace(before, after);
  }
  source = source.replace(/from (["'])(\.\/[^"']+)\1/g,
    (_, quote, path) => `from ${quote}${links[path] || new URL(path, url).href}${quote}`);
  const href = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return { api: await import(href), href };
}
async function reader(calendar, compilerChanges = [], answerChanges = []) {
  const compiler = await moduleCopy('ledger-intent.js', compilerChanges, calendar ? { './ledger-intent-calendar.js': calendar.href } : {});
  return (await moduleCopy('ledger-answer.js', answerChanges, { './ledger-intent.js': compiler.href })).api.withLedgerAnswer;
}
const money = r => r.body.ledger?.combined_inflow_minor ?? r.body.ledger?.total_minor ??
  (r.body.ledger?.kind === 'totals' && r.body.ledger.accounts?.reduce((sum,a)=>sum+a.credits_minor,0));
const facts = r => assert.ok(r.sql.some(sql => sql.includes('CROSS JOIN fin_transactions')), 'actual ledger decision reached');

test('mutant killed: original arbitrary word allowlist', async () => {
  const calendar = await moduleCopy('ledger-intent-calendar.js', [[
    '  unread.sort((a,b) => a.index - b.index);',
    String.raw`  const admitted = new Set('show expenses could you a list for in'.split(' '));
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (!admitted.has(m[0]) && !spans.some(([start,end]) => m.index >= start && m.index + m[0].length <= end)) unread.push(m);
  }
  unread.sort((a,b) => a.index - b.index);`,
  ]]);
  const compiler = await moduleCopy('ledger-intent.js', [], { './ledger-intent-calendar.js': calendar.href });
  const q = 'could you make a list for expenses in February';
  const oracle = parse => { const p=parse(q,'2025-07-16',true); assert.ok(p.consumed.length); assert.notEqual(p.invalid,true); };
  oracle(localLedgerWindow);
  const peer=compiler.api.localLedgerWindow('Show expenses February','2025-07-16',true);
  assert.ok(peer.consumed.length);assert.notEqual(peer.invalid,true);
  assert.throws(()=>oracle(compiler.api.localLedgerWindow),assert.AssertionError);
});

test('mutant killed: unsupported temporal restriction ignored', async t => {
  const f=setup(t),q='Show expenses Oct 2026 only in its latter half';
  const oracle=r=>{facts(r);assert.equal(money(r),1700);assert.ok(r.body.ledger.unused_calendar_limits?.includes('latter half'));assert.match(r.body.answer,/I did not narrow it by 'latter half'/);};
  const green=await ask(f,q,raw(intent()));assert.equal(green.extraction,1);oracle(green);
  const calendar=await moduleCopy('ledger-intent-calendar.js', [['for (const m of text.matchAll(restriction)) {','for (const m of []) {']]);
  const api=await reader(calendar),bad=await ask(f,q,raw(intent()),api);
  facts(bad);assert.equal(money(bad)??bad.body.ledger.expense_total_minor,1700);
  assert.throws(()=>oracle(bad),assert.AssertionError);
  const peer=await ask(f,'Show expenses from 2026-10-16 to 2026-10-31',raw(intent()),api);facts(peer);assert.equal(money(peer),0);
});

test('mutant killed: named month list rejected', async t=>{
 const f=setup(t),q='money in for August, September and October, month by month';
 const oracle=r=>assert.deepEqual(r.body.ledger?.parts.map(p=>p.from.slice(5,7)),['08','09','10']);
 const green=await ask(f,q,raw(intent('totals')));facts(green);oracle(green);
 const api=await reader(null,[['const monthList = !scopePlan && ledgerMonthList(calendarText);','const monthList = null;']]);
 const bad=await ask(f,q,raw(intent('totals')),api);assert.equal(bad.extraction,1);assert.equal(bad.sql.length,0);
 assert.throws(()=>oracle(bad),assert.AssertionError);
 const peer=await ask(f,'Show money in August',raw(intent('totals')),api);facts(peer);assert.equal(money(peer),2000);
});

test('mutant killed: middle month silently discarded', async t=>{
 const f=setup(t),q='money in for August, September and October, month by month';
 const oracle=r=>assert.deepEqual(r.body.ledger.parts.map(p=>p.from.slice(5,7)),['08','09','10']);
 oracle(await ask(f,q,raw(intent('totals'))));
 const calendar=await moduleCopy('ledger-intent-calendar.js', [['return { labels, span:','return { labels: [labels[0], labels.at(-1)], span:']]);
 const api=await reader(calendar),bad=await ask(f,q,raw(intent('totals')),api);facts(bad);assert.equal(bad.body.ledger.parts.length,2);
 assert.throws(()=>oracle(bad),assert.AssertionError);
 const peer=await ask(f,'Show money in August',raw(intent('totals')),api);facts(peer);assert.equal(money(peer),2000);
});

test('mutant killed: progress ignores latest certified day',async t=>{
 const f=setup(t),q='how much money came in this month so far, by payer';
 f.raw("UPDATE fin_account_coverage SET covered_to='2026-11-02'");f.add('main','2026-11-02',731,'inflow');
 const oracle=r=>{assert.equal(r.body.ledger?.to,'2026-11-02');assert.equal(money(r),731);};
 const green=await ask(f,q,raw(intent('totals')));facts(green);oracle(green);
 const api=await reader(null,[],[['if (!accounts.some(account => effectivePeriodCovered(account, intent.from, intent.to)) && ends.length) {','if (false) {']]);
 const bad=await ask(f,q,raw(intent('totals')),api);assert.equal(bad.extraction,1);assert.ok(bad.sql.length>0,'coverage decision reached');
 assert.throws(()=>oracle(bad),assert.AssertionError);
 const peer=await ask(f,'Show money in from 2026-11-01 to 2026-11-02',raw(intent('totals')),api);facts(peer);oracle(peer);
});

test('mutant killed: forecast extraction evades current-month actuals',async t=>{
 const f=setup(t),q='how much money am i going to make this month assuming all paying clients pay';
 f.add('main','2026-11-02',731,'inflow');
 const reply=raw(intent('forecast',{direction:null}));
 const oracle=r=>{assert.equal(money(r),731);assert.match(r.body.answer,/actuals only/i);};
 const green=await ask(f,q,reply);facts(green);oracle(green);
 const api=await reader(null,[["['totals', 'forecast'].includes(value.kind) && value.vendor_text", "['totals'].includes(value.kind) && value.vendor_text"]]);
 const bad=await ask(f,q,reply,api);assert.equal(bad.extraction,1);assert.throws(()=>oracle(bad),assert.AssertionError);
 const peer=await ask(f,q,raw(intent('totals')),api);facts(peer);oracle(peer);
});
