// Candidate 4 review fixes (2026-11-12). Each case was a wrong figure at High
// (or a fold regression in confidence) in the candidate 4 money review. The
// founder rule keeps unproved dollars counted and flagged, so these tests pin
// the figure unchanged and require the answer to drop below High with a
// reason. Proved controls stay High; the later party-certificate rules lower the
// incomplete controls without changing their figures. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { overviewFixture } from './helpers/money-overview-fixture.mjs';
import { queryMoney } from '../src/lib/money-query.js';
import { overviewMoney } from '../src/lib/money-overview.js';
import { MONEY_GUIDE } from '../src/lib/money-query-contract.js';

const NOW = Date.parse('2026-11-12T15:00:00Z');
const SYNC = '2026-11-12T09:00:00Z';
const OCT = { period_from: '2026-10-01', period_to: '2026-10-31' };
const P = "posted_on BETWEEN '2026-10-01' AND '2026-10-31'";
const PROFIT = `SELECT tenant_id,currency,SUM(income_minor)-SUM(expense_minor) AS cash_profit_minor,SUM(income_minor) AS income_minor,SUM(expense_minor) AS expense_minor FROM txn WHERE side='business' AND ${P} GROUP BY tenant_id,currency ORDER BY tenant_id,currency`;
const SPEND = `SELECT tenant_id,side,currency,SUM(expense_minor) AS spending_minor,SUM(CASE WHEN estimated=1 THEN expense_minor ELSE 0 END) AS likely_spending_minor FROM txn WHERE ${P} AND expense_minor>0 GROUP BY tenant_id,side,currency ORDER BY tenant_id,side,currency`;
const INC = `SELECT SUM(income_minor) AS income_minor FROM txn WHERE ${P}`;
const recipe = name => MONEY_GUIDE.split('\n').find((line, i, all) => line.startsWith('SELECT ') && all[i - 1].startsWith(name + ':'))
  .replaceAll('2026-09-01', '2026-10-01').replaceAll('2026-09-30', '2026-10-31');

function book(t, { entity = 'biz' } = {}) {
  const f = overviewFixture(t);
  f.env.BRAIN_TIMEZONE = 'UTC';
  f.run("INSERT INTO fin_entities(entity_slug,legal_name,kind,provenance,basis_state,recorded_at) VALUES ('biz','Business role','business','owner_stated','confirmed','2025-12-31T18:00:00Z')");
  f.acct = (slug, o = {}) => {
    const kind = o.kind ?? 'checking', mode = o.mode ?? 'live';
    f.account(slug, mode, kind, 'USD', 'open');
    f.run('UPDATE fin_accounts SET mask=?,balance_role=?,entity_slug=?,label=?,institution=? WHERE account_slug=?',
      o.mask ?? '1111', kind === 'card' ? 'liability' : 'asset', o.entity ?? entity, o.label ?? slug, o.institution ?? null, slug);
    if (o.opened) f.run('UPDATE fin_accounts SET opened_on=? WHERE account_slug=?', o.opened, slug);
    if (mode === 'live') { f.connection(slug, o.provider ?? 'plaid'); f.run('UPDATE bank_feed_items SET last_synced_at=? WHERE item_ref=?', SYNC, slug); }
    const [a, b] = o.cover ?? ['2025-01-01', '2026-11-12']; f.coverage(slug, a, b);
  };
  f.tx = (uid, slug, day, cents, direction, x = {}) => {
    f.row(uid, slug, day, cents, direction, x);
    f.run("UPDATE fin_transactions SET source_feed='synthetic-feed',category=?,category_basis_state=?,payee=?,provenance='feed' WHERE txn_uid=?",
      x.category ?? null, 'confirmed', x.payee ?? null, uid);
  };
  f.ask = (sql, extra = OCT) => queryMoney(f.env, { sql, ...extra }, { now: () => NOW });
  return f;
}
const below = (r, label) => assert.ok(r.confidence.percent < 90, `${label}: ${r.confidence.level} ${r.confidence.percent}`);
const controlConfidence = (r, label) => {
  // 0.4.28 closed-world party and query certificates lower these historical controls.
  const reviewedScores = { 'clean fee book': 89, 'categorized income, windowed': 55, 'customer payment, full read': 89, 'customer and supplier only': 55, 'guide Income': 89, 'ordinary spending': 63 };
  if (label in reviewedScores) {
    assert.equal(r.confidence.percent, reviewedScores[label], label);
    assert.ok(r.confidence.reasons.some(reason => /certificate|certified/.test(reason)), label + ': certificate decision reached');
    assert.ok(r.confidence.missing.length, label + ': missing proof stays explicit');
  } else assert.ok(r.confidence.percent >= 90, `${label}: ${r.confidence.level} ${r.confidence.percent} ${r.confidence.reasons.join(' | ')}`);
};

test("R1: a LIKE '%fee%' or '%interest%' detail filter is not a closed fee or interest list", async t => {
  const fees = `SELECT SUM(expense_minor) AS fees_minor FROM txn WHERE ${P} AND lower(description) LIKE '%fee%'`;
  const f = book(t); f.acct('chk');
  f.tx('f1', 'chk', '2026-10-03', 1500, 'outflow', { description: 'MONTHLY SERVICE FEE' });
  f.tx('f2', 'chk', '2026-10-04', 2500, 'outflow', { description: 'WIRE TRANSFER FEE' });
  f.tx('c1', 'chk', '2026-10-05', 645, 'outflow', { description: 'STARBUCKS COFFEE #1234', payee: 'Starbucks' });
  f.tx('c2', 'chk', '2026-10-12', 38900, 'outflow', { description: 'COFFEE BEAN DIRECT WHOLESALE', payee: 'Coffee Bean Direct' });
  const r = await f.ask(fees);
  assert.equal(r.rows[0].fees_minor, 43545); below(r, 'coffee fee');
  assert.match(r.confidence.reasons.join(' '), /\$395\.45 in 2 posting\(s\) match '%fee%' only inside another word/);

  const g = book(t); g.acct('card', { kind: 'card', mask: '4444' });
  g.tx('i1', 'card', '2026-10-25', 4210, 'outflow', { description: 'INTEREST CHARGE ON PURCHASES' });
  g.tx('i2', 'card', '2026-10-25', 1890, 'outflow', { description: 'FINANCE CHARGE' });
  g.tx('p1', 'card', '2026-10-10', 9900, 'outflow', { description: 'INTERESTING DEVELOPMENT LLC', payee: 'Interesting Development' });
  const i = await g.ask(`SELECT SUM(expense_minor) AS interest_minor FROM txn WHERE ${P} AND lower(description) LIKE '%interest%'`);
  assert.equal(i.rows[0].interest_minor, 14110); below(i, 'interesting');
  assert.match(i.confidence.reasons.join(' '), /\$18\.90 in 1 posting\(s\) look like interest/);

  const c = book(t); c.acct('chk');
  c.tx('f1', 'chk', '2026-10-03', 1500, 'outflow', { description: 'MONTHLY SERVICE FEE' });
  c.tx('f2', 'chk', '2026-10-04', 2500, 'outflow', { description: 'WIRE TRANSFER FEE' });
  c.tx('s1', 'chk', '2026-10-05', 6400, 'outflow', { description: 'SAFEWAY 1234', payee: 'Safeway' });
  const control = await c.ask(fees);
  assert.equal(control.rows[0].fees_minor, 4000); controlConfidence(control, 'clean fee book');
});

function refundBook(t, entity = 'biz', refundText = 'THE HOME DEPOT #0456', payee = 'The Home Depot') {
  const f = book(t, { entity }); f.acct('chk');
  f.tx('c1', 'chk', '2026-10-02', 350000, 'inflow', { description: entity === 'biz' ? 'ACME CORP ACH PMT' : 'ACME PAYROLL', payee: 'Acme Corp' });
  f.tx('buy', 'chk', '2026-09-18', 180000, 'outflow', { description: payee.toUpperCase() + ' #0456', payee });
  f.tx('ref', 'chk', '2026-10-08', 180000, 'inflow', { description: refundText, payee });
  return f;
}

test('R2: a windowed read cannot certify payee deposits as income at High', async t => {
  const f = refundBook(t);
  const full = await f.ask(PROFIT);
  assert.equal(full.rows[0].income_minor, 530000); below(full, 'full history read');
  const windowed = await f.ask(PROFIT, { ...OCT, from: '2026-10-01', through: '2026-10-31' });
  assert.equal(windowed.rows[0].income_minor, 530000); below(windowed, 'from/through read');
  assert.match(windowed.confidence.reasons.join(' '), /earlier history was not read/);

  // Control: a trusted income category is not a payee guess, and the full
  // read of a customer-only book stays High.
  const c = book(t); c.acct('chk');
  c.tx('c1', 'chk', '2026-10-02', 350000, 'inflow', { description: 'ACME CORP ACH PMT', payee: 'Acme Corp', category: 'INCOME' });
  c.tx('s1', 'chk', '2026-10-05', 120000, 'outflow', { description: 'OFFICE DEPOT', payee: 'Office Depot' });
  controlConfidence(await c.ask(PROFIT, { ...OCT, from: '2026-10-01', through: '2026-10-31' }), 'categorized income, windowed');
  const d = book(t); d.acct('chk');
  d.tx('c1', 'chk', '2026-10-02', 350000, 'inflow', { description: 'ACME CORP ACH PMT', payee: 'Acme Corp' });
  controlConfidence(await d.ask(PROFIT), 'customer payment, full read');
});

test('R3: income keywords do not switch off the vendor-credit check', async t => {
  for (const [text, payee] of [['BEST BUY SALES RETURN', 'Best Buy'], ['THE HOME DEPOT CUSTOMER CREDIT', 'The Home Depot']]) {
    const f = refundBook(t, 'owner', text, payee);
    const r = await f.ask(INC);
    assert.equal(r.rows[0].income_minor, 530000); below(r, text);
  }
  const c = book(t, { entity: 'owner' }); c.acct('chk');
  c.tx('c1', 'chk', '2026-10-02', 350000, 'inflow', { description: 'ACME PAYROLL', payee: 'Acme Corp' });
  controlConfidence(await c.ask(INC), 'payroll control');
});

test('R4: tax refunds, lender draws, own-money moves and rewards are counted and flagged, not certified income', async t => {
  for (const [entity, description, payee, minor, want] of [
    ['biz', 'CA FTB TAX REF', 'Franchise Tax Board', 84000, 434000],
    ['biz', 'FUNDBOX INC DRAW', 'Fundbox', 1000000, 1350000],
    ['biz', 'KABBAGE FUNDING', 'Kabbage', 1000000, 1350000],
    ['owner', 'SCHWAB BROKERAGE MONEYLINK', 'Charles Schwab', 500000, 850000],
    ['owner', 'VENMO CASHOUT', 'Venmo', 40000, 390000],
    ['owner', 'AMERICAN EXPRESS REWARDS', 'American Express', 15000, 365000],
  ]) {
    const f = book(t, { entity }); f.acct('chk');
    f.tx('c1', 'chk', '2026-10-02', 350000, 'inflow', { description: 'ACME CORP ACH PMT', payee: 'Acme Corp' });
    f.tx('s1', 'chk', '2026-10-05', 120000, 'outflow', { description: 'OFFICE DEPOT', payee: 'Office Depot' });
    f.tx('x', 'chk', '2026-10-14', minor, 'inflow', { description, payee });
    const r = await f.ask(entity === 'biz' ? PROFIT : INC);
    assert.equal(r.rows[0].income_minor, want, description); below(r, description);
  }
  const c = book(t); c.acct('chk');
  c.tx('c1', 'chk', '2026-10-02', 350000, 'inflow', { description: 'ACME CORP ACH PMT', payee: 'Acme Corp' });
  c.tx('s1', 'chk', '2026-10-05', 120000, 'outflow', { description: 'OFFICE DEPOT', payee: 'Office Depot' });
  controlConfidence(await c.ask(PROFIT), 'customer and supplier only');
});

test('R5: money moved to investments and card cash advances are not certified spending', async t => {
  const f = book(t, { entity: 'owner' }); f.acct('chk');
  f.tx('s1', 'chk', '2026-10-05', 20000, 'outflow', { description: 'SAFEWAY', payee: 'Safeway' });
  f.tx('s2', 'chk', '2026-10-06', 500000, 'outflow', { description: 'SCHWAB BROKERAGE MONEYLINK', payee: 'Charles Schwab' });
  f.tx('s3', 'chk', '2026-10-07', 300000, 'outflow', { description: 'VANGUARD BUY INVESTMENT', payee: 'Vanguard' });
  const r = await f.ask(SPEND);
  // 0.4.28 party certification also marks the uncategorized grocery purchase as likely.
  assert.equal(r.rows[0].spending_minor, 820000); assert.equal(r.rows[0].likely_spending_minor, 820000); below(r, 'investments');
  for (const description of ['ATM CASH ADVANCE', 'CONVENIENCE CHECK 1001']) {
    const g = book(t, { entity: 'owner' }); g.acct('card', { kind: 'card', mask: '4444' });
    g.tx('s1', 'card', '2026-10-05', 20000, 'outflow', { description: 'SAFEWAY', payee: 'Safeway' });
    g.tx('ca', 'card', '2026-10-06', 300000, 'outflow', { description });
    const c = await g.ask(SPEND);
    // 0.4.28 loan-proceeds policy excludes ATM advances; convenience checks remain counted.
    assert.equal(c.rows[0].spending_minor, description==='ATM CASH ADVANCE'?20000:320000);
    assert.equal(c.rows[0].likely_spending_minor, description==='ATM CASH ADVANCE'?20000:320000); below(c, description);
    if(description==='ATM CASH ADVANCE') assert.match(c.confidence.reasons.join(' '), /3,000\.00/);
  }
  const c = book(t, { entity: 'owner' }); c.acct('chk');
  c.tx('s1', 'chk', '2026-10-05', 20000, 'outflow', { description: 'SAFEWAY', payee: 'Safeway' });
  c.tx('s4', 'chk', '2026-10-06', 4500, 'outflow', { description: 'INVESTORS TITLE PRINTING', payee: 'Investors Title' });
  controlConfidence(await c.ask(SPEND), 'ordinary spending');
});

test('R6: an unmatched card payment credit flags an equal bank debit without payment wording', async t => {
  const run = async (debitMinor, label) => {
    const f = book(t, { entity: 'owner' }); f.acct('chk', { label: 'Checking', institution: 'Wells Fargo' });
    f.acct('card', { kind: 'card', mask: '4444', label: 'Card', institution: 'Card Bank' });
    f.tx('p1', 'card', '2026-10-03', 125000, 'outflow', { description: 'BEST BUY 00123', payee: 'Best Buy' });
    f.tx('p2', 'card', '2026-10-09', 40000, 'outflow', { description: 'WHOLE FOODS', payee: 'Whole Foods' });
    f.tx('s1', 'chk', '2026-10-11', 20000, 'outflow', { description: 'SHELL OIL 123', payee: 'Shell' });
    f.tx('pay', 'chk', '2026-10-15', debitMinor, 'outflow', { description: 'WELLS FARGO CARD CCPYMT' });
    f.tx('cr', 'card', '2026-10-19', 250000, 'inflow', { description: 'PAYMENT RECEIVED - THANK YOU' });
    return [await f.ask(SPEND), label];
  };
  const [r] = await run(250000, 'equal');
  // 0.4.28 party certification also marks the uncategorized grocery purchase as likely.
  assert.equal(r.rows[0].spending_minor, 435000); assert.equal(r.rows[0].likely_spending_minor, 290000); below(r, 'lagged equal debit');
  const [c] = await run(240000, 'unequal');
  assert.equal(c.rows[0].likely_spending_minor, 40000, 'only the uncategorized grocery purchase is likely; unequal debit is not nominated');
});

test("guide Income recipe (income_minor<>0) keeps the proved scope on a complete live book", async t => {
  const f = book(t); f.acct('chk', { opened: '2025-06-01', cover: ['2025-06-01', '2026-11-12'] });
  f.tx('c', 'chk', '2026-10-02', 300000, 'inflow', { description: 'ACME CORP ACH PMT', payee: 'Acme Corp', category: 'INCOME' });
  f.tx('s', 'chk', '2026-10-05', 120000, 'outflow', { description: 'OFFICE DEPOT', payee: 'Office Depot', category: 'GENERAL_MERCHANDISE' });
  const sql = recipe('Income');
  assert.match(sql, /income_minor<>0/);
  const r = await f.ask(sql);
  assert.equal(r.rows.reduce((n, row) => n + row.income_minor, 0), 300000); controlConfidence(r, 'guide Income');
  const positive = await f.ask(sql.replace('income_minor<>0', 'income_minor>0'));
  assert.equal(positive.confidence.percent, r.confidence.percent);
});

test('a period before every recorded account is not a proved zero; the control period stays High', async t => {
  const f = book(t); f.acct('op', { opened: '2024-03-01', cover: ['2024-03-01', '2026-11-12'] });
  f.tx('i', 'op', '2026-10-06', 2000000, 'inflow', { description: 'CLIENT INCOME', category: 'INCOME', payee: 'client' });
  const r = await f.ask("SELECT SUM(income_minor) AS x FROM txn WHERE posted_on BETWEEN '2019-01-01' AND '2019-12-31'", {});
  assert.equal(r.rows[0].x, null); assert.ok(r.confidence.percent < 70, `${r.confidence.percent}`);
  assert.match(r.confidence.reasons.join(' '), /No recorded account was open between 2019-01-01 and 2019-12-31/);
  controlConfidence(await f.ask("SELECT SUM(income_minor) AS x FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31'"), 'October 2026');
});

test('the money overview of a SimpleFIN book is not capped by pending collection and names the gap', async t => {
  for (const provider of ['plaid', 'simplefin']) {
    const f = overviewFixture(t);
    f.account('deposit', 'live'); f.connection('deposit', provider);
    f.run('UPDATE bank_feed_items SET last_synced_at=?', '2025-12-31T18:00:00Z');
    f.run("UPDATE fin_accounts SET opened_on='2025-06-01'");
    f.coverage('deposit', '2025-06-01', '2025-12-31');
    for (const m of ['06', '07', '08', '09', '10', '11', '12']) {
      f.row('in' + m, 'deposit', `2025-${m}-05`, 300000, 'inflow', { description: 'Customer payment' });
      f.row('out' + m, 'deposit', `2025-${m}-12`, 120000, 'outflow', { description: 'Supplier purchase' });
    }
    f.run("UPDATE fin_transactions SET category='PURCHASE',category_basis_state='confirmed' WHERE direction='outflow'");
    f.run("UPDATE fin_transactions SET category='INCOME',category_basis_state='confirmed' WHERE direction='inflow'");
    const o = await overviewMoney(f.env, { now: () => Date.parse('2025-12-31T18:00:00Z') });
    // 0.4.28 grouped overview requires party attribution proof for High.
    assert.equal(o.confidence.percent, 89, provider);
    if (provider === 'simplefin') {
      assert.match(o.coverage_text, /Pending not counted: not collected by this feed \(amount unknown\)/);
      assert.match(o.confidence.reasons.join(' '), /pending not collected by this feed/);
    } else assert.equal(o.confidence.percent, 89);
  }
});
