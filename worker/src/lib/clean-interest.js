import { normalizeLedgerText } from './money-analysis.js';

const lenders = new Set(['loan','line_of_credit']);
const day = r => Date.parse(r.posted_on)/86400000;
const key = (...parts) => JSON.stringify(parts);

// A stated component is not a second cash payment. Reconcile on the frozen
// all-history book before the public period/account filter. A lender name only
// nominates a group; it never proves repayment or removes a counted bank debit.
export function reconcileInterest(rows, decisions, accounts, endpoints) {
  const readings=new Map(decisions.map(d=>[d.id,d]));
  const names=new Map(),groups=new Map();
  for(const a of accounts.filter(a=>lenders.has(a.account_kind))) {
    for(const name of new Set([a.label,a.institution].map(normalizeLedgerText).filter(Boolean))) {
      const k=key(a.tenant_id,name),list=names.get(k)||[];list.push(a);names.set(k,list);
    }
  }
  for(const r of rows) {
    const d=readings.get(r.id);
    d.interest_overlap_minor=0;
    d.interest_bound=0;d.interest_bound_payment_id=null;d.interest_bound_payment_on=null;
    d.interest_expense_minor=r.direction==='outflow' && d.money_kind==='ordinary'?0:d.interest_stated_minor;
    if(r.direction!=='inflow' || !lenders.has(r.account_kind) ||
      !['loan_payment','loan_interest'].includes(d.money_kind))continue;
    const k=key(r.tenant_id,r.currency,r.account_identity,r.posted_on),g=groups.get(k)||{rows:[],candidates:[]};
    g.rows.push(r);groups.set(k,g);
  }
  for(const r of rows) {
    const d=readings.get(r.id);
    if(r.direction!=='outflow' || !['checking','savings'].includes(r.account_kind) ||
      !(d.money_kind==='loan_payment' || d.money_kind==='ordinary' &&
        (d.uncertain_kind==='loan_payment' || d.payment_kind==='loan')))continue;
    const endpoint=endpoints.get(r.id),slug=d.paid_to_account_slug||endpoint?.slug;
    const targets=slug?accounts.filter(a=>a.tenant_id===r.tenant_id && a.account_slug===slug && lenders.has(a.account_kind)):
      names.get(key(r.tenant_id,normalizeLedgerText(r.payee)))||[];
    if(targets.length!==1)continue;
    const target=targets[0],matches=[];
    for(let delta=-3;delta<=3;delta++) {
      const date=new Date((day(r)+delta)*86400000).toISOString().slice(0,10);
      const g=groups.get(key(r.tenant_id,r.currency,target.account_identity,date));
      if(!g || !g.rows.some(p=>readings.get(p.id).money_kind==='loan_interest') ||
        !g.rows.some(p=>readings.get(p.id).money_kind==='loan_payment'))continue;
      if(g.rows.reduce((n,p)=>n+BigInt(p.amount_minor),0n)===BigInt(r.amount_minor))matches.push(g);
    }
    if(matches.length===1)matches[0].candidates.push(r);
  }
  for(const g of groups.values()) {
    // Competing equal payments cannot consume the same lender group twice.
    // Leave the available figures intact with a quantified overlap warning.
    if(!g.candidates.length)continue;
    const interest=g.rows.filter(r=>readings.get(r.id).money_kind==='loan_interest');
    const total=interest.reduce((n,r)=>n+r.amount_minor,0);
    for(const debit of g.candidates) {
      const d=readings.get(debit.id);
      if(d.money_kind==='ordinary' || d.interest_stated_minor>0)d.interest_overlap_minor=total;
    }
    if(g.candidates.length!==1)continue;
    const debit=g.candidates[0],d=readings.get(debit.id);
    // This identity belongs to one exact dated lender group, never to a nearby
    // interest word on another posting. Keep both dates for period disclosure.
    d.interest_bound=1;
    for(const r of interest)Object.assign(readings.get(r.id),{interest_bound_payment_id:debit.id,interest_bound_payment_on:debit.posted_on});
    if(d.money_kind==='ordinary') {
      for(const r of interest)Object.assign(readings.get(r.id),{interest_expense_minor:0,estimated:1,
        estimate_reason:'possible_interest_component_in_counted_payment'});
    }
    // If both sides state a split, use the lender component once. This does
    // not certify the memo or change the full debit's repayment membership.
    d.interest_expense_minor=0;
  }
}
