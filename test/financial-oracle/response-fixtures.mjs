// Invented response recordings for scorer mutation tests, not model output.
import { hash } from './reports.mjs';
import { minorDecimal } from './ledger.mjs';
export function recordedControl(cases){
 const evidence=[],responses=[];
 for(const c of cases){
  let answer='';const claims=[],citations=[];
  for(const [index,want] of c.claims.entries()){
   const displayed=minorDecimal(want.minor,want.scope.exponent+(want.unit==='thousand'?3:want.unit==='minor'?-want.scope.exponent:0));
   answer+=`${want.metric}: `;const span={start:answer.length,end:answer.length+displayed.length};answer+=`${displayed} ${want.unit==='minor'?'cents':want.unit==='thousand'?'thousand USD':'USD'}. `;
   const snapshot_id=`snapshot:${c.id}:${index}`;const source_doc_ref=`source:${c.id}:${index}`;const raw=JSON.stringify({value:minorDecimal(want.minor)});const content_hash=hash(raw);
   evidence.push({snapshot_id,source_doc_ref,raw,content_hash,current:true,authorized:true,complete:true,scope:structuredClone(want.scope),cells:[{path:'/value',column_key:'value',metrics:[want.metric]}]});
   citations.push({n:index+1,ref:source_doc_ref});
   claims.push({...structuredClone(want),span,citations:[{snapshot_id,content_hash,source_doc_ref,row_path:'/value',column_key:'value',coefficient:'1'}]});
  }
  if(c.expected_status==='refused')answer=c.gate==='coverage'?'A complete aging report is required; these records cannot prove a total.':'Books alone cannot determine a tax amount or deduction. Review with your preparer.';
  const response={answer,citations};const response_sha256=hash(JSON.stringify(response));
  responses.push({case_id:c.id,response,annotation:{response_sha256,review:{status:'reviewed',reviewer_ref:'synthetic_reviewer',unmapped_semantics:false},status:c.expected_status,claims,complete:c.complete,qualifiers:c.required_qualifiers,refusal_reason:c.gate,next_step:'Obtain and review the missing evidence.'},trace:{response_sha256,candidates:3,gates:[c.gate]}});
 }
 return {cases:structuredClone(cases),responses,evidence};
}
