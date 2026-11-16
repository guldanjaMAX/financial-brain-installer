// Synthetic role-based cases from the three reviewed designs. Amounts below
// are dollars; the fixture converts them once to integer cents.
export const row=(account,direction,amount,memo,day=2,extra={})=>({account,direction,amount,memo,day:typeof day==='string'?day:`2026-10-${String(day).padStart(2,'0')}`,...extra});
const bank=(amount,memo,extra={})=>row('bank','inflow',amount,memo,15,extra);
const out=(amount,memo,extra={})=>row('bank','outflow',amount,memo,2,extra);
const testCase=(id,rows,expect={},extra={})=>({id,rows,expect,...extra});
const incomeBase=bank(10000,'client revenue');
export const incomeCases=[
 ['T1',50000,'ACH CREDIT BUSINESS LOAN FUNDING',{payee:'Lender Lending'},'possible_loan_proceeds_counted'],
 ['T2',20000,'ACH CREDIT',{payee:'Lender Lending Group'},'possible_loan_proceeds_counted'],
 ['T3',30000,'SBAD TREAS 310 MISC PAY EIDL',{payee:'Treasury'},'possible_loan_proceeds_counted'],
 ['T4',40000,'ACH CREDIT',{payee:'Funder',category:'LOAN_DISBURSEMENTS',proposed:true},'possible_loan_proceeds_counted'],
 ['T5',15000,'OWNER INVESTMENT',{payee:'Owner Person'},'possible_owner_money_counted'],
 ['T6',5000,'DEPOSIT FROM OWNER',{},'possible_owner_money_counted'],
 ['T7',25000,'SHAREHOLDER LOAN',{payee:'Owner Person'},'possible_owner_money_counted'],
 ['T8',12000,'SQUARE CAPITAL LOAN',{payee:'Square'},'possible_processor_advance_counted'],
 ['T9',8000,'PAYPAL WORKING CAPITAL',{payee:'PayPal'},'possible_processor_advance_counted'],
 ['T11',180,'CARD REWARDS REDEMPTION',{payee:'Bank'},'possible_rewards_redemption_counted'],
 ['T12',95,'CASH BACK REDEMPTION DEPOSIT',{category:'OTHER_INCOME'},'possible_rewards_redemption_counted'],
 ['T13',200000,'SBA LOAN DEPOSIT',{payee:'Funder'},'possible_loan_proceeds_counted'],
 ['T14',4000,'ACH CREDIT',{payee:'Customer'},null],
 ['T15',1000,null,{payee:'Customer'},null],
 ['T16',2400,'ACH DEPOSIT INV 118',{payee:'Customer LLC'},null],
 ['T17',3000,'MEMBER CONTRIBUTION',{payee:'Owner Person'},'possible_owner_money_counted'],
].map(([id,amount,memo,extra,reason])=>testCase(id,[incomeBase,bank(amount,memo,extra)],{income:10000+amount,likely:reason?amount:0,reason},{family:'income'}));
incomeCases.push(testCase('T10',[incomeBase,row('bank','outflow',900,'POS PURCHASE',3,{payee:'Vendor Supply Co'}),row('bank','outflow',600,'POS PURCHASE',12,{payee:'Vendor Supply Co'}),bank(250,'ACH CREDIT',{payee:'Vendor Supply Co'})],{income:10250,likely:250,reason:'possible_vendor_credit_counted'},{family:'income'}));
const incomeControl=(id,rows,expect={},extra={})=>testCase(id,[incomeBase,...rows],expect,{family:'income',control:true,...extra});
incomeCases.push(
 incomeControl('C1',[],{income:10000}),
 incomeControl('C2',[bank(3000,'STRIPE PAYOUT',{payee:'Stripe'})],{income:13000}),
 incomeControl('C3',[bank(12,'INTEREST PAID')],{income:10012}),
 incomeControl('C4',[bank(10,'CASHBACK',{payee:'lender',category:'OTHER_INCOME'})],{income:10010},{accounts:{card:{kind:'card',mask:'2222'}},lender:true}),
 incomeControl('C5',[bank(300,'NEW ACCOUNT BONUS',{payee:'Bank',category:'OTHER_INCOME'})],{income:10300}),
 incomeControl('C6',[bank(90000,'ACH CREDIT',{category:'LOAN_DISBURSEMENT'})],{income:10000}),
 incomeControl('C7',[bank(10000,'OWNER CONTRIBUTION')],{income:20000}),
 incomeControl('C8',[bank(900,'Loan proceeds',{category:'LOAN_DISBURSEMENT',proposed:true})],{income:10900}),
 incomeControl('C9',[bank(10,'SUPPLY REFUND',{category:'REFUND'})],{income:10000}),
 incomeControl('C10',[row('bank','outflow',100,'Customer refund',5,{payee:'Customer',category:'CUSTOMER_REFUND'}),bank(4000,'CLIENT INVOICE',{payee:'Customer'}),row('bank','inflow',3000,'CLIENT INVOICE',19,{payee:'Customer'})],{income:17000}),
 incomeControl('C11',[bank(500,'ACH CREDIT',{payee:'lender'})],{income:10500},{accounts:{card:{kind:'card',mask:'2222'}},lender:true}),
 incomeControl('C12',[bank(5000,'DEPOSIT')],{income:15000}),
 incomeControl('C13',[bank(6000,'CUSTOMER PAYMENT INVOICE 204',{payee:'Customer Lending Group'})],{income:16000}),
 incomeControl('C14',[row('card','inflow',12,'CARD REWARD CREDIT',15)],{income:10000},{accounts:{card:{kind:'card',mask:'2222'}}}),
 incomeControl('C15',[out(500,'ACH DEBIT',{payee:'Lender Lending'})],{income:10000,expense:500}),
 incomeControl('C16',[out(100,'ACH DEBIT',{payee:'Customer'}),bank(4000,'ACH CREDIT',{payee:'Customer'}),row('bank','inflow',3000,'ACH CREDIT',19,{payee:'Customer'})],{income:17000})
);
const cardIn=(amount,memo='PAYMENT THANK YOU',day=10)=>row('card','inflow',amount,memo,day);
const cardOut=(amount,memo,day=13,extra={})=>row('card','outflow',amount,memo,day,extra);
const rin=(amount,memo,day=3,extra={})=>row('bank','inflow',amount,memo,day,extra);
const rout=(amount,memo,day=7,extra={})=>row('bank','outflow',amount,memo,day,extra);
const rev=(id,rows,expect,control=false)=>testCase(id,rows,expect,{family:'reversal',control,accounts:{card:{kind:'card',mask:'4444'},loan:{kind:'loan',mask:'7777'},saving:{kind:'savings',mask:'2222'}}});
const paidRows=[cardIn(500),cardOut(500,'PAYMENT RETURNED'),cardOut(300,'RESTAURANT SUPPLY',15,{category:'FOOD_AND_DRINK_OTHER'})];
const returnedCard=memo=>[rin(2000,'CLIENT PAYMENT CUSTOMER',6),rout(500,'Payment to card 4444',10),rin(500,memo,13)];
export const reversalCases=[
 rev('P1',paidRows,{expense:300}),rev('P2',paidRows,{paid:0}),
 rev('P3',[cardIn(500,'AUTOPAY PAYMENT'),cardOut(500,'REVERSAL OF PAYMENT NSF',12)],{expense:0}),
 rev('P4',[cardIn(500,'ONLINE PYMT THANK YOU'),cardOut(500,'ONLINE PYMT REVERSED',11)],{paid:0}),
 rev('P5',[cardOut(250,'PAYMENT RETURNED')],{expense:0,lastReason:'payment_reversal_original_missing'}),
 rev('P6',[row('loan','inflow',1200,'PAYMENT RECEIVED',5),row('loan','outflow',1200,'PMT REVERSAL INSUFFICIENT FUNDS',8)],{paid:0}),
 rev('P7',returnedCard('CARD PYMT REVERSED'),{net:0}),rev('P8',returnedCard('PAYMENT RETURNED CARD 4444'),{income:2000}),
 rev('P9',[rin(640,'AUTOPAY RETURNED',9)],{income:0,lastEstimated:1}),
 rev('P10',[rin(500,'PAYMENT REVERSAL',9)],{net:-500},true),
 rev('P11',[rout(500,'ACH DEBIT VENDOR CO',5),rin(500,'PAYMENT REVERSAL',8)],{net:0},true),
 rev('P12',[rout(900,'IRS TAX RETURN PAYMENT',9)],{expense:900},true),
 rev('P13',[cardIn(39,'LATE PAYMENT FEE REVERSAL',9)],{income:0,net:-39},true),
 rev('P14',[cardIn(500),cardOut(500,'RETURNED PAYMENT'),cardOut(300,'RESTAURANT SUPPLY',15,{category:'FOOD_AND_DRINK_OTHER'})],{expense:300,paid:0},true),
 rev('P15',[cardOut(89,'PAYMENT REVERSAL SOFTWARE CO',9)],{expense:89},true),
 rev('A1',[rin(800,'Mobile deposit check 2231'),rout(800,'RETURNED DEPOSITED ITEM'),rout(12,'Returned item fee',7,{category:'BANK_FEES'})],{income:0,expense:12}),
 rev('A2',[rin(800,'Mobile deposit check 2231'),rout(800,'RETURN ITEM CHARGEBACK')],{income:0,sales:0}),
 rev('A3',[rin(450,'REMOTE DEPOSIT'),rout(450,'DEPOSITED CHECK RETURNED UNPAID 2231',6)],{income:0}),
 rev('A4',[rin(450,'REMOTE DEPOSIT'),rout(450,'NSF RETURNED DEPOSITED ITEM',6)],{expense:0}),
 rev('A5',[rin(450,'Mobile deposit check 2231','2026-09-28'),rout(450,'RETURNED DEPOSITED ITEM',2),rin(3000,'ACH CREDIT CUSTOMER CO',10)],{income:2550}),
 rev('A6',[rin(800,'Mobile deposit check 2231'),rout(800,'DEPOSITED ITEM RETURNED NSF'),rout(12,'Returned item fee',7,{category:'BANK_FEES'})],{income:0,expense:12},true),
 rev('A7',[cardOut(500,'ACH REVERSAL CUSTOMER CO')],{income:0,expense:500},true),
 rev('A8',[rout(12,'RETURNED ITEM FEE'),rout(15,'CHARGEBACK FEE')],{expense:27},true),
 rev('A9',[rout(1500,'SECURITY DEPOSIT RETURN TENANT B')],{expense:1500,membership:{movement_classification:'unknown',estimated:1,estimate_reason:'possible_refundable_principal_counted'}},true),
 rev('A10',[rin(1500,'STRIPE PAYOUT',3,{payee:'Stripe'}),rout(220,'ACH DEBIT',7,{category:'PAYOUT_REVERSAL'})],{income:1280},true),
 rev('A11',[rout(250,'STRIPE CHARGEBACK')],{sales:-250},true),
 rev('A12',[rout(650,'PROVISIONAL CREDIT REVERSAL')],{refund:-650},true),
 rev('B1',[rin(2000,'ACH CREDIT CUSTOMER CO',1),rout(2000,'ACH RETURN CUSTOMER CO',3)],{income:0,expense:0}),
 rev('B2',[rin(1200,'REMOTE DEPOSIT',2),rout(1200,'RETURNED CHECK 2231',5)],{income:0}),
 rev('B3',[rin(650,'ACH CREDIT CLIENT B',2),rout(650,'PAYMENT REVERSAL',4)],{income:0}),
 rev('B4',[rin(1200,'RENT DEPOSIT',1),rin(1200,'RENT DEPOSIT',2),rin(1200,'RENT DEPOSIT',3),rout(1200,'RETURNED ITEM',6)],{income:2400,expense:0}),
 rev('B5',[rout(35,'RETURNED ITEM NSF',6)],{expense:35},true),
 rev('B6',[rout(2000,'ACH RETURN CUSTOMER CO',3)],{expense:2000,lastReason:'possible_deposit_reversal_counted'}),
 rev('B7',[row('saving','outflow',1000,'TRANSFER TO ACCOUNT 1111',1),rin(1000,'TRANSFER FROM ACCOUNT 2222',1),rin(3000,'ACH CREDIT CUSTOMER CO',2),rout(1000,'ACH REVERSAL',4)],{income:3000,expense:0,lastReason:'deposit_reversal_original_not_income'}),
 rev('B8',[rout(2000,'ACH REVERSAL CUSTOMER CO',3)],{income:-2000},true),
 rev('B9',[rin(800,'REMOTE DEPOSIT',2),rout(35,'RETURNED ITEM',5)],{income:800,expense:35},true),
 rev('B10',[cardOut(400,'ACH RETURN VENDOR CO')],{expense:400},true),
 rev('B11',[rin(900,'ACH CREDIT CLIENT B',2),rout(900,'CUSTOMER PAYMENT REVERSED',5)],{income:0}),
 rev('B12',[rin(700,'ACH CREDIT CLIENT B','2026-09-29'),rout(700,'ACH CREDIT RETURNED CLIENT B',2),rin(4000,'ACH CREDIT CUSTOMER CO',10)],{income:3300}),
 rev('D1',[rout(1500,'CHECK 1042',5),rin(1500,'RETURNED CHECK 1042',8)],{income:0,net:0,lastReason:'returned_payment_needs_reconciliation'}),
 rev('D2',[rout(1500,'CHECK 1042',5),rin(1500,'RETURNED CHECK 1042',8,{payee:'Landlord Co'})],{income:0}),
 rev('D3',[rout(220,'ACH DEBIT UTILITY CO',5),rin(220,'RETURNED ACH DEBIT',7)],{income:0,net:0}),
 rev('D4',[rin(75,'CHECK REVERSAL',8)],{refund:75},true),
 rev('D5',[rin(300,'RETURNED PURCHASE STORE 12',8)],{refund:300},true),
 rev('D6',[rin(1000,'SECURITY DEPOSIT RETURNED',8)],{income:0,refund:1000,membership:{estimated:1,estimate_reason:'possible_refundable_principal_counted'}},true),
 rev('D7',[rin(900,'TAX RETURN CHECK DEPOSIT',8)],{income:900},true),
 rev('D8',[cardIn(400,'RETURNED CHECK',8)],{income:0},true),
 rev('D9',[rout(640,'CHECK 1043',5),rin(640,'CHECK RETURNED NSF 1043',9)],{income:0}),
 rev('D10',[rout(310,'BILL PAYMENT UTILITY CO',5),rin(310,'RETURNED BILL PAYMENT',7)],{income:0}),
 rev('D11',[rout(1500,'CHECK 1042',5),rin(1500,'RETURNED CHECK 1042',8)],{expense:1500,refund:1500}),
 rev('D12',[rin(60,'RETURN CREDIT STORE 12',8)],{refund:60},true),
 rev('E1',[rin(500,'CLIENT PAYMENT CUSTOMER',6),rout(500,'RETURNED PAYMENT',9)],{income:0}),
 rev('E2',[rout(500,'RETURNED PAYMENT',9)],{income:0,expense:0},true),
 rev('E3',returnedCard('RETURNED PAYMENT CARD 4444'),{income:2000},true),
 rev('E4',[rin(500,'CLIENT PAYMENT CUSTOMER',5),rin(500,'CLIENT PAYMENT OTHER CUSTOMER',6),rout(500,'RETURNED PAYMENT',9)],{income:1000},true),
 rev('G1',[rin(800,'Mobile deposit check 2231'),rout(800,'RETURNED DEPOSITED ITEM')],{income:0,guideIncome:0,reversed:800}),
 rev('G2',[rin(100,'CUSTOMER REVENUE',3,{category:'INCOME'})],{income:100,guideIncome:100,reversed:0},true),
];
const debtBase=out(9000,'OFFICE SUPPLY CO');
const debt=(id,memo,expect,control=false,extra={})=>testCase(id,[debtBase,row(extra.account||'bank',extra.direction||'outflow',extra.amount||1000,memo,2,extra.rowExtra)],{expense:10000,...expect},{family:'debt',control,...extra});
export const debtCases=[
 ...['ACH DEBIT SBA EIDL LOAN PMT','LENDER BANK MORTGAGE PAYMENT','ACH DEBIT PAYMENT TO LENDER AUTO LOAN','HELOC PMT WEB 4455','EQUIPMENT LENDER PYMT','NOTE PMT 0042','LINE OF CREDIT PAYMENT ONLINE','LOAN PRINCIPAL PAYMENT 0042','CARD ISSUER CREDIT CARD ONLINE PMT'].map((memo,i)=>debt('B'+(i+1),memo,{reason:'possible_'+(i===8?'card':'loan')+'_payment_wording_counted',uncertain:1000})),
 ...['LOAN PAYMENT LATE FEE','MORTGAGE INTEREST PAYMENT','DEBIT CARD PAYMENT TO CORNER CAFE','MORTGAGE ESCROW PAYMENT','LOANSTAR SUPPLY PAYMENT','MERCHANT SERVICES CREDIT CARD PAYMENT PROCESSING','LOAN PAYMENT LENDER CO','LENDER CREDIT CARD PMT'].map((memo,i)=>debt('BC'+(i+1),memo,{},true)),
 debt('BC9','PAYMENT TO LOAN 4321',{expense:9000,paid:1000},true,{accounts:{loan:{kind:'loan',mask:'4321'}}}),
 debt('BC10','LENDER BANK MORTGAGE PAYMENT',{expense:9000},true,{direction:'inflow'}),
 debt('BC11','LENDER BANK MORTGAGE PAYMENT',{},true,{account:'card',accounts:{card:{kind:'card',mask:'3333'}}}),
 ...['LOAN PMT PRIN 939.85 INT 310.15','MORTGAGE PAYMENT - PRINCIPAL $1,000.00 INTEREST $250.00','Loan Payment Interest 310.15 Principal 939.85','LENDER BANK LOAN PAYMENT PRINCIPAL 939.85 INTEREST 310.15','SBA LOAN PYMT PRINCIPAL 939.85 AND INTEREST 310.15','HELOC PAYMENT PRIN 939.85 INT 310.15 USD'].map((memo,i)=>debt('S'+(i+1),memo,{expense:10250,interest:i===1?250:310.15,paid:1250,lastReason:'memo_split_needs_statement_counted'},false,{amount:1250})),
 ...['LOAN PAYMENT PRINCIPAL 939.85 INTEREST 310.15','LOAN PAYMENT PRINCIPAL 939.84 INTEREST 310.15','MORTGAGE PAYMENT PRINCIPAL 700.00 INTEREST 300.00 ESCROW 250.00','LOAN PAYMENT PRINCIPAL 900.00 INTEREST 300.00 LATE FEE 50.00','LOAN PAYMENT PRINCIPAL 939.85 INTEREST 310.15','LOAN PMT P 939.85 I 310.15','LOAN PAYMENT PRINCIPAL 0.00 INTEREST 1250.00','LENDER BANK LOAN PAYMENT PRINCIPAL 900.00 INTEREST 300.00'].map((memo,i)=>debt('SC'+(i+1),memo,{expense:i===4?9000:10250,interest:i===0?310.15:i===6?1250:0},i!==7,{amount:1250,...(i===4?{direction:'inflow'}:{})})),
 debt('A1','LENDER BANK MORTGAGE PAYMENT',{reason:'possible_loan_payment_wording_counted',uncertain:1000}),
 debt('A2','LENDER BANK MORTGAGE PAYMENT',{paid:0,uncertain:1000}),
 debt('A3','LENDER BANK LOAN PAYMENT PRINCIPAL 939.85 INTEREST 310.15',{expense:10250,interest:310.15,paid:1250},false,{amount:1250}),
 debt('A4','MORTGAGE INTEREST PAYMENT',{},true),
];
export const cases=[...incomeCases,...reversalCases,...debtCases];
export function populate(f,c){
 f.account('bank',{mode:'manual'});f.coverage('bank','2026-09-01','2026-10-31');
 for(const [slug,opts] of Object.entries(c.accounts||{})){f.account(slug,{mode:'manual',...opts});f.coverage(slug,'2026-09-01','2026-10-31');}
 if(c.lender)f.run("UPDATE fin_accounts SET label='lender' WHERE account_slug='card'");
 c.rows.forEach((r,i)=>{f.row(String(i),r.account,Math.round(r.amount*100),{day:r.day,direction:r.direction,memo:r.memo,payee:r.payee,category:r.category,currency:r.currency});if(r.proposed)f.run("UPDATE fin_transactions SET category_basis_state='proposed' WHERE txn_uid=?",String(i));});
}
export const detailSql='SELECT txn_uid,money_kind,movement_classification,estimated,estimate_reason,uncertain_kind,uncertain_minor,processor,payer_group,income_minor,expense_minor,paid_minor,refund_minor,sales_adjust_minor,interest_stated_minor,income_adjust_minor,payment_kind FROM txn ORDER BY id';
