import {fixture} from '../ledger-review-fixture.mjs';
export const shapes = [
 ['How much money is in the bank?', 'How much mony do I have in the bank?', 'Whats my total bank balnce?'],
 ['What is the balance in Practice Checking?', 'Whats in my busines checking account?', 'How much is in Practice Checking balnce?'],
 ['How much came in this month?', 'How much mony came in this month?', 'What came into my acounts this month?'],
 ['How much came in last month?', 'How much mony came in last month?', 'What came into my acounts last month?'],
 ['What did I spend last month, and on what?', 'What did I spend last month and on waht?', 'Show my spendng last month by category'],
 ['How much did I spend at Amazon in the last 3 months?', 'How much did I spend at Amazon in the last 3 monts?', 'Whats my Amazon spendng for the last three months?'],
 ['How much do I pay Clearline Internet each month?', 'How much do I pay Clearline Internet each mnth?', 'Whats my monthly Clearline Internet chrge?'],
 ['Did Cedar pay the invoice?', 'Did Cedar pay the invioce?', 'Has Cedars invoice been piad?'],
 ['What were my biggest expenses last month?', 'What were my bigest expenses last month?', 'Show my largest purchses last month'],
 ['Who paid me last month?', 'Who piad me last month?', 'Show who sent me mony last month'],
];
export function makeLedger(seed, t) {
 const f=fixture(t); f.owner('practice');
 f.raw("INSERT INTO fin_entities(entity_slug,legal_name,display_label,kind,status,relationship,provenance,basis_state,recorded_at) VALUES ('personal','Synthetic household','Synthetic household','person','active','owned','owner_stated','confirmed','2026-11-03')");
 const accounts=[['business','practice','checking','asset','1111','Practice Checking',500000],['personal','personal','checking','asset','2222','Daily Checking',170000],['savings','personal','savings','asset','3333','Rainy Savings',830000],['card','personal','card','liability','4444','Daily Card',23000]];
 for(const [slug,entity,kind,role,mask,label,balance] of accounts){
 f.raw("INSERT INTO fin_accounts(account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at) VALUES (?,?,?,?,?,?,'manual','owner_stated','confirmed','2026-11-03')",slug,entity,kind,role,mask,label);
 f.raw("INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at) VALUES (?,? ,?,'2026-11-03','2026-11-03','owner_stated','confirmed','2026-11-03')",slug,slug==='savings'?'partial':'complete',slug==='savings'?'2026-10-15':'2026-07-01');
 f.raw("INSERT INTO fin_balance_snapshots(account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at) VALUES (?,'2026-11-03',?,'owner_stated','confirmed','2026-11-03')",slug,balance+seed);
 }
 let state=seed; const next=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state%4000;};
 const rows=[]; const add=(id,account,date,cents,direction,payee,description=payee,tag='expense')=>{
 const r={id,account,date,cents,direction,payee,description,tag};rows.push(r);
 f.raw("INSERT INTO fin_transactions(txn_uid,account_slug,posted_on,amount_minor,direction,payee,description,provenance,basis_state,recorded_at) VALUES (?,?,?,?,?,?,?,'owner_stated','confirmed','2026-11-03')",id,account,date,cents,direction,payee,description);
 };
 for(const [month,spelling] of [['08','AMZN Mktp US'],['09','AMAZON.COM'],['10','Amazon Marketplace']]){
 add('market-'+month,'card',`2026-${month}-20`,2100+next(),'outflow',null,spelling,'marketplace');
 add('utility-'+month,'personal',`2026-${month}-12`,7999,'outflow','Clearline Internet');
 }
 add('rent','business','2026-10-01',125000+next(),'outflow','Office Rental');
 add('supplies','business','2026-10-07',5300+next(),'outflow','Practice Supplies');
 add('client-cedar','business','2026-10-14',18000+next(),'inflow',null,'CED PAYMENT','client');
 add('client-birch','business','2026-10-16',24000+next(),'inflow','Birch','ACH CREDIT FROM Birch','client');
 add('client-nov','business','2026-11-02',16000+next(),'inflow','Birch','ACH CREDIT FROM Birch','client');
 add('transfer-out','business','2026-10-18',50000,'outflow',null,'TRANSFER TO account 2222','transfer');
 add('transfer-in','personal','2026-10-18',50000,'inflow',null,'TRANSFER FROM account 1111','transfer');
 add('card-pay','personal','2026-10-23',23000,'outflow',null,'payment to account 4444','payment');
 add('card-receipt','card','2026-10-23',23000,'inflow',null,'payment from account 2222','payment');
 // Oracle uses authored economic tags, not product parser, selectors, or analysis.
 const sum=rs=>rs.reduce((n,r)=>n+r.cents,0);
 const oct=rows.filter(r=>r.date.startsWith('2026-10'));
 const expenses=oct.filter(r=>r.direction==='outflow'&&!['transfer','payment'].includes(r.tag));
 const oracle={bank:1500000+3*seed,business:500000+seed,currentIncome:sum(rows.filter(r=>r.date.startsWith('2026-11')&&r.tag==='client')),lastIncome:sum(oct.filter(r=>r.tag==='client')),grossLastInflow:sum(oct.filter(r=>r.direction==='inflow')),expenses:sum(expenses),market:sum(rows.filter(r=>r.tag==='marketplace')),utility:7999,cedar:rows.find(r=>r.id==='client-cedar').cents,payers:['Cedar','Birch'],expenseRows:expenses.sort((a,b)=>b.cents-a.cents)};
 return {f,rows,oracle};
}
