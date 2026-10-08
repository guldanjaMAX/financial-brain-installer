import { financialError } from './financial-money.js';
import { canonicalFinancialJson, validateFinancialContract } from './financial-snapshot-contract.js';
import { containsTaxIdentifier, evaluateTaxCheck, taxCheckHash } from './tax-check.js';
import { TAX_CHECK_CATALOG, TAX_CHECK_WORDING, TAX_CHECK_VERSION, uncheckedTaxResult } from './tax-check-rules.js';

const same = (a, b) => canonicalFinancialJson(a) === canonicalFinancialJson(b);
const moneyText = value => `${value.currency} ${value.decimal}`;
const outcomeText = Object.freeze({ possible_miss: 'Possible miss', discrepancy: 'Compared amounts differ',
  review_question: 'Treatment review question', no_signal: 'No signal in this comparison', not_checked: 'Not checked' });

// Render only fixed words and typed values. Numbered citations are the private
// drilldown index, never raw filenames, identifiers, account numbers or URLs.
function render(results, year, observedAt) {
  const citations = [], roots = new Set();
  const cite = citation => {
    let index = citations.findIndex(item => same(item, citation));
    if (index < 0) { index = citations.length; citations.push(citation); }
    return `[${index + 1}]`;
  };
  const counts = { checked: 0, not_checked: 0, possible_miss: 0, discrepancy: 0, review_question: 0, no_signal: 0 };
  const lines = [`# Tax check ${year}`, '', TAX_CHECK_WORDING, '', `Input as of ${observedAt}.`,
    'This is a review record, not tax or legal advice. No eligibility, deduction, tax savings or return correctness is determined.',
    'A clear comparison covers only its reviewed evidence. Unprovided documents and unsupported checks remain unknown.', '',
    'Bring possible misses and unresolved evidence to your preparer or bookkeeper.', ''];
  for (const result of results) {
    const rule = TAX_CHECK_CATALOG.find(item => item.rule_id === result.rule_id);
    if (result.status === 'not_checked') counts.not_checked++;
    else { counts.checked++; counts[result.status]++; }
    lines.push(`## ${rule.rule_id}: ${rule.label}`, '', TAX_CHECK_WORDING, '', outcomeText[result.status]);
    if (result.status === 'not_checked') {
      lines.push('The evidence, reviewed mapping or supported rule is unavailable. Complete the named review before comparing.', `Gap code: ${result.reason}.`, '');
      continue;
    }
    result.root_ids.forEach(root => roots.add(root));
    const sourceCitations = result.citations.slice(0, -1).map(cite).join(' ');
    const targetCitation = cite(result.citations.at(-1));
    if (result.transfer.tax_line) {
      const locator = result.transfer.tax_line;
      lines.push(`Return scope: ${locator.form}, line ${locator.line}, ${locator.return_state} version ${targetCitation}.`);
    }
    lines.push(`Rule version: ${TAX_CHECK_VERSION}. Reviewed input and mapping digest: ${result.evidence_hash}.`);
    lines.push(`Reviewed source amount: ${moneyText(result.source_value)} ${sourceCitations}.`);
    if (result.return_value) lines.push(`Reviewed return value: ${moneyText(result.return_value)} ${targetCitation}.`);
    else lines.push(`No linked treatment in the reviewed coverage ${targetCitation}. This is not a zero-valued tax line.`);
    if (result.difference) lines.push(`Source less return: ${moneyText(result.difference)} ${sourceCitations} ${targetCitation}.`);
    if (result.comparison === 'consistent_with_reported_precision') lines.push('The values agree under the reviewed whole-dollar rounding rule.');
    if (result.value_basis === 'includes_owner_stated_value') lines.push('Includes a value confirmed by the owner from the document. Original OCR reliability is unchanged.');
    if (result.status === 'review_question') lines.push('Ask how this item was treated. Its cost or contribution does not establish a deductible amount.');
    else lines.push('Ask your preparer to reconcile the cited claims and documented adjustments. Neither source is selected as correct.');
    lines.push('');
  }
  // One stored index still has the union of actual roots. It cannot conceal
  // high-cardinality evidence by inventing an independent umbrella source.
  if (roots.size > 16) throw financialError('tax_check_lineage_capacity');
  lines.splice(9, 0, `Checked: ${counts.checked}. Not checked: ${counts.not_checked}.`, '');
  return { document: { title: `Tax check ${year}`, text: lines.join('\n'), source_kind: 'derived_record',
    independent_evidence: false, root_ids: [...roots].sort(), financial_authority: false }, citations, counts };
}

// Reuse the reserved append-only financial_run_events table. A run is one
// immutable row containing its typed results and readable document, so a
// partial write cannot publish a document without its receipt. This adds no
// table, migration, corpus ingest, vector, source write or owner-app route.
// authorizeRun is the authenticated owner/entity grant adapter.
export function createTaxCheckStore(dependencies = {}) {
  const { db, authorizeRun } = dependencies;
  if (!db?.prepare || typeof authorizeRun !== 'function') throw financialError('tax_check_dependencies');
  const statement = (sql, ...values) => db.prepare(sql).bind(...values);
  async function allow(request, action) {
    if (await authorizeRun({ tenant: request.scope.tenant, entity_ref: request.scope.entity_ref,
      filing_unit_ref: request.filing_unit_ref, action }) !== true) throw financialError('tax_check_access');
  }
  function validate(request) {
    if (!request || containsTaxIdentifier({ ...request, implementation_sha: null }) ||
        Object.keys(request).sort().join(',') !== 'entries,filing_unit_ref,implementation_sha,jurisdiction,observed_at,scope,tax_year' ||
        !validateFinancialContract('scope', request.scope).ok || !Number.isSafeInteger(request.tax_year) ||
        request.tax_year < 1900 || request.tax_year > 9999 || request.jurisdiction !== 'US_federal' ||
        typeof request.filing_unit_ref !== 'string' || request.filing_unit_ref.length === 0 || request.filing_unit_ref.length > 256 ||
        typeof request.implementation_sha !== 'string' || !/^[a-f0-9]{40}$/.test(request.implementation_sha) ||
        typeof request.observed_at !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(request.observed_at) ||
        !Number.isFinite(Date.parse(request.observed_at)) || Date.parse(request.observed_at) > Date.parse(dependencies.now) ||
        !Array.isArray(request.entries) || !request.entries.length || request.entries.length > 32 ||
        new Set(request.entries.map(item => item.rule_id)).size !== request.entries.length) throw financialError('tax_check_request');
    for (const item of request.entries) {
      if (Object.keys(item).sort().join(',') !== 'rule_id,transfer' ||
          !TAX_CHECK_CATALOG.some(rule => rule.rule_id === item.rule_id) || !validateFinancialContract('tax', item.transfer).ok ||
          !same(item.transfer.scope, request.scope) || item.transfer.tax_year !== request.tax_year ||
          item.transfer.filing_unit_ref !== request.filing_unit_ref || item.transfer.jurisdiction !== request.jurisdiction ||
          item.transfer.observed_at !== request.observed_at) throw financialError('tax_check_request');
    }
  }
  async function compute(request) {
    validate(request);
    await allow(request, 'read');
    const results = [];
    for (const rule of TAX_CHECK_CATALOG) {
      const entry = request.entries.find(item => item.rule_id === rule.rule_id);
      results.push(entry ? await evaluateTaxCheck(entry, dependencies) : uncheckedTaxResult(rule.rule_id,
        rule.implemented ? 'evidence_not_supplied' : 'rule_not_implemented', ['catalog']));
    }
    return { schema_version: 'tax-check-document-1', rules_version: TAX_CHECK_VERSION,
      ...render(results, request.tax_year, request.observed_at), results };
  }
  const scopeKey = request => taxCheckHash({ scope: request.scope, tax_year: request.tax_year,
    filing_unit_ref: request.filing_unit_ref, jurisdiction: request.jurisdiction });
  const head = (tenant, scopeHash) => statement(`SELECT snapshot_id,
    json_extract(dependencies_json,'$.sequence') AS sequence FROM financial_run_events
    WHERE tenant_id=? AND event_kind='published' AND json_extract(dependencies_json,'$.schema_version')='tax-check-stored-1'
    AND json_extract(dependencies_json,'$.scope_hash')=? ORDER BY sequence DESC LIMIT 1`, tenant, scopeHash).first();
  async function readRow(tenant, runRef) {
    const row = await statement(`SELECT snapshot_id,event_hash,implementation_sha,observed_at,input_hash,dependencies_json
      FROM financial_run_events WHERE tenant_id=? AND snapshot_id=? AND event_kind='published'`, tenant, runRef).first();
    if (!row) throw financialError('tax_check_readback');
    let payload;
    try { payload = JSON.parse(row.dependencies_json); } catch { throw financialError('tax_check_readback'); }
    if (payload.schema_version !== 'tax-check-stored-1' || payload.request?.scope.tenant !== tenant ||
        row.input_hash !== await taxCheckHash(payload.request) || row.event_hash !== await taxCheckHash(payload) ||
        row.snapshot_id !== `tax_check_${row.event_hash}` || row.snapshot_id !== runRef ||
        row.implementation_sha !== payload.request.implementation_sha || row.observed_at !== payload.request.observed_at ||
        payload.scope_hash !== await scopeKey(payload.request) ||
        payload.content_key !== await taxCheckHash({ request: payload.request, result: payload.result }) ||
        !Number.isSafeInteger(payload.sequence) || payload.sequence < 1 ||
        (payload.sequence === 1 ? payload.previous_run_ref !== null : !/^tax_check_[a-f0-9]{64}$/.test(payload.previous_run_ref))) throw financialError('tax_check_readback');
    return { row, payload };
  }
  async function read({ tenant, run_ref: runRef, current = true } = {}) {
    if (typeof tenant !== 'string' || typeof runRef !== 'string' || !/^tax_check_[a-f0-9]{64}$/.test(runRef) ||
        typeof current !== 'boolean') throw financialError('tax_check_reference');
    const { payload } = await readRow(tenant, runRef);
    await allow(payload.request, 'read');
    if (current) {
      if ((await head(tenant, payload.scope_hash))?.snapshot_id !== runRef) throw financialError('tax_check_superseded');
    }
    // Historical is a label, never permission to reveal revoked source money.
    // Both modes re-resolve current grants, mappings and review bindings.
    const recomputed = await compute(payload.request);
    if (!same(recomputed, payload.result)) throw financialError('tax_check_stale');
    await allow(payload.request, 'read');
    return { ...payload.result, run_ref: runRef, current };
  }
  async function publish(input) {
    const request = structuredClone(input);
    validate(request);
    await allow(request, 'write');
    const result = await compute(request);
    const tenant = request.scope.tenant, scopeHash = await scopeKey(request);
    const contentKey = await taxCheckHash({ request, result });
    const existing = await statement(`SELECT snapshot_id FROM financial_run_events WHERE tenant_id=? AND event_kind='published'
      AND json_extract(dependencies_json,'$.schema_version')='tax-check-stored-1'
      AND json_extract(dependencies_json,'$.content_key')=?`, tenant, contentKey).first();
    if (existing) return read({ tenant, run_ref: existing.snapshot_id });
    const prior = await head(tenant, scopeHash);
    const payload = { schema_version: 'tax-check-stored-1', scope_hash: scopeHash, content_key: contentKey,
      sequence: (prior?.sequence ?? 0) + 1, previous_run_ref: prior?.snapshot_id ?? null, request, result };
    const json = canonicalFinancialJson(payload);
    if (new TextEncoder().encode(json).length > 1048576) throw financialError('tax_check_storage_bound');
    const eventHash = await taxCheckHash(payload), runRef = `tax_check_${eventHash}`;
    await allow(request, 'write');
    try {
      await statement(`INSERT INTO financial_run_events
        (tenant_id,snapshot_id,event_kind,implementation_sha,observed_at,input_hash,dependencies_json,event_hash)
        SELECT ?,?,'published',?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM financial_run_events WHERE tenant_id=? AND event_hash=?)
        AND COALESCE((SELECT max(json_extract(dependencies_json,'$.sequence')) FROM financial_run_events
          WHERE tenant_id=? AND event_kind='published' AND json_extract(dependencies_json,'$.schema_version')='tax-check-stored-1'
          AND json_extract(dependencies_json,'$.scope_hash')=?),0)=?`,
      tenant, runRef, request.implementation_sha, request.observed_at, await taxCheckHash(request), json, eventHash, tenant, eventHash,
      tenant, scopeHash, payload.sequence - 1).run();
    } catch { throw financialError('tax_check_storage'); }
    const saved = await read({ tenant, run_ref: runRef });
    if (!same(saved, { ...result, run_ref: runRef, current: true })) throw financialError('tax_check_readback');
    return saved;
  }
  return Object.freeze({ publish, read });
}
