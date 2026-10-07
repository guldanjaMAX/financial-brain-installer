import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cmdDeploy, cmdDoctor, cmdUpdate, cmdUpgrade, supportErrorCode } from "../brain.mjs";
import {
  exportSupportJournal,
  previewSupportJournal,
  recordSupportEvent,
} from "../support-journal.mjs";
import { renderSupportRecovery, supportRecovery } from "../support-recovery.mjs";

const WRAPPING_NAME = "BANK_FEED_WRAPPING_KEY_V2";
const SENTINEL = `v2.${Buffer.alloc(32, 29).toString("base64url")}`;
const SENTINEL_PATTERN = new RegExp(SENTINEL.replaceAll(".", "\\."));

function apiResponse(result, { success = true, status = 200, message = "fixture refusal" } = {}) {
  return new Response(JSON.stringify({
    success,
    result: success ? result : null,
    errors: success ? [] : [{ code: 1000, message }],
  }), { status, headers: { "content-type": "application/json" } });
}

function manifest({ bankFeed = true, provider = "plaid", version = "0.4.0" } = {}) {
  return {
    client: { slug: "fixture", display_name: "Fixture" },
    brain: {
      worker_name: "fixture-brain",
      domain: "fixture-brain.example.invalid",
      version,
    },
    infrastructure: {
      cloudflare: {
        account_id: "fixture-account",
        d1_database_id: "fixture-database",
        storage: "d1",
        vectorize_index: "fixture-index",
      },
    },
    retrieval: { answer_model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
    ...(bankFeed ? {
      corpora: {
        bank_feed: {
          enabled: true,
          provider,
          environment: provider === "simplefin" ? "production" : "sandbox",
        },
      },
    } : {}),
  };
}

function cloudflareHarness({ initial = [], rejectPut = false, landRejectedPut = false } = {}) {
  const secretNames = new Set(initial);
  const calls = [];
  const writtenValues = [];
  let workerUploads = 0;
  let secretLists = 0;
  let secretPuts = 0;
  const uploadedMetadata = [];
  const fetchImpl = async (input, options = {}) => {
    const path = new URL(String(input)).pathname;
    const method = options.method || "GET";
    if (path === "/client/v4/accounts" && method === "GET") {
      return apiResponse([{ id: "fixture-account", name: "Fixture account" }]);
    }
    if (path.endsWith("/workers/scripts/fixture-brain") && method === "PUT") {
      workerUploads++;
      calls.push("worker-upload");
      uploadedMetadata.push(await options.body.get("metadata").text());
      return apiResponse({});
    }
    if (path.endsWith("/workers/scripts/fixture-brain/secrets") && method === "GET") {
      secretLists++;
      calls.push("secret-list");
      return apiResponse([...secretNames].map((name) => ({ name, type: "secret_text" })));
    }
    if (path.endsWith("/workers/scripts/fixture-brain/secrets") && method === "PUT") {
      secretPuts++;
      const body = JSON.parse(String(options.body || "{}"));
      calls.push(`secret-put:${body.name}`);
      writtenValues.push(body.text);
      if (rejectPut) {
        if (landRejectedPut) secretNames.add(body.name);
        return apiResponse(null, {
          success: false,
          status: 503,
          message: `synthetic write rejection carrying ${body.text}`,
        });
      }
      secretNames.add(body.name);
      return apiResponse({});
    }
    if (path.endsWith("/workers/scripts/fixture-brain/subdomain") && method === "POST") {
      calls.push("route-enable");
      return apiResponse({ enabled: true });
    }
    if (path.endsWith("/workers/scripts/fixture-brain/schedules") && method === "GET") {
      calls.push("schedule-list");
      return apiResponse([{ cron: "* * * * *" }]);
    }
    throw new Error(`offline fixture has no response for ${method} ${path}`);
  };
  return {
    fetchImpl,
    calls,
    writtenValues,
    uploadedMetadata,
    secretNames,
    get workerUploads() { return workerUploads; },
    get secretLists() { return secretLists; },
    get secretPuts() { return secretPuts; },
  };
}

async function isolatedRuntime(fetchImpl, operation) {
  const priorFetch = globalThis.fetch;
  const priorLog = console.log;
  const priorError = console.error;
  const tracked = [
    "ADMIN_KEY",
    "BANK_FEED_CLIENT_ID",
    "BANK_FEED_SECRET",
    WRAPPING_NAME,
    "CLOUDFLARE_API_TOKEN",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_URL",
  ];
  const priorEnvironment = Object.fromEntries(tracked.map((name) => [name, process.env[name]]));
  const output = [];
  try {
    globalThis.fetch = fetchImpl;
    console.log = (...values) => output.push(values.map(String).join(" "));
    console.error = (...values) => output.push(values.map(String).join(" "));
    for (const name of tracked) delete process.env[name];
    process.env.CLOUDFLARE_API_TOKEN = "fixture-control-token";
    const result = await operation();
    return { result, output: output.join("\n") };
  } catch (error) {
    error.capturedOutput = output.join("\n");
    throw error;
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

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-bank-wrapping-lifecycle-")));
// cmdUpdate records the installed-manifest pointer under the home folder; keep it in the sandbox
// so a run without a scratch HOME can never write into the real one.
process.env.HOME = join(sandbox, "home");
mkdirSync(process.env.HOME, { recursive: true });
const writeManifest = (name, value) => {
  const path = join(sandbox, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
};

function writtenFileContents(root) {
  const contents = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) contents.push(...writtenFileContents(path));
    else if (entry.isFile()) contents.push(readFileSync(path, "utf8"));
  }
  return contents;
}

test.after(() => rmSync(sandbox, { recursive: true, force: true }));

test("deploy creates a missing wrapping key once and verifies it by name", async () => {
  const harness = cloudflareHarness();
  const path = writeManifest("deploy-absent.json", manifest());
  const run = await isolatedRuntime(harness.fetchImpl, () => cmdDeploy(path, {
    nextSteps: false,
    generateBankWrappingKey: () => SENTINEL,
  }));

  assert.equal(harness.workerUploads, 1, "the real deploy decision point must be reached");
  assert.equal(harness.secretLists, 2, "absence and post-write presence must both be read");
  assert.equal(harness.secretPuts, 1);
  assert.deepEqual(harness.calls.slice(0, 4), [
    "worker-upload",
    "secret-list",
    `secret-put:${WRAPPING_NAME}`,
    "secret-list",
  ]);
  assert.equal(harness.secretNames.has(WRAPPING_NAME), true);
  assert.equal(harness.writtenValues[0], SENTINEL);
  assert.doesNotMatch(run.output, new RegExp(SENTINEL.replaceAll(".", "\\.")));
  assert.doesNotMatch(JSON.stringify(run.result) ?? "undefined", new RegExp(SENTINEL.replaceAll(".", "\\.")));
});

test("deploy leaves an existing wrapping key untouched", async () => {
  const harness = cloudflareHarness({ initial: [WRAPPING_NAME] });
  const path = writeManifest("deploy-present.json", manifest());
  await isolatedRuntime(harness.fetchImpl, () => cmdDeploy(path, {
    nextSteps: false,
    generateBankWrappingKey: () => { throw new Error("generation must not be reached"); },
  }));

  assert.equal(harness.workerUploads, 1, "the real deploy decision point must be reached");
  assert.equal(harness.secretLists, 1);
  assert.equal(harness.secretPuts, 0);
});

test("deploy creates and verifies the same independent key for SimpleFIN", async () => {
  const harness = cloudflareHarness();
  const path = writeManifest("deploy-simplefin-absent.json", manifest({ provider: "simplefin" }));
  await isolatedRuntime(harness.fetchImpl, () => cmdDeploy(path, {
    nextSteps: false,
    generateBankWrappingKey: () => SENTINEL,
  }));

  assert.equal(harness.workerUploads, 1, "the SimpleFIN deploy decision point must be reached");
  assert.equal(harness.secretLists, 2, "the missing key and its readback must both be observed");
  assert.equal(harness.secretPuts, 1);
  assert.deepEqual(harness.calls.slice(0, 4), [
    "worker-upload",
    "secret-list",
    `secret-put:${WRAPPING_NAME}`,
    "secret-list",
  ]);
});

for (const [label, failure] of [
  ["rejection", new Error(`fixture inventory rejection carrying ${SENTINEL}`)],
  ["timeout", Object.assign(new Error(`fixture inventory timed out carrying ${SENTINEL}`), { code: "ETIMEDOUT" })],
]) {
  test(`deploy fails closed when the wrapping-key inventory has a ${label}`, async () => {
    const harness = cloudflareHarness();
    const path = writeManifest(`deploy-list-${label}.json`, manifest());
    let lists = 0;
    let puts = 0;
    let error;
    try {
      await isolatedRuntime(harness.fetchImpl, () => cmdDeploy(path, {
        nextSteps: false,
        listWorkerSecretNames: async () => {
          lists += 1;
          throw failure;
        },
        putWorkerSecret: async () => { puts += 1; },
        generateBankWrappingKey: () => { throw new Error("generation must not be reached"); },
      }));
    } catch (caught) {
      error = caught;
    }

    assert.equal(harness.workerUploads, 1, "the real deploy decision point must be reached");
    assert.equal(lists, 1, "the inventory decision point must be reached");
    assert.equal(puts, 0, "an unreadable inventory must not trigger a put");
    assert.match(error?.message || "", /secret names could not be checked/i);
    assert.doesNotMatch(error?.message || "", SENTINEL_PATTERN);
    assert.doesNotMatch(error?.capturedOutput || "", SENTINEL_PATTERN);
  });
}

test("a wrapping-key write failure reports uncertainty and never leaks the generated value", async () => {
  const harness = cloudflareHarness({ rejectPut: true });
  const path = writeManifest("deploy-put-failure.json", manifest());
  let error;
  try {
    await isolatedRuntime(harness.fetchImpl, () => cmdDeploy(path, {
      nextSteps: false,
      generateBankWrappingKey: () => SENTINEL,
    }));
  } catch (caught) {
    error = caught;
  }

  assert.equal(harness.workerUploads, 1, "the real deploy decision point must be reached");
  assert.equal(harness.secretLists, 1);
  assert.equal(harness.secretPuts, 1);
  assert.match(error?.message || "", /independent bank wrapping key could not be created/i);
  assert.match(error?.message || "", /result is unknown|result could not be confirmed/i);
  assert.doesNotMatch(error?.message || "", /nothing was half-written/i);
  assert.doesNotMatch(error?.message || "", SENTINEL_PATTERN);
  assert.doesNotMatch(error?.capturedOutput || "", SENTINEL_PATTERN);
  assert.equal(harness.secretNames.has(WRAPPING_NAME), false);
});

test("a landed wrapping-key write is adopted on retry and stays absent from every disclosure surface", async () => {
  const harness = cloudflareHarness({ rejectPut: true, landRejectedPut: true });
  const path = writeManifest("deploy-landed-put-failure.json", manifest());
  let error;
  try {
    await isolatedRuntime(harness.fetchImpl, () => cmdDeploy(path, {
      nextSteps: false,
      generateBankWrappingKey: () => SENTINEL,
    }));
  } catch (caught) {
    error = caught;
  }

  assert.equal(harness.workerUploads, 1, "the first real deploy decision point must be reached");
  assert.equal(harness.secretLists, 1, "the first inventory decision must be reached");
  assert.equal(harness.secretPuts, 1, "the uncertain write must be attempted once");
  assert.equal(harness.secretNames.has(WRAPPING_NAME), true, "the failure fixture must land the write");

  const retry = await isolatedRuntime(harness.fetchImpl, () => cmdDeploy(path, {
    nextSteps: false,
    generateBankWrappingKey: () => { throw new Error("retry must not generate a replacement"); },
  }));
  assert.equal(harness.workerUploads, 2, "the retry must reach the real deploy path");
  assert.equal(harness.secretLists, 2, "the retry must recheck the inventory");
  assert.equal(harness.secretPuts, 1, "the landed key must not be replaced");

  const issueCode = supportErrorCode(error, { command: "deploy" });
  recordSupportEvent({ command: "deploy", source: "cloudflare", errorCode: issueCode }, {
    root: sandbox,
    now: () => new Date("2026-09-28T12:00:00.000Z"),
    randomBytes: () => Buffer.alloc(16, 7),
  });
  const supportPreview = previewSupportJournal({
    root: sandbox,
    now: () => new Date("2026-09-28T12:00:00.000Z"),
  });
  const supportExport = join(sandbox, "support-export.jsonl");
  const exported = exportSupportJournal(supportExport, {
    root: sandbox,
    now: () => new Date("2026-09-28T12:00:00.000Z"),
  });
  assert.equal(exported.events, 1, "the support export decision point must be reached");

  const recovery = supportRecovery(issueCode);
  const doctor = await isolatedRuntime(harness.fetchImpl, () => cmdDoctor(null, {
    withAvailableCloudflareToken: (action) => action(),
    doctorRunAll: async ({ onResult }) => {
      const check = { name: "offline fixture", status: "ok", detail: "ready" };
      onResult(check);
      return [check];
    },
  }));
  const disclosureSurfaces = [
    error?.message || "",
    error?.capturedOutput || "",
    retry.output,
    JSON.stringify(retry.result) ?? "undefined",
    harness.uploadedMetadata.join("\n"),
    supportPreview,
    readFileSync(supportExport, "utf8"),
    JSON.stringify(recovery),
    renderSupportRecovery(recovery),
    doctor.output,
    JSON.stringify(doctor.result) ?? "undefined",
    ...writtenFileContents(sandbox),
  ];
  for (const surface of disclosureSurfaces) assert.doesNotMatch(surface, SENTINEL_PATTERN);
});

test("the public bank-feed schema describes deploy custody and optional provider credentials", () => {
  const schema = JSON.parse(readFileSync(new URL("../manifest.schema.json", import.meta.url), "utf8"));
  const description = schema.properties.corpora.properties.bank_feed.description;
  assert.match(description, /setup, update, and deploy create the independent wrapping key/i);
  assert.match(description, /provider credentials may remain absent/i);
  assert.doesNotMatch(description, /routine secret repair requires all three names/i);
});

test("deploy performs no secret call when the bank feed is disabled", async () => {
  const harness = cloudflareHarness();
  const path = writeManifest("deploy-disabled.json", manifest({ bankFeed: false }));
  await isolatedRuntime(harness.fetchImpl, () => cmdDeploy(path, { nextSteps: false }));

  assert.equal(harness.workerUploads, 1, "the green control must reach the real deploy decision point");
  assert.equal(harness.secretLists, 0);
  assert.equal(harness.secretPuts, 0);
});

test("brain update reaches the real deploy and creates the wrapping key before verification", async () => {
  const harness = cloudflareHarness();
  const path = writeManifest("update-absent.json", manifest());
  let d1Version = null;
  let upgradeDeployments = 0;
  const run = await isolatedRuntime(harness.fetchImpl, () => cmdUpdate(path, {
    lifecycleLockOptions: { machineLockRoot: join(sandbox, "lifecycle-locks") },
    discoverInstalledManifest: () => ({ path, source: "explicit" }),
    readUpdateBacklog: async () => ({ pending: 0 }),
    adoptCloudflareAuthProfile: async () => {},
    withCloudflareControl: async (action) => action(),
    cmdVerify: async () => {},
    cmdUpgrade: (upgradePath) => cmdUpgrade(upgradePath, {
      resolveAccount: async () => ({ id: "fixture-account" }),
      d1Query: async (_account, _database, sql) => {
        if (/sqlite_master/i.test(sql)) return { results: [] };
        if (/UPDATE install_state/i.test(sql)) d1Version = JSON.parse(readFileSync("package.json", "utf8")).version;
        if (/SELECT product_version FROM install_state/i.test(sql)) {
          return { results: [{ product_version: d1Version }] };
        }
        return { results: [] };
      },
      cf: async () => ({ bookmark: "metadata-fixture-bookmark" }),
      cmdMigrate: async () => {},
      cmdBootstrap: async () => ({
        epoch: 1,
        total: 0,
        confirmed: 0,
        remaining: 0,
        rounds: 1,
        complete: true,
        vector_ready: true,
      }),
      cmdDeploy: async (deployPath, deployOptions) => {
        upgradeDeployments++;
        return cmdDeploy(deployPath, {
          ...deployOptions,
          nextSteps: false,
          generateBankWrappingKey: () => SENTINEL,
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
  }));

  assert.equal(upgradeDeployments, 2, "the D1 update must reach paused and active deployment stages");
  assert.equal(harness.workerUploads, 2, "both stages must use the real deploy function");
  assert.equal(harness.secretLists, 3, "the second deploy must observe the first deploy's verified key");
  assert.equal(harness.secretPuts, 1);
  assert.equal(harness.secretNames.has(WRAPPING_NAME), true);
  assert.doesNotMatch(run.output, new RegExp(SENTINEL.replaceAll(".", "\\.")));
  assert.doesNotMatch(JSON.stringify(run.result) ?? "undefined", new RegExp(SENTINEL.replaceAll(".", "\\.")));
});
