// A missing row receipt is not an idle provider. Requiring the entire outbox
// empty covers acceptance before either the global or per-row receipt saved.
// A paused rollback generation additionally closes the upgrade bootstrap door.
import { isUnconfirmedVectorProbe } from "../worker/src/lib/vector-fence-probe.js";
export const ROLLBACK_WRITER_PROOF_SQL = `SELECT schema_version, vector_drain_lease_owner AS owner,
  vector_drain_lease_expires_at AS expires_at,
  (SELECT EXISTS(SELECT 1 FROM vector_outbox WHERE submitted_mutation_id IS NOT NULL)) AS in_flight,
  (SELECT EXISTS(SELECT 1 FROM vector_outbox)) AS pending,
  (SELECT EXISTS(SELECT 1 FROM vector_outbox_retry_state WHERE failure_code='receipt_write_incomplete')) AS ambiguous,
  (SELECT EXISTS(SELECT 1 FROM vector_bootstrap_batches WHERE status <> 'confirmed')) AS bootstrap_pending,
  vector_projection_status AS projection_status,
  vector_projection_mutation_id AS mutation_id,
  vector_projection_submitted_at AS submitted_at
FROM install_state WHERE id=1`;

export function rollbackWriterReading(result) {
  const row = result?.results?.[0];
  const counts = ["in_flight", "pending", "ambiguous", "bootstrap_pending"];
  if (!Array.isArray(result?.results) || result.results.length !== 1 || !row ||
      !["owner", "expires_at", "mutation_id", "submitted_at", "projection_status"].every(key => Object.hasOwn(row, key)) ||
      counts.some(key => !Number.isSafeInteger(row[key]) || row[key] < 0)) {
    throw new Error("complete writer state did not read back");
  }
  const quiet = row.owner === null && row.expires_at === null &&
    counts.every(key => row[key] === 0) && row.projection_status === "verified";
  return { row, quiet };
}

export function rollbackProviderSettled(row, info) {
  if (isUnconfirmedVectorProbe({ mutationId: row.mutation_id })) return false;
  // Accept a provider watermark only for the exact saved mutation. Differing
  // opaque ids and elapsed time are not a proof of ordering at a restore cut.
  if (row.mutation_id === null) return row.submitted_at === null &&
    info?.vectorCount === 0 && info?.processedUpToMutation === null;
  return typeof row.mutation_id === "string" && row.mutation_id.length > 0 &&
    Number.isSafeInteger(row.submitted_at) && row.submitted_at >= 0 &&
    typeof info?.processedUpToMutation === "string" && info.processedUpToMutation === row.mutation_id;
}
