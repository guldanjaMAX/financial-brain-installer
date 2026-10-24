// Review probes only. This file does not implement either Worker.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createFakeIntuit } from '../testing/fake-intuit.mjs';
import { validates } from '../testing/schema-test-helper.mjs';
import { parseStrictJson } from '../../../broker/quickbooks/src/validation.mjs';
const schemas = JSON.parse(readFileSync(new URL('../v1/schemas/protocol.schema.json', import.meta.url), 'utf8'));
const wire = JSON.parse(readFileSync(new URL('../v1/wire-contract.json', import.meta.url), 'utf8'));
function responseJson(text) {
  try { return parseStrictJson(text, { canonicalRequired: false }); }
  catch { assert.fail('response JSON must be unambiguous before granting a private field exception'); }
}

// The schema owns privacy classification. New annotated leaves, including
// leaves behind references or matching alternatives, need no route-specific code.
export function privateResponseFields(root, name, value) {
  assert.ok(validates(root, name, value), 'successful broker response must match its exact wire schema');
  const fields = new Map();
  const matches = (rule, data) => validates({ ...root, $defs: { ...root.$defs, probeResponseBranch: rule } },
    'probeResponseBranch', data);
  function visit(rule, data, path) {
    if (rule.$ref) visit(root.$defs[rule.$ref.slice(8)], data, path);
    if (rule['x-private'] === true) {
      assert.ok(typeof data === 'string' && data.length > 0, 'private response annotations require nonempty string values');
      fields.set(JSON.stringify(path), { path, value: data });
    }
    for (const kind of ['oneOf', 'anyOf', 'allOf']) for (const branch of rule[kind] ?? []) {
      if (matches(branch, data)) visit(branch, data, path);
    }
    for (const [key, child] of Object.entries(rule.properties ?? {})) {
      if (data !== null && typeof data === 'object' && Object.hasOwn(data, key)) visit(child, data[key], [...path, key]);
    }
    if (Array.isArray(data) && rule.items) data.forEach((item, index) => visit(rule.items, item, [...path, index]));
  }
  visit(root.$defs[name], value, []);
  return [...fields.values()];
}

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

export async function refusedUnchanged(rig, operation) {
  const before = rig.provider.snapshot();
  const owner = rig.state();
  const response = await operation();
  rejected(response);
  assert.ok(JSON.stringify(rig.provider.snapshot()) === JSON.stringify(before), 'refused replay must leave every provider outcome unchanged');
  assert.ok(JSON.stringify(rig.state()) === JSON.stringify(owner),
    'refused replay must preserve generation, fence, status, disabled reads and remote outcome');
  return response;
}

export async function readsDisabled(rig) {
  const before = rig.provider.snapshot();
  const outbound = { ...rig.outbound };
  const owner = rig.state();
  assert.ok(!owner.scheduleEnabled && !owner.readsEnabled, 'both scheduled and direct reads must be disabled');
  assert.ok(await rig.adapter.runScheduledRead({ owner: 0 }) === false, 'disabled schedule must refuse execution');
  assert.ok(await rig.adapter.runDirectRead({ owner: 0 }) === false, 'disabled direct read must refuse execution');
  assert.ok(JSON.stringify(rig.provider.snapshot()) === JSON.stringify(before) &&
    JSON.stringify(rig.outbound) === JSON.stringify(outbound), 'disabled reads must never enter any outbound transport');
  assert.ok(JSON.stringify(rig.state()) === JSON.stringify(owner), 'disabled reads must preserve the fenced owner state');
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
  const recordedResponses = new WeakMap();
  const auditOperations = [];
  const privateValues = new Map([[provider.config.clientSecret, null]]);
  const rememberPrivate = (value, permission = null) => {
    if (!privateValues.has(value)) privateValues.set(value, permission);
    else if (permission) {
      const existing = privateValues.get(value);
      assert.ok(existing?.response === permission.response && existing?.field === permission.field &&
        JSON.stringify(existing?.path) === JSON.stringify(permission.path),
        'a private value may have only one exact response field exception');
    }
  };
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
      return brokerRequest(request);
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
          if (typeof body?.[key] === 'string') rememberPrivate(body[key]);
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
        if (typeof envelope.ciphertext === 'string') rememberPrivate(envelope.ciphertext);
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
    let recorded = recordedResponses.get(response);
    if (!recorded) {
      recorded = { snapshots: [] };
      returned.push(recorded);
      recordedResponses.set(response, recorded);
    }
    // The owner forwards the same start Response. Preserve its one identity,
    // but retain every observation because its headers can change in transit.
    const snapshot = { body: await response.clone().text(), headers: Object.fromEntries(response.headers) };
    if (JSON.stringify(recorded.snapshots.at(-1)) !== JSON.stringify(snapshot)) recorded.snapshots.push(snapshot);
    return response;
  };
  const auditRequest = async (route, invoke) => {
    const before = new Set(adapter.inspect().brokerRows.map(row => row.event_id_hash).filter(Boolean));
    const response = await invoke();
    const snapshot = adapter.inspect();
    const fresh = snapshot.brokerRows.filter(row => row.route === route && row.event_id_hash && !before.has(row.event_id_hash));
    // Expectations come from the requested operation, never from whatever the
    // sink happens to retain. Empty or unrelated evidence cannot certify privacy.
    const success = response.ok || response.status === 303;
    const successAudit = ({
      '/v1/quickbooks/installations/issue': [['enrollment:accepted'], ['enrollment:delivered']],
      [START]: [['start:accepted']], '/v1/quickbooks/launch': [['launched:accepted']],
      [CALLBACK]: [['delivered:delivered', 'canceled:owner_canceled', 'failed']],
      [REFRESH]: [['refresh_started:accepted'], ['refreshed:refreshed']],
      [REVOKE]: [['not_sent:no_provider_contact', 'revoked:revoked', 'failed:provider_rejected', 'failed:provider_uncertain']],
    })[route];
    const expected = successAudit && (success ? successAudit : [['failed']]);
    if (expected) auditOperations.push({ route, expected, ids: fresh.map(row => row.event_id_hash) });
    await recordResponse(response);
    if (response.ok) {
      const recorded = recordedResponses.get(response);
      // Owner handlers can catch a transport assertion and return a refusal.
      // Keep failed validation visible even when that caller catches the error.
      try {
        const declared = wire.routes.find(candidate => candidate.path === route)?.response_schema;
        if (declared) {
          assert.ok(response.headers.get('content-type')?.includes('application/json'),
            'successful broker response must match its exact wire schema');
          const body = responseJson(await response.clone().text());
          for (const { path, value } of privateResponseFields(schemas, declared, body)) {
            rememberPrivate(value, { response: recorded, field: 'body', path });
          }
        } else {
          // The result page is the only successful non-JSON body. Redirects are
          // checked by launch/queryFree; none exempts a body or an extra header.
          assert.ok(route === wire.generic_result_path && response.headers.get('content-type')?.startsWith('text/html'),
            'successful broker response must match its exact wire schema');
        }
      } catch (error) {
        // Repairing mutable headers or reusing the object on another route
        // cannot erase an earlier invalid observation of this response.
        recorded.schemaFailure = true;
        throw error;
      }
    }
    return response;
  };
  const brokerRequest = request => {
    const url = new URL(request.url);
    if (url.pathname === CALLBACK) for (const key of ['state', 'code', 'realmId']) {
      for (const value of url.searchParams.getAll(key)) if (value) {
        rememberPrivate(value);
      }
    }
    return auditRequest(url.pathname, () => adapter.broker.fetch(request));
  };
  // Include callback receipts and direct fixture calls, not just rig.owner().
  for (const owner of adapter.owners) {
    const original = owner.fetch;
    owner.fetch = async request => recordResponse(await original(request));
  }

  const rig = {
    adapter, provider, now, origins, events, deliveries, receipts, outbound,
    advance: milliseconds => { time += milliseconds; },
    deliveryFault: fault => { ownerDeliveryFault = fault; },
    resolveTo: address => { resolverAddress = address; },
    enroll: (owner = 0, options = {}) => auditRequest('/v1/quickbooks/installations/issue', () => adapter.fixtures.enroll({ owner, ...options })),
    inspect: () => adapter.inspect(),
    state: (owner = 0) => adapter.inspect().owners[owner],
    broker: brokerRequest,
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
      assert.ok(validates(schemas, 'capability', url.searchParams.get('state')), 'launch requires a valid state');
      // Only this validated provider Location may carry state. Its other
      // headers and its entire body remain subject to the callback canaries.
      rememberPrivate(url.searchParams.get('state'), {
        response: recordedResponses.get(response), field: 'headers.location.state',
      });
      return { url, cookie: cookie.split(';')[0] };
    },
    async consent(launch, consent = true) {
      const authorization = new URL(launch.url);
      // The provider fake models the human consent decision through its grant helper.
      const grant = await provider.grant({
        state: authorization.searchParams.get('state'), environment: 'sandbox', consent,
      });
      for (const key of ['code', 'realmId', 'state']) {
        if (grant.callback.searchParams.has(key)) {
          rememberPrivate(grant.callback.searchParams.get(key));
        }
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
      assert.ok(auditOperations.length > 0, 'privacy requires an expected audited operation');
      const witnessed = new Set();
      for (const operation of auditOperations) {
        const rows = snapshot.brokerRows.filter(row => operation.ids.includes(row.event_id_hash));
        for (const alternatives of operation.expected) {
          const witness = rows.find(row => !witnessed.has(row.event_id_hash) &&
            (alternatives.includes(row.phase) || alternatives.includes(`${row.phase}:${row.outcome}`)));
          assert.ok(witness,
            `operation ${operation.route} requires audit ${alternatives.join('|')}`);
          witnessed.add(witness.event_id_hash);
        }
        for (const row of rows) assert.ok(snapshot.brokerLogs.some(log =>
          JSON.stringify(log) === JSON.stringify(row)), 'every stored audit witness requires an identical log witness');
      }
      const retained = JSON.stringify({ rows: snapshot.brokerRows, logs: snapshot.brokerLogs });
      for (const value of privateValues.keys()) {
        assert.ok(!retained.includes(value), 'broker storage and logs must exclude transient credentials and ciphertext');
      }
      for (const origin of origins) {
        assert.ok(!retained.includes(origin), 'broker storage and logs must exclude callback origins');
      }
      for (const response of returned) for (const snapshot of response.snapshots) {
        const json = snapshot.headers['content-type']?.includes('application/json') || /^[\s]*[\[{\"]/.test(snapshot.body);
        const parsed = json ? responseJson(snapshot.body) : undefined;
        for (const [value, permission] of privateValues) {
          const headers = { ...snapshot.headers };
          let body = json ? structuredClone(parsed) : snapshot.body;
          let rawBody = snapshot.body;
          if (permission?.response === response) {
            if (permission.field === 'headers.location.state') {
              const location = new URL(headers.location);
              assert.ok(location.searchParams.getAll('state').length === 1 &&
                location.searchParams.get('state') === value, 'launch state exception must be exact');
              location.searchParams.delete('state');
              headers.location = location.href;
            } else {
              const path = permission.path;
              const parent = path.slice(0, -1).reduce((object, key) => object?.[key], body);
              const fieldValue = path.length ? parent?.[path.at(-1)] : body;
              assert.ok(fieldValue === value, 'response field exception must be exact');
              // Strict decoding rejects duplicate keys and exposes escaped
              // echoes. Remove only this response's exact permitted field.
              if (path.length) delete parent[path.at(-1)];
              else body = null;
              rawBody = '';
            }
          }
          const bytes = JSON.stringify({ headers, body, rawBody });
          assert.ok(!bytes.includes(value),
            'every response header and body must exclude private values outside their exact allowed field');
        }
      }
      assert.ok(returned.every(response => !response.schemaFailure),
        'every successful broker response requires validated schema evidence');
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
