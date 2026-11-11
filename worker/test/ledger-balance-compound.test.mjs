import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture, NOW } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';

const labels = ['Operating account', 'Reserve account', 'Buffer account'];
const cents = [347, 229, 113];
const balance = account_hint => ({ kind: 'balance', account_hint, period: { type: 'none' } });
const activity = account_hint => ({ kind: 'totals', direction: 'inflow', account_hint, period: { type: 'this_month' } });
function setup(t) {
  const f = fixture(t); f.owner();
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.env.AI.run = async () => assert.fail('external model forbidden');
  f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex');
  f.env.RERANK_MODEL = 'claude-haiku-4-5-20251001';
  for (let i = 0; i < 3; i++) {
    f.raw(`INSERT INTO fin_accounts(account_slug,entity_slug,label,mask,account_kind,balance_role,status,feed_mode,provenance,basis_state,recorded_at)
      VALUES (?,'owner',?,?,'checking','asset','open','manual','owner_stated','confirmed',?)`, `row-${i}`, labels[i], String(610 + i), NOW);
    f.raw(`INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES (?,'complete','2026-01-01','2026-10-12',?,'owner_stated','confirmed',?)`, `row-${i}`, NOW, NOW);
    f.raw(`INSERT INTO fin_balance_snapshots(account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at)
      VALUES (?,'2026-10-11',?,'owner_stated','confirmed',?)`, `row-${i}`, cents[i], NOW);
  }
  f.raw(`INSERT INTO fin_transactions(txn_uid,account_slug,posted_on,amount_minor,direction,description,provenance,basis_state,recorded_at)
    VALUES ('deposit','row-1','2026-10-05',53,'inflow','Synthetic deposit','owner_stated','confirmed',?)`, NOW);
  return f;
}
async function ask(f, question, intents, fallbackAnswer = 'Synthetic document answer.') {
  let models = 0, fallbacks = 0;
  const start = f.calls.length;
  const body = await (await withLedgerAnswer({ env: f.env, question, now: Date.parse(NOW),
    grantScope: { all: true }, scopePrincipalKind: 'owner', callLLM: async () => {
      models++;
      return { content: [{ type: 'text', text: JSON.stringify({ intents }) }] };
    } }, async gap => {
    fallbacks++;
    return Response.json({ answer: fallbackAnswer, gaps: gap ? [gap] : [], citations: [], results: [],
      evidence_gate: { supported: true, complete: true, partial: false } });
  })).json();
  return { body, models, fallbacks, sql: f.calls.slice(start) };
}
function refused(r, count) {
  assert.ok(r.sql.some(sql => /FROM fin_accounts a/.test(sql)), 'real account decision reached');
  assert.equal(r.fallbacks, 0, 'compound refusal is terminal');
  assert.equal(r.body.evidence_gate.supported, false);
  assert.equal(r.body.evidence_gate.complete, false);
  assert.equal(r.body.evidence_gate.partial, true);
  assert.equal(r.body.ledger.complete, false);
  assert.equal(r.body.ledger.compound_refused, true);
  assert.equal(r.body.ledger.comparison, undefined);
  assert.equal(r.body.ledger.operands.length, count);
  assert.match(r.body.answer, /cannot confirm.*compound/i);
  assert.ok(!JSON.stringify(r.body).includes('row-'), 'internal identity stays private');
}

for (const reverse of [false, true]) for (const fault of ['missing', 'never_connected', 'closed', 'currency', 'basis']) {
  for (const mixed of [false, true]) for (const fallback of [null, 'Synthetic document answer.']) {
    test(`safe compound: reverse=${reverse} fault=${fault} mixed=${mixed} fallback=${fallback === null ? 'null' : 'supported'}`, async t => {
      const f = setup(t);
      const clauses = ['retrieve my Operating account balance', mixed ? 'show money received in Reserve account this month' : 'retrieve my Reserve account balance'];
      const order = reverse ? [1, 0] : [0, 1];
      const question = `Could you ${order.map(i => clauses[i]).join(' and ')}?`;
      const intents = order.map(i => i === 0 ? balance(labels[0]) : mixed ? activity(labels[1]) : balance(labels[1]));
      // Independent single-operand controls prove both underlying readings.
      for (const i of [0, 1]) {
        const control = await ask(f, `Could you ${clauses[i]}?`, [i === 0 ? balance(labels[0]) : mixed ? activity(labels[1]) : balance(labels[1])]);
        assert.ok(control.body.ledger, 'single-operand green control');
        assert.ok(control.sql.length > 0);
        assert.equal(control.fallbacks, 0);
      }
      const green = await ask(f, question, intents, fallback);
      refused(green, 2);
      assert.deepEqual(green.body.ledger.operands.map(p => p.complete), [true, true]);
      assert.match(green.body.answer, /Operating account.*610.*open/);
      assert.match(green.body.answer, /Reserve account.*611.*open/);
      if (fault === 'missing') f.raw("DELETE FROM fin_balance_snapshots WHERE account_slug='row-1'");
      if (fault === 'never_connected' || fault === 'closed') f.raw("UPDATE fin_accounts SET status=? WHERE account_slug='row-1'", fault);
      if (fault === 'currency') f.raw("UPDATE fin_accounts SET currency='EUR' WHERE account_slug='row-1'");
      if (fault === 'basis') f.raw("UPDATE fin_accounts SET basis_state='proposed' WHERE account_slug='row-1'");
      const bad = await ask(f, question, intents, fallback);
      refused(bad, 2);
      assert.match(bad.body.answer, /\$3\.47/);
      const failed = bad.body.ledger.operands[order.indexOf(1)];
      if (!mixed && fault === 'closed' || mixed && ['missing', 'closed', 'never_connected'].includes(fault)) {
        // Activity keeps its existing status/coverage semantics; a closed
        // exact balance still has a complete dated observation.
        assert.ok(failed.accounts.length > 0);
      } else {
        assert.equal(failed.complete, false);
        assert.doesNotMatch(bad.body.answer, /\$2\.29|\$0\.53/);
        assert.ok(bad.body.gaps.length > 0, 'actual operand limitation retained');
        if (fault === 'currency' || fault === 'basis') assert.ok(bad.body.gaps.some(gap =>
          gap.reason === (fault === 'currency' ? 'unsupported_currency' : 'ambiguous_account')));
      }
      if (!mixed && fault === 'missing') assert.match(bad.body.answer, /Reserve account.*missing recorded balance/);
      if (fault === 'never_connected') assert.match(bad.body.answer, /Reserve account.*never connected/);
      if (fault === 'closed') assert.match(bad.body.answer, /Reserve account.*closed/);
    });
  }
}

for (const form of ['compare', 'difference', 'versus', 'and']) for (const shape of ['two', 'collapsed', 'none']) {
  test(`compound wording: ${form} ${shape}`, async t => {
    const f = setup(t);
    const question = form === 'difference' ? 'What is the difference between my Operating account balance and my Reserve account balance?'
      : form === 'compare' ? 'Compare balances in Operating account and Reserve account.'
        : `What are my Operating account balance ${form} my Reserve account balance?`;
    const intents = shape === 'two' ? labels.slice(0, 2).map(balance)
      : shape === 'collapsed' ? [balance('Operating account')] : [];
    const green = await ask(f, 'Could you retrieve my Operating account balance?', [balance(labels[0])]);
    assert.equal(green.body.ledger.accounts[0].current_minor, 347);
    const result = await ask(f, question, intents);
    refused(result, 2);
    assert.deepEqual(result.body.ledger.parts.map(part => part?.accounts[0].current_minor), [347, 229]);
    assert.ok(result.body.citations.every(ref => result.body.answer.includes(`[${ref.n}]`)));
  });
}

test('a literal account conjunction preserves the single-account reading', async t => {
  const f = setup(t);
  f.raw("UPDATE fin_accounts SET label='Reserve and Buffer account' WHERE account_slug='row-0'");
  const question = 'Could you retrieve my Reserve and Buffer account balance?';
  const result = await ask(f, question, [balance('Reserve and Buffer account')]);
  assert.equal(result.fallbacks, 0);
  assert.equal(result.body.ledger.kind, 'balance');
  assert.equal(result.body.ledger.accounts.length, 1);
  assert.equal(result.body.ledger.accounts[0].current_minor, 347);
  assert.ok(result.sql.some(sql => /WITH observations/.test(sql)));
});

test('a model hint spanning two actual account operands cannot hide the conjunction', async t => {
  const f = setup(t);
  const question = 'Could you retrieve balances in Operating account and Reserve account?';
  const result = await ask(f, question, [balance('Operating account and Reserve account')]);
  refused(result, 2);
  assert.deepEqual(result.body.ledger.parts.map(part => part?.accounts[0].current_minor), [347, 229]);
});

for (const mixed of [false, true]) test(`literal payee words do not become balance operands: ${mixed}`, async t => {
  const f = setup(t);
  f.raw(`INSERT INTO fin_transactions(txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,provenance,basis_state,recorded_at)
    VALUES ('purchase','row-1','2026-10-05',17,'outflow','Supply Unit','Supply Unit','owner_stated','confirmed',?)`, NOW);
  const merchant = vendor_text => ({ kind: 'merchant', direction: 'outflow', vendor_text, period: { type: 'this_month' } });
  const control = await ask(f, 'How much did I spend at Supply Unit this month?', [merchant('Supply Unit')]);
  assert.equal(control.body.ledger.total_minor, 17);
  assert.equal(control.fallbacks, 0);
  f.raw("UPDATE fin_transactions SET payee='Balance and Loan Unit',description='Balance and Loan Unit' WHERE txn_uid='purchase'");
  const question = mixed ? 'Could you retrieve my Operating account balance and show spending at Balance and Loan Unit this month?'
    : 'How much did I spend at Balance and Loan Unit this month?';
  const result = await ask(f, question, mixed ? [balance(labels[0]), merchant('Balance and Loan Unit')] : [merchant('Balance and Loan Unit')]);
  assert.ok(result.sql.some(sql => /fin_transactions/.test(sql)), 'literal payee decision reached');
  assert.equal(result.fallbacks, 0);
  if (mixed) {
    refused(result, 2);
    assert.equal(result.body.ledger.parts[1].total_minor, 17);
  } else {
    assert.equal(result.body.ledger.kind, 'merchant');
    assert.equal(result.body.ledger.total_minor, 17);
  }
});

for (const allAvailable of [false, true]) test(`compound measures retain only independently complete values: ${allAvailable}`, async t => {
  const f = setup(t);
  if (allAvailable) f.raw('UPDATE fin_balance_snapshots SET available_minor=current_minor-1');
  const control = await ask(f, 'Could you retrieve bank balances?', [balance(null)]);
  assert.equal(control.body.ledger.kind, 'balance');
  assert.equal(control.fallbacks, 0);
  const question = 'Could you retrieve current balance versus available balance?';
  const result = await ask(f, question, [{ kind: 'balance', vendor_text: 'current balance', period: { type: 'none' } },
    { kind: 'balance', vendor_text: 'available balance', period: { type: 'none' } }]);
  refused(result, 2);
  assert.deepEqual(result.body.ledger.operands.map(part => part.complete), [true, allAvailable]);
  assert.equal(result.body.ledger.parts[0].accounts.length, 3);
  if (allAvailable) assert.deepEqual(result.body.ledger.parts[1].accounts.map(row => row.available_minor).sort((a,b) => a-b), [112, 228, 346]);
  else assert.equal(result.body.ledger.parts[1], null);
});

for (const order of [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]]) for (const join of ['versus', 'and', 'comma']) {
  for (const shape of ['two', 'three', 'none']) test(`whole-question operands: ${order} ${join} ${shape}`, async t => {
    const f = setup(t);
    const names = order.map(i => labels[i]);
    const list = join === 'comma' ? `${names[0]}, ${names[1]} and ${names[2]}` : names.join(` ${join} `);
    const question = `Could you compare balances in ${list}?`;
    const intents = shape === 'none' ? [] : order.slice(0, shape === 'two' ? 2 : 3).map(i => balance(labels[i]));
    for (const i of order) {
      const control = await ask(f, `Could you retrieve my ${labels[i]} balance?`, [balance(labels[i])]);
      assert.equal(control.body.ledger.accounts[0].current_minor, cents[i]);
      assert.equal(control.fallbacks, 0);
    }
    const green = await ask(f, question, intents);
    refused(green, 3);
    assert.equal(green.body.ledger.operands.filter(p => p.complete).length, 3);
    f.raw('DELETE FROM fin_balance_snapshots WHERE account_slug=?', `row-${order[2]}`);
    const bad = await ask(f, question, intents);
    refused(bad, 3);
    for (const label of labels) assert.ok(bad.body.answer.includes(label));
    assert.match(bad.body.answer, new RegExp(`${names[2]}.*missing recorded balance`));
    assert.equal(bad.body.ledger.operands.filter(p => p.complete).length, 2);
    assert.ok(bad.sql.filter(sql => /WITH observations/.test(sql)).length >= 3, 'omitted operand snapshot decision reached');
  });
}

// An empty bank inventory cannot take over the existing document/QuickBooks
// route merely because that question mentions two account kinds.
test('compound bank routing preserves the document path when no bank accounts exist', async t => {
  const f = fixture(t); f.owner();
  const result = await ask(f, 'What bank and credit card accounts do I have, and what are their current balances?', [balance(null)]);
  assert.equal(result.body.ledger?.compound_refused, undefined);
  assert.equal(result.fallbacks, 1);
});

for (const source of ['QuickBooks', 'QBO']) test(`compound source qualification preserves documents beside existing bank accounts: ${source}`, async t => {
  const f = setup(t);
  const result = await ask(f, `What bank and credit card accounts are in ${source}, and what are their current balances?`, [balance(null)]);
  assert.equal(result.body.ledger?.compound_refused, undefined);
  assert.equal(result.fallbacks, 1);
});
