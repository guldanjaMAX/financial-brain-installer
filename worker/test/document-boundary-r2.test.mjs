import { assertUnprovedDocument } from './helpers/doc-high-provenance.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeDocumentAnswer } from '../src/lib/document-answer.js';
import { filterThinkCandidates } from '../src/lib/think-candidate-policy.js';
import { assertDocumentAnswer } from './helpers/document-answer-contract.mjs';
import { build, doc } from './fixtures/document-audit/cross-source-freshness/lib.mjs';

const sources = [{name:'records',kind:'upload',lastIngestDaysAgo:0,sweepDaysAgo:0,expectedSeconds:86400}];
const approve = {supported:true,complete:true,evidence:[1,2,3],reason:'synthetic approval'};
const positive = 'The capacity is 250 units.';
const draft = 'The capacity is 250 units [1][2][3].';
const rows = snippet => [1,2,3].map(n => ({n,title:`Specification ${n}`,source:`records-${n}`,snippet,
  ts:'2026-11-11',date_reliable:true,text_source:'native',text_reliable:true,read_complete:true,
  authority:{tier:'T1',rank:1,eligible:true,authoritative:true},lineage:{status:'known',family_tokens:[`independent-${n}`]}}));
const finalize = snippet => {
  const docs = rows(snippet);
  return finalizeDocumentAnswer({question:'What capacity does the specification state?',draft,docs,approvedDocs:docs,checks:[approve],searchComplete:true});
};
const contract = body => {
  assert.ok(body.answer?.trim());
  assert.equal(body.error,undefined);
  assert.equal(body.answer_contract?.kind,'document');
  assert.match(body.confidence_text,/Confidence: (High|Medium|Low) \(\d+%\).*Why:.*Missing:/s);
  assert.match(body.answer,/Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
};

for (const snippet of [
  'It is false that the capacity is 250 units.',
  'The rejected claim was: The capacity is 250 units.',
  'The capacity is 250 units is not correct.',
  'The capacity is 250 units is no longer accurate.',
  'The capacity is 250 units only if the upgrade is approved.',
  'The following claim was rejected. The capacity is 250 units.',
  'The capacity is 250 units. This claim is false.',
  'The following claim was rejected. Background context remains. The capacity is 250 units.',
  'These values are not approved. Background context remains. The capacity is 250 units.',
  'The capacity is 250 units. This claim is wrong.',
  'Never use this claim. The capacity is 250 units.',
]) test(`B1: preserve context: ${snippet}`, () => {
  const control = finalize(positive);
  assert.equal(control.answer_contract.rung,2,'exact quotation does not prove governing applicability');
  assertUnprovedDocument(control,positive);
  const body = finalize(snippet);
  contract(body);
  assert.match(body.answer,/says:/,'the populated statement reaches attribution');
  assert.ok(body.answer.includes(snippet),'the whole contextual statement survives');
  assert.notEqual(body.answer.split('\n\nCoverage:')[0],draft);
  assert.ok(body.confidence.percent<90);
});

test('B1: a false checker approval cannot turn a negated source into a High route answer', async () => {
  for (const [snippet,negative] of [[positive,false],['It is false that the capacity is 250 units.',true]]) {
    const h = await build({sources:[1,2,3].map(n=>({...sources[0],name:`records-${n}`})),
      docs:[1,2,3].map(n=>doc(`records-${n}`,`spec-${n}`,'Equipment contract',snippet,1)),draft,verdict:approve});
    try {
      const r = await h.think('What capacity does the specification state?');
      assert.equal(r.http,200);assert.ok(h.log.includes('verifier'),'real verifier reached');contract(r.body);
      if (negative) {assert.match(r.body.answer,/says:.*It is false/);assert.ok(r.body.confidence.percent<90);}
      else {assert.equal(r.body.answer_contract.rung,2);assertUnprovedDocument(r.body,positive);}
    } finally {h.close();}
  }
});

test('B2: correction-store failures finalize an incomplete answer without bypassing integrity', async () => {
  for (const failure of [null,'keyword','correction','after-reading','answer-configuration']) {
    const h = await build({sources,docs:[doc('records','memo','Vendor review memo','The review is November 13.',1)],draft:'The review is November 13 [1].'});
    try {
      let decisions=0;
      if (failure==='answer-configuration') Object.defineProperty(h.fixture.env,'ANSWER_MODEL',{get(){
        decisions++;throw new Error('synthetic answer configuration unavailable');
      }});
      const prepare = h.fixture.env.DB.prepare.bind(h.fixture.env.DB);
      h.fixture.env.DB.prepare = sql => {
        if (failure && failure!=='answer-configuration' && (failure==='correction' ? /memory_supersessions/i.test(sql) : failure==='keyword' ? /FROM chunks_fts/i.test(sql) : /FROM sources/i.test(sql))) {
          const fail = async () => {decisions++;throw new Error(failure==='correction'?'no such table: memory_supersessions':'synthetic read unavailable');};
          const wrap = statement => ({...statement,all:fail,first:fail,bind:(...args)=>wrap(statement.bind(...args))});
          return wrap(prepare(sql));
        }
        return prepare(sql);
      };
      const r = await h.think('When is the vendor review?');
      if (failure) assert.ok(decisions>0,'the failing read was reached');
      assert.equal(r.http,200);contract(r.body);
      if (failure==='correction') {
        assert.equal(r.body.answer_contract.rung,4);
        assert.equal(r.body.results.length,0,'unverified correction content stays out');
        assert.doesNotMatch(r.body.answer,/November 13|memory_supersessions|synthetic read/);
        assert.ok(r.body.confidence.percent<=10);
        assert.match(r.body.answer,/search is incomplete/i);
      } else {
        assert.match(r.body.answer,/November 13/,'safe available evidence remains');
        if (failure==='answer-configuration') {
          assert.ok(r.body.results.length,'screened source evidence survives a later exception');
          assert.ok(r.body.confidence.percent<=10);assert.match(r.body.confidence_text,/search or answer processing did not complete/);
        }
      }
    } finally {h.close();}
  }
});

test('B3: a bounded full-record read retains a figure already found in chunk 501', async () => {
  for (const total of [500,501]) {
    const h = await build({sources,docs:[doc('records','manual','Equipment manual','Background information.',1)],draft:'The maximum capacity is 4321 units [1].'});
    try {
      const original = h.fixture.first('SELECT * FROM chunks LIMIT 1');
      const cols = Object.keys(original).filter(k=>k!=='id');
      for (let i=1;i<total;i++) {
        const row={...original,chunk_uid:`${original.doc_uid}#${i}`,chunk_ix:i,text:i===total-1?'The maximum capacity is 4321 units.':'Background information.'};
        h.fixture.raw(`INSERT INTO chunks (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`,...cols.map(k=>row[k]));
      }
      h.fixture.raw('UPDATE install_state SET vector_projection_bootstrap_base_count=? WHERE id=1',total);
      h.fixture.env.VECTORIZE.describe=async()=>({vectorCount:total,processedUpToMutation:null});
      h.fixture.env.VECTORIZE.query=async()=>({matches:[{id:`${original.doc_uid}#${total-1}`,score:1}]});
      const search=await h.unified('What is the maximum capacity?');
      assert.ok(search.body.results.some(r=>r.snippet.includes('4321')),'real retrieval found the figure');
      const before=h.fixture.seen.sql.length;
      const r=await h.think('What is the maximum capacity?');
      assert.ok(h.fixture.seen.sql.slice(before).some(sql=>sql.includes('LIMIT 501')),'bounded read reached');
      assert.equal(r.http,200);contract(r.body);assert.match(r.body.answer,/4321 units/);
      if(total===501) {assert.ok(r.body.confidence.percent<90);assert.match(r.body.confidence.basis.join(' '),/partly read/);}
    } finally {h.close();}
  }
});

test('M1: filing headers after agency preambles are screened while correspondence remains readable', async () => {
  const filing='Department of the Treasury. Internal Revenue Service. Form 1040. Filing status: single. Wages: $56000.';
  const note={title:'Advisor memo',snippet:'Prepare the review packet. The advisor may request Form 1040 later.'};
  for (const snippet of [filing,filing.replaceAll('. ','\n'),'Department of the Treasury Internal Revenue Service 2025 Form 1040. Wages: $56000.']) {
    const row={title:'Annual archive',snippet};
    const policy=filterThinkCandidates([row,note],{question:'What does the annual archive contain?'});
    assert.equal(policy.withheld?.examined_count,2,'both populated records reached policy');
    assert.deepEqual(policy.rows,[note]);assert.equal(policy.withheld.count,1);
    assert.deepEqual(filterThinkCandidates([row],{question:'What is on my Form 1040?'}).rows,[row]);
  }
  for (const [content,screened] of [[filing,true],[note.snippet,false]]) {
    const h=await build({sources,docs:[doc('records','archive','Annual archive',content,1)],draft:screened?'Wages: $56000 [1].':'The advisor may request Form 1040 later [1].'});
    try {
      const search=await h.unified('What does the annual archive contain?');
      assert.ok(search.body.results.length,'real retrieval reached the populated record');
      const r=await h.think('What does the annual archive contain?');assert.equal(r.http,200);contract(r.body);
      if(screened) {assert.equal(r.body.withheld_documents.count,1);assert.doesNotMatch(r.body.answer,/56000/);}
      else {assert.equal(r.body.withheld_documents,undefined);assert.match(r.body.answer,/advisor may request/);}
    } finally {h.close();}
  }
});

test('M2: the money oracle rejects extra amounts and changed subject, currency, account or period', () => {
  const snippet='Payer North charged USD 120.00 for October on card ending 4242.';
  const docs=rows(snippet).slice(0,1);
  const body={...finalizeDocumentAnswer({question:'What charge is recorded?',docs,checks:[{supported:false,complete:false,reason:'payment unverified'}],searchComplete:true}),results:docs};
  const options={expected:snippet,provisional:true};
  assertDocumentAnswer(body,options);
  for (const extra of ['You paid USD 999.00 [1].','You paid USD 120.00 [1].','Payer South charged USD 120.00 [1].','Payer North charged CAD 120.00 [1].','Card ending 4343 charged USD 120.00 [1].','Payer North charged USD 120.00 in November [1].','The total is twenty dollars [1].','The total is twenty dollars.']) {
    const mutation={...body,answer:body.answer.replace('\n\nCoverage:',`\n${extra}\n\nCoverage:`)};
    assert.ok(mutation.answer.includes(extra),'the false statement reaches the oracle');
    assert.throws(()=>assertDocumentAnswer(mutation,options),assert.AssertionError);
  }
  for (const [from,to] of [['As of 2026-11-11','As of 2026-11-12'],['"Specification 1"','"You paid USD 999.00"'],['says: "Payer North','says: "You paid USD 999.00. Payer North']]) {
    const mutation={...body,answer:body.answer.replace(from,to)};
    assert.notEqual(mutation.answer,body.answer,'the attribution mutation is present');
    assert.throws(()=>assertDocumentAnswer(mutation,options),assert.AssertionError);
  }
});
