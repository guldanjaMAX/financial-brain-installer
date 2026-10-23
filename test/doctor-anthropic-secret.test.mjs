import assert from "node:assert/strict";
import test from "node:test";

import * as brain from "../brain.mjs";
import * as doctor from "../doctor.mjs";

const customManifest = Object.freeze({
  brain: { worker_name: "fixture-brain" },
  infrastructure: { cloudflare: { d1_database_id: "fixture-database" } },
  retrieval: {
    answer_model: "claude-opus-5-5",
    gate_model: "claude-sonnet-5-5",
  },
});

test("doctor fails a configured Claude model when the Worker secret name is absent", () => {
  assert.equal(typeof doctor.checkAnthropicWorkerSecret, "function");
  const check = doctor.checkAnthropicWorkerSecret(customManifest, {
    workerSecretNames: ["ADMIN_KEY"],
  });
  assert.equal(check.status, doctor.FAIL);
  assert.match(check.detail, /Worker[\s\S]*ANTHROPIC_API_KEY[\s\S]*missing/iu);
  assert.match(check.fix, /brain connect anthropic/iu);
});

test("doctor passes a configured Claude model only from the Worker's secret-name inventory", () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "ambient-value-must-not-count";
  try {
    const present = doctor.checkAnthropicWorkerSecret(customManifest, {
      workerSecretNames: ["ADMIN_KEY", "ANTHROPIC_API_KEY"],
    });
    const absent = doctor.checkAnthropicWorkerSecret(customManifest, {
      workerSecretNames: ["ADMIN_KEY"],
    });
    assert.equal(present.status, doctor.OK);
    assert.equal(absent.status, doctor.FAIL);
    assert.doesNotMatch(JSON.stringify([present, absent]), /ambient-value-must-not-count/u);
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});

test("doctor reads the deployed Worker's secret names for a configured Claude model", async () => {
  assert.equal(typeof brain.buildAnthropicWorkerSecretCheck, "function");
  let inventoryReads = 0;
  const check = await brain.buildAnthropicWorkerSecretCheck("/fixture/brain.manifest.json", {
    loadManifest: () => ({ m: customManifest }),
    resolveAccount: async () => ({ id: "fixture-account" }),
    cf: async (path) => {
      inventoryReads += 1;
      assert.equal(path, "/accounts/fixture-account/workers/scripts/fixture-brain/secrets");
      return [{ name: "ADMIN_KEY" }, { name: "ANTHROPIC_API_KEY" }];
    },
  });
  assert.equal(inventoryReads, 1, "the Worker secret-name decision point was reached");
  assert.equal(check.status, doctor.OK);
});

test("built-in answer models do not require an Anthropic Worker secret read", async () => {
  let inventoryReads = 0;
  const check = await brain.buildAnthropicWorkerSecretCheck("/fixture/brain.manifest.json", {
    loadManifest: () => ({ m: { ...customManifest, retrieval: {} } }),
    resolveAccount: async () => ({ id: "fixture-account" }),
    cf: async () => { inventoryReads += 1; return []; },
  });
  assert.equal(inventoryReads, 0);
  assert.equal(check.status, doctor.OK);
});
