import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { acquireBrainLifecycleLock } from "../../operations/brain-lifecycle-lock.mjs";
const input = JSON.parse(process.argv[2]);
let decisions = 0, collisions = 0, lease;
const mkdir = fs.mkdirSync;
fs.mkdirSync = (path, ...args) => {
  try { return mkdir(path, ...args); }
  catch (error) { if (String(path).endsWith(".lock") && error.code === "EEXIST") collisions++; throw error; }
};
syncBuiltinESMExports();
const fileSystem = { ...fs, lstatSync(path, ...args) {
  if (input.denyShared && path === input.environment.ProgramData) {
    throw Object.assign(new Error("synthetic permission decision"), { code: "EACCES" });
  }
  return fs.lstatSync(path, ...args);
} };
process.on("message", message => {
  if (message === "acquire") {
    try {
      lease = acquireBrainLifecycleLock({ manifestPath: input.manifestPath, home: input.home,
        platform: "win32", operation: "update", restrictWindowsDirectory() {},
        lockRootOptions: { environment: input.environment, fileSystem, windowsAccountHome: input.home,
          log() {}, recordEvent() {}, restrictWindowsDirectory() {} },
        isOwnerAlive(pid) { decisions++; try { process.kill(pid, 0); return true; } catch { return false; } },
      });
      process.send({ kind: "acquired", path: lease.path, accountPath: lease.accountPath });
    } catch (error) { process.send({ kind: error.code === "brain_lifecycle_busy" ? "busy" : "failure", decisions, collisions, message: error.message }); }
  } else if (message === "release") {
    const released = lease.release(); lease = null;
    process.send({ kind: released ? "released" : "failure" });
  }
});
process.send({ kind: "ready" });
