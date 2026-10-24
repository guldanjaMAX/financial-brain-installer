import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { assertSchema } from '../../../broker/quickbooks/src/validation.mjs';
import { createProbeAdapter } from '../implementation-adapter.mjs';
import { BROKER, START, createRig, queryFree, REFRESH, REVOKE, rejected, refusedUnchanged, rewriteJson } from '../probes/harness.mjs';

// Echo into a reviewed public header so detection proves source registration.
// An unknown header would register its own value under the private default.

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

test('START_REQUEST_PRIVATE_ECHO mutant is killed inside a granted response field', async t => {
  for (const entry of ['broker', 'owner']) for (const form of ['exact', 'embedded']) {
    await t.test(`${entry} ${form} request key`, async () => {
      const rig = await createRig(createProbeAdapter);
      await rig.enroll();
      const original = rig.adapter.broker.fetch;
      let mutate = false;
      let wrapperCalls = 0;
      let handlerSuccesses = 0;
      let mutatedResponses = 0;
      rig.adapter.broker.fetch = async request => {
        const input = await request.clone().json();
        wrapperCalls++;
        const response = await original(request);
        assert.ok(response.status === 201, 'wrapper must reach the real successful start handler');
        handlerSuccesses++;
        const body = await response.clone().json();
        assertSchema('launchResponse', body);
        if (!mutate) return response;
        // The key is also a valid capability. Embedding it in a distinct
        // capability proves another value's field grant cannot hide this key.
        body.launch_capability = input.body.delivery_auth_key + (form === 'embedded' ? 'A' : '');
        assertSchema('launchResponse', body);
        mutatedResponses++;
        return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
      };
      await startThrough(rig, entry);
      await rig.assertPrivate();
      assert.ok(wrapperCalls === 1 && handlerSuccesses === 1 && mutatedResponses === 0,
        'each mutant must first pass an unmodified real start through its wrapper');

      mutate = true;
      let result;
      let failure;
      try {
        result = entry === 'owner' ? await rig.owner('/api/quickbooks/connect/start', { body: {} })
          : await rig.broker(await rig.signed(START));
      } catch (error) { failure = error; }
      assert.ok(wrapperCalls === 2 && handlerSuccesses === 2 && mutatedResponses === 1,
        'mutant must change exactly one schema-valid response after the real handler ran');
      if (form === 'embedded') {
        assert.ok(!failure && result?.ok, 'embedded key must reach the valid response field grant');
      } else if (entry === 'owner') {
        assert.ok(!failure && result?.status === 400, 'owner must catch the refused request-value grant');
      } else {
        assert.ok(failure?.code === 'ERR_ASSERTION' && /only one exact response field exception/.test(failure.message),
          'request private value must not receive a response field grant');
      }
      await assert.rejects(() => rig.assertPrivate(), {
        code: 'ERR_ASSERTION', message: /outside their exact allowed field/,
      });
    });
  }
  for (const surface of ['body', 'header']) await t.test(`malformed request ${surface} echo`, async () => {
    const rig = await createRig(createProbeAdapter);
    await rig.enroll();
    const original = rig.adapter.broker.fetch;
    let mutate = false;
    let wrapperCalls = 0;
    let handlerSuccesses = 0;
    let handlerRefusals = 0;
    rig.adapter.broker.fetch = async request => {
      const input = await request.clone().json();
      wrapperCalls++;
      const response = await original(request);
      if (!mutate) {
        assert.ok(response.status === 201, 'malformed-request mutant needs a real successful start control');
        handlerSuccesses++;
        return response;
      }
      assert.ok(response.status === 400, 'malformed request must reach the real broker refusal');
      handlerRefusals++;
      if (surface === 'header') {
        response.headers.set('content-security-policy', input.body.delivery_auth_key);
        return response;
      }
      const body = await response.json();
      body.echo = input.body.delivery_auth_key;
      return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
    };
    await startThrough(rig, 'broker');
    await rig.assertPrivate();
    assert.ok(wrapperCalls === 1 && handlerSuccesses === 1 && handlerRefusals === 0,
      'malformed-request control must pass through the same real handler wrapper');
    mutate = true;
    const request = await rewriteJson(await rig.signed(START), body => { body.unrecognized = true; });
    assert.ok((await rig.broker(request, { expectInvalidRequest: true })).status === 400);
    assert.ok(wrapperCalls === 2 && handlerSuccesses === 1 && handlerRefusals === 1,
      'malformed-request echo must follow one actual broker refusal');
    await assert.rejects(() => rig.assertPrivate(), {
      code: 'ERR_ASSERTION', message: /outside their exact allowed field/,
    });
  });
});

test('ENROLLMENT_REQUEST_PRIVATE_ECHO mutant is killed after the real handler', async () => {
  const rig = await createRig(createProbeAdapter);
  assert.ok((await rig.enroll()).status === 202, 'unmodified enrollment control must succeed');
  await rig.assertPrivate();
  const original = rig.adapter.broker.fetch;
  let wrapperCalls = 0;
  let handlerSuccesses = 0;
  rig.adapter.broker.fetch = async request => {
    const input = await request.clone().json();
    assertSchema('enrollmentIssue', input);
    wrapperCalls++;
    const response = await original(request);
    assert.ok(response.status === 202, 'wrapper must reach the real successful enrollment handler');
    handlerSuccesses++;
    response.headers.set('content-security-policy', input.challenge);
    return response;
  };
  assert.ok((await rig.enroll()).status === 202, 'enrollment echo must retain the successful status');
  assert.ok(wrapperCalls === 1 && handlerSuccesses === 1,
    'enrollment fixture must traverse the observed broker request boundary and real handler');
  await assert.rejects(() => rig.assertPrivate(), {
    code: 'ERR_ASSERTION', message: /outside their exact allowed field/,
  });
});

test('HEADER_COOKIE_ECHO mutant is killed for authentication headers and transaction cookies', async t => {
  for (const name of ['authorization', 'x-access-capability', 'set-cookie']) {
    await t.test(`callback receipt response-only ${name}`, async () => {
      let rig = await createRig(createProbeAdapter);
      const secret = randomBytes(48).toString('base64url');
      const credential = name === 'authorization' ? `Bearer ${secret}`
        : name === 'set-cookie' ? `probe_cookie=${secret}; Path=/; HttpOnly; Secure; SameSite=Lax` : secret;
      let mutate = false;
      let wrapperCalls = 0;
      let handlerSuccesses = 0;
      let mutatedResponses = 0;
      const wrap = current => {
        const original = current.adapter.owners[0].fetch;
        current.adapter.owners[0].fetch = async request => {
          const response = await original(request);
          if (new URL(request.url).pathname === '/api/quickbooks/connect/callback') {
            wrapperCalls++;
            assert.ok(response.ok, 'callback receipt mutant must follow the real successful owner handler');
            handlerSuccesses++;
            if (mutate) {
              response.headers.set(name, credential);
              mutatedResponses++;
            }
          }
          return response;
        };
      };
      wrap(rig);
      await rig.connect();
      await rig.assertPrivate();
      assert.ok(wrapperCalls === 1 && handlerSuccesses === 1 && mutatedResponses === 0,
        'callback receipt mutant requires an unchanged complete connection control');
      mutate = true;
      rig = await createRig(createProbeAdapter);
      wrap(rig);
      await rig.connect();
      assert.ok(wrapperCalls === 2 && handlerSuccesses === 2 && mutatedResponses === 1,
        'callback receipt mutant adds one header only after the real owner handler succeeds');
      await assert.rejects(() => rig.assertPrivate(), {
        code: 'ERR_ASSERTION', message: /outside their exact allowed field/,
      });
    });
  }
  await t.test('direct broker request authorization', async () => {
    const rig = await createRig(createProbeAdapter);
    assert.ok((await rig.enroll()).status === 202);
    const credential = `Bearer ${randomBytes(48).toString('base64url')}`;
    const original = rig.adapter.broker.fetch;
    let mutate = false;
    let wrapperCalls = 0;
    let handlerSuccesses = 0;
    let mutatedResponses = 0;
    rig.adapter.broker.fetch = async request => {
      wrapperCalls++;
      const response = await original(request);
      assert.ok(response.ok, 'direct broker probe must reach its actual successful health handler');
      handlerSuccesses++;
      if (mutate) {
        response.headers.set('content-security-policy', credential.slice(7));
        mutatedResponses++;
      }
      return response;
    };
    assert.ok((await rig.adapter.broker.fetch(new Request(BROKER + '/health', {
      headers: { authorization: credential },
    }))).ok, 'direct broker request must first pass an unchanged successful control');
    await rig.assertPrivate();
    assert.ok(wrapperCalls === 1 && handlerSuccesses === 1 && mutatedResponses === 0);
    mutate = true;
    assert.ok((await laterResponse(rig, 'health')).ok);
    assert.ok(wrapperCalls === 2 && handlerSuccesses === 2 && mutatedResponses === 1,
      'direct broker mutant echoes the earlier request only after the real later handler');
    await assert.rejects(() => rig.assertPrivate(), {
      code: 'ERR_ASSERTION', message: /outside their exact allowed field/,
    });
  });
  await t.test('private enrollment challenge response header', async () => {
    let mutate = false;
    let wrapperCalls = 0;
    let handlerSuccesses = 0;
    let mutatedResponses = 0;
    const rig = await createRig(async dependencies => {
      const adapter = await createProbeAdapter(dependencies);
      const original = adapter.owners[0].fetch;
      adapter.owners[0].fetch = async request => {
        const response = await original(request);
        if (new URL(request.url).pathname === '/api/quickbooks/connect/enrollment/challenge') {
          wrapperCalls++;
          assert.ok(response.ok, 'challenge header probe must reach the real successful private reply');
          handlerSuccesses++;
          if (mutate) {
            response.headers.set('content-security-policy', request.headers.get('authorization'));
            mutatedResponses++;
          }
        }
        return response;
      };
      return adapter;
    });
    assert.ok((await rig.enroll()).status === 202);
    await rig.assertPrivate();
    assert.ok(wrapperCalls === 1 && handlerSuccesses === 1 && mutatedResponses === 0);
    mutate = true;
    assert.ok((await rig.enroll()).status === 202);
    assert.ok(wrapperCalls === 2 && handlerSuccesses === 2 && mutatedResponses === 1,
      'challenge header mutant changes one private reply after real authentication');
    await assert.rejects(() => rig.assertPrivate(), {
      code: 'ERR_ASSERTION', message: /outside their exact allowed field/,
    });
  });
  for (const source of ['enrollment', 'owner']) for (const form of ['full', 'payload']) {
    await t.test(`${source} authorization ${form}`, async () => {
      const rig = await createRig(createProbeAdapter);
      if (source === 'owner') assert.ok((await rig.enroll()).status === 202);
      const target = source === 'enrollment' ? rig.adapter.broker : rig.adapter.owners[0];
      const original = target.fetch;
      let mutate = false;
      let wrapperCalls = 0;
      let handlerSuccesses = 0;
      let mutatedResponses = 0;
      target.fetch = async request => {
        const credential = request.headers.get('authorization');
        assert.ok(typeof credential === 'string' && credential.startsWith('Bearer '),
          'authentication echo must originate in the actual request header');
        wrapperCalls++;
        const response = await original(request);
        assert.ok(response.ok, 'authentication mutant must reach a real successful handler');
        handlerSuccesses++;
        if (mutate) {
          response.headers.set('content-security-policy', form === 'full' ? credential : credential.slice(7));
          mutatedResponses++;
        }
        return response;
      };
      const operation = () => source === 'enrollment' ? rig.enroll() : rig.owner('/api/quickbooks/status');
      assert.ok((await operation()).ok, 'authentication mutant requires an unchanged successful control');
      await rig.assertPrivate();
      assert.ok(wrapperCalls === 1 && handlerSuccesses === 1 && mutatedResponses === 0);
      mutate = true;
      assert.ok((await operation()).ok, 'authentication echo preserves the real successful response');
      assert.ok(wrapperCalls === 2 && handlerSuccesses === 2 && mutatedResponses === 1,
        'authentication mutant changes one response only after the real handler succeeds');
      await assert.rejects(() => rig.assertPrivate(), {
        code: 'ERR_ASSERTION', message: /outside their exact allowed field/,
      });
    });
  }
  for (const destination of ['health', 'status']) for (const form of ['set-cookie', 'cookie', 'value']) {
    await t.test(`transaction ${form} then ${destination}`, async () => {
      const rig = await createRig(createProbeAdapter);
      const originalBroker = rig.adapter.broker.fetch;
      let issuedCookie;
      let launches = 0;
      rig.adapter.broker.fetch = async request => {
        const response = await originalBroker(request);
        if (new URL(request.url).pathname === '/v1/quickbooks/launch') {
          assert.ok(response.status === 303, 'cookie control must reach the real launch handler');
          issuedCookie = response.headers.get('set-cookie');
          launches++;
        }
        return response;
      };
      await rig.pending();
      assert.ok(launches === 1 && typeof issuedCookie === 'string' && issuedCookie.includes('HttpOnly'),
        'cookie mutant must use the cookie issued by the actual launch handler');
      await rig.assertPrivate();
      const pair = issuedCookie.split(';')[0];
      const echo = form === 'set-cookie' ? issuedCookie : form === 'cookie' ? pair : pair.slice(pair.indexOf('=') + 1);
      const target = destination === 'health' ? rig.adapter.broker : rig.adapter.owners[0];
      const original = target.fetch;
      let mutate = false;
      let wrapperCalls = 0;
      let handlerSuccesses = 0;
      let mutatedResponses = 0;
      target.fetch = async request => {
        wrapperCalls++;
        const response = await original(request);
        assert.ok(response.ok, 'cookie echo must reach a real successful later handler');
        handlerSuccesses++;
        if (mutate) {
          response.headers.set('content-security-policy', echo);
          mutatedResponses++;
        }
        return response;
      };
      const operation = () => laterResponse(rig, destination);
      assert.ok((await operation()).ok, 'cookie mutant requires an unchanged later-response control');
      await rig.assertPrivate();
      assert.ok(wrapperCalls === 1 && handlerSuccesses === 1 && mutatedResponses === 0);
      mutate = true;
      assert.ok((await operation()).ok, 'cookie echo preserves the real successful response');
      assert.ok(wrapperCalls === 2 && handlerSuccesses === 2 && mutatedResponses === 1,
        'cookie mutant changes one later response only after the real handler succeeds');
      await assert.rejects(() => rig.assertPrivate(), {
        code: 'ERR_ASSERTION', message: /outside their exact allowed field/,
      });
    });
  }
  for (const name of ['cf-access-jwt-assertion', 'cf-access-client-secret', 'x-access-capability',
    'x-api-key', 'x-future-credential', 'cookie']) {
    await t.test(`request-only ${name}`, async () => {
      const rig = await createRig(createProbeAdapter);
      assert.ok((await rig.enroll()).status === 202);
      const secret = randomBytes(48).toString('base64url');
      const credential = name === 'cookie'
        ? `first=${randomBytes(48).toString('base64url')}; probe_cookie=${secret}; last=${randomBytes(48).toString('base64url')}` : secret;
      const request = () => new Request(BROKER + '/health', { headers: { [name]: credential } });
      const original = rig.adapter.broker.fetch;
      let mutate = false;
      let wrapperCalls = 0;
      let handlerSuccesses = 0;
      let mutatedResponses = 0;
      rig.adapter.broker.fetch = async input => {
        assert.ok(input.headers.get(name) === credential, 'channel probe must reach the unchanged request header');
        wrapperCalls++;
        const response = await original(input);
        assert.ok(response.ok, 'channel echo must follow the actual successful health handler');
        handlerSuccesses++;
        if (mutate) {
          response.headers.set('content-security-policy', secret);
          mutatedResponses++;
        }
        return response;
      };
      assert.ok((await rig.broker(request())).ok, 'request-only channel requires a successful unchanged control');
      await rig.assertPrivate();
      assert.ok(wrapperCalls === 1 && handlerSuccesses === 1 && mutatedResponses === 0);
      mutate = true;
      assert.ok((await rig.broker(request())).ok);
      assert.ok(wrapperCalls === 2 && handlerSuccesses === 2 && mutatedResponses === 1,
        'request-only channel mutant changes one response after its real handler');
      await assert.rejects(() => rig.assertPrivate(), {
        code: 'ERR_ASSERTION', message: /outside their exact allowed field/,
      });
    });
  }
  for (const destination of ['health', 'status']) for (const name of ['authorization', 'x-access-capability', 'set-cookie']) {
    await t.test(`${destination} response-only ${name}`, async () => {
      const rig = await createRig(createProbeAdapter);
      assert.ok((await rig.enroll()).status === 202);
      const secret = randomBytes(48).toString('base64url');
      const credential = name === 'authorization' ? `Bearer ${secret}`
        : name === 'set-cookie' ? `probe_cookie=${secret}; Path=/; HttpOnly; Secure; SameSite=Lax` : secret;
      const target = destination === 'health' ? rig.adapter.broker : rig.adapter.owners[0];
      const original = target.fetch;
      let mutate = false;
      let wrapperCalls = 0;
      let handlerSuccesses = 0;
      let mutatedResponses = 0;
      target.fetch = async request => {
        wrapperCalls++;
        const response = await original(request);
        assert.ok(response.ok, 'new response credential follows the real successful handler');
        handlerSuccesses++;
        if (mutate) {
          response.headers.set(name, credential);
          mutatedResponses++;
        }
        return response;
      };
      const operation = () => laterResponse(rig, destination);
      assert.ok((await operation()).ok);
      await rig.assertPrivate();
      assert.ok(wrapperCalls === 1 && handlerSuccesses === 1 && mutatedResponses === 0);
      mutate = true;
      assert.ok((await operation()).ok);
      assert.ok(wrapperCalls === 2 && handlerSuccesses === 2 && mutatedResponses === 1,
        'response-only mutant introduces one credential after a real successful handler');
      await assert.rejects(() => rig.assertPrivate(), {
        code: 'ERR_ASSERTION', message: /outside their exact allowed field/,
      });
    });
  }
});

async function successfulRefresh(rig, entry) {
  rig.advance(3_000_000);
  let ciphertext;
  const original = rig.adapter.broker.fetch;
  rig.adapter.broker.fetch = async request => {
    const response = await original(request);
    if (new URL(request.url).pathname === REFRESH && response.ok) {
      ciphertext = (await response.clone().json()).ciphertext;
    }
    return response;
  };
  const generation = rig.state().tokenGeneration;
  const response = entry === 'owner'
    ? await rig.owner('/api/quickbooks/refresh', { body: {} })
    : await rig.broker(await rig.signed(REFRESH));
  rig.adapter.broker.fetch = original;
  assert.ok(response.ok && typeof ciphertext === 'string' && ciphertext.length > 22,
    'refresh control must return a real encrypted replacement from the fake provider');
  assert.ok(rig.provider.snapshot().mutated.refresh === 1, 'refresh control must rotate exactly once');
  if (entry === 'owner') assert.ok(rig.state().tokenGeneration === generation + 1 && !rig.state().outcomeUnknown,
    'owner refresh control must commit and read back the replacement');
  await rig.assertPrivate();
  return ciphertext;
}

function laterResponse(rig, destination) {
  if (destination === 'status') return rig.owner('/api/quickbooks/status');
  return rig.broker(new Request(BROKER + (destination === 'health' ? '/health' : '/unrecognized')));
}

async function recordEcho(operation, schemaMayRefuse = false) {
  try { return await operation(); }
  catch (error) {
    // Schema validation can reject an added health field before the scan.
    // Every caller still requires the scan to catch the recorded private value.
    assert.ok(schemaMayRefuse && error?.code === 'ERR_ASSERTION' &&
      error.message === 'successful broker response must match its exact wire schema',
    'only the exact successful-response schema refusal may precede the privacy assertion');
  }
}

test('successful refresh keeps its ciphertext private through owner and raw broker entry points', async () => {
  for (const entry of ['owner', 'broker']) {
    const rig = await createRig(createProbeAdapter);
    await rig.connect();
    await successfulRefresh(rig, entry);
    for (const destination of ['health', 'status', 'refusal']) {
      const response = await laterResponse(rig, destination);
      assert.ok(destination === 'refusal' ? response.status === 404 : response.ok,
        'clean later response must reach its expected result');
    }
    await rig.assertPrivate();
  }
});

for (const surface of ['body', 'header']) {
  test(`REFRESH_CIPHERTEXT_${surface.toUpperCase()}_ECHO mutant is killed`, async t => {
    for (const entry of ['owner', 'broker']) for (const destination of ['health', 'status', 'refusal']) {
      await t.test(`${entry} refresh then ${destination}`, async () => {
        const rig = await createRig(createProbeAdapter);
        await rig.connect();
        const ciphertext = await successfulRefresh(rig, entry);
        const clean = await laterResponse(rig, destination);
        assert.ok(destination === 'refusal' ? clean.status === 404 : clean.ok,
          'each echo mutant requires a passing later-response control');
        await rig.assertPrivate();
        const target = destination === 'status' ? rig.adapter.owners[0] : rig.adapter.broker;
        const original = target.fetch;
        let echoed = false;
        target.fetch = async request => {
          const response = await original(request);
          echoed = true;
          if (surface === 'header') {
            response.headers.set('content-security-policy', ciphertext);
            return response;
          }
          const body = await response.json();
          body.echo = ciphertext;
          return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
        };
        await recordEcho(() => laterResponse(rig, destination), surface === 'body' && destination === 'health');
        assert.ok(echoed, 'echo mutant must reach the actual later response');
        await assert.rejects(() => rig.assertPrivate(), {
          code: 'ERR_ASSERTION', message: /outside their exact allowed field/,
        });
      });
    }
    await t.test(surface === 'body' ? 'second refresh cannot reuse a ciphertext grant' : 'same refresh header cannot reuse its body grant', async () => {
      const rig = await createRig(createProbeAdapter);
      await rig.connect();
      const ciphertext = await successfulRefresh(rig, 'owner');
      rig.advance(3_000_000);
      const original = rig.adapter.broker.fetch;
      rig.adapter.broker.fetch = async request => {
        const response = await original(request);
        const body = await response.clone().json();
        if (surface === 'header') {
          response.headers.set('content-security-policy', body.ciphertext);
          return response;
        }
        body.ciphertext = ciphertext;
        return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
      };
      const refresh = await rig.signed(REFRESH);
      if (surface === 'body') await assert.rejects(() => rig.broker(refresh), {
        code: 'ERR_ASSERTION', message: /only one exact response field exception/,
      });
      else assert.ok((await rig.broker(refresh)).ok, 'same-response header mutant must return successful refresh');
      await assert.rejects(() => rig.assertPrivate(), {
        code: 'ERR_ASSERTION', message: /outside their exact allowed field/,
      });
    });
  });
}

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
            response.headers.set('content-security-policy', typeof start[field] === 'string' ? start[field] : JSON.stringify(start[field]));
            return response;
          }
          const headers = new Headers(response.headers);
          const body = await response.json();
          body[field] = start[field];
          return new Response(JSON.stringify(body), { status: response.status, headers });
        };
        const later = await recordEcho(() => entry === 'owner' ? rig.owner('/api/quickbooks/status')
          : rig.broker(new Request(BROKER + '/health')), surface === 'body' && entry !== 'owner');
        assert.ok(later === undefined || later.ok, 'later response must reach the mutated successful response');
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
          response.headers.set('content-security-policy', typeof body[field] === 'string' ? body[field] : JSON.stringify(body[field]));
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
        await recordEcho(() => rig.broker(new Request(BROKER + '/health')), true);
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
