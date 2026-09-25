// ocr.js — read one page of a scanned document, inside the client's own account.
//
// WHY THIS IS A WORKER ROUTE AND NOT A CALL FROM THE INSTALLER
//
// The installer could reach Cloudflare's REST API directly with an account
// token and get the same model. It must not, for three reasons that all point
// the same way.
//
// The spend cap lives here. `callLLM` refuses once the day's budget is gone,
// logs every call, and degrades rather than failing open. A CLI-side REST call
// would walk straight past all of it, on the client's own payment method, one
// page at a time. OCR is the first bulk, automatic, per-document inference cost
// this product has ever had; it is exactly the thing the cap was built for.
//
// The credential is already right. The installer holds the brain admin key. A
// direct REST path would mean a standing Cloudflare control-plane token present
// during routine ingest, which this product deliberately moved away from:
// ingest is a data-plane operation.
//
// And the binding is already there. Every install declares `[ai] binding =
// "AI"`, so the model runs in the client's account with no new resource, no new
// account, and nothing to revoke at handoff.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//
// It does not use `env.AI.toMarkdown()`. That helper accepts PDFs and looks
// like the obvious answer, and it is the trap. Cloudflare's own description of
// its PDF path is metadata plus structure plus "extract the text of the page
// as-is" — no rasterisation and no vision model, which is precisely nothing on
// a page that has no text. Its IMAGE path is worse for this purpose: it runs a
// captioning prompt and returns a DESCRIPTION of the picture. A statement page
// through that comes back as prose about a document rather than the document,
// and indexing that as content is the fabrication this whole product exists to
// refuse.

import { jsonResponse, validateAdminKey, callLLM } from "./core.js";
import {
  OCR_REQUEST_ID,
  OCR_REPLAY_KEY,
  acknowledgeOcrPageRequests,
  canonicalOcrInput,
  claimOcrPageRequest,
  completeOcrPageRequest,
  releaseOcrPageRequest,
  replayOcrPageResponse,
  ocrPageRequestId,
  sha256Hex,
  startOcrPageRequest,
} from "./ocr-idempotency.js";

export { ocrPageRequestId };

export const OCR_PATH = "/api/admin/brain/ocr";

/** Default model. Overridable per install by the OCR_MODEL var. */
export const DEFAULT_OCR_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

/**
 * One page image, base64. Larger than the ingest body limit on purpose: this
 * route carries a picture, and the ingest ceiling was sized for text. A 1600px
 * greyscale page PNG is comfortably inside this; a page that is not is a sign
 * the caller did not downscale.
 */
export const MAX_IMAGE_BASE64_BYTES = 4_000_000;

/** Ceiling on transcription length. A page of dense print is far under this. */
const MAX_OUTPUT_TOKENS = 2000;

export function ocrModelFor(env) {
  const configured = String(env.OCR_MODEL || "").trim();
  return configured || DEFAULT_OCR_MODEL;
}

/**
 * Is OCR switched on for this install?
 *
 * Off unless the manifest says otherwise, because turning it on changes ingest
 * from a free local operation into a metered one that bills the owner. An
 * upgrade must never quietly start spending.
 */
export function ocrEnabled(env) {
  const raw = env.OCR_ENABLED;
  return raw === true || raw === "1" || raw === "true";
}

/**
 * POST /api/admin/brain/ocr
 *
 * Body: { image_base64, page?, prompt, request_id? } or the internal source
 * acknowledgement shape { acknowledge_request_ids }.
 * Returns transcription or acknowledgement readback, or a refusal with the cause.
 *
 * One page per request, deliberately. A 40-page statement is 40 calls, which
 * keeps every page inside the cap check, inside the log, and inside a request
 * size that cannot be argued about.
 */
export async function handleOcr(env, request, { now = () => new Date() } = {}) {
  if (!validateAdminKey(request, env)) return jsonResponse({ error: "unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  if (Array.isArray(body?.acknowledge_request_ids)) {
    try {
      const receipt = await acknowledgeOcrPageRequests(env.DB, {
        requestIds: body.acknowledge_request_ids,
        now: now(),
      });
      return jsonResponse({ ocr_acknowledged: receipt.acknowledged });
    } catch {
      return jsonResponse({
        error: "OCR source acknowledgement could not be confirmed",
        detail: "The encrypted handoff was retained. Retry the same acknowledgement after D1 is available.",
        ocr_acknowledgement_unavailable: true,
      }, 503);
    }
  }

  if (!ocrEnabled(env)) {
    return jsonResponse({
      error: "OCR is not enabled on this brain",
      detail: "For a new install, answer yes when setup asks about scanned PDF OCR. For an existing brain, set safety.ocr.enabled in the manifest and re-run `brain update`. It is off by default because it spends money on your own Cloudflare account, once per scanned page.",
      ocr_enabled: false,
    }, 409);
  }

  const image = typeof body?.image_base64 === "string" ? body.image_base64 : "";
  if (!image) return jsonResponse({ error: "image_base64 is required" }, 400);
  if (image.length > MAX_IMAGE_BASE64_BYTES) {
    return jsonResponse({
      error: `the page image is ${image.length} base64 bytes, over the ${MAX_IMAGE_BASE64_BYTES} limit`,
      detail: "Downscale the page before sending it. The installer renders at 1600px on the longest side, which is well inside this.",
    }, 413);
  }
  const prompt = typeof body?.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : null;
  if (!prompt) return jsonResponse({ error: "prompt is required" }, 400);

  const model = ocrModelFor(env);
  const imageFormat = env.OCR_IMAGE_FORMAT === "image_field" ? "image_field" : "content_array";
  const inputSha256 = await sha256Hex(canonicalOcrInput({ image, model, prompt }));
  const suppliedRequestId = body?.request_id;
  if (suppliedRequestId !== undefined && !OCR_REQUEST_ID.test(String(suppliedRequestId))) {
    return jsonResponse({ error: "request_id must be one lowercase 64-character SHA-256 value" }, 400);
  }
  const requestId = suppliedRequestId || inputSha256;
  const replayKey = body?.replay_key == null ? null : String(body.replay_key);
  if (replayKey !== null && !OCR_REPLAY_KEY.test(replayKey)) {
    return jsonResponse({ error: "replay_key must be one base64url-encoded 256-bit value" }, 400);
  }
  const ownerToken = crypto.randomUUID();
  let claim;
  try {
    claim = await claimOcrPageRequest(env.DB, {
      requestId, inputSha256, ownerToken, replayKey, now: now(),
    });
  } catch {
    return jsonResponse({
      error: "OCR could not establish its idempotency receipt",
      detail: "No model call was started, so this page was not charged. Retry after D1 is available.",
      ocr_idempotency_unavailable: true,
    }, 503);
  }
  if (claim.state === "conflict") {
    return jsonResponse({
      error: "the OCR request id belongs to different page bytes",
      detail: "Refusing to reuse one billable request identity for different input.",
      ocr_idempotency_conflict: true,
    }, 409);
  }
  if (claim.state === "pending" || claim.state === "retry_later") {
    const waitingForRereadWindow = claim.state === "retry_later";
    return jsonResponse({
      error: waitingForRereadWindow
        ? "the prior OCR re-read window is still active"
        : "the first OCR attempt is still running",
      detail: waitingForRereadWindow
        ? "Retry this same request id after the bounded wait; no model call was started."
        : "Retry this same request id after the bounded wait; no second model call was started.",
      ocr_request_pending: true,
      retry_after_ms: Number.isSafeInteger(claim.retryAfterMs) && claim.retryAfterMs > 0
        ? claim.retryAfterMs
        : 2_000,
    }, 425);
  }
  if (claim.state === "replayable") {
    try {
      const replay = await replayOcrPageResponse({
        receipt: claim.receipt,
        handoff: claim.handoff,
        replayKey,
      });
      return jsonResponse({ ...replay, idempotent_replay: true }, claim.status);
    } catch {
      return jsonResponse({
        error: "the earlier OCR result could not be recovered from its encrypted handoff",
        detail: "This page is held for review. The permanent receipt prevents a second charge.",
        ocr_idempotency_unavailable: true,
        ocr_request_completed: true,
      }, 503);
    }
  }
  if (claim.state === "completed") {
    return jsonResponse({
      error: "the earlier OCR attempt completed but its plaintext was not retained",
      detail: "This page is held for review because the content-free receipt prevents a second charge but cannot replay document text.",
      ocr_idempotency_unavailable: true,
      ocr_request_completed: true,
    }, 503);
  }

  try {
    // Pending is a short pre-call reservation and may be reclaimed after its
    // lease expires. This exact transition closes that safe-reclaim window
    // before any billable provider work begins.
    await startOcrPageRequest(env.DB, {
      requestId, inputSha256, ownerToken, now: now(),
    });
  } catch {
    return jsonResponse({
      error: "OCR could not confirm its model-start receipt",
      detail: "No model call was started. Retry after D1 is available.",
      ocr_idempotency_unavailable: true,
    }, 503);
  }

  try {
    const data = await callLLM(env, {
      model,
      system: prompt,
      messages: [{ role: "user", content: "Transcribe this page." }],
      image,
      max_tokens: MAX_OUTPUT_TOKENS,
      // Its own label so OCR spend is separable from answering in llm_call_log.
      label: "ocr",
    });
    const text = data?.content?.[0]?.text ?? "";
    const responseBody = {
      text,
      model: data?.model || model,
      image_format: imageFormat,
      page: Number.isFinite(body?.page) ? body.page : null,
      usage: data?.usage || {},
      request_id: requestId,
      ...(claim.rereadAfterExpiry ? { ocr_reread_after_expiry: true } : {}),
    };
    try {
      await completeOcrPageRequest(env.DB, {
        requestId, inputSha256, ownerToken, status: 200, body: responseBody, replayKey, now: now(),
      });
    } catch {
      return jsonResponse({
        error: "OCR finished but its idempotency receipt could not be confirmed",
        detail: "The transcription was not returned because an automatic retry must not charge for this page twice.",
        ocr_idempotency_unavailable: true,
      }, 503);
    }
    return jsonResponse(responseBody);
  } catch (error) {
    // A cap hit, a provider mismatch and an outage are all statements about the
    // SYSTEM, never about the page. Returning any of them as "this page is
    // unreadable" would write a permanently wrong reason into the corpus, so
    // each keeps its own status and its own flag and the caller must not treat
    // them as evidence about the document.
    if (error?.llm_cap_exceeded) {
      try {
        await releaseOcrPageRequest(env.DB, { requestId, inputSha256, ownerToken });
      } catch {
        return jsonResponse({
          error: "OCR spend was refused but its idempotency receipt could not be released",
          detail: "No model call was started. Retry after D1 is available.",
          ocr_idempotency_unavailable: true,
        }, 503);
      }
      return jsonResponse({
        error: "OCR stopped because the daily spend cap was reached",
        detail: String(error.message || error).slice(0, 300),
        llm_cap_exceeded: true,
        spend_guard_degraded: error.spend_guard_degraded === true || undefined,
      }, 429);
    }
    if (error?.provider_mismatch) {
      try {
        await releaseOcrPageRequest(env.DB, { requestId, inputSha256, ownerToken });
      } catch {
        return jsonResponse({
          error: "OCR custody was refused but its idempotency receipt could not be released",
          detail: "No model call was started. Retry after D1 is available.",
          ocr_idempotency_unavailable: true,
        }, 503);
      }
      return jsonResponse({
        error: "OCR refused rather than sending a scanned page to another provider",
        detail: String(error.message || error).slice(0, 300),
        provider_mismatch: true,
      }, 409);
    }
    const responseBody = {
      error: "the OCR model call failed",
      // Verbatim, because if the image shape is wrong this sentence is the
      // whole diagnosis and paraphrasing it would cost an afternoon.
      detail: String(error?.message || error).slice(0, 400),
      model,
      image_format: imageFormat,
      request_id: requestId,
    };
    try {
      // A provider error can arrive after billable work. Seal a content-free
      // completion receipt rather than guessing that a new attempt is free.
      await completeOcrPageRequest(env.DB, {
        requestId, inputSha256, ownerToken, status: 502, body: responseBody, replayKey, now: now(),
      });
    } catch {
      return jsonResponse({
        error: "OCR failed and its idempotency receipt could not be confirmed",
        detail: "The request remains reserved so an automatic retry cannot charge for this page twice.",
        ocr_idempotency_unavailable: true,
      }, 503);
    }
    return jsonResponse(responseBody, 502);
  }
}
