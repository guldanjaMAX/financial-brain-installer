import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  UPDATE_PREVIEW_LIMITS,
  UPDATE_RUNTIME_IDENTITY_SCHEME,
  WINDOWS_NODE_LAUNCHER_TEMPLATE,
  UpdatePreviewError,
  classifyUpdatePreviewProjectionReceipt,
  createUpdatePreviewFailureReceipt,
  createUpdatePreviewPlan,
  createUpdatePreviewProjectionFailureReceipt,
  createUpdatePreviewSuccessReceipt,
  deriveUpdateRuntimePayloadSha256,
  expectedWindowsNodeLauncherBytes,
  inventoryUpdateRuntimePayload,
  parseUpdatePreviewArgv,
  updatePreviewPlanFingerprint,
  validateVectorProjectionAggregateReceipt,
  verifyUpdateRuntimePayload,
} from "../operations/update-preview.mjs";
import { inspectNpmArchiveBytes } from "../operations/package-bundle-verifier.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const MODULE_PATH = join(HERE, "..", "operations", "update-preview.mjs");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const nativeRealpath = realpathSync.native || realpathSync;

function expectCode(code) {
  return (error) => error instanceof UpdatePreviewError && error.code === code &&
    error.message === code;
}

function runtimeFixture(t) {
  const temporary = nativeRealpath(mkdtempSync(join(nativeRealpath(tmpdir()), "brain-update-preview-")));
  const root = join(temporary, "runtime");
  mkdirSync(join(root, "operations"), { recursive: true });
  writeFileSync(join(root, "brain.mjs"), "private fixture entrypoint\n");
  writeFileSync(join(root, "operations", "helper.mjs"), "private fixture helper\n");
  writeFileSync(join(root, "empty.txt"), "");
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  return {
    root,
    allowlist: ["operations/helper.mjs", "empty.txt", "brain.mjs"],
  };
}

const MOCK_BIN_TARGET = "../@scope/tool/bin/tool.mjs";

function mockWindowsNodeShims(target = MOCK_BIN_TARGET) {
  const shellTarget = `"$basedir/${target}"`;
  const batchTarget = `"%dp0%\\${target.replaceAll("/", "\\")}"`;
  return {
    plain:
      "#!/bin/sh\n" +
      "basedir=$(dirname \"$(echo \"$0\" | sed -e 's,\\\\,/,g')\")\n\n" +
      "case `uname` in\n" +
      "    *CYGWIN*|*MINGW*|*MSYS*)\n" +
      "        if command -v cygpath > /dev/null 2>&1; then\n" +
      "            basedir=`cygpath -w \"$basedir\"`\n" +
      "        fi\n" +
      "    ;;\n" +
      "esac\n\n" +
      "if [ -x \"$basedir/node\" ]; then\n" +
      `  exec \"$basedir/node\"  ${shellTarget} \"$@\"\n` +
      "else \n" +
      `  exec node  ${shellTarget} \"$@\"\n` +
      "fi\n",
    cmd:
      "@ECHO off\r\n" +
      "GOTO start\r\n" +
      ":find_dp0\r\n" +
      "SET dp0=%~dp0\r\n" +
      "EXIT /b\r\n" +
      ":start\r\n" +
      "SETLOCAL\r\n" +
      "CALL :find_dp0\r\n\r\n" +
      "IF EXIST \"%dp0%\\node.exe\" (\r\n" +
      "  SET \"_prog=%dp0%\\node.exe\"\r\n" +
      ") ELSE (\r\n" +
      "  SET \"_prog=node\"\r\n" +
      "  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n" +
      ")\r\n\r\n" +
      "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & " +
      `\"%_prog%\"  ${batchTarget} %*\r\n`,
    powershell:
      "#!/usr/bin/env pwsh\n" +
      "$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n\n" +
      "$exe=\"\"\n" +
      "if ($PSVersionTable.PSVersion -lt \"6.0\" -or $IsWindows) {\n" +
      "  # Fix case when both the Windows and Linux builds of Node\n" +
      "  # are installed in the same directory\n" +
      "  $exe=\".exe\"\n" +
      "}\n" +
      "$ret=0\n" +
      "if (Test-Path \"$basedir/node$exe\") {\n" +
      "  # Support pipeline input\n" +
      "  if ($MyInvocation.ExpectingInput) {\n" +
      `    $input | & \"$basedir/node$exe\"  ${shellTarget} $args\n` +
      "  } else {\n" +
      `    & \"$basedir/node$exe\"  ${shellTarget} $args\n` +
      "  }\n" +
      "  $ret=$LASTEXITCODE\n" +
      "} else {\n" +
      "  # Support pipeline input\n" +
      "  if ($MyInvocation.ExpectingInput) {\n" +
      `    $input | & \"node$exe\"  ${shellTarget} $args\n` +
      "  } else {\n" +
      `    & \"node$exe\"  ${shellTarget} $args\n` +
      "  }\n" +
      "  $ret=$LASTEXITCODE\n" +
      "}\n" +
      "exit $ret\n",
  };
}

function bundledBinFixture(t, platform) {
  const temporary = nativeRealpath(mkdtempSync(join(nativeRealpath(tmpdir()), "brain-shim-fixture-")));
  const root = join(temporary, "runtime");
  const dependencyRoot = join(root, "node_modules", "@scope", "tool");
  const binDirectory = join(root, "node_modules", ".bin");
  mkdirSync(join(dependencyRoot, "bin"), { recursive: true });
  mkdirSync(binDirectory, { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({
    name: "runtime-fixture",
    version: "1.0.0",
    bundleDependencies: ["@scope/tool"],
  })}\n`);
  writeFileSync(join(dependencyRoot, "package.json"), `${JSON.stringify({
    name: "@scope/tool",
    version: "1.0.0",
    bin: { tool: "./bin/tool.mjs" },
  })}\n`);
  writeFileSync(join(dependencyRoot, "bin", "tool.mjs"),
    "#!/usr/bin/env node\nconsole.log('fixture');\n");
  if (platform === "posix") {
    symlinkSync(MOCK_BIN_TARGET, join(binDirectory, "tool"));
  } else {
    const shims = mockWindowsNodeShims();
    writeFileSync(join(binDirectory, "tool"), shims.plain);
    writeFileSync(join(binDirectory, "tool.cmd"), shims.cmd);
    writeFileSync(join(binDirectory, "tool.ps1"), shims.powershell);
  }
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const allowlist = [
    "package.json",
    "node_modules/@scope/tool/package.json",
    "node_modules/@scope/tool/bin/tool.mjs",
  ];
  const rows = allowlist.map((path) => {
    const content = readFileSync(join(root, ...path.split("/")));
    return {
      path,
      bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  });
  return {
    root,
    allowlist,
    expectedRuntimeSha256: deriveUpdateRuntimePayloadSha256(rows),
    payloadBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    binDirectory,
  };
}

function treeSnapshot(root) {
  const rows = [];
  const visit = (directory, prefix = "") => {
    for (const name of readdirSync(directory).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        rows.push({ path: relative, type: "directory", mode: info.mode & 0o777 });
        visit(path, relative);
      } else if (info.isFile() && !info.isSymbolicLink()) {
        rows.push({
          path: relative,
          type: "file",
          mode: info.mode & 0o777,
          size: info.size,
          sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
        });
      } else {
        rows.push({ path: relative, type: info.isSymbolicLink() ? "symlink" : "special" });
      }
    }
  };
  visit(root);
  return rows;
}

function syntheticRuntimeProof({ hash = HASH_A, files = 3, bytes = 42 } = {}) {
  return Object.freeze({
    schema_version: 1,
    identity_scheme: UPDATE_RUNTIME_IDENTITY_SCHEME,
    runtime_payload_sha256: hash,
    file_count: files,
    total_bytes: bytes,
    expected_runtime_sha256: hash,
    verified_passes: 2,
  });
}

function projectionInventory(overrides = {}) {
  const expected = overrides.expected ?? 10;
  const actual = overrides.actual ?? expected;
  const pending = overrides.pending ?? 0;
  const upserts = overrides.upserts ?? pending;
  const deletes = overrides.deletes ?? 0;
  const submitted = overrides.submitted ?? 0;
  const ready = overrides.ready ?? (pending === 0 && actual === expected);
  const reason = Object.hasOwn(overrides, "reason")
    ? overrides.reason
    : ready ? null : pending > 0 ? "vector_work_queued" : "vector_count_mismatch";
  return {
    version: overrides.version ?? "0.4.7",
    backend: overrides.backend ?? "d1",
    vector_drain_mode: overrides.drainMode ?? "active",
    rows: overrides.rows ?? [{ private_source: "must-not-escape" }],
    vector_backlog: {
      pending,
      upserts,
      deletes,
      submitted,
      oldest_queued_at: Object.hasOwn(overrides, "oldestQueuedAt")
        ? overrides.oldestQueuedAt
        : pending > 0 ? 1_750_000_000_000 : null,
    },
    vector_readiness: {
      ready,
      reason,
      expected_vectors: expected,
      actual_vectors: actual,
      pending: overrides.readinessPending ?? pending,
      submitted: overrides.readinessSubmitted ?? submitted,
      oldest_queued_at: Object.hasOwn(overrides, "readinessOldestQueuedAt")
        ? overrides.readinessOldestQueuedAt
        : Object.hasOwn(overrides, "oldestQueuedAt")
          ? overrides.oldestQueuedAt
          : pending > 0 ? 1_750_000_000_000 : null,
    },
  };
}

function syntheticProjection(overrides = {}) {
  const inventory = projectionInventory(overrides);
  return classifyUpdatePreviewProjectionReceipt(inventory, {
    expectedVersion: overrides.expectedVersion ?? inventory.version,
    expectedBackend: "d1",
  });
}

function syntheticPlan(overrides = {}) {
  const recordedVersion = Object.hasOwn(overrides, "recordedVersion")
    ? overrides.recordedVersion
    : "0.4.7";
  return createUpdatePreviewPlan({
    manifestSha256: overrides.manifestSha256 ?? HASH_B,
    manifestSource: overrides.manifestSource ?? "explicit",
    recordedVersion,
    candidateVersion: overrides.candidateVersion ?? "0.4.8",
    runtimeProof: overrides.runtimeProof ?? syntheticRuntimeProof(),
    deployedProjection: overrides.deployedProjection ?? syntheticProjection({
      version: recordedVersion ?? "0.4.7",
    }),
  });
}

test("strict update-preview argv parser accepts only the complete exact syntax", () => {
  const hash = "1".repeat(64);
  const withManifest = [
    "/private/owner/brain.manifest.json",
    "--preview",
    "--json",
    "--expect-runtime-sha256",
    hash,
  ];
  const original = [...withManifest];
  const parsed = parseUpdatePreviewArgv(withManifest);
  assert.deepEqual(withManifest, original, "the pure parser must not mutate caller argv");
  assert.deepEqual(parsed, {
    manifestPath: withManifest[0],
    preview: true,
    json: true,
    expectedRuntimeSha256: hash,
  });
  assert.ok(Object.isFrozen(parsed));

  assert.deepEqual(
    parseUpdatePreviewArgv([
      "--json", "--expect-runtime-sha256", hash, "--preview",
    ]),
    { manifestPath: null, preview: true, json: true, expectedRuntimeSha256: hash },
    "the manifest is optional but all three exact preview options are mandatory",
  );
});

test("update-preview parser refuses incomplete sets, aliases, duplicates, and ambiguity", () => {
  const hash = "2".repeat(64);
  for (const argv of [
    [],
    ["--preview"],
    ["--preview", "--json"],
    ["--preview", "--expect-runtime-sha256", hash],
    ["--json", "--expect-runtime-sha256", hash],
  ]) {
    assert.throws(() => parseUpdatePreviewArgv(argv),
      expectCode("UPDATE_PREVIEW_FLAGS_INCOMPLETE"));
  }
  assert.throws(
    () => parseUpdatePreviewArgv(["--preview", "--preview", "--json",
      "--expect-runtime-sha256", hash]),
    expectCode("UPDATE_PREVIEW_DUPLICATE_OPTION"),
  );
  assert.throws(
    () => parseUpdatePreviewArgv(["--preview", "--json", "--expect-runtime-sha256", hash,
      "second-manifest.json"]),
    expectCode("UPDATE_PREVIEW_EXTRA_POSITIONAL"),
  );
  assert.throws(
    () => parseUpdatePreviewArgv(["--preview", "late-manifest.json", "--json",
      "--expect-runtime-sha256", hash]),
    expectCode("UPDATE_PREVIEW_EXTRA_POSITIONAL"),
  );
  assert.throws(
    () => parseUpdatePreviewArgv(["--preview=true", "--json",
      "--expect-runtime-sha256", hash]),
    expectCode("UPDATE_PREVIEW_EQUALS_SYNTAX_FORBIDDEN"),
  );
  assert.throws(
    () => parseUpdatePreviewArgv(["--preview", "--json",
      `--expect-runtime-sha256=${hash}`]),
    expectCode("UPDATE_PREVIEW_EQUALS_SYNTAX_FORBIDDEN"),
  );
  assert.throws(
    () => parseUpdatePreviewArgv(["--preview", "--json", "--expect-runtime-sha256", hash,
      "--adopt-cloudflare-profile"]),
    expectCode("UPDATE_PREVIEW_ADOPTION_FORBIDDEN"),
  );
  assert.throws(
    () => parseUpdatePreviewArgv(["--preview", "--json", "--expect-runtime-sha256", hash,
      "--yes"]),
    expectCode("UPDATE_PREVIEW_UNKNOWN_OPTION"),
  );
  assert.throws(
    () => parseUpdatePreviewArgv(["--preview", "--json", "--expect-runtime-sha256", hash,
      "--preview", "extra"]),
    expectCode("UPDATE_PREVIEW_ARGUMENTS_INVALID"),
    "the finite grammar is bounded before token interpretation",
  );
});

test("update-preview parser requires one lowercase SHA-256 value and bounded safe tokens", () => {
  const prefix = ["--preview", "--json", "--expect-runtime-sha256"];
  for (const invalid of ["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64)]) {
    assert.throws(
      () => parseUpdatePreviewArgv([...prefix, invalid]),
      expectCode("UPDATE_PREVIEW_EXPECTED_RUNTIME_SHA256_INVALID"),
    );
  }
  assert.throws(
    () => parseUpdatePreviewArgv(prefix),
    expectCode("UPDATE_PREVIEW_EXPECTED_RUNTIME_SHA256_INVALID"),
  );
  assert.throws(
    () => parseUpdatePreviewArgv(["x".repeat(UPDATE_PREVIEW_LIMITS.argument_bytes + 1),
      "--preview", "--json", "--expect-runtime-sha256", HASH_A]),
    expectCode("UPDATE_PREVIEW_ARGUMENT_TOO_LONG"),
  );
  assert.throws(
    () => parseUpdatePreviewArgv(["private\nmanifest", "--preview", "--json",
      "--expect-runtime-sha256", HASH_A]),
    expectCode("UPDATE_PREVIEW_ARGUMENT_TOO_LONG"),
  );
  assert.throws(
    () => parseUpdatePreviewArgv(["e\u0301.json", "--preview", "--json",
      "--expect-runtime-sha256", HASH_A]),
    expectCode("UPDATE_PREVIEW_MANIFEST_ARGUMENT_INVALID"),
  );
});

test("runtime inventory is deterministic, aggregate-only, exact, and zero-write", (t) => {
  const fixture = runtimeFixture(t);
  const before = treeSnapshot(fixture.root);
  const first = inventoryUpdateRuntimePayload(fixture);
  const afterFirst = treeSnapshot(fixture.root);
  const second = inventoryUpdateRuntimePayload({
    ...fixture,
    allowlist: [...fixture.allowlist].reverse(),
  });
  const afterSecond = treeSnapshot(fixture.root);

  assert.deepEqual(afterFirst, before);
  assert.deepEqual(afterSecond, before);
  assert.deepEqual(second, first);
  assert.equal(first.schema_version, 1);
  assert.equal(first.identity_scheme, UPDATE_RUNTIME_IDENTITY_SCHEME);
  assert.match(first.runtime_payload_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(first.file_count, 3);
  assert.equal(first.total_bytes,
    Buffer.byteLength("private fixture entrypoint\nprivate fixture helper\n", "utf8"));
  const digestRows = fixture.allowlist.map((path) => {
    const bytes = readFileSync(join(fixture.root, ...path.split("/")));
    return {
      path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  assert.equal(deriveUpdateRuntimePayloadSha256(digestRows), first.runtime_payload_sha256,
    "archive inspection and installed-tree inspection must share exact identity framing");
  assert.equal(deriveUpdateRuntimePayloadSha256([...digestRows].reverse()),
    first.runtime_payload_sha256, "row order cannot change the canonical runtime identity");
  assert.ok(Object.isFrozen(first));
  const publicJson = JSON.stringify(first);
  assert.doesNotMatch(publicJson, /brain\.mjs|helper\.mjs|empty\.txt|private fixture|brain-update-preview/i);
});

test("two-pass runtime proof binds the independently supplied exact digest", (t) => {
  const fixture = runtimeFixture(t);
  const inventory = inventoryUpdateRuntimePayload(fixture);
  const before = treeSnapshot(fixture.root);
  const proof = verifyUpdateRuntimePayload({
    ...fixture,
    expectedRuntimeSha256: inventory.runtime_payload_sha256,
  });
  assert.deepEqual(treeSnapshot(fixture.root), before);
  assert.deepEqual(proof, {
    ...inventory,
    expected_runtime_sha256: inventory.runtime_payload_sha256,
    verified_passes: 2,
  });
  assert.ok(Object.isFrozen(proof));
  assert.throws(
    () => verifyUpdateRuntimePayload({ ...fixture, expectedRuntimeSha256: HASH_A }),
    expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_MISMATCH"),
  );
});

test("POSIX bundled executable shim is exact and excluded from archive-derived identity", {
  skip: process.platform === "win32",
}, (t) => {
  const fixture = bundledBinFixture(t, "posix");
  const proof = verifyUpdateRuntimePayload({
    root: fixture.root,
    allowlist: fixture.allowlist,
    expectedRuntimeSha256: fixture.expectedRuntimeSha256,
    platform: "posix",
  });
  assert.equal(proof.runtime_payload_sha256, fixture.expectedRuntimeSha256);
  assert.equal(proof.file_count, fixture.allowlist.length);
  assert.equal(proof.total_bytes, fixture.payloadBytes);
  assert.equal(proof.verified_passes, 2);
  assert.doesNotMatch(JSON.stringify(proof), /\.bin|@scope|tool\.mjs|runtime-fixture/u,
    "public runtime proof remains aggregate-only");
});

test("POSIX generated shim contract refuses wrong, external, regular, and extra entries", {
  skip: process.platform === "win32",
}, async (t) => {
  await t.test("wrong allowlisted target", (t) => {
    const fixture = bundledBinFixture(t, "posix");
    rmSync(join(fixture.binDirectory, "tool"));
    symlinkSync("../@scope/tool/package.json", join(fixture.binDirectory, "tool"));
    assert.throws(
      () => inventoryUpdateRuntimePayload({
        root: fixture.root, allowlist: fixture.allowlist, platform: "posix",
      }),
      expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"),
    );
  });
  await t.test("external target", (t) => {
    const fixture = bundledBinFixture(t, "posix");
    rmSync(join(fixture.binDirectory, "tool"));
    symlinkSync("../../../../outside", join(fixture.binDirectory, "tool"));
    assert.throws(
      () => inventoryUpdateRuntimePayload({
        root: fixture.root, allowlist: fixture.allowlist, platform: "posix",
      }),
      expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"),
    );
  });
  await t.test("regular file substitution", (t) => {
    const fixture = bundledBinFixture(t, "posix");
    rmSync(join(fixture.binDirectory, "tool"));
    writeFileSync(join(fixture.binDirectory, "tool"), MOCK_BIN_TARGET);
    assert.throws(
      () => inventoryUpdateRuntimePayload({
        root: fixture.root, allowlist: fixture.allowlist, platform: "posix",
      }),
      expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"),
    );
  });
  await t.test("extra generated link", (t) => {
    const fixture = bundledBinFixture(t, "posix");
    symlinkSync(MOCK_BIN_TARGET, join(fixture.binDirectory, "tool-extra"));
    assert.throws(
      () => inventoryUpdateRuntimePayload({
        root: fixture.root, allowlist: fixture.allowlist, platform: "posix",
      }),
      expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"),
    );
  });
});

test("mocked Windows npm 11.8.0 shims are exact and excluded from payload identity", (t) => {
  const fixture = bundledBinFixture(t, "win32");
  const proof = verifyUpdateRuntimePayload({
    root: fixture.root,
    allowlist: fixture.allowlist,
    expectedRuntimeSha256: fixture.expectedRuntimeSha256,
    platform: "win32",
  });
  assert.equal(proof.runtime_payload_sha256, fixture.expectedRuntimeSha256);
  assert.equal(proof.file_count, fixture.allowlist.length);
  assert.equal(proof.total_bytes, fixture.payloadBytes);
  assert.equal(proof.verified_passes, 2);
});

test("reviewed Windows outer launcher bytes are exact for a global user-prefix install", () => {
  const target = "node_modules/brain-installer/brain.mjs";
  const targetBytes = Buffer.from("#!/usr/bin/env node\nconsole.log('fixture');\n", "utf8");
  const expected = mockWindowsNodeShims(target);
  const observed = expectedWindowsNodeLauncherBytes({
    launcherDirectory: ".",
    payloadTarget: target,
    targetBytes,
  });
  try {
    assert.equal(WINDOWS_NODE_LAUNCHER_TEMPLATE, "npm.cmd-shim-8.windows-node.v1");
    assert.deepEqual(Object.keys(observed).sort(), ["cmd", "plain", "powershell"]);
    assert.equal(observed.plain.toString("utf8"), expected.plain);
    assert.equal(observed.cmd.toString("utf8"), expected.cmd);
    assert.equal(observed.powershell.toString("utf8"), expected.powershell);
  } finally {
    targetBytes.fill(0);
    observed.plain.fill(0);
    observed.cmd.fill(0);
    observed.powershell.fill(0);
  }
});

test("reviewed Windows launcher byte helper rejects an open or non-Node contract", () => {
  const valid = {
    launcherDirectory: ".",
    payloadTarget: "node_modules/brain-installer/brain.mjs",
    targetBytes: Buffer.from("#!/usr/bin/env node\n", "utf8"),
  };
  assert.throws(
    () => expectedWindowsNodeLauncherBytes({ ...valid, extra: true }),
    expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"),
  );
  assert.throws(
    () => expectedWindowsNodeLauncherBytes({ ...valid, launcherDirectory: "" }),
    expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"),
  );
  assert.throws(
    () => expectedWindowsNodeLauncherBytes({
      ...valid,
      targetBytes: Buffer.from("#!/usr/bin/env bash\n", "utf8"),
    }),
    expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"),
  );
  valid.targetBytes.fill(0);
});

test("mocked Windows generated shim contract refuses drift, omission, links, and extras", async (t) => {
  await t.test("one-byte cmd drift", (t) => {
    const fixture = bundledBinFixture(t, "win32");
    writeFileSync(join(fixture.binDirectory, "tool.cmd"), "changed\r\n");
    assert.throws(
      () => inventoryUpdateRuntimePayload({
        root: fixture.root, allowlist: fixture.allowlist, platform: "win32",
      }),
      expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"),
    );
  });
  await t.test("missing PowerShell shim", (t) => {
    const fixture = bundledBinFixture(t, "win32");
    rmSync(join(fixture.binDirectory, "tool.ps1"));
    assert.throws(
      () => inventoryUpdateRuntimePayload({
        root: fixture.root, allowlist: fixture.allowlist, platform: "win32",
      }),
      expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"),
    );
  });
  await t.test("linked plain shim", (t) => {
    const fixture = bundledBinFixture(t, "win32");
    rmSync(join(fixture.binDirectory, "tool"));
    symlinkSync("../@scope/tool/bin/tool.mjs", join(fixture.binDirectory, "tool"));
    assert.throws(
      () => inventoryUpdateRuntimePayload({
        root: fixture.root, allowlist: fixture.allowlist, platform: "win32",
      }),
      expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"),
    );
  });
  await t.test("extra executable shim", (t) => {
    const fixture = bundledBinFixture(t, "win32");
    writeFileSync(join(fixture.binDirectory, "tool.exe"), "not expected");
    assert.throws(
      () => inventoryUpdateRuntimePayload({
        root: fixture.root, allowlist: fixture.allowlist, platform: "win32",
      }),
      expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"),
    );
  });
});

test("real clean-prefix POSIX npm install preserves the archive-derived runtime identity", {
  skip: process.platform === "win32",
}, (t) => {
  const temporary = realpathSync(mkdtempSync(join(realpathSync(tmpdir()),
    "brain-real-install-parity-")));
  const packDirectory = join(temporary, "pack");
  const installPrefix = join(temporary, "prefix");
  const cacheDirectory = join(temporary, "npm-cache");
  mkdirSync(packDirectory, { recursive: true });
  mkdirSync(installPrefix, { recursive: true });
  mkdirSync(cacheDirectory, { recursive: true });
  const npmConfig = join(temporary, "empty.npmrc");
  writeFileSync(npmConfig, "");
  t.after(() => rmSync(temporary, { recursive: true, force: true }));

  const npmCli = realpathSync(join(dirname(process.execPath), "npm"));
  const npmEnvironment = {
    ...process.env,
    npm_config_audit: "false",
    npm_config_cache: cacheDirectory,
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
    npm_config_offline: "true",
    npm_config_userconfig: npmConfig,
  };
  const packed = spawnSync(process.execPath, [
    npmCli,
    "pack",
    "--json",
    "--ignore-scripts",
    "--offline",
    "--pack-destination",
    packDirectory,
    ROOT,
  ], {
    cwd: temporary,
    encoding: "utf8",
    env: npmEnvironment,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
  });
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const metadata = JSON.parse(packed.stdout);
  assert.equal(metadata.length, 1);
  assert.match(metadata[0].filename, /^brain-installer-[0-9A-Za-z.-]+\.tgz$/u);
  const archivePath = join(packDirectory, metadata[0].filename);

  const installed = spawnSync(process.execPath, [
    npmCli,
    "install",
    "--prefix",
    installPrefix,
    "--ignore-scripts",
    "--omit=dev",
    "--offline",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    archivePath,
  ], {
    cwd: temporary,
    encoding: "utf8",
    env: npmEnvironment,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
  });
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);

  const archive = readFileSync(archivePath);
  const inspected = inspectNpmArchiveBytes(archive);
  const digestRows = inspected.rows.map(({ path, bytes, sha256 }) =>
    ({ path, bytes, sha256 }));
  const expectedRuntimeSha256 = deriveUpdateRuntimePayloadSha256(digestRows);
  const root = join(installPrefix, "node_modules", "brain-installer");
  assert.equal(lstatSync(join(root, "node_modules", ".bin", "xlsx")).isSymbolicLink(), true,
    "npm must have materialized the bundled dependency executable shim being tested");
  const proof = verifyUpdateRuntimePayload({
    root,
    allowlist: inspected.rows.map(({ path }) => path),
    expectedRuntimeSha256,
    platform: "posix",
  });
  assert.equal(proof.runtime_payload_sha256, expectedRuntimeSha256);
  assert.equal(proof.file_count, inspected.rows.length);
  assert.equal(proof.total_bytes,
    inspected.rows.reduce((sum, row) => sum + row.bytes, 0));
  assert.doesNotMatch(JSON.stringify(proof), /\.bin|xlsx|brain-real-install-parity/u);
});

test("runtime platform selector is closed", (t) => {
  const fixture = runtimeFixture(t);
  assert.throws(
    () => inventoryUpdateRuntimePayload({ ...fixture, platform: "windows" }),
    expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"),
  );
});

test("generated shim contract is rebuilt and rechecked on the second complete pass", (t) => {
  const fixture = bundledBinFixture(t, "posix");
  assert.throws(
    () => verifyUpdateRuntimePayload({
      root: fixture.root,
      allowlist: fixture.allowlist,
      expectedRuntimeSha256: fixture.expectedRuntimeSha256,
      platform: "posix",
      betweenPasses() {
        rmSync(join(fixture.binDirectory, "tool"));
        symlinkSync("../@scope/tool/package.json", join(fixture.binDirectory, "tool"));
      },
    }),
    expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"),
  );
});

test("generated shim metadata and count bounds fail closed", async (t) => {
  await t.test("undeclared generated entry is not inferred", (t) => {
    const fixture = bundledBinFixture(t, "posix");
    const dependencyManifest = join(
      fixture.root, "node_modules", "@scope", "tool", "package.json",
    );
    writeFileSync(dependencyManifest, `${JSON.stringify({
      name: "@scope/tool",
      version: "1.0.0",
      bin: {
        tool: "./bin/tool.mjs",
        second: "./bin/tool.mjs",
      },
    })}\n`);
    assert.throws(
      () => inventoryUpdateRuntimePayload({
        root: fixture.root, allowlist: fixture.allowlist, platform: "posix",
      }),
      expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"),
    );
  });
  await t.test("more generated declarations than the fixed bound", (t) => {
    const fixture = bundledBinFixture(t, "posix");
    const dependencyManifest = join(
      fixture.root, "node_modules", "@scope", "tool", "package.json",
    );
    const bin = {};
    for (let index = 0; index <= UPDATE_PREVIEW_LIMITS.generated_entries; index++) {
      bin[`tool-${index}`] = "./bin/tool.mjs";
    }
    writeFileSync(dependencyManifest, `${JSON.stringify({
      name: "@scope/tool",
      version: "1.0.0",
      bin,
    })}\n`);
    assert.throws(
      () => inventoryUpdateRuntimePayload({
        root: fixture.root, allowlist: fixture.allowlist, platform: "posix",
      }),
      expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_LIMIT"),
    );
  });
  await t.test("Windows template refuses a noncanonical interpreter", (t) => {
    const fixture = bundledBinFixture(t, "win32");
    writeFileSync(
      join(fixture.root, "node_modules", "@scope", "tool", "bin", "tool.mjs"),
      "#!/usr/bin/node\nconsole.log('fixture');\n",
    );
    assert.throws(
      () => inventoryUpdateRuntimePayload({
        root: fixture.root, allowlist: fixture.allowlist, platform: "win32",
      }),
      expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"),
    );
  });
});

test("runtime inventory refuses missing, extra, linked, and non-allowlisted directory entries", async (t) => {
  await t.test("missing file", (t) => {
    const fixture = runtimeFixture(t);
    rmSync(join(fixture.root, "empty.txt"));
    assert.throws(() => inventoryUpdateRuntimePayload(fixture),
      expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"));
  });
  await t.test("extra file", (t) => {
    const fixture = runtimeFixture(t);
    writeFileSync(join(fixture.root, "private-extra.txt"), "private extra");
    assert.throws(() => inventoryUpdateRuntimePayload(fixture),
      expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"));
  });
  await t.test("extra empty directory", (t) => {
    const fixture = runtimeFixture(t);
    mkdirSync(join(fixture.root, "private-extra"));
    assert.throws(() => inventoryUpdateRuntimePayload(fixture),
      expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"));
  });
  await t.test("symlink", (t) => {
    const fixture = runtimeFixture(t);
    rmSync(join(fixture.root, "empty.txt"));
    symlinkSync("brain.mjs", join(fixture.root, "empty.txt"));
    assert.throws(() => inventoryUpdateRuntimePayload(fixture),
      expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"));
  });
  await t.test("hard link", (t) => {
    const fixture = runtimeFixture(t);
    rmSync(join(fixture.root, "empty.txt"));
    linkSync(join(fixture.root, "brain.mjs"), join(fixture.root, "empty.txt"));
    assert.throws(() => inventoryUpdateRuntimePayload(fixture),
      expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"));
  });
  await t.test("symlinked root", (t) => {
    const fixture = runtimeFixture(t);
    const linkedRoot = join(dirname(fixture.root), "linked-runtime");
    symlinkSync(fixture.root, linkedRoot, "dir");
    assert.throws(
      () => inventoryUpdateRuntimePayload({ ...fixture, root: linkedRoot }),
      expectCode("UPDATE_PREVIEW_RUNTIME_ROOT_INVALID"),
    );
  });
  await t.test("special entry classification", (t) => {
    const fixture = runtimeFixture(t);
    const target = join(fixture.root, "empty.txt");
    let classified = false;
    assert.throws(
      () => inventoryUpdateRuntimePayload({
        ...fixture,
        io: {
          lstat(path) {
            const info = lstatSync(path);
            if (path !== target) return info;
            classified = true;
            return {
              ...info,
              isDirectory: () => false,
              isFile: () => false,
              isSymbolicLink: () => false,
            };
          },
        },
      }),
      expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"),
    );
    assert.equal(classified, true, "the crafted special-entry seam must actually run");
  });
});

test("runtime allowlist rejects extraction-unsafe and colliding path forms", (t) => {
  const fixture = runtimeFixture(t);
  const invalidAllowlists = [
    ["../outside"],
    ["/absolute"],
    ["C:/drive"],
    ["folder\\file"],
    ["folder/../file"],
    ["folder//file"],
    ["folder/trailing."],
    ["folder/trailing "],
    ["folder/CON"],
    ["folder/CONIN$.txt"],
    ["folder/COM¹.txt"],
    ["e\u0301.txt"],
    ["same", "same"],
    ["A/file", "a/other"],
    ["ancestor", "ancestor/child"],
  ];
  for (const allowlist of invalidAllowlists) {
    assert.throws(
      () => inventoryUpdateRuntimePayload({ ...fixture, allowlist }),
      expectCode("UPDATE_PREVIEW_RUNTIME_ALLOWLIST_INVALID"),
      JSON.stringify(allowlist),
    );
  }
});

test("runtime file, aggregate, and inventory bounds fail closed", async (t) => {
  await t.test("file bound", (t) => {
    const fixture = runtimeFixture(t);
    assert.throws(
      () => inventoryUpdateRuntimePayload({ ...fixture, maxFileBytes: 4 }),
      expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_LIMIT"),
    );
  });
  await t.test("aggregate bound", (t) => {
    const fixture = runtimeFixture(t);
    assert.throws(
      () => inventoryUpdateRuntimePayload({ ...fixture, maxTotalBytes: 8 }),
      expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_LIMIT"),
    );
  });
  await t.test("file-count bound", (t) => {
    const fixture = runtimeFixture(t);
    assert.throws(
      () => inventoryUpdateRuntimePayload({ ...fixture, maxFiles: 2 }),
      expectCode("UPDATE_PREVIEW_RUNTIME_ALLOWLIST_INVALID"),
    );
  });
  await t.test("unknown option or injected operation", (t) => {
    const fixture = runtimeFixture(t);
    assert.throws(
      () => inventoryUpdateRuntimePayload({ ...fixture, unknownLimit: 1 }),
      expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"),
    );
    assert.throws(
      () => inventoryUpdateRuntimePayload({ ...fixture, io: { write: () => {} } }),
      expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_INVALID"),
    );
  });
});

test("two-pass proof detects a payload mutation between complete inventories", (t) => {
  const fixture = runtimeFixture(t);
  const expected = inventoryUpdateRuntimePayload(fixture).runtime_payload_sha256;
  assert.throws(
    () => verifyUpdateRuntimePayload({
      ...fixture,
      expectedRuntimeSha256: expected,
      betweenPasses() {
        writeFileSync(join(fixture.root, "brain.mjs"), "changed between passes\n");
      },
    }),
    expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_CHANGED"),
  );
});

test("stable reader detects a file replacement between lstat and opened descriptor", (t) => {
  const fixture = runtimeFixture(t);
  const target = join(fixture.root, "brain.mjs");
  let changed = false;
  assert.throws(
    () => inventoryUpdateRuntimePayload({
      ...fixture,
      io: {
        open(path, flags) {
          if (!changed && path === target) {
            changed = true;
            writeFileSync(target, "mutated at open boundary\n");
          }
          return openSync(path, flags);
        },
      },
    }),
    expectCode("UPDATE_PREVIEW_RUNTIME_PAYLOAD_CHANGED"),
  );
  assert.equal(changed, true, "the crafted TOCTOU seam must actually run");
});

test("runtime failures never include private paths or contents", (t) => {
  const fixture = runtimeFixture(t);
  const privatePath = join(fixture.root, "Private Client Name.pdf");
  writeFileSync(privatePath, "private account and customer contents");
  let error;
  try {
    inventoryUpdateRuntimePayload(fixture);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof UpdatePreviewError);
  const visible = `${error.name}:${error.code}:${error.message}:${JSON.stringify(
    createUpdatePreviewFailureReceipt(error),
  )}`;
  assert.doesNotMatch(visible, /Private Client|account and customer|brain-update-preview/i);
});

test("authenticated projection validation returns only one frozen aggregate cut", () => {
  const inventory = projectionInventory({
    rows: [{ source_type: "private-payroll", title: "Private Customer File" }],
  });
  const aggregate = validateVectorProjectionAggregateReceipt(inventory, {
    expectedVersion: "0.4.7",
    expectedBackend: "d1",
    expectedDrainMode: "active",
  });
  assert.deepEqual(aggregate, {
    worker_version: "0.4.7",
    backend: "d1",
    vector_drain_mode: "active",
    expected_vectors: 10,
    actual_vectors: 10,
    queue: {
      pending: 0,
      upserts: 0,
      deletes: 0,
      submitted: 0,
      oldest_queued_at: null,
    },
    query_ready: true,
    readiness_reason: null,
  });
  assert.ok(Object.isFrozen(aggregate));
  assert.ok(Object.isFrozen(aggregate.queue));
  assert.doesNotMatch(JSON.stringify(aggregate), /private-payroll|Private Customer File/u);
});

test("projection classifier distinguishes ready, sufficient, insufficient, missing, and excess", () => {
  const cases = [
    [{}, "ready"],
    [{ expected: 10, actual: 2, pending: 8 }, "recoverable_queued_work"],
    [{ expected: 10, actual: 2, pending: 8, upserts: 0, deletes: 8 },
      "projection_work_insufficient"],
    [{ expected: 10, actual: 2, pending: 8, upserts: 7, deletes: 1 },
      "projection_work_insufficient"],
    [{ expected: 10, actual: 10, pending: 2 }, "queued_work_present"],
    [{ expected: 10, actual: 2, pending: 8, reason: "projection_bootstrap_required" },
      "recoverable_queued_work"],
    [{ expected: 10, actual: 2, reason: "vector_count_mismatch" },
      "projection_work_missing"],
    [{ expected: 10, actual: 2, reason: "projection_bootstrap_required" },
      "projection_work_missing"],
    [{ expected: 10, actual: 2, reason: "accepted_mutation_processing" },
      "projection_visibility_pending"],
    [{ expected: 10, actual: 11 }, "projection_excess"],
    [{ expected: 10, actual: 11, pending: 1, upserts: 0, deletes: 1 },
      "projection_excess"],
  ];
  for (const [fixture, verdict] of cases) {
    const proof = syntheticProjection(fixture);
    assert.equal(proof.verdict, verdict);
    assert.equal(proof.queue.pending, fixture.pending ?? 0);
    assert.ok(Object.isFrozen(proof));
  }
});

test("projection validation fails closed on mixed or incoherent same-response fields", () => {
  const cases = [
    [projectionInventory({ version: "0.4.6" }), "UPDATE_PREVIEW_DEPLOYED_GENERATION_MISMATCH"],
    [projectionInventory({ backend: "supabase" }), "UPDATE_PREVIEW_DEPLOYED_BACKEND_MISMATCH"],
    [projectionInventory({ backend: "D1" }), "UPDATE_PREVIEW_DEPLOYED_BACKEND_MISMATCH"],
    [projectionInventory({ drainMode: "paused-for-upgrade" }), "UPDATE_PREVIEW_DEPLOYED_DRAIN_PAUSED"],
    [projectionInventory({ pending: 2, upserts: 1, deletes: 0 }),
      "UPDATE_PREVIEW_VECTOR_BACKLOG_INVALID"],
    [projectionInventory({ pending: 2, oldestQueuedAt: null }),
      "UPDATE_PREVIEW_QUEUE_TIMESTAMP_INVALID"],
    [projectionInventory({ pending: 2, readinessOldestQueuedAt: 1_750_000_000_001 }),
      "UPDATE_PREVIEW_QUEUE_TIMESTAMP_INVALID"],
    [projectionInventory({ pending: 2, readinessPending: 1 }),
      "UPDATE_PREVIEW_VECTOR_READINESS_INVALID"],
    [projectionInventory({ pending: 2, submitted: 0, reason: "accepted_mutation_processing" }),
      "UPDATE_PREVIEW_VECTOR_READINESS_INVALID"],
    [projectionInventory({ pending: 2, submitted: 1, reason: "vector_work_queued" }),
      "UPDATE_PREVIEW_VECTOR_READINESS_INVALID"],
    [projectionInventory({ expected: 10, actual: 11, reason: "vector_work_queued" }),
      "UPDATE_PREVIEW_VECTOR_READINESS_INVALID"],
    [projectionInventory({ expected: 10, actual: 11, pending: 1,
      reason: "projection_unverified" }), "UPDATE_PREVIEW_VECTOR_READINESS_INVALID"],
    [projectionInventory({ expected: 10, actual: 10, ready: false, reason: "unknown" }),
      "UPDATE_PREVIEW_VECTOR_READINESS_INVALID"],
  ];
  for (const [inventory, code] of cases) {
    assert.throws(
      () => classifyUpdatePreviewProjectionReceipt(inventory, {
        expectedVersion: "0.4.7",
        expectedBackend: "d1",
      }),
      expectCode(code),
    );
  }

  const exactButUnverified = projectionInventory({
    expected: 10,
    actual: 10,
    ready: false,
    reason: "projection_unverified",
  });
  assert.equal(validateVectorProjectionAggregateReceipt(exactButUnverified, {
    expectedVersion: "0.4.7",
  }).query_ready, false, "health may still render this coherent transient state");
  assert.throws(
    () => classifyUpdatePreviewProjectionReceipt(exactButUnverified, {
      expectedVersion: "0.4.7",
    }),
    expectCode("UPDATE_PREVIEW_VECTOR_READINESS_INVALID"),
  );
});

test("preview plan and success receipt bind local identity plus live aggregate proof", () => {
  const plan = syntheticPlan();
  const fingerprint = updatePreviewPlanFingerprint(plan);
  assert.match(fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(updatePreviewPlanFingerprint(plan), fingerprint);
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.manifest));
  assert.ok(Object.isFrozen(plan.candidate));
  assert.ok(Object.isFrozen(plan.deployed_projection));
  assert.equal(plan.deployed_projection.verdict, "ready");
  assert.equal(plan.version_relation, "upgrade");
  assert.equal(syntheticPlan({ recordedVersion: "0.4.8" }).version_relation, "same");
  assert.throws(
    () => syntheticPlan({ recordedVersion: null }),
    expectCode("UPDATE_PREVIEW_PLAN_INVALID"),
  );

  const receipt = createUpdatePreviewSuccessReceipt(plan, {
    credential_reads: 1,
    network_requests: 1,
  });
  assert.equal(receipt.status, "pre_update_check_complete");
  assert.equal(receipt.read_only, true);
  assert.equal(receipt.authorizes_update, false);
  assert.equal(receipt.projection_ready, true);
  assert.equal(receipt.plan_fingerprint, fingerprint);
  assert.deepEqual(receipt.effects, {
    manifest_writes: 0,
    credential_reads: 1,
    network_requests: 1,
    brain_writes: 0,
    cloudflare_control_requests: 0,
    deployments: 0,
    browser_launches: 0,
    package_installs: 0,
    support_journal_writes: 0,
    workspace_writes: 0,
    skill_writes: 0,
  });
  assert.deepEqual(receipt.proof_boundary, {
    public_release_authenticity: "unproven",
    credential_custody: "durable_admin_key_read",
    brain_domain_identity: "pinned_manifest_assertion",
    cloudflare_account_ownership: "not_accessed",
    deployed_install_state: "authenticated_aggregate_observed",
    schema_compatibility: "not_accessed",
    restore_bookmark: "not_created",
    deployment: "not_started",
    acceptance: "not_run",
  });
  assert.ok(Object.isFrozen(receipt));
  assert.ok(Object.isFrozen(receipt.effects));
  assert.ok(Object.isFrozen(receipt.proof_boundary));
});

test("plan fingerprint binds every variable plan field", () => {
  const baseline = updatePreviewPlanFingerprint(syntheticPlan());
  const variants = [
    syntheticPlan({ manifestSha256: "c".repeat(64) }),
    syntheticPlan({ manifestSource: "remembered" }),
    syntheticPlan({ recordedVersion: "0.4.6" }),
    syntheticPlan({ candidateVersion: "0.4.9" }),
    syntheticPlan({ runtimeProof: syntheticRuntimeProof({ hash: "d".repeat(64) }) }),
    syntheticPlan({ runtimeProof: syntheticRuntimeProof({ files: 4 }) }),
    syntheticPlan({ runtimeProof: syntheticRuntimeProof({ bytes: 43 }) }),
    syntheticPlan({ deployedProjection: syntheticProjection({ expected: 11, actual: 11 }) }),
    syntheticPlan({ deployedProjection: syntheticProjection({ expected: 10, actual: 9, pending: 1 }) }),
    syntheticPlan({ deployedProjection: syntheticProjection({
      expected: 10,
      actual: 9,
      pending: 1,
      submitted: 1,
      reason: "accepted_mutation_processing",
    }) }),
  ];
  for (const variant of variants) {
    assert.notEqual(updatePreviewPlanFingerprint(variant), baseline);
  }
});

test("completed queued-work diagnostics exit as checks, never as projection readiness", () => {
  for (const deployedProjection of [
    syntheticProjection({ expected: 10, actual: 2, pending: 8 }),
    syntheticProjection({ expected: 10, actual: 10, pending: 2 }),
  ]) {
    const receipt = createUpdatePreviewSuccessReceipt(
      syntheticPlan({ deployedProjection }),
      { credential_reads: 1, network_requests: 1 },
    );
    assert.equal(receipt.status, "pre_update_check_complete");
    assert.equal(receipt.projection_ready, false);
    assert.equal(receipt.authorizes_update, false);
    assert.equal(receipt.plan.deployed_projection.query_ready, false);
    assert.match(receipt.plan.deployed_projection.verdict, /queued_work/u);
  }
});

test("success plans reject downgrade, unverified runtime, drift, and extra fields", () => {
  assert.throws(
    () => syntheticPlan({ recordedVersion: "0.4.9" }),
    expectCode("UPDATE_PREVIEW_DOWNGRADE_REFUSED"),
  );
  assert.throws(
    () => syntheticPlan({
      runtimeProof: { ...syntheticRuntimeProof(), verified_passes: 1 },
    }),
    expectCode("UPDATE_PREVIEW_PLAN_INVALID"),
  );
  assert.throws(
    () => syntheticPlan({
      runtimeProof: { ...syntheticRuntimeProof(), expected_runtime_sha256: HASH_B },
    }),
    expectCode("UPDATE_PREVIEW_PLAN_INVALID"),
  );
  const plan = syntheticPlan();
  assert.throws(
    () => createUpdatePreviewSuccessReceipt({ ...plan, private_path: "/private/customer" }),
    expectCode("UPDATE_PREVIEW_PLAN_INVALID"),
  );
  assert.throws(
    () => createUpdatePreviewSuccessReceipt({
      ...plan,
      version_relation: "same",
    }),
    expectCode("UPDATE_PREVIEW_PLAN_INVALID"),
  );
  const missingPlan = syntheticPlan({
    deployedProjection: syntheticProjection({ expected: 10, actual: 2 }),
  });
  assert.throws(
    () => createUpdatePreviewSuccessReceipt(missingPlan, {
      credential_reads: 1,
      network_requests: 1,
    }),
    expectCode("UPDATE_PREVIEW_PLAN_INVALID"),
  );
  const arbitraryReason = structuredClone(syntheticPlan());
  arbitraryReason.deployed_projection.expected_vectors = 10;
  arbitraryReason.deployed_projection.actual_vectors = 11;
  arbitraryReason.deployed_projection.query_ready = false;
  arbitraryReason.deployed_projection.readiness_reason = "private-detail-must-not-pass";
  arbitraryReason.deployed_projection.verdict = "projection_excess";
  assert.throws(
    () => createUpdatePreviewPlan({
      manifestSha256: arbitraryReason.manifest.sha256,
      manifestSource: arbitraryReason.manifest.source,
      recordedVersion: arbitraryReason.manifest.recorded_version,
      candidateVersion: arbitraryReason.candidate.version,
      runtimeProof: syntheticRuntimeProof(),
      deployedProjection: arbitraryReason.deployed_projection,
    }),
    expectCode("UPDATE_PREVIEW_PLAN_INVALID"),
  );
});

test("evaluated projection refusals retain zero queued proof under the plan fingerprint", () => {
  const missingPlan = syntheticPlan({
    deployedProjection: syntheticProjection({
      expected: 1_151_274,
      actual: 62_439,
      reason: "vector_count_mismatch",
    }),
  });
  const receipt = createUpdatePreviewProjectionFailureReceipt(missingPlan, {
    credential_reads: 1,
    network_requests: 1,
  });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.authorizes_update, false);
  assert.equal(receipt.projection_ready, false);
  assert.equal(receipt.error_code, "UPDATE_PREVIEW_PROJECTION_WORK_MISSING");
  assert.equal(receipt.plan.deployed_projection.queue.pending, 0);
  assert.equal(receipt.plan.deployed_projection.expected_vectors, 1_151_274);
  assert.equal(receipt.plan.deployed_projection.actual_vectors, 62_439);
  assert.equal(receipt.plan_fingerprint, updatePreviewPlanFingerprint(missingPlan));
  const changed = syntheticPlan({
    deployedProjection: syntheticProjection({
      expected: 1_151_274,
      actual: 62_440,
      reason: "vector_count_mismatch",
    }),
  });
  assert.notEqual(updatePreviewPlanFingerprint(changed), receipt.plan_fingerprint);
  assert.equal(receipt.effects.brain_writes, 0);
  assert.equal(receipt.effects.deployments, 0);
  assert.equal(receipt.effects.support_journal_writes, 0);

  const insufficientPlan = syntheticPlan({
    deployedProjection: syntheticProjection({
      expected: 10,
      actual: 2,
      pending: 8,
      upserts: 7,
      deletes: 1,
    }),
  });
  const insufficient = createUpdatePreviewProjectionFailureReceipt(insufficientPlan, {
    credential_reads: 1,
    network_requests: 1,
  });
  assert.equal(insufficient.error_code, "UPDATE_PREVIEW_PROJECTION_WORK_INSUFFICIENT");
  assert.equal(insufficient.plan.deployed_projection.verdict, "projection_work_insufficient");
  assert.equal(insufficient.plan.deployed_projection.queue.upserts, 7);
  assert.equal(insufficient.plan_fingerprint, updatePreviewPlanFingerprint(insufficientPlan));
  assert.notEqual(insufficient.plan_fingerprint, receipt.plan_fingerprint);
});

test("failure receipts collapse raw errors and unknown codes without copying details", () => {
  const privateFailure = new Error("Private Customer /Users/owner secret-token-123");
  assert.deepEqual(createUpdatePreviewFailureReceipt(privateFailure), {
    schema_version: 1,
    operation: "brain.update.preview",
    status: "failed",
    read_only: true,
    authorizes_update: false,
    projection_ready: false,
    error_code: "UPDATE_PREVIEW_FAILED",
    effects: {
      manifest_writes: 0,
      credential_reads: 0,
      network_requests: 0,
      brain_writes: 0,
      cloudflare_control_requests: 0,
      deployments: 0,
      browser_launches: 0,
      package_installs: 0,
      support_journal_writes: 0,
      workspace_writes: 0,
      skill_writes: 0,
    },
  });
  assert.equal(
    createUpdatePreviewFailureReceipt("PRIVATE_PROVIDER_DETAIL").error_code,
    "UPDATE_PREVIEW_FAILED",
  );
  assert.equal(
    createUpdatePreviewFailureReceipt(
      new UpdatePreviewError("UPDATE_PREVIEW_RUNTIME_PAYLOAD_MISMATCH"),
    ).error_code,
    "UPDATE_PREVIEW_RUNTIME_PAYLOAD_MISMATCH",
  );
  assert.doesNotMatch(JSON.stringify(createUpdatePreviewFailureReceipt(privateFailure)),
    /Private Customer|Users|secret-token/i);
});

test("pure preview core has no write, network, child-process, environment, or credential import", () => {
  const source = readFileSync(MODULE_PATH, "utf8");
  assert.doesNotMatch(source, /from "node:(?:child_process|http|https|net|tls)"/u);
  assert.doesNotMatch(source, /\bprocess\.env\b|\bfetch\s*\(/u);
  assert.doesNotMatch(source,
    /\b(?:writeFile|appendFile|mkdir|rename|unlink|rm|rmdir|truncate|chmod|chown|symlink|link)Sync\b/u);
  assert.doesNotMatch(source, /keychain|wrangler|cloudflare-api-token/i);
});
