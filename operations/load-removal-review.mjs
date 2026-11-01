/** Aggregate review facts shared by load, daily receipts and local status. */
import { DriveRemovalReviewRequired } from "./drive-removal-plan.mjs";
import { renderCliCommands } from "./cli-guidance.mjs";

const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const fingerprint = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : null;
const sourceName = (value) => typeof value === "string" && /^[a-z0-9_-]{1,64}$/u.test(value) ? value : null;

// Project closed aggregate fields. Never carry saved selectors, document IDs,
// provider output, local paths or raw apply errors into receipts or status.
export function removalReviewFacts(review, source) {
  if (!review || !fingerprint(review.fingerprint)) return null;
  const facts = {
    source: sourceName(review.source) || sourceName(source),
    kind: typeof review.kind === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(review.kind) ? review.kind : null,
    stored_documents_to_remove: count(review.stored_documents_to_remove),
    source_removals: count(review.source_removals),
    replacement_family_reviews: count(review.replacement_family_reviews),
    source_stored_documents: count(review.source_stored_documents),
    source_cleanup_percentage: Number.isFinite(review.source_cleanup_percentage) &&
      review.source_cleanup_percentage >= 0 && review.source_cleanup_percentage <= 100 ? review.source_cleanup_percentage : null,
    reasons: review.reasons && ["source_deleted", "source_policy", "intentional_skip"].every(key => count(review.reasons[key]) !== null)
      ? Object.fromEntries(["source_deleted", "source_policy", "intentional_skip"].map(key => [key, review.reasons[key]])) : null,
    fingerprint: review.fingerprint,
    approval_fingerprint: fingerprint(review.approval_fingerprint),
  };
  if (!facts.source || [facts.stored_documents_to_remove, facts.source_removals, facts.replacement_family_reviews].includes(null)) return null;
  facts.apply_command = renderCliCommands(`brain ingest <manifest>${facts.kind && facts.kind !== "upload" ? ` --from ${facts.kind}` : ""}` +
    ` --source ${facts.source} --apply-removals ${facts.fingerprint}` +
    (facts.approval_fingerprint ? ` --approve-removals ${facts.approval_fingerprint}` : ""));
  return Object.freeze(facts);
}

export function canAutoApplyRemoval(review, kind, source) {
  const total = review?.stored_documents_to_remove;
  // Physical targets must agree with the complete, disjoint source reasons.
  // Missing facts and replacement parts cannot borrow a logical-family ratio.
  return ["calendar", "gmail"].includes(kind) && review?.kind === kind && review.source === source &&
    total > 0 && total <= 25 && review.source_stored_documents > 0 &&
    total * 100 <= review.source_stored_documents &&
    review.source_removals === total && review.replacement_family_reviews === 0 &&
    review.reasons?.source_deleted === total && review.reasons.source_policy === 0 &&
    review.reasons.intentional_skip === 0 && review.approval_fingerprint === null;
}

export function removalOwnerSentence(review) {
  const label = review?.kind === "calendar" ? "Calendar" : review?.kind === "gmail" ? "Gmail" : "This source";
  if (!review) return `${label} is waiting for your OK to review removals. Run ingestion again to obtain the exact apply command.`;
  const deletedOnly = review.reasons?.source_deleted === review.source_removals &&
    review.reasons.source_policy === 0 && review.reasons.intentional_skip === 0 && review.replacement_family_reviews === 0;
  return `${label} is waiting for your OK to remove ${review.stored_documents_to_remove} item(s)` +
    (deletedOnly ? " you deleted." : " after a removal review.") + ` Run: ${review.apply_command}`;
}

/** One initial source run, one exact apply, one source replay. No retry loop. */
export async function runLoadRemovalLeg({ run, apply, kind, source, dryRun, assertOwned = () => {} }) {
  try { return { result: await run(), auto_applied_removals: [] }; }
  catch (error) {
    if (!(error instanceof DriveRemovalReviewRequired)) throw error;
    const review = removalReviewFacts(error.removal_review, source);
    if (dryRun || !canAutoApplyRemoval(review, kind, source)) throw error;
    const attempt = { source, count: review.stored_documents_to_remove,
      percent: review.stored_documents_to_remove * 100 / review.source_stored_documents,
      fingerprint: review.fingerprint, reasons: review.reasons, readback: "failed" };
    try {
      assertOwned();
      const result = await apply({ from: kind, source, "apply-removals": review.fingerprint });
      if (result?.removed !== attempt.count || result?.cursor_advanced !== false || result?.readback !== "passed") {
        throw new Error("The removal apply did not prove its exact count and readback.");
      }
      attempt.readback = "passed";
    } catch (failure) {
      error.auto_applied_removals = [{ ...attempt, failure_code: "apply_or_readback_failed" }];
      error.auto_apply_error = failure;
      throw error;
    }
    try {
      assertOwned();
      return { result: await run(), auto_applied_removals: [attempt] };
    } catch (failure) {
      failure.auto_applied_removals = [attempt];
      throw failure;
    }
  }
}
