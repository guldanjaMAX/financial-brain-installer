import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/clean-money-fixture.mjs';
import { queryMoney, handleMoneyQuery } from '../src/lib/money-query.js';
import { moneyGuideFor } from '../src/lib/money-query-contract.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const PERIOD = { period_from:'2026-10-01', period_to:'2026-10-31', time_zone:'UTC' };
const WINDOW = { from:PERIOD.period_from, through:PERIOD.period_to };
function book(t, { kind='loan', counterpart=true, category='LOAN_PROCEEDS', memo='Lender LOAN_PROCEEDS', payee='Lender' } = {}) {
  t.mock.method(Date,'now',()=>NOW);
  const f = fixture(t);
  f.account('operating',{mode:'manual'});
  f.account('borrowing',{kind,mask:'5555',mode:'manual'});
  for (const slug of ['operating','borrowing']) f.coverage(slug,PERIOD.period_from,PERIOD.period_to);
  f.row('purchases','operating',280619,{direction:'outflow',payee:'Supplier',memo:'Stock purchase',category:'PURCHASE'});
  f.row('draw-out','borrowing',450000,{direction:'outflow',payee,memo,category,day:'2026-10-04'});
  if (counterpart) f.row('draw-in','operating',450000,{payee,memo,category,day:'2026-10-04'});
  return {...f,read:sql=>queryMoney(f.env,{sql,...PERIOD},{now:()=>NOW})};
}

for (const kind of ['loan','line_of_credit']) test(`P2 ${kind}: the actual txn sum excludes both proved borrowing legs`,async t=>{
  const f=book(t,{kind});
  const pairs=await f.read('SELECT * FROM transfer_pairs');
  assert.equal(pairs.rows.length,1,'the unique opposite-direction candidate was reached');
  const sum=await f.read('SELECT SUM(expense_minor) AS cents FROM txn');
  assert.ok(f.calls.some(sql=>sql.includes('SUM(expense_minor) AS cents')),'the public aggregate reached SQLite');
  assert.equal(sum.rows[0].cents,280619,'$7,306.19 becomes $2,806.19 without a category filter');
  assert.equal(pairs.rows[0].proved,1);
  const result=await f.read('SELECT txn_uid,money_kind,movement_classification,expense_minor,income_minor,paid_minor,credited_minor,estimated FROM txn ORDER BY id');
  assert.equal(result.rows.length,3,'all observed postings remain readable');
  for(const row of result.rows.filter(r=>r.txn_uid.startsWith('draw-'))) {
    assert.equal(row.money_kind,'loan_proceeds');
    assert.equal(row.movement_classification,'own_transfer');
    assert.equal(row.expense_minor,0); assert.equal(row.income_minor,0); assert.equal(row.estimated,0);
    assert.equal(row.paid_minor,0); assert.equal(row.credited_minor,0,'a draw is not a repayment');
  }
});

test('P2 proved reciprocal locators establish a borrowing movement without a category',async t=>{
  const f=book(t,{category:null,memo:'TRANSFER TO ACCOUNT 1111',payee:null});
  f.run("UPDATE fin_transactions SET description='TRANSFER FROM ACCOUNT 5555' WHERE txn_uid='draw-in'");
  const result=await f.read('SELECT txn_uid,money_kind,expense_minor FROM txn ORDER BY id');
  assert.equal(result.rows.length,3);
  assert.deepEqual(result.rows.filter(r=>r.txn_uid.startsWith('draw-')).map(r=>[r.money_kind,r.expense_minor]),[['loan_proceeds',0],['loan_proceeds',0]]);
});

const locatorCases = [
  ['both endpoints conflict','TRANSFER TO ACCOUNT 9999','TRANSFER FROM ACCOUNT 8888'],
  ['outgoing endpoint conflicts','TRANSFER TO ACCOUNT 9999','TRANSFER FROM ACCOUNT 5555'],
  ['incoming endpoint conflicts','TRANSFER TO ACCOUNT 1111','TRANSFER FROM ACCOUNT 8888'],
  ['bilateral endpoint conflicts','TRANSFER FROM ACCOUNT 5555 TO ACCOUNT 9999','TRANSFER FROM ACCOUNT 5555 TO ACCOUNT 1111'],
  ['stated endpoint kind conflicts','TRANSFER TO SAVINGS ACCOUNT 1111','TRANSFER FROM ACCOUNT 5555'],
  ['endpoint direction conflicts','TRANSFER FROM ACCOUNT 1111','TRANSFER FROM ACCOUNT 5555'],
  ['proceeds endpoints conflict','LOAN PROCEEDS TO ACCOUNT 9999','LOAN PROCEEDS FROM ACCOUNT 8888'],
  ...['LOAN ADVANCE','CREDIT ADVANCE','LINE OF CREDIT ADVANCE','LOAN DISBURSEMENTS',
    'CREDIT PROCEEDS','LINE OF CREDIT DISBURSEMENT','LINE OF CREDIT PROCEEDS'].map(verb=>
    [`${verb.toLowerCase()} endpoints conflict`,`${verb} TO ACCOUNT 9999`,`${verb} FROM ACCOUNT 8888`,verb]),
  ['advance outgoing endpoint conflicts','LINE OF CREDIT ADVANCE TO ACCOUNT 9999','LINE OF CREDIT ADVANCE FROM ACCOUNT 5555','LINE OF CREDIT ADVANCE'],
  ['advance incoming endpoint conflicts','LINE OF CREDIT ADVANCE TO ACCOUNT 1111','LINE OF CREDIT ADVANCE FROM ACCOUNT 8888','LINE OF CREDIT ADVANCE'],
  ['advance bilateral endpoint conflicts','LINE OF CREDIT ADVANCE FROM ACCOUNT 5555 TO ACCOUNT 9999','LINE OF CREDIT ADVANCE FROM ACCOUNT 5555 TO ACCOUNT 1111','LINE OF CREDIT ADVANCE'],
  ['advance stated kind conflicts','LINE OF CREDIT ADVANCE TO SAVINGS ACCOUNT 1111','LINE OF CREDIT ADVANCE FROM ACCOUNT 5555','LINE OF CREDIT ADVANCE'],
  ['advance direction conflicts','LINE OF CREDIT ADVANCE FROM ACCOUNT 1111','LINE OF CREDIT ADVANCE FROM ACCOUNT 5555','LINE OF CREDIT ADVANCE'],
  ['unresolved directed vocabulary','BORROWING DRAW TO ACCOUNT 9999','BORROWING DRAW FROM ACCOUNT 8888','LINE OF CREDIT ADVANCE'],
  ['unresolved directed prefix','BANK LINE OF CREDIT ADVANCE TO ACCOUNT 9999','BANK LINE OF CREDIT ADVANCE FROM ACCOUNT 8888','LINE OF CREDIT ADVANCE'],
  ['unresolved directed suffix','LINE OF CREDIT ADVANCE TO','LINE OF CREDIT ADVANCE FROM','LINE OF CREDIT ADVANCE'],
  ['unresolved locator without direction','LINE OF CREDIT ADVANCE ACCOUNT 9999','LINE OF CREDIT ADVANCE ACCOUNT 8888','LINE OF CREDIT ADVANCE'],
  ['unresolved named destination','LINE OF CREDIT ADVANCE TOWARD RESERVE','LINE OF CREDIT ADVANCE ORIGIN RESERVE','LINE OF CREDIT ADVANCE'],
  ['unresolved named locator','BORROWING DRAW DESTINATION RESERVE','BORROWING DRAW ORIGIN RESERVE','LINE OF CREDIT ADVANCE'],
  ['payee endpoint conflicts','LOAN PROCEEDS','LOAN PROCEEDS','LINE OF CREDIT ADVANCE','LINE OF CREDIT ADVANCE TO ACCOUNT 9999'],
  ['payee direction conflicts with exact memos','TRANSFER TO ACCOUNT 1111','TRANSFER FROM ACCOUNT 5555','TRANSFER',
    ['TRANSFER FROM ACCOUNT 1111','TRANSFER FROM ACCOUNT 5555']],
];
for(const kind of ['loan','line_of_credit']) for(const [label,outMemo,inMemo,controlVerb,payeeMemo] of locatorCases)
  for(const control of [false,true]) test(`P23-B-01 ${kind} ${label}: ${control?'reciprocal control':'unproved dollars stay counted'}`,async t=>{
    const verb=controlVerb ?? (label==='proceeds endpoints conflict'?'LOAN PROCEEDS':'TRANSFER');
    const payees=control?[]:Array.isArray(payeeMemo)?payeeMemo:[payeeMemo,payeeMemo];
    const f=book(t,{kind,payee:payees[0] ?? null,memo:control?`${verb} TO ACCOUNT 1111`:outMemo});
    f.run('UPDATE fin_transactions SET description=?,payee=? WHERE txn_uid=?',control?`${verb} FROM ACCOUNT 5555`:inMemo,payees[1] ?? null,'draw-in');
    const pairs=await f.read('SELECT * FROM transfer_pairs');
    assert.equal(pairs.row_count,1,'the nonempty candidate reached the real pair decision');
    const pair=pairs.rows[0];
    assert.equal(pair.unique_match,1,'both opposite postings have a unique candidate');
    assert.equal(pair.out_matches,1); assert.equal(pair.in_matches,1);
    const sum=await f.read("SELECT SUM(expense_minor) AS cents FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'");
    assert.ok(f.calls.some(sql=>sql.includes('SUM(expense_minor) AS cents')),'the aggregate reached SQLite');
    assert.equal((await f.read('SELECT SUM(expense_minor) AS cents FROM txn')).rows[0].cents,sum.rows[0].cents,'the plain public sum retains the same membership');
    const result=await f.read('SELECT txn_uid,money_kind,movement_classification,expense_minor,estimated,estimate_reason FROM txn ORDER BY id');
    assert.equal(result.row_count,3,'all postings and the purchase control remain readable');
    const purchase=result.rows.find(r=>r.txn_uid==='purchases'),draw=result.rows.find(r=>r.txn_uid==='draw-out');
    assert.equal(purchase.expense_minor,280619,'the purchase control is preserved');
    assert.equal(purchase.estimated,0);
    t.diagnostic(JSON.stringify({kind,label,control,proved:pair.proved,total_minor:sum.rows[0].cents,
      draw_expense_minor:draw.expense_minor,estimated:draw.estimated,confidence:sum.confidence.line,
      confidence_text:sum.confidence_text}));
    assert.equal(pair.proved,Number(control),'categories cannot repair contradictory endpoint evidence');
    assert.equal(sum.rows[0].cents,control?280619:730619);
    assert.equal(draw.expense_minor,control?0:450000);
    assert.equal(draw.estimated,control?0:1);
    if(control) {
      assert.equal(sum.confidence.percent,95,'proved controls retain their original confidence');
      assert.equal(draw.money_kind,'loan_proceeds');
      assert.equal(draw.movement_classification,'own_transfer');
      assert.equal(draw.estimate_reason,null);
    } else {
      assert.equal(pair.evidence,null);
      assert.equal(draw.money_kind,'ordinary');
      assert.equal(draw.movement_classification,'unknown');
      assert.equal(draw.estimate_reason,'possible_loan_proceeds_counted');
      assert.ok(sum.confidence.percent<90,'unproved borrowing cannot be High');
      assert.match(sum.confidence_text,/4,500\.00/,'exact uncertain dollars reach the aggregate answer evidence');
      assert.match(sum.confidence.reasons.join(' '),/Account 5555:.*4,500\.00.*unproved/i);
      assert.match(sum.confidence.missing.join(' '),/counterpart statements/i,'the missing endpoint proof is named');
      assert.equal(sum.confidence.may_only_lower,true);
    }
  });

for(const kind of ['investment','retirement','escrow'])
  test(`P2 a proved borrowing movement into an owned ${kind} account is not spending`,async t=>{
    const f=book(t,{category:null,memo:'TRANSFER TO ACCOUNT 1111',payee:null});
    f.run("UPDATE fin_accounts SET account_kind=? WHERE account_slug='operating'",kind);
    f.run("UPDATE fin_transactions SET description='TRANSFER FROM ACCOUNT 5555' WHERE txn_uid='draw-in'");
    const pairs=await f.read('SELECT * FROM transfer_pairs');
    assert.equal(pairs.row_count,1,'the non-bank owned endpoint pair was reached');
    assert.equal(pairs.rows[0].proved,1,'exact reciprocal locators prove the movement');
    const result=await f.read('SELECT SUM(expense_minor) AS cents FROM txn');
    assert.equal(result.rows[0].cents,280619);
  });

for(const kind of ['investment','retirement','escrow'])
  test(`P2 generic codes toward an owned ${kind} account do not prove a borrowing movement`,async t=>{
    const f=book(t,{category:'TRANSFER',memo:'TRANSFER',payee:null});
    f.run("UPDATE fin_accounts SET account_kind=? WHERE account_slug='operating'",kind);
    const candidates=await f.read('SELECT * FROM transfer_pairs');
    assert.equal(candidates.row_count,1,'the non-bank candidate decision was reached');
    const result=await f.read("SELECT expense_minor,estimated,estimate_reason FROM txn WHERE txn_uid='draw-out'");
    assert.equal(result.row_count,1);
    assert.equal(result.rows[0].expense_minor,450000);
    assert.equal(result.rows[0].estimated,1);
    assert.equal(result.rows[0].estimate_reason,'possible_loan_proceeds_counted');
    assert.ok(result.confidence.percent<90);
    assert.match(result.confidence_text,/4,500\.00/);
  });

for (const arm of ['missing counterpart','competing counterpart','unconfirmed account','different currency','wording only','outside payee','unpaired locator','untyped debit','bank-code-only'])
  test(`P2 ${arm}: unproved borrowing stays counted with exact uncertain dollars`,async t=>{
    const f=book(t,{counterpart:arm!=='missing counterpart'});
    if(arm==='competing counterpart') f.row('competing','operating',450000,{day:'2026-10-04',payee:'Lender',memo:'Lender LOAN_PROCEEDS',category:'LOAN_PROCEEDS'});
    if(arm==='unconfirmed account') f.run("UPDATE fin_accounts SET basis_state='proposed' WHERE account_slug='borrowing'");
    if(arm==='different currency') f.run("UPDATE fin_transactions SET currency='EUR' WHERE txn_uid='draw-in'");
    if(arm==='wording only') f.run("UPDATE fin_transactions SET category_basis_state='proposed'");
    if(arm==='outside payee') f.run("UPDATE fin_transactions SET payee='Supplier' WHERE txn_uid='draw-in'");
    if(arm==='unpaired locator') {
      f.run("UPDATE fin_transactions SET description='TRANSFER TO ACCOUNT 1111',payee=NULL,category=NULL WHERE txn_uid='draw-out'");
      f.run("UPDATE fin_transactions SET removed_at='2026-10-05T12:00:00Z',removal_reason='provider removal' WHERE txn_uid='draw-in'");
    }
    if(arm==='untyped debit') {
      f.run("UPDATE fin_transactions SET description='ACH DEBIT',payee=NULL,category=NULL WHERE txn_uid='draw-out'");
      f.run("UPDATE fin_transactions SET removed_at='2026-10-05T12:00:00Z',removal_reason='provider removal' WHERE txn_uid='draw-in'");
    }
    if(arm==='bank-code-only') f.run("UPDATE fin_transactions SET description='TRANSFER',payee=NULL,category='TRANSFER' WHERE txn_uid LIKE 'draw-%'");
    const result=await f.read("SELECT * FROM txn WHERE txn_uid='draw-out'");
    assert.equal(result.rows.length,1,'the borrowing debit decision was reached');
    const row=result.rows[0];
    assert.equal(row.expense_minor,450000);
    assert.equal(row.estimated,1);
    assert.equal(row.estimate_reason,'possible_loan_proceeds_counted');
    assert.ok(result.confidence.percent<90);
    assert.match(result.confidence_text,/4,500\.00/,'the dollars at risk must reach the answer evidence');
    const sum=await f.read('SELECT SUM(expense_minor) AS cents FROM txn');
    assert.equal(sum.rows[0].cents,730619);
  });

test('P2 green controls: a bank category alone and an explicit liability purchase remain spending',async t=>{
  for(const [kind,counterpart] of [['checking',true],['loan',true],['loan',false]]) {
    const f=book(t,{kind,counterpart});
    if(kind==='loan')f.run("UPDATE fin_transactions SET category='PURCHASE',description='Stock purchase',payee='Supplier' WHERE txn_uid='draw-out'");
    const result=await f.read("SELECT expense_minor,estimated,estimate_reason FROM txn WHERE txn_uid='draw-out'");
    assert.equal(result.rows.length,1);
    assert.equal(result.rows[0].expense_minor,450000,'neither the category alone nor loan kind erases a purchase');
    if(kind==='checking') {
      assert.equal(result.rows[0].estimated,1,'a proceeds category alone leaves the counted bank debit uncertain');
      assert.ok(result.confidence.percent<90);
      assert.match(result.confidence_text,/4,500\.00/);
    }
    if(kind==='loan' && counterpart) {
      const candidates=await f.read('SELECT * FROM transfer_pairs');
      assert.equal(candidates.row_count,1,'the conflicting same-amount candidate was reached');
      assert.equal(candidates.rows[0].proved,0);
      assert.equal(result.rows[0].estimated,1,'an unproved opposite posting keeps purchase membership uncertain');
      assert.equal(result.rows[0].estimate_reason,'unmatched_leg_candidate');
      assert.ok(result.confidence.percent<90);assert.match(result.confidence_text,/\$4,500\.00/);
      assert.match(result.confidence_text,/Missing:.*(?:counterpart|statement)/is);
    }
    if(kind==='loan' && !counterpart) {
      assert.equal(result.rows[0].estimated,0,'an isolated explicit liability purchase keeps its certificate');
      const total=await f.read("SELECT SUM(expense_minor) AS cents FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'");
      assert.equal(total.rows[0].cents,730619);
      assert.equal(total.confidence.percent,95,'the purchase control remains High without a conflicting movement');
    }
  }
});

test('P2 conflicting payment-reversal evidence cannot become a certain new loan draw',async t=>{
  const f=book(t,{memo:'PAYMENT REVERSAL'});
  const result=await f.read('SELECT txn_uid,money_kind,estimated FROM txn ORDER BY id');
  assert.equal(result.row_count,3,'the contradictory coded pair and purchase control were read');
  const reversal=result.rows.find(r=>r.txn_uid==='draw-out');
  assert.equal(reversal.money_kind,'payment_reversal');
  assert.equal(reversal.estimated,1,'the missing original repayment remains a stated gap');
  assert.ok(result.confidence.percent<90);
});

function lifecycle(t) {
  const f=book(t,{counterpart:false});
  for(const [uid,amount,direction] of [['removed',999991,'inflow'],['superseded',888881,'outflow']])
    f.row(uid,'operating',amount,{direction,day:'2026-10-27',memo:'Lifecycle posting'});
  f.run("UPDATE fin_transactions SET removed_at='2026-10-28T12:00:00Z',removal_reason='provider removal' WHERE txn_uid='removed'");
  f.run("UPDATE fin_transactions SET superseded_by_id=(SELECT id FROM fin_transactions WHERE txn_uid='purchases') WHERE txn_uid='superseded'");
  return f;
}
test('P3 guide lifecycle recipe reads the real removed/superseded columns and amounts',async t=>{
  const f=lifecycle(t),guide=moneyGuideFor({now:NOW,timeZone:'UTC'});
  const recipe=guide.match(/\nLifecycle:[^\n]*\n([^\n]+)/)?.[1];
  assert.ok(recipe,'the documented lifecycle recipe exists');
  for(const column of ['pending','removed_at','removal_reason','superseded_by_id']) assert.ok(recipe.includes(column),column);
  const sql=recipe.replaceAll('2026-09-01',PERIOD.period_from).replaceAll('2026-09-30',PERIOD.period_to);
  const result=await f.read(sql);
  assert.ok(f.calls.some(q=>q.includes('removal_reason')),'the recipe reached SQLite');
  assert.deepEqual(result.rows.map(r=>[r.txn_uid,r.amount_minor]),[['removed',999991],['superseded',888881]]);
  const clean=await f.read("SELECT txn_uid FROM txn WHERE txn_uid IN ('removed','superseded')");
  assert.equal(clean.row_count,0,'lifecycle rows remain outside posted totals');
});

test('P3 pilot raw SQL succeeds with period metadata and no clean-view window',async t=>{
  const f=lifecycle(t);
  for(const sql of [
    "SELECT * FROM fin_transactions WHERE posted_on >= '2026-10-27' AND posted_on <= '2026-10-27'",
    "SELECT * FROM fin_transactions WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31' AND amount_minor IN (999991,888881,-999991,-888881)",
  ]) {
    const result=await f.read(sql);
    assert.equal(result.row_count,2,'both known lifecycle postings were actually read');
    assert.deepEqual(result.rows.map(r=>r.amount_minor),[999991,888881]);
  }
});

test('P3 failed lifecycle lookup says amount unknown and gives the precise raw-window recovery',async t=>{
  const f=lifecycle(t),sql="SELECT * FROM fin_transactions WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31' AND (removed_at IS NOT NULL OR superseded_by_id IS NOT NULL)";
  const reached=f.calls.length;
  const response=await handleMoneyQuery(f.env,new Request('https://fixture.invalid/query',{method:'POST',body:JSON.stringify({sql,...PERIOD,...WINDOW})}));
  const result=await response.json();
  assert.ok(f.calls.length>reached,'the failing query reached SQL validation');
  assert.equal(result.code,'MONEY_QUERY_INVALID'); assert.equal(result.reason,'window_raw_mix');
  assert.equal(result.rows,null); assert.equal(result.row_count,null);
  assert.match(result.error,/omit from\/through/i);
  assert.match(result.next_step,/amount unknown/i);
  assert.match(result.next_step,/never.*(?:\$0|none)/i);
  assert.equal(result.confidence.percent,0);
  const control=await f.read(sql);
  assert.equal(control.row_count,2,'the corrected request reads the nonzero green control');
});

test('P6 guide states combined-first totals and the separate-side default',()=>{
  const guide=moneyGuideFor({now:NOW,timeZone:'UTC'});
  assert.ok(/total, altogether, combined, overall, in all, everything/i.test(guide));
  assert.ok(/combined total first.*per-side split right under it/i.test(guide));
  assert.ok(/When no total is asked and no scope is named.*one labeled number per side.*never summed/.test(guide));
  assert.ok(/Keep tenants.*currencies separate/.test(guide));
});
