import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { strFromU8, unzipSync } from "fflate";

import {
  ARTIFACT_KIND,
  ARTIFACT_SCHEMA_VERSION,
  INTENDED_ARCHITECTURE,
  LAUNCHER_PATH,
  LOOPBACK_ORIGIN,
  PURPOSE,
  REPOSITORY_GH_TARGET,
  REPOSITORY_SLUG,
  REPOSITORY_URL,
  REQUIRED_CI_JOBS,
  buildKitArtifacts,
  createKitCommandEnvironment,
  downloadRuntimeIdentityArtifact,
  loadCiEvidence,
  normalizeRepositoryUrl,
  parseWindowsOnboardingKitArgs,
  runWindowsOnboardingKit,
  validateCiRun,
} from "../scripts/build-windows-onboarding-kit.mjs";
import {
  createRuntimeIdentityReceipt,
  runtimeIdentityArtifactName,
  runtimeIdentityReceiptBytes,
} from "../scripts/runtime-identity-receipt.mjs";

const SHA = "a".repeat(40);
const TREE = "b".repeat(40);
const RUN_ID = "456789";
const VERSION = "0.4.8";
const PACKAGE_SHA = "c".repeat(64);
const RUNTIME_SHA = "9".repeat(64);
const PACKAGE_BYTES = 123456;
const PACKAGE_FILE_COUNT = 678;
const IDENTITY_SCHEME = "brain.runtime-payload.sha256.v1";
const LAUNCHER_BYTES = Buffer.from("# reviewed synthetic launcher fixture\r\n");
const CHECKED_AT = new Date("2026-09-12T19:00:00.000Z");

function sourceIdentity(headSha = SHA) {
  return {
    head_sha: headSha,
    tree_sha: TREE,
    package_name: "brain-installer",
    package_version: VERSION,
    package_json_sha256: "d".repeat(64),
    package_lock_sha256: "e".repeat(64),
    package_alignment: { aligned: true },
    working_tree_clean: true,
    shallow_repository: false,
    diff_check_clean: true,
    identity_stable_during_check: true,
  };
}

function candidate() {
  return {
    repository_url: REPOSITORY_URL,
    head_sha: SHA,
    tree_sha: TREE,
    package_name: "brain-installer",
    package_version: VERSION,
    package_json_sha256: "d".repeat(64),
    package_lock_sha256: "e".repeat(64),
    launcher: {
      path: LAUNCHER_PATH,
      bytes: LAUNCHER_BYTES.length,
      sha256: "f".repeat(64),
    },
  };
}

function ciRun({
  headSha = SHA,
  conclusion = "success",
  status = "completed",
  jobs = null,
} = {}) {
  return {
    databaseId: Number(RUN_ID),
    attempt: 1,
    workflowName: "ci",
    event: "push",
    headSha,
    conclusion,
    status,
    url: `${REPOSITORY_URL}/actions/runs/${RUN_ID}`,
    updatedAt: "2026-09-12T18:00:00.000Z",
    jobs: jobs || REQUIRED_CI_JOBS.map((name, index) => ({
      name,
      databaseId: 7000 + index,
      status: "completed",
      conclusion: "success",
      url: `${REPOSITORY_URL}/actions/runs/${RUN_ID}/job/${7000 + index}`,
    })),
  };
}

function runtimeIdentityBytes() {
  return runtimeIdentityReceiptBytes(createRuntimeIdentityReceipt({
    sourceSha: SHA,
    packageFilename: `brain-installer-${VERSION}.tgz`,
    packageVersion: VERSION,
    packageBytes: PACKAGE_BYTES,
    packageFileCount: PACKAGE_FILE_COUNT,
    packageSha256: PACKAGE_SHA,
    identityScheme: IDENTITY_SCHEME,
    runtimePayloadSha256: RUNTIME_SHA,
  }));
}

function artifactResponse({ digest = `sha256:${PACKAGE_SHA}`, expired = false } = {}) {
  const identityBytes = runtimeIdentityBytes();
  return {
    total_count: 2,
    artifacts: [
      {
        id: 8100,
        name: `brain-installer-${VERSION}.tgz`,
        size_in_bytes: PACKAGE_BYTES,
        digest,
        expired,
        workflow_run: { id: Number(RUN_ID), head_sha: SHA },
      },
      {
        id: 8101,
        name: runtimeIdentityArtifactName(VERSION),
        size_in_bytes: identityBytes.length,
        digest: `sha256:${createHash("sha256").update(identityBytes).digest("hex")}`,
        expired,
        workflow_run: { id: Number(RUN_ID), head_sha: SHA },
      },
    ],
  };
}

function ciValidationOptions(extra = {}) {
  return {
    expectedSha: SHA,
    version: VERSION,
    ciRunId: RUN_ID,
    runtimeIdentityBytes: runtimeIdentityBytes(),
    now: CHECKED_AT,
    ...extra,
  };
}

function ciEvidence() {
  return validateCiRun(ciRun(), artifactResponse(), ciValidationOptions());
}

function dependencies(overrides = {}) {
  return {
    identityReader(expectedSha) {
      assert.equal(expectedSha, SHA);
      return sourceIdentity();
    },
    repositoryReader() {
      return REPOSITORY_URL;
    },
    fileReader(path) {
      assert.match(path, /onboarding[\\/]start-windows-rehearsal\.ps1$/);
      return LAUNCHER_BYTES;
    },
    identityArtifactReader() {
      return runtimeIdentityBytes();
    },
    ...overrides,
  };
}

test("argument modes keep planning, drafts, and production seals separate", () => {
  assert.deepEqual(
    parseWindowsOnboardingKitArgs(["--plan", "--json", "--expect-sha", SHA]).mode,
    "plan",
  );
  assert.deepEqual(
    parseWindowsOnboardingKitArgs(["--draft", "--expect-sha", SHA, "--output", "/outside/new"]).mode,
    "draft",
  );
  assert.deepEqual(
    parseWindowsOnboardingKitArgs(["--ci-run", RUN_ID, "--expect-sha", SHA, "--output", "/outside/new"]).mode,
    "seal",
  );
  assert.throws(() => parseWindowsOnboardingKitArgs(["--plan", "--expect-sha", SHA, "--output", "/tmp/x"]), /plan_must_not/);
  assert.throws(() => parseWindowsOnboardingKitArgs(["--draft", "--expect-sha", SHA]), /output_required/);
  assert.throws(() => parseWindowsOnboardingKitArgs(["--ci-json", "evidence.json", "--expect-sha", SHA]), /unknown_option/);
  assert.throws(() => parseWindowsOnboardingKitArgs(["--ci-run", "0", "--expect-sha", SHA, "--output", "/tmp/x"]), /ci_run_invalid/);
});

test("only the exact public repository origin is accepted", () => {
  assert.equal(normalizeRepositoryUrl(`${REPOSITORY_URL}.git`), REPOSITORY_URL);
  assert.equal(normalizeRepositoryUrl(`git@github.com:${REPOSITORY_SLUG}.git`), REPOSITORY_URL);
  assert.throws(() => normalizeRepositoryUrl("https://github.com/example/fork"), /repository_origin_mismatch/);
  assert.throws(() => normalizeRepositoryUrl("https://user@example.com/repository"), /repository_origin_mismatch/);
});

test("every worktree file hashed into the kit is pinned to LF on Windows", () => {
  const attributes = readFileSync(new URL("../.gitattributes", import.meta.url), "utf8");
  for (const path of ["package.json", "package-lock.json", LAUNCHER_PATH]) {
    assert.match(attributes, new RegExp(`^${path.replaceAll(".", "\\.")} text eol=lf$`, "m"));
    assert.equal(readFileSync(new URL(`../${path}`, import.meta.url)).includes(13), false);
  }
});

test("the installed technician skill routes this synthetic receipt before install checks", () => {
  const skill = readFileSync(new URL("../skills/financial-brain-technician/SKILL.md", import.meta.url), "utf8");
  const rehearsalRoute = skill.indexOf("## Route a sealed synthetic Windows rehearsal first");
  const installRoute = skill.indexOf("## Start here");
  assert.ok(rehearsalRoute >= 0 && rehearsalRoute < installRoute);
  assert.match(skill, new RegExp(ARTIFACT_KIND));
  assert.match(skill, /replaces \*\*Start\s+here\*\*/i);
  assert.match(skill, /do not run\s+`brain --version`, `brain tools`, the packaged preflight/i);
  assert.match(skill, /do not compare its digest to\s+an installed package/i);
  assert.match(skill, /Require schema version 3/i);
  assert.match(skill, /`intended_architecture: x64`/i);
  assert.match(skill, /x64 Node process emulated by Windows ARM64 does not\s+qualify/i);
  assert.match(skill, /Native Windows OS architecture: x64 confirmed/i);
  assert.match(skill, /Node process architecture: x64 confirmed/i);
  assert.match(skill, /`tested_package\.identity_scheme`/i);
  assert.match(skill, /`runtime_payload_sha256` to match\s+`update_preview\.expected_runtime_sha256`/i);
  assert.match(skill, /did not observe an\s+installed runtime or run update preview/i);
  assert.match(skill, /Never infer an install-kit contract from the filename\s+`release\.json` alone/i);
});

test("plan mode checks exact identity but creates no output and never calls GitHub", async () => {
  let outputCalls = 0;
  let writes = 0;
  let commands = 0;
  const result = await runWindowsOnboardingKit(
    parseWindowsOnboardingKitArgs(["--plan", "--json", "--expect-sha", SHA]),
    dependencies({
      outputMaker() { outputCalls += 1; throw new Error("must not create output"); },
      fileWriter() { writes += 1; throw new Error("must not write"); },
      commandRunner() { commands += 1; throw new Error("must not call gh"); },
    }),
  );
  assert.equal(result.status, "plan_only");
  assert.equal(result.schema_version, ARTIFACT_SCHEMA_VERSION);
  assert.equal(result.intended_architecture, INTENDED_ARCHITECTURE);
  assert.equal(result.ready_to_send, false);
  assert.equal(result.output_created, false);
  assert.equal(result.source.head_sha, SHA);
  assert.equal(result.source.repository_url, REPOSITORY_URL);
  assert.deepEqual([outputCalls, writes, commands], [0, 0, 0]);
});

test("GitHub evidence must be one successful exact-SHA ci run with every required job", () => {
  const evidence = ciEvidence();
  assert.equal(evidence.head_sha, SHA);
  assert.equal(evidence.event, "push");
  assert.equal(evidence.conclusion, "success");
  assert.deepEqual(evidence.required_jobs.map(({ name }) => name), REQUIRED_CI_JOBS);
  assert.equal(evidence.package.sha256, PACKAGE_SHA);
  assert.equal(evidence.package.bytes, PACKAGE_BYTES);
  assert.equal(evidence.package.file_count, PACKAGE_FILE_COUNT);
  assert.equal(evidence.package.identity_scheme, IDENTITY_SCHEME);
  assert.equal(evidence.package.runtime_payload_sha256, RUNTIME_SHA);
  assert.equal(evidence.package.digest_scope, "github_actions_raw_file_artifact");
  assert.equal(evidence.package.github_artifact_api_size_bytes, PACKAGE_BYTES);
  assert.equal(
    evidence.package.runtime_identity_artifact.filename,
    runtimeIdentityArtifactName(VERSION),
  );
  assert.equal(evidence.package.runtime_identity_artifact.receipt_schema_version, 1);
  assert.equal(evidence.package.used_by_rehearsal, false);

  assert.throws(() => validateCiRun(ciRun({ headSha: "9".repeat(40) }), artifactResponse(),
    ciValidationOptions()), /ci_head_sha_mismatch/);
  assert.throws(() => validateCiRun({ ...ciRun(), event: "pull_request" }, artifactResponse(),
    ciValidationOptions()), /ci_event_mismatch/);
  assert.throws(() => validateCiRun(ciRun({ conclusion: "failure" }), artifactResponse(),
    ciValidationOptions()), /ci_run_not_successful/);
  assert.throws(() => validateCiRun(ciRun({ jobs: ciRun().jobs.slice(1) }), artifactResponse(),
    ciValidationOptions()), /ci_required_job_missing/);
  const failedJobs = ciRun().jobs.map((job, index) => index === 3
    ? { ...job, conclusion: "failure" }
    : job);
  assert.throws(() => validateCiRun(ciRun({ jobs: failedJobs }), artifactResponse(),
    ciValidationOptions()), /ci_required_job_not_successful/);
  assert.throws(() => validateCiRun(ciRun(), artifactResponse({ digest: null }),
    ciValidationOptions()), /ci_package_digest_missing/);
  const missingIdentity = artifactResponse();
  missingIdentity.artifacts = missingIdentity.artifacts.slice(0, 1);
  missingIdentity.total_count = 1;
  assert.throws(() => validateCiRun(ciRun(), missingIdentity, ciValidationOptions()),
    /ci_runtime_identity_artifact_missing/);
  const changedIdentity = Buffer.from(runtimeIdentityBytes());
  changedIdentity[changedIdentity.length - 2] ^= 1;
  assert.throws(() => validateCiRun(ciRun(), artifactResponse(),
    ciValidationOptions({ runtimeIdentityBytes: changedIdentity })),
  /ci_runtime_identity_receipt_invalid/);
  assert.throws(() => validateCiRun(
    { ...ciRun(), updatedAt: "2026-09-01T00:00:00.000Z" },
    artifactResponse(),
    ciValidationOptions(),
  ), /ci_run_stale/);
});

test("production evidence is fetched only through gh for the named repository and run", () => {
  const calls = [];
  let identityBytes;
  const evidence = loadCiEvidence({ ciRunId: RUN_ID, expectedSha: SHA, version: VERSION }, {
    commandRunner(command, args, options) {
      calls.push({ command, args, options });
      if (args[0] === "run") return { status: 0, stdout: JSON.stringify(ciRun()) };
      if (args[0] === "api") return { status: 0, stdout: JSON.stringify(artifactResponse()) };
      throw new Error("unexpected command");
    },
    environment: { PATH: "/fixture/bin" },
    clock: () => CHECKED_AT,
    identityArtifactReader({ artifact, environment }) {
      assert.equal(artifact.filename, runtimeIdentityArtifactName(VERSION));
      assert.deepEqual(environment, { PATH: "/fixture/bin" });
      identityBytes = runtimeIdentityBytes();
      return identityBytes;
    },
  });
  assert.equal(evidence.run_id, RUN_ID);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ command }) => command), ["gh", "gh"]);
  assert.deepEqual(calls[0].args.slice(0, 6), ["run", "view", RUN_ID, "--repo", REPOSITORY_GH_TARGET, "--json"]);
  assert.match(calls[0].args[6], /(?:^|,)event(?:,|$)/);
  assert.deepEqual(calls[1].args.slice(0, 3), ["api", "--hostname", "github.com"]);
  assert.equal(calls[1].args[3], `repos/${REPOSITORY_SLUG}/actions/runs/${RUN_ID}/artifacts?per_page=100`);
  assert.equal(calls.every(({ options }) => options.shell === false), true);
  assert.equal(identityBytes.every((byte) => byte === 0), true);
});

test("the runtime identity artifact download captures exact raw bytes by immutable ID", () => {
  const bytes = runtimeIdentityBytes();
  const response = artifactResponse();
  const source = response.artifacts.find(({ name }) =>
    name === runtimeIdentityArtifactName(VERSION));
  const artifact = {
    artifact_id: String(source.id),
    filename: source.name,
    bytes: source.size_in_bytes,
    sha256: source.digest.slice("sha256:".length),
  };
  const received = [];
  const commandStdout = Buffer.from(bytes);
  const commandStderr = Buffer.alloc(0);
  const downloaded = downloadRuntimeIdentityArtifact({
    ciRunId: RUN_ID,
    artifact,
    environment: { PATH: "/fixture/bin" },
    commandRunner(command, args, options) {
      received.push({ command, args, options });
      return { status: 0, signal: null, stdout: commandStdout, stderr: commandStderr };
    },
  });
  assert.deepEqual(downloaded, bytes);
  assert.equal(commandStdout.every((byte) => byte === 0), true);
  assert.equal(received.length, 1);
  assert.equal(received[0].command, "gh");
  assert.deepEqual(received[0].args, [
    "api", "--hostname", "github.com",
    `repos/${REPOSITORY_SLUG}/actions/artifacts/${artifact.artifact_id}/zip`,
  ]);
  assert.deepEqual(received[0].options.env, { PATH: "/fixture/bin" });
  assert.equal(received[0].options.encoding, null);
  assert.equal(received[0].options.shell, false);
  assert.equal(received[0].options.windowsHide, true);
  downloaded.fill(0);
});

test("the raw artifact download fails closed and zeroes captured buffers", () => {
  const source = artifactResponse().artifacts.find(({ name }) =>
    name === runtimeIdentityArtifactName(VERSION));
  const artifact = {
    artifact_id: String(source.id),
    filename: source.name,
    bytes: source.size_in_bytes,
    sha256: source.digest.slice("sha256:".length),
  };
  const cases = [
    {
      name: "nonzero exit",
      code: /ci_runtime_identity_download_failed/,
      result: () => ({
        status: 1,
        signal: null,
        stdout: Buffer.from("partial private response"),
        stderr: Buffer.from("private-token-must-not-escape"),
      }),
    },
    {
      name: "string stdout",
      code: /ci_runtime_identity_download_binary_output_required/,
      result: () => ({ status: 0, signal: null, stdout: "not raw bytes", stderr: Buffer.alloc(0) }),
    },
    {
      name: "nonempty stderr",
      code: /ci_runtime_identity_download_stderr_not_empty/,
      result: () => ({
        status: 0,
        signal: null,
        stdout: Buffer.from(runtimeIdentityBytes()),
        stderr: Buffer.from("private-token-must-not-escape"),
      }),
    },
    {
      name: "wrong byte count",
      code: /ci_runtime_identity_download_size_mismatch/,
      result: () => ({
        status: 0,
        signal: null,
        stdout: Buffer.concat([runtimeIdentityBytes(), Buffer.from([0])]),
        stderr: Buffer.alloc(0),
      }),
    },
    {
      name: "wrong digest",
      code: /ci_runtime_identity_download_digest_mismatch/,
      result: () => {
        const stdout = runtimeIdentityBytes();
        stdout[0] ^= 1;
        return { status: 0, signal: null, stdout, stderr: Buffer.alloc(0) };
      },
    },
  ];
  for (const fixture of cases) {
    const result = fixture.result();
    let error;
    try {
      downloadRuntimeIdentityArtifact({
        ciRunId: RUN_ID,
        artifact,
        environment: { PATH: "/fixture/bin" },
        commandRunner() { return result; },
      });
    } catch (caught) {
      error = caught;
    }
    assert.match(String(error?.message || ""), fixture.code, fixture.name);
    assert.doesNotMatch(String(error?.message || ""), /private-token/, fixture.name);
    if (Buffer.isBuffer(result.stdout)) {
      assert.equal(result.stdout.every((byte) => byte === 0), true, fixture.name);
    }
    if (Buffer.isBuffer(result.stderr)) {
      assert.equal(result.stderr.every((byte) => byte === 0), true, fixture.name);
    }
  }

  assert.throws(() => downloadRuntimeIdentityArtifact({
    ciRunId: RUN_ID,
    artifact,
    environment: { PATH: "/fixture/bin" },
    commandRunner() { throw new Error("private-token-must-not-escape"); },
  }), (error) => {
    assert.match(error.message, /ci_runtime_identity_download_failed/);
    assert.doesNotMatch(error.message, /private-token/);
    return true;
  });

  assert.throws(() => downloadRuntimeIdentityArtifact({
    ciRunId: RUN_ID,
    artifact: { ...artifact, sha256: "not-a-digest" },
    commandRunner() { throw new Error("must not run"); },
  }), /ci_runtime_identity_artifact_metadata_invalid/);
});

test("Git and gh receive the same credential-minimized command environment", async () => {
  const environment = createKitCommandEnvironment({
    PATH: "/fixture/bin",
    SystemRoot: "C:\\Windows",
    HOME: "/private/home",
    USERPROFILE: "C:\\Users\\fixture",
    APPDATA: "C:\\Users\\fixture\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local",
    GH_CONFIG_DIR: "/private/gh-config",
    XDG_CONFIG_HOME: "/private/xdg-config",
    GH_TOKEN: "private-github-token",
    GITHUB_TOKEN: "private-actions-token",
    GH_ENTERPRISE_TOKEN: "private-enterprise-token",
    CLOUDFLARE_API_TOKEN: "private-cloudflare-token",
    QUICKBOOKS_CLIENT_SECRET: "private-provider-secret",
    NODE_OPTIONS: "--import=/private/hook.mjs",
  });
  assert.equal(environment.PATH, "/fixture/bin");
  assert.equal(environment.SystemRoot, "C:\\Windows");
  assert.equal(environment.HOME, "/private/home");
  assert.equal(environment.USERPROFILE, "C:\\Users\\fixture");
  assert.equal(environment.APPDATA, "C:\\Users\\fixture\\AppData\\Roaming");
  assert.equal(environment.LOCALAPPDATA, "C:\\Users\\fixture\\AppData\\Local");
  assert.equal(environment.GH_CONFIG_DIR, "/private/gh-config");
  assert.equal(environment.XDG_CONFIG_HOME, "/private/xdg-config");
  assert.equal(environment.GH_TOKEN, undefined);
  assert.equal(environment.GITHUB_TOKEN, undefined);
  assert.equal(environment.GH_ENTERPRISE_TOKEN, undefined);
  assert.equal(environment.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(environment.QUICKBOOKS_CLIENT_SECRET, undefined);
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.GIT_OPTIONAL_LOCKS, "0");
  assert.equal(environment.GIT_TERMINAL_PROMPT, "0");

  const receivedEnvironments = [];
  const result = await runWindowsOnboardingKit(
    parseWindowsOnboardingKitArgs([
      "--ci-run", RUN_ID, "--expect-sha", SHA, "--output", "/outside/new",
    ]),
    dependencies({
      environment,
      repositoryReader(_runner, received) {
        receivedEnvironments.push(received);
        return REPOSITORY_URL;
      },
      commandRunner(command, args, options) {
        assert.equal(command, "gh");
        receivedEnvironments.push(options.env);
        if (args[0] === "run") return { status: 0, stdout: JSON.stringify(ciRun()) };
        return { status: 0, stdout: JSON.stringify(artifactResponse()) };
      },
      clock: () => CHECKED_AT,
      outputMaker(path) { return path; },
      fileWriter() {},
    }),
  );
  assert.equal(receivedEnvironments.length, 4);
  assert.equal(receivedEnvironments.every((received) => received === environment), true);
  assert.doesNotMatch(JSON.stringify(result.release), /private-(?:github|actions|enterprise|cloudflare|provider)|private[\\/]home/i);
});

function zipEntryTimes(bytes) {
  const entries = [];
  for (let offset = 0; offset <= bytes.length - 16; offset++) {
    const signature = bytes.readUInt32LE(offset);
    if (signature === 0x04034b50) {
      entries.push({ kind: "local", time: bytes.readUInt16LE(offset + 10), date: bytes.readUInt16LE(offset + 12) });
    } else if (signature === 0x02014b50) {
      entries.push({ kind: "central", time: bytes.readUInt16LE(offset + 12), date: bytes.readUInt16LE(offset + 14) });
    }
  }
  return entries;
}

test("the sealed archive and receipts are deterministic, generic, and synthetic only", async () => {
  const first = await buildKitArtifacts(candidate(), ciEvidence());
  const second = await buildKitArtifacts(candidate(), ciEvidence());
  assert.deepEqual(first.archiveBytes, second.archiveBytes);
  assert.deepEqual(first.releaseBytes, second.releaseBytes);
  assert.match(first.archiveFilename, new RegExp(`^financial-brain-v${VERSION.replaceAll(".", "\\.")}-windows-onboarding-rehearsal-${SHA.slice(0, 12)}-[0-9a-f]{16}\\.zip$`));
  assert.equal(first.release.ready_to_send, true);
  assert.equal(first.release.ready_for_live_accounts, false);
  assert.equal(first.release.physical_windows_execution, "pending");
  assert.equal(first.release.schema_version, ARTIFACT_SCHEMA_VERSION);
  assert.equal(first.release.purpose, PURPOSE);
  assert.equal(first.release.artifact_kind, ARTIFACT_KIND);
  assert.equal(first.release.intended_architecture, INTENDED_ARCHITECTURE);
  assert.equal(first.release.intended_loopback_origin, LOOPBACK_ORIGIN);
  assert.equal(first.release.launcher.digest_scope, "checked_in_file_in_reviewed_checkout");
  assert.equal(first.release.launcher.included_in_handoff_archive, false);
  assert.equal(first.release.archive.sha256.length, 64);
  assert.equal(first.release.tested_package.sha256, PACKAGE_SHA);
  assert.equal(first.release.tested_package.github_artifact_api_size_bytes, PACKAGE_BYTES);
  assert.equal(first.release.tested_package.identity_scheme, IDENTITY_SCHEME);
  assert.equal(first.release.tested_package.runtime_payload_sha256, RUNTIME_SHA);
  assert.equal(first.release.update_preview.identity_scheme, IDENTITY_SCHEME);
  assert.equal(first.release.update_preview.expected_runtime_sha256, RUNTIME_SHA);
  assert.equal(first.release.update_preview.observed_installed_runtime, false);
  assert.equal(first.release.update_preview.preview_executed, false);
  assert.equal(first.release.boundaries.customer_data_allowed, false);
  assert.equal(first.release.boundaries.credentials_allowed, false);
  assert.equal(first.release.boundaries.live_actions_allowed, false);
  assert.equal(first.release.stale_reuse_guards.source_identity_rechecked_before_output, true);
  assert.equal(first.release.valid_until, "2026-09-19T18:00:00.000Z");
  const entryTimes = zipEntryTimes(first.archiveBytes);
  assert.equal(entryTimes.filter(({ kind }) => kind === "local").length, 2);
  assert.equal(entryTimes.filter(({ kind }) => kind === "central").length, 2);
  assert.equal(entryTimes.every(({ time, date }) => time === 0 && date === 33), true);

  const unzipped = unzipSync(first.archiveBytes);
  const names = Object.keys(unzipped).sort();
  assert.equal(names.length, 2);
  const instructionName = names.find((name) => name.endsWith("/RUN-WITH-CLAUDE-CODE.txt"));
  const manifestName = names.find((name) => name.endsWith("/REHEARSAL-MANIFEST.json"));
  const instructions = strFromU8(unzipped[instructionName]);
  const manifest = JSON.parse(strFromU8(unzipped[manifestName]));
  assert.equal(manifest.ready_to_send, true);
  assert.equal(manifest.schema_version, ARTIFACT_SCHEMA_VERSION);
  assert.equal(manifest.intended_architecture, INTENDED_ARCHITECTURE);
  assert.equal(manifest.intended_architecture, first.release.intended_architecture);
  assert.deepEqual(manifest.update_preview, first.release.update_preview);
  assert.equal(manifest.source.head_sha, SHA);
  assert.equal(manifest.launcher.path, LAUNCHER_PATH);
  assert.equal(manifest.launcher.digest_scope, "checked_in_file_in_reviewed_checkout");
  assert.equal(manifest.launcher.included_in_handoff_archive, false);
  assert.match(instructions, /normal PowerShell window opened from the Windows Start menu/i);
  assert.match(instructions, /artifact_kind is financial_brain_windows_onboarding_rehearsal/i);
  assert.match(instructions, /schema_version is 3/i);
  assert.match(instructions, /intended_architecture is x64/i);
  assert.match(instructions, /native x64 Windows computer/i);
  assert.match(instructions, /native Windows OS architecture x64.*Node process architecture x64/i);
  assert.match(instructions, /Windows on ARM64 does not qualify.*emulate x64 Node/i);
  assert.match(instructions, /successful CI event is push for exact source SHA/i);
  assert.match(instructions, /detached-HEAD mode/i);
  assert.match(instructions,
    /start-windows-rehearsal\.ps1.*-ExpectedSha.*-ExpectedRuntimeIdentityScheme.*-ExpectedRuntimeSha256/i);
  assert.match(instructions, new RegExp(`expected_runtime_sha256 is ${RUNTIME_SHA}`, "i"));
  assert.match(instructions,
    /preserved the expected runtime identity but did not observe an installed runtime or run update preview/i);
  assert.match(instructions, /Do not paste or reconstruct the PowerShell script body/i);
  assert.match(instructions, /launcher digest in release\.json describes this file in the reviewed checkout/i);
  assert.match(instructions, /launcher is not an entry inside the ZIP/i);
  assert.match(instructions, /Do not run npm install, npm ci/i);
  assert.match(instructions, /Do not run setup, provision, deploy, update, connect, ingest, OCR/i);
  assert.match(instructions, /owner should only need to answer questions.*click when guided/i);
  assert.match(instructions, /Guide them through one synthetic screen at a time/i);
  assert.match(instructions, /browser closes.*reopen http:\/\/127\.0\.0\.1:4176\/.*do not rerun the launcher/i);
  assert.match(instructions, /three biggest points of confusion/i);
  assert.match(instructions, /verified native Windows OS architecture.*verified Node process architecture/i);
  assert.doesNotMatch(
    `${instructions}\n${JSON.stringify(first.release)}`,
    /private-person-fixture|private@example\.test|\/Users\//i,
  );
});

test("a draft is visibly non-sendable and writes only a new output archive and receipt", async () => {
  const writes = [];
  const result = await runWindowsOnboardingKit(
    parseWindowsOnboardingKitArgs(["--draft", "--expect-sha", SHA, "--output", "/outside/new"]),
    dependencies({
      outputMaker(path) {
        assert.equal(path, "/outside/new");
        return path;
      },
      fileWriter(path, bytes) { writes.push({ path, bytes: Buffer.from(bytes) }); },
      commandRunner() { throw new Error("draft must not call GitHub"); },
    }),
  );
  assert.equal(result.release.status, "draft_not_ready");
  assert.equal(result.release.ready_to_send, false);
  assert.equal(result.release.ci, null);
  assert.equal(result.release.tested_package, null);
  assert.equal(result.release.valid_until, null);
  assert.equal(writes.length, 2);
  assert.equal(writes.some(({ path }) => path === join("/outside/new", "release.json")), true);
});

test("a stale source or failed CI refuses before the output directory is created", async () => {
  let outputs = 0;
  const options = parseWindowsOnboardingKitArgs([
    "--ci-run", RUN_ID, "--expect-sha", SHA, "--output", "/outside/new",
  ]);
  await assert.rejects(
    runWindowsOnboardingKit(options, dependencies({
      identityReader() { throw new Error("expected_source_sha_mismatch"); },
      outputMaker() { outputs += 1; },
    })),
    /expected_source_sha_mismatch/,
  );
  assert.equal(outputs, 0);

  await assert.rejects(
    runWindowsOnboardingKit(options, dependencies({
      commandRunner(command, args) {
        if (command !== "gh") throw new Error("unexpected command");
        if (args[0] === "run") return { status: 0, stdout: JSON.stringify(ciRun({ conclusion: "failure" })) };
        return { status: 0, stdout: JSON.stringify(artifactResponse()) };
      },
      clock: () => CHECKED_AT,
      outputMaker() { outputs += 1; },
    })),
    /ci_run_not_successful/,
  );
  assert.equal(outputs, 0);

  let identityReads = 0;
  await assert.rejects(
    runWindowsOnboardingKit(options, dependencies({
      identityReader() {
        identityReads += 1;
        return identityReads === 1
          ? sourceIdentity()
          : { ...sourceIdentity(), tree_sha: "8".repeat(40) };
      },
      commandRunner(command, args) {
        if (command !== "gh") throw new Error("unexpected command");
        if (args[0] === "run") return { status: 0, stdout: JSON.stringify(ciRun()) };
        return { status: 0, stdout: JSON.stringify(artifactResponse()) };
      },
      clock: () => CHECKED_AT,
      outputMaker() { outputs += 1; },
    })),
    /source_identity_changed_before_output/,
  );
  assert.equal(identityReads, 2);
  assert.equal(outputs, 0);
});
