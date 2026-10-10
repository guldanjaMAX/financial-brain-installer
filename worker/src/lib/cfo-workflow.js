import { taxReadiness } from './cfo-tax-evidence.js';

const QUESTIONS = 'Select one entity and ask “Check tax readiness for 2025.”, “Show my weekly cash brief.” or “Check books against bank from 2026-09-01 to 2026-09-30.”';
// Clarify attempted workflow actions, including compound clauses. A role or
// topic mention in a document question is not a request to run a workflow.
const CFO_REQUEST = /(?:^|[.!?;]\s+|\b(?:and|then)\s+)(?:please\s+|(?:can|could|would)\s+you\s+)?(?:(?:check|review)\s+(?:my\s+)?(?:tax[\s-]+readiness|books)\b|(?:show|run|review|check)\s+(?:my\s+)?(?:weekly[\s-]+cash(?:[\s-]+brief)?|cash[\s-]+brief)\b)/i;
function calendarDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Only complete questions enter a handler. Account references are opaque JSON
// strings: decode escaping, but never trim, fold case or infer from a label.
export function parseCfoQuestion(question) {
  const text = String(question ?? '').trim();
  let match = /^Check tax readiness for (\d{4})\.?$/i.exec(text);
  if (match && Number(match[1]) >= 1900 && Number(match[1]) <= 2200) {
    return { kind: 'tax_readiness', taxYear: Number(match[1]) };
  }
  if (/^Show my weekly cash brief\.?$/i.test(text)) return { kind: 'cash_brief' };
  match = /^Check books against bank from (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})(?: for account ("(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[\da-fA-F]{4})*"))?\.?$/i.exec(text);
  if (match && calendarDate(match[1]) && calendarDate(match[2]) && match[1] <= match[2]) {
    let accountRef;
    try { accountRef = match[3] === undefined ? null : JSON.parse(match[3]); }
    catch { return { kind: 'clarification' }; }
    if (accountRef === null || (accountRef.length > 0 && accountRef.length <= 256 && !/[\x00-\x1f\x7f]/.test(accountRef))) {
      return { kind: 'books_check', periodStart: match[1], periodEnd: match[2], accountRef };
    }
  }
  return CFO_REQUEST.test(text) ? { kind: 'clarification' } : null;
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
export async function dispatchCfoWorkflow({ question, entityScope, ownerCapability = null, filters = {}, reauthorize = async () => false }, dependencies = {}) {
  const intent = parseCfoQuestion(question);
  if (!intent) return null;
  const asOf = (dependencies.now ?? (() => new Date().toISOString()))();
  const reply = (status, answer, code) => cfoEnvelope({ entityScope, asOf, kind: intent.kind, status, answer, gaps: [{ type: code, detail: answer }] });
  if (!['signed_in_owner', 'full_admin'].includes(ownerCapability)) {
    return reply('refused', 'Sign in as the full owner to run this evidence workflow.', 'cfo_owner_required');
  }
  if (intent.kind === 'clarification') return reply('clarification', QUESTIONS, 'cfo_question_scope_required');
  if (entityScope?.applied !== true || !entityScope.entity_slug) {
    return reply('clarification', 'Select exactly one owned entity before running this workflow.', 'cfo_entity_required');
  }
  if (Object.keys(filters).some(key => !['entity_slug', 'vector_client'].includes(key))) {
    return reply('clarification', 'Use the entity selection and the year or dates in the supported question, without additional source or date filters.', 'cfo_filters_unsupported');
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
