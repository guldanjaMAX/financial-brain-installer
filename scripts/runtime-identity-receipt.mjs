#!/usr/bin/env node
/**
 * Create or verify the small, non-secret receipt that transports the exact
 * package runtime identity out of the package-producing CI job.
 *
 * The package artifact remains the executable authority. This receipt binds
 * the runtime-payload digest derived from those exact bytes to the same source
 * commit and package identity so downstream jobs and the held Windows kit do
 * not have to scrape logs or trust a recomputed ambient install.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

import { UPDATE_RUNTIME_IDENTITY_SCHEME } from "../operations/update-preview.mjs";

export const RUNTIME_IDENTITY_RECEIPT_SCHEMA_VERSION = 1;
export const RUNTIME_IDENTITY_RECEIPT_ARTIFACT_KIND =
  "financial_brain_package_runtime_identity";

const SHA256_RE = /^[a-f0-9]{64}$/u;
const SOURCE_SHA_RE = /^[a-f0-9]{40}$/u;
const VERSION_RE = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const MAX_RECEIPT_BYTES = 4096;
const MAX_PROOF_BYTES = 1024 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const RECEIPT_KEYS = Object.freeze([
  "artifact_kind",
  "identity_scheme",
  "package_bytes",
  "package_file_count",
  "package_filename",
  "package_sha256",
  "package_version",
  "runtime_payload_sha256",
  "schema_version",
  "source_sha",
]);

export class RuntimeIdentityReceiptError extends Error {
  constructor(code) {
    super(code);
    this.name = "RuntimeIdentityReceiptError";
    this.code = code;
  }
}

function refuse(code) {
  throw new RuntimeIdentityReceiptError(code);
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected);
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) refuse(code);
  return value;
}

function sha256(value, code) {
  if (!SHA256_RE.test(String(value || ""))) refuse(code);
  return value;
}

function version(value) {
  if (!VERSION_RE.test(String(value || ""))) refuse("RUNTIME_IDENTITY_VERSION_INVALID");
  return value;
}

export function runtimeIdentityArtifactName(packageVersion) {
  const checkedVersion = version(packageVersion);
  return `brain-installer-${checkedVersion}-runtime-identity.json`;
}

export function createRuntimeIdentityReceipt({
  sourceSha,
  packageFilename,
  packageVersion,
  packageBytes,
  packageFileCount,
  packageSha256,
  identityScheme,
  runtimePayloadSha256,
} = {}) {
  const checkedVersion = version(packageVersion);
  if (!SOURCE_SHA_RE.test(String(sourceSha || ""))) {
    refuse("RUNTIME_IDENTITY_SOURCE_SHA_INVALID");
  }
  if (packageFilename !== `brain-installer-${checkedVersion}.tgz`) {
    refuse("RUNTIME_IDENTITY_PACKAGE_FILENAME_INVALID");
  }
  if (identityScheme !== UPDATE_RUNTIME_IDENTITY_SCHEME) {
    refuse("RUNTIME_IDENTITY_SCHEME_INVALID");
  }
  return Object.freeze({
    schema_version: RUNTIME_IDENTITY_RECEIPT_SCHEMA_VERSION,
    artifact_kind: RUNTIME_IDENTITY_RECEIPT_ARTIFACT_KIND,
    source_sha: sourceSha,
    package_filename: packageFilename,
    package_version: checkedVersion,
    package_bytes: positiveInteger(packageBytes, "RUNTIME_IDENTITY_PACKAGE_BYTES_INVALID"),
    package_file_count: positiveInteger(
      packageFileCount,
      "RUNTIME_IDENTITY_PACKAGE_FILE_COUNT_INVALID",
    ),
    package_sha256: sha256(packageSha256, "RUNTIME_IDENTITY_PACKAGE_SHA256_INVALID"),
    identity_scheme: identityScheme,
    runtime_payload_sha256: sha256(
      runtimePayloadSha256,
      "RUNTIME_IDENTITY_RUNTIME_PAYLOAD_SHA256_INVALID",
    ),
  });
}

export function runtimeIdentityReceiptBytes(receipt) {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

export function parseRuntimeIdentityReceiptBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_RECEIPT_BYTES) {
    refuse("RUNTIME_IDENTITY_RECEIPT_BYTES_INVALID");
  }
  let text;
  let parsed;
  try {
    text = UTF8.decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    refuse("RUNTIME_IDENTITY_RECEIPT_JSON_INVALID");
  }
  if (!exactKeys(parsed, RECEIPT_KEYS) ||
      parsed.schema_version !== RUNTIME_IDENTITY_RECEIPT_SCHEMA_VERSION ||
      parsed.artifact_kind !== RUNTIME_IDENTITY_RECEIPT_ARTIFACT_KIND) {
    refuse("RUNTIME_IDENTITY_RECEIPT_SCHEMA_INVALID");
  }
  const receipt = createRuntimeIdentityReceipt({
    sourceSha: parsed.source_sha,
    packageFilename: parsed.package_filename,
    packageVersion: parsed.package_version,
    packageBytes: parsed.package_bytes,
    packageFileCount: parsed.package_file_count,
    packageSha256: parsed.package_sha256,
    identityScheme: parsed.identity_scheme,
    runtimePayloadSha256: parsed.runtime_payload_sha256,
  });
  const canonical = runtimeIdentityReceiptBytes(receipt);
  try {
    if (!canonical.equals(bytes)) refuse("RUNTIME_IDENTITY_RECEIPT_ENCODING_INVALID");
  } finally {
    canonical.fill(0);
  }
  return receipt;
}

export function verifyRuntimeIdentityArtifact({
  bytes,
  artifactSha256,
  artifactBytes,
  expected = {},
} = {}) {
  if (!Buffer.isBuffer(bytes) ||
      positiveInteger(artifactBytes, "RUNTIME_IDENTITY_ARTIFACT_BYTES_INVALID") !== bytes.length ||
      sha256(artifactSha256, "RUNTIME_IDENTITY_ARTIFACT_SHA256_INVALID") !==
        createHash("sha256").update(bytes).digest("hex")) {
    refuse("RUNTIME_IDENTITY_ARTIFACT_MISMATCH");
  }
  const receipt = parseRuntimeIdentityReceiptBytes(bytes);
  const checks = {
    source_sha: expected.sourceSha,
    package_filename: expected.packageFilename,
    package_version: expected.packageVersion,
    package_bytes: expected.packageBytes,
    package_file_count: expected.packageFileCount,
    package_sha256: expected.packageSha256,
    identity_scheme: expected.identityScheme,
    runtime_payload_sha256: expected.runtimePayloadSha256,
  };
  for (const [key, value] of Object.entries(checks)) {
    if (value !== undefined && receipt[key] !== value) {
      refuse("RUNTIME_IDENTITY_EXPECTATION_MISMATCH");
    }
  }
  return receipt;
}

function optionMap(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--") || result.has(name)) {
      refuse("RUNTIME_IDENTITY_ARGUMENTS_INVALID");
    }
    result.set(name, value);
  }
  return result;
}

function required(options, name) {
  const value = options.get(name);
  if (!value) refuse("RUNTIME_IDENTITY_ARGUMENTS_INVALID");
  return value;
}

function safeReadJson(path, limit, code) {
  let bytes;
  try { bytes = readFileSync(resolve(path)); }
  catch { refuse(code); }
  try {
    if (bytes.length < 1 || bytes.length > limit) refuse(code);
    return JSON.parse(UTF8.decode(bytes));
  } catch (error) {
    if (error instanceof RuntimeIdentityReceiptError) throw error;
    refuse(code);
  } finally {
    bytes?.fill(0);
  }
}

function createFromProof(options) {
  const allowed = new Set([
    "--create", "--proof", "--source-sha", "--package-filename",
    "--package-version", "--output",
  ]);
  if ([...options.keys()].some((key) => !allowed.has(key)) ||
      required(options, "--create") !== "receipt") {
    refuse("RUNTIME_IDENTITY_ARGUMENTS_INVALID");
  }
  const proof = safeReadJson(
    required(options, "--proof"),
    MAX_PROOF_BYTES,
    "RUNTIME_IDENTITY_PROOF_INVALID",
  );
  if (proof?.status !== "passed") refuse("RUNTIME_IDENTITY_PROOF_INVALID");
  const receipt = createRuntimeIdentityReceipt({
    sourceSha: required(options, "--source-sha"),
    packageFilename: required(options, "--package-filename"),
    packageVersion: required(options, "--package-version"),
    packageBytes: proof.archive_bytes,
    packageFileCount: proof.archive_file_count,
    packageSha256: proof.archive_sha256,
    identityScheme: proof.identity_scheme,
    runtimePayloadSha256: proof.runtime_payload_sha256,
  });
  const output = resolve(required(options, "--output"));
  if (basename(output) !== runtimeIdentityArtifactName(receipt.package_version)) {
    refuse("RUNTIME_IDENTITY_ARTIFACT_NAME_INVALID");
  }
  const bytes = runtimeIdentityReceiptBytes(receipt);
  try {
    writeFileSync(output, bytes, { flag: "wx", mode: 0o600 });
    return Object.freeze({
      status: "passed",
      artifact_name: basename(output),
      artifact_path: output,
      artifact_bytes: bytes.length,
      artifact_sha256: createHash("sha256").update(bytes).digest("hex"),
      identity_scheme: receipt.identity_scheme,
      runtime_payload_sha256: receipt.runtime_payload_sha256,
    });
  } catch (error) {
    if (error instanceof RuntimeIdentityReceiptError) throw error;
    refuse("RUNTIME_IDENTITY_ARTIFACT_WRITE_FAILED");
  } finally {
    bytes.fill(0);
  }
}

function numberOption(options, name) {
  const value = required(options, name);
  if (!/^[1-9][0-9]*$/u.test(value)) refuse("RUNTIME_IDENTITY_ARGUMENTS_INVALID");
  const number = Number(value);
  if (!Number.isSafeInteger(number)) refuse("RUNTIME_IDENTITY_ARGUMENTS_INVALID");
  return number;
}

function verifyFromOptions(options) {
  const allowed = new Set([
    "--verify", "--receipt", "--artifact-sha256", "--artifact-bytes",
    "--source-sha", "--package-filename", "--package-version",
    "--package-bytes", "--package-file-count", "--package-sha256",
    "--identity-scheme", "--runtime-payload-sha256",
  ]);
  if ([...options.keys()].some((key) => !allowed.has(key)) ||
      required(options, "--verify") !== "receipt") {
    refuse("RUNTIME_IDENTITY_ARGUMENTS_INVALID");
  }
  const receiptPath = resolve(required(options, "--receipt"));
  let bytes;
  try { bytes = readFileSync(receiptPath); }
  catch { refuse("RUNTIME_IDENTITY_RECEIPT_READ_FAILED"); }
  try {
    const receipt = verifyRuntimeIdentityArtifact({
      bytes,
      artifactSha256: required(options, "--artifact-sha256"),
      artifactBytes: numberOption(options, "--artifact-bytes"),
      expected: {
        sourceSha: required(options, "--source-sha"),
        packageFilename: required(options, "--package-filename"),
        packageVersion: required(options, "--package-version"),
        packageBytes: numberOption(options, "--package-bytes"),
        packageFileCount: numberOption(options, "--package-file-count"),
        packageSha256: required(options, "--package-sha256"),
        identityScheme: required(options, "--identity-scheme"),
        runtimePayloadSha256: required(options, "--runtime-payload-sha256"),
      },
    });
    return Object.freeze({
      status: "passed",
      identity_scheme: receipt.identity_scheme,
      runtime_payload_sha256: receipt.runtime_payload_sha256,
    });
  } finally {
    bytes?.fill(0);
  }
}

function usage() {
  return "runtime identity receipt: use --create receipt or --verify receipt with the complete fixed argument set";
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(usage());
    return;
  }
  if (argv.length % 2 !== 0) refuse("RUNTIME_IDENTITY_ARGUMENTS_INVALID");
  const options = optionMap(argv);
  const result = options.has("--create")
    ? createFromProof(options)
    : verifyFromOptions(options);
  console.log(JSON.stringify(result));
}

const IS_MAIN = (() => {
  try { return resolve(process.argv[1] || "") === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (IS_MAIN) {
  main(process.argv.slice(2)).catch((error) => {
    const code = error instanceof RuntimeIdentityReceiptError
      ? error.code
      : "RUNTIME_IDENTITY_FAILED";
    console.error(`Runtime identity receipt refused: ${code}`);
    process.exitCode = 1;
  });
}
