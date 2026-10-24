// Review probes only. This file does not implement either Worker.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
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
  return privateFields(root, name, value);
}

function privateFields(root, name, value, { invalid = false } = {}) {
  const fields = new Map();
  const matches = (rule, data) => validates({ ...root, $defs: { ...root.$defs, probeResponseBranch: rule } },
    'probeResponseBranch', data);
  function visit(rule, data, path) {
    if (rule.$ref) visit(root.$defs[rule.$ref.slice(8)], data, path);
    if (rule['x-private'] === true) {
      if (!invalid) assert.ok(typeof data === 'string' && data.length > 0, 'private response annotations require nonempty string values');
      if (typeof data === 'string' && data.length > 0) fields.set(JSON.stringify(path), { path, value: data });
    }
    for (const kind of ['oneOf', 'anyOf', 'allOf']) for (const branch of rule[kind] ?? []) {
      if (invalid || matches(branch, data)) visit(branch, data, path);
    }
    for (const [key, child] of Object.entries(rule.properties ?? {})) {
      if (data !== null && typeof data === 'object' && Object.hasOwn(data, key)) visit(child, data[key], [...path, key]);
    }
    if (Array.isArray(data) && rule.items) data.forEach((item, index) => visit(rule.items, item, [...path, index]));
  }
  visit(root.$defs[name], value, []);
  return [...fields.values()];
}

function requestFields(encoded) {
  const result = Object.create(null);
  for (const pair of encoded.split('&')) {
    const separator = pair.indexOf('=');
    assert.ok(separator > 0);
    const key = decodeURIComponent(pair.slice(0, separator).replaceAll('+', ' '));
    const value = decodeURIComponent(pair.slice(separator + 1).replaceAll('+', ' '));
    assert.ok(!Object.hasOwn(result, key));
    result[key] = value;
  }
  return result;
}

// A single visitor owns all wire channels, including empty ones. The recorder
// builds the denominator before invoking this function, so a skipped channel
// cannot also disappear from the completeness check.
export function captureExchange(snapshot, visit) {
  for (const [channel, value] of Object.entries(snapshot)) visit(channel, value);
}

function decodedBody(text, type) {
  try {
    if (type?.includes('application/x-www-form-urlencoded')) {
      return [...new URLSearchParams(text)].map(([name, value]) => {
        if (name === 'transaction') {
          try { value = parseStrictJson(value, { canonicalRequired: false }); } catch { /* Validation refuses it later. */ }
        }
        return { [name]: value };
      });
    }
    return [parseStrictJson(text, { canonicalRequired: false })];
  } catch { return []; }
}

function cookieFields(headers) {
  return headers.flatMap(([header, raw], index) => {
    if (!['cookie', 'set-cookie'].includes(header)) return [];
    const parts = header === 'set-cookie' ? [raw.split(';')[0]] : raw.split(';');
    return parts.map(part => {
      const pair = part.trim();
      const separator = pair.indexOf('=');
      return { index, pair, name: separator < 0 ? pair : pair.slice(0, separator),
        value: separator < 0 ? '' : pair.slice(separator + 1) };
    });
  });
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
export async function createRig(factory, { capture = captureExchange } = {}) {
  let time = Date.parse('2026-01-01T00:00:00Z');
  const now = () => time;
  const provider = createFakeIntuit({ now });
  const origins = ['https://owner-a.invalid', 'https://owner-b.invalid'];
  const events = [];
  const deliveries = [];
  const receipts = [];
  const returned = [];
  const recordedResponses = new WeakMap();
  const exchanges = [];
  const brokerInvocation = new AsyncLocalStorage();
  const auditOperations = [];
  const privateValues = new Map([[provider.config.clientSecret, null]]);
  const rememberPrivate = (value, permission = null) => {
    if (!privateValues.has(value)) privateValues.set(value, permission);
    else if (permission) {
      const existing = privateValues.get(value);
      assert.ok(existing?.response === permission.response && existing?.field === permission.field &&
        JSON.stringify(existing?.path) === JSON.stringify(permission.path) && existing?.headerValue === permission.headerValue,
        'a private value may have only one exact response field exception');
    }
  };
  const outbound = { brokerAccounting: 0, ownerAccounting: 0, blocked: 0, delivery: 0 };
  let ownerDeliveryFault;
  let resolverAddress = '93.184.216.34';
  let adapter;
  let ownerChallengeHandlers;
  const captureMessage = async (message, { direction, scope, route, bodySchemas = [], recorded,
    cookieGrant = false, privateChallenge = false, launchState } = {}) => {
    const text = await message.clone().text();
    // Headers iteration coalesces Set-Cookie in some runtimes. Its dedicated
    // accessor preserves every physical cookie, including Expires commas.
    const headers = [...message.headers].filter(([name]) => name !== 'set-cookie');
    const setCookies = message.headers.getSetCookie?.() ??
      (message.headers.has('set-cookie') ? [message.headers.get('set-cookie')] : []);
    for (const value of setCookies) headers.push(['set-cookie', value]);
    const channels = {
      body: { text, decoded: decodedBody(text, message.headers.get('content-type')) },
      headers: headers.map(([name, value]) => ({ name, value })),
      cookies: cookieFields(headers),
      query: message instanceof Request ? [...new URL(message.url).searchParams].map(([name, value]) => ({ name, value })) : [],
    };
    // Keep immutable expected bytes separate from the injected walker. Tests
    // can omit a channel or entry, but cannot shrink the recorded denominator.
    const expected = new Map(Object.entries(channels).map(([name, value]) => [name, JSON.stringify(value)]));
    const coverage = new Map();
    exchanges.push({ direction, scope, expected, coverage });
    const snapshot = { body: text, headers: Object.fromEntries(message.headers), headerEntries: channels.headers,
      cookies: channels.cookies, privateChallenge };
    // Record before validation or registration can throw. A caller catching a
    // refusal must not erase the response that caused that refusal.
    if (recorded && JSON.stringify(recorded.snapshots.at(-1)) !== JSON.stringify(snapshot)) recorded.snapshots.push(snapshot);
    const grant = index => cookieGrant && headers[index]?.[0] === 'set-cookie'
      ? { response: recorded, field: 'headers.set-cookie', path: [index], headerValue: headers[index][1] } : null;
    const visitChannel = (channel, data) => {
      assert.ok(expected.has(channel) && !coverage.has(channel), 'exchange capture must visit each known channel once');
      coverage.set(channel, JSON.stringify(data));
      if (channel === 'body') {
        if (direction === 'request' && scope === 'owner' && bodySchemas.length && message.body !== null) {
          assert.ok(data.decoded.length > 0, 'private request body must be inspectable before handler entry');
        }
        if (privateChallenge) assert.ok(validates(schemas, 'enrollmentChallenge', responseJson(text)),
          'private enrollment reply must match its exact wire schema');
        if (direction === 'response' && scope === 'broker' && message.ok) {
          if (bodySchemas.length) {
            assert.ok(message.headers.get('content-type')?.includes('application/json'),
              'successful broker response must match its exact wire schema');
            for (const schema of bodySchemas) for (const { path, value } of
              privateResponseFields(schemas, schema, responseJson(text))) {
              rememberPrivate(value, { response: recorded, field: 'body', path });
            }
          } else assert.ok(route === wire.generic_result_path && message.headers.get('content-type')?.startsWith('text/html'),
            'successful broker response must match its exact wire schema');
          return;
        }
        for (const body of data.decoded) for (const schema of bodySchemas) {
          for (const { value } of privateFields(schemas, schema, body, { invalid: true })) {
            // Requests cannot grant a response exception, including malformed
            // inspectable inputs. Existing issuance grants survive round trips.
            rememberPrivate(value);
          }
        }
      } else if (channel === 'headers') {
        if (launchState) rememberPrivate(launchState, { response: recorded, field: 'headers.location.state' });
        data.forEach((header, index) => {
          assert.ok(validates(schemas, 'exchangeHeader', header), 'every header requires a reviewed channel model');
          for (const { value } of header.value ? privateFields(schemas, 'exchangeHeader', header) : []) {
            rememberPrivate(value, grant(index));
            const bearer = /^Bearer\s+(.+)$/i.exec(value);
            if (bearer) rememberPrivate(bearer[1]);
            const basic = /^Basic\s+(.+)$/i.exec(value);
            if (basic) rememberPrivate(basic[1]);
          }
        });
      } else if (channel === 'cookies') {
        for (const cookie of data) {
          const model = { name: cookie.name, value: cookie.value };
          assert.ok(validates(schemas, 'exchangeCookie', model), 'every cookie requires a reviewed channel model');
          for (const { value } of privateFields(schemas, 'exchangeCookie', model, { invalid: true })) {
            rememberPrivate(value, grant(cookie.index));
            rememberPrivate(cookie.pair, grant(cookie.index));
          }
        }
      } else if (channel === 'query') {
        for (const { name, value } of data) for (const { value: secret } of
          privateFields(schemas, 'callbackQuery', { [name]: value }, { invalid: true })) rememberPrivate(secret);
      }
    };
    let captureFailure;
    try {
      capture(structuredClone(channels), (channel, data) => {
        try { visitChannel(channel, data); }
        catch (error) { captureFailure ??= error; }
      });
    } catch (error) { captureFailure ??= error; }
    if (captureFailure) {
      if (recorded) recorded.schemaFailure = true;
      throw captureFailure;
    }
    return snapshot;
  };
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
      await captureMessage(request, { direction: 'request', scope: 'provider', route: url.pathname,
        bodySchemas: ['callbackQuery', 'refreshBody', 'revokeBody'] });
      const response = await provider.fetch(request);
      // Provider replies are private transport input, not outward responses.
      // Capture even malformed replacements before the broker can catch them.
      await captureMessage(response, { direction: 'response', scope: 'provider', route: url.pathname,
        bodySchemas: ['tokenBundle', 'callbackQuery'] });
      return response;
    }
    const owner = origins.indexOf(url.origin);
    if (owner !== -1) {
      assert.ok(request.redirect === 'manual', 'owner delivery must prohibit redirect following');
      if (caller === 'broker' && request.method === 'GET' &&
          url.pathname === '/api/quickbooks/connect/enrollment/challenge') {
        // This authenticated private protocol reply carries the challenge by
        // contract. It is not returned to the owner/browser. Keep every broker
        // response and every direct owner call in the outward privacy scan.
        await captureMessage(request, { direction: 'request', scope: 'owner', route: url.pathname });
        const response = await ownerChallengeHandlers[owner](request);
        await recordResponse(response, { scope: 'owner', route: url.pathname,
          bodySchemas: ['enrollmentChallenge'], privateChallenge: response.ok });
        return response;
      }
      if (url.pathname === OWNER_CALLBACK) {
        outbound.delivery++;
        deliveries.push(request.clone());
        // Record before injected transport loss as well as successful receipt.
        await captureMessage(request, { direction: 'request', scope: 'owner', route: url.pathname,
          bodySchemas: ['ownerCallbackRequest'] });
        if (ownerDeliveryFault === 'unavailable') throw new Error('probe_delivery_unavailable');
        if (ownerDeliveryFault === 'redirect') {
          return recordResponse(new Response(null, { status: 307, headers: { location: 'https://elsewhere.invalid/collect' } }),
            { scope: 'owner', route: url.pathname });
        }
        const response = await recordResponse(await adapter.owners[owner].fetch(request),
          { scope: 'owner', route: url.pathname });
        receipts.push(response.clone());
        if (ownerDeliveryFault === 'lost_receipt_once') {
          ownerDeliveryFault = undefined;
          throw new Error('probe_receipt_lost');
        }
        return response;
      }
      // Observe the transport receipt after fixture wrappers too. They may
      // change a Response already captured by the inner owner entry point.
      return recordResponse(await adapter.owners[owner].fetch(request), { scope: 'owner', route: url.pathname });
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
  ownerChallengeHandlers = adapter.owners.map(owner => owner.fetch.bind(owner));
  const recordResponse = async (response, context = {}) => {
    if (context.scope === 'owner' && !context.bodySchemas) {
      const bodySchema = ({ '/api/quickbooks/connect/start': 'launchResponse',
        '/api/quickbooks/connect/enrollment/challenge': 'enrollmentChallenge',
        [OWNER_CALLBACK]: 'ownerCallbackReceipt' })[context.route];
      context = { ...context, bodySchemas: bodySchema ? [bodySchema] : [] };
    }
    let recorded = recordedResponses.get(response);
    if (!recorded) {
      recorded = { snapshots: [] };
      returned.push(recorded);
      recordedResponses.set(response, recorded);
    }
    // The owner forwards the same start Response. Preserve its one identity,
    // but retain every observation because its headers can change in transit.
    const launching = context.scope === 'broker' && context.route === '/v1/quickbooks/launch' && response.status === 303;
    let cookieGrant = false;
    let launchState;
    if (launching) {
      const cookie = response.headers.get('set-cookie');
      let location;
      try { location = new URL(response.headers.get('location')); } catch { /* Keep the invalid observation below. */ }
      cookieGrant = typeof cookie === 'string' &&
        /^__Secure-qbo_transaction=[A-Za-z0-9._-]+; Path=\/v1\/quickbooks\/oauth\/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=[0-9]+$/.test(cookie) &&
        location && location.origin + location.pathname === provider.config.authorizationUrl &&
        location.searchParams.get('redirect_uri') === provider.config.redirectUri &&
        location.searchParams.get('client_id') === provider.config.clientId &&
        location.searchParams.get('response_type') === 'code' &&
        location.searchParams.get('scope') === 'com.intuit.quickbooks.accounting' &&
        [...location.searchParams].length === 5 && validates(schemas, 'capability', location.searchParams.get('state'));
      if (cookieGrant) launchState = location.searchParams.get('state');
    }
    await captureMessage(response, { ...context, direction: 'response', recorded, cookieGrant, launchState });
    if (launching && !cookieGrant) {
      recorded.schemaFailure = true;
      assert.fail('launch response grants require the exact provider redirect and transaction cookie');
    }
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
    const declaredSchema = wire.routes.find(candidate => candidate.path === route)?.response_schema;
    await recordResponse(response, { scope: 'broker', route, bodySchemas: declaredSchema ? [declaredSchema] : [] });
    return response;
  };
  const brokerRequest = async (request, { expectInvalidRequest = false } = {}, invoke) => {
    const url = new URL(request.url);
    const declared = wire.routes.find(route => route.path === url.pathname);
    await captureMessage(request, { direction: 'request', scope: 'broker', route: url.pathname,
      bodySchemas: declared?.request_schema ? [declared.request_schema] : [] });
    if (declared?.request_schema) {
      let body;
      let decoded = false;
      let valid = false;
      try {
        // Snapshot the finite synthetic request without consuming the handler's
        // stream. Canceling a bounded reader on a tee can wait for that unread
        // handler branch, so the harness checks its buffered fixture bytes.
        const text = declared.method === 'GET' ? url.search.slice(1) : await request.clone().text();
        const form = declared.request_schema === 'launchRequest';
        // A bodyless wrong-method probe has no private payload to inspect.
        body = text === '' && request.body === null ? null
          : declared.method === 'GET' || form ? requestFields(text)
            : parseStrictJson(text, { canonicalRequired: false });
        if (form && body !== null) body.transaction = parseStrictJson(body.transaction ?? '');
        decoded = true;
        const type = form ? 'application/x-www-form-urlencoded' : 'application/json';
        valid = request.method === declared.method && !url.hash &&
          Buffer.byteLength(text) <= wire.limits.control_bytes &&
          (declared.method === 'GET' || (request.headers.get('content-type') === type &&
            !request.headers.has('content-encoding'))) && validates(schemas, declared.request_schema, body);
      } catch { /* Malformed probes must opt in below and still reach the real refusal. */ }
      // A malformed JSON/form body cannot proceed if its private leaves cannot
      // be inspected. Callback duplicates are covered individually above.
      assert.ok(expectInvalidRequest ? !valid && (decoded || url.pathname === CALLBACK) : valid,
        'broker request must match its exact wire schema before handler entry');
    } else assert.ok(!expectInvalidRequest, 'malformed probe requires a declared request schema');
    const response = await auditRequest(url.pathname, () => brokerInvocation.run(
      { request, delegated: Boolean(invoke) }, invoke ?? (() => adapter.broker.fetch(request))));
    if (expectInvalidRequest) assert.ok(response.status >= 400 ||
      (url.pathname === CALLBACK && response.status === 303 &&
        response.headers.get('location') === BROKER + wire.generic_result_path),
    'malformed request must reach a real broker refusal');
    return response;
  };
  // Direct adapter calls are fixture entry points too. Requests already inside
  // the rig boundary use its outer observation, preserving one audit witness
  // and capturing any wrapper mutation before the response reaches the caller.
  const brokerHandler = adapter.broker.fetch;
  adapter.broker.fetch = request => {
    const invocation = brokerInvocation.getStore();
    if (invocation?.request === request && !invocation.delegated) {
      invocation.delegated = true;
      return brokerHandler(request);
    }
    return brokerRequest(request, {}, () => brokerHandler(request));
  };
  // Include callback receipts and direct fixture calls, not just rig.owner().
  for (const owner of adapter.owners) {
    const original = owner.fetch;
    owner.fetch = async request => {
      const route = new URL(request.url).pathname;
      const bodySchema = ({ [OWNER_CALLBACK]: 'ownerCallbackRequest',
        '/api/quickbooks/connect/enrollment/voucher': 'enrollmentDelivery' })[route];
      await captureMessage(request, { direction: 'request', scope: 'owner', route,
        bodySchemas: bodySchema ? [bodySchema] : [] });
      return recordResponse(await original(request), { scope: 'owner', route });
    };
  }

  const rig = {
    adapter, provider, now, origins, events, deliveries, receipts, outbound,
    advance: milliseconds => { time += milliseconds; },
    deliveryFault: fault => { ownerDeliveryFault = fault; },
    resolveTo: address => { resolverAddress = address; },
    enroll: (owner = 0, { expectInvalidRequest = false, ...options } = {}) => adapter.fixtures.enroll({
      owner, ...options, send: request => brokerRequest(request, { expectInvalidRequest }),
    }),
    inspect: () => adapter.inspect(),
    state: (owner = 0) => adapter.inspect().owners[owner],
    broker: brokerRequest,
    signed: (route, options = {}) => adapter.fixtures.signedRequest({ owner: 0, route, ...options }),
    owner: async (path, { owner = 0, authenticated = true, body } = {}) => {
      const headers = authenticated ? adapter.owners[owner].authHeaders : {};
      const request = body === undefined
        ? new Request(origins[owner] + path, { headers, redirect: 'manual' })
        : jsonRequest(origins[owner] + path, body, headers);
      // Also observe after external fixture wrappers, which can mutate a
      // Response already seen inside the owner boundary.
      return recordResponse(await adapter.owners[owner].fetch(request), { scope: 'owner', route: path });
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
      return { url, cookie: cookie.split(';')[0] };
    },
    async consent(launch, consent = true) {
      const authorization = new URL(launch.url);
      // The provider fake models the human consent decision through its grant helper.
      const grant = await provider.grant({
        state: authorization.searchParams.get('state'), environment: 'sandbox', consent,
      });
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
      for (const exchange of exchanges) assert.ok(exchange.expected.size === exchange.coverage.size &&
        [...exchange.expected].every(([name, value]) => exchange.coverage.get(name) === value),
      'every recorded exchange channel must be traversed without omissions');
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
          // The exact schema-checked challenge body is private broker input.
          // Do not erase other fields, headers, or any outward observation.
          if (snapshot.privateChallenge && body?.challenge === value) {
            delete body.challenge;
            rawBody = '';
          }
          if (permission?.response === response) {
            if (permission.field === 'headers.location.state') {
              const location = new URL(headers.location);
              assert.ok(location.searchParams.getAll('state').length === 1 &&
                location.searchParams.get('state') === value, 'launch state exception must be exact');
              location.searchParams.delete('state');
              headers.location = location.href;
            } else if (permission.field === 'headers.set-cookie') {
              // Full header, transmitted pair and payload aliases share this
              // single physical field. Other cookies and headers stay visible.
              const entry = snapshot.headerEntries[permission.path[0]];
              assert.ok(entry?.name === 'set-cookie' && entry.value === permission.headerValue,
                'transaction cookie exception must be exact');
              const remaining = snapshot.headerEntries.filter((_, index) => index !== permission.path[0]);
              headers['set-cookie'] = remaining.filter(header => header.name === 'set-cookie').map(header => header.value).join(', ');
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
