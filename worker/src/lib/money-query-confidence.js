import { moneyMinorNumber, moneyMinorText } from './money-format.js';
import { moneyOverlapGroups, moneyOverlapMinor } from './money-query-overlap.js';
import { pendingInScope, pendingTotals, stalePending } from './money-pending.js';
import { historyHoles } from './money-history.js';

// A deterministic evidence rubric, never a probability or a completeness proof.
const key = r => JSON.stringify([r.tenant_id, r.account_slug]);
const isoDate = value => typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;
const inPeriod = (r, period) => !period || !isoDate(r.posted_on) || r.posted_on >= period.from && r.posted_on <= period.to;
const days = (from,to) => Math.max(0,Math.round((Date.parse(to)-Date.parse(from))/86400000)+1);
const nextDay = (date,offset) => new Date(Date.parse(date)+offset*86400000).toISOString().slice(0,10);
const scoped = (rows, period, slugs) => (rows ?? []).filter(r => (!slugs || slugs.includes(r.account_slug)) && inPeriod(r, period));
const dollars = (minor, currency) => new Intl.NumberFormat('en-US', { style:'currency', currency: /^[A-Z]{3}$/.test(currency ?? '') ? currency : 'USD' }).format(moneyMinorNumber(minor, currency));
const dates = rows => rows.map(r => r.posted_on).filter(Boolean).sort();
const sumDirection = (rows, direction) => rows.filter(r => r.direction === direction).reduce((s,r) => s + (r.amount_minor ?? 0), 0);
const band = percent => percent >= 90 ? 'High' : percent >= 70 ? 'Medium' : 'Low';

export function readsRepaymentMeasure(tokens) {
  const columns=new Set(['paid_minor','credited_minor','debt_moved_minor','paid_to_account_slug','paid_to_account','paid_basis','payment_kind']);
  return tokens.some((t,i)=>columns.has(t.v) || t.v==='*' && ['select','distinct',',','.'].includes(tokens[i-1]?.v) || t.kind==='string' && ['card_payment','loan_payment'].includes(t.v));
}

export function repaymentUncertainty({snapshot,decisions,period,accountSlugs,selection,readsPaid}) {
  const readings=new Map(decisions.map(d=>[d.id,d])),byId=new Map(snapshot.rows.map(r=>[r.id,r]));
  const inScope=r=>Boolean(r) && (!accountSlugs || accountSlugs.includes(r.account_slug)) &&
    ['account_slug','account','account_identity','tenant_id','side','currency','entity','direction'].every(k=>!selection?.[k] || r[k]===selection[k]);
  const rows=scoped(snapshot.rows,period,accountSlugs).filter(inScope), groups=new Map();
  for (const r of rows) {
    const d=readings.get(r.id);
    const outside=readsPaid && d?.pay_row_id && !inScope(byId.get(d.pay_row_id));
    const code=outside?'repayment_paid_outside_scope':d?.paid_basis?.startsWith('likely_')?'repayment_unproved':null;
    if (!code) continue;
    const k=JSON.stringify([code,d.paid_basis,r.currency]);
    const group=groups.get(k) || {code,basis:d.paid_basis,currency:r.currency,rows:[]};
    group.rows.push(r);groups.set(k,group);
  }
  return [...groups.values()].map(g=>{
    const from=dates(g.rows)[0],to=dates(g.rows).at(-1),accounts=[...new Set(g.rows.map(r=>r.account))].sort();
    const amounts=[{currency:g.currency,inflow_minor:sumDirection(g.rows,'inflow'),outflow_minor:sumDirection(g.rows,'outflow')}];
    const impact=amounts[0].inflow_minor || amounts[0].outflow_minor;
    const paying=[...new Set(g.rows.map(r=>byId.get(readings.get(r.id).pay_row_id)?.account).filter(Boolean))].sort();
    const why=g.code==='repayment_paid_outside_scope'
      ? `${dollars(impact,g.currency)} credited to Account ${accounts.join(', ')} was paid from Account ${paying.join(', ')}, outside the named accounts; paid_minor counts it on the paying account.`
      : `${g.rows.length} repayment rows on Account ${accounts.join(', ')}, ${from} through ${to}, are matched by equal amount and nearby dates only (${g.basis}); the likely repayment total could be ${g.basis.startsWith('likely_paid_possible_')?'lower':'higher'} by ${dollars(impact,g.currency)}.`;
    return {code:g.code,why,missing:g.code==='repayment_paid_outside_scope'
      ? 'Include the paying account and filter paid_to_account or paid_to_account_slug for repayments sent; read credited_minor for credits received on the card or loan alone.'
      : 'The bank line and card or loan statement line for each payment, or a bank transfer code linking them.',
      amounts,rows:g.rows.length,from,to,accounts};
  });
}

export function moneyQueryEvidence({ snapshot, decisions = [], period = null, accountSlugs, asOf } = {}) {
  const evidence = { as_of: asOf, period, accounts: [] };
  if (!snapshot) return evidence;
  const membership = new Map(decisions.map(d => [d.id,d]));
  const rows = scoped(snapshot.rows, period, accountSlugs);
  const pending = pendingInScope(snapshot.pending, period, accountSlugs);
  const excluded = scoped(snapshot.excluded, period, accountSlugs);
  const conflicts=scoped(snapshot.conflicts,period,accountSlugs);
  const duplicateDollars = new Map();
  // Membership duplicate decisions price each extra copy once. Same-day and
  // shifted same-mask overlaps without such a decision stay review candidates:
  // a copy in another account record is priced by its dollar share, while
  // equal postings repeated inside one account keep a flat review cost.
  const repeatDollars = new Map(), addTo = (map,r,minor) => map.set(key(r),(map.get(key(r)) ?? 0)+minor);
  for(const r of rows)if(membership.get(r.id)?.duplicate_minor)addTo(duplicateDollars,r,membership.get(r.id).duplicate_minor);
  const selectedIds=new Set(rows.map(r=>r.id));
  for (const group of moneyOverlapGroups(snapshot.historyRows||snapshot.rows,selectedIds)) {
    const affected=group.filter(r=>selectedIds.has(r.id));
    if(affected.some(r=>membership.get(r.id)?.duplicate_minor))continue;
    const slugs=[...new Set(group.map(r=>r.account_slug))].sort();
    let remaining=moneyOverlapMinor(group,selectedIds);
    for (const r of affected) {
      const minor=Number(remaining<BigInt(r.amount_minor)?remaining:BigInt(r.amount_minor));
      addTo(duplicateDollars,r,minor);
      if(slugs.length===1)addTo(repeatDollars,r,minor);
      remaining-=BigInt(minor);
    }
  }
  for (const c of (snapshot.coverage ?? []).filter(c => !accountSlugs || accountSlugs.includes(c.account_slug))) {
    const belongs = r => key(r) === key(c);
    const own = rows.filter(belongs), waiting = pending.filter(belongs), omitted = excluded.filter(belongs),
      stale=stalePending(waiting,asOf?.date),active=waiting.filter(r=>!stale.includes(r)),holes=historyHoles(snapshot.historyRows || snapshot.rows,c,period);
    const uncertain = own.filter(r => !membership.has(r.id) || membership.get(r.id).classification === 'unknown' || membership.get(r.id).estimated === 1);
    const observed = dates(own);
    const verified = c.coverage_verified === 1;
    const account = snapshot.accounts?.find(belongs) ?? {};
    const openInPeriod = !period || !(isoDate(account.closed_on) && account.closed_on<period.from || isoDate(account.opened_on) && account.opened_on>period.to);
    const expectedFrom = period && isoDate(account.opened_on) && account.opened_on>period.from ? account.opened_on : period?.from;
    const expectedTo = period && isoDate(account.closed_on) && account.closed_on<period.to ? account.closed_on : period?.to;
    const periodDays = period ? days(expectedFrom,expectedTo) : null;
    const verifiedDays = period && verified ? Math.max(0,days(c.covered_from>expectedFrom ? c.covered_from : expectedFrom,c.covered_to<expectedTo ? c.covered_to : expectedTo)-holes.reduce((n,h)=>n+h.days,0)) : 0;
    const unverified = [];
    if (period && openInPeriod) {
      if (!verifiedDays) unverified.push({from:expectedFrom,to:expectedTo});
      else {
        if (c.covered_from>expectedFrom) unverified.push({from:expectedFrom,to:nextDay(c.covered_from,-1)});
        if (c.covered_to<expectedTo) unverified.push({from:nextDay(c.covered_to,1),to:expectedTo});
      }
    }
    unverified.push(...holes);
    let from = verified ? c.covered_from : observed[0] ?? null;
    let through = verified ? c.covered_to : observed.at(-1) ?? null;
    if (period && from && through) { from = from > period.from ? from : period.from; through = through < period.to ? through : period.to; }
    if (!from || !through || from > through) from = through = null;
    const exclusions = new Map();
    for (const r of [...omitted,...conflicts.filter(belongs).map(r=>({...r,reason:'counted_'+r.reason}))]) {
      const k = JSON.stringify([r.reason,r.currency]);
      const e = exclusions.get(k) ?? { reason:r.reason,currency:r.currency,rows:0,inflow_minor:0,outflow_minor:0,first_row:r.posted_on,last_row:r.posted_on };
      e.rows += r.row_count; e[r.direction+'_minor'] += r.amount_minor ?? 0;
      if (r.posted_on < e.first_row) e.first_row = r.posted_on;
      if (r.posted_on > e.last_row) e.last_row = r.posted_on;
      exclusions.set(k,e);
    }
    evidence.accounts.push({ tenant_id:c.tenant_id,account_slug:c.account_slug,last4:c.account ?? null,label:c.account_label,
      bank:account.institution ?? null, side:c.side,currency:c.currency,
      open_in_period:openInPeriod,status:account.status,opened_on:account.opened_on ?? null,closed_on:account.closed_on ?? null,
      period_days:periodDays,verified_days:verifiedDays,observed_through:observed.at(-1) ?? null,unverified_dates:unverified,
      coverage_verified:verified,stated_from:from,stated_through:through,rows_in_period:own.length,
      period_verified:Boolean(verified && (!period || openInPeriod && verifiedDays===periodDays)),
      uncertain:{inflow_minor:sumDirection(uncertain,'inflow'),outflow_minor:sumDirection(uncertain,'outflow'),first_row:dates(uncertain)[0]??null,last_row:dates(uncertain).at(-1)??null},
      pending:{...pendingTotals(active),...(c.feed_kind==='simplefin' && !active.length?{rows:null,inflow_minor:null,outflow_minor:null}:{}),
        collection:c.feed_kind==='simplefin'?'not_collected':'recorded',amount_known:c.feed_kind!=='simplefin',stale:pendingTotals(stale)},
      excluded:[...exclusions.values()].filter(e=>!e.reason.startsWith('counted_')),
      lifecycle_conflicts:[...exclusions.values()].filter(e=>e.reason.startsWith('counted_')).map(e=>({...e,reason:e.reason.slice(8)})),possible_duplicate_minor:duplicateDollars.get(key(c)) ?? 0,same_account_repeat_minor:repeatDollars.get(key(c)) ?? 0,
      identity_basis:c.identity_basis,history_holes:holes,
      unreadable_rows:scoped(snapshot.quality,period,accountSlugs).filter(belongs).reduce((n,r)=>n+r.unreadable_rows,0),
      unreadable:scoped(snapshot.quality,period,accountSlugs).filter(belongs),
      unconfirmed_rows:own.filter(r=>r.basis_state!=='confirmed').length,
    });
  }
  return evidence;
}

function accountName(a, multipleTenants, all = []) {
  const collision = a.last4 && all.filter(b => b.last4 === a.last4).length > 1;
  return `${multipleTenants ? a.tenant_id+' ' : ''}Account ${a.last4 ?? 'last 4 not recorded'}${!a.last4 || collision ? ' ('+[a.label,a.bank].filter(Boolean).join(', ')+')' : ''}`;
}

function possibleMovement(rows, pairs) {
  const proved = new Set((pairs ?? []).filter(p=>p.proved===1 || p.proved===true).flatMap(p=>[p.out_id,p.in_id]));
  const amounts = new Map();
  for (const r of rows) {
    if (proved.has(r.id)) continue;
    const k = JSON.stringify([r.tenant_id,r.currency,r.amount_minor]);
    const days = amounts.get(k) ?? new Map();
    const identities = days.get(r.posted_on) ?? new Map();
    identities.set(JSON.stringify([r.direction,r.account_identity]),r); days.set(r.posted_on,identities); amounts.set(k,days);
  }
  for (const days of amounts.values()) for (const [day, identities] of days) for (let offset=-3;offset<=3;offset++) {
    const peers = days.get(new Date(Date.parse(day)+offset*86400000).toISOString().slice(0,10));
    if (peers && [...identities.values()].some(r=>[...peers.values()].some(p=>p.direction!==r.direction && p.account_identity!==r.account_identity))) return true;
  }
  return false;
}

// Evaluate each referenced evidence family, then retain the lowest score. A
// clean ledger cannot certify an old balance or an unassessed obligations list.
export function moneyQueryConfidence({ snapshot, decisions = [], raw = false, truncated = false, period = null, accountSlugs, evidence, balances, balanceScope, asOf, balanceAsOf = asOf?.date, references = [], cleanCheckTooLarge = false, pendingRequested=false, immaterialRisk=false } = {}) {
  const reasons = [], missing = [];
  let percent;
  const add = (why, gap) => { reasons.push(why); missing.push(gap); };
  if (!snapshot) {
    percent = balances ? 95 : raw ? 55 : 50;
    if (!balances && !raw) add('These are recorded figures; whether the records are complete and current was not assessed.','Account/date coverage and source evidence for the figure being answered.');
  } else {
    percent = 95;
    add('The complete expected-account inventory is not independently verified.','Owner-confirmed expected accounts and verified statement coverage for the requested dates.');
    evidence ??= moneyQueryEvidence({snapshot,decisions,period,accountSlugs,asOf});
    const allAccounts = evidence.accounts;
    const accounts = allAccounts.filter(a=>a.open_in_period!==false);
    const longDate = date => new Intl.DateTimeFormat('en-US',{timeZone:'UTC',year:'numeric',month:'long',day:'numeric'}).format(new Date(date));
    for (const a of allAccounts.filter(a=>a.open_in_period===false)) {
      const lifecycle = period && isoDate(a.closed_on) && a.closed_on<period.from ? 'closed '+longDate(a.closed_on) : 'opens '+longDate(a.opened_on);
      add(`${accountName(a,false,allAccounts)}: ${lifecycle}; $0 expected.`,'Lifecycle dates supported by the recorded account history.');
    }
    const multipleTenants = new Set(accounts.map(a=>a.tenant_id)).size>1;
    const name = a => accountName(a,multipleTenants,accounts);
    const span = period ? `${period.from} through ${period.to}` : 'the available history';
    const uncovered = accounts.filter(a=>!a.period_verified);
    if (uncovered.length) {
      if (!period) percent-=15;
      else {
        const share = Math.min(...accounts.map(a=>a.period_days ? a.verified_days/a.period_days : 0));
        if (share>=0.5) percent-=15;
        else percent=Math.min(percent,share>0 ? 60 : 70);
      }
      for (const a of uncovered) {
        const dates = period ? a.unverified_dates.map(d=>`${d.from} through ${d.to}`).join(', ') : span;
        add(`${name(a)}: ${dates} unverified; $0 quantified; amount unknown; rows seen ${a.stated_from ?? 'none'} through ${a.stated_through ?? 'none'}.`,`${name(a)}: a complete dated statement or verified feed coverage for ${dates}.`);
      }
    }
    const uncertain = accounts.filter(a=>a.uncertain.inflow_minor || a.uncertain.outflow_minor);
    if (uncertain.length) {
      if(!immaterialRisk){percent-=20;percent=Math.min(percent,89);}
      for (const a of uncertain) for (const direction of ['inflow','outflow']) if (a.uncertain[direction+'_minor'])
        add(`${name(a)}: ${dollars(a.uncertain[direction+'_minor'],a.currency)} of ${direction} for ${span} (postings ${a.uncertain.first_row} through ${a.uncertain.last_row}) have unproved income, expense or payment membership.`,`${name(a)}: deposit source, category or payment records proving those rows' membership.`);
    }
    const pending = accounts.filter(a=>a.pending.rows);
    if (pending.length) {
      percent-=10;
      for (const a of pending) add(`${name(a)}: ${a.pending.rows} pending rows for ${span}, ${dollars(a.pending.inflow_minor,a.currency)} inflow and ${dollars(a.pending.outflow_minor,a.currency)} outflow, are excluded.`,`${name(a)}: posted amounts and dates for those pending rows.`);
    }
    for(const a of accounts) {
      if(a.history_holes?.length){percent=Math.min(percent,89);add(`${name(a)}: possible feed hole ${a.history_holes.map(h=>h.from+' through '+h.to).join(', ')} in a busy account; $0 quantified; amount unknown.`,`${name(a)}: complete statements or a bank history reconciliation for the silent dates.`);}
      if(pendingRequested && a.pending.collection==='not_collected'){percent=Math.min(percent,69);add(`${name(a)}: pending not collected; amount unknown.`,`${name(a)}: the bank's current pending entries or a feed that collects pending transactions.`);}
      if(a.pending.stale.rows){percent=Math.min(percent,89);add(`${name(a)}: ${a.pending.stale.rows} stale pending holds older than 14 days, ${dollars(a.pending.stale.inflow_minor,a.currency)} inflow and ${dollars(a.pending.stale.outflow_minor,a.currency)} outflow; status unknown.`,`${name(a)}: bank confirmation of settlement or release for the stale holds.`);}
    }
    if (accounts.some(a=>a.possible_duplicate_minor>0 || a.identity_basis==='stale_link')) {
      // Possible copies cost their dollar share (11 to 45); equal postings
      // repeated inside one account keep the flat review cost (15). Any
      // candidate stays below High.
      const extra=accounts.reduce((n,a)=>n+a.possible_duplicate_minor-(a.same_account_repeat_minor||0),0),gross=scoped(snapshot.rows,period,accountSlugs).reduce((n,r)=>n+r.amount_minor,0);
      const share=extra>0 ? Math.min(45,Math.max(11,Math.ceil(45*extra/Math.max(1,gross)))) : 0;
      const flat=accounts.some(a=>a.same_account_repeat_minor>0 || a.identity_basis==='stale_link') ? 15 : 0;
      if(!immaterialRisk)percent=Math.min(percent-Math.max(share,flat),89);
      add('Possible duplicate rows or stale same-account approvals remain in the observed accounts.','Statement comparison and current owner-approved identity links for duplicate candidates.');
      for(const a of accounts.filter(a=>a.possible_duplicate_minor>0))add(
        `${name(a)}: ${dollars(a.possible_duplicate_minor,a.currency)} may repeat another posting for ${span}; it may be counted twice, or left out when a mirrored feed copy is likely.`,
        `${name(a)}: compare the overlapping imports with the original statement, then approve the same-account link or resolve the duplicate imports.`);
    }
    if (accounts.some(a=>a.unreadable_rows>0 || a.unconfirmed_rows>0)) {
      percent-=15; add('Unreadable or unconfirmed transaction rows remain in the requested coverage.','Readable, confirmed amounts for every flagged account row.');
      for (const a of accounts) for (const r of a.unreadable) add(`${name(a)}: ${dollars(r.amount_minor ?? 0,r.currency)} ${r.direction ?? 'direction unknown'} excluded with an unreadable date or amount; ${r.amount_minor==null ? 'amount unknown' : 'recorded amount'}.`,`${name(a)}: a readable date, amount and direction for the flagged rows.`);
    }
    if (possibleMovement(scoped(snapshot.rows,period,accountSlugs),snapshot.pairs)) {
      if(!immaterialRisk)percent-=10; add('Equal opposite-direction amounts across accounts may be transfers; ownership or counterpart evidence is incomplete.','Counterpart statements or explicit bank transfer evidence for the possible movements.');
    }
    if (!period) { percent=Math.min(percent,89); add('No requested period was declared.','Explicit period_from and period_to matching the question.'); }
    const empty = accounts.filter(a=>a.rows_in_period===0 && !a.period_verified);
    if (empty.length) {
      percent=Math.min(percent,60);
      for (const a of empty) add(`${name(a)}: no rows or verified coverage for ${span}; $0 quantified; amount unknown.`,`${name(a)}: dated rows or verified complete coverage for ${span}.`);
    }
    if (!allAccounts.length || !accounts.length || empty.length===accounts.length) {
      percent=Math.min(percent,30);
      if (!allAccounts.length) add('No posted transaction rows or account inventory were available.','The expected accounts and dated rows for the requested period.');
    }
    for(const a of allAccounts)for(const e of a.lifecycle_conflicts || []){percent=Math.min(percent,60);add(`${name(a)}: ${dollars(e.inflow_minor,e.currency)} inflow and ${dollars(e.outflow_minor,e.currency)} outflow remain counted despite ${e.reason} from ${e.first_row} through ${e.last_row}.`,`${name(a)}: corrected account dates or statements resolving the counted conflict.`);}
    for (const a of allAccounts) for (const e of a.excluded.filter(e=>e.reason!=='duplicate_feed')) {
      percent=Math.min(percent,60);
      add(`${name(a)}: ${dollars(e.inflow_minor,e.currency)} inflow and ${dollars(e.outflow_minor,e.currency)} outflow excluded (${e.reason}) from ${e.first_row} through ${e.last_row}.`,`${name(a)}: account lifecycle or coverage evidence resolving the excluded rows for ${span}.`);
    }
  }
  if (balances) {
    let balancePercent=95;
    const observation = a => {
      const figure=a.provider_position_minor!=null ? (a.balance_role==='liability' ? -a.provider_position_minor : a.provider_position_minor) : a.current_minor;
      return `${a.currency || 'currency unknown'} ${figure==null?'amount unknown':dollars(figure,a.currency)} as of ${a.as_of_date || 'date unknown'}`;
    };
    add('The expected-account list is not independently verified.','Owner-confirmed expected accounts and dated balance observations.');
    // A request declaration never proves that SQL excluded another account.
    // Account-table exclusion does not prove observation exclusion (a currency
    // join can still return the closed account's import). Apply the coarse
    // import ceiling before any lifecycle or declared-account shortcut.
    const scopedAccounts = balances;
    if (!scopedAccounts.length) { balancePercent=30; add('No accounts were recorded in the requested scope.','The expected-account inventory and dated balances for that scope.'); }
    for (const a of scopedAccounts) {
      const name = accountName({...a,last4:a.mask,label:a.label,bank:a.institution},false,scopedAccounts.map(b=>({...b,last4:b.mask})));
      // An observation's date is not its identity. A same-date or later zero
      // cannot resolve another import's gaps or certify its correction. Keep
      // that history below High even for an exact-date SQL selection.
      for(const history of a.balance_recompute_history || []) {
        if(history.statement_gaps?.length) {
          balancePercent=Math.min(balancePercent,80);
          add(`${name}: historical observation ${history.as_of_date}, ${dollars(history.current_minor,history.currency)}. ${history.statement_gaps.join(' ')}`,
            `${name}: reconcile the dated original statement closing, stored current balance and signed position in the account's sign convention.`);
        }
        if(history.corrected || history.notes.length) {
          balancePercent=Math.min(balancePercent,80);
          add(`${name}: historical observation ${history.as_of_date}, ${dollars(history.current_minor,history.currency)}: ${history.notes.join(' ')} The read-time correction still needs an independent closing-statement check.`,`${name}: independently verify that dated statement's closing balance and complete posted rows.`);
        }
        if(history.gaps.length) {
          balancePercent=Math.min(balancePercent,80);
          add(`${name}: historical observation ${history.as_of_date}, ${dollars(history.current_minor,history.currency)} has unresolved imported balance evidence. Another dated observation does not reconcile it. ${history.gaps.join(' ')}`,`${name}: reconcile that statement's opening, closing and complete posted rows.`);
        }
        if(history.opening_balance_missing || history.observation_gap) {
          balancePercent=Math.min(balancePercent,80);
          add(`${name}: historical observation ${history.as_of_date}, ${dollars(history.current_minor,history.currency)}. ${history.opening_balance_missing?'The stored imported statement opening balance is missing. ':''}${history.observation_gap || ''}`,
            `${name}: the original dated statement with an independently stored opening balance, complete posted rows and a reconciled closing balance.`);
        }
      }
      const recompute=a.balance_recompute;
      if(a.balance_statement_gaps?.length) {
        balancePercent=Math.min(balancePercent,80);
        add(`${name}: ${observation(a)}. ${a.balance_statement_gaps.join(' ')}`,
          `${name}: reconcile the dated original statement closing, stored current balance and signed position in the account's sign convention.`);
      }
      if(a.balance_recompute_unavailable) {
        balancePercent=Math.min(balancePercent,80);
        add(`${name}: stored figures remain readable, but the imported-statement arithmetic assessment is unavailable.`,`${name}: a complete bounded statement, opening balance and posted rows assessment.`);
      }
      if(recompute?.corrected || recompute?.notes.length) {
        balancePercent=Math.min(balancePercent,80);
        add(`${name}: ${observation(a)}. ${recompute.notes.join(' ')} The read-time correction still needs an independent closing-statement check.`,`${name}: independently verify the imported statement's closing balance and complete posted rows.`);
      }
      if(recompute?.gaps.length) {
        balancePercent=Math.min(balancePercent,80);
        add(`${name}: ${observation(a)}. ${recompute.gaps.join(' ')}`,`${name}: an independently stated opening balance, complete posted statement rows, and an exact reconciled closing balance/sign.`);
      }
      if(a.balance_opening_missing) {
        balancePercent=Math.min(balancePercent,80);
        add(`${name}: ${observation(a)}. The stored imported statement opening balance is missing.`,
          `${name}: the original dated statement with an independently stored opening balance, complete posted rows and a reconciled closing balance.`);
      }
      if (a.observation_provenance==='extracted' && /#balance$/.test(a.observation_locator || '') && !recompute) {
        balancePercent=Math.min(balancePercent,80);
        add(`${name}: ${observation(a)} came from an older file import without the closing cell or row proof; the latest posting date may have been paired with a different row's balance.`,
          `${name}: re-import the original statement with the current reader to prove the closing balance cell, posting date and row order.`);
      }
      if (a.observation_gap || a.observation_provenance==='extracted' && a.balance_role==='liability' && a.provider_position_minor==null && !recompute?.sign_proved) {
        balancePercent=Math.min(balancePercent,80);
        add(`${name}: ${a.observation_gap || 'the imported liability balance sign is unproved: signed position or positive amount owed.'}`,`${name}: a statement with account type, stated directions and opening/closing or running balances proving the sign convention.`);
      }
    }
    const selected = scopedAccounts.filter(a=>!(balanceScope?.closedNotCounted &&
      a.status==='closed' && isoDate(a.closed_on) && a.closed_on<=balanceAsOf) &&
      !(isoDate(a.opened_on) && a.opened_on>balanceAsOf && !a.as_of_date));
    for (const a of selected) {
      const name = accountName({...a,last4:a.mask,label:a.label,bank:a.institution},false,selected.map(b=>({...b,last4:b.mask})));
      if (a.account_kind_balance_conflict) {
        balancePercent=Math.min(balancePercent,80);
        add(`${name}: the saved deposit-account review conflicts with the provider's liability balance; a type review does not prove money owed became cash.`,
          `${name}: a statement proving the account type and signed balance before using it as cash.`);
      }
      const settledClosed = a.status==='closed' && a.closed_on<=balanceAsOf && a.as_of_date===a.closed_on &&
        a.basis_state==='confirmed' && a.current_minor===0 && (a.provider_position_minor==null || a.provider_position_minor===0) && !a.later_rows?.length;
      if (settledClosed) {
        add(`${name}: closed on ${a.closed_on} with a confirmed zero closing observation.`,`${name}: retain the confirmed zero closing statement.`);
        continue;
      }
      if (a.status==='closed' && isoDate(a.closed_on) && a.closed_on<=balanceAsOf) {
        balancePercent=Math.min(balancePercent,85);
        add(`${name}: closed on ${a.closed_on}; ${observation(a)} remains in the query and may be counted.`,`${name}: exclude the closed account or reconcile its closing statement and payoff before using this total.`);
      }
      if (isoDate(a.opened_on) && a.opened_on>balanceAsOf) {
        balancePercent=Math.min(balancePercent,60);
        add(`${name}: opens on ${a.opened_on}, after ${balanceAsOf}, but remains in the balance scope.`,`${name}: exclude future accounts or correct the recorded opening date.`);
      }
      const usable = a.as_of_date && (a.provider_position_minor!=null || a.current_minor!=null && !a.legacy_simplefin);
      if (!usable) { balancePercent=Math.min(balancePercent,60); add(`${name}: no usable balance observation on or before ${balanceAsOf}.`,`${name}: a dated balance observation with a usable signed provider position.`); continue; }
      if (a.basis_state!=='confirmed') { balancePercent=Math.min(balancePercent,80); add(`${name}: latest balance observation is unconfirmed.`,`${name}: confirmed balance evidence.`); }
      if (a.later_rows?.length) {
        balancePercent=Math.min(balancePercent,85);
        const shown=a.later_rows.slice(0,100);
        add(`${name}: ${a.later_rows.length>100?'at least ':''}${shown.length} posted rows after the ${a.as_of_date} observation through ${balanceAsOf}: ${shown.map(r=>`${r.posted_on} row ${r.id}, ${r.amount_minor==null?'amount unknown':dollars(r.amount_minor,r.currency)} ${r.direction || 'direction unknown'}`).join('; ')}. The returned dated figure does not include this later activity.`,
          `${name}: a balance observation after these posted rows, or a complete reconciled statement proving their balance impact and any interest or fees.`);
      }
      const c=a.balance_coverage;
      if (a.as_of_date<balanceAsOf && c && (c.status!=='complete' || c.basis!=='confirmed' ||
          !isoDate(c.from) || !isoDate(c.to) || c.from>nextDay(a.as_of_date,1) || c.to<balanceAsOf)) {
        balancePercent=Math.min(balancePercent,85);
        const after=nextDay(a.as_of_date,1),ranges=[];
        if(c.status==='complete' && c.basis==='confirmed' && isoDate(c.from) && isoDate(c.to)) {
          if(c.from>after) ranges.push(`${after} through ${c.from>balanceAsOf?balanceAsOf:nextDay(c.from,-1)}`);
          if(c.to<balanceAsOf) ranges.push(`${c.to>=after?nextDay(c.to,1):after} through ${balanceAsOf}`);
        }
        const unverified=ranges.length?ranges.join('; '):`${after} through ${balanceAsOf}`;
        add(`${name}: the ledger coverage leaves ${unverified} unverified after the ${a.as_of_date} balance observation; missing activity has unknown dollar impact.`,
          `${name}: complete confirmed statement activity and a reconciled balance for ${unverified}.`);
      }
      const age = days(a.as_of_date,balanceAsOf)-1;
      if (age>3) { balancePercent=Math.min(balancePercent,85); add(`${name}: the oldest latest balance observation is ${a.as_of_date}.`,`${name}: a fresh observation on or before ${balanceAsOf}.`); }
      if (age>35) balancePercent=Math.min(balancePercent,40);
    }
    // A mask is only a candidate identity. Keep both figures and name both
    // records until the owner proves whether they are the same account.
    for (let i=0;i<selected.length;i++) for (const b of selected.slice(i+1)) {
      const a=selected[i];
      if (a.tenant_id!==b.tenant_id || !a.mask || a.mask!==b.mask || a.account_kind!==b.account_kind ||
        a.currency!==b.currency || a.institution && b.institution && a.institution!==b.institution) continue;
      balancePercent=Math.min(balancePercent,85);
      add(`Possible duplicate account identity: Account ${a.mask}, ${a.label || a.account_slug} (${a.account_slug}) and ${b.label || b.account_slug} (${b.account_slug}), ${a.institution || b.institution || 'institution unknown'}, ${a.account_kind}; recorded observations ${observation(a)} and ${observation(b)} may count the same money twice.`,
        `Compare the original statements for ${a.account_slug} and ${b.account_slug}, then confirm distinct accounts or approve their same-account identity link.`);
    }
    const currencies=[...new Set(selected.map(a=>a.currency).filter(Boolean))];
    if (currencies.length>1 && !balanceScope?.currenciesSeparated) {
      balancePercent=Math.min(balancePercent,85);
      add(`Balance observations use ${currencies.join(', ')}; this result has not proved separate currency totals. Recorded observations: ${selected.map(a=>`${a.account_slug}: ${observation(a)}`).join('; ')}.`,
        'Return each currency separately or supply a dated exchange rate and show the conversion before combining balances.');
    }
    if (balanceScope?.scopedRaw) {
      balancePercent=Math.min(balancePercent,85);
      add('Schema-qualified storage reads can bypass the effective owner-reviewed account kind and balance scope.',
        'Use the Balances or Accounts recipe over the effective account inventory before certifying the figure.');
    }
    percent=Math.min(percent,balancePercent);
  }
  if (raw) {
    percent=Math.min(percent,cleanCheckTooLarge ? 40 : 55);
    add('Raw figures include lifecycle rows, transfers, payments, refunds and possible duplicate feeds until separately checked.','Clean membership and deduplication for disjoint account/date slices; compare the completed rows with statements.');
    if (cleanCheckTooLarge) add('Ledger too large for the clean check; coverage, transfers and duplicates were not assessed.','A complete bounded clean ledger assessment and statements for the requested accounts and dates.');
  }
  const assessed = new Set(['txn','coverage','transfer_pairs','fin_accounts','fin_entities','fin_account_links','fin_account_coverage','plaid_account_entity_assignments','simplefin_account_assignments','fin_balance_snapshots','fin_transactions']);
  for (const table of references.filter(name=>!assessed.has(name))) {
    percent=Math.min(percent,50);
    add(`${table} records were read as recorded; completeness was not assessed.`,`${table}: complete current source evidence for the requested figure.`);
  }
  if (truncated) { percent=Math.min(percent,40); add('The returned rows were truncated and cannot establish the complete figure.','An aggregate or all ordered pages for this query.'); }
  percent=Math.max(0,percent);
  return {percent,band:band(percent),reasons,missing};
}


const sqlDay = value => Date.parse(value + 'T00:00:00Z');
const sqlAccountName = account => /^\d{4}$/.test(account?.account ?? '') ? `Account ${account.account}` : 'Account without recorded last four';
const sqlHistory = account => `${sqlAccountName(account)} (sqlHistory ${account.history_first_row ?? 'unknown'} through ${account.history_last_row ?? 'unknown'})`;
const sqlCents = row => Math.abs(Number(row.amount_minor) || 0);

// This ceiling is a reproducible reading of the supplied account/row evidence,
// not a model's certainty or proof that unrecorded accounts do not exist.
// It never depends on query output columns, wording, or the ambient clock.
export function moneyConfidence({ coverage = [], rows = [], pairsTotal = 0, pairsProved = 0, window = null, today, truncated = false, raw = false }) {
  let percent = 100;
  const reasons = [], missing = [];
  const add = (code, points, text, needed) => {
    percent -= points;
    reasons.push({ code, points, text });
    missing.push(needed);
  };
  const result = () => {
    percent = Math.max(10, percent);
    const word = percent >= 90 ? 'High' : percent >= 70 ? 'Medium' : 'Low';
    return { percent, word, line:`Confidence: ${word} (${percent}%)`, reasons, missing };
  };
  const reference = window?.through && window.through < today ? window.through : today;
  const period = window ? `${window.from} through ${window.through}` : `available sqlHistory through ${reference}`;
  // Raw SQL has no frozen coverage or classification evidence. Empty coverage
  // there means "not read", not "no accounts"; expose that exact gap at 60%.
  if (!raw) {
    if (!coverage.length) {
      add('no_accounts', 90, `No account coverage is available for ${period}.`, 'Connect or import the owner\'s accounts and sync their activity for this period.');
      return result();
    }
    if (coverage.reduce((n, a) => n + a.row_count, 0) === 0)
      add('no_rows', 40, `${coverage.map(sqlAccountName).join(', ')} have no retained posted rows for ${period}.`, 'Sync or import dated posted activity for these accounts and this period.');
    let stalePoints = 0;
    for (const account of coverage) if (account.history_last_row && sqlDay(reference) - sqlDay(account.history_last_row) > 7 * 86400000) {
      const points = Math.min(10, 30 - stalePoints); stalePoints += points;
      add('stale_account', points, `${sqlAccountName(account)} has no rows after ${account.history_last_row}; activity through ${reference} may be missing.`,
        `Sync ${sqlAccountName(account)} after ${account.history_last_row} through ${reference}.`);
    }
    let startPoints = 0;
    for (const account of coverage) if (window && account.history_first_row > window.from) {
      const points = Math.min(10, 20 - startPoints); startPoints += points;
      add('starts_late', points, `${sqlAccountName(account)} first has rows on ${account.history_first_row}; activity from ${window.from} may be missing.`,
        `Import ${sqlAccountName(account)} sqlHistory from ${window.from} before ${account.history_first_row}.`);
    }
    for (const [field, noun, needed] of [
      ['unreadable_rows', 'unreadable', 'Re-import the unreadable rows with dates, directions and amounts.'],
      ['unconfirmed_rows', 'unconfirmed', 'Review and confirm the proposed row amounts and their source evidence.'],
    ]) {
      const affected = coverage.filter(a => a[field] > 0);
      if (affected.length) add(field, 5, affected.map(a => `${sqlHistory(a)} has ${a[field]} ${noun} rows`).join('; ') + '.', needed);
    }
    const estimated = rows.filter(r => r.classification === 'unknown');
    const estimatedCents = estimated.reduce((n, r) => n + sqlCents(r), 0), totalCents = rows.reduce((n, r) => n + sqlCents(r), 0);
    if (estimatedCents > 0) {
      // Keep account and currency amounts separate; a mixed-currency sum must
      // never appear in the explanation as if it were one dollar total.
      const groups = new Map();
      for (const row of estimated) {
        const name = sqlAccountName(row), currency = row.currency ?? 'unknown currency', key = JSON.stringify([name,currency]);
        if (!groups.has(key)) groups.set(key, { name, currency, amount:0, first:row.posted_on, last:row.posted_on });
        const group = groups.get(key); group.amount += sqlCents(row);
        if (row.posted_on < group.first) group.first = row.posted_on;
        if (row.posted_on > group.last) group.last = row.posted_on;
      }
      const text = [...groups.values()].map(g => `${g.name} from ${g.first} through ${g.last} has ${g.currency === 'USD' ? '$' : g.currency + ' '}${moneyMinorText(g.amount, g.currency, { grouped: false })} with unknown money classification`).join('; ') + '.';
      add('estimated_rows', Math.max(1, Math.min(25, Math.round(25 * estimatedCents / totalCents))), text,
        'Confirm the uncertain movements with bank details or counterpart records to distinguish income, spending and own-account payments.');
    }
    const duplicates = coverage.filter(a => a.possible_duplicate_count > 0);
    if (duplicates.length) add('possible_duplicates', 5,
      duplicates.map(a => `${sqlHistory(a)} has ${a.possible_duplicate_count} possible duplicate rows in ${period}`).join('; ') + '.',
      'Compare same-date/amount postings and confirm same-account feed links; inspect txn amounts for the dollars possibly counted twice.');
    if (pairsTotal > pairsProved) add('possible_transfers', 5,
      `${pairsTotal - pairsProved} possible transfer pairs remain unproved among ${coverage.map(sqlAccountName).join(', ')} for ${period}; those movements may still be counted.`,
      'Match counterpart bank postings and confirm owned endpoints; inspect transfer_pairs for each candidate amount and date.');
  }
  if (truncated) add('truncated', 20, `The query result is incomplete for ${period}.`, 'Return fewer columns or page ordered rows until the complete result is read.');
  if (raw) add('raw_rows', Math.max(0, percent - 60),
    'Raw transaction rows have not removed own transfers, card payments or duplicate feeds; account coverage and money classification were not read.',
    'Read clean txn and coverage for the same period; verify lifecycle states, own-account movements and duplicate feeds before certifying a total.');
  return result();
}
