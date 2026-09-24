const MISSED_REASON = "SCHEDULE_MISSED";

/** Keep small clock and wake jitter from turning a healthy cadence into noise. */
export function scheduleGraceSeconds(expectedSeconds) {
  const expected = Number(expectedSeconds);
  if (!Number.isFinite(expected) || expected < 60) return 300;
  return Math.max(300, Math.min(3_600, Math.floor(expected * 0.1)));
}

function timestamp(value) {
  if (value === null || value === undefined || value === "") return NaN;
  const parsed = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : NaN;
}

/**
 * Mark healthy scheduled sources that missed one complete cadence plus grace.
 *
 * This is one bounded registry read. ORDER BY the sources primary key and both
 * correlated event lookups use the existing source_events(source_name, at)
 * index. No document, chunk, outbox, or corpus aggregate is touched.
 */
export async function markMissedSourceRuns(env, { now = Date.now() } = {}) {
  const sql =
    `SELECT s.name, s.kind, s.status, s.stale_reason, s.expected_refresh_seconds,
            (SELECT MAX(e.at) FROM source_events e
              WHERE e.source_name=s.name AND e.event='schedule_install') AS schedule_installed_at,
            (SELECT MAX(e.at) FROM source_events e
              WHERE e.source_name=s.name AND e.event='schedule_run') AS last_successful_run_at
       FROM sources s
      WHERE s.expected_refresh_seconds IS NOT NULL
      ORDER BY s.name`;
  const result = await env.DB.prepare(sql).all();
  const rows = result?.results || [];
  const overdue = [];
  const candidates = [];

  for (const source of rows) {
    const expected = Number(source.expected_refresh_seconds);
    if (!Number.isFinite(expected) || expected < 60) continue;
    const installed = timestamp(source.schedule_installed_at);
    const successful = timestamp(source.last_successful_run_at);
    const reference = Number.isFinite(successful) ? successful : installed;
    // A legacy expectation with no install event has no trustworthy start for
    // its first-run clock. It remains waiting, never falsely missed.
    if (!Number.isFinite(reference)) continue;
    const grace = scheduleGraceSeconds(expected);
    if (now <= reference + (expected + grace) * 1000) continue;
    overdue.push(source.name);
    if (String(source.status || "").toLowerCase() === "error") continue;
    if (String(source.stale_reason || "").trim() && source.stale_reason !== MISSED_REASON) continue;
    if (source.stale_reason === MISSED_REASON) continue;
    candidates.push({ ...source, grace });
  }

  if (!candidates.length) {
    return { checked: rows.length, overdue: overdue.length, newly_missed: 0 };
  }

  const at = new Date(now).toISOString();
  const statements = candidates.flatMap((source) => [
    env.DB.prepare(
      `UPDATE sources
          SET stale_reason=?2
        WHERE name=?1
          AND (stale_reason IS NULL OR stale_reason='')
          AND lower(status)<>'error'`
    ).bind(source.name, MISSED_REASON),
    env.DB.prepare(
      `INSERT INTO source_events (source_name,event,at,detail)
       SELECT ?1,'schedule_missed',?2,?3 WHERE changes()=1`
    ).bind(
      source.name,
      at,
      `expected_refresh_seconds=${Number(source.expected_refresh_seconds)} grace_seconds=${source.grace}`,
    ),
  ]);
  const writes = await env.DB.batch(statements);
  let newlyMissed = 0;
  for (let index = 0; index < writes.length; index += 2) {
    const changes = Number(writes[index]?.meta?.changes);
    newlyMissed += Number.isFinite(changes) ? Math.max(0, changes) : 1;
  }
  return { checked: rows.length, overdue: overdue.length, newly_missed: newlyMissed };
}

/** Optional aggregate-only owner hook. No configured URL means no request. */
export async function notifyMissedSources(env, result, { fetchImpl = fetch } = {}) {
  const configured = String(env?.SOURCE_ALERT_WEBHOOK_URL || "").trim();
  if (!configured) return { configured: false, attempted: false, delivered: false };
  if (!Number(result?.newly_missed)) return { configured: true, attempted: false, delivered: false };
  let url;
  try {
    url = new URL(configured);
  } catch {
    return { configured: true, attempted: false, delivered: false };
  }
  if (url.protocol !== "https:") return { configured: true, attempted: false, delivered: false };
  try {
    const response = await fetchImpl(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "source_schedule_missed",
        count: Number(result.newly_missed),
        status_path: "/api/admin/brain/freshness",
        next_action: "Run brain handoff-check to see which source needs its schedule checked.",
      }),
    });
    return { configured: true, attempted: true, delivered: response?.ok === true };
  } catch {
    return { configured: true, attempted: true, delivered: false };
  }
}

export async function runMissedSourceWatchdog(env, options = {}) {
  const result = await markMissedSourceRuns(env, options);
  const alert = await notifyMissedSources(env, result, options);
  return { ...result, alert };
}
