import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from '../worker/test/ledger-review-fixture.mjs';
import { maintainAccountKind } from '../worker/src/lib/fin-account-kinds.js';
import { ledgerAccounts, ledgerCashPosition } from '../worker/src/lib/fin-d1.js';
import { readEffectiveAccounts } from '../worker/src/lib/ledger-reader.js';
import { withLedgerAnswer } from '../worker/src/lib/ledger-answer.js';

const NOW = '2026-10-31T19:00:00.000Z';
let network = 0;
globalThis.fetch = () => { network++; throw Error('offline only'); };
test.after(() => assert.equal(network, 0));

function seed(t, { maintain = maintainAccountKind, cash = ledgerCashPosition, answer = withLedgerAnswer } = {}) {
  const f = fixture(t); f.owner();
  for (const [slug, mask, kind, role] of [['cash','3131','checking','asset'], ['debt','4242','other','neither']]) {
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,mask,account_kind,balance_role,label,feed_mode,
      external_ref,source_feed,provenance,basis_state,recorded_at)
      VALUES (?,'owner',?,?,?,?, 'live',?,'bank-feed:synthetic','feed','confirmed',?)`,
    slug,mask,kind,role,slug,`provider-${slug}`,NOW);
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,
      computed_at,provenance,basis_state,recorded_at)
      VALUES (?,'complete','2026-10-01','2026-10-31',?,'owner_stated','confirmed',?)`,slug,NOW,NOW);
  }
  f.plan = (extra = {}) => maintain(f.env, { selector:'debt',kind:'loan',now:NOW,...extra });
  f.apply = async (extra = {}) => {
    const plan = await f.plan(extra);
    assert.equal(plan.accounts.length, 1, 'exact account selection reached');
    assert.equal(plan.blocked, false);
    return f.plan({ ...extra,dryRun:false,approve:plan.plan_hash });
  };
  f.cash = () => cash(f.env);
  f.balance = (slug, amount) => f.raw(`INSERT INTO fin_balance_snapshots
    (account_slug,as_of_date,current_minor,provenance,source_feed,basis_state,recorded_at)
    VALUES (?,'2026-10-31',?,'feed','bank-feed:synthetic','confirmed',?)`,slug,amount,NOW);
  f.transaction = (uid, amount, description = 'supplies', payee = 'store') => f.raw(`INSERT INTO fin_transactions
    (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,provenance,basis_state,recorded_at)
    VALUES (?,'cash','2026-10-12',?,'outflow',?,?,'owner_stated','confirmed',?)`,uid,amount,description,payee,NOW);
  f.ask = async (question = 'What are my expenses in October 2026?') => {
    const before = f.calls.length;
    const body = await (await answer({ env:f.env,question,now:NOW,
      grantScope:{all:true},scopePrincipalKind:'owner' },gap => Response.json({answer:null,gaps:[gap]}))).json();
    assert.ok(f.calls.slice(before).some(sql => sql.includes('JOIN fin_transactions')), 'real payment query reached');
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 2, 'nonempty payment input');
    return body;
  };
  return f;
}

async function approvalProbe(t, overrides) {
  const f = seed(t, overrides);
  f.balance('cash',100000); f.balance('debt',900000);
  f.raw("UPDATE fin_accounts SET account_kind='loan',balance_role='liability' WHERE account_slug='debt'");
  const before = await f.cash();
  assert.equal(before.total_minor,100000, 'known-loan green control');
  assert.ok(before.excluded.some(a => a.account_slug === 'debt' && a.reason === 'money_owed_not_held'));
  const history = f.rows('SELECT * FROM fin_account_kind_reviews');
  for (const kind of ['checking','savings']) {
    const start = f.calls.length, plan = await f.plan({kind});
    assert.ok(f.calls.length > start, 'provider observation decision reached');
    assert.equal(plan.accounts.length,1);
    assert.equal(plan.accounts[0].provider_role,'liability');
    assert.equal(plan.blocked,true);
    assert.equal(plan.balance_conflict,'provider_liability_deposit_review');
    const calls = f.calls.length;
    await assert.rejects(f.plan({kind,dryRun:false,approve:plan.plan_hash}), /blocked/);
    assert.ok(f.calls.length > calls, 'apply reached the conflict decision');
    assert.deepEqual(f.rows('SELECT * FROM fin_account_kind_reviews'),history);
    assert.equal((await f.cash()).total_minor,100000);
  }
  f.raw("UPDATE fin_accounts SET account_kind='other',balance_role='neither' WHERE account_slug='debt'");
  assert.equal((await f.apply({kind:'checking'})).mutation_count,1,'ordinary unknown-to-deposit control');
  assert.equal((await f.cash()).total_minor,1000000);
  await f.apply({kind:undefined,revoke:true});
  assert.equal((await f.cash()).total_minor,100000,'revocation control');
}
test('R4 provider liability blocks deposit approval with explicit preview conflict', t => approvalProbe(t));

async function storedProbe(t, overrides) {
  const f = seed(t, overrides);
  f.balance('cash',100000); f.balance('debt',900000);
  const approval = await f.apply({kind:'checking'});
  assert.equal((await f.cash()).total_minor,1000000,'unknown-to-checking green control');
  const history = f.rows('SELECT * FROM fin_account_kind_reviews');
  // Provider kind/role are observations, not identity. This also represents a
  // durable conflicting review saved by an older runtime before the guard.
  f.raw("UPDATE fin_accounts SET account_kind='loan',balance_role='liability' WHERE account_slug='debt'");
  const row = (await ledgerAccounts(f.env)).accounts.find(a => a.account_slug === 'debt');
  assert.equal(row.account_kind_review.state,'current');
  assert.equal(row.provider_account_kind,'loan'); assert.equal(row.provider_balance_role,'liability');
  assert.deepEqual(f.rows('SELECT * FROM fin_account_kind_reviews'),history);
  const start = f.calls.length, cash = await f.cash();
  assert.ok(f.calls.slice(start).some(sql => sql.includes('FROM fin_accounts')), 'current review inventory reached');
  assert.ok(cash.covered.some(a => a.account_slug === 'cash'), 'ordinary cash balance query reached');
  assert.equal(cash.total_minor,null,'type review cannot certify a provider amount owed as money held');
  assert.equal(cash.unavailable,true); assert.equal(cash.complete,false);
  assert.ok(cash.missing.some(a => a.account_slug === 'debt' && a.reason === 'account_kind_balance_conflict'));
  assert.ok(!cash.covered.some(a => a.account_slug === 'debt'));
  const retry = await f.plan({kind:'checking'});
  assert.equal(retry.blocked,true,'an existing approval cannot bypass the conflict');
  const calls = f.calls.length;
  await assert.rejects(f.plan({kind:'checking',dryRun:false,approve:approval.plan_hash}), /blocked/);
  assert.ok(f.calls.length > calls, 'stored approval replay reached the conflict decision');
  assert.deepEqual(f.rows('SELECT * FROM fin_account_kind_reviews'),history);
  await f.apply({kind:undefined,revoke:true});
  assert.equal((await f.cash()).total_minor,100000,'revocation restores provider exclusion');
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_account_kind_reviews').n,1,'history retained');
}
test('R4 stored conflicting deposit review withholds cash and remains revocable', t => storedProbe(t));

async function repaymentProbe(t, overrides) {
  const f = seed(t, overrides);
  f.transaction('store',21000);
  f.transaction('own',40000,'payment to account 4242','payment');
  assert.equal((await f.ask()).gaps[0].reason,'ledger_account_kind_review_required');
  for (const kind of ['loan','card','line_of_credit']) {
    await f.apply({kind});
    const body = await f.ask();
    assert.equal(body.ledger.expense_total_minor,21000,'supported repayment subtype control');
    assert.equal(body.ledger.own_account_payments.total_minor,40000);
    assert.equal(body.ledger.own_account_payments.card_minor,kind === 'card' ? 40000 : 0);
    assert.equal(body.ledger.own_account_payments.loan_minor,kind === 'card' ? 0 : 40000);
  }
  await f.apply({kind:'other',role:'liability'});
  const row = (await readEffectiveAccounts(f.env)).find(a => a.account_slug === 'debt');
  assert.equal(row.account_kind_review.state,'current'); assert.equal(row.balance_role,'liability');
  const body = await f.ask();
  assert.equal(body.answer,null,'unsupported subtype withholds the expense headline');
  assert.equal(body.gaps[0].reason,'ledger_account_kind_review_required');
  assert.notEqual(body.ledger?.complete,true);
  assert.equal(body.ledger?.expense_total_minor,undefined);
  f.raw("UPDATE fin_transactions SET payee='outside lender' WHERE txn_uid='own'");
  assert.equal((await f.ask()).ledger.expense_total_minor,61000,'outside-payee control remains an expense');
  f.raw("UPDATE fin_transactions SET payee='payment',description='payment to account 9999' WHERE txn_uid='own'");
  assert.equal((await f.ask()).ledger.expense_total_minor,61000,'unmatched locator cannot prove ownership');
}
test('R5 reviewed other liability retains the directed-owned-payment uncertainty guard', t => repaymentProbe(t));

async function storedRepaymentProbe(t, overrides, { kind = 'checking', providerKind = 'loan', locator = 'account 4242' } = {}) {
  const f = seed(t, overrides);
  f.transaction('store',21000);
  f.transaction('own',40000,`payment to ${locator}`,'payment');
  f.balance('cash',100000); f.balance('debt',900000);
  await f.apply({kind:'loan'});
  const green = await f.ask();
  assert.equal(green.ledger.expense_total_minor,21000,'supported loan review control');
  assert.equal(green.ledger.own_account_payments.total_minor,40000);
  await f.apply({kind});
  f.raw("UPDATE fin_accounts SET account_kind=?,balance_role='liability' WHERE account_slug='debt'",providerKind);
  const history = f.rows('SELECT * FROM fin_account_kind_reviews');
  const debt = (await readEffectiveAccounts(f.env)).find(a => a.account_slug === 'debt');
  assert.equal(debt.provider_account_kind,providerKind);
  assert.equal(debt.provider_balance_role,'liability');
  assert.equal(debt.account_kind_review.state,'current');
  assert.equal(debt.account_kind,kind,'stored conflicting overlay is exercised');
  const body = await f.ask();
  const ranking = await f.ask('What are my largest expenses in October 2026?');
  const cash = await f.cash();
  assert.equal(cash.total_minor,null,'cash conflict control');
  assert.equal(cash.unavailable,true);
  assert.deepEqual(f.rows('SELECT * FROM fin_account_kind_reviews'),history,'reads preserve review history');
  f.raw("UPDATE fin_transactions SET payee='outside lender' WHERE txn_uid='own'");
  assert.equal((await f.ask()).ledger.expense_total_minor,61000,'explicit outside-payee control');
  f.raw("UPDATE fin_transactions SET payee='payment',description='payment to account 9999' WHERE txn_uid='own'");
  assert.equal((await f.ask()).ledger.expense_total_minor,61000,'unmatched locator control');
  f.raw("UPDATE fin_transactions SET description=? WHERE txn_uid='own'",`payment to ${locator}`);
  const revoked = await f.apply({kind:undefined,revoke:true});
  assert.equal(revoked.mutation_count,1);
  const restored = await f.ask();
  if (providerKind !== 'other') {
    assert.equal(restored.ledger.expense_total_minor,21000,'revocation restores provider repayment control');
    assert.equal(restored.ledger.own_account_payments.total_minor,40000);
  } else assert.equal(restored.code,'ledger_account_kind_review_required','unknown provider subtype still needs review');
  assert.equal(f.rows('SELECT * FROM fin_account_kind_reviews').length,history.length,'revocation preserves history');
  await f.apply({kind:'loan'});
  const supported = await f.ask();
  assert.equal(supported.ledger.expense_total_minor,21000,'supported replacement review control');
  assert.equal(supported.ledger.own_account_payments.total_minor,40000);
  assert.equal(body.answer,null,'conflicted deposit review withholds the ordinary-expense headline');
  for (const result of [body,ranking]) {
    assert.equal(result.code,'ledger_account_kind_review_required');
    assert.equal(result.gaps[0].reason,'ledger_account_kind_review_required');
    assert.equal(result.evidence_gate.complete,false);
    assert.equal(result.ledger?.expense_total_minor,undefined);
    assert.equal(result.ledger?.own_account_payments,undefined,'a conflict cannot establish a repayment bucket');
  }
}

for (const providerKind of ['loan','card','line_of_credit','other']) {
  for (const kind of ['checking','savings']) {
    test(`R6 saved ${kind} conflict with provider ${providerKind} withholds expense totals and ranking`,
      t => storedRepaymentProbe(t,undefined,{kind,providerKind}));
  }
}
test('R6 a stated loan locator still reaches the saved deposit conflict',
  t => storedRepaymentProbe(t,undefined,{locator:'loan 4242'}));

// Execute restored product decisions through the same SQLite and answer probes.
// Data modules replace only the named site; relative imports still use the repo.
const moduleSource = (source, url) => `data:text/javascript;base64,${Buffer.from(source.replace(
  /from (['"])(\.\/.+?)\1/g, (_, quote, path) => `from ${JSON.stringify(new URL(path, url).href)}`)).toString('base64')}`;
async function restored(file, from, to) {
  const url = new URL(`../worker/src/lib/${file}`, import.meta.url), source = readFileSync(url, 'utf8');
  assert.equal(source.split(from).length - 1, 1, 'exactly one restoring product site');
  const changed = source.replace(from, to);
  assert.notEqual(changed, source);
  const target = moduleSource(changed, url);
  if (file !== 'ledger-analysis.js') return import(target);
  const answerUrl = new URL('../worker/src/lib/ledger-answer.js', import.meta.url);
  const answer = readFileSync(answerUrl, 'utf8').replace('from "./ledger-analysis.js"', `from "${target}"`);
  assert.notEqual(answer, readFileSync(answerUrl, 'utf8'), 'answer uses the restored classifier');
  return import(moduleSource(answer, answerUrl));
}

test('restoring R4 approval decision fails the same loan preview probe', async t => {
  await approvalProbe(t);
  const mutant = await restored('fin-account-kinds.js',
    "const balanceConflict = !revoke &&", "const balanceConflict = false && !revoke &&");
  await assert.rejects(approvalProbe(t, { maintain:mutant.maintainAccountKind }),
    error => error.code === 'ERR_ASSERTION' && error.actual === false && error.expected === true);
});

test('restoring R4 cash decision republishes the positive amount owed', async t => {
  await storedProbe(t);
  const mutant = await restored('fin-d1.js',
    'const conflicts = considered.filter(a =>', 'const conflicts = considered.filter(a => false &&');
  await assert.rejects(storedProbe(t, { cash:mutant.ledgerCashPosition }),
    error => error.code === 'ERR_ASSERTION' && error.actual === 1000000 && error.expected === null);
});

test('restoring R5 role exception fails the same reviewed-liability probe', async t => {
  await repaymentProbe(t);
  const mutant = await restored('ledger-analysis.js',
    ".some(account => account?.account_kind === 'other' || hasAccountKindConflict(account));",
    ".some(account => account?.account_kind === 'other' && account.balance_role === 'neither' || hasAccountKindConflict(account));");
  await assert.rejects(repaymentProbe(t, { answer:mutant.withLedgerAnswer }),
    error => error.code === 'ERR_ASSERTION' && /You spent \$610\.00/.test(error.actual) && error.expected === null);
});

test('restoring R6 payment decision certifies the same conflicted repayment as spending', async t => {
  await storedRepaymentProbe(t);
  const mutant = await restored('ledger-analysis.js',
    ".some(account => account?.account_kind === 'other' || hasAccountKindConflict(account));",
    ".some(account => account?.account_kind === 'other');");
  await assert.rejects(storedRepaymentProbe(t,{answer:mutant.withLedgerAnswer}),
    error => error.code === 'ERR_ASSERTION' && /You spent \$610\.00/.test(error.actual) && error.expected === null);
});
