import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ask, intent, raw, context } from './c3-calendar-scope-fixture.mjs';
import { validateLedgerIntentDecision } from '../src/lib/ledger-intent.js';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const matrix = [
  ['Could you retrieve LABEL spending for sept and oct?', 'merchant', [700,1200], ['2026-09','2026-10']],
  ['Compare LABEL expenses September versus October', 'merchant', [700,1200], ['2026-09','2026-10']],
  ['LABEL spending Sept against Oct please', 'merchant', [700,1200], ['2026-09','2026-10']],
  ['Show LABEL expenses Sep plus Oct', 'merchant', [700,1200], ['2026-09','2026-10']],
  ['Compare LABEL spending this q vs last q', 'merchant', [1200,700], ['2026-10','2026-07']],
  ['Could you compare LABEL expenses Oct vs Sept?', 'merchant', [1200,700], ['2026-10','2026-09']],
  ["Compare expenses in Oct '25 versus Sep '25", 'year', [0,0], ['2025-10','2025-09']],
  ['Compare expenses in Oct \u201925 versus Sep \u201925', 'year', [0,0], ['2025-10','2025-09']],
  ['Compare expenses October 2025 versus September 2025', 'year', [0,0], ['2025-10','2025-09']],
  ["Spending for Sept '25 versus Oct '25 please", 'year', [0,0], ['2025-09','2025-10']],
  ["Show expenses Sep '25 plus Oct '25", 'year', [0,0], ['2025-09','2025-10']],
  ['Could you compare spending Oct vs Sept?', 'current', [1700,700], ['2026-10','2026-09']],
];
for (const [index,[template,kind,expected,windows]] of matrix.entries()) test(`C3 final paraphrase ${index+1}`, async t=>{
  const f=setup(t), label=index%2 ? 'Daily Fund' : 'Working Cash';
  f.raw("UPDATE fin_accounts SET label=? WHERE account_slug='main'",label);
  f.raw("UPDATE fin_accounts SET institution=CASE WHEN entity_slug='store' THEN 'Synthetic North Bank' ELSE 'Synthetic South Bank' END");
  // Deliberately permute the actual SQLite reply, rather than predicting order.
  const batch=f.env.DB.batch;
  if(index%2) f.env.DB.batch=async statements=>{
    const out=await batch(statements);
    for(let i=0;i<statements.length;i++) if(statements[i].sql.includes('CROSS JOIN fin_transactions')) out[i].results.reverse();
    return out;
  };
  const q=template.replace('LABEL',label), v=kind==='merchant'?intent('merchant',{vendor_text:label}):intent();
  const r=await ask(f,q,raw(v,v)); reached(r);
  assert.deepEqual(r.body.ledger.parts.map(p=>p.expense_total_minor),expected);
  assert.deepEqual(r.body.ledger.parts.map(p=>p.from.slice(0,7)),windows);
  const exactWindows=windows.map(month=>[`${month}-01`,month==='2026-07'?'2026-09-30':index===4 && month==='2026-10'?'2026-11-03':`${month}-${month.endsWith('-09')?'30':'31'}`]);
  assert.deepEqual(r.body.ledger.parts.map(p=>[p.from,p.to]),exactWindows);
  assert.equal(r.body.ledger.comparison.difference_minor,expected[0]-expected[1]);
  assert.ok(r.body.ledger.parts.every(p=>p.complete && p.operand_coverage.complete));
  const masks=kind==='merchant'?['1111']:['4444','1111','2222','3333'];
  for(const part of r.body.ledger.parts) {
    assert.deepEqual(part.accounts.map(a=>a.account_mask),masks);
    const selected=f.rows(`SELECT account_slug FROM fin_accounts WHERE mask IN (${masks.map(()=>'?').join(',')}) ORDER BY account_slug`,...masks).map(a=>a.account_slug);
    assert.deepEqual(selected,kind==='merchant'?['main']:['main','personal','reserve','supply-main']);
  }
  // Independent SQLite integer facts identify contributors; no production
  // classifier supplies expected amounts or references.
  const expectedRefs=f.rows("SELECT id FROM fin_transactions WHERE direction='outflow' AND (? IS NULL OR account_slug=?) AND posted_on BETWEEN ? AND ?",kind==='merchant'?'main':null,kind==='merchant'?'main':null,r.body.ledger.parts[0].from,r.body.ledger.parts[0].to).map(row=>`ledger:transaction:${row.id}`).sort();
  const actualRefs=r.body.citations.filter(c=>c.posted_on>=r.body.ledger.parts[0].from && c.posted_on<=r.body.ledger.parts[0].to && c.amount_minor<5000).map(c=>c.ref).sort();
  assert.deepEqual(actualRefs,expectedRefs);
  assert.match(r.body.answer,/first minus second/);
  if(kind==='year') assert.match(r.body.answer,/2025/);
  const peer=kind==='merchant'?intent('expense_summary',{account_hint:label}):intent();
  const peerQuestion=kind==='year'?q.replace(/['\u2019]25/g,'2025'):q;
  const control=await ask(f,peerQuestion,raw(peer,peer));reached(control);
  assert.deepEqual(control.body.ledger.parts.map(p=>p.expense_total_minor),expected);
});

for(const quote of ["'",'\u2019']) test(`C3 final future abbreviated year ${quote.codePointAt(0)} refuses after calendar decision`,async t=>{
  const f=setup(t), reply=raw(intent(),intent());
  const green=await ask(f,`Compare expenses Oct ${quote}25 versus Sep ${quote}25`,reply); reached(green);
  assert.equal(green.body.ledger.comparison.difference_minor,0);
  const q=`Compare expenses Oct ${quote}27 versus Sep ${quote}25`;
  const d=validateLedgerIntentDecision(reply,q,context);
  assert.equal(d.outcome,'fallback'); assert.equal(d.reason,'period_contradiction');
  const r=await ask(f,q,reply); assert.equal(r.extraction,1); assert.equal(r.sql.length,0); assert.equal(r.body.ledger,undefined);
});

async function mutant(t,label,file,replacements,links={}) {
  const dir=mkdtempSync(join(tmpdir(),'brain-c3-mutant-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let source=readFileSync(new URL(`../src/lib/${file}`,import.meta.url),'utf8');
  for(const [before,after] of replacements) {assert.ok(source.includes(before),`${label}: mutation site reached`);source=source.replace(before,after);}
  source=source.replace(/from (["'])(\.\/[^"']+)\1/g,(_,q,p)=>`from ${q}${links[p] || new URL(`../src/lib/${p.slice(2)}`,import.meta.url).href}${q}`);
  const path=join(dir,`${label}.mjs`);writeFileSync(path,source);
  assert.ok(replacements.length===0 || replacements.every(([,after])=>source.includes(after)),'mutation bytes written');
  return {api:await import(pathToFileURL(path).href),href:pathToFileURL(path).href};
}
test('C3 final restoring late scope bypass is killed by exact selection and amount oracles',async t=>{
  const f=setup(t),q=matrix[0][0].replace('LABEL','Operating'),v=intent('merchant',{vendor_text:'Operating'}),reply=raw(v,v);
  const green=await ask(f,q,reply);reached(green);assert.equal(green.body.ledger.comparison.difference_minor,-500);
  const m=await mutant(t,'scope-bypass','ledger-answer.js',[
    ["if (!decision.scopePlan || decision.scopePlan.type === 'operands') {","if (false) {"],
    ["if (decision.operandClauses && (!decision.scopePlan || decision.scopePlan.type === 'operands')) {", 'if (false) {'],
    ['if (recognizeLiteralAccount(inventory, intent, intent.presentation, protectedPayee) && intent.scopePlan) {','if (recognizeLiteralAccount(inventory, intent, intent.presentation, protectedPayee) && false) {'],
  ]);
  const bad=await ask(f,q,reply,m.api.withLedgerAnswer);reached(bad);
  assert.deepEqual(bad.body.ledger.parts.map(p=>p.expense_total_minor),[700,1700]);
  assert.equal(bad.body.ledger.comparison.difference_minor,-1000);
  assert.throws(()=>assert.deepEqual(bad.body.ledger.parts.map(p=>p.accounts.map(a=>a.account_mask)),[['1111'],['1111']]));
  assert.throws(()=>assert.equal(bad.body.ledger.comparison.difference_minor,-500));
});
test('C3 final restoring year dropping is killed while four-digit peer stays green',async t=>{
  const f=setup(t),reply=raw(intent(),intent()),q="Compare expenses Oct '25 versus Sep '25";
  const green=await ask(f,q,reply);reached(green);assert.equal(green.body.ledger.comparison.difference_minor,0);
  const calendar=await mutant(t,'year-drop','ledger-intent-calendar.js',[
    ["(_, month, year) => `${month} ${year.length === 2 ? '20' : ''}${year}`",'(_, month, year) => `${month}`'],
  ]);
  const compiler=await mutant(t,'year-compiler','ledger-intent.js',[],{'./ledger-intent-calendar.js':calendar.href});
  const answer=await mutant(t,'year-answer','ledger-answer.js',[],{'./ledger-intent.js':compiler.href});
  const bad=await ask(f,q,reply,answer.api.withLedgerAnswer);reached(bad);
  assert.deepEqual(bad.body.ledger.parts.map(p=>p.expense_total_minor),[1700,700]);
  assert.throws(()=>assert.equal(bad.body.ledger.parts[0].from,'2025-10-01'));
  const peer=await ask(f,'Compare expenses Oct 2025 versus Sep 2025',reply,answer.api.withLedgerAnswer);reached(peer);
  assert.deepEqual(peer.body.ledger.parts.map(p=>p.expense_total_minor),[0,0]);
});

function reached(r) {
  assert.equal(r.extraction,1); assert.equal(r.documents,0);
  assert.ok(r.sql.some(sql=>sql.includes('FROM fin_accounts a')),'inventory reached');
  assert.ok(r.sql.some(sql=>sql.includes('CROSS JOIN fin_transactions')),'real rows reached');
  assert.equal(r.body.ledger.parts.length,2);
}
test('C3 final R2-01 literal merchant account must narrow both operands', async t=>{
  const f=setup(t), q='Could you retrieve Operating spending for sept and oct?';
  const scoped=intent('expense_summary',{account_hint:'Operating'});
  const green=await ask(f,q,raw(scoped,scoped)); reached(green);
  assert.deepEqual(green.body.ledger.parts.map(p=>p.expense_total_minor),[700,1200]);
  const merchant=intent('merchant',{vendor_text:'Operating'}), reply=raw(merchant,merchant);
  assert.equal(validateLedgerIntentDecision(reply,q,context).intents.length,2,'nonempty plan');
  const r=await ask(f,q,reply); assert.ok(r.body.ledger?.parts,JSON.stringify(r.body)); reached(r);
  assert.deepEqual(r.body.ledger.parts.map(p=>p.accounts.map(a=>a.account_mask)),[['1111'],['1111']]);
  assert.deepEqual(r.body.ledger.parts.map(p=>p.expense_total_minor),[700,1200]);
  assert.equal(r.body.ledger.comparison.difference_minor,-500);
});
test('C3 final R3-01 apostrophe years remain part of the calendar operand',async t=>{
  const f=setup(t), reply=raw(intent(),intent());
  const green=await ask(f,'Compare expenses in Oct 2025 versus Sep 2025',reply); reached(green);
  assert.deepEqual(green.body.ledger.parts.map(p=>p.expense_total_minor),[0,0]);
  const r=await ask(f,"Compare expenses in Oct '25 versus Sep '25",reply); reached(r);
  assert.deepEqual(r.body.ledger.parts.map(p=>[p.from,p.to]),[['2025-10-01','2025-10-31'],['2025-09-01','2025-09-30']]);
  assert.deepEqual(r.body.ledger.parts.map(p=>p.expense_total_minor),[0,0]);
  assert.equal(r.body.ledger.comparison.difference_minor,0);
});
