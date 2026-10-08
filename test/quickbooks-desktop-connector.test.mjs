import assert from 'node:assert/strict';
import test from 'node:test';
import * as guard from '../connectors/quickbooks-guard.mjs';
import { mapQuickBooksDesktopRecord, desktopEntity, desktopMinorUnits, desktopUtc } from '../connectors/quickbooks-desktop-map.mjs';
import { syncQuickBooksDesktop } from '../connectors/quickbooks-desktop.mjs';
import { desktopCompanyIdentity, makeDesktopBinding } from '../connectors/quickbooks-desktop-binding.mjs';
import { quickBooksCompanyFingerprint } from '../connectors/quickbooks-online.mjs';
import { renderQuickBooksRecord } from '../connectors/quickbooks-records.mjs';
import { normalizeProviderResult } from '../connectors/provider-runtime.mjs';
import { desktopFixture, desktopBridge, SNAPSHOT } from './fixtures/quickbooks-desktop-qbxml.mjs';
import { FIXTURES } from './fixtures/quickbooks-records.mjs';
import { quickBooksBalanceAnswer } from '../worker/src/lib/quickbooks-balance.js';
import { quickBooksOpenItemsAnswer } from '../worker/src/lib/quickbooks-open-items.js';
import { quickBooksMoneyPolicy } from '../worker/src/lib/quickbooks-money.js';

const proof = guard.createQuickBooksGuardForTest({ desktopSignTypes: ['Bank'], desktopFreshnessVerified: true });
const NOW = Date.parse(SNAPSHOT);
export const evidence = (document, index = 0) => ({ n: index + 1, source: 'quickbooks_desktop', source_kind: 'quickbooks',
  ref: document.source_id, ref_key: document.source_id, snippet: document.content.replace(/\s+/g, ' '), ts: document.occurred_at,
  date_source: document.date_source, date_reliable: document.date_reliable, text_source: document.text_source, text_reliable: document.text_reliable,
  lineage: { status: 'known', kind: 'source_record' } });
export async function collectDesktop(rows = desktopFixture(), opts = {}, seam = { guardRecord: proof }) {
  const calls = [];
  const binding = makeDesktopBinding({ accounts: desktopFixture().AccountRet, country: 'US' });
  const result = await syncQuickBooksDesktop({ bridge: desktopBridge(rows, { calls, ...opts.bridgeOptions }), binding: { ...binding, ...opts.binding },
    snapshotAt: SNAPSHOT, listStoredFamilies: async () => opts.stored || new Set(), now: () => NOW, ...opts.adapter }, seam);
  assert.ok(calls.length || opts.adapter?.bridge || opts.adapter?.now, 'the helper decision point was reached');
  return result;
}
const balance = docs => quickBooksBalanceAnswer({ question: 'What are the current QuickBooks account balances?', results: docs, docs, now: NOW });
const open = docs => quickBooksOpenItemsAnswer({ question: 'Who owes us?', candidates: docs, citationCount: docs.length, now: NOW });
const statements = docs => quickBooksMoneyPolicy({ question: 'QuickBooks', docs, now: NOW }).instruction.split('\n').filter(line => /\[\d+\]/.test(line));

test('Desktop positive proof is an explicit test-only dependency, never a production sign-list change', () => {
  const input = { AccountType: 'Bank', CurrentBalance: '1201.00' };
  assert.deepEqual(guard.PROVEN_SIGN_TYPES.desktop, []);
  assert.deepEqual(guard.guardQuickBooksRecord('Account', input, { edition: 'desktop' }).withheld, ['CurrentBalance']);
  assert.equal(typeof guard.createQuickBooksGuardForTest, 'function');
  const testGuard = guard.createQuickBooksGuardForTest({ desktopSignTypes: ['Bank'], desktopFreshnessVerified: true });
  assert.equal(testGuard('Account', input, { edition: 'desktop' }).row.CurrentBalance, '1201.00');
  for (const type of ['Non-Posting', 'Income', 'Other Income', 'Expense', 'Other Expense', 'Cost of Goods Sold']) {
    assert.throws(() => guard.createQuickBooksGuardForTest({ desktopSignTypes: [type] }), /permanently excluded/);
  }
});

test('mapper openings match the existing goldens, including a separate Check control', () => {
  const rows = desktopFixture();
  for (const ret of ['AccountRet', 'CustomerRet', 'VendorRet', 'InvoiceRet', 'BillRet', 'CreditMemoRet', 'BillPaymentCreditCardRet', 'BillPaymentCheckRet']) {
    const raw = structuredClone(rows[ret][0]);
    // Pure mapper golden uses the existing descriptive link. Bridge/D1 tests
    // below use the helper's strict provider IDs instead.
    if (raw.AppliedToTxnRet) raw.AppliedToTxnRet[0].TxnID = 'bill-one';
    const mapped = mapQuickBooksDesktopRecord(ret, raw, { host: rows.HostRet[0], preferences: rows.PreferencesRet[0], currencies: rows.CurrencyRet,
      accounts: rows.AccountRet, postdatedCount: 0, transaction: rows.TransactionRet[0] }, { guardRecord: proof });
    assert.deepEqual(mapped.refusalReasons, [], ret);
    const entity = desktopEntity(ret); let expected = FIXTURES.find(([kind]) => kind === entity)[2];
    if (ret === 'BillPaymentCheckRet') expected = expected.replace('credit card (Company Card)', 'check (Checking)');
    assert.equal(renderQuickBooksRecord(entity, mapped.row, SNAPSHOT).content.split('\n')[0], expected);
  }
  assert.equal(desktopMinorUnits('9007199254740992.01'), 900719925474099201n);
});

test('real projected frames produce balance and open-item controls; production withholds money', async () => {
  const result = await collectDesktop();
  assert.equal(result.documents.length, 9); assert.equal(result.walk_complete, true);
  const docs = normalizeProviderResult('quickbooks_desktop', result).documents.map(evidence);
  const accounts = docs.filter(doc => doc.ref.startsWith('account:')).map((doc, i) => ({ ...doc, n: i + 1 }));
  const invoices = docs.filter(doc => doc.ref.startsWith('invoice:')).map((doc, i) => ({ ...doc, n: i + 1 }));
  assert.equal(balance(accounts).answer.split('\n')[0], '"Checking" (Bank): balance USD 1,201.00 as of 2026-10-07 [1].');
  assert.equal(open(invoices).answer.split('\n')[0], 'Invoice "1016" to "Customer One": owes USD 75.00, due 2026-08-22, as of 2026-10-07 [1].');
  assert.ok(statements(invoices).length > 0);
  const production = await collectDesktop(desktopFixture(), {}, {});
  assert.equal(production.documents.length, 9); assert.equal(production.code, 'QB_FRESHNESS_UNVERIFIED');
  assert.equal(production.walk_complete, false);
  for (const document of production.documents) {
    assert.equal(document.metadata.freshness, 'unverified');
    assert.equal(statements([evidence(document)]).length, 0);
    assert.doesNotMatch(document.content, /USD [\d,]+\.\d{2}/);
  }
});

const mutations = [
  ['card sign', 'AccountRet', rows => { rows.AccountRet[0].AccountType = 'CreditCard'; }],
  ['liability sign', 'AccountRet', rows => { rows.AccountRet[0].AccountType = 'OtherCurrentLiability'; }],
  ['account rollup', 'AccountRet', rows => { rows.AccountRet[0].TotalBalance = '1202.00'; }],
  ['postdated', 'AccountRet', () => {}, { bridgeOptions: { matchedCount: 1 } }],
  ['name collision', 'AccountRet', rows => { rows.AccountRet.push({ ...rows.AccountRet[0], ListID: 'AF-20', Name: 'ＣＨＥＣＫＩＮＧ' }); }],
  ['job', 'CustomerRet', rows => { rows.CustomerRet[0].Sublevel = '1'; }],
  ['unsafe party', 'InvoiceRet', rows => { rows.InvoiceRet[0]['CustomerRef.FullName'] = 'Owner/Job'; }],
  ['empty hierarchy', 'InvoiceRet', rows => { rows.InvoiceRet[0]['CustomerRef.FullName'] = 'Owner::Job'; }],
  ['multicurrency', 'InvoiceRet', rows => { rows.PreferencesRet[0]['MultiCurrencyPreferences.IsMultiCurrencyOn'] = 'true'; }],
  ['user currency', 'InvoiceRet', rows => { rows.CurrencyRet[0].CurrencyCode = 'Owner Currency'; }],
  ['non US no currency', 'InvoiceRet', rows => { rows.HostRet[0].Country = 'CA'; delete rows.PreferencesRet[0]['MultiCurrencyPreferences.HomeCurrencyRef.ListID']; }, { binding: { country: 'CA' } }],
  ['US fallback off', 'InvoiceRet', rows => { delete rows.PreferencesRet[0]['MultiCurrencyPreferences.HomeCurrencyRef.ListID']; }],
  ['invoice tax', 'InvoiceRet', rows => { rows.InvoiceRet[0].SalesTaxTotal = '1.00'; }],
  ['invoice applied', 'InvoiceRet', rows => { rows.InvoiceRet[0].AppliedAmount = '-1.00'; }],
  ['invoice paid flag', 'InvoiceRet', rows => { rows.InvoiceRet[0].IsPaid = 'true'; }],
  ['invoice currencies', 'InvoiceRet', rows => { rows.TransactionRet[0]['CurrencyRef.ListID'] = 'FE-17'; }],
  ['bill missing open', 'BillRet', rows => { delete rows.BillRet[0].OpenAmount; }],
  ['credit excludes tax', 'CreditMemoRet', rows => { rows.CreditMemoRet[0].TotalAmount = '70.00'; }],
  ['pending invoice', 'InvoiceRet', rows => { rows.InvoiceRet[0].IsPending = 'true'; }],
  ['pending bill', 'BillRet', rows => { rows.BillRet[0].IsPending = 'true'; }],
  ['void invoice', 'InvoiceRet', rows => { Object.assign(rows.InvoiceRet[0], { Subtotal: '0.00', BalanceRemaining: '0.00', IsPaid: 'true' }); rows.TransactionRet[0].Amount = '0.00'; }],
  ['void bill payment', 'BillPaymentCreditCardRet', rows => { rows.BillPaymentCreditCardRet[0].Amount = '0.00'; }],
  ['missing offset', 'BillPaymentCreditCardRet', rows => { rows.BillPaymentCreditCardRet[0].TimeModified = '2026-10-07T04:00:00'; }],
];
for (const [label, ret, mutate, opts] of mutations) test(`refusal ${label} follows an admitted same-record control`, async () => {
  const rows = desktopFixture(); const raw = rows[ret][0]; const id = `${desktopEntity(ret).toLowerCase()}:${raw.ListID || raw.TxnID}`;
  const control = (await collectDesktop()).documents.find(doc => doc.source_id === id);
  const controls = [evidence(control)];
  if (ret === 'AccountRet') assert.ok(balance(controls)); else assert.ok(statements(controls).length > 0);
  mutate(rows); const result = await collectDesktop(rows, opts);
  const document = result.documents.find(doc => doc.source_id === id);
  assert.ok(document, 'the record was re-emitted, never silently dropped');
  const docs = [evidence(document)];
  assert.equal(balance(docs), null); assert.equal(open(docs), null); assert.equal(statements(docs).length, 0);
});

test('valid party hierarchy is preserved without accepting slash-bearing segments', async () => {
  const rows = desktopFixture(); rows.InvoiceRet[0]['CustomerRef.FullName'] = 'Customer One:Job';
  const invoice = (await collectDesktop(rows)).documents.find(doc => doc.source_id.startsWith('invoice:'));
  assert.match(invoice.content, /Customer One \/ Job/); assert.ok(statements([evidence(invoice)]).length);
});

for (const [name, mutate, opts, expected] of [
  ['sample', rows => { rows.CompanyRet[0].IsSampleCompanyFile = 'true'; }, {}, 'QB_SAMPLE_COMPANY'],
  ['wrong company', rows => { rows.AccountRet[0].ListID = 'AE-12'; }, {}, 'QB_WRONG_COMPANY'],
  ['restored', () => {}, { binding: { previous_max_time_modified: '2026-10-07T11:01:00.000Z' } }, 'QB_STALE_COPY'],
  ['missing terminal', () => {}, { bridgeOptions: { mutateFrames: frames => frames.slice(0, -1) } }, 'QB_PARTIAL_VIEW'],
  ['missing family', () => {}, { stored: new Set(['quickbooks_desktop:invoice:FF-999']) }, 'QB_PARTIAL_VIEW'],
  ['25 percent count drop', rows => {
    for (const [index, TxnID] of ['CD-14', 'CE-14'].entries()) {
      rows.InvoiceRet.push({ ...rows.InvoiceRet[0], TxnID, RefNumber: String(1017 + index) });
      rows.TransactionRet.push({ ...rows.TransactionRet[0], TxnID });
    }
  }, { binding: { previous_counts: { Invoice: 4 } } }, 'QB_PARTIAL_VIEW'],
]) test(`run integrity ${name} sends no documents after the same complete green control`, async () => {
  assert.equal((await collectDesktop()).documents.length, 9);
  const rows = desktopFixture(); mutate(rows); const result = await collectDesktop(rows, opts);
  assert.equal(result.code, expected); assert.equal(result.walk_complete, false); assert.equal(result.documents.length, 0);
});

test('exact tombstones satisfy coverage; live/deleted conflicts refuse', async () => {
  const rows = desktopFixture(); rows.TxnDeletedRet = [{ TxnDelType: 'Invoice', TxnID: 'FF-999' }];
  const opts = { stored: new Set(['quickbooks_desktop:invoice:FF-999']) };
  const result = await collectDesktop(rows, opts);
  assert.equal(result.documents.length, 9); assert.equal(result.deletions[0].source_id, 'invoice:FF-999');
  rows.TxnDeletedRet[0].TxnID = 'CC-14';
  assert.equal((await collectDesktop(rows)).code, 'QB_PARTIAL_VIEW');
});

test('time boundaries and mixed sources refuse after green policy controls', async () => {
  const result = await collectDesktop();
  const doc = evidence(result.documents.find(doc => doc.source_id.startsWith('invoice:')));
  assert.ok(statements([doc]).length);
  for (const now of [NOW - 1, NOW + 86400001]) {
    assert.equal(quickBooksOpenItemsAnswer({ question: 'Who owes us?', candidates: [doc], citationCount: 1, now }), null);
    assert.ok(!/\[1\]/.test(quickBooksMoneyPolicy({ question: 'QuickBooks', docs: [doc], now }).instruction));
  }
  const peer = { ...doc, n: 2, source: 'quickbooks' };
  assert.equal(open([doc, peer]), null); assert.equal(statements([doc, peer]).length, 0);
});

test('a proven matching open-file observation discriminates dormant files in the test seam only', async () => {
  const rows = desktopFixture();
  for (const values of Object.values(rows)) for (const row of values) if (row.TimeModified) row.TimeModified = '2026-09-01T04:00:00-07:00';
  const binding = makeDesktopBinding({ accounts: rows.AccountRet, country: 'US' });
  binding.previous_file_write_at = '2026-09-01T11:00:00.000Z';
  const args = { bridge: desktopBridge(rows), binding, snapshotAt: SNAPSHOT, now: () => NOW, listStoredFamilies: async () => new Set() };
  const control = await syncQuickBooksDesktop(args, { guardRecord: proof, openFileObservation: { company_fingerprint: binding.fingerprint, last_write_at: SNAPSHOT } });
  assert.equal(control.documents.length, 9); assert.equal(control.code, null);
  const dormant = await syncQuickBooksDesktop(args, { guardRecord: proof, openFileObservation: { company_fingerprint: binding.fingerprint, last_write_at: binding.previous_file_write_at } });
  assert.equal(dormant.documents.length, 9); assert.equal(dormant.code, 'QB_FILE_DORMANT');
  assert.equal(statements(dormant.documents.map(evidence)).length, 0); assert.equal(dormant.walk_complete, false);
});

test('identity is deterministic and separate from Online for 1000 invented tuples', () => {
  // Independently checked with shasum over the released namespace bytes.
  assert.equal(quickBooksCompanyFingerprint('synthetic-company'), 'dc69e089f9c8f67a9c2066388c171a5d0fe9b7ecfb159115b8c5cbe118d89d3f');
  for (let i = 1; i <= 1000; i++) {
    const row = { ListID: `AA-${i}`, TimeCreated: '2020-01-01T00:00:00-07:00' };
    const a = desktopCompanyIdentity([row]); const b = desktopCompanyIdentity([{ ...row, Name: 'Renamed' }]);
    assert.equal(a.fingerprint, b.fingerprint); assert.notEqual(a.fingerprint, quickBooksCompanyFingerprint(`${row.ListID}|${row.TimeCreated}`));
  }
});

test('timestamp conversion rejects calendar rollover after a valid offset control', () => {
  assert.equal(desktopUtc('2026-02-28T04:00:00-07:00'), '2026-02-28T11:00:00.000Z');
  assert.equal(desktopUtc('2026-02-30T04:00:00-07:00'), null);
});
