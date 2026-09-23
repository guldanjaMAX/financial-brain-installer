/**
 * OCR never worked as shipped. `callLLM`'s Workers AI branch read only
 * `data.response`, and the product's own default OCR model,
 * `@cf/google/gemma-4-26b-a4b-it`, does not use that field. It answers in the
 * OpenAI chat-completions shape, `choices[0].message.content`, so a perfect
 * transcription was thrown away as "Workers AI returned no answer text" and
 * every scanned page came back a 502. Proven live on 2026-09-23 against a real
 * scanned page: see FINDING-OCR-BROKEN-IN-048-AND-THE-SWITCH-2026-09-23.md.
 *
 * This file pins the reply shapes actually measured that day, so the same
 * defect cannot come back quietly on a future default-model change:
 *
 *   - choices only            (google/gemma-4-26b-a4b-it, the default)
 *   - response AND choices    (meta/llama-4-scout, mistralai/mistral-small)
 *   - response only           (meta/llama-3.3-70b, the answer model)
 *   - neither                 (must still refuse, not fabricate)
 *   - choices as a content-part array, not a plain string
 *
 * and then proves the fix through the actual OCR route, not just callLLM in
 * isolation, because the route is what a client's install calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { callLLM } from "../src/lib/core.js";
import { handleOcr } from "../src/lib/ocr.js";

// D1 logging is fire-and-forget in this path; a stub keeps the test offline.
const db = () => ({
  prepare: () => ({
    bind: () => ({ run: async () => {}, first: async () => ({ m: 0 }) }),
    run: async () => {},
    first: async () => ({ m: 0 }),
  }),
});

const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const call = (aiRun) =>
  callLLM({ DB: db(), AI: { run: aiRun } }, { model: GEMMA, system: "s", messages: [{ role: "user", content: "go" }], label: "test" });

test("choices-only reply (measured shape of the default OCR model, gemma-4) is read", async () => {
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
  }));
  assert.equal(result.content[0].text, "the response field",
    "the existing response branch is untouched; choices is a fallback, not a replacement");
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

test("the OCR route returns 200 with the transcription for a choices-only reply", async () => {
  const env = {
    ADMIN_KEY,
    OCR_ENABLED: "1",
    DB: db(),
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
  assert.equal(body.model, GEMMA, "the default OCR model is reported even though it needed the fallback");
});

test("the OCR route still 502s with its own explanation when a reply truly has no answer text", async () => {
  const env = {
    ADMIN_KEY,
    OCR_ENABLED: "1",
    DB: db(),
    AI: { run: async () => ({ usage: {} }) },
  };
  const res = await handleOcr(env, ocrRequest({ image_base64: "AA", prompt: "transcribe" }));
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.match(body.detail, /Workers AI returned no answer text/);
});
