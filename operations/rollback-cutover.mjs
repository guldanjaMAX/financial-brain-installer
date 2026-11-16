import { ROLLBACK_WRITER_PROOF_SQL, rollbackWriterReading, rollbackProviderSettled } from './rollback-writer-proof.mjs';

/** A destructive restore needs observed quiet, never an elapsed pause alone. */
export async function requireRollbackWriterQuiescence({
  queryDatabase, accountId, databaseId, waitForCutover, wait, now = Date.now,
  readProvider, cutoverOptions = {},
}) {
  const readNow = cutoverOptions.now ?? now;
  const cutover = await waitForCutover(wait, {
    ...cutoverOptions, nextStep: 'the D1 restore', now: readNow,
    probe: async () => {
      const response = await queryDatabase(accountId, databaseId,
        ROLLBACK_WRITER_PROOF_SQL);
      const row = response?.results?.[0];
      if (response?.results?.length !== 1 || !row ||
          !Number.isSafeInteger(row.schema_version) || row.schema_version < 11 ||
          !(row.owner === null || (typeof row.owner === 'string' && row.owner.length > 0)) ||
          ![0, 1].includes(row.in_flight) ||
          (row.owner !== null && (!Number.isSafeInteger(row.expires_at) || row.expires_at < 1))) {
        throw new Error('The rollback writer state could not be verified');
      }
      // A free lease alone misses accepted writes whose receipt was lost, and
      // an empty outbox alone cannot prove that the provider finished them.
      const reading = rollbackWriterReading(response);
      if (!reading.quiet) return { leaseFree: false, inFlight: 1 };
      return { leaseFree: rollbackProviderSettled(row, await readProvider()), inFlight: 0 };
    },
  });
  if (cutover?.proven !== true) {
    throw Object.assign(new Error('Rollback stopped because writer quiescence was not verified. The Worker remains paused; no D1 restore was started.'),
      { supportCode: 'SAFETY_REVIEW_REQUIRED' });
  }
  return cutover;
}
