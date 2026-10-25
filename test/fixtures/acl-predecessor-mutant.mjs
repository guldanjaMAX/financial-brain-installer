import { registerHooks } from "node:module";

const targets = new Set([
  "../../operations/admin-key-file.mjs",
  "../../connectors/google-auth.mjs",
  "../../connectors/whatsapp.mjs",
  "../../connectors/quickbooks-desktop-binding.mjs",
  "../../operations/quickbooks-schedule-state.mjs",
].map(path => new URL(path, import.meta.url).href));

registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!targets.has(url)) return result;
  const source = String(result.source);
  const target = '["dev", "ino", "nlink", "size", "mtimeMs", "mode"]';
  if (source.split(target).length !== 2) throw new Error("ACL predecessor mutation target missing or ambiguous");
  process.stderr.write("MUTATION_APPLIED restore_acl_predecessor_ctime\n");
  return { ...result, source: source.replace(target, '["dev", "ino", "nlink", "size", "mtimeMs", "ctimeMs", "mode"]') };
} });
