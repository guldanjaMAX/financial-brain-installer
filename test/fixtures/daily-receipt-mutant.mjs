import { registerHooks } from "node:module";

const mutations = {
  resume_fenceless_authoritatively: [[
    "    fenceless: !fence,",
    "    fenceless: false,",
  ], [
    "  const fencelessPredecessor = prior !== null && priorFence === null;",
    "  const fencelessPredecessor = false;",
  ]],
  discard_fenceless_receipt: [[
    "  // Without the shared fence, daily commands may have changed the schedules.",
    "  if (manifestPath && !fence) return null;\n  // Without the shared fence, daily commands may have changed the schedules.",
  ]],
  erase_fenceless_remote_intent: [[
    "    (prior !== null && prior.remote_mutation_may_have_started !== false);",
    "    (prior !== null && options.expectedPredecessor?.fenceless !== true && prior.remote_mutation_may_have_started !== false);",
  ]],
};
const chosen = process.env.BRAIN_DAILY_RECEIPT_MUTANT;
if (!Object.hasOwn(mutations, chosen)) throw new Error("Unknown daily receipt mutation");
const targetUrl = new URL("../../operations/daily-refresh-scheduler.mjs", import.meta.url).href;

// Mutations affect only modules loaded by the current synthetic test process.
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (url !== targetUrl) return result;
  let source = String(result.source).replace(/\r\n/g, "\n");
  for (const [target, replacement] of mutations[chosen]) {
    if (source.split(target).length !== 2) throw new Error("Daily receipt mutation target missing or ambiguous");
    source = source.replace(target, replacement);
  }
  process.stderr.write(`MUTATION_APPLIED ${chosen}\n`);
  return { ...result, source };
} });
