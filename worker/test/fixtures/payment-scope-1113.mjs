import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../src/index.js';
import { ledgerFixture, NOW } from '../ledger-review-fixture.mjs';

async function ask(f,q) {
 const start=f.calls.length;
 const res=await worker.fetch(new Request('https://fixture.invalid/api/rag/think',{
  method:'POST',headers:{'Content-Type':'application/json','X-Admin-Key':f.env.ADMIN_KEY},body:JSON.stringify({q})
 }),f.env,{waitUntil(){}});
 const b=await res.json();assert.ok(f.calls.slice(start).some(sql=>/CROSS JOIN fin_transactions/.test(sql)),'scoped posting decision reached');return b;
}
for(const [q,field,expected] of [
 ['How much did I spend at Store Unit in October 2026?','total_minor',10000],
 ['How much money came in in October 2026?','combined_inflow_minor',7000],
 ['What were my largest expenses in October 2026?',null,null],
 ['What were my top 1 expenses in October 2026?','ranked-control',10000],
 ['How much did I spend on materials in October 2026?','total_minor',10000],
]) test(`payment disclosure stays inside the stated measure: ${q}`,async t=>{
 t.mock.method(Date,'now',()=>Date.parse(NOW));t.mock.method(globalThis,'fetch',()=>assert.fail('network forbidden'));
 const f=ledgerFixture(t);
 f.add('ordinary','Purchase Unit','Store Unit',{cents:10000,direction:'outflow'});
 f.add('income','Income Unit','Income Unit',{cents:7000});
 f.raw("UPDATE fin_transactions SET category='materials',category_basis_state='confirmed' WHERE txn_uid='ordinary'");
 const control=await ask(f,q);assert.ok(control.ledger,'bank control reached');
 if(field==='ranked-control') assert.deepEqual(control.ledger.rows.map(r=>r.amount_minor),[expected]);
 else if(field) assert.equal(control.ledger[field],expected);
 f.add('unproved','Card payment','Payment Unit',{cents:2500,direction:'outflow'});
 f.raw("UPDATE fin_transactions SET category='travel',category_basis_state='confirmed' WHERE txn_uid='unproved'");
 const b=await ask(f,q);

 if(field==='ranked-control') assert.deepEqual(b.ledger.rows.map(r=>r.amount_minor),[expected]);
 else if(field) assert.equal(b.ledger[field],expected,'original requested figure preserved');
 if(field) assert.ok(!(b.ledger.possible_payments || []).some(row=>row.amount_minor===2500 && row.included_in_total),'foreign posting is not marked included');
 if(field) assert.doesNotMatch(b.answer,/Counted in spending above, possibly a card payment: \$25\.00/,'unrelated outflow is not an operand of this answer');
 else assert.ok(b.ledger.rows.some(r=>r.amount_minor===2500),'ranked payment control is actually included');
});
