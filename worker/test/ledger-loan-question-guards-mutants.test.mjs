import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { waitForQuiet } from '../../eval/fast-loop/money-replay.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const mutations = [
  ['confirmed sending kind before fallback', 'ledger-analysis.js', [['assetKinds.includes(from?.account_kind)', 'true']], 'green reciprocal withdrawal'],
  ['confirmed receiving kind before fallback', 'ledger-analysis.js', [['assetKinds.includes(to?.account_kind)', 'true']], 'green reciprocal withdrawal'],
  ['consistent sending role before fallback', 'ledger-analysis.js', [['!hasAccountKindConflict(from)', 'true']], 'green reciprocal withdrawal'],
  ['consistent receiving role before fallback', 'ledger-analysis.js', [['!hasAccountKindConflict(to)', 'true']], 'green reciprocal withdrawal'],
  ['proved withdrawal endpoint', 'ledger-analysis.js', [['const directed = isDirectedOwnedTransfer(pair, accounts);', 'const directed = false;']], 'green reciprocal withdrawal'],
  ['reciprocal proof before partition', 'ledger-answer.js', [['loanCardPaymentKind(row, bySlug) || movementMembership.excluded.get(row.id)?.liabilityKind', 'loanCardPaymentKind(row, bySlug)']], 'green reciprocal liability proof'],
  ['accepted card review boundary', 'ledger-answer.js', [["(isOwnedMovementChannel(row.payee, { cardOnly: true }) || !possibleOwnedMovement(row, bySlug)?.counterpart)", '(!possibleOwnedMovement(row, bySlug)?.counterpart)']], 'green accepted card expense conflict'],
  ['outside payee boundary', 'ledger-analysis.js', [["if (row.direction === 'outflow' && hasIndependentOutsidePayee(row, accounts)) return null;", 'if (false) return null;']], 'green identity literal'],
  ['generic transfer outside payee boundary', 'ledger-answer.js', [["transfers && isTransferCandidate(row) && !hasIndependentOutsidePayee(row, bySlug)", 'transfers && isTransferCandidate(row)']], 'green identity literal'],
  ['unresolved endpoint nomination', 'ledger-analysis.js', [['ownMaskPattern.test(locator) || /^\\d{1,4}(?: |$)/.test(locator);', 'ownMaskPattern.test(locator) || /^\\d{1,4}$/.test(locator);']], 'G6 an unresolved endpoint tail'],
  ['category income membership', 'ledger-answer.js', [['const payerReading = ["merchant", "category"].includes(intent.kind) && intent.direction === "inflow";', 'const payerReading = intent.kind === "merchant" && intent.direction === "inflow";']], 'G4 category income'],
  ['vendor identity protection', 'ledger-intent-contract.js', [['if (intent?.match) {', 'if (false && intent?.match) {']], 'green identity literal'],
  ['payment subject', 'ledger-intent-contract.js', [['export function loanPaymentSubject(question, intent = null) {', 'export function loanPaymentSubject(question, intent = null) { return false;']], 'G1 payment subject'],
  ['unresolved selector', 'ledger-intent-contract.js', [['export const loanAccountSelector = value =>', 'export const loanAccountSelector = value => false &&']], 'G1 unresolved.*business'],
  ['spending disclosure', 'ledger-answer.js', [['result.answer += candidate.destination', 'void candidate.destination']], 'G2 uncertain'],
  ['unary retention', 'ledger-analysis.js', [['if (nomination) possible.set(row.id, nomination);', 'if (nomination) { possible.set(row.id, nomination); excluded.set(row.id, nomination); }']], 'G3 unary'],
  ['credit disclosure', 'ledger-answer.js', [['if (candidates.length) {\n      result.ledger.possible_owned_credits', 'if (false && candidates.length) {\n      result.ledger.possible_owned_credits']], 'G3 unary credit'],
  ['possible income', 'ledger-analysis.js', [['export function possibleOwnedMovement(row, accounts) {', 'export function possibleOwnedMovement(row, accounts) { return null;']], 'G4 possible own credit'],
  ['named income', 'ledger-answer.js', [['const notPayments = payerReading ? rows.filter', 'const notPayments = payerReading && !intent.match ? rows.filter']], 'G4 named'],
  ['equal counterpart hold', 'ledger-answer.js', [['moneyOutReading?.unconfirmed.length && !mixedLoanPayments.length', 'false && moneyOutReading?.unconfirmed.length && !mixedLoanPayments.length']], 'equal connected counterpart'],
  ['pending suppression', 'ledger-reader.js', [['AND NOT EXISTS (\n        SELECT 1 FROM fin_transactions posted', 'AND EXISTS (\n        SELECT 1 FROM fin_transactions posted']], 'G5 linked pending'],
  ['pending linkage required', 'ledger-reader.js', [['AND posted.pending_transaction_id=t.external_id', 'AND 1=1']], 'green controls: unlinked hold'],
  ['pending account boundary', 'ledger-reader.js', [['posted.tenant_id=t.tenant_id AND posted.account_slug=t.account_slug', 'posted.tenant_id=t.tenant_id']], 'G5 linkage.*account'],
  ['pending tenant boundary', 'ledger-reader.js', [['posted.tenant_id=t.tenant_id AND posted.account_slug=t.account_slug', 'posted.account_slug=t.account_slug']], 'G5 linkage.*tenant'],
  ['typed endpoint', 'ledger-analysis.js', [['${channel}(?:loan )?payment', '${channel}payment']], 'G6 reciprocal'],
  ['fully consumed endpoint', 'ledger-analysis.js', [['const text = normalizeLedgerText(locator).replace', "const text = normalizeLedgerText(locator).replace(/ extra$/, '').replace"]], 'G6 recognizer'],
  ['pair amount', 'ledger-analysis.js', [['pair.out.amount_minor !== pair.in.amount_minor', 'false'], ['JSON.stringify([row.currency, row.amount_minor, direction, day])', 'JSON.stringify([row.currency, direction, day])']], 'G6 recognizer'],
  ['pair window', 'ledger-analysis.js', [['let offset = -3; offset <= 3 && count < 2', 'let offset = -4; offset <= 4 && count < 2']], 'G6 recognizer'],
  ['pair uniqueness', 'ledger-analysis.js', [['if (count === 1) peers.set', 'if (count >= 1) peers.set']], 'G6 recognizer'],
  ['disclose once', 'ledger-answer.js', [['pairedIncoming.add(pair.in.id);', 'if (false) pairedIncoming.add(pair.in.id);']], 'G6 reciprocal'],
  ['three day payment disclosure', 'ledger-answer.js', [['Math.abs(Date.parse(pair.out.posted_on) - Date.parse(pair.in.posted_on)) > 3 * 86400000 ||', 'Math.abs(Date.parse(pair.out.posted_on) - Date.parse(pair.in.posted_on)) > 86400000 ||']], 'G6 recognizer'],
];

test('loan guard clause mutants fail only after populated green controls and restore exact bytes', () => {
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'loan-guard-mutants-')));
  try {
    const copied = [];
    const record = path => {
      const absolute = join(root, path);
      if (statSync(absolute).isDirectory()) for (const child of readdirSync(absolute)) record(path + '/' + child);
      else copied.push([path, createHash('sha256').update(readFileSync(absolute)).digest('hex')]);
    };
    for (const path of ['worker/src', 'migrations/d1', 'package.json', 'worker/test/ledger-review-fixture.mjs',
      'worker/test/fixtures/ledger-intent-cases.mjs', 'worker/test/ledger-loan-question-guards.test.mjs']) {
      record(path); mkdirSync(dirname(join(folder, path)), { recursive: true }); cpSync(join(root, path), join(folder, path), { recursive: true });
    }
    for (const [path, digest] of copied)
      assert.equal(createHash('sha256').update(readFileSync(join(folder, path))).digest('hex'), digest, 'copied source: ' + path);
    writeFileSync(join(folder, 'copied-sources.sha256'), copied.map(([path, digest]) => digest + '  ' + path).join('\n') + '\n');
    const env = Object.fromEntries(['PATH', 'TMPDIR', 'NODE_COMPILE_CACHE', 'HOME', 'BRAIN_NO_WRANGLER_LOGIN'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    env.BRAIN_NO_WRANGLER_LOGIN = '1';
    const run = pattern => {
      waitForQuiet(env);
      return spawnSync(process.execPath, ['--test', '--test-name-pattern', pattern, 'worker/test/ledger-loan-question-guards.test.mjs'],
        { cwd: folder, env, encoding: 'utf8', timeout: 180000 });
    };
    const green = run('.'); assert.equal(green.status, 0, green.stdout + green.stderr); assert.match(green.stdout, /pass 44\b/);
    let killed = 0;
    for (const [name, file, edits, pattern] of mutations) {
      const path = join(folder, 'worker/src/lib', file), original = readFileSync(path, 'utf8');
      const digest = createHash('sha256').update(original).digest('hex');
      let changed = original;
      for (const [from, to] of edits) {
        assert.equal(changed.split(from).length - 1, 1, name + ': exact decision reached');
        changed = changed.replace(from, () => to);
      }
      try {
        writeFileSync(path, changed);
        const red = run(pattern);
        assert.equal(red.error, undefined, name); assert.equal(red.signal, null, name);
        assert.equal(red.status, 1, name + red.stdout + red.stderr); assert.match(red.stdout, /AssertionError/, name);
        killed++;
      } finally { writeFileSync(path, original); }
      assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), digest, name + ': restored');
    }
    console.log(JSON.stringify({ mutants_killed: killed, total: mutations.length, restored: killed }));
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('both offline chain lists include each loan guard proof', async () => {
  const { TEST_COMMANDS, POST_LAUNCHER_TEST_COMMANDS } = await import('../../scripts/run-test-chain.mjs');
  for (const commands of [TEST_COMMANDS, POST_LAUNCHER_TEST_COMMANDS]) {
    for (const file of ['ledger-loan-question-guards.test.mjs', 'ledger-loan-question-guards-mutants.test.mjs'])
      assert.equal(commands.filter(command => command === 'node --test worker/test/' + file).length, 1);
  }
});
