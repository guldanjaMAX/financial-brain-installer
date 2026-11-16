// 11-16: the founder Brain's 0.4.28 rc2 update read the Worker's secret names
// once, right after its active upload. Cloudflare left out
// BANK_FEED_WRAPPING_KEY_V2, which the same run had listed after its paused
// upload, and the updater PUT a new random value over it. The stored Plaid
// access reference could no longer be opened (BANK_ACCESS_REFERENCE_UNREADABLE).
//
// Contract pinned here: the inventory is read BEFORE the upload too. A key that
// was there before (or earlier in the same run) is never written again; a
// missing name after the upload is re-read after 2s, 5s and 10s and, if it
// never comes back, the command stops without writing. A key is created only
// when it was absent before the upload AND after it.
//
// Review round (11-16): two false-absent reads in a NEW process (a rerun after
// the stop, a standalone deploy, the paused upload of the next update) still
// replaced the key. So a key is also never created when this computer recorded
// it on that Worker in an earlier run, or when the Brain's D1 holds any bank
// connection or Plaid Link receipt sealed with it; a Worker-missing answer is
// read only from Cloudflare's structured error code; and a paged secret list
// is never read as "absent".
import { createUpgradeBookmarkWriter } from "./fixtures/upgrade-bookmark-writer.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bankWrappingKeySightingStore,
  cmdDeploy,
  cmdUpdate,
  cmdUpgrade,
  isWorkerScriptMissingError,
  readWorkerSecretNameInventory,
  splitStatements,
} from "../brain.mjs";
import {
  BANK_SEALED_REFERENCE_CHECKS,
  BANK_WRAPPING_KEY_CONFIRM_DELAYS_MS,
  countSealedBankAccessReferences,
  ensureBankFeedWrappingKey,
  readBankWrappingKeyBeforeUpload,
} from "../operations/bank-feed-owner-secrets.mjs";

const WRAPPING_NAME = "BANK_FEED_WRAPPING_KEY_V2";
const SENTINEL = `v2.${Buffer.alloc(32, 41).toString("base64url")}`;
const SENTINEL_PATTERN = new RegExp(SENTINEL.replaceAll(".", "\\."));
const NOT_CONFIRMED = /no new key was created and nothing was replaced/i;
const INTACT = /this command did not change your bank connections/i;
const SEALED = /database holds \d+ bank connection records? sealed with that key/i;
const SEALED_UNKNOWN = /database could not be checked for bank connections sealed with it/i;
const RECORDED = /an earlier run on this computer saw it there/i;

// ---------------------------------------------------------------------------
// Unit level: the custody decision itself.
// ---------------------------------------------------------------------------

function custodyFixture(reads, { sealed = 0 } = {}) {
  // reads: array of "present" | "missing" | "fail"; the last entry repeats.
  // sealed: what the Brain's database check answers (a count, or "fail").
  let lists = 0;
  let sealedChecks = 0;
  let puts = 0;
  let generated = 0;
  const waits = [];
  const landed = new Set();
  const listSecretNames = async () => {
    const mode = reads[Math.min(lists, reads.length - 1)];
    lists += 1;
    if (mode === "fail") throw new Error(`fixture inventory failure carrying ${SENTINEL}`);
    if (landed.has(WRAPPING_NAME)) return ["ADMIN_KEY", WRAPPING_NAME];
    return mode === "present" ? ["ADMIN_KEY", WRAPPING_NAME] : ["ADMIN_KEY"];
  };
  return {
    listSecretNames,
    putSecret: async (name) => { puts += 1; landed.add(name); },
    generateWrappingKey: () => { generated += 1; return SENTINEL; },
    sleep: async (ms) => { waits.push(ms); },
    countSealedReferences: async () => {
      sealedChecks += 1;
      if (sealed === "fail") throw new Error(`fixture database failure carrying ${SENTINEL}`);
      return sealed;
    },
    get sealedChecks() { return sealedChecks; },
    get lists() { return lists; },
    get puts() { return puts; },
    get generated() { return generated; },
    waits,
  };
}

async function decide(fixture, beforeUpload, { withSealedCheck = true } = {}) {
  try {
    const result = await ensureBankFeedWrappingKey({
      enabled: true,
      listSecretNames: fixture.listSecretNames,
      putSecret: fixture.putSecret,
      generateWrappingKey: fixture.generateWrappingKey,
      sleep: fixture.sleep,
      ...(withSealedCheck ? { countSealedReferences: fixture.countSealedReferences } : {}),
      ...(beforeUpload === undefined ? {} : { beforeUpload }),
    });
    return { result, error: null };
  } catch (error) {
    return { result: null, error };
  }
}

test("the confirm waits are 2s, 5s and 10s", () => {
  assert.deepEqual([...BANK_WRAPPING_KEY_CONFIRM_DELAYS_MS], [2_000, 5_000, 10_000]);
});

test("present before + missing after: never PUTs, re-reads with backoff, then stops", async () => {
  const fixture = custodyFixture(["missing"]);
  const { error } = await decide(fixture, "present");
  assert.equal(fixture.puts, 0, "a key that existed before the upload must never be written");
  assert.equal(fixture.generated, 0, "no replacement value may even be generated");
  assert.deepEqual(fixture.waits, [2_000, 5_000, 10_000]);
  assert.equal(fixture.lists, 4, "one read after the upload plus three confirm re-reads");
  assert.match(error?.message || "", NOT_CONFIRMED);
  assert.match(error?.message || "", INTACT);
  assert.match(error?.message || "", /rerun the same command/i);
  assert.doesNotMatch(error?.message || "", SENTINEL_PATTERN);
});

test("present before + missing after + listed again on a re-read: no PUT, success", async () => {
  const fixture = custodyFixture(["missing", "missing", "present"]);
  const { result, error } = await decide(fixture, "present");
  assert.equal(error, null);
  assert.equal(result.created, false);
  assert.equal(result.confirmRetries, 2);
  assert.equal(fixture.puts, 0);
  assert.equal(fixture.generated, 0);
  assert.deepEqual(fixture.waits, [2_000, 5_000]);
});

test("present before + a failing re-read keeps waiting and never writes", async () => {
  const fixture = custodyFixture(["missing", "fail", "present"]);
  const { result, error } = await decide(fixture, "present");
  assert.equal(error, null);
  assert.equal(result.created, false);
  assert.equal(fixture.puts, 0);
});

test("present before + present after: no PUT and no waiting", async () => {
  const fixture = custodyFixture(["present"]);
  const { result, error } = await decide(fixture, "present");
  assert.equal(error, null);
  assert.equal(result.created, false);
  assert.equal(fixture.lists, 1);
  assert.equal(fixture.puts, 0);
  assert.deepEqual(fixture.waits, []);
});

test("absent before + absent after: creates exactly once and verifies by name", async () => {
  const fixture = custodyFixture(["missing"]);
  const { result, error } = await decide(fixture, "absent");
  assert.equal(error, null);
  assert.equal(result.created, true);
  assert.equal(fixture.generated, 1);
  assert.equal(fixture.puts, 1);
  assert.equal(fixture.lists, 2, "the absent read and the post-write verification");
  assert.deepEqual(fixture.waits, []);
  assert.doesNotMatch(JSON.stringify(result), SENTINEL_PATTERN);

  const rerun = await decide(fixture, "present");
  assert.equal(rerun.error, null, "an idempotent rerun sees the created key");
  assert.equal(fixture.puts, 1, "the rerun must not write again");
});

test("absent before + present after (landed elsewhere): adopts it, no PUT", async () => {
  const fixture = custodyFixture(["present"]);
  const { result, error } = await decide(fixture, "absent");
  assert.equal(error, null);
  assert.equal(result.created, false);
  assert.equal(fixture.puts, 0);
  assert.equal(fixture.sealedChecks, 0, "a listed key needs no database proof");
});

test("absent before + absent after + a sealed connection in the database: never PUTs", async () => {
  const fixture = custodyFixture(["missing"], { sealed: 1 });
  const { error } = await decide(fixture, "absent");
  assert.equal(fixture.sealedChecks, 1, "the database decision point must be reached");
  assert.equal(fixture.puts, 0, "a key that sealed a stored connection must never be replaced");
  assert.equal(fixture.generated, 0);
  assert.match(error?.message || "", SEALED);
  assert.match(error?.message || "", INTACT);
  assert.match(error?.message || "", /ask for help/i);
  assert.doesNotMatch(error?.message || "", SENTINEL_PATTERN);
});

for (const [label, sealed] of [["a failed database read", "fail"], ["a non-number count", Number.NaN], ["a negative count", -1]]) {
  test(`absent before + absent after + ${label}: never PUTs`, async () => {
    const fixture = custodyFixture(["missing"], { sealed });
    const { error } = await decide(fixture, "absent");
    assert.equal(fixture.puts, 0, "an unproven zero must never create a key");
    assert.equal(fixture.generated, 0);
    assert.match(error?.message || "", SEALED_UNKNOWN);
    assert.doesNotMatch(error?.message || "", SENTINEL_PATTERN);
  });
}

test("absent before + absent after with no database check supplied: never PUTs", async () => {
  const fixture = custodyFixture(["missing"]);
  const { error } = await decide(fixture, "absent", { withSealedCheck: false });
  assert.equal(fixture.puts, 0);
  assert.match(error?.message || "", SEALED_UNKNOWN);
});

test("recorded by an earlier run + missing after: never PUTs, re-reads, then stops", async () => {
  const fixture = custodyFixture(["missing"]);
  const { error } = await decide(fixture, "recorded");
  assert.equal(fixture.puts, 0, "a key this computer saw in an earlier run must never be written");
  assert.equal(fixture.sealedChecks, 0);
  assert.deepEqual(fixture.waits, [2_000, 5_000, 10_000]);
  assert.match(error?.message || "", RECORDED);
  assert.match(error?.message || "", INTACT);
  assert.match(error?.message || "", /ask for help/i);
});

test("the database check counts every value sealed with the key against the real schema", async () => {
  const db = new DatabaseSync(":memory:");
  const migrations = new URL("../migrations/d1/", import.meta.url);
  for (const file of readdirSync(migrations).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
    for (const sql of splitStatements(readFileSync(new URL(file, migrations), "utf8"))) db.exec(sql);
  }
  const query = async (sql) => ({ results: db.prepare(sql).all() });
  assert.equal(await countSealedBankAccessReferences({ query }), 0, "a freshly migrated Brain holds nothing sealed");

  const insertItem = db.prepare(
    `INSERT INTO bank_feed_items (item_ref, access_ciphertext, access_iv, key_version, environment, status,
       status_detail, connected_at, removed_at) VALUES (?, ?, ?, ?, 'production', ?, ?, '2026-11-01', ?)`,
  );
  insertItem.run("legacy-item", "QUJDREVGR0hJSktMTU5PUA==", "QUJDREVGR0g=", 1, "connected", null, null);
  assert.equal(await countSealedBankAccessReferences({ query }), 0, "a version-1 row uses the legacy derived key");
  insertItem.run("removed-item", "QUJDREVGR0hJSktMTU5PUA==", "QUJDREVGR0g=", 2, "removed", "owner removed", "2026-11-02");
  assert.equal(await countSealedBankAccessReferences({ query }), 1, "a removed connection keeps its sealed reference");
  insertItem.run("live-item", "QUJDREVGR0hJSktMTU5PUA==", "QUJDREVGR0g=", 2, "connected", null, null);
  db.prepare(
    `INSERT INTO plaid_link_operations (session_ref, request_fingerprint, mode, state, link_ciphertext, link_iv,
       link_key_version, created_at, updated_at) VALUES ('s1', 'f1', 'connect', 'link_ready', 'QUJDREVGR0hJSktMTU5PUA==',
       'QUJDREVGR0g=', 2, '2026-11-01', '2026-11-01')`,
  ).run();
  assert.equal(await countSealedBankAccessReferences({ query }), 3, "an open Plaid Link receipt is sealed too");
  db.close();

  const empty = new DatabaseSync(":memory:");
  assert.equal(
    await countSealedBankAccessReferences({ query: async (sql) => ({ results: empty.prepare(sql).all() }) }),
    0,
    "a database migrated before the bank feed holds nothing sealed",
  );
  empty.close();
  assert.deepEqual(BANK_SEALED_REFERENCE_CHECKS.map((check) => check.table), ["bank_feed_items", "plaid_link_operations"]);

  await assert.rejects(
    countSealedBankAccessReferences({ query: async () => { throw new Error("D1 overloaded: no such table: bank_feed_items_archive"); } }),
    /could not be checked/i,
    "only the exact missing table counts as empty",
  );
  await assert.rejects(countSealedBankAccessReferences({ query: async () => ({ results: [] }) }), /unreadable count/i);
  await assert.rejects(countSealedBankAccessReferences({ query: async () => ({ results: [{ sealed: "1e3" }] }) }), /unreadable count/i);
});

test("a Worker-missing answer is read only from Cloudflare's structured error code", () => {
  const formatted = "GET /accounts/a/workers/scripts/fixture-10007-brain/secrets failed (404): 10000: route not found";
  assert.equal(isWorkerScriptMissingError(Object.assign(new Error(formatted), {
    status: 404, cloudflareErrorCodes: [10000],
  })), false, "a script name containing 10007 must not make any 404 read as missing");
  assert.equal(isWorkerScriptMissingError(Object.assign(new Error("This Worker does not exist on your account"), {
    status: 404,
  })), false, "message text alone is never proof");
  assert.equal(isWorkerScriptMissingError({ status: 404, cloudflareErrorCodes: [10007] }), true);
  assert.equal(isWorkerScriptMissingError({ status: 503, cloudflareErrorCodes: [10007] }), false);
  assert.equal(isWorkerScriptMissingError({ status: 404, cloudflareErrorCodes: [10007, 10000] }), false);
  assert.equal(isWorkerScriptMissingError({ status: 404, cloudflareErrorCodes: ["10007"] }), false);
});

test("a paged or partial secret-name list is never read as complete", async () => {
  const page = (result_info) => async () => ({
    result: [{ name: "ADMIN_KEY", type: "secret_text" }],
    ...(result_info === undefined ? {} : { result_info }),
  });
  assert.deepEqual(await readWorkerSecretNameInventory("/p", { request: page(undefined) }), ["ADMIN_KEY"]);
  assert.deepEqual(await readWorkerSecretNameInventory("/p", { request: page({ total_count: 1, total_pages: 1 }) }), ["ADMIN_KEY"]);
  await assert.rejects(readWorkerSecretNameInventory("/p", { request: page({ total_count: 5 }) }), /only part/i);
  await assert.rejects(readWorkerSecretNameInventory("/p", { request: page({ total_pages: 2 }) }), /only part/i);
  await assert.rejects(readWorkerSecretNameInventory("/p", { request: page({ total_count: "many" }) }), /only part/i);
  await assert.rejects(readWorkerSecretNameInventory("/p", { request: async () => ({ result: null }) }), /invalid/i);
});

test("the sighting record holds only an identity digest, privately, and is idempotent", () => {
  const directory = join(realpathSync.native(mkdtempSync(join(tmpdir(), "brain-bank-sighting-"))), "sightings");
  try {
    const store = bankWrappingKeySightingStore({ accountId: "fixture-account", scriptName: "fixture-brain", directory });
    assert.equal(store.has(), false);
    assert.equal(store.record(), true);
    assert.equal(store.record(), false, "a second sighting is the same record");
    assert.equal(store.has(), true);
    const text = readFileSync(store.path, "utf8");
    assert.match(text, /^\{"version":1,"identity":"[0-9a-f]{64}"\}\n$/);
    assert.doesNotMatch(text, /fixture-account|fixture-brain|BANK_FEED/);
    if (process.platform !== "win32") {
      assert.equal(statSync(store.path).mode & 0o777, 0o600);
      assert.equal(statSync(directory).mode & 0o777, 0o700);
    }
    const other = bankWrappingKeySightingStore({ accountId: "fixture-account", scriptName: "other-brain", directory });
    assert.equal(other.has(), false, "a sighting belongs to one account and Worker");
    writeFileSync(other.path, "");
    assert.equal(other.has(), true, "a torn record still counts as a sighting");
    assert.throws(() => bankWrappingKeySightingStore({ accountId: " a", scriptName: "b", directory }));
  } finally {
    rmSync(join(directory, ".."), { recursive: true, force: true });
  }
});

for (const beforeUpload of ["unknown", undefined, "garbage"]) {
  test(`list failure before upload (${String(beforeUpload)}) + missing after: never creates`, async () => {
    const fixture = custodyFixture(["missing"]);
    const { error } = await decide(fixture, beforeUpload);
    assert.equal(fixture.puts, 0, "an unproven absence must never create a key");
    assert.equal(fixture.generated, 0);
    assert.deepEqual(fixture.waits, [2_000, 5_000, 10_000]);
    assert.match(error?.message || "", /could not be read before this upload/i);
    assert.match(error?.message || "", INTACT);
  });
}

test("list failure before upload + present after: no PUT", async () => {
  const fixture = custodyFixture(["present"]);
  const { result, error } = await decide(fixture, "unknown");
  assert.equal(error, null);
  assert.equal(result.created, false);
  assert.equal(fixture.puts, 0);
});

test("the pre-upload read reports present, absent, missing-Worker and unknown", async () => {
  const missingWorker = Object.assign(
    new Error("GET /accounts/a/workers/scripts/s/secrets failed (404): 10007: This Worker does not exist on your account."),
    { status: 404 },
  );
  const isWorkerMissing = (error) => error === missingWorker;
  assert.equal(await readBankWrappingKeyBeforeUpload({ listSecretNames: async () => [WRAPPING_NAME] }), "present");
  assert.equal(await readBankWrappingKeyBeforeUpload({ listSecretNames: async () => ["ADMIN_KEY"] }), "absent");
  assert.equal(await readBankWrappingKeyBeforeUpload({
    listSecretNames: async () => { throw missingWorker; },
    isWorkerMissing,
  }), "absent", "a Worker that does not exist yet is a fresh install");
  assert.equal(await readBankWrappingKeyBeforeUpload({
    listSecretNames: async () => { throw new Error("503 service unavailable"); },
    isWorkerMissing,
  }), "unknown");
  assert.equal(await readBankWrappingKeyBeforeUpload({
    listSecretNames: async () => [WRAPPING_NAME.toLowerCase()],
  }), "unknown", "an ambiguous spelling is never read as absent");
  assert.equal(await readBankWrappingKeyBeforeUpload({
    listSecretNames: async () => { throw new Error("boom"); },
    isWorkerMissing: () => { throw new Error("classifier failed"); },
  }), "unknown");
});

// ---------------------------------------------------------------------------
// Integration: the real deploy and update paths against an offline Cloudflare.
// ---------------------------------------------------------------------------

function apiResponse(result, { success = true, status = 200, code = 1000, message = "fixture refusal", resultInfo } = {}) {
  return new Response(JSON.stringify({
    success,
    result: success ? result : null,
    errors: success ? [] : [{ code, message }],
    ...(resultInfo ? { result_info: resultInfo } : {}),
  }), { status, headers: { "content-type": "application/json" } });
}

function manifest({ provider = "plaid", script = "fixture-brain" } = {}) {
  return {
    client: { slug: "fixture", display_name: "Fixture" },
    brain: { worker_name: script, domain: "fixture-brain.example.invalid", version: "0.4.0" },
    infrastructure: {
      cloudflare: {
        account_id: "fixture-account",
        d1_database_id: "fixture-database",
        storage: "d1",
        vectorize_index: "fixture-index",
      },
    },
    retrieval: { answer_model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
    corpora: {
      bank_feed: {
        enabled: true,
        provider,
        environment: provider === "simplefin" ? "production" : "sandbox",
      },
    },
  };
}

/**
 * `listModes[n]` decides what the n-th secret-name GET returns:
 * "real" (the true inventory), "hide" (the true inventory minus the wrapping
 * key: Cloudflare's false-absent read), "empty" (a successful empty list),
 * "partial" (the true inventory minus the key, flagged by result_info as one
 * page of a longer list), "fail" (a 503), "no-worker" (404 10007, the answer
 * for a script that does not exist yet), or "404-other" (a 404 with another
 * code). The last entry repeats.
 *
 * `sealed` is what the Brain's D1 answers to the sealed-reference check: a
 * count, "fail" (an outage), or "no-table" (a database without bank tables).
 * Each harness gets its own sighting directory, standing for one computer.
 */
let harnessCount = 0;
function cloudflareHarness({
  initial = [],
  listModes = ["real"],
  script = "fixture-brain",
  sealed = 0,
  sightingDirectory = null,
} = {}) {
  const secretNames = new Set(initial);
  const sightings = sightingDirectory ?? join(sandbox, "sightings", String(harnessCount++));
  let sealedChecks = 0;
  const calls = [];
  const writtenValues = [];
  let workerUploads = 0;
  let secretLists = 0;
  let secretPuts = 0;
  const fetchImpl = async (input, options = {}) => {
    const path = new URL(String(input)).pathname;
    const method = options.method || "GET";
    if (path === "/client/v4/accounts" && method === "GET") {
      return apiResponse([{ id: "fixture-account", name: "Fixture account" }]);
    }
    if (path.endsWith(`/workers/scripts/${script}`) && method === "PUT") {
      workerUploads++;
      calls.push("worker-upload");
      return apiResponse({});
    }
    if (path.endsWith(`/workers/scripts/${script}/secrets`) && method === "GET") {
      const mode = listModes[Math.min(secretLists, listModes.length - 1)];
      secretLists++;
      calls.push(`secret-list:${mode}`);
      if (mode === "fail") return apiResponse(null, { success: false, status: 503, code: 10013, message: "fixture outage" });
      if (mode === "no-worker") {
        return apiResponse(null, { success: false, status: 404, code: 10007, message: "This Worker does not exist on your account." });
      }
      if (mode === "404-other") {
        return apiResponse(null, { success: false, status: 404, code: 10000, message: "fixture route not found" });
      }
      if (mode === "empty") return apiResponse([]);
      const names = [...secretNames].filter((name) => !["hide", "partial"].includes(mode) || name !== WRAPPING_NAME);
      return apiResponse(names.map((name) => ({ name, type: "secret_text" })), mode === "partial"
        ? { resultInfo: { page: 1, per_page: names.length, count: names.length, total_count: secretNames.size, total_pages: 2 } }
        : {});
    }
    if (path.endsWith(`/workers/scripts/${script}/secrets`) && method === "PUT") {
      secretPuts++;
      const body = JSON.parse(String(options.body || "{}"));
      calls.push(`secret-put:${body.name}`);
      writtenValues.push(body.text);
      secretNames.add(body.name);
      return apiResponse({});
    }
    if (path.endsWith(`/workers/scripts/${script}/subdomain`) && method === "POST") {
      calls.push("route-enable");
      return apiResponse({ enabled: true });
    }
    if (path.endsWith(`/workers/scripts/${script}/schedules`) && method === "GET") {
      return apiResponse([{ cron: "* * * * *" }]);
    }
    if (path.endsWith("/d1/database/fixture-database/query") && method === "POST") {
      sealedChecks++;
      calls.push("sealed-count");
      if (sealed === "fail") return apiResponse(null, { success: false, status: 503, code: 7500, message: "D1 overloaded" });
      if (sealed === "no-table") {
        const sql = JSON.parse(String(options.body || "{}")).sql || "";
        const table = /FROM (\w+)/.exec(sql)?.[1] || "unknown";
        return apiResponse(null, { success: false, status: 400, code: 7500, message: `no such table: ${table}: SQLITE_ERROR` });
      }
      return apiResponse([{ results: [{ sealed }], success: true }]);
    }
    throw new Error(`offline fixture has no response for ${method} ${path}`);
  };
  return {
    fetchImpl,
    calls,
    writtenValues,
    secretNames,
    sightingDirectory: sightings,
    get sealedChecks() { return sealedChecks; },
    get workerUploads() { return workerUploads; },
    get secretLists() { return secretLists; },
    get secretPuts() { return secretPuts; },
  };
}

async function isolatedRuntime(fetchImpl, operation) {
  const priorFetch = globalThis.fetch;
  const priorLog = console.log;
  const priorError = console.error;
  const tracked = ["ADMIN_KEY", "BANK_FEED_CLIENT_ID", "BANK_FEED_SECRET", WRAPPING_NAME, "CLOUDFLARE_API_TOKEN"];
  const priorEnvironment = Object.fromEntries(tracked.map((name) => [name, process.env[name]]));
  const output = [];
  try {
    globalThis.fetch = fetchImpl;
    console.log = (...values) => output.push(values.map(String).join(" "));
    console.error = (...values) => output.push(values.map(String).join(" "));
    for (const name of tracked) delete process.env[name];
    process.env.CLOUDFLARE_API_TOKEN = "fixture-control-token";
    const result = await operation();
    return { result, output: output.join("\n"), error: null };
  } catch (error) {
    return { result: null, output: output.join("\n"), error };
  } finally {
    globalThis.fetch = priorFetch;
    console.log = priorLog;
    console.error = priorError;
    for (const name of tracked) {
      if (priorEnvironment[name] === undefined) delete process.env[name];
      else process.env[name] = priorEnvironment[name];
    }
  }
}

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-bank-key-custody-1116-")));
process.env.HOME = join(sandbox, "home");
mkdirSync(process.env.HOME, { recursive: true });
const writeManifest = (name, value) => {
  const path = join(sandbox, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
};
test.after(() => rmSync(sandbox, { recursive: true, force: true }));

function deployOptions(waits, harness) {
  return {
    nextSteps: false,
    bankWrappingKeySightingDirectory: harness.sightingDirectory,
    generateBankWrappingKey: () => SENTINEL,
    bankWrappingKeySleep: async (ms) => { waits.push(ms); },
  };
}

test("deploy: key present before the upload but hidden after it is never replaced", async () => {
  const harness = cloudflareHarness({ initial: ["ADMIN_KEY", WRAPPING_NAME], listModes: ["real", "hide"] });
  const waits = [];
  const run = await isolatedRuntime(harness.fetchImpl, () =>
    cmdDeploy(writeManifest("deploy-hidden-after.json", manifest()), deployOptions(waits, harness)));
  assert.equal(harness.workerUploads, 1);
  assert.equal(harness.secretPuts, 0, "the existing key must never be PUT");
  assert.deepEqual(waits, [2_000, 5_000, 10_000]);
  assert.equal(harness.secretLists, 5, "before, after, and three confirm re-reads");
  assert.match(run.error?.message || "", NOT_CONFIRMED);
  assert.match(run.error?.message || "", INTACT);
  assert.doesNotMatch(run.output, /created and verified/);
  assert.doesNotMatch(`${run.output}\n${run.error?.message || ""}`, SENTINEL_PATTERN);
});

test("deploy: key present before and listed again on the first re-read succeeds with no PUT", async () => {
  const harness = cloudflareHarness({ initial: ["ADMIN_KEY", WRAPPING_NAME], listModes: ["real", "hide", "real"] });
  const waits = [];
  const run = await isolatedRuntime(harness.fetchImpl, () =>
    cmdDeploy(writeManifest("deploy-hidden-once.json", manifest()), deployOptions(waits, harness)));
  assert.equal(run.error, null, run.error?.message);
  assert.equal(harness.secretPuts, 0);
  assert.deepEqual(waits, [2_000]);
  assert.match(run.output, /already exists on fixture-brain; it was not replaced/);
});

test("deploy: key present before and after reads twice and never waits", async () => {
  const harness = cloudflareHarness({ initial: ["ADMIN_KEY", WRAPPING_NAME] });
  const waits = [];
  const run = await isolatedRuntime(harness.fetchImpl, () =>
    cmdDeploy(writeManifest("deploy-present.json", manifest()), deployOptions(waits, harness)));
  assert.equal(run.error, null, run.error?.message);
  assert.deepEqual(harness.calls.slice(0, 3), ["secret-list:real", "worker-upload", "secret-list:real"]);
  assert.equal(harness.secretPuts, 0);
  assert.deepEqual(waits, []);
});

test("deploy: list failure before the upload with the key absent after it never creates", async () => {
  const harness = cloudflareHarness({ initial: ["ADMIN_KEY"], listModes: ["fail", "real"] });
  const waits = [];
  const run = await isolatedRuntime(harness.fetchImpl, () =>
    cmdDeploy(writeManifest("deploy-prefail.json", manifest()), deployOptions(waits, harness)));
  assert.equal(harness.workerUploads, 1, "an unreadable inventory alone must not block the upload");
  assert.equal(harness.secretPuts, 0, "an unproven absence must never create a key");
  assert.deepEqual(waits, [2_000, 5_000, 10_000]);
  assert.match(run.error?.message || "", /could not be read before this upload/i);
  assert.match(run.error?.message || "", INTACT);

  // The rerun (same computer) reads a clean "absent" before and after, finds
  // nothing sealed in the database, and only then creates.
  const rerun = cloudflareHarness({ initial: ["ADMIN_KEY"], sightingDirectory: harness.sightingDirectory });
  const rerunResult = await isolatedRuntime(rerun.fetchImpl, () =>
    cmdDeploy(writeManifest("deploy-prefail-rerun.json", manifest()), deployOptions([], rerun)));
  assert.equal(rerunResult.error, null, rerunResult.error?.message);
  assert.equal(rerun.secretPuts, 1);
});

test("deploy: a fresh Worker (404 10007 before the upload) creates the key once", async () => {
  const harness = cloudflareHarness({ initial: [], listModes: ["no-worker", "real"] });
  const waits = [];
  const run = await isolatedRuntime(harness.fetchImpl, () =>
    cmdDeploy(writeManifest("deploy-fresh.json", manifest({ provider: "simplefin" })), {
      ...deployOptions(waits, harness),
      readWorkerBankProvider: async () => null,
      prepareBankProviderDeployment: async () => ({ target_provider: "simplefin", transition_ref: null }),
      completeBankProviderDeployment: async () => ({ deployed_provider: "simplefin" }),
    }));
  assert.equal(run.error, null, run.error?.message);
  assert.deepEqual(harness.calls.slice(0, 7), [
    "secret-list:no-worker",
    "worker-upload",
    "secret-list:real",
    "sealed-count",
    "sealed-count",
    `secret-put:${WRAPPING_NAME}`,
    "secret-list:real",
  ]);
  assert.equal(harness.secretPuts, 1);
  assert.equal(harness.writtenValues[0], SENTINEL);
  assert.deepEqual(waits, []);
  assert.doesNotMatch(run.output, SENTINEL_PATTERN);
});

function updateOptions(path, { waits, sandboxName, harness }) {
  const bookmarkWriter = createUpgradeBookmarkWriter();
  let d1Version = null;
  let deployments = 0;
  const options = {
    lifecycleLockOptions: { machineLockRoot: join(sandbox, sandboxName) },
    discoverInstalledManifest: () => ({ path, source: "explicit" }),
    readUpdateBacklog: async () => ({ pending: 0 }),
    adoptCloudflareAuthProfile: async () => {},
    withCloudflareControl: async (action) => action(),
    cmdVerify: async () => {},
    cmdUpgrade: (upgradePath) => cmdUpgrade(upgradePath, {
      saveUpgradeBookmark: bookmarkWriter.saveUpgradeBookmark,
      resolveAccount: async () => ({ id: "fixture-account" }),
      d1Query: async (_account, _database, sql) => {
        if (/sqlite_master/i.test(sql)) return { results: [] };
        if (/UPDATE install_state/i.test(sql)) d1Version = JSON.parse(readFileSync("package.json", "utf8")).version;
        if (/SELECT product_version FROM install_state/i.test(sql)) return { results: [{ product_version: d1Version }] };
        return { results: [] };
      },
      cf: async () => ({ bookmark: "metadata-fixture-bookmark" }),
      cmdMigrate: async () => {},
      cmdBootstrap: async () => ({
        epoch: 1, total: 0, confirmed: 0, remaining: 0, rounds: 1, complete: true, vector_ready: true,
      }),
      cmdDeploy: async (deployPath, upgradeDeployOptions) => {
        deployments++;
        return cmdDeploy(deployPath, {
          ...upgradeDeployOptions,
          nextSteps: false,
          bankWrappingKeySightingDirectory: harness.sightingDirectory,
          generateBankWrappingKey: () => SENTINEL,
          bankWrappingKeySleep: async (ms) => { waits.push(ms); },
        });
      },
      reconcileWorkerProviderSecrets: async () => {},
      cmdDrain: async () => {},
      cmdHealth: async () => {},
      cmdTest: async () => {},
      readUpdateBacklog: async () => ({ pending: 0 }),
      waitForVectorDrainQuiescence: async () => {},
    }),
    reconcileExistingOwnerAgents: null,
    writeClaudeWorkspaceGuideAfterUpdate: null,
    installTechnicianSkills: () => [{ root: ".codex", status: "verified" }],
    reportSkillRefreshOk: () => {},
    reportSkillRefreshWarning: () => {},
  };
  return { options, get deployments() { return deployments; } };
}

test("founder sequence: paused upload sees the key, active upload's read misses it -> update stops, key untouched", async () => {
  // Reads: paused before (real), paused after (real), active before (real),
  // active after (hide), then every confirm re-read hides it too.
  const harness = cloudflareHarness({
    initial: ["ADMIN_KEY", "RAG_PROXY_KEY", "SESSION_SIGNING_KEY", "BANK_FEED_CLIENT_ID", "BANK_FEED_SECRET", WRAPPING_NAME],
    listModes: ["real", "real", "real", "hide"],
  });
  const waits = [];
  const path = writeManifest("update-founder.json", manifest());
  const update = updateOptions(path, { waits, sandboxName: "locks-founder", harness });
  const run = await isolatedRuntime(harness.fetchImpl, () => cmdUpdate(path, update.options));

  assert.equal(update.deployments, 2, "the update must reach the paused and the active upload");
  assert.equal(harness.workerUploads, 2);
  assert.equal(harness.secretPuts, 0, "the founder's existing key must never be replaced");
  assert.deepEqual(harness.writtenValues, []);
  assert.deepEqual(waits, [2_000, 5_000, 10_000]);
  assert.ok(run.error, "the update must stop instead of creating a replacement key");
  assert.match(String(run.error?.message || ""), NOT_CONFIRMED);
  assert.match(String(run.error?.message || ""), INTACT);
  assert.doesNotMatch(run.output, /created and verified/);
  assert.doesNotMatch(`${run.output}\n${run.error?.message || ""}`, SENTINEL_PATTERN);
});

test("founder sequence: the active read misses once, the first re-read lists it -> update completes, no PUT", async () => {
  const harness = cloudflareHarness({
    initial: ["ADMIN_KEY", WRAPPING_NAME],
    listModes: ["real", "real", "real", "hide", "real"],
  });
  const waits = [];
  const path = writeManifest("update-founder-recovers.json", manifest());
  const update = updateOptions(path, { waits, sandboxName: "locks-founder-recovers", harness });
  const run = await isolatedRuntime(harness.fetchImpl, () => cmdUpdate(path, update.options));

  assert.equal(run.error, null, run.error?.message);
  assert.equal(update.deployments, 2);
  assert.equal(harness.secretPuts, 0);
  assert.deepEqual(waits, [2_000]);
});

test("founder sequence, double fault: a key seen by the paused upload is never created by the active one", async () => {
  // Every read after the paused upload's own confirmation hides the key,
  // including the active upload's pre-upload read. Only the run memory of the
  // earlier sighting stops a create here.
  const harness = cloudflareHarness({
    initial: ["ADMIN_KEY", WRAPPING_NAME],
    listModes: ["real", "real", "hide"],
  });
  const waits = [];
  const path = writeManifest("update-founder-double.json", manifest());
  const update = updateOptions(path, { waits, sandboxName: "locks-founder-double", harness });
  const run = await isolatedRuntime(harness.fetchImpl, () => cmdUpdate(path, update.options));

  assert.equal(update.deployments, 2);
  assert.equal(harness.secretPuts, 0, "a key seen earlier in the same update must never be created again");
  assert.deepEqual(waits, [2_000, 5_000, 10_000]);
  assert.match(String(run.error?.message || ""), NOT_CONFIRMED);
});

test("update on a Brain that never had a key creates it once and the active upload reuses it", async () => {
  const harness = cloudflareHarness({ initial: ["ADMIN_KEY"] });
  const waits = [];
  const path = writeManifest("update-first-key.json", manifest());
  const update = updateOptions(path, { waits, sandboxName: "locks-first-key", harness });
  const run = await isolatedRuntime(harness.fetchImpl, () => cmdUpdate(path, update.options));

  assert.equal(run.error, null, run.error?.message);
  assert.equal(harness.secretPuts, 1);
  assert.equal(harness.secretLists, 5, "paused: before, after, verify; active: before, after");
  assert.deepEqual(waits, []);
  assert.doesNotMatch(run.output, SENTINEL_PATTERN);
});

// ---------------------------------------------------------------------------
// Review round: two false-absent reads in a process with no memory of the key.
// ---------------------------------------------------------------------------

const FOUNDER_NAMES = ["ADMIN_KEY", "RAG_PROXY_KEY", "SESSION_SIGNING_KEY", "BANK_FEED_CLIENT_ID", "BANK_FEED_SECRET", WRAPPING_NAME];

test("new process, both reads hide the key, the database holds a sealed connection: deploy never PUTs", async () => {
  const harness = cloudflareHarness({ initial: FOUNDER_NAMES, listModes: ["hide"], sealed: 1 });
  const waits = [];
  const run = await isolatedRuntime(harness.fetchImpl, () =>
    cmdDeploy(writeManifest("review-both-hide.json", manifest()), deployOptions(waits, harness)));
  assert.equal(harness.workerUploads, 1);
  assert.equal(harness.sealedChecks, BANK_SEALED_REFERENCE_CHECKS.length, "the database decision point must be reached");
  assert.equal(harness.secretPuts, 0, "two false-absent reads must never replace a key that sealed a connection");
  assert.deepEqual(harness.writtenValues, []);
  assert.match(run.error?.message || "", SEALED);
  assert.match(run.error?.message || "", INTACT);
  assert.doesNotMatch(`${run.output}\n${run.error?.message || ""}`, SENTINEL_PATTERN);
});

test("new process, an EMPTY list before the upload and the key hidden after: deploy never PUTs", async () => {
  const harness = cloudflareHarness({ initial: FOUNDER_NAMES, listModes: ["empty", "hide"], sealed: 1 });
  const run = await isolatedRuntime(harness.fetchImpl, () =>
    cmdDeploy(writeManifest("review-empty-list.json", manifest()), deployOptions([], harness)));
  assert.equal(harness.sealedChecks, BANK_SEALED_REFERENCE_CHECKS.length);
  assert.equal(harness.secretPuts, 0, "a successful empty list is not proof the key is absent");
  assert.match(run.error?.message || "", SEALED);
});

test("new process, both reads hide the key and the database cannot be read: deploy never PUTs", async () => {
  const harness = cloudflareHarness({ initial: FOUNDER_NAMES, listModes: ["hide"], sealed: "fail" });
  const run = await isolatedRuntime(harness.fetchImpl, () =>
    cmdDeploy(writeManifest("review-db-fail.json", manifest()), deployOptions([], harness)));
  assert.equal(harness.sealedChecks, 1);
  assert.equal(harness.secretPuts, 0, "an unreadable database is never proof that nothing is sealed");
  assert.match(run.error?.message || "", SEALED_UNKNOWN);
});

test("first (paused) upload of an update in a new process: both reads hide the key -> update stops, no PUT", async () => {
  const harness = cloudflareHarness({ initial: FOUNDER_NAMES, listModes: ["hide"], sealed: 1 });
  const waits = [];
  const path = writeManifest("review-update-paused.json", manifest());
  const update = updateOptions(path, { waits, sandboxName: "locks-review-paused", harness });
  const run = await isolatedRuntime(harness.fetchImpl, () => cmdUpdate(path, update.options));
  assert.equal(update.deployments, 1, "the update must stop at its paused upload");
  assert.equal(harness.secretPuts, 0);
  assert.match(String(run.error?.message || ""), SEALED);
});

test("rerun after the stop: the earlier run's sighting blocks a create even when every read hides the key and D1 reads zero", async () => {
  // Run 1: the founder sequence. The paused upload lists the key, so this
  // computer records the sighting; the active upload's reads hide it and the
  // update stops.
  const first = cloudflareHarness({ initial: FOUNDER_NAMES, listModes: ["real", "real", "real", "hide"] });
  const path = writeManifest("review-rerun.json", manifest());
  const firstRun = await isolatedRuntime(first.fetchImpl, () =>
    cmdUpdate(path, updateOptions(path, { waits: [], sandboxName: "locks-review-rerun-1", harness: first }).options));
  assert.match(String(firstRun.error?.message || ""), NOT_CONFIRMED);
  assert.equal(first.secretPuts, 0);
  const recorded = readdirSync(first.sightingDirectory);
  assert.equal(recorded.length, 1, "the sighting must be on disk, not only in the stopped process");

  // Run 2: a new process on the same computer. Worst case: every read hides
  // the key and the database check (wrongly) reads zero.
  const rerun = cloudflareHarness({
    initial: FOUNDER_NAMES, listModes: ["hide"], sealed: 0, sightingDirectory: first.sightingDirectory,
  });
  const waits = [];
  const rerunResult = await isolatedRuntime(rerun.fetchImpl, () =>
    cmdDeploy(path, deployOptions(waits, rerun)));
  assert.equal(rerun.secretPuts, 0, "a key a previous run saw must never be created by a later one");
  assert.equal(rerun.sealedChecks, 0, "a recorded sighting never reaches the create branch");
  assert.deepEqual(waits, [2_000, 5_000, 10_000]);
  assert.match(rerunResult.error?.message || "", RECORDED);
  assert.match(rerunResult.error?.message || "", INTACT);
  for (const file of recorded) {
    assert.doesNotMatch(readFileSync(join(first.sightingDirectory, file), "utf8"), SENTINEL_PATTERN);
  }
});

test("a fresh install where a deleted Worker was once seen: 404 10007 ignores the old sighting and creates once", async () => {
  const harness = cloudflareHarness({ initial: [], listModes: ["no-worker", "real"] });
  bankWrappingKeySightingStore({
    accountId: "fixture-account", scriptName: "fixture-brain", directory: harness.sightingDirectory,
  }).record();
  const run = await isolatedRuntime(harness.fetchImpl, () =>
    cmdDeploy(writeManifest("review-fresh-stale-sighting.json", manifest()), deployOptions([], harness)));
  assert.equal(run.error, null, run.error?.message);
  assert.equal(harness.sealedChecks, BANK_SEALED_REFERENCE_CHECKS.length, "the database still proves nothing is sealed");
  assert.equal(harness.secretPuts, 1);
});

test("a database without bank tables reads as nothing sealed and a fresh key is created once", async () => {
  const harness = cloudflareHarness({ initial: ["ADMIN_KEY"], sealed: "no-table" });
  const run = await isolatedRuntime(harness.fetchImpl, () =>
    cmdDeploy(writeManifest("review-no-table.json", manifest()), deployOptions([], harness)));
  assert.equal(run.error, null, run.error?.message);
  assert.equal(harness.sealedChecks, BANK_SEALED_REFERENCE_CHECKS.length);
  assert.equal(harness.secretPuts, 1);
});

test("a Worker named with 10007 and any other 404 before the upload is unknown, never absent", async () => {
  const script = "fixture-10007-brain";
  const harness = cloudflareHarness({ initial: ["ADMIN_KEY"], listModes: ["404-other", "real"], script });
  const waits = [];
  const run = await isolatedRuntime(harness.fetchImpl, () =>
    cmdDeploy(writeManifest("review-10007-name.json", manifest({ script })), deployOptions(waits, harness)));
  assert.equal(harness.workerUploads, 1);
  assert.equal(harness.secretPuts, 0, "a 404 whose message happens to contain 10007 must not create a key");
  assert.equal(harness.sealedChecks, 0);
  assert.deepEqual(waits, [2_000, 5_000, 10_000]);
  assert.match(run.error?.message || "", /could not be read before this upload/i);
});

test("a secret list flagged as one page of a longer list is never read as absent", async () => {
  const harness = cloudflareHarness({ initial: FOUNDER_NAMES, listModes: ["partial"] });
  const run = await isolatedRuntime(harness.fetchImpl, () =>
    cmdDeploy(writeManifest("review-partial.json", manifest()), deployOptions([], harness)));
  assert.equal(harness.workerUploads, 1);
  assert.equal(harness.secretPuts, 0, "a partial page must never create a key");
  assert.equal(harness.sealedChecks, 0);
  assert.match(run.error?.message || "", /secret names could not be checked/i);
});
