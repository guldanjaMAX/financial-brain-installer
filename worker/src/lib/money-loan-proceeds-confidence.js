import { applyAccountKindReview } from './fin-account-kinds.js';
import { legLocator } from './clean-money-transfers.js';
import { normalizeLedgerText } from './money-analysis.js';
import { moneyMinorNumber } from './money-format.js';

// This is a confidence boundary, not another membership rule. Category-only
// promotion can clear uncertainty without establishing the named destination.
// Require reciprocal exact endpoints independently of the promoted proved bit.
function exactOwnedPair(pair, byId, inventory) {
  if (!pair || pair.proved!==1 || pair.unique_match!==1 || pair.out_matches!==1 || pair.in_matches!==1) return false;
  const out=byId.get(pair.out_id),into=byId.get(pair.in_id);
  if (!out || !into || out.tenant_id!==into.tenant_id || out.entity!==into.entity ||
      out.account_identity===into.account_identity || out.direction!=='outflow' || into.direction!=='inflow' ||
      out.currency!==into.currency || out.amount_minor<=0 || out.amount_minor!==into.amount_minor ||
      out.basis_state!=='confirmed' || into.basis_state!=='confirmed') return false;
  const accounts=new Map();
  for (const raw of inventory.filter(a=>a.tenant_id===out.tenant_id)) {
    const a=applyAccountKindReview(raw);
    let account=accounts.get(a.account_identity);
    if (!account) { account={...a,members:[]}; accounts.set(a.account_identity,account); }
    account.members.push(a);
  }
  const source=accounts.get(out.account_identity),target=accounts.get(into.account_identity);
  const owned=a=>a && a.members.every(m=>m.relationship==='owned' && m.entity_basis==='confirmed' &&
    m.basis_state==='confirmed' && m.account_kind===a.account_kind && !m.account_kind_balance_conflict);
  if (!owned(source) || !owned(target) || !['loan','line_of_credit'].includes(source.account_kind) ||
      !['checking','savings','investment','retirement','escrow'].includes(target.account_kind)) return false;
  return [[out,source,target,'out'],[into,target,source,'in']].every(([row,self,other,side])=> {
    if (legLocator(row,self,other,accounts,side,{loanAdvance:true})!=='exact') return false;
    // Unknown payee wording cannot become absent evidence. A conservative cap
    // also applies to lender-only payees until their endpoint is reconciled.
    return !normalizeLedgerText(row.payee) ||
      legLocator({...row,description:row.payee},self,other,accounts,side,{loanAdvance:true})==='exact';
  });
}

export function loanProceedsConfidence({snapshot,decisions,period,accountSlugs,selection}) {
  if (!snapshot || !decisions) return [];
  const byId=new Map(snapshot.rows.map(r=>[r.id,r])),pairs=new Map();
  for (const p of snapshot.pairs) for (const id of [p.out_id,p.in_id]) {
    const candidates=pairs.get(id) || []; candidates.push(p); pairs.set(id,candidates);
  }
  const proof=new Map(),disclosures=[];
  for (const d of decisions) {
    if (d.money_kind!=='loan_proceeds') continue;
    const r=byId.get(d.id);
    // Scope the disclosure, keeping all rows available for reciprocal proof.
    if (!r || !(r.amount_minor>0) || accountSlugs && !accountSlugs.includes(r.account_slug) ||
        ['account_slug','account_identity','account','tenant_id','side','currency','entity'].some(k=>selection?.[k] && r[k]!==selection[k]) ||
        period && (r.posted_on<period.from || r.posted_on>period.to)) continue;
    const candidates=pairs.get(r.id) || [],pair=candidates.length===1?candidates[0]:null;
    if (pair && !proof.has(pair)) {
      // A failed optional proof read lowers confidence; it never erases the
      // already-computed figure or turns an answer into an error.
      try { proof.set(pair,!snapshot.partial && exactOwnedPair(pair,byId,snapshot.accounts)); }
      catch { proof.set(pair,false); }
    }
    const proved=Boolean(pair && proof.get(pair));
    const currency=/^[A-Z]{3}$/.test(r.currency || '')?r.currency:'USD';
    const amount=new Intl.NumberFormat('en-US',{style:'currency',currency}).format(moneyMinorNumber(r.amount_minor,currency));
    const account=/^\d{4}$/.test(r.account || '')?`Account ${r.account}`:'Account without recorded last four';
    disclosures.push({code:'loan_proceeds_exclusion',proved,amount_minor:r.amount_minor,currency:r.currency,
      why:`${amount} ${r.direction} on ${account}, ${r.posted_on}, is excluded from ${r.direction==='outflow'?'spending':'income'} as ${proved?'':'likely '}loan proceeds; ${proved
        ? 'a unique pair between confirmed owned accounts has exact reciprocal source and destination locators with no contradicting locator.'
        : 'unique owned-account source and destination proof is incomplete or a locator is unresolved; this directional total could change by this amount. Paired legs describe the same movement and must not be added together.'}`,
      missing:proved?null:'Counterpart statements or explicit bank transfer evidence identifying both the source and destination; check the dated postings and reconcile every description and payee locator.'});
  }
  return disclosures;
}
