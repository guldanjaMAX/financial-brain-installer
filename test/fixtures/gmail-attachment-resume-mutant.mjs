import { registerHooks } from "node:module";

// Restore the body-only shortcut in memory. The reviewed file stays intact.
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith("/brain.mjs")) return result;
  const source = String(result.source);
  const target = "if (!gmailRevisionIsCurrent(version)) return null;";
  if (source.split(target).length !== 2) throw new Error("Resume mutation target missing or ambiguous");
  process.stderr.write("MUTATION_APPLIED body_only_resume\n");
  return { ...result, source: source.replace(target, "void 0;") };
} });
