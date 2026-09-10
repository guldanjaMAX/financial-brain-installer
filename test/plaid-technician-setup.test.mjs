import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  PLAID_WORKER_SECRET_NAMES,
  bankFeedWrappingKeyStorageOptions,
  ensureBankFeedWrappingKey,
  preflightPlaidWorkerSecretCustody,
  resolvePlaidWorkerProofBase,
  setupPlaidWorkerSecrets,
} from "../operations/plaid-technician-setup.mjs";

const FIXTURE_KEY = `v2.${Buffer.alloc(32, 23).toString("base64url")}`;
const OTHER_FIXTURE_KEY = `v2.${Buffer.alloc(32, 41).toString("base64url")}`;
const keyFingerprint = (value) => createHash("sha256")
  .update(Buffer.from(value.slice(3), "base64url"))
  .digest("hex");
const unlocked = async (_options, task) => task({ assertOwned: () => true });
const FAST_CEREMONY = Object.freeze({
  withLock: unlocked,
  proofAttempts: 1,
  proofDelayMs: 0,
  proofTimeoutMs: 0,
});
const absentKeyProof = async () => ({
  configured: false,
  key_version: 2,
  key_fingerprint: null,
});
const presentKeyProof = (value = FIXTURE_KEY) => async () => ({
  configured: true,
  key_version: 2,
  key_fingerprint: keyFingerprint(value),
});

function memoryStore(initial = {}) {
  let value = structuredClone(initial);
  return {
    loadStore: () => structuredClone(value),
    saveStore: (next) => { value = structuredClone(next); },
    read: () => structuredClone(value),
  };
}

test("the authenticated proof origin is derived only from the exact Cloudflare account and Worker", async () => {
  const calls = [];
  const base = await resolvePlaidWorkerProofBase({
    accountId: "fixture-account",
    scriptName: "fixture-worker",
    apiRequest: async (path) => {
      calls.push(path);
      if (path.endsWith("/workers/scripts/fixture-worker/subdomain")) return { enabled: true };
      return { subdomain: "Owner-Account" };
    },
  });
  assert.equal(base, "https://fixture-worker.owner-account.workers.dev");
  assert.deepEqual(calls, [
    "/accounts/fixture-account/workers/scripts/fixture-worker/subdomain",
    "/accounts/fixture-account/workers/subdomain",
  ]);
  assert.doesNotMatch(base, /brain\.fixture\.test/);
});

test("an unsafe Worker or workers.dev label refuses before an authenticated proof route exists", async () => {
  let calls = 0;
  await assert.rejects(
    resolvePlaidWorkerProofBase({
      accountId: "fixture-account",
      scriptName: "https://attacker.invalid",
      apiRequest: async () => { calls++; return { subdomain: "owner" }; },
    }),
    /Worker name is not safe/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    resolvePlaidWorkerProofBase({
      accountId: "fixture-account",
      scriptName: "fixture-worker",
      apiRequest: async (path) => {
        calls++;
        if (path.endsWith("/workers/scripts/fixture-worker/subdomain")) return { enabled: true };
        return { subdomain: "attacker.invalid" };
      },
    }),
    /did not return a safe workers\.dev hostname/,
  );
  assert.equal(calls, 2);
});

test("a disabled workers.dev route stops before an authenticated proof request", async () => {
  const calls = [];
  await assert.rejects(
    resolvePlaidWorkerProofBase({
      accountId: "fixture-account",
      scriptName: "fixture-worker",
      apiRequest: async (path) => { calls.push(path); return { enabled: false }; },
    }),
    /workers\.dev proof route is not enabled.*brain deploy/is,
  );
  assert.deepEqual(calls, [
    "/accounts/fixture-account/workers/scripts/fixture-worker/subdomain",
  ]);
});

test("the wrapping-key destination is a distinct per-Worker protected record", () => {
  const first = bankFeedWrappingKeyStorageOptions({
    accountId: "fixture-account",
    scriptName: "fixture-worker",
    home: "/fixture/home",
    platform: "win32",
  });
  const second = bankFeedWrappingKeyStorageOptions({
    accountId: "fixture-account",
    scriptName: "another-worker",
    home: "/fixture/home",
    platform: "win32",
  });
  assert.notEqual(first.path, second.path);
  assert.notEqual(first.keychainAccount, second.keychainAccount);
  assert.equal(first.backend, "file");
  assert.match(first.path, /bank-feed-wrapping-key-v2-[a-f0-9]{32}\.json$/);
  assert.doesNotMatch(JSON.stringify(first), /BANK_FEED_CLIENT_ID|BANK_FEED_SECRET/);
});

test("a new independent wrapping key is persisted and exactly read back before use", () => {
  const store = memoryStore();
  let generations = 0;
  const receipt = ensureBankFeedWrappingKey({
    accountId: "fixture-account",
    scriptName: "fixture-worker",
    loadStore: store.loadStore,
    saveStore: store.saveStore,
    describeStore: () => "fixture protected store",
    generate: () => { generations++; return FIXTURE_KEY; },
  });
  assert.equal(receipt.status, "generated");
  assert.equal(receipt.value, FIXTURE_KEY);
  assert.equal(receipt.storage, "fixture protected store");
  assert.equal(generations, 1);
  assert.equal(store.read().wrapping_key, FIXTURE_KEY);

  const reused = ensureBankFeedWrappingKey({
    accountId: "fixture-account",
    scriptName: "fixture-worker",
    loadStore: store.loadStore,
    saveStore: store.saveStore,
    describeStore: () => "fixture protected store",
    generate: () => { generations++; return FIXTURE_KEY; },
  });
  assert.equal(reused.status, "reused");
  assert.equal(reused.value, FIXTURE_KEY);
  assert.equal(generations, 1);
});

test("the read-only custody preflight runs before provider input and generates nothing", async () => {
  const store = memoryStore();
  let apiCalls = 0;
  const receipt = await preflightPlaidWorkerSecretCustody({
    accountId: "fixture-account",
    scriptName: "fixture-worker",
    wrappingKeyOptions: {
      ...FAST_CEREMONY,
      loadStore: store.loadStore,
      saveStore: store.saveStore,
      describeStore: () => "fixture protected store",
      generate: () => { throw new Error("preflight must not generate"); },
    },
    apiRequest: async () => {
      apiCalls++;
      throw new Error("GET binding failed (404): not found");
    },
    remoteWrappingKeyProof: absentKeyProof,
  });
  assert.deepEqual(receipt, {
    ready: true,
    remote_binding_present: false,
    local_custody: "ready_to_generate",
  });
  assert.equal(apiCalls, 1);
  assert.deepEqual(store.read(), {});
});

test("protected-store failure stops before remote mutation and reports no provider value", async () => {
  const clientId = Buffer.from("fixture-plaid-client-id");
  const clientSecret = Buffer.from("fixture-plaid-secret");
  let apiCalls = 0;
  await assert.rejects(
    setupPlaidWorkerSecrets({
      accountId: "fixture-account",
      scriptName: "fixture-worker",
      clientId,
      clientSecret,
      wrappingKeyOptions: {
        ...FAST_CEREMONY,
        loadStore: () => ({}),
        saveStore: () => { throw new Error("fixture-plaid-secret"); },
        describeStore: () => "fixture protected store",
        generate: () => FIXTURE_KEY,
      },
      apiRequest: async () => {
        apiCalls++;
        throw new Error("GET binding failed (404): not found");
      },
      remoteWrappingKeyProof: absentKeyProof,
    }),
    (error) => /No Worker secret was changed/.test(error.message) &&
      /protected credential store/.test(error.message) &&
      !error.message.includes("fixture-plaid-secret"),
  );
  assert.equal(apiCalls, 1);
});

test("an existing Worker key without local custody refuses before generation or mutation", async () => {
  const store = memoryStore();
  let generations = 0;
  let patchCalls = 0;
  await assert.rejects(
    setupPlaidWorkerSecrets({
      accountId: "fixture-account",
      scriptName: "fixture-worker",
      clientId: Buffer.from("fixture-plaid-client-id"),
      clientSecret: Buffer.from("fixture-plaid-secret"),
      wrappingKeyOptions: {
        ...FAST_CEREMONY,
        loadStore: store.loadStore,
        saveStore: store.saveStore,
        describeStore: () => "fixture protected store",
        generate: () => { generations++; return FIXTURE_KEY; },
      },
      apiRequest: async (_path, options = {}) => {
        if (options.method === "PATCH") patchCalls++;
        return { name: "BANK_FEED_WRAPPING_KEY_V2", type: "secret_text" };
      },
      remoteWrappingKeyProof: presentKeyProof(),
    }),
    (error) => /already has BANK_FEED_WRAPPING_KEY_V2/.test(error.message) &&
      /could make stored bank access references unreadable/.test(error.message) &&
      !error.message.includes("fixture-plaid-secret"),
  );
  assert.equal(generations, 0);
  assert.equal(patchCalls, 0);
  assert.deepEqual(store.read(), {});
});

test("Plaid setup bulk-applies exactly three secrets and reads back only those names", async () => {
  const store = memoryStore();
  const calls = [];
  const clientId = Buffer.from("fixture-plaid-client-id");
  const clientSecret = Buffer.from("fixture-plaid-secret");
  const receipt = await setupPlaidWorkerSecrets({
    accountId: "fixture-account",
    scriptName: "fixture-worker",
    clientId,
    clientSecret,
    wrappingKeyOptions: {
      ...FAST_CEREMONY,
      loadStore: store.loadStore,
      saveStore: store.saveStore,
      describeStore: () => "fixture protected store",
      generate: () => FIXTURE_KEY,
    },
    remoteWrappingKeyProof: async () => calls.some((call) => call.method === "PATCH")
      ? presentKeyProof()()
      : absentKeyProof(),
    apiRequest: async (path, options = {}) => {
      calls.push({ path, method: options.method || "GET", body: structuredClone(options.body) });
      if (!options.method && path.endsWith("/secrets/BANK_FEED_WRAPPING_KEY_V2") &&
          !calls.some((call) => call.method === "PATCH")) {
        throw new Error("GET binding failed (404): not found");
      }
      if (options.method === "PATCH") return {};
      const name = decodeURIComponent(path.split("/").at(-1));
      return { name, type: "secret_text" };
    },
  });

  assert.equal(receipt.applied_atomically, true);
  assert.deepEqual(receipt.secret_names_verified, PLAID_WORKER_SECRET_NAMES);
  assert.equal(receipt.opened_bank_connection, false);
  assert.equal(calls[0].method, "GET");
  assert.match(calls[0].path, /\/secrets\/BANK_FEED_WRAPPING_KEY_V2$/);
  assert.equal(calls[1].method, "PATCH");
  assert.match(calls[1].path, /\/secrets-bulk$/);
  assert.deepEqual(Object.keys(calls[1].body.secrets).sort(), [...PLAID_WORKER_SECRET_NAMES].sort());
  assert.deepEqual(calls.slice(2).map((call) => decodeURIComponent(call.path.split("/").at(-1))),
    PLAID_WORKER_SECRET_NAMES);
  assert.ok(calls.slice(2).every((call) => call.method === "GET" && call.body === undefined));
  assert.equal(calls[1].body.secrets.BANK_FEED_CLIENT_ID.text, "fixture-plaid-client-id");
  assert.equal(calls[1].body.secrets.BANK_FEED_SECRET.text, "fixture-plaid-secret");
  assert.equal(calls[1].body.secrets.BANK_FEED_WRAPPING_KEY_V2.text, FIXTURE_KEY);
  assert.equal(clientId.toString(), "fixture-plaid-client-id");
  assert.equal(clientSecret.toString(), "fixture-plaid-secret");
});

test("an ambiguous bulk failure keeps the same durable key for a safe atomic retry", async () => {
  const store = memoryStore();
  let generations = 0;
  const submittedKeys = [];
  const wrappingKeyOptions = {
    ...FAST_CEREMONY,
    loadStore: store.loadStore,
    saveStore: store.saveStore,
    describeStore: () => "fixture protected store",
    generate: () => { generations++; return FIXTURE_KEY; },
  };
  const values = () => ({
    clientId: Buffer.from("fixture-plaid-client-id"),
    clientSecret: Buffer.from("fixture-plaid-secret"),
  });
  let attempts = 0;
  const apiRequest = async (path, options = {}) => {
    if (!options.method && attempts === 0 &&
        path.endsWith("/secrets/BANK_FEED_WRAPPING_KEY_V2")) {
      throw new Error("GET binding failed (404): not found");
    }
    if (options.method === "PATCH") {
      attempts++;
      submittedKeys.push(options.body.secrets.BANK_FEED_WRAPPING_KEY_V2.text);
      if (attempts === 1) throw new Error("fixture response containing fixture-plaid-secret");
      return {};
    }
    const name = decodeURIComponent(path.split("/").at(-1));
    return { name, type: "secret_text" };
  };
  const remoteWrappingKeyProof = async () => attempts > 0
    ? presentKeyProof()()
    : absentKeyProof();

  await assert.rejects(
    setupPlaidWorkerSecrets({
      accountId: "fixture-account", scriptName: "fixture-worker", ...values(),
      apiRequest, remoteWrappingKeyProof, wrappingKeyOptions,
    }),
    (error) => /did not confirm the atomic bank-secret update/.test(error.message) &&
      !error.message.includes("fixture-plaid-secret"),
  );
  assert.equal(store.read().wrapping_key, FIXTURE_KEY);

  const retried = await setupPlaidWorkerSecrets({
    accountId: "fixture-account", scriptName: "fixture-worker", ...values(),
    apiRequest, remoteWrappingKeyProof, wrappingKeyOptions,
  });
  assert.equal(retried.wrapping_key_status, "reused");
  assert.deepEqual(submittedKeys, [FIXTURE_KEY, FIXTURE_KEY]);
  assert.equal(generations, 1);
});

test("a stale protected key cannot overwrite a different deployed wrapping key", async () => {
  const store = memoryStore();
  ensureBankFeedWrappingKey({
    accountId: "fixture-account",
    scriptName: "fixture-worker",
    loadStore: store.loadStore,
    saveStore: store.saveStore,
    describeStore: () => "fixture protected store",
    generate: () => FIXTURE_KEY,
  });
  let patchCalls = 0;
  await assert.rejects(
    setupPlaidWorkerSecrets({
      accountId: "fixture-account",
      scriptName: "fixture-worker",
      clientId: Buffer.from("fixture-plaid-client-id"),
      clientSecret: Buffer.from("fixture-plaid-secret"),
      wrappingKeyOptions: {
        ...FAST_CEREMONY,
        loadStore: store.loadStore,
        saveStore: store.saveStore,
        describeStore: () => "fixture protected store",
        generate: () => FIXTURE_KEY,
      },
      apiRequest: async (_path, options = {}) => {
        if (options.method === "PATCH") patchCalls++;
        return { name: "BANK_FEED_WRAPPING_KEY_V2", type: "secret_text" };
      },
      remoteWrappingKeyProof: presentKeyProof(OTHER_FIXTURE_KEY),
    }),
    (error) => /could not be proved equal to the deployed Brain/.test(error.message) &&
      /No Worker secret was changed/.test(error.message) &&
      !error.message.includes("fixture-plaid-secret"),
  );
  assert.equal(patchCalls, 0);
  assert.equal(store.read().wrapping_key, FIXTURE_KEY);
});

test("a just-rotated remote key breaks the full pre-write stability window", async () => {
  const store = memoryStore();
  ensureBankFeedWrappingKey({
    accountId: "fixture-account",
    scriptName: "fixture-worker",
    loadStore: store.loadStore,
    saveStore: store.saveStore,
    describeStore: () => "fixture protected store",
    generate: () => FIXTURE_KEY,
  });
  let clock = 0;
  let proofReads = 0;
  let patchCalls = 0;
  const waits = [];
  await assert.rejects(
    setupPlaidWorkerSecrets({
      accountId: "fixture-account",
      scriptName: "fixture-worker",
      clientId: Buffer.from("fixture-plaid-client-id"),
      clientSecret: Buffer.from("fixture-plaid-secret"),
      wrappingKeyOptions: {
        withLock: unlocked,
        loadStore: store.loadStore,
        saveStore: store.saveStore,
        describeStore: () => "fixture protected store",
        generate: () => FIXTURE_KEY,
        proofAttempts: 3,
        proofDelayMs: 10,
        proofTimeoutMs: 20,
        now: () => clock,
        wait: async (milliseconds) => { waits.push(milliseconds); clock += milliseconds; },
      },
      apiRequest: async (_path, options = {}) => {
        if (options.method === "PATCH") patchCalls++;
        return { name: "BANK_FEED_WRAPPING_KEY_V2", type: "secret_text" };
      },
      remoteWrappingKeyProof: async () => {
        proofReads++;
        return proofReads === 1 ? presentKeyProof(FIXTURE_KEY)() : presentKeyProof(OTHER_FIXTURE_KEY)();
      },
    }),
    /could not be proved equal.*recent secret update settle/is,
  );
  assert.deepEqual(waits, [10]);
  assert.equal(patchCalls, 0);
  assert.equal(store.read().wrapping_key, FIXTURE_KEY);
});

test("the ceremony acquires its per-Worker lock before any local or remote work", async () => {
  let apiCalls = 0;
  let lockPath = null;
  await assert.rejects(
    setupPlaidWorkerSecrets({
      accountId: "fixture-account",
      scriptName: "fixture-worker",
      clientId: Buffer.from("fixture-plaid-client-id"),
      clientSecret: Buffer.from("fixture-plaid-secret"),
      wrappingKeyOptions: {
        storage: { home: "/fixture/home", platform: "linux" },
        withLock: async (options) => {
          lockPath = options.statePath;
          const error = new Error("ingest wording must not escape");
          error.code = "source_ingest_already_running";
          throw error;
        },
      },
      apiRequest: async () => { apiCalls++; },
      remoteWrappingKeyProof: absentKeyProof,
    }),
    (error) => /private per-Worker lock/.test(error.message) &&
      !error.message.includes("ingest wording"),
  );
  assert.match(lockPath, /bank-feed-wrapping-key-v2-[a-f0-9]{32}\.json$/);
  assert.equal(apiCalls, 0);
});

test("a changed pinned context stops before local key generation or the atomic patch", async () => {
  const store = memoryStore();
  let contextChecks = 0;
  let patchCalls = 0;
  await assert.rejects(
    setupPlaidWorkerSecrets({
      accountId: "fixture-account",
      scriptName: "fixture-worker",
      clientId: Buffer.from("fixture-plaid-client-id"),
      clientSecret: Buffer.from("fixture-plaid-secret"),
      wrappingKeyOptions: {
        ...FAST_CEREMONY,
        loadStore: store.loadStore,
        saveStore: store.saveStore,
        describeStore: () => "fixture protected store",
        generate: () => FIXTURE_KEY,
      },
      assertContextUnchanged: () => {
        contextChecks++;
        if (contextChecks === 2) throw new Error("the install record changed");
      },
      apiRequest: async (path, options = {}) => {
        if (options.method === "PATCH") patchCalls++;
        if (path.endsWith("/BANK_FEED_WRAPPING_KEY_V2")) {
          throw new Error("GET binding failed (404): not found");
        }
        return {};
      },
      remoteWrappingKeyProof: absentKeyProof,
    }),
    /install record changed/,
  );
  assert.equal(contextChecks, 2);
  assert.equal(patchCalls, 0);
  assert.deepEqual(store.read(), {});
});

test("a context change after PATCH admits Cloudflare may have changed and keeps the retry key", async () => {
  const store = memoryStore();
  let contextChecks = 0;
  let patchCalls = 0;
  await assert.rejects(
    setupPlaidWorkerSecrets({
      accountId: "fixture-account",
      scriptName: "fixture-worker",
      clientId: Buffer.from("fixture-plaid-client-id"),
      clientSecret: Buffer.from("fixture-plaid-secret"),
      wrappingKeyOptions: {
        ...FAST_CEREMONY,
        loadStore: store.loadStore,
        saveStore: store.saveStore,
        describeStore: () => "fixture protected store",
        generate: () => FIXTURE_KEY,
      },
      assertContextUnchanged: ({ mutationMayHaveStarted = false } = {}) => {
        contextChecks++;
        if (mutationMayHaveStarted) {
          throw new Error(
            "Cloudflare may already have changed. The protected wrapping key was kept for the exact retry.",
          );
        }
      },
      apiRequest: async (path, options = {}) => {
        if (options.method === "PATCH") { patchCalls++; return {}; }
        if (path.endsWith("/BANK_FEED_WRAPPING_KEY_V2")) {
          throw new Error("GET binding failed (404): not found");
        }
        return {};
      },
      remoteWrappingKeyProof: absentKeyProof,
    }),
    (error) => /Cloudflare may already have changed/.test(error.message) &&
      /protected wrapping key was kept/.test(error.message) &&
      !/No Worker secret was changed/.test(error.message),
  );
  assert.ok(contextChecks > 0);
  assert.equal(patchCalls, 1);
  assert.equal(store.read().wrapping_key, FIXTURE_KEY);
});

test("bad binding readback fails without exposing the submitted values", async () => {
  const store = memoryStore();
  ensureBankFeedWrappingKey({
    accountId: "fixture-account",
    scriptName: "fixture-worker",
    loadStore: store.loadStore,
    saveStore: store.saveStore,
    describeStore: () => "fixture protected store",
    generate: () => FIXTURE_KEY,
  });
  const clientId = Buffer.from("fixture-plaid-client-id");
  const clientSecret = Buffer.from("fixture-plaid-secret");
  await assert.rejects(
    setupPlaidWorkerSecrets({
      accountId: "fixture-account",
      scriptName: "fixture-worker",
      clientId,
      clientSecret,
      wrappingKeyOptions: {
        ...FAST_CEREMONY,
        loadStore: store.loadStore,
        saveStore: store.saveStore,
        describeStore: () => "fixture protected store",
        generate: () => FIXTURE_KEY,
      },
      remoteWrappingKeyProof: presentKeyProof(),
      apiRequest: (() => {
        let reads = 0;
        return async (_path, options = {}) => {
          if (options.method === "PATCH") return {};
          reads++;
          return reads === 1
            ? { name: "BANK_FEED_WRAPPING_KEY_V2", type: "secret_text" }
            : { name: "wrong", type: "secret_text", text: "fixture-plaid-secret" };
        };
      })(),
    }),
    (error) => /accepted the atomic bank-secret update/.test(error.message) &&
      !error.message.includes("fixture-plaid-secret"),
  );
});
