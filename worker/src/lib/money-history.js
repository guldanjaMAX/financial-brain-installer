export const openingRowSql = (account, day) => `EXISTS(SELECT 1 FROM main.fin_transactions o
  WHERE o.tenant_id=${account}.tenant_id AND o.account_slug=${account}.account_slug
    AND o.pending=0 AND o.removed_at IS NULL AND o.superseded_by_id IS NULL AND o.posted_on=${day}
    AND (lower(COALESCE(o.description,'')) GLOB '*opening deposit*'
      OR lower(COALESCE(o.description,'')) GLOB '*initial deposit*'
      OR lower(COALESCE(o.description,'')) GLOB '*new account deposit*'))`;

// A completed history request proves delivery, not that the bank retained every
// requested year. Preserve owner-certified statements and recorded opening dates.
export const historyCoverageStartSql = (account, first, valid) => `CASE WHEN (${valid})
  AND ${account}.opened_on IS NULL AND c.basis_note='Plaid completed the requested history window.'
  THEN CASE WHEN ${first} IS NULL THEN c.covered_to WHEN ${first}>c.covered_from THEN ${first} ELSE c.covered_from END
  ELSE c.covered_from END`;

const day = d => Date.parse(d+'T00:00:00Z')/86400000;
const iso = n => new Date(n*86400000).toISOString().slice(0,10);
export function historyHoles(rows, account, period) {
  // A confirmed complete statement import already accounts for quiet days.
  // Cadence is a feed diagnostic, not contrary evidence to that statement.
  if(account.feed_kind==='import' && account.coverage_status==='complete' && account.coverage_basis_state==='confirmed')return [];
  const dates=[...new Set(rows.filter(r=>r.tenant_id===account.tenant_id && r.account_slug===account.account_slug)
    .map(r=>r.posted_on).filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d||'')))].sort();
  if(dates.length<8)return [];
  const intervals=dates.slice(1).map((d,i)=>day(d)-day(dates[i])).sort((a,b)=>a-b),
    median=intervals[Math.floor(intervals.length/2)];
  // Sparse monthly activity is not a hole. A sustained busy cadence supplies a
  // suspicion only, never an invented transaction or a claim of proven loss.
  if(median>3 || intervals.filter(n=>n<=3).length<6)return [];
  const holes=[];
  for(let i=1;i<dates.length;i++) {
    const distance=day(dates[i])-day(dates[i-1]);
    if(distance<8 || distance<median*5)continue;
    const from=iso(Math.max(day(dates[i-1])+1,period?.from?day(period.from):-Infinity)),
      to=iso(Math.min(day(dates[i])-1,period?.to?day(period.to):Infinity));
    if(from<=to)holes.push({from,to,reason:'possible_feed_hole',days:day(to)-day(from)+1});
  }
  return holes;
}
