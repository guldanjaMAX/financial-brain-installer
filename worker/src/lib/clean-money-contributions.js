import { normalizeLedgerText, reversalForm, moneyProcessor } from './money-analysis.js';
import { reconcileInterest } from './clean-interest.js';
import { repaymentContributions, reconcileRepayments, flagLaggedPaymentDebits } from './clean-repayments.js';
import { certifyMoneyKinds } from './clean-money-evidence.js';

const splitWord='(?!(?:fee|fees|late|escrow|insurance|tax|taxes|penalty|charge|charges|reversal|reversed|returned|refund|principal|princ|prin|prncpl|interest|intrst|int)(?: |$))[a-z]+';
const splitP='(?:principal|princ|prin|prncpl)',splitI='(?:interest|intrst|int)';
const splitAmount='(\\d+(?:\\.\\d{1,2})?)(?: usd)?';
const statedSplit=new RegExp(`^(?:${splitWord} ){0,4}(?:loan|mortgage|mtg|heloc) (?:payment|pmt|pymt|repayment)(?: ${splitWord}){0,3} `+
  `(?:${splitP} ${splitAmount} (?:and )?${splitI} ${splitAmount}|${splitI} ${splitAmount} (?:and )?${splitP} ${splitAmount})$`);
export function statedLoanSplit(description) {
  const raw=String(description||'').normalize('NFKC').toLowerCase();
  // Do not repair malformed grouping, negative components or European decimals
  // into a plausible split. The posted cents must still reconcile exactly.
  if(/\d,\d{1,2}(?:\D|$)|[-−]\s*\$?\d|\(\s*\$?\d/.test(raw))return null;
  const text=raw.replace(/(\d),(?=\d{3}(?:\D|$))/g,'$1').replace(/(\d)\.(?=\d)/g,'$1\u0001')
    .replace(/[^a-z0-9\u0001]+/g,' ').replace(/\u0001/g,'.').trim();
  const m=statedSplit.exec(text);
  return !m ? null : m[1]!==undefined ? {principal:m[1],interest:m[2]} : {principal:m[4],interest:m[3]};
}

export const CONTRIBUTION_FIELDS=['paid_minor','refund_minor','sales_adjust_minor','interest_stated_minor','interest_expense_minor','interest_overlap_minor','income_adjust_minor','payment_kind','paid_to_account_slug','paid_to_account','paid_basis','credited_minor','debt_moved_minor','cross_side_minor','duplicate_minor','reversal_payer_group'];
const paymentEvidence=r=>/\b(?:payment|pymt|pmt|autopay|payoff)\b/.test(normalizeLedgerText(r.description)) ||
  (r.category_basis_state==='confirmed'||r.provenance==='feed') && /^loan payments?\b|^credit card payment\b/.test(normalizeLedgerText(r.category));

// Gross postings remain immutable. Signed contributions make the intended
// question explicit without summing both sides of one payment or inventing fees.
export function cleanMoneyContributions(rows,decisions,pairs,accounts=[],{depositOriginal=new Map(),transferOriginal=new Map(),endpoints=new Map(),entities=[]}={}){
  const byId=new Map(rows.map(r=>[r.id,r])),readings=new Map(decisions.map(d=>[d.id,d]));
  const reversalOriginal=new Map([...depositOriginal,...transferOriginal]);
  for(const d of decisions){
    const r=byId.get(d.id);Object.assign(d,{paid_minor:0,refund_minor:0,sales_adjust_minor:0,interest_stated_minor:0,income_adjust_minor:0,payment_kind:null,cross_side_minor:0,duplicate_minor:d.duplicate_minor||0,reversal_payer_group:null});
    if(d.money_kind==='own_transfer' && ['business','personal'].includes(r.side) &&
      ['business','personal'].includes(d.counterpart_side) && r.side!==d.counterpart_side)d.cross_side_minor=r.amount_minor;
    if(d.money_kind==='refund'){
      if(r.direction==='inflow' && /(?<!sales )\btax (?:refund|ref|rfd)\b/.test(normalizeLedgerText(r.description))) { /* Government tax money is not merchant money back. */ }
      // Buyer-side liability recoveries offset purchases. A seller recovery
      // on an asset/processor account instead restores the returned sale.
      else if(r.direction==='inflow' && !['card','loan','line_of_credit'].includes(r.account_kind) && /\b(?:chargeback|dispute)\b.*\b(?:reversal|reversed|won)\b/.test(normalizeLedgerText(r.description)))d.sales_adjust_minor=r.amount_minor;
      else if(r.direction==='inflow')d.refund_minor=r.amount_minor;
      else d.sales_adjust_minor=-r.amount_minor;
    }
    if(d.money_kind==='loan_interest')d.interest_stated_minor=r.amount_minor;
    if(d.money_kind==='refund_reversal')d.refund_minor=-r.amount_minor;
    if(d.money_kind==='deposit_reversal'){
      const original=depositOriginal.get(r.id);
      if(original===undefined || readings.get(original)?.money_kind==='ordinary'){
        d.income_adjust_minor=-r.amount_minor;
        // Attribute the signed reversal to its processor, its proved original
        // deposit, or one unique equal ordinary deposit; never invent a payer.
        const processor=moneyProcessor(r);
        const payerOf=p=>moneyProcessor(p)?'processor:'+moneyProcessor(p):String(p.payee || p.description || '').trim().toLowerCase();
        if(processor)d.reversal_payer_group='processor:'+processor;
        else if(original!==undefined)d.reversal_payer_group=payerOf(byId.get(original));
        else {
          const candidates=rows.filter(p=>p.tenant_id===r.tenant_id && p.account_identity===r.account_identity &&
            p.direction==='inflow' && p.currency===r.currency && p.amount_minor===r.amount_minor && p.posted_on<=r.posted_on &&
            Date.parse(r.posted_on)-Date.parse(p.posted_on)<=14*86400000 && readings.get(p.id)?.money_kind==='ordinary');
          // Keep unmatched reversals signed and visible, without inventing a payer.
          d.reversal_payer_group=candidates.length===1 ? payerOf(candidates[0]) : 'unattributed deposit reversal';
        }
      }
      else d.estimate_reason='deposit_reversal_original_not_income';
    }
  }
  repaymentContributions(rows,decisions,pairs,endpoints,paymentEvidence);
  for(const d of decisions){
    const r=byId.get(d.id);
    // Retain the bank memo's punctuation until after decimal parsing. A split
    // is exposed only when both stated parts reconcile exactly to the debit.
    const split=r.direction==='outflow'?statedLoanSplit(r.description):null;
    if(split){const cents=s=>{const [a,b='']=s.split('.');return Number(a)*100+Number(b.padEnd(2,'0'));};
      const principal=cents(split.principal),interest=cents(split.interest);
      if(Number.isSafeInteger(principal+interest) && principal+interest===r.amount_minor){
        d.interest_stated_minor=interest;d.payment_kind='loan';d.estimated=1;
        if(['checking','savings'].includes(endpoints.get(r.id)?.source_kind)) {d.paid_minor=r.amount_minor;d.paid_basis='memo_split';}
        // A reconciled memo supports a likely component, not an owned repayment
        // endpoint. Keep an unproved ordinary debit counted in full spending.
        d.estimate_reason=d.money_kind==='ordinary'?'memo_split_needs_statement_counted':'memo_split_needs_statement';
      }
    }
  }
  // A transfer return can undo an already excluded owned movement. Matching
  // an ordinary row is insufficient authority to remove any dollars.
  for(const [id,original] of transferOriginal){
    const d=readings.get(id),prior=readings.get(original);
    if(prior?.money_kind!=='own_transfer')continue;
    Object.assign(d,{classification:'own_transfer',money_kind:'own_transfer',estimated:1,estimate_reason:'transfer_reversal_needs_reconciliation',
      paid_minor:0,refund_minor:0,sales_adjust_minor:0,interest_stated_minor:0,income_adjust_minor:0,payment_kind:null,
      paid_to_account_slug:null,paid_to_account:null,paid_basis:null,credited_minor:0,debt_moved_minor:0});
  }
  reconcileRepayments(rows,decisions,pairs,endpoints);
  flagLaggedPaymentDebits(rows,decisions,pairs,endpoints,paymentEvidence);
  // Separate lender postings can explain a payment only with one recorded
  // lender identity, one dated receipt group, and an exact currency/amount
  // reconciliation. Amount coincidence alone never supplies the endpoint.
  for(const d of decisions.filter(d=>d.money_kind==='loan_payment')){
    const debit=byId.get(d.id);if(debit.direction!=='outflow')continue;
    const targets=accounts.filter(a=>a.tenant_id===debit.tenant_id && ['loan','line_of_credit'].includes(a.account_kind) &&
      debit.payee && [a.label,a.institution].some(v=>normalizeLedgerText(v)===normalizeLedgerText(debit.payee)));
    if(targets.length!==1)continue;
    const target=targets[0],receipts=rows.filter(r=>r.account_identity===target.account_identity && r.tenant_id===debit.tenant_id && r.currency===debit.currency && r.direction==='inflow' &&
      Math.abs(Date.parse(r.posted_on)-Date.parse(debit.posted_on))<=3*86400000 && /^(?:principal payment|interest payment|payment (?:received|thank you)(?: thank you)?)$/.test(normalizeLedgerText(r.description)));
    const dates=[...new Set(receipts.map(r=>r.posted_on))].map(day=>receipts.filter(r=>r.posted_on===day)).filter(group=>group.reduce((n,r)=>n+BigInt(r.amount_minor),0n)===BigInt(debit.amount_minor));
    if(dates.length!==1)continue;
    d.payment_account_identity=target.account_identity;
    for(const receipt of dates[0])readings.get(receipt.id).paid_minor=0;
  }
  // A returned deposit and a returned payment share the original-posting
  // budget. Different bank labels must not undo the same receipt twice.
  const consumed=new Set([...depositOriginal.values(),...transferOriginal.values()]);
  for(const d of decisions.filter(d=>d.money_kind==='payment_reversal').sort((a,b)=>byId.get(a.id).posted_on.localeCompare(byId.get(b.id).posted_on)||a.id-b.id)){
    const r=byId.get(d.id);
    const prior=rows.filter(p=>p.tenant_id===r.tenant_id && p.account_identity===r.account_identity && p.direction!==r.direction && p.currency===r.currency &&
      !consumed.has(p.id) && !depositOriginal.has(p.id) && !['payment_reversal','deposit_reversal','refund_reversal'].includes(readings.get(p.id)?.money_kind) && p.amount_minor===r.amount_minor && p.posted_on<=r.posted_on && Date.parse(r.posted_on)-Date.parse(p.posted_on)<=6*86400000 && paymentEvidence(p));
    // Reversal-worded credits were refunds before this grammar was extended.
    // Keep that result unless an actual excluded debt payment proves otherwise.
    const form=reversalForm(r,['card','loan','line_of_credit'].includes(r.account_kind));
    if(form?.refund_today && (prior.length!==1 || !['card_payment','loan_payment'].includes(readings.get(prior[0].id)?.money_kind))){
      Object.assign(d,{classification:'refund',money_kind:'refund',refund_minor:r.amount_minor,paid_minor:0,payment_kind:null,estimated:0,estimate_reason:null});continue;
    }
    if(prior.length===1){const payment=readings.get(prior[0].id);d.paid_minor=-payment.paid_minor;d.payment_kind=payment.payment_kind;
      d.credited_minor=-payment.credited_minor;d.debt_moved_minor=-payment.debt_moved_minor;
      d.paid_to_account_slug=payment.paid_to_account_slug;d.paid_to_account=payment.paid_to_account;d.paid_basis='reversal';
      consumed.add(prior[0].id);
      reversalOriginal.set(d.id,prior[0].id);
      if(r.direction==='inflow' && payment.money_kind==='ordinary'){d.refund_minor=r.amount_minor;d.estimated=1;d.estimate_reason='returned_payment_refund_counted';}
      if(r.direction==='outflow' && !['card','loan','line_of_credit'].includes(r.account_kind) && payment.money_kind==='ordinary'){
        Object.assign(d,{classification:'refund',money_kind:'deposit_reversal',income_adjust_minor:-r.amount_minor,paid_minor:0,payment_kind:null,estimated:1,estimate_reason:'deposit_reversal_needs_reconciliation',
          paid_to_account_slug:null,paid_to_account:null,paid_basis:null,credited_minor:0,debt_moved_minor:0});
      }
    }
    else {d.estimated=1;d.estimate_reason='payment_reversal_original_missing';}
  }
  reconcileInterest(rows,decisions,accounts,endpoints);
  // Recognition and a unique original do not prove that every economic
  // component was undone. Check the final contributions after all reconcilers,
  // including future signed fields; overlap/duplicate dollars are diagnostics.
  // Keep this evidence private to scoring, outside the public SQL catalogue.
  const signed=CONTRIBUTION_FIELDS.filter(k=>k.endsWith('_minor') && !['duplicate_minor','interest_overlap_minor'].includes(k));
  for(const [id,original] of reversalOriginal){
    const d=readings.get(id),prior=readings.get(original);if(!d || !prior)continue;
    const gaps=signed.filter(k=>prior[k] && d[k]!==-prior[k])
      .map(field=>({field,residual_minor:prior[field]+(d[field]||0)}));
    if(gaps.length){d.reversal_original_id=original;d.reversal_contribution_gaps=gaps;}
  }
  certifyMoneyKinds(rows,decisions,accounts,pairs,entities,reversalOriginal);
}
