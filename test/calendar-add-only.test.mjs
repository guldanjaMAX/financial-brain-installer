import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cmdIngestCalendar } from '../brain.mjs';
import { buildEnvelope, ingestEnvelopes, syncAll } from '../connectors/google-calendar.mjs';
import { createProductFixture } from '../worker/test/product-contract-fixture.mjs';
import { assertDocumentAnswer } from '../worker/test/helpers/document-answer-contract.mjs';
import { createIngestRemovalReview } from '../operations/ingest-removal-plan.mjs';
import { buildDriveRemovalPlan } from '../operations/drive-removal-plan.mjs';
import { readOwnerDocumentPage } from '../worker/src/lib/mcp-endpoint.js';
import { readDocumentEvidence } from '../worker/src/lib/document-answer.js';
import { restampFirstPartySourceProvenance } from '../worker/src/lib/provenance-receipt.js';

const EVENT = {
  id: 'event-one', status: 'confirmed', summary: 'Owner planning meeting',
  start: { dateTime: '2031-04-08T15:00:00Z' }, end: { dateTime: '2031-04-08T16:00:00Z' },
  updated: '2031-04-01T12:00:00Z', description: 'Keep this original meeting record.',
};
const SOURCE_ID = 'gcal:primary:event-one';
const CANCEL_ROUTE = '/api/admin/brain/calendar-cancellation';

async function setup(t, source = 'calendar') {
  t.mock.method(Date, 'now', () => Date.parse('2031-04-07T12:00:00Z'));
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network forbidden'); });
  const fixture = await createProductFixture({ env: { BRAIN_TIMEZONE: 'UTC', INGEST_VERSION: { id: 'fixture-runtime' } } });
  t.after(() => fixture.close());
  const home = mkdtempSync(join(process.env.HOME, 'calendar-case-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const manifest = join(home, 'brain.manifest.json');
  const keyFile = join(home, '.brain-admin-key');
  writeFileSync(manifest, '{}\n');
  writeFileSync(keyFile, fixture.env.ADMIN_KEY, { mode: 0o600 });
  const statePath = join(home, `.brain-ingest-${source}.json`);
  const auth = { 'X-Admin-Key': fixture.env.ADMIN_KEY };
  const envelope = restampFirstPartySourceProvenance(buildEnvelope(EVENT).envelope, { sourceType: source, textSource: 'native', textReliable: true });
  const seeded = await fixture.post('/api/admin/brain/ingest', envelope, auth);
  assert.equal(seeded.status, 200);
  const before = fixture.first('SELECT * FROM documents WHERE doc_uid=?', `${source}:${SOURCE_ID}`);
  const chunks = fixture.rows('SELECT * FROM chunks ORDER BY chunk_uid');
  const outbox = fixture.rows('SELECT * FROM vector_outbox ORDER BY chunk_uid');
  const calls = [], receipts = [], pages = [];
  let failMark = false, falseProof = false;
  const transport = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, body: init.body ? JSON.parse(init.body) : null, syncToken: parsed.searchParams.get('syncToken') });
    if (parsed.hostname === 'www.googleapis.com') {
      assert.ok(pages.length, 'provider decision reached with a scripted page');
      return new Response(JSON.stringify(pages.shift()), { status: 200 });
    }
    assert.equal(parsed.hostname, 'brain.invalid');
    if (parsed.pathname === CANCEL_ROUTE && failMark) return new Response('{}', { status: 503 });
    if (parsed.pathname === CANCEL_ROUTE && falseProof) return new Response(JSON.stringify({ verified: true, action: 'kept_cancelled', source, source_id: 'wrong-event' }));
    return fixture.worker.fetch(new Request(url, init), fixture.env, { waitUntil() {} });
  };
  const options = {
    sourceIngestLockOptions: { home },
    resolveAccount: async () => ({}), resolveBaseUrl: async () => 'https://brain.invalid',
    resolveAdminKey: () => readFileSync(keyFile, 'utf8'), getAccessToken: async () => 'fixture-access',
    fetchImpl: transport, postSourceReceipt: async (_base, _key, receipt) => receipts.push(receipt),
    googleCalendar: { syncAll, ingestEnvelopes: args => ingestEnvelopes({ ...args, fetchImpl: transport }) },
    removalPlanRuntime: () => 'fixture-runtime',
    removalPlanRequest: async ({ body }) => {
      calls.push({ path: 'removal-review', body });
      const res = await fixture.post('/api/admin/brain/ingest-removal-plan', body, auth);
      assert.equal(res.status, 200);
      return res.json();
    },
    listStoredSourceFamilies: async () => new Set([`${source}:${SOURCE_ID}`]),
  };
  return { fixture, home, manifest, statePath, before, chunks, outbox, calls, receipts, pages, auth, options,
    run: flags => cmdIngestCalendar({ brain: { domain: 'brain.invalid' } }, manifest, { source, ...flags }, options),
    setFail: value => { failMark = value; }, setFalseProof: value => { falseProof = value; },
    saved: () => JSON.parse(readFileSync(statePath, 'utf8')),
  };
}

async function legacyPlan(x, cause = 'explicit_deletion') {
  const state = { done: {}, skipped: {} };
  const review = createIngestRemovalReview({
    source: 'calendar', kind: 'calendar', state, manifest: { brain: { domain: 'brain.invalid' } }, manifestPath: x.manifest, base: 'https://brain.invalid',
    saveState: () => writeFileSync(x.statePath, JSON.stringify(state)),
    runtime: () => 'fixture-runtime', request: x.options.removalPlanRequest,
  });
  await assert.rejects(review.finish({ sourcePlan: buildDriveRemovalPlan({
    storedFamilies: new Set([x.before.doc_uid]), vanishedCandidates: [x.before.doc_uid],
    targetCauses: { [x.before.doc_uid]: cause },
  }) }), { code: 'SAFETY_REVIEW_REQUIRED' });
  assert.equal(state.ingest_removal_plan.targets.length, 1, 'nonempty authentic legacy plan reached');
  return state;
}

test('normal Calendar cancellation retains exact stored content, marks it, advances and never reviews removal', async t => {
  const x = await setup(t, 'owner-calendar');
  x.pages.push({ items: [{ id: EVENT.id, status: 'cancelled' }], nextSyncToken: 'next-one' });
  const result = await x.run();
  assert.equal(result.removed, 0);
  assert.equal(result.removalPending, 0);
  assert.equal(result.cancelled, 1);
  assert.equal(x.saved().primary.sync_token, 'next-one');
  assert.equal(x.saved().ingest_removal_plan, undefined);
  assert.equal(x.calls.filter(c => c.path === CANCEL_ROUTE).length, 1, 'real cancellation write reached');
  assert.equal(x.calls.filter(c => c.path === 'removal-review').length, 0);
  const after = x.fixture.first('SELECT * FROM documents WHERE doc_uid=?', x.before.doc_uid);
  for (const key of Object.keys(x.before).filter(key => key !== 'meta')) assert.deepEqual(after[key], x.before[key], key);
  assert.equal(JSON.parse(after.meta).status, 'cancelled');
  assert.deepEqual(x.fixture.rows('SELECT * FROM chunks ORDER BY chunk_uid'), x.chunks);
  assert.deepEqual(x.fixture.rows('SELECT * FROM vector_outbox ORDER BY chunk_uid'), x.outbox);
  assert.equal(x.receipts.at(-1).status, 'ready');
  assert.match(x.receipts.at(-1).detail, /1 cancellation\(s\) kept and marked/);
  x.pages.push({ items: [], nextSyncToken: 'next-two' });
  await x.run();
  assert.equal(x.calls.filter(c => c.syncToken).at(-1).syncToken, 'next-one', 'next provider read uses earned cursor');
});

test('Calendar cancellation preview computes its decision without writing markers, receipts or legacy state', async t => {
  const x = await setup(t);
  await legacyPlan(x);
  const beforeState = readFileSync(x.statePath, 'utf8');
  x.calls.length = 0;
  x.pages.push({ items: [{ id: EVENT.id, status: 'cancelled' }], nextSyncToken: 'preview-only' });
  const result = await x.run({ 'dry-run': true });
  assert.equal(result.deletions.length, 1, 'preview really reached cancellation decision');
  assert.equal(x.calls.length, 1, 'provider preview only');
  assert.equal(x.receipts.length, 0);
  assert.equal(readFileSync(x.statePath, 'utf8'), beforeState);
  assert.equal(JSON.parse(x.fixture.first('SELECT meta FROM documents WHERE doc_uid=?', x.before.doc_uid).meta).status, 'confirmed');
});

test('legacy explicit-deletion plan becomes kept and marked without apply, even when provider no longer repeats it', async t => {
  const x = await setup(t);
  await legacyPlan(x);
  x.calls.length = 0;
  x.pages.push({ items: [], nextSyncToken: 'legacy-settled' });
  await x.run();
  assert.equal(x.saved().primary.sync_token, 'legacy-settled');
  assert.equal(x.saved().ingest_removal_plan, undefined);
  assert.equal(JSON.parse(x.fixture.first('SELECT meta FROM documents WHERE doc_uid=?', x.before.doc_uid).meta).status, 'cancelled');
  assert.equal(x.calls.filter(c => c.path === CANCEL_ROUTE).length, 1);
  assert.equal(x.calls.filter(c => c.path === 'removal-review').length, 0, 'no preview or apply on conversion');
});

test('legacy window exits stay kept without inventing cancellation; a confirmed provider update restores a cancelled plan target', async t => {
  for (const cause of ['window_exit', 'explicit_deletion']) {
    const x = await setup(t);
    await legacyPlan(x, cause);
    x.calls.length = 0;
    x.pages.push({ items: cause === 'explicit_deletion' ? [EVENT] : [], nextSyncToken: 'kept-position' });
    const result = await x.run();
    assert.deepEqual(result.sent.errors, []);
    assert.equal(result.cancelled, 0);
    assert.equal(x.calls.filter(c => c.path === CANCEL_ROUTE || c.path === 'removal-review').length, 0);
    assert.equal(x.saved().ingest_removal_plan, undefined);
    assert.equal(x.saved().calendar_retained_removals[0].status, cause === 'explicit_deletion' ? 'restored' : 'kept');
    assert.equal(x.saved().primary.sync_token, 'kept-position');
    assert.equal(JSON.parse(x.fixture.first('SELECT meta FROM documents WHERE doc_uid=?', x.before.doc_uid).meta).status, 'confirmed');
    assert.equal(x.fixture.rows('SELECT * FROM documents').length, 1, 'kept record control');
  }
});

test('explicit apply-removals remains available only for its exact reviewed plan', async t => {
  const x = await setup(t);
  const state = await legacyPlan(x);
  x.calls.length = 0;
  const result = await x.run({ 'apply-removals': state.ingest_removal_plan.fingerprint,
    'approve-removals': state.ingest_removal_plan.sourcePlan.fingerprint });
  assert.equal(result.removed, 1);
  assert.ok(x.calls.some(c => c.path === 'removal-review' && c.body.action === 'apply'), 'explicit deletion decision reached');
  assert.equal(x.fixture.rows('SELECT * FROM documents').length, 0);
  assert.equal(x.calls.filter(c => c.path === CANCEL_ROUTE).length, 0);
});

test('mark failures and mismatched readback hold cursor, keep record, explain stable failure and retry successfully', async t => {
  for (const mode of ['unavailable', 'wrong-readback']) {
    const x = await setup(t);
    x.setFail(mode === 'unavailable'); x.setFalseProof(mode === 'wrong-readback');
    x.pages.push({ items: [{ id: EVENT.id, status: 'cancelled' }], nextSyncToken: 'must-retry' });
    await assert.rejects(x.run(), error => error.code === 'INGEST_FAILED' && /https:\/\//.test(error.message) && !/\n/.test(error.message));
    assert.equal(x.calls.filter(c => c.path === CANCEL_ROUTE).length, 1, 'failed mark decision reached');
    assert.equal(x.fixture.rows('SELECT * FROM documents').length, 1);
    assert.equal(x.receipts.at(-1).status, 'error');
    assert.equal(x.receipts.at(-1).issue_code, 'INGEST_FAILED');
    assert.throws(() => x.saved(), /ENOENT/);
    x.setFail(false); x.setFalseProof(false);
    x.pages.push({ items: [{ id: EVENT.id, status: 'cancelled' }], nextSyncToken: 'retry-accepted' });
    await x.run();
    assert.equal(x.saved().primary.sync_token, 'retry-accepted', 'green retry control');
  }
});

test('Worker cancellation boundary checks authority, pause, identity, absent records and exact readback', async t => {
  const x = await setup(t);
  const request = { source: 'calendar', source_id: SOURCE_ID };
  assert.equal((await x.fixture.post(CANCEL_ROUTE, request)).status, 401);
  x.fixture.env.VECTOR_DRAIN_MODE = 'paused-for-upgrade';
  assert.equal((await x.fixture.post(CANCEL_ROUTE, request, x.auth)).status, 503);
  delete x.fixture.env.VECTOR_DRAIN_MODE;
  assert.equal((await x.fixture.post(CANCEL_ROUTE, { ...request, source_id: 'other-provider:event-one' }, x.auth)).status, 400);
  const absent = await x.fixture.post(CANCEL_ROUTE, { ...request, source_id: 'gcal:primary:absent-event' }, x.auth);
  assert.equal(absent.status, 200);
  assert.equal((await absent.json()).action, 'not_stored');
  const marked = await x.fixture.post(CANCEL_ROUTE, request, x.auth);
  assert.equal(marked.status, 200, 'valid write is the green control');
  assert.deepEqual(await marked.json(), { ...request, action: 'kept_cancelled', verified: true });
  assert.equal(x.fixture.rows('SELECT * FROM documents').length, 1);
  assert.ok(x.fixture.seen.sql.some(sql => /calendar-cancellation/.test(sql)), 'storage decision reached');
  const second = await x.fixture.post(CANCEL_ROUTE, request, x.auth);
  assert.equal(second.status, 200, 'repeated cancellation is idempotent');
  assert.deepEqual(x.fixture.rows('SELECT * FROM chunks ORDER BY chunk_uid'), x.chunks);
  const restored = await x.fixture.post('/api/admin/brain/ingest', restampFirstPartySourceProvenance(buildEnvelope(EVENT).envelope, { sourceType: 'calendar', textSource: 'native', textReliable: true }), x.auth);
  assert.equal(restored.status, 200);
  assert.equal(JSON.parse(x.fixture.first('SELECT meta FROM documents WHERE doc_uid=?', x.before.doc_uid).meta).status, 'confirmed', 'normal provider reactivation clears cancellation');
  const [refreshed] = await readDocumentEvidence(x.fixture.env, [{ doc_uid: x.before.doc_uid,
    title: `[Cancelled] ${x.before.title}`, calendar_status: 'cancelled' }]);
  assert.equal(refreshed.calendar_status, 'confirmed', 'fresh read clears a stale retrieval status');
  assert.equal(refreshed.title, x.before.title);
  x.fixture.raw("UPDATE documents SET date_source='file:modified' WHERE doc_uid=?", x.before.doc_uid);
  const nonCalendar = await x.fixture.post(CANCEL_ROUTE, request, x.auth);
  assert.equal(nonCalendar.status, 503, 'matching identity alone cannot mark a non-calendar record');
  assert.equal(JSON.parse(x.fixture.first('SELECT meta FROM documents WHERE doc_uid=?', x.before.doc_uid).meta).status, 'confirmed');
});

test('cancelled stored event reaches real answer path marked and cannot be promoted as tomorrow at High', async t => {
  const x = await setup(t);
  const marked = await x.fixture.post(CANCEL_ROUTE, { source: 'calendar', source_id: SOURCE_ID }, x.auth);
  assert.equal(marked.status, 200);
  const searched = await x.fixture.post('/api/rag/unified', { q: 'Owner planning meeting', limit: 10 }, x.auth);
  assert.equal(searched.status, 200);
  const searchBody = await searched.json();
  assert.equal(searchBody.results.length, 1, 'real search reached stored event');
  assert.equal(searchBody.results[0].calendar_status, 'cancelled');
  assert.match(searchBody.results[0].title, /cancelled/i);
  const reading = await readOwnerDocumentPage(x.fixture.env, { id: x.before.doc_uid }, 'https://brain.invalid');
  const readBody = JSON.parse(reading.content[0].text);
  assert.equal(readBody.calendar_status, 'cancelled');
  assert.match(readBody.title, /cancelled/i);
  assert.match(readBody.text, /Keep this original meeting record/);
  const [lateRead] = await readDocumentEvidence(x.fixture.env, [{ doc_uid: x.before.doc_uid, title: x.before.title }]);
  assert.equal(lateRead.calendar_status, 'cancelled', 'full reading refreshes marker even after an earlier unmarked retrieval');
  let drafts = 0, verifiers = 0;
  x.fixture.env.AI.run = async (model, input) => {
    if (model.includes('bge-')) return { data: [[0.1, 0.2, 0.3]] };
    if (String(input.messages?.[0]?.content).includes('verify a proposed answer')) {
      verifiers++;
      return { response: { supported: true, complete: true, evidence: [1], conflicts: [], reason: 'injected approval' } };
    }
    drafts++;
    return { response: 'Your Owner planning meeting is tomorrow, April 8, 2031 [1].' };
  };
  x.fixture.env.VECTORIZE.query = async () => ({ matches: x.fixture.rows('SELECT chunk_uid AS id FROM chunks') });
  const response = await x.fixture.post('/api/rag/think', { q: 'What is on tomorrow?', limit: 10 }, x.auth);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.results.length, 1, 'retained event actually retrieved');
  assert.equal(drafts, 1); assert.equal(verifiers, 1);
  assert.equal(body.results[0].calendar_status, 'cancelled');
  assert.match(body.results[0].title, /cancelled/i);
  assert.equal(body.citations[0].calendar_status, 'cancelled');
  assert.ok(body.confidence.percent < 90, 'false upcoming claim cannot be High');
  assertDocumentAnswer(body, { provisional: true, empty: false });
  assert.match(body.answer, /cancelled/i);
});

