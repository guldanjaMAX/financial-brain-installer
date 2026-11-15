import test from 'node:test';
import assert from 'node:assert/strict';
import { readDocumentEvidence, finalizeDocumentAnswer } from '../src/lib/document-answer.js';
import { documentEvidenceRevision } from '../src/lib/document-read-coverage.js';
import { handleMcp } from '../src/lib/mcp-endpoint.js';

const id = 'records:schedule';
const hash = 'a'.repeat(64);
const head = 'The crew deadline is November 30.';
const tail = 'Correction: the crew deadline is December 12.';
const row = () => ({n:1,doc_uid:id,title:'Crew schedule',source:'records',ts:'2026-11-13',
  date_reliable:true,text_reliable:true,text_source:'native',source_excerpts:[head,tail],
  snippet:`Keyword-matched excerpt:\n${head}\n\nSemantic excerpt from the same document:\n${tail}`});
function fixture(chunks, fail = false) {
  let reads=0;
  const env={DB:{prepare(sql){return {bind(){return this;},async all(){
    if(/sqlite_master/.test(sql))return {results:['custom_api_current_jobs','custom_api_document_versions'].map(name=>({name}))};
    reads++;if(fail)throw new Error('synthetic unavailable read');return {results:chunks};
  }};}}};
  return {env,reads:()=>reads};
}
const chunk=(text,chunk_ix=0,total_chunks=1)=>({doc_uid:id,content_hash:hash,chunk_ix,total_chunks,text});

test('receipt green control distinguishes contiguous chunks from a reached gap',async()=>{
  for(const ix of [0,2]){
    const f=fixture([chunk(head,ix)]);
    const out=await readDocumentEvidence(f.env,[{...row(),snippet:head,source_excerpts:[head]}]);
    assert.equal(f.reads(),1);
    assert.equal(out[0].read_complete,ix===0);
    assert.equal(out[0].read_coverage.contiguous,ix===0);
    assert.ok(out[0].read_coverage.revision);
    assert.equal(out[0].snippet,head);
  }
});

test('complete source-only reading keeps revision proof and request-local reuse',async()=>{
  const f=fixture([chunk(`${head} ${tail}`)]);
  const out=await readDocumentEvidence(f.env,[row(),row()]);
  assert.equal(f.reads(),1,'both populated hits reuse the actual authorized read');
  for(const doc of out){
    assert.equal(doc.snippet,`${head} ${tail}`);
    assert.deepEqual(doc.retrieval_excerpts,[]);
    assert.equal(doc.read_complete,true);
    assert.equal(doc.read_coverage.kind,'whole_stored_record');
    assert.equal(doc.read_coverage.revision,await documentEvidenceRevision(id,hash));
    assert.equal(doc.read_coverage.source_complete,false);
  }
});

test('bounded reuse keeps each source span separate and drift drops stale spans',async()=>{
  const f=fixture([chunk(head,0,501)]);
  const revision=await documentEvidenceRevision(id,hash);
  const out=await readDocumentEvidence(f.env,[{...row(),source_excerpts:[head],evidence_revision:revision},
    {...row(),source_excerpts:[tail],evidence_revision:revision}]);
  assert.equal(f.reads(),1,'two distinct retrieved spans reach the shared bounded read');
  assert.deepEqual(out.map(d=>d.retrieval_excerpts),[[],[tail]]);
  for(const doc of out){assert.equal(doc.snippet,head);assert.equal(doc.read_complete,false);assert.equal(doc.read_coverage.kind,'excerpt');}
  const answer=finalizeDocumentAnswer({question:'What is the crew deadline?',docs:[out[1]],searchComplete:true,asOf:'2026-11-14'});
  assert.match(answer.answer,/December 12/);
  assert.match(answer.answer,/additional retrieved excerpt/);
  assert.match(answer.answer,/Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
  assert.ok(answer.confidence.percent<90);
  const drift=await readDocumentEvidence(f.env,[{...row(),evidence_revision:'different'}]);
  assert.equal(f.reads(),2,'revision drift reaches its own database decision');
  assert.equal(drift[0].read_coverage.revision_changed,true);
  assert.deepEqual(drift[0].retrieval_excerpts,[]);
  assert.equal(drift[0].snippet,head);
});

test('unavailable reads retain pure source spans with explicit partial receipts',async()=>{
  for(const arm of ['empty','failure','no database']){
    const f=fixture([],arm==='failure');const input=row();
    const out=await readDocumentEvidence(arm==='no database'?{}:f.env,[input]);
    assert.equal(f.reads(),arm==='no database'?0:1,'each database decision is reached, or explicitly absent');
    assert.equal(input.source_excerpts.length,2,'fallback has populated authorized source spans');
    assert.equal(out[0].snippet,head);assert.deepEqual(out[0].retrieval_excerpts,[tail]);
    assert.equal(out[0].read_complete,false);assert.equal(out[0].read_coverage.reason,'read_unavailable');
    const answer=finalizeDocumentAnswer({question:'What is the crew deadline?',docs:out,searchComplete:true,asOf:'2026-11-14'});
    assert.match(answer.answer,/December 12/);assert.ok(answer.confidence.percent<90);
    assert.doesNotMatch(answer.answer,/Keyword-matched excerpt:|Semantic excerpt from the same document:/);
  }
  const green=fixture([chunk(`${head} ${tail}`)]);
  const out=await readDocumentEvidence(green.env,[row()]);
  assert.equal(green.reads(),1);assert.equal(out[0].read_complete,true);
});

test('remote search instructions retain successor, coverage and calendar observation rules',async()=>{
  const url=new URL('https://fixture.invalid/mcp');
  const response=await handleMcp({},new Request(url,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}),url,{});
  const body=await response.json();
  assert.ok(body.result.tools.length>0,'tool-list decision reached');
  const search=body.result.tools.find(t=>t.name==='search');assert.ok(search);
  assert.match(search.description,/selection\.newer_record/);
  assert.match(search.description,/read_coverage and retrieval_coverage/);
  assert.match(search.description,/record_observation\.ts/);
  assert.match(search.description,/scheduled event date/);
});
