import fs from "node:fs";
import child from "node:child_process";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks, syncBuiltinESMExports } from "node:module";

// Keep subprocess probes offline even if a future dispatch change reaches a
// credential or scheduler path. Only another Node process is permitted here.
const lifecycle = new URL("../../operations/brain-lifecycle-lock.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === lifecycle && specifier === "./current-user-file.mjs") {
      return { url: new URL("./lifecycle-lock-acl.mjs", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const originalSpawn = child.spawnSync;
child.spawnSync = function (file, ...args) {
  if (file !== process.execPath) throw new Error("unexpected host command in folder fixture");
  return originalSpawn.call(this, file, ...args);
};
globalThis.fetch = async () => { throw new Error("unexpected network in folder fixture"); };

if (process.env.FOLDER_INTERLEAVE_DONE !== "1" && process.env.FOLDER_CASE_ROOT) {
  const root = process.env.FOLDER_CASE_ROOT;
  const record = (value) => fs.appendFileSync(join(root, "ingest-boundary.txt"), `${value}\n`);
  const originalMkdir = fs.mkdirSync;
  const originalReadDir = fs.readdirSync;
  let reached = false;
  fs.mkdirSync = function (path, ...args) {
    if (!reached && /^source-ingest-[a-f0-9]{32}\.lock$/u.test(basename(String(path)))) {
      reached = true;
      record("source-lock-decision");
      if (process.env.FOLDER_INGEST_RACE === "1") {
        const env = Object.fromEntries([
          "PATH", "SystemRoot", "WINDIR", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP",
          "BRAIN_NO_WRANGLER_LOGIN", "BRAIN_LIFECYCLE_LOCK_ROOT", "BRAIN_TEST_USER_ROOT",
        ].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
        const peer = child.spawnSync(process.execPath, [
          "--import", import.meta.url,
          fileURLToPath(new URL("../../brain.mjs", import.meta.url)),
          "folder", join(root, "owner's settings.json"), "remove", "--source", "first",
        ], { env: { ...env, FOLDER_INTERLEAVE_DONE: "1" }, encoding: "utf8", timeout: 10_000 });
        if (peer.status === 0) record("remove-success");
        else if (peer.status === 1 && /running|busy|manifest changed/iu.test(`${peer.stdout}${peer.stderr}`)) record("remove-refused");
        else throw new Error("the peer failed outside the concurrency decision");
      }
    }
    return originalMkdir.call(this, path, ...args);
  };
  fs.readdirSync = function (path, ...args) {
    if (String(path) === join(root, "first")) record("feed-walk");
    return originalReadDir.call(this, path, ...args);
  };
}
syncBuiltinESMExports();
