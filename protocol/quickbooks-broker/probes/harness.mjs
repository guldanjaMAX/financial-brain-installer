// Review probes only. This file does not implement either Worker.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createFakeIntuit } from '../testing/fake-intuit.mjs';
import { validates } from '../testing/schema-test-helper.mjs';
const schemas = JSON.parse(readFileSync(new URL('../v1/schemas/protocol.schema.json', import.meta.url), 'utf8'));

export const PROTOCOL = 'qbo-broker/1';
export const BROKER = 'https://broker.invalid';
export const CALLBACK = '/v1/quickbooks/oauth/callback';
export const OWNER_CALLBACK = '/api/quickbooks/connect/callback';
export const START = '/v1/quickbooks/authorizations';
export const REFRESH = '/v1/quickbooks/tokens/refresh';
export const REVOKE = '/v1/quickbooks/tokens/revoke';
const ADAPTER = new URL('../implementation-adapter.mjs', import.meta.url);

export async function loadImplementation() {
  assert.ok(existsSync(ADAPTER),
    'BROKER_IMPLEMENTATION_MISSING: implement the reviewed in-memory adapter before this E2E gate can pass');
  const module = await import(ADAPTER.href);
  assert.ok(typeof module.createProbeAdapter === 'function', 'adapter must export createProbeAdapter');
  return module.createProbeAdapter;
}

export function jsonRequest(url, body, headers = {}) {
  return new Request(url, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

export function launchRequest(body) {
  assert.ok(validates(schemas, 'launchRequest', body), 'launch form must contain the exact logical launch request');
  // The decoded capsule has only ASCII keys and scalar schema-constrained values.
  // Its compact sorted-key JSON is carried in one HTML form field, not a fetch body.
  const transaction = JSON.stringify(Object.fromEntries(
    Object.keys(body.transaction).sort().map(key => [key, body.transaction[key]]),
  ));
  return new Request(BROKER + '/v1/quickbooks/launch', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      protocol: body.protocol, launch_capability: body.launch_capability, transaction,
    }).toString(),
  });
}

export async function rewriteJson(request, change, headers = {}) {
  const body = await request.clone().json();
  change(body);
  return jsonRequest(request.url, body, { ...Object.fromEntries(request.headers), ...headers });
}

export function rejected(response) {
  assert.ok(response.status >= 400 && response.status < 600, 'request must be refused');
}

export function queryFree(response) {
  assert.ok(response.status === 303, 'completion must use a redirect');
  let target;
  try { target = new URL(response.headers.get('location')); }
  catch { assert.fail('completion must contain a valid absolute URL'); }
  assert.ok(target.protocol === 'https:' && !target.search && !target.hash,
    'completion must have no query or fragment');
  assert.ok([
    'https://broker.invalid/v1/quickbooks/result',
    'https://owner-a.invalid/app/connect/quickbooks',
    'https://owner-b.invalid/app/connect/quickbooks',
  ].includes(target.href), 'completion must use an exact approved result page');
}

export function reached(rig, event, since = 0) {
  assert.ok(rig.events.slice(since).includes(event), `probe must reach ${event}`);
}

export function ordered(rig, before, after) {
  reached(rig, before);
  reached(rig, after);
  assert.ok(rig.events.indexOf(before) < rig.events.indexOf(after), `probe requires ${before} before ${after}`);
}

// All external effects are injected. There is no global fetch or socket fallback.
export async function createRig(factory) {
  let time = Date.parse('2026-01-01T00:00:00Z');
  const now = () => time;
  const provider = createFakeIntuit({ now });
  const origins = ['https://owner-a.invalid', 'https://owner-b.invalid'];
  const events = [];
  const deliveries = [];
  const receipts = [];
  const returned = [];
  const privateValues = new Set([provider.config.clientSecret]);
  const credentials = new Set([provider.config.clientSecret]);
  const outbound = { brokerAccounting: 0, ownerAccounting: 0, blocked: 0, delivery: 0 };
  let ownerDeliveryFault;
  let resolverAddress = '93.184.216.34';
  let adapter;
  const providerOrigins = new Set([
    new URL(provider.config.authorizationUrl).origin,
    new URL(provider.config.tokenUrl).origin,
    new URL(provider.config.revokeUrl).origin,
    ...Object.values(provider.config.apiOrigins),
  ]);
  const fetchFor = caller => async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === BROKER) {
      assert.ok(caller === 'owner', 'only an owner Worker may use the injected broker control transport');
      return adapter.broker.fetch(request);
    }
    if (providerOrigins.has(url.origin)) {
      if (url.pathname.startsWith('/v3/company/')) {
        outbound[caller === 'broker' ? 'brokerAccounting' : 'ownerAccounting']++;
        assert.ok(caller === 'owner', 'broker must never contact accounting API');
      }
      const response = await provider.fetch(request);
      if (response.headers.get('content-type')?.includes('application/json')) {
        const body = await response.clone().json().catch(() => null);
        for (const key of ['access_token', 'refresh_token', 'realmId']) {
          if (typeof body?.[key] === 'string') privateValues.add(body[key]);
          if (key !== 'realmId' && typeof body?.[key] === 'string') credentials.add(body[key]);
        }
      }
      return response;
    }
    const owner = origins.indexOf(url.origin);
    if (owner !== -1) {
      assert.ok(request.redirect === 'manual', 'owner delivery must prohibit redirect following');
      if (url.pathname === OWNER_CALLBACK) {
        outbound.delivery++;
        deliveries.push(request.clone());
        const envelope = await request.clone().json();
        if (typeof envelope.ciphertext === 'string') privateValues.add(envelope.ciphertext);
        if (ownerDeliveryFault === 'unavailable') throw new Error('probe_delivery_unavailable');
        if (ownerDeliveryFault === 'redirect') {
          return new Response(null, { status: 307, headers: { location: 'https://elsewhere.invalid/collect' } });
        }
        const response = await adapter.owners[owner].fetch(request);
        receipts.push(response.clone());
        if (ownerDeliveryFault === 'lost_receipt_once') {
          ownerDeliveryFault = undefined;
          throw new Error('probe_receipt_lost');
        }
        return response;
      }
      return adapter.owners[owner].fetch(request);
    }
    outbound.blocked++;
    throw new Error('probe_network_target_refused');
  };
  adapter = await factory({
    protocol: PROTOCOL, now, origins,
    brokerConfig: provider.config,
    brokerFetch: fetchFor('broker'), ownerFetch: fetchFor('owner'),
    resolve: async () => [resolverAddress],
    observe: event => {
      assert.ok(typeof event === 'string' && /^[a-z_.]+$/.test(event), 'observations are fixed event names only');
      events.push(event);
    },
  });
  assert.ok(typeof adapter.broker?.fetch === 'function', 'adapter must expose the broker request handler');
  assert.ok(adapter.owners?.length === 2, 'adapter must expose two isolated owner Workers');
  assert.ok(typeof adapter.inspect === 'function' && typeof adapter.armFault === 'function', 'adapter must expose storage observations and injected faults');
  assert.ok(typeof adapter.fixtures?.enroll === 'function' && typeof adapter.fixtures?.signedRequest === 'function', 'adapter must supply wire fixture builders');
  const recordResponse = async response => {
    returned.push(await response.clone().text(), JSON.stringify(Object.fromEntries(response.headers)));
    return response;
  };

  const rig = {
    adapter, provider, now, origins, events, deliveries, receipts, outbound,
    advance: milliseconds => { time += milliseconds; },
    deliveryFault: fault => { ownerDeliveryFault = fault; },
    resolveTo: address => { resolverAddress = address; },
    enroll: (owner = 0, options = {}) => adapter.fixtures.enroll({ owner, ...options }),
    inspect: () => adapter.inspect(),
    state: (owner = 0) => adapter.inspect().owners[owner],
    broker: async request => recordResponse(await adapter.broker.fetch(request)),
    signed: (route, options = {}) => adapter.fixtures.signedRequest({ owner: 0, route, ...options }),
    owner: async (path, { owner = 0, authenticated = true, body } = {}) => {
      const headers = authenticated ? adapter.owners[owner].authHeaders : {};
      const request = body === undefined
        ? new Request(origins[owner] + path, { headers, redirect: 'manual' })
        : jsonRequest(origins[owner] + path, body, headers);
      return recordResponse(await adapter.owners[owner].fetch(request));
    },
    async start(owner = 0) {
      const response = await rig.owner('/api/quickbooks/connect/start', { owner, body: {} });
      assert.ok(response.ok, 'authenticated enrolled start control must succeed');
      const result = await response.json();
      assert.ok(result.protocol === PROTOCOL && typeof result.launch_capability === 'string' &&
        typeof result.transaction?.ciphertext === 'string', 'start returns one launch capability and sealed transaction');
      privateValues.add(result.launch_capability);
      privateValues.add(result.transaction.ciphertext);
      return result;
    },
    async launch(start) {
      const response = await rig.broker(launchRequest({
        protocol: PROTOCOL, launch_capability: start.launch_capability, transaction: start.transaction,
      }));
      assert.ok(response.status === 303, 'launch control must redirect');
      const cookie = response.headers.get('set-cookie');
      assert.ok(typeof cookie === 'string' && /HttpOnly/i.test(cookie) && /Secure/i.test(cookie) && /SameSite=Lax/i.test(cookie), 'transaction cookie flags must be set');
      const url = new URL(response.headers.get('location'));
      assert.ok(url.origin + url.pathname === provider.config.authorizationUrl, 'launch uses the fixed provider endpoint');
      assert.ok(url.searchParams.get('redirect_uri') === provider.config.redirectUri, 'launch uses the fixed registered redirect');
      assert.ok(url.searchParams.get('client_id') === provider.config.clientId &&
        url.searchParams.get('response_type') === 'code' &&
        url.searchParams.get('scope') === 'com.intuit.quickbooks.accounting' &&
        [...url.searchParams.keys()].length === 5, 'launch uses the exact configured provider query');
      return { url, cookie: cookie.split(';')[0] };
    },
    async consent(launch, consent = true) {
      const authorization = new URL(launch.url);
      // The provider fake models the human consent decision through its grant helper.
      const grant = await provider.grant({
        state: authorization.searchParams.get('state'), environment: 'sandbox', consent,
      });
      for (const key of ['code', 'realmId', 'state']) {
        if (grant.callback.searchParams.has(key)) privateValues.add(grant.callback.searchParams.get(key));
      }
      return new Request(grant.callback, { headers: { cookie: launch.cookie }, redirect: 'manual' });
    },
    async pending(owner = 0) {
      const enrollment = await rig.enroll(owner);
      assert.ok(enrollment.ok, 'approved live ownership enrollment control must succeed');
      return rig.launch(await rig.start(owner));
    },
    async connect(owner = 0) {
      const response = await rig.broker(await rig.consent(await rig.pending(owner)));
      queryFree(response);
      connected(rig, owner);
      return response;
    },
    async assertPrivate() {
      const snapshot = rig.inspect();
      const retained = JSON.stringify({ rows: snapshot.brokerRows, logs: snapshot.brokerLogs });
      for (const value of privateValues) {
        assert.ok(!retained.includes(value), 'broker storage and logs must exclude transient credentials and ciphertext');
      }
      for (const origin of origins) {
        assert.ok(!retained.includes(origin), 'broker storage and logs must exclude callback origins');
      }
      for (const value of credentials) {
        assert.ok(returned.every(bytes => !bytes.includes(value)), 'responses must not return provider credentials');
      }
      assert.ok(Array.isArray(snapshot.brokerRows) && snapshot.brokerRows.every(row =>
        ['auditEvent', 'replayRow', 'quotaRow'].some(name => validates(schemas, name, row))) &&
        Array.isArray(snapshot.brokerLogs) && snapshot.brokerLogs.every(row => validates(schemas, 'auditEvent', row)),
        'broker retention must use only the reviewed non-content schema');
      assert.ok(outbound.brokerAccounting === 0, 'broker receives no accounting requests');
    },
  };
  return rig;
}

export function connected(rig, owner = 0) {
  const state = rig.state(owner);
  assert.ok(state.status === 'connected', 'owner readback is the connection authority');
  assert.ok(state.tokenGeneration >= 1 && state.tokenCiphertextCount >= 3, 'owner must store the encrypted token pair and company');
  assert.ok(state.connectionCommitCount === 1 && state.connectionReadbackCount >= 1, 'one connection save requires exact readback');
  reached(rig, 'owner.connection.readback');
}

export function noExchange(rig, event) {
  reached(rig, event);
  assert.ok(rig.provider.snapshot().attempted.exchange === 0, 'refusal must precede provider exchange');
  assert.ok(rig.state().connectionCommitCount === 0, 'refusal must not activate a connection');
}
