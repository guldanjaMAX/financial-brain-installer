import test from 'node:test';
import assert from 'node:assert/strict';
import {shapes,makeLedger} from './fixtures/owner-route-book.mjs';
import {withLedgerAnswer} from '../src/lib/ledger-answer.js';
const kinds=['balance','balance','totals','totals','expense_summary','merchant','recurring','payment','largest','merchant'];
export async function ask(f,question){return (await withLedgerAnswer({env:f.env,question,now:Date.parse('2026-11-03T19:00:00Z'),grantScope:{all:true},scopePrincipalKind:'owner',callLLM:()=>assert.fail('model forbidden')},()=>Response.json({fallback:true}))).json();}
for(const complete of [false,true])for(let i=0;i<10;i++)for(let j=0;j<3;j++)test(`${complete?'complete':'partial'} Q${i+1}.${j}`,async t=>{
 const {f,oracle}=makeLedger(427,t);f.env.BRAIN_TIMEZONE='America/Phoenix';
 if(complete)f.raw("UPDATE fin_account_coverage SET coverage_status='complete', covered_from='2026-07-01'");
 const b=await ask(f,shapes[i][j]);
 if(!complete && [7,9].includes(i)){assert.equal(b.gaps?.[0]?.reason,'period_outside_coverage');assert.match(b.gaps[0].detail,/3333/);assert.match(b.gaps[0].detail,/October 15/);return;}
 assert.equal(b.ledger?.kind,kinds[i],JSON.stringify(b));
 if(i===0)assert.equal(b.ledger.accounts.filter(a=>a.balance_group==='cash').reduce((sum,a)=>sum+a.current_minor,0),oracle.bank);
 if(i===7){assert.equal(b.ledger.found,null);assert.equal(b.ledger.total_minor,null);assert.match(b.answer,/invoice-to-payment link is missing/);}
 if(i===9){assert.equal(b.ledger.lead_total_minor,oracle.lastIncome);assert.equal(b.ledger.attribution_incomplete,true);}
 if(i===1)assert.match(b.answer,/5,004.27/);
 if(i===2)assert.equal((b.ledger.covered_inflow_subtotal_minor ?? b.ledger.combined_inflow_minor),oracle.currentIncome);
 if(i===3)assert.equal((b.ledger.covered_inflow_subtotal_minor ?? b.ledger.combined_inflow_minor),oracle.grossLastInflow); // Recorded inflow is gross; outside inflow has its own field.
 if(i===4)assert.equal(b.ledger.expense_total_minor,oracle.expenses);
 if(i===5)assert.equal(b.ledger.found,null);
 if(i===6){assert.equal(b.ledger.recurring?.[0]?.typical_minor,oracle.utility);assert.equal(b.ledger.recurring?.[0]?.monthly_minor,oracle.utility);}
 if(i===8)assert.deepEqual(b.ledger.lead_rows.map(r=>r.amount_minor),oracle.expenseRows.map(r=>r.cents));
 if(b.ledger.payment_exclusions){assert.equal(b.ledger.payment_exclusions.total_minor,23000);assert.equal(b.ledger.payment_exclusions.count,1);}
});
test('owned payment pair is one payment; either single leg is a green control',async t=>{
 for(const keep of [null,'card-pay','card-receipt']){const {f}=makeLedger(427,t);f.raw(keep?'DELETE FROM fin_transactions WHERE txn_uid != ?':"DELETE FROM fin_transactions WHERE txn_uid NOT IN ('card-pay','card-receipt')",...(keep?[keep]:[]));
 const b=await ask(f,'How much came in last month?');assert.equal(b.ledger.payment_exclusions.total_minor,23000);assert.equal(b.ledger.payment_exclusions.count,1);}
});

test('syntax tolerance preserves all identity literals and refuses extra qualifiers',async t=>{
 const {f}=makeLedger(427,t);f.raw("UPDATE fin_account_coverage SET coverage_status='complete', covered_from='2026-07-01'");
 for(const q of ['What is the balance in Practise Checking?','How much do I pay Clearline Internat each month?']){
  const b=await ask(f,q);assert.doesNotMatch(b.answer||'',/5,004\.27|79\.99/);
 }
 for(const q of ['How much money is in the bank next year?','How much do I pay Clearline Internet each month excluding tax?']){
  const b=await ask(f,q);assert.equal(b.ledger,undefined);
 }
 const b=await ask(f,'Did Birch pay the invoice?');assert.equal(b.ledger.found,true);assert.match(b.answer,/invoice-to-payment link is missing/);
});

test('existing supported wordings remain green controls for each reader',async t=>{
 const {f}=makeLedger(427,t);f.raw("UPDATE fin_account_coverage SET coverage_status='complete', covered_from='2026-07-01'");
 const controls=['What are my account balances?','What is my Practice Checking balance?','How much money came in this month?','How much money came in last month?','What did I spend last month and on what?','How much did I spend at Amazon in the last 3 months?','What are my recurring charges?','Did Birch pay?','What were my biggest expenses last month?','Show income by merchant last month'];
 for(let i=0;i<controls.length;i++)assert.equal((await ask(f,controls[i])).ledger?.kind,kinds[i]);
});

test('pair proof requires both directed references, equal amounts and a three-day window',async t=>{
 for(const [sql,total,count] of [
  ["UPDATE fin_transactions SET posted_on='2026-10-24' WHERE txn_uid='card-receipt'",23000,1],
  ["UPDATE fin_transactions SET posted_on='2026-10-25' WHERE txn_uid='card-receipt'",23000,1],
  ["UPDATE fin_transactions SET posted_on='2026-10-26' WHERE txn_uid='card-receipt'",23000,1],
  ["UPDATE fin_transactions SET posted_on='2026-10-27' WHERE txn_uid='card-receipt'",46000,2],
  ["UPDATE fin_transactions SET amount_minor=23001 WHERE txn_uid='card-receipt'",46001,2],
  ["UPDATE fin_transactions SET description='payment from account 1111' WHERE txn_uid='card-receipt'",46000,2],
 ]){const {f}=makeLedger(427,t);f.raw(sql);const b=await ask(f,'How much came in last month?');assert.equal(b.ledger.payment_exclusions.total_minor,total);assert.equal(b.ledger.payment_exclusions.count,count);}
});
import {classifyLedgerQuestion} from '../src/lib/ledger-question.js';
test('numeric period values are exact rather than syntax typos',()=>{
 const q=classifyLedgerQuestion('How much did I spend at Amazon in the last 4 months?',{now:Date.parse('2026-11-03T19:00:00Z'),timeZone:'America/Phoenix'});assert.equal(q.from,'2026-07-03');
});
import {ownerQuestionAlias} from '../src/lib/ledger-owner-aliases.js';
test('alias capture keeps punctuation and words inside identity slots',()=>{
 assert.equal(ownerQuestionAlias('How much do I pay North, South each month?').recurring,'north, south');
 assert.equal(ownerQuestionAlias('How much do I pay Whats Media each month?').recurring,'whats media');
});
test('business checking preserves kind and asks when the singular account is ambiguous',async t=>{
 const {f}=makeLedger(427,t);f.raw("UPDATE fin_accounts SET entity_slug='practice' WHERE account_slug='card'");
 const single=await ask(f,'Whats in my business checking account?');assert.deepEqual(single.ledger.accounts.map(a=>a.account_mask),['1111']);
 f.raw("UPDATE fin_accounts SET entity_slug='practice' WHERE account_slug='personal'");
 const ambiguous=await ask(f,'Whats in my business checking account?');assert.equal(ambiguous.ledger.selector_ambiguous,true);assert.match(ambiguous.answer,/choose which account/);assert.equal(ambiguous.ledger.accounts.length,2);
});
test('named nickname aliases retain the existing ambiguity clarification',async t=>{
 const {f}=makeLedger(427,t);f.raw("UPDATE fin_accounts SET label='Practice Checking' WHERE account_slug='personal'");
 const b=await ask(f,'What is the balance in Practice Checking?');assert.equal(b.ledger.selector_ambiguous,true);assert.match(b.answer,/choose which account/);
});
test('every existing disclosure reader counts the owned pair once',async t=>{
 const {f}=makeLedger(427,t);f.raw("UPDATE fin_account_coverage SET coverage_status='complete',covered_from='2026-07-01'");
 for(const q of ['What did I spend last month and on what?','Show spending by category last month','What are my recurring charges?','Show income by merchant last month','Show deposits last month','What were my biggest expenses last month']){
  const b=await ask(f,q);assert.ok(b.ledger,q);
  for(const summary of [b.ledger.payment_exclusions,b.ledger.own_account_payments].filter(Boolean)){assert.equal(summary.total_minor,23000,q);assert.equal(summary.count,1,q);}
  assert.doesNotMatch(b.answer,/\$460\.00 across 2 payments/);
 }
});
test('a plural ownership phrase stays an ownership scope rather than a nickname',async t=>{
 const {f}=makeLedger(427,t);const b=await ask(f,"What's in my business accounts?");assert.deepEqual(b.ledger?.accounts.map(a=>a.account_mask),['1111']);
});

async function askBalanceInventory(f, question) {
 f.calls.length=0;
 const body=await ask(f,question);
 assert.ok(f.calls.some(sql=>/AS account_kind_review_json\b/i.test(sql)), 'account inventory decision reached');
 return body;
}

test('a balance possessive leaves the exact ending and full nickname available',async t=>{
 const {f}=makeLedger(427,t);
 const control=await askBalanceInventory(f,'What is my account ending 1111 balance?');
 assert.deepEqual(control.ledger.accounts.map(a=>a.account_mask),['1111']);
 for(const q of ['What is the balance on my 1111?','What is the balance in my 1111?']){
  const b=await askBalanceInventory(f,q);
  assert.equal(b.ledger?.kind,'balance',q);
  assert.deepEqual(b.ledger.accounts,control.ledger.accounts,q);
 }
 f.raw("UPDATE fin_accounts SET label='My Reserve' WHERE account_slug='personal'");
 const named=await askBalanceInventory(f,'What is the balance in my Reserve?');
 assert.deepEqual(named.ledger?.accounts.map(a=>a.account_mask),['2222'],'the full recorded nickname is still literal evidence');
 const missing=await askBalanceInventory(f,'What is the balance on my 1112?');
 assert.equal(missing.ledger,undefined,'an ending is never repaired as a syntax typo');
 assert.equal(missing.gaps?.[0]?.reason,'no_accounts');
});

// Seed 904271 enumerates role/kind one-edit siblings; each row proves the
// real balance route was reached and checks a literal balance green control.
const siblingRows = [];
let routeSeed = 904271;
for (const role of ['business','personal']) for (const kind of ['checking','savings','card','loan']) {
 for (const target of ['role','kind']) for (const edit of ['delete','insert','replace','transpose','exact']) {
  if (target==='kind' && edit==='exact') continue;
  const token=target==='role'?role:kind;
  routeSeed = (Math.imul(routeSeed,1664525)+1013904223)>>>0;
  const at=1+routeSeed%(token.length-2);
  const word=edit==='delete'?token.slice(0,at)+token.slice(at+1):edit==='insert'?token.slice(0,at)+'z'+token.slice(at):edit==='replace'?token.slice(0,at)+'z'+token.slice(at+1):edit==='transpose'?token.slice(0,at)+token[at+1]+token[at]+token.slice(at+2):token;
  siblingRows.push({role,kind,target,edit,label:target==='role'?`${word} ${kind}`:`${role} ${word}`});
 }
}
for (const row of siblingRows) test(`literal role collision seed904271 ${JSON.stringify(row)}`,async t=>{
 const {f}=makeLedger(427,t);
 f.raw("UPDATE fin_accounts SET label=? WHERE account_slug='personal'",row.label);
 const control=await ask(f,`What is my ${row.label} balance?`);
 assert.equal(control.ledger?.kind,'balance');
 assert.deepEqual(control.ledger.accounts.map(a=>a.account_mask),['2222'],'literal control stays green');
 const actual=await askBalanceInventory(f,`What's in my ${row.label} account?`);
 assert.equal(actual.ledger?.kind,'balance','decision point reached');
 assert.deepEqual(actual.ledger.accounts.map(a=>a.account_mask),['2222']);
 assert.deepEqual(actual.ledger.accounts,control.ledger.accounts);
});
test('duplicate exact role labels clarify rather than choose a role',async t=>{
 const {f}=makeLedger(427,t);f.raw("UPDATE fin_accounts SET label='Busines Checking' WHERE account_slug IN ('personal','business')");
 const b=await askBalanceInventory(f,"What's in my Busines Checking account?");
 assert.equal(b.ledger?.kind,'balance');assert.equal(b.ledger.selector_ambiguous,true);
});

test('review witness keeps the exact Busines Checking account',async t=>{
 const {f}=makeLedger(427,t);
 f.raw("UPDATE fin_accounts SET label='Busines Checking' WHERE account_slug='personal'");
 const control=await ask(f,'What is my Busines Checking balance?');
 assert.equal(control.ledger?.kind,'balance');
 assert.deepEqual(control.ledger.accounts.map(a=>a.account_mask),['2222']);
 const b=await askBalanceInventory(f,"What's in my Busines Checking account?");
 assert.equal(b.ledger?.kind,'balance','real balance decision reached');
 assert.deepEqual(b.ledger.accounts,control.ledger.accounts);
 assert.match(b.answer,/1,704\.27/);assert.doesNotMatch(b.answer,/5,004\.27/);
});

// Seed 904272 covers the remaining ownership forms and generic kind-word
// nicknames. Explicit ending digits are independent green controls per row.
const otherLiteralRows=[];
let otherSeed=904272;
for(const role of ['business','personal']) for(const edit of ['exact','delete','insert','replace','transpose']) {
 otherSeed=(Math.imul(otherSeed,1664525)+1013904223)>>>0;
 const at=1+otherSeed%(role.length-2);
 const name=edit==='delete'?role.slice(0,at)+role.slice(at+1):edit==='insert'?role.slice(0,at)+'z'+role.slice(at):edit==='replace'?role.slice(0,at)+'z'+role.slice(at+1):edit==='transpose'?role.slice(0,at)+role[at+1]+role[at]+role.slice(at+2):role;
 for(const suffix of ['account','accounts'])otherLiteralRows.push({name,question:`What's in my ${name} ${suffix}?`});
}
for(const name of ['checking','savings','card','loan']) for(const question of [`What's in my ${name} account?`,`What is the balance in ${name}?`,`How much is in ${name} balance?`])otherLiteralRows.push({name,question});
for(const row of otherLiteralRows)test(`literal sibling seed904272 ${JSON.stringify(row)}`,async t=>{
 const {f}=makeLedger(427,t);f.raw("UPDATE fin_accounts SET label=? WHERE account_slug='personal'",row.name);
 const control=await ask(f,'What is my account ending 2222 balance?');
 assert.equal(control.ledger?.kind,'balance');assert.deepEqual(control.ledger.accounts.map(a=>a.account_mask),['2222']);
 assert.equal(classifyLedgerQuestion(row.question).kind,'balance','balance grammar decision reached');
 f.calls.length=0;
 const b=await askBalanceInventory(f,row.question);
 assert.ok(f.calls.some(sql=>/FROM fin_accounts\b/i.test(sql)),'inventory decision reached');
 assert.deepEqual(b.ledger?.accounts,control.ledger.accounts);
});

for(const suffix of ['acounts','accoutns','accountss'])test(`literal ownership suffix ${suffix}`,async t=>{
 const {f}=makeLedger(427,t);f.raw("UPDATE fin_accounts SET label='Busines' WHERE account_slug='personal'");
 const control=await ask(f,'What is my account ending 2222 balance?');
 assert.deepEqual(control.ledger.accounts.map(a=>a.account_mask),['2222']);
 const b=await askBalanceInventory(f,`What's in my Busines ${suffix}?`);
 assert.equal(b.ledger?.kind,'balance');assert.deepEqual(b.ledger.accounts,control.ledger.accounts);
});

for(const question of ["What's in my What's Checking account?","What is the balance in What's Checking?","How much is in What's Checking balance?","  What's in my What's Checking account?"])test(`literal contraction identity ${question}`,async t=>{
 const {f}=makeLedger(427,t);
 f.raw("UPDATE fin_accounts SET label=? WHERE account_slug='personal'","What's Checking");
 f.raw("UPDATE fin_accounts SET label='What is Checking' WHERE account_slug='business'");
 const control=await ask(f,'What is my account ending 2222 balance?');assert.deepEqual(control.ledger.accounts.map(a=>a.account_mask),['2222']);
 f.calls.length=0;const b=await askBalanceInventory(f,question);
 assert.equal(b.ledger?.kind,'balance');assert.ok(f.calls.some(sql=>/FROM fin_accounts\b/i.test(sql)),'inventory decision reached');
 assert.deepEqual(b.ledger.accounts,control.ledger.accounts);
});

const frameRows=[];
let frameSeed=904274;
for(const role of ['business','personal'])for(const kind of ['', 'checking','savings','card','loan'])for(const suffix of ['account','accounts']){
 frameSeed=(Math.imul(frameSeed,1664525)+1013904223)>>>0;
 const word=frameSeed%2 ? role : role.slice(0,-1);
 const name=[word,kind,suffix].filter(Boolean).join(' ');
 frameRows.push({name,question:`What's in my ${name}?`});
}
for(const word of ['business','personal','checking','savings','card','loan'])frameRows.push({name:`${word} balance`,question:`How much is in ${word} balance?`});
for(const row of frameRows)test(`literal maximal frame seed904274 ${JSON.stringify(row)}`,async t=>{
 const {f}=makeLedger(427,t);f.raw("UPDATE fin_accounts SET label=? WHERE account_slug='personal'",row.name);
 const control=await ask(f,`What is the balance in ${row.name}?`);
 assert.equal(control.ledger?.kind,'balance');assert.deepEqual(control.ledger.accounts.map(a=>a.account_mask),['2222'],'full-name control');
 f.calls.length=0;const b=await askBalanceInventory(f,row.question);
 assert.ok(f.calls.some(sql=>/FROM fin_accounts\b/i.test(sql)),'inventory decision reached');
 assert.deepEqual(b.ledger?.accounts,control.ledger.accounts);
});
test('competing exact account frames clarify instead of choosing a shorter name',async t=>{
 const {f}=makeLedger(427,t);f.raw("UPDATE fin_accounts SET label='Business Checking' WHERE account_slug='business'");
 f.raw("UPDATE fin_accounts SET label='Business Checking Account' WHERE account_slug='personal'");
 const control=await ask(f,'What is my account ending 2222 balance?');assert.deepEqual(control.ledger.accounts.map(a=>a.account_mask),['2222']);
 const b=await askBalanceInventory(f,"What's in my Business Checking account?");assert.equal(b.ledger?.kind,'balance');assert.equal(b.ledger.selector_ambiguous,true);
});

test('an exact closed account frame retains the named-reader status rule',async t=>{
 const {f}=makeLedger(427,t);f.raw("UPDATE fin_accounts SET label='Business Balance',status='closed' WHERE account_slug='personal'");
 const control=await ask(f,'What is the balance in Business Balance?');assert.deepEqual(control.ledger.accounts.map(a=>a.account_mask),['2222']);
 const b=await askBalanceInventory(f,'How much is in Business balance?');assert.equal(b.ledger?.kind,'balance');assert.deepEqual(b.ledger.accounts,control.ledger.accounts);
});

let equivalentSeed=904275;
const equivalentKinds=['checking','savings','card','loan'];
for(const prefix of ['Unit','Business','Personal'])for(const [index,kind] of equivalentKinds.entries()){
 equivalentSeed=(Math.imul(equivalentSeed,1664525)+1013904223)>>>0;
 const sibling=equivalentKinds[(index+1+equivalentSeed%3)%equivalentKinds.length];
 const name=`${prefix} ${kind}`;
 for(const question of [`What is the balance in ${name}?`,`How much is in ${name} balance?`,`What's in my ${name} account?`])test(`literal equivalent identity seed904275 ${prefix} ${kind}/${sibling} ${question}`,async t=>{
  const {f}=makeLedger(427,t);f.raw("UPDATE fin_accounts SET label=? WHERE account_slug='business'",name);f.raw("UPDATE fin_accounts SET label=? WHERE account_slug='personal'",`${prefix} ${sibling}`);
  const control=await ask(f,`What is my ${name} balance?`);assert.equal(control.ledger?.kind,'balance');assert.equal(control.ledger.selector_ambiguous,true,'existing nickname-equivalence control');
  f.calls.length=0;const b=await askBalanceInventory(f,question);assert.equal(b.ledger?.kind,'balance');assert.ok(f.calls.some(sql=>/FROM fin_accounts\b/i.test(sql)),'inventory decision reached');
  assert.equal(b.ledger.selector_ambiguous,true);assert.deepEqual(b.ledger.accounts,control.ledger.accounts);
 });
}
