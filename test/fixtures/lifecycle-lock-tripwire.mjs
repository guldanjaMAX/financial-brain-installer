import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function canonicalFuture(path) {
  if (fs.existsSync(path)) return fs.realpathSync.native(path);
  return resolve(canonicalFuture(dirname(path)), relative(dirname(path), path));
}
const inside = (root, path) => {
  const suffix = relative(root, path);
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
};

// Guard the real lock module's first write, including creation of its parent
// root. Checking only *.lock would already have touched the host directory.
export function installLifecycleLockTripwire(root) {
  const fixtures = (Array.isArray(root) ? root : [root]).map(path => fs.realpathSync.native(path));
  const mkdir = fs.mkdirSync;
  const guard = { attempts: 0, blocked: 0, restore() {
    fs.mkdirSync = mkdir;
    syncBuiltinESMExports();
  } };
  fs.mkdirSync = (path, ...options) => {
    const caller = (new Error().stack ?? "").split("\n")[2] ?? "";
    if (/[/\\]operations[/\\]brain-lifecycle-lock\.mjs:/u.test(caller)) {
      guard.attempts++;
      const target = resolve(path instanceof URL ? fileURLToPath(path) : String(path));
      if (!fixtures.some(fixture => inside(fixture, target) && inside(fixture, canonicalFuture(target)))) {
        guard.blocked++;
        throw new Error("TEST_LIFECYCLE_LOCK_OUTSIDE_FIXTURE");
      }
    }
    return mkdir(path, ...options);
  };
  syncBuiltinESMExports();
  return guard;
}

if (process.env.BRAIN_TEST_LIFECYCLE_ROOT) {
  const guard = installLifecycleLockTripwire(process.env.BRAIN_TEST_LIFECYCLE_ROOT);
  process.on("exit", () => {
    if (guard.blocked) {
      process.stderr.write("TEST_LIFECYCLE_LOCK_OUTSIDE_FIXTURE\n");
      process.exitCode = 1;
    }
  });
}
