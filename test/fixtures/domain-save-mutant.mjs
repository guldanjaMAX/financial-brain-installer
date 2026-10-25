import { registerHooks } from "node:module";

const targetUrl = new URL("../../brain.mjs", import.meta.url).href;
const target = "  await (options.saveManifest ?? saveManifest)(manifestPath, m);";
// Preserve the prior round's caller mutant as a reproducible repository fixture.
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (url !== targetUrl) return result;
  const source = String(result.source).replace(/\r\n/g, "\n");
  if (source.split(target).length !== 2) throw new Error("Domain saver mutation target missing or ambiguous");
  process.stderr.write("MUTATION_APPLIED bypass_deployment_manifest_writer\n");
  return { ...result, source: source.replace(target, "  saveManifest(manifestPath, m);") };
} });
