/**
 * Scheduler tests must never reach the real launchctl or schtasks: a CI host
 * would otherwise answer with its own machine state, which is how a Windows
 * runner once printed "ERROR: The system cannot find the file specified."
 * into a check written for another platform.
 *
 * Importing this module replaces the child_process entry points for those two
 * programs with a scripted "no such task" answer and counts each attempt.
 * `syncBuiltinESMExports` makes the replacement visible to modules that
 * imported `spawnSync` by name. Used directly by in-process tests and through
 * `node --import` for a spawned public CLI.
 */
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";

const SCHEDULER_PROGRAMS = new Set(["launchctl", "schtasks", "schtasks.exe"]);
export const schedulerRunnerAttempts = [];

function schedulerProgram(command) {
  const name = basename(String(command || "").replaceAll("\\", "/")).toLowerCase();
  return SCHEDULER_PROGRAMS.has(name) ? name : null;
}

function absentAnswer(program, args) {
  schedulerRunnerAttempts.push({ program, args: Array.isArray(args) ? [...args] : [] });
  if (program === "launchctl") {
    return { status: 113, stdout: "", stderr: "Could not find service in domain for port", signal: null, pid: 0, output: [] };
  }
  // Task Scheduler absence is proven by an empty CSV task listing; every
  // other schtasks verb answers as if the named task does not exist.
  const list = Array.isArray(args) && args[0] === "/Query" && !args.includes("/TN");
  return list
    ? { status: 0, stdout: "", stderr: "", signal: null, pid: 0, output: [] }
    : { status: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified.", signal: null, pid: 0, output: [] };
}

const realSpawnSync = childProcess.spawnSync;
const realExecFileSync = childProcess.execFileSync;
const realSpawn = childProcess.spawn;
const realExecFile = childProcess.execFile;

childProcess.spawnSync = function guardedSpawnSync(command, args, ...rest) {
  const program = schedulerProgram(command);
  return program ? absentAnswer(program, args) : realSpawnSync.call(this, command, args, ...rest);
};
childProcess.execFileSync = function guardedExecFileSync(command, ...rest) {
  if (schedulerProgram(command)) throw new Error(`test refused a real ${schedulerProgram(command)} call`);
  return realExecFileSync.call(this, command, ...rest);
};
childProcess.spawn = function guardedSpawn(command, ...rest) {
  if (schedulerProgram(command)) throw new Error(`test refused a real ${schedulerProgram(command)} call`);
  return realSpawn.call(this, command, ...rest);
};
childProcess.execFile = function guardedExecFile(command, ...rest) {
  if (schedulerProgram(command)) throw new Error(`test refused a real ${schedulerProgram(command)} call`);
  return realExecFile.call(this, command, ...rest);
};
syncBuiltinESMExports();
