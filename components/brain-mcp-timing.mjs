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
