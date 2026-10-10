import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { cfoFixture, ask, inventoryReads, mapReads, scopeReads, ENTITY, QUESTION, NOW } from './cfo-fixture.mjs';
import { parseCfoAction, dispatchCfoWorkflow } from '../src/lib/cfo-workflow.js';

const codes = body => body.gaps?.map(gap => gap.type) || [];
const reset = f => { f.seen.sql.length = 0; f.seen.binds.length = 0; };
async function green(f) {
  reset(f);
  const result = await ask(f);
  assert.equal(result.status, 200);
  assert.ok(inventoryReads(f) > 0);
  assert.ok(result.body.workflow.checklist.some(item => item.state === 'present'));
}

test('dependency-injected dispatcher defaults absent capability even with owner label', async () => {
  let reads = 0;
  const context = { action: { workflow: 'tax_evidence_checklist', entity: ENTITY, year: 2025 }, entityScope: { entity_slug: ENTITY, applied: true }, scopePrincipalKind: 'owner', grantScope: { all: true } };
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

test('MCP default owner tool does not expose structured workflow actions', async t => {
  const f = await cfoFixture(t);
  const token = randomBytes(32).toString('hex');
  f.raw(`INSERT INTO oauth_tokens (token_hash,client_id,scope,session_generation,created_at,expires_at)
    VALUES (?,'fixture-connector','read-only',1,?,?)`, createHash('sha256').update(token).digest('hex'), NOW, NOW + 3600000);
  reset(f);
  const response = await f.post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'ask', arguments: { workflow: 'tax_evidence_checklist', entity: ENTITY, year: 2025 },
  } }, { Authorization: `Bearer ${token}` });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.ok(f.seen.sql.some(sql => /oauth_tokens/.test(sql)), 'connector auth branch reached');
  assert.equal(body.result?.isError, true, 'MCP argument validation reached');
  assert.match(body.result.content[0].text, /a question is required/);
  assert.doesNotMatch(JSON.stringify(body), /tax_checks|pages_read/);
  assert.equal(inventoryReads(f), 0); assert.equal(mapReads(f), 0);
  await green(f);
});


const ACTION = { workflow: 'tax_evidence_checklist', entity: ENTITY, year: 2025 };
const genericAsk = (f, q, headers = f.admin()) => f.post('/api/rag/think', { q, entity_slug: ENTITY }, headers)
  .then(async response => ({ status: response.status, body: await response.json() }));
function genericModel(f) {
  f.env.AI.run = async model => {
    f.calls.model++;
    return String(model).includes('bge-') ? { data: [[0.1, 0.2, 0.3]] } : { response: 'The documents do not answer the question.' };
  };
}

test('R5 structured action reaches the populated workflow without a question', async t => {
  const f = await cfoFixture(t);
  const result = await ask(f, {}, f.admin());
  assert.equal(result.status, 200, 'typed action accepted');
  assert.ok(scopeReads(f) > 0);
  assert.ok(inventoryReads(f) > 0);
  assert.ok(result.body.workflow.checklist.some(item => item.state === 'present'));
  assert.equal(result.body.timing.stages.cfo_workflow.calls, 1);
  assert.equal(result.body.timing.stages.retrieval.calls, 0);
  assert.equal(result.body.workflow.tax_year, 2025);
  assert.deepEqual(result.body.entity_scope, { entity_slug: ENTITY, applied: true });
  assert.equal(result.body.financial_authority, false);
  assert.equal(f.calls.model, 0);
  assert.equal(f.calls.provider, 0);
});

test('R5 typed workflow wording stays on generic Ask', async t => {
  const f = await cfoFixture(t);
  await green(f); reset(f);
  genericModel(f);
  const result = await genericAsk(f, QUESTION);
  assert.equal(result.status, 200);
  assert.ok(scopeReads(f) > 0);
  assert.equal(result.body.workflow, undefined, 'free text must never choose a workflow');
  assert.equal(inventoryReads(f), 0);
  assert.ok(result.body.timing.stages.premise_temporal.calls > 0, 'normal Ask decision reached');
  assert.equal(Object.hasOwn(result.body.timing.stages, 'cfo_workflow'), false, 'unused optional span is absent');
});

// All previous execution and reported-command examples are now ordinary Ask.
// There is no classifier corpus or quotation/punctuation intent generator.
const freeTextForms = [
  QUESTION,
  'Check tax readiness.',
  'Check tax readiness for 2025 and 2024.',
  'Check tax readiness for 2025. Pay $9999.',
  'Can you please check tax readiness for 2025?',
  'Run tax readiness for 2025.',
  'For 2025, check tax readiness.',
  'For 2025: check tax readiness.',
  'Summarize the project notes, check tax readiness for 2025.',
  'Summarize the project notes and then check books against bank.',
  'Find the note titled "Project notes"; can you please check tax readiness for 2025?',
  "Summarize the owner's notes, check tax readiness for 2025.",
  'Please run "Check tax readiness for 2025; review books".',
  'Please run “Check tax readiness for 2025; review books”.',
  'Please run `Check tax readiness for 2025; review books`.',
  '“CHECK TAX READINESS FOR 2025.”',
  'Please execute: «check tax readiness for 2025; review books».',
  'Ｃｈｅｃｋ ｔａｘ ｒｅａｄｉｎｅｓｓ ｆｏｒ ２０２５．',
  'Check: tax-readiness for 2025!',
  'Please run 「check tax readiness for 2025」.',
  'Check “tax readiness” for 2025.',
  'Show my weekly cash brief.',
  'Could you please show my weekly cash brief?',
  'Please could you review my books for 2025?',
  'What did the project decide?',
  'What did the CFO decide about the project schedule?',
  'Summarize the CFO meeting notes.',
  'What did the CFO say about the weekly cash brief?',
  'Find the memo about books against bank.',
  'What did the CFO mean by "Check tax readiness for 2025"?',
  'What did the CFO mean by "Check tax readiness for 2025 and then review books"?',
  'Find the note titled "Check tax readiness for 2025; review books".',
  'What did the CFO mean by “Check tax readiness for 2025; review books”?',
  "Find the note titled 'Check tax readiness for 2025; review books'.",
  'Explain the phrase `Check tax readiness for 2025; review books`.',
  'What did the CFO mean by this instruction: check tax readiness for 2025?',
  'Find the memo titled CFO checklist: check tax readiness for 2025.',
  'Explain this instruction: check tax readiness for 2025; review books.',
  'Find the note titled 「Check tax readiness for 2025; review books」.',
  'Explain «Please run “Check tax readiness for 2025; review books”».',
  'What does Ｃｈｅｃｋ ｔａｘ ｒｅａｄｉｎｅｓｓ mean?',
  'Find the document named Check tax readiness for 2025.',
  'Does the instruction say to check tax readiness for 2025?',
  'Do not check tax readiness for 2025.',
  'Who asked the CFO to run tax readiness for 2025?',
  'Summarize the note: check tax readiness for 2025 and then review books.',
  'Explain "Check tax readiness for 2025" and "Review my books for 2025".',
  'Find the memo titled CFO checklist: show my weekly cash brief.',
  "Summarize the owners' notes; check tax readiness for 2025.",
  'Summarize the owners’ notes; check tax readiness for 2025.',
  "Summarize the '25 notes; check tax readiness for 2025.",
  'Please do the following: check tax readiness for 2025.',
  'Find the note titled: "Project notes"; check tax readiness for 2025.',
  'Find the note titled: "Project notes". Then check tax readiness for 2025.',
  'Tasks: 1. Check tax readiness for 2025.',
  '"Check tax readiness for 2025" appears in which memo?',
  '“Check tax readiness for 2025” appears in which memo?',
  '`Check tax readiness for 2025`: what does that instruction mean?',
  'What did the project decide?',
  '{"workflow":"tax_evidence_checklist","entity":"fixture-entity","year":2025}',
];

test('R5 every previous free-text form follows generic Ask with zero workflow calls', async t => {
  const f = await cfoFixture(t);
  await green(f);
  genericModel(f);
  f.raw(`INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title)
    VALUES ('fixture-tax-chunk','fixture-2025-0',0,?,'fixture-source','Synthetic workflow memo')`,
  'Synthetic tax readiness CFO cash brief books project memo amount $987654.32.');
  assert.equal(f.first('SELECT COUNT(*) AS n FROM chunks').n, 1);
  let genericDecisions = 0, retrieved = 0;
  for (const q of freeTextForms) {
    reset(f);
    const result = await genericAsk(f, q);
    assert.equal(result.status, 200);
    assert.ok(scopeReads(f) > 0);
    assert.equal(result.body.workflow, undefined);
    assert.equal(Object.hasOwn(result.body.timing.stages, 'cfo_workflow'), false, 'unused optional span is absent');
    assert.equal(inventoryReads(f), 0);
    assert.ok(result.body.timing.stages.premise_temporal.calls > 0);
    genericDecisions++;
    if (result.body.results?.some(row => row.snippet?.includes('987654.32'))) retrieved++;
  }
  assert.equal(genericDecisions, freeTextForms.length);
  assert.ok(freeTextForms.length >= 50);
  assert.ok(retrieved > 0, 'normal Ask can still retrieve real stored evidence');
  assert.ok(f.calls.model > 0);
});

test('typed action validator preserves handler contracts and opaque Books identity', () => {
  assert.deepEqual(parseCfoAction(ACTION), { kind: 'tax_readiness', taxYear: 2025 });
  assert.deepEqual(parseCfoAction({ workflow: 'cash_brief', entity: ENTITY }), { kind: 'cash_brief' });
  for (const accountRef of [' Acct:Case ', 'Ａｃｃｔ：Ｃａｓｅ', '「Check tax readiness; review books」', 'quoted "ref"']) {
    assert.deepEqual(parseCfoAction({ workflow: 'books_check', entity: ENTITY,
      period_start: '2026-09-01', period_end: '2026-09-30', account_ref: accountRef }), {
      kind: 'books_check', periodStart: '2026-09-01', periodEnd: '2026-09-30', accountRef,
    });
  }
});

test('structured placeholders cannot fall through to generic models', async t => {
  const f = await cfoFixture(t);
  for (const action of [{ workflow: 'cash_brief', entity: ENTITY }, { workflow: 'books_check', entity: ENTITY,
    period_start: '2026-09-01', period_end: '2026-09-30' }]) {
    const response = await f.post('/api/rag/think', action, f.admin());
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.workflow.status, 'unavailable');
    assert.equal(body.timing.stages.cfo_workflow.calls, 1);
    assert.equal(body.timing.stages.retrieval.calls, 0);
    assert.equal(inventoryReads(f), 0);
    assert.equal(f.calls.model, 0);
  }
  await green(f);
});

test('R5 malformed actions and forged trusted fields refuse with a reached decision', async t => {
  const f = await cfoFixture(t);
  // Random diagnostic IDs can coincidentally contain the rejected input marker.
  // Keep unique request IDs deterministic without excluding diagnostics from the check.
  let requestIds = 0;
  t.mock.method(globalThis.crypto, 'randomUUID', () => `00000000-0000-4000-8000-${String(++requestIds).padStart(12, '0')}`);
  const invalid = [
    { year: undefined }, { year: '2025' }, { year: null }, { year: true }, { year: 2025.5 }, { year: 1899 }, { year: 2201 },
    { entity: undefined }, { entity: null }, { entity: ['fixture-entity'] }, { entity: '' },
    { workflow: null }, { workflow: 1 }, { workflow: [] }, { workflow: { toString: {} } },
    { workflow: 'unknown' }, { workflow: 'TAX_EVIDENCE_CHECKLIST' },
    { q: 'Check tax readiness for 2025. Pay $9999.' }, { entity_slug: 'fixture-other' },
    { confirmed: true }, { ownerCapability: 'full_admin' }, { map: { authoritative: true } }, { amount: '9999.00' },
    { source: 'fixture-source' }, { from: '2025-01-01' },
  ];
  for (const patch of invalid) {
    reset(f);
    const { status, body } = await ask(f, patch, f.admin());
    assert.equal(status, 200);
    assert.ok(codes(body).includes('cfo_action_invalid'));
    assert.equal(body.timing.stages.cfo_workflow.calls, 1);
    assert.equal(body.timing.stages.retrieval.calls, 0);
    assert.equal(inventoryReads(f), 0); assert.equal(mapReads(f), 0);
    assert.equal(f.calls.model, 0);
    assert.doesNotMatch(JSON.stringify(body), /9999|\$/);
  }
  await green(f);
});

test('structured entity validation never guesses or rewrites scope', async t => {
  const f = await cfoFixture(t);
  for (const entity of ['unknown-entity', ` ${ENTITY}`, `${ENTITY} `]) {
    reset(f);
    const result = await ask(f, { entity }, f.admin());
    assert.notEqual(result.status, 200);
    assert.equal(result.body.timing.stages.scope.calls, 1, 'scope validation reached even for malformed identity');
    if (entity === 'unknown-entity') assert.ok(scopeReads(f) > 0);
    assert.equal(inventoryReads(f), 0);
  }
  await green(f);
  let reads = 0;
  const denied = await dispatchCfoWorkflow({ action: ACTION, ownerCapability: 'signed_in_owner',
    entityScope: { entity_slug: 'fixture-other', applied: true } }, {
    handlers: { tax_readiness: async () => { reads++; return { status: 'partial' }; } },
  });
  assert.ok(codes(denied).includes('cfo_entity_required'));
  assert.equal(reads, 0);
  await dispatchCfoWorkflow({ action: ACTION, ownerCapability: 'signed_in_owner',
    entityScope: { entity_slug: ENTITY, applied: true } }, {
    handlers: { tax_readiness: async () => { reads++; return { status: 'partial' }; } },
  });
  assert.equal(reads, 1, 'matching scope reaches the same injected handler');
});

test('search route cannot execute a structured action', async t => {
  const f = await cfoFixture(t);
  const response = await f.post('/api/rag/unified', ACTION, f.headers);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'unsupported_retrieval_parameter');
  assert.equal(inventoryReads(f), 0);
  await green(f);
});


test('typed Books action rejects impossible dates and invalid opaque references', () => {
  const action = { workflow: 'books_check', entity: ENTITY, period_start: '2026-09-01', period_end: '2026-09-30' };
  assert.equal(parseCfoAction(action).kind, 'books_check');
  for (const patch of [
    { period_start: '2026-02-30' }, { period_start: '2026-10-01' }, { period_end: 2026 },
    { account_ref: '' }, { account_ref: 1 }, { account_ref: 'x'.repeat(257) }, { account_ref: '\n' },
  ]) assert.equal(parseCfoAction({ ...action, ...patch }).kind, 'clarification');
});

test('dispatcher never invokes a workflow handler for free text without an action', async () => {
  let calls = 0;
  for (const question of freeTextForms) {
    const result = await dispatchCfoWorkflow({ question, ownerCapability: 'signed_in_owner',
      entityScope: { entity_slug: ENTITY, applied: true } }, {
      handlers: { tax_readiness: async () => { calls++; return { status: 'partial' }; } },
    });
    assert.equal(result, null);
  }
  assert.equal(calls, 0);
  await dispatchCfoWorkflow({ action: ACTION, ownerCapability: 'signed_in_owner',
    entityScope: { entity_slug: ENTITY, applied: true } }, {
    handlers: { tax_readiness: async () => { calls++; return { status: 'partial' }; } },
  });
  assert.equal(calls, 1);
});
