import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,ask,intent,raw} from './c3-calendar-scope-fixture.mjs';
for (const tail of ['before the 10th','through the 9th']) test(`C3 D unread bound ${tail}`,async t=>{
 const f=setup(t);
 const peer=await ask(f,'Show expenses from October 1 to October 9',raw(intent()));
 assert.equal(peer.body.ledger.total_minor,0);
 const r=await ask(f,`Show expenses Oct 2026 ${tail}`,raw(intent()));
 assert.equal(r.body.ledger,undefined);
 assert.ok(r.body.gaps.some(g=>g.scope==='calendar'));
 assert.match(r.body.answer,new RegExp(tail));
 assert.equal(r.sql.length,0);
});
test('C3 D payment day cannot hide a second bound',async t=>{
 const f=setup(t),q='Could you check the payment on October 10 before the 9th';
 const r=await ask(f,q,raw(intent('payment',{direction:'inflow',date_text:'October 10'})));
 assert.equal(r.sql.length,0);assert.ok(r.body.gaps.some(g=>g.scope==='calendar'));
});

import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
async function mutated(t,file,before,after,links={}) {
 const dir=mkdtempSync(join(tmpdir(),'brain-c3-d-mutant-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let source=readFileSync(new URL(`../src/lib/${file}`,import.meta.url),'utf8');
 if(before){assert.equal(source.split(before).length-1,1);source=source.replace(before,after);}
 if (file === 'ledger-intent-calendar.js' && after?.includes('filter(m => !/')) source = source.replace(/  \/\/ A consumed period[\s\S]*?(?=  \/\/ Convert normalized offsets back)/, '');
 source=source.replace(/from (["'])(\.\/[^"']+)\1/g,(_,quote,path)=>`from ${quote}${links[path]||new URL(`../src/lib/${path.slice(2)}`,import.meta.url).href}${quote}`);
 const path=join(dir,file.replace('.js','.mjs'));writeFileSync(path,source);
 return {href:pathToFileURL(path).href,api:await import(pathToFileURL(path).href)};
}
for(const label of ['residue check skipped for named months','residue check ignores ordinals','refusal reads facts first']) test(`C3 D mutant: ${label}`,async t=>{
 const f=setup(t),q=label.includes('ordinals')?'Show expenses Oct 2026 the 10th':'Show expenses Oct 2026 before the 10th';
 const oracle=r=>{assert.equal(r.body.ledger,undefined);assert.equal(r.sql.length,0);assert.ok(r.body.gaps.some(g=>g.scope==='calendar'));};
 oracle(await ask(f,q,raw(intent())));
 let answer;
 if(label==='refusal reads facts first') {
  answer=await mutated(t,'ledger-answer.js',"    return Response.json({ mode: 'think', answer: (decision.futurePeriod ? 'This period has not happened yet.","    await readEffectiveTransactions(env, await readEffectiveAccounts(env), { from: '2026-10-01', to: '2026-10-31' });\n    return Response.json({ mode: 'think', answer: (decision.futurePeriod ? 'This period has not happened yet.");
 } else {
  let compiler;
  if(label.includes('named months')) compiler=await mutated(t,'ledger-intent.js','    use(named, relativeYear);','    use(named, relativeYear); consumed = [[0,text.length]];');
  else {
   const calendar=await mutated(t,'ledger-intent-calendar.js','const unread = [...text.matchAll(tokens)].filter(m =>',String.raw`const unread = [...text.matchAll(tokens)].filter(m => !/^(?:the )?\d{1,2}(?:st|nd|rd|th)$/.test(m[0])).filter(m =>`);
   compiler=await mutated(t,'ledger-intent.js',null,null,{'./ledger-intent-calendar.js':calendar.href});
  }
  answer=await mutated(t,'ledger-answer.js',null,null,{'./ledger-intent.js':compiler.href});
 }
 const bad=await ask(f,q,raw(intent()),answer.api.withLedgerAnswer);
 assert.ok(bad.sql.some(s=>s.includes('CROSS JOIN fin_transactions')),'mutant reaches real SQLite facts');
 assert.throws(()=>oracle(bad),assert.AssertionError);
 const peer=await ask(f,'Show expenses from October 1 to October 9',raw(intent()),answer.api.withLedgerAnswer);
 assert.equal(peer.body.ledger.total_minor,0);
});

import {localLedgerWindow} from '../src/lib/ledger-intent.js';
import {supplementalLedgerWindow} from '../src/lib/ledger-intent-calendar.js';
test('C3 D parsers report exact original spans after expansion',()=>{
 for(const [q,expected,parse] of [
  ["Show expenses Oct. '2025", "Oct. '2025",localLedgerWindow],
  ['Show expenses from October 1 to October 9','from October 1 to October 9',localLedgerWindow],
  ['Show expenses on or after Oct 30th','on or after Oct 30th',localLedgerWindow],
  ['Show expenses since last Monday','since last Monday',supplementalLedgerWindow],
 ]) {
  const p=parse(q,'2026-11-03',true);assert.ok(p.from,q);assert.equal(p.invalid,undefined,q);
  assert.deepEqual(p.consumed.map(([start,end])=>q.slice(start,end)),[expected],q);
 }
});
test('C3 D grounded currency amounts cannot become calendar years',async t=>{
 const f=setup(t);
 const r=await ask(f,'Could you check the $1234 payment last month',raw(intent('payment',{direction:'inflow',amount_text:'$1234'})));
 assert.ok(r.sql.some(s=>s.includes('CROSS JOIN fin_transactions')));
 assert.equal(r.body.ledger.found,false);
});
test('C3 D model tail labels cannot erase calendar bounds',async t=>{
 const f=setup(t);
 for(const tail of ['before the 10th','through the 9th','since Monday']) {
  const reply={...raw(intent()),unanswered_part:tail};
  const r=await ask(f,`Show expenses Oct 2026 ${tail}`,reply);
  assert.equal(r.sql.length,0);assert.equal(r.body.ledger,undefined);
  assert.ok(r.body.gaps.some(g=>g.scope==='calendar'));
  assert.ok(r.body.answer.includes(tail === 'since Monday' ? 'Oct 2026' : tail));
 }
});
test('C3 D abbreviated weekdays cannot hide behind a named month',async t=>{
 const f=setup(t);
 for(const day of ['Mon','Tue.','WED','Thu','Fri.','Sat','Sun','Mondays']) {
  const r=await ask(f,`Show expenses Oct 2026 ${day}`,raw(intent()));
  assert.equal(r.sql.length,0,day);assert.ok(r.body.gaps.some(g=>g.scope==='calendar'),day);
 }
});
test('C3 D derived comparison windows preserve unread constraints',async t=>{
 const f=setup(t);
 const peer=await ask(f,'Compare expenses yesterday versus the day before',raw(intent(),intent()));
 assert.deepEqual(peer.body.ledger.parts.map(p=>[p.from,p.to]),[['2026-11-02','2026-11-02'],['2026-11-01','2026-11-01']]);
 assert.deepEqual(peer.body.ledger.parts.map(p=>p.expense_total_minor),[0,0]);
 const r=await ask(f,'Compare expenses yesterday versus the day before before the 10th',raw(intent(),intent()));
 assert.equal(r.sql.length,0);assert.equal(r.body.ledger,undefined);
 assert.ok(r.body.gaps.some(g=>g.scope==='calendar'));
 assert.ok(r.body.answer.includes('before the 10th'));
});
test('C3 D written day ordinals beside months are calendar tokens',async t=>{
 const f=setup(t);
 for(const day of ['the ninth','the tenth','the twenty-first','the thirty first']) {
  const r=await ask(f,`Show expenses Oct 2026 ${day}`,raw(intent()));
  assert.equal(r.sql.length,0,day);assert.ok(r.body.gaps.some(g=>g.scope==='calendar'),day);
 }
});
test('C3 D explicit years cannot consume a conflicting relative year',async t=>{
 const f=setup(t);
 for(const period of ['Oct 2025 this year','Q3 2025 this year','Oct 2026 last year']) {
  const r=await ask(f,`Show expenses ${period}`,raw(intent()));
  assert.equal(r.sql.length,0,period);assert.ok(r.body.gaps.some(g=>g.scope==='calendar'),period);
 }
});
test('C3 D consuming since on a relative period includes the days through today',async t=>{
 const f=setup(t);
 const peer=await ask(f,'Show expenses from 2026-10-01 to 2026-11-03',raw(intent()));
 assert.equal(peer.body.ledger.total_minor,1700);
 const r=await ask(f,'Show expenses since last month',raw(intent()));
 assert.deepEqual([r.body.ledger.from,r.body.ledger.to],['2026-10-01','2026-11-03']);
 assert.equal(r.body.ledger.total_minor,peer.body.ledger.total_minor);
});
test('C3 D unread quotes exclude already consumed spans',()=>{
 const p=localLedgerWindow('Show expenses before the 9th Oct 2026 after the 20th','2026-11-03',true);
 assert.equal(p.invalid,true);
 assert.deepEqual(p.unread,['before the 9th','after the 20th']);
});
test('C3 D financial adjustment words retain their non-calendar meaning',async t=>{
 const f=setup(t);
 for(const basis of ['after returns','after credits','after refund']) {
  const r=await ask(f,`Show Store Vendor spending last month ${basis}`,raw(intent('merchant',{vendor_text:'Store Vendor'})));
  assert.ok(r.sql.some(s=>s.includes('CROSS JOIN fin_transactions')),basis);
  assert.equal(r.body.ledger.total_minor,1700,basis);
  assert.match(r.body.answer,/unconfirmed|before subtracting refunds|not been subtracted/i,basis);
 }
});

test('S4 latest-payment ranking coexists with strict calendar consumption', async t => {
 const f=setup(t);
 f.add('main','2026-10-18',271,'outflow','Supplier payment','Supplier Unit');
 f.add('main','2026-10-22',319,'outflow','Supplier payment','Supplier Unit');
 const core=raw(intent('payment',{vendor_text:'Supplier Unit',account_hint:'account ending 1111'}));
 const r=await ask(f,'When did I last pay Supplier Unit in the account ending 1111 in October 2026?',core);
 assert.equal(r.body.ledger?.found,true);
 assert.deepEqual(r.body.citations.map(c=>[c.amount_minor,c.posted_on]),[[319,'2026-10-22']]);
 const refused=await ask(f,'When did I last pay Supplier Unit in the account ending 1111 in October 2026 before the 10th?',core);
 assert.equal(refused.body.ledger,undefined);
 assert.ok(refused.body.gaps.some(g=>g.scope==='calendar'));
 assert.equal(refused.sql.length,0);
});

test('S4 restoring calendar rejection of latest-payment ranking is killed', async t => {
 const f=setup(t);
 f.add('main','2026-10-22',319,'outflow','Supplier payment','Supplier Unit');
 const block = String.raw`    if (raw.intents[index]?.kind === 'payment' || amountLookup(raw.intents[index])) temporal = temporal.replace(
      /\b(?:last|most recent)(?=\s+(?:pay|paid|payment)\b)/gi, match => ' '.repeat(match.length));`;
 const compiler=await mutated(t,'ledger-intent.js',block,'');
 const answer=await mutated(t,'ledger-answer.js',null,null,{'./ledger-intent.js':compiler.href});
 const core=raw(intent('payment',{vendor_text:'Supplier Unit',account_hint:'account ending 1111'}));
 const q='When did I last pay Supplier Unit in the account ending 1111 in October 2026?';
 const oracle=r=>assert.equal(r.body.ledger?.found,true);
 oracle(await ask(f,q,core));
 const bad=await ask(f,q,core,answer.api.withLedgerAnswer);
 assert.ok(bad.body.gaps.some(g=>g.scope==='calendar'));
 assert.throws(()=>oracle(bad),assert.AssertionError);
 oracle(await ask(f,q,core));
});

test('S4 ranking words inside literal payees cannot become unread calendar prose', async t => {
 const f=setup(t);
 for(const vendor of ['Last Pay Services','Most Recent Payment Services']) {
  f.add('main','2026-10-22',319,'outflow','Supplier payment',vendor);
  const core=raw(intent('payment',{vendor_text:vendor,account_hint:'account ending 1111',amount_text:'$3.19'}));
  const r=await ask(f,`Could you retrieve the $3.19 payment to ${vendor} in the account ending 1111 in October 2026?`,core);
  assert.equal(r.body.ledger?.found,true,vendor);
  assert.deepEqual(r.body.citations.map(c=>[c.amount_minor,c.posted_on]),[[319,'2026-10-22']],vendor);
 }
});

test('S4 ranking recognition before protected payee removal is killed', async t => {
 const f=setup(t);
 f.add('main','2026-10-22',319,'outflow','Supplier payment','Last Pay Services');
 const early=String.raw`    if (raw.intents[index]?.kind === 'payment' || amountLookup(raw.intents[index])) temporal = temporal.replace(
      /\b(?:last|most recent)(?=\s+(?:pay|paid|payment)\b)/gi, match => ' '.repeat(match.length));
    temporal = withoutSelector(temporal);`;
 const compiler=await mutated(t,'ledger-intent.js','    temporal = withoutSelector(temporal);',early);
 const answer=await mutated(t,'ledger-answer.js',null,null,{'./ledger-intent.js':compiler.href});
 const q='Could you retrieve the $3.19 payment to Last Pay Services in the account ending 1111 in October 2026?';
 const core=raw(intent('payment',{vendor_text:'Last Pay Services',account_hint:'account ending 1111',amount_text:'$3.19'}));
 const oracle=r=>assert.equal(r.body.ledger?.found,true);
 oracle(await ask(f,q,core));
 const bad=await ask(f,q,core,answer.api.withLedgerAnswer);
 assert.ok(bad.body.gaps.some(g=>g.scope==='calendar'));
 assert.throws(()=>oracle(bad),assert.AssertionError);
 oracle(await ask(f,q,core));
});
