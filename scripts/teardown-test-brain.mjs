#!/usr/bin/env node
/**
 * Preview the three resources for one disposable test Brain.
 *
 * This coordinator never reads a Cloudflare credential. Provider work runs in
 * an exact owner-only Keychain wrapper whose fixed program retrieves the token
 * only after the coordinator has removed every ambient credential from the
 * child environment. The child returns a closed aggregate receipt; raw
 * Cloudflare bodies and errors never cross that boundary.
 *
 * A preview is durably saved in a new owner-only receipt and binds opaque
 * hashes for the exact account, resource instances, wrapper, and provider
 * program. Commit is intentionally disabled: Cloudflare's name-addressed
 * Worker and Vectorize deletes do not offer a generation fence, and a same-user
 * caller can forge a child nonce. No path in this file can issue DELETE.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROVIDER_SNAPSHOT_ARG = "--provider-snapshot-child";
const IS_PROVIDER_SNAPSHOT_PROCESS = process.argv[1] === PROVIDER_SNAPSHOT_ARG;
const privateReceipt = IS_PROVIDER_SNAPSHOT_PROCESS ? null : await import(
  "../operations/private-aggregate-receipt.mjs"
);
const {
  abandonPrivateAggregateReceipt,
  assertNoDarwinReceiptAcl,
  assertPrivateAggregateOutputPath,
  finalizePrivateAggregateReceipt,
  reservePrivateAggregateReceipt,
} = privateReceipt || {};

const API_ORIGIN = "https://api.cloudflare.com";
const API_PREFIX = "/client/v4";
const PROVIDER_CONTRACT_VERSION = 2;
const RECEIPT_CONTRACT_VERSION = 2;
const MAX_PROVIDER_BYTES = 1024 * 1024;
const MAX_PROVIDER_PROGRAM_BYTES = 64 * 1024;
const MAX_WRAPPER_BYTES = 64 * 1024;
const MAX_WORKER_PAGES = 100;
const WORKER_PAGE_SIZE = 100;
const MAX_D1_PAGES = 100;
const D1_PAGE_SIZE = 100;
const CHILD_TIMEOUT_MS = 120_000;
const NAME_RE = /^brain-test(?:-[a-z0-9](?:[a-z0-9-]{0,125}[a-z0-9])?)?$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/u;
const WORKER_ID_RE = /^[a-f0-9]{32}$/u;
const D1_ID_RE = /^[a-f0-9-]{16,64}$/u;
const CHILD_NONCE_RE = /^[a-f0-9]{64}$/u;
const CLOSED_RESOURCE_STATES = new Set(["present", "absent"]);
const TOKEN_ENV_NAME = ["CLOUDFLARE", "API", "TOKEN"].join("_");
const ACCOUNT_ENV_NAME = ["CLOUDFLARE", "ACCOUNT", "ID"].join("_");
const WRAPPER_PROVIDER_DIGEST_LINE =
  'BRAIN_TEARDOWN_PROVIDER_ACTUAL_SHA="$(printf \'%s\' "${BRAIN_TEARDOWN_PROVIDER_SOURCE:?}" | /usr/bin/shasum -a 256)" || exit 126';
const WRAPPER_PROVIDER_PIN_RE =
  /^\[ "\$\{BRAIN_TEARDOWN_PROVIDER_ACTUAL_SHA%% \*\}" = '([a-f0-9]{64})' \] \|\| exit 126$/u;
const WRAPPER_EXEC_LINE =
  'exec "${BRAIN_TEARDOWN_NODE:?}" --input-type=module --eval "${BRAIN_TEARDOWN_PROVIDER_SOURCE:?}" -- --provider-snapshot-child "$@"';
const WRAPPER_TOKEN_LINE_RE =
  /^CLOUDFLARE_API_TOKEN="\$\(\/usr\/bin\/security find-generic-password -a '[A-Za-z0-9._:@/-]{1,128}' -s '[A-Za-z0-9._:@/-]{1,128}' -w\)" \|\| exit 125$/u;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");

export class TeardownSafetyError extends Error {
  constructor(code) {
    super(code);
    this.name = "TeardownSafetyError";
    this.code = code;
  }
}

function refuse(code) {
  throw new TeardownSafetyError(code);
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

function exactKeys(value, keys) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function sameFile(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino &&
    left?.size === right?.size && left?.mtimeMs === right?.mtimeMs &&
    left?.ctimeMs === right?.ctimeMs;
}

function currentUidOwns(info) {
  return typeof process.getuid !== "function" || info.uid === process.getuid();
}

function within(root, path) {
  return path === root || path.startsWith(`${root}/`);
}

function cleanName(value) {
  if (typeof value !== "string" || !NAME_RE.test(value)) {
    refuse("TEARDOWN_NAME_REFUSED");
  }
  return value;
}

/** Only an exact, lower-case brain-test prefix can enter the preview path. */
export function looksDisposable(name) {
  return typeof name === "string" && NAME_RE.test(name);
}

export function protectedList(raw) {
  if (typeof raw !== "string") return Object.freeze([]);
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.some((value) => !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(value))) {
    refuse("TEARDOWN_PROTECTED_LOCK_INVALID");
  }
  return Object.freeze([...new Set(values)].sort());
}

/** The second lock is mandatory, nonempty, and never echoed. */
export function protectedListMissing(raw) {
  try { return protectedList(String(raw ?? "")).length === 0; }
  catch { return true; }
}

/** Return only a closed reason code, never the protected prefix that matched. */
export function teardownDecision(name, {
  protectedPrefixes = [],
  protectedRaw = null,
} = {}) {
  if (typeof name !== "string" || name.length === 0) {
    return Object.freeze({ allowed: false, reason: "name_missing" });
  }
  if (!looksDisposable(name)) {
    return Object.freeze({ allowed: false, reason: "name_not_brain_test" });
  }
  let prefixes;
  try {
    prefixes = protectedRaw === null
      ? Object.freeze([...protectedPrefixes])
      : protectedList(protectedRaw);
  } catch {
    return Object.freeze({ allowed: false, reason: "protected_lock_invalid" });
  }
  if (prefixes.length === 0) {
    return Object.freeze({ allowed: false, reason: "protected_lock_missing" });
  }
  const hit = prefixes.some((prefix) =>
    prefix instanceof RegExp ? prefix.test(name) : name.startsWith(prefix));
  if (hit) return Object.freeze({ allowed: false, reason: "protected_match" });
  return Object.freeze({ allowed: true, reason: "allowed" });
}

/** Validate the only accepted Keychain wrapper program without executing it. */
export function validateTeardownWrapperProgram(raw) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ""), "utf8");
  try {
    if (bytes.length < 1 || bytes.length > MAX_WRAPPER_BYTES) {
      refuse("TEARDOWN_WRAPPER_UNSAFE");
    }
    const text = bytes.toString("utf8");
    if (Buffer.byteLength(text, "utf8") !== bytes.length) {
      refuse("TEARDOWN_WRAPPER_UNSAFE");
    }
    const lines = text.split("\n");
    if (lines.length !== 9 || lines[8] !== "" ||
        lines[0] !== "#!/bin/sh" ||
        lines[1] !== WRAPPER_PROVIDER_DIGEST_LINE ||
        !WRAPPER_PROVIDER_PIN_RE.test(lines[2]) ||
        lines[3] !== "unset BRAIN_TEARDOWN_PROVIDER_ACTUAL_SHA" ||
        !WRAPPER_TOKEN_LINE_RE.test(lines[4]) ||
        lines[5] !== `[ -n "$${TOKEN_ENV_NAME}" ] || exit 125` ||
        lines[6] !== `export ${TOKEN_ENV_NAME}` ||
        lines[7] !== WRAPPER_EXEC_LINE) {
      refuse("TEARDOWN_WRAPPER_UNSAFE");
    }
    return true;
  } finally {
    if (!Buffer.isBuffer(raw)) bytes.fill(0);
  }
}

/**
 * Read one stable, private, executable wrapper. The wrapper must live outside
 * the checkout so its private Keychain locator cannot enter package evidence.
 */
export function inspectTeardownWrapper(path) {
  if (!isAbsolute(path || "")) refuse("TEARDOWN_WRAPPER_UNSAFE");
  const absolute = resolve(path);
  const parentPath = dirname(absolute);
  if (within(REPOSITORY_ROOT, absolute)) refuse("TEARDOWN_WRAPPER_UNSAFE");
  let parent;
  let before;
  let descriptor;
  let raw;
  try {
    parent = lstatSync(parentPath);
    before = lstatSync(absolute);
    if (!parent.isDirectory() || parent.isSymbolicLink() ||
        realpathSync(parentPath) !== parentPath || !currentUidOwns(parent) ||
        (process.platform !== "win32" && (parent.mode & 0o077) !== 0) ||
        !before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
        before.size < 1 || before.size > MAX_WRAPPER_BYTES ||
        realpathSync(absolute) !== absolute || !currentUidOwns(before) ||
        (process.platform !== "win32" &&
          ((before.mode & 0o077) !== 0 || (before.mode & 0o100) === 0))) {
      refuse("TEARDOWN_WRAPPER_UNSAFE");
    }
    parent = assertNoDarwinReceiptAcl(parentPath, parent, {
      code: "TEARDOWN_WRAPPER_UNSAFE",
    });
    before = assertNoDarwinReceiptAcl(absolute, before, {
      code: "TEARDOWN_WRAPPER_UNSAFE",
    });
    descriptor = openSync(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameFile(before, opened)) refuse("TEARDOWN_WRAPPER_UNSAFE");
    raw = readFileSync(descriptor);
    if (!Buffer.isBuffer(raw) || raw.length !== opened.size) {
      refuse("TEARDOWN_WRAPPER_UNSAFE");
    }
    const openedAfter = fstatSync(descriptor);
    const after = lstatSync(absolute);
    if (!sameFile(opened, openedAfter) || !sameFile(opened, after) ||
        realpathSync(absolute) !== absolute) {
      refuse("TEARDOWN_WRAPPER_UNSAFE");
    }
    validateTeardownWrapperProgram(raw);
    const program = raw.toString("utf8");
    if (!Buffer.from(program, "utf8").equals(raw)) {
      refuse("TEARDOWN_WRAPPER_UNSAFE");
    }
    const providerPin = WRAPPER_PROVIDER_PIN_RE.exec(program.split("\n")[2])?.[1];
    if (!SHA256_RE.test(providerPin || "")) refuse("TEARDOWN_WRAPPER_UNSAFE");
    return Object.freeze({
      path: absolute,
      sha256: sha256(raw),
      providerSha256: providerPin,
      program,
    });
  } catch (error) {
    if (error instanceof TeardownSafetyError) throw error;
    refuse("TEARDOWN_WRAPPER_UNSAFE");
  } finally {
    if (raw) raw.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Snapshot the exact provider module bytes that the token-bearing shell runs. */
export function inspectTeardownProviderProgram(path = SCRIPT_PATH) {
  if (!isAbsolute(path || "")) refuse("TEARDOWN_PROVIDER_PROGRAM_UNSAFE");
  const absolute = resolve(path);
  let before;
  let descriptor;
  let raw;
  try {
    before = lstatSync(absolute);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
        before.size < 1 || before.size > MAX_PROVIDER_PROGRAM_BYTES ||
        realpathSync(absolute) !== absolute || !currentUidOwns(before) ||
        (process.platform !== "win32" &&
          ((before.mode & 0o022) !== 0 || (before.mode & 0o100) === 0))) {
      refuse("TEARDOWN_PROVIDER_PROGRAM_UNSAFE");
    }
    before = assertNoDarwinReceiptAcl(absolute, before, {
      code: "TEARDOWN_PROVIDER_PROGRAM_UNSAFE",
    });
    descriptor = openSync(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameFile(before, opened)) refuse("TEARDOWN_PROVIDER_PROGRAM_UNSAFE");
    raw = readFileSync(descriptor);
    const openedAfter = fstatSync(descriptor);
    const after = lstatSync(absolute);
    if (!Buffer.isBuffer(raw) || raw.length !== opened.size ||
        !sameFile(opened, openedAfter) || !sameFile(opened, after) ||
        realpathSync(absolute) !== absolute) {
      refuse("TEARDOWN_PROVIDER_PROGRAM_UNSAFE");
    }
    const program = raw.toString("utf8");
    if (!Buffer.from(program, "utf8").equals(raw) || program.includes("\u0000")) {
      refuse("TEARDOWN_PROVIDER_PROGRAM_UNSAFE");
    }
    return Object.freeze({ path: absolute, sha256: sha256(raw), program });
  } catch (error) {
    if (error instanceof TeardownSafetyError) throw error;
    refuse("TEARDOWN_PROVIDER_PROGRAM_UNSAFE");
  } finally {
    if (raw) raw.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** The wrapper receives no ambient credential, account selector, path, or HOME. */
export function safeTeardownChildEnvironment({
  nonce,
  providerProgram,
  nodePath = process.execPath,
} = {}) {
  if (!CHILD_NONCE_RE.test(String(nonce || "")) || !isAbsolute(nodePath || "") ||
      typeof providerProgram?.program !== "string" ||
      !SHA256_RE.test(providerProgram.sha256 || "") ||
      sha256(providerProgram.program) !== providerProgram.sha256) {
    refuse("TEARDOWN_CHILD_BOUNDARY_INVALID");
  }
  return Object.freeze({
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C",
    LC_ALL: "C",
    BRAIN_TEARDOWN_NODE: nodePath,
    BRAIN_TEARDOWN_PROVIDER_SOURCE: providerProgram.program,
    BRAIN_TEARDOWN_WRAPPED_NONCE: nonce,
  });
}

function ambientCredentialPresent(env) {
  return Object.hasOwn(env || {}, TOKEN_ENV_NAME) ||
    Object.hasOwn(env || {}, ACCOUNT_ENV_NAME) ||
    Object.hasOwn(env || {}, "CF_API_TOKEN") ||
    Object.hasOwn(env || {}, "CLOUDFLARE_API_KEY") ||
    Object.hasOwn(env || {}, "CLOUDFLARE_EMAIL");
}

function stateObject(value, code = "TEARDOWN_PROVIDER_RECEIPT_INVALID") {
  if (!exactKeys(value, ["worker", "d1", "vectorize"]) ||
      Object.values(value).some((state) => !CLOSED_RESOURCE_STATES.has(state))) {
    refuse(code);
  }
  return Object.freeze({
    worker: value.worker,
    d1: value.d1,
    vectorize: value.vectorize,
  });
}

function instanceShaObject(value, states, code = "TEARDOWN_PROVIDER_RECEIPT_INVALID") {
  if (!exactKeys(value, ["account", "worker", "d1", "vectorize"]) ||
      !SHA256_RE.test(value.account || "")) {
    refuse(code);
  }
  for (const kind of ["worker", "d1", "vectorize"]) {
    const expected = states[kind] === "present" ? "hash" : "absent";
    if (expected === "hash" ? !SHA256_RE.test(value[kind] || "") : value[kind] !== null) {
      refuse(code);
    }
  }
  return Object.freeze({
    account: value.account,
    worker: value.worker,
    d1: value.d1,
    vectorize: value.vectorize,
  });
}

/** Parse the closed child contract before any value reaches a public result. */
export function validateProviderReceipt(value, {
  operation,
  targetSha256,
  nonceSha256,
  providerSha256,
} = {}) {
  const common = [
    "contract_version", "ok", "operation", "target_sha256", "nonce_sha256",
    "provider_sha256", "account_scope_exact", "instance_sha256", "before",
    "after", "deleted", "already_absent", "absence_verified",
  ];
  if (!exactKeys(value, common) || value.contract_version !== PROVIDER_CONTRACT_VERSION ||
      value.ok !== true || operation !== "preview" || value.operation !== operation ||
      value.target_sha256 !== targetSha256 || value.nonce_sha256 !== nonceSha256 ||
      value.provider_sha256 !== providerSha256 ||
      value.account_scope_exact !== true || !SHA256_RE.test(value.target_sha256) ||
      !SHA256_RE.test(value.nonce_sha256) || !SHA256_RE.test(value.provider_sha256) ||
      !Number.isSafeInteger(value.deleted) || value.deleted < 0 || value.deleted > 3 ||
      !Number.isSafeInteger(value.already_absent) || value.already_absent < 0 ||
      value.already_absent > 3 || typeof value.absence_verified !== "boolean") {
    refuse("TEARDOWN_PROVIDER_RECEIPT_INVALID");
  }
  const before = stateObject(value.before);
  const after = stateObject(value.after);
  const instanceSha256 = instanceShaObject(value.instance_sha256, before);
  if (canonical(before) !== canonical(after) || value.deleted !== 0 ||
      value.already_absent !== 0 || value.absence_verified !== false) {
    refuse("TEARDOWN_PROVIDER_RECEIPT_INVALID");
  }
  return Object.freeze({ ...value, instance_sha256: instanceSha256, before, after });
}

function parseClosedJson(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 2 || raw.length > MAX_PROVIDER_BYTES) {
    refuse("TEARDOWN_PROVIDER_RECEIPT_INVALID");
  }
  let value;
  try { value = JSON.parse(raw.toString("utf8")); }
  catch { refuse("TEARDOWN_PROVIDER_RECEIPT_INVALID"); }
  return value;
}

function defaultRunWrapper({ wrapperProgram, args, env }) {
  const input = Buffer.from(wrapperProgram, "utf8");
  try {
    return spawnSync("/bin/sh", ["-s", "--", ...args], {
      cwd: REPOSITORY_ROOT,
      env,
      encoding: null,
      input,
      maxBuffer: MAX_PROVIDER_BYTES,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: CHILD_TIMEOUT_MS,
      windowsHide: true,
    });
  } finally {
    input.fill(0);
  }
}

export function invokeTeardownWrapper({
  wrapper,
  operation,
  name,
  expectedStates = null,
  providerProgram = null,
  run = defaultRunWrapper,
  random = randomBytes,
  inspectProvider = inspectTeardownProviderProgram,
}) {
  cleanName(name);
  if (operation === "delete") refuse("TEARDOWN_COMMIT_DISABLED");
  if (!wrapper?.path || !isAbsolute(wrapper.path) ||
      typeof wrapper.program !== "string" ||
      !SHA256_RE.test(wrapper.sha256 || "") ||
      !SHA256_RE.test(wrapper.providerSha256 || "") ||
      sha256(wrapper.program) !== wrapper.sha256 || operation !== "preview" ||
      expectedStates !== null) {
    refuse("TEARDOWN_WRAPPER_UNSAFE");
  }
  validateTeardownWrapperProgram(wrapper.program);
  const provider = providerProgram || inspectProvider();
  if (!provider?.path || !isAbsolute(provider.path) ||
      typeof provider.program !== "string" ||
      !SHA256_RE.test(provider.sha256 || "") ||
      sha256(provider.program) !== provider.sha256) {
    refuse("TEARDOWN_PROVIDER_PROGRAM_UNSAFE");
  }
  if (wrapper.providerSha256 !== provider.sha256) {
    refuse("TEARDOWN_PROVIDER_PROGRAM_CHANGED");
  }
  const nonce = random(32).toString("hex");
  if (!CHILD_NONCE_RE.test(nonce)) refuse("TEARDOWN_CHILD_BOUNDARY_INVALID");
  const args = ["--operation", operation, "--name", name];
  let child;
  try {
    child = run({
      wrapperProgram: wrapper.program,
      args,
      env: safeTeardownChildEnvironment({ nonce, providerProgram: provider }),
    });
    if (child?.error || child?.signal || child?.status !== 0 ||
        !Buffer.isBuffer(child.stdout) || !Buffer.isBuffer(child.stderr) ||
        child.stderr.length !== 0) {
      refuse("TEARDOWN_PROVIDER_UNCONFIRMED");
    }
    const receipt = validateProviderReceipt(parseClosedJson(child.stdout), {
      operation,
      targetSha256: sha256(name),
      nonceSha256: sha256(nonce),
      providerSha256: provider.sha256,
    });
    return receipt;
  } catch (error) {
    if (error instanceof TeardownSafetyError) throw error;
    refuse("TEARDOWN_PROVIDER_UNCONFIRMED");
  } finally {
    if (Buffer.isBuffer(child?.stdout)) child.stdout.fill(0);
    if (Buffer.isBuffer(child?.stderr)) child.stderr.fill(0);
  }
}

function previewBinding({ name, wrapper, protectedPrefixes, provider }) {
  const base = Object.freeze({
    contract_version: RECEIPT_CONTRACT_VERSION,
    kind: "brain_test_teardown_preview",
    target_sha256: sha256(name),
    wrapper_sha256: wrapper.sha256,
    provider_sha256: provider.provider_sha256,
    protected_lock_sha256: sha256(canonical(protectedPrefixes)),
    provider_contract_version: PROVIDER_CONTRACT_VERSION,
    provider_receipt_sha256: sha256(canonical(provider)),
    resources: provider.before,
    instance_sha256: provider.instance_sha256,
  });
  return Object.freeze({
    ...base,
    approval_fingerprint: sha256(canonical(base)),
  });
}

function validatePreviewReceipt(value) {
  const keys = [
    "contract_version", "kind", "target_sha256", "wrapper_sha256",
    "provider_sha256", "protected_lock_sha256", "provider_contract_version",
    "provider_receipt_sha256", "resources", "instance_sha256",
    "approval_fingerprint",
  ];
  if (!exactKeys(value, keys) || value.contract_version !== RECEIPT_CONTRACT_VERSION ||
      value.kind !== "brain_test_teardown_preview" ||
      value.provider_contract_version !== PROVIDER_CONTRACT_VERSION ||
      ![value.target_sha256, value.wrapper_sha256, value.provider_sha256,
        value.protected_lock_sha256, value.provider_receipt_sha256,
        value.approval_fingerprint].every((hash) =>
        SHA256_RE.test(hash))) {
    refuse("TEARDOWN_PREVIEW_RECEIPT_INVALID");
  }
  const resources = stateObject(value.resources, "TEARDOWN_PREVIEW_RECEIPT_INVALID");
  const instanceSha256 = instanceShaObject(
    value.instance_sha256,
    resources,
    "TEARDOWN_PREVIEW_RECEIPT_INVALID",
  );
  const base = { ...value };
  delete base.approval_fingerprint;
  if (sha256(canonical(base)) !== value.approval_fingerprint) {
    refuse("TEARDOWN_PREVIEW_RECEIPT_INVALID");
  }
  return Object.freeze({ ...value, resources, instance_sha256: instanceSha256 });
}

function countStates(states) {
  const values = Object.values(stateObject(states));
  return Object.freeze({
    present: values.filter((value) => value === "present").length,
    absent: values.filter((value) => value === "absent").length,
  });
}

export function parseCoordinatorArguments(argv) {
  if (!Array.isArray(argv)) refuse("TEARDOWN_ARGUMENTS_INVALID");
  const values = Object.create(null);
  let commit = false;
  const valueFlags = new Set(["name", "wrapper", "record", "approve", "result-record"]);
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (item === "--commit") {
      if (commit) refuse("TEARDOWN_ARGUMENTS_INVALID");
      commit = true;
      continue;
    }
    if (typeof item !== "string" || !item.startsWith("--")) {
      refuse("TEARDOWN_ARGUMENTS_INVALID");
    }
    const flag = item.slice(2);
    if (!valueFlags.has(flag) || Object.hasOwn(values, flag)) {
      refuse("TEARDOWN_ARGUMENTS_INVALID");
    }
    const value = argv[++index];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      refuse("TEARDOWN_ARGUMENTS_INVALID");
    }
    values[flag] = value;
  }
  if (!values.name || !values.wrapper || !values.record) {
    refuse("TEARDOWN_ARGUMENTS_INVALID");
  }
  try { cleanName(values.name); }
  catch { refuse("TEARDOWN_ARGUMENTS_INVALID"); }
  if (commit) {
    if (!values.approve || !SHA256_RE.test(values.approve) || !values["result-record"] ||
        resolve(values.record) === resolve(values["result-record"])) {
      refuse("TEARDOWN_ARGUMENTS_INVALID");
    }
  } else if (values.approve || values["result-record"]) {
    refuse("TEARDOWN_ARGUMENTS_INVALID");
  }
  return Object.freeze({
    commit,
    name: values.name,
    wrapperPath: values.wrapper,
    recordPath: values.record,
    approval: values.approve || null,
    resultRecordPath: values["result-record"] || null,
  });
}

/** Coordinator entrypoint with injected seams for offline tests only. */
export function executeTeardown(options, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  if (ambientCredentialPresent(env)) refuse("TEARDOWN_AMBIENT_CREDENTIAL_REFUSED");
  const prefixes = protectedList(String(env.BRAIN_TEARDOWN_PROTECTED ?? ""));
  const decision = teardownDecision(options.name, { protectedPrefixes: prefixes });
  if (!decision.allowed) {
    refuse(decision.reason === "protected_match"
      ? "TEARDOWN_PROTECTED_NAME_REFUSED"
      : decision.reason === "protected_lock_missing"
        ? "TEARDOWN_PROTECTED_LOCK_MISSING"
        : "TEARDOWN_NAME_REFUSED");
  }
  // A same-user caller can forge argv and environment nonces, while Worker and
  // Vectorize deletion have no conditional generation fence. No public child
  // may reach DELETE until both boundaries have a provider-side solution.
  if (options.commit) refuse("TEARDOWN_COMMIT_DISABLED");

  const inspectWrapper = dependencies.inspectWrapper ?? inspectTeardownWrapper;
  const invoke = dependencies.invokeWrapper ?? invokeTeardownWrapper;
  const assertOutput = dependencies.assertOutput ?? assertPrivateAggregateOutputPath;
  const reserve = dependencies.reserve ?? reservePrivateAggregateReceipt;
  const finalize = dependencies.finalize ?? finalizePrivateAggregateReceipt;
  const wrapper = inspectWrapper(options.wrapperPath);
  const output = assertOutput(options.recordPath, {
    code: "TEARDOWN_PRIVATE_RECORD_REFUSED",
  });
  const provider = invoke({
    wrapper,
    operation: "preview",
    name: options.name,
  });
  const receipt = previewBinding({
    name: options.name,
    wrapper,
    protectedPrefixes: prefixes,
    provider,
  });
  const reservation = reserve(output, {
    contract_version: RECEIPT_CONTRACT_VERSION,
    kind: "brain_test_teardown_preview_pending",
    target_sha256: receipt.target_sha256,
    wrapper_sha256: receipt.wrapper_sha256,
    provider_sha256: receipt.provider_sha256,
  });
  try { finalize(reservation, receipt); }
  catch (error) { abandonPrivateAggregateReceipt(reservation); throw error; }
  return Object.freeze({
    ok: true,
    mode: "dry_run",
    target_bound: true,
    preview_instances_bound: true,
    resources: countStates(provider.before),
    private_record_saved: true,
    approval_fingerprint: receipt.approval_fingerprint,
    next: "commit_disabled_pending_conditional_provider_fence",
  });
}

function parseProviderChildArguments(argv) {
  const values = Object.create(null);
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (!new Set(["--operation", "--name"]).has(item) ||
        Object.hasOwn(values, item)) {
      refuse("TEARDOWN_PROVIDER_INPUT_INVALID");
    }
    const value = argv[++index];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      refuse("TEARDOWN_PROVIDER_INPUT_INVALID");
    }
    values[item] = value;
  }
  if (values["--operation"] !== "preview" || !values["--name"]) {
    refuse("TEARDOWN_PROVIDER_INPUT_INVALID");
  }
  cleanName(values["--name"]);
  return Object.freeze({
    operation: values["--operation"],
    name: values["--name"],
  });
}

async function boundedProviderJson(response, { allowEmpty = false } = {}) {
  if (!response || typeof response.status !== "number" ||
      !response.headers || typeof response.headers.get !== "function") {
    refuse("TEARDOWN_PROVIDER_RESPONSE_INVALID");
  }
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const declared = response.headers.get("content-length");
  if (declared !== null && declared !== "") {
    if (!/^\d+$/u.test(declared) || Number(declared) > MAX_PROVIDER_BYTES) {
      refuse("TEARDOWN_PROVIDER_RESPONSE_INVALID");
    }
  }
  if (!response.body) {
    if (allowEmpty && (declared === null || declared === "" || declared === "0")) return null;
    refuse("TEARDOWN_PROVIDER_RESPONSE_INVALID");
  }
  if (typeof response.body.getReader !== "function") {
    refuse("TEARDOWN_PROVIDER_RESPONSE_INVALID");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) refuse("TEARDOWN_PROVIDER_RESPONSE_INVALID");
      total += item.value.byteLength;
      if (total > MAX_PROVIDER_BYTES) {
        try { await reader.cancel(); } catch {}
        refuse("TEARDOWN_PROVIDER_RESPONSE_INVALID");
      }
      chunks.push(Buffer.from(item.value));
    }
    const raw = Buffer.concat(chunks, total);
    try {
      if (raw.length === 0 && allowEmpty) return null;
      if (raw.length < 2 ||
          !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/u.test(contentType)) {
        refuse("TEARDOWN_PROVIDER_RESPONSE_INVALID");
      }
      return JSON.parse(raw.toString("utf8"));
    } catch (error) {
      if (error instanceof TeardownSafetyError) throw error;
      refuse("TEARDOWN_PROVIDER_RESPONSE_INVALID");
    } finally {
      raw.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    try { reader.releaseLock(); } catch {}
  }
}

function providerUrl(path, query = null) {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("//") ||
      path.includes("?") || path.includes("#")) {
    refuse("TEARDOWN_PROVIDER_INPUT_INVALID");
  }
  const expected = `${API_PREFIX}${path}`;
  const url = new URL(expected, API_ORIGIN);
  if (query) {
    for (const [key, value] of query) url.searchParams.append(key, value);
  }
  if (url.origin !== API_ORIGIN || url.pathname !== expected ||
      url.username || url.password || url.hash) {
    refuse("TEARDOWN_PROVIDER_INPUT_INVALID");
  }
  return url;
}

async function providerRequest(fetchImpl, token, path, {
  method = "GET",
  query = null,
  allowMissing = false,
  allowEmptySuccess = false,
} = {}) {
  if (method !== "GET") refuse("TEARDOWN_COMMIT_DISABLED");
  let response;
  try {
    response = await fetchImpl(providerUrl(path, query), {
      method,
      headers: { authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    refuse("TEARDOWN_PROVIDER_UNCONFIRMED");
  }
  const body = await boundedProviderJson(response, {
    allowEmpty: allowEmptySuccess && response.status >= 200 && response.status < 300,
  });
  if (allowMissing && response.status === 404) {
    return Object.freeze({ missing: true, body: null });
  }
  if (response.status < 200 || response.status >= 300 || body?.success === false ||
      body === null && !allowEmptySuccess) {
    refuse("TEARDOWN_PROVIDER_REQUEST_FAILED");
  }
  return Object.freeze({ missing: false, body });
}

function providerResult(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      body.success === false || !Object.hasOwn(body, "result")) {
    refuse("TEARDOWN_PROVIDER_RESPONSE_INVALID");
  }
  return body.result;
}

async function resolveExactAccount(fetchImpl, token) {
  const verified = await providerRequest(fetchImpl, token, "/user/tokens/verify");
  providerResult(verified.body);
  const accounts = await providerRequest(fetchImpl, token, "/accounts", {
    query: [["per_page", "2"], ["page", "1"]],
  });
  const rows = providerResult(accounts.body);
  if (!Array.isArray(rows) || rows.length !== 1 ||
      !ACCOUNT_ID_RE.test(String(rows[0]?.id || ""))) {
    refuse("TEARDOWN_ACCOUNT_SCOPE_AMBIGUOUS");
  }
  return rows[0].id;
}

function providerInstanceSha256(kind, account, identity) {
  return sha256(canonical({ account, kind, identity }));
}

async function listExactWorker(fetchImpl, token, account, name) {
  const matches = [];
  for (let page = 1; page <= MAX_WORKER_PAGES; page++) {
    const response = await providerRequest(
      fetchImpl,
      token,
      `/accounts/${encodeURIComponent(account)}/workers/scripts-search`,
      { query: [
        ["name", name],
        ["order_by", "name"],
        ["per_page", String(WORKER_PAGE_SIZE)],
        ["page", String(page)],
      ] },
    );
    const rows = providerResult(response.body);
    if (!Array.isArray(rows)) refuse("TEARDOWN_PROVIDER_RESPONSE_INVALID");
    for (const row of rows) {
      if (row?.script_name === name) {
        const id = String(row.id || "").toLowerCase();
        if (!WORKER_ID_RE.test(id)) refuse("TEARDOWN_PROVIDER_RESPONSE_INVALID");
        matches.push(Object.freeze({
          id,
          instanceSha256: providerInstanceSha256("worker", account, id),
        }));
      }
    }
    if (matches.length > 1) refuse("TEARDOWN_RESOURCE_SCOPE_AMBIGUOUS");
    if (rows.length < WORKER_PAGE_SIZE) break;
    if (page === MAX_WORKER_PAGES) refuse("TEARDOWN_PROVIDER_RESPONSE_INVALID");
  }
  return matches[0] || null;
}

async function listExactD1(fetchImpl, token, account, name) {
  const matches = [];
  for (let page = 1; page <= MAX_D1_PAGES; page++) {
    const response = await providerRequest(
      fetchImpl,
      token,
      `/accounts/${encodeURIComponent(account)}/d1/database`,
      { query: [["per_page", String(D1_PAGE_SIZE)], ["page", String(page)]] },
    );
    const rows = providerResult(response.body);
    if (!Array.isArray(rows)) refuse("TEARDOWN_PROVIDER_RESPONSE_INVALID");
    for (const row of rows) {
      if (row?.name === name) {
        const id = String(row.uuid || row.id || "").toLowerCase();
        if (!D1_ID_RE.test(id)) refuse("TEARDOWN_PROVIDER_RESPONSE_INVALID");
        matches.push(Object.freeze({
          id,
          instanceSha256: providerInstanceSha256("d1", account, id),
        }));
      }
    }
    if (rows.length < D1_PAGE_SIZE) break;
    if (page === MAX_D1_PAGES) refuse("TEARDOWN_PROVIDER_RESPONSE_INVALID");
  }
  if (matches.length > 1) refuse("TEARDOWN_RESOURCE_SCOPE_AMBIGUOUS");
  return matches[0] || null;
}

async function inspectProviderResources(fetchImpl, token, account, name) {
  const accountPath = `/accounts/${encodeURIComponent(account)}`;
  const encodedName = encodeURIComponent(name);
  const worker = await listExactWorker(fetchImpl, token, account, name);
  const d1 = await listExactD1(fetchImpl, token, account, name);
  const vectorize = await providerRequest(fetchImpl, token,
    `${accountPath}/vectorize/v2/indexes/${encodedName}`, { allowMissing: true });
  const vectorizeResult = vectorize.missing ? null : providerResult(vectorize.body);
  if (vectorizeResult && (vectorizeResult.name !== name ||
      typeof vectorizeResult.created_on !== "string" ||
      vectorizeResult.created_on.length < 1 || vectorizeResult.created_on.length > 64 ||
      !Number.isFinite(Date.parse(vectorizeResult.created_on)))) {
    refuse("TEARDOWN_PROVIDER_RESPONSE_INVALID");
  }
  const states = Object.freeze({
    worker: worker ? "present" : "absent",
    d1: d1 ? "present" : "absent",
    vectorize: vectorizeResult ? "present" : "absent",
  });
  return Object.freeze({
    states,
    instanceSha256: Object.freeze({
      account: providerInstanceSha256("account", account, account),
      worker: worker?.instanceSha256 || null,
      d1: d1?.instanceSha256 || null,
      vectorize: vectorizeResult
        ? providerInstanceSha256("vectorize", account, vectorizeResult)
        : null,
    }),
  });
}

/** Read-only provider snapshot. No caller-controlled input can enable DELETE. */
export async function executeProviderChild(options, {
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  if (options?.operation === "delete") refuse("TEARDOWN_COMMIT_DISABLED");
  if (!exactKeys(options, ["operation", "name"]) || options.operation !== "preview") {
    refuse("TEARDOWN_PROVIDER_INPUT_INVALID");
  }
  cleanName(options.name);
  const nonce = String(env.BRAIN_TEARDOWN_WRAPPED_NONCE || "");
  const token = env[TOKEN_ENV_NAME];
  const providerSource = env.BRAIN_TEARDOWN_PROVIDER_SOURCE;
  if (!CHILD_NONCE_RE.test(nonce) || typeof token !== "string" ||
      token.length < 16 || token.length > 8192 || /[\u0000-\u001f\u007f]/u.test(token) ||
      typeof providerSource !== "string" || providerSource.length < 1 ||
      Buffer.byteLength(providerSource, "utf8") > MAX_PROVIDER_PROGRAM_BYTES ||
      providerSource.includes("\u0000") ||
      Object.hasOwn(env, ACCOUNT_ENV_NAME)) {
    refuse("TEARDOWN_CHILD_BOUNDARY_INVALID");
  }
  const account = await resolveExactAccount(fetchImpl, token);
  const targetSha256 = sha256(options.name);
  const nonceSha256 = sha256(nonce);
  const observed = await inspectProviderResources(fetchImpl, token, account, options.name);
  return Object.freeze({
    contract_version: PROVIDER_CONTRACT_VERSION,
    ok: true,
    operation: "preview",
    target_sha256: targetSha256,
    nonce_sha256: nonceSha256,
    provider_sha256: sha256(providerSource),
    account_scope_exact: true,
    instance_sha256: observed.instanceSha256,
    before: observed.states,
    after: observed.states,
    deleted: 0,
    already_absent: 0,
    absence_verified: false,
  });
}

function sanitizedFailure(error) {
  const allowed = error instanceof TeardownSafetyError &&
    /^TEARDOWN_[A-Z0-9_]+$/u.test(error.code || "")
    ? error.code
    : "TEARDOWN_UNEXPECTED_FAILURE";
  return Object.freeze({ ok: false, code: allowed });
}

async function runClosedCli(argv, providerSnapshot) {
  try {
    const result = providerSnapshot
      ? await executeProviderChild(parseProviderChildArguments(argv))
      : executeTeardown(parseCoordinatorArguments(argv));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    // No raw provider error, path, account, URL, resource identity, or
    // credential is ever emitted. Commit is refused before any record or child.
    process.stdout.write(`${JSON.stringify(sanitizedFailure(error))}\n`);
    process.exitCode = 1;
  }
}

const RUN_DIRECTLY = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_PROVIDER_SNAPSHOT_PROCESS) {
  await runClosedCli(process.argv.slice(2), true);
} else if (RUN_DIRECTLY) {
  await runClosedCli(process.argv.slice(2), false);
}
