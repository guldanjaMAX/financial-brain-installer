import { registerHooks } from "node:module";

const mutations = {
  no_retry: [
    '["EPERM", "EACCES", "EBUSY"].includes(error?.code) && attempt < 9',
    "false",
  ],
  retry_every_error: [
    '["EPERM", "EACCES", "EBUSY"].includes(error?.code) && attempt < 9',
    "attempt < 9",
  ],
  unbounded_tries: [" && attempt < 9", ""],
};
const chosen = process.env.BRAIN_RENAME_MUTANT;
if (!Object.hasOwn(mutations, chosen)) throw new Error("Unknown rename retry mutation");
const [target, replacement] = mutations[chosen];
const helperUrl = new URL("../../operations/rename-retry.mjs", import.meta.url).href;

// Change only the module loaded by this test process, preserving product bytes.
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (url !== helperUrl) return result;
  const source = String(result.source);
  if (source.split(target).length !== 2) throw new Error("Rename retry mutation target missing or ambiguous");
  process.stderr.write(`MUTATION_APPLIED ${chosen}\n`);
  return { ...result, source: source.replace(target, replacement) };
} });
