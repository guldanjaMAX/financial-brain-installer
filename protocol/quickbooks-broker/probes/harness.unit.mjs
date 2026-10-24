import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as helpers from './harness.mjs';
import { fixture } from '../testing/schema-test-helper.mjs';
import { createRig, jsonRequest, rewriteJson, queryFree } from './harness.mjs';
const schema = JSON.parse(readFileSync(new URL('../v1/schemas/protocol.schema.json', import.meta.url), 'utf8'));
const audit = () => fixture(schema, 'auditEvent', length => randomBytes(length).toString('base64url').slice(0, length));

function transportSpy() {
  let dependencies;
  const rows = [];
  return {
    rows,
    get dependencies() { return dependencies; },
    async factory(injected) {
      dependencies = injected;
      return {
        broker: { fetch: async () => { throw new Error('spy_has_no_broker'); } },
        owners: [0, 1].map(() => ({ fetch: async () => new Response(null, { status: 204 }), authHeaders: {} })),
        inspect: () => ({ brokerRows: rows, brokerLogs: [], owners: [] }),
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
  rig.adapter.broker.fetch = async () => new Response(null, { status: 204 });
  assert.ok((await spy.dependencies.ownerFetch('https://broker.invalid/health')).status === 204);
  await assert.rejects(() => spy.dependencies.brokerFetch('https://broker.invalid/health'), { code: 'ERR_ASSERTION' });
});

test('probe privacy scan rejects generated canaries and forbidden retained field names', async () => {
  const spy = transportSpy();
  const rig = await createRig(spy.factory);
  spy.rows.push({ ...audit(), route: '/v1/quickbooks/oauth/callback' });
  await rig.assertPrivate();
  spy.rows.push({ metadata: rig.provider.config.clientSecret });
  await assert.rejects(() => rig.assertPrivate(), { code: 'ERR_ASSERTION' });
  spy.rows.length = 0;
  await rig.assertPrivate();
  spy.rows.push({ callback: 'https://owner-a.invalid/api/quickbooks/connect/callback' });
  await assert.rejects(() => rig.assertPrivate(), { code: 'ERR_ASSERTION' });
});

test('probe privacy scan rejects fields outside the exact durable schema', async () => {
  const spy = transportSpy();
  const rig = await createRig(spy.factory);
  spy.rows.push(audit());
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
  await rig.assertPrivate();
  rig.adapter.broker.fetch = async () => new Response(rig.provider.config.clientSecret);
  await rig.broker(new Request('https://broker.invalid/health'));
  await assert.rejects(() => rig.assertPrivate(), { code: 'ERR_ASSERTION' });
});
