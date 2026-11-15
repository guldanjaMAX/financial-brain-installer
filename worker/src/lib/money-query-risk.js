import { moneyOverlapGroups } from './money-query-overlap.js';
import { applyAccountKindReview } from './fin-account-kinds.js';
import { platformIdentity } from './money-platform.js';
import { normalizeLedgerText as norm } from './money-analysis.js';
import { moneyMinorNumber, moneyMinorText } from './money-format.js';

// Infer only the actual posted contribution the SQL computes. Supporting row
// counts, dates and IDs do not change that measure. Arbitrary expressions,
// mixed measures and sales/profit labels cannot borrow its evidence slice.
export function postedMoneyProjection(tokens) {
  const from=tokens.findIndex(t=>t.v==='from'),fields=[];
  if(from<0)return null;
  let depth=0,start=1;
  for(let i=1;i<=from;i++) {
    if(i===from || tokens[i].v===',' && depth===0){fields.push(tokens.slice(start,i));start=i+1;}
    else if(tokens[i].v==='(')depth++;else if(tokens[i].v===')')depth--;
  }
  let measure=null;
  for(const field of fields) {
    if(field.at(-2)?.v==='as') {
      if(/gross|sales|revenue|profit|reserve|withhold|fees?|refund|tax|balance|burn|runway|cash_flow|cash_change/.test(field.at(-1).v))return null;
      field.splice(-2);
    }
    if(field.some(t=>t.kind==='string'))return null;
    const expression=field.map(t=>t.v).join(' ');
    const sum=/^(?:sum \( (income_minor|expense_minor) \)|coalesce \( sum \( (income_minor|expense_minor) \) , 0 \))$/.exec(expression);
    if(sum) {
      const next=(sum[1]||sum[2])==='income_minor'?'net_receipts':'posted_spending';
      if(measure && measure!==next)return null;
      measure=next;
    } else if(!/^(?:currency|payee|payer_group|category|side|tenant_id|entity|account_slug|account_identity|account|substr \( posted_on , 1 , 7 \)|count \( \* \)|(?:min|max) \( posted_on \)|group_concat \( (?:distinct )?(?:txn_uid|account_slug) \)|sum \( estimated \))$/.test(expression))return null;
  }
  return measure;
}

export function inferredPostedMeasure(tokens,scope,measure) {
  if(measure!==undefined)return measure;
  const inferred=postedMoneyProjection(tokens);
  return scope?.positiveContributions?.includes(inferred==='net_receipts'?'income_minor':'expense_minor')?inferred:undefined;
}

export function requestedMoneyRanking(tokens,measure,rankLimit) {
  // The SQL itself declares the returned top N. An explicit context must
  // agree; neither form certifies an all-groups total or arbitrary ordering.
  if(rankLimit===undefined && tokens.at(-2)?.v==='limit' && tokens.at(-1)?.kind==='number')rankLimit=Number(tokens.at(-1).v);
  if(measure!=='posted_spending' || !Number.isSafeInteger(rankLimit) || rankLimit<1 || rankLimit>1000)return false;
  if(tokens.at(-2)?.v!=='limit' || tokens.at(-1)?.kind!=='number' || Number(tokens.at(-1).v)!==rankLimit)return false;
  const from=tokens.findIndex(t=>t.v==='from'),projection=tokens.slice(0,from).map(t=>t.v).join(' ');
  const sum=/\bsum \( expense_minor \) as ([a-z_][a-z_0-9]*)\b/.exec(projection);
  const order=tokens.findIndex(t=>t.v==='order');
  // A caller's top-N context proves neither a total nor an arbitrary ordering.
  // Only the matching descending grouped expense SUM earns this exception.
  const ordering=tokens.slice(order+2).map(t=>t.v).join(' ');
  return Boolean(sum && tokens.some(t=>t.v==='group') && order>from && tokens[order+1]?.v==='by' &&
    (tokens[order+2]?.v===sum[1] && tokens[order+3]?.v==='desc' || /^sum \( expense_minor \) desc\b/.test(ordering)));
}

// Explicit measures describe the owner's question, never certify a row. Keep
// uncertain exclusions in the candidate population: filtering to positive
// contributions alone would let a mistaken classification prove itself.
export function questionMoneyEvidence(snapshot,decisions,scope,measure,tokens=[]) {
  if(!snapshot || !scope || !['net_receipts','posted_spending'].includes(measure))return {snapshot,decisions};
  const projection=tokens.slice(0,tokens.findIndex(t=>t.v==='from')).map(t=>t.v);
  if(!scope.recurring && postedMoneyProjection(tokens)!==measure)return {snapshot,decisions};
  const income=measure==='net_receipts',field=income?'income_minor':'expense_minor';
  if(!scope.positiveContributions?.includes(field))return {snapshot,decisions};
  const byId=new Map(decisions.map(d=>[d.id,d]));
  const taxPopulation=tokens.some(t=>t.kind==='string' && /\btax(?:es)?\b/.test(norm(t.v))) || projection.some(v=>/tax/.test(v));
  const readings=decisions.map(d=>!income && !taxPopulation && d.kind_unproved==='tax_payment_type_unproved'
    // A posted spending total needs the paid cash, not the government's tax
    // attribution. Keep this narrow receipt for the final source-risk recheck;
    // it cannot resolve another risk or certify a selected tax population.
    ? {...d,estimated:0,estimate_reason:null,kind_unproved:null,kind_proof:'face_value',posted_tax_type_only:true}:d);
  const category=scope.rowFilters?.category?.value;
  const rows=snapshot.rows.filter(r=>{
    const d=byId.get(r.id);
    if(income ? r.direction!=='inflow' && !d?.income_adjust_minor : r.direction!=='outflow')return false;
    if(category && r.category!==category && norm(r.category)!==norm(category) && r.category_basis_state==='confirmed' && r.category)return false;
    return d?.money_kind==='ordinary' && (!income || !['card','loan','line_of_credit'].includes(r.account_kind)) ||
      income && d?.income_adjust_minor || d?.estimated || d?.kind_unproved;
  });
  return {decisions:readings,snapshot:{...snapshot,historyRows:snapshot.rows,rows,pending:[],
    coverage:snapshot.coverage.map(c=>({...c,pending_rows:0,pending_in_minor:0,pending_out_minor:0}))}};
}

// A query can ask more than its contributing rows establish. These checks
// qualify the returned figure; they never rewrite arithmetic or block a read.
export function queryMeasureRisks({tokens=[],rows=[],decisions=[],scope,measure,accounts=[],readFrom=null,contextRows=[]}) {
  const groupStart=tokens.findIndex(t=>t.v==='group');
  const grouping=groupStart<0?'':tokens.slice(groupStart+2).map(t=>t.v).join(' ').split(/ order | limit | having /)[0];
  const words=tokens.map(t=>t.v).join(' '), projection=tokens.slice(0,tokens.findIndex(t=>t.v==='from')).map(t=>t.v).join(' ');
  const byId=new Map(decisions.map(d=>[d.id,d]));
  const contextSides=new Map(contextRows.map(r=>[JSON.stringify([r.tenant_id,r.account_slug]),r.side]));
  const settlementDescriptor=r=>/\b(?:marketplace|mktpl|seller|merchant)\b.{0,45}\b(?:payout|settlement|disbursement|payment|pmt)\b/.test(norm(r.description));
  const payouts=rows.filter(r=>r.direction==='inflow' && (platformIdentity(r) || settlementDescriptor(r)) && byId.get(r.id)?.money_kind==='ordinary');
  const gaps=[];const add=(code,why,missing)=>gaps.push({code,why,missing});
  if(scope?.recurring) {
    const months=new Map(),category=scope.rowFilters?.category?.value;
    for(const r of rows)if(r.direction==='outflow' && byId.get(r.id)?.money_kind==='ordinary' &&
      (!category || !r.category || r.category_basis_state!=='confirmed' || norm(r.category)===norm(category)) &&
      typeof r.posted_on==='string' && Number.isSafeInteger(r.amount_minor) && r.amount_minor>=0) {
      const month=r.posted_on.slice(0,7),key=JSON.stringify([r.payee,r.currency,month]),g=months.get(key)||{month,currency:r.currency,rows:0,minor:0n};
      g.rows++;g.minor+=BigInt(r.amount_minor);months.set(key,g);
    }
    const repeated=[...months.values()].filter(g=>g.rows>1);
    if(repeated.length)add('recurring_monthly_population_unproved',repeated.map(g=>`${g.month}: ${g.rows} charges total ${g.currency} ${moneyMinorText(g.minor,g.currency)}.`).join(' ')+' A per-charge minimum does not establish the monthly bill.',
      'Sum the separate charges per vendor and currency in each month, then establish the fixed monthly total.');
  }
  if((scope?.filters?.side || scope?.filters?.entity || /\bside\b/.test(projection)) && contextRows.some(r=>r.side==='unassigned' ||
      r.side==='business' && byId.get(r.id)?.money_kind==='owner_money' && r.direction==='outflow' &&
        (scope?.filters?.side==='personal' || /\bside\b/.test(projection)) && /\b(?:expense_minor|spending_minor)\b/.test(projection) ||
      r.direction==='outflow' && byId.get(r.id)?.payment_kind && contextSides.has(JSON.stringify([r.tenant_id,byId.get(r.id).paid_to_account_slug])) && contextSides.get(JSON.stringify([r.tenant_id,byId.get(r.id).paid_to_account_slug]))!==r.side ||
      r.side==='personal' && (/\bbusiness (?:income|expense)\b/.test(norm(r.category)) || platformIdentity(r)) ||
      r.side==='business' && r.direction==='inflow' && /\b(?:salary|wages|paycheck|outside employer|pension|retirement|unemployment|social security|soc sec)\b/.test(norm([r.category,r.description,r.payee].join(' ')))))add('entity_attribution_unproved',
    'Account ownership does not settle the business/personal allocation of unassigned accounts, outside wages, cross-side repayments or business-labelled postings in personal accounts.',
    'Owner-confirmed activity allocation for the listed period, including the unassigned and mixed-use accounts.');
  if(/\b(?:money_kind|cross_side_minor)\b/.test(projection) && /owner_money|cross_side_minor/.test(projection) && rows.some(r=>byId.get(r.id)?.cross_side_minor>0))add('owner_draw_measure_unproved',
    'Owner-money labels and cash crossing sides are different populations; a draw total may omit one of them.',
    'Reconcile the owner equity ledger with classified owner money and both legs of cash crossing the business/personal boundary.');

  if(/\baccount_kind\b/.test(words) && rows.some(r=>accounts.some(a=>a.tenant_id===r.tenant_id && a.account_slug===r.account_slug && applyAccountKindReview(a).account_kind!==r.account_kind)))add('reviewed_kind_projection',
    'The public account kind differs from the current owner review; a kind-based selection may omit the reviewed account.', 'Use the reviewed account identity and reconcile its current kind before attributing this figure.');
  if(/\bpaid_minor\b/.test(projection) && rows.some(r=>['card','loan','line_of_credit'].includes(r.account_kind) && r.direction==='inflow' && byId.get(r.id)?.paid_minor>0 && byId.get(r.id)?.paid_basis==='credit_only' && readFrom && Date.parse(r.posted_on)-Date.parse(readFrom)<=10*86400000))add('receiving_payment_date_unproved',
    'A receiving-only liability payment does not prove the paying date; the paying debit may lie outside this period.', 'Read the paying account and reconcile the unique debit with this liability credit using its actual posting date.');
  if(/\bincome_minor\b/.test(projection) && !/\bsales_adjust_minor\b/.test(projection) && rows.some(r=>byId.get(r.id)?.sales_adjust_minor))add('gross_income_before_returns',
    'This income figure is before recorded customer refunds or chargebacks; it does not establish net sales.', 'Include the signed sales adjustments for net income and reconcile them to the original customer receipts.');

  const operatingNet=/\bincome_minor\b/.test(projection) && /\bexpense_minor\b/.test(projection);
  const feeOrSpend=!operatingNet && scope?.detailFilter!=='interest' && /\b(?:expense_minor|spending_minor|fees?\w*)\b/.test(words) || scope?.detailFilter==='fee';
  const items=[];let depth=0,start=1;
  const projectionTokens=tokens.slice(0,tokens.findIndex(t=>t.v==='from'));
  for(let i=1;i<=projectionTokens.length;i++){
    if(i===projectionTokens.length || projectionTokens[i].v===',' && depth===0){items.push(projectionTokens.slice(start,i).map(t=>t.v).join(' '));start=i+1;}
    else if(projectionTokens[i].v==='(')depth++;else if(projectionTokens[i].v===')')depth--;
  }
  const sales=items.some(item=>/\b(?:income_minor|sales\w*)\b/.test(item) && !/\bexpense_minor\b/.test(item));
  const returnMeasure=/\b(?:refund_minor|sales_adjust_minor|refunds?|chargebacks?)\b/.test(words);
  if(payouts.length && measure!=='net_receipts' && measure!=='posted_spending' && (feeOrSpend || sales || returnMeasure && !operatingNet || /\bpaid_minor\b/.test(words)))add('processor_components_unrecorded',
    payouts.map(r=>`${r.currency} ${new Intl.NumberFormat('en-US',{style:'currency',currency:r.currency}).format(moneyMinorNumber(r.amount_minor,r.currency))} received on ${r.posted_on}`).join('; ')+': processor payouts are net settlements, not individual gross sales, refunds, fees or loan-principal receipts. Withheld components have no separate bank row; an apparent zero or total may omit them. Confirm these rows.',
    'The processor settlement and financing statements showing gross sales, taxes, tips, fees, refunds, reserves and withheld principal, reconciled to the bank payouts.');
  const partyKey=value=>norm(value).replace(/(?: (?:llc|inc|corp|corporation|ltd|limited|co))+$/g,'');
  const rawPartyGrouping=/\b(?:payee|description)\b/.test(grouping) || /\bcase when\b/.test(projection) || /\bcount \( distinct payee\b/.test(projection);
  const partyKeys=new Map(),rawPartyKeys=new Map();let partyAliases=false;
  for(const r of rows)if(r.payee){const key=JSON.stringify([r.tenant_id,r.currency,partyKey(r.payee)]),name=norm(r.payee);
    if(partyKeys.has(key) && partyKeys.get(key)!==name)partyAliases=true;else partyKeys.set(key,name);
    if(rawPartyGrouping && rawPartyKeys.has(key) && rawPartyKeys.get(key)!==r.payee)partyAliases=true;
    else rawPartyKeys.set(key,r.payee);
  }
  if(/\b(?:payer_group|payee|description)\b/.test(words) && (/\b(?:payer_group|payee|description)\b/.test(grouping) || /\bcase when\b/.test(projection) || /\bcount \( distinct (?:payer_group|payee)\b/.test(projection)) &&
      (partyAliases || rows.some(r=>!(measure==='net_receipts' && (platformIdentity(r) || settlementDescriptor(r) ||
        byId.get(r.id)?.kind_proof==='code' && /\binterest\b/.test(norm(r.category)) && /\bincome\b/.test(norm(r.category)))) && (!r.payee || /\b(?:zelle|paypal|bill com|intuit|deposit|stripe|square|shopify|etsy|ebay|doordash)\b/.test(norm(r.payee)) || /\s{2,}|[^\x20-\x7e]/.test(r.payee) || /\d/.test(r.payee)))))add('party_attribution_unproved',
    'Payer or vendor grouping may split one party or merge several parties; rail names, unidentified deposits, references and unbound returns do not prove customer identity.',
    'Owner-confirmed party identities and invoice/payment records linking each receipt and return, including unidentified deposits and processor settlements.');
  const categoryKeys=new Map();let categoryAliases=false;
  for(const r of rows)if(r.category){const key=norm(r.category);if(categoryKeys.has(key) && categoryKeys.get(key)!==r.category)categoryAliases=true;else categoryKeys.set(key,r.category);}
  if(categoryAliases && /\bcategory\b/.test(grouping))add('category_aliases_unproved','Case or spacing variants split one apparent category into different SQL groups.','Reconcile the category labels and combine confirmed aliases before ranking categories.');
  if(/\b(?:max|min|avg) \(/.test(projection) && rows.some(r=>/\b(?:pmt|payment|part|instalment|installment) \d+ of \d+\b/i.test(r.description||'')))add('invoice_population_unproved',
    'Installment postings do not establish the largest invoice or average whole expense.', 'The original invoices and payment allocation grouping their installments.');
  if(/\bcategory\b/.test(grouping) && rows.some(r=>!r.category || r.category_basis_state!=='confirmed'))add('category_attribution_unproved',
    'Uncategorized or unconfirmed categories can change the category ranking and its totals.', 'Owner confirmation of the category for each selected posting.');
  if(/\b(?:avg|min|max|count)\s*\(/.test(projection) && !/\b(?:income_minor|expense_minor) > 0\b/.test(words) &&
      (payouts.length || rows.some(r=>byId.get(r.id)?.money_kind!=='ordinary')))add('aggregate_population_unproved',
    'This count, average or extremum includes batches or zero-contribution movements; it does not establish individual sales or purchase statistics.',
    'Define the population using positive contributions and individual sales/purchase records; compute a monthly average from complete monthly totals.');
  if(rows.some(r=>byId.get(r.id)?.money_kind==='owner_money' ||
      byId.get(r.id)?.money_kind==='own_transfer' && Object.keys(scope?.filters || {}).some(k=>['account_slug','account_identity','account','side','entity'].includes(k)) && !rows.some(p=>p.id!==r.id && p.amount_minor===r.amount_minor && p.currency===r.currency && p.direction!==r.direction && byId.get(p.id)?.money_kind==='own_transfer') || byId.get(r.id)?.cross_side_minor>0 || ['investment','retirement','merchant','point_of_sale'].includes(r.account_kind) && byId.get(r.id)?.money_kind==='own_transfer') &&
      (/\b(?:month|burn|runway|cash_flow|cash_change)\b/.test(projection) || /\bamount_minor\b/.test(projection) && /\bown_transfer\b/.test(words) || Object.keys(scope?.filters || {}).some(k=>['account_slug','account_identity','account'].includes(k))) && !/\b(?:cross_side_minor|owner_money_minor)\b/.test(projection))add('cash_boundary_unproved',
    'Income minus spending is an operating cash subtotal; owner withdrawals and movements crossing the selected cash-account boundary can change burn, runway and available cash.',
    'Reconcile owner money and both legs of transfers against the requested cash-account boundary before using this subtotal for cash flow or runway.');
  if(/\binterest_stated_minor\b/.test(words) && rows.some(r=>r.direction==='outflow' && /\binterest\b/.test(norm(r.description)) && !byId.get(r.id)?.interest_stated_minor))add('interest_measure_unproved',
    'A separately posted interest charge is counted in spending but absent from stated lender-receipt interest; the stated-interest figure may omit it.',
    'Reconcile lender interest charges and receipts to the payment, counting interest once.');
  return gaps;
}

// Only a single-currency, monetary SUM can supply the materiality denominator.
// Counts, averages, mixed currencies, zeroes and unknown impacts fail closed.
export function moneyRiskMateriality({tokens=[],result=[],rows=[],decisions=[],contextRows=rows}) {
  const projection=tokens.slice(0,tokens.findIndex(t=>t.v==='from'));
  if(!projection.some(t=>t.v==='sum') || projection.some(t=>['avg','count','min','max','amount','*','/'].includes(t.v) || t.kind==='number' && t.v!=='0'))return false;
  const currencies=new Set(rows.map(r=>r.currency));if(currencies.size!==1)return false;
  const currency=[...currencies][0];if(currency!=='USD')return false;
  const byId=new Map(decisions.map(d=>[d.id,d]));
  const ids=new Set(moneyOverlapGroups(rows).flatMap(group=>group.slice(1).map(r=>r.id)));
  const risky=rows.filter(r=>ids.has(r.id) || byId.get(r.id)?.estimated || byId.get(r.id)?.kind_unproved);
  if(!risky.length)return false;
  // Materiality covers unresolved dollars, not a headline contradicted by
  // return evidence. A small credit from a prior supplier can be a refund;
  // its size cannot certify that the credit is new customer income.
  const party=v=>norm(v).replace(/(?: (?:llc|inc|corp|corporation|ltd|co))+$/g,'');
  const priorPayments=new Map(),partyKey=r=>JSON.stringify([r.tenant_id,r.currency,party(r.payee)]);
  for(const p of contextRows)if(p.direction==='outflow' && party(p.payee)) {
    const key=partyKey(p),first=priorPayments.get(key);
    if(!first || p.posted_on<first)priorPayments.set(key,p.posted_on);
  }
  if(risky.some(r=>/return|refund/.test(byId.get(r.id)?.kind_unproved||'') ||
    r.direction==='inflow' && party(r.payee) && priorPayments.get(partyKey(r))<=r.posted_on))return false;
  const impact=risky.reduce((n,r)=>n+BigInt(r.amount_minor),0n);
  const figures=result.flatMap(r=>Object.entries(r).filter(([k,v])=>k!=='currency' && typeof v==='number').map(([,v])=>v));
  return figures.length>0 && figures.every(n=>Number.isSafeInteger(n) && Math.abs(n)>0 && impact*50n<BigInt(Math.abs(n))) &&
    moneyMinorNumber(Number(impact),currency)<100;
}

// Optional structured records qualify a successful amount. Failed reads leave
// that amount intact and explicitly name the missing check.
export async function queryContextRisks({read,rows=[],coverage=[],period,tokens=[]}) {
  if(!period || !coverage.length)return [];
  const gaps=[],slugs=[...new Set(coverage.map(c=>c.account_slug))],tenants=[...new Set(coverage.map(c=>c.tenant_id))];
  const bindList=a=>a.map(()=>'?').join(',');
  const within=`tenant_id IN (${bindList(tenants)}) AND (account_slug IS NULL OR account_slug IN (${bindList(slugs)})) AND (period_start IS NULL OR period_start<=?) AND (period_end IS NULL OR period_end>=?)`;
  const conflicts=await read(`SELECT account_slug,currency,measure,delta_minor FROM fin_reconciliations WHERE state='mismatched' AND ${within} LIMIT 1001`,[...tenants,...slugs,period.to,period.from]);
  if(conflicts.length)gaps.push({code:'recorded_reconciliation_conflict',why:conflicts.slice(0,1000).map(c=>`Account ${coverage.find(a=>a.account_slug===c.account_slug)?.account || '(unassigned)'} has a recorded ${c.measure.replaceAll('_',' ')} disagreement of ${c.currency} ${moneyMinorNumber(Math.abs(c.delta_minor),c.currency)} in the requested period.`).join(' '),missing:'Reconcile the source statement, complete line count and recorded ledger for the listed accounts and dates.'});
  const payouts=rows.filter(r=>r.direction==='inflow' && platformIdentity(r));
  if(payouts.length){
    const debts=await read(`SELECT tenant_id,entity_slug,counterparty,label,currency,start_on,end_on FROM fin_obligations WHERE kind='loan' AND superseded_by_id IS NULL AND tenant_id IN (${bindList(tenants)}) LIMIT 1001`,tenants);
    if(debts.length>1000)gaps.push({code:'financing_context_bounded',why:'The processor financing context exceeds the bounded read; withholding impact is unknown.',missing:'A complete scoped processor financing inventory.'});
    if(debts.some(d=>(!d.start_on || d.start_on<=period.to) && (!d.end_on || d.end_on>=period.from) && payouts.some(r=>r.tenant_id===d.tenant_id && r.entity===d.entity_slug && r.currency===d.currency && [d.counterparty,d.label].some(v=>norm(v).includes(platformIdentity(r))))))gaps.push({code:'processor_financing_withheld',why:'A recorded processor loan can be repaid inside net payouts; missing withholding rows can change sales, loan repayments and operating profit.',missing:'The processor financing and settlement statements separating withheld principal, interest, fees and gross receipts.'});
  }
  const preferences=await read(`SELECT value_json FROM owner_preferences WHERE preference_key='fiscal_year_start_month' AND tenant_id IN (${bindList(tenants)}) LIMIT 1001`,tenants);
  if(preferences.some(p=>{try{return Number(JSON.parse(p.value_json))!==1;}catch{return true;}}) && period.from.slice(5)==='01-01')gaps.push({code:'fiscal_period_unproved',why:'The recorded fiscal-year start differs from the calendar-year selection; this figure follows the SQL dates.',missing:'Confirm fiscal versus calendar-year dates and read the corresponding complete period.'});
  return gaps;
}
