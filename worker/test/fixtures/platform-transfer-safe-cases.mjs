// Safe-design tables, expressed as executable synthetic books. Amounts are
// integer cents; role labels carry no owner identity or instance configuration.
const account=(slug,mask,kind='checking',extra={})=>({slug,mask,kind,mode:'live',...extra});
export const chk=account('chk','4821'),sav=account('sav','3307','savings');
const stripe=account('stripe','0001','merchant',{label:'Stripe Balance',institution:'Stripe'});
const row=(uid,acct,cents,memo,extra={})=>({uid,acct,cents,memo,day:'2026-10-06',dir:'inflow',prov:'feed',...extra});
const inflow=(cents,memo,extra={})=>row('in','chk',cents,memo,extra);
const outflow=(cents,memo,extra={})=>row('out','chk',cents,memo,{dir:'outflow',...extra});
const base=inflow(400000,'STRIPE PAYOUT',{uid:'sale',payee:'Stripe',day:'2026-10-03'});
const rent=amount=>outflow(amount,'RENT OCTOBER',{uid:'rent',payee:'Property owner',cat:'RENT'});
export const safeCases=[];
const add=(id,rows,expected,extra={})=>safeCases.push({id,accounts:[chk],rows,expected,measure:'income_minor',...extra});
for(const [id,cents,memo,payee,P] of [
  ['B7-1',100000,'STRIPE PAYOUT.',null,'stripe'],['B7-2',125000,'Stripe - Payout ST-ABC123',null,'stripe'],
  ['B7-3',40000,'SQUARE  PAYOUT',null,'square'],['B7-4',60000,'ACH CREDIT','Stripe-Inc','stripe'],
  ['B7-C1',194000,'STRIPE PAYOUT','Stripe','stripe'],['B7-C2',70003,'ACH sales settlement','Stripe, Inc.','stripe'],
  ['B7-C3',60009,'ACH sales settlement','SHOPIFY PAYMENTS','shopify'],['B7-C4',30000,'transfer from stripe',null,'stripe'],
  ['B7-C5',1800,'Stripe processing fee refund','Stripe','stripe']])
  add(id,[inflow(cents,memo,{payee,cat:id==='B7-C5'?'FEE_REFUND':id==='B7-C2'||id==='B7-C3'?'SALES':null})],id==='B7-C5'?0:cents,
    {measure:`CASE WHEN processor='${P}' THEN amount_minor ELSE 0 END`,control:id.includes('C')});
const payers=[inflow(100000,'STRIPE PAYOUT 1001',{uid:'p1'}),inflow(50000,'STRIPE PAYOUT.',{uid:'p2'}),inflow(25000,'Stripe-Payout 77',{uid:'p3'}),inflow(120000,'INVOICE 1042',{uid:'p4',payee:'Customer'})];
add('B7-5',payers,175000,{measure:"CASE WHEN payer_group='processor:stripe' THEN income_minor ELSE 0 END"});
add('B7-6',payers,295000,{control:true});

const annotated=[['A1',200000,'STRIPE PAYOUT NET OF REFUNDS','Stripe','TRANSFER_IN'],
  ['A2',150000,'Payout - net of refunds','Stripe',null],['A3',320000,'SHOPIFY PAYOUT 88213 LESS REFUNDS AND CHARGEBACKS',null,'TRANSFER_IN_DEPOSIT'],
  ['A5',70000,'PAYPAL TRANSFER LESS REFUNDS','PayPal',null],['A6',120000,'STRIPE DEPOSIT NET OF REFUNDS',null,null],
  ['A7',45000,'Transfer net of refunds and fees','Square',null],['A-C1',200000,'STRIPE PAYOUT NET OF REFUNDS','Stripe',null],
  ['A-C2',91000,'Stripe payout sales including refund adjustments','Stripe','SALES']];
for(const [id,cents,memo,payee,cat] of annotated) {
  const rows=[inflow(cents,memo,{payee,cat})];if(id==='A3')rows.push(inflow(680000,'CLIENT INVOICE 1042',{uid:'customer',payee:'Customer'}));
  add(id,rows,id==='A3'?1000000:cents,{control:id.startsWith('A-C')});
}
add('A1b',[inflow(200000,annotated[0][2],{payee:'Stripe',cat:'TRANSFER_IN'})],200000,{measure:'income_minor+sales_adjust_minor'});
add('A4',[inflow(90000,'STRIPE PAYOUT NET OF REFUNDS',{payee:'Stripe'}),row('out','sav',90000,'WITHDRAWAL',{dir:'outflow'})],90000,{accounts:[chk,sav]});
add('A-C3',[inflow(1800,'STRIPE REFUND',{payee:'Stripe'})],1800,{measure:'refund_minor',control:true});
add('A-C4',[inflow(188888,'Stripe payout batch 06',{payee:'Stripe'}),inflow(20000,'Stripe dispute won',{uid:'recovery',payee:'Stripe',cat:'CHARGEBACK_RECOVERY'})],208888,{measure:'income_minor+sales_adjust_minor',control:true});
add('A-C5',[inflow(7555,'Refund for supplies',{payee:'Supplier'})],7555,{measure:'refund_minor',control:true});

for(const [id,cents,memo,extra,other,spend] of [
 ['D1',12000,'STRIPE REFUND ch_3NX81',{},0,0],['D2',12000,'STRIPE REFUND ch_3NX81',{cat:'REFUND',cbs:'confirmed'},100000,100000],
 ['D3',25000,'SQUARE DISPUTE dp_77',{},75000,75000],['D4',25000,'SHOPIFY CHARGEBACK',{prov:'owner_stated',cbs:'proposed'},75000,75000],
 ['D5',8000,'Refund for order 1042',{payee:'PayPal'},92000,92000],['D6',50000,'STRIPE RESERVE HOLD',{payee:'Stripe'},150000,150000],
 ['D9',30000,'SHOPIFY ROLLING RESERVE',{},70000,70000]]) {
  const rows=[base,outflow(cents,memo,extra),...(other?[rent(other)]:[])];
  add(id,rows,spend,{measure:'expense_minor',belowHigh:id!=='D2'});
  if(id==='D1'||id==='D4')add(id+'b',rows,400000-cents,{measure:'income_minor+sales_adjust_minor',belowHigh:true});
}
const held=outflow(50000,'STRIPE RESERVE HOLD',{payee:'Stripe',day:'2026-10-05'}),released=inflow(50000,'STRIPE RESERVE RELEASE',{uid:'release',payee:'Stripe',day:'2026-10-28'});
add('D6b',[base,held,rent(150000)],200000,{measure:"CASE WHEN direction='outflow' AND money_kind<>'own_transfer' THEN amount_minor ELSE 0 END",belowHigh:true});
add('D7',[base,held,rent(150000),released],400000,{belowHigh:true});
add('D8',[base,released],450000,{belowHigh:true});
add('D10',[base,{...held,day:'2026-09-20'},released],400000,{belowHigh:true});
for(const [id,cents,memo,cat,payee,kind] of [
 ['D-C1',1500,'Stripe dispute fee','CHARGEBACK_FEE','Stripe'],['D-C2',15000,'SQUARE PAYOUT REVERSAL','PAYOUT_REVERSAL'],
 ['D-C3',15000,'Square customer refund','CUSTOMER_REFUND','Square'],['D-C4',900,'STRIPE CHARGEBACK PROTECTION',null,'Stripe'],
 ['D-C5',25000,'Shopify chargeback principal','CHARGEBACK','Shopify'],['D-C6',6000,'PAYPAL REFUND SERVICES INC'],
 ['D-C7',100000,'BUSINESS RESERVE DEPOSIT'],['D-C8',12000,'STRIPE REFUND',null,null,'card']])
 add(id,[base,{...outflow(cents,memo,{cat,payee}),acct:kind?'card':'chk'}],['D-C2','D-C3','D-C5'].includes(id)?0:cents,
   {measure:'expense_minor',control:true,accounts:kind?[chk,account('card','7777','card')]:[chk]});

// Transfer table rows use the table's months; accounts and coverage are shared.
const customer=(cents=200000,day='2026-10-14')=>inflow(cents,'Customer payment',{uid:'customer',day});
const transfer=(uid,acct,cents,memo,dir,day='2026-10-06',extra={})=>row(uid,acct,cents,memo,{dir,day,...extra});
const addTransfer=(id,rows,expected,extra={})=>add(id,rows,expected,{accounts:[chk,sav],...extra});
for(const [id,cents,memo,otherMemo,cat,otherCat,customerCents] of [
 ['B8-01',80000,'STRIPE PAYOUT','','TRANSFER_IN','TRANSFER_OUT',0],
 ['B8-02',200000,'MOBILE DEPOSIT','Transfer','TRANSFER_IN','TRANSFER_OUT',50000],
 ['B8-03',150000,'ATM CHECK DEPOSIT','Transfer to 4821',null,null,200000],
 ['B8-05',64025,'SQUARE TRANSFER 0422','Transfer','TRANSFER_IN',null,0],
 ['B8-06',150000,'ACH CREDIT SUPPLIER','', 'TRANSFER_IN','TRANSFER_OUT',200000],
 ['B8-07',150000,'DEPOSIT','WITHDRAWAL','TRANSFER_IN','TRANSFER_OUT',200000],
 ['B8-C1',150000,'','', 'TRANSFER_IN','TRANSFER_OUT',80000],
 ['B8-C2',100000,'','Transfer to 4821',null,null,100000],
 ['B8-C3',100000,'Transfer from 3307','Transfer to 4821',null,null,100000],
 ['B8-C5',80000,'STRIPE PAYOUT','Withdrawal',null,null,0],
 ['B8-C7',90000,'Online Transfer','Online Transfer','TRANSFER_IN','TRANSFER_OUT',80000]]) {
  const included=['B8-01','B8-02','B8-03','B8-05','B8-C5'].includes(id);
  addTransfer(id,[inflow(cents,memo,{cat}),transfer('out','sav',cents,otherMemo,'outflow','2026-10-06',{cat:otherCat}),...(customerCents?[customer(customerCents)]:[])],customerCents+(included?cents:0),
    {control:id.includes('-C'),belowHigh:!id.includes('-C')});
}
addTransfer('B8-04',[inflow(320000,'DIRECT DEP EMPLOYER CO',{cat:'TRANSFER_IN'}),transfer('out','sav',320000,'','outflow','2026-10-06',{cat:'TRANSFER_OUT'})],320000,{accounts:[{...chk,entity:'household'},{...sav,entity:'household'}],belowHigh:true});
addTransfer('B8-C4',[inflow(500000,'WIRE TRANSFER IN CUSTOMER CO',{payee:'Customer',cat:'TRANSFER_IN'}),transfer('out','sav',500000,'Transfer to 9001','outflow','2026-10-06',{cat:'TRANSFER_OUT'})],500000,{control:true});
addTransfer('B8-C6',[transfer('out','sav',300000,'Transfer to 4821','outflow','2026-09-27'),inflow(300000,'Transfer from 3307',{day:'2026-10-02'}),customer(100000)],100000,{control:true});

const merchantBase=[transfer('s1','stripe',50000,'Payment from customer ch_1','inflow','2026-10-02'),transfer('s2','stripe',52000,'Payment from customer ch_2','inflow','2026-10-03'),transfer('fee','stripe',3000,'Processing fee','outflow','2026-10-04',{cat:'BANK_FEES'})];
const merchantOut=(extra={})=>transfer('out','stripe',99000,'STRIPE PAYOUT','outflow','2026-10-05',{payee:'Stripe',...extra});
const merchantIn=(extra={})=>inflow(99000,'STRIPE PAYOUT',{payee:'Stripe',day:'2026-10-07',...extra});
const addSweep=(id,rows,expected,extra={})=>add(id,rows,expected,{accounts:[chk,stripe],...extra});
addSweep('B14-01',[...merchantBase,merchantOut(),merchantIn()],102000);
addSweep('B14-02',[...merchantBase,merchantIn()],102000,{belowHigh:true});
addSweep('B14-03',[...merchantBase,merchantOut(),merchantIn({day:'2026-10-09'})],102000,{belowHigh:true});
addSweep('B14-04',[...merchantBase,merchantOut(),merchantIn({day:'2026-10-09'})],3000,{measure:'expense_minor',belowHigh:true});
addSweep('B14-05',[{...merchantBase[1],cents:30000},merchantIn(),customer()],329000,{belowHigh:true});
const sq=account('sq','0002','point_of_sale',{label:'Square',institution:'Square'});
add('B14-06',[transfer('s1','sq',120000,'Card sales','inflow'),transfer('s2','sq',116520,'Transfer to bank account','outflow'),transfer('fee','sq',3480,'Square fees','outflow'),inflow(116520,'SQUARE INC',{payee:'Square Inc'})],120000,{accounts:[chk,sq]});
addSweep('B14-07',[...merchantBase,merchantOut({cents:20000,memo:'Refund to customer ch_9'}),merchantIn({cents:20000})],102000,{belowHigh:true});
addSweep('B14-08',[{...merchantBase[0],cents:100000},merchantOut({uid:'o1',cents:50000,day:'2026-10-03'}),merchantOut({uid:'o2',cents:50000}),merchantIn({uid:'i1',cents:50000,day:'2026-10-04'}),merchantIn({uid:'i2',cents:50000,day:'2026-10-06'})],100000,{belowHigh:true});
addSweep('B14-C1',[...merchantBase,merchantOut({cat:'TRANSFER'}),merchantIn({cat:'TRANSFER'})],102000,{control:true});
add('B14-C2',[merchantIn()],99000,{control:true});
addSweep('B14-C3',[inflow(185000,'Transfer from Stripe')],185000,{accounts:[chk,{...stripe,label:'Stripe'}],control:true});
addSweep('B14-C4',[{...merchantBase[0],cents:10000,day:'2026-01-10'},merchantIn()],99000,{control:true});
addSweep('B14-C5',[...merchantBase,{...merchantIn(),acct:'personal'}],201000,{accounts:[chk,stripe,account('personal','7710','checking',{entity:'household'})],control:true});
addSweep('B14-C6',[transfer('sale','proc',10000,'CUSTOMER SALES','inflow','2026-10-02',{cat:'GROSS_SALES'}),transfer('out','proc',9700,'Stripe payout to owner bank','outflow','2026-10-03',{payee:'Stripe',cat:'TRANSFER_OUT'}),inflow(9700,'Stripe payout from owner processor',{payee:'Stripe',cat:'TRANSFER_IN',day:'2026-10-03'})],10000,{accounts:[chk,account('proc','3333','merchant',{label:'proc'})],control:true});
// The B7 sweep control uses the same coded merchant book.
addSweep('B7-C6',[...merchantBase,merchantOut({cat:'TRANSFER'}),merchantIn({cat:'TRANSFER'})],102000,{control:true});

for(const [id,outMemo,inMemo,expected,extra] of [
 ['S3-01','Transfer to 4821','Online transfer from savings',200000],['S3-02','Transfer to checking','Transfer from 3307',200000],
 ['S3-05','Online transfer to checking','Online transfer from savings',200000,{belowHigh:true}],
 ['S3-06','Transfer from savings to checking','Transfer from savings to checking',200000,{belowHigh:true}],
 ['S3-C1','Online transfer to checking','Online transfer from savings',300000,{accounts:[chk,sav,account('sav2','9001','savings')],control:true}],
 ['S3-C3','Transfer to 4821','Transfer from checking',300000,{control:true}],
 ['S3-C4','Transfer to 4821','Online transfer from savings',300000,{payee:'Customer',control:true}],
 ['S3-C6','Online Transfer','Online Transfer',300000,{control:true}],
 ['S3-C8','TRANSFER TO CHK 4821 REF 88121','TRANSFER FROM SAV 3307 REF 88121',200000,{control:true}]])
 addTransfer(id,[transfer('out','sav',100000,outMemo,'outflow'),inflow(100000,inMemo,{payee:extra?.payee}),customer()],expected,extra);
addTransfer('S3-03',[outflow(75000,'Online Banking transfer to SAV Confirmation# 5551234'),transfer('in','sav',75000,'Transfer from CHK 4821 Confirmation# 5551234','inflow'),customer()],200000);
addTransfer('S3-04',[transfer('out','sav',200000,'Transfer to 4821','outflow','2026-09-30'),inflow(200000,'Transfer from savings',{day:'2026-10-02'}),customer(50000)],50000);
addTransfer('S3-07',[transfer('out','sav',100000,'Transfer to 4821','outflow'),inflow(100000,'Transfer from 3307'),customer(100000,'2026-10-06')],100000);
addTransfer('S3-C2',[...['05','07'].flatMap(d=>[transfer('o'+d,'sav',50000,'Transfer to 4821','outflow','2026-10-'+d),inflow(50000,'Transfer from 3307',{uid:'i'+d,day:'2026-10-'+d})]),customer()],200000,{control:true});
addTransfer('S3-C5',[outflow(50000,'TRANSFER TO ACCOUNT 3307',{day:'2026-09-30'}),transfer('in','sav',50000,'TRANSFER FROM ACCOUNT 4821','inflow','2026-10-01'),transfer('in2','sav',50000,'TRANSFER FROM ACCOUNT 4821','inflow','2026-09-27')],0,{control:true});
addTransfer('S3-C7',[outflow(43210,'',{cat:'TRANSFER_OUT'}),transfer('in','sav',43210,'','inflow','2026-10-08')],43210,{control:true});
