import { registerHooks } from "node:module";

registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith("/connectors/gmail.mjs")) return result;
  const source = String(result.source);
  const target = "extractionPolicyVersion: 1,";
  if (source.split(target).length !== 2) throw new Error("Membership mutation target missing or ambiguous");
  process.stderr.write("MUTATION_APPLIED extraction_forces_membership_sweep\n");
  return { ...result, source: source.replace(target, "extractionPolicyVersion: GMAIL_EXTRACTION_POLICY_VERSION,") };
} });
