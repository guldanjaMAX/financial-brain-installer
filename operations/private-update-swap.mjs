/** A saved entry outside both renamed directories survives process loss.
 * It repairs executable bytes only; the schedule fence survives until the
 * normal update has reconciled every task with exact native readback. */
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateRuntimeInventory } from "./private-update-runtime.mjs";
import { readStableRegularFile } from "./package-bundle-verifier.mjs";
import { withBrainLifecycleLock } from "./brain-lifecycle-lock.mjs";
import { replaceFileWithRetrySync } from "./rename-retry.mjs";

const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** A directory sharing lock is retryable only before any path has moved.
 * Never repeat an ambiguous rename or replace an unexpected destination. A
 * Windows host retries whichever platform a caller models: its file system
 * holds the lock. */
export function renameWithRetry(rename, from, to, { platform = process.platform, attempts = 8,
  delaysMs = [50, 100, 200, 400, 800, 1600, 2000], sleep = sleepSync,
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 8 || !Array.isArray(delaysMs) ||
      !delaysMs.length || delaysMs.some(ms => !Number.isFinite(ms) || ms < 0 || ms > 2000)) {
    throw new TypeError("invalid directory rename retry budget");
  }
  for (let attempt = 0; ; attempt++) {
    try { return rename(from, to); }
    catch (error) {
      if ((platform !== "win32" && process.platform !== "win32") || !["EPERM", "EACCES", "EBUSY"].includes(error?.code) ||
          attempt + 1 >= attempts || !existsSync(from) || existsSync(to)) throw error;
      sleep(delaysMs[Math.min(attempt, delaysMs.length - 1)]);
      if (!existsSync(from) || existsSync(to)) throw error;
    }
  }
}

// Each phase replaces the journal it wrote moments earlier, which a Windows
// scanner may still hold open. An unsaved phase never leaves its staged copy.
function durable(path, value, platform) {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
  let saved = false;
  try {
    const fd = openSync(temporary, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    replaceFileWithRetrySync(temporary, path, { platform });
    saved = true;
  } finally {
    if (!saved) {
      try { unlinkSync(temporary); } catch { /* The original failure is the result. */ }
    }
  }
}

// Copy the reviewed static module closure, not the old installed package. The
// latter need not contain the new recovery implementation. No npm is involved.
function saveRecoveryCode(destination) {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const seen = new Set();
  function copy(source) {
    if (seen.has(source)) return;
    seen.add(source);
    const path = relative(sourceRoot, source);
    if (path.startsWith("..")) throw new Error("recovery import escapes product source");
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(source, target);
    const code = readFileSync(source, "utf8");
    for (const match of code.matchAll(/^(?:import|export)\s+(?:[^;]*?\s+from\s+)?["'](\.[^"']+)["']/gmu)) {
      if (match[1].endsWith(".mjs")) copy(resolve(dirname(source), match[1]));
    }
  }
  copy(fileURLToPath(import.meta.url));
}

export function preparePrivateRuntimeSwap({ staging, runtimeRoot, candidate, manifestPath, binding,
  lifecycleLockOptions = {}, renameOptions = {} }) {
  const journalPath = join(staging, "swap.json");
  const backup = join(staging, "prior-runtime"), failed = join(staging, "failed-runtime");
  saveRecoveryCode(join(staging, "recovery-code"));
  const entry = join(staging, "recover.mjs");
  writeFileSync(entry, 'import { recoverPrivateRuntime } from "./recovery-code/operations/private-update-swap.mjs";\n' +
    'try { await recoverPrivateRuntime(new URL("./swap.json", import.meta.url)); console.log("Executable recovery verified. Keep the schedule receipt and retry the normal update."); }\n' +
    'catch { console.error("Executable recovery remains pending. Preserve this directory and the schedule receipt; retry after the lifecycle recovery window or directory hold clears."); process.exitCode = 1; }\n',
  { flag: "wx", mode: 0o600 });
  const journal = { schema_version: 1, runtimeRoot, manifestPath, binding, phase: "prepared",
    prior: privateRuntimeInventory(runtimeRoot), candidate: privateRuntimeInventory(candidate),
    lock: { ...(lifecycleLockOptions.platform ? { platform: lifecycleLockOptions.platform } : {}),
      ...(lifecycleLockOptions.machineLockRoot ? { machineLockRoot: lifecycleLockOptions.machineLockRoot } : {}) } };
  const phase = value => { journal.phase = value; durable(journalPath, journal, renameOptions.platform); };
  phase("prepared");
  const verified = (path, inventory) => existsSync(path) && privateRuntimeInventory(path) === inventory;
  return {
    entry, phase,
    forward(rename = renameSync) {
      phase("forward_remove");
      renameWithRetry(rename, runtimeRoot, backup, renameOptions);
      phase("forward_install");
      renameWithRetry(rename, candidate, runtimeRoot, renameOptions);
      if (!verified(runtimeRoot, journal.candidate)) throw new Error("candidate runtime readback failed");
      phase("installed");
    },
    rollback(rename = renameSync) {
      if (!existsSync(backup)) {
        if (!verified(runtimeRoot, journal.prior)) throw new Error("prior runtime is not available");
        phase("restored"); return;
      }
      if (!verified(backup, journal.prior)) throw new Error("prior runtime changed");
      phase("rollback_remove");
      if (existsSync(runtimeRoot)) renameWithRetry(rename, runtimeRoot, failed, renameOptions);
      phase("rollback_restore");
      try {
        renameWithRetry(rename, backup, runtimeRoot, renameOptions);
      } catch (error) {
        // A scanner can deny restoration. Put the verified candidate back so
        // the configured launcher can still start; retain the old backup.
        if (!existsSync(runtimeRoot) && verified(failed, journal.candidate)) renameWithRetry(rename, failed, runtimeRoot, renameOptions);
        throw error;
      }
      if (!verified(runtimeRoot, journal.prior)) throw new Error("prior runtime readback failed");
      phase("restored");
    },
  };
}

export async function recoverPrivateRuntime(journalUrl, { lifecycleLockOptions = {}, rename = renameSync,
  platform = process.platform, renameOptions = {},
} = {}) {
  const journalPath = journalUrl instanceof URL ? fileURLToPath(journalUrl) : journalUrl;
  const staging = realpathSync(dirname(journalPath));
  const info = lstatSync(journalPath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 32 * 1024 * 1024 ||
      (process.platform !== "win32" && (info.mode & 0o077))) throw new Error("unsafe swap receipt");
  const value = JSON.parse(readStableRegularFile(journalPath, { maxBytes: 32 * 1024 * 1024 }).toString("utf8"));
  if (value.schema_version !== 1 || basename(value.runtimeRoot) !== "brain-installer" ||
      realpathSync(dirname(value.runtimeRoot)) !== dirname(staging) ||
      !["prepared", "forward_remove", "forward_install", "installed", "rollback_remove", "rollback_restore", "restored", "child_started"].includes(value.phase)) {
    throw new Error("invalid swap receipt");
  }
  return withBrainLifecycleLock({ ...value.lock, ...lifecycleLockOptions, manifestPath: value.manifestPath, operation: "update" }, () => {
    const fingerprint = createHash("sha256").update(readFileSync(value.manifestPath)).digest("hex");
    if (fingerprint !== value.binding.fingerprint) throw new Error("manifest changed; preserve recovery evidence");
    const current = value.runtimeRoot, backup = join(staging, "prior-runtime"), failed = join(staging, "failed-runtime");
    const valid = (path, expected) => existsSync(path) && privateRuntimeInventory(path) === expected;
    if (value.phase === "child_started") {
      // Executable repair alone cannot settle a dispatched child's remote or
      // scheduler outcome. Keep its verified candidate for the normal update.
      // Only the live parent can authorize rollback from the bound child proof
      // and the full durable pre-dispatch schedule transaction together.
      if (!valid(current, value.candidate)) throw new Error("unproved child outcome");
      return;
    }
    if (valid(current, value.prior)) { value.phase = "restored"; durable(journalPath, value, platform); return; }
    if (!valid(backup, value.prior)) throw new Error("prior runtime is not available");
    // Persist authorization before removing the candidate. Every crash boundary
    // is repeatable from a fresh process using the same immutable inventories.
    value.phase = "rollback_remove"; durable(journalPath, value, platform);
    if (existsSync(current)) {
      if (!valid(current, value.candidate) || existsSync(failed)) throw new Error("runtime changed");
      renameWithRetry(rename, current, failed, { ...renameOptions, platform });
    }
    value.phase = "rollback_restore"; durable(journalPath, value, platform);
    try { renameWithRetry(rename, backup, current, { ...renameOptions, platform }); }
    catch (error) {
      if (!existsSync(current) && valid(failed, value.candidate)) renameWithRetry(rename, failed, current, { ...renameOptions, platform });
      throw error;
    }
    if (!valid(current, value.prior)) throw new Error("prior runtime readback failed");
    value.phase = "restored"; durable(journalPath, value, platform);
  });
}
