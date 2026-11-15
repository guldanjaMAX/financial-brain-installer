import { confidenceText, limitMoneyConfidence, unknownMoneyConfidence } from './money-confidence.js';

// References are replayable requests plus content digests, not bearer tokens.
// No caller score, persistent certificate cache or cross-request state is trusted.
const requestKeys=['sql','max_rows','from','through','to','period_end','period_from','period_to','account_slugs','measure','rank_limit','time_zone','payment_evidence'];
const canonical=value=>Array.isArray(value)?value.map(canonical):value && typeof value==='object'
  ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const sha=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
function* fragments(value) {
  if(Array.isArray(value)) {
    yield '[';for(let i=0;i<value.length;i++){if(i)yield ',';yield* fragments(value[i]);}yield ']';
  } else if(value && typeof value==='object') {
    yield '{';let first=true;
    for(const key of Object.keys(value).sort()) {if(!first)yield ',';first=false;yield JSON.stringify(key);yield ':';yield* fragments(value[key]);}
    yield '}';
  } else yield JSON.stringify(value)??'null';
}
async function digest(value) {
  // Bound extra hashing memory independently of the source snapshot size.
  // Whole-book canonical copies and a second whole-book UTF-8 buffer can turn
  // an otherwise readable aggregate into an isolate memory failure.
  let chunk='';const hashes=[];
  for(const part of fragments(value))for(let i=0;i<part.length;) {
    const end=Math.min(part.length,i+65536-chunk.length);chunk+=part.slice(i,end);i=end;
    if(chunk.length===65536){
      const code=chunk.charCodeAt(chunk.length-1),carry=code>=0xd800 && code<=0xdbff?chunk.slice(-1):'';
      hashes.push(await sha(carry?chunk.slice(0,-1):chunk));chunk=carry;
    }
  }
  if(chunk)hashes.push(await sha(chunk));
  return sha(JSON.stringify(hashes));
}
export async function headlineCertificate(body,result,snapshot,decisions) {
  const query=Object.fromEntries(requestKeys.filter(k=>body[k]!==undefined).map(k=>[k,body[k]]));
  const parts={figures:await digest(result.rows),population:await digest({snapshot,decisions}),
    assessment:await digest({percent:result.confidence.percent,reasons:result.confidence.reasons,missing:result.confidence.missing,
      as_of:result.as_of.local_date,time_zone:result.as_of.time_zone})};
  return {id:await digest({query,parts}),query,parts};
}

// Only direct row projections have a lineage proof. Functions, constants,
// aggregates, duplicate column labels and joins retain their own low score.
function projection(checked) {
  const ts=checked.tokens,id=t=>t && ['word','identifier'].includes(t.kind);
  const at=ts.findIndex(t=>t.kind==='word' && t.v==='from');
  if(ts[0]?.v!=='select' || at<0 || ts[at+1]?.v!=='txn' ||
    ts.filter(t=>t.kind==='word' && t.v==='select').length!==1 ||
    ts.some(t=>t.kind==='word' && ['join','union','intersect','except','group','having','distinct'].includes(t.v)))return null;
  let end=at+2,alias='txn';
  if(ts[end]?.v==='as')end++;
  if(id(ts[end]) && !['where','order','limit'].includes(ts[end].v))alias=ts[end++].v;
  if(ts[end] && !['where','order','limit'].includes(ts[end].v))return null;
  const parts=[];let start=1;
  for(let i=1;i<=at;i++)if(i===at || ts[i].v===','){parts.push(ts.slice(start,i));start=i+1;}
  const fields=new Map();
  for(const part of parts) {
    const named=part.at(-2)?.v==='as' && id(part.at(-1)),value=named?part.slice(0,-2):part;
    const c=value.length===1 && (id(value[0]) || value[0]?.v==='*')?value[0].v:
      value.length===3 && value[0].v===alias && value[1].v==='.' && (id(value[2]) || value[2].v==='*')?value[2].v:null;
    if(!c || c==='*' && (parts.length!==1 || named))return null;
    const last=part.at(-1),out=named?(last.kind==='identifier'?last.raw.slice(1,-1).replaceAll(last.raw[0]+last.raw[0],last.raw[0]):last.raw):c;
    if([...fields.keys()].some(k=>k.toLowerCase()===out.toLowerCase()))return null;fields.set(out,c);
  }
  return fields;
}
const gap=(code,why)=>({code,why,missing:'Repeat the exact headline aggregate and reconcile the supporting row identities, contributions, filters, accounts and dates. Keep disputed or excluded dollars separate.'});

// Membership alone cannot certify a selection: an arbitrary WHERE can hide the
// rows that disprove a derived figure, and an empty result proves no figure.
// Match the complete predicate token-for-token, ignoring only source qualifiers
// and SQL identifier quoting/case. Extra conjuncts may select one returned group.
function certifiedSelection(checked,grammar,head) {
  const ts=checked.tokens,from=ts.findIndex(t=>t.kind==='word' && t.v==='from');
  let at=from+2,alias='txn';
  if(ts[at]?.v==='as')at++;
  if(['word','identifier'].includes(ts[at]?.kind) && !['where','order','limit'].includes(ts[at].v))alias=ts[at].v;
  const normalize=(tokens,alias)=>{
    const out=[];
    for(let i=0;i<tokens.length;i++) {
      const t=tokens[i],id=['word','identifier'].includes(t.kind);
      if(id && [alias,'txn'].includes(t.v) && tokens[i+1]?.v==='.' && ['word','identifier'].includes(tokens[i+2]?.kind)) {i++;continue;}
      out.push({kind:id?'identifier':t.kind,v:t.kind==='string'?t.raw.slice(1,-1).replaceAll("''", "'"):t.v});
    }
    return out;
  };
  const where=ts.findIndex(t=>t.kind==='word' && t.v==='where');
  if(where<0 || !grammar.populationWhere)return false;
  const end=ts.findIndex((t,i)=>i>where && t.kind==='word' && ['order','limit'].includes(t.v));
  const selected=normalize(ts.slice(where+1,end<0?ts.length:end),alias);
  const certified=normalize(grammar.populationWhere,grammar.sourceAlias);
  if(!same(selected.slice(0,certified.length),certified))return false;
  const extra=selected.slice(certified.length),equalities=[];
  for(let i=0;i<extra.length;) {
    if(extra[i++]?.v!=='and')return false;
    let key;
    if(extra[i]?.v==='substr' && same(extra.slice(i,i+8).map(t=>t.v),['substr','(','posted_on',',','1',',','7',')'])) {
      key='posting_month';i+=8;
    } else if(extra[i]?.kind==='identifier')key=extra[i++].v;
    if(!grammar.groups.some(g=>g.key===key) || extra[i++]?.v!=='=')return false;
    const value=extra[i++];
    if(!value || !['string','number'].includes(value.kind))return false;
    equalities.push({key,value:value.kind==='number'?Number(value.v):value.v});
  }
  return !equalities.length || head.rows.some(row=>equalities.every(({key,value})=>
    same(row[grammar.groups.find(g=>g.key===key).output],value)));
}

async function verifyHeadlineSupport({body,result,checked,snapshot,replay}) {
  const inconsistencies=[],rowUse=[];let head,proof,matched=0,populationSize=null;
  const fail=(code,why)=>inconsistencies.push(gap(code,why));
  const ref=body.supports;
  try {
    if(!ref || typeof ref!=='object' || Array.isArray(ref) || !/^[a-f0-9]{64}$/.test(ref.id) ||
      !ref.query || typeof ref.query!=='object' || Array.isArray(ref.query) ||
      Object.keys(ref).some(k=>!['id','query','parts'].includes(k)) ||
      !ref.parts || !['figures','population','assessment'].every(k=>/^[a-f0-9]{64}$/.test(ref.parts[k])) ||
      Object.keys(ref.query).some(k=>!requestKeys.includes(k)) || JSON.stringify(ref.query).length>40000)
      throw Error('invalid reference');
    head=await replay(ref.query,p=>{proof=p;});
    if(!proof || head.certificate?.id!==ref.id) {
      fail('certificate_unverified','The supplied certificate identifier is not verified by the replayed headline.');
      fail(head.certificate?'certificate_changed':'certificate_unverified',
        'The headline certificate no longer matches its rows, total, count, classification or evidence; changed dollar impact requires reconciliation.');
      if(head.certificate)for(const [key,why] of Object.entries({
        figures:'The headline aggregate figures or group counts changed on replay.',
        population:'The stored row population, lifecycle, classification, account or coverage evidence changed on replay, even if aggregate sums stayed the same.',
        assessment:'The computed headline confidence evidence or owner calendar changed on replay.'}))
        if(head.certificate.parts[key]!==ref.parts[key])fail('headline_'+key+'_changed',why);
    }
  } catch {
    fail('certificate_unverified','The headline certificate could not be verified by a complete read-only replay. Its dollar impact is unknown.');
  }
  const fields=projection(checked);
  if(!fields || !snapshot || result.complete===false || result.truncated)
    fail('support_shape_unproved','The supporting query is not a complete direct txn row projection with verifiable row identities. Raw pending, removed or superseded rows are separate evidence and cannot be counted under a posted certificate.');
  if(proof && ref?.query) {
    const allAccounts=[...new Set(snapshot?.coverage?.map(r=>r.account_slug)??[])].sort();
    const sameContext=key=>same(body[key],ref.query[key]) ||
      key==='measure' && body.measure===undefined ||
      key==='account_slugs' && body.account_slugs===undefined && same(allAccounts,[...(ref.query.account_slugs??[])].sort());
    for(const key of ['period_from','period_to','account_slugs','measure','payment_evidence'])if(!sameContext(key)) {
      fail('support_context_differs',`The supporting request has a different ${key} from the certified headline.`);break;
    }
    if(result.as_of.time_zone!==head.as_of.time_zone || !proof.scope || !checked.tokens)
      fail('support_context_differs','The supporting owner calendar does not match the headline calendar.');
    // Even an empty or coincidentally unchanged result cannot conceal a changed
    // requested period. Only returned-group equality may narrow the WHERE.
    const dates=checked.tokens.filter(t=>t.kind==='string' && /^\d{4}-\d{2}-\d{2}$/.test(t.v)).map(t=>t.v);
    if(dates.some(d=>d<proof.scope.from || d>proof.scope.to))
      fail('support_period_differs','The supporting SQL reads dates outside the certified headline period.');
    if(!result.rows.length || !certifiedSelection(checked,proof.grammar,head))
      fail('support_selection_uncertified','The supporting selection is empty or its WHERE differs from the certified population. Only the exact predicate, with optional returned-group equality, ORDER BY or LIMIT, can retain the headline score. Figures derived from this selection retain its own confidence ceiling.');
  }
  if(fields && !inconsistencies.some(g=>g.code!=='support_selection_uncertified'))try {
    const mapped=result.rows.map(row=>fields.has('*')?row:Object.fromEntries([...fields].map(([out,col])=>[col,row[out]])));
    if(mapped.some(r=>r.id===undefined && r.txn_uid===undefined))throw Error('missing identity');
    const wantedIds=new Set(mapped.map(r=>r.id)),wantedUids=new Set(mapped.map(r=>r.txn_uid));
    const byRowId=new Map(),byUid=new Map();
    // One snapshot pass keeps proof work linear in the read plus the result;
    // rescanning a large snapshot once for every quoted row defeats the budget.
    for(const row of snapshot.rows)for(const [wanted,index,key] of [[wantedIds,byRowId,row.id],[wantedUids,byUid,row.txn_uid]])
      if(wanted.has(key)){if(!index.has(key))index.set(key,[]);index.get(key).push(row);}
    const ids=mapped.map(r=>{
      const candidates=(r.id!==undefined?byRowId.get(r.id):byUid.get(r.txn_uid))??[];
      const matches=candidates.filter(s=>(r.id===undefined || s.id===r.id) &&
        (r.txn_uid===undefined || s.txn_uid===r.txn_uid) &&
        (r.account_slug===undefined || s.account_slug===r.account_slug) &&
        (r.tenant_id===undefined || s.tenant_id===r.tenant_id));
      if(matches.length!==1 || !Number.isSafeInteger(matches[0].id))throw Error('ambiguous identity');
      return matches[0].id;
    });
    if(new Set(ids).size!==ids.length)throw Error('repeated row');
    const canonicalRows=await proof.readRows(ids);
    const byId=new Map(canonicalRows.rows.map(r=>[r.id,r])),selected=new Set(canonicalRows.selected);
    for(let i=0;i<mapped.length;i++) {
      const row=byId.get(ids[i]);
      if(!row || !Object.entries(mapped[i]).every(([k,v])=>Object.hasOwn(row,k) && same(v,row[k]))) {
        fail('support_rows_outside_scope','Supporting rows or their displayed amounts do not match the certified population, filters or contributions. Their dollars cannot be counted under this certificate.');break;
      }
      if(!selected.has(row.id)) {
        fail('support_rows_outside_scope','Supporting rows fall outside the certified filters, accounts or dates. Their dollars cannot be counted under this certificate.');break;
      }
      if(proof.grammar.groups.length && !head.rows.some(g=>proof.grammar.groups.every(({key,output})=>
        same(g[output],key==='posting_month'?row.posted_on.slice(0,7):row[key])))) {
        fail('support_rows_outside_scope','The supporting row belongs to a group outside the certified headline groups, including any top-N selection.');break;
      }
      rowUse.push({row_index:i,included_in_headline:true});matched++;
    }
    populationSize=await proof.countRows();
  } catch {
    fail('support_shape_unproved','The supporting row identities or population membership could not be proved; the added dollar impact is unknown.');
  }
  let confidence=head?.confidence??unknownMoneyConfidence('The headline certificate is unverified.','A completed certified headline query and membership-checked support rows.');
  for(const g of inconsistencies)confidence=limitMoneyConfidence(confidence,g.why,g.missing,
    g.code==='support_selection_uncertified'?result.confidence.percent:Math.min(69,result.confidence.percent));
  return {support:{certificate_id:typeof ref?.id==='string'?ref.id:null,checked:true,
    consistent_with_certificate:!inconsistencies.length,matched_rows:matched,proof_basis:'population_membership_only',
    subset:populationSize===null?null:matched<populationSize,row_use:rowUse,inconsistencies},
    answer_confidence:{...confidence,line:confidenceText(confidence).split('\n')[0],may_only_lower:true},
    answer_confidence_text:confidenceText(confidence)};
}

export async function checkHeadlineSupport(options) {
  const controller=new AbortController();let timer;
  const deadline=new Promise(resolve=>{
    timer=setTimeout(()=>{
      controller.abort();
      const g=gap('support_replay_timeout','The supporting rows were read, but the optional headline replay or membership proof exceeded its separate time budget. The headline confidence could not be verified; disputed dollar impact is unknown.');
      const confidence=unknownMoneyConfidence(g.why,g.missing);
      resolve({support:{certificate_id:options.body.supports?.id??null,checked:true,
        consistent_with_certificate:false,matched_rows:0,proof_basis:'population_membership_only',subset:null,row_use:[],inconsistencies:[g]},
        answer_confidence:{...confidence,may_only_lower:true},answer_confidence_text:confidenceText(confidence)});
    },options.timeoutMs??2000);
  });
  try {return await Promise.race([verifyHeadlineSupport({...options,
    replay:(query,onProof)=>options.replay(query,onProof,controller.signal)}),deadline]);}
  finally {clearTimeout(timer);}
}
