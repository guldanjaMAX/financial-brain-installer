import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  classifyCliCredentialBoundary,
  cmdUpdatePreview,
  readUpdatePreviewAggregateResponse,
  runCliCommandWithCredentialBoundary,
  supportSourceForCommand,
  validateLocalUpdatePreviewManifest,
  updatePreviewDocumentsUrl,
} from "../brain.mjs";
import { renderCliCommands } from "../operations/cli-guidance.mjs";
import * as previewCore from "../operations/update-preview.mjs";

const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);
const MANIFEST_PATH = resolve("test-fixture", "brain.manifest.json");
const MANIFEST = Object.freeze({
  brain: Object.freeze({ version: "0.4.7", domain: "brain.example.invalid" }),
  infrastructure: Object.freeze({
    cloudflare: Object.freeze({
      account_id: "1".repeat(32),
      auth_profile: `financial-brain-${"2".repeat(24)}`,
      storage: "d1",
      d1_database_id: "11111111-2222-4333-8444-555555555555",
    }),
  }),
});

function runtimeProof(runtime = SHA) {
  return Object.freeze({
    schema_version: 1,
    identity_scheme: "brain.runtime-payload.sha256.v1",
    runtime_payload_sha256: runtime,
    file_count: 12,
    total_bytes: 34_567,
    expected_runtime_sha256: SHA,
    verified_passes: 2,
  });
}

function readinessInventory(overrides = {}) {
  const expected = overrides.expected ?? 10;
  const actual = overrides.actual ?? expected;
  const pending = overrides.pending ?? 0;
  const ready = overrides.ready ?? (pending === 0 && actual === expected);
  return {
    version: overrides.version ?? "0.4.7",
    backend: overrides.backend ?? "d1",
    vector_drain_mode: overrides.drainMode ?? "active",
    rows: [{ source_type: "private-source-must-not-escape" }],
    vector_backlog: {
      pending,
      upserts: overrides.upserts ?? pending,
      deletes: overrides.deletes ?? 0,
      submitted: overrides.submitted ?? 0,
      oldest_queued_at: pending > 0 ? 1_750_000_000_000 : null,
    },
    vector_readiness: {
      ready,
      reason: Object.hasOwn(overrides, "reason")
        ? overrides.reason
        : ready ? null : pending > 0 ? "vector_work_queued" : "vector_count_mismatch",
      expected_vectors: expected,
      actual_vectors: actual,
      pending,
      submitted: overrides.submitted ?? 0,
      oldest_queued_at: pending > 0 ? 1_750_000_000_000 : null,
    },
  };
}

function legacyV046Inventory(overrides = {}) {
  const inventory = readinessInventory({ version: "0.4.6", ...overrides });
  delete inventory.version;
  delete inventory.vector_drain_mode;
  return inventory;
}

function streamedResponse(body, {
  status = 200,
  contentLength,
  onRead = () => {},
  onCancel = () => {},
} = {}) {
  const bytes = body instanceof Uint8Array ? body : Buffer.from(String(body), "utf8");
  let sent = false;
  const headers = new Headers();
  if (contentLength !== undefined) headers.set("content-length", String(contentLength));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    body: {
      getReader() {
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            onRead();
            return { done: false, value: bytes };
          },
          async cancel() { onCancel(); },
          releaseLock() {},
        };
      },
    },
  };
}

function inventoryResponse(inventory, options = {}) {
  return streamedResponse(JSON.stringify(inventory), options);
}

function previewOptions(overrides = {}) {
  const raw = JSON.stringify(overrides.manifest ?? MANIFEST);
  const manifest = overrides.manifest ?? MANIFEST;
  return {
    previewLib: previewCore,
    runtimeRoot: "/reviewed-runtime",
    runtimeAllowlist: ["brain.mjs"],
    verifyRuntime: overrides.verifyRuntime ?? (() => runtimeProof()),
    pinRuntimePackage: overrides.pinRuntimePackage ?? (() => ({
      manifest: { name: "brain-installer", version: "0.4.8" },
    })),
    discoverInstalledManifest: overrides.discoverInstalledManifest ?? (() => ({
      path: MANIFEST_PATH,
      source: "explicit",
    })),
    pinManifest: overrides.pinManifest ?? (() => ({
      target: MANIFEST_PATH,
      raw,
      fingerprint: OTHER_SHA,
      manifest,
    })),
    validateManifest: overrides.validateManifest ?? (() => ({
      recordedVersion: manifest.brain.version,
      credential_reference: "present",
    })),
    revalidateManifest: overrides.revalidateManifest ?? (() => {}),
    revalidateRuntimePackage: overrides.revalidateRuntimePackage ?? (() => {}),
    resolveAdminKey: overrides.resolveAdminKey ?? (() => "unit-test-admin-key"),
    request: overrides.request ?? (async () =>
      inventoryResponse(overrides.inventory ?? readinessInventory())),
    write: overrides.write ?? (() => {}),
  };
}

test("credential boundary classifies only the exact historical update grammar as live", () => {
  for (const argv of [
    [],
    ["brain.manifest.json"],
    ["--adopt-cloudflare-profile"],
    ["brain.manifest.json", "--adopt-cloudflare-profile"],
    ["--adopt-cloudflare-profile", "brain.manifest.json"],
  ]) {
    assert.equal(classifyCliCredentialBoundary("update", argv), "update");
  }
  for (const argv of [
    ["--preview", "--json", "--expect-runtime-sha256", SHA],
    ["brain.manifest.json", "--unknown"],
    ["one.json", "two.json"],
    ["--adopt-cloudflare-profile", "--adopt-cloudflare-profile"],
    ["--adopt-cloudflare-profile=true"],
    ["bad\npath"],
  ]) {
    assert.equal(classifyCliCredentialBoundary("update", argv), "update-preview");
  }
  assert.equal(
    classifyCliCredentialBoundary("ingest-file", ["manifest.json", "--json"]),
    "ingest-file-preview",
  );
  assert.equal(
    classifyCliCredentialBoundary("ingest-file", ["manifest.json", "--apply"]),
    "ingest-file-preview",
  );
  assert.equal(
    classifyCliCredentialBoundary("ingest-file", [
      "manifest.json", "--source", "pilot_docs", "--file", "first-source.txt",
      "--expect-runtime-sha256", SHA,
      "--apply", "--approve", SHA,
    ]),
    "ingest-file-apply",
  );
});

test("local update manifest validation inspects references without reading a credential", () => {
  assert.deepEqual(validateLocalUpdatePreviewManifest(MANIFEST), {
    recordedVersion: "0.4.7",
    credential_reference: "adjacent_protected_file",
  });
  const legacy = structuredClone(MANIFEST);
  delete legacy.infrastructure.cloudflare.auth_profile;
  assert.deepEqual(validateLocalUpdatePreviewManifest(legacy), {
    recordedVersion: "0.4.7",
    credential_reference: "adjacent_protected_file",
  });
  const keychain = structuredClone(MANIFEST);
  keychain.operations = {
    admin_key_secret: "keychain://fixture-brain-admin/fixture-owner",
  };
  assert.deepEqual(validateLocalUpdatePreviewManifest(keychain, { platform: "darwin" }), {
    recordedVersion: "0.4.7",
    credential_reference: "keychain",
  });
  assert.throws(() => validateLocalUpdatePreviewManifest(keychain, { platform: "win32" }));
  keychain.operations.admin_key_secret = "keychain://missing-account";
  assert.throws(() => validateLocalUpdatePreviewManifest(keychain, { platform: "darwin" }));
  keychain.operations.admin_key_secret = ["keychain://fixture-brain-admin/fixture-owner"];
  assert.throws(() => validateLocalUpdatePreviewManifest(keychain, { platform: "darwin" }));
  for (const mutate of [
    (value) => { value.infrastructure.cloudflare.account_id = "placeholder"; },
    (value) => { value.infrastructure.cloudflare.account_id = ["1".repeat(32)]; },
    (value) => { value.infrastructure.cloudflare.storage = "supabase"; },
    (value) => { value.infrastructure.cloudflare.d1_database_id = "filled_in_by_provisioner"; },
    (value) => {
      value.infrastructure.cloudflare.d1_database_id = ["11111111-2222-4333-8444-555555555555"];
    },
    (value) => { value.infrastructure.cloudflare.auth_profile = "default"; },
    (value) => { value.brain.version = "04.8.0"; },
    (value) => { value.brain.version = null; },
  ]) {
    const invalid = structuredClone(MANIFEST);
    mutate(invalid);
    assert.throws(() => validateLocalUpdatePreviewManifest(invalid));
  }
});

test("update preview derives only the permanent HTTPS documents endpoint", () => {
  assert.equal(
    updatePreviewDocumentsUrl(MANIFEST),
    "https://brain.example.invalid/api/admin/brain/documents",
  );
  for (const domain of [
    "", " brain.example.invalid ", "http://brain.example.invalid",
    "https://brain.example.invalid",
    "https://owner@example.invalid",
    "https://brain.example.invalid:8443", "https://brain.example.invalid/private",
    "127.0.0.1", "brain.localhost", "brain.local", "metadata.google.internal",
    "brain.home.arpa", `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}.com`,
  ]) {
    const invalid = structuredClone(MANIFEST);
    invalid.brain.domain = domain;
    assert.throws(() => updatePreviewDocumentsUrl(invalid));
  }
  for (const domain of [["brain.example.invalid"], { toString: () => "brain.example.invalid" }]) {
    const invalid = structuredClone(MANIFEST);
    invalid.brain.domain = domain;
    assert.throws(() => updatePreviewDocumentsUrl(invalid));
  }
});

test("update preview bounds the streamed response even when Content-Length is absent or false", async () => {
  const parsed = await readUpdatePreviewAggregateResponse(
    streamedResponse('{"ready":true}'),
    { maxBytes: 32 },
  );
  assert.deepEqual(parsed, { ready: true });

  let cancelled = false;
  await assert.rejects(
    readUpdatePreviewAggregateResponse(
      streamedResponse("x".repeat(33), {
        contentLength: 2,
        onCancel() { cancelled = true; },
      }),
      { maxBytes: 32 },
    ),
  );
  assert.equal(cancelled, true);

  let bodyOpened = false;
  const oversizedHeader = streamedResponse("{}", { contentLength: 33 });
  const originalGetReader = oversizedHeader.body.getReader;
  oversizedHeader.body.getReader = () => {
    bodyOpened = true;
    return originalGetReader();
  };
  await assert.rejects(
    readUpdatePreviewAggregateResponse(oversizedHeader, { maxBytes: 32 }),
  );
  assert.equal(bodyOpened, false);
});

test("update preview verifies runtime before private discovery and closes both identities", async () => {
  const order = [];
  const output = [];
  const receipt = await cmdUpdatePreview([
    "brain.manifest.json",
    "--preview",
    "--expect-runtime-sha256", SHA,
    "--json",
  ], {
    previewLib: previewCore,
    runtimeRoot: "/reviewed-runtime",
    runtimeAllowlist: ["brain.mjs"],
    verifyRuntime(options) {
      order.push("runtime");
      assert.equal(options.root, "/reviewed-runtime");
      assert.deepEqual(options.allowlist, ["brain.mjs"]);
      assert.equal(options.expectedRuntimeSha256, SHA);
      return runtimeProof();
    },
    pinRuntimePackage(root) {
      order.push("pin-runtime-package");
      assert.equal(root, "/reviewed-runtime");
      return { manifest: { name: "brain-installer", version: "0.4.8" } };
    },
    discoverInstalledManifest(path) {
      order.push("discover");
      assert.equal(path, "brain.manifest.json");
      return { path: MANIFEST_PATH, source: "explicit" };
    },
    pinManifest(path) {
      order.push("pin");
      assert.equal(path, MANIFEST_PATH);
      return {
        target: MANIFEST_PATH,
        raw: JSON.stringify(MANIFEST),
        fingerprint: OTHER_SHA,
        manifest: MANIFEST,
      };
    },
    validateManifest(manifest) {
      order.push("manifest");
      assert.equal(manifest, MANIFEST);
      return { recordedVersion: "0.4.7", credential_reference: "present" };
    },
    revalidateManifest(_pin, stage) {
      order.push(`revalidate:${stage}`);
    },
    revalidateRuntimePackage(_pin, stage) {
      order.push(`revalidate-runtime:${stage}`);
    },
    resolveAdminKey(path, options) {
      order.push("credential");
      assert.equal(path, MANIFEST_PATH);
      assert.equal(options.ignoreEnvironment, true);
      assert.equal(options.read(path), JSON.stringify(MANIFEST));
      return "unit-test-admin-key";
    },
    async request(url, init) {
      order.push("request");
      assert.equal(url, "https://brain.example.invalid/api/admin/brain/documents");
      assert.equal(init.method, "GET");
      assert.equal(init.headers["X-Admin-Key"], "unit-test-admin-key");
      assert.equal(Object.hasOwn(init, "body"), false);
      return inventoryResponse(readinessInventory(), {
        onRead() { order.push("response"); },
      });
    },
    write(value) {
      order.push("write");
      output.push(value);
    },
  });
  assert.deepEqual(order, [
    "runtime",
    "pin-runtime-package",
    "discover",
    "pin",
    "manifest",
    "revalidate:local update preview",
    "runtime",
    "revalidate-runtime:update runtime preview",
    "revalidate:update preview credential boundary",
    "credential",
    "revalidate-runtime:update preview live request",
    "revalidate:update preview live request",
    "request",
    "response",
    "runtime",
    "revalidate-runtime:update runtime live receipt",
    "revalidate:update preview live receipt",
    "revalidate-runtime:update runtime receipt",
    "revalidate:update preview receipt",
    "runtime",
    "write",
  ]);
  assert.equal(receipt.status, "pre_update_check_complete");
  assert.equal(receipt.read_only, true);
  assert.equal(receipt.authorizes_update, false);
  assert.equal(receipt.projection_ready, true);
  assert.equal(receipt.plan.manifest.sha256, OTHER_SHA);
  assert.equal(receipt.plan.candidate.expected_runtime_sha256, SHA);
  assert.equal(receipt.plan.deployed_projection.verdict, "ready");
  assert.equal(receipt.plan.deployed_projection.queue.pending, 0);
  assert.equal(receipt.effects.credential_reads, 1);
  assert.equal(receipt.effects.network_requests, 1);
  assert.equal(receipt.effects.brain_writes, 0);
  assert.equal(receipt.effects.cloudflare_control_requests, 0);
  assert.equal(receipt.effects.deployments, 0);
  assert.equal(receipt.effects.support_journal_writes, 0);
  assert.equal(supportSourceForCommand("update-preview"), "brain-data-plane");
  assert.doesNotMatch(output[0], /private-source-must-not-escape|unit-test-admin-key/u);
  assert.deepEqual(JSON.parse(output[0]), receipt);
});

test("recorded v0.4.6 emits one closed legacy observation only after final revalidation", async () => {
  const manifest = structuredClone(MANIFEST);
  manifest.brain.version = "0.4.6";
  const inventory = legacyV046Inventory({
    rows: [{ source_type: "private-source-must-not-escape", title: "Private Owner Record" }],
  });
  const runtimeStages = [];
  const manifestStages = [];
  let runtimeChecks = 0;
  let credentialReads = 0;
  let networkRequests = 0;
  let successWrites = 0;
  await assert.rejects(
    cmdUpdatePreview([
      "brain.manifest.json", "--preview", "--expect-runtime-sha256", SHA, "--json",
    ], previewOptions({
      manifest,
      inventory,
      verifyRuntime() {
        runtimeChecks += 1;
        return runtimeProof();
      },
      revalidateRuntimePackage(_pin, stage) {
        runtimeStages.push(stage);
      },
      revalidateManifest(_pin, stage) {
        manifestStages.push(stage);
      },
      resolveAdminKey() {
        credentialReads += 1;
        return "unit-test-admin-key";
      },
      async request() {
        networkRequests += 1;
        return inventoryResponse(inventory);
      },
      write() { successWrites += 1; },
    })),
    (error) => {
      assert.equal(error.constructor.name, "JsonFatal");
      const receipt = error.payload;
      assert.equal(receipt.status, "legacy_observation_complete");
      assert.equal(receipt.error_code, "UPDATE_PREVIEW_LEGACY_GENERATION_UNBOUND");
      assert.equal(receipt.read_only, true);
      assert.equal(receipt.authorizes_update, false);
      assert.equal(receipt.projection_ready, false);
      assert.equal(receipt.legacy_observation.manifest.recorded_version, "0.4.6");
      assert.equal(receipt.legacy_observation.manifest.sha256, OTHER_SHA);
      assert.equal(receipt.legacy_observation.candidate.version, "0.4.8");
      assert.equal(receipt.legacy_observation.candidate.observed_runtime_sha256, SHA);
      assert.equal(
        receipt.legacy_observation.response_contract,
        "brain.documents.v0.4.6.legacy",
      );
      assert.equal(
        receipt.legacy_observation.generation_binding,
        "absent_from_authenticated_response",
      );
      assert.equal(
        receipt.legacy_observation.drain_mode_binding,
        "absent_from_authenticated_response",
      );
      assert.equal(receipt.legacy_observation.mixed_generation_excluded, false);
      assert.equal(receipt.legacy_observation.update_gate_satisfied, false);
      assert.equal(
        receipt.legacy_observation.deployed_projection_observation.worker_reported_verdict,
        "ready",
      );
      assert.match(receipt.observation_fingerprint, /^[a-f0-9]{64}$/u);
      assert.equal(Object.hasOwn(receipt, "plan"), false);
      assert.equal(Object.hasOwn(receipt, "plan_fingerprint"), false);
      for (const [name, value] of Object.entries(receipt.effects)) {
        assert.equal(
          value,
          name === "credential_reads" || name === "network_requests" ? 1 : 0,
          `${name} must report the exact read-only boundary`,
        );
      }
      assert.doesNotMatch(
        `${error.message}\n${JSON.stringify(receipt)}`,
        /private-source-must-not-escape|Private Owner Record|unit-test-admin-key/u,
      );
      return true;
    },
  );
  assert.equal(runtimeChecks, 4);
  assert.deepEqual(runtimeStages, [
    "update runtime preview",
    "update preview live request",
    "update runtime live receipt",
    "update runtime receipt",
  ]);
  assert.deepEqual(manifestStages, [
    "local update preview",
    "update preview credential boundary",
    "update preview live request",
    "update preview live receipt",
    "update preview receipt",
  ]);
  assert.equal(credentialReads, 1);
  assert.equal(networkRequests, 1);
  assert.equal(successWrites, 0, "the non-green legacy receipt cannot use the success writer");
});

test("an unversioned response cannot enter the v0.4.6 legacy lane for another manifest", async () => {
  await assert.rejects(
    cmdUpdatePreview([
      "brain.manifest.json", "--preview", "--expect-runtime-sha256", SHA, "--json",
    ], previewOptions({ inventory: legacyV046Inventory() })),
    (error) => {
      assert.equal(error.payload?.error_code, "UPDATE_PREVIEW_READINESS_RECEIPT_INVALID");
      assert.equal(error.payload?.effects.credential_reads, 1);
      assert.equal(error.payload?.effects.network_requests, 1);
      assert.equal(Object.hasOwn(error.payload, "legacy_observation"), false);
      assert.equal(Object.hasOwn(error.payload, "observation_fingerprint"), false);
      return true;
    },
  );
});

test("partial or extended v0.4.6 envelopes fail as ordinary invalid receipts", async () => {
  const manifest = structuredClone(MANIFEST);
  manifest.brain.version = "0.4.6";
  const missingVersion = readinessInventory({ version: "0.4.6" });
  delete missingVersion.version;
  const missingDrainMode = readinessInventory({ version: "0.4.6" });
  delete missingDrainMode.vector_drain_mode;
  const extraLegacyField = {
    ...legacyV046Inventory(),
    private_provider_detail: "must-not-pass",
  };
  for (const inventory of [missingVersion, missingDrainMode, extraLegacyField]) {
    await assert.rejects(
      cmdUpdatePreview([
        "brain.manifest.json", "--preview", "--expect-runtime-sha256", SHA, "--json",
      ], previewOptions({ manifest, inventory })),
      (error) => {
        assert.equal(error.payload?.status, "failed");
        assert.equal(error.payload?.error_code, "UPDATE_PREVIEW_READINESS_RECEIPT_INVALID");
        assert.equal(error.payload?.effects.credential_reads, 1);
        assert.equal(error.payload?.effects.network_requests, 1);
        assert.equal(Object.hasOwn(error.payload, "legacy_observation"), false);
        assert.equal(Object.hasOwn(error.payload, "observation_fingerprint"), false);
        assert.doesNotMatch(error.message, /private_provider_detail|must-not-pass/u);
        return true;
      },
    );
  }
});

test("runtime mismatch refuses before manifest discovery and emits no private detail", async () => {
  let discovered = false;
  await assert.rejects(
    cmdUpdatePreview([
      "--preview", "--expect-runtime-sha256", SHA, "--json",
    ], {
      previewLib: previewCore,
      runtimeRoot: "/private/runtime-that-must-not-print",
      runtimeAllowlist: ["brain.mjs"],
      verifyRuntime() {
        throw new previewCore.UpdatePreviewError("UPDATE_PREVIEW_RUNTIME_PAYLOAD_MISMATCH");
      },
      discoverInstalledManifest() {
        discovered = true;
      },
      write() {
        throw new Error("failure must not write a success receipt");
      },
    }),
    (error) => {
      assert.equal(error.payload?.error_code, "UPDATE_PREVIEW_RUNTIME_PAYLOAD_MISMATCH");
      assert.doesNotMatch(error.message, /private|runtime-that-must-not-print/u);
      return true;
    },
  );
  assert.equal(discovered, false);
});

test("a locally provable downgrade refuses before credential and network access", async () => {
  const manifest = structuredClone(MANIFEST);
  manifest.brain.version = "0.4.9";
  let credentialReads = 0;
  let requests = 0;
  await assert.rejects(
    cmdUpdatePreview([
      "brain.manifest.json", "--preview", "--expect-runtime-sha256", SHA, "--json",
    ], previewOptions({
      manifest,
      resolveAdminKey() { credentialReads += 1; },
      async request() { requests += 1; },
    })),
    (error) => {
      assert.equal(error.payload?.error_code, "UPDATE_PREVIEW_DOWNGRADE_REFUSED");
      assert.equal(error.payload?.effects.credential_reads, 0);
      assert.equal(error.payload?.effects.network_requests, 0);
      return true;
    },
  );
  assert.equal(credentialReads, 0);
  assert.equal(requests, 0);
});

test("an overlong local version refuses before credential and network access", async () => {
  let credentialReads = 0;
  let requests = 0;
  await assert.rejects(
    cmdUpdatePreview([
      "brain.manifest.json", "--preview", "--expect-runtime-sha256", SHA, "--json",
    ], previewOptions({
      pinRuntimePackage: () => ({
        manifest: { name: "brain-installer", version: `${"1".repeat(129)}.0.0` },
      }),
      resolveAdminKey() { credentialReads += 1; },
      async request() { requests += 1; },
    })),
    (error) => {
      assert.equal(error.payload?.error_code, "UPDATE_PREVIEW_PLAN_INVALID");
      assert.equal(error.payload?.effects.credential_reads, 0);
      assert.equal(error.payload?.effects.network_requests, 0);
      return true;
    },
  );
  assert.equal(credentialReads, 0);
  assert.equal(requests, 0);
});

test("an invalid durable-key locator refuses before the credential boundary", async () => {
  const manifest = structuredClone(MANIFEST);
  manifest.operations = { admin_key_secret: "keychain://missing-account" };
  let credentialReads = 0;
  let requests = 0;
  await assert.rejects(
    cmdUpdatePreview([
      "brain.manifest.json", "--preview", "--expect-runtime-sha256", SHA, "--json",
    ], previewOptions({
      manifest,
      validateManifest: (value) => validateLocalUpdatePreviewManifest(value, {
        platform: "darwin",
      }),
      resolveAdminKey() { credentialReads += 1; },
      async request() { requests += 1; },
    })),
    (error) => {
      assert.equal(error.payload?.error_code, "UPDATE_PREVIEW_FAILED");
      assert.equal(error.payload?.effects.credential_reads, 0);
      assert.equal(error.payload?.effects.network_requests, 0);
      assert.equal(error.payload?.authorizes_update, false);
      return true;
    },
  );
  assert.equal(credentialReads, 0);
  assert.equal(requests, 0);
});

test("unsafe or absent Brain domain refuses before credential and network access", async () => {
  const manifest = structuredClone(MANIFEST);
  manifest.brain.domain = "http://private-owner.example.invalid/path";
  let credentialReads = 0;
  let requests = 0;
  await assert.rejects(
    cmdUpdatePreview([
      "brain.manifest.json", "--preview", "--expect-runtime-sha256", SHA, "--json",
    ], previewOptions({
      manifest,
      resolveAdminKey() { credentialReads += 1; },
      async request() { requests += 1; },
    })),
    (error) => {
      assert.equal(error.payload?.error_code, "UPDATE_PREVIEW_BRAIN_DOMAIN_INVALID");
      assert.equal(error.payload?.effects.credential_reads, 0);
      assert.equal(error.payload?.effects.network_requests, 0);
      assert.doesNotMatch(error.message, /private-owner|example\.invalid/u);
      return true;
    },
  );
  assert.equal(credentialReads, 0);
  assert.equal(requests, 0);
});

test("missing durable admin key records one credential read and no request", async () => {
  let requests = 0;
  await assert.rejects(
    cmdUpdatePreview([
      "brain.manifest.json", "--preview", "--expect-runtime-sha256", SHA, "--json",
    ], previewOptions({
      resolveAdminKey(_path, options) {
        assert.equal(options.ignoreEnvironment, true);
        return undefined;
      },
      async request() { requests += 1; },
    })),
    (error) => {
      assert.equal(error.payload?.error_code, "UPDATE_PREVIEW_ADMIN_KEY_UNAVAILABLE");
      assert.equal(error.payload?.effects.credential_reads, 1);
      assert.equal(error.payload?.effects.network_requests, 0);
      assert.equal(error.payload?.effects.brain_writes, 0);
      return true;
    },
  );
  assert.equal(requests, 0);
});

test("manifest drift after credential lookup stops before the live request", async () => {
  let requests = 0;
  let validations = 0;
  await assert.rejects(
    cmdUpdatePreview([
      "brain.manifest.json", "--preview", "--expect-runtime-sha256", SHA, "--json",
    ], previewOptions({
      revalidateManifest() {
        validations += 1;
        if (validations === 3) throw new Error("private manifest replacement");
      },
      async request() { requests += 1; },
    })),
    (error) => {
      assert.equal(error.payload?.error_code, "UPDATE_PREVIEW_FAILED");
      assert.equal(error.payload?.effects.credential_reads, 1);
      assert.equal(error.payload?.effects.network_requests, 0);
      assert.doesNotMatch(error.message, /private manifest replacement/u);
      return true;
    },
  );
  assert.equal(requests, 0);
});

test("transport and malformed response failures report the crossed read boundaries", async () => {
  for (const request of [
    async () => { throw new Error("private transport and customer hostname"); },
    async () => streamedResponse("private non-json customer response"),
  ]) {
    await assert.rejects(
      cmdUpdatePreview([
        "brain.manifest.json", "--preview", "--expect-runtime-sha256", SHA, "--json",
      ], previewOptions({ request })),
      (error) => {
        assert.equal(error.payload?.effects.credential_reads, 1);
        assert.equal(error.payload?.effects.network_requests, 1);
        assert.equal(error.payload?.effects.brain_writes, 0);
        assert.equal(error.payload?.effects.cloudflare_control_requests, 0);
        assert.equal(error.payload?.effects.deployments, 0);
        assert.equal(error.payload?.effects.support_journal_writes, 0);
        assert.doesNotMatch(error.message, /private|customer hostname|non-json/u);
        return true;
      },
    );
  }
});

test("the default preview transport uses one 120-second request with no retry", async () => {
  let calls = 0;
  const options = previewOptions();
  delete options.request;
  options.httpRequest = async (url, init, transport) => {
    calls += 1;
    assert.equal(url, "https://brain.example.invalid/api/admin/brain/documents");
    assert.equal(init.method, "GET");
    assert.equal(init.headers["X-Admin-Key"], "unit-test-admin-key");
    assert.deepEqual(transport, {
      timeoutMs: 120_000,
      what: "the update preview readiness check",
    });
    throw new Error("private one-shot transport refusal");
  };
  await assert.rejects(
    cmdUpdatePreview([
      "brain.manifest.json", "--preview", "--expect-runtime-sha256", SHA, "--json",
    ], options),
    (error) => {
      assert.equal(error.payload?.error_code, "UPDATE_PREVIEW_READINESS_UNAVAILABLE");
      assert.equal(error.payload?.effects.credential_reads, 1);
      assert.equal(error.payload?.effects.network_requests, 1);
      assert.doesNotMatch(error.message, /private one-shot transport refusal/u);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("a transport refusal cannot hide runtime, package, or manifest drift in postflight", async () => {
  const cases = [
    {
      expectedCode: "UPDATE_PREVIEW_RUNTIME_PAYLOAD_CHANGED",
      options: {
        verifyRuntime: (() => {
          let checks = 0;
          return () => runtimeProof(++checks === 3 ? OTHER_SHA : SHA);
        })(),
      },
    },
    {
      expectedCode: "UPDATE_PREVIEW_FAILED",
      options: {
        revalidateRuntimePackage(_pin, stage) {
          if (stage === "update runtime live receipt") {
            throw new Error("private package drift");
          }
        },
      },
    },
    {
      expectedCode: "UPDATE_PREVIEW_FAILED",
      options: {
        revalidateManifest(_pin, stage) {
          if (stage === "update preview live receipt") {
            throw new Error("private manifest drift");
          }
        },
      },
    },
  ];
  for (const { expectedCode, options } of cases) {
    await assert.rejects(
      cmdUpdatePreview([
        "brain.manifest.json", "--preview", "--expect-runtime-sha256", SHA, "--json",
      ], previewOptions({
        ...options,
        async request() { throw new Error("private transport detail"); },
      })),
      (error) => {
        assert.equal(error.payload?.error_code, expectedCode);
        assert.equal(error.payload?.effects.credential_reads, 1);
        assert.equal(error.payload?.effects.network_requests, 1);
        assert.doesNotMatch(error.message, /private|package drift|manifest drift|transport detail/u);
        return true;
      },
    );
  }
});

test("update preview requires exact HTTP 200 and bounds a false-length body", async () => {
  for (const [request, expectedCode] of [
    [async () => inventoryResponse(readinessInventory(), { status: 201 }),
      "UPDATE_PREVIEW_READINESS_UNAVAILABLE"],
    [async () => streamedResponse(new Uint8Array((4 * 1024 * 1024) + 1), {
      contentLength: 2,
    }), "UPDATE_PREVIEW_READINESS_RECEIPT_INVALID"],
  ]) {
    await assert.rejects(
      cmdUpdatePreview([
        "brain.manifest.json", "--preview", "--expect-runtime-sha256", SHA, "--json",
      ], previewOptions({ request })),
      (error) => {
        assert.equal(error.payload?.error_code, expectedCode);
        assert.equal(error.payload?.effects.credential_reads, 1);
        assert.equal(error.payload?.effects.network_requests, 1);
        assert.equal(error.payload?.effects.brain_writes, 0);
        return true;
      },
    );
  }
});

test("zero-queue projection shortfall emits a fingerprinted non-authorizing refusal", async () => {
  let successWrites = 0;
  await assert.rejects(
    cmdUpdatePreview([
      "brain.manifest.json", "--preview", "--expect-runtime-sha256", SHA, "--json",
    ], previewOptions({
      inventory: readinessInventory({
        expected: 1_151_274,
        actual: 62_439,
        reason: "vector_count_mismatch",
      }),
      write() { successWrites += 1; },
    })),
    (error) => {
      const receipt = error.payload;
      assert.equal(receipt.error_code, "UPDATE_PREVIEW_PROJECTION_WORK_MISSING");
      assert.equal(receipt.authorizes_update, false);
      assert.equal(receipt.plan.deployed_projection.queue.pending, 0);
      assert.equal(receipt.plan.deployed_projection.expected_vectors, 1_151_274);
      assert.equal(receipt.plan.deployed_projection.actual_vectors, 62_439);
      assert.match(receipt.plan_fingerprint, /^[a-f0-9]{64}$/u);
      assert.equal(receipt.effects.credential_reads, 1);
      assert.equal(receipt.effects.network_requests, 1);
      assert.doesNotMatch(error.message, /private-source-must-not-escape|unit-test-admin-key/u);
      return true;
    },
  );
  assert.equal(successWrites, 0);
});

test("queued shortfall is reported as recoverable work, never as readiness", async () => {
  let output = "";
  const receipt = await cmdUpdatePreview([
    "brain.manifest.json", "--preview", "--expect-runtime-sha256", SHA, "--json",
  ], previewOptions({
    inventory: readinessInventory({ expected: 10, actual: 2, pending: 8 }),
    write(value) { output = value; },
  }));
  assert.equal(receipt.status, "pre_update_check_complete");
  assert.equal(receipt.authorizes_update, false);
  assert.equal(receipt.projection_ready, false);
  assert.equal(receipt.plan.deployed_projection.verdict, "recoverable_queued_work");
  assert.equal(receipt.plan.deployed_projection.query_ready, false);
  assert.equal(receipt.plan.deployed_projection.queue.pending, 8);
  assert.doesNotMatch(output, /private-source-must-not-escape|unit-test-admin-key/u);
});

test("delete-only and undersized upsert queues emit fingerprinted insufficiency refusals", async () => {
  for (const queue of [
    { pending: 8, upserts: 0, deletes: 8 },
    { pending: 8, upserts: 7, deletes: 1 },
  ]) {
    let successWrites = 0;
    await assert.rejects(
      cmdUpdatePreview([
        "brain.manifest.json", "--preview", "--expect-runtime-sha256", SHA, "--json",
      ], previewOptions({
        inventory: readinessInventory({ expected: 10, actual: 2, ...queue }),
        write() { successWrites += 1; },
      })),
      (error) => {
        const receipt = error.payload;
        assert.equal(receipt.error_code, "UPDATE_PREVIEW_PROJECTION_WORK_INSUFFICIENT");
        assert.equal(receipt.authorizes_update, false);
        assert.equal(receipt.projection_ready, false);
        assert.equal(receipt.plan.deployed_projection.verdict, "projection_work_insufficient");
        assert.equal(receipt.plan.deployed_projection.queue.upserts, queue.upserts);
        assert.match(receipt.plan_fingerprint, /^[a-f0-9]{64}$/u);
        assert.equal(receipt.effects.credential_reads, 1);
        assert.equal(receipt.effects.network_requests, 1);
        return true;
      },
    );
    assert.equal(successWrites, 0);
  }
});

test("runtime drift after the live read fails with honest 1/1 effects", async () => {
  let checks = 0;
  await assert.rejects(
    cmdUpdatePreview([
      "brain.manifest.json", "--preview", "--expect-runtime-sha256", SHA, "--json",
    ], previewOptions({
      verifyRuntime() {
        checks += 1;
        return runtimeProof(checks === 3 ? OTHER_SHA : SHA);
      },
    })),
    (error) => {
      assert.equal(error.payload?.error_code, "UPDATE_PREVIEW_RUNTIME_PAYLOAD_CHANGED");
      assert.equal(error.payload?.effects.credential_reads, 1);
      assert.equal(error.payload?.effects.network_requests, 1);
      return true;
    },
  );
  assert.equal(checks, 3);
});

test("runtime drift at final receipt construction fails with honest 1/1 effects", async () => {
  let checks = 0;
  let successWrites = 0;
  await assert.rejects(
    cmdUpdatePreview([
      "brain.manifest.json", "--preview", "--expect-runtime-sha256", SHA, "--json",
    ], previewOptions({
      verifyRuntime() {
        checks += 1;
        return runtimeProof(checks === 4 ? OTHER_SHA : SHA);
      },
      write() { successWrites += 1; },
    })),
    (error) => {
      assert.equal(error.payload?.error_code, "UPDATE_PREVIEW_RUNTIME_PAYLOAD_CHANGED");
      assert.equal(error.payload?.effects.credential_reads, 1);
      assert.equal(error.payload?.effects.network_requests, 1);
      return true;
    },
  );
  assert.equal(checks, 4);
  assert.equal(successWrites, 0);
});

test("the update-preview wrapper never calls the Wrangler-session boundary", async () => {
  let wrapperCalls = 0;
  const result = await runCliCommandWithCredentialBoundary(
    "update-preview",
    () => "data-plane-only",
    { withWranglerSession() { wrapperCalls += 1; } },
  );
  assert.equal(result, "data-plane-only");
  assert.equal(wrapperCalls, 0);
});

test("CLI help describes the authenticated aggregate read without claiming local-only access", () => {
  const result = spawnSync(process.execPath, [resolve("brain.mjs"), "help"], {
    cwd: resolve("."),
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const previewHelp = result.stdout.slice(result.stdout.indexOf(
    renderCliCommands("brain update     [manifest] --preview"),
  ));
  assert.match(previewHelp, /one authenticated aggregate\s+Brain read/u);
  assert.match(previewHelp, /no control-plane request, write, deploy/u);
  assert.doesNotMatch(previewHelp.slice(0, 400), /local preflight|no credential,\s+network/u);
});

test("malformed preview CLI returns one fixed JSON refusal with no support journal", () => {
  const privateHome = mkdtempSync(join(tmpdir(), "brain-update-preview-cli-"));
  try {
    const result = spawnSync(process.execPath, [
      resolve("brain.mjs"), "update", "--preview", "--json",
    ], {
      cwd: resolve("."),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH || "",
        HOME: privateHome,
        USERPROFILE: privateHome,
      },
      timeout: 30_000,
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.operation, "brain.update.preview");
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.authorizes_update, false);
    assert.equal(receipt.projection_ready, false);
    assert.equal(receipt.effects.credential_reads, 0);
    assert.equal(receipt.effects.network_requests, 0);
    assert.equal(existsSync(join(privateHome, ".brain", "support")), false);
  } finally {
    rmSync(privateHome, { recursive: true, force: true });
  }
});
