import test from 'node:test';
import assert from 'node:assert/strict';
import { search, searchKeyword } from '../src/lib/store-d1.js';
import { keywordFixture } from './fixtures/keyword-search.mjs';
import { createProductFixture } from './product-contract-fixture.mjs';
import { readDocumentEvidence, finalizeDocumentAnswer } from '../src/lib/document-answer.js';
import { readOwnerDocumentPage } from '../src/lib/mcp-endpoint.js';
const NOW = Date.parse('2026-11-14T12:00:00Z');
const originalClock=Date.now;
test.before(()=>{Date.now=()=>NOW;});
test.after(()=>{Date.now=originalClock;});

function overload(f, { permanent = false, fail = 'D1 DB is overloaded' } = {}) {
  const prepare = f.env.DB.prepare.bind(f.env.DB), calls = [];
  f.env.DB.prepare = sql => {
    const s = prepare(sql), bind = s.bind.bind(s);
    s.bind = (...params) => {
      const bound = bind(...params), all = bound.all.bind(bound);
      bound.all = async () => {
        if (/chunks_fts MATCH/.test(sql)) {
          calls.push({sql, params});
          if (permanent || !/keyword_recovery_candidates/.test(sql)) {
            await new Promise(resolve => setTimeout(resolve, 2));
            throw new Error(fail);
          }
        }
        return all();
      };
      return bound;
    };
    return s;
  };
  return calls;
}

test('C1: eight parallel heavy failures recover once without widening, hints or an unavailable result', async () => {
  const f = keywordFixture(1000), calls = overload(f);
  try {
    const replies = await Promise.all(Array.from({length:8}, () => search(f.env, {
      query:'payment', embedding:null, limit:5, supplementalFilters:[{source:'bulk'}], now:NOW,
    })));
    assert.equal(calls.filter(c => !/keyword_recovery_candidates/.test(c.sql)).length,8,'one reached heavy decision per asker');
    assert.equal(calls.filter(c => /keyword_recovery_candidates/.test(c.sql)).length,8,'one reached recovery per asker');
    for (const r of replies) {
      assert.ok(r.results.length > 0,'recovery control supplies real authorized rows');
      assert.equal(r.degraded_reason,'bounded-keyword-recovery');
      assert.equal(r.retrieval_coverage.plan,'bounded_keyword');
      assert.equal(r.retrieval_coverage.state,'completed');
      assert.equal(r.retrieval_coverage.relevant_coverage,'unknown');
    }
    const sql = calls.find(c => /keyword_recovery_candidates/.test(c.sql)).sql;
    assert.doesNotMatch(sql,/bm25/i);assert.match(sql,/LIMIT 401/);assert.match(sql,/LIMIT 400/);
  } finally { f.db.close(); }
});

test('C2/C3: sparse recovery is incomplete; failed recovery differs from a populated green control', async () => {
  for (const arm of ['visible','sparse','failed','healthy']) {
    const f = keywordFixture(1000);
    const calls = arm === 'healthy' ? [] : overload(f,{permanent:arm==='failed'});
    try {
      const r = await search(f.env,{query:'payment',embedding:null,limit:5,now:NOW,
        filters:arm==='sparse'?{source:'absent-source'}:{}});
      if(arm==='healthy') {assert.ok(r.results.length);assert.equal(r.retrieval_coverage,undefined);continue;}
      assert.equal(calls.length,2,'both decision points reached even for zero survivors');
      assert.equal(r.retrieval_coverage.state,arm==='failed'?'failed':'completed');
      assert.equal(r.results.length>0,arm==='visible');
      assert.equal(r.degraded_reason,arm==='failed'?'bounded-keyword-recovery-failed':'bounded-keyword-recovery');
    } finally {f.db.close();}
  }
});

test('C4: recovery preserves 97/98-zone binding ceilings and protected failures never trigger recovery',async()=>{
  for(const n of [97,98]) {
    const f=keywordFixture(1000,{maxBindings:100});
    const zones=['private',...Array.from({length:n-1},(_,i)=>`zone-${i}`)];
    try {
      const rows=await searchKeyword(f.env,'payment',{limit:5,scope:{zones},readPlan:'bounded_keyword'});
      const calls=f.calls.filter(c=>/chunks_fts MATCH/.test(c.sql));
      assert.equal(calls.length,1);assert.ok(rows.length,'authorized green control');
      assert.equal(calls[0].params.length,n+2);assert.match(calls[0].sql,/keyword_recovery_candidates/);
      const hidden=await searchKeyword(f.env,'payment',{limit:5,scope:{zones:['unavailable-zone']},readPlan:'bounded_keyword'});
      assert.equal(hidden.length,0);assert.equal(f.calls.filter(c=>/keyword_recovery_candidates/.test(c.sql)).length,2);
    } finally {f.db.close();}
  }
  for(const fail of ['no such table: memory_supersessions','SQLITE_SCHEMA: no such column: scope']) {
    const f=keywordFixture(1000),calls=overload(f,{fail});
    try {
      if(fail.includes('memory_supersessions')) await assert.rejects(search(f.env,{query:'payment',embedding:null}),/memory_supersessions/);
      else await search(f.env,{query:'payment',embedding:null});
      assert.ok(calls.length,'protected failure reached actual keyword path');
      assert.equal(calls.filter(c=>/keyword_recovery_candidates/.test(c.sql)).length,0);
    } finally {f.db.close();}
  }
});

async function records(docs) {
  const f=await createProductFixture({env:{BRAIN_TIMEZONE:'UTC'}});
  f.raw("INSERT INTO sources(name,kind,status,created_at,last_ingest_at,last_complete_sweep_at,expected_refresh_seconds) VALUES ('records','upload','ready',?,?,?,86400)",...Array(3).fill(new Date(NOW).toISOString()));
  const response=await f.post('/api/admin/brain/ingest/batch',{docs:docs.map(d=>({source_type:'records',title:'Review memo',text_source:'native',text_reliable:true,date_source:'fixture:recorded_at',date_reliable:true,...d}))},{'X-Admin-Key':f.env.ADMIN_KEY});
  assert.equal(response.status,200);return f;
}

test('A: an exact authorized thread discovers a newer candidate outside the keyword window',async()=>{
  const saved=Date.now;Date.now=()=>NOW;
  try {
    for(const arm of ['linked','different-topic','hidden','future']) {
      const f=await records([
        {source_id:'earlier',content:'taskword status is open.',occurred_at:'2026-11-10',metadata:{thread_id:'topic-one'}},
        {source_id:'later',content:'The status is closed.',occurred_at:arm==='future'?'2026-12-01':'2026-11-13',metadata:{thread_id:arm==='different-topic'?'topic-two':'topic-one'}},
      ]);
      try {
        if(arm==='hidden') f.raw("UPDATE documents SET deleted_at=? WHERE doc_uid='records:later'",NOW);
        const res=await f.post('/api/rag/unified',{q:'taskword',limit:10},{'X-Admin-Key':f.env.ADMIN_KEY});
        const b=await res.json();assert.equal(res.status,200);assert.ok(b.results.length,'nonempty authorized seed');
        assert.ok(f.seen.sql.some(s=>/successor-discovery/.test(s)),'discovery decision reached');
        const old=b.results.find(r=>r.doc_uid==='records:earlier');assert.ok(old);
        if(arm==='linked'||arm==='future') {
          assert.equal(old.selection.newer_record.id,'records:later');
          assert.match(old.selection.newer_record.date,/2026-(11-13|12-01)/);
          assert.equal(old.selection.state,'unresolved','a thread never certifies an operative clause');
          assert.equal(old.selection.complete,false);
          assert.ok(b.results.some(r=>r.doc_uid==='records:later'),'candidate reaches the answer window');
        } else {
          assert.equal(old.selection.newer_record,null);
          assert.ok(!JSON.stringify(b).includes('records:later'),'hidden or unrelated existence is not disclosed');
        }
      } finally {f.close();}
    }
  } finally {Date.now=saved;}
});

test('B1/B3: contiguous, missing and bounded chunks have honest revision-bound reading receipts',async()=>{
  for(const arm of ['whole','gap','bound','pending']) {
    const f=await records([{source_id:'memo',content:'The price is USD 1250 monthly.',occurred_at:'2026-11-10'}]);
    try {
      if(arm==='pending')f.raw("UPDATE documents SET content_hash='pending-revision' WHERE doc_uid='records:memo'");
      if(arm==='gap')f.raw("UPDATE chunks SET chunk_ix=2 WHERE doc_uid='records:memo'");
      if(arm==='bound') {
        const row=f.first("SELECT * FROM chunks WHERE doc_uid='records:memo'");
        for(let i=1;i<=501;i++)f.raw('INSERT INTO chunks(chunk_uid,doc_uid,chunk_ix,text,source,title,document_date) VALUES(?,?,?,?,?,?,?)',`records:memo:${i}`,'records:memo',i,i===501?'Final qualification: not paid.':'Context.',row.source,row.title,row.document_date);
      }
      const rows=await readDocumentEvidence(f.env,[{doc_uid:'records:memo',snippet:'The price is USD 1250 monthly.'}]);
      assert.equal(rows.length,1);assert.ok(f.seen.sql.some(s=>/total_chunks/.test(s)),'coverage read reached');
      const r=rows[0].read_coverage;assert.ok(r);assert.equal(r.document_id,'records:memo');if(arm==='pending')assert.equal(r.revision,null);else assert.ok(r.revision);
      assert.equal(r.stored_text_complete,arm==='whole');assert.equal(rows[0].read_complete,arm==='whole');
      assert.equal(r.source_complete,false,'stored chunks alone never prove complete source extraction');
      assert.equal(r.kind,arm==='whole'?'whole_stored_record':'excerpt');
      assert.match(rows[0].snippet,/1250/);
    } finally {f.close();}
  }
});

test('B4: a final fetch page and forged completion cannot certify earlier pages or another revision',async()=>{
  const f=await records([{source_id:'long',content:'A source sentence. '.repeat(4000),occurred_at:'2026-11-10'}]);
  try {
    const first=JSON.parse((await readOwnerDocumentPage(f.env,{id:'records:long'},'https://fixture.invalid')).content[0].text);
    assert.ok(first.page.next_offset);assert.ok(first.read_coverage.revision);
    const tail=JSON.parse((await readOwnerDocumentPage(f.env,{id:'records:long',offset:first.page.next_offset,complete:true},'https://fixture.invalid')).content[0].text);
    assert.equal(tail.page.complete,true,'legacy end-of-page field is preserved');
    assert.equal(tail.read_coverage.stored_text_complete,false);assert.equal(tail.read_coverage.served_from,first.page.next_offset);
    const changed=await readOwnerDocumentPage(f.env,{id:'records:long',offset:first.page.next_offset,revision:'different'},'https://fixture.invalid');
    assert.equal(changed.isError,true);assert.match(changed.content[0].text,/revision/i);
    const short=await records([{source_id:'short',content:'Whole source sentence.',occurred_at:'2026-11-10'}]);
    try {const c=JSON.parse((await readOwnerDocumentPage(short.env,{id:'records:short'},'https://fixture.invalid')).content[0].text);assert.equal(c.read_coverage.stored_text_complete,true);} finally {short.close();}
  } finally {f.close();}
});

test('A/B5: unresolved successor retains dated alternatives below High and complete control differs',()=>{
  const doc={n:1,title:'Review memo',source:'records',snippet:'The status is open.',ts:'2026-11-10',date_reliable:true,text_reliable:true,text_source:'native',read_complete:true};
  const later={...doc,n:2,snippet:'The status is closed.',ts:'2026-11-13'};
  const base={question:'What is the latest status?',draft:'The status is open [1].',docs:[doc],approvedDocs:[doc],checks:[{supported:true,complete:true}],searchComplete:true};
  const green=finalizeDocumentAnswer(base);
  const changed=finalizeDocumentAnswer({...base,docs:[{...doc,selection:{state:'unresolved',newer_record:{id:'records:later',date:'2026-11-13'}}},later]});
  assert.match(changed.answer,/closed/);assert.match(changed.answer,/open/);assert.ok(changed.confidence.percent<=69);
  assert.ok(changed.confidence.missing.some(s=>/newer|related|claim/i.test(s)));
  assert.notEqual(changed.answer,green.answer);assert.match(changed.answer,/Coverage:.*\nMissing or counted twice:.*\nEstimates:.*\nHow to check:/s);
});

test('C1/C2/D2: eight real route replies retain the figure, five parts and Low confidence under recovery',async()=>{
  const saved=Date.now;Date.now=()=>NOW;
  try {
    const f=await records([{source_id:'memo',content:'The taskword fee is USD 1250 monthly.',occurred_at:'2026-11-10'}]);
    try {
      const calls=overload(f);f.control.vectorQueryFails=true;
      const replies=await Promise.all(Array.from({length:8},async()=>{
        const response=await f.post('/api/rag/unified',{q:'taskword'},{'X-Admin-Key':f.env.ADMIN_KEY});
        assert.equal(response.status,200);return response.json();
      }));
      assert.equal(calls.length,16,'eight heavy and eight bounded SQL decisions');
      for(const b of replies){assert.equal(b.status,'coverage_incomplete');assert.match(b.answer,/1250/);assert.ok(b.results.length);assert.ok(b.confidence.percent<=10);assert.match(b.confidence_text,/Confidence: Low/);assert.match(b.answer,/Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);assert.ok(b.gaps.some(g=>g.type==='bounded_keyword_recovery'));}
      const before=calls.length;
      const invalid=await f.post('/api/rag/unified',{q:'taskword',read_plan:'arbitrary'},{'X-Admin-Key':f.env.ADMIN_KEY});
      assert.equal(invalid.status,400);assert.equal(calls.length,before,'closed enum rejected before SQL');
      const failedCalls=overload(f,{permanent:true});
      const failed=await f.post('/api/rag/think',{q:'taskword'},{'X-Admin-Key':f.env.ADMIN_KEY});
      const b=await failed.json();assert.equal(failed.status,200);assert.ok(failedCalls.length>=2,'heavy and recovery failure reached');
      assert.ok(b.answer.trim());assert.ok(b.confidence.percent<=10);assert.ok(b.confidence.missing.length);assert.doesNotMatch(b.answer,/\$0\b/);
    } finally {f.close();}
  } finally {Date.now=saved;}
});

test('B: reading concurrency is two, duplicate revisions reuse a read, and revision drift is partial',async()=>{
  const f=await records(Array.from({length:4},(_,i)=>({source_id:`record-${i}`,content:'The status is open.',occurred_at:'2026-11-10'})));
  let active=0,max=0,reads=0;const prepare=f.env.DB.prepare.bind(f.env.DB);
  f.env.DB.prepare=sql=>{const s=prepare(sql),bind=s.bind.bind(s);s.bind=(...p)=>{const b=bind(...p),all=b.all.bind(b);b.all=async()=>{if(!/total_chunks/.test(sql))return all();active++;max=Math.max(max,active);reads++;try{await new Promise(r=>setTimeout(r,2));return await all();}finally{active--;}};return b;};return s;};
  try {
    const input=Array.from({length:4},(_,i)=>({doc_uid:`records:record-${i}`}));
    const read=await readDocumentEvidence(f.env,[...input,input[0]]);
    assert.equal(reads,4,'same revision read once per request');assert.equal(max,2);assert.equal(read.length,5);assert.ok(read.every(r=>r.read_complete));
    const drift=await readDocumentEvidence(f.env,[{...input[0],evidence_revision:'different',snippet:'stale figure 9999'}]);
    assert.equal(drift[0].read_coverage.revision_changed,true);assert.equal(drift[0].read_complete,false);assert.doesNotMatch(drift[0].snippet,/9999/);
  } finally {f.close();}
});

test('C4: bounded recovery repeats date, entity, deletion, exact grants, corrections and current API pointers',async()=>{
  const f=keywordFixture(1000);
  try {
    const run=(query,options={})=>searchKeyword(f.env,query,{limit:10,readPlan:'bounded_keyword',...options});
    const visible=await run('payment');assert.ok(visible.some(r=>r.doc_uid==='bulk:0'));
    f.db.prepare("UPDATE documents SET deleted_at=? WHERE doc_uid='bulk:0'").run(NOW);
    assert.ok(!(await run('payment')).some(r=>r.doc_uid==='bulk:0'),'reached populated deleted-row decision');
    assert.equal((await run('payment',{filters:{entity_slug:'other'}})).length,0);
    assert.equal((await run('payment',{filters:{from:'2026-02-01'}})).length,0);
    assert.equal((await run('payment',{filters:{to:'2025-12-31'}})).length,0);
    f.db.prepare('INSERT INTO document_access_documents VALUES(?,?,?,NULL)').run('grant-a','bulk:2','entity-a');
    const granted=await run('payment',{access:{kind:'grant',grantId:'grant-a',entitySlug:'entity-a'}});
    assert.deepEqual(granted.map(r=>r.doc_uid),['bulk:2']);
    assert.deepEqual((await run('memorytoken')).map(r=>r.doc_uid),['owner-notes:memory-current']);
    assert.deepEqual((await run('apitoken')).map(r=>r.doc_uid),['api:api-current']);
    assert.ok(f.calls.filter(c=>/keyword_recovery_candidates/.test(c.sql)).length>=8,'all real SQL predicate decisions reached');
  } finally {f.db.close();}
});

test('A1/A4/A5/A6: related instruments stay attributed, future/draft records never replace governing terms by date',async()=>{
  const saved=Date.now;Date.now=()=>NOW;
  try {
    for(const arm of ['same-family','similar-title-only','other-entity','future-proposal']) {
      const f=await records([
        {source_id:'operative',title:'Executed order',content:'taskword monthly term is USD 1250. Signed and entered.',occurred_at:'2026-11-10',metadata:{family_of:'records:case'}},
        {source_id:'proposal',title:'Unsigned proposal',content:'Proposed monthly term is USD 1500. Unsigned, not effective.',occurred_at:arm==='future-proposal'?'2026-12-01':'2026-11-13',entity_slug:arm==='other-entity'?'other':undefined,metadata:arm==='similar-title-only'?{}:{family_of:'records:case'}},
      ]);
      try {
        if(arm==='other-entity') {f.raw("UPDATE documents SET entity_slug='other' WHERE doc_uid='records:proposal'");assert.equal(f.first("SELECT entity_slug FROM documents WHERE doc_uid='records:proposal'").entity_slug,'other');}
        const res=await f.post('/api/rag/think',{q:'What is the latest taskword term?'},{'X-Admin-Key':f.env.ADMIN_KEY});const b=await res.json();
        assert.equal(res.status,200);assert.match(b.answer,/1250/);assert.ok(b.confidence.percent<90);
        assert.ok(f.seen.sql.some(s=>/successor-discovery/.test(s)),'family discovery decision reached');
        if(arm==='same-family'||arm==='future-proposal') {assert.ok(b.results.some(r=>r.selection?.newer_record?.id==='records:proposal'));assert.match(b.answer,/1500/);assert.ok(b.confidence.percent<=69);}
        else assert.ok(!b.results.some(r=>r.selection?.newer_record?.id==='records:proposal'));
        const historical=JSON.parse((await readOwnerDocumentPage(f.env,{id:'records:operative'},'https://fixture.invalid')).content[0].text);
        assert.match(historical.text,/1250/);assert.doesNotMatch(historical.text,/1500/);
      } finally {f.close();}
    }
  } finally {Date.now=saved;}
});

test('MCP: remote search preserves successor, reading and recovery receipts and the prepared answer',async()=>{
  const {handleMcp}=await import('../src/lib/mcp-endpoint.js');
  const f=await records([{source_id:'memo',content:'The taskword fee is USD 1250 monthly.',occurred_at:'2026-11-10'}]);
  try {
    overload(f);f.control.vectorQueryFails=true;let calls=0;
    const response=await handleMcp(f.env,new Request('https://fixture.invalid/mcp',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'search',arguments:{query:'taskword'}}})}),new URL('https://fixture.invalid/mcp'),{
      grant:{profile:'librarian'},think:async()=>assert.fail('no recursive think'),search:async args=>{calls++;return (await f.post('/api/rag/unified',args,{'X-Admin-Key':f.env.ADMIN_KEY})).json();},
    });
    const rpc=await response.json();const b=JSON.parse(rpc.result.content[0].text);
    assert.equal(calls,1);assert.ok(b.results.length);assert.equal(b.retrieval_coverage.plan,'bounded_keyword');
    assert.equal(b.results[0].read_coverage.kind,'excerpt');assert.ok(b.results[0].selection);
    assert.match(b.answer,/1250/);assert.ok(b.answer_contract);assert.match(b.confidence_text,/Confidence: Low/);
  } finally {f.close();}
});

test('A2: verified correction edges recover a new label from an old-label query without reviving history',async()=>{
  const {validateLesson,renderLesson}=await import('../src/lib/remember-contract.js');
  const {withFirstPartySourceProvenance}=await import('../src/lib/provenance-receipt.js');
  const {discoverDocumentSuccessors}=await import('../src/lib/document-successors.js');
  const saved=Date.now;Date.now=()=>NOW;
  const f=await createProductFixture();
  try {
    const identity={source_type:'owner-notes',written_by:'owner_assistant',agent_profile:'owner-assistant',recorded_via:'local_mcp'};
    const write=async input=>{
      const checked=await validateLesson({...input,confidence:'verified',verification:'Direct owner correction in the synthetic conversation.'},identity);assert.equal(checked.ok,true);
      const value=checked.value;
      const envelope=withFirstPartySourceProvenance({source_type:'owner-notes',source_id:value.source_id,title:value.title,content:renderLesson(value),metadata:{category:'lesson',...identity,confidence:value.confidence,verification:value.verification,...(value.supersedes?{supersedes:value.supersedes}:{}),evidence_lineage:{version:1,kind:'agent_derived',root_ids:value.derived_from}}},{textSource:'native',textReliable:true});
      const response=await f.post('/api/admin/brain/owner-notes',envelope,{'X-Admin-Key':f.env.ADMIN_KEY});assert.equal(response.status,200);return (await response.json()).doc_uid;
    };
    const earlier=await write({title:'Prior label',body:'During the synthetic owner recap the label is cobaltoldmarker.'});
    const later=await write({title:'Corrected label',body:'During the synthetic owner recap the label is emeraldnewmarker.',supersedes:earlier});
    assert.ok(f.rows('SELECT * FROM memory_supersessions').length,'real verified edge decision reached');
    const response=await f.post('/api/rag/unified',{q:'cobaltoldmarker'},{'X-Admin-Key':f.env.ADMIN_KEY});const b=await response.json();
    assert.equal(response.status,200);assert.ok(b.results.some(r=>r.doc_uid===later));assert.ok(!b.results.some(r=>r.doc_uid===earlier));assert.match(b.answer,/emeraldnewmarker/);
    assert.ok(f.seen.sql.some(s=>/verified-correction-search/.test(s)),'bounded private history-seed decision reached');
    const discovered=await discoverDocumentSuccessors(f.env,[{doc_uid:earlier}],{question:'recap label'});
    assert.equal(discovered[0].selection.newer_record.id,later);
    const history=JSON.parse((await readOwnerDocumentPage(f.env,{id:earlier},'https://fixture.invalid')).content[0].text);assert.match(history.text,/cobaltoldmarker/);
    f.raw('DELETE FROM memory_supersessions');
    const control=await f.post('/api/rag/unified',{q:'cobaltoldmarker'},{'X-Admin-Key':f.env.ADMIN_KEY});const c=await control.json();
    assert.ok(c.results.some(r=>r.doc_uid===earlier),'without verified edge the dated original remains searchable');assert.ok(!c.results.some(r=>r.doc_uid===later),'raw supersedes intent is not replacement proof');
  } finally {Date.now=saved;f.close();}
});

test('MCP: an unfinalized search cannot inherit confidence in a legacy refusal',async()=>{
  const {handleMcp}=await import('../src/lib/mcp-endpoint.js');
  for(const high of [false,true]) {
    let calls=0;
    const response=await handleMcp({},new Request('https://fixture.invalid/mcp',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'search',arguments:{query:'status'}}})}),new URL('https://fixture.invalid/mcp'),{
      grant:{profile:'librarian'},think:async()=>assert.fail('no recursive think'),search:async()=>{calls++;return {results:[{source:'records',source_id:'memo',ts:'2026-11-13',date_reliable:true,text_source:'native',text_reliable:true}],...(high?{confidence:{percent:100,band:'High'}}:{})};},
    });
    const rpc=await response.json(),b=JSON.parse(rpc.result.content[0].text);assert.equal(calls,1);
    assert.ok(b.results.length);assert.ok(b.confidence.percent<90,'raw search never approves an answer at High');assert.match(b.confidence_text,/Confidence: Medium/);
  }
});

test('A/C4: unauthorized successors are indistinguishable from an absent neighbor',async()=>{
  const {discoverDocumentSuccessors}=await import('../src/lib/document-successors.js');
  const f=await records([{source_id:'earlier',content:'taskword open status.',occurred_at:'2026-11-10',metadata:{thread_id:'one'}},{source_id:'later',content:'Closed status.',occurred_at:'2026-11-13',metadata:{thread_id:'one'}}]);
  try {
    f.raw("UPDATE documents SET entity_slug='entity-a'");
    f.raw("INSERT INTO document_access_grants(grant_id,subject_label,entity_slug,created_at,created_by,create_request_id,request_fingerprint) VALUES ('scope','Reviewer','entity-a',?,'owner','request','fingerprint')",NOW);
    f.raw("INSERT INTO document_access_documents(grant_id,document_id,entity_slug,granted_at) VALUES ('scope','records:earlier','entity-a',?)",NOW);
    const options={access:{kind:'grant',grantId:'scope',entitySlug:'entity-a'},question:'status'};
    const seed=[{doc_uid:'records:earlier',snippet:'taskword open status.'}];
    const hidden=await discoverDocumentSuccessors(f.env,seed,options);
    assert.ok(f.seen.sql.some(s=>/successor-discovery/.test(s)),'authorized nonempty seed reached discovery');
    assert.ok(!JSON.stringify(hidden).includes('records:later'));
    f.raw("UPDATE documents SET deleted_at=? WHERE doc_uid='records:later'",NOW);
    const absent=await discoverDocumentSuccessors(f.env,seed,options);assert.deepEqual(hidden,absent,'no hidden id, date, count or existence marker');
    f.raw("UPDATE documents SET deleted_at=NULL WHERE doc_uid='records:later'");
    f.raw("INSERT INTO document_access_documents(grant_id,document_id,entity_slug,granted_at) VALUES ('scope','records:later','entity-a',?)",NOW);
    const visible=await discoverDocumentSuccessors(f.env,seed,options);assert.equal(visible[0].selection.newer_record.id,'records:later');assert.notDeepEqual(visible,hidden);
  } finally {f.close();}
});

test('D2: successor attribution preserves a lower model confidence ceiling',()=>{
  const doc={n:1,title:'Review memo',source:'records',snippet:'The status is open.',ts:'2026-11-10',date_reliable:true,text_reliable:true,text_source:'native',read_complete:true};
  const run=selection=>finalizeDocumentAnswer({question:'What is the latest status?',draft:'The status is open [1].\nConfidence: Low (5%)',docs:[{...doc,selection}],approvedDocs:[doc],checks:[{supported:true,complete:true}],searchComplete:true});
  const control=run(null);assert.ok(control.confidence.percent<=5);
  const related=run({state:'unresolved',newer_record:{id:'records:later',date:'2026-11-13'}});
  assert.match(related.answer,/open/);assert.ok(related.confidence.percent<=5,'new attribution can only lower the existing model ceiling');
});

test('B3: reused reads retain each authorized retrieval span beyond the 500-chunk bound',async()=>{
  const f=await records([{source_id:'memo',content:'First permitted clause.',occurred_at:'2026-11-10'}]);
  try {
    const base=f.first("SELECT * FROM chunks WHERE doc_uid='records:memo'");
    for(let i=1;i<=500;i++)f.raw('INSERT INTO chunks(chunk_uid,doc_uid,chunk_ix,text,source,title,document_date) VALUES(?,?,?,?,?,?,?)',`records:memo:${i}`,'records:memo',i,i===500?'Final qualification: amount is not paid.':'Context.',base.source,base.title,base.document_date);
    const before=f.seen.sql.length;
    const read=await readDocumentEvidence(f.env,[{doc_uid:'records:memo',snippet:'First permitted clause.'},{doc_uid:'records:memo',snippet:'Final qualification: amount is not paid.'}]);
    assert.equal(f.seen.sql.slice(before).filter(s=>/total_chunks/.test(s)).length,1,'one actual revision read reused');
    assert.match(read[0].snippet,/First permitted clause/);
    assert.deepEqual(read[0].retrieval_excerpts,[]);
    assert.deepEqual(read[1].retrieval_excerpts,['Final qualification: amount is not paid.']);
    assert.doesNotMatch(read[1].snippet,/Final qualification: amount is not paid/,'out-of-page source text stays separately attributed');
    const answer=finalizeDocumentAnswer({question:'What is the payment status?',
      docs:[{...read[1],n:1,title:'Review memo'}],searchComplete:true,asOf:'2026-11-14'});
    assert.match(answer.answer,/Final qualification: amount is not paid/);
    assert.match(answer.answer,/additional retrieved excerpt/);
    assert.ok(answer.confidence.percent<90);
    assert.ok(read.every(r=>r.read_complete===false));
  } finally {f.close();}
});
