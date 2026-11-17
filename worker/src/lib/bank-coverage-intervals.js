/** Inclusive calendar intervals. A missing day remains a hole, including when
 * both neighboring intervals have activity or matching monetary totals. */
export function bankCoverageGaps(from,to,intervals=[]) {
  const shift=(s,n)=>new Date(Date.parse(s+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
  const valid=s=>typeof s==='string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10)===s;
  if(!valid(from)||!valid(to)||from>to) throw Error('Invalid coverage interval.');
  const ordered=intervals.filter(i=>valid(i.from)&&valid(i.to)&&i.from<=i.to&&i.to>=from&&i.from<=to)
    .map(i=>({from:i.from<from?from:i.from,to:i.to>to?to:i.to})).sort((a,b)=>a.from.localeCompare(b.from));
  let cursor=from;const gaps=[];
  for(const i of ordered){if(i.from>cursor)gaps.push([cursor,shift(i.from,-1)]);if(i.to>=cursor)cursor=shift(i.to,1);if(cursor>to)break;}
  if(cursor<=to)gaps.push([cursor,to]);
  return gaps;
}
