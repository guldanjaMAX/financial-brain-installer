import { registerHooks } from "node:module";

// An isolated approval still needs the current accepted candidate revision.
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith("/operations/gmail-attachment-review.mjs")) return result;
  const source = String(result.source);
  const target = " || state.done?.[uid] !== hash || state.skipped?.[uid]";
  if (source.split(target).length !== 2) throw new Error("Candidate receipt mutation target missing or ambiguous");
  process.stderr.write("MUTATION_APPLIED omit_candidate_receipt_binding\n");
  return { ...result, source: source.replace(target, "") };
} });
