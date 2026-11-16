import test from 'node:test';
import { createHash } from 'node:crypto';
import { chunkText } from '../worker/src/lib/store.js';
import assert from 'node:assert/strict';
import { fixture } from './helpers/gmail-batch-fixture.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('held restore audit leaves new Gmail windows flowing without claiming coverage', async () => fixture(async f => {
  f.ids = ['accepted-prefix'];
  assert.equal((await f.once()).state.history_id, 'next');
  let clock = 0;
  f.options = { ingestNowMs: () => clock, ingestDeadlineAt: 60000 };
  // An unavailable proof is a durable coverage hold, not permission to remove
  // the old message or prevent unrelated new mail from reaching D1.
  f.partProof = (_url, options) => {
    const { source, source_ids } = JSON.parse(options.body);
    if (source_ids.includes("accepted-prefix")) clock = 60000;
    return Response.json({ source,
      database: { instance: "1".repeat(32), nonce: "2".repeat(32), generation: f.remoteParts.size },
      geometry: { size: 1500, overlap: 300 }, parts: source_ids.map(source_id => {
        const doc = f.remoteParts.get(source_id);
        return { source_id, content_hash: createHash("sha256").update(`chunk-v1:1500:300\0${doc.content}`).digest("hex"), chunk_count: chunkText(doc.content).length };
      }) });
  };
  for (const marker of ['later', 'latest']) {
    clock = 0;
    f.ids = [`new-${marker}`]; f.marker = marker;
    const result = await f.once({}, { flags: { only: 'gmail' }, allowPartialRefresh: true,
      deferGmailRemovals: true, ingestDeadlineAt: 60000 });
    assert.equal(result.error, null, result.output);
    assert.ok(f.stored.has(`gmail:new-${marker}`), 'new mail accepted before held audit');
    assert.equal(result.state.history_id, marker, 'settled window advances independently');
    assert.equal(result.receipt.status, 'error', 'held audit never certifies full coverage');
    assert.equal(result.receipt.complete_sweep, false);
    assert.ok(result.state.gmail_accepted_parts['gmail:accepted-prefix']);
    assert.equal(f.forgotten, 0);
  }
}));

for (const restored of [true, false]) test(`historical audit after new mail: ${restored ? 'missing part' : 'intact control'}`, async () => fixture(async f => {
  f.ids = ['old-entry'];
  assert.equal((await f.once()).receipt.status, 'ready');
  if (restored) f.remoteParts.delete('old-entry');
  f.ids = ['fresh-entry']; f.marker = 'later';
  const next = await f.once();
  assert.equal(next.error, null);
  assert.ok(f.stored.has('gmail:fresh-entry'));
  assert.equal(next.state.history_id, 'later');
  if (restored) {
    assert.equal(next.state.gmail_retry['gmail:old-entry'], true);
    assert.equal(next.state.done['gmail:old-entry'], undefined);
    assert.equal(next.receipt.status, 'error');
  } else assert.equal(next.receipt.status, 'ready');
  const before = f.calls.length;
  f.ids = []; f.marker = 'latest';
  const repaired = await f.once();
  assert.equal(repaired.error, null);
  assert.equal(repaired.receipt.status, 'ready');
  assert.equal(repaired.state.gmail_retry, undefined);
  assert.deepEqual(f.calls.slice(before).flat(), restored ? ['old-entry'] : []);
  assert.equal(f.forgotten, 0);
}));

test('historical audit cannot invalidate a freshly accepted replacement revision', async () => fixture(async f => {
  f.ids = ['updated-entry'];
  assert.equal((await f.once()).receipt.status, 'ready');
  f.marker = 'later';
  f.customEnvelope = id => ({ version: 'replacement-revision', envelope: {
    source_type: 'gmail', source_id: id, title: 'Synthetic correspondence',
    content: 'The owner approved this revised synthetic record for the next scheduled review.',
  } });
  const next = await f.once();
  assert.equal(next.error, null);
  assert.equal(next.state.done['gmail:updated-entry'], 'replacement-revision');
  assert.equal(next.state.gmail_retry, undefined);
  assert.equal(next.receipt.status, 'ready');
  assert.equal(f.calls.flat().length, 2);
  assert.equal(f.forgotten, 0);
}));

test('liveness mutations preserve both flow and honest coverage', () => {
  const environment = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'HOME', 'TMPDIR', 'TMP', 'TEMP']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  for (const name of ['window_hold', 'false_ready', 'audit_first']) {
    const result = spawnSync(process.execPath, ['--import', new URL('./fixtures/gmail-liveness-mutant.mjs', import.meta.url).href,
      '--test', '--test-name-pattern=^held restore', fileURLToPath(import.meta.url)], {
      env: { ...environment, BRAIN_GMAIL_LIVENESS_MUTANT: name }, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, `survived: ${name}`);
    assert.match(result.stdout + result.stderr, new RegExp(`MUTATION_APPLIED ${name}`));
    assert.match(result.stdout + result.stderr, /AssertionError/);
  }
});
