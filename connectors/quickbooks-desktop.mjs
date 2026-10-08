import { providerEnvelope, providerSyncResult } from './provider-sync.mjs';
import { renderQuickBooksRecord } from './quickbooks-records.mjs';
import { guardQuickBooksRecord } from './quickbooks-guard.mjs';
import { desktopEntity, desktopUtc, mapQuickBooksDesktopRecord } from './quickbooks-desktop-map.mjs';
import { desktopCompanyIdentity } from './quickbooks-desktop-binding.mjs';
import { encodeQbdFrame, qbdPlan, validateQbdResult, QBD_ID } from '../operations/quickbooks-desktop-bridge.mjs';

const BALANCE = new Set(['Account', 'Customer', 'Vendor', 'Invoice', 'Bill', 'CreditMemo']);
const RETS = ['AccountRet', 'CustomerRet', 'VendorRet', 'InvoiceRet', 'BillRet', 'CreditMemoRet', 'BillPaymentCheckRet', 'BillPaymentCreditCardRet', 'ReceivePaymentRet'];
export const desktopRows = (result, entity) => result.frames.filter(frame => frame.entity === entity).flatMap(frame => frame.rows);
const fail = code => ({ ...providerSyncResult({ provider: 'quickbooks', complete: false, walkComplete: false,
  deletionAuthority: 'unavailable', reason: code, warnings: [code] }), code });

/** All helper frames are revalidated before any document can leave this adapter.
 * The second argument is the isolated synthetic proof seam, never owner input.
 */
export async function syncQuickBooksDesktop({ bridge, binding, snapshotAt, listStoredFamilies, now = () => Date.now() },
  { guardRecord = guardQuickBooksRecord, openFileObservation = null } = {}) {
  if (desktopUtc(snapshotAt) !== snapshotAt || !Number.isFinite(+new Date(now())) || Date.parse(snapshotAt) > +new Date(now()) ||
      +new Date(now()) - Date.parse(snapshotAt) > 86400000) return fail('QB_CLOCK_UNVERIFIED');
  if (typeof bridge !== 'function' || typeof listStoredFamilies !== 'function' || !binding?.fingerprint) return fail('QB_NOT_CONNECTED');
  const call = async input => {
    const value = await bridge(input);
    if (!value?.ok) return { ok: false, code: /^QB_[A-Z_]+$/.test(value?.code || '') ? value.code : 'QB_PARTIAL_VIEW' };
    const plan = qbdPlan(input, new Date(snapshotAt));
    return validateQbdResult(Buffer.concat(value.frames.map(frame => encodeQbdFrame(frame))), input.operation, plan);
  };
  try {
    const probe = await call({ operation: 'probe' }); if (!probe.ok) return fail(probe.code);
    const accounts = desktopRows(probe, 'AccountRet');
    if (desktopCompanyIdentity(accounts).fingerprint !== binding.fingerprint) return fail('QB_WRONG_COMPANY');
    const company = desktopRows(probe, 'CompanyRet');
    if (company.length !== 1 || company[0].IsSampleCompanyFile !== 'false') return fail('QB_SAMPLE_COMPANY');
    const stored = await listStoredFamilies();
    if (!(stored instanceof Set)) return fail('QB_PARTIAL_VIEW');
    const storedIds = [...stored].map(uid => uid.startsWith('quickbooks_desktop:') ? uid.slice(19) : uid);
    if (storedIds.some(id => !/^(account|customer|vendor|invoice|bill|creditmemo|billpayment|payment):[0-9A-F]{1,16}-[0-9]{1,12}$/.test(id))) return fail('QB_PARTIAL_VIEW');
    const since = binding.last_complete_snapshot_at ? Date.parse(binding.last_complete_snapshot_at) - 3600000 : Date.parse(snapshotAt) - 730 * 86400000;
    const input = { operation: 'snapshot', historySince: new Date(since).toISOString().replace('.000Z', 'Z').replace(/\.\d{3}Z$/, 'Z'),
      accountListIds: accounts.map(row => row.ListID), storedTxnIds: [...new Set(storedIds.filter(id => !/^(account|customer|vendor):/.test(id)).map(id => id.split(':')[1]))] };
    const result = await call(input); if (!result.ok) return fail(result.code);
    const snapshotAccounts = desktopRows(result, 'AccountRet');
    if (desktopCompanyIdentity(snapshotAccounts).fingerprint !== binding.fingerprint) return fail('QB_WRONG_COMPANY');
    if (snapshotAccounts.length !== accounts.length || snapshotAccounts.some(row => !input.accountListIds.includes(row.ListID))) return fail('QB_PARTIAL_VIEW');
    const single = entity => { const rows = desktopRows(result, entity); if (rows.length !== 1) throw new Error('QB_PARTIAL_VIEW'); return rows[0]; };
    if (single('CompanyRet').IsSampleCompanyFile !== 'false') return fail('QB_SAMPLE_COMPANY');
    const host = single('HostRet'); const preferences = single('PreferencesRet');
    if (host.Country !== binding.country) return fail('QB_WRONG_COMPANY');
    const transactions = desktopRows(result, 'TransactionRet');
    if (new Set(transactions.map(row => row.TxnID)).size !== transactions.length) return fail('QB_PARTIAL_VIEW');
    const joined = new Map(transactions.map(row => [row.TxnID, row]));
    const records = RETS.flatMap(ret => desktopRows(result, ret).map(raw => ({ ret, raw, entity: desktopEntity(ret), id: raw.ListID || raw.TxnID })));
    if (records.some(record => !QBD_ID.test(record.id || ''))) return fail('QB_PARTIAL_VIEW');
    const ids = records.map(record => `${record.entity.toLowerCase()}:${record.id}`);
    if (new Set(ids).size !== ids.length) return fail('QB_PARTIAL_VIEW');
    const deletions = [];
    for (const ret of ['TxnDeletedRet', 'ListDeletedRet']) for (const raw of desktopRows(result, ret)) {
      const type = raw.TxnDelType || raw.ListDelType;
      const entity = desktopEntity(`${type}Ret`); const id = raw.TxnID || raw.ListID;
      if (![...BALANCE, 'BillPayment', 'Payment'].includes(entity)) continue;
      if (!QBD_ID.test(id || '')) return fail('QB_PARTIAL_VIEW');
      deletions.push({ source_type: 'quickbooks', source_id: `${entity.toLowerCase()}:${id}` });
    }
    const tombstones = new Set(deletions.map(row => row.source_id));
    if (ids.some(id => tombstones.has(id)) || storedIds.some(id => BALANCE.has(id.split(':')[0].replace(/^./, c => c.toUpperCase()).replace('Creditmemo', 'CreditMemo')) && !ids.includes(id) && !tombstones.has(id))) return fail('QB_PARTIAL_VIEW');
    const counts = Object.fromEntries([...BALANCE, 'BillPayment', 'Payment'].map(entity => [entity, records.filter(row => row.entity === entity).length]));
    if (Object.entries(binding.previous_counts || {}).some(([entity, count]) => BALANCE.has(entity) && counts[entity] * 5 < count * 4)) return fail('QB_PARTIAL_VIEW');
    const changed = records.filter(row => ['Account', 'Invoice', 'Bill', 'Payment'].includes(row.entity)).map(row => desktopUtc(row.raw.TimeModified)).filter(Boolean).sort();
    const maxChanged = changed.at(-1) || null;
    if (binding.previous_max_time_modified && (!maxChanged || maxChanged < binding.previous_max_time_modified)) return fail('QB_STALE_COPY');
    // No field-verified open-file identity/stat source exists. Even a bridge
    // property claiming one must not enable money in a shipped owner path.
    const fresh = guardRecord.desktopFreshnessVerified === true;
    const dormant = fresh && openFileObservation?.company_fingerprint === binding.fingerprint && maxChanged &&
      Date.parse(snapshotAt) - Date.parse(maxChanged) >= 14 * 86400000 && binding.previous_file_write_at &&
      binding.previous_file_write_at === openFileObservation.last_write_at;
    const code = dormant ? 'QB_FILE_DORMANT' : !fresh ? 'QB_FRESHNESS_UNVERIFIED' : host.Country !== 'US' ? 'QB_NON_US' : null;
    const postdated = new Map(result.frames.at(-1).requests.filter(request => request.id.startsWith('Postdated:'))
      .map(request => [input.accountListIds[Number(request.id.split(':')[1])], request.matchedCount]));
    const documents = records.map(({ ret, raw, entity, id }) => {
      const mapped = mapQuickBooksDesktopRecord(ret, raw, { host, preferences, currencies: desktopRows(result, 'CurrencyRet'),
        accounts: snapshotAccounts, transaction: joined.get(id), postdatedCount: postdated.get(id),
        customerName: desktopRows(result, 'CustomerRet').find(row => row.ListID === raw['CustomerRef.ListID'])?.Name }, { guardRecord });
      if (code) for (const field of ['CurrentBalance', 'Balance', 'RemainingCredit', 'TotalAmt']) delete mapped.row[field];
      const rendered = renderQuickBooksRecord(entity, mapped.row, snapshotAt);
      const document = providerEnvelope('quickbooks', `${entity.toLowerCase()}:${id}`, {
        title: rendered.title, content: rendered.content, occurredAt: rendered.balanceField ? snapshotAt : desktopUtc(raw.TimeModified),
        uri: `quickbooks://${entity.toLowerCase()}/${encodeURIComponent(id)}`,
        metadata: { qbo_company_fingerprint: binding.fingerprint, qb_edition: 'desktop', entity_type: entity, provider_id: id,
          provider_version: desktopUtc(raw.TimeModified), snapshot_at: snapshotAt, transaction_date: mapped.row.TxnDate || null,
          balance_snapshot_field: rendered.balanceField, details_omitted: rendered.detailsOmitted, reconciliation_lines: [],
          desktop_field_map: mapped.desktop_field_map, currency_source: mapped.currency_source, freshness: fresh ? 'test_verified' : 'unverified',
          refusal_reasons: [...new Set([...mapped.refusalReasons, ...(code ? [code] : [])])] },
      });
      if (rendered.balanceField) document.date_source = 'quickbooks:balance_snapshot';
      return document;
    });
    return { ...providerSyncResult({ provider: 'quickbooks', documents, deletions: [...tombstones].map(source_id => ({ source_type: 'quickbooks', source_id })),
      deletionAuthority: 'unavailable', complete: !code, walkComplete: !code, warnings: code ? [code] : [], reason: code }), code,
      qbo_company_fingerprint: binding.fingerprint, enumeration_complete: true,
      observation: { snapshot_at: snapshotAt, counts, max_time_modified: maxChanged } };
  } catch { return fail('QB_PARTIAL_VIEW'); }
}
