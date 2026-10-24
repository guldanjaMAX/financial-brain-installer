import { measureQueryStage, measureQueryModel } from "./query-timing.js";
// core.js — HTTP helpers, auth, and the LLM call with its spend cap.
//
// Extracted from a single-tenant worker and genericized. Every
// Instance-specific values are now read from env.

/* ---------------------------------------------------------------- http */

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/* ---------------------------------------------------------------- auth */

// Constant-time compare. Workers do not expose crypto.timingSafeEqual, so this
// is the standard XOR-over-bytes fallback. Length mismatch returns immediately
// because the length itself is not secret.
export function constantTimeEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Prevent browser, proxy, and edge caches from retaining private answers.
 *
 *  Lives here rather than in index.js because lib modules serve private data
 *  too, and a second copy is how two cache policies drift apart. */
export function privateNoStore(response) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("Pragma", "no-cache");
  // Session-authenticated routes vary on the cookie as well. The no-store
  // above already settles it; this keeps the header honest for any
  // intermediary that heeds Vary and ignores Cache-Control.
  headers.set("Vary", "X-Admin-Key, Cookie");
  return new Response(response.body, { status: response.status, headers });
}

export function validateAdminKey(request, env) {
  // Secrets belong in headers. Query-string credentials leak too easily into
  // browser history, proxy/access logs, analytics, screenshots and referrers.
  const key = request.headers.get("X-Admin-Key");
  if (!key || !env.ADMIN_KEY) return false;
  return constantTimeEquals(key, env.ADMIN_KEY);
}

/**
 * Accept the full admin key or the optional read-only proxy key.
 *
 * The proxy key is deliberately valid only on the two retrieval routes. A UI
 * proxy can answer questions without holding a credential that can ingest,
 * purge, reindex, drain, or inspect administrative state.
 */
export function validateReadKey(request, env) {
  const key = request.headers.get("X-Admin-Key");
  if (!key) return false;
  if (env.ADMIN_KEY && constantTimeEquals(key, env.ADMIN_KEY)) return true;
  return !!env.RAG_PROXY_KEY && constantTimeEquals(key, env.RAG_PROXY_KEY);
}

/* ----------------------------------------------------------------- llm */

const CAP_TABLE = `CREATE TABLE IF NOT EXISTS llm_call_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  day TEXT NOT NULL,
  label TEXT,
  model TEXT,
  status TEXT,
  est_cost_usd_micros INTEGER DEFAULT 0
)`;

let capCache = { day: null, micros: 0, checkedAt: 0 };

// What THIS isolate has charged today. Written by this process on every billed
// call, so no database can lose it. It is the floor under every budget
// decision, and it is the whole reason a broken ledger cannot mean zero spend.
let isolateLedger = { day: null, micros: 0 };

// Why the guard is degraded, when it is. Kept so the refusal can name its cause
// and so a health route can surface it, rather than leaving a silent hole where
// a cap used to be.
let guardState = { degraded: false, reason: null, since: null };

// The share of the day's budget a degraded guard is still allowed to spend.
// Small on purpose: enough to ride out a D1 blip, nowhere near enough for a
// runaway loop to matter.
const DEGRADED_BUDGET_FRACTION = 0.1;

// ...and never more than this in absolute terms, however large the configured
// cap is. A client running a $500/day cap has the appetite for it; a broken
// ledger is still not a licence to spend at that rate unsupervised.
const DEGRADED_BUDGET_CEILING_USD = 5;

const degradedBudgetUsd = (capUsd) =>
  Math.min(capUsd * DEGRADED_BUDGET_FRACTION, DEGRADED_BUDGET_CEILING_USD);

const utcDay = () => new Date().toISOString().slice(0, 10);

/**
 * The configured cap, in dollars.
 *
 * A garbled value falls back to the default rather than to NaN. `spent >= NaN`
 * is false, so a typo in DAILY_LLM_CAP_USD would otherwise remove the cap
 * entirely and look like a working config while doing so.
 */
function capUsdFor(env) {
  const raw = env.DAILY_LLM_CAP_USD;
  const n = raw === undefined || raw === null || raw === "" ? 10 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 10;
}

/** Record a billed call against this isolate, resetting on UTC day rollover. */
function chargeIsolate(micros) {
  const day = utcDay();
  if (isolateLedger.day !== day) isolateLedger = { day, micros: 0 };
  isolateLedger.micros += Math.max(0, Number(micros) || 0);
}

function markDegraded(reason) {
  if (!guardState.degraded || guardState.reason !== reason) {
    console.warn(`[spend-guard] DEGRADED: ${reason}. Falling back to a reduced per-instance allowance.`);
    guardState = { degraded: true, reason, since: new Date().toISOString() };
  }
}

function markHealthy() {
  if (guardState.degraded) {
    console.warn("[spend-guard] recovered: the spend ledger is readable again; the full cap is back in force.");
    guardState = { degraded: false, reason: null, since: null };
  }
}

/** Read-only view of the guard, for health reporting and tests. */
export function spendGuardStatus() {
  return {
    degraded: guardState.degraded,
    reason: guardState.reason,
    since: guardState.since,
    isolate_day: isolateLedger.day,
    isolate_spent_micros: isolateLedger.micros,
  };
}

/**
 * Per-UTC-day spend guard.
 *
 * Exists because a runaway loop is a billing incident, not a bug you notice
 * next month. The cost of the call in flight is folded in immediately, so a
 * tight loop is caught inside the cache window rather than after it expires.
 *
 * It does NOT fail open. It used to: the catch returned 0, which reported zero
 * spend and un-bound the cap for as long as D1 was unhappy. A cap that fails
 * open is not a cap. On a client-owned install the payment method behind it is
 * the client's, so the failure mode was somebody else's bill.
 *
 * It does not fail fully closed either. Refusing every answer because a logging
 * table hiccuped is its own kind of broken, and to the client it looks like the
 * brain is down. So the guard degrades: it falls back to what THIS isolate
 * knows it has spent and holds that against a small fraction of the day's
 * budget. Answers keep flowing through a blip; a loop hits the floor fast and
 * stops. Unbounded spend is unreachable in every branch, because the isolate
 * ledger only ever grows and is never replaced by a zero.
 *
 * The honest limit, stated rather than glossed: the degraded bound is per
 * isolate, not global. A runaway loop lives in one isolate and is bounded
 * exactly. Broad fan-out across many isolates while D1 is down is bounded only
 * by (isolates x reduced allowance), which is far tighter than "no cap" but is
 * not a single global number.
 */
async function readSpend(env) {
  const day = utcDay();
  const now = Date.now();
  if (isolateLedger.day !== day) isolateLedger = { day, micros: 0 };
  const floor = isolateLedger.micros;

  if (!env.DB) {
    // No binding means no ledger exists to read, which is the same hole as a
    // failing query: nothing outside this process could ever bind the cap.
    markDegraded("no D1 binding, so no spend ledger exists to read");
    return { micros: floor, degraded: true };
  }

  // While degraded, skip the cache window and retry every call, so the full cap
  // comes back the moment D1 does.
  if (!guardState.degraded && capCache.day === day && now - capCache.checkedAt < 60_000) {
    return { micros: Math.max(capCache.micros, floor), degraded: false };
  }

  try {
    const row = await env.DB.prepare(
      "SELECT COALESCE(SUM(est_cost_usd_micros),0) AS m FROM llm_call_log WHERE day = ? AND status != 'blocked'"
    )
      .bind(day)
      .first();
    capCache = { day, micros: Number(row?.m || 0), checkedAt: now };
    markHealthy();
    // The stored sum can under-report: logCall swallows its own failures. Take
    // whichever ledger is higher so a lost write cannot buy extra budget.
    return { micros: Math.max(capCache.micros, floor), degraded: false };
  } catch (err) {
    markDegraded(`spend ledger query failed: ${err?.message || err}`);
    return { micros: floor, degraded: true };
  }
}

async function ensureLogTable(env) {
  if (!env.DB) return;
  try {
    await env.DB.exec(CAP_TABLE.replace(/\s+/g, " "));
  } catch {
    /* table probably exists */
  }
}

async function logCall(env, { label, model, status, micros }) {
  if (!env.DB) return;
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      "INSERT INTO llm_call_log (ts, day, label, model, status, est_cost_usd_micros) VALUES (?,?,?,?,?,?)"
    )
      .bind(now, now.slice(0, 10), label || null, model || null, status, micros || 0)
      .run();
  } catch {
    /* logging must never break the call */
  }
}

/**
 * Per-model Workers AI rates, in dollars per million tokens.
 *
 * A single hard-coded pair used to price every Workers AI call at the answer
 * model's rate. Gemma remains an owner override at $0.10/$0.30, while the
 * reviewed Llama default uses $0.293/$2.25. A custom model falls back to the
 * dearer known rate so the cap cannot fail quiet.
 *
 * Prefix-matched, longest first, so a family rate covers its variants. Read
 * from the published Workers AI model pages on 2026-08-28.
 */
const WORKERS_AI_RATES = [
  ["@cf/google/gemma-4", { in: 0.1, out: 0.3 }],
  ["@cf/meta/llama-4-scout-17b-16e-instruct", { in: 0.293, out: 2.25 }],
  ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", { in: 0.293, out: 2.25 }],
];

// The default is the most expensive rate we know, not the cheapest. An unknown
// model priced optimistically would let the cap fail quiet.
const WORKERS_AI_FALLBACK_RATE = { in: 0.293, out: 2.25 };

export function workersAiRate(model) {
  const id = String(model || "");
  let best = null;
  for (const [prefix, rate] of WORKERS_AI_RATES) {
    if (id.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { prefix, rate };
  }
  return best ? best.rate : WORKERS_AI_FALLBACK_RATE;
}

/**
 * Per-model Anthropic rates, in dollars per million tokens.
 *
 * These list prices are from Anthropic's first-party pricing page, checked
 * 2026-10-22. Opus 5.5 is $4/$20, Sonnet 5.5 is $2/$10, and Haiku 5.5 is
 * $0.10/$0.50 per million input/output tokens for prompts up to 100k tokens
 * ($0.50/$2.50 above that; Brain prompts are far below it). Prefix matching
 * covers dated model IDs. Unknown Claude IDs retain the conservative $3/$15
 * estimate so a new model cannot weaken the cap. Thinking tokens are already
 * included in `usage.output_tokens` and must not be added a second time.
 */
const ANTHROPIC_RATES = [
  ["claude-haiku-5-5", { in: 0.1, out: 0.5 }],
  ["claude-haiku-4-5", { in: 1, out: 5 }],
  ["claude-sonnet-5-5", { in: 2, out: 10 }],
  ["claude-opus-5-5", { in: 4, out: 20 }],
];
const ANTHROPIC_FALLBACK_RATE = { in: 3, out: 15 };

export function anthropicRate(model) {
  const id = String(model || "");
  let best = null;
  for (const [prefix, rate] of ANTHROPIC_RATES) {
    if (id.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { prefix, rate };
  }
  return best ? best.rate : ANTHROPIC_FALLBACK_RATE;
}

/** Join every model text block in provider order. Non-text blocks carry model
 *  work, not answer copy, and must never displace a later answer block. */
export function llmText(data) {
  return Array.isArray(data?.content)
    ? data.content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("")
    : "";
}

export class AnthropicEmptyResponseError extends Error {
  constructor(stopReason) {
    const budgetExhausted = stopReason === "max_tokens";
    super(budgetExhausted
      ? "The Anthropic answer model used its whole output budget before writing an answer."
      : "Anthropic returned no answer text.");
    this.name = "AnthropicEmptyResponseError";
    this.code = "ANTHROPIC_EMPTY_TEXT";
    this.anthropic_empty_response = true;
    this.output_budget_exhausted = budgetExhausted;
    this.stop_reason = stopReason || null;
  }
}

export class AnthropicIncompleteResponseError extends Error {
  constructor(stopReason) {
    super(`Anthropic returned an incomplete ${stopReason || "unknown"} response.`);
    this.name = "AnthropicIncompleteResponseError";
    this.anthropic_incomplete_response = true;
    this.stop_reason = stopReason || null;
  }
}

export const ANSWER_AND_CHECK_LABELS = Object.freeze([
  "rag-think",
  "rag-think-repair",
  "rag-synthesis-gate",
  "rag-evidence-gate",
  "answer-model-check",
]);
const ANSWER_AND_CHECK_LABEL_SET = new Set(ANSWER_AND_CHECK_LABELS);

function anthropicEffort(model) {
  const id = String(model || "");
  if (id === "claude-opus-5-5" || id.startsWith("claude-opus-5-5-")) return "medium";
  if (id === "claude-sonnet-5-5" || id.startsWith("claude-sonnet-5-5-")) return "high";
  return null;
}

function isAbortLike(error) {
  return error?.name === "AbortError" || error?.name === "TimeoutError" || error?.code === "ABORT_ERR";
}

function anthropicInputCharacterCount(system, messages) {
  const messageChars = Array.isArray(messages)
    ? messages.reduce((sum, message) => {
        if (typeof message?.content === "string") return sum + message.content.length;
        if (message?.content === undefined || message?.content === null) return sum;
        const serialized = JSON.stringify(message.content);
        return sum + (typeof serialized === "string" ? serialized.length : String(message.content).length);
      }, 0)
    : 0;
  return String(system || "").length + messageChars;
}

/**
 * How an image is attached to a Workers AI chat request.
 *
 * STATED PLAINLY: this shape is NOT verified against a live account in this
 * build. Cloudflare's model page for the OCR model lists Vision as a
 * capability and publishes its prices, but its usage examples are text-only
 * and it does not document the image field. Two shapes exist in the wild — the
 * OpenAI-compatible content array with `image_url`, which is what an
 * instruction-tuned chat model reached through `messages` accepts, and the
 * older top-level `image` field used by llama-3.2-vision.
 *
 * Rather than guess once and fail silently, the shape is a named switch. The
 * default is the content array; `OCR_IMAGE_FORMAT=image_field` selects the
 * other. The OCR route reports which shape it sent and returns the provider's
 * own error verbatim, so a wrong guess costs one call and one variable rather
 * than a debugging session.
 */
export function visionMessages(system, messages, image, env = {}) {
  const dataUrl = `data:image/png;base64,${image}`;
  const text = (messages || []).map((m) => m?.content).filter((c) => typeof c === "string").join("\n\n");

  if (env.OCR_IMAGE_FORMAT === "image_field") {
    return [
      { role: "system", content: system },
      { role: "user", content: text, image: dataUrl },
    ];
  }
  return [
    { role: "system", content: system },
    {
      role: "user",
      content: [
        ...(text ? [{ type: "text", text }] : []),
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    },
  ];
}

export function callLLM(env, options) {
  return measureQueryStage(options.timing, options.timingStage, () => callLLMImpl(env, options));
}

async function callLLMImpl(env, {
  model,
  system,
  messages,
  max_tokens,
  anthropic_max_tokens,
  label,
  timeoutMs,
  image,
  timing = null,
  timingStage,
}) {
  const apiKey = env.ANTHROPIC_API_KEY;
  const modelIsCloudflare = !model || String(model).startsWith("@cf/");
  const missingAnswerKey = !apiKey && !modelIsCloudflare &&
    ANSWER_AND_CHECK_LABEL_SET.has(label);

  // An image is a page of the client's own scanned document. It has exactly one
  // legal destination: the Workers AI binding inside their own Cloudflare
  // account. There is no Anthropic branch for it and there is no default-model
  // fallback, because either would move a picture of their bank statement to a
  // provider their manifest does not name. This is a custody claim, so it
  // refuses rather than degrades.
  if (image !== undefined) {
    if (!String(model || "").startsWith("@cf/")) {
      const e = new Error(
        `OCR must run on a Cloudflare model inside this account; ${model || "(no model)"} is not one. ` +
        "Refusing to send a page of a scanned document anywhere else.",
      );
      e.provider_mismatch = true;
      throw e;
    }
    if (!env.AI) {
      const e = new Error(
        "OCR needs this worker's own Workers AI binding, and there is none. " +
        "Refusing to send a page of a scanned document to another provider.",
      );
      e.provider_mismatch = true;
      throw e;
    }
  }

  await ensureLogTable(env);

  if (missingAnswerKey) {
    await logCall(env, { label, model, status: "blocked", micros: 0 });
    const error = new Error("the configured Anthropic answer or check model has no Anthropic key");
    error.no_anthropic_key = true;
    throw error;
  }
  if (!apiKey && !env.AI) {
    const error = new Error("no LLM key configured");
    error.no_key = true;
    throw error;
  }

  const capUsd = capUsdFor(env);
  const { micros: spent, degraded } = await readSpend(env);
  const budgetUsd = degraded ? degradedBudgetUsd(capUsd) : capUsd;
  if (spent >= budgetUsd * 1_000_000) {
    await logCall(env, { label, model, status: "blocked", micros: 0 });
    const e = new Error(
      degraded
        ? `LLM spend guard is degraded (${guardState.reason}); the reduced ` +
          `allowance of $${budgetUsd} for this instance is already spent. ` +
          `Refusing rather than spending without a working cap.`
        : `daily LLM spend cap of $${capUsd} reached`,
    );
    e.llm_cap_exceeded = true;
    if (degraded) {
      e.spend_guard_degraded = true;
      console.warn(`[spend-guard] BLOCKED a call while degraded: ${guardState.reason}`);
    }
    throw e;
  }

  // Route by the CONFIGURED MODEL, never by which key happens to be present.
  // A manifest that selects a Cloudflare model must reach Cloudflare, even on an
  // install that also carries an Anthropic key for reranking. Branching on the
  // key alone silently promoted Anthropic from "reranking only" to "every
  // answer", so a client's document text reached a provider their own manifest
  // did not name. That is a custody claim, not a preference.
  if (!apiKey || (modelIsCloudflare && env.AI)) {
    const workersModel = String(model || "").startsWith("@cf/")
      ? model
      : env.WORKERS_AI_ANSWER_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    try {
      const data = await measureQueryModel(timing, timingStage, "cloudflare-workers-ai", workersModel, () => env.AI.run(workersModel, {
        messages: image === undefined
          ? [{ role: "system", content: system }, ...(messages || [])]
          : visionMessages(system, messages, image, env),
        max_tokens: max_tokens || 1000,
        temperature: 0,
      }));
      const rawResponse = data?.response;
      let text = typeof rawResponse === "string" ? rawResponse.trim() : "";
      // Not every Workers AI model replies in the same shape, and reading only
      // `response` silently discarded a correct answer from some of them.
      // Measured live against the REST API on 2026-09-23, page by page, against
      // the same scanned image: the answer model
      // (llama-3.3-70b-instruct-fp8-fast) replies with a `response` string, so
      // the branch above already covered it. Two vision models
      // (llama-4-scout-17b-16e-instruct, mistral-small-3.1-24b-instruct) send
      // BOTH `response` and the OpenAI chat-completions `choices`, so they also
      // already worked. Gemma, which remains an owner override, answered ONLY
      // in `choices[0].message.content`, with no `response` field at all. This
      // fallback keeps reading that captured shape once `response` offers no
      // text. The OCR default is selected separately from reply parsing.
      if (!text) {
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content === "string") {
          text = content.trim();
        } else if (Array.isArray(content)) {
          text = content
            .filter((part) => part?.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("")
            .trim();
        }
      }
      // A structured (object) `response` is serialized only when neither a
      // `response` string nor `choices` produced text. Serializing it first put
      // a truthy but useless string in front of a real chat-completions
      // answer: the defect this fallback fixes, one layer down (raised in
      // review, 2026-09-23). With no `choices` text the object is serialized
      // exactly as before.
      if (!text && rawResponse && typeof rawResponse === "object") {
        text = JSON.stringify(rawResponse);
      }
      if (!text) throw new Error("Workers AI returned no answer text");
      const inTok = data?.usage?.prompt_tokens || data?.usage?.input_tokens || 0;
      const outTok = data?.usage?.completion_tokens || data?.usage?.output_tokens || 0;
      // Priced by the model actually called, per WORKERS_AI_RATES. Keep the
      // estimate conservative enough for the guard to remain useful.
      const rate = workersAiRate(workersModel);
      const micros = Math.ceil(inTok * rate.in + outTok * rate.out);
      chargeIsolate(micros);
      await logCall(env, { label, model: workersModel, status: "ok", micros });
      return {
        content: [{ type: "text", text }],
        model: workersModel,
        usage: data?.usage || {},
        provider: "cloudflare-workers-ai",
        ...(!apiKey && !modelIsCloudflare
          ? { provider_fallback: "anthropic_key_missing" }
          : {}),
      };
    } catch (error) {
      await logCall(env, { label, model: workersModel, status: "error", micros: 0 });
      throw new Error(`Workers AI: ${error?.message || error}`);
    }
  }

  if (modelIsCloudflare) {
    // A Cloudflare model is configured but this worker has no AI binding to
    // serve it. Quietly answering from Anthropic instead would move client
    // document text to a provider the manifest does not name. Refuse and say so.
    const e = new Error(
      `the configured answer model ${model || "(default)"} is a Cloudflare model, ` +
        "but this worker has no AI binding. Refusing to answer from a different " +
        "provider than the manifest names.",
    );
    e.provider_mismatch = true;
    throw e;
  }
  const anthropicModel = model;
  const requestedAnthropicMaxTokens = Number(anthropic_max_tokens);
  const effectiveAnthropicMaxTokens = Number.isFinite(requestedAnthropicMaxTokens) &&
    requestedAnthropicMaxTokens > 0
    ? Math.trunc(requestedAnthropicMaxTokens)
    : max_tokens || 1000;
  const timeoutRate = anthropicRate(anthropicModel);
  const timeoutMicros = Math.ceil(
    Math.ceil(anthropicInputCharacterCount(system, messages) / 3) * timeoutRate.in +
    effectiveAnthropicMaxTokens * timeoutRate.out,
  );
  const chargeTimeout = async (error) => {
    if (!isAbortLike(error)) return;
    chargeIsolate(timeoutMicros);
    await logCall(env, { label, model: anthropicModel, status: "timeout", micros: timeoutMicros });
  };
  const data = await measureQueryModel(timing, timingStage, "anthropic", anthropicModel, async () => {
    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: anthropicModel,
          max_tokens: effectiveAnthropicMaxTokens,
          system,
          messages,
          ...(anthropicEffort(anthropicModel)
            ? { output_config: { effort: anthropicEffort(anthropicModel) } }
            : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs || 45_000),
      });
    } catch (error) {
      await chargeTimeout(error);
      throw error;
    }

    if (!res.ok) {
      const text = await res.text();
      await logCall(env, { label, model, status: "error", micros: 0 });
      let message = "";
      try { message = String(JSON.parse(text)?.error?.message || ""); } catch { /* protected log only */ }
      const error = new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`);
      error.anthropic_status = res.status;
      error.provider_error_class = classifyAnthropicFailure(res.status, message);
      throw error;
    }

    try {
      return await res.json();
    } catch (error) {
      await chargeTimeout(error);
      throw error;
    }
  });
  const inTok = data?.usage?.input_tokens || 0;
  const outTok = data?.usage?.output_tokens || 0;
  const rate = anthropicRate(data?.model || anthropicModel);
  const micros = Math.ceil(inTok * rate.in + outTok * rate.out);
  chargeIsolate(micros);
  await logCall(env, { label, model: data?.model || anthropicModel, status: "ok", micros });
  const text = llmText(data);
  if (!text.trim()) throw new AnthropicEmptyResponseError(data?.stop_reason);
  if (data?.stop_reason === "max_tokens" || data?.stop_reason === "refusal") {
    throw new AnthropicIncompleteResponseError(data.stop_reason);
  }
  return {
    content: [{ type: "text", text }],
    model: data?.model || anthropicModel,
    usage: data?.usage || {},
    stop_reason: data?.stop_reason,
    provider: "anthropic",
  };
}

export function classifyAnthropicFailure(status, message = "") {
  const code = Number(status);
  if (code === 401 || code === 403) return "key_rejected";
  if (code === 402 || (code === 400 && /credit balance/i.test(String(message)))) return "billing";
  if (code === 400) return "error";
  if (code === 404) return "model_unavailable";
  if (code === 429 || code === 529 || code >= 500) return "busy";
  return "error";
}
