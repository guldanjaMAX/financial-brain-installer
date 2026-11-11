import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
const root = fileURLToPath(new URL('../../', import.meta.url));
const mutations = [
  ['recognizer drops channel prefixes', 'ledger-analysis.js', '(?:(?:automatic|internet|mobile|online) )?', '', 'channel ownership online card payment case=0 side=card'],
  ['unresolved guard drifts to plain card', 'ledger-answer.js', 'isOwnedMovementChannel(row.payee)', "/^(?:credit card|card) payment$/.test(normalizeLedgerText(row.payee))", 'channel ownership online card payment case=0 side=card'],
  ['bare guard drifts to plain card', 'ledger-answer.js', 'isOwnedMovementChannel(row.description, { liabilityOnly: true })', "/^(?:credit card|card|loan) payment$/.test(normalizeLedgerText(row.description))", 'bare channel online card payment case=0'],
  ['uncertain inventory ignored', 'ledger-answer.js', '? await readUncertainScopeAccounts(env) : [];', '? [] : [];', 'channel ownership online payment case=0 side=card'],
  ['uncertain endpoint precision lost', 'ledger-analysis.js', 'return resolvesExactAccount(endpoint.locator, candidate, new Map([[candidate.account_slug, candidate]]), true);', 'return true;', 'channel text alone cannot establish uncertain ownership: online payment'],
  ['recognizer admits sibling prefix', 'ledger-analysis.js', '(?:(?:automatic|internet|mobile|online) )?', '(?:[a-z]+ )?', 'channel grammar accepts exactly'],
];
test('payment channel guards kill six mutations and restore every source', () => {
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'payment-channel-mutants-'))), copied = [];
  const inventory = path => {
    const absolute = join(root, path);
    try { for (const name of readdirSync(absolute)) inventory(path + '/' + name); }
    catch (error) {
      if (error.code !== 'ENOTDIR') throw error;
      copied.push(createHash('sha256').update(readFileSync(absolute)).digest('hex') + '  ' + path);
    }
  };
  for (const path of ['worker/src', 'migrations/d1', 'package.json', 'worker/test/ledger-review-fixture.mjs',
    'worker/test/ledger-payment-channel-guards.test.mjs']) {
    inventory(path); mkdirSync(dirname(join(folder, path)), { recursive: true });
    cpSync(join(root, path), join(folder, path), { recursive: true });
  }
  writeFileSync(join(folder, 'copied-sources.sha256'), copied.join('\n') + '\n');
  const env = Object.fromEntries(['PATH', 'TMPDIR', 'NODE_COMPILE_CACHE', 'SystemRoot', 'WINDIR']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
  env.HOME = join(root, 'home-test'); env.BRAIN_NO_WRANGLER_LOGIN = '1';
  const run = pattern => {
    if (process.platform !== 'win32') {
      // This lane's runtime identity may move into a copy; the marker stays at
      // the workspace root's parent, rather than depending on the copy depth.
      const quietMarker = process.env.BRAIN_MAC_QUIET_FILE || resolve(root, '../../MAC-QUIET');
      if (quietMarker) {
        const wait = spawnSync('/bin/sh', ['-c', 'while [ -e "$1" ]; do sleep 60; done', 'quiet', quietMarker],
          { env, encoding: 'utf8', timeout: 60000 });
        assert.equal(wait.status, 0, 'quiet wait completed before child Node');
      }
    }
    return spawnSync(process.execPath, ['--test', '--test-name-pattern', pattern, 'worker/test/ledger-payment-channel-guards.test.mjs'],
      { cwd: folder, env, encoding: 'utf8', timeout: 120000 });
  };
  const control = run('online card payment case=0|channel grammar accepts exactly');
  writeFileSync(join(folder, 'green.log'), control.stdout + control.stderr);
  assert.equal(control.status, 0, control.stdout + control.stderr);
  assert.match(control.stdout, /pass 4\b/);
  let killed = 0;
  for (const [name, file, from, to, pattern] of mutations) {
    const path = join(folder, 'worker/src/lib', file), original = readFileSync(path, 'utf8');
    assert.equal(original.split(from).length - 1, 1, name + ': unique mutation point');
    try {
      writeFileSync(path, original.replace(from, to));
      const red = run(pattern); writeFileSync(join(folder, name.replaceAll(' ', '-') + '.log'), red.stdout + red.stderr);
      assert.equal(red.error, undefined); assert.equal(red.signal, null);
      assert.equal(red.status, 1, name + ': rejected'); assert.match(red.stdout, /AssertionError/, name + ': reached assertion');
      killed++;
    } finally {
      writeFileSync(path, original); assert.equal(readFileSync(path, 'utf8'), original);
    }
  }
  assert.equal(killed, 6); console.log(JSON.stringify({ mutants_killed: killed, mutants: mutations.length, restored: killed }));
});
