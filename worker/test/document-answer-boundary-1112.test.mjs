import { assertUnprovedDocument } from './helpers/doc-high-provenance.mjs';
import test from 'node:test';
import { answerResponseContractDiagnostic } from '../../acceptance.mjs';
import assert from 'node:assert/strict';
import { createProductFixture } from './product-contract-fixture.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { cmdAsk } from '../../brain.mjs';
import { finalizeDocumentAnswer } from '../src/lib/document-answer.js';
import { readOwnerDocumentPage } from '../src/lib/mcp-endpoint.js';
import { filterThinkCandidates } from '../src/lib/think-candidate-policy.js';
const NOW = Date.parse('2026-11-12T19:00:00Z');
const originalNow = Date.now;
const docs = (content, options = {}) => ({ source_type:'records', source_id:'memo', title:'Vendor review memo',
  content, occurred_at:'2026-11-10', date_source:'fixture:recorded_at', date_reliable:true,
  text_source:'native', text_reliable:true, metadata:{ evidence_lineage:{version:1,kind:'source_record'} }, ...options });
const approve = {supported:true,complete:true,evidence:[1],reason:'record support'};
const cases = [
  {id:'green',q:'When is the vendor review?',text:'The vendor review is November 13.',draft:'The vendor review is November 13 [1].',expect:/November 13/},
  {id:'checker rejection',q:'When is the vendor review?',text:'The vendor review is November 13.',draft:'The vendor review is November 13 [1].',verdict:{supported:false,complete:false,evidence:[],reason:'owner link missing'},expect:/November 13/},
  {id:'approved refusal',q:'When is the vendor review?',text:'The vendor review is November 13.',draft:'**I cannot disclose the review date.** [1]',expect:/November 13/},
  {id:'novel refusal',q:'When is the vendor review?',text:'The vendor review is November 13.',draft:'A reliable review date is unavailable [1].',expect:/November 13/},
  {id:'no citation',q:'When is the vendor review?',text:'The vendor review is November 13.',draft:'The vendor review is November 13.',expect:/November 13/},
  {id:'model failure',q:'When is the vendor review?',text:'The vendor review is November 13.',error:true,expect:/November 13/},
  {id:'unreadable checker',q:'When is the vendor review?',text:'The vendor review is November 13.',draft:'The vendor review is November 13 [1].',verdict:'unreadable',expect:/November 13/},
  {id:'document money',q:'How much is the rent in the office lease?',text:'Office lease: rent is $1,250.00 monthly.',title:'Office lease',draft:'Monthly rent is $1,250.00 [1].',expect:/\$1,250\.00/},
  {id:'outside time',q:'What did the vendor review say last week?',text:'The vendor review set delivery for November 13.',date:'2026-10-01',draft:'Delivery is November 13 [1].',expect:/November 13/},
  {id:'whole record',q:'What renewal code does the memo state?',text:'Background paragraph. '.repeat(80)+'The renewal code is 125000.',draft:(_,prompt)=>prompt.includes('125000')?'The renewal code is 125000 [1].':'The renewal code is 125 [1].',expect:/125000/},
  {id:'invented figure',q:'What price does the memo state?',text:'The quoted price is $1,250.00.',draft:'The price is $9,999.00 [1].',expect:/\$1,250\.00/,absent:/\$9,999/},
  {id:'empty completed search',q:'What did the vendor review say?',empty:true,expect:/Not found in 0 records/},
  {id:'tax assumption',q:'What is on my K-1?',title:'Owner K-1',text:'Schedule K-1 ordinary income is $2,450.',draft:'Ordinary income is $2,450 [1].',expect:/\$2,450/},
];
test('every document exit answers from the records actually read', async t => {
  Date.now = () => NOW;
  try {
    for (const c of cases) await t.test(c.id, async () => {
      const calls = {answer:0,check:0};
      const f = await createProductFixture({env:{BRAIN_OWNER:'Owner Example',BRAIN_TIMEZONE:'UTC', AI:{async run(model,input){
        if(String(model).includes('bge-'))return {data:[[0.1,0.2,0.3]]};
        const all=JSON.stringify(input.messages);
        if(all.includes('verify a proposed answer')){calls.check++;return {response:c.verdict??approve};}
        calls.answer++;if(c.error)throw new Error('fixture model failure');
        return {response:typeof c.draft==='function'?c.draft(0,all):c.draft};
      }}}});
      try {
        f.raw("INSERT INTO sources(name,kind,status,created_at,last_ingest_at,last_complete_sweep_at,expected_refresh_seconds) VALUES ('records','upload','ready',?,?,?,86400)",new Date(NOW).toISOString(),new Date(NOW).toISOString(),new Date(NOW).toISOString());
        if(!c.empty){const ingested=await f.post('/api/admin/brain/ingest/batch',{docs:[docs(c.text,{title:c.title??'Vendor review memo',occurred_at:c.date??'2026-11-10'})]},{'X-Admin-Key':f.env.ADMIN_KEY});assert.equal(ingested.status,200);}
        const res=await f.post('/api/rag/think',{q:c.q},{'X-Admin-Key':f.env.ADMIN_KEY});
        const body=await res.json();assert.equal(res.status,200);
        assert.ok(f.seen.sql.some(sql=>/chunks/i.test(sql)),'retrieval decision reached');
        if(!c.empty)assert.ok(calls.answer>0,'answer decision reached');
        assert.equal(typeof body.answer,'string');assert.ok(body.answer.trim());assert.match(body.answer,c.expect);
        assert.equal(answerResponseContractDiagnostic(body), null, 'acceptance validates the real owner response');
        if(c.absent)assert.doesNotMatch(body.answer,c.absent);
        assert.notEqual(body.status,'answer_withheld');assert.ok(body.confidence);
        assert.ok(['High','Medium','Low'].includes(body.confidence.band));
        assert.ok(body.confidence.basis.length);assert.ok(body.confidence.missing.length);
        if(c.id!=='green')assert.ok(body.confidence.percent<90);
        if(c.id==='checker rejection')assert.doesNotMatch(body.confidence.basis[0],/gate approved/,'a rejected draft cannot claim approved citations');
        assert.match(body.answer,/Coverage:/);assert.match(body.answer,/Missing or counted twice:/);assert.match(body.answer,/Estimates:/);assert.match(body.answer,/How to check:/);
      } finally { f.close(); }
    });
  } finally {Date.now=originalNow;}
});

test('local document-read route preserves the rest of a record and requires owner authorization', async () => {
  const f = await createProductFixture();
  try {
    f.raw("INSERT INTO sources(name,kind,status,created_at) VALUES ('records','upload','ready','2026-11-12T00:00:00Z')");
    const saved = await f.post('/api/admin/brain/ingest/batch',{docs:[docs('Background. '.repeat(300)+'Final renewal code is 125000.')]},{'X-Admin-Key':f.env.ADMIN_KEY});
    assert.equal(saved.status,200);
    const read = await f.post('/api/admin/brain/document-read',{id:'records:memo'},{'X-Admin-Key':f.env.ADMIN_KEY});
    const body = await read.json();
    assert.equal(read.status,200,'owner read reaches the route');
    assert.match(body.text,/125000/);assert.equal(body.page.complete,true);
    const denied = await f.post('/api/admin/brain/document-read',{id:'records:memo'});
    assert.equal(denied.status,401,'the same populated record stays owner-only');
  } finally {f.close();}
});

test('owner CLI prints the Worker score even when a check failed', async () => {
  const root = mkdtempSync(join(process.env.HOME,'document-cli-'));
  const manifest = join(root,'brain.manifest.json');
  writeFileSync(manifest,JSON.stringify({client:{slug:'fixture'},brain:{domain:'fixture.invalid'},infrastructure:{cloudflare:{account_id:'unused'}}}));
  const doc = {n:1,title:'Review memo',source:'records',snippet:'The review is November 13.',ts:'2026-11-10',date_reliable:true,text_reliable:true,text_source:'native',read_complete:true};
  const body = {...finalizeDocumentAnswer({question:'When is the review?',draft:'The review is November 13 [1].',docs:[doc],checks:[{supported:false,complete:false,reason:'Owner link missing.'}]}),
    evidence_gate:{supported:false,complete:false,reason:'Owner link missing.'},citations:[],gaps:[],status:'answered'};
  const lines=[], log=console.log;
  try {
    console.log=(...parts)=>lines.push(parts.join(' '));
    await cmdAsk(manifest,{ask:async ()=>'When is the review?',adminKey:randomBytes(24).toString('hex'),http:async()=>new Response(JSON.stringify(body))});
  } finally {console.log=log;rmSync(root,{recursive:true,force:true});}
  assert.match(lines.join('\n'),new RegExp(`Confidence: ${body.confidence.band} \\(${body.confidence.percent}%\\)`));
  assert.match(lines.join('\n'),/Why:.*Missing:/);
});

test('document reading screens legacy credential material with a populated readable control', async () => {
  const secret = ['sk','proj',randomBytes(32).toString('hex')].join('-');
  let reads=0, content='The renewal code is 125000.';
  const env={DB:{prepare(sql){return {bind(){return this;},async first(){return {doc_uid:'records:memo',source:'records',source_id:'memo',title:'Review memo',meta:'{}',text_source:'native',text_reliable:1};},async all(){reads++;return {results:[{text:content}]};}};}}};
  const good=await readOwnerDocumentPage(env,{id:'records:memo'},'https://fixture.invalid');
  assert.match(good.content[0].text,/125000/);assert.ok(reads>0);
  const before=reads;content='Legacy credential '+secret;
  const screened=await readOwnerDocumentPage(env,{id:'records:memo'},'https://fixture.invalid');
  assert.ok(reads>before,'the populated record reached the read decision');
  assert.equal(JSON.stringify(screened).includes(secret),false);
  assert.equal(screened.isError,undefined);
  assert.match(JSON.parse(screened.content[0].text).text,/screen|permitted/i);
});

test('an approved wrong figure written in words is replaced by the cited value', () => {
  const rows=[1,2,3].map(n=>({n,title:`Agreement ${n}`,source:`records-${n}`,snippet:'The notice period is sixty days.',ts:'2026-11-10',date_reliable:true,text_reliable:true,text_source:'native',read_complete:true,
    authority:{tier:'T1',rank:1,eligible:true,authoritative:true},lineage:{status:'known',family_tokens:[`family-${n}`]}}));
  const control=finalizeDocumentAnswer({question:'What is the notice period?',draft:'The notice period is sixty days [1][2][3].',docs:rows,approvedDocs:rows,checks:[approve],searchComplete:true});
  assert.match(control.answer,/sixty days/);assertUnprovedDocument(control,'sixty days');
  const wrong=finalizeDocumentAnswer({question:'What is the notice period?',draft:'The notice period is thirty days [1][2][3].',docs:rows,approvedDocs:rows,checks:[approve],searchComplete:true});
  assert.match(wrong.answer.split('Coverage:')[0],/sixty days/);
  assert.doesNotMatch(wrong.answer.split('Coverage:')[0],/thirty days/);
  assert.ok(wrong.confidence.percent<90);
});

test('the boundary defaults to incomplete and every rung has text, reasons and missing evidence', () => {
  const doc={n:1,title:'Review memo',source:'records',snippet:'The review is November 13.',ts:'2026-11-10',date_reliable:true,text_reliable:true,text_source:'native',read_complete:true};
  for(const reason of ['owner link','current status','money figure','future date','conflicting records','tax scope','unreadable checker']) {
    const out=finalizeDocumentAnswer({question:'When is the review?',draft:'The review is November 13 [1].',docs:[doc],approvedDocs:[doc],checks:[{supported:false,complete:false,reason}],searchComplete:true});
    assert.ok(out.answer.includes('November 13'));
    assert.ok(out.confidence.percent<=89);assert.ok(out.confidence.deductions.some(d=>d.reason.includes(reason)&&d.missing));
  }
  const incomplete=finalizeDocumentAnswer({question:'When is the review?',docs:[doc]});
  assert.ok(incomplete.confidence.percent<=10);assert.ok(incomplete.confidence.basis.some(r=>/did not complete/.test(r)));
  const empty=finalizeDocumentAnswer({question:'When is the review?',searchComplete:true});
  assert.match(empty.answer,/Not found in 0 records/);assert.ok(empty.confidence.percent<=30);
  const screened=finalizeDocumentAnswer({question:'When is the review?',retrievedCount:1,screenedCount:1,searchComplete:true});
  assert.doesNotMatch(screened.answer,/Not found in 0/);assert.match(screened.answer,/screen/);
  const handoff=finalizeDocumentAnswer({handoff:{answer:''}});assert.ok(handoff.answer.trim());
});

test('a filing header stays screened while an incidental form mention stays readable', () => {
  const filing={title:'Annual archive',snippet:'Form 1040. Ordinary income is 2450.'};
  const note={title:'Advisor memo',snippet:'Prepare the review packet. The advisor may request Form 1040 later.'};
  const read=filterThinkCandidates([filing,note],{question:'What did the advisor request?'});
  assert.equal(read.withheld?.examined_count,2,'both populated records reached screening');
  assert.equal(read.withheld?.count,1);assert.deepEqual(read.rows,[note]);
  const requested=filterThinkCandidates([filing],{question:'What is on my Form 1040?',taxQuestion:{applicable:true,resolved:false}});
  assert.deepEqual(requested.rows,[filing],'the named-form green control remains readable');
});
