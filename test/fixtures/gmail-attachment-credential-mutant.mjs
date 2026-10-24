import { registerHooks } from "node:module";

// The final envelope scanner stays enabled. Without the per-attachment gate it
// refuses the entire family, so preserving a clean sibling must kill this mutant.
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith("/connectors/gmail-attachments.mjs")) return result;
  const source = String(result.source);
  const target = "if (partRefused({ content: got.text, title: name })) {";
  if (source.split(target).length !== 2) throw new Error("Credential mutation target missing or ambiguous");
  process.stderr.write("MUTATION_APPLIED omit_attachment_credential_gate\n");
  return { ...result, source: source.replace(target, "if (false) {") };
} });
