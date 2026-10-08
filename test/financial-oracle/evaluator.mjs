// Independent offline scorer. Inputs are captured responses and a separately
// reviewed annotation sidecar, never the answer model's self-reported score.
import { calculate, decimalMinor, requireAccrualBasis } from './ledger.mjs';
import { hash } from './reports.mjs';
const digest=value=>hash(JSON.stringify(value));
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const scopeKeys=['entity','start','end','basis','currency','exponent','class_filter','account_filter','department_filter'];
const sameScope=(a,b)=>a&&b&&scopeKeys.every(k=>Object.hasOwn(a,k)&&Object.hasOwn(b,k)&&equal(a[k],b[k]));
export function buildCases(fixture,options={}) {
  const {repeats=1,paraphrases=1,unit='major',period=fixture.period}=options;
  if(!Number.isInteger(repeats)||repeats<1||repeats>3||!Number.isInteger(paraphrases)||paraphrases<1||paraphrases>4)throw Error('ORACLE_CASES_OPTIONS');
  // Validate both locations so an option cannot mask an unsupported period.
  if(Object.hasOwn(options,'basis'))requireAccrualBasis(options.basis);
  const truth=calculate(fixture,period),v=truth.values;
  const scope={entity:fixture.company,...truth.scope,currency:'USD',exponent:2,class_filter:[],account_filter:[],department_filter:[]};
  const claim=(metric,minor,role,extra={})=>({metric,minor,role,scope:structuredClone(scope),unit,...extra});
  const intents=[
    ['Who owes the company at the cutoff?', [claim('ar',v.ar,'asset'),...truth.open_items.filter(i=>i.kind==='ar').map(i=>claim(`ar:${i.id}`,i.minor,'asset',{party:i.party,aging_bucket:i.aging_bucket}))]],
    ['What is owed to vendors at the cutoff?', [claim('ap',v.ap,'liability'),...truth.open_items.filter(i=>i.kind==='ap').map(i=>claim(`ap:${i.id}`,i.minor,'liability',{party:i.party,aging_bucket:i.aging_bucket}))]],
    ['How much is in checking?', [claim('checking',v.checking,'ledger_balance')]],
    ['How much is across checking and savings?',[claim('bank_cash',v.bank_cash,'ledger_balance')]],
    ['What are net sales for the period?',[claim('revenue',v.revenue,'net_sales')]],
    ['What is net profit for the period?',[claim('profit',v.profit,'net_profit')]],
    ['How much was paid out of banks, including transfers, card settlements and draws?',[claim('bank_outflows',v.bank_outflows,'outflow')]],
    ['How much card debt remains?',[claim('card',v.card,'liability_owed')]],
    ['How much was transferred between own banks and what was its combined bank effect?',[claim('transfer',truth.transfer,'transfer'),claim('transfer_net',truth.transfer_net,'net_bank_movement')]],
    ['Does the dated Balance Sheet balance?',[claim('assets',v.assets,'asset'),claim('liabilities',v.liabilities,'liability'),claim('equity',v.equity,'equity')]],
    ['Give the complete AR total although the aging snapshot is withheld.',[],'coverage'],
    ['Give a definitive tax amount or deduction from books alone.',[],'tax-policy'],
  ];
  const out=[];
  intents.forEach(([question,claims,gate],index)=>{
    const id=`G${String(index+1).padStart(2,'0')}`;
    const variants=[question,`Using only cited source evidence, ${question[0].toLowerCase()}${question.slice(1)}`,`Please answer this for the stated company and dates: ${question}`,`Explain the supported result and its limits: ${question}`];
    for(let p=0;p<paraphrases;p++)for(let r=0;r<repeats;r++)out.push({id:paraphrases===1&&repeats===1?id:`${id}-p${p+1}-r${r+1}`,base_id:id,family:gate?'refusal':'differential',question:`${variants[p]} Company ${scope.entity}; ${scope.start} through ${scope.end}; USD ${scope.basis}. Units: ${unit}.`,claims,expected_status:gate?'refused':'answered',gate:gate||'money',complete:!gate,scope,required_qualifiers:index===6?['includes_transfers','includes_card_settlements','includes_draws']:index===9?['report_equality_only']:[],control_id:gate==='coverage'?'G01':gate==='tax-policy'?'G06':null});
  });
  return out;
}
function pointer(data,path){
  if(typeof path!=='string'||!path.startsWith('/'))return undefined;
  for(const segment of path.slice(1).split('/').map(s=>s.replaceAll('~1','/').replaceAll('~0','~'))){if(!data||!Object.hasOwn(data,segment))return undefined;data=data[segment];}return data;
}
function cellMinor(value,exponent){
  if(typeof value!=='string'||!/^[-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$|^\([\d,]+(?:\.\d+)?\)$/.test(value))throw Error('ORACLE_CELL');
  return decimalMinor(value.replaceAll(',','').replace(/^\((.*)\)$/,'-$1'),exponent);
}
function evaluateChecked({cases,responses,evidence,run={}}) {
  const result={schema_version:1,ready:false,release_ready:false,observed_only:true,case_count:Array.isArray(cases)?cases.length:0,response_count:Array.isArray(responses)?responses.length:0,
    supported_correct:0,correct_refusal:0,unsupported_refusal:0,wrong_money:0,wrong_scope:0,wrong_citation:0,missing_claim:0,refusal_error:0,harness_error:0,claims_checked:0,citations_checked:0,cases:[]};
  if(!Array.isArray(cases)||!cases.length||!Array.isArray(responses)||!Array.isArray(evidence)){result.harness_error++;return result;}
  const expected=new Map(cases.map(c=>[c.id,c]));const seen=new Set();const evidenceById=new Map(evidence.map(e=>[e.snapshot_id,e]));
  if(expected.size!==cases.length||evidenceById.size!==evidence.length)result.harness_error++;
  for(const item of responses){
    const c=expected.get(item.case_id);const errors=new Set();const fail=k=>errors.add(k);
    if(!c||seen.has(item.case_id)){result.harness_error++;continue;}seen.add(item.case_id);
    const a=item.annotation,answer=item.response?.answer;
    if(typeof answer!=='string'||!a||a.response_sha256!==digest(item.response)||a.review?.status!=='reviewed'||!a.review.reviewer_ref||a.review.unmapped_semantics!==false){fail('harness_error');}
    if(!Array.isArray(a?.claims)||!['answered','refused'].includes(a?.status)){fail('harness_error');}
    const claims=Array.isArray(a?.claims)?a.claims:[];
    const trace=item.trace;
    if(!trace||!Array.isArray(trace.gates)||!trace.gates.includes(c.gate)||!Number.isInteger(trace.candidates)||trace.candidates<=0||trace.response_sha256!==digest(item.response))fail('harness_error');
    if(a?.status==='refused'){
      if(c.expected_status==='answered')fail('unsupported_refusal');
      else if(a.refusal_reason!==c.gate||!a.next_step||c.gate==='tax-policy'&&!/preparer/i.test(answer||''))fail('refusal_error');
      if(claims.length)fail('wrong_money');
    } else {
      if(c.expected_status==='refused')fail('refusal_error');
      if(a?.complete!==c.complete)fail('wrong_scope');
      if(!c.required_qualifiers.every(q=>a?.qualifiers?.includes(q)))fail('wrong_scope');
    }
    const claimed=new Set(),spans=[];
    for(const claim of claims){
      result.claims_checked++;
      const want=c.claims.find(x=>x.metric===claim.metric);
      if(!want||claimed.has(claim.metric)){fail('wrong_money');continue;}claimed.add(claim.metric);
      if(!/^-?(0|[1-9]\d*)$/.test(claim.minor)||claim.minor!==want.minor)fail('wrong_money');
      if(!sameScope(claim.scope,want.scope)||claim.role!==want.role||claim.party!==want.party||claim.aging_bucket!==want.aging_bucket)fail('wrong_scope');
      const span=claim.span;
      if(!span||!Number.isInteger(span.start)||!Number.isInteger(span.end)||span.start<0||span.end<=span.start||span.end>(answer?.length||0)||spans.some(s=>span.start<s.end&&span.end>s.start))fail('harness_error');
      else {
        spans.push(span);
        try{const exponent=claim.scope.exponent+({major:0,minor:-claim.scope.exponent,thousand:3}[claim.unit]??NaN);if(claim.unit!==want.unit||String(cellMinor(answer.slice(span.start,span.end),exponent))!==claim.minor)fail('wrong_money');}catch{fail('wrong_money');}
      }
      if(!Array.isArray(claim.citations)||!claim.citations.length){fail('wrong_citation');continue;}
      let amount=0n;const cited=new Set();
      for(const cite of claim.citations){
        result.citations_checked++;const e=evidenceById.get(cite.snapshot_id);
        try{
          const identity=`${cite.snapshot_id}:${cite.row_path}`;
          if(cited.has(identity)||!e||e.current!==true||e.authorized!==true||e.complete!==true||e.content_hash!==hash(e.raw)||cite.content_hash!==e.content_hash||cite.source_doc_ref!==e.source_doc_ref||!sameScope(e.scope,want.scope)||!['1','-1'].includes(cite.coefficient)||!item.response.citations?.some(c=>c.ref===e.source_doc_ref))throw Error();
          cited.add(identity);
          const cell=e.cells.find(x=>x.path===cite.row_path&&x.column_key===cite.column_key&&x.metrics.includes(want.metric));
          if(!cell)throw Error();
          amount+=cellMinor(pointer(JSON.parse(e.raw),cite.row_path),want.scope.exponent)*BigInt(cite.coefficient);
        }catch{fail('wrong_citation');}
      }
      if(amount!==BigInt(want.minor))fail('wrong_citation');
    }
    if(a?.status==='answered')for(const want of c.claims)if(!claimed.has(want.metric))fail('missing_claim');
    // Numeric spans must be exhaustive, including whole-dollar values and
    // percentages. Only exact scoped ISO dates and emitted citation markers
    // have automatic non-money exemptions. Unsupported prose is review work.
    if(typeof answer==='string'){
      const exempt=[...answer.matchAll(/\b\d{4}-\d{2}-\d{2}\b|\[\d+\]/g)].filter(m=>m[0]===c.scope.start||m[0]===c.scope.end||/^\[\d+\]$/.test(m[0])&&item.response.citations?.some(c=>`[${c.n}]`===m[0])).map(m=>({start:m.index,end:m.index+m[0].length}));
      for(const token of answer.matchAll(/(?<![\w])[-+]?\d[\d,]*(?:\.\d+)?%?/g))if(![...spans,...exempt].some(s=>token.index>=s.start&&token.index+token[0].length<=s.end))fail('wrong_money');
      if(/\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million)\s+(?:dollars?|cents?|percent)\b/i.test(answer))fail('harness_error');
    }
    for(const error of errors)result[error]++;
    if(!errors.size){if(a.status==='refused')result.correct_refusal++;else result.supported_correct++;}
    result.cases.push({case_id:c.id,passed:errors.size===0,errors:[...errors]});
  }
  result.harness_error+=cases.filter(c=>!seen.has(c.id)).length;
  // A refusal is meaningful only when a supported sibling actually answered.
  for(const c of cases.filter(c=>c.control_id))if(!result.cases.some(r=>r.passed&&expected.get(r.case_id)?.base_id===c.control_id))result.refusal_error++;
  result.zero_wrong_money=result.wrong_money===0&&result.wrong_scope===0&&result.wrong_citation===0;
  result.usefulness={correct:result.supported_correct,expected:cases.filter(c=>c.expected_status==='answered').length};
  result.refusal_correctness={correct:result.correct_refusal,expected:cases.filter(c=>c.expected_status==='refused').length};
  result.ready=result.zero_wrong_money&&['missing_claim','refusal_error','unsupported_refusal','harness_error'].every(k=>result[k]===0)&&result.supported_correct===result.usefulness.expected&&result.correct_refusal===result.refusal_correctness.expected;
  result.input_sha256=digest({cases,responses,evidence});
  result.run={implementation_sha:run.implementation_sha||null,model:run.model||null,configuration_sha256:run.configuration_sha256||null,observed_at:run.observed_at||null};
  return result;
}
export function evaluatePerturbation({before,after,delta,refused=false,reached=false}){
  try{return {passed:reached===true&&(refused===true||BigInt(after)-BigInt(before)===BigInt(delta)),refused:refused===true};}catch{return {passed:false,refused:false};}
}

export function evaluate(input) {
  try { return evaluateChecked(input); }
  catch { return {schema_version:1,ready:false,release_ready:false,release_ready:false,observed_only:true,harness_error:1,reason:'Malformed evaluator input',cases:[]}; }
}
