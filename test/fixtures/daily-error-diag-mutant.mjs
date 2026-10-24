/** In-memory mutants for focused daily diagnostics tests; no product files change. */
import { registerHooks } from "node:module";

const mutants = {
  lost_load_causes: ["brain.mjs", "sourceErrors.push(error);", "void error;"],
  unknown_issue_code: ["operations/daily-refresh-run.mjs",
    "const issueCode = dailyIssueCode(context.error);", 'const issueCode = "UNKNOWN";'],
  raw_detail: ["operations/daily-refresh-run.mjs",
    "function safeDiagnosticText(value, maxLength = 200) {",
    "function safeDiagnosticText(value, maxLength = 200) { return String(value).slice(0, maxLength);"],
};

const id = process.env.DAILY_ERROR_DIAG_MUTANT;
if (id) {
  const mutation = mutants[id];
  if (!mutation) throw new Error("unknown daily diagnostic mutant");
  const [file, target, replacement] = mutation;
  const targetUrl = new URL(`../../${file}`, import.meta.url).href;
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (url !== targetUrl) return loaded;
      const source = String(loaded.source);
      if (source.split(target).length !== 2) throw new Error("daily diagnostic mutant target is not unique");
      process.stderr.write(`DAILY_DIAG_MUTANT_REACHED:${id}\n`);
      return { ...loaded, source: source.replace(target, replacement) };
    },
  });
}
