import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Each mutant removes one money-out decision. The named behavior test must go
// red with an assertion (never a crash), and the source must be restored.
const root = fileURLToPath(new URL('../../', import.meta.url));
const mutations = [
  ['connected card payment counted on top of its purchases', 'ledger-answer.js',
    '      : others.filter(account => couldReceiveRepayment(account, kind));', '      : [];', 'an unproven card payment is withheld'],
  ['possible loan payment dropped from money out', 'ledger-answer.js',
    'const possiblePaymentIdsInScope = new Set(moneyOut || totalsMoneyOut ? [] : possiblePayments.map(({ row }) => row.id));',
    'const possiblePaymentIdsInScope = new Set(possiblePayments.map(({ row }) => row.id));', 'store Q4'],
  ['totals money out keeps the 0.4.27 exclusion', 'ledger-answer.js',
    "const totalsMoneyOut = intent.kind === 'totals' && !intent.inflowOnly;", 'const totalsMoneyOut = false;', 'money in and out totals'],
  ['spending measure changed', 'ledger-answer.js',
    "const moneyOut = intent.outflowMeasure === true && intent.kind === 'expense_summary';",
    "const moneyOut = intent.kind === 'expense_summary';", 'store Q4'],
  ['"You spent" lead for a went-out question', 'ledger-answer.js',
    '    : moneyOut\n    ? `${complete ? "Money out" : "Money out I could check"}', '    : false\n    ? `${complete ? "Money out" : "Money out I could check"}',
    'the proven payment is an own movement'],
  ['grammar measure dropped', 'ledger-question.js', '      ...(expense[1] ? { outflowMeasure: true } : {}),', '      ...({}),',
    'only the closed'],
  ['unproven transfer leg counted', 'ledger-answer.js',
    "const counterparts = kind === 'transfer' || kind === 'own_account' || destination ? others.filter(",
    "const counterparts = kind === 'transfer' || kind === 'own_account' || destination ? [].filter(",
    'equal amount lands'],
  ['model-read measure dropped', 'ledger-intent.js', ')) intent.outflowMeasure = true;', ')) intent.outflowMeasureDropped = true;',
    'model-read money out'],
  ['included claimed without a stated figure', 'ledger-answer.js',
    'const included = operands.has(`ledger:transaction:${row.id}`) && !counterparts.length;', 'const included = !counterparts.length;',
    'states no figure'],
  ['refused month read as figures', 'ledger-monthly.js', 'readable && both && Array.isArray(ledger.lead_accounts) ? {', 'readable && both ? {',
    'money in and out totals'],
  ['monthly operand lost', 'ledger-monthly.js', '!uncountedRepaymentNumbers.has(n)', '!possibleRepaymentNumbers.has(n)',
    'model-read money out'],
];
test('went-out measure mutants reach their decision after a green control', () => {
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'went-out-mutants-')));
  const files = ['worker/src', 'migrations/d1', 'package.json', 'worker/test/ledger-review-fixture.mjs',
    'worker/test/store-owner-shapes.measure.mjs', 'worker/test/ledger-went-out-measure.test.mjs'];
  try {
    for (const path of files) { mkdirSync(dirname(join(folder, path)), { recursive: true }); cpSync(join(root, path), join(folder, path), { recursive: true }); }
    const env = Object.fromEntries(['PATH', 'TMPDIR', 'NODE_COMPILE_CACHE', 'HOME', 'BRAIN_NO_WRANGLER_LOGIN'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    const run = pattern => spawnSync(process.execPath, ['--test', '--test-name-pattern', pattern, 'worker/test/ledger-went-out-measure.test.mjs'],
      { cwd: folder, env, encoding: 'utf8', timeout: 240000 });
    const green = run('.'); assert.equal(green.status, 0, green.stdout + green.stderr); assert.match(green.stdout, /pass 13\b/);
    for (const [name, file, from, to, pattern] of mutations) {
      const path = join(folder, 'worker/src/lib', file), source = readFileSync(path, 'utf8'), before = createHash('sha256').update(source).digest('hex');
      assert.equal(source.split(from).length - 1, 1, name + ': exact decision reached');
      try {
        writeFileSync(path, source.replace(from, to));
        const red = run(pattern);
        assert.equal(red.error, undefined); assert.equal(red.signal, null);
        assert.equal(red.status, 1, name + red.stdout + red.stderr);
        assert.match(red.stdout, /AssertionError/, name);
      } finally { writeFileSync(path, source); }
      assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), before, name + ': restored');
    }
    console.log(JSON.stringify({ mutants_killed: mutations.length, restored: mutations.length }));
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
