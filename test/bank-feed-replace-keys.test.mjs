// `brain connect bank --replace-keys` and the pre-write Plaid key check.
//
// Field evidence: two operators pasted a Plaid secret from the wrong
// environment. The only path that could write the pair prompted only when a
// name was missing, `brain secrets` refuses bank keys by design, and the wrong
// secret surfaced later as a Link failure in the owner's browser. The pair is
// now proven with one harmless authenticated Plaid read before anything is
// written, on the first entry and on every replacement.
//
// Every value here is an invented placeholder. Plaid, Cloudflare, and the hidden
// prompt are injected; nothing leaves the process.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdConnect, cmdConnectBank } from "../brain.mjs";

const CLIENT_ID = "placeholder-client-id-0001";
const SECRET = "placeholder-secret-0002";
const WRONG_SECRET = "placeholder-secret-from-another-environment";
const WRAPPING = "BANK_FEED_WRAPPING_KEY_V2";
const ALL_NAMES = ["BANK_FEED_CLIENT_ID", "BANK_FEED_SECRET", WRAPPING];

const plaidJson = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json" },
});

/** An offline Plaid that accepts exactly one pair in exactly one environment. */
function plaidFake({ environment = "sandbox", acceptSecret = SECRET, unreachable = false, errorCode = null } = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init.body || "{}"));
    calls.push({ host: url.hostname, path: url.pathname, method: init.method, body });
    if (unreachable) throw new TypeError("fetch failed");
    if (errorCode) return plaidJson({ error_type: "API_ERROR", error_code: errorCode, error_message: "fixture" }, 500);
    const rightHost = url.hostname === `${environment}.plaid.com`;
    if (!rightHost || body.client_id !== CLIENT_ID || body.secret !== acceptSecret) {
      return plaidJson({
        display_message: null, error_type: "INVALID_INPUT", error_code: "INVALID_API_KEYS",
        error_message: "invalid client_id or secret provided", request_id: "fixture-request",
      }, 400);
    }
    return plaidJson({ institutions: [{ institution_id: "ins_fixture", name: "Fixture Institution" }], total: 1 });
  };
  return { fetchImpl, calls };
}

function workerFake(initialNames) {
  const names = new Set(initialNames);
  const writes = [];
  const values = new Map();
  let lists = 0;
  return {
    writes, values,
    listCount: () => lists,
    names: () => new Set(names),
    listWorkerSecretNames: async () => { lists += 1; return [...names]; },
    putWorkerSecret: async (name, text) => { writes.push(name); values.set(name, text); names.add(name); },
  };
}

function manifestFile(environment = "sandbox") {
  const directory = mkdtempSync(join(tmpdir(), "brain-replace-keys-"));
  const path = join(directory, "brain.manifest.json");
  writeFileSync(path, JSON.stringify({
    client: { slug: "fixture", display_name: "Fixture" },
    brain: { worker_name: "fixture-brain", domain: "fixture-brain.example.workers.dev" },
    infrastructure: { cloudflare: { account_id: "fixture-account" } },
    corpora: { bank_feed: {
      enabled: true, provider: "plaid", environment, country_codes: ["US"],
      registered_redirect_uris: ["https://fixture-brain.example.workers.dev/app/connect/bank"],
    } },
  }));
  return { path, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

async function connect({ flags = {}, initial = ALL_NAMES, answers = [CLIENT_ID, SECRET], plaid = plaidFake(), environment = "sandbox" } = {}) {
  const manifest = manifestFile(environment);
  const worker = workerFake(initial);
  const prompts = [];
  const opened = [];
  const output = [];
  const priorLog = console.log;
  let result = null;
  let message = "";
  console.log = (...args) => output.push(args.map(String).join(" "));
  try {
    result = await cmdConnectBank(manifest.path, flags, {
      env: {},
      listWorkerSecretNames: worker.listWorkerSecretNames,
      putWorkerSecret: worker.putWorkerSecret,
      readSecret: async (text) => { prompts.push(text); return answers[prompts.length - 1]; },
      plaidFetchImpl: plaid.fetchImpl,
      generateWrappingKey: () => `v2.${"B".repeat(43)}`,
      openImpl: (url) => { opened.push(url); return true; },
    });
  } catch (error) {
    message = String(error?.message || error);
  } finally {
    console.log = priorLog;
    manifest.cleanup();
  }
  return { result, message, prompts, opened, worker, plaid, output: output.join("\n") };
}

const noTypedValue = (text) => ![CLIENT_ID, SECRET, WRONG_SECRET].some((value) => text.includes(value));

test("--replace-keys re-prompts for both keys even when all three names exist, and keeps the wrapping key", async () => {
  const run = await connect({ flags: { "replace-keys": true } });
  assert.equal(run.message, "");
  assert.equal(run.prompts.length, 2);
  assert.match(run.prompts[0], /client_id for the sandbox environment \(hidden\)/);
  assert.match(run.prompts[1], /secret for the sandbox environment \(hidden\)/);
  assert.deepEqual(run.worker.writes, ["BANK_FEED_CLIENT_ID", "BANK_FEED_SECRET"]);
  assert.equal(run.worker.values.get("BANK_FEED_SECRET"), SECRET);
  assert.equal(run.worker.values.has(WRAPPING), false, "the wrapping key is never written by --replace-keys");
  assert.equal(run.worker.listCount(), 2, "the Worker is re-listed after the writes");
  assert.equal(run.result.keys_replaced, true);
  assert.deepEqual(run.result.secrets_written, ["BANK_FEED_CLIENT_ID", "BANK_FEED_SECRET"]);
  assert.equal(run.opened.length, 1);
  assert.match(run.output, /BANK_FEED_WRAPPING_KEY_V2 was not touched/);
  assert.ok(noTypedValue(run.output), "no typed value is ever printed");
});

test("the typed pair is proven with one harmless Plaid read against the manifest environment first", async () => {
  const run = await connect({ flags: { "replace-keys": true } });
  assert.equal(run.plaid.calls.length, 1);
  const [call] = run.plaid.calls;
  assert.deepEqual({ host: call.host, path: call.path, method: call.method }, {
    host: "sandbox.plaid.com", path: "/institutions/get", method: "POST",
  });
  assert.deepEqual(call.body, { client_id: CLIENT_ID, secret: SECRET, count: 1, offset: 0, country_codes: ["US"] });

  const production = await connect({
    flags: { "replace-keys": true }, environment: "production", plaid: plaidFake({ environment: "production" }),
  });
  assert.equal(production.message, "");
  assert.equal(production.plaid.calls[0].host, "production.plaid.com");
  assert.match(production.prompts[1], /production environment/);
});

test("a pair from another Plaid environment is refused at the prompt and nothing is written", async () => {
  for (const initial of [ALL_NAMES, ["ADMIN_KEY"]]) {
    const run = await connect({
      flags: initial === ALL_NAMES ? { "replace-keys": true } : {},
      initial, answers: [CLIENT_ID, WRONG_SECRET],
    });
    assert.match(run.message, /Plaid rejected this client_id and secret for the sandbox environment/);
    assert.match(run.message, /the secret is for a different Plaid environment \(sandbox, development or production\)/);
    assert.match(run.message, /Nothing was written/);
    assert.deepEqual(run.worker.writes, [], "not even a first-time wrapping key is written");
    assert.equal(run.opened.length, 0, "the browser does not open on a refused pair");
    assert.ok(noTypedValue(run.message) && noTypedValue(run.output), "the refusal repeats no typed value");
  }
});

test("the first-time prompt is checked the same way before any write", async () => {
  const run = await connect({ initial: ["ADMIN_KEY"] });
  assert.equal(run.message, "");
  assert.equal(run.plaid.calls.length, 1);
  assert.deepEqual(run.worker.writes, ALL_NAMES, "a missing wrapping key is still generated on first setup");
  assert.equal(run.result.keys_replaced, false);
});

test("an unreachable or erroring Plaid fails closed without writing", async () => {
  for (const plaid of [plaidFake({ unreachable: true }), plaidFake({ errorCode: "INTERNAL_SERVER_ERROR" })]) {
    const run = await connect({ flags: { "replace-keys": true }, plaid });
    assert.match(run.message, /could not be reached|did not confirm these keys/);
    assert.match(run.message, /[Nn]othing was written/);
    assert.deepEqual(run.worker.writes, []);
    assert.equal(run.opened.length, 0);
  }
});

test("--replace-keys never creates a missing wrapping key and never runs as a valued flag", async () => {
  const missingWrapping = await connect({
    flags: { "replace-keys": true }, initial: ["BANK_FEED_CLIENT_ID", "BANK_FEED_SECRET"],
  });
  assert.match(missingWrapping.message, /--replace-keys changes only the Plaid client_id and secret/);
  assert.equal(missingWrapping.prompts.length, 0, "refused before any prompt");
  assert.deepEqual(missingWrapping.worker.writes, []);

  const valued = await connect({ flags: { "replace-keys": "yes" } });
  assert.match(valued.message, /--replace-keys is a switch and does not take a value/);
  assert.equal(valued.prompts.length, 0);
  assert.deepEqual(valued.worker.writes, []);
});

test("with every key present and no flag, nothing is prompted and the owner is told how to fix a typo", async () => {
  const run = await connect();
  assert.equal(run.prompts.length, 0);
  assert.equal(run.plaid.calls.length, 0);
  assert.deepEqual(run.worker.writes, []);
  assert.match(run.output, /rerun this command with --replace-keys/);
});

test("the validator names each refusal plainly and never echoes a key", async () => {
  // Imported here so every other case in this file still runs against a build
  // that predates the validator.
  const { validatePlaidApplicationKeys } = await import("../operations/bank-feed-owner-secrets.mjs");
  assert.equal(typeof validatePlaidApplicationKeys, "function");
  const plaid = plaidFake();
  await assert.doesNotReject(validatePlaidApplicationKeys({
    environment: "sandbox", clientId: CLIENT_ID, secret: SECRET, fetchImpl: plaid.fetchImpl,
  }));
  await assert.rejects(validatePlaidApplicationKeys({
    environment: "sandbox", clientId: CLIENT_ID, secret: WRONG_SECRET, fetchImpl: plaid.fetchImpl,
  }), (error) => /different Plaid environment/.test(error.message) && noTypedValue(error.message));
  await assert.rejects(validatePlaidApplicationKeys({
    environment: "development", clientId: CLIENT_ID, secret: SECRET, fetchImpl: plaid.fetchImpl,
  }), /must be sandbox or production/);
  assert.equal(plaid.calls.length, 2, "an unsupported environment is refused before any request");
});

test("the CLI dispatcher hands --replace-keys to connect bank as a switch", async () => {
  let seen = null;
  await cmdConnect("bank", {
    argv: ["node", "brain.mjs", "connect", "bank", "fixture.manifest.json", "--replace-keys"],
    withManifestControl: (_path, action) => action(),
    connectBank: async (path, flags) => { seen = { path, flags }; return {}; },
  });
  assert.deepEqual(seen, { path: "fixture.manifest.json", flags: { "replace-keys": true } });
});
