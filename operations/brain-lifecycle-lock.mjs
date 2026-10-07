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
import { isAbsolute, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";

const CURRENT_PROCESS_INSTANCE = `${Math.round(Date.now() - process.uptime() * 1000)}`;

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

function brainIdentityFromManifest(manifestPath) {
  const manifest = canonicalManifest(manifestPath);
  let value;
  try { value = JSON.parse(readFileSync(manifest, "utf8")); } catch {
    throw failure("brain_lifecycle_manifest_unsafe", "the Brain manifest is not valid JSON");
  }
  const cloudflare = value?.infrastructure?.cloudflare || {};
  let identity;
  if (cloudflare.d1_database_id) {
    identity = { kind: "d1", account_id: cloudflare.account_id || null, d1_database_id: cloudflare.d1_database_id };
  } else if (value?.brain?.worker_name) {
    identity = { kind: "worker", account_id: cloudflare.account_id || null, worker_name: value.brain.worker_name };
  } else if (value?.brain?.domain) {
    identity = { kind: "domain", domain: value.brain.domain };
  } else if (value?.client?.slug) {
    identity = { kind: "prepared-manifest", slug: value.client.slug };
  } else {
    identity = { kind: "unprovisioned-manifest", canonical_path: manifest };
  }
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32);
}

function defaultMachineLockRoot(platform) {
  const injected = process.env.BRAIN_LIFECYCLE_LOCK_ROOT;
  if (injected && isAbsolute(injected)) return resolve(injected);
  if (platform === "win32") {
    const programData = process.env.ProgramData;
    if (programData && isAbsolute(programData)) return join(resolve(programData), "FinancialBrain", "locks");
  }
  return "/tmp/financial-brain-lifecycle-v1";
}

function assertSharedRoot(path, platform) {
  const state = lstatSync(path);
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw failure("brain_lifecycle_unsafe", "the machine Brain lock root must be one real directory");
  }
  if (platform !== "win32" && ((state.mode & 0o002) === 0 || (state.mode & 0o1000) === 0)) {
    chmodSync(path, 0o1777);
    if ((lstatSync(path).mode & 0o002) === 0) {
      throw failure("brain_lifecycle_unsafe", "the machine Brain lock root is not shared safely");
    }
  }
}

function lockDirectory({ manifestPath, platform, machineLockRoot }) {
  const identity = brainIdentityFromManifest(manifestPath);
  const locks = resolve(machineLockRoot || defaultMachineLockRoot(platform));
  mkdirSync(locks, { recursive: true, mode: platform === "win32" ? 0o700 : 0o1777 });
  assertSharedRoot(locks, platform);
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
  if (value?.schema_version !== 2 || value?.pid !== pid || value?.token !== token ||
      typeof value?.operation !== "string") {
    throw failure("brain_lifecycle_unsafe", "the Brain lifecycle lock owner is malformed");
  }
  return {
    pid,
    token,
    operation: value.operation,
    process_instance: typeof value.process_instance === "string" ? value.process_instance : null,
    path: ownerPath,
    mtimeMs: state.mtimeMs,
  };
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
  machineLockRoot,
  staleMs = DEFAULT_STALE_MS,
  isOwnerAlive = ownerAlive,
  processInstance = (pid) => pid === process.pid
    ? CURRENT_PROCESS_INSTANCE
    : null,
  now = () => new Date(),
} = {}) {
  if (!operation || !/^[a-z][a-z0-9-]{1,31}$/u.test(String(operation))) {
    throw new TypeError("a bounded lifecycle operation name is required");
  }
  void home;
  const path = lockDirectory({ manifestPath, platform, machineLockRoot });
  const staleAfter = Math.max(MIN_STALE_MS, Number(staleMs) || 0);
  const currentTime = () => {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError("the lifecycle lock clock is invalid");
    return value;
  };
  let token;
  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 });
      assertPrivateDirectory(path, "Brain lifecycle lock", platform);
      token = randomBytes(16).toString("hex");
      writeFileSync(join(path, `owner-${process.pid}-${token}.json`), JSON.stringify({
        schema_version: 2,
        pid: process.pid,
        token,
        operation: String(operation),
        process_instance: processInstance(process.pid),
        created_at: currentTime().toISOString(),
      }), { encoding: "utf8", flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const collisionState = lstatSync(path);
      if (!collisionState.isDirectory() || collisionState.isSymbolicLink()) {
        throw failure("brain_lifecycle_unsafe", "the Brain lifecycle lock must be one real directory");
      }
      if (platform !== "win32" && typeof process.getuid === "function" && collisionState.uid !== process.getuid()) {
        throw failure(
          "brain_lifecycle_busy",
          `another operating-system user owns this Brain lifecycle lock; wait before starting ${operation}`,
          { retryable: true },
        );
      }
      assertPrivateDirectory(path, "Brain lifecycle lock", platform);
      const directoryState = lstatSync(path);
      const entries = readdirSync(path, { withFileTypes: true });
      if (entries.length === 0 && currentTime().getTime() - directoryState.mtimeMs > staleAfter) {
        const currentState = lstatSync(path);
        if (currentState.mtimeMs === directoryState.mtimeMs && readdirSync(path).length === 0) {
          try { rmdirSync(path); } catch (reapError) {
            if (!new Set(["ENOENT", "ENOTEMPTY", "EEXIST"]).has(reapError?.code)) throw reapError;
          }
          continue;
        }
      }
      const owner = readOwner(path, platform);
      const live = isOwnerAlive(owner.pid);
      const observedInstance = live ? processInstance(owner.pid) : null;
      const sameProcess = live && (!owner.process_instance || !observedInstance || owner.process_instance === observedInstance);
      if (currentTime().getTime() - owner.mtimeMs > staleAfter && !sameProcess) {
        const current = readOwner(path, platform);
        const currentLive = isOwnerAlive(current.pid);
        const currentInstance = currentLive ? processInstance(current.pid) : null;
        const currentSameProcess = currentLive &&
          (!current.process_instance || !currentInstance || current.process_instance === currentInstance);
        if (current.token === owner.token && current.mtimeMs === owner.mtimeMs && !currentSameProcess) {
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
