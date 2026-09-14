import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  classifyCliCredentialBoundary,
  cmdUpdatePreview,
  runCliCommandWithCredentialBoundary,
  validateLocalUpdatePreviewManifest,
} from "../brain.mjs";
import * as previewCore from "../operations/update-preview.mjs";

const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);
const MANIFEST = Object.freeze({
  brain: Object.freeze({ version: "0.4.7" }),
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
    credential_reference: "present",
  });
  const legacy = structuredClone(MANIFEST);
  delete legacy.infrastructure.cloudflare.auth_profile;
  legacy.brain.version = null;
  assert.deepEqual(validateLocalUpdatePreviewManifest(legacy), {
    recordedVersion: null,
    credential_reference: "legacy_absent",
  });
  for (const mutate of [
    (value) => { value.infrastructure.cloudflare.account_id = "placeholder"; },
    (value) => { value.infrastructure.cloudflare.storage = "supabase"; },
    (value) => { value.infrastructure.cloudflare.d1_database_id = "filled_in_by_provisioner"; },
    (value) => { value.infrastructure.cloudflare.auth_profile = "default"; },
    (value) => { value.brain.version = "04.8.0"; },
  ]) {
    const invalid = structuredClone(MANIFEST);
    mutate(invalid);
    assert.throws(() => validateLocalUpdatePreviewManifest(invalid));
  }
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
      return { path: "/private/brain.manifest.json", source: "explicit" };
    },
    pinManifest(path) {
      order.push("pin");
      assert.equal(path, "/private/brain.manifest.json");
      return { fingerprint: OTHER_SHA, manifest: MANIFEST };
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
    "revalidate-runtime:update runtime receipt",
    "revalidate:update preview receipt",
    "write",
  ]);
  assert.equal(receipt.status, "local_preflight_passed");
  assert.equal(receipt.read_only, true);
  assert.equal(receipt.plan.manifest.sha256, OTHER_SHA);
  assert.equal(receipt.plan.candidate.expected_runtime_sha256, SHA);
  assert.deepEqual(JSON.parse(output[0]), receipt);
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

test("the update-preview wrapper never calls the Wrangler-session boundary", async () => {
  let wrapperCalls = 0;
  const result = await runCliCommandWithCredentialBoundary(
    "update-preview",
    () => "local-only",
    { withWranglerSession() { wrapperCalls += 1; } },
  );
  assert.equal(result, "local-only");
  assert.equal(wrapperCalls, 0);
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
    assert.equal(receipt.effects.credential_reads, 0);
    assert.equal(receipt.effects.network_requests, 0);
    assert.equal(existsSync(join(privateHome, ".brain", "support")), false);
  } finally {
    rmSync(privateHome, { recursive: true, force: true });
  }
});
