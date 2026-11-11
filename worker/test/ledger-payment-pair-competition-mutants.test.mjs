import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
test('one-sided payment pairing is killed after all three real-reader controls pass', () => {
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'payment-pair-mutant-')));
  try {
    for (const path of ['worker/src', 'migrations/d1', 'package.json', 'worker/test/ledger-review-fixture.mjs',
      'worker/test/fixtures/owner-route-book.mjs', 'worker/test/ledger-payment-pair-competition.test.mjs']) {
      mkdirSync(dirname(join(folder, path)), { recursive: true }); cpSync(join(root, path), join(folder, path), { recursive: true });
    }
    const env = Object.fromEntries(['PATH', 'TMPDIR', 'NODE_COMPILE_CACHE', 'HOME', 'BRAIN_NO_WRANGLER_LOGIN'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    const run = () => spawnSync(process.execPath, ['--test', 'worker/test/ledger-payment-pair-competition.test.mjs'],
      { cwd: folder, env, encoding: 'utf8', timeout: 240000 });
    const green = run(); assert.equal(green.status, 0, green.stdout + green.stderr); assert.match(green.stdout, /pass 3\b/);
    const path = join(folder, 'worker/src/lib/ledger-answer.js'), source = readFileSync(path, 'utf8');
    const hash = value => createHash('sha256').update(value).digest('hex');
    const start = source.indexOf('  const paymentById = new Map(paymentPostings.map(');
    const end = source.indexOf('  const pairingUncertain = ', start);
    assert.ok(start > 0 && end > start, 'exact pairing decision reached');
    const oneSided = `  const usedOutgoing = new Set();
  for (const incoming of paymentPostings.filter(item => item.row.direction === 'inflow')) {
    const candidates = paymentPostings.filter(outgoing => outgoing.row.direction === 'outflow' &&
      !usedOutgoing.has(outgoing.row.id) && outgoing.liabilityKind === incoming.liabilityKind &&
      Math.abs(Date.parse(outgoing.row.posted_on) - Date.parse(incoming.row.posted_on)) <= 86400000 &&
      isDirectedOwnedTransfer({ out: outgoing.row, in: incoming.row }, bySlug) &&
      !/^payment thank you$/i.test(incoming.row.description || ''));
    if (candidates.length === 1) { pairedIncoming.add(incoming.row.id); usedOutgoing.add(candidates[0].row.id); }
  }
`;
    try {
      writeFileSync(path, source.slice(0, start) + oneSided + source.slice(end));
      const red = run(); assert.equal(red.error, undefined); assert.equal(red.signal, null);
      assert.equal(red.status, 1, red.stdout + red.stderr); assert.match(red.stdout, /AssertionError/);
      assert.match(red.stdout, /no unique economic pair authorizes removing an incoming posting/);
      assert.match(red.stdout, /pass 2\b/); assert.match(red.stdout, /fail 1\b/);
    } finally { writeFileSync(path, source); }
    assert.equal(hash(readFileSync(path)), hash(source), 'exact source restored');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
