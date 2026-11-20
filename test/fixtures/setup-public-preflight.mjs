// Inject machine facts only. The public dispatcher, setup wrapper, and output
// remain real; the separate side-effect tripwire guards every host boundary.
import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";

const doctorUrl = new URL("../../doctor.mjs", import.meta.url).href;
const checks = [
  { name: "Node.js", status: "ok", detail: "ready" },
  { name: "Free disk space", status: "warn", detail: "3.1 GiB free" },
  { name: "Install folder", status: "warn", detail: "needs room", fix: "Make room for files." },
  { name: "Claude Code", status: "fail", detail: "not signed in", fix: "Open Claude Code once and sign in.\nThen retry setup." },
];

globalThis.__setupOutputChecks = (options) => {
  appendFileSync(process.env.BRAIN_TEST_SETUP_CALLS, JSON.stringify({
    stage: "preflight", skipCloudflare: options.skipCloudflare,
    requireClaudeCode: options.requireClaudeCode,
  }) + "\n");
  return checks;
};
registerHooks({
  load(url, context, nextLoad) {
    if (url === doctorUrl) {
      return {
        format: "module", shortCircuit: true,
        source: `export * from ${JSON.stringify(doctorUrl + "?original")};
          export async function runAll(options) { return globalThis.__setupOutputChecks(options); }`,
      };
    }
    return nextLoad(url, context);
  },
});
