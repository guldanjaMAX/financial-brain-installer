import test from 'node:test';
import assert from 'node:assert/strict';
import { calEvent, rec, runCase } from './fixtures/document-audit/mail-meetings-texts/harness.mjs';
import { readDocumentEvidence, finalizeDocumentAnswer } from '../src/lib/document-answer.js';
import { computeGaps } from '../src/index.js';
import { handleMcp } from '../src/lib/mcp-endpoint.js';
import { currentEvidenceCandidates } from '../src/lib/query-intent.js';
import { assertDocumentAnswer } from './helpers/document-answer-contract.mjs';

const NOW = '2026-11-14T18:00:00Z';
const UPDATED = '2026-11-13T12:00:00Z';
const question = 'When is the upcoming crew winterization meeting on the calendar?';
const flat = value => String(value).replace(/\s+/g, ' ').trim();
const event = (day, updated = UPDATED, allDay = false) => calEvent({
  id:'fixture-event', summary:'Crew winterization meeting', updated,
  start:allDay ? {date:day} : {dateTime:`${day}T07:00:00-07:00`,timeZone:'America/Phoenix'},
  end:allDay ? {date:day} : {dateTime:`${day}T08:00:00-07:00`,timeZone:'America/Phoenix'},
  description:'Winterization assignments for the crew.',
});
async function calendarCase(day, options = {}) {
  const out = await runCase({id:'calendar-observation',now:NOW,question,records:[event(day, options.updated, options.allDay)],
    draft:'The meeting is scheduled as recorded [r0].',mcp:false,...options});
  assert.equal(out.think_http,200);
  assert.equal(out.network_attempts,0);
  assert.ok(out.worker_read_calls>0 && out.calls.draft>0,'retrieval and answer decision points reached');
  assert.equal(out.worker_think.results.length,1);
  assert.equal(out.worker_think.results[0].read_complete,true);
  assert.ok(out.worker_think.confidence.percent<90);
  assert.match(out.worker_think.confidence_text,/Confidence: (?:Low|Medium) \(\d+%\).*Why:.*Missing:/s);
  assert.match(out.worker_think.answer,/Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
  return out;
}

test('N1 scheduled-day controls leave the observation date unchanged',async()=>{
  const first = await calendarCase('2026-11-18');
  const moved = await calendarCase('2026-12-18');
  for (const [out,day] of [[first,'2026-11-18'],[moved,'2026-12-18']]) {
    assert.match(out.worker_think.answer,/As of 2026-11-13,/);
    assert.ok(out.worker_think.answer.includes(day),'scheduled fact remains in the quotation');
    assert.ok(out.worker_think.results[0].ts.startsWith(day),'event-day retrieval contract stays intact');
    assert.equal(out.worker_think.citations[0].record_observation.ts,'2026-11-13T12:00:00.000Z');
    assert.match(out.remote_ask.text,/As of 2026-11-13,/);
  }
  assert.equal(first.worker_think.confidence.percent,moved.worker_think.confidence.percent);
});

test('N1 a past series start does not make a recently modified record stale',async()=>{
  const out = await calendarCase('2025-12-05');
  assert.match(out.worker_think.answer,/As of 2026-11-13,/);
  assert.match(out.worker_think.answer,/2025-12-05/);
  assert.equal(out.worker_think.gaps.some(g=>g.type==='stale'),false,'populated past event reaches freshness analysis');
  assert.doesNotMatch(out.worker_think.confidence_text,/344 days old/);
});

test('N1 all-day events use the modification date too',async()=>{
  const out = await calendarCase('2026-12-24',{allDay:true});
  assert.match(out.worker_think.answer,/As of 2026-11-13,/);
  assert.match(out.worker_think.answer,/2026-12-24/);
});

test('N1 missing or invalid modification dates stay unverified',async t=>{
  for (const updated of [null,'not-a-date','2026-02-30T12:00:00Z']) await t.test(String(updated),async()=>{
    const out=await calendarCase('2026-11-18',{updated});
    assert.match(out.worker_think.answer,/As of date unverified,/);
    assert.ok(out.worker_think.gaps.some(g=>g.type==='undated'));
    assert.doesNotMatch(out.worker_think.answer,/As of 2026-11-18/);
  });
});

test('N1 modification chronology cannot be inverted by a future scheduled day',async()=>{
  const invitation=event('2026-11-23','2026-11-01T12:00:00Z');
  const email=rec('Crew winterization email','Crew winterization meeting is November 24 at 7 AM.',{date:'2026-11-13'});
  const out=await runCase({id:'revision-order',now:NOW,question:'Do the calendar and email agree about crew winterization?',
    records:[invitation,email],draft:'Crew winterization meeting is November 24 at 7 AM [r1].',mcp:false});
  assert.ok(out.worker_read_calls>0 && out.calls.draft>0);
  assert.equal(out.worker_think.results.length,2);
  assert.match(out.worker_think.answer,/November 24/);
  assert.match(out.worker_think.answer,/2026-11-23/,'the conflicting older invitation remains visible');
  assert.match(out.worker_think.answer,/As of 2026-11-01,/);
  assert.doesNotMatch(out.worker_think.answer,/Newer retrieved records/);
  assert.ok(out.worker_think.confidence.percent<90);
});

test('N1 local and remote search newest_record use observation time, preserving event dates',async()=>{
  const out=await calendarCase('2026-11-18',{mcp:true,searchArgs:{sort:'newest'}});
  const local=out.mcp_search.body;
  assert.equal(local.results.length,1,'stdio search reached the populated record');
  assert.equal(local.newest_record.ts,'2026-11-13T12:00:00.000Z');
  assert.ok(local.results[0].ts.startsWith('2026-11-18'));
  const url=new URL('https://fixture.invalid/mcp');
  let calls=0;
  const response=await handleMcp({},new Request(url,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,
    method:'tools/call',params:{name:'search',arguments:{query:question}}})}),url,{
    search:async()=>{calls++;return out.worker_unified;},
  });
  const remote=JSON.parse((await response.json()).result.content[0].text);
  assert.equal(calls,1);
  assert.equal(remote.results.length,1);
  assert.equal(remote.newest_record.date,'2026-11-13T12:00:00.000Z');
  assert.ok(remote.results[0].date.startsWith('2026-11-18'));
});

test('N1 existing non-calendar source dates and stale deductions remain unchanged',async()=>{
  const realNow=Date.now;Date.now=()=>Date.parse(NOW);
  try {
    const gaps=computeGaps([{source:'records',ts:'2025-12-05',date_reliable:true}]);
    assert.ok(gaps.some(g=>g.type==='stale' && g.days_since_newest===344),'stale green control reaches age decision');
  } finally {Date.now=realNow;}
  const doc={n:1,title:'Review email',source:'records',ts:'2026-11-13',date_reliable:true,
    snippet:'The review is November 18.',read_complete:true,text_source:'native',text_reliable:true};
  const out=finalizeDocumentAnswer({question:'When is the review?',docs:[doc],searchComplete:true});
  assert.match(out.answer,/As of 2026-11-13,/);
  assert.equal(out.answer_contract.read_count,1);
});

test('N1 current revision ranking uses modification time rather than event time',()=>{
  const calendar={title:'Crew winterization',snippet:'Crew winterization meeting is November 23.',
    ts:'2026-11-23',date_source:'calendar:event_start',date_reliable:true,
    authority_meta:JSON.stringify({updated:'2026-11-01T12:00:00Z'})};
  const email={title:'Crew winterization',snippet:'Crew winterization meeting is November 24.',
    ts:'2026-11-13',date_reliable:true};
  const ranked=currentEvidenceCandidates('What is the latest status for crew winterization?',[calendar,email]);
  assert.equal(ranked.length,2,'both revisions reached current-evidence ordering');
  assert.equal(ranked[0],email);
});

test('N1 an explicit latest scheduled meeting request retains occurrence ordering',()=>{
  const morning={title:'Crew morning meeting',snippet:'Crew morning meeting.',ts:'2026-11-18',date_source:'calendar:event_start',
    date_reliable:true,occurred_at:'2026-11-18T07:00:00-07:00',authority_meta:JSON.stringify({updated:'2026-11-13T12:00:00Z'})};
  const afternoon={...morning,title:'Crew afternoon meeting',snippet:'Crew afternoon meeting.',
    occurred_at:'2026-11-18T15:00:00-07:00',authority_meta:JSON.stringify({updated:'2026-11-01T12:00:00Z'})};
  const scheduled=currentEvidenceCandidates('What is the latest scheduled meeting for the crew?',[morning,afternoon]);
  const revisions=currentEvidenceCandidates('What is the latest status for the crew?',[morning,afternoon]);
  assert.equal(scheduled.length,2,'both events reached occurrence ordering');
  assert.equal(revisions.length,2,'both revisions reached modification ordering');
  assert.equal(scheduled[0],afternoon);
  assert.equal(revisions[0],morning,'event and revision questions have distinct green controls');
});

const sourceHead='The crew booking deadline was November 30.';
const sourceTail='Correction: the crew booking deadline is December 12, 2026; the November 30 date is superseded.';
const sourceBody=sourceHead+' '+Array.from({length:30},(_,i)=>`Station ${i+1} inventories gloves and checks storage shelves.`).join(' ')+' '+sourceTail;

test('N2 complete authorized reads quote source chunks without a second retrieval layer',async()=>{
  let prompt='';
  const out=await runCase({id:'complete-quote',now:NOW,question:'What is the latest crew booking deadline in the long schedule?',
    records:[rec('Crew booking schedule',sourceBody,{date:'2026-11-13'})],
    draft:value=>{prompt=value;return 'The crew booking deadline is December 12 [r0].';},mcp:false});
  assert.equal(out.think_http,200);
  assert.ok(out.worker_read_calls>0 && out.calls.draft>0);
  assert.equal(out.worker_think.results[0].read_complete,true);
  assert.match(out.worker_unified.results[0].snippet,/Keyword-matched excerpt:/,'control reaches composed retrieval, not a single-chunk shortcut');
  const reading=out.worker_think.results[0].snippet;
  assert.ok(reading.includes(sourceHead) && reading.includes(sourceTail),'both ends of the complete read survive');
  assert.doesNotMatch(reading,/Keyword-matched excerpt:|Semantic excerpt from the same document:/);
  assert.doesNotMatch(out.worker_think.answer,/Keyword-matched excerpt:|Semantic excerpt from the same document:/);
  assert.ok(prompt.includes(sourceTail),'answer model receives the complete tail');
  assert.doesNotMatch(prompt,/Keyword-matched excerpt:|Semantic excerpt from the same document:/);
  assert.ok(reading.indexOf(sourceHead)<reading.indexOf(sourceTail));
  assert.ok(out.worker_think.confidence.percent<90);
});

function readFixture(chunks) {
  const calls=[];
  // Complete-read controls supply the revision hash and contiguous indices
  // required by newest-wins receipts, rather than treating a row count as proof.
  const stored=chunks.map((chunk,chunk_ix)=>({content_hash:'a'.repeat(64),chunk_ix,...chunk}));
  const env={DB:{prepare(sql){return {bind(...args){calls.push({sql,args});return this;},async all(){return {results:stored};}};}}};
  return {env,calls};
}
const retrievedRow=()=>({n:1,doc_uid:'records:schedule',title:'Crew booking schedule',source:'records',ts:'2026-11-13',
  date_reliable:true,text_reliable:true,text_source:'native',
  snippet:`Keyword-matched excerpt:\n${sourceHead}\n\nSemantic excerpt from the same document:\n${sourceTail}`,
  source_excerpts:[sourceHead,sourceTail]});

for (const arm of ['complete','bounded','no chunks','read failure','no database']) test(`N2 ${arm} read keeps pure quoted spans and the retrieved tail`,async()=>{
  const chunks=arm==='complete' ? [{doc_uid:'records:schedule',text:sourceHead+' '+sourceTail,total_chunks:1}]
    : arm==='bounded' ? [{doc_uid:'records:schedule',text:sourceHead,total_chunks:501}] : [];
  const fixture=readFixture(chunks);
  if(arm==='read failure')fixture.env.DB.prepare=()=>{fixture.calls.push('failed read');throw new Error('fixture read unavailable');};
  const input=retrievedRow();
  const rows=await readDocumentEvidence(arm==='no database'?{}:fixture.env,[input]);
  assert.equal(rows.length,1);
  if(arm!=='no database')assert.ok(fixture.calls.length>0,'authorized read decision reached');
  else assert.ok(input.source_excerpts.length===2,'fallback has two populated source spans');
  assert.equal(rows[0].read_complete,arm==='complete');
  const out=finalizeDocumentAnswer({question:'What is the crew booking deadline?',docs:rows,searchComplete:true});
  assertDocumentAnswer({...out,results:rows},{provisional:true});
  assert.match(out.answer,/December 12/,'fallback never drops the retrieved correction');
  const quotes=[...out.answer.matchAll(/says: ("(?:[^"\\]|\\.)*") \[1\]/g)].map(m=>JSON.parse(m[1]));
  assert.ok(quotes.length>0,'attribution decision reached with a populated quotation');
  for(const quote of quotes)assert.ok(flat(sourceHead+' '+sourceTail).includes(quote),'each quotation is a source-only span');
  assert.doesNotMatch(out.answer,/Keyword-matched excerpt:|Semantic excerpt from the same document:/);
  assert.ok(out.confidence.percent<90);
});

test('N2 source-authored heading words remain source text',async()=>{
  const content='Keyword-matched excerpt: is the heading written by this record. The deadline is December 12.';
  const fixture=readFixture([{doc_uid:'records:schedule',text:content,total_chunks:1}]);
  const rows=await readDocumentEvidence(fixture.env,[{...retrievedRow(),snippet:content,source_excerpts:[content]}]);
  assert.ok(fixture.calls.some(call=>/FROM chunks/.test(call.sql)),'source read reached the populated fixture');
  assert.equal(rows[0].snippet,content,'purity comes from typed spans, never deleting matching source words');
  assert.equal(rows[0].read_complete,true);
});

test('N2 the 500-chunk boundary retains an out-of-page hit separately',async()=>{
  const chunks=Array.from({length:501},(_,i)=>({doc_uid:'records:schedule',chunk_ix:i,
    text:i===500 ? sourceTail : `Station ${i+1} checked storage shelves.`,total_chunks:501}));
  const fixture=readFixture(chunks);
  const rows=await readDocumentEvidence(fixture.env,[retrievedRow()]);
  assert.ok(fixture.calls.some(call=>/FROM chunks/.test(call.sql)));
  assert.equal(rows[0].read_complete,false);
  assert.match(rows[0].snippet,/Station 500 checked/);
  assert.doesNotMatch(rows[0].snippet,/December 12/);
  assert.deepEqual(rows[0].retrieval_excerpts,[sourceHead,sourceTail]);
  const answer=finalizeDocumentAnswer({question:'What is the crew booking deadline?',docs:rows,searchComplete:true});
  assert.match(answer.answer,/December 12/);
  assert.match(answer.answer,/additional retrieved excerpt/);
  assert.ok(answer.confidence.basis.some(reason=>/only partly read/.test(reason)));
});
