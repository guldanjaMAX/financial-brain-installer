import { normalizeLedgerText as norm } from './money-analysis.js';
import { moneyMinorText } from './money-format.js';
import { certifyMoneyQuery } from './money-query-certificate.js';
import { moneyTypeRisk, isNonOperatingMoneyCategory } from './clean-money-risk.js';
import { isRecognisedOperatingCategory } from './money-operating-categories.js';
import { moneyOverlapGroups, moneyOverlapMinor, moneyReversalPartners } from './money-query-overlap.js';

const typeFields=['income_minor','expense_minor','income_adjust_minor','sales_adjust_minor','refund_minor','interest_expense_minor'];
const partyName=value=>norm(value).replace(/(?: (?:llc|inc|corp|corporation|ltd|limited|co))+$/g,'');
// A rail-only label has no party residual. A rail word inside an otherwise
// resolved name does not erase that name or its independently read history.
const railOnly=/^(?:(?:ach|zelle|venmo|paypal|deposit|transfer|credit|debit|wire|payments?|online|bank)(?: |$))+$/;
const amountText=(currency,minor)=>`${currency} ${currency==='USD'?'$':''}${moneyMinorText(minor,currency)}`;
// The practical face-value rule admits ordinary commercial postings, not every
// alphabetic outside party. Unknown purpose defaults to unproved. These forms
// describe the transaction's ordinary purpose; risk evidence still vetoes them.
function ordinaryPurpose(row,decision,postedTax) {
  if(!['party','face_value'].includes(decision?.kind_proof))return true;
  if(postedTax)return true;
  const memo=norm(row.description),party=partyName(row.payee);
  // A known processor's payout identifies settled cash, while the source-risk
  // veto below still checks principal, reserves and returns independently.
  // A bare processor name contains no payout purpose and stays unproved.
  if(row.direction==='inflow' && decision.processor_name &&
    new RegExp(`^(?:ach credit )?${norm(decision.processor_name)}(?: inc| payments)? (?:payout|settlement)(?: (?:batch|id|ref|no|[a-z]{0,4}\\d[a-z0-9]*))*$`).test(memo))return true;
  if(row.direction==='outflow' && /^office rent(?: paid to (?:property owner|landlord))?$/.test(memo))return true;
  if(/\b(?:purchases?|invoices?|supplies|repairs?|services?|fees?|subscriptions?|payroll|wages?|salary|sales?|commissions?)\b/.test(memo))return true;
  if(/\b(?:customer|client) payments?\b|\b(?:payment received|invoice paid|paid invoice)\b/.test(memo) || memo==='payment for work')return true;
  return !memo && /\b(?:customers?|clients?|vendors?|suppliers?|merchants?|shops?|stores?)\b/.test(party);
}

// This is the single High type-certificate boundary, after contributions are
// frozen and before owner confidence is rendered. Every contributing party
// must resolve to one group, have its history in this snapshot, and have no
// contrary type evidence. A category, explicit measure, top-N context or small
// dollar share cannot supply missing proof. No amount or membership is changed.
export function moneyTypeCertificate({tokens=[],rows=[],decisions=[],snapshot,scope,period=null,certificate=certifyMoneyQuery({tokens})}) {
  const from=tokens.findIndex(t=>t.v==='from'),projection=tokens.slice(0,from);
  const wildcard=projection.length===2 && projection[1].v==='*' || projection.length===4 && projection.at(-1).v==='*';
  // Use parsed source contributions for certified SQL. A monetary output alias
  // cannot change which party's dollars/history the certificate must check.
  // Counts require the underlying row population as well. For unsupported SQL,
  // preserve conservative disclosures independently of the query-shape ceiling.
  const fields=certificate.certified?certificate.fields:typeFields.filter(field=>wildcard || tokens.some(t=>['word','identifier'].includes(t.kind) && t.v===field) || scope?.recurring && field==='expense_minor');
  if(!fields.length)return [];
  const byId=new Map(decisions.map(d=>[d.id,d]));
  const history=snapshot?.historyRows??snapshot?.rows;
  const historyIds=new Set((history||[]).map(r=>r.id));
  const names=new Map();
  for(const r of history||[])if(partyName(r.payee)) {
    const k=JSON.stringify([r.tenant_id,r.currency,partyName(r.payee)]),values=names.get(k)||new Set();
    values.add(r.payee);names.set(k,values);
  }
  const grouped=certificate.certified,parties=new Map(),contributing=new Set();
  for(const r of rows)for(const field of fields) {
    const d=byId.get(r.id),income=field==='income_minor';
    let minor=field==='amount_minor'?r.amount_minor:income?(d?.income_adjust_minor||0):field==='expense_minor'?0:(d?.[field]??(!d?r.amount_minor:0));
    if(['income_minor','expense_minor'].includes(field) && (!d || d.money_kind==='ordinary') && r.direction===(income?'inflow':'outflow') &&
      (!income || !['card','loan','line_of_credit'].includes(r.account_kind)))minor+=r.amount_minor;
    if(!minor || scope?.positiveContributions?.includes(field) && minor<0)continue;
    if(scope?.filters?.direction && scope.filters.direction!==r.direction)continue;
    const category=scope?.rowFilters?.category;
    if(category && (category.op==='='?r.category!==category.value:r.category===category.value))continue;
    contributing.add(r.id);
    const name=partyName(r.payee);
    // Closed bank fee/earnings forms identify the recorded account itself.
    // They do not turn arbitrary missing payees into resolved outside parties.
    const accountForm=d?.kind_proof==='form' && r.account_identity;
    const party=d?.reversal_payer_group || (d?.processor_name?`processor:${d.processor_name}`:name) || (accountForm?`account:${r.account_identity}`:null);
    const k=JSON.stringify([r.tenant_id,r.currency,party??['unresolved',r.id],field]);
    const group=parties.get(k)||{currency:r.currency,label:r.payee||d?.processor_name||(accountForm?'the recorded account':'an unresolved party'),minor:0n,issues:new Set()};
    group.minor+=BigInt(Math.abs(minor));
    if(!grouped)group.issues.add('displayed attribution is not proved by GROUP BY');
    if(!party || name && names.get(JSON.stringify([r.tenant_id,r.currency,name]))?.size>1 ||
      !d?.processor_name && name && (railOnly.test(name) || /\d/.test(name) || /\s{2,}|[^\x20-\x7e]/.test(r.payee)))group.issues.add('party identity is unresolved or maps to several groups');
    if(!snapshot || !history || snapshot.partial || snapshot.readFrom || snapshot.readThrough || !historyIds.has(r.id))group.issues.add('earlier history was not read completely');
    if(!d || !d.kind_proof || d.estimated || d.kind_unproved || d.estimate_reason || d.reversal_contribution_gaps?.length)group.issues.add('read history or type evidence is contrary or unproved');
    // This veto is independent of earlier proof, ordinary-purpose wording and
    // materiality. It qualifies operating contributions, never gross cash rows.
    const sourceCategory=r.category_detailed || r.category_primary || r.category;
    // A separately typed lender-interest component already excludes principal.
    // Its broad loan-payment category cannot invalidate that narrower reading.
    const loanInterest=field==='interest_expense_minor' && d?.money_kind==='loan_interest';
    if(typeFields.includes(field) && !loanInterest && norm(sourceCategory) && r.category_basis_state==='confirmed' &&
      (!isRecognisedOperatingCategory(sourceCategory) || isNonOperatingMoneyCategory(sourceCategory)))
      group.issues.add(`the confirmed category ${sourceCategory} has no recognised operating type or reconciled operating allocation`);
    // Ordinary counting is practical, but neither identity, category nor size
    // proves that principal, agency money or a return is an operating posting.
    // Recheck source facts after contributions freeze so a prior code/role
    // promotion cannot erase contrary short-list evidence.
    const sourceRisk=moneyTypeRisk(r);
    const postedTax=d?.posted_tax_type_only===true && d.kind_proof==='face_value' && sourceRisk==='tax_payment_type_unproved';
    if(!['form','pair','original','matched_reversal','interest_group'].includes(d?.kind_proof) &&
      (d?.money_kind==='ordinary' && sourceRisk && !postedTax || sourceRisk==='entrusted_principal_unproved'))
      group.issues.add('principal, ownership, service-period or return evidence is unresolved');
    if(d?.money_kind==='ordinary' && !ordinaryPurpose(r,d,postedTax))group.issues.add('the recorded party and posting do not establish an ordinary operating purpose');
    // Closed lender-side payment acknowledgements establish cash received,
    // unlike a debt charge/accrual. They do not invent a paying-side posting.
    const receivedPayment=r.direction==='inflow' && d?.kind_proof==='form' && ['loan_payment','loan_interest'].includes(d.money_kind);
    if(['loan','line_of_credit'].includes(r.account_kind) && d?.kind_proof!=='interest_group' && !receivedPayment)
      group.issues.add('a debt-account posting has no bound cash settlement; accrued or capitalized interest is not proved paid');
    parties.set(k,group);
  }
  const gaps=[...parties.values()].filter(p=>p.issues.size).map(p=>({code:'party_type_certificate_unproved',
    why:`${amountText(p.currency,p.minor)} for ${p.label} contributing to the figure has no complete party type certificate: ${[...p.issues].join('; ')}. The provisional figure is retained.`,
    missing:'Resolve every contributing payer/vendor to one group, bind displayed dimensions to GROUP BY, and read the full history without from/through. Reconcile each contrary posting, including beneficial ownership, principal, asset/expense allocation, earned period and any earlier purchase or return, with its source statement.'}));
  // Duplicate identity is independent of party/type proof. Materiality may
  // price this uncertainty, but can never prove two observations are two cash
  // movements. Keep the full provisional figure and name possible extra dollars.
  for(const group of moneyOverlapGroups(history||rows,contributing)) {
    const extra=moneyOverlapMinor(group,contributing);
    gaps.push({code:'duplicate_identity_unproved',why:`${amountText(group[0].currency,extra)} may be counted twice in the figure; repeated source observations have no disjoint posting proof. The provisional figure is retained.`,
      missing:'Confirm these rows against the original statement and provider posting identities, proving each repeated amount is a separate cash movement.'});
  }
  const inPeriod=r=>!period || r.posted_on>=period.from && r.posted_on<=period.to;
  for(const {original,reversal} of moneyReversalPartners(history||rows)) {
    if(inPeriod(original)===inPeriod(reversal) || ![original,reversal].some(r=>contributing.has(r.id)))continue;
    gaps.push({code:'reversal_period_boundary_unproved',
      why:`${amountText(original.currency,BigInt(original.amount_minor))} has a possible reversal across the requested period: original ${original.posted_on}, reversal ${reversal.posted_on}. The provisional figure uses its actual posting dates and is retained.`,
      missing:'Confirm these rows against both dated statements and the return notice, including the original payment identity and the period to which its reversal belongs.'});
  }
  return gaps;
}
