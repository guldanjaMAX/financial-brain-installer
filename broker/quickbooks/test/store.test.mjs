import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createBrokerStore, validateBrokerRow } from '../src/store.mjs';
import { createSqliteD1 } from './support/sqlite-d1.mjs';

const protocol = 'qbo-broker/1';
const start = '/v1/quickbooks/authorizations';
const refresh = '/v1/quickbooks/tokens/refresh';
const digest = () => randomBytes(32).toString('base64url');
const time = 1800000000000;
const replay = (overrides = {}) => ({ protocol, route: start, request_id_hash: digest(), state_hash: digest(), intent_hash: digest(), install_fingerprint: digest(), phase: 'start', provider_attempts: 0, key_generation: 1, created_at: time, expires_at: time + 600000, ...overrides });
const event = (overrides = {}) => ({ protocol, event_id_hash: digest(), request_id_hash: null, route: start, install_fingerprint: null, intent_hash: null, state_hash: null, phase: 'start', outcome: 'accepted', http_status_class: '2xx', build_id: digest(), key_generation: 1, created_at: time, expires_at: time + 2592000000, duration_ms: 0, attempt_count: 0, retention_ms: 2592000000, ...overrides });
const quota = (overrides = {}) => ({ protocol, route: start, subject_kind: 'network', subject_hash: digest(), window_start: time, window_ms: 600000, count: 0, expires_at: time + 1200000, retention_ms: 1200000, ...overrides });
function setup() {
  const { db, sqlite } = createSqliteD1();
  return { db, sqlite, store: createBrokerStore(db, { now: () => time }) };
}

test('broker migrations create only closed metadata tables and survive a second application', () => {
  const { sqlite } = setup();
  const sql = readFileSync(new URL('../migrations/0001_security_ledger.sql', import.meta.url), 'utf8');
  sqlite.exec(sql);
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
  assert.deepEqual(tables, ['qbo_broker_events', 'qbo_broker_quotas', 'qbo_broker_readiness', 'qbo_broker_replays']);
  for (const table of tables) {
    const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
    assert.equal(columns.some(name => /token|callback|company|realm|ciphertext|payload|message|error|address/.test(name)), false);
  }
  sqlite.close();
});

test('closed audit validation rejects forbidden fields before SQL, with valid roundtrip control', async () => {
  const { store, sqlite } = setup();
  const good = event();
  await store.recordEvent(good);
  assert.deepEqual((await store.inspect()).events, [good]);
  for (const field of ['access_token', 'refresh_token', 'callback', 'realmId', 'company_fingerprint', 'ciphertext', 'headers', 'body', 'raw_error', 'url', 'query']) {
    const bad = { ...event(), [field]: randomBytes(45).toString('base64url') };
    await assert.rejects(store.recordEvent(bad), { code: 'invalid_record' });
  }
  for (const patch of [{ outcome: 'arbitrary' }, { route: '/arbitrary' }, { phase: 'arbitrary' }, { build_id: 'arbitrary' }, { duration_ms: 600001 }, { retention_ms: 2592000001 }]) {
    await assert.rejects(store.recordEvent(event(patch)), { code: 'invalid_record' });
  }
  assert.equal((await store.inspect()).events.length, 1);
  sqlite.close();
});

test('SQL also refuses forbidden columns and invalid enum values without application validation', () => {
  const { sqlite } = setup();
  assert.throws(() => sqlite.prepare('INSERT INTO qbo_broker_events (access_token) VALUES (?)').run(randomBytes(32).toString('base64url')));
  const good = event();
  const columns = Object.keys(good);
  const statement = sqlite.prepare(`INSERT INTO qbo_broker_events (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
  statement.run(...Object.values(good));
  assert.throws(() => statement.run(...Object.values(event({ outcome: 'arbitrary' }))));
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM qbo_broker_events').get().count, 1);
  sqlite.close();
});

test('a durable replay row and exact readback precede each one-use phase transition', async () => {
  const { store, sqlite } = setup();
  const row = replay();
  assert.deepEqual(await store.createReplay(row), row);
  await assert.rejects(store.createReplay(row), { code: 'replayed' });
  await assert.rejects(store.createReplay(replay({ state_hash: row.state_hash })), { code: 'replayed' });
  assert.deepEqual(await store.getReplayByState(row.state_hash), row);
  const launched = await store.transitionReplay(row.request_id_hash, 'start', 'launched');
  assert.equal(launched.phase, 'launched');
  const results = await Promise.allSettled([
    store.transitionReplay(row.request_id_hash, 'launched', 'exchange_started', { providerAttempts: 1 }),
    store.transitionReplay(row.request_id_hash, 'launched', 'exchange_started', { providerAttempts: 1 }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await store.getReplay(row.request_id_hash)).provider_attempts, 1);
  await assert.rejects(store.transitionReplay(row.request_id_hash, 'exchange_started', 'exchange_started', { providerAttempts: 1 }), { code: 'invalid_transition' });
  sqlite.close();
});

test('failed commit or altered readback never grants a replay fence', async () => {
  const { store, db, sqlite } = setup();
  const good = replay();
  assert.equal((await store.createReplay(good)).phase, 'start');
  db.failNext('batch');
  await assert.rejects(store.createReplay(replay()), { code: 'ledger_unavailable' });
  db.corruptNextReadback();
  await assert.rejects(store.createReplay(replay()), { code: 'ledger_unavailable' });
  sqlite.close();
});

test('one-use no-contact proof consumption and replacement fence are atomic', async () => {
  const { store, sqlite } = setup();
  const original = replay({ route: '/v1/quickbooks/tokens/revoke', phase: 'not_sent', state_hash: null });
  await store.createReplay(original);
  const replacement = replay({ route: original.route, phase: 'revoke_started', provider_attempts: 1, state_hash: null, install_fingerprint: original.install_fingerprint, intent_hash: original.intent_hash });
  await store.consumeProof(original.request_id_hash, replacement);
  assert.equal((await store.getReplay(original.request_id_hash)).phase, 'proof_consumed');
  assert.equal((await store.getReplay(replacement.request_id_hash)).phase, 'revoke_started');
  await assert.rejects(store.consumeProof(original.request_id_hash, replay({ ...replacement, request_id_hash: digest() })), { code: 'replayed' });
  const rollback = replay({ ...original, request_id_hash: digest(), intent_hash: digest() });
  await store.createReplay(rollback);
  await assert.rejects(store.consumeProof(rollback.request_id_hash, { ...replacement, intent_hash: rollback.intent_hash }), { code: 'replayed' });
  assert.equal((await store.getReplay(rollback.request_id_hash)).phase, 'not_sent');
  sqlite.close();
});

test('quota increments are atomic and bounded; hourly requests use the replay ledger', async () => {
  const { store, sqlite } = setup();
  const one = quota();
  const two = quota({ subject_kind: 'install' });
  await store.admitQuota([{ row: one, limit: 2 }, { row: two, limit: 1 }]);
  await assert.rejects(store.admitQuota([{ row: one, limit: 2 }, { row: two, limit: 1 }]), { code: 'quota_exceeded' });
  assert.deepEqual((await store.inspect()).quotas.map(row => row.count), [1, 1]);
  const installFingerprint = digest();
  const options = { limits: [{ route: refresh, installFingerprint, since: time - 3600000, limit: 2 }] };
  const make = () => replay({ route: refresh, install_fingerprint: installFingerprint, state_hash: null, phase: 'refresh_started', provider_attempts: 1 });
  await store.createReplay(make(), options);
  await store.createReplay(make(), options);
  await assert.rejects(store.createReplay(make(), options), { code: 'quota_exceeded' });
  assert.equal(await store.countRequests({ route: refresh, installFingerprint, since: time - 3600000 }), 2);
  sqlite.close();
});

test('readiness requires exact build and generation; revocation markers and bounded expiry remain visible', async () => {
  const { store, sqlite } = setup();
  assert.equal(await store.getReadiness(), null);
  const ready = { build_id: digest(), key_generation: 1, ready: true, updated_at: time };
  assert.deepEqual(await store.setReadiness(ready), ready);
  assert.deepEqual(await store.getReadiness(), ready);
  await assert.rejects(store.setReadiness({ ...ready, secret: randomBytes(32).toString('base64url') }), { code: 'invalid_record' });
  const fingerprint = digest();
  assert.equal(await store.isVoucherRevoked(fingerprint), false);
  await store.recordEvent(event({ route: '/v1/quickbooks/installations/issue', install_fingerprint: fingerprint, phase: 'revoked', outcome: 'revoked' }));
  assert.equal(await store.isVoucherRevoked(fingerprint), true);
  for (let index = 0; index < 4; index++) await store.createReplay(replay({ created_at: time - 700000, expires_at: time - 1 }));
  assert.equal(await store.cleanup({ limit: 2 }), 2);
  assert.equal((await store.inspect()).replays.length, 2);
  assert.deepEqual(await store.getReadiness(), ready);
  sqlite.close();
});

test('mutant AUDIT_EXTRA_FIELD is killed by the same exact-shape privacy invariant', () => {
  const assertPrivate = validate => {
    assert.equal(validate('event', event()), true);
    assert.throws(() => validate('event', { ...event(), refresh_token: randomBytes(32).toString('base64url') }));
  };
  assertPrivate(validateBrokerRow);
  const acceptExtraMutant = (kind, row) => {
    const copy = { ...row };
    delete copy.refresh_token;
    return validateBrokerRow(kind, copy);
  };
  assert.throws(() => assertPrivate(acceptExtraMutant), { code: 'ERR_ASSERTION' });
});

test('token attempt phases require durable attempt authority and forbid a fresh-ID operation retry', async () => {
  const { store, sqlite } = setup();
  const good = replay({ route: refresh, phase: 'refresh_started', provider_attempts: 1, state_hash: null });
  await store.createReplay(good);
  await assert.rejects(store.createReplay({ ...good, request_id_hash: digest() }), { code: 'replayed' });
  await assert.rejects(store.createReplay(replay({ route: refresh, phase: 'refresh_started', provider_attempts: 0, state_hash: null })), { code: 'invalid_record' });
  sqlite.close();
});

test('mutant UNFENCED_PROVIDER_SEND is killed when a successful write result lacks exact durable readback', async () => {
  const source = readFileSync(new URL('../src/store.mjs', import.meta.url), 'utf8');
  const target = "return checkResult(results[1], next, 'replay');";
  assert.equal(source.split(target).length, 2);
  const mutantSource = source.replace(target, 'return next;');
  const mutant = await import(`data:text/javascript;base64,${Buffer.from(mutantSource).toString('base64')}`);
  async function requiresFence(factory) {
    const { db, sqlite } = createSqliteD1();
    let bypass = false;
    let before;
    const wrapped = { ...db, async batch(statements) {
      if (bypass) {
        bypass = false;
        // The dependency reports success but did not make the requested change.
        return [{ success: true, meta: { changes: 1 } }, { success: true, results: [before] }];
      }
      return db.batch(statements);
    } };
    const store = factory(wrapped, { now: () => time });
    let sends = 0;
    const control = replay({ phase: 'launched' });
    await store.createReplay(control);
    await store.transitionReplay(control.request_id_hash, 'launched', 'exchange_started', { providerAttempts: 1 });
    sends++;
    assert.equal(sends, 1);
    before = replay({ phase: 'launched' });
    await store.createReplay(before);
    bypass = true;
    try {
      await store.transitionReplay(before.request_id_hash, 'launched', 'exchange_started', { providerAttempts: 1 });
      sends++;
    } catch (error) { assert.equal(error.code, 'ledger_unavailable'); }
    try { assert.equal(sends, 1, 'no provider send authority without a durable exchange fence'); }
    finally { sqlite.close(); }
  }
  await requiresFence(createBrokerStore);
  await assert.rejects(requiresFence(mutant.createBrokerStore), { code: 'ERR_ASSERTION' });
});

test('provider-class circuit counts only recent failures on its route and fails closed on store loss', async () => {
  const { store, db, sqlite } = setup();
  const options = { since: time - 60000, limit: 2 };
  await store.recordEvent(event({ route: refresh, outcome: 'accepted' }));
  await store.recordEvent(event({ route: start, outcome: 'provider_rejected' }));
  await store.recordEvent(event({ route: refresh, outcome: 'provider_uncertain', created_at: time - 61000, expires_at: time }));
  assert.equal(await store.providerCircuitAllows(refresh, options), true);
  await store.recordEvent(event({ route: refresh, outcome: 'provider_rejected' }));
  assert.equal(await store.providerCircuitAllows(refresh, options), true);
  await store.recordEvent(event({ route: refresh, outcome: 'provider_uncertain' }));
  assert.equal(await store.providerCircuitAllows(refresh, options), false);
  db.failNext('first');
  await assert.rejects(store.providerCircuitAllows(refresh, options), { code: 'ledger_unavailable' });
  sqlite.close();
});

test('quota admission refuses success metadata when the counter did not durably advance', async () => {
  const { db, sqlite } = createSqliteD1();
  let bypass = false;
  let saved;
  const wrapped = { ...db, async batch(statements) {
    if (bypass) {
      bypass = false;
      const read = { success: true, results: [saved] };
      const write = { success: true, meta: { changes: 1 } };
      return statements.length === 2 ? [write, read] : [read, write, read];
    }
    return db.batch(statements);
  } };
  const store = createBrokerStore(wrapped, { now: () => time });
  const row = quota();
  [saved] = await store.admitQuota([{ row, limit: 5 }]);
  assert.equal(saved.count, 1);
  bypass = true;
  await assert.rejects(store.admitQuota([{ row, limit: 5 }]), { code: 'ledger_unavailable' });
  sqlite.close();
});

test('hourly admission covers no-contact proof replacement without consuming a refused proof', async () => {
  const { store, sqlite } = setup();
  const route = '/v1/quickbooks/tokens/revoke';
  const fingerprint = digest();
  const limits = [{ route, installFingerprint: fingerprint, since: time - 3600000, limit: 2 }];
  const original = replay({ route, phase: 'not_sent', state_hash: null, install_fingerprint: fingerprint });
  const replacement = replay({ ...original, request_id_hash: digest(), phase: 'revoke_started', provider_attempts: 1 });
  await store.createReplay(original);
  await store.consumeProof(original.request_id_hash, replacement, { limits });
  assert.equal((await store.getReplay(original.request_id_hash)).phase, 'proof_consumed');
  const next = replay({ ...original, request_id_hash: digest(), intent_hash: digest() });
  await store.createReplay(next);
  const nextReplacement = replay({ ...next, request_id_hash: digest(), phase: 'revoke_started', provider_attempts: 1 });
  await assert.rejects(store.consumeProof(next.request_id_hash, nextReplacement, { limits }), { code: 'quota_exceeded' });
  assert.equal((await store.getReplay(next.request_id_hash)).phase, 'not_sent');
  assert.equal(await store.getReplay(nextReplacement.request_id_hash), null);
  sqlite.close();
});
