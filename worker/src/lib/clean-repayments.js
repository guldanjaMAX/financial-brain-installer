const liabilities = new Set(['card', 'loan', 'line_of_credit']);
const banks = new Set(['checking', 'savings']);
const order = (a,b) => a.posted_on.localeCompare(b.posted_on) || a.id-b.id;
const day = r => Date.parse(r.posted_on)/86400000;

// This is a contribution model, not transfer proof. Amount/date matches may
// prevent counting one payment twice, but never remove an ordinary expense.
export function repaymentContributions(rows, decisions, pairs, endpoints, paymentEvidence) {
  const readings = new Map(decisions.map(d=>[d.id,d]));
  const outgoing = new Map(), incoming = new Map();
  for (const p of pairs) if (p.proved) { outgoing.set(p.out_id,p); incoming.set(p.in_id,p); }
  for (const r of rows) {
    const d=readings.get(r.id), e=endpoints.get(r.id) || {};
    Object.assign(d,{paid_to_account_slug:null,paid_to_account:null,paid_basis:null,credited_minor:0,debt_moved_minor:0});
    const out=outgoing.get(r.id), received=incoming.get(r.id);
    const moved=liabilities.has(e.source_kind) && liabilities.has(e.destination_kind) && e.slug;
    // A separately posted lender interest receipt is part of cash paid, just
    // like its principal receipt. The later lender-group reconciler suppresses
    // both when the recorded bank total already counts the same payment.
    if (['card_payment','loan_payment','loan_interest'].includes(d.money_kind)) {
      d.payment_kind=d.money_kind==='card_payment'?'card':'loan';
      d.paid_to_account_slug=e.slug ?? null; d.paid_to_account=e.mask ?? null;
      if (received) {
        d.pay_row_id=received.out_id;
        const debt=liabilities.has(endpoints.get(received.out_id)?.source_kind);
        d.paid_basis=debt?'debt_moved':'proved_pair';
        d.credited_minor=debt?0:r.amount_minor;
      } else if (r.direction==='outflow' && d.classification==='card_or_loan_payment' && (banks.has(e.source_kind) || moved)) {
        if (moved) { d.debt_moved_minor=r.amount_minor; d.paid_basis='debt_moved'; }
        else { d.paid_minor=r.amount_minor; d.paid_basis=out?'proved_pair':'owned_endpoint'; }
      } else if (r.direction==='inflow' && liabilities.has(e.source_kind) &&
          (d.classification==='card_or_loan_payment' || paymentEvidence(r))) {
        d.paid_minor=r.amount_minor; d.credited_minor=r.amount_minor; d.paid_basis='credit_only';
      }
    }
    if (out && moved && liabilities.has(endpoints.get(out.in_id)?.source_kind)) {
      d.paid_minor=0; d.debt_moved_minor=r.amount_minor; d.paid_basis='debt_moved';
      d.paid_to_account_slug=e.slug; d.paid_to_account=e.mask;
    }
  }
}

export function reconcileRepayments(rows, decisions, pairs, endpoints) {
  const readings=new Map(decisions.map(d=>[d.id,d]));
  const provedOut=new Set(pairs.filter(p=>p.proved).map(p=>p.out_id));
  const groups=new Map();
  for (const r of rows) {
    const d=readings.get(r.id);
    if (!d.paid_to_account_slug) continue;
    const paying=r.direction==='outflow' && (d.paid_basis==='owned_endpoint' || d.paid_basis==='debt_moved' && !provedOut.has(r.id));
    const credit=d.paid_basis==='credit_only' && d.credited_minor>0;
    if (!paying && !credit) continue;
    const key=JSON.stringify([r.tenant_id,r.currency,r.amount_minor,d.paid_to_account_slug]);
    const group=groups.get(key) || {paying:[],credits:[]};
    group[paying?'paying':'credits'].push(r); groups.set(key,group);
  }
  for (const {paying,credits} of groups.values()) {
    paying.sort(order); credits.sort(order);
    // Match repeated equal payments in posting order, once per side. A week
    // includes weekends/settlement lag; this remains explicitly likely.
    let next=0;
    for (const p of paying) {
      while (next<credits.length && day(credits[next])<day(p)-3) next++;
      const c=credits[next]; if (!c || day(c)>day(p)+7) continue;
      next++;
      const pd=readings.get(p.id), cd=readings.get(c.id);
      cd.paid_minor=0; cd.pay_row_id=p.id;
      if (pd.debt_moved_minor) { cd.credited_minor=0; cd.paid_basis='likely_debt_moved'; }
      else cd.paid_basis=pd.paid_basis='likely_same_payment';
    }
    // Longer gaps are evidence of possible double counting, not a license
    // to erase a separate payment. Bound work by sorting and a sliding window.
    let start=0;
    for (const p of paying) {
      const pd=readings.get(p.id); if(pd.paid_basis!=='owned_endpoint')continue;
      while(start<credits.length && day(credits[start])<day(p)-10)start++;
      const c=credits.slice(start,start+1).find(c=>day(c)<=day(p)+10 && readings.get(c.id).paid_basis==='credit_only');
      if(c){pd.paid_basis=readings.get(c.id).paid_basis='likely_paid_possible_same_payment';}
    }
  }
  const byId=new Map(rows.map(r=>[r.id,r]));
  for (const p of pairs) if (p.unique_match && !p.proved) {
    const debit=byId.get(p.out_id), credit=byId.get(p.in_id), pd=readings.get(p.out_id), cd=readings.get(p.in_id);
    if (!pd || cd?.paid_basis!=='credit_only') continue;
    if (pd.paid_basis==='memo_split' && ['loan','line_of_credit'].includes(endpoints.get(credit.id)?.source_kind)) {
      cd.paid_minor=0;cd.pay_row_id=debit.id;cd.paid_basis=pd.paid_basis='likely_same_payment';
      pd.paid_to_account_slug=cd.paid_to_account_slug;pd.paid_to_account=cd.paid_to_account;
    } else if (liabilities.has(endpoints.get(debit.id)?.source_kind)) cd.paid_basis='likely_paid_possible_debt_moved';
  }
}

// A generic bank payment debit can be the same payment as an unmatched card
// or loan credit that posts outside the three-day pair window. Without a
// destination this is never proof: the debit stays counted spending and is
// flagged as a possible repayment with its exact dollars (founder rule).
export function flagLaggedPaymentDebits(rows, decisions, pairs, endpoints, paymentEvidence) {
  const readings=new Map(decisions.map(d=>[d.id,d]));
  const key=r=>JSON.stringify([r.tenant_id,r.currency,String(r.amount_minor)]);
  const credits=new Map();
  for (const r of rows) {
    if (r.direction!=='inflow' || !r.posted_on || readings.get(r.id)?.paid_basis!=='credit_only') continue;
    const list=credits.get(key(r)) || []; list.push(r); credits.set(key(r),list);
  }
  if (!credits.size) return;
  const paired=new Set(pairs.flatMap(p=>[p.out_id,p.in_id]));
  // Issuer memos such as "WELLS FARGO CARD CCPYMT" carry no payment word we
  // know, but they name a card. A merchant debit (control: OFFICE DEPOT) does
  // not, so an equal amount alone still never nominates it. Flag only.
  const cardDebit=r=>/\b(?:card|crd|cardmember|cc ?(?:pymt|pmt|payment|pay)|ccpay\w*)\b/.test(String(r.description || '').toLowerCase().replace(/[^a-z0-9]+/g,' '));
  for (const r of rows) {
    const d=readings.get(r.id);
    if (r.direction!=='outflow' || !r.posted_on || d?.money_kind!=='ordinary' || d.estimated || paired.has(r.id) ||
      !banks.has(endpoints.get(r.id)?.source_kind) || !paymentEvidence(r) && !cardDebit(r)) continue;
    const match=(credits.get(key(r)) || []).find(c=>day(c)>=day(r)-3 && day(c)<=day(r)+10);
    if (!match) continue;
    const kind=endpoints.get(match.id)?.source_kind==='card'?'card':'loan';
    Object.assign(d,{classification:'unknown',estimated:1,estimate_reason:'possible_'+kind+'_payment_lagged_credit_counted',uncertain_kind:kind+'_payment'});
  }
}
