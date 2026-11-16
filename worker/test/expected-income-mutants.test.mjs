import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tool = 'worker/src/lib/money-tools/expected_income.js';
const helper = 'worker/src/lib/money-tools/_expected-income-helpers.js';
const mutations = [
  ['COV-01 unread inventory admitted to coverage', tool, 'accounts.filter(a => readAccounts.has(a.account_slug))', 'accounts'],
  ['partial invoice month certifies payment', tool, ' || !monthCoverage.get(period)', ''],
  ['excluded possible payer ignored', tool, '=== identity || possibleName(r, e)', '=== identity'],
  ['excluded payment evidence allocated', tool, 'if (uncertainDeposit) { ambiguousExact.add(row); continue; }', 'if (false) { ambiguousExact.add(row); continue; }'],
  ['competing obligations certified', tool, 'if (competing)', 'if (false)'],
  ['missing deposit called paid', tool, "matches.length ? \"can't tell\" : 'not yet'", "matches.length ? \"can't tell\" : 'paid'"],
  ['unclear non-invoice memo accepted', helper, '.includes(memo) ? null : false', '.includes(memo) ? null : null'],
  ['unclassified memo accepted', helper, '!clearRemainder || ', ''],
  ['mixed invoice clauses accepted', helper, '[...text.matchAll(/\\binvoice\\b/gi)].length !== 1 || ', ''],
  ['multiple deposits certify settlement', tool, 'matches.length !== 1 || row.amount_minor > e.amount_minor', 'false'],
  ['partial deposit called not yet', tool, "matches.length ? \"can't tell\" : 'not yet'", "'not yet'"],
  ['EI-02 unsupported invoice becomes absent', helper, 'return !clearRemainder || [...text.matchAll(/\\binvoice\\b/gi)].length !== 1 || new Set(found).size !== 1 ? false : found[0];', 'return new Set(found).size > 1 ? false : found[0] || null;'],
  ['expected money added to actual cash', tool, 'already_in_minor: cash,', 'already_in_minor: add(cash, remaining),'],
  ['unconfirmed forecast admitted', tool, 'const likely = e.confirmed_by_owner ?', 'const likely = true ?'],
  ['pending cash admitted', tool, "if (bucket === 'income') result.rows.push(shaped)", "if (bucket === 'income' || bucket === 'pending') result.rows.push(shaped)"],
  ['automatic confirmation', helper, 'confirmed_by_owner: 0', 'confirmed_by_owner: 1'],
  ['ambiguous deposit counted twice', tool, 'remaining -= overlap;', 'remaining -= 0;'],
  ['tenant filter removed', tool, 'WHERE tenant_id=? AND start_on<=?', 'WHERE (? IS NOT NULL) AND start_on<=?'],
  ['unreliable source date accepted', helper, '!hit.date_reliable || ', ''],
  ['one cent forecast error', tool, 'likely_remaining_minor: remaining,', 'likely_remaining_minor: remaining + 1,'],
  ['EI-01 repeating income omitted', tool, 'remaining = add(remaining, r.remaining_minor)', 'remaining = add(remaining, 0)'],
  ['EI-01 proposal hides repeating income', helper, 'e.confirmed_by_owner && normalize(e.client) === identity', 'normalize(e.client) === identity'],
  ['EI-01 possible name hides recurring payer', helper, 'e.confirmed_by_owner && normalize(e.client) === identity', 'e.confirmed_by_owner && (normalize(e.client) === identity || possibleName(last, e))'],
  ['EI-02 processing date overrides invoice period', helper, "const months = ['january'", "const iso = text.match(/\\b(\\d{4}-\\d{2})(?:-\\d{2})?\\b/); if (iso) return iso[1]; const months = ['january'"],
  ['EI-02 contradictory invoice treated as absent', helper, 'new Set(found).size !== 1 ? false', 'new Set(found).size !== 1 ? null'],
  ['EI-R1-03 history consumes current cash budget', tool, 'readFrom = from,', 'readFrom = historyFrom,'],
  ['EI-02 earlier invoice settles current month', tool, 'const period = invoicePeriod(row);', "const period = invoicePeriod(row) ? e.due_on.slice(0, 7) : invoicePeriod(row);"],
  ['EI-02 payer alone proves settlement', tool, 'if (!period && e.start_on < from)', 'if (false)'],
];

test('twenty-eight financial mutants fail assertions in disposable system-temp copies', () => {
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'brain-expectation-mutants-')));
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'PATH', 'PATHEXT', 'COMSPEC']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
  env.BRAIN_NO_WRANGLER_LOGIN = '1';
  try {
    for (const path of ['worker/src', 'worker/test/ledger-review-fixture.mjs',
      'worker/test/expected-income.test.mjs', 'migrations/d1', 'package.json']) {
      mkdirSync(dirname(join(folder, path)), { recursive: true });
      cpSync(join(root, path), join(folder, path), { recursive: true });
    }
    const run = () => spawnSync(process.execPath, ['--test', 'worker/test/expected-income.test.mjs'],
      { cwd: folder, env, encoding: 'utf8', timeout: 60000 });
    const green = run();
    assert.equal(green.status, 0, green.stdout + green.stderr);
    for (const [name, path, from, to] of mutations) {
      const target = join(folder, path), original = readFileSync(target, 'utf8');
      assert.ok(original.includes(from), `${name}: mutation site exists`);
      try {
        writeFileSync(target, original.replace(from, to));
        const red = run();
        assert.equal(red.error, undefined, `${name}: child ran`);
        assert.equal(red.signal, null, `${name}: no timeout`);
        assert.equal(red.status, 1, `${name}: must fail`);
        assert.match(red.stdout + red.stderr, /AssertionError/, `${name}: financial assertion reached`);
      } finally { writeFileSync(target, original); }
    }
  } finally {
    // Verify the absolute cleanup target remains this test's disposable folder.
    assert.ok(folder.startsWith(realpathSync.native(tmpdir())) && folder.includes('brain-expectation-mutants-'));
    rmSync(folder, { recursive: true, force: true });
  }
});
