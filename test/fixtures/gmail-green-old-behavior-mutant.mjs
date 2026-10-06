/** Restores refusal gaps so the Gmail green regression must reject it. */

import { registerHooks } from "node:module";

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith("/brain.mjs")) return result;
    const source = String(result.source);
    const target = 'const gmailCredentialRefusalSkips = which === "gmail" ? localRefused + tally.refused : 0;';
    if (!source.includes(target)) throw new Error("Gmail refusal mutant target is missing");
    return {
      ...result,
      source: source.replace(target, 'const gmailCredentialRefusalSkips = 0;'),
    };
  },
});
