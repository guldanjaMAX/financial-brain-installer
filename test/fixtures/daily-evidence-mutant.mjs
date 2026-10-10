/** Mutation controls for the real daily/provider/Worker regression path. */
import { registerHooks, syncBuiltinESMExports } from "node:module";
import fs from "node:fs";

const mutations = {
  calendar_page_shape: ["google-calendar.mjs", '!Array.isArray(body?.items)', 'false'],
  calendar_token_type: ["google-calendar.mjs", 'typeof token !== "string"', 'false'],
  calendar_token_empty: ["google-calendar.mjs", 'token.length === 0', 'false'],
  calendar_conflicting_tokens: ["google-calendar.mjs", '(body.nextPageToken !== undefined && body.nextSyncToken !== undefined)', 'false'],
  calendar_boundary_write: ["brain.mjs", 'provider_check_complete: authoritativeSnapshot', 'provider_check_complete: true'],
  calendar_boundary_required: ["source-receipt.js", 'if (kind === "calendar" && run.provider_check_complete !== true) return null;', ''],
  calendar_boundary_persist: ["index.js", 'body?.provider_check_complete === true ? 1 : 0', 'true ? 1 : 0'],
  calendar_boundary_projection: ["store-d1.js", 'row.run_provider_check_complete === 1 || row.run_provider_check_complete === true', 'true'],
  source_failure_precedence: ["brain.mjs", 'sourceFailed ? "broken" : ', ''],
  daily_failure_precedence: ["brain.mjs", ': receiptRows.some(row => row?.receipt?.status === "error") || states.includes("broken") ? "broken"', ''],
  zoom_index_required: ["zoom-deliveries.js", 'INDEXED BY zoom_deliveries_status', ''],
  zoom_read_failure: ["zoom-deliveries.js", 'if (!/no such index:\\s*zoom_deliveries_status\\b/i.test(String(error?.message))) throw error;', ''],
  zoom_status_index: ["0054_daily_evidence.sql", 'CREATE INDEX IF NOT EXISTS zoom_deliveries_status ON zoom_deliveries(status);', 'SELECT 1;'],
  zoom_insert_trigger: ["0054_daily_evidence.sql", 'CREATE INDEX IF NOT EXISTS zoom_deliveries_status ON zoom_deliveries(status);', `CREATE INDEX IF NOT EXISTS zoom_deliveries_status ON zoom_deliveries(status);
    CREATE TABLE synthetic_change_log (value INTEGER);
    CREATE TRIGGER synthetic_delivery_insert AFTER INSERT ON zoom_deliveries BEGIN
      INSERT INTO synthetic_change_log VALUES (1);
    END;`],
  zoom_update_trigger: ["0054_daily_evidence.sql", 'CREATE INDEX IF NOT EXISTS zoom_deliveries_status ON zoom_deliveries(status);', `CREATE INDEX IF NOT EXISTS zoom_deliveries_status ON zoom_deliveries(status);
    CREATE TABLE synthetic_change_log (value INTEGER);
    CREATE TRIGGER synthetic_delivery_update AFTER UPDATE OF status ON zoom_deliveries BEGIN
      INSERT INTO synthetic_change_log VALUES (1);
      INSERT INTO synthetic_change_log VALUES (1);
    END;`],
  zoom_delete_trigger: ["0054_daily_evidence.sql", 'CREATE INDEX IF NOT EXISTS zoom_deliveries_status ON zoom_deliveries(status);', `CREATE INDEX IF NOT EXISTS zoom_deliveries_status ON zoom_deliveries(status);
    CREATE TABLE synthetic_change_log (value INTEGER);
    CREATE TRIGGER synthetic_delivery_delete AFTER DELETE ON zoom_deliveries BEGIN
      INSERT INTO synthetic_change_log VALUES (1);
    END;`],
  zoom_unknown_counts: ["zoom-deliveries.js", ': !countsAvailable ? "unknown"', ''],
  zoom_uninitialized_counts: ["zoom-deliveries.js", 'Number.isSafeInteger(item.count) && item.count >= 0', 'true'],
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
  if (mutation[0].endsWith(".sql")) {
    const read = fs.readFileSync;
    fs.readFileSync = function(path, ...args) {
      const source = read.call(this, path, ...args);
      if (!String(path).endsWith(`/${mutation[0]}`)) return source;
      if (String(source).split(mutation[1]).length !== 2) throw new Error("daily SQL mutation target is not unique");
      process.stderr.write(`DAILY_MUTATION_REACHED:${id}\n`);
      return String(source).replace(mutation[1], mutation[2]);
    };
    syncBuiltinESMExports();
  }
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
