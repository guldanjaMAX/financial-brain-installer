import { financialPictureInventory } from './financial-picture.js';
import { readOwnerFinancialMapState } from './owner-financial-map.js';
import { TAX_CHECK_CATALOG, uncheckedTaxResult } from './tax-check-rules.js';

export const TAX_INVENTORY_SECTIONS = Object.freeze(['books', 'payroll', 'tax_returns', 'filing_payments', 'evidence', 'periods', 'conflicts']);
export const TAX_PAGE_LIMIT = 100;
export const TAX_MAX_PAGES_PER_SECTION = 2;
const LABELS = Object.freeze({ books: 'Books', payroll: 'Payroll', tax_returns: 'Tax returns', filing_payments: 'Filing and payment evidence', evidence: 'Supporting evidence', periods: 'Periods', conflicts: 'Conflicts' });
const LIMIT_NOTICE = 'Tax amounts and filing readiness are not checked.';
const gap = (type, detail) => ({ type, detail });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function taxChecks() {
  return TAX_CHECK_CATALOG.map(rule => ({ label: rule.label, implemented: rule.implemented,
    ...uncheckedTaxResult(rule.rule_id, rule.implemented ? 'official_map_and_authenticated_field_review_required' : 'rule_not_implemented'),
  }));
}

function identityGaps(map, year) {
  const gaps = [];
  const matches = map.active_map.entities.filter(entity => entity.ledger_evidence?.state === 'linked_current_record' && entity.ledger_evidence.current_ref === map.selected_entity_ref);
  if (!map.selected_entity_ref || matches.length !== 1 || matches[0].disposition !== 'included') {
    return [gap('tax_entity_unassigned', 'Assign the selected ledger entity in the owner Financial Map. No other entity was substituted.')];
  }
  const years = matches[0].tax_years.filter(item => item.tax_year === year && item.state === 'included');
  if (years.length !== 1) return [gap('tax_year_unassigned', 'Review the requested year for this entity in Financial Map. No nearby year was substituted.')];
  const row = years[0];
  if (row.filing_units.assessment !== 'confirmed' || row.filing_units.refs.length === 0) {
    gaps.push(gap('tax_filing_unit_unassigned', 'Confirm the filing unit for this entity and year in Financial Map.'));
  } else if (row.filing_units.refs.length !== 1) {
    gaps.push(gap('tax_filing_unit_ambiguous', 'Resolve the multiple filing units for this entity and year before preparer review.'));
  } else if (!map.active_map.filing_units.some(unit => unit.map_id === row.filing_units.refs[0] && unit.assessment === 'confirmed')) {
    gaps.push(gap('tax_filing_unit_unassigned', 'Confirm the referenced filing unit in Financial Map.'));
  }
  if (map.population_state !== 'owner_asserted_complete') gaps.push(gap('tax_population_unknown', 'Review the expected entity and source population in Financial Map.'));
  if (row.expected_sources.assessment !== 'confirmed') gaps.push(gap('tax_expected_sources_unknown', 'Review the expected sources for this entity and year in Financial Map.'));
  return gaps;
}

function fixedGaps() {
  // These schema limitations cannot be resolved by parsing a map label, a
  // question, or a fixture form map. Each requires its own reviewed surface.
  return [
    gap('tax_form_unknown', 'Confirm exact forms and revisions for this year with your preparer; inventory cannot identify tax forms.'),
    gap('tax_role_unknown', 'Confirm each K-1 issuer or recipient role with your preparer; inventory cannot establish that role.'),
    gap('tax_jurisdiction_unsupported', 'Confirm the filing jurisdiction with your preparer. This workflow has no supported jurisdiction mapping.'),
    gap('tax_official_map_missing', 'A reviewed official form map for the exact year and jurisdiction is required before any tax comparison.'),
    gap('tax_field_review_missing', 'Review original fields through an authenticated confirmation workflow before comparing them. This checklist does not confirm fields.'),
    gap('tax_inventory_limits', 'Stored inventory cannot establish that all required documents exist. Payroll and rejected or unextracted documents are not fully inventoried.'),
    gap('tax_freshness_unchecked', 'Review source freshness and period applicability; stored timestamps do not establish current or complete evidence.'),
    gap('tax_conflict_period_scope', 'Conflicts are checked for the selected entity across all periods because the conflict registry has no tax-year filter. Period inventory covers only rows assigned to the requested tax year.'),
  ];
}

function scopedSection(result, section, filters) {
  const value = result?.body?.sections?.[section];
  if (result?.status !== 200 || !value) return null;
  if (!same(value.applied_filters, filters) || value.not_applicable_filters?.length) throw new Error('scope mismatch');
  return value;
}

function summarize(section, records, unavailable, unfinished) {
  const unreadable = records.filter(row => row.custody?.readable === false ||
    row.verification?.extraction?.text_reliable === false ||
    ['unreadable', 'ocr_partial', 'unavailable'].includes(row.verification?.extraction?.state)).length;
  const inaccessible = records.filter(row => row.custody?.restricted === true ||
    ['can_get_it', 'do_not_have_it'].includes(row.custody?.availability) ||
    (row.source_lineage?.source_feed_present && row.source_lineage?.source_feed_registry_state !== 'resolved') ||
    ['revoked', 'disconnected', 'error', 'paused'].includes(row.verification?.freshness?.source_status)).length;
  const state = unavailable ? 'unavailable' : records.length === 0 ? (unfinished ? 'partial' : 'measured_empty') :
    inaccessible === records.length ? 'unavailable' : unreadable === records.length ? 'unreadable' : 'present';
  return { section, state, observed_records: unavailable ? null : records.length, unreadable_records: unavailable ? null : unreadable,
    unavailable_records: unavailable ? null : inaccessible, traversal: unfinished ? 'partial' : unavailable ? 'unavailable' : 'finished',
    scope: section === 'conflicts' ? 'selected_entity_all_periods' : 'selected_entity_tax_year', real_world_completeness: 'not_proven' };
}

// Every map/inventory outcome crosses this final owner check, including early
// gaps and failed reads. Refusal metadata must not reveal which private branch
// ran or how many pages were read after access was revoked or became unknown.
export async function taxReadiness(context, dependencies = {}) {
  const result = await readTaxEvidence(context, dependencies);
  try {
    if (await context.reauthorize?.() === true) return result;
  } catch { /* Unknown current access withholds the same private state. */ }
  const detail = 'Owner access could not be confirmed at the end of the check. Sign in again before reading this checklist.';
  const checks = taxChecks();
  return { status: 'unavailable', answer: `${detail} ${LIMIT_NOTICE}`, gaps: [gap('cfo_owner_required', detail)],
    metadata: { tax_year: context.intent.taxYear, tax_checks: checks, compared_families: 0,
      total_families: checks.length, checklist: [], stages: ['recheck'] } };
}

/** Read-only metadata checklist. At most 14 initial and 14 validation reads.
 * Offset cursors are live views, not snapshot continuation: replay every page
 * and recheck the sealed map and owner before exposing observed presence.
 * Even a stable replay proves neither a shared snapshot nor real-world absence.
 */
async function readTaxEvidence({ intent, entityScope, asOf }, {
  env, readMap = (options) => readOwnerFinancialMapState(env, options),
  inventory = body => financialPictureInventory(env, body, { capturedAt: asOf }),
} = {}) {
  const year = intent.taxYear;
  const entity = entityScope.entity_slug;
  const checks = taxChecks();
  const stages = ['map'];
  const metadata = { tax_year: year, tax_checks: checks, compared_families: 0, total_families: checks.length, checklist: [], stages };
  const refusal = (code, detail) => ({ status: 'unavailable', answer: `${detail} ${LIMIT_NOTICE}`, gaps: [gap(code, detail)], metadata });
  let map;
  try { map = await readMap({ entitySlug: entity }); } catch { return refusal('tax_map_unavailable', 'Financial Map could not be read. Retry before assessing the evidence population.'); }
  if (!map) return refusal('tax_map_unavailable', 'Financial Map is unavailable on this backend. Review the supported map setup before assessing evidence.');
  if (map.map_status === 'not_established') return refusal('tax_map_missing', 'Open Financial Map in the owner app and establish the entity and year population.');
  if (map.map_status === 'stale') return refusal('tax_map_stale', 'Review and save the changed entity or account inventory in Financial Map.');
  if (map.map_status !== 'current' || map.authoritative !== true || !map.active_map) return refusal('tax_map_unavailable', 'The current Financial Map could not be verified.');
  stages.push('identity');
  const gaps = identityGaps(map, year);
  if (gaps.some(item => ['tax_entity_unassigned', 'tax_year_unassigned'].includes(item.type))) {
    return { status: 'clarification', answer: `${gaps[0].detail} ${LIMIT_NOTICE}`, gaps, metadata };
  }
  gaps.push(...fixedGaps());
  stages.push('inventory');
  const reads = [];
  const checklist = [];
  let pages = 0;
  for (const section of TAX_INVENTORY_SECTIONS) {
    const filters = { entity_slug: entity, ...(section === 'conflicts' ? {} : { tax_year: year }), period_start: null, period_end: null };
    const records = [];
    const cursors = new Set();
    let cursor = null, total = null, unavailable = false, unfinished = false;
    for (let page = 0; page < TAX_MAX_PAGES_PER_SECTION; page++) {
      const request = { sections: [section], filters, limit: TAX_PAGE_LIMIT, ...(cursor ? { cursor } : {}) };
      let result, value;
      pages++;
      try { result = await inventory(request); value = scopedSection(result, section, filters); }
      catch { unavailable = true; break; }
      if (!value) { unavailable = true; break; }
      reads.push({ request, section, value });
      if (value.unavailable) { unavailable = true; break; }
      if (!Array.isArray(value.records) || !Number.isSafeInteger(value.total) || value.total < 0 ||
          value.returned !== value.records.length || value.records.length > TAX_PAGE_LIMIT ||
          (total !== null && value.total !== total) || value.cursor !== cursor ||
          value.records.some(row => section !== 'conflicts' && row.tax_year != null && row.tax_year !== year)) {
        unavailable = true; break;
      }
      total = value.total;
      records.push(...value.records);
      unfinished = value.truncated === true;
      if (unfinished !== Boolean(value.next_cursor) || (!unfinished && records.length !== total)) {
        unavailable = true; break;
      }
      if (!unfinished) break;
      if (value.records.length === 0 || cursors.has(value.next_cursor)) { unavailable = true; break; }
      cursor = value.next_cursor; cursors.add(cursor);
    }
    const item = summarize(section, records, unavailable, unfinished);
    checklist.push(item);
    if (unavailable) gaps.push(gap(`tax_${section}_unavailable`, `${LABELS[section]} inventory is unavailable. Retry or review its supported source; no zero count was inferred.`));
    else if (item.state === 'measured_empty') gaps.push(gap(`tax_${section}_empty`, `No matching ${LABELS[section].toLowerCase()} rows were measured in the stored scope. Check the expected originals; this does not prove absence.`));
    if (unfinished) gaps.push(gap(`tax_${section}_partial`, `${LABELS[section]} has an unfinished page sequence. Review the remaining inventory before assessing its population.`));
    if (item.unreadable_records) gaps.push(gap(`tax_${section}_unreadable`, `Review readable originals for ${LABELS[section].toLowerCase()}; stored evidence includes unreadable or unverified extraction.`));
    if (item.unavailable_records) gaps.push(gap(`tax_${section}_restricted`, `Review custody, source access and restrictions for ${LABELS[section].toLowerCase()} before using that evidence.`));
  }
  metadata.pages_read = pages;
  stages.push('recheck');
  try {
    for (const read of reads) {
      const current = scopedSection(await inventory(read.request), read.section, read.request.filters);
      if (!same(current, read.value)) return refusal('tax_evidence_changed', 'Evidence or source access changed during the check. Run the checklist again; affected evidence is withheld.');
    }
    if (!same(map, await readMap({ entitySlug: entity }))) return refusal('tax_map_changed', 'Financial Map changed during the check. Review the current map and run the checklist again.');
  } catch { return refusal('tax_recheck_unavailable', 'Current evidence could not be rechecked. Retry; observed evidence is withheld.'); }
  metadata.checklist = checklist;
  gaps.push(gap('tax_original_citations_unresolved', 'Inventory references are opaque metadata, not original-document links. Open and review the authorized originals separately; no document citation was resolved here.'));
  const allRead = checklist.every(item => item.traversal === 'finished');
  const heading = allRead ? 'Evidence inventory checked.' : 'Evidence inventory partially checked; some reads or pages remain unavailable.';
  const lines = checklist.map(item => `${LABELS[item.section]}: ${item.state === 'measured_empty' ? 'measured empty in stored scope' : item.state}${item.traversal === 'partial' ? ' (unfinished pages)' : ''}.`);
  return { status: 'partial', metadata, gaps,
    answer: [`Tax evidence checklist for ${entity}, ${year}. As of ${asOf}.`, heading, ...lines,
      `Tax families: ${checks.length} not checked; none compared.`,
      ...checks.map(rule => `${rule.rule_id} ${rule.label}: not checked (${rule.implemented ? 'official map and field review required' : 'not implemented'}).`),
      'Next steps:', ...gaps.map(item => item.detail), LIMIT_NOTICE].join('\n') };
}
