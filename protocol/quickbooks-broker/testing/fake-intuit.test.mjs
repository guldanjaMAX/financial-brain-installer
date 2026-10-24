import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeIntuit } from './fake-intuit.mjs';

const credentials = (fake) => `Basic ${Buffer.from(`${fake.config.clientId}:${fake.config.clientSecret}`).toString('base64')}`;
const post = (fake, url, fields, overrides = {}) => fake.fetch(url, {
  method: 'POST', headers: { authorization: credentials(fake), 'content-type': 'application/x-www-form-urlencoded', ...overrides.headers },
  body: new URLSearchParams(fields), ...overrides,
});
const codeFields = (fake, callback) => ({ grant_type: 'authorization_code', code: callback.searchParams.get('code'), redirect_uri: fake.config.redirectUri });
async function pair(fake) {
  const { callback } = await fake.grant();
  const response = await post(fake, fake.config.tokenUrl, codeFields(fake, callback));
  assert.equal(response.status, 200, 'code exchange control');
  return { callback, tokens: await response.json() };
}
const refresh = (fake, token) => post(fake, fake.config.tokenUrl, { grant_type: 'refresh_token', refresh_token: token });
const revoke = (fake, token) => fake.fetch(fake.config.revokeUrl, {
  method: 'POST', headers: { authorization: credentials(fake), 'content-type': 'application/json' }, body: JSON.stringify({ token }),
});
const read = (fake, tokens, realm, options = {}) => fake.fetch(
  `${fake.config.apiOrigins.sandbox}/v3/company/${encodeURIComponent(realm)}/query?query=${encodeURIComponent('SELECT * FROM Account STARTPOSITION 1 MAXRESULTS 1000')}`,
  { headers: { authorization: `Bearer ${tokens.access_token}` }, ...options },
);

test('fake consent control preserves state; cancellation creates no exchangeable code', async () => {
  const fake = createFakeIntuit();
  const state = fake.opaque('state');
  const accepted = await fake.grant({ state });
  assert.ok(accepted.callback.searchParams.get('state') === state, 'state preserved without printing it');
  assert.ok(accepted.callback.searchParams.has('code'));
  const denied = await fake.grant({ state, consent: false });
  assert.equal(denied.callback.searchParams.get('error'), 'access_denied');
  assert.equal(denied.callback.searchParams.has('code'), false);
  assert.equal(fake.snapshot().issuedPairs, 0);
  await pair(fake);
});

test('fake exact authorization target, client, callback, scope and duplicate-key checks have a valid control', async () => {
  const fake = createFakeIntuit();
  const { callback } = await fake.grant();
  assert.equal(callback.origin, new URL(fake.config.redirectUri).origin);
  const valid = new URL(fake.config.authorizationUrl);
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: fake.config.clientId, redirect_uri: fake.config.redirectUri, scope: 'com.intuit.quickbooks.accounting', state: fake.opaque('state') })) valid.searchParams.set(key, value);
  for (const [key, value] of [['client_id', fake.opaque('wrong-app')], ['redirect_uri', 'https://other.invalid/callback'], ['scope', 'openid'], ['response_type', 'token']]) {
    const url = new URL(valid); url.searchParams.set(key, value);
    assert.equal((await fake.fetch(url)).status, 400, `reject altered ${key}`);
  }
  const duplicate = new URL(valid); duplicate.searchParams.append('state', fake.opaque('state'));
  assert.equal((await fake.fetch(duplicate)).status, 400);
  assert.equal((await fake.fetch(valid)).status, 302);
});

async function oneUseCodeInvariant(fake) {
  const { callback } = await pair(fake);
  const replay = await post(fake, fake.config.tokenUrl, codeFields(fake, callback));
  assert.equal(replay.status, 400, 'authorization code replay must fail');
  assert.equal(fake.snapshot().mutated.exchange, 1);
}

test('fake code is single use; named mutant REUSE_CODE is killed by the same passing unit', async () => {
  await oneUseCodeInvariant(createFakeIntuit());
  await assert.rejects(() => oneUseCodeInvariant(createFakeIntuit({ mutant: 'reuse-code' })), { code: 'ERR_ASSERTION', message: /authorization code replay must fail/ });
});

test('fake code rejects wrong app proof, redirect, unknown code and expiry before mutation', async () => {
  let instant = 1_000;
  const fake = createFakeIntuit({ now: () => instant, lifetimes: { codeMs: 1_000 } });
  const { callback } = await fake.grant();
  const fields = codeFields(fake, callback);
  assert.equal((await post(fake, fake.config.tokenUrl, fields, { headers: { authorization: `Basic ${Buffer.from(fake.opaque('wrong-app')).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' } })).status, 401);
  assert.equal((await post(fake, fake.config.tokenUrl, { ...fields, redirect_uri: 'https://other.invalid/callback' })).status, 400);
  assert.equal((await post(fake, fake.config.tokenUrl, { ...fields, code: fake.opaque('unknown-code') })).status, 400);
  assert.equal(fake.snapshot().mutated.exchange, 0);
  assert.equal((await post(fake, fake.config.tokenUrl, fields)).status, 200, 'same untouched code remains valid');
  const expired = await fake.grant(); instant += 1_000;
  assert.equal((await post(fake, fake.config.tokenUrl, codeFields(fake, expired.callback))).status, 400);
  await pair(fake);
});

test('fake refresh rotates both tokens and refuses old, unknown and expired grants', async () => {
  let instant = 1_000;
  const fake = createFakeIntuit({ now: () => instant, lifetimes: { refreshMs: 2_000 } });
  const { tokens, callback } = await pair(fake);
  const result = await refresh(fake, tokens.refresh_token);
  assert.equal(result.status, 200);
  const replacement = await result.json();
  assert.ok(replacement.refresh_token !== tokens.refresh_token && replacement.access_token !== tokens.access_token, 'replacement pair differs');
  assert.equal((await refresh(fake, tokens.refresh_token)).status, 400);
  assert.equal((await refresh(fake, fake.opaque('unknown-refresh'))).status, 400);
  assert.equal((await read(fake, tokens, callback.searchParams.get('realmId'))).status, 401, 'old generation is rejected');
  assert.equal((await read(fake, replacement, callback.searchParams.get('realmId'))).status, 200);
  instant += 2_000;
  assert.equal((await refresh(fake, replacement.refresh_token)).status, 400);
  const fresh = await pair(fake);
  assert.equal((await refresh(fake, fresh.tokens.refresh_token)).status, 200);
});

test('fake hard refresh deadline survives rotations and access expiry uses injected time', async () => {
  let instant = 1_000;
  const fake = createFakeIntuit({ now: () => instant, lifetimes: { accessMs: 1_000, refreshMs: 10_000, hardRefreshMs: 2_000 } });
  const { tokens, callback } = await pair(fake);
  const realm = callback.searchParams.get('realmId');
  assert.equal((await read(fake, tokens, realm)).status, 200);
  instant += 1_000;
  assert.equal((await read(fake, tokens, realm)).status, 401);
  const renewed = await refresh(fake, tokens.refresh_token);
  assert.equal(renewed.status, 200);
  const replacement = await renewed.json();
  instant += 1_000;
  assert.equal((await refresh(fake, replacement.refresh_token)).status, 400);
  await pair(fake);
});

test('fake revoke confirms and disables either token; invalid token is definitely rejected', async () => {
  for (const type of ['access_token', 'refresh_token']) {
    const fake = createFakeIntuit();
    const { tokens, callback } = await pair(fake);
    assert.equal((await read(fake, tokens, callback.searchParams.get('realmId'))).status, 200);
    assert.equal((await revoke(fake, tokens[type])).status, 200);
    assert.equal((await refresh(fake, tokens.refresh_token)).status, 400);
    assert.equal((await read(fake, tokens, callback.searchParams.get('realmId'))).status, 401);
    assert.equal((await revoke(fake, fake.opaque('unknown-token'))).status, 400);
    assert.equal(fake.snapshot().mutated.revoke, 1);
  }
});

test('fake revoke follows the repository provider JSON wire shape and rejects form bodies', async () => {
  const fake = createFakeIntuit();
  const { tokens } = await pair(fake);
  assert.equal((await post(fake, fake.config.revokeUrl, { token: tokens.refresh_token })).status, 415);
  assert.equal(fake.snapshot().mutated.revoke, 0);
  assert.equal((await revoke(fake, tokens.refresh_token)).status, 200, 'valid JSON revoke control');
});

for (const route of ['exchange', 'refresh', 'revoke']) {
  test(`fake ${route} loss before versus after contact has distinct reached and mutation counters`, async () => {
    for (const fault of ['loss_before', 'loss_after']) {
      const fake = createFakeIntuit();
      const initial = route === 'exchange' ? await fake.grant() : await pair(fake);
      const invoke = route === 'exchange'
        ? () => post(fake, fake.config.tokenUrl, codeFields(fake, initial.callback))
        : route === 'refresh' ? () => refresh(fake, initial.tokens.refresh_token) : () => revoke(fake, initial.tokens.refresh_token);
      const before = fake.snapshot();
      fake.queueFault(route, fault);
      await assert.rejects(invoke, { code: 'FAKE_TRANSPORT_LOSS' });
      const after = fake.snapshot();
      assert.equal(after.attempted[route] - before.attempted[route], 1);
      assert.equal(after.reached[route] - before.reached[route], fault === 'loss_after' ? 1 : 0);
      assert.equal(after.mutated[route] - before.mutated[route], fault === 'loss_after' ? 1 : 0);
      if (fault === 'loss_before') assert.equal((await invoke()).status, 200, 'no-contact request control');
      else if (route !== 'revoke') assert.equal((await invoke()).status, 400, 'provider consumed grant despite lost response');
      await pair(fake);
    }
  });
}

for (const route of ['exchange', 'refresh', 'revoke', 'accounting']) {
  test(`fake ${route} 429, 5xx and rejection are bounded one-shot faults with passing controls`, async () => {
    const fake = createFakeIntuit();
    const initial = route === 'exchange' ? await fake.grant() : await pair(fake);
    const invoke = route === 'exchange'
      ? () => post(fake, fake.config.tokenUrl, codeFields(fake, initial.callback))
      : route === 'refresh' ? () => refresh(fake, initial.tokens.refresh_token)
        : route === 'revoke' ? () => revoke(fake, initial.tokens.refresh_token)
          : () => read(fake, initial.tokens, initial.callback.searchParams.get('realmId'));
    for (const [fault, status] of [['rate_limit', 429], ['server_error', 503], ['reject', 400]]) {
      fake.queueFault(route, fault);
      const result = await invoke();
      assert.equal(result.status, status);
      if (status === 429) assert.equal(result.headers.get('retry-after'), '30');
    }
    assert.equal((await invoke()).status, 200, 'same valid request control after fault queue clears');
  });
}

for (const route of ['exchange', 'refresh']) {
  test(`fake ${route} malformed, missing replacement and changed company responses follow provider mutation`, async () => {
    for (const fault of ['malformed', 'missing_refresh', 'changed_company']) {
      const fake = createFakeIntuit();
      const initial = route === 'exchange' ? await fake.grant() : await pair(fake);
      const before = fake.snapshot().mutated[route];
      fake.queueFault(route, fault);
      const result = route === 'exchange'
        ? await post(fake, fake.config.tokenUrl, codeFields(fake, initial.callback))
        : await refresh(fake, initial.tokens.refresh_token);
      assert.equal(result.status, 200);
      assert.equal(fake.snapshot().mutated[route], before + 1);
      if (fault === 'malformed') await assert.rejects(() => result.json(), SyntaxError);
      else {
        const data = await result.json();
        if (fault === 'missing_refresh') assert.equal(Object.hasOwn(data, 'refresh_token'), false);
        else assert.ok(data.realmId !== initial.callback.searchParams.get('realmId'), 'malicious company echo differs');
      }
      const control = await pair(fake);
      assert.ok(typeof control.tokens.refresh_token === 'string');
    }
  });
}

test('fake accounting enforces direct read-only queries, realm, environment, safe entity and bounds', async () => {
  const fake = createFakeIntuit();
  const { tokens, callback } = await pair(fake);
  const realm = callback.searchParams.get('realmId');
  assert.equal((await read(fake, tokens, realm)).status, 200);
  assert.equal((await read(fake, tokens, fake.company())).status, 401);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await read(fake, tokens, realm, { method })).status, 405);
  const url = new URL(`${fake.config.apiOrigins.production}/v3/company/${realm}/query`);
  url.searchParams.set('query', 'SELECT * FROM Account STARTPOSITION 1 MAXRESULTS 1000');
  assert.equal((await fake.fetch(url, { headers: { authorization: `Bearer ${tokens.access_token}` } })).status, 401);
  url.hostname = new URL(fake.config.apiOrigins.sandbox).hostname;
  for (const query of ['DELETE FROM Account', 'SELECT * FROM Unsafe STARTPOSITION 1 MAXRESULTS 1', 'SELECT * FROM Account STARTPOSITION 0 MAXRESULTS 1000', 'SELECT * FROM Account STARTPOSITION 1 MAXRESULTS 1001']) {
    url.searchParams.set('query', query);
    assert.equal((await fake.fetch(url, { headers: { authorization: `Bearer ${tokens.access_token}` } })).status, 400);
  }
  assert.equal((await read(fake, tokens, realm)).status, 200);
  assert.equal(fake.snapshot().deniedWrites, 4);
});

test('fake accounting requires the Bearer scheme as well as the current access token', async () => {
  const fake = createFakeIntuit();
  const { tokens, callback } = await pair(fake);
  const realm = callback.searchParams.get('realmId');
  assert.equal((await read(fake, tokens, realm, { headers: { authorization: tokens.access_token } })).status, 401);
  assert.equal((await read(fake, tokens, realm)).status, 200, 'proper Bearer control');
});

test('fake concurrent code and refresh attempts allow exactly one provider mutation', async () => {
  const fake = createFakeIntuit();
  const { callback } = await fake.grant();
  const exchanges = await Promise.all([0, 1].map(() => post(fake, fake.config.tokenUrl, codeFields(fake, callback))));
  assert.deepEqual(exchanges.map((response) => response.status).sort(), [200, 400]);
  assert.equal(fake.snapshot().mutated.exchange, 1);
  const tokens = await exchanges.find((response) => response.status === 200).json();
  const refreshes = await Promise.all([0, 1].map(() => refresh(fake, tokens.refresh_token)));
  assert.deepEqual(refreshes.map((response) => response.status).sort(), [200, 400]);
  assert.equal(fake.snapshot().mutated.refresh, 1);
});

test('fake never forwards unknown targets or retains diagnostic credential/content fields', async () => {
  const fake = createFakeIntuit();
  const { tokens, callback } = await pair(fake);
  for (const target of ['https://unregistered.invalid/', 'http://intuit.invalid/oauth2/token', 'https://intuit.invalid/unknown', 'https://intuit.invalid:8443/oauth2/token', 'https://intuit.invalid/oauth2/token#fragment']) {
    assert.equal((await fake.fetch(target)).status, 404);
  }
  assert.equal((await read(fake, tokens, callback.searchParams.get('realmId'))).status, 200);
  const snapshot = fake.snapshot();
  const wire = JSON.stringify(snapshot);
  for (const value of [fake.config.clientId, fake.config.clientSecret, tokens.access_token, tokens.refresh_token, callback.searchParams.get('code'), callback.searchParams.get('realmId')]) assert.ok(!wire.includes(value), 'diagnostics contain only counters');
  assert.ok(Object.values(snapshot).every((value) => typeof value === 'number' || Object.values(value).every(Number.isSafeInteger)));
  snapshot.attempted.exchange = 999;
  assert.equal(fake.snapshot().attempted.exchange, 1, 'snapshot cannot mutate counters');
});
