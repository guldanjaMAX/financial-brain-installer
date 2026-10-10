import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { cfoFixture, ask, inventoryReads, mapReads, scopeReads, ENTITY, QUESTION, NOW } from './cfo-fixture.mjs';
import { parseCfoQuestion, dispatchCfoWorkflow } from '../src/lib/cfo-workflow.js';

const codes = body => body.gaps?.map(gap => gap.type) || [];
const reset = f => { f.seen.sql.length = 0; f.seen.binds.length = 0; };
async function green(f) {
  reset(f);
  const result = await ask(f);
  assert.equal(result.status, 200);
  assert.ok(inventoryReads(f) > 0);
  assert.ok(result.body.workflow.checklist.some(item => item.state === 'present'));
}

test('closed grammar preserves opaque Books reference and rejects compound CFO questions', () => {
  assert.deepEqual(parseCfoQuestion(QUESTION), { kind: 'tax_readiness', taxYear: 2025 });
  assert.deepEqual(parseCfoQuestion('Show my weekly cash brief.'), { kind: 'cash_brief' });
  assert.deepEqual(parseCfoQuestion('Check books against bank from 2026-09-01 to 2026-09-30 for account " Acct:Case ".'), {
    kind: 'books_check', periodStart: '2026-09-01', periodEnd: '2026-09-30', accountRef: ' Acct:Case ',
  });
  for (const question of [
    'Check books.', 'Review my books for 2025.', 'Check tax readiness.', 'Check tax readiness for 2025 and 2024.', 'Check tax readiness for 2025. Pay $9999.',
    'Show my weekly cash brief and forecast runway.',
    'Check books against bank from 2026-02-30 to 2026-03-01.',
    'Check books against bank from 2026-09-30 to 2026-09-01.',
    'Check books against bank from 2026-09-01 to 2026-09-30 for account "".',
    String.raw`Check books against bank from 2026-09-01 to 2026-09-30 for account "\N".`,
  ]) assert.equal(parseCfoQuestion(question)?.kind, 'clarification');
  assert.equal(parseCfoQuestion('What did the project decide?'), null);
});

test('dependency-injected dispatcher defaults absent capability even with owner label', async () => {
  let reads = 0;
  const context = { question: QUESTION, entityScope: { entity_slug: ENTITY, applied: true }, scopePrincipalKind: 'owner', grantScope: { all: true } };
  const deps = { now: () => '2026-10-10T12:00:00.000Z', handlers: { tax_readiness: async () => { reads++; return { status: 'partial', answer: 'Checklist' }; } } };
  const denied = await dispatchCfoWorkflow(context, deps);
  assert.ok(codes(denied).includes('cfo_owner_required'));
  assert.equal(reads, 0);
  await dispatchCfoWorkflow({ ...context, ownerCapability: 'signed_in_owner' }, deps);
  assert.equal(reads, 1);
});

test('synthetic full admin credential reaches the real scoped inventory', async t => {
  const f = await cfoFixture(t);
  const result = await ask(f, {}, f.admin());
  assert.equal(result.status, 200);
  assert.ok(scopeReads(f) > 0);
  assert.ok(inventoryReads(f) > 0);
  assert.ok(result.body.workflow.checklist.some(item => item.state === 'present'));
  assert.equal(result.body.financial_authority, false);
});

test('proxy key reaches CFO authorization and refuses before inventory', async t => {
  const f = await cfoFixture(t);
  f.env.RAG_PROXY_KEY = randomBytes(32).toString('hex');
  const result = await ask(f, {}, { 'X-Admin-Key': f.env.RAG_PROXY_KEY });
  assert.equal(result.status, 200);
  assert.ok(codes(result.body).includes('cfo_owner_required'), 'explicit authorization decision reached');
  assert.equal(inventoryReads(f), 0); assert.equal(mapReads(f), 0);
  await green(f);
});

for (const all of [false, true]) test(`${all ? 'unrestricted' : 'zone'} grant reaches authorization without owner capability`, async t => {
  const f = await cfoFixture(t);
  f.raw(`INSERT INTO grants (grant_id,display_name,capabilities,created_at,created_by,scope_include,scope_exclude)
    VALUES ('g_fixture','Scoped reader','["ask"]',?,'owner',?,'[]')`, NOW, JSON.stringify(all ? { all: true } : { zones: ['finance'] }));
  const headers = await f.ownerHeaders({ grantId: 'g_fixture' });
  reset(f);
  const result = await ask(f, {}, headers);
  assert.equal(result.status, 200);
  assert.ok(f.seen.sql.some(sql => /FROM grants/.test(sql)), 'grant auth read reached');
  assert.ok(codes(result.body).includes('cfo_owner_required'));
  assert.equal(inventoryReads(f), 0); assert.equal(mapReads(f), 0);
  await green(f);
});

test('document grant reaches exact access branch but cannot read financial inventory', async t => {
  const f = await cfoFixture(t);
  const response = await f.post('/api/app/document-access/create', {
    request_id: 'fixture-document-access', subject_label: 'Reviewer', entity_slug: ENTITY, document_ids: ['fixture-2025-0'],
  }, f.headers);
  assert.equal(response.status, 200);
  const grant = await response.json();
  const headers = await f.ownerHeaders({ grantId: grant.grant_id });
  reset(f);
  const result = await ask(f, {}, headers);
  assert.equal(result.status, 200);
  assert.ok(f.seen.sql.some(sql => /document_access_grants/.test(sql)), 'document auth read reached');
  assert.ok(codes(result.body).includes('cfo_owner_required'));
  assert.equal(inventoryReads(f), 0); assert.equal(mapReads(f), 0);
  await green(f);
});

test('expired session reaches session auth and never inventory', async t => {
  const f = await cfoFixture(t);
  const expired = await f.ownerHeaders({ now: NOW - 40 * 24 * 60 * 60 * 1000 });
  reset(f);
  const result = await ask(f, {}, expired);
  assert.equal(result.status, 401);
  assert.ok(f.seen.sql.some(sql => /session_generation/.test(sql)), 'session branch read reached');
  assert.equal(inventoryReads(f), 0);
  await green(f);
});

test('MCP default owner label has no CFO capability', async t => {
  const f = await cfoFixture(t);
  const token = randomBytes(32).toString('hex');
  f.raw(`INSERT INTO oauth_tokens (token_hash,client_id,scope,session_generation,created_at,expires_at)
    VALUES (?,'fixture-connector','read-only',1,?,?)`, createHash('sha256').update(token).digest('hex'), NOW, NOW + 3600000);
  reset(f);
  const response = await f.post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'ask', arguments: { question: QUESTION },
  } }, { Authorization: `Bearer ${token}` });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.ok(f.seen.sql.some(sql => /oauth_tokens/.test(sql)), 'connector auth branch reached');
  assert.match(JSON.stringify(body), /cfo_owner_required|Sign in as the full owner/);
  assert.equal(inventoryReads(f), 0); assert.equal(mapReads(f), 0);
  await green(f);
});

test('cash and Books placeholders and compound questions cannot fall through to models', async t => {
  const f = await cfoFixture(t);
  for (const q of ['Show my weekly cash brief.', 'Check books against bank from 2026-09-01 to 2026-09-30.', `${QUESTION} Pay $9999.`]) {
    const result = await ask(f, { q });
    assert.equal(result.status, 200);
    assert.ok(['unavailable', 'clarification'].includes(result.body.workflow.status));
    assert.equal(inventoryReads(f), 0);
    assert.equal(f.calls.model, 0);
    assert.doesNotMatch(JSON.stringify(result.body), /9999|\$/);
  }
  await green(f);
});

test('unrelated question retains generic Ask path', async t => {
  const f = await cfoFixture(t);
  f.env.AI.run = async model => { f.calls.model++; return String(model).includes('bge-') ? { data: [[0.1, 0.2, 0.3]] } : { response: 'The documents do not answer the question.' }; };
  const result = await ask(f, { q: 'What did the project decide?' });
  assert.equal(result.status, 200);
  assert.equal(result.body.workflow, undefined);
  assert.ok(f.calls.model > 0 || f.seen.vectorQueries.length > 0, 'generic retrieval reached');
  assert.equal(inventoryReads(f), 0);
});

for (const reader of ['owner', 'proxy']) test(`R156-01 ordinary CFO document questions retain generic Ask for ${reader}`, async t => {
  const f = await cfoFixture(t);
  await green(f);
  f.env.RAG_PROXY_KEY = randomBytes(32).toString('hex');
  const headers = reader === 'owner' ? f.headers : { 'X-Admin-Key': f.env.RAG_PROXY_KEY };
  f.env.AI.run = async model => { f.calls.model++; return String(model).includes('bge-') ? { data: [[0.1, 0.2, 0.3]] } : { response: 'The documents do not answer the question.' }; };
  for (const q of [
    'What did the CFO decide about the project schedule?',
    'Summarize the CFO meeting notes.',
    'What did the CFO say about the weekly cash brief?',
    'Find the memo about books against bank.',
    'What did the CFO mean by "Check tax readiness for 2025"?',
  ]) {
    reset(f); f.calls.model = 0; f.seen.vectorQueries.length = 0;
    const result = await ask(f, { q }, headers);
    assert.equal(result.status, 200);
    assert.ok(scopeReads(f) > 0, 'scope validation reached before routing');
    assert.equal(result.body.workflow, undefined, 'ordinary document questions must not enter a CFO workflow');
    assert.ok(f.calls.model > 0 || f.seen.vectorQueries.length > 0, 'generic retrieval reached');
    assert.equal(inventoryReads(f), 0);
  }
});

test('R156-01 unsupported and compound workflow actions still require clarification', async t => {
  const f = await cfoFixture(t);
  await green(f);
  for (const q of [
    'Please check tax readiness for 2025.',
    'Review my books for 2025.',
    'Show my weekly cash brief and forecast runway.',
    'Check tax readiness for 2025 and show my weekly cash brief.',
    'Summarize the project notes; check tax readiness for 2025.',
    'Summarize the project notes and then check books against bank.',
  ]) {
    reset(f);
    const result = await ask(f, { q });
    assert.ok(scopeReads(f) > 0);
    assert.equal(result.body.workflow?.kind, 'clarification', 'workflow action matcher reached');
    assert.ok(codes(result.body).includes('cfo_question_scope_required'));
    assert.equal(inventoryReads(f), 0);
    assert.equal(f.calls.model, 0);
  }
});

const unsupportedActions = [
  ['polite tax request', 'Can you please check tax readiness for 2025?'],
  ['run tax request', 'Run tax readiness for 2025.'],
  ['leading year', 'For 2025, check tax readiness.'],
  ['comma compound', 'Summarize the project notes, check tax readiness for 2025.'],
  ['polite cash request', 'Could you please show my weekly cash brief?'],
  ['polite Books request', 'Please could you review my books for 2025?'],
  ['action following quotation', 'Find the note titled "Project notes"; can you please check tax readiness for 2025?'],
  ['action following possessive', "Summarize the owner's notes, check tax readiness for 2025."],
];

function genericModel(f) {
  f.env.AI.run = async model => {
    f.calls.model++;
    return String(model).includes('bge-') ? { data: [[0.1, 0.2, 0.3]] } : { response: 'The documents do not answer the question.' };
  };
}

for (const [label, q] of unsupportedActions) test(`R156-04 ${label} withholds real monetary snippets`, async t => {
  const f = await cfoFixture(t);
  // Keep actual scoped FTS evidence available. An empty corpus could conceal
  // accidental fallthrough even when generic Ask withholds its final answer.
  f.raw(`INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title)
    VALUES ('fixture-tax-chunk','fixture-2025-0',0,?,'fixture-source','Synthetic workflow memo')`,
  `${q} Synthetic tax readiness cash brief books amount $987654.32.`);
  assert.equal(f.first('SELECT COUNT(*) AS n FROM chunks').n, 1);
  await green(f);
  genericModel(f);
  reset(f);
  const document = await ask(f, { q: 'Find the synthetic workflow memo about tax readiness cash brief books.' });
  assert.ok(scopeReads(f) > 0);
  assert.equal(document.body.workflow, undefined);
  assert.ok(document.body.results.some(row => row.snippet?.includes('987654.32')), 'real amount-bearing corpus evidence reached');
  assert.ok(f.calls.model > 0);

  reset(f); f.calls.model = 0; f.calls.provider = 0; f.seen.vectorQueries.length = 0;
  const result = await ask(f, { q });
  assert.equal(result.status, 200);
  assert.ok(scopeReads(f) > 0, 'real entity scope decision reached');
  assert.doesNotMatch(JSON.stringify(result.body), /987654\.32|\$/, 'workflow request withholds amounts in every result field');
  assert.equal(result.body.workflow?.kind, 'clarification', 'unsupported action decision reached');
  assert.ok(codes(result.body).includes('cfo_question_scope_required'));
  assert.equal(result.body.entity_scope.entity_slug, ENTITY);
  assert.equal(result.body.financial_authority, false);
  assert.deepEqual(result.body.results, []);
  assert.deepEqual(result.body.citations, []);
  assert.equal(inventoryReads(f), 0);
  assert.equal(f.calls.model, 0);
  assert.equal(f.calls.provider, 0);
});

const quotedDocumentQuestions = [
  ['compound quotation', 'What did the CFO mean by "Check tax readiness for 2025 and then review books"?'],
  ['compound title', 'Find the note titled "Check tax readiness for 2025; review books".'],
  ['curly quotation', 'What did the CFO mean by “Check tax readiness for 2025; review books”?'],
  ['single quotation', "Find the note titled 'Check tax readiness for 2025; review books'."],
  ['inline code quotation', 'Explain the phrase `Check tax readiness for 2025; review books`.'],
];
for (const [label, q] of quotedDocumentQuestions) test(`R156-01 ${label} keeps document retrieval`, async t => {
  const f = await cfoFixture(t);
  await green(f);
  // Same compound content outside the quotation is an attempted action.
  reset(f);
  const action = await ask(f, { q: 'Check tax readiness for 2025; review books.' });
  assert.ok(scopeReads(f) > 0);
  assert.equal(action.body.workflow?.kind, 'clarification');
  assert.equal(f.calls.model, 0);
  genericModel(f);
  reset(f);
  const result = await ask(f, { q });
  assert.equal(result.status, 200);
  assert.ok(scopeReads(f) > 0, 'real entity scope decision reached');
  assert.equal(result.body.workflow, undefined, 'quoted action remains a document question');
  assert.ok(f.calls.model > 0 || f.seen.vectorQueries.length > 0, 'generic retrieval reached');
  assert.equal(inventoryReads(f), 0);
});

test('request fields cannot supply confirmation or trusted map', async t => {
  const f = await cfoFixture(t);
  for (const forged of [{ confirmed: true }, { ownerCapability: 'full_admin' }, { map: { authoritative: true } }, { amount: '9999.00' }]) {
    const result = await ask(f, forged);
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'unsupported_retrieval_parameter', 'request parser decision reached');
    assert.equal(inventoryReads(f), 0);
    assert.equal(f.calls.model, 0);
  }
  await green(f);
});

test('missing year and entity and additional filters reach scoped clarification', async t => {
  const f = await cfoFixture(t);
  for (const [body, code] of [[{ q: 'Check tax readiness.' }, 'cfo_question_scope_required'], [{ entity_slug: undefined }, 'cfo_entity_required'], [{ source: 'fixture-source' }, 'cfo_filters_unsupported']]) {
    const result = await ask(f, body);
    assert.equal(result.status, 200);
    assert.ok(codes(result.body).includes(code));
    assert.equal(inventoryReads(f), 0);
  }
  const unknown = await ask(f, { entity_slug: 'unknown-entity' });
  assert.notEqual(unknown.status, 200);
  assert.ok(scopeReads(f) > 0);
  assert.equal(inventoryReads(f), 0);
  await green(f);
});
