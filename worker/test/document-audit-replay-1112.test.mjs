import test, {before, after} from 'node:test';
import { writeFileSync } from 'node:fs';
import { assertDocumentAnswer } from './helpers/document-answer-contract.mjs';
const originalNow = Date.now;
const receipts = [];
before(() => {Date.now = () => Date.parse('2026-11-12T19:00:00Z');});
after(() => {
  Date.now = originalNow;
  if(process.env.BRAIN_DOCUMENT_ORACLE_RECEIPT) writeFileSync(process.env.BRAIN_DOCUMENT_ORACLE_RECEIPT, JSON.stringify(receipts,null,2)+'\n');
});
function capture(domain, c, body) {
  receipts.push({domain,id:c.id,question:c.q,source_records:c.rows || c.docs || c.records || [],body});
}
import assert from 'node:assert/strict';
const base = './fixtures/document-audit/';
function contract(body, label) {
  if (!body.money_handoff && body.answer_contract?.kind === 'document') assertDocumentAnswer(body, {empty:!body.results?.length});
  if (body.answer_contract?.kind === 'ledger') assert.equal(body.confidence.percent,0,'an absent bank assessment stays at zero');
  assert.equal(typeof body.answer,'string',label);
  assert.ok(body.answer.trim(),label);
  assert.notEqual(body.status,'answer_withheld',label);
  assert.equal(body.answer_error,undefined,label);
  assert.doesNotMatch(body.answer.split(/Coverage:/)[0],/^(?:\*\*)?I (?:cannot|can't|must decline)|^The documents do not answer/im,label);
  assert.ok(body.confidence && Number.isInteger(body.confidence.percent),label);
  const p=body.confidence.percent;
  assert.equal(body.confidence.band,p>=90?'High':p>=70?'Medium':'Low',label);
  assert.ok(body.confidence.basis.length,label);
  assert.ok(body.confidence.missing.length,label);
  if(!body.money_handoff) assert.match(body.answer,/Coverage:.*[\s\S]*Missing or counted twice:.*[\s\S]*Estimates:.*[\s\S]*How to check:/,label);
}
test('contracts and invoices retain an answer through the real Worker', async t => {
  const {envFor,post} = await import(base+'contracts-invoices/harness.mjs');
  for(const file of ['cases.mjs','cases2.mjs']) {
    const {CASES}=await import(base+'contracts-invoices/'+file);
    for(const c of CASES) await t.test(c.id,async()=>{
      const {env,calls}=envFor(c);
      let reads=0;const prepare=env.DB.prepare.bind(env.DB);
      env.DB.prepare=(...args)=>{reads++;return prepare(...args);};
      const body=await post(env,'/api/rag/think',{q:c.q,limit:8});
      assert.ok(reads>0,'the real retrieval or ledger decision read its fixture');
      capture('CI',c,body);contract(body,c.id);
      if(c.id==='C13')assert.match(body.answer,/Co\./,'company subject survives');
      if(['C13','C13b'].includes(c.id))assert.match(body.answer,/2025-06-02/,'signature date survives full record read');
    });
  }
});
test('mail, meetings and texts retain record attribution',async t=>{
  const {runCase}=await import(base+'mail-meetings-texts/harness.mjs');
  for(const file of ['cases-a.mjs','cases-b.mjs','cases-c.mjs']) {
    const {cases}=await import(base+'mail-meetings-texts/'+file);
    for(const c of cases)await t.test(c.id,async()=>{
      const r=await runCase({...c,mcp:false});
      assert.equal(r.network_attempts,0);assert.equal(r.think_http,200);
      capture('MM',c,r.worker_think);contract(r.worker_think,c.id);assert.equal(r.remote_ask.isError,false);
      assert.ok(r.worker_read_calls>0,'the Worker reading decision ran before the remote adapter');
    });
  }
});
test('cross-source freshness and conflicts lower the one score',async t=>{
  const {build,remote}=await import(base+'cross-source-freshness/lib.mjs');
  const {cases}=await import(base+'cross-source-freshness/cases.mjs');
  for(const c of cases)await t.test(c.id,async()=>{
    const h=await build({sources:c.sources,docs:c.docs,draft:c.draft,verdict:c.verdict,indexBuilding:c.indexBuilding});
    try {
      const beforeReads=h.fixture.seen.sql.length;
      if(c.search){const r=await h.unified(c.q,c.params||{});assert.equal(r.http,200);assert.ok(h.fixture.seen.sql.length>beforeReads,'search decision reached');receipts.push({domain:'CS',id:c.id,search_only:true,http:r.http});return;}
      const r=await h.think(c.q,c.params||{});capture('CS',c,r.body);contract(r.body,c.id);
      assert.ok(h.fixture.seen.sql.length>beforeReads,'the actual retrieval decision ran');
      const a=await remote('ask',r.body,{question:c.q});assert.equal(a.isError,false);
      if(['OWN-04b','OWN-06'].includes(c.id)){assert.match(r.body.answer,/Newer retrieved records/);assert.match(r.body.answer,/As of/);assert.ok(r.body.confidence.percent<70);}
      if(['RT-08','OWN-07c','OWN-16'].includes(c.id))assert.ok(r.body.confidence.percent<90);
      if(c.id==='RT-13')assert.match(r.body.answer,/fourth day of March/);
    } finally{h.close();}
  });
});
test('confidence and model failure probes retain the closest record',async t=>{
  const {think,remoteAsk}=await import(base+'confidence-and-refusal/lib.mjs');
  for(const file of ['cases-a.mjs','cases-b.mjs','cases-c.mjs','cases-d.mjs']) {
    const {cases}=await import(base+'confidence-and-refusal/'+file);
    for(const c of cases)await t.test(c.id,async()=>{
      const r=await think(c.rows||[],c.q,c);capture('CR',c,r.body);contract(r.body,c.id);
      assert.ok(r.seen.sql.length>0,'the actual reading decision ran before model or source fallback');
      assert.equal((await remoteAsk(r.body,c.q)).isError,false);
      if(/^Q10/.test(c.id))assert.match(r.body.answer,/12,400/,'a named K-1 must return its stated figure');
      if(c.id==='Q13-who-signed-and-when-partial'){assert.doesNotMatch(r.body.answer,/Not covered by the documents/);assert.match(r.body.confidence.missing.join(' '),/signatories|signing date/);}
      if(c.id==='O09-clipped-number-in-excerpt')assert.match(r.body.answer,/1,250,000/);
      if(/Q13b/.test(c.id))assert.match(r.body.answer,/March 3, 2025/);
      if(/Q14b/.test(c.id))assert.match(r.body.answer,/60 days/);
      if(/900-prompt-boundary/.test(c.id))assert.match(r.body.answer,/125000/);
      if(/R3-02|zero-results|answer-service-down/.test(c.id))assert.ok(r.body.confidence.percent<90);
    });
  }
});
