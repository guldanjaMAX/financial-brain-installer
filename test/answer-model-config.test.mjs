import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { cmdUpdate, optionalWorkerSecretNames, workerBindings } from "../brain.mjs";

const CF = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const ANSWER = "claude-opus-5-5";
const GATE = "claude-sonnet-5-5";
const cfg = { d1_database_id: "fixture-database", storage: "d1" };
const value = (bindings, name) => bindings.find((binding) => binding.name === name)?.text;

test("deploy emits the configured answer and gate models", () => {
  const bindings = workerBindings({
    retrieval: { answer_model: ANSWER, gate_model: GATE },
  }, cfg);
  assert.equal(value(bindings, "ANSWER_MODEL"), ANSWER);
  assert.equal(value(bindings, "GATE_MODEL"), GATE);
});

test("an omitted gate model defaults byte for byte to the answer model", () => {
  const configured = workerBindings({ retrieval: { answer_model: ANSWER } }, cfg);
  assert.equal(value(configured, "GATE_MODEL"), value(configured, "ANSWER_MODEL"));

  const defaults = workerBindings({}, cfg);
  assert.equal(value(defaults, "ANSWER_MODEL"), CF,
    "normal deploys always set ANSWER_MODEL, making the Worker's legacy fallback unreachable");
  assert.equal(value(defaults, "GATE_MODEL"), CF);
});

test("mixed providers preserve the Anthropic secret only when one configured call needs it", () => {
  assert.deepEqual(optionalWorkerSecretNames({
    retrieval: { answer_model: CF, gate_model: GATE },
  }), ["ANTHROPIC_API_KEY"]);
  assert.deepEqual(optionalWorkerSecretNames({
    retrieval: { answer_model: ANSWER, gate_model: CF },
  }), ["ANTHROPIC_API_KEY"]);
  assert.deepEqual(optionalWorkerSecretNames({
    retrieval: { answer_model: CF, gate_model: CF },
  }), []);
});

test("schema, public template, and Worker template declare the gate model", () => {
  const schema = JSON.parse(readFileSync(new URL("../manifest.schema.json", import.meta.url), "utf8"));
  const template = JSON.parse(readFileSync(new URL("../templates/brain.manifest.json", import.meta.url), "utf8"));
  const wrangler = readFileSync(new URL("../worker/wrangler.toml.template", import.meta.url), "utf8");
  assert.deepEqual(schema.properties.retrieval.properties.gate_model.anyOf, [
    { type: "string", pattern: "^@cf/" },
    { enum: [ANSWER, GATE] },
  ]);
  assert.match(schema.properties.retrieval.properties.gate_model.description,
    /claude-opus-5-5.*claude-sonnet-5-5.*Anthropic key/is);
  assert.equal(template.retrieval.gate_model, template.retrieval.answer_model);
  assert.match(template.retrieval._comment, /gate_model/i);
  assert.match(wrangler, /^GATE_MODEL = /mu);
});

test("a schema-48-era manifest stays on the built-in pair without an Anthropic secret", () => {
  const legacy = {
    manifest_version: 1,
    brain: { version: "0.4.8" },
    infrastructure: { cloudflare: { storage: "d1" } },
  };
  const bindings = workerBindings(legacy, cfg);
  assert.deepEqual(bindings
    .filter((binding) => ["ANSWER_MODEL", "GATE_MODEL"].includes(binding.name))
    .map((binding) => [binding.name, binding.text]), [
      ["ANSWER_MODEL", CF],
      ["GATE_MODEL", CF],
    ]);
  assert.deepEqual(optionalWorkerSecretNames(legacy), []);
});

test("update refuses an unreviewed answer model before any paused-stage or credential work", async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "answer-model-update-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifestPath = join(root, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    manifest_version: 1,
    client: { slug: "fixture", display_name: "Owner" },
    brain: { worker_name: "fixture-brain", domain: "fixture.invalid" },
    infrastructure: { cloudflare: { storage: "d1" } },
    retrieval: { answer_model: "fixture-unreviewed", gate_model: CF },
  }));
  const calls = [];
  const error = await cmdUpdate(manifestPath, {
    lifecycleLockHeld: true,
    discoverInstalledManifest: () => ({ path: manifestPath }),
    adoptCloudflareAuthProfile: async () => {
      calls.push("credential-adoption");
      throw new Error("the refusal ran too late");
    },
  }).then(() => null, (caught) => caught);
  assert.equal(error?.supportCode, "ANSWER_MODEL_NOT_REVIEWED");
  assert.match(error?.message || "", /brain disconnect anthropic/);
  assert.equal(calls.length, 0, "the unreviewed-model decision happened before credential or pause work");
});

test("brain secrets warns about and explicitly excludes an ambient Anthropic key", () => {
  const source = readFileSync(new URL("../brain.mjs", import.meta.url), "utf8");
  const start = source.indexOf("export async function cmdSecrets(");
  const end = source.indexOf("\nexport ", start + 1);
  assert.ok(start >= 0 && end > start, "the cmdSecrets decision boundary was found");
  const boundary = source.slice(start, end);
  assert.match(boundary, /Object\.hasOwn\(environment, "ANTHROPIC_API_KEY"\)/);
  assert.match(boundary, /name !== "ANTHROPIC_API_KEY"/);
});
