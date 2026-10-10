/** Mutation controls for the real daily/provider/Worker regression path. */
import { registerHooks } from "node:module";

const mutations = {
  provider_kind: ["source-receipt.js", 'if (!["drive", "gmail", "imap", "calendar"].includes(kind)) return null;', ""],
  provider_terminal: ["source-receipt.js", 'if (run?.outcome !== "empty" || run.walk_complete !== true || run.metrics_version !== 1) return null;', ""],
  provider_counts: ["source-receipt.js", '.every(field => run[field] === 0)', '.every(() => true)'],
  provider_times: ["source-receipt.js", 'if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return null;', 'if (!Number.isFinite(started) || !Number.isFinite(finished)) return null;'],
  current_start: ["daily-refresh-run.mjs", 'Date.parse(row.latest_run.started_at) >= Date.parse(sourceStartedAt)', "true"],
  future_check: ["daily-refresh-run.mjs", 'Date.parse(check) <= Date.parse(checkedAt)', "true"],
  check_replay: ["daily-refresh-run.mjs", '(!prior || Date.parse(check) > Date.parse(prior))', "true"],
  stable_ingest: ["daily-refresh-run.mjs", 'beforeBySource[name] === afterBySource[name]', "true"],
  reached_loader: ["daily-refresh-run.mjs", '(runResult?.loaded > 0 || runResult?.status === "complete")', "true"],
  execution_status: ["daily-refresh-run.mjs", '(runResult?.status === undefined || ["complete", "partial"].includes(runResult.status))', "true"],
  selected_entry: ["daily-refresh-run.mjs", '&& selectedRan &&', '&& true &&'],
  no_change_admission: ["daily-refresh-run.mjs", 'if (noChangeBySource[index]) return true;', ""],
  every_leg: ["daily-refresh-run.mjs", 'latestRuns.every((_run, index) =>', 'latestRuns.some((_run, index) =>'],
  mixed_evidence: ["daily-refresh-run.mjs", 'noChangeBySource.every(Boolean)', 'noChangeBySource.some(Boolean)'],
  empty_plan: ["daily-refresh-run.mjs", 'sourceResults.length === 0 || ', ""],
  check_projection: ["store-d1.js", 'providerNoChangeCheckAt(kind, latestRun) || inventoryTimestamp(row.last_successful_run_at)', 'inventoryTimestamp(row.last_successful_run_at)'],
  status_projection: ["brain.mjs", ': checked ? "checked"', ': false ? "checked"'],
  zoom_page: ["zoom.js", 'if (!Array.isArray(data?.meetings) ||', 'if (Array.isArray(data?.meetings) ||'],
  zoom_config: ["zoom-deliveries.js", 'configured === 0 ? "not_configured"', 'false ? "not_configured"'],
  zoom_partial_config: ["zoom-deliveries.js", 'configured !== 4 ? "credentials_missing"', 'false ? "credentials_missing"'],
  zoom_cursor: ["zoom-deliveries.js", 'const paginationPending = row?.pagination_pending === 1;', 'const paginationPending = false;'],
  zoom_counts: ["zoom-deliveries.js", 'deliveries[item.status] = Number(item.count)', 'deliveries[item.status] = 0'],
  zoom_completion: ["zoom-deliveries.js", 'completed === null ? null : new Date(completed).toISOString()', 'new Date(now).toISOString()'],
  zoom_future: ["zoom-deliveries.js", '&& row.completed_at_ms <= now', '&& true'],
  zoom_failure: ["zoom-deliveries.js", '["retryable", "unavailable", "refused"].includes(row.status)', 'false'],
  zoom_refusal: ["zoom-deliveries.js", 'deliveries.refused > 0 || deliveries.unavailable > 0', 'false'],
  zoom_lease: ["zoom-deliveries.js", 'row.status === "processing" || deliveries.processing > 0', 'false'],
  zoom_missing: ["zoom-deliveries.js", '!row ? "unknown"', '!row ? "checked"'],
  zoom_stale: ["zoom-deliveries.js", 'now - completed > 24 * 60 * 60 * 1000', 'false'],
  zoom_history: ["zoom-deliveries.js", 'history: { state: "unproven", complete_through: null }', 'history: { state: "complete", complete_through: null }'],
};

const id = process.env.DAILY_EVIDENCE_MUTANT;
if (id) {
  const mutation = mutations[id];
  if (!mutation) throw new Error("unknown daily evidence mutation");
  registerHooks({ load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    const [file, target, replacement] = mutation;
    if (!url.endsWith(`/${file}`)) return loaded;
    const source = String(loaded.source);
    if (source.split(target).length !== 2) throw new Error("daily evidence mutation target is not unique");
    process.stderr.write(`DAILY_MUTATION_REACHED:${id}\n`);
    return { ...loaded, source: source.replace(target, replacement) };
  } });
}
