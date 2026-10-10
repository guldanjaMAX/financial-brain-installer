import { createInventoryAccumulator, recoveryPlanSummary } from "../worker/src/lib/source-inventory-merge.js";

const failure = (code) => { throw Object.assign(new Error(code), { code }); };

/** Transport work pages are never exposed as complete source receipts. */
export async function collectBoundedInventory(first, requestPage, { onProgress = () => {},
  maxPages = 1000, now = Date.now, maxDurationMs = 10 * 60 * 1000, validateRows = () => {} } = {}) {
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
        sources: sources.map(row => {
          const { coverage: _coverage, ...freshness } = row.freshness;
          return { name: row.name, kind: row.kind, freshness, receipt: {
            last_successful_run_at: row.receipt?.last_successful_run_at ?? null,
            latest_run: row.receipt?.latest_run ?? null,
          } };
        }) };
      return { contract_version: 3, kind: "source_inventory", complete: true,
        total: sources.length, returned: sources.length, truncated: false, cursor: null,
        as_of: page.as_of, snapshot: { id: `sha256:${page.snapshot}`, as_of: page.as_of, stable: true, total: sources.length },
        sources, recovery_plan_summary: recoveryPlanSummary(sources), limitations: page.limitations };
    }
    if (cursors.has(page.cursor)) failure("inventory_cursor_stalled");
    cursors.add(page.cursor);
    if (now() - started >= maxDurationMs) failure("inventory_time_limit");
    if (number === maxPages) break;
    const response = await requestPage({ mode, ...(mode === "bounded" ? { limit: 5000 } : {}), cursor: page.cursor });
    if (!response.ok) failure(response.status === 409 ? "inventory_snapshot_changed" : "source_inventory_unavailable");
    try { page = await response.json(); } catch { failure("inventory_contract_invalid"); }
  }
  failure("inventory_page_limit");
}
