import assert from 'node:assert/strict';
import test from 'node:test';
import { createProductFixture } from './product-contract-fixture.mjs';
import { syncQuickBooksDesktop } from '../../connectors/quickbooks-desktop.mjs';
import { syncQuickBooksOnline } from '../../connectors/quickbooks-online.mjs';
import { createQuickBooksGuardForTest } from '../../connectors/quickbooks-guard.mjs';
import { makeDesktopBinding } from '../../connectors/quickbooks-desktop-binding.mjs';
import { mapQuickBooksDesktopRecord, desktopEntity } from '../../connectors/quickbooks-desktop-map.mjs';
import { normalizeProviderResult } from '../../connectors/provider-runtime.mjs';
import { desktopBridge, desktopFixture, SNAPSHOT } from '../../test/fixtures/quickbooks-desktop-qbxml.mjs';
import { quickBooksBalanceAnswer } from '../src/lib/quickbooks-balance.js';
import { quickBooksOpenItemsAnswer } from '../src/lib/quickbooks-open-items.js';
import { quickBooksMoneyPolicy } from '../src/lib/quickbooks-money.js';

const HEADERS = { 'X-Admin-Key': 'fixture-admin-key' };
const NOW = Date.parse(SNAPSHOT);
const proof = createQuickBooksGuardForTest({ desktopSignTypes: ['Bank'], desktopFreshnessVerified: true });
async function collect(rows, { production = false, stored = new Set(), snapshotAt = SNAPSHOT } = {}) {
  let helperCalls = 0; const bridge = desktopBridge(rows);
  const result = await syncQuickBooksDesktop({ binding: makeDesktopBinding({ accounts: rows.AccountRet, country: rows.HostRet[0].Country }),
    bridge: input => { helperCalls++; return bridge(input); }, snapshotAt, now: () => Date.parse(snapshotAt), listStoredFamilies: async () => stored },
  production ? {} : { guardRecord: proof });
  assert.equal(helperCalls, 2); assert.equal(result.documents.length, 9);
  return normalizeProviderResult('quickbooks_desktop', result);
}
async function ingest(fixture, result) {
  const response = await fixture.post('/api/admin/brain/ingest/batch', { docs: result.documents }, HEADERS);
  assert.equal(response.status, 200);
  const receipt = await response.json(); assert.equal(receipt.results.length, 9);
  assert.ok(receipt.results.every(row => ['created', 'updated', 'unchanged'].includes(row.status)));
  return receipt;
}
const fromEnvelope = (doc, n = 1, source = 'quickbooks_desktop') => ({ n, source, source_kind: 'quickbooks', ref: doc.source_id, ref_key: doc.source_id,
  snippet: doc.content.replace(/\s+/g, ' '), ts: doc.occurred_at, date_source: doc.date_source, date_reliable: doc.date_reliable,
  text_source: doc.text_source, text_reliable: doc.text_reliable, lineage: { kind: 'source_record', status: 'known' } });
function evidenceFromStore(fixture, id) {
  const stored = fixture.first('SELECT * FROM documents WHERE source_id=?', id);
  assert.ok(stored);
  const chunk = fixture.first('SELECT text FROM chunks WHERE doc_uid=? ORDER BY chunk_ix LIMIT 1', `quickbooks_desktop:${id}`);
  const metadata = JSON.parse(stored.meta);
  assert.equal(metadata.evidence_lineage.kind, 'source_record');
  return fromEnvelope({ source_id: id, content: chunk.text, occurred_at: new Date(stored.document_date).toISOString(),
    date_source: stored.date_source, date_reliable: Boolean(stored.date_reliable), text_source: stored.text_source, text_reliable: Boolean(stored.text_reliable) });
}
const policyLines = docs => quickBooksMoneyPolicy({ question: 'QuickBooks', docs, now: NOW }).instruction.split('\n').filter(line => /\[\d+\]/.test(line));
const open = docs => quickBooksOpenItemsAnswer({ question: 'Who owes us?', candidates: docs, citationCount: docs.length, now: NOW });

test('Desktop envelopes cross the real owner batch route and D1 before exact answer and Online parity checks', async () => {
  const fixture = await createProductFixture();
  try {
    fixture.raw("INSERT INTO sources(name,kind,status,created_at) VALUES ('quickbooks_desktop','quickbooks','ready',?)", SNAPSHOT);
    const rows = desktopFixture(); const result = await collect(rows); await ingest(fixture, result);
    assert.equal(fixture.first('SELECT count(*) AS n FROM documents').n, 9);
    const bank = evidenceFromStore(fixture, 'account:AA-12');
    assert.equal(quickBooksBalanceAnswer({ question: 'What are the current QuickBooks bank account balances?', docs: [bank], results: [bank], now: NOW }).answer.split('\n')[0],
      '"Checking" (Bank): balance USD 1,201.00 as of 2026-10-07 [1].');
    const invoice = evidenceFromStore(fixture, 'invoice:CC-14');
    assert.equal(open([invoice]).answer.split('\n')[0], 'Invoice "1016" to "Customer One": owes USD 75.00, due 2026-08-22, as of 2026-10-07 [1].');
    for (const ret of ['CustomerRet', 'VendorRet', 'InvoiceRet', 'BillRet', 'CreditMemoRet', 'BillPaymentCheckRet', 'BillPaymentCreditCardRet']) {
      const raw = rows[ret][0]; const entity = desktopEntity(ret);
      const mapped = mapQuickBooksDesktopRecord(ret, raw, { host: rows.HostRet[0], preferences: rows.PreferencesRet[0], currencies: rows.CurrencyRet,
        transaction: rows.TransactionRet[0] }, { guardRecord: proof });
      let reads = 0;
      const online = await syncQuickBooksOnline({ realmId: 'synthetic-company', accessToken: 'synthetic-token', entities: [entity], snapshotAt: SNAPSHOT, now: () => NOW,
        fetchImpl: async () => { reads++; return new Response(JSON.stringify({ QueryResponse: { [entity]: [mapped.row] } })); } });
      assert.equal(reads, 1);
      const fromStore = evidenceFromStore(fixture, `${entity.toLowerCase()}:${raw.ListID || raw.TxnID}`);
      assert.ok(policyLines([fromStore]).length > 0);
      assert.deepEqual(policyLines([fromStore]), policyLines([fromEnvelope(online.documents[0], 1, 'quickbooks')]));
    }
  } finally { fixture.close(); }
});

test('paid transition and failed cross-check replace the same family in real D1', async () => {
  const fixture = await createProductFixture();
  try {
    fixture.raw("INSERT INTO sources(name,kind,status,created_at) VALUES ('quickbooks_desktop','quickbooks','ready',?)", SNAPSHOT);
    const rows = desktopFixture(); await ingest(fixture, await collect(rows));
    assert.ok(open([evidenceFromStore(fixture, 'invoice:CC-14')]));
    Object.assign(rows.InvoiceRet[0], { IsPaid: 'true', BalanceRemaining: '0.00', AppliedAmount: '-75.00' });
    const paid = await ingest(fixture, await collect(rows)); assert.ok(paid.results.some(row => row.source_id === 'invoice:CC-14' && row.status === 'updated'));
    const observedPaid = evidenceFromStore(fixture, 'invoice:CC-14');
    assert.match(observedPaid.snippet, /USD 0\.00 \(paid\)/); assert.equal(open([observedPaid]), null);
    assert.ok(policyLines([observedPaid]).length > 0, 'paid is coherent evidence, not an inconsistency refusal');
    rows.InvoiceRet[0].SalesTaxTotal = '1.00';
    const withheld = await ingest(fixture, await collect(rows)); assert.ok(withheld.results.some(row => row.source_id === 'invoice:CC-14' && row.status === 'updated'));
    const invalid = evidenceFromStore(fixture, 'invoice:CC-14');
    assert.equal(policyLines([invalid]).length, 0); assert.match(invalid.snippet, /balance not provided/);
    assert.equal(fixture.first("SELECT count(*) AS n FROM documents WHERE source_id='invoice:CC-14'").n, 1);
    assert.equal(fixture.first('SELECT count(*) AS n FROM documents').n, 9);
  } finally { fixture.close(); }
});

test('production Desktop records remain searchable through D1 while sensitive unprojected fields never leave the adapter', async () => {
  const fixture = await createProductFixture();
  try {
    fixture.raw("INSERT INTO sources(name,kind,status,created_at) VALUES ('quickbooks_desktop','quickbooks','ready',?)", SNAPSHOT);
    const rows = desktopFixture();
    const sentinels = ['PRIVATE_COMPANY_PATH_SENTINEL', 'PRIVATE_SSN_SENTINEL', 'PRIVATE_EIN_SENTINEL', 'PRIVATE_BANK_SENTINEL', 'PRIVATE_CARD_SENTINEL'];
    rows.CompanyRet[0].CompanyFilePath = sentinels[0]; rows.CustomerRet[0].SSN = sentinels[1]; rows.VendorRet[0].VendorTaxIdent = sentinels[2];
    rows.AccountRet[0].BankNumber = sentinels[3]; rows.BillPaymentCreditCardRet[0].CreditCardInfo = sentinels[4];
    const result = await collect(rows, { production: true });
    for (const sentinel of sentinels) assert.ok(!JSON.stringify(result).includes(sentinel));
    assert.equal(result.code, 'QB_FRESHNESS_UNVERIFIED'); await ingest(fixture, result);
    const invoice = evidenceFromStore(fixture, 'invoice:CC-14');
    assert.match(invoice.snippet, /Invoice 1016 to Customer One/); assert.equal(policyLines([invoice]).length, 0);
    assert.ok(fixture.first("SELECT count(*) AS n FROM chunks WHERE text LIKE '%Customer One%'").n > 0);
  } finally { fixture.close(); }
});

test('adapter has no external fetch and delivery uses only the injected Brain batch route', async t => {
  let fetches = 0; const routes = [];
  t.mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('unexpected external request'); });
  const fixture = await createProductFixture();
  try {
    fixture.raw("INSERT INTO sources(name,kind,status,created_at) VALUES ('quickbooks_desktop','quickbooks','ready',?)", SNAPSHOT);
    const result = await collect(desktopFixture(), { production: true });
    assert.equal(result.enumeration_complete, true);
    const post = fixture.post;
    fixture.post = (route, ...args) => { routes.push(new URL(route, 'https://brain.example.invalid')); return post(route, ...args); };
    await ingest(fixture, result);
    assert.equal(routes.length, 1, 'the complete adapter result crossed the real batch decision point');
    assert.ok(routes.every(url => url.origin === 'https://brain.example.invalid' &&
      ['/api/admin/brain/ingest/batch', '/api/admin/brain/source-receipt', '/api/admin/brain/source-families'].includes(url.pathname)));
    assert.equal(fetches, 0);
  } finally { fixture.close(); }
});
