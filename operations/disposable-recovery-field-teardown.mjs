/**
 * Campaign-specific A13-A16 teardown broker for the v0.4.8 field proof.
 *
 * The general teardown helper remains preview-only. This broker accepts only
 * the two fixed campaign roles, consumes an exact private preview approval,
 * and journals each Worker -> Vectorize -> D1 action through immutable private
 * records. A sent-unconfirmed action is reconciled by exact endpoint GET only;
 * it is never retried.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  abandonPrivateAggregateReceipt,
  assertNoDarwinReceiptAcl,
  assertPrivateAggregateOutputPath,
  assertPrivateAggregateReceiptDirectory,
  finalizePrivateAggregateReceipt,
  privateAggregateReceiptCommitPath,
  privateAggregateReceiptPendingPath,
  readPrivateAggregateReceipt,
  recoverPrivateAggregateReceiptFinalization,
  reservePrivateAggregateReceipt,
  resumePrivateAggregateReceiptReservation,
} from "./private-aggregate-receipt.mjs";
import {
  DISPOSABLE_TEARDOWN_NAMES,
} from "./cloudflare-disposable-teardown-provider.mjs";
import {
  DISPOSABLE_RECOVERY_TARGET_EVAL_RECEIPT_NAME,
  assertDisposableRecoveryTargetEvalReceipt,
} from "./disposable-recovery-field-acceptance.mjs";
import {
  DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME,
  readDisposableRecoveryDeploymentReceipt,
} from "./disposable-recovery-deployment-receipt.mjs";
import {
  assertDisposableRecoveryFieldKeychainVerificationCapability,
  disposableRecoveryFieldKeychainPreparationFingerprint,
} from "./disposable-recovery-field-keychain-prep.mjs";
import {
  readDisposableRecoveryProvisionArtifacts,
} from "./disposable-recovery-field-provision.mjs";
import {
  validateVerifiedRecoveryState,
  verifiedRecoveryStatus,
} from "./verified-recovery.mjs";

export const DISPOSABLE_RECOVERY_FIELD_TEARDOWN_SCHEMA_VERSION = 1;
export const DISPOSABLE_RECOVERY_SOURCE_TEARDOWN_PREVIEW_NAME =
  "v048-disposable-source-teardown-preview.json";
export const DISPOSABLE_RECOVERY_TARGET_TEARDOWN_PREVIEW_NAME =
  "v048-disposable-target-teardown-preview.json";
export const DISPOSABLE_RECOVERY_SOURCE_TEARDOWN_RECEIPT_NAME =
  "v048-disposable-source-teardown.json";
export const DISPOSABLE_RECOVERY_TARGET_TEARDOWN_RECEIPT_NAME =
  "v048-disposable-target-teardown.json";
export const DISPOSABLE_RECOVERY_SOURCE_TEARDOWN_ABSENT_PREVIEW_NAME =
  "v048-disposable-source-teardown-absent-preview.json";
export const DISPOSABLE_RECOVERY_TARGET_TEARDOWN_ABSENT_PREVIEW_NAME =
  "v048-disposable-target-teardown-absent-preview.json";

const PROVIDER_RELATIVE = "operations/cloudflare-disposable-teardown-provider.mjs";
const PROVIDER_PATH = fileURLToPath(new URL(`./${basename(PROVIDER_RELATIVE)}`, import.meta.url));
const MAX_PROGRAM_BYTES = 64 * 1024;
const MAX_WRAPPER_BYTES = 8 * 1024;
const MAX_CHILD_BYTES = 1024 * 1024;
const CHILD_TIMEOUT_MS = 120_000;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const SHA40_RE = /^[a-f0-9]{40}$/u;
const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/u;
const WORKER_ID_RE = /^[a-f0-9]{32}$/u;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RESOURCE_ORDER = Object.freeze(["worker", "vectorize", "d1"]);
const STORAGE_RESOURCE_ORDER = Object.freeze(["d1", "vectorize"]);
const STORAGE_ABSENCE_AUTHORITY =
  "two_stable_exhaustive_account_inventories";
const PROVISION_PREPARATION_OVERLAP_FIELDS = Object.freeze([
  "candidate_sha", "candidate_tree_sha", "field_receipt_run_id",
  "field_receipt_sha256", "package_filename", "package_bytes",
  "package_sha256", "package_file_count", "execution_inventory_sha256",
  "installed_execution_inventory_sha256", "wrangler_version",
  "wrangler_wrapper_sha256", "wrangler_runtime_inventory_sha256",
  "wrangler_entrypoint_sha256", "node_version", "node_executable_sha256",
]);
const VERIFIED_PROVISION_ARTIFACTS = new WeakMap();
const VERIFIED_A12_EVIDENCE = new WeakMap();
const VERIFIED_SOURCE_TEARDOWN_RECEIPTS = new WeakMap();
export const DISPOSABLE_TEARDOWN_TOKEN_SERVICE = "brain-cloudflare-token";
const STATE_ORDER = Object.freeze(["planned", "sent_unconfirmed"]);
const FINAL_STATES = new Set(["confirmed", "reconciled"]);
const WRAPPER_HASH_LINE =
  'BRAIN_TEARDOWN_PROVIDER_ACTUAL_SHA="$(printf \'%s\' "${BRAIN_TEARDOWN_PROVIDER_SOURCE:?}" | /usr/bin/shasum -a 256)" || exit 126';
const WRAPPER_PIN_RE =
  /^\[ "\$\{BRAIN_TEARDOWN_PROVIDER_ACTUAL_SHA%% \*\}" = '([a-f0-9]{64})' \] \|\| exit 126$/u;
const WRAPPER_KEYCHAIN_RE =
  /^\/usr\/bin\/security find-generic-password -a '([A-Za-z0-9._:@/-]{1,128})' -s '([A-Za-z0-9._:@/-]{1,128})' -w \| exec "\$\{BRAIN_TEARDOWN_NODE:\?\}" --input-type=module --eval "\$\{BRAIN_TEARDOWN_PROVIDER_SOURCE:\?\}" -- --campaign-teardown-provider-child 3<&3$/u;

export class DisposableRecoveryFieldTeardownError extends Error {
  constructor(code) {
    super(code);
    this.name = "DisposableRecoveryFieldTeardownError";
    this.code = code;
  }
}

function refuse(code) {
  throw new DisposableRecoveryFieldTeardownError(code);
}

async function recoverCommittedAggregate(output, marker, validateFinalReceipt, {
  code,
  recover = recoverPrivateAggregateReceiptFinalization,
  revalidate = () => true,
} = {}) {
  if (!existsSync(privateAggregateReceiptCommitPath(output.path))) return null;
  if (await revalidate() !== true) refuse(code);
  const result = await recover(output, marker, (value) => {
    validateFinalReceipt(value);
    return true;
  }, { code });
  if (await revalidate() !== true) refuse(code);
  return result;
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, fields) {
  return plainObject(value) && Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const WORKER_MISSING_CODE_SHA256 = sha256(canonical({ codes: [10007] }));
const EMPTY_SCHEDULES_SHA256 = sha256(canonical([]));

function privateReceiptSha256(value) {
  return sha256(Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

function immutable(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) immutable(child);
  return Object.freeze(value);
}

/**
 * Read an A1/A3 artifact pair through the authoritative provision reader and
 * mint the in-process capability consumed by teardown. A copied or
 * self-consistent plain object cannot cross this boundary.
 */
function normalizedProvisionArtifacts(value) {
  const vectorizeCreatedOn = value?.receipt?.final_state?.vectorize_created_on;
  const completedAt = value?.receipt?.completed_at;
  if (!exactUtcRfc3339(vectorizeCreatedOn) || !exactUtcRfc3339(completedAt)) {
    refuse("TEARDOWN_PROVISION_IDENTITY_MISMATCH");
  }
  return immutable({
    ...value,
    vectorizeCreatedOn,
    completedAt,
    binding: value.receipt.binding,
  });
}

export function readDisposableRecoveryTeardownProvisionArtifacts(options) {
  if (!exactKeys(options, [
    "receiptPath", "manifestPath", "expectedReceiptDirectory", "role",
  ])) {
    refuse("TEARDOWN_PROVISION_IDENTITY_MISMATCH");
  }
  const readerOptions = Object.freeze({
    receiptPath: String(options.receiptPath),
    manifestPath: String(options.manifestPath),
    expectedReceiptDirectory: String(options.expectedReceiptDirectory),
    role: String(options.role),
  });
  let value;
  try {
    value = readDisposableRecoveryProvisionArtifacts(readerOptions);
  } catch {
    refuse("TEARDOWN_PROVISION_IDENTITY_MISMATCH");
  }
  const capability = normalizedProvisionArtifacts(value);
  const fingerprint = canonical(capability);
  VERIFIED_PROVISION_ARTIFACTS.set(capability, async () => {
    try {
      const current = normalizedProvisionArtifacts(
        readDisposableRecoveryProvisionArtifacts(readerOptions),
      );
      return canonical(current) === fingerprint;
    } catch {
      return false;
    }
  });
  return capability;
}

/** Assert that an artifact pair came from the authoritative reader above. */
export function assertDisposableRecoveryTeardownProvisionArtifactsCapability(value) {
  if (!VERIFIED_PROVISION_ARTIFACTS.has(value)) {
    refuse("TEARDOWN_PROVISION_IDENTITY_MISMATCH");
  }
  return value;
}

function fixedReceiptPath(path, directory, name, code) {
  let acceptedDirectory;
  let resolvedPath;
  try {
    acceptedDirectory = assertPrivateAggregateReceiptDirectory(
      resolve(directory),
      { code },
    ).path;
    resolvedPath = resolve(path);
  } catch {
    refuse(code);
  }
  const expected = join(acceptedDirectory, name);
  if (resolvedPath !== expected) refuse(code);
  return expected;
}

function readA12Snapshot(paths, plan) {
  let targetEvalLoaded;
  let targetEval;
  let stateRecord;
  let golden;
  let deployment;
  let state;
  try {
    targetEvalLoaded = readPrivateAggregateReceipt(paths.targetEvalReceiptPath, {
      code: "TEARDOWN_TARGET_EVAL_RECEIPT_INVALID",
    });
    targetEval = assertDisposableRecoveryTargetEvalReceipt(
      targetEvalLoaded.value,
      targetEvalLoaded.value.binding,
    );
    stateRecord = readPrivateAggregateReceipt(paths.statePath, {
      code: "TEARDOWN_RECOVERY_STATE_INVALID",
    });
    golden = readPrivateAggregateReceipt(paths.goldenPath, {
      code: "TEARDOWN_GOLDEN_INVALID",
    });
    deployment = readDisposableRecoveryDeploymentReceipt(
      paths.deploymentReceiptPath,
    );
    state = validateVerifiedRecoveryState(stateRecord.value, plan);
  } catch {
    refuse("TEARDOWN_A12_EVIDENCE_INVALID");
  }
  let recoveryStatus;
  try {
    recoveryStatus = verifiedRecoveryStatus(plan, state);
  } catch {
    refuse("TEARDOWN_A12_EVIDENCE_INVALID");
  }
  const targetBinding = targetEval.binding;
  const deploymentBinding = deployment.value.binding;
  const activeWorkerVersionId =
    deployment.value.target.active_version.version_id;
  if (privateReceiptSha256(targetEval) !== targetEvalLoaded.sha256 ||
      privateReceiptSha256(deployment.value) !== deployment.sha256 ||
      recoveryStatus?.status !== "complete" ||
      !exactUtcRfc3339(targetEval.completed_at) ||
      !exactUtcRfc3339(deployment.value.completed_at) ||
      !exactUtcRfc3339(state.updated_at) ||
      state.field_proof?.deployment_receipt_sha256 !== deployment.sha256 ||
      targetBinding.recovery_state_sha256 !== stateRecord.sha256 ||
      targetBinding.golden_sha256 !== golden.sha256 ||
      targetBinding.active_worker_version_id !== activeWorkerVersionId ||
      targetBinding.recovery_plan_fingerprint !== plan.plan_fingerprint ||
      targetBinding.source_resource_fingerprint !==
        plan.source_resource_fingerprint ||
      targetBinding.target_resource_fingerprint !==
        plan.target_resource_fingerprint ||
      deploymentBinding.plan_fingerprint !==
        targetBinding.recovery_plan_fingerprint ||
      deploymentBinding.source_resource_fingerprint !==
        targetBinding.source_resource_fingerprint ||
      deploymentBinding.target_resource_fingerprint !==
        targetBinding.target_resource_fingerprint ||
      deploymentBinding.runtime_contract_fingerprint !==
        plan.runtime_contract_fingerprint ||
      [
        "candidate_sha", "candidate_tree_sha", "package_sha256",
        "field_receipt_sha256", "keychain_binding_sha256",
        "campaign_fingerprint",
      ].some((field) => deploymentBinding[field] !== targetBinding[field]) ||
      Date.parse(deployment.value.completed_at) > Date.parse(state.updated_at) ||
      Date.parse(state.updated_at) > Date.parse(targetEval.completed_at)) {
    refuse("TEARDOWN_A12_EVIDENCE_INVALID");
  }
  return immutable({
    state_sha256: stateRecord.sha256,
    golden_sha256: golden.sha256,
    deployment_receipt_sha256: deployment.sha256,
    state_deployment_receipt_sha256:
      state.field_proof.deployment_receipt_sha256,
    deployment_completed_at: deployment.value.completed_at,
    state_updated_at: state.updated_at,
    active_worker_version_id: activeWorkerVersionId,
    target_eval_receipt: immutable({
      value: targetEval,
      sha256: targetEvalLoaded.sha256,
    }),
  });
}

/** Read and continuously bind the completed A12 evidence chain. */
export function readDisposableRecoveryTeardownA12Evidence(options) {
  if (!exactKeys(options, [
    "targetEvalReceiptPath", "statePath", "goldenPath",
    "deploymentReceiptPath", "expectedReceiptDirectory", "plan",
  ]) || !plainObject(options.plan)) {
    refuse("TEARDOWN_A12_EVIDENCE_INVALID");
  }
  const directory = resolve(options.expectedReceiptDirectory);
  const paths = Object.freeze({
    targetEvalReceiptPath: fixedReceiptPath(
      options.targetEvalReceiptPath,
      directory,
      DISPOSABLE_RECOVERY_TARGET_EVAL_RECEIPT_NAME,
      "TEARDOWN_A12_EVIDENCE_INVALID",
    ),
    statePath: resolve(options.statePath),
    goldenPath: resolve(options.goldenPath),
    deploymentReceiptPath: fixedReceiptPath(
      options.deploymentReceiptPath,
      directory,
      DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME,
      "TEARDOWN_A12_EVIDENCE_INVALID",
    ),
  });
  const plan = immutable(structuredClone(options.plan));
  const capability = readA12Snapshot(paths, plan);
  const fingerprint = canonical(capability);
  VERIFIED_A12_EVIDENCE.set(capability, async () => {
    try {
      return canonical(readA12Snapshot(paths, plan)) === fingerprint;
    } catch {
      return false;
    }
  });
  return capability;
}

/** Assert that A12 evidence came from the fixed authoritative reader. */
export function assertDisposableRecoveryTeardownA12EvidenceCapability(value) {
  if (!VERIFIED_A12_EVIDENCE.has(value)) {
    refuse("TEARDOWN_A12_EVIDENCE_INVALID");
  }
  return value;
}

function exactUtcRfc3339(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u
    .exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  return calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day &&
    calendar.getUTCHours() === hour && calendar.getUTCMinutes() === minute &&
    calendar.getUTCSeconds() === second;
}

function isoNow(now) {
  const value = now().toISOString();
  if (new Date(value).toISOString() !== value) refuse("TEARDOWN_CLOCK_INVALID");
  return value;
}

function checkedMaintenanceWindow(value) {
  if (!exactKeys(value, ["single_operator", "other_actors_paused"]) ||
      value.single_operator !== true || value.other_actors_paused !== true) {
    refuse("TEARDOWN_MAINTENANCE_WINDOW_REQUIRED");
  }
  return immutable(structuredClone(value));
}

function checkedTokenLocatorEvidence(value, accountFingerprint) {
  if (!exactKeys(value, [
    "account_fingerprint", "service_sha256", "locator_sha256",
  ]) || value.account_fingerprint !== accountFingerprint ||
      !SHA256_RE.test(String(value.service_sha256 || "")) ||
      !SHA256_RE.test(String(value.locator_sha256 || ""))) {
    refuse("TEARDOWN_TOKEN_LOCATOR_INVALID");
  }
  return immutable(structuredClone(value));
}

function sameFile(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino &&
    left?.nlink === right?.nlink && left?.size === right?.size &&
    left?.mtimeMs === right?.mtimeMs && left?.ctimeMs === right?.ctimeMs;
}

function readStableProgram(path, maximumBytes, code, {
  executable = false,
  privateParent = false,
} = {}) {
  if (!isAbsolute(path || "")) refuse(code);
  const absolute = resolve(path);
  let descriptor;
  let bytes;
  try {
    const parent = lstatSync(dirname(absolute));
    let before = lstatSync(absolute);
    if (!parent.isDirectory() || parent.isSymbolicLink() ||
        realpathSync(dirname(absolute)) !== dirname(absolute) ||
        !before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
        before.size < 1 || before.size > maximumBytes ||
        realpathSync(absolute) !== absolute ||
        (typeof process.getuid === "function" &&
          (parent.uid !== process.getuid() || before.uid !== process.getuid())) ||
        (process.platform !== "win32" &&
          ((privateParent ? (parent.mode & 0o077) !== 0 : (parent.mode & 0o022) !== 0) ||
           (before.mode & 0o022) !== 0 ||
           executable && (before.mode & 0o100) === 0))) {
      refuse(code);
    }
    assertNoDarwinReceiptAcl(dirname(absolute), parent, { code });
    before = assertNoDarwinReceiptAcl(absolute, before, { code });
    descriptor = openSync(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameFile(before, opened)) refuse(code);
    bytes = readFileSync(descriptor);
    if (!Buffer.isBuffer(bytes) || bytes.length !== opened.size ||
        !sameFile(opened, fstatSync(descriptor)) ||
        !sameFile(opened, lstatSync(absolute))) {
      refuse(code);
    }
    const program = bytes.toString("utf8");
    if (!Buffer.from(program, "utf8").equals(bytes) || program.includes("\u0000")) {
      refuse(code);
    }
    return immutable({
      path: absolute,
      sha256: sha256(bytes),
      info: opened,
      program,
    });
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldTeardownError) throw error;
    refuse(code);
  } finally {
    bytes?.fill?.(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function inspectDisposableTeardownProviderProgram(path = PROVIDER_PATH) {
  return readStableProgram(path, MAX_PROGRAM_BYTES,
    "TEARDOWN_PROVIDER_PROGRAM_UNSAFE");
}

function tokenLocatorEvidence(accountId, service) {
  const accountFingerprint = sha256(canonical({
    kind: "cloudflare_account",
    account_id: accountId,
  }));
  const serviceSha256 = sha256(service);
  return immutable({
    account_fingerprint: accountFingerprint,
    service_sha256: serviceSha256,
    locator_sha256: sha256(canonical({
      backend: "macos_keychain",
      account_fingerprint: accountFingerprint,
      service_sha256: serviceSha256,
    })),
  });
}

export function validateDisposableTeardownWrapperProgram(program, {
  accountId,
  service = DISPOSABLE_TEARDOWN_TOKEN_SERVICE,
} = {}) {
  const lines = String(program ?? "").split("\n");
  const keychain = WRAPPER_KEYCHAIN_RE.exec(lines[8] || "");
  if (lines.length !== 10 || lines[9] !== "" ||
      lines[0] !== "#!/bin/sh" || lines[1] !== "set -eu" ||
      lines[2] !== "exec 3<&0" || lines[3] !== WRAPPER_HASH_LINE ||
      !WRAPPER_PIN_RE.test(lines[4]) ||
      lines[5] !== "unset BRAIN_TEARDOWN_PROVIDER_ACTUAL_SHA" ||
      lines[6] !== '[ -n "${BRAIN_TEARDOWN_NODE:?}" ]' ||
      lines[7] !== '[ -n "${BRAIN_TEARDOWN_PROVIDER_SOURCE:?}" ]' ||
      !keychain || !ACCOUNT_ID_RE.test(String(accountId || "")) ||
      service !== DISPOSABLE_TEARDOWN_TOKEN_SERVICE ||
      keychain[1] !== accountId || keychain[2] !== service) {
    refuse("TEARDOWN_WRAPPER_UNSAFE");
  }
  return immutable({
    providerSha256: WRAPPER_PIN_RE.exec(lines[4])[1],
    tokenLocator: tokenLocatorEvidence(accountId, service),
  });
}

export function inspectDisposableTeardownWrapper(path, { accountId } = {}) {
  const wrapper = readStableProgram(
    path,
    MAX_WRAPPER_BYTES,
    "TEARDOWN_WRAPPER_UNSAFE",
    { executable: true, privateParent: true },
  );
  const contract = validateDisposableTeardownWrapperProgram(wrapper.program, { accountId });
  return immutable({ ...wrapper, ...contract });
}

function safeChildEnvironment(provider) {
  if (!provider || !isAbsolute(provider.path) ||
      !SHA256_RE.test(provider.sha256 || "") ||
      sha256(provider.program || "") !== provider.sha256) {
    refuse("TEARDOWN_PROVIDER_PROGRAM_UNSAFE");
  }
  return Object.freeze({
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C",
    LC_ALL: "C",
    BRAIN_TEARDOWN_NODE: process.execPath,
    BRAIN_TEARDOWN_PROVIDER_SOURCE: provider.program,
  });
}

function defaultRunWrapper({ wrapper, requestBytes, env }) {
  return spawnSync(wrapper.path, [], {
    cwd: "/",
    env,
    input: requestBytes,
    encoding: null,
    maxBuffer: MAX_CHILD_BYTES,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: CHILD_TIMEOUT_MS,
    windowsHide: true,
  });
}

function providerCommon(value, operation, role) {
  if (!plainObject(value) || value.schema_version !== 1 ||
      value.operation !== operation || value.role !== role) {
    refuse("TEARDOWN_PROVIDER_RECEIPT_INVALID");
  }
  return value;
}

function validateStorageInventoryPasses(value, states, entryCounts) {
  if (!exactKeys(value, STORAGE_RESOURCE_ORDER) ||
      !exactKeys(states, RESOURCE_ORDER)) {
    refuse("TEARDOWN_CUSTODY_INVALID");
  }
  for (const kind of STORAGE_RESOURCE_ORDER) {
    const passes = value[kind];
    const expectedMatches = states[kind] === "present" ? 1 : 0;
    if (!Array.isArray(passes) || passes.length !== 2 ||
        canonical(passes[0]) !== canonical(passes[1])) {
      refuse("TEARDOWN_CUSTODY_INVALID");
    }
    for (const pass of passes) {
      if (!exactKeys(pass, [
        "resource_kind", "pagination_complete", "entries_inspected",
        "matching_resources", "inventory_sha256",
      ]) || pass.resource_kind !== kind || pass.pagination_complete !== true ||
          !Number.isSafeInteger(pass.entries_inspected) ||
          pass.entries_inspected < 0 ||
          pass.entries_inspected !== entryCounts[kind] ||
          pass.matching_resources !== expectedMatches ||
          !SHA256_RE.test(String(pass.inventory_sha256 || ""))) {
        refuse("TEARDOWN_CUSTODY_INVALID");
      }
    }
  }
  return immutable(structuredClone(value));
}

function validateWorkerSchedules(value, states) {
  const workerPresent = states?.worker === "present";
  if (!exactKeys(value, [
    "count", "exact_endpoint_status", "missing_code_sha256",
    "schedules_sha256",
  ]) || value.count !== 0 ||
      value.exact_endpoint_status !== (workerPresent ? 200 : 404) ||
      value.missing_code_sha256 !== (workerPresent
        ? null
        : WORKER_MISSING_CODE_SHA256) ||
      value.schedules_sha256 !== EMPTY_SCHEDULES_SHA256) {
    refuse("TEARDOWN_CUSTODY_INVALID");
  }
  return immutable(structuredClone(value));
}

function validateCustody(value, role = null, states = null) {
  if (!exactKeys(value, [
    "pagination_complete", "workers_inspected", "versions_inspected",
    "bindings_inspected", "d1_entries_inspected", "vectorize_entries_inspected",
    "other_campaign_worker_inspected",
    "incoming_references", "routes", "custom_domains",
    "worker_schedules", "storage_inventory_passes", "inventory_sha256",
  ]) || value.pagination_complete !== true ||
      typeof value.other_campaign_worker_inspected !== "boolean" ||
      !SHA256_RE.test(String(value.inventory_sha256 || "")) ||
      !exactKeys(value.incoming_references, [
        "version_references", "service_bindings", "tail_consumers",
      ]) || [
        value.workers_inspected, value.versions_inspected, value.bindings_inspected,
        value.d1_entries_inspected, value.vectorize_entries_inspected,
        value.incoming_references.version_references,
        value.incoming_references.service_bindings,
        value.incoming_references.tail_consumers,
        value.routes, value.custom_domains,
      ].some((number) => !Number.isSafeInteger(number) || number < 0) ||
      value.incoming_references.version_references !== 0 ||
      value.incoming_references.service_bindings !== 0 ||
      value.incoming_references.tail_consumers !== 0 ||
      value.routes !== 0 || value.custom_domains !== 0 ||
      role === "source" && value.other_campaign_worker_inspected !== true ||
      role === "target" && value.other_campaign_worker_inspected !== false) {
    refuse("TEARDOWN_CUSTODY_INVALID");
  }
  validateStorageInventoryPasses(value.storage_inventory_passes, states, {
    d1: value.d1_entries_inspected,
    vectorize: value.vectorize_entries_inspected,
  });
  validateWorkerSchedules(value.worker_schedules, states);
  return immutable(structuredClone(value));
}

export function assertDisposableTeardownProviderResult(value, {
  operation,
  role,
  kind = null,
  expectedInstanceFingerprint = null,
  maintenanceWindow = null,
} = {}) {
  providerCommon(value, operation, role);
  const expectedMaintenanceWindowSha256 = sha256(canonical(
    checkedMaintenanceWindow(maintenanceWindow),
  ));
  if (operation === "preview") {
    if (!exactKeys(value, [
      "schema_version", "operation", "role", "account_fingerprint",
      "target_fingerprint", "maintenance_window_sha256",
      "states", "instance_fingerprints",
      "exact_endpoint_statuses", "exact_endpoint_missing_code_sha256",
      "absence_authority", "custody", "snapshot_sha256",
    ]) || !SHA256_RE.test(value.account_fingerprint || "") ||
        !SHA256_RE.test(value.target_fingerprint || "") ||
        value.maintenance_window_sha256 !== expectedMaintenanceWindowSha256 ||
        !SHA256_RE.test(value.snapshot_sha256 || "") ||
        !exactKeys(value.states, RESOURCE_ORDER) ||
        !exactKeys(value.instance_fingerprints, RESOURCE_ORDER) ||
        !exactKeys(value.exact_endpoint_statuses, RESOURCE_ORDER) ||
        !exactKeys(value.exact_endpoint_missing_code_sha256, RESOURCE_ORDER) ||
        !exactKeys(value.absence_authority, RESOURCE_ORDER)) {
      refuse("TEARDOWN_PROVIDER_RECEIPT_INVALID");
    }
    for (const resource of RESOURCE_ORDER) {
      if (!new Set(["present", "absent"]).has(value.states[resource]) ||
          value.exact_endpoint_statuses[resource] !==
            (value.states[resource] === "present" ? 200 : 404) ||
          (value.states[resource] === "present"
            ? !SHA256_RE.test(value.instance_fingerprints[resource] || "")
            : value.instance_fingerprints[resource] !== null) ||
          (value.states[resource] === "present"
            ? value.exact_endpoint_missing_code_sha256[resource] !== null
            : !SHA256_RE.test(
              value.exact_endpoint_missing_code_sha256[resource] || "",
            )) || value.states[resource] === "absent" && resource === "worker" &&
              value.exact_endpoint_missing_code_sha256.worker !==
                WORKER_MISSING_CODE_SHA256 ||
          value.absence_authority[resource] !==
              (value.states[resource] === "present"
                ? "present"
                : resource === "worker"
                  ? "exact_id_404_code_10007"
                  : STORAGE_ABSENCE_AUTHORITY)) {
        refuse("TEARDOWN_PROVIDER_RECEIPT_INVALID");
      }
    }
    const base = { ...value };
    delete base.snapshot_sha256;
    if (sha256(canonical(base)) !== value.snapshot_sha256) {
      refuse("TEARDOWN_PROVIDER_RECEIPT_INVALID");
    }
    return immutable({
      ...structuredClone(value),
      custody: validateCustody(value.custody, role, value.states),
    });
  }
  if (!RESOURCE_ORDER.includes(kind) ||
      !SHA256_RE.test(expectedInstanceFingerprint || "") ||
      value.kind !== kind ||
      value.expected_instance_fingerprint !== expectedInstanceFingerprint) {
    refuse("TEARDOWN_PROVIDER_RECEIPT_INVALID");
  }
  if (operation === "delete") {
    if (!exactKeys(value, [
      "schema_version", "operation", "role", "kind",
      "expected_instance_fingerprint", "maintenance_window_sha256",
      "accepted", "response_status",
      "response_body_sha256",
    ]) || value.maintenance_window_sha256 !== expectedMaintenanceWindowSha256 ||
        value.accepted !== true || value.response_status !== 200 ||
        !SHA256_RE.test(value.response_body_sha256 || "")) {
      refuse("TEARDOWN_PROVIDER_RECEIPT_INVALID");
    }
  } else if (operation === "reconcile") {
    if (!exactKeys(value, [
      "schema_version", "operation", "role", "kind",
      "expected_instance_fingerprint", "maintenance_window_sha256",
      "exact_endpoint_status",
      "missing_code_sha256", "absence_authority", "absent",
      "current_instance_fingerprint",
    ]) || value.maintenance_window_sha256 !== expectedMaintenanceWindowSha256 ||
        ![200, 404].includes(value.exact_endpoint_status) ||
        value.absent !== (value.exact_endpoint_status === 404) ||
        (value.absent
          ? !SHA256_RE.test(value.missing_code_sha256 || "")
          : value.missing_code_sha256 !== null) ||
        value.absent && kind === "worker" &&
          value.missing_code_sha256 !== WORKER_MISSING_CODE_SHA256 ||
        value.absence_authority !== (value.absent
          ? kind === "worker"
            ? "exact_id_404_code_10007"
            : STORAGE_ABSENCE_AUTHORITY
          : "present") ||
        (value.absent
          ? value.current_instance_fingerprint !== null
          : value.current_instance_fingerprint !== expectedInstanceFingerprint)) {
      refuse("TEARDOWN_PROVIDER_RECEIPT_INVALID");
    }
  } else {
    refuse("TEARDOWN_PROVIDER_RECEIPT_INVALID");
  }
  return immutable(structuredClone(value));
}

export function createDisposableTeardownProviderInvoker({
  wrapper,
  provider,
  run = defaultRunWrapper,
} = {}) {
  if (!wrapper || wrapper.providerSha256 !== provider?.sha256 ||
      sha256(wrapper.program || "") !== wrapper.sha256 ||
      sha256(provider?.program || "") !== provider.sha256) {
    refuse("TEARDOWN_EXECUTION_PIN_MISMATCH");
  }
  return Object.freeze({
    async invoke(request) {
      let requestBytes;
      let child;
      try {
        requestBytes = Buffer.from(canonical(request), "utf8");
        child = run({
          wrapper,
          requestBytes,
          provider,
          env: safeChildEnvironment(provider),
        });
        if (child?.error || child?.signal || child?.status !== 0 ||
            !Buffer.isBuffer(child.stdout) || !Buffer.isBuffer(child.stderr) ||
            child.stderr.length !== 0 || child.stdout.length < 2 ||
            child.stdout.length > MAX_CHILD_BYTES) {
          refuse("TEARDOWN_PROVIDER_OUTCOME_UNKNOWN");
        }
        let parsed;
        try { parsed = JSON.parse(child.stdout.toString("utf8")); }
        catch { refuse("TEARDOWN_PROVIDER_OUTCOME_UNKNOWN"); }
        if (!exactKeys(parsed, ["schema_version", "ok", "result"]) ||
            parsed.schema_version !== 1 || parsed.ok !== true) {
          refuse("TEARDOWN_PROVIDER_OUTCOME_UNKNOWN");
        }
        return assertDisposableTeardownProviderResult(parsed.result, {
          operation: request.operation,
          role: request.role,
          kind: request.kind,
          expectedInstanceFingerprint: request.expected_instance_fingerprint,
          maintenanceWindow: request.maintenance_window,
        });
      } finally {
        requestBytes?.fill?.(0);
        child?.stdout?.fill?.(0);
        child?.stderr?.fill?.(0);
      }
    },
  });
}

function checkedManifestBinding(manifest, role) {
  if (!plainObject(manifest) ||
      !ACCOUNT_ID_RE.test(String(manifest.accountId || "").toLowerCase()) ||
      !WORKER_ID_RE.test(String(manifest.workerId || "").toLowerCase()) ||
      !UUID_RE.test(String(manifest.databaseId || "").toLowerCase()) ||
      manifest.workerName !== DISPOSABLE_TEARDOWN_NAMES[role] ||
      manifest.databaseName !== DISPOSABLE_TEARDOWN_NAMES[role] ||
      manifest.vectorizeIndex !== DISPOSABLE_TEARDOWN_NAMES[role]) {
    refuse("TEARDOWN_PREPARATION_INVALID");
  }
  return manifest;
}

function checkedProvisionArtifacts(
  value,
  manifest,
  manifestFingerprint,
  role,
  preparationBinding,
  keychainProof,
) {
  const provisionBinding = value?.binding;
  const provisionManifest = value?.manifest;
  const provisionReceipt = value?.receipt;
  const campaignBase = plainObject(provisionBinding)
    ? { ...provisionBinding }
    : null;
  if (campaignBase) delete campaignBase.campaign_fingerprint;
  const cloudflare = provisionManifest?.infrastructure?.cloudflare;
  if (!VERIFIED_PROVISION_ARTIFACTS.has(value) ||
      !plainObject(value) || value.role !== role ||
      value.accountId !== manifest.accountId ||
      value.resourceName !== manifest.workerName ||
      value.workerId !== manifest.workerId ||
      value.databaseId !== manifest.databaseId ||
      !exactUtcRfc3339(value.vectorizeCreatedOn) ||
      !exactUtcRfc3339(value.completedAt) ||
      !SHA256_RE.test(String(value.receiptSha256 || "")) ||
      !SHA256_RE.test(String(value.manifestSha256 || "")) ||
      value.manifestSha256 !== manifestFingerprint ||
      !plainObject(provisionBinding) || !plainObject(provisionManifest) ||
      !plainObject(provisionReceipt) ||
      privateReceiptSha256(provisionReceipt) !== value.receiptSha256 ||
      privateReceiptSha256(provisionManifest) !== value.manifestSha256 ||
      canonical(provisionReceipt.binding) !== canonical(provisionBinding) ||
      provisionReceipt.completed_at !== value.completedAt ||
      provisionReceipt.manifest_sha256 !== value.manifestSha256 ||
      provisionReceipt.final_state?.account_id !== value.accountId ||
      provisionReceipt.final_state?.resource_name !== value.resourceName ||
      provisionReceipt.final_state?.worker_id !== value.workerId ||
      provisionReceipt.final_state?.database_id !== value.databaseId ||
      provisionReceipt.final_state?.vectorize_created_on !==
        value.vectorizeCreatedOn ||
      provisionBinding.role !== role ||
      provisionBinding.action !== (role === "source" ? "A1" : "A3") ||
      provisionBinding.account_id !== manifest.accountId ||
      provisionBinding.resource_name !== manifest.workerName ||
      !SHA256_RE.test(String(provisionBinding.campaign_fingerprint || "")) ||
      provisionBinding.campaign_fingerprint !== sha256(canonical(campaignBase)) ||
      PROVISION_PREPARATION_OVERLAP_FIELDS.some((field) =>
        !Object.hasOwn(preparationBinding, field) ||
        provisionBinding[field] !== preparationBinding[field]) ||
      provisionBinding.keychain_prep_receipt_sha256 !==
        keychainProof.receipt_sha256 ||
      provisionBinding.keychain_preparation_fingerprint !==
        keychainProof.preparation_fingerprint ||
      provisionBinding.keychain_account_fingerprint !==
        keychainProof.account_fingerprint ||
      canonical(provisionBinding.campaign_keychain_items) !==
        canonical(keychainProof.campaign_items) ||
      provisionBinding.keychain_binding_sha256 !==
        keychainProof.keychain_binding_sha256 ||
      provisionManifest.brain?.worker_name !== manifest.workerName ||
      cloudflare?.account_id !== manifest.accountId ||
      cloudflare?.worker_id !== manifest.workerId ||
      cloudflare?.d1_database_id !== manifest.databaseId ||
      cloudflare?.d1_database_name !== manifest.databaseName ||
      cloudflare?.vectorize_index !== manifest.vectorizeIndex) {
    refuse("TEARDOWN_PROVISION_IDENTITY_MISMATCH");
  }
  return value;
}

function checkedTargetEvalReceipt(preparation) {
  const loaded = preparation.targetEvalReceipt;
  if (!plainObject(loaded) || !plainObject(loaded.value) ||
      !SHA256_RE.test(String(loaded.sha256 || ""))) {
    refuse("TEARDOWN_TARGET_EVAL_RECEIPT_INVALID");
  }
  let receipt;
  try {
    receipt = assertDisposableRecoveryTargetEvalReceipt(
      loaded.value,
      loaded.value.binding,
    );
  } catch {
    refuse("TEARDOWN_TARGET_EVAL_RECEIPT_INVALID");
  }
  const expected = preparation.binding;
  const actual = receipt.binding;
  if (privateReceiptSha256(receipt) !== loaded.sha256 ||
      actual.candidate_sha !== expected.candidate_sha ||
      actual.candidate_tree_sha !== expected.candidate_tree_sha ||
      actual.package_sha256 !== expected.package_sha256 ||
      actual.field_receipt_sha256 !== expected.field_receipt_sha256 ||
      actual.keychain_binding_sha256 !== expected.keychain_binding_sha256 ||
      actual.campaign_fingerprint !== expected.campaign_fingerprint ||
      actual.recovery_plan_fingerprint !== expected.plan_fingerprint ||
      actual.source_resource_fingerprint !== expected.source_resource_fingerprint ||
      actual.target_resource_fingerprint !== expected.target_resource_fingerprint) {
    refuse("TEARDOWN_TARGET_EVAL_RECEIPT_INVALID");
  }
  return immutable({
    sha256: loaded.sha256,
    completedAt: receipt.completed_at,
  });
}

function checkedA12Evidence(value, targetEvalReceipt, targetEval) {
  if (!VERIFIED_A12_EVIDENCE.has(value) || !exactKeys(value, [
    "state_sha256", "golden_sha256", "deployment_receipt_sha256",
    "state_deployment_receipt_sha256", "deployment_completed_at",
    "state_updated_at", "active_worker_version_id", "target_eval_receipt",
  ]) || [value.state_sha256, value.golden_sha256,
    value.deployment_receipt_sha256, value.state_deployment_receipt_sha256]
    .some((hash) => !SHA256_RE.test(String(hash || ""))) ||
      typeof value.active_worker_version_id !== "string" ||
      !value.active_worker_version_id ||
      !exactUtcRfc3339(value.deployment_completed_at) ||
      !exactUtcRfc3339(value.state_updated_at) ||
      value.state_sha256 !==
        targetEvalReceipt.value.binding.recovery_state_sha256 ||
      value.golden_sha256 !== targetEvalReceipt.value.binding.golden_sha256 ||
      value.deployment_receipt_sha256 !==
        value.state_deployment_receipt_sha256 ||
      value.active_worker_version_id !==
        targetEvalReceipt.value.binding.active_worker_version_id ||
      canonical(value.target_eval_receipt) !== canonical(targetEvalReceipt) ||
      value.target_eval_receipt.sha256 !== targetEval.sha256 ||
      Date.parse(value.deployment_completed_at) >
        Date.parse(value.state_updated_at) ||
      Date.parse(value.state_updated_at) > Date.parse(targetEval.completedAt)) {
    refuse("TEARDOWN_TARGET_EVAL_RECEIPT_INVALID");
  }
  return value;
}

function checkedPreparation(preparation, role) {
  if (!plainObject(preparation) || !plainObject(preparation.binding) ||
      !plainObject(preparation.manifestBindings) ||
      !plainObject(preparation.provisionArtifacts) ||
      !plainObject(preparation.a12Evidence) ||
      typeof preparation.revalidate !== "function" ||
      typeof preparation.revalidateKeychain !== "function" ||
      !plainObject(preparation.keychainProof) ||
      !Array.isArray(preparation.executionPins) ||
      !["source", "target"].includes(role)) {
    refuse("TEARDOWN_PREPARATION_INVALID");
  }
  const binding = preparation.binding;
  const requiredHashes = [
    binding.campaign_fingerprint,
    binding.plan_fingerprint,
    binding.package_sha256,
    binding.field_receipt_sha256,
    binding.keychain_binding_sha256,
    binding.wrangler_wrapper_sha256,
    binding.source_manifest_fingerprint,
    binding.source_resource_fingerprint,
    binding.target_manifest_fingerprint,
    binding.target_resource_fingerprint,
    binding.runtime_contract_fingerprint,
  ];
  if (!SHA40_RE.test(String(binding.candidate_sha || "")) ||
      !SHA40_RE.test(String(binding.candidate_tree_sha || "")) ||
      requiredHashes.some((hash) => !SHA256_RE.test(String(hash || ""))) ||
      preparation.manifestBindings.planFingerprint !== binding.plan_fingerprint ||
      preparation.manifestBindings.sourceManifestFingerprint !==
        binding.source_manifest_fingerprint ||
      preparation.manifestBindings.targetManifestFingerprint !==
        binding.target_manifest_fingerprint) {
    refuse("TEARDOWN_PREPARATION_INVALID");
  }
  let keychainProof;
  try {
    keychainProof = assertDisposableRecoveryFieldKeychainVerificationCapability(
      preparation.keychainProof,
      binding.keychain_binding_sha256,
    );
  } catch {
    refuse("TEARDOWN_PREPARATION_INVALID");
  }
  const manifests = Object.freeze({
    source: checkedManifestBinding(preparation.manifestBindings.source, "source"),
    target: checkedManifestBinding(preparation.manifestBindings.target, "target"),
  });
  if (manifests.source.accountId.toLowerCase() !==
      manifests.target.accountId.toLowerCase()) {
    refuse("TEARDOWN_PREPARATION_INVALID");
  }
  const manifest = manifests[role];
  try {
    const expectedKeychainPreparation =
      disposableRecoveryFieldKeychainPreparationFingerprint({
        candidate_sha: binding.candidate_sha,
        candidate_tree_sha: binding.candidate_tree_sha,
        package_sha256: binding.package_sha256,
        field_receipt_sha256: binding.field_receipt_sha256,
        account_id: manifest.accountId.toLowerCase(),
      });
    if (keychainProof.account_fingerprint !==
          sha256(manifest.accountId.toLowerCase()) ||
        keychainProof.preparation_fingerprint !== expectedKeychainPreparation) {
      refuse("TEARDOWN_PREPARATION_INVALID");
    }
  } catch {
    refuse("TEARDOWN_PREPARATION_INVALID");
  }
  const provisions = Object.freeze({
    source: checkedProvisionArtifacts(
      preparation.provisionArtifacts.source,
      manifests.source,
      preparation.manifestBindings.sourceManifestFingerprint,
      "source",
      binding,
      keychainProof,
    ),
    target: checkedProvisionArtifacts(
      preparation.provisionArtifacts.target,
      manifests.target,
      preparation.manifestBindings.targetManifestFingerprint,
      "target",
      binding,
      keychainProof,
    ),
  });
  const targetEval = checkedTargetEvalReceipt(preparation);
  const a12Evidence = checkedA12Evidence(
    preparation.a12Evidence,
    preparation.targetEvalReceipt,
    targetEval,
  );
  if (Date.parse(provisions.source.completedAt) >
        Date.parse(provisions.target.completedAt) ||
      Date.parse(provisions.target.completedAt) >
        Date.parse(a12Evidence.deployment_completed_at) ||
      [provisions.source, provisions.target].some((provisionArtifact) =>
        Date.parse(provisionArtifact.completedAt) > Date.parse(targetEval.completedAt))) {
    refuse("TEARDOWN_PROVISION_IDENTITY_MISMATCH");
  }
  const provision = provisions[role];
  const otherRole = role === "source" ? "target" : "source";
  return immutable({
    role,
    target: {
      account_id: manifest.accountId.toLowerCase(),
      worker_id: manifest.workerId.toLowerCase(),
      worker_name: manifest.workerName,
      database_id: manifest.databaseId.toLowerCase(),
      database_name: manifest.databaseName,
      vectorize_name: manifest.vectorizeIndex,
      vectorize_created_on: provision.vectorizeCreatedOn,
      other_worker_name: DISPOSABLE_TEARDOWN_NAMES[otherRole],
    },
    binding: {
      candidate_sha: binding.candidate_sha,
      candidate_tree_sha: binding.candidate_tree_sha,
      package_sha256: binding.package_sha256,
      field_receipt_sha256: binding.field_receipt_sha256,
      keychain_binding_sha256: binding.keychain_binding_sha256,
      campaign_fingerprint: binding.campaign_fingerprint,
      plan_fingerprint: binding.plan_fingerprint,
      resource_fingerprint: binding[`${role}_resource_fingerprint`],
      wrangler_wrapper_sha256: binding.wrangler_wrapper_sha256,
      provision_receipt_sha256: provision.receiptSha256,
      provision_manifest_sha256: provision.manifestSha256,
      target_eval_receipt_sha256: targetEval.sha256,
    },
    target_eval_completed_at: targetEval.completedAt,
  });
}

async function revalidatePreparation(preparation, sourceTeardownReceipt = null) {
  const sourceProvisionRevalidate = VERIFIED_PROVISION_ARTIFACTS.get(
    preparation.provisionArtifacts?.source,
  );
  const targetProvisionRevalidate = VERIFIED_PROVISION_ARTIFACTS.get(
    preparation.provisionArtifacts?.target,
  );
  const a12Revalidate = VERIFIED_A12_EVIDENCE.get(preparation.a12Evidence);
  const sourceTeardownRevalidate = sourceTeardownReceipt === null
    ? null
    : VERIFIED_SOURCE_TEARDOWN_RECEIPTS.get(sourceTeardownReceipt);
  if (typeof sourceProvisionRevalidate !== "function" ||
      typeof targetProvisionRevalidate !== "function" ||
      typeof a12Revalidate !== "function" ||
      sourceTeardownReceipt !== null &&
        typeof sourceTeardownRevalidate !== "function") {
    refuse("TEARDOWN_PREPARATION_CHANGED");
  }
  const revalidateOwnedEvidence = async () =>
    await sourceProvisionRevalidate() === true &&
    await targetProvisionRevalidate() === true &&
    await a12Revalidate() === true &&
    (sourceTeardownRevalidate === null ||
      await sourceTeardownRevalidate() === true);
  let ownedBefore;
  let local;
  let keychain;
  let suppliedKeychain;
  let finalLocal;
  let ownedAfter;
  try {
    ownedBefore = await revalidateOwnedEvidence();
    if (ownedBefore === true) local = await preparation.revalidate();
    if (local === true) {
      keychain = await assertDisposableRecoveryFieldKeychainVerificationCapability(
        preparation.keychainProof,
        preparation.binding.keychain_binding_sha256,
      ).revalidate();
    }
    if (keychain === true) {
      suppliedKeychain = await preparation.revalidateKeychain();
    }
    if (suppliedKeychain === true) finalLocal = await preparation.revalidate();
    if (finalLocal === true) ownedAfter = await revalidateOwnedEvidence();
  } catch {
    refuse("TEARDOWN_PREPARATION_CHANGED");
  }
  if (ownedBefore !== true || local !== true || keychain !== true ||
      suppliedKeychain !== true || finalLocal !== true || ownedAfter !== true) {
    refuse("TEARDOWN_PREPARATION_CHANGED");
  }
  return true;
}

function assertProviderPin(preparation, provider) {
  const pin = preparation.executionPins.find((entry) =>
    entry?.relative === PROVIDER_RELATIVE);
  if (!pin || pin.path !== provider.path || pin.hash !== provider.sha256 ||
      !sameFile(pin.info, provider.info)) {
    refuse("TEARDOWN_PROVIDER_PROGRAM_NOT_PACKAGE_PINNED");
  }
  return true;
}

function providerRequest(
  operation,
  prepared,
  maintenanceWindow,
  kind = null,
  fingerprint = null,
) {
  return immutable({
    schema_version: 1,
    operation,
    role: prepared.role,
    kind,
    target: prepared.target,
    expected_instance_fingerprint: fingerprint,
    maintenance_window: checkedMaintenanceWindow(maintenanceWindow),
  });
}

function previewReceipt(
  prepared,
  providerSnapshot,
  wrapper,
  provider,
  createdAt,
  sourceTeardownReceiptSha256,
  targetEvalReceiptSha256,
  maintenanceWindow,
) {
  const base = {
    schema_version: 1,
    kind: "v048_disposable_teardown_preview",
    role: prepared.role,
    status: "ready_for_separate_approval",
    created_at: createdAt,
    binding: prepared.binding,
    teardown_wrapper_sha256: wrapper.sha256,
    teardown_provider_sha256: provider.sha256,
    teardown_token_locator: wrapper.tokenLocator,
    account_fingerprint: providerSnapshot.account_fingerprint,
    target_fingerprint: providerSnapshot.target_fingerprint,
    provider_snapshot_sha256: providerSnapshot.snapshot_sha256,
    target_eval_receipt_sha256: targetEvalReceiptSha256,
    source_teardown_receipt_sha256: sourceTeardownReceiptSha256,
    maintenance_window: maintenanceWindow,
    maintenance_window_sha256: providerSnapshot.maintenance_window_sha256,
    resources: providerSnapshot.states,
    instance_fingerprints: providerSnapshot.instance_fingerprints,
    custody: providerSnapshot.custody,
  };
  return immutable({ ...base, approval_fingerprint: sha256(canonical(base)) });
}

function checkedSourceTeardownReceipt(preparation, loaded, {
  expectedSha256 = null,
  notAfter = null,
  readerOwned = false,
} = {}) {
  if (!readerOwned && !VERIFIED_SOURCE_TEARDOWN_RECEIPTS.has(loaded)) {
    refuse("TEARDOWN_SOURCE_RECEIPT_INVALID");
  }
  let accepted;
  const prepared = checkedPreparation(preparation, "source");
  try {
    accepted = assertDisposableRecoveryBrainTeardownReceipt(loaded?.value, {
      role: "source",
      expectedBinding: prepared.binding,
    });
  } catch {
    refuse("TEARDOWN_SOURCE_RECEIPT_INVALID");
  }
  const sourceSha256 = loaded?.sha256;
  if (!SHA256_RE.test(String(sourceSha256 || "")) ||
      expectedSha256 !== null && sourceSha256 !== expectedSha256 ||
      Date.parse(prepared.target_eval_completed_at) >
        Date.parse(accepted.started_at) ||
      notAfter !== null && Date.parse(accepted.completed_at) > Date.parse(notAfter) ||
      privateReceiptSha256(accepted) !== sourceSha256) {
    refuse("TEARDOWN_SOURCE_RECEIPT_INVALID");
  }
  return immutable({ value: accepted, sha256: sourceSha256 });
}

/** Read A14 from its fixed path and retain reader-owned revalidation. */
export function readDisposableRecoverySourceTeardownReceipt(options) {
  if (!exactKeys(options, [
    "receiptPath", "expectedReceiptDirectory", "preparation",
  ])) {
    refuse("TEARDOWN_SOURCE_RECEIPT_INVALID");
  }
  const receiptPath = fixedReceiptPath(
    options.receiptPath,
    options.expectedReceiptDirectory,
    DISPOSABLE_RECOVERY_SOURCE_TEARDOWN_RECEIPT_NAME,
    "TEARDOWN_SOURCE_RECEIPT_INVALID",
  );
  const read = () => {
    let loaded;
    try {
      loaded = readPrivateAggregateReceipt(receiptPath, {
        code: "TEARDOWN_SOURCE_RECEIPT_INVALID",
      });
    } catch {
      refuse("TEARDOWN_SOURCE_RECEIPT_INVALID");
    }
    return checkedSourceTeardownReceipt(options.preparation, loaded, {
      readerOwned: true,
    });
  };
  const capability = read();
  const fingerprint = canonical(capability);
  VERIFIED_SOURCE_TEARDOWN_RECEIPTS.set(capability, async () => {
    try { return canonical(read()) === fingerprint; }
    catch { return false; }
  });
  return capability;
}

/** Assert that a source receipt came from the fixed A14 reader. */
export function assertDisposableRecoverySourceTeardownReceiptCapability(value) {
  if (!VERIFIED_SOURCE_TEARDOWN_RECEIPTS.has(value)) {
    refuse("TEARDOWN_SOURCE_RECEIPT_INVALID");
  }
  return value;
}

export function assertDisposableRecoveryTeardownPreview(value, {
  role = null,
  preparation = null,
} = {}) {
  if (!exactKeys(value, [
    "schema_version", "kind", "role", "status", "created_at", "binding",
    "teardown_wrapper_sha256", "teardown_provider_sha256",
    "teardown_token_locator",
    "account_fingerprint", "target_fingerprint", "provider_snapshot_sha256",
    "target_eval_receipt_sha256",
    "source_teardown_receipt_sha256",
    "maintenance_window", "maintenance_window_sha256",
    "resources", "instance_fingerprints", "custody", "approval_fingerprint",
  ]) || value.schema_version !== 1 ||
      value.kind !== "v048_disposable_teardown_preview" ||
      value.status !== "ready_for_separate_approval" ||
      !["source", "target"].includes(value.role) || role && value.role !== role ||
      (value.role === "source"
        ? value.source_teardown_receipt_sha256 !== null
        : !SHA256_RE.test(String(value.source_teardown_receipt_sha256 || ""))) ||
      value.target_eval_receipt_sha256 !==
        value.binding?.target_eval_receipt_sha256 ||
      new Date(value.created_at).toISOString() !== value.created_at ||
      [value.teardown_wrapper_sha256, value.teardown_provider_sha256,
        value.account_fingerprint, value.target_fingerprint,
        value.provider_snapshot_sha256, value.target_eval_receipt_sha256,
        value.maintenance_window_sha256, value.approval_fingerprint]
        .some((hash) => !SHA256_RE.test(String(hash || ""))) ||
      !exactKeys(value.resources, RESOURCE_ORDER) ||
      !exactKeys(value.instance_fingerprints, RESOURCE_ORDER) ||
      RESOURCE_ORDER.some((kind) => value.resources[kind] !== "present" ||
        !SHA256_RE.test(String(value.instance_fingerprints[kind] || "")))) {
    refuse("TEARDOWN_PREVIEW_INVALID");
  }
  const maintenanceWindow = checkedMaintenanceWindow(value.maintenance_window);
  if (value.maintenance_window_sha256 !== sha256(canonical(maintenanceWindow))) {
    refuse("TEARDOWN_PREVIEW_INVALID");
  }
  checkedTokenLocatorEvidence(
    value.teardown_token_locator,
    value.account_fingerprint,
  );
  validateCustody(value.custody, value.role, value.resources);
  if (preparation) {
    const expected = checkedPreparation(preparation, value.role);
    if (canonical(value.binding) !== canonical(expected.binding) ||
        Date.parse(expected.target_eval_completed_at) >
          Date.parse(value.created_at)) {
      refuse("TEARDOWN_PREVIEW_INVALID");
    }
  }
  const base = { ...value };
  delete base.approval_fingerprint;
  if (sha256(canonical(base)) !== value.approval_fingerprint) {
    refuse("TEARDOWN_PREVIEW_INVALID");
  }
  return immutable(structuredClone(value));
}

export async function runDisposableRecoveryTeardownPreview({
  preparation,
  role,
  receiptPath,
  teardownWrapperPath,
  sourceTeardownReceipt = null,
  maintenanceWindow,
  resume = false,
  now = () => new Date(),
  inspectWrapper = inspectDisposableTeardownWrapper,
  inspectProvider = inspectDisposableTeardownProviderProgram,
  createInvoker = createDisposableTeardownProviderInvoker,
  assertOutput = assertPrivateAggregateOutputPath,
  reserve = reservePrivateAggregateReceipt,
  finalize = finalizePrivateAggregateReceipt,
  recover = recoverPrivateAggregateReceiptFinalization,
} = {}) {
  const prepared = checkedPreparation(preparation, role);
  const acceptedMaintenanceWindow = checkedMaintenanceWindow(maintenanceWindow);
  const createdAt = isoNow(now);
  if (Date.parse(prepared.target_eval_completed_at) > Date.parse(createdAt)) {
    refuse("TEARDOWN_TARGET_EVAL_RECEIPT_INVALID");
  }
  let sourceTeardownReceiptSha256 = null;
  if (role === "target") {
    sourceTeardownReceiptSha256 = checkedSourceTeardownReceipt(
      preparation,
      sourceTeardownReceipt,
      { notAfter: createdAt },
    ).sha256;
  } else if (sourceTeardownReceipt !== null) {
    refuse("TEARDOWN_PREVIEW_INVALID");
  }
  const revalidateEvidence = () => revalidatePreparation(
    preparation,
    role === "target" ? sourceTeardownReceipt : null,
  );
  await revalidateEvidence();
  const wrapper = inspectWrapper(teardownWrapperPath, {
    accountId: prepared.target.account_id,
  });
  const provider = inspectProvider();
  assertProviderPin(preparation, provider);
  if (wrapper.providerSha256 !== provider.sha256) {
    refuse("TEARDOWN_EXECUTION_PIN_MISMATCH");
  }
  await revalidateEvidence();
  const marker = {
    schema_version: 1,
    kind: "v048_disposable_teardown_preview_pending",
    role,
    campaign_fingerprint: prepared.binding.campaign_fingerprint,
    target_eval_receipt_sha256: prepared.binding.target_eval_receipt_sha256,
    teardown_token_locator_sha256: wrapper.tokenLocator.locator_sha256,
    teardown_wrapper_sha256: wrapper.sha256,
    teardown_provider_sha256: provider.sha256,
  };
  const absoluteReceiptPath = resolve(receiptPath);
  const recoveryOutput = resumableOutput(
    absoluteReceiptPath,
    dirname(absoluteReceiptPath),
    "TEARDOWN_PREVIEW_PATH_INVALID",
  );
  const validateCompletedPreview = (value) => {
    const accepted = assertDisposableRecoveryTeardownPreview(value, {
      role,
      preparation,
    });
    if (accepted.teardown_wrapper_sha256 !== wrapper.sha256 ||
        accepted.teardown_provider_sha256 !== provider.sha256 ||
        canonical(accepted.teardown_token_locator) !==
          canonical(wrapper.tokenLocator) ||
        accepted.source_teardown_receipt_sha256 !==
          sourceTeardownReceiptSha256) {
      refuse("TEARDOWN_PREVIEW_INVALID");
    }
    return accepted;
  };
  const recovery = await recoverCommittedAggregate(
    recoveryOutput,
    marker,
    (value) => validateCompletedPreview(value),
    {
      code: "TEARDOWN_PREVIEW_FINALIZATION_RECOVERY_INVALID",
      recover,
      revalidate: revalidateEvidence,
    },
  );
  if (recovery?.status === "finalized" ||
      existsSync(absoluteReceiptPath) &&
        !existsSync(privateAggregateReceiptPendingPath(absoluteReceiptPath)) &&
        !existsSync(privateAggregateReceiptCommitPath(absoluteReceiptPath))) {
    const completed = readPrivateAggregateReceipt(absoluteReceiptPath, {
      code: "TEARDOWN_PREVIEW_INVALID",
    });
    const receipt = validateCompletedPreview(completed.value);
    await revalidateEvidence();
    return immutable({
      receipt,
      approvalFingerprint: receipt.approval_fingerprint,
      alreadyComplete: true,
    });
  }
  const hasReservation = recovery?.status === "reservation_resumable" ||
    existsSync(absoluteReceiptPath) &&
      existsSync(privateAggregateReceiptPendingPath(absoluteReceiptPath)) &&
      !existsSync(privateAggregateReceiptCommitPath(absoluteReceiptPath));
  if (hasReservation && !resume) refuse("TEARDOWN_PREVIEW_RESUME_REQUIRED");
  const output = hasReservation
    ? recoveryOutput
    : assertOutput(receiptPath, { code: "TEARDOWN_PREVIEW_PATH_INVALID" });
  const reservation = hasReservation
    ? resumePrivateAggregateReceiptReservation(output, marker)
    : reserve(output, marker);
  try {
    const invoker = createInvoker({ wrapper, provider });
    const snapshot = await invoker.invoke(providerRequest(
      "preview",
      prepared,
      acceptedMaintenanceWindow,
    ));
    await revalidateEvidence();
    const receipt = previewReceipt(
      prepared,
      snapshot,
      wrapper,
      provider,
      createdAt,
      sourceTeardownReceiptSha256,
      prepared.binding.target_eval_receipt_sha256,
      acceptedMaintenanceWindow,
    );
    assertDisposableRecoveryTeardownPreview(receipt, { role, preparation });
    finalize(reservation, receipt);
    return immutable({ receipt, approvalFingerprint: receipt.approval_fingerprint });
  } catch (error) {
    abandonPrivateAggregateReceipt(reservation);
    throw error;
  }
}

function journalRecordName(role, sequence, kind, state) {
  return `v048-${role}-teardown-${String(sequence).padStart(2, "0")}-${kind}-${state}.json`;
}

function journalBinding(preview) {
  return sha256(canonical({
    role: preview.role,
    approval_fingerprint: preview.approval_fingerprint,
    provider_snapshot_sha256: preview.provider_snapshot_sha256,
  }));
}

function journalRequestSha(preview, kind) {
  return sha256(canonical({
    schema_version: 1,
    operation: "delete",
    role: preview.role,
    kind,
    instance_fingerprint: preview.instance_fingerprints[kind],
    target_fingerprint: preview.target_fingerprint,
    approval_fingerprint: preview.approval_fingerprint,
    maintenance_window_sha256: preview.maintenance_window_sha256,
  }));
}

function journalMarker(preview, sequence, kind, state) {
  return {
    schema_version: 1,
    kind: "v048_teardown_journal_record_pending",
    role: preview.role,
    sequence,
    resource_kind: kind,
    state,
    journal_binding_sha256: journalBinding(preview),
  };
}

function assertJournalRecord(value, preview, expected) {
  if (!exactKeys(value, [
    "schema_version", "kind", "role", "sequence", "resource_kind", "state",
    "recorded_at", "journal_binding_sha256", "instance_fingerprint",
    "request_sha256", "previous_record_sha256", "exact_endpoint_status",
  ]) || value.schema_version !== 1 || value.kind !== "v048_teardown_journal_record" ||
      value.role !== preview.role || value.sequence !== expected.sequence ||
      value.resource_kind !== expected.kind || value.state !== expected.state ||
      new Date(value.recorded_at).toISOString() !== value.recorded_at ||
      value.journal_binding_sha256 !== journalBinding(preview) ||
      value.instance_fingerprint !== preview.instance_fingerprints[expected.kind] ||
      value.request_sha256 !== journalRequestSha(preview, expected.kind) ||
      value.previous_record_sha256 !== expected.previousSha256 ||
      (FINAL_STATES.has(expected.state)
        ? value.exact_endpoint_status !== 404
        : value.exact_endpoint_status !== null)) {
    refuse("TEARDOWN_JOURNAL_INVALID");
  }
  return immutable(structuredClone(value));
}

function journalShape(records) {
  const result = new Map();
  for (const kind of RESOURCE_ORDER) result.set(kind, []);
  for (const record of records) result.get(record.value.resource_kind).push(record);
  return result;
}

async function readJournalRecords(directory, preview, {
  resume = false,
  recover = recoverPrivateAggregateReceiptFinalization,
  revalidate = () => true,
} = {}) {
  const records = [];
  let previousSha256 = null;
  let sequence = 1;
  for (const kind of RESOURCE_ORDER) {
    const states = [...STATE_ORDER, "confirmed", "reconciled"];
    let finalized = false;
    for (const state of states) {
      if (finalized) break;
      const alternatives = FINAL_STATES.has(state)
        ? ["confirmed", "reconciled"]
        : [state];
      const found = [];
      const resumable = [];
      for (const candidate of alternatives) {
        const path = join(
          directory,
          journalRecordName(preview.role, sequence, kind, candidate),
        );
        const output = resumableOutput(path, directory, "TEARDOWN_JOURNAL_INVALID");
        const recovery = await recoverCommittedAggregate(
          output,
          journalMarker(preview, sequence, kind, candidate),
          (value) => assertJournalRecord(value, preview, {
            sequence,
            kind,
            state: candidate,
            previousSha256,
          }),
          {
            code: "TEARDOWN_JOURNAL_FINALIZATION_RECOVERY_INVALID",
            recover,
            revalidate,
          },
        );
        if (recovery?.status === "finalized") found.push(candidate);
        else if (recovery?.status === "reservation_resumable") {
          resumable.push(candidate);
        } else if (existsSync(path)) {
          if (existsSync(privateAggregateReceiptPendingPath(path))) {
            resumable.push(candidate);
          } else {
            found.push(candidate);
          }
        }
      }
      if (resumable.length > 1 || found.length > 0 && resumable.length > 0 ||
          resumable.length === 1 && !resume) {
        refuse("TEARDOWN_JOURNAL_INVALID");
      }
      if (found.length > 1) refuse("TEARDOWN_JOURNAL_INVALID");
      if (found.length === 0) {
        if (state === "planned" || state === "sent_unconfirmed") return records;
        break;
      }
      const selected = found[0];
      const file = readPrivateAggregateReceipt(join(
        directory,
        journalRecordName(preview.role, sequence, kind, selected),
      ), { code: "TEARDOWN_JOURNAL_INVALID" });
      const value = assertJournalRecord(file.value, preview, {
        sequence,
        kind,
        state: selected,
        previousSha256,
      });
      records.push({ value, sha256: file.sha256 });
      previousSha256 = file.sha256;
      sequence += 1;
      if (FINAL_STATES.has(selected)) finalized = true;
    }
    if (!finalized) break;
  }
  return records;
}

async function writeJournalRecord(directory, preview, records, kind, state, now, {
  resume = false,
  recover = recoverPrivateAggregateReceiptFinalization,
  revalidate = () => true,
  finalize = finalizePrivateAggregateReceipt,
  finalizeOptions = () => undefined,
} = {}) {
  const sequence = records.length + 1;
  const previousSha256 = records.at(-1)?.sha256 || null;
  const record = {
    schema_version: 1,
    kind: "v048_teardown_journal_record",
    role: preview.role,
    sequence,
    resource_kind: kind,
    state,
    recorded_at: isoNow(now),
    journal_binding_sha256: journalBinding(preview),
    instance_fingerprint: preview.instance_fingerprints[kind],
    request_sha256: journalRequestSha(preview, kind),
    previous_record_sha256: previousSha256,
    exact_endpoint_status: FINAL_STATES.has(state) ? 404 : null,
  };
  const path = join(directory, journalRecordName(preview.role, sequence, kind, state));
  const marker = journalMarker(preview, sequence, kind, state);
  const recoveryOutput = resumableOutput(
    path,
    directory,
    "TEARDOWN_JOURNAL_PATH_INVALID",
  );
  const recovery = await recoverCommittedAggregate(
    recoveryOutput,
    marker,
    (value) => assertJournalRecord(value, preview, {
      sequence,
      kind,
      state,
      previousSha256,
    }),
    {
      code: "TEARDOWN_JOURNAL_FINALIZATION_RECOVERY_INVALID",
      recover,
      revalidate,
    },
  );
  if (recovery?.status === "finalized") {
    const readback = readPrivateAggregateReceipt(path, {
      code: "TEARDOWN_JOURNAL_INVALID",
    });
    const value = assertJournalRecord(readback.value, preview, {
      sequence,
      kind,
      state,
      previousSha256,
    });
    records.push({ value, sha256: readback.sha256 });
    return records.at(-1);
  }
  const hasReservation = recovery?.status === "reservation_resumable" ||
    existsSync(path) && existsSync(privateAggregateReceiptPendingPath(path));
  if (hasReservation && !resume) refuse("TEARDOWN_JOURNAL_INVALID");
  const output = hasReservation
    ? recoveryOutput
    : assertPrivateAggregateOutputPath(path, {
      code: "TEARDOWN_JOURNAL_PATH_INVALID",
    });
  if (await revalidate() !== true) refuse("TEARDOWN_PREPARATION_CHANGED");
  const reservation = hasReservation
    ? resumePrivateAggregateReceiptReservation(output, marker)
    : reservePrivateAggregateReceipt(output, marker);
  try {
    finalize(reservation, record, finalizeOptions({
      sequence,
      kind,
      state,
      path,
    }));
    if (await revalidate() !== true) refuse("TEARDOWN_PREPARATION_CHANGED");
  } catch (error) {
    abandonPrivateAggregateReceipt(reservation);
    throw error;
  }
  const readback = readPrivateAggregateReceipt(path, { code: "TEARDOWN_JOURNAL_INVALID" });
  assertJournalRecord(readback.value, preview, {
    sequence,
    kind,
    state,
    previousSha256,
  });
  records.push({ value: readback.value, sha256: readback.sha256 });
  return records.at(-1);
}

function currentJournalState(records, kind) {
  const items = journalShape(records).get(kind);
  return items.at(-1)?.value.state || null;
}

function resumableJournalFinalState(directory, preview, records, kind) {
  const sequence = records.length + 1;
  const candidates = [...FINAL_STATES].filter((state) => {
    const path = join(
      directory,
      journalRecordName(preview.role, sequence, kind, state),
    );
    return existsSync(path) &&
      existsSync(privateAggregateReceiptPendingPath(path)) &&
      !existsSync(privateAggregateReceiptCommitPath(path));
  });
  if (candidates.length > 1) refuse("TEARDOWN_JOURNAL_INVALID");
  return candidates[0] || null;
}

function verifyCurrentSnapshot(snapshot, preview, records) {
  if (snapshot.account_fingerprint !== preview.account_fingerprint ||
      snapshot.target_fingerprint !== preview.target_fingerprint ||
      snapshot.maintenance_window_sha256 !==
        preview.maintenance_window_sha256 ||
      snapshot.custody.other_campaign_worker_inspected !==
        preview.custody.other_campaign_worker_inspected ||
      canonical(snapshot.custody.incoming_references) !==
        canonical(preview.custody.incoming_references) ||
      snapshot.custody.routes !== 0 || snapshot.custody.custom_domains !== 0 ||
      snapshot.custody.worker_schedules.count !== 0) {
    refuse("TEARDOWN_CURRENT_STATE_MISMATCH");
  }
  for (const kind of RESOURCE_ORDER) {
    const state = currentJournalState(records, kind);
    if (FINAL_STATES.has(state)) {
      if (snapshot.states[kind] !== "absent" ||
          snapshot.exact_endpoint_statuses[kind] !== 404) {
        refuse("TEARDOWN_CURRENT_STATE_MISMATCH");
      }
    } else if (state === "sent_unconfirmed") {
      if (snapshot.states[kind] === "present") {
        if (snapshot.instance_fingerprints[kind] !==
            preview.instance_fingerprints[kind]) {
          refuse("TEARDOWN_CURRENT_STATE_MISMATCH");
        }
      } else if (snapshot.states[kind] !== "absent" ||
          snapshot.exact_endpoint_statuses[kind] !== 404) {
        refuse("TEARDOWN_CURRENT_STATE_MISMATCH");
      }
    } else if (snapshot.states[kind] !== "present" ||
        snapshot.instance_fingerprints[kind] !==
          preview.instance_fingerprints[kind]) {
      refuse("TEARDOWN_CURRENT_STATE_MISMATCH");
    }
  }
  return true;
}

function validateWorkerSchedulePasses(value) {
  if (!exactKeys(value, ["present", "absent"])) {
    refuse("TEARDOWN_RECEIPT_INVALID");
  }
  validateWorkerSchedules(value.present, { worker: "present" });
  validateWorkerSchedules(value.absent, { worker: "absent" });
  return immutable(structuredClone(value));
}

export function assertDisposableRecoveryBrainTeardownReceipt(value, {
  role = null,
  expectedBinding = null,
  expectedSourceTeardownReceiptSha256 = undefined,
} = {}) {
  if (!exactKeys(value, [
    "schema_version", "kind", "role", "status", "binding",
    "resource_fingerprint", "started_at", "completed_at",
    "target_eval_receipt_sha256", "source_teardown_receipt_sha256",
    "present_preview_sha256", "custody", "actions",
    "absent_preview_sha256", "absence",
  ]) || value.schema_version !== 1 ||
      value.kind !== "v048_disposable_brain_teardown" ||
      value.status !== "passed" || !["source", "target"].includes(value.role) ||
      role && value.role !== role ||
      new Date(value.started_at).toISOString() !== value.started_at ||
      new Date(value.completed_at).toISOString() !== value.completed_at ||
      Date.parse(value.completed_at) < Date.parse(value.started_at) ||
      value.resource_fingerprint !== value.binding.resource_fingerprint ||
      value.target_eval_receipt_sha256 !==
        value.binding.target_eval_receipt_sha256 ||
      !SHA256_RE.test(value.target_eval_receipt_sha256 || "") ||
      (value.role === "source"
        ? value.source_teardown_receipt_sha256 !== null
        : !SHA256_RE.test(value.source_teardown_receipt_sha256 || "")) ||
      expectedSourceTeardownReceiptSha256 !== undefined &&
        value.source_teardown_receipt_sha256 !==
          expectedSourceTeardownReceiptSha256 ||
      !SHA256_RE.test(value.present_preview_sha256 || "") ||
      !SHA256_RE.test(value.absent_preview_sha256 || "") ||
      value.present_preview_sha256 === value.absent_preview_sha256 ||
      !exactKeys(value.custody, [
        "pagination_complete", "incoming_references", "routes",
        "custom_domains", "worker_schedule_passes",
        "storage_inventory_passes", "resources",
      ]) || value.custody.pagination_complete !== true ||
      !exactKeys(value.custody.incoming_references, [
        "version_references", "service_bindings", "tail_consumers",
      ]) || Object.values(value.custody.incoming_references).some((count) => count !== 0) ||
      value.custody.routes !== 0 || value.custody.custom_domains !== 0 ||
      !validateWorkerSchedulePasses(value.custody.worker_schedule_passes) ||
      !validateStorageInventoryPasses(
        value.custody.storage_inventory_passes,
        { worker: "absent", vectorize: "absent", d1: "absent" },
        {
          d1: value.custody.storage_inventory_passes?.d1?.[0]?.entries_inspected,
          vectorize:
            value.custody.storage_inventory_passes?.vectorize?.[0]?.entries_inspected,
        },
      ) ||
      !Array.isArray(value.custody.resources) || value.custody.resources.length !== 3 ||
      !Array.isArray(value.actions) || value.actions.length !== 3 ||
      !exactKeys(value.absence, ["present", "absent"]) ||
      value.absence.present !== 0 || value.absence.absent !== 3) {
    refuse("TEARDOWN_RECEIPT_INVALID");
  }
  if (expectedBinding && canonical(value.binding) !== canonical(expectedBinding)) {
    refuse("TEARDOWN_RECEIPT_INVALID");
  }
  for (let index = 0; index < RESOURCE_ORDER.length; index += 1) {
    const kind = RESOURCE_ORDER[index];
    const resource = value.custody.resources[index];
    const action = value.actions[index];
    if (!exactKeys(resource, ["kind", "instance_fingerprint"]) ||
        resource.kind !== kind || !SHA256_RE.test(resource.instance_fingerprint || "") ||
        !exactKeys(action, [
          "kind", "instance_fingerprint", "request_sha256", "transitions",
          "exact_endpoint_status", "missing_code_sha256", "absence_authority",
        ]) || action.kind !== kind ||
        action.instance_fingerprint !== resource.instance_fingerprint ||
        !SHA256_RE.test(action.request_sha256 || "") ||
        !Array.isArray(action.transitions) || action.transitions.length !== 3 ||
        action.transitions[0] !== "planned" ||
        action.transitions[1] !== "sent_unconfirmed" ||
        !FINAL_STATES.has(action.transitions[2]) ||
        action.exact_endpoint_status !== 404 ||
        !SHA256_RE.test(String(action.missing_code_sha256 || "")) ||
        kind === "worker" &&
          action.missing_code_sha256 !== WORKER_MISSING_CODE_SHA256 ||
        action.absence_authority !== (kind === "worker"
          ? "exact_id_404_code_10007"
          : STORAGE_ABSENCE_AUTHORITY)) {
      refuse("TEARDOWN_RECEIPT_INVALID");
    }
  }
  return immutable(structuredClone(value));
}

function receiptMarker(preview, approval) {
  return {
    schema_version: 1,
    kind: "v048_disposable_brain_teardown_pending",
    role: preview.role,
    approval_fingerprint: approval,
    present_preview_sha256: preview.provider_snapshot_sha256,
    target_eval_receipt_sha256: preview.target_eval_receipt_sha256,
  };
}

function absentMarker(preview, approval) {
  return {
    schema_version: 1,
    kind: "v048_disposable_teardown_absent_preview_pending",
    role: preview.role,
    approval_fingerprint: approval,
  };
}

function resumableOutput(path, directory, code) {
  if (!isAbsolute(path || "") || dirname(resolve(path)) !== directory) refuse(code);
  const parent = assertPrivateAggregateReceiptDirectory(directory, { code });
  const absolute = resolve(path);
  return Object.freeze({
    path: absolute,
    pendingPath: privateAggregateReceiptPendingPath(absolute),
    parent,
  });
}

function assertAbsentReceipt(value, role, snapshot = null) {
  if (!exactKeys(value, [
    "schema_version", "kind", "role", "status", "account_fingerprint",
    "target_fingerprint", "provider_snapshot_sha256", "resources",
      "exact_endpoint_statuses", "exact_endpoint_missing_code_sha256",
      "absence_authority", "custody",
  ]) || value.schema_version !== 1 ||
      value.kind !== "v048_disposable_teardown_absent_preview" ||
      value.role !== role || value.status !== "passed" ||
      !SHA256_RE.test(value.account_fingerprint || "") ||
      !SHA256_RE.test(value.target_fingerprint || "") ||
      !SHA256_RE.test(value.provider_snapshot_sha256 || "") ||
      !exactKeys(value.resources, RESOURCE_ORDER) ||
      !exactKeys(value.exact_endpoint_statuses, RESOURCE_ORDER) ||
      !exactKeys(value.exact_endpoint_missing_code_sha256, RESOURCE_ORDER) ||
      !exactKeys(value.absence_authority, RESOURCE_ORDER) ||
      RESOURCE_ORDER.some((kind) => value.resources[kind] !== "absent" ||
        value.exact_endpoint_statuses[kind] !== 404 ||
        !SHA256_RE.test(value.exact_endpoint_missing_code_sha256[kind] || "") ||
        kind === "worker" &&
          value.exact_endpoint_missing_code_sha256.worker !==
            WORKER_MISSING_CODE_SHA256 ||
        value.absence_authority[kind] !== (kind === "worker"
          ? "exact_id_404_code_10007"
          : STORAGE_ABSENCE_AUTHORITY))) {
    refuse("TEARDOWN_ABSENCE_UNCONFIRMED");
  }
  validateCustody(value.custody, role, value.resources);
  if (snapshot && (value.account_fingerprint !== snapshot.account_fingerprint ||
      value.target_fingerprint !== snapshot.target_fingerprint ||
      value.provider_snapshot_sha256 !== snapshot.snapshot_sha256 ||
      canonical(value.resources) !== canonical(snapshot.states) ||
      canonical(value.exact_endpoint_statuses) !==
        canonical(snapshot.exact_endpoint_statuses) ||
      canonical(value.exact_endpoint_missing_code_sha256) !==
        canonical(snapshot.exact_endpoint_missing_code_sha256) ||
      canonical(value.absence_authority) !== canonical(snapshot.absence_authority) ||
      canonical(value.custody) !== canonical(snapshot.custody))) {
    refuse("TEARDOWN_ABSENCE_UNCONFIRMED");
  }
  return immutable(structuredClone(value));
}

function assertAbsentReceiptBoundToPreview(value, role, preview) {
  const accepted = assertAbsentReceipt(value, role);
  if (accepted.account_fingerprint !== preview.account_fingerprint ||
      accepted.target_fingerprint !== preview.target_fingerprint ||
      canonical(accepted.custody.incoming_references) !==
        canonical(preview.custody.incoming_references) ||
      accepted.custody.routes !== preview.custody.routes ||
      accepted.custody.custom_domains !== preview.custody.custom_domains) {
    refuse("TEARDOWN_ABSENCE_UNCONFIRMED");
  }
  return accepted;
}

export async function runDisposableRecoveryTeardownMutation({
  preparation,
  role,
  preview,
  previewSha256,
  approvalFingerprint,
  teardownWrapperPath,
  receiptDirectory,
  receiptPath,
  absentPreviewPath,
  sourceTeardownReceipt = null,
  maintenanceWindow,
  resume = false,
  now = () => new Date(),
  inspectWrapper = inspectDisposableTeardownWrapper,
  inspectProvider = inspectDisposableTeardownProviderProgram,
  createInvoker = createDisposableTeardownProviderInvoker,
  afterAbsentFinalized = () => true,
  recover = recoverPrivateAggregateReceiptFinalization,
  finalize = finalizePrivateAggregateReceipt,
  journalFinalizeOptions = () => undefined,
  absentFinalizeOptions = undefined,
  finalFinalizeOptions = undefined,
} = {}) {
  const prepared = checkedPreparation(preparation, role);
  const acceptedPreview = assertDisposableRecoveryTeardownPreview(preview, {
    role,
    preparation,
  });
  if (canonical(checkedMaintenanceWindow(maintenanceWindow)) !==
      canonical(acceptedPreview.maintenance_window)) {
    refuse("TEARDOWN_MAINTENANCE_WINDOW_REQUIRED");
  }
  if (role === "target") {
    checkedSourceTeardownReceipt(
      preparation,
      sourceTeardownReceipt,
      {
        expectedSha256: acceptedPreview.source_teardown_receipt_sha256,
        notAfter: acceptedPreview.created_at,
      },
    );
  } else if (sourceTeardownReceipt !== null) {
    refuse("TEARDOWN_SOURCE_RECEIPT_INVALID");
  }
  const revalidateEvidence = () => revalidatePreparation(
    preparation,
    role === "target" ? sourceTeardownReceipt : null,
  );
  if (!SHA256_RE.test(previewSha256 || "") ||
      privateReceiptSha256(acceptedPreview) !== previewSha256 ||
      approvalFingerprint !== acceptedPreview.approval_fingerprint) {
    refuse("TEARDOWN_APPROVAL_INVALID");
  }
  const mutationStartedAt = isoNow(now);
  if (Date.parse(mutationStartedAt) < Date.parse(acceptedPreview.created_at)) {
    refuse("TEARDOWN_CLOCK_INVALID");
  }
  await revalidateEvidence();
  const wrapper = inspectWrapper(teardownWrapperPath, {
    accountId: prepared.target.account_id,
  });
  const provider = inspectProvider();
  assertProviderPin(preparation, provider);
  if (wrapper.sha256 !== acceptedPreview.teardown_wrapper_sha256 ||
      provider.sha256 !== acceptedPreview.teardown_provider_sha256 ||
      canonical(wrapper.tokenLocator) !==
      canonical(acceptedPreview.teardown_token_locator) ||
      wrapper.providerSha256 !== provider.sha256) {
    refuse("TEARDOWN_EXECUTION_PIN_MISMATCH");
  }
  await revalidateEvidence();
  let directory;
  try {
    directory = assertPrivateAggregateReceiptDirectory(resolve(receiptDirectory), {
      code: "TEARDOWN_RECEIPT_DIRECTORY_INVALID",
    }).path;
  } catch {
    refuse("TEARDOWN_RECEIPT_DIRECTORY_INVALID");
  }
  if (dirname(resolve(receiptPath)) !== directory ||
      dirname(resolve(absentPreviewPath)) !== directory ||
      resolve(receiptPath) === resolve(absentPreviewPath)) {
    refuse("TEARDOWN_RECEIPT_PATH_INVALID");
  }
  const finalMarker = receiptMarker(acceptedPreview, approvalFingerprint);
  const absentReceiptMarker = absentMarker(acceptedPreview, approvalFingerprint);
  const resumableFinalOutput = resumableOutput(
    resolve(receiptPath),
    directory,
    "TEARDOWN_RECEIPT_PATH_INVALID",
  );
  const resumableAbsentOutput = resumableOutput(
    resolve(absentPreviewPath),
    directory,
    "TEARDOWN_RECEIPT_PATH_INVALID",
  );
  const finalRecovery = await recoverCommittedAggregate(
    resumableFinalOutput,
    finalMarker,
    (value) => assertDisposableRecoveryBrainTeardownReceipt(value, {
      role,
      expectedBinding: prepared.binding,
      expectedSourceTeardownReceiptSha256:
        acceptedPreview.source_teardown_receipt_sha256,
    }),
    {
      code: "TEARDOWN_RECEIPT_FINALIZATION_RECOVERY_INVALID",
      recover,
      revalidate: revalidateEvidence,
    },
  );
  const absentRecovery = await recoverCommittedAggregate(
    resumableAbsentOutput,
    absentReceiptMarker,
    (value) => assertAbsentReceiptBoundToPreview(value, role, acceptedPreview),
    {
      code: "TEARDOWN_ABSENT_FINALIZATION_RECOVERY_INVALID",
      recover,
      revalidate: revalidateEvidence,
    },
  );
  if (resume && existsSync(resolve(receiptPath)) &&
      !existsSync(privateAggregateReceiptCommitPath(resolve(receiptPath))) &&
      !existsSync(privateAggregateReceiptPendingPath(resolve(receiptPath)))) {
    const completed = readPrivateAggregateReceipt(resolve(receiptPath), {
      code: "TEARDOWN_RECEIPT_INVALID",
    });
    const accepted = assertDisposableRecoveryBrainTeardownReceipt(completed.value, {
      role,
      expectedBinding: prepared.binding,
      expectedSourceTeardownReceiptSha256:
        acceptedPreview.source_teardown_receipt_sha256,
    });
    return immutable({ receipt: accepted, alreadyComplete: true });
  }
  const finalOutput = resume
    ? resumableFinalOutput
    : assertPrivateAggregateOutputPath(receiptPath, {
      code: "TEARDOWN_RECEIPT_PATH_INVALID",
    });
  const absentIsFinal = resume && existsSync(resolve(absentPreviewPath)) &&
    !existsSync(privateAggregateReceiptCommitPath(resolve(absentPreviewPath))) &&
    !existsSync(privateAggregateReceiptPendingPath(resolve(absentPreviewPath)));
  const absentOutput = absentIsFinal
    ? null
    : resume
      ? resumableAbsentOutput
      : assertPrivateAggregateOutputPath(absentPreviewPath, {
        code: "TEARDOWN_RECEIPT_PATH_INVALID",
      });
  const finalReservation = resume ||
      finalRecovery?.status === "reservation_resumable"
    ? resumePrivateAggregateReceiptReservation(finalOutput, finalMarker)
    : reservePrivateAggregateReceipt(finalOutput, finalMarker);
  let absentReservation;
  try {
    absentReservation = absentIsFinal
      ? null
      : resume || absentRecovery?.status === "reservation_resumable"
      ? resumePrivateAggregateReceiptReservation(absentOutput,
        absentReceiptMarker)
      : reservePrivateAggregateReceipt(absentOutput,
        absentReceiptMarker);
  } catch (error) {
    abandonPrivateAggregateReceipt(finalReservation);
    throw error;
  }
  try {
    await revalidateEvidence();
    const invoker = createInvoker({ wrapper, provider });
    const journalOptions = {
      resume,
      recover,
      revalidate: revalidateEvidence,
      finalize,
      finalizeOptions: journalFinalizeOptions,
    };
    const records = await readJournalRecords(
      directory,
      acceptedPreview,
      journalOptions,
    );
    const current = await invoker.invoke(providerRequest(
      "preview",
      prepared,
      acceptedPreview.maintenance_window,
    ));
    verifyCurrentSnapshot(current, acceptedPreview, records);
    await revalidateEvidence();

    for (const kind of RESOURCE_ORDER) {
      let state = currentJournalState(records, kind);
      if (FINAL_STATES.has(state)) continue;
      if (state === null) {
        await writeJournalRecord(
          directory, acceptedPreview, records, kind, "planned", now, journalOptions,
        );
        state = "planned";
      }
      let deleteConfirmed = false;
      if (state === "planned") {
        // This durable marker is the last operation before the provider call.
        // Its existence means every future invocation may reconcile only.
        await writeJournalRecord(
          directory,
          acceptedPreview,
          records,
          kind,
          "sent_unconfirmed",
          now,
          journalOptions,
        );
        await revalidateEvidence();
        try {
          await invoker.invoke(providerRequest(
            "delete",
            prepared,
            acceptedPreview.maintenance_window,
            kind,
            acceptedPreview.instance_fingerprints[kind],
          ));
          deleteConfirmed = true;
        } catch {
          // The response boundary cannot prove whether Cloudflare accepted the
          // DELETE. Continue only with the exact endpoint read below.
          deleteConfirmed = false;
        }
      }
      await revalidateEvidence();
      let reconciled;
      try {
        reconciled = await invoker.invoke(providerRequest(
          "reconcile",
          prepared,
          acceptedPreview.maintenance_window,
          kind,
          acceptedPreview.instance_fingerprints[kind],
        ));
      } catch {
        refuse("TEARDOWN_RECONCILIATION_UNCONFIRMED");
      }
      await revalidateEvidence();
      if (reconciled.exact_endpoint_status !== 404 || reconciled.absent !== true) {
        refuse("TEARDOWN_SENT_UNCONFIRMED_REMAINS_OPEN");
      }
      await writeJournalRecord(
        directory,
        acceptedPreview,
        records,
        kind,
        resumableJournalFinalState(
          directory,
          acceptedPreview,
          records,
          kind,
        ) || (deleteConfirmed ? "confirmed" : "reconciled"),
        now,
        journalOptions,
      );
    }

    await revalidateEvidence();
    const absent = await invoker.invoke(providerRequest(
      "preview",
      prepared,
      acceptedPreview.maintenance_window,
    ));
    await revalidateEvidence();
    if (RESOURCE_ORDER.some((kind) => absent.states[kind] !== "absent" ||
        absent.instance_fingerprints[kind] !== null ||
        absent.exact_endpoint_statuses[kind] !== 404)) {
      refuse("TEARDOWN_ABSENCE_UNCONFIRMED");
    }
    const absentReceipt = immutable({
      schema_version: 1,
      kind: "v048_disposable_teardown_absent_preview",
      role,
      status: "passed",
      account_fingerprint: absent.account_fingerprint,
      target_fingerprint: absent.target_fingerprint,
      provider_snapshot_sha256: absent.snapshot_sha256,
      resources: absent.states,
      exact_endpoint_statuses: absent.exact_endpoint_statuses,
      exact_endpoint_missing_code_sha256:
        absent.exact_endpoint_missing_code_sha256,
      absence_authority: absent.absence_authority,
      custody: absent.custody,
    });
    assertAbsentReceipt(absentReceipt, role, absent);
    if (absentIsFinal) {
      const priorAbsent = readPrivateAggregateReceipt(absentPreviewPath, {
        code: "TEARDOWN_ABSENCE_UNCONFIRMED",
      });
      assertAbsentReceipt(priorAbsent.value, role, absent);
    } else {
      finalize(absentReservation, absentReceipt, absentFinalizeOptions);
    }
    afterAbsentFinalized();
    const absentReadback = readPrivateAggregateReceipt(absentPreviewPath, {
      code: "TEARDOWN_ABSENCE_UNCONFIRMED",
    });
    const completeRecords = await readJournalRecords(
      directory,
      acceptedPreview,
      journalOptions,
    );
    const actions = RESOURCE_ORDER.map((kind) => {
      const states = journalShape(completeRecords).get(kind).map((record) => record.value.state);
      if (states.length !== 3 || states[0] !== "planned" ||
          states[1] !== "sent_unconfirmed" || !FINAL_STATES.has(states[2])) {
        refuse("TEARDOWN_JOURNAL_INVALID");
      }
      return {
        kind,
        instance_fingerprint: acceptedPreview.instance_fingerprints[kind],
        request_sha256: journalRequestSha(acceptedPreview, kind),
        transitions: states,
        exact_endpoint_status: 404,
        missing_code_sha256:
          absent.exact_endpoint_missing_code_sha256[kind],
        absence_authority: absent.absence_authority[kind],
      };
    });
    const startedAt = completeRecords[0].value.recorded_at;
    const receipt = {
      schema_version: 1,
      kind: "v048_disposable_brain_teardown",
      role,
      status: "passed",
      binding: acceptedPreview.binding,
      resource_fingerprint: acceptedPreview.binding.resource_fingerprint,
      target_eval_receipt_sha256: acceptedPreview.target_eval_receipt_sha256,
      source_teardown_receipt_sha256:
        acceptedPreview.source_teardown_receipt_sha256,
      started_at: startedAt,
      completed_at: isoNow(now),
      present_preview_sha256: previewSha256,
      custody: {
        pagination_complete: acceptedPreview.custody.pagination_complete,
        incoming_references: acceptedPreview.custody.incoming_references,
        routes: acceptedPreview.custody.routes,
        custom_domains: acceptedPreview.custody.custom_domains,
        worker_schedule_passes: {
          present: acceptedPreview.custody.worker_schedules,
          absent: absent.custody.worker_schedules,
        },
        storage_inventory_passes: absent.custody.storage_inventory_passes,
        resources: RESOURCE_ORDER.map((kind) => ({
          kind,
          instance_fingerprint: acceptedPreview.instance_fingerprints[kind],
        })),
      },
      actions,
      absent_preview_sha256: absentReadback.sha256,
      absence: { present: 0, absent: 3 },
    };
    assertDisposableRecoveryBrainTeardownReceipt(receipt, {
      role,
      expectedBinding: prepared.binding,
      expectedSourceTeardownReceiptSha256:
        acceptedPreview.source_teardown_receipt_sha256,
    });
    await revalidateEvidence();
    finalize(finalReservation, receipt, finalFinalizeOptions);
    return immutable({ receipt, absentReceipt });
  } catch (error) {
    abandonPrivateAggregateReceipt(absentReservation);
    abandonPrivateAggregateReceipt(finalReservation);
    throw error;
  }
}
