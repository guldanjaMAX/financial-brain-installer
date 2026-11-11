import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { waitForQuiet } from '../../eval/fast-loop/money-replay.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
// Each mutant removes one decision of the extended shared nominator or its
// readers. Its named red test must fail; every other test stays the control.
const mutations = [
  ['bare owner destination removed', 'ledger-analysis.js',
    "  bareOwnDestination.exec(destination)?.[1].concat(' account') ||\n", '', 'bare owner account destination'],
  ['liability transfer form removed', 'ledger-analysis.js',
    "|^${transferTo('loan|mortgage')}`", '`', 'liability transfer and processor forms'],
  ['processor repayment form removed', 'ledger-analysis.js',
    '|^${processor}(?:loan|mortgage) (?:payment|pmt|repayment|autopay)${ownMaskTail}${ownComponentTail}$', '', 'liability transfer and processor forms'],
  ['connected-mask exit restored', 'ledger-analysis.js',
    '  if (ordinaryMoneyMembership([row], [], accounts).excluded.has(row.id) || loanCardPaymentKind(row, accounts) ||',
    '  if ([...accounts.values()].some(account => account.mask && found.destination.includes(account.mask)) || ordinaryMoneyMembership([row], [], accounts).excluded.has(row.id) || loanCardPaymentKind(row, accounts) ||',
    'connected destination named without endpoint proof'],
  ['account-type review exit removed', 'ledger-analysis.js',
    ' ||\n      accountKindReviewRequired(row, accounts)) return null;', ') return null;', 'account-type review hold'],
  ['recurring endpoint proof removed', 'ledger-answer.js',
    'const provedOwnedRows = new Set(pairs.filter(pair => isDirectedOwnedTransfer(pair, bySlug)).flatMap(pair => [pair.out.id, pair.in.id]));', 'const provedOwnedRows = new Set();', 'resolved owned endpoint is never a recurring'],
  ['own-account counterpart rule removed', 'ledger-answer.js',
    "    const counterparts = kind === 'transfer' || kind === 'own_account' || destination ? others.filter(",
    "    const counterparts = kind === 'transfer' ? others.filter(", 'unproved matching deposit'],
  ['processor card phrase left open', 'ledger-analysis.js',
    'credit card (?:payment|pmt|autopay)${ownMaskTail}$|', 'credit card (?:payment|pmt|autopay)\\\\b|', 'green controls'],
  ['card transfer mixed rule removed', 'ledger-analysis.js',
    "const mixed = (kind === 'loan' || cardTransfer) &&", "const mixed = kind === 'loan' &&", 'mixed bare, liability and processor'],
  ['outside-payee veto removed', 'ledger-analysis.js',
    '  if (separatePayee && !ownedPayeeAccounts.length) return null;', '  if (false) return null;', 'outside structured payee'],
  ['whole-destination bound removed', 'ledger-analysis.js',
    '${ownMaskTail}${ownComponentTail}$`);', '${ownMaskTail}${ownComponentTail}`);', 'green controls'],
];
test('extended own-movement mutants reach their decision after green controls', () => {
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'own-movement-xcheck-mutants-')));
  const files = ['worker/src', 'migrations/d1', 'package.json', 'worker/test/ledger-review-fixture.mjs', 'worker/test/ledger-own-movement-xcheck.test.mjs'];
  try {
    const copied = [];
    const record = path => {
      const absolute = join(root, path);
      if (statSync(absolute).isDirectory()) for (const child of readdirSync(absolute)) record(path + '/' + child);
      else copied.push([path, createHash('sha256').update(readFileSync(absolute)).digest('hex')]);
    };
    for (const path of files) { record(path); mkdirSync(dirname(join(folder, path)), { recursive: true }); cpSync(join(root, path), join(folder, path), { recursive: true }); }
    for (const [path, digest] of copied)
      assert.equal(createHash('sha256').update(readFileSync(join(folder, path))).digest('hex'), digest, 'copied source: ' + path);
    writeFileSync(join(folder, 'copied-sources.sha256'), copied.map(([path, digest]) => digest + '  ' + path).join('\n') + '\n');
    const env = Object.fromEntries(['PATH', 'TMPDIR', 'NODE_COMPILE_CACHE', 'HOME', 'BRAIN_NO_WRANGLER_LOGIN'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    env.BRAIN_NO_WRANGLER_LOGIN = '1';
    const run = pattern => {
      waitForQuiet(env);
      return spawnSync(process.execPath, ['--test', '--test-name-pattern', pattern, 'worker/test/ledger-own-movement-xcheck.test.mjs'],
        { cwd: folder, env, encoding: 'utf8', timeout: 180000 });
    };
    const green = run('.'); assert.equal(green.status, 0, green.stdout + green.stderr); assert.match(green.stdout, /pass 22\b/);
    for (const [name, file, from, to, pattern] of mutations) {
      const path = join(folder, 'worker/src/lib', file), source = readFileSync(path, 'utf8'), before = createHash('sha256').update(source).digest('hex');
      assert.equal(source.split(from).length - 1, 1, name + ': exact decision reached');
      try {
        writeFileSync(path, source.replace(from, () => to));
        const red = run(pattern);
        assert.equal(red.error, undefined); assert.equal(red.signal, null);
        assert.equal(red.status, 1, name + red.stdout + red.stderr); assert.match(red.stdout, /AssertionError|TypeError/);
      } finally { writeFileSync(path, source); }
      assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), before, name + ': restored');
    }
    console.log(JSON.stringify({ mutants_killed: mutations.length, restored: mutations.length }));
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
