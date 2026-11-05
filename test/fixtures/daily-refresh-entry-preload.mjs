import { register, syncBuiltinESMExports } from "node:module";
import { isMainThread } from "node:worker_threads";
import child from "node:child_process";

// The real entry point runs with synthetic plan and scheduler dependencies.
// Native scheduling, credentials and network access remain forbidden.
if (isMainThread) {
  if (process.env.DAILY_ENTRY_PLATFORM) {
    Object.defineProperty(process, "platform", { value: process.env.DAILY_ENTRY_PLATFORM });
  }
  const NativeDate = Date;
  const fixed = NativeDate.parse("2026-11-02T18:05:06.789Z");
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed; }
  };
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]) {
    child[name] = () => { throw new Error("unexpected host command in daily fixture"); };
  }
  child.spawnSync = (file, args) => {
    if (/[\\/]whoami\.exe$/iu.test(String(file)) && JSON.stringify(args) === JSON.stringify(["/user", "/fo", "csv", "/nh"])) {
      return { status: 0, stdout: '"fixture-user","S-1-5-21-1000"' };
    }
    throw new Error("unexpected host command in daily fixture");
  };
  globalThis.fetch = async () => { throw new Error("unexpected network in daily fixture"); };
  syncBuiltinESMExports();
  register(import.meta.url);
}

export async function load(url, context, nextLoad) {
  if (url === new URL("../../operations/current-user-file.mjs", import.meta.url).href) {
    return { format: "module", shortCircuit: true, source: `
      import assert from 'node:assert/strict';
      import { realpathSync } from 'node:fs';
      import { dirname, isAbsolute, relative, sep } from 'node:path';
      import { restrictWindowsFileToCurrentUser as file, restrictWindowsDirectoryToCurrentUser as directory } from ${JSON.stringify(`${url}?fixture-real`)};
      export * from ${JSON.stringify(`${url}?fixture-real`)};
      function settings(path, options) {
        const root = realpathSync(dirname(process.env.DAILY_ENTRY_FIXTURE));
        const suffix = relative(root, realpathSync(path));
        assert.ok(suffix && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep));
        return { ...options, username: 'fixture-user', environment: { SystemRoot: 'C:/Windows' },
          runAcl(_file, args) { assert.equal(args[0], path); return { status: 0 }; } };
      }
      export function restrictWindowsFileToCurrentUser(path, options) { return file(path, settings(path, options)); }
      export function restrictWindowsDirectoryToCurrentUser(path, options) { return directory(path, settings(path, options)); }
    ` };
  }
  if (url === new URL("../../brain.mjs", import.meta.url).href) {
    return { format: "module", shortCircuit: true, source: `
      import { readFileSync, appendFileSync } from 'node:fs';
      const fixture = JSON.parse(readFileSync(process.env.DAILY_ENTRY_FIXTURE, 'utf8'));
      export async function buildConfiguredDailyPlan() { return fixture.plan; }
      let reads = 0;
      export async function readSourceFreshness() {
        return { sources: [{ name: 'second', receipt: { last_successful_run_at: ++reads === 1 ? '2026-11-01T18:05:06.789Z' : '2026-11-02T18:05:06.789Z' } }] };
      }
      export async function cmdLoad() {
        appendFileSync(fixture.events, 'source-run\\n');
        return { status: 'complete' };
      }
    ` };
  }
  if (url === new URL("../../operations/daily-refresh-scheduler.mjs", import.meta.url).href) {
    return { format: "module", shortCircuit: true, source: `
      import { readFileSync, appendFileSync } from 'node:fs';
      export { buildDailyRefreshDefinition } from ${JSON.stringify(`${url}?fixture-real`)};
      const fixture = JSON.parse(readFileSync(process.env.DAILY_ENTRY_FIXTURE, 'utf8'));
      export function readDailyRefreshUpdateTransaction() { return null; }
      export function statusDailyRefreshSchedule() {
        appendFileSync(fixture.events, 'schedule-read\\n');
        if (fixture.mode === 'generic') throw new Error(fixture.privateError);
        return { installed: true, enabled: true, state: { definition: fixture.registered },
          plan_matches_registered_definition: fixture.mode === 'current' };
      }
    ` };
  }
  return nextLoad(url, context);
}
