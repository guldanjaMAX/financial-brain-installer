import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { createProductFixture, seedOwnedEntity } from './product-contract-fixture.mjs';
import { filterThinkCandidates } from '../src/lib/think-candidate-policy.js';
import { taxQuestionScopeAssessment } from '../src/lib/tax-evidence-scope.js';
import { POST_LAUNCHER_TEST_COMMANDS } from '../../scripts/run-test-chain.mjs';
import { scanEnvelope } from '../src/lib/secret-scan.js';
import { renderCliCommands } from '../../operations/cli-guidance.mjs';
// Keep the record-request table in the existing offline regression entry point.
import './sensitive-record-request.test.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRATCH = join(ROOT, '.lane-p1');
const NOW = Date.parse('2026-11-03T12:00:00Z');
const BENIGN = 'The cabinet is blue.';
const ownQuestions = [
  'What did we spned at the warehouse sept and oct combined?',
  'What do we owe on the cards altogether?',
  'Largest processor payout this year?',
  'Processor payoouts by month this year?',
  'Oct versus sept spending for the shop?',
  'This q versus last q, money in?',
  'How much did the store move to personal this yr?',
  'What is on the travel card right now?',
  'How much did the business spend on ads in q3?',
  'What did the payment processor pay out in October?',
  'Split last month between business and personal?',
  'Which charges showed up as ADVERT on the cards last month?',
];
const baseRecords = () => [
  { title: 'Tax return ARCHIVE_TAX', content: 'Form 1040 tax return ARCHIVE_TAX_BODY', id: 'tax-locator' },
  { title: 'Credit report ARCHIVE_CREDIT', content: 'Consumer credit report ARCHIVE_CREDIT_BODY', id: 'credit-locator' },
  { title: 'Passport ARCHIVE_IDENTITY', content: 'Passport number: ARCHIVE_IDENTITY_BODY', id: 'identity-locator' },
  { title: 'Archived access note ARCHIVE_CREDENTIAL', content: 'ordinary staging text', id: 'credential-locator',
    legacyText: ['sk', 'proj', 'Q7mN2pR9sT4vW6xY8zA3bC5dE1fG0hJ2'].join('-') },
  { title: 'Older correspondence ARCHIVE_FIELDS', content: 'SSN: ' + ['321', '54', '9876'].join('-') + ' ARCHIVE_FIELDS_BODY', id: 'fields-locator' },
  { title: 'Cabinet note', content: BENIGN, id: 'benign-locator' },
];
const rejectedMarkers = rows => rows.filter(row => row.id !== 'benign-locator')
  .flatMap(row => [row.title, row.id, row.content, row.legacyText].filter(Boolean));
const containsNone = (text, markers, message) => assert.ok(markers.every(marker => !text.includes(marker)), message);

async function setup(t, records = baseRecords(), { refuse = false } = {}) {
  t.mock.method(Date, 'now', () => NOW);
  let network = 0, retrievals = 0, drafts = 0, verifiers = 0;
  const prompts = [];
  t.mock.method(globalThis, 'fetch', async () => { network++; throw new Error('network forbidden'); });
  const f = await createProductFixture({ env: {
    ADMIN_KEY: randomBytes(24).toString('hex'), SESSION_SIGNING_KEY: randomBytes(32).toString('hex'),
    BRAIN_TIMEZONE: 'UTC',
    AI: { async run(model, input) {
      if (String(model).includes('bge-')) return { data: [[0.1, 0.2, 0.3]] };
      const system = String(input.messages?.[0]?.content || '');
      const prompt = String(input.messages?.at(-1)?.content || '');
      prompts.push(system + '\n' + prompt);
      if (system.includes('verify a proposed answer')) {
        verifiers++;
        const answer = /PROPOSED ANSWER:\n([\s\S]*?)\n\nCITED DOCUMENTS:/.exec(prompt)?.[1] || '';
        return { response: { supported: true, complete: true,
          evidence: [...new Set([...answer.matchAll(/\[(\d+)\]/g)].map(m => Number(m[1])))],
          conflicts: [], reason: 'synthetic approval' } };
      }
      drafts++;
      if (refuse) return { response: 'The documents do not answer the question.' };
      const at = prompt.indexOf(BENIGN);
      const numbers = [...prompt.slice(0, at).matchAll(/^\[(\d+)\] \(/gm)];
      return { response: `${BENIGN} [${numbers.at(-1)?.[1] || 1}]` };
    } },
  } });
  t.after(() => f.close());
  f.raw("INSERT INTO sources(name,kind,status,created_at) VALUES ('records','gmail','ready','2026-11-03')");
  for (const record of records) {
    const response = await f.post('/api/admin/brain/ingest/batch', { docs: [{
      source_type: 'records', source_id: record.id, title: record.title, content: record.content,
      occurred_at: '2026-10-15', date_reliable: true, date_source: 'fixture:record_date',
      text_source: 'native', text_reliable: true,
      metadata: { evidence_lineage: { version: 1, kind: 'source_record' } },
    }] }, { 'X-Admin-Key': f.env.ADMIN_KEY });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).results[0].status, 'created', 'synthetic record was stored');
    // Model legacy storage without relaxing the current ingest credential gate.
    if (record.legacyText) f.raw('UPDATE chunks SET text=? WHERE doc_uid=(SELECT doc_uid FROM documents WHERE source_id=?)',
      record.legacyText, record.id);
  }
  f.raw('DELETE FROM vector_outbox');
  const vectorCount = f.first('SELECT COUNT(*) AS n FROM chunks').n;
  f.raw("UPDATE install_state SET vector_projection_status='verified', vector_projection_bootstrap_base_count=? WHERE id=1", vectorCount);
  f.env.VECTORIZE.describe = async () => ({ vectorCount, processedUpToMutation: null });
  f.env.VECTORIZE.query = async () => {
    retrievals++;
    return { matches: f.rows('SELECT chunk_uid AS id FROM chunks') };
  };
  const ask = async (q, filters = {}) => {
    const before = retrievals;
    const response = await f.post('/api/rag/think', { q, ...filters }, { 'X-Admin-Key': f.env.ADMIN_KEY });
    assert.equal(response.status, 200);
    assert.equal(network, 0, 'no external fetch was attempted');
    return { body: await response.json(), retrievals: retrievals - before };
  };
  return { f, ask, prompts, counts: () => ({ drafts, verifiers, retrievals, network }) };
}

function localAdapter(t, bodies) {
  mkdirSync(SCRATCH, { recursive: true });
  const root = realpathSync.native(mkdtempSync(join(SCRATCH, 'adapter-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home-fixture');
  mkdirSync(home);
  const manifest = join(root, 'brain.manifest.json');
  writeFileSync(manifest, JSON.stringify({ operations: { admin_key_secret: null } }));
  writeFileSync(join(root, '.brain-admin-key'), randomBytes(24).toString('hex'), { mode: 0o600 });
  const launchctl = join(root, 'launchctl-fixture');
  writeFileSync(launchctl, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  writeFileSync(join(root, 'responses.json'), JSON.stringify(bodies));
  const loader = join(root, 'fetch-fixture.mjs');
  writeFileSync(loader, `import { readFileSync, appendFileSync } from 'node:fs';
const bodies = JSON.parse(readFileSync(new URL('./responses.json', import.meta.url), 'utf8'));
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://brain.invalid/api/rag/think') throw Error('unexpected fixture route');
  const { q } = JSON.parse(init.body);
  appendFileSync(new URL('./calls.txt', import.meta.url), q + '\\n');
  return new Response(JSON.stringify(bodies[q]), { headers: { 'Content-Type': 'application/json' } });
};\n`);
  if (process.platform !== 'win32') {
    const quiet = spawnSync('/bin/sh', ['-c', `while [ -e ${resolve(ROOT, '..', 'MAC-QUIET')} ]; do sleep 60; done`],
      { env: { PATH: process.env.PATH, HOME: home }, timeout: 60000 });
    assert.equal(quiet.status, 0, 'MAC-QUIET released before adapter Node starts');
  }
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: root,
    BRAIN_URL: 'https://brain.invalid', BRAIN_NAME: 'fixture', BRAIN_MANIFEST: manifest,
    BRAIN_NO_WRANGLER_LOGIN: '1', BRAIN_TEST_LAUNCHCTL: launchctl };
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) {
    if (process.platform === 'win32' && process.env[key]) env[key] = process.env[key];
  }
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(join(ROOT, 'test/fixtures/cli-side-effect-tripwire.mjs')).href,
    '--import', pathToFileURL(loader).href,
    join(ROOT, 'components/brain-mcp.mjs')], {
    cwd: ROOT, env,
    input: Object.keys(bodies).map((q, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1,
      method: 'tools/call', params: { name: 'brain_think', arguments: { q } } })).join('\n') + '\n',
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(child.status, 0, `local stdio adapter completed: ${child.error?.message ?? ''}\n${child.stderr ?? ''}`);
  assert.equal(readFileSync(join(root, 'calls.txt'), 'utf8').trim().split('\n').length,
    Object.keys(bodies).length, 'all adapter calls reached the injected transport');
  return child.stdout.trim().split('\n').map(JSON.parse).filter(row => row.id)
    .map(row => JSON.parse(row.result.content[0].text));
}

for (const refuse of [false, true]) test(`mixed candidates stay private through Worker and local adapter (${refuse ? 'refusal' : 'answer'})`, async t => {
  const records = baseRecords();
  const markers = rejectedMarkers(records);
  const fixture = await setup(t, records, { refuse });
  const bodies = {};
  for (const q of ownQuestions) {
    const { body, retrievals } = await fixture.ask(q);
    assert.ok(retrievals > 0, 'real document retrieval ran, including missed admission wording');
    assert.ok(fixture.prompts.length > 0, 'the provider input decision was reached');
    containsNone(fixture.prompts.join('\n'), markers, 'provider prompts must exclude every rejected record');
    assert.equal(body.withheld_documents?.examined_count, records.length, `every retrieved candidate was examined in arm ${ownQuestions.indexOf(q)}`);
    assert.equal(body.withheld_documents.count, records.length - 1);
    assert.equal(body.results.length, 1, 'the benign control remains readable');
    assert.ok(body.results[0].snippet.includes(BENIGN));
    containsNone(JSON.stringify(body), markers, 'Worker response metadata and citations must exclude rejected records');
    if (refuse) assert.ok(!body.citations.length);
    else assert.ok(body.answer?.includes(BENIGN), 'the accepted answer control must remain supported');
    bodies[q] = body;
  }
  const output = localAdapter(t, bodies);
  assert.equal(output.length, ownQuestions.length);
  for (const body of output) {
    containsNone(JSON.stringify(body), markers, 'local serialized output must exclude rejected records');
    assert.equal(body.withheld_documents?.count, records.length - 1, 'withholding disclosure survives local serialization');
  }
  assert.ok(fixture.counts().drafts >= ownQuestions.length);
});

test('all-sensitive evidence reports withholding without a no-records claim', async t => {
  const records = baseRecords().filter(row => row.id !== 'benign-locator');
  const fixture = await setup(t, records);
  const { body, retrievals } = await fixture.ask(ownQuestions[0]);
  assert.ok(retrievals > 0);
  assert.equal(body.withheld_documents?.examined_count, records.length);
  assert.equal(body.withheld_documents.count, records.length);
  assert.equal(fixture.counts().drafts, 0, 'no answer model receives withheld-only evidence');
  assert.equal(body.answer, null);
  assert.equal(body.status, 'answer_withheld');
  assert.equal(body.evidence_gate?.supported, false);
  assert.equal(body.evidence_gate.complete, false);
  assert.equal(body.evidence_gate.reason, 'sensitive_documents_withheld');
  assert.ok(!body.results.length && !body.citations.length);
  assert.ok(!body.gaps.some(gap => gap.type === 'no_results'));
  assert.match(body.notice, /withheld/i);
  containsNone(JSON.stringify(body), rejectedMarkers(records), 'all-sensitive response is content-free');
  const [out] = localAdapter(t, { [ownQuestions[0]]: body });
  assert.equal(out.withheld_documents?.count, records.length);
  assert.match(out.note, /withheld/i);
  assert.doesNotMatch(out.note, /FOUND 0|No match in this search/i);
});

test('benign document questions preserve their response without a disclosure', async t => {
  const fixture = await setup(t, [baseRecords().at(-1)]);
  for (const q of [...ownQuestions, 'What color is the cabinet in the note?', 'What does the cabinet note say?']) {
    const { body, retrievals } = await fixture.ask(q);
    assert.ok(retrievals > 0);
    assert.ok(body.answer?.includes(BENIGN));
    assert.equal(body.withheld_documents, undefined);
    assert.equal(body.results.length, 1);
    assert.ok(!body.gaps.some(gap => gap.type === 'sensitive_documents_withheld'));
  }
});

test('local candidate export independently rejects sensitive marker bytes', async t => {
  const records = baseRecords();
  const fixture = await setup(t, records, { refuse: true });
  const { body, retrievals } = await fixture.ask(ownQuestions[0]);
  assert.ok(retrievals > 0, 'export control reached nonempty real retrieval');
  const [out] = localAdapter(t, { [ownQuestions[0]]: body });
  assert.ok(out.results.some(row => row.snippet.includes(BENIGN)), 'benign export control is nonempty');
  containsNone(JSON.stringify(out), rejectedMarkers(records), 'local export contains no rejected marker bytes');
  assert.equal(out.results.length, 1, 'only the benign candidate is exported');
});

test('mixed refusal retains withholding status and never assigns absence confidence', async t => {
  const fixture = await setup(t, baseRecords(), { refuse: true });
  const { body, retrievals } = await fixture.ask(ownQuestions[0]);
  assert.ok(retrievals > 0);
  assert.equal(body.results.length, 1, 'a permitted candidate reached the refusal decision');
  assert.equal(body.withheld_documents?.count, 5);
  assert.equal(body.status, 'answer_withheld');
  assert.equal(body.confidence, undefined, 'filtered evidence cannot certify an absence');
  assert.equal(body.answer, null);
  assert.match(body.notice, /withheld/i);
});

test('the screen covers complete legacy surfaces and exact scope without exporting findings', () => {
  const fields = baseRecords().find(row => row.id === 'fields-locator').content;
  const credential = baseRecords().find(row => row.legacyText).legacyText;
  const surfaces = [
    { title: 'ordinary', snippet: 'x'.repeat(1100) + ' ' + fields },
    { title: 'ordinary', snippet: BENIGN, uri: 'https://archive.invalid/credit-report/record' },
    { title: 'ordinary', snippet: BENIGN, source_id: credential },
    { title: 'ordinary', snippet: BENIGN, authority_meta: { nested: { [fields]: 'value' } } },
    { title: 'ordinary', snippet: BENIGN, query_variant: { matched: fields } },
    { title: 'ordinary', snippet: BENIGN, metadata: { ssn: ['321', '54', '9876'].join('-') } },
    { title: 'ordinary', snippet: BENIGN, metadata: { passport_number: 'SYNTHETIC_ID_RECORD' } },
    { title: '2025_Form_1040.pdf', snippet: BENIGN },
  ];
  const policy = filterThinkCandidates([...surfaces, { title: 'Cabinet note', snippet: BENIGN }], { question: ownQuestions[0] });
  assert.equal(policy.withheld.examined_count, surfaces.length + 1);
  assert.equal(policy.withheld.count, surfaces.length);
  assert.equal(policy.rows.length, 1, 'complete-surface decision keeps the green control');
  assert.deepEqual(Object.keys(policy.withheld).sort(), ['count', 'examined_count', 'reasons']);
  containsNone(JSON.stringify(policy.withheld), [fields, credential], 'withholding receipt has counts and closed reasons only');

  const row = { title: 'Passport', snippet: 'Passport number: SYNTHETIC_ID_RECORD' };
  for (const q of ['What does my passport say?', 'Show my passport', 'Open the passport']) {
    assert.equal(filterThinkCandidates([row], { question: q }).rows.length, 1, 'a direct particular record request is preserved');
  }
  for (const q of ['Compare all passports', 'How much did I spend on passport fees?', 'Show my passport and all tax returns']) {
    const result = filterThinkCandidates([row], { question: q });
    assert.equal(result.withheld.examined_count, 1, 'scope rejection reached the candidate decision');
    assert.equal(result.rows.length, 0);
  }
  const contaminated = { ...row, snippet: credential };
  const result = filterThinkCandidates([contaminated], { question: 'Show my passport' });
  assert.equal(result.withheld.examined_count, 1);
  assert.equal(result.rows.length, 0, 'confirmed credentials stay withheld for an explicit record request');
});

test('tax exception retains the existing entity/year/form scope checks', () => {
  const question = 'What does Shop Entity 2025 Form 1040 report?';
  const taxQuestion = taxQuestionScopeAssessment(question);
  assert.equal(taxQuestion.resolved, true, 'the existing tax decision resolves the synthetic scope');
  const rows = [
    { title: 'Shop Entity 2025 Form 1040', snippet: 'Tax return requested record' },
    { title: 'Other Entity 2025 Form 1040', snippet: 'Tax return wrong entity' },
    { title: 'Shop Entity 2024 Form 1040', snippet: 'Tax return wrong year' },
    { title: 'Shop Entity 2025 Form 1065', snippet: 'Tax return wrong form' },
  ];
  const result = filterThinkCandidates(rows, { question, taxQuestion });
  assert.equal(result.withheld.examined_count, rows.length);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0], rows[0], 'exact matching filing remains unchanged');
});

test('public tax candidates retain the authoritative scope assessment after private headers are removed', async t => {
  const records = [{ title: 'Owner 2025 Form 1040', id: 'owner-return',
    content: 'Taxpayer: Fixture Owner\n2025 Form 1040\n' + BENIGN }];
  const fixture = await setup(t, records);
  const { body, retrievals } = await fixture.ask('What does my 2025 Form 1040 report?');
  assert.ok(retrievals > 0);
  assert.equal(body.results.length, 1, 'the previously permitted owner filing remains readable');
  assert.equal(body.results[0].authority.tax_scope.matched, true, 'real tax authority matched before export');
  assert.equal(body.withheld_documents, undefined);
  assert.ok(fixture.prompts.some(prompt => prompt.includes('Taxpayer: Fixture Owner')));

  const question = 'What does Shop Entity 2025 Form 1040 report?';
  const taxQuestion = taxQuestionScopeAssessment(question);
  const forgedTitle = { title: 'Shop Entity 2025 Form 1040', snippet: 'Tax return',
    authority: { tax_scope: { applicable: true, matched: false } } };
  const rejected = filterThinkCandidates([forgedTitle], { question, taxQuestion });
  assert.equal(rejected.withheld.examined_count, 1);
  assert.equal(rejected.rows.length, 0, 'a matching title cannot overrule a rejected native header');
});

test('the offline chain discovers this sensitivity regression', () => {
  assert.ok(POST_LAUNCHER_TEST_COMMANDS.includes(renderCliCommands('node --test worker/test/sensitive-fallback.test.mjs')));
});

test('scanner-flagged credentials and capability URLs stay withheld even for a particular record request', () => {
  const suspected = ['Bearer', ['Q7mN2pR9sT4vW6xY8zA3bC5dE1fG0hJ2', 'nP4xR6sT8vY0'].join('')].join(' ');
  const scan = scanEnvelope({ content: suspected });
  assert.equal(scan.shouldFlag, true, 'the actual credential scanner reached a flagged fixture');
  assert.equal(scan.shouldRefuse, false, 'this arm exercises suspected credentials');
  const capability = ['https:', '', ['billing', 'stripe', 'com'].join('.'), 'p', 'session',
    ['Q7mN2pR9sT4vW6xY8zA3bC5dE1fG0hJ2', 'nP4xR6sT8vY0'].join('')].join('/');
  for (const snippet of [suspected, capability]) {
    const result = filterThinkCandidates([{ title: 'Passport', snippet }], { question: 'Show my passport' });
    assert.equal(result.withheld?.examined_count, 1);
    assert.equal(result.rows.length, 0);
    assert.deepEqual(result.withheld.reasons, ['credential']);
  }
});

test('an explicit sensitive-record request keeps only the requested record, never credentials', async t => {
  const fixture = await setup(t);
  const { body, retrievals } = await fixture.ask('Show me the document titled "Credit report ARCHIVE_CREDIT".');
  assert.ok(retrievals > 0);
  assert.equal(body.results.length, 2, 'requested credit report and benign evidence remain');
  assert.ok(body.results.some(row => row.title === 'Credit report ARCHIVE_CREDIT'));
  assert.ok(fixture.prompts.some(prompt => prompt.includes('ARCHIVE_CREDIT_BODY')));
  assert.equal(body.withheld_documents?.count, 4);
  containsNone(JSON.stringify(body), rejectedMarkers(baseRecords()).filter(marker => !/CREDIT|credit-locator/.test(marker)),
    'a narrow record request cannot release unrelated sensitive records or credentials');
});

test('supported ledger control never enters document retrieval', async t => {
  const fixture = await setup(t);
  seedOwnedEntity(fixture.f, 'owner', 'Owner');
  fixture.f.raw(`INSERT INTO fin_accounts
    (account_slug,entity_slug,account_kind,balance_role,feed_mode,provenance,basis_state,recorded_at)
    VALUES ('cash','owner','checking','asset','live','owner_stated','confirmed',?)`, NOW);
  fixture.f.raw(`INSERT INTO fin_balance_snapshots
    (account_slug,as_of_date,current_minor,available_minor,provenance,basis_state,recorded_at)
    VALUES ('cash','2026-11-03',12345,12345,'owner_stated','confirmed',?)`, NOW);
  const { body, retrievals } = await fixture.ask('What is my current balance?');
  assert.equal(body.ledger?.kind, 'balance', 'the successful ledger decision was reached');
  assert.ok(fixture.f.seen.sql.some(sql => /JOIN fin_balance_snapshots/.test(sql)), 'ledger facts were read');
  assert.equal(retrievals, 0);
  assert.equal(fixture.counts().drafts, 0);
  assert.equal(body.withheld_documents, undefined);
});

// The source filter uses the real fallback route even when ledger intent is
// optional. Each control changes only the requested object, not the records.
const incidentalRequests = [
  ['Passport', 'What is my spending on passport fees?'],
  ['2023 Form 1065', 'What is my spending on Form 1065 preparation fees?'],
  ['2023 Form 1040 income', 'Show my income'],
  ...['is', 'was', 'are', 'were'].map(verb =>
    ['Passport', `What ${verb} my spending on passport replacement services?`]),
  ...['show', 'read', 'open'].flatMap(verb => ['income', 'balance', 'spending', 'wages', 'revenue'].map(subject =>
    [`2023 Form 1040 ${subject}`, `${verb} my ${subject}`])),
  ['Passport fees', 'What amount is on my passport fees?'],
  ['2023 Form 1065 preparation fees', 'What amount is on my Form 1065 preparation fees?'],
];
for (const [title, question] of incidentalRequests) test(`record intent binds the requested object: ${question}`, async t => {
  const marker = 'PRIVATE_RECORD_CONTENTS';
  const records = [{ title, id: 'private-record', content: marker }, baseRecords().at(-1)];
  const fixture = await setup(t, records);
  const bodies = {};
  const form = /Form (\d{4})/.exec(title)?.[1];
  const explicit = form ? `What amount is on our 2023 Form ${form}?`
    : `Show me the document titled "${title}".`;
  const admitted = await fixture.ask(explicit, { source: 'records' });
  assert.ok(admitted.retrievals > 0, 'explicit green control reached retrieval');
  assert.ok(admitted.body.results.some(row => row.snippet.includes(marker)), 'explicit record control is admitted');
  assert.ok(fixture.prompts.some(prompt => prompt.includes(marker)), 'explicit control reached provider input');
  fixture.prompts.length = 0;
  const { body, retrievals } = await fixture.ask(question, { source: 'records' });
  assert.ok(retrievals > 0, 'ordinary money question reached nonempty real retrieval');
  assert.equal(body.withheld_documents?.examined_count, records.length, 'all retrieved candidates reached the policy');
  assert.equal(body.withheld_documents.count, 1);
  assert.ok(fixture.prompts.length > 0, 'benign evidence reached provider input');
  containsNone(fixture.prompts.join('\n'), [marker], 'provider input excludes private contents');
  containsNone(JSON.stringify(body), [marker, title, 'private-record'], 'results, citations and response metadata exclude the record');
  assert.equal(body.results.length, 1);
  assert.ok(body.results[0].snippet.includes(BENIGN), 'benign control remains visible');
  bodies[question] = body;
  bodies[explicit] = admitted.body;
  const output = localAdapter(t, bodies);
  assert.equal(output.length, 2);
  containsNone(JSON.stringify(output[0]), [marker, title, 'private-record'], 'serialized MCP output excludes the record');
  assert.ok(JSON.stringify(output[1]).includes(marker), 'serialized explicit control remains visible');
});

test('a passport contents request remains explicit on the real route', async t => {
  const fixture = await setup(t, [{ title: 'Passport', id: 'passport-record', content: 'EXPLICIT_PASSPORT_CONTENTS' }, baseRecords().at(-1)]);
  const { body, retrievals } = await fixture.ask('What expiry date is on my passport?', { source: 'records' });
  assert.ok(retrievals > 0);
  assert.equal(body.withheld_documents, undefined);
  assert.ok(body.results.some(row => row.snippet.includes('EXPLICIT_PASSPORT_CONTENTS')));
});

for (const [form, description] of [['1065', 'partnership return'], ['1120-S', 'corporate return'],
  ['1040', 'individual tax return'], ['K-1', 'partner allocation statement'],
  ['W-2', 'annual wage statement'], ['1099', 'annual income statement']]) {
  for (const question of [
    `What amount is on our ${description} for 2023?`,
    `What does my ${description} for 2023 report?`,
    `What amount is on Store Entity's 2023 ${description}?`,
  ]) test(`described-return route uses the production scope condition: ${question}`, async t => {
    const taxQuestion = taxQuestionScopeAssessment(question, { owner: 'Fixture Owner', now: NOW, timeZone: 'UTC' });
    const fixture = await setup(t, [{ title: `Store Entity 2023 Form ${form} ${description}`,
      id: 'described-return', content: `Taxpayer: Store Entity\n2023 Form ${form}\nDESCRIBED_RETURN_CONTENTS` }, baseRecords().at(-1)]);
    const { body, retrievals } = await fixture.ask(question, { source: 'records' });
    if (taxQuestion.applicable && !taxQuestion.resolved) {
      assert.equal(body.evidence_gate?.reason, 'tax question scope is unresolved', 'real early scope decision reached');
      assert.ok(body.gaps.some(gap => gap.type === 'tax_question_scope_unresolved'));
      assert.equal(retrievals, 0, 'unresolved scope cannot grant a candidate capability');
      assert.deepEqual(body.results, []);
      assert.equal(fixture.prompts.length, 0);
    } else {
      assert.ok(retrievals > 0, 'described record reached retrieval under the real production condition');
      assert.ok(body.results.some(row => row.snippet.includes('DESCRIBED_RETURN_CONTENTS')));
      assert.equal(body.withheld_documents, undefined);
    }
    const control = await fixture.ask('Show me the document titled "Cabinet note".', { source: 'records' });
    assert.ok(control.retrievals > 0, 'same route and records have a successful retrieval control');
    assert.ok(control.body.results.some(row => row.snippet.includes(BENIGN)));
  });
}

// A container word cannot identify the sensitive kind containing it. Every arm
// keeps the same stored candidates and changes only the requested object.
const containerRequests = [
  ['Social security card', 'card'],
  ['Social security card', 'security card'],
  ['Identity document', 'document'],
  ['Credit report', 'report'],
  ['Birth certificate', 'certificate'],
  ['Passport file', 'file', 'Passport'],
  ['Passport record', 'record', 'Passport'],
  ['Passport statement', 'statement', 'Passport'],
  ["Driver's license", 'license'],
  ['National ID', 'id'],
  ['Consumer report', 'report'],
  ['Identity card', 'card'],
  ['Credit reports', 'reports'],
  ['Tax return', 'return', '2023 Form 1040'],
  ['2023 Form 1099', 'form'],
  ['Social security card and credit report', 'social security card'],
];
for (const [title, container, kind = title] of containerRequests) {
  const questions = [`Show my ${container}`, `Read my ${container}`, `Open my ${container}`];
  if (!title.includes(' and ')) questions.unshift(`What balance is on my ${container}?`);
  for (const question of questions) {
    test(`container overlap cannot identify a sensitive record: ${title}: ${question}`, async t => {
      const marker = 'PRIVATE_IDENTITY_CONTENTS';
      const fixture = await setup(t, [{ title, id: 'identity-record', content: marker }, baseRecords().at(-1)]);
      const explicit = question.replace(container, question.startsWith('What ') ? kind
        : /\btax return\b/i.test(title) ? kind : title);
      const green = await fixture.ask(explicit, { source: 'records' });
      assert.ok(green.retrievals > 0, 'explicit same-record control reached retrieval');
      assert.ok(green.body.results.some(row => row.snippet.includes(marker)), 'explicit record is visible');
      assert.ok(fixture.prompts.some(prompt => prompt.includes(marker)), 'explicit record reached the provider');
      fixture.prompts.length = 0;
      const { body, retrievals } = await fixture.ask(question, { source: 'records' });
      const scope = taxQuestionScopeAssessment(question, { owner: 'Fixture Owner', now: NOW, timeZone: 'UTC' });
      if (scope.applicable && !scope.resolved) {
        assert.equal(body.evidence_gate?.reason, 'tax question scope is unresolved', 'early tax decision remains authoritative');
        assert.ok(body.gaps.some(gap => gap.type === 'tax_question_scope_unresolved'));
        assert.equal(retrievals, 0);
        assert.deepEqual(body.results, []);
        assert.equal(fixture.prompts.length, 0);
      } else {
        assert.ok(retrievals > 0, 'generic request reached real nonempty retrieval');
        assert.equal(body.withheld_documents?.examined_count, 2, 'both records reached the candidate decision');
        assert.equal(body.withheld_documents.count, 1);
        assert.deepEqual(body.withheld_documents.reasons, ['unsolicited_sensitive_record']);
        assert.ok(fixture.prompts.length > 0, 'benign evidence still reached provider input');
        assert.equal(body.results.length, 1);
        assert.ok(body.results[0].snippet.includes(BENIGN), 'benign row remains visible');
      }
      containsNone(fixture.prompts.join('\n'), [marker], 'provider prompts exclude identity contents');
      containsNone(JSON.stringify(body), [marker, title, 'identity-record'], 'response and citations exclude identity contents');
      assert.ok(green.body.results.some(row => row.snippet.includes(BENIGN)), 'same-record benign control is visible');
      if (!/\btax return\b/i.test(title)) {
        const quoted = await fixture.ask(`Show me the document titled "${title}".`, { source: 'records' });
        assert.ok(quoted.retrievals > 0, 'quoted exact-title control reaches retrieval');
        assert.ok(quoted.body.results.some(row => row.snippet.includes(marker)), 'quoted exact title admits the same record');
      }
      const output = localAdapter(t, { [question]: body, [explicit]: green.body });
      assert.equal(output.length, 2);
      containsNone(JSON.stringify(output[0]), [marker, title, 'identity-record'], 'serialized MCP output excludes identity contents');
      assert.ok(JSON.stringify(output[1]).includes(marker), 'serialized exact-record control remains visible');
    });
  }
}

// Exact identification precedes kind grammar. Arbitrary suffixes are title
// data, so adding a suffix to a record must not change its solicitation.
for (const suffix of ['scan', 'copy', 'archive', 'image', 'backup', '2023', 'edition alpha', 'fees']) {
  const title = `Passport ${suffix}`;
  for (const question of [`Show my ${title}`, `Please show me our ${title}.`, `Open the ${title}`,
    `Read my ${title}`, `What does my ${title} say?`]) {
    test(`direct exact titles preserve arbitrary suffixes: ${question}`, async t => {
      const marker = 'EXACT_TITLE_IDENTITY_CONTENTS';
      for (const includeBenign of [false, true]) {
        const records = [{ title, id: 'exact-record', content: marker }, ...(includeBenign ? [baseRecords().at(-1)] : [])];
        const fixture = await setup(t, records, { refuse: true });
        const quoted = `Show me the document titled "${title}".`;
        const bodies = {};
        for (const q of [quoted, question]) {
          fixture.prompts.length = 0;
          const { body, retrievals } = await fixture.ask(q, { source: 'records' });
          assert.ok(retrievals > 0, 'exact-title request reached the real candidate decision');
          assert.ok(body.results.some(row => row.snippet.includes(marker)), 'direct and quoted exact-title paths admit the same record');
          assert.equal(body.withheld_documents, undefined);
          assert.ok(fixture.prompts.some(prompt => prompt.includes(marker)), 'admitted title reaches provider input');
          bodies[q] = body;
        }
        fixture.prompts.length = 0;
        const ordinary = 'What balance is on my card?';
        const { body, retrievals } = await fixture.ask(ordinary, { source: 'records' });
        assert.ok(retrievals > 0, 'unrelated control reached nonempty retrieval');
        assert.equal(body.withheld_documents?.examined_count, records.length);
        assert.equal(body.withheld_documents.count, 1);
        containsNone(fixture.prompts.join('\n'), [marker], 'ordinary control never forwards identity contents');
        containsNone(JSON.stringify(body), [marker, title, 'exact-record'], 'ordinary response never exports identity contents');
        if (includeBenign) assert.ok(body.results.some(row => row.snippet.includes(BENIGN)), 'same-record benign control remains visible');
        else assert.equal(body.evidence_gate.reason, 'sensitive_documents_withheld', 'sensitive-only control reaches the withholding decision');
        bodies[ordinary] = body;
        const output = localAdapter(t, bodies);
        assert.equal(output.length, 3);
        assert.ok(JSON.stringify(output[0]).includes(marker), 'quoted exact title survives serialized MCP output');
        assert.ok(JSON.stringify(output[1]).includes(marker), 'direct exact title survives serialized MCP output');
        containsNone(JSON.stringify(output[2]), [marker, title, 'exact-record'], 'ordinary serialized MCP output stays private');
      }
    });
  }
}
