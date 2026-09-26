/**
 * The signing workflow turns a reviewed unsigned build into artifacts that
 * carry the owner's publisher identity. These checks pin the boundaries a
 * review found open: which artifact is fetched and from which run, the token
 * scopes and triggers of both workflows, the signer identity, the shared
 * Actions cache, and the SHA-256 receipt a downloader can check.
 *
 * The macOS step scripts run here under bash against stubbed Apple tools, so
 * their decisions are exercised rather than only pattern-matched. Nothing here
 * reaches GitHub, Apple, or Azure.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
// Job and trigger keys are read by the shared parser, which sees every key
// spelling YAML accepts (S3-R); the rest of this file's readers are local.
import { beforeJobs, triggerNames, workflowJobs } from "./helpers/workflow-yaml.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8").replaceAll("\r\n", "\n");
const SIGNING_PATH = ".github/workflows/installer-signing.yml";
const UNSIGNED_PATH = ".github/workflows/machine-prep-installers.yml";
const PLANNED_PUBLISHER = "Financial Brain LLC";

// ---------------------------------------------------------------------------
// Minimal, indentation-based readers for the two reviewed workflow files.

function topLevelBlock(workflow, key) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^(?:${key}|"${key}"|'${key}'):(.*)$`).test(line));
  if (start < 0) return null;
  const inline = lines[start].slice(lines[start].indexOf(":") + 1).trim();
  const body = [];
  for (let index = start + 1; index < lines.length; index++) {
    if (/^\S/.test(lines[index])) break;
    body.push(lines[index]);
  }
  return { inline, body };
}

/** A permissions value: null (undeclared), a string (read-all/write-all), or a map. */
function permissionsAt(lines, indent) {
  const pattern = new RegExp(`^ {${indent}}permissions:(.*)$`);
  const start = lines.findIndex((line) => pattern.test(line));
  if (start < 0) return null;
  const inline = pattern.exec(lines[start])[1].trim();
  if (inline === "{}") return {};
  if (inline) return inline;
  const map = {};
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (line.length - line.trimStart().length <= indent) break;
    const match = /^\s+([a-z-]+):\s*(\S+)\s*$/.exec(line);
    if (!match) throw new Error(`unparsed permissions line: ${line}`);
    map[match[1]] = match[2];
  }
  return map;
}

const workflowSteps = (job) => job.split(/^      - /m).slice(1);
const topPermissions = (workflow) => permissionsAt(beforeJobs(workflow).split("\n"), 0);
const jobPermissions = (job) => permissionsAt(job.split("\n"), 4);

function stepNamed(job, name) {
  const step = workflowSteps(job).find((candidate) => candidate.startsWith(`name: ${name}\n`));
  assert.ok(step, `step "${name}" exists`);
  return step;
}

function withValue(step, key) {
  return new RegExp(`^\\s+${key}: (.*)$`, "m").exec(step)?.[1]?.trim() ?? null;
}

/** The literal script of a step's `run: |` block, dedented. */
function runScript(step) {
  const lines = step.split("\n");
  const start = lines.findIndex((line) => /^\s+run: \|$/.test(line));
  assert.notEqual(start, -1, "the step has a run block");
  const indent = /^\s*/.exec(lines[start])[0].length;
  const body = [];
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim() && line.length - line.trimStart().length <= indent) break;
    body.push(line);
  }
  const margin = Math.min(...body.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length));
  return body.map((line) => line.slice(margin)).join("\n");
}

/**
 * The whole token and trigger policy of one workflow. A regression in any
 * part must throw here; the mutation tests below prove that it does.
 */
function assertWorkflowPolicy(workflow, expected) {
  assert.deepEqual(triggerNames(workflow), ["workflow_dispatch"], "workflow_dispatch is the only trigger");
  assert.deepEqual(topPermissions(workflow), expected.top, "top-level permissions are exact");
  const jobs = workflowJobs(workflow);
  assert.deepEqual([...jobs.keys()].sort(), Object.keys(expected.jobs).sort(), "the job set is exact");
  for (const [name, job] of jobs) {
    assert.deepEqual(jobPermissions(job), expected.jobs[name], `${name} permissions are exact`);
    for (const step of workflowSteps(job)) {
      const uses = /^\s*uses: ([^\s#]+)/m.exec(step)?.[1];
      if (!uses) continue;
      assert.match(uses, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/, `${uses} is pinned to a full commit`);
      if (/^actions\/checkout@/.test(uses)) {
        assert.equal(withValue(step, "persist-credentials"), "false", `${name} checkout does not persist its token`);
      }
    }
  }
}

const SIGNING_POLICY = Object.freeze({
  top: {},
  jobs: {
    "macos-sign": { contents: "read", actions: "read" },
    "windows-sign": { contents: "read", actions: "read", "id-token": "write" },
  },
});
const UNSIGNED_POLICY = Object.freeze({
  top: { contents: "read" },
  jobs: { "macos-unsigned": null, "windows-unsigned": null },
});

// ---------------------------------------------------------------------------
// S1: the signing job requests exactly the artifact the build uploads.

function uploadedBasenames() {
  const jobs = workflowJobs(read(UNSIGNED_PATH));
  const byJob = {};
  for (const [jobName, job] of jobs) {
    const upload = workflowSteps(job).find((step) => /actions\/upload-artifact@/.test(step));
    assert.ok(upload, `${jobName} uploads its artifact`);
    // upload-artifact names an unarchived upload after the file, ignoring name:.
    assert.equal(withValue(upload, "archive"), "false");
    byJob[jobName] = basename(withValue(upload, "path"));
  }
  return byJob;
}

test("S1 each signing job downloads by immutable artifact ID the exact file the build uploads", () => {
  const uploaded = uploadedBasenames();
  assert.deepEqual(uploaded, {
    "macos-unsigned": "FinancialBrainMachinePrep-unsigned.pkg",
    "windows-unsigned": "FinancialBrainMachinePrep-unsigned.msi",
  });
  const jobs = workflowJobs(read(SIGNING_PATH));
  for (const [signingJob, buildJob] of [["macos-sign", "macos-unsigned"], ["windows-sign", "windows-unsigned"]]) {
    const job = jobs.get(signingJob);
    const provenance = workflowSteps(job)[0];
    assert.equal(withValue(provenance, "EXPECTED_ARTIFACT_NAME"), uploaded[buildJob],
      `${signingJob} asks for the artifact name upload-artifact really produced`);
    const download = workflowSteps(job).find((step) => /actions\/download-artifact@/.test(step));
    assert.equal(withValue(download, "name"), null, "the download never selects by a mutable name");
    assert.equal(withValue(download, "artifact-ids"), "${{ steps.provenance.outputs.artifact_id }}");
    assert.equal(withValue(download, "run-id"), "${{ steps.provenance.outputs.run_id }}");
    assert.equal(withValue(download, "skip-decompress"), "true");
    assert.equal(withValue(download, "digest-mismatch"), "error");
    assert.equal(withValue(download, "path"), "unsigned");
    assert.ok(job.includes(`unsigned/${uploaded[buildJob]}`), `${signingJob} signs unsigned/${uploaded[buildJob]}`);
  }
});

test("S1 the unsigned build publishes each artifact ID and digest for the signing dispatch", () => {
  const jobs = workflowJobs(read(UNSIGNED_PATH));
  for (const job of jobs.values()) {
    const upload = workflowSteps(job).find((step) => /actions\/upload-artifact@/.test(step));
    assert.match(upload, /^\s+id: upload$/m);
    const receipt = stepNamed(job, "record the artifact ID and digest to sign");
    assert.equal(withValue(receipt, "ARTIFACT_ID"), "${{ steps.upload.outputs.artifact-id }}");
    assert.equal(withValue(receipt, "ARTIFACT_DIGEST"), "${{ steps.upload.outputs.artifact-digest }}");
    assert.match(receipt, /GITHUB_STEP_SUMMARY/);
  }
});

// ---------------------------------------------------------------------------
// S2: provenance of the run and the artifact is proven before any download.

const REPOSITORY = "fixture-owner/fixture-repo";
const RUN_ID = "1234567890";
const ARTIFACT_ID = "987654321";
const SHA = "a".repeat(64);
// Synthetic commit IDs: the tip of main, an older commit on main, and a commit
// that exists only under a tag.
const MAIN_TIP = "1".repeat(40);
const MAIN_ANCESTOR = "2".repeat(40);
const TAG_ONLY_COMMIT = "3".repeat(40);
const MAC_JOB = "build unsigned macOS package";
const WINDOWS_JOB = "build unsigned Windows MSI";
const goodRun = () => ({
  id: Number(RUN_ID),
  path: ".github/workflows/machine-prep-installers.yml",
  event: "workflow_dispatch",
  head_branch: "main",
  head_sha: MAIN_TIP,
  status: "completed",
  conclusion: "success",
  repository: { full_name: REPOSITORY },
  head_repository: { full_name: REPOSITORY },
});
const mainRef = (sha = MAIN_TIP) => ({ ref: "refs/heads/main", object: { type: "commit", sha } });
/** GET /compare/{main tip}...{head_sha}: how head_sha relates to the tip of main. */
const comparison = (status, headSha = MAIN_TIP) => ({
  status,
  ahead_by: status === "ahead" || status === "diverged" ? 2 : 0,
  behind_by: status === "behind" || status === "diverged" ? 3 : 0,
  merge_base_commit: { sha: status === "behind" || status === "identical" ? headSha : MAIN_ANCESTOR },
});
const job = (name, conclusion, headSha = MAIN_TIP) => ({
  id: name === MAC_JOB ? 11 : 12,
  run_id: Number(RUN_ID),
  name,
  head_sha: headSha,
  status: "completed",
  conclusion,
});
/** The default dispatch: the Windows job deliberately fails without the WiX OSMF confirmation. */
const goodJobs = (headSha = MAIN_TIP) => ({
  total_count: 2,
  jobs: [job(MAC_JOB, "success", headSha), job(WINDOWS_JOB, "failure", headSha)],
});
const goodArtifact = () => ({
  id: Number(ARTIFACT_ID),
  name: "FinancialBrainMachinePrep-unsigned.pkg",
  expired: false,
  digest: `sha256:${SHA}`,
  workflow_run: { id: Number(RUN_ID), head_branch: "main", repository_id: 1, head_repository_id: 1 },
});

/** The provenance program each signing job's gate step feeds to node. */
function embeddedProvenance() {
  const jobs = workflowJobs(read(SIGNING_PATH));
  const mac = runScript(workflowSteps(jobs.get("macos-sign"))[0]);
  const windows = runScript(workflowSteps(jobs.get("windows-sign"))[0]);
  const macProgram = /<<'PROVENANCE'\n([\s\S]*?)\nPROVENANCE$/m.exec(mac)?.[1];
  const windowsProgram = /^\$provenance = @'\n([\s\S]*?)\n'@$/m.exec(windows)?.[1];
  assert.ok(macProgram, "the macOS gate feeds a provenance program to node");
  assert.ok(windowsProgram, "the Windows gate feeds a provenance program to node");
  assert.match(mac, /node --input-type=module - <<'PROVENANCE'/);
  assert.match(windows, /\$provenance \| node --input-type=module -\nif \(\$LASTEXITCODE -ne 0\) \{ exit 1 \}/);
  return { macProgram, windowsProgram };
}

/**
 * Run the embedded program exactly as the gate does, with fetch answered
 * from fixtures. The fixture preload records each API path it was asked for.
 */
function runProvenance({ run = goodRun(), artifact = goodArtifact(), env = {}, fixtures = {} } = {}) {
  const { macProgram } = embeddedProvenance();
  const directory = mkdtempSync(join(tmpdir(), "signing-provenance-"));
  try {
    const calls = join(directory, "calls.log");
    const output = join(directory, "github-output");
    const preload = join(directory, "fetch-fixture.mjs");
    writeFileSync(preload, `
      import { appendFileSync } from "node:fs";
      const fixtures = JSON.parse(process.env.FIXTURES);
      globalThis.fetch = async (url, init) => {
        const path = new URL(url).pathname;
        appendFileSync(process.env.CALLS, path + "\\n");
        if (init?.headers?.authorization !== "Bearer fixture-token") throw new Error("the API call carried no job token");
        const body = fixtures[path];
        const status = body === undefined ? 404 : body.__status ?? 200;
        return { ok: status === 200, status, json: async () => body };
      };
    `);
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, "--input-type=module", "-"], {
      input: macProgram,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_API_URL: "https://api.fixture.invalid",
        GITHUB_OUTPUT: output,
        GH_TOKEN: "fixture-token",
        UNSIGNED_RUN_ID: RUN_ID,
        UNSIGNED_ARTIFACT_ID: ARTIFACT_ID,
        UNSIGNED_SHA256: SHA,
        EXPECTED_ARTIFACT_NAME: "FinancialBrainMachinePrep-unsigned.pkg",
        CALLS: calls,
        FIXTURES: JSON.stringify({
          [`/repos/${REPOSITORY}/actions/runs/${RUN_ID}`]: run,
          [`/repos/${REPOSITORY}/git/ref/heads/main`]: mainRef(),
          [`/repos/${REPOSITORY}/compare/${MAIN_TIP}...${MAIN_TIP}`]: comparison("identical"),
          [`/repos/${REPOSITORY}/actions/runs/${RUN_ID}/jobs`]: goodJobs(),
          [`/repos/${REPOSITORY}/actions/artifacts/${ARTIFACT_ID}`]: artifact,
          ...fixtures,
        }),
        ...env,
      },
    });
    return {
      status: result.status,
      text: `${result.stdout}${result.stderr}`,
      calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : [],
      output: existsSync(output) ? readFileSync(output, "utf8") : "",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const RUN_PATH = `/repos/${REPOSITORY}/actions/runs/${RUN_ID}`;
const ARTIFACT_PATH = `/repos/${REPOSITORY}/actions/artifacts/${ARTIFACT_ID}`;
const HEADS_MAIN_PATH = `/repos/${REPOSITORY}/git/ref/heads/main`;
const TAGS_MAIN_PATH = `/repos/${REPOSITORY}/git/ref/tags/main`;
const comparePath = (headSha = MAIN_TIP) => `/repos/${REPOSITORY}/compare/${MAIN_TIP}...${headSha}`;
const JOBS_PATH = `/repos/${REPOSITORY}/actions/runs/${RUN_ID}/jobs`;
/** Every record the gate reads, in order, before it reads the artifact. */
const RUN_PROOF_CALLS = (headSha = MAIN_TIP) => [RUN_PATH, HEADS_MAIN_PATH, TAGS_MAIN_PATH, comparePath(headSha), JOBS_PATH];

test("S2 both jobs run the same provenance program", () => {
  const { macProgram, windowsProgram } = embeddedProvenance();
  assert.equal(windowsProgram, macProgram);
});

test("S2 a reviewed main workflow_dispatch artifact with the declared digest is accepted", () => {
  const result = runProvenance();
  assert.equal(result.status, 0, result.text);
  assert.deepEqual(result.calls, [...RUN_PROOF_CALLS(), ARTIFACT_PATH]);
  assert.equal(result.output, `run_id=${RUN_ID}\nartifact_id=${ARTIFACT_ID}\n`);
});

const runRefusals = [
  ["another workflow file", (run) => { run.path = ".github/workflows/ci.yml"; }, /workflow/],
  ["a pull_request event", (run) => { run.event = "pull_request"; }, /workflow_dispatch/],
  ["a pull_request_target event", (run) => { run.event = "pull_request_target"; }, /workflow_dispatch/],
  ["a fork head repository", (run) => { run.head_repository = { full_name: "someone-else/fixture-repo" }; }, /head repository/],
  ["a missing head repository", (run) => { delete run.head_repository; }, /head repository/],
  ["a non-main branch", (run) => { run.head_branch = "feature"; }, /not main/],
  ["an unfinished run", (run) => { run.status = "in_progress"; run.conclusion = null; }, /completed with success/],
  ["a run with no head commit", (run) => { delete run.head_sha; }, /has no 40-character head_sha/],
  ["a run from another repository", (run) => { run.repository = { full_name: "someone-else/fixture-repo" }; }, /another repository/],
];
for (const [name, mutate, message] of runRefusals) {
  test(`S2 refuses ${name} after reading the run and before reading the artifact`, () => {
    const run = goodRun();
    mutate(run);
    const result = runProvenance({ run });
    assert.equal(result.status, 1);
    assert.match(result.text, message);
    assert.match(result.text, /Nothing was downloaded or signed/);
    assert.deepEqual(result.calls, [RUN_PATH], "the refusal came from the run's own record");
    assert.equal(result.output, "", "no artifact ID reached the download step");
  });
}

const artifactRefusals = [
  ["an artifact from another run", (artifact) => { artifact.workflow_run.id = 1; }, /not run/],
  ["an artifact under the build's ignored label", (artifact) => { artifact.name = "FinancialBrainMachinePrep-macOS-unsigned"; }, /is named/],
  ["an artifact whose digest differs", (artifact) => { artifact.digest = `sha256:${"b".repeat(64)}`; }, /digest/],
  ["an artifact with no digest", (artifact) => { delete artifact.digest; }, /digest/],
  ["an expired artifact", (artifact) => { artifact.expired = true; }, /expired/],
];
for (const [name, mutate, message] of artifactRefusals) {
  test(`S2 refuses ${name} after reading both records`, () => {
    const artifact = goodArtifact();
    mutate(artifact);
    const result = runProvenance({ artifact });
    assert.equal(result.status, 1);
    assert.match(result.text, message);
    assert.deepEqual(result.calls, [...RUN_PROOF_CALLS(), ARTIFACT_PATH], "the refusal came from the artifact's own record");
    assert.equal(result.output, "");
  });
}

// S2-R: head_branch "main" is only a name. A dispatch on a tag called main
// reports head_branch "main" too, so the gate proves the built commit is the
// tip of the main branch or an ancestor of it, and refuses while a main tag
// exists at all.

test("S2-R a run that built an older commit of main is accepted", () => {
  const run = goodRun();
  run.head_sha = MAIN_ANCESTOR;
  const result = runProvenance({
    run,
    fixtures: { [comparePath(MAIN_ANCESTOR)]: comparison("behind", MAIN_ANCESTOR), [JOBS_PATH]: goodJobs(MAIN_ANCESTOR) },
  });
  assert.equal(result.status, 0, result.text);
  assert.deepEqual(result.calls, [...RUN_PROOF_CALLS(MAIN_ANCESTOR), ARTIFACT_PATH]);
});

test("S2-R a dispatch on a tag named main is refused while that tag exists", () => {
  const run = goodRun();
  run.head_sha = TAG_ONLY_COMMIT;
  const result = runProvenance({
    run,
    fixtures: {
      [TAGS_MAIN_PATH]: { ref: "refs/tags/main", object: { type: "commit", sha: TAG_ONLY_COMMIT } },
      [comparePath(TAG_ONLY_COMMIT)]: comparison("diverged", TAG_ONLY_COMMIT),
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.text, /a tag named main exists in fixture-owner\/fixture-repo, so run 1234567890's head_branch "main" cannot be proven to be the main branch/);
  assert.match(result.text, /Nothing was downloaded or signed/);
  assert.deepEqual(result.calls, [RUN_PATH, HEADS_MAIN_PATH, TAGS_MAIN_PATH], "the refusal came from the tag lookup");
  assert.equal(result.output, "");
});

for (const [name, status, extra] of [
  ["a commit that main does not contain", "diverged", {}],
  ["a commit newer than main", "ahead", {}],
  ["a behind status whose merge base is another commit", "behind", { merge_base_commit: { sha: MAIN_ANCESTOR } }],
  ["an identical status that reports commits ahead", "identical", { ahead_by: 1 }],
]) {
  test(`S2-R refuses ${name} even after its tag is gone`, () => {
    const run = goodRun();
    run.head_sha = TAG_ONLY_COMMIT;
    const result = runProvenance({
      run,
      fixtures: { [comparePath(TAG_ONLY_COMMIT)]: { ...comparison(status, TAG_ONLY_COMMIT), ...extra } },
    });
    assert.equal(result.status, 1);
    assert.match(result.text, new RegExp(`run 1234567890 built commit ${TAG_ONLY_COMMIT}, which is not the tip of main or an ancestor of it \\(compare status ${status}\\)`));
    assert.deepEqual(result.calls, [RUN_PATH, HEADS_MAIN_PATH, TAGS_MAIN_PATH, comparePath(TAG_ONLY_COMMIT)]);
    assert.equal(result.output, "");
  });
}

for (const [name, ref] of [
  ["a missing main branch", undefined],
  ["a main ref that is not refs/heads/main", { ref: "refs/tags/main", object: { type: "commit", sha: MAIN_TIP } }],
  ["a main ref that names a tag object", { ref: "refs/heads/main", object: { type: "tag", sha: MAIN_TIP } }],
]) {
  test(`S2-R refuses ${name}`, () => {
    const result = runProvenance({ fixtures: { [HEADS_MAIN_PATH]: ref } });
    assert.equal(result.status, 1);
    assert.match(result.text, ref === undefined ? /HTTP 404 for \/repos\/fixture-owner\/fixture-repo\/git\/ref\/heads\/main/ : /refs\/heads\/main did not resolve to a commit/);
    assert.deepEqual(result.calls, [RUN_PATH, HEADS_MAIN_PATH]);
    assert.equal(result.output, "");
  });
}

test("S2-R an error other than 404 on the tag lookup is a refusal, not an absent tag", () => {
  const result = runProvenance({ fixtures: { [TAGS_MAIN_PATH]: { __status: 500 } } });
  assert.equal(result.status, 1);
  assert.match(result.text, /GitHub answered HTTP 500 for \/repos\/fixture-owner\/fixture-repo\/git\/ref\/tags\/main/);
  assert.equal(result.output, "");
});

// S8: the default dispatch fails the Windows job on purpose, so the gate reads
// the conclusion of the one platform job that built the artifact, not the run.

test("S8 a macOS package from a run whose Windows job failed is accepted", () => {
  const run = goodRun();
  run.conclusion = "failure";
  const result = runProvenance({ run });
  assert.equal(result.status, 0, result.text);
  assert.deepEqual(result.calls, [...RUN_PROOF_CALLS(), ARTIFACT_PATH]);
});

test("S8 a Windows MSI is gated on the Windows job, not the macOS job", () => {
  const run = goodRun();
  run.conclusion = "failure";
  const msi = { EXPECTED_ARTIFACT_NAME: "FinancialBrainMachinePrep-unsigned.msi" };
  const artifact = { ...goodArtifact(), name: "FinancialBrainMachinePrep-unsigned.msi" };
  const accepted = runProvenance({
    run, artifact, env: msi,
    fixtures: { [JOBS_PATH]: { total_count: 2, jobs: [job(MAC_JOB, "failure"), job(WINDOWS_JOB, "success")] } },
  });
  assert.equal(accepted.status, 0, accepted.text);
  const refused = runProvenance({ run, artifact, env: msi });
  assert.equal(refused.status, 1);
  assert.match(refused.text, /the build unsigned Windows MSI job of run 1234567890 is completed with conclusion failure, not completed with success/);
  assert.deepEqual(refused.calls, RUN_PROOF_CALLS());
  assert.equal(refused.output, "");
});

const jobRefusals = [
  ["a failed platform job", (jobs) => { jobs.jobs[0].conclusion = "failure"; },
    /the build unsigned macOS package job of run 1234567890 is completed with conclusion failure, not completed with success/],
  ["a skipped platform job", (jobs) => { jobs.jobs[0].conclusion = "skipped"; }, /conclusion skipped, not completed with success/],
  ["an unfinished platform job", (jobs) => { jobs.jobs[0].status = "in_progress"; jobs.jobs[0].conclusion = null; },
    /is in_progress with conclusion null, not completed with success/],
  ["a missing platform job", (jobs) => { jobs.jobs.shift(); jobs.total_count = 1; },
    /run 1234567890 has 0 jobs named "build unsigned macOS package", not exactly one/],
  ["a duplicated platform job name", (jobs) => { jobs.jobs.push({ ...jobs.jobs[0], id: 13 }); jobs.total_count = 3; },
    /run 1234567890 has 2 jobs named "build unsigned macOS package", not exactly one/],
  ["a job name that only resembles the platform job", (jobs) => { jobs.jobs[0].name = `${MAC_JOB} (copy)`; },
    /has 0 jobs named "build unsigned macOS package"/],
  ["a job list that is only one page of more", (jobs) => { jobs.total_count = 150; },
    /run 1234567890 lists 150 jobs but the API returned 2; an incomplete job list proves nothing/],
  ["a job from another run", (jobs) => { jobs.jobs[0].run_id = 1; }, /belongs to run 1, not run 1234567890/],
  ["a job that built another commit", (jobs) => { jobs.jobs[0].head_sha = MAIN_ANCESTOR; },
    new RegExp(`built ${MAIN_ANCESTOR}, not the run's head_sha ${MAIN_TIP}`)],
];
for (const [name, mutate, message] of jobRefusals) {
  test(`S8 refuses ${name} before reading the artifact`, () => {
    const jobs = goodJobs();
    mutate(jobs);
    const result = runProvenance({ fixtures: { [JOBS_PATH]: jobs } });
    assert.equal(result.status, 1);
    assert.match(result.text, message);
    assert.match(result.text, /Nothing was downloaded or signed/);
    assert.deepEqual(result.calls, RUN_PROOF_CALLS(), "the refusal came from the jobs record");
    assert.equal(result.output, "");
  });
}

test("S8 the gate's platform job names are the unsigned workflow's own job names", () => {
  const unsignedJobs = workflowJobs(read(UNSIGNED_PATH));
  const { macProgram } = embeddedProvenance();
  for (const [buildJob, file] of [["macos-unsigned", "FinancialBrainMachinePrep-unsigned.pkg"], ["windows-unsigned", "FinancialBrainMachinePrep-unsigned.msi"]]) {
    const displayName = /^    name: (.+)$/m.exec(unsignedJobs.get(buildJob))?.[1];
    assert.ok(displayName, `${buildJob} has a display name`);
    assert.ok(macProgram.includes(`"${file}": "${displayName}"`), `the gate reads the "${displayName}" job for ${file}`);
  }
  assert.doesNotMatch(macProgram, /run\.conclusion !== "success"/, "the whole-run conclusion no longer decides");
});

for (const [name, env] of [
  ["a non-numeric run ID", { UNSIGNED_RUN_ID: "12; rm -rf /" }],
  ["a non-numeric artifact ID", { UNSIGNED_ARTIFACT_ID: "latest" }],
  ["a malformed SHA-256", { UNSIGNED_SHA256: "abc" }],
  ["an uppercase SHA-256", { UNSIGNED_SHA256: "A".repeat(64) }],
  ["an unexpected artifact name", { EXPECTED_ARTIFACT_NAME: "anything.pkg" }],
]) {
  test(`S2 refuses ${name} before any API call`, () => {
    const result = runProvenance({ env });
    assert.equal(result.status, 1);
    assert.match(result.text, /must be/);
    assert.deepEqual(result.calls, []);
  });
}

test("S2 an API error is a refusal, not a pass", () => {
  const result = runProvenance({ env: { UNSIGNED_RUN_ID: "5" } });
  assert.equal(result.status, 1);
  assert.match(result.text, /HTTP 404/);
  assert.equal(result.output, "");
});

test("S2 the provenance gate precedes every download and the digest is re-checked before signing", () => {
  const workflow = read(SIGNING_PATH);
  const inputs = topLevelBlock(workflow, "on").body.join("\n");
  assert.match(inputs, /^      unsigned_artifact_id:$/m);
  assert.match(inputs, /^      unsigned_sha256:$/m);
  const jobs = workflowJobs(workflow);
  for (const [name, signingPattern] of [["macos-sign", /productsign/], ["windows-sign", /-signing-action@/]]) {
    const steps = workflowSteps(jobs.get(name));
    const download = steps.findIndex((step) => /actions\/download-artifact@/.test(step));
    const digest = steps.findIndex((step) => step.startsWith("name: verify the downloaded bytes against the dispatched SHA-256\n"));
    const signing = steps.findIndex((step) => signingPattern.test(step));
    assert.equal(download, 1, `${name} downloads right after the gate`);
    assert.ok(digest > download && digest < signing, `${name} re-hashes the download before signing`);
    const gate = steps[0];
    assert.match(gate, /^\s+id: provenance$/m);
    assert.equal(withValue(gate, "UNSIGNED_RUN_ID"), "${{ inputs.unsigned_run_id }}");
    assert.equal(withValue(gate, "UNSIGNED_ARTIFACT_ID"), "${{ inputs.unsigned_artifact_id }}");
    assert.equal(withValue(gate, "UNSIGNED_SHA256"), "${{ inputs.unsigned_sha256 }}");
    assert.equal(withValue(gate, "GH_TOKEN"), "${{ github.token }}");
    assert.equal(withValue(steps[digest], "UNSIGNED_SHA256"), "${{ inputs.unsigned_sha256 }}");
    assert.match(runScript(steps[digest]), /unsigned\/FinancialBrainMachinePrep-unsigned\.(?:pkg|msi)/);
  }
});

// ---------------------------------------------------------------------------
// S3: exact permissions and triggers, proven to catch regressions.

test("S3 both workflows have exact permissions, a dispatch-only trigger and non-persisted checkouts", () => {
  assertWorkflowPolicy(read(SIGNING_PATH), SIGNING_POLICY);
  assertWorkflowPolicy(read(UNSIGNED_PATH), UNSIGNED_POLICY);
  assert.equal([...read(UNSIGNED_PATH).matchAll(/uses: actions\/checkout@/g)].length, 2,
    "each unsigned build checks out reviewed source without persisting its token");
  assert.equal([...read(SIGNING_PATH).matchAll(/uses: actions\/checkout@/g)].length, 0,
    "the signing jobs run no repository code inside the signing environment");
});

const mutations = [
  [SIGNING_PATH, SIGNING_POLICY, "top-level write-all", (text) => text.replace(/^permissions: \{\}$/m, "permissions: write-all")],
  [SIGNING_PATH, SIGNING_POLICY, "actions: write on the macOS job", (text) => text.replace(/^      actions: read$/m, "      actions: write")],
  [SIGNING_PATH, SIGNING_POLICY, "an added contents: write", (text) => text.replace(/^      contents: read$/m, "      contents: write")],
  [SIGNING_PATH, SIGNING_POLICY, "an added packages: write", (text) => text.replace(/^      id-token: write$/m, "      id-token: write\n      packages: write")],
  [SIGNING_PATH, SIGNING_POLICY, "id-token granted to the macOS job", (text) => text.replace(/^      actions: read$/m, "      actions: read\n      id-token: write")],
  [SIGNING_PATH, SIGNING_POLICY, "a job-level write-all", (text) => text.replace(/^    permissions:\n      contents: read\n      actions: read\n      id-token: write$/m, "    permissions: write-all")],
  [SIGNING_PATH, SIGNING_POLICY, "a pull_request_target trigger", (text) => text.replace(/^on:\n/m, "on:\n  pull_request_target:\n")],
  [SIGNING_PATH, SIGNING_POLICY, "a push trigger", (text) => text.replace(/^on:\n/m, "on:\n  push:\n    branches: [main]\n")],
  [SIGNING_PATH, SIGNING_POLICY, "an inline trigger list", (text) => text.replace(/^on:\n/m, "on: [push, workflow_dispatch]\nignored:\n")],
  [SIGNING_PATH, SIGNING_POLICY, "an added signing checkout that persists its token", (text) => text.replace(
    /^    steps:\n/m, "    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n")],
  [SIGNING_PATH, SIGNING_POLICY, "an unpinned action", (text) => text.replace(/actions\/download-artifact@[0-9a-f]{40}/, "actions/download-artifact@v8")],
  [UNSIGNED_PATH, UNSIGNED_POLICY, "unsigned top-level write-all", (text) => text.replace(/^permissions:\n  contents: read$/m, "permissions: write-all")],
  [UNSIGNED_PATH, UNSIGNED_POLICY, "unsigned actions: write", (text) => text.replace(/^permissions:\n  contents: read$/m, "permissions:\n  contents: read\n  actions: write")],
  [UNSIGNED_PATH, UNSIGNED_POLICY, "an unsigned job-level grant", (text) => text.replace(/^    runs-on: macos-latest$/m, "    runs-on: macos-latest\n    permissions:\n      contents: write")],
  [UNSIGNED_PATH, UNSIGNED_POLICY, "an unsigned pull_request trigger", (text) => text.replace(/^on:\n/m, "on:\n  pull_request:\n")],
  [UNSIGNED_PATH, UNSIGNED_POLICY, "an unsigned workflow_run trigger", (text) => text.replace(/^on:\n/m, "on:\n  workflow_run:\n    workflows: [ci]\n")],
  [UNSIGNED_PATH, UNSIGNED_POLICY, "a persisted unsigned checkout", (text) => text.replace(/^          persist-credentials: false$/m, "          persist-credentials: true")],
  [UNSIGNED_PATH, UNSIGNED_POLICY, "an unsigned checkout without persist-credentials", (text) => text.replace(/^        with:\n          persist-credentials: false\n/m, "")],
  // S3-R: job and trigger keys in every spelling YAML accepts.
  ...[[SIGNING_PATH, SIGNING_POLICY, /^  windows-sign:$/m], [UNSIGNED_PATH, UNSIGNED_POLICY, /^  windows-unsigned:$/m]].flatMap(([path, policy, lastJob]) => {
    // No permissions block, so only the job-key parser can notice the job.
    const extraJob = (key) => `  ${key}\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo extra\n`;
    const label = path === SIGNING_PATH ? "" : "unsigned ";
    return [
      [path, policy, `${label}an appended Extra_Job key with a trailing comment`, (text) => `${text}${extraJob("Extra_Job:  # comment")}`],
      [path, policy, `${label}an inserted double-quoted job key`, (text) => text.replace(lastJob, (line) => `${extraJob('"quoted-job":')}${line}`)],
      [path, policy, `${label}an inserted single-quoted job key`, (text) => text.replace(lastJob, (line) => `${extraJob("'quoted-job':")}${line}`)],
      [path, policy, `${label}an appended uppercase job key`, (text) => `${text}${extraJob("PUBLISH:")}`],
      [path, policy, `${label}an appended job key with a digit and underscore`, (text) => `${text}${extraJob("job_2:")}`],
      [path, policy, `${label}a single-quoted pull_request_target trigger`, (text) => text.replace(/^on:\n/m, "on:\n  'pull_request_target':\n")],
      [path, policy, `${label}a double-quoted push trigger with a comment`, (text) => text.replace(/^on:\n/m, 'on:\n  "push":  # comment\n    branches: [main]\n')],
      [path, policy, `${label}a schedule trigger with a comment`, (text) => text.replace(/^on:\n/m, "on:\n  schedule:  # nightly\n    - cron: '0 0 * * *'\n")],
      [path, policy, `${label}a quoted workflow_dispatch beside an added workflow_run`, (text) => text.replace(/^  workflow_dispatch:$/m, "  'workflow_dispatch':\n  \"workflow_run\":\n    workflows: [ci]")],
      [path, policy, `${label}a commented on: key with an added push`, (text) => text.replace(/^on:\n/m, "on:  # triggers\n  push:\n")],
    ];
  }),
];
for (const [path, policy, name, mutate] of mutations) {
  test(`S3 mutation "${name}" fails the policy check`, () => {
    const original = read(path);
    assertWorkflowPolicy(original, policy);
    const mutated = mutate(original);
    assert.notEqual(mutated, original, "the mutation applied to the current workflow");
    assert.throws(() => assertWorkflowPolicy(mutated, policy), assert.AssertionError);
  });
}

// Rewrites YAML treats as the same workflow must still pass, so the parser
// cannot satisfy the mutation cases above just by refusing unusual spellings.
const equivalentRewrites = [
  ["a single-quoted workflow_dispatch key", (text) => text.replace(/^  workflow_dispatch:$/m, "  'workflow_dispatch':")],
  ["a double-quoted workflow_dispatch key with a comment", (text) => text.replace(/^  workflow_dispatch:$/m, '  "workflow_dispatch":  # by hand only')],
  ["a commented on: key", (text) => text.replace(/^on:$/m, "on:  # triggers")],
  ["a commented jobs: key", (text) => text.replace(/^jobs:$/m, "jobs:  # every job")],
  ["a quoted jobs: key", (text) => text.replace(/^jobs:$/m, '"jobs":')],
  ["job keys with trailing comments", (text) => text.replace(/^  ([a-z-]+-(?:sign|unsigned)):$/gm, "  $1:  # reviewed job")],
  ["single-quoted job keys", (text) => text.replace(/^  ([a-z-]+-(?:sign|unsigned)):$/gm, "  '$1':")],
  ["double-quoted job keys", (text) => text.replace(/^  ([a-z-]+-(?:sign|unsigned)):$/gm, '  "$1":')],
  ["a comment line between jobs", (text) => text.replace(/^  (windows-(?:sign|unsigned)):$/m, "# the Windows job\n  $1:")],
];
for (const [path, policy] of [[SIGNING_PATH, SIGNING_POLICY], [UNSIGNED_PATH, UNSIGNED_POLICY]]) {
  for (const [name, rewrite] of equivalentRewrites) {
    test(`S3-R ${basename(path)} with ${name} still parses to the same policy`, () => {
      const original = read(path);
      const rewritten = rewrite(original);
      assert.notEqual(rewritten, original, "the rewrite applied to the current workflow");
      assertWorkflowPolicy(rewritten, policy);
    });
  }
}

// ---------------------------------------------------------------------------
// S4: owner checklist.

test("S4 the signing plan names the environment branch policy, self-review and the federated subject", () => {
  const plan = read("machine-prep/SIGNING.md");
  assert.match(plan, /deployment branch policy of `main` only/);
  assert.match(plan, /[Pp]revent self-review/);
  assert.match(plan, /repo:<owner>\/<repo>:environment:installer-signing/);
  assert.match(plan, /financialbrain-signing/);
  assert.match(plan, /East US/);
  assert.match(plan, /https:\/\/eus\.codesigning\.azure\.net\//);
  assert.match(plan, /certificate profile[^.]*(?:does not exist yet|not created yet|pending)/i);
  for (const variable of ["ARTIFACT_SIGNING_ENDPOINT", "ARTIFACT_SIGNING_ACCOUNT_NAME", "ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME"]) {
    assert.match(plan, new RegExp(`\\b${variable}\\b[^\\n]*repository variable|repository variables?[^\\n]*\\b${variable}\\b`));
  }
});

test("S8 the owner checklist says the platform job, not the whole run, must succeed", () => {
  const plan = read("machine-prep/SIGNING.md");
  const step4 = /^4\. Dispatch `machine-prep-installers` on `main`.*$/m.exec(plan)?.[0];
  assert.ok(step4, "checklist step 4 exists");
  assert.match(step4, /`build unsigned macOS package`/);
  assert.match(step4, /`build unsigned Windows MSI`/);
  assert.match(step4, /wix_osmf_confirmed/);
  assert.match(step4, /whole run[^.]*(?:fail|red)/i);
  assert.match(step4, /tag named `main`/);
  assert.doesNotMatch(plan, /finished with `success`/, "the plan no longer claims the whole run must succeed");
});

// ---------------------------------------------------------------------------
// S5: no shared Actions cache feeds the signing tools.

test("S5 the Artifact Signing action does not restore its tools from the shared cache", () => {
  const job = workflowJobs(read(SIGNING_PATH)).get("windows-sign");
  const signing = workflowSteps(job).find((step) => /-signing-action@/.test(step));
  assert.equal(withValue(signing, "cache-dependencies"), "false");
});

// ---------------------------------------------------------------------------
// S6/S7: run the macOS step scripts against stubbed Apple tools.

const bashAvailable = process.platform !== "win32" && spawnSync("bash", ["-c", "true"]).status === 0;

function stubTools(directory, tools) {
  mkdirSync(directory, { recursive: true });
  for (const [name, body] of Object.entries(tools)) {
    const path = join(directory, name);
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path, 0o755);
  }
}

function runStep(stepName, { tools, env = {}, cwd }) {
  const job = workflowJobs(read(SIGNING_PATH)).get("macos-sign");
  const script = runScript(stepNamed(job, stepName));
  const stubs = join(cwd, ".stubs");
  stubTools(stubs, tools);
  return spawnSync("bash", ["-e", "-c", script], {
    cwd,
    encoding: "utf8",
    env: { PATH: `${stubs}:/usr/bin:/bin`, RUNNER_TEMP: join(cwd, ".runner"), GITHUB_ENV: join(cwd, ".github-env"), ...env },
  });
}

const identityLine = (index, team, org = PLANNED_PUBLISHER) =>
  `  ${index}) ${String(index).repeat(40).slice(0, 40)} "Developer ID Installer: ${org} (${team})"`;

function keychainScenario(findIdentityOutput) {
  const cwd = mkdtempSync(join(tmpdir(), "signing-keychain-"));
  mkdirSync(join(cwd, ".runner"));
  const result = runStep("create a temporary signing keychain", {
    cwd,
    tools: {
      security: `if [ "$1" = find-identity ]; then cat <<'EOF'\n${findIdentityOutput}\nEOF\nfi\nexit 0`,
    },
    env: { P12_BASE64: Buffer.from("fixture").toString("base64"), P12_PASSWORD: "fixture", APPLE_TEAM_ID: "TEAMID1234" },
  });
  const githubEnv = existsSync(join(cwd, ".github-env")) ? readFileSync(join(cwd, ".github-env"), "utf8") : "";
  rmSync(cwd, { recursive: true, force: true });
  return { result, githubEnv };
}

test("S6 macOS signing selects only the Developer ID Installer identity of the declared team", { skip: !bashAvailable && "needs bash" }, () => {
  const chosen = keychainScenario([
    identityLine(1, "OTHERTEAM9"),
    identityLine(2, "TEAMID1234"),
    "     2 valid identities found",
  ].join("\n"));
  assert.equal(chosen.result.status, 0, chosen.result.stderr);
  assert.match(chosen.githubEnv, /^SIGNING_IDENTITY=2{40}$/m, "the identity of the declared team was chosen, not the first one listed");

  const wrongTeam = keychainScenario([identityLine(1, "OTHERTEAM9"), "     1 valid identities found"].join("\n"));
  assert.notEqual(wrongTeam.result.status, 0);
  assert.match(`${wrongTeam.result.stdout}${wrongTeam.result.stderr}`, /TEAMID1234|team/i);
  assert.doesNotMatch(wrongTeam.githubEnv, /SIGNING_IDENTITY=/, "no identity was handed to productsign");

  const ambiguous = keychainScenario([identityLine(1, "TEAMID1234"), identityLine(2, "TEAMID1234"), "     2 valid identities found"].join("\n"));
  assert.notEqual(ambiguous.result.status, 0, "two matching identities are ambiguous");
  assert.doesNotMatch(ambiguous.githubEnv, /SIGNING_IDENTITY=/);
});

function signScenario(signatureOutput) {
  const cwd = mkdtempSync(join(tmpdir(), "signing-sign-"));
  mkdirSync(join(cwd, ".runner"));
  mkdirSync(join(cwd, "unsigned"));
  writeFileSync(join(cwd, "unsigned", "FinancialBrainMachinePrep-unsigned.pkg"), "fixture package");
  const result = runStep("sign the package with a secure timestamp", {
    cwd,
    tools: {
      productsign: 'cp "${@: -2:1}" "${@: -1}"',
      pkgutil: `cat <<'EOF'\n${signatureOutput}\nEOF`,
    },
    env: { SIGNING_IDENTITY: "2".repeat(40), SIGNING_KEYCHAIN: join(cwd, "k"), APPLE_TEAM_ID: "TEAMID1234" },
  });
  rmSync(cwd, { recursive: true, force: true });
  return result;
}

test("S6 the signed package's certificate chain must name the declared team", { skip: !bashAvailable && "needs bash" }, () => {
  const signature = (team) => [
    "Package \"FinancialBrainMachinePrep.pkg\":",
    "   Status: signed by a developer certificate issued by Apple for distribution",
    "   Signed with a trusted timestamp on: 2026-09-26 00:00:00 +0000",
    "   Certificate Chain:",
    `    1. Developer ID Installer: ${PLANNED_PUBLISHER} (${team})`,
    "       Expires: 2031-09-26 00:00:00 +0000",
    "    2. Developer ID Certification Authority",
  ].join("\n");
  const good = signScenario(signature("TEAMID1234"));
  assert.equal(good.status, 0, `${good.stdout}${good.stderr}`);
  const other = signScenario(signature("OTHERTEAM9"));
  assert.notEqual(other.status, 0, "a signature from another team's identity is refused");
});

test("S6 the workflow reads the team from configuration and the Windows signer must be the planned publisher", () => {
  const workflow = read(SIGNING_PATH);
  const jobs = workflowJobs(workflow);
  const macGate = workflowSteps(jobs.get("macos-sign"))[0];
  assert.match(macGate, /APPLE_TEAM_ID: \$\{\{ vars\.APPLE_TEAM_ID \}\}/);
  assert.match(macGate, /\^\[A-Z0-9\]\{10\}\$/, "the team ID is validated before anything is downloaded");
  for (const name of ["create a temporary signing keychain", "sign the package with a secure timestamp", "verify the exact distributed bytes"]) {
    assert.equal(withValue(stepNamed(jobs.get("macos-sign"), name), "APPLE_TEAM_ID"), "${{ vars.APPLE_TEAM_ID }}", name);
  }
  const verify = stepNamed(jobs.get("windows-sign"), "verify the Authenticode signature");
  assert.equal(withValue(verify, "EXPECTED_PUBLISHER"), PLANNED_PUBLISHER);
  const script = runScript(verify);
  assert.match(script, /\$signature\.SignerCertificate\.Subject/);
  assert.match(script, /O=/);
  assert.match(script, /EXPECTED_PUBLISHER/);
  assert.ok(script.indexOf("SignerCertificate.Subject") < script.indexOf("signtool"),
    "the publisher is checked before the receipt is produced");
});

test("S7 the macOS SHA-256 receipt verifies from the downloaded artifact root", { skip: !bashAvailable && "needs bash" }, () => {
  const cwd = mkdtempSync(join(tmpdir(), "signing-receipt-"));
  try {
    mkdirSync(join(cwd, ".runner"));
    mkdirSync(join(cwd, "dist"));
    writeFileSync(join(cwd, "dist", "FinancialBrainMachinePrep.pkg"), "signed fixture package");
    const result = runStep("verify the exact distributed bytes", {
      cwd,
      tools: {
        xcrun: "exit 0",
        spctl: "exit 0",
        pkgutil: `echo "    1. Developer ID Installer: ${PLANNED_PUBLISHER} (TEAMID1234)"`,
      },
      env: { APPLE_TEAM_ID: "TEAMID1234" },
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const receipt = readFileSync(join(cwd, "dist", "FinancialBrainMachinePrep.pkg.sha256"), "utf8");
    const digest = createHash("sha256").update("signed fixture package").digest("hex");
    assert.equal(receipt, `${digest}  FinancialBrainMachinePrep.pkg\n`);
    // The uploaded artifact's root is dist/, so this is where a downloader runs it.
    const check = spawnSync("shasum", ["-a", "256", "-c", "FinancialBrainMachinePrep.pkg.sha256"], {
      cwd: join(cwd, "dist"), encoding: "utf8",
    });
    assert.equal(check.status, 0, `${check.stdout}${check.stderr}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// S9: every refusal after the provenance gate is exercised, not only matched.

function withScratch(prefix, body) {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  try {
    mkdirSync(join(cwd, ".runner"));
    return body(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const sha256Of = (text) => createHash("sha256").update(text).digest("hex");

test("S9 the macOS re-hash refuses bytes that differ from the dispatched SHA-256", { skip: !bashAvailable && "needs bash" }, () => {
  const rehash = (declared) => withScratch("signing-rehash-", (cwd) => {
    mkdirSync(join(cwd, "unsigned"));
    writeFileSync(join(cwd, "unsigned", "FinancialBrainMachinePrep-unsigned.pkg"), "fixture package");
    // The real shasum hashes the bytes; only the Apple tools are stubbed.
    return runStep("verify the downloaded bytes against the dispatched SHA-256", { cwd, tools: {}, env: { UNSIGNED_SHA256: declared } });
  });
  const good = rehash(sha256Of("fixture package"));
  assert.equal(good.status, 0, `${good.stdout}${good.stderr}`);
  const bad = rehash(sha256Of("other bytes"));
  assert.equal(bad.status, 1);
  assert.match(`${bad.stdout}${bad.stderr}`,
    new RegExp(`::error::the downloaded package hashes to ${sha256Of("fixture package")}, not the dispatched unsigned_sha256\\. Nothing was signed\\.`));
});

test("S9 the macOS final check refuses a distributed package whose leaf is another team", { skip: !bashAvailable && "needs bash" }, () => {
  const finalCheck = (signatureLines) => withScratch("signing-final-", (cwd) => {
    mkdirSync(join(cwd, "dist"));
    writeFileSync(join(cwd, "dist", "FinancialBrainMachinePrep.pkg"), "signed fixture package");
    const result = runStep("verify the exact distributed bytes", {
      cwd,
      tools: { xcrun: "exit 0", spctl: "exit 0", pkgutil: `cat <<'EOF'\n${signatureLines.join("\n")}\nEOF` },
      env: { APPLE_TEAM_ID: "TEAMID1234" },
    });
    return { result, receipt: existsSync(join(cwd, "dist", "FinancialBrainMachinePrep.pkg.sha256")) };
  });
  for (const lines of [
    [`    1. Developer ID Installer: ${PLANNED_PUBLISHER} (OTHERTEAM9)`],
    [`    1. Developer ID Installer: ${PLANNED_PUBLISHER} (OTHERTEAM9)`, `    2. Developer ID Installer: ${PLANNED_PUBLISHER} (TEAMID1234)`],
    [`    1. Developer ID Application: ${PLANNED_PUBLISHER} (TEAMID1234)`],
  ]) {
    const { result, receipt } = finalCheck(lines);
    assert.equal(result.status, 1, lines.join("\n"));
    assert.match(`${result.stdout}${result.stderr}`,
      /::error::the distributed package's leaf certificate is not the Developer ID Installer identity of team TEAMID1234\. No receipt was written\./);
    assert.equal(receipt, false, "no SHA-256 receipt vouches for a package signed by another identity");
  }
});

/** A node program a Windows pwsh step feeds to node, extracted exactly as the step runs it. */
function windowsProgram(stepName, variable) {
  const script = runScript(stepNamed(workflowJobs(read(SIGNING_PATH)).get("windows-sign"), stepName));
  const program = new RegExp(`^\\$${variable} = @'\\n([\\s\\S]*?)\\n'@$`, "m").exec(script)?.[1];
  assert.ok(program, `"${stepName}" feeds a $${variable} program to node`);
  assert.match(script, new RegExp(`^\\$${variable} \\| node --input-type=module -\\nif \\(\\$LASTEXITCODE -ne 0\\) \\{ exit 1 \\}$`, "m"),
    `"${stepName}" stops when the program refuses`);
  return { script, program };
}

function runWindowsProgram(program, { cwd, env }) {
  return spawnSync(process.execPath, ["--input-type=module", "-"], {
    input: program, cwd, encoding: "utf8", env: { PATH: process.env.PATH, ...env },
  });
}

test("S9 the Windows re-hash refuses bytes that differ from the dispatched SHA-256", () => {
  const { script, program } = windowsProgram("verify the downloaded bytes against the dispatched SHA-256", "rehash");
  assert.match(program, /unsigned\/FinancialBrainMachinePrep-unsigned\.msi/);
  assert.doesNotMatch(script, /Get-FileHash/, "the decision is the program the suite runs, not an untested pwsh copy");
  const rehash = (declared, { write = true } = {}) => withScratch("signing-win-rehash-", (cwd) => {
    if (write) {
      mkdirSync(join(cwd, "unsigned"));
      writeFileSync(join(cwd, "unsigned", "FinancialBrainMachinePrep-unsigned.msi"), "fixture msi");
    }
    return runWindowsProgram(program, { cwd, env: { UNSIGNED_SHA256: declared } });
  });
  const good = rehash(sha256Of("fixture msi"));
  assert.equal(good.status, 0, `${good.stdout}${good.stderr}`);
  const bad = rehash(sha256Of("other bytes"));
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, new RegExp(`::error::the downloaded MSI hashes to ${sha256Of("fixture msi")}, not the dispatched unsigned_sha256\\. Nothing was signed\\.`));
  const uppercase = rehash(sha256Of("fixture msi").toUpperCase());
  assert.equal(uppercase.status, 1, "only the exact lowercase digest the gate proved is accepted");
  const missing = rehash(sha256Of("fixture msi"), { write: false });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /::error::the downloaded MSI could not be read \(ENOENT\)\. Nothing was signed\./);
});

const SUBJECT_TAIL = "L=Fixture City, S=Fixture State, C=US";
test("S9 the Windows publisher check accepts only a signer whose organization is the planned publisher", () => {
  const { script, program } = windowsProgram("verify the Authenticode signature", "publisherCheck");
  assert.match(script, /^\$env:SIGNER_SUBJECT = \[string\]\$signature\.SignerCertificate\.Subject$/m);
  assert.ok(script.indexOf("$publisherCheck | node") < script.indexOf("signtool"), "the publisher is decided before signtool and the receipt");
  const check = (subject, expected = PLANNED_PUBLISHER) =>
    runWindowsProgram(program, { cwd: ROOT, env: { SIGNER_SUBJECT: subject, EXPECTED_PUBLISHER: expected } });
  for (const subject of [
    `CN=${PLANNED_PUBLISHER}, O=${PLANNED_PUBLISHER}, ${SUBJECT_TAIL}`,
    `CN=${PLANNED_PUBLISHER}, O="${PLANNED_PUBLISHER}", ${SUBJECT_TAIL}`,
    `O=${PLANNED_PUBLISHER}`,
  ]) {
    const accepted = check(subject);
    assert.equal(accepted.status, 0, `${subject}: ${accepted.stdout}${accepted.stderr}`);
  }
  for (const subject of [
    `CN=${PLANNED_PUBLISHER}, O=Other Publisher LLC, ${SUBJECT_TAIL}`,
    `CN=${PLANNED_PUBLISHER}, O=${PLANNED_PUBLISHER} Holdings, ${SUBJECT_TAIL}`,
    `CN=${PLANNED_PUBLISHER}, O=Not ${PLANNED_PUBLISHER}, ${SUBJECT_TAIL}`,
    `CN=${PLANNED_PUBLISHER}, OU=${PLANNED_PUBLISHER}, O=Other Publisher LLC, ${SUBJECT_TAIL}`,
    `CN=${PLANNED_PUBLISHER}, ${SUBJECT_TAIL}`,
    `CN=${PLANNED_PUBLISHER}, O=${PLANNED_PUBLISHER}, O=Other Publisher LLC, ${SUBJECT_TAIL}`,
    `CN=${PLANNED_PUBLISHER}, O="${PLANNED_PUBLISHER}, Inc", ${SUBJECT_TAIL}`,
    `CN=Other, O=Other Publisher LLC, OU="${PLANNED_PUBLISHER}, O=${PLANNED_PUBLISHER}"`,
    "",
  ]) {
    const refused = check(subject);
    assert.equal(refused.status, 1, subject);
    assert.match(refused.stdout, /^::error::the MSI signer is .*, not O=Financial Brain LLC\. Nothing was published\.$/m, subject);
  }
  const unbalanced = check(`CN=${PLANNED_PUBLISHER}, O="${PLANNED_PUBLISHER}`);
  assert.equal(unbalanced.status, 1);
  assert.match(unbalanced.stdout, /::error::the MSI signer subject could not be parsed/);
  const unconfigured = check(`O=${PLANNED_PUBLISHER}`, "");
  assert.equal(unconfigured.status, 1);
  assert.match(unconfigured.stdout, /::error::EXPECTED_PUBLISHER is empty/);
});
