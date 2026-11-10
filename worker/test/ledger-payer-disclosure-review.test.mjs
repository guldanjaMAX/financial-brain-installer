import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { readFileSync } from 'node:fs';
import { cpSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const answerUrl = new URL('../src/lib/ledger-answer.js', import.meta.url);
const parsedSource = readFileSync(answerUrl, 'utf8')
  .replace('async function withParsedLedgerAnswer(', 'export async function withParsedLedgerAnswer(')
  .replace(/from (["'])(\.\.?\/[^"']+)\1/g, (_, quote, path) => `from ${quote}${new URL(path, answerUrl).href}${quote}`);
const { withParsedLedgerAnswer } = await import(`data:text/javascript;base64,${Buffer.from(parsedSource).toString('base64')}`);

function setup(t) {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  return f;
}
async function reached(f, question, intent = null) {
  const before = f.calls.length, changes = f.first('SELECT total_changes() n').n;
  const options = { env: f.env, question, now: NOW, grantScope: { all: true }, scopePrincipalKind: 'owner' };
  let response;
  if (intent) {
    // The ordinary broad payer form is admitted by the deterministic parser.
    // The model compiler requires a literal vendor, so exercise the monthly
    // composition seam with an explicit window, without widening admission.
    const parsed = classifyLedgerQuestion('Show income by merchant last month', { now: NOW, timeZone: 'UTC' });
    assert.equal(parsed.kind, 'merchant', 'real broad payer parser admits the period');
    assert.equal(parsed.direction, 'inflow'); assert.equal(parsed.match, null);
    assert.equal(parsed.from, '2026-09-01');
    response = await withParsedLedgerAnswer(options, () => assert.fail('ledger route required'), { ...parsed, from: '2026-08-01', to: '2026-10-12', monthlyBreakdown: true });
  } else response = await withLedgerAnswer(options, () => assert.fail('ledger route required'));
  const body = await response.json();
  assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)), 'persisted transaction decision reached');
  assert.equal(f.first('SELECT total_changes() n').n, changes, 'read-only answer');
  assert.ok(body.ledger, 'ledger answer reached');
  return body;
}
function connect(f) {
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
    VALUES ('reserve','owner','savings','asset','5678','manual','owner_stated','confirmed',?)`, NOW);
  f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
    VALUES ('reserve','complete','2024-01-01','2026-10-31',?,'owner_stated','confirmed',?)`, NOW, NOW);
}
const cash = amount => '$' + (amount / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function assertDisclosure(body, disclosure, total) {
  assert.equal(disclosure?.total_minor, total, 'not-payment disclosure survives');
  assert.equal(disclosure.rows.length, 2);
  const line = body.answer.split('\n').find(line => line.includes(`Not counted as payments to you: ${cash(total)} (`));
  assert.ok(line, 'separate amount line survives');
  for (const row of disclosure.rows) {
    const ref = body.citations.find(ref => ref.n === row.n);
    assert.equal(ref?.amount_minor, row.amount_minor, 'rebased citation has the exact amount');
    assert.equal(ref?.posted_on, row.posted_on, 'rebased citation has the exact date');
    assert.equal(ref?.account_mask, '1234');
    assert.ok(line.includes(`${row.reason} ${cash(row.amount_minor)} [${row.n}]`));
  }
}

test('F1 monthly payer composition retains separate not-payment amounts and rebased evidence', async t => {
  const f = setup(t);
  for (const [month, receipt, refund, contribution] of [['08', 100000, 5000, 20000], ['09', 110000, 6000, 22000]]) {
    f.add('receipt-' + month, 'Payroll', 'Payroll Unit', { date: `2026-${month}-05`, cents: receipt });
    f.add('refund-' + month, 'Merchant refund for returned purchase', 'Refund Unit', { date: `2026-${month}-06`, cents: refund });
    f.add('contribution-' + month, 'Owner contribution', 'Contribution Unit', { date: `2026-${month}-07`, cents: contribution });
  }
  const control = await reached(f, 'Who paid me last month?');
  assert.equal(control.ledger.total_minor, 110000, 'single-month green control');
  assert.equal(control.ledger.complete, false, 'bank labels never certify payer identity');
  assertDisclosure(control, control.ledger.not_payments, 28000);
  const body = await reached(f, 'Show income by merchant month by month since August', { kind: 'merchant', direction: 'inflow' });
  assert.equal(body.ledger.months.length, 3, 'real monthly composition reached');
  assert.equal(body.ledger.complete, false, 'monthly composition cannot certify payer income');
  assert.equal(new Set(body.citations.map(ref => ref.n)).size, body.citations.length, 'global citation numbers are unique');
  for (const [index, total] of [[0, 25000], [1, 28000]]) {
    const month = body.ledger.months[index];
    assert.equal(month.available, false, 'disclosure is preserved even when payer attribution is unavailable');
    assert.equal(month.total_minor, null); assert.equal(month.subtotal_minor, null);
    assertDisclosure(body, month.not_payments, total);
    for (const row of month.not_payments.rows) {
      assert.ok(!month.amount_citations.includes(row.n), 'not-payment evidence is never an amount operand');
      assert.ok(month.citations.includes(row.n));
    }
  }
  assert.ok(Math.min(...body.ledger.months[1].not_payments.rows.map(row => row.n)) >
    Math.max(...body.ledger.months[0].citations), 'later month citations are rebased');
});

test('F2 retained movement describes an unproved counterpart without inventing account connection', async t => {
  for (const state of ['connected-four-days', 'unknown', 'connected-no-deposit', 'connected-same-day']) {
    const f = setup(t);
    f.add('purchase', 'Store purchase', 'Store Unit', { cents: 567, direction: 'outflow' });
    assert.equal((await reached(f, 'How much money went out this month?')).ledger.expense_total_minor, 567, 'ordinary green control');
    if (state !== 'unknown') connect(f);
    f.add('move', state === 'unknown' ? 'Transfer to personal' : 'WIRE TO ACCT 5678', null,
      { cents: 12345, direction: 'outflow' });
    if (state.includes('days') || state.includes('same-day')) {
      f.add('deposit', 'DEPOSIT', null, { cents: 12345, date: state.includes('four') ? '2026-10-09' : '2026-10-05' });
      f.raw("UPDATE fin_transactions SET account_slug='reserve' WHERE txn_uid='deposit'");
    }
    const body = await reached(f, 'How much money went out this month?');
    const row = body.ledger.possible_payments?.[0];
    assert.ok(row, 'movement nomination and disclosure reached');
    assert.ok(body.citations.some(ref => ref.n === row.n && ref.amount_minor === 12345));
    if (state === 'connected-same-day') {
      assert.equal(body.ledger.expense_total_minor, null, 'nearby unproved counterpart withholds');
      assert.equal(body.ledger.reason, 'money_out_destination_unconfirmed');
      assert.ok(row.connected_counterpart_masks.length > 0, 'connected counterpart decision reached');
    } else {
      assert.equal(body.ledger.expense_total_minor, 12912, 'unproved movement remains in money out');
      assert.equal(row.included_in_total, true, 'retained operand decision reached');
      assert.match(row.label, /counterpart.*not proved/i);
      assert.doesNotMatch(body.answer, /(?:is|that is|account that is) not connected/i);
    }
  }
});

test('F3 payer transfer guidance never offers to turn own movements into payer income', async t => {
  const f = setup(t); connect(f);
  f.add('payroll', 'Payroll', 'Payroll Unit', { cents: 100000, date: '2026-09-05' });
  f.add('move-out', 'Transfer to account 5678', null, { cents: 20000, direction: 'outflow', date: '2026-09-06' });
  f.add('move-in', 'Transfer from account 1234', null, { cents: 20000, date: '2026-09-06' });
  f.raw("UPDATE fin_transactions SET account_slug='reserve' WHERE txn_uid='move-in'");
  const control = await reached(f, 'How much money came in and went out last month?');
  assert.equal(control.ledger.lead_accounts.reduce((sum, account) => sum + account.credits_minor, 0), 100000, 'ordinary-activity green control');
  assert.ok(control.ledger.flip.includes('including transfers'), 'supported raw-activity toggle survives');
  const body = await reached(f, 'Who paid me last month?');
  assert.equal(body.ledger.total_minor, 100000);
  assert.equal(body.ledger.not_payments?.total_minor, 20000, 'own-account exclusion decision reached');
  assert.ok(body.ledger.transfers.length > 0, 'paired movement decision reached');
  assert.equal(body.ledger.complete, false, 'payer identity remains unconfirmed');
  assert.ok(!body.ledger.flip.includes('including transfers'), 'payer flip cannot offer an ineffective toggle');
  assert.doesNotMatch(body.answer, /say "including transfers"/i);
  const included = await reached(f, 'Show income by merchant last month including transfers');
  assert.equal(included.ledger.total_minor, 100000, 'an explicit activity toggle cannot make own movements payer income');
  assert.equal(included.ledger.not_payments?.total_minor, 20000, 'toggle still reaches the payer exclusion');
});

test('review mutants turn each protected behavior red and restore exact source bytes', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'payer-disclosure-mutants-')));
  const files = ['worker/src', 'migrations/d1', 'package.json', 'worker/test/ledger-review-fixture.mjs',
    'worker/test/ledger-payer-disclosure-review.test.mjs'];
  const mutations = [
    ['F1 disclosure dropped', 'ledger-monthly.js', 'const childNotPayments = ledger?.not_payments;', 'const childNotPayments = null;', 'F1 '],
    ['F1 citations not rebased', 'ledger-monthly.js',
      'rows: childNotPayments.rows.map(row => ({ ...row, n: citationOffset + row.n })),',
      'rows: childNotPayments.rows.map(row => ({ ...row })),', 'F1 '],
    ['F1 excluded credits become operands', 'ledger-monthly.js', 'amount_citations: amountCitations,', 'amount_citations: [...amountCitations, ...(notPayments?.rows || []).map(row => row.n)],', 'F1 '],
    ['F2 connection invented', 'ledger-answer.js', '(counterpart not proved)', 'that is not connected', 'F2 '],
    ['F3 ineffective toggle restored', 'ledger-answer.js', 'else if (payerListing) notes.push', 'else if (false) notes.push', 'F3 '],
  ];
  const digest = source => createHash('sha256').update(source).digest('hex');
  try {
    for (const path of files) {
      mkdirSync(dirname(join(folder, path)), { recursive: true });
      cpSync(join(root, path), join(folder, path), { recursive: true });
    }
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'TMPDIR', 'NODE_COMPILE_CACHE', 'HOME', 'BRAIN_NO_WRANGLER_LOGIN', 'BRAIN_TEST_NODE_GUARD']
      .filter(key => process.env[key]).map(key => [key, process.env[key]]));
    const run = pattern => {
      const nodeArgs = ['--test', '--test-reporter=tap', '--test-name-pattern', pattern,
        'worker/test/ledger-payer-disclosure-review.test.mjs'];
      const options = { cwd: folder, env, encoding: 'utf8', timeout: 180000, windowsHide: true };
      if (process.platform === 'win32') return spawnSync(process.execPath, nodeArgs, options);
      return spawnSync('/bin/zsh', ['-c',
      (process.env.BRAIN_TEST_NODE_GUARD || ':') + '\nexec nice -n 10 "$@"',
        'mutation-check', process.execPath, ...nodeArgs], options);
    };
    const green = run('^F[123] ');
    assert.equal(green.status, 0, green.stdout + green.stderr);
    assert.match(green.stdout, /# pass 3\b/);
    for (const [label, file, from, to, pattern] of mutations) {
      const path = join(folder, 'worker/src/lib', file), source = readFileSync(path, 'utf8');
      const original = digest(source);
      assert.equal(source.split(from).length - 1, 1, label + ': exact decision reached');
      try {
        writeFileSync(path, source.replace(from, () => to));
        const red = run(pattern);
        assert.equal(red.error, undefined); assert.equal(red.signal, null);
        assert.equal(red.status, 1, label + red.stdout + red.stderr);
        assert.match(red.stdout, /AssertionError/, label + ': behavior assertion failed');
      } finally { writeFileSync(path, source); }
      assert.equal(digest(readFileSync(path)), original, label + ': source restored');
    }
    const restored = run('^F[123] ');
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    assert.match(restored.stdout, /# pass 3\b/);
    console.log(JSON.stringify({ mutants_killed: mutations.length, restored: mutations.length }));
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
