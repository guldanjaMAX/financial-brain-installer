import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createBroker, ROUTES } from '../src/broker.mjs';
import { createBrokerStore } from '../src/store.mjs';
import { createSqliteD1 } from './support/sqlite-d1.mjs';
import { canonical, randomCapability, sha256, publicJwk, signObject, encode64 } from '../src/crypto.mjs';
import { createFakeIntuit } from '../../../protocol/quickbooks-broker/testing/fake-intuit.mjs';
import { assertSchema } from '../src/validation.mjs';
import { createOwnerRuntime } from '../../../protocol/quickbooks-broker/testing/owner-runtime.mjs';

const protocol = 'qbo-broker/1';
const callback = 'https://owner.invalid/api/quickbooks/connect/callback';
const json = value => new Response(canonical(value), { headers: { 'content-type': 'application/json' } });
const request = (path, body, authorized = true) => new Request('https://broker.invalid' + path, {
  method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...(authorized ? { authorization: 'test-role' } : {}) }, body: canonical(body),
});

async function enrollmentFixture({ lost = 0, unavailable = false, concurrent = false,
  readbackFailures = 0, ownerFactory = createOwnerRuntime } = {}) {
  let instant = 1800000000000;
  const now = () => instant;
  const fake = createFakeIntuit({ now });
  const { db, sqlite } = createSqliteD1();
  const store = createBrokerStore(db, { now });
  const buildId = randomCapability(), events = [], deliveries = [], acknowledgements = [], faults = new Set();
  const owner = await ownerFactory({ origin: 'https://owner.invalid', now,
    transport: () => { throw new Error('unexpected_owner_outbound'); },
    apiOrigins: fake.config.apiOrigins, observe: event => events.push(event), faults });
  await store.setReadiness({ build_id: buildId, key_generation: 1, ready: true, updated_at: now() });
  const broker = createBroker({ config: { ...fake.config, buildId, keyGeneration: 1, offline: true }, store, now,
    providerTransport: request => fake.fetch(request), resolve: async () => ['93.184.216.34'],
    verifyAccess: async () => true,
    ownerTransport: async request => {
      if (new URL(request.url).pathname.endsWith('/challenge')) return owner.fetch(request);
      deliveries.push(request.clone());
      if (unavailable) throw new Error('synthetic_owner_unavailable');
      if (readbackFailures-- > 0) faults.add('owner.enrollment.readback');
      const replies = concurrent ? await Promise.all([owner.fetch(request.clone()), owner.fetch(request.clone())])
        : [await owner.fetch(request)];
      for (const reply of replies) acknowledgements.push({ status: reply.status, body: await reply.clone().text() });
      if (lost-- > 0) throw new Error('synthetic_acknowledgement_lost');
      return replies[0];
    },
  });
  return { owner, events, deliveries, acknowledgements, fake,
    advance: value => { instant += value; },
    enroll: async () => broker.fetch(request(ROUTES.issue, await owner.prepareEnrollment())),
    issued: () => sqlite.prepare('SELECT count(*) AS count FROM qbo_broker_replays').get().count };
}

async function assertEnrollmentReplay(target) {
  assert.equal((await target.enroll()).status, 202);
  assert.equal(target.deliveries.length, 2, 'one lost acknowledgement requires exactly one identical retry');
  assert.equal(target.issued(), 1, 'retry must not mint another voucher or restart enrollment');
  assert.equal(target.events.filter(event => event === 'owner.enrollment.committed').length, 1);
  assert.equal(target.events.filter(event => event === 'owner.enrollment.acknowledgement.replayed').length, 1);
  assert.ok(target.acknowledgements.length === 2 && target.acknowledgements.every(reply => reply.status === 200));
  assert.ok(target.acknowledgements[0].body === target.acknowledgements[1].body, 'replay returns the exact saved status acknowledgement');
  assert.ok(await target.deliveries[0].clone().text() === await target.deliveries[1].clone().text(), 'retry delivery bytes must be identical');
  const acknowledgement = JSON.parse(target.acknowledgements[0].body);
  assert.deepEqual(Object.keys(acknowledgement).sort(), ['install_fingerprint', 'outcome', 'protocol']);
  assert.equal(target.fake.snapshot().attempted.exchange, 0);
}

test('enrollment lost acknowledgement replays once without saving a second voucher', async () => {
  const control = await enrollmentFixture();
  assert.equal((await control.enroll()).status, 202);
  assert.equal(control.deliveries.length, 1);
  const target = await enrollmentFixture({ lost: 1 });
  await assertEnrollmentReplay(target);
  target.advance(120_001);
  const replay = await target.owner.fetch(target.deliveries[0].clone());
  assert.equal(replay.status, 200, 'a consumed challenge can replay its acknowledgement after expiry');
  assert.ok(await replay.text() === target.acknowledgements[0].body);
  const changed = await target.deliveries[0].clone().json();
  changed.voucher.claims.voucher_id = randomCapability();
  const refused = await target.owner.fetch(new Request(target.deliveries[0].url, {
    method: 'POST', headers: target.deliveries[0].headers, body: canonical(changed),
  }));
  assert.equal(refused.status, 403, 'changed delivery bytes must never reuse an acknowledgement');
  assert.equal(target.events.filter(event => event === 'owner.enrollment.committed').length, 1);
});

test('enrollment delivery is bounded when unavailable or every acknowledgement is lost', async () => {
  const control = await enrollmentFixture();
  assert.equal((await control.enroll()).status, 202);
  for (const options of [{ unavailable: true }, { lost: 3 }]) {
    const target = await enrollmentFixture(options);
    assert.equal((await target.enroll()).status, 503);
    assert.equal(target.deliveries.length, 3);
    assert.equal(target.issued(), 1);
    assert.equal(target.events.filter(event => event === 'owner.enrollment.committed').length, options.unavailable ? 0 : 1);
    for (const delivery of target.deliveries.slice(1))
      assert.ok(await target.deliveries[0].clone().text() === await delivery.clone().text());
  }
});

test('concurrent identical enrollment deliveries commit once and return the saved acknowledgement', async () => {
  const control = await enrollmentFixture();
  assert.equal((await control.enroll()).status, 202);
  const target = await enrollmentFixture({ concurrent: true });
  assert.equal((await target.enroll()).status, 202);
  assert.equal(target.events.filter(event => event === 'owner.enrollment.committed').length, 1);
  assert.ok(target.acknowledgements.length === 2 && target.acknowledgements.every(reply => reply.status === 200));
  assert.ok(target.acknowledgements[0].body === target.acknowledgements[1].body);
});

test('enrollment readback failure rolls back voucher and consumption before a recoverable retry', async () => {
  const control = await enrollmentFixture();
  assert.equal((await control.enroll()).status, 202);
  const target = await enrollmentFixture({ readbackFailures: 3 });
  assert.equal((await target.enroll()).status, 503);
  assert.equal(target.deliveries.length, 3);
  assert.equal(target.events.filter(event => event === 'owner.enrollment.readback.attempted').length, 3);
  assert.equal(target.owner.inspect().enrollmentReadbackAttemptCount, 3,
    'each failed delivery must reach the injected readback decision');
  assert.equal(target.events.filter(event => event === 'owner.enrollment.committed').length, 0);
  assert.equal(target.events.filter(event => event === 'owner.enrollment.acknowledgement.replayed').length, 0);
  assert.equal(control.events.filter(event => event === 'owner.enrollment.readback.attempted').length, 1);
  assert.equal(control.owner.inspect().enrollmentReadbackAttemptCount, 1);
  assert.equal((await target.owner.fetch(target.deliveries[0].clone())).status, 200);
  assert.equal(target.events.filter(event => event === 'owner.enrollment.readback.attempted').length, 4);
  assert.equal(target.owner.inspect().enrollmentReadbackAttemptCount, 4);
  assert.equal(target.events.filter(event => event === 'owner.enrollment.committed').length, 1);
});

test('mutant ENROLLMENT_ACK_NOT_REPLAYED is killed by the lost acknowledgement control', async () => {
  await assertEnrollmentReplay(await enrollmentFixture({ lost: 1 }));
  const sourceUrl = new URL('../../../protocol/quickbooks-broker/testing/owner-runtime.mjs', import.meta.url);
  const source = readFileSync(sourceUrl, 'utf8');
  const seam = 'if (pending.consumed) return replayAcknowledgement();';
  assert.equal(source.split(seam).length - 1, 2);
  const mutated = source.replaceAll(seam, 'if (pending.consumed) return refuse(403);')
    .replace(/from '(\.\.?\/[^']+)'/g, (_, path) => `from '${new URL(path, sourceUrl).href}'`);
  const { createOwnerRuntime: ownerFactory } = await import('data:text/javascript;base64,' + Buffer.from(mutated).toString('base64'));
  const target = await enrollmentFixture({ lost: 1, ownerFactory });
  await assert.rejects(() => assertEnrollmentReplay(target), { code: 'ERR_ASSERTION' });
  assert.equal(target.events.filter(event => event === 'owner.enrollment.committed').length, 1);
  assert.equal(target.deliveries.length, 3);
});

async function fixture({ hasChallenge = true, staleChallenge = false, missingSignature = false,
  ownerCallback = callback, brokerFactory = createBroker } = {}) {
  const instant = 1800000000000;
  const now = () => instant;
  const { db, sqlite } = createSqliteD1();
  const store = createBrokerStore(db, { now });
  const fake = createFakeIntuit({ now });
  const buildId = randomCapability();
  await store.setReadiness({ build_id: buildId, key_generation: 1, ready: true, updated_at: instant });
  const install = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const delivery = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const installPublic = await publicJwk(install.publicKey);
  const capability = randomCapability();
  const challenge = { protocol, challenge: capability, callback: ownerCallback, install_public_key: installPublic,
    environment: 'sandbox', key_generation: 1, issued_at: staleChallenge ? instant - 121000 : instant,
    expires_at: staleChallenge ? instant - 1000 : instant + 120000 };
  challenge.signature = missingSignature ? randomCapability() : await signObject(install.privateKey, protocol + '/challenge', challenge);
  let voucher;
  let delivered = 0;
  let providerSend = async req => fake.fetch(req);
  const logs = [], observed = [];
  const broker = brokerFactory({ config: { ...fake.config, buildId, keyGeneration: 1, offline: true }, store, now,
    providerTransport: req => providerSend(req), verifyAccess: async req => req.headers.get('authorization') === 'test-role',
    resolve: async () => ['93.184.216.34'], observe: name => observed.push(name), logEvent: value => logs.push(value),
    ownerTransport: async (req, pinned) => {
      assert.equal(pinned.hostname, new URL(ownerCallback).hostname);
      assert.equal(req.redirect, 'manual');
      if (req.headers.get('authorization') !== `Bearer ${capability}`) return new Response(null, { status: 401 });
      if (new URL(req.url).pathname.endsWith('/challenge')) return hasChallenge ? json(challenge) : new Response(null, { status: 404 });
      const value = await req.json();
      if (value.challenge !== capability) return new Response(null, { status: 401 });
      voucher = value.voucher;
      delivered++;
      return json({ protocol, outcome: 'committed_readback', install_fingerprint: await sha256(voucher) });
    },
  });
  const issue = { protocol, request_id: randomCapability(), challenge: capability, callback: ownerCallback,
    install_public_key: installPublic, environment: 'sandbox', issued_at: instant, expires_at: instant + 60000 };
  return {
    broker, store, sqlite, fake, logs, observed, now,
    enroll: authorized => broker.fetch(request(ROUTES.issue, issue, authorized)),
    delivered: () => delivered,
    setProvider: transport => { providerSend = transport; },
    async seedRefresh() {
      // Provider setup is confined to the injected in-memory fake. The broker
      // must still commit its own fence before the tested refresh operation.
      const grant = await fake.grant({ state: randomCapability(), realmId: 'synthetic.realm' });
      const response = await fake.fetch(new Request(fake.config.tokenUrl, { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${btoa(`${fake.config.clientId}:${fake.config.clientSecret}`)}` },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: grant.callback.searchParams.get('code'), redirect_uri: fake.config.redirectUri }),
      }));
      assert.equal(response.status, 200);
      return (await response.json()).refresh_token;
    },
    async signed(kind = 'start', overrides = {}, requestId = randomCapability()) {
      const route = ROUTES[kind];
      const body = { intent: randomCapability(), callback: ownerCallback, environment: 'sandbox',
        delivery_public_key: await publicJwk(delivery.publicKey), delivery_auth_key: randomCapability(),
        ...(kind === 'start' ? { expected_token_generation: 1 } : { token_generation: 1, refresh_token: randomCapability(),
          realm_id: 'synthetic.realm', company_fingerprint: [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('quickbooks-company-v1:synthetic.realm')))].map(byte => byte.toString(16).padStart(2, '0')).join('') }), ...overrides };
      const value = { protocol, method: 'POST', route, request_id: requestId, issued_at: instant,
        expires_at: instant + 60000, key_generation: 1, voucher, body, body_hash: await sha256(body) };
      value.signature = await signObject(install.privateKey, protocol + '/request', value);
      return request(route, value);
    },
    retained() {
      return canonical({ logs, events: sqlite.prepare('SELECT * FROM qbo_broker_events').all().map(row => ({ ...row })),
        replays: sqlite.prepare('SELECT * FROM qbo_broker_replays').all().map(row => ({ ...row })),
        quotas: sqlite.prepare('SELECT * FROM qbo_broker_quotas').all().map(row => ({ ...row })) });
    },
  };
}

test('voucher issuance requires operator role and a live signed owner challenge together', async () => {
  const control = await fixture();
  const issued = await control.enroll(true);
  assert.equal(issued.status, 202);
  assert.equal(control.delivered(), 1);
  assert.equal(Object.hasOwn(await issued.json(), 'voucher'), false);
  assert.equal(control.retained().includes(callback), false);

  for (const [options, authorized, guard] of [[{}, false, 'enrollment.access.checked'],
    [{ hasChallenge: false }, true, 'enrollment.challenge.checked'],
    [{ staleChallenge: true }, true, 'enrollment.challenge.checked'],
    [{ missingSignature: true }, true, 'enrollment.challenge.checked']]) {
    const denied = await fixture(options);
    const response = await denied.enroll(authorized);
    assert.ok(response.status >= 400);
    assert.equal(denied.delivered(), 0);
    assert.equal(denied.sqlite.prepare('SELECT COUNT(*) AS n FROM qbo_broker_replays').get().n, 0);
    assert.ok(denied.observed.includes(guard));
    assert.equal(denied.fake.snapshot().mutated.exchange, 0);
  }
  const replayed = await control.enroll(true);
  assert.equal(replayed.status, 409);
  assert.equal(control.delivered(), 1);
});

test('start and refresh reject an invalid delivery curve point before any provider send', async () => {
  const control = await fixture();
  assert.equal((await control.enroll(true)).status, 202);
  assert.equal((await control.broker.fetch(await control.signed())).status, 201);
  const refreshControl = await control.broker.fetch(await control.signed('refresh', { refresh_token: await control.seedRefresh() }));
  assert.equal(refreshControl.status, 200);
  assert.equal(control.fake.snapshot().mutated.refresh, 1);
  const invalidKey = { kty: 'EC', crv: 'P-256', x: encode64(new Uint8Array(32)), y: encode64(new Uint8Array(32)) };
  for (const kind of ['start', 'refresh']) {
    const target = await fixture();
    assert.equal((await target.enroll(true)).status, 202);
    const response = await target.broker.fetch(await target.signed(kind, { delivery_public_key: invalidKey }));
    assert.ok(response.status >= 400 && response.status < 500, 'invalid recipient key must refuse during admission');
    assert.equal(target.fake.snapshot().attempted.refresh, 0);
    assert.equal(target.sqlite.prepare('SELECT COUNT(*) AS n FROM qbo_broker_replays WHERE route <> ?').get(ROUTES.issue).n, 0);
  }
});

test('provider-thrown runtime token canary cannot escape into responses, logs or retained rows', async () => {
  const control = await fixture();
  assert.equal((await control.enroll(true)).status, 202);
  assert.equal((await control.broker.fetch(await control.signed('refresh', { refresh_token: await control.seedRefresh() }))).status, 200);
  const target = await fixture();
  assert.equal((await target.enroll(true)).status, 202);
  const originalToken = await target.seedRefresh();
  let tokenCanary;
  target.setProvider(async req => {
    const result = await target.fake.fetch(req);
    tokenCanary = (await result.json()).refresh_token;
    throw new Error(tokenCanary);
  });
  const response = await target.broker.fetch(await target.signed('refresh', { refresh_token: originalToken }));
  assert.equal(response.status, 503);
  assert.ok(typeof tokenCanary === 'string' && tokenCanary.length > 0);
  assert.equal(target.fake.snapshot().attempted.refresh, 1);
  assert.equal(target.fake.snapshot().mutated.refresh, 1);
  assert.ok(!(await response.text()).includes(tokenCanary));
  assert.ok(!target.retained().includes(tokenCanary) && !target.retained().includes(originalToken));
});

test('refused enrollment and callback attempts leave only closed stable security events', async () => {
  const control = await fixture();
  assert.equal((await control.enroll(true)).status, 202);
  assert.ok(control.logs.length > 0);
  for (const event of control.logs) assertSchema('auditEvent', event);
  const refused = await fixture();
  const response = await refused.enroll(false);
  assert.equal(response.status, 401);
  assert.equal(refused.logs.length, 1, 'an unauthorized issue attempt must remain visible');
  assert.equal(refused.logs[0].outcome, 'unauthorized');
  assert.equal(refused.logs[0].install_fingerprint, null);
  assertSchema('auditEvent', refused.logs[0]);
  const tokenCanary = randomCapability();
  const returned = await refused.broker.fetch(new Request('https://broker.invalid' + ROUTES.callback + '?code=' + tokenCanary));
  assert.equal(returned.status, 303);
  assert.equal(refused.logs.length, 2, 'an invalid callback must remain visible without its query');
  assertSchema('auditEvent', refused.logs[1]);
  assert.ok(!refused.retained().includes(tokenCanary));
  assert.ok(!returned.headers.get('location').includes('?'));
});

test('recent provider rejection threshold closes route admission using persisted events', async () => {
  const target = await fixture();
  assert.equal((await target.enroll(true)).status, 202);
  assert.equal((await target.broker.fetch(await target.signed())).status, 201);
  const sample = { ...target.sqlite.prepare('SELECT * FROM qbo_broker_events WHERE route = ? LIMIT 1').get(ROUTES.start) };
  for (let index = 0; index < 20; index++) {
    await target.store.recordEvent({ ...sample, event_id_hash: randomCapability(), outcome: 'provider_uncertain', phase: 'failed' });
  }
  const response = await target.broker.fetch(await target.signed());
  assert.equal(response.status, 429);
  assert.equal(target.sqlite.prepare('SELECT COUNT(*) AS n FROM qbo_broker_replays WHERE route = ?').get(ROUTES.start).n, 1);
  assert.equal(target.fake.snapshot().mutated.exchange, 0);
});

test('start refuses a capsule beyond its wire limit even when the complete cookie fits', async () => {
  const longCapability = () => encode64(crypto.getRandomValues(new Uint8Array(96)));
  const control = await fixture();
  assert.equal((await control.enroll(true)).status, 202);
  const normal = await control.broker.fetch(await control.signed('start', { intent: longCapability() }, longCapability()));
  assert.equal(normal.status, 201);
  assertSchema('launchResponse', await normal.json());

  const hostname = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(53), 'invalid'].join('.');
  const ownerCallback = `https://${hostname}/api/quickbooks/connect/callback`;
  const largest = await fixture({ ownerCallback });
  assert.equal((await largest.enroll(true)).status, 202);
  const maximum = await largest.broker.fetch(await largest.signed('start', { intent: longCapability() }, longCapability()));
  assert.equal(maximum.status, 201);
  assertSchema('launchResponse', await maximum.json());

  // Current valid inputs remain below the capsule limit. Inject a serializer
  // fault into the actual handler to prove output validation is independent
  // of the complete-cookie check and occurs before a replay row is committed.
  const sourceUrl = new URL('../src/broker.mjs', import.meta.url);
  const source = readFileSync(sourceUrl, 'utf8');
  const seam = "const transaction = await crypt.seal('launch', payload);";
  assert.ok(source.includes(seam));
  const injected = source.replace(seam, seam + `\n    transaction.ciphertext = '${'A'.repeat(3502)}';`)
    .replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, sourceUrl).href}'`);
  const altered = await import('data:text/javascript;base64,' + Buffer.from(injected).toString('base64'));
  const target = await fixture({ ownerCallback, brokerFactory: altered.createBroker });
  assert.equal((await target.enroll(true)).status, 202);
  const signed = await target.signed('start', { intent: longCapability() }, longCapability());
  assertSchema('startRequest', await signed.clone().json());
  const response = await target.broker.fetch(signed);
  const result = await response.json();
  assert.ok(response.status >= 400 && response.status < 500,
    `oversized capsule must refuse before commit; returned ciphertext length ${result.transaction?.ciphertext.length ?? 0}`);
  assert.equal(target.sqlite.prepare('SELECT COUNT(*) AS n FROM qbo_broker_replays WHERE route = ?').get(ROUTES.start).n, 0);
  assert.equal(target.fake.snapshot().mutated.exchange, 0);
});
