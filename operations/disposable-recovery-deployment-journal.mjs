/**
 * Durable ambiguity journal for the fixed disposable Worker deployment phases.
 *
 * One journal file belongs to one approval phase and one private binding. The
 * journal persists only hashes and a closed set of non-secret provider facts.
 * Binding data, requests, response bodies, credentials, paths, and account
 * identifiers are never serialized here.
 *
 * Binding and request inputs are semantic projections only: hashes, bounded
 * counts, booleans, enums, and fixed public labels. Raw payload containers and
 * secret/authentication field families are rejected recursively.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { TextDecoder, types as utilTypes } from "node:util";

import {
  assertNoDarwinReceiptAcl,
  assertPrivateAggregateEmptyReceiptFile,
  assertPrivateAggregateReceiptDirectory,
  syncPrivateReceiptDirectory,
} from "./private-aggregate-receipt.mjs";

export const DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_PROTOCOL =
  "v048-disposable-recovery-deployment-journal-v1";
export const DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_SUMMARY_PROTOCOL =
  "v048-disposable-recovery-deployment-journal-summary-v1";

const MAX_JOURNAL_BYTES = 64 * 1024;
const MAX_CANONICAL_BYTES = 2 * 1024 * 1024;
const MAX_CANONICAL_DEPTH = 64;
const MAX_CANONICAL_VALUES = 100_000;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LEASE_SUFFIX = ".lease";
const SENSITIVE_FIELD_PARTS = new Set([
  "auth",
  "authentication",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "passkey",
  "passphrase",
  "passwd",
  "password",
  "secret",
  "token",
]);
const SENSITIVE_FIELD_NAMES = new Set([
  "admin_key",
  "api_key",
  "argv",
  "body",
  "buffer",
  "bytes",
  "client_secret",
  "content",
  "encryption_key",
  "env",
  "environment",
  "headers",
  "modules",
  "pass_key",
  "private_key",
  "proxy_authorization",
  "raw",
  "raw_body",
  "recovery_code",
  "recovery_codes",
  "session_key",
  "signing_key",
  "wrapping_key",
]);

const PHASE_PLAN = Object.freeze({
  source: Object.freeze([
    Object.freeze({
      step: "upload_active_version",
      effect: "create_worker_version",
    }),
    Object.freeze({
      step: "deploy_active_version",
      effect: "replace_worker_deployment",
    }),
  ]),
  target: Object.freeze([
    Object.freeze({
      step: "upload_paused_version",
      effect: "create_worker_version",
    }),
    Object.freeze({
      step: "upload_active_version",
      effect: "create_worker_version",
    }),
    Object.freeze({
      step: "deploy_paused_version",
      effect: "replace_worker_deployment",
    }),
  ]),
});

const RECORD_FIELDS = Object.freeze([
  "binding_sha256",
  "effect",
  "effect_state",
  "phase",
  "protocol",
  "provider_metadata",
  "record_type",
  "request_sha256",
  "result",
  "result_sha256",
  "schema_version",
  "sequence",
  "step",
]);

export class DisposableRecoveryDeploymentJournalError extends Error {
  constructor(code) {
    super(code);
    this.name = "DisposableRecoveryDeploymentJournalError";
    this.code = code;
  }
}

function refuse(code) {
  throw new DisposableRecoveryDeploymentJournalError(code);
}

function exactKeys(value, fields) {
  try {
    if (!isPlainObject(value)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    return keys.length === fields.length &&
      keys.every((field) => typeof field === "string" && fields.includes(field)) &&
      fields.every((field) => descriptors[field]?.enumerable === true &&
        Object.hasOwn(descriptors[field], "value"));
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      utilTypes.isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function canonicalValue(value, state, depth) {
  state.values += 1;
  if (state.values > MAX_CANONICAL_VALUES || depth > MAX_CANONICAL_DEPTH) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_CANONICAL_INVALID");
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_CANONICAL_INVALID");
    }
    return JSON.stringify(value);
  }
  if (value && typeof value === "object" && utilTypes.isProxy(value)) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_CANONICAL_INVALID");
  }
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownNames = Reflect.ownKeys(descriptors);
    const lengthDescriptor = descriptors.length;
    if (!Object.hasOwn(lengthDescriptor, "value") ||
        !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
        ownNames.some((field) => typeof field !== "string") ||
        ownNames.length !== lengthDescriptor.value + 1 || !ownNames.includes("length")) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_CANONICAL_INVALID");
    }
    const length = lengthDescriptor.value;
    const items = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || descriptor.enumerable !== true ||
          !Object.hasOwn(descriptor, "value")) {
        refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_CANONICAL_INVALID");
      }
      items.push(canonicalValue(descriptor.value, state, depth + 1));
    }
    return `[${items.join(",")}]`;
  }
  if (!isPlainObject(value)) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_CANONICAL_INVALID");
  }
  if (state.seen.has(value)) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_CANONICAL_INVALID");
  }
  state.seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const fields = Reflect.ownKeys(descriptors);
    if (fields.some((field) => typeof field !== "string" ||
        descriptors[field].enumerable !== true ||
        !Object.hasOwn(descriptors[field], "value"))) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_CANONICAL_INVALID");
    }
    return `{${fields.sort().map((field) =>
      `${JSON.stringify(field)}:${canonicalValue(descriptors[field].value, state, depth + 1)}`
    ).join(",")}}`;
  } finally {
    state.seen.delete(value);
  }
}

function canonical(value) {
  try {
    const serialized = canonicalValue(value, {
      seen: new Set(),
      values: 0,
    }, 0);
    if (Buffer.byteLength(serialized, "utf8") > MAX_CANONICAL_BYTES) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_CANONICAL_INVALID");
    }
    return serialized;
  } catch (error) {
    if (error instanceof DisposableRecoveryDeploymentJournalError) throw error;
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_CANONICAL_INVALID");
  }
}

function sha256Canonical(serialized) {
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

/** Hash one strict, deterministic JSON value without retaining its source. */
export function disposableRecoveryDeploymentJournalSha256(value) {
  return sha256Canonical(canonical(value));
}

function freezeJsonValue(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeJsonValue(child);
  return value;
}

function normalizedSensitiveFieldName(field) {
  return field.normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
}

function isSensitiveFieldName(field) {
  const normalized = normalizedSensitiveFieldName(field);
  if (normalized.endsWith("_sha256") || normalized.endsWith("_bytes") ||
      normalized.endsWith("_count")) return false;
  if (SENSITIVE_FIELD_NAMES.has(normalized)) return true;
  const parts = normalized.split("_");
  if (parts.some((part) => SENSITIVE_FIELD_PARTS.has(part))) return true;
  return normalized.startsWith("raw_") || [
    "_body",
    "_buffer",
    "_content",
    "_environment",
    "_headers",
    "_modules",
  ].some((suffix) => normalized.endsWith(suffix));
}

function assertNoSensitiveInputFields(value) {
  if (Array.isArray(value)) {
    for (const item of value) assertNoSensitiveInputFields(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [field, child] of Object.entries(value)) {
    const normalized = normalizedSensitiveFieldName(field);
    if (normalized.endsWith("_sha256")) {
      if (typeof child !== "string" || !SHA256_RE.test(child)) {
        refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_SENSITIVE_INPUT_REFUSED");
      }
      continue;
    }
    if (normalized.endsWith("_bytes") || normalized.endsWith("_count")) {
      if (!Number.isSafeInteger(child) || child < 0) {
        refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_SENSITIVE_INPUT_REFUSED");
      }
      continue;
    }
    if (isSensitiveFieldName(field)) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_SENSITIVE_INPUT_REFUSED");
    }
    assertNoSensitiveInputFields(child);
  }
}

function canonicalSnapshot(value, { requireNonEmptyObject = false } = {}) {
  const serialized = canonical(value);
  let snapshot;
  try { snapshot = JSON.parse(serialized); }
  catch { refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_CANONICAL_INVALID"); }
  if (requireNonEmptyObject &&
      (!isPlainObject(snapshot) || Object.keys(snapshot).length === 0)) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_INPUT_INVALID");
  }
  if (requireNonEmptyObject) assertNoSensitiveInputFields(snapshot);
  return Object.freeze({
    value: freezeJsonValue(snapshot),
    sha256: sha256Canonical(serialized),
  });
}

function sameInode(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function sameStableFile(left, right) {
  return left?.isFile?.() === true && right?.isFile?.() === true &&
    left.nlink === 1 && right.nlink === 1 && sameInode(left, right) &&
    left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function assertOwner(info, code) {
  if (typeof process.getuid !== "function" || info.uid !== process.getuid()) refuse(code);
}

function assertJournalPlatform() {
  if (process.platform === "win32") {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_PLATFORM_REFUSED");
  }
}

function privateDirectory(path) {
  try {
    return assertPrivateAggregateReceiptDirectory(path, {
      code: "DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_DIRECTORY_REFUSED",
    });
  } catch {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_DIRECTORY_REFUSED");
  }
}

function assertSameDirectory(parent) {
  const current = privateDirectory(parent.path);
  if (!sameInode(parent.info, current.info)) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_DIRECTORY_CHANGED");
  }
  return current;
}

function assertPrivateFile(path, info, code) {
  if (!info?.isFile?.() || info.isSymbolicLink?.() || info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 || info.size > MAX_JOURNAL_BYTES) {
    refuse(code);
  }
  assertOwner(info, code);
  try {
    return assertNoDarwinReceiptAcl(path, info, { code });
  } catch {
    refuse(code);
  }
}

function assertJournalPath(journalPath, expectedJournalDirectory) {
  assertJournalPlatform();
  if (!isAbsolute(journalPath || "") ||
      !isAbsolute(expectedJournalDirectory || "")) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_PATH_REFUSED");
  }
  const path = resolve(journalPath);
  const expectedDirectory = resolve(expectedJournalDirectory);
  if (dirname(path) !== expectedDirectory) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_PATH_REFUSED");
  }
  return Object.freeze({
    path,
    parent: privateDirectory(expectedDirectory),
  });
}

function assertLeaseStable(lease) {
  try {
    assertSameDirectory(lease.parent);
    const opened = fstatSync(lease.descriptor);
    const current = lstatSync(lease.path);
    if (!sameStableFile(opened, current) || !sameInode(opened, lease.info) ||
        opened.size !== 0) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_LEASE_CHANGED");
    }
    lease.info = assertPrivateFile(
      lease.path,
      current,
      "DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_LEASE_CHANGED",
    );
    return lease.info;
  } catch (error) {
    if (error instanceof DisposableRecoveryDeploymentJournalError) throw error;
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_LEASE_CHANGED");
  }
}

function releaseJournalLease(lease) {
  if (!lease || !Number.isSafeInteger(lease.descriptor)) return;
  const leaseDescriptor = lease.descriptor;
  lease.descriptor = undefined;
  let directoryDescriptor;
  let failure = null;
  try {
    const before = assertLeaseStable({ ...lease, descriptor: leaseDescriptor });
    directoryDescriptor = openSync(
      lease.parent.path,
      fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0) |
        (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_CLOEXEC || 0),
    );
    const openedDirectory = fstatSync(directoryDescriptor);
    if (!openedDirectory.isDirectory() ||
        !sameInode(openedDirectory, lease.parent.info)) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_LEASE_CHANGED");
    }
    const current = lstatSync(lease.path);
    if (!sameStableFile(before, current)) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_LEASE_CHANGED");
    }
    // The descriptor stays open across unlink, so a replaced path can never be
    // mistaken for the lease this invocation actually owns.
    unlinkSync(lease.path);
    const unlinked = fstatSync(leaseDescriptor);
    if (!unlinked.isFile() || !sameInode(before, unlinked) || unlinked.nlink !== 0) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_LEASE_CHANGED");
    }
    try {
      lstatSync(lease.path);
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_LEASE_CHANGED");
    } catch (error) {
      if (error instanceof DisposableRecoveryDeploymentJournalError) throw error;
      if (error?.code !== "ENOENT") {
        refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_LEASE_CHANGED");
      }
    }
    fsyncSync(directoryDescriptor);
    if (!sameInode(fstatSync(directoryDescriptor), lease.parent.info)) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_LEASE_CHANGED");
    }
    assertSameDirectory(lease.parent);
  } catch (error) {
    failure = error instanceof DisposableRecoveryDeploymentJournalError
      ? error
      : new DisposableRecoveryDeploymentJournalError(
        "DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_LEASE_CHANGED",
      );
  } finally {
    if (directoryDescriptor !== undefined) {
      try { closeSync(directoryDescriptor); }
      catch {
        failure ||= new DisposableRecoveryDeploymentJournalError(
          "DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_LEASE_CHANGED",
        );
      }
    }
    try { closeSync(leaseDescriptor); }
    catch {
      failure ||= new DisposableRecoveryDeploymentJournalError(
        "DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_LEASE_CHANGED",
      );
    }
  }
  if (failure) throw failure;
}

function acquireJournalLease(journalPath, parent) {
  const path = `${journalPath}${LEASE_SUFFIX}`;
  if (dirname(path) !== parent.path) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_LEASE_REFUSED");
  }
  let descriptor;
  let lease;
  try {
    assertSameDirectory(parent);
    descriptor = openSync(
      path,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR |
        (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_CLOEXEC || 0),
      0o600,
    );
    const info = assertPrivateAggregateEmptyReceiptFile(path, descriptor, {
      code: "DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_LEASE_REFUSED",
    });
    lease = { path, parent, descriptor, info };
    fsyncSync(descriptor);
    if (syncPrivateReceiptDirectory(
      parent.path,
      parent.info,
      path,
      info,
      "DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_LEASE_CHANGED",
    ) !== true) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_LEASE_CHANGED");
    }
    assertLeaseStable(lease);
    return lease;
  } catch (error) {
    if (lease) {
      try { releaseJournalLease(lease); }
      catch { /* a surviving exact lease is the conservative failure state */ }
    } else if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* keep the original refusal */ }
    }
    if (error?.code === "EEXIST") {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_LEASE_HELD");
    }
    if (error instanceof DisposableRecoveryDeploymentJournalError) throw error;
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_LEASE_REFUSED");
  }
}

function openExistingJournal(path, parent) {
  let descriptor;
  try {
    assertSameDirectory(parent);
    const before = assertPrivateFile(
      path,
      lstatSync(path),
      "DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_FILE_REFUSED",
    );
    descriptor = openSync(
      path,
      fsConstants.O_RDWR | fsConstants.O_APPEND | (fsConstants.O_NOFOLLOW || 0) |
        (fsConstants.O_CLOEXEC || 0),
    );
    const opened = fstatSync(descriptor);
    const after = lstatSync(path);
    if (!sameStableFile(before, opened) || !sameStableFile(opened, after)) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_FILE_CHANGED");
    }
    assertPrivateFile(
      path,
      after,
      "DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_FILE_REFUSED",
    );
    assertSameDirectory(parent);
    return {
      path,
      parent,
      descriptor,
      info: opened,
      created: false,
    };
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* the fixed refusal remains authoritative */ }
    }
    if (error instanceof DisposableRecoveryDeploymentJournalError) throw error;
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_FILE_REFUSED");
  }
}

function createOrOpenJournal(path, parent) {
  let descriptor;
  try {
    assertSameDirectory(parent);
    descriptor = openSync(
      path,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR |
        fsConstants.O_APPEND |
        (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_CLOEXEC || 0),
      0o600,
    );
    let info;
    try {
      info = assertPrivateAggregateEmptyReceiptFile(path, descriptor, {
        code: "DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_FILE_REFUSED",
      });
    } catch {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_FILE_REFUSED");
    }
    assertSameDirectory(parent);
    return {
      path,
      parent,
      descriptor,
      info,
      created: true,
    };
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* the fixed refusal remains authoritative */ }
    }
    if (error instanceof DisposableRecoveryDeploymentJournalError) throw error;
    if (error?.code === "EEXIST") return openExistingJournal(path, parent);
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_FILE_REFUSED");
  }
}

function assertContextStable(context, expectedSize = context.info.size) {
  try {
    assertSameDirectory(context.parent);
    const opened = fstatSync(context.descriptor);
    const current = lstatSync(context.path);
    if (!sameStableFile(opened, current) || !sameInode(opened, context.info) ||
        opened.size !== expectedSize) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_FILE_CHANGED");
    }
    context.info = assertPrivateFile(
      context.path,
      current,
      "DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_FILE_REFUSED",
    );
    return context.info;
  } catch (error) {
    if (error instanceof DisposableRecoveryDeploymentJournalError) throw error;
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_FILE_CHANGED");
  }
}

function readExact(descriptor, bytes, position) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(
      descriptor,
      bytes,
      offset,
      bytes.length - offset,
      position + offset,
    );
    if (!Number.isSafeInteger(count) || count < 1) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_READ_FAILED");
    }
    offset += count;
  }
}

function assertProviderMetadata(value) {
  if (!exactKeys(value, [
    "body_sha256", "content_type", "schema_version", "status",
  ]) || value.schema_version !== 1 || value.status !== 200 ||
      !["application/json", "application/json; charset=utf-8"]
        .includes(value.content_type) ||
      !SHA256_RE.test(value.body_sha256 || "")) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_RESULT_INVALID");
  }
  return Object.freeze({
    schema_version: 1,
    status: 200,
    content_type: value.content_type,
    body_sha256: value.body_sha256,
  });
}

function assertResult(value, effect) {
  if (effect === "create_worker_version") {
    if (!exactKeys(value, ["version_id"]) ||
        !UUID_RE.test(String(value.version_id || ""))) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_RESULT_INVALID");
    }
    return Object.freeze({ version_id: value.version_id });
  }
  if (effect === "replace_worker_deployment") {
    if (!exactKeys(value, ["accepted", "deployment_id", "version_id"]) ||
        value.accepted !== true ||
        !UUID_RE.test(String(value.deployment_id || "")) ||
        !UUID_RE.test(String(value.version_id || ""))) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_RESULT_INVALID");
    }
    return Object.freeze({
      accepted: true,
      deployment_id: value.deployment_id,
      version_id: value.version_id,
    });
  }
  refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_RESULT_INVALID");
}

function assertConfirmedValue(value, effect) {
  if (!exactKeys(value, ["provider_metadata", "result"])) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_RESULT_INVALID");
  }
  return Object.freeze({
    provider_metadata: assertProviderMetadata(value.provider_metadata),
    result: assertResult(value.result, effect),
  });
}

function assertRecord(record, index) {
  if (!exactKeys(record, RECORD_FIELDS) || record.schema_version !== 1 ||
      record.protocol !== DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_PROTOCOL ||
      record.sequence !== index + 1 || !SHA256_RE.test(record.binding_sha256 || "") ||
      !SHA256_RE.test(record.request_sha256 || "") ||
      !Object.hasOwn(PHASE_PLAN, record.phase)) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_MALFORMED");
  }
  const operation = PHASE_PLAN[record.phase].find((entry) => entry.step === record.step);
  if (!operation || operation.effect !== record.effect) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_MALFORMED");
  }
  if (record.record_type === "prepared") {
    if (record.effect_state !== "sent_unconfirmed" ||
        record.result_sha256 !== null || record.provider_metadata !== null ||
        record.result !== null) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_MALFORMED");
    }
    return record;
  }
  if (record.record_type !== "confirmed" || record.effect_state !== "confirmed" ||
      !SHA256_RE.test(record.result_sha256 || "")) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_MALFORMED");
  }
  let confirmed;
  try {
    confirmed = assertConfirmedValue({
      provider_metadata: record.provider_metadata,
      result: record.result,
    }, record.effect);
  } catch {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_MALFORMED");
  }
  if (disposableRecoveryDeploymentJournalSha256(confirmed.result) !==
      record.result_sha256) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_MALFORMED");
  }
  return record;
}

function analyzeRecords(records) {
  if (!Array.isArray(records) || records.length > 6) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_MALFORMED");
  }
  if (records.length === 0) {
    return Object.freeze({
      phase: null,
      bindingSha256: null,
      completed: Object.freeze([]),
      pending: null,
    });
  }
  records.forEach(assertRecord);
  const phase = records[0].phase;
  const bindingSha256 = records[0].binding_sha256;
  const plan = PHASE_PLAN[phase];
  const completed = [];
  let pending = null;
  let recordIndex = 0;
  let stepIndex = 0;
  while (recordIndex < records.length) {
    const prepared = records[recordIndex];
    const expected = plan[stepIndex];
    if (!expected || prepared.record_type !== "prepared" ||
        prepared.phase !== phase || prepared.binding_sha256 !== bindingSha256 ||
        prepared.step !== expected.step || prepared.effect !== expected.effect) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_MALFORMED");
    }
    const confirmed = records[recordIndex + 1];
    if (!confirmed) {
      pending = prepared;
      recordIndex += 1;
      break;
    }
    if (confirmed.record_type !== "confirmed" || confirmed.phase !== phase ||
        confirmed.binding_sha256 !== bindingSha256 ||
        confirmed.request_sha256 !== prepared.request_sha256 ||
        confirmed.step !== prepared.step || confirmed.effect !== prepared.effect) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_MALFORMED");
    }
    completed.push(Object.freeze({ prepared, confirmed }));
    recordIndex += 2;
    stepIndex += 1;
  }
  if (recordIndex !== records.length) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_MALFORMED");
  }
  return Object.freeze({
    phase,
    bindingSha256,
    completed: Object.freeze(completed),
    pending,
  });
}

function parseJournalBytes(bytes, { allowEmpty = false } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_JOURNAL_BYTES ||
      (bytes.length === 0 && !allowEmpty)) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_MALFORMED");
  }
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0x0a) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_MALFORMED");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_MALFORMED");
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0)) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_MALFORMED");
  }
  const records = lines.map((line) => {
    let record;
    try { record = JSON.parse(line); }
    catch { refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_MALFORMED"); }
    let serialized;
    try { serialized = canonical(record); }
    catch { refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_MALFORMED"); }
    if (serialized !== line) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_MALFORMED");
    }
    return record;
  });
  analyzeRecords(records);
  return records;
}

function readContextRecords(context, { allowEmpty = false } = {}) {
  const before = assertContextStable(context);
  let bytes;
  try {
    bytes = Buffer.alloc(before.size);
    if (bytes.length > 0) readExact(context.descriptor, bytes, 0);
    const after = fstatSync(context.descriptor);
    const current = lstatSync(context.path);
    if (!sameStableFile(before, after) || !sameStableFile(after, current)) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_FILE_CHANGED");
    }
    return parseJournalBytes(bytes, { allowEmpty });
  } catch (error) {
    if (error instanceof DisposableRecoveryDeploymentJournalError) throw error;
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_READ_FAILED");
  } finally {
    if (bytes) bytes.fill(0);
  }
}

function appendExact(descriptor, bytes) {
  // The same-directory lease serializes writers. O_APPEND remains a second
  // boundary against an uncooperative stale descriptor overwriting history.
  const count = writeSync(descriptor, bytes, 0, bytes.length, null);
  if (count !== bytes.length) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_WRITE_FAILED");
  }
}

function appendRecord(context, priorRecords, record) {
  const line = `${canonical(record)}\n`;
  const bytes = Buffer.from(line, "utf8");
  let readback;
  try {
    const before = assertContextStable(context);
    if (before.size + bytes.length > MAX_JOURNAL_BYTES) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_WRITE_FAILED");
    }
    appendExact(context.descriptor, bytes);
    readback = Buffer.alloc(bytes.length);
    readExact(context.descriptor, readback, before.size);
    if (!readback.equals(bytes)) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_WRITE_FAILED");
    }
    fsyncSync(context.descriptor);
    const opened = fstatSync(context.descriptor);
    const current = lstatSync(context.path);
    if (!sameStableFile(opened, current) || !sameInode(before, opened) ||
        opened.size !== before.size + bytes.length) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_FILE_CHANGED");
    }
    context.info = assertPrivateFile(
      context.path,
      current,
      "DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_FILE_REFUSED",
    );
    const directoryResult = syncPrivateReceiptDirectory(
      context.parent.path,
      context.parent.info,
      context.path,
      context.info,
      "DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_DIRECTORY_CHANGED",
    );
    if (directoryResult !== true) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_DIRECTORY_CHANGED");
    }
    const persisted = readContextRecords(context);
    if (persisted.length !== priorRecords.length + 1 ||
        canonical(persisted.at(-1)) !== canonical(record)) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_WRITE_FAILED");
    }
    return persisted;
  } catch (error) {
    if (error instanceof DisposableRecoveryDeploymentJournalError) throw error;
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_WRITE_FAILED");
  } finally {
    bytes.fill(0);
    if (readback) readback.fill(0);
  }
}

function closeContext(context) {
  if (!context || !Number.isSafeInteger(context.descriptor)) return;
  const descriptor = context.descriptor;
  context.descriptor = undefined;
  try { closeSync(descriptor); }
  catch { refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_FILE_REFUSED"); }
}

function assertOperation(phase, step, effect) {
  if (!Object.hasOwn(PHASE_PLAN, phase)) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_OPERATION_INVALID");
  }
  const operation = PHASE_PLAN[phase].find((entry) => entry.step === step);
  if (!operation || operation.effect !== effect) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_OPERATION_INVALID");
  }
  return operation;
}

function snapshotHashInput(value) {
  return canonicalSnapshot(value, { requireNonEmptyObject: true });
}

function preparedRecord({ phase, step, effect, bindingSha256, requestSha256, sequence }) {
  return Object.freeze({
    schema_version: 1,
    protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_PROTOCOL,
    sequence,
    record_type: "prepared",
    effect_state: "sent_unconfirmed",
    phase,
    step,
    effect,
    binding_sha256: bindingSha256,
    request_sha256: requestSha256,
    result_sha256: null,
    provider_metadata: null,
    result: null,
  });
}

function confirmedRecord(prepared, value) {
  return Object.freeze({
    schema_version: 1,
    protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_PROTOCOL,
    sequence: prepared.sequence + 1,
    record_type: "confirmed",
    effect_state: "confirmed",
    phase: prepared.phase,
    step: prepared.step,
    effect: prepared.effect,
    binding_sha256: prepared.binding_sha256,
    request_sha256: prepared.request_sha256,
    result_sha256: disposableRecoveryDeploymentJournalSha256(value.result),
    provider_metadata: value.provider_metadata,
    result: value.result,
  });
}

function immutableClone(value) {
  return canonicalSnapshot(value).value;
}

function eventManifestForPhase(phase) {
  const events = [];
  for (const [index, operation] of PHASE_PLAN[phase].entries()) {
    events.push(Object.freeze({
      sequence: (index * 2) + 1,
      record_type: "prepared",
      effect_state: "sent_unconfirmed",
      step: operation.step,
      effect: operation.effect,
    }));
    events.push(Object.freeze({
      sequence: (index * 2) + 2,
      record_type: "confirmed",
      effect_state: "confirmed",
      step: operation.step,
      effect: operation.effect,
    }));
  }
  return Object.freeze(events);
}

function summarizeRecords(records, expectedPhase, expectedBindingSha256) {
  const state = analyzeRecords(records);
  const plan = PHASE_PLAN[expectedPhase];
  if (state.phase !== expectedPhase ||
      state.bindingSha256 !== expectedBindingSha256) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_CONFLICT");
  }
  if (state.pending || state.completed.length !== plan.length ||
      records.length !== plan.length * 2) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_SUMMARY_INCOMPLETE");
  }
  const eventCount = records.length;
  const throughSequence = records.at(-1).sequence;
  const events = eventManifestForPhase(expectedPhase);
  const eventManifestSha256 = disposableRecoveryDeploymentJournalSha256({
    schema_version: 1,
    digest_type: "event_manifest",
    summary_protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_SUMMARY_PROTOCOL,
    journal_protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_PROTOCOL,
    phase: expectedPhase,
    event_count: events.length,
    events,
  });
  // This digest commits to every canonical record in order. Hashing only the
  // final record would not bind the prefix because v1 records are not chained.
  const headSha256 = disposableRecoveryDeploymentJournalSha256({
    schema_version: 1,
    digest_type: "ordered_record_prefix",
    summary_protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_SUMMARY_PROTOCOL,
    journal_protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_PROTOCOL,
    phase: expectedPhase,
    binding_sha256: expectedBindingSha256,
    through_sequence: throughSequence,
    event_count: eventCount,
    records,
  });
  return Object.freeze({
    schema_version: 1,
    protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_SUMMARY_PROTOCOL,
    journal_protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_PROTOCOL,
    phase: expectedPhase,
    binding_sha256: expectedBindingSha256,
    through_sequence: throughSequence,
    event_count: eventCount,
    head_sha256: headSha256,
    event_manifest_sha256: eventManifestSha256,
  });
}

/** Read and strictly validate one existing phase journal. */
export function readDisposableRecoveryDeploymentJournal(
  journalPath,
  { expectedJournalDirectory } = {},
) {
  const target = assertJournalPath(journalPath, expectedJournalDirectory);
  const context = openExistingJournal(target.path, target.parent);
  try {
    return immutableClone(readContextRecords(context));
  } finally {
    closeContext(context);
  }
}

/**
 * Summarize one complete phase as two independently domain-separated digests.
 * The expected binding is reproved without serializing its private fields.
 */
export function summarizeDisposableRecoveryDeploymentJournal(
  journalPath,
  summaryOptions,
) {
  if (!exactKeys(summaryOptions, [
    "expectedBinding",
    "expectedJournalDirectory",
    "expectedPhase",
  ])) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_INPUT_INVALID");
  }
  const {
    expectedBinding,
    expectedJournalDirectory,
    expectedPhase,
  } = summaryOptions;
  if (!Object.hasOwn(PHASE_PLAN, expectedPhase)) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_OPERATION_INVALID");
  }
  const bindingSnapshot = snapshotHashInput(expectedBinding);
  const target = assertJournalPath(journalPath, expectedJournalDirectory);
  const lease = acquireJournalLease(target.path, target.parent);
  let context;
  let result;
  let failure = null;
  try {
    context = openExistingJournal(target.path, target.parent);
    assertLeaseStable(lease);
    const records = readContextRecords(context);
    assertLeaseStable(lease);
    result = summarizeRecords(records, expectedPhase, bindingSnapshot.sha256);
  } catch (error) {
    failure = error;
  } finally {
    if (context) {
      try { closeContext(context); }
      catch (error) { failure ||= error; }
    }
    try { releaseJournalLease(lease); }
    catch (error) { failure ||= error; }
  }
  if (failure) throw failure;
  return result;
}

/**
 * Run one fixed mutation behind a durable sent-unconfirmed boundary.
 *
 * `validate` must reduce the provider response to exactly
 * `{ provider_metadata, result }`. Provider metadata is exactly the sanitized
 * status, content type, and raw-response hash emitted by the narrow transport.
 * Upload results contain only `version_id`; deployment results retain the
 * accepted deployment and version IDs needed to bind the POST result to an
 * exact final readback.
 */
export async function runJournaledDisposableRecoveryDeploymentMutation(
  options,
  ...unexpectedDependencies
) {
  if (unexpectedDependencies.length !== 0) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_DEPENDENCY_INVALID");
  }
  if (!exactKeys(options, [
    "binding",
    "effect",
    "expectedJournalDirectory",
    "journalPath",
    "mutate",
    "phase",
    "request",
    "step",
    "validate",
  ])) {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_INPUT_INVALID");
  }
  const {
    binding,
    effect,
    expectedJournalDirectory,
    journalPath,
    mutate,
    phase,
    request,
    step,
    validate,
  } = options;
  assertOperation(phase, step, effect);
  if (typeof mutate !== "function" || typeof validate !== "function") {
    refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_DEPENDENCY_INVALID");
  }
  // Journal identity is a one-time immutable semantic projection. Raw bodies,
  // module content, authorization material, and other secret-bearing fields
  // are refused; callers provide hashes/counts/public labels instead.
  const bindingSnapshot = snapshotHashInput(binding);
  const requestSnapshot = snapshotHashInput(request);
  const bindingSha256 = bindingSnapshot.sha256;
  const requestSha256 = requestSnapshot.sha256;
  const target = assertJournalPath(journalPath, expectedJournalDirectory);
  const lease = acquireJournalLease(target.path, target.parent);
  let context;
  let output;
  let failure = null;
  try {
    context = createOrOpenJournal(target.path, target.parent);
    assertLeaseStable(lease);
    let records = readContextRecords(context, { allowEmpty: context.created });
    const state = analyzeRecords(records);
    if (state.phase !== null &&
        (state.phase !== phase || state.bindingSha256 !== bindingSha256)) {
      refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_CONFLICT");
    }
    const replay = state.completed.find(({ prepared }) => prepared.step === step);
    if (replay) {
      if (replay.prepared.request_sha256 !== requestSha256 ||
          replay.prepared.effect !== effect) {
        refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_CONFLICT");
      }
      assertLeaseStable(lease);
      output = immutableClone(replay.confirmed.result);
    } else {
      if (state.pending) {
        if (state.pending.step === step &&
            state.pending.request_sha256 !== requestSha256) {
          refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_CONFLICT");
        }
        refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_AMBIGUOUS");
      }
      const expected = PHASE_PLAN[phase][state.completed.length];
      if (!expected || expected.step !== step || expected.effect !== effect) {
        refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_CONFLICT");
      }
      const prepared = preparedRecord({
        phase,
        step,
        effect,
        bindingSha256,
        requestSha256,
        sequence: records.length + 1,
      });
      try {
        records = appendRecord(context, records, prepared);
      } catch (error) {
        if (error instanceof DisposableRecoveryDeploymentJournalError) throw error;
        refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_WRITE_FAILED");
      }

      let providerResult;
      try {
        assertLeaseStable(lease);
        providerResult = await mutate(requestSnapshot.value);
        assertLeaseStable(lease);
      } catch {
        refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_AMBIGUOUS");
      }

      let confirmedValue;
      try {
        confirmedValue = assertConfirmedValue(await validate(providerResult), effect);
        assertLeaseStable(lease);
      } catch {
        refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_AMBIGUOUS");
      }

      const confirmed = confirmedRecord(prepared, confirmedValue);
      try {
        appendRecord(context, records, confirmed);
      } catch {
        refuse("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_AMBIGUOUS");
      }
      output = immutableClone(confirmedValue.result);
    }
  } catch (error) {
    failure = error;
  } finally {
    if (context) {
      try { closeContext(context); }
      catch (error) { failure ||= error; }
    }
    try { releaseJournalLease(lease); }
    catch (error) { failure ||= error; }
  }
  if (failure) throw failure;
  return output;
}
