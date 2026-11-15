import { pendingInScope, pendingTotals, stalePending } from './money-pending.js';
import { historyHoles } from './money-history.js';

// Pending holds can predate a period while still settling inside it. The same
// six-day evidence margin must appear in coverage and confidence disclosures.
export function pendingInPeriod(snapshot,account,period){
  return pendingInScope(snapshot.pending,period,[account.account_slug]).filter(r=>r.tenant_id===account.tenant_id);
}
export const unreadableInPeriod=(row,period)=>!period?.from || !row.readable_day || row.readable_day>=period.from && row.readable_day<=period.to;

// Margin rows support membership proof, not the owner's period statistics.
// Compute both public coverage and scoring from this one frozen projection.
export function coverageInPeriod(snapshot,period,asOf){
  return snapshot.coverage.map(c=>{
    const rows=snapshot.rows.filter(r=>r.tenant_id===c.tenant_id && r.account_slug===c.account_slug && (!period?.from || r.posted_on>=period.from && r.posted_on<=period.to)),
      pending=pendingInPeriod(snapshot,c,period),stale=stalePending(pending,asOf),active=pending.filter(r=>!stale.includes(r)),
      totals=pendingTotals(active),old=pendingTotals(stale),days=rows.map(r=>r.posted_on).sort(),holes=historyHoles(snapshot.rows,c,period);
    const collected=c.feed_kind==='simplefin'?'not_collected':'recorded';
    return {...c,first_row:days[0]??null,last_row:days.at(-1)??null,row_count:rows.length,
      unreadable_rows:(snapshot.unreadable||[]).filter(r=>r.tenant_id===c.tenant_id && r.account_slug===c.account_slug && unreadableInPeriod(r,period)).length,
      unconfirmed_rows:rows.filter(r=>r.basis_state!=='confirmed').length,
      rows_outside_account_dates:rows.filter(r=>c.opened_on && r.posted_on<c.opened_on || c.closed_on && r.posted_on>c.closed_on ||
        c.status==='closed' && !c.closed_on || c.coverage_status==='complete' && c.coverage_basis_state==='confirmed' &&
        (r.posted_on<c.covered_from || r.posted_on>c.covered_to)).length,
      pending_rows:collected==='not_collected' && !totals.rows?null:totals.rows,
      pending_in_minor:collected==='not_collected' && !totals.rows?null:totals.inflow_minor,
      pending_out_minor:collected==='not_collected' && !totals.rows?null:totals.outflow_minor,
      pending_oldest_on:totals.oldest_on,pending_collection:collected,pending_stale_rows:old.rows,
      pending_stale_in_minor:old.inflow_minor,pending_stale_out_minor:old.outflow_minor,
      history_gap_days:holes.reduce((n,h)=>n+h.days,0)};
  });
}
