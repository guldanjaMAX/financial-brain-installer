import { validateFinancialContract } from './financial-snapshot-contract.js';
import { sumMoney, moneyFromMinor } from './financial-money.js';

export const TAX_CHECK_WORDING = 'Possible miss, review with your preparer';
export const TAX_CHECK_VERSION = 'tax-check-1';
const TARGET_FORMS = new Set(['1040', 'Schedule-1', 'Schedule-C', 'Schedule-D', '4562', '8889', '1120-S', '1065', '1120', 'W-2']);
const definitions = [
  ['Wages', 'wages', 'lower_bound'], ['Nonemployee compensation'], ['Miscellaneous income'], ['Recipient K-1'],
  ['Taxable interest', 'taxable_interest', 'lower_bound'], ['Ordinary dividends', 'ordinary_dividends', 'lower_bound'],
  ['Securities transactions'], ['Retirement distributions'], ['Gross receipts', 'gross_receipts', 'equal'],
  ['Payment processor coverage'], ['Reviewed supplies', 'reviewed_supplies', 'equal'],
  ['Home office records', 'home_office_cost', 'review'], ['Vehicle records', 'vehicle_cost', 'review'],
  ['Asset records', 'asset_cost', 'review'], ['Retirement contributions', 'retirement_contribution', 'review'],
  ['Personal HSA contributions', 'hsa_personal_contribution', 'review'],
  ['Shareholder insurance', 'shareholder_insurance', 'review'], ['Applied estimated payments', 'applied_estimates', 'equal'],
  ['Capital loss carryforward', 'capital_loss_carryforward', 'review'], ['Net operating loss carryforward'],
  ['Charitable carryforward'], ['Shareholder distributions', 'shareholder_distributions', 'review'],
  ['State items'], ['Mortgage interest'], ['Itemized tax payments'], ['Qualified business income worksheet'],
  ['Self-employment schedule transfer'], ['Additional tax schedule transfer'], ['Credit and payment schedule transfer'],
  ['Return version and coverage'], ['Federal withholding'], ['Business book-tax balance bridge'],
];
export const TAX_CHECK_CATALOG = Object.freeze(definitions.map(([label, measure = null, mode = null], index) => Object.freeze({
  rule_id: `T${String(index + 1).padStart(2, '0')}`, label, measure, mode, implemented: mode !== null,
})));

export function uncheckedTaxResult(ruleId, reason, trace = []) {
  const rule = TAX_CHECK_CATALOG.find(item => item.rule_id === ruleId);
  return { schema_version: TAX_CHECK_VERSION, rule_id: rule?.rule_id ?? null,
    status: 'not_checked', reason, trace: [...trace], wording: TAX_CHECK_WORDING,
    review_only: true, financial_authority: false, tax_advice: false, return_correctness_proven: false,
    source_value: null, return_value: null, difference: null, citations: [], comparison: 'not_checked',
    value_basis: null, severity: 'none', transfer: null };
}

// A pure computation seam, not an authorization API. Only the coordinator may
// supply review/mapping resolved from authenticated storage. Caller booleans
// never establish authority; this function also refuses without those records.
export function evaluateTaxRule(ruleId, transfer, { review, mapping } = {}) {
  const trace = ['catalog'];
  const refuse = reason => uncheckedTaxResult(ruleId, reason, trace);
  const rule = TAX_CHECK_CATALOG.find(item => item.rule_id === ruleId);
  if (!rule?.implemented) return refuse('rule_not_implemented');
  trace.push('contract');
  if (!validateFinancialContract('tax', transfer).ok) return refuse('invalid_transfer');
  trace.push('confirmation');
  if (!review || !mapping || review.authenticated !== true || !transfer.confirmation) return refuse('review_required');
  trace.push('coverage');
  if (transfer.coverage.state !== 'complete_for_report_scope' || review.source_inventory !== 'complete_for_rule' ||
      review.return_inventory !== 'complete_for_rule' || !review.inventory_revision || review.corrections_reviewed !== true ||
      review.allocations_reviewed !== true || review.adjustments_reviewed !== true || transfer.open_finding_refs.length ||
      !['linked', 'unlinked', 'not_applicable'].includes(review.treatment)) return refuse('rule_coverage_incomplete');
  trace.push('mapping');
  const target = transfer.tax_line ?? review.reviewed_absence;
  const entry = mapping.rules?.find(item => item.rule_id === ruleId);
  if (!entry || entry.measure !== rule.measure || !target || target.measure !== rule.measure ||
      !TARGET_FORMS.has(target.form) || !/^(?:box)?[0-9]{1,3}[a-z]?$|^reviewed_schedule$|^carryforward_workpaper$/.test(target.line) ||
      entry.form !== target.form || entry.form_revision !== target.form_revision || entry.line !== target.line ||
      entry.tax_year !== transfer.tax_year || entry.jurisdiction !== transfer.jurisdiction ||
      entry.currency !== transfer.scope.presentation_currency || entry.currency !== 'USD' ||
      entry.basis !== transfer.scope.basis || entry.period?.start !== transfer.scope.period_start ||
      entry.period?.end !== transfer.scope.period_end ||
      (transfer.tax_line && entry.rounding !== transfer.tax_line.rounding)) return refuse('comparison_mapping_unresolved');
  const metric = transfer.metrics.find(item => item.measure === rule.measure);
  // T1 has one cited, reviewed aggregate per measure. Never sum arbitrary
  // retrieved documents, ordinary+qualified dividends, or 1099-K plus books.
  if (!metric || transfer.metrics.length !== 1 || transfer.bridge_adjustments.some(item => item.measure !== rule.measure)) return refuse('measure_unavailable');
  trace.push('amounts');
  let source, difference;
  try {
    source = sumMoney([metric.value, ...transfer.bridge_adjustments.map(item => item.value)]);
    if (!entry.signed && BigInt(source.amount_minor) < 0n) return refuse('signed_value_unreviewed');
    if (transfer.tax_line) {
      difference = moneyFromMinor(BigInt(source.amount_minor) - BigInt(transfer.tax_line.value.amount_minor), source.currency);
      if (!entry.signed && BigInt(transfer.tax_line.value.amount_minor) < 0n) return refuse('signed_value_unreviewed');
    }
  } catch { return refuse('amount_unavailable'); }
  if (rule.mode !== 'review' && !transfer.tax_line) return refuse('return_value_unavailable');
  if (rule.mode === 'review' && !transfer.tax_line && !review.reviewed_absence) return refuse('return_coverage_unavailable');
  let compared = structuredClone(transfer), status, comparison = 'not_checked';
  if (rule.mode === 'review') {
    // A linked alternative method, rollover, exhausted carryforward, or other
    // reviewed treatment defeats the prompt even when the visible line is zero.
    status = review.treatment === 'unlinked' && BigInt(source.amount_minor) > 0n ? 'review_question' : 'no_signal';
    compared.comparison = 'not_checked'; compared.difference = null;
  } else {
    const value = BigInt(source.amount_minor), reported = BigInt(transfer.tax_line.value.amount_minor);
    let comparable = value;
    if (transfer.tax_line.rounding === 'whole_dollar_half_away_from_zero') {
      const unit = 10n ** BigInt(source.exponent);
      comparable = ((value < 0n ? -value : value) + unit / 2n) / unit * unit * (value < 0n ? -1n : 1n);
      comparison = comparable === reported ? 'consistent_with_reported_precision' : 'candidate';
    } else if (transfer.tax_line.rounding === 'exact') comparison = value === reported ? 'agree' : 'candidate';
    else return refuse('rounding_unreviewed');
    compared.comparison = comparison; compared.difference = difference;
    if (!validateFinancialContract('tax', compared).ok) return refuse('comparison_invalid');
    const signal = rule.mode === 'lower_bound' ? comparable > reported : comparable !== reported;
    status = signal ? rule.mode === 'lower_bound' ? 'possible_miss' : 'discrepancy' : 'no_signal';
  }
  trace.push('compare');
  return { ...uncheckedTaxResult(ruleId, 'reviewed_comparison', trace), status,
    severity: status === 'review_question' ? 'review' : ['possible_miss', 'discrepancy'].includes(status) ? 'priority_review' : 'none',
    source_value: source, return_value: transfer.tax_line?.value ?? null,
    difference: rule.mode === 'review' ? null : difference, comparison,
    citations: [metric.citation, ...transfer.bridge_adjustments.map(item => item.citation), target.citation],
    value_basis: transfer.tax_line?.extraction === 'owner_confirmed' ? 'includes_owner_stated_value' : 'reviewed_evidence',
    transfer: compared };
}
