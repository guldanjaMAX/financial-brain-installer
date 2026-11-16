import { moneyTypeRisk } from './clean-money-risk.js';
import { MONEY_CATEGORY_CLASSES as classes } from './money-operating-categories.js';
import { legLocator } from './clean-money-transfers.js';
import { platformCategory, platformIdentity } from './money-platform.js';
import { normalizeLedgerText as norm, normalizeMerchantText, PAYMENT_EXPENSE_DESCRIPTIONS, resolvesExactAccount } from './money-analysis.js';

export const MONEY_KIND_PROOFS = Object.freeze(['pair','code','account','form','party','original','role','matched_reversal','history','face_value','interest_group']);
export const MONEY_KIND_DOUBTS = Object.freeze(['prior_estimate','unmatched_leg_candidate','possible_currency_conversion','names_another_account',
  'counterparty_is_owned_entity','counterparty_is_recorded_account_party','category_names_nonoperating_account',
  'tax_payment_type_unproved','tax_collected_not_income','financial_counterparty_type_unproved','rail_only_counterparty_unrecorded',
  'counterparty_unrecorded','refund_original_not_counted','kind_not_proved','entrusted_principal_unproved','return_membership_unproved']);
const liabilities = Object.freeze(['card','loan','line_of_credit']);
const deposits = Object.freeze(['checking','savings']);
// Owner-confirmed category words survive qualifiers on either side. Memo
// words and feed-only categories cannot enter this certificate path. Explicit
// negation of the type word cannot certify income either.
const incomeWords = '(?:income|sales|revenue|payout|settlement)';
const incomeCategory = Object.freeze(new RegExp('(?:^| )'+incomeWords+'(?: |$)'));
const negatedIncomeCategory = Object.freeze(new RegExp('(?:^| )(?:not|non|no) '+incomeWords+'(?: |$)'));
// Collected government money is not proved operating income, even when an
// owner-confirmed category also contains sales/revenue/income qualifiers.
const taxCollected = Object.freeze(/\b(?:(?:sales|use|excise) tax(?:es)?|value added tax|vat|gst|hst|tax(?:es)? (?:collected|payable|withheld|remittance|reserve)|collected tax(?:es)?)\b/);
// These frozen lexicons may only remove a certificate. Whole party names and
// balance-sheet phrases avoid mistaking a tax preparer or card printer for an
// authority. Unknown lenders/related parties remain a spend-side limitation.
const taxParties=Object.freeze(['irs','internal revenue service','franchise tax board','state comptroller','eftps',
  'us treasury','u s treasury','united states treasury','department of treasury','arizona department of revenue','department of revenue']);
const financialParties=Object.freeze(['chase','citi','citibank','capital one','american express','amex','discover','barclays','barclay',
  'synchrony','wells fargo','bank of america','apple card','applecard gsbank','goldman sachs','brex','ramp','wise','revolut','venmo','zelle','cash app','paypal']);
const balanceSheet=Object.freeze(/\b(?:(?:owners?|members?|partners?|shareholders?)(?: s)? (?:draws?|distributions?|contributions?|investments?|equity|capital|pay)\b|capital (?:contributions?|investments?|equity)\b|loan (?:payable|principal|payments?)\b|notes? payable\b|liabilit(?:y|ies)\b|(?:security |customer |tenant |refundable )?deposits?\b|escrow\b|transfers?\b|personal expenses?\b|income tax\b|estimated tax\b|distributions?\b)/);
const operatingCategory=Object.freeze(['charitable contributions','personal care','401k employer contributions','freight distribution','partner marketing','sales deposits']);
const principalWords=Object.freeze(/\b(?:security|damage|rental|refundable|holding|key|utility) (?:deposits?|bonds?)\b|\b(?:sec dep|trust|escrow|earnest|collateral|custodial|custody|as agent|for (?:property )?owner|owner (?:remittance|disbursement|statement|proceeds)|client funds|tenant funds|rental proceeds|till float|prepayments?|prepaid|retain(?:er|age)|(?:dispute|reserve) (?:hold )?(?:release|released)|bond lodgement|loan disbursement|refinance payoff|principal advance payoff|payoff disbursement|payoff to|register float|change fund|rents collected remitted|deposit refund|sales tax (?:collected|payable|reserve))\b/);
const returnLanguage=Object.freeze(/\b(?:refunds?|refunded|overpayment|returned goods|store credit|representment|re presentment|rebill|rebilled|re bill|re debit|dispute (?:debit|adjustment|hold|lost|final))\b/);
const giftCardCashOut=Object.freeze(/\bgift cards? (?:balance )?(?:cash out|redemption|refund)\b/);
const temporaryCredit=Object.freeze(/\bprovisional\b/);
const rail=Object.freeze(/\b(?:payments?|pmt|pymt|pymnt|epay|autopay|bill pay|ach|wire|transfers?|xfer|withdrawals?|deposits?|checks?|draft|debit|credit|zelle|venmo|paypal|sweep|payoff)\b/);
const railPrefix=Object.freeze(/^(?:(?:online|recurring|automatic|mobile|internet) )?(?:ach (?:debit|credit)|debit card|checkcard|pos|purchase|bill pay|online payment|recurring debit)\b\s*/);
const movementDescriptor=Object.freeze(/^(?:to|from) (?:savings|checking|reserve|vault|share|personal|account)\b|^(?:move|moved|add) (?:money|funds)\b|^(?:round up|auto save|book entry|ib ft|funds moved|pocket allocation)\b/);
const currencyForm=Object.freeze(/\b(?:currency (?:exchange|conversion)|converted|conversion|fx)\b|\b(?:usd|eur|gbp|cad|aud|jpy|chf|mxn|cny|inr|nzd|sek|nok|dkk|sgd|hkd|brl|zar|pln)\b.*\b(?:usd|eur|gbp|cad|aud|jpy|chf|mxn|cny|inr|nzd|sek|nok|dkk|sgd|hkd|brl|zar|pln)\b/);
const locator=Object.freeze(/(?:\b(?:ending(?: in)?|acct|account|card|loan|savings|checking|x+)\s*(?:ending\s*)?(?:in\s*)?(?:(?:number|no)\.?\s*)?|\.{2,}\s*|\*+\s*)(\d{4})\b/gi);
const feeForm=Object.freeze(/^(?:(?:monthly|maintenance|service|overdraft|nsf|returned item|returned payment|wire|late|finance|annual|interest|bank|account|foreign currency conversion|debit card replacement|wire transfer|balance transfer|card payment|loan payment|credit card payment|mortgage payment|payment) ){0,3}(?:fees?|charges?|interest)(?: charge)?$/);
const registryName=value=>norm(value).replace(/(?:\s+(?:llc|inc|corp|ltd|co|lp|pllc|\d+))+$/g,'').trim();
const sameParty=(value,recorded)=>{const a=registryName(value),b=registryName(recorded);return Boolean(a&&b&&(a===b||a.startsWith(b+' ')||b.startsWith(a+' ')));};
const sameBook=(a,b)=>a.tenant_id===b.tenant_id&&a.currency===b.currency;
const identity=row=>row.account_identity??JSON.stringify([row.tenant_id,row.account_slug]);
function sellerRole(row, accounts) {
  const a=accounts.find(a=>a.tenant_id===row.tenant_id&&a.account_slug===row.account_slug);
  return Boolean(platformIdentity({payee:row.payee}))||Boolean(a&&['merchant','point_of_sale'].includes(row.account_kind)&&
    a.basis_state==='confirmed'&&a.relationship==='owned'&&a.entity_basis==='confirmed');
}
function codeProof(row,d) {
  if(row.category_basis_state!=='confirmed')return false;
  const c=platformCategory(row),has=k=>classes[k].includes(c);
  if(d.money_kind==='ordinary')return row.direction==='inflow'?!liabilities.includes(row.account_kind)&&incomeCategory.test(c)&&!negatedIncomeCategory.test(c):has('expense');
  if(d.money_kind==='owner_money')return has(row.direction==='inflow'?'ownerIn':'ownerOut');
  if(d.money_kind==='loan_proceeds')return row.direction==='inflow'&&has('loan');
  if(d.money_kind==='loan_interest')return has('interest');
  if(d.money_kind==='refund')return row.direction==='outflow'&&has('returned');
  return false;
}
function closedForm(row,d,own) {
  const text=norm(row.description),payee=norm(row.payee);
  if(payee&&payee!==text&&![own?.label,own?.institution].some(v=>norm(v)&&norm(v)===payee))return false;
  if(d.money_kind==='ordinary')return row.direction==='outflow'?feeForm.test(text)||PAYMENT_EXPENSE_DESCRIPTIONS.includes(text)
    :deposits.includes(row.account_kind)&&/^(?:interest (?:earned|paid|credit|payment)|dividend(?: interest)?)$/.test(text);
  if(liabilities.includes(row.account_kind)&&row.direction==='inflow') {
    if(['card_payment','loan_payment'].includes(d.money_kind))return /^(?:(?:online|automatic|mobile|internet|autopay|auto) )*payment (?:thank you|received)(?: thank you)?$/.test(text)||row.account_kind!=='card'&&text==='principal payment';
    if(d.money_kind==='loan_interest')return row.account_kind!=='card'&&text==='interest payment';
  }
  return d.money_kind==='balance_refund'&&text==='credit balance refund';
}
// A processor-star descriptor records the merchant residual. Strip only the
// same closed decoration accepted by the product merchant normalizer.
const processorPrefix=Object.freeze(/^\s*(?:processor|paypal|sq|tst)\s*\*\s*/i);
const merchantDescriptor=row=>norm(String(row.description||'').replace(processorPrefix,''))
  .replace(railPrefix,'').replace(/\bcard \d{4}\b/g,'').trim();
function outside(row,own) {
  const text=norm(row.description),payee=norm(row.payee);
  if(movementDescriptor.test(text))return false;
  if(payee&&payee!==text&&![own?.label,own?.institution].some(v=>norm(v)&&norm(v)===payee))return true;
  const residual=merchantDescriptor(row);
  return Boolean(residual)&&!rail.test(residual)&&!/^\d+$/.test(residual)&&
    !/^(?:promotional balance|balance|advance)\b/.test(residual);
}

// Contributions are frozen first. Ordinary types count at face value; only
// risky types require independent evidence. Earlier doubts remain visible.
export function certifyMoneyKinds(rows, decisions, accounts=[], pairs=[], entities=[], reversalOriginal=new Map()) {
  const byId=new Map(rows.map(r=>[r.id,r])),readings=new Map(decisions.map(d=>[d.id,d]));
  const dates=new Map(rows.map(r=>[r.id,Date.parse(r.posted_on)/86400000])),parties=new Map(rows.map(r=>[r.id,normalizeMerchantText(r.payee)]));
  const date=r=>dates.get(r.id),party=r=>parties.get(r.id),accountKey=r=>JSON.stringify([r.tenant_id,r.account_slug]);
  const accountByKey=new Map(accounts.map(a=>[accountKey(a),a])),fx=new Map();
  const supplierPayments=new Map(),supplierKey=r=>JSON.stringify([r.tenant_id,r.currency,registryName(r.payee)]);
  for(const r of rows)if(r.direction==='outflow' && Number.isSafeInteger(r.amount_minor) && r.amount_minor>0 &&
      typeof r.posted_on==='string' && Number.isFinite(date(r)) && registryName(r.payee) && readings.get(r.id)?.money_kind==='ordinary') {
    const key=supplierKey(r),group=supplierPayments.get(key)||[];
    group.push({day:r.posted_on,minor:BigInt(r.amount_minor)});supplierPayments.set(key,group);
  }
  for(const group of supplierPayments.values()) {
    group.sort((a,b)=>a.day.localeCompare(b.day));let total=0n;
    for(const p of group){total+=p.minor;p.total=total;}
  }
  const supplierSpent=r=>{
    const group=supplierPayments.get(supplierKey(r))||[];let lo=0,hi=group.length;
    while(lo<hi){const mid=(lo+hi)>>1;if(group[mid].day<=r.posted_on)lo=mid+1;else hi=mid;}
    return lo?group[lo-1].total:0n;
  };
  // Index currency neighbours once. A new confidence guard must not turn a
  // large, unrelated multi-currency book into a quadratic date-parsing loop.
  const fxKey=(r,institution,day,direction)=>JSON.stringify([r.tenant_id,institution,day,direction]);
  for(const r of rows) {
    const a=accountByKey.get(accountKey(r)),institution=norm(a?.institution);
    if(!deposits.includes(r.account_kind)||!institution)continue;
    const key=fxKey(r,institution,date(r),r.direction),group=fx.get(key)||new Map();
    group.set(JSON.stringify([r.currency,identity(r)]),{currency:r.currency,account:identity(r)});fx.set(key,group);
  }
  const registryAccounts=new Map();
  for(const a of accounts) {
    const registry=registryAccounts.get(a.tenant_id)||new Map(),key=identity(a);
    const group=registry.get(key)||{...a,members:[]};group.members.push(a);registry.set(key,group);registryAccounts.set(a.tenant_id,registry);
  }
  const proved=new Set(),candidates=new Set();
  for(const p of pairs)for(const id of [p.out_id??p.out?.id,p.in_id??p.in?.id])if(id!==undefined)(p.proved===1||p.proved===true?proved:candidates).add(id);
  const spent=new Map();
  for(const row of [...rows].sort((a,b)=>String(a.posted_on??'').localeCompare(String(b.posted_on??''))||a.id-b.id)) {
    const d=readings.get(row.id);if(!d||!row.amount_minor)continue;
    const doubt=reason=>{d.estimated=1;d.estimate_reason||=reason;d.kind_unproved=reason;};
    if(d.money_kind==='ordinary' && row.direction==='inflow' && taxCollected.test(norm(row.description)+' '+platformCategory(row))) {
      doubt('tax_collected_not_income');continue;
    }
    if(d.estimated||d.estimate_reason){doubt('prior_estimate');continue;}
    // The existing interest reconciler binds one bank debit to one dated
    // principal-plus-interest group. Recheck its rows and owned endpoint here;
    // an unrelated interest word or a memo split supplies none of this proof.
    if(d.money_kind==='loan_payment' && row.direction==='outflow' && d.interest_bound===1 && d.payment_account_identity) {
      const target=accounts.find(a=>a.tenant_id===row.tenant_id && identity(a)===d.payment_account_identity &&
        ['loan','line_of_credit'].includes(a.account_kind) && a.basis_state==='confirmed' && a.relationship==='owned' && a.entity_basis==='confirmed');
      const receipts=target?rows.filter(p=>sameBook(p,row) && identity(p)===identity(target) && p.direction==='inflow' &&
        Math.abs(date(p)-date(row))<=3 && ['loan_payment','loan_interest'].includes(readings.get(p.id)?.money_kind)):[];
      const groups=[...new Set(receipts.map(p=>p.posted_on))].map(day=>receipts.filter(p=>p.posted_on===day)).filter(g=>
        g.some(p=>readings.get(p.id)?.interest_bound_payment_id===row.id) &&
        g.some(p=>readings.get(p.id)?.money_kind==='loan_payment') && g.reduce((n,p)=>n+BigInt(p.amount_minor),0n)===BigInt(row.amount_minor));
      if(groups.length===1){d.kind_proof='interest_group';continue;}
    }
    if(proved.has(row.id)){
      const pair=pairs.find(p=>[p.out_id??p.out?.id,p.in_id??p.in?.id].includes(row.id));
      if(pair?.evidence==='bank_category') {
        const out=byId.get(pair.out_id),into=byId.get(pair.in_id),registry=registryAccounts.get(row.tenant_id);
        const source=registry?.get(identity(out||{})),target=registry?.get(identity(into||{}));
        const owned=a=>a?.members.every(m=>m.relationship==='owned' && m.entity_basis==='confirmed' && m.basis_state==='confirmed');
        // A category-only match remains a candidate. Independently unique,
        // reciprocal owned endpoints are proof even if category won the label.
        if(!out || !into || pair.unique_match!==1 || pair.out_matches!==1 || pair.in_matches!==1 ||
          !owned(source) || !owned(target) ||
          legLocator(out,source,target,registry,'out')!=='exact' || legLocator(into,target,source,registry,'in')!=='exact') {
          doubt('unmatched_leg_candidate');continue;
        }
      }
      d.kind_proof='pair';continue;
    }
    const own=accountByKey.get(accountKey(row)),text=norm(row.description),payee=norm(row.payee),category=platformCategory(row);
    const trusted=row.category_basis_state==='confirmed'||row.provenance==='feed',code=codeProof(row,d),form=closedForm(row,d,own),seller=sellerRole(row,accounts);
    // The independent owner income code resolves an institution-name overlap
    // for closed bank earnings types. A bare memo supplies no such proof.
    const bankEarnings=code && d.money_kind==='ordinary' && row.direction==='inflow' && deposits.includes(row.account_kind) &&
      /^(?:new account bonus|cashback|interest (?:earned|paid|credit|payment)|dividend(?: interest)?)$/.test(text);

    // A confirmed refund code can remove this party doubt, but it cannot
    // bypass the excluded-original veto or original consumption budget below.
    const ownerRefundCode=row.category_basis_state==='confirmed'&&d.money_kind==='refund'&&row.direction==='inflow'&&classes.refund.includes(category);
    const counterparty=payee||merchantDescriptor(row);
    const institutionParty=counterparty.replace(/\b(?:online|ach|pmt|pymt|payment|payments|epay|autopay|wire|debit|credit|to|from|\d+)\b/g,' ').replace(/\s+/g,' ').trim();
    let reason;
    if(candidates.has(row.id)||row.possible_transfer)reason='unmatched_leg_candidate';
    else if(deposits.includes(row.account_kind)&&!form&&(currencyForm.test(text)&&(!payee||financialParties.includes(institutionParty))||norm(own?.institution)&&[-1,0,1].some(delta=>[...(fx.get(fxKey(row,norm(own.institution),date(row)+delta,row.direction==='outflow'?'inflow':'outflow'))?.values()||[])].some(p=>p.currency!==row.currency&&p.account!==identity(row)))))reason='possible_currency_conversion';
    else if(deposits.includes(row.account_kind)&&!form&&!/\b(?:pos|purchase|debit card|checkcard)\b/.test(text)&&[...String(row.description||'').matchAll(locator)].some(m=>m[1]!==row.account&&[...(registryAccounts.get(row.tenant_id)?.values()||[])].some(a=>identity(a)!==identity(row)&&resolvesExactAccount(m[0],a,registryAccounts.get(row.tenant_id),true,false))))reason='names_another_account';
    else if(entities.some(e=>(e.tenant_id===undefined||e.tenant_id===row.tenant_id)&&[e.legal_name,e.display_label].some(v=>sameParty(counterparty,v))))reason='counterparty_is_owned_entity';
    else if(['ordinary','refund'].includes(d.money_kind)&&accounts.some(a=>a.tenant_id===row.tenant_id&&identity(a)!==identity(row)&&[a.label,a.institution].some(v=>sameParty(counterparty,v)))&&!form&&!bankEarnings)reason='counterparty_is_recorded_account_party';
    else if(d.money_kind==='ordinary'&&trusted&&!operatingCategory.includes(category)&&balanceSheet.test(category))reason='category_names_nonoperating_account';
    // An outside party proves identity, not which side of a refund or dispute
    // this posting belongs to. Keep the figure until the category/credit record
    // resolves a customer return, temporary credit, or buyer-side re-debit.
    else if(['ordinary','refund'].includes(d.money_kind)&&temporaryCredit.test(text))reason='kind_not_proved';
    else if(d.money_kind==='ordinary'&&row.direction==='outflow'&&!code&&returnLanguage.test(text))reason='kind_not_proved';
    else if(d.money_kind==='refund'&&row.direction==='outflow'&&!seller&&rows.some(p=>sameBook(p,row)&&identity(p)===identity(row)&&p.direction==='inflow'&&p.amount_minor===row.amount_minor&&date(p)<date(row)&&date(row)-date(p)<=180&&readings.get(p.id)?.money_kind==='refund'&&readings.get(p.id)?.refund_minor>0))reason='kind_not_proved';
    else if(d.money_kind==='ordinary'&&(principalWords.test(text+' '+category)||row.direction==='outflow'&&giftCardCashOut.test(text+' '+category)||['escrow','trust'].includes(row.account_kind)))reason='kind_not_proved';
    else if(!code&&!ownerRefundCode&&!form&&taxParties.includes(institutionParty))reason='tax_payment_type_unproved';
    else if(!code&&!ownerRefundCode&&!form&&!seller&&financialParties.includes(institutionParty))reason='financial_counterparty_type_unproved';
    if(reason){doubt(reason);continue;}
    // Corporate suffixes do not turn a supplier's credit into a new customer.
    // Prior spending nominates return risk; it never proves a refund or changes
    // the cash figure. Limit that nomination to observed earlier spending: a
    // small debit to a customer does not make every larger receipt a refund.
    // Both sides use the same canonical party key.
    const supplierCredit=d.money_kind==='ordinary' && row.direction==='inflow' && Number.isSafeInteger(row.amount_minor) && /\bcredit\b/.test(text) &&
      registryName(row.payee) && BigInt(row.amount_minor)<=supplierSpent(row);
    const risk=supplierCredit?'return_membership_unproved':moneyTypeRisk(row);
    // A role identifies a seller, not the type of each receipt. A confirmed
    // operating category cannot make contradictory principal/return text safe.
    const riskProof=code && (d.money_kind!=='ordinary' || bankEarnings ||
      risk==='financial_counterparty_type_unproved' && /^(?:interest|interest expense|bank fees|processor fees)$/.test(category) ||
      code && risk==='tax_payment_type_unproved' && /^(?:payroll taxes|sales taxes?)$/.test(category));
    if(risk && !riskProof && d.money_kind==='ordinary'){doubt(risk);continue;}
    if(code){d.kind_proof='code';continue;}
    if(form){d.kind_proof='form';continue;}
    if(d.money_kind==='ordinary'&&seller&&row.direction==='inflow'){d.kind_proof='role';continue;}
    if(d.money_kind==='refund'&&d.sales_adjust_minor>0&&seller&&row.category_basis_state==='confirmed'&&['chargeback recovery','chargeback reversal','dispute recovery','dispute reversal'].includes(category)){d.kind_proof='role';continue;}
    if(['refund_reversal','deposit_reversal','payment_reversal'].includes(d.money_kind)) {
      const original=byId.get(reversalOriginal.get(row.id));
      if(original&&rows.filter(p=>sameBook(p,row)&&identity(p)===identity(row)&&p.direction!==row.direction&&p.amount_minor===row.amount_minor&&date(p)<=date(row)&&date(row)-date(p)<=6).length===1){d.kind_proof='matched_reversal';continue;}
    }
    if(d.money_kind==='refund'&&row.direction==='inflow'&&d.refund_minor>0) {
      const prior=rows.filter(p=>p!==row&&sameBook(p,row)&&p.direction==='outflow'&&date(p)<=date(row)&&date(row)-date(p)<=180);
      const related=prior.filter(p=>party(row)&&party(p)===party(row)||p.amount_minor===row.amount_minor&&date(row)-date(p)<=60);
      const counted=p=>{const v=readings.get(p.id);return Boolean(v?.kind_proof&&!v.estimated&&(v.money_kind==='ordinary'||v.interest_expense_minor>0));};
      const veto=related.some(p=>!counted(p));
      const equal=prior.filter(p=>identity(p)===identity(row)&&p.amount_minor===row.amount_minor&&date(row)-date(p)<=60);
      const originals=equal.length===1&&counted(equal[0])?[equal[0]]:prior.filter(p=>party(row)&&party(p)===party(row)&&counted(p));
      let needed=BigInt(row.amount_minor);const allocations=[];
      for(const p of originals){const remaining=BigInt(p.amount_minor)-(spent.get(p.id)||0n),used=remaining<needed?remaining:needed;if(used>0n){allocations.push([p.id,used]);needed-=used;}}
      const coded=row.category_basis_state==='confirmed'&&classes.refund.includes(category);
      if(!veto&&(needed===0n||coded&&related.length===0)){for(const [id,used] of allocations)spent.set(id,(spent.get(id)||0n)+used);d.kind_proof=needed===0n?'original':'code';continue;}
      doubt('refund_original_not_counted');d.money_type_wording_only='refund';continue;
    }
    if(d.money_kind==='ordinary') {
      const external=outside(row,own);
      const ordinaryCategory=row.direction==='inflow'?incomeCategory.test(category)&&!negatedIncomeCategory.test(category):classes.expense.includes(category);
      if(!external && !ordinaryCategory || !deposits.includes(row.account_kind) && !(liabilities.includes(row.account_kind) && row.account_basis==='confirmed')){
        doubt(external?'kind_not_proved':rail.test(text)||movementDescriptor.test(text)?'rail_only_counterparty_unrecorded':'counterparty_unrecorded');continue;
      }
      d.kind_proof=row.direction==='outflow' && external
        ? liabilities.includes(row.account_kind) && row.account_basis==='confirmed'?'account':'party'
        :'face_value';
      continue;
    }
    doubt('kind_not_proved');
    if(['refund','refund_reversal','deposit_reversal','payment_reversal'].includes(d.money_kind))d.money_type_wording_only=d.sales_adjust_minor>0?'recovery':'reversal';
  }
}
