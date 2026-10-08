// Shared by local connectors and the Worker. These are JSON Schema 2020-12
// descriptors, not permission or evidence receipts. Semantic checks live in
// financial-snapshot-contract.js; callers must use both through its validator.
const str = (maxLength = 256) => ({ type: 'string', minLength: 1, maxLength });
const enumeration = (...values) => ({ enum: values });
const ref = name => ({ $ref: `#/$defs/${name}` });
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const array = (items, maxItems = 10000, minItems = 0) => ({ type: 'array', items, maxItems, minItems });
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const integer = (minimum = 0) => ({ type: 'integer', minimum, maximum: Number.MAX_SAFE_INTEGER });
const version = value => ({ const: value });
const bool = { type: 'boolean' };
const hash = { ...str(64), pattern: '^[a-f0-9]{64}$' };
const id = str(); // Opaque bytes are compared verbatim, never trimmed on one side.
const date = { ...str(10), format: 'date' };
const instant = { ...str(35), format: 'date-time' };
const path = { ...str(2048), pattern: '^/' };
const decimal = { ...str(160), pattern: '^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$' };
const minor = { ...str(79), pattern: '^(0|-?[1-9][0-9]*)$' };
const currency = { ...str(3), pattern: '^[A-Z]{3}$' };
const filter = nullable(array(id, 1000));
const parameters = array(object({ name: id, requested: nullable(str(2048)), echoed: nullable(str(2048)) }), 100);
const role = enumeration('debit', 'credit', 'asset', 'liability', 'inflow', 'outflow', 'measure', 'unknown');

const defs = {
  money: object({ decimal, currency, exponent: integer(), amount_minor: nullable(minor),
    precision: enumeration('exact', 'provider_rounded', 'derived_rounded', 'unrepresentable') }),
  scope: object({ tenant: id, entity_ref: nullable(id), owner_map_head: nullable(id),
    company_fingerprint: nullable(hash), period_start: date, period_end: date, as_of: date,
    fiscal_year_end: nullable({ ...str(5), pattern: '^[0-9]{2}-[0-9]{2}$' }),
    company_timezone: nullable(str(100)), basis: nullable(enumeration('cash', 'accrual')),
    presentation_currency: nullable(currency), transaction_currencies: nullable(array(currency, 100)),
    class_filter: filter, department_filter: filter, account_filter: filter, report_parameters: parameters }),
  coverage: object({ schema_version: version('financial-coverage-1'),
    state: enumeration('complete_for_report_scope', 'partial', 'unavailable', 'not_applicable'), reason: id,
    expected_report_types: nullable(array(id, 100)), received_report_types: array(id, 100),
    expected_entity_types: nullable(array(id, 100)), received_entity_types: array(id, 100),
    expected_pages: nullable(integer()), received_pages: integer(), expected_rows: nullable(integer()), received_rows: integer(),
    pages: array(object({ page_id: id, payload_hash: hash, byte_count: integer(1), row_count: integer(), parse_state: enumeration('complete', 'failed') }), 1000),
    continuation: enumeration('exhausted', 'not_applicable', 'pending', 'unknown'),
    parse_failures: array(id, 1000), omissions: array(id, 1000), unsupported_capabilities: array(id, 1000),
    parameters, parameter_match: bool, byte_count: integer(), durable_readback: bool,
    mutation_check: object({ state: enumeration('stable', 'changed', 'not_supported', 'unknown'),
      method: id, before: nullable(id), after: nullable(id) }), real_world_complete: version(false) }),
  citation: object({ schema_version: version('financial-citation-1'), snapshot_id: id, content_hash: hash,
    source_id: id, source_doc_ref: id, row_path: path, column_key: id,
    native_entity_id: nullable(id), native_entity_version: nullable(id), native_line_id: nullable(id) }),
  snapshot_ref: object({ snapshot_id: id, content_hash: hash }),
  column: object({ key: id, kind: enumeration('money', 'text', 'date', 'percentage'), label: str(1000),
    currency: nullable(currency), exponent: nullable(integer()) }),
  cell: object({ column_key: id, raw_path: path, raw_text: { type: 'string', maxLength: 4000 },
    state: enumeration('value', 'blank', 'unavailable', 'not_applicable'),
    kind: enumeration('money', 'text', 'date', 'percentage'), money: nullable(ref('money')),
    text: nullable({ type: 'string', maxLength: 4000 }), role }),
  row: object({ row_path: path, parent_path: nullable(path), kind: enumeration('header', 'detail', 'subtotal', 'total'),
    label: { type: 'string', maxLength: 1000 }, group_ref: nullable(object({ kind: enumeration('account', 'customer', 'vendor', 'class', 'department', 'other'), id })),
    native_entity_id: nullable(id),
    native_entity_version: nullable(id), native_line_id: nullable(id), cells: array(ref('cell'), 100) }),
  snapshot: object({ schema_version: version('financial-snapshot-1'), contract: version('R1'),
    snapshot_id: id, generation: integer(1), source_kind: enumeration('quickbooks_report', 'bank_report', 'tax_report', 'reviewed_import'),
    source_id: id, source_family: id, scope: ref('scope'), requested_at: instant, observed_at: instant,
    provider_generated_at: nullable(instant), provider_version: id, raw_payload_hash: hash, source_document_ref: id,
    report: object({ requested_name: id, returned_name: id, reporting_type: enumeration('period', 'as_of'),
      no_report_data: bool, header_path: path, columns_path: path, rows_path: path }),
    coverage: ref('coverage'), columns: array(ref('column'), 100, 1), rows: array(ref('row')),
    totals: array(object({ row_path: path, column_key: id }), 1000),
    lineage: object({ kind: enumeration('source_record', 'derived_record'), root_ids: array(id, 16, 1), source_families: array(id, 16, 1) }),
    supersedes: nullable(ref('snapshot_ref')), content_hash: hash }),
  evidence: object({ state: enumeration('present', 'absent', 'unavailable'), value: nullable(ref('money')),
    citations: array(ref('citation'), 16), search_receipt: nullable(object({ citation: ref('citation'),
      scope: ref('scope'), coverage: ref('coverage'), match_count: integer(), predicate_hash: hash })), reason: id }),
  finding: object({ schema_version: version('books-finding-1'), contract: version('B1'), finding_id: id,
    run_ref: id, generation: integer(1), rule_id: enumeration(...Array.from({ length: 14 }, (_, i) => `B${String(i + 1).padStart(2, '0')}`)),
    rule_version: id, policy_version: id, scope: ref('scope'), observed_at: instant,
    status: enumeration('incomplete', 'clear', 'finding'),
    outcome: enumeration('pass', 'candidate', 'incomplete', 'not_applicable', 'not_comparable'),
    severity: enumeration('blocker', 'major', 'minor', 'none'), left: ref('evidence'), right: ref('evidence'),
    difference: nullable(ref('money')), candidate_sets: array(array(ref('citation'), 16, 1), 100),
    reason: id, question: str(1000), wording: version('Possible issue'),
    resolution: enumeration('open', 'reviewed_no_change', 'evidence_requested', 'superseded_by_new_evidence'),
    financial_authority: version(false), content_hash: hash }),
  tax_line: object({ filing_unit_ref: id, entity_ref: id, filer_role: enumeration('filer', 'recipient', 'issuer'),
    tax_year: integer(1900), jurisdiction: id, form: id, form_revision: id,
    period: object({ start: date, end: date }), basis: enumeration('cash', 'accrual'),
    return_state: enumeration('original', 'amended', 'superseded'), document_hash: hash,
    extraction: enumeration('reliable_mapped_native', 'owner_confirmed', 'candidate', 'unreadable'),
    review_receipt_ref: nullable(id), page: integer(1), box: nullable(id), line: id,
    measure: id, value: ref('money'), citation: ref('citation'),
    rounding: enumeration('exact', 'whole_dollar_half_away_from_zero', 'unknown') }),
  tax: object({ schema_version: version('books-tax-1'), contract: version('T1'), scope: ref('scope'),
    observed_at: instant, tax_year: integer(1900), filing_unit_ref: id, jurisdiction: id, books_run_ref: id,
    report_snapshot_refs: array(ref('snapshot_ref'), 16, 1), coverage: ref('coverage'),
    metrics: array(object({ measure: id, value: ref('money'), citation: ref('citation') }), 100, 1),
    bridge_adjustments: array(object({ measure: id, value: ref('money'), citation: ref('citation'), mapping_ref: id }), 100),
    open_finding_refs: array(id, 1000), mapping_version: id, confirmation: nullable(object({ receipt_ref: id, binding_hash: hash })),
    tax_line: nullable(ref('tax_line')), comparison: enumeration('not_checked', 'agree', 'candidate', 'consistent_with_reported_precision'),
    difference: nullable(ref('money')), wording: version('Possible miss, review with your preparer'),
    review_only: version(true), financial_authority: version(false) }),
  claim: object({ claim_id: id, measure: id, operation: enumeration('source_cell', 'sum', 'difference'),
    operands: array(ref('citation'), 16, 1), value: ref('money'), role,
    qualification: enumeration('complete_report_scope', 'partial_individual_fact'),
    additive_set_ref: nullable(ref('citation')) }),
  answer: object({ schema_version: version('financial-answer-1'), scope: ref('scope'), observed_at: instant,
    intent: enumeration('source_report', 'bounded_calculation'), claims: array(ref('claim'), 100, 1),
    financial_authority: version(false), rendering: version('fixed_claims_only') }),
};

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export const FINANCIAL_CONTRACT_SCHEMA = freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:brain:financial-contract:1', $defs: defs,
});
