import { registerHooks } from "node:module";
import { writeSync } from "node:fs";

const mode = process.env.BRAIN_REMOVAL_CAUSE_MUTANT;
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  let source = String(result.source);
  const replace = (before, after) => {
    if (!source.includes(before)) throw new Error("The restoring mutation missed its decision point.");
    source = source.replace(before, after);
    writeSync(2, `REMOVAL_CAUSE_MUTANT_REACHED:${mode}\n`);
  };
  if (mode === "f1" && url.endsWith("/operations/load-removal-review.mjs")) {
    replace('checkedRemovalCauseCounts(review.removal_causes, total)?.explicit_deletion === total', 'true');
  }
  if (mode === "f1" && url.endsWith("/operations/ingest-removal-plan.mjs")) {
    replace('automatic && !canAutoApplyRemoval(reviewFacts(plan), kind, source)', 'false');
  }
  if (mode === "f2" && url.endsWith("/operations/load-removal-review.mjs")) {
    const first = source.indexOf('  const explanation =');
    const last = source.indexOf('  return `${label}', first);
    if (first < 0 || last <= first) throw new Error("The wording mutation missed its decision point.");
    replace(source.slice(first, last), '  const explanation = review.reasons?.source_deleted === review.source_removals &&\n' +
      '    review.reasons.source_policy === 0 && review.reasons.intentional_skip === 0 && review.replacement_family_reviews === 0\n' +
      '    ? " you deleted." : " after a removal review.";\n');
  }
  return { ...result, source };
} });
