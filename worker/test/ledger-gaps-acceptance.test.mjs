import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptanceFixture } from './gaps-acceptance-fixture.mjs';
import { readBankExport } from '../src/lib/bank-export.js';
import { importBankExport } from '../src/lib/fin-import.js';
import { importBankExport as legacyImport } from '../../test/fixtures/ledger-schema48/fin-import.mjs';
import { handleOwnerBankImport, OWNER_BANK_IMPORT_PREVIEW_PATH, OWNER_BANK_IMPORT_COMMIT_PATH } from '../src/lib/owner-bank-import.js';

const NOW = '2034-07-15T12:00:00Z';
const options = { entitySlug: 'business-one', now: NOW };
const totalQuestion = month => `How much money came in and went out in ${month} 2034?`;
async function fixture(t) {
  const f = await acceptanceFixture(t, { now: Date.parse(NOW) });
  f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('business-one','Operating Entity','business','owned','owner_stated','confirmed',?)`, NOW);
  f.account = (slug = 'operating', mask = '26', kind = 'checking') => f.raw(
    `INSERT INTO fin_accounts(account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,institution,provenance,basis_state,recorded_at)
     VALUES (?,'business-one',?,'asset',?,'manual','Synthetic Institution','owner_stated','confirmed',?)`, slug, kind, mask, NOW);
  // Independent complete-statement evidence is a fixture input. Importers may
  // never manufacture it from first/last transaction dates.
  f.complete = (slug, from, to) => f.raw(
    `INSERT OR REPLACE INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,basis_note,computed_at,provenance,basis_state,recorded_at)
     VALUES (?,'complete',?,?,'Independent complete statement',?,'owner_stated','confirmed',?)`, slug, from, to, NOW, NOW);
  f.add = (id, amount, direction, description, { account = 'operating', day = '2034-06-15', payee = null } = {}) => f.raw(
    `INSERT INTO fin_transactions(txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,provenance,basis_state,recorded_at)
     VALUES (?,?,?,?,?,?,?,'owner_stated','confirmed',?)`, id, account, day, amount, direction, description, payee, NOW);
  f.ask = async q => {
    const start = f.seen.sql.length;
    const txBefore = f.rows('SELECT * FROM fin_transactions ORDER BY txn_uid');
    const result = await f.request('think', q);
    assert.equal(result.response.status, 200);
    const sql = f.seen.sql.slice(start);
    assert.ok(sql.some(s => /FROM fin_accounts a/.test(s)), 'actual account/coverage decision reached');
    assert.deepEqual(f.rows('SELECT * FROM fin_transactions ORDER BY txn_uid'), txBefore, 'Ask preserves stored facts');
    f.noExternal();
    return { ...result.body, sql };
  };
  return f;
}
const csv = (rows, accountKey = 'operating') => readBankExport(
  `Date,Description,Debit,Credit\n${rows.join('\n')}\n`, { format: 'csv', name: 'synthetic.csv',
    accountHint: { accountKey, accountKind: 'checking', mask: '26' } });
function ofx(ids = ['event-a'], day = '20340615') {
  return `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD</CURDEF><BANKACCTFROM><BANKID>999</BANKID><ACCTID>26</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM><BANKTRANLIST><DTSTART>${day}</DTSTART><DTEND>${day}</DTEND>${ids.map(id => `<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>${day}</DTPOSTED><TRNAMT>-271.39</TRNAMT><FITID>${id}</FITID><NAME>Office Supplies</NAME></STMTTRN>`).join('')}</BANKTRANLIST><LEDGERBAL><BALAMT>728.61</BALAMT><DTASOF>${day}</DTASOF></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
}
function debit(body, expected) {
  assert.ok(body.ledger, 'ledger renderer reached');
  assert.ok(body.sql.some(sql => /JOIN fin_transactions/.test(sql)), 'transaction read decision reached');
  assert.equal(body.ledger.accounts.reduce((sum, a) => sum + a.debits_minor, 0), expected);
  assert.ok(body.answer.includes((expected / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })), 'rendered exact amount');
}

for (const legacy of [false, true]) for (const reverse of [false, true]) {
  test(`T2 unseen month stays unknown: legacy=${legacy}, reversed partials=${reverse}`, async t => {
    const f = await fixture(t);
    const january = csv(['2034-01-15,Supplies,50.00,']);
    assert.equal((await importBankExport(f.env, january, options)).transactions, 1);
    f.complete('operating', '2034-01-01', '2034-01-31');
    const later = [csv(['2034-06-15,Supplies,271.39,']), csv(['2034-07-01,Supplies,12.00,'])];
    for (const envelope of reverse ? later.reverse() : later) {
      const receipt = await (legacy ? legacyImport : importBankExport)(f.env, envelope, options);
      assert.equal(receipt.imported, true); assert.equal(receipt.transactions, 1);
    }
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 3);
    const unknown = await f.ask(totalQuestion('March'));
    assert.equal(unknown.ledger, undefined, 'unseen month cannot certify zero');
    assert.ok(unknown.gaps.some(g => /coverage/.test(g.reason || g.type || '')), 'coverage refusal decision reached');
    assert.ok(!unknown.answer || !/0\.00|no (?:payments|transactions)/i.test(unknown.answer));
    // A separately supplied complete March statement is the positive control.
    f.complete('operating', '2034-03-01', '2034-03-31');
    debit(await f.ask(totalQuestion('March')), 0);
    // Legacy identity recovery is separate from coverage review. Use a fresh
    // independently complete statement for the nonzero import control.
    const nonzero = await fixture(t);
    assert.equal((await importBankExport(nonzero.env, csv(['2034-03-18,Supplies,73.19,']), options)).transactions, 1);
    nonzero.complete('operating', '2034-03-01', '2034-03-31');
    debit(await nonzero.ask(totalQuestion('March')), 7319);
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 3);
  });
}

for (const reverse of [false, true]) test(`T3 mixed-format overlap refuses before second write: reverse=${reverse}`, async t => {
  const f = await fixture(t);
  const bank = readBankExport(ofx(), { format: 'ofx', name: 'synthetic.ofx' });
  const key = bank.accounts[0].accountKey;
  const text = csv(['2034-06-15,Office Supplies,271.39,'], key);
  const pair = reverse ? [text, bank] : [bank, text];
  assert.equal((await importBankExport(f.env, pair[0], options)).transactions, 1);
  const before = f.rows('SELECT * FROM fin_transactions');
  const changes = f.first('SELECT total_changes() n').n;
  const at = f.seen.sql.length;
  const blocked = await importBankExport(f.env, pair[1], options);
  assert.equal(blocked.code, 'bank_export_overlap_review_required');
  assert.ok(f.seen.sql.slice(at).some(sql => /external_id IS NULL/.test(sql)), 'nonempty overlap decision reached');
  assert.equal(f.first('SELECT total_changes() n').n, changes, 'refusal writes nothing');
  assert.deepEqual(f.rows('SELECT * FROM fin_transactions'), before);
  f.complete(key, '2034-06-01', '2034-06-30');
  debit(await f.ask(totalQuestion('June')), 27139);
  // Repeat in the original format is green, with identical provenance.
  assert.equal((await importBankExport(f.env, pair[0], options)).imported, true);
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 1);
  debit(await f.ask(totalQuestion('June')), 27139);
});

test('T3 preview, commit-time race and approval preservation use the real owner import handler', async t => {
  const f = await fixture(t);
  const bank = readBankExport(ofx(), { format: 'ofx', name: 'synthetic.ofx' });
  const payload = { entity_slug: 'business-one', file_name: 'synthetic.csv',
    content_base64: Buffer.from('Date,Description,Debit,Credit\n2034-06-15,Office Supplies,271.39,\n').toString('base64'),
    mapping: { account_slug: bank.accounts[0].accountKey, account_kind: 'checking', currency: 'USD' } };
  let entityReads = 0;
  const deps = { now: NOW, validateEntity: async () => { entityReads++; return { ok: true, entity: { status: 'active', label: 'Operating Entity' } }; } };
  const response = await handleOwnerBankImport(f.env, payload, OWNER_BANK_IMPORT_PREVIEW_PATH, deps);
  assert.equal(response.status, 200);
  const preview = await response.json(); assert.equal(preview.previewed, true);
  assert.equal((await importBankExport(f.env, bank, options)).transactions, 1);
  for (const path of [OWNER_BANK_IMPORT_PREVIEW_PATH, OWNER_BANK_IMPORT_COMMIT_PATH]) {
    const before = f.first('SELECT total_changes() n').n;
    const result = await handleOwnerBankImport(f.env, { ...payload, confirmed: true,
      preview_id: preview.preview_id, request_id: 'overlap-probe' }, path, deps);
    assert.equal(result.status, 409);
    assert.equal((await result.json()).code, 'bank_export_overlap_review_required');
    assert.equal(f.first('SELECT total_changes() n').n, before);
  }
  assert.equal(entityReads, 3);
  assert.ok(f.seen.sql.some(sql => /external_id IS NULL/.test(sql)));
  assert.equal(f.first('SELECT COUNT(*) n FROM owner_bank_import_commits').n, 0);
  // Independent nonoverlapping CSV completes preview AND commit.
  payload.content_base64 = Buffer.from('Date,Description,Debit,Credit\n2034-01-15,Office Supplies,271.39,\n').toString('base64');
  const good = await (await handleOwnerBankImport(f.env, payload, OWNER_BANK_IMPORT_PREVIEW_PATH, deps)).json();
  assert.equal(good.previewed, true);
  const committed = await handleOwnerBankImport(f.env, { ...payload, confirmed: true,
    preview_id: good.preview_id, request_id: 'nonoverlap-control' }, OWNER_BANK_IMPORT_COMMIT_PATH, deps);
  assert.equal(committed.status, 201);
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 2);
});

test('T3 equal real purchases survive repeated and reordered exports; legacy mixed state refuses totals', async t => {
  const f = await fixture(t);
  const bank = readBankExport(ofx(['event-a', 'event-b']), { format: 'ofx', name: 'synthetic.ofx' });
  const key = bank.accounts[0].accountKey;
  for (let i = 0; i < 2; i++) assert.equal((await importBankExport(f.env, bank, options)).transactions, 2);
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 2);
  f.complete(key, '2034-06-01', '2034-06-30');
  debit(await f.ask(totalQuestion('June')), 54278);
  const mixed = csv(['2034-06-15,Office Supplies,271.39,'], key);
  assert.equal((await legacyImport(f.env, mixed, options)).transactions, 1);
  f.complete(key, '2034-06-01', '2034-06-30');
  const answer = await f.ask(totalQuestion('June'));
  assert.equal(answer.ledger, undefined);
  assert.ok(answer.gaps.some(g => g.reason === 'bank_export_overlap_review_required'));
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 3);
  const other = await fixture(t);
  const rows = ['2034-06-15,Office Supplies,271.39,', '2034-06-15,Office Supplies,271.39,', '2034-06-16,Travel,10.00,'];
  for (const items of [rows, [...rows].reverse().map(row => row.replace('Office Supplies', ' Office Supplies '))])
    assert.equal((await importBankExport(other.env, csv(items), options)).transactions, 3);
  assert.equal(other.first('SELECT COUNT(*) n FROM fin_transactions').n, 3);
  other.complete('operating', '2034-06-01', '2034-06-30');
  debit(await other.ask(totalQuestion('June')), 55278);
});

// Frozen cross-product before any money implementation change: 32 cases, with
// independently known sender and cents. Nothing here imports production truth.
const payerCases = Object.freeze(['Payer One', 'Savings Supplier'].flatMap(sender =>
  ['Zelle', 'ACH'].flatMap(prefix => [false, true].flatMap(explicit =>
    [false, true].flatMap(amount => [false, true].map(wrong => ({ sender, prefix, explicit, amount, wrong })))))));
for (const [index, arm] of payerCases.entries()) test(`T4 frozen payer matrix ${index + 1}/32`, async t => {
  const f = await fixture(t); f.account(); f.complete('operating', '2034-06-01', '2034-06-30');
  f.add('receipt', 81327, 'inflow', `${arm.prefix} from ${arm.sender} for Payer Two invoice`, { payee: arm.explicit ? arm.sender : null });
  const subject = arm.wrong ? 'Payer Two' : arm.sender;
  const body = await f.ask(`Did the payment ${arm.amount ? 'of $813.27 ' : ''}from ${subject} arrive in June 2034?`);
  assert.equal(body.ledger?.kind, 'payment');
  assert.ok(body.sql.some(sql => /JOIN fin_transactions/.test(sql)), 'stored sender row read');
  assert.equal(body.ledger.found, !arm.wrong);
  if (!arm.wrong) assert.equal(body.citations[0].amount_minor, 81327);
  const income = await f.ask(`How much income came from ${subject} in June 2034?`);
  assert.equal(income.ledger?.total_minor, arm.wrong ? 0 : 81327);
  assert.ok(income.answer.includes(arm.wrong ? '0.00' : '813.27'));
});

for (const own of [false, true]) for (const mask of [false, true]) test(`T4 pairing truth: own=${own}, incidental mask=${mask}`, async t => {
  const f = await fixture(t); f.account(); f.account('reserve', '357', 'savings');
  for (const slug of ['operating', 'reserve']) f.complete(slug, '2034-06-01', '2034-07-15');
  f.add('outgoing', 90000, 'outflow', own ? 'TRANSFER TO account 357' : `Payment to vendor${mask ? ' for account 357' : ''}`,
    { day: '2034-06-30', payee: own ? null : 'Outside Supplier' });
  f.add('incoming', 90000, 'inflow', own ? 'TRANSFER FROM account 26' : 'Receipt from Outside Buyer',
    { account: 'reserve', day: '2034-07-01', payee: own ? null : 'Outside Buyer' });
  const body = await f.ask(totalQuestion('June'));
  debit(body, 90000);
  assert.equal(body.ledger.lead_accounts.reduce((sum, a) => sum + a.debits_minor, 0), own ? 0 : 90000);
  assert.equal(typeof body.ledger.candidate_transfer_count, 'number', 'pairing decision reached');
  if (own) assert.equal(body.ledger.candidate_transfer_count, 1);
});

test('T4 opaque processor is unknown attribution, with a positive sender control', async t => {
  const green = await fixture(t); green.account(); green.complete('operating', '2034-06-01', '2034-06-30');
  green.add('known', 81327, 'inflow', 'ACH from Payer One', { payee: 'Payer One' });
  assert.equal((await green.ask('Did the payment of $813.27 from Payer One arrive in June 2034?')).ledger.found, true);
  const f = await fixture(t); f.account(); f.complete('operating', '2034-06-01', '2034-06-30');
  f.add('opaque', 81327, 'inflow', 'Processor settlement');
  const unknown = await f.ask('Did the payment from Payer One arrive in June 2034?');
  assert.ok(unknown.sql.some(sql => /JOIN fin_transactions/.test(sql)));
  assert.ok(!unknown.answer || !/no matching deposit|no payment.*(?:arrived|received)/i.test(unknown.answer),
    'an unattributed inflow cannot certify payer absence');
  assert.ok(unknown.gaps.some(g => /attribution|sender|unattributed/i.test(JSON.stringify(g))), 'attribution uncertainty must remain visible');
});
