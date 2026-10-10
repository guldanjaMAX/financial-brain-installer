import { taxReadiness } from './cfo-tax-evidence.js';

function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Only an explicit typed action can select a handler. No question text is read,
// normalized, or classified. Unknown fields cannot supply evidence or authority.
export function parseCfoAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return { kind: 'clarification' };
  const fields = {
    tax_evidence_checklist: ['workflow', 'entity', 'year'],
    cash_brief: ['workflow', 'entity'],
    books_check: ['workflow', 'entity', 'period_start', 'period_end', 'account_ref'],
  };
  const keys = typeof action.workflow === 'string' && Object.hasOwn(fields, action.workflow) ? fields[action.workflow] : null;
  if (!keys || Object.keys(action).some(key => !keys.includes(key))) return { kind: 'clarification' };
  if (typeof action.entity !== 'string' || !action.entity || action.entity !== action.entity.trim()) return { kind: 'clarification' };
  if (action.workflow === 'tax_evidence_checklist' && Number.isInteger(action.year) && action.year >= 1900 && action.year <= 2200) {
    return { kind: 'tax_readiness', taxYear: action.year };
  }
  if (action.workflow === 'cash_brief') return { kind: 'cash_brief' };
  if (action.workflow === 'books_check' && calendarDate(action.period_start) && calendarDate(action.period_end)
    && action.period_start <= action.period_end) {
    const accountRef = action.account_ref === undefined ? null : action.account_ref;
    if (accountRef === null || (typeof accountRef === 'string' && accountRef.length > 0 && accountRef.length <= 256 && !/[\x00-\x1f\x7f]/.test(accountRef))) {
      return { kind: 'books_check', periodStart: action.period_start, periodEnd: action.period_end, accountRef };
    }
  }
  return { kind: 'clarification' };
}

export function cfoEnvelope({ entityScope, asOf, kind, status, answer, gaps = [], metadata = {} }) {
  return {
    mode: 'think', answer, notice: `Evidence checklist as of ${asOf}. Tax amounts and filing readiness are not checked.`,
    citations: [], results: [], gaps, entity_scope: entityScope, filter_not_applied: false,
    financial_authority: false,
    evidence_gate: { supported: false, complete: false, partial: true, evidence: [], reason: 'Evidence checklist only; no financial or filing approval.' },
    workflow: { ...metadata, kind, status, as_of: asOf, financial_authority: false },
  };
}

// This capability is supplied by the authenticated HTTP boundary, never by
// request JSON, a principal label, unrestricted scope, or an MCP default.
export async function dispatchCfoWorkflow({ action, entityScope, ownerCapability = null, filters = {}, reauthorize = async () => false }, dependencies = {}) {
  if (action === undefined) return null;
  const intent = parseCfoAction(action);
  const asOf = (dependencies.now ?? (() => new Date().toISOString()))();
  const reply = (status, answer, code) => cfoEnvelope({ entityScope, asOf, kind: intent.kind, status, answer, gaps: [{ type: code, detail: answer }] });
  if (!['signed_in_owner', 'full_admin'].includes(ownerCapability)) {
    return reply('refused', 'Sign in as the full owner to run this evidence workflow.', 'cfo_owner_required');
  }
  if (intent.kind === 'clarification') return reply('clarification', 'Choose one entity and a tax year from 1900 through 2200 using the Tax evidence checklist control. Send only the fields for that action.', 'cfo_action_invalid');
  if (entityScope?.applied !== true || !entityScope.entity_slug || entityScope.entity_slug !== action.entity) {
    return reply('clarification', 'Select exactly one owned entity before running this workflow.', 'cfo_entity_required');
  }
  if (Object.keys(filters).some(key => !['entity_slug', 'vector_client'].includes(key))) {
    return reply('clarification', 'Use only the entity and year or dates in the selected action, without additional source or date filters.', 'cfo_filters_unsupported');
  }
  const handlers = { tax_readiness: taxReadiness, ...dependencies.handlers };
  const handler = handlers[intent.kind];
  if (!handler) return reply('unavailable', 'This CFO workflow is not available yet.', 'cfo_workflow_unavailable');
  try {
    const result = await handler({ intent, entityScope, asOf, reauthorize }, dependencies.tax);
    return cfoEnvelope({ ...result, entityScope, asOf, kind: intent.kind });
  } catch {
    return reply('unavailable', 'The evidence checklist could not be read. Retry the check; no empty inventory or financial conclusion was inferred.', 'cfo_read_unavailable');
  }
}
