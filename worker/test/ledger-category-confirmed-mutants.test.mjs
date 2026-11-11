import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const answer = 'worker/src/lib/ledger-answer.js', analysis = 'worker/src/lib/ledger-analysis.js';
const mutations = [
  ['unknown membership guard bypass', answer, 'if (intent.categorySelector && !categoryTotalUnconfirmed)', 'if (intent.categorySelector)'],
  ['category subtotal plus one cent', answer, 'summary.ledger.category_selector = intent.categorySelector;', 'summary.ledger.total_minor += 1; summary.ledger.category_selector = intent.categorySelector;'],
  ['liability payments admitted', answer, 'const liabilityKind = loanCardPaymentKind(row, bySlug);\n    if (liabilityKind) {', 'const liabilityKind = loanCardPaymentKind(row, bySlug);\n    if (false && liabilityKind) {'],
  ['proposed label counted', analysis, 'row.category_basis_state !== "confirmed" ||', '!row.category_basis_state ||'],
  ['unconfirmed rows silently dropped', answer, '      answer += `\\nTransactions without a confirmed category: ${unsorted.length} rows totaling ${money(ledger.unsorted_minor)} ${refs(unsorted)}; left out of the confirmed category subtotal.`;', '      answer += \"\";'],
  ['model route bypasses the exclusion', answer, 'const directionRows = (categoryExpenses ? categoryExpenses.ordinary : activity.filter(row => row.direction === intent.direction)).filter(row => !notPaymentIds.has(row.id));', 'const directionRows = (categoryExpenses && !intent.interpretation ? categoryExpenses.ordinary : activity.filter(row => row.direction === intent.direction)).filter(row => !notPaymentIds.has(row.id));', true],
  ['category sum includes a card payment', answer, 'const directionRows = (categoryExpenses ? categoryExpenses.ordinary : activity.filter(row => row.direction === intent.direction)).filter(row => !notPaymentIds.has(row.id));', 'const directionRows = (categoryExpenses ? [...categoryExpenses.ordinary, ...[...categoryExpenses.payments.values()].filter(p => p.liabilityKind === "card").map(p => p.row)] : activity.filter(row => row.direction === intent.direction)).filter(row => !notPaymentIds.has(row.id));', true],
];

test('category finder and review kill all seven structural mutations in disposable copies', () => {
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'brain-category-mutants-')));
  // No installed instance or desktop credentials enter the child environment.
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'PATH', 'PATHEXT', 'COMSPEC']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
  env.CATEGORY_FINDER_STRICT = '1';
  env.HOME = join(root, 'home-test');
  env.BRAIN_NO_WRANGLER_LOGIN = '1';
  try {
    for (const path of ['worker/src', 'worker/test/ledger-review-fixture.mjs',
      'worker/test/category_spend_property_finder_generated.test.mjs', 'migrations/d1',
      'worker/test/category-confirmed-independent-review.test.mjs',
      'eval/fast-loop/money-oracle.mjs', 'package.json']) {
      mkdirSync(dirname(join(folder, path)), { recursive: true });
      cpSync(join(root, path), join(folder, path), { recursive: true });
    }
    const run = (review = false) => {
      if (process.platform !== 'win32') {
        const quiet = spawnSync('/bin/sh', ['-c', 'while [ -e ' + resolve(root, '../../MAC-QUIET') + ' ]; do sleep 60; done'],
          { env, encoding: 'utf8', timeout: 60000 });
        assert.equal(quiet.status, 0, 'quiet wait finished before child Node');
      }
      return spawnSync(process.execPath, ['--test', review ? 'worker/test/category-confirmed-independent-review.test.mjs' : 'worker/test/category_spend_property_finder_generated.test.mjs'],
        { cwd: folder, env, encoding: 'utf8', timeout: 120000 });
    };
    const green = run();
    assert.equal(green.status, 0, 'unmutated disposable copy must pass: ' + green.stdout + green.stderr);
    assert.equal(run(true).status, 0, 'unmutated review must pass');
    for (const [name, path, from, to, review] of mutations) {
      const target = join(folder, path), original = readFileSync(target, 'utf8');
      assert.ok(original.includes(from), `${name}: mutation site exists`);
      try {
        let mutated = original.replaceAll(from, to);
        // Ordinary-money membership independently excludes the same directed payment.
        // Disable both protections so this mutant still exercises an admitted liability row.
        if (name === 'liability payments admitted') mutated = mutated.replace(
          'const membership = ordinaryMoneyMembership(rows, pairs, bySlug);',
          'const membership = { ordinary: rows, excluded: new Map() };');
        // The integrated reader partitions payments before either category
        // renderer. Remove that independent defense only in these attacks.
        if (name === 'liability payments admitted' || review) mutated = mutated.replace(
          'const excludePayments = paymentReader && intent.kind !== "expense_summary" && !(intent.kind === "largest" && intent.direction === "outflow");',
          'const excludePayments = false;');
        writeFileSync(target, mutated);
        const red = run(review);
        assert.equal(red.error, undefined, `${name}: child must run`);
        assert.equal(red.signal, null, `${name}: timeout is not a killed mutant`);
        assert.equal(red.status, 1, `${name}: finder must reject mutant`);
        assert.match(red.stdout, review ? /new category totals and disclosures must agree with integer oracle/ : /wrong figures block product release/, `${name}: money assertion must be reached`);
      } finally { writeFileSync(target, original); }
    }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
