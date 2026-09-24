import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  rebuildRestoredProjection,
  withAutomaticRestorePoint,
} from "../brain.mjs";
import {
  buildOwnerRestorePlan,
  executeOwnerRestore,
  normalizeRestoreTime,
} from "../operations/owner-restore.mjs";

const manifest = {
  infrastructure: { cloudflare: { account_id: "a".repeat(32), d1_database_id: "fixture-db", vectorize_index: "fixture-vectors" } },
};

test("restore preview binds timestamp, current bookmark, counts, and replacement index", () => {
  const plan = buildOwnerRestorePlan({
    manifestFingerprint: "b".repeat(64),
    manifest,
    targetTime: "2026-09-23T12:00:00.000Z",
    targetBookmark: "target-bookmark",
    currentBookmark: "current-bookmark",
    before: { documents: 4, chunks: 9, vectors: 9, active_ingests: 0 },
  });
  assert.match(plan.approval_fingerprint, /^[a-f0-9]{64}$/);
  assert.notEqual(plan.replacement_index, manifest.infrastructure.cloudflare.vectorize_index);
  assert.equal(plan.effects.d1_restore, true);
  assert.equal(plan.effects.old_vector_index_retained, true);
});

test("restore refuses active ingestion after reaching the concurrency decision", async () => {
  let reads = 0;
  let restores = 0;
  await assert.rejects(executeOwnerRestore({
    manifestPath: "/fixture/brain.manifest.json",
    targetTime: "2026-09-23T12:00:00.000Z",
    approval: "0".repeat(64),
  }, {
    loadPinnedManifest: () => ({ manifest, fingerprint: "b".repeat(64) }),
    observe: async () => {
      reads += 1;
      return { currentBookmark: "current", targetBookmark: "target", before: { documents: 1, chunks: 1, vectors: 1, active_ingests: 1 } };
    },
    restoreD1: async () => { restores += 1; },
  }), /ingest.*running/i);
  assert.equal(reads, 1, "the active-run decision point was reached");
  assert.equal(restores, 0);
});

test("restore refuses an active update after observing it and before any mutation", async () => {
  let observations = 0;
  let restorePoints = 0;
  await assert.rejects(executeOwnerRestore({
    manifestPath: "/fixture/brain.manifest.json",
    targetTime: "2026-09-23T12:00:00.000Z",
    approval: "0".repeat(64),
  }, {
    loadPinnedManifest: () => ({ manifest, fingerprint: "b".repeat(64) }),
    observe: async () => {
      observations += 1;
      return {
        currentBookmark: "current",
        targetBookmark: "target",
        before: { documents: 1, chunks: 1, vectors: 1, active_ingests: 0, active_updates: 1 },
      };
    },
    createRestorePoint: async () => { restorePoints += 1; },
  }), /update.*running/i);
  assert.equal(observations, 1, "the active-update decision point was reached");
  assert.equal(restorePoints, 0);
});

test("restore requires an unchanged preview fingerprint before any mutation and returns before/after proof", async () => {
  const observed = { currentBookmark: "current", targetBookmark: "target", before: { documents: 4, chunks: 9, vectors: 9, active_ingests: 0 } };
  const preview = await executeOwnerRestore({
    manifestPath: "/fixture/brain.manifest.json",
    targetTime: "2026-09-23T12:00:00.000Z",
  }, {
    loadPinnedManifest: () => ({ manifest, fingerprint: "b".repeat(64) }),
    observe: async () => observed,
  });
  assert.equal(preview.status, "preview");

  const calls = [];
  const applied = await executeOwnerRestore({
    manifestPath: "/fixture/brain.manifest.json",
    targetTime: "2026-09-23T12:00:00.000Z",
    approval: preview.plan.approval_fingerprint,
  }, {
    loadPinnedManifest: () => ({ manifest, fingerprint: "b".repeat(64) }),
    observe: async () => observed,
    createRestorePoint: async () => calls.push("restore-point"),
    restoreD1: async () => { calls.push("restore-d1"); return { previousBookmark: "current" }; },
    resetLocalState: async () => { calls.push("reset-local-state"); return { reset: 2 }; },
    rebuildProjection: async () => { calls.push("rebuild"); return { vectors: 9 }; },
    readAfter: async () => { calls.push("read-after"); return { documents: 4, chunks: 9, vectors: 9, pending_outbox: 0 }; },
    writeReceipt: async () => calls.push("receipt"),
  });
  assert.deepEqual(calls, ["restore-point", "restore-d1", "reset-local-state", "rebuild", "read-after", "receipt"]);
  assert.equal(applied.status, "restored");
  assert.equal(applied.receipt.after.vectors, applied.receipt.after.chunks);
  assert.equal(applied.receipt.local_resume_states_reset, 2);
});

test("restore time accepts only an explicit RFC3339 instant", () => {
  assert.equal(normalizeRestoreTime("2026-09-23T12:00:00Z"), "2026-09-23T12:00:00.000Z");
  assert.throws(() => normalizeRestoreTime("yesterday"), /RFC3339/);
});

test("automatic restore points finish before a risky action and a failed point blocks it", async () => {
  const calls = [];
  const result = await withAutomaticRestorePoint("/fixture/brain.manifest.json", "pre-ingest", async () => {
    calls.push("action");
    return "done";
  }, {
    createOwnerBackup: async () => {
      calls.push("backup");
      return { path: "/fixture/backup", restorePoint: { timestamp: "2026-09-24T12:00:00.000Z" } };
    },
  });
  assert.equal(result, "done");
  assert.deepEqual(calls, ["backup", "action"]);

  let actionCalls = 0;
  await assert.rejects(withAutomaticRestorePoint("/fixture/brain.manifest.json", "pre-forget", async () => {
    actionCalls += 1;
  }, {
    createOwnerBackup: async () => { throw new Error("backup refused"); },
  }), /backup refused/);
  assert.equal(actionCalls, 0, "the risky decision point stayed unreachable after backup failure");
});

function projectionFixture() {
  const root = mkdtempSync(join(tmpdir(), "brain-owner-projection-"));
  const manifestPath = join(root, "brain.manifest.json");
  const value = {
    client: { slug: "fixture" },
    infrastructure: {
      cloudflare: {
        account_id: "a".repeat(32),
        d1_database_id: "fixture-database",
        vectorize_index: "fixture-old-index",
      },
    },
  };
  writeFileSync(manifestPath, `${JSON.stringify(value, null, 2)}\n`);
  const fingerprint = createHash("sha256").update(readFileSync(manifestPath)).digest("hex");
  return { manifestPath, fingerprint };
}

test("restored D1 is reprojected into one empty replacement index before active upgrade", async () => {
  const { manifestPath, fingerprint } = projectionFixture();
  const replacement = "fixture-restore-index";
  const metadata = [];
  const calls = [];
  let created = false;
  const cf = async (path, options = {}) => {
    if (path.endsWith("/metadata_index/list")) return { metadataIndexes: metadata };
    if (path.endsWith("/metadata_index/create")) {
      metadata.push(options.body);
      calls.push(`metadata:${options.body.propertyName}`);
      return {};
    }
    if (path.endsWith(`/${replacement}`)) {
      if (!created) throw new Error("Cloudflare API GET failed (404): not found");
      return { config: { dimensions: 768 }, vectorCount: 0 };
    }
    if (path.endsWith("/vectorize/v2/indexes") && options.method === "POST") {
      created = true;
      calls.push("create-index");
      return {};
    }
    throw new Error(`unexpected fixture call: ${path}`);
  };
  const result = await rebuildRestoredProjection(manifestPath, {
    manifest_fingerprint: fingerprint,
    replacement_index: replacement,
  }, {
    cf,
    resolveAccount: async () => ({ id: "a".repeat(32) }),
    sleep: async () => {},
    log: () => {},
    cmdDeploy: async (_path, options) => {
      calls.push("deploy-paused");
      assert.equal(options.pauseVectorDrainForUpgrade, true);
    },
    cmdUpgrade: async () => calls.push("upgrade"),
  });
  assert.equal(result.replacementIndex, replacement);
  assert.equal(metadata.length, 6);
  assert.deepEqual(calls.slice(-2), ["deploy-paused", "upgrade"]);
  assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).infrastructure.cloudflare.vectorize_index, replacement);
});

test("replacement-index inspection errors fail closed before creation", async () => {
  const { manifestPath, fingerprint } = projectionFixture();
  let mutations = 0;
  await assert.rejects(rebuildRestoredProjection(manifestPath, {
    manifest_fingerprint: fingerprint,
    replacement_index: "fixture-restore-index",
  }, {
    cf: async (_path, options = {}) => {
      if (options.method) mutations += 1;
      throw new Error("Cloudflare API GET failed (403): forbidden");
    },
    resolveAccount: async () => ({ id: "a".repeat(32) }),
  }), /403/);
  assert.equal(mutations, 0, "the index-create decision point was reached but not crossed");
});
