import assert from "node:assert/strict";
import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildLocalCleanupPlan,
  executeLocalCleanup,
  markConsumed,
  missingOngoingKeys,
  moveFileToSystemTrash,
  retentionEligible,
  retireStagingSource,
  sourceRole,
} from "../operations/local-staging-cleanup.mjs";

const files = [
  { source: "drop", key: "copy.txt", path: "/stage/copy.txt", bytes: 12, mtime_ms: 1 },
  { source: "drop", key: "only.txt", path: "/stage/only.txt", bytes: 34, mtime_ms: 2 },
  { source: "work", key: "live.txt", path: "/work/live.txt", bytes: 56, mtime_ms: 3 },
];

test("source roles default to ongoing and accept the two staging spellings", () => {
  assert.equal(sourceRole({}), "ongoing");
  assert.equal(sourceRole({ role: "ongoing" }), "ongoing");
  assert.equal(sourceRole({ role: "staging" }), "staging");
  assert.equal(sourceRole({ role: "one-time-import" }), "staging");
  assert.throws(() => sourceRole({ role: "mirror" }), /ongoing, staging, or one-time-import/);
});

test("cleanup preview reaches confirmed staging files and never ongoing files", () => {
  const plan = buildLocalCleanupPlan({
    files,
    sources: {
      drop: { role: "staging" },
      work: { role: "ongoing" },
    },
    confirmations: {
      "drop:copy.txt": { accepted_resolution_current: true, external_original: "documents" },
      "drop:only.txt": { accepted_resolution_current: true, external_original: null },
      "work:live.txt": { accepted_resolution_current: true, external_original: "drive" },
    },
  });
  assert.deepEqual(plan.copies.map((item) => item.key), ["copy.txt"]);
  assert.deepEqual(plan.only_copies.map((item) => item.key), ["only.txt"]);
  assert.equal(plan.total_bytes, 46);
  assert.equal(plan.decision_points, 2, "the two staging candidates prove the decision path was reached");
  assert.equal(plan.items.some((item) => item.source === "work"), false);
});

test("an only-copy file requires an explicit keep, archive, or remove choice", async () => {
  const plan = buildLocalCleanupPlan({
    files: [files[1]],
    sources: { drop: { role: "staging" } },
    confirmations: { "drop:only.txt": { accepted_resolution_current: true, external_original: null } },
  });
  let trashCalls = 0;
  await assert.rejects(
    executeLocalCleanup(plan, { approve: plan.plan_id, trash: async () => { trashCalls++; } }),
    /only copy.*keep, archive, or remove/i,
  );
  assert.equal(plan.decision_points, 1, "the refusal is not vacuous");
  assert.equal(trashCalls, 0);
});

test("approved cleanup uses the injected system Trash operation, never a delete primitive", async () => {
  const plan = buildLocalCleanupPlan({
    files: [files[0], files[1]],
    sources: { drop: { role: "staging" } },
    confirmations: {
      "drop:copy.txt": { accepted_resolution_current: true, external_original: "drive" },
      "drop:only.txt": { accepted_resolution_current: true, external_original: null },
    },
  });
  const trashed = [];
  const removed = [];
  const receipt = await executeLocalCleanup(plan, {
    approve: plan.plan_id,
    onlyCopyChoice: "remove",
    assertCurrent: async () => {},
    trash: async (path) => trashed.push(path),
    remove: async (path) => removed.push(path),
    now: () => "2026-09-24T12:00:00.000Z",
  });
  assert.deepEqual(trashed, ["/stage/copy.txt", "/stage/only.txt"]);
  assert.deepEqual(removed, []);
  assert.equal(receipt.moved_to_trash, 2);
  assert.equal(receipt.recoverable, true);
});

test("the Linux adapter invokes the system Trash provider, never rm", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-trash-adapter-"));
  const file = join(root, "fixture.txt");
  writeFileSync(file, "fixture");
  const calls = [];
  await moveFileToSystemTrash(file, {
    platform: "linux",
    spawn(command, args) {
      calls.push({ command, args });
      renameSync(file, `${file}.trashed`);
      return { status: 0 };
    },
  });
  assert.deepEqual(calls, [{ command: "gio", args: ["trash", "--", file] }]);
  assert.equal(calls.length, 1, "the Trash decision point was reached exactly once");
});

test("archive choice verifies the owner archive copy before moving the original to Trash", async () => {
  const plan = buildLocalCleanupPlan({
    files: [files[1]],
    sources: { drop: { role: "staging" } },
    confirmations: { "drop:only.txt": { accepted_resolution_current: true, external_original: null } },
  });
  const calls = [];
  const receipt = await executeLocalCleanup(plan, {
    approve: plan.plan_id,
    onlyCopyChoice: "archive",
    assertCurrent: async () => calls.push("checked"),
    archive: async () => calls.push("archived"),
    trash: async () => calls.push("trashed"),
  });
  assert.deepEqual(calls, ["checked", "archived", "trashed"]);
  assert.equal(receipt.archived, 1);
  assert.equal(receipt.moved_to_trash, 1);
});

test("consumed staging keys never become removals while ongoing keys retain the gate", () => {
  const state = { done: { "old.txt": "a", "live.txt": "b" }, consumed: {} };
  markConsumed(state, { source: "drop", key: "old.txt", proof: "proof-1", consumed_at: 7 });
  assert.deepEqual(missingOngoingKeys({
    knownKeys: Object.keys(state.done),
    presentKeys: [],
    role: "staging",
    consumed: state.consumed,
  }), ["live.txt"]);
  assert.deepEqual(missingOngoingKeys({
    knownKeys: ["live.txt"],
    presentKeys: [],
    role: "ongoing",
    consumed: { "live.txt": { proof: "proof-2" } },
  }), ["live.txt"]);
});

test("recurring cleanup obeys retention and writes a bounded receipt", () => {
  assert.equal(retentionEligible({ mtime_ms: 100 }, { now_ms: 200, retention_days: 1 }), false);
  assert.equal(retentionEligible({ mtime_ms: 100 }, { now_ms: 100 + 31 * 86400000, retention_days: 30 }), true);
  assert.throws(() => retentionEligible(files[0], { now_ms: 200, retention_days: 0 }), /positive integer/);
});

test("retiring a one-time source stops future walks and preserves Brain documents", () => {
  const manifest = { corpora: { upload: { enabled: true, folders: [
    { path: "/stage", source: "drop", role: "one-time-import" },
  ] } } };
  const receipt = retireStagingSource(manifest, "drop", { now: () => "2026-09-24T12:00:00.000Z" });
  assert.equal(receipt.decision_points, 1);
  assert.equal(receipt.documents_preserved, true);
  assert.equal(manifest.corpora.upload.folders[0].retired, true);
  assert.equal(manifest.corpora.upload.folders[0].retired_at, "2026-09-24T12:00:00.000Z");
});
