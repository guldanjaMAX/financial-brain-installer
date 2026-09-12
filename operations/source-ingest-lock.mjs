import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const OWNER_FILE_RE = /^owner-([1-9][0-9]*)-([a-f0-9]{32})\.json$/;
const MIN_STALE_MS = 120_000;

export class SourceIngestLockError extends Error {
  constructor(message, { code, retryable = false } = {}) {
    super(message);
    this.name = "SourceIngestLockError";
    this.code = code || "source_ingest_lock_failed";
    this.retryable = retryable;
  }
}

function lockError(message, code, retryable = false) {
  return new SourceIngestLockError(message, { code, retryable });
}

function assertPrivateDirectory(path, label, platform = process.platform) {
  const state = lstatSync(path);
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw lockError(`the local ${label} must be a real directory`, "source_ingest_lock_unsafe");
  }
  if (platform !== "win32") {
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
    if ((expectedUid !== null && state.uid !== expectedUid) || (state.mode & 0o077) !== 0) {
      throw lockError(
        `the local ${label} must be private to the current user`,
        "source_ingest_lock_unsafe",
      );
    }
  }
  return state;
}

function mkdirIfMissing(path) {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

function securePrivateDirectory(path, label, platform) {
  if (platform === "win32") return assertPrivateDirectory(path, label, platform);

  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (["ELOOP", "ENOTDIR"].includes(error?.code)) {
      throw lockError(`the local ${label} must be a real directory`, "source_ingest_lock_unsafe");
    }
    throw error;
  }
  try {
    const state = fstatSync(fd);
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!state.isDirectory()) {
      throw lockError(`the local ${label} must be a real directory`, "source_ingest_lock_unsafe");
    }
    if (expectedUid !== null && state.uid !== expectedUid) {
      throw lockError(`the local ${label} must be private to the current user`, "source_ingest_lock_unsafe");
    }

    // Tighten a verified real directory through its open descriptor. A path
    // swapped to a symlink cannot redirect this chmod to another target.
    fchmodSync(fd, 0o700);
    const secured = fstatSync(fd);
    const current = lstatSync(path);
    if (!current.isDirectory() || current.isSymbolicLink() ||
        current.dev !== secured.dev || current.ino !== secured.ino ||
        (secured.mode & 0o077) !== 0) {
      throw lockError(`the local ${label} changed while it was secured`, "source_ingest_lock_unsafe");
    }
    return current;
  } finally {
    closeSync(fd);
  }
}

function ensurePrivateRuntime(home, platform) {
  const resolvedHome = resolve(home);
  if (!existsSync(resolvedHome)) mkdirIfMissing(resolvedHome);
  const homeState = lstatSync(resolvedHome);
  if (!homeState.isDirectory() || homeState.isSymbolicLink()) {
    throw lockError("the local ingest-lock home must be a real directory", "source_ingest_lock_unsafe");
  }
  if (platform !== "win32" && typeof process.getuid === "function" && homeState.uid !== process.getuid()) {
    throw lockError("the local ingest-lock home is not owned by the current user", "source_ingest_lock_unsafe");
  }

  const runtimeDir = join(resolvedHome, ".brain");
  const locksDir = join(runtimeDir, "locks");
  for (const [path, label] of [[runtimeDir, "ingest runtime directory"], [locksDir, "ingest lock directory"]]) {
    if (!existsSync(path)) mkdirIfMissing(path);
    securePrivateDirectory(path, label, platform);
  }
  return realpathSync(locksDir);
}

function canonicalManifestFilePath(manifestPath) {
  const manifest = realpathSync(resolve(manifestPath));
  const state = lstatSync(manifest);
  // A hard-linked manifest has more than one equally valid parent directory,
  // so there is no portable way to choose its one adjacent resume-state file.
  // Refuse that ambiguous identity instead of letting each alias take a
  // different state lease. Keep the error path-free because manifests may
  // live below owner-private directories.
  if (state.nlink !== 1) {
    throw lockError(
      "the local brain manifest must not have multiple filesystem links",
      "source_ingest_lock_unsafe",
    );
  }
  return manifest;
}

/**
 * The adjacent resume-state path is the local mutation identity. Canonicalizing
 * the manifest itself means a file or parent symlink cannot start a second
 * writer. Only its digest reaches the private runtime path.
 */
export function canonicalSourceIngestStatePath({ manifestPath, sourceName }) {
  if (!manifestPath || !sourceName) {
    throw new TypeError("a manifest path and source name are required for an ingest lock");
  }
  // Resolve the manifest itself, not only its parent. A manifest-file symlink
  // can live in a real second directory, and canonicalizing only that directory
  // gives the alias a second resume file and therefore a second writer lease.
  const manifest = canonicalManifestFilePath(manifestPath);
  return join(dirname(manifest), `.brain-ingest-${sourceName}.json`);
}

export function sourceIngestLockPath({
  manifestPath,
  sourceName,
  statePath = null,
  sharedRecord = null,
  home = homedir(),
  platform = process.platform,
}) {
  if (!sourceName || (!sharedRecord && !statePath && !manifestPath)) {
    throw new TypeError("a state or manifest path and source name are required for an ingest lock");
  }
  if (sharedRecord !== null && !/^provider:[a-z][a-z0-9-]{0,63}$/.test(sharedRecord)) {
    throw new TypeError("an ingest lock shared record must identify a supported provider namespace");
  }
  // Provider cursors share one per-user credential record across sources and
  // manifest directories. Serialize the whole provider record; a source-only
  // lock cannot protect read/modify/write of that shared record. This coarse
  // namespace also stays exclusive when its storage backend changes.
  // Actual source writers pass both manifestPath and their already-derived
  // statePath. Revalidate the manifest here so a caller cannot bypass the
  // hard-link refusal merely by supplying the state path explicitly.
  const manifest = sharedRecord === null && manifestPath
    ? canonicalManifestFilePath(manifestPath)
    : null;
  const canonicalIdentity = sharedRecord !== null
    ? `shared-record-v1:${sharedRecord}`
    : statePath ? resolve(statePath) : join(dirname(manifest), `.brain-ingest-${sourceName}.json`);
  const identity = createHash("sha256").update(canonicalIdentity).digest("hex").slice(0, 32);
  return join(ensurePrivateRuntime(home, platform), `source-ingest-${identity}.lock`);
}

const ownerName = (pid, token) => `owner-${pid}-${token}.json`;

function readOwner(lockPath, platform = process.platform) {
  let entries;
  try {
    entries = readdirSync(lockPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (entries.length === 0) return null;
  const owners = entries.filter((entry) => OWNER_FILE_RE.test(entry.name));
  if (entries.length !== 1 || owners.length !== 1 || !owners[0].isFile()) {
    throw lockError("the local ingest lock contains unexpected files", "source_ingest_lock_unsafe");
  }

  const match = owners[0].name.match(OWNER_FILE_RE);
  const pidFromName = Number(match[1]);
  const tokenFromName = match[2];
  if (!Number.isSafeInteger(pidFromName) || pidFromName < 1) {
    throw lockError("the local ingest lock owner is malformed", "source_ingest_lock_unsafe");
  }
  const path = join(lockPath, owners[0].name);
  let state;
  try {
    state = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!state.isFile() || state.isSymbolicLink() || state.size > 1_024 || state.nlink !== 1) {
    throw lockError("the local ingest lock owner is invalid", "source_ingest_lock_unsafe");
  }
  if (platform !== "win32" &&
      ((typeof process.getuid === "function" && state.uid !== process.getuid()) ||
       (state.mode & 0o077) !== 0)) {
    throw lockError("the local ingest lock owner is not private", "source_ingest_lock_unsafe");
  }

  let parsed = null;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { /* bounded stale recovery below */ }
  const malformed = parsed?.token !== tokenFromName || parsed?.pid !== pidFromName;
  return {
    token: tokenFromName,
    pid: pidFromName,
    mtimeMs: state.mtimeMs,
    path,
    malformed,
  };
}

function ownerAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // EPERM and unfamiliar platform responses do not prove that a process is
    // dead, so takeover fails closed.
    return true;
  }
}

function releaseOwner(lockPath, expectedToken, platform) {
  const owner = readOwner(lockPath, platform);
  if (!owner || owner.token !== expectedToken) return false;
  // The token is part of the filename. A stopped or delayed prior holder can
  // therefore remove only its own record, never a successor's lock.
  unlinkSync(owner.path);
  rmdirSync(lockPath);
  return true;
}

function removeStaleOwner(lockPath, expectedOwner, { isOwnerAlive, platform }) {
  if (!expectedOwner || isOwnerAlive(expectedOwner.pid)) return false;
  const current = readOwner(lockPath, platform);
  if (!current ||
      current.token !== expectedOwner.token ||
      current.pid !== expectedOwner.pid ||
      current.mtimeMs !== expectedOwner.mtimeMs ||
      isOwnerAlive(current.pid)) {
    return false;
  }
  unlinkSync(current.path);
  rmdirSync(lockPath);
  return true;
}

function busyError(sourceName) {
  return lockError(
    `${sourceName === "gmail" ? "Gmail" : sourceName} ingest is already running on this computer. ` +
      "Wait for it to finish, then re-run the same command.",
    "source_ingest_already_running",
    true,
  );
}

/**
 * Acquire one nonblocking, cross-platform writer lease for a source's local
 * resume state. Atomic directory creation supplies exclusion on macOS, Linux,
 * and Windows. The heartbeat plus PID check makes an abrupt-exit residue
 * recoverable without allowing an old timestamp to evict a live long ingest.
 */
export function acquireSourceIngestLock({
  manifestPath,
  sourceName,
  statePath = null,
  sharedRecord = null,
  home = homedir(),
  platform = process.platform,
  staleMs = MIN_STALE_MS,
  isOwnerAlive = ownerAlive,
  writeOwner = writeFileSync,
} = {}) {
  const lockPath = sourceIngestLockPath({ manifestPath, sourceName, statePath, sharedRecord, home, platform });
  const staleAfter = Math.max(MIN_STALE_MS, Number(staleMs) || 0);
  let ownerToken = null;

  while (!ownerToken) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      const createdState = assertPrivateDirectory(lockPath, "ingest lock", platform);
      ownerToken = randomBytes(16).toString("hex");
      const ownerPath = join(lockPath, ownerName(process.pid, ownerToken));
      try {
        writeOwner(ownerPath, JSON.stringify({
          schema_version: 1,
          token: ownerToken,
          pid: process.pid,
          created_at: new Date().toISOString(),
        }), { encoding: "utf8", flag: "wx", mode: 0o600 });
        const currentState = lstatSync(lockPath);
        if (currentState.dev !== createdState.dev || currentState.ino !== createdState.ino) {
          throw lockError(
            "the local ingest lock changed while ownership was being recorded",
            "source_ingest_lock_lost",
          );
        }
        const owner = readOwner(lockPath, platform);
        if (!owner || owner.malformed || owner.token !== ownerToken) {
          throw lockError(
            "the local ingest lock changed while ownership was being recorded",
            "source_ingest_lock_lost",
          );
        }
      } catch (error) {
        try { unlinkSync(ownerPath); } catch { /* the exact owner file may not exist */ }
        try { rmdirSync(lockPath); } catch { /* preserve the original failure */ }
        throw error;
      }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let state;
      try {
        state = lstatSync(lockPath);
      } catch (readError) {
        if (readError?.code === "ENOENT") continue;
        throw readError;
      }
      if (!state.isDirectory() || state.isSymbolicLink()) {
        throw lockError("the local ingest lock is not a safe directory", "source_ingest_lock_unsafe");
      }
      assertPrivateDirectory(lockPath, "ingest lock", platform);
      const owner = readOwner(lockPath, platform);
      const lastHeartbeat = owner?.mtimeMs ?? state.mtimeMs;
      if (Date.now() - lastHeartbeat > staleAfter) {
        try {
          if (owner) {
            if (removeStaleOwner(lockPath, owner, { isOwnerAlive, platform })) continue;
          } else {
            rmdirSync(lockPath);
            continue;
          }
        } catch (removeError) {
          if (removeError?.code === "ENOENT") continue;
          if (removeError?.code !== "ENOTEMPTY") throw removeError;
        }
      }
      if (owner?.malformed) {
        throw lockError("the local ingest lock owner is malformed", "source_ingest_lock_unsafe");
      }
      throw busyError(sourceName);
    }
  }

  const assertOwned = () => {
    const owner = readOwner(lockPath, platform);
    if (!owner || owner.malformed || owner.token !== ownerToken) {
      throw lockError(
        "the local ingest lock changed during this run; its completion cannot be trusted",
        "source_ingest_lock_lost",
      );
    }
    return true;
  };
  const heartbeat = setInterval(() => {
    try {
      assertOwned();
      const now = new Date();
      utimesSync(join(lockPath, ownerName(process.pid, ownerToken)), now, now);
    } catch { /* assertOwned supplies a stable refusal when the task checks */ }
  }, Math.min(10_000, Math.max(1_000, Math.floor(staleAfter / 4))));
  heartbeat.unref?.();

  let released = false;
  const release = () => {
    if (released) return false;
    released = true;
    clearInterval(heartbeat);
    process.removeListener("exit", release);
    try { return releaseOwner(lockPath, ownerToken, platform); } catch { return false; }
  };
  process.once("exit", release);
  return { path: lockPath, assertOwned, release };
}

export async function withSourceIngestLock(options, task) {
  if (typeof task !== "function") throw new TypeError("an ingest-lock task is required");
  const lock = acquireSourceIngestLock(options);
  try {
    return await task({ assertOwned: lock.assertOwned });
  } finally {
    lock.release();
  }
}
