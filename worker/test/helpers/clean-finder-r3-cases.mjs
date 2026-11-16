import { readFileSync } from 'node:fs';
import { fixture } from './clean-money-fixture.mjs';
export const reports=Object.fromEntries(['cards','payouts','periods'].map(k=>[k,JSON.parse(readFileSync(new URL(`../fixtures/clean-money-${k}-r3-1112.json`,import.meta.url),'utf8'))]));
const period="posted_on BETWEEN '2026-10-01' AND '2026-10-31'";
const clone=x=>structuredClone(x);
function cardRows(c){return Array.isArray(c.rows)?c.rows:cardRows(reports.cards.cases.find(r=>r.id===c.rows.match(/C\d+/)[0]));}
function periodLedger(c){
  const spec=c.ledger;
  if(typeof spec==='string')return spec==='base'?{...clone(reports.periods.base_fixture),pending:[]}:periodLedger(reports.periods.cases.find(r=>r.id===spec));
  const d=spec.base_of?periodLedger(reports.periods.cases.find(r=>r.id===spec.base_of)):clone(reports.periods.base_fixture);
  for(const key of ['accounts','coverage','rows','pending']){
    if(spec[key+'_replace'])d[key]=clone(spec[key+'_replace']);
    d[key]=[...(d[key]||[]),...clone(spec[key+'_add']||[])];
    for(const r of d[key])Object.assign(r,spec[key+'_override']?.[r.id||r.slug||r.account_slug]);
  }
  for(const r of d.accounts)Object.assign(r,spec.account_override?.[r.slug]);
  for(const r of d.coverage)Object.assign(r,spec.coverage_override?.[r.account_slug]);
  return d;
}
export function r3Fixture(t,kind,c){
  const f=fixture(t),d=reports[kind];let accounts,rows,coverage,request;
  if(kind==='cards'){
    accounts=d.fixture.account_sets[c.accounts].map(slug=>({slug,...d.fixture.accounts[slug],kind:d.fixture.accounts[slug].account_kind}));
    rows=cardRows(c);coverage=accounts.map(a=>({account_slug:a.slug,...d.fixture.coverage_defaults}));
    const mask=/account=(\d+)/.exec(c.query)?.[1],where=period+(mask?` AND account='${mask}'`:'');
    const name=c.query.split(' ')[0];
    const paymentWhere=name==='Q_PAID_TO' && mask?period+` AND paid_to_account='${mask}'`:where;
    // The full counted debit already contains memo-stated interest. Follow the
    // public guide without changing the finder's independent expected figure.
    const expr={Q_SPEND:'SUM(expense_minor+CASE WHEN expense_minor=0 THEN interest_stated_minor ELSE 0 END)',Q_NET_SPEND:'SUM(expense_minor-refund_minor)',Q_INCOME:'SUM(income_minor)',
      Q_FEES:"SUM(CASE WHEN lower(description) LIKE '%fee%' THEN expense_minor-refund_minor ELSE 0 END)",
      Q_INTEREST:"SUM(CASE WHEN lower(description||' '||COALESCE(category,'')) LIKE '%interest%' THEN expense_minor-refund_minor+interest_stated_minor ELSE 0 END)",
      Q_PAID_TO:'SUM(paid_minor)',Q_GUIDE_PAYMENTS:"SUM(CASE WHEN payment_kind='card' THEN paid_minor ELSE 0 END)",Q_PRINCIPAL:"SUM(CASE WHEN lower(description)='principal payment' THEN amount_minor ELSE 0 END)"}[name];
    if(!expr)throw new Error('unknown card query '+c.query);
    request={sql:`SELECT COALESCE(${expr},0) n FROM txn WHERE ${paymentWhere}`,from:'2026-10-01',to:'2026-10-31'};
  }else if(kind==='payouts'){
    accounts=d.meta.account_presets[c.accounts];rows=c.rows.map(r=>({id:r.uid,account:r.acct,posted_on:r.day||'2026-10-02',direction:r.dir||'inflow',amount_minor:r.cents,description:r.memo,payee:r.payee,category:r.cat,category_basis_state:r.category_basis_state}));
    coverage=accounts.map(a=>({account_slug:a.slug,covered_from:'2026-01-01',covered_to:'2026-10-31',...c.coverage?.[a.slug]}));
    const [query,value]=c.sql.split(':');let sql=d.meta.sql_templates[query]||c.sql;
    if(['PROC','PAYER'].includes(query))sql=`SELECT COALESCE(SUM(amount_minor),0) cents FROM txn WHERE ${period} GROUP BY ${query==='PROC'?'processor':'payer_group'} HAVING ${query==='PROC'?'processor':'payer_group'}='${query==='PAYER'?'processor:':''}${value}'`;
    // Use the public signed contributions; the original handwritten templates
    // predate paid_minor/refund_minor/sales_adjust_minor and remain in JSON.
    if(query==='NETSALES')sql=`SELECT COALESCE(SUM(income_minor+sales_adjust_minor),0) cents FROM txn WHERE ${period}`;
    if(query==='NET')sql=`SELECT COALESCE(SUM(income_minor+sales_adjust_minor-expense_minor+refund_minor),0) cents FROM txn WHERE ${period}`;
    sql=sql.replaceAll('SELECT SUM(amount_minor) AS cents','SELECT COALESCE(SUM(amount_minor),0) AS cents');
    request={sql};
    if(/gross .*sales|gross sales/i.test(c.question))request.measure='gross_sales';
    if(/holding in reserve/.test(c.question))request.measure='reserve_balance';
  }else{
    const data=periodLedger(c);accounts=data.accounts;rows=[...data.rows,...data.pending.map(r=>({...r,pending:1}))];coverage=data.coverage;
    request={...c.req,sql:c.req.sql==='Q_OCT'?d.base_fixture.Q_OCT:c.req.sql};
    if(c.id==='P31')Object.assign(request,{from:'2026-10-01',to:'2026-10-31'});
    if(c.id==='P39')request={sql:'SELECT 0 n',time_zone:'America/Los_Angeles'};
    rows=rows.map(r=>({...d.base_fixture[r.leg],...r}));
  }
  for(const a of accounts){f.account(a.slug,{mask:a.mask,kind:a.kind||a.account_kind,mode:a.feed_mode||'manual',entity:a.entity||'business'});
    for(const field of ['label','institution','opened_on','closed_on','status','basis_state'])if(a[field]!==undefined)f.run(`UPDATE fin_accounts SET ${field}=? WHERE account_slug=?`,a[field],a.slug);
  }
  for(const a of coverage){f.coverage(a.account_slug,a.covered_from||a.from,a.covered_to||a.to);
    for(const field of ['coverage_status','basis_state'])if(a[field])f.run(`UPDATE fin_account_coverage SET ${field}=? WHERE account_slug=?`,a[field],a.account_slug);
  }
  for(const r of rows){
    // Fault injection covers legacy malformed dates that current schema rejects.
    const corruptDate=r.posted_on && !/^\d{4}-\d{2}-\d{2}$/.test(r.posted_on);
    if(corruptDate)f.db.exec('PRAGMA ignore_check_constraints=ON');
    f.row(r.id,r.account,r.amount_minor??0,{day:r.posted_on,direction:r.direction,memo:r.description,payee:r.payee,category:r.category,pending:r.pending||0});
    if(r.provenance==='feed')f.run("UPDATE fin_transactions SET source_feed='synthetic-feed' WHERE txn_uid=?",r.id);
    for(const field of ['provenance','category_basis_state','source_provider','external_id','pending_transaction_id','basis_state'])if(r[field]!==undefined)
      f.run(`UPDATE fin_transactions SET ${field}=? WHERE txn_uid=?`,r[field]==='import'?'owner_stated':r[field],r.id);
    if(r.amount_minor===null)f.run("UPDATE fin_transactions SET amount_minor=NULL,direction=NULL,basis_state='unparsed',unparsed_reason='synthetic unreadable amount' WHERE txn_uid=?",r.id);
    if(corruptDate)f.db.exec('PRAGMA ignore_check_constraints=OFF');
  }
  return {...f,request};
}
export function r3Expected(kind,c){return kind==='cards'?c.expected.figure_minor:kind==='payouts'?c.expected.minor:c.exp.figure;}

export async function r3Query(f,kind,c,query){
  // The R3 books state today=2026-11-12. Pin that clock: pending holds older
  // than fourteen days are reported as stale (fix step 8), so the wall clock
  // must not move a fixture's pending evidence between runs.
  if(kind!=='periods' || c.id!=='P39')return query(f.env,f.request,{now:()=>Date.parse('2026-11-12T19:00:00Z')});
  const options={now:()=>Date.parse('2026-11-01T00:30:00Z')},context=await query(f.env,f.request,options);
  const from=context.as_of.local_today.slice(0,7)+'-01',date=new Date(from+'T00:00:00Z');date.setUTCMonth(date.getUTCMonth()+1);date.setUTCDate(0);
  const to=date.toISOString().slice(0,10);
  return query(f.env,{sql:`SELECT SUM(expense_minor) expense_minor FROM txn WHERE posted_on BETWEEN '${from}' AND '${to}'`,time_zone:f.request.time_zone},options);
}
