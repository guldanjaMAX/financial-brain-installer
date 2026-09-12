#!/usr/bin/env node
/**
 * Build a deterministic, synthetic-only Windows onboarding rehearsal handoff.
 *
 * The archive contains instructions and a manifest, never executable source or
 * customer material. The recipient still obtains a fresh detached checkout and
 * runs the checked-in launcher, preserving its Git, SHA, cleanliness, Windows,
 * and non-administrator checks.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPlanEnvironment,
  makeOutputDirectory,
  readSourceIdentity,
} from "./field-prepare.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPOSITORY_URL = "https://github.com/guldanjaMAX/financial-brain-installer";
export const REPOSITORY_SLUG = "guldanjaMAX/financial-brain-installer";
export const REPOSITORY_GH_TARGET = `github.com/${REPOSITORY_SLUG}`;
export const ARTIFACT_KIND = "financial_brain_windows_onboarding_rehearsal";
export const PURPOSE = "synthetic_local_owner_experience_only";
export const LOOPBACK_ORIGIN = "http://127.0.0.1:4176";
export const LAUNCHER_PATH = "onboarding/start-windows-rehearsal.ps1";
export const REQUIRED_CI_JOBS = Object.freeze([
  "public git history zero findings",
  "build one exact package",
  "preflight-traps",
  "windows-latest / node 22",
  "windows-latest / node 24",
  "macos-latest / node 22",
  "macos-latest / node 24",
  "ubuntu-latest / node 22",
  "ubuntu-latest / node 24",
]);
const FIXED_ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0, 0);
const READY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function createKitCommandEnvironment(source = process.env) {
  const environment = createPlanEnvironment(source);
  // gh needs a non-secret locator for authentication already stored by the
  // operating system. Preserve only those config-directory paths; never pass a
  // token or the rest of the desktop environment into either git or gh.
  for (const name of [
    "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "GH_CONFIG_DIR", "XDG_CONFIG_HOME",
  ]) {
    if (typeof source[name] === "string" && source[name]) environment[name] = source[name];
  }
  return environment;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function refusal(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeCode(error) {
  return String(error?.code || error?.message || "windows_onboarding_kit_failed")
    .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 96);
}

export function parseWindowsOnboardingKitArgs(argv) {
  const options = {
    mode: null,
    expectSha: null,
    output: null,
    ciRunId: null,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--plan") {
      if (options.mode) throw refusal("choose_exactly_one_mode");
      options.mode = "plan";
    } else if (value === "--draft") {
      if (options.mode) throw refusal("choose_exactly_one_mode");
      options.mode = "draft";
    } else if (value === "--json") options.json = true;
    else if (value === "--help") options.help = true;
    else if (["--expect-sha", "--output", "--ci-run"].includes(value)) {
      const next = argv[++index];
      if (!next || next.startsWith("--")) throw refusal(`${value.slice(2).replace(/-/g, "_")}_required`);
      if (value === "--expect-sha") options.expectSha = next;
      if (value === "--output") options.output = next;
      if (value === "--ci-run") {
        if (options.mode) throw refusal("choose_exactly_one_mode");
        options.mode = "seal";
        options.ciRunId = next;
      }
    } else throw refusal("unknown_option");
  }
  if (options.help) return Object.freeze(options);
  if (!options.mode) throw refusal("mode_required");
  if (!/^[0-9a-f]{40}$/.test(String(options.expectSha || ""))) throw refusal("expect_sha_invalid");
  if (options.mode === "plan") {
    if (options.output || options.ciRunId) throw refusal("plan_must_not_name_output_or_ci");
  } else if (!options.output) throw refusal("output_required");
  if (options.mode !== "plan" && options.json) throw refusal("json_is_plan_only");
  if (options.mode === "seal" && !/^[1-9][0-9]*$/.test(String(options.ciRunId))) {
    throw refusal("ci_run_invalid");
  }
  return Object.freeze(options);
}

export function normalizeRepositoryUrl(value) {
  const raw = String(value || "").trim().replace(/\.git$/i, "");
  const ssh = raw.match(/^git@github\.com:([^/]+\/[^/]+)$/i)
    || raw.match(/^ssh:\/\/git@github\.com\/([^/]+\/[^/]+)$/i);
  const https = raw.match(/^https:\/\/github\.com\/([^/]+\/[^/?#]+)$/i);
  const slug = (ssh?.[1] || https?.[1] || "").toLowerCase();
  if (slug !== REPOSITORY_SLUG.toLowerCase()) throw refusal("repository_origin_mismatch");
  return REPOSITORY_URL;
}

function commandSucceeded(result) {
  return !result?.error && (result?.status === 0 || result?.ok === true);
}

function runJson(commandRunner, args, label, environment) {
  const result = commandRunner("gh", args, {
    cwd: ROOT,
    env: environment,
    encoding: "utf8",
    shell: false,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (!commandSucceeded(result)) throw refusal(`${label}_unavailable`);
  try { return JSON.parse(String(result.stdout || "")); }
  catch { throw refusal(`${label}_invalid_json`); }
}

function jobReceipt(job) {
  return Object.freeze({
    name: job.name,
    database_id: String(job.databaseId || job.database_id || ""),
    conclusion: job.conclusion,
    url: job.url,
  });
}

export function validateCiRun(run, artifactsResponse, {
  expectedSha,
  version,
  ciRunId,
  now = new Date(),
}) {
  if (String(run?.databaseId) !== String(ciRunId)) throw refusal("ci_run_id_mismatch");
  if (run?.workflowName !== "ci") throw refusal("ci_workflow_mismatch");
  // pull_request runs may report the branch head SHA while checkout tests the
  // synthetic merge SHA. Only a push run proves that this exact source commit
  // produced the package and all required job results named below.
  if (run?.event !== "push") throw refusal("ci_event_mismatch");
  if (run?.headSha !== expectedSha) throw refusal("ci_head_sha_mismatch");
  if (run?.status !== "completed" || run?.conclusion !== "success") {
    throw refusal("ci_run_not_successful");
  }
  const expectedRunUrl = `${REPOSITORY_URL}/actions/runs/${ciRunId}`;
  if (run?.url !== expectedRunUrl) throw refusal("ci_run_url_mismatch");
  if (!Number.isInteger(Number(run?.attempt)) || Number(run.attempt) < 1) {
    throw refusal("ci_attempt_missing");
  }
  const jobs = Array.isArray(run?.jobs) ? run.jobs : [];
  const requiredJobs = REQUIRED_CI_JOBS.map((name) => {
    const matches = jobs.filter((job) => job?.name === name);
    if (matches.length !== 1) throw refusal(matches.length ? "ci_required_job_duplicated" : "ci_required_job_missing");
    const job = matches[0];
    if (job.status !== "completed" || job.conclusion !== "success") {
      throw refusal("ci_required_job_not_successful");
    }
    if (!/^[1-9][0-9]*$/.test(String(job.databaseId || ""))) throw refusal("ci_job_id_missing");
    if (typeof job.url !== "string" || !job.url.startsWith(`${REPOSITORY_URL}/actions/runs/${ciRunId}/job/`)) {
      throw refusal("ci_job_url_mismatch");
    }
    return jobReceipt(job);
  });

  const artifacts = Array.isArray(artifactsResponse?.artifacts) ? artifactsResponse.artifacts : [];
  if (Number(artifactsResponse?.total_count) !== artifacts.length) throw refusal("ci_artifact_page_incomplete");
  const expectedPackageName = `brain-installer-${version}.tgz`;
  const matching = artifacts.filter((artifact) => artifact?.name === expectedPackageName);
  if (matching.length !== 1) throw refusal(matching.length ? "ci_package_artifact_duplicated" : "ci_package_artifact_missing");
  const artifact = matching[0];
  if (artifact.expired !== false) throw refusal("ci_package_artifact_expired");
  const digest = String(artifact.digest || "");
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw refusal("ci_package_digest_missing");
  if (!Number.isInteger(Number(artifact.id)) || Number(artifact.id) < 1) throw refusal("ci_package_artifact_id_missing");
  if (!Number.isInteger(Number(artifact.size_in_bytes)) || Number(artifact.size_in_bytes) < 1) {
    throw refusal("ci_package_size_missing");
  }
  if (artifact.workflow_run?.id != null && String(artifact.workflow_run.id) !== String(ciRunId)) {
    throw refusal("ci_package_run_mismatch");
  }
  if (artifact.workflow_run?.head_sha != null && artifact.workflow_run.head_sha !== expectedSha) {
    throw refusal("ci_package_head_sha_mismatch");
  }
  const completedAt = new Date(run.updatedAt);
  if (!Number.isFinite(completedAt.getTime())) throw refusal("ci_completion_time_missing");
  const checkedAt = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(checkedAt.getTime())) throw refusal("current_time_invalid");
  if (completedAt.getTime() > checkedAt.getTime() + 5 * 60 * 1000) {
    throw refusal("ci_completion_time_in_future");
  }
  if (checkedAt.getTime() > completedAt.getTime() + READY_WINDOW_MS) {
    throw refusal("ci_run_stale");
  }
  return Object.freeze({
    run_id: String(ciRunId),
    attempt: Number(run.attempt),
    workflow: "ci",
    event: "push",
    head_sha: expectedSha,
    status: "completed",
    conclusion: "success",
    url: expectedRunUrl,
    completed_at: completedAt.toISOString(),
    required_jobs: Object.freeze(requiredJobs),
    package: Object.freeze({
      artifact_id: String(artifact.id),
      filename: expectedPackageName,
      sha256: digest.slice("sha256:".length),
      digest_scope: "github_actions_raw_file_artifact",
      raw_package_equivalence_proof: "successful exact-package job verified the archive:false upload digest against the locally hashed package",
      github_artifact_api_size_bytes: Number(artifact.size_in_bytes),
      expired: false,
      used_by_rehearsal: false,
    }),
  });
}

export function loadCiEvidence({ ciRunId, expectedSha, version }, {
  commandRunner = spawnSync,
  environment = createKitCommandEnvironment(process.env),
  clock = () => new Date(),
} = {}) {
  const run = runJson(commandRunner, [
    "run", "view", String(ciRunId), "--repo", REPOSITORY_GH_TARGET,
    "--json", "databaseId,attempt,event,headSha,status,conclusion,url,workflowName,updatedAt,jobs",
  ], "ci_run", environment);
  const artifacts = runJson(commandRunner, [
    "api", "--hostname", "github.com",
    `repos/${REPOSITORY_SLUG}/actions/runs/${ciRunId}/artifacts?per_page=100`,
  ], "ci_artifacts", environment);
  return validateCiRun(run, artifacts, {
    expectedSha, version, ciRunId, now: clock(),
  });
}

function readRepositoryUrl(commandRunner, environment) {
  const result = commandRunner("git", [
    "-c", "core.fsmonitor=false", "config", "--get", "remote.origin.url",
  ], { cwd: ROOT, env: environment, encoding: "utf8", shell: false });
  if (!commandSucceeded(result)) throw refusal("repository_origin_unavailable");
  const lines = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw refusal("repository_origin_ambiguous");
  return normalizeRepositoryUrl(lines[0]);
}

export function collectCandidate(expectSha, {
  identityReader = readSourceIdentity,
  commandRunner = spawnSync,
  environment = createKitCommandEnvironment(process.env),
  fileReader = readFileSync,
  repositoryReader = readRepositoryUrl,
} = {}) {
  const source = identityReader(expectSha, environment);
  const repositoryUrl = repositoryReader(commandRunner, environment);
  const launcher = Buffer.from(fileReader(join(ROOT, LAUNCHER_PATH)));
  if (!launcher.length) throw refusal("launcher_missing");
  return Object.freeze({
    repository_url: repositoryUrl,
    head_sha: source.head_sha,
    tree_sha: source.tree_sha,
    package_name: source.package_name,
    package_version: source.package_version,
    package_json_sha256: source.package_json_sha256,
    package_lock_sha256: source.package_lock_sha256,
    launcher: Object.freeze({
      path: LAUNCHER_PATH,
      bytes: launcher.length,
      sha256: sha256(launcher),
    }),
  });
}

export function renderShareableInstructions(candidate, ci) {
  const expiry = ci ? new Date(new Date(ci.completed_at).getTime() + READY_WINDOW_MS).toISOString() : null;
  return `Financial Brain Windows onboarding rehearsal\n\n` +
    `PURPOSE: ${PURPOSE}\n` +
    `This is a local synthetic owner-experience rehearsal. It is not an install and is not permission to use a live account or customer data.\n\n` +
    `Give this complete file and the release.json kept beside its ZIP to Claude Code. Claude Code should perform the checks and commands below; the owner should only need to answer questions, review the synthetic screens, and click when guided.\n\n` +
    `Before starting\n` +
    `1. Keep release.json beside the downloaded ZIP. Continue only when its artifact_kind is ${ARTIFACT_KIND}, ready_to_send is true, ready_for_live_accounts is false, its filename, byte count, and SHA-256 match the ZIP, its successful CI event is push for exact source SHA ${candidate.head_sha}, and valid_until has not passed.\n` +
    `2. Use Claude Code launched from a normal PowerShell window opened from the Windows Start menu. Do not use an embedded app terminal and do not choose Run as administrator.\n` +
    `3. Start in a new empty folder. Clone only ${candidate.repository_url}, then check out ${candidate.head_sha} in detached-HEAD mode. Do not reuse an older clone or switch to main.\n` +
    `4. Confirm the checkout is clean and the checked-in launcher ${candidate.launcher.path} has SHA-256 ${candidate.launcher.sha256}. The launcher digest in release.json describes this file in the reviewed checkout; the launcher is not an entry inside the ZIP.\n\n` +
    `From the top-level folder of that exact checkout, run this one line, replacing nothing:\n\n` +
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\\onboarding\\start-windows-rehearsal.ps1" -ExpectedSha "${candidate.head_sha}"\n\n` +
    `Do not paste or reconstruct the PowerShell script body. Do not run npm install, npm ci, or another npm command yourself; the checked-in launcher handles the local UI preparation it needs.\n\n` +
    `Do not run setup, provision, deploy, update, connect, ingest, OCR, repair, reindex, drain, forget, zone, grant, invite, or any live Cloudflare or provider command. Do not enter a token, password, authentication code, billing approval, consent, or real passkey. Stop at the first refusal or mismatch.\n\n` +
    `When the browser opens, remind the owner that every record is invented. Guide them through one synthetic screen at a time and ask what feels clear, confusing, too technical, or surprising. Pay special attention to the first passkey explanation, healthy-empty versus unavailable wording, partial data, conflicts, retries, guest access, and the Owner Financial Map review. If the browser closes, reopen ${LOOPBACK_ORIGIN}/ while the original PowerShell window remains open; do not rerun the launcher.\n\n` +
    `At the end, have the owner close the browser tab, return to the same PowerShell window, and press Control-C once. Then provide a short feedback note containing only: the exact commit SHA, Windows version, Node version, whether the browser opened automatically, which synthetic screens were reviewed, the three biggest points of confusion, what felt reassuring, and any step where the owner did not know what to click. Do not include the Windows username, local paths, account names, private data, credentials, or full environment output.\n\n` +
    `Expected local address: ${LOOPBACK_ORIGIN}/\n` +
    `CI evidence: ${ci ? ci.url : "not supplied; this draft is not ready to send"}\n` +
    `Valid until: ${expiry || "not applicable; this draft is not ready to send"}\n`;
}

function receiptCore(candidate, ci) {
  const ready = Boolean(ci);
  const validUntil = ci
    ? new Date(new Date(ci.completed_at).getTime() + READY_WINDOW_MS).toISOString()
    : null;
  return {
    schema_version: 1,
    artifact_kind: ARTIFACT_KIND,
    purpose: PURPOSE,
    status: ready ? "sealed_for_supervised_rehearsal" : "draft_not_ready",
    ready_to_send: ready,
    ready_for_live_accounts: false,
    physical_windows_execution: "pending",
    source: {
      repository_url: candidate.repository_url,
      head_sha: candidate.head_sha,
      tree_sha: candidate.tree_sha,
      package_name: candidate.package_name,
      package_version: candidate.package_version,
      package_json_sha256: candidate.package_json_sha256,
      package_lock_sha256: candidate.package_lock_sha256,
    },
    launcher: {
      ...candidate.launcher,
      digest_scope: "checked_in_file_in_reviewed_checkout",
      included_in_handoff_archive: false,
    },
    ci,
    tested_package: ci?.package || null,
    intended_loopback_origin: LOOPBACK_ORIGIN,
    valid_until: validUntil,
    stale_reuse_guards: {
      exact_expected_sha_required: true,
      fresh_detached_checkout_required: true,
      clean_checkout_required: true,
      source_identity_rechecked_before_output: true,
      content_addressed_archive_name: true,
      expires_after_ci_days: 7,
    },
    boundaries: {
      synthetic_data_only: true,
      customer_data_allowed: false,
      credentials_allowed: false,
      live_actions_allowed: false,
      cloudflare_contacted: false,
      provider_contacted: false,
      package_executed_by_rehearsal: false,
    },
  };
}

function assertCandidateUnchanged(opening, closing) {
  if (stableJson(opening) !== stableJson(closing)) {
    throw refusal("source_identity_changed_before_output");
  }
}

export async function buildKitArtifacts(candidate, ci = null, { zipLibrary = null } = {}) {
  // Keep --plan usable before npm has installed dependencies. The no-write
  // identity check returns before this production-only import is needed.
  const { strToU8, zipSync } = zipLibrary || await import("fflate");
  const instructions = renderShareableInstructions(candidate, ci);
  const innerManifest = {
    ...receiptCore(candidate, ci),
    files: {
      "RUN-WITH-CLAUDE-CODE.txt": {
        bytes: Buffer.byteLength(instructions),
        sha256: sha256(Buffer.from(instructions)),
      },
    },
  };
  const manifestBytes = Buffer.from(stableJson(innerManifest));
  const root = `financial-brain-v${candidate.package_version}-windows-onboarding-rehearsal-${candidate.head_sha.slice(0, 12)}`;
  const zipBytes = Buffer.from(zipSync({
    [`${root}/REHEARSAL-MANIFEST.json`]: [new Uint8Array(manifestBytes), { level: 9 }],
    [`${root}/RUN-WITH-CLAUDE-CODE.txt`]: [strToU8(instructions), { level: 9 }],
  }, { level: 9, mtime: FIXED_ZIP_MTIME }));
  const archiveSha256 = sha256(zipBytes);
  const archiveFilename = `${root}-${archiveSha256.slice(0, 16)}.zip`;
  const release = {
    ...receiptCore(candidate, ci),
    archive: {
      filename: archiveFilename,
      bytes: zipBytes.length,
      sha256: archiveSha256,
      entry_count: 2,
      fixed_zip_mtime: "1980-01-01T00:00:00",
    },
    inner_manifest: {
      path: `${root}/REHEARSAL-MANIFEST.json`,
      bytes: manifestBytes.length,
      sha256: sha256(manifestBytes),
    },
  };
  return Object.freeze({
    archiveFilename,
    archiveBytes: zipBytes,
    release,
    releaseBytes: Buffer.from(stableJson(release)),
    instructions,
    innerManifest,
  });
}

function privateWrite(path, bytes) {
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

export async function runWindowsOnboardingKit(options, dependencies = {}) {
  const commandEnvironment = dependencies.environment || createKitCommandEnvironment(process.env);
  const scopedDependencies = { ...dependencies, environment: commandEnvironment };
  const candidate = collectCandidate(options.expectSha, scopedDependencies);
  if (options.mode === "plan") {
    return Object.freeze({
      schema_version: 1,
      status: "plan_only",
      ready_to_send: false,
      output_created: false,
      source: candidate,
      required_ci_workflow: "ci",
      required_ci_jobs: REQUIRED_CI_JOBS,
      production_seal_requires_gh_run: true,
      boundaries: receiptCore(candidate, null).boundaries,
    });
  }
  const ci = options.mode === "seal"
    ? loadCiEvidence({
      ciRunId: options.ciRunId,
      expectedSha: candidate.head_sha,
      version: candidate.package_version,
    }, scopedDependencies)
    : null;
  const artifacts = await buildKitArtifacts(candidate, ci, dependencies);
  const closingCandidate = collectCandidate(options.expectSha, scopedDependencies);
  assertCandidateUnchanged(candidate, closingCandidate);
  const createOutput = dependencies.outputMaker || makeOutputDirectory;
  const write = dependencies.fileWriter || privateWrite;
  const output = createOutput(options.output);
  write(join(output, artifacts.archiveFilename), artifacts.archiveBytes);
  write(join(output, "release.json"), artifacts.releaseBytes);
  return Object.freeze({
    output,
    archivePath: join(output, artifacts.archiveFilename),
    receiptPath: join(output, "release.json"),
    release: artifacts.release,
  });
}

function help() {
  return `No-write exact-candidate plan:\n  node scripts/build-windows-onboarding-kit.mjs --plan --json --expect-sha <40-character-sha>\n\nDraft receipt and deterministic archive, never sendable:\n  npm run rehearsal:kit -- --draft --expect-sha <40-character-sha> --output <new-directory-outside-checkout>\n\nProduction seal from one verified GitHub Actions ci run:\n  npm run rehearsal:kit -- --ci-run <run-id> --expect-sha <40-character-sha> --output <new-directory-outside-checkout>`;
}

const IS_MAIN = (() => {
  try { return resolve(process.argv[1] || "") === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (IS_MAIN) {
  try {
    const options = parseWindowsOnboardingKitArgs(process.argv.slice(2));
    if (options.help) {
      console.log(help());
    } else {
      if (options.mode === "plan" && process.env.npm_lifecycle_event === "rehearsal:kit") {
        throw refusal("plan_requires_direct_node_entrypoint");
      }
      const result = await runWindowsOnboardingKit(options);
      if (options.mode === "plan") console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`Windows onboarding rehearsal kit: ${result.release.status}`);
        console.log(`Archive: ${result.archivePath}`);
        console.log(`Receipt: ${result.receiptPath}`);
      }
    }
  } catch (error) {
    console.error(`Windows onboarding rehearsal kit refused: ${safeCode(error)}`);
    process.exitCode = 1;
  }
}
