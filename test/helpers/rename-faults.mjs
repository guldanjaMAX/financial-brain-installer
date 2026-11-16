import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// Same wording as the native Windows refusals, so support classification of a
// synthetic lock matches what a native run reports.
const MESSAGES = Object.freeze({
  EPERM: "operation not permitted",
  EBUSY: "resource busy or locked",
  EACCES: "permission denied",
});

/**
 * Inject Windows sharing refusals into node:fs renameSync for this process.
 * Node's documented builtin-export sync updates every module's live binding,
 * so the product code under test keeps its own imports and gains no hook.
 * `decide(from, to, attempt)` returns an error code to throw, or null to let
 * the real rename run. `attempt` counts calls for the same staged source.
 */
export function injectRenameFaults(t, decide) {
  const original = fs.renameSync;
  const attempts = new Map();
  const calls = [];
  fs.renameSync = function renameSync(from, to) {
    const source = String(from), target = String(to);
    const attempt = (attempts.get(source) || 0) + 1;
    attempts.set(source, attempt);
    const code = decide(source, target, attempt) || null;
    calls.push({ from: source, to: target, attempt, code });
    if (code) {
      throw Object.assign(new Error(`${code}: ${MESSAGES[code] || "synthetic sharing lock"}, rename '${source}' -> '${target}'`),
        { code, syscall: "rename", path: source, dest: target });
    }
    return original.call(this, from, to);
  };
  syncBuiltinESMExports();
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    fs.renameSync = original;
    syncBuiltinESMExports();
  };
  t.after(restore);
  return { calls, restore };
}

/**
 * Inject the same Windows refusals into node:fs unlinkSync. `decide(path,
 * attempt)` returns an error code, or null to run the real removal; `attempt`
 * counts calls for the same path.
 */
export function injectUnlinkFaults(t, decide) {
  const original = fs.unlinkSync;
  const attempts = new Map();
  const calls = [];
  fs.unlinkSync = function unlinkSync(path) {
    const target = String(path);
    const attempt = (attempts.get(target) || 0) + 1;
    attempts.set(target, attempt);
    const code = decide(target, attempt) || null;
    calls.push({ path: target, attempt, code });
    if (code) {
      throw Object.assign(new Error(`${code}: ${MESSAGES[code] || "synthetic sharing lock"}, unlink '${target}'`),
        { code, syscall: "unlink", path: target });
    }
    return original.call(this, path);
  };
  syncBuiltinESMExports();
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    fs.unlinkSync = original;
    syncBuiltinESMExports();
  };
  t.after(restore);
  return { calls, restore };
}

/** Every refused removal must later succeed for the same path. */
export function refusedThenRemoved(calls) {
  const refused = calls.filter(call => call.code);
  return refused.length > 0 && refused.every(call =>
    calls.some(next => next.path === call.path && next.attempt > call.attempt && !next.code));
}

export function isRecoveryFence(path) {
  return /[\\/]brain-update-recovery-[a-f0-9]{32}\.json$/u.test(path);
}

const TRANSACTION_RECEIPT = /daily-update-transactions[\\/](?:v1-[a-f0-9]+|history[\\/][a-f0-9]{32})\.json$/u;

export function isDailyUpdateReceipt(to) {
  return TRANSACTION_RECEIPT.test(to);
}

export function isPrivateSwapJournal(to) {
  return /[\\/]swap\.json$/u.test(to);
}

/** Every refused replacement must later succeed from the same staged file. */
export function refusedThenReplaced(calls) {
  const refused = calls.filter(call => call.code);
  return refused.length > 0 && refused.every(call =>
    calls.some(next => next.from === call.from && next.attempt > call.attempt && !next.code));
}
