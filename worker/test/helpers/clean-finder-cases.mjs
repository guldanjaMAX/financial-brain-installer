import { readFileSync } from 'node:fs';
import { fixture } from './clean-money-fixture.mjs';
export const finders=Object.fromEntries(['income','credits'].map(kind=>[kind,JSON.parse(readFileSync(new URL(`../fixtures/clean-money-${kind}-1112.json`,import.meta.url),'utf8'))]));
export function finderFixture(t,kind,c){
  const f=fixture(t),d=finders[kind];
  const presets=kind==='income'?c.accounts:c.accounts.map(k=>({...d.account_presets[k],label:d.fixture_defaults.account_labels[k]?.[0],institution:d.fixture_defaults.account_labels[k]?.[1]}));
  for(const a of presets){
    f.account(a.slug,{kind:a.kind,mask:a.last4,mode:a.feed_mode||'live',entity:a.entity===null?'unassigned':a.entity||'business'});
    const fields=['label','institution','status','closed_on','opened_on'];
    for(const key of fields)if(a[key]!==undefined)f.run(`UPDATE fin_accounts SET ${key}=? WHERE account_slug=?`,a[key],a.slug);
    const period=c.period||d.fixture_defaults.period;
    const cov=a.coverage||c.coverage?.[a.slug]||{};
    f.coverage(a.slug,cov.from||'2026-01-01',cov.to||(kind==='income'?'2026-10-31':period[1]));
    if(kind==='credits'&&!c.coverage?.[a.slug]?.from)f.run('UPDATE fin_account_coverage SET covered_from=? WHERE account_slug=?',period[0],a.slug);
    if(cov.coverage_status)f.run('UPDATE fin_account_coverage SET coverage_status=? WHERE account_slug=?',cov.coverage_status,a.slug);
  }
  for(const a of presets)if(a.link)f.link(a.slug,a.link.split(' ').at(-1));
  for(const r of c.rows){
    const slug=r.acct||r.account;
    f.row(r.id,slug,Math.round((r.amount||0)*100),{day:r.date,direction:r.dir==='in'?'inflow':'outflow',memo:r.desc??r.description,payee:r.payee,
      category:r.cat??r.category,currency:r.currency||'USD',pending:r.pending||0});
    // The finders used conceptual "import" provenance, absent from the real
    // schema. Owner-stated manual rows preserve its lack of bank-code authority.
    f.run("UPDATE fin_transactions SET source_feed='synthetic-feed',provenance=?,category_basis_state=?,amount_minor=?,direction=?,basis_state=?,unparsed_reason=? WHERE txn_uid=?",
      r.provenance==='import'?'owner_stated':r.provenance||'feed',r.cat_basis||(kind==='credits'?'proposed':'confirmed'),r.amount_null?null:Math.round((r.amount||0)*100),
      r.amount_null?null:r.dir==='in'?'inflow':'outflow',r.amount_null?'unparsed':'confirmed',r.amount_null?'synthetic unreadable amount':null,r.id);
  }
  return f;
}
export function finderSql(kind,c,{canonical=false}={}){
  const [from,to]=c.period||finders[kind].fixture_defaults.period;
  const dates=`posted_on BETWEEN '${from}' AND '${to}'`;
  if(kind==='income'){
    let expr='COALESCE(SUM(income_minor),0)';
    if(['C19','C20','C21'].includes(c.id))expr=canonical?'COALESCE(SUM(income_minor+sales_adjust_minor),0)':finders.credits.queries.net_sales.split('SELECT ')[1].split(' FROM ')[0];
    const currencies=typeof c.expected.figure_minor==='object';
    return `SELECT ${currencies?'currency,':''}${expr} n FROM txn WHERE side='business' AND ${dates}${currencies?' GROUP BY currency':''}`;
  }
  const metrics={card_paid:"SUM(CASE WHEN money_kind='card_payment' OR payment_kind='card' THEN paid_minor ELSE 0 END)",
    loan_paid:"SUM(CASE WHEN money_kind='loan_payment' OR payment_kind='loan' THEN paid_minor ELSE 0 END)",net_spend:'SUM(expense_minor-refund_minor)',
    net_sales:'SUM(income_minor+sales_adjust_minor)',refunds_in:'SUM(refund_minor)',interest:'SUM(CASE WHEN interest_stated_minor>0 THEN interest_stated_minor ELSE expense_minor END)'};
  if(canonical && metrics[c.query])return `SELECT COALESCE(${metrics[c.query]},0) n FROM txn WHERE ${c.query==='interest'?"lower(description) LIKE '%interest%' AND ":''}${dates}`;
  return finders.credits.queries[c.query].replaceAll(':from',`'${from}'`).replaceAll(':to',`'${to}'`).replace(' FROM txn',' n FROM txn');
}
export const expectedMinor=(kind,c)=>kind==='income'?c.expected.figure_minor:Math.round(c.expected[0]*100);
export const figure=(kind,c,r)=>kind==='income'&&typeof c.expected.figure_minor==='object'?Object.fromEntries(r.rows.map(row=>[row.currency,row.n])):r.rows.reduce((n,row)=>n+row.n,0);
