#!/usr/bin/env node
/** Packaged unattended schedules for the Gmail, Calendar, and IMAP sources. */

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

export const SCHEDULED_SOURCE_IDS = Object.freeze(["gmail", "calendar", "imap"]);

const TOKEN_STORES = new Set(["auto", "keychain", "file"]);
const DEFAULT_CRONS = Object.freeze({
  gmail: "5 * * * *",
  calendar: "10 * * * *",
  imap: "20 * * * *",
});
const SOURCE_LABELS = Object.freeze({
  gmail: "Gmail",
  calendar: "Calendar",
  imap: "IMAP",
});

function sourceConfiguration(manifest, source) {
  return manifest?.corpora?.[source] || null;
}

function storeConfiguration(manifest, source) {
  return String(source === "imap"
    ? manifest?.operations?.imap_credential_store || "auto"
    : manifest?.operations?.google_token_store || "auto").toLowerCase();
}

export function createSourceSchedulerSpec(source) {
  const key = String(source || "").toLowerCase();
  if (!SCHEDULED_SOURCE_IDS.includes(key)) throw new TypeError(`unsupported scheduled source ${key}`);
  const label = SOURCE_LABELS[key];
  const storeEnvironment = key === "imap" ? "BRAIN_IMAP_CREDENTIAL_STORE" : "BRAIN_GOOGLE_TOKEN_STORE";
  return Object.freeze({
    kind: `${key}-ingest`,
    schedulerNoun: `${label} scheduler`,
    activityNoun: `${label} ingest`,
    cronLabels: Object.freeze({
      key: `operations.source_crons.${key}`,
      noun: `${label} ingest cron`,
    }),
    cronOf: (manifest) => manifest?.operations?.source_crons?.[key] || DEFAULT_CRONS[key],
    cronMissingError: `operations.source_crons.${key} must be a five-field cron expression`,
    requireEnabled(manifest) {
      if (sourceConfiguration(manifest, key)?.enabled !== true) {
        throw new Error(`corpora.${key}.enabled must be true before its scheduler can be installed`);
      }
    },
    domainMissingError:
      `brain.domain is required for unattended ${label} ingest because the scheduled child receives no Cloudflare deployment token`,
    platformError: (platform) =>
      `unattended ${label} scheduling is currently implemented with macOS LaunchAgents; this machine reports ${platform}`,
    defaultSchedulerPath: () => fileURLToPath(import.meta.url),
    schedulerArgumentsOf: () => [key],
    referenceExtrasOf: (manifest) => ({
      sourceId: key,
      sourceName: String(sourceConfiguration(manifest, key)?.source || key),
      credentialStore: storeConfiguration(manifest, key),
      sourceConfiguration: sourceConfiguration(manifest, key),
    }),
    validateExtras(reference) {
      if (!TOKEN_STORES.has(reference.credentialStore)) {
        const field = key === "imap" ? "operations.imap_credential_store" : "operations.google_token_store";
        throw new Error(`${field} must be auto, keychain or file`);
      }
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(reference.sourceName)) {
        throw new Error(`corpora.${key}.source must be a valid source name`);
      }
    },
    configHashPayloadOf: (reference) => ({
      version: 1,
      source: key,
      source_name: reference.sourceName,
      slug: reference.slug,
      manifest_path: reference.path,
      brain_path: reference.brainPath,
      domain: reference.manifest.brain.domain,
      ingest_cron: reference.cron,
      admin_key_secret: reference.manifest?.operations?.admin_key_secret || null,
      credential_store: reference.credentialStore,
      source_configuration: reference.sourceConfiguration,
    }),
    childArgumentsOf: (plan) => [
      "ingest", plan.path, "--from", key, "--source", plan.sourceName, "--scheduled-run",
    ],
    childEnvironmentOf: (plan, environment) => {
      const child = safeIngestEnvironment(environment);
      if (plan.credentialStore === "auto") delete child[storeEnvironment];
      else child[storeEnvironment] = plan.credentialStore;
      return child;
    },
    configChangedError:
      `the manifest's scheduled ${label} configuration changed after this schedule was installed; reinstall it before it may read credentials`,
    busyReason: `${label} ingest is already running`,
  });
}

const optionsFor = (source, options = {}) => ({ ...options, spec: createSourceSchedulerSpec(source) });

export const buildSourceSchedulerPlan = (source, manifestPath, options = {}) =>
  buildSchedulerPlan(manifestPath, optionsFor(source, options));
export const installSourceScheduler = (source, manifestPath, options = {}) =>
  installScheduler(manifestPath, optionsFor(source, options));
export const statusSourceScheduler = (source, manifestPath, options = {}) =>
  statusScheduler(manifestPath, optionsFor(source, options));
export const removeSourceScheduler = (source, manifestPath, options = {}) =>
  removeScheduler(manifestPath, optionsFor(source, options));
export const runSourceScheduledIngest = (source, manifestPath, options = {}) =>
  runScheduledIngest(manifestPath, optionsFor(source, options));

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

async function main(argv = process.argv.slice(2)) {
  const [source, command, manifestPath] = argv;
  if (!SCHEDULED_SOURCE_IDS.includes(String(source || "")) ||
      !["install", "status", "remove", "run"].includes(String(command || "")) || !manifestPath) {
    console.log(
      "usage: node operations/source-scheduler.mjs <gmail|calendar|imap> " +
      "<install|status|remove|run> <manifest> [--brain <brain.mjs>]",
    );
    return 1;
  }
  const options = {
    brainPath: optionValue(argv, "--brain") || undefined,
    expectedConfigHash: optionValue(argv, "--config-hash") || undefined,
  };
  if (command === "run") {
    const result = runSourceScheduledIngest(source, manifestPath, options);
    console.log(`[${new Date().toISOString()}] ${result.reason || `${source} ingest ${result.status}`}`);
    return result.code;
  }
  const result = command === "install"
    ? installSourceScheduler(source, manifestPath, options)
    : command === "status"
      ? statusSourceScheduler(source, manifestPath, options)
      : removeSourceScheduler(source, manifestPath, options);
  console.log(JSON.stringify({
    source,
    label: result.label,
    installed: result.installed,
    loaded: result.loaded,
    running: result.running,
    cron: result.cron,
    expected_refresh_seconds: result.expectedRefreshSeconds,
    definition_matches_manifest: result.definitionMatches,
    plist: result.plistPath,
    stdout_log: result.stdoutPath,
    stderr_log: result.stderrPath,
  }, null, 2));
  for (const warning of result.warnings || []) console.log(`warning: ${warning}`);
  return 0;
}

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`source scheduler failed: ${error.message}`);
    process.exitCode = 1;
  });
}
