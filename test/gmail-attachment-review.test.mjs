import assert from "node:assert/strict";
import test from "node:test";
import * as attachmentReview from "../operations/gmail-attachment-review.mjs";
import { ingestPlanStore } from "./helpers/ingest-plan-store.mjs";

const { createGmailAttachmentReview } = attachmentReview;

function fixture({ excluded = false, readback = false } = {}) {
  const store = ingestPlanStore();
  store.put("gmail:report-one");
  store.put("gmail:report-one#part1of2", { part: 1, part_count: 2, part_of: "report-one" });
  store.put("gmail:ordinary");
  const hash = "gmail-extraction-2:accepted-one";
  const state = {
    version: 1, done: { "gmail:report-one": hash }, skipped: {}, history_id: "history-one",
    gmail_attachment_backfill: {
      schema_version: 1, extraction_version: 2, query: "synthetic-candidate-query",
      scanner_fingerprint: "scanner-one", complete: false,
      pending_ids: ["report-one"], next_page_token: null,
    },
  };
  const manifest = { client: { slug: "fixture" }, brain: { domain: "fixture.invalid" } };
  let runtime = "runtime-one";
  let saves = 0;
  let leaseHeld = true;
  const request = async input => {
    input.beforeAttempt?.();
    if (input.body.action === "preview" && excluded) return {
      marker: { instance: "fixture", runtime: "runtime-one", nonce: "fixture", generation: 1 },
      targets: [], documents: 0, excluded_documents: 1,
    };
    const response = await store.request(input);
    if (readback && store.calls.apply && input.body.action === "preview") {
      return { ...response, targets: ["gmail:report-one#part1of2"], documents: 1 };
    }
    return response;
  };
  const makeReview = () => createGmailAttachmentReview({
    state, source: "gmail", manifest, manifestPath: "/fixture/manifest.json",
    base: "https://fixture.invalid", request, runtime: () => runtime,
    assertOwned: () => { if (!leaseHeld) throw new Error("synthetic lease lost"); },
    saveState: () => { saves++; }, onProgress: () => {},
  });
  const review = makeReview();
  const acceptedPlan = {
    stateKey: "gmail:report-one", hash, expectedParts: 1,
    base_doc_uid: "gmail:report-one", keep_doc_uids: ["gmail:report-one"], family_kind: "structural",
  };
  const reviewState = () => state.gmail_attachment_backfill.review;
  const stop = async () => {
    review.remember([acceptedPlan]);
    await assert.rejects(review.finish(), { code: "SAFETY_REVIEW_REQUIRED" });
    assert.deepEqual(reviewState().ingest_removal_plan.targets, ["gmail:report-one#part1of2"]);
    return reviewState().ingest_removal_plan.fingerprint;
  };
  return { state, store, manifest, review, acceptedPlan, reviewState, makeReview, stop,
    setRuntime: value => { runtime = value; }, saves: () => saves,
    loseLease: () => { leaseHeld = false; }, close: () => store.db.close() };
}

test("control: candidate cleanup needs exact approval and verified readback", async () => {
  const f = fixture();
  try {
    const fingerprint = await f.stop();
    assert.equal(f.store.calls.apply, 0);
    assert.equal(f.store.calls.inventory, 0);
    assert.equal(f.state.ingest_removal_plan, undefined);
    assert.equal(f.state.ingest_pending_families, undefined);
    const result = await f.review.apply(fingerprint);
    assert.equal(result.removed, 1);
    assert.equal(result.cursor_advanced, false);
    assert.deepEqual(f.store.uids(), ["gmail:ordinary", "gmail:report-one"]);
    assert.equal(f.state.history_id, "history-one");
    assert.equal(f.reviewState().ingest_removal_plan, undefined);
  } finally { f.close(); }
});

test("control: an exact empty preview settles candidate cleanup without growing its receipt map", async () => {
  const f = fixture();
  try {
    f.store.db.prepare("DELETE FROM documents WHERE doc_uid = ?").run("gmail:report-one#part1of2");
    f.review.remember([f.acceptedPlan]);
    assert.equal(f.review.pending(), true);
    await f.review.finish();
    assert.equal(f.review.pending(), false);
    assert.equal(f.review.fingerprint, null);
    assert.deepEqual(f.reviewState().done, {});
    assert.equal(f.state.done["gmail:report-one"], f.acceptedPlan.hash);
    assert.equal(f.store.calls.apply, 0);
    assert.equal(f.store.calls.inventory, 0);
  } finally { f.close(); }
});

test("normal history changes do not invalidate a candidate cleanup approval", async () => {
  const f = fixture();
  try {
    const fingerprint = await f.stop();
    f.state.history_id = "history-two";
    f.state.done["gmail:ordinary"] = "ordinary-new-revision";
    f.state.skipped["gmail:other"] = "fixed exclusion";
    const result = await f.makeReview().apply(fingerprint);
    assert.equal(result.removed, 1);
    assert.equal(f.state.history_id, "history-two");
    assert.equal(f.state.done["gmail:ordinary"], "ordinary-new-revision");
  } finally { f.close(); }
});

for (const change of ["candidate", "candidate-skip", "manifest", "runtime", "query", "scanner", "extraction", "targets", "lease"]) {
  test(`candidate cleanup refuses changed ${change} evidence before removal`, async () => {
    const f = fixture();
    try {
      const fingerprint = await f.stop();
      if (change === "candidate") f.state.done["gmail:report-one"] = "gmail-extraction-2:changed";
      if (change === "candidate-skip") f.state.skipped["gmail:report-one"] = "fixed exclusion";
      if (change === "manifest") f.manifest.brain.domain = "other.invalid";
      if (change === "runtime") f.setRuntime("runtime-two");
      if (change === "query") f.state.gmail_attachment_backfill.query = "other-query";
      if (change === "scanner") f.state.gmail_attachment_backfill.scanner_fingerprint = "scanner-two";
      if (change === "extraction") f.state.gmail_attachment_backfill.extraction_version = 3;
      if (change === "targets") f.store.put("gmail:report-one#part2of2", { part: 2, part_count: 2, part_of: "report-one" });
      if (change === "lease") f.loseLease();
      await assert.rejects(f.review.apply(fingerprint));
      assert.equal(f.store.calls.apply, 0);
      assert.ok(f.reviewState().ingest_removal_plan);
      assert.equal(f.state.history_id, "history-one");
    } finally { f.close(); }
  });
}

test("unverified overlapping documents retain the candidate review", async () => {
  const f = fixture({ excluded: true });
  try {
    f.review.remember([f.acceptedPlan]);
    await assert.rejects(f.review.finish(), { code: "SAFETY_REVIEW_REQUIRED" });
    assert.ok(f.reviewState().ingest_pending_families?.["gmail:report-one"]);
    assert.equal(f.state.gmail_attachment_backfill.complete, false);
    assert.equal(f.store.calls.apply, 0);
  } finally { f.close(); }
});

test("incomplete cleanup readback retains the saved candidate plan", async () => {
  const f = fixture({ readback: true });
  try {
    const fingerprint = await f.stop();
    await assert.rejects(f.review.apply(fingerprint), { code: "SAFETY_REVIEW_REQUIRED" });
    assert.ok(f.reviewState().ingest_removal_plan);
    assert.equal(f.state.gmail_attachment_backfill.complete, false);
    assert.equal(f.state.history_id, "history-one");
  } finally { f.close(); }
});

test("control: candidate recovery validates current review evidence without changing it", async () => {
  const f = fixture();
  try {
    await f.stop();
    const before = structuredClone(f.state);
    const recovered = attachmentReview.gmailAttachmentReviewCandidates({ state: f.state, source: "gmail",
      query: "synthetic-candidate-query", scannerFingerprint: "scanner-one", extractionVersion: 2 });
    assert.deepEqual(recovered, { ids: ["report-one"], changed: false });
    assert.deepEqual(f.state, before);
    assert.equal(f.store.calls.apply, 0);
  } finally { f.close(); }
});

for (const change of ["candidate", "skip", "query", "scanner", "extraction"]) {
  test(`candidate recovery requeues exact retained identities after changed ${change}`, async () => {
    const f = fixture();
    try {
      await f.stop();
      if (change === "candidate") f.state.done["gmail:report-one"] = "gmail-extraction-2:changed";
      if (change === "skip") f.state.skipped["gmail:report-one"] = "fixed exclusion";
      const before = structuredClone(f.state);
      const recovered = attachmentReview.gmailAttachmentReviewCandidates({ state: f.state, source: "gmail",
        query: change === "query" ? "changed-candidate-query" : "synthetic-candidate-query",
        scannerFingerprint: change === "scanner" ? "scanner-two" : "scanner-one",
        extractionVersion: change === "extraction" ? 3 : 2 });
      assert.deepEqual(recovered, { ids: ["report-one"], changed: true });
      assert.deepEqual(f.state, before);
      assert.equal(f.store.calls.apply, 0);
    } finally { f.close(); }
  });
}

for (const corrupt of ["schema", "source", "empty-keep", "hash", "plan", "binding"]) {
  test(`candidate recovery refuses malformed ${corrupt} intent without erasing it`, async () => {
    const f = fixture();
    try {
      await f.stop();
      const review = f.reviewState();
      if (corrupt === "schema") review.version = 9;
      if (corrupt === "source") review.ingest_pending_families["gmail:report-one"].family.base_doc_uid = "other:report-one";
      if (corrupt === "empty-keep") review.ingest_pending_families["gmail:report-one"].family.keep_doc_uids = [];
      if (corrupt === "hash") review.ingest_pending_families["gmail:report-one"].hash = "different";
      if (corrupt === "plan") review.ingest_removal_plan.targets.push("gmail:other");
      if (corrupt === "binding") review.ingest_removal_plan.state = "f".repeat(64);
      const before = structuredClone(f.state);
      assert.throws(() => attachmentReview.gmailAttachmentReviewCandidates({ state: f.state, source: "gmail" }),
        { code: "SAFETY_REVIEW_REQUIRED" });
      assert.deepEqual(f.state, before);
      assert.equal(f.store.calls.apply, 0);
    } finally { f.close(); }
  });
}

test("candidate recovery validates unpreviewed selectors and accepts a settled empty review", () => {
  const f = fixture();
  try {
    f.review.remember([f.acceptedPlan]);
    assert.deepEqual(attachmentReview.gmailAttachmentReviewCandidates({ state: f.state, source: "gmail" }),
      { ids: ["report-one"], changed: false });
    f.reviewState().ingest_pending_families["gmail:report-one"].family.keep_doc_uids = ["gmail:report-one#part3of2"];
    const before = structuredClone(f.state);
    assert.throws(() => attachmentReview.gmailAttachmentReviewCandidates({ state: f.state, source: "gmail" }),
      { code: "SAFETY_REVIEW_REQUIRED" });
    assert.deepEqual(f.state, before);
    assert.deepEqual(attachmentReview.gmailAttachmentReviewCandidates({ state: {}, source: "gmail" }),
      { ids: [], changed: false });
    assert.deepEqual(attachmentReview.gmailAttachmentReviewCandidates({ state: {
      gmail_attachment_backfill: { review: { version: 1, done: {}, skipped: {} } },
    }, source: "gmail" }), { ids: [], changed: false });
  } finally { f.close(); }
});
