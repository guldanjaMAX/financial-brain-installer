import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { callLLM, spendGuardStatus } from "../src/lib/core.js";

/* Issue #19. The provider must follow the CONFIGURED MODEL, never whichever key
   happens to exist. Before this, an install with an Anthropic key for reranking
   sent every answer to Anthropic while its manifest still said Cloudflare, so
   client document text reached a provider the manifest did not name. That is a
   custody claim, which is why it gets a test rather than a comment. */

const CF = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const call = (env, model, options = {}) => callLLM(env, {
  model, system: "s", messages: [], label: "test", ...options,
});

// D1 logging is fire-and-forget in this path; a stub keeps the test offline.
const db = () => ({ prepare: () => ({ bind: () => ({ run: async () => {}, first: async () => ({}) }), run: async () => {}, first: async () => ({}) }) });

let aiCalls, fetchCalls, anthropicReply, anthropicError;
const aiBinding = () => ({
  run: async (model, input) => {
    aiCalls.push({ model, input });
    return { response: "ok", usage: {} };
  },
});
const origFetch = globalThis.fetch;

function reset() {
  aiCalls = [];
  fetchCalls = [];
  anthropicReply = {
    content: [{ type: "text", text: "ok" }],
    model: "claude-sonnet-4-5",
    usage: {},
    stop_reason: "end_turn",
  };
  anthropicError = null;
}
globalThis.fetch = async (url, opts) => {
  fetchCalls.push({ url: String(url), body: JSON.parse(opts?.body || "{}") });
  if (anthropicError) throw anthropicError;
  return { ok: true, status: 200, json: async () => anthropicReply, text: async () => "" };
};

try {
  /* THE BUG: Cloudflare model + an Anthropic key present. Must stay on Cloudflare. */
  reset();
  await call({ DB: db(), AI: aiBinding(), ANTHROPIC_API_KEY: "k" }, CF);
  assert.equal(aiCalls.length, 1, "a @cf/ model must be served by Workers AI");
  assert.equal(aiCalls[0].model, CF, "the configured model is used, not a substitute");
  assert.equal(fetchCalls.length, 0,
    "a @cf/ model must NEVER reach Anthropic just because a key exists");

  /* An explicitly Anthropic model with a key still goes to Anthropic. */
  reset();
  await call({ DB: db(), AI: aiBinding(), ANTHROPIC_API_KEY: "k" }, "claude-sonnet-4-5");
  assert.equal(fetchCalls.length, 1, "a non-@cf model routes to Anthropic");
  assert.match(fetchCalls[0].url, /api\.anthropic\.com/);
  assert.equal(fetchCalls[0].body.model, "claude-sonnet-4-5", "the configured model is passed through");
  assert.equal(aiCalls.length, 0);

  /* Adaptive-thinking replies can put a non-text block first. The shared
     provider boundary must collapse all text blocks before any caller sees
     the response. */
  reset();
  anthropicReply = {
    content: [
      { type: "thinking", thinking: "" },
      { type: "text", text: "A " },
      { type: "text", text: "[1]" },
    ],
    model: "claude-haiku-5-5-20261001",
    usage: {
      input_tokens: 1000,
      output_tokens: 1000,
      output_tokens_details: { thinking_tokens: 475 },
    },
    stop_reason: "end_turn",
  };
  const thinkingFirst = await call(
    { DB: db(), ANTHROPIC_API_KEY: "fixture" },
    "claude-haiku-5-5-20261001",
  );
  assert.equal(thinkingFirst.content[0].text, "A [1]");
  assert.equal(thinkingFirst.content.length, 1, "callers receive one normalized text block");
  assert.equal(thinkingFirst.provider, "anthropic");

  /* A text-only reply keeps the same public fields and bytes. */
  reset();
  const textOnlyUsage = {
    input_tokens: 7,
    output_tokens: 3,
    output_tokens_details: { thinking_tokens: 0 },
  };
  anthropicReply = {
    content: [{ type: "text", text: "  B [1]  " }],
    model: "claude-sonnet-5-5-20261001",
    usage: textOnlyUsage,
    stop_reason: "end_turn",
  };
  const textOnly = await call(
    { DB: db(), ANTHROPIC_API_KEY: "fixture" },
    "claude-sonnet-5-5-20261001",
  );
  assert.deepEqual(textOnly, {
    content: [{ type: "text", text: "  B [1]  " }],
    model: "claude-sonnet-5-5-20261001",
    usage: textOnlyUsage,
    stop_reason: "end_turn",
    provider: "anthropic",
  });

  /* A provider-success envelope with no text is an explicit model error. The
     max-token case names the real failure instead of becoming a null refusal. */
  reset();
  anthropicReply = {
    content: [{ type: "thinking", thinking: "" }],
    model: "claude-opus-5-5-20261001",
    usage: { input_tokens: 5, output_tokens: 4000, output_tokens_details: { thinking_tokens: 4000 } },
    stop_reason: "max_tokens",
  };
  await assert.rejects(
    () => call(
      { DB: db(), ANTHROPIC_API_KEY: "fixture" },
      "claude-opus-5-5-20261001",
      { max_tokens: 1000, anthropic_max_tokens: 4000 },
    ),
    (error) => error?.name === "AnthropicEmptyResponseError" &&
      error?.output_budget_exhausted === true &&
      /used its whole output budget before writing an answer/.test(error.message),
  );
  assert.equal(fetchCalls.length, 1, "the empty-response decision follows a completed provider call");
  assert.equal(fetchCalls[0].body.max_tokens, 4000,
    "the named max_tokens error is exercised at the new Anthropic answer cap");

  /* A non-empty max-token or refusal completion is still incomplete. The
     provider boundary names it so answer and gate callers can fail closed
     without parsing provider prose. */
  for (const stopReason of ["max_tokens", "refusal"]) {
    reset();
    anthropicReply = {
      content: [{ type: "text", text: "partial text that must not escape" }],
      model: "claude-opus-5-5-20261001",
      usage: { input_tokens: 5, output_tokens: 4000 },
      stop_reason: stopReason,
    };
    await assert.rejects(
      () => call(
        { DB: db(), ANTHROPIC_API_KEY: "fixture" },
        "claude-opus-5-5-20261001",
        { anthropic_max_tokens: 4000 },
      ),
      (error) => error?.name === "AnthropicIncompleteResponseError" &&
        error?.anthropic_incomplete_response === true &&
        error?.stop_reason === stopReason,
      `${stopReason} text must be discarded as an incomplete provider reply`,
    );
    assert.equal(fetchCalls.length, 1, `${stopReason} reached the provider decision point`);
  }

  /* Provider-specific caps affect Anthropic only. */
  reset();
  await call(
    { DB: db(), ANTHROPIC_API_KEY: "fixture" },
    "claude-sonnet-5-5-20261001",
    { max_tokens: 300, anthropic_max_tokens: 2000 },
  );
  assert.equal(fetchCalls[0].body.max_tokens, 2000,
    "the evidence gate receives its complete Anthropic budget");
  reset();
  await call(
    { DB: db(), AI: aiBinding() },
    CF,
    { max_tokens: 300, anthropic_max_tokens: 2000 },
  );
  assert.equal(aiCalls[0].input.max_tokens, 300,
    "the Anthropic cap must never alter a Workers AI request");

  /* Once a timed request has been dispatched, an abort can still have billed
     input and output. Charge the conservative upper estimate and preserve a
     typed timeout row so the daily cap cannot forget the call. */
  const timeoutLogs = [];
  const timeoutDb = {
    exec: async () => {},
    prepare: (sql) => ({
      bind: (...args) => ({
        first: async () => ({ m: 0 }),
        run: async () => {
          if (/INSERT INTO llm_call_log/.test(sql)) timeoutLogs.push(args);
        },
      }),
    }),
  };
  reset();
  anthropicError = Object.assign(new Error("synthetic dispatched timeout"), { name: "TimeoutError" });
  const spentBeforeTimeout = spendGuardStatus().isolate_spent_micros;
  await assert.rejects(
    () => call(
      { DB: timeoutDb, ANTHROPIC_API_KEY: "fixture" },
      "claude-sonnet-5-5-20261001",
      {
        system: "abcdef",
        messages: [{ role: "user", content: "123456789" }],
        anthropic_max_tokens: 4000,
      },
    ),
    (error) => error?.name === "TimeoutError",
  );
  const expectedTimeoutMicros = 5 * 2 + 4000 * 10;
  const timeoutLog = timeoutLogs.at(-1);
  assert.equal(fetchCalls.length, 1, "the timeout estimate is charged only after dispatch was attempted");
  assert.equal(timeoutLog?.[4], "timeout", "the call log keeps a distinct timeout status");
  assert.equal(timeoutLog?.[5], expectedTimeoutMicros,
    "timeout cost uses input chars/3 plus the full effective output budget");
  assert.equal(spendGuardStatus().isolate_spent_micros - spentBeforeTimeout, expectedTimeoutMicros,
    "the same conservative timeout estimate binds the isolate spend cap");

  /* Published model-family prices are selected by prefix. A captured log cost
     below exercises the actual billing expression so restoring 3/15 fails. */
  const logged = [];
  const loggingDb = {
    exec: async () => {},
    prepare: (sql) => ({
      bind: (...args) => ({
        first: async () => ({ m: 0 }),
        run: async () => {
          if (/INSERT INTO llm_call_log/.test(sql)) logged.push(args);
        },
      }),
    }),
  };
  for (const [model, expectedMicros] of [
    ["claude-haiku-5-5-20261001", 600],
    ["claude-haiku-4-5-20251001", 6000],
    ["claude-sonnet-5-5-20261001", 12000],
    ["claude-opus-5-5-20261001", 24000],
    ["claude-future-model", 18000],
  ]) {
    reset();
    anthropicReply = {
      content: [{ type: "text", text: "priced" }],
      model,
      usage: { input_tokens: 1000, output_tokens: 1000, output_tokens_details: { thinking_tokens: 400 } },
      stop_reason: "end_turn",
    };
    await call({ DB: loggingDb, ANTHROPIC_API_KEY: "fixture" }, model);
    assert.equal(logged.at(-1)?.[5], expectedMicros,
      `${model} uses its own rate and prices thinking once through output_tokens`);
  }

  /* All consumers use the shared text reader. This source contract kills a
     caller-only regression even though the normalizer returns one block. */
  for (const relative of ["../src/index.js", "../src/lib/ocr.js"]) {
    const source = readFileSync(new URL(relative, import.meta.url), "utf8");
    assert.equal(/content(?:\?\.)?\[0\](?:\?\.|\.)text/u.test(source), false,
      `${relative} must not read only content block zero`);
  }

  /* No key at all: unchanged behaviour, Workers AI. */
  reset();
  await call({ DB: db(), AI: aiBinding() }, CF);
  assert.equal(aiCalls.length, 1, "no key still uses Workers AI");
  assert.equal(fetchCalls.length, 0);

  /* Cloudflare model configured but no AI binding: refuse, do not silently swap provider. */
  reset();
  await assert.rejects(
    () => call({ DB: db(), ANTHROPIC_API_KEY: "k" }, CF),
    (e) => e.provider_mismatch === true && /Refusing to answer from a different provider/.test(e.message),
    "with no AI binding it must refuse rather than quietly answer from Anthropic",
  );
  assert.equal(fetchCalls.length, 0, "the refusal must not have called Anthropic first");

  console.log("provider routing: all focused offline tests passed");
} finally {
  globalThis.fetch = origFetch;
}
