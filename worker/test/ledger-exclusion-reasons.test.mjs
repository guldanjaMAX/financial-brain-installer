import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture, NOW } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { replay } from '../../eval/fast-loop/money-replay.mjs';
import { scoreRun } from '../../eval/fast-loop/money-score.mjs';
import { BASE_CASES, CONTROLS } from '../../test/fixtures/fastloop-money/input.mjs';

const QUESTIONS = [
  'biggest charges last month',
  'What were my biggest charges last month?',
  'Show my largest charges last month',
  'What were my ten largest expenses last month?',
  'Show my 10 largest expenses last month',
  'What were my biggest expenses last month?',
  'List my largest expenses last month',
  'What were my largest expenses in September 2026?',
  'Show my 10 biggest expenses in September 2026',
  'What were my ten largest charges last month?',
  'Show my largest charges in September 2026',
];

function setup(t, { kind = 'loan', payment = true, paired = false, withdrawal = false } = {}) {
  const f = fixture(t); f.owner();
  for (const [slug, mask, accountKind] of [
    ['checking-unit', '1111', 'checking'], ['destination-unit', '2222', kind],
  ]) {
    f.raw(`INSERT INTO fin_accounts
      (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
      VALUES (?,'owner',?,?,?,'manual','owner_stated','confirmed',?)`,
    slug, accountKind, ['loan', 'card', 'line_of_credit'].includes(accountKind) ? 'liability' : 'asset', mask, NOW);
    f.raw(`INSERT INTO fin_account_coverage
      (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES (?,'complete','2026-08-01','2026-10-31',?,'owner_stated','confirmed',?)`, slug, NOW, NOW);
  }
  const add = (id, slug, amount, direction, description, category = null) => f.raw(`INSERT INTO fin_transactions
    (txn_uid,account_slug,posted_on,amount_minor,direction,description,category,category_basis_state,provenance,basis_state,recorded_at)
    VALUES (?,?,'2026-09-15',?,?,?,?,?,'owner_stated','confirmed',?)`,
  id, slug, amount, direction, description, category, category ? 'confirmed' : null, NOW);
  add('ordinary-expense', 'checking-unit', 12000, 'outflow', 'Ordinary purchase');
  if (payment) add('owned-payment', 'checking-unit', 70318, 'outflow',
    `TRANSFER TO ${kind === 'card' ? 'CARD' : kind === 'loan' ? 'LOAN' : 'ACCOUNT'} ACCT NO. XXXX2222`);
  if (paired) add('counterpart', 'destination-unit', 70318, 'inflow', 'TRANSFER FROM ACCOUNT 1111');
  if (withdrawal) add('withdrawal', 'checking-unit', 40900, 'inflow', 'TRANSFER FROM RETIREMENT',
    'TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS');
  f.askWith = async (question, answerPath = withLedgerAnswer) => {
    const before = f.calls.length;
    const result = await answerPath({ env: f.env, question, now: Date.parse(NOW),
      grantScope: { all: true }, scopePrincipalKind: 'owner' }, async () => Response.json({ route: 'documents' }));
    return { body: await result.json(), sql: f.calls.slice(before) };
  };
  return f;
}

function checkPayment(result, kind) {
  assert.ok(result.sql.some(sql => /JOIN fin_transactions/.test(sql)), 'real transaction decision reached');
  const { body } = result;
  assert.equal(body.ledger?.kind, 'largest', 'ranking decision reached');
  assert.equal(body.ledger.own_account_payments.count, 1, 'payment exclusion decision reached');
  assert.equal(body.ledger.own_account_payments.total_minor, 70318);
  assert.equal(body.ledger.own_account_payments[`${kind === 'card' ? 'card' : 'loan'}_minor`], 70318);
  assert.deepEqual(body.ledger.lead_rows.map(row => row.amount_minor), [12000]);
  assert.deepEqual(body.ledger.rows.map(row => row.amount_minor), [12000], 'R1 alternate ranking excludes payments too');
  assert.equal(body.ledger.if_own_transfers.total_minor, 12000);
  assert.match(body.answer, /Payments to loans and cards \(excluded from spending and income\):.*across [12] payments?/);
  assert.equal(body.answer.match(/^Payments to loans and cards \(excluded from spending and income\):/gm)?.length, 1);
  assert.doesNotMatch(body.answer, /Excluded payment|Possible transfer, unmatched/,
    'the payment has one cited receipt and never an unmatched-transfer appendix');
  assert.doesNotMatch(body.answer, /Possible transfer, unmatched|retirement or investment withdrawal/);
  assert.equal(body.ledger.unmatched_transfers.length, 0, 'known payment is not an unmatched transfer');
}

test('own loan and card payments retain their reason for eleven question variants', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network forbidden'); });
  for (const kind of ['loan', 'card']) {
    const f = setup(t, { kind });
    const control = setup(t, { kind, payment: false });
    for (const question of QUESTIONS) {
      checkPayment(await f.askWith(question), kind);
      const ordinary = await control.askWith(question);
      assert.ok(ordinary.sql.some(sql => /JOIN fin_transactions/.test(sql)), 'green control reached transaction SQL');
      assert.deepEqual(ordinary.body.ledger.lead_rows.map(row => row.amount_minor), [12000]);
      assert.equal(ordinary.body.ledger.own_account_payments, undefined);
      assert.doesNotMatch(ordinary.body.answer, /Excluded payment|retirement or investment withdrawal/);
    }
  }
});

test('paired payment and below-cutoff payment use the same classification', async t => {
  const paired = setup(t, { paired: true });
  checkPayment(await paired.askWith(QUESTIONS[0]), 'loan');
  const below = setup(t);
  below.raw("UPDATE fin_transactions SET amount_minor=90000 WHERE txn_uid='ordinary-expense'");
  const result = await below.askWith('What were my 1 largest expenses last month?');
  assert.ok(result.sql.some(sql => /JOIN fin_transactions/.test(sql)));
  assert.equal(result.body.ledger.own_account_payments.total_minor, 70318);
  assert.deepEqual(result.body.ledger.lead_rows.map(row => row.amount_minor), [90000]);
  assert.match(result.body.answer, /Payments to loans and cards \(excluded from spending and income\): \$703\.18 across 1 payment/);
  assert.doesNotMatch(result.body.answer, /Excluded payment/);
  assert.doesNotMatch(result.body.answer, /Possible transfer, unmatched|retirement or investment withdrawal/);
});

// The same recorded payment decision owns every rendering path. Neither a
// counterpart nor a display cutoff creates a second place to explain it.
for (const kind of ['loan', 'card', 'line_of_credit']) {
  for (const paired of [false, true]) for (const belowCutoff of [false, true]) {
    test(`one payment explanation: ${kind}, paired=${paired}, below cutoff=${belowCutoff}`, async t => {
      const f = setup(t, { kind, paired });
      const control = setup(t, { kind, paired });
      // Only the recorded counterparty changes. A similarly described payment
      // to an external party must remain ordinary spending, not disappear.
      control.raw("UPDATE fin_transactions SET payee='External Store' WHERE txn_uid='owned-payment'");
      const ordinaryMinor = belowCutoff ? 90000 : 12000;
      for (const fixture of [f, control]) fixture.raw(
        "UPDATE fin_transactions SET amount_minor=? WHERE txn_uid='ordinary-expense'", ordinaryMinor);
      for (const wording of [...QUESTIONS,
        'What were my largest expenses last month including transfers?',
        'What were my largest expenses last month excluding transfers?',
        'What were my largest expenses last month including withdrawals?',
      ]) {
        const question = belowCutoff ? wording.replace(/ten |10 /, '').replace(/largest|biggest/, '1 largest') : wording;
        const result = await f.askWith(question);
        assert.ok(result.sql.some(sql => /JOIN fin_transactions/.test(sql)), 'payment decision read real rows');
        assert.equal(result.body.ledger?.kind, 'largest');
        assert.equal(result.body.ledger.own_account_payments.count, 1, 'exact owned-payment decision reached');
        assert.equal(result.body.ledger.own_account_payments.total_minor, 70318);
        assert.equal(result.body.ledger.own_account_payments[kind === 'card' ? 'card_minor' : 'loan_minor'], 70318);
        assert.deepEqual(result.body.ledger.lead_rows.map(row => row.amount_minor), [ordinaryMinor]);
        assert.equal(result.body.answer.match(/^Payments to loans and cards \(excluded from spending and income\):/gm)?.length, 1);
        assert.doesNotMatch(result.body.answer, /Excluded payment|Possible transfer, unmatched|retirement or investment withdrawal/);
        assert.deepEqual(result.body.ledger.unmatched_transfers, []);
        const green = await control.askWith(question);
        assert.ok(green.sql.some(sql => /JOIN fin_transactions/.test(sql)), 'external-payee control read real rows');
        assert.equal(green.body.ledger?.kind, 'largest');
        assert.equal(green.body.ledger.own_account_payments, undefined);
        assert.deepEqual(green.body.ledger.lead_rows.map(row => row.amount_minor),
          belowCutoff ? [90000] : [70318, 12000]);
        assert.doesNotMatch(green.body.answer, /Excluded payment/);
        if (paired) {
          // The external outgoing leg remains spending, while the independent
          // receiving liability posting must now have its own cited receipt.
          const receipt = green.body.ledger.payment_exclusions;
          assert.equal(receipt.count, 1);
          assert.equal(receipt.total_minor, 70318);
          assert.equal(receipt.rows[0].direction, 'inflow');
          assert.equal(receipt.rows[0].account_mask, '2222');
          assert.equal(green.body.citations.find(ref => ref.n === receipt.rows[0].n).ref,
            `ledger:transaction:${control.first("SELECT id FROM fin_transactions WHERE txn_uid='counterpart'").id}`);
        } else {
          assert.equal(green.body.ledger.payment_exclusions, undefined);
          assert.doesNotMatch(green.body.answer, /Payments to loans and cards \(excluded from spending and income\):/);
        }
      }
    });
  }
}

test('real retirement withdrawal keeps its reason and explicit inclusion restores it', async t => {
  const f = setup(t, { payment: false, withdrawal: true });
  const omitted = await f.askWith('What were my largest deposits last month?');
  assert.ok(omitted.sql.some(sql => /JOIN fin_transactions/.test(sql)));
  assert.equal(omitted.body.ledger.default_exclusions.withdrawal_count, 1);
  assert.deepEqual(omitted.body.ledger.lead_rows, []);
  assert.match(omitted.body.answer, /left out of the first figures as a retirement or investment withdrawal/);
  const restored = await f.askWith('What were my largest deposits last month including withdrawals?');
  assert.equal(restored.body.ledger.default_exclusions.withdrawal_count, 0);
  assert.deepEqual(restored.body.ledger.lead_rows.map(row => row.amount_minor), [40900]);
  assert.match(restored.body.answer, /retained in income\/spend totals/);
});

test('matched own-account transfer keeps the transfer explanation', async t => {
  const f = setup(t, { kind: 'savings', paired: true });
  const result = await f.askWith(QUESTIONS[0]);
  assert.ok(result.sql.some(sql => /JOIN fin_transactions/.test(sql)));
  assert.equal(result.body.ledger.default_exclusions.own_transfer_pairs, 1);
  assert.deepEqual(result.body.ledger.lead_rows.map(row => row.amount_minor), [12000]);
  assert.match(result.body.answer, /Moves between your own connected accounts, left out/);
  assert.match(result.body.answer, /left out of the first figures as a matched own-account transfer/);
  assert.doesNotMatch(result.body.answer, /retirement or investment withdrawal/);
  const included = await f.askWith('What were my largest expenses last month including transfers?');
  assert.equal(included.body.ledger.default_exclusions.own_transfer_pairs, 0);
  assert.deepEqual(included.body.ledger.lead_rows.map(row => row.amount_minor), [70318, 12000]);
});

for (const [kind, reason, field, include] of [
  ['retirement', 'a retirement or investment withdrawal', 'withdrawal_count', 'withdrawals'],
  ['loan', 'loan or line-of-credit proceeds', 'loan_proceeds_count', 'loan proceeds'],
]) test(`paired ${kind} inflow preserves its actual exclusion reason`, async t => {
  const f = setup(t, { payment: false, kind });
  for (const [id, account, direction, description] of [
    ['source-leg', 'destination-unit', 'outflow', 'TRANSFER TO ACCOUNT 1111'],
    ['receiving-leg', 'checking-unit', 'inflow', 'TRANSFER FROM ACCOUNT 2222'],
  ]) f.raw(`INSERT INTO fin_transactions
    (txn_uid,account_slug,posted_on,amount_minor,direction,description,provenance,basis_state,recorded_at)
    VALUES (?,?,'2026-09-16',40900,?,?,'owner_stated','confirmed',?)`, id, account, direction, description, NOW);
  const result = await f.askWith('What were my largest deposits last month?');
  assert.ok(result.sql.some(sql => /JOIN fin_transactions/.test(sql)));
  assert.equal(result.body.ledger.default_exclusions[field], 1, 'paired exclusion decision reached');
  assert.deepEqual(result.body.ledger.lead_rows, []);
  assert.ok(result.body.answer.includes(`left out of the first figures as ${reason}`));
  const included = await f.askWith(`What were my largest deposits last month including ${include}?`);
  assert.equal(included.body.ledger.default_exclusions[field], 0);
  assert.deepEqual(included.body.ledger.lead_rows.map(row => row.amount_minor), [40900]);
});

test('withdrawals below the display cutoff retain the wider-pool explanation', async t => {
  const f = setup(t, { payment: false, withdrawal: true });
  f.raw(`INSERT INTO fin_transactions
    (txn_uid,account_slug,posted_on,amount_minor,direction,description,provenance,basis_state,recorded_at)
    VALUES ('ordinary-deposit','checking-unit','2026-09-17',90000,'inflow','Ordinary deposit','owner_stated','confirmed',?)`, NOW);
  const result = await f.askWith('What were my 1 largest deposits last month?');
  assert.ok(result.sql.some(sql => /JOIN fin_transactions/.test(sql)));
  assert.equal(result.body.ledger.default_exclusions.withdrawal_count, 1);
  assert.deepEqual(result.body.ledger.lead_rows.map(row => row.amount_minor), [90000]);
  assert.match(result.body.answer, /a retirement or investment withdrawal excluded from the wider candidate pool; outside the displayed rows/);
});

test('restoring the wrong label and unmatched appendix is caught by the payment probe', async t => {
  const sourceUrl = new URL('../src/lib/ledger-answer.js', import.meta.url);
  let source = readFileSync(sourceUrl, 'utf8');
  for (const [before, after] of [
    ['unmatched.filter(row => !expensePayments.has(row.id))', 'unmatched'],
    ['? exclusionLabel(row)', '? "left out of the first figures as a retirement or investment withdrawal; kept in the gross figures"'],
  ]) {
    assert.equal(source.split(before).length - 1, 1, 'restoring mutant reached exactly one changed site');
    source = source.replace(before, after);
  }
  source = source.replace(/from "(\.\/[^"\n]+)"/g, (_, path) => `from ${JSON.stringify(new URL(path, sourceUrl).href)}`);
  const mutant = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const f = setup(t);
  const wrong = await f.askWith(QUESTIONS[0], mutant.withLedgerAnswer);
  assert.ok(wrong.sql.some(sql => /JOIN fin_transactions/.test(sql)), 'mutant reached real transaction SQL');
  assert.equal(wrong.body.ledger.own_account_payments.count, 1);
  assert.match(wrong.body.answer, /Possible transfer, unmatched \(left out of the first figures as a retirement or investment withdrawal/);
  assert.throws(() => checkPayment(wrong, 'loan'), assert.AssertionError, 'the same payment probe kills the restoring mutant');
  checkPayment(await f.askWith(QUESTIONS[0]), 'loan');
});

test('HF-01 restoring the duplicate dated payment makes the unchanged M08 key red', () => {
  const inputs = [...BASE_CASES, ...CONTROLS];
  const fixed = replay({ cases: inputs });
  const green = scoreRun(fixed, inputs);
  const score = green.scores.find(row => row.id === 'M08');
  assert.equal(score.verdict, 'correct');
  assert.equal(score.required_facts_met, 6);
  assert.equal(score.required_facts_total, 6);
  assert.deepEqual(green.scores.filter(row => row.verdict === 'wrong figure').map(row => row.id), []);
  const source = readFileSync(new URL('../src/lib/ledger-answer.js', import.meta.url), 'utf8');
  const site = '  return refundResult({ answer, citations, ledger });\n}\n\n// The only integration point';
  assert.equal(source.split(site).length - 1, 1, 'one final rendering decision reached');
  const duplicate = '  for (const { row } of expensePayments.values()) answer += `\\nExcluded payment (${exclusionLabel(row)}): ${rowLine(row)}.`;\n';
  const changed = source.replace(site, duplicate + site);
  assert.notEqual(changed, source, 'restoring mutant changes executed product source');
  const c = inputs.find(row => row.id === 'M08');
  const mutant = replay({ cases: [c], sourceOverrides: { 'ledger-answer.js': changed } });
  const observation = mutant.observations[0];
  assert.ok(observation.trace.rows_read.length > 0, 'mutant read the nonempty ranking pool');
  assert.equal(observation.body.ledger.own_account_payments.total_minor, 40000, 'payment decision reached');
  assert.match(observation.body.answer, /Excluded payment \(a payment to your own loan account excluded from the wider candidate pool; outside the displayed rows\)/);
  const red = scoreRun(mutant, [c]).scores[0];
  assert.equal(red.verdict, 'wrong figure', 'unchanged bench kills restore-duplicate-dated-payment');
  assert.ok(red.reasons.some(reason => reason.startsWith('unreviewed-money-prose:')));
  assert.ok(red.reasons.some(reason => reason.startsWith('display-row-date:')));
  assert.equal(scoreRun(replay({ cases: [c] }), [c]).scores[0].verdict, 'correct', 'intact peer stays green');
});
