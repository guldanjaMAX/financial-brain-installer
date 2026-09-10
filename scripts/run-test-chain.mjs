import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ALLOWED_NODE_FLAGS = new Set(["--no-warnings", "--test"]);
const TEST_MODULE = /^(?:eval|scripts|test|worker\/test)\/[A-Za-z0-9._/-]+\.mjs$/u;

export const RUNNER_TEST_COMMAND = "node test/test-chain-runner.test.mjs";
// Commands added after the legacy 8,427-byte npm script was frozen. The graph
// regression projects these out so it can keep asserting the exact original
// 172-command chain and order. Add to this list when you add a test; never
// weaken the projection itself.
export const POST_LAUNCHER_TEST_COMMANDS = Object.freeze([
  RUNNER_TEST_COMMAND,
  "node --no-warnings worker/test/ready-window-webhook-regression.test.mjs",
  "node --no-warnings test/vector-bootstrap-stale-pending.test.mjs",
  "node --no-warnings test/bootstrap-receipt-reprojection.test.mjs",
  "node --no-warnings test/vector-bootstrap-end-to-end.test.mjs",
  "node --no-warnings worker/test/plaid-refresh-debt-regression.test.mjs",
  "node --no-warnings worker/test/mcp-upgrade-pause.test.mjs",
  "node --no-warnings worker/test/oauth-consent-query.test.mjs",
  "node --no-warnings worker/test/public-guard-coverage.test.mjs",
  "node --test test/subdomain-read-names-its-cause.test.mjs",
  "node --test test/adoption-requires-prior-ownership.test.mjs",
  "node --test test/vectorize-ownership-persisted.test.mjs",
  "node test/hidden-entry-fails-closed.test.mjs",
  "node worker/test/pending-short-projection-activates.test.mjs",
  "node worker/test/remedy-never-names-a-refused-action.test.mjs",
  "node test/ingest-link-and-declared-source.test.mjs",
  "node test/upgrade-resend-is-announced.test.mjs",
  "node --no-warnings worker/test/reprojection-pause-order.test.mjs",
  "node --no-warnings test/legacy-manifest-auth-profile.test.mjs",
  "node --no-warnings test/adopt-cloudflare-profile-consent.test.mjs",
  "node test/drain-query-ready-gate.test.mjs",
  // Client upgrade rehearsals, added after the launcher freeze. Every shipped
  // release through v0.3.6 ships 22 migrations and this release ships 35, so
  // 0023..0035 have never run on a real client brain until these.
  "node --no-warnings test/migration-walk-22-to-35.test.mjs",
  "node --no-warnings test/healthy-schema22-update-rehearsal.test.mjs",
  "node --no-warnings test/healthy-v020-install-guards.test.mjs",
  "node --no-warnings test/paused-strand-upgrade-rehearsal.test.mjs",
  "node --no-warnings test/client-upgrade-rehearsal.test.mjs",
  // Field run A: the cutover printed its success line after a probe error and
  // told the migration the drain was quiesced anyway.
  "node --no-warnings test/vector-drain-cutover-unverified.test.mjs",
  "node --no-warnings test/setup-paused-brain-guard.test.mjs",
  "node --no-warnings test/zone-assignment-retry.test.mjs",
]);
export const TEST_COMMANDS = Object.freeze([
  "node test/test-chain-complete.test.mjs",
  "node test/test-chain-runner.test.mjs",
  "node --no-warnings test/provenance-sweep.test.mjs",
  "node test/current-version.test.mjs",
  "node test/brain-http.test.mjs",
  "node --test test/golden20-backlog-guard.test.mjs",
  "node test/acceptance-verdict.test.mjs",
  "npm run test:eval",
  "node test/eval-init-privacy.test.mjs",
  "node test/init-paths.test.mjs",
  "node test/setup-clean-path.test.mjs",
  "node test/ask.test.mjs",
  "node test/mcp-absence-honesty.test.mjs",
  "node test/field-rehearsal.test.mjs",
  "node test/provision-guards.test.mjs",
  "node test/drive-removal-guard.test.mjs",
  "node --no-warnings test/family-reconciliation.test.mjs",
  "node --no-warnings test/ingestion-contract.test.mjs",
  "node test/curated-dual-sync.test.mjs",
  "node test/curated-sync-scheduler.test.mjs",
  "node test/package-privacy.test.mjs",
  "node test/wrangler-oauth.test.mjs",
  "node test/cloudflare-token-prompt.test.mjs",
  "node test/technician-setup.test.mjs",
  "node test/onboarding-sandbox.test.mjs",
  "node test/cloudflare-token-store.test.mjs",
  "node test/drain-throughput.test.mjs",
  "node --no-warnings test/vector-fence-recovery.test.mjs",
  "node --no-warnings test/cli-path-persist.test.mjs",
  "node --no-warnings test/fresh-setup-path.test.mjs",
  "node --no-warnings test/d1-batch-ingest.test.mjs",
  "node --no-warnings test/vector-delete-outbox.test.mjs",
  "node --no-warnings test/vector-bootstrap-paused-strand.test.mjs",
  // Client upgrade rehearsals. Every shipped release through v0.3.6 carries 22
  // migrations and this release carries 35, so 0023..0035 have never run on a
  // real client brain. These walk a populated schema-22 database forward.
  "node --no-warnings test/migration-walk-22-to-35.test.mjs",
  "node --no-warnings test/healthy-schema22-update-rehearsal.test.mjs",
  "node --no-warnings test/healthy-v020-install-guards.test.mjs",
  "node --no-warnings test/paused-strand-upgrade-rehearsal.test.mjs",
  "node --no-warnings test/client-upgrade-rehearsal.test.mjs",
  "node --no-warnings test/setup-paused-brain-guard.test.mjs",
  "node test/supabase-import.test.mjs",
  "node test/message-session.test.mjs",
  "node --no-warnings test/imessage-capture.test.mjs",
  "node --no-warnings test/imessage-ingest.test.mjs",
  "node --no-warnings test/whatsapp-capture.test.mjs",
  "node --no-warnings test/whatsapp-ingest.test.mjs",
  "node --no-warnings test/iphone-backup.test.mjs",
  "node test/migration-import-closure.test.mjs",
  "node test/migration-hardening.test.mjs",
  "node test/reindex.test.mjs",
  "node test/verified-recovery.test.mjs",
  "node test/cloudflare-recovery-adapter.test.mjs",
  "node test/freshness.test.mjs",
  "node test/acceptance-freshness.test.mjs",
  "node test/bootstrap-retrying.test.mjs",
  "node test/acceptance-version.test.mjs",
  "node test/wrangler-session-retry.test.mjs",
  "node test/schedule-platform.test.mjs",
  "node test/database-read-failure.test.mjs",
  "node test/schema-ahead-guard.test.mjs",
  "node test/teardown-guards.test.mjs",
  "node test/upgrade-verify.test.mjs",
  "node --no-warnings test/vector-drain-cutover-unverified.test.mjs",
  "node test/upgrade-repair.test.mjs",
  "node test/checksum-reconciliation.test.mjs",
  "node --test test/unknown-flags.test.mjs",
  "node test/whatsapp-export.test.mjs",
  "node test/sms-backup.test.mjs",
  "node test/facebook-messenger-export.test.mjs",
  "node test/calendar-ingest.test.mjs",
  "node test/imap-connector.test.mjs",
  "node --no-warnings test/imap-scanner-removal.test.mjs",
  "node test/connector-rehearsal.test.mjs",
  "node --no-warnings test/diagnose.test.mjs",
  "node --no-warnings test/fts-stopwords.test.mjs",
  "node test/support-journal.test.mjs",
  "node test/support-recovery.test.mjs",
  "node test/admin-key-file.test.mjs",
  "node test/admin-key-rotation.test.mjs",
  "node test/rag-proxy-key.test.mjs",
  "node test/session-signing-key.test.mjs",
  "node test/mcp-apply.test.mjs",
  "node test/mcp-rotation.test.mjs",
  "node test/health-verify-exit.test.mjs",
  "node test/drain-exit.test.mjs",
  "node test/drain-query-ready-gate.test.mjs",
  "node test/report-html.test.mjs",
  "node test/report-deploy-exit.test.mjs",
  "node test/errors.test.mjs",
  "node test/doctor.test.mjs",
  "node --test test/drain-cron-default.test.mjs",
  "node --no-warnings test/bank-feed-secrets.test.mjs",
  "node test/bank-feed-deploy-path.test.mjs",
  "node test/migrations.test.mjs",
  "node test/doc-date.test.mjs",
  "node test/quality.test.mjs",
  "node test/ingest-run.test.mjs",
  "node --no-warnings test/ingest-prefetch.test.mjs",
  "node --no-warnings test/source-ingest-lock.test.mjs",
  "node test/formats-extra.test.mjs",
  "node --no-warnings test/ocr.test.mjs",
  "node test/bank-export.test.mjs",
  "node --no-warnings test/bank-import-path.test.mjs",
  "node test/load-all.test.mjs",
  "node test/drive-live-fixture.test.mjs",
  "node test/google-calendar.test.mjs",
  "node test/google-auth-storage.test.mjs",
  "node test/google-drive.test.mjs",
  "node test/drive-scheduler.test.mjs",
  "node test/imessage-scheduler.test.mjs",
  "node test/folder-scheduler.test.mjs",
  "node test/whatsapp-daemon.test.mjs",
  "node test/zoom-connect.test.mjs",
  "node test/zoom-cli.test.mjs",
  "node worker/test/worker.test.mjs",
  "node worker/test/confidence.test.mjs",
  "node --test worker/test/evidence-authority.test.mjs",
  "node --test worker/test/webauthn.test.mjs worker/test/sessions.test.mjs worker/test/owner-auth.test.mjs worker/test/grants.test.mjs worker/test/document-access.test.mjs worker/test/owner-actions.test.mjs worker/test/connector.test.mjs worker/test/app-page.test.mjs worker/test/zones.test.mjs",
  "node worker/test/store.test.mjs",
  "node worker/test/store-d1.test.mjs",
  "node worker/test/credential-envelope-gate.test.mjs",
  "node --no-warnings worker/test/connections.test.mjs",
  "node worker/test/routes.test.mjs",
  "node worker/test/zoom.test.mjs",
  "node worker/test/health-honesty.test.mjs",
  "node worker/test/degraded-absence.test.mjs",
  "node worker/test/secret-scan.test.mjs",
  "node worker/test/provider-routing.test.mjs",
  "node worker/test/spend-cap.test.mjs",
  "node --no-warnings worker/test/fin-d1.test.mjs",
  "node --no-warnings worker/test/fin-routes.test.mjs",
  "node --no-warnings --test worker/test/product-migration-contract.test.mjs worker/test/owner-actions-contract.test.mjs worker/test/business-scope-contract.test.mjs worker/test/security-contract.test.mjs",
  "node worker/test/system-status.test.mjs",
  "node --no-warnings worker/test/bank-feed.test.mjs",
  "node --no-warnings test/archive-safety.test.mjs",
  "node --no-warnings test/bank-access-wrapping-key.test.mjs",
  "node --no-warnings test/bootstrap-status.test.mjs",
  "node --no-warnings test/client-experience-packet.test.mjs",
  "node --no-warnings test/cloudflare-account-bootstrap.test.mjs",
  "node --no-warnings test/cloudflare-oauth-session.test.mjs",
  "node --no-warnings test/field-prepare.test.mjs",
  "node --no-warnings test/full-history-privacy.test.mjs",
  "node --no-warnings test/gmail-incremental-policy.test.mjs",
  "node --no-warnings test/linkedin-export.test.mjs",
  "node --no-warnings test/migration-checksum-pin.test.mjs",
  "node --no-warnings test/migration-upgrade-path.test.mjs",
  "node --no-warnings test/packed-fresh-setup.test.mjs",
  "node --no-warnings test/provider-cli.test.mjs",
  "node --no-warnings test/provider-connectors.test.mjs",
  "node --no-warnings test/provider-oauth.test.mjs",
  "node --no-warnings test/provider-runtime.test.mjs",
  "node --no-warnings test/provider-scheduler.test.mjs",
  "node --no-warnings test/provider-sync-safety.test.mjs",
  "node --no-warnings test/recovery-artifact-crypto.test.mjs",
  "node --no-warnings test/recovery-mutation-boundaries.test.mjs",
  "node --no-warnings test/vector-drain-recovery.test.mjs",
  "node --no-warnings test/windows-dpapi-release-gate.test.mjs",
  "node --no-warnings worker/test/agent-authority-deletion.test.mjs",
  "node --no-warnings worker/test/owner-bank-import.test.mjs",
  "node --no-warnings worker/test/plaid-bank-feed.test.mjs",
  "node --no-warnings worker/test/plaid-protocol.test.mjs",
  "node --no-warnings worker/test/plaid-scheduled.test.mjs",
  "node --no-warnings worker/test/qbo-bank-reconciliation.test.mjs",
  "node --no-warnings worker/test/quickbooks-oauth-callback.test.mjs",
  "node --no-warnings worker/test/support-access.test.mjs",
  "node --no-warnings worker/test/tax-qbo-reconciliation.test.mjs",
  "node --no-warnings worker/test/update-status.test.mjs",
  "node --no-warnings worker/test/upload-extract.test.mjs",
  "node --no-warnings worker/test/zoom-delivery-safety.test.mjs",
  "node --no-warnings test/update-audit.test.mjs",
  "node --no-warnings test/preflight-posix.test.mjs",
  "node --no-warnings test/wrangler-spec-pinned.test.mjs",
  "node --no-warnings test/install-page-version.test.mjs",
  "node --no-warnings test/release-script-coverage.test.mjs",
  "node scripts/test-release-workflow-contract.mjs",
  "node --no-warnings test/provider-ingest-custody.test.mjs",
  "node --no-warnings test/vector-bootstrap-history.test.mjs",
  "node --no-warnings test/vector-fence-probe.test.mjs",
  "node --no-warnings test/cli-guidance-rendering.test.mjs",
  "node --no-warnings worker/test/plaid-connection-review.test.mjs",
  "node --no-warnings worker/test/owner-entity-create.test.mjs",
  "node --no-warnings worker/test/plaid-sync-custody.test.mjs",
  "node --no-warnings worker/test/ready-window-webhook-regression.test.mjs",
  "node --no-warnings test/vector-bootstrap-stale-pending.test.mjs",
  "node --no-warnings test/bootstrap-receipt-reprojection.test.mjs",
  "node --no-warnings test/vector-bootstrap-end-to-end.test.mjs",
  "node --no-warnings worker/test/plaid-refresh-debt-regression.test.mjs",
  "node --no-warnings worker/test/mcp-upgrade-pause.test.mjs",
  "node --no-warnings worker/test/oauth-consent-query.test.mjs",
  "node --no-warnings worker/test/public-guard-coverage.test.mjs",
  "node --test test/subdomain-read-names-its-cause.test.mjs",
  "node --test test/adoption-requires-prior-ownership.test.mjs",
  "node --test test/vectorize-ownership-persisted.test.mjs",
  "node test/hidden-entry-fails-closed.test.mjs",
  "node worker/test/pending-short-projection-activates.test.mjs",
  "node worker/test/remedy-never-names-a-refused-action.test.mjs",
  "node test/ingest-link-and-declared-source.test.mjs",
  "node test/upgrade-resend-is-announced.test.mjs",
  "node --no-warnings worker/test/reprojection-pause-order.test.mjs",
  "node --no-warnings test/legacy-manifest-auth-profile.test.mjs",
  "node --no-warnings test/adopt-cloudflare-profile-consent.test.mjs",
  "node --no-warnings test/zone-assignment-retry.test.mjs",
]);

export function parseTestCommand(command) {
  if (typeof command !== "string" || command.length === 0 || command !== command.trim()) {
    throw new TypeError("test commands must be nonempty, trimmed strings");
  }
  const words = command.split(" ");
  if (words.some((word) => word.length === 0)) {
    throw new TypeError(`test command has unsupported whitespace: ${command}`);
  }

  if (words[0] === "npm") {
    if (words.length !== 3 || words[1] !== "run" || words[2] !== "test:eval") {
      throw new TypeError(`unsupported npm test command: ${command}`);
    }
    return Object.freeze({ display: command, kind: "npm", args: Object.freeze(words.slice(1)) });
  }

  if (words[0] !== "node") {
    throw new TypeError(`unsupported test executable: ${words[0]}`);
  }

  let sawModule = false;
  for (const word of words.slice(1)) {
    if (!sawModule && word.startsWith("--")) {
      if (!ALLOWED_NODE_FLAGS.has(word)) {
        throw new TypeError(`unsupported Node test flag: ${word}`);
      }
      continue;
    }
    sawModule = true;
    if (!TEST_MODULE.test(word)) {
      throw new TypeError(`unsupported test module: ${word}`);
    }
  }
  if (!sawModule) {
    throw new TypeError(`test command has no module: ${command}`);
  }
  return Object.freeze({ display: command, kind: "node", args: Object.freeze(words.slice(1)) });
}

for (const command of TEST_COMMANDS) parseTestCommand(command);

export function parseRunnerOptions(args) {
  if (!Array.isArray(args)) throw new TypeError("runner arguments must be an array");
  if (args.length === 0) return Object.freeze({ continueOnFailure: false });
  if (args.length === 1 && args[0] === "--continue-on-failure") {
    return Object.freeze({ continueOnFailure: true });
  }
  throw new TypeError(`unknown test-runner option: ${args.join(" ")}`);
}

function invocationFor(parsed, { nodeExecutable, npmExecPath }) {
  if (typeof nodeExecutable !== "string" || !isAbsolute(nodeExecutable)) {
    throw new TypeError("the Node executable must be an absolute path");
  }
  if (parsed.kind === "node") {
    return { executable: nodeExecutable, args: [...parsed.args] };
  }
  if (typeof npmExecPath !== "string" || !isAbsolute(npmExecPath)) {
    throw new TypeError("npm_execpath is required for the npm test:eval command; start this runner with npm test");
  }
  return {
    executable: nodeExecutable,
    args: [npmExecPath, ...parsed.args],
  };
}

function failedExecution(command, index, child) {
  if (child?.error) {
    return Object.freeze({ command, index, code: 1, signal: null, reason: "spawn" });
  }
  if (child?.signal) {
    return Object.freeze({ command, index, code: null, signal: child.signal, reason: "signal" });
  }
  if (child?.status !== 0) {
    const code = Number.isInteger(child?.status) && child.status > 0 ? child.status : 1;
    return Object.freeze({ command, index, code, signal: null, reason: "exit" });
  }
  return null;
}

function failureLabel(failure) {
  if (failure.signal) return `signal ${failure.signal}`;
  if (failure.reason === "spawn") return "could not start";
  return `exit ${failure.code}`;
}

export function runTestCommands({
  commands = TEST_COMMANDS,
  continueOnFailure = false,
  cwd = ROOT,
  env = process.env,
  nodeExecutable = process.execPath,
  npmExecPath = process.env.npm_execpath,
  spawnSyncImpl = spawnSync,
  stdio = "inherit",
  logger = console,
} = {}) {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new TypeError("the test command graph must be a nonempty array");
  }

  const failures = [];
  let attempted = 0;
  for (const [index, command] of commands.entries()) {
    const parsed = parseTestCommand(command);
    const invocation = invocationFor(parsed, { nodeExecutable, npmExecPath });
    const child = spawnSyncImpl(invocation.executable, invocation.args, {
      cwd,
      env,
      stdio,
      shell: false,
      windowsHide: true,
    });
    attempted += 1;
    const failure = failedExecution(command, index, child);
    if (!failure) continue;

    failures.push(failure);
    logger.error(`test ${index + 1}/${commands.length} failed (${failureLabel(failure)}): ${command}`);
    if (!continueOnFailure) break;
  }

  return Object.freeze({
    ok: failures.length === 0,
    attempted,
    total: commands.length,
    failures: Object.freeze(failures),
  });
}

export function exitDisposition(result, { continueOnFailure = false } = {}) {
  if (result.ok) return Object.freeze({ code: 0, signal: null });
  const first = result.failures[0];
  if (!continueOnFailure && first?.signal) {
    return Object.freeze({ code: null, signal: first.signal });
  }
  if (!continueOnFailure && Number.isInteger(first?.code) && first.code > 0) {
    return Object.freeze({ code: first.code, signal: null });
  }
  return Object.freeze({ code: 1, signal: null });
}

function runFromCli() {
  try {
    const options = parseRunnerOptions(process.argv.slice(2));
    const result = runTestCommands(options);
    if (result.ok) {
      console.log(`test chain complete: ${result.attempted}/${result.total} commands passed`);
      return;
    }

    console.error(`test chain failed: ${result.failures.length} of ${result.attempted} attempted commands failed`);
    for (const failure of result.failures) {
      console.error(`  ${failure.index + 1}. ${failure.command} (${failureLabel(failure)})`);
    }

    const disposition = exitDisposition(result, options);
    if (disposition.signal) {
      process.exitCode = 1;
      try {
        process.kill(process.pid, disposition.signal);
      } catch {
        // Unsupported self-signaling still leaves a nonzero result.
      }
      return;
    }
    process.exitCode = disposition.code;
  } catch (error) {
    console.error(`test chain configuration error: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 2;
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath === resolve(fileURLToPath(import.meta.url))) runFromCli();
