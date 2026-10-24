import { registerHooks } from "node:module";

// Remove only the Gmail policy forwarding in memory. The PDF parser still
// enforces the option when requested, so its passing controls remain useful.
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith("/connectors/gmail-attachments.mjs")) return result;
  const source = String(result.source);
  const target = "extract(bytes, name, { rejectEncrypted: true })";
  if (source.split(target).length !== 2) throw new Error("Encryption mutation target missing or ambiguous");
  process.stderr.write("MUTATION_APPLIED reject_encrypted_not_forwarded\n");
  return { ...result, source: source.replace(target, "extract(bytes, name)") };
} });
