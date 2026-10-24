import { registerHooks } from "node:module";

const mutations = {
  retry_every_error: [
    '!["EPERM", "EACCES", "EBUSY"].includes(error?.code) || attempt === 9',
    "attempt === 9",
  ],
  no_backoff: ["sleep(225);", "void 0;"],
  unbounded_tries: [" || attempt === 9", ""],
};
const chosen = process.env.BRAIN_STATE_MUTANT;
if (!Object.hasOwn(mutations, chosen)) throw new Error("Unknown state writer mutation");
const [target, replacement] = mutations[chosen];

// Change only the loaded state writer. Product bytes remain unchanged on disk.
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith("/ingest/run.mjs")) return result;
  const source = String(result.source);
  if (source.split(target).length !== 2) throw new Error("State writer mutation target missing or ambiguous");
  process.stderr.write(`MUTATION_APPLIED ${chosen}\n`);
  return { ...result, source: source.replace(target, replacement) };
} });
