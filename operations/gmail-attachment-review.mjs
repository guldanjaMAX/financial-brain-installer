import { createIngestRemovalReview, requestIngestRemovalPlan, ingestRemovalRuntime, removalDigest } from "./ingest-removal-plan.mjs";
import { DriveRemovalReviewRequired } from "./drive-removal-plan.mjs";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const refuse = message => { throw new DriveRemovalReviewRequired(message); };
const REVIEW_LIMIT = 100;
const structuralMember = (uid, base) => {
  if (typeof uid !== "string") return false;
  if (uid === base) return true;
  if (!uid.startsWith(`${base}#`)) return false;
  const part = /^#part([1-9]\d*)of([1-9]\d*)$/.exec(uid.slice(base.length));
  return Boolean(part && Number.isSafeInteger(Number(part[1])) && Number.isSafeInteger(Number(part[2])) &&
    Number(part[1]) <= Number(part[2]));
};

/** Recover only the identities bound by retained structural intent. A new
 * scanner, query or accepted revision needs another read and another preview,
 * never reuse of the old removal approval. This inspection performs no writes.
 */
export function gmailAttachmentReviewCandidates({
  state, source, query, scannerFingerprint, extractionVersion,
}) {
  const checkpoint = state?.gmail_attachment_backfill;
  if (checkpoint?.review === undefined) return { ids: [], changed: false };
  const review = checkpoint.review;
  const invalid = () => refuse("The saved attachment cleanup intent is invalid. It was retained for review.");
  const validUid = uid => typeof uid === "string" && uid.startsWith(`${source}:`) &&
    /^[A-Za-z0-9_-]{1,256}$/.test(uid.slice(source.length + 1));
  const belongs = structuralMember;
  const validFamily = family => object(family) && validUid(family.base_doc_uid) &&
    family.family_kind === "structural" && Array.isArray(family.keep_doc_uids) &&
    family.keep_doc_uids.length > 0 && new Set(family.keep_doc_uids).size === family.keep_doc_uids.length &&
    family.keep_doc_uids.every(uid => belongs(uid, family.base_doc_uid));
  if (!object(checkpoint) || !object(review) || review.version !== 1 ||
      !object(review.done) || !object(review.skipped) || Object.keys(review.skipped).length ||
      Object.keys(review.done).length > REVIEW_LIMIT ||
      Object.keys(review).some(key => !["version", "done", "skipped", "ingest_pending_families", "ingest_removal_plan"].includes(key)) ||
      (review.ingest_pending_families !== undefined && !object(review.ingest_pending_families))) invalid();
  let changed = (query !== undefined && checkpoint.query !== query) ||
    (scannerFingerprint !== undefined && checkpoint.scanner_fingerprint !== scannerFingerprint) ||
    (extractionVersion !== undefined && checkpoint.extraction_version !== extractionVersion);
  for (const [uid, hash] of Object.entries(review.done)) {
    if (!validUid(uid) || typeof hash !== "string" || !hash) invalid();
    if (state.done?.[uid] !== hash || state.skipped?.[uid]) changed = true;
  }
  const entries = Object.entries(review.ingest_pending_families || {});
  if (entries.length > REVIEW_LIMIT) invalid();
  for (const [uid, entry] of entries) {
    if (!object(entry) || !validFamily(entry.family) || uid !== entry.stateKey ||
        uid !== entry.family.base_doc_uid || !Object.hasOwn(review.done, uid) || review.done[uid] !== entry.hash) invalid();
  }
  if (review.ingest_removal_plan !== undefined) {
    const plan = review.ingest_removal_plan;
    if (!object(plan) || plan.version !== 1 || plan.source !== source || plan.kind !== "gmail" ||
        !Array.isArray(plan.families) || plan.families.length !== entries.length || !entries.length ||
        plan.families.some(family => !validFamily(family)) ||
        !Array.isArray(plan.sourceTargets) || plan.sourceTargets.length || plan.sourcePlan !== null ||
        !Array.isArray(plan.targets) || !plan.targets.length || new Set(plan.targets).size !== plan.targets.length ||
        plan.targets.some(uid => !plan.families.some(family => belongs(uid, family.base_doc_uid) &&
          !family.keep_doc_uids.includes(uid)))) invalid();
    const expected = entries.map(([, entry]) => entry.family);
    const byBase = families => [...families].sort((a, b) => a.base_doc_uid < b.base_doc_uid ? -1 : a.base_doc_uid > b.base_doc_uid ? 1 : 0);
    const { fingerprint, ...payload } = plan;
    const { ingest_removal_plan: _plan, ...snapshot } = review;
    if (removalDigest(byBase(plan.families)) !== removalDigest(byBase(expected)) ||
        plan.state !== removalDigest(snapshot) || fingerprint !== removalDigest(payload)) invalid();
  }
  return { ids: entries.map(([uid]) => uid.slice(source.length + 1)), changed };
}

/** Candidate replacement cleanup has its own approval snapshot. The normal
 * history checkpoint must remain live while an obsolete attachment part waits
 * for owner approval; a changed accepted candidate still invalidates that plan.
 */
export function createGmailAttachmentReview({
  state, source, manifest, manifestPath, base, adminKey, saveState, assertOwned,
  request = requestIngestRemovalPlan, runtime = ingestRemovalRuntime,
  now = () => Date.now(), onProgress = () => {},
}) {
  const checkpoint = state.gmail_attachment_backfill;
  if (!object(checkpoint)) refuse("Attachment cleanup needs a valid backfill checkpoint.");
  if (checkpoint.review !== undefined && !object(checkpoint.review)) {
    refuse("The saved attachment cleanup review is invalid. Its checkpoint was retained.");
  }
  const reviewState = checkpoint.review ||= { version: 1, done: {}, skipped: {} };
  const validUid = uid => typeof uid === "string" && uid.startsWith(`${source}:`) &&
    /^[A-Za-z0-9_-]{1,256}$/.test(uid.slice(source.length + 1));
  const validFamily = family => object(family) && validUid(family.base_doc_uid) &&
    family.family_kind === "structural" && Array.isArray(family.keep_doc_uids) &&
    family.keep_doc_uids.length > 0 && new Set(family.keep_doc_uids).size === family.keep_doc_uids.length &&
    family.keep_doc_uids.every(uid => structuralMember(uid, family.base_doc_uid));
  const assertCurrent = () => {
    assertOwned?.();
    if (state.gmail_attachment_backfill !== checkpoint || checkpoint.review !== reviewState ||
        reviewState.version !== 1 || !object(reviewState.done) || !object(reviewState.skipped) ||
        Object.keys(reviewState.skipped).length || Object.keys(reviewState.done).length > REVIEW_LIMIT) {
      refuse("The saved attachment cleanup review changed or is invalid. Its checkpoint was retained.");
    }
    for (const [uid, hash] of Object.entries(reviewState.done)) {
      if (!validUid(uid) || typeof hash !== "string" || !hash || state.done?.[uid] !== hash || state.skipped?.[uid]) {
        refuse("An accepted attachment revision changed. Run Gmail ingestion again before approving its cleanup.");
      }
    }
    if (reviewState.ingest_pending_families !== undefined && !object(reviewState.ingest_pending_families)) {
      refuse("The saved attachment cleanup families are invalid. Their checkpoint was retained.");
    }
    for (const [uid, entry] of Object.entries(reviewState.ingest_pending_families || {})) {
      if (!object(entry) || !validFamily(entry.family) || uid !== entry.family.base_doc_uid ||
          entry.stateKey !== uid || reviewState.done[uid] !== entry.hash) {
        refuse("The saved attachment cleanup family binding is invalid. Its checkpoint was retained.");
      }
    }
  };
  const save = () => { assertCurrent(); saveState(); };
  const review = createIngestRemovalReview({
    state: reviewState, source, kind: "gmail", manifest, manifestPath, base, adminKey,
    saveState: save, assertOwned: assertCurrent, runtime, now, onProgress,
    policy: () => ({ lane: "gmail_attachment_backfill", query: checkpoint.query,
      extraction_version: checkpoint.extraction_version, scanner_fingerprint: checkpoint.scanner_fingerprint }),
    request: async input => {
      assertCurrent();
      const response = await request(input);
      // Shared source cleanup can retain an unrelated overlap and continue.
      // Candidate coverage is narrower: every candidate family must settle,
      // including an overlap whose structural membership cannot be proven.
      if (input.body.action === "preview" && Number.isSafeInteger(response?.excluded_documents) &&
          response.excluded_documents > 0) {
        refuse("Attachment cleanup preserved unverified overlapping documents. Review remains pending; normal Gmail history can continue.");
      }
      return response;
    },
  });
  const pending = () => Boolean(reviewState.ingest_removal_plan ||
    Object.keys(reviewState.ingest_pending_families || {}).length);
  const settle = () => {
    // Retain no growing second copy of accepted mailbox revisions. The outer
    // done map owns acceptance; this tiny map exists only while cleanup waits.
    if (!pending()) {
      reviewState.done = {};
      save();
    }
  };
  assertCurrent();
  return {
    pending,
    get fingerprint() { return reviewState.ingest_removal_plan?.fingerprint ?? null; },
    remember(plans) {
      assertCurrent();
      const accepted = [...plans];
      const keys = new Set([...Object.keys(reviewState.done), ...accepted.map(plan => plan?.stateKey)]);
      if (keys.size > REVIEW_LIMIT || accepted.some(plan => !object(plan) || !validFamily(plan) ||
          plan.stateKey !== plan.base_doc_uid || typeof plan.hash !== "string" || !plan.hash ||
          state.done?.[plan.stateKey] !== plan.hash || state.skipped?.[plan.stateKey])) {
        refuse("Attachment cleanup needs exact accepted candidate revisions within the run limit.");
      }
      for (const plan of accepted) reviewState.done[plan.stateKey] = plan.hash;
      review.remember(accepted);
      save();
    },
    async finish() {
      assertCurrent();
      try { await review.finish(); }
      catch (error) {
        if (error instanceof DriveRemovalReviewRequired) {
          error.message = error.message.replace(
            "Accepted additions and updates are saved. No removal was applied; the source cursor was kept.",
            "Accepted attachment revisions are saved. No removal was applied; normal Gmail history remains independent.",
          );
        }
        throw error;
      }
      settle();
    },
    async apply(fingerprint, sourceApproval) {
      assertCurrent();
      const result = await review.apply(fingerprint, sourceApproval);
      settle();
      return result;
    },
  };
}
