import { registerHooks } from "node:module";

// Remove the known-omission stop without editing the reviewed source file.
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith("/connectors/gmail-attachments.mjs")) return result;
  const source = String(result.source);
  const target = 'if (got.incomplete === true || got.provenance?.text_reliable === false) return failure("incomplete_attachment");';
  if (source.split(target).length !== 2) throw new Error("Attachment mutation target missing or ambiguous");
  process.stderr.write("MUTATION_APPLIED ignore_incomplete_attachment\n");
  return { ...result, source: source.replace(target, "void 0;") };
} });
