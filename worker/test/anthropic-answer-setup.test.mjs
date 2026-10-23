import assert from "node:assert/strict";
import test from "node:test";

import {
  ANSWER_ERROR_MESSAGES,
  answerGenerationError,
  safeAnswerErrorText,
} from "../src/lib/answer-render.js";
import { ANSWER_ERROR_MESSAGES as FRONTEND_MESSAGES } from "../../frontend/src/lib/answer-render.js";
import { callLLM } from "../src/lib/core.js";
import { handleAnswerCheck } from "../src/index.js";

const db = () => ({
  exec: async () => {},
  prepare: () => ({
    bind: () => ({ run: async () => {}, first: async () => ({ m: 0 }) }),
    run: async () => {},
    first: async () => ({ m: 0 }),
  }),
});

test("Worker and frontend keep the reviewed answer messages byte-identical", () => {
  assert.deepEqual(ANSWER_ERROR_MESSAGES, FRONTEND_MESSAGES);
  for (const value of Object.values(ANSWER_ERROR_MESSAGES)) assert.equal(safeAnswerErrorText(value), value);
});

test("typed Anthropic failures select account, busy, and spend messages", () => {
  for (const provider_error_class of ["key_rejected", "billing", "model_unavailable"]) {
    assert.equal(answerGenerationError({ provider_error_class }), ANSWER_ERROR_MESSAGES.providerAccount);
    assert.equal(answerGenerationError({ provider_error_class }, { verification: true }), ANSWER_ERROR_MESSAGES.providerAccount);
  }
  assert.equal(answerGenerationError({ provider_error_class: "busy" }), ANSWER_ERROR_MESSAGES.unavailable);
  assert.equal(answerGenerationError({ llm_cap_exceeded: true, spend_guard_degraded: true }), ANSWER_ERROR_MESSAGES.spendCheckPaused);
  assert.equal(answerGenerationError({ llm_cap_exceeded: true }), ANSWER_ERROR_MESSAGES.dailyLimit);
  assert.equal(answerGenerationError({ no_anthropic_key: true }), ANSWER_ERROR_MESSAGES.keyMissing);
});

test("missing Anthropic key blocks answer and check labels without a Workers AI call", async () => {
  for (const label of ["rag-think", "rag-think-repair", "rag-synthesis-gate", "rag-evidence-gate", "answer-model-check"]) {
    let calls = 0;
    await assert.rejects(
      callLLM({ AI: { run: async () => { calls++; } }, DB: { prepare: () => ({ bind: () => ({ run: async () => {} }) }) } }, {
        model: "claude-opus-5-5", label, system: "fixture", messages: [], max_tokens: 128,
      }),
      (error) => error?.no_anthropic_key === true,
    );
    assert.equal(calls, 0, label);
  }
  await assert.rejects(
    callLLM({ DB: db() }, {
      model: "claude-opus-5-5", label: "answer-model-check", system: "fixture", messages: [], max_tokens: 128,
    }),
    (error) => error?.no_anthropic_key === true,
    "the answer-key refusal takes precedence even when no Workers AI binding exists",
  );
});

test("rerank retains the existing no-key fallback", async () => {
  let calls = 0;
  const result = await callLLM({ AI: { run: async () => { calls++; return { response: "[]" }; } } }, {
    model: "claude-haiku-4-5", label: "rag-rerank", system: "fixture", messages: [], max_tokens: 128,
  });
  assert.equal(calls, 1);
  assert.equal(result.provider, "cloudflare-workers-ai");
});

test("effort is sent only for the reviewed Opus and Sonnet ids", async () => {
  const bodies = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ content: [{ type: "text", text: "OK" }], usage: {} }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    for (const model of ["claude-opus-5-5", "claude-sonnet-5-5-20261001", "claude-haiku-4-5"]) {
      await callLLM({ ANTHROPIC_API_KEY: "fixture-not-a-key" }, {
        model, label: "fixture", system: "fixture", messages: [], max_tokens: 128,
      });
    }
  } finally {
    globalThis.fetch = oldFetch;
  }
  assert.deepEqual(bodies.map((body) => body.output_config), [
    { effort: "medium" },
    { effort: "high" },
    undefined,
  ]);
});

test("provider HTTP failures carry only typed status and class into public mapping", async () => {
  const oldFetch = globalThis.fetch;
  const rows = [
    [401, { error: { message: "private authentication detail" } }, "key_rejected"],
    [403, { error: { message: "private permission detail" } }, "key_rejected"],
    [402, { error: { message: "private billing detail" } }, "billing"],
    [400, { error: { message: "Credit balance is too low" } }, "billing"],
    [400, { error: { message: "different request problem" } }, "error"],
    [404, { error: { message: "private model detail" } }, "model_unavailable"],
    [429, { error: { message: "private rate detail" } }, "busy"],
    [529, { error: { message: "private overload detail" } }, "busy"],
    [500, { error: { message: "private service detail" } }, "busy"],
  ];
  try {
    for (const [status, responseBody, expected] of rows) {
      globalThis.fetch = async () => new Response(JSON.stringify(responseBody), {
        status,
        headers: { "content-type": "application/json" },
      });
      await assert.rejects(
        callLLM({ ANTHROPIC_API_KEY: "fixture", DB: db() }, {
          model: "claude-opus-5-5", label: "rag-think", system: "fixture", messages: [], max_tokens: 128,
        }),
        (error) => error.anthropic_status === status && error.provider_error_class === expected &&
          !answerGenerationError(error).includes("private"),
      );
    }
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("answer-check makes no provider call for built-in and never returns provider text", async () => {
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("must not call provider"); };
  try {
    const builtIn = await (await handleAnswerCheck({
      ANSWER_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      GATE_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    })).json();
    assert.equal(calls, 0);
    assert.deepEqual(builtIn, {
      answer: { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", status: "built_in" },
      check: { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", status: "built_in" },
    });

    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "provider text sentinel" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    };
    const rejected = await (await handleAnswerCheck({
      ANSWER_MODEL: "claude-opus-5-5",
      GATE_MODEL: "claude-opus-5-5",
      ANTHROPIC_API_KEY: "fixture",
      DB: db(),
    })).json();
    assert.equal(calls, 1, "equal models reach one provider decision point");
    assert.deepEqual(rejected, {
      answer: { model: "claude-opus-5-5", status: "key_rejected" },
      check: { model: "claude-opus-5-5", status: "key_rejected" },
    });
    assert.equal(JSON.stringify(rejected).includes("provider text sentinel"), false);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("answer-check closes every provider and spend outcome to a typed status", async () => {
  const oldFetch = globalThis.fetch;
  const rows = [
    [402, { error: { message: "account detail" } }, "billing"],
    [400, { error: { message: "other detail" } }, "error"],
    [404, { error: { message: "model detail" } }, "model_unavailable"],
    [529, { error: { message: "busy detail" } }, "busy"],
  ];
  try {
    for (const [status, responseBody, expected] of rows) {
      globalThis.fetch = async () => new Response(JSON.stringify(responseBody), {
        status,
        headers: { "content-type": "application/json" },
      });
      const body = await (await handleAnswerCheck({
        ANSWER_MODEL: "claude-opus-5-5",
        GATE_MODEL: "claude-opus-5-5",
        ANTHROPIC_API_KEY: "fixture",
        DB: db(),
      })).json();
      assert.equal(body.answer.status, expected);
      assert.equal(body.check.status, expected);
      assert.equal(JSON.stringify(body).includes("detail"), false);
    }

    globalThis.fetch = async () => new Response(JSON.stringify({
      content: [{ type: "thinking", thinking: "" }],
      model: "claude-opus-5-5",
      usage: {},
      stop_reason: "max_tokens",
    }), { status: 200, headers: { "content-type": "application/json" } });
    const emptyAtLimit = await (await handleAnswerCheck({
      ANSWER_MODEL: "claude-opus-5-5",
      GATE_MODEL: "claude-opus-5-5",
      ANTHROPIC_API_KEY: "fixture",
      DB: db(),
    })).json();
    assert.equal(emptyAtLimit.answer.status, "ok");

    let providerCalls = 0;
    globalThis.fetch = async () => { providerCalls++; throw new Error("must not call"); };
    const missing = await (await handleAnswerCheck({
      ANSWER_MODEL: "claude-opus-5-5",
      GATE_MODEL: "claude-opus-5-5",
      DB: db(),
      AI: { run: async () => { providerCalls++; } },
    })).json();
    assert.equal(missing.answer.status, "key_missing");
    assert.equal(providerCalls, 0);

    const daily = await (await handleAnswerCheck({
      ANSWER_MODEL: "claude-opus-5-5",
      GATE_MODEL: "claude-opus-5-5",
      ANTHROPIC_API_KEY: "fixture",
      DAILY_LLM_CAP_USD: "0",
      DB: db(),
    })).json();
    assert.equal(daily.answer.status, "daily_limit");

    const paused = await (await handleAnswerCheck({
      ANSWER_MODEL: "claude-opus-5-5",
      GATE_MODEL: "claude-opus-5-5",
      ANTHROPIC_API_KEY: "fixture",
      DAILY_LLM_CAP_USD: "0",
    })).json();
    assert.equal(paused.answer.status, "spend_check_paused");
  } finally {
    globalThis.fetch = oldFetch;
  }
});

