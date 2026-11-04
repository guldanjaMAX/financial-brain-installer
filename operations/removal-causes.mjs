/** Closed, content-free evidence carried from provider observations to apply. */
export const REMOVAL_CAUSES = Object.freeze([
  "explicit_deletion", "window_exit", "scope_or_filter_change",
  "blank_or_quality", "permission_or_visibility", "unknown",
]);

export const removalCause = value => REMOVAL_CAUSES.includes(value) ? value : "unknown";

export function removalCauseCounts(targets, causes) {
  const counts = Object.fromEntries(REMOVAL_CAUSES.map(cause => [cause, 0]));
  for (const target of targets) counts[removalCause(causes?.[target])]++;
  return counts;
}

export function checkedRemovalCauseCounts(value, total) {
  if (!value || Object.keys(value).length !== REMOVAL_CAUSES.length ||
      REMOVAL_CAUSES.some(cause => !Number.isSafeInteger(value[cause]) || value[cause] < 0) ||
      REMOVAL_CAUSES.reduce((sum, cause) => sum + value[cause], 0) !== total) return null;
  return Object.fromEntries(REMOVAL_CAUSES.map(cause => [cause, value[cause]]));
}
