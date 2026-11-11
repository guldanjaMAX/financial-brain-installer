import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';

const families = [
  ['savings','savings',['Transfer to savings','ONLINE TRANSFER TO SAVINGS XXXX5678','ACH DEBIT OWNER SAVINGS CONTRIB']],
  ['brokerage','investment',['Transfer to investment','BROKERAGE CONTRIBUTION XXXX5678','ACH DEBIT OWNER BROKERAGE CONTRIB']],
  ['retirement','retirement',['Transfer to retirement','AUTOMATIC TRANSFER TO IRA XXXX5678','ACH DEBIT OWNER 401K CONTRIB']],
  ['escrow','escrow',['Transfer to escrow','WIRE TO OWNER ESCROW XXXX5678','ACH DEBIT OWNER ESCROW CONTRIB']],
  ['second-bank','checking',['Transfer to account 5678','ONLINE TRANSFER TO XXXX5678','WIRE TO ACCT 5678']],
  ['self-p2p','checking',['Transfer to self','ZELLE TO SELF XXXX5678','MOBILE TRANSFER TO SELF']],
  ['owner-draw','checking',['Transfer to personal','OWNER DRAW TO PERSONAL XXXX5678','WIRE OWNER DRAW TO PERSONAL']],
  ['owner-contribution','checking',['Transfer to business','OWNER CONTRIBUTION TO BUSINESS XXXX5678','ACH DEBIT OWNER BUSINESS CONTRIB']],
  ['card','card',['Transfer to credit card','CREDIT CARD PAYMENT XXXX5678','AUTOMATIC PAYMENT TO CREDIT CARD']],
  ['loan','loan',['Transfer to loan','LOAN PAYMENT SYNTHETIC LENDER XXXX5678','ACH DEBIT OWNER LOAN PAYMENT']],
];
const questions = [
  ['spent','How much did I spend this month?'],
  ['went-out','How much money went out this month?'],
  ['largest','What were my biggest expenses this month?'],
  ['recurring','What are my recurring charges?'],
  ['business','What did the business spend this month?'],
  ['category','How much did I spend on software this month?'],
  ['profit','What was my net income this month?'],
];
const dates = ['2026-08-05','2026-09-05','2026-10-05'];
// The oracle consumes intent-specific public figures, never raw gross appendices
// or the product's ownership classifier. Own membership is generator truth.
export function observe(body, surface) {
  const l = body.ledger;
  if (!l) return null;
  if (surface === 'largest') return l.kind === 'largest' && Array.isArray(l.lead_rows) ? l.lead_rows.reduce((n,r)=>n+r.amount_minor,0) : null;
  if (surface === 'profit') return Number.isSafeInteger(l.net_minor) ? -l.net_minor : null;
  if (surface === 'recurring') return Number.isSafeInteger(l.monthly_total_minor) ? l.monthly_total_minor : null;
  return Number.isSafeInteger(l.expense_total_minor) ? l.expense_total_minor : Number.isSafeInteger(l.total_minor) ? l.total_minor : null;
}
export function verdict(body, surface, expected, own) {
  const actual = observe(body,surface);
  if (process.env.OWN_MOVEMENT_ORACLE_MUTANT === 'include-own' && own) return 'RIGHT';
  if (process.env.OWN_MOVEMENT_ORACLE_MUTANT === 'exclude-merchant' && !own && actual === 0) return 'RIGHT';
  if (process.env.OWN_MOVEMENT_ORACLE_MUTANT === 'refuse-merchant' && !own && actual == null) return 'RIGHT';
  if (actual == null) return own ? 'WITHHELD' : 'OVER-REFUSAL';
  if (actual !== expected) return own ? 'WRONG' : actual < expected ? 'OVER-EXCLUSION' : 'WRONG';
  if (own && /(?:possible own transfer, not counted|excluded|left out|set aside)/i.test(body.answer || '')) return 'DISCLOSED-EXCLUSION';
  return 'RIGHT';
}
function seedValue(seed) { let x=seed|0; x^=x<<13; x^=x>>>17; x^=x<<5; return 100+(x>>>0)%90000; }

async function measure(t) {
  let network=0,model=0;
  t.mock.method(globalThis,'fetch',()=>{ network++; throw new Error('network forbidden'); });
  const f=ledgerFixture(t);
  f.owner('destination-owner');
  f.env.AI.run=async()=>{model++;throw new Error('model forbidden');};
  const stats={cases:0,matrix_cases:0,control_cases:0,families:10,wrong_figures:0,known_class_wrong:0,over_exclusions:0,over_refusals:0,verdicts:{},by_family:{},by_surface:{},shrunk:0,controls:0,network:0,model:0};
  const witnesses=[];
  function setup(c, cents=c.cents, keep=null) {
    f.raw('DELETE FROM fin_transactions');
    f.raw('UPDATE fin_entities SET kind=? WHERE entity_slug=\'owner\'',c.family==='owner-contribution'?'person':'business');
    f.raw('UPDATE fin_entities SET kind=? WHERE entity_slug=\'destination-owner\'',c.family==='owner-draw'?'person':'business');
    for(const table of ['fin_balance_snapshots','fin_account_coverage']) f.raw(`DELETE FROM ${table} WHERE account_slug='destination'`);
    f.raw("DELETE FROM fin_accounts WHERE account_slug='destination'");
    if(c.connection!=='no') {
      // Copy only synthetic fixture provenance; label is the exact endpoint for
      // each family's accepted transfer form, not an oracle ownership inference.
      f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,source_feed,basis_state,recorded_at)
        SELECT 'destination','destination-owner',?,?,'5678',? ,feed_mode,provenance,source_feed,basis_state,recorded_at FROM fin_accounts WHERE account_slug='fixture-account'`,c.kind,['card','loan'].includes(c.kind)?'liability':'asset',c.endpoint);
      f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at)
        SELECT 'destination',coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at FROM fin_account_coverage WHERE account_slug='fixture-account'`);
    }
    const ds=c.surface==='recurring'?dates:['2026-10-05'];
    const rows=ds.map((date,i)=>({uid:'out'+i,date,direction:'outflow'}));
    if(c.connection==='pair') for(const [i,date] of ds.entries()) rows.push({uid:'in'+i,date,direction:'inflow'});
    for(const row of rows) {
      if(keep&&!keep.includes(row.uid))continue;
      f.add(row.uid,row.direction==='inflow'?'Transfer from account 1234':c.description,'',{date:row.date,cents,direction:row.direction});
      if(row.direction==='inflow') f.raw("UPDATE fin_transactions SET account_slug='destination' WHERE txn_uid=?",row.uid);
      else if(c.category!=='none') f.raw('UPDATE fin_transactions SET category=?,category_basis_state=? WHERE txn_uid=?',c.category==='transfer'?'TRANSFER_OUT':'software',c.category==='owner-expense'?'confirmed':'proposed',row.uid);
    }
    return rows.map(r=>r.uid).filter(uid=>!keep||keep.includes(uid));
  }
  async function ask(c,cents=c.cents,keep=null) {
    setup(c,cents,keep); const start=f.calls.length;
    const changes=f.first('SELECT total_changes() n').n;
    const response=await withLedgerAnswer({env:f.env,question:c.question,now:Date.parse(NOW),grantScope:{all:true},scopePrincipalKind:'owner',
      callLLM:async()=>{model++;throw new Error('model forbidden');}},async gap=>Response.json({route:'documents',gaps:gap?[gap]:[]}));
    const b=await response.json();
    assert.equal(f.first('SELECT total_changes() n').n,changes,'answer leaves durable rows unchanged');
    return {b,reached:f.calls.slice(start).some(sql=>/SELECT t\.id,t\.account_slug AS source_account_slug|WITH observations AS/.test(sql))};
  }
  async function shrink(c) {
    // Greedy row deletion reaches a 1-minimal witness, followed by the
    // smallest positive integer-cent amount. Each reduction is re-executed.
    let keep=setup(c);
    for(const uid of [...keep]) { const candidate=keep.filter(x=>x!==uid); const trial=await ask(c,c.cents,candidate); if(verdict(trial.b,c.surface,0,true)==='WRONG')keep=candidate; }
    const tiny=await ask(c,1,keep); assert.equal(verdict(tiny.b,c.surface,0,true),'WRONG','cent shrink retains failure');
    for(const uid of keep) assert.notEqual(verdict((await ask(c,1,keep.filter(x=>x!==uid))).b,c.surface,0,true),'WRONG','row minimal');
    stats.shrunk++;
    witnesses.push({...c,cents:1,rows:keep,verdict:['card','loan'].includes(c.family)?'KNOWN-CLASS':'WRONG',actual_minor:observe(tiny.b,c.surface)});
  }
  for(const seed of [17,428,7301]) for(const [family,kind,forms] of families) for(const [form,description] of forms.entries())
    for(const connection of ['pair','connected-unpaired','no']) for(const category of ['none','transfer','provider-expense','owner-expense']) for(const [surface,question] of questions) {
      const c={seed,family,kind,form,description,endpoint:forms[0].replace('Transfer to ',''),connection,category,surface,question,cents:seedValue(seed)};
      const {b,reached}=await ask(c); let v=verdict(b,surface,0,true);
      if(observe(b,surface)!==null) assert.ok(reached,'certified figure reached transaction reader');
      const known=['card','loan'].includes(family);
      stats.cases++; stats.matrix_cases++; stats.by_family[family] ||= {wrong:0,known_wrong:0}; stats.by_surface[surface] ||= {};
      stats.by_surface[surface][v]=(stats.by_surface[surface][v]||0)+1;
      stats.verdicts[known?'KNOWN-CLASS':v]=(stats.verdicts[known?'KNOWN-CLASS':v]||0)+1;
      if(v==='WRONG') {
        stats.by_family[family][known?'known_wrong':'wrong']++;
        stats[known?'known_class_wrong':'wrong_figures']++;
        await shrink(c);
      }
      f.calls.length=0;
    }
  // Two ambiguous forms per family exercise the withholding branch explicitly.
  for(const [family,kind,forms] of families) for(const suffix of [' PRINCIPAL PLUS INTEREST FEE',' $10.00 PLUS $2.00']) for(const [surface,question] of questions) {
    const c={family,kind,description:forms[0]+suffix,endpoint:'unused',connection:'no',category:'owner-expense',surface,question,cents:1200};
    const {b}=await ask(c); const v=verdict(b,surface,0,true); stats.cases++; stats.matrix_cases++;
    if(process.env.OWN_MOVEMENT_RULE_CHILD)assert.equal(observe(b,surface),null,'component text withholds the scope figure');
    stats.by_surface[surface][v]=(stats.by_surface[surface][v]||0)+1;
    if(v==='WRONG')stats.by_family[family][['card','loan'].includes(family)?'known_wrong':'wrong']++;
    if(v==='WRONG') {stats[['card','loan'].includes(family)?'known_class_wrong':'wrong_figures']++; await shrink(c);}
    const label=['card','loan'].includes(family)?'KNOWN-CLASS':v;
    stats.verdicts[label]=(stats.verdicts[label]||0)+1; f.calls.length=0;
  }
  // Green controls use recognized endpoint text, confirmed category membership,
  // and real cadence rows. A fallback never passes a control.
  for(const [surface,question] of questions) {
    for(const merchant of ['SYNTHETIC OFFICE STORE','SYNTHETIC TRANSFER TRUCKING']) {
      const c={family:'merchant',kind:'checking',description:merchant,endpoint:'unused',connection:'no',category:'owner-expense',surface,question,cents:137};
      const {b,reached}=await ask(c); const v=verdict(b,surface,137,false);
      stats.cases++; stats.control_cases++;
      if(v==='OVER-EXCLUSION')stats.over_exclusions++; if(v==='OVER-REFUSAL')stats.over_refusals++;
      if(surface==='business') { assert.equal(v,'OVER-REFUSAL','base role surface needs provider admission'); }
      else {assert.ok(reached,'merchant control reaches facts'); assert.equal(v,'RIGHT',surface+' '+merchant+' '+JSON.stringify(b)); stats.controls++;}
    }
  }
  const pair={family:'savings',kind:'savings',description:'Transfer to savings',endpoint:'savings',connection:'pair',category:'none',surface:'spent',question:questions[0][1],cents:137};
  const paired=await ask(pair);assert.ok(paired.reached);assert.equal(observe(paired.b,'spent'),0);assert.equal(paired.b.ledger.excluded_own_transfer_minor,137,'one outgoing exclusion, not double counted');stats.controls++;
  stats.cases++; stats.control_cases++;
  // Adversarial merchant descriptors have a destination noun inside a legal
  // merchant name. Count experimental over-exclusion rather than hiding it.
  for(const name of ['ACH DEBIT SAVINGS TRANSFER TRUCKING','WIRE ESCROW TRANSFER TRUCKING']) {
    const c={...pair,connection:'no',description:name,category:'owner-expense',cents:1};
    const {b,reached}=await ask(c); assert.ok(reached);
    const v=verdict(b,'spent',1,false);
    stats.cases++; stats.control_cases++;
    if(v==='OVER-EXCLUSION')stats.over_exclusions++;
    if(v==='OVER-REFUSAL')stats.over_refusals++;
    if(!process.env.OWN_MOVEMENT_RULE_CHILD)assert.equal(v,'RIGHT');
  }
  assert.equal(stats.shrunk,stats.wrong_figures+stats.known_class_wrong,'every failure has a minimal replay');
  assert.equal(stats.matrix_cases,7700,'the complete fixed population was measured');
  assert.equal(stats.cases,7717,'the population and all controls were measured');
  stats.wrong_total=stats.wrong_figures+stats.known_class_wrong+stats.over_exclusions;
  assert.equal(network,0); assert.equal(model,0); stats.network=network;stats.model=model;
  if(process.env.OWN_MOVEMENT_RESULT)writeFileSync(process.env.OWN_MOVEMENT_RESULT,JSON.stringify({stats,witnesses},null,2));
  console.log('OWN_MOVEMENT '+JSON.stringify(stats));
  return stats;
}

test('oracle rejects restored spending, word-merchant exclusions, and missing controls',()=>{
  const expense={ledger:{expense_total_minor:1},answer:'Spent $0.01'};
  assert.equal(verdict(expense,'spent',0,true),'WRONG');
  assert.equal(verdict({ledger:{expense_total_minor:0}},'spent',1,false),'OVER-EXCLUSION');
  assert.equal(verdict({},'spent',1,false),'OVER-REFUSAL');
  assert.equal(verdict({ledger:{total_minor:null}},'spent',0,true),'WITHHELD');
});
test('generated own destination measurement through real ledger entry',measure);
if(!process.env.OWN_MOVEMENT_RULE_CHILD) test('closed-world rule experiment in memory',()=>{
  const child=spawnSync(process.execPath,['--import',new URL('./own-movement-experiment-loader.mjs',import.meta.url).href,'--test',fileURLToPath(import.meta.url)],{encoding:'utf8',env:{SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,TMPDIR:process.env.TMPDIR,PATH:process.env.PATH,OWN_MOVEMENT_RULE_CHILD:'1',...(process.env.OWN_MOVEMENT_RULE_MUTANT?{OWN_MOVEMENT_RULE_MUTANT:process.env.OWN_MOVEMENT_RULE_MUTANT}:{}),...(process.env.OWN_MOVEMENT_RULE_RESULT?{OWN_MOVEMENT_RESULT:process.env.OWN_MOVEMENT_RULE_RESULT}:{})},maxBuffer:8*1024*1024});
  assert.equal(child.status,0,child.stdout+'\n'+child.stderr);
  const result=JSON.parse(child.stdout.match(/OWN_MOVEMENT (\{[^\n]+\})/)[1]);
  assert.equal(result.cases,7717,'the trial measured the same complete population and controls');
  console.log(child.stdout);
});
