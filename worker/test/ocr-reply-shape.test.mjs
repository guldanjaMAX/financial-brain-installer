/**
 * Workers AI vision models do not return one common reply shape. These shapes
 * were measured live on 2026-09-23 with one scanned page sent to each model:
 *
 *   model                                  response        choices
 *   google/gemma-4-26b-a4b-it               absent          transcription
 *   meta/llama-4-scout-17b-16e-instruct    transcription   transcription
 *   mistralai/mistral-small-3.1-24b-instr. transcription   transcription
 *   meta/llama-3.3-70b-instruct-fp8-fast   answer          (absent)
 *
 * A full ingest on 2026-09-24 then attempted 25 single-page scans with Gemma
 * but stored no readable transcription. Llama-4-scout had separately completed
 * the end-to-end stored-text path in live testing, so it is now the reviewed
 * default. Gemma remains a
 * supported owner override, and its captured choices-only shape remains pinned
 * so changing the default does not narrow reply parsing.
 *
 * This file pins the reply shapes actually measured that day, so the same
 * defect cannot come back quietly on a future default-model change:
 *
 *   - choices only            (google/gemma-4-26b-a4b-it override)
 *   - response AND choices    (meta/llama-4-scout default, mistralai/mistral-small)
 *   - response only           (meta/llama-3.3-70b, the answer model)
 *   - neither                 (must still refuse, not fabricate)
 *   - choices as a content-part array, not a plain string
 *
 * and then proves the fix through the actual OCR route, not just callLLM in
 * isolation, because the route is what a client's install calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { callLLM } from "../src/lib/core.js";
import { handleOcr } from "../src/lib/ocr.js";
import { canonicalOcrInput, sha256Hex } from "../src/lib/ocr-idempotency.js";

// D1 logging is fire-and-forget in this path; a stub keeps the test offline.
const db = () => ({
  prepare: () => ({
    bind: () => ({ run: async () => {}, first: async () => ({ m: 0 }) }),
    run: async () => {},
    first: async () => ({ m: 0 }),
  }),
});

const HERE = dirname(fileURLToPath(import.meta.url));
const routeDb = () => {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of [
    "0002_llm_call_log.sql",
    "0047_ocr_page_idempotency.sql",
    "0048_ocr_page_acknowledgement.sql",
    "0049_ocr_page_retry_budget.sql",
  ]) {
    sqlite.exec(readFileSync(join(HERE, "..", "..", "migrations", "d1", file), "utf8"));
  }
  return {
    sqlite,
    exec: async (sql) => { sqlite.exec(sql); },
    prepare: (sql) => {
      const shape = (params = []) => ({
        bind: (...next) => shape(next),
        first: async () => sqlite.prepare(sql).get(...params) ?? null,
        all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
        run: async () => {
          const result = sqlite.prepare(sql).run(...params);
          return { results: [], meta: { changes: Number(result.changes || 0) } };
        },
      });
      return shape();
    },
  };
};

async function replaceStoredCompletion(receiptDb, {
  requestId,
  replayKey,
  status,
  body,
  reread,
  completedAt,
}) {
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(replayKey, "base64url"),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const responseJson = JSON.stringify(body);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(responseJson),
  );
  const receipt = {
    schema_version: 1,
    response_sha256: await sha256Hex(responseJson),
    usage: {},
    ocr_reread_after_expiry: reread ? 1 : 0,
  };
  receiptDb.sqlite.prepare(
    `UPDATE ocr_page_requests
        SET response_status=?1,response_json=?2,replay_key_sha256=?3,
            replay_expires_at=?4,replay_iv=?5,replay_ciphertext=?6
      WHERE request_id=?7`,
  ).run(
    status,
    JSON.stringify(receipt),
    await sha256Hex(replayKey),
    new Date(completedAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    Buffer.from(iv).toString("base64url"),
    Buffer.from(ciphertext).toString("base64url"),
    requestId,
  );
}

const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const LLAMA = "@cf/meta/llama-4-scout-17b-16e-instruct";
const call = (aiRun, model = GEMMA) =>
  callLLM({ DB: db(), AI: { run: aiRun } }, { model, system: "s", messages: [{ role: "user", content: "go" }], label: "test" });

test("choices-only reply (measured shape of the Gemma owner override) is read", async () => {
  const result = await call(async () => ({
    choices: [{ message: { content: "QUILLFEATHER MARINA - SLIP RENTAL AGREEMENT" } }],
    usage: { prompt_tokens: 301, completion_tokens: 112 },
  }));
  assert.equal(result.content[0].text, "QUILLFEATHER MARINA - SLIP RENTAL AGREEMENT");
  assert.equal(result.usage.completion_tokens, 112, "usage still comes through unchanged");
});

test("when both response and choices are present (llama-4-scout, mistral-small shape), response wins", async () => {
  const result = await call(async () => ({
    response: "the response field",
    choices: [{ message: { content: "the choices field" } }],
    usage: {},
  }), LLAMA);
  assert.equal(result.content[0].text, "the response field",
    "the existing response branch is untouched; choices is a fallback, not a replacement");
});

test("a structured (object) response does not stand in front of a real choices transcription", async () => {
  const result = await call(async () => ({
    response: { status: "ok", tokens: 42 },
    choices: [{ message: { content: "INVOICE 4471 - AMOUNT DUE 812.00" } }],
    usage: {},
  }));
  assert.equal(result.content[0].text, "INVOICE 4471 - AMOUNT DUE 812.00",
    "a stringified envelope must not beat a real answer: the same defect as the choices fallback, one layer down");
});

test("a structured (object) response with no choices text is still serialized exactly as before", async () => {
  const envelope = { answer: "structured", items: [1, 2] };
  const result = await call(async () => ({ response: envelope, usage: {} }));
  assert.equal(result.content[0].text, JSON.stringify(envelope));
});

test("response-only reply (the answer model's own shape) still works exactly as before", async () => {
  const result = await call(async () => ({ response: "TOTAL 1,204.55", usage: {} }));
  assert.equal(result.content[0].text, "TOTAL 1,204.55");
});

test("an empty reply from both fields is still refused, never fabricated", async () => {
  await assert.rejects(
    () => call(async () => ({ response: "", choices: [], usage: {} })),
    /Workers AI returned no answer text/,
  );
  await assert.rejects(
    () => call(async () => ({ usage: {} })),
    /Workers AI returned no answer text/,
    "a reply with neither field at all must refuse the same way",
  );
});

test("a choices content-part array (rather than a plain string) is joined", async () => {
  const result = await call(async () => ({
    choices: [{
      message: {
        content: [
          { type: "text", text: "Tenant: Jordan Ashworth. " },
          { type: "text", text: "Monthly fee: $1,265.00." },
        ],
      },
    }],
    usage: {},
  }));
  assert.equal(result.content[0].text, "Tenant: Jordan Ashworth. Monthly fee: $1,265.00.");
});

test("a non-text content part (e.g. an echoed image_url) is not treated as transcription text", async () => {
  const result = await call(async () => ({
    choices: [{
      message: {
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          { type: "text", text: "Only this part is real text." },
        ],
      },
    }],
    usage: {},
  }));
  assert.equal(result.content[0].text, "Only this part is real text.");
});

/* ---------------------------------------------------- through the OCR route */
/* callLLM alone proves the parsing. The route is what an install actually
   calls, and it has its own body plumbing (admin key, enabled flag, image
   size) that a callLLM-only test cannot exercise. Fixture pattern reused from
   test/ocr.test.mjs's "the worker route" section: a 40-char admin key, a POST
   with X-Admin-Key, and a D1 stub that answers every prepare/bind/run/first. */

const ADMIN_KEY = "k".repeat(40);
const ocrRequest = (body) =>
  new Request("https://brain.example/api/admin/brain/ocr", {
    method: "POST",
    headers: { "X-Admin-Key": ADMIN_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("the OCR route default uses llama-4-scout's measured response-plus-choices reply", async () => {
  let calledModel = null;
  const env = {
    ADMIN_KEY,
    OCR_ENABLED: "1",
    DB: routeDb(),
    AI: {
      run: async (model) => {
        calledModel = model;
        return {
          response: "Renewal date: March 31, 2028.",
          choices: [{ message: { content: "choices copy of the same transcription" } }],
          usage: { prompt_tokens: 301, completion_tokens: 12 },
        };
      },
    },
  };
  const res = await handleOcr(env, ocrRequest({ image_base64: "AA", page: 1, prompt: "transcribe" }));
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.text, "Renewal date: March 31, 2028.");
  assert.equal(body.model, LLAMA);
  assert.equal(calledModel, LLAMA, "the default model decision point must call llama-4-scout");
});

test("a Gemma owner override still reads its measured choices-only reply", async () => {
  const env = {
    ADMIN_KEY,
    OCR_ENABLED: "1",
    OCR_MODEL: GEMMA,
    DB: routeDb(),
    AI: {
      run: async () => ({
        choices: [{ message: { content: "Renewal date: March 31, 2028." } }],
        usage: { prompt_tokens: 301, completion_tokens: 12 },
      }),
    },
  };
  const res = await handleOcr(env, ocrRequest({ image_base64: "AA", page: 1, prompt: "transcribe" }));
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.text, "Renewal date: March 31, 2028.");
  assert.equal(body.model, GEMMA, "the configured owner override is reported after the choices fallback");
});

test("the OCR route still 502s with its own explanation when a reply truly has no answer text", async () => {
  const env = {
    ADMIN_KEY,
    OCR_ENABLED: "1",
    DB: routeDb(),
    AI: { run: async () => ({ usage: {} }) },
  };
  const res = await handleOcr(env, ocrRequest({ image_base64: "AA", prompt: "transcribe" }));
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.match(body.detail, /Workers AI returned no answer text/);
});

test("an in-flight duplicate request is held without starting a second billable model call", async () => {
  let modelCalls = 0;
  let releaseModel;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const held = new Promise((resolve) => { releaseModel = resolve; });
  const env = {
    ADMIN_KEY,
    OCR_ENABLED: "1",
    DB: routeDb(),
    AI: {
      run: async () => {
        modelCalls++;
        signalStarted();
        await held;
        return { response: "Recovered text", usage: {} };
      },
    },
  };
  const body = {
    image_base64: "AA",
    page: 1,
    prompt: "transcribe",
    request_id: "b".repeat(64),
  };
  const firstPending = handleOcr(env, ocrRequest(body));
  await started;
  const duplicate = await handleOcr(env, ocrRequest(body));
  const duplicateBody = await duplicate.json();
  assert.equal(duplicate.status, 425);
  assert.equal(duplicateBody.ocr_request_pending, true);
  assert.equal(modelCalls, 1, "the pending decision point was reached after exactly one model call started");
  releaseModel();
  const first = await firstPending;
  assert.equal(first.status, 200);
  assert.equal(modelCalls, 1);
});

test("a content-free completion without a handoff permits one re-read but never stores plaintext", async () => {
  const receiptDb = routeDb();
  const syntheticCredential = `sk-proj-${"A7".repeat(16)}`;
  let modelCalls = 0;
  const env = {
    ADMIN_KEY,
    OCR_ENABLED: "1",
    DB: receiptDb,
    AI: {
      run: async () => {
        modelCalls++;
        return {
          response: `Synthetic credential ${syntheticCredential} must be refused by the document gate.`,
          usage: { prompt_tokens: 301, completion_tokens: 18 },
        };
      },
    },
  };
  const requestBody = {
    image_base64: "credential-shaped-page",
    page: 1,
    prompt: "transcribe",
  };
  const first = await handleOcr(env, ocrRequest(requestBody));
  assert.equal(first.status, 200, await first.clone().text());

  const row = receiptDb.sqlite.prepare(
    "SELECT status,response_status,response_json FROM ocr_page_requests",
  ).get();
  assert.equal(row.status, "completed", "the completion decision must have reached durable D1 state");
  assert.equal(row.response_status, 200);
  assert.doesNotMatch(row.response_json, /Synthetic credential|sk-proj-|must be refused/u);
  const receipt = JSON.parse(row.response_json);
  assert.match(receipt.response_sha256, /^[0-9a-f]{64}$/u);

  const duplicate = await handleOcr(env, ocrRequest(requestBody));
  const duplicateBody = await duplicate.json();
  const afterReread = await handleOcr(env, ocrRequest(requestBody));
  const afterRereadBody = await afterReread.json();
  assert.equal(duplicate.status, 200, JSON.stringify(duplicateBody));
  assert.equal(duplicateBody.ocr_reread_after_expiry, true);
  assert.equal(afterReread.status, 425);
  assert.equal(afterRereadBody.ocr_request_pending, true);
  assert.ok(afterRereadBody.retry_after_ms > 0,
    "the fresh replacement receipt must name the bounded next re-read window");
  assert.equal(modelCalls, 2, "a handoff-less completion permits only one replacement model call");
});

test("an acknowledged completed result is pruned after T+8 and gets one recorded re-read", async () => {
  const receiptDb = routeDb();
  const completedAt = new Date("2026-09-24T12:00:00.000Z");
  const afterOldRetentionWindow = new Date("2026-10-02T12:00:00.000Z");
  let modelCalls = 0;
  const env = {
    ADMIN_KEY,
    OCR_ENABLED: "1",
    DB: receiptDb,
    AI: {
      run: async () => {
        modelCalls++;
        return { response: "Durable sample transcription", usage: {} };
      },
    },
  };
  const requestBody = {
    image_base64: "durable-completed-page",
    page: 1,
    prompt: "transcribe",
    replay_key: "A".repeat(43),
  };

  const first = await handleOcr(env, ocrRequest(requestBody), { now: () => completedAt });
  assert.equal(first.status, 200, await first.clone().text());
  const firstBody = await first.json();
  const acknowledgement = await handleOcr({ ...env, OCR_ENABLED: "0" }, ocrRequest({
    acknowledge_request_ids: [firstBody.request_id],
  }), { now: () => completedAt });
  const acknowledgementBody = await acknowledgement.json();
  const duplicate = await handleOcr(env, ocrRequest(requestBody), { now: () => afterOldRetentionWindow });
  const duplicateBody = await duplicate.json();
  const row = receiptDb.sqlite.prepare(
    "SELECT status,response_json,replay_ciphertext FROM ocr_page_requests",
  ).get();

  assert.equal(acknowledgement.status, 200, JSON.stringify(acknowledgementBody));
  assert.equal(acknowledgementBody.ocr_acknowledged, 1,
    "the source-storage acknowledgement must update the receipt even after paid OCR is disabled");
  assert.equal(duplicate.status, 200, JSON.stringify(duplicateBody));
  assert.equal(duplicateBody.ocr_reread_after_expiry, true,
    "acknowledgement must not remove the expired receipt's recovery exit");
  assert.equal(modelCalls, 2, "the acknowledged T+8 decision point permits exactly one replacement call");
  assert.equal(row.status, "completed", "the identity-bearing tombstone must still exist after T+8 days");
  assert.equal(typeof row.replay_ciphertext, "string", "the replacement must leave a fresh encrypted handoff");
  assert.equal(JSON.parse(row.response_json).acknowledged_at, undefined,
    "the fresh replacement receipt must await a fresh source acknowledgement");
  assert.equal(JSON.parse(row.response_json).ocr_reread_after_expiry, 1,
    "the fresh receipt must record the replacement call");
  assert.match(JSON.parse(row.response_json).response_sha256, /^[0-9a-f]{64}$/u);
});

test("an unacknowledged completed result keeps its ciphertext and replays after T+8", async () => {
  const receiptDb = routeDb();
  const completedAt = new Date("2026-09-24T12:00:00.000Z");
  const afterOldRetentionWindow = new Date("2026-10-02T12:00:00.000Z");
  let modelCalls = 0;
  const env = {
    ADMIN_KEY,
    OCR_ENABLED: "1",
    DB: receiptDb,
    AI: {
      run: async () => {
        modelCalls++;
        return { response: "Durable sample transcription", usage: {} };
      },
    },
  };
  const requestBody = {
    image_base64: "unacknowledged-completed-page",
    page: 1,
    prompt: "transcribe",
    replay_key: "B".repeat(43),
  };

  const first = await handleOcr(env, ocrRequest(requestBody), { now: () => completedAt });
  assert.equal(first.status, 200, await first.clone().text());
  const duplicate = await handleOcr(env, ocrRequest(requestBody), { now: () => afterOldRetentionWindow });
  const duplicateBody = await duplicate.json();
  const row = receiptDb.sqlite.prepare(
    "SELECT status,response_json,replay_ciphertext FROM ocr_page_requests",
  ).get();

  assert.equal(duplicate.status, 200, JSON.stringify(duplicateBody));
  assert.equal(duplicateBody.idempotent_replay, true);
  assert.equal(modelCalls, 1, "the unacknowledged T+8 decision point must replay without another call");
  assert.equal(row.status, "completed");
  assert.equal(typeof row.replay_ciphertext, "string",
    "an unacknowledged handoff must survive its former cleanup deadline");
});

test("a provider failure never replays and permits one replacement after its ambiguity window", async () => {
  const receiptDb = routeDb();
  const failedAt = new Date("2026-09-24T12:00:00.000Z");
  const beforeRetryWindow = new Date("2026-09-24T12:00:30.000Z");
  const afterRetryWindow = new Date("2026-09-24T12:02:00.000Z");
  let modelCalls = 0;
  let providerRecovered = false;
  const env = {
    ADMIN_KEY,
    OCR_ENABLED: "1",
    DB: receiptDb,
    AI: {
      run: async () => {
        modelCalls++;
        if (!providerRecovered) throw new Error("synthetic provider 502");
        return { response: "Recovered transcription", usage: {} };
      },
    },
  };
  const requestBody = {
    image_base64: "provider-failure-recovery-page",
    page: 1,
    prompt: "transcribe",
    replay_key: "F".repeat(43),
  };

  const failed = await handleOcr(env, ocrRequest(requestBody), { now: () => failedAt });
  const failedBody = await failed.json();
  const failureReceipt = receiptDb.sqlite.prepare(
    "SELECT status,model_started_at,response_status,replay_ciphertext FROM ocr_page_requests",
  ).get();
  assert.equal(failed.status, 502, JSON.stringify(failedBody));
  assert.equal(modelCalls, 1, "the failure probe must reach exactly one model call");
  assert.equal(failureReceipt.status, "in_flight",
    "a non-success keeps model-start evidence but is not a replayable completion");
  assert.equal(typeof failureReceipt.model_started_at, "string");
  assert.equal(failureReceipt.response_status, null);
  assert.equal(failureReceipt.replay_ciphertext, null);

  providerRecovered = true;
  const held = await handleOcr(env, ocrRequest(requestBody), { now: () => beforeRetryWindow });
  const heldBody = await held.json();
  assert.equal(held.status, 425, JSON.stringify(heldBody));
  assert.equal(heldBody.ocr_request_pending, true,
    "the 60-second provider-failure backoff must reach the typed no-call decision");
  assert.ok(heldBody.retry_after_ms > 0);
  assert.equal(modelCalls, 1, "the active provider-failure backoff cannot start another call");

  const recovered = await handleOcr(env, ocrRequest(requestBody), { now: () => afterRetryWindow });
  const recoveredBody = await recovered.json();
  assert.equal(recovered.status, 200, JSON.stringify(recoveredBody));
  assert.equal(recoveredBody.ocr_reread_after_expiry, true);
  assert.equal(modelCalls, 2, "the 60-second expiry permits exactly one replacement model call");

  const replay = await handleOcr(env, ocrRequest(requestBody), { now: () => afterRetryWindow });
  const replayBody = await replay.json();
  assert.equal(replay.status, 200, JSON.stringify(replayBody));
  assert.equal(replayBody.idempotent_replay, true,
    "a lost successful replacement response must replay without another call");
  assert.equal(modelCalls, 2, "the successful replacement cannot charge a third time");
});

test("three failed model calls hold the page until its next 24-hour window", async () => {
  const receiptDb = routeDb();
  const base = new Date("2026-09-24T12:00:00.000Z");
  let modelCalls = 0;
  let providerRecovered = false;
  const env = {
    ADMIN_KEY,
    OCR_ENABLED: "1",
    DB: receiptDb,
    AI: {
      run: async () => {
        modelCalls++;
        if (!providerRecovered) throw new Error("synthetic terminal provider failure");
        return { response: "Recovered next-day transcription", usage: {} };
      },
    },
  };
  const requestBody = {
    image_base64: "provider-daily-cap-page",
    page: 1,
    prompt: "transcribe",
    replay_key: "G".repeat(43),
  };

  for (const minutes of [0, 2, 4]) {
    const response = await handleOcr(env, ocrRequest(requestBody), {
      now: () => new Date(base.getTime() + minutes * 60_000),
    });
    assert.equal(response.status, 502, await response.clone().text());
  }
  const capped = await handleOcr(env, ocrRequest(requestBody), {
    now: () => new Date(base.getTime() + 6 * 60_000),
  });
  const cappedBody = await capped.json();
  const cappedReceipt = receiptDb.sqlite.prepare(
    "SELECT status,model_call_count,model_call_window_started_at FROM ocr_page_requests",
  ).get();
  assert.equal(capped.status, 425, JSON.stringify(cappedBody));
  assert.equal(cappedBody.ocr_model_call_cap_exhausted, true,
    "the cap-exhaustion decision point must be explicit to the load report");
  assert.equal(cappedBody.model_calls_in_24_hours, 3);
  assert.ok(cappedBody.retry_after_ms > 0);
  assert.equal(modelCalls, 3, "the fourth same-day request cannot start another model call");
  assert.equal(cappedReceipt.model_call_count, 3, "the three-call cap must be durable");

  providerRecovered = true;
  const nextDay = await handleOcr(env, ocrRequest(requestBody), {
    now: () => new Date(base.getTime() + 25 * 60 * 60 * 1000),
  });
  assert.equal(nextDay.status, 200, await nextDay.clone().text());
  assert.equal(modelCalls, 4, "the next 24-hour window must permit recovery instead of a permanent hold");
  assert.equal(receiptDb.sqlite.prepare(
    "SELECT model_call_count FROM ocr_page_requests",
  ).get().model_call_count, 1, "the next-day call starts a fresh durable window");
});

test("a ciphertext-less completed tombstone permits exactly one recorded re-read", async () => {
  const receiptDb = routeDb();
  const completedAt = new Date("2026-09-24T12:00:00.000Z");
  const afterOldRetentionWindow = new Date("2026-10-02T12:00:00.000Z");
  let modelCalls = 0;
  const env = {
    ADMIN_KEY,
    OCR_ENABLED: "1",
    DB: receiptDb,
    AI: {
      run: async () => {
        modelCalls++;
        return { response: `Durable sample transcription ${modelCalls}`, usage: {} };
      },
    },
  };
  const requestBody = {
    image_base64: "legacy-completed-page",
    page: 1,
    prompt: "transcribe",
    replay_key: "C".repeat(43),
  };

  const first = await handleOcr(env, ocrRequest(requestBody), { now: () => completedAt });
  assert.equal(first.status, 200, await first.clone().text());
  receiptDb.sqlite.prepare(
    `UPDATE ocr_page_requests
        SET replay_key_sha256=NULL,replay_expires_at=NULL,replay_iv=NULL,replay_ciphertext=NULL`,
  ).run();

  const reread = await handleOcr(env, ocrRequest(requestBody), { now: () => afterOldRetentionWindow });
  const rereadBody = await reread.json();
  const replay = await handleOcr(env, ocrRequest(requestBody), { now: () => afterOldRetentionWindow });
  const replayBody = await replay.json();
  const row = receiptDb.sqlite.prepare(
    "SELECT status,response_json,replay_ciphertext FROM ocr_page_requests",
  ).get();
  const receipt = JSON.parse(row.response_json);

  assert.equal(reread.status, 200, JSON.stringify(rereadBody));
  assert.equal(rereadBody.ocr_reread_after_expiry, true,
    "the legacy tombstone decision point must identify the one replacement call");
  assert.equal(replay.status, 200, JSON.stringify(replayBody));
  assert.equal(replayBody.idempotent_replay, true, "the replacement completion must clear the hold");
  assert.equal(modelCalls, 2, "the tombstone may authorize one replacement call, never a third");
  assert.equal(receipt.ocr_reread_after_expiry, 1,
    "the content-free receipt must retain the re-read counter");
  assert.equal(typeof row.replay_ciphertext, "string",
    "the replacement result must leave a fresh handoff until source acknowledgement");
});

test("expired pre-call reservations and in-flight ambiguity each rearm one bounded call", async () => {
  const now = new Date("2026-09-24T12:16:00.000Z");
  const expiredAt = "2026-09-24T11:59:00.000Z";

  const reclaimDb = routeDb();
  const reclaimBody = { image_base64: "safe-reclaim", page: 1, prompt: "transcribe" };
  const reclaimInput = await sha256Hex(canonicalOcrInput({
    image: reclaimBody.image_base64,
    model: LLAMA,
    prompt: reclaimBody.prompt,
  }));
  reclaimDb.sqlite.prepare(
    `INSERT INTO ocr_page_requests
       (request_id,input_sha256,status,owner_token,started_at,expires_at)
     VALUES (?1,?2,'pending',?3,?4,?5)`,
  ).run(reclaimInput, reclaimInput, "old-owner-token".padEnd(32, "x"), "2026-09-24T11:50:00.000Z", expiredAt);
  let reclaimedCalls = 0;
  const reclaimed = await handleOcr({
    ADMIN_KEY,
    OCR_ENABLED: "1",
    DB: reclaimDb,
    AI: { run: async () => { reclaimedCalls++; return { response: "Recovered safely", usage: {} }; } },
  }, ocrRequest({ ...reclaimBody, request_id: reclaimInput }), { now: () => now });
  assert.equal(reclaimed.status, 200, await reclaimed.clone().text());
  assert.equal(reclaimedCalls, 1, "the expired reservation reached exactly one new model call");

  const heldDb = routeDb();
  const heldBody = { image_base64: "ambiguous-in-flight", page: 1, prompt: "transcribe" };
  const heldInput = await sha256Hex(canonicalOcrInput({
    image: heldBody.image_base64,
    model: LLAMA,
    prompt: heldBody.prompt,
  }));
  heldDb.sqlite.prepare(
    `INSERT INTO ocr_page_requests
       (request_id,input_sha256,status,owner_token,started_at,model_started_at,expires_at,
        model_call_count,model_call_window_started_at)
     VALUES (?1,?2,'in_flight',?3,?4,?4,?5,1,?4)`,
  ).run(heldInput, heldInput, "ambiguous-owner-token".padEnd(32, "x"),
    "2026-09-24T12:00:00.000Z", "2026-09-24T12:15:00.000Z");
  let ambiguityRereadCalls = 0;
  const stillHeld = await handleOcr({
    ADMIN_KEY,
    OCR_ENABLED: "1",
    DB: heldDb,
    AI: { run: async () => { ambiguityRereadCalls++; return { response: "Too early", usage: {} }; } },
  }, ocrRequest({ ...heldBody, request_id: heldInput }), {
    now: () => new Date("2026-09-24T12:02:00.000Z"),
  });
  assert.equal(stillHeld.status, 425);
  assert.equal(ambiguityRereadCalls, 0,
    "the T+2 minute ambiguity decision point cannot start a replacement call");
  const rereadResponse = await handleOcr({
    ADMIN_KEY,
    OCR_ENABLED: "1",
    DB: heldDb,
    AI: { run: async () => { ambiguityRereadCalls++; return { response: "Recovered after expiry", usage: {} }; } },
  }, ocrRequest({ ...heldBody, request_id: heldInput }), { now: () => now });
  const rereadResponseBody = await rereadResponse.json();
  assert.equal(rereadResponse.status, 200, JSON.stringify(rereadResponseBody));
  assert.equal(rereadResponseBody.ocr_reread_after_expiry, true,
    "the expired in-flight decision point must record its bounded replacement");
  assert.equal(ambiguityRereadCalls, 1, "T+16 minutes authorizes exactly one call in the new window");
});

test("every durable OCR receipt state has a bounded exit across time and process outcomes", async () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const base = new Date("2026-09-24T12:00:00.000Z");
  const clocks = [
    ["fresh", new Date(base.getTime() + 60_000)],
    ["T+2 minutes", new Date(base.getTime() + 2 * 60_000)],
    ["T+16 minutes", new Date(base.getTime() + 16 * 60_000)],
    ["T+25 hours", new Date(base.getTime() + 25 * 60 * 60 * 1000)],
    ["T+8 days", new Date(base.getTime() + 8 * dayMs)],
    ["T+31 days", new Date(base.getTime() + 31 * dayMs)],
  ];
  const outcomes = ["normal", "response lost after commit", "crash before local save"];
  const storedOutcomes = [
    { name: "success", status: 200, body: (requestId) => ({ text: "Stored transcription", request_id: requestId }) },
    { name: "provider 4xx", status: 400, body: (requestId) => ({ error: "provider 4xx", request_id: requestId }) },
    { name: "provider 5xx/502", status: 502, body: (requestId) => ({ error: "provider 502", request_id: requestId }) },
    { name: "timeout", status: 504, body: (requestId) => ({ error: "provider timeout", request_id: requestId }) },
    { name: "empty", status: 200, body: (requestId) => ({ text: "", request_id: requestId }) },
    { name: "malformed", status: 200, malformedReceipt: true },
  ];
  const handoffs = [
    { name: "matching", replayKey: "D".repeat(43) },
    { name: "missing", replayKey: "D".repeat(43) },
    { name: "mismatched", replayKey: "E".repeat(43) },
    { name: "undecryptable", replayKey: "D".repeat(43) },
  ];
  const states = [
    { name: "reserved pre-call", status: "pending", reread: false },
    { name: "reserved re-read pre-call", status: "pending", reread: true },
    { name: "in-flight", status: "in_flight", reread: false },
    { name: "in-flight re-read", status: "in_flight", reread: true },
    { name: "daily model-call cap exhausted", status: "in_flight", reread: true, providerFailed: true, modelCallCount: 3 },
    { name: "completed unacknowledged", status: "completed", acknowledged: false, reread: false },
    { name: "completed acknowledged", status: "completed", acknowledged: true, reread: false },
    { name: "completed re-read unacknowledged", status: "completed", acknowledged: false, reread: true },
    { name: "completed re-read acknowledged", status: "completed", acknowledged: true, reread: true },
  ];
  const decisions = { replay: 0, new_call: 0, retry_later: 0 };
  const completedHandoffDecisions = Object.fromEntries(handoffs.map(({ name }) => [name, 0]));
  const completedOutcomeDecisions = Object.fromEntries(storedOutcomes.map(({ name }) => [name, 0]));
  let combinations = 0;

  for (const [stateIndex, state] of states.entries()) {
    const stateHandoffs = state.status === "completed"
      ? handoffs
      : [{ name: "not-applicable", replayKey: "D".repeat(43) }];
    for (const handoff of stateHandoffs) {
      const stateStoredOutcomes = state.status === "completed"
        ? storedOutcomes
        : [{ name: "not-applicable", status: 200 }];
      for (const storedOutcome of stateStoredOutcomes) {
        for (const [clockIndex, [clockName, clock]] of clocks.entries()) {
          for (const [outcomeIndex, outcome] of outcomes.entries()) {
            const receiptDb = routeDb();
            let modelCalls = 0;
            const env = {
              ADMIN_KEY,
              OCR_ENABLED: "1",
              DB: receiptDb,
              AI: {
                run: async () => {
                  modelCalls++;
                  return { response: `Synthetic OCR response ${modelCalls}`, usage: {} };
                },
              },
            };
            const requestBody = {
              image_base64: `state-${stateIndex}-${handoff.name}-${storedOutcome.name}-${clockIndex}-${outcomeIndex}`,
              page: 1,
              prompt: "transcribe",
              replay_key: "D".repeat(43),
            };
            const attemptBody = { ...requestBody, replay_key: handoff.replayKey };
            const context = `${state.name}; ${handoff.name} handoff; ${storedOutcome.name} stored outcome; ${clockName}; ${outcome}`;

            const seeded = await handleOcr(env, ocrRequest(requestBody), { now: () => base });
            assert.equal(seeded.status, 200, `${context}: seed completion failed`);
            if (state.reread) {
              receiptDb.sqlite.prepare(
                `UPDATE ocr_page_requests
                    SET replay_key_sha256=NULL,replay_expires_at=NULL,replay_iv=NULL,replay_ciphertext=NULL`,
              ).run();
              const rereadSeed = await handleOcr(env, ocrRequest(requestBody), { now: () => base });
              assert.equal(rereadSeed.status, 200, `${context}: re-read seed failed`);
              assert.equal((await rereadSeed.json()).ocr_reread_after_expiry, true,
                `${context}: re-read seed did not reach its decision point`);
            }
            const seededBody = await seeded.json();
            if (state.acknowledged) {
              const acknowledgement = await handleOcr({ ...env, OCR_ENABLED: "0" }, ocrRequest({
                acknowledge_request_ids: [seededBody.request_id],
              }), { now: () => base });
              assert.equal(acknowledgement.status, 200, `${context}: acknowledgement seed failed`);
            }
            if (state.status === "completed" && storedOutcome.name !== "success") {
              if (storedOutcome.malformedReceipt) {
                receiptDb.sqlite.prepare(
                  "UPDATE ocr_page_requests SET response_status=200,response_json='malformed'",
                ).run();
              } else {
                await replaceStoredCompletion(receiptDb, {
                  requestId: seededBody.request_id,
                  replayKey: "D".repeat(43),
                  status: storedOutcome.status,
                  body: storedOutcome.body(seededBody.request_id),
                  reread: state.reread,
                  completedAt: base,
                });
              }
            }
            if (handoff.name === "missing") {
              receiptDb.sqlite.prepare(
                `UPDATE ocr_page_requests
                    SET replay_key_sha256=NULL,replay_expires_at=NULL,replay_iv=NULL,replay_ciphertext=NULL`,
              ).run();
            } else if (handoff.name === "undecryptable") {
              receiptDb.sqlite.prepare(
                `UPDATE ocr_page_requests SET replay_ciphertext='A'`,
              ).run();
            }
            if (state.status === "pending") {
              receiptDb.sqlite.prepare(
                `UPDATE ocr_page_requests
                    SET status='pending',started_at=?1,expires_at=?2,model_started_at=NULL,completed_at=NULL,
                        response_status=NULL,response_json=NULL,replay_expires_at=NULL,replay_iv=NULL,
                        replay_ciphertext=NULL,acknowledged_at=NULL`,
              ).run(base.toISOString(), new Date(base.getTime() + 5 * 60_000).toISOString());
            } else if (state.status === "in_flight") {
              const inFlightExpiry = state.providerFailed
                ? base.getTime() + 60_000
                : base.getTime() + 15 * 60_000;
              receiptDb.sqlite.prepare(
                `UPDATE ocr_page_requests
                    SET status='in_flight',started_at=?1,model_started_at=?1,expires_at=?2,completed_at=NULL,
                        response_status=NULL,response_json=NULL,replay_expires_at=NULL,replay_iv=NULL,
                        replay_ciphertext=NULL,acknowledged_at=NULL,provider_failed_at=?3,
                        model_call_count=?4,model_call_window_started_at=?1`,
              ).run(base.toISOString(), new Date(inFlightExpiry).toISOString(),
                state.providerFailed ? base.toISOString() : null, state.modelCallCount || 1);
            }
            modelCalls = 0;

            const settle = async (attemptAt, label) => {
              const callsBefore = modelCalls;
              let response = await handleOcr(env, ocrRequest(attemptBody), { now: () => attemptAt });
              let responseBody = await response.json();
              if (response.status === 425) {
                decisions.retry_later++;
                assert.equal(responseBody.ocr_request_pending, true, `${context}; ${label}: retry was not typed`);
                assert.ok(Number.isSafeInteger(responseBody.retry_after_ms) && responseBody.retry_after_ms > 0,
                  `${context}; ${label}: retry was not bounded: ${JSON.stringify(responseBody)}`);
                const stateExpiry = state.status === "pending"
                  ? base.getTime() + 5 * 60_000
                  : state.status === "in_flight"
                    ? state.providerFailed ? base.getTime() + dayMs : base.getTime() + 15 * 60_000
                    : 0;
                const retryAt = new Date(Math.max(
                  attemptAt.getTime() + responseBody.retry_after_ms + 1,
                  stateExpiry + 1,
                ));
                response = await handleOcr(env, ocrRequest(attemptBody), { now: () => retryAt });
                responseBody = await response.json();
                attemptAt = retryAt;
              }
              const newCalls = modelCalls - callsBefore;
              assert.equal(response.status, 200,
                `${context}; ${label}: permanent hold: ${JSON.stringify(responseBody)}`);
              assert.ok(newCalls === 0 || newCalls === 1,
                `${context}; ${label}: ${newCalls} model calls crossed one decision`);
              if (newCalls === 0) {
                decisions.replay++;
                assert.equal(responseBody.idempotent_replay, true,
                  `${context}; ${label}: a no-charge exit was not a replay`);
              } else {
                decisions.new_call++;
              }
              return { attemptAt, responseBody, newCalls };
            };

            let settled = await settle(clock, "initial exit");
            if (state.status === "completed") {
              completedHandoffDecisions[handoff.name]++;
              completedOutcomeDecisions[storedOutcome.name]++;
              if (storedOutcome.name !== "success") {
                assert.equal(settled.newCalls, 1,
                  `${context}: a stored non-success was replayed instead of replaced`);
              }
            }
            if (outcome === "response lost after commit") {
              const callsBeforeReplay = modelCalls;
              const replay = await handleOcr(env, ocrRequest(attemptBody), { now: () => settled.attemptAt });
              const replayBody = await replay.json();
              assert.equal(replay.status, 200, `${context}: lost response did not recover`);
              assert.equal(replayBody.idempotent_replay, true, `${context}: lost response did not replay`);
              assert.equal(modelCalls, callsBeforeReplay, `${context}: lost response caused another charge`);
              decisions.replay++;
            } else if (outcome === "crash before local save") {
              const acknowledgement = await handleOcr({ ...env, OCR_ENABLED: "0" }, ocrRequest({
                acknowledge_request_ids: [settled.responseBody.request_id],
              }), { now: () => settled.attemptAt });
              assert.equal(acknowledgement.status, 200, `${context}: committed acknowledgement was not durable`);
              settled = await settle(new Date(settled.attemptAt.getTime() + 8 * dayMs), "resume after local crash");
              assert.equal(typeof settled.responseBody.text, "string", `${context}: resumed text was unavailable`);
            }
            combinations++;
          }
        }
      }
    }
  }

  const stateHandoffAndOutcomeCombinations = states.reduce(
    (total, state) => total + (state.status === "completed"
      ? handoffs.length * storedOutcomes.length
      : 1), 0,
  );
  assert.equal(combinations, stateHandoffAndOutcomeCombinations * clocks.length * outcomes.length);
  assert.equal(combinations, 1818, "the complete state × handoff × stored-outcome × clock × crash matrix ran");
  for (const { name } of handoffs) {
    assert.equal(completedHandoffDecisions[name], 432,
      `${name} handoff decision was not reached: ${JSON.stringify(completedHandoffDecisions)}`);
  }
  for (const { name } of storedOutcomes) {
    assert.equal(completedOutcomeDecisions[name], 288,
      `${name} stored outcome decision was not reached: ${JSON.stringify(completedOutcomeDecisions)}`);
  }
  assert.ok(decisions.replay > 0, `replay decision was not reached: ${JSON.stringify(decisions)}`);
  assert.ok(decisions.new_call > 0, `new-call decision was not reached: ${JSON.stringify(decisions)}`);
  assert.ok(decisions.retry_later > 0, `retry-later decision was not reached: ${JSON.stringify(decisions)}`);
});
