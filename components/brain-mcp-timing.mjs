import { createQueryTiming, measureQueryStage, projectQueryTiming } from '../worker/src/lib/query-timing.js';

// The MCP host and Worker have different clocks. Keep the local envelope and
// up to two backend attempts separate, linked only by opaque request ids.
export function createMcpQueryTiming({ route, now } = {}) {
  const timing = createQueryTiming({ route, now });
  const backend = [];
  let endWrapping = timing.start('mcp_wrapping');
  async function outsideWrapper(stage, fn) {
    endWrapping();
    try { return await measureQueryStage(timing, stage, fn); }
    finally { endWrapping = timing.start('mcp_wrapping'); }
  }
  return {
    async backend(fn) {
      const response = await outsideWrapper('mcp_backend', fn);
      const receipt = projectQueryTiming(response?.timing);
      if (receipt && backend.length < 2) backend.push(receipt);
      timing.observeResult(response);
      return response;
    },
    wait(fn) { return outsideWrapper('mcp_retry_wait', fn); },
    finish(outcome) {
      endWrapping();
      return { ...timing.finish(outcome), backend };
    },
  };
}

const PART_B_ROLES = Object.freeze({
  answer_llm: Object.freeze({ provider: 'anthropic', model: 'claude-opus-5-5' }),
  verifier_llm: Object.freeze({ provider: 'anthropic', model: 'claude-sonnet-5-5' }),
});

// Project the operator-visible receipt only from the finished local envelope
// and its already validated backend projection. The answer body, identifiers,
// durations, host, paths and resource names never enter this shape.
export function partBRouteReceiptFromTiming(timing) {
  if (timing?.route !== 'mcp.brain_think' || timing.outcome !== 'ok' ||
      timing.stages?.mcp_backend?.calls !== 1 || timing.stages.mcp_backend.errors !== 0 ||
      !Array.isArray(timing.backend) || timing.backend.length !== 1) return null;
  const backend = timing.backend[0];
  if (backend?.route !== 'think' || backend.outcome !== 'ok' || !Array.isArray(backend.models)) return null;
  const roles = {};
  for (const [stage, expected] of Object.entries(PART_B_ROLES)) {
    const rows = backend.models.filter((model) => model?.stage === stage);
    if (rows.length !== 1 || rows[0].provider !== expected.provider || rows[0].id !== expected.model ||
        !Number.isSafeInteger(rows[0].calls) || rows[0].calls < 1 ||
        !Number.isSafeInteger(rows[0].errors) || rows[0].errors !== 0) return null;
    roles[stage] = rows[0];
  }
  return Object.freeze({
    schema_version: 1,
    route: 'mcp.brain_think',
    backend_route: 'think',
    outcome: 'ok',
    answer_provider: roles.answer_llm.provider,
    answer_model: roles.answer_llm.id,
    answer_calls: roles.answer_llm.calls,
    answer_errors: roles.answer_llm.errors,
    check_provider: roles.verifier_llm.provider,
    check_model: roles.verifier_llm.id,
    check_calls: roles.verifier_llm.calls,
    check_errors: roles.verifier_llm.errors,
    fallback_search_calls: 0,
  });
}
