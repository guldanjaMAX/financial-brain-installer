import { normalizeLedgerText as norm, reversalForm } from './money-analysis.js';

const day=r=>Date.parse(r.posted_on+'T00:00:00Z')/86400000;
const key=(...values)=>JSON.stringify(values);
const account=r=>r.account_identity || r.account_slug;
const month=r=>Number(r.posted_on.slice(0,4))*12+Number(r.posted_on.slice(5,7));
const monthDays=r=>new Date(Date.UTC(Number(r.posted_on.slice(0,4)),Number(r.posted_on.slice(5,7)),0)).getUTCDate();

// Three consecutive, single-charge months with the same account, party,
// category, purpose and calendar cadence support ordinary monthly recurrence.
// A month label alone, or an extra observation in any month, proves nothing.
function monthlyCadence(rows) {
  if(rows.length<3 || !account(rows[0]) || !rows[0].category ||
    rows.some(r=>r.category_basis_state!=='confirmed' || r.amount_minor!==rows[0].amount_minor ||
      r.category!==rows[0].category || norm(r.description)!==norm(rows[0].description)))return false;
  const ordered=[...rows].sort((a,b)=>day(a)-day(b));
  if(ordered.some((r,i)=>i && month(r)!==month(ordered[i-1])+1))return false;
  const scheduled=Math.max(...ordered.map(r=>Number(r.posted_on.slice(8,10))));
  return ordered.every(r=>Number(r.posted_on.slice(8,10))===Math.min(scheduled,monthDays(r)));
}

// Match the full read history BEFORE selecting affected answer rows. Source
// formats, transaction IDs, account records and a calendar boundary do not
// establish separate cash movements. This nominates risk; it never drops rows.
export function moneyOverlapGroups(rows, selectedIds=null) {
  const parents=rows.map((_,i)=>i),buckets=new Map(),cadences=new Map();
  const find=i=>{while(parents[i]!==i){parents[i]=parents[parents[i]];i=parents[i];}return i;};
  const join=(a,b)=>{parents[find(b)]=find(a);};
  const add=(k,i)=>{const values=buckets.get(k)||[];values.push(i);buckets.set(k,values);};
  for(const [i,r] of rows.entries()) {
    add(key('date',r.tenant_id,r.posted_on,r.currency,r.direction,r.amount_minor),i);
    if(/^\d{4}$/.test(r.account||''))add(key('mask',r.tenant_id,r.account,r.currency,r.direction,r.amount_minor),i);
    if(norm(r.payee)) {
      add(key('party',r.tenant_id,r.currency,r.direction,r.amount_minor,norm(r.payee)),i);
      const k=key(r.tenant_id,account(r),r.currency,r.direction,norm(r.payee)),group=cadences.get(k)||[];
      group.push(r);cadences.set(k,group);
    }
    if(r.external_id)add(key('source',r.tenant_id,account(r),r.currency,r.direction,r.external_id),i);
  }
  const recurring=new Set([...cadences.values()].filter(monthlyCadence).flat());
  for(const [k,indices] of buckets) {
    const kind=JSON.parse(k)[0],ordered=indices.sort((a,b)=>day(rows[a])-day(rows[b]) || a-b);
    for(let i=1;i<ordered.length;i++) {
      const a=ordered[i-1],b=ordered[i],gap=day(rows[b])-day(rows[a]);
      if(kind==='mask' && gap>3 || kind==='party' && gap>31)continue;
      // Recurrence evidence never exempts same-day observations, same-mask
      // mirrors or reused provider IDs. It applies to its own recorded account.
      if(kind==='party' && gap>3 && account(rows[a])===account(rows[b]) && recurring.has(rows[a]) && recurring.has(rows[b]))continue;
      join(a,b);
    }
  }
  const components=new Map();
  for(const [i,r] of rows.entries()){const k=find(i),group=components.get(k)||[];group.push(r);components.set(k,group);}
  return [...components.values()].filter(g=>g.length>1 && (!selectedIds || g.some(r=>selectedIds.has(r.id))))
    .map(g=>g.sort((a,b)=>day(a)-day(b) || a.id-b.id));
}

// An outside partner can make any selected copy the repeated one. Bound the
// impact to the selected dollars and price each connected component once.
export function moneyOverlapMinor(group, selectedIds) {
  const amounts=group.map(r=>BigInt(r.amount_minor)),total=amounts.reduce((n,v)=>n+v,0n);
  const extra=total-amounts.reduce((n,v)=>v>n?v:n,0n);
  const selected=group.filter(r=>selectedIds.has(r.id)).reduce((n,r)=>n+BigInt(r.amount_minor),0n);
  return selected<extra?selected:extra;
}

// Closed return grammar nominates an opposite-direction original over the
// existing six-day matching window. Scope is applied after this full-history
// lookup, so neither side of a month/year boundary can hide its partner.
export function moneyReversalPartners(rows) {
  const groups=new Map(),pairs=[];
  for(const r of rows){const k=key(r.tenant_id,r.currency,r.amount_minor),g=groups.get(k)||[];g.push(r);groups.set(k,g);}
  for(const group of groups.values()) {
    const ordered=[...group].sort((a,b)=>day(a)-day(b) || a.id-b.id);
    for(let i=0;i<ordered.length;i++) {
      const reversal=ordered[i];
      if(!reversalForm(reversal,['card','loan','line_of_credit'].includes(reversal.account_kind)))continue;
      for(let j=i-1;j>=0 && day(reversal)-day(ordered[j])<=6;j--) {
        const original=ordered[j];
        if(original.direction===reversal.direction || reversalForm(original,['card','loan','line_of_credit'].includes(original.account_kind)))continue;
        if(account(original)!==account(reversal) && (!norm(original.payee) || norm(original.payee)!==norm(reversal.payee)))continue;
        pairs.push({original,reversal});
      }
    }
  }
  return pairs;
}
