import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, account, transaction, NOW } from './fixtures/money-fix/fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { applyMoneyVeto } from '../src/lib/money-veto.js';
import { queryTimeWindow } from '../src/lib/query-intent.js';
import { readBankExport } from '../src/lib/bank-export.js';
import { importBankExport } from '../src/lib/fin-import.js';
import { rekeyBankExportTransactions } from '../src/lib/fin-ledger-maintenance.js';
import { ApiError, ownerError } from '../../frontend/src/lib/api.ts';
import { feedFixture } from './fixtures/money-fix/feed-fixture.mjs';
import { ledgerObligations, ledgerUnsortedSpending } from '../src/lib/fin-d1.js';
import { handleOwnerBankImport, OWNER_BANK_IMPORT_PREVIEW_PATH, OWNER_BANK_IMPORT_COMMIT_PATH } from '../src/lib/owner-bank-import.js';

globalThis.fetch = async () => { throw new Error('Network forbidden in review probes'); };
test.before(() => mock.method(Date, 'now', () => Date.parse(NOW)));
test.after(() => mock.restoreAll());
const ask = (f, question, extra = {}) => withLedgerAnswer({
  env: f.env, question, grantScope: { all: true }, scopePrincipalKind: 'owner', now: NOW, ...extra,
}, async gap => new Response(JSON.stringify({ answer: null, gaps: [gap] }))).then(r => r.json());
const totalQuestion = 'How much money came in September 2026?';
const cents = body => body.ledger?.accounts.reduce((sum, a) => sum + a.credits_minor, 0);
function vetoInput({ amount = '1,234.50', month = 'September', card = '4242' } = {}) {
  return {
    now: Date.parse(NOW), question: `What did card ending ${card} charge?`,
    answer: `Card ending ${card} charged USD ${amount} in ${month} [1].`,
    evidenceGate: { supported: true, complete: true, evidence: [1] },
    docs: [{ n: 1, ts: '2026-10-10', date_reliable: true,
      authority: { tier: 'T1', eligible: true }, lineage: { status: 'known', kind: 'source_record' },
      snippet: `Card ending ${card} charged USD 1,234.50 in September.` }],
  };
}

test('control: exact money prose survives; veto never promotes rejection', () => {
  const input = vetoInput();
  assert.equal(applyMoneyVeto(input).answer, input.answer);
  for (const supported of [false, undefined]) {
    const candidate = { ...input, evidenceGate: { ...input.evidenceGate, supported } };
    assert.equal(applyMoneyVeto(candidate).evidenceGate, candidate.evidenceGate);
  }
});

test('F01 numeric formatting preserves the supported amount', () => {
  const control = vetoInput();
  assert.equal(applyMoneyVeto(control).answer, control.answer);
  const input = vetoInput({ amount: '1234.5' });
  assert.ok(input.docs.length && input.evidenceGate.evidence.includes(input.docs[0].n));
  const result = applyMoneyVeto(input);
  assert.equal(result.answer, input.answer, result.evidenceGate.reason);
});

test('F01 month abbreviation preserves the supported month', () => {
  const control = vetoInput();
  assert.equal(applyMoneyVeto(control).answer, control.answer);
  const input = vetoInput({ month: 'Sep' });
  const result = applyMoneyVeto(input);
  assert.equal(result.answer, input.answer, result.evidenceGate.reason);
});

test('F02 a four-digit account mask does not impose a historical year', () => {
  const control = vetoInput();
  assert.equal(applyMoneyVeto(control).answer, control.answer);
  assert.equal(queryTimeWindow(control.question, { now: control.now }), null);
  const input = vetoInput({ card: '2025' });
  const result = applyMoneyVeto(input);
  assert.equal(result.answer, input.answer, result.evidenceGate.reason);
});

test('control: covered totals, authorization and inactive transaction filters execute', async t => {
  const f = fixture(); t.after(f.close);
  account(f); transaction(f);
  for (const extra of [
    { uid: 'pending-credit', pending: 1 },
    { uid: 'removed-credit', removed: NOW },
    { uid: 'old-credit', superseded: 99 },
    { uid: 'outside-credit', day: '2026-08-31' },
  ]) transaction(f, extra);
  assert.equal(cents(await ask(f, totalQuestion)), 123450);
  assert.ok(f.seen.some(sql => sql.includes('JOIN fin_transactions')));
  for (const scope of [
    { scopePrincipalKind: 'grant' }, { grantScope: { all: true, exclude: ['private'] } },
    { filters: { entity: 'owner-company' } }, { entityScope: { applied: true } },
  ]) {
    const before = f.seen.length;
    const result = await ask(f, totalQuestion, scope);
    assert.equal(result.gaps[0].reason, 'retrieval_scope_restricted');
    assert.equal(f.seen.length, before);
  }
});

test('F03 separate institutions with the same mask retain both accounts', async t => {
  const f = fixture(); t.after(f.close);
  account(f, { slug: 'manual-account', mode: 'manual', mask: '1111', institution: 'Bank One' });
  account(f, { institution: 'Bank Two' });
  transaction(f, { uid: 'manual-credit', slug: 'manual-account', amount: 10000 });
  transaction(f, { amount: 20000 });
  assert.equal(cents(await ask(f, totalQuestion)), 30000);
  f.raw("UPDATE fin_accounts SET mask='4321' WHERE account_slug='manual-account'");
  const before = f.seen.length;
  const result = await ask(f, totalQuestion);
  assert.ok(f.seen.slice(before).some(sql => sql.includes('JOIN fin_transactions')));
  assert.equal(cents(result), 30000, 'mask collision must not silently drop the other bank');
});

test('F04 unknown live coverage cannot turn twin rows into a complete double total', async t => {
  const f = fixture(); t.after(f.close);
  account(f, { slug: 'manual-account', mode: 'manual' }); account(f);
  transaction(f, { uid: 'manual-credit', slug: 'manual-account' }); transaction(f);
  assert.equal(cents(await ask(f, totalQuestion)), 123450);
  f.raw("UPDATE fin_account_coverage SET coverage_status='missing',covered_from=NULL,covered_to=NULL WHERE account_slug='live-account'");
  const before = f.seen.length;
  const result = await ask(f, totalQuestion);
  assert.ok(f.seen.slice(before).some(sql => sql.includes('FROM fin_accounts')));
  assert.ok(!result.ledger || cents(result) === 123450,
    `uncertain twins must fall back or deduplicate, observed ${cents(result)} complete=${result.evidence_gate?.complete}`);
});

test('F05 legacy import refusal needs specific recovery guidance', async t => {
  const f = fixture(); t.after(f.close);
  const exportFile = readBankExport('Date,Description,Debit,Credit\n2026-09-15,Office supplies,12.00,\n', {
    name: 'synthetic.csv', accountHint: { accountKey: 'owner-checking', accountKind: 'checking' },
  });
  const options = { entitySlug: 'owner-company', now: NOW };
  assert.equal((await importBankExport(f.env, exportFile, options)).imported, true);


  const payload = { entity_slug: 'owner-company', file_name: 'synthetic.csv', media_type: 'text/csv',
    content_base64: Buffer.from('Date,Description,Debit,Credit\n2026-09-15,Office supplies,12.00,\n').toString('base64'),
    mapping: { account_slug: 'owner-checking', account_kind: 'checking', currency: 'USD' } };
  const routeOptions = { now: NOW, validateEntity: async () => ({ ok: true, entity: { status: 'active' } }) };
  const freshResponse = await handleOwnerBankImport(f.env, payload, OWNER_BANK_IMPORT_PREVIEW_PATH, routeOptions);
  assert.equal(freshResponse.status, 200);
  const fresh = await freshResponse.json();
  f.raw("UPDATE fin_transactions SET txn_uid=account_slug||':line:legacy:'||id");
  const before = f.seen.length;
  const refused = await importBankExport(f.env, exportFile, options);
  assert.equal(refused.code, 'bank_export_identity_review_required');
  assert.ok(f.seen.slice(before).some(sql => sql.includes('SELECT id FROM fin_transactions')));
  const previewResponse = await handleOwnerBankImport(f.env, payload, OWNER_BANK_IMPORT_PREVIEW_PATH, routeOptions);
  assert.equal(previewResponse.status, 409);
  const preview = await previewResponse.json();
  assert.equal(preview.code, refused.code);
  const response = await handleOwnerBankImport(f.env, { ...payload, preview_id: fresh.preview_id,
    request_id: 'synthetic-import-request', confirmed: true }, OWNER_BANK_IMPORT_COMMIT_PATH, routeOptions);
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.deepEqual(body, { error: 'conflict', code: refused.code });
  const message = ownerError(new ApiError(response.status, body)).message;
  const generic = ownerError(new ApiError(409, { error: 'conflict', code: 'unknown-code' })).message;
  assert.notEqual(message, generic, 'identity recovery must not tell the owner merely to refresh and retry');
});

test('control: maintenance is atomic, preserves rows and replays without mutation', async t => {
  const f = fixture(); t.after(f.close);
  const data = readBankExport('Date,Description,Debit,Credit\n2026-09-15,Office supplies,12.00,\n2026-09-15,Office supplies,12.00,\n', {
    name: 'synthetic.csv', accountHint: { accountKey: 'owner-checking', accountKind: 'checking' },
  });
  const options = { entitySlug: 'owner-company', now: NOW };
  await importBankExport(f.env, data, options);
  assert.equal(f.rows('SELECT * FROM fin_transactions').length, 2);
  f.raw("UPDATE fin_transactions SET txn_uid=account_slug||':line:legacy:'||id");
  const before = f.rows('SELECT * FROM fin_transactions ORDER BY id');
  const preview = await rekeyBankExportTransactions(f.env, { accountSlug: 'owner-checking' });
  assert.equal(preview.candidate_count, 2);
  const apply = { accountSlug: 'owner-checking', dryRun: false, confirm: true, expectedPlanHash: preview.plan_hash };
  assert.equal((await rekeyBankExportTransactions(f.env, apply)).mutation_count, 2);
  assert.equal((await rekeyBankExportTransactions(f.env, apply)).mutation_count, 0);
  assert.deepEqual(f.rows('SELECT * FROM fin_transactions ORDER BY id').map(({ txn_uid, ...rest }) => rest), before.map(({ txn_uid, ...rest }) => rest));
  assert.equal((await importBankExport(f.env, data, options)).imported, true);
  assert.equal(f.rows('SELECT * FROM fin_transactions').length, 2);
});

test('F06 next-days payment question accepts an older invoice with a matching due date', () => {
  const input = vetoInput();
  input.question = 'What payment is due in the next 5 days?';
  input.answer = 'Invoice 101 has USD 1,234.50 due on 2026-10-12 [1].';
  input.docs[0].snippet = input.answer.replace(' [1]', '');
  input.docs[0].ts = '2026-10-11';
  assert.equal(applyMoneyVeto(input).answer, input.answer);
  input.docs[0].ts = '2026-10-01';
  const result = applyMoneyVeto(input);
  assert.equal(result.answer, input.answer, result.evidenceGate.reason);
});

test('F07 adding an owner obligation after feed promotion does not double the debt', async t => {
  const { f, state, run } = await feedFixture(); t.after(f.close);
  assert.equal((await ledgerObligations(f.env)).exposure.balance_minor, 25000);
  const original = f.first('SELECT * FROM fin_obligations');
  f.raw(`INSERT INTO fin_obligations
    (obligation_uid,entity_slug,kind,label,account_slug,balance_minor,balance_as_of,currency,provenance,basis_state,recorded_at)
    VALUES ('owner-loan','owner-company','loan','Owner loan',?,25000,'2026-10-11','USD','owner_stated','confirmed',?)`, original.account_slug, NOW);
  const before = f.seen.length;
  state.now = '2026-10-12T12:00:00.000Z';
  await run();
  assert.ok(f.seen.slice(before).some(sql => sql.includes('INSERT INTO fin_obligations')));
  const result = await ledgerObligations(f.env);
  assert.equal(result.exposure.balance_minor, 25000, 'linked owner and feed rows describe the same loan');
  assert.deepEqual(f.first('SELECT * FROM fin_obligations WHERE obligation_uid=?', original.obligation_uid), original);
  assert.equal(result.obligations.find(o => o.obligation_uid === original.obligation_uid).shadowed_by_owner, true);
  assert.equal(result.exposure.obligations_total, 1);
});

test('F08 refreshing a transaction preserves the owner-confirmed category', async t => {
  const { f, state, run } = await feedFixture({ type: 'depository', subtype: 'checking' }); t.after(f.close);
  const row = { transaction_id: 'synthetic-charge', account_id: 'synthetic-account', amount: '12.00',
    iso_currency_code: 'USD', date: '2026-10-10', pending: false, name: 'Office supplies',
    personal_finance_category: { primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_OFFICE_SUPPLIES' } };
  state.page.added = [row]; await run();
  assert.equal((await ledgerUnsortedSpending(f.env)).by_account[0].outflow_minor, 1200);
  f.raw("UPDATE fin_transactions SET category='Owner reviewed office',category_basis_state='confirmed'");
  assert.equal((await ledgerUnsortedSpending(f.env)).by_account.length, 0);
  state.page.added = []; state.page.modified = [{ ...row, name: 'Office supplies updated' }];
  const before = f.seen.length;
  await run();
  assert.ok(f.seen.slice(before).some(sql => sql.includes('INSERT INTO fin_transactions')));
  assert.equal(f.first("SELECT category_basis_state FROM fin_transactions WHERE external_id='synthetic-charge'").category_basis_state, 'confirmed');
  assert.equal(f.first("SELECT category FROM fin_transactions WHERE external_id='synthetic-charge'").category, 'Owner reviewed office');
  assert.equal((await ledgerUnsortedSpending(f.env)).by_account.length, 0);
});

test('inspection: transaction query plan', async t => {
  const f = fixture(); t.after(f.close);
  account(f); transaction(f);
  assert.equal(cents(await ask(f, totalQuestion)), 123450);
  const query = f.queries.find(q => q.sql.includes('JOIN fin_transactions'));
  assert.ok(query);
  const plan = f.rows('EXPLAIN QUERY PLAN ' + query.sql, ...query.binds);
  t.diagnostic(JSON.stringify(plan.map(row => row.detail)));
});

test('F09 a bounded monthly question uses an account-bound transaction search', async t => {
  const f = fixture(); t.after(f.close);
  account(f); transaction(f);
  const baseline = await ask(f, totalQuestion);
  assert.equal(cents(baseline), 123450);
  f.raw(`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<30000)
    INSERT INTO fin_transactions
      (txn_uid,account_slug,posted_on,amount_minor,direction,provenance,basis_state,recorded_at)
    SELECT 'old-'||n,'live-account','2020-01-01',100,'outflow','owner_stated','confirmed',? FROM sequence`, NOW);
  assert.equal(f.first('SELECT COUNT(*) AS n FROM fin_transactions').n, 30001);
  assert.equal(cents(await ask(f, totalQuestion)), 123450);
  const query = f.queries.find(q => q.sql.includes('JOIN fin_transactions'));
  const details = f.rows('EXPLAIN QUERY PLAN ' + query.sql, ...query.binds).map(row => row.detail).join('; ');
  assert.match(details, /SEARCH t USING INDEX idx_fin_transactions_account \(tenant_id=\? AND account_slug=\? AND posted_on>\? AND posted_on<\?\)/, `the current plan scans all tenant history: ${details}`);
  assert.doesNotMatch(details, /SCAN (?:t|fin_transactions)\b/);
  const narrow = await ask(f, 'List deposits in September 2026 for account ending 4321?');
  assert.equal(narrow.ledger.rows.length, 1);
  assert.equal(narrow.ledger.rows[0].amount_minor, 123450);
  const narrowQuery = f.queries.filter(q => q.sql.includes('JOIN fin_transactions')).at(-1);
  const plan = f.rows('EXPLAIN QUERY PLAN ' + narrowQuery.sql, ...narrowQuery.binds).map(row => row.detail).join('; ');
  assert.match(plan, /SEARCH t .*account_slug=\? AND posted_on>\? AND posted_on<\?/);
  assert.doesNotMatch(plan, /SCAN (?:t|fin_transactions)\b/);
});

test('F10 a work-life question does not consult or attach bank account coverage', async t => {
  const f = fixture(); t.after(f.close);
  account(f); transaction(f);
  const before = f.seen.length;
  const control = await ask(f, 'How can I organize work and rest?');
  assert.equal(control.gaps[0], null);
  assert.equal(f.seen.length, before);
  const result = await ask(f, 'How can I balance work and rest?');
  assert.equal(result.answer, null, 'document fallback executed');
  assert.equal(result.gaps[0], null);
  assert.equal(f.seen.length, before, 'a non-financial use of balance must not read the ledger');
});

test('control: an uncovered payment window cannot establish absence', async t => {
  const f = fixture(); t.after(f.close);
  account(f); transaction(f);
  const question = 'Did the payment of $1234.51 arrive on September 15, 2026?';
  const control = await ask(f, question);
  assert.equal(control.ledger.found, false);
  assert.equal(control.evidence_gate.complete, true);
  f.raw("UPDATE fin_account_coverage SET covered_from='2026-09-20'");
  const before = f.seen.length;
  const result = await ask(f, question);
  assert.equal(result.gaps[0].reason, 'period_outside_coverage');
  assert.ok(f.seen.slice(before).some(sql => sql.includes('FROM fin_accounts')));
  assert.equal(result.ledger, undefined);
});

test('control: an in-transaction maintenance race aborts before re-key and recovers with fresh approval', async t => {
  const f = fixture(); t.after(f.close);
  const data = readBankExport('Date,Description,Debit,Credit\n2026-09-15,Office supplies,12.00,\n', {
    name: 'synthetic.csv', accountHint: { accountKey: 'owner-checking', accountKind: 'checking' },
  });
  await importBankExport(f.env, data, { entitySlug: 'owner-company', now: NOW });
  f.raw("UPDATE fin_transactions SET txn_uid=account_slug||':line:legacy:'||id");
  const preview = await rekeyBankExportTransactions(f.env, { accountSlug: 'owner-checking' });
  assert.equal(preview.candidate_count, 1);
  const batch = f.DB.batch;
  let decisions = 0;
  f.DB.batch = async statements => {
    decisions++;
    f.raw("UPDATE fin_transactions SET description='Changed synthetic description'");
    return batch(statements);
  };
  await assert.rejects(rekeyBankExportTransactions(f.env, { accountSlug: 'owner-checking',
    dryRun: false, confirm: true, expectedPlanHash: preview.plan_hash }), /malformed JSON/);
  assert.equal(decisions, 1);
  assert.match(f.first('SELECT txn_uid FROM fin_transactions').txn_uid, /:line:legacy:/);
  assert.equal(f.first('SELECT COUNT(*) AS n FROM fin_transactions').n, 1);
  f.DB.batch = batch;
  const fresh = await rekeyBankExportTransactions(f.env, { accountSlug: 'owner-checking' });
  assert.equal((await rekeyBankExportTransactions(f.env, { accountSlug: 'owner-checking',
    dryRun: false, confirm: true, expectedPlanHash: fresh.plan_hash })).mutation_count, 1);
});

test('F05 recovery pages bound large accounts and keep imports blocked between pages', async t => {
  const f = fixture(); t.after(f.close);
  const lines = Array.from({ length: 2101 }, (_, i) => `2026-09-15,Supply ${i},${i + 1}.00,`);
  const data = readBankExport(`Date,Description,Debit,Credit\n${lines.join('\n')}\n`, {
    name: 'synthetic.csv', accountHint: { accountKey: 'owner-checking', accountKind: 'checking' },
  });
  await importBankExport(f.env, data, { entitySlug: 'owner-company', now: NOW });
  f.raw("UPDATE fin_transactions SET txn_uid=account_slug||':line:legacy:'||id");
  const scope = { accountSlug: 'owner-checking' };
  const first = await rekeyBankExportTransactions(f.env, scope);
  assert.ok(first.candidate_count > 0 && first.candidate_count <= 2000);
  assert.equal(first.has_more, true);
  const apply = await rekeyBankExportTransactions(f.env, { ...scope, dryRun: false, confirm: true, expectedPlanHash: first.plan_hash });
  assert.ok(apply.mutation_count > 0);
  assert.equal(apply.complete, false);
  assert.equal((await importBankExport(f.env, data, { entitySlug: 'owner-company', now: NOW })).refused, true);
  const next = await rekeyBankExportTransactions(f.env, scope);
  assert.ok(next.candidate_count > 0);
  const finish = await rekeyBankExportTransactions(f.env, { ...scope, dryRun: false, confirm: true, expectedPlanHash: next.plan_hash });
  assert.equal(finish.complete, true);
  assert.equal((await importBankExport(f.env, data, { entitySlug: 'owner-company', now: NOW })).imported, true);
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 2101);
});

test('F08 shared writer preserves confirmed categories on provider refresh', async t => {
  const f = fixture(); t.after(f.close);
  const data = readBankExport('Date,Description,Debit,Credit\n2026-09-15,Office supplies,12.00,\n', {
    name: 'synthetic.csv', accountHint: { accountKey: 'owner-checking', accountKind: 'checking' },
  });
  const options = { entitySlug: 'owner-company', now: NOW, origin: { provenance: 'feed', sourceFeed: 'synthetic-feed' } };
  await importBankExport(f.env, data, options);
  assert.equal(f.first('SELECT category_basis_state FROM fin_transactions').category_basis_state, 'proposed');
  f.raw("UPDATE fin_transactions SET category='Owner reviewed',category_basis_state='confirmed'");
  const before = f.seen.length;
  await importBankExport(f.env, data, options);
  assert.ok(f.seen.slice(before).some(sql => sql.includes('INSERT INTO fin_transactions')));
  assert.deepEqual({ ...f.first('SELECT category,category_basis_state FROM fin_transactions') }, { category: 'Owner reviewed', category_basis_state: 'confirmed' });
});

for (const scalar of ['card ending 2025', 'account ending 2025', 'x2025', '•2025', '$2025', 'USD 2025', '2025 dollars', 'invoice 2025', '2025 items', '2025.50', 'for 2025.50', 'USD -2025', '2,025.00']) {
  test(`F02 scalar is not a year: ${scalar}`, () => {
    assert.ok(queryTimeWindow('during 2025', { now: Date.parse(NOW) }));
    assert.equal(queryTimeWindow(`What about ${scalar}?`, { now: Date.parse(NOW) }), null);
  });
}

test('F03 missing institution refuses; normalized institution proves a twin', async t => {
  const f = fixture(); t.after(f.close);
  account(f, { slug: 'manual-account', mode: 'manual', institution: ' BANK   ONE ' }); account(f);
  transaction(f, { uid: 'manual-credit', slug: 'manual-account' }); transaction(f);
  assert.equal(cents(await ask(f, totalQuestion)), 123450);
  f.raw("UPDATE fin_accounts SET institution=NULL WHERE account_slug='manual-account'");
  const before = f.seen.length;
  const result = await ask(f, totalQuestion);
  assert.ok(f.seen.slice(before).some(sql => sql.includes('FROM fin_accounts')));
  assert.equal(result.gaps[0].reason, 'ambiguous_account');
  assert.equal(result.ledger, undefined);
});

for (const event of ['due', 'paid', 'posted']) {
  test(`F06 ${event} date controls window and unknown claim dates qualify`, () => {
    const input = vetoInput();
    input.question = `Which payment is ${event} in the next 5 days?`;
    input.answer = `Invoice 101 has USD 1,234.50 ${event} on 2026-10-12 [1].`;
    input.docs[0].snippet = input.answer.replace(' [1]', ''); input.docs[0].ts = '2026-10-01';
    assert.equal(applyMoneyVeto(input).answer, input.answer);
    input.answer = input.answer.replace('2026-10-12', '2026-10-20');
    input.docs[0].snippet = input.answer.replace(' [1]', '');
    assert.equal(applyMoneyVeto(input).answer, null);
    input.answer = `Invoice 101 has USD 1,234.50 ${event} [1].`;
    input.docs[0].snippet = input.answer.replace(' [1]', '');
    const unknown = applyMoneyVeto(input);
    assert.equal(unknown.answer, input.answer);
    assert.equal(unknown.evidenceGate.complete, false);
    assert.equal(unknown.evidenceGate.partial, true);
  });
}

test('F07 owner-first obligation retains its terms; later feed promotion never doubles exposure', async t => {
  const { f, run } = await feedFixture({ beforePromotion(f) {
    const slug = f.first('SELECT account_slug FROM plaid_sync_stage_accounts').account_slug;
    assert.ok(slug, 'account mapping exists before promotion');
    f.raw(`INSERT INTO fin_obligations
      (obligation_uid,entity_slug,kind,label,account_slug,balance_minor,balance_as_of,payment_minor,rate_bp,currency,provenance,basis_state,recorded_at)
      VALUES ('owner-loan','owner-company','loan','Owner loan',?,25000,'2026-10-11',1000,450,'USD','owner_stated','confirmed',?)`, slug, NOW);
  } }); t.after(f.close);
  const original = f.first("SELECT * FROM fin_obligations WHERE obligation_uid='owner-loan'");
  assert.equal((await ledgerObligations(f.env)).exposure.balance_minor, 25000);
  const before = f.seen.length; await run();
  assert.ok(f.seen.slice(before).some(sql => sql.includes('INSERT INTO fin_obligations')));
  assert.equal((await ledgerObligations(f.env)).exposure.balance_minor, 25000);
  assert.deepEqual(f.first("SELECT * FROM fin_obligations WHERE obligation_uid='owner-loan'"), original);
});

test('F01 decimal signs, currencies, magnitude and account identifiers cannot be swapped', () => {
  for (const month of ['Sep', 'Sept', 'September']) {
    const input = vetoInput({ month, amount: '1234.5' });
    assert.equal(applyMoneyVeto(input).answer, input.answer);
  }
  const control = vetoInput(); assert.equal(applyMoneyVeto(control).answer, control.answer);
  for (const replacement of ['USD -1234.50', 'USD 12345.00', 'CAD 1234.50']) {
    const input = vetoInput(); input.answer = input.answer.replace('USD 1,234.50', replacement);
    assert.equal(applyMoneyVeto(input).answer, null, replacement);
  }
  const mask = vetoInput({ card: '2025' }); mask.answer = mask.answer.replace('2025', '02025');
  assert.equal(applyMoneyVeto(mask).answer, null);
  const input = vetoInput(); input.answer = input.answer.replace('USD 1,234.50', '-$1234.50');
  input.docs[0].snippet = input.docs[0].snippet.replace('USD 1,234.50', '$1234.50');
  assert.equal(applyMoneyVeto(input).answer, null, 'sign before currency is still a sign');
});

test('F10 non-money fallback and veto preserve the original response bytes', async t => {
  const f = fixture(); t.after(f.close); account(f);
  const answer = 'Balance work and rest with 2 breaks.';
  const evidenceGate = { supported: true, complete: true, evidence: [] };
  const original = '{ "answer": "Balance work and rest with 2 breaks.", "gaps": [] }\n';
  let fallbackCalls = 0;
  const response = await withLedgerAnswer({ env: f.env, question: 'How can I balance work and rest?',
    grantScope: { all: true }, scopePrincipalKind: 'owner', now: NOW }, gap => {
    fallbackCalls++; assert.equal(gap, null); return new Response(original);
  });
  assert.equal(fallbackCalls, 1); assert.equal(f.seen.length, 0);
  assert.equal(await response.text(), original);
  assert.deepEqual(applyMoneyVeto({ question: 'How can I balance work and rest?', answer, evidenceGate }), { answer, evidenceGate });
});

test('F01 sign placement around the currency keeps the same exact negative decimal', () => {
  const input = vetoInput();
  input.answer = input.answer.replace('USD 1,234.50', '$ -1234.5');
  input.docs[0].snippet = input.docs[0].snippet.replace('USD 1,234.50', '-$1,234.50');
  assert.equal(applyMoneyVeto(input).answer, input.answer);
});

test('F06 a document date cannot supply a different claimed due date', () => {
  const input = vetoInput(); input.question = 'Which payment is due in the next 5 days?';
  input.answer = 'Invoice 101 has USD 1,234.50 due on 2026-10-12 [1].';
  input.docs[0].ts = '2026-10-12'; input.docs[0].snippet = input.answer.replace(' [1]', '');
  assert.equal(applyMoneyVeto(input).answer, input.answer);
  input.docs[0].snippet = input.docs[0].snippet.replace('2026-10-12', '2026-10-13');
  assert.equal(applyMoneyVeto(input).answer, null);
});

test('F04 retained live dates do not certify missing coverage or duplicate manual rows outside it', async t => {
  const f = fixture(); t.after(f.close);
  account(f, { slug: 'manual-account', mode: 'manual' }); account(f);
  transaction(f, { uid: 'manual-credit', slug: 'manual-account' }); transaction(f);
  assert.equal(cents(await ask(f, totalQuestion)), 123450);
  f.raw("UPDATE fin_account_coverage SET covered_from='2026-10-01',coverage_status='missing' WHERE account_slug='live-account'");
  const before = f.seen.length;
  const unknown = await ask(f, totalQuestion);
  assert.ok(f.seen.slice(before).some(sql => sql.includes('FROM fin_accounts')));
  assert.ok(!unknown.ledger || cents(unknown) === 123450);
  f.raw("UPDATE fin_account_coverage SET coverage_status='complete' WHERE account_slug='live-account'");
  const known = await ask(f, totalQuestion);
  assert.equal(cents(known), 123450, 'only the complete manual source supplies this outside-live window');
});
