import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const mutations = [
  ['any subtraction', "Object.assign(result.ledger, { net_refunds_unavailable: true, amount_basis: 'gross_before_refunds' });",
    "Object.assign(result.ledger, { net_refunds_unavailable: true, amount_basis: 'gross_before_refunds', net_expense_minor: result.ledger.total_minor - 1 });",
    'ledger-answer.js', /no subtraction in this release/],
  ['candidate not listed', 'result.ledger.possible_refunds = refs.map(', 'result.ledger.possible_refunds = [].map(',
    'ledger-answer.js', /every candidate listed once/],
  ['candidate answer line omitted', "if (refs.length) result.answer +=", "if (false) result.answer +=",
    'ledger-answer.js', /candidate cited/],
  ['payment credit listed', 'const credits = refundCreditMembership(history, pairs, accounts);',
    "const credits = history.filter(row => row.direction === 'inflow');", 'ledger-answer.js', /every candidate listed once/],
];

test('four closed-world refund mutants die at assertions after a green real-path control; copies restored', () => {
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'refund-mutants-')));
  const sources = ['worker/src', 'migrations/d1', 'package.json', 'worker/test/ledger-review-fixture.mjs',
    'worker/test/ledger-refund-structural.test.mjs', 'eval/fast-loop/money-oracle.mjs'];
  const inventory = [];
  const hashTree = path => {
    const absolute = join(root, path);
    try {
      for (const item of readdirSync(absolute)) hashTree(path + '/' + item);
    } catch (e) {
      if (e.code !== 'ENOTDIR') throw e;
      inventory.push([path, createHash('sha256').update(readFileSync(absolute)).digest('hex')]);
    }
  };
  try {
    for (const path of sources) {
      hashTree(path);
      mkdirSync(dirname(join(folder, path)), { recursive: true });
      cpSync(join(root, path), join(folder, path), { recursive: true });
    }
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'PATHEXT', 'COMSPEC', 'TMPDIR', 'TEMP', 'TMP', 'NODE_COMPILE_CACHE']
      .filter(key => process.env[key]).map(key => [key, process.env[key]]));
    env.HOME = join(root, 'home-test');
    env.BRAIN_NO_WRANGLER_LOGIN = '1';
    mkdirSync(env.HOME, { recursive: true });
    const run = () => {
      // Honor the host quiet protocol before every child Node launch too.
      if (process.platform !== 'win32') {
        const quiet = spawnSync('/bin/sh', ['-c', 'while [ -e "$1" ]; do sleep 60; done', 'quiet', resolve(root, '../../MAC-QUIET')],
          { env, encoding: 'utf8', timeout: 60000 });
        assert.equal(quiet.status, 0, 'quiet wait must finish before node starts');
      }
      return spawnSync(process.execPath, ['--test', 'worker/test/ledger-refund-structural.test.mjs'],
        { cwd: folder, env, encoding: 'utf8', timeout: 120000 });
    };
    const green = run();
    assert.equal(green.status, 0, green.stdout + green.stderr);
    assert.match(green.stdout, /refund_property.*640/);
    for (const [name, from, to, file = 'ledger-analysis.js', assertion] of mutations) {
      const target = join(folder, 'worker/src/lib', file);
      const original = readFileSync(target, 'utf8');
      assert.equal(original.split(from).length - 1, 1, name + ': exact mutation site');
      try {
        writeFileSync(target, original.replace(from, to));
        const red = run();
        assert.equal(red.error, undefined, name + ': child ran');
        assert.equal(red.signal, null, name + ': no timeout kill');
        assert.equal(red.status, 1, name + ': test must turn red');
        assert.match(red.stdout, /AssertionError/);
        assert.match(red.stdout, assertion,
          name + ': real refund decision assertion reached');
        assert.doesNotMatch(red.stdout + red.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND/);
      } finally { writeFileSync(target, original); }
      assert.equal(readFileSync(target, 'utf8'), original, 'mutant restored');
    }
    writeFileSync(join(folder, 'copied-sources.sha256'), inventory.map(([path, hash]) => hash + '  ' + path).join('\n') + '\n');
    console.log(JSON.stringify({ mutants_killed: mutations.length, mutants: mutations.length, restored: mutations.length }));
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
