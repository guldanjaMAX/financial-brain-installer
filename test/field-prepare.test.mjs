import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertDirectPlanEntrypoint,
  assertNoLiveCommand,
  buildNpmInvocation,
  buildStepPlan,
  buildWindowsBatchInvocation,
  canonicalSourceRoot,
  createCredentialFreeProviderEnvironment,
  createPlanEnvironment,
  createSafeEnvironment,
  parseFieldPrepareArgs,
  readSourceIdentity,
  renderFieldChecklist,
  runFieldPrepare,
  sameCanonicalSourceRoot,
} from "../scripts/field-prepare.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("the default profile contains every credential-free preparation gate", () => {
  const options = parseFieldPrepareArgs([]);
  const ids = buildStepPlan(options).map((step) => step.id);
  assert.deepEqual(ids, [
    "source-identity", "full-suite", "frontend-test", "frontend-build",
    "hiccup-lab", "plaid-fake",
    "d1-auth-atomicity", "passkey-protocol", "package-privacy",
    "history-privacy", "dependency-audit", "package-build", "clean-prefix-smoke",
    "source-identity-final", "private-home-cleanup",
  ]);
});

test("fast and selected profiles cannot become accidental full proof", () => {
  const fast = buildStepPlan(parseFieldPrepareArgs(["--fast"])).map((step) => step.id);
  assert.ok(fast.includes("focused-suite"));
  assert.ok(fast.includes("frontend-test"));
  assert.ok(fast.includes("frontend-build"));
  assert.ok(fast.includes("hiccup-lab-fast"));
  assert.ok(fast.includes("package-privacy-fast"));
  assert.ok(!fast.includes("full-suite"));
  assert.ok(!fast.includes("hiccup-lab"));
  assert.ok(!fast.includes("package-privacy"));

  const selected = buildStepPlan(parseFieldPrepareArgs(["--only", "clean-prefix-smoke"]));
  assert.deepEqual(selected.map((step) => step.id), [
    "source-identity", "package-build", "clean-prefix-smoke", "source-identity-final",
    "private-home-cleanup",
  ]);
  const reversed = buildStepPlan(parseFieldPrepareArgs([
    "--only", "clean-prefix-smoke,package-build",
  ])).map((step) => step.id);
  assert.ok(reversed.indexOf("package-build") < reversed.indexOf("clean-prefix-smoke"));
  assert.throws(() => parseFieldPrepareArgs(["--fast", "--only", "plaid-fake"]), /separate modes/);
  assert.throws(() => parseFieldPrepareArgs(["--only", "cloudflare-live"]), /unknown/);
  assert.throws(() => parseFieldPrepareArgs(["--only", ","]), /at least one/);
  assert.throws(() => parseFieldPrepareArgs(["--json"]), /only with --plan/);
});

test("every child environment drops credentials and customer-home access", () => {
  const temporary = mkdtempSync(join(tmpdir(), "brain-field-env-test-"));
  try {
    const safe = createSafeEnvironment({
      PATH: "/fixture/bin",
      HOME: "/private/customer-home",
      CLOUDFLARE_API_TOKEN: "fixture-cloud-token",
      BANK_FEED_SECRET: "fixture-bank-secret",
      QUICKBOOKS_CLIENT_SECRET: "fixture-qbo-secret",
      GOOGLE_CLIENT_SECRET: "fixture-google-secret",
      NODE_OPTIONS: "--import=/private/customer-hook.mjs",
    }, temporary);
    assert.equal(safe.PATH, "/fixture/bin");
    assert.equal(safe.HOME, temporary);
    assert.equal(safe.USERPROFILE, temporary);
    assert.equal(safe.CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(safe.BANK_FEED_SECRET, undefined);
    assert.equal(safe.QUICKBOOKS_CLIENT_SECRET, undefined);
    assert.equal(safe.GOOGLE_CLIENT_SECRET, undefined);
    assert.equal(safe.NODE_OPTIONS, undefined);
    assert.equal(safe.NPM_CONFIG_CACHE, join(temporary, "npm-cache"));
    assert.equal(safe.NPM_CONFIG_GLOBALCONFIG, join(temporary, "npm-globalrc"));
    assert.equal(safe.NPM_CONFIG_USERCONFIG, join(temporary, "npmrc"));
    assert.equal(safe.NPM_CONFIG_OFFLINE, "true");
    assert.equal(safe.BRAIN_FIELD_PREPARE, "1");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("npm and Windows wrapper launches avoid ambient shell execution", () => {
  const npm = buildNpmInvocation("C:\\safe tools\\npm-cli.js", ["pack", "a&b"]);
  assert.equal(npm.command, process.execPath);
  assert.deepEqual(npm.args, ["C:\\safe tools\\npm-cli.js", "pack", "a&b"]);
  assert.equal(npm.shell, false);

  const batch = buildWindowsBatchInvocation("cmd.exe", "C:\\safe tools\\brain.cmd");
  assert.equal(batch.command, "cmd.exe");
  assert.equal(batch.shell, false);
  assert.deepEqual(batch.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.throws(() => buildWindowsBatchInvocation("cmd.exe", "bad\"path.cmd"), /refused/);
});

test("provider subprocesses drop credentials while keeping telemetry disabled", () => {
  const safe = createCredentialFreeProviderEnvironment({
    PATH: "/fixture/bin",
    CLOUDFLARE_API_TOKEN: "fixture-token",
    CF_ACCOUNT_ID: "fixture-account",
    WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING: "fixture-connection",
    WRANGLER_SEND_METRICS: "true",
  });
  assert.equal(safe.PATH, "/fixture/bin");
  assert.equal(safe.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(safe.CF_ACCOUNT_ID, undefined);
  assert.equal(safe.WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING, undefined);
  assert.equal(safe.WRANGLER_SEND_METRICS, "false");
  assert.equal(safe.DO_NOT_TRACK, "1");
});

test("plan identity checks receive no ambient credentials or writable Git config", () => {
  const safe = createPlanEnvironment({
    PATH: "/fixture/bin",
    HOME: "/private/customer-home",
    CLOUDFLARE_API_TOKEN: "fixture-cloud-token",
    NODE_OPTIONS: "--import=/private/customer-hook.mjs",
    GIT_ASKPASS: "/private/credential-helper",
  });
  assert.equal(safe.PATH, "/fixture/bin");
  assert.equal(safe.HOME, undefined);
  assert.equal(safe.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(safe.NODE_OPTIONS, undefined);
  assert.equal(safe.GIT_ASKPASS, undefined);
  assert.equal(safe.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(safe.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(safe.GIT_NO_LAZY_FETCH, "1");
  assert.equal(safe.GIT_OPTIONAL_LOCKS, "0");
  assert.equal(safe.GIT_TERMINAL_PROMPT, "0");
});

test("read-only planning must use the direct Node entrypoint", () => {
  const plan = parseFieldPrepareArgs(["--plan", "--json", "--expect-sha", "a".repeat(40)]);
  assert.equal(assertDirectPlanEntrypoint(plan, {}), true);
  assert.throws(
    () => assertDirectPlanEntrypoint(plan, { npm_lifecycle_event: "field:prepare" }),
    /plan_requires_direct_node_entrypoint/,
  );
  assert.equal(
    assertDirectPlanEntrypoint(parseFieldPrepareArgs([]), { npm_lifecycle_event: "field:prepare" }),
    true,
  );
});

test("source roots accept equivalent Windows case and path spellings", () => {
  assert.equal(
    sameCanonicalSourceRoot(
      "D:\\a\\financial-brain-installer\\scripts\\..",
      "d:/A/FINANCIAL-BRAIN-INSTALLER/",
      "win32",
    ),
    true,
  );
});

test("source roots expand the GitHub Windows runner 8.3 temp alias", () => {
  const shortRoot = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\brain-field-plan-test-fixture";
  const longRoot = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\brain-field-plan-test-fixture";
  const otherRoot = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\another-checkout";
  const nativeCalls = [];
  const nativeRealpath = (value) => {
    nativeCalls.push(value);
    return value === shortRoot ? longRoot : value;
  };
  const portableRealpath = () => {
    throw new Error("Windows source roots must use the native resolver");
  };

  assert.equal(sameCanonicalSourceRoot(shortRoot, longRoot, "win32"), false);
  const canonicalShort = canonicalSourceRoot(shortRoot, {
    platform: "win32", nativeRealpath, portableRealpath,
  });
  const canonicalLong = canonicalSourceRoot(longRoot, {
    platform: "win32", nativeRealpath, portableRealpath,
  });
  const canonicalOther = canonicalSourceRoot(otherRoot, {
    platform: "win32", nativeRealpath, portableRealpath,
  });
  assert.deepEqual(nativeCalls, [shortRoot, longRoot, otherRoot]);
  assert.equal(sameCanonicalSourceRoot(canonicalShort, canonicalLong, "win32"), true);
  assert.equal(sameCanonicalSourceRoot(canonicalShort, canonicalOther, "win32"), false);
});

test("source roots reject different Windows directories", () => {
  assert.equal(
    sameCanonicalSourceRoot(
      "D:\\a\\financial-brain-installer",
      "D:\\a\\another-checkout",
      "win32",
    ),
    false,
  );
  assert.equal(
    sameCanonicalSourceRoot("D:\\a\\financial-brain-installer", "D:\\a\\financial-brain", "win32"),
    false,
  );
  assert.equal(
    sameCanonicalSourceRoot(
      "D:\\a\\financial-brain-installer",
      "D:\\a\\financial-brain-installer\\child",
      "win32",
    ),
    false,
  );
  assert.equal(
    sameCanonicalSourceRoot("D:\\a\\financial-brain-installer", "C:\\a\\financial-brain-installer", "win32"),
    false,
  );
  assert.equal(sameCanonicalSourceRoot("relative\\repo", "relative/repo", "win32"), false);
});

test("source roots preserve exact POSIX comparisons", () => {
  const exactRoot = canonicalSourceRoot("/tmp/Brain", {
    platform: "linux",
    nativeRealpath() {
      throw new Error("POSIX source roots must not use the Windows native resolver");
    },
    portableRealpath: (value) => value,
  });
  assert.equal(exactRoot, "/tmp/Brain");
  assert.equal(sameCanonicalSourceRoot("/tmp/Brain", "/tmp/Brain", "linux"), true);
  assert.equal(sameCanonicalSourceRoot("/tmp/Brain", "/tmp/brain", "linux"), false);
  assert.equal(sameCanonicalSourceRoot("/tmp/Brain", "/tmp/Brain/", "darwin"), false);
});

test("the command boundary refuses live modes, manifests, and mutating Cloudflare runners", () => {
  const full = buildStepPlan(parseFieldPrepareArgs([]));
  for (const step of full.filter((item) => !item.internal)) assert.equal(assertNoLiveCommand(step), true);
  assert.throws(() => assertNoLiveCommand({ command: "node", args: ["runner.mjs", "--live"] }), /unsafe/);
  assert.throws(() => assertNoLiveCommand({ command: "node", args: ["brain.mjs", "setup"] }), /unsafe/);
  assert.throws(() => assertNoLiveCommand({ command: "node", args: ["x.manifest.json"] }), /unsafe/);
});

test("the generated checklist keeps offline proof separate from human field gates", () => {
  const checklist = renderFieldChecklist({
    generated_at: "2026-08-31T00:00:00.000Z",
    status: "source_preparation_passed",
    source: {
      head_sha: "a".repeat(40), tree_sha: "b".repeat(40),
      package_name: "brain-installer", package_version: "0.2.1",
    },
    package: { filename: "brain-installer-0.2.1.tgz", bytes: 123, sha256: "c".repeat(64) },
  });
  assert.match(checklist, /Clean Windows owner profile/);
  assert.match(checklist, /Disposable Cloudflare Brain/);
  assert.match(checklist, /Plaid Sandbox through the deployed Brain/);
  assert.match(checklist, /QuickBooks Online Sandbox/);
  assert.match(checklist, /does not prove Cloudflare/i);
  assert.doesNotMatch(checklist, /--execute|--live/);
});

test("plan mode verifies candidate identity without running a planned step", async () => {
  const expectedSha = "a".repeat(40);
  let identityReads = 0;
  let commandRuns = 0;
  const plan = await runFieldPrepare(
    parseFieldPrepareArgs(["--plan", "--json", "--expect-sha", expectedSha]),
    {
      planEnvironment: { PATH: "/fixture/bin", GIT_OPTIONAL_LOCKS: "0" },
      readSourceIdentity(expected, environment) {
        identityReads += 1;
        assert.equal(expected, expectedSha);
        assert.equal(environment.GIT_OPTIONAL_LOCKS, "0");
        return {
          head_sha: expectedSha,
          tree_sha: "b".repeat(40),
          package_name: "brain-installer",
          package_version: "9.9.9",
          package_alignment: { aligned: true },
          package_lock_sha256: "c".repeat(64),
          working_tree_clean: true,
          shallow_repository: false,
          diff_check_clean: true,
          identity_stable_during_check: true,
        };
      },
      runCommand() {
        commandRuns += 1;
        throw new Error("plan_must_not_run_commands");
      },
    },
  );
  assert.equal(identityReads, 1);
  assert.equal(commandRuns, 0);
  assert.equal(plan.status, "plan_only");
  assert.equal(plan.candidate_binding.status, "verified");
  assert.equal(plan.candidate_binding.expected_sha, expectedSha);
  assert.equal(plan.candidate_binding.actual_sha, expectedSha);
  assert.equal(plan.candidate_binding.sha_matches, true);
  assert.equal(plan.candidate_binding.working_tree_clean, true);
  assert.equal(plan.candidate_binding.package_aligned, true);
  assert.equal(plan.live_actions, false);
  assert.equal(plan.reads_customer_manifest, false);
  assert.equal(plan.reads_credential_store, false);
  assert.equal(plan.steps_run, false);
  assert.equal(plan.output_created, false);
  assert.equal(plan.steps[0].id, "source-identity");
});

function makeInjectedIdentityReads({
  openingHead = "a".repeat(40),
  closingHead = openingHead,
  openingPackageVersion = "9.9.9",
  closingPackageVersion = openingPackageVersion,
} = {}) {
  const openingTree = "b".repeat(40);
  const closingTree = closingHead === openingHead ? openingTree : "d".repeat(40);
  const packageJsonBytes = Buffer.from(`${JSON.stringify({
    name: "brain-installer", version: openingPackageVersion,
  })}\n`);
  const closingPackageJsonBytes = Buffer.from(`${JSON.stringify({
    name: "brain-installer", version: closingPackageVersion,
  })}\n`);
  const packageLockBytes = Buffer.from(`${JSON.stringify({
    name: "brain-installer",
    version: openingPackageVersion,
    packages: { "": { name: "brain-installer", version: openingPackageVersion } },
  })}\n`);
  let headReads = 0;
  let packageJsonReads = 0;
  const treeRequests = [];
  return {
    openingHead,
    openingTree,
    packageJsonBytes,
    treeRequests,
    dependencies: {
      root: ROOT,
      git(args) {
        const [command, value] = args;
        if (command === "rev-parse" && value === "--show-toplevel") return ROOT;
        if (command === "rev-parse" && value === "HEAD") {
          return headReads++ === 0 ? openingHead : closingHead;
        }
        if (command === "rev-parse" && value.endsWith("^{tree}")) {
          treeRequests.push(value);
          return value === `${openingHead}^{tree}` ? openingTree : closingTree;
        }
        if (command === "rev-parse" && value === "--is-shallow-repository") return "false";
        if (command === "status") return "";
        throw new Error(`unexpected_git_read_${command}`);
      },
      diffCheck() {
        return { ok: true, stdout: "", stderr: "" };
      },
      exists() {
        return false;
      },
      readFile(path) {
        if (path === join(ROOT, "package.json")) {
          return packageJsonReads++ === 0 ? packageJsonBytes : closingPackageJsonBytes;
        }
        if (path === join(ROOT, "package-lock.json")) return packageLockBytes;
        throw new Error("unexpected_source_file_read");
      },
    },
  };
}

test("source identity binds each tree to its observed HEAD and refuses a mid-read HEAD change", () => {
  const closingHead = "c".repeat(40);
  const fixture = makeInjectedIdentityReads({ closingHead });
  assert.throws(
    () => readSourceIdentity(fixture.openingHead, {}, fixture.dependencies),
    (error) => {
      assert.equal(error.code, "source_identity_changed_during_check");
      assert.equal(error.sourceIdentity.head_sha, fixture.openingHead);
      assert.equal(error.sourceIdentity.tree_sha, fixture.openingTree);
      assert.equal(error.sourceIdentity.identity_stable_during_check, false);
      return true;
    },
  );
  assert.deepEqual(fixture.treeRequests, [
    `${fixture.openingHead}^{tree}`,
    `${closingHead}^{tree}`,
  ]);
});

test("source identity hashes the parsed package bytes and refuses a closing-byte change", () => {
  const fixture = makeInjectedIdentityReads({ closingPackageVersion: "9.9.8" });
  assert.throws(
    () => readSourceIdentity(fixture.openingHead, {}, fixture.dependencies),
    (error) => {
      assert.equal(error.code, "source_identity_changed_during_check");
      assert.equal(
        error.sourceIdentity.package_json_sha256,
        createHash("sha256").update(fixture.packageJsonBytes).digest("hex"),
      );
      assert.equal(error.sourceIdentity.package_version, "9.9.9");
      assert.equal(error.sourceIdentity.identity_stable_during_check, false);
      return true;
    },
  );
});

function gitEnvironment() {
  const environment = {};
  for (const name of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT"]) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}

function runFixtureGit(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: gitEnvironment() });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function commitFixture(root, message) {
  runFixtureGit(root, ["add", "."]);
  runFixtureGit(root, [
    "-c", "user.name=Field Fixture",
    "-c", "user.email=field-fixture@example.test",
    "commit", "--quiet", "-m", message,
  ]);
  return runFixtureGit(root, ["rev-parse", "HEAD"]);
}

function writeFixtureLock(root, version) {
  writeFileSync(join(root, "package-lock.json"), `${JSON.stringify({
    name: "brain-installer",
    version,
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "brain-installer", version } },
  }, null, 2)}\n`);
}

function makeCleanPlanFixture() {
  const root = mkdtempSync(join(tmpdir(), "brain-field-plan-test-"));
  mkdirSync(join(root, "scripts"));
  writeFileSync(
    join(root, "scripts", "field-prepare.mjs"),
    readFileSync(join(ROOT, "scripts", "field-prepare.mjs")),
  );
  writeFileSync(join(root, "package.json"), `${JSON.stringify({
    name: "brain-installer",
    version: "9.9.9",
    type: "module",
  }, null, 2)}\n`);
  writeFixtureLock(root, "9.9.9");
  runFixtureGit(root, ["init", "--quiet"]);
  return { root, sha: commitFixture(root, "clean plan fixture") };
}

function runPlanFixtureArgs(root, args, extraEnvironment = {}) {
  return spawnSync(process.execPath, ["scripts/field-prepare.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...gitEnvironment(),
      HOME: join(root, "private-home-that-must-not-be-read"),
      CLOUDFLARE_API_TOKEN: "fixture-secret-that-must-not-cross",
      CUSTOMER_MANIFEST: join(root, "missing.manifest.json"),
      ...extraEnvironment,
    },
  });
}

function runPlanFixture(root, sha) {
  return runPlanFixtureArgs(root, ["--plan", "--json", "--expect-sha", sha]);
}

test("JSON plan argument failures stay structured before parsing completes", () => {
  const fixture = makeCleanPlanFixture();
  try {
    const cases = [
      {
        args: ["--plan", "--json", "--expect-sha", "not-a-sha"],
        failureCode: "expect_sha_invalid",
      },
      {
        args: ["--plan", "--json", "--expect-sha"],
        failureCode: "expect_sha_value_required",
      },
      {
        args: ["--plan", "--json", "--unknown-plan-option"],
        failureCode: "unknown_option",
      },
    ];
    for (const fixtureCase of cases) {
      const result = runPlanFixtureArgs(fixture.root, fixtureCase.args);
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.equal(result.stderr, "");
      const refusal = JSON.parse(result.stdout);
      assert.equal(refusal.status, "refused");
      assert.equal(refusal.failure_code, fixtureCase.failureCode);
      assert.equal(refusal.candidate_binding.status, "refused_arguments");
      assert.equal(refusal.candidate_binding.expected_sha, null);
      assert.equal(refusal.candidate_binding.actual_sha, null);
      assert.equal(refusal.steps_run, false);
      assert.equal(refusal.output_created, false);
    }
    assert.equal(existsSync(join(fixture.root, ".field-prepare")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the npm execution entrypoint refuses plan mode before source inspection", () => {
  const fixture = makeCleanPlanFixture();
  try {
    const result = runPlanFixtureArgs(
      fixture.root,
      ["--plan", "--json", "--expect-sha", fixture.sha],
      { npm_lifecycle_event: "field:prepare" },
    );
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const refusal = JSON.parse(result.stdout);
    assert.equal(refusal.failure_code, "plan_requires_direct_node_entrypoint");
    assert.equal(refusal.candidate_binding.status, "refused_entrypoint");
    assert.equal(refusal.candidate_binding.expected_sha, fixture.sha);
    assert.equal(refusal.candidate_binding.actual_sha, null);
    assert.equal(existsSync(join(fixture.root, ".field-prepare")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("CLI plan binds a clean checkout and returns structured refusals without output", () => {
  const fixture = makeCleanPlanFixture();
  try {
    const outputRoot = join(fixture.root, ".field-prepare");
    const cleanIndex = readFileSync(join(fixture.root, ".git", "index"));
    const success = runPlanFixture(fixture.root, fixture.sha);
    assert.equal(success.status, 0, `${success.stdout}\n${success.stderr}`);
    const plan = JSON.parse(success.stdout);
    assert.equal(plan.candidate_binding.status, "verified");
    assert.equal(plan.candidate_binding.expected_sha, fixture.sha);
    assert.equal(plan.candidate_binding.actual_sha, fixture.sha);
    assert.equal(plan.candidate_binding.working_tree_clean, true);
    assert.equal(plan.candidate_binding.package_aligned, true);
    assert.equal(plan.source.package_alignment.aligned, true);
    assert.equal(plan.steps.length > 0, true);
    assert.equal(plan.steps_run, false);
    assert.equal(plan.output_created, false);
    assert.equal(existsSync(outputRoot), false);
    assert.deepEqual(readFileSync(join(fixture.root, ".git", "index")), cleanIndex);
    assert.doesNotMatch(success.stdout, /fixture-secret-that-must-not-cross|\.manifest\.json/i);

    const differentSha = fixture.sha === "f".repeat(40) ? "e".repeat(40) : "f".repeat(40);
    const mismatch = runPlanFixture(fixture.root, differentSha);
    assert.equal(mismatch.status, 1, `${mismatch.stdout}\n${mismatch.stderr}`);
    const mismatchReceipt = JSON.parse(mismatch.stdout);
    assert.equal(mismatchReceipt.status, "refused");
    assert.equal(mismatchReceipt.failure_code, "expected_source_sha_mismatch");
    assert.equal(mismatchReceipt.candidate_binding.status, "refused_sha_mismatch");
    assert.equal(mismatchReceipt.candidate_binding.expected_sha, differentSha);
    assert.equal(mismatchReceipt.candidate_binding.actual_sha, fixture.sha);
    assert.equal(mismatchReceipt.candidate_binding.sha_matches, false);
    assert.equal(mismatchReceipt.steps_run, false);
    assert.equal(mismatchReceipt.output_created, false);
    assert.equal(existsSync(outputRoot), false);
    assert.deepEqual(readFileSync(join(fixture.root, ".git", "index")), cleanIndex);

    writeFileSync(join(fixture.root, "untracked.fixture"), "dirty\n");
    const dirty = runPlanFixture(fixture.root, fixture.sha);
    assert.equal(dirty.status, 1, `${dirty.stdout}\n${dirty.stderr}`);
    const dirtyReceipt = JSON.parse(dirty.stdout);
    assert.equal(dirtyReceipt.failure_code, "working_tree_not_clean");
    assert.equal(dirtyReceipt.candidate_binding.actual_sha, fixture.sha);
    assert.equal(dirtyReceipt.candidate_binding.sha_matches, true);
    assert.equal(dirtyReceipt.candidate_binding.working_tree_clean, false);
    assert.equal(existsSync(outputRoot), false);
    assert.deepEqual(readFileSync(join(fixture.root, ".git", "index")), cleanIndex);

    rmSync(join(fixture.root, "untracked.fixture"));
    writeFixtureLock(fixture.root, "9.9.8");
    const misalignedSha = commitFixture(fixture.root, "misaligned package lock fixture");
    const misaligned = runPlanFixture(fixture.root, misalignedSha);
    assert.equal(misaligned.status, 1, `${misaligned.stdout}\n${misaligned.stderr}`);
    const misalignedReceipt = JSON.parse(misaligned.stdout);
    assert.equal(misalignedReceipt.failure_code, "package_lock_identity_mismatch");
    assert.equal(misalignedReceipt.candidate_binding.actual_sha, misalignedSha);
    assert.equal(misalignedReceipt.candidate_binding.package_aligned, false);
    assert.equal(existsSync(outputRoot), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("package scripts expose only the offline execution entrypoint", () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["field:prepare"], "node scripts/field-prepare.mjs");
  const help = spawnSync(process.execPath, ["scripts/field-prepare.mjs", "--help"], {
    cwd: ROOT,
    encoding: "utf8",
    env: gitEnvironment(),
  });
  assert.equal(help.status, 0, `${help.stdout}\n${help.stderr}`);
  assert.match(help.stdout, /Read-only raw JSON plan:[\s\S]*node scripts\/field-prepare\.mjs --plan --json/);
  assert.match(help.stdout, /Offline preparation execution:[\s\S]*npm run field:prepare/);
  assert.match(help.stdout, /--plan\s+direct Node only/);
});
