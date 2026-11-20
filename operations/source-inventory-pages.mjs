import { createInventoryAccumulator, projectSourceFreshness, recoveryPlanSummary } from "../worker/src/lib/source-inventory-merge.js";

export const SOURCE_INVENTORY_HELP_URL = new URL(
  "../onboarding/06-runbook-top-ten-failures.md#source-inventory-is-unavailable", import.meta.url,
).href;

const failure = (code) => { throw Object.assign(new Error(code), { code }); };

/** Only read requests are retried; the accepted cursor and snapshot stay fixed. */
export async function requestInventoryPage(requestPage, payload, {
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now,
  deadline = now() + 600000,
} = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (now() >= deadline) failure("inventory_time_limit");
    let response;
    try { response = await requestPage(payload); }
    catch (error) {
      // Retry a classified transport interruption, never an auth, contract or
      // local credential error. The caller owns those decision boundaries.
      if (error?.retryable !== true || attempt === 3) throw error;
    }
    if (now() >= deadline) failure("inventory_time_limit");
    const temporary = response && ([408, 425, 429].includes(response.status) || response.status >= 500);
    if (response && (!temporary || attempt === 3)) return response;
    if (response?.body) await response.body.cancel();
    // D1's short resource window needs breathing room between bounded pages.
    const delay = [1000, 3000, 10000][attempt];
    if (now() + delay >= deadline) failure("inventory_time_limit");
    await sleep(delay);
  }
}

/** Transport work pages are never exposed as complete source receipts. */
export async function collectBoundedInventory(first, requestPage, { onProgress = () => {},
  maxPages = 1000, now = Date.now, maxDurationMs = 10 * 60 * 1000, validateRows = () => {}, sleep } = {}) {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1000 ||
      !Number.isFinite(maxDurationMs) || maxDurationMs <= 0 || maxDurationMs > 600000) throw new TypeError("invalid inventory bound");
  const mode = first?.kind === "source_freshness_scan" ? "freshness" : "bounded";
  const started = now();
  const accumulator = createInventoryAccumulator();
  let page = first, scanned = 0, receiptsScanned = 0;
  const cursors = new Set();
  for (let number = 1; number <= maxPages; number++) {
    if (now() - started > maxDurationMs) failure("inventory_time_limit");
    if (page?.contract_version !== 3 || page.kind !== first.kind || !["source_inventory_scan", "source_freshness_scan"].includes(page.kind) ||
        !/^[a-f0-9]{64}$/.test(page.snapshot || "") || !Number.isFinite(Date.parse(page.as_of)) ||
        page.snapshot !== first.snapshot || page.as_of !== first.as_of) failure("inventory_snapshot_changed");
    const scan = page.scan;
    const receipts = scan?.receipts;
    if (receipts && (receipts.limit !== 5000 || ![receipts.events, receipts.runs].every(value =>
      Number.isSafeInteger(value) && value >= 0 && value <= receipts.limit))) failure("inventory_contract_invalid");
    const receiptsComplete = !receipts || (receipts.events < receipts.limit && receipts.runs < receipts.limit);
    if (!scan || scan.page !== number || !Number.isSafeInteger(scan.scanned) || scan.scanned < 0 ||
        !Number.isSafeInteger(scan.limit) || scan.limit < 1 || scan.limit > 5000 || scan.scanned > scan.limit ||
        typeof page.complete !== "boolean" || page.truncated !== !page.complete ||
        page.complete !== (scan.scanned < scan.limit && receiptsComplete) || (page.complete ? page.cursor !== null : !page.cursor)) {
      failure("inventory_contract_invalid");
    }
    validateRows(page.sources);
    accumulator.add(page);
    scanned += scan.scanned;
    if (scanned > 5000000) failure("inventory_document_limit");
    receiptsScanned += (receipts?.events || 0) + (receipts?.runs || 0);
    onProgress({ pages: number, scanned, receiptsScanned, maxPages, maxDocuments: 5000000 });
    if (page.complete) {
      const sources = accumulator.finish();
      if (mode === "freshness") return { contract_version: 3, kind: "source_freshness", as_of: page.as_of,
        sources: projectSourceFreshness(sources) };
      return { contract_version: 3, kind: "source_inventory", complete: true,
        total: sources.length, returned: sources.length, truncated: false, cursor: null,
        as_of: page.as_of, snapshot: { id: `sha256:${page.snapshot}`, as_of: page.as_of, stable: true, total: sources.length },
        sources, recovery_plan_summary: recoveryPlanSummary(sources), limitations: page.limitations };
    }
    if (cursors.has(page.cursor)) failure("inventory_cursor_stalled");
    cursors.add(page.cursor);
    if (now() - started >= maxDurationMs) failure("inventory_time_limit");
    if (number === maxPages) break;
    const response = await requestInventoryPage(requestPage,
      { mode, ...(mode === "bounded" ? { limit: page.scan.limit } : {}), cursor: page.cursor },
      { sleep, now, deadline: started + maxDurationMs });
    if (!response.ok) failure(response.status === 409 ? "inventory_snapshot_changed" : "source_inventory_unavailable");
    try { page = await response.json(); } catch { failure("inventory_contract_invalid"); }
  }
  failure("inventory_page_limit");
}
