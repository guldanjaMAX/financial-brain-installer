import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import worker from "../worker/src/index.js";
import { splitOversized, MAX_DOC_CHARS } from "../ingest/envelope-batching.mjs";
import { createIngestRemovalReview, applyApprovedProvenanceFamily } from "../operations/ingest-removal-plan.mjs";
import { buildDriveRemovalPlan, DriveRemovalReviewRequired } from "../operations/drive-removal-plan.mjs";
import { renderCliCommands } from "../operations/cli-guidance.mjs";
import { ingestPlanStore } from "./helpers/ingest-plan-store.mjs";
import { previewIngestRemovals, applyIngestRemovals } from "../worker/src/lib/ingest-removal-plan.js";

function fixture(count = 20, options = {}) {
  const store = ingestPlanStore();
  for (let index = 0; index < count; index++) store.put(`drive:item${index}`);
  const state = { version: 1, done: {}, skipped: {} };
  const manifest = { safety: { ocr: { enabled: false } } };
  let runtime = "runtime-one";
  let saves = 0;
  const review = createIngestRemovalReview({ state, saveState: () => { saves++; },
    source: "drive", manifest, manifestPath: "/fixture/manifest.json",
    base: "https://fixture.invalid", request: store.request, runtime: () => runtime, ...options });
  const plan = () => buildDriveRemovalPlan({ storedFamilies: store.uids(), vanishedCandidates: ["drive:item0"] });
  const stop = async () => {
    await assert.rejects(review.finish({ sourcePlan: plan() }), { code: "SAFETY_REVIEW_REQUIRED" });
    assert.deepEqual(state.ingest_removal_plan.targets, ["drive:item0"]);
    assert.ok(store.calls.preview > 0);
    return state.ingest_removal_plan.fingerprint;
  };
  return { store, state, manifest, review, stop, setRuntime: (next) => { runtime = next; }, saves: () => saves };
}

test("the review command names an exact plan without disclosing target identities", async () => {
  const f = fixture();
  try {
    let stopped;
    try { await f.stop(); } catch (error) { throw error; }
    const fingerprint = f.state.ingest_removal_plan.fingerprint;
    try { await f.review.finish({ sourcePlan: f.state.ingest_removal_plan.sourcePlan }); }
    catch (error) { stopped = error; }
    assert.ok(renderCliCommands(stopped.message).includes(renderCliCommands(
      `brain ingest <manifest> --source drive --apply-removals ${fingerprint}`,
    )));
    assert.doesNotMatch(stopped.message, /item0|\/fixture\/|fixture\.invalid/);
    assert.ok(f.saves() >= 2);
    await f.review.apply(fingerprint);
    assert.equal(f.store.calls.apply, 1);
    assert.equal(f.store.uids().includes("drive:item0"), false);
  } finally { f.store.db.close(); }
});

for (const drift of ["fingerprint", "state", "policy", "runtime", "inventory", "worker-runtime"]) {
  test(`${drift} drift refuses a nonempty plan; a fresh matching plan applies`, async () => {
    const f = fixture();
    try {
      const fingerprint = await f.stop();
      if (drift === "state") f.state.done.other = "changed";
      if (drift === "policy") f.manifest.safety.ocr.enabled = true;
      if (drift === "runtime") f.setRuntime("runtime-two");
      if (drift === "inventory") f.store.put("drive:item1", {}, "new-revision");
      if (drift === "worker-runtime") f.store.env.INGEST_VERSION.id = "fixture-runtime-two";
      await assert.rejects(f.review.apply(drift === "fingerprint" ? "f".repeat(64) : fingerprint));
      assert.equal(f.store.calls.apply, 0);
      assert.ok(f.store.uids().includes("drive:item0"));
      const fresh = await f.stop();
      await f.review.apply(fresh);
      assert.equal(f.store.calls.apply, 1);
      assert.equal(f.store.uids().includes("drive:item0"), false);
    } finally { f.store.db.close(); }
  });
}

test("the original over-ten-percent refusal remains an additional gate", async () => {
  const f = fixture(2);
  try {
    const fingerprint = await f.stop();
    assert.equal(f.state.ingest_removal_plan.sourcePlan.tooLarge, true);
    await assert.rejects(f.review.apply(fingerprint), { code: "SAFETY_REVIEW_REQUIRED" });
    assert.equal(f.store.calls.apply, 0);
    await f.review.apply(fingerprint, f.state.ingest_removal_plan.sourcePlan.fingerprint);
    assert.equal(f.store.calls.apply, 1);
  } finally { f.store.db.close(); }
});

test("a writer between preflight and DELETE is fenced inside the transaction", async () => {
  const store = ingestPlanStore();
  try {
    store.put("gmail:original");
    const families = [{ base_doc_uid: "gmail:original", keep_doc_uids: [] }];
    const plan = await previewIngestRemovals(store.env, { families });
    assert.deepEqual(plan.targets, ["gmail:original"]);
    let reached = 0;
    store.beforeBatch(() => { reached++; store.put("gmail:concurrent"); });
    await assert.rejects(applyIngestRemovals(store.env, plan), /malformed JSON/);
    assert.equal(reached, 1);
    assert.ok(store.uids().includes("gmail:original"));
    store.beforeBatch(null);
    const fresh = await previewIngestRemovals(store.env, { families });
    const receipt = await applyIngestRemovals(store.env, fresh);
    assert.equal(receipt.documents, 1);
    assert.deepEqual(store.uids(), ["gmail:concurrent"]);
  } finally { store.db.close(); }
});

test("deferred replacement families survive restart and remove only obsolete members", async () => {
  const f = fixture();
  try {
    f.store.put("message:old", { family_of: "drive:export" });
    f.store.put("message:current", { family_of: "drive:export" });
    f.state.done.export = "accepted";
    f.review.remember([{ stateKey: "export", hash: "accepted", base_doc_uid: "drive:export",
      keep_doc_uids: ["message:current"], family_kind: "declared" }]);
    await assert.rejects(f.review.finish(), { code: "SAFETY_REVIEW_REQUIRED" });
    assert.deepEqual(f.state.ingest_removal_plan.targets, ["message:old"]);
    const reloadedState = JSON.parse(JSON.stringify(f.state));
    const reloaded = createIngestRemovalReview({ state: reloadedState, saveState() {},
      source: "drive", manifest: f.manifest, manifestPath: "/fixture/manifest.json",
      base: "https://fixture.invalid", request: f.store.request, runtime: () => "runtime-one" });
    await reloaded.apply(reloadedState.ingest_removal_plan.fingerprint);
    assert.ok(f.store.uids().includes("message:current"));
    assert.equal(f.store.uids().includes("message:old"), false);
  } finally { f.store.db.close(); }
});

test("zero-removal replacement commits without a decision and makes no delete call", async () => {
  const f = fixture();
  try {
    f.state.done.item0 = "accepted";
    f.review.remember([{ stateKey: "item0", hash: "accepted", base_doc_uid: "drive:item0",
      keep_doc_uids: ["drive:item0"], family_kind: "structural" }]);
    await f.review.finish();
    assert.ok(f.store.calls.preview > 0);
    assert.equal(f.store.calls.apply, 0);
    assert.equal(f.state.ingest_removal_plan, undefined);
    assert.equal(f.store.uids().length, 20);
  } finally { f.store.db.close(); }
});

test("the authenticated route previews without mutation, refuses drift, and honors the upgrade pause", async () => {
  const store = ingestPlanStore();
  const key = randomBytes(32).toString("hex");
  store.env.ADMIN_KEY = key;
  const route = (body, authorized = true) => worker.fetch(new Request("https://fixture.invalid/api/admin/brain/ingest-removal-plan", {
    method: "POST", headers: { "Content-Type": "application/json", ...(authorized ? { "X-Admin-Key": key } : {}) },
    body: JSON.stringify(body),
  }), store.env, { waitUntil() {} });
  try {
    store.put("drive:original");
    const families = [{ base_doc_uid: "drive:original", keep_doc_uids: [] }];
    assert.equal((await route({ action: "preview", families }, false)).status, 401);
    const response = await route({ action: "preview", families });
    assert.equal(response.status, 200);
    const plan = await response.json();
    assert.deepEqual(plan.targets, ["drive:original"]);
    assert.equal(store.calls.batches, 0);
    store.env.VECTOR_DRAIN_MODE = "paused-for-upgrade";
    assert.equal((await route({ action: "apply", targets: plan.targets, marker: plan.marker })).status, 503);
    assert.ok(store.uids().includes("drive:original"));
    delete store.env.VECTOR_DRAIN_MODE;
    store.put("drive:neighbor");
    assert.equal((await route({ action: "apply", targets: plan.targets, marker: plan.marker })).status, 409);
    const fresh = await (await route({ action: "preview", families })).json();
    assert.equal((await route({ action: "apply", targets: fresh.targets, marker: fresh.marker })).status, 200);
    assert.deepEqual(store.uids(), ["drive:neighbor"]);
  } finally { store.db.close(); }
});

test("multiple bounded groups delete only their named targets and read back the final generation", async () => {
  const f = fixture(120);
  try {
    const sourcePlan = buildDriveRemovalPlan({ storedFamilies: f.store.uids(),
      vanishedCandidates: f.store.uids().slice(0, 101) });
    await assert.rejects(f.review.finish({ sourcePlan }), { code: "SAFETY_REVIEW_REQUIRED" });
    const plan = f.state.ingest_removal_plan;
    assert.equal(plan.targets.length, 101);
    const kept = f.store.uids().filter((uid) => !plan.targets.includes(uid));
    await assert.rejects(f.review.apply(plan.fingerprint), { code: "SAFETY_REVIEW_REQUIRED" });
    assert.equal(f.store.calls.apply, 0);
    await f.review.apply(plan.fingerprint, sourcePlan.fingerprint);
    assert.equal(f.store.calls.apply, 3);
    assert.deepEqual(f.store.uids(), kept);
  } finally { f.store.db.close(); }
});


test("an expired source observation refuses its nonempty plan and a fresh observation applies", async () => {
  const anchor = Date.parse("2026-10-07T00:00:00.000Z");
  let now = anchor;
  const f = fixture(20, { now: () => now });
  try {
    const sourcePlan = buildDriveRemovalPlan({ storedFamilies: f.store.uids(), vanishedCandidates: ["drive:item0"] });
    const expiresAt = new Date(anchor + 24 * 60 * 60 * 1000).toISOString();
    await assert.rejects(f.review.finish({ sourcePlan, expiresAt }), { code: "SAFETY_REVIEW_REQUIRED" });
    assert.deepEqual(f.state.ingest_removal_plan.targets, ["drive:item0"]);
    now = Date.parse(expiresAt);
    await assert.rejects(f.review.apply(f.state.ingest_removal_plan.fingerprint), /observation expired/);
    assert.equal(f.store.calls.apply, 0);
    await f.stop();
    await f.review.apply(f.state.ingest_removal_plan.fingerprint);
    assert.equal(f.store.calls.apply, 1);
  } finally { f.store.db.close(); }
});

test("equal generation counters from diverged restore histories are not interchangeable", async () => {
  const f = fixture();
  try {
    const fingerprint = await f.stop();
    f.store.db.exec("UPDATE ingest_removal_generation SET nonce = lower(hex(randomblob(16))) WHERE id = 1");
    await assert.rejects(f.review.apply(fingerprint), /changed/);
    assert.equal(f.store.calls.apply, 0);
    assert.ok(f.store.uids().includes("drive:item0"));
    await f.review.apply(await f.stop());
    assert.equal(f.store.calls.apply, 1);
  } finally { f.store.db.close(); }
});


test("a lost successful apply response preserves the checkpoint and cannot replay its old approval", async () => {
  const f = fixture();
  try {
    const fingerprint = await f.stop();
    let lost = false;
    const review = createIngestRemovalReview({ state: f.state, saveState() {}, source: "drive",
      manifest: f.manifest, manifestPath: "/fixture/manifest.json", base: "https://fixture.invalid",
      runtime: () => "runtime-one", request: async (input) => {
        const result = await f.store.request(input);
        if (input.body.action === "apply") { lost = true; throw new Error("fixture lost response"); }
        return result;
      } });
    await assert.rejects(review.apply(fingerprint), /lost response/);
    assert.equal(lost, true);
    assert.equal(f.store.calls.apply, 1);
    assert.equal(f.state.ingest_removal_plan.fingerprint, fingerprint);
    await assert.rejects(f.review.apply(fingerprint), /changed/);
    assert.equal(f.store.calls.apply, 1);
    await f.review.finish({ sourcePlan: buildDriveRemovalPlan({ storedFamilies: f.store.uids(), vanishedCandidates: ["drive:item0"] }) });
    assert.equal(f.state.ingest_removal_plan, undefined);
    assert.equal(f.store.uids().length, 19);
  } finally { f.store.db.close(); }
});


test("runtime binding works in a packed installation without a lockfile and covers root modules", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "removal-runtime-")));
  try {
    for (const folder of ["operations", "connectors", "ingest", "worker/src/lib"]) mkdirSync(join(root, folder), { recursive: true });
    for (const path of ["operations/ingest-removal-plan.mjs", "operations/drive-removal-plan.mjs",
      "operations/cli-guidance.mjs", "operations/command-display.mjs", "worker/src/lib/stored-family-identity.js"]) {
      const bytes = readFileSync(new URL(`../${path}`, import.meta.url));
      writeFileSync(join(root, path), bytes);
      console.log(`copied-runtime-source ${path} sha256=${createHash("sha256").update(bytes).digest("hex")}`);
    }
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", dependencies: {},
      files: ["brain.mjs", "support-recovery.mjs", "operations/", "connectors/", "ingest/", "worker/src/"] }));
    writeFileSync(join(root, "brain.mjs"), "// synthetic dispatcher\n");
    const helper = join(root, "support-recovery.mjs");
    writeFileSync(helper, "// first helper revision\n");
    const { ingestRemovalRuntime } = await import(pathToFileURL(join(root, "operations/ingest-removal-plan.mjs")));
    let first;
    assert.doesNotThrow(() => { first = ingestRemovalRuntime(); }, "npm omits package-lock.json from the published artifact");
    writeFileSync(helper, "// second helper revision\n");
    assert.notEqual(ingestRemovalRuntime(), first, "a root runtime module change must invalidate approval");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy family previews remain read-only and bare confirmation has no deletion authority", async () => {
  const store = ingestPlanStore();
  const key = randomBytes(32).toString("hex");
  store.env.ADMIN_KEY = key;
  let requests = 0;
  const route = body => {
    requests++;
    return worker.fetch(new Request("https://fixture.invalid/api/admin/brain/forget", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Key": key }, body: JSON.stringify(body),
    }), store.env, { waitUntil() {} });
  };
  try {
    store.put("drive:old");
    const families = [{ base_doc_uid: "drive:old", keep_doc_uids: [] }];
    const preview = await route({ families });
    assert.equal(preview.status, 200);
    assert.deepEqual((await preview.json()).targets, ["drive:old"]);
    assert.equal(store.calls.batches, 0);
    for (const extra of [{}, { authorization: "provenance-repair" }, { approvalId: "a".repeat(64) }]) {
      const response = await route({ families, confirm: true, ...extra });
      assert.equal(response.status, 409);
      const refusal = await response.json();
      assert.equal(refusal.code, "INGEST_REMOVAL_PLAN_REQUIRED");
      assert.match(refusal.error, /update.*CLI/i);
      assert.equal(store.calls.batches, 0);
      assert.deepEqual(store.uids(), ["drive:old"]);
    }
    assert.equal(requests, 4, "authenticated route and nonempty preview were reached");
    const explicitForget = await route({ doc_uids: ["drive:old"], confirm: true });
    assert.equal(explicitForget.status, 200);
    assert.equal((await explicitForget.json()).documents, 1);
    assert.deepEqual(store.uids(), []);
  } finally { store.db.close(); }
});

test("separately approved provenance cleanup fences exact structural targets and retains replacements", async () => {
  const store = ingestPlanStore();
  try {
    store.put("upload:original");
    store.put("upload:original#part1of2", { part: 1, part_count: 2, part_of: "original" });
    store.put("upload:original#part2of2", { part: 2, part_count: 2, part_of: "original" });
    const families = [{ base_doc_uid: "upload:original", keep_doc_uids: ["upload:original#part1of2", "upload:original#part2of2"] }];
    const input = { families, request: store.request, assertOwned() {} };
    await assert.rejects(applyApprovedProvenanceFamily(input), /separately approved/);
    assert.equal(store.calls.preview, 0);
    let reached = 0;
    await assert.rejects(applyApprovedProvenanceFamily({ ...input, approvalId: "a".repeat(64), request: async input => {
      const result = await store.request(input);
      if (input.body.action === "preview") {
        assert.deepEqual(result.targets, ["upload:original"]);
        reached++;
        store.put("upload:neighbor");
      }
      return result;
    } }), /changed/);
    assert.equal(reached, 1);
    assert.equal(store.calls.batches, 0);
    assert.ok(store.uids().includes("upload:original"));
    assert.equal(await applyApprovedProvenanceFamily({ ...input, approvalId: "a".repeat(64) }), 1);
    assert.deepEqual(store.uids(), ["upload:neighbor", "upload:original#part1of2", "upload:original#part2of2"]);
    assert.equal(store.calls.batches, 1);
  } finally { store.db.close(); }
});

test("approved structural Drive cleanup runs the aggregate guard before exact deletion", async () => {
  const store = ingestPlanStore();
  try {
    store.put("drive:original");
    store.put("drive:original#part1of2", { part: 1, part_count: 2, part_of: "original" });
    store.put("drive:original#part2of2", { part: 2, part_count: 2, part_of: "original" });
    store.put("drive:neighbor");
    const families = [{ base_doc_uid: "drive:original",
      keep_doc_uids: ["drive:original#part1of2", "drive:original#part2of2"] }];
    const sourcePlan = buildDriveRemovalPlan({
      storedFamilies: ["drive:original", "drive:neighbor"],
      intentionalCandidates: ["drive:original"],
    });
    assert.equal(sourcePlan.total, 1);
    assert.equal(sourcePlan.tooLarge, true);
    let previews = 0;
    const input = { families, approvalId: "a".repeat(64), request: async input => {
      const result = await store.request(input);
      if (input.body.action === "preview" && !input.body.marker) {
        previews++;
        assert.deepEqual(result.targets, ["drive:original"]);
      }
      return result;
    } };
    for (const approval of [undefined, "f".repeat(64)]) {
      const before = previews;
      await assert.rejects(applyApprovedProvenanceFamily({
        ...input, sourcePlan, sourceApproval: approval,
      }), { code: "SAFETY_REVIEW_REQUIRED" });
      assert.equal(previews, before + 1, "the nonempty exact inventory must reach the guard");
      assert.equal(store.calls.apply, 0);
      assert.ok(store.uids().includes("drive:original"));
    }
    // Omitting or substituting the aggregate plan cannot bypass its gate.
    for (const aggregate of [null, buildDriveRemovalPlan({
      storedFamilies: ["drive:original", "drive:neighbor"],
      intentionalCandidates: ["drive:neighbor"],
    })]) {
      const before = previews;
      await assert.rejects(applyApprovedProvenanceFamily({
        ...input, sourcePlan: aggregate, sourceApproval: aggregate?.fingerprint,
      }), { code: "SAFETY_REVIEW_REQUIRED" });
      assert.equal(previews, before + 1);
      assert.equal(store.calls.apply, 0);
    }
    const actions = [];
    assert.equal(await applyApprovedProvenanceFamily({
      ...input, sourcePlan, sourceApproval: sourcePlan.fingerprint,
      request: async input => {
        actions.push(input.body.action);
        return store.request(input);
      },
    }), 1);
    assert.deepEqual(actions, ["preview", "apply", "preview"]);
    assert.equal(store.calls.apply, 1);
    assert.deepEqual(store.uids(), ["drive:neighbor", "drive:original#part1of2", "drive:original#part2of2"]);
  } finally { store.db.close(); }
});


for (const collision of [false, true]) {
  test(`structural cleanup preserves independent originals, collision=${collision}`, async () => {
    const store = ingestPlanStore();
    try {
      const base = "upload:records/original.txt";
      const independent = collision ? `${base}#partner.txt` : `${base}.other.txt`;
      store.put(base);
      for (let part = 1; part <= 2; part++) {
        store.put(`${base}#part${part}of2`, { part, part_count: 2, part_of: "records/original.txt" });
      }
      store.put(independent);
      const families = [{ base_doc_uid: base, keep_doc_uids: [base], family_kind: "structural" }];
      const observed = await previewIngestRemovals(store.env, { families });
      assert.equal(observed.targets.length >= 2, true, "nonempty obsolete family reached the decision");
      assert.deepEqual(observed.targets, [`${base}#part1of2`, `${base}#part2of2`]);
      assert.equal(observed.excluded_documents, collision ? 1 : 0);
      const result = await applyIngestRemovals(store.env, observed);
      assert.equal(result.documents, 2);
      assert.equal(store.calls.batches, 1);
      assert.deepEqual(store.uids(), [base, independent].sort());
    } finally { store.db.close(); }
  });
}

test("structural membership requires exact part syntax and provenance; inconsistent keep refuses", async () => {
  const store = ingestPlanStore();
  try {
    const base = "upload:records/original.txt";
    store.put(base);
    const rejected = [
      ["#partner.txt", { part_of: "records/original.txt" }],
      ["#part01of2", { part_of: "records/original.txt" }],
      ["#part0of2", { part_of: "records/original.txt" }],
      ["#part3of2", { part_of: "records/original.txt" }],
      ["#part1of2.txt", { part_of: "records/original.txt" }],
      ["#part1of2\n", { part_of: "records/original.txt" }],
      ["#part1of2", {}],
      ["#part2of2", { part_of: "records/neighbor.txt" }],
      ["#part1of3", { part_of: "records/original.txt ", part: 1 }],
      ["#part2of3", { part_of: "records/original.txt", part: 1 }],
    ];
    for (const [suffix, meta] of rejected) store.put(base + suffix, meta);
    const valid = `${base}#part3of3`;
    store.put(valid, { part: 3, part_count: 3, part_of: base });
    const family = { base_doc_uid: base, keep_doc_uids: [base], family_kind: "structural" };
    const observed = await previewIngestRemovals(store.env, { families: [family] });
    assert.deepEqual(observed.targets, [valid], "a verified obsolete part reaches the plan");
    assert.equal(observed.excluded_documents, rejected.length);
    await assert.rejects(previewIngestRemovals(store.env, { families: [{ ...family,
      keep_doc_uids: [base, `${base}#part1of2`] }] }), /keep.*belong/);
    assert.equal(store.calls.batches, 0, "inconsistent keep stops before writes");
    await applyIngestRemovals(store.env, observed);
    assert.equal(store.calls.batches, 1);
    assert.equal(store.uids().includes(valid), false);
    assert.ok(rejected.every(([suffix]) => store.uids().includes(base + suffix)));
  } finally { store.db.close(); }
});


test("the exact character ceiling never creates a one-part split", () => {
  for (const content of ["x".repeat(MAX_DOC_CHARS), "x".repeat(MAX_DOC_CHARS - 1) + "é"]) {
    assert.equal(content.length, MAX_DOC_CHARS, "the split decision reaches the exact ceiling");
    const envelope = { source_type: "upload", source_id: "records/limit.txt", content };
    const result = splitOversized(envelope);
    assert.equal(result.length, 1);
    assert.equal(result[0].source_id, envelope.source_id, "no synthetic one-part identity");
    assert.equal(result[0].metadata.part_of, undefined);
    assert.equal(result[0].content, content);
    const oversized = splitOversized({ ...envelope, content: content + "x" });
    assert.equal(oversized.length, 2, "the above-ceiling control still splits");
    assert.deepEqual(oversized.map(part => part.metadata.part_count), [2, 2]);
    assert.equal(oversized.map(part => part.content).join(""), content + "x");
  }
});

test("an existing one-part split is reviewable while an unrelated one-part identity is preserved", async () => {
  const store = ingestPlanStore();
  try {
    const base = "upload:records/legacy.txt";
    const legacy = `${base}#part1of1`;
    store.put(base);
    store.put(legacy, { part_of: "records/legacy.txt", part: 1, part_count: 1 });
    const families = [{ base_doc_uid: base, keep_doc_uids: [base], family_kind: "structural" }];
    const observed = await store.request({ body: { action: "preview", families } });
    assert.equal(store.calls.preview, 1, "the authenticated review decision was reached");
    assert.deepEqual(observed.targets, [legacy]);
    assert.equal(observed.excluded_documents, 0);
    const result = await applyIngestRemovals(store.env, observed);
    assert.equal(result.documents, 1);
    assert.equal(store.calls.batches, 1);
    assert.deepEqual(store.uids(), [base]);
    store.put(legacy, { part_of: "records/independent.txt", part: 1, part_count: 1 });
    const excluded = await store.request({ body: { action: "preview", families } });
    assert.equal(store.calls.preview, 2);
    assert.deepEqual(excluded.targets, []);
    assert.equal(excluded.excluded_documents, 1);
    assert.deepEqual(store.uids(), [base, legacy]);
  } finally { store.db.close(); }
});

test("excluded-family warning offers safe next steps through the native command renderer", async () => {
  const store = ingestPlanStore();
  const warnings = [];
  const previous = console.warn;
  console.warn = text => warnings.push(text);
  try {
    const base = "upload:records/overlap.txt";
    store.put(base);
    store.put(`${base}#partner.txt`);
    const state = { done: { original: "accepted" }, skipped: {} };
    const review = createIngestRemovalReview({ state, saveState: () => {}, source: "upload",
      manifest: {}, manifestPath: "/fixture/manifest.json", base: "https://fixture.invalid",
      request: store.request, runtime: () => "fixture-runtime" });
    review.remember([{ base_doc_uid: base, keep_doc_uids: [base], family_kind: "structural",
      stateKey: "original", hash: "accepted" }]);
    await review.finish();
    assert.equal(store.calls.preview, 1, "the real exclusion decision was reached");
    assert.equal(store.calls.apply, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /preserved 1 stored document/);
    assert.match(warnings[0], /Nothing was lost/);
    assert.match(warnings[0], /review.*support.*retry/i);
    assert.ok(warnings[0].includes(renderCliCommands("brain support --explain SAFETY_REVIEW_REQUIRED")));
    assert.doesNotMatch(warnings[0], /records\/|partner|result_family|fixture\.invalid/);
  } finally { console.warn = previous; store.db.close(); }
});

function unverifyStoredBinding(store, uid) {
  store.db.exec("INSERT INTO source_original_id_key_state (tenant_id, signing_salt) VALUES ('primary', lower(hex(randomblob(32))))");
  store.db.prepare("UPDATE documents SET document_revision_id='rev-v1:' || lower(hex(randomblob(32))), source_original_binding_hash=? WHERE doc_uid=?")
    .run("sha256:" + "ab".repeat(32), uid);
}

test("an excluded source target refuses before an empty preview can commit progress", async () => {
  const f = fixture();
  try {
    unverifyStoredBinding(f.store, "drive:item0");
    const sourcePlan = buildDriveRemovalPlan({ storedFamilies: f.store.uids(), vanishedCandidates: ["drive:item0"] });
    assert.equal(sourcePlan.total, 1, "nonempty source decision reached");
    await assert.rejects(f.review.finish({ sourcePlan }), (error) =>
      error instanceof DriveRemovalReviewRequired && error.code === "SAFETY_REVIEW_REQUIRED");
    assert.equal(f.store.calls.preview, 2, "combined and source-only previews reached");
    assert.equal(f.state.ingest_removal_plan, undefined);
    assert.equal(f.store.calls.apply, 0);
    assert.ok(f.store.uids().includes("drive:item0"));
    // With the unverifiable row resolved, the same review can complete.
    f.store.db.prepare("DELETE FROM documents WHERE doc_uid=?").run("drive:item0");
    await f.review.finish({ sourcePlan });
    assert.equal(f.store.calls.preview, 3);
  } finally { f.store.db.close(); }
});

test("an exclusion confined to a replacement family still warns and completes", async () => {
  const f = fixture();
  const warnings = [];
  const priorWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    const uid = "drive:item0#part1of2";
    f.store.put(uid, { part_of: "item0", part: 1, part_count: 2 });
    unverifyStoredBinding(f.store, uid);
    const replacement = { stateKey: "item0", hash: "accepted", base_doc_uid: "drive:item0",
      keep_doc_uids: ["drive:item0"], family_kind: "structural" };
    f.state.done.item0 = "accepted";
    f.review.remember([replacement]);
    await f.review.finish();
    assert.equal(f.store.calls.preview, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /preserved 1 stored document/);
    assert.equal(f.state.ingest_removal_plan, undefined);
    assert.equal(f.store.calls.apply, 0);
    assert.ok(f.store.uids().includes(uid));
    // A now-absent source target must not inherit a replacement-only refusal
    // when the combined preview causes the source-only recheck to run.
    const sourcePlan = buildDriveRemovalPlan({ storedFamilies: f.store.uids(), vanishedCandidates: ["drive:item1"] });
    f.store.db.prepare("DELETE FROM documents WHERE doc_uid=?").run("drive:item1");
    f.review.remember([replacement]);
    await f.review.finish({ sourcePlan });
    assert.equal(f.store.calls.preview, 3);
    assert.equal(warnings.length, 2);
    assert.equal(f.state.ingest_removal_plan, undefined);
    // Verifiable obsolete members must still enter the saved removal plan.
    f.store.db.prepare("UPDATE documents SET document_revision_id=NULL, source_original_binding_hash=NULL WHERE doc_uid=?").run(uid);
    f.review.remember([replacement]);
    await assert.rejects(f.review.finish(), { code: "SAFETY_REVIEW_REQUIRED" });
    assert.deepEqual(f.state.ingest_removal_plan.targets, [uid]);
  } finally { console.warn = priorWarn; f.store.db.close(); }
});
