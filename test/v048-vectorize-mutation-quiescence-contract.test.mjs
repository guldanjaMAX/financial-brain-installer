import assert from "node:assert/strict";
import test from "node:test";

import {
  V048_VECTORIZE_MUTATION_QUIESCENCE_KIND,
  V048_VECTORIZE_MUTATION_QUIESCENCE_SCOPE,
  V048VectorizeMutationQuiescenceContractError,
  assertV048VectorizeMutationQuiescenceApproval,
  v048TargetResourceFingerprint,
  v048VectorizeMutationQuiescenceApprovalFingerprint,
} from "../operations/v048-vectorize-mutation-quiescence-contract.mjs";

const sourceManifestSha256 = "1".repeat(64);
const targetManifestSha256 = "2".repeat(64);
const target = Object.freeze({
  accountId: "a".repeat(32),
  databaseId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  databaseName: "brain-test-v048-field-target-recovery-gate-a48f1102",
  vectorizeIndex: "brain-test-v048-field-target-recovery-gate-a48f1102",
  workerName: "brain-test-v048-field-target-recovery-gate-a48f1102",
  domain:
    "brain-test-v048-field-target-recovery-gate-a48f1102.example.workers.dev",
});

function binding(override = {}) {
  return {
    sourceManifestSha256,
    targetManifestSha256,
    targetResourceFingerprint: v048TargetResourceFingerprint(target),
    ...override,
  };
}

function expectCode(action, code) {
  assert.throws(action, (error) => {
    assert.equal(error instanceof V048VectorizeMutationQuiescenceContractError, true);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

test("approval is canonical, versioned, and aggregate-only", () => {
  const approvalFingerprint =
    v048VectorizeMutationQuiescenceApprovalFingerprint(binding());
  const attestation = assertV048VectorizeMutationQuiescenceApproval({
    ...binding(),
    approvalFingerprint,
  });

  assert.match(approvalFingerprint, /^[a-f0-9]{64}$/u);
  assert.deepEqual(attestation, {
    schema_version: 1,
    kind: V048_VECTORIZE_MUTATION_QUIESCENCE_KIND,
    approval_fingerprint: approvalFingerprint,
    campaign_identity_sha256: attestation.campaign_identity_sha256,
    target_resource_fingerprint: v048TargetResourceFingerprint(target),
    scope_sha256: attestation.scope_sha256,
    continuous: true,
    interval_start:
      "exact_disposable_target_vectorize_index_creation_or_provisioning",
    interval_end: "recovery_final_active_composite_proof_accepted",
    includes_pending_before_first_provider_observation: true,
    mutation_surfaces_attested: 5,
  });
  assert.match(attestation.campaign_identity_sha256, /^[a-f0-9]{64}$/u);
  assert.match(attestation.scope_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(attestation), true);
  assert.equal(JSON.stringify(attestation).includes(target.accountId), false);
  assert.equal(JSON.stringify(attestation).includes(target.databaseId), false);
  assert.equal(JSON.stringify(attestation).includes(target.vectorizeIndex), false);
});

test("scope covers every competing mutation surface for the full interval", () => {
  assert.deepEqual(V048_VECTORIZE_MUTATION_QUIESCENCE_SCOPE, {
    continuous: true,
    interval_start:
      "exact_disposable_target_vectorize_index_creation_or_provisioning",
    interval_end: "recovery_final_active_composite_proof_accepted",
    includes_pending_before_first_provider_observation: true,
    mutation_surfaces: [
      "cloudflare_dashboard",
      "cloudflare_rest_api",
      "wrangler_cli",
      "cloudflare_api_tokens",
      "all_non_campaign_writers",
    ],
  });
  assert.equal(Object.isFrozen(V048_VECTORIZE_MUTATION_QUIESCENCE_SCOPE), true);
  assert.equal(Object.isFrozen(V048_VECTORIZE_MUTATION_QUIESCENCE_SCOPE.mutation_surfaces), true);
});

test("fingerprint binds both manifests and the exact target resource", () => {
  const baseline = v048VectorizeMutationQuiescenceApprovalFingerprint(binding());
  for (const changed of [
    binding({ sourceManifestSha256: "3".repeat(64) }),
    binding({ targetManifestSha256: "4".repeat(64) }),
    binding({ targetResourceFingerprint: "5".repeat(64) }),
  ]) {
    assert.notEqual(
      v048VectorizeMutationQuiescenceApprovalFingerprint(changed),
      baseline,
    );
  }
  expectCode(
    () => assertV048VectorizeMutationQuiescenceApproval({
      ...binding(),
      approvalFingerprint: "6".repeat(64),
    }),
    "V048_VECTORIZE_MUTATION_QUIESCENCE_APPROVAL_MISMATCH",
  );
});

test("target resource fingerprint uses the verified-recovery identity shape", () => {
  const baseline = v048TargetResourceFingerprint(target);
  assert.match(baseline, /^[a-f0-9]{64}$/u);
  for (const changed of [
    { ...target, accountId: "c".repeat(32) },
    { ...target, databaseId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    { ...target, domain: target.domain.replace("example", "changed") },
  ]) {
    assert.notEqual(v048TargetResourceFingerprint(changed), baseline);
  }
  for (const invalid of [
    { ...target, extra: true },
    { ...target, vectorizeIndex: "other-index" },
    { ...target, domain: target.domain.toUpperCase() },
  ]) {
    expectCode(
      () => v048TargetResourceFingerprint(invalid),
      "V048_VECTORIZE_MUTATION_QUIESCENCE_TARGET_INVALID",
    );
  }
});

test("malformed approval inputs fail closed", () => {
  for (const invalid of [
    null,
    {},
    { ...binding(), sourceManifestSha256: "A".repeat(64) },
    { ...binding(), targetManifestSha256: "short" },
    { ...binding(), targetResourceFingerprint: "not-a-hash" },
    { ...binding(), ignored: true },
  ]) {
    expectCode(
      () => v048VectorizeMutationQuiescenceApprovalFingerprint(invalid),
      "V048_VECTORIZE_MUTATION_QUIESCENCE_INPUT_INVALID",
    );
  }
  expectCode(
    () => assertV048VectorizeMutationQuiescenceApproval({
      ...binding(),
      approvalFingerprint: "bad",
    }),
    "V048_VECTORIZE_MUTATION_QUIESCENCE_APPROVAL_INVALID",
  );
});
