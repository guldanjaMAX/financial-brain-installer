// Deliberately bad implementations loaded only by the discrimination suite.
import { registerHooks } from "node:module";
import { writeSync } from "node:fs";

const control = process.env.BRAIN_SMALL_REMOVAL_CONTROL;
if (control === "startup-refusal" && process.argv[1]?.endsWith("brain.mjs")) {
  writeSync(2, "SMALL_REMOVAL_STARTUP_REFUSAL\n");
  process.exit(23);
}
// Model a pipe whose writes finish after the review handler returns.
if (["buffered-output", "immediate-exit"].includes(control) && process.argv[1]?.endsWith("brain.mjs")) {
  const NativeDate = Date;
  const anchor = NativeDate.parse("2026-11-01T12:00:00Z");
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [anchor])); }
    static now() { return anchor; }
  };
  const write = process.stdout._write;
  process.stdout._write = function (chunk, encoding, callback) {
    setTimeout(() => write.call(this, chunk, encoding, callback), 10);
  };
}
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.endsWith("/brain.mjs") && control === "immediate-exit") {
      const before = String(result.source);
      const source = before.replace('process.stdout.write("", () => process.exit(1));', 'process.exit(1);');
      if (source === before) throw new Error("the immediate-exit control did not reach the review handler");
      return { ...result, source };
    }
    if (!url.endsWith("/operations/load-removal-review.mjs")) return result;
    let source = String(result.source);
    if (control === "never-apply") source = source.replace('if (dryRun || !canAutoApplyRemoval(review, kind, source))', 'if (true)');
    if (control === "always-apply") source = source.replace('if (dryRun || !canAutoApplyRemoval(review, kind, source))', 'if (false)');
    if (control === "omit-receipt") source = source.replace('auto_applied_removals: [attempt]', 'auto_applied_removals: []');
    if (control === "omit-approval") source = source.replace(
      '(facts.approval_fingerprint ? ` --approve-removals ${facts.approval_fingerprint}` : "")', '""');
    if (control === "ignore-failure") source = source.replace(/error\.auto_apply_error = failure;\r?\n      throw error;/u,
      'error.auto_apply_error = failure;\n      return { result: { sent: { unchanged: 1 } }, auto_applied_removals: [attempt] };');
    if (["never-apply", "always-apply", "omit-receipt", "omit-approval", "ignore-failure"].includes(control) &&
        source === String(result.source)) throw new Error("the removal control did not reach its mutation site");
    return { ...result, source };
  },
});
