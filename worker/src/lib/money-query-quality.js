import { moneyMinorNumber } from './money-format.js';
import { coverageInPeriod, unreadableInPeriod } from './clean-money-period.js';
import { shiftDay } from './money-query-budget.js';
import { applyAccountKindReview } from './fin-account-kinds.js';
import { moneyAccountStart } from './money-confidence.js';
import { moneyOverlapGroups } from './money-query-overlap.js';
import { historyHoles } from './money-history.js';

// Confidence describes evidence, not model certainty. A closed account/date
// selection can prove a complete historical interval; opaque SQL cannot.
export function moneyQueryQuality(snapshot, decisions = [], {truncated=false,selection=null,readsRawTransactions=false,accountEvidence=[],measure=null,asOf=null,pendingRequested=false,immaterialRisk=false} = {}) {
  const gaps=[],caveats=[];let score=100;
  const gap=(code,penalty,why,missing,details={})=>{score-=penalty;gaps.push({code,why,missing,...details});};
  const sum=rows=>{const n=rows.reduce((n,r)=>n+BigInt(r.amount_minor || 0),0n),v=Number(n);return Number.isSafeInteger(v)?v:n.toString();};
  const amounts=rows=>[...new Set(rows.map(r=>r.currency))].sort().map(currency=>({currency,
    inflow_minor:sum(rows.filter(r=>r.currency===currency && r.direction==='inflow')),
    outflow_minor:sum(rows.filter(r=>r.currency===currency && r.direction==='outflow'))}));
  const accounts=rows=>rows.map(c=>({account:c.account,account_slug:c.account_slug,from:c.covered_from,to:c.covered_to}));
  const selected=r=>!selection || ['account_slug','account_identity','account','tenant_id','side','currency','entity'].every(k=>!selection[k] || r[k]===selection[k]);
  const byId=new Map(decisions.map(d=>[d.id,d]));
  const selectedRow=r=>selected(r) && (!selection?.direction || selection.direction===r.direction) &&
    (!selection?.money_kind || selection.money_kind===(byId.get(r.id)?.money_kind==='ordinary' && r.direction==='inflow' && byId.get(r.id)?.processor_name?'payout':byId.get(r.id)?.money_kind));
  if(!snapshot)gap(readsRawTransactions?'unclassified_query':'not_transaction_evidence',readsRawTransactions?60:20,
    readsRawTransactions?'This query read raw transactions without classified membership.':'This figure was read from stored balances, obligations or document records and was not checked against transactions.',
    readsRawTransactions?'Read txn and coverage for classified amounts and account/date coverage.':'A dated statement or source record and reconciliation to the requested account and period.');
  else {
    if(snapshot.partial){const missing=snapshot.missing||[];
      gap('input_incomplete',100,'The bounded snapshot omits current source rows; this figure is a partial estimate, not a complete total.',
        'Read smaller from/to windows covering the requested period and add their classified results.',{missing_rows_at_least:1,
          missing_rows:missing.reduce((n,r)=>n+r.n,0),from:missing.map(r=>r.first).filter(Boolean).sort()[0]??null,
          to:missing.map(r=>r.last).filter(Boolean).sort().at(-1)??null,
          amounts:amounts(missing.map(r=>({currency:r.currency,direction:r.direction,amount_minor:r.minor})))});
    }
    const coverage=coverageInPeriod(snapshot,selection,asOf).filter(selected).map(c=>{
      // Only matching private evidence can supply completed history and sync.
      const account=accountEvidence.find(a=>a.tenant_id===c.tenant_id && a.account_slug===c.account_slug);
      const recorded=snapshot.accounts.find(a=>a.tenant_id===c.tenant_id && a.account_slug===c.account_slug);
      const history=account || c;
      // A proposed opening date cannot erase required statement days. Keep
      // independently completed feed history eligible to establish the start.
      const startEvidence=recorded?.basis_state==='confirmed'?history:{...history,opened_on:null};
      return {...c,account_start:moneyAccountStart(startEvidence),last_sync:account ? account.last_sync : c.last_sync};
    }),rows=snapshot.rows.filter(r=>selectedRow(r) &&
      (!selection?.from || r.posted_on>=selection.from && r.posted_on<=selection.to));
    const bounded=Boolean(selection?.from && selection?.to);
    if(selection?.account_slug){
      const identities=new Set(coverage.map(c=>c.account_identity));
      const linked=snapshot.coverage.filter(c=>identities.has(c.account_identity) && c.account_slug!==selection.account_slug);
      const moved=snapshot.rows.filter(r=>linked.some(c=>c.tenant_id===r.tenant_id && c.account_slug===r.account_slug) &&
        (!bounded || r.posted_on>=selection.from && r.posted_on<=selection.to));
      if(moved.length)gap('linked_record_rows',25,'Some postings for this account are kept under a linked record and are absent from the account_slug filter.',
        'Filter by account_identity to include all records of the owner-linked account.',{accounts:accounts(linked),amounts:amounts(moved)});
    }
    const lifecycle=c=>snapshot.accounts.some(a=>a.tenant_id===c.tenant_id && a.account_slug===c.account_slug && a.basis_state==='confirmed');
    const incomplete=coverage.filter(c=>!(bounded && (c.account_start>selection.to || lifecycle(c) && c.closed_on && c.closed_on<selection.from)) &&
      (c.coverage_status!=='complete' || c.coverage_basis_state!=='confirmed' ||
      !c.covered_from || !c.covered_to || bounded &&
      (c.covered_from>(c.account_start>selection.from?c.account_start:selection.from) ||
        c.covered_to<(lifecycle(c) && c.closed_on && c.closed_on<selection.to?c.closed_on:selection.to))));
    const clipped=coverage.filter(c=>bounded && lifecycle(c) && (c.opened_on>selection.from || c.closed_on && c.closed_on<selection.to));
    if(clipped.length)caveats.push({code:'account_lifecycle_boundary',why:'Coverage is required only while each confirmed account was open.',accounts:accounts(clipped)});
    const proved=bounded && coverage.length>0 && incomplete.length===0;
    if(!proved)gap('selection_coverage_unverified',10,'The requested accounts and from-through dates are not independently covered by complete confirmed history.',
      'A literal account/date selection and complete confirmed statement coverage for that period.',{accounts:accounts(coverage)});
    caveats.push({code:'account_inventory_boundary',why:'Coverage describes the recorded account inventory; accounts never declared by the owner cannot be inferred.'});
    if(!coverage.length || !rows.length && !proved)gap('no_posted_history',60,'No posted transaction history is available for this selection.',
      'Connected account history or an imported statement for the requested period.');
    if(incomplete.length)gap('incomplete_coverage',25,'Some selected account date ranges are not confirmed complete.',
      'Complete statements or synced history for the listed accounts and dates.',{accounts:accounts(incomplete),from:selection?.from,to:selection?.to});
    const holes=coverage.flatMap(c=>historyHoles(snapshot.historyRows || snapshot.rows,c,selection).map(h=>({...h,account:c.account,account_slug:c.account_slug})));
    if(holes.length)gap('possible_feed_hole',11,'A busy account has an unusually long silent run inside stated coverage; $0 quantified; amount unknown.',
      'Complete statements or a bank history reconciliation for the listed dates.',{dates:holes});
    const uncertain=rows.filter(r=>byId.get(r.id)?.estimated);
    if(uncertain.length){
      const penalties=amounts(uncertain).flatMap(a=>['inflow','outflow'].map(direction=>{
        const total=rows.filter(r=>r.currency===a.currency && r.direction===direction).reduce((n,r)=>n+BigInt(r.amount_minor||0),0n),
          estimated=BigInt(a[direction+'_minor']);return Number((35n*estimated+(total||1n)-1n)/(total||1n));}));
      const penalty=Math.min(35,Math.max(11,...penalties));
      const reasons=[];
      for(const reason of [...new Set(uncertain.map(r=>byId.get(r.id).estimate_reason))].sort()){
        const group=uncertain.filter(r=>byId.get(r.id).estimate_reason===reason);
        for(const amount of amounts(group)){
          const affected=group.filter(r=>r.currency===amount.currency);
          // The frozen classifier also sees bank categories. A generic issuer
          // memo must retain the same card-payment disclosure as a spelled-out
          // memo, without folding unrelated loan candidates into its dollars.
          const cardRows=reason?.endsWith('_counted') ? affected.filter(r=>r.direction==='outflow' &&
            (byId.get(r.id)?.uncertain_kind==='card_payment' || /\b(?:card|crcardpmt|cardmember|crd)\b/i.test(r.description||''))) : [];
          const cardMinor=cardRows.reduce((n,r)=>n+r.amount_minor,0);
          const note=cardRows.length?'may be a card payment: '+new Intl.NumberFormat('en-US',{style:'currency',currency:amount.currency}).format(moneyMinorNumber(cardMinor, amount.currency)):null;
          const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:amount.currency}).format(moneyMinorNumber(n, amount.currency));
          const covered=affected.reduce((n,r)=>n+BigInt(byId.get(r.id)?.sweep_covered_minor||0),0n);
          const movementNote={
            return_type_negated_counted:`Conflicting credit type: ${money(amount.inflow_minor)} is still in the provisional cash reading, but the memo negates a refund. Obtain the issuer credit memo and statement to distinguish a reward from a purchase refund.`,
            return_type_conflicts_with_receipt_counted:`Conflicting receipt type: ${money(amount.inflow_minor)} may be invoice income omitted as a refund; the wording alone does not prove either type. Obtain the invoice, payment receipt and any refund or credit record.`,
            cash_advance_use_unrecorded:`Borrowed cash principal: ${money(amount.outflow_minor)} is left out of purchase spending; its subsequent cash use is unknown. Separately posted fees remain expenses. Obtain the cash ledger and cash receipts before treating the advance as a purchase.`,
            possible_refundable_principal_counted:`Possible refundable deposit principal: ${[amount.inflow_minor?money(amount.inflow_minor)+' received':null,amount.outflow_minor?money(amount.outflow_minor)+' paid':null].filter(Boolean).join(' and ')} remains in the provisional cash figure; operating expense/refund membership is unproved. Obtain the deposit ledger, deposit terms and original posting to distinguish principal from an operating refund or expense.`,
            possible_interest_component_in_counted_payment:`Possible interest overlap: ${money(amount.inflow_minor)} is already inside a counted bank payment; the lender posting is not added again. Obtain the lender statement and payment reconciliation.`,
            possible_third_party_funds_counted:`Possible third-party liability settlement: ${money(amount.outflow_minor)} remains counted in spending; operating-expense membership is unproved. Obtain the beneficiary payable ledger and reconcile this cash debit to the entrusted funds before excluding it.`,
            possible_processor_sweep_counted:`Likely processor payout counted; up to ${money(covered)} may already be included in connected merchant-account sales. Match the processor statement and bank deposit.`,
            processor_sweep_unmatched_excluded:'Likely sweep left out because connected merchant-account sales already cover it; the matching payout debit or processor settlement statement is missing.',
            processor_payout_bank_leg_missing_excluded:'Likely merchant-account payout left out of spending; the bank receipt or processor settlement statement is missing.',
            own_transfer_bank_code_only_excluded:'Likely transfer left out from equal bank-coded amounts; the memo does not identify the owned counterpart. Check both account statements; if this is a customer payment, add these inflow dollars to income.',
            own_transfer_account_kind_locators_excluded:'Likely transfer left out; the memos name account kinds but no specific account. Match both statements to the connected account identities.',
            own_transfer_counter_entry_missing_excluded:'Likely transfer left out; an owned account is named but no equal counter-entry is recorded. Match the other account statement; this is not proved.',
            own_transfer_counter_entry_ambiguous_excluded:'Likely transfer left out; the owned account locator has equal candidate receipts but no unique match. Match the dated account statements; no individual pair is proved.',
            own_transfer_repeated_bank_codes_excluded:'Likely repeated transfers left out using the bank-coded set; individual equal movements cannot be distinguished. Match the dated statements.',
            processor_return_debit_unconfirmed:'Likely returned sales, excluded from spending and subtracted from net sales; confirm the refund, dispute or chargeback type on the processor statement.',
            processor_return_recovery_unconfirmed:'Likely refund/dispute recovery added back to net sales; match the original debit and processor statement.',
            processor_reserve_held:'Likely owner money held in reserve, excluded from spending; confirm the held balance and its release on the processor statement.',
            processor_reserve_returned:'Likely owner reserve returned, excluded from income; confirm the matching held balance on the processor statement.',
            processor_reserve_release_counted:'Reserve release counted as likely income because the earlier reserve hold is missing; obtain the processor reserve history before treating it as new sales.',
            payment_category_on_bank_deposit_excluded:'Bank deposit has a repayment category but no liability receipt proof; left out provisionally. Confirm whether it is a customer payment, loan repayment to the owner or an own transfer, and add these dollars to income if it is a customer payment.',
            payment_category_on_bank_deposit_counted:'Bank deposit counted as likely income despite the repayment category; an owned liability receipt is missing. Check the bank and processor statements.',
            processor_return_with_fee_unsplit_counted:'Combined returned-sales principal and fee remains counted in spending; the split is unproved. Obtain the processor statement to separate the fee from returned sales.',
          }[reason];
          reasons.push({reason,treatment:reason?.endsWith('_counted')?'counted':'left_out',rows:affected.length,...amount,
            ...(note||movementNote?{note:note||movementNote}:{}),...(covered?{possibly_repeated_sales_minor:covered.toString()}:{}),accounts:accounts(coverage.filter(c=>affected.some(r=>r.tenant_id===c.tenant_id && r.account_slug===c.account_slug))),
            from:affected.map(r=>r.posted_on).sort()[0],to:affected.map(r=>r.posted_on).sort().at(-1)});
        }
      }
      const entrusted=reasons.filter(r=>['possible_third_party_funds_counted','possible_refundable_principal_counted','possible_interest_component_in_counted_payment','cash_advance_use_unrecorded','return_type_negated_counted','return_type_conflicts_with_receipt_counted'].includes(r.reason));
      gap('estimated_membership',immaterialRisk?0:penalty,
        ['Some postings have unresolved movement membership; counted amounts may repeat other activity, and left-out amounts may be missing.',...entrusted.map(r=>r.note)].join(' '),
        entrusted.length ? [...new Set(entrusted.map(r=>({
          possible_third_party_funds_counted:'Beneficiary payable records reconciled to each listed cash debit and the original entrusted-funds receipt; separate any operating fee.',
          possible_refundable_principal_counted:'The deposit ledger, deposit terms and original posting establishing principal versus operating expense/refund.',
          possible_interest_component_in_counted_payment:'Lender statements and payment identity reconciling the bank debit with principal and interest receipts.',
          cash_advance_use_unrecorded:'The card statement, cash ledger and cash receipts separating borrowed principal, subsequent cash use and fees.',
          return_type_negated_counted:'The issuer credit memo and statement establishing whether the credit is a reward or a purchase refund.',
          return_type_conflicts_with_receipt_counted:'The invoice, payment receipt and any refund or credit record establishing the transaction type.',
        })[r.reason]))].join(' ')
          : 'Counterpart statements, bank transaction codes or an owner review of the listed postings.',{amounts:amounts(uncertain),reasons});
    }
    // Even a wrongly excluded posting needs a type certificate. A SQL filter
    // on money_kind cannot certify its own omissions.
    const certificateRows=snapshot.rows.filter(r=>selected(r) &&
      (!bounded || r.posted_on>=selection.from && r.posted_on<=selection.to));
    const unproved=certificateRows.filter(r=>byId.get(r.id)?.kind_unproved);
    const proofMissing={
      unmatched_leg_candidate:'Both account statements and the dated counterpart posting proving the movement.',
      possible_currency_conversion:'Both currency statements and the conversion confirmation separating principal and fees.',
      names_another_account:'The counterpart account statement and dated payment or transfer confirmation.',
      counterparty_is_owned_entity:'Owner category confirmation and both entity/account statements proving the money type.',
      counterparty_is_recorded_account_party:'The counterpart statement and payment or purchase record proving the money type.',
      category_names_nonoperating_account:'Owner category confirmation and the equity, payable, loan or deposit ledger proving the money type.',
      tax_payment_type_unproved:'The tax form type and owner category confirmation separating income tax from operating payroll or sales tax.',
      tax_collected_not_income:'The tax-collected payable ledger, original receipt and government remittance record separating collected tax from earned operating income.',
      financial_counterparty_type_unproved:'The lender or issuer statement and purchase/payment record separating principal, interest, fees and purchases.',
      rail_only_counterparty_unrecorded:'The payee/payable record and counterpart statement identifying these rows.',
      counterparty_unrecorded:'The payee/payable record or owner category confirmation identifying these rows.',
      refund_original_not_counted:'The original purchase and statement reconciliation proving a counted expense or interest charge, with unused refund capacity.',
      entrusted_principal_unproved:'The deposit, trust or beneficiary payable ledger and original receipt proving principal versus earned income or operating expense.',
      return_membership_unproved:'The uniquely matched original posting and issuer or processor return/reversal record.',
      kind_not_proved:'Owner-confirmed category or seller-role evidence; for income, earlier counted income from the same payee with no counted spending; otherwise the original payment, purchase or payable record.',
      prior_estimate:'The source and counterpart statements, original purchase/payment and owner category confirmation resolving the earlier estimate.',
    };
    for(const reason of [...new Set(unproved.map(r=>byId.get(r.id).kind_unproved))].sort()) {
      const group=unproved.filter(r=>byId.get(r.id).kind_unproved===reason);
      if(!immaterialRisk)score=Math.min(score,89);
      const disputed=amounts(group).map(a=>{
        const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:a.currency}).format(moneyMinorNumber(n,a.currency));
        return [a.inflow_minor?money(a.inflow_minor)+' received':null,a.outflow_minor?money(a.outflow_minor)+' paid':null].filter(Boolean).join(' and ');
      }).join('; ');
      const why={
        unmatched_leg_candidate:'an unmatched movement candidate',possible_currency_conversion:'a possible currency conversion',
        names_another_account:'a description naming another account',counterparty_is_owned_entity:'a counterparty matching a recorded owned entity',
        counterparty_is_recorded_account_party:'a counterparty matching another recorded account',
        category_names_nonoperating_account:'a balance-sheet category that does not prove operating income or spending',
        tax_payment_type_unproved:'an unproved tax payment type',financial_counterparty_type_unproved:'an unproved lender or issuer payment type',
        tax_collected_not_income:'tax collected for government remittance, which does not prove earned operating income',
        rail_only_counterparty_unrecorded:'rail wording without an identified outside counterparty',counterparty_unrecorded:'an unrecorded counterparty',
        refund_original_not_counted:'refund wording or a category without a proved counted original and available refund capacity',
        entrusted_principal_unproved:'possible refundable deposit/bond or funds held for others',return_membership_unproved:'an unproved refund, reversal or returned posting',
        kind_not_proved:'wording without a trusted money-type certificate',prior_estimate:'an earlier unresolved money-type estimate',
      }[reason];
      gap(reason,0,`${disputed} rests on ${why}. These estimated dollars keep their current treatment in the figure. Confirm these rows.`,
        proofMissing[reason],{amounts:amounts(group),accounts:accounts(coverage.filter(c=>group.some(r=>r.tenant_id===c.tenant_id && r.account_slug===c.account_slug)))});
    }
    const wordingOnly=certificateRows.filter(r=>{const d=byId.get(r.id);return d?.money_type_wording_only || d?.kind_unproved &&
      (d.money_kind==='ordinary'&&r.direction==='inflow'&&!['card','loan','line_of_credit'].includes(r.account_kind) || d.money_kind==='refund'&&d.sales_adjust_minor>0);});
    if(wordingOnly.length)gap('money_type_wording_only',0,
      'Sale, refund, recovery or reversal membership rests on wording; buyer-versus-seller role or the counted original remains unproved. Confirm these rows.',
      'Owner-confirmed category or original invoice/payment, issuer credit memo and statement reconciliation; for recoveries, the original purchase/dispute or processor sales record proving the buyer or seller role.',
      {amounts:amounts(wordingOnly),accounts:accounts(coverage.filter(c=>wordingOnly.some(r=>r.tenant_id===c.tenant_id && r.account_slug===c.account_slug)))});
    const unsplitFees=rows.filter(r=>byId.get(r.id)?.estimate_reason==='fee_wording_with_payment_or_transfer_counted');
    if(unsplitFees.length){
      // A combined movement cannot supply a proved principal/fee allocation.
      // Retain its full provisional figure, but do not score the unsplit
      // component like an ordinary amount-only membership estimate.
      score=Math.min(score,65);
      gap('movement_fee_unsplit',0,'Combined transfer/payment principal and fee remain unsplit in the provisional figure; the fee wording does not prove the allocation.',
        'The transfer/payment confirmation and both account statements reconciling the principal/fee split.',
        {amounts:amounts(unsplitFees),rows:unsplitFees.map(r=>({account:r.account,posted_on:r.posted_on,amount_minor:r.amount_minor,currency:r.currency}))});
    }
    const interestOverlaps=rows.filter(r=>byId.get(r.id)?.interest_overlap_minor>0);
    if(interestOverlaps.length)gap('possible_interest_overlap',11,
      interestOverlaps.map(r=>`Possible interest overlap: ${new Intl.NumberFormat('en-US',{style:'currency',currency:r.currency}).format(moneyMinorNumber(byId.get(r.id).interest_overlap_minor,r.currency))} may be part of the same payment as the lender receipt; never add it again to a counted full debit.`).join(' '),
      'The lender statement and payment identity reconciling the bank debit with principal and interest receipts.',
      {rows:interestOverlaps.map(r=>({account:r.account,posted_on:r.posted_on,currency:r.currency,possible_overlap_minor:byId.get(r.id).interest_overlap_minor}))});
    const pending=coverage.filter(c=>c.pending_rows>0);
    const notCollected=coverage.filter(c=>c.pending_collection==='not_collected');
    if(pendingRequested && notCollected.length)gap('pending_not_collected',31,'Pending not collected by this feed; amount unknown.',
      'Current bank pending entries or a feed that collects pending transactions.',{accounts:accounts(notCollected)});
    const stale=coverage.filter(c=>c.pending_stale_rows>0);
    if(stale.length)gap('stale_pending',11,'Holds older than 14 days have unknown status and are reported separately from current pending.',
      'Bank confirmation that the stale holds settled or were released.',{amounts:stale.map(c=>({account:c.account,currency:c.currency,rows:c.pending_stale_rows,inflow_minor:c.pending_stale_in_minor,outflow_minor:c.pending_stale_out_minor}))});
    const possiblePosted=snapshot.pending.filter(r=>selectedRow(r) && r.amount_minor!==null &&
      (!bounded || !r.posted_on || r.posted_on<=selection.to && r.posted_on>=shiftDay(selection.from,-6)) &&
      snapshot.rows.filter(p=>p.tenant_id===r.tenant_id && p.account_slug===r.account_slug && p.amount_minor===r.amount_minor && p.direction===r.direction && p.currency===r.currency &&
        p.posted_on>=r.posted_on && Date.parse(p.posted_on)-Date.parse(r.posted_on)<=10*86400000).length===1);
    if(possiblePosted.length)caveats.push({code:'pending_likely_posted',why:'These holds may match posted entries, but the source does not prove the link. The pending amounts remain disclosed and confidence stays lower.',amounts:amounts(possiblePosted),rows:possiblePosted});
    if(pending.length)gap('pending',15,'Pending entries are excluded from posted totals and may change.',
      'Final posted entries or confirmation that the holds were withdrawn.',{accounts:accounts(pending),
        unknown_amount_rows:snapshot.pending.filter(r=>selectedRow(r) && r.amount_minor===null && (!bounded || !r.posted_on || r.posted_on>=shiftDay(selection.from,-6) && r.posted_on<=selection.to)).length,
        amounts:pending.map(c=>({account:c.account,currency:c.currency,inflow_minor:c.pending_in_minor,outflow_minor:c.pending_out_minor}))});
    const unreadable=(snapshot.unreadable||[]).filter(selectedRow),unreadableHere=unreadable.filter(r=>unreadableInPeriod(r,selection)),unreadableOutside=unreadable.filter(r=>!unreadableHere.includes(r));
    if(unreadableHere.length)gap('unreadable',30,'Some posted amounts or dates could not be read.','Readable statements or corrected source rows.',{accounts:accounts(unreadableHere),amounts:amounts(unreadableHere),rows:unreadableHere,unknown_amount_rows:unreadableHere.filter(r=>r.amount_minor===null).length});
    if(unreadableOutside.length)caveats.push({code:'unreadable_outside_period',why:'These unreadable source records have a readable calendar prefix outside the requested period.',amounts:amounts(unreadableOutside),rows:unreadableOutside});
    const unconfirmed=rows.filter(r=>r.basis_state!=='confirmed');
    if(unconfirmed.length)gap('unconfirmed',10,'Some source rows are unconfirmed.','Confirmed source amounts and directions.',{accounts:accounts(unconfirmed),amounts:amounts(unconfirmed),from:unconfirmed.map(r=>r.posted_on).sort()[0],to:unconfirmed.map(r=>r.posted_on).sort().at(-1)});
    if(bounded){
      const end=shiftDay(selection.to,5),after=snapshot.rows.filter(r=>selectedRow(r) && r.posted_on>selection.to && r.posted_on<=end);
      if(after.length)caveats.push({code:'posted_after_period',why:'These postings fall just after the requested period and are excluded from its total.',amounts:amounts(after),rows:after.map(r=>({account:r.account,posted_on:r.posted_on,amount_minor:r.amount_minor,direction:r.direction}))});
      const settled=(snapshot.settled||[]).filter(r=>selectedRow(r) && r.pending_on>=selection.from && r.pending_on<=selection.to && r.posted_on>selection.to);
      if(settled.length)caveats.push({code:'settled_after_period',why:'These pending entries settled after the requested period; only the final posting counts in its posting period.',amounts:amounts(settled),rows:settled});
      const narrow=Date.parse(selection.to)-Date.parse(selection.from)<=2*86400000;
      const authorizationAfter=after.filter(r=>/\bauthori[sz](?:ed|ation)\b/i.test(r.description||''));
      if(narrow && (settled.length || authorizationAfter.length))gap('authorization_posting_boundary',11,
        'This short-period figure uses posting dates; authorizations or linked holds in the requested interval may have posted just afterward.',
        'Confirm authorization versus posting-date basis and reconcile the listed card authorizations with their final posted dates.',{amounts:amounts([...settled,...authorizationAfter]),rows:[...settled,...authorizationAfter]});

    }
    // A loan repayment proves movement of cash, not the missing interest split.
    const loanPayments=rows.filter(r=>byId.get(r.id)?.money_kind==='loan_payment' &&
      (r.direction==='outflow' || ['loan','line_of_credit'].includes(r.account_kind)) &&
      !byId.get(r.id)?.interest_bound && !byId.get(r.id)?.interest_stated_minor && !/\bprincipal\b/i.test(r.description||''));
    if(loanPayments.length)gap('loan_interest_unseparated',25,
      'Loan repayments may include interest or escrow absent from spending; the full payment amount is shown without an invented split. '+
      amounts(loanPayments).map(a=>{const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:a.currency}).format(moneyMinorNumber(n,a.currency));
        return [a.outflow_minor?money(a.outflow_minor)+' paid':null,a.inflow_minor?money(a.inflow_minor)+' received on the lender account':null].filter(Boolean).join(' and ');}).join('; ')+
      '; $0 interest quantified; interest amount unknown. Confirm these rows.',
      'The lender statement separating principal, interest and escrow for these payments.',{accounts:accounts(loanPayments),amounts:amounts(loanPayments),rows:loanPayments.map(r=>({account:r.account,posted_on:r.posted_on,amount_minor:r.amount_minor,currency:r.currency}))});
    if(bounded) {
      const outside=r=>r.posted_on<selection.from || r.posted_on>selection.to;
      const boundary=snapshot.rows.filter(r=>{
        const d=byId.get(r.id),payment=snapshot.rows.find(p=>p.id===d?.interest_bound_payment_id);
        return payment && (selected(r)&&!outside(r) || selected(payment)&&!outside(payment)) &&
          outside(r)!==outside(payment);
      });
      if(boundary.length) {
        if(!immaterialRisk)score=Math.min(score,89);
        gap('interest_bound_outside_period',0,boundary.map(r=>{
          const d=byId.get(r.id),money=new Intl.NumberFormat('en-US',{style:'currency',currency:r.currency}).format(moneyMinorNumber(r.amount_minor,r.currency));
          return `${money} interest posted ${r.posted_on} is bound to the payment posted ${d.interest_bound_payment_on}; the dates straddle the selected period. These dollars keep their posting dates in the figure. Confirm these rows.`;
        }).join(' '),'The lender statement reconciling these interest dollars and both posting dates to the requested period.',
        {amounts:amounts(boundary),accounts:accounts(boundary),rows:boundary.map(r=>({posted_on:r.posted_on,payment_on:byId.get(r.id).interest_bound_payment_on,interest_minor:r.amount_minor,currency:r.currency}))});
      }
    }
    const repeatedInterest=rows.filter(r=>byId.get(r.id)?.money_kind==='loan_interest' && byId.get(r.id)?.interest_expense_minor>0 &&
      snapshot.rows.some(p=>p.id!==r.id && p.tenant_id===r.tenant_id && p.account_identity===r.account_identity && p.currency===r.currency &&
        p.direction!==r.direction && p.amount_minor===r.amount_minor && Math.abs(Date.parse(p.posted_on)-Date.parse(r.posted_on))<=14*86400000 &&
        (byId.get(p.id)?.interest_expense_minor>0 || p.direction==='outflow' && byId.get(p.id)?.money_kind==='ordinary' && /\binterest (?:charge|charged)\b/i.test(p.description||''))));
    if(repeatedInterest.length) {
      if(!immaterialRisk)score=Math.min(score,89);
      gap('interest_charge_receipt_overlap',0,'Interest charges and receipts may count the same interest twice. '+
        amounts(repeatedInterest).map(a=>new Intl.NumberFormat('en-US',{style:'currency',currency:a.currency}).format(moneyMinorNumber(BigInt(a.inflow_minor)+BigInt(a.outflow_minor),a.currency))+' of interest').join('; ')+'. Confirm these rows.',
        'The lender statement reconciling the separately posted interest charge and receipt.',{amounts:amounts(repeatedInterest),accounts:accounts(repeatedInterest)});
    }
    if(measure==='gross_sales')gap('gross_sales_unverified',25,'Bank deposits establish net receipts; they do not prove gross sales or withheld fees, refunds and reserves.',
      'The processor gross-sales and settlement report for the selected period.',{amounts:amounts(rows.filter(r=>r.direction==='inflow'))});
    if(measure==='reserve_balance')gap('reserve_balance_unverified',60,'Bank transactions show visible reserve movements, not the processor-held balance. Zero visible movements does not prove a zero reserve.',
      'A dated processor reserve statement including the opening balance, holds and releases.',{amounts:amounts(rows)});
    // Membership duplicate decisions (shifted feeds, same-account imports) and
    // same-day equal postings in different account records are possible copies;
    // their cost follows the dollar share, not a flat deduction. Equal postings
    // repeated inside one account stay overlap candidates at a flat review cost.
    const selectedIds=new Set(rows.map(r=>r.id));
    const overlaps=moneyOverlapGroups(snapshot.historyRows||snapshot.rows,selectedIds);
    const copyRows=[...new Map(overlaps.filter(g=>new Set(g.map(r=>r.account_slug)).size>1).flat().filter(r=>selectedIds.has(r.id))
      .concat(rows.filter(r=>byId.get(r.id)?.duplicate_minor || /duplicate_(?:feed|import)_counted/.test(byId.get(r.id)?.estimate_reason||''))).map(r=>[r.id,r])).values()];
    const copyIds=new Set(copyRows.map(r=>r.id)),repeatRows=overlaps.flat().filter(r=>selectedIds.has(r.id) && !copyIds.has(r.id));
    const duplicateRows=[...copyRows,...repeatRows];
    const duplicateShare=Math.max(0,...amounts(copyRows).flatMap(a=>['inflow','outflow'].map(direction=>{
      const total=rows.filter(r=>r.currency===a.currency && r.direction===direction).reduce((n,r)=>n+BigInt(r.amount_minor||0),0n);
      return total ? Number(10000n*BigInt(a[direction+'_minor'])/total)/10000 : 0;
    })));
    const flatCost=repeatRows.length || coverage.some(c=>c.identity_basis==='stale_link') ? 15 : 0;
    if(duplicateRows.length || coverage.some(c=>c.identity_basis==='stale_link'))gap('possible_duplicate',immaterialRisk?0:Math.max(copyRows.length?Math.max(11,Math.ceil(45*duplicateShare)):0,flatCost),
      'Some source rows may repeat postings in the same or another account record; weak matches stay counted and mirrored feed copies are left out as likely.','Current owner-approved account identity links and matching statement rows.',
      {amounts:amounts(duplicateRows),accounts:accounts(coverage.filter(c=>duplicateRows.some(r=>r.tenant_id===c.tenant_id && r.account_slug===c.account_slug)))});
    if(coverage.some(c=>c.rows_outside_account_dates>0))gap('account_dates_conflict',5,
      'Posted rows conflict with account lifecycle or declared coverage dates; their dollars remain counted.',
      'Corrected opening/closing dates and statements extending the declared coverage.',{accounts:accounts(coverage.filter(c=>c.rows_outside_account_dates>0))});
    const unreviewed=snapshot.accounts.map(applyAccountKindReview).filter(a=>a.account_kind==='other' && a.account_kind_review?.state!=='current' &&
      rows.some(r=>r.account_slug===a.account_slug && r.tenant_id===a.tenant_id));
    if(unreviewed.length)gap('account_kind_unreviewed',15,'The kind of some accounts with selected postings has not been reviewed.',
      "The owner's confirmation of what kind of account each one is.",{accounts:unreviewed.map(a=>({account:a.mask,account_slug:a.account_slug})),
        amounts:amounts(rows.filter(r=>unreviewed.some(a=>r.tenant_id===a.tenant_id && r.account_slug===a.account_slug)))});
    if(coverage.some(c=>c.last_sync===null)){
      const why='An exact completed feed sync time is unavailable; assignment observations are not sync receipts.';
      if(proved)caveats.push({code:'freshness_unavailable',why:why+' Confirmed statements cover the requested historical period.'});
      else gap('freshness_unavailable',5,why,'A completed sync receipt or complete confirmed statements through the requested period.');
    }
  }
  if(truncated)gap('truncated_output',30,'The returned row list is incomplete.','An SQL aggregate or all pages of the ordered result.');
  score=Math.max(0,score);const label=score>=90?'High':score>=70?'Medium':'Low';
  return {score,label,display:`Confidence: ${label} (${score}%)`,basis:selection?.source==='request_window'?'requested_window':selection?.from?'selected_account_dates':'whole_available_snapshot',caveats,gaps};
}
