import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { waitForQuiet } from '../../eval/fast-loop/money-replay.mjs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
// Each mutant removes one decision of the shared admitted-inflow membership.
// Its named behavior test must go red with an assertion; the source is restored.
const mutations = [
  ['payer boundary removed', 'ledger-answer.js',
    'const directionRows = (categoryExpenses ? categoryExpenses.ordinary : activity.filter(row => row.direction === intent.direction)).filter(row => !notPaymentIds.has(row.id));', 'const directionRows = categoryExpenses ? categoryExpenses.ordinary : activity.filter(row => row.direction === intent.direction);', 'proved own-account move'],
  ['payer listing reads the undirected pairing', 'ledger-answer.js',
    'payerReading ? pairOwnTransfers(pairingRows, bySlug, { directedEvidence: true }).pairs',
    'payerReading ? pairOwnTransfers(pairingRows, bySlug, { directedEvidence: false }).pairs', 'proved own-account move'],
  ['money in leaves the shared membership', 'ledger-answer.js',
    '\n      provedOwnInflowPair(pair, inflowMembership));', '\n      false);', 'proved own-account move'],
  ['directed proof dropped from the shared membership', 'ledger-answer.js',
    'selected.has(pair.in.effective_account_slug) && inWindow(pair.in) && isDirectedOwnedTransfer(pair, bySlug);',
    'selected.has(pair.in.effective_account_slug) && inWindow(pair.in);', 'answer boundary'],
  ['not-a-payment disclosure removed', 'ledger-answer.js',
    'Not counted as payments to you: ${money(ledger.not_payments.total_minor)} (', '${money(ledger.not_payments.total_minor)} (',
    'proved own-account move'],
  ['possible own money admitted', 'ledger-answer.js',
    'possibleOwnedMovement(row, bySlug) || ordinaryMoneyMembership([row], [], bySlug).excluded.has(row.id) ||\n      pairing.candidateRows.has(row.id) || ownMovementRole(row) ?',
    'false ?', 'answer boundary'],
  ['owner contribution read as possible own money', 'ledger-answer.js',
    '    : ownMovementRole(row)?.includes("owner contribution") ? "an owner contribution"\n', '', 'answer boundary'],
  ['refund and reversal text admitted', 'ledger-answer.js',
    ' : payerListing && refundCandidateIds([], [row]).size ? "a refund or reversal" : null;', ' : null;', 'answer boundary'],
];
test('payer inflow membership mutants reach their decision after green controls', () => {
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'payer-inflow-mutants-')));
  const files = ['worker/src', 'migrations/d1', 'package.json', 'worker/test/ledger-review-fixture.mjs', 'worker/test/ledger-payer-inflow-membership.test.mjs'];
  try {
    const copied = [];
    const record = path => {
      const absolute = join(root, path);
      if (statSync(absolute).isDirectory()) for (const child of readdirSync(absolute)) record(path + '/' + child);
      else copied.push([path, createHash('sha256').update(readFileSync(absolute)).digest('hex')]);
    };
    for (const path of files) { record(path); mkdirSync(dirname(join(folder, path)), { recursive: true }); cpSync(join(root, path), join(folder, path), { recursive: true }); }
    for (const [path, digest] of copied) assert.equal(createHash('sha256').update(readFileSync(join(folder, path))).digest('hex'), digest);
    writeFileSync(join(folder, 'copied-sources.sha256'), copied.map(([path, digest]) => digest + '  ' + path).join('\n') + '\n');
    const env = Object.fromEntries(['PATH', 'TMPDIR', 'NODE_COMPILE_CACHE', 'HOME', 'BRAIN_NO_WRANGLER_LOGIN'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    const run = pattern => {
      waitForQuiet(env);
      return spawnSync(process.execPath, ['--test', '--test-name-pattern', pattern, 'worker/test/ledger-payer-inflow-membership.test.mjs'],
      { cwd: folder, env, encoding: 'utf8', timeout: 180000 });
    };
    const green = run('.'); assert.equal(green.status, 0, green.stdout + green.stderr); assert.match(green.stdout, /pass 5\b/);
    for (const [name, file, from, to, pattern] of mutations) {
      const path = join(folder, 'worker/src/lib', file), source = readFileSync(path, 'utf8'), before = createHash('sha256').update(source).digest('hex');
      assert.equal(source.split(from).length - 1, 1, name + ': exact decision reached');
      try {
        writeFileSync(path, source.replace(from, () => to));
        const red = run(pattern);
        assert.equal(red.error, undefined); assert.equal(red.signal, null);
        assert.equal(red.status, 1, name + red.stdout + red.stderr); assert.match(red.stdout, /AssertionError/, name);
      } finally { writeFileSync(path, source); }
      assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), before, name + ': restored');
    }
    console.log(JSON.stringify({ mutants_killed: mutations.length, restored: mutations.length }));
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
