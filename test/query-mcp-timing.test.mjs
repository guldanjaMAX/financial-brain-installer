import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpQueryTiming } from '../components/brain-mcp-timing.mjs';
import { createQueryTiming } from '../worker/src/lib/query-timing.js';

test('local envelope separates backend attempts, retry wait and wrapping across clocks', async () => {
  let ms = 0;
  const trace = createMcpQueryTiming({ route: 'mcp.brain_search', now: () => ms });
  const receipts = [];
  for (let i = 0; i < 2; i++) {
    const remote = createQueryTiming({ route: 'unified', now: () => 0 }).finish();
    receipts.push(remote);
    await trace.backend(async () => { ms += 100; return { timing: { ...remote, query: 'private-marker' } }; });
    if (i === 0) await trace.wait(async () => { ms += 2000; });
  }
  ms += 20;
  const timing = trace.finish();
  assert.equal(timing.total_ms, 2220);
  assert.equal(timing.stages.mcp_backend.ms, 200);
  assert.equal(timing.stages.mcp_backend.calls, 2);
  assert.equal(timing.stages.mcp_retry_wait.ms, 2000);
  assert.equal(timing.stages.mcp_wrapping.ms, 20);
  assert.deepEqual(timing.backend.map(item => item.request_id), receipts.map(item => item.request_id));
  assert.equal(JSON.stringify(timing).includes('private-marker'), false);
  assert.equal(timing.overlap_ms, 0);
});

test('failed local backend attempts retain their decision and duration', async () => {
  let ms = 0, calls = 0;
  const trace = createMcpQueryTiming({ route: 'mcp.brain_think', now: () => ms });
  await assert.rejects(trace.backend(async () => { calls++; ms += 100; throw new Error('synthetic failure'); }));
  assert.equal(calls, 1);
  const timing = trace.finish('error');
  assert.equal(timing.outcome, 'error');
  assert.equal(timing.stages.mcp_backend.errors, 1);
  assert.equal(timing.total_ms, 100);
  const control = createMcpQueryTiming({ route: 'mcp.brain_think', now: () => 0 });
  assert.equal((await control.backend(async () => ({ answer: 'synthetic' }))).answer, 'synthetic');
  assert.equal(control.finish().stages.mcp_backend.errors, 0);
});

// Exercise the real stdio entry point with an injected fetch, private fixture
// HOME, file-backed synthetic admin credential and inert scheduler executable.
// No socket, external endpoint or machine credential helper is available.
test('real local MCP carries bounded timing in metadata for authorized diagnostics only', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const parent = join(root, 'home-query-spans');
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(join(parent, 'mcp-'));
  try {
  const home = join(scratch, 'home');
  await mkdir(home);
  const manifest = join(scratch, 'brain.manifest.json');
  await writeFile(manifest, JSON.stringify({ operations: { admin_key_secret: null } }));
  await writeFile(join(scratch, '.brain-admin-key'), randomUUID(), { mode: 0o600 });
  const launchctl = join(scratch, 'launchctl-fixture');
  await writeFile(launchctl, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const remote = createQueryTiming({ route: 'think', now: () => 0 }).finish();
  const preload = join(scratch, 'preload.mjs');
  await writeFile(preload, `
    let ms = 0;
    Object.defineProperty(globalThis, 'performance', { value: { now: () => ms } });
    globalThis.fetch = async (url, options) => {
      if (url !== 'https://fixture.invalid/api/rag/think' || options.method !== 'POST') throw new Error('unexpected request');
      ms += 100;
      return Response.json({ mode: 'think', answer: 'Seven units. [1]', citations: [{ n: 1 }], results: [],
        evidence_gate: { supported: true }, timing: ${JSON.stringify(remote)} });
    };
  `);
  for (const profile of ['owner-assistant', 'librarian']) {
    const child = spawn(process.execPath, ['--import', preload, join(root, 'components/brain-mcp.mjs')], {
      cwd: root, env: {
        PATH: process.env.PATH, HOME: home, TMPDIR: scratch, TZ: 'UTC',
        BRAIN_NO_WRANGLER_LOGIN: '1', BRAIN_TEST_LAUNCHCTL: launchctl,
        BRAIN_URL: 'https://fixture.invalid', BRAIN_MANIFEST: manifest, BRAIN_AGENT_PROFILE: profile,
      }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'brain_think', arguments: { q: 'What threshold was recorded?' } } }) + '\n');
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(code, 0);
    assert.equal(errors, '');
    const reply = JSON.parse(output.trim());
    assert.notEqual(reply.result.isError, true);
    const body = JSON.parse(reply.result.content[0].text);
    assert.equal(body.answer, 'Seven units. [1]');
    assert.equal(body.timing, undefined);
    if (profile === 'owner-assistant') {
      const timing = reply.result._meta.timing;
      assert.equal(timing.total_ms, 100);
      assert.equal(timing.stages.mcp_backend.calls, 1);
      assert.equal(timing.stages.mcp_backend.ms, 100);
      assert.equal(timing.stages.mcp_wrapping.ms, 0);
      assert.equal(timing.backend[0].request_id, remote.request_id);
    } else assert.equal(reply.result._meta, undefined);
  }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
