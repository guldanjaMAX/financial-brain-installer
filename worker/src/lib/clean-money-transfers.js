import { normalizeLedgerText, cleanBankMemo, cleanPairEvidence, transferEndpoints, resolvesExactAccount,
  hasExplicitExpenseCategory, cleanFee, trustedCode, hasIndependentOutsidePayee, isOwnedMovementChannel } from './money-analysis.js';
import { platformIdentity, accountProcessor, platformCategory } from './money-platform.js';

const bank = a => ['checking','savings'].includes(a?.account_kind);
const merchant = a => ['merchant','point_of_sale'].includes(a?.account_kind);
const kinds = /^(?:(?:my|the|your) )?(checking|savings)(?: (?:account|acct))?$/;
const transferCode = row => trustedCode(row) && /^(?:transfer|internal transfer|bank transfer)(?: in| out)?(?: account transfer)?$/.test(platformCategory(row));
const outside = row => hasExplicitExpenseCategory(row) || cleanFee(row) ||
  /\b(?:customer|client|invoice|refunds?|refunded|reversals?|reversed|reimbursement|chargebacks?|disputes?|income|revenue|sales?|reward|cashback|bonus|payroll|wages)\b/.test(normalizeLedgerText(row.description)+' '+platformCategory(row));
const deposit = row => Boolean(platformIdentity(row)) ||
  /\b(?:mobile|remote|atm|cash|check|cheque|branch|counter|teller|night|lockbox|merchant|card|bankcard|direct|payroll) (?:deposit|dep)\b|\bdeposited (?:item|check)\b|\b(?:interest|dividend) (?:paid|payment|earned|credit)\b/.test(normalizeLedgerText(row.description)) ||
  trustedCode(row) && /^(?:income|wages|payroll|sales)(?: |$)/.test(platformCategory(row));

function directedMemo(row) {
  return cleanBankMemo(row.description)
    .replace(/^online transfer ref [a-z0-9]+ (to|from) /,'online transfer $1 ')
    .replace(/ on \d{2} \d{2} \d{2,4}$/,'')
    .replace(/\b(?:business market rate|business) (checking|savings) /,'$1 ')
    .replace(/\bx+(?=\d{4}\b)/g,'');
}
// Resolve a locator against the actual counterpart. Confirmation digits and
// amounts alone never identify an account, and a conflicting kind vetoes it.
export function legLocator(row, self, other, accounts, side, options = {}) {
  const memo=directedMemo(row),e=transferEndpoints(memo,options);
  // Borrowing codes must not turn an unread locator into absent evidence.
  // Unknown verbs/prefixes, dangling directions and unresolved account numbers
  // keep the debit counted until the endpoint can be reconciled. This veto is
  // deliberately broader than the closed grammar that can prove an endpoint.
  if (!e) return (options.loanAdvance
    ? /\b(?:to|from|into|account|acct|ending)\b|\d/.test(memo)
    : /\btransfer (?:to|from)\b/.test(memo))?'conflict':'none';
  const kind=(locator,account)=>kinds.exec(locator)?.[1]===account?.account_kind;
  if(e.form==='unary') {
    if(e.direction!==(side==='out'?'to':'from'))return 'conflict';
    if(resolvesExactAccount(e.locator,other,accounts))return 'exact';
    return /transfer$/.test(e.verb) && kind(e.locator,other)?'kind':'conflict';
  }
  const [mine,theirs]=side==='out'?[e.source,e.destination]:[e.destination,e.source];
  const exactMine=resolvesExactAccount(mine,self,accounts),exactTheirs=resolvesExactAccount(theirs,other,accounts);
  if(exactMine && exactTheirs)return 'exact';
  return (exactMine||kind(mine,self)) && (exactTheirs||kind(theirs,other))?'kind':'conflict';
}
const movementOnly=(row,self,other,accounts,side)=>!normalizeLedgerText(row.description) ||
  /^(?:(?:online|mobile|internet|automatic|scheduled|recurring|ach) )?(?:(?:funds|internal|account|bank|book) )?(?:transfers?|xfer|xfr|tfr|trf)(?: (?:in|out|credit|debit))?$/.test(normalizeLedgerText(row.description)) ||
  ['exact','kind'].includes(legLocator(row,self,other,accounts,side));
function outsidePayee(row,self,other,accounts,side) {
  if(!hasIndependentOutsidePayee(row,accounts))return false;
  // Some feeds repeat the directed channel and kind while omitting the mask.
  // Require that whole payee to name the actual counterpart kind.
  return !['exact','kind'].includes(legLocator({...row,description:row.payee},self,other,accounts,side));
}
function pairProof(pair,accounts) {
  const out=accounts.get(pair.out.effective_account_slug),into=accounts.get(pair.in.effective_account_slug);
  if(!out || !into || out===into || [pair.out,pair.in].some(r=>r.basis_state!=='confirmed'))return null;
  if(merchant(out) && bank(into) && pair.out.entity===pair.in.entity) {
    const P=platformIdentity(pair.in),A=accountProcessor(out),O=platformIdentity(pair.out);
    if(P && (A||O) && (!A||A===P) && (!O||O===P) && ![pair.out,pair.in].some(outside)) {
      const supported=(row,other)=>{const p=normalizeLedgerText(row.payee);return !p || p===normalizeLedgerText(row.description) ||
        isOwnedMovementChannel(p) || [P,P+' inc',P+' payments'].includes(p) ||
        [other,...(other.members||[])].some(a=>[a.label,a.institution].some(v=>normalizeLedgerText(v)===p));};
      if(supported(pair.out,into) && supported(pair.in,out) &&
          (!normalizeLedgerText(pair.out.description) || /^(?:(?:stripe|square|paypal|shopify|etsy|ebay|doordash) )?(?:payouts?|transfer|bank transfer|withdrawal)(?: |$)/.test(normalizeLedgerText(pair.out.description))))return {evidence:'processor_sweep'};
    }
  }
  if([pair.out,pair.in].some(outside) || outsidePayee(pair.out,out,into,accounts,'out') || outsidePayee(pair.in,into,out,accounts,'in'))return null;
  const existing=cleanPairEvidence(pair,accounts);
  if(existing)return {evidence:existing};
  if(!bank(out)||!bank(into)||[out,into].some(a=>a.account_kind_balance_conflict))return null;
  const o=legLocator(pair.out,out,into,accounts,'out'),i=legLocator(pair.in,into,out,accounts,'in');
  if(o==='exact' && i==='exact')return {evidence:'reciprocal_bank_locators'};
  if(o==='exact' && i==='kind'||o==='kind' && i==='exact')return {evidence:'directed_locator_with_account_kind'};
  const only=a=>[...accounts.values()].filter(b=>b.account_kind===a.account_kind).length===1;
  if(o==='kind' && i==='kind' && only(out) && only(into))return {evidence:'reciprocal_account_kind_locators',likely:'own_transfer_account_kind_locators_excluded'};
  return null;
}

export function refineTransferPairs(snapshot,rows,accounts) {
  const byId=new Map(rows.map(r=>[r.id,r])),likelyPairs=new Map(),dropped=new Set();
  const tenantPairs=snapshot.pairs.filter(p=>byId.has(p.out_id)&&byId.has(p.in_id));
  const asPair=p=>({out:byId.get(p.out_id),in:byId.get(p.in_id),proved:true});
  if(snapshot.partial)return {likelyPairs};
  const counts=(pairs,key)=>{const m=new Map();for(const p of pairs)m.set(p[key],(m.get(p[key])||0)+1);return m;};
  const exact=tenantPairs.filter(p=>!p.unique_match && byId.get(p.out_id).entity===byId.get(p.in_id).entity &&
    pairProof(asPair(p),accounts)?.evidence==='reciprocal_bank_locators');
  const exactOut=counts(exact,'out_id'),exactIn=counts(exact,'in_id');
  const resolvedOut=new Map(),resolvedIn=new Map();
  for(const p of exact)if(exactOut.get(p.out_id)===1 && exactIn.get(p.in_id)===1) {
    p.proved=1;p.evidence='reciprocal_bank_locators';
    resolvedOut.set(p.out_id,p);resolvedIn.set(p.in_id,p);
  }
  for(const p of tenantPairs)if(resolvedOut.has(p.out_id) && resolvedOut.get(p.out_id)!==p || resolvedIn.has(p.in_id) && resolvedIn.get(p.in_id)!==p)dropped.add(p);
  snapshot.pairs=snapshot.pairs.filter(p=>!dropped.has(p));
  const remaining=tenantPairs.filter(p=>!dropped.has(p));
  const outCounts=counts(remaining,'out_id'),inCounts=counts(remaining,'in_id');
  for(const p of remaining) {
    p.out_matches=outCounts.get(p.out_id);
    p.in_matches=inCounts.get(p.in_id);
    p.unique_match=Number(p.out_matches===1 && p.in_matches===1);
    const pair=asPair(p),out=accounts.get(pair.out.effective_account_slug),into=accounts.get(pair.in.effective_account_slug);
    let rejected=false;
    if(p.proved && p.evidence==='processor_sweep' && pairProof(pair,accounts)?.evidence!=='processor_sweep') {
      p.proved=0;p.evidence=null;rejected=true;
    }
    if(p.proved && ['bank_category','counterpart_memo'].includes(p.evidence)) {
      if(deposit(pair.in) && pairProof(pair,accounts)?.evidence!=='processor_sweep'){p.proved=0;p.evidence=null;rejected=true;}
      else if(p.evidence==='bank_category' && (!movementOnly(pair.out,out,into,accounts,'out') || !movementOnly(pair.in,into,out,accounts,'in')))
        for(const id of [p.out_id,p.in_id])likelyPairs.set(id,'own_transfer_bank_code_only_excluded');
    }
    if(!rejected && !p.proved && p.unique_match) {
      const proof=pairProof(pair,accounts);
      if(proof){p.proved=1;p.evidence=proof.evidence;if(proof.likely)for(const id of [p.out_id,p.in_id])likelyPairs.set(id,proof.likely);}
    }
  }
  // Repeated generic bank-coded transfers are a set, not three ambiguous
  // expenses and deposits. Only eligible transfer legs compete for this set.
  // Without specific locators the exclusion stays likely and below High.
  const groups=new Map();
  for(const p of remaining.filter(p=>!p.proved)) {
    const pair=asPair(p),out=accounts.get(pair.out.effective_account_slug),into=accounts.get(pair.in.effective_account_slug);
    if(!bank(out)||!bank(into)||pair.out.entity!==pair.in.entity||[pair.out,pair.in].some(r=>outside(r)||deposit(r)||!transferCode(r)) ||
        !movementOnly(pair.out,out,into,accounts,'out')||!movementOnly(pair.in,into,out,accounts,'in') ||
        outsidePayee(pair.out,out,into,accounts,'out')||outsidePayee(pair.in,into,out,accounts,'in'))continue;
    const key=JSON.stringify([pair.out.account_identity,pair.in.account_identity,p.currency,p.amount_minor]);
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push(p);
  }
  const setOut=new Map(),setIn=new Map();
  for(const group of groups.values()) {
    const outs=[...new Set(group.map(p=>p.out_id))].sort((a,b)=>byId.get(a).posted_on.localeCompare(byId.get(b).posted_on)||a-b);
    const ins=[...new Set(group.map(p=>p.in_id))].sort((a,b)=>byId.get(a).posted_on.localeCompare(byId.get(b).posted_on)||a-b);
    if(outs.length!==ins.length)continue;
    const pairsById=new Map(group.map(p=>[JSON.stringify([p.out_id,p.in_id]),p]));
    const selected=outs.map((id,i)=>pairsById.get(JSON.stringify([id,ins[i]])));
    if(selected.some(p=>!p))continue;
    for(const p of selected) {p.proved=1;p.evidence='bank_category';setOut.set(p.out_id,p);setIn.set(p.in_id,p);
      for(const id of [p.out_id,p.in_id])likelyPairs.set(id,'own_transfer_repeated_bank_codes_excluded');}
  }
  snapshot.pairs=snapshot.pairs.filter(p=>(!setOut.has(p.out_id)||setOut.get(p.out_id)===p)&&(!setIn.has(p.in_id)||setIn.get(p.in_id)===p));
  return {likelyPairs};
}

// Sales coverage nominates an unmatched sweep, never proves it. Use all bank
// payouts in the window so a second payout cannot reuse the same sales capacity.
export function processorSweepEstimates(rows,accounts) {
  const result=new Map(),groups=new Map();
  const merchantPlatforms=new Map([...accounts.values()].filter(merchant).map(a=>[a.account_slug,accountProcessor(a)]));
  const group=(row,P)=>{
    const key=JSON.stringify([row.tenant_id,row.entity,row.currency,P]);
    if(!groups.has(key))groups.set(key,{sales:[],payouts:[]});return groups.get(key);
  };
  for(const row of rows) {
    if(row.direction!=='inflow')continue;
    const source=accounts.get(row.effective_account_slug);
    if(merchant(source)) {
      const P=merchantPlatforms.get(source.account_slug);
      if(P && !/\b(?:transfer|payout|reserve|refund|reversal)\b/.test(normalizeLedgerText(row.description)))group(row,P).sales.push(row);
    } else if(bank(source)) {
      const P=platformIdentity(row);
      if(P && !/\b(?:refund|reversal|reversed|returned|chargeback|reserve)\b/.test(normalizeLedgerText(row.description)))group(row,P).payouts.push(row);
    }
  }
  const indexed=rows=>{
    rows.sort((a,b)=>a.posted_on.localeCompare(b.posted_on)||a.id-b.id);
    const prefix=[0n];for(const r of rows)prefix.push(prefix.at(-1)+BigInt(r.amount_minor));
    const bound=(day,upper)=>{let lo=0,hi=rows.length;while(lo<hi){const mid=(lo+hi)>>>1;
      if(rows[mid].posted_on<day || upper&&rows[mid].posted_on===day)lo=mid+1;else hi=mid;}return lo;};
    return (from,to)=>prefix[bound(to,true)]-prefix[bound(from,false)];
  };
  // Prefix sums keep a large processor feed bounded by sorting, rather than
  // rescanning every sale and deposit for each payout. Include all same-day
  // deposits; neither row order nor a competing payout can reuse sales silently.
  for(const {sales,payouts} of groups.values()) {
    if(!sales.length || !payouts.length)continue;
    const salesIn=indexed(sales),needIn=indexed(payouts);
    let prior=0n,left=0;
    for(const row of payouts) {
      const from=new Date(Date.parse(row.posted_on)-14*86400000).toISOString().slice(0,10);
      while(left<payouts.length && payouts[left].posted_on<from)prior-=BigInt(payouts[left++].amount_minor);
      const amount=salesIn(from,row.posted_on),need=needIn(from,row.posted_on);
      const available=amount>prior?amount-prior:0n,covered=available<BigInt(row.amount_minor)?available:BigInt(row.amount_minor);
      if(amount>0n)result.set(row.id,{funded:amount>=need,covered_minor:covered.toString()});
      prior+=BigInt(row.amount_minor);
    }
  }
  return result;
}
