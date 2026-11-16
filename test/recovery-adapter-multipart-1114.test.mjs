import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createCloudflareRecoveryFieldGateAdapters, previewCloudflareRecoveryFieldGate,
  runCloudflareRecoveryFieldGate,
} from "../operations/cloudflare-recovery-adapter.mjs";
import { initializeVerifiedRecovery, loadVerifiedRecoveryState, verifiedRecoveryStatus } from "../operations/verified-recovery.mjs";

// Called with the existing adapter suite's fully injected provider. The byte
// model counts an owner-sized stream without allocating gigabytes; physical
// crypto and inventory checks still run over every small representative part.
export async function runMultipartAdapterCases({ sandbox, baseConfig, providerHarness }) {
  let passed = 0;
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  for (const arm of ["large", "small", "altered", "missing", "reordered", "extra", "nonempty", "nonempty-at-import", "wrong-final", "lost-import", "interrupted", "changed-source", "approval"].filter((arm) => !process.env.BRAIN_RECOVERY_MULTIPART_ARM || arm === process.env.BRAIN_RECOVERY_MULTIPART_ARM)) {
    const directory = mkdtempSync(join(sandbox, "multipart-case-"));
    const artifacts = join(directory, "artifacts");
    mkdirSync(artifacts, { mode: 0o700 });
    const config = { ...baseConfig, artifactDirectory: artifacts,
      planPath: join(directory, "plan.json"), statePath: join(directory, "state.json") };
    const initial = initializeVerifiedRecovery(config.sourceManifestPath, config.targetManifestPath,
      config.planPath, config.statePath, { now: new Date("2026-11-14T00:00:00Z") });
    const run = async (request, dependencies) => {
      try { return await runCloudflareRecoveryFieldGate(request, dependencies); }
      catch (error) {
        if (error.code !== "RECOVERY_FIELD_GATE_INTENTIONAL_INTERRUPTION") throw error;
        return { ok: true, state: loadVerifiedRecoveryState(config.statePath, initial.plan) };
      }
    };
    assert.equal(initial.plan.artifact.multipart_format, "financial_brain_recovery_multipart_v1");
    const preview = previewCloudflareRecoveryFieldGate(config, { platform: "darwin" });
    const approved = { ...config, approvePlan: preview.plan_fingerprint,
      approveDisposableTarget: preview.target_approval_fingerprint,
      approveTargetExecution: preview.target_execution_approval_fingerprint,
      approveSourceExportBlocking: preview.source_export_blocking_approval_fingerprint,
      approveWrapper: preview.wrapper_approval_fingerprint, approveGolden: preview.golden_approval_fingerprint,
      approveImplementation: preview.implementation_approval_fingerprint, stopAfterStage: "restore_d1" };
    const provider = providerHarness({ multipartImports: true, initialTargetRestored: arm === "nonempty" });
    const events = [];
    const dependencies = { ...provider.dependencies,
      recoveryPartBytes: arm === "small" ? 5 * 1024 ** 3 : 80_000,
      onRecoveryPartVerified: (part) => {
        events.push(part);
        if (["interrupted", "changed-source"].includes(arm) && events.length === 1) throw new Error("SYNTHETIC_EXPORT_INTERRUPTION");
      } };
    let cleanReads = 0, changedReadbacks = 0;
    dependencies.runWrangler = async (call) => {
      const result = await provider.dependencies.runWrangler(call);
      if (call.args.includes("--file") && arm === "lost-import") {
        const error = new Error("SYNTHETIC_IMPORT_RESPONSE_LOST"); error.code = error.message; throw error;
      }
      if (call.args[0] === "d1" && call.args[1] === "execute" && call.args.some((value) => /user_table_count/.test(value))) {
        cleanReads++;
        if (arm === "nonempty-at-import" && cleanReads === 2) {
          result.stdout = JSON.stringify([{ success: true, results: [{ user_table_count: 1 }] }]);
        }
      }
      if (arm === "wrong-final" && provider.importCalls > 0 && call.args.some((value) => /AS table_name,COUNT/.test(value))) {
        const payload = JSON.parse(result.stdout.toString());
        payload[0].results.find(({ table_name }) => table_name === "documents").row_count++;
        changedReadbacks++;
        result.stdout = JSON.stringify(payload);
      }
      return result;
    };
    if (arm === "approval") {
      await assert.rejects(runCloudflareRecoveryFieldGate({ ...approved, approvePlan: "0".repeat(64) }, dependencies));
      assert.equal(provider.wranglerCalls.length, 0);
      assert.ok(preview.ready_for_explicit_approval);
      passed++;
      continue;
    }
    let result = await run({ ...approved, stopAfterStage: "export_d1" }, dependencies);
    const set = join(artifacts, initial.plan.artifact.multipart_relative_name);
    if (["interrupted", "changed-source"].includes(arm)) {
      assert.equal(result.ok, false);
      assert.equal(events.length, 1);
      const first = join(set, "part-000001.sql.fbrenc");
      const prior = hash(readFileSync(first));
      if (arm === "changed-source") {
        const changed = providerHarness({ multipartImports: true, dataExport: "-- alternate coherent source cut\n" });
        result = await run({ ...approved, stopAfterStage: "export_d1" }, {
          ...changed.dependencies, recoveryPartBytes: dependencies.recoveryPartBytes,
        });
        assert.equal(result.ok, false, "a resumed prefix cannot adopt a different source snapshot");
        assert.equal(result.state.failure.cause, "RECOVERY_MULTIPART_RESUME_BINDING_MISMATCH");
        assert.ok(changed.wranglerCalls.some(({ args }) => args[0] === "d1" && args[1] === "export"));
        assert.equal(changed.importCalls, 0);
        assert.equal(hash(readFileSync(first)), prior);
        passed++;
        continue;
      }
      result = await run({ ...approved, stopAfterStage: "export_d1" }, dependencies);
      assert.equal(hash(readFileSync(first)), prior);
      assert.ok(events.some((event) => event.skipped));
    }
    assert.equal(result.ok, true, `${arm}: export completes ${JSON.stringify(result.state?.failure)}`);
    const state = loadVerifiedRecoveryState(config.statePath, initial.plan);
    const evidence = state.completed.find(({ id }) => id === "export_d1").evidence;
    if (arm === "small") {
      assert.equal(evidence.multipart, undefined);
      assert.equal(statSync(join(artifacts, initial.plan.artifact.relative_name)).isFile(), true);
    } else {
      assert.ok(evidence.multipart.part_count >= 3);
      const sizes = evidence.multipart.parts.map(({ bytes }) => bytes);
      assert.ok(sizes.every((bytes) => bytes <= dependencies.recoveryPartBytes));
      // A homothetic byte model: one physical byte represents this many
      // virtual bytes. It tests part accounting, never claims physical scale.
      const scale = 6_400_000_000 / evidence.artifact_bytes;
      const virtualBytes = sizes.reduce((sum, bytes) => sum + bytes * scale, 0);
      assert.ok(virtualBytes <= 6_400_000_000);
      assert.ok(sizes.every((bytes) => bytes * scale < initial.plan.artifact.max_single_import_bytes));
      assert.ok(6_400_000_000 > initial.plan.artifact.max_single_import_bytes);
      assert.equal(readdirSync(set).length, sizes.length + 1);
    }
    if (["altered", "missing", "reordered", "extra"].includes(arm)) {
      const first = join(set, "part-000001.sql.fbrenc");
      if (arm === "altered") { const bytes = readFileSync(first); bytes[60] ^= 1; writeFileSync(first, bytes); }
      if (arm === "missing") unlinkSync(first);
      if (arm === "extra") writeFileSync(join(set, "unexpected"), "synthetic", { mode: 0o600 });
      if (arm === "reordered") {
        const second = join(set, "part-000002.sql.fbrenc");
        renameSync(first, join(set, "swap")); renameSync(second, first); renameSync(join(set, "swap"), second);
      }
    }
    result = await run(approved, dependencies);
    if (["wrong-final", "lost-import"].includes(arm)) {
      assert.equal(result.ok, false);
      assert.equal(result.state.failure.stage, "restore_d1");
      if (arm === "wrong-final") {
        assert.equal(result.state.failure.cause, "RECOVERY_MULTIPART_TARGET_FINGERPRINT_MISMATCH");
        assert.equal(provider.importCalls, evidence.multipart.part_count);
        assert.equal(changedReadbacks, 1);
      } else {
        assert.equal(provider.importCalls, 1);
        result = await run(approved, dependencies);
        assert.equal(result.ok, false);
        assert.equal(result.state.failure.cause, "RECOVERY_MULTIPART_TARGET_NOT_EMPTY");
        assert.equal(provider.importCalls, 1, "a partial target is never cleared or replayed");
      }
      passed++;
      console.log(`PASS multipart adapter arm ${arm}`);
      continue;
    }
    const negative = ["altered", "missing", "reordered", "extra", "nonempty", "nonempty-at-import"].includes(arm);
    assert.equal(result.ok, !negative, `${arm}: distinct decision ${JSON.stringify(result.state?.failure)}`);
    if (negative) {
      assert.ok(state.completed.some(({ id }) => id === "export_d1"), "real producer reached");
      assert.equal(result.state.failure.stage, arm === "nonempty" ? "prove_target_clean" :
        arm === "nonempty-at-import" ? "restore_d1" : "verify_export");
      if (arm === "nonempty-at-import") {
        assert.equal(cleanReads, 2);
        assert.equal(result.state.failure.stage, "restore_d1");
        assert.equal(result.state.failure.cause, "RECOVERY_MULTIPART_TARGET_NOT_EMPTY");
      } else if (arm === "nonempty") assert.ok(provider.wranglerCalls.some(({ args }) =>
        args[0] === "d1" && args[1] === "execute" && args.some((value) => /user_table_count/.test(value))));
      else assert.equal(result.state.failure.cause, ["altered", "reordered"].includes(arm)
        ? "RECOVERY_MULTIPART_PART_HASH_MISMATCH" : "RECOVERY_MULTIPART_SET_INVENTORY_MISMATCH");
      assert.equal(provider.importCalls, 0);
      assert.ok(result.state.failure);
    } else {
      assert.equal(provider.importCalls, evidence.multipart?.part_count ?? 1);
      assert.equal(verifiedRecoveryStatus(initial.plan, result.state).current_stage, "verify_d1");
      assert.ok(result.state.completed.some(({ id }) => id === "restore_d1"));
      if (evidence.multipart) assert.equal(verifiedRecoveryStatus(initial.plan, result.state).artifact.part_count,
        evidence.multipart.part_count);
    }
    rmSync(directory, { recursive: true, force: true });
    passed++;
    console.log(`PASS multipart adapter arm ${arm}`);
  }
  console.log(`PASS multipart real-adapter cases: ${passed}/13, virtual export 6400000000 bytes; physical parts only`);
}
