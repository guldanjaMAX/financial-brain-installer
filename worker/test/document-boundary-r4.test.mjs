import { assertUnprovedDocument } from './helpers/doc-high-provenance.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeDocumentAnswer } from '../src/lib/document-answer.js';
import { filterThinkCandidates } from '../src/lib/think-candidate-policy.js';
import { moneyQuestionHandoff } from '../src/lib/money-handoff.js';
import { handleMcp } from '../src/lib/mcp-endpoint.js';
import { assertDocumentAnswer } from './helpers/document-answer-contract.mjs';
import { build, doc } from './fixtures/document-audit/cross-source-freshness/lib.mjs';

// R4 replaces word lists with closed-world rules. Every red input from both
// R3 reviews is kept verbatim. High (rung 1, 90+) now needs every cited record
// to be consumed by the claim: each sentence is an exact, case-sensitive claim
// clause or a heading of plain title words, the title is plain, and no uncited
// record is newer, same-day, undated or about the same field. Anything else is
// quoted as what the record says, below High.
const sources = [1,2,3].map(n => ({name:`records-${n}`,kind:'upload',lastIngestDaysAgo:0,sweepDaysAgo:0,expectedSeconds:86400}));
const approve = {supported:true,complete:true,evidence:[1,2,3],reason:'synthetic approval'};
const rows = (snippet, extra = {}) => [1,2,3].map(n => ({n,title:`Specification ${n}`,source:`records-${n}`,snippet,
  ts:'2026-11-11',date_reliable:true,text_source:'native',text_reliable:true,read_complete:true,
  authority:{tier:'T1',rank:1,eligible:true,authoritative:true},lineage:{status:'known',family_tokens:[`independent-${n}`]},...extra}));
const finalize = (snippet, draft, question = 'What capacity does the specification state?', more = [], title = null) => {
  const docs = [...rows(snippet).map(d => title ? {...d, title:title(d.n)} : d), ...more];
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
const routeDocs = (content, title = 'Equipment contract') => sources.map((s,i)=>doc(s.name,`record-${i}`,typeof title === 'function' ? title(i) : title,content,1));
async function route(docs, draft, question, check, extraSources = []) {
  const h = await build({sources:[...sources,...extraSources],docs,draft,verdict:approve});
  try {
    const before = h.fixture.seen.sql.length;
    const r = await h.think(question);
    assert.equal(r.http,200);contract(r.body);
    assert.ok(h.log.includes('verifier'),'the real verifier decision was reached');
    assert.ok(h.fixture.seen.sql.slice(before).some(sql => sql.includes('LIMIT 501')),'the full-record read was reached');
    check(r.body);
  } finally {h.close();}
}

// ---- B1: any unconsumed sentence or unplain title keeps the record's context ----
const pump = 'The pump capacity is 250 units.';
const pumpDraft = 'The pump capacity is 250 units [1][2][3].';
const pumpQ = 'What pump capacity does the equipment contract state?';
const capacity = 'The capacity is 250 units.';
const capacityDraft = 'The capacity is 250 units [1][2][3].';
const afterClaim = [
  // Review 1 F1, verbatim.
  'Field tests by our engineers disagree.', 'A lab retest measured far less.', 'Auditors found pump output overstated tenfold.',
  'La cifra fue retirada por el fabricante.', "Rev B doubles each pump's capacity.", "From 2026-11-10 each pump's capacity is 300 units.",
  // Review 2 R3-B1 (b) and its finalizer variants, verbatim.
  'The opening remark was a typo.', 'Vendor engineers labeled the opening remark bogus.', 'Lorem ipsum filler from the template vendor.',
];
const beforeClaim = ['Copied from a vendor brochure our engineers distrust.', 'Prank memo from the sales intern follows.'];
test('B1 exact-clause controls: full consumption alone leaves provenance unproved', () => {
  for (const [label, snippet, draft, question] of [
    ['single claim', pump, pumpDraft, pumpQ],
    ['heading of title words', `Specification. ${capacity}`, capacityDraft, undefined],
    ['two claim sentences', `${capacity} The housing is aluminum.`, `${capacityDraft.replace(' [1][2][3].','')} [1][2][3]. The housing is aluminum [1][2][3].`, undefined],
  ]) {
    const body = finalize(snippet, draft, question);
    contract(body);
    assert.equal(body.answer_contract.rung,2,label);assertUnprovedDocument(body,snippet);
    assert.ok(prose(body).includes(snippet),label);
  }
});
for (const qualifier of afterClaim) test(`B1: an unconsumed later sentence keeps the record's context below High: ${qualifier}`, () => {
  for (const [snippet, draft, question] of [[`${pump} ${qualifier}`, pumpDraft, pumpQ], [`${capacity} ${qualifier}`, capacityDraft, undefined]]) {
    const body = finalize(snippet, draft, question);
    contract(body);
    assert.notEqual(prose(body),draft,'the bare positive draft is not admitted');
    assert.match(prose(body),/the record "Specification \d" says:/,'rewritten as what the record says');
    assert.ok(prose(body).includes(qualifier),'the qualification is quoted beside the figure');
    assert.ok(prose(body).includes('250 units'),'the figure itself is not dropped');
    assert.ok(body.confidence.percent<90,'never High');
    // The reason names the record by citation number; the sentence itself is
    // in the quoted source text (explanation text quotes no source).
    assert.ok(body.confidence.basis.some(reason => /^Cited record [123] has (?:another sentence|\d+ other sentences) that (?:was|were) not checked against the claim/.test(reason)),'the reason names the unchecked sentence');
    assert.ok(!body.confidence.basis.some(reason => reason.includes(qualifier)),'the reason does not quote the source');
  }
});
for (const qualifier of beforeClaim) test(`B1: an unconsumed earlier sentence keeps the record's context below High: ${qualifier}`, () => {
  const body = finalize(`${qualifier} ${pump}`, pumpDraft, pumpQ);
  contract(body);
  assert.notEqual(prose(body),pumpDraft);
  assert.ok(prose(body).includes(qualifier),'the earlier qualification is quoted');
  assert.ok(prose(body).includes('250 units'));
  assert.ok(body.confidence.percent<90);
});
test('B1: a single record with an unconsumed sentence is quoted, not stated bare at Medium', () => {
  for (const snippet of [`${pump} Field tests by our engineers disagree.`, `${pump} From 2026-11-10 each pump's capacity is 300 units.`]) {
    const docs = rows(snippet).slice(0,1);
    const body = finalizeDocumentAnswer({question:pumpQ,draft:'The pump capacity is 250 units [1].',docs,approvedDocs:docs,checks:[approve],searchComplete:true});
    contract(body);
    assert.ok(prose(body).includes(snippet.split('. ')[1]),'the second sentence is shown');
    assert.ok(body.confidence.percent<90);
  }
});
test('B1: a title that is not plain keeps the title attribution below High', () => {
  for (const title of ['WITHDRAWN equipment contract','Superseded equipment contract','Rejected draft equipment contract','DRAFT specification']) {
    const body = finalize(capacity, capacityDraft, undefined, [], n => `${title} ${n}`);
    contract(body);
    assert.notEqual(prose(body),capacityDraft,title);
    assert.ok(prose(body).includes(`the record "${title} 1" says:`),`${title}: the title is shown`);
    assert.ok(body.confidence.percent<90,title);
    // The title is shown in the attribution above; the reason names its record.
    assert.ok(body.confidence.basis.some(reason => /^The title of cited record [123] has (?:a word that was|words that were) not checked against the claim\.$/.test(reason)),`${title}: the reason names the title`);
    assert.ok(!body.confidence.basis.some(reason => reason.includes(title)),`${title}: the reason does not quote the title`);
  }
  // Neutral record labels stay High. Question wording alone no longer
  // validates a non-neutral title, even when it explicitly names that record.
  const plain = finalize(capacity, capacityDraft, undefined, [], n => `Equipment contract ${n}`);
  assert.equal(plain.answer_contract.rung,2);assertUnprovedDocument(plain,capacity);
  const qualified = finalize(capacity, capacityDraft, 'What capacity does the withdrawn contract state?', [], n => `Withdrawn contract ${n}`);
  assert.equal(qualified.answer_contract.rung,2);assert.equal(qualified.confidence.percent,89);
  assert.match(prose(qualified),/the record "Withdrawn contract 1" says:/);
  assert.ok(prose(qualified).includes('250 units'),'the available figure remains answered with its title');
});
test('B1: the real route keeps unconsumed context, dates and titles below High', async () => {
  await route(routeDocs(pump), pumpDraft, pumpQ, body => {
    assert.equal(body.answer_contract.rung,2);assertUnprovedDocument(body,pump);
  });
  for (const qualifier of ['Field tests by our engineers disagree.', "Rev B doubles each pump's capacity."]) {
    await route(routeDocs(`${pump} ${qualifier}`), pumpDraft, pumpQ, body => {
      assert.ok(prose(body).includes(qualifier),qualifier);assert.match(prose(body),/says:/);assert.ok(body.confidence.percent<90,qualifier);
    });
  }
  for (const qualifier of ['Vendor postponed the session to December.', 'Acme moved the meeting to a later week.']) {
    await route(routeDocs(`The vendor review is on November 20. ${qualifier}`, 'Service contract'), 'The vendor review is on November 20 [1][2][3].', 'When is the vendor review?', body => {
      assert.ok(prose(body).includes(qualifier),qualifier);assert.ok(prose(body).includes('November 20'));assert.ok(body.confidence.percent<90,qualifier);
    });
  }
  for (const title of ['WITHDRAWN equipment contract','Superseded equipment contract']) {
    await route(routeDocs(capacity, title), capacityDraft, 'What capacity does the specification state?', body => {
      assert.ok(prose(body).includes(`"${title}"`),title);assert.ok(body.confidence.percent<90,title);
    });
  }
});

// ---- F2: an uncited record that is not older, or that names the field or the
// cited record, is shown and caps the score ----
const vendor = (snippet, ts) => ({n:4,title:'Vendor notice',source:'records-4',snippet,ts,date_reliable:true,text_source:'native',text_reliable:true,read_complete:true});
test('F2: uncited same-day, undated and older field-matching records are shown below High', () => {
  for (const [label, record] of [
    ['same-day plural', vendor('Corrected capacity for both pumps: 300 units.','2026-11-11')],
    ['same-day hyphen', vendor('The per-pump capacity was corrected to 300 units.','2026-11-11')],
    ['same-day withdrawal', vendor('The Equipment contract specification was withdrawn in full by the vendor.','2026-11-11')],
    ['undated', {...vendor('Corrected capacity for both pumps: 300 units.',''), ts:undefined}],
    ['older plural', vendor('Corrected capacity for both pumps: 300 units.','2026-11-01')],
    ['older names the record', {...vendor('The Specification 1 figures were withdrawn by the vendor.','2026-11-01')}],
  ]) {
    const body = finalize(pump, pumpDraft, pumpQ, [record]);
    contract(body);
    assert.ok(body.confidence.percent<90,label);
    assert.ok(prose(body).includes(record.snippet),`${label}: the uncited record is shown`);
    assert.ok(body.confidence.basis.some(reason => reason.startsWith('Cited record 4 (')),`${label}: the reason names it`);
    assert.ok(!body.confidence.basis.some(reason => reason.includes('Vendor notice')),`${label}: the reason does not quote its title`);
  }
  // An older record sharing two and at least half of the claim's field words.
  const fee = 'The monthly storage fee is $1,240.';
  const raised = finalize(fee, 'The monthly storage fee is $1,240 [1][2][3].', 'What is the monthly storage fee?', [vendor('Storage fees were raised to $1,400.','2026-11-01')]);
  contract(raised);
  assert.ok(raised.confidence.percent<90,'older head-term record');assert.ok(prose(raised).includes('Storage fees were raised to $1,400.'));
  const changed = finalize('The monthly fee is changed from $900 to $1,050.', 'The monthly fee is changed from $900 to $1,050 [1][2][3].', 'What is the monthly fee?', [vendor('The monthly fee is $900.','2025-01-15')]);
  contract(changed);
  assert.ok(prose(changed).includes('The monthly fee is $900.'),'an older record on the same field is shown even when the claim ends in a verb');
  const late = finalize(fee, 'The monthly storage fee is $1,240 [1][2][3].', 'What is the monthly storage fee?', [vendor('The late fee is $50.','2026-11-01')]);
  assert.equal(late.answer_contract.rung,2,'the source figure lacks governing-document proof');assertUnprovedDocument(late,fee);
  // Control: an older uncited record about another field leaves High intact.
  const control = finalize(pump, pumpDraft, pumpQ, [vendor('The housing is painted blue.','2026-11-01')]);
  assert.equal(control.answer_contract.rung,2);assertUnprovedDocument(control,pump);
});
test('F2: the real route shows a same-day uncited withdrawal and correction', async () => {
  for (const text of ['The Equipment contract specification was withdrawn in full by the vendor.', 'Corrected capacity for both pumps: 300 units.']) {
    const docs = [...routeDocs(pump), doc('records-4','extra-0','Vendor notice',text,1)];
    await route(docs, pumpDraft, pumpQ, body => {
      assert.ok(prose(body).includes(text),text);assert.ok(body.confidence.percent<90,text);
    }, [{name:'records-4',kind:'upload',lastIngestDaysAgo:0,sweepDaysAgo:0,expectedSeconds:86400}]);
  }
});

// ---- F3/B4: the whole clause is compared case-sensitively ----
const unitCases = [
  ['What concentration does the equipment contract state?','The concentration is 5 mg per mL.','The concentration is 5 mg per ML [1][2][3].','per ML'],
  ['What output power does the equipment specification state?','The output power is 250 (typical) mW.','The output power is 250 (typical) MW [1][2][3].','(typical) MW'],
  ['What link speed does the equipment specification state?','The link speed is 100 (max) Mb/s.','The link speed is 100 (max) MB/s [1][2][3].','(max) MB/s'],
  ['What rated power does the specification state?','The rated power in mW is 250.','The rated power in MW is 250 [1][2][3].','in MW'],
  ['What hazard class does the specification state?','The hazard class is Co.','The hazard class is CO [1][2][3].','class is CO'],
  ['What output power does the equipment specification state?','The output power is 250 nominal mW.','The output power is 250 nominal MW [1][2][3].','nominal MW'],
  ['What dose does the specification state?','The dose is 5 mg per kg.','The dose is 5 mg per Kg [1][2][3].','per Kg'],
];
for (const [question, source, draft, changed] of unitCases) test(`F3: a case change anywhere in the clause never reaches the owner: ${changed}`, () => {
  const control = finalize(source, `${source.replace(/\.$/,'')} [1][2][3].`, question);
  if (/\d/.test(source)) {assert.equal(control.answer_contract.rung,2);assertUnprovedDocument(control,source);}
  else {assert.equal(control.answer_contract.rung,1);assert.ok(control.confidence.percent>=90);}
  const body = finalize(source, draft, question);
  contract(body);
  assert.equal(body.answer.includes(changed),false,'the changed clause never reaches the owner');
  assert.ok(prose(body).includes(source),'the exact source clause is quoted');
  assert.ok(body.confidence.percent<90);
});
test('F3: the real route quotes mL when an approved draft says ML', async () => {
  await route(routeDocs('The concentration is 5 mg per mL.'), 'The concentration is 5 mg per ML [1][2][3].', 'What concentration does the equipment contract state?', body => {
    assert.match(body.answer,/5 mg per mL/);assert.doesNotMatch(body.answer,/per ML/);assert.ok(body.confidence.percent<90);
  });
});

// ---- F4: a scale header is never dropped ----
test('F4: a table scale header stays beside the figure below High', async () => {
  for (const [snippet, draft] of [['Table values in thousands. Pump capacity: 250.','Pump capacity: 250 [1][2][3].'],['Table values in thousands\nPump capacity: 250','Pump capacity: 250 [1][2][3].']]) {
    const body = finalize(snippet, draft, pumpQ);
    contract(body);
    assert.match(prose(body),/thousands/);assert.ok(body.confidence.percent<90);
  }
  await route(routeDocs('Table values in thousands. Pump capacity: 250.'), 'Pump capacity: 250 [1][2][3].', pumpQ, body => {
    assert.match(prose(body),/Table values in thousands/);assert.ok(body.confidence.percent<90);
  });
});

// ---- F5: a citation marker inside a figure is never admitted ----
test('F5: only sentence-end citations are accepted', async () => {
  const body = finalize('The pump capacity is 2500 units.', 'The pump capacity is 250[1]0 units [1][2][3].', pumpQ);
  contract(body);
  assert.equal(body.answer.includes('250[1]0'),false);assert.match(prose(body),/2500 units/);assert.ok(body.confidence.percent<90);
  const control = finalize('The pump capacity is 2500 units.', 'The pump capacity is 2500 units. [1][2][3]', pumpQ);
  assert.equal(control.answer_contract.rung,2,'a valid sentence-end citation still lacks governing applicability');
  assertUnprovedDocument(control,'2500 units');
  await route(routeDocs('The pump capacity is 2500 units.'), 'The pump capacity is 250[1]0 units [1][2][3].', pumpQ, routed => {
    assert.equal(routed.answer.includes('250[1]0'),false);assert.match(prose(routed),/2500 units/);
  });
});

// ---- R3-OS and M1: one header grammar for sensitive kinds ----
const ocr = '[OCR] The text below was read from a scanned image by a machine, not from a text layer in the file. It can be wrong, and figures especially can be wrong.';
const w2Layout = ['Copy C - For EMPLOYEE\'S RECORDS','22222 Void','b Employer identification number 12-3456789','c Employer\'s name, address, and ZIP code','Synthetic Store LLC','100 Main Street','Springfield','d Control number 0042','e Employee\'s first name and initial','Last name','Pat Example','f Employee\'s address and ZIP code','1 Wages, tips, other compensation','$56000.00','2 Federal income tax withheld','7000.00','Form W-2 Wage and Tax Statement 2025','Department of the Treasury - Internal Revenue Service'].join('\n');
const filings = [
  'Department of the Treasury—Internal Revenue Service Form 1099-INT Interest Income 2025. Interest income: $56000.', // review 2 (a)
  ocr + ' Department of the Treasury – Internal Revenue Service Form 1099-NEC Nonemployee compensation: $56000.',
  ocr + ' OMB No. 1545-0008 Form W-2 Wage and Tax Statement 2025. Wages: $56000.',                               // review 2 (b)
  ocr + '\n' + w2Layout,                                                                                        // review 2 (c)
  ocr + ' Form 8879 IRS e-file Signature Authorization 2025. Adjusted gross income: $56000.',
  'CONSUMER CREDIT REPORT\nPrepared 2026-01-15\nRevolving balance: $56000.',
];
const mentions = [
  ['When is the conference?','Travel memo','Bring your passport to the conference on November 20.','November 20'],
  ['When will the advisor file the extension?','Advisor email','The advisor will file your tax return extension by April 15.','April 15'],
  ['What did the lender ask for?','Lender email','The lender needs a copy of your credit report and the signed note by Friday.','Friday'],
  ['When does the DMV appointment start?','Calendar note','DMV appointment to renew the driver\'s license on December 3 at 9:00.','December 3'],
  ['What does the engagement letter cost?','Engagement letter','Preparation of the 2025 tax returns costs USD 1,800.','1,800'],
  ['What does the long memo contain?','Long memo',Array.from({length:30},(_,i)=>`Background item ${i+1} for the review.`).join('\n')+'\nForm 1040 is mentioned here only as a later example.','Background item 1'],
  // A title-case phrase that only modifies another noun, and an email
  // subject line, are not headings of a sensitive record.
  ['What does the engagement letter cost?','Engagement letter','2025 Tax Return Preparation Engagement Letter\nThe preparation fee is USD 1,800.','1,800'],
  ['What did the bookkeeper ask?','Bookkeeper email','Re: Form 1099-NEC Request\nPlease confirm the contractor address by January 15.','January 15'],
];
test('R3-OS: a passing mention of a sensitive kind stays readable; titles, headings and identity numbers stay screened', () => {
  for (const [question, title, snippet] of mentions) {
    const row = {title, snippet};
    assert.deepEqual(filterThinkCandidates([row],{question}).rows,[row],snippet.slice(0,60));
  }
  for (const row of [
    {title:'Passport', snippet:'Scan of page two.'},
    {title:'Travel memo', snippet:'Passport number: X1234567.'},
    {title:'Archive', snippet:'CONSUMER CREDIT REPORT\nRevolving balance: $56000.'},
    {title:'Archive', snippet:'Passport\nUnited States of America\nSurname: Example'},
  ]) assert.deepEqual(filterThinkCandidates([row],{question:'What does the archive contain?'}).rows,[],JSON.stringify(row));
});
test('R3-OS: the real route answers a passing mention with its figure', async () => {
  for (const [question, title, content, figure] of mentions.slice(0,5).filter((_,i)=>[0,2,4].includes(i))) {
    const h = await build({sources:[sources[0]],docs:[doc('records-1','r1',title,content,3)],draft:`${content.replace(/\.$/,'')} [1].`});
    try {
      const search = await h.unified(question);
      assert.ok(search.body.results.length,'real retrieval found the record');
      const r = await h.think(question);
      assert.equal(r.http,200);contract(r.body);
      assert.equal(r.body.withheld_documents,undefined,question);
      assert.ok(r.body.answer.includes(figure),`${question}: the figure reaches the owner`);
    } finally {h.close();}
  }
});
test('M1: unrequested filing headers after dashes, OMB lines and layouts are screened; requested forms stay readable', () => {
  const note = {title:'Advisor memo',snippet:'Prepare the review packet. The advisor may request Form 1040 later.'};
  for (const snippet of filings) {
    const row = {title:'Annual archive',snippet};
    const policy = filterThinkCandidates([row,note],{question:'What does the annual archive contain?'});
    assert.equal(policy.withheld?.examined_count,2,'both records reached the policy');
    assert.deepEqual(policy.rows,[note],snippet.slice(0,80));
  }
  for (const [question, snippet] of [['What is on my W-2?', filings[2]], ['What is on my Form 1099-INT?', filings[0]], ['What is on my Form 8879?', filings[4]]]) {
    const row = {title:'Annual archive',snippet};
    assert.deepEqual(filterThinkCandidates([row],{question}).rows,[row],question);
  }
});
test('M1: the real route screens dash, OMB and layout filings', async () => {
  for (const [content, textSource] of [[filings[0],'native'],[filings[2],'ocr'],[filings[3],'ocr']]) {
    const h = await build({sources:[sources[0]],docs:[doc('records-1','archive','Annual archive',content,1,{textSource})],draft:'Wages: $56000 [1].'});
    try {
      const search = await h.unified('What does the annual archive contain?');
      assert.ok(search.body.results.length,'real retrieval found the record');
      const r = await h.think('What does the annual archive contain?');
      assert.equal(r.http,200);contract(r.body);
      assert.equal(r.body.withheld_documents?.count,1);assert.doesNotMatch(r.body.answer,/56000/);
    } finally {h.close();}
  }
});

// ---- M2: the oracle consumes every sentence, with or without a figure ----
test('M2: the money oracle rejects any unvalidated sentence in provisional mode', () => {
  const snippet = 'Payer North charged USD 120.00 for October on card ending 4242.';
  const docs = rows(snippet).slice(0,1);
  const body = {...finalizeDocumentAnswer({question:'What charge is recorded?',docs,checks:[{supported:false,complete:false,reason:'payment unverified'}],searchComplete:true}),results:docs};
  const options = {expected:snippet,provisional:true};
  assertDocumentAnswer(body,options);
  for (const extra of ['The invoice is unpaid.','The charge was refunded.','North reversed the charge.','Nothing is due.','You owe nothing.','Payment was received in full.','You are owed a refund.']) {
    const answer = body.answer.replace('\n\nCoverage:', `\n${extra}\n\nCoverage:`);
    assert.notEqual(answer,body.answer,'the mutation is present');
    assert.ok(answer.includes(extra));
    assert.throws(()=>assertDocumentAnswer({...body,answer},options),assert.AssertionError,extra);
  }
});

// ---- M3: payment-state questions are bank-first unless a record is the
// subject of the main question ----
const bankFirst = [
  'Have I paid my insurance policy bill?','Do I owe anything on the policy bill?','Have I paid the lease invoice?',
  'Have I paid the invoice under the services agreement?','Have I paid the deposit the lease requires?','Did we settle invoice 1042?',
  'Is anything still due on invoice 1042?','Did I ever pay the quote from the roofer?','Did my payment for invoice 1042 go through?','Did the Acme invoice clear?',
  'Do I still owe rent under the lease?','Has the contractor been paid for the quote?','Was the Acme invoice covered?','Is the Acme invoice closed out?',
  'Have I covered invoice 1042?','Is the roofer quote paid?','What do I owe under the lease?',
  // Earlier controls stay bank-first.
  'Did I pay the deposit the contract requires?','Did I pay the invoice the email mentions?','Have I paid this invoice?','Do I owe anything on this invoice?',
];
const documentFirst = [
  'What rent does the lease state?','What amount due does the invoice state?','Who issued this invoice?','Have I paid the QuickBooks bill?',
  'How many paid holidays does the handbook give?','What does the lease say I owe each month?','When is rent due under the lease?',
  'Is water damage covered by the policy?','What does the loan agreement say about payments?','When does the lease renew?',
];
test('M3: payment-state questions take the bank handoff; record-terms questions stay documents', async () => {
  for (const q of [...bankFirst,...documentFirst]) {
    let reads = 0;
    const url = new URL('https://fixture.invalid/mcp');
    const body = {mode:'think',...finalizeDocumentAnswer({question:q,docs:[],searchComplete:true}),results:[]};
    const reply = await (await handleMcp({},new Request(url,{method:'POST',body:JSON.stringify({id:1,method:'tools/call',params:{name:'ask',arguments:{question:q}}})}),url,
      {grant:{profile:'librarian'},think:async()=>{reads++;return body;}})).json();
    assert.ok(reply.result?.content?.[0]?.text?.trim(),`${q}: the assistant gets an answer`);
    if (bankFirst.includes(q)) {
      assert.equal(moneyQuestionHandoff(q)?.money_handoff,true,q);
      assert.equal(reads,0,`${q}: bank-first, no document think`);
    } else {
      assert.equal(moneyQuestionHandoff(q),null,q);
      assert.equal(reads,1,`${q}: the document reader answers`);
    }
  }
});

// ---- R3-m1: every scalar question the route accepts is finalized ----
test('R3-m1: a boolean q with a failing scope read is finalized, not a bare 503', async () => {
  const h = await build({sources:[sources[0]],docs:[doc('records-1','memo','true','The review is true on November 13.',1)],draft:'The review is true on November 13 [1].'});
  try {
    h.fixture.raw("INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at) VALUES ('store','Synthetic store','business','owned','owner_stated','confirmed','2026-11-12')");
    h.fixture.raw("UPDATE documents SET entity_slug='store'");
    const headers = { 'X-Admin-Key': h.fixture.env.ADMIN_KEY };
    const healthy = await h.fixture.post('/api/rag/think', {q:true, entity_slug:'store'}, headers);
    assert.equal(healthy.status,200);contract(await healthy.json());
    let reached = 0;
    const prepare = h.fixture.env.DB.prepare.bind(h.fixture.env.DB);
    h.fixture.env.DB.prepare = sql => {
      const statement = prepare(sql);
      if (!/SELECT entity_slug, legal_name, display_label, status, relationship/.test(sql)) return statement;
      const wrap = s => ({...s,bind:(...args)=>wrap(s.bind(...args)),first:async()=>{reached++;throw new Error('synthetic scope read unavailable');}});
      return wrap(statement);
    };
    const r = await h.fixture.post('/api/rag/think', {q:true, entity_slug:'store'}, headers);
    const body = await r.json();
    assert.ok(reached>0,'the owned-scope read was reached');
    assert.equal(r.status,200);contract(body);
    assert.equal(body.code,'entity_scope_unavailable');assert.ok(body.confidence.percent<=10);
    assert.doesNotMatch(body.answer,/November 13|synthetic scope read/);
  } finally {h.close();}
});
