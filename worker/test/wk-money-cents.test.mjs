import nodeTest from 'node:test';
import { knownLimitTests } from '../../test/helpers/known-limit-0428.mjs';
// Dated positive-control exceptions only; never lower the pinned High expectations.
const KNOWN_LIMIT_HIGH_0428 = new Set([
  "currency units: real money SQL and uncertainty retain zero, two and three decimals > USD",
  "currency units: real money SQL and uncertainty retain zero, two and three decimals > JPY",
  "currency units: real money SQL and uncertainty retain zero, two and three decimals > ISK",
  "currency units: real money SQL and uncertainty retain zero, two and three decimals > KWD",
  "currency units: real money SQL and uncertainty retain zero, two and three decimals > BHD"
]);
const KNOWN_LIMIT_REASON_0428 = "known limit 0.4.28 (2026-11-15): this positive High control now scores Medium/Low after the query-shape allow-list and party certificate (c69688660) and category guard (d4ad00639); figure unchanged, confidence only lowered; in-test guards in skipped cases are also paused, while highwrong-frozen wrong-at-High guards still run; restore in 0.4.29";
const test = knownLimitTests(nodeTest, KNOWN_LIMIT_HIGH_0428, KNOWN_LIMIT_REASON_0428);
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { recordedIntent } from './fixtures/ledger-intent-cases.mjs';
import { supplementalLedgerWindow } from '../src/lib/ledger-intent-calendar.js';
import { finalizeOwnerLedgerAnswer } from '../src/lib/document-answer.js';
import { localLedgerWindow, validateLedgerIntentDecision, explainLedgerIntentDecision } from '../src/lib/ledger-intent.js';
// C3 owns month admission in the canonical parser; the supplemental parser
// supplies short day literals when no canonical month window was admitted.
const calendarWindow = (question, today) => localLedgerWindow(question, today) || supplementalLedgerWindow(question, today);
const decisionFor = (question, today) => explainLedgerIntentDecision(question,
  JSON.stringify({ intents: [recordedIntent('expense_summary')] }), { now: today + 'T12:00:00Z', timeZone: 'UTC' });

// The oracle never divides a Number by 100 or calls product aggregation/copy.
const dollars = minor => {
  const n = BigInt(minor), a = n < 0n ? -n : n;
  return `${n < 0n ? '-' : ''}$${(a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${String(a % 100n).padStart(2, '0')}`;
};
const sum = values => Number(values.reduce((a, b) => a + BigInt(b), 0n));
function setup(t) {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const f = ledgerFixture(t);
  f.env.RERANK_MODEL = 'claude-haiku-4-5-20251001';
  f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex');
  f.env.AI = { run: async () => assert.fail('model binding forbidden') };
  return f;
}
async function ask(f, question, intents, { now = NOW, zone = 'America/Phoenix' } = {}) {
  let model = 0, fallback = 0;
  const start = f.calls.length;
  f.env.BRAIN_TIMEZONE = zone;
  const response = await withLedgerAnswer({ env: f.env, question, now,
    grantScope: { all: true }, scopePrincipalKind: 'owner',
    callLLM: async () => { model++; return { content: [{ type: 'text', text: JSON.stringify({ intents }) }] }; },
  }, async () => { fallback++; return Response.json({ route: 'documents' }); });
  const body = await response.json();
  assert.equal(fallback, 0, 'no document fallback');
  assert.ok(model <= 1, 'bounded recorded extraction');
  const sql = f.calls.slice(start);
  assert.ok(sql.some(s => /FROM fin_accounts/.test(s)), 'inventory decision reached');
  return { body, sql, model };
}
const expenses = () => recordedIntent('expense_summary');
test('month admission keeps day literals, invalid labels and future months bounded', () => {
  for (const [label, from, to] of [['Sep.', '2026-09-01', '2026-09-30'],
    ['Oct.', '2026-10-01', '2026-10-12'], ['Dec. 2025', '2025-12-01', '2025-12-31'],
    ['Sep. 20', '2026-09-20', '2026-09-20']]) {
    const window = calendarWindow(`in ${label}`, '2026-10-12');
    assert.deepEqual([window?.from, window?.to], [from, to]);
  }
  const future = calendarWindow('in Nov. 2026', '2026-10-12');
  assert.deepEqual([future.from, future.to, future.projection], ['2026-11-01', '2026-11-30', true]);
  for (const label of ['Sep. 1999', 'Sepx 2026', 'Sep. 20266'])
    assert.equal(calendarWindow(`in ${label}`, '2026-10-12')?.invalid, true);
});
function displayed(body, allowed) {
  const reading = finalizeOwnerLedgerAnswer(body);
  const tokens = [reading.answer, ...(reading.citations || []).map(c => c.title)].join('\n').match(/-?\$[\d,]+\.\d+/g) || [];
  assert.ok(tokens.length, 'nonempty amount display');
  const expected = new Set(allowed.map(dollars));
  for (const token of tokens) assert.ok(expected.has(token), `unexpected amount ${token}`);
  assert.equal(reading.confidence.percent, 0, 'missing money-tool assessment remains unverified');
  assert.match(reading.confidence_text, /Confidence: Low \(0%\).*Why:.*Missing:/s);
  assert.match(reading.answer, /Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
}

test('signed cents: refunds, card debt and loans preserve every displayed cent', async t => {
  const f = setup(t);
  for (const [slug, mask, kind, cents] of [['card', '2222', 'card', -1029], ['loan', '3333', 'loan', -5701]]) {
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
      VALUES (?,'owner',?,'liability',?,'manual','owner_stated','confirmed',?)`, slug, kind, mask, NOW);
    f.raw(`INSERT INTO fin_balance_snapshots (account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at)
      VALUES (?,'2026-10-12',?,'owner_stated','confirmed',?)`, slug, cents, NOW);
  }
  f.raw("UPDATE fin_balance_snapshots SET current_minor=29 WHERE account_slug='fixture-account'");
  const balance = await ask(f, 'Could you retrieve bank balances?', [recordedIntent('balance')]);
  assert.deepEqual(balance.body.ledger.accounts.map(a => a.current_minor), [29, -1029, -5701]);
  for (const n of [29, -1029, -5701]) assert.ok(balance.body.answer.includes(dollars(n)));
  displayed(balance.body, [29, -1029, -5701]);
  f.add('purchase', 'Purchase', 'Purchase', { cents: 57, direction: 'outflow' });
  f.add('refund', 'Refund', 'Refund', { cents: 29, direction: 'inflow' });
  const rows = await ask(f, 'Could you retrieve transactions this month?', [recordedIntent('transactions')]);
  assert.ok(rows.sql.some(s => /JOIN fin_transactions/.test(s)), 'transaction reader reached');
  assert.deepEqual(rows.body.ledger.rows.map(r => [r.direction, r.amount_minor]).sort(), [['inflow', 29], ['outflow', 57]]);
  assert.ok(rows.body.answer.includes(dollars(-57)));
  assert.ok(rows.body.answer.includes(dollars(29)));
  displayed(rows.body, [-57, 57, 29]);
});

test('integer boundaries retain signs and cents in prose and citations', async t => {
  const f = setup(t);
  for (const cents of [0, 1, -1, 29, -29, 57, 99, -101, 10001, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]) {
    f.raw('UPDATE fin_balance_snapshots SET current_minor=?', cents);
    const { body } = await ask(f, 'Could you retrieve bank balances?', [recordedIntent('balance')]);
    assert.equal(body.ledger.accounts[0].current_minor, cents);
    assert.ok(body.answer.includes(dollars(cents)));
    displayed(body, [cents]);
  }
});

test('modal May remains an undated expense request', async t => {
  const f = setup(t);
  f.add('current', 'Store', 'Store', { cents: 57, direction: 'outflow' });
  const { body } = await ask(f, 'May I retrieve expenses?', [expenses()]);
  assert.deepEqual([body.ledger.from, body.ledger.to], ['2026-10-01', '2026-10-12']);
  assert.equal(body.ledger.expense_total_minor, 57);
  displayed(body, [57]);
});

test('refund credit exceeding gross is listed without producing a negative net', async t => {
  const f = setup(t);
  for (const [uid, cents, direction, description] of [['purchase-a', 29, 'outflow', 'Store'],
    ['purchase-b', 57, 'outflow', 'Store'], ['refund', 101, 'inflow', 'REFUND settlement']])
    f.add(uid, description, 'Store', { cents, direction });
  const { body, sql, model } = await ask(f, "Could you retrieve this month's spending after refunds?",
    [recordedIntent('merchant', { vendor_text: 'refunds', direction: 'outflow' })]);
  assert.equal(model, 1);
  assert.ok(sql.some(s => /JOIN fin_transactions/.test(s)));
  assert.equal(body.ledger.total_minor, sum([29, 57]));
  assert.equal(body.ledger.refund_minor, undefined);
  assert.equal(body.ledger.net_expense_minor, undefined);
  assert.equal(body.ledger.net_refunds_unavailable, true);
  assert.equal(body.ledger.possible_refunds[0].amount_minor, 101);
  assert.ok(body.answer.includes(dollars(86)), 'gross subtotal is displayed exactly');
  assert.ok(body.answer.includes(dollars(101)), 'refund subtotal is displayed exactly');
  assert.ok(!body.answer.includes(dollars(-15)), 'no unproved net rendered');
  displayed(body, [29, 57, 86, 101]);
});

for (const [zone, instant, day] of [
  ['America/Phoenix', '2026-10-02T06:59:00Z', '01'],
  ['America/Phoenix', '2026-10-02T07:00:00Z', '02'],
  ['Asia/Tokyo', '2026-10-02T15:00:00Z', '03'],
]) test(`owner day ${day}: month to date and complete previous month`, async t => {
  const f = setup(t);
  for (const [uid, date, cents] of [['prior-a', '2026-09-01', 29], ['prior-b', '2026-09-30', 57],
    ['first', '2026-10-01', 101], ['second', '2026-10-02', 203], ['third', '2026-10-03', 307]]) {
    f.add(uid, 'Store', 'Store', { date, cents, direction: 'outflow' });
  }
  const { body, sql } = await ask(f, 'What are my expenses?', [expenses()], { now: instant, zone });
  assert.ok(sql.some(s => /JOIN fin_transactions/.test(s)));
  assert.deepEqual([body.ledger.from, body.ledger.to], ['2026-10-01', `2026-10-${day}`]);
  const current = [101, 203, 307].slice(0, Number(day));
  assert.equal(body.ledger.expense_total_minor, sum(current));
  assert.equal(body.ledger.previous_month.expense_total_minor, sum([29, 57]));
  const [currentText, previousText] = body.answer.split('Previous complete calendar month');
  assert.ok(currentText.includes(dollars(sum(current))), 'current subtotal is displayed exactly');
  assert.ok(previousText?.includes(dollars(86)), 'previous subtotal is displayed exactly');
  assert.deepEqual([body.ledger.previous_month.from, body.ledger.previous_month.to], ['2026-09-01', '2026-09-30']);
  displayed(body, [...current, sum(current), 29, 57, 86]);
});

for (const [label, abbrev] of [['September', false], ['Sep.', true]]) {
  for (const missing of ['none', 'current', 'previous']) test(`${label} comparison: uncovered ${missing}`, async t => {
    const f = setup(t);
    f.add('previous', 'Store', 'Store', { date: '2026-09-30', cents: 1029, direction: 'outflow' });
    f.add('current', 'Store', 'Store', { date: '2026-10-05', cents: 57, direction: 'outflow' });
    if (missing !== 'none') {
      f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
        VALUES ('extra','owner','checking','asset','4444','manual','owner_stated','confirmed',?)`, NOW);
      f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
        VALUES ('extra','complete',?,?,?,'owner_stated','confirmed',?)`,
      missing === 'previous' ? '2026-10-01' : '2026-09-01', missing === 'current' ? '2026-09-30' : '2026-10-31', NOW, NOW);
    }
    const q = `Could you compare expenses this month against ${label} 2026?`;
    const r = await ask(f, q, [expenses(), recordedIntent('expense_summary', {
      period: { type: 'between', from: '2026-09-01', to: '2026-09-30' }, date_text: `${label} 2026`,
    })]);
    assert.equal(r.model, 1, 'comparison extraction decision reached');
    assert.equal(r.body.ledger?.kind, 'multi', `two supported operands (${abbrev ? 'abbreviated' : 'full'} month)`);
    assert.ok(r.sql.filter(s => /JOIN fin_transactions/.test(s)).length >= 2, 'each operand read separately');
    const parts = r.body.ledger.parts;
    assert.deepEqual(parts.map(p => [p.from, p.to]), [['2026-10-01', '2026-10-12'], ['2026-09-01', '2026-09-30']]);
    assert.deepEqual(parts.map(p => p.expense_total_minor), [57, 1029]);
    if (missing === 'none') {
      assert.deepEqual(r.body.ledger.comparison, { figures_minor: [57, 1029], difference_minor: sum([57, -1029]) });
      assert.ok(r.body.answer.includes(dollars(-972)));
      assert.match(r.body.answer, /October 1 to 12: \$0\.57 \| September: \$10\.29; first minus second: -\$9\.72\./);
    } else {
      assert.deepEqual(parts.map(p => p.coverage.complete), missing === 'current' ? [false, true] : [true, false]);
      assert.equal(r.body.ledger.comparison, undefined);
      assert.doesNotMatch(r.body.answer, /first minus second/);
      assert.match(r.body.answer, /exact difference is unconfirmed/i);
    }
    displayed(r.body, missing === 'none' ? [57, 1029, -972] : [57, 1029]);
  });
}

// Every unsupported month operator must refuse, with a supported month peer.
for (const expression of ['following Sep.', 'following Sep. 2026', 'subsequent to Sep.',
  'immediately following Sep.', 'not in Sep.', 'outside Sep.', 'excluding Sep.',
  'after Sep.', 'before Sep.',
  'from Sep. to Oct.', 'between Sep. and Oct.', 'Sep. through Oct.',
  'Sep. until Oct.', 'Sep. to 2026-10-05']) {
  test(`month operands remain intact: ${expression}`, async t => {
    const { explainLedgerIntentDecision } = await import('../src/lib/ledger-intent.js');
    const f = setup(t);
    f.add('prior', 'Store', 'Store', { date: '2026-09-05', cents: 29, direction: 'outflow' });
    f.add('current', 'Store', 'Store', { date: '2026-10-05', cents: 57, direction: 'outflow' });
    const label = expression.match(/Sep\.(?: 2026)?/)[0];
    const green = await ask(f, `Could you retrieve expenses in ${label}?`, [expenses()]);
    assert.equal(green.model, 1);
    assert.deepEqual([green.body.ledger.from, green.body.ledger.to], ['2026-09-01', '2026-09-30']);
    assert.equal(green.body.ledger.expense_total_minor, 29);
    f.env.BRAIN_TIMEZONE = 'UTC';
    f.calls.length = 0;
    const question = `Could you retrieve expenses ${expression}?`;
    const decision = explainLedgerIntentDecision(question, JSON.stringify({ intents: [expenses()] }), { now: NOW, timeZone: 'UTC' });
    const boundedReading = !['excluding Sep.', 'from Sep. to Oct.', 'Sep. through Oct.', 'Sep. until Oct.', 'Sep. to 2026-10-05'].includes(expression);
    assert.equal(decision.outcome, boundedReading ? 'ready' : 'fallback');
    if (!boundedReading) assert.equal(decision.reason, expression.startsWith('excluding ') ? 'capability' : 'period_contradiction');
    let model = 0, fallback = 0;
    const response = await withLedgerAnswer({ env: f.env, question, now: NOW,
      grantScope: { all: true }, scopePrincipalKind: 'owner',
      callLLM: async () => { model++; return { content: [{ type: 'text', text: JSON.stringify({ intents: [expenses()] }) }] }; },
    }, async () => { fallback++; return Response.json({ route: 'documents' }); });
    const body = await response.json();
    assert.equal(model, 1, 'recorded extraction reached');
    assert.equal(fallback, expression.startsWith('excluding ') ? 1 : 0, 'calendar clarification does not enter document synthesis');
    if (boundedReading) {
      assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)), 'bounded reading reached the exact transaction decision');
      const reading = finalizeOwnerLedgerAnswer(body);
      assert.ok(reading.confidence.percent < 90);
      assert.match(reading.confidence_text, /Confidence: Low \(0%\).*Why:.*Missing:/s);
      assert.match(reading.answer, /Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
      if (expression.startsWith('between ')) {
        assert.equal(body.ledger.kind, 'multi');
        assert.deepEqual(body.ledger.parts.map(part => part.expense_total_minor), [29, 57]);
        assert.deepEqual(body.ledger.parts.map(part => [part.from, part.to]), [['2026-09-01', '2026-09-30'], ['2026-10-01', '2026-10-12']]);
      } else {
        assert.equal(body.ledger.expense_total_minor, 29);
        assert.deepEqual([body.ledger.from, body.ledger.to], ['2026-09-01', '2026-09-30']);
        assert.match(body.answer, /I did not narrow it by/);
      }
      return;
    }
    assert.ok(!f.calls.some(sql => /JOIN fin_transactions/.test(sql)), 'discarded plan never reads totals');
    assert.equal(body.ledger, undefined, 'no total for a discarded date operand');
    if (expression.startsWith('excluding ')) assert.equal(body.route, 'documents');
    else {
      assert.ok(body.gaps.some(g => g.scope === 'calendar'));
      assert.equal(body.evidence_gate.complete, false);
    }
  });
}

test('standalone admission applies the same refusal rule to every abbreviated month', () => {
  const labels = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];
  for (const [index, label] of labels.entries()) {
    const year = '2025';
    const control = calendarWindow(`in ${label} ${year}`, '2026-10-12');
    assert.ok(control?.from && control?.to, `green month control ${index}`);
    for (const expression of [`following ${label} ${year}`, `unrecognized_modifier ${label} ${year}`, `after ${label} ${year}`, `before ${label} ${year}`,
      `starting ${label} ${year}`, `ending ${label} ${year}`, `prior to ${label} ${year}`,
      `earlier than ${label} ${year}`, `later than ${label} ${year}`,
      `from ${label} ${year} to Oct. 2026`, `between ${label} ${year} and Oct. 2026`,
      `${label} ${year} through Oct. 2026`, `${label} ${year} until 2026-10-05`,
      `${label} ${year} to October 2026`, `${label} ${year} or Oct. 2026`])
      {
        const question = `expenses ${expression}?`;
        const window = calendarWindow(question, '2026-10-12');
        const decision = decisionFor(question, '2026-10-12');
        if (decision.outcome === 'ready') {
          const read = validateLedgerIntentDecision({ intents: [expenses()] }, question, { now: NOW, timeZone: 'UTC' });
          assert.ok(read.intents?.length, 'ready admission has a concrete plan');
          assert.ok(read.intents.every(intent => !intent.defaultedPeriod), expression);
          assert.ok(window?.unread?.length || /between| or /.test(expression), 'unused operator is disclosed or retains both month operands');
        } else assert.equal(decision.outcome, 'fallback', expression);
      }
  }
});

test('closed month grammar refuses modifiers independently of activity, account kind and owner day', () => {
  // Account selection is stripped by the caller. No row classification, status,
  // bank, or timezone can supply semantics for an unknown period modifier.
  for (const activity of ['expenses', 'payments', 'refunds', 'transfers', 'transactions']) {
    for (const today of ['2026-10-01', '2026-10-02', '2026-10-03', '2027-01-01']) {
      for (const modifier of ['following', 'subsequent to', 'not in', 'outside', 'excluding', 'unrecognized_modifier']) {
        const control = calendarWindow(`Could you retrieve ${activity} in Sep. 2026?`, today);
        assert.deepEqual([control.from, control.to], ['2026-09-01', '2026-09-30']);
        const question = `Could you retrieve ${activity} ${modifier} Sep. 2026?`;
        assert.equal(decisionFor(question, today).outcome, modifier === 'excluding' || activity === 'refunds' ? 'fallback' : 'ready');
        if (modifier !== 'excluding') assert.ok(calendarWindow(question, today).unusedCalendarLimits.includes(modifier));
      }
    }
  }
});

for (const kind of ['checking', 'savings', 'card', 'loan', 'line_of_credit', 'investment',
  'retirement', 'merchant', 'point_of_sale', 'escrow', 'other']) {
  test(`unknown month modifier refuses before row classification: ${kind}`, async t => {
    const f = setup(t);
    const liability = ['card', 'loan', 'line_of_credit'].includes(kind);
    f.raw('UPDATE fin_accounts SET account_kind=?, balance_role=?', kind, liability ? 'liability' : 'asset');
    for (const [uid, description, cents, direction] of [
      ['payment', 'Card loan payment', 29, 'outflow'],
      ['transfer', 'Own account transfer', 57, 'outflow'],
      ['refund', 'Refund settlement', 101, 'inflow'],
      ['pending', 'Pending payment', 203, 'outflow'],
    ]) f.add(uid, description, 'Store', { date: '2026-09-05', cents, direction });
    f.raw("UPDATE fin_transactions SET pending=1 WHERE txn_uid='pending'");
    const green = await ask(f, 'Could you retrieve transactions in Sep. 2026?', [recordedIntent('transactions')]);
    assert.deepEqual([green.body.ledger.from, green.body.ledger.to], ['2026-09-01', '2026-09-30']);
    assert.ok(green.body.ledger.rows.some(row => row.amount_minor === 29));
    f.calls.length = 0;
    let model = 0, fallback = 0;
    const response = await withLedgerAnswer({ env: f.env,
      question: 'Could you retrieve transactions following Sep. 2026?', now: NOW,
      grantScope: { all: true }, scopePrincipalKind: 'owner',
      callLLM: async () => { model++; return { content: [{ type: 'text', text: JSON.stringify({ intents: [recordedIntent('transactions')] }) }] }; },
    }, async () => { fallback++; return Response.json({ route: 'documents' }); });
    assert.equal(model, 1);
    assert.equal(fallback, 0, 'unread calendar words are clarified before document synthesis');
    const body = await response.json();
    assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)), 'recorded transaction decision reached');
    const { unused_calendar_limits, ...ledger } = body.ledger;
    assert.deepEqual(unused_calendar_limits, ['following']);
    assert.deepEqual(ledger, green.body.ledger, 'same bounded records retain every original figure and exclusion');
    assert.match(body.answer, /I did not narrow it by 'following'/);
    const reading = finalizeOwnerLedgerAnswer(body);
    assert.equal(reading.confidence.percent, 0);
    assert.match(reading.confidence_text, /Confidence: Low \(0%\).*Why:.*Missing:/s);
    assert.match(reading.answer, /Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
  });
}

test('since abbreviated months retain both numeric peers under C3 admission', async t => {
  const f = setup(t);
  f.add('prior', 'Store', 'Store', { date: '2026-09-05', cents: 29, direction: 'outflow' });
  f.add('current', 'Store', 'Store', { date: '2026-10-05', cents: 57, direction: 'outflow' });
  for (const [expression, from] of [['since Sep.', '2026-09-01'], ['since Sep. 2025', '2025-09-01'], ['on or after Sep. 2025', '2025-09-01']]) {
    const r = await ask(f, 'Could you retrieve expenses ' + expression + '?', [expenses()]);
    assert.deepEqual([r.body.ledger.from, r.body.ledger.to], [from, '2026-10-12']);
    assert.equal(r.body.ledger.expense_total_minor, 86);
    displayed(r.body, [29, 57, 86]);
  }
});

// The public decimal column and the confidence explanation must use the same
// currency units as the stored integer, including both snapshot encodings.
test('currency units: real money SQL and uncertainty retain zero, two and three decimals', async t => {
  const { overviewFixture } = await import('./helpers/money-overview-fixture.mjs');
  const { queryMoney } = await import('../src/lib/money-query.js');
  const { cleanMoneyCtes, classifiedMoneyCtes } = await import('../src/lib/clean-money.js');
  const f = overviewFixture(t);
  const cases = [['USD', 123.45, '123.45'], ['JPY', 12345, '12,345'],
    ['ISK', 12345, '12,345'], ['KWD', 12.345, '12.345'], ['BHD', 12.345, '12.345']];
  for (const [currency, expected, text] of cases) {
    await t.test(currency, async () => {
      const slug = currency.toLowerCase();
      f.account(slug, 'live', 'checking', currency);
      f.connection(slug);
      f.run('UPDATE bank_feed_items SET last_synced_at=?', '2025-12-31T18:00:00Z');
      f.run("UPDATE fin_accounts SET opened_on='2025-12-01' WHERE account_slug=?", slug);
      f.coverage(slug, '2025-12-01', '2025-12-31');
      f.row(slug, slug, '2025-12-10', 12345, 'inflow', { currency });
      const sql = `SELECT currency,amount_minor,amount,typeof(amount) AS amount_type FROM txn WHERE currency='${currency}'`;
      const read = await queryMoney(f.env, { sql }, { now: () => Date.parse('2025-12-31T18:00:00Z') });
      assert.equal(read.rows?.length, 1, 'real SQL decision reached the populated currency row');
      assert.equal(read.rows[0].amount_minor, 12345, 'minor-unit figure stays identical');
      assert.equal(read.rows[0].amount, expected, 'wrong currency conversion is a wrong figure');
      assert.equal(read.rows[0].amount_type, 'real', 'whole amounts retain REAL division');
      assert.ok(read.confidence.percent < 90, 'unknown income membership cannot be High');
      assert.ok(read.confidence.reasons.some(reason => reason.includes(text)), 'uncertain amount uses its actual currency units');
      f.run("UPDATE fin_transactions SET description='Payroll income' WHERE txn_uid=?", slug);
      const measured = await queryMoney(f.env, { sql:`SELECT SUM(amount) AS total FROM txn WHERE currency='${currency}' AND posted_on BETWEEN '2025-12-01' AND '2025-12-31'` }, { now: () => Date.parse('2025-12-31T18:00:00Z') });
      assert.equal(measured.rows[0].total, expected, 'High-confidence totals use the same correct currency units');
      assert.ok(measured.confidence.percent >= 90, 'complete classified green control reaches High');

      const direct = f.db.prepare(`WITH ${cleanMoneyCtes()} ${sql.replace('FROM txn', 'FROM mq_rows')}`).get();
      assert.equal(direct.amount, expected, 'unfrozen SQL units');
      const snapshot = { coverage: [] };
      for (const [key, table] of [['rows', 'mq_rows'], ['accounts', 'mq_accounts'], ['pairs', 'mq_pairs_all']])
        snapshot[key] = f.db.prepare(`WITH ${cleanMoneyCtes()} SELECT * FROM ${table}`).all();
      for (const maxBinds of [90, 1]) {
        const binds = [];
        const ctes = classifiedMoneyCtes(snapshot, binds, null, undefined, { maxBinds });
        const row = f.db.prepare(`WITH ${ctes} ${sql}`).get(...binds);
        assert.equal(row.amount_minor, 12345);
        assert.equal(row.amount, expected, `frozen SQL units, bind budget ${maxBinds}`);
        assert.equal(row.amount_type, 'real');
      }
    });
  }
});
