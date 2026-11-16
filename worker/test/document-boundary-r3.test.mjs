import { assertUnprovedDocument } from './helpers/doc-high-provenance.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { finalizeDocumentAnswer } from '../src/lib/document-answer.js';
import { filterThinkCandidates } from '../src/lib/think-candidate-policy.js';
import { moneyQuestionHandoff } from '../src/lib/money-handoff.js';
import { handleMcp } from '../src/lib/mcp-endpoint.js';
import { assertDocumentAnswer } from './helpers/document-answer-contract.mjs';
import { build, doc } from './fixtures/document-audit/cross-source-freshness/lib.mjs';

// R3 closes the R2 review findings with closed-world guards. Every red input
// from the review is kept verbatim, plus three new variants per guard.
const sources = [1,2,3].map(n => ({name:`records-${n}`,kind:'upload',lastIngestDaysAgo:0,sweepDaysAgo:0,expectedSeconds:86400}));
const approve = {supported:true,complete:true,evidence:[1,2,3],reason:'synthetic approval'};
const rows = (snippet, extra = {}) => [1,2,3].map(n => ({n,title:`Specification ${n}`,source:`records-${n}`,snippet,
  ts:'2026-11-11',date_reliable:true,text_source:'native',text_reliable:true,read_complete:true,
  authority:{tier:'T1',rank:1,eligible:true,authoritative:true},lineage:{status:'known',family_tokens:[`independent-${n}`]},...extra}));
const finalize = (snippet, draft, question = 'What capacity does the specification state?', more = []) => {
  const docs = [...rows(snippet), ...more];
  return finalizeDocumentAnswer({question,draft,docs,approvedDocs:docs.slice(0,3),checks:[approve],searchComplete:true});
};
const prose = body => body.answer.split('\n\nCoverage:')[0];
const contract = body => {
  assert.equal(typeof body.answer,'string');assert.ok(body.answer.trim(),'a non-empty answer');
  assert.ok(body.confidence && Number.isInteger(body.confidence.percent),'a confidence object');
  assert.equal(body.confidence.band,body.confidence.percent>=90?'High':body.confidence.percent>=70?'Medium':'Low');
  assert.ok(body.confidence.basis?.length && body.confidence.missing?.length,'reasons and missing evidence');
  assert.ok(body.answer_contract?.kind,'the answer contract');
  assert.match(body.confidence_text,/Confidence: (?:High|Medium|Low) \(\d+%\).*Why:.*Missing:/s);
  assert.match(body.answer,/Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
};

const capacity = 'The capacity is 250 units.';
const capacityDraft = 'The capacity is 250 units [1][2][3].';
const qualifiers = [
  // Review R2 B1 inputs, verbatim.
  'This claim has been disproven.', 'That claim has been retracted.', 'This figure is fictional.',
  // New variants: an elliptical verdict, an anaphoric verdict with no
  // lexicon word, and a later dated figure for the same field.
  'Satire.', 'Everything above is invented by the vendor.', 'On 2026-11-10 the capacity was set to 300 units.',
];
test('B1 exact-clause control: agreement retains the figure below High without provenance', () => {
  const body = finalize(capacity, capacityDraft);
  contract(body);
  assert.equal(body.answer_contract.rung,2);assertUnprovedDocument(body,capacity);
  assert.ok(prose(body).includes(capacity));
});
test('B1 positive control: a heading made of the record title is not a qualifier', () => {
  const body = finalize(`Specification. ${capacity}`, capacityDraft);
  contract(body);
  assert.equal(body.answer_contract.rung,2);assertUnprovedDocument(body,capacity);
  // R4 closed world: a sentence the claim does not consume is quoted with the
  // figure below High, even one that looks unrelated.
  const unrelated = finalize(`Specification. ${capacity} The housing is aluminum alloy.`, capacityDraft);
  contract(unrelated);
  assert.ok(unrelated.confidence.percent<90);assert.match(prose(unrelated),/The housing is aluminum alloy/);
});
for (const qualifier of qualifiers) test(`B1: a later qualification keeps the record's context below High: ${qualifier}`, () => {
  const body = finalize(`${capacity} ${qualifier}`, capacityDraft);
  contract(body);
  assert.notEqual(prose(body),capacityDraft,'the bare positive draft is not admitted');
  assert.match(prose(body),/the record "Specification \d" says:/,'rewritten as what the record says');
  assert.ok(prose(body).includes(qualifier),'the qualification is kept beside the figure');
  assert.ok(prose(body).includes('250 units'),'the figure itself is not dropped');
  assert.ok(body.confidence.percent<90,'never High');
  // The reason names the record by citation number; the qualification itself
  // is in the quoted source text above (explanation text quotes no source).
  assert.ok(body.confidence.basis.some(reason => /^Cited record [123] has (?:another sentence|\d+ other sentences) that (?:was|were) not checked against the claim/.test(reason)),'the reason names the doubt');
  assert.ok(!body.confidence.basis.some(reason => reason.includes(qualifier)),'the reason does not quote the source');
});
test('B1: an uncited record disputing the same field keeps the answer below High', () => {
  for (const [label, text, ts] of [['older dispute','The capacity figure of 250 units is disputed by the vendor.','2026-11-01'],['newer figure','The capacity is 300 units.','2026-11-12']]) {
    const extra = {n:4,title:'Vendor letter',source:'records-4',snippet:text,ts,date_reliable:true,text_source:'native',text_reliable:true,read_complete:true};
    const body = finalize(capacity, capacityDraft, undefined, [extra]);
    contract(body);
    assert.ok(body.confidence.percent<90,label);
    assert.ok(prose(body).includes(text),`${label}: the disputing record is shown`);
    assert.ok(body.confidence.basis.some(reason => reason.startsWith(`Cited record 4 (${ts}) has a sentence on the same subject`)),`${label}: the reason names the doubt`);
    assert.ok(!body.confidence.basis.some(reason => reason.includes('Vendor letter') || reason.includes(text)),`${label}: the reason quotes no title or source text`);
  }
});
test('B1: the real route keeps disproven, retracted and fictional context below High', async () => {
  for (const [qualifier, positive] of [['',true],...qualifiers.slice(0,3).map(q => [q,false])]) {
    const h = await build({sources,docs:sources.map((s,i)=>doc(s.name,`record-${i}`,'Equipment contract',`${capacity}${qualifier ? ' '+qualifier : ''}`,1)),draft:capacityDraft,verdict:approve});
    try {
      const before = h.fixture.seen.sql.length;
      const r = await h.think('What capacity does the specification state?');
      assert.equal(r.http,200);contract(r.body);
      assert.ok(h.log.includes('verifier'),'the real verifier decision was reached');
      assert.ok(h.fixture.seen.sql.slice(before).some(sql => sql.includes('LIMIT 501')),'the full-record read was reached');
      if (positive) {assert.equal(r.body.answer_contract.rung,2);assertUnprovedDocument(r.body,capacity);}
      else {assert.ok(prose(r.body).includes(qualifier));assert.match(prose(r.body),/says:/);assert.ok(r.body.confidence.percent<90);}
    } finally {h.close();}
  }
});

// B4: a draft may never change a figure's digits or its unit, including SI
// prefix case. The first pair is the review's exact input.
const unitCases = [
  ['What output power does the equipment specification state?','The output power is 250 mW.','The output power is 250 MW [1][2][3].','250 MW'],
  ['What link speed does the equipment specification state?','The link speed is 100 Mb/s.','The link speed is 100 MB/s [1][2][3].','100 MB/s'],
  ['What resistance does the equipment specification state?','The contact resistance is 10 mΩ.','The contact resistance is 10 MΩ [1][2][3].','10 MΩ'],
  ['What mass does the equipment specification state?','The shipping mass is 250 g.','The shipping mass is 250 kg [1][2][3].','250 kg'],
];
for (const [question, source, draft, changed] of unitCases) test(`B4: the source unit survives an approved changed draft: ${changed}`, () => {
  const control = finalize(source, draft.replace(changed, source.match(/\d+ \S+?(?=\.$)/)[0]), question);
  assert.equal(control.answer_contract.rung,2,'the identical unit is quoted with unproved applicability');assertUnprovedDocument(control,source);
  const body = finalize(source, draft, question);
  contract(body);
  assert.doesNotMatch(body.answer,new RegExp(changed.replace(/[.*+?^${}()|[\]\\/]/g,'\\$&')),'the changed figure never reaches the owner');
  assert.ok(prose(body).includes(source.replace(/\.$/,'')),'the exact source figure and unit are quoted');
  assert.ok(body.confidence.percent<90);
  assert.ok(body.confidence.basis.some(reason => /figure|unit/i.test(reason)),'the reason names the changed figure');
});
test('B4: the real route quotes 250 mW when an approved draft says 250 MW', async () => {
  for (const [draft, positive] of [['The output power is 250 mW [1][2][3].',true],['The output power is 250 MW [1][2][3].',false]]) {
    const h = await build({sources,docs:sources.map((s,i)=>doc(s.name,`record-${i}`,'Equipment contract','The output power is 250 mW.',1)),draft,verdict:approve});
    try {
      const r = await h.think('What output power does the equipment specification state?');
      assert.equal(r.http,200);contract(r.body);assert.ok(h.log.includes('verifier'));
      assert.match(r.body.answer,/250 mW/);assert.doesNotMatch(r.body.answer,/250 MW/);
      if (positive) assertUnprovedDocument(r.body,'250 mW'); else assert.ok(r.body.confidence.percent<90);
    } finally {h.close();}
  }
});

// B2: the think route's outermost boundary finalizes every response for a
// question, including returned scope failures and validation responses.
const scopeSources = [{name:'records',kind:'upload',lastIngestDaysAgo:0,sweepDaysAgo:0,expectedSeconds:86400}];
async function scoped(fn) {
  const h = await build({sources:scopeSources,docs:[doc('records','memo','Vendor review memo','The review is November 13.',1)],draft:'The review is November 13 [1].'});
  try {
    h.fixture.raw("INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at) VALUES ('store','Synthetic store','business','owned','owner_stated','confirmed','2026-11-12')");
    h.fixture.raw("INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at) VALUES ('buyer','Synthetic buyer','business','counterparty','owner_stated','confirmed','2026-11-12')");
    h.fixture.raw("UPDATE documents SET entity_slug='store'");
    return await fn(h);
  } finally {h.close();}
}
const failScopeRead = h => {
  let reached = 0;
  const prepare = h.fixture.env.DB.prepare.bind(h.fixture.env.DB);
  h.fixture.env.DB.prepare = sql => {
    const statement = prepare(sql);
    if (!/SELECT entity_slug, legal_name, display_label, status, relationship/.test(sql)) return statement;
    const wrap = s => ({...s,bind:(...args)=>wrap(s.bind(...args)),first:async()=>{reached++;throw new Error('synthetic scope read unavailable');}});
    return wrap(statement);
  };
  return () => reached;
};
test('B2: a returned scope-read failure is finalized as an incomplete answer without broadening the search', async () => {
  await scoped(async h => {
    const healthy = await h.think('When is the vendor review?',{entity_slug:'store'});
    assert.equal(healthy.http,200);contract(healthy.body);assert.match(healthy.body.answer,/November 13/);
    const reached = failScopeRead(h);
    const before = h.fixture.seen.sql.length;
    const r = await h.think('When is the vendor review?',{entity_slug:'store'});
    assert.ok(reached()>0,'the actual owned-scope decision was reached');
    assert.equal(r.http,200);contract(r.body);
    assert.ok(r.body.confidence.percent<=10);
    assert.equal(r.body.code,'entity_scope_unavailable','the operational cause stays visible');
    assert.equal(r.body.error,undefined,'an incomplete reading is not an error reply');
    assert.doesNotMatch(r.body.answer,/November 13|synthetic scope read/,'no unscoped document text and no raw exception');
    assert.equal(h.fixture.seen.sql.slice(before).some(sql => /FROM chunks_fts/.test(sql)),false,'the search is never broadened around the failure');
    assert.match(r.body.answer,/scope/i);
  });
});
test('B2: scope and parameter validation responses keep their status and code and still answer', async () => {
  await scoped(async h => {
    for (const [params, status, code] of [
      [{entity_slug:'INVALID!'},400,'invalid_entity_slug'],
      [{entity_slug:'not-recorded'},404,'entity_not_found'],
      [{entity_slug:'buyer'},403,'entity_not_owned'],
      [{entity_slug:'store',client:'other'},409,'conflicting_business_scope'],
      [{role:'owner'},400,'unsupported_retrieval_parameter'],
      [{from:'2025-12-31',to:'2025-01-01'},400,'reversed_date_range'],
    ]) {
      const before = h.fixture.seen.sql.length;
      const r = await h.think('When is the vendor review?',params);
      assert.equal(r.http,status,code);assert.equal(r.body.code,code);contract(r.body);
      assert.ok(r.body.confidence.percent<=10,code);
      assert.doesNotMatch(r.body.answer,/November 13/,code);
      assert.equal(h.fixture.seen.sql.slice(before).some(sql => /FROM chunks/.test(sql)),false,`${code}: no records are read`);
    }
  });
});
test('B2: a failure injected at every database read, the vector index and the models still answers', async () => {
  await scoped(async h => {
    const prepare = h.fixture.env.DB.prepare.bind(h.fixture.env.DB);
    let count = 0, failAt = -1, failed = 0;
    const reachedSql = [];
    h.fixture.env.DB.prepare = sql => {
      const statement = prepare(sql);
      const wrap = s => {
        const step = async (method, args) => {
          const index = count++;
          reachedSql[index] = sql;
          if (index === failAt) {failed++;throw new Error('synthetic injected read failure');}
          return s[method](...args);
        };
        return {...s,bind:(...args)=>wrap(s.bind(...args)),all:(...a)=>step('all',a),first:(...a)=>step('first',a),run:(...a)=>step('run',a),raw:(...a)=>step('raw',a)};
      };
      return wrap(statement);
    };
    const ask = async label => {
      const r = await h.think('When is the vendor review?',{entity_slug:'store'});
      assert.ok([200].includes(r.http),`${label}: HTTP ${r.http} ${JSON.stringify(r.body).slice(0,300)}`);
      contract(r.body);
      assert.doesNotMatch(r.body.answer,/synthetic injected/,`${label}: no raw exception text`);
      return r;
    };
    count = 0; failAt = -1;
    const healthy = await ask('healthy');
    assert.match(healthy.body.answer,/November 13/);
    const total = count;
    assert.ok(total>=5,`the healthy route performs several reads (${total})`);
    const healthySql = reachedSql.slice(0,total).join('\n');
    for (const table of [/FROM fin_entities/,/FROM chunks/,/FROM sources/,/LIMIT 501/]) assert.match(healthySql,table,'the walk covers scope, retrieval, full-record and coverage reads');
    // Walk every read the route reaches: fail read k, then k+1, until a run
    // completes without reaching the injected index. Earlier failures can
    // shorten a run, so the walk stops only when no read k exists.
    let walked = 0;
    for (let k = 0; ; k++) {
      count = 0; failAt = k; failed = 0;
      await ask(`read ${k}`);
      if (!failed) break;
      walked++;
    }
    assert.ok(walked>=total-1,`every read the healthy route makes was failed in turn (${walked} of ${total})`);
    failAt = -1;
    const query = h.fixture.env.VECTORIZE.query;
    h.fixture.env.VECTORIZE.query = async () => {throw new Error('synthetic injected vector failure');};
    await ask('vector index');
    h.fixture.env.VECTORIZE.query = query;
    const run = h.fixture.env.AI.run;
    h.fixture.env.AI.run = async (model, input) => {
      if (String(model).includes('bge-')) throw new Error('synthetic injected embedding failure');
      return run(model, input);
    };
    await ask('embedding model');
    h.fixture.env.AI.run = async () => {throw new Error('synthetic injected model failure');};
    const model = await ask('answer model');
    assert.match(model.body.answer,/November 13/,'the screened record survives a model outage');
    h.fixture.env.AI.run = run;
  });
});

test('B2: every think call site goes through the one response post-condition', () => {
  const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const wrapper = source.slice(source.indexOf('async function handleThink(env, request, ...rest) {'), source.indexOf('async function handleThinkRoute('));
  assert.ok(wrapper.includes('finalizeThinkResponse(response, question)'),'the wrapper finalizes the route response');
  const outside = source.replace(wrapper,'');
  assert.equal([...outside.matchAll(/handleThinkRoute\(/g)].length,1,'only the declaration exists outside the wrapper');
  assert.ok([...outside.matchAll(/await handleThink\(env,/g)].length>=2,'the router and the remote connector call the wrapper');
});

// M1: tax filing headers after any preamble in the opening lines stay screened.
const filing = 'Department of the Treasury. Internal Revenue Service. Form 1040. Filing status: single. Wages: $56000.';
const ocr = '[OCR] The text below was read from a scanned image by a machine, not from a text layer in the file. It can be wrong, and figures especially can be wrong.';
const filingVariants = [
  ocr + ' ' + filing,
  ocr + '\n[[page 1: could not be read]]\nForm W-2 Wage and Tax Statement 2025\nWages: $56000.',
  'Taxpayer copy\nPrepared for the owner on 2026-01-15\nForm 1040 U.S. Individual Income Tax Return 2025\nWages: $56000.',
  '[Scanned upload]\nArchive box 4\nSchedule K-1 (Form 1065) 2025\nOrdinary business income: $56000.',
];
test('M1: filing headers after OCR, page and agency preambles are screened; incidental and requested forms remain readable', () => {
  const note = {title:'Advisor memo',snippet:'Prepare the review packet. The advisor may request Form 1040 later.'};
  for (const snippet of filingVariants) {
    const row = {title:'Annual archive',snippet};
    const policy = filterThinkCandidates([row,note],{question:'What does the annual archive contain?'});
    assert.equal(policy.withheld?.examined_count,2,'both records reached the policy');
    assert.deepEqual(policy.rows,[note],snippet.slice(0,60));
    const form = /Form W-2/.test(snippet) ? 'W-2' : /K-1/.test(snippet) ? 'Schedule K-1' : 'Form 1040';
    assert.deepEqual(filterThinkCandidates([row],{question:`What is on my ${form}?`}).rows,[row],'an explicitly requested form stays readable');
  }
  const late = {title:'Long memo',snippet:Array.from({length:30},(_,i)=>`Background item ${i+1} for the review.`).join('\n')+'\nForm 1040 is mentioned here only as a later example.'};
  assert.deepEqual(filterThinkCandidates([late],{question:'What does the long memo contain?'}).rows,[late],'a mention far past the opening lines is not a header');
});
test('M1: the real route screens the OCR-prefixed filing and keeps correspondence', async () => {
  for (const [content, screened, textSource] of [[ocr+' '+filing,true,'ocr'],[filing,true,'native'],['The advisor may request Form 1040 later.',false,'native']]) {
    const h = await build({sources:scopeSources,docs:[doc('records','archive','Annual archive',content,1,{textSource})],draft:screened?'Wages: $56000 [1].':'The advisor may request Form 1040 later [1].'});
    try {
      const search = await h.unified('What does the annual archive contain?');
      assert.ok(search.body.results.length,'real retrieval found the record');
      const r = await h.think('What does the annual archive contain?');
      assert.equal(r.http,200);contract(r.body);
      if (screened) {assert.equal(r.body.withheld_documents?.count,1);assert.doesNotMatch(r.body.answer,/56000/);}
      else {assert.equal(r.body.withheld_documents,undefined);assert.match(r.body.answer,/advisor may request/);}
    } finally {h.close();}
  }
});

// M2: the oracle consumes the whole response, including every contract line.
test('M2: the money oracle rejects an extra figure anywhere in the response', () => {
  const snippet = 'Payer North charged USD 120.00 for October on card ending 4242.';
  const docs = rows(snippet).slice(0,1);
  const body = {...finalizeDocumentAnswer({question:'What charge is recorded?',docs,checks:[{supported:false,complete:false,reason:'payment unverified'}],searchComplete:true}),results:docs};
  const options = {expected:snippet,provisional:true};
  assertDocumentAnswer(body,options);
  const extra = 'You paid USD 999.00 [1].';
  const mutations = [
    body.answer + '\n' + extra,                                          // review R2 M2 input, verbatim
    body.answer.replace(/(\nCoverage: [^\n]*)/, `$1 ${extra}`),          // inside Coverage
    body.answer.replace(/(\nMissing or counted twice: )/, `$1${extra} `), // inside Missing
    body.answer.replace(/\nEstimates: [^\n]*/, '\nEstimates: You owe USD 999.00.'),
    body.answer + '\nTotal paid: $999.',
  ];
  for (const answer of mutations) {
    assert.notEqual(answer,body.answer,'the mutation is present');
    assert.throws(()=>assertDocumentAnswer({...body,answer},options),assert.AssertionError,answer.slice(-80));
  }
  const accepted = finalizeDocumentAnswer({question:'What charge is recorded?',draft:'Payer North charged USD 120.00 for October on card ending 4242 [1].',docs,approvedDocs:docs,checks:[approve],searchComplete:true});
  const exact = {...accepted,results:docs};
  assertDocumentAnswer(exact,{expected:'Payer North charged USD 120.00 for October on card ending 4242 [1].',exact:true});
  assert.throws(()=>assertDocumentAnswer({...exact,answer:exact.answer.replace('\n\nCoverage:',' You paid USD 120.00 [1].\n\nCoverage:')},
    {expected:'Payer North charged USD 120.00 for October on card ending 4242 [1].',exact:true}),assert.AssertionError,'exact mode rejects a same-amount extra claim');
});

// M3: invoice and bill payment questions take the bank-tool handoff.
test('M3: invoice payment, debt and outstanding questions take the bank handoff; document terms stay documents', async () => {
  const bank = ['Have I paid this invoice?','Do I owe anything on this invoice?', // review R2 M3 inputs
    'Is this invoice still outstanding?','Has the electric bill been paid?','Is anything unpaid on the utility bill?',
    'Did I pay this invoice?','How much do I owe on this invoice?',
    // R4: an owed question stays bank-first even when it names a lease
    // (founder rule: paid, spent and owed are bank-first). The main-clause
    // record-terms form below remains a document question.
    'What do I owe under the lease?'];
  const documents = ['What rent does the lease state?','What amount due does the invoice state?','Who issued this invoice?',
    'Have I paid the QuickBooks bill?','How many paid holidays does the handbook give?','What does the lease say I owe each month?'];
  for (const q of [...bank,...documents]) {
    let reads = 0;
    const url = new URL('https://fixture.invalid/mcp');
    const body = {mode:'think',...finalizeDocumentAnswer({question:q,docs:[],searchComplete:true}),results:[]};
    const reply = await (await handleMcp({},new Request(url,{method:'POST',body:JSON.stringify({id:1,method:'tools/call',params:{name:'ask',arguments:{question:q}}})}),url,
      {grant:{profile:'librarian'},think:async()=>{reads++;return body;}})).json();
    const answer = reply.result?.content?.[0]?.text;
    assert.ok(answer?.trim(),`${q}: the assistant gets an answer`);
    if (bank.includes(q)) {
      assert.equal(moneyQuestionHandoff(q)?.money_handoff,true,q);
      assert.equal(reads,0,`${q}: bank-first, no document think`);
      assert.match(answer,/brain_money_overview/,q);
      const handoff = moneyQuestionHandoff(q);
      assert.match(handoff.confidence_text,/Confidence: Low \(0%\)[\s\S]*Missing:/,'the handoff still carries its score');
      assert.equal(handoff.confidence.percent,0);assert.ok(handoff.confidence.basis.length && handoff.confidence.missing.length);
    } else {
      assert.equal(moneyQuestionHandoff(q),null,q);
      assert.equal(reads,1,`${q}: the document reader answers`);
    }
  }
});
test('M3/MF1: a human caller asking an invoice payment question keeps the Worker reader and gets a scored answer', async () => {
  const h = await build({sources:scopeSources,docs:[doc('records','invoice','Invoice 1042','Invoice 1042 total is USD 120.00.',1)],draft:'Invoice 1042 total is USD 120.00 [1].'});
  try {
    for (const q of ['Have I paid this invoice?','Do I owe anything on this invoice?']) {
      const r = await h.think(q);
      assert.equal(r.http,200);contract(r.body);
      assert.doesNotMatch(r.body.answer,/brain_money_overview first/,'human callers are not handed assistant tool instructions');
      assert.ok(r.body.confidence.percent<90,'a document total never proves payment');
    }
  } finally {h.close();}
});
