#!/usr/bin/env node
/**
 * Synthetic-only field proof for the accelerated lifecycle-update path.
 *
 * The gate has two explicit phases. `--prepare` performs read-only target
 * inspection and binds an exact packed candidate plus a clean live baseline to
 * an approval fingerprint. An operator then disables schedules and seeds the
 * dedicated target outside this process. `--execute` consumes the matching
 * aggregate seed receipt, re-reads the seeded state, invokes the installed
 * `brain update` wrapper exactly once, and proves the durable result directly.
 *
 * This file never provisions, deletes, retries an update, reads corpus text, or
 * accepts an ordinary/customer manifest. Raw provider responses, SQL results,
 * child output, credentials, target names, and canary strings remain in memory.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildFieldGates,
  FULL_FIELD_PREPARATION_STEPS,
} from "../../scripts/field-prepare.mjs";
import {
  buildNpmCliInvocation,
  resolveNpmCliPath,
} from "../../operations/npm-cli-runtime.mjs";

export const EXECUTION_CONFIRMATION = "accelerated-update-synthetic-v2";
export const SYNTHETIC_DISPLAY_NAME = "Synthetic Accelerated Update Field Gate";
export const BASELINE_SQL = "SELECT (SELECT count(*) FROM install_state) install_rows,client_slug,product_version,schema_version,vector_projection_status status,vector_projection_bootstrap_protocol protocol,vector_projection_bootstrap_epoch epoch,vector_projection_bootstrap_base_count base_count,vector_projection_residue_epoch residue_epoch,(vector_drain_lease_owner IS NOT NULL OR vector_drain_lease_expires_at IS NOT NULL) lease_present,(SELECT count(*) FROM documents) documents,(SELECT count(*) FROM chunks) chunks,(SELECT count(*) FROM vector_outbox) outbox,(SELECT count(*) FROM vector_bootstrap_batches) batches,(SELECT count(*) FROM vector_bootstrap_batches WHERE status<>'confirmed') unfinished_batches,(SELECT count(*) FROM vector_outbox_retry_state) retry_rows,(SELECT count(*) FROM vector_projection_events) event_count,(SELECT coalesce(max(id),0) FROM vector_projection_events) event_max_id,(SELECT count(*) FROM upgrade_runs WHERE status IN ('started','failed')) bad_upgrade_runs FROM install_state WHERE id=1";
export const RESIDUE_SHAPE_SQL = "SELECT count(*) total,coalesce(sum(CASE WHEN o.op='upsert' THEN 1 ELSE 0 END),0) upserts,coalesce(sum(CASE WHEN o.op='delete' THEN 1 ELSE 0 END),0) deletes,coalesce(sum(CASE WHEN o.submitted_mutation_id IS NOT NULL THEN 1 ELSE 0 END),0) submitted,coalesce(sum(CASE WHEN o.attempts>0 OR o.last_error IS NOT NULL THEN 1 ELSE 0 END),0) legacy_failed,coalesce(sum(CASE WHEN o.op='upsert' AND c.chunk_uid IS NOT NULL AND o.submitted_mutation_id IS NULL AND s.quarantined_at IS NULL THEN 1 ELSE 0 END),0) pageable,coalesce(sum(CASE WHEN s.quarantined_at IS NOT NULL THEN 1 ELSE 0 END),0) quarantined,coalesce(sum(CASE WHEN o.op='upsert' AND c.chunk_uid IS NULL THEN 1 ELSE 0 END),0) orphan_upserts FROM vector_outbox o LEFT JOIN chunks c ON c.chunk_uid=o.chunk_uid LEFT JOIN vector_outbox_retry_state s ON s.chunk_uid=o.chunk_uid AND s.generation=o.generation";
export const UPGRADE_SUMMARY_SQL = "SELECT count(*) total,coalesce(max(id),0) max_id FROM upgrade_runs";
export const MIGRATION_LEDGER_SQL = "SELECT version,name,checksum FROM schema_migrations ORDER BY version";
const GATE = "accelerated_lifecycle_update_synthetic_v2";
const PLAN_STATUS = "ready_for_external_synthetic_seed";
const SEED_STATUS = "synthetic_seed_completed";
const PLAN_NEXT = "Externally seed the exact synthetic aggregate contract while schedules remain disabled. Then execute only with this exact plan fingerprint.";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SHA1_PATTERN = /^[a-f0-9]{40}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const ACCOUNT_PATTERN = /^[a-f0-9]{32}$/;
const D1_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SLUG_PATTERN = /^synthetic-accelerated-update-([a-z0-9]{6,12})$/;
const PROFILE_PATTERN = /^financial-brain-[a-f0-9]{24}$/;
const WORKER_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{1,127}$/;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 128 * 1024 * 1024;
const REQUIRED_SYNTHETIC_SECRET_NAMES = Object.freeze([
  "ADMIN_KEY", "RAG_PROXY_KEY", "SESSION_SIGNING_KEY",
]);
const REQUIRED_SYNTHETIC_NON_SECRET_NAMES = Object.freeze([
  "AI", "ANSWER_MODEL", "BRAIN_NAME", "BRAIN_OWNER", "BRAIN_VERSION",
  "CHUNK_OVERLAP", "CHUNK_SIZE", "CREDENTIAL_SCANNER", "DAILY_LLM_CAP_USD",
  "DB", "OCR_ENABLED", "OCR_MODEL", "STORAGE", "VECTORIZE",
]);
const COMMON_VALUE_FLAGS = Object.freeze([
  "--manifest", "--package", "--field-receipt", "--target-account",
  "--target-worker", "--target-d1", "--target-vector-index", "--target-domain",
  "--cleanup-owner", "--plan-receipt", "--seed-receipt", "--receipt",
]);
const EXECUTE_VALUE_FLAGS = Object.freeze(["--confirm", "--approve-plan"]);
const VALUE_FLAGS = new Set([...COMMON_VALUE_FLAGS, ...EXECUTE_VALUE_FLAGS]);
const BOOLEAN_FLAGS = new Set(["--help", "--plan", "--prepare", "--execute"]);

function refusal(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function safeFailureCode(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  return /^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(code)
    ? code.toLowerCase().replaceAll("-", "_")
    : "accelerated_update_field_gate_failed";
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprint(value) {
  return sha256(canonical(value));
}

function assertPlainObject(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) refusal(code);
  return value;
}

function assertExactKeys(value, keys, code) {
  const actual = Object.keys(assertPlainObject(value, code)).sort();
  const expected = [...keys].sort();
  if (canonical(actual) !== canonical(expected)) refusal(code);
}

function integer(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) refusal(code);
  return number;
}

function sameFile(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino &&
    left?.size === right?.size && left?.mtimeMs === right?.mtimeMs;
}

function sameSingleFileIdentity(left, right) {
  return left?.isFile?.() === true && right?.isFile?.() === true &&
    left.nlink === 1 && right.nlink === 1 && sameFile(left, right);
}

function sameStableSingleFile(left, right) {
  return sameSingleFileIdentity(left, right) && left.ctimeMs === right.ctimeMs;
}

function sameInode(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function assertPrivateDirectory(path, code = "private_directory_required") {
  const absolute = resolve(path);
  let info;
  try { info = lstatSync(absolute); } catch { refusal(code); }
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(absolute) !== absolute ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0) ||
      (typeof process.getuid === "function" && info.uid !== process.getuid())) refusal(code);
  return Object.freeze({ path: absolute, info });
}

function assertPrivateOutputPath(path, code) {
  if (!isAbsolute(path)) refusal("absolute_path_required");
  const parent = assertPrivateDirectory(dirname(resolve(path)), code);
  try {
    lstatSync(path);
    refusal("output_already_exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return Object.freeze({ path: resolve(path), parent });
}

function readStablePrivateFile(path, { code, maxBytes = MAX_JSON_BYTES } = {}) {
  if (!isAbsolute(path)) refusal("absolute_path_required");
  const absolute = resolve(path);
  let before;
  try { before = lstatSync(absolute); } catch { refusal(code); }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      realpathSync(absolute) !== absolute || before.size < 1 || before.size > maxBytes ||
      (process.platform !== "win32" && (before.mode & 0o077) !== 0) ||
      (typeof process.getuid === "function" && before.uid !== process.getuid())) refusal(code);
  let descriptor;
  let raw;
  try {
    descriptor = openSync(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameFile(before, opened)) refusal(`${code}_changed`);
    raw = readFileSync(descriptor);
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(absolute);
    if (!sameFile(opened, afterDescriptor) || !sameFile(opened, afterPath) ||
        raw.length !== opened.size) refusal(`${code}_changed`);
    return Object.freeze({ path: absolute, info: opened, raw, hash: sha256(raw) });
  } catch (error) {
    if (raw) raw.fill(0);
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseStablePrivateJson(path, code) {
  const loaded = readStablePrivateFile(path, { code });
  try {
    const value = JSON.parse(loaded.raw.toString("utf8"));
    return Object.freeze({ ...loaded, value });
  } catch {
    refusal(`${code}_invalid_json`);
  } finally {
    loaded.raw.fill(0);
  }
}

function assertFilePin(pin, code) {
  let descriptor;
  let bytes;
  try {
    const current = lstatSync(pin.path);
    if (!sameFile(pin.info, current) || current.isSymbolicLink() || current.nlink !== 1) refusal(code);
    descriptor = openSync(pin.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameFile(pin.info, opened)) refusal(code);
    bytes = readFileSync(descriptor);
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(pin.path);
    if (!sameFile(opened, afterDescriptor) || !sameFile(opened, afterPath) ||
        bytes.length !== opened.size || sha256(bytes) !== pin.hash) refusal(code);
  } finally {
    if (bytes) bytes.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return true;
}

export function parseAcceleratedUpdateArgs(argv) {
  const values = new Map();
  const booleans = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (BOOLEAN_FLAGS.has(flag)) {
      if (booleans.has(flag)) refusal("duplicate_option");
      booleans.add(flag);
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) refusal("unknown_or_positional_option");
    if (values.has(flag)) refusal("duplicate_option");
    const value = argv[index + 1];
    if (typeof value !== "string" || !value || value.startsWith("--")) refusal("option_value_required");
    values.set(flag, value);
    index += 1;
  }
  if (booleans.has("--help") || booleans.has("--plan")) {
    if (argv.length !== 1) refusal("inert_mode_must_be_used_alone");
    return Object.freeze({ mode: booleans.has("--help") ? "help" : "plan" });
  }
  if (booleans.size !== 1 || (!booleans.has("--prepare") && !booleans.has("--execute"))) {
    refusal("exact_phase_required");
  }
  const mode = booleans.has("--prepare") ? "prepare" : "execute";
  for (const flag of COMMON_VALUE_FLAGS) if (!values.has(flag)) refusal("phase_option_required");
  if (mode === "prepare" && EXECUTE_VALUE_FLAGS.some((flag) => values.has(flag))) {
    refusal("execution_approval_refused_during_prepare");
  }
  if (mode === "execute") {
    for (const flag of EXECUTE_VALUE_FLAGS) if (!values.has(flag)) refusal("execution_option_required");
    if (values.get("--confirm") !== EXECUTION_CONFIRMATION) refusal("exact_synthetic_confirmation_required");
    if (!SHA256_PATTERN.test(values.get("--approve-plan"))) refusal("plan_approval_invalid");
  }
  for (const flag of [
    "--manifest", "--package", "--field-receipt", "--plan-receipt",
    "--seed-receipt", "--receipt",
  ]) {
    if (!isAbsolute(values.get(flag))) refusal("absolute_path_required");
  }
  if (!ACCOUNT_PATTERN.test(values.get("--target-account"))) refusal("target_account_invalid");
  if (!D1_ID_PATTERN.test(values.get("--target-d1"))) refusal("target_d1_invalid");
  if (!/^[a-z][a-z0-9-]{5,62}$/.test(values.get("--target-worker")) ||
      !/^[a-z][a-z0-9-]{5,62}$/.test(values.get("--target-vector-index"))) {
    refusal("target_name_invalid");
  }
  if (!/^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(values.get("--target-domain"))) {
    refusal("target_domain_invalid");
  }
  const cleanupOwner = values.get("--cleanup-owner");
  if (cleanupOwner !== cleanupOwner.trim() || !/^[A-Za-z][A-Za-z0-9 ._-]{1,63}$/.test(cleanupOwner)) {
    refusal("cleanup_owner_invalid");
  }
  return Object.freeze({
    mode,
    manifestPath: resolve(values.get("--manifest")),
    packagePath: resolve(values.get("--package")),
    fieldReceiptPath: resolve(values.get("--field-receipt")),
    targetAccount: values.get("--target-account"),
    targetWorker: values.get("--target-worker"),
    targetD1: values.get("--target-d1"),
    targetVectorIndex: values.get("--target-vector-index"),
    targetDomain: values.get("--target-domain"),
    cleanupOwner,
    planReceiptPath: resolve(values.get("--plan-receipt")),
    seedReceiptPath: resolve(values.get("--seed-receipt")),
    receiptPath: resolve(values.get("--receipt")),
    approvePlan: values.get("--approve-plan") || null,
  });
}

export function acceleratedUpdatePlan() {
  return Object.freeze({
    schema_version: 2,
    gate: GATE,
    mode: "plan_only",
    phases: Object.freeze(["read_only_prepare", "externally_supervised_seed", "single_update_execute"]),
    command_entrypoint: "installed brain update",
    mutates_provisioned_target: true,
    creates_resources: false,
    deletes_resources: false,
    retries_update: false,
    reads_manifest: false,
    reads_credential_store: false,
    writes_receipt: false,
    allowed_data: "fictional_synthetic_only",
    execution_requires: Object.freeze([
      "exact full field-prepare tarball and aggregate receipt",
      "dedicated externally provisioned Worker, D1 database, Vectorize index, and workers.dev hostname",
      "zero routes, zero custom domains, and zero schedules during deterministic seed",
      "candidate-derived threshold-plus-one one-chunk synthetic documents with aggregate seed receipt",
      "approval equal to the exact bound plan fingerprint",
      "named cleanup owner and supervised cleanup after proof",
    ]),
    durable_proof: Object.freeze([
      "exactly one residue-reprojection event and exact page ledger",
      "installed migration checksum parity and exactly one verified upgrade run",
      "D1 and Vectorize count parity before seed, after update, and after canary",
      "active candidate health, restored declared cron, and synthetic write-drain-retrieval canary",
    ]),
    allowed_mutations: Object.freeze({
      externally_supervised_seed: "candidate-derived trigger count",
      installed_brain_update_invocations: 1,
      post_update_canary_ingest_calls: 1,
      post_update_canary_drain_max_calls: 12,
      post_update_canary_retrieval_calls: 1,
    }),
    forbidden_mutations: Object.freeze([
      "resource provisioning or deletion",
      "direct residue bootstrap or residue drain",
      "automatic brain update retry",
    ]),
  });
}

export function createLifecycleEnvironment(source = process.env, privateRoot) {
  if (!privateRoot || !isAbsolute(privateRoot)) refusal("private_runtime_root_required");
  const allowed = [
    "PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "SystemDrive",
    "ComSpec", "COMSPEC", "PATHEXT", "LANG", "LANGUAGE", "LC_ALL", "SHELL", "TERM",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  ];
  const environment = {};
  for (const name of allowed) {
    if (typeof source?.[name] === "string" && source[name]) environment[name] = source[name];
  }
  for (const [name, value] of Object.entries(source || {})) {
    if (name.startsWith("LC_") && typeof value === "string" && value) environment[name] = value;
  }
  const home = join(privateRoot, "home");
  return Object.freeze({
    ...environment,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(privateRoot, "appdata", "roaming"),
    LOCALAPPDATA: join(privateRoot, "appdata", "local"),
    XDG_CONFIG_HOME: join(privateRoot, "xdg", "config"),
    XDG_DATA_HOME: join(privateRoot, "xdg", "data"),
    XDG_STATE_HOME: join(privateRoot, "xdg", "state"),
    XDG_CACHE_HOME: join(privateRoot, "xdg", "cache"),
    CODEX_HOME: join(privateRoot, "codex"),
    CLAUDE_CONFIG_DIR: join(privateRoot, "claude"),
    TMPDIR: join(privateRoot, "tmp"),
    TMP: join(privateRoot, "tmp"),
    TEMP: join(privateRoot, "tmp"),
    NPM_CONFIG_CACHE: join(privateRoot, "npm", "cache"),
    NPM_CONFIG_USERCONFIG: join(privateRoot, "npm", "userconfig"),
    NPM_CONFIG_GLOBALCONFIG: join(privateRoot, "npm", "globalconfig"),
    NPM_CONFIG_PREFIX: join(privateRoot, "npm", "prefix"),
    GIT_CONFIG_GLOBAL: join(privateRoot, "git", "config"),
    GIT_CONFIG_NOSYSTEM: "1",
    BRAIN_NO_WRANGLER_LOGIN: "1",
    NO_COLOR: "1",
    DO_NOT_TRACK: "1",
    WRANGLER_SEND_METRICS: "false",
    BRAIN_ACCELERATED_UPDATE_FIELD_GATE: "1",
  });
}

function makeRuntimeDirectories(environment) {
  const directories = new Set([
    environment.HOME, environment.APPDATA, environment.LOCALAPPDATA,
    environment.XDG_CONFIG_HOME, environment.XDG_DATA_HOME, environment.XDG_STATE_HOME,
    environment.XDG_CACHE_HOME, environment.CODEX_HOME, environment.CLAUDE_CONFIG_DIR,
    environment.TMPDIR, environment.NPM_CONFIG_CACHE, environment.NPM_CONFIG_PREFIX,
    dirname(environment.NPM_CONFIG_USERCONFIG), dirname(environment.NPM_CONFIG_GLOBALCONFIG),
    dirname(environment.GIT_CONFIG_GLOBAL),
  ]);
  for (const path of directories) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(path, 0o700);
  }
  for (const path of [environment.NPM_CONFIG_USERCONFIG, environment.NPM_CONFIG_GLOBALCONFIG, environment.GIT_CONFIG_GLOBAL]) {
    const descriptor = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    closeSync(descriptor);
  }
}

function validateFieldReceipt(receipt, packagePath, packagePin) {
  assertPlainObject(receipt, "field_prepare_receipt_invalid");
  assertExactKeys(receipt, [
    "schema_version", "run_id", "generated_at", "completed_at", "status", "profile",
    "scope", "proof_level", "ready_for_live_accounts", "live_field_gates_run",
    "customer_data_read", "customer_manifests_read", "credential_stores_read",
    "live_accounts_contacted", "external_network_allowed", "tooling", "source",
    "package", "steps", "human_field_gates",
  ], "field_prepare_receipt_invalid");
  const generatedAt = new Date(receipt.generated_at);
  const completedAt = new Date(receipt.completed_at);
  if (receipt.schema_version !== 1 || receipt.status !== "source_preparation_passed" ||
      receipt.profile !== "full" || receipt.scope !== "source_preparation_only" ||
      receipt.proof_level !== "offline_synthetic_only" || receipt.ready_for_live_accounts !== false ||
      receipt.live_field_gates_run !== false || receipt.customer_data_read !== false ||
      receipt.customer_manifests_read !== false || receipt.credential_stores_read !== false ||
      receipt.live_accounts_contacted !== false || receipt.external_network_allowed !== false ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(String(receipt.run_id || "")) ||
      typeof receipt.generated_at !== "string" || !Number.isFinite(generatedAt.getTime()) ||
      generatedAt.toISOString() !== receipt.generated_at || typeof receipt.completed_at !== "string" ||
      !Number.isFinite(completedAt.getTime()) || completedAt.toISOString() !== receipt.completed_at ||
      completedAt.getTime() < generatedAt.getTime()) refusal("field_prepare_receipt_incomplete");
  assertExactKeys(receipt.tooling, ["wrangler_package", "wrangler_resolution"], "field_prepare_receipt_invalid");
  if (!/^wrangler@\d+\.\d+\.\d+$/.test(String(receipt.tooling.wrangler_package || "")) ||
      receipt.tooling.wrangler_resolution !== "locked_local_dev_dependency") {
    refusal("field_prepare_receipt_incomplete");
  }
  if (!Array.isArray(receipt.steps) || receipt.steps.length !== FULL_FIELD_PREPARATION_STEPS.length) {
    refusal("field_prepare_receipt_incomplete");
  }
  for (let index = 0; index < FULL_FIELD_PREPARATION_STEPS.length; index += 1) {
    const step = receipt.steps[index];
    const expected = FULL_FIELD_PREPARATION_STEPS[index];
    assertExactKeys(step, [
      "id", "title", "status", "proof", "duration_ms", "exit_code", "failure_code",
      "network_scope",
    ], "field_prepare_receipt_invalid");
    if (step.id !== expected.id || step.title !== expected.title || step.proof !== expected.proof ||
        step.network_scope !== expected.network_scope || step.status !== "passed" ||
        !Number.isSafeInteger(step.duration_ms) || step.duration_ms < 0 ||
        step.exit_code !== null || step.failure_code !== null) refusal("field_prepare_receipt_incomplete");
  }
  const expectedHumanGates = buildFieldGates().map(({ id }) => id);
  if (!Array.isArray(receipt.human_field_gates) ||
      receipt.human_field_gates.length !== expectedHumanGates.length) {
    refusal("field_prepare_receipt_incomplete");
  }
  for (let index = 0; index < expectedHumanGates.length; index += 1) {
    const gate = receipt.human_field_gates[index];
    assertExactKeys(gate, ["id", "status"], "field_prepare_receipt_invalid");
    if (gate.id !== expectedHumanGates[index] || gate.status !== "pending_human_proof") {
      refusal("field_prepare_receipt_incomplete");
    }
  }
  const source = assertPlainObject(receipt.source, "field_prepare_source_invalid");
  const artifact = assertPlainObject(receipt.package, "field_prepare_package_invalid");
  assertExactKeys(source, [
    "head_sha", "tree_sha", "package_name", "package_version", "package_alignment",
    "package_json_sha256", "package_lock_sha256", "working_tree_clean",
    "shallow_repository", "diff_check_clean", "identity_stable_during_check", "end_clean",
  ], "field_prepare_source_invalid");
  assertExactKeys(source.package_alignment, [
    "aligned", "package_lock_name", "package_lock_version", "package_lock_root_name",
    "package_lock_root_version",
  ], "field_prepare_source_invalid");
  assertExactKeys(artifact, ["filename", "bytes", "sha256", "file_count"], "field_prepare_package_invalid");
  if (!SHA1_PATTERN.test(String(source.head_sha || "")) || !SHA1_PATTERN.test(String(source.tree_sha || "")) ||
      source.package_name !== "brain-installer" || !VERSION_PATTERN.test(String(source.package_version || "")) ||
      source.package_alignment?.aligned !== true ||
      source.package_alignment.package_lock_name !== source.package_name ||
      source.package_alignment.package_lock_version !== source.package_version ||
      source.package_alignment.package_lock_root_name !== source.package_name ||
      source.package_alignment.package_lock_root_version !== source.package_version ||
      source.working_tree_clean !== true ||
      source.shallow_repository !== false || source.diff_check_clean !== true ||
      source.identity_stable_during_check !== true || source.end_clean !== true ||
      !SHA256_PATTERN.test(String(source.package_json_sha256 || "")) ||
      !SHA256_PATTERN.test(String(source.package_lock_sha256 || ""))) refusal("field_prepare_source_invalid");
  const expectedFilename = `${source.package_name}-${source.package_version}.tgz`;
  if (artifact.filename !== expectedFilename || basename(packagePath) !== expectedFilename ||
      resolve(dirname(packagePath), artifact.filename) !== packagePath ||
      integer(artifact.bytes, "field_prepare_package_invalid") !== packagePin.info.size ||
      artifact.sha256 !== packagePin.hash || !SHA256_PATTERN.test(artifact.sha256) ||
      integer(artifact.file_count, "field_prepare_package_invalid") < 1) refusal("field_prepare_package_invalid");
  return Object.freeze({
    commit: source.head_sha,
    tree: source.tree_sha,
    name: source.package_name,
    version: source.package_version,
    packageJsonSha256: source.package_json_sha256,
    packageLockSha256: source.package_lock_sha256,
    archiveSha256: artifact.sha256,
    archiveBytes: artifact.bytes,
    fileCount: artifact.file_count,
  });
}

export function inspectFieldPreparation(packagePath, receiptPath) {
  const packageParent = assertPrivateDirectory(dirname(resolve(packagePath)), "field_prepare_directory_refused");
  const receiptParent = assertPrivateDirectory(dirname(resolve(receiptPath)), "field_prepare_directory_refused");
  if (packageParent.path !== receiptParent.path) refusal("field_prepare_artifacts_must_share_directory");
  const packagePin = readStablePrivateFile(packagePath, { code: "candidate_archive_refused", maxBytes: MAX_PACKAGE_BYTES });
  packagePin.raw.fill(0);
  const receiptPin = parseStablePrivateJson(receiptPath, "field_prepare_receipt_refused");
  const candidate = validateFieldReceipt(receiptPin.value, packagePin.path, packagePin);
  return Object.freeze({ candidate, packagePin, receiptPin, directory: packageParent });
}

function childSucceeded(result) {
  return result?.status === 0 && !result?.signal && !result?.error;
}

export function readInstalledContract(packageRoot, read = readFileSync, list = readdirSync) {
  const migrationDirectory = join(packageRoot, "migrations", "d1");
  const files = list(migrationDirectory).filter((name) => String(name).endsWith(".sql")).sort();
  if (!files.length) refusal("installed_migration_set_empty");
  const migrations = files.map((name, index) => {
    const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(String(name));
    if (!match) refusal("installed_migration_filename_refused");
    const version = Number(match[1]);
    if (version !== index + 1) refusal("installed_migration_sequence_not_contiguous");
    const sql = String(read(join(migrationDirectory, name), "utf8"));
    return Object.freeze({ version, name: name.slice(0, -4), checksum: sha256(sql).slice(0, 16) });
  });
  const store = String(read(join(packageRoot, "worker", "src", "lib", "store-d1.js"), "utf8"));
  const worker = String(read(join(packageRoot, "worker", "src", "index.js"), "utf8"));
  const exactNumber = (pattern, code, source = store) => {
    const match = pattern.exec(source);
    const number = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(number) || number < 1) refusal(code);
    return number;
  };
  const drainBatch = exactNumber(/const\s+DRAIN_BATCH_SIZE_MAX\s*=\s*(\d+)\s*;/, "installed_drain_batch_unrecognized");
  const multiplier = exactNumber(/export\s+const\s+RESIDUE_REPROJECTION_MIN_ROWS\s*=\s*(\d+)\s*\*\s*DRAIN_BATCH_SIZE_MAX\s*;/, "installed_residue_threshold_unrecognized");
  const residueSchema = exactNumber(/export\s+const\s+RESIDUE_REPROJECTION_SCHEMA\s*=\s*(\d+)\s*;/, "installed_residue_schema_unrecognized");
  const pageSize = exactNumber(/export\s+const\s+ACCELERATED_BOOTSTRAP_PAGE_SIZE\s*=\s*(\d+)\s*;/, "installed_bootstrap_page_unrecognized");
  const window = exactNumber(/export\s+const\s+ACCELERATED_BOOTSTRAP_WINDOW\s*=\s*(\d+)\s*;/, "installed_bootstrap_window_unrecognized");
  const ingestBatchMax = exactNumber(/const\s+BATCH_MAX_DOCS\s*=\s*(\d+)\s*;/, "installed_ingest_batch_unrecognized", worker);
  const triggerRows = drainBatch * multiplier + 1;
  if (!migrations.some((entry) => entry.version === residueSchema && entry.name.endsWith("_vector_projection_events")) ||
      triggerRows !== pageSize + 1 || window < 2 || ingestBatchMax > 50) refusal("installed_accelerated_contract_incompatible");
  return Object.freeze({
    migrations: Object.freeze(migrations), terminalSchema: migrations.at(-1).version,
    residueSchema, drainBatch, triggerRows, pageSize, window, ingestBatchMax,
    seedCalls: Math.ceil(triggerRows / ingestBatchMax),
  });
}

export function assertAcceleratedFieldRuntimeSupported(platform = process.platform) {
  if (platform === "win32") refusal("accelerated_field_runtime_windows_not_reviewed");
  return true;
}

export function installCandidateArtifact(field, source = process.env, options = {}) {
  assertAcceleratedFieldRuntimeSupported();
  const spawn = options.spawn || spawnSync;
  const created = mkdtempSync(join(options.temporaryRoot || tmpdir(), "brain-accelerated-update-field-"));
  const runtimeRoot = realpathSync(created);
  if (process.platform !== "win32") chmodSync(runtimeRoot, 0o700);
  const runtimeInfo = lstatSync(runtimeRoot);
  const environment = createLifecycleEnvironment(source, runtimeRoot);
  makeRuntimeDirectories(environment);
  const prefix = join(runtimeRoot, "prefix");
  mkdirSync(prefix, { mode: 0o700 });
  let complete = false;
  try {
    assertFilePin(field.packagePin, "candidate_archive_changed");
    assertFilePin(field.receiptPin, "field_prepare_receipt_changed");
    const npmCli = resolveNpmCliPath({
      environment: source,
      nodeExecutable: process.execPath,
      platform: process.platform,
    });
    const npmInvocation = buildNpmCliInvocation(npmCli, [
      "install", "--global", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
      "--prefix", prefix, field.packagePin.path,
    ]);
    const result = spawn(npmInvocation.command, npmInvocation.args, {
      cwd: runtimeRoot, encoding: null,
      env: { ...environment, NPM_CONFIG_OFFLINE: "true", NO_UPDATE_NOTIFIER: "1" },
      input: Buffer.alloc(0), shell: npmInvocation.shell,
      timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024,
    });
    try {
      if (!childSucceeded(result)) refusal("candidate_prefix_install_failed");
    } finally {
      if (Buffer.isBuffer(result?.stdout)) result.stdout.fill(0);
      if (Buffer.isBuffer(result?.stderr)) result.stderr.fill(0);
    }
    assertFilePin(field.packagePin, "candidate_archive_changed");
    assertFilePin(field.receiptPin, "field_prepare_receipt_changed");
    const packageRoot = realpathSync(join(prefix, "lib", "node_modules", field.candidate.name));
    const cliPath = join(prefix, "bin", "brain");
    const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    if (packageJson.name !== field.candidate.name || packageJson.version !== field.candidate.version ||
        realpathSync(cliPath) !== join(packageRoot, "brain.mjs")) refusal("installed_candidate_identity_mismatch");
    const cliInfo = statSync(cliPath);
    if (!cliInfo.isFile() ||
        (process.platform !== "win32" && (cliInfo.mode & 0o100) === 0)) {
      refusal("installed_candidate_cli_refused");
    }
    const version = spawn(cliPath, ["--version"], {
      cwd: runtimeRoot, encoding: null, env: environment, input: Buffer.alloc(0), shell: false,
      timeout: 60_000, maxBuffer: 64 * 1024,
    });
    try {
      if (!childSucceeded(version) || String(version.stdout || "").trim() !== field.candidate.version ||
          String(version.stderr || "").trim()) refusal("installed_candidate_version_mismatch");
    } finally {
      if (Buffer.isBuffer(version?.stdout)) version.stdout.fill(0);
      if (Buffer.isBuffer(version?.stderr)) version.stderr.fill(0);
    }
    const contract = readInstalledContract(packageRoot);
    complete = true;
    return Object.freeze({ runtimeRoot, runtimeInfo, environment, prefix, packageRoot, cliPath, candidate: field.candidate, contract });
  } finally {
    if (!complete) rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

export function removeCandidateRuntime(runtime) {
  const path = runtime?.runtimeRoot;
  const expected = runtime?.runtimeInfo;
  if (!path || !expected || !/^brain-accelerated-update-field-/.test(basename(path))) refusal("private_runtime_cleanup_refused");
  const current = lstatSync(path);
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino) {
    refusal("private_runtime_cleanup_refused");
  }
  rmSync(path, { recursive: true, force: false });
}

export async function deriveInstalledAuthProfile(runtime, manifestPath, dependencies = {}) {
  if (!runtime?.packageRoot || !runtime?.cliPath || !isAbsolute(manifestPath)) {
    refusal("installed_oauth_profile_derivation_invalid");
  }
  const cli = dependencies.cliModule || await import(pathToFileURL(runtime.cliPath).href);
  const oauth = dependencies.oauthModule || await import(pathToFileURL(
    join(runtime.packageRoot, "operations", "cloudflare-oauth-session.mjs"),
  ).href);
  if (typeof cli.cloudflareOAuthInstallIdentity !== "function" ||
      typeof oauth.cloudflareOAuthProfileName !== "function") {
    refusal("installed_oauth_profile_derivation_invalid");
  }
  const expected = oauth.cloudflareOAuthProfileName(
    cli.cloudflareOAuthInstallIdentity(manifestPath),
  );
  if (!PROFILE_PATTERN.test(String(expected || ""))) {
    refusal("installed_oauth_profile_derivation_invalid");
  }
  return expected;
}

function compareVersions(left, right) {
  if (!VERSION_PATTERN.test(String(left)) || !VERSION_PATTERN.test(String(right))) {
    refusal("candidate_or_target_version_invalid");
  }
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function decodeLocatorPart(value) {
  try { return decodeURIComponent(value); } catch { refusal("admin_credential_locator_invalid"); }
}

export function validateSyntheticProvisionedManifest(manifest, targets, candidateVersion) {
  assertExactKeys(manifest, [
    "$schema", "manifest_version", "client", "brain", "infrastructure",
    "corpora", "operations", "field_gate",
  ], "manifest_contains_non_gate_sections");
  if (manifest.$schema !== "manifest.schema.json" || manifest.manifest_version !== 1) {
    refusal("manifest_identity_refused");
  }
  const marker = manifest.field_gate;
  assertExactKeys(marker, [
    "schema_version", "purpose", "data_class", "target_management",
    "dedicated_resources", "cleanup_required",
  ], "synthetic_field_gate_marker_invalid");
  if (marker.schema_version !== 2 || marker.purpose !== "accelerated_lifecycle_update" ||
      marker.data_class !== "fictional_synthetic_only" ||
      marker.target_management !== "externally_provisioned_operator_managed" ||
      marker.dedicated_resources !== true || marker.cleanup_required !== true) {
    refusal("synthetic_field_gate_marker_invalid");
  }

  const client = manifest.client;
  assertExactKeys(client, ["slug", "display_name", "timezone"], "synthetic_client_fields_refused");
  const slugMatch = SLUG_PATTERN.exec(String(client.slug || ""));
  if (!slugMatch || client.display_name !== SYNTHETIC_DISPLAY_NAME || client.timezone !== "UTC") {
    refusal("synthetic_client_required");
  }
  const expectedWorker = `${client.slug}-brain`;
  const brain = manifest.brain;
  assertExactKeys(brain, ["version", "domain", "worker_name"], "synthetic_brain_fields_refused");
  if (!VERSION_PATTERN.test(String(brain.version || "")) || compareVersions(brain.version, candidateVersion) >= 0) {
    refusal("target_must_start_on_older_version");
  }
  if (brain.worker_name !== expectedWorker || targets.targetWorker !== expectedWorker ||
      targets.targetDomain !== brain.domain) refusal("explicit_worker_target_mismatch");
  const domainLabels = String(brain.domain || "").split(".");
  if (domainLabels.length !== 4 || domainLabels[0] !== expectedWorker ||
      domainLabels.slice(-2).join(".") !== "workers.dev" || !/^[a-z0-9-]+$/.test(domainLabels[1])) {
    refusal("dedicated_workers_dev_domain_required");
  }

  assertExactKeys(manifest.infrastructure, ["cloudflare"], "non_d1_infrastructure_refused");
  const cloudflare = manifest.infrastructure.cloudflare;
  const allowedCloudflare = [
    "account_id", "auth_profile", "storage", "d1_database_name", "d1_database_id",
    "vectorize_index", "drain_cron",
  ];
  assertExactKeys(cloudflare, allowedCloudflare, "cloudflare_target_fields_refused");
  if (!ACCOUNT_PATTERN.test(String(cloudflare.account_id || "")) ||
      cloudflare.account_id !== targets.targetAccount) refusal("explicit_account_target_mismatch");
  if (!PROFILE_PATTERN.test(String(cloudflare.auth_profile || ""))) refusal("named_cloudflare_profile_required");
  if (cloudflare.storage !== "d1" || cloudflare.d1_database_name !== expectedWorker) refusal("d1_storage_required");
  if (!D1_ID_PATTERN.test(String(cloudflare.d1_database_id || "")) ||
      cloudflare.d1_database_id !== targets.targetD1) refusal("explicit_d1_target_mismatch");
  if (cloudflare.vectorize_index !== expectedWorker ||
      cloudflare.vectorize_index !== targets.targetVectorIndex) refusal("explicit_vector_target_mismatch");
  if (cloudflare.drain_cron !== "* * * * *") refusal("standard_drain_cron_required");

  assertExactKeys(manifest.corpora, [], "connectors_and_corpus_configuration_refused");
  assertExactKeys(manifest.operations, ["admin_key_secret"], "non_gate_operations_refused");
  const locator = String(manifest.operations.admin_key_secret || "");
  const locatorMatch = /^keychain:\/\/([^/]+)\/([^/]+)$/.exec(locator);
  if (!locatorMatch) refusal("dedicated_keychain_admin_locator_required");
  const service = decodeLocatorPart(locatorMatch[1]);
  const account = decodeLocatorPart(locatorMatch[2]);
  if (service !== `${client.slug}-brain-admin` ||
      !/^owner-[a-z0-9][a-z0-9_-]{2,63}$/.test(account)) refusal("non_synthetic_admin_locator_refused");
  return Object.freeze({
    slug: client.slug,
    displayName: client.display_name,
    nonce: slugMatch[1],
    fromVersion: brain.version,
    toVersion: candidateVersion,
    accountId: cloudflare.account_id,
    authProfile: cloudflare.auth_profile,
    databaseName: cloudflare.d1_database_name,
    databaseId: cloudflare.d1_database_id,
    vectorIndex: cloudflare.vectorize_index,
    workerName: brain.worker_name,
    domain: brain.domain,
    cron: cloudflare.drain_cron,
    adminLocator: Object.freeze({ backend: "keychain", service, account }),
  });
}

export function assertNoAmbientProviderCredential(environment = process.env) {
  const forbidden = [
    "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_TOKEN", "CF_API_KEY",
    "WRANGLER_API_TOKEN", "WRANGLER_OAUTH_TOKEN",
  ];
  if (forbidden.some((name) => typeof environment?.[name] === "string" && environment[name])) {
    refusal("ambient_cloudflare_credential_refused");
  }
  return true;
}

function encodedSegment(value) {
  return encodeURIComponent(String(value));
}

async function boundedResponseJson(response, code) {
  if (!response || typeof response.status !== "number" || typeof response.arrayBuffer !== "function") refusal(code);
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) refusal(code);
  const raw = Buffer.from(await response.arrayBuffer());
  try {
    if (raw.length < 1 || raw.length > MAX_JSON_BYTES) refusal(code);
    return JSON.parse(raw.toString("utf8"));
  } catch (error) {
    if (error?.code) throw error;
    refusal(code);
  } finally {
    raw.fill(0);
  }
}

async function exactFetch(fetchImpl, url, options, code) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(options?.timeoutMs || 180_000),
    });
  } catch {
    refusal(code);
  }
  if (response.redirected === true || (response.status >= 300 && response.status < 400)) refusal(code);
  return response;
}

function cloudflareResult(body, status, code) {
  if (status < 200 || status >= 300 || !body || body.success !== true ||
      !Array.isArray(body.errors) || body.errors.length !== 0 || !Object.hasOwn(body, "result")) refusal(code);
  return body.result;
}

function normalizeD1Rows(body, status) {
  const result = cloudflareResult(body, status, "cloudflare_d1_query_refused");
  if (!Array.isArray(result) || result.length !== 1 || result[0]?.success === false ||
      !Array.isArray(result[0]?.results)) refusal("cloudflare_d1_query_refused");
  return result[0].results;
}

function normalizeVectorInfo(result) {
  assertPlainObject(result, "cloudflare_vector_info_refused");
  const vectorCount = integer(result.vector_count ?? result.vectorCount ?? result.vectors_count, "cloudflare_vector_info_refused");
  const dimensions = integer(result.config?.dimensions ?? result.dimensions, "cloudflare_vector_info_refused");
  const metric = String(result.config?.metric ?? result.metric ?? "").toLowerCase();
  const name = String(result.name ?? result.index_name ?? "");
  if (!name || !["cosine"].includes(metric)) refusal("cloudflare_vector_info_refused");
  return Object.freeze({ name, vectorCount, dimensions, metric });
}

function activeDeploymentVersion(result) {
  const deployments = Array.isArray(result) ? result : result?.deployments;
  if (!Array.isArray(deployments) || deployments.length < 1) refusal("cloudflare_worker_deployments_refused");
  const versions = deployments[0]?.versions;
  if (!Array.isArray(versions)) refusal("cloudflare_worker_deployments_refused");
  const active = versions.filter((entry) => Number(entry?.percentage) === 100);
  const id = active[0]?.version_id ?? active[0]?.id;
  if (active.length !== 1 || typeof id !== "string" || !/^[a-f0-9-]{16,64}$/i.test(id)) {
    refusal("cloudflare_worker_deployments_refused");
  }
  return id;
}

function normalizeSchedules(result) {
  const schedules = Array.isArray(result) ? result : result?.schedules;
  if (!Array.isArray(schedules)) refusal("cloudflare_worker_schedules_refused");
  return Object.freeze(schedules.map((entry) => {
    if (!entry || typeof entry.cron !== "string") refusal("cloudflare_worker_schedules_refused");
    return entry.cron;
  }).sort());
}

export function normalizeCompleteWorkerRecords(response, workerName, code, { requireResultInfo = false } = {}) {
  const result = response?.result;
  const rows = Array.isArray(result) ? result : result?.records;
  if (!Array.isArray(rows)) refusal(code);
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) refusal(code);
    const service = row.service ?? row.worker_name ?? row.script;
    if (service !== undefined && service !== workerName) refusal(code);
  }
  const page = response?.resultInfo;
  if (page !== null && page !== undefined) {
    assertPlainObject(page, code);
    for (const key of ["page", "count", "total_count", "total_pages"]) {
      if (!Number.isSafeInteger(page[key]) || page[key] < 0) refusal(code);
    }
    if (page.page !== 1 || page.count !== rows.length || page.total_count !== rows.length ||
        page.total_pages > 1 ||
        (page.total_pages === 0 && (rows.length !== 0 || page.total_count !== 0)) ||
        (page.total_pages === 1 && page.total_count === 0 && rows.length !== 0)) refusal(code);
  } else if (requireResultInfo || rows.length >= 100) {
    // Some Worker endpoints return an unpaginated array. A full requested page
    // without pagination metadata is ambiguous, so it cannot prove isolation.
    refusal(code);
  }
  return rows;
}

export function validateActiveWorkerBindings(version, binding, expectedVersion, activeVersionId) {
  assertPlainObject(version, "cloudflare_worker_version_refused");
  if (version.id !== activeVersionId || !WORKER_VERSION_PATTERN.test(String(version.id || ""))) {
    refusal("cloudflare_worker_version_refused");
  }
  const resources = assertPlainObject(version.resources, "cloudflare_worker_bindings_refused");
  const bindings = resources.bindings;
  if (!Array.isArray(bindings) || bindings.some((entry) =>
    !entry || typeof entry !== "object" || Array.isArray(entry))) {
    refusal("cloudflare_worker_bindings_refused");
  }
  const names = bindings.map((entry) => String(entry.name || ""));
  if (names.some((name) => !name) || new Set(names).size !== names.length) {
    refusal("cloudflare_worker_bindings_refused");
  }
  const nonSecretNames = bindings
    .filter((entry) => entry.type !== "secret_text")
    .map((entry) => entry.name)
    .sort();
  const secretNames = bindings
    .filter((entry) => entry.type === "secret_text")
    .map((entry) => entry.name)
    .sort();
  if (canonical(nonSecretNames) !== canonical([...REQUIRED_SYNTHETIC_NON_SECRET_NAMES].sort()) ||
      canonical(secretNames) !== canonical([...REQUIRED_SYNTHETIC_SECRET_NAMES].sort())) {
    refusal("cloudflare_worker_bindings_refused");
  }
  const exactlyOne = (predicate) => bindings.filter(predicate).length === 1;
  const d1Bindings = bindings.filter((entry) => entry.type === "d1" && entry.name === "DB");
  if (d1Bindings.length !== 1) refusal("cloudflare_worker_bindings_refused");
  const d1Binding = d1Bindings[0];
  const d1Aliases = ["id", "database_id"].filter((key) => Object.hasOwn(d1Binding, key));
  if (d1Aliases.length < 1 || d1Aliases.some((key) => d1Binding[key] !== binding.databaseId) ||
      !exactlyOne((entry) => entry.type === "vectorize" && entry.name === "VECTORIZE" &&
        entry.index_name === binding.vectorIndex) ||
      !exactlyOne((entry) => entry.type === "ai" && entry.name === "AI")) {
    refusal("cloudflare_worker_bindings_refused");
  }
  const expectedPlainText = new Map([
    ["STORAGE", "d1"],
    ["BRAIN_NAME", binding.slug],
    ["BRAIN_OWNER", binding.displayName],
    ["BRAIN_VERSION", expectedVersion],
    ["CHUNK_SIZE", "1500"],
    ["CHUNK_OVERLAP", "300"],
    ["DAILY_LLM_CAP_USD", "10"],
    ["ANSWER_MODEL", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"],
    ["CREDENTIAL_SCANNER", "on"],
    ["OCR_ENABLED", "0"],
    ["OCR_MODEL", "@cf/google/gemma-4-26b-a4b-it"],
  ]);
  for (const [name, text] of expectedPlainText) {
    if (!exactlyOne((entry) => entry.type === "plain_text" && entry.name === name && entry.text === text)) {
      refusal("cloudflare_worker_bindings_refused");
    }
  }
  return fingerprint({
    active_version_id: activeVersionId,
    database_id: binding.databaseId,
    vectorize_index: binding.vectorIndex,
    plain_text: Object.fromEntries(expectedPlainText),
    secret_names: [...REQUIRED_SYNTHETIC_SECRET_NAMES].sort(),
  });
}

export function validateAccountWorkersDevSubdomain(result, binding) {
  assertPlainObject(result, "cloudflare_account_subdomain_refused");
  const subdomain = String(result.subdomain || "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain) ||
      binding.domain !== `${binding.workerName}.${subdomain}.workers.dev`) {
    refusal("cloudflare_account_subdomain_refused");
  }
  return fingerprint({ account_id: binding.accountId, worker: binding.workerName, subdomain });
}

export function normalizeZoneRoutes(response, workerName, code = "cloudflare_zone_routes_refused") {
  const rows = response?.result;
  if (!Array.isArray(rows)) refusal(code);
  if (response.resultInfo !== null && response.resultInfo !== undefined) {
    const info = response.resultInfo;
    assertPlainObject(info, code);
    if (!["page", "count", "total_count", "total_pages"].every((key) =>
      Number.isSafeInteger(info[key]) && info[key] >= 0) ||
        info.page !== 1 || info.count !== rows.length || info.total_count !== rows.length ||
        ![0, 1].includes(info.total_pages)) refusal(code);
  }
  let matches = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row) ||
        typeof row.pattern !== "string" ||
        (row.script !== null && row.script !== undefined && typeof row.script !== "string")) refusal(code);
    if (row.script === workerName) matches += 1;
  }
  return matches;
}

export async function createInstalledCloudflareProvider(runtime, binding, {
  fetchImpl = globalThis.fetch,
  revalidate = () => true,
  oauthModule = null,
} = {}) {
  if (typeof fetchImpl !== "function") refusal("cloudflare_fetch_unavailable");
  const modulePath = join(runtime.packageRoot, "operations", "cloudflare-oauth-session.mjs");
  const oauth = oauthModule || await import(pathToFileURL(modulePath).href);
  if (typeof oauth.withCloudflareOAuthSession !== "function") refusal("installed_oauth_module_invalid");
  const account = encodedSegment(binding.accountId);
  const worker = encodedSegment(binding.workerName);
  const database = encodedSegment(binding.databaseId);
  const vector = encodedSegment(binding.vectorIndex);
  const allowedZoneIds = new Set();

  const cloudflare = async (path, { method = "GET", body } = {}) => {
    revalidate();
    const url = new URL(path, "https://api.cloudflare.com/client/v4/");
    const exactAccountPrefix = `/client/v4/accounts/${account}/`;
    const isAccountRequest = url.pathname.startsWith(exactAccountPrefix);
    const isZoneList = url.pathname === "/client/v4/zones" &&
      url.searchParams.get("account.id") === binding.accountId;
    const zoneRoute = /^\/client\/v4\/zones\/([a-f0-9]{32})\/workers\/routes$/.exec(url.pathname);
    const isApprovedZoneRoute = Boolean(zoneRoute && allowedZoneIds.has(zoneRoute[1]));
    if (url.origin !== "https://api.cloudflare.com" ||
        (!isAccountRequest && !isZoneList && !isApprovedZoneRoute)) {
      refusal("cloudflare_request_target_refused");
    }
    const response = await exactFetch(fetchImpl, url, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${providerToken.toString("ascii")}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, "cloudflare_request_failed");
    const parsed = await boundedResponseJson(response, "cloudflare_response_invalid");
    revalidate();
    return {
      result: cloudflareResult(parsed, response.status, "cloudflare_request_refused"),
      resultInfo: parsed.result_info ?? null,
      status: response.status,
    };
  };

  const pagedCollection = async (path, code) => {
    const rows = [];
    let expectedTotal = null;
    let expectedPages = null;
    for (let page = 1; page <= (expectedPages ?? 1); page += 1) {
      if (page > 100) refusal(code);
      const url = new URL(path, "https://api.cloudflare.com/client/v4/");
      url.searchParams.set("page", String(page));
      url.searchParams.set("per_page", "50");
      const requestPath = `${url.pathname.slice("/client/v4/".length)}${url.search}`;
      const response = await cloudflare(requestPath);
      if (!Array.isArray(response.result)) refusal(code);
      const info = response.resultInfo;
      assertPlainObject(info, code);
      for (const key of ["page", "count", "total_count", "total_pages"]) {
        if (!Number.isSafeInteger(info[key]) || info[key] < 0) refusal(code);
      }
      if (info.page !== page || info.count !== response.result.length ||
          info.total_count < response.result.length || info.total_pages > 100 ||
          (info.total_pages === 0 && (page !== 1 || info.total_count !== 0 || response.result.length !== 0)) ||
          (info.total_pages > 0 && page > info.total_pages)) refusal(code);
      if (expectedTotal === null) {
        expectedTotal = info.total_count;
        expectedPages = info.total_pages;
      } else if (info.total_count !== expectedTotal || info.total_pages !== expectedPages) refusal(code);
      rows.push(...response.result);
    }
    if (rows.length !== expectedTotal) refusal(code);
    return rows;
  };

  let providerToken = null;
  const dataRequest = async (path, adminKey, { body } = {}) => {
    revalidate();
    const base = new URL(`https://${binding.domain}`);
    const url = new URL(path, `${base.href}/`);
    if (url.origin !== base.origin || !url.pathname.startsWith("/") || url.username || url.password || url.hash) {
      refusal("brain_data_target_refused");
    }
    const response = await exactFetch(fetchImpl, url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-store",
        ...(adminKey ? { "X-Admin-Key": adminKey } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, "brain_data_request_failed");
    const parsed = await boundedResponseJson(response, "brain_data_response_invalid");
    revalidate();
    return Object.freeze({ status: response.status, headers: response.headers, body: parsed });
  };

  const session = async (action) => oauth.withCloudflareOAuthSession({
    profile: binding.authProfile,
    expectedAccountId: binding.accountId,
    reauthorize: false,
    readOnlyExistingProfile: true,
    environment: runtime.environment,
    workingDirectory: runtime.runtimeRoot,
    tmpDirectory: runtime.environment.TMPDIR,
    action: async ({ profile, account: selected, token }) => {
      if (profile !== binding.authProfile || selected?.id !== binding.accountId || !Buffer.isBuffer(token)) {
        refusal("named_oauth_account_binding_mismatch");
      }
      providerToken = token;
      try { return await action(provider); }
      finally { providerToken = null; }
    },
  });

  const provider = Object.freeze({
    withSession: session,
    async d1Rows(sql) {
      if (!providerToken || typeof sql !== "string" || !sql) refusal("provider_session_required");
      const response = await cloudflare(`accounts/${account}/d1/database/${database}/query`, {
        method: "POST", body: { sql },
      });
      return normalizeD1Rows({ success: true, errors: [], result: response.result }, response.status);
    },
    async vectorInfo() {
      const { result } = await cloudflare(`accounts/${account}/vectorize/v2/indexes/${vector}`);
      return normalizeVectorInfo(result);
    },
    async inspectControl(expectedVersion) {
      if (!VERSION_PATTERN.test(String(expectedVersion || ""))) refusal("cloudflare_worker_version_refused");
      const databaseInfo = (await cloudflare(`accounts/${account}/d1/database/${database}`)).result;
      const vectorInfo = await provider.vectorInfo();
      const accountSubdomain = (await cloudflare(`accounts/${account}/workers/subdomain`)).result;
      const workersDevDomainFingerprint = validateAccountWorkersDevSubdomain(accountSubdomain, binding);
      const workersDev = (await cloudflare(`accounts/${account}/workers/scripts/${worker}/subdomain`)).result;
      const schedules = normalizeSchedules((await cloudflare(`accounts/${account}/workers/scripts/${worker}/schedules`)).result);
      const deployments = (await cloudflare(`accounts/${account}/workers/scripts/${worker}/deployments`)).result;
      const activeVersionId = activeDeploymentVersion(deployments);
      const versionInfo = (await cloudflare(`accounts/${account}/workers/scripts/${worker}/versions/${encodedSegment(activeVersionId)}`)).result;
      const workerBindingFingerprint = validateActiveWorkerBindings(
        versionInfo, binding, expectedVersion, activeVersionId,
      );
      const zones = await pagedCollection(`zones?account.id=${account}`, "cloudflare_zone_inventory_refused");
      allowedZoneIds.clear();
      const seenZoneIds = new Set();
      const zoneIds = [];
      for (const zone of zones) {
        const zoneId = String(zone?.id || "");
        if (!/^[a-f0-9]{32}$/.test(zoneId) || zone?.account?.id !== binding.accountId ||
            seenZoneIds.has(zoneId)) refusal("cloudflare_zone_inventory_refused");
        seenZoneIds.add(zoneId);
        allowedZoneIds.add(zoneId);
        zoneIds.push(zoneId);
      }
      let routeCount = 0;
      for (const zoneId of zoneIds) {
        routeCount += normalizeZoneRoutes(
          await cloudflare(`zones/${zoneId}/workers/routes`),
          binding.workerName,
        );
      }
      const customDomains = normalizeCompleteWorkerRecords(
        await cloudflare(`accounts/${account}/workers/domains?service=${worker}&page=1&per_page=100`),
        binding.workerName,
        "cloudflare_custom_domains_refused",
        { requireResultInfo: true },
      );
      const databaseId = String(databaseInfo?.uuid ?? databaseInfo?.id ?? "");
      const databaseName = String(databaseInfo?.name ?? "");
      const scriptEtag = String(versionInfo?.resources?.script?.etag ?? versionInfo?.etag ?? "");
      if (!D1_ID_PATTERN.test(databaseId) || !databaseName || !SHA256_PATTERN.test(scriptEtag)) {
        refusal("cloudflare_target_identity_refused");
      }
      return Object.freeze({
        databaseId, databaseName, vectorInfo,
        workersDevEnabled: workersDev?.enabled === true,
        workersDevDomainFingerprint,
        schedules, routes: routeCount, customDomains: customDomains.length,
        activeVersionId, scriptEtag, workerBindingFingerprint,
      });
    },
    health: () => dataRequest("/health", null),
    ingest: (adminKey, docs) => dataRequest("/api/admin/brain/ingest/batch", adminKey, { body: { docs } }),
    drain: (adminKey) => dataRequest("/api/admin/brain/drain", adminKey, { body: {} }),
    unified: (adminKey, body) => dataRequest("/api/rag/unified", adminKey, { body }),
  });
  return provider;
}

function normalizeSnapshot(row) {
  assertPlainObject(row, "d1_lifecycle_snapshot_invalid");
  const result = {
    install_rows: integer(row.install_rows, "d1_lifecycle_snapshot_invalid"),
    client_slug: String(row.client_slug ?? ""),
    product_version: String(row.product_version ?? ""),
    schema_version: integer(row.schema_version, "d1_lifecycle_snapshot_invalid"),
    status: String(row.status ?? ""),
    protocol: String(row.protocol ?? ""),
    epoch: integer(row.epoch, "d1_lifecycle_snapshot_invalid"),
    base_count: integer(row.base_count, "d1_lifecycle_snapshot_invalid"),
    residue_epoch: row.residue_epoch === null || row.residue_epoch === undefined
      ? null : integer(row.residue_epoch, "d1_lifecycle_snapshot_invalid"),
    lease_present: integer(row.lease_present, "d1_lifecycle_snapshot_invalid"),
    documents: integer(row.documents, "d1_lifecycle_snapshot_invalid"),
    chunks: integer(row.chunks, "d1_lifecycle_snapshot_invalid"),
    outbox: integer(row.outbox, "d1_lifecycle_snapshot_invalid"),
    batches: integer(row.batches, "d1_lifecycle_snapshot_invalid"),
    unfinished_batches: integer(row.unfinished_batches, "d1_lifecycle_snapshot_invalid"),
    retry_rows: integer(row.retry_rows, "d1_lifecycle_snapshot_invalid"),
    event_count: integer(row.event_count, "d1_lifecycle_snapshot_invalid"),
    event_max_id: integer(row.event_max_id, "d1_lifecycle_snapshot_invalid"),
    bad_upgrade_runs: integer(row.bad_upgrade_runs, "d1_lifecycle_snapshot_invalid"),
  };
  if (!SLUG_PATTERN.test(result.client_slug) || !VERSION_PATTERN.test(result.product_version)) {
    refusal("d1_lifecycle_snapshot_invalid");
  }
  return Object.freeze(result);
}

function normalizeUpgradeSummary(row) {
  assertPlainObject(row, "upgrade_summary_invalid");
  return Object.freeze({
    total: integer(row.total, "upgrade_summary_invalid"),
    max_id: integer(row.max_id, "upgrade_summary_invalid"),
  });
}

function normalizeResidueShape(row) {
  assertPlainObject(row, "residue_shape_invalid");
  return Object.freeze(Object.fromEntries([
    "total", "upserts", "deletes", "submitted", "legacy_failed",
    "pageable", "quarantined", "orphan_upserts",
  ].map((key) => [key, integer(row[key], "residue_shape_invalid")])));
}

async function singleD1Row(provider, sql, code) {
  const rows = await provider.d1Rows(sql);
  if (!Array.isArray(rows) || rows.length !== 1) refusal(code);
  return rows[0];
}

export function validateControlSnapshot(control, binding, { expectedSchedules, previous = null } = {}) {
  assertPlainObject(control, "target_control_snapshot_invalid");
  if (control.databaseId !== binding.databaseId || control.databaseName !== binding.databaseName ||
      control.vectorInfo?.name !== binding.vectorIndex || control.vectorInfo?.dimensions !== 768 ||
      control.vectorInfo?.metric !== "cosine" || control.workersDevEnabled !== true ||
      !SHA256_PATTERN.test(String(control.workersDevDomainFingerprint || "")) ||
      !SHA256_PATTERN.test(String(control.workerBindingFingerprint || "")) ||
      integer(control.routes, "target_control_snapshot_invalid") !== 0 ||
      integer(control.customDomains, "target_control_snapshot_invalid") !== 0 ||
      canonical(control.schedules) !== canonical(expectedSchedules) ||
      typeof control.activeVersionId !== "string" || !/^[a-f0-9-]{16,64}$/i.test(control.activeVersionId) ||
      !SHA256_PATTERN.test(String(control.scriptEtag || ""))) refusal("target_control_snapshot_invalid");
  if (previous && (control.activeVersionId === previous.activeVersionId || control.scriptEtag === previous.scriptEtag)) {
    refusal("target_active_worker_did_not_change");
  }
  return Object.freeze({
    isolationFingerprint: fingerprint({
      account_id: binding.accountId,
      worker_name: binding.workerName,
      database_name: control.databaseName,
      database_id: control.databaseId,
      vectorize_index: control.vectorInfo.name,
      domain: binding.domain,
      active_version_id: control.activeVersionId,
      worker_script_etag: control.scriptEtag,
      routes: 0,
      custom_domains: 0,
      workers_dev: true,
      workers_dev_domain_fingerprint: control.workersDevDomainFingerprint,
      worker_binding_fingerprint: control.workerBindingFingerprint,
      schedules: [...control.schedules],
    }),
    vectorCount: integer(control.vectorInfo.vectorCount, "target_control_snapshot_invalid"),
    activeVersionId: control.activeVersionId,
    scriptEtag: control.scriptEtag,
  });
}

export function validateHealthReceipt(response, version, expectedMode = "active") {
  if (!response || response.status !== 200) refusal("worker_health_invalid");
  const body = assertPlainObject(response.body, "worker_health_invalid");
  const active = expectedMode === "active";
  if (body.version !== version || body.vector_writer_protocol !== "lease-v1" ||
      body.vector_drain_mode !== expectedMode || body.ok !== active ||
      body.status !== (active ? "ok" : "paused-for-upgrade") ||
      body.accepting_documents !== active || body.version_mismatch === true ||
      body.configured_version !== undefined) refusal("worker_health_invalid");
  return true;
}

export function validateCleanBaseline(snapshot, upgrade, vector, binding, contract) {
  if (snapshot.install_rows !== 1 || snapshot.client_slug !== binding.slug ||
      snapshot.product_version !== binding.fromVersion ||
      snapshot.schema_version !== contract.residueSchema || snapshot.status !== "verified" ||
      snapshot.protocol !== "bootstrap-v2" || snapshot.base_count !== snapshot.chunks ||
      snapshot.residue_epoch !== null ||
      snapshot.lease_present !== 0 || snapshot.outbox !== 0 || snapshot.batches !== 0 ||
      snapshot.unfinished_batches !== 0 || snapshot.retry_rows !== 0 || snapshot.event_count !== 0 ||
      snapshot.event_max_id !== 0 || snapshot.bad_upgrade_runs !== 0 ||
      vector.vectorCount !== snapshot.chunks || vector.dimensions !== 768 || vector.metric !== "cosine") {
    refusal("clean_residue_predecessor_baseline_required");
  }
  if (upgrade.total < 0 || upgrade.max_id < 0 || (upgrade.total === 0) !== (upgrade.max_id === 0)) {
    refusal("upgrade_summary_invalid");
  }
  return true;
}

export function validateSeededState(snapshot, residue, vector, baseline, binding, contract) {
  const added = contract.triggerRows;
  if (snapshot.install_rows !== 1 || snapshot.client_slug !== binding.slug ||
      snapshot.product_version !== binding.fromVersion ||
      snapshot.schema_version !== contract.residueSchema || snapshot.status !== "pending" ||
      snapshot.protocol !== baseline.protocol || snapshot.epoch !== baseline.epoch ||
      snapshot.base_count !== baseline.base_count || snapshot.residue_epoch !== baseline.residue_epoch ||
      snapshot.documents !== baseline.documents + added || snapshot.chunks !== baseline.chunks + added ||
      snapshot.outbox !== added || snapshot.batches !== 0 || snapshot.unfinished_batches !== 0 ||
      snapshot.retry_rows !== 0 || snapshot.event_count !== baseline.event_count ||
      snapshot.event_max_id !== baseline.event_max_id || snapshot.bad_upgrade_runs !== 0 ||
      snapshot.lease_present !== 0 || residue.total !== added || residue.upserts !== added ||
      residue.pageable !== added || residue.deletes !== 0 || residue.submitted !== 0 ||
      residue.legacy_failed !== 0 || residue.quarantined !== 0 || residue.orphan_upserts !== 0 ||
      vector.vectorCount !== baseline.chunks || vector.dimensions !== 768 || vector.metric !== "cosine") {
    refusal("deterministic_seeded_residue_state_required");
  }
  return true;
}

function planMaterial(options, field, runtime, manifestPin, binding, baseline, upgrade, isolationFingerprint) {
  return Object.freeze({
    schema_version: 2,
    gate: GATE,
    package: {
      path: field.packagePin.path,
      sha256: field.candidate.archiveSha256,
      bytes: field.candidate.archiveBytes,
      version: field.candidate.version,
      commit: field.candidate.commit,
      tree: field.candidate.tree,
    },
    field_receipt: { path: field.receiptPin.path, sha256: field.receiptPin.hash },
    manifest: { path: manifestPin.path, sha256: manifestPin.hash },
    target: {
      account_id: binding.accountId,
      worker_name: binding.workerName,
      database_name: binding.databaseName,
      database_id: binding.databaseId,
      vectorize_index: binding.vectorIndex,
      domain: binding.domain,
      auth_profile: binding.authProfile,
    },
    candidate_contract: {
      terminal_schema: runtime.contract.terminalSchema,
      residue_schema: runtime.contract.residueSchema,
      trigger_rows: runtime.contract.triggerRows,
      page_size: runtime.contract.pageSize,
      window: runtime.contract.window,
      ingest_batch_max: runtime.contract.ingestBatchMax,
      seed_calls: runtime.contract.seedCalls,
    },
    baseline,
    upgrade_baseline: upgrade,
    isolation_fingerprint: isolationFingerprint,
    cleanup_owner: options.cleanupOwner,
    paths: {
      plan_receipt: options.planReceiptPath,
      seed_receipt: options.seedReceiptPath,
      final_receipt: options.receiptPath,
    },
  });
}

function publicContract(contract) {
  return Object.freeze({
    terminal_schema: contract.terminalSchema,
    residue_schema: contract.residueSchema,
    trigger_rows: contract.triggerRows,
    page_size: contract.pageSize,
    window: contract.window,
    ingest_batch_max: contract.ingestBatchMax,
    seed_calls: contract.seedCalls,
  });
}

function publicBaseline(snapshot, upgrade) {
  const { client_slug: omittedClientSlug, ...aggregate } = snapshot;
  if (!omittedClientSlug) refusal("plan_baseline_invalid");
  return Object.freeze({
    ...aggregate,
    client_slug_matches: true,
    upgrade_total: upgrade.total,
    upgrade_max_id: upgrade.max_id,
  });
}

function buildPlanReceipt({ now, planFingerprint, field, runtime, manifestPin, baseline, upgrade, cleanupOwner }) {
  return Object.freeze({
    schema_version: 2,
    gate: GATE,
    status: PLAN_STATUS,
    created_at: now,
    plan_fingerprint: planFingerprint,
    data_class: "fictional_synthetic_only",
    candidate: Object.freeze({
      git_sha: field.candidate.commit,
      git_tree: field.candidate.tree,
      package_version: field.candidate.version,
      package_sha256: field.candidate.archiveSha256,
      package_bytes: field.candidate.archiveBytes,
      package_file_count: field.candidate.fileCount,
      field_receipt_sha256: field.receiptPin.hash,
      manifest_sha256: manifestPin.hash,
    }),
    contract: publicContract(runtime.contract),
    baseline: publicBaseline(baseline, upgrade),
    control: Object.freeze({
      zero_routes: true,
      zero_custom_domains: true,
      zero_schedules: true,
      workers_dev_only: true,
      vector_dimensions: 768,
      vector_metric: "cosine",
    }),
    seed_receipt_contract: Object.freeze({
      status: SEED_STATUS,
      plan_fingerprint: planFingerprint,
      documents_requested: runtime.contract.triggerRows,
      chunks: runtime.contract.triggerRows,
      batch_calls: runtime.contract.seedCalls,
      max_batch_size: runtime.contract.ingestBatchMax,
      schedules_disabled: true,
      all_results_created: true,
      all_results_one_chunk: true,
      only_aggregate_fields: true,
    }),
    safeguards: Object.freeze({
      ordinary_manifests_refused: true,
      private_data_refused: true,
      ambient_provider_credentials_refused: true,
      resources_created_by_harness: false,
      resources_deleted_by_harness: false,
      update_executed: false,
      target_identifiers_recorded: false,
      receipt_paths_recorded: false,
    }),
    cleanup: Object.freeze({ required: true, owner: cleanupOwner, verified: false }),
    next: PLAN_NEXT,
  });
}

function validatePlanReceipt(receipt, field, runtime, manifestPin, binding, options) {
  assertExactKeys(receipt, [
    "schema_version", "gate", "status", "created_at", "plan_fingerprint", "data_class",
    "candidate", "contract", "baseline", "control", "seed_receipt_contract",
    "safeguards", "cleanup", "next",
  ], "plan_receipt_invalid");
  assertExactKeys(receipt.candidate, [
    "git_sha", "git_tree", "package_version", "package_sha256", "package_bytes",
    "package_file_count", "field_receipt_sha256", "manifest_sha256",
  ], "plan_receipt_invalid");
  assertExactKeys(receipt.contract, [
    "terminal_schema", "residue_schema", "trigger_rows", "page_size", "window",
    "ingest_batch_max", "seed_calls",
  ], "plan_receipt_invalid");
  assertExactKeys(receipt.baseline, [
    "install_rows", "client_slug_matches", "product_version", "schema_version", "status", "protocol", "epoch",
    "base_count", "residue_epoch", "lease_present", "documents", "chunks", "outbox",
    "batches", "unfinished_batches", "retry_rows", "event_count", "event_max_id",
    "bad_upgrade_runs", "upgrade_total", "upgrade_max_id",
  ], "plan_receipt_invalid");
  assertExactKeys(receipt.control, [
    "zero_routes", "zero_custom_domains", "zero_schedules", "workers_dev_only",
    "vector_dimensions", "vector_metric",
  ], "plan_receipt_invalid");
  assertExactKeys(receipt.seed_receipt_contract, [
    "status", "plan_fingerprint", "documents_requested", "chunks", "batch_calls",
    "max_batch_size", "schedules_disabled", "all_results_created",
    "all_results_one_chunk", "only_aggregate_fields",
  ], "plan_receipt_invalid");
  assertExactKeys(receipt.safeguards, [
    "ordinary_manifests_refused", "private_data_refused", "ambient_provider_credentials_refused",
    "resources_created_by_harness", "resources_deleted_by_harness", "update_executed",
    "target_identifiers_recorded", "receipt_paths_recorded",
  ], "plan_receipt_invalid");
  assertExactKeys(receipt.cleanup, ["required", "owner", "verified"], "plan_receipt_invalid");
  const createdAt = new Date(receipt.created_at);
  if (receipt.schema_version !== 2 || receipt.gate !== GATE || receipt.status !== PLAN_STATUS ||
      receipt.data_class !== "fictional_synthetic_only" || !SHA256_PATTERN.test(receipt.plan_fingerprint) ||
      typeof receipt.created_at !== "string" || !Number.isFinite(createdAt.getTime()) ||
      createdAt.toISOString() !== receipt.created_at || receipt.next !== PLAN_NEXT ||
      receipt.cleanup?.required !== true || receipt.cleanup?.owner !== options.cleanupOwner ||
      receipt.cleanup?.verified !== false || receipt.safeguards?.update_executed !== false ||
      receipt.baseline?.client_slug_matches !== true ||
      receipt.safeguards?.target_identifiers_recorded !== false ||
      receipt.safeguards?.receipt_paths_recorded !== false) refusal("plan_receipt_invalid");
  const candidate = receipt.candidate;
  if (candidate?.git_sha !== field.candidate.commit || candidate?.git_tree !== field.candidate.tree ||
      candidate?.package_version !== field.candidate.version ||
      candidate?.package_sha256 !== field.candidate.archiveSha256 ||
      candidate?.package_bytes !== field.candidate.archiveBytes ||
      candidate?.package_file_count !== field.candidate.fileCount ||
      candidate?.field_receipt_sha256 !== field.receiptPin.hash ||
      candidate?.manifest_sha256 !== manifestPin.hash ||
      canonical(receipt.contract) !== canonical(publicContract(runtime.contract))) refusal("plan_candidate_binding_changed");
  const expectedControl = {
    zero_routes: true,
    zero_custom_domains: true,
    zero_schedules: true,
    workers_dev_only: true,
    vector_dimensions: 768,
    vector_metric: "cosine",
  };
  const expectedSeed = {
    status: SEED_STATUS,
    plan_fingerprint: receipt.plan_fingerprint,
    documents_requested: runtime.contract.triggerRows,
    chunks: runtime.contract.triggerRows,
    batch_calls: runtime.contract.seedCalls,
    max_batch_size: runtime.contract.ingestBatchMax,
    schedules_disabled: true,
    all_results_created: true,
    all_results_one_chunk: true,
    only_aggregate_fields: true,
  };
  const expectedSafeguards = {
    ordinary_manifests_refused: true,
    private_data_refused: true,
    ambient_provider_credentials_refused: true,
    resources_created_by_harness: false,
    resources_deleted_by_harness: false,
    update_executed: false,
    target_identifiers_recorded: false,
    receipt_paths_recorded: false,
  };
  if (canonical(receipt.control) !== canonical(expectedControl) ||
      canonical(receipt.seed_receipt_contract) !== canonical(expectedSeed) ||
      canonical(receipt.safeguards) !== canonical(expectedSafeguards)) refusal("plan_receipt_invalid");
  baselineFromPlan(receipt, binding);
  return receipt;
}

export function syntheticSeedReceipt(planReceipt) {
  const contract = planReceipt?.seed_receipt_contract;
  if (!contract || planReceipt?.status !== PLAN_STATUS) refusal("plan_receipt_invalid");
  return Object.freeze({
    schema_version: 1,
    gate: GATE,
    status: SEED_STATUS,
    plan_fingerprint: planReceipt.plan_fingerprint,
    data_class: "fictional_synthetic_only",
    schedules_disabled: true,
    documents_requested: contract.documents_requested,
    batch_calls: contract.batch_calls,
    max_batch_size: contract.max_batch_size,
    created: contract.documents_requested,
    updated: 0,
    unchanged: 0,
    refused: 0,
    failed: 0,
    chunks: contract.chunks,
    all_results_created: true,
    all_results_one_chunk: true,
    identifiers_persisted: false,
    content_persisted: false,
  });
}

export function validateSyntheticSeedReceipt(receipt, planReceipt, contract) {
  assertExactKeys(receipt, [
    "schema_version", "gate", "status", "plan_fingerprint", "data_class",
    "schedules_disabled", "documents_requested", "batch_calls", "max_batch_size",
    "created", "updated", "unchanged", "refused", "failed", "chunks",
    "all_results_created", "all_results_one_chunk",
    "identifiers_persisted", "content_persisted",
  ], "seed_receipt_contains_nonaggregate_fields");
  if (receipt.schema_version !== 1 || receipt.gate !== GATE || receipt.status !== SEED_STATUS ||
      receipt.plan_fingerprint !== planReceipt.plan_fingerprint ||
      receipt.data_class !== "fictional_synthetic_only" || receipt.schedules_disabled !== true ||
      receipt.documents_requested !== contract.triggerRows || receipt.batch_calls !== contract.seedCalls ||
      receipt.max_batch_size !== contract.ingestBatchMax || receipt.created !== contract.triggerRows ||
      receipt.updated !== 0 || receipt.unchanged !== 0 || receipt.refused !== 0 || receipt.failed !== 0 ||
      receipt.chunks !== contract.triggerRows || receipt.all_results_created !== true ||
      receipt.all_results_one_chunk !== true || receipt.identifiers_persisted !== false ||
      receipt.content_persisted !== false) refusal("seed_receipt_invalid");
  return true;
}

const WINDOWS_DIRECTORY_SYNC_UNSUPPORTED = new Set([
  "EACCES", "EBADF", "EISDIR", "EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM",
]);

function windowsDirectorySyncUnsupported(error, platform) {
  return platform === "win32" && WINDOWS_DIRECTORY_SYNC_UNSUPPORTED.has(error?.code);
}

/**
 * Flush a directory entry after create, rename, or unlink. Node may reject a
 * directory handle on Windows. Only those documented platform errors fall
 * back to a stable O_RDWR handle for the final file in the same directory.
 */
export function syncDirectoryBarrier(
  directoryPath,
  expectedDirectoryInfo,
  finalPath,
  expectedFinalInfo,
  code,
  {
    platform = process.platform,
    openDirectoryHandle = openSync,
    statDirectoryHandle = fstatSync,
    syncDirectoryHandle = fsyncSync,
    closeDirectoryHandle = closeSync,
    syncFileHandle = fsyncSync,
  } = {},
) {
  const absoluteDirectory = resolve(directoryPath);
  const absoluteFinal = resolve(finalPath);
  if (dirname(absoluteFinal) !== absoluteDirectory) refusal(code);
  const initialDirectory = lstatSync(absoluteDirectory);
  if (!initialDirectory.isDirectory() || initialDirectory.isSymbolicLink() ||
      realpathSync(absoluteDirectory) !== absoluteDirectory ||
      !sameInode(initialDirectory, expectedDirectoryInfo)) refusal(code);
  const initialFinal = lstatSync(absoluteFinal);
  if (!initialFinal.isFile() || initialFinal.isSymbolicLink() || initialFinal.nlink !== 1 ||
      (expectedFinalInfo && !sameStableSingleFile(initialFinal, expectedFinalInfo))) refusal(code);

  let directoryDescriptor;
  let directoryFailure = null;
  try {
    try {
      directoryDescriptor = openDirectoryHandle(
        absoluteDirectory,
        fsConstants.O_RDONLY |
          (platform === "win32" ? 0 : (fsConstants.O_DIRECTORY || 0)) |
          (fsConstants.O_NOFOLLOW || 0),
      );
    } catch (error) {
      if (!windowsDirectorySyncUnsupported(error, platform)) throw error;
      directoryFailure = error;
    }
    if (directoryDescriptor !== undefined) {
      const opened = statDirectoryHandle(directoryDescriptor);
      if (!opened.isDirectory() || !sameInode(opened, expectedDirectoryInfo)) refusal(code);
      try {
        syncDirectoryHandle(directoryDescriptor);
      } catch (error) {
        if (!windowsDirectorySyncUnsupported(error, platform)) throw error;
        directoryFailure = error;
      }
      if (!directoryFailure) {
        if (!sameInode(statDirectoryHandle(directoryDescriptor), expectedDirectoryInfo)) refusal(code);
        const finalDirectory = lstatSync(absoluteDirectory);
        const finalFile = lstatSync(absoluteFinal);
        if (!finalDirectory.isDirectory() || finalDirectory.isSymbolicLink() ||
            realpathSync(absoluteDirectory) !== absoluteDirectory ||
            !sameInode(finalDirectory, expectedDirectoryInfo) ||
            !sameStableSingleFile(initialFinal, finalFile)) refusal(code);
      }
    }
  } finally {
    if (directoryDescriptor !== undefined) {
      closeDirectoryHandle(directoryDescriptor);
    }
  }
  if (!directoryFailure) return true;

  // FlushFileBuffers needs a writable handle. The file was already fsynced
  // before the directory barrier; this is the strongest supported Windows
  // post-entry barrier and retains exact identity checks around the flush.
  let finalDescriptor;
  let finalFailure = null;
  try {
    const before = lstatSync(absoluteFinal);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
        (expectedFinalInfo && !sameStableSingleFile(before, expectedFinalInfo))) refusal(code);
    finalDescriptor = openSync(
      absoluteFinal,
      fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW || 0),
    );
    const opened = fstatSync(finalDescriptor);
    if (!sameStableSingleFile(before, opened)) refusal(code);
    syncFileHandle(finalDescriptor);
    const openedAfter = fstatSync(finalDescriptor);
    const finalAfter = lstatSync(absoluteFinal);
    const directoryAfter = lstatSync(absoluteDirectory);
    if (!sameStableSingleFile(before, openedAfter) ||
        !sameStableSingleFile(before, finalAfter) ||
        !directoryAfter.isDirectory() || directoryAfter.isSymbolicLink() ||
        realpathSync(absoluteDirectory) !== absoluteDirectory ||
        !sameInode(directoryAfter, expectedDirectoryInfo)) refusal(code);
  } catch (error) {
    finalFailure = error;
  } finally {
    if (finalDescriptor !== undefined) {
      try { closeSync(finalDescriptor); } catch (error) { finalFailure ||= error; }
    }
  }
  if (finalFailure) throw finalFailure;
  return true;
}

export function persistAggregateReceipt(path, receipt) {
  const parent = assertPrivateDirectory(dirname(resolve(path)), "receipt_parent_refused");
  let descriptor;
  let info;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    fchmodSync(descriptor, 0o600);
    info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
      refusal("receipt_file_refused");
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  syncDirectoryBarrier(parent.path, parent.info, path, info, "receipt_parent_changed");
}

function writeDescriptorBytes(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (!Number.isSafeInteger(written) || written < 1) refusal("receipt_write_failed");
    offset += written;
  }
}

function readDescriptorBytes(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const read = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (!Number.isSafeInteger(read) || read < 1) refusal("receipt_read_failed");
    offset += read;
  }
  return bytes;
}

function validateReceiptReservation(reservation, code) {
  if (!reservation || reservation.closed === true || !Number.isSafeInteger(reservation.descriptor)) {
    refusal(code);
  }
  let parent;
  let current;
  let opened;
  try {
    parent = lstatSync(reservation.parentPath);
    current = lstatSync(reservation.path);
    opened = fstatSync(reservation.descriptor);
  } catch { refusal(code); }
  if (!parent.isDirectory() || parent.isSymbolicLink() ||
      realpathSync(reservation.parentPath) !== reservation.parentPath ||
      !sameInode(parent, reservation.parentInfo) ||
      (process.platform !== "win32" && (parent.mode & 0o077) !== 0) ||
      (typeof process.getuid === "function" && parent.uid !== process.getuid()) ||
      !Number.isSafeInteger(reservation.markerSize) || reservation.markerSize < 1 ||
      reservation.markerSize > MAX_JSON_BYTES ||
      !SHA256_PATTERN.test(reservation.markerHash || "") ||
      !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 ||
      (process.platform !== "win32" && (current.mode & 0o077) !== 0) ||
      current.size !== reservation.markerSize ||
      !sameFile(reservation.info, current) || !sameFile(reservation.info, opened)) refusal(code);
  return true;
}

function closeReceiptReservationHandle(reservation, closeHandle = closeSync) {
  if (!reservation || reservation.closed === true || !Number.isSafeInteger(reservation.descriptor)) {
    refusal("receipt_reservation_changed");
  }
  const descriptor = reservation.descriptor;
  closeHandle(descriptor);
  reservation.descriptor = undefined;
  reservation.closed = true;
}

function validateClosedReceiptReservation(reservation, code, platform = process.platform) {
  if (!reservation || reservation.closed !== true || reservation.descriptor !== undefined) refusal(code);
  let parent;
  let current;
  try {
    parent = lstatSync(reservation.parentPath);
    current = lstatSync(reservation.path);
  } catch { refusal(code); }
  if (!parent.isDirectory() || parent.isSymbolicLink() ||
      realpathSync(reservation.parentPath) !== reservation.parentPath ||
      !sameInode(parent, reservation.parentInfo) ||
      (platform !== "win32" && (parent.mode & 0o077) !== 0) ||
      (typeof process.getuid === "function" && parent.uid !== process.getuid()) ||
      !Number.isSafeInteger(reservation.markerSize) || reservation.markerSize < 1 ||
      reservation.markerSize > MAX_JSON_BYTES ||
      !SHA256_PATTERN.test(reservation.markerHash || "") ||
      !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 ||
      (platform !== "win32" && (current.mode & 0o077) !== 0) ||
      current.size !== reservation.markerSize || reservation.info?.size !== reservation.markerSize ||
      !sameInode(reservation.info, current)) refusal(code);
  let markerDescriptor;
  let markerBytes;
  let markerMatches = false;
  let stable;
  try {
    markerDescriptor = openSync(
      reservation.path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0) |
        (platform === "win32" ? 0 : (fsConstants.O_NONBLOCK || 0)),
    );
    const opened = fstatSync(markerDescriptor);
    if (!sameStableSingleFile(current, opened)) refusal(code);
    markerBytes = Buffer.alloc(reservation.markerSize);
    readDescriptorBytes(markerDescriptor, markerBytes);
    const openedAfterRead = fstatSync(markerDescriptor);
    stable = lstatSync(reservation.path);
    markerMatches = sha256(markerBytes) === reservation.markerHash &&
      sameStableSingleFile(current, openedAfterRead) &&
      sameStableSingleFile(current, stable);
  } catch { /* Refuse an unreadable or concurrently replaced marker below. */ }
  finally {
    if (Buffer.isBuffer(markerBytes)) markerBytes.fill(0);
    if (markerDescriptor !== undefined) {
      const descriptor = markerDescriptor;
      closeSync(descriptor);
      markerDescriptor = undefined;
    }
  }
  if (!markerMatches) refusal(code);
  return stable;
}

function syncReservationDirectory(reservation, code, expectedFinalInfo = null) {
  return syncDirectoryBarrier(
    reservation.parentPath,
    reservation.parentInfo,
    reservation.path,
    expectedFinalInfo,
    code,
  );
}

export function reserveAggregateReceipt(output, marker) {
  if (!output?.path || !output?.parent?.path || dirname(output.path) !== output.parent.path) {
    refusal("receipt_reservation_invalid");
  }
  const parent = assertPrivateDirectory(output.parent.path, "receipt_parent_refused");
  if (!sameInode(parent.info, output.parent.info)) refusal("receipt_parent_changed");
  let descriptor;
  try {
    descriptor = openSync(
      output.path,
      fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
  } catch (error) {
    if (error?.code === "EEXIST") refusal("receipt_reservation_collision");
    throw error;
  }
  const reservation = {
    path: output.path,
    parentPath: parent.path,
    parentInfo: parent.info,
    descriptor,
    info: null,
    markerSize: null,
    markerHash: null,
    closed: false,
  };
  let bytes;
  try {
    bytes = Buffer.from(`${JSON.stringify(marker, null, 2)}\n`, "utf8");
    reservation.markerSize = bytes.length;
    reservation.markerHash = sha256(bytes);
    writeDescriptorBytes(descriptor, bytes);
    fsyncSync(descriptor);
    fchmodSync(descriptor, 0o600);
    reservation.info = fstatSync(descriptor);
    const current = lstatSync(output.path);
    if (!reservation.info.isFile() || reservation.info.nlink !== 1 ||
        reservation.info.size !== reservation.markerSize ||
        (process.platform !== "win32" && (reservation.info.mode & 0o077) !== 0) ||
        !sameFile(reservation.info, current)) refusal("receipt_reservation_invalid");
    syncReservationDirectory(reservation, "receipt_parent_changed", reservation.info);
    validateReceiptReservation(reservation, "receipt_reservation_changed");
    return reservation;
  } catch (error) {
    try { closeSync(descriptor); } catch { /* The reserved path remains a conservative marker. */ }
    reservation.closed = true;
    throw error;
  } finally {
    if (bytes) bytes.fill(0);
  }
}

export function finalizeReservedAggregateReceipt(reservation, receipt, {
  writeBytes = writeDescriptorBytes,
  readBytes = readDescriptorBytes,
  syncFile = fsyncSync,
  rename = renameSync,
  syncDirectory = syncReservationDirectory,
  platform = process.platform,
  closeReservation = closeSync,
  closeTemporary = closeSync,
} = {}) {
  validateReceiptReservation(reservation, "receipt_reservation_changed");
  const nonce = randomBytes(12).toString("hex");
  const temporaryPath = join(reservation.parentPath, `.accelerated-update-field-gate-final-${nonce}.tmp`);
  let temporaryDescriptor;
  let temporaryIdentity = null;
  let temporaryInfo = null;
  let renamed = false;
  let bytes;
  try {
    bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    temporaryDescriptor = openSync(
      temporaryPath,
      fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    temporaryIdentity = fstatSync(temporaryDescriptor);
    writeBytes(temporaryDescriptor, bytes);
    syncFile(temporaryDescriptor);
    fchmodSync(temporaryDescriptor, 0o600);
    temporaryInfo = fstatSync(temporaryDescriptor);
    const temporaryCurrent = lstatSync(temporaryPath);
    if (!temporaryInfo.isFile() || temporaryInfo.nlink !== 1 || temporaryInfo.size !== bytes.length ||
        (platform !== "win32" && (temporaryInfo.mode & 0o077) !== 0) ||
        !sameFile(temporaryInfo, temporaryCurrent)) refusal("receipt_finalization_invalid");
    validateReceiptReservation(reservation, "receipt_reservation_changed");
    let closedReservationInfo = null;
    if (platform === "win32") {
      closeReceiptReservationHandle(reservation, closeReservation);
      closedReservationInfo = validateClosedReceiptReservation(
        reservation,
        "receipt_reservation_changed",
        platform,
      );
      if (!sameStableSingleFile(temporaryInfo, lstatSync(temporaryPath))) {
        refusal("receipt_finalization_changed");
      }
      if (!sameStableSingleFile(closedReservationInfo, lstatSync(reservation.path))) {
        refusal("receipt_reservation_changed");
      }
    }
    rename(temporaryPath, reservation.path);
    renamed = true;
    const finalCurrent = lstatSync(reservation.path);
    const finalOpened = fstatSync(temporaryDescriptor);
    if (!finalCurrent.isFile() || finalCurrent.isSymbolicLink() || finalCurrent.nlink !== 1 ||
        !sameFile(temporaryInfo, finalCurrent) ||
        !sameStableSingleFile(finalCurrent, finalOpened) ||
        (platform !== "win32" && fstatSync(reservation.descriptor).nlink !== 0)) {
      refusal("receipt_finalization_changed");
    }
    let readback;
    let verifiedCurrent;
    try {
      readback = Buffer.alloc(bytes.length);
      readBytes(temporaryDescriptor, readback);
      if (!readback.equals(bytes)) refusal("receipt_finalization_changed");
      const openedAfterRead = fstatSync(temporaryDescriptor);
      verifiedCurrent = lstatSync(reservation.path);
      if (!sameStableSingleFile(finalOpened, openedAfterRead) ||
          !sameStableSingleFile(finalCurrent, verifiedCurrent) ||
          !sameStableSingleFile(verifiedCurrent, openedAfterRead)) {
        refusal("receipt_finalization_changed");
      }
    } finally {
      if (Buffer.isBuffer(readback)) readback.fill(0);
    }
    syncDirectory(reservation, "receipt_parent_changed", verifiedCurrent);
    const durableCurrent = lstatSync(reservation.path);
    if (!sameStableSingleFile(verifiedCurrent, durableCurrent) ||
        !sameInode(lstatSync(reservation.parentPath), reservation.parentInfo)) {
      refusal("receipt_finalization_changed");
    }
    if (temporaryDescriptor !== undefined) {
      const descriptor = temporaryDescriptor;
      closeTemporary(descriptor);
      temporaryDescriptor = undefined;
    }
    if (!reservation.closed) closeReceiptReservationHandle(reservation, closeReservation);
    return true;
  } catch (error) {
    if (!renamed && temporaryIdentity) {
      try {
        const current = lstatSync(temporaryPath);
        const opened = temporaryDescriptor === undefined ? null : fstatSync(temporaryDescriptor);
        if (current.isFile() && !current.isSymbolicLink() && current.nlink === 1 &&
            sameInode(temporaryIdentity, current) && (!opened || sameInode(temporaryIdentity, opened))) {
          unlinkSync(temporaryPath);
        }
      } catch { /* Leave an ambiguous private sibling untouched for review. */ }
    }
    throw error;
  } finally {
    if (bytes) bytes.fill(0);
    if (temporaryDescriptor !== undefined) {
      try { closeSync(temporaryDescriptor); } catch { /* The target lock remains on failure. */ }
    }
  }
}

function abandonReceiptReservation(reservation) {
  if (!reservation || reservation.closed === true) return;
  try { closeReceiptReservationHandle(reservation); } catch {
    /* Preserve the exact reserved path for review. */
  }
}

function acquireExecutionLock(directory, planFingerprint, durabilityPath) {
  const path = join(directory.path, ".accelerated-update-field-gate.lock");
  if (!durabilityPath || dirname(resolve(durabilityPath)) !== directory.path) {
    refusal("execution_lock_durability_path_refused");
  }
  let descriptor;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify({ schema_version: 1, plan_fingerprint: planFingerprint })}\n`);
    fsyncSync(descriptor);
    const info = fstatSync(descriptor);
    syncDirectoryBarrier(directory.path, directory.info, path, info, "execution_lock_parent_changed");
    return Object.freeze({
      path,
      descriptor,
      info,
      directoryPath: directory.path,
      directoryInfo: directory.info,
      durabilityPath,
    });
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (error?.code === "EEXIST") refusal("execution_plan_locked");
    throw error;
  }
}

function releaseExecutionLock(lock) {
  if (!lock) return;
  const current = lstatSync(lock.path);
  const opened = fstatSync(lock.descriptor);
  if (!sameFile(lock.info, current) || !sameFile(lock.info, opened) || current.nlink !== 1) {
    refusal("execution_lock_changed");
  }
  const durabilityInfo = lstatSync(lock.durabilityPath);
  if (!durabilityInfo.isFile() || durabilityInfo.isSymbolicLink() || durabilityInfo.nlink !== 1 ||
      dirname(resolve(lock.durabilityPath)) !== lock.directoryPath) {
    refusal("execution_lock_durability_path_refused");
  }
  const directoryInfo = lstatSync(lock.directoryPath);
  if (!sameInode(directoryInfo, lock.directoryInfo)) refusal("execution_lock_parent_changed");
  closeSync(lock.descriptor);
  unlinkSync(lock.path);
  syncDirectoryBarrier(
    lock.directoryPath,
    directoryInfo,
    lock.durabilityPath,
    durabilityInfo,
    "execution_lock_parent_changed",
  );
}

function validateDistinctPaths(options) {
  const paths = [
    options.manifestPath, options.packagePath, options.fieldReceiptPath,
    options.planReceiptPath, options.seedReceiptPath, options.receiptPath,
  ];
  if (new Set(paths).size !== paths.length) refusal("field_gate_paths_must_be_distinct");
}

async function prepareLocalContext(options, dependencies, phase) {
  assertNoAmbientProviderCredential(dependencies.environment || process.env);
  validateDistinctPaths(options);
  const inspect = dependencies.inspectFieldPreparation || inspectFieldPreparation;
  const field = inspect(options.packagePath, options.fieldReceiptPath);
  assertPrivateDirectory(dirname(options.manifestPath), "synthetic_manifest_directory_refused");
  const manifestPin = parseStablePrivateJson(options.manifestPath, "synthetic_manifest_refused");
  const binding = validateSyntheticProvisionedManifest(manifestPin.value, options, field.candidate.version);
  const planOutput = phase === "prepare"
    ? assertPrivateOutputPath(options.planReceiptPath, "plan_receipt_parent_refused")
    : null;
  if (phase === "prepare") {
    assertPrivateOutputPath(options.seedReceiptPath, "seed_receipt_parent_refused");
    assertPrivateOutputPath(options.receiptPath, "receipt_parent_refused");
  }
  const finalOutput = phase === "execute"
    ? assertPrivateOutputPath(options.receiptPath, "receipt_parent_refused")
    : null;
  const install = dependencies.installCandidateArtifact || installCandidateArtifact;
  const remove = dependencies.removeCandidateRuntime || removeCandidateRuntime;
  let runtime = null;
  try {
    runtime = await install(field, dependencies.environment || process.env, {
      spawn: dependencies.installSpawn,
      temporaryRoot: dependencies.temporaryRoot,
    });
    if (runtime.candidate.version !== field.candidate.version ||
        runtime.candidate.archiveSha256 !== field.candidate.archiveSha256) refusal("installed_candidate_binding_changed");
    const deriveProfile = dependencies.deriveInstalledAuthProfile || deriveInstalledAuthProfile;
    const expectedProfile = await deriveProfile(runtime, manifestPin.path);
    if (binding.authProfile !== expectedProfile) refusal("named_cloudflare_profile_manifest_mismatch");
    const staticPins = [field.packagePin, field.receiptPin];
    const revalidateStatic = () => {
      for (const pin of staticPins) assertFilePin(pin, "candidate_or_receipt_changed");
      return true;
    };
    const revalidateBeforeUpdate = () => {
      revalidateStatic();
      assertFilePin(manifestPin, "synthetic_manifest_changed");
      return true;
    };
    return Object.freeze({ field, manifestPin, runtime, binding, planOutput, finalOutput, revalidateStatic, revalidateBeforeUpdate });
  } catch (error) {
    if (runtime) remove(runtime);
    throw error;
  }
}

async function providerCall(revalidate, action) {
  revalidate();
  const result = await action();
  revalidate();
  return result;
}

async function openProvider(runtime, binding, revalidate, dependencies) {
  const create = dependencies.createProvider || createInstalledCloudflareProvider;
  const provider = await create(runtime, binding, {
    fetchImpl: dependencies.fetch,
    revalidate,
  });
  if (!provider || typeof provider.withSession !== "function") refusal("field_provider_invalid");
  return provider;
}

export async function prepareAcceleratedUpdateFieldGate(options, dependencies = {}) {
  if (options?.mode !== "prepare") refusal("prepare_options_required");
  const local = await prepareLocalContext(options, dependencies, "prepare");
  try {
    const provider = await openProvider(local.runtime, local.binding, local.revalidateBeforeUpdate, dependencies);
    const evidence = await providerCall(local.revalidateBeforeUpdate, () => provider.withSession(async (active) => {
      const control = await providerCall(local.revalidateBeforeUpdate, () =>
        active.inspectControl(local.binding.fromVersion));
      const controlProof = validateControlSnapshot(control, local.binding, { expectedSchedules: [] });
      const health = await providerCall(local.revalidateBeforeUpdate, () => active.health());
      validateHealthReceipt(health, local.binding.fromVersion, "active");
      const baseline = normalizeSnapshot(await singleD1Row(active, BASELINE_SQL, "baseline_row_required"));
      local.revalidateBeforeUpdate();
      const upgrade = normalizeUpgradeSummary(await singleD1Row(active, UPGRADE_SUMMARY_SQL, "upgrade_summary_row_required"));
      local.revalidateBeforeUpdate();
      validateCleanBaseline(baseline, upgrade, control.vectorInfo, local.binding, local.runtime.contract);
      return Object.freeze({ control, controlProof, baseline, upgrade });
    }));
    const material = planMaterial(
      options, local.field, local.runtime, local.manifestPin, local.binding,
      evidence.baseline, evidence.upgrade, evidence.controlProof.isolationFingerprint,
    );
    const planFingerprint = fingerprint(material);
    const receipt = buildPlanReceipt({
      now: (dependencies.now || (() => new Date().toISOString()))(),
      planFingerprint,
      field: local.field,
      runtime: local.runtime,
      manifestPin: local.manifestPin,
      baseline: evidence.baseline,
      upgrade: evidence.upgrade,
      cleanupOwner: options.cleanupOwner,
    });
    (dependencies.persistReceipt || persistAggregateReceipt)(options.planReceiptPath, receipt);
    return receipt;
  } finally {
    (dependencies.removeCandidateRuntime || removeCandidateRuntime)(local.runtime);
  }
}

function baselineFromPlan(receipt, binding) {
  const raw = assertPlainObject(receipt.baseline, "plan_baseline_invalid");
  if (raw.client_slug_matches !== true) refusal("plan_baseline_invalid");
  const snapshot = normalizeSnapshot({ ...raw, client_slug: binding.slug });
  const upgrade = normalizeUpgradeSummary({ total: raw.upgrade_total, max_id: raw.upgrade_max_id });
  return Object.freeze({ snapshot, upgrade });
}

function eventSql(afterId) {
  return `SELECT id,at,kind,epoch_before,epoch_after,base_before,base_after,rows,chunks FROM vector_projection_events WHERE id>${integer(afterId, "event_baseline_invalid")} ORDER BY id`;
}

function batchSql(epoch, contract) {
  const validatedEpoch = integer(epoch, "event_epoch_invalid");
  const pageSize = integer(contract.pageSize, "installed_bootstrap_page_unrecognized");
  const pageCount = Math.ceil(contract.triggerRows / pageSize);
  return `SELECT count(*) batches,coalesce(sum(CASE WHEN status='confirmed' THEN 1 ELSE 0 END),0) confirmed,coalesce(sum(CASE WHEN status<>'confirmed' THEN 1 ELSE 0 END),0) unfinished,coalesce(sum(row_count),0) rows,min(batch_no) first_batch,max(batch_no) last_batch,coalesce(sum(CASE WHEN batch_no<${pageCount} AND row_count<>${pageSize} THEN 1 ELSE 0 END),0) bad_full_pages,coalesce(max(CASE WHEN batch_no=${pageCount} THEN row_count END),0) last_rows FROM vector_bootstrap_batches WHERE epoch=${validatedEpoch}`;
}

function upgradeRowsSql(afterId) {
  return "SELECT id,from_version,to_version,status,(started_at IS NOT NULL AND length(started_at)>0) started_present,(finished_at IS NOT NULL AND length(finished_at)>0) finished_present,(d1_bookmark IS NOT NULL AND length(d1_bookmark)>0) bookmark_present,(detail IS NULL) detail_absent FROM upgrade_runs WHERE id>" + integer(afterId, "upgrade_baseline_invalid") + " ORDER BY id";
}

function validateEventAndBatch(eventRows, batchRows, baseline, post, contract) {
  if (!Array.isArray(eventRows) || eventRows.length !== 1 || !Array.isArray(batchRows) || batchRows.length !== 1) {
    refusal("single_residue_event_and_batch_required");
  }
  const event = eventRows[0];
  const eventId = integer(event.id, "residue_event_invalid");
  const epochBefore = integer(event.epoch_before, "residue_event_invalid");
  const epochAfter = integer(event.epoch_after, "residue_event_invalid");
  if (event.kind !== "residue-reprojection" || epochBefore !== baseline.epoch ||
      epochAfter !== baseline.epoch + 1 || integer(event.base_before, "residue_event_invalid") !== baseline.chunks ||
      integer(event.base_after, "residue_event_invalid") !== baseline.chunks ||
      integer(event.rows, "residue_event_invalid") !== contract.triggerRows ||
      integer(event.chunks, "residue_event_invalid") !== baseline.chunks + contract.triggerRows ||
      post.event_count !== baseline.event_count + 1 || post.event_max_id !== eventId ||
      post.epoch !== epochAfter + 1 || post.residue_epoch !== epochAfter) refusal("residue_event_invalid");
  const batch = batchRows[0];
  const pageCount = Math.ceil(contract.triggerRows / contract.pageSize);
  const lastRows = contract.triggerRows - contract.pageSize * (pageCount - 1);
  if (integer(batch.batches, "residue_batch_invalid") !== pageCount ||
      integer(batch.confirmed, "residue_batch_invalid") !== pageCount ||
      integer(batch.unfinished, "residue_batch_invalid") !== 0 ||
      integer(batch.rows, "residue_batch_invalid") !== contract.triggerRows ||
      integer(batch.first_batch, "residue_batch_invalid") !== 1 ||
      integer(batch.last_batch, "residue_batch_invalid") !== pageCount ||
      integer(batch.bad_full_pages, "residue_batch_invalid") !== 0 ||
      integer(batch.last_rows, "residue_batch_invalid") !== lastRows) refusal("residue_batch_invalid");
  return Object.freeze({ id: eventId, epoch: epochAfter, rows: contract.triggerRows, batches: pageCount });
}

function validateMigrationLedger(rows, migrations) {
  if (!Array.isArray(rows) || rows.length !== migrations.length) refusal("migration_ledger_mismatch");
  for (let index = 0; index < migrations.length; index += 1) {
    const actual = rows[index];
    const expected = migrations[index];
    if (integer(actual?.version, "migration_ledger_mismatch") !== expected.version ||
        actual?.name !== expected.name || actual?.checksum !== expected.checksum) refusal("migration_ledger_mismatch");
  }
  return true;
}

function validateUpgradeProof(summary, rows, baseline, binding) {
  if (summary.total !== baseline.total + 1 || summary.max_id <= baseline.max_id ||
      !Array.isArray(rows) || rows.length !== 1) refusal("single_verified_upgrade_run_required");
  const row = rows[0];
  if (integer(row.id, "verified_upgrade_run_invalid") !== summary.max_id ||
      row.from_version !== binding.fromVersion || row.to_version !== binding.toVersion ||
      row.status !== "verified" || integer(row.started_present, "verified_upgrade_run_invalid") !== 1 ||
      integer(row.finished_present, "verified_upgrade_run_invalid") !== 1 ||
      integer(row.bookmark_present, "verified_upgrade_run_invalid") !== 1 ||
      integer(row.detail_absent, "verified_upgrade_run_invalid") !== 1) refusal("verified_upgrade_run_invalid");
  return true;
}

function validatePostUpdateSnapshot(snapshot, vector, baseline, binding, contract) {
  const expectedBatches = Math.ceil(contract.triggerRows / contract.pageSize);
  if (snapshot.install_rows !== 1 || snapshot.client_slug !== binding.slug ||
      snapshot.product_version !== binding.toVersion ||
      snapshot.schema_version !== contract.terminalSchema || snapshot.status !== "verified" ||
      snapshot.protocol !== "bootstrap-v2" || snapshot.documents !== baseline.documents + contract.triggerRows ||
      snapshot.chunks !== baseline.chunks + contract.triggerRows || snapshot.base_count !== snapshot.chunks ||
      snapshot.outbox !== 0 || snapshot.batches !== expectedBatches || snapshot.unfinished_batches !== 0 ||
      snapshot.retry_rows !== 0 ||
      snapshot.bad_upgrade_runs !== 0 || snapshot.lease_present !== 0 ||
      vector.vectorCount !== snapshot.chunks || vector.dimensions !== 768 || vector.metric !== "cosine") {
    refusal("post_update_projection_invalid");
  }
  return true;
}

function validateFinalCanarySnapshot(snapshot, vector, post, binding) {
  if (snapshot.install_rows !== 1 || snapshot.client_slug !== binding.slug ||
      snapshot.product_version !== post.product_version ||
      snapshot.schema_version !== post.schema_version ||
      snapshot.status !== "verified" || snapshot.protocol !== "bootstrap-v2" ||
      snapshot.epoch !== post.epoch || snapshot.residue_epoch !== post.residue_epoch ||
      snapshot.documents !== post.documents + 1 || snapshot.chunks !== post.chunks + 1 ||
      snapshot.base_count !== snapshot.chunks || snapshot.outbox !== 0 || snapshot.batches !== post.batches ||
      snapshot.unfinished_batches !== 0 ||
      snapshot.retry_rows !== 0 || snapshot.bad_upgrade_runs !== 0 || snapshot.lease_present !== 0 ||
      snapshot.event_count !== post.event_count || snapshot.event_max_id !== post.event_max_id ||
      vector.vectorCount !== snapshot.chunks || vector.dimensions !== 768 || vector.metric !== "cosine") {
    refusal("post_update_canary_projection_invalid");
  }
  return true;
}

async function readInstalledAdminKey(runtime, binding, dependencies) {
  if (dependencies.readAdminKey) return dependencies.readAdminKey(binding.adminLocator, runtime.environment);
  const modulePath = join(runtime.packageRoot, "operations", "admin-key-persistence.mjs");
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.readAdminKeyFromKeychain !== "function") refusal("installed_admin_key_reader_invalid");
  const value = module.readAdminKeyFromKeychain(binding.adminLocator, { environment: runtime.environment });
  if (typeof value !== "string" || !value) refusal("declared_admin_key_missing");
  return value;
}

function cacheIsNoStore(headers) {
  return /(?:^|,)\s*(?:private\s*,\s*)?no-store(?:\s*,|$)/i.test(String(headers?.get?.("cache-control") || ""));
}

async function runCanary(active, adminKey, post, revalidate, dependencies, progress) {
  const nonce = (dependencies.randomHex || ((bytes) => randomBytes(bytes).toString("hex")))(12);
  if (!/^[a-f0-9]{24}$/.test(nonce)) refusal("canary_nonce_invalid");
  const source = "accelerated_field_gate";
  const sourceId = `canary-${nonce}`;
  const title = `Synthetic canary ${nonce}`;
  const query = `synthetic canary ${nonce}`;
  const document = {
    source_type: source,
    source_id: sourceId,
    title,
    content: `${query}. This fictional field-gate record contains no credential or customer information.`,
    metadata: { platform: "synthetic", category: "accelerated_update_field_gate" },
  };
  progress.ingest_calls += 1;
  const ingest = await providerCall(revalidate, () => active.ingest(adminKey, [document]));
  const body = ingest?.body;
  if (ingest?.status !== 200 || body?.total !== 1 || body?.created !== 1 || body?.updated !== 0 ||
      body?.unchanged !== 0 || body?.refused !== 0 || body?.failed !== 0 ||
      !Array.isArray(body?.results) || body.results.length !== 1 ||
      body.results[0]?.status !== "created" || body.results[0]?.chunks !== 1) refusal("canary_ingest_invalid");

  let drainCalls = 0;
  let drained = 0;
  let remaining = null;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    progress.drain_calls += 1;
    const receipt = await providerCall(revalidate, () => active.drain(adminKey));
    drainCalls += 1;
    const drain = receipt?.body;
    if (receipt?.status !== 200 || drain?.busy === true || drain?.paused === true || drain?.error ||
        integer(drain?.failed ?? 0, "canary_drain_invalid") !== 0 ||
        integer(drain?.quarantined ?? 0, "canary_drain_invalid") !== 0) refusal("canary_drain_invalid");
    drained += integer(drain.drained ?? 0, "canary_drain_invalid");
    remaining = integer(drain.remaining, "canary_drain_invalid");
    if (remaining === 0) {
      if (drain.vector_ready !== true || integer(drain.actual_vectors, "canary_drain_invalid") !==
          integer(drain.expected_vectors, "canary_drain_invalid")) refusal("canary_drain_invalid");
      break;
    }
    if (attempt < 12) await (dependencies.wait || ((ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms))))(2_000);
  }
  if (remaining !== 0) refusal("canary_drain_did_not_converge");
  progress.retrieval_calls += 1;
  const search = await providerCall(revalidate, () => active.unified(adminKey, {
    q: query, source, limit: 10, rerank: 0,
  }));
  if (search?.status !== 200 || !cacheIsNoStore(search.headers) || search.body?.degraded !== null ||
      !Array.isArray(search.body?.results) || !search.body.results.some((row) => row?.title === title)) {
    refusal("canary_retrieval_invalid");
  }
  return Object.freeze({ created: 1, chunks: 1, drain_calls: drainCalls, drained, remaining: 0, retrieved: true });
}

function invokeInstalledUpdate(runtime, manifestPath, dependencies) {
  const spawn = dependencies.updateSpawn || spawnSync;
  const child = spawn(runtime.cliPath, ["update", manifestPath], {
    cwd: runtime.runtimeRoot,
    encoding: null,
    env: runtime.environment,
    input: Buffer.alloc(0),
    shell: false,
    timeout: 90 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  try {
    if (!childSucceeded(child)) {
      if (child?.error?.code === "ETIMEDOUT") refusal("brain_update_timed_out");
      refusal("brain_update_failed");
    }
    const outputs = [child.stdout, child.stderr].filter((value) => value !== null && value !== undefined);
    if (outputs.some((value) => !Buffer.isBuffer(value))) refusal("brain_update_output_invalid");
    const contains = (needle) => outputs.some((value) => value.includes(needle));
    if (contains(Buffer.from("quiescence was NOT verified")) ||
        contains(Buffer.from("quiescence NOT verified before"))) {
      refusal("update_writer_quiescence_unverified");
    }
    if (!contains(Buffer.from("older database writers have finished; starting database migration"))) {
      refusal("update_writer_quiescence_proof_missing");
    }
    return true;
  } finally {
    if (Buffer.isBuffer(child?.stdout)) child.stdout.fill(0);
    if (Buffer.isBuffer(child?.stderr)) child.stderr.fill(0);
  }
}

function elapsedMilliseconds(start, end) {
  const value = Number(end) - Number(start);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function validateUpdatedManifest(path, original, candidateVersion) {
  const updated = parseStablePrivateJson(path, "updated_manifest_refused");
  const expected = structuredClone(original);
  expected.brain = { ...expected.brain, version: candidateVersion };
  if (canonical(updated.value) !== canonical(expected)) refusal("manifest_changed_beyond_exact_version");
  return updated;
}

function executionInProgressReceipt({ now, planReceipt, field, runtime, cleanupOwner }) {
  return Object.freeze({
    schema_version: 2,
    gate: GATE,
    status: "execution_in_progress_or_interrupted_target_requires_review",
    reserved_at: now,
    plan_fingerprint: planReceipt.plan_fingerprint,
    data_class: "fictional_synthetic_only",
    mutation_state: "unknown_if_process_interrupted",
    candidate: Object.freeze({
      git_sha: field.candidate.commit,
      package_version: field.candidate.version,
      package_sha256: field.candidate.archiveSha256,
      d1_schema_version: runtime.contract.terminalSchema,
      residue_trigger_rows: runtime.contract.triggerRows,
    }),
    safeguards: Object.freeze({
      exact_receipt_inode_reserved_before_provider_or_update: true,
      resources_created_by_harness: false,
      resources_deleted_by_harness: false,
      target_identifiers_recorded: false,
      receipt_paths_recorded: false,
      credential_values_recorded: false,
      customer_data_read: false,
    }),
    cleanup: Object.freeze({
      required: true,
      owner: cleanupOwner,
      verified: false,
      target_must_be_preserved_for_review: true,
    }),
    proof_boundary: "If this marker remains, execution did not durably record a final outcome. Treat the synthetic target as possibly updated or paused and do not rerun it.",
  });
}

function successReceipt({ now, planReceipt, field, runtime, baseline, post, final, event, canary, upgrade, cleanupOwner, timings }) {
  return Object.freeze({
    schema_version: 2,
    gate: GATE,
    status: "passed_cleanup_required",
    executed_at: now,
    plan_fingerprint: planReceipt.plan_fingerprint,
    data_class: "fictional_synthetic_only",
    failure_code: null,
    timings,
    mutations: Object.freeze({
      externally_supervised_seed_performed_by_harness: false,
      installed_brain_update_invocations: 1,
      direct_residue_bootstrap_calls: 0,
      direct_residue_drain_calls: 0,
      post_update_canary_ingest_calls: 1,
      post_update_canary_drain_calls: canary.drain_calls,
      post_update_canary_retrieval_calls: 1,
    }),
    candidate: Object.freeze({
      git_sha: field.candidate.commit,
      package_version: field.candidate.version,
      package_sha256: field.candidate.archiveSha256,
      package_bytes: field.candidate.archiveBytes,
      package_file_count: field.candidate.fileCount,
      d1_schema_version: runtime.contract.terminalSchema,
      residue_schema_version: runtime.contract.residueSchema,
      residue_trigger_rows: runtime.contract.triggerRows,
      bootstrap_page_size: runtime.contract.pageSize,
      bootstrap_window: runtime.contract.window,
    }),
    lifecycle: Object.freeze({
      entrypoint: "installed brain update",
      invocation_count: 1,
      initial_version: baseline.product_version,
      final_version: final.product_version,
      paused_residue_event_count: 1,
      residue_rows: event.rows,
      residue_batches: event.batches,
      event_epoch_advanced_once: true,
      final_epoch_advanced_for_verification: true,
      residue_history_marker_retained: true,
      migration_count: runtime.contract.migrations.length,
      migration_max_version: runtime.contract.terminalSchema,
      migration_ledger_matches: true,
      verified_upgrade_runs_added: upgrade.total - planReceipt.baseline.upgrade_total,
    }),
    projection: Object.freeze({
      baseline_documents: baseline.documents,
      baseline_chunks: baseline.chunks,
      seeded_documents: runtime.contract.triggerRows,
      seeded_chunks: runtime.contract.triggerRows,
      post_update_documents: post.documents,
      post_update_chunks: post.chunks,
      post_canary_documents: final.documents,
      post_canary_chunks: final.chunks,
      post_update_outbox: post.outbox,
      final_outbox: final.outbox,
      final_unfinished_batches: final.unfinished_batches,
      final_retry_rows: final.retry_rows,
      d1_vectorize_parity: true,
    }),
    canary,
    control: Object.freeze({
      workers_dev_only: true,
      routes: 0,
      custom_domains: 0,
      declared_schedules_restored: 1,
      active_candidate_health: true,
      active_worker_changed: true,
    }),
    safeguards: Object.freeze({
      exact_field_prepare_artifact_consumed: true,
      installed_cli_executed: true,
      receipt_reserved_before_provider_or_update: true,
      receipt_finalized_via_private_atomic_replace: true,
      writer_quiescence_proven_by_installed_cli: true,
      named_oauth_profile_and_account_bound: true,
      ambient_provider_credentials_refused: true,
      ordinary_manifests_refused: true,
      resources_created_by_harness: false,
      resources_deleted_by_harness: false,
      update_retried_by_harness: false,
      credential_values_recorded: false,
      target_identifiers_recorded: false,
      receipt_paths_recorded: false,
      raw_provider_json_recorded: false,
      raw_child_transcript_recorded: false,
      customer_data_read: false,
    }),
    cleanup: Object.freeze({
      required: true,
      owner: cleanupOwner,
      verified: false,
      resources_retained: Object.freeze(["worker", "d1", "vectorize"]),
    }),
    proof_boundary: "This proves one dedicated synthetic target traversed the installed brain update residue path. It does not prove cleanup, customer data, connectors, or a permanent hostname.",
  });
}

function failureReceipt({ now, planReceipt, field, runtime, cleanupOwner, error, updateStarted, timings, canaryProgress }) {
  return Object.freeze({
    schema_version: 2,
    gate: GATE,
    status: updateStarted ? "failed_target_requires_review" : "refused_before_update",
    executed_at: now,
    plan_fingerprint: planReceipt.plan_fingerprint,
    data_class: "fictional_synthetic_only",
    failure_code: safeFailureCode(error),
    timings,
    mutations: Object.freeze({
      externally_supervised_seed_performed_by_harness: false,
      installed_brain_update_invocations: updateStarted ? 1 : 0,
      direct_residue_bootstrap_calls: 0,
      direct_residue_drain_calls: 0,
      post_update_canary_ingest_calls: canaryProgress.ingest_calls,
      post_update_canary_drain_calls: canaryProgress.drain_calls,
      post_update_canary_retrieval_calls: canaryProgress.retrieval_calls,
    }),
    candidate: Object.freeze({
      git_sha: field.candidate.commit,
      package_version: field.candidate.version,
      package_sha256: field.candidate.archiveSha256,
      d1_schema_version: runtime.contract.terminalSchema,
      residue_trigger_rows: runtime.contract.triggerRows,
    }),
    lifecycle: Object.freeze({
      entrypoint: "installed brain update",
      invocation_count: updateStarted ? 1 : 0,
      durable_completion_verified: false,
    }),
    safeguards: Object.freeze({
      receipt_reserved_before_provider_or_update: true,
      resources_created_by_harness: false,
      resources_deleted_by_harness: false,
      update_retried_by_harness: false,
      credential_values_recorded: false,
      target_identifiers_recorded: false,
      receipt_paths_recorded: false,
      raw_provider_json_recorded: false,
      raw_child_transcript_recorded: false,
      customer_data_read: false,
    }),
    cleanup: Object.freeze({
      required: true,
      owner: cleanupOwner,
      verified: false,
      target_must_be_preserved_for_review: true,
    }),
    proof_boundary: updateStarted
      ? "The target may remain paused or partially updated. Do not rerun, drain, repair, or remove it until the failure is reviewed."
      : "The update entrypoint was not invoked. The externally seeded synthetic target is retained for review and must not be reused without a new plan.",
  });
}

function abandonExecutionLock(lock) {
  if (!lock) return;
  try { closeSync(lock.descriptor); } catch { /* Keep the durable lock path. */ }
}

export async function executeAcceleratedUpdateFieldGate(options, dependencies = {}) {
  if (options?.mode !== "execute") refusal("execute_options_required");
  const monotonicNow = dependencies.monotonicNow || (() => performance.now());
  const executionStarted = monotonicNow();
  const local = await prepareLocalContext(options, dependencies, "execute");
  let lock = null;
  let receiptReservation = null;
  let receiptFinalized = false;
  let lockReleaseAttempted = false;
  let updateDuration = null;
  let canaryDuration = null;
  const canaryProgress = { ingest_calls: 0, drain_calls: 0, retrieval_calls: 0 };
  try {
    const planPin = parseStablePrivateJson(options.planReceiptPath, "plan_receipt_refused");
    const seedPin = parseStablePrivateJson(options.seedReceiptPath, "seed_receipt_refused");
    validatePlanReceipt(planPin.value, local.field, local.runtime, local.manifestPin, local.binding, options);
    validateSyntheticSeedReceipt(seedPin.value, planPin.value, local.runtime.contract);
    if (options.approvePlan !== planPin.value.plan_fingerprint) refusal("exact_plan_approval_required");
    const planned = baselineFromPlan(planPin.value, local.binding);
    const stablePins = [local.field.packagePin, local.field.receiptPin, planPin, seedPin];
    let updatedManifestPin = null;
    let updateStarted = false;
    const revalidate = () => {
      for (const pin of stablePins) assertFilePin(pin, "execution_local_binding_changed");
      if (updatedManifestPin) assertFilePin(updatedManifestPin, "updated_manifest_changed");
      else assertFilePin(local.manifestPin, "synthetic_manifest_changed");
      return true;
    };
    const marker = executionInProgressReceipt({
      now: (dependencies.now || (() => new Date().toISOString()))(),
      planReceipt: planPin.value,
      field: local.field,
      runtime: local.runtime,
      cleanupOwner: options.cleanupOwner,
    });
    receiptReservation = (dependencies.reserveReceipt || reserveAggregateReceipt)(local.finalOutput, marker);
    let resultReceipt;
    try {
      lock = (dependencies.acquireLock || acquireExecutionLock)(
        local.finalOutput.parent,
        planPin.value.plan_fingerprint,
        receiptReservation.path,
      );
      const provider = await openProvider(local.runtime, local.binding, revalidate, dependencies);
      const evidence = await providerCall(revalidate, () => provider.withSession(async (active) => {
        const beforeControl = await providerCall(revalidate, () =>
          active.inspectControl(local.binding.fromVersion));
        const beforeControlProof = validateControlSnapshot(beforeControl, local.binding, { expectedSchedules: [] });
        validateCleanBaseline(planned.snapshot, planned.upgrade, beforeControl.vectorInfo, local.binding, local.runtime.contract);
        const material = planMaterial(
          options, local.field, local.runtime, local.manifestPin, local.binding,
          planned.snapshot, planned.upgrade, beforeControlProof.isolationFingerprint,
        );
        if (fingerprint(material) !== planPin.value.plan_fingerprint || options.approvePlan !== fingerprint(material)) {
          refusal("live_plan_binding_changed");
        }
        const health = await providerCall(revalidate, () => active.health());
        validateHealthReceipt(health, local.binding.fromVersion, "active");
        const seeded = normalizeSnapshot(await providerCall(revalidate, () => singleD1Row(active, BASELINE_SQL, "seeded_snapshot_required")));
        const residue = normalizeResidueShape(await providerCall(revalidate, () => singleD1Row(active, RESIDUE_SHAPE_SQL, "seeded_residue_required")));
        const seededVector = await providerCall(revalidate, () => active.vectorInfo());
        const seededUpgrade = normalizeUpgradeSummary(await providerCall(revalidate, () => singleD1Row(active, UPGRADE_SUMMARY_SQL, "seeded_upgrade_summary_required")));
        if (canonical(seededUpgrade) !== canonical(planned.upgrade)) refusal("upgrade_history_changed_before_update");
        validateSeededState(seeded, residue, seededVector, planned.snapshot, local.binding, local.runtime.contract);

        const immediateControl = await providerCall(revalidate, () =>
          active.inspectControl(local.binding.fromVersion));
        const immediateControlProof = validateControlSnapshot(immediateControl, local.binding, {
          expectedSchedules: [],
        });
        if (immediateControlProof.isolationFingerprint !== beforeControlProof.isolationFingerprint ||
            immediateControlProof.vectorCount !== seededVector.vectorCount) {
          refusal("target_changed_immediately_before_update");
        }

        revalidate();
        updateStarted = true;
        const updateStartedAt = monotonicNow();
        try { invokeInstalledUpdate(local.runtime, options.manifestPath, dependencies); }
        finally { updateDuration = elapsedMilliseconds(updateStartedAt, monotonicNow()); }
        updatedManifestPin = validateUpdatedManifest(options.manifestPath, local.manifestPin.value, local.binding.toVersion);
        revalidate();

        const postControl = await providerCall(revalidate, () =>
          active.inspectControl(local.binding.toVersion));
        const postControlProof = validateControlSnapshot(postControl, local.binding, {
          expectedSchedules: [local.binding.cron], previous: beforeControl,
        });
        const postHealth = await providerCall(revalidate, () => active.health());
        validateHealthReceipt(postHealth, local.binding.toVersion, "active");
        const post = normalizeSnapshot(await providerCall(revalidate, () => singleD1Row(active, BASELINE_SQL, "post_update_snapshot_required")));
        const postVector = await providerCall(revalidate, () => active.vectorInfo());
        validatePostUpdateSnapshot(post, postVector, planned.snapshot, local.binding, local.runtime.contract);
        const events = await providerCall(revalidate, () => active.d1Rows(eventSql(planned.snapshot.event_max_id)));
        if (!Array.isArray(events) || events.length !== 1) refusal("single_residue_event_required");
        const eventEpoch = integer(events[0]?.epoch_after, "residue_event_invalid");
        const batches = await providerCall(revalidate, () => active.d1Rows(batchSql(eventEpoch, local.runtime.contract)));
        const event = validateEventAndBatch(events, batches, planned.snapshot, post, local.runtime.contract);
        const migrations = await providerCall(revalidate, () => active.d1Rows(MIGRATION_LEDGER_SQL));
        validateMigrationLedger(migrations, local.runtime.contract.migrations);
        const upgrade = normalizeUpgradeSummary(await providerCall(revalidate, () => singleD1Row(active, UPGRADE_SUMMARY_SQL, "post_upgrade_summary_required")));
        const upgradeRows = await providerCall(revalidate, () => active.d1Rows(upgradeRowsSql(planned.upgrade.max_id)));
        validateUpgradeProof(upgrade, upgradeRows, planned.upgrade, local.binding);

        const canaryStartedAt = monotonicNow();
        let adminKey = await readInstalledAdminKey(local.runtime, local.binding, dependencies);
        let canary;
        try { canary = await runCanary(active, adminKey, post, revalidate, dependencies, canaryProgress); }
        finally {
          adminKey = null;
          canaryDuration = elapsedMilliseconds(canaryStartedAt, monotonicNow());
        }
        const final = normalizeSnapshot(await providerCall(revalidate, () => singleD1Row(active, BASELINE_SQL, "final_canary_snapshot_required")));
        const finalVector = await providerCall(revalidate, () => active.vectorInfo());
        validateFinalCanarySnapshot(final, finalVector, post, local.binding);
        const finalControl = await providerCall(revalidate, () =>
          active.inspectControl(local.binding.toVersion));
        const finalControlProof = validateControlSnapshot(finalControl, local.binding, {
          expectedSchedules: [local.binding.cron],
        });
        if (finalControl.activeVersionId !== postControl.activeVersionId ||
            finalControl.scriptEtag !== postControl.scriptEtag ||
            finalControlProof.isolationFingerprint !== postControlProof.isolationFingerprint) {
          refusal("active_worker_changed_after_update_proof");
        }
        const finalHealth = await providerCall(revalidate, () => active.health());
        validateHealthReceipt(finalHealth, local.binding.toVersion, "active");
        return Object.freeze({ baseline: planned.snapshot, post, final, event, canary, upgrade });
      }));
      resultReceipt = successReceipt({
        now: (dependencies.now || (() => new Date().toISOString()))(),
        planReceipt: planPin.value,
        field: local.field,
        runtime: local.runtime,
        ...evidence,
        cleanupOwner: options.cleanupOwner,
        timings: Object.freeze({
          total_ms: elapsedMilliseconds(executionStarted, monotonicNow()),
          update_ms: updateDuration,
          canary_ms: canaryDuration,
        }),
      });
    } catch (error) {
      resultReceipt = failureReceipt({
        now: (dependencies.now || (() => new Date().toISOString()))(),
        planReceipt: planPin.value,
        field: local.field,
        runtime: local.runtime,
        cleanupOwner: options.cleanupOwner,
        error,
        updateStarted,
        timings: Object.freeze({
          total_ms: elapsedMilliseconds(executionStarted, monotonicNow()),
          update_ms: updateDuration,
          canary_ms: canaryDuration,
        }),
        canaryProgress,
      });
    }
    (dependencies.finalizeReceipt || finalizeReservedAggregateReceipt)(receiptReservation, resultReceipt);
    receiptFinalized = true;
    if (lock) {
      lockReleaseAttempted = true;
      (dependencies.releaseLock || releaseExecutionLock)(lock);
      lock = null;
    }
    return resultReceipt;
  } finally {
    abandonReceiptReservation(receiptReservation);
    if (lock) {
      if (receiptFinalized && !lockReleaseAttempted) (dependencies.releaseLock || releaseExecutionLock)(lock);
      else abandonExecutionLock(lock);
    }
    (dependencies.removeCandidateRuntime || removeCandidateRuntime)(local.runtime);
  }
}

export async function runAcceleratedUpdateFieldGate(options, dependencies = {}) {
  if (options?.mode === "prepare") return prepareAcceleratedUpdateFieldGate(options, dependencies);
  if (options?.mode === "execute") return executeAcceleratedUpdateFieldGate(options, dependencies);
  refusal("field_gate_phase_required");
}

function help() {
  return `Usage:
  node test/live/accelerated-update-field-gate.mjs --plan

  node test/live/accelerated-update-field-gate.mjs --prepare \\
    --manifest /private/path/brain.manifest.json \\
    --package /private/field-prepare/brain-installer-x.y.z.tgz \\
    --field-receipt /private/field-prepare/field-prepare-receipt.json \\
    --target-account <exact-account-id> \\
    --target-worker <exact-worker-name> \\
    --target-d1 <exact-d1-uuid> \\
    --target-vector-index <exact-index-name> \\
    --target-domain <exact-workers.dev-hostname> \\
    --cleanup-owner "Field gate operator" \\
    --plan-receipt /private/proof/plan.json \\
    --seed-receipt /private/proof/seed.json \\
    --receipt /private/proof/result.json

  node test/live/accelerated-update-field-gate.mjs --execute \\
    <the same exact path and target options> \\
    --confirm ${EXECUTION_CONFIRMATION} \\
    --approve-plan <exact-plan-fingerprint>

Prepare is read-only and requires a dedicated synthetic predecessor with zero
routes, custom domains, schedules, residue, and historical projection events.
It writes the aggregate seed contract and approval fingerprint. Seeding is an
external supervised action. Execute revalidates that exact 1001-or-derived-row
state and invokes only the installed candidate's brain update entrypoint once.
  The harness never provisions, deletes, cleans up, directly bootstraps or drains
  residue, or retries the update. Its post-update canary may make up to 12 bounded
  direct drain calls, and the aggregate receipt records the exact call count.`;
}

const IS_MAIN = (() => {
  try { return resolve(process.argv[1] || "") === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (IS_MAIN) {
  try {
    const options = parseAcceleratedUpdateArgs(process.argv.slice(2));
    if (options.mode === "help") console.log(help());
    else if (options.mode === "plan") console.log(JSON.stringify(acceleratedUpdatePlan(), null, 2));
    else {
      const receipt = await runAcceleratedUpdateFieldGate(options);
      const output = {
        status: receipt.status,
        receipt_written: true,
        cleanup_required: true,
        ...(receipt.status === PLAN_STATUS
          ? {
            plan_fingerprint: receipt.plan_fingerprint,
            seed_receipt_template: syntheticSeedReceipt(receipt),
          }
          : {}),
      };
      console.log(JSON.stringify(output, null, 2));
      if (![PLAN_STATUS, "passed_cleanup_required"].includes(receipt.status)) process.exitCode = 1;
    }
  } catch (error) {
    console.error(`Accelerated update field gate refused: ${safeFailureCode(error)}`);
    process.exitCode = 1;
  }
}
