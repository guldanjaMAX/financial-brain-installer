import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RUNTIME_IDENTITY_RECEIPT_ARTIFACT_KIND,
  RUNTIME_IDENTITY_RECEIPT_SCHEMA_VERSION,
  RuntimeIdentityReceiptError,
  createRuntimeIdentityReceipt,
  parseRuntimeIdentityReceiptBytes,
  runtimeIdentityArtifactName,
  runtimeIdentityReceiptBytes,
  verifyRuntimeIdentityArtifact,
} from "../scripts/runtime-identity-receipt.mjs";

const SOURCE_SHA = "a".repeat(40);
const PACKAGE_SHA = "b".repeat(64);
const RUNTIME_SHA = "c".repeat(64);
const VERSION = "0.4.8";
const PACKAGE_FILENAME = `brain-installer-${VERSION}.tgz`;
const SCHEME = "brain.runtime-payload.sha256.v1";
const SCRIPT = fileURLToPath(new URL("../scripts/runtime-identity-receipt.mjs", import.meta.url));

function receipt() {
  return createRuntimeIdentityReceipt({
    sourceSha: SOURCE_SHA,
    packageFilename: PACKAGE_FILENAME,
    packageVersion: VERSION,
    packageBytes: 1234,
    packageFileCount: 567,
    packageSha256: PACKAGE_SHA,
    identityScheme: SCHEME,
    runtimePayloadSha256: RUNTIME_SHA,
  });
}

function expectCode(code) {
  return (error) => error instanceof RuntimeIdentityReceiptError && error.code === code;
}

test("the runtime identity receipt has one canonical exact-key schema", () => {
  const value = receipt();
  assert.deepEqual(value, {
    schema_version: RUNTIME_IDENTITY_RECEIPT_SCHEMA_VERSION,
    artifact_kind: RUNTIME_IDENTITY_RECEIPT_ARTIFACT_KIND,
    source_sha: SOURCE_SHA,
    package_filename: PACKAGE_FILENAME,
    package_version: VERSION,
    package_bytes: 1234,
    package_file_count: 567,
    package_sha256: PACKAGE_SHA,
    identity_scheme: SCHEME,
    runtime_payload_sha256: RUNTIME_SHA,
  });
  assert.equal(runtimeIdentityArtifactName(VERSION),
    "brain-installer-0.4.8-runtime-identity.json");
  const bytes = runtimeIdentityReceiptBytes(value);
  assert.deepEqual(parseRuntimeIdentityReceiptBytes(bytes), value);
  assert.equal(bytes.at(-1), 10);
});

test("artifact bytes, producer values, and every consumer expectation are bound", () => {
  const value = receipt();
  const bytes = runtimeIdentityReceiptBytes(value);
  const artifactSha256 = createHash("sha256").update(bytes).digest("hex");
  assert.deepEqual(verifyRuntimeIdentityArtifact({
    bytes,
    artifactSha256,
    artifactBytes: bytes.length,
    expected: {
      sourceSha: SOURCE_SHA,
      packageFilename: PACKAGE_FILENAME,
      packageVersion: VERSION,
      packageBytes: 1234,
      packageFileCount: 567,
      packageSha256: PACKAGE_SHA,
      identityScheme: SCHEME,
      runtimePayloadSha256: RUNTIME_SHA,
    },
  }), value);
  assert.throws(() => verifyRuntimeIdentityArtifact({
    bytes,
    artifactSha256: "d".repeat(64),
    artifactBytes: bytes.length,
  }), expectCode("RUNTIME_IDENTITY_ARTIFACT_MISMATCH"));
  assert.throws(() => verifyRuntimeIdentityArtifact({
    bytes,
    artifactSha256,
    artifactBytes: bytes.length,
    expected: { runtimePayloadSha256: "d".repeat(64) },
  }), expectCode("RUNTIME_IDENTITY_EXPECTATION_MISMATCH"));
});

test("extra keys, duplicate-key encodings, and noncanonical JSON refuse", () => {
  const value = receipt();
  assert.throws(() => parseRuntimeIdentityReceiptBytes(Buffer.from(
    `${JSON.stringify({ ...value, extra: true }, null, 2)}\n`,
  )), expectCode("RUNTIME_IDENTITY_RECEIPT_SCHEMA_INVALID"));
  const canonical = runtimeIdentityReceiptBytes(value).toString("utf8");
  assert.throws(() => parseRuntimeIdentityReceiptBytes(Buffer.from(
    canonical.replace('  "source_sha":', `  "source_sha": "${SOURCE_SHA}",\n  "source_sha":`),
  )), expectCode("RUNTIME_IDENTITY_RECEIPT_ENCODING_INVALID"));
  assert.throws(() => parseRuntimeIdentityReceiptBytes(Buffer.from(
    JSON.stringify(value),
  )), expectCode("RUNTIME_IDENTITY_RECEIPT_ENCODING_INVALID"));
});

test("the CLI creates from verifier JSON and verifies the exact artifact", () => {
  const directory = mkdtempSync(join(tmpdir(), "brain-runtime-identity-"));
  const proofPath = join(directory, "proof.json");
  const receiptPath = join(directory, runtimeIdentityArtifactName(VERSION));
  try {
    writeFileSync(proofPath, JSON.stringify({
      status: "passed",
      archive_bytes: 1234,
      archive_file_count: 567,
      archive_sha256: PACKAGE_SHA,
      identity_scheme: SCHEME,
      runtime_payload_sha256: RUNTIME_SHA,
    }));
    const create = spawnSync(process.execPath, [
      SCRIPT,
      "--create", "receipt",
      "--proof", proofPath,
      "--source-sha", SOURCE_SHA,
      "--package-filename", PACKAGE_FILENAME,
      "--package-version", VERSION,
      "--output", receiptPath,
    ], { encoding: "utf8" });
    assert.equal(create.status, 0, create.stderr || create.stdout);
    const created = JSON.parse(create.stdout);
    const bytes = readFileSync(receiptPath);
    assert.equal(created.artifact_name, runtimeIdentityArtifactName(VERSION));
    assert.equal(created.artifact_bytes, bytes.length);
    assert.equal(created.artifact_sha256,
      createHash("sha256").update(bytes).digest("hex"));
    assert.equal(created.identity_scheme, SCHEME);
    assert.equal(created.runtime_payload_sha256, RUNTIME_SHA);

    const verify = spawnSync(process.execPath, [
      SCRIPT,
      "--verify", "receipt",
      "--receipt", receiptPath,
      "--artifact-sha256", created.artifact_sha256,
      "--artifact-bytes", String(created.artifact_bytes),
      "--source-sha", SOURCE_SHA,
      "--package-filename", PACKAGE_FILENAME,
      "--package-version", VERSION,
      "--package-bytes", "1234",
      "--package-file-count", "567",
      "--package-sha256", PACKAGE_SHA,
      "--identity-scheme", SCHEME,
      "--runtime-payload-sha256", RUNTIME_SHA,
    ], { encoding: "utf8" });
    assert.equal(verify.status, 0, verify.stderr || verify.stdout);
    assert.deepEqual(JSON.parse(verify.stdout), {
      status: "passed",
      identity_scheme: SCHEME,
      runtime_payload_sha256: RUNTIME_SHA,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
