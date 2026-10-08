/**
 * From 0.4.11 every ingest lane uses createIngestRemovalReview, labelled
 * "Source". A local folder must never read "Drive". The underlying aggregate
 * primitive still defaults to "Drive" and accepts an explicit "Folder" label.
 * Every identifier below belongs to a synthetic fixture.
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
  check("the primitive accepts an explicit Folder label for its review-required message",
    /^Folder cleanup would remove 150 of 150 stored documents \(100\.0%\)\./.test(folderMessage || ""),
    folderMessage);

  check("an approved fingerprint still clears the same local-folder plan",
    assertDriveRemovalPlanSafe(plan, plan.fingerprint, { sourceLabel: "Folder" }) === plan);
}

/* ----------------------------------------------------------- the wiring */
/* 0.4.11 plan-first contract (slice 41ca8b0b): no ingest lane calls the
   aggregate guard directly any more. Every lane hands its aggregate plan to
   the shared removal review (operations/ingest-removal-plan.mjs), whose ONE
   guard call names the source generically ("Source"), so no lane can fall
   back to the "Drive" default. Prove the wiring AND the text an owner reads. */

{
  const cli = readFileSync(new URL("../brain.mjs", import.meta.url), "utf8");
  const shared = readFileSync(new URL("../operations/ingest-removal-plan.mjs", import.meta.url), "utf8");
  const localStart = cli.indexOf("export async function cmdIngestLocal(");
  const localEnd = cli.indexOf("\nexport function validateForgetReceipt", localStart);
  assert.notEqual(localStart, -1, "local folder ingest must exist");
  assert.ok(localEnd > localStart, "local folder ingest must be inspectable");
  const local = cli.slice(localStart, localEnd);
  check(
    "cmdIngestLocalRun hands its aggregate plan to the shared removal review",
    local.includes('await removalReview.finish({ sourcePlan: localRemovalPlan, familyKind: "hybrid" });'),
    "expected removal-review call site not found in the local ingest lane",
  );
  check(
    "the real Drive lane hands its aggregate plan to the same shared removal review",
    /await removalReview\.finish\(\{\s*sourcePlan: driveRemovalPlan,/.test(cli),
    "drive removal-review call site not found",
  );
  check(
    "no lane in brain.mjs calls the aggregate guard directly, so none can fall back to the \"Drive\" default",
    !/\bassertDriveRemovalPlanSafe\(/.test(cli),
    "a direct assertDriveRemovalPlanSafe( call is back in brain.mjs",
  );
  const guardCalls = shared.match(/\bassertDriveRemovalPlanSafe\([\s\S]*?\);/g) || [];
  check(
    "the shared removal review calls the guard exactly once, and labels it \"Source\"",
    guardCalls.length === 1 && guardCalls[0].includes('{ sourceLabel: "Source" }'),
    JSON.stringify(guardCalls),
  );
}

/* ------------------------------------------- what the owner actually reads */

{
  const { createIngestRemovalReview } = await import("../operations/ingest-removal-plan.mjs");
  const { ingestPlanStore } = await import("./helpers/ingest-plan-store.mjs");
  for (const [source, familyKind] of [["upload", "hybrid"], ["drive", "structural"]]) {
    const store = ingestPlanStore();
    try {
      const uids = Array.from({ length: 20 }, (_, i) => `${source}:doc-${String(i).padStart(4, "0")}`);
      for (const uid of uids) store.put(uid);
      const state = { version: 1, done: {}, skipped: {} };
      const review = createIngestRemovalReview({
        state, saveState() {}, source, manifest: {}, manifestPath: "/fixture/manifest.json",
        base: "https://fixture.invalid", request: store.request, runtime: () => "fixture-runtime",
      });
      // 5 of 20 (25%) is over the 10% ratio, so the aggregate review is required.
      const sourcePlan = buildDriveRemovalPlan({ storedFamilies: uids, vanishedCandidates: uids.slice(0, 5) });
      check(`${source}: the fixture plan is oversized`, sourcePlan.tooLarge === true, JSON.stringify(sourcePlan));

      let stop = null;
      try { await review.finish({ sourcePlan, familyKind }); } catch (error) { stop = error; }
      check(`${source}: the ingest run stops and names its own source, not Drive's default`,
        stop instanceof DriveRemovalReviewRequired &&
          stop.message.startsWith(`Source ${source}: 5 stored document(s) would be removed`),
        stop?.message);
      check(`${source}: the stop asks for the additional aggregate approval by exact fingerprint`,
        (stop?.message || "").includes(`--approve-removals ${sourcePlan.fingerprint}`), stop?.message);

      let refusal = null;
      try { await review.apply(state.ingest_removal_plan?.fingerprint); } catch (error) { refusal = error; }
      check(`${source}: applying without that approval says "Source cleanup", never the "Drive" default`,
        refusal instanceof DriveRemovalReviewRequired &&
          /^Source cleanup would remove 5 of 20 stored documents \(25\.0%\)\./.test(refusal.message),
        refusal?.message);
      check(`${source}: nothing was removed without the aggregate approval`, store.calls.apply === 0 && store.calls.preview > 0 && state.ingest_removal_plan?.targets.length === 5,
        JSON.stringify(store.calls));
      await review.apply(state.ingest_removal_plan?.fingerprint, sourcePlan.fingerprint);
      check(`${source}: exact aggregate approval removes only the five reviewed targets`,
        store.calls.apply === 1 && store.uids().length === 15 &&
          uids.slice(0, 5).every((uid) => !store.uids().includes(uid)));
      if (source === "upload") {
        check("a local folder's removal review never says Drive anywhere",
          !/drive/i.test(`${stop?.message}\n${refusal?.message}`), `${stop?.message}\n${refusal?.message}`);
      }
    } finally { store.db.close(); }
  }
}

console.log(`\n${ran - fail}/${ran} checks passed`);
if (fail) process.exit(1);
