import { FINANCIAL_CONTRACT_SCHEMA } from './financial-contract-schema.js';
import { assertMoney, FINANCIAL_CURRENCY_EXPONENTS, financialError, moneyFromDecimal, moneyFromMinor } from './financial-money.js';

export { FINANCIAL_CONTRACT_SCHEMA };
export function canonicalFinancialJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalFinancialJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalFinancialJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function financialHash(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function validFinancialDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
function validInstant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return validFinancialDate(value.slice(0, 10)) && Number(value.slice(11, 13)) < 24 &&
    Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60 && Number.isFinite(Date.parse(value));
}
function unique(values) { return new Set(values).size === values.length; }
function equal(a, b) { return canonicalFinancialJson(a) === canonicalFinancialJson(b); }
function sameSet(a, b) { return Array.isArray(a) && Array.isArray(b) && equal([...a].sort(), [...b].sort()); }

// No input values, labels or opaque IDs are included in errors. The count is
// also a decision-point witness for adversarial and negative fixture tests.
export function validateFinancialContract(kind, value) {
  const errors = [];
  let checked = 0;
  let failures = 0;
  const fail = code => { failures++; if (errors.length < 64) errors.push({ code }); };
  function visit(schema, item, depth = 0) {
    checked++;
    if (depth > 30) { fail('depth_limit'); return; }
    if (schema.$ref) {
      const name = schema.$ref.slice('#/$defs/'.length);
      const before = failures;
      visit(FINANCIAL_CONTRACT_SCHEMA.$defs[name], item, depth + 1);
      if (failures === before) semantic(name, item);
      return;
    }
    if (schema.anyOf) {
      // The schema's only unions are nullable, so no speculative validation
      // can accidentally erase a semantic failure in another branch.
      if (item === null) return;
      visit(schema.anyOf[0], item, depth + 1); return;
    }
    if ('const' in schema && !equal(schema.const, item)) { fail('constant'); return; }
    if (schema.enum && !schema.enum.includes(item)) { fail('enum'); return; }
    if (schema.type === 'object') {
      if (!item || typeof item !== 'object' || Array.isArray(item) || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) { fail('object'); return; }
      if (Object.keys(item).some(key => !Object.hasOwn(schema.properties, key))) fail('closed_object');
      if (schema.required.some(key => !Object.hasOwn(item, key))) fail('required');
      for (const [key, field] of Object.entries(schema.properties)) if (Object.hasOwn(item, key)) visit(field, item[key], depth + 1);
    } else if (schema.type === 'array') {
      if (!Array.isArray(item)) { fail('array'); return; }
      if (item.length < schema.minItems || item.length > schema.maxItems) { fail('array_size'); return; }
      item.forEach(child => visit(schema.items, child, depth + 1));
    } else if (schema.type === 'string') {
      if (typeof item !== 'string' || item.length < (schema.minLength ?? 0) || item.length > schema.maxLength || /[\u0000-\u001f\u007f]/.test(item)) { fail('string'); return; }
      if (schema.pattern && !new RegExp(schema.pattern).test(item)) fail('pattern');
      if (schema.format === 'date' && !validFinancialDate(item)) fail('date');
      if (schema.format === 'date-time' && !validInstant(item)) fail('as_of');
    } else if (schema.type === 'integer' && (!Number.isSafeInteger(item) || item < schema.minimum || item > schema.maximum)) fail('integer');
    else if (schema.type === 'boolean' && typeof item !== 'boolean') fail('boolean');
  }
  function semantic(name, item) {
    checked++;
    if (name === 'money') { try { assertMoney(item); } catch (error) { fail(error.code); } }
    if (name === 'scope') {
      if (item.period_start > item.period_end || item.as_of !== item.period_end) fail('scope_dates');
      if (item.fiscal_year_end !== null && !validFinancialDate(`2000-${item.fiscal_year_end}`)) fail('date');
      if (item.company_timezone !== null) { try { new Intl.DateTimeFormat('en', { timeZone: item.company_timezone }); } catch { fail('timezone'); } }
      for (const code of [item.presentation_currency, ...(item.transaction_currencies || [])].filter(v => v !== null)) {
        if (!Object.hasOwn(FINANCIAL_CURRENCY_EXPONENTS, code)) fail('money_currency');
      }
      for (const values of [item.class_filter, item.department_filter, item.account_filter, item.transaction_currencies]) if (values !== null && !unique(values)) fail('duplicate_scope');
      if (!unique(item.report_parameters.map(parameter => parameter.name))) fail('duplicate_parameter');
    }
    if (name === 'coverage') {
      for (const values of [item.expected_report_types, item.received_report_types, item.expected_entity_types, item.received_entity_types]) if (values !== null && !unique(values)) fail('duplicate_coverage');
      if (!unique(item.parameters.map(parameter => parameter.name))) fail('duplicate_parameter');
      if (!unique(item.pages.map(page => page.page_id)) || !unique(item.pages.map(page => page.payload_hash))) fail('repeated_page');
      if (item.pages.length !== item.received_pages || item.pages.reduce((sum, page) => sum + BigInt(page.row_count), 0n) !== BigInt(item.received_rows) ||
        item.pages.reduce((sum, page) => sum + BigInt(page.byte_count), 0n) !== BigInt(item.byte_count)) fail('page_binding');
      const parametersMatch = item.parameters.every(parameter => parameter.requested !== null && parameter.requested === parameter.echoed);
      if (item.parameter_match && !parametersMatch) fail('parameter_mismatch');
      if (item.mutation_check.state === 'stable' && (item.mutation_check.before === null || item.mutation_check.before !== item.mutation_check.after)) fail('mutation_mismatch');
      if (item.state === 'complete_for_report_scope' && (
        !sameSet(item.expected_report_types, item.received_report_types) || !sameSet(item.expected_entity_types, item.received_entity_types) ||
        item.expected_pages === null || item.expected_pages < 1 || item.expected_pages !== item.received_pages ||
        item.expected_rows === null || item.expected_rows !== item.received_rows ||
        !['exhausted', 'not_applicable'].includes(item.continuation) || item.parse_failures.length || item.omissions.length ||
        item.unsupported_capabilities.length || !item.parameter_match || !item.durable_readback || !item.byte_count ||
        !['stable', 'not_supported'].includes(item.mutation_check.state) || item.pages.some(page => page.parse_state !== 'complete'))) fail('coverage_incomplete');
    }
    if (name === 'citation' && ((item.native_entity_id === null) !== (item.native_entity_version === null) ||
      (item.native_line_id !== null && item.native_entity_id === null))) fail('native_identity');
    if (name === 'column') {
      if ((item.kind === 'money') !== (item.currency !== null && item.exponent !== null)) fail('column_money');
      if (item.currency !== null && FINANCIAL_CURRENCY_EXPONENTS[item.currency] !== item.exponent) fail('money_currency');
    }
    if (name === 'cell') {
      if ((item.kind === 'money' && item.state === 'value') !== (item.money !== null)) fail('cell_money');
      if (item.money && item.raw_text !== item.money.decimal &&
        (!/^\((0|[1-9][0-9]*)(\.[0-9]+)?\)$/.test(item.raw_text) || `-${item.raw_text.slice(1, -1)}` !== item.money.decimal)) fail('cell_decimal_mismatch');
      if (item.kind === 'money' && item.text !== null) fail('cell_text');
      if (item.kind !== 'money' && item.state === 'value' && item.text === null) fail('cell_text');
      if (item.state !== 'value' && (item.text !== null || item.money !== null)) fail('blank_value');
      if (item.kind === 'date' && item.text !== null && !validFinancialDate(item.text)) fail('date');
      if (item.kind === 'percentage' && item.text !== null && !/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(item.text)) fail('percentage');
    }
    if (name === 'snapshot') checkSnapshot(item);
    if (name === 'evidence') {
      if (item.state === 'present' && !item.citations.length) fail('evidence_missing');
      if (item.state !== 'present' && (item.value !== null || item.citations.length)) fail('fabricated_absence');
      if (item.state === 'absent' && (!item.search_receipt || item.search_receipt.match_count !== 0 || item.search_receipt.coverage.state !== 'complete_for_report_scope')) fail('absence_unproved');
      if (item.state !== 'absent' && item.search_receipt !== null) fail('unexpected_search');
    }
    if (name === 'finding') {
      const summary = { pass: 'clear', not_applicable: 'clear', candidate: 'finding', incomplete: 'incomplete', not_comparable: 'incomplete' };
      if (summary[item.outcome] !== item.status) fail('finding_status');
      if (['pass', 'candidate'].includes(item.outcome) && [item.left, item.right].some(side => side.state === 'unavailable')) fail('evidence_missing');
      if (item.outcome === 'candidate' && item.severity === 'none') fail('finding_severity');
      if (item.outcome === 'pass' && item.severity !== 'none') fail('finding_severity');
      if (item.outcome === 'pass' && item.difference !== null && item.difference.amount_minor !== '0') fail('finding_status');
      for (const side of [item.left, item.right]) if (side.search_receipt && !equal(side.search_receipt.scope, item.scope)) fail('scope_mismatch');
      if (item.difference !== null) {
        try {
          const [left, right] = [item.left.value, item.right.value].map(v => assertMoney(v, { exact: true }));
          if (left.currency !== right.currency || left.currency !== item.difference.currency) fail('mixed_currency');
          else if (!equal(moneyFromMinor(BigInt(left.amount_minor) - BigInt(right.amount_minor), left.currency), item.difference)) fail('difference_mismatch');
        } catch { fail('difference_unproved'); }
      }
    }
    if (name === 'tax') checkTax(item);
    if (name === 'answer') {
      for (const key of ['entity_ref', 'owner_map_head', 'company_fingerprint', 'basis', 'presentation_currency', 'company_timezone', 'class_filter', 'department_filter', 'account_filter']) if (item.scope[key] === null) fail('scope_unknown');
      if (!unique(item.claims.map(claim => claim.claim_id))) fail('duplicate_claim');
      for (const claim of item.claims) {
        if (claim.value.currency !== item.scope.presentation_currency) fail('mixed_currency');
        if (claim.operation === 'source_cell' && claim.operands.length !== 1) fail('operand_count');
        if (claim.operation === 'difference' && claim.operands.length !== 2) fail('operand_count');
        if (claim.operation === 'sum' && !claim.additive_set_ref) fail('additivity_unproved');
        if (claim.operation !== 'sum' && claim.additive_set_ref !== null) fail('unexpected_additivity');
        if (claim.role === 'unknown') fail('unknown_role');
        if (claim.qualification === 'partial_individual_fact' && claim.operation !== 'source_cell') fail('partial_aggregate');
      }
    }
  }
  function checkSnapshot(item) {
    if (Date.parse(item.requested_at) > Date.parse(item.observed_at)) fail('observation_order');
    if (item.report.requested_name !== item.report.returned_name) fail('report_mismatch');
    if (!unique(item.columns.map(column => column.key)) || !unique(item.rows.map(row => row.row_path))) fail('duplicate_coordinate');
    if (!unique(item.lineage.root_ids) || !unique(item.lineage.source_families) || !item.lineage.source_families.includes(item.source_family)) fail('lineage');
    if (item.lineage.kind === 'source_record' && !sameSet(item.lineage.root_ids, [item.source_document_ref])) fail('lineage');
    if (item.coverage.received_rows !== item.rows.length || !equal(item.scope.report_parameters, item.coverage.parameters)) fail('coverage_binding');
    if (!item.coverage.received_report_types.includes(item.report.returned_name)) fail('coverage_binding');
    if (item.report.no_report_data && item.rows.some(row => row.kind === 'detail')) fail('no_data_conflict');
    if (item.report.no_report_data && item.rows.some(row => row.cells.some(cell => cell.money && cell.money.amount_minor !== '0'))) fail('no_data_conflict');
    if ((item.generation === 1) !== (item.supersedes === null) || item.supersedes?.snapshot_id === item.snapshot_id) fail('generation');
    const rows = new Map(item.rows.map(row => [row.row_path, row]));
    const columns = new Map(item.columns.map(column => [column.key, column]));
    for (const row of item.rows) {
      if (!unique(row.cells.map(cell => cell.column_key))) fail('duplicate_coordinate');
      if (row.kind === 'detail' && !sameSet(row.cells.map(cell => cell.column_key), item.columns.map(column => column.key))) fail('row_cells_missing');
      const visited = new Set([row.row_path]);
      let parent = row.parent_path;
      while (parent !== null) {
        if (!rows.has(parent) || visited.has(parent)) { fail('row_hierarchy'); break; }
        visited.add(parent); parent = rows.get(parent).parent_path;
      }
      if ((row.native_entity_id === null) !== (row.native_entity_version === null) || (row.native_line_id !== null && row.native_entity_id === null)) fail('native_identity');
      for (const cell of row.cells) {
        const column = columns.get(cell.column_key);
        if (!column || column.kind !== cell.kind) fail('column_binding');
        if (cell.money && (cell.money.currency !== column?.currency || cell.money.exponent !== column?.exponent)) fail('mixed_currency');
      }
    }
    if (!unique(item.totals.map(total => canonicalFinancialJson(total)))) fail('duplicate_coordinate');
    for (const total of item.totals) {
      const row = rows.get(total.row_path);
      if (!row || !['subtotal', 'total'].includes(row.kind) || !row.cells.some(cell => cell.column_key === total.column_key && cell.money !== null)) fail('total_coordinate');
    }
    if (item.coverage.state === 'complete_for_report_scope') {
      for (const key of ['entity_ref', 'owner_map_head', 'company_fingerprint', 'basis', 'presentation_currency', 'company_timezone', 'class_filter', 'department_filter', 'account_filter']) if (item.scope[key] === null) fail('scope_unknown');
      // Empty filters mean all only with explicit request/echo proof.
      for (const key of ['class_filter', 'department_filter', 'account_filter']) {
        const parameter = item.scope.report_parameters.find(p => p.name === key);
        if (!parameter || parameter.requested !== canonicalFinancialJson(item.scope[key]) || parameter.echoed !== parameter.requested) fail('filter_unproved');
      }
      for (const [name, expected] of Object.entries({
        report_name: item.report.returned_name, company_fingerprint: item.scope.company_fingerprint,
        period_start: item.scope.period_start, period_end: item.scope.period_end, as_of: item.scope.as_of,
        basis: item.scope.basis, presentation_currency: item.scope.presentation_currency,
      })) {
        if (!item.scope.report_parameters.some(parameter => parameter.name === name && parameter.requested === expected && parameter.echoed === expected)) fail('report_scope_unproved');
      }
    }
  }
  function checkTax(item) {
    if (!equal(item.coverage.parameters, item.scope.report_parameters)) fail('coverage_binding');
    if (item.scope.presentation_currency === null) fail('scope_unknown');
    for (const metric of [...item.metrics, ...item.bridge_adjustments]) {
      if (metric.value.currency !== item.scope.presentation_currency) fail('mixed_currency');
      if (!item.report_snapshot_refs.some(reference => reference.snapshot_id === metric.citation.snapshot_id && reference.content_hash === metric.citation.content_hash)) fail('tax_snapshot_binding');
    }
    if (!unique(item.metrics.map(metric => metric.measure))) fail('duplicate_measure');
    if (item.comparison === 'not_checked') { if (item.difference !== null) fail('unchecked_difference'); return; }
    const line = item.tax_line;
    if (!line || !item.confirmation || item.mapping_version === 'pending_preparer_review' || item.coverage.state !== 'complete_for_report_scope') { fail('tax_review_required'); return; }
    if (line.filing_unit_ref !== item.filing_unit_ref || line.entity_ref !== item.scope.entity_ref || line.filer_role !== 'filer' ||
      line.tax_year !== item.tax_year || line.jurisdiction !== item.jurisdiction || line.value.currency !== item.scope.presentation_currency ||
      line.period.start !== item.scope.period_start || line.period.end !== item.scope.period_end || line.basis !== item.scope.basis) fail('tax_scope');
    if (line.return_state === 'superseded' || !['reliable_mapped_native', 'owner_confirmed'].includes(line.extraction) || !line.review_receipt_ref) fail('tax_review_required');
    const metric = item.metrics.find(candidate => candidate.measure === line.measure);
    if (!metric) { fail('tax_measure'); return; }
    try {
      const values = [metric.value, ...item.bridge_adjustments.filter(adjustment => adjustment.measure === line.measure).map(adjustment => adjustment.value)];
      values.forEach(value => assertMoney(value, { exact: true }));
      assertMoney(line.value, { exact: true });
      const books = values.reduce((sum, value) => sum + BigInt(value.amount_minor), 0n);
      const reported = BigInt(line.value.amount_minor), residual = books - reported;
      if (!item.difference || item.difference.currency !== line.value.currency || item.difference.amount_minor !== String(residual)) fail('difference_mismatch');
      if (line.rounding === 'unknown') fail('tax_precision');
      if (item.comparison === 'agree' && (residual !== 0n || line.rounding !== 'exact')) fail('tax_equality');
      if (line.rounding === 'whole_dollar_half_away_from_zero') {
        const unit = 10n ** BigInt(line.value.exponent);
        if (reported % unit !== 0n) fail('tax_precision');
        const rounded = ((books < 0n ? -books : books) + unit / 2n) / unit * unit * (books < 0n ? -1n : 1n);
        if ((item.comparison === 'consistent_with_reported_precision') !== (rounded === reported)) fail('tax_rounding');
      } else if (item.comparison === 'consistent_with_reported_precision') fail('tax_precision');
      if (item.comparison === 'candidate' && residual === 0n) fail('tax_equality');
    } catch { fail('tax_precision'); }
  }
  if (!Object.hasOwn(FINANCIAL_CONTRACT_SCHEMA.$defs, kind)) fail('unknown_contract');
  else visit({ $ref: `#/$defs/${kind}` }, value);
  return { ok: errors.length === 0, checked, errors };
}
export function assertFinancialContract(kind, value) {
  const result = validateFinancialContract(kind, value);
  if (!result.ok) throw financialError(result.errors[0].code);
  return value;
}
export async function sealFinancialSnapshot(input) {
  const snapshot = structuredClone(input);
  snapshot.content_hash = '0'.repeat(64);
  assertFinancialContract('snapshot', snapshot);
  const { content_hash: ignored, ...payload } = snapshot;
  snapshot.content_hash = await financialHash(canonicalFinancialJson(payload));
  return snapshot;
}
export async function verifyFinancialSnapshot(snapshot) {
  assertFinancialContract('snapshot', snapshot);
  const { content_hash, ...payload } = snapshot;
  if (await financialHash(canonicalFinancialJson(payload)) !== content_hash) throw financialError('snapshot_hash');
  return snapshot;
}
export function resolveFinancialCell(snapshot, citation) {
  assertFinancialContract('citation', citation);
  if (citation.snapshot_id !== snapshot.snapshot_id || citation.content_hash !== snapshot.content_hash ||
      citation.source_id !== snapshot.source_id || citation.source_doc_ref !== snapshot.source_document_ref) throw financialError('citation_binding');
  const row = snapshot.rows.find(candidate => candidate.row_path === citation.row_path);
  const cell = row?.cells.find(candidate => candidate.column_key === citation.column_key);
  if (!cell || ['native_entity_id', 'native_entity_version', 'native_line_id'].some(key => row[key] !== citation[key])) throw financialError('citation_coordinate');
  return { row, cell };
}

// Provider adapters supply the verified column semantics and explicit blank
// state. V1 supports only canonical decimal and reviewed accounting parentheses;
// it never guesses separators, currency, units, or whether a blank means zero.
export function normalizeFinancialReportCell({ column_key, raw_path, raw_text, kind, state, role, currency = null, format = 'canonical' }) {
  if (!['canonical', 'accounting_parentheses'].includes(format)) throw financialError('display_format');
  let money = null, text = null;
  if (state === 'value') {
    if (kind === 'money') {
      const decimal = format === 'accounting_parentheses' && typeof raw_text === 'string' && /^\((0|[1-9][0-9]*)(\.[0-9]+)?\)$/.test(raw_text)
        ? `-${raw_text.slice(1, -1)}` : raw_text;
      money = moneyFromDecimal(decimal, currency);
    } else text = raw_text;
  }
  if (state === 'blank' && raw_text !== '') throw financialError('blank_value');
  const cell = { column_key, raw_path, raw_text, state, kind, money, text, role };
  return assertFinancialContract('cell', cell);
}
