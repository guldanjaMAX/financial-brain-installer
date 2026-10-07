// Invented oracle values, independent of the product rule catalog.
import { financialFixtures, financialCitation } from './financial-contract.mjs';
import { financialHash, canonicalFinancialJson, sealFinancialSnapshot, resolveFinancialCell } from '../../worker/src/lib/financial-snapshot-contract.js';
import { moneyFromDecimal } from '../../worker/src/lib/financial-money.js';

export const TAX_TIME = '2026-10-07T15:00:00.000Z';
export const TAX_CASES = [
  ['T01', 'wages', '1040', '1a', '64000.00', '59000.00', 'possible_miss'],
  ['T05', 'taxable_interest', '1040', '2b', '420.00', '0.00', 'possible_miss'],
  ['T06', 'ordinary_dividends', '1040', '3b', '850.00', '500.00', 'possible_miss'],
  ['T09', 'gross_receipts', 'Schedule-C', '1', '120000.00', '115000.00', 'discrepancy'],
  ['T11', 'reviewed_supplies', 'Schedule-C', '22', '2400.00', '0.00', 'discrepancy'],
  ['T12', 'home_office_cost', 'Schedule-C', '30', '3600.00', null, 'review_question'],
  ['T13', 'vehicle_cost', 'Schedule-C', '9', '1800.00', null, 'review_question'],
  ['T14', 'asset_cost', '4562', 'reviewed_schedule', '8000.00', null, 'review_question'],
  ['T15', 'retirement_contribution', 'Schedule-1', '20', '3000.00', null, 'review_question'],
  ['T16', 'hsa_personal_contribution', '8889', '2', '2000.00', null, 'review_question'],
  ['T17', 'shareholder_insurance', 'Schedule-1', '17', '4800.00', null, 'review_question'],
  ['T18', 'applied_estimates', '1040', '26', '12000.00', '9000.00', 'discrepancy'],
  ['T19', 'capital_loss_carryforward', 'Schedule-D', 'carryforward_workpaper', '7000.00', null, 'review_question'],
  ['T22', 'shareholder_distributions', 'W-2', 'box1', '50000.00', null, 'review_question'],
];
const hash = value => financialHash(canonicalFinancialJson(value));

export async function taxFixture({ rule = 'T05', control = false, books, reported, rounding = 'exact' } = {}) {
  const spec = TAX_CASES.find(row => row[0] === rule);
  const [, measure, form, line, sourceValue, returnValue] = spec;
  const { snapshot: seed, tax } = await financialFixtures();
  const scope = structuredClone(seed.scope);
  scope.period_end = scope.as_of = '2025-12-31';
  for (const p of scope.report_parameters) if (['period_end', 'as_of'].includes(p.name)) p.requested = p.echoed = '2025-12-31';
  async function snapshotFor(id, decimal, absent = false) {
    const item = structuredClone(seed);
    item.snapshot_id = `${id}_snapshot`; item.source_id = `${id}_source`; item.source_document_ref = `${id}_document`;
    item.source_family = `${id}_family`; item.scope = structuredClone(scope);
    item.observed_at = item.requested_at = item.provider_generated_at = TAX_TIME;
    item.coverage.parameters = structuredClone(scope.report_parameters);
    item.lineage = { kind: 'source_record', root_ids: [item.source_document_ref], source_families: [item.source_family] };
    item.source_kind = id === 'return' ? 'tax_report' : 'reviewed_import';
    item.rows[0].cells[0].money = moneyFromDecimal(decimal, 'USD');
    item.rows[0].cells[0].raw_text = decimal;
    item.report.no_report_data = absent;
    if (absent) {
      item.rows[0].kind = 'total';
      item.totals = [{ row_path: item.rows[0].row_path, column_key: 'amount' }];
    }
    return sealFinancialSnapshot(item);
  }
  const absence = returnValue === null && !control;
  const source = await snapshotFor('books', books ?? sourceValue);
  const target = await snapshotFor('return', reported ?? (control ? sourceValue : returnValue ?? '0.00'), absence);
  tax.scope = scope; tax.observed_at = TAX_TIME; tax.coverage = structuredClone(source.coverage);
  tax.mapping_version = 'fixture_tax_map_1';
  tax.metrics = [{ measure, value: source.rows[0].cells[0].money, citation: financialCitation(source) }];
  tax.report_snapshot_refs = [{ snapshot_id: source.snapshot_id, content_hash: source.content_hash }];
  const locator = { filing_unit_ref: tax.filing_unit_ref, entity_ref: scope.entity_ref, filer_role: 'filer', tax_year: 2025,
    jurisdiction: 'US_federal', form, form_revision: 'fixture_2025', period: { start: scope.period_start, end: scope.period_end },
    basis: scope.basis, return_state: 'original', document_hash: 'b'.repeat(64), page: 1, box: null, line, measure,
    citation: financialCitation(target) };
  tax.tax_line = absence ? null : { ...locator, extraction: 'owner_confirmed', review_receipt_ref: 'field_review_01',
    value: target.rows[0].cells[0].money, rounding };
  const mapping = { schema_version: 'tax-check-map-1', version: tax.mapping_version, reviewed: true,
    rules: [{ rule_id: rule, tax_year: 2025, jurisdiction: 'US_federal', form, form_revision: 'fixture_2025', line,
      measure, rounding, signed: true, currency: 'USD', period: structuredClone(locator.period), basis: scope.basis }],
    content_hash: '' };
  mapping.content_hash = await hash({ ...mapping, content_hash: null });
  const review = { schema_version: 'tax-check-review-1', receipt_ref: 'batch_review_01', authenticated: true,
    principal_ref: 'fixture_reviewer', confirmed_at: TAX_TIME, binding_hash: '', mapping_hash: mapping.content_hash,
    source_inventory: 'complete_for_rule', return_inventory: 'complete_for_rule', inventory_revision: 'inventory_01',
    corrections_reviewed: true, allocations_reviewed: true, adjustments_reviewed: true,
    treatment: control ? 'linked' : 'unlinked', operative_return_hash: locator.document_hash,
    reviewed_absence: absence ? locator : null };
  const fieldReview = tax.tax_line ? { schema_version: 'tax-field-review-1', receipt_ref: 'field_review_01', authenticated: true,
    principal_ref: 'fixture_reviewer', confirmed_at: TAX_TIME, confirmation: 'owner_confirmed_from_document',
    line_hash: await hash(tax.tax_line) } : null;
  const calls = [];
  const snapshots = new Map([source, target].map(item => [item.snapshot_id, item]));
  const state = { denied: false, current: true, documentHash: locator.document_hash, textSource: 'ocr', mapHead: scope.owner_map_head };
  async function rebind() {
    review.binding_hash = await hash({ rule_id: rule, transfer: { ...tax, confirmation: null, comparison: 'not_checked', difference: null } });
    tax.confirmation = { receipt_ref: review.receipt_ref, binding_hash: review.binding_hash };
  }
  await rebind();
  const deps = {
    now: TAX_TIME,
    readCitation: async ({ citation }) => {
      calls.push('citation');
      if (state.denied || !state.current) throw new Error('fixture_denied');
      const snapshot = snapshots.get(citation.snapshot_id);
      return { snapshot, ...resolveFinancialCell(snapshot, citation) };
    },
    readReview: async ({ receipt_ref }) => { calls.push('review'); return structuredClone(receipt_ref === review.receipt_ref ? review : fieldReview); },
    readMapping: async () => { calls.push('mapping'); return structuredClone(mapping); },
    readDocument: async () => { calls.push('document'); return { available: !state.denied, current: state.current,
      document_hash: state.documentHash, text_source: state.textSource, text_reliable: state.textSource === 'native' }; },
    readMapHead: async () => { calls.push('map_head'); return state.mapHead; },
  };
  return { rule, spec, tax, source, target, locator, mapping, review, fieldReview, deps, calls, state, snapshots, rebind };
}
