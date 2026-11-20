/**
 * One manifest-wide writer lease shared by updates, loads, and scheduled work.
 * Source leases are acquired only after this lease, so no source writer can
 * race a deployment transition that has already paused local scheduling.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, win32 as pathWin32 } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { restrictWindowsDirectoryToCurrentUser } from "./current-user-file.mjs";
import { removeFileWithRetrySync, replaceFileWithRetrySync } from "./rename-retry.mjs";

const CURRENT_PROCESS_INSTANCE = `process-lifetime:${randomBytes(16).toString("hex")}`;

const OWNER_RE = /^owner-(\d+)-([a-f0-9]{32})\.json$/u;
const OWNER_FILE = "owner.json";
const MIN_STALE_MS = 60_000;
const DEFAULT_STALE_MS = 30 * 60_000;
export const BRAIN_LIFECYCLE_PARENT_ENV = "BRAIN_LIFECYCLE_PARENT";

import { BrainLifecycleLockError, resolveBrainLockRoot, resolveBrainAccountLockRoot, brainLockRootCandidates, brainLockRootsReadOnly,
  resolveLegacyBrainLockRoot, legacyBrainLockUnavailable, announcePrivateBrainLock } from "./brain-lock-root.mjs";
export { BrainLifecycleLockError } from "./brain-lock-root.mjs";

function failure(code, message, options) {
  return new BrainLifecycleLockError(code, code === "brain_lifecycle_busy"
    ? `${message} UPDATE_BRAIN_BUSY: https://financialbrain.ai/help/UPDATE_BRAIN_BUSY` : message, options);
}

function boundedEnvironment(environment, names) {
  return Object.fromEntries(names.flatMap((name) =>
    typeof environment?.[name] === "string" && environment[name]
      ? [[name, environment[name]]]
      : []));
}

/** Stable process ownership without PATH lookup or inherited credentials. */
export function processStartIdentity(pid, {
  platform = process.platform,
  environment = process.env,
  run = spawnSync,
} = {}) {
  const numericPid = Number(pid);
  if (!Number.isSafeInteger(numericPid) || numericPid <= 0) return null;
  try {
    if (platform === "win32") {
      const systemRoot = String(environment?.SystemRoot || environment?.WINDIR || "");
      if (!/^[A-Za-z]:\\/u.test(systemRoot)) return null;
      const executable = pathWin32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const command = `$p = Get-Process -Id ${numericPid} -ErrorAction Stop; [Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)`;
      const result = run(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
        encoding: "utf8",
        env: boundedEnvironment(environment, ["SystemRoot", "WINDIR"]),
        timeout: 5_000,
        windowsHide: true,
      });
      const ticks = String(result?.stdout || "").trim();
      return result?.status === 0 && /^\d{15,20}$/u.test(ticks) ? `win32:${ticks}` : null;
    }
    if (platform === "linux" || platform === "darwin") {
      const result = run("/bin/ps", ["-o", "lstart=", "-p", String(numericPid)], {
        encoding: "utf8",
        env: {},
        timeout: 5_000,
      });
      const started = Date.parse(String(result?.stdout || "").trim());
      return result?.status === 0 && Number.isFinite(started) ? `posix:${started}` : null;
    }
  } catch {}
  return null;
}

function ownerIsPriorProcessWithContenderPid(owner, contenderProcessInstance) {
  return owner.pid === process.pid &&
    typeof owner.process_instance === "string" && owner.process_instance.length > 0 &&
    owner.process_instance !== contenderProcessInstance;
}

function lifecycleOwnerIsDead({ owner, live, contenderProcessInstance }) {
  return live !== true || ownerIsPriorProcessWithContenderPid(owner, contenderProcessInstance);
}

function busyRetryInstruction(retryCommand) {
  const command = typeof retryCommand === "string" ? retryCommand.trim() : "";
  if (command && command.length <= 512 && !/[\r\n\0]/u.test(command)) {
    return `then run ${command} again.`;
  }
  return "then run the same command again.";
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

export function brainLifecycleCoordinates({ manifestPath, platform = process.platform, machineLockRoot,
  home, operation, lockRootOptions = {},
} = {}) {
  const identity = brainIdentityFromManifest(manifestPath);
  const selected = resolveBrainLockRoot({ ...lockRootOptions, platform, machineLockRoot, home, operation });
  return Object.freeze({ identity, ...selected });
}

function readRecoveryFenceAtPath(path) {
  if (!existsSync(path)) return null;
  const state = lstatSync(path);
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1 || state.size > 2048) {
    throw failure("brain_lifecycle_unsafe", "the Brain update recovery fence is unsafe");
  }
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch {
    throw failure("brain_lifecycle_unsafe", "the Brain update recovery fence is malformed");
  }
  if (value?.schema_version !== 1 || value?.kind !== "brain_update_recovery_fence" ||
      !/^[a-f0-9]{32}$/u.test(String(value?.brain_identity || "")) ||
      !/^[a-f0-9]{32}$/u.test(String(value?.transaction_id || ""))) {
    throw failure("brain_lifecycle_unsafe", "the Brain update recovery fence is malformed");
  }
  return Object.freeze({ ...value, path });
}

export function readBrainRecoveryFence(options = {}) {
  const coordinates = brainLifecycleCoordinates(options);
  const selected = readRecoveryFenceAtPath(join(coordinates.root, `brain-update-recovery-${coordinates.identity}.json`));
  // Permission repair can make the shared root usable again on a later run.
  // Never hide this user's unfinished recovery merely by switching roots.
  return selected || ((options.platform ?? process.platform) === "win32" ? readBrainRecoveryFenceReadOnly(options) : null);
}

/** Missing roots stay missing; preview never probes, repairs or journals. */
export function readBrainRecoveryFenceReadOnly({ manifestPath, platform = process.platform, machineLockRoot,
  lockRootOptions = {},
} = {}) {
  const identity = brainIdentityFromManifest(manifestPath);
  for (const root of brainLockRootsReadOnly({ ...lockRootOptions, platform, machineLockRoot })) {
    const fence = readRecoveryFenceAtPath(join(root, `brain-update-recovery-${identity}.json`));
    if (fence) return fence;
  }
  return null;
}

export function writeBrainRecoveryFence({
  manifestPath,
  transactionId,
  platform = process.platform,
  machineLockRoot,
  home, lockRootOptions = {},
} = {}) {
  if (!/^[a-f0-9]{32}$/u.test(String(transactionId || ""))) {
    throw new TypeError("a valid Brain update transaction id is required");
  }
  const coordinates = brainLifecycleCoordinates({ manifestPath, platform, machineLockRoot, home, lockRootOptions });
  const path = join(coordinates.root, `brain-update-recovery-${coordinates.identity}.json`);
  const existing = readBrainRecoveryFence({ manifestPath, platform, machineLockRoot, home, lockRootOptions });
  if (existing) {
    if (existing.transaction_id !== transactionId) {
      throw failure("brain_lifecycle_recovery_required", "this Brain already has an unresolved update recovery fence");
    }
    return existing;
  }
  const value = Object.freeze({
    schema_version: 1,
    kind: "brain_update_recovery_fence",
    brain_identity: coordinates.identity,
    transaction_id: transactionId,
  });
  try {
    writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o644 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const collision = readBrainRecoveryFence({ manifestPath, platform, machineLockRoot, home, lockRootOptions });
    if (collision?.transaction_id !== transactionId) {
      throw failure("brain_lifecycle_recovery_required", "this Brain already has an unresolved update recovery fence");
    }
  }
  return Object.freeze({ ...value, path });
}

export function clearBrainRecoveryFence({
  manifestPath,
  transactionId,
  platform = process.platform,
  machineLockRoot,
  home, lockRootOptions = {},
} = {}) {
  const existing = readBrainRecoveryFence({ manifestPath, platform, machineLockRoot, home, lockRootOptions });
  if (!existing) return false;
  if (existing.transaction_id !== transactionId) {
    throw failure("brain_lifecycle_recovery_required", "the Brain update recovery fence belongs to another transaction");
  }
  removeFileWithRetrySync(existing.path, { platform });
  return true;
}

function readOwner(path, platform) {
  let entries;
  try { entries = readdirSync(path, { withFileTypes: true }); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  // Continue reading pre-upgrade leases, but publish only one exclusive slot.
  const owners = entries.filter((entry) => entry.name === OWNER_FILE || OWNER_RE.test(entry.name));
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
  const pid = match ? Number(match[1]) : value?.pid;
  const token = match ? match[2] : value?.token;
  const createdAt = typeof value?.created_at === "string" ? value.created_at : "";
  if (!Number.isSafeInteger(pid) || pid <= 0 || !/^[a-f0-9]{32}$/u.test(String(token || "")) ||
      value?.schema_version !== 2 || value?.pid !== pid || value?.token !== token ||
      typeof value?.operation !== "string" || !Number.isFinite(Date.parse(createdAt))) {
    throw failure("brain_lifecycle_unsafe", "the Brain lifecycle lock owner is malformed");
  }
  return {
    pid,
    token,
    operation: value.operation,
    created_at: createdAt,
    process_instance: typeof value.process_instance === "string" ? value.process_instance : null,
    path: ownerPath,
    mtimeMs: state.mtimeMs,
  };
}

function assertSameDirectory(path, expected) {
  let current;
  // Native file IDs must not lose bits through Number conversion on Windows.
  try { current = lstatSync(path, { bigint: true }); } catch {
    throw failure("brain_lifecycle_lost", "the Brain lifecycle lock changed during acquisition");
  }
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== expected.dev ||
      current.ino !== expected.ino || current.birthtimeNs !== expected.birthtimeNs) {
    throw failure("brain_lifecycle_lost", "the Brain lifecycle lock changed during acquisition");
  }
}

function ownerAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function releaseOwner(path, token, platform, { removeDirectory, waitSync }) {
  const owner = readOwner(path, platform);
  if (!owner || owner.token !== token) return false;
  unlinkSync(owner.path);
  // Windows scanners can retain the just-unlinked owner briefly. Bound the
  // synchronous retry budget so even exit cleanup cannot hang indefinitely.
  for (let attempt = 0; ; attempt++) {
    try { removeDirectory(path); break; } catch (error) {
      if (error?.code === "ENOENT") break;
      if (platform !== "win32" || attempt >= 20 ||
          !["EPERM", "EBUSY", "ENOTEMPTY"].includes(error?.code)) throw error;
      waitSync(50);
    }
  }
  return true;
}

function acquireLifecycleSlot({
  coordinates,
  manifestPath,
  operation,
  retryCommand,
  home = homedir(),
  platform = process.platform,
  machineLockRoot,
  lockRootOptions = {},
  staleMs = DEFAULT_STALE_MS,
  isOwnerAlive = ownerAlive,
  now = () => new Date(),
  removeDirectory = rmdirSync,
  publishOwner = writeFileSync,
  waitSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  log = (message) => console.error(message),
  // Real ACLs only exist on a Windows host; a simulated win32 platform on POSIX has nothing to restrict.
  restrictWindowsDirectory = (path, options) => (process.platform === "win32"
    ? restrictWindowsDirectoryToCurrentUser(path, options)
    : undefined),
} = {}) {
  if (!operation || !/^[a-z][a-z0-9-]{1,31}$/u.test(String(operation))) {
    throw new TypeError("a bounded lifecycle operation name is required");
  }
  const path = join(coordinates.root, `brain-lifecycle-${coordinates.identity}.lock`);
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
      const acquiredDirectory = lstatSync(path, { bigint: true });
      if (platform === "win32") {
        try {
          restrictWindowsDirectory(path, { label: "the Brain lifecycle lock" });
        } catch {
          try {
            assertSameDirectory(path, acquiredDirectory);
            if (readdirSync(path).length === 0) rmdirSync(path);
          } catch {}
          throw failure("brain_lifecycle_unsafe", "the local Brain lifecycle lock is not private");
        }
      }
      assertPrivateDirectory(path, "Brain lifecycle lock", platform);
      token = randomBytes(16).toString("hex");
      const publication = JSON.stringify({
        schema_version: 2,
        pid: process.pid,
        token,
        operation: String(operation),
        process_instance: CURRENT_PROCESS_INSTANCE,
        created_at: currentTime().toISOString(),
      });
      // A suspended mkdir winner can resume after empty-directory recovery.
      // Identity checks reject replacement directories; the fixed exclusive
      // slot closes the check-to-write race without adding a second owner.
      assertSameDirectory(path, acquiredDirectory);
      try { publishOwner(join(path, OWNER_FILE), publication, { encoding: "utf8", flag: "wx", mode: 0o600 }); }
      catch (error) {
        // A denied shared-slot write may continue privately. Remove only our
        // unchanged, empty directory so it cannot strand a phantom contender.
        try { assertSameDirectory(path, acquiredDirectory); if (readdirSync(path).length === 0) rmdirSync(path); } catch {}
        throw error;
      }
      try {
        assertSameDirectory(path, acquiredDirectory);
        const published = readOwner(path, platform);
        if (!published || published.token !== token) {
          throw failure("brain_lifecycle_lost", "the Brain lifecycle lock changed during acquisition");
        }
      } catch (error) {
        // If recovery replaced an empty directory, our exclusive write may
        // have won its slot. Release only our token so refusal cannot strand
        // an owned claim and block the next command for the full stale window.
        try { releaseOwner(path, token, platform, { removeDirectory, waitSync }); }
        catch { log("The Brain lifecycle lock could not be released; retry after its recovery grace period."); }
        throw error;
      }
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
      if (entries.length === 0) {
        // Only mkdir-to-owner-write needs this short grace. Owned locks retain
        // the full stale window, and reaping still requires an exact recheck.
        if (currentTime().getTime() - directoryState.mtimeMs > 10_000) {
          const currentState = lstatSync(path);
          if (currentState.mtimeMs === directoryState.mtimeMs && readdirSync(path).length === 0) {
            try { rmdirSync(path); } catch (reapError) {
              if (!new Set(["ENOENT", "ENOTEMPTY", "EEXIST"]).has(reapError?.code)) throw reapError;
            }
            continue;
          }
        }
        throw failure(
          "brain_lifecycle_busy",
          `the Brain lifecycle lock is being acquired. Wait for it to finish, ${busyRetryInstruction(retryCommand)}`,
          { retryable: true },
        );
      }
      const owner = readOwner(path, platform);
      const live = isOwnerAlive(owner.pid);
      const contenderInstance = CURRENT_PROCESS_INSTANCE;
      const observedAt = currentTime();
      const stale = observedAt.getTime() - owner.mtimeMs > staleAfter;
      const ownerDead = lifecycleOwnerIsDead({
        owner,
        live,
        contenderProcessInstance: contenderInstance,
      });
      if (stale && ownerDead) {
        // Serialize the entire final observation/removal. Never age-reap this
        // guard: a suspended reaper can resume after any timeout. A crash in
        // recovery requires explicit intervention rather than a second writer.
        const recoveryPath = path + ".recovery";
        try { mkdirSync(recoveryPath, { mode: 0o700 }); } catch (error) {
          if (error?.code !== "EEXIST") throw error;
          throw failure("brain_lifecycle_busy", "the Brain lifecycle lock is being recovered; wait before retrying", { retryable: true });
        }
        try {
          const recoveryDirectory = lstatSync(path, { bigint: true });
          const current = readOwner(path, platform);
          const currentLive = isOwnerAlive(current.pid);
          const currentStale = currentTime().getTime() - current.mtimeMs > staleAfter;
          const currentDead = lifecycleOwnerIsDead({
            owner: current,
            live: currentLive,
            contenderProcessInstance: contenderInstance,
          });
          if (current.token === owner.token && current.mtimeMs === owner.mtimeMs &&
              currentStale && currentDead) {
            assertSameDirectory(path, recoveryDirectory);
            unlinkSync(current.path);
            rmdirSync(path);
            continue;
          }
        } finally { rmdirSync(recoveryPath); }
      }
      const holderStatus = !live
        ? "The recorded process is no longer running, but the lock is still inside its recovery window."
        : owner.pid === process.pid && owner.process_instance === contenderInstance
          ? "That process is still running."
          : "A process with that ID is running, but this computer could not confirm it is the same one.";
      const heldMinutes = Math.max(1, Math.floor(
        (observedAt.getTime() - Date.parse(owner.created_at)) / 60_000,
      ));
      const guidance = live && stale
        ? `Another Brain task has held the lock for ${heldMinutes} minutes. ` +
          "If no Brain command is running, restart the computer and run the command again."
        : live
          ? `${holderStatus} Wait for it to finish, ${busyRetryInstruction(retryCommand)}`
          : `${holderStatus} Wait for the recovery window to end, ${busyRetryInstruction(retryCommand)}`;
      throw failure(
        "brain_lifecycle_busy",
        `the Brain lifecycle lock is held by ${owner.operation} since ${owner.created_at}. ` +
          guidance,
        { retryable: true },
      );
    }
  }

  return ownedLifecycleLock({ path, token, operation, platform, staleAfter, removeDirectory, waitSync, log, ...coordinates });
}

function together(data, account, legacy) {
  const slots = [...new Set([data, legacy, account].filter(Boolean))];
  if (slots.length === 1 && !account && !legacy) return data;
  return Object.freeze({ ...data, ...(account ? { accountPath: account.path } : {}), ...(legacy ? { legacyPath: legacy.path } : {}),
    assertOwned() { for (const slot of slots) slot.assertOwned(); return true; },
    release() { return slots.map(slot => slot.release()).every(Boolean); },
    childDelegation() { return { ...data.childDelegation(),
      ...(account && account !== data ? { account: account.childDelegation() } : {}),
      ...(legacy && legacy !== data && legacy !== account ? { legacy: legacy.childDelegation() } : {}) }; },
  });
}

export function acquireBrainLifecycleLock(options = {}) {
  const { manifestPath, platform = process.platform, machineLockRoot, home, operation, lockRootOptions = {} } = options;
  if (!operation || !/^[a-z][a-z0-9-]{1,31}$/u.test(String(operation))) {
    throw new TypeError("a bounded lifecycle operation name is required");
  }
  const coordinates = brainLifecycleCoordinates(options);
  // Every Windows writer, including an explicit override, takes the same
  // account-and-Brain slot before publishing any selected-root owner. A scan
  // cannot establish exclusion when the other token cannot read a shared root.
  const accountCoordinates = resolveBrainAccountLockRoot({ ...lockRootOptions, platform, home,
    restrictWindowsDirectory: lockRootOptions.restrictWindowsDirectory ?? options.restrictWindowsDirectory });
  let account, legacy, data;
  try {
    if (accountCoordinates) account = acquireLifecycleSlot({ ...options,
      coordinates: accountCoordinates.root === coordinates.root ? coordinates : { ...accountCoordinates, identity: coordinates.identity } });
    const legacyCoordinates = resolveLegacyBrainLockRoot({ ...lockRootOptions, platform });
    if (legacyCoordinates) {
      try { legacy = account?.root === legacyCoordinates.root ? account : acquireLifecycleSlot({ ...options,
        coordinates: legacyCoordinates.root === coordinates.root ? coordinates : { ...legacyCoordinates, identity: coordinates.identity } }); }
      catch (error) { if (!legacyBrainLockUnavailable(error)) throw error; }
    }
    if (platform === "win32" && !legacy) announcePrivateBrainLock({ ...lockRootOptions,
      root: coordinates.root, home, operation, platform });
    // Fixed order: account, released shared slot, then an optional explicit or
    // private data root. Never release the shared slot while returning a lease.
    data = account?.root === coordinates.root ? account : legacy?.root === coordinates.root ? legacy :
      platform === "win32" && !legacy && coordinates.root === legacyCoordinates?.root ? account :
        acquireLifecycleSlot({ ...options, coordinates });
    // Alternate roots exist only on Windows. Re-running the stricter POSIX
    // preview check here changed the released mutating permission contract.
    const roots = platform === "win32" ? brainLockRootsReadOnly({ ...lockRootOptions, platform, machineLockRoot }) : [];
    for (const root of roots) {
      if (root === coordinates.root || root === legacy?.root || root === account?.root) continue;
      let other;
      try { other = lstatSync(join(root, `brain-lifecycle-${coordinates.identity}.lock`)); }
      catch (error) { if (error?.code === "ENOENT") continue; throw error; }
      if (!other.isDirectory() || other.isSymbolicLink()) {
        throw failure("brain_lifecycle_unsafe", "the alternate Brain lifecycle lock must be one real directory");
      }
      // Recover an abandoned alternate slot only through the same proven-dead
      // rule as the chosen slot; the account lease serializes same-user reapers.
      const alternate = acquireLifecycleSlot({ ...options, coordinates: { ...coordinates, root } });
      alternate.release();
    }
    if (operation !== "update") {
      const fence = readRecoveryFenceAtPath(join(coordinates.root, `brain-update-recovery-${coordinates.identity}.json`)) ||
        (legacy && readRecoveryFenceAtPath(join(legacy.root, `brain-update-recovery-${coordinates.identity}.json`))) ||
        (platform === "win32" && readBrainRecoveryFenceReadOnly({ manifestPath, platform, machineLockRoot, lockRootOptions }));
      if (fence) throw failure("brain_lifecycle_recovery_required", `a prior Brain update requires verified recovery before ${operation} can write`);
    }
    return together(data, account, legacy);
  } catch (error) {
    for (const slot of new Set([data, legacy, account].filter(Boolean))) slot.release();
    throw error;
  }
}

function ownedLifecycleLock({ path, token, operation, platform, staleAfter, removeDirectory, waitSync, log, root = dirname(path), rootKind, identity }) {
  const ownerPath = join(path, OWNER_FILE);
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
    try { return releaseOwner(path, token, platform, { removeDirectory, waitSync }); }
    catch {
      log("The Brain lifecycle lock could not be released; retry after its recovery grace period.");
      return false;
    }
  };
  process.once("exit", release);
  const childDelegation = () => {
    assertOwned();
    if (operation !== "update") throw failure("brain_lifecycle_unsafe", "only an update lease can pass to its child");
    return { schema_version: 1, pid: process.pid, token, process_instance: CURRENT_PROCESS_INSTANCE,
      coordinates: { root, rootKind, identity } };
  };
  return Object.freeze({ path, root, rootKind, identity, operation: String(operation), assertOwned, release, childDelegation });
}

/** Transfer the occupied slot without ever releasing the writer boundary. The
 * child gets a fresh token, so parent exit cleanup cannot release its lease. */
function adoptLifecycleSlot({ coordinates, manifestPath, delegation, platform = process.platform,
  machineLockRoot, lockRootOptions = {}, home, parentPid = process.ppid, isOwnerAlive = ownerAlive,
  log = message => console.error(message),
  restrictWindowsDirectory = (path, options) => (process.platform === "win32"
    ? restrictWindowsDirectoryToCurrentUser(path, options) : undefined),
} = {}) {
  const path = join(coordinates.root, `brain-lifecycle-${coordinates.identity}.lock`);
  try { assertPrivateDirectory(path, "Brain lifecycle lock", platform); }
  catch { throw failure("brain_lifecycle_lost", "the parent update lease could not be verified"); }
  const directory = lstatSync(path, { bigint: true });
  const owner = readOwner(path, platform);
  if (delegation?.schema_version !== 1 || !Number.isSafeInteger(delegation.pid) || delegation.pid !== parentPid ||
      !owner || owner.pid !== parentPid || owner.operation !== "update" || owner.token !== delegation.token ||
      owner.path !== join(path, OWNER_FILE) || owner.process_instance !== delegation.process_instance || !isOwnerAlive(parentPid)) {
    throw failure("brain_lifecycle_lost", "the parent update lease could not be verified");
  }
  const token = randomBytes(16).toString("hex");
  // Stage outside the occupied directory. A crash before rename must not leave
  // an extra entry that would make stale-owner recovery permanently refuse.
  const staging = mkdtempSync(join(dirname(path), "brain-lifecycle-handoff-"));
  const staged = join(staging, OWNER_FILE);
  let written = false;
  try {
    if (platform === "win32") {
      try { restrictWindowsDirectory(staging, { label: "the update lease handoff" }); }
      catch { throw failure("brain_lifecycle_unsafe", "the update lease handoff is not private"); }
    }
    assertPrivateDirectory(staging, "update lease handoff", platform);
    writeFileSync(staged, JSON.stringify({ schema_version: 2, pid: process.pid, token,
      operation: "update", process_instance: CURRENT_PROCESS_INSTANCE, created_at: owner.created_at,
    }), { encoding: "utf8", flag: "wx", mode: 0o600 });
    written = true;
    // Windows can briefly hold owner.json open. Every attempt, including the
    // first, re-proves the unchanged parent lease before replacing it.
    replaceFileWithRetrySync(staged, owner.path, { platform, revalidate: () => {
      assertSameDirectory(path, directory);
      const current = readOwner(path, platform);
      if (!current || current.token !== owner.token || current.pid !== owner.pid ||
          current.process_instance !== owner.process_instance || !isOwnerAlive(parentPid)) {
        throw failure("brain_lifecycle_lost", "the parent update lease changed during handoff");
      }
    } });
    written = false;
    const lock = ownedLifecycleLock({ path, token, operation: "update", platform, ...coordinates,
      staleAfter: DEFAULT_STALE_MS, removeDirectory: rmdirSync,
      waitSync: ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), log });
    try { lock.assertOwned(); } catch (error) { lock.release(); throw error; }
    return lock;
  } finally {
    try {
      if (written) unlinkSync(staged);
      rmdirSync(staging);
    } catch { log("The temporary update lease handoff could not be removed."); }
  }
}

export function adoptParentBrainLifecycleLock(options = {}) {
  const { manifestPath, delegation, platform = process.platform, machineLockRoot, lockRootOptions = {}, home } = options;
  const identity = brainIdentityFromManifest(manifestPath);
  const accountCoordinates = resolveBrainAccountLockRoot({ ...lockRootOptions, platform, home,
    restrictWindowsDirectory: lockRootOptions.restrictWindowsDirectory ?? options.restrictWindowsDirectory });
  let account, legacy, data;
  try {
    let bound = delegation?.coordinates;
    if (!bound) {
      // The previous package delegated only its owner token. Acquire the new
      // account boundary before adopting that exact legacy slot, so a package
      // transition does not silently drop same-account exclusion.
      if (accountCoordinates) account = acquireLifecycleSlot({ ...options, operation: "update",
        coordinates: { ...accountCoordinates, identity } });
      const roots = brainLockRootsReadOnly({ ...lockRootOptions, platform, machineLockRoot });
      for (const root of roots) {
        const owner = readOwner(join(root, `brain-lifecycle-${identity}.lock`), platform);
        if (owner?.token !== delegation?.token || owner?.pid !== delegation?.pid) continue;
        if (bound) throw failure("brain_lifecycle_lost", "the parent update lease is ambiguous");
        const candidate = brainLockRootCandidates({ ...lockRootOptions, platform, machineLockRoot })
          .find(candidate => { try { return candidate.path && realpathSync(candidate.path) === root; } catch { return false; } });
        bound = { root, rootKind: candidate.kind, identity };
      }
    }
    const candidates = [...brainLockRootCandidates({ ...lockRootOptions, platform, machineLockRoot }),
      ...(accountCoordinates ? [{ path: accountCoordinates.root, kind: "account" }] : [])];
    if (!bound || bound.identity !== identity || !candidates.some(candidate => candidate.path &&
        candidate.kind === bound.rootKind && (() => {
          try { return realpathSync(candidate.path) === bound.root; } catch { return false; }
        })())) {
      throw failure("brain_lifecycle_lost", "the parent update lease coordinates could not be verified");
    }
    const sameRoot = accountCoordinates?.root === bound.root;
    if (accountCoordinates && !sameRoot && !account && (delegation.account?.coordinates?.root !== accountCoordinates.root ||
        delegation.account?.coordinates?.identity !== identity)) {
      throw failure("brain_lifecycle_lost", "the parent account lease could not be verified");
    }
    const legacyCoordinates = resolveLegacyBrainLockRoot({ ...lockRootOptions, platform });
    const legacyBound = delegation?.legacy?.coordinates;
    if (delegation?.legacy && (!legacyCoordinates || legacyBound?.root !== legacyCoordinates.root ||
        legacyBound?.rootKind !== "shared" || legacyBound?.identity !== identity)) {
      throw failure("brain_lifecycle_lost", "the parent legacy lease could not be verified");
    }
    if (legacyCoordinates && legacyCoordinates.root !== bound.root && !delegation?.legacy) {
      // Older parents did not delegate this extra slot. Acquire it before
      // transfer; an occupied released slot is still busy, never a fallback.
      try { legacy = account?.root === legacyCoordinates.root ? account : acquireLifecycleSlot({ ...options,
        operation: "update", coordinates: { ...legacyCoordinates, identity } }); }
      catch (error) { if (!legacyBrainLockUnavailable(error)) throw error; }
    }
    // Transfer the selected slot first. The parent retains the common boundary
    // until the second transfer completes, including a crash between transfers.
    data = adoptLifecycleSlot({ ...options, coordinates: bound });
    if (sameRoot) account = data;
    if (legacyCoordinates?.root === bound.root) legacy = data;
    else if (delegation?.legacy) legacy = adoptLifecycleSlot({ ...options,
      delegation: delegation.legacy, coordinates: { ...legacyCoordinates, identity } });
    if (accountCoordinates && !sameRoot && !account) account = adoptLifecycleSlot({ ...options,
      delegation: delegation.account, coordinates: { ...accountCoordinates, identity } });
    if (platform === "win32" && !legacy) announcePrivateBrainLock({ ...lockRootOptions,
      root: bound.root, home, operation: "update", platform });
    return together(data, account, legacy);
  } catch (error) { for (const slot of new Set([data, legacy, account].filter(Boolean))) slot.release(); throw error; }
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
