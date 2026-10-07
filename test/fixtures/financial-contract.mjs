// Invented, frozen-clock examples for every 0.4.11 financial lane. Builders
// return fresh objects so a mutation test cannot corrupt another lane's oracle.
import { financialHash, sealFinancialSnapshot } from '../../worker/src/lib/financial-snapshot-contract.js';
import { moneyFromDecimal, moneyFromMinor } from '../../worker/src/lib/financial-money.js';

export const FINANCIAL_FIXTURE_TIME = '2025-02-01T12:00:00.000Z';
export const FINANCIAL_FIXTURE_RAW = '{"Header":{"ReportName":"ProfitAndLoss"},"Rows":[{"net_sales":"3700.00"}]}';
export function financialScope() {
  return { tenant: 'fixture_tenant', entity_ref: 'entity_01', owner_map_head: 'map_01', company_fingerprint: 'a'.repeat(64),
    period_start: '2025-01-01', period_end: '2025-01-31', as_of: '2025-01-31', fiscal_year_end: '12-31',
    company_timezone: 'Etc/UTC', basis: 'accrual', presentation_currency: 'USD', transaction_currencies: ['USD'],
    class_filter: [], department_filter: [], account_filter: [],
    report_parameters: Object.entries({ class_filter: '[]', department_filter: '[]', account_filter: '[]',
      report_name: 'ProfitAndLoss', company_fingerprint: 'a'.repeat(64), period_start: '2025-01-01', period_end: '2025-01-31',
      as_of: '2025-01-31', basis: 'accrual', presentation_currency: 'USD' }).map(([name, value]) => ({ name, requested: value, echoed: value })) };
}
export function financialCoverage() {
  return { schema_version: 'financial-coverage-1', state: 'complete_for_report_scope', reason: 'measured_report',
    expected_report_types: ['ProfitAndLoss'], received_report_types: ['ProfitAndLoss'], expected_entity_types: [], received_entity_types: [],
    expected_pages: 1, received_pages: 1, expected_rows: 1, received_rows: 1, continuation: 'not_applicable',
    pages: [{ page_id: 'page_01', payload_hash: 'cd24a0c73e28d0e461fb55ae97bf56cc864907ff393c430a9f28b90c5ee5fcd7', byte_count: new TextEncoder().encode(FINANCIAL_FIXTURE_RAW).length, row_count: 1, parse_state: 'complete' }],
    parse_failures: [], omissions: [], unsupported_capabilities: [], parameters: financialScope().report_parameters,
    parameter_match: true, byte_count: new TextEncoder().encode(FINANCIAL_FIXTURE_RAW).length, durable_readback: true,
    mutation_check: { state: 'stable', method: 'fixture_writers_frozen', before: 'revision_01', after: 'revision_01' }, real_world_complete: false };
}
export function financialCitation(snapshot, row = snapshot.rows[0], column = row.cells[0].column_key) {
  return { schema_version: 'financial-citation-1', snapshot_id: snapshot.snapshot_id, content_hash: snapshot.content_hash,
    source_id: snapshot.source_id, source_doc_ref: snapshot.source_document_ref, row_path: row.row_path, column_key: column,
    native_entity_id: row.native_entity_id, native_entity_version: row.native_entity_version, native_line_id: row.native_line_id };
}
export async function financialFixtures() {
  const money = moneyFromDecimal('3700.00', 'USD');
  const snapshot = await sealFinancialSnapshot({ schema_version: 'financial-snapshot-1', contract: 'R1', snapshot_id: 'snapshot_01',
    generation: 1, source_kind: 'quickbooks_report', source_id: 'source_01', source_family: 'company_01', scope: financialScope(),
    requested_at: FINANCIAL_FIXTURE_TIME, observed_at: FINANCIAL_FIXTURE_TIME, provider_generated_at: FINANCIAL_FIXTURE_TIME,
    provider_version: 'fixture_1', raw_payload_hash: await financialHash(FINANCIAL_FIXTURE_RAW), source_document_ref: 'document_01',
    report: { requested_name: 'ProfitAndLoss', returned_name: 'ProfitAndLoss', reporting_type: 'period', no_report_data: false,
      header_path: '/Header', columns_path: '/Columns', rows_path: '/Rows' }, coverage: financialCoverage(),
    columns: [{ key: 'amount', kind: 'money', label: 'Amount', currency: 'USD', exponent: 2 }],
    rows: [{ row_path: '/Rows/0', parent_path: null, kind: 'detail', label: 'Net sales', group_ref: null, native_entity_id: null,
      native_entity_version: null, native_line_id: null, cells: [{ column_key: 'amount', raw_path: '/Rows/0/net_sales',
        raw_text: '3700.00', state: 'value', kind: 'money', money, text: null, role: 'measure' }] }],
    totals: [], lineage: { kind: 'source_record', root_ids: ['document_01'], source_families: ['company_01'] },
    supersedes: null, content_hash: '0'.repeat(64) });
  const citation = financialCitation(snapshot);
  const evidence = { state: 'present', value: money, citations: [citation], search_receipt: null, reason: 'cited_value' };
  const finding = { schema_version: 'books-finding-1', contract: 'B1', finding_id: 'finding_01', run_ref: 'run_01', generation: 1,
    rule_id: 'B07', rule_version: '1', policy_version: '1', scope: financialScope(), observed_at: FINANCIAL_FIXTURE_TIME,
    status: 'clear', outcome: 'pass', severity: 'none', left: structuredClone(evidence), right: structuredClone(evidence),
    difference: moneyFromDecimal('0.00', 'USD'), candidate_sets: [], reason: 'compared_claims_agree',
    question: 'Does the report scope explain the compared values?', wording: 'Possible issue', resolution: 'open',
    financial_authority: false, content_hash: '0'.repeat(64) };
  const tax = { schema_version: 'books-tax-1', contract: 'T1', scope: financialScope(), observed_at: FINANCIAL_FIXTURE_TIME,
    tax_year: 2025, filing_unit_ref: 'filing_unit_01', jurisdiction: 'US_federal', books_run_ref: 'run_01',
    report_snapshot_refs: [{ snapshot_id: snapshot.snapshot_id, content_hash: snapshot.content_hash }], coverage: financialCoverage(),
    metrics: [{ measure: 'net_sales', value: money, citation }], bridge_adjustments: [], open_finding_refs: [],
    mapping_version: 'pending_preparer_review', confirmation: null, tax_line: null, comparison: 'not_checked', difference: null,
    wording: 'Possible miss, review with your preparer', review_only: true, financial_authority: false };
  const answer = { schema_version: 'financial-answer-1', scope: financialScope(), observed_at: FINANCIAL_FIXTURE_TIME,
    intent: 'source_report', claims: [{ claim_id: 'claim_01', measure: 'net_sales', operation: 'source_cell', operands: [citation],
      value: money, role: 'measure', qualification: 'complete_report_scope', additive_set_ref: null }],
    financial_authority: false, rendering: 'fixed_claims_only' };
  return { snapshot, finding, tax, answer, contracts: { money, scope: financialScope(), coverage: financialCoverage(), citation, snapshot, finding, tax, answer } };
}
export async function invalidFinancialFixtures() {
  const { contracts } = await financialFixtures();
  const cases = [];
  const add = (kind, code, mutate) => { const value = structuredClone(contracts[kind]); mutate(value); cases.push({ kind, code, value }); };
  add('money', 'string', value => { value.amount_minor = 1.23; });
  add('money', 'money_value', value => { value.amount_minor = '1'; });
  add('money', 'money_currency', value => { value.currency = 'ZZZ'; });
  add('snapshot', 'required', value => { delete value.observed_at; });
  add('scope', 'required', value => { delete value.as_of; });
  add('scope', 'date', value => { value.as_of = '2025-02-30'; });
  add('coverage', 'required', value => { delete value.state; });
  add('coverage', 'coverage_incomplete', value => { value.expected_rows = null; });
  add('coverage', 'coverage_incomplete', value => { value.continuation = 'pending'; });
  add('coverage', 'coverage_incomplete', value => { value.durable_readback = false; });
  add('coverage', 'coverage_incomplete', value => { value.omissions = ['page_missing']; });
  add('coverage', 'mutation_mismatch', value => { value.mutation_check.after = 'revision_02'; });
  add('citation', 'required', value => { delete value.source_id; });
  add('snapshot', 'mixed_currency', value => { value.rows[0].cells[0].money = moneyFromDecimal('3700.00', 'EUR'); });
  add('snapshot', 'filter_unproved', value => { value.scope.class_filter = ['class_01']; });
  add('snapshot', 'duplicate_coordinate', value => { value.columns.push(structuredClone(value.columns[0])); });
  add('snapshot', 'row_hierarchy', value => { value.rows[0].parent_path = value.rows[0].row_path; });
  add('finding', 'finding_status', value => { value.status = 'finding'; });
  add('finding', 'evidence_missing', value => { value.left.citations = []; });
  add('tax', 'tax_review_required', value => { value.comparison = 'agree'; });
  add('tax', 'constant', value => { value.wording = 'The return is correct'; });
  add('answer', 'closed_object', value => { value.prose = 'A made-up amount'; });
  return cases;
}

export async function financialTaxComparison({ books = '3700.00', reported = '3700.00', comparison = 'agree', rounding = 'exact' } = {}) {
  const { tax } = await financialFixtures();
  tax.metrics[0].value = moneyFromDecimal(books, 'USD');
  tax.mapping_version = 'fixture_reviewed_map_1';
  tax.confirmation = { receipt_ref: 'review_01', binding_hash: '1'.repeat(64) };
  tax.tax_line = { filing_unit_ref: tax.filing_unit_ref, entity_ref: tax.scope.entity_ref, filer_role: 'filer', tax_year: 2025,
    jurisdiction: tax.jurisdiction, form: 'fixture_business_form', form_revision: 'fixture_2025', return_state: 'original',
    document_hash: '2'.repeat(64), extraction: 'reliable_mapped_native', review_receipt_ref: 'review_02',
    period: { start: tax.scope.period_start, end: tax.scope.period_end }, basis: 'accrual',
    page: 1, box: null, line: 'line_01', measure: 'net_sales', value: moneyFromDecimal(reported, 'USD'),
    citation: { ...tax.metrics[0].citation, snapshot_id: 'tax_snapshot_01', content_hash: '3'.repeat(64), source_id: 'tax_source_01', source_doc_ref: 'tax_document_01' }, rounding };
  tax.comparison = comparison;
  tax.difference = moneyFromMinor(BigInt(tax.metrics[0].value.amount_minor) - BigInt(tax.tax_line.value.amount_minor), 'USD');
  return tax;
}

export async function financialReportFixture({ count = 17, currency = 'USD', duplicateLabels = false } = {}) {
  if (!Number.isSafeInteger(count) || count < 0 || count > 1001) throw new Error('fixture_bound');
  const { snapshot } = await financialFixtures();
  const unit = moneyFromDecimal(currency === 'JPY' ? '1' : currency === 'KWD' ? '1.000' : '1.00', currency);
  const total = moneyFromMinor(BigInt(unit.amount_minor) * BigInt(count), currency);
  snapshot.scope.presentation_currency = currency; snapshot.scope.transaction_currencies = [currency];
  for (const parameter of snapshot.scope.report_parameters) if (parameter.name === 'presentation_currency') parameter.requested = parameter.echoed = currency;
  snapshot.coverage.parameters = structuredClone(snapshot.scope.report_parameters);
  snapshot.columns = [{ key: 'amount', kind: 'money', label: 'Amount', currency, exponent: unit.exponent },
    { key: 'label', kind: 'text', label: 'Label', currency: null, exponent: null }];
  const row = (index, money, kind) => ({ row_path: `/Rows/${index}`, parent_path: index === 0 ? null : '/Rows/0', kind,
    label: duplicateLabels ? 'Account' : `Account ${index}`, group_ref: index === 0 ? null : { kind: 'account', id: `account_${index}` },
    native_entity_id: null, native_entity_version: null, native_line_id: null,
    cells: [{ column_key: 'amount', raw_path: `/Rows/${index}/amount`, raw_text: money.decimal, state: 'value', kind: 'money', money, text: null, role: 'measure' },
      { column_key: 'label', raw_path: `/Rows/${index}/label`, raw_text: 'Account', state: 'value', kind: 'text', money: null, text: 'Account', role: 'unknown' }] });
  snapshot.rows = [row(0, total, 'total'), ...Array.from({ length: count }, (_, index) => row(index + 1, unit, 'detail'))];
  snapshot.totals = [{ row_path: '/Rows/0', column_key: 'amount' }];
  snapshot.report.no_report_data = count === 0;
  snapshot.coverage.expected_rows = snapshot.coverage.received_rows = snapshot.rows.length;
  const raw = JSON.stringify({ Header: { ReportName: 'ProfitAndLoss' }, Columns: snapshot.columns.map(column => ({ ColTitle: column.label, ColType: column.kind })),
    Rows: snapshot.rows.map(row => ({ amount: row.cells[0].raw_text, label: row.label })) });
  snapshot.raw_payload_hash = await financialHash(raw); snapshot.coverage.byte_count = new TextEncoder().encode(raw).length;
  snapshot.coverage.pages = [{ page_id: 'page_01', payload_hash: snapshot.raw_payload_hash, byte_count: snapshot.coverage.byte_count, row_count: snapshot.rows.length, parse_state: 'complete' }];
  return { snapshot: await sealFinancialSnapshot(snapshot), raw };
}
