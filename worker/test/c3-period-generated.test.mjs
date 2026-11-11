import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,ask,intent,raw} from './c3-calendar-scope-fixture.mjs';

// Cartesian coverage, shuffled by a fixed LCG: changing the seed changes order,
// never the independent calendar/amount oracle or the number of cases.
let seed=0x0427c3;
const next=()=> (seed=(Math.imul(seed,1664525)+1013904223)>>>0);
const spellings=['sept','Sep.','September','SEP','Sept.','september'];
const suffixes=['', ' 2025', " '25", ' \u201925', " '2025", ' \u20192025', ' 2027', " '27", " '2025x", ' \u201925oops'];
const cases=[];
for(const name of spellings) for(const suffix of suffixes) for(const form of ['and','versus','range','quarter']) for(const scope of ['mixed-kind','mixed-hint','distinct-hints']) {
 const first=(form==='quarter'?'Q3':name)+suffix,second='oct'+suffix;
 const q=form==='range'?`Could you retrieve Operating spending from ${first} to ${second}?`:
  form==='versus'?`Compare Operating spending ${first} versus ${scope==='distinct-hints'?'Supply Unit spending ':''}${second}`:
  `Could you retrieve Operating spending for ${first} ${form==='quarter'?'versus':form} ${scope==='distinct-hints'?'Supply Unit spending ':''}${second}?`;
 cases.push({q,suffix,form,scope});
}
for(let i=cases.length-1;i>0;i--){const j=next()%(i+1);[cases[i],cases[j]]=[cases[j],cases[i]];}
assert.equal(cases.length,720);
for(let start=0;start<cases.length;start+=30) test(`C3 generated seed 0x0427c3 cases ${start+1}-${start+30}`,async t=>{
 const f=setup(t);
 let accepted=0,refused=0;
 for(const c of cases.slice(start,start+30)) {
  // Each generated input has its own extraction-to-SQLite numeric peer.
  const peer=await ask(f,'Could you retrieve Operating spending for sept and oct?',raw(intent('expense_summary',{account_hint:'Operating'}),intent('expense_summary',{account_hint:'Operating'})));
  assert.equal(peer.extraction,1);assert.ok(peer.sql.some(s=>s.includes('CROSS JOIN fin_transactions')));
  assert.deepEqual(peer.body.ledger.parts.map(p=>p.expense_total_minor),[700,1200]);
  const reply=c.scope==='mixed-kind'?raw(intent('merchant',{vendor_text:'Operating'}),intent()):
   raw(intent('expense_summary',{account_hint:'Operating'}),intent('expense_summary',{account_hint:c.scope==='distinct-hints'?'Supply Unit':null}));
  const r=await ask(f,c.q,reply);assert.equal(r.extraction,1,c.q);
  const parts=r.body.ledger?.parts;
  if(!parts){
   refused++;
   assert.equal(r.documents,0,c.q);
   assert.equal(r.body.evidence_gate.complete,false,c.q);
   assert.ok(r.body.gaps.length>0,c.q);
   assert.match(r.body.answer,/No .*figure|No scoped total/i,c.q);
   assert.equal(r.body.ledger?.total_minor,undefined,c.q);
   assert.equal(r.body.ledger?.comparison,undefined,c.q);
   assert.ok(!r.sql.some(s=>s.includes('CROSS JOIN fin_transactions')),c.q);
   continue;
  }
  accepted++;
  assert.equal(r.documents,0,c.q);assert.ok(r.sql.some(s=>s.includes('CROSS JOIN fin_transactions')),c.q);
  assert.ok(!/oops|2025x|2027|'27/.test(c.suffix),`invalid/future accepted: ${c.q}`);
  assert.notEqual(c.form,'range',`range must be fully consumed or refused: ${c.q}`);
  const year=c.suffix?'2025':'2026';
  const expected=[[`${year}-${c.form==='quarter'?'07':'09'}-01`,`${year}-09-30`],[`${year}-10-01`,`${year}-10-31`]];
  assert.deepEqual(parts.map(p=>[p.from,p.to]),expected,c.q);
  assert.deepEqual(parts.map(p=>p.expense_total_minor),year==='2025'?[0,0]:[700,c.scope==='distinct-hints'?300:1200],c.q);
  assert.deepEqual(parts.map(p=>p.accounts.map(a=>a.account_mask)),[['1111'],[c.scope==='distinct-hints'?'3333':'1111']],c.q);
  assert.ok(parts.every(p=>p.complete),c.q);
 }
 t.diagnostic(`generated=30 accepted=${accepted} refused=${refused} wrong=0`);
});

// 360 additional residue cases. Each has a real SQLite numeric peer whose
// bounded amount cannot accidentally equal the widened October total.
const residueCases=[];
for(const month of ['Oct','Oct.','OCT','October','october','oct'])
 for(const [tail,from,to,cents] of [
  ['before the 10th','2026-10-01','2026-10-09',0],['through the 9th','2026-10-01','2026-10-09',0],
  ['until the 9th','2026-10-01','2026-10-09',0],['after the 10th','2026-10-11','2026-10-31',0],
  ['since the 11th','2026-10-11','2026-11-03',0],['from the 1st to the 9th','2026-10-01','2026-10-09',0],
  ['between the 1st and the 9th','2026-10-01','2026-10-09',0],['since Monday','2026-11-02','2026-11-03',0],
  ['until Friday','2026-10-01','2026-10-30',1700],['after Tuesday','2026-10-28','2026-10-31',0]])
  for(const mixed of ['', ' before the 20th',' through the 21st',' since Wednesday',' until Thursday',' in 2025'])
   residueCases.push({q:`Show expenses ${month} 2026 ${tail}${mixed}`,from,to,cents});
assert.equal(residueCases.length,360);
for(let start=0;start<residueCases.length;start+=30) test(`C3 D generated residue ${start+1}-${start+30}`,async t=>{
 const f=setup(t);
 for(const {q,from,to,cents} of residueCases.slice(start,start+30)) {
  const peer=await ask(f,`Show expenses from ${from} to ${to}`,raw(intent()));
  assert.equal(peer.extraction,1);assert.equal(peer.body.ledger.total_minor,cents);
  assert.deepEqual([peer.body.ledger.from,peer.body.ledger.to],[from,to]);
  assert.ok(peer.sql.some(s=>s.includes('CROSS JOIN fin_transactions')));
  const r=await ask(f,q,raw(intent()));
  assert.equal(r.extraction,1,q);assert.equal(r.documents,0,q);
  assert.equal(r.body.ledger,undefined,q);assert.equal(r.body.evidence_gate.complete,false,q);
  assert.ok(r.body.gaps.some(g=>g.scope==='calendar'),q);
  assert.match(r.body.answer,/Unread calendar words:/,q);
  assert.equal(r.sql.length,0,q);
 }
 t.diagnostic('generated=30 refused=30 wrong=0');
});
