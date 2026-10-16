import test from 'node:test';
import { readBankExport } from '../src/lib/bank-export.js';
import { importBankExport, prepareBankExportImport } from '../src/lib/fin-import.js';
import { importBankExport as importLegacyBankExport } from '../../test/fixtures/ledger-schema48/fin-import.mjs';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { handleOwnerBankImport, OWNER_BANK_IMPORT_PREVIEW_PATH, OWNER_BANK_IMPORT_COMMIT_PATH } from '../src/lib/owner-bank-import.js';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';

export const NOW = '2034-07-15T12:00:00Z';
export const PERIOD = 'in June 2034';
const migrations = new URL('../../migrations/d1/', import.meta.url);
const schema = readdirSync(migrations).filter(f => f.endsWith('.sql')).sort()
  .map(f => readFileSync(new URL(f, migrations), 'utf8')).join('\n');

// No server, CLI, credential, model, provider, or host process is used.
globalThis.fetch = async () => { throw new Error('network forbidden in offline probe'); };

export function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schema);
  t.after(() => sqlite.close());
  const seen = { sql: [], rowCounts: [], fallbacks: 0, gaps: [] };
  const execute = (sql, params, mode = 'all') => {
    seen.sql.push(sql);
    const stmt = sqlite.prepare(sql);
    if (mode === 'first') return stmt.get(...params) ?? null;
    if (mode === 'run') return { meta: { changes: Number(stmt.run(...params).changes) } };
    const results = stmt.all(...params); seen.rowCounts.push(results.length);
    return { results };
  };
  const prepare = (sql, params = []) => ({ sql, params,
    bind: (...args) => prepare(sql, args),
    all: async () => execute(sql, params),
    first: async () => execute(sql, params, 'first'),
    run: async () => execute(sql, params, 'run'),
  });
  const DB = { prepare, async batch(statements) {
    sqlite.exec('BEGIN');
    try {
      const results = statements.map(s => execute(s.sql, s.params,
        /^\s*(SELECT|WITH|PRAGMA)/i.test(s.sql) ? 'all' : 'run'));
      sqlite.exec('COMMIT'); return results;
    } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  } };
  const raw = (sql, ...args) => sqlite.prepare(sql).run(...args);
  const f = { sqlite, raw, seen, env: { DB },
    entity(slug, kind = 'business') {
      raw(`INSERT INTO fin_entities (entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
        VALUES (?,?,?,'owned','owner_stated','confirmed',?)`, slug, slug, kind, NOW);
    },
    account(slug, mask, kind = 'checking', entity = 'business-one', mode = 'live') {
      raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,institution,provenance,basis_state,recorded_at)
        VALUES (?,?,?,?,?,?,'Synthetic Institution','owner_stated','confirmed',?)`, slug, entity, kind,
        ['card', 'loan', 'line_of_credit'].includes(kind) ? 'liability' : 'asset', mask, mode, NOW);
      raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
        VALUES (?,'complete','2034-01-01','2034-07-15',?,'owner_stated','confirmed',?)`, slug, NOW, NOW);
      raw(`INSERT INTO fin_balance_snapshots (account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at)
        VALUES (?,'2034-07-15',100000,'owner_stated','confirmed',?)`, slug, NOW);
    },
    add(id, account, amount, direction, description, { day = '2034-06-15', payee = null, category = null, basis = null } = {}) {
      raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,category,category_basis_state,provenance,basis_state,recorded_at)
        VALUES (?,?,?,?,?,?,?,?,?,'owner_stated','confirmed',?)`, id, account, day, amount, direction, description, payee, category, basis, NOW);
    },
    async ask(question, options = {}) {
      const before = sqlite.prepare('SELECT total_changes() n').get().n;
      const beforeReads = seen.sql.length;
      const response = await withLedgerAnswer({ env: f.env, question, now: NOW,
        grantScope: { all: true }, scopePrincipalKind: 'owner', ...options }, async gap => {
        seen.fallbacks++; seen.gaps.push(gap);
        return new Response(JSON.stringify({ answer: null, gaps: [] }));
      });
      assert.equal(sqlite.prepare('SELECT total_changes() n').get().n, before, 'answer path must be read-only');
      const body = await response.json();
      return body;
    },
  };
  f.entity('business-one'); f.entity('business-two'); f.entity('personal', 'household');
  return f;
}

export function reached(f, body, kind = 'totals') {
  assert.equal(body.ledger?.kind, kind, 'real ledger answer required');
  assert.ok(f.seen.sql.some(sql => /JOIN fin_transactions/.test(sql)), 'real transaction SQL must execute');
  assert.equal(body.evidence_gate.supported, true);
  assert.equal(f.seen.fallbacks, 0, 'must not substitute document retrieval');
}

export const netQuestion = (suffix = '') => `What was my profit ${PERIOD}${suffix}?`;
export const moneyQuestion = (suffix = '') => `How much money came in and went out ${PERIOD}${suffix}?`;

test('R5 C51: unclassified connected account is visible and kind guidance is honest', async t => {
  const f = fixture(t); f.account('unclassified', '26', 'other');
  const all = await f.ask('What are my balances?');
  assert.equal(all.ledger.accounts[0].current_minor, 100000);
  const filtered = await f.ask('What are my card balances?');
  assert.equal(filtered.gaps[0].reason, 'no_accounts');
  assert.ok(f.seen.sql.filter(sql => /FROM fin_accounts a/.test(sql)).length >= 2);
  for (const file of ['money-rules-v3.md', 'money-rules-v3-windows.md']) {
    const text = readFileSync(new URL(`../../templates/owner-contract/${file}`, import.meta.url), 'utf8');
    assert.match(text, /no account was found under that kind, not proof that it is disconnected/i);
    assert.doesNotMatch(text, /that account isn't connected/i);
  }
  f.raw("UPDATE fin_accounts SET account_kind='card',balance_role='liability' WHERE account_slug='unclassified'");
  assert.equal((await f.ask('What are my card balances?')).ledger.accounts[0].current_minor, 100000);
});

test('C15 legacy widened coverage refuses a gap until independently re-established', async t => {
  const f = fixture(t); f.account('operating', '26', 'checking', 'business-one', 'manual');
  f.raw("UPDATE fin_account_coverage SET covered_to='2034-01-31'");
  f.add('january', 'operating', 5000, 'outflow', 'Supplies', { day: '2034-01-15' });
  const envelope = readBankExport('Date,Description,Debit,Credit\n2034-06-15,Supplies,271.39,\n', {
    format: 'csv', name: 'synthetic.csv', accountHint: { accountKey: 'operating', accountKind: 'checking', mask: '26' },
  });
  // Replay the immutable historical writer, not a repair or a hand-edited
  // runtime record. Its old upsert creates the widened complete claim.
  const receipt = await importLegacyBankExport(f.env, envelope, { entitySlug: 'business-one', now: NOW });
  assert.equal(receipt.imported, true); assert.equal(receipt.transactions, 1);
  const coverage = f.sqlite.prepare('SELECT * FROM fin_account_coverage').get();
  assert.equal(coverage.coverage_status, 'complete'); assert.equal(coverage.covered_to, '2034-06-15');
  const refused = await f.ask('How much money came in and went out in March 2034?');
  assert.ok(f.seen.sql.some(sql => /FROM fin_accounts a/.test(sql)));
  assert.equal(refused.ledger, undefined);
  assert.equal(refused.gaps[0].reason, 'coverage_review_required');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM fin_transactions').get().n, 2);
  // Models a separately reviewed recertification, never a product auto-repair.
  f.raw("UPDATE fin_account_coverage SET basis_note='Independently reviewed complete interval' WHERE account_slug='operating'");
  const control = await f.ask('How much money came in and went out in March 2034?');
  assert.equal(control.ledger.accounts[0].debits_minor, 0);
});

for (const amount of [false, true]) for (const payee of [null, 'Outside Buyer'])
test(`C17/C18 sender control amount=${amount} payee=${Boolean(payee)}`, async t => {
  const f = fixture(t); f.account('operating', '26');
  f.add('receipt', 'operating', 81327, 'inflow', 'Zelle from Outside Buyer for Studio Buyer invoice', { payee });
  const payer = await f.ask(`Did the payment ${amount ? 'of $813.27 ' : ''}from Outside Buyer arrive ${PERIOD}?`);
  reached(f, payer, 'payment'); assert.equal(payer.ledger.found, true);
  const subject = await f.ask(`Did the payment ${amount ? 'of $813.27 ' : ''}from Studio Buyer arrive ${PERIOD}?`);
  assert.equal(subject.ledger.found, false);
  const income = await f.ask(`How much income came from Outside Buyer ${PERIOD}?`);
  assert.equal(income.ledger.total_minor, 81327);
});

test('C19 distinct literal conjunction merchants remain distinct', async t => {
  const f = fixture(t); f.account('operating', '26');
  for (const [i, merchant] of ['Tools and Supply', 'Tools & Supply', 'Tools Supply'].entries())
    f.add(`purchase-${i}`, 'operating', (i + 1) * 100, 'outflow', merchant, { payee: merchant });
  const listed = await f.ask(`How much did I spend by merchant ${PERIOD}?`); reached(f, listed, 'merchant');
  assert.equal(listed.ledger.groups.length, 3);
  for (const group of listed.ledger.groups) {
    const body = await f.ask(`How much did I spend at ${group.merchant} ${PERIOD}?`);
    assert.equal(body.ledger.total_minor, group.total_minor);
    assert.equal(body.citations.length, 1);
  }
});

test('C19 unknown sender label cannot round-trip as a certified zero', async t => {
  const f = fixture(t); f.account('operating', '26');
  f.add('unknown', 'operating', 81327, 'inflow', 'Invoice for Studio Buyer');
  const listed = await f.ask(`How much income by merchant ${PERIOD}?`); reached(f, listed, 'merchant');
  assert.equal(listed.ledger.total_minor, 81327);
  assert.equal(listed.ledger.groups[0].merchant, 'unknown merchant');
  const requested = await f.ask(`How much income came from ${listed.ledger.groups[0].merchant} ${PERIOD}?`);
  assert.equal(requested.ledger, undefined);
  assert.equal(requested.gaps[0].reason, 'merchant_selector_unsupported');
});

for (const kind of ['investment', 'card', 'savings']) test(`C21 explicit ${kind} scope survives sender parsing`, async t => {
  const f = fixture(t); f.account('operating', '26'); f.account('selected', '357', kind);
  f.add('receipt-a', 'operating', 48129, 'inflow', 'Transfer from Investment Platform', { payee: 'Investment Platform' });
  f.add('receipt-b', 'selected', 12345, 'inflow', 'Transfer from Investment Platform', { payee: 'Investment Platform' });
  const question = `Did the payment from Investment Platform arrive ${PERIOD} into my ${kind} account ending 357?`;
  const body = await f.ask(question); reached(f, body, 'payment');
  assert.equal(body.citations.length, 1); assert.equal(body.citations[0].amount_minor, 12345);
  assert.equal(body.citations[0].account_mask, '357');
});


test('CONTROL: several entities, payroll, draws, refunds, chargebacks, and bank cents', async t => {
  const f = fixture(t);
  f.account('operating', '26'); f.account('second-business', '357', 'checking', 'business-two');
  f.account('personal-bank', '4682', 'savings', 'personal'); f.account('card', '5793', 'card');
  f.add('receipts', 'operating', 834517, 'inflow', 'Processor batched receipts');
  f.add('payroll', 'operating', 211337, 'outflow', 'Payroll ACH');
  f.add('refund', 'operating', 12023, 'inflow', 'Supplier refund');
  f.add('chargeback', 'operating', 31327, 'outflow', 'Processor chargeback');
  f.add('draw-out', 'operating', 67119, 'outflow', 'TRANSFER TO account 4682');
  f.add('draw-in', 'personal-bank', 67119, 'inflow', 'TRANSFER FROM account 26');
  f.add('other-receipt', 'second-business', 12343, 'inflow', 'Zelle receipt');
  f.add('card-purchase', 'card', 17339, 'outflow', 'Supplies');
  const body = await f.ask(netQuestion()); reached(f, body);
  assert.equal(body.ledger.candidate_transfer_count, 1);
  assert.equal(body.ledger.net_minor, 834517 - 211337 + 12023 - 31327 + 12343 - 17339);
});

for (const conflicting of [false, true]) test(`${conflicting ? 'REGRESSION PM01' : 'CONTROL PM01'}: a memo is not an owned cash transfer`, async t => {
  const f = fixture(t); f.account('operating', '26'); f.account('reserve', '357', 'savings');
  f.add('sale', 'operating', 30000, 'inflow', 'Customer receipt', { day: '2034-06-08' });
  f.add('outgoing', 'operating', 90000, 'outflow', conflicting ? 'Payment to vendor for account 357' : 'Payment to vendor',
    { day: '2034-06-30', payee: 'Outside Supplier' });
  f.add('incoming', 'reserve', 90000, 'inflow', 'Outside customer receipt', { day: '2034-07-01' });
  const body = await f.ask(netQuestion()); reached(f, body);
  assert.equal(body.ledger.candidate_transfer_count, conflicting ? 1 : 0, 'pair decision must run');
  assert.equal(body.ledger.net_minor, -60000, 'June paid an external supplier; July customer receipt is separate');
});

for (const withAmount of [false, true]) test(`${withAmount ? 'REGRESSION PM02' : 'CONTROL PM02'}: adding an amount must not change who paid`, async t => {
  const f = fixture(t); f.account('operating', '26');
  f.add('receipt', 'operating', 81327, 'inflow', 'Transfer from Outside Buyer for Studio Buyer invoice', { payee: 'Outside Buyer' });
  const body = await f.ask(`Did the payment ${withAmount ? 'of $813.27 ' : ''}from Studio Buyer arrive ${PERIOD}?`);
  reached(f, body, 'payment');
  assert.equal(f.seen.rowCounts.at(-1), 1, 'the conflicting receipt was actually read');
  assert.equal(body.ledger.found, false, 'a memo mention must not confirm the wrong payer');
});

for (const payer of ['Settlement Platform', 'Investment Platform']) test(`${payer.startsWith('Investment') ? 'REGRESSION PM09' : 'CONTROL PM09'}: a payer word must not select an account kind`, async t => {
  const f = fixture(t); f.account('operating', '26'); f.account('brokerage', '357', 'investment');
  f.add('receipt', 'operating', 48129, 'inflow', `Transfer from ${payer}`, { payee: payer });
  const body = await f.ask(`Did the payment from ${payer} arrive ${PERIOD}?`); reached(f, body, 'payment');
  assert.ok(f.seen.rowCounts.includes(2), 'both owned accounts were inventoried');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM fin_transactions').get().n, 1, 'the receipt exists');
  assert.equal(body.ledger.found, true, 'payer name is attribution, not an account-kind scope clause');
});

for (const payee of ['Outside Buyer', null]) test(`${payee ? 'CONTROL PM03' : 'REGRESSION PM03'}: merchant income must identify the sender`, async t => {
  const f = fixture(t); f.account('operating', '26');
  f.add('receipt', 'operating', 81327, 'inflow', 'Zelle from Outside Buyer for Studio Buyer invoice', { payee });
  const body = await f.ask(`How much income came from Studio Buyer ${PERIOD}?`); reached(f, body, 'merchant');
  assert.equal(f.seen.rowCounts.at(-1), 1);
  assert.equal(body.ledger.lead_total_minor, 0, 'memo subject is not sender attribution');
});

for (const kind of ['checking', 'card']) test(`C20 cash flow refuses; supported surplus keeps the ${kind} purchase`, async t => {
  const f = fixture(t); f.account('operating', '26');
  if (kind === 'card') f.account('spending', '357', 'card');
  f.add('receipts', 'operating', 200000, 'inflow', 'Batched sales');
  f.add('purchase', kind === 'card' ? 'spending' : 'operating', 80000, 'outflow', 'Supplies purchase');
  const control = await f.ask(netQuestion()); reached(f, control);
  assert.equal(control.ledger.net_minor, 120000);
  const reads = f.seen.sql.length;
  const body = await f.ask(`What was my cash flow ${PERIOD}?`);
  assert.ok(f.seen.sql.length > reads, 'authorized inventory decision reached');
  assert.equal(body.ledger, undefined);
  assert.equal(body.gaps[0].reason, 'cash_flow_unsupported');
  assert.equal(body.evidence_gate.supported, false);
  assert.match(body.gaps[0].detail, /card|cash flow/);
});

for (const twoAccounts of [false, true]) test(`${twoAccounts ? 'DEFERRED C23' : 'CONTROL C23'}: recurring results remain detected and unconfirmed`, async t => {
  const f = fixture(t); f.account('card-one', '26', 'card');
  if (twoAccounts) f.account('card-two', '357', 'card', 'business-two');
  for (const month of ['04', '05', '06']) for (const slug of twoAccounts ? ['card-one', 'card-two'] : ['card-one'])
    f.add(`${slug}-${month}`, slug, 2900, 'outflow', 'Workspace Software', { day: `2034-${month}-15`, payee: 'Workspace Software' });
  const body = await f.ask('What are my recurring charges in Q2 2034?'); reached(f, body, 'recurring');
  assert.equal(f.seen.rowCounts.at(-1), twoAccounts ? 6 : 3);
  assert.equal(body.ledger.monthly_total_minor, twoAccounts ? 0 : 2900);
  assert.match(body.answer, /detected, not confirmed/);
});

for (const merchant of ['Atlas Retail', 'Atlas 12345']) test(`${merchant.includes('12345') ? 'REGRESSION PM06' : 'CONTROL PM06'}: printed labels round-trip or explicitly refuse`, async t => {
  const f = fixture(t); f.account('operating', '26');
  f.add('purchase', 'operating', 27139, 'outflow', merchant, { payee: merchant });
  const listed = await f.ask(`How much did I spend by merchant ${PERIOD}?`); reached(f, listed, 'merchant');
  const label = listed.ledger.groups[0].merchant;
  assert.equal(listed.ledger.total_minor, 27139, 'nonempty by-merchant control');
  const queried = await f.ask(`How much did I spend at ${label} ${PERIOD}?`);
  if (label.includes('[redacted]')) {
    assert.equal(queried.ledger, undefined);
    assert.equal(queried.gaps[0].reason, 'merchant_selector_unsupported');
  } else { reached(f, queried, 'merchant'); assert.equal(queried.ledger.total_minor, 27139); }
});

for (const merchant of ['Tools Supply', 'Tools and Supply']) test(`${merchant.includes(' and ') ? 'REGRESSION PM06' : 'CONTROL PM06'}: unsupported conjunction substitution refuses and the literal label works`, async t => {
  const f = fixture(t); f.account('operating', '26');
  f.add('purchase', 'operating', 27139, 'outflow', merchant, { payee: merchant });
  const listed = await f.ask(`How much did I spend by merchant ${PERIOD}?`); reached(f, listed, 'merchant');
  assert.equal(listed.ledger.total_minor, 27139);
  const label = listed.ledger.groups[0].merchant.replace(/\band\b/g, '&');
  const queried = await f.ask(`How much did I spend at ${label} ${PERIOD}?`);
  if (merchant.includes(' and ')) {
    assert.equal(queried.ledger, undefined);
    assert.equal(queried.gaps[0].reason, 'merchant_selector_ambiguous');
    const exact = await f.ask(`How much did I spend at ${merchant} ${PERIOD}?`);
    assert.equal(exact.ledger.total_minor, 27139);
  } else { reached(f, queried, 'merchant'); assert.equal(queried.ledger.total_minor, 27139); }
});

for (const number of [4, 5001]) test(`${number > 5000 ? 'DEFERRED C22' : 'CONTROL C22'}: oversized counterpart inventory refuses without a figure`, async t => {
  const f = fixture(t); f.account('operating', '26'); f.account('busy', '357', 'checking', 'business-two');
  f.add('sale', 'operating', 87419, 'inflow', 'Customer receipt');
  f.sqlite.exec('BEGIN');
  for (let i = 0; i < number; i++) f.add(`busy-${i}`, 'busy', 100 + i, 'inflow', 'Merchant processor deposit');
  f.sqlite.exec('COMMIT');
  const body = await f.ask(netQuestion(' for account ending 26'));
  assert.ok(f.seen.sql.some(sql => /JOIN fin_transactions/.test(sql)));
  assert.ok(f.seen.rowCounts.includes(number > 5000 ? 5001 : 5), 'bounded row decision executed');
  if (number > 5000) {
    assert.equal(body.ledger, undefined);
    assert.equal(body.gaps[0].reason, 'ledger_unavailable');
  } else assert.equal(body.ledger.net_minor, 87419);
});

for (const outside of [false, true]) test(`CONTROL: selected retirement outgoing leg, boundary=${outside}`, async t => {
  const f = fixture(t); f.account('operating', '26'); f.account('retirement', '357', 'retirement');
  f.add('withdraw-out', 'retirement', 91327, 'outflow', 'TRANSFER TO account 26', { day: '2034-06-30' });
  f.add('withdraw-in', 'operating', 91327, 'inflow', 'TRANSFER FROM account 357', { day: outside ? '2034-07-01' : '2034-06-30' });
  const body = await f.ask(moneyQuestion(' for account ending 357')); reached(f, body);
  assert.equal(body.ledger.candidate_transfer_count, 1);
  // Withdrawal exclusion is licensed only by the selected receiving cash account.
  assert.equal(body.ledger.default_exclusions.withdrawal_minor, 0);
  assert.match(body.answer, /kept|included/, 'a visible reason must explain the retained withdrawal leg');
});


for (const kind of ['loan', 'line_of_credit']) test(`CONTROL: reciprocal ${kind} advance and its inclusion flip`, async t => {
  const f = fixture(t); f.account('operating', '26'); f.account('borrowing', '357', kind);
  f.add('receipt', 'operating', 12347, 'inflow', 'Client receipt');
  f.add('advance-out', 'borrowing', 53719, 'outflow', 'TRANSFER TO account 26');
  f.add('advance-in', 'operating', 53719, 'inflow', 'TRANSFER FROM account 357');
  const first = await f.ask(netQuestion()); reached(f, first);
  assert.equal(first.ledger.candidate_transfer_count, 1);
  assert.equal(first.ledger.default_exclusions.loan_proceeds_minor, 53719);
  assert.equal(first.ledger.net_minor, 12347);
  const included = await f.ask(netQuestion(' including loan proceeds')); reached(f, included);
  assert.equal(included.ledger.net_minor, 66066);
});

for (const kind of ['investment', 'retirement']) test(`CONTROL: ${kind} withdrawal and its inclusion flip`, async t => {
  const f = fixture(t); f.account('operating', '26'); f.account('reserve', '357', kind);
  f.add('withdraw-out', 'reserve', 83129, 'outflow', 'TRANSFER TO account 26');
  f.add('withdraw-in', 'operating', 83129, 'inflow', 'TRANSFER FROM account 357');
  const first = await f.ask(netQuestion()); reached(f, first);
  assert.equal(first.ledger.candidate_transfer_count, 1);
  assert.equal(first.ledger.default_exclusions.withdrawal_minor, 83129);
  assert.equal(first.ledger.net_minor, 0);
  const included = await f.ask(netQuestion(' including withdrawals')); reached(f, included);
  assert.equal(included.ledger.net_minor, 83129);
});

test('CONTROL: pending and removed duplicates do not change a posted amount', async t => {
  const f = fixture(t); f.account('operating', '26');
  for (const id of ['posted', 'pending', 'removed']) f.add(id, 'operating', 27139, 'outflow', 'Supplies');
  f.raw("UPDATE fin_transactions SET pending=1 WHERE txn_uid='pending'");
  f.raw("UPDATE fin_transactions SET removed_at=?,removal_reason='fixture reversal' WHERE txn_uid='removed'", NOW);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM fin_transactions').get().n, 3);
  const body = await f.ask(moneyQuestion()); reached(f, body);
  assert.equal(f.seen.rowCounts.at(-1), 1, 'filter decision reached with surviving green row');
  assert.equal(body.ledger.lead_accounts[0].debits_minor, 27139);
});

test('CONTROL: named owner month survives a UTC month and year boundary', () => {
  // At this instant an owner at UTC-7 is still in December.
  const now = '2035-01-01T02:30:00Z';
  const relative = classifyLedgerQuestion('What was my profit last month?', { now });
  assert.deepEqual([relative.kind, relative.from, relative.to], ['totals', '2034-12-01', '2034-12-31']);
  const ownerMonth = classifyLedgerQuestion('What was my profit in November 2034?', { now });
  assert.deepEqual([ownerMonth.kind, ownerMonth.from, ownerMonth.to], ['totals', '2034-11-01', '2034-11-30']);
});

test('CONTROL: v3 template families and periods reach their advertised grammar', () => {
  const forms = [
    ['totals', p => `How much money came in and went out ${p}?`],
    ['totals', p => `What was my profit ${p}?`],
    ['totals', p => `What was my net income ${p} for account ending 26?`],
    ['totals', p => `What was my cash flow ${p}?`],
    ['largest', p => `What were my 3 largest expenses ${p}?`],
    ['largest', p => `What were my 3 largest deposits ${p}?`],
    ['deposits', p => `What were my deposits ${p}?`],
    ['category', p => `What were my top spending categories ${p}?`],
    ['merchant', p => `How much did I spend by merchant ${p}?`],
    ['merchant', p => `How much income by merchant ${p}?`],
    ['merchant', p => `How much income came from Studio Buyer ${p}?`],
    ['transfers', p => `How much did I transfer between my own accounts ${p}?`],
  ];
  let decisions = 0;
  for (const period of ['last month', 'this month', PERIOD, 'in the last 7 days', 'so far this year', 'in Q2 2034'])
    for (const [kind, build] of forms) {
      const intent = classifyLedgerQuestion(build(period), { now: NOW });
      assert.equal(intent.kind, kind, build(period)); assert.ok(intent.from && intent.to); decisions++;
    }
  assert.equal(decisions, 72);
});


const ofx = `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD</CURDEF>
<BANKACCTFROM><BANKID>7654321</BANKID><ACCTID>2468</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST><DTSTART>20340601</DTSTART><DTEND>20340630</DTEND>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20340615</DTPOSTED><TRNAMT>-271.39</TRNAMT><FITID>fixture-purchase</FITID><NAME>Office Supplies</NAME></STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>728.61</BALAMT><DTASOF>20340630</DTASOF></LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

for (const stage of ['preview', 'commit']) test(`C16 owner ${stage} refuses cross-format overlap without consuming approval`, async t => {
  const f = fixture(t);
  const bank = readBankExport(ofx, { format: 'ofx', name: 'synthetic.ofx' });
  const accountKey = bank.accounts[0].accountKey;
  const payload = { entity_slug: 'business-one', file_name: 'synthetic.csv',
    content_base64: Buffer.from('Date,Description,Debit,Credit\n2034-06-15,Office Supplies,271.39,\n').toString('base64'),
    mapping: { account_slug: accountKey, account_kind: 'checking', currency: 'USD' } };
  let entityReads = 0;
  const options = { now: NOW, validateEntity: async () => {
    entityReads++; return { ok: true, entity: { status: 'active', label: 'Synthetic owner' } };
  } };
  const control = await handleOwnerBankImport(f.env, payload, OWNER_BANK_IMPORT_PREVIEW_PATH, options);
  assert.equal(control.status, 200);
  const preview = await control.json(); assert.equal(preview.previewed, true);
  assert.equal((await importBankExport(f.env, bank, { entitySlug: 'business-one', now: NOW })).imported, true);
  const before = f.sqlite.prepare('SELECT total_changes() n').get().n;
  const result = stage === 'preview'
    ? await handleOwnerBankImport(f.env, payload, OWNER_BANK_IMPORT_PREVIEW_PATH, options)
    : await handleOwnerBankImport(f.env, { ...payload, confirmed: true, preview_id: preview.preview_id,
      request_id: 'fixture-cross-format' }, OWNER_BANK_IMPORT_COMMIT_PATH, options);
  assert.equal(result.status, 409);
  assert.equal((await result.json()).code, 'bank_export_overlap_review_required');
  assert.equal(entityReads, 2, 'entity approval decision reached for both arms');
  assert.ok(f.seen.sql.some(sql => /external_id IS NULL/.test(sql)), 'overlap query reached');
  assert.equal(f.sqlite.prepare('SELECT total_changes() n').get().n, before);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM owner_bank_import_commits').get().n, 0);
});

for (const reverse of [false, true]) test(`C16 nonoverlapping format windows remain importable, reverse=${reverse}`, async t => {
  const f = fixture(t);
  const bank = readBankExport(ofx, { format: 'ofx', name: 'synthetic.ofx' });
  const accountKey = bank.accounts[0].accountKey;
  const csv = readBankExport('Date,Description,Debit,Credit\n2034-01-15,Office Supplies,271.39,\n', {
    format: 'csv', name: 'synthetic.csv', accountHint: { accountKey, accountKind: 'checking' },
  });
  for (const envelope of reverse ? [csv, bank] : [bank, csv])
    assert.equal((await importBankExport(f.env, envelope, { entitySlug: 'business-one', now: NOW })).imported, true);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM fin_transactions').get().n, 2);
  assert.ok(f.seen.sql.some(sql => /external_id IS NULL/.test(sql)));
});

test('C16 equivalent CSV then OFX also refuses without changing original provenance', async t => {
  const f = fixture(t);
  const bank = readBankExport(ofx, { format: 'ofx', name: 'synthetic.ofx' });
  const accountKey = bank.accounts[0].accountKey;
  const csv = readBankExport('Date,Description,Debit,Credit\n2034-06-15,Office Supplies,271.39,\n', {
    format: 'csv', name: 'synthetic.csv', accountHint: { accountKey, accountKind: 'checking' },
  });
  assert.equal((await importBankExport(f.env, csv, { entitySlug: 'business-one', now: NOW })).imported, true);
  const original = f.sqlite.prepare('SELECT * FROM fin_transactions').all();
  const before = f.sqlite.prepare('SELECT total_changes() n').get().n;
  const result = await importBankExport(f.env, bank, { entitySlug: 'business-one', now: NOW });
  assert.equal(result.code, 'bank_export_overlap_review_required');
  assert.ok(f.seen.sql.some(sql => /external_id IS NULL/.test(sql)));
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM fin_transactions').all(), original);
  assert.equal(f.sqlite.prepare('SELECT total_changes() n').get().n, before);
});

for (const racing of [false, true]) test(`C16 operator guards every batch, racing legacy import=${racing}`, async t => {
  const f = fixture(t);
  const bank = readBankExport(ofx, { format: 'ofx', name: 'synthetic.ofx' });
  const accountKey = bank.accounts[0].accountKey;
  const csv = readBankExport('Date,Description,Debit,Credit\n' + Array.from({ length: 100 }, (_, i) =>
    `2034-06-15,Office Supplies ${(i + 1)},1.00,\n`).join(''), {
    format: 'csv', name: 'synthetic.csv', accountHint: { accountKey, accountKind: 'checking' },
  });
  const options = { entitySlug: 'business-one', now: NOW };
  let batches = 0, beforeRace;
  const original = f.env.DB.batch;
  f.env.DB.batch = async statements => {
    batches++;
    if (racing && batches === 2) {
      beforeRace = f.sqlite.prepare('SELECT COUNT(*) n FROM fin_transactions').get().n;
      const receipt = await importLegacyBankExport({ DB: { ...f.env.DB, batch: original } }, bank, options);
      assert.equal(receipt.transactions, 1);
    }
    return original(statements);
  };
  if (racing) {
    await assert.rejects(importBankExport(f.env, csv, options), /malformed JSON/);
    assert.ok(beforeRace > 0 && beforeRace < 100, 'first nonempty chunk was committed');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM fin_transactions').get().n, beforeRace + 1,
      'no second-chunk rows landed; all first-chunk rows and racing provenance remain');
  } else {
    assert.equal((await importBankExport(f.env, csv, options)).transactions, 100);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM fin_transactions').get().n, 100);
  }
  assert.equal(batches, 2, 'both chunks reached the real write boundary');
});

for (const format of ['csv', 'ofx']) test(`C16 two separate same-day same-amount purchases survive ${format} and replay`, async t => {
  const f = fixture(t);
  const input = format === 'csv' ? 'Date,Description,Debit,Credit\n2034-06-15,Office Supplies,271.39,\n2034-06-15,Office Supplies,271.39,\n'
    : ofx.replace('</BANKTRANLIST>', ofx.match(/<STMTTRN>.*?<\/STMTTRN>/s)[0].replace('fixture-purchase', 'fixture-second-purchase') + '</BANKTRANLIST>');
  const envelope = readBankExport(input, { format, name: `synthetic.${format}`, accountHint: { accountKey: 'operating', accountKind: 'checking' } });
  assert.equal(envelope.ok, true); assert.equal(envelope.accounts[0].transactions.length, 2);
  f.account(envelope.accounts[0].accountKey, '2468', 'checking', 'business-one', 'manual');
  for (let i = 0; i < 2; i++) assert.equal((await importBankExport(f.env, envelope, { entitySlug: 'business-one', now: NOW })).imported, true);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM fin_transactions').get().n, 2);
  const body = await f.ask(moneyQuestion()); reached(f, body);
  assert.equal(body.ledger.accounts[0].debits_minor, 54278);
});

test('C16 legacy mixed identities are retained but refuse an unsupported doubled total', async t => {
  const f = fixture(t); f.account('operating', '26', 'checking', 'business-one', 'manual');
  f.add('old-ofx', 'operating', 27139, 'outflow', 'Office Supplies');
  f.add('old-csv', 'operating', 27139, 'outflow', 'OFFICE SUPPLIES purchase');
  f.raw("UPDATE fin_transactions SET provenance='extracted',source_doc_uid=txn_uid,external_id=CASE WHEN txn_uid='old-ofx' THEN 'fixture-purchase' ELSE NULL END");
  const body = await f.ask(moneyQuestion());
  assert.ok(f.seen.sql.some(sql => /JOIN fin_transactions/.test(sql)));
  assert.equal(body.ledger, undefined);
  assert.equal(body.gaps[0].reason, 'bank_export_overlap_review_required');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM fin_transactions').get().n, 2);
  assert.equal(f.sqlite.prepare('SELECT COUNT(DISTINCT source_doc_uid) n FROM fin_transactions').get().n, 2);
});

test('C16 prepared owner plan rechecks overlap transactionally after a racing import', async t => {
  const f = fixture(t);
  const bank = readBankExport(ofx, { format: 'ofx', name: 'synthetic.ofx' });
  const accountKey = bank.accounts[0].accountKey;
  const csv = readBankExport('Date,Description,Debit,Credit\n2034-06-15,Office Supplies,271.39,\n', {
    format: 'csv', name: 'synthetic.csv', accountHint: { accountKey, accountKind: 'checking' },
  });
  const plan = prepareBankExportImport(csv, { entitySlug: 'business-one', now: NOW });
  assert.ok(plan.transactionUids.length === 1 && plan.statements.length > 0);
  assert.equal((await importBankExport(f.env, bank, { entitySlug: 'business-one', now: NOW })).imported, true);
  let attempts = 0;
  await assert.rejects(async () => {
    attempts++;
    await f.env.DB.batch(plan.statements.map(([sql, binds]) => f.env.DB.prepare(sql).bind(...binds)));
  });
  assert.equal(attempts, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM fin_transactions').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM fin_transactions WHERE external_id IS NOT NULL').get().n, 1);
});

for (const mixed of [false, true]) test(`${mixed ? 'REGRESSION PM08' : 'CONTROL PM08'}: same purchase imported from two bank formats`, async t => {
  const f = fixture(t);
  const bank = readBankExport(ofx, { format: 'ofx', name: 'synthetic.ofx' });
  assert.equal(bank.ok, true); assert.equal(bank.accounts[0].transactions.length, 1);
  const accountKey = bank.accounts[0].accountKey;
  // A previously owner-confirmed manual coverage window is retained on reimport.
  f.account(accountKey, '2468', 'checking', 'business-one', 'manual');
  const csv = readBankExport('Date,Description,Debit,Credit\n2034-06-15,Office Supplies,271.39,\n', {
    format: 'csv', name: 'synthetic.csv', accountHint: { accountKey, accountKind: 'checking', mask: '2468' },
  });
  assert.equal(csv.ok, true); assert.equal(csv.accounts[0].transactions.length, 1);
  const options = { entitySlug: 'business-one', now: NOW };
  assert.equal((await importBankExport(f.env, bank, options)).imported, true);
  const second = await importBankExport(f.env, mixed ? csv : bank, options);
  if (mixed) {
    assert.equal(second.refused, true);
    assert.equal(second.code, 'bank_export_overlap_review_required');
    assert.ok(f.seen.sql.some(sql => /external_id IS/.test(sql)), 'overlap decision reached');
  } else assert.equal(second.imported, true);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM fin_transactions').get().n, 1);
  const body = await f.ask(moneyQuestion()); reached(f, body);
  assert.equal(body.ledger.lead_accounts[0].debits_minor, 27139, 'same bank event must not become two expenses');
});

for (const later of [false, true]) test(`${later ? 'REGRESSION PM11' : 'CONTROL PM11'}: partial imports must not bridge an unobserved coverage gap`, async t => {
  const f = fixture(t); f.account('operating', '2468', 'checking', 'business-one', 'manual');
  f.raw("UPDATE fin_account_coverage SET covered_from='2034-01-01',covered_to='2034-01-31' WHERE account_slug='operating'");
  f.add('known-january', 'operating', 5000, 'outflow', 'Supplies', { day: '2034-01-15' });
  const exportDay = later ? '2034-06-15' : '2034-01-20';
  const envelope = readBankExport(`Date,Description,Debit,Credit\n${exportDay},Supplies,271.39,\n`, {
    format: 'csv', name: 'synthetic.csv', accountHint: { accountKey: 'operating', accountKind: 'checking' },
  });
  assert.equal(envelope.ok, true);
  const receipt = await importBankExport(f.env, envelope, { entitySlug: 'business-one', now: NOW });
  assert.equal(receipt.imported, true); assert.equal(receipt.transactions, 1, 'nonempty real import executed');
  const coverage = f.sqlite.prepare("SELECT coverage_status,covered_to FROM fin_account_coverage WHERE account_slug='operating'").get();
  assert.equal(coverage.coverage_status, later ? 'partial' : 'complete');
  assert.equal(coverage.covered_to, later ? '2034-06-15' : '2034-01-31', 'coverage update decision reached');
  const body = await f.ask('How much money came in and went out in March 2034?');
  assert.ok(f.seen.sql.some(sql => /FROM fin_accounts a/.test(sql)), 'coverage read decision reached');
  assert.equal(body.ledger, undefined, 'no March source exists, so a complete March total must not be returned');
  assert.equal(body.gaps[0].reason, 'period_outside_coverage');
});
