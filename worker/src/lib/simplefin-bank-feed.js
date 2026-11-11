import { accountKindReviewSql, applyAccountKindReview } from "./fin-account-kinds.js";
import { balanceRoleFor, prepareBankExportImport } from "./fin-import.js";
import { SIMPLEFIN_POSTED_HISTORY_REVISION } from "./bank-feed-profiles.js";
import { simpleFinCoverageStatements, simpleFinCoverageSummaryStatement } from "./simplefin-ledger.js";
import { simpleFinTransactionInventory, simpleFinRestoreStatements, simpleFinReconciliationPlan, simpleFinPromotionIntent } from "./simplefin-reconciliation.js";
import {
  BANK_ACCESS_WRAPPING_KEY_VERSION,
  decryptAccessReference,
  encryptAccessReference,
  feedScopeKey,
  tenantReference,
} from "./bank-feed.js";

const PROVIDER = "simplefin";
const BACKFILL_DAYS = 730;
const WINDOW_DAYS = 90;
const DEFAULT_REQUESTS_PER_RUN = 3;
const DAILY_REQUEST_LIMIT = 24;
// This evidence version proves exclusive full-day requests and posted-only
// reconciliation. An arbitrary older revision is never coverage authority.
export const POSTED_HISTORY_REVISION = SIMPLEFIN_POSTED_HISTORY_REVISION;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/;
const ENTITY_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class SimpleFinError extends Error {
  constructor(code, status = 502) {
    super(code);
    this.name = "SimpleFinError";
    this.code = code;
    this.status = status;
    this.provider = PROVIDER;
  }
}

function stampOf(now = null) {
  const value = now ? new Date(now) : new Date();
  if (!Number.isFinite(value.getTime())) throw new SimpleFinError("simplefin_time_invalid", 500);
  return value.toISOString();
}

function dayOf(value) { return String(value).slice(0, 10); }

function addDays(day, count) {
  const value = new Date(`${day}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

function tomorrow(stamp) {
  const value = new Date(stamp);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString();
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(value)),
  ));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rowsOf(result) { return Array.isArray(result?.results) ? result.results : []; }

function changed(result) { return Number(result?.meta?.changes || 0); }

async function boundedText(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new SimpleFinError("simplefin_response_too_large", 502);
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).length > maxBytes) {
      throw new SimpleFinError("simplefin_response_too_large", 502);
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new SimpleFinError("simplefin_response_too_large", 502);
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    if (size > maxBytes) await reader.cancel().catch(() => {});
  }
}

function decodeSetupToken(setupToken) {
  if (typeof setupToken !== "string" || setupToken.length < 8 || setupToken.length > 8192) {
    throw new SimpleFinError("simplefin_setup_token_invalid", 400);
  }
  let decoded;
  try {
    decoded = atob(setupToken.replace(/\s+/g, ""));
  } catch {
    throw new SimpleFinError("simplefin_setup_token_invalid", 400);
  }
  let url;
  try { url = new URL(decoded); } catch {
    throw new SimpleFinError("simplefin_setup_token_invalid", 400);
  }
  if (url.protocol !== "https:") throw new SimpleFinError("simplefin_setup_token_invalid", 400);
  return url.href;
}

function validateAccessUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch {
    throw new SimpleFinError("simplefin_claim_response_invalid", 502);
  }
  if (url.protocol !== "https:" || !url.username || !url.password || url.hash) {
    throw new SimpleFinError("simplefin_claim_response_invalid", 502);
  }
  return url.href.replace(/\/$/, "");
}

function providerRequest(value, method, accept, failureCode) {
  try {
    const url = new URL(value);
    const headers = { Accept: accept };
    if (url.username || url.password) {
      const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
      headers.Authorization = `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(credentials)))}`;
      url.username = "";
      url.password = "";
    }
    // Workers rejects redirect:error; manual also prevents credentials from
    // following a provider redirect. Construct before reserving a one-time claim.
    return new Request(url.href, { method, redirect: "manual", headers });
  } catch {
    throw new SimpleFinError(failureCode, 400);
  }
}

async function claimRow(env, tenantId, requestId) {
  return env.DB.prepare(
    `SELECT request_fingerprint,state,item_ref,error_code
       FROM simplefin_claim_operations WHERE tenant_id=? AND request_id=?`,
  ).bind(tenantId, requestId).first();
}

function claimReceipt(row, replayed) {
  if (row.state === "claimed") {
    return { status: replayed ? 200 : 201, body: { ok: true, provider: PROVIDER, item_ref: row.item_ref, replayed } };
  }
  if (row.error_code === "simplefin_claim_refused") throw new SimpleFinError(row.error_code, 502);
  throw new SimpleFinError("simplefin_claim_outcome_unknown", 409);
}

/**
 * Consume a Setup Token at most once and seal the resulting Access URL before
 * it reaches durable storage. A timeout after POST is an unknown outcome, not
 * permission to retry a one-time claim.
 */
export async function claimSimpleFinAccess(env, {
  requestId,
  setupToken,
  fetchImpl = fetch,
  now = null,
} = {}) {
  if (!REQUEST_ID.test(String(requestId || ""))) {
    throw new SimpleFinError("simplefin_claim_request_id_required", 400);
  }
  const claimUrl = decodeSetupToken(setupToken);
  const request = providerRequest(claimUrl, "POST", "text/plain", "simplefin_claim_request_invalid");
  const fingerprint = await sha256Hex(setupToken);
  const { tenantId } = tenantReference(env);
  const stamp = stampOf(now);
  const inserted = await env.DB.prepare(
    `INSERT INTO simplefin_claim_operations
       (tenant_id,request_id,request_fingerprint,state,created_at,updated_at)
     VALUES (?,?,?,'claiming',?,?) ON CONFLICT DO NOTHING`,
  ).bind(tenantId, requestId, fingerprint, stamp, stamp).run();
  if (changed(inserted) !== 1) {
    const existing = await claimRow(env, tenantId, requestId);
    if (!existing) {
      const used = await env.DB.prepare(
        `SELECT request_id FROM simplefin_claim_operations
          WHERE tenant_id=? AND request_fingerprint=?`,
      ).bind(tenantId, fingerprint).first();
      if (used) throw new SimpleFinError("simplefin_setup_token_already_used", 409);
    }
    if (!existing || existing.request_fingerprint !== fingerprint) {
      throw new SimpleFinError("simplefin_claim_request_conflict", 409);
    }
    return claimReceipt(existing, true);
  }

  let accessUrl;
  try {
    const response = await fetchImpl(request);
    if ((response.status >= 300 && response.status < 400) || !response.ok) {
      throw new SimpleFinError("simplefin_claim_refused", 502);
    }
    accessUrl = validateAccessUrl(await boundedText(response, 4096));
  } catch (error) {
    // A refusal is observable, but still consumes the claim attempt: even a
    // redirect response cannot prove that the provider left its token unused.
    const code = error instanceof SimpleFinError && error.code === "simplefin_claim_refused"
      ? error.code : "simplefin_claim_outcome_unknown";
    await env.DB.prepare(
      `UPDATE simplefin_claim_operations
          SET state='outcome_unknown',error_code=?,updated_at=?
        WHERE tenant_id=? AND request_id=? AND state='claiming'`,
    ).bind(code, stamp, tenantId, requestId).run().catch(() => {});
    throw new SimpleFinError(code, code === "simplefin_claim_refused" ? 502 : 409);
  }

  const itemRef = `simplefin-${crypto.randomUUID()}`;
  const sealed = await encryptAccessReference(env, accessUrl);
  const end = dayOf(stamp);
  const start = addDays(end, -(BACKFILL_DAYS - 1));
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO bank_feed_items
           (tenant_id,item_ref,institution_ref,institution_label,access_ciphertext,access_iv,
            key_version,environment,status,connected_at)
         VALUES (?,?,'simplefin','SimpleFIN Bridge',?,?,?,'production','connected',?)`,
      ).bind(tenantId, itemRef, sealed.ciphertext, sealed.iv, sealed.keyVersion, stamp),
      env.DB.prepare(
        `INSERT INTO bank_feed_backfill
           (tenant_id,item_ref,requested_days,state,queued_at)
         VALUES (?,?,?,'queued',?)`,
      ).bind(tenantId, itemRef, BACKFILL_DAYS, stamp),
      env.DB.prepare(
        `INSERT INTO simplefin_connections
           (tenant_id,item_ref,backfill_start,backfill_next,backfill_end,next_pull_at,updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).bind(tenantId, itemRef, start, start, end, stamp, stamp),
      env.DB.prepare(
        `UPDATE simplefin_claim_operations SET state='claimed',item_ref=?,updated_at=?
          WHERE tenant_id=? AND request_id=? AND state='claiming'`,
      ).bind(itemRef, stamp, tenantId, requestId),
    ]);
  } catch {
    await env.DB.prepare(
      `UPDATE simplefin_claim_operations
          SET state='outcome_unknown',error_code='simplefin_claim_storage_unknown',updated_at=?
        WHERE tenant_id=? AND request_id=?`,
    ).bind(stamp, tenantId, requestId).run().catch(() => {});
    throw new SimpleFinError("simplefin_claim_storage_unknown", 503);
  }
  return claimReceipt({ state: "claimed", item_ref: itemRef }, false);
}

function accessReferenceFragments(accessUrl) {
  if (!accessUrl) return [];
  const fragments = new Set();
  const add = (value) => {
    const text = String(value || "");
    if (!text) return;
    fragments.add(text);
    fragments.add(encodeURIComponent(text));
    try { fragments.add(decodeURIComponent(text)); } catch {}
  };
  add(accessUrl);
  try {
    const parsed = new URL(accessUrl);
    add(parsed.username);
    add(parsed.password);
    add(`${parsed.username}:${parsed.password}`);
    for (const segment of parsed.pathname.split("/").filter(Boolean)) add(segment);
    for (const value of parsed.searchParams.values()) add(value);
  } catch {
    // Access URLs pass validateAccessUrl before this point. A closed fallback
    // still avoids treating a malformed value as safe provider text.
    return [String(accessUrl)];
  }
  return [...fragments].filter(Boolean).sort((left, right) => right.length - left.length);
}

function safeErrlist(value, { accessUrl = null } = {}) {
  if (!Array.isArray(value)) throw new SimpleFinError("simplefin_response_invalid", 502);
  const secretFragments = accessReferenceFragments(accessUrl);
  const unreadable = "SimpleFIN reported an issue without readable details.";
  return value.slice(0, 25).map((entry) => {
    let safe = typeof entry === "string" ? entry
      : entry && !Array.isArray(entry) && typeof entry === "object"
        ? typeof entry.msg === "string" ? entry.msg : typeof entry.text === "string" ? entry.text : unreadable
        : unreadable;
    // Older pulls stringified provider objects before persistence. The lost
    // fields cannot be reconstructed, so every durable canonical artifact and
    // any comma-joined sibling fail closed to the honest bounded fallback.
    if (safe.includes("[object Object]")) safe = unreadable;
    for (const fragment of secretFragments) {
      safe = safe.replaceAll(fragment, "[access reference removed]");
    }
    safe = safe
      .replace(/https?:\/\/\S+/gi, "[provider address removed]")
      .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[provider reference removed]")
      .replace(/[\r\n\t]+/g, " ")
      .trim()
      .slice(0, 240);
    return safe || unreadable;
  })
    .filter(Boolean);
}

function validatePayload(payload, { accessUrl = null } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.accounts)) {
    throw new SimpleFinError("simplefin_response_invalid", 502);
  }
  if (payload.accounts.length > 500) throw new SimpleFinError("simplefin_response_too_large", 502);
  let transactions = 0;
  for (const account of payload.accounts) {
    if (!account || typeof account !== "object" || typeof account.id !== "string" ||
        !account.id || account.id.length > 512 ||
        (account.conn_id !== undefined && (typeof account.conn_id !== 'string' || !account.conn_id || account.conn_id.length > 512)) ||
        (account.transactions !== undefined && !Array.isArray(account.transactions)) ||
        !/^[A-Z]{3}$/.test(account.currency || "") ||
        account["balance-date"] == null || !Number.isSafeInteger(account["balance-date"]) ||
        !epochDay(account["balance-date"])) {
      throw new SimpleFinError("simplefin_response_invalid", 502);
    }
    transactions += (account.transactions || []).length;
    if (transactions > 10_000) throw new SimpleFinError("simplefin_response_too_large", 502);
  }
  return {
    accounts: payload.accounts,
    // Bridge warnings can still arrive in the deprecated string list. Neither
    // a current empty errlist nor an unreadable object may hide that warning.
    errlist: [...safeErrlist(payload.errlist ?? [], { accessUrl }),
      ...safeErrlist(payload.errors ?? [], { accessUrl })].slice(0, 25),
  };
}

function accountInstitution(payload, account) {
  const match = Array.isArray(payload.connections)
    ? payload.connections.find((entry) => entry?.conn_id && entry.conn_id === account.conn_id)
    : null;
  return String(match?.name || match?.org_name || account.org?.name || "SimpleFIN Bridge").slice(0, 160);
}

async function accountRef(tenantId, itemRef, providerAccountId) {
  return `sfa_${(await sha256Hex(`${tenantId}\0${itemRef}\0${providerAccountId}`)).slice(0, 32)}`;
}

function observationFence() {
  return `NOT EXISTS (SELECT 1 FROM simplefin_sync_windows newer
    WHERE newer.tenant_id=w.tenant_id AND newer.item_ref=w.item_ref
      AND newer.window_start<=w.window_end AND newer.window_end>=w.window_start
      AND newer.staging_revision>w.staging_revision)`;
}

function accountListingsCompleteSql(windowAlias = "w") {
  // An omitted account leaves its exact-interval receipt unresolved across
  // parent revisions. Only that account's complete replacement can clear it.
  // Scheduling also inspects receipts left behind by earlier promoters.
  return `NOT EXISTS (SELECT 1 FROM simplefin_account_windows incomplete
    WHERE incomplete.tenant_id=${windowAlias}.tenant_id AND incomplete.item_ref=${windowAlias}.item_ref
      AND incomplete.window_start=${windowAlias}.window_start AND incomplete.window_end=${windowAlias}.window_end
      AND incomplete.complete=0)`;
}

async function revisionBatch(env, tenantId, window, statements, staging = false) {
  // The fence and writes share a D1 transaction. Checking only before a batch
  // lets an older promoter certify a new revision or overwrite newer ledger rows.
  const result = await env.DB.batch([
    env.DB.prepare(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM simplefin_sync_windows w JOIN bank_feed_items i
           ON i.tenant_id=w.tenant_id AND i.item_ref=w.item_ref
          WHERE w.tenant_id=? AND w.item_ref=? AND w.window_start=? AND w.window_end=?
            AND w.staging_revision=? AND i.removed_at IS NULL
            AND ${observationFence()}
            ${staging ? "" : "AND w.revision=? AND w.state='staged'"}
       ) THEN 1 ELSE json_extract('simplefin revision superseded','$') END AS revision_guard`,
    ).bind(tenantId, window.item_ref, window.window_start, window.window_end, window.revision,
      ...(staging ? [] : [window.revision])),
    ...statements,
  ]);
  return result.slice(1);
}

async function batchInChunks(env, tenantId, window, statements, staging = false, size = 50) {
  for (let offset = 0; offset < statements.length; offset += size) {
    await revisionBatch(env, tenantId, window, statements.slice(offset, offset + size), staging);
  }
}

async function beginWindowRevision(env, tenantId, itemRef, window, stamp, reservation) {
  // The atomic budget reservation supplies a connection-wide observation order,
  // including same-clock and cross-midnight pulls. '~' sorts after older UUID
  // receipts. Random IDs and response arrival times never decide precedence.
  const revision = `${POSTED_HISTORY_REVISION}~${reservation.request_day}:${String(reservation.requests_today).padStart(2, "0")}:${crypto.randomUUID()}`;
  // Establish custody before dispatch: a late older provider response cannot
  // replace newer staged history that is still awaiting owner assignment.
  const [claimed] = await env.DB.batch([env.DB.prepare(
    `INSERT INTO simplefin_sync_windows
       (tenant_id,item_ref,window_start,window_end,state,errlist_json,fetched_at,staging_revision)
     SELECT ?,?,?,?,'staged','[]',?,? FROM simplefin_connections
       WHERE tenant_id=? AND item_ref=? AND (?=0 OR backfill_next=?)
     ON CONFLICT (tenant_id,item_ref,window_start,window_end) DO UPDATE SET
       staging_revision=excluded.staging_revision
       WHERE excluded.staging_revision>simplefin_sync_windows.staging_revision`,
  ).bind(tenantId, itemRef, window.start, window.end, stamp, revision,
    tenantId, itemRef, window.backfill ? 1 : 0, window.start),
  // A replacement may be incomplete or fail after dispatch. Prior coverage
  // cannot certify this revision until promotion verifies the whole response.
  env.DB.prepare(
    `UPDATE fin_account_coverage SET coverage_status='partial',computed_at=?
      WHERE tenant_id=? AND source_feed=? AND superseded_by_id IS NULL
        AND EXISTS (SELECT 1 FROM simplefin_sync_windows WHERE tenant_id=? AND item_ref=?
          AND window_start=? AND window_end=? AND staging_revision=?)`,
  ).bind(stamp, tenantId, feedScopeKey(itemRef), tenantId, itemRef, window.start, window.end, revision)]);
  if (changed(claimed) !== 1) throw new SimpleFinError("simplefin_window_superseded", 409);
  return revision;
}

async function stageResponse(env, {
  tenantId,
  itemRef,
  windowStart,
  windowEnd,
  payload,
  accessUrl,
  stamp,
  revision,
}) {
  const validated = validatePayload(payload, { accessUrl });
  const window = { item_ref: itemRef, window_start: windowStart, window_end: windowEnd, revision };
  const statements = [];
  const accountIds = new Set();
  let transactionCount = 0;
  for (const account of validated.accounts) {
    const connectionId = account.conn_id ?? '';
    const identityKey = JSON.stringify([connectionId,account.id]);
    if (accountIds.has(identityKey)) throw new SimpleFinError("simplefin_response_invalid", 502);
    accountIds.add(identityKey);
    const legacy = await env.DB.prepare(`SELECT 1 AS present FROM simplefin_account_assignments
      WHERE tenant_id=? AND item_ref=? AND source_account_id=? AND connection_id IS NULL`)
      .bind(tenantId,itemRef,account.id).first();
    if (legacy) throw new SimpleFinError('simplefin_account_identity_review_required',409);
    const existing = await env.DB.prepare(`SELECT provider_account_id,account_ref FROM simplefin_account_assignments
      WHERE tenant_id=? AND item_ref=? AND connection_id=? AND source_account_id=?`)
      .bind(tenantId,itemRef,connectionId,account.id).first();
    // An approved legacy binding keeps every ledger reference and kind review.
    const storageKey = existing?.provider_account_id ?? identityKey;
    const transactionIds = new Set();
    const currency = /^[A-Z]{3}$/.test(String(account.currency || "").toUpperCase())
      ? String(account.currency).toUpperCase() : "USD";
    const ref = existing?.account_ref ?? await accountRef(tenantId, itemRef, identityKey);
    const occupied = await env.DB.prepare(`SELECT connection_id,source_account_id,account_ref FROM simplefin_account_assignments
      WHERE tenant_id=? AND item_ref=? AND provider_account_id=?`).bind(tenantId,itemRef,storageKey).first();
    if (occupied && (occupied.connection_id !== connectionId || occupied.source_account_id !== account.id || occupied.account_ref !== ref))
      throw new SimpleFinError('simplefin_account_identity_review_required',409);
    const label = String(account.name || "Bank account").slice(0, 160);
    const institution = accountInstitution(payload, account);
    statements.push(env.DB.prepare(
      `INSERT INTO simplefin_account_assignments
         (tenant_id,item_ref,provider_account_id,account_ref,account_label,institution_label,currency,
          first_seen_at,last_seen_at,connection_id,source_account_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (tenant_id,item_ref,provider_account_id) DO UPDATE SET
         account_label=excluded.account_label,institution_label=excluded.institution_label,
         currency=excluded.currency,last_seen_at=excluded.last_seen_at
       WHERE simplefin_account_assignments.connection_id=excluded.connection_id
         AND simplefin_account_assignments.source_account_id=excluded.source_account_id
         AND simplefin_account_assignments.account_ref=excluded.account_ref`,
    ).bind(tenantId, itemRef, storageKey, ref, label, institution, currency, stamp, stamp,connectionId,account.id));
    // Provider text is unrestricted. Repeat exact identity validation inside the
    // staging transaction, including the UPSERT conflict and its reference.
    statements.push(env.DB.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM simplefin_account_assignments
      WHERE tenant_id=? AND item_ref=? AND provider_account_id=? AND connection_id=? AND source_account_id=? AND account_ref=?)
      THEN 1 ELSE json_extract('simplefin account identity conflict','$') END AS verified`)
      .bind(tenantId,itemRef,storageKey,connectionId,account.id,ref));
    // Record retry work before its staging row, even across chunk boundaries.
    // A later omitted-account response must not discharge this observation if
    // staging publication or the final receipt write is interrupted. Replacing
    // a complete receipt also stays pending until this revision is promoted.
    statements.push(...simpleFinCoverageStatements(env, { tenantId, itemRef, window,
      accounts: [{ account_ref: ref, complete: false }], stamp }));
    statements.push(env.DB.prepare(
      `INSERT INTO simplefin_stage_accounts
         (tenant_id,item_ref,window_start,window_end,provider_account_id,account_label,
          institution_label,currency,balance_decimal,available_decimal,balance_epoch,revision,transactions_present,
          connection_id,source_account_id,identity_account_ref)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (tenant_id,item_ref,window_start,window_end,provider_account_id) DO UPDATE SET
         account_label=excluded.account_label,institution_label=excluded.institution_label,
         currency=excluded.currency,balance_decimal=excluded.balance_decimal,
         available_decimal=excluded.available_decimal,balance_epoch=excluded.balance_epoch,
         revision=excluded.revision,transactions_present=excluded.transactions_present,
         connection_id=excluded.connection_id,source_account_id=excluded.source_account_id,
         identity_account_ref=excluded.identity_account_ref`,
    ).bind(
      tenantId, itemRef, windowStart, windowEnd, storageKey, label, institution, currency,
      account.balance == null ? null : String(account.balance),
      // Omission means equal to balance in the protocol. An explicit null is
      // still unreadable and must not acquire that meaning by coercion.
      account["available-balance"] === undefined ? String(account.balance) :
        account["available-balance"] === null ? null : String(account["available-balance"]),
      Number.isSafeInteger(Number(account["balance-date"])) ? Number(account["balance-date"]) : null,
      revision, Array.isArray(account.transactions) ? 1 : 0,connectionId,account.id,ref,
    ));
    for (const transaction of account.transactions || []) {
      if (!transaction || typeof transaction !== "object" || transaction.id == null ||
          String(transaction.id).length > 128 || transactionIds.has(String(transaction.id))) {
        throw new SimpleFinError("simplefin_response_invalid", 502);
      }
      transactionIds.add(String(transaction.id));
      if (Object.hasOwn(transaction, "pending") && typeof transaction.pending !== "boolean") {
        throw new SimpleFinError("simplefin_response_invalid", 502);
      }
      // We request posted history (no pending=1). Some providers still return
      // pending entries, including posted=0 and changing IDs. Never turn them
      // into completed money; the later posted event is imported normally.
      if (transaction.pending === true) continue;
      transactionCount++;
      statements.push(env.DB.prepare(
        `INSERT INTO simplefin_stage_transactions
           (tenant_id,item_ref,window_start,window_end,provider_account_id,provider_transaction_id,
            posted_epoch,transacted_epoch,amount_decimal,description,payee,memo,currency,revision)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (tenant_id,item_ref,window_start,window_end,provider_account_id,provider_transaction_id)
         DO UPDATE SET posted_epoch=excluded.posted_epoch,transacted_epoch=excluded.transacted_epoch,
           amount_decimal=excluded.amount_decimal,description=excluded.description,
           payee=excluded.payee,memo=excluded.memo,currency=excluded.currency,revision=excluded.revision`,
      ).bind(
        tenantId, itemRef, windowStart, windowEnd, storageKey, String(transaction.id),
        transaction.posted != null && Number.isSafeInteger(Number(transaction.posted)) ? Number(transaction.posted) : null,
        transaction.transacted_at != null && Number.isSafeInteger(Number(transaction.transacted_at)) ? Number(transaction.transacted_at) : null,
        transaction.amount == null ? null : String(transaction.amount),
        transaction.description == null ? null : String(transaction.description).slice(0, 500),
        transaction.payee == null ? null : String(transaction.payee).slice(0, 300),
        transaction.memo == null ? null : String(transaction.memo).slice(0, 500),
        currency, revision,
      ));
    }
  }
  // Until publication, revision != staging_revision excludes this window from
  // promotion. Every chunk remains fenced to the pre-dispatch revision.
  await batchInChunks(env, tenantId, window, statements, true);
  await revisionBatch(env, tenantId, window, [
    env.DB.prepare(
      `SELECT CASE WHEN
         (SELECT COUNT(*) FROM simplefin_stage_accounts
           WHERE tenant_id=? AND item_ref=? AND window_start=? AND window_end=? AND revision=?)=?
         AND (SELECT COUNT(*) FROM simplefin_stage_transactions
           WHERE tenant_id=? AND item_ref=? AND window_start=? AND window_end=? AND revision=?)=?
       THEN 1 ELSE json_extract('simplefin incomplete staging','$') END AS completeness_guard`,
    ).bind(tenantId, itemRef, windowStart, windowEnd, revision, validated.accounts.length,
      tenantId, itemRef, windowStart, windowEnd, revision, transactionCount),
    env.DB.prepare(
      `UPDATE simplefin_sync_windows SET revision=?,state='staged',promoted_at=NULL,errlist_json=?,fetched_at=?
        WHERE tenant_id=? AND item_ref=? AND window_start=? AND window_end=? AND staging_revision=?`,
    ).bind(revision, JSON.stringify(validated.errlist), stamp, tenantId, itemRef, windowStart, windowEnd, revision),
  ], true);
  return { accounts: validated.accounts.length, transactions: transactionCount, errlist: validated.errlist };
}

function exactMinor(value, currency) {
  if (value === null || value === undefined) return null;
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(String(value).trim());
  if (!match) return null;
  const exponent = currency === "JPY" || currency === "KRW" ? 0 : 2;
  const fraction = match[3] || "";
  if (fraction.length > exponent && /[1-9]/.test(fraction.slice(exponent))) return null;
  const digits = `${match[2]}${fraction.slice(0, exponent).padEnd(exponent, "0")}`;
  const minor = Number(digits);
  if (!Number.isSafeInteger(minor)) return null;
  return match[1] === "-" ? -minor : minor;
}

function epochDay(value) {
  if (value == null || !Number.isSafeInteger(Number(value)) || Number(value) < 0) return null;
  const date = new Date(Number(value) * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function accountKey(accountRef) { return `simplefin-${accountRef.slice(4)}`.slice(0, 64); }

function namedAccountKind(label, currentMinor) {
  const name = String(label || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ");
  const kinds = [
    ["checking", /\bchecking\b/], ["savings", /\bsavings\b/],
    ["card", /\bcredit card\b/], ["loan", /\bloan\b/],
    ["line_of_credit", /\bline of credit\b/],
  ].filter(([, pattern]) => pattern.test(name)).map(([kind]) => kind);
  // A negative balance alone can be an overdraft. Require one explicit kind;
  // ambiguous names and liability labels with contrary signs stay unknown.
  if (kinds.length !== 1) return "other";
  const kind = kinds[0];
  return ["card", "loan", "line_of_credit"].includes(kind) && (currentMinor === null || currentMinor > 0) ? "other" : kind;
}

async function promoteWindow(env, tenantId, window, stamp) {
  // A complete but overtaken snapshot stays retryable. Do not let assignment
  // replay apply it over a newer overlapping observation, even in later runs.
  const current = await env.DB.prepare(
    `SELECT 1 AS current FROM simplefin_sync_windows w
      WHERE w.tenant_id=? AND w.item_ref=? AND w.window_start=? AND w.window_end=?
        AND w.staging_revision=? AND ${observationFence()}`,
  ).bind(tenantId, window.item_ref, window.window_start, window.window_end, window.revision).first();
  if (!current) return { promoted: false, superseded: true };
  const accounts = rowsOf(await env.DB.prepare(
    `SELECT s.*,a.account_ref,a.entity_slug
       FROM simplefin_stage_accounts s
       LEFT JOIN simplefin_account_assignments a
         ON a.tenant_id=s.tenant_id AND a.item_ref=s.item_ref
        AND a.provider_account_id=s.provider_account_id
        AND a.connection_id=s.connection_id AND a.source_account_id=s.source_account_id
        AND a.account_ref=s.identity_account_ref
      WHERE s.tenant_id=? AND s.item_ref=? AND s.window_start=? AND s.window_end=? AND s.revision=?
      ORDER BY s.provider_account_id`,
  ).bind(tenantId, window.item_ref, window.window_start, window.window_end, window.revision).all());
  for (const account of accounts) {
    if (!account.account_ref) throw new SimpleFinError('simplefin_account_identity_review_required',409);
    if (!account.entity_slug) return { promoted: false, assignment_required: true };
  }
  // Replacing a listing first closes its old coverage authority. An interrupted
  // chunk must not leave a complete certificate beside only some new rows.
  await revisionBatch(env,tenantId,window,[env.DB.prepare(`UPDATE fin_account_coverage
    SET coverage_status='partial',basis_note='SimpleFIN replacement promotion is pending.'
    WHERE tenant_id=? AND source_feed=? AND superseded_by_id IS NULL
      AND account_slug IN (SELECT 'simplefin-'||substr(a.account_ref,5)
        FROM simplefin_stage_accounts s JOIN simplefin_account_assignments a
          ON a.tenant_id=s.tenant_id AND a.item_ref=s.item_ref AND a.provider_account_id=s.provider_account_id
        WHERE s.tenant_id=? AND s.item_ref=? AND s.window_start=? AND s.window_end=? AND s.revision=?)`)
    .bind(tenantId,feedScopeKey(window.item_ref),tenantId,window.item_ref,window.window_start,window.window_end,window.revision)]);
  let transactions = 0;
  let unread = false;
  const coverage = [];
  for (const account of accounts) {
    const transactionRows = rowsOf(await env.DB.prepare(
      `SELECT * FROM simplefin_stage_transactions
        WHERE tenant_id=? AND item_ref=? AND window_start=? AND window_end=?
          AND provider_account_id=? AND revision=? ORDER BY provider_transaction_id`,
    ).bind(
      tenantId, window.item_ref, window.window_start, window.window_end, account.provider_account_id, window.revision,
    ).all());
    const currency = account.currency || "USD";
    const currentMinor = exactMinor(account.balance_decimal, currency);
    const availableMinor = exactMinor(account.available_decimal, currency);
    const accountKind = namedAccountKind(account.account_label, currentMinor);
    const mapped = transactionRows.map((row) => {
      const rawMinor = exactMinor(row.amount_decimal, currency);
      // An occurrence timestamp does not establish the date of posting.
      const postedOn = epochDay(row.posted_epoch);
      const unread = rawMinor === null
        ? "the amount SimpleFIN reported could not be represented exactly in supported minor units"
        : postedOn === null
          ? "SimpleFIN reported no usable posting date"
          : null;
      return {
        locator: `simplefin/transaction/${row.provider_transaction_id}`,
        // fin-import scopes provider IDs to accountKey before deduplication.
        // Keeping only the bounded provider ID here avoids truncating its
        // distinguishing suffix inside the ledger's 190-character UID limit.
        externalId: row.provider_transaction_id,
        postedOn,
        description: row.description || row.memo || null,
        payee: row.payee || null,
        rawAmountMinor: unread ? null : rawMinor,
        amountMinor: unread ? null : Math.abs(rawMinor),
        direction: unread ? null : rawMinor < 0 ? "outflow" : "inflow",
        pending: false,
        currency,
        unparsedReason: unread,
        source: row,
      };
    });
    unread ||= mapped.some(row => row.unparsedReason);
    const envelope = {
      ok: true,
      format: PROVIDER,
      signConvention: "simplefin_negative_amount_is_outflow",
      establishedBy: "SimpleFIN Bridge reports signed account deltas; negative leaves the account",
      sourceDocUid: null,
      sourceLabel: feedScopeKey(window.item_ref),
      accounts: [{
        accountKey: accountKey(account.account_ref),
        institution: account.institution_label || "SimpleFIN Bridge",
        label: account.account_label || "Bank account",
        mask: null,
        accountKind,
        balanceRole: balanceRoleFor(accountKind),
        currency,
        externalRef: account.account_ref,
        periodStart: window.window_start,
        periodEnd: window.window_end,
        // Plaid and the financial ledger express liabilities as amounts owed;
        // SimpleFIN balances are signed account positions. Transaction deltas
        // keep their provider sign regardless of the account's kind.
        ledgerBalanceMinor: currentMinor === null ? null : balanceRoleFor(accountKind) === "liability" ? -currentMinor : currentMinor,
        providerPositionMinor: currentMinor,
        availableBalanceMinor: availableMinor,
        // Retained staging predates current payload validation. An unknown
        // balance timestamp must never become the requested window's end.
        balanceAsOf: epochDay(account.balance_epoch),
        transactions: mapped,
      }],
    };
    const inventory = await simpleFinTransactionInventory(env, { tenantId,
      accountSlug: accountKey(account.account_ref), sourceFeed: feedScopeKey(window.item_ref) });
    const intent = await simpleFinPromotionIntent(env,{inventory,current:mapped,accountRef:account.account_ref,window,stamp});
    await revisionBatch(env,tenantId,window,intent.statements);
    const before = intent.before;
    const complete = account.transactions_present === 1 && window.errlist_json === '[]' &&
      mapped.every(row => !row.unparsedReason && row.postedOn >= window.window_start && row.postedOn <= window.window_end);
    const restore = await simpleFinRestoreStatements(env,inventory,new Set(mapped.map(r => r.externalId)),stamp,
      { current: mapped, window, complete });
    if (restore.length) await revisionBatch(env,tenantId,window,restore);
    const plan = prepareBankExportImport(envelope, {
      tenantId,
      entitySlug: account.entity_slug,
      now: stamp,
      origin: { provenance: "feed", sourceFeed: feedScopeKey(window.item_ref) },
    });
    coverage.push({ ...account, account_slug: accountKey(account.account_ref), complete });
    if (!plan.receipt.imported) throw new SimpleFinError("simplefin_promotion_refused", 409);
    await batchInChunks(env, tenantId, window,
      plan.statements.map(([sql, binds]) => env.DB.prepare(sql).bind(...binds)));
    await revisionBatch(env, tenantId, window, [env.DB.prepare(
      `UPDATE fin_transactions SET source_provider='simplefin'
        WHERE tenant_id=? AND source_feed=? AND (source_provider IS NULL OR source_provider='simplefin')`,
    ).bind(tenantId, feedScopeKey(window.item_ref))]);
    const reconciliation = await simpleFinReconciliationPlan(env, { before, current: mapped,
      tenantId,itemRef: window.item_ref,accountRef: account.account_ref,
      window: { ...window, provider_account_id: account.provider_account_id },stamp,complete: coverage.at(-1).complete });
    if (reconciliation.statements.length) await revisionBatch(env,tenantId,window,reconciliation.statements);
    const after = await simpleFinTransactionInventory(env,before);
    if (after.json !== before.json) {
      const oldRows = new Map(before.rows.map(row => [row.id,row]));
      const newRows = new Map(after.rows.map(row => [row.id,row]));
      const changedDays = new Set();
      for (const id of new Set([...oldRows.keys(),...newRows.keys()])) {
        const old = oldRows.get(id), current = newRows.get(id);
        if (JSON.stringify(old) === JSON.stringify(current)) continue;
        if (old) changedDays.add(old.posted_on);
        if (current) changedDays.add(current.posted_on);
      }
      // Backfill outside a reviewed period cannot change that period's facts.
      // Date corrections invalidate both the old and the new posting periods.
      await revisionBatch(env,tenantId,window,[env.DB.prepare(
        `UPDATE simplefin_coverage_reviews SET revoked_at=? WHERE tenant_id=? AND account_ref=? AND revoked_at IS NULL
          AND EXISTS(SELECT 1 FROM json_each(?) day WHERE day.value IS NULL OR day.value BETWEEN covered_from AND covered_to)`)
        .bind(stamp,tenantId,account.account_ref,JSON.stringify([...changedDays]))]);
    }
    transactions += Number(plan.receipt.transactions || 0);
  }
  // Account receipts can exceed one D1 batch. Publish bounded, revision-fenced
  // chunks before the final promotion; staged windows confer no coverage.
  await batchInChunks(env, tenantId, window,
    simpleFinCoverageStatements(env, { tenantId, itemRef: window.item_ref, window, accounts: coverage, stamp }));
  // Usable rows and balances survive, but a missing array or an out-of-window
  // posting is retryable work just like an unread row. An explicit [] is valid.
  if (unread || coverage.some(account => !account.complete))
    return { promoted: false, unread, incomplete: true, transactions };
  // The current response may omit an account with an older incomplete receipt.
  // Keep that work staged; the atomic promotion guard repeats this decision.
  const listings = await env.DB.prepare(
    `SELECT ${accountListingsCompleteSql()} AS complete FROM simplefin_sync_windows w
      WHERE tenant_id=? AND item_ref=? AND window_start=? AND window_end=? AND revision=?`,
  ).bind(tenantId, window.item_ref, window.window_start, window.window_end, window.revision).first();
  if (listings?.complete === 0)
    return { promoted: false, unread, incomplete: true, transactions };
  const result = await revisionBatch(env, tenantId, window, [
    env.DB.prepare(
      `UPDATE simplefin_sync_windows SET state='promoted',promoted_at=?
        WHERE tenant_id=? AND item_ref=? AND window_start=? AND window_end=? AND revision=? AND state='staged'
          AND ${accountListingsCompleteSql("simplefin_sync_windows")}`,
    ).bind(stamp, tenantId, window.item_ref, window.window_start, window.window_end, window.revision),
    // Exact receipt verification and cursor advancement share the same batch;
    // response loss can only leave an already-committed, replay-safe receipt.
    env.DB.prepare(
      `SELECT CASE WHEN EXISTS (SELECT 1 FROM simplefin_sync_windows w
         WHERE tenant_id=? AND item_ref=? AND window_start=? AND window_end=?
           AND revision=? AND staging_revision=? AND state='promoted' AND promoted_at=?
           AND ${accountListingsCompleteSql()})
       THEN 1 ELSE json_extract('simplefin promotion unverified','$') END AS promotion_verified`,
    ).bind(tenantId, window.item_ref, window.window_start, window.window_end, window.revision, window.revision, stamp),
    env.DB.prepare(
      `UPDATE bank_feed_backfill SET state='running',started_at=COALESCE(started_at,?),
          pages_done=pages_done+1,transactions_seen=transactions_seen+?
        WHERE tenant_id=? AND item_ref=?`,
    ).bind(stamp, transactions, tenantId, window.item_ref),
    env.DB.prepare(
      `UPDATE simplefin_connections SET backfill_next=?,updated_at=?
        WHERE tenant_id=? AND item_ref=? AND backfill_next=? AND backfill_next<=backfill_end
          AND EXISTS (SELECT 1 FROM simplefin_sync_windows w
            WHERE tenant_id=? AND item_ref=? AND window_start=? AND window_end=?
              AND revision=? AND staging_revision=? AND state='promoted' AND errlist_json='[]'
              AND ${accountListingsCompleteSql()})`,
    ).bind(addDays(window.window_end, 1), stamp, tenantId, window.item_ref, window.window_start,
      tenantId, window.item_ref, window.window_start, window.window_end, window.revision, window.revision),
  ]);
  if (rowsOf(result[1])[0]?.promotion_verified !== 1) {
    throw new SimpleFinError("simplefin_promotion_unverified", 503);
  }
  return { promoted: true, transactions };
}

async function refreshSimpleFinCoverage(env, tenantId, itemRef, stamp) {
  const windows = rowsOf(await env.DB.prepare(`SELECT window_start,window_end,revision,staging_revision,state,errlist_json,
    ${accountListingsCompleteSql()} AS listings_complete
    FROM simplefin_sync_windows w WHERE tenant_id=? AND item_ref=? ORDER BY window_start,window_end`)
    .bind(tenantId,itemRef).all());
  if (!windows.length || windows.some(w => w.state !== 'promoted' || w.revision !== w.staging_revision ||
    w.errlist_json !== '[]' || w.listings_complete !== 1 || !w.revision.startsWith(POSTED_HISTORY_REVISION))) return;
  const accounts = rowsOf(await env.DB.prepare(`SELECT s.account_ref,a.account_slug FROM simplefin_account_assignments s
    JOIN fin_accounts a ON a.tenant_id=s.tenant_id AND a.external_ref=s.account_ref AND a.source_feed=('bank-feed:'||s.item_ref)
    WHERE s.tenant_id=? AND s.item_ref=? AND a.superseded_by_id IS NULL`).bind(tenantId,itemRef).all());
  const guard = env.DB.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM bank_feed_items
      WHERE tenant_id=?1 AND item_ref=?2 AND removed_at IS NULL)
    AND (SELECT COUNT(*) FROM simplefin_sync_windows WHERE tenant_id=?1 AND item_ref=?2)=?3
    AND NOT EXISTS(SELECT 1 FROM json_each(?4) e LEFT JOIN simplefin_sync_windows w
      ON w.tenant_id=?1 AND w.item_ref=?2 AND w.window_start=json_extract(e.value,'$.window_start')
        AND w.window_end=json_extract(e.value,'$.window_end')
      WHERE w.revision IS NULL OR w.revision<>json_extract(e.value,'$.revision') OR w.revision<>w.staging_revision
        OR w.state<>'promoted' OR w.errlist_json<>'[]' OR NOT (${accountListingsCompleteSql()}))
    THEN 1 ELSE json_extract('simplefin coverage superseded','$') END AS coverage_guard`)
    .bind(tenantId,itemRef,windows.length,JSON.stringify(windows));
  // Recompute only from explicit bank comparisons. Repeat the exact source
  // fence in each bounded transaction, including assignment-only replays.
  for (let offset=0; offset<accounts.length; offset+=50) await env.DB.batch([guard,
    ...accounts.slice(offset,offset+50).map(account => simpleFinCoverageSummaryStatement(env,
      { tenantId,itemRef,account,stamp })),
  ]);
}

export async function promoteSimpleFinWindows(env, { itemRef = null, now = null } = {}) {
  const { tenantId } = tenantReference(env);
  const stamp = stampOf(now);
  // Old receipts used a truncated endpoint and may contain completed pending
  // rows. Fail closed before any publication, including assignment-only replay.
  await env.DB.prepare(
    `UPDATE fin_account_coverage SET coverage_status='partial',computed_at=?
      WHERE tenant_id=? AND superseded_by_id IS NULL AND EXISTS (
        SELECT 1 FROM simplefin_sync_windows w WHERE w.tenant_id=fin_account_coverage.tenant_id
          AND fin_account_coverage.source_feed='bank-feed:' || w.item_ref
          AND (? IS NULL OR w.item_ref=?) AND substr(w.revision,1,?)<>?)`,
  ).bind(stamp, tenantId, itemRef, itemRef, POSTED_HISTORY_REVISION.length, POSTED_HISTORY_REVISION).run();
  const windows = rowsOf(await env.DB.prepare(
    `SELECT item_ref,window_start,window_end,revision,errlist_json FROM simplefin_sync_windows
      WHERE tenant_id=? AND state='staged' AND revision=staging_revision AND (? IS NULL OR item_ref=?)
        AND substr(revision,1,?)=?
      ORDER BY fetched_at,window_start`,
  ).bind(tenantId, itemRef, itemRef, POSTED_HISTORY_REVISION.length, POSTED_HISTORY_REVISION).all());
  const report = [];
  for (const window of windows) report.push(await promoteWindow(env, tenantId, window, stamp));
  const items = rowsOf(await env.DB.prepare(
    `SELECT item_ref,backfill_next,backfill_end FROM simplefin_connections
      WHERE tenant_id=? AND (? IS NULL OR item_ref=?)`,
  ).bind(tenantId, itemRef, itemRef).all());
  for (const item of items) {
    await refreshSimpleFinCoverage(env, tenantId, item.item_ref, stamp);
    // An install may already say complete because the earlier promoter skipped
    // an incomplete account. Reopen progress from receipts without cursor edits.
    await env.DB.prepare(
      `UPDATE bank_feed_backfill SET state='running',finished_at=NULL
        WHERE tenant_id=? AND item_ref=? AND EXISTS (
          SELECT 1 FROM simplefin_sync_windows w
          WHERE w.tenant_id=bank_feed_backfill.tenant_id AND w.item_ref=bank_feed_backfill.item_ref
            AND (w.state<>'promoted' OR w.revision<>w.staging_revision OR w.errlist_json<>'[]'
              OR NOT (${accountListingsCompleteSql()})))`,
    ).bind(tenantId, item.item_ref).run();
    if (item.backfill_next <= item.backfill_end) continue;
    // Assignment and maintenance may overlap between the listing and this
    // write. Completion must observe the cursor and pending revisions atomically.
    await env.DB.prepare(
      `UPDATE bank_feed_backfill SET state='complete',finished_at=?
        WHERE tenant_id=? AND item_ref=?
          AND EXISTS (SELECT 1 FROM simplefin_connections c
            WHERE c.tenant_id=bank_feed_backfill.tenant_id AND c.item_ref=bank_feed_backfill.item_ref
              AND c.backfill_next>c.backfill_end)
          AND NOT EXISTS (SELECT 1 FROM simplefin_sync_windows w
            WHERE w.tenant_id=bank_feed_backfill.tenant_id AND w.item_ref=bank_feed_backfill.item_ref
              AND (w.state<>'promoted' OR w.revision<>w.staging_revision OR w.errlist_json<>'[]'
                OR NOT (${accountListingsCompleteSql()})))`,
    ).bind(stamp, tenantId, item.item_ref).run();
  }
  return report;
}

async function reserveRequest(env, tenantId, itemRef, stamp) {
  const day = dayOf(stamp);
  const result = await env.DB.prepare(
    `UPDATE simplefin_connections SET
       requests_today=CASE
         WHEN request_day IS NULL OR request_day<? THEN 1
         ELSE COALESCE(requests_today,0)+1
       END,
       request_day=CASE
         WHEN request_day IS NULL OR request_day<? THEN ?
         ELSE request_day
       END,
       updated_at=?
     WHERE tenant_id=? AND item_ref=?
       AND (request_day IS NULL OR request_day<? OR COALESCE(requests_today,0)<?)
     RETURNING request_day,requests_today`,
  ).bind(day, day, day, stamp, tenantId, itemRef, day, DAILY_REQUEST_LIMIT).first();
  if (!result) throw new SimpleFinError("simplefin_daily_request_limit", 429);
  return result;
}

async function requestWindow(env, tenantId, connection, stamp) {
  // Repair the oldest unresolved interval, including pre-versioned receipts.
  // One failed daily pull therefore consumes one bounded retry on a later day;
  // it cannot be silently ignored as the rolling current window moves on.
  const retry = await env.DB.prepare(
    `SELECT window_start,window_end FROM simplefin_sync_windows w
      WHERE tenant_id=? AND item_ref=? AND
        (state<>'promoted' OR revision<>staging_revision OR errlist_json<>'[]' OR substr(revision,1,?)<>?
          OR NOT (${accountListingsCompleteSql()}))
      ORDER BY window_start,window_end LIMIT 1`,
  ).bind(tenantId, connection.item_ref, POSTED_HISTORY_REVISION.length, POSTED_HISTORY_REVISION).first();
  if (retry) return { start: retry.window_start, end: retry.window_end,
    backfill: connection.backfill_next === retry.window_start && connection.backfill_next <= connection.backfill_end };
  // Supply useful first-day records before walking older history. This window
  // does not advance the historical cursor; its normal revision and owner
  // assignment receipts still fence promotion. Interrupted first pulls retry.
  if (connection.last_synced_at == null) {
    const end = dayOf(stamp);
    return { start: addDays(end, -(WINDOW_DAYS - 1)), end, backfill: false };
  }
  if (connection.backfill_next <= connection.backfill_end) {
    return {
      start: connection.backfill_next,
      end: [addDays(connection.backfill_next, WINDOW_DAYS - 1), connection.backfill_end].sort()[0],
      backfill: true,
    };
  }
  const end = dayOf(stamp);
  // The rolling refresh is only an overlap, never a progress cursor. Retries,
  // legacy repairs and missed schedules can outlive it. Derive the earliest
  // outstanding day from durable, verified intervals and fetch bounded chunks.
  const history = rowsOf(await env.DB.prepare(
    `SELECT window_start,window_end FROM simplefin_sync_windows w
      WHERE tenant_id=? AND item_ref=? AND state='promoted' AND revision=staging_revision
        AND errlist_json='[]' AND substr(revision,1,?)=? AND ${accountListingsCompleteSql()} ORDER BY window_start,window_end`,
  ).bind(tenantId, connection.item_ref, POSTED_HISTORY_REVISION.length, POSTED_HISTORY_REVISION).all());
  let next = connection.backfill_start;
  for (const interval of history) {
    if (interval.window_start > next) break;
    if (interval.window_end >= next) next = addDays(interval.window_end, 1);
  }
  const start = next < addDays(end, -2) ? next : addDays(end, -2);
  return { start, end: [addDays(start, WINDOW_DAYS - 1), end].sort()[0], backfill: false };
}

async function readAccessUrl(env, item) {
  return decryptAccessReference(env, {
    ciphertext: item.access_ciphertext,
    iv: item.access_iv,
    keyVersion: item.key_version,
  });
}

async function pullWindow(env, connection, item, {
  fetchImpl,
  stamp,
}) {
  const { tenantId } = tenantReference(env);
  const window = await requestWindow(env, tenantId, connection, stamp);
  const reservation = await reserveRequest(env, tenantId, item.item_ref, stamp);
  const revision = await beginWindowRevision(env, tenantId, item.item_ref, window, stamp, reservation);
  let payload;
  let accessUrl;
  try {
    accessUrl = await readAccessUrl(env, item);
    const endpoint = new URL(accessUrl);
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/accounts`;
    endpoint.search = "";
    endpoint.searchParams.set("version", "2");
    endpoint.searchParams.set("start-date", String(Math.floor(Date.parse(`${window.start}T00:00:00Z`) / 1000)));
    // The protocol excludes the end instant. Next midnight includes every
    // second of the final day, including transactions at 23:59:59.
    endpoint.searchParams.set("end-date", String(Math.floor(Date.parse(`${addDays(window.end, 1)}T00:00:00Z`) / 1000)));
    const request = providerRequest(endpoint.href, "GET", "application/json", "simplefin_pull_request_invalid");
    const response = await fetchImpl(request);
    if ((response.status >= 300 && response.status < 400) || !response.ok) {
      throw new SimpleFinError("simplefin_pull_refused", 502);
    }
    payload = JSON.parse(await boundedText(response, MAX_BODY_BYTES));
  } catch (error) {
    if (error instanceof SimpleFinError) throw error;
    throw new SimpleFinError("simplefin_pull_unavailable", 502);
  }
  const staged = await stageResponse(env, {
    tenantId,
    itemRef: item.item_ref,
    windowStart: window.start,
    windowEnd: window.end,
    payload,
    accessUrl,
    stamp,
    revision,
  });
  const partial = staged.errlist.length > 0;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE simplefin_connections SET last_errlist_json=?,last_pull_partial=?,updated_at=?
        WHERE tenant_id=? AND item_ref=?`,
    ).bind(JSON.stringify(staged.errlist), partial ? 1 : 0, stamp, tenantId, item.item_ref),
    env.DB.prepare(
      `UPDATE bank_feed_items SET last_synced_at=?,status='connected',status_detail=?,last_error_at=NULL
        WHERE tenant_id=? AND item_ref=?`,
    ).bind(
      stamp,
      partial ? `SimpleFIN reported ${staged.errlist.length} issue(s); the history cursor was not advanced.` : null,
      tenantId,
      item.item_ref,
    ),
  ]);
  await promoteSimpleFinWindows(env, { itemRef: item.item_ref, now: stamp });
  return { ...window, ...staged, partial };
}

/** Run a bounded due slice. Three backfill windows or one current window. */
export async function runSimpleFinMaintenance(env, {
  fetchImpl = fetch,
  now = null,
  maxItems = 3,
  maxRequestsPerItem = DEFAULT_REQUESTS_PER_RUN,
} = {}) {
  const { tenantId } = tenantReference(env);
  const stamp = stampOf(now);
  const connections = rowsOf(await env.DB.prepare(
    `SELECT c.*,i.access_ciphertext,i.access_iv,i.key_version,i.status,i.last_synced_at
       FROM simplefin_connections c
       JOIN bank_feed_items i ON i.tenant_id=c.tenant_id AND i.item_ref=c.item_ref
      WHERE c.tenant_id=? AND c.next_pull_at<=? AND i.removed_at IS NULL
        AND i.status IN ('connected','error')
      ORDER BY c.next_pull_at,c.item_ref LIMIT ?`,
  ).bind(tenantId, stamp, Math.max(1, Math.min(Number(maxItems) || 1, 3))).all());
  const report = [];
  for (const connection of connections) {
    const pulls = [];
    const limit = Math.max(1, Math.min(Number(maxRequestsPerItem) || 1, DEFAULT_REQUESTS_PER_RUN));
    let current = { ...connection };
    try {
      for (let request = 0; request < limit; request++) {
        const pulled = await pullWindow(env, current, connection, { fetchImpl, stamp });
        pulls.push(pulled);
        if (pulled.partial || !pulled.backfill) break;
        const persisted = await env.DB.prepare(
          `SELECT backfill_next FROM simplefin_connections WHERE tenant_id=? AND item_ref=?`,
        ).bind(tenantId, connection.item_ref).first();
        if (!persisted || persisted.backfill_next <= pulled.end) break;
        current.backfill_next = persisted.backfill_next;
        if (current.backfill_next > current.backfill_end) break;
      }
      await env.DB.prepare(
        `UPDATE simplefin_connections SET next_pull_at=?,updated_at=? WHERE tenant_id=? AND item_ref=?`,
      ).bind(tomorrow(stamp), stamp, tenantId, connection.item_ref).run();
      report.push({ item_ref: connection.item_ref, ok: true, partial: pulls.some((row) => row.partial), pulls });
    } catch (error) {
      const code = error instanceof SimpleFinError ? error.code : "simplefin_pull_unavailable";
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE bank_feed_items SET status='error',status_detail=?,last_error_at=?
            WHERE tenant_id=? AND item_ref=?`,
        ).bind(code === "simplefin_pending_response_unsupported"
          ? "SimpleFIN returned pending items in a posted-only response. This pull was refused; completed history will be retried."
          : "SimpleFIN could not be read on the last attempt.", stamp, tenantId, connection.item_ref),
        env.DB.prepare(
          `UPDATE simplefin_connections SET next_pull_at=?,updated_at=? WHERE tenant_id=? AND item_ref=?`,
        ).bind(tomorrow(stamp), stamp, tenantId, connection.item_ref),
      ]);
      report.push({ item_ref: connection.item_ref, ok: false, code });
    }
  }
  return { provider: PROVIDER, ran: report.length, items: report };
}

export async function simpleFinOwnerAccountStatus(env) {
  const { tenantId } = tenantReference(env);
  const accounts = rowsOf(await env.DB.prepare(
    `SELECT a.account_ref,a.account_label,a.institution_label,a.currency,a.entity_slug,
            e.display_label,e.legal_name,f.account_slug,f.account_kind,f.balance_role,
            ${accountKindReviewSql('f')} AS account_kind_review_json,c.coverage_status,c.covered_from,c.covered_to
       FROM simplefin_account_assignments a
       JOIN bank_feed_items i ON i.tenant_id=a.tenant_id AND i.item_ref=a.item_ref
        AND i.removed_at IS NULL
       LEFT JOIN fin_entities e ON e.tenant_id=a.tenant_id AND e.entity_slug=a.entity_slug
        AND e.superseded_by_id IS NULL AND e.status='active' AND e.relationship='owned'
       LEFT JOIN fin_accounts f ON f.tenant_id=a.tenant_id AND f.external_ref=a.account_ref AND f.superseded_by_id IS NULL
       LEFT JOIN fin_account_coverage c ON c.tenant_id=f.tenant_id AND c.account_slug=f.account_slug AND c.superseded_by_id IS NULL
      WHERE a.tenant_id=? ORDER BY a.institution_label,a.account_label,a.account_ref`,
  ).bind(tenantId).all());
  const shaped = accounts.map(applyAccountKindReview).map((row) => ({
    account_ref: row.account_ref,
    masked_identifier: row.account_label || "Bank account",
    institution_label: row.institution_label || "SimpleFIN Bridge",
    currency: row.currency,
    account_slug: row.account_slug || null,
    account_kind: row.account_kind || null,
    account_kind_review: row.account_kind_review || null,
    coverage: { status:row.coverage_status || null,from:row.covered_from || null,to:row.covered_to || null },
    assignment: row.entity_slug && row.legal_name ? {
      state: "assigned",
      entity_slug: row.entity_slug,
      entity_label: row.display_label || row.legal_name,
    } : { state: "required" },
  }));
  const missing = shaped.filter((row) => row.assignment.state !== "assigned").length;
  return {
    provider: PROVIDER,
    state: shaped.length === 0 ? "discovering" : missing ? "assignment_required" : "current",
    accounts: shaped,
    summary: { total: shaped.length, assignment_required: missing },
  };
}

export async function assignSimpleFinAccountEntity(env, body, { now = null } = {}) {
  const { tenantId } = tenantReference(env);
  const requestId = String(body?.request_id || "");
  const account = String(body?.account_ref || "");
  const entity = String(body?.entity_slug || "");
  if (!REQUEST_ID.test(requestId) || !/^sfa_[0-9a-f]{32}$/.test(account) || !ENTITY_SLUG.test(entity)) {
    throw new SimpleFinError("simplefin_account_assignment_invalid", 400);
  }
  const prior = await env.DB.prepare(
    `SELECT account_ref,entity_slug,response_json FROM simplefin_assignment_requests
      WHERE tenant_id=? AND request_id=?`,
  ).bind(tenantId, requestId).first();
  if (prior) {
    if (prior.account_ref !== account || prior.entity_slug !== entity) {
      throw new SimpleFinError("request_id_conflict", 409);
    }
    return { status: 200, body: { ...JSON.parse(prior.response_json), replayed: true } };
  }
  const assignment = await env.DB.prepare(
    `SELECT item_ref,provider_account_id,entity_slug FROM simplefin_account_assignments
      WHERE tenant_id=? AND account_ref=?`,
  ).bind(tenantId, account).first();
  if (!assignment) throw new SimpleFinError("simplefin_account_not_found", 404);
  const owner = await env.DB.prepare(
    `SELECT entity_slug FROM fin_entities WHERE tenant_id=? AND entity_slug=?
      AND superseded_by_id IS NULL AND status='active' AND relationship='owned'`,
  ).bind(tenantId, entity).first();
  if (!owner) throw new SimpleFinError("entity_not_owned", 403);
  if (assignment.entity_slug && assignment.entity_slug !== entity) {
    throw new SimpleFinError("bank_account_reassignment_requires_review", 409);
  }
  const response = { ok: true, changed: assignment.entity_slug !== entity, account_ref: account, entity_slug: entity };
  const stamp = stampOf(now);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE simplefin_account_assignments SET entity_slug=?,assigned_at=?
        WHERE tenant_id=? AND account_ref=? AND (entity_slug IS NULL OR entity_slug=?)`,
    ).bind(entity, stamp, tenantId, account, entity),
    env.DB.prepare(
      `INSERT INTO simplefin_assignment_requests
         (tenant_id,request_id,account_ref,entity_slug,response_json,created_at)
       VALUES (?,?,?,?,?,?)`,
    ).bind(tenantId, requestId, account, entity, JSON.stringify(response), stamp),
  ]);
  await promoteSimpleFinWindows(env, { itemRef: assignment.item_ref, now: stamp });
  return { status: response.changed ? 201 : 200, body: response };
}

export async function simpleFinFeedStatus(env) {
  const { tenantId } = tenantReference(env);
  const rows = rowsOf(await env.DB.prepare(
    `SELECT i.item_ref,i.institution_label,i.status,i.status_detail,i.connected_at,i.last_synced_at,
            b.state AS history_state,b.pages_done,b.transactions_seen,b.unread_lines,
            c.backfill_next,c.backfill_end,c.next_pull_at,c.request_day,c.requests_today,
            c.last_errlist_json,c.last_pull_partial,
            (SELECT COUNT(*) FROM simplefin_account_assignments a
              WHERE a.tenant_id=i.tenant_id AND a.item_ref=i.item_ref AND a.entity_slug IS NULL)
              AS accounts_needing_owner
       FROM bank_feed_items i
       JOIN simplefin_connections c ON c.tenant_id=i.tenant_id AND c.item_ref=i.item_ref
       LEFT JOIN bank_feed_backfill b ON b.tenant_id=i.tenant_id AND b.item_ref=i.item_ref
      WHERE i.tenant_id=? AND i.removed_at IS NULL ORDER BY i.connected_at`,
  ).bind(tenantId).all());
  const connections = rows.map((row) => {
    let errors = [];
    try { errors = safeErrlist(JSON.parse(row.last_errlist_json || "[]")); } catch { errors = ["SimpleFIN status could not be read safely."]; }
    return {
      item_ref: row.item_ref,
      institution_label: row.institution_label || "SimpleFIN Bridge",
      provider: PROVIDER,
      status: row.status,
      status_detail: row.status_detail,
      connected_at: row.connected_at,
      last_synced_at: row.last_synced_at,
      next_pull_at: row.next_pull_at,
      provider_errors: errors,
      accounts_needing_owner: Number(row.accounts_needing_owner || 0),
      request_budget: { day: row.request_day || null, used: Number(row.requests_today || 0), limit: DAILY_REQUEST_LIMIT },
      history: {
        state: row.history_state || "queued",
        pages_done: Number(row.pages_done || 0),
        transactions_seen: Number(row.transactions_seen || 0),
        unread_lines: Number(row.unread_lines || 0),
        backfill_complete: row.backfill_next > row.backfill_end,
        partial: row.last_pull_partial === 1,
      },
    };
  });
  return {
    configured: true,
    provider: PROVIDER,
    environment: "production",
    connections,
    needs_attention: connections.filter((row) =>
      row.status !== "connected" || row.provider_errors.length > 0 || row.accounts_needing_owner > 0),
  };
}

export async function disconnectSimpleFinConnection(env, itemRef, { now = null } = {}) {
  const { tenantId } = tenantReference(env);
  const stamp = stampOf(now);
  const item = await env.DB.prepare(
    `SELECT item_ref FROM bank_feed_items WHERE tenant_id=? AND item_ref=? AND removed_at IS NULL`,
  ).bind(tenantId, itemRef).first();
  if (!item) throw new SimpleFinError("simplefin_connection_not_found", 404);
  const sealed = await encryptAccessReference(env, `disconnected:${crypto.randomUUID()}`, {
    keyVersion: BANK_ACCESS_WRAPPING_KEY_VERSION,
  });
  await env.DB.prepare(
    `UPDATE bank_feed_items SET access_ciphertext=?,access_iv=?,key_version=?,status='removed',
        status_detail='Disconnected locally. Cancel provider access in SimpleFIN Bridge.',removed_at=?
      WHERE tenant_id=? AND item_ref=?`,
  ).bind(sealed.ciphertext, sealed.iv, sealed.keyVersion, stamp, tenantId, itemRef).run();
  return { ok: true, provider: PROVIDER, history_kept: true, provider_cancellation_required: true };
}

/** Owner-only setup and account-assignment page. No provider script is loaded. */
export function simpleFinConnectPageHtml(_config, { ownerEntityCount = null } = {}) {
  const open = ownerEntityCount === 0 ? " open" : "";
  const csp = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect SimpleFIN</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1.25rem;color:#202124}h1{font-size:1.55rem;margin-bottom:.4rem}h2{font-size:1.15rem}p{color:#444}.panel{margin:1.5rem 0;border:1px solid #d7dce1;border-radius:.8rem;padding:1rem}.note{font-size:.92rem;color:#62676d}.err{color:#9b1c1c}.ok{color:#285c35}.account{border-top:1px solid #eee;padding:1rem 0}.account:first-child{border-top:0}button,input,select{font:inherit;padding:.7rem;border-radius:.55rem;box-sizing:border-box}input{width:100%;border:1px solid #999}button{border:0;background:#1f2937;color:#fff;cursor:pointer}button:disabled{opacity:.55}.assign{display:flex;gap:.6rem;flex-wrap:wrap}.assign select{min-width:14rem}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:36rem){body{margin:1.5rem auto}.assign>*{width:100%}}</style></head><body>
<h1>Connect SimpleFIN Bridge</h1>
<p>SimpleFIN reads account balances and transactions. It cannot move money. Financial Brain never receives your bank password or verification code.</p>
<section class="panel"><h2>1. Claim this Brain's connection</h2>
<p class="note">In SimpleFIN Bridge, link the banks you want, then create a one-time Setup Token. Paste it here. It goes straight from this page to your own Brain and is not saved.</p>
<form id="claim"><label for="token">One-time Setup Token</label><br><input id="token" type="password" autocomplete="off" required maxlength="8192">
<p><button id="claim-button" type="submit">Claim connection</button></p></form><p id="claim-status" role="status" aria-live="polite"></p></section>
<section class="panel"><h2>2. Choose where each account belongs</h2>
<p class="note">SimpleFIN does not reliably label account types, so new accounts are not counted as cash or debt until that information is separately reviewed.</p>
<details id="entity-details"${open}><summary>Add a person, household, or business</summary>
<form id="entity-create"><p><label for="entity-name">Name</label><br><input id="entity-name" maxlength="120" required autocomplete="off"></p>
<p><label for="entity-kind">What is it?</label><br><select id="entity-kind"><option value="business">Business</option><option value="person">Person</option><option value="household">Household</option><option value="trust">Trust</option><option value="property">Property</option><option value="investment">Investment</option></select></p>
<button type="submit">Save this choice</button><p id="entity-status" role="status" aria-live="polite"></p></form></details>
<p id="account-status" role="status" aria-live="polite">Checking for accounts…</p><div id="accounts"></div><p><button id="refresh" type="button">Check again</button></p></section>
<section class="panel"><h2>3. Review account types and bank dates</h2>
<p>After assigning every account, confirm its type below. Then compare the full transaction list in your bank for the dates you want to ask about, including transfers and repayments. Matching balances alone is not enough. SimpleFIN supplies a subset and cannot certify complete history.</p><div id="reviews"></div><p id="review-status" role="status" aria-live="polite"></p></section>
<section class="panel"><h2>Connection status</h2><div id="connections" aria-live="polite">Checking status…</div></section>
<p><a href="/app">Back to your Brain</a></p>
<script>
const byId=(id)=>document.getElementById(id);const headers={"Content-Type":"application/json","X-Brain-App":"1"};
async function request(path,init){const response=await fetch(path,{credentials:"same-origin",...init,headers});const body=await response.json().catch(()=>({}));if(!response.ok){const error=new Error(body.code||"This step did not finish.");error.code=body.code;throw error}return body}
const get=(path)=>request(path,{method:"GET"});const post=(path,body)=>request(path,{method:"POST",body:JSON.stringify(body||{})});
function node(tag,text,kind){const value=document.createElement(tag);if(text!=null)value.textContent=String(text);if(kind)value.className=kind;return value}
function providerMessage(value){return typeof value==="string"?value:value&&typeof value.text==="string"?value.text:"SimpleFIN reported an issue without readable details."}
async function entities(){const data=await post("/api/fin/snapshot",{sections:["entities"]});return Array.isArray(data.entities)?data.entities.filter((entry)=>entry&&entry.status==="active"&&entry.relationship==="owned"):[]}

function reviewAccounts(accounts){const root=byId("reviews");root.replaceChildren();for(const account of accounts){if(!account.account_slug)continue;const card=node("article",null,"account");card.append(node("h3",account.masked_identifier));const typeLabel=node("label","Account type"),kind=node("select");typeLabel.append(kind);for(const [value,label] of [["checking","Checking"],["savings","Savings"],["card","Credit card"],["loan","Loan"],["line_of_credit","Line of credit"]]){const option=node("option",label);option.value=value;kind.append(option)}kind.value=account.account_kind_review&&account.account_kind_review.state==="current"?account.account_kind:"";const typeButton=node("button","Preview account type");typeButton.type="button";let typePlan=null;kind.onchange=()=>{typePlan=null;typeButton.textContent="Preview account type"};typeButton.onclick=async()=>{try{const base={action:"kind",account_slug:account.account_slug,kind:kind.value};if(!typePlan){typePlan=await post("/api/bank-feed/simplefin/review",{...base,dry_run:true});if(typePlan.blocked)throw new Error();typeButton.textContent="Confirm "+kind.options[kind.selectedIndex].textContent}else{await post("/api/bank-feed/simplefin/review",{...base,dry_run:false,approve:typePlan.plan_hash});await loadAccounts()}}catch{byId("review-status").textContent="The type review could not be saved. Preview again.";typePlan=null}};card.append(typeLabel,typeButton);
const fromLabel=node("label","Bank history from"),from=node("input"),toLabel=node("label"," through"),to=node("input");from.type=to.type="date";fromLabel.append(from);toLabel.append(to);const checkLabel=node("label"," I compared the full bank history for these dates and the saved ledger agrees."),check=node("input");check.type="checkbox";check.style.width="auto";checkLabel.prepend(check);const button=node("button","Preview bank dates"),detail=node("p",null,"note");button.type="button";let plan=null;const reset=()=>{plan=null;button.textContent="Preview bank dates";detail.textContent=""};from.onchange=to.onchange=reset;button.onclick=async()=>{try{const base={action:"coverage",account_ref:account.account_ref,from:from.value,to:to.value};if(!plan){plan=await post("/api/bank-feed/simplefin/review",{...base,dry_run:true});if(plan.blocked){detail.textContent="These dates are not ready. Finish the pull and resolve unread or uncertain transactions first.";plan=null;return}detail.textContent=plan.transaction_count+" saved transactions for "+plan.from+" through "+plan.to+". Compare the complete bank list before confirming.";button.textContent="Confirm compared bank dates"}else{if(!check.checked){detail.textContent="Compare the full bank history and check the confirmation first.";return}await post("/api/bank-feed/simplefin/review",{...base,dry_run:false,approve:plan.plan_hash,confirm_source_comparison:true});byId("review-status").textContent="Bank dates confirmed. You can ask covered-period questions.";await loadAccounts()}}catch{detail.textContent="The bank-date review changed or could not be verified. Preview again.";plan=null}};card.append(node("p",account.coverage&&account.coverage.status==="complete"?"Reviewed bank dates: "+account.coverage.from+" through "+account.coverage.to:"Bank history needs a date review."),fromLabel,toLabel,checkLabel,button,detail);root.append(card)}}

async function loadAccounts(){const status=byId("account-status");try{const values=await Promise.all([get("/api/bank-feed/accounts"),entities()]);const data=values[0],owners=values[1];reviewAccounts(data.accounts||[]);const root=byId("accounts");root.replaceChildren();if(!owners.length)byId("entity-details").open=true;for(const account of data.accounts||[]){const card=node("article",null,"account");card.append(node("h3",account.masked_identifier||"Bank account"));card.append(node("p",account.institution_label||"SimpleFIN Bridge","note"));if(account.assignment&&account.assignment.state==="assigned"){card.append(node("p","Assigned to "+(account.assignment.entity_label||"the selected owner")+"."))}else if(!owners.length){card.append(node("p","Add an owner first, then choose where this account belongs.","note"))}else{const row=node("div",null,"assign"),select=node("select"),button=node("button","Assign account");select.append(node("option","Choose an owner"));select.options[0].value="";for(const owner of owners){const option=node("option",owner.label||owner.legal_name||owner.entity_slug);option.value=owner.entity_slug;select.append(option)}button.type="button";button.onclick=async()=>{if(!select.value){status.textContent="Choose an owner first.";return}button.disabled=true;try{await post("/api/bank-feed/accounts/assign",{request_id:crypto.randomUUID(),account_ref:account.account_ref,entity_slug:select.value});await loadAccounts();await loadConnections()}catch(error){status.textContent="Could not save that choice. Reference code: "+error.code}finally{button.disabled=false}};row.append(select,button);card.append(row)}root.append(card)}const missing=data.summary&&Number(data.summary.assignment_required||0);status.textContent=!data.accounts||!data.accounts.length?"No accounts have arrived yet. The scheduled pull may take a few minutes.":missing?missing+" account(s) still need an owner choice.":"Every discovered account has an owner choice."}catch(error){status.textContent="The account list is unavailable. Reference code: "+error.code;status.className="err"}}
async function loadConnections(){const root=byId("connections");try{const data=await get("/api/bank-feed/status");root.replaceChildren();if(!data.connections||!data.connections.length){root.append(node("p","No SimpleFIN connection is saved yet."));return}for(const connection of data.connections){const card=node("div",null,"account");card.append(node("h3",connection.institution_label||"SimpleFIN Bridge"));card.append(node("p",connection.last_synced_at?"Last pull: "+connection.last_synced_at:"Waiting for the first scheduled pull."));for(const message of connection.provider_errors||[])card.append(node("p",providerMessage(message),"err"));if(connection.accounts_needing_owner)card.append(node("p",connection.accounts_needing_owner+" account(s) need an owner choice.","note"));card.append(node("p","Provider requests today: "+connection.request_budget.used+" of "+connection.request_budget.limit+".","note"));root.append(card)}}catch(error){root.replaceChildren(node("p","Connection status is unavailable. Reference code: "+error.code,"err"))}}
byId("claim").onsubmit=async(event)=>{event.preventDefault();const field=byId("token"),button=byId("claim-button"),status=byId("claim-status");button.disabled=true;status.textContent="Claiming this one-time token…";try{await post("/api/bank-feed/simplefin/claim",{request_id:crypto.randomUUID(),setup_token:field.value});field.value="";status.textContent="Connection saved and encrypted. The scheduled pull will discover accounts.";status.className="ok";await loadConnections()}catch(error){field.value="";status.textContent=error.code==="simplefin_claim_outcome_unknown"?"The one-time claim may have succeeded, but the result could not be confirmed. Do not retry this token. Create a new Setup Token in SimpleFIN Bridge after reviewing saved connections.":"The connection was not claimed. Reference code: "+error.code;status.className="err"}finally{button.disabled=false}};
byId("entity-create").onsubmit=async(event)=>{event.preventDefault();const name=byId("entity-name").value.trim(),status=byId("entity-status");if(!name)return;const stem=name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,45)||"entity";try{await post("/api/owner/entities/create",{request_id:crypto.randomUUID(),entity_slug:stem+"-"+crypto.randomUUID().slice(0,8),legal_name:name,kind:byId("entity-kind").value});byId("entity-name").value="";status.textContent="Saved.";await loadAccounts()}catch(error){status.textContent="Could not save that owner. Reference code: "+error.code}};
byId("refresh").onclick=()=>{loadAccounts();loadConnections()};loadAccounts();loadConnections();
</script></body></html>`;
  return { html, csp };
}
