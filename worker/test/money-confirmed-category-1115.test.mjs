import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/clean-money-fixture.mjs';
import { queryMoney, validateMoneySql } from '../src/lib/money-query.js';
import { certifyMoneyQuery } from '../src/lib/money-query-certificate.js';
import { moneyTypeCertificate } from '../src/lib/money-type-certificate.js';
import { isRecognisedOperatingCategory } from '../src/lib/money-operating-categories.js';
import { handleMcp } from '../src/lib/mcp-endpoint.js';
import { withMoneyConfidence } from '../src/lib/money-query-contract.js';

const at=Date.parse('2026-11-15T19:00:00Z');
const period={period_from:'2026-10-01',period_to:'2026-10-31'};
const where="posted_on BETWEEN '2026-10-01' AND '2026-10-31'";
const operating=`SELECT SUM(income_minor)-SUM(expense_minor) AS operating_net FROM txn WHERE ${where}`;
const expense=`SELECT SUM(expense_minor) AS cents FROM txn WHERE ${where}`;
const cash=`SELECT SUM(amount_minor) AS cents FROM txn WHERE ${where} AND direction='outflow'`;
const dollars=minor=>(minor/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
function book(t) {
  const f=fixture(t);f.env.BRAIN_TIMEZONE='America/Phoenix';
  f.account('operating',{mode:'manual'});
  f.coverage('operating',period.period_from,period.period_to);
  return f;
}
async function query(f,sql,extra={}) {
  const before=f.calls.length;
  const r=await queryMoney(f.env,{sql,...period,...extra},{now:()=>at});
  assert.ok(f.calls.length>before && r.rows?.length,'the real migrated SQLite query and scoring decision were reached');
  assert.match(r.confidence_text,/Confidence: (High|Medium|Low) \(\d+%\).*Reasons:.*Missing:/s);
  assert.equal(r.confidence.may_only_lower,true);
  return r;
}
function qualified(r,minor,category) {
  assert.ok(r.confidence.percent<90,r.confidence_text);
  assert.ok(r.confidence_text.includes(dollars(minor)),'the affected category dollars are named');
  assert.ok(r.confidence_text.includes(category),'the contrary confirmed category is named');
  assert.match(r.confidence.missing.join(' '),/asset|principal|ownership|allocation/i);
}
const cases=[
  ['Q01',30000000,13590000,'Building purchase','FIXED_ASSETS','Seller'],
  ['Q02',30000000,23590000,'Land purchase','FIXED_ASSETS','Seller'],
  ['Q03',30000000,359000,'Equipment purchase','FIXED_ASSETS','Seller'],
  ['Q04',1000000,135900,'Customer payment on behalf of landlord','FUNDS_FOR_OTHERS','Property owner'],
  ['Q05',1000000,235900,'Service charge collected for lessor','FUNDS_FOR_OTHERS','Property owner'],
];
for(const [id,received,paid,memo,category,payee] of cases)test(`${id}: confirmed category outranks ordinary wording and survives both MCP boundaries`,async t=>{
  const f=book(t);
  if(category==='FUNDS_FOR_OTHERS') {
    f.run('DELETE FROM fin_account_coverage');f.coverage('operating','2026-09-01',period.period_to);
    f.row('held-principal','operating',paid,{day:'2026-09-20',payee:'Tenant',memo:'Security deposit received'});
  }
  f.row('earned','operating',received,{payee:'Customer',memo:'Management services invoice paid'});
  f.row('paid','operating',paid,{day:'2026-10-20',direction:'outflow',memo,payee,category});
  const checked=await validateMoneySql(operating,async sql=>f.db.prepare(sql).all());
  assert.equal(certifyMoneyQuery(checked).certified,true,'the reviewed operating-net SQL production is accepted');
  const r=await query(f,operating);
  assert.equal(r.rows[0].operating_net,received-paid,'the readable provisional figure survives the qualification');
  // Cash movement is a different measure: all debits remain available.
  const gross=await query(f,cash);assert.equal(gross.rows[0].cents,paid);
  const detail=await query(f,`SELECT txn_uid,amount_minor,expense_minor FROM txn WHERE ${where} AND direction='outflow'`);
  assert.equal(detail.rows[0].txn_uid,'paid');assert.equal(detail.rows[0].amount_minor,paid);
  assert.equal(detail.rows[0].expense_minor,paid,'this fix caps interpretation without silently rewriting membership');
  const local=withMoneyConfidence(r);
  assert.equal(local.confidence.percent,r.confidence.percent);
  assert.equal(local.rows[0].operating_net,received-paid);
  t.mock.method(Date,'now',()=>at);
  const before=f.calls.length,url=new URL('https://brain.invalid/mcp');
  const response=await handleMcp(f.env,new Request(url,{method:'POST',body:JSON.stringify({id:1,method:'tools/call',
    params:{name:'brain_money_query',arguments:{sql:operating,...period}}})}),url,{grant:{profile:'owner-assistant'}});
  const reply=(await response.json()).result;
  assert.equal(response.status,200);assert.notEqual(reply.isError,true);
  assert.ok(f.calls.length>before,'the remote MCP handler executed the real money query');
  const remote=JSON.parse(reply.content[0].text);
  assert.equal(remote.rows[0].operating_net,received-paid);
  assert.equal(remote.confidence.percent,r.confidence.percent);
  qualified(r,paid,category);qualified(remote,paid,category);qualified(local,paid,category);
  t.diagnostic(`${id}: provisional ${received-paid}; operating ${r.confidence.percent}%; gross outflow ${gross.rows[0].cents}`);
});

test('ordinary operating debits and receipts retain High, and gross outflows keep category-coded debits',async t=>{
  const f=book(t);
  f.row('earned','operating',30000000,{payee:'Customer',memo:'Management services invoice paid'});
  f.row('paid','operating',13590000,{direction:'outflow',payee:'Supply vendor',memo:'Packaging purchase',category:'OFFICE_SUPPLIES'});
  const ordinary=await query(f,operating);
  assert.equal(ordinary.rows[0].operating_net,16410000);assert.ok(ordinary.confidence.percent>=90,ordinary.confidence_text);
  const ordinaryCash=await query(f,cash);assert.equal(ordinaryCash.rows[0].cents,13590000);
  assert.ok(ordinaryCash.confidence.percent>=90,ordinaryCash.confidence_text);
  for(const category of ['FIXED_ASSETS','FUNDS_FOR_OTHERS','AGENCY_FUNDS']) {
    f.run('UPDATE fin_transactions SET category=? WHERE txn_uid=?',category,'paid');
    const gross=await query(f,cash);assert.equal(gross.rows[0].cents,13590000);
    assert.equal(gross.confidence.percent,95,gross.confidence_text);
    const restricted=await query(f,operating);
    assert.equal(restricted.rows[0].operating_net,ordinary.rows[0].operating_net);
    qualified(restricted,13590000,category);
  }
});

// Each representative covers an existing balance-sheet/agency category family,
// including singular/plural codes and the two missed source codes. This is a
// deterministic cross product, independent of the product's category matcher.
const categories=[
  'OWNER_DRAW','OWNERS_DRAWS',
  'FIXED_ASSETS','FIXED_ASSET','FUNDS_FOR_OTHERS','FUNDS_HELD_FOR_OTHERS',
  'CLIENT_FUNDS','CUSTOMER_FUNDS','TENANT_FUNDS','TRUST','TRUST_FUNDS','ESCROW',
  'CUSTODIAL_FUNDS','AGENCY_REMITTANCES','BENEFICIARY_PROCEEDS','THIRD_PARTY_FUNDS',
  'DEPOSIT','DEPOSITS','SECURITY_DEPOSIT','CUSTOMER_DEPOSITS','TENANT_DEPOSITS','REFUNDABLE_DEPOSIT',
  'LOAN_PAYABLE','LOAN_PRINCIPAL','LOAN_PAYMENTS','NOTE_PAYABLE','NOTES_PAYABLE','LIABILITY','LIABILITIES',
  'MEMBER_DISTRIBUTION','PARTNER_CONTRIBUTION','SHAREHOLDER_INVESTMENT',
  'OWNER_EQUITY','OWNER_CAPITAL','OWNER_PAY','CAPITAL_CONTRIBUTION','CAPITAL_INVESTMENT','CAPITAL_EQUITY',
  'TRANSFER','TRANSFERS','TRANSFER_IN_ACCOUNT_TRANSFER','TRANSFER_OUT_ACCOUNT_TRANSFER',
  'PERSONAL_EXPENSE','INCOME_TAX','ESTIMATED_TAX','DISTRIBUTION',
];
const wording=[
  'Purchase','Purchases','Invoice','Invoices','Supplies','Repair','Repairs','Service','Services','Fee','Fees',
  'Subscription','Subscriptions','Payroll','Wage','Wages','Salary','Sale','Sales','Commission','Commissions',
  'Customer payment','Client payments','Payment received','Invoice paid','Paid invoice','Payment for work','Office rent',
  'Customer payment on behalf of landlord','Service charge collected for lessor',
];
// These principal/asset families also occur in the existing kind/risk taxonomy.
const principalCategories=['LOAN_PROCEEDS','LOAN_DISBURSEMENT','LOAN_DISBURSEMENTS','LINE_OF_CREDIT_ADVANCE',
  'INVESTMENTS','TREASURY_BILLS','SECURITIES','BROKERAGE','HOLDINGS','RECEIVABLES','PAYABLES'];
test('source category taxonomy vetoes principal and investment codes after a closed-form promotion',()=>{
  let checked=0;
  for(const category of principalCategories)for(const memo of wording)for(const field of ['income_minor','expense_minor']) {
    const row={id:1,tenant_id:'primary',currency:'USD',payee:'Outside vendor',description:memo,category,category_basis_state:'confirmed',
      direction:field==='income_minor'?'inflow':'outflow',account_kind:'checking',account_identity:'operating',amount_minor:1};
    const args={rows:[row],decisions:[{id:1,money_kind:'ordinary',kind_proof:'form',estimated:0}],snapshot:{rows:[row]},scope:{},
      certificate:{certified:true,fields:[field]}};
    const control={...row,category:'OFFICE_SUPPLIES'};
    assert.equal(moneyTypeCertificate({...args,rows:[control],snapshot:{rows:[control]}}).length,0,'the ordinary closed-form control reaches and passes the boundary');
    assert.ok(moneyTypeCertificate(args).some(g=>g.why.includes(category) && g.why.includes('0.01')),
      `${category} / ${memo} / ${field}: a principal category survives closed-form proof`);
    checked++;
  }
  assert.equal(checked,principalCategories.length*wording.length*2);
});
test('property: category wording pairs retain provisional operating and cash figures',async t=>{
  const f=book(t);
  f.row('earned','operating',1000000,{memo:'Customer payment',payee:'Customer'});
  f.row('paid','operating',1,{direction:'outflow',day:'2026-10-20',memo:'Purchase',payee:'Outside vendor',category:'OFFICE_SUPPLIES'});
  const green=await query(f,expense);assert.equal(green.rows[0].cents,1);assert.ok(green.confidence.percent>=90,green.confidence_text);
  let checked=0;
  for(const category of categories) {
    for(const memo of wording) {
      // Shipped owner draws are excluded except for the existing fee-reading
      // path. Preserve both provisional readings; any counted fee must still
      // stay below High when its confirmed category contradicts that purpose.
      const ownerDraw=['OWNER_DRAW','OWNERS_DRAWS'].includes(category);
      const expected=ownerDraw && !['Fee','Fees','Service charge collected for lessor'].includes(memo)?0:1;
      f.run('UPDATE fin_transactions SET category=?,description=? WHERE txn_uid=?',category,memo,'paid');
      const r=await query(f,expense);
      assert.equal(r.rows[0].cents,expected,`${category} / ${memo}: preserve the existing operating contribution`);
      if(expected)qualified(r,1,category);
      checked++;
    }
    const gross=await query(f,cash);assert.equal(gross.rows[0].cents,1,`${category}: retain the cash debit`);
  }
  assert.equal(checked,categories.length*wording.length);
  t.diagnostic(`${checked} real SQL category/wording pairs, plus one gross-outflow check per category`);
});
test('property: final boundary vetoes every category, wording, proof and operating contribution',t=>{
  // The final boundary must also veto a prior promotion, including a refund or
  // an account/form proof. This forces the decision independently of early doubts.
  const proofs=['pair','code','account','form','party','original','role','matched_reversal','history','face_value','interest_group'];
  const fields=['income_minor','expense_minor','income_adjust_minor','sales_adjust_minor','refund_minor','interest_expense_minor'];
  let finalChecks=0;
  for(const category of [...categories,...principalCategories,...missedCategories])for(const memo of wording)for(const proof of proofs)for(const field of fields) {
    const row={id:1,tenant_id:'primary',currency:'USD',payee:'Outside vendor',description:memo,category,category_basis_state:'confirmed',
      direction:field==='income_minor'?'inflow':'outflow',account_kind:'checking',amount_minor:1,account_identity:'operating'};
    const decision={id:1,money_kind:'ordinary',kind_proof:proof,estimated:0,[field]:1};
    const args={rows:[row],decisions:[decision],snapshot:{rows:[row]},scope:{},
      certificate:{certified:true,fields:[field]}};
    const gaps=moneyTypeCertificate(args);
    assert.ok(gaps.length,`${category} / ${memo} / ${proof} / ${field}: category veto was reached`);
    assert.ok(gaps.some(g=>g.why.includes(category) && g.why.includes('0.01')),'the category and exact affected dollars survive prior proof');
    // Incoming rent has its own pre-existing ownership/earned-period risk.
    // Pair that arm with an ordinary receipt, retaining the rent safeguard.
    const ordinary={...row,category:'OFFICE_SUPPLIES',description:row.direction==='inflow' && memo==='Office rent'?'Customer payment':memo};
    const control=moneyTypeCertificate({...args,rows:[ordinary],snapshot:{rows:[ordinary]}});
    assert.equal(control.length,0,'the same complete ordinary proof without contrary category remains admissible');
    finalChecks++;
  }
  assert.equal(finalChecks,(categories.length+principalCategories.length+missedCategories.length)*wording.length*proofs.length*fields.length);
  t.diagnostic(`${finalChecks} final-boundary cases, each with a green control`);
});

test('operating category exceptions and unconfirmed source codes keep their existing ordinary paths',async t=>{
  const f=book(t);f.row('ordinary','operating',12345,{direction:'outflow',payee:'Supply vendor',memo:'Service invoice'});
  for(const category of ['CHARITABLE_CONTRIBUTIONS','PERSONAL_CARE','401K_EMPLOYER_CONTRIBUTIONS','FREIGHT_DISTRIBUTION','PARTNER_MARKETING','SALES_DEPOSITS']) {
    f.run('UPDATE fin_transactions SET category=? WHERE txn_uid=?',category,'ordinary');
    const r=await query(f,expense);assert.equal(r.rows[0].cents,12345);assert.ok(r.confidence.percent>=90,r.confidence_text);
  }
  f.run("UPDATE fin_transactions SET category='FIXED_ASSETS',category_basis_state='proposed' WHERE txn_uid='ordinary'");
  const proposed=await query(f,expense);assert.equal(proposed.rows[0].cents,12345);
  assert.ok(proposed.confidence.percent>=90,proposed.confidence_text);
});

test('the regression is registered exactly once in both offline command lists',async()=>{
  const {TEST_COMMANDS,POST_LAUNCHER_TEST_COMMANDS}=await import('../../scripts/run-test-chain.mjs');
  const {renderCliCommands}=await import('../../operations/cli-guidance.mjs');
  const command=renderCliCommands('node --test worker/test/money-confirmed-category-1115.test.mjs');
  for(const commands of [TEST_COMMANDS,POST_LAUNCHER_TEST_COMMANDS])assert.equal(commands.filter(value=>value===command).length,1);
});

const missedCategories=[
  'LAND','BUILDINGS','ASSET_PURCHASE','PROPERTY_AND_EQUIPMENT','FURNITURE_AND_FIXTURES',
  'LEASEHOLD_IMPROVEMENTS','CAPEX','REAL_ESTATE','RENT_COLLECTED_FOR_OWNERS','OWNER_PAYMENTS',
  'LANDLORD_PAYMENTS','PASS_THROUGH','DUE_TO_OWNERS','CLIENT_MONEY','FUNDS_FOR_OTHER','FundsForOthers','FIXEDASSETS',
  // A closed world must reject unknown labels even when they contain a valid
  // operating word or resemble a valid provider primary/detailed category.
  'UNMAPPED_BUCKET','ASSET_SERVICE','GENERAL_SERVICES_UNKNOWN_ALLOCATION','OFFICE_SUPPLIES_FOR_OTHERS',
];
for(const category of missedCategories)for(const direction of ['outflow','inflow'])
test(`F1: confirmed ${category} ${direction} needs a recognised operating type`,async t=>{
  const f=book(t);
  f.row('earned','operating',30000000,{payee:'Customer',memo:'Management services invoice paid'});
  f.row('paid','operating',13590000,{day:'2026-10-20',direction:'outflow',memo:'Land purchase',payee:'Seller'});
  const green=await query(f,operating);
  assert.equal(green.rows[0].operating_net,16410000);assert.equal(green.confidence.percent,95,green.confidence_text);
  const uid=direction==='outflow'?'paid':'earned',minor=direction==='outflow'?13590000:30000000;
  f.run('UPDATE fin_transactions SET category=? WHERE txn_uid=?',category,uid);
  const r=await query(f,operating);
  assert.equal(r.rows[0].operating_net,16410000,'keep the provisional figure while qualifying the type');
  t.diagnostic(`${category} ${direction}: provisional ${r.rows[0].operating_net}; confidence ${r.confidence.percent}%`);
  qualified(r,minor,category);
});

for(const category of ['FIXED_ASSETS','FUNDS_FOR_OTHERS','AGENCY_FUNDS'])
test(`F2: ${category} does not lower unrelated or gross cash confidence`,async t=>{
  const f=book(t);
  f.row('earned','operating',30000000,{payee:'Customer',memo:'Management services invoice paid'});
  f.row('supplies','operating',50000,{day:'2026-10-05',direction:'outflow',memo:'Packaging purchase',payee:'Supply vendor',category:'OFFICE_SUPPLIES'});
  f.row('paid','operating',13590000,{day:'2026-10-20',direction:'outflow',memo:'Equipment purchase',payee:'Seller',category:'OFFICE_SUPPLIES'});
  const checks=[
    ['money in',`SELECT SUM(income_minor) AS cents FROM txn WHERE ${where}`,30000000,95],
    ['gross money in',`SELECT SUM(amount_minor) AS cents FROM txn WHERE ${where} AND direction='inflow'`,30000000,95],
    ['gross outflow',cash,13640000,95],
    ['payee breakdown',`SELECT payee,SUM(amount_minor) AS cents FROM txn WHERE ${where} AND direction='outflow' GROUP BY payee ORDER BY cents DESC`,13590000,95],
    ['unrelated category',`SELECT SUM(amount_minor) AS cents FROM txn WHERE ${where} AND direction='outflow' AND category='OFFICE_SUPPLIES'`,50000,95],
    ['category breakdown',`SELECT category,SUM(amount_minor) AS cents FROM txn WHERE ${where} AND direction='outflow' GROUP BY category ORDER BY cents DESC`,13590000,89],
    ['excluded operating category',`${expense} AND category<>'${category}'`,50000,89],
  ];
  // Each query first reaches a complete ordinary book as a green control.
  // Only the unrelated-category figure changes when the large debit moves.
  for(const [name,sql,,percent] of checks) {
    const green=await query(f,sql);assert.ok(green.rows.length,name);
    assert.equal(green.confidence.percent,percent,green.confidence_text);
  }
  f.run('UPDATE fin_transactions SET category=? WHERE txn_uid=?',category,'paid');
  for(const [name,sql,minor,percent] of checks)await t.test(name,async()=>{
    const r=await query(f,sql);
    assert.equal(r.rows[0].cents,minor);
    t.diagnostic(`${category} ${name}: ${minor}; confidence ${r.confidence.percent}%`);
    assert.equal(r.confidence.percent,percent,r.confidence_text);
  });
  const restricted=await query(f,operating);
  assert.equal(restricted.rows[0].operating_net,16360000);qualified(restricted,13590000,category);
});

for(const category of ['LOAN_PAYMENTS','Loan payment','LOAN_PAYMENTS_MORTGAGE_PAYMENT'])
test(`F3: separately posted loan interest keeps High under ${category}`,async t=>{
  const f=book(t);
  f.account('borrowing',{mode:'manual',mask:'4242',kind:'loan'});
  f.coverage('borrowing',period.period_from,period.period_to);
  f.row('principal','borrowing',90000,{day:'2026-10-10',memo:'PRINCIPAL PAYMENT'});
  f.row('interest','borrowing',10000,{day:'2026-10-10',memo:'INTEREST PAYMENT'});
  const sql=`SELECT SUM(interest_expense_minor) AS cents FROM txn WHERE ${where}`;
  const green=await query(f,sql);assert.equal(green.rows[0].cents,10000);assert.equal(green.confidence.percent,95,green.confidence_text);
  f.run('UPDATE fin_transactions SET category=? WHERE account_slug=?',category,'borrowing');
  const r=await query(f,sql);assert.equal(r.rows[0].cents,10000);
  t.diagnostic(`${category}: interest ${r.rows[0].cents}; confidence ${r.confidence.percent}%`);
  assert.equal(r.confidence.percent,95,r.confidence_text);
});

test('recognised operating categories normalize complete labels without opening arbitrary suffixes',async t=>{
  const f=book(t);
  f.row('ordinary','operating',12345,{direction:'outflow',payee:'Supply vendor',memo:'Service invoice'});
  for(const category of [
    'OFFICE_SUPPLIES','office supply','OfficeSupplies','OFFICESUPPLIES','operating expenses','OperatingExpense',
    'GENERAL_SERVICES','GeneralService','GENERALSERVICES','GENERAL_SERVICES_OTHER','GENERAL_SERVICES_CONSULTING_AND_LEGAL',
    'GENERAL_MERCHANDISE_OFFICE_SUPPLIES','GeneralMerchandiseOfficeSupply','GENERALMERCHANDISEOFFICESUPPLIES',
    'FOOD_AND_DRINK','FOOD_AND_DRINK_COFFEE','FOOD_AND_DRINK_OTHER','RENT_AND_UTILITIES_RENT',
    'BANK_FEES','BANKFEE','BANK_FEES_INSUFFICIENT_FUNDS','ASSET_MANAGEMENT_FEES','SOFTWARE','ADVERTISING','INVENTORY','Inventories','EQUIPMENT','VEHICLES','Vehicle',
  ]) {
    assert.equal(isRecognisedOperatingCategory(category),true,category);
    f.run('UPDATE fin_transactions SET category=? WHERE txn_uid=?',category,'ordinary');
    const r=await query(f,expense);assert.equal(r.rows[0].cents,12345);assert.equal(r.confidence.percent,95,r.confidence_text);
  }
  for(const category of [...missedCategories,'FIXED_ASSETS','FixedAsset','FixedAssets','fixedasset','FUNDS_FOR_OTHERS',
    'FundsForOther','FUNDSFOROTHERS','FUNDSFOROTHER','generalservicescustom','loanpayments','INCOME_UNKNOWN',
    'UNKNOWN_SALES','RENT_AND_UTILITIES_UNKNOWN','OFFICESUPPLIESCLIENTMONEY'])
    assert.equal(isRecognisedOperatingCategory(category),false,category);
});

test('the loan-interest exception preserves every other category and evidence veto',()=>{
  const row={id:1,tenant_id:'primary',currency:'USD',payee:'Lender',description:'INTEREST PAYMENT',category:'LOAN_PAYMENTS',
    category_basis_state:'confirmed',direction:'inflow',account_kind:'loan',amount_minor:10000,account_identity:'borrowing'};
  const decision={id:1,money_kind:'loan_interest',kind_proof:'form',estimated:0,interest_expense_minor:10000};
  const args={rows:[row],decisions:[decision],snapshot:{rows:[row]},scope:{},certificate:{certified:true,fields:['interest_expense_minor']}};
  assert.deepEqual(moneyTypeCertificate(args),[],'a nonzero typed interest contribution reaches and passes the boundary');
  for(const changed of [
    {...args,decisions:[{...decision,money_kind:'ordinary'}]},
    {...args,decisions:[{...decision,money_kind:'loan_payment'}]},
    {...args,decisions:[{...decision,income_adjust_minor:10000}],certificate:{certified:true,fields:['income_adjust_minor']}},
    {...args,decisions:[{...decision,estimated:1}]},
    {...args,snapshot:{rows:[row],partial:true}},
    {...args,rows:[{...row,account_kind:'checking',category:'TRUST_FUNDS'}],decisions:[{...decision,kind_proof:'code'}]},
  ])assert.ok(moneyTypeCertificate(changed).length,'nonzero contributions still reach the independent veto');
});

test('positive recognition never removes the prior final category caps',()=>{
  for(const category of ['INCOME_TAX_REFUND','SALES_DEPOSIT','CHARITABLE_CONTRIBUTIONS_PAYABLE']) {
    const row={id:1,tenant_id:'primary',currency:'USD',payee:'Outside vendor',description:'Service invoice',category,
      category_basis_state:'confirmed',direction:'outflow',account_kind:'checking',amount_minor:1,account_identity:'operating'};
    const args={rows:[row],decisions:[{id:1,money_kind:'ordinary',kind_proof:'form'}],snapshot:{rows:[row]},scope:{},
      certificate:{certified:true,fields:['expense_minor']}};
    const control={...row,category:'OFFICE_SUPPLIES'};
    assert.equal(moneyTypeCertificate({...args,rows:[control],snapshot:{rows:[control]}}).length,0);
    assert.ok(moneyTypeCertificate(args).some(g=>g.why.includes(category)&&g.why.includes('0.01')));
  }
});

test('no-category representations keep the base High path',async t=>{
  const f=book(t);
  f.row('ordinary','operating',12345,{direction:'outflow',payee:'Supply vendor',memo:'Service invoice'});
  const green=await query(f,expense);assert.equal(green.rows[0].cents,12345);assert.equal(green.confidence.percent,95,green.confidence_text);
  for(const category of ['', '   ', null])await t.test(JSON.stringify(category),async()=>{
    f.run('UPDATE fin_transactions SET category=? WHERE txn_uid=?',category,'ordinary');
    const r=await query(f,expense);assert.equal(r.rows[0].cents,12345);assert.equal(r.confidence.percent,95,r.confidence_text);
  });
});

test('the final mapping uses the same detailed then primary source priority as the reader',()=>{
  const row={id:1,tenant_id:'primary',currency:'USD',payee:'Outside vendor',description:'Service invoice',category:'OFFICE_SUPPLIES',
    category_basis_state:'confirmed',direction:'outflow',account_kind:'checking',amount_minor:1,account_identity:'operating'};
  const args={decisions:[{id:1,money_kind:'ordinary',kind_proof:'form'}],scope:{},certificate:{certified:true,fields:['expense_minor']}};
  const check=r=>moneyTypeCertificate({...args,rows:[r],snapshot:{rows:[r]}});
  assert.deepEqual(check(row),[],'a nonzero ordinary contribution reaches the mapping');
  for(const contrary of [
    {...row,category_primary:'GENERAL_SERVICES',category_detailed:'ASSET_PURCHASE'},
    {...row,category_primary:'CLIENT_MONEY'},
  ])assert.ok(check(contrary).some(g=>g.why.includes(contrary.category_detailed||contrary.category_primary)&&g.why.includes('0.01')));
  assert.deepEqual(check({...row,category:'CLIENT_MONEY',category_primary:'FIXED_ASSETS',category_detailed:'GENERAL_SERVICES'}),[]);
});
