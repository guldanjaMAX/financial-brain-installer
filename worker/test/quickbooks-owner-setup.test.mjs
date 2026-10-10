import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../src/index.js';

const origin = 'https://books-owner.invalid';
const now = Date.parse('2026-10-10T12:00:00Z');
const owner = { kind: 'owner', grantId: null };
const operationId = 'operation-fixture-00000000000001';
const request = (action, value, headers = {}) => new Request(`${origin}${action === "pair" ? "/api/oauth/quickbooks/setup/pair" : `/api/app/quickbooks/setup/${action}`}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Brain-App': '1', Origin: origin,
    Cookie: 'brain_session=synthetic-owner-session', ...headers }, body: JSON.stringify(value),
});
function dbFixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../../migrations/d1/0055_quickbooks_owner_setup.sql', import.meta.url), 'utf8'));
  let queries = 0;
  const DB = { prepare(sql) { const build = (args = []) => ({ bind: (...values) => build(values),
    first: async () => { queries++; return db.prepare(sql).get(...args) || null; },
    all: async () => { queries++; return { results: db.prepare(sql).all(...args) }; },
    run: async () => { queries++; return { meta: { changes: db.prepare(sql).run(...args).changes } }; },
  }); return build(); } };
  return { db, DB, queries: () => queries };
}

test('P05 setup shell is registered and unauthenticated API cannot coordinate a companion', async () => {
  const response = await worker.fetch(new Request(origin + '/app/setup?provider=quickbooks'), {});
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Security-Policy'), /connect-src 'self'/);
  const refused = await worker.fetch(request('status', { operation_id: operationId }), {});
  assert.ok([401, 503].includes(refused.status));
});

test('P05 owner session and paired signature advance exactly one operation; grant, cross-origin, replay and expiry refuse', async () => {
  const { handleQuickBooksOwnerSetup, setupProgressBytes } = await import('../src/lib/quickbooks-owner-setup.js');
  const fixture = dbFixture();
  const env = { DB: fixture.DB };
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = await crypto.subtle.exportKey('jwk', key.publicKey);
  const call = (action, value, extra = {}) => handleQuickBooksOwnerSetup(env, request(action, value, extra.headers), {
    principal: owner, now, ...extra,
  });
  try {
    const paired = await call('pair', { operation_id: operationId, installation_fingerprint: 'a'.repeat(64), public_key: publicKey }, { adminAuthorized: true });
    assert.equal(paired.status, 201);
    assert.equal((await call('start', { operation_id: operationId })).status, 200);
    const count = fixture.queries();
    assert.ok(count > 0);
    for (const principal of [null, { kind: 'grant', grantId: 'document-fixture' }, { kind: 'support', grantId: null }, { kind: 'owner', grantId: 'not-null' }]) {
      assert.equal((await call('status', { operation_id: operationId }, { principal })).status, 403);
    }
    assert.equal((await call('status', { operation_id: operationId }, { headers: { Origin: 'https://other.invalid' } })).status, 403);
    assert.equal(fixture.queries(), count);
    const payload = { operation_id: operationId, sequence: 1, stage: 'keys_staged', last_import_at: null, next_check_at: null };
    const signature = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey,
      setupProgressBytes(origin, 'a'.repeat(64), payload))).toString('base64url');
    assert.equal((await call('progress', { ...payload, signature: 'A'.repeat(86) })).status, 403);
    assert.ok(fixture.queries() > count);
    assert.equal((await call('progress', { ...payload, signature })).status, 200);
    assert.equal((await call('progress', { ...payload, signature })).status, 409);
    const status = await (await call('status', { operation_id: operationId })).json();
    assert.equal(status.stage, 'keys_staged'); assert.equal(status.connected, false);
    assert.equal((await call('status', { operation_id: operationId }, { now: now + 600_001 })).status, 410);
    assert.equal((await call('cancel', { operation_id: operationId })).status, 200);
    assert.equal((await call('status', { operation_id: operationId })).status, 410);
  } finally { fixture.db.close(); }
});

test('P05 real Worker router binds a pairing offer to a current owner session', async (t) => {
  t.mock.method(Date, 'now', () => now);
  const { mintSessionCookie } = await import('../src/lib/sessions.js');
  const fixture = dbFixture();
  const dir = new URL('../../migrations/d1/', import.meta.url);
  for (const file of readdirSync(dir).filter((file) => file.endsWith('.sql')).sort()) fixture.db.exec(readFileSync(new URL(file, dir), 'utf8'));
  fixture.db.exec("INSERT INTO install_state(id,client_slug,product_version,schema_version,installed_at,session_generation) VALUES(1,'fixture','0.4.12',55,'2026-10-10',1)");
  fixture.db.exec("INSERT INTO owner_passkeys(credential_id,public_key_jwk,alg,created_at) VALUES('fixture-owner','{}',-7,1)");
  const env = { DB: fixture.DB, ADMIN_KEY: 'synthetic-admin', SESSION_SIGNING_KEY: 'synthetic-session-signing' };
  const cookie = (await mintSessionCookie(env, 1, { credentialId: 'fixture-owner', now })).split(';')[0];
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pair = { operation_id: operationId, installation_fingerprint: 'a'.repeat(64), public_key: await crypto.subtle.exportKey('jwk', key.publicKey) };
  try {
    assert.equal((await worker.fetch(request('pair', pair), env)).status, 403);
    assert.equal((await worker.fetch(request('pair', pair, { 'X-Admin-Key': env.ADMIN_KEY }), env)).status, 201);
    assert.equal((await worker.fetch(request('start', { operation_id: operationId }, { Cookie: cookie }), env)).status, 200);
    assert.ok(fixture.queries() > 0);
    assert.equal((await worker.fetch(request('status', { operation_id: operationId }, { Cookie: cookie, Origin: 'https://other.invalid' }), env)).status, 403);
    assert.equal((await worker.fetch(request('status', { operation_id: operationId }, { Cookie: cookie }), env)).status, 200);
    fixture.db.exec('UPDATE install_state SET session_generation = 2');
    assert.equal((await worker.fetch(request('status', { operation_id: operationId }, { Cookie: cookie }), env)).status, 401);
  } finally { fixture.db.close(); }
});

test('setup rejects malformed, unpaired and wrong-session operations with a live paired control', async () => {
  const { handleQuickBooksOwnerSetup } = await import('../src/lib/quickbooks-owner-setup.js');
  const fixture = dbFixture(); const env = { DB: fixture.DB };
  const handle = (req, extra = {}) => handleQuickBooksOwnerSetup(env, req, { principal: owner, now, ...extra });
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pair = { operation_id: operationId, installation_fingerprint: 'a'.repeat(64), public_key: await crypto.subtle.exportKey('jwk', key.publicKey) };
  try {
    assert.equal((await handle(new Request(origin + '/api/app/quickbooks/setup/status'))).status, 405);
    assert.equal((await handleQuickBooksOwnerSetup({}, request('status', { operation_id: operationId }), { principal: owner, now })).status, 503);
    const badOrigin = new Request('http://books-owner.invalid/api/app/quickbooks/setup/status', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Brain-App': '1', Origin: 'http://books-owner.invalid' }, body: '{}' });
    assert.equal((await handle(badOrigin)).status, 403);
    assert.equal((await handle(request('pair', pair))).status, 403);
    assert.equal((await handle(request('pair', { ...pair, client_secret: 'synthetic-rejected-field' }), { adminAuthorized: true })).status, 400);
    assert.equal((await handle(request('pair', pair), { adminAuthorized: true })).status, 201);
    assert.equal((await handle(request('pair', pair), { adminAuthorized: true })).status, 409);
    assert.equal((await handle(request('status', { operation_id: 'short' }))).status, 400);
    assert.equal((await handle(request('status', { operation_id: operationId }, { 'Content-Type': 'text/plain' }))).status, 400);
    assert.equal((await handle(request('status', { operation_id: 'missing-operation-00000000000001' }))).status, 409);
    assert.equal((await handle(request('start', { operation_id: operationId, extra: true }))).status, 400);
    assert.equal((await handle(request('start', { operation_id: operationId }))).status, 200);
    assert.equal((await handle(request('start', { operation_id: operationId }))).status, 409);
    const queries = fixture.queries(); assert.ok(queries > 0);
    assert.equal((await handle(request('status', { operation_id: operationId }, { Cookie: '' }))).status, 403);
    assert.equal((await handle(request('status', { operation_id: operationId }, { Cookie: 'brain_session=another-owner-session' }))).status, 403);
    assert.equal((await handle(request('progress', { operation_id: operationId, stage: 'injected-stage' }))).status, 400);
    assert.equal((await handle(request('status', { operation_id: operationId }))).status, 200);
    assert.equal(fixture.db.prepare('SELECT count(*) n FROM quickbooks_owner_setup').get().n, 1);
  } finally { fixture.db.close(); }
});

test('setup reports body, session and store failures distinctly without private diagnostics', async () => {
  const { handleQuickBooksOwnerSetup } = await import('../src/lib/quickbooks-owner-setup.js');
  const fixture = dbFixture();
  const call = (env, req) => handleQuickBooksOwnerSetup(env, req, { principal: owner, now });
  try {
    const bodyFailure = await call({ DB: fixture.DB }, request('status', { operation_id: operationId }, { 'Content-Type': 'text/plain' }));
    assert.equal((await bodyFailure.json()).code, 'quickbooks_setup_body_invalid');
    const sessionFailure = await call({ DB: fixture.DB }, request('status', { operation_id: operationId }, { Cookie: '' }));
    assert.equal((await sessionFailure.json()).code, 'quickbooks_owner_required');
    const missingStore = await call({}, request('status', { operation_id: operationId }));
    assert.equal((await missingStore.json()).code, 'quickbooks_setup_unavailable');
    let queries = 0;
    const failed = await call({ DB: { prepare() { queries++; throw new Error('synthetic-private-store-body'); } } }, request('status', { operation_id: operationId }));
    assert.equal(queries, 1); assert.equal(failed?.status, 503);
    assert.equal((await failed.json()).code, 'quickbooks_setup_store_unavailable');
    const control = await call({ DB: fixture.DB }, request('status', { operation_id: operationId }));
    assert.equal(control.status, 409);
  } finally { fixture.db.close(); }
});
