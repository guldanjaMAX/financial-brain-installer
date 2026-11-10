import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture } from '../worker/test/ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../worker/src/lib/ledger-answer.js';
import { isOwnedMovement } from '../worker/src/lib/ledger-analysis.js';
import { minor, total, displayFigures } from '../eval/fast-loop/money-oracle.mjs';

// Membership is enforced; --strict-properties also exposes capability omissions.
// Gold is schedule metadata authored here, never inferred by a product helper.
const SEEDS = [0x10427, 0x426, 0x1104];
const TYPES = ['monthly', 'annual', 'irregular', 'price', 'tax', 'skipped',
  'refund', 'card', 'transfer', 'loan', 'descriptors', 'partial'];
const random = seed => () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
const shift = day => { const d = new Date(`${day}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10); };
const signature = b => (b.ledger?.recurring || []).map(g => [g.merchant, g.cadence, g.typical_minor, g.monthly_minor]);

function generate() {
  const cases = [];
  for (const seed of SEEDS) {
    const next = random(seed);
    for (let i = 0; i < 204; i++) {
      const type = TYPES[i % TYPES.length], cents = 1000 + next() % 9000;
      const day = String(2 + next() % 9).padStart(2, '0');
      let dates = ['08', '09', '10'].map(m => `2026-${m}-${day}`);
      if (type === 'annual') dates = ['2024', '2025', '2026'].map(y => `${y}-10-${day}`);
      if (type === 'skipped') dates = ['07', '08', '10'].map(m => `2026-${m}-${day}`);
      if (type === 'irregular') dates = [`2026-08-${day}`, '2026-08-22', `2026-10-${day}`];
      const rows = dates.map((date, n) => ({ id: n + 1, date, cents: String(cents +
        (type === 'price' && n === 2 ? Math.ceil(cents / 4) : type === 'tax' && n === 2 ? 1 + next() % 50 : 0)),
        direction: 'outflow', payee: ['transfer', 'loan'].includes(type) ? null : 'Service Unit',
        description: type === 'transfer' ? 'Transfer to savings 5678' : type === 'loan' ? 'Payment to loan 5678'
          : type === 'descriptors' ? `Service Unit reference ${n}` : 'Service Unit' }));
      if (type === 'refund') rows.push({ ...rows[1], id: 4, direction: 'inflow' });
      if (type === 'transfer') for (const row of [...rows]) rows.push({ ...row, id: row.id + 3,
        account: 'destination', direction: 'inflow', description: 'Transfer from checking 1234' });
      // Two distinct descriptor-only merchants, each with its own monthly series.
      if (type === 'descriptors') {
        rows.forEach(r => { r.payee = null; r.description = 'Service Unit plan alpha'; });
        rows.push(...rows.map(r => ({ ...r, id: r.id + 3, description: 'Service Unit plan beta', cents: String(cents + 137) })));
      }
      cases.push({ id: `${seed}/${i}`, type, rows });
    }
  }
  return cases;
}

// Contract: typical is the upper median of observed positive charges, refunds
// do not create a new subscription, and annual monthly estimates round cents.
// Irregular subscriptions have no defensible monthly estimate (null); skipped
// months retain the known schedule. These are capability probes, not evidence
// that a ledger alone can prove the generated subscription contract.
function gold(c) {
  if (['transfer', 'loan'].includes(c.type)) return [];
  const groups = new Map();
  for (const r of c.rows.filter(r => r.direction === 'outflow')) {
    const name = (r.payee || r.description).toLowerCase();
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(minor(r.cents));
  }
  return [...groups].filter(([, values]) => values.length >= 3).map(([name, values]) => {
    values.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    const typical = values[Math.floor(values.length / 2)];
    return [name, c.type === 'annual' ? 'annual' : c.type === 'irregular' ? 'irregular' : 'monthly', Number(typical),
      c.type === 'irregular' ? null : Number(c.type === 'annual' ? (typical + 6n) / 12n : typical)];
  }).sort((a, b) => a[0].localeCompare(b[0]));
}

function failures(c, b, moved) {
  const expected = gold(c), got = signature(b), found = [];
  if (c.type === 'loan' && c.rows.length >= 3) {
    // This generated family has no conflicting payee and names the exact
    // connected loan ending. The integrated payment rule proves exclusion;
    // unresolved descriptions in the sibling controls remain set aside.
    assert.equal(b.ledger?.possible_owned_movements?.length, 0);
    assert.equal(b.ledger?.payment_exclusions?.count, c.rows.length);
    assert.deepEqual(b.ledger.payment_exclusions.rows.map(row => [row.posted_on, row.amount_minor]).sort(),
      c.rows.map(row => [row.date, Number(row.cents)]).sort(), 'excluded dates and amounts stay exact');
    assert.equal(b.ledger.payment_exclusions.total_minor, Number(total(c.rows.map(row => row.cents))));
    for (const row of b.ledger.payment_exclusions.rows) {
      assert.equal(row.own_loan_mask, '5678');
      assert.equal(b.citations.find(ref => ref.n === row.n)?.amount_minor, row.amount_minor);
    }
  }
  for (const series of got) if (!expected.some(g => JSON.stringify(g) === JSON.stringify(series)))
    found.push(['wrong', ['transfer', 'loan'].includes(c.type) ? 'owned-movement' : 'cadence-or-amount']);
  if (b.ledger && b.ledger.monthly_total_minor !== (b.ledger.set_aside_recurring?.length || c.type === 'partial' ? null : Number(total(got.map(g => String(g[3])))))) found.push(['wrong', 'total']);
  if (c.type === 'partial' && (b.evidence_gate?.complete || b.ledger?.complete === true)) found.push(['wrong', 'partial-complete']);
  if (JSON.stringify(got) !== JSON.stringify(signature(moved))) found.push(['wrong', 'date-shift']);
  if (c.type !== 'partial' && expected.some(g => !got.some(s => JSON.stringify(s) === JSON.stringify(g))))
    found.push(['refusal', ['annual', 'irregular', 'skipped'].includes(c.type) ? c.type : 'amount-drift']);
  if (got.length) {
    const figures = displayFigures(b.answer);
    if (!got.every(g => figures.some(f => f.cents === String(g[2])))) found.push(['wrong', 'rendered-amount']);
  }
  return [...new Map(found.map(f => [f.join('/'), f])).values()];
}

test('612 seeded ledgers: independent gold, real answer path, shrinking and grouping', async t => {
  const f = ledgerFixture(t);
  f.raw("UPDATE fin_account_coverage SET covered_from='2023-01-01', covered_to='2026-12-31'");
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at)
    SELECT 'destination',entity_slug,'savings','asset','5678',feed_mode,provenance,source_feed,basis_state,recorded_at FROM fin_accounts WHERE account_slug='fixture-account'`);
  f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at)
    SELECT 'destination',coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at FROM fin_account_coverage WHERE account_slug='fixture-account'`);
  let modelCalls = 0, executions = 0;
  f.env.AI.run = async () => { modelCalls++; throw Error('MODEL_FORBIDDEN'); };
  async function answer(c, moved = false) {
    executions++;
    f.raw('DELETE FROM fin_transactions');
    f.raw("UPDATE fin_accounts SET account_kind=?, balance_role=CASE WHEN ? IN ('card','loan') THEN 'liability' ELSE 'asset' END WHERE account_slug='destination'", c.kind || (c.type === 'loan' ? 'loan' : 'savings'), c.kind || (c.type === 'loan' ? 'loan' : 'savings'));
    f.raw("UPDATE fin_accounts SET account_kind=?, balance_role=CASE WHEN ? IN ('card','loan') THEN 'liability' ELSE 'asset' END WHERE account_slug='fixture-account'", c.type === 'card' ? 'card' : 'checking', c.type === 'card' ? 'card' : 'checking');
    f.raw("UPDATE fin_account_coverage SET coverage_status=CASE WHEN account_slug='destination' THEN ? ELSE 'complete' END",
      c.type === 'partial' ? 'partial' : 'complete');
    for (const r of c.rows) f.raw(`INSERT INTO fin_transactions
      (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,?,?,?,?,?,?,'feed','bank-feed:fixture-feed','confirmed','2026-10-12T12:00:00Z')`,
    `synthetic-${r.id}`, r.account || 'fixture-account', moved ? shift(r.date) : r.date, Number(r.cents), r.direction, r.description, r.payee);
    const decisionStart = f.calls.length;
    const response = await withLedgerAnswer({ env: f.env, question: 'What do I pay for every month?',
    now: Date.parse(moved ? '2026-11-12T12:00:00Z' : '2026-10-12T12:00:00Z'),
    grantScope: { all: true }, scopePrincipalKind: 'owner', callLLM: async () => { modelCalls++; throw Error('MODEL_FORBIDDEN'); } },
    async gap => Response.json({ gaps: gap ? [gap] : [], evidence_gate: { complete: false } }));
    const body = await response.json();
    assert.ok(f.calls.slice(decisionStart).some(sql => /JOIN fin_transactions/.test(sql)), 'persisted recurring decision reached');
    return body;
  }
  // These five bank-text controls are explicit repayments under the shared
  // unconnected-loan contract. Other account-looking controls remain uncertain.
  const possibleLoanChannels = new Set(['Loan autopay', 'Automatic loan repayment', 'Mortgage payment', 'Loan pmt', 'Repayment of loan']);
  const possibleLoanContract = (body, rows, cents) => {
    assert.equal(body.ledger.monthly_total_minor, 0);
    assert.equal(body.ledger.lead_monthly_total_minor, 0);
    assert.equal(body.ledger.if_own_transfers.monthly_total_minor, 0);
    assert.equal(body.ledger.recurring.length, 0);
    assert.equal(body.ledger.possible_owned_movements.length, 0, 'no owned endpoint is proved');
    assert.equal(body.ledger.possible_payments.length, rows.length, 'nonempty payment decision reached');
    assert.deepEqual(body.ledger.possible_payments.map(r => [r.posted_on, r.amount_minor]).sort(), rows.map(r => [r.date, cents]).sort());
    for (const r of body.ledger.possible_payments) {
      assert.equal(r.payment_kind, 'loan');
      assert.ok(body.citations.some(c => c.n === r.n && c.posted_on === r.posted_on && c.amount_minor === cents));
    }
    assert.ok(body.answer.includes('possible loan payment, not counted as spending:'));
  };
  // Exact review inputs and fresh seeds; gold is authored independently.
  let reviewCases = 0;
  const owned = ['Loan autopay', 'Automatic loan repayment', 'Mortgage payment',
    'Credit card autopay', 'Savings xfer', 'Transfer to money market', 'Loan pmt',
    'Payment to installment account', 'Repayment of loan', 'Deposit account transfer',
    'Payment to account ending in 5678', 'Loan acct no. 5678', 'Account xxxx5678', 'Account ****5678', 'Liability payment', 'Payment to liability account', 'Payment for loan', 'Payment for loan account ending in 5678', 'Loan principal repayment', 'Savings scheduled periodic xfer', 'Payment scheduled toward mortgage'];
  for (const seed of [0x9a71, 0xb842, 0xec03]) {
    const next = random(seed);
    for (const [i, description] of owned.entries()) {
      const kind = /card/i.test(description) ? 'card' : /loan|mortgage|installment|liability/i.test(description) ? 'loan' : 'savings';
      const cents = seed === 0x9a71 ? 1999 : 1 + next() % 9000;
      const series = description => ['08', '09', '10'].map((m, n) => ({id: n + 1,
        date: '2026-' + m + '-07', cents: String(cents), direction: 'outflow', payee: 'Cloud Suite', description}));
      // Run the external control first so review M1/M2 reproduce independently.
      const control = ['Cloud Suite invoice 1234', 'Payment for credit monitoring subscription',
        'Cloud Suite reference 5678', 'Payment for loan monitoring subscription',
        'Payment for savings advice subscription', 'Payment for liability insurance subscription'][i % 6];
      const green = await answer({type: 'monthly', kind, rows: series(control)});
      assert.equal(green.ledger.recurring.length, 1, control);
      assert.equal(green.ledger.monthly_total_minor, cents, control);
      assert.equal(green.ledger.lead_monthly_total_minor, cents, control);
      assert.equal(green.ledger.if_own_transfers.monthly_total_minor, cents, control);
      const body = await answer({type: 'monthly', kind, rows: series(description)});
      if (possibleLoanChannels.has(description)) possibleLoanContract(body, series(description), cents);
      else {
      assert.equal(body.ledger.monthly_total_minor, null, description);
      assert.equal(body.ledger.lead_monthly_total_minor, null, description);
      assert.equal(body.ledger.if_own_transfers.monthly_total_minor, null, description);
      assert.equal(body.ledger.recurring.length, 0, description);
      assert.equal(body.ledger.possible_owned_movements.length, 3, description);
      assert.equal(body.ledger.complete, false, description);
      assert.deepEqual(body.ledger.possible_owned_movements.map(r => [r.posted_on, r.amount_minor]).sort(),
        series(description).map(r => [r.date, cents]).sort());
      }
      reviewCases += 2;
    }
  }
  for (const [kind, description] of [['savings', 'Loan autopay'], ['loan', 'Credit card autopay']]) {
    const rows = ['08', '09', '10'].map((m, n) => ({id: n + 1, date: '2026-' + m + '-07',
      cents: '1999', direction: 'outflow', payee: 'Cloud Suite', description}));
    const body = await answer({type: 'monthly', kind, rows});
    if (description === 'Loan autopay') possibleLoanContract(body, rows, 1999);
    else assert.equal(body.ledger.monthly_total_minor, 1999, 'structured merchant card control remains a subscription');
    reviewCases++;
  }
  t.diagnostic('review sibling ledgers=' + reviewCases + ' wrong_figures=0');
  const assess = async c => failures(c, await answer(c), await answer(c, true));
  const groups = new Map();
  let wrong = 0, refusals = 0;
  for (const c of generate()) {
    const observed = await assess(c);
    if (observed.some(([kind]) => kind === 'wrong')) wrong++;
    if (observed.some(([kind]) => kind === 'refusal')) refusals++;
    for (const [kind, cause] of observed) {
      const key = `${kind}/${cause}`;
      // Exhaust all subsets in ascending cardinality: globally minimal by row
      // count, not just a greedy one-row deletion minimum. At most six rows.
      let smallest;
      for (let size = 0; size <= c.rows.length && !smallest; size++) {
        for (let mask = 0; mask < 2 ** c.rows.length; mask++) {
          const rows = c.rows.filter((_, n) => mask & (1 << n));
          if (rows.length !== size) continue;
          const candidate = { ...c, rows };
          if ((await assess(candidate)).some(f => f.join('/') === key)) { smallest = rows; break; }
        }
      }
      assert.ok(smallest, `shrink reproduces ${c.id} ${key}`);
      // Normalize equal-price classes to 1, 2, ... cents. For these schedules
      // this reaches the positive-cent minimum (or 1 -> 2 for price drift)
      // without thousands of linear searches over irrelevant dollar amounts.
      const amounts = [...new Set(smallest.map(r => r.cents))].sort((a, b) => Number(minor(a) - minor(b)));
      const tiny = smallest.map(r => ({ ...r, cents: String(amounts.indexOf(r.cents) + 1) }));
      if ((await assess({ ...c, rows: tiny })).some(f => f.join('/') === key)) smallest = tiny;
      const group = groups.get(key) || { count: 0, example: c.id, rows: smallest };
      group.count++;
      if (smallest.length < group.rows.length) { group.example = c.id; group.rows = smallest; }
      groups.set(key, group);
    }
  }
  // Equal amounts and a destination type without exact account identity do
  // not prove the counterpart or authorize a gross-row "included" tag.
  const advisory = generate().find(c => c.type === 'transfer');
  const unresolved = await answer({ ...advisory, rows: advisory.rows.map(row => row.direction === 'inflow'
    ? { ...row, description: 'Unresolved acknowledgement' }
    : { ...row, description: 'Transfer to savings' }) });
  assert.equal(unresolved.ledger.possible_owned_movements.length, 3);
  assert.equal(unresolved.ledger.monthly_total_minor, null);
  assert.equal(unresolved.ledger.complete, false);
  assert.doesNotMatch(unresolved.answer.split('Possible transfers or payments between your own accounts')[1].split('I can show')[0], /included/);
  assert.equal(modelCalls, 0);
  assert.ok(executions >= 1224);
  const result = { cases: generate().length, wrong_figures: wrong, groups: groups.size, over_refusals: refusals,
    executions, failures: Object.fromEntries(groups) };
  t.diagnostic(JSON.stringify(result));
  // New categories must be reviewed; known reds remain visible finder output.
  for (const key of groups.keys()) assert.ok(['wrong/owned-movement', 'refusal/annual', 'refusal/irregular', 'refusal/skipped', 'refusal/amount-drift'].includes(key), key);
  assert.equal(wrong, 0, 'owned movement listed as recurring');
  assert.equal(refusals, 204);
  assert.equal(groups.size, 4);
  // Cadence capability is excluded from this release; keep its 204 omissions pinned above.
  // Strict membership still rejects every wrong figure. A separate opt-in gate exposes cadence work.
  if (process.argv.includes('--strict-properties')) assert.equal(wrong, 0, JSON.stringify(result));
  if (process.argv.includes('--strict-cadence-properties')) assert.equal(wrong + refusals, 0, JSON.stringify(result));
});

test('independent cents and calendar controls', () => {
  assert.equal(total(['1001', '137', '-1']), '1137');
  assert.equal(shift('2026-12-10'), '2027-01-10');
  const annual = generate().find(c => c.type === 'annual');
  assert.equal(gold(annual)[0][3], Number((minor(annual.rows[0].cents) + 6n) / 12n));
  const descriptors = generate().find(c => c.type === 'descriptors');
  assert.equal(gold(descriptors).length, 2);
  assert.deepEqual(gold(generate().find(c => c.type === 'loan')), []);
});

test('shared owned movement predicate: masks, account words in either order, and external controls', () => {
  const accounts = new Map([['a', {account_kind: 'savings', members: [{mask: '5678'}]}], ['b', {account_kind: 'loan', members: [{mask: '9012'}]}]]);
  for (const description of ['Transfer to savings', 'Savings transfer', 'Payment to loan', 'Loan payment', 'Account 5678', 'Payment 9012'])
    assert.equal(isOwnedMovement({description}, accounts), true, description);
  for (const description of ['Service Unit', 'Payment for hosting', 'Invoice 156789', 'Transfer to savings'])
    assert.equal(isOwnedMovement({description}, new Map()), false, description);
  assert.equal(isOwnedMovement({id: 7}, accounts, new Set([7])), true);
  assert.equal(isOwnedMovement({description: 'Payment for hosting'}, accounts), false);
  assert.equal(isOwnedMovement({description: 'Invoice 156789'}, accounts), false);
});

for (const [id, description, loan] of [
  ['M1', 'Cloud Suite invoice 1234', false],
  ['M2', 'Payment for credit monitoring subscription', true],
]) test('review exact ' + id + ': external subscription stays recurring', async t => {
  const f = ledgerFixture(t);
  if (loan) {
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at)
      SELECT 'destination',entity_slug,'loan','liability','5678',feed_mode,provenance,source_feed,basis_state,recorded_at FROM fin_accounts WHERE account_slug='fixture-account'`);
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at)
      SELECT 'destination',coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at FROM fin_account_coverage WHERE account_slug='fixture-account'`);
  }
  for (const month of ['08', '09', '10']) f.add('synthetic-' + month, description, 'Cloud Suite',
    {date: '2026-' + month + '-07', cents: 1999, direction: 'outflow'});
  const body = await f.ask('What do I pay for every month?');
  assert.equal(body.ledger.recurring.length, 1, description);
  assert.equal(body.ledger.monthly_total_minor, 1999, description);
  assert.equal(body.ledger.lead_monthly_total_minor, 1999, description);
  assert.equal(body.ledger.possible_owned_movements.length, 0, description);
});

test('review residual generic repayments remain unresolved owned movements', () => {
  const accounts = new Map([['loan', {account_kind:'loan', mask:'5678'}]]);
  for (const description of ['Loan autopay', 'Automatic loan repayment', 'Mortgage payment', 'Loan pmt', 'Payment to installment account', 'Liability payment', 'Payment to liability account'])
    assert.equal(isOwnedMovement({description}, accounts), true, description);
});

test('account-reference grammar separates service for-clauses and owned-looking rows', () => {
  const accounts = new Map([['loan', {account_kind:'loan', mask:'5678'}], ['checking', {account_kind:'checking', mask:'1234'}]]);
  for (const description of ['Credit monitoring payment', 'Payment for hosting; invoice 5678'])
    assert.equal(isOwnedMovement({description, payee: 'Service Unit'}, accounts), false, description);
  for (const description of ['Invoice account reconciliation 1234', 'Card account 1234', 'Loan monthly payment', 'Payment toward mortgage', 'Transfer to account ending in 5678', 'Account xxxx5678', 'Loan repayment', 'Payment for loan', 'Payment for loan account ending in 5678'])
    assert.equal(isOwnedMovement({description}, accounts), true, description);
});

test('mask references retain locator syntax and fail closed on owned account nouns', () => {
  // Owned masks fail closed even when a stated kind conflicts. A separate
  // external payee can prove that an invoice/reference number is coincidental.
  const accounts = new Map([['checking', {account_kind:'checking', mask:'1234'}], ['loan', {account_kind:'loan', mask:'5678'}]]);
  for (const description of ['Loan acct no. 5678', 'Loan account number 5678', 'Account ending in 5678', 'xxxx5678', '****5678', 'Loan account ****5678', 'Deposit account number 1234', 'Liability account number 5678', 'Deposit account number 5678', 'Liability account number 1234', 'Card account number 1234', 'Credit card ****1234', 'Card account xxxx1234'])
    assert.equal(isOwnedMovement({description}, accounts), true, description);
  for (const description of ['Card account number 9876', 'Invoice no. 5678', 'Cloud Suite reference 1234'])
    assert.equal(isOwnedMovement({description, payee: 'Service Unit'}, accounts), false, description);
});

test('MAIN any-order rule remains fail closed across intervening bank wording', () => {
  const accounts = new Map([['loan', {account_kind:'loan', mask:'5678'}], ['savings', {account_kind:'savings', mask:'9012'}]]);
  for (const description of ['Loan principal repayment', 'Savings scheduled periodic xfer', 'Payment scheduled toward mortgage'])
    assert.equal(isOwnedMovement({description}, accounts), true, description);
  for (const description of ['Payment for loan monitoring subscription', 'Payment for savings advice subscription'])
    assert.equal(isOwnedMovement({description, payee: 'Service Unit'}, accounts), false, description);
});


// Independent membership gold: service subjects have an external payee;
// account targets stay unresolved even without a familiar movement verb.
test('R2 service subjects and fail-closed targets', async t => {
  const next = random(0x72d0427);
  const cases = [
    ['loan monitoring subscription payment', 9065, false],
    ['liability insurance membership autopay', 7734, false],
    ...['loan', 'mortgage', 'liability', 'installment account'].flatMap(noun =>
      ['monitoring subscription', 'insurance membership', 'protection subscription', 'forecast membership'].flatMap(service => [
        [noun + ' ' + service + ' autopay', 1 + next() % 9000, false],
        ['Payment for our ' + noun, 1 + next() % 9000, true],
        [noun + ' scheduled allocation', 1 + next() % 9000, true],
      ])),
    ['Routing allocation 5678', 2461, true],
    ['5678 scheduled allocation', 3891, true],
    ['Reserve allocation 5678', 1823, true],
    ['Service Unit invoice 1234', 2461, false],
    ['Service Unit reference 5678', 3891, false],
    ['Service Unit invoice no. 5678', 1823, false],
    ['Payment for the loan', 3655, true],
    ['Payment for our loan', 47, true],
    ['Loan monitoring subscription payment; account 5678', 2071, true],
    ['Loan monitoring subscription payment', 1907, true, ''],
    ['Loan monitoring subscription payment', 1908, true, 'Loan account 5678'],
  ];
  for (const [description, cents, owned, payee = 'Service Unit'] of cases) {
    await t.test(description + '/' + cents, async t => {
      const f = ledgerFixture(t);
      f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at)
        SELECT 'destination',entity_slug,'loan','liability','5678',feed_mode,provenance,source_feed,basis_state,recorded_at FROM fin_accounts WHERE account_slug='fixture-account'`);
      f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at)
        SELECT 'destination',coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at FROM fin_account_coverage WHERE account_slug='fixture-account'`);
      for (const month of ['08', '09', '10']) f.add('synthetic-' + month, description, payee,
        {date: '2026-' + month + '-07', cents, direction: 'outflow'});
      const {ledger} = await f.ask('What do I pay for every month?');
      const exactPayment = payee === 'Loan account 5678';
      for (const actual of [ledger.monthly_total_minor, ledger.lead_monthly_total_minor, ledger.if_own_transfers.monthly_total_minor])
        assert.equal(actual, exactPayment ? 0 : owned ? null : cents, description);
      assert.equal(ledger.recurring.length, owned ? 0 : 1);
      assert.equal(ledger.possible_owned_movements.length, owned && !exactPayment ? 3 : 0);
      if (exactPayment) {
        assert.equal(ledger.payment_exclusions.count, 3);
        assert.equal(ledger.payment_exclusions.total_minor, 3 * cents);
        assert.deepEqual(ledger.payment_exclusions.rows.map(r => [r.posted_on, r.amount_minor]).sort(),
          ['08', '09', '10'].map(month => ['2026-' + month + '-07', cents]));
      } else if (owned) {
        assert.equal(ledger.complete, false);
        assert.deepEqual(ledger.possible_owned_movements.map(r => [r.posted_on, r.amount_minor]).sort(),
          ['08', '09', '10'].map(month => ['2026-' + month + '-07', cents]));
      }
    });
  }
  t.diagnostic('R2 ledgers=' + cases.length + ' wrong_figures=0');
});

test('R2 text-only charge exclusions apply to outflows, not customer receipts', () => {
  const accounts = new Map([['checking', {account_kind: 'checking', mask: '1111'}]]);
  for (const description of ['Fixture client deposit', 'Customer deposit allocation', 'Deposit scheduled allocation']) {
    assert.equal(isOwnedMovement({description, direction: 'inflow'}, accounts), false, description);
    assert.equal(isOwnedMovement({description, direction: 'outflow'}, accounts), true, description);
  }
  assert.equal(isOwnedMovement({id: 9, direction: 'inflow'}, accounts, new Set([9])), true);
});
