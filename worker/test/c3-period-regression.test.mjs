import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,ask,intent,raw} from './c3-calendar-scope-fixture.mjs';

test('C3 B1 mixed kinds bind the literal shared account before facts',async t=>{
 const f=setup(t),q='Could you retrieve Operating spending for sept and oct?';
 const peer=await ask(f,q,raw(intent('expense_summary',{account_hint:'Operating'}),intent('expense_summary',{account_hint:'Operating'})));
 assert.deepEqual(peer.body.ledger.parts.map(p=>p.expense_total_minor),[700,1200]);
 const r=await ask(f,q,raw(intent('merchant',{vendor_text:'Operating'}),intent()));
 assert.equal(r.extraction,1);assert.equal(r.documents,0);
 assert.ok(r.sql.some(s=>s.includes('CROSS JOIN fin_transactions')));
 assert.deepEqual(r.body.ledger.parts.map(p=>p.expense_total_minor),[700,1200]);
 assert.deepEqual(r.body.ledger.parts.map(p=>p.accounts.map(a=>a.account_mask)),[['1111'],['1111']]);
});
test('C3 B2 apostrophe four-digit year is consumed completely',async t=>{
 const f=setup(t),reply=raw(intent(),intent());
 const peer=await ask(f,'Compare expenses Oct 2025 versus Sep 2025',reply);
 assert.deepEqual(peer.body.ledger.parts.map(p=>p.expense_total_minor),[0,0]);
 const r=await ask(f,"Compare expenses Oct '2025 versus Sep '2025",reply);
 assert.equal(r.extraction,1);assert.equal(r.documents,0);
 assert.ok(r.sql.some(s=>s.includes('CROSS JOIN fin_transactions')));
 assert.deepEqual(r.body.ledger.parts.map(p=>p.expense_total_minor),[0,0]);
 assert.deepEqual(r.body.ledger.parts.map(p=>[p.from,p.to]),[['2025-10-01','2025-10-31'],['2025-09-01','2025-09-30']]);
});

import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
async function mutant(t,label,file,replacements,links={}) {
 const dir=mkdtempSync(join(tmpdir(),'brain-c3-c-mutant-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let source=readFileSync(new URL(`../src/lib/${file}`,import.meta.url),'utf8');
 for(const [before,after] of replacements){assert.ok(source.includes(before),`${label}: site exists`);source=source.replace(before,after);}
 source=source.replace(/from (["'])(\.\/[^"']+)\1/g,(_,q,p)=>`from ${q}${links[p]||new URL(`../src/lib/${p.slice(2)}`,import.meta.url).href}${q}`);
 const path=join(dir,`${label}.mjs`);writeFileSync(path,source);
 assert.ok(replacements.every(([,after])=>source.includes(after)),'mutant bytes written');
 const href=pathToFileURL(path).href;return {api:await import(href),href};
}

test('C3 B1 mutant mixed-kind-preflight-omission makes exact numeric oracle red',async t=>{
 const f=setup(t),q='Could you retrieve Operating spending for sept and oct?';
 const reply=raw(intent('merchant',{vendor_text:'Operating'}),intent());
 const oracle=r=>assert.deepEqual(r.body.ledger.parts.map(p=>p.expense_total_minor),[700,1200]);
 oracle(await ask(f,q,reply));
 const m=await mutant(t,'mixed-kind-preflight-omission','ledger-answer.js',[
  ['(decision?.scopePlan || decision?.operandClauses)','decision?.scopePlan'],
 ]);
 const bad=await ask(f,q,reply,m.api.withLedgerAnswer);
 assert.equal(bad.extraction,1);assert.ok(bad.sql.some(s=>s.includes('CROSS JOIN fin_transactions')));
 assert.deepEqual(bad.body.ledger.parts.map(p=>p.expense_total_minor),[700,1700]);
 assert.throws(()=>oracle(bad),assert.AssertionError);
 const peer=await ask(f,q,raw(intent('expense_summary',{account_hint:'Operating'}),intent('expense_summary',{account_hint:'Operating'})),m.api.withLedgerAnswer);
 oracle(peer);
});
test('C3 B2 mutant four-digit-year-dropping makes exact calendar oracle red',async t=>{
 const f=setup(t),q="Compare expenses Oct '2025 versus Sep '2025",reply=raw(intent(),intent());
 const oracle=r=>assert.deepEqual(r.body.ledger.parts.map(p=>p.from),['2025-10-01','2025-09-01']);
 oracle(await ask(f,q,reply));
 const calendar=await mutant(t,'four-digit-year-dropping','ledger-intent-calendar.js',[
  ["(_, month, year) => `${month} ${year.length === 2 ? '20' : ''}${year}`",'(_, month, year) => year.length === 4 ? month : `${month} 20${year}`'],
 ]);
 const compiler=await mutant(t,'four-digit-compiler','ledger-intent.js',[],{'./ledger-intent-calendar.js':calendar.href});
 const answer=await mutant(t,'four-digit-answer','ledger-answer.js',[],{'./ledger-intent.js':compiler.href});
 const bad=await ask(f,q,reply,answer.api.withLedgerAnswer);
 assert.equal(bad.extraction,1);assert.ok(bad.sql.some(s=>s.includes('CROSS JOIN fin_transactions')));
 assert.deepEqual(bad.body.ledger.parts.map(p=>p.expense_total_minor),[1700,700]);
 assert.throws(()=>oracle(bad),assert.AssertionError);
 oracle(await ask(f,'Compare expenses Oct 2025 versus Sep 2025',reply,answer.api.withLedgerAnswer));
});

test('C3 B1 unresolved literal scopes refuse both mixed-kind operands',async t=>{
 const f=setup(t),q='Could you retrieve Operating spending for sept and oct?';
 const reply=raw(intent('merchant',{vendor_text:'Operating'}),intent());
 const green=await ask(f,q,reply);assert.deepEqual(green.body.ledger.parts.map(p=>p.expense_total_minor),[700,1200]);
 // The permissive recognition sees a candidate, but exact inventory resolution
 // cannot bind the asked literal. No broad second operand may survive.
 f.raw("UPDATE fin_accounts SET label='Operating Checking' WHERE account_slug='main'");
 const refused=await ask(f,q,reply);assert.equal(refused.extraction,1);
 assert.ok(refused.sql.some(s=>s.includes('FROM fin_accounts a')));
 assert.ok(!refused.sql.some(s=>s.includes('CROSS JOIN fin_transactions')));
 assert.equal(refused.body.ledger.kind,'scope_refused');assert.equal(refused.body.ledger.reason,'scope_unresolved');
 assert.equal(refused.body.ledger.total_minor,undefined);
});

test('C3 B2 explicit calendar residue has a scoped gap and a numeric peer',async t=>{
 const f=setup(t),reply=raw(intent(),intent());
 for(const suffix of ["'2025x",'\u20192025x',"'20255",'2025x','2025-foo',"'2025 '2024",'2025 in 2024',"'27",'\u201927']) {
  const peer=await ask(f,'Compare expenses Oct 2025 versus Sep 2025',reply);
  assert.ok(peer.sql.some(s=>s.includes('CROSS JOIN fin_transactions')));
  assert.deepEqual(peer.body.ledger.parts.map(p=>p.expense_total_minor),[0,0]);
  const q=`Compare expenses Oct ${suffix} versus Sep 2025`,r=await ask(f,q,reply);
  assert.equal(r.extraction,1,q);assert.equal(r.documents,0,q);
  assert.equal(r.body.ledger,undefined,q);assert.ok(r.body.gaps.length>0,q);
  assert.equal(r.body.evidence_gate.complete,false,q);assert.equal(r.sql.length,0,q);
 }
});

import {TEST_COMMANDS,POST_LAUNCHER_TEST_COMMANDS} from '../../scripts/run-test-chain.mjs';
test('C3 period suites are registered in both chains and four omission mutants fail',()=>{
 const paths=['worker/test/c3-period-regression.test.mjs','worker/test/c3-period-generated.test.mjs'];
 const check=commands=>{for(const p of paths)assert.equal(commands.filter(c=>c===`node --test ${p}`).length,1,p);};
 for(const commands of [TEST_COMMANDS,POST_LAUNCHER_TEST_COMMANDS]) {
  check(commands);
  for(const p of paths) {
   const mutant=commands.filter(c=>c!==`node --test ${p}`);
   assert.equal(mutant.length,commands.length-1);
   assert.throws(()=>check(mutant),assert.AssertionError);
  }
 }
});

test('C3 B1 absent shared literal cannot leave a whole-owner second operand',async t=>{
 const f=setup(t),q='Could you retrieve Operating spending for sept and oct?';
 const reply=raw(intent('merchant',{vendor_text:'Operating'}),intent());
 const peer=await ask(f,q,reply);assert.deepEqual(peer.body.ledger.parts.map(p=>p.expense_total_minor),[700,1200]);
 f.raw("UPDATE fin_accounts SET label='Another Fund' WHERE account_slug='main'");
 const r=await ask(f,q,reply);assert.equal(r.extraction,1);
 assert.ok(r.sql.some(s=>s.includes('FROM fin_accounts a')));
 assert.equal(r.body.ledger.kind,'scope_refused');
 assert.ok(!r.sql.some(s=>s.includes('CROSS JOIN fin_transactions')));
});

test('C3 B1 mutant unresolved-shared-literal-widening makes refusal oracle red',async t=>{
 const f=setup(t),q='Could you retrieve Operating spending for sept and oct?';
 const reply=raw(intent('merchant',{vendor_text:'Operating'}),intent());
 const peer=await ask(f,q,reply);assert.deepEqual(peer.body.ledger.parts.map(p=>p.expense_total_minor),[700,1200]);
 f.raw("UPDATE fin_accounts SET label='Another Fund' WHERE account_slug='main'");
 const oracle=r=>assert.equal(r.body.ledger.kind,'scope_refused');
 oracle(await ask(f,q,reply));
 const scope=await mutant(t,'unresolved-shared-literal-widening','ledger-intent-scope.js',[
  ['if (unresolvedShared) return null;','if (false) return null;'],
 ]);
 const answer=await mutant(t,'unresolved-shared-answer','ledger-answer.js',[],{'./ledger-intent-scope.js':scope.href});
 const bad=await ask(f,q,reply,answer.api.withLedgerAnswer);
 assert.equal(bad.extraction,1);assert.ok(bad.sql.some(s=>s.includes('CROSS JOIN fin_transactions')));
 assert.equal(bad.body.ledger.parts[1].expense_total_minor,1700);
 assert.throws(()=>oracle(bad),assert.AssertionError);
});

test('C3 B2 bare short years cannot default a quarter or month',async t=>{
 const f=setup(t);
 for(const q of ['Could you retrieve expenses Q3 25','Could you retrieve expenses in 25']) {
  const peer=await ask(f,'Could you retrieve expenses Q3 2025',raw(intent()));
  assert.equal(peer.body.ledger.total_minor,0);assert.ok(peer.sql.some(s=>s.includes('CROSS JOIN fin_transactions')));
  const r=await ask(f,q,raw(intent()));assert.equal(r.extraction,1);
  assert.equal(r.body.ledger,undefined,q);assert.equal(r.documents,0,q);assert.ok(r.body.gaps.length>0,q);
 }
});

test('C3 B2 unsupported calendar tokens cannot disappear into defaults',async t=>{
 const f=setup(t);
 for(const tail of ['Oct.2025','October2025','in 2025x','10/2025','2025-10-10x','third quarter 2025x']) {
  const peer=await ask(f,'Could you retrieve expenses Oct 2025',raw(intent()));
  assert.equal(peer.body.ledger.total_minor,0);assert.ok(peer.sql.some(s=>s.includes('CROSS JOIN fin_transactions')));
  const r=await ask(f,`Could you retrieve expenses ${tail}`,raw(intent()));
  assert.equal(r.extraction,1);assert.equal(r.documents,0,tail);
  assert.equal(r.body.ledger,undefined,tail);assert.ok(r.body.gaps.some(g=>g.scope==='calendar'),tail);
 }
});
