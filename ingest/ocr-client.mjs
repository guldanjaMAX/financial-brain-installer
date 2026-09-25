/**
 * Bounded client for one billable OCR page request.
 *
 * This module deliberately knows nothing about files, manifests or source
 * cursors. Its unit of identity is the exact source, source item, page index,
 * model, prompt and rendered page bytes. Every retry carries the same opaque
 * SHA-256 request id so the Worker can return the first completed transcription
 * instead of invoking the model and charging for the same page twice. Two
 * documents with identical rendered bytes remain two independent requests.
 */

import {
  ocrPageReplayKey,
  ocrPageRequestId,
} from "../worker/src/lib/ocr-idempotency.js";

export const OCR_PAGE_ATTEMPTS = 3;
export const OCR_PAGE_TIMEOUT_MS = 60_000;
export const OCR_PAGE_RETRY_TIMEOUT_STEP_MS = 30_000;
export const OCR_HEALTH_TIMEOUT_MS = 15_000;

const validRequestId = (value) => /^[0-9a-f]{64}$/u.test(String(value || ""));

export async function acknowledgeOcrPageRequests({
  base,
  adminKey,
  requestIds,
  httpImpl,
  assertOwned = null,
} = {}) {
  const ids = Array.isArray(requestIds) ? [...new Set(requestIds.map(String))] : [];
  if (typeof httpImpl !== "function" || ids.length < 1 || ids.length > 100 ||
      ids.some((requestId) => !validRequestId(requestId))) {
    throw new TypeError("OCR acknowledgement dependencies are invalid");
  }
  assertOwned?.();
  const response = await httpImpl(`${base}/api/admin/brain/ocr`, {
    method: "POST",
    headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json" },
    body: JSON.stringify({ acknowledge_request_ids: ids }),
  }, { timeoutMs: OCR_HEALTH_TIMEOUT_MS, what: "the OCR source acknowledgement" });
  let body;
  try { body = await response.json(); }
  catch { body = null; }
  if (!response.ok || body?.ocr_acknowledged !== ids.length) {
    const error = new Error(
      "OCR source acknowledgement could not be confirmed. The source cursor was not advanced, and the encrypted handoff was retained.",
    );
    error.name = "OcrAcknowledgementUnavailableError";
    error.code = "OCR_ACKNOWLEDGEMENT_UNAVAILABLE";
    error.fatal = true;
    error.retryable = true;
    error.system_evidence = true;
    throw error;
  }
  return Object.freeze({ acknowledged: ids.length });
}

function clockMs(now) {
  const value = now();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError("OCR retry clock is invalid");
  return milliseconds;
}

function transportCode(error) {
  return String(error?.cause?.code || error?.code || "");
}

export function isOcrTimeout(error) {
  const name = String(error?.name || "");
  const code = transportCode(error);
  const message = String(error?.message || error || "");
  return name === "TimeoutError" || name === "AbortError" ||
    code === "ETIMEDOUT" || /^UND_ERR_.*TIMEOUT$/u.test(code) || /timed out/i.test(message);
}

function retryDelayMs(attempt, random) {
  const jitter = 0.75 + Math.max(0, Math.min(1, Number(random()) || 0)) * 0.5;
  return Math.round(2_000 * (2 ** Math.max(0, attempt - 1)) * jitter);
}

async function brainIsReachable({ base, httpImpl, assertOwned }) {
  try {
    assertOwned?.();
    const response = await httpImpl(`${base}/health`, {}, {
      timeoutMs: OCR_HEALTH_TIMEOUT_MS,
      what: "the health probe after the slow OCR page",
    });
    return response?.ok === true;
  } catch (error) {
    if (error?.code === "source_ingest_lock_lost") throw error;
    return false;
  }
}

function unreachableError(page, attempts, cause) {
  const error = new Error(
    `OCR stopped after page ${page} stayed slow for ${attempts} attempts and the Brain health probe failed. ` +
      "Progress is saved, and this page will be checked again when the same pass resumes.",
  );
  error.name = "OcrBrainUnreachableError";
  error.code = "NETWORK_UNREACHABLE";
  error.fatal = true;
  error.cause = cause;
  return error;
}

function systemUnavailableError(page, cause, detail = "") {
  const explanation = String(detail || cause?.message || cause || "the OCR service was unavailable").slice(0, 240);
  const error = new Error(
    `OCR stopped at page ${page} because the system could not complete the request. ${explanation} ` +
      "The previous document revision was kept, and the source cursor was not advanced.",
  );
  error.name = "OcrSystemUnavailableError";
  error.code = "OCR_SYSTEM_UNAVAILABLE";
  error.fatal = true;
  error.retryable = true;
  error.system_evidence = true;
  error.cause = cause;
  return error;
}

/**
 * Create the callback consumed by extractPdf.
 *
 * `httpImpl` and `loadPrompt` are injected so the real CLI path remains easy
 * to probe without ambient credentials or network access.
 */
export function createOcrCallback({
  base,
  adminKey,
  model,
  maxPages,
  onPage = () => {},
  onRetry = () => {},
  onSkip = () => {},
  httpImpl,
  loadPrompt,
  assertOwned = null,
  attempts = OCR_PAGE_ATTEMPTS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
  now = Date.now,
} = {}) {
  if (typeof httpImpl !== "function" || typeof loadPrompt !== "function") {
    throw new TypeError("OCR callback dependencies are incomplete");
  }
  const totalAttempts = Math.max(1, Math.trunc(Number(attempts) || 1));
  const stats = { retriedPages: 0, skippedPages: 0, rereadAfterExpiry: 0 };

  const call = async (image, { page, totalPages, source, sourceItemId } = {}) => {
    const prompt = await loadPrompt();
    const pageIdentity = {
      image: image?.png_base64,
      model,
      prompt,
      source,
      sourceItemId,
      page,
    };
    const [requestId, replayKey] = await Promise.all([
      ocrPageRequestId(pageIdentity),
      ocrPageReplayKey(pageIdentity),
    ]);
    // The Worker stores only AES-GCM ciphertext for the bounded lost-response
    // handoff. A domain-separated hash of the exact private page identity lets
    // a later source pass reproduce the key without writing it to source state
    // or making it derivable from the durable request-id tombstone alone.
    const body = JSON.stringify({
      image_base64: image.png_base64,
      page,
      prompt,
      request_id: requestId,
      replay_key: replayKey,
    });
    let lastTimeout = null;
    let retryCounted = false;

    const countRetry = () => {
      if (retryCounted) return;
      retryCounted = true;
      stats.retriedPages++;
    };

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      const timeoutMs = OCR_PAGE_TIMEOUT_MS + (attempt - 1) * OCR_PAGE_RETRY_TIMEOUT_STEP_MS;
      const deadlineMs = clockMs(now) + timeoutMs;
      let deadlineExpired = false;
      let pendingPoll = 0;

      while (!deadlineExpired) {
        const remainingMs = Math.max(0, deadlineMs - clockMs(now));
        if (remainingMs === 0) {
          lastTimeout = new Error(`the ${Math.round(timeoutMs / 1000)}-second OCR deadline expired`);
          break;
        }

        let response;
        try {
          assertOwned?.();
          response = await httpImpl(`${base}/api/admin/brain/ocr`, {
            method: "POST",
            headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json" },
            body,
          }, { timeoutMs: remainingMs, what: "the OCR request" });
        } catch (error) {
          if (error?.code === "source_ingest_lock_lost") throw error;
          if (!isOcrTimeout(error)) {
            throw systemUnavailableError(page, error);
          }
          lastTimeout = error;
          deadlineExpired = true;
          break;
        }

        let responseBody;
        try {
          responseBody = await response.json();
        } catch (error) {
          throw systemUnavailableError(
            page,
            error,
            `HTTP ${response?.status ?? "unknown"} returned a malformed OCR reply`,
          );
        }

        if (response.status === 425 && responseBody?.ocr_request_pending === true) {
          lastTimeout = new Error("the first OCR attempt is still running");
          const afterResponseMs = Math.max(0, deadlineMs - clockMs(now));
          if (afterResponseMs === 0) {
            deadlineExpired = true;
            break;
          }
          pendingPoll++;
          const requestedDelay = Math.max(
            Number(responseBody.retry_after_ms) || 0,
            retryDelayMs(Math.min(pendingPoll, totalAttempts), random),
          );
          await sleep(Math.min(requestedDelay, afterResponseMs));
          continue;
        }

        if (responseBody?.ocr_idempotency_unavailable === true) {
          const error = new Error(
            `OCR stopped at page ${page} because the Brain could not prove the billable request state. ` +
              `${responseBody?.detail || "The page is held for review."} ` +
              "The previous document revision was kept, and the source cursor was not advanced.",
          );
          error.name = "OcrIdempotencyUnavailableError";
          error.code = "OCR_IDEMPOTENCY_UNAVAILABLE";
          error.fatal = true;
          error.retryable = true;
          error.system_evidence = true;
          error.ocr_idempotency_unavailable = true;
          throw error;
        }

        if (response.status === 429 || responseBody?.llm_cap_exceeded) {
          const error = new Error(
            `OCR stopped because the daily spend cap was reached. ${responseBody?.detail || ""}`.trim() +
              " No document was marked unreadable; re-run once the cap resets or raise safety.daily_llm_spend_cap_usd.",
          );
          error.fatal = true;
          error.system_evidence = true;
          error.llm_cap_exceeded = true;
          throw error;
        }
        if (responseBody?.provider_mismatch) {
          const error = new Error(
            `OCR refused: ${responseBody?.detail || responseBody?.error || "the brain would not run it"}`,
          );
          error.fatal = true;
          error.retryable = true;
          error.system_evidence = true;
          throw error;
        }
        if (response.status >= 500) {
          throw systemUnavailableError(
            page,
            null,
            responseBody?.detail || responseBody?.error || `HTTP ${response.status}`,
          );
        }
        if (!response.ok) {
          // The current Worker has no non-2xx document-content refusal
          // contract. Only a validated transcription can be judged unreadable
          // by the local OCR policy. Auth, routing, throttling, malformed and
          // unknown statuses are system evidence and must never become a
          // removal-plan reason for the prior accepted document.
          throw systemUnavailableError(
            page,
            null,
            responseBody?.detail || responseBody?.error || `HTTP ${response.status}`,
          );
        }
        if (typeof responseBody?.text !== "string") {
          throw systemUnavailableError(page, null, "the OCR reply did not contain transcription text");
        }
        if (responseBody.ocr_reread_after_expiry === true && responseBody.idempotent_replay !== true) {
          stats.rereadAfterExpiry++;
        }
        onPage({ page, totalPages });
        return {
          text: responseBody.text,
          ocr_request_id: requestId,
          ...(responseBody.ocr_reread_after_expiry === true ? { ocr_reread_after_expiry: true } : {}),
        };
      }

      if (attempt < totalAttempts) {
        countRetry();
        const nextTimeoutSeconds = Math.round(
          (OCR_PAGE_TIMEOUT_MS + attempt * OCR_PAGE_RETRY_TIMEOUT_STEP_MS) / 1000,
        );
        onRetry(
          `OCR page ${page} was slow; retrying (${attempt + 1} of ${totalAttempts}) with a ${nextTimeoutSeconds}-second timeout.`,
          { page, attempt, nextAttempt: attempt + 1, totalAttempts, requestId },
        );
        await sleep(retryDelayMs(attempt, random));
      }
    }

    if (!await brainIsReachable({ base, httpImpl, assertOwned })) {
      throw unreachableError(page, totalAttempts, lastTimeout);
    }
    const message =
      "1 OCR page was slow after bounded retries; it was skipped and will be checked again on the next pass.";
    stats.skippedPages++;
    onSkip(message, { page, totalPages, attempts: totalAttempts, requestId });
    return {
      error: `page ${page}: OCR timed out after ${totalAttempts} attempts while the Brain remained reachable; check again next pass`,
      reason_code: "ocr_page_timeout",
      retry_document: true,
    };
  };
  call.model = model;
  call.maxPages = maxPages;
  call.stats = stats;
  return call;
}
