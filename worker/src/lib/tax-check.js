import { assertFinancialContract, canonicalFinancialJson, financialHash, resolveFinancialCell, validateFinancialContract, verifyFinancialSnapshot } from './financial-snapshot-contract.js';
import { TAX_CHECK_CATALOG, evaluateTaxRule, uncheckedTaxResult } from './tax-check-rules.js';

const equal = (a, b) => canonicalFinancialJson(a) === canonicalFinancialJson(b);
export const taxCheckHash = value => financialHash(canonicalFinancialJson(value));
export const taxCheckBinding = ({ rule_id, transfer }) => taxCheckHash({ rule_id,
  transfer: { ...transfer, confirmation: null, comparison: 'not_checked', difference: null } });
// Identifiers are unnecessary in every projection this lane creates. Reject
// suspicious reference metadata rather than change an opaque citation's bytes.
// Monetary strings and cryptographic hashes keep their exact typed meaning.
export function containsTaxIdentifier(value, key = '') {
  if (typeof value === 'string') {
    if (['decimal', 'amount_minor'].includes(key) || /^[a-f0-9]{40,64}$/.test(value) ||
        /^[a-z_.:-]+[a-f0-9]{40,64}$/.test(value)) return false;
    return /\d{3}[- ]\d{2}[- ]\d{4}|\d{9,}/.test(value);
  }
  if (Array.isArray(value)) return value.some(item => containsTaxIdentifier(item, key));
  return !!value && typeof value === 'object' && Object.entries(value).some(([name, item]) => containsTaxIdentifier(item, name));
}
const validTime = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
function authenticated(receipt, now) {
  return receipt?.authenticated === true && typeof receipt.principal_ref === 'string' && receipt.principal_ref.length > 0 &&
    validTime(receipt.confirmed_at) && Date.parse(receipt.confirmed_at) <= Date.parse(now);
}
function sameScope(a, b) {
  // Source report names may differ. All other scope dimensions must agree;
  // this includes filters, company, owner map, timezone and exact period.
  const { report_parameters: ignoredA, ...left } = a;
  const { report_parameters: ignoredB, ...right } = b;
  return equal(left, right);
}
function safeCitation(citation) {
  // Identifier fields never belong in a tax check projection. Hashes stay
  // untouched; masking a binding hash would invalidate evidence identity.
  return ['snapshot_id', 'source_id', 'source_doc_ref', 'row_path', 'column_key', 'native_entity_id', 'native_entity_version', 'native_line_id']
    .every(key => citation[key] === null || (typeof citation[key] === 'string' &&
      !containsTaxIdentifier(citation[key]) && !/[\r\n]/.test(citation[key])));
}

// Batch review UI issues the receipt only after the authenticated owner has
// reviewed the exact document/locator/value. This adapter consumes that receipt;
// it does not create consent, accept a boolean, or promote original OCR text.
export async function confirmTaxLine(input, { now, readReview, readDocument } = {}) {
  const trace = ['candidate'];
  const refuse = reason => ({ ok: false, reason, line: null, trace });
  try {
    const { tenant, extraction, candidate_index: index, line_context: context } = structuredClone(input);
    const candidate = extraction?.fields?.[index];
    if (typeof tenant !== 'string' || tenant.length === 0 || tenant.length > 256 ||
        !validTime(now) || typeof readReview !== 'function' || typeof readDocument !== 'function' ||
        extraction?.schema_version !== 'tax-pdf-candidates-1' || !Number.isSafeInteger(index) || index < 0 ||
        candidate?.state !== 'candidate' || candidate.authoritative !== false ||
        !/^[a-f0-9]{64}$/.test(extraction.document_hash) || !/^[a-f0-9]{64}$/.test(extraction.mapping_hash) ||
        candidate.candidate_hash !== await taxCheckHash({ document_hash: extraction.document_hash,
          mapping_hash: extraction.mapping_hash, text_source: extraction.text_source, candidate: { ...candidate, candidate_hash: null } })) return refuse('candidate_invalid');
    const line = { ...context, document_hash: extraction.document_hash, extraction: 'owner_confirmed',
      value: candidate.value, rounding: candidate.rounding };
    assertFinancialContract('tax_line', line);
    if (['form', 'form_revision', 'tax_year', 'jurisdiction', 'page', 'line', 'box'].some(key => line[key] !== candidate[key]) ||
        !safeCitation(line.citation)) return refuse('candidate_scope');
    trace.push('confirmation');
    const receipt = await readReview({ tenant, receipt_ref: line.review_receipt_ref, line });
    if (receipt?.schema_version !== 'tax-field-review-1' || !authenticated(receipt, now) ||
        receipt.receipt_ref !== line.review_receipt_ref || receipt.confirmation !== 'owner_confirmed_from_document' ||
        receipt.candidate_hash !== candidate.candidate_hash || receipt.line_hash !== await taxCheckHash(line)) return refuse('field_confirmation_invalid');
    trace.push('document');
    const document = await readDocument({ tenant, entity_ref: line.entity_ref, source_id: line.citation.source_id,
      source_doc_ref: line.citation.source_doc_ref, document_hash: line.document_hash });
    if (document?.available !== true || document.current !== true || document.document_hash !== line.document_hash ||
        document.text_source !== extraction.text_source) return refuse('document_unavailable');
    return { ok: true, line, trace, provenance: 'owner_stated', text_source: document.text_source,
      text_reliable: document.text_reliable === true };
  } catch { return refuse('confirmation_unavailable'); }
}

// One owner approval may issue several exact field receipts. Processing a
// batch does not imply every field was reviewed: partial confirmation persists
// as a count and a per-field refusal, never a blanket approval.
export async function confirmTaxLines(inputs, dependencies) {
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 200) return {
    status: 'not_checked', reason: 'batch_invalid', confirmed: 0, not_confirmed: 0, results: [] };
  const requests = structuredClone(inputs), first = requests[0];
  const scopeKeys = ['filing_unit_ref', 'entity_ref', 'tax_year', 'jurisdiction', 'basis'];
  if (requests.some(request => request?.tenant !== first?.tenant || scopeKeys.some(key =>
    request?.line_context?.[key] !== first?.line_context?.[key]) ||
    !equal(request?.line_context?.period ?? null, first?.line_context?.period ?? null))) return {
    status: 'not_checked', reason: 'batch_scope', confirmed: 0, not_confirmed: requests.length, results: [] };
  const results = [];
  for (const request of requests) results.push(await confirmTaxLine(request, dependencies));
  const confirmed = results.filter(result => result.ok).length;
  return { status: confirmed === results.length ? 'confirmed' : confirmed ? 'partial' : 'not_checked',
    confirmed, not_confirmed: results.length - confirmed, results };
}

// Internal server coordinator. No request may supply these dependencies.
// readCitation must be the authorized CURRENT financial evidence store read;
// readDocument checks original custody/grants and operative return version.
// readReview/readMapping return server-held records, never echoed request JSON.
export async function evaluateTaxCheck(input, dependencies = {}) {
  const trace = ['catalog'];
  let ruleId = input?.rule_id;
  const refuse = reason => uncheckedTaxResult(ruleId, reason, trace);
  if (!TAX_CHECK_CATALOG.some(item => item.rule_id === ruleId && item.implemented)) return refuse('rule_not_implemented');
  const { now, readCitation, readReview, readMapping, readDocument, readMapHead } = dependencies;
  let transfer;
  try { transfer = structuredClone(input.transfer); } catch { return refuse('invalid_transfer'); }
  trace.push('contract');
  if (!validateFinancialContract('tax', transfer).ok) return refuse('invalid_transfer');
  trace.push('privacy');
  if (containsTaxIdentifier(transfer)) return refuse('private_identifier_refused');
  if (!validTime(now) || [readCitation, readReview, readMapping, readDocument, readMapHead].some(value => typeof value !== 'function')) return refuse('trusted_dependencies_unavailable');
  const tenant = transfer.scope.tenant;
  try {
    trace.push('scope');
    if (transfer.scope.entity_ref === null || transfer.scope.owner_map_head === null ||
        transfer.scope.presentation_currency !== 'USD' || transfer.jurisdiction !== 'US_federal' ||
        transfer.scope.period_start.slice(0, 4) !== String(transfer.tax_year) ||
        transfer.scope.period_end.slice(0, 4) !== String(transfer.tax_year) ||
        await readMapHead({ tenant }) !== transfer.scope.owner_map_head) return refuse('unsupported_or_stale_scope');
    trace.push('confirmation');
    if (!transfer.confirmation) return refuse('review_required');
    const review = structuredClone(await readReview({ tenant, receipt_ref: transfer.confirmation.receipt_ref }));
    const binding = await taxCheckBinding({ rule_id: ruleId, transfer });
    if (review?.schema_version !== 'tax-check-review-1' || !authenticated(review, now) ||
        review.receipt_ref !== transfer.confirmation.receipt_ref || review.binding_hash !== binding ||
        transfer.confirmation.binding_hash !== binding) return refuse('review_binding_invalid');
    trace.push('mapping');
    const mapping = structuredClone(await readMapping({ tenant, version: transfer.mapping_version }));
    if (mapping?.schema_version !== 'tax-check-map-1' || mapping.reviewed !== true ||
        mapping.version !== transfer.mapping_version || !Array.isArray(mapping.rules) ||
        new Set(mapping.rules.map(item => item.rule_id)).size !== mapping.rules.length ||
        mapping.content_hash !== await taxCheckHash({ ...mapping, content_hash: null }) ||
        mapping.content_hash !== review.mapping_hash) return refuse('mapping_unreviewed');
    trace.push('coverage');
    if (transfer.coverage.state !== 'complete_for_report_scope' || review.source_inventory !== 'complete_for_rule' ||
        review.return_inventory !== 'complete_for_rule' || !review.inventory_revision || review.corrections_reviewed !== true ||
        review.allocations_reviewed !== true || review.adjustments_reviewed !== true || transfer.open_finding_refs.length) return refuse('rule_coverage_incomplete');
    const target = transfer.tax_line ?? review.reviewed_absence;
    if (!target) return refuse('target_unavailable');
    trace.push('citations');
    const citations = [...transfer.metrics, ...transfer.bridge_adjustments, target].map(item => item.citation);
    const seen = new Set(), roots = new Set(), sourceRoots = new Set();
    const snapshots = [];
    for (const [index, citation] of citations.entries()) {
      assertFinancialContract('citation', citation);
      if (!safeCitation(citation)) return refuse('private_identifier_refused');
      const key = canonicalFinancialJson(citation);
      if (seen.has(key)) return refuse('duplicate_evidence');
      seen.add(key);
      const read = await readCitation({ tenant, citation, current: true });
      const snapshot = structuredClone(read?.snapshot);
      await verifyFinancialSnapshot(snapshot);
      const { cell } = resolveFinancialCell(snapshot, citation);
      if (!sameScope(snapshot.scope, transfer.scope) || snapshot.coverage.state !== 'complete_for_report_scope') return refuse('citation_scope_or_coverage');
      if (snapshot.observed_at !== transfer.observed_at && index < citations.length - 1) return refuse('mixed_observations');
      if (cell.state !== 'value' || cell.kind !== 'money' || cell.role !== 'measure') return refuse('citation_value_unavailable');
      const item = [...transfer.metrics, ...transfer.bridge_adjustments, target][index];
      if (item.value && !equal(cell.money, item.value)) return refuse('citation_value_mismatch');
      if (!item.value && (!snapshot.report.no_report_data || cell.money?.amount_minor !== '0')) return refuse('absence_unproved');
      if (index === 0 && !equal(snapshot.coverage, transfer.coverage)) return refuse('coverage_binding_invalid');
      for (const root of snapshot.lineage.root_ids) {
        if (containsTaxIdentifier(root)) return refuse('private_identifier_refused');
        if (index === citations.length - 1 && sourceRoots.has(root)) return refuse('overlapping_return_evidence');
        roots.add(root);
        if (index < citations.length - 1) sourceRoots.add(root);
      }
      snapshots.push(snapshot);
    }
    trace.push('lineage');
    if (roots.size > 16) return refuse('lineage_capacity_exceeded');
    const sourceSnapshots = snapshots.slice(0, -1);
    const firstSource = sourceSnapshots[0];
    if (sourceSnapshots.length > 1 && sourceSnapshots.some(snapshot =>
      snapshot.coverage.mutation_check.state !== 'stable' || snapshot.generation !== firstSource.generation ||
      !equal(snapshot.coverage.mutation_check, firstSource.coverage.mutation_check))) return refuse('cross_report_fence_unproved');
    for (let i = 0; i < sourceSnapshots.length; i++) for (let j = i + 1; j < sourceSnapshots.length; j++) {
      if (sourceSnapshots[i].snapshot_id !== sourceSnapshots[j].snapshot_id &&
          sourceSnapshots[i].lineage.root_ids.some(root => sourceSnapshots[j].lineage.root_ids.includes(root))) return refuse('overlapping_adjustments');
    }
    // Bridge entries must be individually reviewed, same-observation cells.
    // Reusing a report's total and child as separate operands is not allowed.
    const sourceCoordinates = citations.slice(0, -1);
    for (let i = 0; i < sourceCoordinates.length; i++) for (let j = i + 1; j < sourceCoordinates.length; j++) {
      if (sourceCoordinates[i].snapshot_id === sourceCoordinates[j].snapshot_id &&
          (sourceCoordinates[i].row_path === sourceCoordinates[j].row_path ||
           snapshots[i].rows.find(row => row.row_path === sourceCoordinates[i].row_path)?.kind !== 'detail' ||
           snapshots[j].rows.find(row => row.row_path === sourceCoordinates[j].row_path)?.kind !== 'detail')) return refuse('overlapping_adjustments');
    }
    if (transfer.bridge_adjustments.some(item => item.mapping_ref !== mapping.version)) return refuse('adjustment_mapping_unreviewed');
    trace.push('extraction');
    if (target.filing_unit_ref !== transfer.filing_unit_ref || target.entity_ref !== transfer.scope.entity_ref ||
        target.filer_role !== 'filer' || target.tax_year !== transfer.tax_year || target.jurisdiction !== transfer.jurisdiction ||
        target.basis !== transfer.scope.basis || target.period?.start !== transfer.scope.period_start ||
        target.period?.end !== transfer.scope.period_end || !['original', 'amended'].includes(target.return_state) ||
        target.document_hash !== review.operative_return_hash || !Number.isSafeInteger(target.page) || target.page < 1) return refuse('tax_scope_or_version');
    const document = await readDocument({ tenant, entity_ref: target.entity_ref, source_id: target.citation.source_id,
      source_doc_ref: target.citation.source_doc_ref, document_hash: target.document_hash });
    if (document?.available !== true || document.current !== true || document.document_hash !== target.document_hash) return refuse('document_unavailable');
    if (transfer.tax_line) {
      const lineReview = await readReview({ tenant, receipt_ref: target.review_receipt_ref });
      if (lineReview?.schema_version !== 'tax-field-review-1' || !authenticated(lineReview, now) ||
          lineReview.receipt_ref !== target.review_receipt_ref || lineReview.line_hash !== await taxCheckHash(target)) return refuse('field_confirmation_invalid');
      if (target.extraction === 'owner_confirmed') {
        if (lineReview.confirmation !== 'owner_confirmed_from_document') return refuse('field_confirmation_invalid');
      } else if (target.extraction !== 'reliable_mapped_native' || lineReview.confirmation !== 'reliable_mapped_native' ||
          document.text_source !== 'native' || document.text_reliable !== true) return refuse('field_authority_unavailable');
    }
    const result = evaluateTaxRule(ruleId, transfer, { review, mapping });
    result.trace = [...trace, ...result.trace];
    if (result.status !== 'not_checked') {
      result.evidence_hash = await taxCheckHash({ binding, review, mapping });
      result.root_ids = [...roots].sort();
    }
    return result;
  } catch {
    // Never serialize provider errors, PDF text, source labels or receipt bytes.
    return refuse('evidence_unavailable');
  }
}
