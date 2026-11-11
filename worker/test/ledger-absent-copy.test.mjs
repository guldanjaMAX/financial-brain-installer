import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';

const ask = async f => (await withLedgerAnswer({ env: f.env,
  question: 'How much did I spend at Cedar Market last month?', now: Date.parse(NOW),
  grantScope: { all: true }, scopePrincipalKind: 'owner' }, () => assert.fail('ledger refused'))).json();

for (const [payee, suggestion] of [['Other Store', false], ['Cedar Markex', true], ['Cedar Markzz', true],
  ['Cedar Marzzz', false], ['Cedar Marketplace', false], ['Cedar Tools', false]]) {
  test(`absent payee plain copy with ${payee}`, async t => {
    const f = ledgerFixture(t);
    f.add('synthetic-row', payee, payee, { date: '2026-09-15', cents: 12345, direction: 'outflow' });
    const body = await ask(f);
    assert.equal(body.ledger.match_basis, payee === 'Cedar Marketplace' ? 'possible' : 'none', 'absence or identity-review decision reached');
    const identityReview = payee === 'Cedar Marketplace';
    assert.equal(body.answer, 'No charges found for Cedar Market from 2026-09-01 to 2026-09-30 on your account ending 1234.' +
      (suggestion ? `\nPossible matches: ${payee}.` : '') + (identityReview
        ? '\nPossible vendor matches, not included in the confirmed total: "Cedar Marketplace" [1].\nNo store total is confirmed.' : ''));
    assert.equal(body.ledger.total_minor, null);
    assert.deepEqual(body.ledger.closest_payees, suggestion ? [payee] : []);
    if (identityReview) {
      assert.equal(body.ledger.possible_identity_count, 1, 'prefix identity review reached');
      assert.equal(body.citations.length, 1);
      assert.equal(body.citations[0].amount_minor, 12345, 'review citation retains the original posting');
      assert.equal(body.ledger.possible_identity_members[0].ref, body.citations[0].ref);
      assert.doesNotMatch(body.answer, /\$/);
    } else assert.deepEqual(body.citations, []);
  });
}

test('partial coverage absence visibly discloses omitted history', async t => {
  const f = ledgerFixture(t);
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
    VALUES ('second-account','owner','checking','asset','5678','manual','owner_stated','confirmed',?)`, NOW);
  const body = await ask(f);
  assert.equal(body.ledger.match_basis, 'none', 'absence decision reached');
  assert.equal(body.answer, 'No charges found for Cedar Market from 2026-09-01 to 2026-09-30 on your account ending 1234.\nOmitted accounts: your account ending 5678; their bank history does not include every requested date.');
  assert.equal(body.ledger.coverage.omitted_account_count, 1);
  assert.equal(body.ledger.complete, false);
  assert.equal(body.gaps[0].type, 'ledger_partial_coverage');
});

// Each fixed-seed sibling has a full-history control and proves the absence
// decision was reached; missing rows cannot silently become certified absence.
let seed = 0x4281cafe;
for (let row = 0; row < 18; row++) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const states = ['missing', 'late-start', 'early-end', 'partial-status', 'unknown-start', 'unknown-end', 'unconfirmed-basis'];
  const omitted = 1 + seed % 2, state = states[row % states.length];
  const nearby = Boolean(seed & 4);
  test(`generated absence disclosure seed=0x4281cafe row=${row} ${state}`, async t => {
    for (const complete of [false, true]) {
      const f = ledgerFixture(t);
      for (let i = 0; i < omitted; i++) {
        f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
          VALUES (?, 'owner','checking','asset',?,'manual','owner_stated','confirmed',?)`, `extra-${i}`, String(5678+i), NOW);
        if (complete || state !== 'missing') f.raw(`INSERT INTO fin_account_coverage
          (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
          VALUES (?,?,?,?,?,'owner_stated',?,?)`, `extra-${i}`,
          !complete && state === 'unknown-end' ? 'missing' : !complete && state === 'partial-status' ? 'partial' : 'complete',
          !complete && state === 'unknown-start' ? null : !complete && state === 'late-start' ? '2026-09-02' : '2026-01-01',
          !complete && state === 'unknown-end' ? null : !complete && state === 'early-end' ? '2026-09-29' : '2026-10-31', NOW,
          !complete && state === 'unconfirmed-basis' ? 'proposed' : 'confirmed', NOW);
      }
      if (nearby) f.add('near', 'Cedar Markex', 'Cedar Markex', {date:'2026-09-15',direction:'outflow'});
      const body = await ask(f);
      assert.equal(body.ledger.match_basis, 'none', 'absence decision reached');
      assert.equal(body.ledger.total_minor, null);
      assert.equal(body.ledger.coverage.omitted_account_count, complete ? 0 : omitted);
      assert.equal(body.ledger.coverage.complete, complete);
      assert.equal(body.ledger.complete, false, 'absence never certifies a money total');
      assert.match(body.answer, /^No charges found for Cedar Market from 2026-09-01 to 2026-09-30 on /);
      assert.doesNotMatch(body.answer, /\$|Spending I could check/);
      assert.equal(body.answer.includes('Possible matches:'), nearby);
      if (complete) assert.doesNotMatch(body.answer, /Omitted accounts:|missing|does not include/);
      else {
        assert.match(body.answer, /Omitted accounts:.*their bank history does not include every requested date/);
        for (let i = 0; i < omitted; i++) assert.ok(body.answer.split('Omitted accounts:')[1].includes(String(5678+i)));
      }
    }
  });
}

// Isolated product mutants never alter the checkout while other tests run.
test('absence copy kills six wording, proximity, padding and hidden-history mutants', async t => {
  const { readFileSync, writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'absence-copy-mutants-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const moduleUrl = new URL('../src/lib/ledger-answer.js', import.meta.url);
  const product = readFileSync(moduleUrl, 'utf8');
  const scopeUrl = new URL('../src/lib/ledger-period-scope.js', import.meta.url);
  const scopeProduct = readFileSync(scopeUrl, 'utf8');
  const disclosureLine = scopeProduct.split('\n').find(line => line.includes('? `${result.answer}\\nOmitted accounts:'));
  assert.ok(disclosureLine, 'disclosure mutant reaches shared rule');
  const contract = readFileSync(new URL(import.meta.url), 'utf8').split('// Isolated product mutants')[0];
  const absoluteImports = (source, base) => source.replace(/from (["'])(\.\.?\/[^"']+)\1/g,
    (_, quote, path) => `from ${quote}${new URL(path, base).href}${quote}`);
  for (const [name, from, to, target] of [
    ['wording', 'No charges found for', 'No exact payee for'],
    ['label', 'Possible matches:', 'Closest payees:'],
    ['proximity', 'editDistance(normalized) > 2', 'false'],
    ['padding', 'if (!isBoundedVendorAbsence(answer.ledger))', 'if (true)'],
    ['coverage padding', 'isBoundedVendorAbsence(answer.ledger) && !intent.interpretation', 'false'],
    ['hidden omitted history', disclosureLine, '    ? result.answer', 'scope'],
  ]) {
    const original = target === 'scope' ? scopeProduct : product;
    assert.ok(original.includes(from), name + ' anchor');
    const changed = original.replace(from, to);
    assert.notEqual(changed, original, name + ' changes source');
    const modulePath = join(dir, name + '.mjs');
    let source = absoluteImports(target === 'scope' ? product : changed, moduleUrl);
    if (target === 'scope') {
      const scopePath = join(dir, 'hidden-scope.mjs');
      writeFileSync(scopePath, absoluteImports(changed, scopeUrl));
      source = source.replace(scopeUrl.href, pathToFileURL(scopePath).href);
    }
    writeFileSync(modulePath, source);
    const child = join(dir, name + '-test.mjs');
    writeFileSync(child, absoluteImports(contract, import.meta.url).replace(moduleUrl.href, pathToFileURL(modulePath).href));
    const env = Object.fromEntries(['SystemRoot', 'TEMP', 'TMP', 'PATH'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    const result = spawnSync(process.execPath, ['--test', child], { env, encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 1, name + ' must turn red');
    assert.match(result.stdout, /ERR_ASSERTION/, name + ' must fail an assertion');
    if (name === 'hidden omitted history') assert.match(result.stdout, /Omitted accounts:/,
      'hidden-history mutant fails the visible disclosure contract');
    t.diagnostic(`mutant killed: ${name}`);
  }
});

