import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const mutations = [
  ['own nomination removed', 'ledger-analysis.js',
    '  if (!loan && !card && ownMovementDestination(text)) return possibleOwnAccountMovement(row, accounts, text);\n', '',
    'own movement excluded'],
  ['connected-mask exit restored', 'ledger-analysis.js',
    '  if (ordinaryMoneyMembership([row], [], accounts).excluded.has(row.id) || loanCardPaymentKind(row, accounts) ||',
    '  if ([...accounts.values()].some(account => account.mask && found.destination.includes(account.mask)) || ordinaryMoneyMembership([row], [], accounts).excluded.has(row.id) || loanCardPaymentKind(row, accounts) ||',
    'connected destination mask'],
  ['owner-confirmed veto removed', 'ledger-analysis.js',
    "  if (category) return { kind: 'own_account', destination: found.role, mixed: false, categoryConflict: category };\n", '',
    'owner-confirmed expense category vetoes'],
  ['conflict certified silently', 'ledger-answer.js',
    'const movementConflicts = moneyOut || totalsMoneyOut ? [] : nominatedMovements.filter(ownMovementConflict);', 'const movementConflicts = [];',
    'owner-confirmed expense category vetoes'],
  ['own line omitted', 'ledger-answer.js',
    'possible transfer to your own ${candidate.destination}, not counted as spending:', 'possible transfer to your own ${candidate.destination}:',
    'own movement excluded'],
  ['own mixed withholding removed', 'ledger-analysis.js',
    'const mixed = /\\b(?:fees?|charges?|interest|penalt(?:y|ies))\\b/.test(text) || amounts.length > 1;', 'const mixed = false;',
    'mixed own movement'],
  ['candidate also kept as unmatched transfer', 'ledger-answer.js',
    '!possibleMovementIds.has(row.id) && ', '', 'own movement excluded'],
  ['monthly conflict metadata lost', 'ledger-monthly.js',
    '...(movementConflicts.length ? { own_movement_conflicts:', '...(movementConflicts.length ? { lost_own_movement_conflicts:',
    'monthly components'],
];
test('own-movement mutants reach their decision after green controls', () => {
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'own-movement-mutants-')));
  const files = ['worker/src', 'migrations/d1', 'package.json', 'worker/test/ledger-review-fixture.mjs', 'worker/test/ledger-unconnected-own-movement.test.mjs'];
  try {
    for (const path of files) { mkdirSync(dirname(join(folder, path)), { recursive: true }); cpSync(join(root, path), join(folder, path), { recursive: true }); }
    const env = Object.fromEntries(['PATH', 'TMPDIR', 'NODE_COMPILE_CACHE', 'HOME', 'BRAIN_NO_WRANGLER_LOGIN'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    const run = pattern => spawnSync(process.execPath, ['--test', '--test-name-pattern', pattern, 'worker/test/ledger-unconnected-own-movement.test.mjs'],
      { cwd: folder, env, encoding: 'utf8', timeout: 180000 });
    const green = run('.'); assert.equal(green.status, 0, green.stdout + green.stderr); assert.match(green.stdout, /pass 49\b/);
    for (const [name, file, from, to, pattern] of mutations) {
      const path = join(folder, 'worker/src/lib', file), source = readFileSync(path, 'utf8'), before = createHash('sha256').update(source).digest('hex');
      assert.equal(source.split(from).length - 1, 1, name + ': exact decision reached');
      try {
        writeFileSync(path, source.replace(from, to));
        const red = run(pattern);
        assert.equal(red.error, undefined); assert.equal(red.signal, null);
        assert.equal(red.status, 1, name + red.stdout + red.stderr); assert.match(red.stdout, /AssertionError|TypeError/);
      } finally { writeFileSync(path, source); }
      assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), before, name + ': restored');
    }
    console.log(JSON.stringify({ mutants_killed: mutations.length, restored: mutations.length }));
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
