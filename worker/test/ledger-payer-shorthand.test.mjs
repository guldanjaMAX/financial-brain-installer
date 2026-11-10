import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { recordedIntent } from './fixtures/ledger-intent-cases.mjs';
import { readFileSync } from 'node:fs';
const url = new URL('../src/lib/ledger-answer.js', import.meta.url);
const source = readFileSync(url, 'utf8').replace('async function withParsedLedgerAnswer(', 'export async function withParsedLedgerAnswer(')
 .replace(/from (["'])(\.\.?\/[^"']+)\1/g, (_, q, p) => `from ${q}${new URL(p, url).href}${q}`);
const { withParsedLedgerAnswer } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
async function parsed(f, extra = {}) {
 return (await withParsedLedgerAnswer({env:f.env, now:Date.parse('2026-10-12T12:00:00Z'), grantScope:{all:true}, scopePrincipalKind:'owner'}, async()=>Response.json({}),
 {broad:true,kind:'payment',direction:'inflow',timeZone:'UTC',mask:null,accountKind:null,from:'2026-09-08',to:'2026-09-22',amountMinor:null,counterpartyWords:['cedar'],...extra})).json();
}
test('payer description positives quote an assumption in payment and income readers', async t => {
 const f=ledgerFixture(t); f.add('one','CEDAR PAYMENT',null,{date:'2026-09-15',cents:391682});
 for(const extra of [{},{kind:'merchant',match:'Cedar',matchType:'merchant'}]) {
  const b=await parsed(f,extra); assert.equal(b.ledger.found,true); assert.match(b.answer,/Assum.*"CEDAR PAYMENT"/);
 }
});
test('unrecognized payer labels cannot prove absence or zero', async t=>{
 const f=ledgerFixture(t); f.add('one','PROCESSOR CREDIT',null,{date:'2026-09-15',cents:391682});
 for(const extra of [{},{kind:'merchant',match:'Cedar',matchType:'merchant'}]) {
  const b=await parsed(f,extra); assert.equal(b.ledger.found,null); assert.equal(b.ledger.total_minor,null);
 }
});
test('near cents within three days are possible only, with requested amount and account window',async t=>{
 const f=ledgerFixture(t); f.add('near','DEPOSIT',null,{date:'2026-09-18',cents:391682});
 f.add('far','DEPOSIT',null,{date:'2026-09-19',cents:391683});
 const b=await parsed(f,{amountMinor:391681,counterpartyWords:[],nearDate:'2026-09-15'});
 assert.equal(b.ledger.found,false); assert.equal(b.ledger.match_count,0);
 assert.match(b.answer,/No matching deposit.*amount.*\$3,916\.81/);
 assert.match(b.answer,/Possible.*\$3,916\.82/); assert.doesNotMatch(b.answer,/\$3,916\.83/);
 assert.match(b.answer,/1234/); assert.match(b.answer,/Sep/);
});
test('empty amount lookup names the requested amount',async t=>{
 const f=ledgerFixture(t); const b=await parsed(f,{amountMinor:391681,counterpartyWords:[]});
 assert.equal(b.ledger.found,false); assert.match(b.answer,/No matching deposit.*amount.*\$3,916\.81/);
});
test('literal payer month and year questions enter the ledger',async t=>{
 const f=ledgerFixture(t); f.add('one','CEDAR PAYMENT',null,{date:'2026-09-15',cents:391682});
 for(const q of ['Did Cedar pay me in September 2026?','How much did Cedar send me this year?']) {
  const b=await f.ask(q); assert.ok(b.ledger,q); assert.match(b.answer,/3,916\.82/); assert.match(b.answer,/Assum.*"CEDAR PAYMENT"/);
 }
});

test('both-direction public router preserves unidentified deposit uncertainty', async t => {
 const f = ledgerFixture(t); f.add('one','CED PAYMENT',null,{date:'2026-09-15',cents:10001});
 f.env.RERANK_MODEL='claude-haiku-4-5-20251001';
 f.env.ANTHROPIC_API_KEY=(await import('node:crypto')).randomBytes(24).toString('hex');
 let calls = 0;
 const b = await (await withLedgerAnswer({ env:f.env, now:'2026-10-12T12:00:00Z',
  question:'Could you retrieve Cedar transactions in September 2026?', grantScope:{all:true}, scopePrincipalKind:'owner',
  callLLM:async()=>{ calls++; return {content:[{type:'text',text:JSON.stringify({intents:[recordedIntent('payment',
   {direction:'both',vendor_text:'Cedar',period:{type:'last_month'}})]})}]}; }
 },async()=>Response.json({route:'documents'}))).json();
 assert.equal(calls,1); assert.equal(b.ledger.kind,'payment');
 assert.equal(b.ledger.found,null); assert.equal(b.ledger.complete,false);
 assert.equal(b.ledger.inflow_count,1,'decision point has the deposit');
 assert.doesNotMatch(b.answer,/no matching|found no/i);
});

// Seed 0x428b07: cross every supported direction with exact, different and
// absent amount constraints. Each negative has a same-row structured control.
test('seeded payer uncertainty table crosses direction and amount selection', async t => {
 const f=ledgerFixture(t); let seed=0x428b07;
 const next=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
 for(const direction of ['inflow','both','outflow']) for(const amountMode of ['none','exact','different'])
 for(const description of ['CED PAYMENT','PROCESSOR CREDIT','CEDARWOOD REFUND','PAYMENT FOR CEDAR']) {
  const cents=10001+next()%90000;
  const extra={direction,amountMinor:amountMode==='none'?null:amountMode==='exact'?cents:cents+1,
   nearDate:'2026-09-15',counterpartyWords:['cedar']};
  f.raw('DELETE FROM fin_transactions');
  f.add('unknown',description,null,{date:'2026-09-15',cents});
  if(amountMode==='different') f.add('other','BIRCH PAYMENT','Birch',
   {date:'2026-09-15',cents:extra.amountMinor});
  const b=await parsed(f,extra);
  assert.equal(b.ledger.kind,'payment'); assert.equal(b.ledger.amount_minor,extra.amountMinor);
  assert.equal(b.ledger.from,'2026-09-08'); assert.equal(b.ledger.accounts.length,1);
  if(direction==='outflow') {
   assert.equal(b.ledger.found,amountMode==='none'?false:null,'inflows cannot establish a named outflow payment');
  } else if(amountMode!=='none') {
   assert.equal(b.ledger.found,null); assert.equal(b.ledger.total_minor,null);
   assert.equal(b.ledger.complete,false);
   assert.ok((b.ledger.amount_candidates||[]).every(row=>row.amount_minor===extra.amountMinor));
   if(amountMode==='different') assert.doesNotMatch(b.answer,new RegExp((cents/100).toFixed(2).replace('.', '\\.')));
  } else {
   assert.equal(b.ledger.found,null,'covered payment decision must preserve payer uncertainty');
   assert.equal(b.ledger.inflow_count,amountMode==='different'?2:1,'uncertainty decision reached');
   assert.ok(b.ledger.inflows.some(row=>row.amount_minor===cents));
   assert.equal(b.citations[0].posted_on,'2026-09-15');
   assert.equal(b.ledger.found,null); assert.equal(b.ledger.total_minor,null);
   assert.equal(b.ledger.complete,false); assert.equal(b.ledger.attribution_incomplete,true);
   assert.doesNotMatch(b.answer,/no matching|found no/i);
  }
  f.raw('DELETE FROM fin_transactions');
  // Every table row proves that an exact identified transaction still answers.
  f.add('control','CEDAR PAYMENT','Cedar',{date:'2026-09-15',cents:extra.amountMinor??cents,
   direction:direction==='outflow'?'outflow':'inflow'});
  const control=await parsed(f,extra);
  assert.equal(control.ledger.found,true); assert.equal(control.ledger.match_count,1);
  f.raw('DELETE FROM fin_transactions');
  const empty=await parsed(f,extra);
  assert.equal(empty.ledger.found,amountMode==='none'?false:null,'empty named exact lookup preserves identity uncertainty');
 }
 t.diagnostic('seed=0x428b07 rows=36 uncertain=24 positive_controls=36 empty_controls=36 outflow_controls=12');
});

test('named exact receipt survives nearby alternatives without showing other amounts', async t=>{
 const f=ledgerFixture(t);
 f.add('exact','CEDAR PAYMENT','Cedar',{date:'2026-09-15',cents:10000});
 f.add('near','CEDAR PAYMENT','Cedar',{date:'2026-09-15',cents:10001});
 const b=await parsed(f,{amountMinor:10000,nearDate:'2026-09-15'});
 assert.equal(b.ledger.found,true); assert.equal(b.ledger.match_count,1);
 assert.match(b.answer,/\$100\.00/); assert.doesNotMatch(b.answer,/100\.01/);
});

test('isolated product mutations are killed by payer regressions', async t => {
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
 const {spawnSync}=await import('node:child_process');
 const dir=mkdtempSync(join(tmpdir(),'payer-struct-mutants-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const original=readFileSync(new URL(import.meta.url),'utf8').split("test('isolated product mutations")[0];
 const rewriteCopy = copy => copy
  .replace(/from (["'])(\.\.?\/[^"']+)\1/g,(_,q,p)=>`from ${q}${new URL(p,import.meta.url).href}${q}`)
  .replaceAll('import.meta.url',JSON.stringify(import.meta.url));
 const env=Object.fromEntries(['SystemRoot','TEMP','TMP','PATH'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
 const controlPath=join(dir,'control.mjs'); writeFileSync(controlPath,rewriteCopy(original));
 const control=spawnSync(process.execPath,['--test',controlPath],{env,encoding:'utf8',timeout:60000});
 assert.equal(control.status,0,'unmodified copied harness must pass: '+control.stdout+control.stderr);
 for(const [name,from,to] of [
  ['both direction uncertainty dropped',"searchDirection !== 'outflow' && !matched.length", "searchDirection === 'inflow' && !matched.length"],
  ['named exact lookup widened','!intent.counterpartyWords.length && intent.amountMinor !== null', 'intent.amountMinor !== null'],
  ['note dropped','const payerAssumptionNote = rows => rows.filter(row => payerAttributionBasis(row) === "description_assumption")', 'const payerAssumptionNote = rows => rows.filter(row => false)'],
  ['shorthand supports absence','kind: "payment", found: null, total_minor: null','kind: "payment", found: false, total_minor: 0'],
  ['near miss offered as the match','row.amount_minor !== intent.amountMinor)) return false;', 'Math.abs(row.amount_minor - intent.amountMinor) > 100)) return false;'],
  ['absence without the amount','for requested amount ${money(intent.amountMinor)}','for requested amount'],
 ]) {
  assert.ok(source.includes(from),name+' mutation applies');
  const copy=rewriteCopy(original.replace("const source =",'let source =').replace('const { withParsedLedgerAnswer }',`source = source.replace(${JSON.stringify(from)}, ${JSON.stringify(to)});\nconst { withParsedLedgerAnswer }`));
  const path=join(dir,name.replaceAll(' ','-')+'.mjs');writeFileSync(path,copy);
  const result=spawnSync(process.execPath,['--test',path],{env,encoding:'utf8',timeout:60000});
  assert.equal(result.status,1,name+' must turn tests red');
  assert.match(result.stdout+result.stderr,/AssertionError/);
  assert.doesNotMatch(result.stdout+result.stderr,/ERR_MODULE_NOT_FOUND|SyntaxError/);
  t.diagnostic(name+': killed');
 }
 // A broken copy must fail the clean-control decision before any product
 // mutant can claim a kill from unrelated module-loading failures.
 const harness=readFileSync(new URL(import.meta.url),'utf8');
 const broken=harness.replace(/const rewriteCopy = copy => copy[\s\S]+?;\n/,
  'const rewriteCopy = copy => copy;\n');
 assert.notEqual(broken,harness,'copied import rewrite dropped mutation applies');
 const harnessPath=join(dir,'harness-mutant.mjs');writeFileSync(harnessPath,rewriteCopy(broken));
 const harnessResult=spawnSync(process.execPath,['--test','--test-name-pattern=isolated product mutations',harnessPath],
  {env,encoding:'utf8',timeout:60000});
 assert.equal(harnessResult.status,1);
 assert.match(harnessResult.stdout+harnessResult.stderr,/unmodified copied harness must pass/);
 assert.match(harnessResult.stdout+harnessResult.stderr,/ERR_MODULE_NOT_FOUND/);
 t.diagnostic('copied import rewrite dropped: killed');
});
test('named exact amount lookup keeps its requested amount and withholds different amounts',async t=>{
 const f=ledgerFixture(t);
 const empty=await parsed(f,{amountMinor:391681}); assert.match(empty.answer,/No deposit of \$3,916\.81/);
 f.add('one','CEDAR PAYMENT',null,{date:'2026-09-15',cents:391682});
 const b=await parsed(f,{amountMinor:391681,nearDate:'2026-09-15'});
 assert.equal(b.ledger.found,null); assert.match(b.answer,/No deposit of \$3,916\.81/); assert.doesNotMatch(b.answer,/3,916\.82/);
});
test('literal how-much payer question returns the named-income subtotal',async t=>{
 const f=ledgerFixture(t); f.add('one','CEDAR PAYMENT','Cedar',{date:'2026-09-15',cents:100});
 f.add('two','CEDAR PAYMENT','Cedar',{date:'2026-09-16',cents:200});
 const b=await f.ask('How much did Cedar send me this year?');
 assert.equal(b.ledger.attributed_subtotal_minor,300); assert.match(b.answer,/\$3\.00/);
});
test('nearby receipt boundaries preserve exact match identity', async t=>{
 const f=ledgerFixture(t);
 for(const [id,date,cents] of [['exact','2026-09-15',10000],['lower','2026-09-12',9900],['upper','2026-09-18',10100],['outside','2026-09-15',10101]])
  f.add(id,'CEDAR PAYMENT','Cedar',{date,cents});
 const b=await parsed(f,{amountMinor:10000,nearDate:'2026-09-15',counterpartyWords:[]});
 assert.equal(b.ledger.found,true);assert.equal(b.ledger.match_count,1);
 assert.match(b.answer,/Found a deposit of \$100\.00/);
 assert.match(b.answer,/Possible nearby deposit.*\$99\.00/);assert.match(b.answer,/Possible nearby deposit.*\$101\.00/);
 assert.doesNotMatch(b.answer,/101\.01|Assuming/);
});
test('literal payer aliases preserve calendar and residual constraints',async()=>{
 const {classifyLedgerQuestion}=await import('../src/lib/ledger-question.js');
 const options={now:Date.parse('2026-10-12T12:00:00Z'),timeZone:'UTC'};
 assert.equal(classifyLedgerQuestion('Did Cedar pay me in September?',options).from,'2026-09-01');
 for(const q of ['Did Cedar pay me in September 2026 except weekends?','Did Cedar pay me in September 2026 and October 2026?','Did someone pay me in September 2026?'])
  assert.equal(classifyLedgerQuestion(q,options).kind,null,q);
 const unknown=classifyLedgerQuestion('How much did Cedar send me this year?',{...options,timeZone:null});
 assert.equal(unknown.ownerTimeZoneUnavailable,true);assert.equal(unknown.from,undefined);
});
test('description-only zero rows cannot establish payer payment or zero income', async t=>{
 const f=ledgerFixture(t); f.add('zero','CEDAR PAYMENT',null,{date:'2026-09-15',cents:0});
 for(const extra of [{},{kind:'merchant',match:'Cedar',matchType:'merchant'}]) {
  const b=await parsed(f,extra); assert.equal(b.ledger.found,null);
  assert.equal(b.ledger.total_minor,null); assert.equal(b.ledger.attributed_subtotal_minor??null,null);
 }
 const amountOnly=await parsed(f,{amountMinor:0,counterpartyWords:[]});
 assert.equal(amountOnly.ledger.found,true,'a zero-dollar bank record remains observable without payer attribution');
});

