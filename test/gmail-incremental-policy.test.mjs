import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  credentialScannerFingerprint,
  gmailRetryMessageIds,
  sourceCursorCanAdvance,
  sourceReceiptHasRemoteGap,
  validateBatchReceipt,
} from "../brain.mjs";
import { gmailRefusalReadyReceipt } from "./fixtures/gmail-refusal-receipt.mjs";
import {
  DEFAULT_QUERY,
  gmailLabelDecision,
  gmailPolicyFingerprint,
  gmailQuery,
  normalizeGmailSince,
} from "../connectors/gmail.mjs";
import { readAdminKeyFile } from "../operations/admin-key-file.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLI = join(ROOT, "brain.mjs");
const FIXTURE = pathToFileURL(join(HERE, "fixtures", "gmail-incremental-policy-fetch.mjs")).href;
const CURSOR_MUTANT = pathToFileURL(join(HERE, "fixtures", "gmail-cursor-old-behavior-mutant.mjs")).href;
const GREEN_MUTANT = pathToFileURL(join(HERE, "fixtures", "gmail-green-old-behavior-mutant.mjs")).href;
const SYNTHETIC_OPENAI_KEY = `sk-proj-${"A7".repeat(16)}`;
const SYNTHETIC_ADMIN_KEY = "01234567".repeat(8);
const massRefusalIds = Array.from({ length: 101 }, (_, i) => `mass-sensitive-${String(i + 1).padStart(3, "0")}`);
const dilutionOldIds = Array.from({ length: 100 }, (_, i) => `old-absent-${String(i + 1).padStart(3, "0")}`);
const strip = (value) => String(value || "").replace(/\x1b\[[0-9;]*m/g, "");
let ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  assert.ok(condition, `${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS  ${name}`);
};

function stateFor(mode) {
  const currentScannerFingerprint = credentialScannerFingerprint(true);
  const state = {
    version: 1,
    done: {},
    skipped: {},
    history_id: "history-prior",
    credential_scanner_fingerprint: currentScannerFingerprint,
    gmail_policy_fingerprint: gmailPolicyFingerprint({
      credentialScannerFingerprint: currentScannerFingerprint,
    }),
  };
  if (mode === "policy-change-sweep") {
    state.gmail_policy_fingerprint = "stale-gmail-policy";
  }
  if (["since-safe-sweep", "since-removal-review"].includes(mode)) {
    state.done = mode === "since-safe-sweep"
      ? { "gmail:since-oldest": "since-oldest-v1" }
      : {
          "gmail:since-older": "since-older-v1",
          "gmail:since-retained": "since-retained-v1",
        };
  }
  if (mode === "since-incremental") {
    state.done["gmail:since-incremental-older"] = "since-incremental-older-v1";
    state.gmail_policy_fingerprint = gmailPolicyFingerprint({
      credentialScannerFingerprint: currentScannerFingerprint,
      since: "2022-03-01",
    });
  }
  if (mode === "unclassified") {
    state.done["gmail:unclassified"] = "history-prior-message";
    state.removed = { "gmail:pending-removal": "2026-09-04T00:00:00.000Z" };
  }
  if (mode === "credential-refusal") {
    state.done["gmail:credential-refused"] = "credential-prior-v1";
  }
  if (["deleted", "readback-stale"].includes(mode)) {
    state.done["gmail:gone"] = "history-prior";
  }
  if (mode === "relabeled") {
    state.done["gmail:relabelled"] = "history-prior";
  }
  if (mode === "pending-restored") {
    state.done["gmail:pending-restored"] = "history-current";
    state.removed = { "gmail:pending-restored": "2026-09-04T00:00:00.000Z" };
  }
  if (mode === "pending-retained") {
    state.done["gmail:pending-retained"] = "pending-retained-v1";
    state.removed = { "gmail:pending-retained": "2026-09-04T00:00:00.000Z" };
  }
  if (mode === "pending-absent-unreadable") {
    state.done["gmail:pending-absent-unreadable"] = "pending-absent-unreadable-v1";
    state.removed = { "gmail:pending-absent-unreadable": "2026-09-04T00:00:00.000Z" };
  }
  if (mode === "pending-readback-failure") {
    state.done["gmail:pending-readback"] = "pending-readback-v1";
    state.removed = { "gmail:pending-readback": "2026-09-04T00:00:00.000Z" };
  }
  if (["sweep-query-evidence", "sweep-marker-missing"].includes(mode)) {
    delete state.history_id;
  }
  if (mode === "recoverable-worker-failure") delete state.history_id;
  if (mode === "refusal-only-sweep") delete state.history_id;
  if (mode === "resume-precondition-failure") {
    delete state.history_id;
    state.done = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`gmail:checkpoint-prior-${index + 1}`, `prior-v${index + 1}`]),
    );
    state.skipped = Object.fromEntries(
      Array.from({ length: 3 }, (_, index) => [`gmail:checkpoint-skip-${index + 1}`, "prior policy skip"]),
    );
  }
  if (mode === "incremental-precondition-failure") {
    state.done = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`gmail:checkpoint-prior-${index + 1}`, `prior-v${index + 1}`]),
    );
    state.skipped = Object.fromEntries(
      Array.from({ length: 3 }, (_, index) => [`gmail:checkpoint-skip-${index + 1}`, "prior policy skip"]),
    );
  }
  if (["scanner-v5", "scanner-v5-omitted", "scanner-v5-retained-untracked", "scanner-v5-progress-missing", "scanner-v5-mass-refusal", "scanner-v5-dilution-guard"].includes(mode)) {
    state.done = mode === "scanner-v5-mass-refusal"
      ? Object.fromEntries(massRefusalIds.map((id) => [`gmail:${id}`, `mass-v1-${id}`]))
      : mode === "scanner-v5-dilution-guard"
        ? Object.fromEntries(dilutionOldIds.map((id) => [`gmail:${id}`, "history-prior"]))
      : {
          "gmail:migration-safe": "migration-safe-v1",
          ...(mode === "scanner-v5"
            ? { "gmail:migration-sensitive": "migration-sensitive-v1" }
            : mode === "scanner-v5-omitted"
              ? { "gmail:migration-omitted": "migration-omitted-v1" }
              : {}),
        };
    const priorScannerFingerprint = credentialScannerFingerprint(true, 4);
    state.credential_scanner_fingerprint = priorScannerFingerprint;
    state.gmail_policy_fingerprint = gmailPolicyFingerprint({
      credentialScannerFingerprint: priorScannerFingerprint,
    });
    state.credential_scanner_progress = {
      fingerprint: credentialScannerFingerprint(true, 4),
      accepted: { "gmail:migration-safe": "migration-safe-v1" },
    };
    if (mode === "scanner-v5-progress-missing") {
      state.credential_scanner_progress = {
        fingerprint: credentialScannerFingerprint(true, 5),
        accepted: { "gmail:migration-safe": "migration-safe-v1" },
      };
    }
  }
  return state;
}

function runCase(mode, { approval = null, directory = null, reset = false } = {}) {
  const fresh = directory == null;
  directory ||= realpathSync.native(mkdtempSync(join(tmpdir(), `brain-test-gmail-${mode}-`)));
  const manifestPath = join(directory, "fixture.manifest.json");
  const statePath = join(directory, ".brain-ingest-gmail.json");
  const evidencePath = join(directory, "evidence.json");
  const userRoot = join(directory, "isolated-user-root");
  const tokenRoot = join(userRoot, ".brain");
  if (fresh) {
    mkdirSync(tokenRoot, { recursive: true, mode: 0o700 });
    writeFileSync(manifestPath, JSON.stringify({
      client: { slug: "fixture" },
      brain: { domain: "fixture.invalid" },
      infrastructure: { cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-db" } },
      safety: { credential_scanner: { enabled: true }, private_path_prefixes: [] },
      ...(["since-safe-sweep", "since-incremental"].includes(mode)
        ? { corpora: { gmail: { since: "2022-03-01" } } }
        : mode === "since-removal-review"
          ? { corpora: { gmail: { since: "2022-04-01" } } }
          : {}),
    }));
    writeFileSync(join(tokenRoot, "google-tokens.json"), JSON.stringify({
      google: { client_id: "fixture-client", client_secret: null, refresh_token: "fixture-refresh", scopes: ["gmail"] },
    }), { mode: 0o600 });
    writeFileSync(join(directory, ".brain-admin-key"), `${SYNTHETIC_ADMIN_KEY}\n`, { mode: 0o600 });
    writeFileSync(statePath, JSON.stringify(stateFor(mode)), { mode: 0o600 });
  }

  const environment = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  Object.assign(environment, {
    HOME: userRoot,
    NO_COLOR: "1",
    BRAIN_NO_WRANGLER_LOGIN: "1",
    BRAIN_GOOGLE_TOKEN_STORE: "file",
    BRAIN_GMAIL_POLICY_MODE: mode,
    BRAIN_GMAIL_POLICY_EVIDENCE: evidencePath,
    BRAIN_GMAIL_POLICY_USER_ROOT: userRoot,
  });
  const mutant = process.env.BRAIN_GMAIL_CURSOR_MUTANT === "1"
    ? CURSOR_MUTANT
    : process.env.BRAIN_GMAIL_GREEN_MUTANT === "1" ? GREEN_MUTANT : null;
  const args = [
    ...(mutant ? ["--import", mutant] : []),
    "--import", FIXTURE, CLI, "ingest", manifestPath, "--from", "gmail",
  ];
  if (reset) args.push("--reset");
  if (approval) args.push("--approve-removals", approval);
  const result = spawnSync(process.execPath, args, { encoding: "utf8", env: environment, timeout: 30_000 });
  assert.equal(result.error, undefined, String(result.error || ""));
  assert.equal(result.signal, null, `${mode} Gmail fixture was terminated`);
  const output = strip(`${result.stdout || ""}${result.stderr || ""}`);
  assert.ok(existsSync(evidencePath), `${mode} Gmail fixture wrote no evidence:\n${output}`);
  return {
    directory,
    code: result.status,
    output,
    state: JSON.parse(readFileSync(statePath, "utf8")),
    evidence: JSON.parse(readFileSync(evidencePath, "utf8")),
  };
}

function runApprovedCase(mode) {
  const review = runCase(mode);
  const approval = /--approve-removals ([0-9a-f]{64})/.exec(review.output)?.[1] || null;
  assert.ok(approval, `${mode} did not produce a removal approval fingerprint: ${review.output.slice(-1_200)}`);
  return runCase(mode, { directory: review.directory, approval });
}

if (process.platform !== "win32") {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-test-admin-key-link-")));
  try {
    const target = join(root, "target");
    const linked = join(root, "linked");
    mkdirSync(target, { mode: 0o700 });
    writeFileSync(join(target, ".brain-admin-key"), `${SYNTHETIC_ADMIN_KEY}\n`, { mode: 0o600 });
    symlinkSync(target, linked, "dir");

    check("the admin-key reader accepts the same fixture through its canonical path",
      readAdminKeyFile(join(target, ".brain-admin-key")) === SYNTHETIC_ADMIN_KEY);

    let parentChecks = 0;
    assert.throws(
      () => readAdminKeyFile(join(linked, ".brain-admin-key"), {
        realpath(path) {
          parentChecks++;
          return realpathSync.native(path);
        },
      }),
      /must not pass through a linked directory/,
    );
    check("the admin-key reader still reaches and enforces its linked-parent refusal", parentChecks === 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  check("Gmail advances past failed parts only when every failure has a durable retry identity",
    sourceCursorCanAdvance({ failed: 2 }, { durableRetryFailures: 2 }) === true &&
    sourceCursorCanAdvance({ failed: 2 }, { durableRetryFailures: 1 }) === false);
  assert.throws(
    () => gmailRetryMessageIds({ gmail_retry: { "gmail:bad id": "revision" } }),
    /saved Gmail retry list is invalid/,
  );
  check("a malformed Gmail retry list fails closed before cursor settlement", true);

  const schema = JSON.parse(readFileSync(join(ROOT, "manifest.schema.json"), "utf8"));
  const sinceSchema = schema.properties?.corpora?.properties?.gmail?.properties?.since;
  check("the manifest schema declares Gmail since as an exact calendar date",
    sinceSchema?.type === "string" && sinceSchema?.format === "date" &&
    sinceSchema?.pattern === "^\\d{4}-\\d{2}-\\d{2}$",
    JSON.stringify(sinceSchema));
  check("an absent Gmail floor preserves the prior query and policy fingerprint",
    gmailQuery() === DEFAULT_QUERY &&
    gmailPolicyFingerprint({ credentialScannerFingerprint: "fixture-scanner" }) ===
      "7220687d0100ae90edf4a17419811b14a1c537a0fc55bbe005b161069424385a",
    gmailQuery());
  check("a Gmail floor changes both the full-list query and policy fingerprint",
    gmailQuery({ since: "2022-03-01" }) === `${DEFAULT_QUERY} after:2022/03/01` &&
    gmailPolicyFingerprint({ credentialScannerFingerprint: "fixture-scanner", since: "2022-03-01" }) !==
      gmailPolicyFingerprint({ credentialScannerFingerprint: "fixture-scanner" }));
  check("Gmail since validation rejects malformed and impossible dates",
    ["2022-3-01", "2022-02-29", " 2022-03-01", 20220301].every((value) => {
      try { normalizeGmailSince(value); return false; } catch { return true; }
    }));
  const older = gmailLabelDecision(["INBOX"], {
    since: "2022-03-01",
    internalDate: String(Date.UTC(2022, 1, 28, 23, 59, 59)),
  });
  const boundary = gmailLabelDecision(["INBOX"], {
    since: "2022-03-01",
    internalDate: String(Date.UTC(2022, 2, 1)),
  });
  check("incremental policy treats pre-floor mail as a deterministic policy exclusion",
    older.allowed === false && older.policy === true && older.cursor_blocking === false &&
    boundary.allowed === true &&
    gmailLabelDecision(["INBOX"], { since: "2022-03-01" }).cursor_blocking === true,
    JSON.stringify({ older, boundary }));
}

{
  const result = runCase("mixed");
  try {
    check("incremental Gmail indexes ordinary inbox mail but not a promotion",
      result.code === 0 && result.evidence.ingested_ids.join(",") === "inbox",
      result.output.slice(-1_200));
    check("an incremental promotion is a deliberate policy skip, not missing coverage",
      result.state.history_id === "history-current" &&
      result.evidence.final_receipt?.status === "ready" &&
      result.evidence.final_receipt?.docs_refused === 0 &&
      result.evidence.final_receipt?.docs_failed === 0 &&
      /policy_skipped=1; coverage_gaps=0/.test(result.evidence.final_receipt?.detail || ""),
      JSON.stringify(result.evidence.final_receipt));
  } finally { rmSync(result.directory, { recursive: true, force: true }); }
}

{
  const result = runCase("refusal-only");
  try {
    const receipt = result.evidence.final_receipt;
    check("the refusal-only probe reaches two refusals and a closed receipt",
      receipt !== null && receipt?.docs_refused === 2 &&
      result.evidence.receipts.ready + result.evidence.receipts.error === 1,
      JSON.stringify(result.evidence));
    check("two new locally refused Gmail messages close ready without entering the Brain",
      result.code === 0 && result.state.history_id === "history-current" &&
      result.evidence.ingested_ids.length === 0 && result.evidence.forget_targets.length === 0 &&
      !/--approve-removals [0-9a-f]{64}/.test(result.output) &&
      JSON.stringify(receipt) === JSON.stringify(gmailRefusalReadyReceipt({
        runId: receipt?.run_id,
        startedAt: receipt?.started_at,
        completedAt: receipt?.completed_at,
      })),
      `${result.output.slice(-1_200)}\n${JSON.stringify(receipt)}`);
  } finally { rmSync(result.directory, { recursive: true, force: true }); }
}

{
  const result = runCase("refusal-only-sweep");
  try {
    check("a refusal-only Gmail sweep is ready without claiming complete history",
      result.code === 0 && result.evidence.final_receipt?.status === "ready" &&
      result.evidence.final_receipt?.complete_sweep === false &&
      result.evidence.final_receipt?.docs_refused === 2 &&
      result.evidence.final_receipt?.docs_failed === 0,
      `${result.output.slice(-1_200)}\n${JSON.stringify(result.evidence.final_receipt)}`);
  } finally { rmSync(result.directory, { recursive: true, force: true }); }
}

{
  const result = runCase("refusal-with-failure");
  try {
    check("a Gmail refusal plus a recoverable failure stays failed and retryable",
      result.code === 1 && result.state.history_id === "history-current" &&
      result.evidence.final_receipt?.status === "error" &&
      result.evidence.final_receipt?.issue_code === "INGEST_FAILED" &&
      result.evidence.final_receipt?.docs_refused === 1 &&
      result.evidence.final_receipt?.docs_failed === 1 &&
      result.state.gmail_retry?.["gmail:refusal-failure-worker"] === "history-current",
      `${result.output.slice(-1_200)}\n${JSON.stringify(result.state)}\n${JSON.stringify(result.evidence.final_receipt)}`);
  } finally { rmSync(result.directory, { recursive: true, force: true }); }
}

{
  check("only Gmail credential refusals are excluded from the remote-gap decision",
    sourceReceiptHasRemoteGap({ source: "gmail", tally: { failed: 0 }, totalRefused: 2 }) === false &&
    sourceReceiptHasRemoteGap({ source: "drive", tally: { failed: 0 }, totalRefused: 2 }) === true &&
    sourceReceiptHasRemoteGap({ source: "imap", tally: { failed: 0 }, totalRefused: 2 }) === true &&
    [
      { tally: { failed: 1 } },
      { tally: { failed: 0 }, durableRetries: 1 },
      { tally: { failed: 0 }, retryableSkips: 1 },
      { tally: { failed: 0 }, coverageGaps: 1 },
    ].every((shape) => sourceReceiptHasRemoteGap({ source: "gmail", ...shape }) === true));

  let refusedReceiptValidations = 0;
  assert.throws(() => {
    refusedReceiptValidations++;
    validateBatchReceipt({ results: [{ source_id: null, status: "refused" }] }, [{
      envelope: { source_id: "message-001" },
    }]);
  }, /unknown source_id \(empty\)/);
  check("a transport-identity refusal cannot enter the Gmail withheld count",
    refusedReceiptValidations === 1);
}

{
  const result = runCase("unclassified");
  try {
    check("a late missing-label gap discards the entire incremental window",
      result.code === 1 && result.evidence.ingested_ids.length === 0 &&
      result.evidence.forget_targets.length === 0 && /(?:refused|partial) coverage/i.test(result.output),
      result.output.slice(-1_200));
    check("a late missing-label gap retains prior state and marks no eligible sibling done",
      result.state.history_id === "history-prior" &&
      result.state.done["gmail:unclassified"] === "history-prior-message" &&
      Object.hasOwn(result.state.removed || {}, "gmail:pending-removal") &&
      !Object.keys(result.state.done).some((key) => key.startsWith("gmail:eligible-")),
      JSON.stringify(result.state));
    check("an unclassified incremental message closes health as an opaque ingest error",
      result.state.history_id === "history-prior" && result.evidence.final_receipt?.status === "error" &&
      result.evidence.final_receipt?.issue_code === "INGEST_FAILED" &&
      !("error" in result.evidence.final_receipt) && !("detail" in result.evidence.final_receipt),
      JSON.stringify(result.evidence.final_receipt));
  } finally { rmSync(result.directory, { recursive: true, force: true }); }
}

{
  const result = runApprovedCase("credential-refusal");
  try {
    check("an incremental credential refusal still commits clean mail and removes the refused family",
      result.evidence.ingested_ids.join(",") === "credential-clean" &&
      result.evidence.forget_targets.includes("gmail:credential-refused") &&
      !("gmail:credential-refused" in result.state.done),
      `${result.output.slice(-1_200)}\n${JSON.stringify(result.evidence)}`);
    check("a credential refusal closes ready without freezing Gmail history",
      result.code === 0 && result.state.history_id === "history-current" &&
      result.evidence.final_receipt?.status === "ready" &&
      result.evidence.final_receipt?.docs_refused === 1 &&
      result.evidence.final_receipt?.docs_failed === 0 &&
      !("issue_code" in result.evidence.final_receipt) &&
      /; withheld_for_secrets=1$/.test(result.evidence.final_receipt?.detail || ""),
      `${result.output.slice(-1_200)}\n${JSON.stringify(result.evidence.final_receipt)}`);
    check("Gmail credential-refusal diagnostics never echo the synthetic credential",
      !result.output.includes(SYNTHETIC_OPENAI_KEY), result.output.slice(-1_200));
  } finally { rmSync(result.directory, { recursive: true, force: true }); }
}

{
  const result = runCase("worker-refusal");
  try {
    check("a Worker-refused envelope is withheld and closes ready",
      result.code === 0 && result.state.history_id === "history-current" &&
      result.evidence.ingested_ids.join(",") === "worker-refused" &&
      result.evidence.final_receipt?.status === "ready" &&
      result.evidence.final_receipt?.docs_refused === 1 &&
      result.evidence.final_receipt?.docs_failed === 0 &&
      !("issue_code" in result.evidence.final_receipt) &&
      /; withheld_for_secrets=1$/.test(result.evidence.final_receipt?.detail || "") &&
      !Object.hasOwn(result.state, "gmail_retry"),
      `${result.output.slice(-1_200)}\n${JSON.stringify(result.evidence.final_receipt)}`);
  } finally { rmSync(result.directory, { recursive: true, force: true }); }
}

{
  const first = runCase("recoverable-worker-failure");
  try {
    check("a recoverable Worker failure reaches the batch decision and advances Gmail history only with a durable retry",
      first.code === 1 &&
      first.evidence.batch_attempts?.["retry-failed"] === 1 &&
      first.evidence.batch_attempts?.["retry-clean"] === 1 &&
      first.state.history_id === "history-current" &&
      first.state.gmail_retry?.["gmail:retry-failed"] === "history-current" &&
      first.state.done["gmail:retry-clean"] === "history-current" &&
      !Object.hasOwn(first.state.done, "gmail:retry-failed") &&
      first.evidence.final_receipt?.status === "error" &&
      first.evidence.final_receipt?.docs_failed === 1,
      `${first.output.slice(-1_400)}\n${JSON.stringify(first.state)}\n${JSON.stringify(first.evidence)}`);

    const retry = runCase("recoverable-worker-failure", { directory: first.directory });
    check("the next incremental run retries the durable identity after an empty history window and converges",
      retry.code === 0 &&
      retry.evidence.batch_attempts?.["retry-failed"] === 2 &&
      retry.evidence.batch_attempts?.["retry-clean"] === 1 &&
      retry.evidence.ingested_ids.join(",") === "retry-failed,retry-clean,retry-failed" &&
      retry.state.history_id === "history-current" &&
      retry.state.done["gmail:retry-failed"] === "history-current" &&
      !Object.hasOwn(retry.state, "gmail_retry") &&
      retry.evidence.final_receipt?.status === "ready" &&
      retry.evidence.final_receipt?.docs_failed === 0,
      `${retry.output.slice(-1_400)}\n${JSON.stringify(retry.state)}\n${JSON.stringify(retry.evidence)}`);
  } finally { rmSync(first.directory, { recursive: true, force: true }); }
}

{
  const result = runCase("sweep-query-evidence");
  try {
    check("the default filtered full-sweep query supplies sufficient inbox policy evidence",
      result.code === 0 && result.evidence.ingested_ids.join(",") === "sweep-inbox",
      `${result.output.slice(-1_200)}\n${JSON.stringify(result.evidence)}`);
    check("query-proven mail without raw labelIds commits the full-sweep history cursor",
      result.state.history_id === "history-current" &&
      result.state.done["gmail:sweep-inbox"] === "history-current" &&
      result.evidence.final_receipt?.status === "ready",
      `${JSON.stringify(result.state)}\n${JSON.stringify(result.evidence.final_receipt)}`);
  } finally { rmSync(result.directory, { recursive: true, force: true }); }
}

{
  const result = runCase("policy-change-sweep");
  try {
    const currentPolicyFingerprint = gmailPolicyFingerprint({
      credentialScannerFingerprint: credentialScannerFingerprint(true),
    });
    check("a changed Gmail policy forces a complete query-bound sweep",
      result.code === 0 && result.evidence.ingested_ids.join(",") === "sweep-inbox" &&
      result.evidence.final_receipt?.lane === "sweep" &&
      result.evidence.final_receipt?.complete_sweep === true,
      `${result.output.slice(-1_200)}\n${JSON.stringify(result.evidence.final_receipt)}`);
    check("a completed Gmail policy sweep persists the current policy fingerprint",
      result.state.history_id === "history-current" &&
      result.state.gmail_policy_fingerprint === currentPolicyFingerprint,
      JSON.stringify(result.state));
  } finally { rmSync(result.directory, { recursive: true, force: true }); }
}

{
  const result = runCase("since-safe-sweep");
  try {
    check("a floor before the oldest stored Gmail message completes with zero removals",
      result.code === 0 && result.evidence.forget_targets.length === 0 &&
      result.state.done["gmail:since-oldest"] === "since-oldest-v1" &&
      result.state.history_id === "history-current" &&
      result.evidence.final_receipt?.complete_sweep === true,
      `${result.output.slice(-1_200)}\n${JSON.stringify(result.evidence)}`);
  } finally { rmSync(result.directory, { recursive: true, force: true }); }
}

{
  const review = runCase("since-removal-review");
  try {
    const approval = /--approve-removals ([0-9a-f]{64})/.exec(review.output)?.[1] || null;
    check("a later Gmail floor reaches the existing removal-review gate before any removal",
      review.code === 1 && !!approval && review.evidence.forget_targets.length === 0 &&
      review.state.history_id === "history-prior" &&
      /Gmail cleanup would remove 1 of 2 stored documents/.test(review.output),
      `${review.output.slice(-1_400)}\n${JSON.stringify(review.evidence)}`);
    if (approval) {
      const approved = runCase("since-removal-review", { directory: review.directory, approval });
      check("the exact reviewed floor plan removes only the pre-floor stored family",
        approved.code === 0 &&
        approved.evidence.forget_targets.join(",") === "gmail:since-older" &&
        !Object.hasOwn(approved.state.done, "gmail:since-older") &&
        approved.state.done["gmail:since-retained"] === "since-retained-v1" &&
        approved.state.history_id === "history-current",
        `${approved.output.slice(-1_400)}\n${JSON.stringify(approved.evidence)}`);
    }
  } finally { rmSync(review.directory, { recursive: true, force: true }); }
}

{
  const result = runCase("since-incremental");
  try {
    check("incremental Gmail applies the same date floor as the full-list query",
      result.code === 0 && result.evidence.ingested_ids.join(",") === "since-incremental-current" &&
      result.evidence.forget_targets.join(",") === "gmail:since-incremental-older" &&
      !Object.hasOwn(result.state.done, "gmail:since-incremental-older") &&
      result.state.history_id === "history-current" &&
      /policy_skipped=1; coverage_gaps=0/.test(result.evidence.final_receipt?.detail || ""),
      `${result.output.slice(-1_400)}\n${JSON.stringify(result.evidence)}`);
  } finally { rmSync(result.directory, { recursive: true, force: true }); }
}

{
  const result = runApprovedCase("scanner-v5");
  try {
    check("scanner v5 migration re-posts prior safe mail and forgets a newly sensitive family",
      result.evidence.ingested_ids.join(",") === "migration-safe" &&
      result.evidence.forget_targets.includes("gmail:migration-sensitive") &&
      result.state.done["gmail:migration-safe"] === "migration-safe-v1" &&
      !("gmail:migration-sensitive" in result.state.done),
      `${result.output.slice(-1_200)}\n${JSON.stringify(result.evidence)}`);
    check("scanner v5 migration commits Gmail history and replaces resumable progress with the v5 fingerprint",
      result.state.history_id === "history-current" &&
      result.state.credential_scanner_fingerprint === credentialScannerFingerprint(true, 5) &&
      !("credential_scanner_progress" in result.state),
      JSON.stringify(result.state));
    check("scanner migration diagnostics never echo the synthetic admin key",
      !result.output.includes(SYNTHETIC_ADMIN_KEY), result.output.slice(-1_200));
  } finally { rmSync(result.directory, { recursive: true, force: true }); }
}

{
  const review = runCase("scanner-v5-omitted");
  try {
    const approval = /--approve-removals ([0-9a-f]{64})/.exec(review.output)?.[1] || null;
    check("a stored Gmail family omitted from a full sweep requires exact cleanup review",
      review.code === 1 && review.state.history_id === "history-prior" &&
      review.state.credential_scanner_fingerprint === credentialScannerFingerprint(true, 4) &&
      review.evidence.forget_targets.length === 0 && !!approval &&
      /Gmail cleanup would remove 1 of 2 stored documents/.test(review.output),
      `${review.output.slice(-1_200)}\n${JSON.stringify(review.state)}\n${JSON.stringify(review.evidence)}`);
    if (approval) {
      const approved = runCase("scanner-v5-omitted", { approval, directory: review.directory });
      try {
        check("the approved omitted-family cleanup reads back before scanner v5 commits",
          approved.code === 0 && approved.state.history_id === "history-current" &&
          approved.state.credential_scanner_fingerprint === credentialScannerFingerprint(true, 5) &&
          !Object.hasOwn(approved.state.done, "gmail:migration-omitted") &&
          approved.evidence.forget_targets.includes("gmail:migration-omitted") &&
          approved.evidence.final_receipt?.status === "ready",
          `${approved.output.slice(-1_200)}\n${JSON.stringify(approved.state)}\n${JSON.stringify(approved.evidence)}`);
      } finally { /* review.directory is removed by the outer finally */ }
    }
  } finally { rmSync(review.directory, { recursive: true, force: true }); }
}

{
  const result = runCase("scanner-v5-progress-missing");
  try {
    check("a scanner-resume receipt cannot hide a Gmail family missing from authoritative D1",
      result.code === 0 && result.evidence.ingested_ids.join(",") === "migration-safe" &&
      result.state.done["gmail:migration-safe"] === "migration-safe-v1" &&
      result.state.credential_scanner_fingerprint === credentialScannerFingerprint(true, 5) &&
      !("credential_scanner_progress" in result.state),
      `${result.output.slice(-1_200)}\n${JSON.stringify(result.state)}\n${JSON.stringify(result.evidence)}`);
  } finally { rmSync(result.directory, { recursive: true, force: true }); }
}

{
  const result = runCase("scanner-v5-retained-untracked");
  try {
    check("scanner v5 cannot certify a retained Brain family missing from local resume state",
      result.code === 1 &&
      result.state.credential_scanner_fingerprint === credentialScannerFingerprint(true, 4) &&
      result.state.credential_scanner_progress?.fingerprint === credentialScannerFingerprint(true, 5) &&
      result.state.skipped["gmail:migration-unreadable"] === "the message had no content" &&
      result.evidence.forget_targets.every((uid) => uid !== "gmail:migration-unreadable") &&
      result.evidence.final_receipt?.issue_code === "INGEST_FAILED",
      `${result.output.slice(-1_200)}\n${JSON.stringify(result.state)}\n${JSON.stringify(result.evidence)}`);
  } finally { rmSync(result.directory, { recursive: true, force: true }); }
}

{
  const result = runCase("deleted");
  try {
    check("a typed Gmail deletion removes the prior family and advances only after readback",
      result.code === 0 && result.evidence.forget_targets.join(",") === "gmail:gone" &&
      !Object.hasOwn(result.state.done, "gmail:gone") &&
      result.state.history_id === "history-current" && result.evidence.final_receipt?.status === "ready",
      `${result.output.slice(-1_200)}\n${JSON.stringify(result.state)}\n${JSON.stringify(result.evidence)}`);
  } finally { rmSync(result.directory, { recursive: true, force: true }); }
}

{
  const result = runCase("relabeled");
  try {
    check("moving prior mail into an excluded category removes it as deliberate policy",
      result.code === 0 && result.evidence.forget_targets.join(",") === "gmail:relabelled" &&
      result.state.history_id === "history-current" &&
      /policy_skipped=1; coverage_gaps=0/.test(result.evidence.final_receipt?.detail || ""),
      `${result.output.slice(-1_200)}\n${JSON.stringify(result.state)}\n${JSON.stringify(result.evidence)}`);
  } finally { rmSync(result.directory, { recursive: true, force: true }); }
}

{
  const result = runCase("pending-restored");
  try {
    check("an active accepted Gmail message cancels its stale pending removal",
      result.code === 0 && result.evidence.forget_targets.length === 0 &&
      !Object.hasOwn(result.state.removed || {}, "gmail:pending-restored") &&
      result.state.done["gmail:pending-restored"] === "history-current" &&
      result.state.history_id === "history-current",
      `${result.output.slice(-1_200)}\n${JSON.stringify(result.state)}\n${JSON.stringify(result.evidence)}`);
  } finally { rmSync(result.directory, { recursive: true, force: true }); }
}

{
  const first = runCase("pending-retained");
  try {
    check("an active unreadable Gmail message retains an ambiguous pending deletion and holds the cursor",
      first.code === 1 && first.evidence.forget_targets.length === 0 &&
      Object.hasOwn(first.state.removed || {}, "gmail:pending-retained") &&
      first.state.done["gmail:pending-retained"] === "pending-retained-v1" &&
      first.state.history_id === "history-prior" &&
      /active message\(s\) had unresolved pending removals/i.test(first.output),
      `${first.output.slice(-1_200)}\n${JSON.stringify(first.state)}\n${JSON.stringify(first.evidence)}`);
    const retry = runCase("pending-retained", { directory: first.directory });
    check("the retry preserves the prior family and cannot lose a still-required security removal",
      retry.code === 1 && retry.evidence.forget_targets.length === 0 &&
      Object.hasOwn(retry.state.removed || {}, "gmail:pending-retained") &&
      retry.state.done["gmail:pending-retained"] === "pending-retained-v1" &&
      retry.state.history_id === "history-prior",
      `${retry.output.slice(-1_200)}\n${JSON.stringify(retry.state)}\n${JSON.stringify(retry.evidence)}`);
  } finally { rmSync(first.directory, { recursive: true, force: true }); }
}

{
  const first = runCase("pending-absent-unreadable");
  try {
    check("authenticated D1 absence settles an unreadable active Gmail pending marker",
      first.code === 1 && first.evidence.forget_targets.length === 0 &&
      first.state.history_id === "history-current" &&
      !Object.hasOwn(first.state.removed || {}, "gmail:pending-absent-unreadable") &&
      !Object.hasOwn(first.state.done || {}, "gmail:pending-absent-unreadable") &&
      /(?:partial|refused) coverage/i.test(first.output),
      `${first.output.slice(-1_300)}\n${JSON.stringify(first.state)}\n${JSON.stringify(first.evidence)}`);

    const retry = runCase("pending-absent-unreadable", { directory: first.directory });
    check("the settled absent Gmail pending marker cannot wedge the next empty history window",
      retry.code === 0 && retry.evidence.forget_targets.length === 0 &&
      retry.state.history_id === "history-current" &&
      !Object.hasOwn(retry.state.removed || {}, "gmail:pending-absent-unreadable"),
      `${retry.output.slice(-1_300)}\n${JSON.stringify(retry.state)}\n${JSON.stringify(retry.evidence)}`);
  } finally { rmSync(first.directory, { recursive: true, force: true }); }
}

{
  const result = runCase("readback-stale");
  try {
    check("a success-shaped Gmail deletion cannot advance past a family still present on readback",
      result.code === 1 && result.evidence.forget_targets.join(",") === "gmail:gone" &&
      result.state.history_id === "history-prior" &&
      Object.hasOwn(result.state.removed || {}, "gmail:gone") &&
      result.evidence.final_receipt?.status === "error" &&
      /remained after exact source-inventory readback/i.test(result.output),
      `${result.output.slice(-1_200)}\n${JSON.stringify(result.state)}\n${JSON.stringify(result.evidence)}`);
    const retry = runCase("readback-stale", { directory: result.directory });
    check("a transient readback failure does not turn the same typed Gmail deletion into a manual-review wedge",
      retry.code === 1 && retry.state.history_id === "history-prior" &&
      retry.evidence.forget_targets.filter((uid) => uid === "gmail:gone").length === 2 &&
      !/--approve-removals [0-9a-f]{64}/.test(retry.output) &&
      /remained after exact source-inventory readback/i.test(retry.output),
      `${retry.output.slice(-1_300)}\n${JSON.stringify(retry.state)}\n${JSON.stringify(retry.evidence)}`);
  } finally { rmSync(result.directory, { recursive: true, force: true }); }
}

{
  const first = runCase("pending-readback-failure");
  try {
    check("a failed Gmail removal readback retains a pending-only retry",
      first.code === 1 &&
      first.evidence.forget_targets.join(",") === "gmail:pending-readback" &&
      first.state.history_id === "history-prior" &&
      Object.hasOwn(first.state.removed || {}, "gmail:pending-readback") &&
      /ECONNRESET|NETWORK_UNREACHABLE/i.test(first.output),
      `${first.output.slice(-1_300)}\n${JSON.stringify(first.state)}\n${JSON.stringify(first.evidence)}`);

    const retry = runCase("pending-readback-failure", { directory: first.directory });
    check("an empty history retry reissues the preserved Gmail removal and converges",
      retry.code === 0 &&
      retry.evidence.forget_targets.filter((uid) => uid === "gmail:pending-readback").length === 2 &&
      retry.state.history_id === "history-current" &&
      !Object.hasOwn(retry.state.removed || {}, "gmail:pending-readback") &&
      !Object.hasOwn(retry.state.done || {}, "gmail:pending-readback"),
      `${retry.output.slice(-1_300)}\n${JSON.stringify(retry.state)}\n${JSON.stringify(retry.evidence)}`);
  } finally { rmSync(first.directory, { recursive: true, force: true }); }
}

{
  const result = runCase("scanner-v5-mass-refusal");
  try {
    check("a scanner change cannot remove an unbounded Gmail set without exact review",
      result.code === 1 && result.evidence.forget_targets.length === 0 &&
      result.state.history_id === "history-prior" &&
      result.state.credential_scanner_fingerprint === credentialScannerFingerprint(true, 4) &&
      /Gmail cleanup would remove 101 of 101 stored documents/.test(result.output) &&
      /--approve-removals [0-9a-f]{64}/.test(result.output),
      `${result.output.slice(-1_400)}\n${JSON.stringify(result.evidence)}`);
  } finally { rmSync(result.directory, { recursive: true, force: true }); }
}

{
  const result = runCase("scanner-v5-dilution-guard");
  try {
    const approval = /--approve-removals ([0-9a-f]{64})/.exec(result.output)?.[1] || null;
    check("newly ingested mail cannot dilute review of the entire prior Gmail corpus",
      result.code === 1 && result.evidence.ingested_ids.length === 901 &&
      result.evidence.forget_targets.length === 0 &&
      result.state.history_id === "history-prior" &&
      /Gmail cleanup would remove 100 of 100 stored documents/.test(result.output) &&
      !!approval,
      `${result.output.slice(-1_400)}\n${JSON.stringify(result.evidence.final_receipt)}`);
    if (approval) {
      const retry = runCase("scanner-v5-dilution-guard", { directory: result.directory });
      const retryApproval = /--approve-removals ([0-9a-f]{64})/.exec(retry.output)?.[1] || null;
      check("a persisted retry keeps the original Gmail removal denominator and approval fingerprint",
        retry.code === 1 && retryApproval === approval &&
        retry.evidence.ingested_ids.length === 901 && retry.evidence.forget_targets.length === 0 &&
        /Gmail cleanup would remove 100 of 100 stored documents/.test(retry.output),
        `${retry.output.slice(-1_400)}\n${JSON.stringify(retry.state)}`);
      const approved = runCase("scanner-v5-dilution-guard", {
        directory: result.directory,
        approval,
      });
      check("the persisted exact approval removes only the reviewed prior Gmail corpus",
        approved.code === 0 && approved.evidence.ingested_ids.length === 901 &&
        approved.evidence.forget_targets.length === 100 &&
        approved.state.history_id === "history-current" &&
        approved.state.credential_scanner_fingerprint === credentialScannerFingerprint(true, 5) &&
        !("gmail_removal_safety_baseline" in approved.state),
        `${approved.output.slice(-1_400)}\n${JSON.stringify(approved.state)}`);
    }
  } finally { rmSync(result.directory, { recursive: true, force: true }); }
}

{
  const first = runCase("scanner-v5-dilution-guard", { reset: true });
  try {
    const approval = /--approve-removals ([0-9a-f]{64})/.exec(first.output)?.[1] || null;
    const retry = runCase("scanner-v5-dilution-guard", {
      directory: first.directory,
      reset: true,
    });
    const retryApproval = /--approve-removals ([0-9a-f]{64})/.exec(retry.output)?.[1] || null;
    check("repeating --reset cannot discard Gmail's reviewed denominator or bypass exact approval",
      first.code === 1 && retry.code === 1 && !!approval && retryApproval === approval &&
      retry.evidence.forget_targets.length === 0 &&
      /Gmail cleanup would remove 100 of 100 stored documents/.test(retry.output),
      `${retry.output.slice(-1_400)}\n${JSON.stringify(retry.state)}`);
  } finally { rmSync(first.directory, { recursive: true, force: true }); }
}

{
  const first = runCase("scanner-v5-dilution-guard");
  try {
    const approval = /--approve-removals ([0-9a-f]{64})/.exec(first.output)?.[1] || null;
    const statePath = join(first.directory, ".brain-ingest-gmail.json");
    const upgradedState = JSON.parse(readFileSync(statePath, "utf8"));
    // A deployed scanner or Gmail-policy upgrade changes the live baseline key
    // between runs. The stopped plan still owns its original denominator until
    // a complete run commits, even though the new policy may change its digest.
    upgradedState.gmail_removal_safety_baseline.key = JSON.stringify({
      policy_fingerprint: "superseded-gmail-policy",
    });
    writeFileSync(statePath, JSON.stringify(upgradedState), { mode: 0o600 });

    const retry = runCase("scanner-v5-dilution-guard", { directory: first.directory });
    const retryApproval = /--approve-removals ([0-9a-f]{64})/.exec(retry.output)?.[1] || null;
    check("a policy or scanner upgrade cannot dilute a stopped Gmail removal baseline",
      first.code === 1 && !!approval && retry.code === 1 && retryApproval === approval &&
      retry.evidence.forget_targets.length === 0 &&
      retry.state.gmail_removal_safety_baseline?.stored === 100 &&
      /Gmail cleanup would remove 100 of 100 stored documents/.test(retry.output),
      `${retry.output.slice(-1_400)}\n${JSON.stringify(retry.state)}`);
  } finally { rmSync(first.directory, { recursive: true, force: true }); }
}

{
  const result = runCase("sweep-marker-missing");
  try {
    check("a full Gmail sweep without a pre-walk history marker saves work but cannot claim completion",
      result.code === 1 && result.evidence.ingested_ids.join(",") === "sweep-inbox" &&
      !("history_id" in result.state) && result.evidence.final_receipt?.status === "error" &&
      result.evidence.final_receipt?.issue_code === "INGEST_FAILED" &&
      result.evidence.final_receipt?.docs_failed === 0 &&
      result.evidence.final_receipt?.failure_evidence?.operation_class === "gmail_profile_read",
      `${result.output.slice(-1_200)}\n${JSON.stringify(result.state)}\n${JSON.stringify(result.evidence)}`);
  } finally { rmSync(result.directory, { recursive: true, force: true }); }
}

{
  const result = runCase("resume-precondition-failure");
  try {
    const receipt = result.evidence.final_receipt;
    check("a mid-walk Gmail provider failure preserves the last accepted batch and withholds the history cursor",
      result.code === 1 && result.evidence.ingested_ids.length === 50 &&
      Object.keys(result.state.done).length === 55 && Object.keys(result.state.skipped).length === 3 &&
      !Object.hasOwn(result.state, "history_id"),
      `${result.output.slice(-1_200)}\n${JSON.stringify(result.state)}`);
    check("the error receipt records closed provider and checkpoint proof from an exact state-file readback",
      receipt?.status === "error" && receipt?.issue_code === "INGEST_FAILED" &&
      receipt?.walk_complete === false && receipt?.files_seen === 52 &&
      receipt?.docs_added === 50 && receipt?.docs_updated === 0 &&
      receipt?.docs_unchanged === 0 && receipt?.docs_refused === 0 && receipt?.docs_failed === 1 &&
      JSON.stringify(receipt?.failure_evidence) === JSON.stringify({
        version: 1,
        operation_class: "gmail_message_read",
        http_status: 400,
        provider_reason: "failed_precondition",
        checkpoint_readback: "verified",
        checkpoint_done: 55,
        checkpoint_skipped: 3,
        cursor_preservation: "absent_preserved",
      }),
      JSON.stringify(receipt));
    check("the durable Gmail fixture evidence contains no provider message, remote path, or token",
      !JSON.stringify(result.evidence).includes("SYNTHETIC_PRIVATE_PROVIDER_SENTINEL") &&
      !JSON.stringify(result.evidence).includes("fixture-secret") &&
      !JSON.stringify(receipt).includes("checkpoint-provider-failure"),
      JSON.stringify(result.evidence));
  } finally { rmSync(result.directory, { recursive: true, force: true }); }
}

{
  const result = runCase("incremental-precondition-failure");
  try {
    const receipt = result.evidence.final_receipt;
    const evidence = receipt?.failure_evidence;
    check("an incremental Gmail provider failure preserves the exact prior history cursor",
      result.code === 1 && result.state.history_id === "history-prior" &&
      receipt?.files_seen === 1 && receipt?.docs_failed === 1 &&
      evidence?.operation_class === "gmail_message_read" &&
      evidence?.checkpoint_done === 5 && evidence?.checkpoint_skipped === 3 &&
      evidence?.cursor_preservation === "present_preserved",
      `${result.output.slice(-1_200)}\n${JSON.stringify(result.evidence.final_receipt)}`);
  } finally { rmSync(result.directory, { recursive: true, force: true }); }
}

console.log(`\ngmail incremental policy: all ${ran} checks passed`);
