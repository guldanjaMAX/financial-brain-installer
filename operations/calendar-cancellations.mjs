import { fetchBrainWithAdminKey } from '../components/brain-http.mjs';
import { removalDigest } from './ingest-removal-plan.mjs';

export const calendarCancellationFailure = (marked = 0) => Object.assign(new Error(
  'Calendar cancellation marking could not be confirmed; stored records and the sync position were kept. Retry the refresh. Code: INGEST_FAILED. Help: https://github.com/guldanjaMAX/financial-brain-installer/blob/main/onboarding/06-runbook-top-ten-failures.md#calendar-cancellation-marking',
), { code: 'INGEST_FAILED', marked });

// Old plans are observations, never deletion authority. Only fingerprinted
// explicit-deletion targets may become cancelled; unknown/window exits stay kept.
export function pendingCalendarCancellations(state, source) {
  const plan = state.ingest_removal_plan;
  if (!plan) return { cancellations: [], retained: [] };
  const { fingerprint, ...payload } = plan;
  if (plan.kind !== 'calendar' || plan.source !== source || removalDigest(payload) !== fingerprint ||
      !Array.isArray(plan.targets) || plan.targets.some(uid => typeof uid !== 'string' || !uid.startsWith(`${source}:gcal:`))) {
    throw calendarCancellationFailure();
  }
  const retained = plan.targets.map(uid => ({ source_id: uid.slice(source.length + 1),
    cause: plan.targetCauses?.[uid] || 'unknown',
    status: plan.targetCauses?.[uid] === 'explicit_deletion' ? 'cancelled' : 'kept' }));
  return { retained, cancellations: retained.filter(item => item.status === 'cancelled') };
}

export async function markCalendarCancellations({ base, adminKey, source, cancellations, fetchImpl = fetch, assertOwned }) {
  let marked = 0;
  for (const { source_id } of cancellations) {
    assertOwned?.();
    try {
      const response = await fetchBrainWithAdminKey(fetchImpl, `${base.replace(/\/$/, '')}/api/admin/brain/calendar-cancellation`, {
        method: 'POST', signal: AbortSignal.timeout(60_000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source, source_id }),
      }, () => adminKey);
      const proof = await response.json();
      if (!response.ok || proof?.verified !== true || proof.source !== source || proof.source_id !== source_id ||
          !['kept_cancelled', 'not_stored'].includes(proof.action)) throw calendarCancellationFailure();
      assertOwned?.();
      if (proof.action === 'kept_cancelled') marked++;
    } catch (error) {
      if (error?.code === 'source_ingest_lock_lost') throw error;
      throw calendarCancellationFailure(marked);
    }
  }
  return marked;
}
