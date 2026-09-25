/** Durable at-most-once boundary for one billable OCR page invocation. */

export const OCR_REQUEST_ID = /^[0-9a-f]{64}$/u;
export const OCR_REPLAY_KEY = /^[A-Za-z0-9_-]{43}$/u;
export const OCR_RESERVATION_TTL_MS = 5 * 60 * 1000;
export const OCR_IN_FLIGHT_TTL_MS = 15 * 60 * 1000;
export const OCR_REPLAY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const OCR_PROVIDER_FAILURE_BACKOFF_MS = 60 * 1000;
export const OCR_MODEL_CALL_WINDOW_MS = 24 * 60 * 60 * 1000;
export const OCR_MAX_MODEL_CALLS_PER_WINDOW = 3;

const encoder = new TextEncoder();

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function canonicalOcrInput({ image, model, prompt }) {
  return `financial-brain:ocr-page-request:v1\0${String(model || "")}\0${String(prompt || "")}\0${String(image || "")}`;
}

/**
 * Bind identical page bytes to the exact source document and page that owns
 * the billable call. The resulting SHA-256 is the only document identity D1
 * retains; source locators and names never enter the receipt table.
 */
export function canonicalOcrPageIdentity({ image, model, prompt, source, sourceItemId, page }) {
  if (typeof source !== "string" || !source ||
      typeof sourceItemId !== "string" || !sourceItemId ||
      !Number.isSafeInteger(page) || page < 1) {
    throw new TypeError("OCR page identity needs an exact source, source item id, and positive page index");
  }
  return `financial-brain:ocr-page-identity:v2\0${JSON.stringify([
    source,
    sourceItemId,
    page,
    String(model || ""),
    String(prompt || ""),
  ])}\0${String(image || "")}`;
}

export async function ocrPageRequestId(input) {
  return sha256Hex(canonicalOcrPageIdentity(input));
}

/**
 * Recover the encrypted handoff on a later source pass without persisting a
 * plaintext key. The separate domain means the permanent request-id tombstone
 * is not enough to derive this key; the caller must still possess the exact
 * private page identity, including its rendered bytes.
 */
export async function ocrPageReplayKey(input) {
  canonicalOcrPageIdentity(input);
  const pageBytesSha256 = await sha256Hex(String(input?.image || ""));
  const replayIdentity = JSON.stringify([
    input?.source,
    input?.sourceItemId,
    input?.page,
    String(input?.model || ""),
    String(input?.prompt || ""),
    pageBytesSha256,
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(
      `financial-brain:ocr-page-replay-key:v1\0${replayIdentity}`,
    ),
  );
  return base64UrlEncode(digest);
}

function exactReturningRow(result, requestId) {
  return Array.isArray(result?.results) && result.results.length === 1 &&
    result.results[0]?.request_id === requestId;
}

function validDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function expiryFrom(now, ttlMs) {
  return new Date(now.getTime() + ttlMs).toISOString();
}

function modelCallBudget(row) {
  const count = Number(row?.model_call_count);
  const windowStartedAtMs = Date.parse(String(row?.model_call_window_started_at || ""));
  if (!Number.isSafeInteger(count) || count < 0 || count > OCR_MAX_MODEL_CALLS_PER_WINDOW ||
      (count === 0 && row?.model_call_window_started_at != null) ||
      (count > 0 && !Number.isFinite(windowStartedAtMs))) {
    throw new Error("the OCR model-call budget receipt is malformed");
  }
  return Object.freeze({ count, windowStartedAtMs });
}

function dailyModelCallCapDecision(budget, now) {
  if (budget.count < OCR_MAX_MODEL_CALLS_PER_WINDOW) return null;
  const windowExpiresAtMs = budget.windowStartedAtMs + OCR_MODEL_CALL_WINDOW_MS;
  if (windowExpiresAtMs <= now.getTime()) return null;
  return Object.freeze({
    state: "retry_later",
    retryAfterMs: Math.max(1, windowExpiresAtMs - now.getTime()),
    dailyModelCallCap: true,
    modelCallsInWindow: budget.count,
  });
}

function usageReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const receipt = {};
  for (const key of ["prompt_tokens", "completion_tokens", "input_tokens", "output_tokens", "total_tokens"]) {
    const amount = value[key];
    if (Number.isFinite(amount) && amount >= 0) receipt[key] = amount;
  }
  return receipt;
}

function isUsableOcrSuccess(status, body, requestId) {
  return status === 200 && body && typeof body === "object" && !Array.isArray(body) &&
    typeof body.text === "string" && body.text.trim().length > 0 &&
    body.request_id === requestId && body.error == null;
}

async function contentFreeReceipt(body) {
  return {
    schema_version: 1,
    response_sha256: await sha256Hex(JSON.stringify(body)),
    usage: usageReceipt(body?.usage),
    ocr_reread_after_expiry: body?.ocr_reread_after_expiry === true ? 1 : 0,
  };
}

function base64UrlEncode(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value) {
  const text = String(value || "");
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - text.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function replayKeyFingerprint(replayKey) {
  if (replayKey == null) return null;
  if (!OCR_REPLAY_KEY.test(String(replayKey))) throw new TypeError("OCR replay key is invalid");
  return sha256Hex(replayKey);
}

async function encryptReplay(body, replayKey) {
  if (replayKey == null) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    base64UrlDecode(replayKey),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify(body)),
  );
  return {
    keySha256: await replayKeyFingerprint(replayKey),
    iv: base64UrlEncode(iv),
    ciphertext: base64UrlEncode(ciphertext),
  };
}

async function pruneExpiredReplay(db, nowIso) {
  try {
    await db.prepare(
      `UPDATE ocr_page_requests
          SET replay_key_sha256=NULL,replay_expires_at=NULL,replay_iv=NULL,replay_ciphertext=NULL
        WHERE status='completed' AND acknowledged_at IS NOT NULL AND replay_expires_at <= ?1`,
    ).bind(nowIso).run();
  } catch {
    // Handoff cleanup is not authority to weaken the permanent tombstone.
    // Claim/readback below still fails closed if D1 is unavailable.
  }
}

export async function acknowledgeOcrPageRequests(db, {
  requestIds,
  now = new Date(),
} = {}) {
  if (!db?.prepare || !Array.isArray(requestIds) || requestIds.length < 1 || requestIds.length > 100 ||
      !validDate(now) || requestIds.some((requestId) => !OCR_REQUEST_ID.test(String(requestId || ""))) ||
      new Set(requestIds).size !== requestIds.length) {
    throw new TypeError("OCR acknowledgement is invalid");
  }
  const acknowledgedAt = now.toISOString();
  const placeholders = requestIds.map((_, index) => `?${index + 2}`).join(",");
  const result = await db.prepare(
    `UPDATE ocr_page_requests
        SET acknowledged_at=COALESCE(acknowledged_at,?1),
            response_json=json_set(
              response_json,
              '$.acknowledged_at',
              COALESCE(json_extract(response_json,'$.acknowledged_at'),?1)
            )
      WHERE request_id IN (${placeholders}) AND status='completed'
      RETURNING request_id,acknowledged_at,response_json`,
  ).bind(acknowledgedAt, ...requestIds).all();
  if (!Array.isArray(result?.results) || result.results.length !== requestIds.length) {
    throw new Error("the OCR acknowledgement receipt was incomplete");
  }
  const returned = new Set();
  for (const row of result.results) {
    if (!requestIds.includes(row?.request_id) || returned.has(row.request_id) ||
        typeof row.acknowledged_at !== "string") {
      throw new Error("the OCR acknowledgement receipt was ambiguous");
    }
    let receipt;
    try { receipt = JSON.parse(row.response_json); }
    catch { throw new Error("the OCR acknowledgement receipt was malformed"); }
    if (receipt?.acknowledged_at !== row.acknowledged_at) {
      throw new Error("the OCR acknowledgement receipt was not read back exactly");
    }
    returned.add(row.request_id);
  }
  return Object.freeze({ acknowledged: returned.size });
}

export async function replayOcrPageResponse({ receipt, handoff, replayKey } = {}) {
  if (!receipt || !handoff || !OCR_REPLAY_KEY.test(String(replayKey || "")) ||
      !OCR_REQUEST_ID.test(String(receipt.response_sha256 || "")) ||
      typeof handoff.iv !== "string" || typeof handoff.ciphertext !== "string") {
    throw new TypeError("OCR replay handoff is invalid");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    base64UrlDecode(replayKey),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlDecode(handoff.iv) },
    key,
    base64UrlDecode(handoff.ciphertext),
  );
  const json = new TextDecoder().decode(plaintext);
  if (await sha256Hex(json) !== receipt.response_sha256) {
    throw new Error("the OCR replay handoff does not match its content-free receipt");
  }
  const body = JSON.parse(json);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("the OCR replay handoff is malformed");
  }
  return body;
}

export async function claimOcrPageRequest(db, {
  requestId,
  inputSha256,
  ownerToken,
  replayKey = null,
  now = new Date(),
} = {}) {
  if (!db?.prepare || !OCR_REQUEST_ID.test(String(requestId || "")) ||
      !OCR_REQUEST_ID.test(String(inputSha256 || "")) ||
      typeof ownerToken !== "string" || ownerToken.length < 32 || ownerToken.length > 64 || !validDate(now)) {
    throw new TypeError("OCR idempotency claim is invalid");
  }
  const nowIso = now.toISOString();
  const reservationExpiresAt = expiryFrom(now, OCR_RESERVATION_TTL_MS);
  const replayKeySha256 = await replayKeyFingerprint(replayKey);
  await pruneExpiredReplay(db, nowIso);
  const inserted = await db.prepare(
    `INSERT INTO ocr_page_requests
       (request_id,input_sha256,status,owner_token,started_at,expires_at,replay_key_sha256)
     VALUES (?1,?2,'pending',?3,?4,?5,?6)
     ON CONFLICT(request_id) DO NOTHING
     RETURNING request_id`,
  ).bind(requestId, inputSha256, ownerToken, nowIso, reservationExpiresAt, replayKeySha256).all();
  if (exactReturningRow(inserted, requestId)) return Object.freeze({ state: "claimed" });
  if (!Array.isArray(inserted?.results) || inserted.results.length !== 0) {
    throw new Error("the OCR idempotency reservation receipt was ambiguous");
  }

  const existing = await db.prepare(
    `SELECT request_id,input_sha256,status,owner_token,started_at,model_started_at,completed_at,
            expires_at,response_status,response_json,
            replay_key_sha256,replay_expires_at,replay_iv,replay_ciphertext,
            acknowledged_at,reread_count,provider_failed_at,
            model_call_count,model_call_window_started_at
       FROM ocr_page_requests WHERE request_id=?1`,
  ).bind(requestId).first();
  if (!existing || existing.request_id !== requestId) {
    throw new Error("the OCR idempotency reservation disappeared");
  }
  if (existing.input_sha256 !== inputSha256) return Object.freeze({ state: "conflict" });
  const budget = modelCallBudget(existing);
  if (existing.status === "pending") {
    const expiresAtMs = Date.parse(String(existing.expires_at || ""));
    if (!Number.isFinite(expiresAtMs)) {
      throw new Error("the OCR idempotency reservation expiry is malformed");
    }
    if (expiresAtMs > now.getTime()) {
      return Object.freeze({ state: "pending", retryAfterMs: Math.min(2_000, Math.max(1, expiresAtMs - now.getTime())) });
    }
    const capDecision = dailyModelCallCapDecision(budget, now);
    if (capDecision) return capDecision;
    // Only this pre-model state is safe to reclaim automatically. The exact old
    // owner and timestamps make the takeover a compare-and-swap rather than a
    // blind lease steal from a concurrent request.
    const reclaimed = await db.prepare(
      `UPDATE ocr_page_requests
          SET owner_token=?1,started_at=?2,expires_at=?3,replay_key_sha256=?4
        WHERE request_id=?5 AND input_sha256=?6 AND status='pending'
          AND owner_token=?7 AND started_at=?8 AND expires_at=?9
        RETURNING request_id`,
    ).bind(
      ownerToken,
      nowIso,
      reservationExpiresAt,
      replayKeySha256,
      requestId,
      inputSha256,
      existing.owner_token,
      existing.started_at,
      existing.expires_at,
    ).all();
    if (!exactReturningRow(reclaimed, requestId)) {
      throw new Error("the OCR idempotency reservation reclaim was ambiguous");
    }
    return Object.freeze({ state: "claimed", reclaimed: true });
  }
  if (existing.status === "in_flight") {
    const expiresAtMs = Date.parse(String(existing.expires_at || ""));
    if (!Number.isFinite(expiresAtMs)) {
      throw new Error("the OCR idempotency in-flight expiry is malformed");
    }
    if (expiresAtMs > now.getTime()) {
      return Object.freeze({ state: "pending", retryAfterMs: Math.min(2_000, Math.max(1, expiresAtMs - now.getTime())) });
    }
    const capDecision = dailyModelCallCapDecision(budget, now);
    if (capDecision) return capDecision;
    // A crashed Worker can leave the row in-flight forever. Once its full
    // ambiguity window has elapsed, permit one replacement inside the next
    // window. The exact old receipt is the compare-and-swap boundary, so two
    // resumptions cannot both start a model call.
    const rearmed = await db.prepare(
      `UPDATE ocr_page_requests
          SET status='pending',owner_token=?1,started_at=?2,expires_at=?3,
              model_started_at=NULL,completed_at=NULL,response_status=NULL,response_json=NULL,
              replay_key_sha256=?4,replay_expires_at=NULL,replay_iv=NULL,replay_ciphertext=NULL,
              acknowledged_at=NULL,reread_count=1,provider_failed_at=NULL
        WHERE request_id=?5 AND input_sha256=?6 AND status='in_flight'
          AND owner_token=?7 AND started_at=?8 AND model_started_at=?9 AND expires_at=?10
          AND reread_count=?11 AND provider_failed_at IS ?12
          AND model_call_count=?13 AND model_call_window_started_at=?14
        RETURNING request_id`,
    ).bind(
      ownerToken,
      nowIso,
      reservationExpiresAt,
      replayKeySha256,
      requestId,
      inputSha256,
      existing.owner_token,
      existing.started_at,
      existing.model_started_at,
      existing.expires_at,
      existing.reread_count,
      existing.provider_failed_at,
      budget.count,
      existing.model_call_window_started_at,
    ).all();
    if (!exactReturningRow(rearmed, requestId)) {
      throw new Error("the OCR expired in-flight re-read receipt was ambiguous");
    }
    return Object.freeze({ state: "claimed", rereadAfterExpiry: true });
  }
  if (existing.status !== "completed" || ![0, 1].includes(Number(existing.reread_count))) {
    throw new Error("the OCR idempotency receipt is malformed");
  }
  let body = null;
  try { body = JSON.parse(existing.response_json); }
  catch { /* A malformed stored result is unusable, not a permanent hold. */ }
  const receiptUsable = body && typeof body === "object" && !Array.isArray(body) &&
    OCR_REQUEST_ID.test(String(body.response_sha256 || "")) && body.schema_version === 1 &&
    [0, 1].includes(Number(body.ocr_reread_after_expiry || 0));
  const handoffFields = [existing.replay_key_sha256, existing.replay_expires_at,
    existing.replay_iv, existing.replay_ciphertext];
  const handoffPresent = handoffFields.every((value) => typeof value === "string" && value.length > 0);
  if (existing.response_status === 200 && receiptUsable && handoffPresent) {
    const replayExpiresAtMs = Date.parse(existing.replay_expires_at);
    const unacknowledged = existing.acknowledged_at == null;
    if (Number.isFinite(replayExpiresAtMs) && replayKeySha256 === existing.replay_key_sha256 &&
        (unacknowledged || replayExpiresAtMs > now.getTime())) {
      try {
        const replay = await replayOcrPageResponse({
          receipt: body,
          handoff: { iv: existing.replay_iv, ciphertext: existing.replay_ciphertext },
          replayKey,
        });
        if (isUsableOcrSuccess(existing.response_status, replay, requestId)) {
          return Object.freeze({ state: "replayable", status: existing.response_status, replay });
        }
      } catch {
        // A matching fingerprint is not proof that the IV, ciphertext, or
        // plaintext receipt is usable. Fall through to the same compare-and-
        // swap replacement boundary as every other unavailable handoff.
      }
    }
  }

  const completedAtMs = Date.parse(String(existing.completed_at || ""));
  const priorWindowExpiresAtMs = Date.parse(String(existing.expires_at || ""));
  // The first unusable handoff gets one immediate exit. A fresh receipt
  // produced by that replacement starts a new seven-day window, preventing a
  // caller without the matching private identity from creating an unbounded
  // series of model calls.
  const nextRereadAtMs = Number(existing.reread_count) === 0
    ? now.getTime()
    : Number.isFinite(completedAtMs)
      ? completedAtMs + OCR_REPLAY_TTL_MS
      : Number.isFinite(priorWindowExpiresAtMs)
        ? priorWindowExpiresAtMs
        : now.getTime();
  if (nextRereadAtMs > now.getTime()) {
    return Object.freeze({
      state: "retry_later",
      retryAfterMs: Math.max(1, nextRereadAtMs - now.getTime()),
    });
  }
  const capDecision = dailyModelCallCapDecision(budget, now);
  if (capDecision) return capDecision;
  // Missing fields, a mismatched key fingerprint, bad expiry data, failed
  // decryption, and an expired acknowledged handoff all use this one CAS. The
  // replacement result belongs to a fresh receipt and must be acknowledged
  // only after its transcription reaches the complete stored document family.
  const rearmed = await db.prepare(
    `UPDATE ocr_page_requests
        SET status='pending',owner_token=?1,started_at=?2,expires_at=?3,
            model_started_at=NULL,completed_at=NULL,response_status=NULL,response_json=NULL,
            replay_key_sha256=?4,replay_expires_at=NULL,replay_iv=NULL,replay_ciphertext=NULL,
            acknowledged_at=NULL,reread_count=1
      WHERE request_id=?5 AND input_sha256=?6 AND status='completed'
        AND owner_token=?7 AND started_at=?8 AND model_started_at=?9
        AND completed_at IS ?10 AND expires_at IS ?11 AND response_status IS ?12
        AND response_json IS ?13 AND reread_count=?14
        AND replay_key_sha256 IS ?15 AND replay_expires_at IS ?16
        AND replay_iv IS ?17 AND replay_ciphertext IS ?18
      RETURNING request_id`,
  ).bind(
    ownerToken,
    nowIso,
    reservationExpiresAt,
    replayKeySha256,
    requestId,
    inputSha256,
    existing.owner_token,
    existing.started_at,
    existing.model_started_at,
    existing.completed_at,
    existing.expires_at,
    existing.response_status,
    existing.response_json,
    existing.reread_count,
    existing.replay_key_sha256,
    existing.replay_expires_at,
    existing.replay_iv,
    existing.replay_ciphertext,
  ).all();
  if (!exactReturningRow(rearmed, requestId)) {
    throw new Error("the OCR expiry re-read receipt was ambiguous");
  }
  return Object.freeze({ state: "claimed", rereadAfterExpiry: true });
}

export async function startOcrPageRequest(db, {
  requestId,
  inputSha256,
  ownerToken,
  now = new Date(),
} = {}) {
  if (!validDate(now)) throw new TypeError("OCR idempotency start is invalid");
  const startedAt = now.toISOString();
  const expiresAt = expiryFrom(now, OCR_IN_FLIGHT_TTL_MS);
  const modelCallWindowCutoff = new Date(now.getTime() - OCR_MODEL_CALL_WINDOW_MS).toISOString();
  const result = await db.prepare(
    `UPDATE ocr_page_requests
        SET status='in_flight',model_started_at=?1,expires_at=?2,provider_failed_at=NULL,
            model_call_count=CASE
              WHEN model_call_window_started_at IS NULL OR model_call_window_started_at <= ?3 THEN 1
              ELSE model_call_count + 1
            END,
            model_call_window_started_at=CASE
              WHEN model_call_window_started_at IS NULL OR model_call_window_started_at <= ?3 THEN ?1
              ELSE model_call_window_started_at
            END
      WHERE request_id=?4 AND input_sha256=?5 AND owner_token=?6 AND status='pending'
        AND (model_call_window_started_at IS NULL OR model_call_window_started_at <= ?3
          OR model_call_count < ${OCR_MAX_MODEL_CALLS_PER_WINDOW})
      RETURNING request_id`,
  ).bind(startedAt, expiresAt, modelCallWindowCutoff, requestId, inputSha256, ownerToken).all();
  if (!exactReturningRow(result, requestId)) {
    throw new Error("the OCR idempotency model-start receipt was ambiguous");
  }
}

export async function completeOcrPageRequest(db, {
  requestId,
  inputSha256,
  ownerToken,
  status,
  body,
  replayKey = null,
  now = new Date(),
} = {}) {
  if (!isUsableOcrSuccess(status, body, requestId) || !validDate(now)) {
    throw new TypeError("OCR idempotency completion is invalid");
  }
  const completedAt = now.toISOString();
  const replayExpiresAt = replayKey == null ? null : expiryFrom(now, OCR_REPLAY_TTL_MS);
  const receipt = await contentFreeReceipt(body);
  const handoff = await encryptReplay(body, replayKey);
  const result = await db.prepare(
    `UPDATE ocr_page_requests
        SET status='completed',completed_at=?1,response_status=?2,response_json=?3,
            replay_key_sha256=?4,replay_expires_at=?5,replay_iv=?6,replay_ciphertext=?7
      WHERE request_id=?8 AND input_sha256=?9 AND owner_token=?10 AND status='in_flight'
      RETURNING request_id`,
  ).bind(
    completedAt,
    status,
    JSON.stringify(receipt),
    handoff?.keySha256 || null,
    replayExpiresAt,
    handoff?.iv || null,
    handoff?.ciphertext || null,
    requestId,
    inputSha256,
    ownerToken,
  ).all();
  if (!exactReturningRow(result, requestId)) {
    throw new Error("the OCR idempotency completion receipt was ambiguous");
  }
}

export async function recordRetryableOcrPageFailure(db, {
  requestId,
  inputSha256,
  ownerToken,
  now = new Date(),
} = {}) {
  if (!validDate(now)) throw new TypeError("OCR retryable failure receipt is invalid");
  const failedAt = now.toISOString();
  const expiresAt = expiryFrom(now, OCR_PROVIDER_FAILURE_BACKOFF_MS);
  // The model-start transition remains the durable billing boundary, while a
  // returned provider error proves this call is no longer ambiguous. Keep it
  // non-replayable and use a short backoff before the next budgeted CAS.
  const result = await db.prepare(
    `UPDATE ocr_page_requests
        SET expires_at=?1,provider_failed_at=?2
      WHERE request_id=?3 AND input_sha256=?4 AND owner_token=?5 AND status='in_flight'
        AND model_call_count BETWEEN 1 AND ${OCR_MAX_MODEL_CALLS_PER_WINDOW}
      RETURNING request_id`,
  ).bind(expiresAt, failedAt, requestId, inputSha256, ownerToken).all();
  if (!exactReturningRow(result, requestId)) {
    throw new Error("the OCR retryable failure receipt was ambiguous");
  }
}

export async function releaseOcrPageRequest(db, {
  requestId,
  inputSha256,
  ownerToken,
} = {}) {
  const result = await db.prepare(
    `DELETE FROM ocr_page_requests
      WHERE request_id=?1 AND input_sha256=?2 AND owner_token=?3 AND status='in_flight'
      RETURNING request_id`,
  ).bind(requestId, inputSha256, ownerToken).all();
  if (!exactReturningRow(result, requestId)) {
    throw new Error("the OCR idempotency release receipt was ambiguous");
  }
}
