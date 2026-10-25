import { registerHooks } from "node:module";

const targets = new Set([
  new URL("../../operations/admin-key-file.mjs", import.meta.url).href,
  new URL("../../connectors/google-auth.mjs", import.meta.url).href,
]);

// Process-local mutation: put verified replacements back inside rollback
// custody when only removal of their protected backup failed.
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!targets.has(url)) return result;
  const source = String(result.source).replace(/\r\n/g, "\n");
  const target = "    if (replacementVerified) {";
  if (source.split(target).length !== 2) throw new Error("Credential cleanup mutation target missing or ambiguous");
  process.stderr.write("MUTATION_APPLIED rollback_verified_cleanup\n");
  return { ...result, source: source.replace(target, "    if (false && replacementVerified) {") };
} });
