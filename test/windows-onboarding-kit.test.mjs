import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import test from "node:test";

import { strFromU8, unzipSync } from "fflate";

import {
  ARTIFACT_KIND,
  LAUNCHER_PATH,
  LOOPBACK_ORIGIN,
  PURPOSE,
  REPOSITORY_GH_TARGET,
  REPOSITORY_SLUG,
  REPOSITORY_URL,
  REQUIRED_CI_JOBS,
  buildKitArtifacts,
  createKitCommandEnvironment,
  loadCiEvidence,
  normalizeRepositoryUrl,
  parseWindowsOnboardingKitArgs,
  runWindowsOnboardingKit,
  validateCiRun,
} from "../scripts/build-windows-onboarding-kit.mjs";

const SHA = "a".repeat(40);
const TREE = "b".repeat(40);
const RUN_ID = "456789";
const VERSION = "0.4.8";
const PACKAGE_SHA = "c".repeat(64);
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

function artifactResponse({ digest = `sha256:${PACKAGE_SHA}`, expired = false } = {}) {
  return {
    total_count: 1,
    artifacts: [{
      id: 8100,
      name: `brain-installer-${VERSION}.tgz`,
      size_in_bytes: 123456,
      digest,
      expired,
      workflow_run: { id: Number(RUN_ID), head_sha: SHA },
    }],
  };
}

function ciEvidence() {
  return validateCiRun(ciRun(), artifactResponse(), {
    expectedSha: SHA,
    version: VERSION,
    ciRunId: RUN_ID,
    now: CHECKED_AT,
  });
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
  assert.equal(evidence.package.digest_scope, "github_actions_raw_file_artifact");
  assert.equal(evidence.package.github_artifact_api_size_bytes, 123456);
  assert.equal(evidence.package.bytes, undefined);
  assert.equal(evidence.package.used_by_rehearsal, false);

  assert.throws(() => validateCiRun(ciRun({ headSha: "9".repeat(40) }), artifactResponse(), {
    expectedSha: SHA, version: VERSION, ciRunId: RUN_ID, now: CHECKED_AT,
  }), /ci_head_sha_mismatch/);
  assert.throws(() => validateCiRun({ ...ciRun(), event: "pull_request" }, artifactResponse(), {
    expectedSha: SHA, version: VERSION, ciRunId: RUN_ID, now: CHECKED_AT,
  }), /ci_event_mismatch/);
  assert.throws(() => validateCiRun(ciRun({ conclusion: "failure" }), artifactResponse(), {
    expectedSha: SHA, version: VERSION, ciRunId: RUN_ID, now: CHECKED_AT,
  }), /ci_run_not_successful/);
  assert.throws(() => validateCiRun(ciRun({ jobs: ciRun().jobs.slice(1) }), artifactResponse(), {
    expectedSha: SHA, version: VERSION, ciRunId: RUN_ID, now: CHECKED_AT,
  }), /ci_required_job_missing/);
  const failedJobs = ciRun().jobs.map((job, index) => index === 3
    ? { ...job, conclusion: "failure" }
    : job);
  assert.throws(() => validateCiRun(ciRun({ jobs: failedJobs }), artifactResponse(), {
    expectedSha: SHA, version: VERSION, ciRunId: RUN_ID, now: CHECKED_AT,
  }), /ci_required_job_not_successful/);
  assert.throws(() => validateCiRun(ciRun(), artifactResponse({ digest: null }), {
    expectedSha: SHA, version: VERSION, ciRunId: RUN_ID, now: CHECKED_AT,
  }), /ci_package_digest_missing/);
  assert.throws(() => validateCiRun({ ...ciRun(), updatedAt: "2026-09-01T00:00:00.000Z" }, artifactResponse(), {
    expectedSha: SHA, version: VERSION, ciRunId: RUN_ID, now: CHECKED_AT,
  }), /ci_run_stale/);
});

test("production evidence is fetched only through gh for the named repository and run", () => {
  const calls = [];
  const evidence = loadCiEvidence({ ciRunId: RUN_ID, expectedSha: SHA, version: VERSION }, {
    commandRunner(command, args, options) {
      calls.push({ command, args, options });
      if (args[0] === "run") return { status: 0, stdout: JSON.stringify(ciRun()) };
      if (args[0] === "api") return { status: 0, stdout: JSON.stringify(artifactResponse()) };
      throw new Error("unexpected command");
    },
    environment: { PATH: "/fixture/bin" },
    clock: () => CHECKED_AT,
  });
  assert.equal(evidence.run_id, RUN_ID);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ command }) => command), ["gh", "gh"]);
  assert.deepEqual(calls[0].args.slice(0, 6), ["run", "view", RUN_ID, "--repo", REPOSITORY_GH_TARGET, "--json"]);
  assert.match(calls[0].args[6], /(?:^|,)event(?:,|$)/);
  assert.deepEqual(calls[1].args.slice(0, 3), ["api", "--hostname", "github.com"]);
  assert.equal(calls[1].args[3], `repos/${REPOSITORY_SLUG}/actions/runs/${RUN_ID}/artifacts?per_page=100`);
  assert.equal(calls.every(({ options }) => options.shell === false), true);
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
  assert.equal(first.release.purpose, PURPOSE);
  assert.equal(first.release.artifact_kind, ARTIFACT_KIND);
  assert.equal(first.release.intended_loopback_origin, LOOPBACK_ORIGIN);
  assert.equal(first.release.archive.sha256.length, 64);
  assert.equal(first.release.tested_package.sha256, PACKAGE_SHA);
  assert.equal(first.release.tested_package.github_artifact_api_size_bytes, 123456);
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
  assert.equal(manifest.source.head_sha, SHA);
  assert.equal(manifest.launcher.path, LAUNCHER_PATH);
  assert.match(instructions, /normal PowerShell window opened from the Windows Start menu/i);
  assert.match(instructions, /artifact_kind is financial_brain_windows_onboarding_rehearsal/i);
  assert.match(instructions, /successful CI event is push for exact source SHA/i);
  assert.match(instructions, /detached-HEAD mode/i);
  assert.match(instructions, /start-windows-rehearsal\.ps1.*-ExpectedSha/i);
  assert.match(instructions, /Do not paste or reconstruct the PowerShell script body/i);
  assert.match(instructions, /Do not run npm install, npm ci/i);
  assert.match(instructions, /Do not run setup, provision, deploy, update, connect, ingest, OCR/i);
  assert.match(instructions, /owner should only need to answer questions.*click when guided/i);
  assert.match(instructions, /Guide them through one synthetic screen at a time/i);
  assert.match(instructions, /three biggest points of confusion/i);
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
  assert.equal(writes.some(({ path }) => path.endsWith("/release.json")), true);
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
