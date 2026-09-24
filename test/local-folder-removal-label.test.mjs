/**
 * Local-folder cleanup review must say "Folder", not "Drive".
 *
 * WHY THIS EXISTS. assertDriveRemovalPlanSafe's oversized-plan refusal names
 * whichever source is cleaning up, defaulting to "Drive" when the caller
 * passes no sourceLabel. The local synced-folder ingest lane (brain.mjs,
 * cmdIngestLocalRun) used to call it with no label at all, so an owner
 * approving a LOCAL FOLDER cleanup read "Drive cleanup would remove ...
 * stored documents" for a source that was never Google Drive. The real
 * Drive lane must keep saying Drive.
 *
 * Every identifier here is a fictional fixture; none names a real source.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertDriveRemovalPlanSafe,
  buildDriveRemovalPlan,
  DriveRemovalReviewRequired,
} from "../brain.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 300)));
  if (!c) fail++;
};

function oversizedPlan() {
  // 150 exceeds DRIVE_REMOVAL_MAX_COUNT (100) on count alone, so this trips
  // `tooLarge` without needing to reason about the ratio floor too.
  const uids = Array.from({ length: 150 }, (_, i) => `source:doc-${String(i).padStart(4, "0")}`);
  return buildDriveRemovalPlan({ storedFamilies: uids, policyCandidates: uids });
}

function refusalMessage(plan, options) {
  try {
    assertDriveRemovalPlanSafe(plan, null, options);
    return null;
  } catch (error) {
    assert.ok(error instanceof DriveRemovalReviewRequired, String(error?.stack || error));
    return error.message;
  }
}

/* ------------------------------------------------------- the primitive */

{
  const plan = oversizedPlan();
  check("the fixture plan is actually oversized", plan.tooLarge === true, JSON.stringify(plan));
  check("the fixture plan targets all 150 of 150 stored documents",
    plan.total === 150 && plan.stored === 150, JSON.stringify(plan));

  const driveMessage = refusalMessage(plan, undefined);
  check("with no sourceLabel, the review-required message still says Drive (the default is unchanged)",
    /^Drive cleanup would remove 150 of 150 stored documents \(100\.0%\)\./.test(driveMessage || ""),
    driveMessage);

  const folderMessage = refusalMessage(plan, { sourceLabel: "Folder" });
  check("a local folder's review-required message says Folder cleanup, not Drive cleanup",
    /^Folder cleanup would remove 150 of 150 stored documents \(100\.0%\)\./.test(folderMessage || ""),
    folderMessage);

  check("an approved fingerprint still clears the same local-folder plan",
    assertDriveRemovalPlanSafe(plan, plan.fingerprint, { sourceLabel: "Folder" }) === plan);
}

/* ----------------------------------------------------------- the wiring */
/* Prove brain.mjs actually passes the label, not just that the underlying
   primitive supports one. */

{
  const cli = readFileSync(new URL("../brain.mjs", import.meta.url), "utf8");
  const localStart = cli.indexOf("export async function cmdIngestLocal(");
  const localEnd = cli.indexOf("\nexport function validateForgetReceipt", localStart);
  assert.notEqual(localStart, -1, "local folder ingest must exist");
  assert.ok(localEnd > localStart, "local folder ingest must be inspectable");
  const local = cli.slice(localStart, localEnd);
  check(
    "cmdIngestLocalRun labels its removal review \"Folder\"",
    local.includes('assertDriveRemovalPlanSafe(localRemovalPlan, localRemovalApproval, { sourceLabel: "Folder" });'),
    "expected call site not found in the local ingest lane",
  );

  const driveCallSite = 'assertDriveRemovalPlanSafe(driveRemovalPlan, removalApproval);';
  check(
    "the real Drive lane still calls the guard with no override, so it keeps the \"Drive\" default",
    cli.includes(driveCallSite),
    "drive call site not found, or it now overrides the label",
  );
}

console.log(`\n${ran - fail}/${ran} checks passed`);
if (fail) process.exit(1);
