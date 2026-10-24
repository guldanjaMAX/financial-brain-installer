/** In-memory mutants for focused daily diagnostics tests; no product files change. */
import { registerHooks } from "node:module";

const mutants = {
  daily_load_output_policy_removed: ["operations/daily-refresh-run.mjs",
    "        log() {},\n", ""],
  loader_helpers_ignore_output_policy: ["brain.mjs",
    "(s, log = console.log) => log(", "(s) => console.log(", 3],
  lost_load_causes: ["brain.mjs", "sourceErrors.push(error);", "void error;"],
  unknown_issue_code: ["operations/daily-refresh-run.mjs",
    "const issueCode = dailyIssueCode(context.error);", 'const issueCode = "UNKNOWN";'],
  raw_detail: ["operations/daily-refresh-run.mjs",
    "const detail = DAILY_ISSUE_MESSAGES[issueCode];",
    "const detail = String(context.error?.message || context.error).slice(0, 200);"],
  missing_issue_message: ["operations/daily-refresh-messages.mjs",
    '  WRANGLER_UNAVAILABLE: "The hosting tool could not be started; review the local installation.",\n', ""],
  first_aggregate_entry: ["operations/daily-refresh-run.mjs",
    "error: preferredDailyError(stops),", "error: stops[0],"],
  nested_aggregate_not_flattened: ["operations/daily-refresh-run.mjs",
    "visit(entries[index], depth + 1);", "stops.push(entries[index]); failures++;"],
  unregistered_daily_suites: ["scripts/run-test-chain.mjs",
    '  "node --test test/daily-error-diag.test.mjs",\n  "node --test test/daily-load-errors.test.mjs",\n', "", 2],
};

const id = process.env.DAILY_ERROR_DIAG_MUTANT;
if (id) {
  const mutation = mutants[id];
  if (!mutation) throw new Error("unknown daily diagnostic mutant");
  const [file, target, replacement, expectedMatches = 1] = mutation;
  const targetUrl = new URL(`../../${file}`, import.meta.url).href;
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (url !== targetUrl) return loaded;
      const source = String(loaded.source).replace(/\r\n/gu, "\n");
      if (source.split(target).length !== expectedMatches + 1) throw new Error("daily diagnostic mutant target count changed");
      process.stderr.write(`DAILY_DIAG_MUTANT_REACHED:${id}\n`);
      return { ...loaded, source: source.replaceAll(target, replacement) };
    },
  });
}
