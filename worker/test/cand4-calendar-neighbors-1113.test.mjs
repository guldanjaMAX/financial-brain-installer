import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {ledgerFixture,NOW} from './ledger-review-fixture.mjs';
function setup(t){
 t.mock.method(Date,'now',()=>Date.parse(NOW));
 t.mock.method(globalThis,'fetch',()=>assert.fail('network forbidden'));
 return ledgerFixture(t);
}
async function ask(f,q){
 const start=f.calls.length;
 const r=await worker.fetch(new Request('https://fixture.invalid/api/rag/think',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Key':f.env.ADMIN_KEY},body:JSON.stringify({q})}),f.env,{waitUntil(){}});
 const b=await r.json();
 return {b,reads:f.calls.length-start,posting:f.calls.slice(start).some(sql=>/CROSS JOIN fin_transactions/.test(sql))};
}
for(const q of [
 'What did I spend near the end of September 2026 on account ending 1234?',
 'How much did I spend over the last week of September 2026 on account ending 1234?',
]) test('new calendar neighbor: '+q,async t=>{
 const f=setup(t);
 f.add('late','Purchase Unit','Store Unit',{cents:4200,direction:'outflow',date:'2026-09-28'});
 const green=await ask(f,'How much did I spend in September 2026 on account ending 1234?');
 assert.ok(green.posting);assert.equal(green.b.ledger.total_minor,4200);
 const sameSpan=await ask(f,q.replace('over the last week','during the last week'));
 assert.ok(sameSpan.posting);assert.equal(sameSpan.b.ledger.total_minor,4200,'same temporal-span control');
 const {b,reads,posting}=await ask(f,q);
 console.log(JSON.stringify({q,control:green.b.ledger.total_minor,reads,posting,answer:b.answer,ledger:b.ledger,confidence:b.confidence_text}));
 assert.ok(reads>0,'routing and stored data reads reached');
 assert.equal(b.ledger?.total_minor,4200,'usable month and account operands survive');
 assert.ok(posting,'bounded posting decision reached');
 assert.deepEqual([b.ledger.from,b.ledger.to],['2026-09-01','2026-09-30']);
 assert.match(b.answer,/Time restriction not applied:.*full month of September 2026/s);
 assert.match(b.confidence_text,/Confidence: Low \(0%\).*Why:.*Missing:/s);
 assert.match(b.answer,/Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
});
for(const [kind,q] of [
 ['category','How much did I spend on materials in October 2026?'],
 ['ranking','What were my top 2 expenses in October 2026?'],
]) test('new unrelated payment neighbor: '+kind,async t=>{
 const f=setup(t);
 f.add('purchase','Purchase Unit','Store Unit',{cents:10000,direction:'outflow'});
 f.add('included-payment','Card payment','Materials Unit',{cents:3500,direction:'outflow'});
 f.raw("UPDATE fin_transactions SET category='materials',category_basis_state='confirmed'");
 const green=await ask(f,q);assert.ok(green.posting);
 if(kind==='category')assert.equal(green.b.ledger.total_minor,13500);
 else assert.deepEqual(green.b.ledger.rows.map(r=>r.amount_minor),[10000,3500]);
 assert.ok(green.b.ledger.possible_payments.some(r=>r.amount_minor===3500&&r.included_in_total),'selected payment disclosure green control');
 f.add('unrelated','Card payment','Travel Unit',{cents:2500,direction:'outflow'});
 f.raw("UPDATE fin_transactions SET category='travel',category_basis_state='confirmed' WHERE txn_uid='unrelated'");
 const {b,posting}=await ask(f,q);assert.ok(posting);
 console.log(JSON.stringify({kind,q,answer:b.answer,ledger:b.ledger}));
 if(kind==='category')assert.equal(b.ledger.total_minor,13500);
 else assert.deepEqual(b.ledger.rows.map(r=>r.amount_minor),[10000,3500]);
 assert.ok(b.ledger.possible_payments.some(r=>r.amount_minor===3500&&r.included_in_total));
 assert.ok(!b.ledger.possible_payments.some(r=>r.amount_minor===2500&&r.included_in_total));
 assert.doesNotMatch(b.answer,/Counted in spending above, possibly a card payment: \$25\.00/);
});
