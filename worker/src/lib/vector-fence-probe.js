// An idle provider watermark is not a clock. If an unrecorded mutation
// overtakes our fence inside the skew margin, waiting alone cannot open it.
// A delete of a random, absent ID creates a new ordering receipt without
// changing corpus vectors. Only a later processed-watermark observation opens
// that receipt; the existing exact-generation/absence checks still own cleanup.
export const VECTOR_FENCE_PROBE_AFTER_MS = 10 * 60_000;
export const isUnconfirmedVectorProbe = fence =>
  typeof fence?.mutationId === "string" && fence.mutationId.startsWith("brain-fence-unknown:");

export async function probeStalledVectorFence(env, { fence, description, lease, renewLease }) {
  if (isUnconfirmedVectorProbe(fence)) throw new Error("the vector ordering probe submission is unconfirmed; keep writes paused for supervised recovery");
  const now = lease.now();
  const processed = description?.processedUpToMutation;
  // Do not turn an unavailable/malformed provider into a write. A new index
  // with no processed mutations is ordinary pending work, not an overtaken ID.
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(fence?.submittedAt) ||
      now - fence.submittedAt < VECTOR_FENCE_PROBE_AFTER_MS ||
      !["string", "number"].includes(typeof processed) || String(processed) === "" ||
      String(processed) === fence.mutationId ||
      !Number.isFinite(Date.parse(String(description?.processedUpToDatetime ?? "")))) return false;

  // 48 ASCII bytes, below Vectorize's 64-byte limit. Never accept an ID from
  // a request, source document or caller, and never upsert a synthetic vector.
  const id = `brain-fence:${crypto.randomUUID()}`;
  const intentId = id.replace("brain-fence:", "brain-fence-unknown:");
  const existing = await env.VECTORIZE.getByIds([id]);
  if (!Array.isArray(existing) || existing.length !== 0) {
    throw new Error("the vector ordering probe could not prove its ID absent");
  }
  await renewLease(env, lease.ownerToken, { now: lease.now() });
  const submittedAt = lease.now();
  if (!Number.isSafeInteger(submittedAt) || submittedAt < now) {
    throw new Error("the vector ordering probe clock changed before submission");
  }
  // This writer has no outbox row. Persist its uncertainty BEFORE submission:
  // even a lost provider receipt or failed global-fence write must invalidate
  // an earlier verified state, otherwise rollback could call it quiet.
  const intent = await env.DB.prepare(
    `UPDATE install_state SET vector_projection_status = CASE
        WHEN vector_projection_status='verified' THEN 'pending' ELSE vector_projection_status END,
        vector_projection_mutation_id=?3,vector_projection_submitted_at=?4
      WHERE id=1 AND schema_version>=12
        AND vector_drain_lease_owner=?1 AND vector_drain_lease_expires_at>?2
        AND vector_projection_mutation_id=?5 AND vector_projection_submitted_at=?6`
  ).bind(lease.ownerToken, lease.now(), intentId, submittedAt, fence.mutationId, fence.submittedAt).run();
  if (Number(intent?.meta?.changes ?? intent?.changes ?? 0) !== 1) {
    throw new Error("the vector ordering probe intent lost its lease");
  }
  const receipt = await env.VECTORIZE.deleteByIds([id]);
  const mutationId = receipt?.mutationId;
  if (typeof mutationId !== "string" || !mutationId || mutationId.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(mutationId)) {
    throw new Error("the vector ordering probe returned an invalid mutation receipt");
  }
  const receiptAt = lease.now();
  if (!Number.isSafeInteger(receiptAt) || receiptAt < submittedAt) {
    throw new Error("the vector ordering probe receipt clock changed");
  }
  // Until the accepted receipt replaces this exact intent, uncertainty is
  // durable. Neither an old watermark nor elapsed time can clear it. A crash
  // here requires supervised recovery rather than an automatic recertification.
  const recorded = await env.DB.prepare(
    `UPDATE install_state
        SET vector_projection_mutation_id = ?1,
            vector_projection_submitted_at = ?2
      WHERE id = 1 AND schema_version >= 12
        AND vector_projection_mutation_id = ?3
        AND vector_projection_submitted_at = ?4
        AND vector_drain_lease_owner = ?5
        AND vector_drain_lease_expires_at > ?6`
  ).bind(mutationId, receiptAt, intentId, submittedAt,
    lease.ownerToken, lease.now()).run();
  if (Number(recorded?.meta?.changes ?? recorded?.changes ?? 0) !== 1) {
    throw new Error("the vector ordering probe receipt lost its fence or lease");
  }
  // The accepted receipt's timestamp also limits successful probes to one per
  // ten minutes, across invocations/restarts. A failed call exits the invocation
  // with an error and leaves all pending work intact for a later retry.
  return true;
}
