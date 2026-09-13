import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CloudflareDisposableDeploymentProviderError,
  prepareCloudflareDisposableDeploymentProvider,
} from "../operations/cloudflare-disposable-deployment-provider.mjs";

const HASH = "a".repeat(64);
const SOURCE_ACCOUNT = "1".repeat(32);
const TARGET_ACCOUNT = "2".repeat(32);
const SOURCE_DATABASE = "10000000-0000-4000-8000-000000000001";
const TARGET_DATABASE = "20000000-0000-4000-8000-000000000002";
const SOURCE_VERSION = "30000000-0000-4000-8000-000000000003";
const SOURCE_DEPLOYMENT = "40000000-0000-4000-8000-000000000004";
const TARGET_VERSION = "50000000-0000-4000-8000-000000000005";
const TARGET_DEPLOYMENT = "60000000-0000-4000-8000-000000000006";
const NEW_VERSION = "70000000-0000-4000-8000-000000000007";
const NEW_DEPLOYMENT = "80000000-0000-4000-8000-000000000008";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const evidence = () => ({
  schema_version: 1,
  status: 200,
  content_type: "application/json",
  body_sha256: HASH,
});

function manifestBinding(role) {
  const source = role === "source";
  return {
    accountId: source ? SOURCE_ACCOUNT : TARGET_ACCOUNT,
    adminKeySecret: `keychain://fixture-${role}/owner`,
    answerModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    bankFeedEnabled: false,
    chunkOverlap: "300",
    chunkSize: "1500",
    clientDisplayName: "Synthetic Field Gate v0.4.8",
    clientSlug: "v048-field-proof",
    credentialScanner: "on",
    dailyLlmCapUsd: "10",
    databaseId: source ? SOURCE_DATABASE : TARGET_DATABASE,
    databaseName: `brain-test-v048-field-${role}-recovery-gate-a48f110${source ? 1 : 2}`,
    domain: `brain-test-v048-field-${role}-recovery-gate-a48f110${source ? 1 : 2}.fixture.workers.dev`,
    embeddingDimensions: 768,
    embeddingModel: "@cf/baai/bge-base-en-v1.5",
    enabledCorpora: [],
    ocrEnabled: "0",
    ocrModel: "@cf/google/gemma-4-26b-a4b-it",
    productVersion: "0.4.8",
    recoveryArtifactKeySecret: source ? null : "keychain://fixture-target/artifact-v1",
    recoveryFieldGate: null,
    vectorizeIndex: `brain-test-v048-field-${role}-recovery-gate-a48f110${source ? 1 : 2}`,
    workerName: `brain-test-v048-field-${role}-recovery-gate-a48f110${source ? 1 : 2}`,
  };
}

function manifestBindings(phase = "target") {
  const source = {
    planFingerprint: HASH,
    source: manifestBinding("source"),
    sourceManifestFingerprint: "b".repeat(64),
  };
  return phase === "source" ? source : {
    ...source,
    target: manifestBinding("target"),
    targetManifestFingerprint: "c".repeat(64),
  };
}

function moduleFixture() {
  const root = mkdtempSync(join(tmpdir(), "v048-provider-"));
  chmodSync(root, 0o700);
  const source = join(root, "worker", "src");
  mkdirSync(join(source, "lib"), { recursive: true, mode: 0o700 });
  const records = [
    [join(source, "index.js"), "worker/src/index.js", "export default { fetch() {} };\n"],
    [join(source, "lib", "core.js"), "worker/src/lib/core.js", "export const value = 1;\n"],
  ];
  const executionPins = records.map(([path, relative, content]) => {
    writeFileSync(path, content, { mode: 0o600 });
    return { path, relative, hash: digest(content), info: lstatSync(path) };
  });
  return { root, executionPins };
}

function resource(vectorCount = 0) {
  return {
    operation: "read_resource_contract",
    worker_exists: true,
    workers_dev_enabled: true,
    previews_enabled: false,
    routes_count: 0,
    custom_domains_count: 0,
    schedules_count: 0,
    d1_exists: true,
    d1_name_and_id_exact: true,
    vectorize_exists: true,
    vectorize_name_exact: true,
    vector_dimensions: 768,
    vector_metric: "cosine",
    vector_count: vectorCount,
    responses: [
      { operation: "list_workers", ...evidence() },
      { operation: "read_worker_subdomain", ...evidence() },
    ],
  };
}

function fakeTransport(role, calls) {
  const source = role === "source";
  const versionId = source ? SOURCE_VERSION : TARGET_VERSION;
  const deploymentId = source ? SOURCE_DEPLOYMENT : TARGET_DEPLOYMENT;
  return {
    async readCurrentDeployment(input) {
      calls.push({ role, method: "readCurrentDeployment", input });
      return {
        schema_version: 1,
        operation: "read_current_deployment",
        deployment_id: deploymentId,
        strategy: "percentage",
        versions: [{ percentage: 100, version_id: versionId }],
        response: evidence(),
      };
    },
    async readDeployment(input) {
      calls.push({ role, method: "readDeployment", input });
      return {
        schema_version: 1,
        operation: "read_deployment",
        deployment_id: input.deployment_id,
        strategy: "percentage",
        versions: [{ percentage: 100, version_id: versionId }],
        response: evidence(),
      };
    },
    async readVersion(input) {
      calls.push({ role, method: "readVersion", input });
      return {
        schema_version: 1,
        operation: "read_version",
        version_id: input.version_id,
        script_etag: `etag-${role}`,
        bindings_sha256: "d".repeat(64),
        bindings_without_mode_sha256: "e".repeat(64),
        bindings_exact: true,
        compatibility_and_usage_model_exact: true,
        handlers: ["fetch", "scheduled"],
        named_handlers_count: 0,
        response: evidence(),
      };
    },
    async readResourceContract(input) {
      calls.push({ role, method: "readResourceContract", input });
      return resource();
    },
    async uploadVersion(input) {
      calls.push({ role, method: "uploadVersion", input });
      return { version_id: NEW_VERSION, operation: "upload_version" };
    },
    async deployVersion(input) {
      calls.push({ role, method: "deployVersion", input });
      return { deployment_id: NEW_DEPLOYMENT, version_id: input.version_id };
    },
  };
}

function requestPlan(moduleInventorySha256) {
  return {
    source_active_upload: {
      role: "source", mode: "active", module_inventory_sha256: moduleInventorySha256,
    },
    source_active_deployment: {
      role: "source", mode: "active", traffic_percent: 100, force: false,
    },
    target_paused_upload: {
      role: "target", mode: "paused-for-upgrade",
      module_inventory_sha256: moduleInventorySha256,
    },
    target_active_upload: {
      role: "target", mode: "active", module_inventory_sha256: moduleInventorySha256,
    },
    target_paused_deployment: {
      role: "target", mode: "paused-for-upgrade", traffic_percent: 100, force: false,
    },
  };
}

function context(phase, stage, requests) {
  return {
    binding: {
      campaign_fingerprint: HASH,
      plan_fingerprint: HASH,
      source_manifest_fingerprint: "b".repeat(64),
      source_resource_fingerprint: "f".repeat(64),
      target_manifest_fingerprint: "c".repeat(64),
      target_resource_fingerprint: "0".repeat(64),
    },
    phase,
    stage,
    requests,
  };
}

test("provider refuses non-macOS before credential or transport setup", () => {
  let touched = false;
  assert.throws(
    () => prepareCloudflareDisposableDeploymentProvider({
      manifestBindings: {}, executionPins: [],
    }, {
      platform: "win32",
      fetchImpl: async () => {},
      loadToken: () => { touched = true; },
      createTransport: () => { touched = true; },
    }),
    (error) => error instanceof CloudflareDisposableDeploymentProviderError &&
      error.code === "CF_DISPOSABLE_PROVIDER_MACOS_KEYCHAIN_REQUIRED",
  );
  assert.equal(touched, false);
});

test("provider pins modules and wires only the account-bound Keychain resolver", async () => {
  const fixture = moduleFixture();
  const resolverRecords = [];
  const transportRecords = [];
  try {
    const prepared = prepareCloudflareDisposableDeploymentProvider({
      manifestBindings: manifestBindings("source"),
      executionPins: fixture.executionPins,
      phase: "source",
    }, {
      platform: "darwin",
      fetchImpl: async () => { throw new Error("unused"); },
      loadToken(accountId, options) {
        resolverRecords.push({ accountId, options });
        return Buffer.from("synthetic-provider-token-value", "utf8");
      },
      createTransport(options) {
        transportRecords.push(options);
        return fakeTransport("source", []);
      },
    });
    assert.match(prepared.moduleInventorySha256, /^[a-f0-9]{64}$/u);
    const provider = await prepared.createProvider(() => true,
      context("source", "source_preflight", requestPlan(prepared.moduleInventorySha256)));
    assert.equal(transportRecords.length, 1);
    const token = await transportRecords[0].resolveToken();
    try {
      assert.equal(resolverRecords[0].accountId, SOURCE_ACCOUNT);
      assert.deepEqual(resolverRecords[0].options, { platform: "darwin" });
      assert.equal(JSON.stringify(prepared).includes(token.toString("utf8")), false);
    } finally {
      token.fill(0);
    }
    assert.deepEqual(Object.keys(provider).sort(), [
      "deployVersion", "readSnapshot", "uploadVersion",
    ]);

    writeFileSync(fixture.executionPins[0].path, "changed\n");
    assert.throws(
      () => prepareCloudflareDisposableDeploymentProvider({
        manifestBindings: manifestBindings("source"), executionPins: fixture.executionPins,
        phase: "source",
      }, {
        platform: "darwin", fetchImpl: async () => {},
        loadToken: () => Buffer.alloc(32), createTransport: () => ({}),
      }),
      /CF_DISPOSABLE_PROVIDER_MODULE_INVENTORY_CHANGED/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("provider preflight uses current discovery plus exact deployment GET and keeps phases split", async () => {
  const fixture = moduleFixture();
  const calls = [];
  try {
    const prepared = prepareCloudflareDisposableDeploymentProvider({
      manifestBindings: manifestBindings("source"), executionPins: fixture.executionPins,
      phase: "source",
    }, {
      platform: "darwin",
      fetchImpl: async () => {},
      loadToken: () => Buffer.alloc(32, 1),
      createTransport: () => fakeTransport("source", calls),
    });
    const requests = requestPlan(prepared.moduleInventorySha256);
    const provider = await prepared.createProvider(
      () => true,
      context("source", "source_preflight", requests),
    );
    const snapshot = await provider.readSnapshot({
      schema_version: 2,
      protocol: "v048-fixture",
      operation: "read_snapshot",
      phase: "source",
      stage: "source_preflight",
      read_ordinal: 1,
      campaign_fingerprint: HASH,
      expected: null,
    });
    assert.deepEqual(calls.slice(0, 4).map(({ method }) => method), [
      "readCurrentDeployment", "readDeployment", "readVersion", "readResourceContract",
    ]);
    assert.equal(calls[1].input.deployment_id, SOURCE_DEPLOYMENT);
    assert.equal(snapshot.semantic.source.baseline_deployment_id, SOURCE_DEPLOYMENT);
    assert.equal(JSON.stringify(snapshot).includes(SOURCE_ACCOUNT), false);

    const uploaded = await provider.uploadVersion(requests.source_active_upload, {
      source: { baseline_version_id: SOURCE_VERSION },
    });
    assert.equal(uploaded.version_id, NEW_VERSION);
    const upload = calls.find(({ method }) => method === "uploadVersion").input;
    assert.deepEqual(upload.secret_names, [
      "ADMIN_KEY", "RAG_PROXY_KEY", "SESSION_SIGNING_KEY",
    ]);
    assert.equal(upload.modules.some(({ name }) => name === "index.js"), true);
    assert.equal(upload.bindings.some(({ name }) => name === "VECTOR_DRAIN_MODE"), false);
    assert.equal(upload.bindings.some(({ name }) => name === "DB"), true);
    assert.equal(Object.hasOwn(upload, "token"), false);

    const deployed = await provider.deployVersion(
      requests.source_active_deployment,
      NEW_VERSION,
      {},
    );
    assert.equal(deployed.deployment_id, NEW_DEPLOYMENT);
    assert.equal(calls.at(-1).role, "source");

    const finalProvider = await prepared.createProvider(
      () => true,
      context("source", "source_phase", requests),
    );
    const final = await finalProvider.readSnapshot({
      schema_version: 2,
      protocol: "v048-fixture",
      operation: "read_snapshot",
      phase: "source",
      stage: "source_final",
      read_ordinal: 2,
      campaign_fingerprint: HASH,
      expected: {
        active_deployment_id: SOURCE_DEPLOYMENT,
        active_version_id: SOURCE_VERSION,
      },
    });
    assert.equal(final.semantic.source.active_deployment.deployment_id,
      SOURCE_DEPLOYMENT);
    assert.equal(calls.filter(({ method, input }) =>
      method === "readDeployment" && input.deployment_id === SOURCE_DEPLOYMENT).length,
    2);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("target provider inherits only the reviewed target secrets and deploys paused only", async () => {
  const fixture = moduleFixture();
  const calls = [];
  const roles = ["source", "target"];
  try {
    const prepared = prepareCloudflareDisposableDeploymentProvider({
      manifestBindings: manifestBindings(), executionPins: fixture.executionPins,
      phase: "target",
    }, {
      platform: "darwin",
      fetchImpl: async () => {},
      loadToken: () => Buffer.alloc(32, 1),
      createTransport: () => fakeTransport(roles.shift(), calls),
    });
    const requests = requestPlan(prepared.moduleInventorySha256);
    const provider = await prepared.createProvider(
      () => true,
      context("target", "target_phase", requests),
    );
    await provider.uploadVersion(requests.target_paused_upload, {
      target: { baseline_version_id: TARGET_VERSION },
    });
    await provider.uploadVersion(requests.target_active_upload, {
      target: { baseline_version_id: TARGET_VERSION },
    });
    await provider.deployVersion(requests.target_paused_deployment, NEW_VERSION, {});
    const uploads = calls.filter(({ method }) => method === "uploadVersion");
    assert.equal(uploads.length, 2);
    assert.deepEqual(uploads.map(({ role }) => role), ["target", "target"]);
    assert.deepEqual(uploads[0].input.secret_names, [
      "ADMIN_KEY", "BANK_FEED_WRAPPING_KEY_V2", "RAG_PROXY_KEY",
      "SESSION_SIGNING_KEY",
    ]);
    assert.equal(uploads[0].input.bindings.some(({ name, text }) =>
      name === "VECTOR_DRAIN_MODE" && text === "paused-for-upgrade"), true);
    assert.equal(uploads[1].input.bindings.some(({ name }) =>
      name === "VECTOR_DRAIN_MODE"), false);
    assert.equal(calls.at(-1).role, "target");
    assert.equal(calls.at(-1).method, "deployVersion");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
