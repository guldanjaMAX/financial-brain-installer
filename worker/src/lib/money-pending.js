import { shiftDay } from './money-query-budget.js';

export const PENDING_LEAD_DAYS=6;
export function pendingInScope(rows=[],period=null,slugs) {
  const from=period?.from && shiftDay(period.from,-PENDING_LEAD_DAYS);
  return rows.filter(r=>(!slugs || slugs.includes(r.account_slug)) &&
    (!from || !r.posted_on || r.posted_on>=from && r.posted_on<=period.to));
}
export function pendingTotals(rows=[]) {
  return {rows:rows.reduce((n,r)=>n+(r.row_count??1),0),
    inflow_minor:rows.filter(r=>r.direction==='inflow').reduce((n,r)=>n+(r.amount_minor||0),0),
    outflow_minor:rows.filter(r=>r.direction==='outflow').reduce((n,r)=>n+(r.amount_minor||0),0),
    oldest_on:rows.map(r=>r.posted_on).filter(Boolean).sort()[0]??null};
}
export const stalePending = (rows,asOf) => asOf ? rows.filter(r=>r.posted_on && r.posted_on<shiftDay(asOf,-14)) : [];
