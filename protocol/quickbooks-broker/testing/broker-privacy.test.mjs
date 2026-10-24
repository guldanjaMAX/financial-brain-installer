import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createProbeAdapter } from '../implementation-adapter.mjs';
import { BROKER, START, createRig, queryFree, REVOKE, rejected, refusedUnchanged } from '../probes/harness.mjs';

async function startThrough(rig, entry) {
  if (entry === 'helper') return rig.start();
  const response = entry === 'owner' ? await rig.owner('/api/quickbooks/connect/start', { body: {} })
    : await rig.broker(await rig.signed(START));
  assert.ok(response.ok, 'raw start control must succeed');
  return response.json();
}

test('clean starts keep capability and capsule private before launch through every entry point', async () => {
  for (const entry of ['helper', 'owner', 'broker']) {
    const rig = await createRig(createProbeAdapter);
    await rig.enroll();
    const start = await startThrough(rig, entry);
    assert.ok(typeof start.launch_capability === 'string' && typeof start.transaction?.ciphertext === 'string');
    await startThrough(rig, entry);
    await rig.assertPrivate();
  }
});

for (const surface of ['body', 'header']) {
  test(`LATER_RESPONSE_${surface.toUpperCase()}_ECHO mutant is killed for capability and capsule`, async t => {
    for (const entry of ['helper', 'owner', 'broker']) for (const field of ['launch_capability', 'transaction']) {
      await t.test(`${entry} ${field}`, async () => {
        const rig = await createRig(createProbeAdapter);
        await rig.enroll();
        const start = await startThrough(rig, entry);
        await rig.assertPrivate();
        const target = entry === 'owner' ? rig.adapter.owners[0] : rig.adapter.broker;
        const original = target.fetch;
        target.fetch = async request => {
          const response = await original(request);
          if (surface === 'header') {
            // Owner fetch has already been observed by the harness. Mutating the
            // same Response must not hide a later header behind identity dedupe.
            response.headers.set('x-probe-echo', typeof start[field] === 'string' ? start[field] : JSON.stringify(start[field]));
            return response;
          }
          const headers = new Headers(response.headers);
          const body = await response.json();
          body[field] = start[field];
          return new Response(JSON.stringify(body), { status: response.status, headers });
        };
        const later = entry === 'owner' ? await rig.owner('/api/quickbooks/status')
          : await rig.broker(new Request(BROKER + '/health'));
        assert.ok(later.ok, 'later response must reach the mutated successful response');
        await assert.rejects(() => rig.assertPrivate(), {
          code: 'ERR_ASSERTION', message: /outside their exact allowed field/,
        });
      });
    }
    for (const field of ['launch_capability', 'transaction']) await t.test(`start field ${field}`, async () => {
      const rig = await createRig(createProbeAdapter);
      await rig.enroll();
      const start = await rig.start();
      await rig.assertPrivate();
      const target = surface === 'header' ? rig.adapter.owners[0] : rig.adapter.broker;
      const original = target.fetch;
      target.fetch = async request => {
        const response = await original(request);
        const body = await response.clone().json();
        if (surface === 'header') {
          response.headers.set('x-probe-echo', typeof body[field] === 'string' ? body[field] : JSON.stringify(body[field]));
          return response;
        }
        // A prior value cannot gain a second grant even in the same named field
        // of another otherwise valid successful start response.
        body[field] = start[field];
        return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
      };
      if (surface === 'header') await startThrough(rig, 'owner');
      else await assert.rejects(() => startThrough(rig, 'broker'), {
        code: 'ERR_ASSERTION', message: /only one exact response field exception/,
      });
      await assert.rejects(() => rig.assertPrivate(), {
        code: 'ERR_ASSERTION', message: /outside their exact allowed field/,
      });
    });
    if (surface === 'body') for (const field of ['launch_capability', 'transaction']) {
      await t.test(`escaped later ${field}`, async () => {
        const rig = await createRig(createProbeAdapter);
        await rig.enroll();
        const start = await rig.start();
        await rig.assertPrivate();
        const value = field === 'launch_capability' ? start[field] : start[field].ciphertext;
        const encoded = JSON.stringify(value).replace(value[0], `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}`);
        rig.adapter.broker.fetch = async () => new Response(`{"echo":${encoded}}`, {
          headers: { 'content-type': 'application/json' },
        });
        await rig.broker(new Request(BROKER + '/health'));
        await assert.rejects(() => rig.assertPrivate(), {
          code: 'ERR_ASSERTION', message: /outside their exact allowed field/,
        });
      });
    }
    if (surface === 'body') await t.test('duplicate start field with escaped value', async () => {
      const rig = await createRig(createProbeAdapter);
      await rig.enroll();
      await rig.start();
      await rig.assertPrivate();
      const original = rig.adapter.broker.fetch;
      rig.adapter.broker.fetch = async request => {
        const response = await original(request);
        const body = await response.json();
        const value = body.launch_capability;
        const encoded = JSON.stringify(value).replace(value[0], `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}`);
        const duplicate = JSON.stringify(body).slice(0, -1) + `,"launch_capability":${encoded}}`;
        return new Response(duplicate, { status: response.status, headers: response.headers });
      };
      await assert.rejects(() => startThrough(rig, 'broker'), {
        code: 'ERR_ASSERTION', message: /response JSON must be unambiguous/,
      });
    });
  });
}

test('REPLAY_FALSE_SUCCESS mutant is killed even when provider counters stay unchanged', async () => {
  for (const kind of ['refresh', 'revoke']) {
    const rig = await createRig(createProbeAdapter);
    await rig.connect();
    rig.advance(3_000_000);
    rig.provider.queueFault(kind, 'loss_after');
    const path = kind === 'refresh' ? '/api/quickbooks/refresh' : '/api/quickbooks/disconnect';
    await rig.owner(path, { body: {} });
    rejected(await refusedUnchanged(rig, () => rig.owner(path, { body: {} })));
    const original = rig.adapter.owners[0].fetch;
    rig.adapter.owners[0].fetch = async request => {
      await original(request);
      return new Response(null, { status: 204 });
    };
    await assert.rejects(() => refusedUnchanged(rig, () => rig.owner(path, { body: {} })), { code: 'ERR_ASSERTION' });
  }
});

test('launch state is private in retained audit evidence before provider consent', async () => {
  const rig = await createRig(createProbeAdapter);
  const launch = await rig.pending();
  await rig.assertPrivate();
  const inspect = rig.adapter.inspect;
  rig.adapter.inspect = () => {
    const snapshot = inspect();
    const leak = row => row.event_id_hash ? { ...row, state_hash: launch.url.searchParams.get('state') } : row;
    return { ...snapshot, brokerRows: snapshot.brokerRows.map(leak), brokerLogs: snapshot.brokerLogs.map(leak) };
  };
  await assert.rejects(() => rig.assertPrivate(), { code: 'ERR_ASSERTION' });
});

test('concurrent launch responses each keep only their own provider state exception', async () => {
  const rig = await createRig(createProbeAdapter);
  await Promise.all([0, 1].map(owner => rig.pending(owner)));
  await rig.assertPrivate();
});

test('malformed exchange with a usable access token performs one fenced in-memory cleanup', async () => {
  const control = await createRig(createProbeAdapter);
  await control.connect();
  assert.ok(control.provider.snapshot().attempted.exchange === 1 && control.provider.snapshot().attempted.revoke === 0);
  const rig = await createRig(createProbeAdapter);
  rig.provider.queueFault('exchange', 'missing_refresh');
  queryFree(await rig.broker(await rig.consent(await rig.pending())));
  assert.ok(rig.state().status !== 'connected', 'missing replacement fields cannot activate a connection');
  assert.ok(rig.provider.snapshot().attempted.revoke === 1, 'usable partial exchange credentials require one cleanup revoke');
  await rig.assertPrivate();
});

test('a fresh signed request ID cannot repeat the same attempted revoke operation', async () => {
  const rig = await createRig(createProbeAdapter);
  await rig.connect();
  const first = await rig.signed(REVOKE);
  const operation = (await first.clone().json()).body.intent;
  assert.ok((await rig.broker(first)).ok, 'first signed revoke is the successful control');
  assert.ok(rig.provider.snapshot().attempted.revoke === 1);
  const repeated = await rig.broker(await rig.signed(REVOKE, { bodyOverrides: { intent: operation } }));
  assert.ok(repeated.status >= 400, 'attempted operation cannot obtain another fence under a new request ID');
  assert.ok(rig.provider.snapshot().attempted.revoke === 1, 'operation replay must refuse before another provider send');
});

test('runtime credential canaries are absent from complete SQLite images, logs, exceptions and responses', async () => {
  for (const loss of [false, true]) {
    const canary = randomBytes(48).toString('base64url');
    const protectedValues = new Set([canary]);
    const returned = [];
    const escaped = [];
    const rig = await createRig(async dependencies => {
      protectedValues.add(dependencies.brokerConfig.clientSecret);
      const original = dependencies.brokerFetch;
      return createProbeAdapter({ ...dependencies, brokerFetch: async request => {
        const result = await original(request);
        if (request.url === dependencies.brokerConfig.tokenUrl && result.ok) {
          const value = await result.clone().json();
          for (const field of ['access_token', 'refresh_token', 'realmId'])
            if (typeof value[field] === 'string') protectedValues.add(value[field]);
          if (loss) throw new Error(canary);
        }
        return result;
      } });
    });
    try {
      const result = await rig.broker(await rig.consent(await rig.pending()));
      returned.push(await result.text(), JSON.stringify(Object.fromEntries(result.headers)));
      queryFree(result);
    } catch (error) { escaped.push(String(error?.message), String(error?.stack)); }
    assert.ok(escaped.length === 0, 'untrusted transport exceptions must remain inside the broker boundary');
    assert.ok(loss ? rig.state().status !== 'connected' : rig.state().status === 'connected');
    const image = await rig.adapter.inspectDatabase();
    const retained = JSON.stringify(rig.inspect());
    for (const value of protectedValues) {
      assert.ok(!image.includes(Buffer.from(value)), 'complete database image must contain no transient credential canary');
      assert.ok(!retained.includes(value), 'all retained rows and captured application logs must contain no credential canary');
      assert.ok(returned.every(text => !text.includes(value)) && escaped.every(text => !text.includes(value)),
        'responses and escaped errors must contain no credential canary');
    }
    await rig.assertPrivate();
  }
  // There is no analytics writer in this foundation. Introducing one needs a
  // reviewed allowlist and a real injected sink before this assertion can change.
  for (const file of ['broker.mjs', 'provider.mjs']) {
    const source = await readFile(new URL('../../../broker/quickbooks/src/' + file, import.meta.url), 'utf8');
    assert.ok(!/\b(?:console\s*\.|writeDataPoint\s*\(|analytics\s*\.)/.test(source), 'broker must have no unreviewed telemetry sink');
  }
});
