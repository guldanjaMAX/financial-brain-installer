/** Restores the former cursor gate so the Gmail regression must reject it. */

import { registerHooks } from "node:module";

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith("/brain.mjs")) return result;
    const source = String(result.source);
    const target = "Number(tally?.failed || 0) === Number(durableRetryFailures || 0) &&";
    if (!source.includes(target)) throw new Error("Gmail cursor mutant target is missing");
    return {
      ...result,
      source: source.replace(target, "Number(tally?.failed || 0) === 0 &&"),
    };
  },
});
