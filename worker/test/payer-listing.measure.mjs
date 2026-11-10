// Synthetic measurement: oracle membership is authored independently of product helpers.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { fixture } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { trial } from './payer-listing-rule.mjs';
import { score, overRefusal } from './payer-listing-score.mjs';
const prompts = ['who paid me', 'who sent me money', 'list my payers', 'where did my money come from', 'top payers', 'who paied me', 'who sent me monney', 'list my payerrs', 'where did my monney come from', 'top payerrs'];
const kinds = ['customer', 'description', 'connected', 'unconnected', 'refund', 'reversal', 'loan', 'contribution', 'connected_single'];
const descriptions = {customer:'Customer invoice payment',description:'Customer Unit invoice payment',connected:'Transfer from Reserve account',connected_single:'Transfer from Reserve account',unconnected:'Transfer from my unconnected own account',refund:'Merchant refund for returned purchase',reversal:'Reversal returned item',loan:'Loan disbursement',contribution:'Owner contribution'};
const results = [];
let model = 0, network = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { network++; throw Error('NETWORK_FORBIDDEN'); };
try {
for (const seed of [428, 10428, 20428]) for (const scope of ['personal','business']) for (const coverage of ['complete','partial','mixed']) for (const period of ['this month','last month','September 2026']) for (const kind of [...kinds,'mixed']) {
 const partial=coverage!=='complete';
 let close; const f = fixture({after(fn){close=fn;}}); f.owner();
 f.raw('UPDATE fin_entities SET kind=?',scope==='personal'?'person':'business');
 f.env.AI = {async run(){model++;throw Error('MODEL_FORBIDDEN');}};
 for (const [slug,label,mask] of [['main','Daily account','4101'],['reserve','Reserve account','4102']]) {
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at) VALUES (?,'owner','checking','asset',?,?,'manual','owner_stated','confirmed','2026-10-12')`,slug,mask,label);
  f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at) VALUES (?,?,'2026-01-01','2026-10-31','2026-10-12','owner_stated','confirmed','2026-10-12')`,slug,coverage==='partial'||coverage==='mixed'&&slug==='reserve'?'partial':'complete');
 }
 const date=period==='this month'?'2026-10-05':'2026-09-05';
 let expected=0; const members=[];
 for(const k of kind==='mixed'?kinds:[kind]) {
  const amount=10000+seed+kinds.indexOf(k)*137;
  // Loans are outside-party inflow; contribution is an owner's own movement.
  if(['customer','description','loan'].includes(k)){expected+=amount;members.push(k);}
  f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,provenance,basis_state,recorded_at) VALUES (?,'main',?,?,'inflow',?,?,'owner_stated','confirmed','2026-10-12')`,k,date,amount,descriptions[k],k==='description'?null:['connected','connected_single'].includes(k)?'Reserve account':`${k} Unit`);
  if(k==='connected') f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,provenance,basis_state,recorded_at) VALUES ('out','reserve',?,?,'outflow','Transfer to Daily account','Daily account','owner_stated','confirmed','2026-10-12')`,date,amount);
 }
 try {for(const wording of prompts) for(const frame of ['bare','scoped']){
  const question=`${wording} ${period}${frame==='scoped'?` for my ${scope} accounts`:''}?`;
  for(const [mode,reader] of [['base',withLedgerAnswer],['rule',trial]]) {
   const body=await(await reader({env:f.env,question,now:Date.parse('2026-10-12T12:00:00Z'),grantScope:{all:true},scopePrincipalKind:'owner',callLLM:async()=>{model++;throw Error('MODEL_FORBIDDEN');}},async gap=>Response.json({gaps:gap?[gap]:[]}))).json();
   const l=body.ledger; const actual=l?.total_minor;
   const c={seed,scope,coverage,partial,period,kind,frame,question,mode,expected,members,actual,body};
   results.push({...c,status:score(c),over_refusal:overRefusal(c)});
  }
 }}finally{close();}
}
}finally{globalThis.fetch=originalFetch;}
assert.equal(model,0);assert.equal(network,0);
const counts=mode=>results.filter(r=>r.mode===mode).reduce((n,r)=>(n[r.status]=(n[r.status]||0)+1,n),{});
writeFileSync(new URL('../../payer-listing.results.json',import.meta.url),JSON.stringify({model,network,base:counts('base'),rule:counts('rule'),results},null,2)+'\n');
console.log(JSON.stringify({cases:results.length/2,model,network,base:counts('base'),rule:counts('rule')}));
