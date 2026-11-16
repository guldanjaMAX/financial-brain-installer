import test from 'node:test';
import assert from 'node:assert/strict';
import { book, scalar } from './helpers/platform-transfer-book.mjs';
import { processorSweepEstimates } from '../src/lib/clean-money-transfers.js';

const accounts=[{slug:'bank',kind:'checking',mask:'1111',mode:'live'},
  {slug:'saving',kind:'savings',mask:'2222',mode:'live'},
  {slug:'merchant',kind:'merchant',mask:'3333',label:'Stripe Balance',institution:'Stripe',mode:'live'}];
const r=(uid,acct,cents,memo,extra={})=>({uid,acct,cents,memo,day:'2026-10-05',dir:'inflow',prov:'feed',...extra});
const W="posted_on BETWEEN '2026-10-01' AND '2026-10-31'";
test('partial sweep disclosures cannot reuse sales across repeated bank payouts',()=>{
  const map=new Map(accounts.map(a=>[a.slug,{...a,account_slug:a.slug,account_kind:a.kind}]));
  const rows=[r('sale','merchant',30000,'Customer sale',{day:'2026-10-02'}),
    r('p1','bank',99000,'STRIPE PAYOUT'),r('p2','bank',99000,'STRIPE PAYOUT')]
    .map((row,i)=>({...row,id:i,effective_account_slug:row.acct,tenant_id:'primary',entity:'business',currency:'USD',posted_on:row.day,direction:row.dir,amount_minor:row.cents,description:row.memo}));
  const estimates=processorSweepEstimates(rows,map);
  assert.equal(estimates.get(1).covered_minor,'30000');assert.equal(estimates.get(2).covered_minor,'0');
  assert.ok([...estimates.values()].every(e=>e.funded===false));
});
async function withBook(input,fn) {const b=book(input);try{await fn(b);}finally{b.close();}}
test('repayment category on a bank deposit never certifies debt paid',async()=>{
  for(const [memo,cat] of [['BANKCARD DEPOSIT','CREDIT_CARD_PAYMENT'],['ACH CREDIT BORROWER','LOAN_PAYMENTS']])
    await withBook({accounts:accounts.slice(0,1),rows:[r('in','bank',80000,memo,{cat,payee:'Customer'})]},async b=>{
      const answer=await b.ask(`SELECT SUM(income_minor) income FROM txn WHERE ${W}`);
      assert.ok(answer.percent<90);
      const [row]=await b.dump();assert.equal(row.estimated,1);
      if(memo==='BANKCARD DEPOSIT')assert.equal(row.income_minor,80000);
      assert.ok(answer.reasons.length>0);
    });
});
test('unmatched owned locator retains exact excluded dollars and missing proof',async()=>{
  await withBook({accounts:accounts.slice(0,2),rows:[r('in','bank',160000,'Transfer from account 2222')]},async b=>{
    const answer=await b.ask(`SELECT SUM(income_minor) n FROM txn WHERE ${W}`);
    assert.equal(scalar(answer),0);assert.ok(answer.percent<90);
    const [row]=await b.dump();assert.equal(row.estimate_reason,'own_transfer_counter_entry_missing_excluded');
    assert.equal(row.amount_minor,160000);assert.equal(row.estimated,1);
  });
});
test('repeated coded transfers match only transfer candidates and retain the customer deposit',async()=>{
  const rows=[r('customer','bank',100000,'Customer payment',{payee:'Customer'})];
  for(const day of ['12','13','14'])rows.push(r('o'+day,'bank',50000,'Online transfer',{dir:'outflow',cat:'TRANSFER_OUT',day:'2026-10-'+day}),
    r('i'+day,'saving',50000,'Online transfer',{cat:'TRANSFER_IN',day:'2026-10-'+day}));
  await withBook({accounts:accounts.slice(0,2),rows},async b=>{
    const answer=await b.ask(`SELECT SUM(income_minor) income,SUM(expense_minor) expense FROM txn WHERE ${W}`);
    assert.deepEqual(answer.rows,[{income:100000,expense:0}]);
    assert.ok(answer.percent<90,'generic repeated codes stay likely');
    const dump=await b.dump();assert.equal(dump.filter(x=>x.money_kind==='own_transfer').length,6);
    assert.equal(dump.find(x=>x.txn_uid==='customer').money_kind,'ordinary');
  });
});
test('partly covered sweep discloses the sales dollars that might be counted twice',async()=>{
  await withBook({accounts:[accounts[0],accounts[2]],rows:[r('sale','merchant',30000,'Customer sale',{day:'2026-10-02',payee:'Customer'}),
    r('payout','bank',99000,'STRIPE PAYOUT',{payee:'Stripe'})]},async b=>{
    const before=b.db.prepare('SELECT total_changes() n').get().n;
    const {queryMoney}=await import('../src/lib/money-query.js');
    const result=await queryMoney(b.env,{sql:`SELECT SUM(income_minor) n FROM txn WHERE ${W}`,period_from:'2026-10-01',period_to:'2026-10-31'}, {now:()=>Date.parse('2026-11-01T12:00:00Z')});
    assert.equal(result.rows[0].n,129000);assert.ok(result.confidence.percent<90);
    const reasons=result.confidence.selection_gaps.flatMap(g=>g.reasons||[]);
    const sweep=reasons.find(r=>r.reason==='possible_processor_sweep_counted');
    assert.equal(sweep.possibly_repeated_sales_minor,'30000');assert.match(sweep.note,/300\.00/);
    assert.equal(sweep.treatment,'counted');
    assert.equal(b.db.prepare('SELECT total_changes() n').get().n,before);
  });
});
test('reserve matching cannot cross currency or platform',async()=>{
  for(const change of [{currency:'EUR'},{memo:'PAYPAL RESERVE RELEASE',payee:'PayPal'}])
    await withBook({accounts:accounts.slice(0,1),rows:[r('held','bank',50000,'STRIPE RESERVE HOLD',{dir:'outflow',payee:'Stripe'}),
      r('release','bank',50000,'STRIPE RESERVE RELEASE',{day:'2026-10-20',payee:'Stripe',...change})]},async b=>{
      const row=(await b.dump()).find(r=>r.txn_uid==='release');
      assert.equal(row.income_minor,50000);assert.equal(row.estimate_reason,'processor_reserve_release_counted');
    });
});
test('coded sweep cannot override conflicting structured platform identities',async()=>{
  await withBook({accounts:[accounts[0],accounts[2]],rows:[
    r('out','merchant',50000,'STRIPE PAYOUT',{dir:'outflow',payee:'Stripe',cat:'TRANSFER_OUT'}),
    r('in','bank',50000,'STRIPE PAYOUT',{payee:'PayPal',cat:'TRANSFER_IN'})]},async b=>{
    const answer=await b.ask(`SELECT SUM(income_minor) n FROM txn WHERE ${W}`);
    assert.equal(scalar(answer),50000);assert.ok(answer.percent<90);
    const rows=await b.ask('SELECT proved FROM transfer_pairs');assert.ok(rows.rows.every(r=>r.proved===0));
  });
});
test('a merchant account alone cannot prove an unrelated physical deposit is its sweep',async()=>{
  await withBook({accounts:[accounts[0],accounts[2]],rows:[
    r('out','merchant',50000,'',{dir:'outflow',cat:'TRANSFER_OUT'}),
    r('in','bank',50000,'MOBILE DEPOSIT',{cat:'TRANSFER_IN'})]},async b=>{
    const answer=await b.ask(`SELECT SUM(income_minor) n FROM txn WHERE ${W}`);
    assert.equal(scalar(answer),50000);assert.ok(answer.percent<90);
  });
});
test('a platform descriptor alone supplies a figure and attribution below High',async()=>{
  await withBook({accounts:accounts.slice(0,1),rows:[r('in','bank',77000,'ACH CREDIT STRIPE PAYOUT')]},async b=>{
    const answer=await b.ask(`SELECT SUM(income_minor) n FROM txn WHERE ${W}`);
    assert.equal(scalar(answer),77000);assert.ok(answer.percent<90);
    const [row]=await b.dump();assert.equal(row.processor,'stripe');assert.equal(row.payer_group,'processor:stripe');
  });
});
test('a combined chargeback principal and fee remains answered below High until split proof',async()=>{
  await withBook({accounts:accounts.slice(0,1),rows:[r('debit','bank',21500,'CHARGEBACK ORDER 1182 INCL 15.00 FEE',{dir:'outflow'})]},async b=>{
    const answer=await b.ask(`SELECT SUM(expense_minor) n FROM txn WHERE ${W}`);
    assert.equal(scalar(answer),21500);assert.ok(answer.percent<90);
    const [row]=await b.dump();assert.equal(row.estimate_reason,'processor_return_with_fee_unsplit_counted');
  });
});
