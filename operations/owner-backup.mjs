/**
 * Owner-held local recovery points.
 *
 * D1 Time Travel is already continuous. A backup therefore needs to preserve
 * the local half of the install and one exact UTC reference, not copy the
 * corpus through the CLI. The adjacent admin-key file is intentionally outside
 * every allowlist below.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { encryptRecoveryArtifact } from "./recovery-artifact-crypto.mjs";
import { scan } from "../worker/src/lib/secret-scan.js";

const CONTRACT_VERSION = 1;
const ENTRY_RE = /^backup-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)-([a-f0-9]{16})$/;
const STATE_RE = /^\.brain-ingest-[a-z0-9][a-z0-9_-]{0,63}\.json$/;
const SAFE_FILES = new Set(["brain.manifest.json", "receipt.json", "backup.fbrenc"]);
const MAX_LOCAL_FILE_BYTES = 128 * 1024 * 1024;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactUtc(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("backup time must be valid");
  return date.toISOString();
}

function assertPrivateDirectory(path, { create = false } = {}) {
  const absolute = resolve(path);
  if (create && !existsSync(absolute)) mkdirSync(absolute, { mode: 0o700 });
  const state = lstatSync(absolute);
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error("the owner backup folder must be one real directory");
  }
  if (typeof process.getuid === "function" && state.uid !== process.getuid()) {
    throw new Error("the owner backup folder must belong to the current user");
  }
  if (process.platform !== "win32" && (state.mode & 0o077) !== 0) {
    chmodSync(absolute, 0o700);
    const secured = lstatSync(absolute);
    if ((secured.mode & 0o077) !== 0) throw new Error("the owner backup folder must be owner-only");
  }
  return absolute;
}

function stablePrivateFile(path) {
  const absolute = resolve(path);
  const fd = openSync(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd);
    const named = lstatSync(absolute);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== named.dev || opened.ino !== named.ino ||
        opened.size > MAX_LOCAL_FILE_BYTES) {
      throw new Error("a backup input is not one stable bounded regular file");
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) {
      bytes.fill(0);
      throw new Error("a backup input changed while it was read");
    }
    return { absolute, bytes, mode: opened.mode & 0o777 };
  } finally {
    closeSync(fd);
  }
}

function writeNewPrivateFile(path, bytes) {
  const fd = openSync(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 ||
        (process.platform !== "win32" && (opened.mode & 0o077) !== 0)) {
      throw new Error("a backup output could not be made owner-only");
    }
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("a backup output write was incomplete");
      offset += count;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readManifest(manifestPath) {
  const source = stablePrivateFile(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(source.bytes.toString("utf8"));
  } catch (error) {
    source.bytes.fill(0);
    throw new Error(`the backup manifest is invalid JSON: ${error.message}`);
  }
  try {
    assertManifestCredentialLocators(manifest);
    assertBackupBytesSafe(source.bytes, "manifest");
  } catch (error) {
    source.bytes.fill(0);
    throw error;
  }
  return { source, manifest };
}

const SECRET_FIELD_RE = /(?:^|_)(?:secret|password|passphrase|token|credential|api_key|admin_key|private_key|access_key|signing_key|wrapping_key)$/i;
const PROTECTED_LOCATOR_RE = /^(?:keychain:\/\/[^/]+\/.+|secret:\/\/[A-Z][A-Z0-9_]*)$/;

function assertManifestCredentialLocators(manifest) {
  const seen = new Set();
  const visit = (value, path = []) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const [key, item] of Object.entries(value)) {
      const next = [...path, key];
      if (SECRET_FIELD_RE.test(key) && item !== null && item !== undefined &&
          (typeof item !== "string" || !PROTECTED_LOCATOR_RE.test(item))) {
        throw new Error(`the manifest's ${next.join(".")} field is not a protected-store locator; refusing to copy it`);
      }
      visit(item, next);
    }
  };
  visit(manifest);
}

function assertBackupBytesSafe(bytes, label) {
  const result = scan(bytes.toString("utf8"));
  if (result.shouldRefuse) {
    throw new Error(`${label} contains credential-like material; refusing to publish an owner backup`);
  }
}

export function ownerBackupConfiguration(manifestPath, manifest) {
  const config = manifest?.operations?.backup || {};
  const configured = config.directory;
  const directory = configured
    ? resolve(dirname(resolve(manifestPath)), String(configured))
    : join(dirname(resolve(manifestPath)), "brain-backups");
  const retentionDays = config.retention_days ?? 30;
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new Error("operations.backup.retention_days must be an integer from 1 to 3650");
  }
  return Object.freeze({
    directory,
    retentionDays,
    encrypt: config.encrypt === true,
    encryptionKeySecret: config.encryption_key_secret || null,
    cron: config.cron || "0 3 * * *",
  });
}

function defaultStateFiles(manifestPath) {
  const directory = dirname(resolve(manifestPath));
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && STATE_RE.test(entry.name))
    .map((entry) => join(directory, entry.name))
    .sort();
}

function nonceValue(value) {
  const nonce = value || randomBytes(8).toString("hex");
  if (!/^[a-f0-9]{16}$/.test(nonce)) throw new TypeError("backup nonce must be 16 lowercase hex characters");
  return nonce;
}

function safeBackupInput(path, manifestDirectory) {
  const absolute = resolve(path);
  const name = basename(absolute);
  if (dirname(absolute) !== manifestDirectory || !STATE_RE.test(name)) {
    throw new Error("a backup state file fell outside the state-file allowlist");
  }
  return { absolute, name };
}

function canonicalReceipt(receipt) {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

/** Create one complete local snapshot without reading the admin credential or corpus. */
export async function createOwnerBackup(manifestPath, options = {}) {
  const { source: manifestSource, manifest } = readManifest(manifestPath);
  const manifestDirectory = dirname(manifestSource.absolute);
  const configuration = ownerBackupConfiguration(manifestSource.absolute, manifest);
  const timestamp = exactUtc((options.now ?? (() => new Date()))());
  const nonce = nonceValue(options.nonce);
  const entryName = `backup-${timestamp.replaceAll(":", "-")}-${nonce}`;
  let partial = null;
  let destination = null;
  const created = [];
  const inputs = [{ name: "brain.manifest.json", ...manifestSource }];
  try {
    const listed = (options.listStateFiles ?? defaultStateFiles)(manifestSource.absolute);
    if (!Array.isArray(listed)) throw new Error("the backup state-file inventory is invalid");
    for (const candidate of listed) {
      const safe = safeBackupInput(candidate, manifestDirectory);
      const input = { name: safe.name, ...stablePrivateFile(safe.absolute) };
      inputs.push(input);
      assertBackupBytesSafe(input.bytes, "a resumable state file");
    }

    // Validate every byte before even creating the configured backup root. A
    // refusal must not leave a directory that can be mistaken for a published
    // recovery point.
    const root = assertPrivateDirectory(configuration.directory, { create: true });
    partial = join(root, `.${entryName}.partial`);
    destination = join(root, entryName);
    if (existsSync(partial) || existsSync(destination)) {
      throw new Error("the owner backup destination already exists");
    }
    mkdirSync(partial, { mode: 0o700 });

    const contents = inputs.map((input) => ({
      name: input.name,
      bytes: input.bytes.length,
      sha256: sha256(input.bytes),
    }));
    let files = contents;
    if (configuration.encrypt) {
      if (!configuration.encryptionKeySecret) {
        throw new Error("encrypted owner backups require operations.backup.encryption_key_secret");
      }
      const resolveKey = options.resolveEncryptionKey;
      if (typeof resolveKey !== "function") {
        throw new Error("encrypted owner backups require the declared protected key reader");
      }
      const key = await resolveKey(configuration.encryptionKeySecret);
      const bundle = join(partial, ".backup-plaintext-bundle.json");
      const bundleBytes = Buffer.from(JSON.stringify({
        contract_version: 1,
        kind: "financial_brain_owner_backup_bundle",
        files: inputs.map((input) => ({ name: input.name, data: input.bytes.toString("base64") })),
      }), "utf8");
      try {
        writeNewPrivateFile(bundle, bundleBytes);
        created.push(bundle);
        const encrypted = join(partial, "backup.fbrenc");
        await encryptRecoveryArtifact(bundle, encrypted, key);
        created.push(encrypted);
        unlinkSync(bundle);
        created.splice(created.indexOf(bundle), 1);
        const encryptedState = stablePrivateFile(encrypted);
        try {
          files = [{ name: "backup.fbrenc", bytes: encryptedState.bytes.length, sha256: sha256(encryptedState.bytes) }];
        } finally {
          encryptedState.bytes.fill(0);
        }
      } finally {
        bundleBytes.fill(0);
      }
    } else {
      for (const input of inputs) {
        const output = join(partial, input.name);
        writeNewPrivateFile(output, input.bytes);
        created.push(output);
      }
    }
    const receipt = {
      contract_version: CONTRACT_VERSION,
      kind: "financial_brain_owner_backup",
      created_at: timestamp,
      reason: String(options.reason || "manual").slice(0, 64),
      restore_point: {
        timestamp,
        bookmark: options.bookmark ? String(options.bookmark) : null,
      },
      encryption: configuration.encrypt ? "aes-256-gcm" : "none",
      files,
      ...(configuration.encrypt ? { contents } : {}),
      action_status: "prepared",
    };
    const receiptBytes = canonicalReceipt(receipt);
    try {
      writeNewPrivateFile(join(partial, "receipt.json"), receiptBytes);
      created.push(join(partial, "receipt.json"));
    } finally {
      receiptBytes.fill(0);
    }
    renameSync(partial, destination);
    return Object.freeze({
      path: destination,
      receipt,
      files: contents,
      restorePoint: receipt.restore_point,
    });
  } catch (error) {
    for (const path of created.reverse()) {
      try { unlinkSync(path); } catch { /* preserve the primary failure */ }
    }
    if (partial) {
      try { rmdirSync(partial); } catch { /* a surprising residue is retained for review */ }
    }
    throw error;
  } finally {
    for (const input of inputs) input.bytes.fill(0);
    if (!inputs.some((input) => input.bytes === manifestSource.bytes)) manifestSource.bytes.fill(0);
  }
}

function readOwnedReceipt(entryPath) {
  const name = basename(entryPath);
  if (!ENTRY_RE.test(name)) return null;
  let parsed;
  try {
    const directory = lstatSync(entryPath);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return null;
    const file = stablePrivateFile(join(entryPath, "receipt.json"));
    try { parsed = JSON.parse(file.bytes.toString("utf8")); } finally { file.bytes.fill(0); }
  } catch {
    return null;
  }
  if (parsed?.contract_version !== CONTRACT_VERSION || parsed?.kind !== "financial_brain_owner_backup" ||
      typeof parsed?.created_at !== "string" || !Number.isFinite(Date.parse(parsed.created_at)) ||
      !Array.isArray(parsed?.files)) return null;
  return parsed;
}

function removeOwnedEntry(entryPath, receipt) {
  const allowed = new Set(["receipt.json", ...receipt.files.map((file) => file.name)]);
  const entries = readdirSync(entryPath, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile() || !allowed.has(entry.name) ||
      (!SAFE_FILES.has(entry.name) && !STATE_RE.test(entry.name)))) return false;
  for (const entry of entries) {
    const path = join(entryPath, entry.name);
    const state = lstatSync(path);
    if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1) return false;
  }
  for (const entry of entries) unlinkSync(join(entryPath, entry.name));
  rmdirSync(entryPath);
  return true;
}

export function pruneOwnerBackups(manifestPath, options = {}) {
  const { source, manifest } = readManifest(manifestPath);
  source.bytes.fill(0);
  const configuration = ownerBackupConfiguration(manifestPath, manifest);
  if (!existsSync(configuration.directory)) return { removed: [], retained: [] };
  const root = assertPrivateDirectory(configuration.directory);
  const nowMs = exactUtc((options.now ?? (() => new Date()))());
  const cutoff = Date.parse(nowMs) - configuration.retentionDays * 86_400_000;
  const removed = [];
  const retained = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !ENTRY_RE.test(entry.name)) continue;
    const path = join(root, entry.name);
    const receipt = readOwnedReceipt(path);
    if (!receipt || Date.parse(receipt.created_at) >= cutoff) {
      retained.push(path);
      continue;
    }
    if (removeOwnedEntry(path, receipt)) removed.push(path);
    else retained.push(path);
  }
  return { removed: removed.sort(), retained: retained.sort() };
}

export function latestOwnerRestorePoint(manifestPath, options = {}) {
  const { source, manifest } = readManifest(manifestPath);
  source.bytes.fill(0);
  const configuration = ownerBackupConfiguration(manifestPath, manifest);
  if (!existsSync(configuration.directory)) return null;
  const root = assertPrivateDirectory(configuration.directory);
  const candidates = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    const receipt = readOwnedReceipt(path);
    if (receipt && (!Array.isArray(options.reasons) || options.reasons.includes(receipt.reason))) {
      candidates.push({ path, receipt });
    }
  }
  candidates.sort((left, right) => right.receipt.created_at.localeCompare(left.receipt.created_at));
  return candidates[0] || null;
}

/**
 * A D1 restore makes later local cursors untrue. Remove only the adjacent
 * resumable-state allowlist after the pre-restore snapshot has completed so
 * the next ingest must perform a full comparison against restored D1 truth.
 */
export function resetOwnerIngestState(manifestPath, options = {}) {
  const absoluteManifest = resolve(manifestPath);
  const manifestDirectory = dirname(absoluteManifest);
  const listed = (options.listStateFiles ?? defaultStateFiles)(absoluteManifest);
  if (!Array.isArray(listed)) throw new Error("the restore state-file inventory is invalid");
  const files = listed.map((candidate) => safeBackupInput(candidate, manifestDirectory));
  for (const file of files) {
    const input = stablePrivateFile(file.absolute);
    input.bytes.fill(0);
  }
  for (const file of files) unlinkSync(file.absolute);
  return Object.freeze({ reset: files.length });
}

/** Persist the aggregate before/after proof beside, but outside, snapshot entries. */
export function writeOwnerRestoreReceipt(manifestPath, receipt, options = {}) {
  const { source, manifest } = readManifest(manifestPath);
  source.bytes.fill(0);
  const configuration = ownerBackupConfiguration(manifestPath, manifest);
  const root = assertPrivateDirectory(configuration.directory, { create: true });
  const recordedAt = exactUtc((options.now ?? (() => new Date()))());
  const fingerprint = String(receipt?.approval_fingerprint || "");
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new TypeError("restore receipt needs its approval fingerprint");
  const name = `restore-${recordedAt.replaceAll(":", "-")}-${fingerprint.slice(0, 16)}.json`;
  const bytes = canonicalReceipt({ ...receipt, recorded_at: recordedAt });
  try {
    writeNewPrivateFile(join(root, name), bytes);
  } finally {
    bytes.fill(0);
  }
  return join(root, name);
}
