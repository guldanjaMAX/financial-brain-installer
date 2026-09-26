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

/** Every event that can start the workflow, inline or block form. */
function triggerNames(workflow) {
  const on = topLevelBlock(workflow, "on") ?? topLevelBlock(workflow, "true");
  if (!on) return [];
  if (on.inline) {
    return on.inline.replace(/^\[|\]$/g, "").split(",").map((name) => name.trim()).filter(Boolean);
  }
  return on.body.filter((line) => /^  [A-Za-z_]+:/.test(line)).map((line) => line.trim().replace(/:.*$/, ""));
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

function workflowJobs(workflow) {
  const jobsBlock = workflow.slice(workflow.indexOf("\njobs:\n") + "\njobs:\n".length);
  const jobs = new Map();
  for (const match of jobsBlock.matchAll(/^  ([a-z0-9-]+):\n([\s\S]*?)(?=^  [a-z0-9-]+:\n|(?![\s\S]))/gm)) {
    jobs.set(match[1], match[2]);
  }
  return jobs;
}

const workflowSteps = (job) => job.split(/^      - /m).slice(1);
const topPermissions = (workflow) => permissionsAt(workflow.slice(0, workflow.indexOf("\njobs:\n")).split("\n"), 0);
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
const goodRun = () => ({
  id: Number(RUN_ID),
  path: ".github/workflows/machine-prep-installers.yml",
  event: "workflow_dispatch",
  head_branch: "main",
  status: "completed",
  conclusion: "success",
  repository: { full_name: REPOSITORY },
  head_repository: { full_name: REPOSITORY },
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
function runProvenance({ run = goodRun(), artifact = goodArtifact(), env = {} } = {}) {
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
        return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body };
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
          [`/repos/${REPOSITORY}/actions/artifacts/${ARTIFACT_ID}`]: artifact,
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

test("S2 both jobs run the same provenance program", () => {
  const { macProgram, windowsProgram } = embeddedProvenance();
  assert.equal(windowsProgram, macProgram);
});

test("S2 a reviewed main workflow_dispatch artifact with the declared digest is accepted", () => {
  const result = runProvenance();
  assert.equal(result.status, 0, result.text);
  assert.deepEqual(result.calls, [RUN_PATH, ARTIFACT_PATH]);
  assert.equal(result.output, `run_id=${RUN_ID}\nartifact_id=${ARTIFACT_ID}\n`);
});

const runRefusals = [
  ["another workflow file", (run) => { run.path = ".github/workflows/ci.yml"; }, /workflow/],
  ["a pull_request event", (run) => { run.event = "pull_request"; }, /workflow_dispatch/],
  ["a pull_request_target event", (run) => { run.event = "pull_request_target"; }, /workflow_dispatch/],
  ["a fork head repository", (run) => { run.head_repository = { full_name: "someone-else/fixture-repo" }; }, /head repository/],
  ["a missing head repository", (run) => { delete run.head_repository; }, /head repository/],
  ["a non-main branch", (run) => { run.head_branch = "feature"; }, /not main/],
  ["a failed run", (run) => { run.conclusion = "failure"; }, /success/],
  ["an unfinished run", (run) => { run.status = "in_progress"; run.conclusion = null; }, /completed with success/],
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
    assert.deepEqual(result.calls, [RUN_PATH, ARTIFACT_PATH], "the refusal came from the artifact's own record");
    assert.equal(result.output, "");
  });
}

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
