import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  baselineFromReport,
  compareBaseline,
  createHistoryGitEnvironment,
  evaluateStrictRelease,
  gitFailureDiagnostic,
  GIT_HISTORY_TEXT_OUTPUT_LIMIT_BYTES,
  GIT_HISTORY_TIMEOUT_MS,
  scanRepository,
} from "../scripts/scan-git-history-privacy.mjs";
import {
  buildIdentityIndex,
  compileIdentityRule,
  scanIdentityText,
} from "../scripts/privacy-identity.mjs";

const sandbox = mkdtempSync(join(tmpdir(), "brain-history-privacy-"));
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function gitAt(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH || "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
  });
  assert.equal(result.status, 0, result.stderr || `git ${args[0]} failed`);
  return result.stdout.trim();
}

function gitAtInput(cwd, args, input) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    env: {
      PATH: process.env.PATH || "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
  });
  assert.equal(result.status, 0, result.stderr || `git ${args[0]} failed`);
  return result.stdout.trim();
}

function git(args) {
  return gitAt(sandbox, args);
}

test.before(() => {
  git(["init", "--initial-branch=main"]);
  git(["config", "user.name", "History Test"]);
  git(["config", "user.email", "history-test@example.test"]);

  writeFileSync(join(sandbox, "README.md"), "synthetic history scanner repository\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "Create synthetic repository"]);

  const directory = join(sandbox, "records");
  mkdirSync(directory);
  const credentialShape = ["github", "pat", "A".repeat(52)].join("_");
  writeFileSync(
    join(directory, "ZzqHistoryCanary.txt"),
    `ZzqHistoryCanary\n${credentialShape}\n`,
  );
  writeFileSync(join(directory, `${credentialShape}.txt`), "credential-shaped path canary\n");
  git(["add", "records/ZzqHistoryCanary.txt"]);
  git(["commit", "-m", "Add synthetic historical incident"]);

  rmSync(join(directory, "ZzqHistoryCanary.txt"));
  rmSync(join(directory, `${credentialShape}.txt`));
  writeFileSync(join(sandbox, "README.md"), "current tree is clean but history is not\n");
  git(["add", "-A"]);
  git(["commit", "-m", "Remove synthetic historical incident from the tip"]);
  git(["tag", "v1-test"]);
});

test.after(() => rmSync(sandbox, { recursive: true, force: true }));

test("history Git failures are bounded, offline, and never echo partial output", () => {
  const environment = createHistoryGitEnvironment({
    PATH: "/fixture/bin",
    GIT_NO_LAZY_FETCH: "0",
    GIT_ASKPASS: "/private/credential-helper",
  });
  assert.equal(environment.PATH, "/fixture/bin");
  assert.equal(environment.GIT_NO_LAZY_FETCH, "1");
  assert.equal(environment.GIT_OPTIONAL_LOCKS, "0");
  assert.equal(environment.GIT_ASKPASS, undefined);

  const privatePartialOutput = `private/history/path\n${"x".repeat(2 * 1024 * 1024)}`;
  const timedOut = gitFailureDiagnostic(["rev-list", "--objects"], {
    status: null,
    signal: "SIGTERM",
    error: { code: "ETIMEDOUT" },
    stdout: privatePartialOutput,
    stderr: "private/history/error",
  });
  assert.equal(timedOut, `git rev-list timed out after ${GIT_HISTORY_TIMEOUT_MS} ms`);
  assert.equal(timedOut.includes("private/history"), false);

  const overLimit = gitFailureDiagnostic(["rev-list", "--objects"], {
    status: null,
    signal: "SIGTERM",
    error: { code: "ENOBUFS" },
    stdout: privatePartialOutput,
    stderr: "private/history/error",
  });
  assert.equal(overLimit,
    `git rev-list exceeded the ${GIT_HISTORY_TEXT_OUTPUT_LIMIT_BYTES}-byte output limit`);
  assert.equal(overLimit.includes("private/history"), false);

  const exited = gitFailureDiagnostic(["cat-file", "--batch"], {
    status: 128,
    stdout: privatePartialOutput,
    stderr: "private/history/error",
  });
  assert.equal(exited, "git cat-file failed with exit status 128");
  assert.equal(exited.includes("private/history"), false);
});

test("a partial clone refuses absent history blobs without fetching or naming them", () => {
  const container = mkdtempSync(join(tmpdir(), "brain-history-partial-"));
  const repository = join(container, "publisher");
  const remote = join(container, "origin.git");
  const partial = join(container, "partial");
  const privateName = "ZzqPartialHistoryCanary.txt";
  const privateBody = "ZzqPartialHistoryCanary private historical body\n";
  try {
    gitAt(container, ["init", "--bare", remote]);
    gitAt(remote, ["config", "uploadpack.allowFilter", "true"]);
    gitAt(container, ["init", "--initial-branch=main", repository]);
    gitAt(repository, ["config", "user.name", "History Test"]);
    gitAt(repository, ["config", "user.email", "history-test@example.test"]);
    writeFileSync(join(repository, privateName), privateBody);
    gitAt(repository, ["add", privateName]);
    gitAt(repository, ["commit", "-m", "Add partial-clone history canary"]);
    rmSync(join(repository, privateName));
    writeFileSync(join(repository, "README.md"), "current partial-clone tip\n");
    gitAt(repository, ["add", "-A"]);
    gitAt(repository, ["commit", "-m", "Remove partial-clone history canary"]);
    gitAt(repository, ["remote", "add", "origin", remote]);
    gitAt(repository, ["push", "origin", "main"]);

    const cloned = spawnSync("git", [
      "clone", "--filter=blob:none", "--no-checkout", "--branch", "main",
      pathToFileURL(remote).href, partial,
    ], {
      encoding: "utf8",
      env: createHistoryGitEnvironment(process.env),
    });
    assert.equal(cloned.status, 0, cloned.stderr || cloned.stdout);

    const missing = spawnSync("git", [
      "rev-list", "--objects", "--missing=print", "--no-object-names", "HEAD",
    ], {
      cwd: partial,
      encoding: "utf8",
      env: createHistoryGitEnvironment(process.env),
    });
    assert.equal(missing.status, 0, missing.stderr || missing.stdout);
    assert.match(missing.stdout, /^\?[0-9a-f]{40,64}$/m);
    assert.equal(missing.stdout.includes(privateName), false);

    const packDirectory = join(partial, ".git", "objects", "pack");
    const packsBefore = readdirSync(packDirectory).sort();
    let refusal;
    try {
      scanRepository({
        repo: partial,
        refPrefixes: [],
        refs: ["HEAD"],
        identityIndex: buildIdentityIndex([]),
      });
      assert.fail("partial history unexpectedly scanned without its promised blob");
    } catch (error) {
      refusal = error;
    }
    assert.equal(
      refusal.message,
      "full-history privacy scanning requires every selected object to be present locally",
    );
    assert.equal(refusal.message.includes(privateName), false);
    assert.equal(refusal.message.includes(privateBody.trim()), false);
    assert.deepEqual(readdirSync(packDirectory).sort(), packsBefore,
      "the refusal must not materialize another promisor pack");
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

test("direct and annotated non-commit refs retain full paths and transitive reachability", () => {
  const container = mkdtempSync(join(tmpdir(), "brain-history-noncommit-"));
  const repository = join(container, "work");
  const pathCanary = "ZzqTreeRefPathCanary";
  const contentCanary = "ZzqBlobRefContentCanary";
  try {
    gitAt(container, ["init", "--initial-branch=main", repository]);
    gitAt(repository, ["config", "user.name", "History Test"]);
    gitAt(repository, ["config", "user.email", "history-test@example.test"]);

    const nested = join(repository, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, `${pathCanary}.txt`), "path-only tree ref fixture\n");
    gitAt(repository, ["add", `nested/${pathCanary}.txt`]);
    const treeId = gitAt(repository, ["write-tree"]);
    gitAt(repository, ["update-ref", "refs/tags/direct-tree", treeId]);
    gitAt(repository, ["tag", "-a", "annotated-tree", treeId, "-m", "tree fixture"]);

    const blobSource = join(repository, "blob-source.txt");
    writeFileSync(blobSource, `${contentCanary}\n`);
    const blobId = gitAt(repository, ["hash-object", "-w", "blob-source.txt"]);
    rmSync(blobSource);
    gitAt(repository, ["update-ref", "refs/tags/direct-blob", blobId]);
    gitAt(repository, ["tag", "-a", "annotated-blob", blobId, "-m", "blob fixture"]);

    const report = scanRepository({
      repo: repository,
      refPrefixes: [],
      refs: [
        "refs/tags/direct-tree",
        "refs/tags/annotated-tree",
        "refs/tags/direct-blob",
        "refs/tags/annotated-blob",
      ],
      identityIndex: buildIdentityIndex([
        compileIdentityRule("tree ref path", "word", false, pathCanary),
        compileIdentityRule("blob ref content", "word", false, contentCanary),
      ]),
    });

    assert.equal(report.inventory.public_ref_count, 4);
    assert.equal(report.inventory.commit_count, 0);
    const pathFinding = report.finding_objects.find((finding) =>
      finding.classifications.some((classification) =>
        classification.kind === "privacy" && classification.category === "tree ref path"));
    assert(pathFinding);
    assert.deepEqual(pathFinding.locations, ["path"]);
    assert.deepEqual(pathFinding.reachable_from, [
      "refs/tags/annotated-tree", "refs/tags/direct-tree",
    ]);

    const contentFinding = report.finding_objects.find((finding) =>
      finding.classifications.some((classification) =>
        classification.kind === "privacy" && classification.category === "blob ref content"));
    assert(contentFinding);
    assert.deepEqual(contentFinding.locations, ["content"]);
    assert.deepEqual(contentFinding.reachable_from, [
      "refs/tags/annotated-blob", "refs/tags/direct-blob",
    ]);
    assert.deepEqual(
      report.affected_public_refs.map((entry) => entry.ref).sort(),
      [
        "refs/tags/annotated-blob", "refs/tags/annotated-tree",
        "refs/tags/direct-blob", "refs/tags/direct-tree",
      ],
    );

    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(pathCanary), false);
    assert.equal(serialized.includes(contentCanary), false);
    assert.equal(serialized.includes("nested/"), false);
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

test("empty-tree and gitlink leaf paths remain findings on reachable tree objects", () => {
  const container = mkdtempSync(join(tmpdir(), "brain-history-tree-leaves-"));
  const repository = join(container, "work");
  const emptyTreeCanary = "ZzqEmptyTreePathCanary";
  const gitlinkCanary = "ZzqGitlinkPathCanary";
  try {
    gitAt(container, ["init", "--initial-branch=main", repository]);
    gitAt(repository, ["config", "user.name", "History Test"]);
    gitAt(repository, ["config", "user.email", "history-test@example.test"]);
    const objectFormat = gitAt(repository, ["rev-parse", "--show-object-format"]);
    const objectIdLength = objectFormat === "sha256" ? 64 : 40;
    const emptyTree = gitAtInput(repository, ["mktree"], "");
    const absentGitlink = "1".repeat(objectIdLength);
    const rootTree = gitAtInput(repository, ["mktree", "--missing"], [
      `040000 tree ${emptyTree}\t${emptyTreeCanary}`,
      `160000 commit ${absentGitlink}\t${gitlinkCanary}`,
      "",
    ].join("\n"));
    gitAt(repository, ["update-ref", "refs/tags/direct-tree-leaves", rootTree]);
    gitAt(repository, [
      "tag", "-a", "annotated-tree-leaves", rootTree, "-m", "tree leaf fixtures",
    ]);

    const report = scanRepository({
      repo: repository,
      refPrefixes: [],
      refs: ["refs/tags/direct-tree-leaves", "refs/tags/annotated-tree-leaves"],
      identityIndex: buildIdentityIndex([
        compileIdentityRule("empty tree path", "word", false, emptyTreeCanary),
        compileIdentityRule("gitlink path", "word", false, gitlinkCanary),
      ]),
    });

    const emptyTreeFinding = report.finding_objects.find((finding) =>
      finding.classifications.some((classification) =>
        classification.kind === "privacy" && classification.category === "empty tree path"));
    assert(emptyTreeFinding);
    assert.equal(emptyTreeFinding.object_type, "tree");
    assert.deepEqual(emptyTreeFinding.locations, ["path"]);
    assert.deepEqual(emptyTreeFinding.reachable_from, [
      "refs/tags/annotated-tree-leaves", "refs/tags/direct-tree-leaves",
    ]);

    const gitlinkFinding = report.finding_objects.find((finding) =>
      finding.classifications.some((classification) =>
        classification.kind === "privacy" && classification.category === "gitlink path"));
    assert(gitlinkFinding);
    assert.equal(gitlinkFinding.object_type, "tree");
    assert.deepEqual(gitlinkFinding.locations, ["path"]);
    assert.deepEqual(gitlinkFinding.reachable_from, [
      "refs/tags/annotated-tree-leaves", "refs/tags/direct-tree-leaves",
    ]);
    assert.deepEqual(
      report.affected_public_refs.map((entry) => entry.ref).sort(),
      ["refs/tags/annotated-tree-leaves", "refs/tags/direct-tree-leaves"],
    );

    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(emptyTreeCanary), false);
    assert.equal(serialized.includes(gitlinkCanary), false);
    assert.equal(serialized.includes(absentGitlink), false);
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

test("a partial direct-tree ref refuses missing descendants with object-only diagnostics", () => {
  const container = mkdtempSync(join(tmpdir(), "brain-history-partial-tree-"));
  const repository = join(container, "publisher");
  const remote = join(container, "origin.git");
  const partial = join(container, "partial");
  const privateName = "ZzqPartialTreePathCanary.txt";
  const privateBody = "private direct-tree body\n";
  try {
    gitAt(container, ["init", "--bare", remote]);
    gitAt(remote, ["config", "uploadpack.allowFilter", "true"]);
    gitAt(container, ["init", "--initial-branch=main", repository]);
    gitAt(repository, ["config", "user.name", "History Test"]);
    gitAt(repository, ["config", "user.email", "history-test@example.test"]);
    const nested = join(repository, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, privateName), privateBody);
    gitAt(repository, ["add", `nested/${privateName}`]);
    const treeId = gitAt(repository, ["write-tree"]);
    gitAt(repository, ["update-ref", "refs/tags/direct-tree", treeId]);
    gitAt(repository, ["remote", "add", "origin", remote]);
    gitAt(repository, ["push", "origin", "refs/tags/direct-tree"]);

    gitAt(container, ["init", partial]);
    gitAt(partial, ["remote", "add", "origin", remote]);
    gitAt(partial, [
      "-c", "protocol.file.allow=always", "fetch", "--filter=blob:none", "--no-tags",
      "origin", "refs/tags/direct-tree:refs/tags/direct-tree",
    ]);

    const enumerated = spawnSync("git", [
      "rev-list", "--objects", "--missing=print", "--no-object-names", "--stdin",
    ], {
      cwd: partial,
      encoding: "utf8",
      input: "refs/tags/direct-tree\n",
      env: createHistoryGitEnvironment(process.env),
    });
    assert.equal(enumerated.status, 0, enumerated.stderr || enumerated.stdout);
    const lines = enumerated.stdout.trim().split("\n").filter(Boolean);
    assert(lines.some((line) => /^\?[0-9a-f]{40,64}$/.test(line)));
    assert(lines.every((line) => /^\??[0-9a-f]{40,64}$/.test(line)));
    assert.equal(enumerated.stdout.includes(privateName), false);
    assert.equal(enumerated.stdout.includes(privateBody.trim()), false);

    const packDirectory = join(partial, ".git", "objects", "pack");
    const packsBefore = readdirSync(packDirectory).sort();
    let refusal;
    try {
      scanRepository({
        repo: partial,
        refPrefixes: [],
        refs: ["refs/tags/direct-tree"],
        identityIndex: buildIdentityIndex([]),
      });
      assert.fail("partial direct-tree history unexpectedly scanned without its blob");
    } catch (error) {
      refusal = error;
    }
    assert.equal(
      refusal.message,
      "full-history privacy scanning requires every selected object to be present locally",
    );
    assert.equal(refusal.message.includes(privateName), false);
    assert.equal(refusal.message.includes(privateBody.trim()), false);
    assert.doesNotMatch(refusal.message, /[0-9a-f]{40,64}/);
    assert.deepEqual(readdirSync(packDirectory).sort(), packsBefore,
      "the refusal must not materialize another promisor pack");
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

test("scans reachable historical blobs after the current tree is clean", () => {
  const identityIndex = buildIdentityIndex([
    compileIdentityRule("synthetic identity", "word", false, "ZzqHistoryCanary"),
  ]);
  const report = scanRepository({
    repo: sandbox,
    refPrefixes: ["refs/heads", "refs/tags"],
    identityIndex,
  });

  assert.equal(report.inventory.public_ref_count, 2);
  assert.equal(report.inventory.commit_count, 3);
  assert(report.categories.some((entry) =>
    entry.kind === "privacy" && entry.category === "synthetic identity"));
  assert(report.categories.some((entry) =>
    entry.kind === "credential_candidate" && entry.category === "github_fine_grained"));
  assert(report.finding_objects.some((entry) =>
    entry.classifications.some((classification) =>
      classification.kind === "credential_candidate" && classification.category === "github_fine_grained") &&
    entry.locations.includes("path")));
  assert(report.finding_objects.every((entry) => entry.reachable_from.length > 0));

  const serialized = JSON.stringify(report);
  assert(!serialized.includes("ZzqHistoryCanary"));
  assert(!serialized.includes(["github", "pat", "A".repeat(52)].join("_")));
  assert(!serialized.includes("records/"));
});

test("baseline comparison is exact and stores no matched values", () => {
  const identityIndex = buildIdentityIndex([
    compileIdentityRule("synthetic identity", "word", false, "ZzqHistoryCanary"),
  ]);
  const report = scanRepository({
    repo: sandbox,
    refPrefixes: ["refs/heads", "refs/tags"],
    identityIndex,
  });
  const baseline = baselineFromReport(report);
  assert.equal(compareBaseline(report, baseline).matches, true);
  assert(!JSON.stringify(baseline).includes("ZzqHistoryCanary"));

  const changed = structuredClone(baseline);
  changed.finding_objects.pop();
  assert.equal(compareBaseline(report, changed).matches, false);
});

test("strict release review never allowlists privacy or revoked credentials", () => {
  const identityIndex = buildIdentityIndex([
    compileIdentityRule("synthetic identity", "word", false, "ZzqHistoryCanary"),
  ]);
  const report = scanRepository({
    repo: sandbox,
    refPrefixes: ["refs/heads", "refs/tags"],
    identityIndex,
  });
  assert.equal(evaluateStrictRelease(report, {
    schema_version: 1,
    approved_candidates: [],
  }).passes, false);

  const candidateOnly = structuredClone(report);
  candidateOnly.finding_objects = candidateOnly.finding_objects
    .map((finding) => ({
      ...finding,
      classifications: finding.classifications.filter((entry) =>
        entry.kind === "credential_candidate"),
    }))
    .filter((finding) => finding.classifications.length);
  const approved = candidateOnly.finding_objects.flatMap((finding) =>
    finding.classifications.map((entry) => ({
      object_id: finding.object_id,
      category: entry.category,
      disposition: "synthetic_fixture",
    })));
  assert.equal(evaluateStrictRelease(candidateOnly, {
    schema_version: 1,
    approved_candidates: approved,
  }).passes, true);

  approved.push({
    object_id: "0".repeat(40),
    category: "stale-example",
    disposition: "synthetic_fixture",
  });
  assert.equal(evaluateStrictRelease(candidateOnly, {
    schema_version: 1,
    approved_candidates: approved,
  }).passes, false);
  const localFieldResult = evaluateStrictRelease(candidateOnly, {
    schema_version: 1,
    approved_candidates: approved,
  }, { allowStaleDispositions: true });
  assert.equal(localFieldResult.passes, true);
  assert.equal(localFieldResult.stale_disposition_count, 1);
  assert.equal(localFieldResult.stale_dispositions_tolerated, true);

  assert.equal(evaluateStrictRelease(report, {
    schema_version: 1,
    approved_candidates: approved,
  }, { allowStaleDispositions: true }).passes, false,
  "local field tolerance must not allow privacy or unapproved findings");
});

test("stale dispositions are tolerated only by the exact local field-preparation invocation", () => {
  const scanner = join(root, "scripts/scan-git-history-privacy.mjs");
  const dispositions = join(sandbox, "stale-dispositions.json");
  writeFileSync(dispositions, `${JSON.stringify({
    schema_version: 1,
    approved_candidates: [{
      object_id: "0".repeat(40),
      category: "env_assignment",
      disposition: "synthetic_fixture",
    }],
  })}\n`);
  const baseArgs = [
    scanner,
    "--repo", sandbox,
    "--ref", "HEAD~2",
    "--require-clean",
    "--credential-dispositions", dispositions,
  ];

  const ordinaryStrict = spawnSync(process.execPath, baseArgs, { encoding: "utf8" });
  assert.equal(ordinaryStrict.status, 1, ordinaryStrict.stdout || ordinaryStrict.stderr);
  assert.match(ordinaryStrict.stderr, /1 stale credential disposition/);

  const unscopedTolerance = spawnSync(process.execPath, [
    ...baseArgs,
    "--allow-stale-dispositions-for-local-field-prep",
  ], { encoding: "utf8" });
  assert.equal(unscopedTolerance.status, 1, unscopedTolerance.stdout || unscopedTolerance.stderr);
  assert.match(unscopedTolerance.stderr, /restricted to exact local HEAD field preparation/);

  const wrongRefTolerance = spawnSync(process.execPath, [
    ...baseArgs,
    "--allow-stale-dispositions-for-local-field-prep",
  ], {
    encoding: "utf8",
    env: { ...process.env, BRAIN_FIELD_PREPARE: "1" },
  });
  assert.equal(wrongRefTolerance.status, 1, wrongRefTolerance.stdout || wrongRefTolerance.stderr);
  assert.match(wrongRefTolerance.stderr, /restricted to exact local HEAD field preparation/);

  const remoteTolerance = spawnSync(process.execPath, [
    scanner,
    "--repo", sandbox,
    "--remote", "origin",
    "--ref", "HEAD",
    "--require-clean",
    "--credential-dispositions", dispositions,
    "--allow-stale-dispositions-for-local-field-prep",
  ], {
    encoding: "utf8",
    env: { ...process.env, BRAIN_FIELD_PREPARE: "1" },
  });
  assert.equal(remoteTolerance.status, 1, remoteTolerance.stdout || remoteTolerance.stderr);
  assert.match(remoteTolerance.stderr, /restricted to exact local HEAD field preparation/);

  const activeFindings = spawnSync(process.execPath, [
    scanner,
    "--repo", sandbox,
    "--ref", "HEAD",
    "--require-clean",
    "--credential-dispositions", dispositions,
    "--allow-stale-dispositions-for-local-field-prep",
  ], {
    encoding: "utf8",
    env: { ...process.env, BRAIN_FIELD_PREPARE: "1" },
  });
  assert.equal(activeFindings.status, 1, activeFindings.stdout || activeFindings.stderr);
  assert.match(activeFindings.stderr, /[1-9][0-9]* blocking object/,
    "field tolerance must still fail active privacy and unapproved findings");

  const cleanContainer = mkdtempSync(join(tmpdir(), "brain-history-clean-head-"));
  const cleanCheckout = join(cleanContainer, "work");
  gitAt(sandbox, ["worktree", "add", "--detach", cleanCheckout, "HEAD~2"]);
  try {
    const scopedTolerance = spawnSync(process.execPath, [
      scanner,
      "--repo", cleanCheckout,
      "--ref", "HEAD",
      "--require-clean",
      "--credential-dispositions", dispositions,
      "--allow-stale-dispositions-for-local-field-prep",
    ], {
      encoding: "utf8",
      env: { ...process.env, BRAIN_FIELD_PREPARE: "1" },
    });
    assert.equal(scopedTolerance.status, 0, scopedTolerance.stderr || scopedTolerance.stdout);
    assert.match(scopedTolerance.stdout, /local field-preparation gate found no blocking objects/);
  } finally {
    gitAt(sandbox, ["worktree", "remove", "--force", cleanCheckout]);
    rmSync(cleanContainer, { recursive: true, force: true });
  }
});

test("zero-finding policy rejects even a reviewable synthetic candidate", () => {
  const scanner = join(root, "scripts/scan-git-history-privacy.mjs");
  const blocked = spawnSync(process.execPath, [
    scanner,
    "--repo", sandbox,
    "--ref", "main",
    "--require-zero-findings",
  ], { encoding: "utf8" });
  assert.equal(blocked.status, 1, blocked.stdout || blocked.stderr);
  assert.match(blocked.stderr, /zero-finding history gate found [1-9][0-9]* finding object/);

  const clean = spawnSync(process.execPath, [
    scanner,
    "--repo", sandbox,
    "--ref", "main~2",
    "--require-zero-findings",
  ], { encoding: "utf8" });
  assert.equal(clean.status, 0, clean.stderr || clean.stdout);
  assert.match(clean.stdout, /exactly 0 finding objects/);
});

test("predecessor incident metadata stays sanitized but is not an active gate", () => {
  const baseline = JSON.parse(readFileSync(join(root, "privacy/history-baseline.json"), "utf8"));
  assert.equal(baseline.schema_version, 1);
  assert(baseline.finding_objects.length > 0);
  for (const finding of baseline.finding_objects) {
    assert.deepEqual(Object.keys(finding).sort(), [
      "classifications",
      "locations",
      "object_id",
      "object_type",
    ]);
    assert.match(finding.object_id, /^[0-9a-f]{40,64}$/);
    assert(finding.classifications.every((entry) =>
      ["privacy", "credential_candidate", "known_revoked_credential"].includes(entry.kind)));
    assert(finding.locations.every((location) => ["content", "message", "path"].includes(location)));
  }

  const refs = JSON.parse(readFileSync(join(root, "privacy/public-refs.json"), "utf8"));
  assert.equal(refs.schema_version, 1);
  assert(refs.refs.length > 0);
  assert(refs.refs.every((entry) =>
    scanIdentityText(entry.public_ref).length === 0 &&
    scanIdentityText(entry.local_ref).length === 0));

  // This used to assert the file was EMPTY, which pinned a state rather than a
  // property: the moment a real candidate was reviewed and recorded, the test
  // failed for doing the right thing. What actually matters is that every entry
  // is well formed, carries an allowed disposition, and leaks nothing itself.
  // A disposition file is read by humans deciding whether to trust a release,
  // so it is exactly the kind of metadata that must stay sanitized.
  const dispositions = JSON.parse(readFileSync(join(root, "privacy/credential-dispositions.json"), "utf8"));
  assert.equal(dispositions.schema_version, 1);
  assert(Array.isArray(dispositions.approved_candidates));
  const ALLOWED = ["synthetic_fixture", "scanner_source", "public_documentation_example", "secret_name_constant"];
  const seen = new Set();
  for (const entry of dispositions.approved_candidates) {
    assert.deepEqual(Object.keys(entry).sort(), ["category", "disposition", "object_id", "path", "reason"]);
    assert.match(entry.object_id, /^[0-9a-f]{40,64}$/);
    assert(ALLOWED.includes(entry.disposition), `unknown disposition ${entry.disposition}`);
    assert(entry.category.length > 0 && entry.reason.length > 0);
    // Never allowlist a privacy finding by mislabelling it a credential.
    assert(!/privacy/i.test(entry.category), `${entry.category} is not a credential category`);
    // The file itself must not become a leak: no identity in a path or a reason.
    assert.equal(scanIdentityText(entry.path).length, 0, `identity in disposition path ${entry.path}`);
    assert.equal(scanIdentityText(entry.reason).length, 0, "identity in a disposition reason");
    const key = `${entry.object_id}:${entry.category}`;
    assert(!seen.has(key), `duplicate disposition for ${key}`);
    seen.add(key);
  }

  // The release gate runs --require-clean, not --require-zero-findings.
  // --require-zero-findings does not read the disposition file at all: it counts
  // findings and fails if there are any, so no repository holding a single test
  // fixture with a token-shaped string can ever pass it. That made the gate
  // permanently red rather than usefully red. --require-clean still refuses
  // EVERY privacy finding and EVERY known-revoked credential; the only thing it
  // allows through is a credential candidate a human has reviewed and recorded
  // above. Requiring the strict mode by name is what stops a future edit
  // quietly swapping in --baseline, which would accept whatever is already there.
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  for (const name of ["privacy:history", "privacy:history:remote", "privacy:history:strict"]) {
    assert.match(scripts[name], /--require-clean/, `${name} must run the strict release gate`);
    assert.doesNotMatch(scripts[name], /--baseline|--record-baseline|--require-zero-findings/,
      `${name} must not accept a recorded baseline in place of a reviewed judgement`);
    assert.doesNotMatch(scripts[name], /history-baseline|public-refs|credential-dispositions/);
  }
  assert.match(scripts["privacy:history"], /--ref HEAD/);
  assert.match(scripts["privacy:history:field"], /--ref HEAD/);
  assert.match(scripts["privacy:history:field"], /--require-clean/);
  assert.match(scripts["privacy:history:field"], /--allow-stale-dispositions-for-local-field-prep/);
  assert.doesNotMatch(scripts["privacy:history:field"],
    /--remote|--baseline|--record-baseline|--require-zero-findings/);
  assert.match(scripts["privacy:history:remote"], /--remote origin/);
  assert.match(scripts["privacy:history:remote"], /--ref HEAD/);
});

test("remote scan bootstraps from an exact checked-out object without a tracking ref", () => {
  const container = mkdtempSync(join(tmpdir(), "brain-history-bootstrap-"));
  const repository = join(container, "work");
  const remote = join(container, "origin.git");
  const publisher = join(container, "publisher");
  try {
    mkdirSync(repository);
    gitAt(container, ["init", "--bare", remote]);
    gitAt(repository, ["init", "--initial-branch=main"]);
    gitAt(repository, ["config", "user.name", "History Test"]);
    gitAt(repository, ["config", "user.email", "history-test@example.test"]);
    writeFileSync(join(repository, "README.md"), "clean bootstrap history\n");
    gitAt(repository, ["add", "README.md"]);
    gitAt(repository, ["commit", "-m", "Create clean bootstrap"]);
    gitAt(repository, ["remote", "add", "origin", remote]);
    gitAt(repository, ["push", "origin", "main"]);
    gitAt(repository, ["update-ref", "-d", "refs/remotes/origin/main"]);

    assert.doesNotThrow(() => scanRepository({
      repo: repository,
      refPrefixes: [],
      refs: ["HEAD"],
      remote: "origin",
      identityIndex: buildIdentityIndex([]),
    }));
    const cli = spawnSync(process.execPath, [
      join(root, "scripts/scan-git-history-privacy.mjs"),
      "--repo", repository,
      "--remote", "origin",
      "--ref", "HEAD",
      "--require-zero-findings",
    ], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr || cli.stdout);
    assert.match(cli.stdout, /exactly 0 finding objects/);
    const reverseOrder = spawnSync(process.execPath, [
      join(root, "scripts/scan-git-history-privacy.mjs"),
      "--repo", repository,
      "--ref", "HEAD",
      "--remote", "origin",
      "--require-zero-findings",
    ], { encoding: "utf8" });
    assert.equal(reverseOrder.status, 0, reverseOrder.stderr || reverseOrder.stdout);

    gitAt(container, ["clone", "--branch", "main", remote, publisher]);
    gitAt(publisher, ["config", "user.name", "History Test"]);
    gitAt(publisher, ["config", "user.email", "history-test@example.test"]);
    writeFileSync(join(publisher, "SECOND.md"), "server object absent from first checkout\n");
    gitAt(publisher, ["add", "SECOND.md"]);
    gitAt(publisher, ["commit", "-m", "Add unfetched server object"]);
    gitAt(publisher, ["push", "origin", "HEAD:refs/heads/unfetched"]);

    assert.throws(() => scanRepository({
      repo: repository,
      refPrefixes: [],
      refs: ["HEAD"],
      remote: "origin",
      identityIndex: buildIdentityIndex([]),
    }), /missing a server-visible object/);
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

test("remote baseline refuses a rewritten reviewed branch", () => {
  const container = mkdtempSync(join(tmpdir(), "brain-history-remote-"));
  const repository = join(container, "work");
  const remote = join(container, "origin.git");
  const manifestPath = join(container, "public-refs.json");
  try {
    mkdirSync(repository);
    gitAt(container, ["init", "--bare", remote]);
    gitAt(repository, ["init", "--initial-branch=main"]);
    gitAt(repository, ["config", "user.name", "History Test"]);
    gitAt(repository, ["config", "user.email", "history-test@example.test"]);
    writeFileSync(join(repository, "README.md"), "reviewed history\n");
    gitAt(repository, ["add", "README.md"]);
    gitAt(repository, ["commit", "-m", "Create reviewed history"]);
    gitAt(repository, ["remote", "add", "origin", remote]);
    gitAt(repository, ["push", "-u", "origin", "main"]);

    const reviewedTip = gitAt(repository, ["rev-parse", "main"]);
    writeFileSync(manifestPath, `${JSON.stringify({
      schema_version: 1,
      refs: [{
        public_ref: "refs/heads/main",
        local_ref: "refs/remotes/origin/main",
        tip_object: reviewedTip,
      }],
    }, null, 2)}\n`);
    const emptyIdentityIndex = buildIdentityIndex([]);
    assert.doesNotThrow(() => scanRepository({
      repo: repository,
      refPrefixes: [],
      remote: "origin",
      refManifest: manifestPath,
      identityIndex: emptyIdentityIndex,
    }));

    writeFileSync(join(repository, "README.md"), "legitimate descendant\n");
    gitAt(repository, ["commit", "-am", "Advance reviewed history"]);
    gitAt(repository, ["push", "origin", "main"]);
    assert.doesNotThrow(() => scanRepository({
      repo: repository,
      refPrefixes: [],
      remote: "origin",
      refManifest: manifestPath,
      identityIndex: emptyIdentityIndex,
    }));

    gitAt(repository, ["switch", "--orphan", "replacement"]);
    writeFileSync(join(repository, "README.md"), "unrelated replacement\n");
    gitAt(repository, ["add", "README.md"]);
    gitAt(repository, ["commit", "-m", "Replace reviewed history"]);
    gitAt(repository, ["push", "--force", "origin", "replacement:main"]);
    assert.throws(() => scanRepository({
      repo: repository,
      refPrefixes: [],
      remote: "origin",
      refManifest: manifestPath,
      identityIndex: emptyIdentityIndex,
    }), /no longer descends/);
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});
