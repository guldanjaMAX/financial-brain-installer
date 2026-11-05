import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { basename, join, resolve } from "node:path";

const home = process.env.BRAIN_TEST_SCHEDULER_SENTINEL_HOME;
if (!home || !fs.existsSync(join(home, "Library", "LaunchAgents", "com.brain-installer.sentinel.curated-sync.plist"))) {
  throw new Error("scheduler sentinel fixture is missing");
}
os.homedir = () => home;
const readdir = fs.readdirSync;
fs.readdirSync = (path, ...args) => {
  if (resolve(String(path)) === join(home, "Library", "LaunchAgents")) {
    process.stderr.write("SCHEDULER_SENTINEL_REACHED\n");
  } else if (basename(String(path)) === "LaunchAgents") {
    process.stderr.write("SCHEDULER_FIXTURE_INVENTORY_REACHED\n");
  }
  return readdir(path, ...args);
};
// The red arm must discover the poisoned directory without reaching launchd.
// A lost adapter may inspect this synthetic inventory, never the host service.
for (const method of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"]) {
  const original = childProcess[method];
  childProcess[method] = (command, ...args) => {
    const tool = basename(String(command));
    if (tool === "launchctl" && method === "spawnSync") {
      const action = args[0]?.[0];
      if (action === "list") return { status: 0, stdout: "PID Status Label\n" };
      if (action === "print-disabled") return { status: 0, stdout: "disabled services = {\n}\n" };
      if (action === "print") return { status: 113, stdout: "", stderr: "not loaded" };
    }
    if (/^(?:launchctl|security|wrangler|schtasks|powershell|pwsh)(?:\.exe)?$/u.test(tool) ||
        (["exec", "execSync"].includes(method) && /\b(?:launchctl|security|wrangler|schtasks)\b/u.test(String(command)))) {
      process.stderr.write("HOST_HELPER_REFUSED\n");
      throw new Error("host helper reached instead of a fixture adapter");
    }
    return original(command, ...args);
  };
}
syncBuiltinESMExports();
