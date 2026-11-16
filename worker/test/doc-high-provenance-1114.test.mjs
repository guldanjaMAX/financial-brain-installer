import test from 'node:test';
import assert from 'node:assert/strict';
import { probes as round1 } from './fixtures/doc-high-provenance-1114/probes.mjs';
import { probes as round2 } from './fixtures/doc-high-provenance-1114/probes2.mjs';
import { probes as round3 } from './fixtures/doc-high-provenance-1114/probes3.mjs';
import { probes as round4 } from './fixtures/doc-high-provenance-1114/probes4.mjs';
import { runDirect, runRoute } from './fixtures/doc-high-provenance-1114/harness.mjs';
import { finalizeDocumentAnswer } from '../src/lib/document-answer.js';
import { documentFigureProvenance } from '../src/lib/document-answer-provenance.js';
import { answerSentences } from '../src/lib/answer-sentences.js';
// Keep the R3 review cases on the existing full-chain provenance entry point.
import './document-exclusive-consistency-1115-r3.test.mjs';

const cases = new Map([...round1, ...round2, ...round3, ...round4].map(p => [p.id, p]));
const findings = {
  'R1-D01':['D01'], 'R1-D02':['D02'], 'R1-D03':['D03'], 'R1-E03':['E03'],
  'R4-F01':['F01'], 'R4-F02':['F02'], 'R4-D18':['D18'], 'R4-D19':['D19'],
  'R2-E06':['E06'], 'R2-E07':['E07'], 'R2-F05':['F05'], 'R3-E08':['E08'],
  'R3-G03':['G03'], 'R3-E09':['E09'], 'R3-E09B':['E09B'], 'R5-D13':['D13'],
  'R5-E12':['E12'], 'R5-D14':['D14'], 'R6-E14':['E14'], 'R6-F06':['F06'],
  'R7-D09-E10-E11':['D09','E10','E11'],
};
const smoke = { id:'smoke', question:'What monthly fee does the signed contract state?',
  docs:['a','b','c'].map(key => ({key,source:`records-${key}`,title:'Signed contract',
    content:'The monthly fee is $250.',occurred_at:'2026-11-11T19:00:00Z'})),
  draft:'The monthly fee is $250 {a}{b}{c}.' };

const proofParts = [
  'The monthly rent is USD 2,000.', 'Status: signed and current.',
  'Amendments checked through: 2026-11-12.', 'Subject: unit 2 lease.', 'Measure: rent.',
  'Rate basis: monthly.', 'Scale: units.', 'Currency: USD.',
  'Covered dates: 2026-01-01 through 2026-12-31.',
];
const proofProbe = (parts=proofParts, question='What is the monthly rent under the unit 2 lease for March 2026?') => ({
  id:'proved-source',question,docs:['a','b','c'].map(key=>({key,source:`records-${key}`,title:'lease',
    content:parts.join(' '),occurred_at:'2026-11-11T19:00:00Z'})),
  draft:parts.map(part=>`${part.slice(0,-1)} {a}{b}{c}.`).join(' '),
});

function reached(result) {
  assert.equal(result.status,200,'the real Worker route answered');
  assert.ok(result.stages.includes('draft') && result.stages.includes('verifier'),
    'the approving model and verifier decision points were reached');
  assert.ok(result.full_reads > 0,'the whole-record SQLite read was reached');
  assert.equal(result.kind,'document');
  assert.ok(result.contract.provenance?.checked_records>0,'the provenance decision point was reached');
  assert.match(result.answer,/Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
  assert.ok(result.remote_has_prose,'remote ask retains the same answer');
  assert.equal(result.remote_confidence,result.confidence_text.match(/Confidence: \w+ \(\d+%\)/)[0]);
}
function keepsFigure(result, probe) {
  for (const amount of probe.draft.match(/(?:[$€£]\s*)?\d[\d,]*(?:\.\d+)?%?/g) || [])
    assert.ok(result.prose.includes(amount),`${probe.id}: the exact source figure ${amount} remains readable`);
}

for (const [finding, ids] of Object.entries(findings)) test(`${finding}: a quoted figure without complete provenance stays below High`, async t => {
  for (const id of ids) {
    const probe = cases.get(id);
    assert.ok(probe,`the frozen ${id} input exists`);
    const route = await runRoute(probe), direct = runDirect(probe);
    reached(route); keepsFigure(route,probe); keepsFigure(direct,probe);
    t.diagnostic(JSON.stringify({finding,id,route_percent:route.percent,direct_percent:direct.percent}));
    assert.ok(route.percent<90,`${id}: Worker provenance is incomplete (${route.percent}%)`);
    assert.ok(direct.percent<90,`${id}: direct-boundary provenance is incomplete (${direct.percent}%)`);
    assert.match(route.confidence_text,/Why:.*Missing:/s);
    assert.match(route.prose,/says:/,'an unproved figure is attributed to its source');
  }
});

// Round 3: vary grammar independently of the exact source identifier. Every
// negative retains a complete-source control and reaches both real boundaries.
const requestSubjects = [
  {subject:'unit 2 lease',title:'lease',measure:'rent'},
  {subject:'contract 7',title:'contract',measure:'fee'},
  {subject:'unit 2 MW lease',title:'MW lease',measure:'usage per mW'},
];
function scopedProbe(scope, question) {
  const parts=proofParts.map(part=>part.replace('unit 2 lease',scope.subject)
    .replace('monthly rent',`monthly ${scope.measure}`).replace('Measure: rent',`Measure: ${scope.measure}`));
  const probe=proofProbe(parts,question);
  for (const doc of probe.docs) doc.title=scope.title;
  return probe;
}
async function provedRequest(probe, t) {
  const bodies=await bothBoundaries(probe);
  t.diagnostic(JSON.stringify({finding:'M2-R3',question:probe.question,percent:bodies.map(body=>body.percent),
    checks:bodies.map(body=>body.contract.provenance.checks.map(row=>row.proven))}));
  for (const body of bodies) {
    assert.equal(body.contract.provenance.checked_records,3);
    assert.deepEqual(body.contract.provenance.checks.map(row=>row.proven),[true,true,true,true,true]);
    assert.equal(body.contract.provenance.complete,true);
    assert.equal(body.percent,90,body.confidence_text);
  }
}

test('M2 R3: the review article-free counterexample keeps complete-source High',async t=>{
  await provedRequest(proofProbe(),t);
  await provedRequest(proofProbe(proofParts,'What is the monthly rent under unit 2 lease for March 2026?'),t);
});

for (const scope of requestSubjects) for (const preposition of ['under','in','for'])
  for (const determiner of ['the ','a ',''])
    test(`M2 R3: composed subject ${preposition} ${determiner}${scope.subject}`,async t=>{
      await provedRequest(scopedProbe(scope,`What is the monthly ${scope.measure} under the ${scope.subject} for March 2026?`),t);
      const subjectClause=`${preposition} ${determiner}${scope.subject}`;
      for (const question of [
        `What is the monthly ${scope.measure} ${subjectClause} for March 2026?`,
        `${subjectClause}, what is the monthly ${scope.measure} for March 2026?`,
        `For March 2026, what is the monthly ${scope.measure} ${subjectClause}?`,
      ]) await provedRequest(scopedProbe(scope,question),t);
    });

for (const scope of requestSubjects) for (const determiner of ['the ','a ',''])
  test(`M2 R3: a stated subject separates its determiner ${determiner}${scope.subject}`,async t=>{
    await provedRequest(scopedProbe(scope,`What is the monthly ${scope.measure} under the ${scope.subject} for March 2026?`),t);
    await provedRequest(scopedProbe(scope,`What monthly ${scope.measure} does ${determiner}${scope.subject} state for March 2026?`),t);
  });

for (const [question,missing] of [
  ['What is the monthly rent in the documents for March 2026?','subject'],
  ['What is the monthly rent under unit 2 lease?','coverage'],
  ['Under unit 2 lease, what is the monthly rent?','coverage'],
  ['What is the monthly rent under the unit 2 lease?','coverage'],
  ['Under the unit 2 lease, what is the monthly rent?','coverage'],
  ['What is the rent under unit 2 lease for March 2026?','basis'],
  ['What is the annual rent under unit 2 lease for March 2026?','basis'],
  ['What is the monthly rent under unit 3 lease for March 2026?','subject'],
  ['What is the monthly rent under Unit 2 lease for March 2026?','subject'],
  ['What is the monthly rent under unit 2 lease for March 2027?','coverage'],
  ['What is the monthly rent under unit 2 lease for 2025-12-01 through 2026-03-31?','coverage'],
  ['What is the monthly rent under unit 2 lease for this month?','coverage'],
  ['Under unit 3 lease, what is the monthly rent under unit 2 lease for March 2026?','subject'],
  ['For March 2027, what is the monthly rent under unit 2 lease for March 2026?','coverage'],
]) test(`M2 R3: explicit or missing scope cannot borrow source proof: ${question}`,async()=>{
  await completeControl();
  for (const body of await bothBoundaries(proofProbe(proofParts,question))) {
    assert.equal(body.contract.provenance.checked_records,3);
    assert.equal(body.contract.provenance.checks.find(row=>row.check===missing).proven,false);
    assert.equal(body.contract.provenance.complete,false);
    assert.ok(body.percent<90);
    assert.match(body.confidence_text,/Why:.*Missing:/s);
  }
});

test('M2 R3: article-free subjects preserve exact measure-unit case',async t=>{
  const scope=requestSubjects[2];
  const good=`What is the monthly usage per mW under ${scope.subject} for March 2026?`;
  await provedRequest(scopedProbe(scope,good),t);
  for (const body of await bothBoundaries(scopedProbe(scope,good.replace('per mW','per MW')))) {
    assert.equal(body.contract.provenance.checked_records,3);
    assert.equal(body.contract.provenance.checks.find(row=>row.check==='subject').proven,false);
    assert.ok(body.percent<90);
    assert.match(body.answer,/per mW/);
  }
});

for (const id of ['smoke','D01C','E04','E05','F03']) test(`re-pinned control ${id} (incomplete provenance)`, async t => {
  const probe = id==='smoke' ? smoke : cases.get(id);
  const route=await runRoute(probe), direct=runDirect(probe);
  reached(route); keepsFigure(route,probe); keepsFigure(direct,probe);
  t.diagnostic(JSON.stringify({control:id,route_percent:route.percent,direct_percent:direct.percent}));
  // MAIN 11-14 08:0x (founder provenance rule): these hunt controls lack governing/current/period proof,
  // so they are re-pinned below High with the figure kept and the missing check named.
  assert.ok(route.percent<90,`${id}: incomplete document provenance stays below High (Worker)`);
  assert.ok(direct.percent<90,`${id}: incomplete document provenance stays below High (direct)`);
  assert.match(route.confidence_text,/Missing:/,`${id}: the missing check is named`);
});

// The remaining hunt arms include the existing below-High controls. Retaining
// them makes a missing probe, handoff or silent answer loss visible.
const findingIds = new Set(Object.values(findings).flat());
for (const probe of cases.values()) if (!findingIds.has(probe.id) && !['D01C','E04','E05','F03'].includes(probe.id))
  test(`remaining document hunt arm ${probe.id}`, async t => {
    const route=await runRoute(probe);
    reached(route); keepsFigure(route,probe);
    t.diagnostic(JSON.stringify({arm:probe.id,route_percent:route.percent}));
    assert.ok(route.percent<90,`${probe.id}: the full founder provenance is not proved`);
  });

for (const [label,parts] of [
  ['a different rate in the source clause',[proofParts[0].replace('monthly','annual'),...proofParts.slice(1)]],
  ['a different currency in the source clause',[proofParts[0].replace('USD','EUR'),...proofParts.slice(1)]],
  ['a future amendment check',proofParts.map(part=>part.replace('checked through: 2026-11-12','checked through: 2026-12-12'))],
  ['a stale amendment check',proofParts.map(part=>part.replace('checked through: 2026-11-12','checked through: 2026-11-11'))],
  ['an unknown fully quoted qualification',[...proofParts,'For discussion only.']],
  ['duplicate status fields',[...proofParts,'Status: signed and current.']],
  ['unproved percentage denominator',proofParts.map(part=>part.replace('USD 2,000','8%').replace('Scale: units','Scale: percent').replace('Currency: USD','Currency: not applicable'))],
]) test(`even a complete-looking source cannot certify ${label}`,async()=>{
  const probe=proofProbe(parts), body=await runRoute(probe);
  reached(body); keepsFigure(body,probe);assert.ok(body.percent<90,body.confidence_text);
  assert.equal(body.contract.provenance.complete,false);
});

for (const [label,mutate] of [
  ['unchecked storage labels',probe=>{for(const doc of probe.docs){doc.uri='drive://Unreviewed/record';doc.top_folder='Unreviewed';}}],
  ['currency in the title',probe=>{for(const doc of probe.docs) doc.title='Lease (€)';}],
  ['rate in the title',probe=>{for(const doc of probe.docs) doc.title='Annual Lease';}],
  ['a status after the old title limit',probe=>{for(const doc of probe.docs) doc.title='Lease '.repeat(30)+'draft2';}],
]) test(`the final boundary retains ${label}`,async()=>{
  const probe=proofProbe();mutate(probe);
  const body=await runRoute(probe), direct=runDirect(probe);
  reached(body);keepsFigure(body,probe);
  assert.ok(body.percent<90,body.confidence_text);assert.ok(direct.percent<90);
  if(label==='a status after the old title limit') assert.ok(body.prose.includes('draft2'));
});

test('the model may only lower a complete-source score', async()=>{
  const probe=proofProbe();
  const normal=await runRoute(probe);
  for (const percent of [100,99,42]) {
    const labelled={...probe,draft:`${probe.draft}\nConfidence: High (${percent}%)`};
    const direct=runDirect(labelled), body=await runRoute(labelled);
    reached(body);keepsFigure(body,probe);
    assert.equal(direct.percent,Math.min(normal.percent,percent),'the final boundary strips a standalone model label');
    assert.ok(body.percent<=normal.percent && body.percent<=percent,'upstream checks may lower the score further');
  }
});

test('green control: all five source-bound checks can still earn High through the real route', async () => {
  const probe=proofProbe(), route=await runRoute(probe), direct=runDirect(probe);
  reached(route); keepsFigure(route,probe); keepsFigure(direct,probe);
  for (const body of [route,direct]) {
    assert.equal(body.contract.provenance.complete,true);
    assert.deepEqual(body.contract.provenance.checks.map(check=>check.proven),[true,true,true,true,true]);
    assert.ok(body.percent>=90,body.confidence_text);
  }
});

for (const [index,check] of [[1,'governing'],[2,'governing'],[3,'subject'],[4,'subject'],[5,'basis'],[6,'units'],[7,'units'],[8,'coverage']])
  test(`removing source fact ${index} leaves ${check} unproved without losing the figure`, async () => {
    const probe=proofProbe(proofParts.filter((_,i)=>i!==index));
    const body=await runRoute(probe);
    reached(body); keepsFigure(body,probe);
    assert.equal(body.contract.provenance.checks.find(row=>row.check===check).proven,false);
    assert.ok(body.percent<90);
    assert.match(body.prose,/USD 2,000/);
  });

for (const question of [
  'What is the annual rent under the unit 2 lease for March 2026?',
  'What is the monthly rent under the unit 3 lease for March 2026?',
  'What is the monthly rent under the unit 2 lease for March 2027?',
  'What is the total monthly rent across the three leases?',
  'What is the monthly rent under the unit 2 lease for this month?',
]) test(`source proof cannot be supplied or widened by a question: ${question}`,async()=>{
  const probe=proofProbe(proofParts,question), body=await runRoute(probe);
  reached(body); keepsFigure(body,probe); assert.ok(body.percent<90);
});

test('a scale marker in a title is checked even without a transport title wrapper',()=>{
  const probe=proofProbe();
  const docs=probe.docs.map((doc,i)=>({n:i+1,title:'lease ($000)',source:doc.source,snippet:doc.content,
    ts:doc.occurred_at,date_reliable:true,text_source:'native',text_reliable:true,read_complete:true,
    authority:{tier:'T1',rank:1,eligible:true,authoritative:true},
    lineage:{status:'known',family_tokens:[`source-${i}`]}}));
  const draft=probe.draft.replace(/\{a\}/g,'[1]').replace(/\{b\}/g,'[2]').replace(/\{c\}/g,'[3]');
  const greenDocs=docs.map(doc=>({...doc,title:'lease'}));
  const green=finalizeDocumentAnswer({question:probe.question,draft,docs:greenDocs,approvedDocs:greenDocs,
    checks:[{supported:true,complete:true}],searchComplete:true,asOf:'2026-11-12'});
  assert.ok(green.confidence.percent>=90,'the same full source with a matched title is a green control');
  const body=finalizeDocumentAnswer({question:probe.question,draft,docs,approvedDocs:docs,
    checks:[{supported:true,complete:true}],searchComplete:true,asOf:'2026-11-12'});
  assert.ok(body.answer_contract.provenance.checked_records>0,'the real boundary checked the title-bearing records');
  assert.match(body.answer,/USD 2,000/);
  assert.ok(body.confidence.percent<90,'a title scale cannot be silently interpreted as units');
});

test('a case-sensitive unit in the requested measure cannot be case-folded into source proof',async()=>{
  const parts=proofParts.map(part=>part.replace('monthly rent','monthly usage per mW').replace('Measure: rent','Measure: usage per mW'));
  const good=proofProbe(parts,'What is the monthly usage per mW under the unit 2 lease for March 2026?');
  const green=await runRoute(good);reached(green);assert.ok(green.percent>=90);
  const body=await runRoute({...good,question:good.question.replace('per mW','per MW')});
  reached(body);assert.match(body.answer,/per mW/);
  assert.ok(body.percent<90,'MW and mW are different requested measures');
});

test('a case-sensitive unit in a source title cannot be case-folded into subject proof',async()=>{
  const parts=proofParts.map(part=>part.replace('unit 2 lease','unit 2 MW lease'));
  const good=proofProbe(parts,'What is the monthly rent under the unit 2 MW lease for March 2026?');
  for(const doc of good.docs) doc.title='MW lease';
  const green=await runRoute(good);reached(green);assert.ok(green.percent>=90);
  const bad={...good,docs:good.docs.map(doc=>({...doc,title:'mW lease'}))};
  const body=await runRoute(bad);reached(body);assert.match(body.answer,/USD 2,000/);
  assert.ok(body.percent<90,'the title and source subject must carry the same unit case');
});

// Round 2: every arm reaches both answer boundaries and has an unchanged,
// complete-source High control. Uniform demotion cannot pass these probes.
async function bothBoundaries(probe) {
  const route=await runRoute(probe), direct=runDirect(probe);
  reached(route);
  for (const body of [route,direct]) {
    keepsFigure(body,probe);
    assert.ok(body.contract.provenance.checked_records>0);
    assert.match(body.answer,/Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
    assert.doesNotMatch(body.prose,/\b(?:I cannot|I can't|withheld)\b/);
  }
  return [route,direct];
}
async function completeControl() {
  const control=await bothBoundaries(proofProbe());
  for (const body of control) {
    assert.equal(body.contract.provenance.complete,true);
    assert.equal(body.percent,90);
  }
  return control;
}

for (const title of [
  'lease UNSIGNED2','UNSIGNED2 lease','lease draft2','draft lease',
  'lease example2','example lease','lease template2','template lease',
  'lease rejected2','rejected lease','lease superseded2','lease version2',
  'lease v2','lease unknown-qualification',
]) test(`B1: repeating ${title} does not resolve title/version status`,async t=>{
  await completeControl();
  const subject=`unit 2 ${title}`;
  const probe=proofProbe(proofParts.map(part=>part.replace('Subject: unit 2 lease.',`Subject: ${subject}.`)),
    `What is the monthly rent under the ${subject} for March 2026?`);
  for (const doc of probe.docs) doc.title=title;
  const bodies=await bothBoundaries(probe);
  t.diagnostic(JSON.stringify({finding:'B1',title,percent:bodies.map(body=>body.percent),
    governing:bodies.map(body=>body.contract.provenance.checks.find(row=>row.check==='governing').proven)}));
  for (const body of bodies) {
    assert.equal(body.contract.provenance.checks.find(row=>row.check==='governing').proven,false);
    assert.ok(body.percent<90);
    assert.match(body.confidence_text,/governing.*Missing:/s);
    assert.match(body.prose,/says:/);
  }
});

for (const locator of [
  {uri:'https://fixture.invalid/records/lease'},
  {top_folder:'Records'},
  {uri:'https://fixture.invalid/records/lease',top_folder:'Records'},
  {uri:'https://fixture.invalid/file/d/opaque-record-01/view?usp=sharing'},
]) test(`M1: neutral storage preserves the complete-source score ${JSON.stringify(locator)}`,async t=>{
  const control=await completeControl(), probe=proofProbe();
  for (const doc of probe.docs) Object.assign(doc,locator);
  const bodies=await bothBoundaries(probe);
  t.diagnostic(JSON.stringify({finding:'M1',locator,percent:bodies.map(body=>body.percent)}));
  for (const [index,body] of bodies.entries()) {
    assert.equal(body.contract.provenance.complete,true);
    assert.equal(body.percent,control[index].percent);
  }
});

for (const locator of [
  {uri:'https://fixture.invalid/draft/lease'},
  {uri:'https://fixture.invalid/%72ejected/lease'},
  {uri:'https://fixture.invalid/unknown-context/lease'},
  {uri:'https://fixture.invalid/records/lease?status=draft'},
  {uri:'https://fixture.invalid/file/d/opaque-record-01/view',top_folder:'Rejected'},
  {top_folder:'Unreviewed'},
  {top_folder:'Draft'},
]) test(`M1: unresolved storage still caps ${JSON.stringify(locator)}`,async()=>{
  await completeControl();
  const probe=proofProbe();
  for (const doc of probe.docs) Object.assign(doc,locator);
  for (const body of await bothBoundaries(probe)) {
    assert.equal(body.contract.provenance.checks.find(row=>row.check==='governing').proven,false);
    assert.ok(body.percent<90);
    assert.match(body.confidence_text,/governing.*Missing:/s);
  }
});

for (const question of [
  'what is the monthly rent under the unit 2 lease for March 2026?',
  'How much is the monthly rent under the unit 2 lease for March 2026?',
  'WHAT IS THE monthly rent UNDER THE unit 2 lease FOR March 2026?',
  'What monthly rent does the unit 2 lease state for March 2026?',
  'For March 2026, how much is the monthly rent under the unit 2 lease?',
  'Under the unit 2 lease, what is the monthly rent for March 2026?',
]) test(`M2: equivalent requested scope preserves High: ${question}`,async t=>{
  const control=await completeControl();
  const bodies=await bothBoundaries(proofProbe(proofParts,question));
  t.diagnostic(JSON.stringify({finding:'M2',question,percent:bodies.map(body=>body.percent)}));
  for (const [index,body] of bodies.entries()) {
    assert.equal(body.contract.provenance.complete,true);
    assert.equal(body.percent,control[index].percent);
  }
});

for (const question of [
  'How much is the annual rent under the unit 2 lease for March 2026?',
  'how much is the monthly rent under the unit 3 lease for March 2026?',
  'how much is the monthly rent under the unit 2 lease for March 2027?',
  'how much is the monthly rent under the unit 2 lease for 2025-12-01 through 2026-03-31?',
  'How much is not the monthly rent under the unit 2 lease for March 2026?',
  'How much is the total monthly rent across the three leases for March 2026?',
  'How much is the monthly rent under the unit 2 lease for this month?',
]) test(`M2: a different or unresolved requested scope stays below High: ${question}`,async()=>{
  await completeControl();
  for (const body of await bothBoundaries(proofProbe(proofParts,question))) {
    assert.equal(body.contract.provenance.complete,false);
    assert.ok(body.percent<90);
    assert.match(body.confidence_text,/Why:.*Missing:/s);
  }
});

// N1 round 2: keep the heading in the exact draft. Omitting it can demote a
// broken consistency check for an unrelated grounding failure and hide N1.
const flatExclusive = value => value.replace(/\s+/g,' ').trim();
function exclusiveProbe({first='',second='',term='sole',left='agency A',right='agency B',title='lease'}={}) {
  const content=`${first}The ${term} deposit custodian is ${left}. ${second}The ${term} deposit custodian is ${right}.`;
  return {id:'exclusive-heading',question:'What does the lease say about the sole deposit custodian?',
    docs:['a','b','c'].map(key=>({key,source:`records-${key}`,title,content,occurred_at:'2026-11-11T19:00:00Z'})),
    draft:answerSentences(flatExclusive(content)).map(row=>`${row.slice(0,-1)} {a}{b}{c}.`).join(' ')};
}
function exclusiveControl() {
  const body=runDirect(exclusiveProbe({first:'## Terms\n',right:'agency A'}));
  assert.equal(body.contract.read_count,3);
  assert.equal(body.contract.provenance?.checked_records,3);
  assert.equal(body.contract.provenance.checks.find(row=>row.check==='exclusive_consistency')?.proven,true);
  assert.equal(body.rung,1);
  assert.equal(body.percent,90,'exact matching A/A headings still earn High');
  return body;
}
function exclusiveConflict(body,probe) {
  assert.equal(body.contract.read_count,3,'three readable records reached finalization');
  assert.equal(body.contract.provenance?.checked_records,3,'populated exclusive-fact decision reached');
  assert.equal(body.contract.provenance.checks.find(row=>row.check==='exclusive_consistency')?.proven,false);
  assert.ok(body.percent<90,body.confidence_text);
  assert.match(body.prose,/says:/);
  const quotes=[...body.prose.matchAll(/says: ("(?:\\.|[^"\\])*") \[\d+\]/g)].map(match=>JSON.parse(match[1]));
  assert.equal(quotes.length,3,'both assertions stay attributed in every source record');
  for(const doc of probe.docs) assert.ok(quotes.some(quote=>quote.includes(flatExclusive(doc.content))),
    'each complete source span, including headings, figures and values, survives verbatim');
  assert.match(body.confidence_text,/conflict.*Missing:.*operative/s);
  assert.match(body.answer,/Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
  assert.doesNotMatch(body.prose,/\b(?:I cannot|I can't|withheld)\b/);
}

test('N1 R2 review counterexample: distinct Markdown heading after Worker-style flattening',t=>{
  const green=exclusiveControl();
  const probe=exclusiveProbe({first:'## Terms\n'}),body=runDirect(probe);
  t.diagnostic(JSON.stringify({arm:'review-counterexample',consistent_percent:green.percent,conflicting_percent:body.percent,
    checked_records:body.contract.provenance?.checked_records || 0}));
  exclusiveConflict(body,probe);
});

const exclusivePrefixes=[
  '[lease] ','[record] ','# Terms\n','## Terms\n','## Terms ','# Conditions ',
  '[record] ## Terms\n','## Terms [record] ','[record] [record] ## Terms ## Conditions ',
  'Lease: ','Overview: ','[lease] [lease] ## Other heading\n',
  'Unexpected heading without markup ',
];
for(const prefix of exclusivePrefixes) for(const position of ['first','second','both'])
  for(const term of ['sole','single','only','exclusive'])
    test(`N1 R2 normalized fact: ${JSON.stringify(prefix)} ${position} ${term}`,()=>{
      exclusiveControl();
      const probe=exclusiveProbe({term,first:position==='second'?'':prefix,second:position==='first'?'':prefix});
      exclusiveConflict(runDirect(probe),probe);
    });

for(const flatten of [false,true]) test(`N1 R2 source grammar is independent of newline flattening: ${flatten}`,()=>{
  const green=exclusiveControl(),probe=exclusiveProbe({first:'## Terms\n',second:'[record] # Conditions\n'});
  const docs=probe.docs.map((doc,i)=>({n:i+1,title:doc.title,snippet:flatten ? flatExclusive(doc.content) : doc.content}));
  const result=documentFigureProvenance({question:probe.question,draft:probe.draft,docs,hasFigure:()=>false,
    asOf:'2026-11-12',searchComplete:true,retrievedCount:3});
  assert.equal(green.percent,90);
  assert.equal(result.checked_records,3);
  assert.equal(result.checks.find(row=>row.check==='exclusive_consistency')?.proven,false);
});

for(const [left,right] of [
  ['agency A [escrow: primary]','agency B [escrow: secondary]'],
  ['agency A: [primary]','agency B: [secondary]'],
  ['USD 2,000.25','USD 2,001.25'],
  ['250 mW','250 MW'],
  ['agency [1]','agency [2]'],
]) test(`N1 R2 comparison retains exact source values ${left} / ${right}`,()=>{
  exclusiveControl();
  const probe=exclusiveProbe({first:'## Terms\n',left,right});
  exclusiveConflict(runDirect(probe),probe);
});

test('N1 R2 differently titled records and synonymous operators still compare the same fact',()=>{
  exclusiveControl();
  const probe=exclusiveProbe();
  probe.docs=probe.docs.map((doc,i)=>({...doc,title:['lease','contract','agreement'][i],
    content:`${['# Terms','[record] ## Conditions','## Details'][i]}\nThe ${['sole','only','exclusive'][i]} deposit custodian is agency ${i===1?'B':'A'}.`}));
  const body=runDirect(probe);
  exclusiveConflict(body,probe);
});

test('N1 R2 green control: different exclusive subjects can have different values at High',()=>{
  exclusiveControl();
  const probe=exclusiveProbe();
  for(const doc of probe.docs) doc.content='The sole deposit custodian is agency A. The only notice recipient is agency B.';
  probe.draft='The sole deposit custodian is agency A {a}{b}{c}. The only notice recipient is agency B {a}{b}{c}.';
  const body=runDirect(probe);
  assert.equal(body.contract.read_count,3);
  assert.equal(body.contract.provenance.checked_records,3);
  assert.equal(body.contract.provenance.checks.find(row=>row.check==='exclusive_consistency')?.proven,true);
  assert.equal(body.percent,90);
  assert.equal(body.rung,1);
});

test('N1 R2 an unsupported exclusive construction cannot silently certify consistency',()=>{
  exclusiveControl();
  const probe=exclusiveProbe();
  for(const doc of probe.docs) doc.content='## Terms\nOnly agency A may hold the deposit. Only agency B may hold the deposit.';
  probe.draft='## Terms Only agency A may hold the deposit {a}{b}{c}. Only agency B may hold the deposit {a}{b}{c}.';
  const body=runDirect(probe);
  assert.equal(body.contract.read_count,3);
  assert.equal(body.contract.provenance?.checked_records,3);
  assert.equal(body.contract.provenance.checks.find(row=>row.check==='exclusive_consistency')?.proven,false);
  assert.ok(body.percent<90);
  assert.match(body.confidence_text,/exclusive.*Missing:/s);
  assert.match(body.prose,/agency A.*agency B/s);
});

for(const first of ['## Terms\n','# Conditions\n','[record] ## Terms\n','## Terms ','[record] [record] ## Terms ## Other heading '])
  test(`N1 R2 real Worker and full MCP parity: ${JSON.stringify(first)}`,async t=>{
    const control=await runRoute(exclusiveProbe({first,right:'agency A'}));
    assert.equal(control.status,200);assert.equal(control.full_reads,3);
    assert.deepEqual(control.stages,['draft','verifier']);
    assert.equal(control.contract.read_count,3);
    t.diagnostic(JSON.stringify({arm:'worker-control',first,percent:control.percent,basis:control.basis,gaps:control.gaps}));
    // Repeated wrappers can independently affect exact grounding. The review's
    // distinct Markdown-heading control must retain its original High result.
    if(first==='## Terms\n') assert.equal(control.percent,90);
    const probe=exclusiveProbe({first}),body=await runRoute(probe);
    assert.equal(body.status,200);assert.equal(body.full_reads,3);
    assert.deepEqual(body.stages,['draft','verifier']);
    assert.equal(body.kind,'document');
    t.diagnostic(JSON.stringify({arm:'worker-heading',first,consistent_percent:control.percent,conflicting_percent:body.percent}));
    exclusiveConflict(body,probe);
    for(const result of [control,body]) {
      assert.ok(result.remote_text.includes(result.answer),'MCP retains the entire Worker answer and all five contract parts');
      assert.ok(result.remote_text.includes(result.confidence_text),'MCP retains the full computed explanation and missing evidence');
      assert.equal(result.remote_confidence,result.confidence_text.match(/Confidence: \w+ \(\d+%\)/)[0]);
    }
  });

test('N1 R2 model confidence can only lower the exact contradictory reading',()=>{
  exclusiveControl();
  const probe=exclusiveProbe({first:'## Terms\n'}),normal=runDirect(probe);
  exclusiveConflict(normal,probe);
  for(const percent of [100,90,42]) {
    const body=runDirect({...probe,draft:`${probe.draft}\nConfidence: High (${percent}%)`});
    exclusiveConflict(body,probe);
    assert.equal(body.percent,Math.min(normal.percent,percent));
  }
});

test('N1 R2 uncited older exclusive records keep their contrary assertions attributed',()=>{
  exclusiveControl();
  const probe=exclusiveProbe();
  const heading='## Operating appointment authority reconciliation conditions review';
  probe.docs=probe.docs.map((doc,i)=>({...doc,occurred_at:i ? '2026-11-01T19:00:00Z' : doc.occurred_at,
    content:`${i ? '## Terms' : heading}\nThe sole deposit custodian is agency ${i===1?'B':'A'}.`}));
  probe.draft=`${heading} The sole deposit custodian is agency A {a}.`;
  exclusiveConflict(runDirect(probe),probe);
});

test('N1 R2 including uncited contrary copies cannot raise the original reading score',()=>{
  exclusiveControl();
  const probe=exclusiveProbe({first:'## Terms\n',right:'agency A'});
  probe.draft='## Terms The sole deposit custodian is agency A {a}.';
  probe.docs[0].content='## Terms\nThe sole deposit custodian is agency A.';
  for(const doc of probe.docs.slice(1)) {
    doc.occurred_at='2026-11-01T19:00:00Z';
    doc.content='## Terms\nThe sole deposit custodian is agency A. The sole deposit custodian is agency B.';
  }
  const single=runDirect({...probe,docs:probe.docs.slice(0,1)}),body=runDirect(probe);
  assert.equal(single.contract.read_count,1);
  exclusiveConflict(body,probe);
  assert.ok(body.percent<=single.percent,'attribution of additional conflicting records can only lower confidence');
});
