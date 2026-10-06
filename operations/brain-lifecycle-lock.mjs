/**
 * One manifest-wide writer lease shared by updates, loads, and scheduled work.
 * Source leases are acquired only after this lease, so no source writer can
 * race a deployment transition that has already paused local scheduling.
 */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";

const OWNER_RE = /^owner-(\d+)-([a-f0-9]{32})\.json$/u;
const MIN_STALE_MS = 60_000;
const DEFAULT_STALE_MS = 30 * 60_000;

export class BrainLifecycleLockError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = "BrainLifecycleLockError";
    this.code = code;
    this.retryable = retryable;
  }
}

function failure(code, message, options) {
  return new BrainLifecycleLockError(code, message, options);
}

function assertPrivateDirectory(path, label, platform) {
  const state = lstatSync(path);
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw failure("brain_lifecycle_unsafe", `the local ${label} must be one real directory`);
  }
  if (platform !== "win32") {
    if (typeof process.getuid === "function" && state.uid !== process.getuid()) {
      throw failure("brain_lifecycle_unsafe", `the local ${label} is not owned by this user`);
    }
    if ((state.mode & 0o077) !== 0) {
      chmodSync(path, 0o700);
      if ((lstatSync(path).mode & 0o077) !== 0) {
        throw failure("brain_lifecycle_unsafe", `the local ${label} is not private`);
      }
    }
  }
  return state;
}

function canonicalManifest(manifestPath) {
  const lexical = resolve(String(manifestPath || ""));
  let state;
  try { state = lstatSync(lexical); } catch {
    throw failure("brain_lifecycle_manifest_missing", "the Brain manifest does not exist");
  }
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1) {
    throw failure("brain_lifecycle_manifest_unsafe", "the Brain manifest must be one regular file, not a link");
  }
  return realpathSync(lexical);
}

function lockDirectory({ manifestPath, home, platform }) {
  const manifest = canonicalManifest(manifestPath);
  const root = resolve(home || homedir());
  const runtime = join(root, ".brain");
  const locks = join(runtime, "locks");
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  mkdirSync(locks, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(runtime, "Brain runtime directory", platform);
  assertPrivateDirectory(locks, "Brain lock directory", platform);
  const identity = createHash("sha256").update(`brain-lifecycle-v1\0${manifest}`).digest("hex").slice(0, 32);
  return join(realpathSync(locks), `brain-lifecycle-${identity}.lock`);
}

function readOwner(path, platform) {
  let entries;
  try { entries = readdirSync(path, { withFileTypes: true }); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const owners = entries.filter((entry) => OWNER_RE.test(entry.name));
  if (entries.length !== 1 || owners.length !== 1 || !owners[0].isFile()) {
    throw failure("brain_lifecycle_unsafe", "the Brain lifecycle lock contains unexpected files");
  }
  const match = owners[0].name.match(OWNER_RE);
  const ownerPath = join(path, owners[0].name);
  const state = lstatSync(ownerPath);
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1 || state.size > 2048) {
    throw failure("brain_lifecycle_unsafe", "the Brain lifecycle lock owner is invalid");
  }
  if (platform !== "win32" &&
      ((typeof process.getuid === "function" && state.uid !== process.getuid()) || (state.mode & 0o077) !== 0)) {
    throw failure("brain_lifecycle_unsafe", "the Brain lifecycle lock owner is not private");
  }
  let value;
  try { value = JSON.parse(readFileSync(ownerPath, "utf8")); } catch {
    throw failure("brain_lifecycle_unsafe", "the Brain lifecycle lock owner is malformed");
  }
  const pid = Number(match[1]);
  const token = match[2];
  if (value?.schema_version !== 1 || value?.pid !== pid || value?.token !== token ||
      typeof value?.operation !== "string") {
    throw failure("brain_lifecycle_unsafe", "the Brain lifecycle lock owner is malformed");
  }
  return { pid, token, operation: value.operation, path: ownerPath, mtimeMs: state.mtimeMs };
}

function ownerAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function releaseOwner(path, token, platform) {
  const owner = readOwner(path, platform);
  if (!owner || owner.token !== token) return false;
  unlinkSync(owner.path);
  rmdirSync(path);
  return true;
}

export function acquireBrainLifecycleLock({
  manifestPath,
  operation,
  home = homedir(),
  platform = process.platform,
  staleMs = DEFAULT_STALE_MS,
  isOwnerAlive = ownerAlive,
} = {}) {
  if (!operation || !/^[a-z][a-z0-9-]{1,31}$/u.test(String(operation))) {
    throw new TypeError("a bounded lifecycle operation name is required");
  }
  const path = lockDirectory({ manifestPath, home, platform });
  const staleAfter = Math.max(MIN_STALE_MS, Number(staleMs) || 0);
  let token;
  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 });
      assertPrivateDirectory(path, "Brain lifecycle lock", platform);
      token = randomBytes(16).toString("hex");
      writeFileSync(join(path, `owner-${process.pid}-${token}.json`), JSON.stringify({
        schema_version: 1,
        pid: process.pid,
        token,
        operation: String(operation),
        created_at: new Date().toISOString(),
      }), { encoding: "utf8", flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      assertPrivateDirectory(path, "Brain lifecycle lock", platform);
      const owner = readOwner(path, platform);
      if (Date.now() - owner.mtimeMs > staleAfter && !isOwnerAlive(owner.pid)) {
        const current = readOwner(path, platform);
        if (current.token === owner.token && current.mtimeMs === owner.mtimeMs && !isOwnerAlive(current.pid)) {
          unlinkSync(current.path);
          rmdirSync(path);
          continue;
        }
      }
      throw failure(
        "brain_lifecycle_busy",
        `the Brain is already running ${owner.operation}; wait for it to finish before starting ${operation}`,
        { retryable: true },
      );
    }
  }

  const ownerPath = join(path, `owner-${process.pid}-${token}.json`);
  const assertOwned = () => {
    const owner = readOwner(path, platform);
    if (!owner || owner.token !== token) {
      throw failure("brain_lifecycle_lost", "the Brain lifecycle lock changed during this operation");
    }
    return true;
  };
  const heartbeat = setInterval(() => {
    try { assertOwned(); const now = new Date(); utimesSync(ownerPath, now, now); } catch {}
  }, Math.min(10_000, Math.max(1_000, Math.floor(staleAfter / 4))));
  heartbeat.unref?.();
  let released = false;
  const release = () => {
    if (released) return false;
    released = true;
    clearInterval(heartbeat);
    process.removeListener("exit", release);
    try { return releaseOwner(path, token, platform); } catch { return false; }
  };
  process.once("exit", release);
  return Object.freeze({ path, operation: String(operation), assertOwned, release });
}

export async function withBrainLifecycleLock(options, task) {
  if (typeof task !== "function") throw new TypeError("a lifecycle-lock task is required");
  const lock = acquireBrainLifecycleLock(options);
  try {
    return await task({ assertOwned: lock.assertOwned, lock });
  } finally {
    lock.release();
  }
}

export async function withBrainLifecycleLockWait(options, task) {
  if (typeof task !== "function") throw new TypeError("a lifecycle-lock task is required");
  const waitMs = Math.max(0, Number(options?.waitMs) || 0);
  const retryMs = Math.max(25, Number(options?.retryMs) || 250);
  const sleep = options?.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const started = Date.now();
  for (;;) {
    try {
      return await withBrainLifecycleLock(options, task);
    } catch (error) {
      if (error?.code !== "brain_lifecycle_busy" || Date.now() - started >= waitMs) throw error;
      await sleep(Math.min(retryMs, Math.max(1, waitMs - (Date.now() - started))));
    }
  }
}
