import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { strToU8, zipSync } from "fflate";

import {
  buildNpmCliInvocation,
  buildWindowsBatchInvocation,
  buildWindowsNpmPowerShellInvocation,
  classifyWindowsNpmPowerShellFailure,
  installedBrainPath,
  nodeRuntimeNpmCliPaths,
  npmInstallEnvironment,
  parsePublicInstallCommand,
  publicInstallArgumentsFromGuide,
  publicContractChildEnvironment,
  resolveNpmCliPath,
  resolveWindowsNpmCommandPath,
  resolveWindowsPowerShellPath,
  verifiedNpmCliPath,
} from "../operations/npm-cli-runtime.mjs";

const powershellHelper = fileURLToPath(new URL("../scripts/invoke-public-npm-install.ps1", import.meta.url));

const archiveName = "brain-installer-9.8.7.tgz";
const windowsGuide = [
  "## Verify and install",
  `$Archive = Join-Path (Get-Location).Path "${archiveName}"`,
  'npm.cmd install --global --ignore-scripts --no-audit --no-fund --prefix "$env:LOCALAPPDATA\\FinancialBrain" "$Archive"',
  "",
].join("\r\n");
const macosGuide = [
  "## Verify and install",
  `    npm install --global --ignore-scripts --no-audit --no-fund --prefix "$HOME/.npm-global" ./${archiveName}`,
  "",
].join("\n");

function writeNpmFixture(root, relativeCli = join("lib", "node_modules", "npm", "bin", "npm-cli.js")) {
  const cli = join(root, relativeCli);
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  writeFileSync(join(dirname(dirname(cli)), "package.json"), JSON.stringify({ name: "npm", version: "11.0.0" }));
  return realpathSync(cli);
}

test("the public install invocation and installed binary paths exactly match both field guides", () => {
  const posixPrefix = "/tmp/Financial Brain";
  const posixArchive = `/tmp/kit/${archiveName}`;
  assert.deepEqual(parsePublicInstallCommand(macosGuide, { guide: "macos", archiveName }), {
    executable: "npm",
    args: [
      "install", "--global", "--ignore-scripts", "--no-audit", "--no-fund",
      "--prefix", "$HOME/.npm-global", `./${archiveName}`,
    ],
  });
  assert.deepEqual(parsePublicInstallCommand(windowsGuide, { guide: "windows", archiveName }), {
    executable: "npm.cmd",
    args: [
      "install", "--global", "--ignore-scripts", "--no-audit", "--no-fund",
      "--prefix", "$env:LOCALAPPDATA\\FinancialBrain", "$Archive",
    ],
  });
  assert.deepEqual(publicInstallArgumentsFromGuide(macosGuide, {
    guide: "macos", archiveName, prefix: posixPrefix, archive: posixArchive,
  }), [
    "install", "--global", "--ignore-scripts", "--no-audit", "--no-fund",
    "--prefix", posixPrefix, posixArchive,
  ]);
  assert.deepEqual(publicInstallArgumentsFromGuide(windowsGuide, {
    guide: "windows", archiveName, prefix: posixPrefix, archive: posixArchive,
  }), [
    "install", "--global", "--ignore-scripts", "--no-audit", "--no-fund",
    "--prefix", posixPrefix, posixArchive,
  ]);
  assert.equal(installedBrainPath(posixPrefix, "darwin"), "/tmp/Financial Brain/bin/brain");
  assert.equal(installedBrainPath("C:\\Users\\Owner\\FinancialBrain", "win32"),
    "C:\\Users\\Owner\\FinancialBrain\\brain.cmd");
  assert.throws(() => publicInstallArgumentsFromGuide(macosGuide, {
    guide: "macos", archiveName, prefix: "relative-prefix", archive: posixArchive,
  }), /paths_must_be_absolute/);

  const batch = buildWindowsBatchInvocation(
    "C:\\Windows\\System32\\cmd.exe",
    "C:\\Runner Temp\\brain.cmd",
    ["--version"],
  );
  assert.equal(batch.shell, false);
  assert.equal(batch.windowsVerbatimArguments, true);
  assert.deepEqual(batch.args, ['/d /s /c ""C:\\Runner Temp\\brain.cmd" --version"']);
  assert.deepEqual(buildWindowsBatchInvocation(
    batch.command,
    "C:\\Runner Temp\\brain.cmd",
    ["doctor"],
  ).args, ['/d /s /c ""C:\\Runner Temp\\brain.cmd" doctor"']);
  assert.throws(() => buildWindowsBatchInvocation(batch.command, "C:\\bad%path\\brain.cmd", []), /wrapper_path_refused/);
  assert.throws(() => buildWindowsBatchInvocation(batch.command, "C:\\brain.cmd", ["doctor & whoami"]), /arguments_refused/);
});

test("public field-guide install mutations fail before npm arguments are derived", () => {
  const mutations = [
    ["missing global mode", windowsGuide.replace(" --global", "")],
    ["missing script refusal", windowsGuide.replace(" --ignore-scripts", "")],
    ["unexpected npm behavior", windowsGuide.replace(" --no-audit", " --force --no-audit")],
    ["wrong Windows executable", windowsGuide.replace("npm.cmd install", "npm install")],
    ["different Windows prefix", windowsGuide.replace("$env:LOCALAPPDATA\\FinancialBrain", "$env:TEMP\\FinancialBrain")],
    ["different archive variable", windowsGuide.replace('"$Archive"', '"$OtherArchive"')],
    ["different archive assignment", windowsGuide.replace(archiveName, "brain-installer-9.8.6.tgz")],
    ["trailing shell command", windowsGuide.replace('"$Archive"', '"$Archive"; whoami')],
    ["duplicate install command", `${windowsGuide}\r\n${windowsGuide.split(/\r?\n/)[2]}\r\n`],
  ];
  for (const [label, mutatedGuide] of mutations) {
    assert.throws(
      () => publicInstallArgumentsFromGuide(mutatedGuide, {
        guide: "windows",
        archiveName,
        prefix: "/tmp/Financial Brain",
        archive: `/tmp/${archiveName}`,
      }),
      /public_install_/,
      label,
    );
  }

  for (const [label, mutatedGuide] of [
    ["wrong macOS executable", macosGuide.replace("npm install", "npm.cmd install")],
    ["different macOS prefix", macosGuide.replace("$HOME/.npm-global", "$HOME/.financial-brain")],
    ["different macOS archive", macosGuide.replace(`./${archiveName}`, "./other.tgz")],
    ["reordered safety flags", macosGuide.replace("--ignore-scripts --no-audit", "--no-audit --ignore-scripts")],
  ]) {
    assert.throws(
      () => parsePublicInstallCommand(mutatedGuide, { guide: "macos", archiveName }),
      /public_install_/,
      label,
    );
  }
});

test("runtime-relative npm wins and an ambient npm locator cannot leave either Node install layout", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "brain-install-runtime-"));
  try {
    for (const platform of ["linux", "win32"]) {
      const runtime = join(sandbox, `runtime-${platform}`);
      const node = platform === "win32"
        ? join(runtime, "node.exe")
        : join(runtime, "bin", "node");
      mkdirSync(dirname(node), { recursive: true });
      writeFileSync(node, "");
      const primaryTree = platform === "win32" ? "node_modules" : "lib";
      const primaryCli = platform === "win32"
        ? join("node_modules", "npm", "bin", "npm-cli.js")
        : join("lib", "node_modules", "npm", "bin", "npm-cli.js");
      const runtimeCli = writeNpmFixture(runtime, primaryCli);

      const outside = join(sandbox, `outside-${platform}`);
      const outsideCli = writeNpmFixture(outside, join("npm", "bin", "npm-cli.js"));
      assert.equal(resolveNpmCliPath({
        environment: { npm_execpath: outsideCli },
        nodeExecutable: node,
        platform,
      }), runtimeCli, platform);

      rmSync(join(runtime, primaryTree), { recursive: true, force: true });
      assert.throws(
        () => resolveNpmCliPath({
          environment: { npm_execpath: outsideCli },
          nodeExecutable: node,
          platform,
        }),
        /npm_cli_unavailable/,
        platform,
      );

      const fallbackCli = writeNpmFixture(runtime, join("tools", "npm", "bin", "npm-cli.js"));
      assert.equal(resolveNpmCliPath({
        environment: { npm_execpath: fallbackCli },
        nodeExecutable: node,
        platform,
      }), fallbackCli, platform);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("npm CLI verification refuses a final symlink and a primary candidate escaping through an ancestor link", {
  skip: process.platform === "win32",
}, () => {
  const sandbox = mkdtempSync(join(tmpdir(), "brain-install-npm-link-"));
  try {
    const targetRoot = join(sandbox, "target");
    const targetCli = writeNpmFixture(targetRoot, join("npm", "bin", "npm-cli.js"));
    const linkedCli = join(sandbox, "npm-cli.js");
    symlinkSync(targetCli, linkedCli);
    assert.equal(verifiedNpmCliPath(linkedCli), null,
      "lstat must reject the supplied symlink before realpath can hide it");

    const runtime = join(sandbox, "runtime");
    const node = join(runtime, "bin", "node");
    mkdirSync(dirname(node), { recursive: true });
    writeFileSync(node, "");
    const outsideLib = join(sandbox, "outside-lib");
    writeNpmFixture(outsideLib, join("node_modules", "npm", "bin", "npm-cli.js"));
    symlinkSync(outsideLib, join(runtime, "lib"), "dir");
    assert.throws(
      () => resolveNpmCliPath({ environment: {}, nodeExecutable: node, platform: "linux" }),
      /npm_cli_unavailable/,
      "a nominal primary path whose real file left the runtime root must fail",
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("a Windows-style runtime never trusts an npm package beside its Node install directory", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "brain-install-windows-root-"));
  try {
    const runtime = join(sandbox, "nodejs");
    const node = join(runtime, "node.exe");
    mkdirSync(runtime, { recursive: true });
    writeFileSync(node, "");

    const siblingCli = writeNpmFixture(join(sandbox, "sibling"), join("npm", "bin", "npm-cli.js"));
    assert.throws(
      () => resolveNpmCliPath({
        environment: { npm_execpath: siblingCli },
        nodeExecutable: node,
        platform: "win32",
      }),
      /npm_cli_unavailable/,
    );

    const insideCli = writeNpmFixture(runtime, join("tools", "npm", "bin", "npm-cli.js"));
    assert.equal(resolveNpmCliPath({
      environment: { npm_execpath: insideCli },
      nodeExecutable: node,
      platform: "win32",
    }), insideCli);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("npm runs directly with literal arguments and a credential-free allowlisted environment", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "brain-install-npm-"));
  try {
    const cli = writeNpmFixture(sandbox, join("npm", "bin", "npm-cli.js"));
    const literalArgs = ["install", "path with spaces", "$HOME", "a&b", "semi;colon"];
    const direct = buildNpmCliInvocation(cli, literalArgs);
    assert.equal(direct.command, process.execPath);
    assert.equal(direct.shell, false);
    assert.deepEqual(JSON.parse(execFileSync(direct.command, direct.args, { encoding: "utf8" })), literalArgs);

    const environment = npmInstallEnvironment({
      PATH: "/fixture/bin",
      HOME: "/fixture/home",
      TEMP: "/fixture/temp",
      NPM_TOKEN: "must-not-pass",
      NODE_OPTIONS: "--require=must-not-pass",
      CLOUDFLARE_API_TOKEN: "must-not-pass",
      npm_execpath: cli,
    }, "linux");
    assert.deepEqual(environment, {
      PATH: "/fixture/bin",
      HOME: "/fixture/home",
      TEMP: "/fixture/temp",
      npm_config_yes: "true",
      NPM_CONFIG_USERCONFIG: "/dev/null",
    });
    assert.equal(Object.isFrozen(environment), true);
    assert.deepEqual(publicContractChildEnvironment({
      Path: "C:\\runtime",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      NPM_TOKEN: "must-not-pass",
      CLOUDFLARE_API_TOKEN: "must-not-pass",
    }), {
      PATH: "C:\\runtime",
      SYSTEMROOT: "C:\\Windows",
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("the Windows PowerShell bridge accepts only the parsed npm.cmd contract and batch-safe paths", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "brain-install-powershell-contract-"));
  try {
    const npmCommand = join(sandbox, "npm.cmd");
    const powershell = join(sandbox, "powershell.exe");
    const contractPath = join(sandbox, "install.json");
    const prefix = join(sandbox, "prefix");
    const archive = join(sandbox, archiveName);
    mkdirSync(prefix);
    writeFileSync(npmCommand, "fixture");
    writeFileSync(powershell, "fixture");
    writeFileSync(archive, "fixture");
    const args = publicInstallArgumentsFromGuide(windowsGuide, {
      guide: "windows", archiveName, prefix, archive,
    });
    const invocation = buildWindowsNpmPowerShellInvocation({
      executable: "npm.cmd",
      args,
      expectedCommand: npmCommand,
      contractPath,
      helperPath: powershellHelper,
      powershellPath: powershell,
    });
    assert.deepEqual(JSON.parse(invocation.contract).arguments, args);
    assert.equal(invocation.shell, false);
    assert.throws(() => buildWindowsNpmPowerShellInvocation({
      executable: "npm",
      args,
      expectedCommand: npmCommand,
      contractPath,
      helperPath: powershellHelper,
      powershellPath: powershell,
    }), /executable_refused/);
    assert.throws(() => buildWindowsNpmPowerShellInvocation({
      executable: "npm.cmd",
      args: [...args.slice(0, 2), "--force", ...args.slice(3)],
      expectedCommand: npmCommand,
      contractPath,
      helperPath: powershellHelper,
      powershellPath: powershell,
    }), /arguments_refused/);
    assert.throws(() => buildWindowsNpmPowerShellInvocation({
      executable: "npm.cmd",
      args: [...args.slice(0, -2), `${prefix}&whoami`, archive],
      expectedCommand: npmCommand,
      contractPath,
      helperPath: powershellHelper,
      powershellPath: powershell,
    }), /path_refused/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("the Windows runner resolves its default npm and executes a temporary .cmd shim", {
  skip: process.platform !== "win32",
}, () => {
  const npmCli = resolveNpmCliPath();
  const runtimeCli = nodeRuntimeNpmCliPaths().map(verifiedNpmCliPath).find(Boolean);
  const runtimeCommand = resolveWindowsNpmCommandPath();
  if (process.env.GITHUB_ACTIONS === "true") {
    assert.equal(npmCli, runtimeCli, "setup-node npm must resolve from the selected Node runtime");
    assert.equal(dirname(runtimeCommand).toLowerCase(), dirname(process.execPath).toLowerCase(),
      "setup-node npm.cmd must resolve beside the selected Node runtime");
  } else {
    assert.equal(verifiedNpmCliPath(npmCli), npmCli);
  }
  const npmVersion = execFileSync(process.execPath, [npmCli, "--version"], {
    encoding: "utf8",
    env: npmInstallEnvironment(),
    shell: false,
  }).trim();
  assert.match(npmVersion, /^\d+\.\d+\.\d+(?:[-+].*)?$/);

  const sandbox = mkdtempSync(join(tmpdir(), "brain install cmd "));
  try {
    const wrapper = join(sandbox, "brain.cmd");
    writeFileSync(wrapper, [
      "@echo off",
      "if \"%~1\"==\"--version\" (",
      "  echo fixture-version",
      "  exit /b 0",
      ")",
      "exit /b 7",
      "",
    ].join("\r\n"));
    const invocation = buildWindowsBatchInvocation(
      process.env.ComSpec || process.env.COMSPEC || "C:\\Windows\\System32\\cmd.exe",
      wrapper,
      ["--version"],
    );
    const output = execFileSync(invocation.command, invocation.args, {
      encoding: "utf8",
      env: npmInstallEnvironment(),
      shell: invocation.shell,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    }).trim();
    assert.equal(output, "fixture-version");
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("the Windows public install bridge runs under Restricted policy and preserves spaced arguments", {
  skip: process.platform !== "win32",
}, () => {
  const sandbox = mkdtempSync(join(tmpdir(), "brain npm powershell "));
  const powershellPath = resolveWindowsPowerShellPath();
  const policyCommand = (command) => execFileSync(powershellPath,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8",
      env: npmInstallEnvironment(),
      shell: false,
    }).trim();
  let restoreCurrentUserPolicy = null;
  try {
    const runtime = join(sandbox, "runtime with spaces");
    const node = join(runtime, "node.exe");
    const npmCommand = join(runtime, "npm.cmd");
    const recorder = join(sandbox, "record arguments.mjs");
    const prefix = join(sandbox, "prefix with spaces");
    const archive = join(sandbox, archiveName);
    const contractPath = join(sandbox, "install contract.json");
    mkdirSync(runtime, { recursive: true });
    mkdirSync(prefix, { recursive: true });
    writeFileSync(node, "");
    writeFileSync(archive, "fixture archive");
    writeFileSync(recorder, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    writeFileSync(npmCommand, [
      "@echo off",
      `"${process.execPath}" "${recorder}" %*`,
      "",
    ].join("\r\n"));

    const parsed = parsePublicInstallCommand(windowsGuide, { guide: "windows", archiveName });
    const args = publicInstallArgumentsFromGuide(windowsGuide, {
      guide: "windows", archiveName, prefix, archive,
    });
    const invocation = buildWindowsNpmPowerShellInvocation({
      executable: parsed.executable,
      args,
      expectedCommand: resolveWindowsNpmCommandPath({ nodeExecutable: node, platform: "win32" }),
      contractPath,
      helperPath: powershellHelper,
      powershellPath,
    });
    writeFileSync(contractPath, invocation.contract, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const effectivePolicy = policyCommand("Get-ExecutionPolicy");
    if (effectivePolicy !== "Restricted") {
      const prior = policyCommand("Get-ExecutionPolicy -Scope CurrentUser");
      assert.match(prior, /^(?:Undefined|Restricted|AllSigned|RemoteSigned|Unrestricted|Bypass|Default)$/);
      restoreCurrentUserPolicy = prior;
      policyCommand("Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy Restricted -Force");
    }
    assert.equal(policyCommand("Get-ExecutionPolicy"), "Restricted",
      "the installed helper must be tested against a real CurrentUser Restricted policy");
    const environment = npmInstallEnvironment({
      ...process.env,
      PATH: `${runtime};${process.env.PATH || ""}`,
    }, "win32");
    const output = execFileSync(invocation.command, invocation.args, {
      encoding: "utf8",
      env: environment,
      shell: invocation.shell,
    }).trim();
    assert.deepEqual(JSON.parse(output), args);
  } finally {
    if (restoreCurrentUserPolicy !== null) {
      policyCommand(`Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy ${restoreCurrentUserPolicy} -Force`);
    }
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a pre-helper execution-policy block is distinct from a helper contract refusal", () => {
  assert.equal(classifyWindowsNpmPowerShellFailure(
    "File could not be loaded. FullyQualifiedErrorId : UnauthorizedAccess",
  ), "powershell_execution_policy_blocked");
  assert.equal(classifyWindowsNpmPowerShellFailure(
    "PUBLIC_NPM_REFUSED package_identity_unverified",
  ), "public_npm_contract_refused");
  assert.equal(classifyWindowsNpmPowerShellFailure(
    "PUBLIC_NPM_REFUSED contract_unreadable; UnauthorizedAccess",
  ), "public_npm_contract_refused", "a helper refusal wins even if its own diagnostics mention access");
  assert.equal(classifyWindowsNpmPowerShellFailure("unrecognized failure"), "windows_npm_launch_failed");
});

test("the public install caller prints a sanitized diagnosis after preserving the helper's stderr", {
  skip: process.platform !== "win32",
}, () => {
  const sandbox = mkdtempSync(join(tmpdir(), "brain public caller "));
  const powershellPath = resolveWindowsPowerShellPath();
  const policyCommand = (command) => execFileSync(powershellPath,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8", env: npmInstallEnvironment(), shell: false,
    }).trim();
  let restoreCurrentUserPolicy = null;
  try {
    const version = "9.8.7";
    const candidateCommit = "a".repeat(40);
    const tgzName = `brain-installer-${version}.tgz`;
    const packageRoot = join(sandbox, "package");
    mkdirSync(join(packageRoot, "bin"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
      name: "brain-installer", version, type: "module", bin: { brain: "bin/brain.mjs" },
    }));
    writeFileSync(join(packageRoot, "bin", "brain.mjs"), [
      "#!/usr/bin/env node",
      'if (process.argv[2] === "--version") console.log("9.8.7");',
      'else if (process.argv[2] === "doctor") { console.log("Node checked"); process.exitCode = 1; }',
      "",
    ].join("\n"));
    const tgzPath = join(sandbox, tgzName);
    execFileSync("tar.exe", ["-czf", tgzName, "-C", sandbox, "package"], {
      cwd: sandbox,
      shell: false,
    });
    const tgz = readFileSync(tgzPath);
    const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const humanBytes = tgz.length.toLocaleString("en-US");
    const root = "synthetic-field-kit";
    const zip = Buffer.from(zipSync({
      [`${root}/${tgzName}`]: tgz,
      [`${root}/SHA256SUMS.txt`]: strToU8(`${digest(tgz)}  ${tgzName}\n`),
      [`${root}/WINDOWS-FIELD-TEST.md`]: strToU8(`${windowsGuide}\nPackage bytes: ${tgz.length}\n`),
      [`${root}/MACOS-FIELD-TEST.md`]: strToU8(
        `${macosGuide}\nCANDIDATE_COMMIT: ${candidateCommit}\nPackage bytes: ${tgz.length}\n`,
      ),
      [`${root}/RELEASE-CANDIDATE-RECEIPT.md`]: strToU8(
        `commit ${candidateCommit.slice(0, 7)}; ${humanBytes} bytes; sha256 ${digest(tgz)}\n`,
      ),
    }));
    const zipPath = join(sandbox, "fixture-kit.zip");
    const guidePath = join(sandbox, "fixture-guide.md");
    writeFileSync(zipPath, zip);
    const artifactUrl = `https://financialbrain.ai/install/financial-brain-v${version}-field-kit-${digest(zip).slice(0, 16)}.zip`;
    writeFileSync(guidePath, [
      "AGENT_INSTALL_CONTRACT_VERSION: 2",
      "STATUS: supervised field-test candidate",
      "OWNER_PRESENT: required",
      "TARGET: physical Windows 10 or newer",
      "SETUP_PAGE: https://financialbrain.ai/install",
      `CANDIDATE_VERSION: ${version}`,
      `CANDIDATE_COMMIT: ${candidateCommit}`,
      `ARTIFACT_SHA256: ${digest(zip)}`,
      `ARTIFACT_BYTES: ${zip.length}`,
      `ARTIFACT_URL: ${artifactUrl}`,
      "",
    ].join("\n"));

    // Only these two fixture responses are available. Any attempted network
    // request, including an unexpected install source, fails the child.
    const preloadPath = join(sandbox, "offline-public-contract.mjs");
    writeFileSync(preloadPath, [
      'import { readFileSync } from "node:fs";',
      'import { registerHooks } from "node:module";',
      'registerHooks({ load(url, context, nextLoad) {',
      '  const result = nextLoad(url, context);',
      '  if (process.env.BRAIN_TEST_REMOVE_POLICY_FLAG === "1" && url.endsWith("/operations/npm-cli-runtime.mjs")) {',
      '    const source = String(result.source);',
      '    const flag = \'"-ExecutionPolicy", "Bypass", \';',
      '    if (!source.includes(flag)) throw new Error("policy flag mutation target missing");',
      '    return { ...result, source: source.replace(flag, "") };',
      '  }',
      '  return result;',
      '} });',
      'globalThis.fetch = async (url) => {',
      '  if (url === "https://financialbrain.ai/install/agent.md")',
      '    return new Response(readFileSync(process.env.BRAIN_TEST_GUIDE_PATH));',
      '  if (url === process.env.BRAIN_TEST_ARTIFACT_URL)',
      '    return new Response(readFileSync(process.env.BRAIN_TEST_ZIP_PATH));',
      '  throw new Error("offline fixture refused an unexpected fetch");',
      '};',
      "",
    ].join("\n"));
    const fakeNpmDirectory = join(sandbox, "wrong npm");
    mkdirSync(fakeNpmDirectory);
    writeFileSync(join(fakeNpmDirectory, "npm.cmd"), "@echo off\r\nexit /b 9\r\n");
    const localAppData = join(sandbox, "localappdata");
    mkdirSync(localAppData);
    const unzipDirectory = [
      ...(process.env.PATH || process.env.Path || "").split(";"),
      join(process.env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin"),
    ].find((directory) => existsSync(join(directory, "unzip.exe")));
    assert.ok(unzipDirectory, "the Windows install caller requires an unzip executable");
    const caller = fileURLToPath(new URL("../scripts/install-from-public-contract.mjs", import.meta.url));
    const runCaller = (mode) => spawnSync(process.execPath, [
      "--import", pathToFileURL(preloadPath).href, caller, join(sandbox, `run-${mode}`), "--guide", "windows",
    ], {
      cwd: dirname(caller),
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 5_000_000,
      shell: false,
      env: {
        ...process.env,
        LOCALAPPDATA: localAppData,
        PATH: [
          ...(mode === "helper-refusal" ? [fakeNpmDirectory] : []),
          unzipDirectory,
          process.env.PATH || process.env.Path || "",
        ].join(";"),
        BRAIN_TEST_GUIDE_PATH: guidePath,
        BRAIN_TEST_ZIP_PATH: zipPath,
        BRAIN_TEST_ARTIFACT_URL: artifactUrl,
        BRAIN_TEST_REMOVE_POLICY_FLAG: mode === "policy-block" ? "1" : "0",
      },
    });

    const success = runCaller("success");
    assert.equal(success.status, 0, `success: ${success.stderr}`);
    assert.match(success.stdout, /PASS  the packaged archive installs into a clean prefix/);
    assert.match(success.stdout, /install contract: every published claim verified on win32/);
    assert.doesNotMatch(success.stderr, /FAIL  (?:powershell_execution_policy_blocked|public_npm_contract_refused)/);

    const helperRefusal = runCaller("helper-refusal");
    assert.equal(helperRefusal.status, 1);
    assert.match(helperRefusal.stderr, /PUBLIC_NPM_REFUSED npm_path_mismatch/);
    assert.match(helperRefusal.stderr, /FAIL  public_npm_contract_refused/);
    assert.equal(helperRefusal.stderr.replace(/FAIL  public_npm_contract_refused\n$/, ""),
      "PUBLIC_NPM_REFUSED npm_path_mismatch\r\n",
      "the caller must forward the helper's original stderr bytes before adding its own line");
    assert.ok(helperRefusal.stderr.indexOf("PUBLIC_NPM_REFUSED") <
      helperRefusal.stderr.indexOf("FAIL  public_npm_contract_refused"),
    "the original helper stderr must precede the additive diagnosis");

    if (policyCommand("Get-ExecutionPolicy") !== "Restricted") {
      const prior = policyCommand("Get-ExecutionPolicy -Scope CurrentUser");
      assert.match(prior, /^(?:Undefined|Restricted|AllSigned|RemoteSigned|Unrestricted|Bypass|Default)$/);
      restoreCurrentUserPolicy = prior;
      policyCommand("Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy Restricted -Force");
    }
    assert.equal(policyCommand("Get-ExecutionPolicy"), "Restricted");
    const policyBlock = runCaller("policy-block");
    assert.equal(policyBlock.status, 1);
    assert.match(policyBlock.stderr, /UnauthorizedAccess/);
    assert.doesNotMatch(policyBlock.stderr, /PUBLIC_NPM_REFUSED/);
    assert.match(policyBlock.stderr, /FAIL  powershell_execution_policy_blocked/);
    assert.ok(policyBlock.stderr.indexOf("UnauthorizedAccess") <
      policyBlock.stderr.indexOf("FAIL  powershell_execution_policy_blocked"),
    "the original PowerShell stderr must precede the additive diagnosis");
  } finally {
    if (restoreCurrentUserPolicy !== null) {
      policyCommand(`Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy ${restoreCurrentUserPolicy} -Force`);
    }
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
