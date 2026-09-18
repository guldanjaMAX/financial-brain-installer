import { createHash } from "node:crypto";

// A routine sync may clean up a few ordinary source changes without making an
// unattended scheduler unusable. Crossing either boundary is no longer
// routine: it may indicate a revoked permission, a bad listing, or a policy
// mistake, and therefore needs an exact second look from the owner.
export const DRIVE_REMOVAL_MAX_COUNT = 100;
export const DRIVE_REMOVAL_MAX_RATIO = 0.10;

/** A deliberate owner-review boundary, not an installer crash. */
export class DriveRemovalReviewRequired extends Error {
  constructor(message) {
    super(message);
    this.name = "DriveRemovalReviewRequired";
    this.code = "SAFETY_REVIEW_REQUIRED";
  }
}

const CATEGORY_INPUTS = Object.freeze([
  ["source_policy", "policyCandidates"],
  ["source_deleted", "vanishedCandidates"],
  ["intentional_skip", "intentionalCandidates"],
]);

/**
 * A stored family identity must survive every boundary byte-for-byte. Drive
 * provider ids cannot contain whitespace: accepting it there would let the
 * inventory classify one identity while the removal request names another.
 * Other connectors retain their existing opaque ids, including local upload
 * family names whose exact path-derived identity can legitimately contain a
 * space.
 */
export function isCanonicalStoredFamilyUid(value, source = null) {
  if (typeof value !== "string") return false;
  const separator = value.indexOf(":");
  if (separator < 1) return false;
  const uidSource = value.slice(0, separator);
  const sourceId = value.slice(separator + 1);
  if (source !== null && uidSource !== source) return false;
  const sourceIdPattern = uidSource === "drive"
    ? /^[^\s\u0000-\u001f\u007f-\u009f]+$/u
    : /^[^\u0000-\u001f\u007f-\u009f]+$/u;
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(uidSource) &&
    sourceIdPattern.test(sourceId);
}

function canonicalIdentitySet(values, label) {
  if (values == null) return new Set();
  if (typeof values === "string" || typeof values[Symbol.iterator] !== "function") {
    throw new TypeError(`${label} must be an iterable of document identifiers`);
  }
  const identities = [...values];
  if (identities.some((value) => !isCanonicalStoredFamilyUid(value))) {
    throw new TypeError(`${label} contains a malformed document identity`);
  }
  return new Set(identities);
}

/**
 * Build the one deletion decision for a Drive sync.
 *
 * Candidates that are not currently stored are harmless bookkeeping, not
 * deletion targets. A target appearing in more than one reason is assigned to
 * the first reason below so the aggregate count cannot be inflated or applied
 * twice. Only the opaque digest is shown to the owner.
 */
export function buildDriveRemovalPlan(input = {}, options = {}) {
  const storedFamilies = canonicalIdentitySet(input.storedFamilies, "storedFamilies");
  const activeFamilies = canonicalIdentitySet(input.activeFamilies, "activeFamilies");
  const assigned = new Set();
  const targets = {};

  for (const [category, inputKey] of CATEGORY_INPUTS) {
    const candidates = canonicalIdentitySet(input[inputKey], inputKey);
    targets[category] = [...candidates]
      .filter((uid) =>
        storedFamilies.has(uid) &&
        !assigned.has(uid) &&
        // A pending source-deletion marker can survive a lost response. If the
        // file is active again on retry, restoration wins. Policy and current
        // quality refusals remain independent reasons to remove it.
        (category !== "source_deleted" || !activeFamilies.has(uid))
      )
      .sort();
    for (const uid of targets[category]) assigned.add(uid);
  }

  const inventoryStored = storedFamilies.size;
  const stored = options.safetyBaselineCount ?? inventoryStored;
  if (!Number.isInteger(stored) || stored < 0 || stored > inventoryStored) {
    throw new TypeError("safetyBaselineCount must be a non-negative integer no larger than the stored inventory");
  }
  const counts = Object.fromEntries(
    CATEGORY_INPUTS.map(([category]) => [category, targets[category].length])
  );
  const total = assigned.size;
  const ratio = stored ? total / stored : total ? 1 : 0;
  const maxCount = options.maxCount ?? DRIVE_REMOVAL_MAX_COUNT;
  const maxRatio = options.maxRatio ?? DRIVE_REMOVAL_MAX_RATIO;
  const ratioFloorCount = options.ratioFloorCount ?? 0;
  const fingerprintContext = String(options.fingerprintContext || "default");
  const fingerprintBinding = options.fingerprintBinding ?? null;
  if (!Number.isInteger(maxCount) || maxCount < 0) throw new TypeError("maxCount must be a non-negative integer");
  if (!Number.isFinite(maxRatio) || maxRatio < 0 || maxRatio > 1) {
    throw new TypeError("maxRatio must be between zero and one");
  }
  if (!Number.isInteger(ratioFloorCount) || ratioFloorCount < 0) {
    throw new TypeError("ratioFloorCount must be a non-negative integer");
  }

  // Version and category assignment are part of the approval. Reclassifying a
  // target or changing the plan invalidates an earlier approval even when the
  // aggregate total happens to stay the same.
  const fingerprint = createHash("sha256").update(JSON.stringify({
    version: fingerprintBinding === null ? 2 : 3,
    context: fingerprintContext,
    limits: { maxCount, maxRatio, ratioFloorCount },
    stored,
    targets: CATEGORY_INPUTS.map(([category]) => [category, targets[category]]),
    ...(fingerprintBinding === null ? {} : { binding: fingerprintBinding }),
  })).digest("hex");

  return {
    total,
    stored,
    ratio,
    counts,
    targets,
    fingerprint,
    inventoryStored,
    tooLarge: total > maxCount || (total > ratioFloorCount && ratio > maxRatio),
  };
}

/** Refuse a surprising plan without disclosing any source identifier. */
export function assertDriveRemovalPlanSafe(plan, approval, options = {}) {
  const sourceLabel = String(options.sourceLabel || "Drive");
  if (!plan || typeof plan !== "object" || !/^[0-9a-f]{64}$/.test(String(plan.fingerprint || ""))) {
    throw new TypeError(`${sourceLabel} removal plan is invalid`);
  }
  if (!plan.tooLarge || approval === plan.fingerprint) return plan;

  const percent = (Number(plan.ratio || 0) * 100).toFixed(1);
  throw new DriveRemovalReviewRequired(
    `${sourceLabel} cleanup would remove ${plan.total} of ${plan.stored} stored documents (${percent}%).\n` +
      `      Aggregate reasons: source policy ${plan.counts.source_policy}; source deletion ${plan.counts.source_deleted}; intentional skip ${plan.counts.intentional_skip}.\n` +
      "      Nothing in this removal plan was removed. The source cursor was not advanced.\n" +
      "      Review the source and policy, then approve this exact plan by re-running with:\n" +
      `      --approve-removals ${plan.fingerprint}`
  );
}
