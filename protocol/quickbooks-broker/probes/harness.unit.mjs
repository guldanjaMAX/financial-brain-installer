import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as helpers from './harness.mjs';
import { fixture } from '../testing/schema-test-helper.mjs';
import { createRig, jsonRequest, rewriteJson, queryFree } from './harness.mjs';
const schema = JSON.parse(readFileSync(new URL('../v1/schemas/protocol.schema.json', import.meta.url), 'utf8'));
// Header echo probes use the reviewed public CSP field, preventing the sink
// from registering its own canary and concealing a missing source capture.
const audit = () => fixture(schema, 'auditEvent', length => randomBytes(length).toString('base64url').slice(0, length));
const startResponse = () => Response.json(fixture(schema, 'launchResponse',
  length => randomBytes(length).toString('base64url').slice(0, length)));
const startRequest = () => jsonRequest(helpers.BROKER + helpers.START, fixture(schema, 'startRequest',
  length => randomBytes(length).toString('base64url').slice(0, length)));

for (const channel of ['headers', 'cookies']) test(`CAPTURE_SKIP_${channel.toUpperCase()} mutant is killed by independent exchange coverage`, async t => {
  const factory = await helpers.loadImplementation();
  const control = await createRig(factory);
  await control.connect();
  await control.assertPrivate();
  for (const omission of ['channel', 'entry']) await t.test(omission, async () => {
    let skipped = 0;
    const rig = await createRig(factory, { capture: (snapshot, visit) => helpers.captureExchange(snapshot, (name, value) => {
      if (name === channel && omission === 'channel') { skipped++; return; }
      if (name === channel && omission === 'entry' && value.length > 0) {
        skipped++;
        visit(name, value.slice(1));
        return;
      }
      visit(name, value);
    }) });
    await rig.connect();
    await assert.rejects(() => rig.assertPrivate(), {
      code: 'ERR_ASSERTION', message: /every recorded exchange channel must be traversed/,
    });
    assert.ok(skipped > 0, 'mutant must omit actual recorded channel or entry observations');
  });
});

test('schema-selected owner requests refuse uninspectable bodies before handler entry', async t => {
  for (const [route, bodySchema] of [
    [helpers.OWNER_CALLBACK, 'ownerCallbackRequest'],
    ['/api/quickbooks/connect/enrollment/voucher', 'enrollmentDelivery'],
  ]) await t.test(bodySchema, async () => {
    const spy = transportSpy();
    let calls = 0;
    const rig = await createRig(async dependencies => {
      const adapter = await spy.factory(dependencies);
      const original = adapter.owners[0].fetch;
      adapter.owners[0].fetch = request => { calls++; return original(request); };
      return adapter;
    });
    await rig.broker(startRequest());
    const body = fixture(schema, bodySchema, length => randomBytes(length).toString('base64url').slice(0, length));
    const send = value => rig.adapter.owners[0].fetch(jsonRequest(rig.origins[0] + route, value));
    assert.ok((await send(body)).status === 204 && calls === 1,
      'schema-valid owner body must reach the unchanged accepting handler');
    await rig.assertPrivate();
    assert.ok((await send({ ...body, unexpected_public_field: true })).status === 204 && calls === 2,
      'inspectable intentional-invalid owner body remains available to the real handler');
    await rig.assertPrivate();
    calls = 0;
    const duplicate = new Request(rig.origins[0] + route, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body).replace('{', '{"duplicate_probe":0,"duplicate_probe":1,'),
    });
    await assert.rejects(() => rig.adapter.owners[0].fetch(duplicate), {
      code: 'ERR_ASSERTION', message: /private request body must be inspectable before handler entry/,
    });
    assert.ok(calls === 0, 'uninspectable private owner body must never reach the accepting handler');
    await rig.assertPrivate();
  });
});

test('concurrent reuse of one broker Request preserves each capture boundary', async () => {
  async function countedRig({ blockFirst = false } = {}) {
    const spy = transportSpy();
    let capturedRequests = 0;
    let calls = 0;
    let announce;
    let release;
    const entered = new Promise(resolve => { announce = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const rig = await createRig(async dependencies => {
      const adapter = await spy.factory(dependencies);
      const original = adapter.broker.fetch;
      adapter.broker.fetch = async request => {
        if (++calls === 1 && blockFirst) { announce(); await gate; }
        return original(request);
      };
      return adapter;
    }, { capture: (snapshot, visit) => helpers.captureExchange(snapshot, (channel, value) => {
      if (channel === 'body' && value.decoded.some(body => body?.route === helpers.START)) capturedRequests++;
      visit(channel, value);
    }) });
    return { rig, entered, release, count: () => capturedRequests, calls: () => calls };
  }
  const control = await countedRig();
  const sequential = startRequest();
  assert.ok((await control.rig.adapter.broker.fetch(sequential)).ok);
  assert.ok((await control.rig.adapter.broker.fetch(sequential)).ok);
  assert.ok(control.count() === 2 && control.calls() === 2,
    'sequential reuse must capture both successful broker invocations');
  await control.rig.assertPrivate();

  const target = await countedRig({ blockFirst: true });
  const concurrent = startRequest();
  const first = target.rig.broker(concurrent);
  await target.entered;
  let second;
  try { second = await target.rig.adapter.broker.fetch(concurrent); }
  finally { target.release(); }
  assert.ok((await first).ok && second.ok && target.calls() === 2,
    'both concurrent calls must reach their successful handlers');
  assert.ok(target.count() === 2, 'each concurrent broker invocation requires its own request capture');
  await target.rig.assertPrivate();
});

test('REQUEST_SCHEMA_BYPASS mutant is killed before the handler', async t => {
  for (const attack of ['missing_private', 'unknown_field', 'duplicate_field', 'uninspectable_opt_in']) await t.test(attack, async () => {
    const spy = transportSpy();
    const rig = await createRig(spy.factory);
    const source = startRequest();
    assert.ok((await rig.broker(source.clone())).ok, 'unchanged schema-valid request must reach the handler');
    await rig.assertPrivate();
    const body = await source.clone().json();
    if (attack === 'missing_private') delete body.body.delivery_auth_key;
    if (attack === 'unknown_field') body.unrecognized = true;
    const request = ['duplicate_field', 'uninspectable_opt_in'].includes(attack)
      ? new Request(source, { body: JSON.stringify(body).replace('{', '{"protocol":"qbo-broker/1",') })
      : jsonRequest(source.url, body);
    let calls = 0;
    const original = rig.adapter.broker.fetch;
    rig.adapter.broker.fetch = async input => { calls++; return original(input); };
    await assert.rejects(() => rig.broker(request, { expectInvalidRequest: attack === 'uninspectable_opt_in' }), {
      code: 'ERR_ASSERTION', message: /broker request must match its exact wire schema before handler entry/,
    });
    assert.ok(calls === 0, 'invalid request must be rejected before the accepting handler runs');
    await rig.assertPrivate();
  });
});

test('private response fields follow schema references, branches and array paths', () => {
  assert.ok(typeof helpers.privateResponseFields === 'function', 'schema private-field traversal is required');
  const leaf = { type: 'string', minLength: 1, 'x-private': true };
  const shape = { $defs: {
    leaf,
    response: { type: 'object', additionalProperties: false, required: ['nested', 'items', 'public'], properties: {
      nested: { oneOf: [{ type: 'null' }, { $ref: '#/$defs/leaf' }] },
      items: { type: 'array', items: { allOf: [{ $ref: '#/$defs/leaf' }, leaf] } },
      public: { anyOf: [{ type: 'string', const: 'public' }, { type: 'string', const: 'private', 'x-private': true }] },
    } },
  } };
  const value = { nested: 'nested-value', items: ['first-value', 'second-value'], public: 'public' };
  const fields = helpers.privateResponseFields(shape, 'response', value);
  assert.deepEqual(fields.map(field => field.path), [['nested'], ['items', 0], ['items', 1]]);
  assert.ok(fields.every(field => typeof field.value === 'string'));
  assert.deepEqual(helpers.privateResponseFields(shape, 'response', { ...value, nested: null }).map(field => field.path),
    [['items', 0], ['items', 1]]);
  assert.throws(() => helpers.privateResponseFields(shape, 'response', { ...value, extra: true }), {
    code: 'ERR_ASSERTION', message: /successful broker response must match its exact wire schema/,
  });
});

test('every successful broker JSON route declares a response schema', () => {
  const wire = JSON.parse(readFileSync(new URL('../v1/wire-contract.json', import.meta.url), 'utf8'));
  for (const route of wire.routes.filter(route => route.success < 300)) {
    assert.ok(typeof route.response_schema === 'string' && schema.$defs[route.response_schema],
      'successful broker JSON route requires its declared schema');
  }
});

test('successful response schema refusals remain visible after a caller catches them', async () => {
  const spy = transportSpy();
  const rig = await createRig(spy.factory);
  await rig.broker(startRequest());
  const healthy = fixture(schema, 'healthResponse', length => randomBytes(length).toString('base64url').slice(0, length));
  rig.adapter.broker.fetch = async () => Response.json(healthy);
  await rig.broker(new Request(helpers.BROKER + '/health'));
  await rig.assertPrivate();
  rig.adapter.broker.fetch = async () => Response.json({ ...healthy, unexpected: true });
  await assert.rejects(() => rig.broker(new Request(helpers.BROKER + '/health')), {
    code: 'ERR_ASSERTION', message: /successful broker response must match its exact wire schema/,
  });
  await assert.rejects(() => rig.assertPrivate(), {
    code: 'ERR_ASSERTION', message: /every successful broker response requires validated schema evidence/,
  });
});

test('reobserving a repaired response cannot erase a prior schema refusal', async () => {
  const spy = transportSpy();
  const rig = await createRig(spy.factory);
  await rig.broker(startRequest());
  const body = fixture(schema, 'healthResponse', length => randomBytes(length).toString('base64url').slice(0, length));
  const response = Response.json(body);
  rig.adapter.broker.fetch = async () => response;
  await rig.broker(new Request(helpers.BROKER + '/health'));
  await rig.assertPrivate();
  response.headers.set('content-type', 'text/plain');
  await assert.rejects(() => rig.broker(new Request(helpers.BROKER + '/health')), {
    code: 'ERR_ASSERTION', message: /successful broker response must match its exact wire schema/,
  });
  response.headers.set('content-type', 'application/json');
  await rig.broker(new Request(helpers.BROKER + '/health'));
  await assert.rejects(() => rig.assertPrivate(), {
    code: 'ERR_ASSERTION', message: /every successful broker response requires validated schema evidence/,
  });
});

function transportSpy() {
  let dependencies;
  const rows = [];
  const logs = [];
  return {
    rows, logs,
    get dependencies() { return dependencies; },
    async factory(injected) {
      dependencies = injected;
      return {
        broker: { fetch: async request => {
          const route = new URL(request.url).pathname;
          const event = { ...audit(), route, phase: route === helpers.CALLBACK ? 'failed' : 'start',
            outcome: route === helpers.CALLBACK ? 'invalid_request' : 'accepted' };
          rows.push(event); logs.push({ ...event });
          return route === helpers.START ? startResponse() : new Response(null, {
            status: 303, headers: { location: 'https://broker.invalid/v1/quickbooks/result' },
          });
        } },
        owners: [0, 1].map(() => ({ fetch: async () => new Response(null, { status: 204 }), authHeaders: {} })),
        inspect: () => ({ brokerRows: rows, brokerLogs: logs, owners: [] }),
        armFault() {},
        fixtures: { enroll() {}, signedRequest() {} },
      };
    },
  };
}

test('probe request helper preserves the source and changes only its cloned JSON', async () => {
  const source = jsonRequest('https://broker.invalid/control', { protocol: 'qbo-broker/1', count: 1 });
  const changed = await rewriteJson(source, body => { body.count++; });
  assert.ok((await source.json()).count === 1 && (await changed.json()).count === 2);
  assert.ok(changed.redirect === 'manual' && changed.headers.get('content-type') === 'application/json');
});

test('probe launch models a top-level form POST with exact decoded fields', async () => {
  assert.ok(typeof helpers.launchRequest === 'function', 'form launch helper is required');
  const body = fixture(schema, 'launchRequest', length => randomBytes(length).toString('base64url').slice(0, length));
  const request = helpers.launchRequest(body);
  assert.ok(request.method === 'POST' && request.headers.get('content-type') === 'application/x-www-form-urlencoded');
  assert.ok(request.url === 'https://broker.invalid/v1/quickbooks/launch');
  const fields = new URLSearchParams(await request.text());
  assert.deepEqual([...fields.keys()], ['protocol', 'launch_capability', 'transaction']);
  assert.ok(fields.get('protocol') === body.protocol && fields.get('launch_capability') === body.launch_capability);
  const expected = JSON.stringify(Object.fromEntries(Object.entries(body.transaction).sort(([left], [right]) => left.localeCompare(right))));
  assert.ok(fields.get('transaction') === expected, 'transaction form field contains canonical compact JSON');
  assert.throws(() => helpers.launchRequest({ ...body, extra: true }), { code: 'ERR_ASSERTION' });
});

test('probe completion check accepts exact clean results and rejects redirect smuggling', () => {
  const response = location => new Response(null, { status: 303, headers: { location } });
  queryFree(response('https://owner-a.invalid/app/connect/quickbooks'));
  queryFree(response('https://broker.invalid/v1/quickbooks/result'));
  for (const location of [
    'https://owner-a.invalid/app/connect/quickbooks?status=connected',
    'https://owner-a.invalid/app/connect/quickbooks#fragment',
    'https://elsewhere.invalid/app/connect/quickbooks',
  ]) assert.throws(() => queryFree(response(location)), { code: 'ERR_ASSERTION' });
});

test('probe transport allows only in-memory destinations and refuses broker accounting', async () => {
  const spy = transportSpy();
  const rig = await createRig(spy.factory);
  const deps = spy.dependencies;
  const control = await deps.brokerFetch(rig.provider.config.authorizationUrl);
  assert.ok(control.status === 400 && rig.provider.snapshot().attempted.authorize === 1);
  await assert.rejects(() => deps.brokerFetch('https://elsewhere.invalid/'), /probe_network_target_refused/);
  assert.ok(rig.outbound.blocked === 1);
  const query = rig.provider.config.apiOrigins.sandbox + '/v3/company/fixture/query';
  assert.ok((await deps.ownerFetch(query)).status === 401);
  await assert.rejects(() => deps.brokerFetch(query), { code: 'ERR_ASSERTION' });
  assert.ok(rig.outbound.ownerAccounting === 1 && rig.outbound.brokerAccounting === 1);
});

test('probe transport permits owner control requests to the in-memory broker only', async () => {
  const spy = transportSpy();
  const rig = await createRig(spy.factory);
  rig.adapter.broker.fetch = async () => Response.json(fixture(schema, 'healthResponse',
    length => randomBytes(length).toString('base64url').slice(0, length)));
  assert.ok((await spy.dependencies.ownerFetch('https://broker.invalid/health')).status === 200);
  await assert.rejects(() => spy.dependencies.brokerFetch('https://broker.invalid/health'), { code: 'ERR_ASSERTION' });
});

test('probe privacy scan rejects generated canaries and forbidden retained field names', async () => {
  const spy = transportSpy();
  const rig = await createRig(spy.factory);
  await rig.broker(new Request(helpers.BROKER + helpers.CALLBACK + '?error=access_denied&state=' + rig.provider.opaque('state')));
  await rig.assertPrivate();
  const control = spy.rows[0];
  spy.rows.push({ metadata: rig.provider.config.clientSecret });
  await assert.rejects(() => rig.assertPrivate(), { code: 'ERR_ASSERTION' });
  spy.rows.length = 0;
  await assert.rejects(() => rig.assertPrivate(), { code: 'ERR_ASSERTION' });
  spy.rows.push(control);
  await rig.assertPrivate();
  spy.rows.push({ callback: 'https://owner-a.invalid/api/quickbooks/connect/callback' });
  await assert.rejects(() => rig.assertPrivate(), { code: 'ERR_ASSERTION' });
});

test('probe privacy scan rejects fields outside the exact durable schema', async () => {
  const spy = transportSpy();
  const rig = await createRig(spy.factory);
  await rig.broker(startRequest());
  await rig.assertPrivate();
  spy.rows[0].unexpected_public_field = true;
  await assert.rejects(() => rig.assertPrivate(), { code: 'ERR_ASSERTION' });
});

test('probe event ordering requires both observed boundaries', () => {
  assert.ok(typeof helpers.ordered === 'function', 'order helper is required');
  helpers.ordered({ events: ['fence', 'sent'] }, 'fence', 'sent');
  for (const events of [['sent'], ['fence'], ['sent', 'fence']]) {
    assert.throws(() => helpers.ordered({ events }, 'fence', 'sent'), { code: 'ERR_ASSERTION' });
  }
});

test('probe privacy scan rejects a generated credential returned to the browser', async () => {
  const spy = transportSpy();
  const rig = await createRig(spy.factory);
  await rig.broker(startRequest());
  await rig.assertPrivate();
  rig.adapter.broker.fetch = async () => new Response(rig.provider.config.clientSecret);
  await assert.rejects(() => rig.broker(new Request('https://broker.invalid/health')), {
    code: 'ERR_ASSERTION', message: /successful broker response must match its exact wire schema/,
  });
  await assert.rejects(() => rig.assertPrivate(), {
    code: 'ERR_ASSERTION', message: /outside their exact allowed field/,
  });
});

test('EMPTY_AUDIT_SINKS mutant is killed for either sink and missing operation evidence', async () => {
  for (const sink of ['rows', 'logs', 'both', 'operation']) {
    const spy = transportSpy();
    const rig = await createRig(spy.factory);
    await rig.broker(startRequest());
    await rig.assertPrivate();
    if (sink === 'operation') {
      rig.adapter.broker.fetch = async () => startResponse();
      await rig.broker(startRequest());
    } else if (sink === 'both') { spy.rows.length = 0; spy.logs.length = 0; }
    else spy[sink].length = 0;
    await assert.rejects(() => rig.assertPrivate(), { code: 'ERR_ASSERTION' });
  }
  const spy = transportSpy();
  const rig = await createRig(spy.factory);
  await rig.broker(startRequest());
  await rig.assertPrivate();
  const original = rig.adapter.broker.fetch;
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  rig.adapter.broker.fetch = async request => {
    if (++calls === 2) { release(); return startResponse(); }
    await gate;
    return original(request);
  };
  await Promise.all([0, 1].map(() => rig.broker(startRequest())));
  await assert.rejects(() => rig.assertPrivate(), { code: 'ERR_ASSERTION' });
});

test('CALLBACK_RESPONSE_LEAK mutant is killed despite a clean redirect Location', async () => {
  for (const field of ['code', 'state', 'realmId']) {
    for (const surface of ['body', 'header', 'changed_callback']) {
      const spy = transportSpy();
      const rig = await createRig(spy.factory);
      const state = rig.provider.opaque('state');
      const launch = { url: new URL(rig.provider.config.authorizationUrl), cookie: 'fixture=value' };
      launch.url.searchParams.set('state', state);
      const callback = await rig.consent(launch);
      await rig.broker(startRequest());
      await rig.assertPrivate();
      const callbackUrl = new URL(callback.url);
      if (surface === 'changed_callback') callbackUrl.searchParams.set(field, rig.provider.opaque('changed'));
      const secret = callbackUrl.searchParams.get(field);
      const original = rig.adapter.broker.fetch;
      rig.adapter.broker.fetch = async request => {
        await original(request);
        return new Response(surface !== 'header' ? secret : null, { status: 303,
          headers: { location: 'https://broker.invalid/v1/quickbooks/result',
            ...(surface === 'header' ? { 'x-leaked-value': secret } : {}) } });
      };
      queryFree(await rig.broker(new Request(callbackUrl, callback)));
      await assert.rejects(() => rig.assertPrivate(), { code: 'ERR_ASSERTION' });
    }
  }
});

test('privacy audit expectations exclude read-only health and absent routes', async () => {
  const spy = transportSpy();
  const rig = await createRig(spy.factory);
  await rig.broker(startRequest());
  await rig.assertPrivate();
  for (const [path, status] of [['/health', 503], ['/absent', 404]]) {
    rig.adapter.broker.fetch = async () => new Response(null, { status });
    await rig.broker(new Request(helpers.BROKER + path));
    await rig.assertPrivate();
  }
});
