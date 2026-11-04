import assert from "node:assert/strict";
import test from "node:test";
import { buildDriveRemovalPlan, DriveRemovalReviewRequired } from "../operations/drive-removal-plan.mjs";
import { createIngestRemovalReview, removalDigest } from "../operations/ingest-removal-plan.mjs";
import { canAutoApplyRemoval, removalOwnerSentence, removalReviewFacts } from "../operations/load-removal-review.mjs";
import { REMOVAL_CAUSES } from "../operations/removal-causes.mjs";

async function fixture(causes, { members = {}, legacy = false } = {}) {
  const ids = causes.map((_, i) => `gmail:item${i}`);
  const storedFamilies = Array.from({ length: Math.max(100, causes.length * 100) }, (_, i) => `gmail:item${i}`);
  const sourcePlan = buildDriveRemovalPlan({ storedFamilies, vanishedCandidates: ids,
    ...(legacy ? {} : { targetCauses: Object.fromEntries(ids.map((uid, i) => [uid, causes[i]])) }) });
  const state = { done: {}, skipped: {} };
  const stored = new Set(ids.flatMap(uid => members[uid] || [uid]));
  const calls = { preview: 0, apply: 0, saves: 0 };
  let marker = { instance: "fixture", runtime: "fixture", nonce: "before", generation: 1 };
  const review = createIngestRemovalReview({ state, source: "gmail", kind: "gmail",
    manifest: {}, manifestPath: "fixture/manifest.json", base: "https://fixture.invalid",
    runtime: () => "fixture", saveState() { calls.saves++; },
    request: async ({ body }) => {
      calls[body.action]++;
      if (body.marker) assert.deepEqual(body.marker, marker);
      if (body.action === "preview") {
        const targets = [...new Set(body.families.flatMap(family => members[family.base_doc_uid] || [family.base_doc_uid]))]
          .filter(uid => stored.has(uid)).sort();
        return { marker, targets, documents: targets.length };
      }
      assert.ok(state.ingest_removal_plan.targets.length > 0);
      for (const uid of body.targets) assert.equal(stored.delete(uid), true);
      marker = { ...marker, nonce: "after", generation: marker.generation + 1 };
      return { marker, documents: body.targets.length };
    } });
  let failure;
  await assert.rejects(review.finish({ sourcePlan }), error => {
    failure = error;
    return error instanceof DriveRemovalReviewRequired;
  });
  assert.ok(calls.preview > 0 && calls.saves > 0);
  const plan = state.ingest_removal_plan;
  assert.ok(plan.targets.length > 0, "a nonempty exact plan reached the decision");
  const { fingerprint, ...payload } = plan;
  assert.equal(removalDigest(payload), fingerprint);
  return { review, state, plan, calls, stored, facts: removalReviewFacts(failure.removal_review, "gmail") };
}

for (const cause of [...REMOVAL_CAUSES, "unrecognized", null]) {
  test(`exact automatic apply and owner wording use the per-target cause: ${cause}`, async () => {
    const f = await fixture([cause]);
    const explicit = cause === "explicit_deletion";
    assert.equal(canAutoApplyRemoval(f.facts, "gmail", "gmail"), explicit);
    assert.equal(removalOwnerSentence(f.facts).includes("deleted"), explicit);
    assert.ok(!removalOwnerSentence(f.facts).includes("you deleted"));
    if (explicit) {
      assert.equal((await f.review.apply(f.plan.fingerprint, undefined, { automatic: true })).removed, 1);
      assert.equal(f.calls.apply, 1);
    } else {
      await assert.rejects(f.review.apply(f.plan.fingerprint, undefined, { automatic: true }), /explicit deletion evidence/);
      assert.equal(f.calls.apply, 0);
      assert.equal(f.stored.size, 1);
      // The owner's separate exact approval remains available for held causes.
      assert.equal((await f.review.apply(f.plan.fingerprint)).removed, 1);
      assert.equal(f.calls.apply, 1);
    }
  });
}

test("causes change both the source fingerprint and exact saved fingerprint", async () => {
  const a = await fixture(["explicit_deletion"]);
  const b = await fixture(["unknown"]);
  assert.notEqual(a.plan.sourcePlan.fingerprint, b.plan.sourcePlan.fingerprint);
  assert.notEqual(a.plan.fingerprint, b.plan.fingerprint);
  a.plan.targetCauses["gmail:item0"] = "unknown";
  await assert.rejects(a.review.apply(a.plan.fingerprint, undefined, { automatic: true }), /Removal plan changed/);
  assert.equal(a.calls.apply, 0);
});

test("mixed evidence stays held even inside the small limits", async () => {
  const f = await fixture(["explicit_deletion", "permission_or_visibility"]);
  await assert.rejects(f.review.apply(f.plan.fingerprint, undefined, { automatic: true }), /explicit deletion evidence/);
  assert.equal(f.calls.apply, 0);
  assert.deepEqual(f.plan.targetCauses, { "gmail:item0": "explicit_deletion", "gmail:item1": "permission_or_visibility" });
});

test("legacy saved plans and missing adapter evidence remain held", async () => {
  const f = await fixture(["explicit_deletion"], { legacy: true });
  assert.equal(f.facts.removal_causes.unknown, 1);
  delete f.plan.targetCauses;
  const { fingerprint: _old, ...payload } = f.plan;
  f.plan.fingerprint = removalDigest(payload);
  await assert.rejects(f.review.apply(f.plan.fingerprint, undefined, { automatic: true }), /explicit deletion evidence/);
  assert.equal(f.calls.apply, 0);
});

test("physical family members inherit evidence through authenticated previews", async () => {
  const f = await fixture(["explicit_deletion", "window_exit"], {
    members: { "gmail:item0": ["gmail:item0#part1of2", "gmail:item0#part2of2"] },
  });
  assert.equal(f.calls.preview, 2, "different causes use separate authenticated batches");
  assert.deepEqual(f.plan.targetCauses, {
    "gmail:item0#part1of2": "explicit_deletion", "gmail:item0#part2of2": "explicit_deletion", "gmail:item1": "window_exit",
  });
  assert.equal(f.facts.removal_causes.explicit_deletion, 2);
  assert.equal(f.facts.removal_causes.window_exit, 1);
  await assert.rejects(f.review.apply(f.plan.fingerprint, undefined, { automatic: true }), /explicit deletion evidence/);
  assert.equal(f.calls.apply, 0);
});

test("overlapping family evidence fails closed", async () => {
  const f = await fixture(["explicit_deletion", "window_exit"], {
    members: { "gmail:item0": ["gmail:shared"], "gmail:item1": ["gmail:shared"] },
  });
  assert.equal(f.calls.preview, 2);
  assert.equal(f.plan.targetCauses["gmail:shared"], "unknown");
  assert.equal(f.facts.removal_causes.unknown, 1);
  await assert.rejects(f.review.apply(f.plan.fingerprint, undefined, { automatic: true }), /explicit deletion evidence/);
  assert.equal(f.calls.apply, 0);
});
