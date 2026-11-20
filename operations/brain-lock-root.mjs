/** Shared Windows lock folders can belong to another local account. A private
 * lease cannot exclude an older CLI that still uses an inaccessible or unsafe
 * shared boundary; acquisition must announce that compatibility limit. */
import * as fs from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { recordSupportEvent, SUPPORT_COMMANDS } from "../support-journal.mjs";
import { restrictWindowsDirectoryToCurrentUser } from "./current-user-file.mjs";

export class BrainLifecycleLockError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = "BrainLifecycleLockError";
    this.code = code;
    this.retryable = retryable;
  }
}

const announced = new Set();
const PER_USER = "BRAIN_LOCK_FOLDER_PER_USER";
const UNUSABLE = "BRAIN_LOCK_FOLDER_UNUSABLE";
const sharedLabel = "%ProgramData%\\FinancialBrain\\locks";
const privateLabel = "%LOCALAPPDATA%\\FinancialBrain\\locks";
const accountLabel = "<Windows user profile>\\AppData\\Local\\FinancialBrain\\account-locks";
const help = code => `https://financialbrain.ai/help/${code}`;
const permissionError = error => ["EACCES", "EPERM"].includes(error?.code);
export const legacyBrainLockUnavailable = error => permissionError(error) || error?.code === "brain_lifecycle_unsafe";
const unsafe = () => new BrainLifecycleLockError("brain_lifecycle_unsafe", "the machine Brain lock root must be one real directory, without links");
const unusable = (override = false) => new BrainLifecycleLockError(UNUSABLE,
  `${UNUSABLE}: Windows cannot use ${override ? "the BRAIN_LIFECYCLE_LOCK_ROOT override" : `${sharedLabel} or ${privateLabel}`}. ` +
  `Ask the installer to check folder access as this Windows user. ${help(UNUSABLE)}`);

export function brainLockRootCandidates({ platform = process.platform, machineLockRoot, environment = process.env } = {}) {
  const override = machineLockRoot || (isAbsolute(String(environment.BRAIN_LIFECYCLE_LOCK_ROOT || ""))
    ? environment.BRAIN_LIFECYCLE_LOCK_ROOT : null);
  if (override) return [{ path: resolve(override), kind: "override" }];
  if (platform !== "win32") return [{ path: "/tmp/financial-brain-lifecycle-v1", kind: "shared" }];
  // Never invent a Windows root on the current drive when an OS locator is
  // missing. The private candidate can still be used with the explicit warning.
  const shared = isAbsolute(String(environment.ProgramData || ""))
    ? join(resolve(environment.ProgramData), "FinancialBrain", "locks") : null;
  const personal = isAbsolute(String(environment.LOCALAPPDATA || ""))
    ? join(resolve(environment.LOCALAPPDATA), "FinancialBrain", "locks") : null;
  return [{ path: shared, kind: "shared" }, { path: personal, kind: "per-user" }];
}

function inspectWindowsChain(path, fileSystem) {
  // Inspect existing ancestors before recursive mkdir can follow a junction.
  // Windows junctions are reparse-point links reported by lstat as symlinks.
  const chain = [];
  for (let current = path; ; current = dirname(current)) {
    chain.unshift(current);
    if (dirname(current) === current) break;
  }
  for (const current of chain) {
    try {
      const state = fileSystem.lstatSync(current);
      if (!state.isDirectory() || state.isSymbolicLink()) throw unsafe();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function prepareRoot(candidate, { platform, fileSystem, restrictWindowsDirectory }) {
  const path = candidate.path;
  if (!path) throw Object.assign(new Error("Windows folder locator unavailable"), { code: "EACCES" });
  if (platform === "win32") inspectWindowsChain(path, fileSystem);
  fileSystem.mkdirSync(path, { recursive: true, mode: platform === "win32" ? 0o700 : 0o1777 });
  const state = fileSystem.lstatSync(path);
  if (!state.isDirectory() || state.isSymbolicLink()) throw unsafe();
  if (platform !== "win32") {
    if ((state.mode & 0o002) === 0 || (state.mode & 0o1000) === 0) {
      fileSystem.chmodSync(path, 0o1777);
      if ((fileSystem.lstatSync(path).mode & 0o002) === 0) {
        throw new BrainLifecycleLockError("brain_lifecycle_unsafe", "the machine Brain lock root is not shared safely");
      }
    }
    return fileSystem.realpathSync(path);
  }
  inspectWindowsChain(path, fileSystem);
  if (candidate.kind === "per-user") restrictWindowsDirectory(path, { label: "the per-user Brain lock folder" });
  fileSystem.readdirSync(path);
  const probe = join(path, `.brain-lock-probe-${randomBytes(16).toString("hex")}`);
  let descriptor;
  try {
    descriptor = fileSystem.openSync(probe, "wx", 0o600);
  } finally {
    if (descriptor !== undefined) {
      try { fileSystem.closeSync(descriptor); } finally { fileSystem.unlinkSync(probe); }
    }
  }
  inspectWindowsChain(path, fileSystem);
  return fileSystem.realpathSync(path);
}


/** Use the same declared home as the install and its isolated child processes.
 * LOCALAPPDATA and selected-root overrides cannot move this exclusion slot.
 * Never fall back to the host account profile after an isolated-root failure. */
export function resolveBrainAccountLockRoot({ platform = process.platform, environment = process.env,
  home = environment.HOME || environment.USERPROFILE || homedir(),
  windowsAccountHome,
  fileSystem = fs, restrictWindowsDirectory = (path, options) => process.platform === "win32"
    ? restrictWindowsDirectoryToCurrentUser(path, options) : undefined,
} = {}) {
  if (platform !== "win32") return null;
  try {
    const profile = windowsAccountHome === undefined ? home : windowsAccountHome;
    if (!isAbsolute(String(profile || ""))) throw new Error("account profile unavailable");
    const root = prepareRoot({ path: join(profile, "AppData", "Local", "FinancialBrain", "account-locks"), kind: "per-user" },
      { platform, fileSystem, restrictWindowsDirectory });
    return Object.freeze({ root, rootKind: "account" });
  } catch {
    throw new BrainLifecycleLockError(UNUSABLE, `${UNUSABLE}: Windows cannot safely use ${accountLabel}. ` +
      `Keep existing locks and recovery records. Ask the installer to inspect this account's folder access and links. ${help(UNUSABLE)}`);
  }
}

export function resolveBrainLockRoot({ platform = process.platform, machineLockRoot,
  environment = process.env, home = environment.HOME || environment.USERPROFILE || homedir(), operation = "update", fileSystem = fs,
  log = line => console.error(line), recordEvent = recordSupportEvent,
  restrictWindowsDirectory = (path, options) => process.platform === "win32"
    ? restrictWindowsDirectoryToCurrentUser(path, options) : undefined,
} = {}) {
  const candidates = brainLockRootCandidates({ platform, machineLockRoot, environment });
  for (const candidate of candidates) {
    let root;
    try { root = prepareRoot(candidate, { platform, fileSystem, restrictWindowsDirectory }); }
    catch (error) {
      if (platform !== "win32") throw error;
      if (candidate.kind === "shared" && legacyBrainLockUnavailable(error)) continue;
      if (error?.code === "brain_lifecycle_unsafe" && candidate.kind !== "per-user") {
        throw Object.assign(new BrainLifecycleLockError("brain_lifecycle_unsafe",
          `${UNUSABLE}: Windows stopped because the Brain lock folder must be one real directory, without links or junctions. ` +
          `Keep existing locks and recovery records. Ask the installer to inspect the folder. ${help(UNUSABLE)}`),
        { supportCode: UNUSABLE });
      }
      // A failed current-user ACL must not leave a usable-looking fallback.
      if (candidate.kind !== "shared") throw unusable(candidate.kind === "override");
      throw error;
    }
    if (candidate.kind === "per-user") announcePrivateBrainLock({ root, home, operation, platform, log, recordEvent });
    return Object.freeze({ root, rootKind: candidate.kind });
  }
  throw unusable();
}

/** Overrides select the data/fence root, but cannot move the boundary an
 * unchanged released CLI uses. Retain its exact ProgramData slot when usable. */
export function resolveLegacyBrainLockRoot({ platform = process.platform, environment = process.env,
  fileSystem = fs, restrictWindowsDirectory = () => {},
} = {}) {
  if (platform !== "win32") return null;
  const candidate = brainLockRootCandidates({ platform, environment: { ProgramData: environment.ProgramData } })[0];
  try {
    return Object.freeze({ root: prepareRoot(candidate, { platform, fileSystem, restrictWindowsDirectory }), rootKind: "shared" });
  } catch (error) {
    if (legacyBrainLockUnavailable(error)) return null;
    throw error;
  }
}

export function announcePrivateBrainLock({ root, environment = process.env,
  home = environment.HOME || environment.USERPROFILE || homedir(), operation = "update", platform = "win32",
  log = line => console.error(line), recordEvent = recordSupportEvent,
} = {}) {
  if (announced.has(root)) return;
  let journalFailed = false;
  try {
    recordEvent({ command: SUPPORT_COMMANDS.includes(operation) ? operation : "update", source: "installer", errorCode: PER_USER }, { root: home, platform });
  } catch { journalFailed = true; }
  log(`${PER_USER}: Using private Windows account locks; another Windows account on this PC cannot see this lock or its recovery fence. ` +
    `Run Brain commands from this Windows account. Do not run an older Brain tool at the same time. ${help(PER_USER)}` +
    (journalFailed ? " The local issue note could not be saved." : ""));
  announced.add(root);
}

/** Preview callers inspect all possible fences without a write probe, ACL
 * repair, warning journal or directory creation. A readable shared directory
 * can still be unwritable, so a private fence must remain visible in preview. */
export function brainLockRootsReadOnly(options = {}) {
  const { platform = process.platform, fileSystem = fs } = options;
  const roots = [];
  for (const candidate of brainLockRootCandidates(options)) {
    if (!candidate.path) continue;
    // Preserve the released POSIX read-only lookup, including its absent-root
    // decision. Windows must inspect links and access errors explicitly.
    if (platform !== "win32" && !fileSystem.existsSync(candidate.path)) continue;
    try {
      if (platform === "win32") inspectWindowsChain(candidate.path, fileSystem);
      const state = fileSystem.lstatSync(candidate.path);
      if (!state.isDirectory() || state.isSymbolicLink()) throw unsafe();
      if (platform !== "win32" && ((state.mode & 0o002) === 0 || (state.mode & 0o1000) === 0)) {
        throw new BrainLifecycleLockError("brain_lifecycle_unsafe", "the machine Brain lock root does not have the required shared permissions");
      }
      roots.push(fileSystem.realpathSync(candidate.path));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (platform === "win32" && candidate.kind === "shared" && legacyBrainLockUnavailable(error)) continue;
      throw error;
    }
  }
  return roots;
}
