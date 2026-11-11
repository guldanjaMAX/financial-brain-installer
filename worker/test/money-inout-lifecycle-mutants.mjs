import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('../../', import.meta.url);
const parent = resolve(tmpdir());
const sandbox = mkdtempSync(join(parent, 'money-lifecycle-mutants-'));
const env = Object.fromEntries(['PATH','SystemRoot','WINDIR','TEMP','TMP','TMPDIR'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
const run = file => spawnSync(process.execPath, [file], { cwd: sandbox, env, encoding: 'utf8', timeout: 120000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
try {
  for (const directory of ['worker/src', 'migrations/d1'])
    cpSync(new URL(directory, root), join(sandbox, directory), { recursive: true });
  // Copy only the synthetic proof's dependencies, never a local eval corpus.
  for (const file of [
    'worker/test/ledger-review-fixture.mjs', 'worker/test/ledger-pending-lifecycle.test.mjs',
    'worker/test/money-inout-structure-mutants.mjs',
    'worker/test/money_inout_property_finder_generated.test.mjs',
    'worker/test/money-inout-review-generated.test.mjs',
    'eval/fast-loop/money-oracle.mjs', 'scripts/run-test-chain.mjs',
  ]) {
    mkdirSync(dirname(join(sandbox, file)), { recursive: true });
    cpSync(new URL(file, root), join(sandbox, file));
  }
  writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');
  const test = 'worker/test/ledger-pending-lifecycle.test.mjs';
  assert.equal(run(test).status, 0, 'green control before mutations');
  const path = join(sandbox, 'worker/src/lib/ledger-reader.js');
  const original = readFileSync(path, 'utf8');
  const mutants = [
    ['pending closing-date over-refusal', 'if (!pendingOnly && selected.some', 'if (selected.some'],
    ['pending lifecycle clipping', '${pendingOnly ? "" : `', '${false ? "" : `'],
    ['completed missing-close fail-open', 'if (!pendingOnly && selected.some', 'if (false && selected.some'],
  ];
  for (const [name, before, after] of mutants) {
    assert.ok(original.includes(before), name);
    try {
      writeFileSync(path, original.replace(before, after));
      const result = run(test);
      assert.equal(result.error, undefined, name);
      assert.notEqual(result.status, 0, `${name} survived`);
      assert.match(result.stdout + result.stderr, /ledger closing date unknown|pending open\/null|Missing expected rejection/, 'financial decision must kill mutant');
      console.log(`KILLED ${name}`);
    } finally { writeFileSync(path, original); }
  }
  assert.equal(run(test).status, 0, 'all lifecycle mutants restored');
  const inherited = run('worker/test/money-inout-structure-mutants.mjs');
  process.stdout.write(inherited.stdout);
  assert.equal(inherited.status, 0, inherited.stderr);
  const inheritedPath = join(sandbox, 'worker/test/money-inout-structure-mutants.mjs');
  const inheritedSource = readFileSync(inheritedPath, 'utf8');
  try {
    writeFileSync(inheritedPath, inheritedSource
      .replace('money_inout_property_finder_generated.test.mjs', 'money-inout-review-generated.test.mjs')
      .replace('FINDER_RECEIPT', 'REVIEW_RECEIPT'));
    const fresh = run('worker/test/money-inout-structure-mutants.mjs');
    console.log('Fresh 480-case population:');
    process.stdout.write(fresh.stdout);
    assert.equal(fresh.status, 0, fresh.stderr);
  } finally { writeFileSync(inheritedPath, inheritedSource); }
  assert.equal(readFileSync(path, 'utf8'), original, 'inherited reader mutants restored');
  console.log('mutants_killed=10/10');
} finally {
  assert.equal(dirname(resolve(sandbox)), parent);
  assert.ok(sandbox.startsWith(join(parent, 'money-lifecycle-mutants-')));
  rmSync(sandbox, { recursive: true, force: true });
}

