import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
const reader = await import(process.env.NAMED_ZERO_READER || '../src/lib/ledger-answer.js');

const dates = ['2026-07-07', '2026-08-08', '2026-09-09', '2026-10-05'];
const names = ['July', 'August', 'September', 'October'];
const monthlyQuestion = 'Could you retrieve charges at Store Unit month by month since July?';
const money = n => '$' + (n / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function setup(t) {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  t.mock.method(Date, 'now', () => Date.parse(NOW));
  f.env.RERANK_MODEL = 'claude-haiku-4-5-20251001';
  f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex');
  f.put = (id, cents, { date = dates[3], possible = false, kind = 'ordinary' } = {}) => {
    f.add(id, `Store Unit ${kind === 'refund' ? 'refund of purchase' : kind === 'ordinary' ? 'purchase' : 'payment'}`,
      possible ? null : 'Store Unit', { cents, date, direction: kind === 'refund' ? 'inflow' : 'outflow' });
    const category = kind === 'card' ? 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' : kind === 'loan' ? 'LOAN_PAYMENTS' : kind === 'refund' ? 'REFUND' : 'GENERAL_SERVICES';
    f.raw('UPDATE fin_transactions SET category=?,category_basis_state=? WHERE txn_uid=?', category, 'confirmed', id);
  };
  f.read = async (position, monthly, options = {}) => {
    const start = f.calls.length, changes = f.first('SELECT total_changes() n').n;
    let models = 0;
    const response = await reader.withLedgerAnswer({ env: f.env, now: NOW, grantScope: { all: true }, scopePrincipalKind: 'owner',
      question: options.question || (monthly ? monthlyQuestion : `Could you retrieve charges at Store Unit in ${names[position]} 2026?`),
      callLLM: async () => {
        models++;
        return { content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null, intents: [{
          kind: 'merchant', direction: 'outflow', vendor_text: 'Store Unit', count: null, account_hint: null,
          amount_text: null, date_text: null, period: { type: 'none' }, ...options.intent,
        }] }) }] };
      },
    }, () => assert.fail('document fallback'));
    const body = await response.json();
    assert.ok(body.ledger, 'real ledger decision reached');
    assert.equal(models, options.literal ? 0 : 1, 'interpretation decision reached');
    assert.ok(f.calls.slice(start).some(sql => /JOIN fin_transactions/.test(sql)), 'transaction SQL reached');
    assert.ok(f.first('SELECT count(*) n FROM fin_transactions').n > 0, 'nonempty decision pool');
    assert.equal(f.first('SELECT total_changes() n').n, changes, 'answer stays read-only');
    if (monthly) assert.equal(body.ledger.months.length, 4, 'month composition reached');
    return body;
  };
  return f;
}
const scopeOf = (body, position, monthly) => monthly ? body.ledger.months[position] : body.ledger;
function scopeText(body, scope, monthly) {
  if (!monthly) return body.answer;
  const start = body.answer.indexOf(scope.label + ':');
  assert.ok(start >= 0, 'month text reached');
  const next = body.ledger.months.find(month => month.from > scope.to);
  return body.answer.slice(start, next ? body.answer.indexOf(next.label + ':', start) : undefined);
}
function keptEvidence(body, scope, monthly) {
  const text = scopeText(body, scope, monthly);
  for (const row of scope.payment_exclusions?.rows || []) {
    const ref = body.citations.find(ref => ref.n === row.n);
    assert.ok(ref, 'itemized payment citation retained');
    assert.equal(ref.amount_minor, row.amount_minor);
    assert.equal(ref.posted_on, row.posted_on);
    assert.ok(text.includes(`[${row.n}]`), 'payment text retains citation');
    assert.ok(text.includes(money(row.amount_minor)), 'itemized payment amount retained');
  }
  for (const row of scope.refund_rows || []) {
    assert.equal(body.citations.find(ref => ref.n === row.n)?.amount_minor, row.amount_minor);
    assert.ok(text.includes(`[${row.n}]`), 'proven refund citation retained');
    assert.ok(text.includes(money(scope.refunds_received_minor)), 'proven refund amount retained');
  }
}
function unconfirmed(body, scope, monthly) {
  assert.equal(scope.total_minor, null, 'uncertain attribution cannot certify zero');
  assert.equal(scope.complete, false);
  if (monthly) assert.equal(scope.subtotal_minor, null);
  else {
    assert.equal(body.evidence_gate.complete, false);
    assert.notEqual(scope.lead_total_minor, 0, 'alternate total cannot certify zero');
    assert.notEqual(scope.if_own_transfers?.total_minor, 0, 'alternate transfer view cannot certify zero');
  }
  assert.doesNotMatch(scopeText(body, scope, monthly), /No spending|No charges|\$0\.00/i);
  assert.match(scopeText(body, scope, monthly), /(?:store total|store's own total) is not confirmed/i);
  keptEvidence(body, scope, monthly);
}

// The independent review's exact 2 x 4 x 2 attack matrix, each with a green zero.
for (const kind of ['card', 'refund']) for (let position = 0; position < 4; position++) for (const monthly of [false, true])
  test(`R2-B1 ${kind} position=${position} monthly=${monthly}`, async t => {
    const f = setup(t), date = dates[position];
    f.put('anchor', 1729, { date: dates[(position + 1) % 4] });
    f.put('exact', 751, { date, kind });
    const green = await f.read(position, monthly), gs = scopeOf(green, position, monthly);
    assert.equal(gs.total_minor, 0, 'exact-only zero kept');
    assert.equal(gs.complete, monthly || position !== 3, 'S7 keeps a future-ended October reading partial'); keptEvidence(green, gs, monthly);
    f.put('possible-payment', 4093, { date, possible: true, kind: 'loan' });
    const body = await f.read(position, monthly), scope = scopeOf(body, position, monthly);
    assert.ok(scope.payment_exclusions.rows.some(row => row.match_basis === 'possible'), 'possible payment partition reached');
    unconfirmed(body, scope, monthly);
  });

// Deterministic generation varies scope, exact evidence, payment type, ordinary
// candidates, refunds, row ordering and cents without consulting a wall clock.
for (let seed = 0; seed < 512; seed++) test(`zero property seed=${seed}`, async t => {
  const monthly = Boolean(seed & 1), position = (seed >> 1) % 4;
  const f = setup(t), date = dates[position];
  f.put('anchor', 1701 + seed, { date: dates[(position + 1) % 4] });
  const kind = seed & 8 ? 'refund' : 'card';
  f.put('exact', 701 + seed * 3, { date, kind });
  if (seed & 16) f.put('second-exact', 331 + seed, { date, kind: kind === 'card' ? 'refund' : 'loan' });
  const green = await f.read(position, monthly), gs = scopeOf(green, position, monthly);
  assert.equal(gs.total_minor, 0, 'generated exact-only zero kept');
  assert.equal(gs.complete, monthly || position !== 3, 'S7 keeps a future-ended October reading partial'); keptEvidence(green, gs, monthly);
  f.put('possible-payment', 4001 + seed * 7, { date, possible: true, kind: seed & 32 ? 'card' : 'loan' });
  if (seed & 64) f.put('possible-ordinary', 1913 + seed, { date, possible: true });
  if (seed & 128) f.put('possible-refund', 97 + seed, { date, possible: true, kind: 'refund' });
  if (seed & 256) f.put('exact-purchase', 1103 + seed, { date });
  const body = await f.read(position, monthly), scope = scopeOf(body, position, monthly);
  assert.ok(scope.payment_exclusions?.rows.some(row => row.match_basis === 'possible'), 'generated possible payment partition reached');
  assert.ok(scope.total_minor !== 0 || scope.complete === false, 'no certified zero beside possible attribution');
  assert.doesNotMatch(scopeText(body, scope, monthly), /No spending|No charges|\$0\.00/i);
  keptEvidence(body, scope, monthly);
  if (!(seed & (64 | 256))) unconfirmed(body, scope, monthly);
  if (monthly) {
    const anchor = body.ledger.months[(position + 1) % 4];
    assert.equal(anchor.total_minor, 1701 + seed, 'other month arithmetic unchanged');
    assert.equal(anchor.complete, true, 'uncertainty stays in its month');
    for (const month of body.ledger.months.filter(m => ![position, (position + 1) % 4].includes(+m.month.slice(5) - 7) && m.to.endsWith('-31'))) {
      assert.equal(month.total_minor, 0, 'empty covered month remains zero');
      assert.equal(month.complete, true);
    }
  }
});

test('genuinely empty covered months keep zero', async t => {
  const f = setup(t); f.put('anchor', 1913, { date: dates[0] });
  const body = await f.read(0, true);
  for (const position of [1, 2]) {
    assert.equal(body.ledger.months[position].total_minor, 0);
    assert.equal(body.ledger.months[position].complete, true);
  }
});

// Exercise the actual boundary independently of today's branch reachability.
// A future renderer may retain a possible refund even when the current compact
// receipt omits it. Its inflow direction cannot authorize a named spending zero.
for (const kind of ['ordinary', 'payment', 'refund']) for (const monthly of [false, true])
  test(`boundary retained ${kind} monthly=${monthly}`, () => {
    const scope = { from: '2026-07-01', to: '2026-07-31', total_minor: 0, lead_total_minor: 0,
      complete: true, available: true, citations: [1, 2, 3],
      if_own_transfers: { total_minor: 0, complete: true },
      payment_exclusions: { total_minor: 751, count: 1, rows: [{ n: 1, posted_on: dates[0], amount_minor: 751 }] },
      refunds_received_minor: 397, refund_rows: [{ n: 2, posted_on: dates[0], amount_minor: 397 }],
      ...(monthly ? { label: 'July 2026', month: '2026-07', subtotal_minor: null } : {}),
    };
    const body = { answer: (monthly ? 'July 2026: $0.00. ' : 'No spending at Store Unit; ') +
      'Refunds received: $3.97 [2].\npayment to a card: $7.51 on July 7 in account 1234 [1].',
      citations: [751, 397, 4093].map((amount_minor, i) => ({ n: i + 1, ref: `ledger:transaction:${i + 1}`, posted_on: dates[0], amount_minor })),
      ledger: monthly ? { months: [scope], complete: true } : scope };
    const number = kind === 'payment' ? 1 : kind === 'refund' ? 2 : 3;
    const possibleRef = body.citations.find(ref => ref.n === number);
    assert.ok(possibleRef, 'retained reference decision reached');
    const green = structuredClone(body);
    reader.enforceNamedZeroPostcondition(green, { possible: new Set() });
    assert.deepEqual(green, body, 'exact-only boundary is byte-for-byte unchanged');
    reader.enforceNamedZeroPostcondition(body, { possible: new Set([possibleRef.ref]) });
    const actual = monthly ? body.ledger.months[0] : body.ledger;
    assert.equal(actual.total_minor, null);
    assert.equal(actual.lead_total_minor, null);
    assert.equal(actual.if_own_transfers.total_minor, null);
    assert.equal(actual.complete, false); assert.equal(body.ledger.complete, false);
    assert.doesNotMatch(body.answer, /No spending|No charges|\$0\.00/i);
    assert.equal(body.answer.match(/The store's own total is not confirmed\./g)?.length, 1);
    keptEvidence(body, actual, monthly);
    assert.equal(body.citations.length, 3, 'every retained citation survives');
  });

for (let position = 0; position < 4; position++) for (const monthly of [false, true])
  test(`partial zero purchase position=${position} monthly=${monthly}`, async t => {
    const f = setup(t), date = dates[position];
    f.raw("INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at) VALUES ('second-unit','owner','checking','asset','3456','manual','owner_stated','confirmed',?)", NOW);
    f.raw("INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at) VALUES ('second-unit','complete','2026-10-08','2026-10-31',?,'owner_stated','confirmed',?)", NOW, NOW);
    f.put('anchor', 1729, { date: dates[(position + 1) % 4] });
    f.put('zero-purchase', 0, { date });
    const green = await f.read(position, monthly), gs = scopeOf(green, position, monthly);
    assert.equal(monthly ? gs.subtotal_minor : gs.partial_subtotal_minor, 0, 'exact-only partial zero kept');
    assert.match(scopeText(green, gs, monthly), /\$0\.00/);
    f.put('possible-payment', 4093, { date, possible: true, kind: 'loan' });
    const body = await f.read(position, monthly), scope = scopeOf(body, position, monthly);
    assert.ok(scope.payment_exclusions.rows.some(row => row.match_basis === 'possible'), 'partial possible payment partition reached');
    unconfirmed(body, scope, monthly);
    if (!monthly) assert.equal(scope.partial_subtotal_minor, null);
  });

for (const claim of ['You spent $0.00 at Store Unit.', 'Total spending: $0.00.', 'No charges at Store Unit.', 'no spending at Store Unit.'])
  test(`boundary textual zero without certified fields: ${claim}`, () => {
    const body = { answer: claim + '\nRefunds received: $3.97 [1].', citations: [{ n: 1, ref: 'ledger:transaction:1', posted_on: dates[0], amount_minor: 397 }],
      ledger: { from: '2026-07-01', to: '2026-07-31', complete: false, total_minor: null } };
    const green = structuredClone(body);
    reader.enforceNamedZeroPostcondition(green, { possible: new Set() });
    assert.deepEqual(green, body, 'exact-only text control unchanged');
    reader.enforceNamedZeroPostcondition(body, { possible: new Set(['ledger:transaction:1']) });
    assert.equal(body.ledger.attribution_incomplete, true, 'textual claim decision reached');
    assert.doesNotMatch(body.answer, /No spending|No charges|\$0\.00/i);
    assert.match(body.answer, /The store's own total is not confirmed\./);
    assert.match(body.answer, /Refunds received: \$3\.97 \[1\]/);
  });

test('withholding a named zero preserves zero-valued payment and refund postings', () => {
  const body = { answer: 'Total spending: $0.00.\nRefunds received: $0.00 [1].\npayment to a card: $0.00 on July 7 in account 1234 [2].',
    citations: [1, 2].map(n => ({ n, ref: `ledger:transaction:${n}`, posted_on: dates[0], amount_minor: 0 })),
    ledger: { from: '2026-07-01', to: '2026-07-31', complete: true, total_minor: 0 } };
  const green = structuredClone(body);
  reader.enforceNamedZeroPostcondition(green, { possible: new Set() });
  assert.deepEqual(green, body, 'exact-only zero-valued postings kept');
  reader.enforceNamedZeroPostcondition(body, { possible: new Set(['ledger:transaction:2']) });
  assert.equal(body.ledger.total_minor, null);
  assert.equal(body.ledger.attribution_incomplete, true, 'zero claim decision reached');
  assert.match(body.answer, /The store's own total is not confirmed\./);
  assert.match(body.answer, /Refunds received: \$0\.00 \[1\]/);
  assert.match(body.answer, /payment to a card: \$0\.00 on July 7 in account 1234 \[2\]/);
  assert.equal(body.answer.match(/\$0\.00/g)?.length, 2, 'only posting zeros survive');
});

// NZ-B1 exposed an empty ranking beside an excluded possible payment. Keep
// these phrases fixed and independent of the product renderer's vocabulary.
const absencePhrases = [/\bno (?:ordinary )?spending\b/i, /\bno charges\b/i,
  /\bno expenses found\b/i, /\bno deposits found\b/i, /\bno recurring charges\b/i,
  /\bno (?:matching|readable) (?:row|transactions?).*found\b/i, /\bfound\s*[:=]\s*false\b/i,
  /\$0\.00\s+at\b/i, /\bno (?:matching )?(?:deposit|payment)\b/i];
function noNamedAbsence(body, scope, monthly, withheldClaim = false) {
  const text = scopeText(body, scope, monthly);
  assert.equal(scope.attribution_incomplete, true, 'possible row sets the typed scope flag');
  assert.equal(scope.complete, false);
  assert.notEqual(scope.found, false, 'absence cannot survive as a structured field');
  for (const phrase of absencePhrases) assert.doesNotMatch(text, phrase);
  const aggregates = text.split('\n').filter(line => !/^(?:payments? to |and \d+ more:|refunds received:|other money received:|money received:)/i.test(line)).join('\n');
  assert.doesNotMatch(aggregates, /\$0\.00\b/, 'rendered aggregate zero cannot escape through another phrase');
  for (const key of ['total_minor', 'lead_total_minor', 'monthly_total_minor', 'lead_monthly_total_minor',
    'subtotal_minor', 'partial_subtotal_minor', 'exact_subtotal_minor', 'family_subtotal_minor'])
    assert.notEqual(scope[key], 0, `uncertain scope cannot certify ${key}`);
  for (const key of ['total_minor', 'monthly_total_minor'])
    assert.notEqual(scope.if_own_transfers?.[key], 0, `alternate aggregate ${key} cannot certify zero`);
  const notices = text.match(/The store's own total is not confirmed\./g)?.length || 0;
  assert.ok(notices <= 1, 'scope never repeats the standard uncertainty sentence');
  if (withheldClaim) assert.equal(notices, 1, 'withheld absence receives its replacement sentence');
  keptEvidence(body, scope, monthly);
}
for (let position = 0; position < 4; position++) for (const kind of ['card', 'refund'])
  test(`NZ-B1 ranking position=${position} exact=${kind}`, async t => {
    const f = setup(t), date = dates[position];
    const options = { question: `Could you retrieve the ten largest expenses at Store Unit in ${names[position]} 2026?`,
      intent: { kind: 'largest', count: 10 } };
    f.put('ordinary-control', 1729, { date });
    assert.equal((await f.read(position, false, options)).ledger.lead_rows[0].amount_minor, 1729);
    f.raw('DELETE FROM fin_transactions');
    f.put('exact', 751, { date, kind });
    const green = await f.read(position, false, options);
    assert.equal(green.ledger.found, false, 'exact-only empty ranking control');
    assert.match(green.answer, /No expenses found/);
    f.put('possible', 4093, { date, kind: 'loan', possible: true });
    const body = await f.read(position, false, options);
    assert.ok(body.ledger.payment_exclusions.rows.some(row => row.match_basis === 'possible'), 'NZ-B1 partition reached');
    assert.equal(body.ledger.lead_rows.length, 0, 'payments stay outside ranking');
    assert.equal(body.ledger.payment_exclusions.total_minor, kind === 'card' ? 4844 : 4093);
    noNamedAbsence(body, body.ledger, false, true);
  });

const answerModes = ['spending', 'merchant', 'monthly', 'largest', 'recurring', 'category-payee', 'hit', 'family', 'payer'];
function kindOptions(mode, position, amount) {
  const period = `in ${names[position]} 2026`;
  const intent = { kind: 'merchant' };
  let question = `Could you retrieve charges at Store Unit ${period}?`;
  if (mode === 'spending') return { question: `How much did I spend at Store Unit ${period}?`, literal: true };
  if (mode === 'monthly') question = monthlyQuestion;
  if (mode === 'largest') { question = `Could you retrieve the ten largest expenses at Store Unit ${period}?`; intent.kind = 'largest'; intent.count = 10; }
  if (mode === 'recurring') { question = `Could you retrieve recurring charges at Store Unit between 2026-${String(position + 5).padStart(2, '0')}-01 and ${dates[position]}?`; intent.kind = 'recurring'; }
  // Named expense/category operands use the existing merchant alias.
  if (mode === 'category-payee') { question = `Could you retrieve spending and categories at Store Unit ${period}?`; intent.kind = 'expense_summary'; }
  if (mode === 'hit') { question = `Did the ${money(amount)} Store Unit payment hit account ending 1234 ${period}?`; Object.assign(intent, { kind: 'payment', direction: 'inflow', account_hint: '1234', amount_text: money(amount) }); }
  if (mode === 'family') question = `Could you retrieve spending at vendor Store Unit ${period}?`;
  if (mode === 'payer') { question = `Could you retrieve deposits from Store Unit ${period}?`; Object.assign(intent, { kind: 'merchant', direction: 'inflow' }); }
  return { question, intent };
}
for (const mode of answerModes) for (let seed = 0; seed < 96; seed++)
  test(`all-kind property ${mode} seed=${seed}`, async t => {
    const f = setup(t), position = seed % 4, date = dates[position], monthly = mode === 'monthly';
    const amount = 4001 + seed * 7, options = kindOptions(mode, position, amount);
    const inflow = ['hit', 'payer'].includes(mode);
    f.put('anchor', 1729, { date: dates[(position + 1) % 4] });
    f.put('exact', inflow ? amount : 751 + seed, { date, kind: inflow ? 'refund' : seed & 1 ? 'refund' : 'card' });
    const green = await f.read(position, monthly, options), gs = scopeOf(green, position, monthly);
    if (mode === 'largest') { assert.equal(gs.found, false); assert.match(green.answer, /No expenses found/); }
    else if (mode === 'hit') assert.equal(gs.found, true, 'exact payment control');
    else if (!['recurring', 'payer'].includes(mode)) { assert.equal(gs.total_minor, 0, 'exact-only zero control'); assert.equal(gs.complete, monthly || position !== 3, 'S7 keeps a future-ended October reading partial'); }
    else if (mode === 'payer') {
      assert.equal(gs.attributed_subtotal_minor, amount, 'exact payer subtotal control');
      assert.equal(gs.complete, false, 'full payer income remains unestablished');
    } else {
      assert.notEqual(gs.attribution_incomplete, true, 'exact-only control retains identity');
      if (mode === 'recurring') { assert.equal(gs.monthly_total_minor, 0); assert.equal(gs.found, false); }
    }
    f.put('possible', amount, { date, possible: true, kind: inflow ? 'refund' : ['ordinary', 'loan', 'refund', 'card'][seed % 4] });
    if (mode === 'hit') {
      f.raw("DELETE FROM fin_transactions WHERE txn_uid='exact'");
      f.raw("UPDATE fin_transactions SET description='Transfer Store Unit receipt' WHERE txn_uid='possible'");
    }
    if (seed & 4) f.put('possible-ordinary', 1913 + seed, { date, possible: true, kind: inflow ? 'refund' : 'ordinary' });
    if (seed & 8) f.put('possible-refund', 97 + seed, { date, possible: true, kind: 'refund' });
    if (seed & 16 && !inflow) f.put('exact-purchase', 1103 + seed, { date });
    if (seed & 32 && !inflow) f.raw("UPDATE fin_transactions SET payee='Store Unit Branch' WHERE txn_uid='exact'");
    const body = await f.read(position, monthly, options), scope = scopeOf(body, position, monthly);
    assert.ok(f.first("SELECT count(*) n FROM fin_transactions WHERE payee IS NULL AND posted_on=?", date).n > 0, 'possible scope decision pool reached');
    noNamedAbsence(body, scope, monthly);
    if (monthly) {
      const anchor = body.ledger.months[(position + 1) % 4];
      assert.equal(anchor.total_minor, 1729, 'other month arithmetic kept');
      assert.equal(anchor.complete, true, 'scope flag stays local');
    }
  });

for (const phrase of ['No expenses found.', 'No spending at Store Unit.', 'No charges at Store Unit.',
  'No recurring charges detected.', 'No deposits found.', 'found: false', '$0.00 at Store Unit.'])
  test(`one renderer guard catches future phrase ${phrase}`, () => {
    const body = { answer: phrase + '\npayment to a loan: $40.93 on July 7 [1].',
      ledger: { from: dates[0], to: dates[0], found: false,
        payment_exclusions: { rows: [{ n: 1, posted_on: dates[0], amount_minor: 4093, match_basis: 'possible' }] } },
      citations: [{ n: 1, ref: 'ledger:transaction:1', posted_on: dates[0], amount_minor: 4093 }] };
    const green = structuredClone(body); green.ledger.payment_exclusions.rows[0].match_basis = 'exact';
    const original = structuredClone(green);
    reader.enforceNamedZeroPostcondition(green, { possible: new Set() });
    assert.deepEqual(green, original, 'exact-only phrase control');
    reader.enforceNamedZeroPostcondition(body, { possible: new Set() });
    noNamedAbsence(body, body.ledger, false, true);
  });

for (const kind of ['ordinary', 'payment', 'refund', 'ranking-candidate'])
  test(`uncited ${kind} still sets scope attribution`, () => {
    const scope = { from: '2026-07-01', to: '2026-07-31', complete: true, total_minor: 0, found: false };
    const body = { answer: 'No expenses found.', ledger: scope, citations: [] };
    const green = structuredClone(body);
    reader.enforceNamedZeroPostcondition(green, { possible: new Set(), possibleRows: [{ posted_on: dates[1] }] });
    assert.deepEqual(green, body, 'out-of-scope uncertainty preserves empty zero');
    const evidence = { possible: new Set(), possibleRows: [{ posted_on: dates[0], ref: 'ledger:transaction:1' }] };
    assert.equal(evidence.possibleRows.length, 1, 'uncited original identity row reaches boundary');
    reader.enforceNamedZeroPostcondition(body, evidence);
    noNamedAbsence(body, scope, false, true);
  });

for (let position = 0; position < 4; position++)
  test(`exact payer plus uncited possible receipt position=${position}`, async t => {
    const f = setup(t), date = dates[position], options = kindOptions('hit', position, 4093);
    f.put('exact', 4093, { date, kind: 'refund' });
    f.put('foreign', 4093, { date, kind: 'refund' });
    f.raw("UPDATE fin_transactions SET payee='Other Unit', description='Store Unit memo' WHERE txn_uid='foreign'");
    f.put('outside-amount', 8191, { date, kind: 'refund', possible: true });
    f.raw("UPDATE fin_transactions SET description='memo Store Unit receipt' WHERE txn_uid='outside-amount'");
    f.put('outside-direction', 4093, { date, possible: true });
    const green = await f.read(position, false, options);
    assert.equal(green.ledger.found, true);
    assert.equal(green.citations.length, 1, 'foreign structured payer excluded');
    assert.equal(green.citations[0].amount_minor, 4093);
    if (position === 3) assert.equal(green.ledger.complete, false, 'October remains partial through the fixture owner day');
    else assert.notEqual(green.ledger.complete, false, 'known different payer preserves exact positive control');
    assert.notEqual(green.ledger.attribution_incomplete, true);
    f.put('possible', 4093, { date, kind: 'refund', possible: true });
    f.raw("UPDATE fin_transactions SET description='memo Store Unit receipt' WHERE txn_uid='possible'");
    const body = await f.read(position, false, options);
    assert.equal(body.ledger.found, true, 'exact receipt remains found');
    assert.equal(body.citations.length, 1, 'uncited possible receipt cannot become another exact hit');
    assert.equal(body.ledger.amount_minor, 4093, 'requested receipt amount kept');
    assert.equal(body.citations[0].amount_minor, 4093, 'exact receipt arithmetic kept');
    const possibleId = f.first("SELECT id FROM fin_transactions WHERE txn_uid='possible'").id;
    assert.ok(body.citations.every(ref => ref.ref !== `ledger:transaction:${possibleId}`),
      'possible original row is outside retained receipt membership');
    assert.equal(body.evidence_gate.complete, false);
    noNamedAbsence(body, body.ledger, false);
  });

for (let position = 0; position < 4; position++)
  test(`nested ranking scope position=${position}`, async t => {
    const f = setup(t), date = dates[position];
    f.raw("INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at) VALUES ('second-unit','owner','checking','asset','3456','manual','owner_stated','confirmed',?)", NOW);
    f.raw("INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at) VALUES ('second-unit','complete','2024-01-01','2026-10-31',?,'owner_stated','confirmed',?)", NOW, NOW);
    const options = { question: `Could you retrieve the ten largest expenses at Store Unit per account in ${names[position]} 2026?`,
      intent: { kind: 'largest', count: 10 } };
    f.put('first-card', 751, { date, kind: 'card' });
    f.put('second-card', 853, { date, kind: 'card' });
    f.raw("UPDATE fin_transactions SET account_slug='second-unit' WHERE txn_uid='second-card'");
    const green = await f.read(position, false, options);
    assert.equal(green.ledger.per_account.length, 2, 'nested ranking composition reached');
    for (const scope of green.ledger.per_account) {
      assert.equal(scope.found, false, 'exact-only nested absence control');
      assert.equal(scope.if_own_transfers.total_minor, 0, 'exact-only nested zero control');
      keptEvidence(green, scope, false);
    }
    f.put('possible-refund', 4093, { date, kind: 'refund', possible: true });
    f.raw("UPDATE fin_transactions SET account_slug='second-unit' WHERE txn_uid='possible-refund'");
    const body = await f.read(position, false, options);
    assert.equal(body.ledger.payment_exclusions.total_minor, 1604, 'posted payment cents kept');
    assert.equal(body.ledger.per_account[0].found, false, 'other account keeps exact empty result');
    assert.equal(body.ledger.per_account[0].if_own_transfers.total_minor, 0);
    assert.notEqual(body.ledger.per_account[0].attribution_incomplete, true, 'account scope stays local');
    const affected = body.ledger.per_account[1];
    assert.equal(affected.attribution_incomplete, true, 'uncited possible refund reaches nested identity scope');
    assert.equal(affected.complete, false);
    assert.equal(affected.found, null);
    assert.equal(affected.if_own_transfers.total_minor, null);
    for (const scope of body.ledger.per_account) keptEvidence(body, scope, false);
    noNamedAbsence(body, body.ledger, false, true);
  });
