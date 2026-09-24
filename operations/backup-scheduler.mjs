#!/usr/bin/env node
/** Daily owner-backup scheduling through the hardened macOS scheduler core. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSchedulerPlan,
  installScheduler,
  removeScheduler,
  runScheduledIngest,
  safeIngestEnvironment,
  statusScheduler,
} from "./drive-scheduler.mjs";

export const BACKUP_SCHEDULER_SPEC = Object.freeze({
  kind: "owner-backup",
  schedulerNoun: "owner backup scheduler",
  activityNoun: "owner backup",
  cronLabels: Object.freeze({ key: "operations.backup.cron", noun: "owner backup cron" }),
  cronOf: (manifest) => manifest?.operations?.backup?.cron || "0 3 * * *",
  cronMissingError: "operations.backup.cron must be a five-field cron expression",
  requireEnabled() {},
  requiresDomain: false,
  domainMissingError: "owner backup does not require a Brain domain",
  platformError: (platform) =>
    `unattended owner-backup scheduling is currently implemented with macOS LaunchAgents; this machine reports ${platform}`,
  defaultSchedulerPath: () => fileURLToPath(import.meta.url),
  referenceExtrasOf: (manifest) => ({ backupConfiguration: manifest?.operations?.backup || {} }),
  configHashPayloadOf: (reference) => ({
    version: 1,
    slug: reference.slug,
    manifest_path: reference.path,
    brain_path: reference.brainPath,
    backup_cron: reference.cron,
    backup: reference.backupConfiguration,
  }),
  childArgumentsOf: (plan) => ["backup", plan.path, "--scheduled"],
  childEnvironmentOf: (_plan, environment) => safeIngestEnvironment(environment),
  configChangedError:
    "the manifest's owner-backup configuration changed after this LaunchAgent was installed; reinstall the backup schedule",
  busyReason: "an owner backup is already running",
});

const optionsFor = (options = {}) => ({ ...options, spec: BACKUP_SCHEDULER_SPEC });
export const buildBackupSchedulerPlan = (manifestPath, options = {}) =>
  buildSchedulerPlan(manifestPath, optionsFor(options));
export const installBackupScheduler = (manifestPath, options = {}) =>
  installScheduler(manifestPath, optionsFor(options));
export const statusBackupScheduler = (manifestPath, options = {}) =>
  statusScheduler(manifestPath, optionsFor(options));
export const removeBackupScheduler = (manifestPath, options = {}) =>
  removeScheduler(manifestPath, optionsFor(options));
export const runScheduledBackup = (manifestPath, options = {}) =>
  runScheduledIngest(manifestPath, optionsFor(options));

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

async function main(argv = process.argv.slice(2)) {
  const [command, manifestPath] = argv;
  if (!["install", "status", "remove", "run"].includes(String(command || "")) || !manifestPath) {
    console.log("usage: node operations/backup-scheduler.mjs <install|status|remove|run> <manifest> [--brain <brain.mjs>]");
    return 1;
  }
  const options = {
    brainPath: optionValue(argv, "--brain") || undefined,
    expectedConfigHash: optionValue(argv, "--config-hash") || undefined,
  };
  const result = command === "run"
    ? runScheduledBackup(manifestPath, options)
    : command === "install"
      ? installBackupScheduler(manifestPath, options)
      : command === "remove"
        ? removeBackupScheduler(manifestPath, options)
        : statusBackupScheduler(manifestPath, options);
  console.log(JSON.stringify({
    status: result.status,
    installed: result.installed,
    loaded: result.loaded,
    cron: result.cron,
    definition_matches_manifest: result.definitionMatches,
  }));
  return result.code || 0;
}

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`owner backup scheduler stopped: ${String(error?.message || error)}`);
    process.exitCode = 1;
  });
}
