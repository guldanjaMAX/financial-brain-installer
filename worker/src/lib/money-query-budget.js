// Infer a scope only for one raw-table SELECT whose WHERE is a conjunction of
// literal indexed bounds. Never push dates into txn: feed precedence depends
// on history before those dates, including the other feeds for that identity.
function indexedScope({ tokens, references }) {
  if (references.size !== 1 || !references.has('fin_transactions') || tokens[0].v !== 'select') return null;
  const words = tokens.filter(t => t.kind === 'word').map(t => t.v);
  if (words.filter(v => v === 'select').length !== 1 || words.filter(v => v === 'from').length !== 1 ||
      words.some(v => ['join', 'or', 'union', 'except', 'intersect', 'not', 'case'].includes(v))) return null;
  const from = tokens.findIndex(t => t.kind === 'word' && t.v === 'from');
  if (tokens[from + 1]?.v !== 'fin_transactions') return null;
  let i = from + 2, alias = 'fin_transactions';
  if (tokens[i]?.v === 'as') i++;
  if (tokens[i]?.kind === 'word' && tokens[i].v !== 'where') alias = tokens[i++].v;
  if (tokens[i++]?.v !== 'where') return null;
  const bounds = new Map();
  const stops = new Set(['group', 'order', 'having', 'limit', 'window']);
  while (i < tokens.length) {
    let column = tokens[i++];
    if (tokens[i]?.v === '.') {
      if (column.v !== alias && column.v !== 'fin_transactions') return null;
      i++; column = tokens[i++];
    }
    if (column?.kind !== 'word') return null;
    let op = tokens[i++]?.v;
    if (['<','>'].includes(op) && tokens[i]?.v === '=') { op += '='; i++; }
    const first = tokens[i++];
    const key = column.v === 'posted_on' && ['>=','<='].includes(op) ? column.v + op : column.v;
    if (bounds.has(key)) return null;
    if (['tenant_id', 'account_slug'].includes(column.v)) {
      if (op !== '=' || first?.kind !== 'string') return null;
      bounds.set(column.v, `${column.v}=${first.raw}`);
    } else if (['removed_at','superseded_by_id'].includes(column.v)) {
      if(op!=='is'||first?.v!=='null'||first.kind!=='word')return null;
      // These filters only remove lifecycle rows; include the whole indexed
      // account/date slice in the probe so no filtered row can evade its cap.
      bounds.set(column.v,`${column.v} IS NULL`);
    } else if(column.v==='pending') {
      if(op!=='='||first?.kind!=='number'||first.v!=='0')return null;
      bounds.set(column.v,'pending=0');
    } else if (column.v === 'posted_on' && ['>=','<='].includes(op)) {
      if (first?.kind !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(first.v)) return null;
      bounds.set(key, `posted_on${op}${first.raw}`);
    } else if (['posted_on', 'id'].includes(column.v)) {
      if (op !== 'between' || tokens[i++]?.v !== 'and') return null;
      const last = tokens[i++];
      if (column.v === 'id') {
        if (![first, last].every(t => t?.kind === 'number' && /^\d+$/.test(t.v) && Number.isSafeInteger(Number(t.v)))) return null;
      } else if (![first, last].every(t => t?.kind === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.v))) return null;
      if (first.v > last.v && column.v === 'posted_on') return null;
      bounds.set(column.v, `${column.v} BETWEEN ${first.raw} AND ${last.raw}`);
    } else return null;
    if (i === tokens.length || stops.has(tokens[i]?.v)) break;
    if (tokens[i++]?.v !== 'and') return null;
  }
  if (bounds.has('posted_on>=') && bounds.has('posted_on<=') && !bounds.has('posted_on')) {
    bounds.set('posted_on', bounds.get('posted_on>=') + ' AND ' + bounds.get('posted_on<='));
    bounds.delete('posted_on>='); bounds.delete('posted_on<=');
  }
  const scopeValues=[...bounds].filter(([key])=>!['removed_at','superseded_by_id','pending'].includes(key)).map(([,value])=>value);
  if (bounds.has('id')) return { index: '', where: scopeValues.join(' AND ') };
  if (['tenant_id', 'account_slug', 'posted_on'].every(k => bounds.has(k))) {
    return { index: ' INDEXED BY idx_fin_transactions_account', where: scopeValues.join(' AND ') };
  }
  if (!bounds.has('tenant_id') && ['account_slug','posted_on'].every(k => bounds.has(k))) {
    return { index: ' INDEXED BY idx_fin_transactions_account', needsTenantProof: true,
      where: `tenant_id IN (SELECT DISTINCT tenant_id FROM main.fin_accounts) AND ${scopeValues.join(' AND ')}` };
  }
  return null;
}

export function transactionInput(checked, maxScanRows, window = null, tenantProof = false, {clean=false,partial=false} = {}) {
  let scope = indexedScope(checked);
  if (scope?.needsTenantProof && !tenantProof) scope = null;
  // Reading one extra row proves overflow without ever counting the corpus.
  const base = window ? `SELECT t.* FROM (SELECT DISTINCT tenant_id,account_slug FROM main.fin_accounts) k
JOIN main.fin_transactions t INDEXED BY idx_fin_transactions_account
ON t.tenant_id=k.tenant_id AND t.account_slug=k.account_slug
AND t.posted_on BETWEEN '${window.scanFrom}' AND '${window.scanThrough}'${clean?' WHERE t.removed_at IS NULL AND t.superseded_by_id IS NULL':''}
UNION ALL SELECT t.* FROM main.fin_transactions t
WHERE (t.posted_on IS NULL OR date(t.posted_on,'+0 days') IS NOT t.posted_on)
  AND (t.posted_on IS NULL OR t.posted_on NOT BETWEEN '${window.scanFrom}' AND '${window.scanThrough}')${clean?' AND t.removed_at IS NULL AND t.superseded_by_id IS NULL':''}` :
    `SELECT * FROM main.fin_transactions${scope?.index ?? ''}${scope ? ` WHERE ${scope.where}` : ''}${clean ? `${scope?' AND ':' WHERE '}removed_at IS NULL AND superseded_by_id IS NULL` : ''}`;
  const input = `${base} LIMIT ${maxScanRows + 1}`;
  return {
    base,
    probe: `SELECT count(*) AS n FROM (${input})`,
    // Repeat the budget inside the same statement. A concurrent ingest after
    // preflight must cause an error, never a plausible partial money total.
    ctes: partial ? `fin_transactions AS MATERIALIZED (${base} ORDER BY id LIMIT ${maxScanRows})` : `mq_scan AS MATERIALIZED (${input}),
fin_transactions AS MATERIALIZED (
  SELECT * FROM mq_scan WHERE (SELECT CASE WHEN count(*)>${maxScanRows}
    THEN json_extract('!', '$') ELSE 1 END FROM mq_scan)
)`,
  };
}

export const TENANT_PROOF_SQL = `SELECT NOT EXISTS(SELECT 1 FROM main.fin_transactions t
  WHERE NOT EXISTS(SELECT 1 FROM main.fin_accounts a WHERE a.tenant_id=t.tenant_id)) AS ok`;
export function needsTenantProof(checked) { return indexedScope(checked)?.needsTenantProof === true; }

export function pairingWorkProbe(ctes) {
  // Bound the trusted self-join as well as caller SQL. Seven indexed equality
  // lookups per amount/day group avoid constructing a quadratic candidate set.
  return `WITH ${ctes},mq_work_groups AS MATERIALIZED (
    SELECT tenant_id,account_slug,currency,amount_minor,posted_on,direction,count(*) AS n
    FROM fin_transactions WHERE removed_at IS NULL AND superseded_by_id IS NULL AND pending=0
      AND amount_minor>0 AND direction IS NOT NULL AND date(posted_on,'+0 days')=posted_on
    GROUP BY tenant_id,account_slug,currency,amount_minor,posted_on,direction
  ),mq_offsets(days) AS (VALUES (-3),(-2),(-1),(0),(1),(2),(3))
  SELECT coalesce(sum(o.n*i.n),0) AS n FROM mq_work_groups o CROSS JOIN mq_offsets delta
  JOIN mq_work_groups i ON i.tenant_id=o.tenant_id AND i.currency=o.currency AND i.amount_minor=o.amount_minor
    AND i.posted_on=date(o.posted_on,printf('%+d days',delta.days)) AND i.direction='inflow'
    AND i.account_slug<>o.account_slug WHERE o.direction='outflow'`;
}

export const isoDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value+'T00:00:00Z').toISOString().slice(0,10) === value;
// Sentinels describe lifecycle bounds, never an owner's posting period.
export const POSTING_DATE_FLOOR='1900-01-01', POSTING_DATE_CEILING='2999-12-31';
export function shiftDay(day,n){
  const value=new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString();
  return value.startsWith('-')?'0000-01-01':value.startsWith('+')?'9999-12-31':value.slice(0,10);
}
export function normalizeDay(value,timeZone='UTC'){
  if(typeof value!=='string')return null;
  const match=/^(\d{4})-(\d{2})-(\d{2})(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/.exec(value);
  if(!match)return null;
  const [,year,month,date]=match,first=year+'-'+month+'-01';
  if(isoDay(value.slice(0,10))){
    // Offset-bearing bounds describe instants. Convert them before selecting
    // posting days, or a UTC end-of-month bound can include the next local day.
    if(value.length>10 && /(?:[Zz]|[+-]\d{2}:\d{2})$/.test(value)){
      const instant=Date.parse(value);if(!Number.isFinite(instant))return null;
      const day=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(instant);
      return {day,reason:'timestamp_owner_date'};
    }
    return {day:value.slice(0,10),reason:value.length>10?'timestamp_date_prefix':null};
  }
  if(!isoDay(first) || +date<1 || +date>31)return null;
  const last=shiftDay(shiftDay(first,32).slice(0,7)+'-01',-1),day=first.slice(0,8)+String(Math.min(+date,+last.slice(8))).padStart(2,'0');
  return {day,reason:value.slice(0,10)!==day?'day_past_month_end':value.length>10?'timestamp_date_prefix':null};
}
export function moneyQueryWindow(body, selection, {timeZone='UTC'} = {}) {
  if(body.from === undefined && body.to === undefined)return selection?.from && selection?.to ? {from:selection.from,to:selection.to,margin_days:6} : null;
  if(isoDay(body.from) && isoDay(body.to) && body.from<=body.to)return {from:body.from,to:body.to,margin_days:6};
  // Recover a malformed transport window only when the SQL independently
  // supplies a closed period. Never invent dates for an unbounded query.
  if(!selection?.from || !selection?.to)throw new Error('invalid money window');
  const adjustments=[];let from=normalizeDay(body.from,timeZone),to=normalizeDay(body.to,timeZone);
  for(const field of ['from','to']){
    const value=field==='from'?from:to;
    if(!value || value.reason)adjustments.push({field,given:body[field]??null,used:value?.day||selection[field],reason:value?.reason||'sql_period_bound'});
  }
  from=from?.day||selection.from;to=to?.day||selection.to;
  if(from>to){[from,to]=[to,from];adjustments.push({field:'window',reason:'reversed',from,to});}
  return {from,to,margin_days:6,adjustments};
}

// Only a flat conjunction establishes scope. Closed date functions and literal
// inequalities describe the same period as BETWEEN; OR/NOT/subqueries never do.
export function moneyQuerySelection({tokens}, {timeZone='UTC'} = {}) {
  if(tokens[0]?.v!=='select')return null;
  const words=tokens.filter(t=>t.kind==='word').map(t=>t.v);
  if(words.filter(w=>w==='select').length!==1 || words.filter(w=>w==='from').length!==1 ||
    words.some(w=>['join','union','except','intersect'].includes(w)))return null;
  const at=tokens.findIndex(t=>t.kind==='word' && t.v==='from'),table=tokens[at+1]?.v;
  if(!['txn','coverage','fin_balance_snapshots'].includes(table))return null;
  let i=at+2;
  if(tokens[i]?.v==='as')i+=2;
  else if(tokens[i]?.kind==='word' && !['where','order','group','limit'].includes(tokens[i].v))i++;
  if(tokens[i++]?.v!=='where')return null;
  const result={table},rewrites=[],adjustments=[];
  const field=()=>{let f=tokens[i++];if(tokens[i]?.v==='.') {i++;f=tokens[i++];}return f;};
  while(i<tokens.length){let column=field();
    if(column?.kind!=='word')return null;
    if(['substr','strftime'].includes(column.v)){
      if(result.from || result.to)return null;
      const name=column.v;let part=tokens.slice(i).map(t=>t.v),count;
      if(name==='substr' && part.slice(0,8).join('|')==='(|posted_on|,|1|,|7|)|=')count=8;
      else if(name==='strftime' && part[0]==='(' && ['%Y-%m'.toLowerCase(),'%Y'.toLowerCase()].includes(part[1]) && part.slice(2,6).join('|')===',|posted_on|)|=')count=6;
      else return null;
      const value=tokens[i+count];
      if(value?.kind!=='string' || !/^\d{4}(?:-\d{2})?$/.test(value.v) || value.v.length!==(name==='strftime' && part[1]==='%y'?4:7))return null;
      const from=value.v+(value.v.length===4?'-01-01':'-01');if(!isoDay(from))return null;
      result.from=from;result.to=value.v.length===4?value.v+'-12-31':shiftDay(shiftDay(from,32).slice(0,7)+'-01',-1);i+=count+1;
    }else{
      let op=tokens[i++]?.v;
      if(['<','>'].includes(op) && tokens[i]?.v==='='){op+='=';i++;}
      const value=tokens[i++];
      if(column.v==='posted_on'){
        const start=value?.kind==='string' && normalizeDay(value.v,timeZone);if(!start)return null;
        if(op==='between'){
          if(result.from || result.to)return null;
          if(tokens[i++]?.v!=='and')return null;
          const end=tokens[i++],last=end?.kind==='string' && normalizeDay(end.v,timeZone);if(!last)return null;
          const reversed=start.day>last.day;result.from=reversed?last.day:start.day;result.to=reversed?start.day:last.day;
          for(const [token,used,reason] of [[value,result.from,start.reason],[end,result.to,last.reason]])if(reason || reversed){rewrites.push({start:token.start,end:token.end,text:"'"+used+"'"});adjustments.push({field:'sql_between',given:token.raw,used,reason:reversed?'reversed':reason});}
        }else if(['>=','>','<=','<'].includes(op)){
          const bound=op.startsWith('>')?'from':'to';if(result[bound])return null;
          result[bound]=shiftDay(start.day,op==='>'?1:op==='<'?-1:0);
          if(start.reason){rewrites.push({start:value.start,end:value.end,text:"'"+start.day+"'"});adjustments.push({field:'sql_bound',given:value.raw,used:start.day,reason:start.reason});}
        }else return null;
      }else if(['account_slug','account_identity','account','tenant_id','side','currency','entity','direction','money_kind'].includes(column.v) && result[column.v]===undefined && op==='=' && value?.kind==='string')result[column.v]=value.raw.slice(1,-1).replaceAll("''", "'");
      else return null;
    }
    if(i===tokens.length || ['group','order','having','limit','window'].includes(tokens[i]?.v))break;
    if(tokens[i++]?.v!=='and')return null;
  }
  if(Boolean(result.from)!==Boolean(result.to) || result.from>result.to)return null;
  if(rewrites.length)Object.assign(result,{rewrites,adjustments});
  return result;
}
