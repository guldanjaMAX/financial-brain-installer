import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { runQuerySpansProbe, parseQuerySpansArgs, QUERY_SPAN_CASES } from '../scripts/query-spans-probe.mjs';
import { createQueryTiming } from '../worker/src/lib/query-timing.js';

test('read-only probe makes six serial fixed queries and emits only projected aggregates', async () => {
  let reads = 0, calls = 0, active = 0, ms = 0;
  const key = randomUUID();
  const result = await runQuerySpansProbe({ url: 'https://brain.example.invalid', adminKeyFile: 'fixture-key-file' }, {
    now: () => ms,
    readKeyFile: async path => { reads++; assert.equal(path, 'fixture-key-file'); return key; },
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(++active, 1);
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['X-Admin-Key'] === key, true);
      assert.equal(new URL(url).search, '');
      const entry = QUERY_SPAN_CASES[Math.floor((calls - 1) / 2)];
      assert.deepEqual(JSON.parse(options.body), { q: entry.q });
      const route = url.endsWith('/think') ? 'think' : 'unified';
      const timing = createQueryTiming({ route, now: () => ms });
      const end = timing.start('keyword');
      ms += 100; end(); active--;
      return Response.json({ answer: 'private-marker', query: 'private-marker', timing: { ...timing.finish(), arbitrary: 'private-marker' } });
    },
  });
  assert.equal(reads, 1);
  assert.equal(calls, 6);
  assert.equal(result.ok, true);
  assert.equal(result.samples.length, 6);
  assert.ok(result.samples.every(sample => sample.client_ms === 100 && sample.timing.stages.keyword.calls === 1));
  assert.equal(JSON.stringify(result).includes('private-marker'), false);
  assert.equal(JSON.stringify(result).includes(key), false);
});

test('request error stops the probe at the reached endpoint and never prints the raw error', async () => {
  let calls = 0;
  const result = await runQuerySpansProbe({ url: 'https://brain.example.invalid', adminKeyFile: 'fixture' }, {
    readKeyFile: async () => randomUUID(), now: () => 0,
    fetchImpl: async () => { calls++; throw new Error('private-error-marker'); },
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.samples[0].error, 'request_or_response_failed');
  assert.equal(JSON.stringify(result).includes('private-error-marker'), false);
});

test('missing, oversized and malformed timing are findings after a real response read', async () => {
  for (const payload of [{}, { timing: { request_id: 'private-marker' } }, { answer: 'x'.repeat(1_048_577) }]) {
    let calls = 0;
    const result = await runQuerySpansProbe({ url: 'https://brain.example.invalid', adminKeyFile: 'fixture' }, {
      readKeyFile: async () => randomUUID(), now: () => 0,
      fetchImpl: async () => { calls++; return Response.json(payload); },
    });
    assert.equal(calls, 1);
    assert.equal(result.ok, false);
    assert.equal(result.samples.length, 1);
    assert.ok(result.samples[0].error);
    assert.equal(JSON.stringify(result).includes('private-marker'), false);
  }
});

test('target and key-locator validation run before credential or request work', async () => {
  for (const url of ['http://brain.example.invalid', 'https://user:pass@brain.example.invalid', 'https://brain.example.invalid/?q=private', 'https://brain.example.invalid/mcp']) {
    let calls = 0, reads = 0;
    const result = await runQuerySpansProbe({ url, adminKeyFile: 'fixture' }, {
      readKeyFile: async () => { reads++; return randomUUID(); },
      fetchImpl: async () => { calls++; return Response.json({}); },
    });
    assert.equal(result.error, 'invalid_target');
    assert.equal(reads, 0); assert.equal(calls, 0);
  }
  assert.deepEqual(parseQuerySpansArgs(['--url', 'https://brain.example.invalid', '--admin-key-file', 'fixture']), {
    url: 'https://brain.example.invalid', adminKeyFile: 'fixture',
  });
  assert.throws(() => parseQuerySpansArgs(['--key', 'never-a-credential-argument']));
});
