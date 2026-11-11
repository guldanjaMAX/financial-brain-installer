// Synthetic measurement only. The authored book is never passed to product code.
import { writeFileSync } from 'node:fs';
import { fixture } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
export const questions = [
 ['What are my account balances?', 'Show my acount balances', 'How much is in each acccount?'],
 ['Show my last 10 transactions', 'Show my last ten transactons', 'List the latest 10 transctions'],
 ['How much money came in last month?', 'How much came in last mnth?', 'What money came in last montth?'],
 ['How much money went out last month?', 'How much went out last mnth?', 'What did I spend last montth?'],
 ['What were my 5 biggest expenses last month?', 'Show my five biggest expensses last month', 'List my 5 largest expenses last mnth'],
 ['Did a payment of $1234.56 arrive in September 2026?', 'Did $1234.56 arive in September 2026?', 'Was $1234.56 recieved in September 2026?'],
 ['How much did I spend at Lumen Supply last month?', 'How much did I spend at Lumen Supply last mnth?', 'Show spend at Lumen Supply last montth'],
 ['What charges hit every month, with the paying account?', 'Show recurring chargges and the paying account', 'What do I pay for every month, by acccount?'],
 ['What moved between my own accounts last month?', 'How much did I transfer between my own accounts last mnth?', 'Show own account tranfers last month'],
 ['Which financing payouts have not landed yet?', 'Which financing payots have not arrived?', 'What financing payouts are still pendng?'],
];
export function bookFor(seed, short = false) {
 let state = seed; const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
 const accounts = Array.from({length: 9}, (_, i) => ({ slug: `account-${i}`, mask: String(4100+i), kind: i < 6 ? i % 2 ? 'savings' : 'checking' : 'card', entity: i < 4 || i > 5 ? 'store' : 'personal', balance: 100000 + next()%900000 }));
 const rows = []; const add = (account, date, cents, payee, extra={}) => rows.push({id: rows.length+1, account, date, cents, payee, move:false, pending:false, ...extra});
 for (let i=0;i<(short?6:45);i++) add(i%9, `2026-09-${String(1+i%28).padStart(2,'0')}`, (i%4===0?1:-1)*(1000+next()%30000), i%3===0 ? ['Lumen Supply','LUMEN SUPPLY','Lumen-Supply'][i%9/3] : `Vendor ${i%5}`);
 if (!short) {
  for (const a of [0,6,7]) for (const month of ['07','08','09']) add(a,`2026-${month}-10`,-(1499+a*100),'Orbit Service');
  for (const [a,b,amount,label] of [[0,4,50000,'Transfer'],[0,6,80000,'Card payment'],[1,7,23000,'Card payment']]) {
   add(a,'2026-09-20',-amount,label,{move:true,description:`payment to account ${accounts[b].mask}`});
   add(b,'2026-09-20',amount,label,{move:true,description:`payment from account ${accounts[a].mask}`});
  }
  add(0,'2026-09-23',-12000,'Outside Lender',{description:'Loan payment to outside lender'});
  add(0,'2026-09-16',123456,'Payer Unit');
  add(8,'2026-09-28',-990001,'Pending Vendor',{pending:true});
 }
 return {accounts,rows};
}
export function oracle(book) {
 const rows=book.rows.filter(r=>!r.pending), month=rows.filter(r=>r.date.startsWith('2026-09'));
 const sum=rs=>Number(rs.reduce((n,r)=>n+BigInt(Math.abs(r.cents)),0n));
 return { balances: book.accounts.map(a=>a.balance), last:[...rows].sort((a,b)=>b.date.localeCompare(a.date)||b.id-a.id).slice(0,10),
  incoming:sum(month.filter(r=>r.cents>0&&!r.move)), outgoing:sum(month.filter(r=>r.cents<0&&!r.move)),
  biggest:month.filter(r=>r.cents<0&&!r.move).sort((a,b)=>a.cents-b.cents).slice(0,5).map(r=>-r.cents),
  payment:month.filter(r=>r.cents===123456), vendor:sum(month.filter(r=>r.cents<0&&r.payee.toLowerCase().replace(/[^a-z0-9]/g,'')==='lumensupply')),
  transfers:sum(month.filter(r=>r.move&&r.cents>0)), recurring:book.rows.length<10?[]:[1499,2099,2199] };
}
export async function runBook(book, partial, prompts = questions, answerRoute = withLedgerAnswer) {
 let close; const f=fixture({after(fn){close=fn;}}); f.owner('store'); f.owner('personal');
 f.raw("UPDATE fin_entities SET kind='person' WHERE entity_slug='personal'");
 let modelCalls=0; f.env.AI={async run(){modelCalls++;throw Error('MODEL_FORBIDDEN');}};
 for(const a of book.accounts){
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at) VALUES (?,?,?,?,?,?,'manual','owner_stated','confirmed','2026-10-12')`,a.slug,a.entity,a.kind,a.kind==='card'?'liability':'asset',a.mask,`Synthetic ${a.slug}`);
  f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at) VALUES (?,?,'2026-06-01','2026-10-12','2026-10-12','owner_stated','confirmed','2026-10-12')`,a.slug,partial&&a.slug==='account-8'?'partial':'complete');
  f.raw(`INSERT INTO fin_balance_snapshots (account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at) VALUES (?,'2026-10-12',?,'owner_stated','confirmed','2026-10-12')`,a.slug,a.balance);
 }
 for(const r of book.rows) f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,pending,provenance,basis_state,recorded_at) VALUES (?,?,?,?,?,?,?,?,'owner_stated','confirmed','2026-10-12')`,`row-${r.id}`,book.accounts[r.account].slug,r.date,Math.abs(r.cents),r.cents<0?'outflow':'inflow',r.description||r.payee,r.payee,Number(Boolean(r.pending)));
 const results=[];
 try {for(let q=0;q<10;q++)for(let phrasing=0;phrasing<3;phrasing++){
  const body=await(await answerRoute({env:f.env,question:prompts[q][phrasing],now:'2026-10-12T12:00:00Z',grantScope:{all:true},scopePrincipalKind:'owner'},async gap=>Response.json({answer:null,gaps:gap?[gap]:[]}))).json();
  results.push({q:q+1,phrasing,question:prompts[q][phrasing],body,modelCalls});
 }}finally{close();} return results;
}
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function score(c,o,partial=false){
 const l=c.body.ledger; const text=JSON.stringify(c.body); const q=c.q;
 if(!l) return {status:(q===10&&/financ|payout/i.test(text)&&/missing|not|cannot|need|unsupported/i.test(text))||(partial&&/period_outside_coverage/.test(text))?'HONEST BOUNDARY':'PARTIAL',detail:c.body.gaps?.[0]?.reason||'no deterministic answer'};
 let observed,expected;
 if(q===1){observed=l.accounts?.map(a=>a.current_minor).sort((a,b)=>a-b);expected=[...o.balances].sort((a,b)=>a-b);}
 if(q===2){observed=l.rows?.map(r=>[r.posted_on,r.amount_minor,r.direction]);expected=o.last.map(r=>[r.date,Math.abs(r.cents),r.cents<0?'outflow':'inflow']);}
 if(q===3){observed=l.combined_inflow_minor??l.lead_accounts?.reduce((n,a)=>n+a.credits_minor,0);expected=o.incoming;}
 if(q===4){observed=l.expense_total_minor??l.lead_accounts?.reduce((n,a)=>n+a.debits_minor,0);expected=o.outgoing;}
 if(q===5){observed=l.lead_rows?.map(r=>r.amount_minor);expected=o.biggest;}
 if(q===6){observed=[l.found,...(c.body.citations||[]).map(r=>[r.posted_on,r.amount_minor])];expected=[o.payment.length>0,...o.payment.map(r=>[r.date,r.cents])];}
 if(q===7){observed=l.lead_total_minor??l.total_minor;expected=o.vendor;}
 if(q===8){observed=l.recurring?.map(r=>r.typical_minor).sort((a,b)=>a-b);expected=o.recurring;}
 if(q===9){observed=l.total_minor;expected=o.transfers;}
 if(q===10)return {status:'MISLEADING',detail:'ledger answer does not establish outstanding financing obligations'};
 if(observed===undefined)return {status:'PARTIAL',detail:`missing requested structure (${l.kind})`};
 if(!eq(observed,expected))return {status:q===5?'MISLEADING':'WRONG FIGURE',detail:`expected ${JSON.stringify(expected)}; observed ${JSON.stringify(observed)}`};
 if(q===8&&!l.recurring.every(r=>r.account_slug||r.account_mask))return {status:'PARTIAL',detail:'recurring amounts match; paying-account attribution missing'};
 return {status:partial&&/4108.*missing|Omitted accounts:.*4108|excluded your account ending 4108/s.test(c.body.answer||'')?'HONEST BOUNDARY':l.complete===false?'PARTIAL':'RIGHT',detail:'independent integer cents and membership match'};
}
export async function measure(){const results=[];for(const seed of [427,10427,20427])for(const mode of ['complete','partial','short']){
 const book=bookFor(seed,mode==='short'), o=oracle(book);
 const bounded=mode==='partial'?oracle({...book,rows:book.rows.filter(r=>r.account!==8)}):o;
 for(const c of await runBook(book,mode==='partial')){const key=c.q===2?o:bounded;results.push({...c,seed,mode,oracle:key,...score(c,key,mode==='partial')});}
 }return results;}
if(process.argv[1]?.endsWith('store-owner-shapes.measure.mjs')){const results=await measure();writeFileSync('store-owner-shapes.results.json',JSON.stringify(results,null,2)+'\n'); console.log(JSON.stringify(results.reduce((n,r)=>(n[r.status]=(n[r.status]||0)+1,n),{})));}
