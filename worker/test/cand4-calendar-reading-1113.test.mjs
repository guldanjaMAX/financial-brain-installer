import test from 'node:test';
import assert from 'node:assert/strict';
import {ledgerFixture,NOW} from './ledger-review-fixture.mjs';
import worker from '../src/index.js';
for(const q of [
 'How much did I spend in Sepx 2026?', 'How much did I spend at the end of September 2026?',
 'How much did I spend at the end of September 2026 on account ending 1234?',
 'What did I spend at the end of September 2026?',
 'How much did I spend in Sepx 2026 on account ending 1234?',
 'What did I spend at the beginning of September 2026 on account ending 1234?',
 'What did I spend in the middle of September 2026?',
 'How much did I spend in the first week of September 2026?',
 'How much did I spend in the last week of September 2026?',
 'How much did I spend at Vendor Unit at the end of September 2026 on account ending 1234?',
]) test(q,async t=>{
 t.mock.method(Date,'now',()=>Date.parse(NOW));t.mock.method(globalThis,'fetch',()=>assert.fail('network forbidden'));
 const f=ledgerFixture(t);f.add('late-month','Purchase Unit','Vendor Unit',{cents:4200,direction:'outflow',date:'2026-09-28'});
 const ask=async q=>{const r=await worker.fetch(new Request('https://fixture.invalid/api/rag/think',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Key':f.env.ADMIN_KEY},body:JSON.stringify({q})}),f.env,{waitUntil(){}});return r.json();};
 const green=await ask('How much did I spend in September 2026?');assert.equal(green.ledger.total_minor,4200);
 if(q.includes('on account ending')) {
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at)
   SELECT 'other-account',entity_slug,account_kind,balance_role,'5678',feed_mode,provenance,source_feed,basis_state,recorded_at FROM fin_accounts WHERE account_slug='fixture-account'`);
  f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at)
   SELECT 'other-account',coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at FROM fin_account_coverage WHERE account_slug='fixture-account'`);
  f.add('other-account-purchase','Purchase Unit','Vendor Unit',{cents:9900,direction:'outflow',date:'2026-09-28'});
  f.raw("UPDATE fin_transactions SET account_slug='other-account' WHERE txn_uid='other-account-purchase'");
 }
 if(q.includes('at Vendor Unit')) f.add('other-payee','Purchase Unit','Other Unit',{cents:8800,direction:'outflow',date:'2026-09-28'});
 const before=f.calls.length;const b=await ask(q);console.log(JSON.stringify({q,figure:b.ledger?.total_minor,kind:b.ledger?.kind,gaps:b.gaps?.map(g=>g.reason),reads:f.calls.length-before}));
 assert.ok(f.calls.slice(before).some(sql=>/CROSS JOIN fin_transactions/.test(sql)), 'actual bounded bank decision reached');
 assert.ok(b.answer.trim(),'the owner answer decision reached');assert.equal(b.ledger?.total_minor,4200);
 assert.doesNotMatch(b.answer,/No charges found|withheld|cannot|can't/i);
 assert.equal(b.ledger.complete,false);assert.deepEqual([b.ledger.from,b.ledger.to],['2026-09-01','2026-09-30']);
 assert.match(b.confidence_text,/Confidence: Low \(0%\).*Why:.*Missing:/s);
 assert.match(b.answer,/Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
 if(q.includes('Sepx'))assert.match(b.answer,/read 'Sepx 2026' as September 2026/i);
 else assert.match(b.answer,/Time restriction not applied:.*full month of September 2026/s);
 assert.match(b.answer,/2026-09-01 through 2026-09-30/);
 assert.match(JSON.stringify(b.gaps),q.includes('Sepx')?/Confirmation of the intended month/:/intended.*dates or cutoff/i);
});
