import { financialFixtures, financialScope } from './financial-contract.mjs';
import { financialHash, sealFinancialSnapshot, normalizeFinancialReportCell } from '../../worker/src/lib/financial-snapshot-contract.js';
import { moneyFromMinor } from '../../worker/src/lib/financial-money.js';

export const booksScope = () => ({ ...financialScope(), account_filter: ['account_01', 'account_02'],
  report_parameters: financialScope().report_parameters.map(p => p.name === 'account_filter'
    ? { ...p, requested: '["account_01","account_02"]', echoed: '["account_01","account_02"]' } : p) });
export const record = (id, amount = '100', extra = {}) => ({ id, amount, date: '2025-01-15', account: 'account_01',
  direction: 'outflow', reference: 'ref_01', link: null, link_line: null, transfer: null, state: 'settled', version: '1', ...extra });

// R1 fixtures reuse the frozen shared contract, including its page receipts.
export async function booksSnapshot(side, records, { partial = false, boundary = true, currency = 'USD' } = {}) {
  const { snapshot } = await financialFixtures();
  snapshot.snapshot_id = `snapshot_${side}`;
  snapshot.source_id = `source_${side}`;
  snapshot.source_document_ref = `document_${side}`;
  snapshot.source_kind = side === 'quickbooks' ? 'quickbooks_report' : 'bank_report';
  snapshot.requested_at = snapshot.observed_at = snapshot.provider_generated_at = '2025-02-05T12:00:00.000Z';
  snapshot.lineage.root_ids = [snapshot.source_document_ref];
  snapshot.scope = booksScope();
  if (boundary) {
    snapshot.scope.period_start = '2024-12-29';
    snapshot.scope.period_end = snapshot.scope.as_of = '2025-02-03';
  }
  snapshot.scope.presentation_currency = currency;
  snapshot.scope.transaction_currencies = [currency];
  snapshot.report.requested_name = snapshot.report.returned_name = 'BooksTransactions';
  snapshot.report.no_report_data = records.length === 0;
  snapshot.scope.report_parameters = snapshot.scope.report_parameters.map(p => {
    const value = p.name === 'report_name' ? 'BooksTransactions' : snapshot.scope[p.name];
    return typeof value === 'string' ? { name: p.name, requested: value, echoed: value } : p;
  });
  const fields = ['amount', 'posted_on', 'direction', 'reference', 'linked_entity_id', 'linked_line_id', 'transfer_ref', 'record_state'];
  snapshot.columns = fields.map(key => ({ key, kind: key === 'amount' ? 'money' : key === 'posted_on' ? 'date' : 'text', label: key,
    currency: key === 'amount' ? currency : null, exponent: key === 'amount' ? moneyFromMinor('0', currency).exponent : null }));
  snapshot.rows = records.map((r, index) => {
    const row_path = `/Rows/${index}`;
    const values = [moneyFromMinor(r.amount, currency).decimal, r.date, r.direction, r.reference, r.link, r.link_line, r.transfer, r.state];
    return { row_path, parent_path: null, kind: 'detail', label: 'Fixture transaction', group_ref: { kind: 'account', id: r.account },
      native_entity_id: r.id, native_entity_version: r.version, native_line_id: r.line ?? null,
      cells: snapshot.columns.map((column, i) => normalizeFinancialReportCell({ column_key: column.key,
        raw_path: `${row_path}/${column.key}`, raw_text: values[i] ?? '', kind: column.kind,
        state: values[i] === null ? 'blank' : 'value', role: column.key === 'amount' ? r.direction : 'unknown', currency })) };
  });
  const raw = JSON.stringify(snapshot.rows);
  snapshot.raw_payload_hash = await financialHash(raw);
  snapshot.coverage.expected_report_types = snapshot.coverage.received_report_types = ['BooksTransactions'];
  snapshot.coverage.parameters = structuredClone(snapshot.scope.report_parameters);
  snapshot.coverage.expected_rows = snapshot.coverage.received_rows = records.length;
  snapshot.coverage.byte_count = new TextEncoder().encode(raw).length;
  snapshot.coverage.pages = [{ page_id: 'page_01', payload_hash: snapshot.raw_payload_hash,
    byte_count: snapshot.coverage.byte_count, row_count: records.length, parse_state: 'complete' }];
  if (partial) { snapshot.coverage.state = 'partial'; snapshot.coverage.continuation = 'pending'; }
  return sealFinancialSnapshot(snapshot);
}

export async function booksHarness(qboRows, bankRows, options = {}) {
  const qbo = await booksSnapshot('quickbooks', qboRows, options.quickbooks);
  const bank = await booksSnapshot('bank', bankRows, options.bank);
  const calls = [];
  const snapshots = new Map([[qbo.snapshot_id, qbo], [bank.snapshot_id, bank]]);
  const ref = snapshot => ({ snapshot_id: snapshot.snapshot_id, content_hash: snapshot.content_hash });
  return { snapshots, calls, input: { scope: booksScope(), quickbooks: ref(qbo), bank: ref(bank) },
    dependencies: { resolveSnapshot: async reference => { calls.push(reference.snapshot_id); return snapshots.get(reference.snapshot_id); } } };
}
