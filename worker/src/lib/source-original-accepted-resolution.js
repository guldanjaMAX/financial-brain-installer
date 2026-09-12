/**
 * Transactional admission for one exact accepted source-original resolution.
 *
 * The caller supplies an already-normalized accepted observation plus a proof
 * built by source-original-result-family. This module stores no locator or
 * private retrieval query. Portable history and deployment-local activation
 * are deliberately separate so recovery never inherits Vectorize authority.
 */

import {
  prepareSourceOriginalResultFamilyPersistence,
  sourceOriginalResultFamilyProofStored,
} from "./source-original-result-family.js";

export const SOURCE_ORIGINAL_ACCEPTED_RESOLUTION_CONTRACT_VERSION = 1;

const encoder = new TextEncoder();

export class SourceOriginalAcceptedResolutionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "SourceOriginalAcceptedResolutionError";
    this.status = status;
    this.code = code;
  }
}

const refuse = (code, message, status = 409) => {
  throw new SourceOriginalAcceptedResolutionError(status, code, message);
};

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Id(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value)));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function rowsOf(result) {
  if (!result || !Array.isArray(result.results)) {
    throw new SourceOriginalAcceptedResolutionError(
      503,
      "source_original_accepted_resolution_database_unavailable",
      "accepted resolution database read is unavailable",
    );
  }
  return result.results;
}

function observationFields(value) {
  return {
    contract_version: Number(value.contract_version),
    tenant_id: String(value.tenant_id),
    source: String(value.source),
    original_id: String(value.original_id),
    locator_kind: String(value.locator_kind),
    run_id: String(value.run_id),
    plan_id: String(value.plan_id),
    source_snapshot_id: String(value.source_snapshot_id),
    target_set_hash: String(value.target_set_hash),
    target_count: Number(value.target_count),
    observation_stage: String(value.observation_stage),
    outcome: String(value.outcome),
    reason_code: String(value.reason_code),
    text_state: String(value.text_state),
    original_content_sha256: String(value.original_content_sha256),
    original_byte_count: Number(value.original_byte_count),
    page_count: value.page_count === null ? null : Number(value.page_count),
    page_count_state: String(value.page_count_state),
    result_document_count: Number(value.result_document_count),
    result_document_set_hash: String(value.result_document_set_hash),
    resolves_observation_hash: String(value.resolves_observation_hash),
  };
}

function resolutionFields(value) {
  return {
    contract_version: Number(value.contract_version),
    tenant_id: String(value.tenant_id),
    source: String(value.source),
    original_id: String(value.original_id),
    locator_kind: String(value.locator_kind),
    original_content_sha256: String(value.original_content_sha256),
    original_byte_count: Number(value.original_byte_count),
    resolves_observation_hash: String(value.resolves_observation_hash),
    accepted_observation_hash: String(value.accepted_observation_hash),
    result_document_count: Number(value.result_document_count),
    result_document_set_hash: String(value.result_document_set_hash),
    family_receipt_hash: String(value.family_receipt_hash),
    admission_verification_hash: String(value.admission_verification_hash),
  };
}

function portableResolutionMatches(row, observation, proof) {
  return Number(row.contract_version) === SOURCE_ORIGINAL_ACCEPTED_RESOLUTION_CONTRACT_VERSION &&
    row.tenant_id === observation.tenant_id && row.source === observation.source &&
    row.original_id === observation.original_id && row.locator_kind === observation.locator_kind &&
    row.original_content_sha256 === observation.original_content_sha256 &&
    Number(row.original_byte_count) === observation.original_byte_count &&
    row.resolves_observation_hash === observation.resolves_observation_hash &&
    row.accepted_observation_hash === observation.observation_hash &&
    Number(row.result_document_count) === observation.result_document_count &&
    row.result_document_set_hash === observation.result_document_set_hash &&
    row.family_receipt_hash === proof.familyReceipt.family_receipt_hash;
}

async function readHistory(env, observation) {
  const [resolutionResult, acceptedResult] = await env.DB.batch([
    env.DB.prepare(
      `SELECT sequence,contract_version,tenant_id,source,original_id,locator_kind,
              original_content_sha256,original_byte_count,resolves_observation_hash,
              accepted_observation_hash,result_document_count,result_document_set_hash,
              family_receipt_hash,admission_verification_hash,resolution_hash,admitted_at
         FROM source_original_accepted_resolutions
        WHERE source=?1 AND original_id=?2
          AND (resolves_observation_hash=?3 OR accepted_observation_hash=?4)
        ORDER BY sequence LIMIT 3`,
    ).bind(
      observation.source,
      observation.original_id,
      observation.resolves_observation_hash,
      observation.observation_hash,
    ),
    env.DB.prepare(
      `SELECT sequence,contract_version,tenant_id,source,original_id,locator_kind,
              run_id,plan_id,source_snapshot_id,target_set_hash,target_count,
              observation_stage,outcome,reason_code,text_state,original_content_sha256,
              original_byte_count,page_count,page_count_state,result_document_count,
              result_document_set_hash,resolves_observation_hash,observation_hash,recorded_at
         FROM source_original_observations
        WHERE (source=?1 AND original_id=?2 AND observation_hash=?3)
           OR (run_id=?4 AND original_id=?2)
        ORDER BY sequence LIMIT 3`,
    ).bind(
      observation.source,
      observation.original_id,
      observation.observation_hash,
      observation.run_id,
    ),
  ]);
  return {
    resolutions: rowsOf(resolutionResult),
    observations: rowsOf(acceptedResult),
  };
}

async function currentActivation(env, resolutionHash, verificationHash) {
  const result = await env.DB.prepare(
    `SELECT activation.activation_hash,activation.activated_at
       FROM source_original_current_accepted_resolutions current
       JOIN source_original_accepted_resolution_activations activation
         ON activation.resolution_hash=current.resolution_hash
       JOIN source_original_current_result_family_verifications verification
         ON verification.verification_hash=activation.verification_hash
        AND verification.family_receipt_hash=current.family_receipt_hash
      WHERE current.resolution_hash=?1 AND activation.verification_hash=?2
      LIMIT 2`,
  ).bind(resolutionHash, verificationHash).all();
  const rows = rowsOf(result);
  if (rows.length !== 1) return null;
  const activatedAt = Number(rows[0].activated_at);
  const expectedActivationHash = await activationHash(resolutionHash, verificationHash, activatedAt);
  if (rows[0].activation_hash !== expectedActivationHash) {
    throw new SourceOriginalAcceptedResolutionError(
      503,
      "source_original_accepted_resolution_corrupt",
      "stored accepted resolution activation integrity check failed",
    );
  }
  return {
    activationHash: expectedActivationHash,
    activatedAt,
  };
}

async function exactHistory(env, observation, proof) {
  const history = await readHistory(env, observation);
  if (history.resolutions.length === 0 && history.observations.length === 0) return null;
  if (history.resolutions.length !== 1 || history.observations.length !== 1) {
    refuse(
      "source_original_accepted_resolution_conflict",
      "stored accepted resolution history does not match the exact request",
    );
  }
  const resolution = history.resolutions[0];
  const accepted = history.observations[0];
  if (!portableResolutionMatches(resolution, observation, proof) ||
      canonical(observationFields(accepted)) !== canonical(observationFields(observation)) ||
      accepted.observation_hash !== observation.observation_hash ||
      Number(accepted.recorded_at) !== Number(resolution.admitted_at)) {
    refuse(
      "source_original_accepted_resolution_conflict",
      "stored accepted resolution history does not match the exact request",
    );
  }
  const expectedResolutionHash = await sha256Id(canonical(resolutionFields(resolution)));
  if (resolution.resolution_hash !== expectedResolutionHash) {
    throw new SourceOriginalAcceptedResolutionError(
      503,
      "source_original_accepted_resolution_corrupt",
      "stored accepted resolution integrity check failed",
    );
  }
  return {
    resolutionHash: String(resolution.resolution_hash),
    admittedAt: Number(resolution.admitted_at),
    admissionVerificationHash: String(resolution.admission_verification_hash),
  };
}

function admissionStatement(env, {
  observation,
  proof,
  resolutionHash,
  activationHash,
  recordedAt,
  activatedAt,
}) {
  return env.DB.prepare(
    `INSERT INTO source_original_accepted_resolution_admissions
       (resolution_hash,contract_version,tenant_id,source,original_id,locator_kind,
        run_id,plan_id,source_snapshot_id,target_set_hash,target_count,text_state,
        original_content_sha256,original_byte_count,page_count,page_count_state,
        result_document_count,result_document_set_hash,resolves_observation_hash,
        accepted_observation_hash,family_receipt_hash,verification_hash,
        activation_hash,recorded_at,activated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,
             ?18,?19,?20,?21,?22,?23,?24,?25)`,
  ).bind(
    resolutionHash,
    observation.contract_version,
    observation.tenant_id,
    observation.source,
    observation.original_id,
    observation.locator_kind,
    observation.run_id,
    observation.plan_id,
    observation.source_snapshot_id,
    observation.target_set_hash,
    observation.target_count,
    observation.text_state,
    observation.original_content_sha256,
    observation.original_byte_count,
    observation.page_count,
    observation.page_count_state,
    observation.result_document_count,
    observation.result_document_set_hash,
    observation.resolves_observation_hash,
    observation.observation_hash,
    proof.familyReceipt.family_receipt_hash,
    proof.verification.verification_hash,
    activationHash,
    recordedAt,
    activatedAt,
  );
}

async function newResolutionHash(observation, proof) {
  return sha256Id(canonical(resolutionFields({
    contract_version: SOURCE_ORIGINAL_ACCEPTED_RESOLUTION_CONTRACT_VERSION,
    tenant_id: observation.tenant_id,
    source: observation.source,
    original_id: observation.original_id,
    locator_kind: observation.locator_kind,
    original_content_sha256: observation.original_content_sha256,
    original_byte_count: observation.original_byte_count,
    resolves_observation_hash: observation.resolves_observation_hash,
    accepted_observation_hash: observation.observation_hash,
    result_document_count: observation.result_document_count,
    result_document_set_hash: observation.result_document_set_hash,
    family_receipt_hash: proof.familyReceipt.family_receipt_hash,
    admission_verification_hash: proof.verification.verification_hash,
  })));
}

async function activationHash(resolutionHash, verificationHash, activatedAt) {
  return sha256Id(canonical({
    contract_version: SOURCE_ORIGINAL_ACCEPTED_RESOLUTION_CONTRACT_VERSION,
    tenant_id: "primary",
    resolution_hash: resolutionHash,
    verification_hash: verificationHash,
    activated_at: activatedAt,
  }));
}

/**
 * Record or reactivate one accepted resolution. Missing deployment-local
 * verification and the admission statement are submitted in one D1 batch.
 */
export async function recordSourceOriginalAcceptedResolution(
  env,
  { observation, proof },
  { now = Date.now() } = {},
) {
  let history = await exactHistory(env, observation, proof);
  const hadPortableHistory = history !== null;
  const resolutionHash = history?.resolutionHash || await newResolutionHash(observation, proof);
  const activatedAt = now;
  const recordedAt = history?.admittedAt ?? now;

  const currentBefore = history && await sourceOriginalResultFamilyProofStored(env, proof)
    ? await currentActivation(env, resolutionHash, proof.verification.verification_hash)
    : null;
  if (currentBefore) {
    return {
      resolution_hash: resolutionHash,
      activation_hash: currentBefore.activationHash,
      recorded: false,
      replayed: true,
      reactivated: false,
    };
  }

  const familyPlan = await prepareSourceOriginalResultFamilyPersistence(
    env,
    proof,
    { operation: "accepted_resolution", recordedAt: activatedAt },
  );
  const localActivationHash = await activationHash(
    resolutionHash,
    proof.verification.verification_hash,
    activatedAt,
  );
  const statements = [
    ...familyPlan.statements,
    admissionStatement(env, {
      observation,
      proof,
      resolutionHash,
      activationHash: localActivationHash,
      recordedAt,
      activatedAt,
    }),
  ];
  let batchFailed = false;
  try {
    await env.DB.batch(statements);
  } catch {
    // Another exact writer may have won. Only the full hash-checked readback
    // below can reconcile that race.
    batchFailed = true;
  }

  history = await exactHistory(env, observation, proof);
  const exactProofStored = await sourceOriginalResultFamilyProofStored(env, proof);
  const exactCurrent = history && exactProofStored
    ? await currentActivation(env, history.resolutionHash, proof.verification.verification_hash)
    : null;
  if (!exactCurrent) {
    throw new SourceOriginalAcceptedResolutionError(
      503,
      "source_original_accepted_resolution_record_unavailable",
      "the exact accepted resolution was not atomically recorded",
    );
  }
  return {
    resolution_hash: history.resolutionHash,
    activation_hash: exactCurrent.activationHash,
    recorded: !batchFailed,
    replayed: batchFailed,
    reactivated: hadPortableHistory,
  };
}

/** Verify current authority without creating a verification or activation. */
export async function verifySourceOriginalAcceptedResolution(env, { observation, proof }) {
  const history = await exactHistory(env, observation, proof);
  const current = history && await sourceOriginalResultFamilyProofStored(env, proof)
    ? await currentActivation(env, history.resolutionHash, proof.verification.verification_hash)
    : null;
  if (!current) {
    throw new SourceOriginalAcceptedResolutionError(
      409,
      "source_original_accepted_resolution_reverification_required",
      "accepted history exists only as portable evidence until this deployment records a fresh exact verification",
    );
  }
  return {
    resolution_hash: history.resolutionHash,
    activation_hash: current.activationHash,
    recorded: false,
    replayed: true,
    reactivated: false,
  };
}
