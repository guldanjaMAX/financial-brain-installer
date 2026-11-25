/**
 * A real Windows install hit `brain setup` step 3 of 6 after it had ALREADY
 * created D1, a Vectorize index, applied every migration, uploaded the
 * Worker, and enabled the workers.dev route. The last thing step 3 does is
 * read the account's workers.dev subdomain so it can save a token-free URL,
 * and on the browser-sign-in path that read can answer 401/403 (or find no
 * credential at all) while every call around it succeeds. Before this fix,
 * persistWorkersDevDomain died unconditionally on that read failing, which
 * left the owner holding billable, already-created resources with no address
 * for them and a message that pointed at a Cloudflare setting rather than the
 * actual denial.
 *
 * cmdDeploy is the exact function that failed (it is the last thing setup's
 * step 3 runs), so these exercise it directly rather than the full six-step
 * `brain setup` orchestration, which has its own dedicated test files for its
 * D1/Vectorize/migration machinery. Nothing here touches a network: every
 * Cloudflare and Worker call is answered by an injected fetch.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cmdDeploy,
  cmdProvision,
  cmdSetup,
  buildSetupManifest,
  probeExistingWorkerHealth,
  probeExistingWorkerDrainMode,
  workerBindings,
  commandPath,
  displayPathForTesting,
  persistWorkersDevDomain,
  renderCliCommands,
  withCloudflareControlCredential,
} from "../brain.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

const ACCOUNT_ID = "a".repeat(32);
const AUTH_PROFILE = `financial-brain-${"b".repeat(24)}`;
const SLUG = "acme";
const SCRIPT_NAME = "acme-brain";
const ACCOUNT_DISPLAY_NAME = "display-fixture";
const SUBDOMAIN_LABEL = "exact-fixture-subdomain";
const CANDIDATE_DOMAIN = `${SCRIPT_NAME}.${SUBDOMAIN_LABEL}.workers.dev`;
const DISPLAY_NAME_DOMAIN = `${SCRIPT_NAME}.${ACCOUNT_DISPLAY_NAME}.workers.dev`;

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-setup-403-")));
after(() => rmSync(sandbox, { recursive: true, force: true }));

let manifestCounter = 0;
function writeManifest() {
  const path = join(sandbox, `fixture-${manifestCounter++}.manifest.json`);
  const value = {
    client: { slug: SLUG, display_name: "Acme" },
    brain: { worker_name: SCRIPT_NAME },
    infrastructure: {
      cloudflare: {
        account_id: ACCOUNT_ID,
        d1_database_id: "db-403-fixture",
        storage: "d1",
        vectorize_index: SCRIPT_NAME,
        drain_cron: "* * * * *",
      },
    },
  };
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function apiResponse(result, { success = true, status = 200, code = 1000, message = "fixture denial" } = {}) {
  return new Response(JSON.stringify({
    success,
    result: success ? result : null,
    errors: success ? [] : [{ code, message }],
  }), { status, headers: { "content-type": "application/json" } });
}

function healthResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * Every Cloudflare and Worker call cmdDeploy's fresh-install path actually
 * makes, for one D1-storage manifest naming `SCRIPT_NAME`. `subdomainRead`
 * selects the account-level `/workers/subdomain` GET's outcome (the exact
 * call the field report's 403 came from); `health` selects what the resulting
 * candidate's `/health` answers. Anything not modeled throws, so a call this
 * fix does not expect is loud rather than silently unanswered.
 */
function harness({ subdomainRead, health = null, initialSchedules = [], scheduleInventory = "ok" }) {
  const calls = [];
  const healthHosts = [];
  let schedules = initialSchedules.map(cron => ({ cron }));
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init.method || "GET";
    calls.push(`${method} ${path}`);
    if (path === "/client/v4/accounts" && method === "GET") {
      return apiResponse([{ id: ACCOUNT_ID, name: ACCOUNT_DISPLAY_NAME }]);
    }
    if (path.endsWith(`/workers/scripts/${SCRIPT_NAME}`) && method === "PUT") {
      return apiResponse({});
    }
    if (path.endsWith(`/workers/scripts/${SCRIPT_NAME}/subdomain`) && method === "POST") {
      return apiResponse({ enabled: true });
    }
    if (path === `/client/v4/accounts/${ACCOUNT_ID}/workers/subdomain` && method === "GET") {
      return subdomainRead === "denied"
        ? apiResponse(null, { success: false, status: 403, code: 10000, message: "Authentication error" })
        : apiResponse({ subdomain: SUBDOMAIN_LABEL });
    }
    if (path.endsWith(`/workers/scripts/${SCRIPT_NAME}/schedules`) && method === "GET") {
      if (scheduleInventory === "unreadable") {
        return apiResponse(null, { success: false, status: 403 });
      }
      return apiResponse(schedules);
    }
    if (path.endsWith(`/workers/scripts/${SCRIPT_NAME}/schedules`) && method === "PUT") {
      if (scheduleInventory !== "lost-write") schedules = JSON.parse(init.body);
      return apiResponse([]);
    }
    if (path === "/health") {
      healthHosts.push(url.hostname);
      if (Array.isArray(health)) {
        // A scripted route: each probe consumes the next answer, and the last
        // one repeats, so "permanent" outcomes need only one entry.
        const step = health[Math.min(healthHosts.length - 1, health.length - 1)];
        if (step === "fetch-error") throw new Error("fetch failed: connection reset (fixture)");
        if (step === "healthy") return healthResponse({ brain: SLUG, version: VERSION });
        if (step === "stale") return healthResponse({ brain: SLUG, version: "0.0.1" });
        if (step === "wrong-brain") return healthResponse({ brain: "someone-else", version: VERSION });
        return healthResponse({ error: "fixture" }, { status: step });
      }
      if (health === "healthy") return healthResponse({ brain: SLUG, version: VERSION });
      if (health === "wrong-brain") return healthResponse({ brain: "someone-else", version: VERSION });
      if (health === "down") throw new Error("fetch failed: connection refused (fixture)");
      throw new Error("this scenario must never probe /health");
    }
    throw new Error(`offline fixture has no response for ${method} ${path}`);
  };
  return { fetchImpl, calls, healthHosts, schedules: () => schedules.map(row => row.cron) };
}

for (const arm of ["fresh", "existing", "unreadable", "lost-write"]) {
  test(`deploy schedule inventory and exact readback: ${arm}`, async () => {
    const h = harness({ subdomainRead: "ok", health: "healthy",
      initialSchedules: arm === "fresh" ? [] : ["7 6 * * *"],
      scheduleInventory: arm,
    });
    const run = () => withFixture(h.fetchImpl, () => cmdDeploy(writeManifest()));
    if (arm === "unreadable") await assert.rejects(run, /schedule inventory could not be verified/);
    else if (arm === "lost-write") await assert.rejects(run, /required schedules did not read back/);
    else await run();
    assert.ok(h.calls.some(call => call === `PUT /client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}`),
      "all arms reached the actual Worker upload");
    const scheduleCalls = h.calls.filter(call => call.endsWith("/schedules"));
    assert.deepEqual(scheduleCalls.map(call => call.split(" ")[0]),
      arm === "unreadable" ? ["GET"] : ["GET", "PUT", "GET"],
      "unknown inventory refuses before replacement; every write needs exact readback");
    assert.deepEqual(h.schedules(), arm === "fresh" ? ["* * * * *"]
      : arm === "existing" ? ["7 6 * * *", "* * * * *"] : ["7 6 * * *"]);
  });
}

let namedProfileTokenReReads = 0;

async function withFixture(fetchImpl, run, { workersSubdomain = SUBDOMAIN_LABEL } = {}) {
  namedProfileTokenReReads = 0;
  const priorFetch = globalThis.fetch;
  const priorToken = process.env.CLOUDFLARE_API_TOKEN;
  try {
    globalThis.fetch = fetchImpl;
    delete process.env.CLOUDFLARE_API_TOKEN;
    return await withCloudflareControlCredential(run, {
      accountId: ACCOUNT_ID,
      authProfile: AUTH_PROFILE,
      interactive: false,
      allowBrowserReauth: false,
      allowTokenRecovery: false,
      // A rejected named-profile request tries one token re-read. The fixture
      // answers it offline as unavailable instead of spawning Wrangler.
      oauthOptions: {
        processRunner: () => {
          namedProfileTokenReReads += 1;
          return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        },
      },
      withOAuthSession: async ({ action }) => action({
        token: Buffer.from("named-profile-fixture-token"),
        profile: AUTH_PROFILE,
        account: { id: ACCOUNT_ID, name: ACCOUNT_DISPLAY_NAME },
        preflight: {
          status: "ready",
          account: { id: ACCOUNT_ID, name: ACCOUNT_DISPLAY_NAME },
          checks: ["account", "workers", "workers_subdomain", "d1", "vectorize", "workers_ai"],
          ...(workersSubdomain ? { workersSubdomain } : {}),
        },
      }),
    });
  } finally {
    globalThis.fetch = priorFetch;
    if (priorToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = priorToken;
  }
}

function writeProvisionRecoveryManifest(label) {
  const path = join(sandbox, `provision-${label}-${manifestCounter++}.manifest.json`);
  writeFileSync(path, JSON.stringify({
    client: { slug: "fixture", display_name: "Fixture Owner" },
    brain: { worker_name: "fixture-brain" },
    infrastructure: {
      cloudflare: {
        account_id: ACCOUNT_ID,
        auth_profile: AUTH_PROFILE,
        d1_database_name: "fixture-brain",
        storage: "d1",
        vectorize_index: "fixture-403-index",
        drain_cron: "* * * * *",
      },
    },
    safety: { ocr: { enabled: false } },
    sources: [],
    testing: { probe_questions: [] },
  }));
  return path;
}

async function runProvisionRecoveryScenario(mode, { platform = "darwin" } = {}) {
  const manifestPath = writeProvisionRecoveryManifest(mode);
  const calls = [];
  const metadata = new Map();
  let databaseCreated = false;
  let indexCreated = false;
  let refusalIssued = false;
  let verifyCalls = 0;
  let storedLoads = 0;
  const wranglerCalls = [];
  const prompts = [];
  const oauthToken = "o".repeat(40);
  const recoveryToken = "t".repeat(40);
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init.method || "GET";
    const authorization = String(init.headers?.Authorization || init.headers?.authorization || "");
    const recovery = authorization.includes(recoveryToken);
    calls.push({ method, path, recovery });

    if (path === "/client/v4/accounts" && method === "GET") {
      return apiResponse([{ id: ACCOUNT_ID, name: "Fixture Account" }]);
    }
    if (path === `/client/v4/accounts/${ACCOUNT_ID}/d1/database` && method === "GET") {
      return apiResponse(databaseCreated ? [{ name: "fixture-brain", uuid: "fixture-database" }] : []);
    }
    if (path === `/client/v4/accounts/${ACCOUNT_ID}/d1/database` && method === "POST") {
      databaseCreated = true;
      return apiResponse({ name: "fixture-brain", uuid: "fixture-database" });
    }
    if (path === `/client/v4/accounts/${ACCOUNT_ID}/d1/database/fixture-database/query` && method === "POST") {
      return apiResponse({ results: [] });
    }
    if (path === `/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes` && method === "GET") {
      if (["wrangler-create-refusal", "wrangler-metadata-refusal"].includes(mode)) {
        return apiResponse(null, { success: false, status: 500, code: 1000, message: "fixture API fallback" });
      }
      return apiResponse(indexCreated ? [{ name: "fixture-403-index", config: { dimensions: 768, metric: "cosine" } }] : []);
    }
    if (path === `/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes` && method === "POST") {
      if (!recovery && !refusalIssued && ["server", "network", "already-exists", "forbidden-no-code", "recovery-refusal"].includes(mode)) {
        refusalIssued = true;
        if (mode === "network") throw new Error("network unavailable for fixture-403-index");
        if (mode === "server") {
          return apiResponse(null, { success: false, status: 500, code: 1000, message: "fixture-403-index temporary failure" });
        }
        if (mode === "already-exists") {
          return apiResponse(null, { success: false, status: 409, code: 1000, message: "fixture-403-index already exists" });
        }
        if (mode === "forbidden-no-code") {
          return apiResponse(null, { success: false, status: 403, code: 1000, message: "fixture permission refusal" });
        }
        return apiResponse(null, { success: false, status: 403, code: 10000, message: "Authentication error" });
      }
      if (mode === "recovery-refusal" && recovery) {
        return apiResponse(null, { success: false, status: 403, code: 10000, message: "Authentication error" });
      }
      indexCreated = true;
      return apiResponse({ name: "fixture-403-index" });
    }
    const metadataList = new RegExp(`/vectorize/v2/indexes/fixture-403-index/metadata_index/list$`).test(path);
    if (metadataList && method === "GET") {
      if (mode === "metadata-list-refusal" && !recovery && !refusalIssued) {
        refusalIssued = true;
        return apiResponse(null, { success: false, status: 403, code: 10000, message: "Authentication error" });
      }
      return apiResponse({
        metadataIndexes: [...metadata].map(([propertyName, indexType]) => ({ propertyName, indexType })),
      });
    }
    const metadataCreate = new RegExp(`/vectorize/v2/indexes/fixture-403-index/metadata_index/create$`).test(path);
    if (metadataCreate && method === "POST") {
      const body = JSON.parse(String(init.body || "{}"));
      metadata.set(body.propertyName, body.indexType);
      return apiResponse({ mutationId: `fixture-${body.propertyName}` });
    }
    throw new Error(`offline provision fixture has no response for ${method} ${path}`);
  };

  const priorFetch = globalThis.fetch;
  const priorLog = console.log;
  const priorError = console.error;
  const longWranglerRefusal =
    `${"fixture diagnostic ".repeat(12)}A request to the Cloudflare API failed. ` +
    "Vectorize permission was refused [code: 10000]";
  const wranglerCommand = (args) => {
    wranglerCalls.push([...args]);
    if (mode === "wrangler-metadata-refusal" && args.includes("list-metadata-index")) {
      return { ok: true, out: "[]", stdout: "[]", stderr: "" };
    }
    if (mode === "wrangler-metadata-refusal" && args.includes("create-metadata-index")) {
      return { ok: false, out: longWranglerRefusal, stdout: "", stderr: longWranglerRefusal };
    }
    if (args.includes("create")) {
      return mode === "wrangler-create-refusal"
        ? { ok: false, out: longWranglerRefusal, stdout: "", stderr: longWranglerRefusal }
        : { ok: true, out: "", stdout: "", stderr: "" };
    }
    return { ok: true, out: "", stdout: "", stderr: "" };
  };
  let outcome;
  try {
    globalThis.fetch = fetchImpl;
    console.log = () => {};
    console.error = () => {};
    outcome = await withCloudflareControlCredential(() => cmdSetup(manifestPath, {
      flags: { "no-connect": true },
      preflightChecks: [],
      ask: async () => "",
      configureStandardAdminKeyStorage: () => ({ changed: false }),
      prepareSetupAdminKey: async () => ({ source: "durable", value: "fixture-admin-key" }),
      cmdVerify: async () => { verifyCalls += 1; },
      ...(["wrangler-create-refusal", "wrangler-metadata-refusal"].includes(mode) ? {
        cmdProvision: (path, options) => cmdProvision(path, { ...options, wranglerCommand }),
      } : {}),
      cmdMigrate: async () => {},
      cmdDeploy: async () => {},
      setupWorkerScriptExists: async () => false,
      cmdSecrets: async () => {},
      cmdDrain: async () => {},
      cmdHealth: async () => {},
      rememberInstalledManifest: () => {},
      backlogCount: async () => 0,
      connectAgents: false,
    }), {
      manifestPath,
      accountId: ACCOUNT_ID,
      authProfile: AUTH_PROFILE,
      interactive: true,
      allowBrowserReauth: true,
      allowTokenRecovery: true,
      // The recovery offer and the saved recovery token below are the macOS
      // lane. The win32 rule they stand for is proved by "on win32 a mid-setup
      // search-index refusal keeps its real refusal and offers no recovery".
      platform,
      resumeCommand: `brain setup ${commandPath(manifestPath)}`,
      recoveryCommand: `brain setup ${commandPath(manifestPath)} --cloudflare-token`,
      askFn: async (question) => { prompts.push(question); return "y"; },
      loadStoredCloudflareToken: () => { storedLoads += 1; return Buffer.from(recoveryToken); },
      storedTokenReference: () => "fixture protected store",
      oauthOptions: {
        processRunner: () => ({
          status: 0,
          signal: null,
          error: null,
          stdout: Buffer.from(JSON.stringify({ type: "oauth", token: oauthToken })),
          stderr: Buffer.alloc(0),
        }),
      },
      withOAuthSession: async (request) => request.action({
        token: Buffer.from(oauthToken),
        profile: AUTH_PROFILE,
        account: { id: ACCOUNT_ID, name: "Fixture Account" },
        preflight: { status: "ready", checks: ["account", "workers", "d1", "vectorize", "workers_ai"] },
      }),
    }).then((value) => ({ value }), (error) => ({ error }));
  } finally {
    globalThis.fetch = priorFetch;
    console.log = priorLog;
    console.error = priorError;
  }
  return {
    ...outcome,
    manifestPath,
    calls,
    databaseCreated,
    indexCreated,
    metadata,
    verifyCalls,
    storedLoads,
    prompts,
    wranglerCalls,
    longWranglerRefusal,
  };
}

test("setup recovers a real metadata-list refusal and adopts the D1 it already created", async () => {
  const run = await runProvisionRecoveryScenario("metadata-list-refusal");
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.verifyCalls, 2, "both the refused setup and its approved recovery rerun must reach verification");
  assert.equal(run.storedLoads, 1, "the recovery credential decision point must be reached once");
  assert.equal(run.prompts.length, 2, "the recovery offer and saved credential each require approval");
  assert.equal(run.calls.filter((call) => call.method === "POST" && call.path.endsWith("/d1/database")).length, 1,
    "the rerun must adopt the first D1 instead of creating another");
  assert.ok(run.calls.some((call) => call.recovery && call.path.endsWith("/d1/database/fixture-database/query")),
    "the recovery rerun must reach the D1 adoption proof");
  assert.equal(run.metadata.size, 6, "all search filters must be active after the recovery rerun");
  const saved = JSON.parse(readFileSync(run.manifestPath, "utf8"));
  assert.equal(saved.infrastructure.cloudflare.d1_database_id, "fixture-database");
  assert.equal(saved.infrastructure.cloudflare.vectorize_index, "fixture-403-index");
});

test("on win32 a mid-setup search-index refusal keeps its real refusal and offers no recovery", async () => {
  const run = await runProvisionRecoveryScenario("metadata-list-refusal", { platform: "win32" });
  assert.ok(run.error, "win32 must fail closed instead of entering the recovery lane");
  assert.equal(run.verifyCalls, 1, "the refused setup must reach the real provision path exactly once");
  assert.ok(run.calls.some((call) => !call.recovery && call.path.endsWith("/metadata_index/list")),
    "the browser sign-in refusal decision point must be reached");
  assert.equal(run.storedLoads, 0, "win32 must not load a saved recovery token");
  assert.deepEqual(run.prompts, [], "win32 must not offer a recovery its hidden prompt would refuse");
  assert.equal(run.calls.filter((call) => call.recovery).length, 0, "no recovery credential may reach Cloudflare");
  assert.equal(run.calls.filter((call) => call.method === "POST" && call.path.endsWith("/d1/database")).length, 1,
    "the D1 created before the refusal must be the only one");
  assert.equal(run.error?.code, "REMOTE_PERMISSION_DENIED", run.error?.message);
  assert.match(run.error.message, /cannot request the Vectorize permission this install requires/);
  assert.match(run.error.message, /Workers Scripts Edit[\s\S]*D1 Edit[\s\S]*Vectorize Edit[\s\S]*Workers AI Read/i);
  assert.doesNotMatch(run.error.message, /Nothing was changed/, "setup made progress, so it must not claim otherwise");
  assert.match(run.error.message,
    /Windows has no saved Cloudflare-token recovery or supported hidden token entry in this release\. Stop here and ask the technician for an approved recovery plan; this command will not ask you to type a key\./);
  assert.doesNotMatch(run.error.message, /--cloudflare-token|recovery API token|saved Cloudflare key/,
    "Windows must not be offered a token route it refuses");
  assert.match(run.error.message, /Issue: CLOUDFLARE_OAUTH_SCOPE_MISSING\./);
  assert.doesNotMatch(run.error.message, /opens the protected recovery flow/,
    "Windows must not be sent to a recovery switch whose hidden prompt it refuses");
});

for (const mode of ["server", "network", "already-exists", "forbidden-no-code"]) {
  test(`setup does not convert a ${mode} Vectorize failure into credential recovery`, async () => {
    const run = await runProvisionRecoveryScenario(mode);
    assert.ok(run.error, "the control failure must remain a failure");
    assert.equal(run.verifyCalls, 1, "the setup action must reach the real provision path once");
    assert.equal(run.storedLoads, 0, "the recovery credential path must not run");
    assert.deepEqual(run.prompts, [], "the owner must not receive a credential offer for this failure");
  });
}

test("a scope refusal on the recovery token is not converted into another recovery", async () => {
  const run = await runProvisionRecoveryScenario("recovery-refusal");
  assert.ok(run.error, "the second credential refusal must remain a failure");
  assert.equal(run.verifyCalls, 2, "the original and recovery actions must each reach real provision once");
  assert.equal(run.storedLoads, 1, "only one recovery credential decision is allowed");
  assert.equal(run.prompts.length, 2, "only the initial recovery offer and saved-token approval may be asked");
  assert.equal(run.error?.constructor?.name, "Fatal",
    "the recovery token's own refusal must keep the provision failure type");
  assert.match(run.error?.message || "", /Vectorize could not be provisioned/i);
  assert.doesNotMatch(run.error?.message || "", /browser sign-in was refused/i,
    "a recovery-token refusal must not be relabeled as a browser-session refusal");
});

test("a failed Wrangler index create keeps Cloudflare's complete refusal", async () => {
  const run = await runProvisionRecoveryScenario("wrangler-create-refusal");
  assert.ok(run.error, "the injected Wrangler create refusal must remain a failure");
  assert.ok(run.wranglerCalls.some((args) => args.includes("create")),
    "the real Wrangler create decision point must be reached");
  assert.ok((run.error?.message || "").includes(run.longWranglerRefusal),
    "the owner must receive the complete Wrangler and Cloudflare refusal");
  assert.match(run.error?.message || "", /code: 10000/i);
});

test("a failed Wrangler search-filter create keeps Cloudflare's final reason", async () => {
  const run = await runProvisionRecoveryScenario("wrangler-metadata-refusal");
  assert.ok(run.error, "the injected Wrangler search-filter refusal must remain a failure");
  assert.ok(run.wranglerCalls.some((args) => args.includes("create-metadata-index")),
    "the real Wrangler search-filter create decision point must be reached");
  assert.match(run.error?.message || "", /code: 10000/i,
    "the final Cloudflare reason must survive owner-facing truncation");
});

test("the named-profile lane probes and persists only the exact preflight subdomain", async () => {
  const target = writeManifest();
  const { fetchImpl, calls, healthHosts } = harness({ subdomainRead: "denied", health: "healthy" });
  await withFixture(fetchImpl, () => cmdDeploy(target, { wait: async () => {} }));
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.brain?.domain, CANDIDATE_DOMAIN);
  assert.deepEqual(healthHosts, [CANDIDATE_DOMAIN],
    "only the hostname derived from the authenticated preflight subdomain may be probed");
  assert.ok(!healthHosts.includes(DISPLAY_NAME_DOMAIN),
    "the account display name must never become a workers.dev hostname");
  assert.ok(!calls.includes(`GET /client/v4/accounts/${ACCOUNT_ID}/workers/subdomain`),
    "the carried authenticated receipt must avoid a second control-plane read");
});

test("a lane without a preflight receipt reads, probes, and persists the exact fallback subdomain", async () => {
  const target = writeManifest();
  const { fetchImpl, calls, healthHosts } = harness({ subdomainRead: "ok", health: "healthy" });
  await withFixture(fetchImpl, () => cmdDeploy(target, { wait: async () => {} }), {
    workersSubdomain: null,
  });
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.brain?.domain, CANDIDATE_DOMAIN);
  assert.ok(calls.includes(`GET /client/v4/accounts/${ACCOUNT_ID}/workers/subdomain`),
    "the no-receipt lane must reach the authenticated fallback decision point");
  assert.deepEqual(healthHosts, [CANDIDATE_DOMAIN]);
});

test("an exact preflight hostname that fails identity is neither persisted nor replaced by a fallback read", async () => {
  const target = writeManifest();
  const { fetchImpl, calls, healthHosts } = harness({ subdomainRead: "ok", health: "wrong-brain" });
  await assert.rejects(
    () => withFixture(fetchImpl, () => cmdDeploy(target, { wait: async () => {} })),
    /exact account hostname was not confirmed as this brain/i,
  );
  assert.deepEqual(healthHosts, [CANDIDATE_DOMAIN],
    "the refusal decision must be reached through the exact authenticated hostname");
  assert.ok(!calls.includes(`GET /client/v4/accounts/${ACCOUNT_ID}/workers/subdomain`),
    "a carried receipt must not be replaced after its exact hostname fails identity");
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.brain?.domain, undefined);
});

test("a fallback hostname whose /health answers for a different brain is refused and never saved", async () => {
  const target = writeManifest();
  const { fetchImpl, calls, healthHosts } = harness({ subdomainRead: "ok", health: "wrong-brain" });
  await assert.rejects(
    () => withFixture(fetchImpl, () => cmdDeploy(target, { wait: async () => {} }), {
      workersSubdomain: null,
    }),
    (error) => {
      assert.match(error.message, /exact account hostname was not confirmed as this brain/i);
      assert.match(error.message, /identified itself as "someone-else"/);
      assert.match(error.message, /No address was saved and no admin key was sent to that host/);
      return true;
    },
  );
  assert.ok(calls.includes(`GET /client/v4/accounts/${ACCOUNT_ID}/workers/subdomain`),
    "the no-receipt lane must reach the authenticated fallback decision point");
  assert.deepEqual(healthHosts, [CANDIDATE_DOMAIN],
    "the refusal decision must be reached through the exact fallback hostname");
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.brain?.domain, undefined);
});

test("the named-profile lane gives only an owner action after both URL proof and API fallback fail", async () => {
  const target = writeManifest();
  const { fetchImpl, calls, healthHosts } = harness({ subdomainRead: "denied", health: "down" });
  await assert.rejects(
    () => withFixture(fetchImpl, () => cmdDeploy(target, { wait: async () => {} }), {
      workersSubdomain: null,
    }),
    (error) => {
      assert.match(error.message, /confirm the brain's public address/);
      assert.match(error.message, /sign in again/i, "the message must name an action the owner can take");
      assert.match(error.message, /Do not change the Workers subdomain setting/i);
      assert.doesNotMatch(error.message, /Workers Scripts Read|needs a permission|Grant /i,
        "the browser-sign-in path must not diagnose a scope for the owner");
      assert.doesNotMatch(error.message, /Nothing is stranded|picks up|instead of recreating/i,
        "the failure must not promise an unproved safe setup resume");
      return true;
    },
  );
  assert.ok(calls.includes(`GET /client/v4/accounts/${ACCOUNT_ID}/workers/subdomain`),
    "the refusal must follow an attempted authenticated fallback read");
  assert.equal(namedProfileTokenReReads, 1,
    "the rejected named-profile read must try exactly one token re-read");
  assert.equal(
    calls.filter((call) => call === `GET /client/v4/accounts/${ACCOUNT_ID}/workers/subdomain`).length,
    1,
    "without a changed token the rejected read must not be repeated",
  );
  assert.deepEqual(healthHosts, [],
    "without an exact subdomain receipt, no guessed hostname may be probed");
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.brain?.domain, undefined);
});

test("the no-credential fallback preserves the wrangler-login and no-shell-token guidance", async () => {
  const target = writeManifest();
  const manifest = JSON.parse(readFileSync(target, "utf8"));
  const priorToken = process.env.CLOUDFLARE_API_TOKEN;
  try {
    delete process.env.CLOUDFLARE_API_TOKEN;
    await assert.rejects(
      persistWorkersDevDomain(target, manifest, { id: ACCOUNT_ID, name: "not a label" }, SCRIPT_NAME),
      (error) => {
        assert.match(error.message, /wrangler@[^\s]+ login/);
        assert.match(error.message, /never paste it\s+into a shell command/i);
        assert.doesNotMatch(error.message, /Workers Scripts Read|subdomain really is unset/i);
        return true;
      },
    );
  } finally {
    if (priorToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = priorToken;
  }
});

/** An injected sleep that records every requested delay and never waits. */
function recordingWait() {
  const delays = [];
  return { delays, wait: async (ms) => { delays.push(ms); } };
}

// A brand-new workers.dev route routinely takes longer than a few seconds to
// answer as the new Worker. The identity gate must give it at least the budget
// cmdHealth gives the same propagation lag (six probes five seconds apart).
const MIN_PROPAGATION_BUDGET_MS = 25_000;

test("a fresh workers.dev route that 404s five times while propagating is still confirmed and saved", async () => {
  const target = writeManifest();
  const { fetchImpl, healthHosts } = harness({
    subdomainRead: "ok",
    health: [404, 404, 404, 404, 404, "healthy"],
  });
  const { delays, wait } = recordingWait();
  await withFixture(fetchImpl, () => cmdDeploy(target, { wait }));
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.brain?.domain, CANDIDATE_DOMAIN);
  assert.equal(healthHosts.length, 6, "the gate must keep probing through propagation 404s");
  assert.ok(healthHosts.every((host) => host === CANDIDATE_DOMAIN));
  assert.equal(delays.length, 5, "each propagation miss waits exactly once before the next probe");
});

test("edge 5xx answers and fetch errors while a route propagates are retried, not fatal", async () => {
  const target = writeManifest();
  const { fetchImpl, healthHosts } = harness({
    subdomainRead: "ok",
    health: ["fetch-error", 503, 522, "fetch-error", "healthy"],
  });
  const { delays, wait } = recordingWait();
  await withFixture(fetchImpl, () => cmdDeploy(target, { wait }));
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.brain?.domain, CANDIDATE_DOMAIN);
  assert.equal(healthHosts.length, 5);
  assert.equal(delays.length, 4);
});

test("this brain still answering its previous version three times is retried until the new version is live", async () => {
  const target = writeManifest();
  const { fetchImpl, healthHosts } = harness({
    subdomainRead: "ok",
    health: ["stale", "stale", "stale", "healthy"],
  });
  const { delays, wait } = recordingWait();
  await withFixture(fetchImpl, () => cmdDeploy(target, { wait }));
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.brain?.domain, CANDIDATE_DOMAIN);
  assert.equal(healthHosts.length, 4, "a stale version of THIS brain is propagation, not a refusal");
  assert.equal(delays.length, 3);
});

test("a workers.dev host that answers for a different brain is refused at once, without retries", async () => {
  const target = writeManifest();
  const { fetchImpl, healthHosts } = harness({
    subdomainRead: "ok",
    health: ["wrong-brain", "healthy"],
  });
  const { delays, wait } = recordingWait();
  await assert.rejects(
    () => withFixture(fetchImpl, () => cmdDeploy(target, { wait })),
    (error) => {
      assert.match(error.message, /identified itself as "someone-else"/);
      assert.match(error.message, /No address was saved and no admin key was sent to that host/);
      return true;
    },
  );
  assert.deepEqual(healthHosts, [CANDIDATE_DOMAIN],
    "the identity refusal must be reached on the first probe and never retried");
  assert.deepEqual(delays, [], "a different brain is not propagation, so nothing waits");
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.brain?.domain, undefined);
});

test("a route that never stops 404ing dies after the full propagation budget and names the resume command", async () => {
  const target = writeManifest();
  const { fetchImpl, healthHosts } = harness({ subdomainRead: "ok", health: [404] });
  const { delays, wait } = recordingWait();
  const resume = renderCliCommands(`brain setup ${commandPath(displayPathForTesting(target, process.cwd()))}`);
  await assert.rejects(
    () => withFixture(fetchImpl, () => cmdDeploy(target, { wait })),
    (error) => {
      assert.match(error.message, /exact account hostname was not confirmed as this brain/i);
      assert.match(error.message, /\/health returned 404/);
      assert.ok(renderCliCommands(error.message).includes(resume),
        `the final refusal must name the resume command ${resume}`);
      return true;
    },
  );
  assert.ok(healthHosts.length >= 6, `expected at least six probes, saw ${healthHosts.length}`);
  assert.ok(healthHosts.every((host) => host === CANDIDATE_DOMAIN));
  assert.equal(delays.length, healthHosts.length - 1, "no sleep after the final probe");
  const waited = delays.reduce((sum, ms) => sum + ms, 0);
  assert.ok(waited >= MIN_PROPAGATION_BUDGET_MS,
    `the gate waited ${waited} ms in total, less than the propagation budget`);
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.brain?.domain, undefined);
});

/** Capture everything the CLI prints while `run` executes. */
async function captureOutput(run) {
  const lines = [];
  const priorLog = console.log;
  const priorError = console.error;
  console.log = (...args) => { lines.push(args.join(" ")); };
  console.error = (...args) => { lines.push(args.join(" ")); };
  try {
    await run();
  } finally {
    console.log = priorLog;
    console.error = priorError;
  }
  // Strip ANSI styling so the assertions read the words the owner reads.
  return lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
}

// Exercise setup's real final deploy and optional-save boundary, with every
// external effect injected. The clock charges each probe against the budget.
async function runSetupAddressScenario(answers) {
  const target = writeManifest();
  const original = readFileSync(target, "utf8");
  const keyFile = join(sandbox, `key-${manifestCounter++}`);
  writeFileSync(keyFile, ["fixture", "admin"].join("-"), { mode: 0o600 });
  const h = harness({ subdomainRead: "ok", health: "healthy" });
  const calls = { verify: 0, provision: 0, migrate: 0, deploy: 0, domain: 0,
    probes: 0, secrets: 0, drain: 0, health: 0, remember: 0, backlog: 0 };
  const waits = [], timeouts = [];
  let clock = 0, value, error;
  const lines = await captureOutput(async () => {
    try {
      value = await withFixture(h.fetchImpl, () => cmdSetup(target, {
        flags: { "no-connect": true }, preflightChecks: [], ask: async () => "",
        configureStandardAdminKeyStorage: () => ({ changed: false }),
        prepareSetupAdminKey: async () => ({ source: "durable", value: readFileSync(keyFile, "utf8") }),
        cmdVerify: async () => { calls.verify++; },
        cmdProvision: async () => { calls.provision++; },
        cmdMigrate: async () => { calls.migrate++; },
        cmdDeploy: async (path, options) => { calls.deploy++; return cmdDeploy(path, options); },
        setupWorkerScriptExists: async () => false,
        cmdSecrets: async () => { calls.secrets++; },
        cmdDrain: async () => { calls.drain++; },
        cmdHealth: async () => { calls.health++; },
        rememberInstalledManifest: () => { calls.remember++; },
        backlogCount: async () => { calls.backlog++; return 0; },
        domainSaveOptions: {
          readSubdomain: async () => { calls.domain++; return { subdomain: SUBDOMAIN_LABEL }; },
          request: async (url, init, { timeoutMs }) => {
            assert.equal(url, `https://${CANDIDATE_DOMAIN}/health`);
            assert.equal(init.headers?.Authorization, undefined);
            assert.ok(timeoutMs > 0 && timeoutMs <= 60_000 - clock);
            timeouts.push(timeoutMs);
            clock += Math.min(1_000, timeoutMs);
            const answer = answers[Math.min(calls.probes++, answers.length - 1)];
            if (answer === "healthy") return healthResponse({ brain: SLUG, version: VERSION });
            if (answer === "foreign") return healthResponse({ brain: "foreign-fixture", version: VERSION });
            return healthResponse({ detail: `RAW_PROVIDER_SENTINEL ${ACCOUNT_ID}` }, { status: answer });
          },
          now: () => clock,
          wait: async ms => { waits.push(ms); clock += ms; },
        },
      }), { workersSubdomain: null });
    } catch (caught) { error = caught; }
  });
  // Reached assertions precede every negative assertion, including the red run.
  assert.equal(calls.deploy, 1, "setup reached its real final deploy");
  assert.ok(h.calls.some(call => call.startsWith("PUT ") && call.endsWith(`/workers/scripts/${SCRIPT_NAME}`)),
    "the real Worker upload decision was reached");
  assert.equal(calls.domain, 1, "the optional-save subdomain decision was reached");
  assert.ok(calls.probes > 0, "the real candidate identity decision was reached");
  return { target, original, calls, clock, waits, timeouts, value, error, lines, text: lines.join("\n") };
}

test("R1: exhausted guided setup returns pending before keys, drain, health or a running claim", async t => {
  const run = await runSetupAddressScenario([404]);
  t.diagnostic(JSON.stringify({ calls: run.calls, clock: run.clock, result: run.value ?? null,
    runningClaim: /STEP 3 of 6 done/.test(run.text), completeClaim: /Brain setup complete/.test(run.text) }));
  assert.equal(run.clock, 60_000, "exhaustion uses exactly the existing one-minute budget");
  assert.equal(run.error, undefined, "propagation is a supported resumable result");
  assert.equal(run.value?.code, "BRAIN_ADDRESS_PENDING", "setup must preserve the typed propagation result");
  assert.equal(run.value?.status, "pending");
  assert.equal(run.calls.secrets, 0, "pending stops before secret writes");
  assert.equal(run.calls.drain, 0); assert.equal(run.calls.health, 0);
  assert.equal(run.calls.remember, 0); assert.equal(run.calls.backlog, 0);
  assert.doesNotMatch(run.text, /STEP 3 of 6 done|STEP 4 of 6|Your Brain is running|Brain setup complete/);
  assert.equal(readFileSync(run.target, "utf8"), run.original, "resource IDs and all manifest bytes are kept");
});

test("R1 green control: delayed identity inside the budget completes real setup", async () => {
  const run = await runSetupAddressScenario([404, 404, "healthy"]);
  assert.equal(run.error, undefined);
  assert.equal(run.calls.probes, 3); assert.equal(run.waits.length, 2); assert.equal(run.clock, 13_000);
  assert.equal(run.calls.secrets, 1); assert.equal(run.calls.drain, 1); assert.equal(run.calls.health, 1);
  assert.equal(run.calls.remember, 1); assert.equal(run.calls.backlog, 1);
  assert.equal(JSON.parse(readFileSync(run.target, "utf8")).brain.domain, CANDIDATE_DOMAIN);
  assert.match(run.text, /STEP 3 of 6 done: your Brain is running/);
  assert.match(run.text, /Brain setup complete/);
  assert.doesNotMatch(run.text, /BRAIN_ADDRESS_PENDING/);
});

test("R2: pending copy keeps work and renders exactly one same-setup resume action", async () => {
  const run = await runSetupAddressScenario([404]);
  assert.equal(run.value?.code, "BRAIN_ADDRESS_PENDING", "a generic failure is not the pending contract");
  const pending = run.lines.filter(line => line.includes("BRAIN_ADDRESS_PENDING"));
  assert.equal(pending.length, 1, "only one supported pending line is emitted");
  assert.match(pending[0], /address is still coming online/i);
  assert.match(pending[0], /everything done so far is kept/i);
  const resume = renderCliCommands(`brain setup ${commandPath(displayPathForTesting(run.target, process.cwd()))} --no-connect`);
  assert.ok(pending[0].includes(resume), "pending prints the exact rendered setup command");
  assert.match(pending[0], /in a few minutes/);
  assert.doesNotMatch(run.text, /RAW_PROVIDER_SENTINEL|BRAIN_DOMAIN_NOT_SAVED|\/health returned|after 6 attempts/);
  assert.ok(!run.text.includes(ACCOUNT_ID), "provider account identity never reaches pending copy");
  assert.ok(!run.text.includes(renderCliCommands("brain deploy")), "pending offers setup only");
});

test("R3: a foreign identity stops guided setup immediately and is never pending", async t => {
  const run = await runSetupAddressScenario(["foreign", "healthy"]);
  t.diagnostic(JSON.stringify({ calls: run.calls, waits: run.waits.length, hardMismatch: Boolean(run.error) }));
  assert.equal(run.calls.probes, 1); assert.deepEqual(run.waits, []);
  assert.ok(run.error, "a different Brain is a hard mismatch through the optional boundary");
  assert.match(run.error.message, /identified itself as "foreign-fixture"/);
  assert.doesNotMatch(run.error.message, /propagat|still coming online/i,
    "a hard mismatch must not be described as propagation");
  assert.equal(run.value, undefined);
  assert.equal(run.calls.secrets, 0); assert.equal(run.calls.drain, 0); assert.equal(run.calls.health, 0);
  assert.doesNotMatch(run.text, /BRAIN_ADDRESS_PENDING|STEP 3 of 6 done|Brain setup complete/);
  assert.equal(readFileSync(run.target, "utf8"), run.original);
});

// The identity gate can sit for about a minute after "workers.dev route
// enabled". A silent minute reads as a hang, so each retry says what it is
// waiting for in the same words the drain warm-up already uses.
test("each propagation retry of the identity gate prints its progress like the drain warm-up", async () => {
  const target = writeManifest();
  const { fetchImpl, healthHosts } = harness({ subdomainRead: "ok", health: [404, 404, 503, "fetch-error", "stale", "healthy"] });
  const { delays, wait } = recordingWait();
  const lines = await captureOutput(() => withFixture(fetchImpl, () => cmdDeploy(target, { wait })));
  assert.equal(healthHosts.length, 6);
  const progress = lines.filter((line) => /Retrying \d+\/\d+ in \d+ second\(s\)\./.test(line));
  assert.equal(progress.length, delays.length, "every wait must be announced, and only waits");
  assert.equal(progress.length, 5);
  const seconds = Math.ceil(delays[0] / 1_000);
  assert.ok(progress[0].includes(
    `the brain's address is not answering yet (404). This is normal just after a deploy. Retrying 1/12 in ${seconds} second(s).`,
  ), progress[0]);
  assert.ok(progress[1].includes("Retrying 2/12 in"), progress[1]);
  assert.ok(progress[2].includes("the brain's address is not answering yet (503)."), progress[2]);
  assert.ok(progress[3].includes("Retrying 4/12 in"), progress[3]);
  assert.match(progress[4], /previous build.*Retrying 5\/12 in \d+ second\(s\)\./);
});

// A probe whose fetch hangs used to be allowed 15 seconds each, so twelve
// probes plus eleven waits could hold setup silently for about four minutes.
// Each probe's own timeout now comes out of the same one-minute budget.
test("hanging identity probes stay inside the propagation budget instead of multiplying it", async () => {
  const target = writeManifest();
  const { fetchImpl } = harness({ subdomainRead: "ok", health: "healthy" });
  let clock = 0;
  const timeouts = [];
  const request = async (_url, _init, { timeoutMs } = {}) => {
    timeouts.push(timeoutMs);
    clock += timeoutMs;
    throw new Error(`the health check timed out after ${timeoutMs} ms (fixture)`);
  };
  const wait = async (ms) => { clock += ms; };
  await assert.rejects(
    () => withFixture(fetchImpl, () => cmdDeploy(target, { wait, request, now: () => clock })),
    (error) => {
      assert.match(error.message, /exact account hostname was not confirmed as this brain/i);
      assert.match(error.message, /did not answer/);
      return true;
    },
  );
  assert.ok(timeouts.length >= 2, `expected more than one probe inside the budget, saw ${timeouts.length}`);
  assert.ok(timeouts.every((ms) => Number.isInteger(ms) && ms > 0 && ms <= 10_000),
    `each probe must be bounded, saw ${JSON.stringify(timeouts)}`);
  assert.ok(clock <= 65_000, `the gate held setup for ${clock} ms, far past its one-minute budget`);
  assert.ok(clock >= MIN_PROPAGATION_BUDGET_MS, `the gate gave up after ${clock} ms, before the propagation budget`);
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.brain?.domain, undefined);
});

// Exercise setup itself: the two branches share one settings read before any
// deployment, migration, or remote secret reconciliation. All bytes are synthetic.
async function runSettingsProofScenario(branch, arm) {
  const target = join(sandbox, `settings-${manifestCounter++}.json`);
  const m = buildSetupManifest({ display: "Owner", slug: "owner", accountId: ACCOUNT_ID });
  m.brain.domain = "owner-brain.fixture.invalid";
  m.infrastructure.cloudflare.d1_database_id = "fixture-settings-db";
  m.infrastructure.cloudflare.vectorize_index = "owner-brain";
  if (arm === "unpinned-db") delete m.infrastructure.cloudflare.d1_database_id;
  if (arm === "reserved-optional") delete m.client.timezone;
  if (arm === "retained-disabled") m.corpora.custom_api = { enabled: false };
  if (arm.startsWith("active-")) m.corpora.custom_api = {
    enabled: true, source: "fixture", token_secret: "CUSTOM_API_TOKEN_FIXTURE",
    base_url: "https://fixture.invalid/api/", endpoints: [{ name: "records", path: "/records", row_key: ["id"],
      document: { fields: ["id", "body"], title_template: "Record {{id}}", body_template: "{{body}}" } }],
  };
  const keyPath = join(sandbox, "settings-admin-key");
  writeFileSync(keyPath, Buffer.alloc(48, 107), { mode: 0o600 });
  const checkpoint = JSON.stringify(m, null, 2) + "\n";
  writeFileSync(target, checkpoint);
  const calls = [];
  const version = arm === "other-live-version" ? "0.0.1" : branch === "retry" ? VERSION : "0.1.14";
  const bindings = workerBindings(m, m.infrastructure.cloudflare).map(row => ({ ...row }));
  bindings.find(row => row.name === "BRAIN_VERSION").text = version;
  const customName = "CUSTOM_API_TOKEN_FIXTURE";
  bindings.push({ name: "ADMIN_KEY", type: "secret_text" }, { name: "ANTHROPIC_API_KEY", type: "secret_text" });
  if (arm === "reserved-optional") bindings.push({ name: "BRAIN_TIMEZONE", type: "secret_text" });
  if (["retained-disabled", "retained-removed", "retained-wrong-type"].includes(arm)) {
    bindings.push({ name: customName, type: arm === "retained-wrong-type" ? "plain_text" : "secret_text" });
  }
  if (["active-exact", "active-missing-config"].includes(arm)) bindings.push({ name: customName, type: "secret_text" });
  if (arm === "active-missing-config") bindings.splice(bindings.findIndex(row => row.name === "CUSTOM_API_CONFIG"), 1);
  if (arm === "unpinned-db") bindings.find(row => row.name === "DB").id = "other-db";
  if (arm === "wrong-db") bindings.find(row => row.name === "DB").id = "other-db";
  if (arm === "wrong-version") bindings.find(row => row.name === "BRAIN_VERSION").text = "0.1.13";
  if (arm === "fence") bindings.push({ name: "VECTOR_ROLLBACK_FENCE", type: "plain_text", text: "1" });
  if (arm === "reserved-secret") bindings.find(row => row.name === "DB").type = "secret_text";
  if (arm === "missing-db") bindings.splice(bindings.findIndex(row => row.name === "DB"), 1);
  if (arm === "missing-version") bindings.splice(bindings.findIndex(row => row.name === "BRAIN_VERSION"), 1);
  if (arm === "duplicate-db") bindings.push({ ...bindings.find(row => row.name === "DB") });
  if (arm === "unknown-runtime") bindings.push({ name: "UNREVIEWED_RUNTIME", type: "plain_text", text: "1" });
  if (arm === "custom-only") bindings.splice(0, bindings.length, { name: customName, type: "secret_text" });
  const healthBody = { ok: true, brain: "owner", version, accepting_documents: true,
    vector_writer_protocol: branch === "retry" ? "lease-v1" : "legacy",
    vector_drain_mode: "active", rollback_write_fence: false };
  const http = async (url) => {
    assert.equal(url, `https://${m.brain.domain}/health`, "only the exact pinned route is probed");
    calls.push("health-read"); return healthResponse(healthBody);
  };
  let error = null;
  const priorLog = console.log;
  try {
    console.log = () => {};
    await cmdSetup(target, {
      flags: { "no-connect": true }, preflightChecks: [], ask: async () => "",
      configureStandardAdminKeyStorage: () => ({ changed: false }),
      prepareSetupAdminKey: async () => ({ source: "durable", value: readFileSync(keyPath, "utf8") }),
      cmdVerify: async () => { calls.push("verify"); },
      cmdProvision: async () => { calls.push("provision"); },
      setupWorkerScriptExists: async () => { calls.push("inventory"); return true; },
      probeExistingWorkerHealth: (path, options) => probeExistingWorkerHealth(path, { ...options, http }),
      probeExistingWorkerDrainMode: (path, options) => probeExistingWorkerDrainMode(path, { ...options, http }),
      setupSettingsProofOptions: {
        http,
        resolveAccount: async () => ({ id: ACCOUNT_ID }),
        cf: async (path) => {
          assert.equal(path, `/accounts/${ACCOUNT_ID}/workers/scripts/owner-brain/settings`);
          calls.push("settings-read");
          if (arm === "other-live-version") throw new Error("fixture settings unavailable");
          return { bindings };
        },
      },
      captureSetupD1Bookmark: async () => { calls.push("bookmark"); return "fixture-bookmark"; },
      waitForVectorDrainQuiescence: async () => { calls.push("wait"); },
      cmdMigrate: async () => { calls.push("migrate"); },
      cmdDeploy: async () => { calls.push("upload"); },
      cmdSecrets: async () => { calls.push("secrets"); },
      cmdDrain: async () => { calls.push("drain"); },
      cmdHealth: async () => { calls.push("health"); },
      rememberInstalledManifest: () => {}, backlogCount: async () => 0, connectAgents: false,
    });
  } catch (caught) { error = caught; }
  finally { console.log = priorLog; }
  return { calls, error, checkpointUnchanged: readFileSync(target, "utf8") === checkpoint };
}

for (const branch of ["retry", "legacy"]) {
  for (const arm of ["exact", "retained-disabled", "retained-removed", "active-exact", "active-missing-token", "active-missing-config", "wrong-db", "wrong-version",
    "fence", "retained-wrong-type", "reserved-secret", "missing-db", "missing-version", "duplicate-db", "unknown-runtime", "unpinned-db", "custom-only", "reserved-optional"]) {
    test(`shared settings proof ${branch}: ${arm}`, async (t) => {
      const run = await runSettingsProofScenario(branch, arm);
      const permits = ["exact", "retained-disabled", "retained-removed", "active-exact"].includes(arm);
      t.diagnostic(JSON.stringify({ branch, arm, settingsRead: run.calls.filter(call => call === "settings-read").length,
        downstreamUpload: run.calls.filter(call => call === "upload").length,
        migrate: run.calls.filter(call => call === "migrate").length,
        secrets: run.calls.filter(call => call === "secrets").length, checkpointUnchanged: run.checkpointUnchanged,
        held: Boolean(run.error) }));
      assert.ok(run.calls.includes("inventory") && run.calls.includes("health-read"), "real setup identity decision reached");
      if (permits) {
        assert.equal(run.error, null, run.error?.message);
        assert.equal(run.calls.filter(call => call === "secrets").length, 1, "green control reaches key reconciliation");
        assert.ok(run.calls.indexOf("settings-read") < run.calls.indexOf("secrets"), "proof precedes key reconciliation");
        assert.equal(run.calls.filter(call => call === "upload").length, branch === "legacy" ? 2 : 0);
        assert.equal(run.calls.filter(call => call === "migrate").length, branch === "legacy" ? 1 : 0);
      } else {
        assert.ok(run.error, `${arm}: contradictory settings must stop setup before downstream work`);
        assert.match(run.error.message, /settings proof/i);
        assert.deepEqual(run.calls.filter(call => ["upload", "migrate", "secrets", "bookmark"].includes(call)), [], "downstreamUpload/migrate/secrets=0");
      }
      assert.equal(run.calls.filter(call => call === "settings-read").length, 1, "settingsRead=1 proves the shared decision was reached");
      assert.equal(run.checkpointUnchanged, true, "checkpoint bytes preserved");
    });
  }
}

test("both existing-Worker branches wire the same pinned settings proof", () => {
  const source = readFileSync(join(ROOT, "brain.mjs"), "utf8");
  const setup = source.slice(source.indexOf("export async function cmdSetup("), source.indexOf("// Even resumed setup reaches this boundary"));
  assert.equal((setup.match(/await runPinnedSetupStage\("setup existing Worker settings proof", proveExistingSettings\)/g) || []).length, 2);
  assert.equal((setup.match(/const proveExistingSettings = \(pinnedPath\) => proveSetupWorkerSettings/g) || []).length, 1);
});

test("an already-live other release keeps its update guidance before settings reads", async () => {
  const run = await runSettingsProofScenario("retry", "other-live-version");
  assert.ok(run.calls.includes("inventory") && run.calls.includes("health-read"), "version hold decision reached");
  assert.match(run.error?.message || "", /already installed and live on version 0\.0\.1/);
  assert.ok(renderCliCommands(run.error.message).includes(renderCliCommands("brain update")));
  assert.equal(run.calls.filter(call => call === "settings-read").length, 0, "the existing version hold is sufficient before any continuation");
  assert.deepEqual(run.calls.filter(call => ["upload", "migrate", "secrets", "bookmark"].includes(call)), []);
  assert.equal(run.checkpointUnchanged, true);
});
