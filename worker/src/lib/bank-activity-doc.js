import { maskedIdentifier, plaidPublicAccountRef } from "./plaid-account-entities.js";
import { tenantReference } from "./bank-feed.js";
import { resolveSourceKind } from "./source-receipt.js";
import {
  D1,
  D1_INGEST_STATEMENT_BUDGET,
  backendOf,
  estimateD1IngestStatements,
} from "./store.js";
import { gatedIngest } from "./zoom.js";
import { withFirstPartySourceProvenance } from "./provenance-receipt.js";

export const BANK_ACTIVITY_SOURCE = "bank_activity";
export const BANK_ACTIVITY_KIND = "bank_activity";
export const BANK_ACTIVITY_DOCUMENT_CAP = 8;
export const BANK_ACTIVITY_INGEST_STATEMENT_BUDGET = 200;

const MONTH_NAMES = Object.freeze([
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]);
const ZERO_DIGIT_CURRENCIES = new Set(["CLP", "ISK", "JPY", "KRW", "VND"]);
const THREE_DIGIT_CURRENCIES = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const PUBLIC_ACCOUNT_REF = /^acct_[a-f0-9]{32}$/;
const LEDGER_MARKER = /^[a-f0-9]{64}$/;

function currencyDigits(currency) {
  const code = String(currency || "USD").toUpperCase();
  if (ZERO_DIGIT_CURRENCIES.has(code)) return 0;
  if (THREE_DIGIT_CURRENCIES.has(code)) return 3;
  return 2;
}

function safeText(value, fallback, max = 120) {
  const text = String(value || "").replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, max);
}

function formatMinor(value, currency) {
  const code = String(currency || "USD").toUpperCase();
  const digits = currencyDigits(code);
  let amount = typeof value === "bigint" ? value : BigInt(Number(value || 0));
  const negative = amount < 0n;
  if (negative) amount = -amount;
  const scale = 10n ** BigInt(digits);
  const whole = amount / scale;
  const fraction = digits ? `.${String(amount % scale).padStart(digits, "0")}` : "";
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${code} ${negative ? "-" : ""}${grouped}${fraction}`;
}

function monthLabel(month) {
  const [year, rawMonth] = month.split("-");
  return `${MONTH_NAMES[Number(rawMonth) - 1]} ${year}`;
}

function monthEnd(month) {
  const [year, rawMonth] = month.split("-").map(Number);
  return new Date(Date.UTC(year, rawMonth, 0)).toISOString().slice(0, 10);
}

function compareCodePoints(left, right) {
  const leftPoints = Array.from(String(left), (character) => character.codePointAt(0));
  const rightPoints = Array.from(String(right), (character) => character.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function compareRows(a, b) {
  return compareCodePoints(String(b.posted_on || ""), String(a.posted_on || "")) ||
    compareCodePoints(
      safeText(a.payee || a.description, "Unlabelled activity"),
      safeText(b.payee || b.description, "Unlabelled activity"),
    ) ||
    compareCodePoints(String(a.direction || ""), String(b.direction || "")) ||
    Number(a.amount_minor || 0) - Number(b.amount_minor || 0) ||
    Number(a.id || 0) - Number(b.id || 0);
}

function rowMonth(row) {
  const value = String(row?.posted_on || "");
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.slice(0, 7) : null;
}

function summarizeRows(rows, month, accountCurrency) {
  const counts = { pending: 0, removed: 0, superseded: 0, unreadable: 0, rounded: 0 };
  const included = [];
  for (const row of rows || []) {
    if (rowMonth(row) !== month) continue;
    if (row.superseded_by_id !== null && row.superseded_by_id !== undefined) {
      counts.superseded += 1;
      continue;
    }
    if (row.removed_at) {
      counts.removed += 1;
      continue;
    }
    if (Number(row.pending || 0) === 1) {
      counts.pending += 1;
      continue;
    }
    if (row.basis_state === "unparsed" || row.amount_minor === null || !row.direction) {
      counts.unreadable += 1;
      continue;
    }
    if (String(row.source_locator || "").includes("#minor_rounded")) counts.rounded += 1;
    included.push({ ...row, currency: String(row.currency || accountCurrency || "USD").toUpperCase() });
  }
  return { counts, included: included.sort(compareRows) };
}

function renderCurrencySection(currency, rows) {
  let moneyIn = 0n;
  let moneyOut = 0n;
  const payees = new Map();
  for (const row of rows) {
    const amount = BigInt(Number(row.amount_minor || 0));
    if (row.direction === "inflow") moneyIn += amount;
    if (row.direction === "outflow") {
      moneyOut += amount;
      const label = safeText(row.payee || row.description, "Unlabelled activity");
      payees.set(label, (payees.get(label) || 0n) + amount);
    }
  }
  const top = [...payees.entries()].sort((a, b) => {
    if (a[1] !== b[1]) return a[1] > b[1] ? -1 : 1;
    return compareCodePoints(a[0], b[0]);
  }).slice(0, 5);
  const latest = rows.slice(0, 25);
  const lines = [
    `## ${currency}`,
    `Settled transaction count: ${rows.length}. Money in: ${formatMinor(moneyIn, currency)}. ` +
      `Money out: ${formatMinor(moneyOut, currency)}. Net: ${formatMinor(moneyIn - moneyOut, currency)}.`,
    `Latest transaction date: ${rows[0]?.posted_on || "none"}.`,
    "Top money out payees:",
    ...(top.length ? top.map(([label, amount]) => `- ${label}: ${formatMinor(amount, currency)}`) : ["- None."]),
    "Latest settled transactions (up to 25):",
    "| Date | Payee or description | Amount | Direction |",
    "| --- | --- | ---: | --- |",
    ...latest.map((row) =>
      `| ${row.posted_on} | ${safeText(row.payee || row.description, "Unlabelled activity")} | ` +
      `${formatMinor(row.amount_minor, currency)} | ${row.direction === "inflow" ? "in" : "out"} |`),
  ];
  if (rows.length > latest.length) lines.push(`${rows.length - latest.length} more not listed.`);
  return lines.join("\n");
}

/**
 * Render only ledger-derived fields. The injected clock is accepted as a test
 * seam but deliberately unused, so retries cannot create a new document body.
 */
export function renderBankActivityDocument({ account, month, transactions, now: _now = null }) {
  if (!MONTH.test(String(month || ""))) throw new TypeError("bank activity month must be YYYY-MM");
  if (!PUBLIC_ACCOUNT_REF.test(String(account?.public_ref || ""))) {
    throw new TypeError("bank activity requires a public account reference");
  }
  const masked = maskedIdentifier(account.label, account.mask);
  const institution = safeText(account.institution, "", 100);
  const entity = safeText(account.entity_label, "the owning entity", 100);
  const { counts, included } = summarizeRows(transactions, month, account.currency);
  const currencies = [...new Set(included.map((row) => row.currency))].sort();
  if (!currencies.length) currencies.push(String(account.currency || "USD").toUpperCase());
  const latestDate = included.map((row) => row.posted_on).sort().at(-1) || null;
  const title = `Bank activity, ${monthLabel(month)}: ${masked}${institution ? ` (${institution})` : ""}`;
  const content = [
    `${title}.`,
    `This account belongs to ${entity}. The account currency is ${String(account.currency || "USD").toUpperCase()}.`,
    `This month includes ${included.length} settled transaction${included.length === 1 ? "" : "s"}. ` +
      `${counts.pending} pending line${counts.pending === 1 ? " was" : "s were"} left out. ` +
      `${counts.unreadable} line${counts.unreadable === 1 ? " could" : "s could"} not be read. ` +
      `${counts.rounded} included amount${counts.rounded === 1 ? " was" : "s were"} rounded from finer bank precision.`,
    `${counts.removed} removed line${counts.removed === 1 ? " was" : "s were"} left out, and ` +
      `${counts.superseded} superseded line${counts.superseded === 1 ? " was" : "s were"} left out.`,
    "Transfers between the owner's own accounts and card payments are included and are not netted out.",
    ...currencies.map((currency) => renderCurrencySection(
      currency,
      included.filter((row) => row.currency === currency),
    )),
  ].join("\n\n");
  const envelope = withFirstPartySourceProvenance({
    source_type: BANK_ACTIVITY_SOURCE,
    source_id: `${account.public_ref}:${month}`,
    title,
    content,
    occurred_at: latestDate || monthEnd(month),
    date_source: latestDate ? "bank_feed:latest_posted_on" : "bank_feed:month_end_no_settled_rows",
    date_reliable: true,
    metadata: {
      entity_slug: account.entity_slug,
      category: BANK_ACTIVITY_SOURCE,
      bank_activity: {
        account_ref: account.public_ref,
        month,
        currencies,
      },
      evidence_lineage: {
        version: 1,
        kind: "derived_record",
        root_ids: [`financial-ledger:${account.public_ref}:${month}`],
      },
    },
  }, { textSource: "native", textReliable: true });
  return { envelope, stats: { settled: included.length, ...counts, currencies, latest_date: latestDate } };
}

function parseCursor(value) {
  if (!value) return null;
  try {
    const cursor = JSON.parse(value);
    if (cursor?.version !== 1 || !Number.isSafeInteger(cursor.rank) || cursor.rank < 1 ||
        !MONTH.test(String(cursor.month || "")) || !Number.isSafeInteger(cursor.account_id) ||
        cursor.account_id < 1 || !Number.isSafeInteger(cursor.failures) || cursor.failures < 0 ||
        !LEDGER_MARKER.test(String(cursor.ledger_marker || ""))) return null;
    return cursor;
  } catch {
    return null;
  }
}

async function plaidLedgerMarker(env, tenantId) {
  const rows = (await env.DB.prepare(
    `SELECT i.item_ref,i.cursor,i.cursor_updated_at,i.last_synced_at,i.institution_label,
            a.id AS account_id,a.account_slug,a.entity_slug,a.label AS account_label,
            a.mask AS account_mask,a.currency AS account_currency,
            a.external_ref AS provider_account_id,a.source_feed,a.feed_mode,
            e.legal_name AS entity_legal_name,e.display_label AS entity_display_label,
            e.status AS entity_status,e.relationship AS entity_relationship,
            (SELECT COUNT(*) FROM fin_accounts a
              WHERE a.tenant_id=i.tenant_id AND a.source_feed='bank-feed:'||i.item_ref
                AND a.superseded_by_id IS NULL) AS account_count,
            (SELECT COALESCE(MAX(a.recorded_at),'') FROM fin_accounts a
              WHERE a.tenant_id=i.tenant_id AND a.source_feed='bank-feed:'||i.item_ref) AS account_recorded_at,
            (SELECT COUNT(*) FROM fin_transactions t
              WHERE t.tenant_id=i.tenant_id AND t.source_feed='bank-feed:'||i.item_ref
                AND t.source_provider='plaid') AS transaction_count,
            (SELECT COALESCE(MAX(COALESCE(t.removed_at,t.recorded_at)),'') FROM fin_transactions t
              WHERE t.tenant_id=i.tenant_id AND t.source_feed='bank-feed:'||i.item_ref
               AND t.source_provider='plaid') AS transaction_recorded_at
       FROM bank_feed_items i
       LEFT JOIN fin_accounts a ON a.tenant_id=i.tenant_id
        AND a.source_feed='bank-feed:'||i.item_ref AND a.superseded_by_id IS NULL
       LEFT JOIN fin_entities e ON e.tenant_id=a.tenant_id AND e.entity_slug=a.entity_slug
        AND e.superseded_by_id IS NULL
      WHERE i.tenant_id=?1 AND i.removed_at IS NULL
      ORDER BY i.item_ref,a.id`,
  ).bind(tenantId).all())?.results || [];
  const bytes = new TextEncoder().encode(JSON.stringify(rows));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function candidateMonths(env, tenantId, cursor) {
  const result = await env.DB.prepare(
    `WITH plaid_accounts AS (
       SELECT a.id AS account_id,a.account_slug,a.entity_slug,a.label,a.mask,a.currency,
              a.external_ref AS provider_account_id,
              substr(a.source_feed,length('bank-feed:')+1) AS item_ref,
              COALESCE(e.display_label,e.legal_name) AS entity_label,
              i.institution_label AS institution
         FROM fin_accounts a
         JOIN fin_entities e ON e.tenant_id=a.tenant_id AND e.entity_slug=a.entity_slug
          AND e.superseded_by_id IS NULL AND e.status='active' AND e.relationship='owned'
         LEFT JOIN bank_feed_items i ON i.tenant_id=a.tenant_id
          AND i.item_ref=substr(a.source_feed,length('bank-feed:')+1)
        WHERE a.tenant_id=?1 AND a.superseded_by_id IS NULL AND a.feed_mode='live'
          AND a.source_feed LIKE 'bank-feed:%' AND a.external_ref IS NOT NULL
          AND EXISTS (SELECT 1 FROM fin_transactions p
            WHERE p.tenant_id=a.tenant_id AND p.account_slug=a.account_slug
              AND p.source_provider='plaid')
     ), account_months AS (
       SELECT a.*,substr(t.posted_on,1,7) AS month
         FROM plaid_accounts a
         JOIN fin_transactions t ON t.tenant_id=?1 AND t.account_slug=a.account_slug
          AND t.source_provider='plaid'
        WHERE t.posted_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        GROUP BY a.account_id,a.account_slug,a.entity_slug,a.label,a.mask,a.currency,
                 a.provider_account_id,a.item_ref,a.entity_label,a.institution,substr(t.posted_on,1,7)
       HAVING SUM(CASE WHEN COALESCE(t.pending,0)=0 THEN 1 ELSE 0 END)>0
     ), ranked AS (
       SELECT account_months.*,
              ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY month DESC) AS month_rank
         FROM account_months
     )
     SELECT * FROM ranked
      WHERE ?2 IS NULL OR month_rank>?2
         OR (month_rank=?2 AND month<?3)
         OR (month_rank=?2 AND month=?3 AND account_id>?4)
      ORDER BY month_rank,month DESC,account_id
      LIMIT ?5`,
  ).bind(
    tenantId,
    cursor?.rank ?? null,
    cursor?.month ?? null,
    cursor?.account_id ?? null,
    BANK_ACTIVITY_DOCUMENT_CAP + 1,
  ).all();
  return result?.results || [];
}

async function monthTransactions(env, tenantId, candidate) {
  const result = await env.DB.prepare(
    `SELECT id,posted_on,amount_minor,direction,currency,description,payee,pending,removed_at,
            basis_state,source_locator,superseded_by_id
       FROM fin_transactions
      WHERE tenant_id=?1 AND account_slug=?2 AND source_provider='plaid'
        AND substr(posted_on,1,7)=?3
      ORDER BY posted_on DESC,id`,
  ).bind(tenantId, candidate.account_slug, candidate.month).all();
  return result?.results || [];
}

async function recordSourcePass(env, {
  at, cursor, complete, confirmed, counts,
}) {
  const nextCursor = complete || !cursor ? null : JSON.stringify(cursor);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE sources SET status='ready',last_ingest_at=CASE WHEN ?2=1 THEN ?3 ELSE last_ingest_at END,
          last_complete_sweep_at=CASE WHEN ?4=1 THEN ?3 ELSE NULL END,
          document_count=(SELECT COUNT(*) FROM documents WHERE source=?1 AND deleted_at IS NULL),
          sync_cursor=?5,expected_refresh_seconds=NULL,stale_reason=NULL
        WHERE name=?1 AND kind=?6`,
    ).bind(BANK_ACTIVITY_SOURCE, confirmed ? 1 : 0, at, complete ? 1 : 0, nextCursor, BANK_ACTIVITY_KIND),
    env.DB.prepare(
      `INSERT INTO source_events (source_name,event,at,documents,detail)
       VALUES (?1,'ingest',?2,
         (SELECT COUNT(*) FROM documents WHERE source=?1 AND deleted_at IS NULL),?3)`,
    ).bind(
      BANK_ACTIVITY_SOURCE,
      at,
      `bank activity pass created=${counts.created} updated=${counts.updated} unchanged=${counts.unchanged} ` +
        `refused=${counts.refused} failed=${counts.failed} complete=${complete ? 1 : 0}`,
    ),
  ]);
}

/**
 * Advance one bounded ledger-to-document sweep after a committed Plaid
 * promotion or rendered-metadata change. Refusals and storage failures stay in
 * this receipt and never change the bank sync receipt that caused the pass.
 */
export async function writeBankActivityDocuments(env, {
  committedPromotions = 0,
  metadataChanges = 0,
  at = null,
} = {}) {
  const base = {
    decision: "promotion_gate_checked",
    ran: false,
    ingest_calls: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    refused: 0,
    failed: 0,
    deferred: 0,
    complete_sweep: false,
  };
  if (env.VECTOR_DRAIN_MODE === "paused-for-upgrade") return { ...base, outcome: "paused" };
  if (backendOf(env) !== D1 || !env.DB) return { ...base, outcome: "not_d1" };
  if (env.BANK_FEED_PROVIDER !== "plaid") return { ...base, outcome: "not_plaid" };
  const promotionTriggered = Number.isSafeInteger(committedPromotions) && committedPromotions > 0;
  const metadataTriggered = Number.isSafeInteger(metadataChanges) && metadataChanges > 0;
  if (!promotionTriggered && !metadataTriggered) {
    return { ...base, outcome: "no_committed_promotion" };
  }

  const stamp = at || new Date().toISOString();
  const { tenantId } = tenantReference(env);
  await resolveSourceKind(env, {
    source: BANK_ACTIVITY_SOURCE,
    requestedKind: BANK_ACTIVITY_KIND,
    defaultKind: BANK_ACTIVITY_KIND,
  });
  const source = await env.DB.prepare(
    "SELECT sync_cursor FROM sources WHERE name=?1 AND kind=?2",
  ).bind(BANK_ACTIVITY_SOURCE, BANK_ACTIVITY_KIND).first();
  const storedCursor = parseCursor(source?.sync_cursor);
  const currentMarker = await plaidLedgerMarker(env, tenantId);
  // A promotion between bounded passes invalidates the older traversal. Start
  // from the newest months again instead of certifying mixed ledger states.
  const priorCursor = storedCursor?.ledger_marker === currentMarker ? storedCursor : null;
  const candidates = await candidateMonths(env, tenantId, priorCursor);
  const selected = candidates.slice(0, BANK_ACTIVITY_DOCUMENT_CAP);
  const counts = { ...base, ran: true, outcome: "ran" };
  let estimatedStatements = 0;
  let last = null;

  for (const candidate of selected) {
    try {
      const publicRef = await plaidPublicAccountRef(tenantId, candidate.item_ref, candidate.provider_account_id);
      const transactions = await monthTransactions(env, tenantId, candidate);
      const { envelope } = renderBankActivityDocument({
        account: {
          public_ref: publicRef,
          entity_slug: candidate.entity_slug,
          entity_label: candidate.entity_label,
          label: candidate.label,
          mask: candidate.mask,
          currency: candidate.currency,
          institution: candidate.institution,
        },
        month: candidate.month,
        transactions,
      });
      const nextEstimate = estimatedStatements + estimateD1IngestStatements(env, [envelope]);
      if (nextEstimate > BANK_ACTIVITY_INGEST_STATEMENT_BUDGET ||
          nextEstimate > D1_INGEST_STATEMENT_BUDGET) {
        counts.deferred += selected.length - counts.ingest_calls;
        break;
      }
      estimatedStatements = nextEstimate;
      counts.ingest_calls += 1;
      const result = await gatedIngest(env, envelope);
      if (result.refused) counts.refused += 1;
      else if (["created", "updated", "unchanged"].includes(result.action)) counts[result.action] += 1;
      else counts.failed += 1;
    } catch {
      counts.failed += 1;
    }
    last = candidate;
  }

  const passFailures = (priorCursor?.failures || 0) + counts.refused + counts.failed + counts.deferred;
  const more = candidates.length > BANK_ACTIVITY_DOCUMENT_CAP || counts.deferred > 0;
  const finalMarker = !more && passFailures === 0
    ? await plaidLedgerMarker(env, tenantId)
    : currentMarker;
  const stableLedger = finalMarker === currentMarker;
  const complete = !more && passFailures === 0 && stableLedger;
  const cursor = last ? {
    version: 1,
    rank: Number(last.month_rank),
    month: last.month,
    account_id: Number(last.account_id),
    failures: passFailures,
    ledger_marker: currentMarker,
  } : priorCursor;
  const nextCursor = (!more && passFailures > 0) || !stableLedger ? null : cursor;
  await recordSourcePass(env, {
    at: stamp,
    cursor: nextCursor,
    complete,
    confirmed: counts.created + counts.updated + counts.unchanged > 0 || selected.length === 0,
    counts,
  });
  return {
    ...counts,
    complete_sweep: complete,
    statement_estimate: estimatedStatements,
    document_cap: BANK_ACTIVITY_DOCUMENT_CAP,
    statement_budget: BANK_ACTIVITY_INGEST_STATEMENT_BUDGET,
  };
}
