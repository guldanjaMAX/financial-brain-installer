import { createHash } from "node:crypto";

import {
  createCloudflareDisposableCampaignSemanticAuthority,
} from "../../operations/cloudflare-disposable-deployment-provider.mjs";
import {
  createCloudflareDisposableCampaignCustodyProof,
  createCloudflareDisposableCampaignGenerationAuthority,
  createCloudflareDisposableCampaignVectorizeInstanceAuthority,
} from "../../operations/cloudflare-disposable-deployment-transport.mjs";
import {
  verifyV048ExclusiveCampaignResourceCustodyWithAuthority,
} from "../../operations/v048-exclusive-resource-custody-contract.mjs";

const digest = (value) => createHash("sha256").update(String(value)).digest("hex");

function nonCampaignEvidence(workerName, bindingText, deployedOn) {
  const workerId = "noncampaign-worker-id";
  const deploymentId = "90000000-0000-4000-8000-000000000009";
  const versionId = "90000000-0000-4000-8000-000000000010";
  return {
    initial: { id: workerId, name: workerName, deployed_on: deployedOn },
    evidence: {
      workerId,
      workerName,
      deploymentList: {
        deployments: [{
          created_on: deployedOn,
          id: deploymentId,
          strategy: "percentage",
          versions: [{ percentage: 100, version_id: versionId }],
        }],
      },
      trafficVersions: [{
        id: versionId,
        resources: {
          bindings: [{
            name: "NONCAMPAIGN_FIXTURE",
            type: "plain_text",
            text: bindingText,
          }],
        },
      }],
    },
  };
}

/**
 * Produce a fully recomputable synthetic A4/A12 authority. The fixture uses
 * production builders and validators, so changing an outer hash cannot make a
 * changed semantic preimage valid.
 */
export function createDisposableCampaignAuthorityFixture({
  source,
  target,
  sourceNetworkIsolation,
  targetNetworkIsolation,
  targetMode = "paused",
  nonCampaignBindingText = null,
  deployedOn = "2026-09-12T12:00:00.000Z",
  sourceVectorizeCreatedOn = deployedOn,
  targetVectorizeCreatedOn = deployedOn,
}) {
  const targetVersion = targetMode === "paused" ? target.paused : target.active;
  const targetDeploymentId = targetMode === "paused"
    ? target.paused.deploymentId
    : target.active.deploymentId;
  const extra = nonCampaignBindingText === null
    ? null
    : nonCampaignEvidence(
      target.nonCampaignWorkerName ?? "ordinary-unrelated-worker",
      nonCampaignBindingText,
      deployedOn,
    );
  const initialWorkers = [
    { id: source.workerId ?? "source-worker-id", name: source.workerName, deployed_on: deployedOn },
    { id: target.workerId ?? "target-worker-id", name: target.workerName, deployed_on: deployedOn },
    ...(extra ? [extra.initial] : []),
  ];
  const custody = verifyV048ExclusiveCampaignResourceCustodyWithAuthority({
    campaignResources: {
      teardownRole: "source",
      source: {
        workerName: source.workerName,
        workerState: "present",
        d1DatabaseId: source.databaseId,
        vectorizeIndexName: source.vectorizeIndexName,
      },
      target: {
        workerName: target.workerName,
        workerState: "present",
        d1DatabaseId: target.databaseId,
        vectorizeIndexName: target.vectorizeIndexName,
      },
    },
    initialWorkerList: {
      total_count: initialWorkers.length,
      workers: initialWorkers,
    },
    nonCampaignWorkers: extra ? [extra.evidence] : [],
  });

  const sourceGeneration = createCloudflareDisposableCampaignGenerationAuthority({
    role: "source",
    mode: "active",
    worker_identity_sha256: sourceNetworkIsolation.worker_identity_sha256,
    deployment_id: source.deploymentId,
    version_id: source.versionId,
    reviewed_worker_generation_sha256: source.reviewedGenerationSha256,
  });
  const targetGeneration = createCloudflareDisposableCampaignGenerationAuthority({
    role: "target",
    mode: targetMode,
    worker_identity_sha256: targetNetworkIsolation.worker_identity_sha256,
    deployment_id: targetDeploymentId,
    version_id: targetVersion.versionId,
    reviewed_worker_generation_sha256: targetVersion.reviewedGenerationSha256,
  });
  const vectorizeInstanceAuthority = Object.freeze(Object.fromEntries(
    ["source", "target"].map((role) => [role,
      createCloudflareDisposableCampaignVectorizeInstanceAuthority({
        role,
        index_name: role === "source"
          ? source.vectorizeIndexName
          : target.vectorizeIndexName,
        dimensions: 768,
        metric: "cosine",
        created_on: role === "source"
          ? sourceVectorizeCreatedOn
          : targetVectorizeCreatedOn,
      })]),
  ));
  const roleProof = (role, generation) => ({
    state: { worker: "present", d1: "present", vectorize: "present" },
    worker_instance_sha256: digest(`${role}-worker-instance:${generation.deployment_id}`),
    d1_instance_sha256: digest(`${role}-d1-instance`),
    vectorize_instance_sha256:
      vectorizeInstanceAuthority[role].instance_sha256,
    worker_protection: {
      schema_version: 1,
      worker_identity_proved: true,
      worker_identity_sha256: generation.worker_identity_sha256,
      worker_reference_snapshot_sha256: digest(`${role}-worker-reference`),
      reviewed_worker_generation_sha256:
        generation.reviewed_worker_generation_sha256,
      worker_generation_proved: true,
      worker_generation_sha256: generation.worker_generation_sha256,
    },
  });
  const proof = createCloudflareDisposableCampaignCustodyProof({
    teardown_role: "source",
    roles: {
      source: roleProof("source", sourceGeneration),
      target: roleProof("target", targetGeneration),
    },
    campaign_custody: custody.receipt,
    campaign_custody_authority: custody.authority,
    generation_authority: {
      source: sourceGeneration,
      target: targetGeneration,
    },
    vectorize_instance_authority: vectorizeInstanceAuthority,
  });
  const approvedVersions = {
    source: {
      version_id: source.versionId,
      script_etag: source.scriptEtag,
      reviewed_worker_generation_sha256: source.reviewedGenerationSha256,
    },
    target_paused: {
      version_id: target.paused.versionId,
      script_etag: target.paused.scriptEtag,
      reviewed_worker_generation_sha256:
        target.paused.reviewedGenerationSha256,
    },
    target_active: {
      version_id: target.active.versionId,
      script_etag: target.active.scriptEtag,
      reviewed_worker_generation_sha256:
        target.active.reviewedGenerationSha256,
    },
  };
  const authority = createCloudflareDisposableCampaignSemanticAuthority({
    target_mode: targetMode,
    approved_versions: approvedVersions,
    campaign_custody: proof,
    source_network_isolation: sourceNetworkIsolation,
    target_network_isolation: targetNetworkIsolation,
  });
  return Object.freeze({ custody: proof, authority });
}
