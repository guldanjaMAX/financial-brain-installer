import { MONEY_TABLES } from './money-query-contract.js';

const DEFAULT_SOURCE_BOUND = 10000;
const publicViews = ['txn', 'coverage', 'transfer_pairs', 'document_index', 'document_sources'];
const nameOf = d => /^(?:SCAN|SEARCH) (?:TABLE |SUBQUERY \d+ )?("?)([^\s"]+)\1(?: AS (\S+))?/.exec(d);

function firstArgument(tokens, index) {
  let depth=0,end=index;
  for(;end<tokens.length;end++) {
    const t=tokens[end];if(t.kind!=='punctuation')continue;
    if(depth===0&&[',',')'].includes(t.v))break;
    if(t.v==='(')depth++;
    if(t.v===')')depth--;
  }
  return tokens.slice(index,end);
}

export function jsonReaderBound(tokens) {
  const bounds={};
  for(let i=0;i<tokens.length;i++) {
    const name=tokens[i].v;
    if(!['json_each','json_tree'].includes(name)||tokens[i+1]?.v!=='(')continue;
    const arg=firstArgument(tokens,i+2);
    const n=arg.length===1&&arg[0].kind==='string'?Math.max(1,arg[0].v.length):
      arg.length&&arg.every(t=>['word','identifier'].includes(t.kind)||t.v==='.')?DEFAULT_SOURCE_BOUND:2000000;
    bounds[name]=Math.max(bounds[name]??0,n);
  }
  return bounds;
}

export function formatWorkMultiplier(tokens) {
  let factor=1;
  for(let i=0;i<tokens.length;i++) {
    if(!['printf','format'].includes(tokens[i].v)||tokens[i+1]?.v!=='(')continue;
    const arg=firstArgument(tokens,i+2);
    if(arg.length!==1||arg[0].kind!=='string') {factor*=20000;continue;}
    let width=0,dynamic=false;
    for(const match of arg[0].v.matchAll(/%[-+ #0,!]*(\*|\d+)?(?:\.(\*|\d+))?(?:ll|l)?[a-z%]/g)) {
      if(match[0].endsWith('%'))continue;
      if(match[1]==='*'||match[2]==='*')dynamic=true;
      width=Math.max(width,Number(match[1]??0),Number(match[2]??0));
    }
    factor*=dynamic?20000:width>=1000?Math.ceil(width/100):1;
  }
  return factor;
}
export function loopName(detail) {
  const match = nameOf(detail);
  return match ? (match[3] ?? match[2]).toLowerCase().replace(/^main\./, '') : null;
}

export function callerCteNames(tokens) {
  const names = new Set();
  for (let i = 1; i < tokens.length; i++) {
    if (!['with','recursive',','].includes(tokens[i-1].v) || !['word','identifier'].includes(tokens[i].kind)) continue;
    let j = i + 1;
    if (tokens[j]?.v === '(') {
      let depth = 1;
      while (++j < tokens.length && depth) {
        if (tokens[j].v === '(') depth++;
        if (tokens[j].v === ')') depth--;
      }
    }
    if (tokens[j]?.v !== 'as') continue;
    j++;
    if (tokens[j]?.v === 'not') j++;
    if (tokens[j]?.v === 'materialized') j++;
    if (tokens[j]?.v === '(') names.add(tokens[i].v);
  }
  return names;
}

export function sourceAliases(tokens, cteNames) {
  const known = new Set([...MONEY_TABLES,...publicViews,'json_each','json_tree',...cteNames]);
  const stops = new Set('on using where join left right full inner cross natural group order limit having window union except intersect as from select values set indexed not'.split(' '));
  const aliases = new Map();
  const add = (alias, name) => {
    if (!aliases.has(alias)) aliases.set(alias, new Set());
    aliases.get(alias).add(name);
  };
  for(let i=0;i<tokens.length;i++) {
    const t=tokens[i];if(!known.has(t.v)||!['word','identifier','string'].includes(t.kind)||tokens[i+1]?.v==='.')continue;
    add(t.v,t.v);
    let j = i + 1;
    // Table functions carry their arguments before their alias.
    if(['json_each','json_tree'].includes(t.v)&&tokens[j]?.v==='(') {
      let depth=1;while(++j<tokens.length&&depth){if(tokens[j].v==='(')depth++;if(tokens[j].v===')')depth--;}
    }
    if(tokens[j]?.v==='as')j++;
    if(['word','identifier','string'].includes(tokens[j]?.kind)&&!stops.has(tokens[j].v))add(tokens[j].v,t.v);
  }
  return aliases;
}

// Nested full scans multiply. A correlated child is paid once for every outer
// row; a materialization or uncorrelated subquery is paid once for the group.
export function loopWork(rows, boundOf) {
  const kids = new Map();
  for (const row of rows) {
    if (!kids.has(row.parent)) kids.set(row.parent, []);
    kids.get(row.parent).push(row);
  }
  const work = id => {
    let product = 1, perRow = 0, once = 0;
    for (const k of kids.get(id) ?? []) {
      const d = String(k.detail);
      if (/^SCAN CONSTANT ROW/.test(d)) continue;
      if (/^SCAN /.test(d)) product *= Math.max(1, boundOf(loopName(d)));
      else if (/^SEARCH /.test(d)) product *= Math.max(1, boundOf.search?.(loopName(d), d) ?? 1);
      else if (/^CORRELATED /.test(d)) perRow += work(k.id);
      else once += work(k.id);
      if (/^(SCAN|SEARCH) /.test(d)) once += work(k.id) - 1;
    }
    return product * (1 + perRow) + once;
  };
  return work(0);
}

export async function loopBounds(checked, knownCounts, countSource) {
  const counts=new Map(Object.entries({...knownCounts,...jsonReaderBound(checked.tokens)}));
  // Validation's reserved empty public-shape reader does no answer work.
  // Callers cannot introduce this alias because mq_ names are rejected.
  counts.set('mq_shape',0);
  const scans=checked.loopPlan.filter(r=>/^(SCAN|SEARCH) /.test(r.detail)&&!/^SCAN (?:CONSTANT ROW|\d+ CONSTANT ROWS)/.test(r.detail));
  // Count only sources involved in fan-out; a lone scan still has the bounded
  // default. Probe at most 100001 rows, never COUNT(*) over an unbounded table.
  if(scans.length>1||checked.loopPlan.some(r=>/^CORRELATED /.test(r.detail))) {
    for(const row of scans)for(const source of checked.aliases.get(loopName(row.detail))??[]) {
      if(!counts.has(source)&&!checked.callerCtes.has(source)&&![...publicViews,'json_each','json_tree'].includes(source)&&MONEY_TABLES.includes(source))counts.set(source,await countSource(source));
      if(!counts.has(source)&&['document_index','document_sources'].includes(source))counts.set(source,await countSource(source));
    }
  }
  const derived=new Map(), resolving=new Set();
  const definitions=new Map();
  for(const row of checked.loopPlan) {
    const name=/^(?:MATERIALIZE|CO-ROUTINE) (.+)$/.exec(row.detail)?.[1]?.toLowerCase();
    if(name) { if(!definitions.has(name))definitions.set(name,[]);definitions.get(name).push(row.id); }
  }
  const definitionBound=id=>{
    const children=checked.loopPlan.filter(r=>r.parent===id);
    const values=children.map(r=>/^SCAN (\d+) CONSTANT ROWS/.exec(r.detail)?.[1]).find(Boolean);
    if(values)return Number(values);
    const inputs=children.filter(r=>/^(SCAN|SEARCH) /.test(r.detail)&&!/^SCAN CONSTANT ROW/.test(r.detail));
    const branches=children.filter(r=>/^(COMPOUND QUERY|LEFT-MOST SUBQUERY|UNION|EXCEPT|INTERSECT|MERGE)(?:$| )/.test(r.detail));
    // Compound definitions add their branches; flattening them to the default
    // loses UNION ALL multiplicity when the relation is scanned by a join.
    if(inputs.length||branches.length)return (inputs.length?inputs.reduce((n,r)=>n*Math.max(1,bound(loopName(r.detail))),1):0)+
      branches.reduce((n,r)=>n+definitionBound(r.id),0);
    if(children.some(r=>/^SCAN CONSTANT ROW$/.test(r.detail)))return 1;
    return DEFAULT_SOURCE_BOUND;
  };
  const bound=name=>{
    if(derived.has(name))return derived.get(name);
    const sources=checked.aliases.get(name)??new Set([name]);
    return Math.max(...[...sources].map(source=>{
      if(counts.has(source)&&!checked.callerCtes.has(source))return counts.get(source);
      if(definitions.has(source)&&!resolving.has(source)) {
        resolving.add(source);
        const n=Math.max(counts.get(source)??0,...definitions.get(source).map(definitionBound));
        resolving.delete(source);derived.set(source,n);return n;
      }
      return DEFAULT_SOURCE_BOUND;
    }));
  };
  // Clean txn preserves the unique fin_transactions.id through the snapshot.
  // A caller shadow or an alias with multiple possible sources cannot borrow
  // that proof. txn_uid alone is only unique within a tenant, not globally.
  // Account/date ranges and nonunique automatic indexes still cost full input.
  bound.search=(name,detail)=>{
    if(/\(rowid=\?\)/.test(detail))return 1;
    const sources=checked.aliases.get(name);
    if(/\(id=\?(?: AND [^)]*)?\)/.test(detail) && sources?.size===1 && sources.has('txn') && !checked.callerCtes.has('txn'))return 1;
    return bound(name);
  };
  return bound;
}
