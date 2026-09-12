/**
 * report — the monthly health report for a brain install.
 *
 *   brain report <manifest> [--out report.md]
 *
 * This is the artifact the monthly fee buys. It exists because "the brain is
 * running" is invisible: a knowledge system that quietly stops ingesting looks
 * exactly like one that is working until someone asks a question it should
 * have answered. The report makes the invisible thing visible once a month.
 *
 * It is deliberately written FOR THE CLIENT, not for us. Every line has to
 * mean something to a business owner who does not know what a vector is. A
 * report they cannot read is a report that justifies nothing.
 *
 * It also states what is NOT working. A monthly report that only ever says
 * "all good" trains the reader to stop opening it, and then it stops being
 * worth paying for. Bad news is the reason it has value.
 */

import { Acceptance } from "./acceptance.mjs";
import { fetchBrainWithAdminKey } from "./components/brain-http.mjs";

const num = (n) => Number(n || 0).toLocaleString("en-US");

const finiteCount = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : null;
};

const firstCount = (...values) => {
  for (const value of values) {
    const count = finiteCount(value);
    if (count !== null) return count;
  }
  return null;
};

const sumKnown = (rows, pick) => {
  if (!rows.length) return 0;
  const counts = rows.map(pick);
  return counts.every((count) => count !== null)
    ? counts.reduce((total, count) => total + count, 0)
    : null;
};

/**
 * Keep the three corpus units distinct. Legacy Workers used `total` for chunks,
 * never documents, and `embedded` for chunks whose semantic projection had
 * cleared the durable visibility queue.
 */
export function corpusReportCounts(corpus) {
  const rows = Array.isArray(corpus?.rows) ? corpus.rows : [];
  return {
    rows,
    logicalDocuments: sumKnown(rows, (row) =>
      firstCount(row?.logical_documents, row?.documents)),
    extractedChunks: sumKnown(rows, (row) =>
      firstCount(row?.chunks, row?.total)),
    semanticVisibleChunks: sumKnown(rows, (row) => finiteCount(row?.embedded)),
  };
}

/**
 * Read the complete authenticated source-registry snapshot. Older Workers do
 * not have this route; callers turn that into an explicit unknown rather than
 * substituting the local manifest.
 */
export async function collectSourceInventorySnapshot({
  base,
  adminKey,
  fetchImpl = fetch,
  pageLimit = 250,
}) {
  const root = String(base || "").replace(/\/+$/, "");
  let cursor = null;
  let snapshotId = null;
  let expectedTotal = null;
  const sources = [];
  const seen = new Set();

  for (let page = 0; page < 64; page++) {
    const response = await fetchBrainWithAdminKey(fetchImpl, `${root}/api/admin/brain/sources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "inventory", limit: pageLimit, ...(cursor ? { cursor } : {}) }),
    }, () => adminKey);
    if (!response.ok) {
      throw new Error(`authenticated source inventory returned HTTP ${response.status}`);
    }

    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error("authenticated source inventory returned an unreadable response");
    }
    if (!body || body.kind !== "source_inventory" || !Array.isArray(body.sources)) {
      throw new Error("authenticated source inventory returned an unrecognized response");
    }
    if (!Number.isSafeInteger(body.total) || body.total < 0) {
      throw new Error("authenticated source inventory omitted its total");
    }
    const currentSnapshot = String(body.snapshot?.id || "");
    if (!currentSnapshot) {
      throw new Error("authenticated source inventory omitted its snapshot receipt");
    }
    if (snapshotId && snapshotId !== currentSnapshot) {
      throw new Error("authenticated source inventory changed during collection");
    }
    snapshotId = currentSnapshot;
    if (expectedTotal !== null && expectedTotal !== body.total) {
      throw new Error("authenticated source inventory total changed during collection");
    }
    expectedTotal = body.total;

    for (const source of body.sources) {
      const id = String(source?.source_id || source?.name || "");
      if (!id || seen.has(id)) {
        throw new Error("authenticated source inventory repeated or omitted a source identity");
      }
      seen.add(id);
      sources.push(source);
    }

    if (body.truncated !== true) {
      if (body.complete !== true || sources.length !== expectedTotal) {
        throw new Error("authenticated source inventory did not prove a complete snapshot");
      }
      return {
        ...body,
        complete: true,
        truncated: false,
        returned: sources.length,
        cursor: null,
        sources,
      };
    }
    if (typeof body.cursor !== "string" || !body.cursor) {
      throw new Error("authenticated source inventory stopped before its next page");
    }
    cursor = body.cursor;
  }
  throw new Error("authenticated source inventory exceeded the bounded page limit");
}

const isoDay = (value) => {
  const millis = Date.parse(String(value || ""));
  return Number.isFinite(millis) ? new Date(millis).toISOString().slice(0, 10) : null;
};

const sourceLabel = (source) => {
  const kind = String(source?.kind || "").toLowerCase();
  return {
    drive: "Google Drive",
    gmail: "Gmail",
    calendar: "Google Calendar",
    quickbooks: "QuickBooks",
    qbo: "QuickBooks",
    upload: "Manual uploads",
    imap: "Email",
    imessage: "iMessage",
    whatsapp: "WhatsApp",
    zoom: "Zoom",
    slack: "Slack",
    notion: "Notion",
    microsoft: "Microsoft 365",
    dropbox: "Dropbox",
    hubspot: "HubSpot",
    plaid: "Bank feed",
  }[kind] || source?.source_id || source?.name || kind || "Source";
};

/** Human-readable statements that never extend beyond authenticated receipts. */
export function sourceReceiptSummary(source) {
  const freshness = source?.freshness && typeof source.freshness === "object"
    ? source.freshness
    : {};
  const receipt = source?.receipt && typeof source.receipt === "object"
    ? source.receipt
    : {};
  const coverage = freshness?.coverage && typeof freshness.coverage === "object"
    ? freshness.coverage
    : {};
  const state = String(freshness.state || "unknown").toLowerCase();
  const expected = finiteCount(freshness.expected_refresh_seconds);
  const latestRun = receipt.latest_run && typeof receipt.latest_run === "object"
    ? receipt.latest_run
    : {};
  const latestOutcome = String(latestRun.outcome || "").toLowerCase();
  const latestWalkComplete = latestRun.walk_complete === true || Number(latestRun.walk_complete) === 1;
  const latestRefused = finiteCount(latestRun.docs_refused);
  const latestFailed = finiteCount(latestRun.docs_failed);
  const lastSuccessful = isoDay(receipt.last_successful_run_at);
  const lastSuccessfulMs = Date.parse(String(receipt.last_successful_run_at || ""));
  const latestFinishedMs = Date.parse(String(latestRun.finished_at || ""));
  const latestWasSuccessful = Number.isFinite(lastSuccessfulMs) &&
    Number.isFinite(latestFinishedMs) && lastSuccessfulMs === latestFinishedMs;
  const lastReceipt = isoDay(receipt.last_ingest_receipt_at || freshness.last_ingest_at);
  const completeThrough = isoDay(receipt.complete_history_through || freshness.last_complete_sweep_at);

  let currency;
  if (["failed", "refused"].includes(latestOutcome)) {
    currency = "needs attention; the latest authenticated ingest did not succeed";
  } else if (latestOutcome === "partial" && ((latestRefused || 0) > 0 || (latestFailed || 0) > 0)) {
    currency = "needs attention; the latest authenticated run left one or more documents unaccepted";
  } else if (latestOutcome === "partial" && !latestWalkComplete) {
    currency = latestWasSuccessful
      ? "the latest authenticated ingest succeeded, but its source walk was bounded or incomplete"
      : "the latest authenticated run was bounded or did not complete its source walk; whole-source currentness remains unproven";
  } else if (latestOutcome === "partial") {
    currency = "needs attention; the latest authenticated run did not establish complete source coverage";
  } else if (latestOutcome === "in_progress") {
    currency = "refresh in progress; currentness is not yet confirmed";
  } else if (state === "ok" && expected !== null) {
    currency = "current against the authenticated refresh expectation";
  } else if (state === "stale") {
    currency = "late against the authenticated refresh expectation";
  } else if (["broken", "review"].includes(state)) {
    currency = "needs attention according to the authenticated source status";
  } else if (state === "indexing") {
    currency = "refresh in progress; currentness is not yet confirmed";
  } else if (state === "never_synced") {
    currency = "no successful ingest has been recorded";
  } else if (state === "unregistered") {
    currency = "not registered; currentness is unknown";
  } else {
    currency = "freshness unverified; no authenticated refresh expectation proves currentness";
  }

  const historyState = String(coverage.history?.state || "unknown").toLowerCase();
  const latestFailedOrRefused = ["failed", "refused"].includes(latestOutcome);
  const history = latestOutcome === "partial" && completeThrough
    ? latestWalkComplete
      ? `last complete sweep recorded through ${completeThrough}; the newer run left document gaps and did not extend that boundary`
      : `last complete sweep recorded through ${completeThrough}; the newer run did not prove another complete walk or extend that boundary`
    : latestFailedOrRefused && completeThrough
    ? `last complete sweep recorded through ${completeThrough}; the newer run needs attention and did not extend that boundary`
    : latestOutcome === "partial"
      ? "the latest run did not prove a complete walk; historical completeness remains unverified"
      : latestFailedOrRefused || historyState === "needs_attention"
      ? "history needs attention; historical completeness unverified"
      : historyState === "running" && completeThrough
        ? `history sweep in progress; the last complete sweep remains through ${completeThrough}`
        : historyState === "running"
          ? "history sweep in progress; completeness remains unproven"
          : historyState === "complete" || completeThrough
            ? `complete sweep recorded${completeThrough ? ` through ${completeThrough}` : ""}`
            : historyState === "not_started"
              ? "no complete history sweep recorded"
              : "historical completeness unverified";

  const ingest = lastSuccessful
    ? `last successful ingest receipt ${lastSuccessful}`
    : lastReceipt
      ? `last ingest receipt ${lastReceipt}; successful-run date not recorded`
      : "no successful ingest receipt date available";
  const run = latestOutcome && latestOutcome !== "completed"
    ? `latest run outcome ${latestOutcome}`
    : null;
  const reason = ["broken", "review", "stale"].includes(state) && freshness.reason
    ? String(freshness.reason)
    : null;

  return {
    label: sourceLabel(source),
    currency,
    history,
    ingest,
    run,
    reason,
  };
}

/**
 * Turn corpus rows into a sentence a business owner understands.
 * "message" and "drive_file" are our words, not theirs.
 */
const FRIENDLY = {
  drive_file: "documents and files",
  message: "messages and email",
  meeting: "meeting transcripts",
  curated: "notes and lessons",
  lead: "contacts",
  email_track: "tracked emails",
  calendar_event: "calendar events",
  custom: "other documents",
};

export async function buildReport({
  base,
  adminKey,
  manifest,
  installState,
  upgradeRuns,
  spend,
  fetchImpl = fetch,
}) {
  const suite = new Acceptance({ base, adminKey, manifest, fetchImpl });
  const acc = await suite.run({
    probes: manifest.testing?.probe_questions || [],
    installState,
  });

  let docs = null;
  try {
    const docsRes = await fetchBrainWithAdminKey(
      fetchImpl,
      `${base}/api/admin/brain/documents`,
      {},
      () => adminKey,
    );
    if (docsRes.ok) docs = await docsRes.json();
  } catch {
    // The report remains useful, but the counts below must stay unknown.
  }
  const counts = corpusReportCounts(docs);
  const { rows, logicalDocuments, extractedChunks, semanticVisibleChunks } = counts;

  let sourceInventory = null;
  let sourceInventoryError = null;
  try {
    sourceInventory = await collectSourceInventorySnapshot({
      base,
      adminKey,
      fetchImpl,
    });
  } catch (error) {
    sourceInventoryError = String(error?.message || error || "source inventory unavailable");
  }

  const name = manifest.client?.display_name || manifest.client?.slug || "your";
  const month = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const L = [];
  L.push(`# ${name} Brain: ${month}`);
  L.push("");

  /* --------------------------------------------------------- the verdict */
  // Headline first. Someone who reads one line should get the true answer.
  const failures = acc.results.filter((r) => r.status === "fail");
  const warnings = acc.results.filter((r) => r.status === "warn");
  if (failures.length === 0 && warnings.length === 0) {
    L.push("**The automated checks passed.** Continue handoff from the source receipts and adaptive evidence review.");
  } else if (failures.length === 0) {
    L.push(`**Working, with ${warnings.length} thing${warnings.length === 1 ? "" : "s"} worth knowing about.** Details below.`);
  } else {
    L.push(`**${failures.length} problem${failures.length === 1 ? "" : "s"} need attention.** Details below.`);
  }
  L.push("");

  /* ------------------------------------------------------------ what is in it */
  L.push("## What is stored and searchable");
  L.push("");
  if (!docs || !Array.isArray(docs.rows)) {
    L.push("The authenticated corpus count was unavailable, so document and chunk totals are **unknown**.");
    L.push("");
  } else if (!rows.length) {
    L.push("The authenticated corpus summary returned **zero source rows** for this snapshot.");
    L.push("");
  } else {
    L.push(`- Logical documents: **${logicalDocuments === null ? "not reported" : num(logicalDocuments)}**`);
    L.push(`- Extracted keyword-searchable chunks: **${extractedChunks === null ? "not reported" : num(extractedChunks)}**`);
    L.push(`- Visibility-confirmed semantic chunks: **${semanticVisibleChunks === null ? "not reported" : num(semanticVisibleChunks)}**`);
    L.push("");
    L.push("| Kind | Logical documents | Extracted chunks | Meaning-search visible | Last stored ingest receipt |");
    L.push("|---|---:|---:|---:|---|");
    for (const r of [...rows].sort((a, b) => Number(b.total) - Number(a.total))) {
      const label = FRIENDLY[r.source_type] || r.source_type;
      const logical = firstCount(r.logical_documents, r.documents);
      const chunks = firstCount(r.chunks, r.total);
      const visible = finiteCount(r.embedded);
      L.push(
        `| ${label} | ${logical === null ? "not reported" : num(logical)} | ` +
        `${chunks === null ? "not reported" : num(chunks)} | ` +
        `${visible === null ? "not reported" : num(visible)} | ` +
        `${isoDay(r.last_ingested) || "not reported"} |`
      );
    }
    L.push("");
  }
  if (extractedChunks !== null && semanticVisibleChunks !== null && semanticVisibleChunks < extractedChunks) {
    const pending = extractedChunks - semanticVisibleChunks;
    L.push(
      `${num(pending)} extracted chunk${pending === 1 ? " is" : "s are"} not yet visibility-confirmed for meaning search. ` +
        `Those chunks may still be available to keyword search; this report does not call them absent.`
    );
    L.push("");
  }

  /* ------------------------------------------------------------- freshness */
  L.push("## Source currency and completeness");
  L.push("");
  if (sourceInventory?.complete === true && sourceInventory.truncated === false) {
    if (!sourceInventory.sources.length) {
      L.push("The authenticated source registry contains no source rows. Source completeness remains unproven.");
    } else {
      for (const source of sourceInventory.sources) {
        const summary = sourceReceiptSummary(source);
        L.push(
          `- **${summary.label}:** ${summary.currency}; ${summary.history}; ${summary.ingest}` +
            `${summary.run ? `; ${summary.run}` : ""}${summary.reason ? `; ${summary.reason}` : ""}.`
        );
      }
    }
  } else {
    L.push(
      `Source currency and historical completeness are **unknown** because the authenticated ` +
        `source-registry receipt was unavailable or incomplete${sourceInventoryError ? ` (${sourceInventoryError})` : ""}.`
    );
  }
  L.push("");

  const configured = Object.entries(manifest?.corpora || {})
    .filter(([key, value]) => !key.startsWith("_") && value && typeof value === "object");
  if (configured.length) {
    L.push("### Intended local configuration");
    L.push("");
    L.push(
      "These settings describe what this local manifest intends. They do not prove an authenticated connection, a successful refresh, currentness, historical completeness, or that a source never held records."
    );
    for (const [key, value] of configured) {
      const label = sourceLabel({ kind: key, source_id: key });
      const setting = value.enabled === true ? "enabled" : value.enabled === false ? "disabled" : "not specified";
      L.push(`- ${label}: ${setting} in this local manifest`);
    }
    L.push("");
  }

  /* ---------------------------------------------------------------- checks */
  L.push("## Safety and health checks");
  L.push("");
  const tierNames = {
    1: "Reachable and access-controlled",
    2: "Data present and current",
    3: "Optional owner-question checks",
    4: "Credential protection active",
    5: "Version and configuration",
  };
  let lastTier = null;
  for (const r of acc.results) {
    if (r.tier !== lastTier) {
      lastTier = r.tier;
      L.push(`**${tierNames[r.tier] || "Checks"}**`);
      L.push("");
    }
    const mark = r.status === "pass" ? "✅" : r.status === "fail" ? "❌" : r.status === "warn" ? "⚠️" : "➖";
    L.push(`- ${mark} ${r.name}${r.detail ? `: ${r.detail}` : ""}`);
  }
  L.push("");

  /* ------------------------------------------------------------------ cost */
  if (spend && spend.length) {
    L.push("## What it cost to run");
    L.push("");
    const totalMicros = spend.reduce((a, r) => a + Number(r.micros || 0), 0);
    L.push(`Answer generation this period: **$${(totalMicros / 1e6).toFixed(2)}**.`);
    const cap = manifest.safety?.daily_llm_spend_cap_usd;
    if (cap) L.push(`A daily ceiling of $${cap} is in place, so a runaway process cannot produce a surprise bill.`);
    L.push("");
  }

  /* --------------------------------------------------------------- version */
  if (installState) {
    L.push("## Version");
    L.push("");
    L.push(`- Running version **${installState.product_version}**`);
    L.push(`- Last updated: ${installState.last_upgraded_at || "not since install"}`);
    if (upgradeRuns && upgradeRuns.length) {
      const bad = upgradeRuns.filter((r) => r.status !== "verified");
      if (bad.length) {
        L.push(`- ⚠️ ${bad.length} update(s) did not complete cleanly this period`);
      }
    }
    L.push("");
  }

  /* ----------------------------------------------------------- what to do */
  L.push("## What needs you");
  L.push("");
  if (!failures.length && !warnings.length) {
    L.push("Nothing. No action required this month.");
  } else {
    for (const f of failures) L.push(`- **${f.name}:** ${f.detail || "failed"}`);
    for (const w of warnings) L.push(`- ${w.name}: ${w.detail || "worth a look"}`);
  }
  L.push("");
  L.push("---");
  L.push("");
  L.push(
    `_This report combines completed live checks, intended local configuration, and explanatory guidance. ` +
      `Incomplete or unavailable checks are marked unknown. You can run it yourself at any time. ` +
      `Everything in your brain lives in accounts you own; we hold no copy of it._`
  );

  return {
    markdown: L.join("\n"),
    acceptance: acc,
    total: extractedChunks ?? 0,
    embedded: semanticVisibleChunks ?? 0,
    logicalDocuments,
    extractedChunks,
    semanticVisibleChunks,
    sourceInventory,
    sourceInventoryError,
  };
}
