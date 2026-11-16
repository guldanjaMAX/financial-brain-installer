import test from 'node:test';
import assert from 'node:assert/strict';
import { answerSentences } from '../src/lib/answer-sentences.js';
import { runDirect, runRoute } from './fixtures/doc-high-provenance-1114/harness.mjs';

const flat = value => value.replace(/\s+/g, ' ').trim();
const record = (key, content, { title='lease', older=false }={}) => ({key,source:`records-${key}`,title,content,
  occurred_at:older ? '2026-10-01T19:00:00Z' : '2026-11-11T19:00:00Z'});
function probeFor(content, {title='lease'}={}) {
  return {id:'exclusive-r3',question:'What does the lease say about the deposit custodian?',
    docs:['a','b','c'].map(key=>record(key,content,{title})),
    draft:answerSentences(flat(content)).map(row=>`${row.replace(/[.]$/,'')} {a}{b}{c}.`).join(' ')};
}
const exclusiveCheck = body => body.contract.provenance?.checks.find(row=>row.check==='exclusive_consistency');
async function boundaries(probe) {
  const direct=runDirect(probe), route=await runRoute(probe);
  assert.equal(route.status,200);
  assert.ok(route.full_reads>=3,'the real SQLite whole-record reading was reached');
  assert.deepEqual(route.stages,['draft','verifier'],'both model decision points were reached');
  assert.ok(route.remote_text.includes(route.answer),'MCP retains the complete answer');
  assert.ok(route.remote_text.includes(route.confidence_text),'MCP retains the computed explanation');
  assert.equal(route.remote_confidence,route.confidence_text.match(/Confidence: \w+ \(\d+%\)/)[0]);
  for (const body of [direct,route]) {
    assert.ok(body.prose.length>0);
    assert.doesNotMatch(body.prose,/\b(?:I cannot|I can't|withheld)\b/);
    assert.match(body.answer,/Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
    assert.match(body.confidence_text,/Why:.*Missing:/s);
  }
  return [direct,route];
}
function keepsQuotes(body, probe) {
  const quotes=[...body.prose.matchAll(/says: ("(?:\\.|[^"\\])*") \[\d+\]/g)].map(match=>JSON.parse(match[1]));
  for (const doc of probe.docs) assert.ok(quotes.some(quote=>quote.includes(flat(doc.content))),
    'each source span, including figures and headings, remains verbatim');
}

// Each conflict has its own exact A/A High control. A keyword cap or a parser
// that treats the first party as the field cannot pass both arms.
for (const [label,left,right] of [
  ['inverted agency','Only agency A is the deposit custodian.','Only agency B is the deposit custodian.'],
  ['inverted heading','## Terms\nOnly agency A is the deposit custodian.','Only agency B is the deposit custodian.'],
  ['inverted roles','Only the landlord is the deposit custodian.','Only the tenant is the deposit custodian.'],
  ['inverted plural','Only agency A and agency C are authorized custodians.','Only agency B is an authorized custodian.'],
  ['solely held','## Terms\nThe deposit is held solely by agency A.','The deposit is held solely by agency B.'],
  ['exclusively copula','## Terms\nThe deposit custodian is exclusively agency A.','The deposit custodian is exclusively agency B.'],
  ['solely copula','The deposit custodian is solely agency A.','The deposit custodian is solely agency B.'],
  ['exclusively held','The deposit is held exclusively by agency A.','The deposit is held exclusively by agency B.'],
  ['inverted permission','## Terms\nOnly agency A may hold the deposit.','Only agency B may hold the deposit.'],
  ['bare exclusive subject','Exclusive rights holders are agency A.','Exclusive rights holders are agency B.'],
  ['bare sole heading','## Sole custodian\nThe custodian is agency A.','## Sole custodian\nThe custodian is agency B.'],
]) test(`R3 exclusive conflict: ${label}`,async t=>{
  const control=await boundaries(probeFor(`${left} ${left}`));
  const probe=probeFor(`${left} ${right}`), conflict=await boundaries(probe);
  for (let i=0;i<conflict.length;i++) {
    assert.equal(control[i].percent,90,'the matching A/A arm stays High');
    assert.equal(exclusiveCheck(control[i])?.proven,true,'the populated positive consistency decision was reached');
    assert.equal(control[i].contract.read_count,3);
    const body=conflict[i];
    assert.equal(body.contract.read_count,3);
    assert.equal(body.contract.provenance?.checked_records,3,'populated consistency decision was reached');
    assert.equal(exclusiveCheck(body)?.proven,false,'different exclusive parties conflict');
    assert.ok(body.percent<90,body.confidence_text);
    assert.match(body.confidence_text,/conflict.*Missing:.*operative/s);
    keepsQuotes(body,probe);
  }
  t.diagnostic(JSON.stringify({label,control:control.map(body=>body.percent),conflict:conflict.map(body=>body.percent)}));
});

// R3 final review: requiring a determiner right before the operator made a
// possessive or qualifier hide the conflict (base and round 2 were 89%,
// round 3 was 90%), and "that only A is ..." read A as the field. Each
// conflict must be Medium (89%) and each exact A/A control must stay at 90%.
const lead='The lease names the parties. ';
for (const [label,prefix,a,b] of [
  ['possessive sole member',lead,"The Company's sole member is Jane Doe.","The Company's sole member is John Roe."],
  ['qualified sole custodian',lead,'The designated sole custodian is agency A.','The designated sole custodian is agency B.'],
  ['possessive exclusive distributor',lead,"Acme's exclusive distributor is agency A.","Acme's exclusive distributor is agency B."],
  ['possessive only custodian',lead,"The deposit's only custodian is agency A.","The deposit's only custodian is agency B."],
  ['provides that only','','The lease provides that only agency A is the deposit custodian.',
    'The lease provides that only agency B is the deposit custodian.'],
  ['heading bare sole subject','## Terms\n','Sole custodian is agency A.','Sole custodian is agency B.'],
]) test(`R3 final exclusive conflict: ${label}`,async t=>{
  const control=await boundaries(probeFor(`${prefix}${a} ${a}`));
  const probe=probeFor(`${prefix}${a} ${b}`), conflict=await boundaries(probe);
  for (let i=0;i<conflict.length;i++) {
    assert.equal(control[i].percent,90,'the matching A/A arm stays High');
    assert.equal(exclusiveCheck(control[i])?.proven,true,'agreeing copies prove consistency');
    assert.equal(control[i].contract.read_count,3);
    const body=conflict[i];
    assert.equal(body.contract.read_count,3);
    assert.equal(body.contract.provenance?.checked_records,3);
    assert.equal(exclusiveCheck(body)?.proven,false,'different exclusive parties conflict');
    assert.equal(body.percent,89,body.confidence_text);
    assert.match(body.confidence_text,/conflict.*Missing:.*operative/s);
    keepsQuotes(body,probe);
  }
  t.diagnostic(JSON.stringify({label,control:control.map(body=>body.percent),conflict:conflict.map(body=>body.percent)}));
});

// Independent review of a531b155a: the original check read the subject as
// everything up to "is/are", punctuation included (base 89%). A narrower
// subject grammar produced no reading for these and returned 90%. Each
// conflict must stay below High; each exact A/A control stays at 90%.
for (const [label,a,b] of [
  ['comma in party name','The sole member of Acme, LLC is Jane Doe.','The sole member of Acme, LLC is John Roe.'],
  ['parenthetical subject','The sole custodian (escrow agent) is agency A.','The sole custodian (escrow agent) is agency B.'],
  ['comma clause subject','The sole custodian, as escrow agent, is agency A.','The sole custodian, as escrow agent, is agency B.'],
  ['only with comma clause','The only custodian, per the lease, is agency A.','The only custodian, per the lease, is agency B.'],
  ['quoted subject','The sole "Custodian" is agency A.','The sole "Custodian" is agency B.'],
  ['ampersand subject','The sole R&D custodian is agency A.','The sole R&D custodian is agency B.'],
  ['hyphenated sole-source','The sole-source supplier is agency A.','The sole-source supplier is agency B.'],
  ['hyphenated single-member','The single-member manager is Jane Doe.','The single-member manager is John Roe.'],
]) test(`R3 punctuated exclusive subject: ${label}`,async t=>{
  const control=await boundaries(probeFor(`${lead}${a} ${a}`));
  const probe=probeFor(`${lead}${a} ${b}`), conflict=await boundaries(probe);
  for (let i=0;i<conflict.length;i++) {
    assert.equal(control[i].percent,90,'the matching A/A arm stays High');
    assert.equal(exclusiveCheck(control[i])?.proven,true,'agreeing copies prove consistency');
    assert.equal(control[i].contract.read_count,3);
    const body=conflict[i];
    assert.equal(body.contract.read_count,3);
    assert.equal(body.contract.provenance?.checked_records,3);
    assert.equal(exclusiveCheck(body)?.proven,false,'different exclusive parties conflict');
    assert.ok(body.percent<90,body.confidence_text);
    assert.match(body.confidence_text,/conflict.*Missing:.*operative/s);
    keepsQuotes(body,probe);
  }
  t.diagnostic(JSON.stringify({label,control:control.map(body=>body.percent),conflict:conflict.map(body=>body.percent)}));
});

for (const content of [
  'The deposit custodian is agency A. Payments are accepted only by wire.',
  'The deposit custodian is agency A. Rent is paid in a single payment.',
  'The deposit custodian is agency A. Parking is available only on weekdays.',
]) test(`R3 unrelated exclusive wording is not a fact: ${content}`,async()=>{
  for (const body of await boundaries(probeFor(content))) {
    assert.equal(body.contract.read_count,3,'all three records reached the reading');
    assert.equal(exclusiveCheck(body),undefined,'non-fact wording supplies no consistency check');
    assert.equal(body.percent,90,'the fully consumed true statement keeps its base confidence');
  }
});

for (const [title,content] of [
  ['Exclusive Listing Agreement','Exclusive Listing Agreement\nThe sole listing broker is agency A.'],
  ['Single Member LLC Agreement','Single Member LLC Agreement\nThe deposit custodian is agency A.'],
]) test(`R3 title words are not operators: ${title}`,async()=>{
  for (const body of await boundaries(probeFor(content,{title}))) {
    assert.equal(body.contract.read_count,3);
    assert.notEqual(exclusiveCheck(body)?.proven,false);
    assert.equal(body.percent,90,'consumed title words keep their base confidence');
  }
});

test('R3 case-only party spelling is the same exclusive value',async()=>{
  const content='The sole deposit custodian is agency A. The sole deposit custodian is Agency A.';
  for (const body of await boundaries(probeFor(content))) {
    assert.equal(body.contract.read_count,3);
    assert.equal(exclusiveCheck(body)?.proven,true);
    assert.equal(body.percent,90);
  }
});

for (const prefix of ['[Lease] ','【lease】 ','「terms」 ','Terms： ','# Terms: ','[x] [y] # Z\n'])
  test(`R3 review prefix still detects conflict: ${JSON.stringify(prefix)}`,async()=>{
    const left=`${prefix}The Sole Deposit\u00a0Custodian is agency A.`;
    const control=await boundaries(probeFor(`${left} ${left}`));
    const probe=probeFor(`${left} The sole deposit custodian is agency B.`);
    for (const [i,body] of (await boundaries(probe)).entries()) {
      assert.ok(control[i].percent>=body.percent);
      assert.equal(exclusiveCheck(control[i])?.proven,true);
      assert.equal(exclusiveCheck(body)?.proven,false);
      assert.ok(body.percent<90);
      keepsQuotes(body,probe);
    }
  });

test('R3 unrelated older only note preserves 89 percent and three records read',async()=>{
  const probe=probeFor('The deposit custodian is agency A.');
  probe.docs.push(record('d','Parking is available only on weekdays.',{title:'note d',older:true}),
    record('e','The building has two elevators.',{title:'note e',older:true}),
    record('f','Trash pickup is on Tuesday.',{title:'note f',older:true}));
  const control={...probe,docs:probe.docs.map(doc=>({...doc,content:doc.content.replace('only on','on')}))};
  const green=await boundaries(control), bodies=await boundaries(probe);
  for (const [i,body] of bodies.entries()) {
    assert.equal(green[i].percent,89);
    assert.equal(body.percent,green[i].percent);
    assert.equal(body.contract.retrieved_count,6,'all six records reached finalization');
    assert.equal(body.contract.read_count,3,'unrelated older records stay outside the reading');
    assert.equal(exclusiveCheck(body),undefined);
    assert.doesNotMatch(body.prose,/Parking|elevators|Trash/);
  }
});

test('R3 a real conflict does not pull unrelated older records alongside it',async()=>{
  const probe=probeFor('The sole deposit custodian is agency A.');
  probe.docs.push(record('d','## Terms\nThe only deposit custodian is agency B.',{title:'note d',older:true}),
    record('e','Parking is available only on weekdays.',{title:'note e',older:true}),
    record('f','Trash pickup is on Tuesday.',{title:'note f',older:true}));
  const control={...probe,docs:probe.docs.map(doc=>({...doc,content:doc.content.replace('agency B','agency A')}))};
  const green=await boundaries(control), bodies=await boundaries(probe);
  for (const [i,body] of bodies.entries()) {
    assert.equal(exclusiveCheck(green[i])?.proven,true);
    assert.equal(exclusiveCheck(body)?.proven,false);
    assert.equal(body.contract.provenance.checked_records,6);
    assert.equal(body.contract.read_count,4,'only the older conflicting record is added');
    assert.ok(body.percent<90);
    assert.ok(body.percent<=green[i].percent);
    assert.match(body.prose,/agency B/);
    assert.doesNotMatch(body.prose,/Parking|Trash/);
  }
});

test('R3 unrelated uncited exclusive facts cannot create an answer conflict',async()=>{
  const probe=probeFor('The sole deposit custodian is agency A.');
  probe.docs.push(record('d','The sole parking manager is operator B.',{title:'note d',older:true}),
    record('e','The sole parking manager is operator C.',{title:'note e',older:true}));
  for (const body of await boundaries(probe)) {
    assert.equal(body.contract.provenance?.checked_records,5,'all candidates reached consistency assessment');
    assert.equal(exclusiveCheck(body)?.proven,true,'only conflicts about a cited fact apply');
    assert.equal(body.contract.read_count,3);
    assert.equal(body.percent,89,'uncited coverage keeps its existing base ceiling');
    assert.doesNotMatch(body.prose,/parking manager/);
  }
});

test('R3 an exclusive conflict retains all five numeric provenance checks',async()=>{
  const numeric='The monthly rent is USD 2,000. Status: signed and current. Amendments checked through: 2026-11-12. '+
    'Subject: unit 2 lease. Measure: rent. Rate basis: monthly. Scale: units. Currency: USD. '+
    'Covered dates: 2026-01-01 through 2026-12-31.';
  const positive=probeFor(numeric);
  positive.question='What is the monthly rent under unit 2 lease for March 2026?';
  for (const body of await boundaries(positive)) assert.equal(body.percent,90,'complete numeric source control is High');
  const probe=probeFor(`${numeric} The sole deposit custodian is agency A. The sole deposit custodian is agency B.`);
  probe.question=positive.question;
  for (const body of await boundaries(probe)) {
    const checks=body.contract.provenance?.checks;
    assert.equal(body.contract.provenance?.checked_records,3);
    assert.equal(exclusiveCheck(body)?.proven,false);
    for (const check of ['governing','subject','basis','units','coverage']) assert.ok(checks.some(row=>row.check===check),check);
    assert.equal(checks.length,6);
    assert.match(body.confidence_text,/governing.*Missing:/s);
    assert.match(body.answer,/USD 2,000/);
    assert.ok(body.percent<90);
    keepsQuotes(body,probe);
  }
});
