import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DisposableRecoveryTargetEvalCliError,
  main,
  parseDisposableRecoveryTargetEvalArguments,
} from "../operations/disposable-recovery-target-eval-cli.mjs";
import {
  createTestDisposableRecoveryK0Capability,
} from "./helpers/disposable-recovery-k0-capability.mjs";
import {
  createDisposableCampaignAuthorityFixture,
} from "./helpers/disposable-campaign-authority.mjs";

if (process.platform === "win32") {
  test("macOS-only disposable recovery target evaluation CLI suite", {
    skip: "private aggregate receipt DACL proof is intentionally unavailable on Windows",
  }, () => {});
} else {

function networkIsolation(role) {
  return {
    worker_identity_proved: true,
    worker_identity_sha256: (role === "source" ? "8" : "9").repeat(64),
    workers_dev_identity_proved: true,
    worker_previews_disabled: true,
    worker_cache_enabled: false,
    worker_extra_exports: 0,
    worker_tail_consumers: 0,
    worker_assets: false,
    worker_logpush: false,
    cron_triggers: 0,
    routes: 0,
    custom_domains: 0,
  };
}

const A4_CAMPAIGN_AUTHORITY = createDisposableCampaignAuthorityFixture({
  source: {
    workerName: "brain-test-v048-field-source-recovery-gate-a48f1101",
    databaseId: "10000000-0000-4000-8000-000000000011",
    vectorizeIndexName: "brain-test-v048-field-source-recovery-gate-a48f1101",
    deploymentId: "10000000-0000-4000-8000-000000000002",
    versionId: "10000000-0000-4000-8000-000000000001",
    scriptEtag: "source-etag-v048",
    reviewedGenerationSha256: "a".repeat(64),
  },
  target: {
    workerName: "brain-test-v048-field-target-recovery-gate-a48f1102",
    databaseId: "20000000-0000-4000-8000-000000000012",
    vectorizeIndexName: "brain-test-v048-field-target-recovery-gate-a48f1102",
    paused: {
      deploymentId: "20000000-0000-4000-8000-000000000002",
      versionId: "20000000-0000-4000-8000-000000000001",
      scriptEtag: "target-paused-etag-v048",
      reviewedGenerationSha256: "b".repeat(64),
    },
    active: {
      deploymentId: "30000000-0000-4000-8000-000000000002",
      versionId: "30000000-0000-4000-8000-000000000001",
      scriptEtag: "target-active-etag-v048",
      reviewedGenerationSha256: "c".repeat(64),
    },
  },
  sourceNetworkIsolation: networkIsolation("source"),
  targetNetworkIsolation: networkIsolation("target"),
}).authority;

const keychainBinding = Object.freeze({
  candidate_sha: "a".repeat(40),
  candidate_tree_sha: "b".repeat(40),
  package_sha256: "c".repeat(64),
  field_receipt_sha256: "d".repeat(64),
  account_id: "e".repeat(32),
});
const K0 = await createTestDisposableRecoveryK0Capability(keychainBinding);

const hashes = Object.freeze({
  eval: "1".repeat(64),
  plan: "2".repeat(64),
  target: "3".repeat(64),
  execution: "4".repeat(64),
  source: "5".repeat(64),
  wrapper: "6".repeat(64),
  golden: "7".repeat(64),
  keychain: K0.proof.keychain_binding_sha256,
});

const common = Object.freeze({
  "account-id": keychainBinding.account_id,
  "keychain-receipt": "/private/artifacts/v048-disposable-field-keychain-prep.json",
  "source-manifest": "/private/source.manifest.json",
  "target-manifest": "/private/target.manifest.json",
  plan: "/private/plan.json",
  state: "/private/state.json",
  "artifact-directory": "/private/artifacts",
  "wrangler-wrapper": "/private/wrangler",
  golden: "/private/golden.json",
  "source-preflight-receipt": "/private/source-preflight.json",
  "source-phase-receipt": "/private/source-phase.json",
  "seed-receipt": "/private/seed.json",
  "target-preflight-receipt": "/private/target-preflight.json",
  "deployment-receipt": "/private/deployment.json",
});

function argv(command, values = {}) {
  return [command, ...Object.entries({ ...common, ...values }).flatMap(([key, value]) => [
    `--${key}`, value,
  ])];
}

function preparation() {
  return Object.freeze({
    binding: Object.freeze({
      candidate_sha: keychainBinding.candidate_sha,
      candidate_tree_sha: keychainBinding.candidate_tree_sha,
      package_sha256: keychainBinding.package_sha256,
      field_receipt_sha256: keychainBinding.field_receipt_sha256,
      golden_sha256: hashes.golden,
      keychain_binding_sha256: hashes.keychain,
    }),
    approvalFingerprint: hashes.eval,
    plan: Object.freeze({
      plan_fingerprint: hashes.plan,
      target_resource_fingerprint: hashes.target,
      source_resource_fingerprint: hashes.source,
    }),
    state: Object.freeze({ status: "complete" }),
    deployment: Object.freeze({
      value: Object.freeze({
        final_semantic: Object.freeze({
          campaign_authority: A4_CAMPAIGN_AUTHORITY,
        }),
      }),
    }),
    revalidate: () => true,
  });
}

function gate(events = []) {
  return Object.freeze({
    manifestAccountIds: Object.freeze([
      keychainBinding.account_id,
      keychainBinding.account_id,
    ]),
    targetExecutionApprovalFingerprint: hashes.execution,
    wrapperApprovalFingerprint: hashes.wrapper,
    goldenApprovalFingerprint: hashes.golden,
    a4CampaignAuthority: A4_CAMPAIGN_AUTHORITY,
    targetEvaluationTransport: Object.freeze({ marker: true }),
    revalidate: () => true,
    acquireLock: () => { events.push("lock"); return Object.freeze({ token: true }); },
    releaseLock: () => { events.push("release"); return true; },
  });
}

function k0Dependencies() {
  return {
    platform: "darwin",
    createKeychain: () => Object.freeze({}),
    verifyKeychainPrep: async () => K0.proof,
  };
}

test("preview is local-only and prints every independently reviewed fingerprint", async () => {
  let output = "";
  const result = await main(argv("preview"), {
    ...k0Dependencies(),
    inspectPreparation: () => preparation(),
    createGate: () => gate(),
    stdout: (value) => { output += value; },
  });
  assert.equal(result.preview_writes, "none");
  assert.equal(result.execute_writes, "ordinary_aggregate_usage_records_only");
  assert.equal(result.execute_corpus_mutations, false);
  assert.equal(result.execute_provider_mutations, false);
  assert.equal(result.execute_may_create_ordinary_aggregate_usage_records, true);
  assert.equal(result.target_eval_approval_fingerprint, hashes.eval);
  assert.equal(result.keychain_binding_sha256, hashes.keychain);
  assert.equal(result.target_execution_approval_fingerprint, hashes.execution);
  assert.equal(JSON.parse(output).golden_approval_fingerprint, hashes.golden);
});

test("execute binds all approvals, holds the field lock, and emits only aggregate identity", async () => {
  const events = [];
  let output = "";
  const result = await main(argv("execute", {
    receipt: "/private/artifacts/v048-disposable-target-eval-receipt.json",
    "approve-target-eval": hashes.eval,
    "approve-plan": hashes.plan,
    "approve-disposable-target": hashes.target,
    "approve-target-execution": hashes.execution,
    "approve-source-export-blocking": hashes.source,
    "approve-wrapper": hashes.wrapper,
    "approve-golden": hashes.golden,
  }), {
    ...k0Dependencies(),
    inspectPreparation: () => preparation(),
    createGate: () => gate(events),
    runEvaluation: async (input) => {
      events.push("evaluate");
      assert.equal(input.approvalFingerprint, hashes.eval);
      assert.equal(input.keychainProof, K0.proof);
      assert.deepEqual(input.keychainBinding, keychainBinding);
      assert.equal(input.a4CampaignAuthority, A4_CAMPAIGN_AUTHORITY);
      assert.equal(input.transport.marker, true);
      return Object.freeze({
        receipt: Object.freeze({ status: "passed" }),
        receiptSha256: "8".repeat(64),
      });
    },
    stdout: (value) => { output += value; },
  });
  assert.deepEqual(events, ["lock", "evaluate", "release"]);
  assert.equal(result.receipt.status, "passed");
  assert.deepEqual(JSON.parse(output), {
    mode: "v048_disposable_target_eval",
    status: "passed",
    receipt_sha256: "8".repeat(64),
  });
});

test("wrong approval stops before lock or evaluation", async () => {
  const events = [];
  await assert.rejects(
    () => main(argv("execute", {
      receipt: "/private/artifacts/v048-disposable-target-eval-receipt.json",
      "approve-target-eval": "f".repeat(64),
      "approve-plan": hashes.plan,
      "approve-disposable-target": hashes.target,
      "approve-target-execution": hashes.execution,
      "approve-source-export-blocking": hashes.source,
      "approve-wrapper": hashes.wrapper,
      "approve-golden": hashes.golden,
    }), {
      ...k0Dependencies(),
      inspectPreparation: () => preparation(),
      createGate: () => gate(events),
      runEvaluation: async () => { events.push("evaluate"); },
    }),
    (error) => error instanceof DisposableRecoveryTargetEvalCliError &&
      error.code === "DISPOSABLE_RECOVERY_TARGET_EVAL_APPROVAL_INVALID",
  );
  assert.deepEqual(events, []);
});

test("changed evidence or a cross-campaign golden stops before lock", async () => {
  for (const candidate of [
    {
      preparation: { ...preparation(), revalidate: () => false },
      gate: gate(),
      code: "DISPOSABLE_RECOVERY_TARGET_EVAL_EVIDENCE_CHANGED",
    },
    {
      preparation: preparation(),
      gate: { ...gate(), goldenApprovalFingerprint: "f".repeat(64) },
      code: "DISPOSABLE_RECOVERY_TARGET_EVAL_EVIDENCE_INVALID",
    },
  ]) {
    const events = [];
    await assert.rejects(
      () => main(argv("execute", {
        receipt: "/private/artifacts/v048-disposable-target-eval-receipt.json",
        "approve-target-eval": hashes.eval,
        "approve-plan": hashes.plan,
        "approve-disposable-target": hashes.target,
        "approve-target-execution": hashes.execution,
        "approve-source-export-blocking": hashes.source,
        "approve-wrapper": hashes.wrapper,
        "approve-golden": hashes.golden,
      }), {
        ...k0Dependencies(),
        inspectPreparation: () => candidate.preparation,
        createGate: () => ({
          ...candidate.gate,
          acquireLock: () => { events.push("lock"); return {}; },
        }),
        runEvaluation: async () => { events.push("evaluate"); },
      }),
      (error) => error instanceof DisposableRecoveryTargetEvalCliError &&
        error.code === candidate.code,
    );
    assert.deepEqual(events, []);
  }
});

test("CLI rejects a copied K0 proof before gate, lock, or evaluation", async () => {
  const events = [];
  await assert.rejects(
    () => main(argv("preview"), {
      ...k0Dependencies(),
      verifyKeychainPrep: async () => Object.freeze({ ...K0.proof }),
      inspectPreparation: () => preparation(),
      createGate: () => { events.push("gate"); return gate(events); },
      runEvaluation: async () => { events.push("evaluate"); },
    }),
    (error) => error instanceof DisposableRecoveryTargetEvalCliError &&
      error.code === "DISPOSABLE_RECOVERY_TARGET_EVAL_KEYCHAIN_BINDING_INVALID",
  );
  assert.deepEqual(events, []);
});

test("parser rejects omissions, extras, duplicates, and execute flags on preview", () => {
  assert.throws(
    () => parseDisposableRecoveryTargetEvalArguments(argv("preview").slice(0, -2)),
    /DISPOSABLE_RECOVERY_TARGET_EVAL_ARGUMENTS_INVALID/u,
  );
  assert.throws(
    () => parseDisposableRecoveryTargetEvalArguments([
      ...argv("preview"), "--approve-plan", hashes.plan,
    ]),
    /DISPOSABLE_RECOVERY_TARGET_EVAL_ARGUMENTS_INVALID/u,
  );
  assert.throws(
    () => parseDisposableRecoveryTargetEvalArguments([
      ...argv("preview"), "--plan", "/other/plan.json",
    ]),
    /DISPOSABLE_RECOVERY_TARGET_EVAL_ARGUMENTS_INVALID/u,
  );
});

test("direct invocation works through a canonicalized symlink path", {
  skip: process.platform === "win32",
}, () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "target-eval-cli-link-")));
  try {
    const source = realpathSync(join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "operations",
      "disposable-recovery-target-eval-cli.mjs",
    ));
    const linked = join(directory, "brain-v048-disposable-target-eval.mjs");
    symlinkSync(source, linked);
    const result = spawnSync(process.execPath, [linked, "preview"], {
      cwd: directory,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
      shell: false,
      timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr,
      /DISPOSABLE_RECOVERY_TARGET_EVAL_ARGUMENTS_INVALID/u);
    assert.match(result.stderr, /usage: brain-v048-disposable-target-eval/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

}
