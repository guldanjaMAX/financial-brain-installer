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
  ['monthly refusal reason lost', 'ledger-monthly.js', 'part?.reason || ledger?.reason ||', 'part?.reason ||', 'monthly payment refusal'],
  ['monthly refund references lost', 'ledger-monthly.js', ' || ledger?.refund_disclosure)', ')', 'monthly payment refusal'],
  ['untyped payment refusal disabled', 'ledger-answer.js', "if (untypedPayments.length &&", 'if (false &&', 'untyped.*payment must withhold'],
  ['directed memo payee veto restored', 'ledger-analysis.js', "endpoint?.form === 'unary' && resolvesExactAccount(endpoint.locator, account, accounts)", 'false', 'composite components'],
  ['card channel payee veto restored', 'ledger-analysis.js', '(?:(?:(?:credit card|card|loan) )?payment|transfer)', '(?:payment|transfer)', 'owned card-payment channel'],
  ['unknown selector guard disabled', 'ledger-answer.js', 'if (categoryResolution && !categoryResolution.resolved)', 'if (false)', 'unresolved category|unknown selector'],
  ['unconfirmed ownership guard disabled', 'ledger-answer.js', 'if (unresolvedCardMovements.length &&', 'if (false &&', 'ownership unconfirmed'],
  ['category substring membership restored', 'ledger-analysis.js', 'return category === wanted;', 'return containsTokens(category, wanted);', 'exact category selection'],
];

test('finder guards kill eight product mutations with reached green controls and restored copies', () => {
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'finder-guards-mutants-')));
  const copied = [];
  const inventory = path => {
    const absolute = join(root, path);
    try { for (const name of readdirSync(absolute)) inventory(path + '/' + name); }
    catch (error) {
      if (error.code !== 'ENOTDIR') throw error;
      copied.push(createHash('sha256').update(readFileSync(absolute)).digest('hex') + '  ' + path);
    }
  };
  for (const path of ['worker/src', 'migrations/d1', 'package.json', 'worker/test/ledger-review-fixture.mjs',
    'worker/test/ledger-finder-wrong-guards.test.mjs']) {
    inventory(path);
    mkdirSync(dirname(join(folder, path)), { recursive:true });
    cpSync(join(root, path), join(folder, path), {recursive:true});
  }
  writeFileSync(join(folder, 'copied-sources.sha256'), copied.join('\n') + '\n');
  const env = Object.fromEntries(['PATH','TMPDIR','NODE_COMPILE_CACHE','SystemRoot','WINDIR'].filter(key => process.env[key])
    .map(key => [key, process.env[key]]));
  env.HOME = join(root, 'home-test');
  env.BRAIN_NO_WRANGLER_LOGIN = '1';
  const run = pattern => {
    if (process.platform !== 'win32') {
      const quiet = spawnSync('/bin/sh', ['-c', 'while [ -e ' + resolve(root, '../../MAC-QUIET') + ' ]; do sleep 60; done'],
        {env, encoding:'utf8', timeout:60000});
      assert.equal(quiet.status, 0, 'quiet wait completed before child Node');
    }
    return spawnSync(process.execPath, ['--test', '--test-name-pattern', pattern, 'worker/test/ledger-finder-wrong-guards.test.mjs'],
      {cwd:folder, env, encoding:'utf8', timeout:120000});
  };
  const green = run('.*');
  writeFileSync(join(folder, 'green.log'), green.stdout + green.stderr);
  assert.equal(green.status, 0, green.stdout + green.stderr);
  assert.match(green.stdout, /pass 20\b/);
  let killed = 0;
  for (const [name, file, from, to, pattern] of mutations) {
    const path = join(folder, 'worker/src/lib', file), original = readFileSync(path, 'utf8');
    assert.equal(original.split(from).length - 1, 1, name + ': unique decision point');
    try {
      writeFileSync(path, original.replace(from, to));
      const red = run(pattern);
      writeFileSync(join(folder, name.replaceAll(' ', '-') + '.log'), red.stdout + red.stderr);
      assert.equal(red.error, undefined, name + ': no launch failure');
      assert.equal(red.signal, null, name + ': no timeout');
      assert.equal(red.status, 1, name + ': regression rejected');
      assert.match(red.stdout, /AssertionError/, name + ': money or membership assertion reached');
      killed++;
    } finally {
      writeFileSync(path, original);
      assert.equal(readFileSync(path, 'utf8'), original, name + ': restored exact source');
    }
  }
  assert.equal(killed, 8);
  console.log(JSON.stringify({mutants_killed:killed, mutants:mutations.length, restored:killed}));
});
