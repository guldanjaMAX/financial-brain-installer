import { join } from "node:path";

export function doctorDependencies() {
  const ready = process.env.BRAIN_TEST_DOCTOR === "ready";
  const stage = (name) => console.log(`TEST_DOCTOR_STAGE:${name}`);
  return {
    localRun(command, args) {
      stage("local");
      if (command.endsWith("powershell.exe")) return { ok: true, out: "BRAIN_STANDARD_USER" };
      if (!ready) return { ok: false, missing: true, out: "fixture unavailable" };
      return { ok: true, out: command === "npx" ? "wrangler 4.131.1" : args.includes("status") ? "signed in" : "fixture version" };
    },
    networkCheck: async () => {
      stage("network");
      return { name: "Network", status: "ok", detail: "fixture reachable" };
    },
    googleStorageCheck: () => {
      stage("google-storage");
      return { exists: ready, backend: "file", description: "fixture storage" };
    },
    googleStorageReadability: () => {
      stage("google-readable");
      return { checked: true, readable: true };
    },
    windowsCredentialCheck: () => {
      stage("windows-credentials");
      return { name: "Windows credential protection", status: "ok", detail: "fixture protection" };
    },
    // Exercise both platform paths without invoking either native backend.
    platformName: process.env.BRAIN_TEST_DOCTOR_PLATFORM || "darwin",
    environment: {
      HOME: process.env.HOME, PATH: "", BRAIN_NO_WRANGLER_LOGIN: "1",
      SystemRoot: "C:\\Windows", LOCALAPPDATA: "C:\\Fixture\\AppData\\Local",
    },
    cliPath: join(process.env.HOME, "fixture-cli.mjs"),
    statfsImpl: () => ({ bavail: 10_000_000n, bsize: 4096n }),
    getEffectiveUserId: () => 501,
  };
}
