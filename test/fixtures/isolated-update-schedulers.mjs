import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installLifecycleLockTripwire } from "./lifecycle-lock-tripwire.mjs";

function absentLaunchctl(args) {
  if (args[0] === "list") return { status: 0, stdout: "PID Status Label\n" };
  if (args[0] === "print-disabled") return { status: 0, stdout: "disabled services = {\n}\n" };
  assert.equal(args[0], "print", "an absent fixture job cannot authorize a native mutation");
  return { status: 113, stdout: "", stderr: "not loaded" };
}

export function isolatedUpdateSchedulerOptions(home, options = {}) {
  const schedulerHome = options.schedulerOptions?.home ?? options.legacySchedulerOptions?.home ?? home;
  mkdirSync(join(schedulerHome, "Library", "LaunchAgents"), { recursive: true, mode: 0o700 });
  return {
    ...options,
    schedulerAdapter: options.schedulerAdapter ?? { read: () => ({ exists: false }) },
    schedulerOptions: { home: schedulerHome, machineLockRoot: join(schedulerHome, "machine-locks"), uid: 501, ...options.schedulerOptions },
    legacySchedulerOptions: { home: schedulerHome, uid: 501, launchctl: absentLaunchctl, ...options.legacySchedulerOptions },
    bridgeOptions: { adapter: { inventory: () => ({ entries: [], ignored: 0 }) }, ...options.bridgeOptions },
  };
}

// Keep the real update path and each test's specific adapters, but give every
// otherwise implicit scheduler lookup a disposable home and a read-only native
// double. HOME alone does not isolate the current user's launchd GUI domain.
export function isolateUpdateSchedulers(update) {
  return async (manifestPath, options = {}) => {
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), "update-schedulers-")));
    // Daily recovery fences also use the lock module beneath the caller's
    // disposable manifest home, separately from this wrapper's lifecycle root.
    const roots = [home];
    if (typeof manifestPath === "string") roots.push(dirname(manifestPath));
    if (options.lifecycleLockOptions?.machineLockRoot) roots.push(dirname(options.lifecycleLockOptions.machineLockRoot));
    const guard = installLifecycleLockTripwire(roots);
    try {
      return await update(manifestPath, {
        ...options,
        dailyRefreshOptions: isolatedUpdateSchedulerOptions(home, options.dailyRefreshOptions),
        lifecycleLockOptions: { machineLockRoot: join(home, "lifecycle-locks"), ...options.lifecycleLockOptions },
      });
    } finally {
      guard.restore();
      rmSync(home, { recursive: true, force: true });
      assert.equal(guard.blocked, 0, "every update lifecycle lock stayed in its fixture");
    }
  };
}
