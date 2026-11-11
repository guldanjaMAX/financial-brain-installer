import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { evidence, CLOCK } from '../../test/fixtures/fastloop-money/input.mjs';

const summaryQuestion = 'What are my expenses?';
const rankQuestion = 'What were my five biggest expenses this month?';
const grossQuestion = 'How much money came in and went out this month?';
function seed(t, change = () => {}) {
  const snapshot = evidence(); change(snapshot);
  const f = fixture(t); f.owner(); f.env.BRAIN_TIMEZONE = CLOCK.owner_time_zone;
  for (const a of snapshot.accounts) {
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at)
      VALUES (?,'owner',?,?,?,?, 'manual','owner_stated','confirmed',?)`, a.slug, a.kind, a.role, a.mask, a.label, CLOCK.now_utc);
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES (?,'complete','2026-07-01','2026-11-07',?,'owner_stated','confirmed',?)`, a.slug, CLOCK.now_utc, CLOCK.now_utc);
  }
  for (const r of snapshot.rows) f.raw(`INSERT INTO fin_transactions
    (id,txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,pending,provenance,basis_state,recorded_at)
    VALUES (?,?,?,?,?,?,?,?,?,'owner_stated','confirmed',?)`, r.id, r.uid, r.account, r.date,
  Number(r.cents), r.direction, r.description, r.payee, r.pending, CLOCK.now_utc);
  f.snapshot = snapshot;
  f.ask = async (question, answer = withLedgerAnswer) => {
    const before = f.calls.length, writes = f.first('SELECT total_changes() n').n;
    const body = await (await answer({ env: f.env, question, now: CLOCK.now_utc,
      grantScope: { all: true }, scopePrincipalKind: 'owner' }, () => assert.fail('unexpected document fallback'))).json();
    assert.ok(f.calls.slice(before).some(sql => /FROM fin_accounts/.test(sql)), 'inventory decision reached');
    assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)), 'transaction decision reached');
    assert.ok(f.first('SELECT COUNT(*) n FROM fin_transactions').n >= 6, 'nonempty seeded input');
    assert.equal(f.first('SELECT total_changes() n').n, writes, 'answer makes no durable writes');
    return body;
  };
  return f;
}
const expenseContract = b => {
  assert.equal(b.ledger.kind, 'expense_summary');
  assert.equal(b.ledger.expense_total_minor, 61000);
  assert.equal(b.ledger.own_account_payments.loan_minor, 40000);
  assert.match(b.answer, /\$610\.00/);
  assert.doesNotMatch(b.answer, /\bprincipal\b/i);
};
const rankingContract = b => {
  assert.equal(b.ledger.kind, 'largest');
  assert.deepEqual(b.ledger.lead_rows.map(r => r.ref), [8, 1, 2, 3, 4].map(id => `ledger:transaction:${id}`));
  assert.deepEqual(b.ledger.lead_rows.map(r => r.amount_minor), [40000, 6000, 5000, 4000, 3000]);
  assert.match(b.answer, /Payments to loans and cards \(excluded from spending and income\): \$400\.00/);
  assert.equal(b.ledger.own_account_payments.total_minor, 40000);
};
const postedContract = b => {
  assert.match(b.answer, /This reading covers completed transactions only; pending activity is not included\./);
  assert.match(b.answer, /^This reading covers completed transactions only; pending activity is not included\.$/m);
  assert.doesNotMatch(b.answer, /(?:no|zero) pending|\bprincipal\b/i);
  if (b.ledger.pending_excluded) {
    assert.equal(b.ledger.pending_excluded.total_minor, 900001);
    assert.equal(b.ledger.pending_excluded.count, 1);
    assert.match(b.answer, /Pending activity: \$9,000\.01 across 1 row, excluded from completed spending/);
    assert.equal(b.ledger.expense_total_minor, 61000, 'pending amount stays out of spending');
  } else assert.doesNotMatch(b.answer, /\bpending\b.*\$/i);
};
const ambiguousRepaymentContract = (b, kind = 'loan') => {
  // A duplicate ending cannot prove an owned destination. Explicit repayment
  // text still nominates a cited candidate, never ordinary spending.
  assert.equal(b.ledger.own_account_payments?.total_minor || 0, 0);
  assert.equal(b.ledger.possible_payments.length, 1);
  const candidate = b.ledger.possible_payments[0];
  assert.equal(candidate.payment_kind, kind);
  assert.equal(candidate.amount_minor, 40000);
  assert.ok(b.citations.some(c => c.n === candidate.n && c.amount_minor === 40000));
  assert.ok(b.answer.includes(`possible ${kind} payment, not counted as spending: $400.00`));
  if (b.ledger.kind === 'expense_summary') assert.equal(b.ledger.expense_total_minor, 61000);
  else {
    assert.equal(b.ledger.kind, 'largest');
    assert.deepEqual(b.ledger.lead_rows.map(r => r.ref), [8, 1, 2, 3, 4].map(id => `ledger:transaction:${id}`));
    assert.deepEqual(b.ledger.lead_rows.map(r => r.amount_minor), [40000, 6000, 5000, 4000, 3000]);
  }
};
for (const memo of ['payment to loan account 4242', 'payment to loan acct no. 4242',
  'payment to card account 4242', 'payment to card acct no. 4242']) {
  test(`RM1 duplicate masks stay ambiguous with a typed locator: ${memo}`, async t => {
    const kind = memo.includes('card') ? 'card' : 'loan';
    const change = s => { s.accounts[2].kind = kind; s.rows[6].description = memo; };
    const f = seed(t, s => { change(s); s.accounts[1].mask = '4242'; });
    for (const question of [summaryQuestion, rankQuestion]) ambiguousRepaymentContract(await f.ask(question), kind);
    const control = seed(t, change), summary = await control.ask(summaryQuestion);
    assert.equal(summary.ledger.expense_total_minor, 61000);
    assert.equal(summary.ledger.own_account_payments[`${kind}_minor`], 40000);
    rankingContract(await control.ask(rankQuestion));
  });
}
const uncertainExpenseContract = b => {
  assert.equal(b.ledger.kind, 'expense_summary');
  assert.equal(b.ledger.complete, false);
  assert.equal(b.evidence_gate.complete, false);
  assert.equal(b.evidence_gate.partial, true);
  assert.equal(b.ledger.coverage.complete, true, 'coverage does not prove classification');
  assert.equal(b.ledger.expense_total_minor, null, 'no certified expense figure');
  assert.equal(b.ledger.total_minor, null);
  assert.equal(b.ledger.retained_outflow_minor, 101000, 'uncertain row is retained');
  assert.equal(b.ledger.own_account_payments.total_minor, 0, 'memo does not manufacture type');
  assert.ok(b.answer.includes("Here is the money out I could check, with spending still unconfirmed. The account types for your account ending 4242 have not been confirmed, so some payments may be between your own accounts."));
  assert.doesNotMatch(b.answer, /^You spent|expense subtotal:/im);
};
test('RM4 other-typed loan cannot certify an expense headline', async t => {
  const f = seed(t, s => {
    s.accounts[2].kind = 'other'; s.accounts[2].role = 'neither';
    s.rows[6].description = 'unclassified outgoing payment';
  });
  uncertainExpenseContract(await f.ask(summaryQuestion));
  expenseContract(await seed(t).ask(summaryQuestion));
});

for (const memo of ['payment to acct no. xxxx4242', 'payment to account number ****4242',
  'payment to loan acct #4242', 'payment to account no 4242', 'payment to acct ending in 4242']) {
  test(`F1 typed unique liability accepts bounded locator: ${memo}`, async t => {
    const f = seed(t, s => { s.rows[6].description = memo; });
    expenseContract(await f.ask(summaryQuestion));
  });
}
for (const [label, change] of [
  ['unknown destination type', s => { s.accounts[2].kind = 'other'; }],
  ['unknown source type', s => { s.accounts[0].kind = 'other'; }],
  ['duplicate mask', s => { s.accounts[1].mask = '4242'; }],
  ['outside lender', s => { s.rows[6].description = 'payment to account 9999'; }],
  ['conflicting payee', s => { s.rows[6].payee = 'Outside Lender'; }],
  ['missing identity', s => { s.accounts[2].mask = null; s.accounts[2].label = null; }],
  ['conflicting type in locator', s => { s.rows[6].description = 'payment to savings account 4242'; }],
  ['unbounded marker', s => { s.rows[6].description = 'payment to acct no. xxxxx4242'; }],
  ['numeric suffix', s => { s.rows[6].description = 'payment to acct no. 42420'; }],
  ['residual words', s => { s.rows[6].description = 'payment to acct no. 4242 outside'; }],
]) test(`F1 ${label} cannot prove owned repayment`, async t => {
  const f = seed(t, change), b = await f.ask(summaryQuestion);
  if (label === 'unknown destination type') {
    assert.equal(b.answer, null, 'unknown subtype cannot establish ordinary expenses');
    assert.equal(b.gaps[0].reason, 'ledger_account_kind_review_required');
    assert.notEqual(b.ledger?.complete, true);
    assert.equal(b.ledger?.expense_total_minor, undefined);
  } else if (label === 'unknown source type') {
    assert.equal(b.ledger.complete, false, 'unknown source still cannot certify ordinary expenses');
    assert.equal(b.ledger.expense_total_minor, null);
    assert.equal(b.ledger.retained_outflow_minor, 61000);
    assert.equal(b.ledger.own_account_payments.total_minor, 40000, 'known liability counterparty still proves the repayment');
    assert.match(b.answer, /spending still unconfirmed/);
    assert.match(b.answer, /Payments to loans and cards/);
  } else {
    assert.equal(b.ledger.own_account_payments.total_minor, 0, 'ownership decision retains uncertain outgoing row');
    assert.equal(b.ledger.expense_total_minor, 101000);
  }
  expenseContract(await seed(t).ask(summaryQuestion));
});
test('F2 eligibility precedes rank cutoff and preserves whole repayments separately', async t => {
  const f = seed(t), b = await f.ask(rankQuestion);
  rankingContract(b);
  assert.equal(f.snapshot.rows.filter(r => !r.pending && r.direction === 'outflow' && r.date <= '2026-10-31').length, 8);
  assert.deepEqual(b.ledger.rows.map(row => row.ref), [8, 1, 2, 3, 4].map(id => `ledger:transaction:${id}`),
    'R1 alternate ranking contains ordinary expenses, with repayments disclosed separately');
  expenseContract(await f.ask(summaryQuestion));
  const gross = await f.ask(grossQuestion);
  assert.equal(gross.ledger.accounts.reduce((sum, a) => sum + a.debits_minor, 0), 101000);
  assert.equal(gross.ledger.possible_payments_included_minor, 40000);
  const vendor = await f.ask('How much did I pay to Outside Lender this month?');
  assert.equal(vendor.ledger.total_minor, 40000);
  assert.equal(vendor.citations[0].ref, 'ledger:transaction:8');
  const transactions = await f.ask('Show my last ten transactions.');
  assert.deepEqual(transactions.citations.map(c => c.ref), [1, 2, 3, 4, 5, 6, 11, 9, 8, 7].map(id => `ledger:transaction:${id}`));
});
test('F3 expense synonyms and movement totals share the repayment boundary', async t => {
  const f = seed(t);
  for (const q of ['Spend this month', 'What is my spending this month', 'How much have I spent this month?', summaryQuestion]) expenseContract(await f.ask(q));
  for (const q of [grossQuestion, 'What were my credits and debits this month?']) {
    const b = await f.ask(q);
    assert.equal(b.ledger.kind, 'totals');
    assert.equal(b.ledger.accounts.reduce((sum, a) => sum + a.debits_minor, 0), 101000);
    assert.equal(b.ledger.possible_payments_included_minor, 40000);
  }
});
for (const pending of [true, false]) test(`F4 posted disclosure with pending row present=${pending}`, async t => {
  const f = seed(t, s => { if (!pending) s.rows = s.rows.filter(r => !r.pending); });
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions WHERE pending=1').n, pending ? 1 : 0);
  for (const q of [summaryQuestion, rankQuestion, grossQuestion, 'Show my last ten transactions.',
    'How much did I pay to Outside Lender this month?']) {
    const b = await f.ask(q); postedContract(b);
    assert.ok(f.calls.some(sql => sql.includes('t.pending=0')), 'real SQL pending predicate reached');
    const pendingRefs = new Set(b.ledger.pending_excluded?.citations || []);
    assert.ok(b.citations.every(c => c.ref !== 'ledger:transaction:12' || pendingRefs.has(c.n)), 'pending citations belong only to the exclusion receipt');
    assert.ok((b.ledger.groups || []).every(group => group.citations.every(n => !pendingRefs.has(n))));
    assert.ok((b.ledger.lead_rows || []).every(row => !pendingRefs.has(row.n)));
    if (pending && b.ledger.kind === 'expense_summary') {
      assert.equal(pendingRefs.size, 1);
      assert.equal(b.citations.find(c => pendingRefs.has(c.n)).ref, 'ledger:transaction:12');
    } else { assert.equal(pendingRefs.size, 0); assert.doesNotMatch(b.answer, /9,000\.01/); }
  }
});

// Restore one product decision at a time; the same positive contract must fail.
async function mutant(file, from, to, additional = []) {
  const url = new URL(`../src/lib/${file}`, import.meta.url);
  let source = readFileSync(url, 'utf8');
  for (const [before, after] of additional) {
    assert.equal(source.split(before).length - 1, 1, 'one overlapping restoring product site');
    source = source.replace(before, after);
  }
  assert.equal(source.split(from).length - 1, 1, 'one restoring mutation site');
  const altered = source.replace(from, to);
  const moduleUrl = (code, base) => `data:text/javascript;base64,${Buffer.from(code.replace(/from "(\.\/.+?)"/g,
    (_, path) => `from ${JSON.stringify(new URL(path, base).href)}`)).toString('base64')}`;
  if (file === 'ledger-answer.js') return (await import(moduleUrl(altered, url))).withLedgerAnswer;
  const target = moduleUrl(altered, url), answerUrl = new URL('../src/lib/ledger-answer.js', import.meta.url);
  const answerSource = readFileSync(answerUrl, 'utf8').replace(`from "./${file}"`, `from "${target}"`);
  return (await import(moduleUrl(answerSource, answerUrl))).withLedgerAnswer;
}
test('RM1 restoring the type filter makes the duplicate-mask contract fail again', async t => {
  const f = seed(t, s => { s.accounts[1].mask = '4242'; s.rows[6].description = 'payment to loan acct no. 4242'; });
  const answer = await mutant('ledger-analysis.js',
    'filter(account => (account.members || []).some(member =>',
    'filter(account => (!statedKind || statedKind === account.account_kind) && (account.members || []).some(member =>');
  for (const question of [summaryQuestion, rankQuestion]) {
    ambiguousRepaymentContract(await f.ask(question));
    const broken = await f.ask(question, answer);
    assert.equal(broken.ledger.own_account_payments.total_minor, 40000);
    assert.throws(() => ambiguousRepaymentContract(broken), { name: 'AssertionError' });
  }
});
test('RM4 restoring coverage-only certification makes the uncertain-expense contract fail again', async t => {
  const f = seed(t, s => {
    s.accounts[2].kind = 'other'; s.accounts[2].role = 'neither';
    s.rows[6].description = 'unclassified outgoing payment';
  });
  uncertainExpenseContract(await f.ask(summaryQuestion));
  // Restore both merged guards to reproduce the coverage-only certification.
  const answer = await mutant('ledger-answer.js', 'if (!classificationComplete) {', 'if (false) {',
    [['const complete = coverageComplete && !classificationUncertain;', 'const complete = coverageComplete;']]);
  const broken = await f.ask(summaryQuestion, answer);
  assert.equal(broken.ledger.complete, true);
  assert.equal(broken.ledger.expense_total_minor, 101000);
  assert.throws(() => uncertainExpenseContract(broken), { name: 'AssertionError' });
});
test('F1 restoring locator grammar makes the same typed-memo contract fail', async t => {
  const f = seed(t, s => { s.rows[6].description = 'payment to acct no. xxxx4242'; });
  expenseContract(await f.ask(summaryQuestion));
  // Scope the restoration to the exact locator, not recurring advisory syntax.
  const answer = await mutant('ledger-analysis.js', '(?: account| acct)? (?:number |no )?', '(?: account| acct)? ');
  const broken = await f.ask(summaryQuestion, answer);
  assert.throws(() => expenseContract(broken), { name: 'AssertionError' });
});
test('F2 restoring ranking exclusions makes the same ranking contract fail', async t => {
  const f = seed(t);
  rankingContract(await f.ask(rankQuestion));
  const answer = await mutant('ledger-answer.js', 'if (intent.kind === "largest" && intent.direction === "outflow") {', 'if (false) {',
    [['const activity = intent.kind === "largest" && intent.direction === "outflow"\n    ? rows.filter(row => !loanCardPaymentKind(row, bySlug)) : rows;', 'const activity = rows;']]);
  const broken = await f.ask(rankQuestion, answer);
  assert.throws(() => rankingContract(broken), { name: 'AssertionError' });
  assert.equal(broken.ledger.lead_rows[0].ref, 'ledger:transaction:7');
});
test('F3 restoring shorthand fallthrough makes the same expense contract fail', async t => {
  const f = seed(t);
  expenseContract(await f.ask('Spend this month'));
  const answer = await mutant('ledger-question.js', '|spend)(?: and on what)?$/;', ')(?: and on what)?$/;');
  const broken = await f.ask('Spend this month', answer);
  assert.throws(() => expenseContract(broken), { name: 'AssertionError' });
  assert.equal(broken.ledger.kind, 'totals');
});
test('F4 restoring undisclosed posted scope makes the same disclosure contract fail', async t => {
  const f = seed(t);
  postedContract(await f.ask(summaryQuestion));
  const answer = await mutant('ledger-answer.js', 'if (answer.ledger.kind !== "balance") answer.answer +=', 'if (false) answer.answer +=');
  const broken = await f.ask(summaryQuestion, answer);
  assert.throws(() => postedContract(broken), { name: 'AssertionError' });
  expenseContract(broken);
});
