import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  BankProviderTransitionError,
  assertBankProviderTransitionAllows,
} from "../src/lib/bank-provider-transition.js";

function environment(target) {
  const counters = { reads: 0 };
  return {
    counters,
    env: {
      DB: {
        prepare() {
          return {
            async first() {
              counters.reads += 1;
              return target ? { transition_target: target } : null;
            },
          };
        },
      },
    },
  };
}

test("one worker guard refuses every non-target provider and keeps the target green", async () => {
  for (const provider of ["plaid", "custom"]) {
    const fixture = environment("simplefin");
    await assert.rejects(
      () => assertBankProviderTransitionAllows(fixture.env, provider),
      (error) => error instanceof BankProviderTransitionError &&
        error.code === "BANK_PROVIDER_TRANSITION_FENCED",
    );
    assert.equal(fixture.counters.reads, 1, `${provider}: the durable fence decision was reached`);
  }
  const target = environment("simplefin");
  await assert.doesNotReject(() => assertBankProviderTransitionAllows(target.env, "simplefin"));
  assert.equal(target.counters.reads, 1);
  const idle = environment(null);
  await assert.doesNotReject(() => assertBankProviderTransitionAllows(idle.env, "plaid"));
  assert.equal(idle.counters.reads, 1);
});

test("Plaid completion and promotion both invoke the shared durable guard", () => {
  const source = readFileSync(new URL("../src/lib/plaid-bank-feed.js", import.meta.url), "utf8");
  const completion = source.slice(source.indexOf("export async function completePlaidLink"),
    source.indexOf("function stagedAccount"));
  const promotion = source.slice(source.indexOf("async function promotePlaidWindow"),
    source.indexOf("export async function syncPlaidItem"));
  assert.match(completion, /assertBankProviderTransitionAllows\(env, PROVIDER\)/u);
  assert.match(promotion, /assertBankProviderTransitionAllows\(env, PROVIDER\)/u);
});
