import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = readFileSync(new URL('../src/lib/ledger-answer.js', import.meta.url), 'utf8');
const mutations = [
  ['errored account dropped', text => text.replace('accounts = inventory;',
    "accounts = inventory.filter(a => !a.members.some(m => m.institution_status === 'error')); ")],
  ['backfill not disclosed', text => text.replace(/      lines\.push\(`\$\{name\}: history is still loading[^\n]+\n/, '')],
  ['card purchase excluded from spending', text => text.replace('const ordinary = membership.ordinary.filter(row =>',
    "const ordinary = membership.ordinary.filter(row => bySlug.get(row.effective_account_slug)?.account_kind !== 'card' &&")],
];

for (const [name, mutate] of mutations) test(`day-one mutant killed: ${name}`, () => {
  // Preserve relative imports in an isolated system-temp copy. The reviewed
  // source is never mutated, including when an assertion or child fails.
  const directory = mkdtempSync(join(tmpdir(), 'day-one-mutant-'));
  const target = pathToFileURL(join(directory, 'src', 'lib', 'ledger-answer.js'));
  const changed = mutate(source);
  assert.notEqual(changed, source, 'mutation reached its decision site');
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'TMPDIR'])
    if (process.env[key]) env[key] = process.env[key];
  env.SIMPLEFIN_DAY_ONE_STRICT = '1';
  env.SIMPLEFIN_DAY_ONE_ANSWER_MODULE = target.href;
  try {
    cpSync(new URL('../src/', import.meta.url), join(directory, 'src'), { recursive: true });
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
    writeFileSync(target, changed);
    const result = spawnSync(process.execPath, ['--test', 'worker/test/simplefin-day-one-generated.test.mjs'],
      { cwd: root, env, encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 1, 'mutant must fail assertions, without a crash or timeout');
    assert.match(result.stdout + result.stderr, /AssertionError/);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()), 'cleanup stays in system temp');
    rmSync(directory, { recursive: true, force: true });
  }
});
