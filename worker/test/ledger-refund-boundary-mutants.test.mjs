import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const monthlyMetadata = 'refund_disclosure: ledger.refund_disclosure,';
const mutations = [
  ['boundary disabled', 'ledger-answer.js', '  enforceRefundDisclosure(body, refundBoundary);', '', /boundary failure must withhold disclosure/],
  ['monthly candidate metadata lost', 'ledger-monthly.js', monthlyMetadata, 'lost_disclosure: ledger.refund_disclosure,', /monthly candidate label retained/],
  ['posting account treated as counterparty', 'ledger-analysis.js',
    'account.account_slug !== row.effective_account_slug && ', '', /exact expected candidate population/],
  ['duplicate rendered candidate', 'ledger-answer.js',
    "  if (refs.length) result.answer +=", "  refs.push(...refs);\n  if (refs.length) result.answer +=", /bank text and citation rendered together/],
];

test('four boundary mutants killed with green controls and restored copies', () => {
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'refund-boundary-mutants-')));
  const sources = ['worker/src', 'migrations/d1', 'package.json', 'worker/test/ledger-review-fixture.mjs',
    'worker/test/ledger-refund-boundary.test.mjs', 'eval/fast-loop/money-oracle.mjs'];
  const inventory = [];
  const hashTree = path => {
    const absolute = join(root, path);
    try { for (const name of readdirSync(absolute)) hashTree(path + '/' + name); }
    catch (error) {
      if (error.code !== 'ENOTDIR') throw error;
      inventory.push(createHash('sha256').update(readFileSync(absolute)).digest('hex') + '  ' + path);
    }
  };
  for (const path of sources) {
    hashTree(path);
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    cpSync(join(root, path), join(folder, path), { recursive: true });
  }
  writeFileSync(join(folder, 'copied-sources.sha256'), inventory.join('\n') + '\n');
  const env = Object.fromEntries(['PATH', 'TMPDIR', 'NODE_COMPILE_CACHE'].filter(key => process.env[key])
    .map(key => [key, process.env[key]]));
  env.HOME = join(root, 'home-test'); env.BRAIN_NO_WRANGLER_LOGIN = '1';
  const run = (pattern, fault = false) => {
    return spawnSync(process.execPath, ['--test', '--test-name-pattern', pattern, 'worker/test/ledger-refund-boundary.test.mjs'],
      { cwd: folder, env: { ...env, ...(fault ? { REFUND_BOUNDARY_FAULT: '1' } : {}) }, encoding: 'utf8', timeout: 120000 });
  };
  const green = run('overall expense summary|posting account|monthly rollup');
  assert.equal(green.status, 0, green.stdout + green.stderr);
  assert.match(green.stdout, /pass 8\b/);
  const faultSites = [
    ['metadata', monthlyMetadata, 'lost_disclosure: ledger.refund_disclosure,'],
    ['quoted bank text', '"${candidate.bank_text}"', '"omitted"'],
    ['citation rebase', 'n: candidate.n + citations.length - refs.length', 'n: candidate.n + citations.length - refs.length + 1'],
    ['period placement', 'return `${month.label}:', "return `${month.label === 'October 2026' ? 'September 2026' : month.label}:"],
  ];
  const monthlyPath = join(folder, 'worker/src/lib/ledger-monthly.js');
  const monthlySource = readFileSync(monthlyPath, 'utf8');
  for (const [name, from, to] of faultSites) {
    assert.equal(monthlySource.split(from).length - 1, 1, name + ': exact fault site');
    try {
      writeFileSync(monthlyPath, monthlySource.replace(from, to));
      const refused = run('boundary fault witness', true);
      assert.equal(refused.status, 0, name + ': ' + refused.stdout + refused.stderr);
      assert.match(refused.stdout, /pass 1\b/);
      writeFileSync(join(folder, 'guard-' + name.replaceAll(' ', '-') + '.log'), refused.stdout + refused.stderr);
    } finally { writeFileSync(monthlyPath, monthlySource); }
  }
  const answerPath = join(folder, 'worker/src/lib/ledger-answer.js');
  const answerSource = readFileSync(answerPath, 'utf8');
  const omitNominee = 'new Map(credits.map(row => [row.id, row]))';
  assert.equal(answerSource.split(omitNominee).length - 1, 1, 'renderer nominee-drop fault site');
  try {
    writeFileSync(answerPath, answerSource.replace(omitNominee, 'new Map(credits.slice(1).map(row => [row.id, row]))'));
    const refused = run('boundary fault witness', true);
    assert.equal(refused.status, 0, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /pass 1\b/);
    writeFileSync(join(folder, 'guard-nominee-dropped-by-renderer.log'), refused.stdout + refused.stderr);
  } finally { writeFileSync(answerPath, answerSource); }
  console.log(JSON.stringify({ boundary_faults_refused: faultSites.length + 1, restored: faultSites.length + 1 }));
  let killed = 0;
  for (const [name, file, from, to, marker] of mutations) {
    const target = join(folder, 'worker/src/lib', file), original = readFileSync(target, 'utf8');
    const monthly = join(folder, 'worker/src/lib/ledger-monthly.js'), monthlyOriginal = readFileSync(monthly, 'utf8');
    assert.equal(original.split(from).length - 1, 1, name + ': exact mutation site reached');
    try {
      if (name === 'boundary disabled') {
        // First prove the intact boundary detects a real composition fault.
        writeFileSync(monthly, monthlyOriginal.replace(monthlyMetadata, 'lost_disclosure: ledger.refund_disclosure,'));
        const guarded = run('boundary fault witness', true);
        assert.equal(guarded.status, 0, guarded.stdout + guarded.stderr);
        assert.match(guarded.stdout, /pass 1\b/);
      }
      writeFileSync(target, original.replace(from, to));
      const red = name === 'boundary disabled' ? run('boundary fault witness', true)
        : run(name.includes('monthly') ? 'monthly rollup' : name.includes('posting') ? 'posting account' : 'explicit expense_summary');
      assert.equal(red.error, undefined, name + ': no launch failure');
      assert.equal(red.signal, null, name + ': no timeout');
      assert.equal(red.status, 1, name + ': killed');
      assert.match(red.stdout, /AssertionError/);
      assert.match(red.stdout, marker, name + ': reached product assertion\n' + red.stdout);
      assert.doesNotMatch(red.stdout + red.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND/);
      writeFileSync(join(folder, name.replaceAll(' ', '-') + '.log'), red.stdout + red.stderr);
      killed++;
    } finally {
      writeFileSync(target, original);
      writeFileSync(monthly, monthlyOriginal);
    }
    assert.equal(readFileSync(target, 'utf8'), original, 'mutant restored');
    assert.equal(readFileSync(monthly, 'utf8'), monthlyOriginal, 'composition restored');
  }
  const restored = run('overall expense summary|posting account|monthly rollup');
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  assert.match(restored.stdout, /pass 8\b/);
  console.log(JSON.stringify({ boundary_mutants_killed: killed, mutants: mutations.length, restored: killed }));
});
