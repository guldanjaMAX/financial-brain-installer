/**
 * Pure, read-only primitives for an exact-runtime `brain update --preview`.
 *
 * This module deliberately has no manifest discovery, credential, network,
 * browser, support-journal, package-install, workspace, or skill dependency.
 * The CLI adapter owns the one authenticated read-only request and gives this
 * module only its in-memory response. Raw rows are never copied into a receipt.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readlinkSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

export const UPDATE_PREVIEW_SCHEMA_VERSION = 1;
export const UPDATE_PREVIEW_OPERATION = "brain.update.preview";
export const UPDATE_RUNTIME_IDENTITY_SCHEME = "brain.runtime-payload.sha256.v1";
export const WINDOWS_NODE_LAUNCHER_TEMPLATE = "npm.cmd-shim-8.windows-node.v1";

export const UPDATE_PREVIEW_LIMITS = Object.freeze({
  arguments: 5,
  argument_bytes: 4 * 1024,
  files: 20_000,
  directories: 20_000,
  path_bytes: 1024,
  allowlist_bytes: 4 * 1024 * 1024,
  file_bytes: 128 * 1024 * 1024,
  total_bytes: 512 * 1024 * 1024,
  generated_entries: 512,
  generated_file_bytes: 64 * 1024,
  generated_total_bytes: 4 * 1024 * 1024,
  package_metadata_bytes: 4 * 1024 * 1024,
});

export const UPDATE_PREVIEW_FAILURE_CODES = Object.freeze([
  "UPDATE_PREVIEW_FAILED",
  "UPDATE_PREVIEW_ARGUMENTS_INVALID",
  "UPDATE_PREVIEW_ARGUMENT_TOO_LONG",
  "UPDATE_PREVIEW_EQUALS_SYNTAX_FORBIDDEN",
  "UPDATE_PREVIEW_UNKNOWN_OPTION",
  "UPDATE_PREVIEW_DUPLICATE_OPTION",
  "UPDATE_PREVIEW_ADOPTION_FORBIDDEN",
  "UPDATE_PREVIEW_MANIFEST_ARGUMENT_INVALID",
  "UPDATE_PREVIEW_EXTRA_POSITIONAL",
  "UPDATE_PREVIEW_FLAGS_INCOMPLETE",
  "UPDATE_PREVIEW_EXPECTED_RUNTIME_SHA256_INVALID",
  "UPDATE_PREVIEW_RUNTIME_ALLOWLIST_INVALID",
  "UPDATE_PREVIEW_RUNTIME_ROOT_INVALID",
  "UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID",
  "UPDATE_PREVIEW_RUNTIME_PAYLOAD_LIMIT",
  "UPDATE_PREVIEW_RUNTIME_PAYLOAD_CHANGED",
  "UPDATE_PREVIEW_RUNTIME_PAYLOAD_MISMATCH",
  "UPDATE_PREVIEW_DOWNGRADE_REFUSED",
  "UPDATE_PREVIEW_BRAIN_DOMAIN_INVALID",
  "UPDATE_PREVIEW_ADMIN_KEY_UNAVAILABLE",
  "UPDATE_PREVIEW_READINESS_UNAVAILABLE",
  "UPDATE_PREVIEW_READINESS_RECEIPT_INVALID",
  "UPDATE_PREVIEW_LEGACY_GENERATION_UNBOUND",
  "UPDATE_PREVIEW_VECTOR_BACKLOG_INVALID",
  "UPDATE_PREVIEW_QUEUE_TIMESTAMP_INVALID",
  "UPDATE_PREVIEW_VECTOR_READINESS_INVALID",
  "UPDATE_PREVIEW_DEPLOYED_GENERATION_MISMATCH",
  "UPDATE_PREVIEW_DEPLOYED_BACKEND_MISMATCH",
  "UPDATE_PREVIEW_DEPLOYED_DRAIN_PAUSED",
  "UPDATE_PREVIEW_PROJECTION_EXCESS",
  "UPDATE_PREVIEW_PROJECTION_WORK_INSUFFICIENT",
  "UPDATE_PREVIEW_PROJECTION_WORK_UNCOUNTED",
  "UPDATE_PREVIEW_PROJECTION_WORK_MISSING",
  "UPDATE_PREVIEW_PROJECTION_VISIBILITY_PENDING",
  "UPDATE_PREVIEW_PLAN_INVALID",
]);

const FAILURE_CODES = new Set(UPDATE_PREVIEW_FAILURE_CODES);
const SHA256_RE = /^[a-f0-9]{64}$/u;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const WINDOWS_FORBIDDEN_RE = /[<>:"|?*]/u;
const WINDOWS_RESERVED_RE =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;
const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const MANIFEST_SOURCES = new Set(["explicit", "remembered", "standard", "legacy_local"]);
const PREVIEW_FLAGS = new Set(["--preview", "--json", "--expect-runtime-sha256"]);
const INVENTORY_OPTION_KEYS = new Set([
  "root", "allowlist", "io", "platform", "maxFiles", "maxDirectories", "maxFileBytes",
  "maxTotalBytes",
]);
const RUNTIME_PLATFORMS = new Set(["posix", "win32"]);
const BUNDLED_PACKAGE_NAME_RE =
  /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,127}$/u;
const BIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const BIN_TARGET_RE = /^[A-Za-z0-9@._/-]+$/u;
const NODE_SHEBANG_RE = /^#!\/usr\/bin\/env node$/u;
const GENERATED_BIN_DIRECTORY = "node_modules/.bin";
const ZERO_EFFECTS = Object.freeze({
  manifest_writes: 0,
  credential_reads: 0,
  network_requests: 0,
  brain_writes: 0,
  cloudflare_control_requests: 0,
  deployments: 0,
  browser_launches: 0,
  package_installs: 0,
  support_journal_writes: 0,
  workspace_writes: 0,
  skill_writes: 0,
});
const PROOF_BOUNDARY = Object.freeze({
  public_release_authenticity: "unproven",
  credential_custody: "durable_admin_key_read",
  brain_domain_identity: "pinned_manifest_assertion",
  cloudflare_account_ownership: "not_accessed",
  deployed_install_state: "authenticated_aggregate_observed",
  schema_compatibility: "not_accessed",
  restore_bookmark: "not_created",
  deployment: "not_started",
  acceptance: "not_run",
});
const LEGACY_OBSERVATION_PROOF_BOUNDARY = Object.freeze({
  public_release_authenticity: "unproven",
  credential_custody: "durable_admin_key_read",
  brain_domain_identity: "pinned_manifest_assertion",
  cloudflare_account_ownership: "not_accessed",
  authenticated_projection_aggregate: "observed",
  deployed_worker_generation: "unproven",
  deployed_drain_mode: "unproven",
  mixed_generation_excluded: false,
  schema_compatibility: "legacy_generation_fields_absent",
  restore_bookmark: "not_created",
  deployment: "not_started",
  acceptance: "not_run",
});
const FINGERPRINT_DOMAIN = Buffer.from("brain.update.preview.plan.v1\0", "utf8");
const LEGACY_OBSERVATION_FINGERPRINT_DOMAIN =
  Buffer.from("brain.update.preview.legacy-observation.v1\0", "utf8");
const RUNTIME_DOMAIN = Buffer.from("brain.update.runtime-payload.v1\0", "utf8");

const DEFAULT_IO = Object.freeze({
  close: closeSync,
  fstat: fstatSync,
  lstat: lstatSync,
  open: openSync,
  read: readSync,
  readlink: readlinkSync,
  readdir: readdirSync,
  realpath: (path) => realpathSync.native(path),
});

export class UpdatePreviewError extends Error {
  constructor(code) {
    super(code);
    this.name = "UpdatePreviewError";
    this.code = code;
  }
}

function refuse(code = "UPDATE_PREVIEW_FAILED") {
  throw new UpdatePreviewError(code);
}

function immutable(value) {
  if (Array.isArray(value)) {
    for (const item of value) immutable(item);
  } else if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    for (const item of Object.values(value)) immutable(item);
  }
  return Object.freeze(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const BACKLOG_BOUNDED_FIELDS = Object.freeze([
  "pending_is_capped", "pending_display", "component_counts_exact",
]);
// The exact outbox receipt returned by every Worker before the bounded
// documents summary: SELECT count(*) totals and nothing else.
const LEGACY_EXACT_BACKLOG_FIELDS = Object.freeze([
  "pending", "upserts", "deletes", "submitted", "oldest_queued_at",
]);
const PROOF_QUEUE_FIELDS = Object.freeze([
  "pending", "pending_is_capped", "pending_display", "component_counts_exact",
  "upserts", "deletes", "submitted", "oldest_queued_at",
]);
export const LEGACY_EXACT_COUNT_RECEIPT = "legacy_exact";
export const LEGACY_EXACT_BACKLOG_NOTE =
  "This Brain runs an older Worker that reports its indexing queue as an exact count, " +
  "so the number shown is exact rather than a capped estimate.";

function exactKeys(value, expected) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    canonical(Object.keys(value).sort()) === canonical([...expected].sort());
}

function safeInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) refuse(code);
  return value;
}

function safeSha256(value, code) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) refuse(code);
  return value;
}

/**
 * Parse only the tokens after `brain update`.
 *
 * The optional manifest must be the first token. Options do not accept `=`,
 * aliases, repetitions, or implicit values. This parser is preview-only, so an
 * ordinary update invocation and every incomplete preview flag set are refused.
 */
export function parseUpdatePreviewArgv(argv) {
  if (!Array.isArray(argv) || argv.length > UPDATE_PREVIEW_LIMITS.arguments ||
      argv.some((value) => typeof value !== "string")) {
    refuse("UPDATE_PREVIEW_ARGUMENTS_INVALID");
  }
  for (const value of argv) {
    if (Buffer.byteLength(value, "utf8") > UPDATE_PREVIEW_LIMITS.argument_bytes ||
        CONTROL_RE.test(value)) {
      refuse("UPDATE_PREVIEW_ARGUMENT_TOO_LONG");
    }
  }

  let index = 0;
  let manifestPath = null;
  if (argv[0] !== undefined && !argv[0].startsWith("-")) {
    if (!argv[0] || argv[0].normalize("NFC") !== argv[0]) {
      refuse("UPDATE_PREVIEW_MANIFEST_ARGUMENT_INVALID");
    }
    manifestPath = argv[0];
    index = 1;
  }

  const seen = new Set();
  let expectedRuntimeSha256 = null;
  for (; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) refuse("UPDATE_PREVIEW_EXTRA_POSITIONAL");
    if (token.includes("=")) refuse("UPDATE_PREVIEW_EQUALS_SYNTAX_FORBIDDEN");
    if (token === "--adopt-cloudflare-profile") {
      refuse("UPDATE_PREVIEW_ADOPTION_FORBIDDEN");
    }
    if (!PREVIEW_FLAGS.has(token)) refuse("UPDATE_PREVIEW_UNKNOWN_OPTION");
    if (seen.has(token)) refuse("UPDATE_PREVIEW_DUPLICATE_OPTION");
    seen.add(token);
    if (token === "--expect-runtime-sha256") {
      index += 1;
      if (index >= argv.length || !SHA256_RE.test(argv[index])) {
        refuse("UPDATE_PREVIEW_EXPECTED_RUNTIME_SHA256_INVALID");
      }
      expectedRuntimeSha256 = argv[index];
    }
  }

  if (!["--preview", "--json", "--expect-runtime-sha256"].every((flag) => seen.has(flag))) {
    refuse("UPDATE_PREVIEW_FLAGS_INCOMPLETE");
  }
  return immutable({
    manifestPath,
    preview: true,
    json: true,
    expectedRuntimeSha256,
  });
}

function selectedIo(io) {
  if (io !== undefined && (!io || typeof io !== "object" || Array.isArray(io))) {
    refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
  }
  if (io && Object.keys(io).some((name) => !Object.hasOwn(DEFAULT_IO, name))) {
    refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
  }
  const selected = {};
  for (const [name, implementation] of Object.entries(DEFAULT_IO)) {
    selected[name] = io?.[name] ?? implementation;
    if (typeof selected[name] !== "function") {
      refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
    }
  }
  return selected;
}

function statIdentity(info) {
  return {
    dev: info.dev,
    ino: info.ino,
    nlink: info.nlink,
    size: info.size,
    mode: info.mode,
    uid: info.uid,
    gid: info.gid,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.nlink === right.nlink && left.size === right.size &&
    left.mode === right.mode && left.uid === right.uid && left.gid === right.gid &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function within(root, path) {
  const suffix = relative(root, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) &&
    !isAbsolute(suffix));
}

function checkedCanonicalRoot(root, io) {
  try {
    if (typeof root !== "string" || !root || CONTROL_RE.test(root)) {
      refuse("UPDATE_PREVIEW_RUNTIME_ROOT_INVALID");
    }
    const lexical = resolve(root);
    const before = io.lstat(lexical);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      refuse("UPDATE_PREVIEW_RUNTIME_ROOT_INVALID");
    }
    const canonicalRoot = io.realpath(lexical);
    const after = io.lstat(canonicalRoot);
    if (!after.isDirectory() || after.isSymbolicLink() ||
        !sameIdentity(statIdentity(before), statIdentity(after))) {
      refuse("UPDATE_PREVIEW_RUNTIME_ROOT_INVALID");
    }
    return canonicalRoot;
  } catch (error) {
    if (error instanceof UpdatePreviewError) throw error;
    refuse("UPDATE_PREVIEW_RUNTIME_ROOT_INVALID");
  }
}

function checkedPayloadPath(value) {
  if (typeof value !== "string" || !value || value !== value.normalize("NFC") ||
      Buffer.byteLength(value, "utf8") > UPDATE_PREVIEW_LIMITS.path_bytes ||
      value.startsWith("/") || value.includes("\\") || CONTROL_RE.test(value) ||
      WINDOWS_FORBIDDEN_RE.test(value)) {
    refuse("UPDATE_PREVIEW_RUNTIME_ALLOWLIST_INVALID");
  }
  const parts = value.split("/");
  if (parts.length > 64 || parts.some((part) => !part || part === "." || part === ".." ||
      Buffer.byteLength(part, "utf8") > 255 || /[. ]$/u.test(part) ||
      WINDOWS_RESERVED_RE.test(part))) {
    refuse("UPDATE_PREVIEW_RUNTIME_ALLOWLIST_INVALID");
  }
  return value;
}

function checkedAllowlist(allowlist, maxFiles, maxDirectories) {
  if (!Array.isArray(allowlist) || allowlist.length < 1 || allowlist.length > maxFiles) {
    refuse("UPDATE_PREVIEW_RUNTIME_ALLOWLIST_INVALID");
  }
  const files = new Set();
  const directories = new Set();
  const canonicalFiles = new Set();
  const canonicalDirectories = new Set();
  const directorySpellings = new Map();
  let allowlistBytes = 0;
  for (const input of allowlist) {
    const path = checkedPayloadPath(input);
    allowlistBytes += Buffer.byteLength(path, "utf8");
    if (allowlistBytes > UPDATE_PREVIEW_LIMITS.allowlist_bytes || files.has(path)) {
      refuse("UPDATE_PREVIEW_RUNTIME_ALLOWLIST_INVALID");
    }
    const key = path.toLowerCase().normalize("NFC");
    if (canonicalFiles.has(key) || canonicalDirectories.has(key)) {
      refuse("UPDATE_PREVIEW_RUNTIME_ALLOWLIST_INVALID");
    }
    const parts = path.split("/");
    const keyParts = key.split("/");
    for (let index = 1; index < parts.length; index++) {
      const directory = parts.slice(0, index).join("/");
      const directoryKey = keyParts.slice(0, index).join("/");
      if (canonicalFiles.has(directoryKey)) refuse("UPDATE_PREVIEW_RUNTIME_ALLOWLIST_INVALID");
      if (directorySpellings.has(directoryKey) &&
          directorySpellings.get(directoryKey) !== directory) {
        refuse("UPDATE_PREVIEW_RUNTIME_ALLOWLIST_INVALID");
      }
      directories.add(directory);
      canonicalDirectories.add(directoryKey);
      directorySpellings.set(directoryKey, directory);
      if (directories.size > maxDirectories) refuse("UPDATE_PREVIEW_RUNTIME_ALLOWLIST_INVALID");
    }
    files.add(path);
    canonicalFiles.add(key);
  }
  return {
    files,
    directories,
    orderedFiles: [...files].sort(),
  };
}

function checkedLimits(options) {
  const code = "UPDATE_PREVIEW_RUNTIME_PAYLOAD_LIMIT";
  return {
    maxFiles: safeInteger(options.maxFiles ?? UPDATE_PREVIEW_LIMITS.files,
      1, UPDATE_PREVIEW_LIMITS.files, code),
    maxDirectories: safeInteger(options.maxDirectories ?? UPDATE_PREVIEW_LIMITS.directories,
      0, UPDATE_PREVIEW_LIMITS.directories, code),
    maxFileBytes: safeInteger(options.maxFileBytes ?? UPDATE_PREVIEW_LIMITS.file_bytes,
      1, UPDATE_PREVIEW_LIMITS.file_bytes, code),
    maxTotalBytes: safeInteger(options.maxTotalBytes ?? UPDATE_PREVIEW_LIMITS.total_bytes,
      1, UPDATE_PREVIEW_LIMITS.total_bytes, code),
  };
}

function stableRegularFile(path, root, maximumBytes, io) {
  let descriptor;
  let bytes;
  try {
    const before = io.lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
        !Number.isSafeInteger(before.size) || before.size < 0) {
      refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
    }
    if (before.size > maximumBytes) refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_LIMIT");
    const canonicalPath = io.realpath(path);
    if (!within(root, canonicalPath)) refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
    descriptor = io.open(path, fsConstants.O_RDONLY |
      (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_NONBLOCK || 0));
    const opened = io.fstat(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 ||
        !sameIdentity(statIdentity(before), statIdentity(opened))) {
      refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_CHANGED");
    }

    bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = io.read(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(count) || count < 1 || count > bytes.length - offset) {
        refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_CHANGED");
      }
      offset += count;
    }
    const probe = Buffer.alloc(1);
    try {
      if (io.read(descriptor, probe, 0, 1, bytes.length) !== 0) {
        refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_CHANGED");
      }
    } finally {
      probe.fill(0);
    }

    const afterDescriptor = io.fstat(descriptor);
    const afterPath = io.lstat(path);
    if (!afterDescriptor.isFile() || afterDescriptor.nlink !== 1 ||
        !afterPath.isFile() || afterPath.isSymbolicLink() || afterPath.nlink !== 1 ||
        !sameIdentity(statIdentity(opened), statIdentity(afterDescriptor)) ||
        !sameIdentity(statIdentity(opened), statIdentity(afterPath)) ||
        io.realpath(path) !== canonicalPath) {
      refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_CHANGED");
    }
    io.close(descriptor);
    descriptor = undefined;
    return bytes;
  } catch (error) {
    bytes?.fill(0);
    if (error instanceof UpdatePreviewError) throw error;
    refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
  } finally {
    if (descriptor !== undefined) {
      try { io.close(descriptor); } catch { /* the closed error above remains sanitized */ }
    }
  }
}

function checkedRuntimePlatform(value) {
  const platform = value ?? (process.platform === "win32" ? "win32" : "posix");
  if (!RUNTIME_PLATFORMS.has(platform)) {
    refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
  }
  return platform;
}

function stableJsonFile(path, root, maximumBytes, io) {
  const bytes = stableRegularFile(path, root, maximumBytes, io);
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
    }
    return value;
  } catch (error) {
    if (error instanceof UpdatePreviewError) throw error;
    refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
  } finally {
    bytes.fill(0);
  }
}

function checkedBundledPackageName(value) {
  if (typeof value !== "string" || value !== value.normalize("NFC") ||
      !BUNDLED_PACKAGE_NAME_RE.test(value)) {
    refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
  }
  return value;
}

function checkedBinName(value) {
  if (typeof value !== "string" || value !== value.normalize("NFC") ||
      !BIN_NAME_RE.test(value) || /[. ]$/u.test(value) || WINDOWS_RESERVED_RE.test(value)) {
    refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
  }
  try { checkedPayloadPath(`${GENERATED_BIN_DIRECTORY}/${value}`); }
  catch { refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"); }
  return value;
}

function checkedBinTarget(dependencyName, value, expectedFiles) {
  if (typeof value !== "string" || !value || value !== value.normalize("NFC") ||
      CONTROL_RE.test(value) || !BIN_TARGET_RE.test(value)) {
    refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
  }
  const unprefixed = value.startsWith("./") ? value.slice(2) : value;
  if (!unprefixed || unprefixed.startsWith("/") || unprefixed.includes("//")) {
    refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
  }
  const payloadTarget = `node_modules/${dependencyName}/${unprefixed}`;
  try { checkedPayloadPath(payloadTarget); }
  catch { refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"); }
  if (!expectedFiles.has(payloadTarget)) {
    refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
  }
  return payloadTarget;
}

function dependencyBinDeclarations(manifest, dependencyName, expectedFiles) {
  const raw = manifest.bin;
  if (raw === undefined || raw === null) return [];
  if (typeof raw === "string") {
    return [{
      name: checkedBinName(dependencyName.split("/").at(-1)),
      target: checkedBinTarget(dependencyName, raw, expectedFiles),
    }];
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
  }
  const rows = Object.entries(raw);
  if (rows.length > UPDATE_PREVIEW_LIMITS.generated_entries) {
    refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_LIMIT");
  }
  return rows.map(([name, target]) => ({
    name: checkedBinName(name),
    target: checkedBinTarget(dependencyName, target, expectedFiles),
  }));
}

/*
 * npm 11.8.0 uses cmd-shim 8 for Windows. Keep this deliberately narrower
 * than cmd-shim itself: reviewed executables must use the canonical
 * `#!/usr/bin/env node` entrypoint, and all three generated bytestrings must
 * match the pinned template exactly. A different npm template fails closed.
 *
 * `launcherDirectory` and `payloadTarget` are package-root-relative POSIX
 * paths. The root-level launcher directory is represented by `.`. Every call
 * returns fresh buffers so the verifier can wipe them after comparison.
 */
export function expectedWindowsNodeLauncherBytes(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options) ||
      Object.keys(options).length !== 3 ||
      Object.keys(options).some((name) =>
        !["launcherDirectory", "payloadTarget", "targetBytes"].includes(name))) {
    refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
  }
  const { launcherDirectory, payloadTarget, targetBytes } = options;
  try {
    if (launcherDirectory !== ".") checkedPayloadPath(launcherDirectory);
    checkedPayloadPath(payloadTarget);
  } catch {
    refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
  }
  if (!Buffer.isBuffer(targetBytes) || targetBytes.length < 1 ||
      targetBytes.length > UPDATE_PREVIEW_LIMITS.package_metadata_bytes) {
    refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
  }
  const firstLine = targetBytes.toString("utf8").trim().split(/\r*\n/u)[0];
  if (!NODE_SHEBANG_RE.test(firstLine)) {
    refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
  }
  const shRelative = posix.relative(launcherDirectory, payloadTarget);
  if (!shRelative || shRelative === "." || shRelative.startsWith("/") ||
      shRelative.includes("\\") || CONTROL_RE.test(shRelative) ||
      Buffer.byteLength(shRelative, "utf8") > UPDATE_PREVIEW_LIMITS.path_bytes) {
    refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
  }
  const batchRelative = shRelative.replaceAll("/", "\\");
  const batchTarget = `"%dp0%\\${batchRelative}"`;
  const shellTarget = `"$basedir/${shRelative}"`;

  const plain = Buffer.from(
    "#!/bin/sh\n" +
    "basedir=$(dirname \"$(echo \"$0\" | sed -e 's,\\\\,/,g')\")\n" +
    "\n" +
    "case `uname` in\n" +
    "    *CYGWIN*|*MINGW*|*MSYS*)\n" +
    "        if command -v cygpath > /dev/null 2>&1; then\n" +
    "            basedir=`cygpath -w \"$basedir\"`\n" +
    "        fi\n" +
    "    ;;\n" +
    "esac\n" +
    "\n" +
    "if [ -x \"$basedir/node\" ]; then\n" +
    `  exec \"$basedir/node\"  ${shellTarget} \"$@\"\n` +
    "else \n" +
    `  exec node  ${shellTarget} \"$@\"\n` +
    "fi\n",
    "utf8",
  );
  const cmd = Buffer.from(
    "@ECHO off\r\n" +
    "GOTO start\r\n" +
    ":find_dp0\r\n" +
    "SET dp0=%~dp0\r\n" +
    "EXIT /b\r\n" +
    ":start\r\n" +
    "SETLOCAL\r\n" +
    "CALL :find_dp0\r\n" +
    "\r\n" +
    "IF EXIST \"%dp0%\\node.exe\" (\r\n" +
    "  SET \"_prog=%dp0%\\node.exe\"\r\n" +
    ") ELSE (\r\n" +
    "  SET \"_prog=node\"\r\n" +
    "  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n" +
    ")\r\n" +
    "\r\n" +
    "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & " +
    `\"%_prog%\"  ${batchTarget} %*\r\n`,
    "utf8",
  );
  const powershell = Buffer.from(
    "#!/usr/bin/env pwsh\n" +
    "$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n" +
    "\n" +
    "$exe=\"\"\n" +
    "if ($PSVersionTable.PSVersion -lt \"6.0\" -or $IsWindows) {\n" +
    "  # Fix case when both the Windows and Linux builds of Node\n" +
    "  # are installed in the same directory\n" +
    "  $exe=\".exe\"\n" +
    "}\n" +
    "$ret=0\n" +
    "if (Test-Path \"$basedir/node$exe\") {\n" +
    "  # Support pipeline input\n" +
    "  if ($MyInvocation.ExpectingInput) {\n" +
    `    $input | & \"$basedir/node$exe\"  ${shellTarget} $args\n` +
    "  } else {\n" +
    `    & \"$basedir/node$exe\"  ${shellTarget} $args\n` +
    "  }\n" +
    "  $ret=$LASTEXITCODE\n" +
    "} else {\n" +
    "  # Support pipeline input\n" +
    "  if ($MyInvocation.ExpectingInput) {\n" +
    `    $input | & \"node$exe\"  ${shellTarget} $args\n` +
    "  } else {\n" +
    `    & \"node$exe\"  ${shellTarget} $args\n` +
    "  }\n" +
    "  $ret=$LASTEXITCODE\n" +
    "}\n" +
    "exit $ret\n",
    "utf8",
  );
  return Object.freeze({ plain, cmd, powershell });
}

function buildGeneratedEntryContract({ root, expected, io, platform, limits }) {
  const entries = new Map();
  const directories = new Set();
  const expectedCanonical = new Set(
    [...expected.files, ...expected.directories].map((path) => path.toLowerCase().normalize("NFC")),
  );
  if (!expected.files.has("package.json")) {
    return { entries, directories, wipe() {} };
  }

  const metadataMaximum = Math.min(
    limits.maxFileBytes,
    UPDATE_PREVIEW_LIMITS.package_metadata_bytes,
  );
  const rootManifest = stableJsonFile(join(root, "package.json"), root, metadataMaximum, io);
  if (Object.hasOwn(rootManifest, "bundleDependencies") &&
      Object.hasOwn(rootManifest, "bundledDependencies")) {
    refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
  }
  const rawDependencies = rootManifest.bundleDependencies ?? rootManifest.bundledDependencies ?? [];
  if (!Array.isArray(rawDependencies) ||
      rawDependencies.length > UPDATE_PREVIEW_LIMITS.generated_entries) {
    refuse(rawDependencies?.length > UPDATE_PREVIEW_LIMITS.generated_entries
      ? "UPDATE_PREVIEW_RUNTIME_PAYLOAD_LIMIT"
      : "UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
  }

  const dependencyNames = new Set();
  const dependencyCanonical = new Set();
  for (const rawName of rawDependencies) {
    const dependencyName = checkedBundledPackageName(rawName);
    const key = dependencyName.toLowerCase().normalize("NFC");
    if (dependencyNames.has(dependencyName) || dependencyCanonical.has(key)) {
      refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
    }
    dependencyNames.add(dependencyName);
    dependencyCanonical.add(key);
  }

  const commandNames = new Set();
  const generatedCanonical = new Set();
  let generatedBytes = 0;
  const addEntry = (path, entry) => {
    const key = path.toLowerCase().normalize("NFC");
    try { checkedPayloadPath(path); }
    catch { refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"); }
    if (entries.has(path) || generatedCanonical.has(key) || expectedCanonical.has(key) ||
        entries.size >= UPDATE_PREVIEW_LIMITS.generated_entries) {
      refuse(entries.size >= UPDATE_PREVIEW_LIMITS.generated_entries
        ? "UPDATE_PREVIEW_RUNTIME_PAYLOAD_LIMIT"
        : "UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
    }
    if (entry.bytes) {
      if (entry.bytes.length > UPDATE_PREVIEW_LIMITS.generated_file_bytes ||
          generatedBytes > UPDATE_PREVIEW_LIMITS.generated_total_bytes - entry.bytes.length) {
        refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_LIMIT");
      }
      generatedBytes += entry.bytes.length;
    }
    entries.set(path, entry);
    generatedCanonical.add(key);
  };

  try {
    for (const dependencyName of [...dependencyNames].sort()) {
      const manifestRelative = `node_modules/${dependencyName}/package.json`;
      if (!expected.files.has(manifestRelative)) {
        refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
      }
      const dependencyManifest = stableJsonFile(
        join(root, ...manifestRelative.split("/")), root, metadataMaximum, io,
      );
      if (dependencyManifest.name !== dependencyName) {
        refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
      }
      const declarations = dependencyBinDeclarations(
        dependencyManifest, dependencyName, expected.files,
      );
      for (const declaration of declarations) {
        const commandKey = declaration.name.toLowerCase().normalize("NFC");
        if (commandNames.has(commandKey)) {
          refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
        }
        commandNames.add(commandKey);
        const basePath = `${GENERATED_BIN_DIRECTORY}/${declaration.name}`;
        if (platform === "posix") {
          const target = posix.relative(GENERATED_BIN_DIRECTORY, declaration.target);
          if (!target.startsWith("../") || target.includes("\\") ||
              Buffer.byteLength(target, "utf8") > UPDATE_PREVIEW_LIMITS.path_bytes) {
            refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
          }
          addEntry(basePath, { type: "symlink", target, payloadTarget: declaration.target });
        } else {
          const targetBytes = stableRegularFile(
            join(root, ...declaration.target.split("/")), root,
            Math.min(limits.maxFileBytes, UPDATE_PREVIEW_LIMITS.package_metadata_bytes), io,
          );
          let shims;
          try {
            shims = expectedWindowsNodeLauncherBytes({
              launcherDirectory: GENERATED_BIN_DIRECTORY,
              payloadTarget: declaration.target,
              targetBytes,
            });
          }
          finally { targetBytes.fill(0); }
          try {
            addEntry(basePath, { type: "file", bytes: shims.plain });
            addEntry(`${basePath}.cmd`, { type: "file", bytes: shims.cmd });
            addEntry(`${basePath}.ps1`, { type: "file", bytes: shims.powershell });
          } catch (error) {
            shims.plain.fill(0);
            shims.cmd.fill(0);
            shims.powershell.fill(0);
            throw error;
          }
        }
      }
    }

    if (entries.size) {
      const directoryKey = GENERATED_BIN_DIRECTORY.toLowerCase().normalize("NFC");
      if (expectedCanonical.has(directoryKey)) {
        refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
      }
      directories.add(GENERATED_BIN_DIRECTORY);
    }
  } catch (error) {
    for (const entry of entries.values()) entry.bytes?.fill(0);
    throw error;
  }
  return {
    entries,
    directories,
    wipe() {
      for (const entry of entries.values()) entry.bytes?.fill(0);
    },
  };
}

function verifyGeneratedSymlink(path, root, expected, io) {
  try {
    const before = io.lstat(path);
    if (!before.isSymbolicLink() || before.nlink !== 1 ||
        !Number.isSafeInteger(before.size) || before.size < 1 ||
        before.size > UPDATE_PREVIEW_LIMITS.path_bytes) {
      refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
    }
    const target = io.readlink(path);
    if (typeof target !== "string" || target !== expected.target || CONTROL_RE.test(target)) {
      refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
    }
    const expectedAbsolute = join(root, ...expected.payloadTarget.split("/"));
    if (resolve(dirname(path), target) !== expectedAbsolute) {
      refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
    }
    const targetInfo = io.lstat(expectedAbsolute);
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink() || targetInfo.nlink !== 1 ||
        io.realpath(expectedAbsolute) !== expectedAbsolute || io.realpath(path) !== expectedAbsolute) {
      refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
    }
    const after = io.lstat(path);
    if (!after.isSymbolicLink() || after.nlink !== 1 ||
        !sameIdentity(statIdentity(before), statIdentity(after)) ||
        io.readlink(path) !== target || io.realpath(path) !== expectedAbsolute) {
      refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_CHANGED");
    }
  } catch (error) {
    if (error instanceof UpdatePreviewError) throw error;
    refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
  }
}

function verifyGeneratedFile(path, root, expected, io) {
  const bytes = stableRegularFile(
    path, root, UPDATE_PREVIEW_LIMITS.generated_file_bytes, io,
  );
  try {
    if (bytes.length !== expected.bytes.length || !bytes.equals(expected.bytes)) {
      refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
    }
  } finally {
    bytes.fill(0);
  }
}

function lengthPrefix(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

/**
 * Derive the canonical runtime identity from content-digest rows.
 *
 * Package inspection can use this same framing without materializing files or
 * duplicating the identity algorithm. Rows are sorted canonically by `path`;
 * `bytes` is the exact file length and `sha256` is the exact content digest.
 */
export function deriveUpdateRuntimePayloadSha256(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > UPDATE_PREVIEW_LIMITS.files) {
    refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
  }
  const checked = [];
  let totalBytes = 0;
  for (const row of rows) {
    if (!exactKeys(row, ["path", "bytes", "sha256"])) {
      refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
    }
    const path = checkedPayloadPath(row.path);
    const bytes = safeInteger(row.bytes, 0, UPDATE_PREVIEW_LIMITS.file_bytes,
      "UPDATE_PREVIEW_RUNTIME_PAYLOAD_LIMIT");
    const sha256 = safeSha256(row.sha256, "UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
    if (totalBytes > UPDATE_PREVIEW_LIMITS.total_bytes - bytes) {
      refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_LIMIT");
    }
    totalBytes += bytes;
    checked.push({ path, bytes, sha256 });
  }
  checkedAllowlist(checked.map((row) => row.path),
    UPDATE_PREVIEW_LIMITS.files, UPDATE_PREVIEW_LIMITS.directories);
  checked.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

  const hash = createHash("sha256").update(RUNTIME_DOMAIN);
  const countPrefix = lengthPrefix(checked.length);
  hash.update(countPrefix);
  countPrefix.fill(0);
  for (const row of checked) {
    const pathBytes = Buffer.from(row.path, "utf8");
    const pathLength = lengthPrefix(pathBytes.length);
    const contentLength = lengthPrefix(row.bytes);
    const contentDigest = Buffer.from(row.sha256, "hex");
    try {
      hash.update(pathLength).update(pathBytes).update(contentLength).update(contentDigest);
    } finally {
      pathLength.fill(0);
      contentLength.fill(0);
      pathBytes.fill(0);
      contentDigest.fill(0);
    }
  }
  return hash.digest("hex");
}

/**
 * Hash one exact allowlisted runtime tree without returning paths or bytes.
 * npm-generated bundled dependency shims are validated separately and never
 * enter the archive-derived identity. Every other link, special, or extra
 * directory entry fails, including empty directories outside the contract.
 */
export function inventoryUpdateRuntimePayload(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options) ||
      Object.keys(options).some((name) => !INVENTORY_OPTION_KEYS.has(name))) {
    refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
  }
  const { root, allowlist, io: ioInput, platform: platformInput, ...limitOptions } = options;
  const limits = checkedLimits(limitOptions);
  const io = selectedIo(ioInput);
  const platform = checkedRuntimePlatform(platformInput);
  const expected = checkedAllowlist(allowlist, limits.maxFiles, limits.maxDirectories);
  const canonicalRoot = checkedCanonicalRoot(root, io);
  const generated = buildGeneratedEntryContract({
    root: canonicalRoot,
    expected,
    io,
    platform,
    limits,
  });
  const seenFiles = new Set();
  const seenDirectories = new Set();
  const seenGeneratedEntries = new Set();
  const seenGeneratedDirectories = new Set();
  const contentDigests = new Map();
  let totalBytes = 0;

  const visit = (directory, relativeDirectory = "") => {
    let before;
    let canonicalDirectory;
    let names;
    try {
      before = io.lstat(directory);
      if (!before.isDirectory() || before.isSymbolicLink()) {
        refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
      }
      canonicalDirectory = io.realpath(directory);
      if (!within(canonicalRoot, canonicalDirectory)) {
        refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
      }
      names = io.readdir(directory);
      if (!Array.isArray(names)) refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
      if (names.length > limits.maxFiles + limits.maxDirectories +
          UPDATE_PREVIEW_LIMITS.generated_entries + generated.directories.size) {
        refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_LIMIT");
      }
    } catch (error) {
      if (error instanceof UpdatePreviewError) throw error;
      refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
    }
    names.sort();
    for (const name of names) {
      if (typeof name !== "string") refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
      const childRelative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      try { checkedPayloadPath(childRelative); }
      catch { refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"); }
      const child = join(directory, name);
      let info;
      try { info = io.lstat(child); }
      catch { refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"); }
      const generatedEntry = generated.entries.get(childRelative);
      if (info.isSymbolicLink()) {
        if (!generatedEntry || generatedEntry.type !== "symlink" ||
            seenGeneratedEntries.has(childRelative)) {
          refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
        }
        verifyGeneratedSymlink(child, canonicalRoot, generatedEntry, io);
        seenGeneratedEntries.add(childRelative);
      } else if (info.isDirectory()) {
        const payloadDirectory = expected.directories.has(childRelative);
        const generatedDirectory = generated.directories.has(childRelative);
        if (payloadDirectory === generatedDirectory ||
            (payloadDirectory && (seenDirectories.has(childRelative) ||
              seenDirectories.size >= limits.maxDirectories)) ||
            (generatedDirectory && seenGeneratedDirectories.has(childRelative))) {
          refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
        }
        if (payloadDirectory) seenDirectories.add(childRelative);
        else seenGeneratedDirectories.add(childRelative);
        visit(child, childRelative);
      } else if (info.isFile()) {
        if (generatedEntry) {
          if (generatedEntry.type !== "file" || seenGeneratedEntries.has(childRelative)) {
            refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
          }
          verifyGeneratedFile(child, canonicalRoot, generatedEntry, io);
          seenGeneratedEntries.add(childRelative);
        } else {
          if (!expected.files.has(childRelative) || seenFiles.has(childRelative) ||
              seenFiles.size >= limits.maxFiles) {
            refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
          }
          const bytes = stableRegularFile(child, canonicalRoot, limits.maxFileBytes, io);
          if (totalBytes > limits.maxTotalBytes - bytes.length) {
            bytes.fill(0);
            refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_LIMIT");
          }
          totalBytes += bytes.length;
          seenFiles.add(childRelative);
          contentDigests.set(childRelative, {
            length: bytes.length,
            sha256: createHash("sha256").update(bytes).digest(),
          });
          bytes.fill(0);
        }
      } else {
        refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
      }
    }
    let after;
    try { after = io.lstat(directory); }
    catch { refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_CHANGED"); }
    if (!after.isDirectory() || after.isSymbolicLink() ||
        !sameIdentity(statIdentity(before), statIdentity(after)) ||
        io.realpath(directory) !== canonicalDirectory) {
      refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_CHANGED");
    }
  };

  try {
    visit(canonicalRoot);
    if (seenFiles.size !== expected.files.size ||
        seenDirectories.size !== expected.directories.size ||
        seenGeneratedEntries.size !== generated.entries.size ||
        seenGeneratedDirectories.size !== generated.directories.size) {
      refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
    }
    const digestRows = [];
    for (const path of expected.orderedFiles) {
      const content = contentDigests.get(path);
      if (!content || !Buffer.isBuffer(content.sha256) || content.sha256.length !== 32) {
        refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
      }
      digestRows.push({ path, bytes: content.length, sha256: content.sha256.toString("hex") });
      content.sha256.fill(0);
      contentDigests.delete(path);
    }
    return immutable({
      schema_version: UPDATE_PREVIEW_SCHEMA_VERSION,
      identity_scheme: UPDATE_RUNTIME_IDENTITY_SCHEME,
      runtime_payload_sha256: deriveUpdateRuntimePayloadSha256(digestRows),
      file_count: seenFiles.size,
      total_bytes: totalBytes,
    });
  } finally {
    generated.wipe();
    for (const content of contentDigests.values()) content.sha256?.fill(0);
    contentDigests.clear();
  }
}

function sameInventory(left, right) {
  return left.schema_version === right.schema_version &&
    left.identity_scheme === right.identity_scheme &&
    left.runtime_payload_sha256 === right.runtime_payload_sha256 &&
    left.file_count === right.file_count && left.total_bytes === right.total_bytes;
}

/**
 * Require the independently supplied digest on two complete tree passes.
 * `betweenPasses` is an injectable synchronous test seam; production callers
 * should omit it. It cannot authorize or perform an update.
 */
export function verifyUpdateRuntimePayload(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
  }
  const { expectedRuntimeSha256, betweenPasses, ...inventoryOptions } = options;
  safeSha256(expectedRuntimeSha256, "UPDATE_PREVIEW_EXPECTED_RUNTIME_SHA256_INVALID");
  if (betweenPasses !== undefined && typeof betweenPasses !== "function") {
    refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
  }
  const first = inventoryUpdateRuntimePayload(inventoryOptions);
  if (first.runtime_payload_sha256 !== expectedRuntimeSha256) {
    refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_MISMATCH");
  }
  if (betweenPasses) {
    let result;
    try { result = betweenPasses(Object.freeze({ pass: 1 })); }
    catch (error) {
      if (error instanceof UpdatePreviewError) throw error;
      refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_CHANGED");
    }
    if (result && typeof result.then === "function") {
      refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID");
    }
  }
  const second = inventoryUpdateRuntimePayload(inventoryOptions);
  if (!sameInventory(first, second) || second.runtime_payload_sha256 !== expectedRuntimeSha256) {
    refuse("UPDATE_PREVIEW_RUNTIME_PAYLOAD_CHANGED");
  }
  return immutable({
    ...second,
    expected_runtime_sha256: expectedRuntimeSha256,
    verified_passes: 2,
  });
}

function parseVersion(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    refuse("UPDATE_PREVIEW_PLAN_INVALID");
  }
  const match = VERSION_RE.exec(value);
  if (!match) refuse("UPDATE_PREVIEW_PLAN_INVALID");
  const prerelease = match[4] ? match[4].split(".") : [];
  if (prerelease.some((item) => /^\d+$/u.test(item) && item.length > 1 && item.startsWith("0"))) {
    refuse("UPDATE_PREVIEW_PLAN_INVALID");
  }
  return { core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])], prerelease };
}

function compareVersion(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < a.core.length; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

/** Refuse a locally provable downgrade before any private read is reachable. */
export function updatePreviewVersionRelation(recordedVersion, candidateVersion) {
  parseVersion(recordedVersion);
  parseVersion(candidateVersion);
  const comparison = compareVersion(recordedVersion, candidateVersion);
  if (comparison > 0) refuse("UPDATE_PREVIEW_DOWNGRADE_REFUSED");
  return comparison < 0 ? "upgrade" : "same";
}

/** Identify the shipped /documents contract before version and drain mode appeared. */
export function isLegacyPre047Version(version) {
  parseVersion(version);
  return compareVersion(version, "0.4.7") < 0;
}

const READINESS_REASONS = new Set([
  "accepted_mutation_needs_confirmation",
  "accepted_mutation_processing",
  "projection_bootstrap_required",
  "projection_unverified",
  "vector_count_mismatch",
  "vector_work_queued",
]);

function readinessReasonIsCoherent({
  ready,
  reason,
  expected,
  actual,
  pending,
  submitted,
}) {
  const countsMatch = actual === expected;
  if (ready) return pending === 0 && countsMatch && reason === null;
  if (typeof reason !== "string" || !READINESS_REASONS.has(reason)) return false;
  // The Worker reports bootstrap state before queue/fence state, so this reason
  // is compatible with either an empty or populated queue.
  if (reason === "projection_bootstrap_required") return true;
  if (pending > 0) {
    if (submitted === 0) return reason === "vector_work_queued";
    return reason === "accepted_mutation_processing" ||
      reason === "accepted_mutation_needs_confirmation";
  }
  // With no durable outbox row, only an outstanding provider fence, a count
  // mismatch, or the final exactness marker can explain non-readiness.
  if (reason === "accepted_mutation_processing") return true;
  if (!countsMatch) return reason === "vector_count_mismatch";
  return reason === "projection_unverified";
}

/**
 * Validate the aggregate projection fields carried together by the existing
 * authenticated /api/admin/brain/documents response. The route also contains
 * source rows; this function deliberately neither validates nor returns them.
 *
 * Health and update preview share this validator so a queue cannot be accepted
 * under one command and rejected under the other because their count rules
 * drifted apart.
 */
function validateProjectionAggregateFields(inventory, expectedBackend, {
  requireBoundedMetadata = false,
} = {}) {
  if (inventory.backend !== expectedBackend) {
    refuse("UPDATE_PREVIEW_DEPLOYED_BACKEND_MISMATCH");
  }
  const validCount = (value) => Number.isSafeInteger(value) && value >= 0;
  const backlog = inventory.vector_backlog;
  if (!backlog || typeof backlog !== "object" || Array.isArray(backlog) ||
      Object.hasOwn(backlog, "error") || !validCount(backlog.pending) ||
      !validCount(backlog.upserts) || !validCount(backlog.deletes) ||
      !validCount(backlog.submitted) || backlog.upserts + backlog.deletes !== backlog.pending ||
      backlog.submitted > backlog.pending) {
    refuse("UPDATE_PREVIEW_VECTOR_BACKLOG_INVALID");
  }
  const boundedFieldCount = BACKLOG_BOUNDED_FIELDS
    .filter((field) => Object.hasOwn(backlog, field)).length;
  const hasBacklogBoundedMetadata = boundedFieldCount === BACKLOG_BOUNDED_FIELDS.length;
  // Every Worker before the bounded documents summary reports the same 0.4.8
  // label and returns an exact SELECT count(*) outbox receipt with none of the
  // three bounded fields. That complete pre-summary shape is an exact count,
  // not missing evidence. Any partial field set matches no shipped Worker and
  // still refuses.
  const legacyExactReceipt = requireBoundedMetadata && boundedFieldCount === 0 &&
    exactKeys(backlog, LEGACY_EXACT_BACKLOG_FIELDS);
  if (requireBoundedMetadata && !hasBacklogBoundedMetadata && !legacyExactReceipt) {
    refuse("UPDATE_PREVIEW_VECTOR_BACKLOG_INVALID");
  }
  const pendingIsCapped = hasBacklogBoundedMetadata
    ? backlog.pending_is_capped === true
    : false;
  const componentCountsExact = hasBacklogBoundedMetadata
    ? backlog.component_counts_exact === true
    : true;
  if (hasBacklogBoundedMetadata && (
    typeof backlog.pending_is_capped !== "boolean" ||
    typeof backlog.component_counts_exact !== "boolean" ||
    backlog.pending_display !== (pendingIsCapped ? "10,000+" : String(backlog.pending)) ||
    pendingIsCapped !== !componentCountsExact ||
    (pendingIsCapped ? backlog.pending !== 10_001 : backlog.pending > 10_000)
  )) {
    refuse("UPDATE_PREVIEW_VECTOR_BACKLOG_INVALID");
  }
  const oldestQueuedAt = backlog.oldest_queued_at;
  if (!Object.hasOwn(backlog, "oldest_queued_at") ||
      (backlog.pending > 0 && !validCount(oldestQueuedAt)) ||
      (backlog.pending === 0 && oldestQueuedAt !== null)) {
    refuse("UPDATE_PREVIEW_QUEUE_TIMESTAMP_INVALID");
  }

  const readiness = inventory.vector_readiness;
  if (!readiness || typeof readiness !== "object" || Array.isArray(readiness) ||
      Object.hasOwn(readiness, "error") || typeof readiness.ready !== "boolean" ||
      !validCount(readiness.expected_vectors) || !validCount(readiness.actual_vectors) ||
      !validCount(readiness.pending) || !validCount(readiness.submitted) ||
      readiness.pending !== backlog.pending || readiness.submitted !== backlog.submitted ||
      readiness.submitted > readiness.pending) {
    refuse("UPDATE_PREVIEW_VECTOR_READINESS_INVALID");
  }
  const readinessBoundedFieldCount = ["pending_is_capped", "submitted_counts_exact"]
    .filter((field) => Object.hasOwn(readiness, field)).length;
  const hasReadinessBoundedMetadata = readinessBoundedFieldCount === 2;
  // The pre-summary Worker's readiness carries neither bounded field. Half of
  // the pair is never a shipped shape.
  if (requireBoundedMetadata && !hasReadinessBoundedMetadata &&
      !(legacyExactReceipt && readinessBoundedFieldCount === 0)) {
    refuse("UPDATE_PREVIEW_VECTOR_READINESS_INVALID");
  }
  if (hasReadinessBoundedMetadata && (
    typeof readiness.pending_is_capped !== "boolean" ||
    typeof readiness.submitted_counts_exact !== "boolean" ||
    readiness.pending_is_capped !== pendingIsCapped ||
    readiness.submitted_counts_exact !== componentCountsExact
  )) {
    refuse("UPDATE_PREVIEW_VECTOR_READINESS_INVALID");
  }
  const readinessOldestQueuedAt = readiness.oldest_queued_at;
  if (!Object.hasOwn(readiness, "oldest_queued_at") ||
      readinessOldestQueuedAt !== oldestQueuedAt) {
    refuse("UPDATE_PREVIEW_QUEUE_TIMESTAMP_INVALID");
  }
  if (!readinessReasonIsCoherent({
    ready: readiness.ready,
    reason: readiness.reason,
    expected: readiness.expected_vectors,
    actual: readiness.actual_vectors,
    pending: readiness.pending,
    submitted: readiness.submitted,
  })) {
    refuse("UPDATE_PREVIEW_VECTOR_READINESS_INVALID");
  }

  return {
    backend: expectedBackend,
    expected_vectors: readiness.expected_vectors,
    actual_vectors: readiness.actual_vectors,
    queue: {
      pending: backlog.pending,
      ...(requireBoundedMetadata ? {
        pending_is_capped: pendingIsCapped,
        pending_display: legacyExactReceipt ? String(backlog.pending) : backlog.pending_display,
        component_counts_exact: componentCountsExact,
        ...(legacyExactReceipt ? { count_receipt: LEGACY_EXACT_COUNT_RECEIPT } : {}),
      } : {}),
      upserts: backlog.upserts,
      deletes: backlog.deletes,
      submitted: backlog.submitted,
      oldest_queued_at: backlog.pending > 0 ? oldestQueuedAt : null,
    },
    query_ready: readiness.ready,
    readiness_reason: readiness.reason,
  };
}

export function validateVectorProjectionAggregateReceipt(inventory, options = {}) {
  const expectedVersion = options?.expectedVersion;
  const expectedBackend = options?.expectedBackend ?? "d1";
  const expectedDrainMode = options?.expectedDrainMode ?? "active";
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory) ||
      typeof expectedVersion !== "string" || !VERSION_RE.test(expectedVersion) ||
      expectedBackend !== "d1" ||
      !["active", "paused-for-upgrade"].includes(expectedDrainMode)) {
    refuse("UPDATE_PREVIEW_READINESS_RECEIPT_INVALID");
  }

  if (typeof inventory.version !== "string" || !VERSION_RE.test(inventory.version)) {
    refuse("UPDATE_PREVIEW_READINESS_RECEIPT_INVALID");
  }
  if (inventory.version !== expectedVersion) {
    refuse("UPDATE_PREVIEW_DEPLOYED_GENERATION_MISMATCH");
  }
  if (!["active", "paused-for-upgrade"].includes(inventory.vector_drain_mode)) {
    refuse("UPDATE_PREVIEW_READINESS_RECEIPT_INVALID");
  }
  if (inventory.vector_drain_mode !== expectedDrainMode) {
    if (inventory.vector_drain_mode === "paused-for-upgrade" && expectedDrainMode === "active") {
      refuse("UPDATE_PREVIEW_DEPLOYED_DRAIN_PAUSED");
    }
    refuse("UPDATE_PREVIEW_DEPLOYED_GENERATION_MISMATCH");
  }

  const aggregate = validateProjectionAggregateFields(inventory, expectedBackend, {
    requireBoundedMetadata: true,
  });
  return immutable({
    worker_version: inventory.version,
    backend: aggregate.backend,
    vector_drain_mode: inventory.vector_drain_mode,
    expected_vectors: aggregate.expected_vectors,
    actual_vectors: aggregate.actual_vectors,
    queue: aggregate.queue,
    query_ready: aggregate.query_ready,
    readiness_reason: aggregate.readiness_reason,
  });
}

function projectionAggregateVerdict(aggregate) {
  const shouldBeReady = aggregate.queue.pending === 0 &&
    aggregate.actual_vectors === aggregate.expected_vectors;
  if (aggregate.query_ready !== shouldBeReady) {
    refuse("UPDATE_PREVIEW_VECTOR_READINESS_INVALID");
  }
  return aggregate.actual_vectors > aggregate.expected_vectors
    ? "projection_excess"
    : aggregate.queue.pending > 0 &&
        (aggregate.queue.pending_is_capped || !aggregate.queue.component_counts_exact)
      ? "projection_work_queued_uncounted"
    : aggregate.actual_vectors < aggregate.expected_vectors
      ? aggregate.queue.pending > 0
        ? aggregate.queue.upserts >= aggregate.expected_vectors - aggregate.actual_vectors
          ? "recoverable_queued_work"
          : "projection_work_insufficient"
        : aggregate.readiness_reason === "accepted_mutation_processing"
          ? "projection_visibility_pending"
          : "projection_work_missing"
      : aggregate.queue.pending > 0 ? "queued_work_present" : "ready";
}

function checkedProjectionProof(value) {
  if (!exactKeys(value, [
    "worker_version", "backend", "vector_drain_mode", "expected_vectors",
    "actual_vectors", "queue", "query_ready", "readiness_reason", "verdict",
  ]) || typeof value.worker_version !== "string" || !VERSION_RE.test(value.worker_version) ||
      value.backend !== "d1" || value.vector_drain_mode !== "active" ||
      typeof value.query_ready !== "boolean" ||
      !(exactKeys(value.queue, PROOF_QUEUE_FIELDS) ||
        (exactKeys(value.queue, [...PROOF_QUEUE_FIELDS, "count_receipt"]) &&
          value.queue.count_receipt === LEGACY_EXACT_COUNT_RECEIPT))) {
    refuse("UPDATE_PREVIEW_PLAN_INVALID");
  }
  for (const count of [
    value.expected_vectors, value.actual_vectors, value.queue.pending,
    value.queue.upserts, value.queue.deletes, value.queue.submitted,
  ]) {
    safeInteger(count, 0, Number.MAX_SAFE_INTEGER, "UPDATE_PREVIEW_PLAN_INVALID");
  }
  const pending = value.queue.pending;
  const legacyExact = value.queue.count_receipt === LEGACY_EXACT_COUNT_RECEIPT;
  if (value.queue.upserts + value.queue.deletes !== pending ||
      value.queue.submitted > pending ||
      typeof value.queue.pending_is_capped !== "boolean" ||
      typeof value.queue.component_counts_exact !== "boolean" ||
      value.queue.pending_display !==
        (value.queue.pending_is_capped ? "10,000+" : String(pending)) ||
      value.queue.pending_is_capped !== !value.queue.component_counts_exact ||
      (legacyExact && (value.queue.pending_is_capped || !value.queue.component_counts_exact)) ||
      (value.queue.pending_is_capped ? pending !== 10_001 : !legacyExact && pending > 10_000) ||
      (pending > 0 && (!Number.isSafeInteger(value.queue.oldest_queued_at) ||
        value.queue.oldest_queued_at < 0)) ||
      (pending === 0 && value.queue.oldest_queued_at !== null)) {
    refuse("UPDATE_PREVIEW_PLAN_INVALID");
  }
  const relation = value.actual_vectors < value.expected_vectors
    ? "short"
    : value.actual_vectors === value.expected_vectors ? "exact" : "excess";
  const deficit = relation === "short"
    ? value.expected_vectors - value.actual_vectors
    : 0;
  const reasonIsQueued = [
    "accepted_mutation_needs_confirmation",
    "accepted_mutation_processing",
    "projection_bootstrap_required",
    "vector_work_queued",
  ].includes(value.readiness_reason);
  const reasonIsCoherent = readinessReasonIsCoherent({
    ready: value.query_ready,
    reason: value.readiness_reason,
    expected: value.expected_vectors,
    actual: value.actual_vectors,
    pending,
    submitted: value.queue.submitted,
  });
  const verdictMatches =
    reasonIsCoherent &&
    ((value.verdict === "ready" && pending === 0 && relation === "exact" &&
      value.query_ready === true && value.readiness_reason === null) ||
    (value.verdict === "recoverable_queued_work" && pending > 0 && relation === "short" &&
      value.queue.component_counts_exact && value.queue.upserts >= deficit &&
      value.query_ready === false && reasonIsQueued) ||
    (value.verdict === "projection_work_insufficient" && pending > 0 && relation === "short" &&
      value.queue.component_counts_exact && value.queue.upserts < deficit &&
      value.query_ready === false && reasonIsQueued) ||
    (value.verdict === "projection_work_queued_uncounted" && pending > 0 &&
      !value.queue.component_counts_exact && value.query_ready === false && reasonIsQueued) ||
    (value.verdict === "queued_work_present" && pending > 0 && relation === "exact" &&
      value.query_ready === false && reasonIsQueued) ||
    (value.verdict === "projection_work_missing" && pending === 0 && relation === "short" &&
      value.query_ready === false && ["vector_count_mismatch", "projection_bootstrap_required"]
        .includes(value.readiness_reason)) ||
    (value.verdict === "projection_visibility_pending" && pending === 0 && relation === "short" &&
      value.query_ready === false && value.readiness_reason === "accepted_mutation_processing") ||
    (value.verdict === "projection_excess" && relation === "excess" &&
      value.query_ready === false && typeof value.readiness_reason === "string"));
  if (!verdictMatches) refuse("UPDATE_PREVIEW_PLAN_INVALID");
  return value;
}

/**
 * Convert one coherent private inventory response into the only aggregate
 * states update preview may expose. A missing or insufficient upsert queue and
 * a short projection is refused because that work cannot repair the deficit.
 */
export function classifyUpdatePreviewProjectionReceipt(inventory, options = {}) {
  const aggregate = validateVectorProjectionAggregateReceipt(inventory, {
    expectedVersion: options?.expectedVersion,
    expectedBackend: options?.expectedBackend ?? "d1",
    expectedDrainMode: "active",
  });
  const verdict = projectionAggregateVerdict(aggregate);
  return checkedProjectionProof(immutable({ ...aggregate, verdict }));
}

/**
 * Validate only the authenticated aggregate envelope shipped through v0.4.6.
 * The response does not bind Worker generation or drain mode, so this function
 * returns an observation and can never produce projection readiness.
 */
export function classifyLegacyV046ProjectionObservation(inventory, options = {}) {
  const expectedVersion = options?.expectedVersion;
  const expectedBackend = options?.expectedBackend ?? "d1";
  if (!isLegacyPre047Version(expectedVersion) || expectedBackend !== "d1" ||
      !exactKeys(inventory, ["backend", "rows", "vector_backlog", "vector_readiness"]) ||
      !Array.isArray(inventory.rows)) {
    refuse("UPDATE_PREVIEW_READINESS_RECEIPT_INVALID");
  }
  const aggregate = validateProjectionAggregateFields(inventory, expectedBackend);
  const verdict = projectionAggregateVerdict(aggregate);
  return immutable({
    backend: aggregate.backend,
    expected_vectors: aggregate.expected_vectors,
    actual_vectors: aggregate.actual_vectors,
    queue: aggregate.queue,
    worker_reported_query_ready: aggregate.query_ready,
    worker_reported_readiness_reason: aggregate.readiness_reason,
    worker_reported_verdict: verdict,
  });
}

function checkedRuntimeProof(value) {
  if (!exactKeys(value, [
    "schema_version", "identity_scheme", "runtime_payload_sha256", "file_count",
    "total_bytes", "expected_runtime_sha256", "verified_passes",
  ]) || value.schema_version !== UPDATE_PREVIEW_SCHEMA_VERSION ||
      value.identity_scheme !== UPDATE_RUNTIME_IDENTITY_SCHEME || value.verified_passes !== 2 ||
      safeSha256(value.runtime_payload_sha256, "UPDATE_PREVIEW_PLAN_INVALID") !==
        safeSha256(value.expected_runtime_sha256, "UPDATE_PREVIEW_PLAN_INVALID")) {
    refuse("UPDATE_PREVIEW_PLAN_INVALID");
  }
  safeInteger(value.file_count, 1, UPDATE_PREVIEW_LIMITS.files, "UPDATE_PREVIEW_PLAN_INVALID");
  safeInteger(value.total_bytes, 0, UPDATE_PREVIEW_LIMITS.total_bytes,
    "UPDATE_PREVIEW_PLAN_INVALID");
  return value;
}

function checkedLegacyProjectionObservation(value) {
  if (!exactKeys(value, [
    "backend", "expected_vectors", "actual_vectors", "queue",
    "worker_reported_query_ready", "worker_reported_readiness_reason",
    "worker_reported_verdict",
  ]) || !exactKeys(value.queue, [
    "pending", "upserts", "deletes", "submitted", "oldest_queued_at",
  ])) {
    refuse("UPDATE_PREVIEW_PLAN_INVALID");
  }
  let rebuilt;
  try {
    rebuilt = classifyLegacyV046ProjectionObservation({
      backend: value.backend,
      rows: [],
      vector_backlog: {
        pending: value.queue.pending,
        upserts: value.queue.upserts,
        deletes: value.queue.deletes,
        submitted: value.queue.submitted,
        oldest_queued_at: value.queue.oldest_queued_at,
      },
      vector_readiness: {
        ready: value.worker_reported_query_ready,
        reason: value.worker_reported_readiness_reason,
        expected_vectors: value.expected_vectors,
        actual_vectors: value.actual_vectors,
        pending: value.queue.pending,
        submitted: value.queue.submitted,
        oldest_queued_at: value.queue.oldest_queued_at,
      },
    }, { expectedVersion: "0.4.6", expectedBackend: "d1" });
  } catch {
    refuse("UPDATE_PREVIEW_PLAN_INVALID");
  }
  if (canonical(rebuilt) !== canonical(value)) refuse("UPDATE_PREVIEW_PLAN_INVALID");
  return rebuilt;
}

/**
 * Bind a manifest-recorded pre-v0.4.7 aggregate observation to the exact local
 * candidate.
 * This is deliberately not an update plan because the live response omits the
 * fields needed to exclude a mixed Worker generation.
 */
export function createLegacyV046UpdatePreviewObservation(options = {}) {
  const required = [
    "manifestSha256", "manifestSource", "candidateVersion", "runtimeProof",
    "deployedObservation",
  ];
  const allowed = new Set([...required, "recordedVersion"]);
  if (!options || typeof options !== "object" || Array.isArray(options) ||
      required.some((name) => !Object.hasOwn(options, name)) ||
      Object.keys(options).some((name) => !allowed.has(name))) {
    refuse("UPDATE_PREVIEW_PLAN_INVALID");
  }
  const {
    manifestSha256,
    manifestSource,
    recordedVersion = null,
    candidateVersion,
    runtimeProof,
    deployedObservation,
  } = options;
  safeSha256(manifestSha256, "UPDATE_PREVIEW_PLAN_INVALID");
  if (!MANIFEST_SOURCES.has(manifestSource) || !isLegacyPre047Version(recordedVersion)) {
    refuse("UPDATE_PREVIEW_PLAN_INVALID");
  }
  const relation = updatePreviewVersionRelation(recordedVersion, candidateVersion);
  const runtime = checkedRuntimeProof(runtimeProof);
  const projection = checkedLegacyProjectionObservation(deployedObservation);
  return immutable({
    schema_version: UPDATE_PREVIEW_SCHEMA_VERSION,
    operation: "brain.update.legacy-observation",
    manifest: {
      source: manifestSource,
      sha256: manifestSha256,
      recorded_version: recordedVersion,
    },
    candidate: {
      version: candidateVersion,
      identity_scheme: runtime.identity_scheme,
      expected_runtime_sha256: runtime.expected_runtime_sha256,
      observed_runtime_sha256: runtime.runtime_payload_sha256,
      file_count: runtime.file_count,
      total_bytes: runtime.total_bytes,
    },
    response_contract: "brain.documents.v0.4.6.legacy",
    deployed_projection_observation: projection,
    generation_binding: "absent_from_authenticated_response",
    drain_mode_binding: "absent_from_authenticated_response",
    mixed_generation_excluded: false,
    version_relation: relation,
    live_verification_required: true,
    update_gate_satisfied: false,
  });
}

function checkedLegacyV046UpdatePreviewObservation(value) {
  if (!exactKeys(value, [
    "schema_version", "operation", "manifest", "candidate", "response_contract",
    "deployed_projection_observation", "generation_binding", "drain_mode_binding",
    "mixed_generation_excluded", "version_relation", "live_verification_required",
    "update_gate_satisfied",
  ]) || value.schema_version !== UPDATE_PREVIEW_SCHEMA_VERSION ||
      value.operation !== "brain.update.legacy-observation" ||
      value.response_contract !== "brain.documents.v0.4.6.legacy" ||
      value.generation_binding !== "absent_from_authenticated_response" ||
      value.drain_mode_binding !== "absent_from_authenticated_response" ||
      value.mixed_generation_excluded !== false ||
      value.live_verification_required !== true || value.update_gate_satisfied !== false ||
      !exactKeys(value.manifest, ["source", "sha256", "recorded_version"]) ||
      !exactKeys(value.candidate, [
        "version", "identity_scheme", "expected_runtime_sha256", "observed_runtime_sha256",
        "file_count", "total_bytes",
      ])) {
    refuse("UPDATE_PREVIEW_PLAN_INVALID");
  }
  const rebuilt = createLegacyV046UpdatePreviewObservation({
    manifestSha256: value.manifest.sha256,
    manifestSource: value.manifest.source,
    recordedVersion: value.manifest.recorded_version,
    candidateVersion: value.candidate.version,
    runtimeProof: {
      schema_version: UPDATE_PREVIEW_SCHEMA_VERSION,
      identity_scheme: value.candidate.identity_scheme,
      runtime_payload_sha256: value.candidate.observed_runtime_sha256,
      file_count: value.candidate.file_count,
      total_bytes: value.candidate.total_bytes,
      expected_runtime_sha256: value.candidate.expected_runtime_sha256,
      verified_passes: 2,
    },
    deployedObservation: value.deployed_projection_observation,
  });
  if (canonical(rebuilt) !== canonical(value)) refuse("UPDATE_PREVIEW_PLAN_INVALID");
  return rebuilt;
}

/** Build the closed, aggregate-only plan that binds both local and live proof. */
export function createUpdatePreviewPlan(options = {}) {
  const required = [
    "manifestSha256", "manifestSource", "candidateVersion", "runtimeProof",
    "deployedProjection",
  ];
  const allowed = new Set([...required, "recordedVersion"]);
  if (!options || typeof options !== "object" || Array.isArray(options) ||
      required.some((name) => !Object.hasOwn(options, name)) ||
      Object.keys(options).some((name) => !allowed.has(name))) {
    refuse("UPDATE_PREVIEW_PLAN_INVALID");
  }
  const {
    manifestSha256,
    manifestSource,
    recordedVersion = null,
    candidateVersion,
    runtimeProof,
    deployedProjection,
  } = options;
  safeSha256(manifestSha256, "UPDATE_PREVIEW_PLAN_INVALID");
  if (!MANIFEST_SOURCES.has(manifestSource)) refuse("UPDATE_PREVIEW_PLAN_INVALID");
  const relation = updatePreviewVersionRelation(recordedVersion, candidateVersion);
  const runtime = checkedRuntimeProof(runtimeProof);
  const projection = checkedProjectionProof(deployedProjection);
  if (projection.worker_version !== recordedVersion) {
    refuse("UPDATE_PREVIEW_PLAN_INVALID");
  }
  return immutable({
    schema_version: UPDATE_PREVIEW_SCHEMA_VERSION,
    operation: "brain.update",
    manifest: {
      source: manifestSource,
      sha256: manifestSha256,
      recorded_version: recordedVersion,
    },
    candidate: {
      version: candidateVersion,
      identity_scheme: runtime.identity_scheme,
      expected_runtime_sha256: runtime.expected_runtime_sha256,
      observed_runtime_sha256: runtime.runtime_payload_sha256,
      file_count: runtime.file_count,
      total_bytes: runtime.total_bytes,
    },
    deployed_projection: projection,
    version_relation: relation,
    live_verification_required: true,
  });
}

function checkedPlan(plan) {
  if (!exactKeys(plan, [
    "schema_version", "operation", "manifest", "candidate", "deployed_projection",
    "version_relation", "live_verification_required",
  ]) || plan.schema_version !== UPDATE_PREVIEW_SCHEMA_VERSION || plan.operation !== "brain.update" ||
      plan.live_verification_required !== true ||
      !exactKeys(plan.manifest, ["source", "sha256", "recorded_version"]) ||
      !exactKeys(plan.candidate, [
        "version", "identity_scheme", "expected_runtime_sha256", "observed_runtime_sha256",
        "file_count", "total_bytes",
      ])) {
    refuse("UPDATE_PREVIEW_PLAN_INVALID");
  }
  const rebuilt = createUpdatePreviewPlan({
    manifestSha256: plan.manifest.sha256,
    manifestSource: plan.manifest.source,
    recordedVersion: plan.manifest.recorded_version,
    candidateVersion: plan.candidate.version,
    runtimeProof: {
      schema_version: UPDATE_PREVIEW_SCHEMA_VERSION,
      identity_scheme: plan.candidate.identity_scheme,
      runtime_payload_sha256: plan.candidate.observed_runtime_sha256,
      file_count: plan.candidate.file_count,
      total_bytes: plan.candidate.total_bytes,
      expected_runtime_sha256: plan.candidate.expected_runtime_sha256,
      verified_passes: 2,
    },
    deployedProjection: plan.deployed_projection,
  });
  if (canonical(rebuilt) !== canonical(plan)) refuse("UPDATE_PREVIEW_PLAN_INVALID");
  return rebuilt;
}

/** Fingerprint only the closed plan, never raw paths, manifest fields, or file bytes. */
export function updatePreviewPlanFingerprint(plan) {
  const checked = checkedPlan(plan);
  return createHash("sha256").update(FINGERPRINT_DOMAIN).update(canonical(checked)).digest("hex");
}

/** Fingerprint legacy evidence under a domain that cannot be mistaken for a plan. */
export function legacyV046UpdatePreviewObservationFingerprint(observation) {
  const checked = checkedLegacyV046UpdatePreviewObservation(observation);
  return createHash("sha256")
    .update(LEGACY_OBSERVATION_FINGERPRINT_DOMAIN)
    .update(canonical(checked))
    .digest("hex");
}

function receiptEffects(observed = {}, { requireLiveRead = false } = {}) {
  const credentialReads = observed?.credential_reads;
  const networkRequests = observed?.network_requests;
  if (![credentialReads, networkRequests].every((value) =>
    Number.isSafeInteger(value) && value >= 0 && value <= 1) ||
      (requireLiveRead && (credentialReads !== 1 || networkRequests !== 1))) {
    refuse("UPDATE_PREVIEW_PLAN_INVALID");
  }
  return { ...ZERO_EFFECTS, credential_reads: credentialReads, network_requests: networkRequests };
}

/**
 * Return a closed, non-green receipt for the pre-v0.4.7 legacy
 * contract.
 * A complete aggregate observation is useful evidence, but it cannot satisfy
 * the update gate without same-response generation and drain-mode fields.
 */
export function createLegacyV046UpdatePreviewReceipt(observation, observedEffects) {
  const checked = checkedLegacyV046UpdatePreviewObservation(observation);
  return immutable({
    schema_version: UPDATE_PREVIEW_SCHEMA_VERSION,
    operation: UPDATE_PREVIEW_OPERATION,
    status: "legacy_observation_complete",
    read_only: true,
    authorizes_update: false,
    projection_ready: false,
    error_code: "UPDATE_PREVIEW_LEGACY_GENERATION_UNBOUND",
    legacy_observation: checked,
    observation_fingerprint: legacyV046UpdatePreviewObservationFingerprint(checked),
    proof_boundary: { ...LEGACY_OBSERVATION_PROOF_BOUNDARY },
    effects: receiptEffects(observedEffects, { requireLiveRead: true }),
  });
}

/** Tell the owner, where the receipt already describes the queue, why it is exact. */
function legacyExactBacklogNote(plan) {
  return plan.deployed_projection.queue.count_receipt === LEGACY_EXACT_COUNT_RECEIPT
    ? { owner_note: LEGACY_EXACT_BACKLOG_NOTE }
    : {};
}

/** Return a non-authorizing receipt that includes one live aggregate proof. */
export function createUpdatePreviewSuccessReceipt(plan, observedEffects) {
  const checked = checkedPlan(plan);
  if ([
    "projection_work_insufficient", "projection_work_missing",
    "projection_work_queued_uncounted", "projection_visibility_pending", "projection_excess",
  ]
      .includes(checked.deployed_projection.verdict)) {
    refuse("UPDATE_PREVIEW_PLAN_INVALID");
  }
  return immutable({
    schema_version: UPDATE_PREVIEW_SCHEMA_VERSION,
    operation: UPDATE_PREVIEW_OPERATION,
    status: "pre_update_check_complete",
    read_only: true,
    authorizes_update: false,
    projection_ready: checked.deployed_projection.verdict === "ready",
    ...legacyExactBacklogNote(checked),
    plan: checked,
    plan_fingerprint: updatePreviewPlanFingerprint(checked),
    proof_boundary: { ...PROOF_BOUNDARY },
    effects: receiptEffects(observedEffects, { requireLiveRead: true }),
  });
}

/**
 * Preserve a trustworthy aggregate refusal under the same plan fingerprint as
 * a successful check. The queued count is evidence, not a detail that can be
 * replaced while retaining the receipt identity.
 */
export function createUpdatePreviewProjectionFailureReceipt(plan, observedEffects) {
  const checked = checkedPlan(plan);
  const verdict = checked.deployed_projection.verdict;
  const errorCode = verdict === "projection_work_insufficient"
    ? "UPDATE_PREVIEW_PROJECTION_WORK_INSUFFICIENT"
    : verdict === "projection_work_queued_uncounted"
      ? "UPDATE_PREVIEW_PROJECTION_WORK_UNCOUNTED"
    : verdict === "projection_work_missing"
      ? "UPDATE_PREVIEW_PROJECTION_WORK_MISSING"
    : verdict === "projection_visibility_pending"
      ? "UPDATE_PREVIEW_PROJECTION_VISIBILITY_PENDING"
      : verdict === "projection_excess"
        ? "UPDATE_PREVIEW_PROJECTION_EXCESS"
        : null;
  if (!errorCode) refuse("UPDATE_PREVIEW_PLAN_INVALID");
  return immutable({
    schema_version: UPDATE_PREVIEW_SCHEMA_VERSION,
    operation: UPDATE_PREVIEW_OPERATION,
    status: "failed",
    read_only: true,
    authorizes_update: false,
    projection_ready: false,
    error_code: errorCode,
    ...(verdict === "projection_work_queued_uncounted" ? {
      owner_message: "A large indexing queue is still working; wait for it before updating.",
    } : {}),
    ...legacyExactBacklogNote(checked),
    plan: checked,
    plan_fingerprint: updatePreviewPlanFingerprint(checked),
    proof_boundary: { ...PROOF_BOUNDARY },
    effects: receiptEffects(observedEffects, { requireLiveRead: true }),
  });
}

/** Collapse every failure to a closed code; raw Error messages are never copied. */
export function createUpdatePreviewFailureReceipt(errorOrCode, observedEffects = {
  credential_reads: 0,
  network_requests: 0,
}) {
  const requested = typeof errorOrCode === "string"
    ? errorOrCode
    : errorOrCode instanceof UpdatePreviewError ? errorOrCode.code : null;
  const errorCode = FAILURE_CODES.has(requested) ? requested : "UPDATE_PREVIEW_FAILED";
  return immutable({
    schema_version: UPDATE_PREVIEW_SCHEMA_VERSION,
    operation: UPDATE_PREVIEW_OPERATION,
    status: "failed",
    read_only: true,
    authorizes_update: false,
    projection_ready: false,
    error_code: errorCode,
    effects: receiptEffects(observedEffects),
  });
}
