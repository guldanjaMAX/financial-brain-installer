import { registerHooks } from "node:module";

registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith("/operations/gmail-attachment-backfill.mjs")) return result;
  const source = String(result.source);
  const target = "while (result.attempted < limit)";
  if (source.split(target).length !== 2) throw new Error("Candidate cap mutation target missing or ambiguous");
  process.stderr.write("MUTATION_APPLIED ignore_saved_candidate_cap\n");
  return { ...result, source: source.replace(target, "while (result.attempted < limit || checkpoint.pending_ids.length > 0)") };
} });
