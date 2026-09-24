import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cmdUpgrade,
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
const PRODUCT_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

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

test("restore refuses a stale approval fingerprint before restore-point creation or mutation", async () => {
  const observed = {
    currentBookmark: "current", targetBookmark: "target",
    before: { documents: 4, chunks: 9, vectors: 9, active_ingests: 0 },
    lossInventory: { complete: true, since: "2026-09-23T12:00:00.000Z", sources: [] },
  };
  const preview = await executeOwnerRestore({
    manifestPath: "/fixture/brain.manifest.json",
    targetTime: "2026-09-23T12:00:00.000Z",
  }, {
    loadPinnedManifest: () => ({ manifest, fingerprint: "b".repeat(64) }),
    observe: async () => observed,
  });
  assert.equal(preview.status, "preview");

  let restorePoints = 0;
  let restores = 0;
  await assert.rejects(executeOwnerRestore({
    manifestPath: "/fixture/brain.manifest.json",
    targetTime: "2026-09-23T12:00:00.000Z",
    approval: preview.plan.approval_fingerprint,
  }, {
    loadPinnedManifest: () => ({ manifest, fingerprint: "b".repeat(64) }),
    observe: async () => ({
      ...observed,
      currentBookmark: "newer-current",
      before: { ...observed.before, documents: 5 },
    }),
    createRestorePoint: async () => { restorePoints += 1; },
    restoreD1: async () => { restores += 1; },
  }), /approval no longer matches/i);
  assert.equal(restorePoints, 0, "the stale-approval decision was reached before the safety snapshot");
  assert.equal(restores, 0);
});

test("restore requires proven post-pause quiescence before the D1 restore call", async () => {
  const observed = {
    currentBookmark: "current", targetBookmark: "target",
    before: { documents: 4, chunks: 9, vectors: 9, active_ingests: 0 },
    lossInventory: { complete: true, since: "2026-09-23T12:00:00.000Z", sources: [] },
  };
  const preview = await executeOwnerRestore({
    manifestPath: "/fixture/brain.manifest.json",
    targetTime: "2026-09-23T12:00:00.000Z",
  }, {
    loadPinnedManifest: () => ({ manifest, fingerprint: "b".repeat(64) }),
    observe: async () => observed,
  });
  for (const receipt of [
    { proven: false, active_ingests: 0, active_updates: 0, in_flight_writers: 0 },
    { proven: true, active_ingests: 1, active_updates: 0, in_flight_writers: 0 },
  ]) {
    let quiescenceChecks = 0;
    let restores = 0;
    await assert.rejects(executeOwnerRestore({
      manifestPath: "/fixture/brain.manifest.json",
      targetTime: "2026-09-23T12:00:00.000Z",
      approval: preview.plan.approval_fingerprint,
    }, {
      loadPinnedManifest: () => ({ manifest, fingerprint: "b".repeat(64) }),
      observe: async () => observed,
      createRestorePoint: async () => {},
      proveQuiescence: async () => {
        quiescenceChecks += 1;
        return receipt;
      },
      restoreD1: async () => { restores += 1; },
      resetLocalState: async () => ({ reset: 0 }),
      rebuildProjection: async () => ({}),
      readAfter: async () => ({ documents: 0, chunks: 0, vectors: 0, pending_outbox: 0 }),
      writeReceipt: async () => {},
    }), /quiescence.*not proven/i);
    assert.equal(quiescenceChecks, 1, "the post-pause quiescence decision was reached");
    assert.equal(restores, 0, "an unverified or active receipt made zero D1 restore calls");
  }
});

test("restore returns before/after proof after positive quiescence", async () => {
  const observed = {
    currentBookmark: "current", targetBookmark: "target",
    before: { documents: 4, chunks: 9, vectors: 9, active_ingests: 0 },
    lossInventory: { complete: true, since: "2026-09-23T12:00:00.000Z", sources: [] },
  };
  const preview = await executeOwnerRestore({
    manifestPath: "/fixture/brain.manifest.json",
    targetTime: "2026-09-23T12:00:00.000Z",
  }, {
    loadPinnedManifest: () => ({ manifest, fingerprint: "b".repeat(64) }),
    observe: async () => observed,
  });

  const calls = [];
  const applied = await executeOwnerRestore({
    manifestPath: "/fixture/brain.manifest.json",
    targetTime: "2026-09-23T12:00:00.000Z",
    approval: preview.plan.approval_fingerprint,
  }, {
    loadPinnedManifest: () => ({ manifest, fingerprint: "b".repeat(64) }),
    observe: async () => observed,
    createRestorePoint: async () => calls.push("restore-point"),
    proveQuiescence: async () => {
      calls.push("quiescence");
      return { proven: true, active_ingests: 0, active_updates: 0, in_flight_writers: 0 };
    },
    restoreD1: async () => { calls.push("restore-d1"); return { previousBookmark: "current" }; },
    resetLocalState: async () => { calls.push("reset-local-state"); return { reset: 2 }; },
    rebuildProjection: async () => { calls.push("rebuild"); return { vectors: 9 }; },
    readAfter: async () => { calls.push("read-after"); return { documents: 4, chunks: 9, vectors: 9, pending_outbox: 0 }; },
    writeReceipt: async () => calls.push("receipt"),
  });
  assert.deepEqual(calls, ["restore-point", "quiescence", "restore-d1", "reset-local-state", "rebuild", "read-after", "receipt"]);
  assert.equal(applied.status, "restored");
  assert.equal(applied.receipt.after.vectors, applied.receipt.after.chunks);
  assert.equal(applied.receipt.local_resume_states_reset, 2);
});

test("rewind preview binds the exact newer-change inventory into owner approval", () => {
  const base = {
    manifestFingerprint: "b".repeat(64),
    manifest,
    targetTime: "2026-09-23T12:00:00.000Z",
    targetBookmark: "target-bookmark",
    currentBookmark: "current-bookmark",
    before: { documents: 4, chunks: 9, vectors: 9, active_ingests: 0 },
    operation: "rewind-last",
  };
  const first = buildOwnerRestorePlan({
    ...base,
    lossInventory: {
      complete: true,
      since: "2026-09-23T12:00:00.000Z",
      sources: [{ source: "documents", runs: 1, documents_added: 2, documents_updated: 0, documents_removed: 1, since: "2026-09-23T13:00:00.000Z" }],
    },
  });
  const changed = buildOwnerRestorePlan({
    ...base,
    lossInventory: {
      complete: true,
      since: "2026-09-23T12:00:00.000Z",
      sources: [{ source: "documents", runs: 1, documents_added: 3, documents_updated: 0, documents_removed: 1, since: "2026-09-23T13:00:00.000Z" }],
    },
  });
  assert.deepEqual(first.loss_inventory.sources[0], {
    source: "documents", runs: 1, documents_added: 2, documents_updated: 0, documents_removed: 1, since: "2026-09-23T13:00:00.000Z",
  });
  assert.notEqual(first.approval_fingerprint, changed.approval_fingerprint);
});

test("the misleading undo-last spelling refuses before manifest or credential access", () => {
  const isolatedHome = mkdtempSync(join(tmpdir(), "brain-owner-undo-removed-"));
  const run = spawnSync(process.execPath, ["brain.mjs", "undo-last", "/does/not/exist.json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: {
      HOME: isolatedHome,
      PATH: process.env.PATH,
      BRAIN_NO_WRANGLER_LOGIN: "1",
    },
  });
  assert.equal(run.status, 1);
  const output = `${run.stdout}\n${run.stderr}`;
  assert.match(output, /removed because it rewound the whole database/i);
  assert.doesNotMatch(output, /could not read manifest|credential|token/i);
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
    brain: { version: PRODUCT_VERSION, worker_name: "fixture-brain", domain: "fixture.invalid" },
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

test("restore projection keeps active deployment unreachable when one expected vector is absent", async () => {
  const { manifestPath, fingerprint } = projectionFixture();
  const replacement = "fixture-restore-integration";
  const metadata = [];
  const deployments = [];
  let created = false;
  const cf = async (path, options = {}) => {
    if (path.includes("/time_travel/bookmark")) return { bookmark: "fixture-bookmark" };
    if (path.endsWith("/metadata_index/list")) return { metadataIndexes: metadata };
    if (path.endsWith("/metadata_index/create")) { metadata.push(options.body); return {}; }
    if (path.endsWith(`/${replacement}`)) {
      if (!created) throw new Error("Cloudflare API GET failed (404): not found");
      return { config: { dimensions: 768 }, vectorCount: 0 };
    }
    if (path.endsWith("/vectorize/v2/indexes") && options.method === "POST") { created = true; return {}; }
    throw new Error(`unexpected fixture call: ${path}`);
  };
  const d1Query = async (_account, _database, sql) => {
    if (/sqlite_master/.test(sql)) return { results: [{ name: "install_state" }] };
    if (/SELECT \*,/.test(sql) && /FROM install_state/.test(sql)) return { results: [{
      client_slug: "fixture", product_version: PRODUCT_VERSION, schema_version: 11,
      active_restore_leases: 0,
    }] };
    if (/status = 'restore_lease'/.test(sql)) return { results: [{ active: 0 }] };
    if (/vector_drain_lease_owner/.test(sql)) return { results: [{
      owner: null, expires_at: null, in_flight: 0,
    }] };
    if (/INSERT INTO upgrade_runs/.test(sql)) return { meta: { changes: 1 }, results: [] };
    throw new Error(`unexpected fixture SQL: ${sql}`);
  };
  await assert.rejects(rebuildRestoredProjection(manifestPath, {
    manifest_fingerprint: fingerprint,
    replacement_index: replacement,
  }, {
    cf,
    resolveAccount: async () => ({ id: "a".repeat(32) }),
    sleep: async () => {},
    log: () => {},
    cmdDeploy: async (_path, options) => deployments.push(options.pauseVectorDrainForUpgrade ? "paused" : "active"),
    cmdUpgrade: (path) => cmdUpgrade(path, {
      cf,
      d1Query,
      resolveAccount: async () => ({ id: "a".repeat(32) }),
      cmdDeploy: async (_path, options) => deployments.push(options.pauseVectorDrainForUpgrade ? "paused" : "active"),
      cmdHealth: async () => {},
      waitForVectorDrainQuiescence: async () => {},
      cmdMigrate: async () => {},
      cmdBootstrap: async () => ({
        epoch: 1, total: 1, confirmed: 0, remaining: 1, rounds: 1,
        complete: false, vector_ready: false,
      }),
    }),
  }), /completion proof/i);
  assert.equal(deployments.filter((mode) => mode === "active").length, 0,
    "the real upgrade state machine never crossed the active-deploy decision");
  assert.ok(deployments.filter((mode) => mode === "paused").length >= 1,
    "the paused restore generation was actually deployed");
});

test("restored D1 reaches active mode only after exact projection proof", async () => {
  const { manifestPath, fingerprint } = projectionFixture();
  const replacement = "fixture-restore-index";
  const metadata = [];
  const calls = [];
  let created = false;
  let d1Version = PRODUCT_VERSION;
  let pausedBarrierVerified = false;
  let outboxDepth = 1;
  const expectedVectorIds = new Set(["fixture:0"]);
  const confirmedVectorIds = new Set();
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
  const d1Query = async (_account, _database, sql) => {
    if (/sqlite_master/.test(sql)) return { results: [{ name: "install_state" }] };
    if (/SELECT \*,/.test(sql) && /FROM install_state/.test(sql)) return { results: [{
      client_slug: "fixture", product_version: d1Version, schema_version: 11,
      active_restore_leases: 0,
    }] };
    if (/UPDATE install_state/.test(sql)) {
      d1Version = PRODUCT_VERSION;
      return { meta: { changes: 1 }, results: [] };
    }
    if (/SELECT product_version FROM install_state/.test(sql)) {
      return { results: [{ product_version: d1Version }] };
    }
    if (/vector_drain_lease_owner/.test(sql)) return { results: [{
      owner: null, expires_at: null, vector_in_flight: 0,
      active_ingests: 0, active_updates: 0,
    }] };
    if (/INSERT INTO upgrade_runs/.test(sql)) return { meta: { changes: 1 }, results: [] };
    throw new Error(`unexpected fixture SQL: ${sql}`);
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
    cmdUpgrade: (path) => cmdUpgrade(path, {
      cf: async (requestPath) => {
        if (requestPath.includes("/time_travel/bookmark")) return { bookmark: "fixture-bookmark" };
        throw new Error(`unexpected upgrade fixture call: ${requestPath}`);
      },
      d1Query,
      resolveAccount: async () => ({ id: "a".repeat(32) }),
      cmdDeploy: async (_path, options) => {
        if (options.pauseVectorDrainForUpgrade) {
          calls.push("upgrade-paused");
          return;
        }
        assert.equal(pausedBarrierVerified, true, "the exact paused Worker generation was verified");
        assert.equal(outboxDepth, 0, "the durable vector outbox was empty");
        assert.deepEqual(confirmedVectorIds, expectedVectorIds,
          "every expected vector id had a query-visible confirmation");
        calls.push("upgrade-active");
      },
      cmdHealth: async (_path, options) => {
        if (options.expectDrainMode === "paused-for-upgrade") pausedBarrierVerified = true;
      },
      waitForVectorDrainQuiescence: async () => {},
      cmdMigrate: async () => {},
      cmdBootstrap: async () => {
        confirmedVectorIds.add("fixture:0");
        outboxDepth = 0;
        return {
          epoch: 1, total: 1, confirmed: 1, remaining: 0, rounds: 1,
          complete: true, vector_ready: true,
        };
      },
      reconcileWorkerProviderSecrets: async () => {},
      cmdDrain: async () => {},
      cmdTest: async () => {
        assert.deepEqual(confirmedVectorIds, expectedVectorIds);
        assert.equal(outboxDepth, 0);
      },
    }),
  });
  assert.equal(result.replacementIndex, replacement);
  assert.equal(metadata.length, 6);
  assert.deepEqual(calls.slice(-3), ["deploy-paused", "upgrade-paused", "upgrade-active"]);
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
