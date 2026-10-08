#!/usr/bin/env node
/**
 * Unattended macOS scheduling for OAuth provider connectors.
 *
 * This is a thin spec layer over the hardened Drive scheduler. It reuses the
 * same atomic plist replacement, private logs, single-run lock, config hash,
 * sparse child environment, and durable admin-key resolution.
 */

import { resolve } from "node:path";
import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { quickBooksAnnualWindow } from "./quickbooks-schedule.mjs";
import { fileURLToPath } from "node:url";
import { printGuidance } from "./cli-guidance.mjs";
import { recordSupportEvent } from "../support-journal.mjs";
import {
  buildSchedulerPlan,
  installScheduler,
  pauseScheduler,
  removeScheduler,
  restoreScheduler,
  runScheduledIngest,
  safeIngestEnvironment,
  statusScheduler,
  launchctlChildEnvironment,
} from "./drive-scheduler.mjs";
import { providerOAuthConfig } from "../connectors/provider-oauth.mjs";

export const SCHEDULED_PROVIDER_IDS = Object.freeze([
  "quickbooks", "slack", "notion", "microsoft", "dropbox", "hubspot",
]);

const TOKEN_STORES = new Set(["auto", "keychain", "file"]);
const DEFAULT_CRONS = Object.freeze({
  quickbooks: "0 2 * * *",
  slack: "15 2 * * *",
  notion: "30 2 * * *",
  microsoft: "0 * * * *",
  dropbox: "15 * * * *",
  hubspot: "45 2 * * *",
});
const sourceConfig = (manifest, provider) => manifest?.corpora?.[provider] || null;
const storeEnvironmentName = (provider) => `BRAIN_${provider.toUpperCase()}_TOKEN_STORE`;

export function createProviderSchedulerSpec(provider, options = {}) {
  const config = providerOAuthConfig(provider);
  const key = config.provider;
  if (!SCHEDULED_PROVIDER_IDS.includes(key)) throw new TypeError(`unsupported scheduled provider ${key}`);
  const tokenEnv = storeEnvironmentName(key);
  return Object.freeze({
    kind: `${key}-ingest`,
    schedulerNoun: `${config.label} scheduler`,
    activityNoun: `${config.label} ingest`,
    cronLabels: Object.freeze({
      key: `operations.provider_crons.${key}`,
      noun: `${config.label} ingest cron`,
    }),
    cronOf: (manifest) => {
      if (key === "quickbooks" && manifest.operations?.quickbooks_schedule?.enabled === true) {
        const start = manifest.operations.quickbooks_schedule.start ?? "07:00";
        if (start !== "07:00") throw new Error("macOS QuickBooks refresh starts at 07:00");
        const window = quickBooksAnnualWindow({ timezone: manifest.operations.quickbooks_schedule.timezone || manifest.client?.timezone || options.localTimeZone,
          now: options.now || new Date(), start });
        return `0 7,${window.last_even_hour} * * *`;
      }
      return manifest?.operations?.provider_crons?.[key] || DEFAULT_CRONS[key];
    },
    cronMissingError: `operations.provider_crons.${key} must be a five-field cron expression`,
    requireEnabled(manifest) {
      if (sourceConfig(manifest, key)?.enabled !== true) {
        throw new Error(`corpora.${key}.enabled must be true before its scheduler can be installed`);
      }
    },
    domainMissingError:
      `brain.domain is required for unattended ${config.label} ingest because the scheduled child receives no Cloudflare deployment token`,
    platformError: (platform) =>
      `unattended ${config.label} scheduling is currently implemented with macOS LaunchAgents; this machine reports ${platform}`,
    defaultSchedulerPath: () => fileURLToPath(import.meta.url),
    schedulerArgumentsOf: () => [key],
    referenceExtrasOf: (manifest) => ({
      provider: key,
      tokenStore: String(manifest?.operations?.provider_token_stores?.[key] || "auto").toLowerCase(),
      sourceConfiguration: sourceConfig(manifest, key),
    }),
    validateExtras(reference) {
      if (key === "quickbooks" && reference.manifest.operations?.quickbooks_schedule?.enabled === true &&
          (reference.manifest.operations.quickbooks_schedule.timezone || reference.timeZone || reference.localTimeZone) !== reference.localTimeZone) {
        throw new Error("QuickBooks schedule timezone must match this machine");
      }
      if (!TOKEN_STORES.has(reference.tokenStore)) {
        throw new Error(`operations.provider_token_stores.${key} must be auto, keychain or file`);
      }
    },
    configHashPayloadOf: (reference) => ({
      version: 1,
      provider: key,
      slug: reference.slug,
      manifest_path: reference.path,
      brain_path: reference.brainPath,
      domain: reference.manifest.brain.domain,
      ingest_cron: reference.cron,
      admin_key_secret: reference.manifest?.operations?.admin_key_secret || null,
      token_store: reference.tokenStore,
      source_configuration: reference.sourceConfiguration,
      ...(key === "quickbooks" && reference.manifest.operations?.quickbooks_schedule?.enabled === true
        ? { quickbooks_schedule: reference.manifest.operations.quickbooks_schedule } : {}),
    }),
    childArgumentsOf: (plan) => key === "quickbooks" && plan.manifest.operations?.quickbooks_schedule?.enabled === true
      ? ["quickbooks-run", plan.path, "--provider-config-hash", plan.configHash]
      : ["ingest", plan.path, "--from", key],
    childEnvironmentOf: (plan, environment) => {
      const child = safeIngestEnvironment(environment);
      if (plan.tokenStore === "auto") delete child[tokenEnv];
      else child[tokenEnv] = plan.tokenStore;
      return child;
    },
    configChangedError:
      `the manifest's scheduled ${config.label} configuration changed after this LaunchAgent was installed; reinstall the scheduler before it may read credentials`,
    busyReason: `${config.label} ingest is already running`,
  });
}

const optionsFor = (provider, options = {}) => ({ ...options, spec: createProviderSchedulerSpec(provider, options) });

const refreshExpectation = (provider, result) => provider === "quickbooks" && result.manifest?.operations?.quickbooks_schedule?.enabled === true
  ? { ...result, expectedRefreshSeconds: 86400 } : result;
export const buildProviderSchedulerPlan = (provider, manifestPath, options = {}) =>
  refreshExpectation(provider, buildSchedulerPlan(manifestPath, optionsFor(provider, options)));
export const installProviderScheduler = (provider, manifestPath, options = {}) => {
  const plan = buildProviderSchedulerPlan(provider, manifestPath, options);
  if (provider !== "quickbooks" || plan.manifest.operations?.quickbooks_schedule?.enabled !== true) {
    return installScheduler(manifestPath, optionsFor(provider, options));
  }
  const before = snapshotQuickBooksProviderScheduler(manifestPath, options);
  if (before.verified) return { ...before, changed: false };
  try {
    installScheduler(manifestPath, optionsFor(provider, options));
    const after = snapshotQuickBooksProviderScheduler(manifestPath, options);
    if (!after.verified) throw new Error("QuickBooks provider exact readback failed");
    return { ...after, changed: true };
  } catch (error) {
    restoreQuickBooksProviderSnapshot(manifestPath, before, options);
    throw error;
  }
};
export const statusProviderScheduler = (provider, manifestPath, options = {}) =>
  refreshExpectation(provider, statusScheduler(manifestPath, optionsFor(provider, options)));
export const removeProviderScheduler = (provider, manifestPath, options = {}) =>
  removeScheduler(manifestPath, optionsFor(provider, options));
export const pauseProviderScheduler = (provider, manifestPath, options = {}) =>
  pauseScheduler(manifestPath, optionsFor(provider, options));
export const restoreProviderScheduler = (provider, manifestPath, snapshot, options = {}) =>
  restoreScheduler(manifestPath, snapshot, optionsFor(provider, options));
export const runProviderScheduledIngest = (provider, manifestPath, options = {}) =>
  runScheduledIngest(manifestPath, optionsFor(provider, options));

function quickBooksLaunchctl(options) {
  return options.launchctl || (args => (options.spawn || spawnSync)("/bin/launchctl", args, {
    encoding: "utf8", env: launchctlChildEnvironment(options.environment || process.env), timeout: 15000,
  }));
}
function plistArguments(serialized) {
  const block = serialized.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u)?.[1] || "";
  return [...block.matchAll(/<string>([\s\S]*?)<\/string>/gu)].map(m => m[1].replaceAll("&quot;", '\"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&"));
}
function loadedArguments(output) {
  const block = String(output || "").match(/arguments\s*=\s*\{([\s\S]*?)^\s*\}/mu)?.[1];
  return block ? block.split(/\r?\n/u).map(s => s.trim().replace(/^\d+\s*=\s*/u, "")).filter(Boolean) : [];
}
export function snapshotQuickBooksProviderScheduler(manifestPath, options = {}) {
  let inspection;
  const launchctl = quickBooksLaunchctl(options);
  const status = statusProviderScheduler("quickbooks", manifestPath, { ...options, launchctl: args => {
    const result = launchctl(args); if (args[0] === "print") inspection = result; return result;
  } });
  if (inspection?.error || ![0, 113].includes(inspection?.status)) throw new Error("QuickBooks provider schedule inspection is unavailable");
  let serialized = null;
  if (status.installed) {
    const info = lstatSync(status.plistPath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("QuickBooks provider definition is unsafe");
    serialized = readFileSync(status.plistPath, "utf8");
    const args = plistArguments(serialized);
    // Preserve stale, owned definitions for rollback without adopting a job by
    // label alone. Every executable argument is bound to this installed runner.
    const expected = [status.nodePath, status.schedulerPath, "quickbooks", "run", status.path, "--brain", status.brainPath, "--config-hash"];
    if (args.length !== expected.length + 1 || expected.some((value, index) => args[index] !== value) ||
        !/^[a-f0-9]{64}$/u.test(args.at(-1))) throw new Error("A foreign provider definition occupies the QuickBooks schedule");
  } else if (status.loaded) throw new Error("QuickBooks is loaded without an owned definition");
  const loaded = loadedArguments(inspection?.stdout);
  const expected = serialized ? plistArguments(serialized) : [];
  const loadedMatches = loaded.length === expected.length && loaded.every((value, index) => value === expected[index]);
  return { ...status, serialized, enabled: status.loaded, verified: status.installed && status.loaded && status.definitionMatches &&
    status.interpreterPresent && !status.scheduleError && loadedMatches };
}
export function restoreQuickBooksProviderSnapshot(manifestPath, snapshot, options = {}) {
  const current = snapshotQuickBooksProviderScheduler(manifestPath, options);
  const launchctl = quickBooksLaunchctl(options);
  if (current.loaded && launchctl(["bootout", current.service])?.status !== 0) throw new Error("QuickBooks provider rollback could not stop the replacement");
  if (snapshot?.installed) {
    const staged = `${current.plistPath}.${randomBytes(8).toString("hex")}.rollback`;
    writeFileSync(staged, snapshot.serialized, { mode: 0o600, flag: "wx" });
    renameSync(staged, current.plistPath);
    if (snapshot.loaded && (launchctl(["enable", current.service])?.status !== 0 ||
        launchctl(["bootstrap", current.domain, current.plistPath])?.status !== 0)) throw new Error("QuickBooks provider rollback could not reload the previous definition");
  } else if (existsSync(current.plistPath)) unlinkSync(current.plistPath);
  const result = launchctl(["print", current.service]);
  if ((snapshot?.loaded ? result?.status !== 0 || JSON.stringify(loadedArguments(result.stdout)) !== JSON.stringify(plistArguments(snapshot.serialized)) : result?.status !== 113) ||
      (snapshot?.installed ? readFileSync(current.plistPath, "utf8") !== snapshot.serialized : existsSync(current.plistPath))) {
    throw new Error("QuickBooks provider rollback did not pass exact readback");
  }
  return { restored: true, verified: true };
}

export function removeQuickBooksProviderScheduler(manifestPath, options = {}) {
  const before = snapshotQuickBooksProviderScheduler(manifestPath, options);
  const launchctl = quickBooksLaunchctl(options);
  try {
    // Keep the owned plist available for rollback until native readback proves
    // the job stopped. A successful bootout exit alone is insufficient.
    if (before.loaded && (launchctl(['bootout', before.service])?.status !== 0 ||
        launchctl(['print', before.service])?.status !== 113)) {
      throw new Error('QuickBooks provider removal did not stop the loaded job');
    }
    const result = removeScheduler(manifestPath, optionsFor('quickbooks', { ...options, launchctl }));
    const after = snapshotQuickBooksProviderScheduler(manifestPath, { ...options, launchctl });
    if (after.installed || after.loaded) throw new Error('QuickBooks provider removal did not pass exact readback');
    return { ...result, verified: true };
  } catch (error) {
    restoreQuickBooksProviderSnapshot(manifestPath, before, options);
    throw error;
  }
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

const UNCERTAIN_PROVIDER_CODES = new Set([
  "OAUTH_RESPONSE_UNCERTAIN",
  "REFRESH_OUTCOME_UNKNOWN",
  "PLAID_EXCHANGE_OUTCOME_UNKNOWN",
  "PLAID_REMOVE_OUTCOME_UNKNOWN",
  "SAFETY_REVIEW_REQUIRED",
]);

function providerSchedulerErrorCode(error, action) {
  const values = [error, error?.payload].filter((value) => value && typeof value === "object");
  const typedCodes = [error?.code, error?.payload?.error_code, error?.payload?.issue_code]
    .filter((value) => typeof value === "string")
    .map((value) => value.trim().toUpperCase());
  if (values.some((value) =>
    value.uncertain === true || value.outcome_unknown === true || value.retry_safe === false
  ) || typedCodes.some((code) => UNCERTAIN_PROVIDER_CODES.has(code))) {
    return "SAFETY_REVIEW_REQUIRED";
  }
  return action === "install" ? "SCHEDULE_INSTALL_FAILED" : "SCHEDULE_RUN_FAILED";
}

export function recordProviderSchedulerFailure(provider, action, error, options = {}) {
  const errorCode = providerSchedulerErrorCode(error, action);
  try {
    const event = recordSupportEvent({
      command: "schedule",
      source: provider,
      errorCode,
      productRelativeLocation: "operations/provider-scheduler.mjs#main",
    }, options.journalOptions || {});
    return { eventId: event.event_id, errorCode };
  } catch {
    return { eventId: null, errorCode };
  }
}

async function main(argv = process.argv.slice(2)) {
  const [provider, command, manifestPath] = argv;
  if (!SCHEDULED_PROVIDER_IDS.includes(String(provider || "")) ||
      !["install", "status", "remove", "run"].includes(String(command || "")) || !manifestPath) {
    console.log(
      "usage: node operations/provider-scheduler.mjs <quickbooks|slack|notion|microsoft|dropbox|hubspot> " +
      "<install|status|remove|run> <manifest> [--brain <brain.mjs>]",
    );
    return 1;
  }
  const options = {
    brainPath: optionValue(argv, "--brain") || undefined,
    expectedConfigHash: optionValue(argv, "--config-hash") || undefined,
  };
  if (command === "run") {
    const result = runProviderScheduledIngest(provider, manifestPath, options);
    console.log(`[${new Date().toISOString()}] ${result.reason || `${provider} ingest ${result.status}`}`);
    return result.code;
  }
  const result = command === "install"
    ? installProviderScheduler(provider, manifestPath, options)
    : command === "status"
      ? statusProviderScheduler(provider, manifestPath, options)
      : removeProviderScheduler(provider, manifestPath, options);
  console.log(JSON.stringify({
    provider,
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
    const provider = String(process.argv[2] || "provider");
    const receipt = recordProviderSchedulerFailure(provider, process.argv[3], error);
    console.error(`${provider} scheduler stopped before it could confirm a complete result.`);
    if (receipt.errorCode === "SAFETY_REVIEW_REQUIRED") {
      console.error("The provider result may be uncertain. Please check its current state before retrying this action.");
    } else {
      console.error("The previous schedule and source cursor remain available for review.");
    }
    console.error(`Issue code: ${receipt.errorCode}`);
    printGuidance(`What to try next: brain support --explain ${receipt.errorCode}`);
    if (receipt.eventId) {
      console.error(`Private issue note ${receipt.eventId} was saved locally. The installer did not upload or send it.`);
    }
    process.exitCode = 1;
  });
}
