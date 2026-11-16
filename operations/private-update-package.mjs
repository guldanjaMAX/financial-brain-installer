import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolveNpmCliPath } from "./npm-cli-runtime.mjs";
import { PRIVATE_UPDATE_BINDING_ENV, PrivateOfferError, assertPrivateUpdateBinding, refusePrivateOffer,
  verifyPrivatePackage } from "./private-update-offer.mjs";
import { inspectNpmArchiveBytes, readStableRegularFile } from "./package-bundle-verifier.mjs";
import { BRAIN_LIFECYCLE_PARENT_ENV, acquireBrainLifecycleLock, withBrainLifecycleLock } from "./brain-lifecycle-lock.mjs";
import { restrictWindowsDirectoryToCurrentUser } from "./current-user-file.mjs";
import { PRIVATE_UPDATE_OUTCOME_ENV, preparePrivateUpdateSchedule, privateUpdatePreparationSettled,
  readPrivateUpdateOutcome } from "./private-update-recovery.mjs";

import { preparePrivateRuntimeSwap } from "./private-update-swap.mjs";
import { LOCAL_FILE_LOCKED } from "./rename-retry.mjs";

const PRODUCT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const INSTALL_ENV_NAMES = Object.freeze([
  "PATH", "Path", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TMPDIR", "TMP", "TEMP",
  "SystemRoot", "SYSTEMROOT", "WINDIR", "SystemDrive", "ProgramData", "USERNAME", "USERDOMAIN", "HOMEDRIVE", "HOMEPATH",
  "ComSpec", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TERM", "NO_COLOR", "BRAIN_NO_WRANGLER_LOGIN",
]);

/** The normal updater needs OS/config locators and explicitly supported network
 * settings. npm never receives control-plane access. Keep both environments
 * allowlisted rather than copying unrelated desktop credentials or loaders. */
export function privateUpdateChildEnvironment(environment, extras = {}) {
  const clean = {};
  for (const key of [...INSTALL_ENV_NAMES, "USER", "LOGNAME", "LANGUAGE", "SHELL",
    "PROGRAMDATA", "ALLUSERSPROFILE", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "PSModulePath", "COMPUTERNAME",
    "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_USE_ENV_PROXY",
    "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "WRANGLER_HOME",
    "BRAIN_TEST_USER_ROOT", "BRAIN_LIFECYCLE_LOCK_ROOT"]) {
    if (typeof environment[key] === "string") clean[key] = environment[key];
  }
  clean.HOME ??= homedir();
  return { ...clean, ...extras };
}

export async function installPrivateUpdatePackage({ bytes, offer, manifestPath, binding }, {
  runtimeRoot = PRODUCT_ROOT, environment = process.env,
  spawn = spawnSync, npmCli, lifecycleLockOptions = {}, scheduleOptions = {},
  rename = renameSync, platform = process.platform,
  restrictDirectory = restrictWindowsDirectoryToCurrentUser, renameOptions = {},
} = {}) {
  verifyPrivatePackage(bytes, offer);
  let inspected;
  try {
    inspected = inspectNpmArchiveBytes(bytes);
    if (inspected.packageJson?.name !== "brain-installer" || inspected.packageJson.version !== offer.to_version) {
      refusePrivateOffer("PRIVATE_OFFER_PACKAGE");
    }
  } catch { refusePrivateOffer("PRIVATE_OFFER_PACKAGE"); }
  try {
    runtimeRoot = realpathSync(runtimeRoot);
    if (basename(runtimeRoot) !== "brain-installer" || basename(dirname(runtimeRoot)) !== "node_modules" ||
        JSON.parse(readFileSync(join(runtimeRoot, "package.json"), "utf8")).name !== "brain-installer") {
      refusePrivateOffer("PRIVATE_OFFER_INSTALL");
    }
  } catch { refusePrivateOffer("PRIVATE_OFFER_INSTALL"); }
  const checkBinding = () => {
    try {
      const raw = readStableRegularFile(manifestPath);
      const manifest = JSON.parse(raw.toString("utf8"));
      assertPrivateUpdateBinding({ manifest, fingerprint: createHash("sha256").update(raw).digest("hex") }, binding);
      return manifest;
    } catch { refusePrivateOffer("PRIVATE_OFFER_BINDING"); }
  };
  // The task is paused under the same lease that guards replacement. npm only
  // writes a separate prefix; a failed install cannot damage the working CLI.
  return withBrainLifecycleLock({ ...lifecycleLockOptions, manifestPath, operation: "update",
    retryCommand: "brain update <manifest>",
  }, async ({ lock }) => {
    const manifest = checkBinding();
    let schedule, staging, priorMoved = false, childStarted = false, schedulePrepared = false;
    let recoveryLock, swap;
    const recoveryFailure = () => {
      const error = new PrivateOfferError("PRIVATE_OFFER_RECOVERY");
      if (swap) {
        error.recoveryEntry = swap.entry;
        error.message += ` Saved executable recovery entry: ${swap.entry}`;
      }
      return error;
    };
    try {
      schedule = await preparePrivateUpdateSchedule(manifest, manifestPath, environment, scheduleOptions, lifecycleLockOptions);
      schedulePrepared = true;
      // A sibling on the same volume permits rename-only replacement/rollback.
      // Keep the prior runtime and exact archive as private recovery material.
      staging = mkdtempSync(join(dirname(runtimeRoot), ".brain-private-update-"));
      if (platform === "win32") restrictDirectory(staging, { environment });
      mkdirSync(join(staging, "cache"), { mode: 0o700 });
      writeFileSync(join(staging, "candidate.tgz"), bytes, { flag: "wx", mode: 0o600 });
      writeFileSync(join(staging, "npmrc"), "", { flag: "wx", mode: 0o600 });
      const env = {};
      for (const key of INSTALL_ENV_NAMES) {
        if (typeof environment[key] === "string") env[key] = environment[key];
      }
      env.HOME ??= homedir();
      env.NPM_CONFIG_USERCONFIG = join(staging, "npmrc");
      const cli = npmCli ?? resolveNpmCliPath({ environment: env });
      const prefix = join(staging, "candidate");
      const result = spawn(process.execPath, [cli, "install", "--prefix", prefix, "--offline", "--ignore-scripts",
        "--omit=dev", "--no-audit", "--no-fund", "--cache", join(staging, "cache"), join(staging, "candidate.tgz")], {
        env, cwd: staging, shell: false, stdio: "inherit",
      });
      if (result.error || result.status !== 0) refusePrivateOffer("PRIVATE_OFFER_INSTALL");
      const candidate = realpathSync(join(prefix, "node_modules", "brain-installer"));
      if (!candidate.startsWith(staging + sep)) refusePrivateOffer("PRIVATE_OFFER_INSTALL");
      for (const row of inspected.rows) {
        const path = join(candidate, ...row.path.split("/"));
        let installed;
        if (row.bytes === 0) {
          const info = lstatSync(path);
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== 0 ||
              !realpathSync(path).startsWith(candidate + sep)) refusePrivateOffer("PRIVATE_OFFER_INSTALL");
          installed = Buffer.alloc(0);
        } else installed = readStableRegularFile(path, { root: candidate });
        if (installed.length !== row.bytes || createHash("sha256").update(installed).digest("hex") !== row.sha256) {
          refusePrivateOffer("PRIVATE_OFFER_INSTALL");
        }
      }
      checkBinding();
      lock.assertOwned();
      swap = preparePrivateRuntimeSwap({ staging, runtimeRoot, candidate, manifestPath, binding, lifecycleLockOptions,
        renameOptions: { ...renameOptions, platform } });
      priorMoved = true;
      swap.forward(rename);
      // The new package takes the occupied lease without opening a writer gap.
      swap.phase("child_started");
      childStarted = true;
      const child = spawn(process.execPath, [join(runtimeRoot, "brain.mjs"), "update", manifestPath], {
        env: privateUpdateChildEnvironment(environment, { [PRIVATE_UPDATE_BINDING_ENV]: JSON.stringify(binding),
          [PRIVATE_UPDATE_OUTCOME_ENV]: join(staging, "outcome.json"),
          [BRAIN_LIFECYCLE_PARENT_ENV]: JSON.stringify(lock.childDelegation()) }), shell: false, stdio: "inherit",
      });
      if (child.error || child.status !== 0) refusePrivateOffer("PRIVATE_OFFER_UPDATE");
      if (readPrivateUpdateOutcome(join(staging, "outcome.json"), binding) !== "verified") {
        throw recoveryFailure();
      }
      try { lock.assertOwned(); }
      catch { recoveryLock = acquireBrainLifecycleLock({ ...lifecycleLockOptions, manifestPath, operation: "update" }); }
      await schedule?.complete();
      return { status: "updated" };
    } catch (error) {
      // No receipt means an interrupted child may have dispatched remotely.
      // Keep its new runtime, original backup and paused task for recovery.
      const safeToRestore = !childStarted || readPrivateUpdateOutcome(join(staging, "outcome.json"), binding) === "not_started";
      if (!safeToRestore) {
        try {
          try { lock.assertOwned(); }
          catch { recoveryLock = acquireBrainLifecycleLock({ ...lifecycleLockOptions, manifestPath, operation: "update" }); }
          await schedule?.hold();
        } catch { /* Preserve the existing pause/fence when a dead child's lease is still held. */ }
        throw recoveryFailure();
      }
      try {
        try { lock.assertOwned(); }
        catch { recoveryLock = acquireBrainLifecycleLock({ ...lifecycleLockOptions, manifestPath, operation: "update" }); }
        if (priorMoved) checkBinding();
        schedule?.authorizeRuntimeRollback();
        await schedule?.pause();
        if (priorMoved) swap.rollback(rename);
        await schedule?.restore();
      } catch {
        // No package bytes moved on this binding failure. Keep the original
        // diagnostic and any unresolved schedule receipt; do not mask it as a
        // failed executable rollback or clear custody we cannot re-prove.
        if (!priorMoved && error?.code === "PRIVATE_OFFER_BINDING") throw error;
        throw recoveryFailure();
      }
      // A failed preparation has no transaction to restore here. Its paused
      // tasks, receipt or fence may remain, so only a proven clean state may
      // be reported as a plain refusal; anything else is saved recovery.
      if (!schedulePrepared && !privateUpdatePreparationSettled(error, manifestPath, scheduleOptions, lifecycleLockOptions)) {
        throw recoveryFailure();
      }
      if (error?.code?.startsWith("PRIVATE_OFFER_")) throw error;
      if (error?.supportCode === LOCAL_FILE_LOCKED) {
        // Proven restored above; name the Windows file lock, with one code.
        const locked = new PrivateOfferError("PRIVATE_OFFER_INSTALL");
        locked.supportCode = LOCAL_FILE_LOCKED;
        const [cause, advice] = error.readOnlyDestination
          ? ["Windows would not replace a Brain file marked read-only", "Turn off the read-only setting on the files in the Brain folder"]
          : ["Windows kept a Brain file in use", "Close any program that may be reading the Brain folder, such as a backup, sync or virus scan"];
        locked.message = `${cause} while the private update was saving its progress, so the update stopped and the prior ` +
          `CLI and daily tasks are as they were before this run. ${advice}, then run the same command again. ` +
          `Support code: ${LOCAL_FILE_LOCKED}`;
        throw locked;
      }
      refusePrivateOffer("PRIVATE_OFFER_INSTALL");
    } finally { recoveryLock?.release(); }
  });
}
