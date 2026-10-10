// Request-local, content-free aggregates. Never accept span names, correlation
// ids, model labels or log fields from a question, document or request header.
export const QUERY_STAGES = Object.freeze([
  'scope', 'retrieval', 'embedding', 'keyword', 'vector', 'vector_query', 'projection_readiness',
  'authority_lineage', 'answer_llm', 'verifier_llm', 'evidence_gate',
  'premise_temporal', 'coverage', 'gaps', 'rerank', 'financial_map',
  'cfo_workflow', 'legacy_hybrid', 'mcp_wrapping', 'mcp_backend', 'mcp_retry_wait',
]);
// Version-1 consumers also read older Workers. Additive spans are optional on
// the wire and omitted when unused; the original stages remain required.
const OPTIONAL_QUERY_STAGES = new Set(['cfo_workflow']);
const ROUTES = new Set(['think', 'unified', 'mcp', 'mcp.ask', 'mcp.search', 'mcp.brain_think', 'mcp.brain_search']);
const PROVIDERS = new Set(['cloudflare-workers-ai', 'anthropic']);
// Unknown configured model strings cannot become an exfiltration channel. Add
// reviewed ids here when a new model is supported; never copy provider replies.
const MODELS = new Set([
  '@cf/baai/bge-base-en-v1.5',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/google/gemma-4-26b-a4b-it',
  'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5', 'claude-haiku-4-5-20251001',
]);
const MAX_MS = 86_400_000;
const MAX_COUNT = 65_535;
const noop = () => {};
const rounded = value => Math.round(Math.max(0, Math.min(MAX_MS, value)) * 1000) / 1000;

export function createQueryTiming({ route, now = () => performance.now() } = {}) {
  let last = 0;
  const read = () => {
    const value = Number(now());
    if (Number.isFinite(value)) last = Math.max(last, value);
    return last;
  };
  const origin = read();
  const time = () => Math.min(MAX_MS, Math.max(0, read() - origin));
  const requestId = crypto.randomUUID();
  const stages = Object.fromEntries(QUERY_STAGES.map(key => [key, { calls: 0, errors: 0, active: 0, ms: 0 }]));
  const models = new Map();
  let routeId = ROUTES.has(route) ? route : 'mcp';
  let active = 0, covered = 0, coveredStart = 0, frozen = null;
  let visible = false, observedOutcome = 'ok';
  const pending = new Set();
  return {
    expose() { visible = true; },
    observeResult(body) {
      if (body?.error || body?.answer_error) observedOutcome = 'error';
      else if (observedOutcome !== 'error' && body?.mode === 'think' &&
          (body.answer === null || body.evidence_gate?.supported === false)) observedOutcome = 'refused';
    },
    get visible() { return visible; },
    setRoute(value) { if (ROUTES.has(value)) routeId = value; },
    start(stage) {
      const aggregate = Object.hasOwn(stages, stage) ? stages[stage] : null;
      if (!aggregate || frozen || aggregate.calls >= MAX_COUNT) return noop;
      const start = time();
      aggregate.calls++;
      aggregate.active++;
      if (active++ === 0) coveredStart = start;
      let ended = false;
      const end = (failed = false) => {
        if (ended || frozen) return;
        ended = true;
        const stop = time();
        aggregate.ms += stop - start;
        aggregate.active--;
        if (failed) aggregate.errors++;
        if (--active === 0) covered += stop - coveredStart;
        pending.delete(end);
      };
      pending.add(end);
      return end;
    },
    model(stage, provider, model) {
      if (!Object.hasOwn(stages, stage) || !PROVIDERS.has(provider) || frozen) return noop;
      const id = MODELS.has(model) ? model : 'unrecognized';
      const key = `${stage}:${provider}:${id}`;
      if (!models.has(key) && models.size >= 16) return noop;
      if (!models.has(key)) models.set(key, { stage, provider, id, calls: 0, errors: 0, ms: 0 });
      const entry = models.get(key);
      if (entry.calls >= MAX_COUNT) return noop;
      entry.calls++;
      const start = time();
      let ended = false;
      return (failed = false) => {
        if (ended || frozen) return;
        ended = true;
        entry.ms += time() - start;
        if (failed) entry.errors++;
      };
    },
    finish(outcome = 'ok') {
      if (frozen) return frozen;
      // A failed route can leave manually delimited local work unfinished.
      // Close it here; later async completions cannot mutate this receipt.
      for (const end of pending) end(true);
      const total = time();
      const stageTotal = Object.values(stages).reduce((sum, value) => sum + value.ms, 0);
      frozen = {
        version: 1, request_id: requestId, route: routeId,
        outcome: outcome === 'ok' ? observedOutcome : ['refused', 'error'].includes(outcome) ? outcome : 'error',
        total_ms: rounded(total), covered_ms: rounded(covered),
        overlap_ms: rounded(stageTotal - covered), unattributed_ms: rounded(total - covered),
        stages: Object.fromEntries(Object.entries(stages)
          .filter(([key, value]) => !OPTIONAL_QUERY_STAGES.has(key) || value.calls > 0)
          .map(([key, value]) => [key, {
          calls: value.calls, errors: value.errors, ms: rounded(value.ms),
        }])),
        models: [...models.values()].map(value => ({ ...value, ms: rounded(value.ms) })),
      };
      return frozen;
    },
  };
}

// Preserve synchronous return values, synchronous throws and async rejection.
// Starting before invoking fn is essential: concurrent fan-out must stay parallel.
function measured(end, fn) {
  try {
    const value = fn();
    if (value && typeof value.then === 'function') {
      return value.then(result => { end(); return result; }, error => { end(true); throw error; });
    }
    end();
    return value;
  } catch (error) { end(true); throw error; }
}
export const startQueryStage = (timing, stage) => timing?.start(stage) || noop;
export const measureQueryStage = (timing, stage, fn) => measured(startQueryStage(timing, stage), fn);
export const measureQueryModel = (timing, stage, provider, model, fn) =>
  measured(timing?.model(stage, provider, model) || noop, fn);

export async function queryTimingResponse(timing, response) {
  if (!timing?.visible || !response.headers.get('content-type')?.includes('application/json')) return response;
  const body = await response.json();
  const rpc = body.jsonrpc === '2.0';
  const outcome = response.status >= 400 || body.error || body.answer_error || body.result?.isError
    ? 'error'
    : body.mode === 'think' && (body.answer === null || body.evidence_gate?.supported === false)
      ? 'refused' : 'ok';
  const receipt = timing.finish(outcome);
  // MCP metadata is out of band: diagnostics do not enter the model's content
  // or alter answer/refusal rendering. JSON-RPC errors retain their envelope.
  if (rpc) {
    if (body.result) body.result._meta = { ...body.result._meta, timing: receipt };
    else body.error.data = { timing: receipt };
  } else body.timing = receipt;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('Cache-Control', 'private, no-store, max-age=0');
  return new Response(JSON.stringify(body), { status: response.status, statusText: response.statusText, headers });
}

// Project a remote receipt before carrying it into a probe or MCP metadata.
// No arbitrary property, model string or identifier can ride alongside spans.
export function projectQueryTiming(value) {
  if (!value || value.version !== 1 || !ROUTES.has(value.route) ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.request_id) ||
      !['ok', 'refused', 'error'].includes(value.outcome)) return null;
  const duration = number => typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= MAX_MS;
  const count = number => Number.isInteger(number) && number >= 0 && number <= MAX_COUNT;
  const fields = ['total_ms', 'covered_ms', 'overlap_ms', 'unattributed_ms'];
  if (!fields.every(key => duration(value[key]))) return null;
  const stages = {};
  for (const key of QUERY_STAGES) {
    if (OPTIONAL_QUERY_STAGES.has(key) && !Object.hasOwn(value.stages ?? {}, key)) continue;
    const stage = value.stages?.[key];
    if (!stage || !duration(stage.ms) || !count(stage.calls) || !count(stage.errors) || stage.errors > stage.calls) return null;
    stages[key] = { calls: stage.calls, errors: stage.errors, ms: stage.ms };
  }
  if (!Array.isArray(value.models) || value.models.length > 16) return null;
  const models = [];
  for (const model of value.models) {
    if (!QUERY_STAGES.includes(model?.stage) || !PROVIDERS.has(model.provider) ||
        !(MODELS.has(model.id) || model.id === 'unrecognized') ||
        !count(model.calls) || !count(model.errors) || model.errors > model.calls || !duration(model.ms)) return null;
    models.push({ stage: model.stage, provider: model.provider, id: model.id, calls: model.calls, errors: model.errors, ms: model.ms });
  }
  return { version: 1, request_id: value.request_id, route: value.route, outcome: value.outcome,
    ...Object.fromEntries(fields.map(key => [key, value[key]])), stages, models };
}
