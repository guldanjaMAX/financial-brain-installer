import { registerHooks } from "node:module";

registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith("/test/fixtures/gmail-policy-diagnostics.mjs")) return result;
  const source = String(result.source);
  const target = 'summarize("first", first), ';
  if (source.split(target).length !== 2) throw new Error("Policy diagnostic mutation target missing or ambiguous");
  process.stderr.write("MUTATION_APPLIED hide_initial_checkpoint_failure\n");
  return { ...result, source: source.replace(target, "") };
} });
