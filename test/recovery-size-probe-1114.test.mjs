import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  VERIFIED_RECOVERY_STAGES, initializeVerifiedRecovery, runVerifiedRecovery,
} from "../operations/verified-recovery.mjs";

test("pinned single-import size decision blocks owner-scale bytes, with a small control", async () => {
  const directory = mkdtempSync(join(tmpdir(), "size-probe-"));
  try {
    const source = { manifest_version: 1, client: { slug: "synthetic-brain" },
      brain: { version: "0.4.28", worker_name: "synthetic-source", domain: "source.invalid" },
      infrastructure: { cloudflare: { storage: "d1", account_id: "synthetic-account",
        d1_database_name: "synthetic-source", d1_database_id: "source-id", vectorize_index: "source-index" } },
      retrieval: { embed_model: "synthetic", embed_dimensions: 768, chunk_size: 1500, chunk_overlap: 300,
        answer_model: "synthetic" }, safety: { credential_scanner: { enabled: true } } };
    const target = structuredClone(source);
    target.brain = { ...target.brain, worker_name: "recovery-gate-synthetic", domain: "target.invalid" };
    target.infrastructure.cloudflare = { ...target.infrastructure.cloudflare,
      d1_database_name: "recovery-gate-synthetic", d1_database_id: "target-id", vectorize_index: "target-index" };
    const sourcePath = join(directory, "source.json");
    const targetPath = join(directory, "target.json");
    writeFileSync(sourcePath, JSON.stringify(source), { mode: 0o600 });
    writeFileSync(targetPath, JSON.stringify(target), { mode: 0o600 });
    const clock = () => new Date("2026-11-14T00:00:00Z");
    const initial = initializeVerifiedRecovery(sourcePath, targetPath,
      join(directory, "plan.json"), join(directory, "state.json"), { now: clock() });
    const maximum = initial.plan.artifact.max_single_import_bytes;
    assert.equal(maximum, 5 * 1024 ** 3);
    const reached = [];
    for (const bytes of [maximum + 1, 100]) {
      const adapters = Object.fromEntries(VERIFIED_RECOVERY_STAGES.map(({ id }) => [id, async () => {
        reached.push({ id, bytes });
        if (id !== "export_d1") throw new Error("SYNTHETIC_NEXT_STAGE_STOP");
        return { artifact_sha256: createHash("sha256").update("synthetic").digest("hex"), artifact_bytes: bytes };
      }]));
      const result = await runVerifiedRecovery(initial.plan, initial.state, adapters,
        { revalidateManifests: async () => true, clock });
      assert.equal(result.ok, false);
      assert.equal(result.state.completed.length, bytes > maximum ? 0 : 1);
      assert.equal(result.state.failure.stage, bytes > maximum ? "export_d1" : "verify_export");
    }
    assert.deepEqual(reached.map(({ id }) => id), ["export_d1", "export_d1", "verify_export"]);
    // Count, do not allocate, a 6.4 GB export through the actual plan/state
    // evidence validator. The adapter transport suite separately exercises
    // physical encryption/import with a reduced per-part bound.
    const virtual = { artifact_sha256: createHash("sha256").update("virtual manifest").digest("hex"),
      artifact_bytes: 6_400_000_000,
      multipart: { part_count: 3, manifest_bytes: 1024, parts: [2_200_000_000, 2_200_000_000, 1_999_998_976]
        .map((bytes, index) => ({ index: index + 1, bytes, sha256: createHash("sha256").update(`part ${index}`).digest("hex") })) } };
    let decisions = 0;
    for (const arm of ["valid", "missing", "oversized", "reordered", "wrong-total", "wrong-count"]) {
      const evidence = structuredClone(virtual);
      if (arm === "missing") evidence.multipart.parts.pop();
      if (arm === "oversized") evidence.multipart.parts[0].bytes = maximum + 1;
      if (arm === "reordered") evidence.multipart.parts.reverse();
      if (arm === "wrong-total") evidence.artifact_bytes++;
      if (arm === "wrong-count") evidence.multipart.part_count++;
      const adapters = Object.fromEntries(VERIFIED_RECOVERY_STAGES.map(({ id }) => [id, async () => {
        if (id !== "export_d1") throw new Error("SYNTHETIC_NEXT_STAGE_STOP");
        decisions++;
        return evidence;
      }]));
      const result = await runVerifiedRecovery(initial.plan, initial.state, adapters,
        { revalidateManifests: async () => true, clock });
      assert.equal(result.state.completed.length, arm === "valid" ? 1 : 0, arm);
      assert.equal(result.state.failure.stage, arm === "valid" ? "verify_export" : "export_d1", arm);
    }
    assert.equal(decisions, 6);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
