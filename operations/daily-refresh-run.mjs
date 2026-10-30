/** Sequential execution and per-source proof for the daily machine-pull plan. */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { dailyRefreshIdentity, dailyRefreshPrincipal } from "./daily-refresh-plan.mjs";
import { appendDailySourceFailure, observeDailyRun } from "./daily-refresh-observation.mjs";
import { acquireBrainLifecycleLock } from "./brain-lifecycle-lock.mjs";
import { DriveRemovalReviewRequired } from "./drive-removal-plan.mjs";
import { SUPPORT_ERROR_CODES } from "../support-journal.mjs";
import {
  mergeProviderWithheldReasons,
  normalizeProviderWithheldReasons,
  providerNoChangeCheckAt,
  providerWithheldCheckAt,
} from "../worker/src/lib/source-receipt.js";
import { redactAll, sanitizeSensitiveLinks, scan } from "../worker/src/lib/secret-scan.js";
import {
  buildDailyRefreshDefinition,
  readDailyRefreshUpdateTransaction,
  statusDailyRefreshSchedule,
} from "./daily-refresh-scheduler.mjs";

const DAILY_LOCK_RETRY_INTERVAL_MS = 2_000;
const DAILY_LOCK_WAIT_LIMIT_MS = 55_000;

function lockClockMilliseconds(lockNow) {
  const value = lockNow();
  const milliseconds = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(milliseconds)) throw new TypeError("the daily lifecycle-lock clock is invalid");
  return milliseconds;
}

function elapsedLockWaitMilliseconds(startedAt, scheduledWaitMs, lockNow) {
  return Math.max(scheduledWaitMs, Math.ceil(lockClockMilliseconds(lockNow) - startedAt), 0);
}

function timestamp(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError("the daily refresh clock is invalid");
  return value.toISOString();
}

function validTimestamp(value) {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function dailyIssueCode(error) {
  if (error instanceof DriveRemovalReviewRequired) return "SAFETY_REVIEW_REQUIRED";
  const declaredCode = typeof error?.supportCode === "string" ? error.supportCode : error?.code;
  const typedCode = typeof declaredCode === "string" ? declaredCode.trim().toUpperCase() : "";
  if (SUPPORT_ERROR_CODES.includes(typedCode)) return typedCode;
  const message = String(error?.message || "");
  if (error?.credentialSource !== "wrangler-session" &&
      /\b9109\b/u.test(message) && /(?:invalid access token|failed \((?:401|403)\))/iu.test(message)) {
    return "CLOUDFLARE_TOKEN_NOT_ACTIVE";
  }
  if (/PDF.*tim(?:e|ed) out/iu.test(message)) return "PDF_PROCESS_TIMEOUT";
  if (/PDF.*process/iu.test(message)) return "PDF_PROCESS_FAILED";
  if (/timed out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND/iu.test(`${declaredCode} ${message}`)) return "NETWORK_UNREACHABLE";
  if (/rate.?limit|\b429\b/iu.test(message)) return "RATE_LIMITED";
  if (/\b401\b|expired.*(?:auth|token)|reauthori[sz]/iu.test(message)) return "AUTH_EXPIRED";
  if (/\b403\b|forbidden|permission denied|not permitted/iu.test(message)) return "REMOTE_PERMISSION_DENIED";
  if (/admin key|credential.*(?:missing|required)|token is not set|sign.?in|required.*auth|Keychain.*(?:missing|empty)/iu.test(message)) {
    return "AUTH_REQUIRED";
  }
  if (/not found|\b404\b/iu.test(message)) return "REMOTE_NOT_FOUND";
  if (/extract/iu.test(message)) return "EXTRACTION_FAILED";
  if (/needs --|no such folder|could not read manifest|usage:|must be one of|invalid|does not match/iu.test(message)) {
    return "CONFIG_INVALID";
  }
  return "UNKNOWN";
}

const FIXED_SENSITIVE_DIAGNOSTIC = "the source refresh failed; sensitive diagnostic text was redacted";

function redactAndScanDiagnostic(value) {
  // Every transform comes back through both layers. A later canonicalization
  // must not create a scanner-visible credential after the earlier pass ran.
  const sanitized = sanitizeSensitiveLinks(String(value));
  const redacted = redactAll(sanitized);
  return scan(redacted).shouldFlag ? null : redacted;
}

function transformDiagnostic(value, transform) {
  return redactAndScanDiagnostic(transform(value));
}

function safeDiagnosticText(value, maxLength = 200) {
  let detail = redactAndScanDiagnostic(String(value || "the source refresh failed"));
  const failClosed = () => FIXED_SENSITIVE_DIAGNOSTIC.slice(0, maxLength);
  if (detail === null) return failClosed();

  // Format and bidi controls can split one credential into scanner-clean
  // fragments. Remove them before any text is eligible for persistence.
  detail = transformDiagnostic(detail, (text) => text.replace(
    /[\p{Cf}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
    "",
  ));
  if (detail === null) return failClosed();

  const beforeLineJoin = detail;
  detail = transformDiagnostic(detail, (text) => text.replace(
    /(?<=[A-Za-z0-9_+./=\-])[ \t]*[\r\n\u2028\u2029]+[ \t]*(?=[A-Za-z0-9_+./=\-])/gu,
    "",
  ));
  if (detail === null) return failClosed();

  // Also scan the aggressive join view. It is deliberately not persisted
  // because joining ordinary prose damages the diagnostic; a credential found
  // only in that view is ambiguous, so the fixed text is safer than attempting
  // to map its span back across line boundaries.
  const joinedView = beforeLineJoin.replace(/[\r\n\u2028\u2029]+[ \t]*/gu, "");
  const joinedSanitized = sanitizeSensitiveLinks(joinedView);
  const joinedRedacted = redactAll(joinedSanitized);
  if (joinedRedacted !== joinedSanitized || scan(joinedRedacted).shouldFlag) return failClosed();

  // Diagnostic paths have no schema of their own. Bound unquoted values by a
  // line or punctuation delimiter, never by whitespace, so a path containing
  // spaces cannot leave its tail behind in the journal.
  for (const [pattern, replacement] of [
    [/file:\/\/\/[^,;\r\n)\]}'"`]*/giu, "[REDACTED:path]"],
    [/(^|[\s("'`])(?:[A-Za-z]:\\|\\\\)[^,;\r\n)\]}'"`]*/gu, "$1[REDACTED:path]"],
    [/(^|[\s("'`])\/(?!\/)[^,;\r\n)\]}'"`]*/gu, "$1[REDACTED:path]"],
  ]) {
    detail = transformDiagnostic(detail, (text) => text.replace(pattern, replacement));
    if (detail === null) return failClosed();
  }

  for (const transform of [
    (text) => text.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}\b/gu, "[REDACTED:private_value]"),
    (text) => text.replace(/[\u0000-\u001f\u007f]+/gu, " "),
    (text) => text.replace(/\s+/gu, " "),
    (text) => text.trim(),
  ]) {
    detail = transformDiagnostic(detail, transform);
    if (detail === null) return failClosed();
  }
  if (!detail) detail = "the source refresh failed";
  detail = transformDiagnostic(detail, (text) => text.slice(0, maxLength));
  return detail === null || !detail ? failClosed() : detail;
}

function safeRemovalReview(error, source) {
  const review = error?.removal_review;
  const count = (key) => Number.isSafeInteger(review?.[key]) && review[key] >= 0 ? review[key] : null;
  const stored = count("stored_documents_to_remove");
  const sourceRemovals = count("source_removals");
  const replacementReviews = count("replacement_family_reviews");
  const percentage = Number.isFinite(review?.source_cleanup_percentage) &&
    review.source_cleanup_percentage >= 0 && review.source_cleanup_percentage <= 100
    ? review.source_cleanup_percentage : null;
  const fingerprint = /^[a-f0-9]{64}$/u.test(String(review?.fingerprint || "")) ? review.fingerprint : null;
  if ([stored, sourceRemovals, replacementReviews, percentage].some((value) => value === null) || !fingerprint) {
    return {
      reason: "a removal review is waiting. Nothing was removed.",
      attention: `${source}: a removal review is waiting. Nothing was removed.`,
    };
  }
  return {
    reason: `a removal review is waiting: ${stored} stored documents would be removed across ` +
      `${sourceRemovals} source removals and ${replacementReviews} replacement family reviews; ` +
      `source cleanup is ${percentage.toFixed(1)}% of stored documents; plan fingerprint ${fingerprint}. Nothing was removed.`,
    attention: `${source}: a removal review is waiting (${stored} stored parts, ${sourceRemovals} source removals). Nothing was removed.`,
  };
}

function sourceFreshness(inventory, source) {
  const names = source.source_names?.length ? source.source_names : [source.key];
  return Object.fromEntries(names.map((name) => [name, validTimestamp(inventory?.[name]?.last_successful_run_at)]));
}

function compareFreshness(before, after) {
  const missing = [];
  const notAdvanced = [];
  for (const name of Object.keys(after)) {
    if (!after[name]) missing.push(name);
    else if (before[name] && Date.parse(after[name]) <= Date.parse(before[name])) notAdvanced.push(name);
  }
  return Object.freeze({
    advanced: missing.length === 0 && notAdvanced.length === 0,
    missing: Object.freeze(missing),
    notAdvanced: Object.freeze(notAdvanced),
  });
}

function dailyWithheldAggregate(latestRuns, withheldBySource) {
  const reasonMaps = [];
  let declaredCount = 0;
  for (let index = 0; index < latestRuns.length; index++) {
    const run = latestRuns[index];
    const count = run?.docs_withheld;
    if (count === undefined || count === null) continue;
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(declaredCount + count)) return null;
    declaredCount += count;
    if (count === 0) {
      if (run?.withheld_reasons !== undefined && run?.withheld_reasons !== null) return null;
      continue;
    }
    if (!withheldBySource[index]) return null;
    reasonMaps.push(run.withheld_reasons);
  }
  if (declaredCount === 0) return { count: 0, reasons: null };
  const aggregate = mergeProviderWithheldReasons(reasonMaps);
  return aggregate?.count === declaredCount ? aggregate : null;
}

function providerWithheldOwnerCopy(source) {
  const aggregate = normalizeProviderWithheldReasons(source?.withheld_reasons);
  if (!aggregate || aggregate.count !== source?.docs_withheld) return null;
  const causes = [];
  const calendar = aggregate.reasons.calendar_event_incomplete;
  const credentials = aggregate.reasons.credential_detected;
  if (calendar) causes.push(`calendar_event_incomplete: ${calendar} incomplete calendar item(s) queued for retry`);
  if (credentials) causes.push(`credential_detected: ${credentials} item(s) held by the credential safety check for review`);
  return `${aggregate.count} item(s) withheld by design: ${causes.join("; ")}`;
}

export async function runDailyRefresh({
  plan,
  acquireLock = (options) => acquireBrainLifecycleLock(options),
  runSource,
  readFreshness,
  writeReceipt = () => {},
  now = () => new Date(),
  lockNow = () => performance.now(),
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  home = homedir(),
  platform = process.platform,
  recoveryRequired = () => false,
  scheduleAttention = [],
  writeFailureLog = () => {},
} = {}) {
  if (!plan?.ready || !plan?.enabled) throw new Error("the daily refresh plan is not enabled and ready");
  if (typeof runSource !== "function" || typeof readFreshness !== "function" || typeof writeReceipt !== "function") {
    throw new TypeError("daily refresh needs source, freshness, and receipt dependencies");
  }
  if (typeof lockNow !== "function" || typeof sleep !== "function") {
    throw new TypeError("daily refresh needs lifecycle-lock clock and sleep dependencies");
  }
  const startedAt = timestamp(now);
  const runtimeMinutes = Number.isInteger(plan.max_runtime_minutes) && plan.max_runtime_minutes > 0
    ? plan.max_runtime_minutes
    : 45;
  const deadlineAt = Date.parse(startedAt) + runtimeMinutes * 60_000;
  let lock;
  let lockError = null;
  let lockWaitMs = 0;
  let scheduledWaitMs = 0;
  const lockWaitStartedAt = lockClockMilliseconds(lockNow);
  for (;;) {
    try {
      lock = acquireLock({ manifestPath: plan.manifest_path, operation: "daily-refresh", home, platform });
      break;
    } catch (error) {
      if (platform !== "darwin" || error?.code !== "brain_lifecycle_busy") {
        lockError = error;
        break;
      }
      // The existing acquire path rechecks owner liveness and stale reclaim on
      // every attempt. This runner only adds a macOS pre-source wait boundary.
      lockWaitMs = elapsedLockWaitMilliseconds(lockWaitStartedAt, scheduledWaitMs, lockNow);
      const remainingMs = DAILY_LOCK_WAIT_LIMIT_MS - lockWaitMs;
      if (remainingMs <= 0) {
        lockError = error;
        break;
      }
      const sleepMs = Math.min(DAILY_LOCK_RETRY_INTERVAL_MS, remainingMs);
      await sleep(sleepMs);
      scheduledWaitMs += sleepMs;
      lockWaitMs = elapsedLockWaitMilliseconds(lockWaitStartedAt, scheduledWaitMs, lockNow);
    }
  }
  if (lockError) {
    const error = lockError;
    if (!new Set(["brain_lifecycle_busy", "brain_lifecycle_recovery_required"]).has(error?.code)) throw error;
    const receipt = Object.freeze({
      schema_version: 1,
      kind: "daily_refresh",
      identity: plan.identity.id,
      status: "deferred",
      started_at: startedAt,
      completed_at: timestamp(now),
      lock_wait_ms: lockWaitMs,
      reason_code: error?.code === "brain_lifecycle_recovery_required" ? "update_recovery_required" : "brain_lifecycle_busy",
      reason: error?.code === "brain_lifecycle_recovery_required"
        ? "a prior update still requires verified schedule recovery"
        : "another Brain lifecycle operation owns the manifest lock",
      schedule_attention: Object.freeze([...scheduleAttention]),
      sources: [],
    });
    await writeReceipt(receipt);
    return receipt;
  }

  const sourceResults = [];
  const attentionEntries = [...scheduleAttention];
  try {
    lock.assertOwned();
    if (await recoveryRequired()) {
      const receipt = Object.freeze({
        schema_version: 1,
        kind: "daily_refresh",
        identity: plan.identity.id,
        status: "deferred",
        started_at: startedAt,
        completed_at: timestamp(now),
        lock_wait_ms: lockWaitMs,
        reason_code: "update_recovery_required",
        reason: "a prior update still requires verified schedule recovery",
        schedule_attention: Object.freeze([...attentionEntries]),
        sources: [],
      });
      await writeReceipt(receipt);
      return receipt;
    }
    // Inventory is evidence about a run, not permission to start an approved
    // ingest leg. Keep outages separate from source/removal refusals.
    const observeFreshness = async (source) => {
      try { return { inventory: await readFreshness(source), unavailable: false }; }
      catch { return { inventory: null, unavailable: true }; }
    };
    const baselineObservation = await observeFreshness();
    const baseline = baselineObservation.inventory;
    for (const source of plan.sources.filter((entry) => entry.class === "held")) {
      const receipt = Object.freeze({
        schema_version: 1,
        kind: "daily_refresh_source",
        identity: plan.identity.id,
        source: source.source_names?.[0] || source.key,
        status: "held",
        started_at: startedAt,
        completed_at: timestamp(now),
        freshness_advanced: false,
        reason_code: "source_held",
        reason: source.hold_reason,
      });
      sourceResults.push(receipt);
      await writeReceipt(receipt);
    }
    for (const source of plan.sources.filter((entry) =>
      entry.class === "machine-pull" && entry.owner === "daily-task" && entry.status !== "ready"
    )) {
      const receipt = Object.freeze({
        schema_version: 1,
        kind: "daily_refresh_source",
        identity: plan.identity.id,
        source: source.source_names?.[0] || source.key,
        status: source.status === "skipped" ? "skipped" : "unavailable",
        started_at: startedAt,
        completed_at: timestamp(now),
        freshness_advanced: false,
        reason_code: source.status === "skipped" ? "source_not_ready" : "source_unavailable",
      });
      sourceResults.push(receipt);
      await writeReceipt(receipt);
    }
    const runnable = plan.sources.filter((source) =>
      source.class === "machine-pull" && source.owner === "daily-task" && source.status === "ready"
    );
    for (const source of runnable) {
      lock.assertOwned();
      const sourceStartedAt = timestamp(now);
      if (Date.parse(sourceStartedAt) >= deadlineAt) {
        const receipt = Object.freeze({
          schema_version: 1,
          kind: "daily_refresh_source",
          identity: plan.identity.id,
          source: source.source_names?.[0] || source.key,
          status: "deferred",
          started_at: sourceStartedAt,
          completed_at: sourceStartedAt,
          freshness_advanced: false,
          reason: `the ${runtimeMinutes}-minute daily runtime budget was exhausted before this source started`,
        });
        sourceResults.push(receipt);
        await writeReceipt(receipt);
        continue;
      }
      const beforeBySource = sourceFreshness(baseline, source);
      let runResult;
      let outcome = "complete";
      let reason = null;
      try {
        runResult = await runSource(source, { assertOwned: lock.assertOwned });
        lock.assertOwned();
        const afterObservation = await observeFreshness(source);
        const afterInventory = afterObservation.inventory;
        const freshnessUnknown = baselineObservation.unavailable || afterObservation.unavailable;
        const afterBySource = sourceFreshness(afterInventory, source);
        const freshness = compareFreshness(beforeBySource, afterBySource);
        const afterValues = Object.values(afterBySource).filter(Boolean).sort();
        const beforeValues = Object.values(beforeBySource).filter(Boolean).sort();
        const after = afterValues.at(-1) || null;
        const before = beforeValues.at(-1) || null;
        const latestRuns = Object.keys(afterBySource).map((name) => afterInventory?.[name]?.latest_run);
        const checkedAt = timestamp(now);
        const selectedEntries = Array.isArray(runResult?.entries) ? runResult.entries.filter(entry =>
          entry.key === source.run_key || entry.manifestKey === source.key) : null;
        // cmdLoad reports unselected manifest entries as skipped. Only the
        // selected leg's outcome can establish that this invocation ran.
        const selectedRan = selectedEntries ? selectedEntries.length === 1 &&
          ["loaded", "partial"].includes(selectedEntries[0].status) : !runResult?.skipped;
        const executionComplete = (runResult?.status === undefined || ["complete", "partial"].includes(runResult.status)) && selectedRan &&
          !runResult?.failed && !runResult?.unavailable;
        const noChangeBySource = Object.keys(afterBySource).map((name) => {
          const row = afterInventory?.[name];
          const check = providerNoChangeCheckAt(row?.kind, row?.latest_run);
          const prior = validTimestamp(baseline?.[name]?.latest_run?.finished_at) || beforeBySource[name];
          // A stale/replayed receipt, a future clock, or a borrowed ingest date
          // cannot certify this invocation. Every leg needs its own new proof.
          return executionComplete && (runResult?.loaded > 0 || runResult?.status === "complete") &&
            check !== null && Date.parse(row.latest_run.started_at) >= Date.parse(sourceStartedAt) &&
            Date.parse(check) <= Date.parse(checkedAt) && (!prior || Date.parse(check) > Date.parse(prior)) &&
            beforeBySource[name] === afterBySource[name];
        });
        const withheldBySource = Object.keys(afterBySource).map((name) => {
          const row = afterInventory?.[name];
          const check = providerWithheldCheckAt(row?.kind, row?.latest_run);
          const prior = validTimestamp(baseline?.[name]?.last_check_at) || beforeBySource[name];
          return check && Date.parse(row.latest_run.started_at) >= Date.parse(sourceStartedAt) &&
            Date.parse(check) <= Date.parse(checkedAt) && (!prior || Date.parse(check) > Date.parse(prior)) ? check : null;
        });
        const withheldAggregate = dailyWithheldAggregate(latestRuns, withheldBySource);
        const withholdingEvidenceInvalid = withheldAggregate === null;
        const docsWithheld = withholdingEvidenceInvalid ? null : withheldAggregate.count;
        const docsRefused = latestRuns.every((run) => Number.isSafeInteger(run?.docs_refused))
          ? latestRuns.reduce((sum, run) => sum + run.docs_refused, 0) : null;
        const failedRun = latestRuns.some((run) => ["failed", "refused"].includes(run?.outcome) || run?.docs_failed > 0);
        // Reject measured zero work even when an older server advanced its date.
        const unverifiedBySource = latestRuns.map((run, index) => !withheldBySource[index] && (run?.outcome === "empty" ||
          ((run?.metrics_version === 1 || (Number.isSafeInteger(run?.docs_refused) &&
            Number.isSafeInteger(run?.docs_failed))) &&
            ![run?.docs_added, run?.docs_updated, run?.docs_unchanged]
              .some((count) => Number.isSafeInteger(count) && count > 0))));
        const loaderRefused = ["failed", "refused"].includes(runResult?.status);
        const unverifiedRun = withholdingEvidenceInvalid || unverifiedBySource.some(Boolean);
        const freshnessAdvanced = !freshnessUnknown && !loaderRefused && executionComplete && freshness.advanced && !failedRun && !unverifiedRun;
        // Either missing observation leaves this invocation's evidence unknown,
        // even if the other read contains a completed provider check.
        const checkVerified = !freshnessUnknown && !withholdingEvidenceInvalid && executionComplete && !failedRun && latestRuns.every((_run, index) => {
          if (noChangeBySource[index] || withheldBySource[index]) return true;
          const name = Object.keys(afterBySource)[index];
          return compareFreshness({ [name]: beforeBySource[name] }, { [name]: afterBySource[name] }).advanced &&
            !unverifiedBySource[index];
        });
        const docsExcluded = Number.isSafeInteger(runResult?.excluded) ? runResult.excluded : null;
        if (checkVerified && (latestRuns.some((run) => run?.outcome === "partial") ||
            runResult?.partial > 0 || docsExcluded > 0)) outcome = "partial";
        if (!checkVerified) {
          outcome = "failed";
          reason = withholdingEvidenceInvalid ? "the latest source receipt has invalid or mismatched withholding evidence"
            : unverifiedRun ? "the latest source receipt verified no accepted or unchanged documents"
            : failedRun ? "the latest source receipt reports a failed or refused run"
            : freshness.missing.length
            ? "the source claimed success, but one or more freshness receipts were missing or invalid"
            : "the source claimed success, but last_successful_run_at did not advance for every source leg";
        }
        if (freshnessUnknown) {
          outcome = "unavailable";
          reason = "source freshness is unknown because the source inventory could not be read";
        }
        // An explicit loader refusal remains a failure even when its freshness
        // observation is unavailable. Inventory fallback never approves removal.
        if (loaderRefused || (freshnessUnknown && (failedRun || unverifiedRun))) {
          outcome = "failed";
          reason = "the source refresh failed or refused its work";
        }
        const receipt = Object.freeze({
          schema_version: 1,
          kind: "daily_refresh_source",
          identity: plan.identity.id,
          source: source.source_names?.[0] || source.key,
          status: outcome,
          started_at: sourceStartedAt,
          completed_at: timestamp(now),
          last_successful_run_at_before: before,
          last_successful_run_at_after: after,
          freshness_advanced: freshnessAdvanced,
          ...(freshnessUnknown ? {
            freshness_state: "unknown",
            reason_code: "source_inventory_unavailable",
          } : {}),
          check_verified: checkVerified,
          no_change: checkVerified && noChangeBySource.every(Boolean),
          last_check_at_before: Object.keys(beforeBySource).map(name => baseline?.[name]?.last_check_at || beforeBySource[name])
            .filter(Boolean).sort().at(-1) || null,
          last_check_at_after: checkVerified ? Object.keys(afterBySource).map((name, index) =>
            noChangeBySource[index] ? afterInventory[name].latest_run.finished_at : withheldBySource[index] || afterBySource[name]).sort().at(-1) : null,
          docs_refused: docsRefused,
          docs_withheld: docsWithheld,
          ...(withheldAggregate?.reasons ? { withheld_reasons: Object.freeze(withheldAggregate.reasons) } : {}),
          docs_excluded: docsExcluded,
          missing_freshness_sources: freshness.missing,
          unadvanced_freshness_sources: freshness.notAdvanced,
          reason,
        });
        sourceResults.push(receipt);
        await writeReceipt(receipt);
      } catch (error) {
        const sourceName = source.source_names?.[0] || source.key;
        const safeSource = safeDiagnosticText(sourceName, 128);
        const issueCode = dailyIssueCode(error);
        const detail = safeDiagnosticText(error?.message || error);
        const removalReview = issueCode === "SAFETY_REVIEW_REQUIRED"
          ? safeRemovalReview(error, safeSource) : null;
        if (removalReview) attentionEntries.push(removalReview.attention);
        const receipt = Object.freeze({
          schema_version: 1,
          kind: "daily_refresh_source",
          identity: plan.identity.id,
          source: sourceName,
          status: "failed",
          started_at: sourceStartedAt,
          completed_at: timestamp(now),
          freshness_advanced: false,
          issue_code: issueCode,
          detail,
          reason_code: removalReview ? "removal_review_required" : "source_execution_failed",
          reason: removalReview?.reason || "the source refresh failed; retry this source or inspect its private local diagnostics",
        });
        sourceResults.push(receipt);
        await writeReceipt(receipt);
        await writeFailureLog({
          observed_at: timestamp(now),
          source: safeSource,
          issue_code: issueCode,
          detail,
          ...(removalReview ? { attention: removalReview.attention } : {}),
        });
      }
    }
    const result = Object.freeze({
      schema_version: 1,
      kind: "daily_refresh",
      identity: plan.identity.id,
      status: sourceResults.length === 0 || sourceResults.some((entry) => !["complete", "partial", "held"].includes(entry.status)) ? "failed"
        : sourceResults.some((entry) => ["partial", "held"].includes(entry.status)) ? "partial" : "complete",
      started_at: startedAt,
      completed_at: timestamp(now),
      lock_wait_ms: lockWaitMs,
      schedule_attention: Object.freeze([...attentionEntries]),
      sources: Object.freeze(sourceResults),
    });
    await writeReceipt(result);
    return result;
  } finally {
    lock.release();
  }
}

function freshnessMap(inventory) {
  return Object.fromEntries((inventory?.sources || []).map((row) => [row.name, {
    kind: row.kind,
    last_check_at: row?.receipt?.last_check_at || null,
    last_successful_run_at: row?.receipt?.last_successful_run_at || null,
    state: row?.freshness?.state || null,
    latest_run: row?.receipt?.latest_run || null,
  }]));
}

function dailyReceiptWriter(plan, { home = homedir() } = {}) {
  const directory = join(resolve(home), ".brain", "daily-receipts");
  const path = join(directory, `${plan.identity.id}.json`);
  return async (receipt) => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const staged = `${path}.tmp-${process.pid}`;
    writeFileSync(staged, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(staged, path);
    chmodSync(path, 0o600);
  };
}

export async function runDailyRefreshCli(manifestPath, options = {}) {
  const path = resolve(String(manifestPath || ""));
  let m;
  try { m = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
    throw new Error(`the daily refresh manifest could not be read: ${error.message}`);
  }
  if (m?.brain?.domain || m?.brain?.worker_name || m?.infrastructure?.cloudflare?.d1_database_id || m?.client?.slug) {
    const identity = dailyRefreshIdentity(m, options.principal ?? dailyRefreshPrincipal({
      platform: options.platform ?? process.platform, home: options.home,
    }));
    return observeDailyRun(identity, () => executeDailyRefreshCli(path, m, options, true), options);
  }
  return executeDailyRefreshCli(path, m, options, false);
}

async function executeDailyRefreshCli(path, m, options, observationStarted) {
  const brain = options.brainModule ?? await import("../brain.mjs");
  const buildPlan = options.buildPlan ?? brain.buildConfiguredDailyPlan;
  if (typeof buildPlan !== "function") throw new TypeError("the shared daily plan builder is unavailable");
  const plan = await buildPlan(m, path, {
    platform: options.platform ?? process.platform,
    ...(options.principal ? { principal: options.principal } : {}),
    ...(options.localTimezone ? { localTimezone: options.localTimezone } : {}),
    ...(options.planLoad ? { planLoad: options.planLoad } : {}),
    ...(options.existingSchedulerOwners !== undefined
      ? { existingSchedulerOwners: options.existingSchedulerOwners }
      : {}),
    ...(options.planOptions || {}),
  });
  const execute = async () => {
    if (!plan.ready) throw new Error(plan.configuration_error || "the daily refresh plan is not ready");
    const receiptWriter = options.writeReceipt ?? dailyReceiptWriter(plan, options);
    const readUpdateTransaction = options.readUpdateTransaction ?? readDailyRefreshUpdateTransaction;
    const expectedDefinitionHash = options.expectedDefinitionHash || null;
    const scheduleAttention = [];
    if (expectedDefinitionHash) {
      const definitionOptions = {
        platform: options.platform ?? process.platform,
        ...(options.definitionOptions || {}),
      };
      const inspectSchedule = options.inspectSchedule ?? statusDailyRefreshSchedule;
      const schedule = await inspectSchedule(plan, {
        ...definitionOptions,
        ...(options.schedulerAdapter ? { adapter: options.schedulerAdapter } : {}),
      });
      if (!schedule?.installed || schedule.enabled === false || schedule.state?.definition?.definition_hash !== expectedDefinitionHash) {
        throw new Error("the manifest or source plan changed after daily refresh registration; run brain daily on <manifest> to reconcile it");
      }
      if (schedule.registered_node_usable === false) {
        const missing = schedule.registered_node_present === false;
        const error = new Error(missing
          ? "the registered Node binary is missing; run brain daily on <manifest> to repair the daily schedule"
          : "the registered Node binary is not executable; run brain daily on <manifest> to repair the daily schedule");
        error.code = missing ? "daily_schedule_node_missing" : "daily_schedule_node_unusable";
        throw error;
      }
      if (schedule.plan_matches_registered_definition !== true) {
        throw new Error("the manifest or source plan changed after daily refresh registration; run brain daily on <manifest> to reconcile it");
      }
      const definition = buildDailyRefreshDefinition(plan, definitionOptions);
      if (definition.definition_hash !== expectedDefinitionHash) {
        if (schedule.node_path_changed !== true) {
          throw new Error("the manifest or source plan changed after daily refresh registration; run brain daily on <manifest> to reconcile it");
        }
        scheduleAttention.push("daily schedule needs refresh (Node changed)");
      }
    }
    const readFreshness = options.readFreshness ?? (async () => freshnessMap(await (brain.readSourceFreshness ?? brain.cmdSources)(path, {
      flags: { json: true },
      silent: true,
    })));
    const result = await runDailyRefresh({
      plan,
      acquireLock: options.acquireLock,
      runSource: options.runSource ?? ((source) => brain.cmdLoad(path, {
        flags: { only: source.run_key },
        lifecycleLockHeld: true,
        allowPartialRefresh: true,
      })),
      readFreshness,
      writeReceipt: receiptWriter,
      now: options.now,
      lockNow: options.lockNow,
      sleep: options.sleep,
      home: options.home,
      platform: options.platform,
      scheduleAttention,
      writeFailureLog: options.writeFailureLog ?? ((record) => appendDailySourceFailure(plan.identity, record, options)),
      recoveryRequired: () => Boolean(readUpdateTransaction(plan.identity, {
        home: options.home,
        manifestPath: path,
        platform: options.platform ?? process.platform,
        machineLockRoot: options.machineLockRoot,
      })),
    });
    if (!options.silent) {
      const log = options.log || console.log;
      for (const attention of result.schedule_attention) log(attention);
      const heldCount = result.sources.filter((source) => source.status === "held").length;
      const runCause = result.reason_code === "brain_lifecycle_busy"
        ? "brain_lifecycle_busy: another Brain operation is running; retry after it finishes."
        : result.reason_code === "update_recovery_required"
          ? "update_recovery_required: a prior update needs recovery; complete or retry the update before daily imports."
          : null;
      log(`daily refresh ${result.status}: ${result.sources.length - heldCount} source(s) attempted` +
        (heldCount ? `; ${heldCount} held` : "") +
        (runCause ? ` | ${runCause}` : ""));
      for (const source of result.sources) {
        const withheldCopy = providerWithheldOwnerCopy(source);
        const sourceCause = source.issue_code === "NETWORK_UNREACHABLE"
          ? "NETWORK_UNREACHABLE: network unavailable; check the connection, then retry this source."
          : null;
        log(`${source.source} | ${source.status} | ${source.last_successful_run_at_after || "never"}` +
          (source.no_change ? ` | checked ${source.last_check_at_after}; no changes` : "") +
          (withheldCopy ? ` | ${withheldCopy}`
            : source.status === "partial" ? ` | ${source.docs_refused ?? "unknown"} refused` : "") +
          (source.status === "held" ? ` | ${source.reason}` : "") +
          (source.docs_excluded > 0 ? ` | ${source.docs_excluded} excluded by rule` : "") +
          (sourceCause ? ` | ${sourceCause}` : ""));
      }
    }
    return result;
  };
  return observationStarted ? execute() : observeDailyRun(plan.identity, execute, options);
}

async function main(argv = process.argv.slice(2)) {
  const [command, manifestPath, flag, expectedDefinitionHash] = argv;
  if (command !== "run" || !manifestPath || (flag !== undefined && flag !== "--definition-hash")) {
    throw new Error("usage: node operations/daily-refresh-run.mjs run <manifest> [--definition-hash <sha256>]");
  }
  return runDailyRefreshCli(manifestPath, { expectedDefinitionHash });
}

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_MAIN) {
  main().then((result) => {
    if (result.status === "failed") process.exitCode = 1;
  }).catch((error) => {
    console.error(new Set(["daily_schedule_node_missing", "daily_schedule_node_unusable"]).has(error?.code)
      ? `Daily refresh did not run: the registered Node binary is ${error.code === "daily_schedule_node_missing" ? "missing" : "not executable"}. Turn daily imports on again from the normal Brain terminal to repair the schedule.`
      : "Daily refresh failed: daily_refresh_failed. Inspect the private local diagnostics, then retry.");
    process.exitCode = 1;
  });
}
