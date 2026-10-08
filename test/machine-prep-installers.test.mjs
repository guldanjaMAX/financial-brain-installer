import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { versionGuardArgs } from "../machine-prep/installers/smoke/bootstrap.mjs";
import { inspectPerUserWix } from "./helpers/wix-authoring.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const HANDOFF = join(ROOT, "machine-prep", "handoff");
const MAC_INSTALLER = join(ROOT, "machine-prep", "installers", "macos");
const WINDOWS_INSTALLER = join(ROOT, "machine-prep", "installers", "windows");
const KIT_URL = "https://financialbrain.ai/kit/brain-installer-0.4.9-0555ad1972d7f8d6.tgz";
const KIT_SHA256 = "0555ad1972d7f8d6c1ded78a9fc4265f873cc4f4ce8c11fd04198cc5599409b2";
const KIT_SIZE = "6668013";
const WINDOWS_POWERSHELL_PROCESS_TIMEOUT_MS = 120_000;
const BASH_BEHAVIOR_ON_WINDOWS_SKIP_REASON =
  "requires Unix shell semantics and remains active on the macOS and Linux CI lanes";

function bashBehaviorOptions(platform = process.platform) {
  return {
    skip: platform === "win32" ? BASH_BEHAVIOR_ON_WINDOWS_SKIP_REASON : false,
  };
}

function read(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8").replaceAll("\r\n", "\n");
}

test("per-user WiX contract reaches every directory and component in the actual package", () => {
  const inspected = inspectPerUserWix(read("machine-prep/installers/windows/Package.wxs"));
  assert.equal(inspected.directories.length, 3, "actual per-user directory decisions reached");
  assert.equal(inspected.components.length, 3, "actual component KeyPath decisions reached");
  assert.deepEqual(inspected.issues, []);
});

test("per-user WiX contract rejects missing cleanup and invalid key paths with a green control", () => {
  const component = (id) => `<Component Id="${id}">
    <File Id="${id}File" Source="synthetic.txt" />
    <RemoveFolder Id="Remove${id}" On="uninstall" />
    <RegistryValue Root="HKCU" Key="Software\\SyntheticInstaller" Name="${id}" KeyPath="yes" />
  </Component>`;
  const control = `<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs"><Package Scope="perUser">
    <StandardDirectory Id="LocalAppDataFolder"><Directory Id="App">
      ${component("Payload")}<Directory Id="Nested">${component("Handoff")}</Directory>
    </Directory></StandardDirectory>
    <StandardDirectory Id="ProgramMenuFolder"><Directory Id="Menu">${component("Shortcut")}</Directory></StandardDirectory>
  </Package></Wix>`;
  assert.deepEqual(inspectPerUserWix(control).issues, [], "green nested-directory and shortcut control");
  const mutants = [];
  for (const [id, directory] of [["Payload", "App"], ["Handoff", "Nested"], ["Shortcut", "Menu"]]) {
    const removal = `<RemoveFolder Id="Remove${id}" On="uninstall" />`;
    const registry = `<RegistryValue Root="HKCU" Key="Software\\SyntheticInstaller" Name="${id}" KeyPath="yes" />`;
    mutants.push(
      [removal, `<!-- ${removal} -->`, `ICE64: ${directory}`],
      [removal, removal.replace('On="uninstall"', 'On="install"'), `ICE64: ${directory}`],
      [removal, removal.replace('On="uninstall"', 'On="uninstall" Directory="Elsewhere"'), `ICE64: ${directory}`],
      [registry, "", `ICE38/ICE43: ${id}`],
      [registry, registry.replace('Root="HKCU"', 'Root="HKLM"'), `ICE57: ${id}`],
      [registry, registry.replace(' KeyPath="yes"', ""), `ICE38/ICE43: ${id}`],
      [`<File Id="${id}File"`, `<File KeyPath="yes" Id="${id}File"`, `ICE38/ICE43: ${id}`],
    );
  }
  mutants.push(['<Directory Id="Nested">', '<Directory Id="Uncovered" /><Directory Id="Nested">', "ICE64: Uncovered"]);
  mutants.push(['Name="Handoff" KeyPath="yes"', 'Name="Payload" KeyPath="yes"', "Shared registry marker: Handoff"]);
  mutants.push(['Name="Handoff" KeyPath="yes"', 'Name="PAYLOAD" KeyPath="yes"', "Shared registry marker: Handoff"]);
  for (const [from, to, issue] of mutants) {
    assert.ok(control.includes(from), "mutation target reached");
    const mutant = control.replace(from, to);
    assert.notEqual(mutant, control);
    const inspected = inspectPerUserWix(mutant);
    assert.ok(inspected.directories.length >= 3 && inspected.components.length === 3, "negative arm traversed real decisions");
    assert.ok(inspected.issues.some((message) => message.startsWith(issue)), issue);
  }
  const reformatted = control.replaceAll('"', "'").replaceAll("\n", "\r\n");
  assert.deepEqual(inspectPerUserWix(reformatted).issues, [], "quote style and CRLF do not hide authoring");
});

test("Windows smoke verifies every per-user registry marker and uninstall directory", () => {
  const source = read("machine-prep/installers/smoke/windows.ps1");
  for (const [component, marker] of [["MachinePrepScripts", "scriptsInstalled"], ["ClaudeHandoff", "handoffInstalled"], ["MachinePrepShortcut", "installed"]]) {
    assert.ok(source.includes(`${component} = '${marker}'`), `smoke must expect the ${component} registry KeyPath`);
  }
  assert.match(source, /Assert-PerUserTables \$componentRows \$registry \$removals/);
  assert.match(source, /\$RegistryRows\.Count -ne \$RegistryMarkers\.Count/);
  assert.match(source, /\$RemovalRows\.Count -ne \$Components\.Count/);
  assert.match(source, /\$component\.KeyPath -cne \$rows\[0\]\.Registry/);
  assert.match(source, /\$component\.Attributes -band 4/);
  assert.match(source, /\$removal\[0\]\.DirProperty -cne \$component\.Directory_/);
  assert.match(source, /\$removal\[0\]\.InstallMode -ne '2'/);
  assert.match(source, /foreach \(\$marker in \$RegistryMarkers\.Values\)/);
  assert.match(source, /\$installedMarkers\.\$marker -ne 1/);
});

test("Windows smoke executes per-user table refusals with a green control", { skip: process.platform !== "win32" }, () => {
  const source = read("machine-prep/installers/smoke/windows.ps1");
  const markers = /\$RegistryMarkers = @\{[^}]+\}/.exec(source)?.[0];
  const functions = source.slice(source.indexOf("function Assert-EqualSet("), source.indexOf("function Assert-Absent("));
  assert.ok(markers && functions.includes("function Assert-PerUserTables("), "real smoke table validator extracted");
  const ids = ["MachinePrepScripts", "ClaudeHandoff", "MachinePrepShortcut"];
  const directories = ["INSTALLFOLDER", "HANDOFFFOLDER", "ApplicationProgramsFolder"];
  const names = ["scriptsInstalled", "handoffInstalled", "installed"];
  const control = {
    components: ids.map((id, index) => ({ Component: id, Directory_: directories[index], Attributes: "260", KeyPath: `Marker${index}` })),
    registry: ids.map((id, index) => ({ Registry: `Marker${index}`, Component_: id, Root: "1", Key: "Software\\FinancialBrain\\MachinePrep", Name: names[index], Value: "#1" })),
    removals: ids.map((id, index) => ({ Component_: id, FileName: "", DirProperty: directories[index], InstallMode: "2" })),
  };
  const cases = [{ name: "green", rows: control, accept: true }];
  for (let index = 0; index < ids.length; index++) {
    for (const [table, field, value] of [
      ["registry", "Root", "2"], ["registry", "Name", "unreviewed"],
      ["registry", "Key", "Software\\Elsewhere"], ["registry", "Value", "#0"],
      ["registry", "Component_", "unreviewed"], ["components", "Attributes", "256"],
      ["components", "KeyPath", "FileKeyPath"], ["removals", "DirProperty", "LocalAppDataFolder"],
      ["removals", "FileName", "*"], ["removals", "InstallMode", "1"],
    ]) {
      const rows = structuredClone(control);
      rows[table][index][field] = value;
      cases.push({ name: `${ids[index]}-${field}`, rows, accept: false });
    }
    for (const table of ["registry", "removals"]) {
      for (const action of ["missing", "extra"]) {
        const rows = structuredClone(control);
        if (action === "missing") rows[table].splice(index, 1);
        else rows[table].push({ ...rows[table][index] });
        cases.push({ name: `${ids[index]}-${table}-${action}`, rows, accept: false });
      }
    }
  }
  const home = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-wix-tables-")));
  mkdirSync(join(home, "temp"));
  const fixture = join(home, "table-contract.ps1");
  // Only the pure table-check functions are executed. No installer, registry,
  // credential helper, or top-level native smoke phase is invoked by this test.
  writeFileSync(fixture, `Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
${markers}
${functions}
$cases = @'
${JSON.stringify(cases)}
'@ | ConvertFrom-Json
foreach ($case in $cases) {
  $accepted = $false
  $events = @()
  try {
    Assert-PerUserTables $case.rows.components $case.rows.registry $case.rows.removals | ForEach-Object { $events += $_ }
    $accepted = $true
  } catch {
    if ($_.Exception.Message -notmatch '^Unexpected MSI ') { throw }
  }
  if ($events -notcontains 'PER_USER_TABLE_DECISION_REACHED=1') { throw 'table decision not reached' }
  if ($accepted -ne $case.accept) { throw ('wrong table decision: ' + $case.name) }
  Write-Output ('TABLE_ARM_VERIFIED=' + $case.name)
}
`);
  try {
    const powerShell = process.env.SystemRoot
      ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
    const result = spawnSync(powerShell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixture], {
      cwd: ROOT, encoding: "utf8", timeout: WINDOWS_POWERSHELL_PROCESS_TIMEOUT_MS,
      env: {
        SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
        PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, COMSPEC: process.env.COMSPEC,
        HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, "local"), APPDATA: join(home, "roaming"),
        TEMP: join(home, "temp"), TMP: join(home, "temp"), BRAIN_NO_WRANGLER_LOGIN: "1",
        BRAIN_TEST_LAUNCHCTL: join(home, "injected-launchctl"),
      },
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(result.stdout.match(/^TABLE_ARM_VERIFIED=/gm)?.length, cases.length, "all 43 table decisions reached");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("x64 MSI launcher declaration and native smoke resolve the same 64-bit PowerShell", () => {
  const authored = read("machine-prep/installers/windows/Package.wxs");
  const adapter = read("machine-prep/installers/smoke/windows.ps1");
  assert.match(read("machine-prep/installers/windows/FinancialBrainMachinePrep.wixproj"), /<Platform>x64<\/Platform>/);
  const target = /Target="\[([^\]]+)\]WindowsPowerShell\\v1\.0\\powershell\.exe"/.exec(authored);
  assert.ok(target, "actual authored shortcut decision reached");
  // Windows Installer SystemFolder is SysWOW64 on x64; System64Folder is System32.
  const resolveDirectory = (id) => ({ SystemFolder: "SysWOW64", System64Folder: "System32" })[id];
  assert.equal(resolveDirectory("System64Folder"), "System32", "green Windows directory control");
  assert.equal(resolveDirectory(target[1]), "System32");
  assert.ok(adapter.includes("'[System64Folder]WindowsPowerShell\\v1.0\\powershell.exe'"));
  assert.ok(adapter.includes("'System32\\WindowsPowerShell\\v1.0\\powershell.exe'"));
  assert.match(adapter, /\$shortcut\.TargetPath -ine \$expectedTarget/);
});

function assertBootstrapJobs(workflow) {
  for (const platform of ["macos", "windows"]) {
    const marker = `\n  ${platform}-bootstrap:\n`;
    assert.ok(workflow.includes(marker), `${platform} pinned-kit bootstrap job missing`);
    const job = workflow.split(marker)[1].split(/\n  [a-z][a-z-]+:\n/)[0];
    assert.match(job, new RegExp(`needs: \\[authorization, ${platform}-sign\\]`));
    assert.ok(job.includes(`needs.${platform}-sign.result == 'success'`));
    assert.ok(job.includes(`needs.${platform}-sign.outputs.artifact_id != ''`));
    assert.match(job, /needs\.authorization\.outputs\.authorized == 'true'/);
    assert.ok(job.includes("artifact-ids: ${{ needs." + platform + "-sign.outputs.artifact_id }}"));
    assert.match(job, /permissions:\n      contents: read/);
    assert.match(job, /--bootstrap/);
    assert.match(job, /if: always\(\)/);
    assert.match(job, /upload-artifact@[0-9a-f]{40}/);
    assert.doesNotMatch(job, /environment:|secrets\.|id-token:|run-id:|github-token:|MACHINE_PREP_TEST/);
  }
}

test("pinned-kit bootstrap jobs require same-run signatures and have no signing authority", () => {
  const workflow = read(".github/workflows/installer-signing.yml");
  assertBootstrapJobs(workflow);
  for (const platform of ["macos", "windows"]) {
    const start = workflow.indexOf(`\n  ${platform}-bootstrap:\n`);
    const from = `needs.${platform}-sign.result == 'success'`;
    assert.ok(start > 0 && workflow.slice(start).includes(from), "bootstrap authorization decision reached");
    const mutant = workflow.slice(0, start) + workflow.slice(start).replace(from, "true");
    assert.notEqual(mutant, workflow);
    assert.throws(() => assertBootstrapJobs(mutant));
  }
});

test("installed preparation exposes a bounded CLI-only mode without bypassing real session guards", () => {
  for (const file of ["machine-prep/prep-mac.sh", "machine-prep/prep-windows.ps1"]) {
    const source = read(file);
    assert.match(source, /--prepare-cli/);
    assert.match(source, /CLI_PREPARATION_SESSION_DECISION_REACHED=1/);
    assert.match(source, /CLI_PREPARATION_PREREQUISITE_DECISION_REACHED=1/);
  }
});

test("pinned-kit proof reaches every refusal and cleans after preparation with a green control", async () => {
  const { runKitProof } = await import("../machine-prep/installers/smoke/bootstrap.mjs");
  const phases = ["assertClean", "verifyPins", "download", "verifyArchive", "prepare", "verifyProvenance", "verifyVersion", "cleanup"];
  const run = async (failure) => {
    const calls = [], events = [];
    const host = Object.fromEntries(phases.map((phase) => [phase, () => {
      calls.push(phase);
      if (phase === failure) throw new Error("synthetic bootstrap refusal");
    }]));
    let error;
    try { await runKitProof(host, (event) => events.push(event)); } catch (caught) { error = caught; }
    return { calls, events, error };
  };
  const control = await run();
  assert.equal(control.error, undefined);
  assert.deepEqual(control.calls, phases);
  assert.match(control.events.at(-1), /PINNED_KIT_BOOTSTRAP_VERIFIED=1 version=0\.4\.9/);
  for (const phase of phases) {
    const refused = await run(phase);
    assert.ok(refused.error);
    assert.ok(refused.calls.includes(phase), "negative arm reached its real decision");
    assert.ok(refused.events.includes(`BOOTSTRAP_DECISION_REACHED=${phase}`));
    assert.equal(refused.calls.includes("cleanup"), phase !== "assertClean");
    assert.ok(!refused.events.some((event) => event.startsWith("PINNED_KIT_BOOTSTRAP_VERIFIED=1")));
  }
});

test("pinned-kit verifier rejects changed size, bytes and installed pins with green controls", async () => {
  const { KIT, verifyKit, verifyPreparationPins } = await import("../machine-prep/installers/smoke/bootstrap.mjs");
  const { createHash } = await import("node:crypto");
  const bytes = Buffer.from("synthetic kit witness");
  const pin = { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  verifyKit(bytes, pin);
  assert.throws(() => verifyKit(Buffer.concat([bytes, Buffer.from("x")]), pin), /length mismatch/);
  const tampered = Buffer.from(bytes); tampered[0] ^= 1;
  assert.equal(tampered.length, pin.size, "digest decision reached after length passed");
  assert.throws(() => verifyKit(tampered, pin), /SHA-256 mismatch/);
  assert.equal(KIT.url, KIT_URL); assert.equal(String(KIT.size), KIT_SIZE); assert.equal(KIT.sha256, KIT_SHA256);
  for (const [platform, path] of [["macos", "machine-prep/prep-mac.sh"], ["windows", "machine-prep/prep-windows.ps1"]]) {
    const source = read(path);
    verifyPreparationPins(source, platform);
    for (const from of [KIT.version, KIT.url, String(KIT.size), KIT.sha256]) {
      assert.ok(source.includes(from), "installed pin mutation reached");
      const mutant = source.replace(from, "changed");
      assert.notEqual(mutant, source);
      assert.throws(() => verifyPreparationPins(mutant, platform), /pins differ/);
    }
  }
});

test("pinned-kit provenance compares actual installed bytes instead of trusting version text", async () => {
  const { verifyPackageTree } = await import("../machine-prep/installers/smoke/bootstrap.mjs");
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "kit-provenance-")));
  const expected = join(root, "witness"), installed = join(root, "installed");
  for (const directory of [expected, installed]) {
    mkdirSync(directory);
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "brain-installer", version: "0.4.9", bin: { brain: "./brain.mjs" } }));
    writeFileSync(join(directory, "brain.mjs"), "console.log('0.4.9');\n");
  }
  try {
    assert.equal(verifyPackageTree(expected, installed), 2, "green installed identity and bytes reached");
    writeFileSync(join(installed, "brain.mjs"), "console.log('0.4.9'); // changed bytes\n");
    assert.throws(() => verifyPackageTree(expected, installed), /bytes differ/);
    writeFileSync(join(installed, "brain.mjs"), readFileSync(join(expected, "brain.mjs")));
    writeFileSync(join(installed, "extra.mjs"), "synthetic\n");
    assert.throws(() => verifyPackageTree(expected, installed), /inventory/);
  } finally { rmSync(root, { recursive: true }); }
});

test("pinned-kit source inventory permits only npm shims named by authenticated dependency bins", async () => {
  const { verifyPackageTree } = await import("../machine-prep/installers/smoke/bootstrap.mjs");
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "kit-bin-map-")));
  const expected = join(root, "witness"), installed = join(root, "installed");
  try {
    for (const directory of [expected, installed]) {
      mkdirSync(join(directory, "node_modules", "synthetic-tool"), { recursive: true });
      writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "brain-installer", version: "0.4.9", bin: { brain: "./brain.mjs" } }));
      writeFileSync(join(directory, "brain.mjs"), "console.log('0.4.9');\n");
      writeFileSync(join(directory, "node_modules", "synthetic-tool", "package.json"), JSON.stringify({ name: "synthetic-tool", bin: { "synthetic-tool": "run.js" } }));
      writeFileSync(join(directory, "node_modules", "synthetic-tool", "run.js"), "// synthetic dependency\n");
    }
    mkdirSync(join(installed, "node_modules", ".bin"));
    writeFileSync(join(installed, "node_modules", ".bin", "synthetic-tool.cmd"), "synthetic unexecuted npm command shim\n");
    assert.equal(verifyPackageTree(expected, installed), 4, "authenticated bin-map decision reached");
    writeFileSync(join(installed, "node_modules", ".bin", "unreviewed.cmd"), "synthetic extra\n");
    assert.throws(() => verifyPackageTree(expected, installed), /inventory/);
  } finally { rmSync(root, { recursive: true }); }
});

test("bootstrap version arguments use canonical Windows paths and an encoded ESM file URL", () => {
  // Exercise Windows URL semantics on every host without touching a drive or share.
  const canonical = [
    "D:\\Runner Data\\Installed Kit",
    "D:\\Runner Data\\Installed Kit\\brain.mjs",
    "D:\\Reviewed Source # 100%\\version-guard.mjs",
  ];
  for (const paths of [
    canonical,
    ["d:/Runner Data/Installed Kit", "d:/Runner Data/Installed Kit/brain.mjs", "d:/Reviewed Source # 100%/version-guard.mjs"],
    ["D:\\RUNNER~1\\INSTAL~1", "D:\\RUNNER~1\\INSTAL~1\\brain.mjs", "D:\\REVIEW~1\\version-guard.mjs"],
    ["D:\\kit-junction", "D:\\kit-junction\\brain.mjs", "D:\\source-junction\\version-guard.mjs"],
  ]) {
    const calls = [];
    const [prefix, entrypoint, guard] = paths;
    const args = versionGuardArgs({ prefix, entrypoint, guard }, { windows: true, realpath(path) {
      calls.push(path);
      assert.ok(paths.includes(path), "only the three requested paths may be resolved");
      return canonical[paths.indexOf(path)];
    } });
    assert.deepEqual(calls, paths, "every path canonicalization decision reached");
    assert.deepEqual(args, ["--permission", `--allow-fs-read=${canonical[0]}`, `--allow-fs-read=${canonical[2]}`,
      "--import", "file:///D:/Reviewed%20Source%20%23%20100%25/version-guard.mjs", canonical[1], "--version"]);
  }
});

for (const fixtureKind of ["physical directory", "directory alias", "URL-reserved characters"]) {
  test(`bootstrap version guard denies network and child processes after reached decisions (${fixtureKind})`, () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "kit-version-guard-")));
    try {
      const fixture = join(root, fixtureKind === "URL-reserved characters" ? "fixture # 100%" : "fixture");
      mkdirSync(fixture);
      let fixturePath = fixture;
      if (fixtureKind === "directory alias") {
        fixturePath = join(root, "alias");
        symlinkSync(realpathSync.native(fixture), fixturePath, process.platform === "win32" ? "junction" : "dir");
        assert.ok(lstatSync(fixturePath).isSymbolicLink(), "directory-alias decision reached");
        assert.equal(realpathSync.native(fixturePath), realpathSync.native(fixture), "alias resolves to the same fixture");
      }
      // Node resolves the entry point through realpath, but its permission
      // allowlist does not follow directory aliases (including macOS /var).
      // The production argument builder must canonicalize the original alias.
      const directory = realpathSync.native(fixturePath);
      const entry = join(fixturePath, "brain.mjs");
      const guardSource = readFileSync(join(ROOT, "machine-prep/installers/smoke/version-guard.mjs"));
      const guardDirectory = join(root, fixtureKind === "URL-reserved characters" ? "guard # 100%" : "guard");
      mkdirSync(guardDirectory);
      const guard = join(guardDirectory, "version-guard.mjs");
      writeFileSync(guard, guardSource);
      assert.deepEqual(readFileSync(guard), guardSource, "exercise the unchanged production preload bytes");
      const execute = (source) => {
        writeFileSync(entry, source);
        return spawnSync(process.execPath, versionGuardArgs({ prefix: fixturePath, entrypoint: entry, guard }), {
          cwd: directory, encoding: "utf8", timeout: 15_000,
          env: { HOME: directory, USERPROFILE: directory, BRAIN_NO_WRANGLER_LOGIN: "1" },
        });
      };
      const control = execute("console.log('VERSION_DECISION_REACHED=1'); console.log('0.4.9');\n");
      assert.equal(control.status, 0, control.stderr);
      assert.match(control.stdout, /VERSION_DECISION_REACHED=1\n0\.4\.9/);
      const network = execute("console.log('VERSION_DECISION_REACHED=1'); await fetch('https://example.invalid');\n");
      assert.notEqual(network.status, 0);
      assert.match(network.stdout, /VERSION_DECISION_REACHED=1/);
      assert.match(network.stderr, /BOOTSTRAP_VERSION_NETWORK_REFUSED=1/);
      const child = execute("import { spawnSync } from 'node:child_process'; console.log('VERSION_DECISION_REACHED=1'); spawnSync(process.execPath, ['--eval', 'console.log(\"CHILD_EXECUTED=1\")'], { stdio: 'inherit' });\n");
      assert.notEqual(child.status, 0);
      assert.match(child.stdout, /VERSION_DECISION_REACHED=1/);
      assert.match(child.stderr, /ERR_ACCESS_DENIED/);
      assert.match(child.stderr, /ChildProcess/);
      assert.doesNotMatch(child.stdout, /CHILD_EXECUTED=1/);
      const outside = join(realpathSync.native(root), "outside.txt");
      writeFileSync(outside, "synthetic unreadable sibling\n");
      const readOutside = execute(`import { readFileSync } from 'node:fs'; console.log('VERSION_DECISION_REACHED=1'); readFileSync(${JSON.stringify(outside)});\n`);
      assert.notEqual(readOutside.status, 0);
      assert.match(readOutside.stdout, /VERSION_DECISION_REACHED=1/);
      assert.match(readOutside.stderr, /ERR_ACCESS_DENIED/);
      assert.match(readOutside.stderr, /FileSystemRead/);
      const writeInside = execute(`import { writeFileSync } from 'node:fs'; console.log('VERSION_DECISION_REACHED=1'); writeFileSync(${JSON.stringify(entry)}, 'unexpected write');\n`);
      assert.notEqual(writeInside.status, 0);
      assert.match(writeInside.stdout, /VERSION_DECISION_REACHED=1/);
      assert.match(writeInside.stderr, /ERR_ACCESS_DENIED/);
      assert.match(writeInside.stderr, /FileSystemWrite/);
      assert.match(readFileSync(entry, "utf8"), /VERSION_DECISION_REACHED=1/, "read permission never grants writes");
    } finally { rmSync(root, { recursive: true }); }
  });
}

test("bootstrap failure retains native removal and cannot pass the shell lifecycle", async () => {
  const { runSmoke } = await import("../machine-prep/installers/smoke/contract.mjs");
  for (const fail of [false, true]) {
    const calls = [], events = [];
    const phases = ["verifyHash", "verifySignature", "inspectPayload", "assertClean", "install", "verifyInstalled", "bootstrap", "uninstall", "verifyRemoved"];
    const host = Object.fromEntries(phases.map((phase) => [phase, () => {
      calls.push(phase);
      if (fail && phase === "bootstrap") throw new Error("synthetic bootstrap failed");
    }]));
    if (fail) await assert.rejects(runSmoke(host, (event) => events.push(event)), /bootstrap failed/);
    else await runSmoke(host, (event) => events.push(event));
    assert.deepEqual(calls, phases, "bootstrap and native removal both reached");
    assert.equal(events.includes("INSTALLER_SHELL_SMOKE_PASSED=1"), !fail);
  }
});

test("bootstrap uses installed production preparation, guarded version, and same-user limited Windows token", () => {
  const bootstrap = read("machine-prep/installers/smoke/bootstrap.mjs");
  assert.match(bootstrap, /verifyPreparationPins\(readFileSync\(prep/);
  assert.match(bootstrap, /\[prep, "--prepare-cli"\]/);
  assert.match(bootstrap, /verifyKit\(bytes\)/);
  assert.match(bootstrap, /verifyPackageTree\(join\(scratch, "package"\), installed\)/);
  assert.match(bootstrap, /versionGuardArgs\(\{ prefix, entrypoint: join\(installed, "brain\.mjs"\) \}\)/);
  assert.match(bootstrap, /"--permission"/);
  assert.doesNotMatch(bootstrap, /MACHINE_PREP_TEST|--test-install-brain|\.\.\.process\.env/);
  const limited = read("machine-prep/installers/smoke/windows-limited.ps1");
  assert.match(limited, /-UserId \$context\.sid -LogonType S4U -RunLevel Limited/);
  assert.match(limited, /\$identity\.User\.Value -cne \$context\.sid/);
  assert.match(limited, /IsInRole\(\[Security\.Principal\.WindowsBuiltInRole\]::Administrator\)/);
  assert.match(limited, /Unregister-ScheduledTask -TaskName \$taskName/);
  assert.match(limited, /SAME_USER_LIMITED_TOKEN_VERIFIED=1/);
  assert.doesNotMatch(limited, /-Password|-Credential|New-LocalUser|MACHINE_PREP_TEST/);
});

function assertSignedSmokeJobs(workflow) {
  for (const platform of ["macos", "windows"]) {
    const marker = `\n  ${platform}-smoke:\n`;
    assert.equal(workflow.includes(marker), true, `${platform} signed smoke job is absent`);
    const job = workflow.split(marker)[1].split(/\n  [a-z][a-z-]+:\n/)[0];
    assert.match(job, new RegExp(`needs: \\[authorization, ${platform}-sign\\]`));
    assert.match(job, /needs\.authorization\.outputs\.authorized == 'true'/);
    assert.match(job, new RegExp(`needs\\.${platform}-sign\\.result == 'success'`));
    assert.match(job, new RegExp(`runs-on: ${platform}-latest`));
    assert.match(job, /permissions:\n      contents: read/);
    assert.match(job, /download-artifact@[0-9a-f]{40}/);
    assert.match(job, /artifact-ids: \$\{\{ needs\.[a-z]+-sign\.outputs\.artifact_id \}\}/);
    assert.match(job, /machine-prep\/installers\/smoke\/run\.mjs/);
    assert.match(job, /if: always\(\)/);
    assert.match(job, /upload-artifact@[0-9a-f]{40}/);
    assert.doesNotMatch(job, /environment:|secrets\.|id-token:|sudo|--real|brain setup|run-id:|github-token:/);
  }
}

test("signed smoke jobs consume only successful same-run signed artifacts without signing authority", () => {
  const workflow = read(".github/workflows/installer-signing.yml");
  assertSignedSmokeJobs(workflow);
  for (const from of [
    "needs.macos-sign.result == 'success'", "needs.windows-sign.result == 'success'",
    "artifact-ids: ${{ needs.macos-sign.outputs.artifact_id }}",
  ]) {
    assert.equal(workflow.includes(from), true, "workflow mutation decision reached");
    const mutant = workflow.replace(from, "removed-contract");
    assert.notEqual(mutant, workflow);
    assert.throws(() => assertSignedSmokeJobs(mutant));
  }
});

test("signed smoke lifecycle refuses each failed decision and cleans an attempted install", async () => {
  const { runSmoke } = await import("../machine-prep/installers/smoke/contract.mjs");
  const phases = ["verifyHash", "verifySignature", "inspectPayload", "assertClean", "install", "verifyInstalled", "uninstall", "verifyRemoved"];
  const run = async (failure) => {
    const calls = [];
    const events = [];
    const host = Object.fromEntries(phases.map((phase) => [phase, async () => {
      calls.push(phase);
      if (failure === phase) throw new Error(`synthetic ${phase} refusal`);
    }]));
    let error;
    try { await runSmoke(host, (event) => events.push(event)); } catch (caught) { error = caught; }
    return { calls, events, error };
  };
  const control = await run();
  assert.equal(control.error, undefined);
  assert.deepEqual(control.calls, phases);
  assert.equal(control.events.at(-1), "INSTALLER_SHELL_SMOKE_PASSED=1");
  assert.ok(control.events.includes("BUNDLED_CLI_VERSION_VERIFIED=0 reason=not_bundled"));
  for (const failure of phases) {
    const refused = await run(failure);
    assert.match(refused.error.message, /synthetic/);
    assert.ok(refused.calls.includes(failure), "refused decision was reached");
    assert.ok(refused.events.includes(`DECISION_REACHED=${failure}`));
    assert.ok(!refused.events.includes("INSTALLER_SHELL_SMOKE_PASSED=1"));
    if (phases.indexOf(failure) < phases.indexOf("install")) {
      assert.ok(!refused.calls.includes("install"));
      assert.ok(!refused.calls.includes("uninstall"));
    } else {
      assert.ok(refused.calls.includes("uninstall"));
    }
  }
});

test("signed smoke checksum and exact inventory guards reject tampering with a green control", async () => {
  const { verifyHashRecord, assertExactPaths, assertHostedRunner } = await import("../machine-prep/installers/smoke/contract.mjs");
  const { createHash } = await import("node:crypto");
  const bytes = Buffer.from("synthetic signed payload");
  const file = "FinancialBrainInstaller.pkg";
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.doesNotThrow(() => verifyHashRecord(bytes, `${digest}  dist/${file}\n`, file));
  for (const record of [`${"0".repeat(64)}  ${file}`, `${digest}  ../${file}`, `${digest}  other.pkg`, `${digest}  ${file}\n${digest}  ${file}`]) {
    assert.throws(() => verifyHashRecord(bytes, record, file), /checksum/);
  }
  assertExactPaths(["handoff/note.txt", "launcher"], ["launcher", "handoff/note.txt"]);
  for (const actual of [["launcher"], ["launcher", "../escape"], ["launcher", "launcher"]]) {
    assert.throws(() => assertExactPaths(actual, ["launcher", "handoff/note.txt"]), /inventory/);
  }
  assertHostedRunner({ GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" });
  for (const environment of [{}, { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" }]) {
    assert.throws(() => assertHostedRunner(environment), /hosted runner/);
  }
});

test("signed smoke native entry refuses a local machine before creating logs", async () => {
  const { assertHostedRunner } = await import("../machine-prep/installers/smoke/contract.mjs");
  assert.doesNotThrow(() => assertHostedRunner({ GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" }));
  const result = spawnSync(process.execPath, [join(ROOT, "machine-prep/installers/smoke/run.mjs")], {
    env: { BRAIN_NO_WRANGLER_LOGIN: "1", HOME: process.env.HOME }, encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /installation requires a disposable GitHub-hosted runner/);
  assert.doesNotMatch(result.stderr, /invalid smoke arguments|mkdir/);
});

test("signed smoke native adapters retain signature, user scope, footprint, and uninstall checks", () => {
  const mac = read("machine-prep/installers/smoke/run.mjs");
  const windows = read("machine-prep/installers/smoke/windows.ps1");
  assert.match(mac, /"--check-signature", artifact/);
  assert.match(mac, /"--assess", "--type", "install"/);
  assert.match(mac, /"stapler", "validate"/);
  assert.match(mac, /"-target", "CurrentUserHomeDirectory"/);
  assert.match(mac, /"--volume", home/);
  assert.match(mac, /"--forget", identifier/);
  // A fresh home holds no receipts and pkgutil then exits 1 with no output;
  // only that exact case may read as "no receipts", every other failure stops.
  assert.match(mac, /"receipt-list", "\/usr\/sbin\/pkgutil", \[\.\.\.receiptArgs, "--pkgs"\], \[0\], \{ emptyStatusOne: true \}/);
  assert.match(mac, /emptyStatusOne && !result\.error && result\.status === 1 &&\s+!String\(result\.stdout \|\| ""\)\.trim\(\) && !String\(result\.stderr \|\| ""\)\.trim\(\)/);
  assert.equal([...mac.matchAll(/emptyStatusOne: true/g)].length, 1, "only the receipt listing tolerates an empty status 1");
  assert.match(mac, /digest\(join\(installed, file\)\) !== digest\(join\(payload, file\)\)/);
  assert.match(mac, /BRAIN_NO_WRANGLER_LOGIN = "1"/);
  assert.doesNotMatch(mac, /\.\.\.process\.env/);
  // Undiscarded Windows Installer COM results become extra pipeline rows.
  const windowsSmoke = read("machine-prep/installers/smoke/windows.ps1");
  assert.match(windowsSmoke, /^\s*\$null = \$view\.Execute\(\)\r?$/m);
  assert.match(windowsSmoke, /\$null = \$view\.Close\(\)/);
  assert.doesNotMatch(windowsSmoke, /^\s*\$view\.(?:Execute|Close)\(\)\s*$/m);
  // Installer.Products is unreachable from PowerShell; registration is read per product.
  assert.doesNotMatch(windowsSmoke, /\$script:Installer\.Products\b/);
  // The build-number gate adds AppSearch and RegLocator; the smoke admits
  // exactly that one read-only HKLM 64-bit raw lookup and nothing else.
  assert.match(windowsSmoke, /'_Validation', 'AppSearch', 'RegLocator', 'Signature',/);
  // MSI stores the launcher working directory as [INSTALLFOLDER], with a trailing separator.
  assert.match(windowsSmoke, /\$shortcut\.WorkingDirectory\.TrimEnd\('\\'\) -ine \$InstallRoot/);
  assert.match(windowsSmoke, /Read-Rows 'Signature' @\('Signature'\)\)\.Count -ne 0\) \{ throw 'Unexpected MSI file search' \}/);
  assert.match(windowsSmoke, /\$searches\.Count -ne 1 -or \$searches\[0\]\.Property -cne 'WINDOWSBUILDNUMBER'/);
  assert.match(windowsSmoke, /\$locators\[0\]\.Root -cne '2'/);
  assert.match(windowsSmoke, /\$locators\[0\]\.Type -cne '18'/);
  assert.match(windowsSmoke, /ProductState\(\$product\) -ne -1\) \{ throw 'MSI is already registered' \}/);
  const assertWindows = (source) => {
    assert.match(source, /Get-AuthenticodeSignature -LiteralPath \$Artifact/);
    assert.match(source, /\$signature\.Status -ne 'Valid'/);
    assert.match(source, /TimeStamperCertificate/);
    assert.match(source, /O=Financial Brain LLC/);
    assert.match(source, /\$table -notin \$allowedTables/);
    assert.match(source, /'MsiFileHash'/);
    assert.match(source, /Installer\.FileHash/);
    assert.match(source, /'\/qn', '\/norestart', '\/L\*v'/);
    assert.match(source, /Invoke-Msi '\/i'/);
    assert.match(source, /Invoke-Msi '\/x'/);
    assert.match(source, /ProductState\(\$state\.product\) -ne -1/);
  };
  assertWindows(windows);
  const from = "$signature.Status -ne 'Valid'";
  assert.ok(windows.includes(from), "native signature decision reached");
  const mutant = windows.replace(from, "$false");
  assert.notEqual(mutant, windows);
  assert.throws(() => assertWindows(mutant));
  const packageFiles = JSON.parse(read("package.json")).files;
  assert.ok(!packageFiles.some((file) => file.startsWith("machine-prep")));
  assert.match(read("scripts/run-test-chain.mjs"), /node --test test\/machine-prep-installers\.test\.mjs/);
});

test("bash behavior platform guard keeps macOS and Linux coverage active", () => {
  assert.deepEqual(bashBehaviorOptions("darwin"), { skip: false });
  assert.deepEqual(bashBehaviorOptions("linux"), { skip: false });
  assert.deepEqual(bashBehaviorOptions("win32"), { skip: BASH_BEHAVIOR_ON_WINDOWS_SKIP_REASON });
});

test("Claude handoff messages are local notes with no remote instructions", () => {
  const mac = read("machine-prep/handoff/message-macos.txt");
  const windows = read("machine-prep/handoff/message-windows.txt");
  assert.match(mac, /^The Financial Brain installer installed the verified CLI and opened setup/);
  assert.match(windows, /^The Financial Brain installer installed the verified CLI and opened setup/);
  for (const message of [mac, windows]) {
    assert.match(message, /Want me to do this for you\?/);
    assert.match(message, /Wait for my answer before taking that step\./);
    assert.match(message, /Never ask me to paste a command\./);
    assert.doesNotMatch(message, /https?:\/\/|curl|Invoke-WebRequest|download/i);
  }
});

test("both prep scripts pin, verify, and locally install the published 0.4.9 kit", () => {
  for (const source of [read("machine-prep/prep-mac.sh"), read("machine-prep/prep-windows.ps1")]) {
    assert.match(source, new RegExp(KIT_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(source, new RegExp(KIT_SHA256));
    assert.match(source, new RegExp(KIT_SIZE));
    assert.match(source, /CHECKSUM_DECISION_REACHED/);
    assert.match(source, /PREFIX_DECISION_REACHED/);
    assert.match(source, /--ignore-scripts/);
    assert.match(source, /--no-audit/);
    assert.match(source, /--no-fund/);
    assert.doesNotMatch(source, /npm(?:\.cmd)?[^\n]*install[^\n]*https:\/\//,
      "npm installs only the already verified local archive");
  }
});

test("handoff URL renderer produces the documented Claude Desktop Code deep link", () => {
  const renderer = join(HANDOFF, "render-url.mjs");
  const prompt = join(HANDOFF, "message-macos.txt");
  const result = spawnSync(process.execPath, [renderer, prompt], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /^claude:\/\/code\/new\?q=/);
  const decoded = decodeURIComponent(result.stdout.trim().split("?q=")[1]);
  assert.equal(`${decoded}\n`, readFileSync(prompt, "utf8").replaceAll("\r\n", "\n"));
});

test("both OS handoff launchers expose a no-side-effect decision probe and CLI fallback", () => {
  const mac = read("machine-prep/handoff/handoff-mac.sh");
  const windows = read("machine-prep/handoff/handoff-windows.ps1");
  for (const source of [mac, windows]) {
    assert.match(source, /HANDOFF_DECISION_REACHED=1/);
    assert.match(source, /claude:\/\/code\/new/);
    assert.match(source, /HANDOFF_FALLBACK_CLI/);
  }
});

test("macOS installer refuses an unsupported release after reaching its OS gate", bashBehaviorOptions(), () => {
  const preinstall = join(MAC_INSTALLER, "scripts", "preinstall");
  const home = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-preinstall-home-")));
  const environment = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    BRAIN_NO_WRANGLER_LOGIN: "1",
    BRAIN_TEST_LAUNCHCTL: join(home, "injected-launchctl"),
    MACHINE_PREP_INSTALLER_TEST_MODE: "1",
  };
  try {
    const result = spawnSync("bash", [preinstall], {
      cwd: ROOT,
      env: { ...environment, MACHINE_PREP_OS_VERSION_OVERRIDE: "12.6.9" },
      encoding: "utf8",
    });
    const out = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 2, out);
    assert.match(out, /OS_DECISION_REACHED=1/);
    assert.match(out, /REFUSED macOS 13\.5 or newer is required/);
    assert.doesNotMatch(out, /PREP_STARTED/);

    const control = spawnSync("bash", [preinstall], {
      cwd: ROOT,
      env: { ...environment, MACHINE_PREP_OS_VERSION_OVERRIDE: "13.5" },
      encoding: "utf8",
    });
    assert.equal(control.status, 0, `${control.stdout}${control.stderr}`);
    assert.match(control.stdout, /OS_DECISION_REACHED=1/);
    assert.match(control.stdout, /OS_SUPPORTED=1/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("macOS staging contains the real prep, handoff, support log wrapper, and uninstall notes", bashBehaviorOptions(), () => {
  const staging = realpathSync.native(mkdtempSync(join(tmpdir(), "machine-prep-pkg-stage-")));
  try {
    const build = spawnSync("bash", [join(MAC_INSTALLER, "build-pkg.sh"), "--staging-only", staging], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);
    const installed = join(staging, "payload", "Applications", "Financial Brain Machine Prep");
    const expected = [
      "prep-mac.sh",
      "Run Financial Brain Machine Prep.command",
      "handoff/handoff-mac.sh",
      "handoff/handoff-macos.url",
      "handoff/message-macos.txt",
      "start-brain-setup.command",
      "UNINSTALL.md",
    ];
    for (const relativePath of expected) {
      assert.equal(existsSync(join(installed, relativePath)), true, `missing ${relativePath}`);
    }
    assert.notEqual(statSync(join(installed, "prep-mac.sh")).mode & 0o111, 0);
    const wrapper = readFileSync(join(installed, "Run Financial Brain Machine Prep.command"), "utf8");
    assert.match(wrapper, /"\$PREP_RUNNER" --real/);
    assert.match(wrapper, /installer\.log/);
    assert.match(wrapper, /handoff-mac\.sh/);
    assert.match(wrapper, /start-brain-setup\.command/);
    assert.match(wrapper, /SETUP_LAUNCH_DECISION_REACHED=1/);
    assert.match(wrapper, /LOG_SCHEMA_DECISION_REACHED=1/);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test("macOS package has no privileged script phase and targets only the current user", () => {
  const build = read("machine-prep/installers/macos/build-pkg.sh");
  const distribution = read("machine-prep/installers/macos/Distribution.xml");
  assert.doesNotMatch(build, /--scripts|scripts\/postinstall/);
  assert.match(distribution, /enable_currentUserHome="true"/);
  assert.match(distribution, /enable_localSystem="false"/);
  assert.match(distribution, /require-scripts="false"/);
});

test("macOS native tools build the reviewed unsigned package contents", { skip: process.platform !== "darwin" }, () => {
  const output = realpathSync.native(mkdtempSync(join(tmpdir(), "machine-prep-pkg-build-")));
  try {
    const pkg = join(output, "FinancialBrainMachinePrep-unsigned.pkg");
    const build = spawnSync("bash", [join(MAC_INSTALLER, "build-pkg.sh"), pkg], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);
    const contents = spawnSync("pkgutil", ["--payload-files", pkg], { encoding: "utf8" });
    assert.equal(contents.status, 0, `${contents.stdout}${contents.stderr}`);
    assert.match(contents.stdout, /Financial Brain Machine Prep\/prep-mac\.sh/);
    // PackageKit can serialize protected host provenance xattrs as AppleDouble
    // entries. Ignore those metadata carriers and pin every functional path.
    const functionalPaths = contents.stdout.trim().split("\n")
      .filter((path) => !path.split("/").some((part) => part.startsWith("._")))
      .sort();
    assert.deepEqual(functionalPaths, [
      ".",
      "./Applications",
      "./Applications/Financial Brain Machine Prep",
      "./Applications/Financial Brain Machine Prep/UNINSTALL.md",
      "./Applications/Financial Brain Machine Prep/handoff",
      "./Applications/Financial Brain Machine Prep/handoff/continue-in-claude.command",
      "./Applications/Financial Brain Machine Prep/handoff/handoff-mac.sh",
      "./Applications/Financial Brain Machine Prep/handoff/handoff-macos.url",
      "./Applications/Financial Brain Machine Prep/handoff/message-macos.txt",
      "./Applications/Financial Brain Machine Prep/prep-mac.sh",
      "./Applications/Financial Brain Machine Prep/Run Financial Brain Machine Prep.command",
      "./Applications/Financial Brain Machine Prep/start-brain-setup.command",
    ].sort());
    const signature = spawnSync("pkgutil", ["--check-signature", pkg], { encoding: "utf8" });
    assert.equal(signature.status, 1, `${signature.stdout}${signature.stderr}`);
    assert.match(signature.stdout, /Status: no signature/);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("Windows MSI is per-user, Windows 10+, and uses process-only policy bypass", () => {
  const project = read("machine-prep/installers/windows/FinancialBrainMachinePrep.wixproj");
  const wix = read("machine-prep/installers/windows/Package.wxs");
  assert.match(project, /WixToolset\.Sdk\/7\.0\.0/);
  assert.match(wix, /Scope="perUser"/);
  assert.match(wix, /LocalAppDataFolder/);
  assert.match(wix, /<Shortcut/);
  assert.doesNotMatch(wix, /<CustomAction|InstallExecuteSequence/);
  assert.doesNotMatch(wix, /ProgramFiles64Folder|UAC prompt/);
  // Windows Installer reports VersionNT64 = 603 on Windows 10/11; the gate
  // must use the registry build number (10240 = first Windows 10 build).
  assert.doesNotMatch(wix, /VersionNT64 &gt;= 1000/);
  assert.match(wix, /Condition="Installed OR \(VersionNT64 AND WINDOWSBUILDNUMBER &gt;= 10240\)"/);
  assert.match(wix, /Key="SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"\s+Name="CurrentBuildNumber"\s+Type="raw"\s+Bitness="always64"/);
  assert.match(wix, /macOS 13\.5 and Windows 10 are the supported minimums|Windows 10 or newer is required/);
  assert.match(wix, /ExecutionPolicy Bypass/);
  assert.match(wix, /ProgramMenuFolder/);
  assert.match(wix, /<Shortcut/);
  assert.doesNotMatch(wix, /<CustomAction|InstallExecuteSequence/);
  assert.match(wix, /prep-windows\.ps1/);
  assert.match(wix, /run-machine-prep\.ps1/);
  assert.match(wix, /message-windows\.txt/);
  assert.match(wix, /handoff-windows\.url/);
  assert.doesNotMatch(wix, /Set-ExecutionPolicy|MSIX/);
});

test("Windows wrapper has an unsupported-OS decision gate, shareable log, real prep, and Claude handoff", () => {
  const wrapper = read("machine-prep/installers/windows/run-machine-prep.ps1");
  assert.match(wrapper, /OS_DECISION_REACHED=1/);
  assert.match(wrapper, /This PC needs Windows 10 or newer/);
  assert.match(wrapper, /prep-windows\.ps1/);
  assert.match(wrapper, /Invoke-EmbeddedPowerShell \$prep @\("--real"\)/);
  assert.match(wrapper, /installer\.log/);
  assert.match(wrapper, /handoff-windows\.ps1/);
  assert.match(wrapper, /start-brain-setup\.ps1/);
  assert.match(wrapper, /SETUP_LAUNCH_DECISION_REACHED=1/);
  assert.doesNotMatch(wrapper, /Set-ExecutionPolicy/);
});

test("Windows pinned download and child processes use PowerShell 5.1-compatible bounded primitives", () => {
  const prep = read("machine-prep/prep-windows.ps1");
  const wrapper = read("machine-prep/installers/windows/run-machine-prep.ps1");
  const assertPrimitives = ({ prepSource, wrapperSource }) => {
    assert.match(prepSource, /\[IO\.File\]::Open\(\$Destination, \[IO\.FileMode\]::CreateNew, \[IO\.FileAccess\]::Write, \[IO\.FileShare\]::None\)/);
    assert.doesNotMatch(prepSource, /\[IO\.File\]::OpenNew/);
    for (const source of [prepSource, wrapperSource]) {
      assert.match(source, /StandardOutput\.ReadToEndAsync\(\)/);
      assert.match(source, /StandardError\.ReadToEndAsync\(\)/);
      assert.match(source, /\[Threading\.Tasks\.Task\]::WaitAll/);
    }
  };
  assert.doesNotThrow(() => assertPrimitives({ prepSource: prep, wrapperSource: wrapper }));
  const mutants = [
    { prepSource: prep.replace("[IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)", "[IO.File]::OpenNew($Destination)"), wrapperSource: wrapper },
    { prepSource: prep.replace("StandardOutput.ReadToEndAsync()", "StandardOutput.ReadToEnd()"), wrapperSource: wrapper },
    { prepSource: prep, wrapperSource: wrapper.replace("StandardError.ReadToEndAsync()", "StandardError.ReadToEnd()") },
  ];
  for (const mutant of mutants) assert.throws(() => assertPrimitives(mutant));
});

function assertNoReservedPowerShellLocals(source) {
  assert.doesNotMatch(source, /\$input\b/i, "PowerShell's automatic input variable must never be shadowed or consumed as an ordinary stream");
  const reserved = "args|this|_|psitem|error|host|matches|pid|home|profile";
  assert.doesNotMatch(source, new RegExp(`^\\s*function\\b[^\\n]*\\([^\\n]*\\$(?:${reserved})\\b`, "im"));
  assert.doesNotMatch(source, new RegExp(`^\\s*\\$(?:${reserved})\\s*=`, "im"));
}

test("Windows prep does not shadow PowerShell automatic variables", () => {
  const prep = read("machine-prep/prep-windows.ps1");
  assert.doesNotThrow(() => assertNoReservedPowerShellLocals(prep));
  const mutant = prep.replaceAll("$SourceStream", "$Input");
  assert.throws(() => assertNoReservedPowerShellLocals(mutant));
});

test("visible setup launchers use the installed CLI and the standard fresh manifest path", () => {
  const mac = read("machine-prep/installers/macos/start-brain-setup.command");
  assert.match(mac, /\.financial-brain\/bin\/brain/);
  assert.match(mac, /Financial Brain\/brain\.manifest\.json/);
  assert.match(mac, /"\$BRAIN" setup "\$MANIFEST"/);

  const windows = read("machine-prep/installers/windows/start-brain-setup.ps1");
  assert.match(windows, /FinancialBrain\\brain\.cmd/);
  assert.match(windows, /Financial Brain\\brain\.manifest\.json/);
  assert.match(windows, /& \$brain setup \$manifest/);
});

test("Windows package project names every reviewed payload file", () => {
  const expected = [
    "FinancialBrainMachinePrep.wixproj",
    "Package.wxs",
    "run-machine-prep.ps1",
    "start-brain-setup.ps1",
    "verify-msi.ps1",
    "UNINSTALL.txt",
  ];
  for (const name of expected) {
    assert.equal(existsSync(join(WINDOWS_INSTALLER, name)), true, `missing ${name}`);
  }
  const verifier = read("machine-prep/installers/windows/verify-msi.ps1");
  assert.match(verifier, /LocalAppDataFolder/);
  assert.match(verifier, /MSI_SCOPE_VERIFIED=per_user/);
  assert.match(verifier, /MSI_VISIBLE_LAUNCHER_VERIFIED=1/);
  // Undiscarded COM results become blank rows and broke the exact file count.
  assert.match(verifier, /^\s*\$null = \$view\.Execute\(\)\r?$/m);
  assert.match(verifier, /^\s*\$null = \$view\.Close\(\)\r?$/m);
  assert.doesNotMatch(verifier, /^\s*\$view\.(?:Execute|Close)\(\)\s*$/m);
});

test("Windows wrapper refuses an unsupported release before prep", { skip: process.platform !== "win32" }, () => {
  const directory = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-windows-os-")));
  try {
    const powerShell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const result = spawnSync(powerShell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", join(WINDOWS_INSTALLER, "run-machine-prep.ps1"),
    ], {
      cwd: ROOT,
      env: {
        SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
        HOME: directory, USERPROFILE: directory, LOCALAPPDATA: join(directory, "local"),
        BRAIN_NO_WRANGLER_LOGIN: "1", BRAIN_TEST_LAUNCHCTL: join(directory, "injected-launchctl"),
        MACHINE_PREP_OS_VERSION_OVERRIDE: "6.3", MACHINE_PREP_INSTALLER_TEST_MODE: "1",
      },
      encoding: "utf8",
    });
    const out = `${result.stdout}${result.stderr}`.replaceAll("\r\n", "\n");
    const log = readFileSync(join(directory, "local", "FinancialBrainMachinePrep", "installer.log"), "utf8");
    assert.equal(result.status, 2, out);
    assert.match(log, /OS_DECISION_REACHED=1/);
    assert.match(out, /This PC needs Windows 10 or newer/);
    assert.doesNotMatch(out, /OS_DECISION_REACHED|INSTALLER_TEST_GATE_REACHED|INSTALLER_PROGRESS/);
    assert.doesNotMatch(log, /PREP_EXIT_CODE|SETUP_LAUNCH_DECISION/);
    // The supported-OS green control reaches setup in the wrapper matrix below.
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("machine-prep CI still builds review artifacts with pinned actions and no release path", () => {
  const workflow = read(".github/workflows/machine-prep-installers.yml");
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.match(workflow, /wix_osmf_confirmed:/);
  assert.match(workflow, /if: inputs\.wix_osmf_confirmed/);
  assert.match(workflow, /runs-on: macos-latest/);
  assert.match(workflow, /runs-on: windows-latest/);
  assert.match(workflow, /FinancialBrainMachinePrep-unsigned\.pkg/);
  assert.match(workflow, /FinancialBrainMachinePrep-unsigned\.msi/);
  assert.equal([...workflow.matchAll(/actions\/upload-artifact@[0-9a-f]{40}/g)].length, 2);
  for (const match of workflow.matchAll(/^\s+(?:-\s+)?uses: ([^\s#]+)/gm)) {
    if (match[1].startsWith("./")) continue;
    assert.match(match[1], /@[0-9a-f]{40}$/);
  }
  assert.doesNotMatch(workflow, /gh release|release:|contents:\s*write|id-token:\s*write|notarytool|signtool/i);
});

const WINDOWS_SIGNING_VARIABLES = [
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_SUBSCRIPTION_ID",
  "ARTIFACT_SIGNING_ENDPOINT",
  "ARTIFACT_SIGNING_ACCOUNT",
  "ARTIFACT_SIGNING_PROFILE",
];

const MAC_SIGNING_SECRETS = [
  "APPLE_DEVELOPER_ID_APPLICATION_P12_BASE64",
  "APPLE_DEVELOPER_ID_APPLICATION_P12_PASSWORD",
  "APPLE_DEVELOPER_ID_INSTALLER_P12_BASE64",
  "APPLE_DEVELOPER_ID_INSTALLER_P12_PASSWORD",
  "APPLE_NOTARY_KEY_ID",
  "APPLE_NOTARY_ISSUER_ID",
  "APPLE_NOTARY_KEY_P8_BASE64",
];

const MAC_SIGNING_GATE_SETTINGS = [
  "APP_P12",
  "APP_PASSWORD",
  "INSTALLER_P12",
  "INSTALLER_PASSWORD",
  "NOTARY_KEY_ID",
  "NOTARY_ISSUER_ID",
  "NOTARY_P8",
  "APPLE_TEAM_ID",
];

function signingGateBody(workflow) {
  const gate = workflow.indexOf("        id: gate\n");
  assert.notEqual(gate, -1, "missing signing gate step");
  const bodyStartMarker = "        run: |\n";
  const bodyStart = workflow.indexOf(bodyStartMarker, gate);
  assert.notEqual(bodyStart, -1, "missing signing gate body");
  const bodyEnd = workflow.indexOf("\n  macos-sign:", bodyStart);
  assert.notEqual(bodyEnd, -1, "missing signing gate body terminator");
  return workflow.slice(bodyStart + bodyStartMarker.length, bodyEnd)
    .split("\n")
    .map((line) => line === "" ? "" : line.slice(10))
    .join("\n");
}

function runSigningGate({ workflow = read(".github/workflows/installer-signing.yml"), missing = null, wixConfirmed = "true" } = {}) {
  const directory = realpathSync.native(mkdtempSync(join(ROOT, ".signing-gate-test-")));
  const output = join(directory, "output");
  const summary = join(directory, "summary");
  const settings = [...MAC_SIGNING_GATE_SETTINGS, ...WINDOWS_SIGNING_VARIABLES];
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: directory,
    BRAIN_NO_WRANGLER_LOGIN: "1",
    BRAIN_TEST_LAUNCHCTL: join(directory, "injected-launchctl"),
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
    WIX_OSMF_CONFIRMED: wixConfirmed,
  };
  for (const setting of settings) env[setting] = setting === missing ? "" : "synthetic-configured";
  const result = spawnSync("bash", ["-c", signingGateBody(workflow)], { cwd: ROOT, env, encoding: "utf8" });
  return {
    result,
    output: existsSync(output) ? readFileSync(output, "utf8") : "",
    summary: existsSync(summary) ? readFileSync(summary, "utf8") : "",
    cleanup() { rmSync(directory, { recursive: true, force: true }); },
  };
}

function assertSigningGate(probe, { mac, windows }) {
  assert.equal(probe.result.status, 0, `${probe.result.stdout}${probe.result.stderr}`);
  const values = Object.fromEntries(probe.output.trim().split("\n").map((line) => line.split("=")));
  assert.equal(values.macos_configured, String(mac));
  assert.equal(values.windows_configured, String(windows));
}

test("signing configuration body authorizes only complete settings and explicit WiX confirmation", bashBehaviorOptions(), () => {
  const complete = runSigningGate();
  try {
    assertSigningGate(complete, { mac: true, windows: true });
    assert.equal(complete.summary, "");
  } finally {
    complete.cleanup();
  }

  for (const missing of MAC_SIGNING_GATE_SETTINGS) {
    const probe = runSigningGate({ missing });
    try {
      assertSigningGate(probe, { mac: false, windows: true });
      assert.match(probe.summary, /Signing skipped cleanly for macOS/);
    } finally {
      probe.cleanup();
    }
  }
  for (const missing of WINDOWS_SIGNING_VARIABLES) {
    const probe = runSigningGate({ missing });
    try {
      assertSigningGate(probe, { mac: true, windows: false });
      assert.match(probe.summary, /Signing skipped cleanly for Windows/);
    } finally {
      probe.cleanup();
    }
  }

  const wixRefusal = runSigningGate({ wixConfirmed: "false" });
  try {
    assertSigningGate(wixRefusal, { mac: true, windows: false });
    assert.match(wixRefusal.summary, /wix_osmf_confirmed is absent/);
  } finally {
    wixRefusal.cleanup();
  }
});

test("signing missing-setting mutation turns the executed gate red", bashBehaviorOptions(), () => {
  const workflow = read(".github/workflows/installer-signing.yml");
  const from = '[ -n "$value" ] || mac_missing=1';
  assert.equal(workflow.includes(from), true, "missing signing configuration decision");
  const mutant = workflow.replace(from, '[ -n "$value" ] || true');
  const probe = runSigningGate({ workflow: mutant, missing: "APP_P12" });
  try {
    assert.throws(() => assertSigningGate(probe, { mac: false, windows: true }), undefined,
      "missing-setting decision mutation survived the executable gate matrix");
  } finally {
    probe.cleanup();
  }
});

function assertCleanSigningSkipContract(workflow) {
  assert.match(workflow, /macos_configured=false/);
  assert.match(workflow, /windows_configured=false/);
  assert.match(workflow, /if: needs\.configuration\.outputs\.macos_configured == 'true'/);
  assert.match(workflow, /if: needs\.configuration\.outputs\.windows_configured == 'true'/);
  assert.match(workflow, /Signing skipped cleanly/);
}

test("signing workflow skips cleanly when unsigned and detects a skip-gate mutation", () => {
  const workflow = read(".github/workflows/installer-signing.yml");
  assert.doesNotThrow(() => assertCleanSigningSkipContract(workflow));
  const mutant = workflow.replace("macos_configured=false", "macos_configured=true");
  assert.throws(() => assertCleanSigningSkipContract(mutant));
});

test("signing workflow performs the required Apple and Artifact Signing ceremonies", () => {
  const workflow = read(".github/workflows/installer-signing.yml");
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.match(workflow, /environment: artifact-signing/);
  assert.match(workflow, /wix_osmf_confirmed:/);
  assert.match(workflow, /pkgbuild/);
  assert.match(workflow, /productbuild/);
  assert.match(workflow, /codesign/);
  assert.match(workflow, /productsign/);
  assert.match(workflow, /xcrun notarytool submit[\s\S]*--wait/);
  assert.match(workflow, /xcrun stapler staple/);
  assert.match(workflow, /azure\/login@[0-9a-f]{40}/);
  assert.match(workflow, /azure\/artifact-signing-action@[0-9a-f]{40}/);
  for (const name of WINDOWS_SIGNING_VARIABLES) assert.match(workflow, new RegExp(`vars\\.${name}\\b`));
  for (const name of MAC_SIGNING_SECRETS) assert.match(workflow, new RegExp(`secrets\\.${name}\\b`));
  assert.match(workflow, /vars\.APPLE_TEAM_ID\b/);
  for (const match of workflow.matchAll(/^\s+(?:-\s+)?uses: ([^\s#]+)/gm)) {
    if (match[1].startsWith("./")) continue;
    assert.match(match[1], /@[0-9a-f]{40}$/);
  }
  assert.doesNotMatch(workflow, /contents:\s*write|gh release|releases:/i);
});

function runSigningCleanup({ owned, deleteFails = false, scriptPath = join(MAC_INSTALLER, "cleanup-signing-material.sh") }) {
  const directory = realpathSync.native(mkdtempSync(join(ROOT, ".signing-cleanup-test-")));
  const keychain = join(directory, "installer-signing.keychain-db");
  const marker = join(directory, "installer-signing.keychain-owner");
  const calls = join(directory, "security-calls.log");
  const security = join(directory, "security-fixture");
  const attempt = "synthetic-attempt-1";
  writeFileSync(keychain, "synthetic keychain\n");
  if (owned) writeFileSync(marker, `${attempt}\n`);
  for (const name of ["application.p12", "application.pem", "installer.p12", "installer.pem", "notary-key.p8"]) {
    writeFileSync(join(directory, name), "synthetic material\n");
  }
  writeFileSync(security, `#!/bin/sh
printf '%s\\n' "$1" >> "${calls}"
case "$1" in
  delete-keychain)
    ${deleteFails ? "exit 9" : "rm -f \"$2\"; exit 0"}
    ;;
  show-keychain-info) exit 7 ;;
  *) exit 8 ;;
esac
`);
  chmodSync(security, 0o755);
  const result = spawnSync("bash", [scriptPath], {
    cwd: ROOT,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: directory,
      RUNNER_TEMP: directory,
      SIGNING_KEYCHAIN: keychain,
      SIGNING_KEYCHAIN_MARKER: marker,
      SIGNING_ATTEMPT_ID: attempt,
      SIGNING_SECURITY_COMMAND: security,
      BRAIN_NO_WRANGLER_LOGIN: "1",
      BRAIN_TEST_LAUNCHCTL: join(directory, "injected-launchctl"),
    },
    encoding: "utf8",
  });
  return {
    directory,
    keychain,
    marker,
    calls,
    result,
    cleanup() { rmSync(directory, { recursive: true, force: true }); },
  };
}

test("signing cleanup deletes only its marked keychain and fails loudly when deletion is unproven", bashBehaviorOptions(), () => {
  const owned = runSigningCleanup({ owned: true });
  try {
    assert.equal(owned.result.status, 0, `${owned.result.stdout}${owned.result.stderr}`);
    assert.match(owned.result.stdout, /KEYCHAIN_CLEANUP_DECISION_REACHED=1/);
    assert.match(readFileSync(owned.calls, "utf8"), /^delete-keychain$/m);
    assert.equal(existsSync(owned.keychain), false);
    assert.equal(existsSync(owned.marker), false);
  } finally {
    owned.cleanup();
  }

  const failed = runSigningCleanup({ owned: true, deleteFails: true });
  try {
    assert.notEqual(failed.result.status, 0);
    assert.match(`${failed.result.stdout}${failed.result.stderr}`, /KEYCHAIN_CLEANUP_FAILED=1/);
    assert.equal(existsSync(failed.keychain), true);
  } finally {
    failed.cleanup();
  }

  const foreign = runSigningCleanup({ owned: false });
  try {
    assert.notEqual(foreign.result.status, 0);
    assert.match(`${foreign.result.stdout}${foreign.result.stderr}`, /KEYCHAIN_CLEANUP_STOP_UNOWNED=1/);
    assert.equal(existsSync(foreign.keychain), true);
    assert.equal(existsSync(foreign.calls), false, "foreign keychain must not reach delete");
  } finally {
    foreign.cleanup();
  }
});

test("signing cleanup ownership mutation turns the foreign-keychain control red", bashBehaviorOptions(), () => {
  const sourcePath = join(MAC_INSTALLER, "cleanup-signing-material.sh");
  const source = readFileSync(sourcePath, "utf8");
  const from = 'if [ "$marker_value" != "$attempt_id" ]; then';
  assert.equal(source.includes(from), true, "missing cleanup ownership decision");
  const directory = realpathSync.native(mkdtempSync(join(ROOT, ".signing-cleanup-mutant-")));
  const mutant = join(directory, "cleanup-signing-material.sh");
  writeFileSync(mutant, source.replace(from, "if false; then"));
  const probe = runSigningCleanup({ owned: false, scriptPath: mutant });
  try {
    assert.throws(() => {
      assert.notEqual(probe.result.status, 0);
      assert.equal(existsSync(probe.keychain), true);
      assert.equal(existsSync(probe.calls), false);
    }, undefined, "cleanup ownership mutation survived");
  } finally {
    probe.cleanup();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("installer signing guide names the exact owner ceremonies and settings", () => {
  const guide = read("docs/INSTALLERS-SIGNING.md");
  assert.match(guide, /Keychain Access/);
  assert.match(guide, /Developer ID Application/);
  assert.match(guide, /Developer ID Installer/);
  assert.match(guide, /\.p12/);
  assert.match(guide, /Team Keys/);
  assert.match(guide, /Developer role/);
  assert.match(guide, /Team ID/);
  for (const name of [...MAC_SIGNING_SECRETS, ...WINDOWS_SIGNING_VARIABLES, "APPLE_TEAM_ID"]) {
    assert.match(guide, new RegExp(`\\b${name}\\b`));
  }
  assert.match(guide, /docs\/WINDOWS-SIGNING\.md/);
});

test("signing plan names owner purchases, warning behavior, and secretless repository boundaries", () => {
  const plan = read("machine-prep/SIGNING.md");
  assert.match(plan, /2026-09-24/);
  assert.match(plan, /\$99 per year/);
  assert.match(plan, /Developer ID Installer/);
  assert.match(plan, /notarytool/);
  assert.match(plan, /\$9\.99 per month/);
  assert.match(plan, /\$99\.99 per month/);
  assert.match(plan, /OV.*\$696/s);
  assert.match(plan, /EV.*\$972/s);
  assert.match(plan, /SmartScreen/);
  assert.match(plan, /Open Source Maintenance Fee/);
  assert.match(plan, /GitHub OIDC/);
  assert.match(plan, /No signing credential belongs in the repository/);
});

function assertSecurityContracts({ macPrep, windowsPrep, distribution, buildPkg, wix, macRunner, windowsRunner, signing, signingCleanup }) {
  for (const source of [macPrep, windowsPrep]) {
    assert.doesNotMatch(source, /claude\.ai\/install|nodejs\.org\/dist|winget(?:\.Source)?\s+install|@openai\/codex@/i);
    assert.match(source, /PREREQUISITE_DECISION_REACHED/);
    assert.match(source, /OWNER ACTION/);
    assert.match(source, /REUSE_ATTEMPTED=0/);
    assert.match(source, /INSTALL_LOCK_ACQUIRED/);
    assert.match(source, /STAGED_PREFIX_VERIFIED/);
    assert.match(source, /ATOMIC_PROMOTION_VERIFIED/);
    assert.match(source, /NO_REDIRECTS/);
    assert.match(source, /NPM_ENVIRONMENT_ISOLATED/);
  }
  assert.doesNotMatch(macPrep, /grep -Fq "\$BRAIN_VERSION"/);
  assert.doesNotMatch(windowsPrep, /\.Contains\(\$BrainVersion\)/);
  assert.match(macPrep, /if ! \/bin\/mkdir "\$lock"/);
  assert.match(macPrep, /if ! owns_attempt_dir "\$owned_path"/);
  assert.match(macPrep, /renamex_np[\s\S]*renamex_np\(argv\[0\], argv\[1\], 4\)/);
  assert.match(macPrep, /\/usr\/bin\/env -i HOME=/);
  assert.match(windowsPrep, /\$handler\.AllowAutoRedirect = \$false/);
  assert.match(windowsPrep, /\[IO\.Directory\]::Move\(\$stage, \$BrainPrefix\)/);
  assert.match(windowsPrep, /Test-InstallAttemptOwnership \$Directory \$AttemptId/);
  assert.match(windowsPrep, /StandardOutput\.ReadToEndAsync\(\)/);
  assert.match(windowsPrep, /StandardError\.ReadToEndAsync\(\)/);
  assert.match(windowsPrep, /\[Console\]::Out\.WriteLine\("NPM_ENVIRONMENT_ISOLATED=1"\)/);
  assert.match(distribution, /enable_currentUserHome="true"/);
  assert.match(distribution, /enable_localSystem="false"/);
  assert.match(buildPkg, /Applications\/Financial Brain Machine Prep/);
  assert.doesNotMatch(buildPkg, /--scripts|scripts\/postinstall/);
  assert.match(wix, /Scope="perUser"/);
  assert.match(wix, /LocalAppDataFolder/);
  assert.doesNotMatch(wix, /ProgramFiles64Folder|UAC prompt/);
  assert.match(wix, /<Shortcut/);
  assert.doesNotMatch(wix, /<CustomAction|InstallExecuteSequence/);
  assert.match(macRunner, /LOG_SCHEMA_DECISION_REACHED/);
  assert.doesNotMatch(macRunner, /sanitize_log|2>&1\s*\|/);
  assert.match(macRunner, /\/usr\/bin\/env -i/);
  assert.match(macRunner, /exit "\$prep_status"/);
  assert.match(macRunner, /exit "\$setup_status"/);
  assert.match(windowsRunner, /\[IO\.File\]::AppendAllText/);
  assert.match(windowsRunner, /\.ExitCode/);
  assert.match(windowsRunner, /EnvironmentVariables\.Clear\(\)/);
  assert.match(windowsRunner, /StandardOutput\.ReadToEndAsync\(\)/);
  assert.match(windowsRunner, /StandardError\.ReadToEndAsync\(\)/);
  assert.match(windowsRunner, /\[Threading\.Tasks\.Task\]::WaitAll/);
  assert.match(windowsRunner, /exit \$prepResult\.ExitCode/);
  assert.doesNotMatch(windowsRunner, /Tee-Object|RedirectStandardOutput\s+\$stdout/);
  assert.match(signing, /github\.event_name == 'workflow_dispatch'/);
  assert.match(signing, /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  assert.match(signing, /vars\.SIGNING_REPOSITORY != ''/);
  assert.ok(signing.indexOf("SIGNING_KEYCHAIN=$keychain") < signing.indexOf("security create-keychain"));
  assert.match(signing, /trap cleanup_signing_material EXIT/);
  assert.match(signing, /if \[ "\$mac_missing" -eq 0 \]; then/);
  assert.doesNotMatch(signing, /security delete-keychain[^\n]*\|\| true/);
  assert.match(signingCleanup, /if \[ "\$marker_value" != "\$attempt_id" \]; then/);
  assert.match(signingCleanup, /"\$security_command" delete-keychain "\$keychain"/);
}

test("installer security contracts detect one mutation per reviewed boundary", () => {
  const sources = {
    macPrep: read("machine-prep/prep-mac.sh"),
    windowsPrep: read("machine-prep/prep-windows.ps1"),
    distribution: read("machine-prep/installers/macos/Distribution.xml"),
    buildPkg: read("machine-prep/installers/macos/build-pkg.sh"),
    wix: read("machine-prep/installers/windows/Package.wxs"),
    macRunner: read("machine-prep/installers/macos/run-machine-prep-mac.sh"),
    windowsRunner: read("machine-prep/installers/windows/run-machine-prep.ps1"),
    signing: read(".github/workflows/installer-signing.yml"),
    signingCleanup: read("machine-prep/installers/macos/cleanup-signing-material.sh"),
  };
  assert.doesNotThrow(() => assertSecurityContracts(sources));
  const mutations = [
    ["macPrep", 'if ! /bin/mkdir "$lock"', "if false"],
    ["macPrep", "/usr/bin/env -i HOME=", "/usr/bin/env HOME="],
    ["windowsPrep", "$handler.AllowAutoRedirect = $false", "$handler.AllowAutoRedirect = $true"],
    ["windowsPrep", ".StandardOutput.ReadToEndAsync()", ".StandardOutput.ReadToEnd()"],
    ["signing", 'if [ "$mac_missing" -eq 0 ]; then', 'if [ "$mac_missing" -ne 0 ]; then'],
    ["signingCleanup", 'if [ "$marker_value" != "$attempt_id" ]; then', "if false; then"],
    ["distribution", 'enable_localSystem="false"', 'enable_localSystem="true"'],
    ["buildPkg", "Applications/Financial Brain Machine Prep", "Library/Application Support/FinancialBrainMachinePrep"],
    ["wix", 'Scope="perUser"', 'Scope="perMachine"'],
    ["wix", "<Shortcut", "<CustomAction"],
    ["macRunner", 'exit "$setup_status"', 'exit 0 # setup failure swallowed'],
    ["windowsRunner", ".StandardError.ReadToEndAsync()", ".StandardError.ReadToEnd()"],
    ["signing", "vars.SIGNING_REPOSITORY != ''", "github.repository != ''"],
  ];
  for (const [key, from, to] of mutations) {
    const mutant = { ...sources, [key]: sources[key].replaceAll(from, to) };
    assert.throws(() => assertSecurityContracts(mutant), `mutation survived for ${key}: ${from}`);
  }
});

function runMacWrapper({ prepExit, openExit, handoffExit, prepBody = "", handoffBody = "" }) {
  const directory = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-wrapper-test-")));
  const counter = join(directory, "counter.log");
  const helper = (name, exitCode, body = "") => {
    const path = join(directory, name);
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' ${name} >> "${counter}"\n${body}\nexit ${exitCode}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const result = spawnSync("bash", [join(MAC_INSTALLER, "run-machine-prep-mac.sh")], {
    cwd: ROOT,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: directory,
      BRAIN_NO_WRANGLER_LOGIN: "1",
      BRAIN_TEST_LAUNCHCTL: join(directory, "injected-launchctl"),
      MACHINE_PREP_RUNNER: helper("prep", prepExit, prepBody),
      MACHINE_PREP_OPEN: helper("open", openExit),
      MACHINE_PREP_HANDOFF: helper("handoff", handoffExit, handoffBody),
      MACHINE_PREP_LOG_DIR: join(directory, "log"),
    },
    encoding: "utf8",
  });
  const calls = existsSync(counter) ? readFileSync(counter, "utf8").trim().split("\n").filter(Boolean) : [];
  const logFile = join(directory, "log", "installer.log");
  const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : null;
  rmSync(directory, { recursive: true, force: true });
  return { ...result, calls, log };
}

// What the owner reads in the launcher window. Status markers live only in
// installer.log; these lines never enter it.
const MAC_SCREEN = {
  start: "Financial Brain Machine Prep: checking this Mac for the tools setup needs.",
  failed: "Financial Brain setup has not started yet: follow the steps above, then open Run Financial Brain Machine Prep again.",
  ready: "This Mac is ready. Opening Financial Brain setup in a new Terminal window.",
  windowFailed: "The Financial Brain setup window did not open. Ask Financial Brain support for help.",
  handoff: "Opening Claude to guide your next steps.",
  handoffFailed: "Claude did not open. Continue in the Financial Brain setup window.",
  done: "Done. Continue in the Financial Brain setup window.",
};
const toWindowsScreen = (line) => line
  .replace("This Mac", "This PC").replace("this Mac", "this PC")
  .replace("new Terminal window", "new PowerShell window")
  .replace(/Machine Prep again\.$/, "Machine Prep again from the Start menu.");
const WINDOWS_SCREEN = Object.fromEntries(Object.entries(MAC_SCREEN).map(([key, line]) => [key, toWindowsScreen(line)]));
const SCREEN_MARKER_LINE = /^[A-Z][A-Z_]*(?:[= ]|$)/m;
const MAC_FAILURE_MARKERS = [
  "LOG_SCHEMA_DECISION_REACHED=1",
  "INSTALLER_PROGRESS=1/4 Preparing tools and Financial Brain",
  "PREP_EXIT_CODE=2",
  "INSTALLER_PROGRESS=2/4 Prep needs attention; setup was not opened",
  "SETUP_LAUNCH_DECISION_REACHED=1 skipped=prep_failed",
];
const MAC_SUCCESS_MARKERS = [
  "LOG_SCHEMA_DECISION_REACHED=1",
  "INSTALLER_PROGRESS=1/4 Preparing tools and Financial Brain",
  "PREP_EXIT_CODE=0",
  "INSTALLER_PROGRESS=2/4 Tool and CLI checks completed",
  "SETUP_LAUNCH_DECISION_REACHED=1",
  "SETUP_WINDOW_STARTED=1",
  "INSTALLER_PROGRESS=3/4 Opening the local Claude handoff",
  "INSTALLER_HANDOFF_EXIT_CODE=0",
  "INSTALLER_HANDOFF_STARTED=1",
  "INSTALLER_PROGRESS=4/4 Installer handoff completed",
];
const lines = (...items) => `${items.join("\n")}\n`;

test("Mac launcher shows only plain lines on screen and keeps every status marker in installer.log", bashBehaviorOptions(), () => {
  // The prep's own markers and banner are hidden; its stderr is untouched.
  const prepFailure = runMacWrapper({
    prepExit: 2, openExit: 0, handoffExit: 0,
    prepBody: "printf 'Machine Prep for macOS\\nMODE real\\nPREREQUISITE_DECISION_REACHED=1\\nCodex CLI (optional): not found. Setup can continue without it.\\n'\nprintf 'Financial Brain setup cannot start yet. Nothing was downloaded or installed.\\n- Node.js: not found.\\n' >&2",
  });
  assert.equal(prepFailure.status, 2, prepFailure.stderr);
  assert.equal(prepFailure.stdout, lines(MAC_SCREEN.start, "Codex CLI (optional): not found. Setup can continue without it.", "", MAC_SCREEN.failed));
  assert.equal(prepFailure.stderr, lines("Financial Brain setup cannot start yet. Nothing was downloaded or installed.", "- Node.js: not found."));
  assert.equal(prepFailure.log, lines(...MAC_FAILURE_MARKERS));

  const control = runMacWrapper({
    prepExit: 0, openExit: 0, handoffExit: 0,
    prepBody: [
      "printf 'Machine Prep for macOS\\nMODE real\\nPREREQUISITE_DECISION_REACHED=1\\nCodex CLI (optional): found, version 9.0.0.\\nDOWNLOAD_STARTED=1 kit_version=0.4.9\\nVERIFIED checksum\\n'",
      "printf 'added 1 package in 1s\\nBRAIN_INSTALL_VERIFIED=1 version=0.4.9\\nFinancial Brain CLI preparation completed\\n'",
      "printf 'npm warn example\\n' >&2",
    ].join("\n"),
    handoffBody: "printf 'HANDOFF_DECISION_REACHED=1\\nHANDOFF_DESKTOP_OPENED=1\\n'",
  });
  assert.equal(control.status, 0, control.stderr);
  assert.deepEqual(control.calls, ["prep", "open", "handoff"]);
  assert.equal(control.stdout, lines(
    MAC_SCREEN.start, "Codex CLI (optional): found, version 9.0.0.", "added 1 package in 1s", "Financial Brain CLI preparation completed",
    MAC_SCREEN.ready, MAC_SCREEN.handoff, MAC_SCREEN.done,
  ));
  assert.equal(control.stderr, "npm warn example\n");
  assert.equal(control.log, lines(...MAC_SUCCESS_MARKERS));

  const launchFailure = runMacWrapper({ prepExit: 0, openExit: 9, handoffExit: 0 });
  assert.equal(launchFailure.status, 9, launchFailure.stderr);
  assert.equal(launchFailure.stdout, lines(MAC_SCREEN.start, MAC_SCREEN.ready, MAC_SCREEN.windowFailed));
  assert.equal(launchFailure.log, lines(...MAC_SUCCESS_MARKERS.slice(0, 5), "SETUP_WINDOW_STARTED=0"));

  const handoffFailure = runMacWrapper({ prepExit: 0, openExit: 0, handoffExit: 4, handoffBody: "printf 'HANDOFF_DECISION_REACHED=1\\n'\nprintf 'REFUSED missing Claude handoff URL\\n' >&2" });
  assert.equal(handoffFailure.status, 4, handoffFailure.stderr);
  assert.equal(handoffFailure.stdout, lines(MAC_SCREEN.start, MAC_SCREEN.ready, MAC_SCREEN.handoff, MAC_SCREEN.handoffFailed));
  assert.equal(handoffFailure.stderr, "REFUSED missing Claude handoff URL\n");
  assert.equal(handoffFailure.log, lines(...MAC_SUCCESS_MARKERS.slice(0, 7), "INSTALLER_HANDOFF_EXIT_CODE=4", "INSTALLER_HANDOFF_STARTED=0"));

  for (const result of [prepFailure, control, launchFailure, handoffFailure]) {
    assert.doesNotMatch(result.stdout, SCREEN_MARKER_LINE, result.stdout);
  }
});

test("Windows launcher mirrors the Mac screen: markers only in installer.log, prep markers hidden, waits only for an interactive owner", () => {
  const wrapper = read("machine-prep/installers/windows/run-machine-prep.ps1").replaceAll("\r\n", "\n");
  const mac = read("machine-prep/installers/macos/run-machine-prep-mac.sh");
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Markers are written to installer.log only, on both platforms.
  const macEmit = mac.slice(mac.indexOf("emit_status() {"), mac.indexOf("\n}\n", mac.indexOf("emit_status() {")));
  assert.match(macEmit, /printf '%s\\n' "\$1" >> "\$LOG_FILE"/);
  assert.doesNotMatch(macEmit, /tee|\/dev\/stdout/);
  const windowsLog = wrapper.slice(wrapper.indexOf("function Write-SafeLog"), wrapper.indexOf("\n}\n", wrapper.indexOf("function Write-SafeLog")));
  assert.match(windowsLog, /\[IO\.File\]::AppendAllText\(\$LogFile, "\$Line`r`n"\)/);
  assert.doesNotMatch(windowsLog, /Console|Write-Output|Write-Host/);
  // The OS gate has the same private log boundary as other decisions.
  assert.match(wrapper, /Write-SafeLog "OS_DECISION_REACHED=1 current=\$CurrentVersion minimum=10\.0"/);

  // One hidden-line rule, case-sensitive on both platforms; stderr is never filtered.
  assert.ok(mac.includes("SCREEN_HIDDEN='^([A-Z][A-Z_]*([= ]|$)|Machine Prep for macOS$)'"));
  assert.ok(wrapper.includes("$ScreenHiddenPattern = '^([A-Z][A-Z_]*([= ]|$)|Machine Prep for Windows$)'"));
  assert.match(mac, /run_for_screen\(\) \{\n  "\$@" \| \/usr\/bin\/grep -v -E --line-buffered "\$SCREEN_HIDDEN"\n  return "\$\{PIPESTATUS\[0\]\}"\n\}/);
  // GNU sed takes -l as a line length and then ignores -E, so a sed filter hides nothing on Linux.
  assert.doesNotMatch(mac, /\/usr\/bin\/sed /);
  assert.match(mac, /run_for_screen \/usr\/bin\/env -i HOME=/);
  assert.match(mac, /run_for_screen "\$HANDOFF_RUNNER"/);
  const relay = wrapper.slice(wrapper.indexOf("function Show-ChildOutput"), wrapper.indexOf("function Invoke-EmbeddedPowerShell"));
  assert.match(relay, /if \(\$line -cnotmatch \$ScreenHiddenPattern\) \{ \[Console\]::Out\.WriteLine\(\$line\) \}/);
  assert.match(relay, /if \(\$Result\.Errors\) \{ \[Console\]::Error\.Write\(\$Result\.Errors\) \}/);
  assert.doesNotMatch(relay, /\s-(?:i?notmatch|i?match)\s/, "PowerShell -match ignores case and would hide owner lines");

  // The child streams are still drained concurrently, then handed back.
  assert.match(wrapper, /return \[pscustomobject\]@\{ ExitCode = \[int\]\$process\.ExitCode; Output = \$stdoutTask\.Result; Errors = \$stderrTask\.Result \}/);
  assert.match(wrapper, /return \[pscustomobject\]@\{ ExitCode = \$code; Output = ""; Errors = "" \}/);
  const prepCall = wrapper.indexOf('$prepResult = Invoke-EmbeddedPowerShell $prep @("--real")');
  const shown = wrapper.indexOf("Show-ChildOutput $prepResult");
  const exitLogged = wrapper.indexOf('Write-SafeLog "PREP_EXIT_CODE=');
  assert.ok(prepCall > 0 && prepCall < shown && shown < exitLogged, "prep output is relayed before its exit marker");
  assert.equal(wrapper.split("Show-ChildOutput $").length - 1, 1, "only the prep child is relayed; the pipe test child and handoff are not");

  // Same plain lines with Windows place names. The Windows script writes its
  // success branch before its failure branch, so compare the sets; the Mac
  // order is pinned here and the screen order by the behavior tests.
  const macLines = [...mac.matchAll(/^\s*say '([^']*)'/gm)].map((match) => match[1]);
  const windowsLines = [...wrapper.matchAll(/^\s*Write-OwnerLine "([^"]*)"/gm)].map((match) => match[1]);
  assert.deepEqual(macLines, [MAC_SCREEN.start, "", MAC_SCREEN.failed, MAC_SCREEN.ready, MAC_SCREEN.windowFailed, MAC_SCREEN.handoff, MAC_SCREEN.handoffFailed, MAC_SCREEN.done]);
  assert.deepEqual([...windowsLines].sort(), [...macLines.map(toWindowsScreen), "This PC needs Windows 10 or newer. Nothing was downloaded or installed."].sort());
  assert.match(wrapper, new RegExp([
    'Write-SafeLog "SETUP_LAUNCH_DECISION_REACHED=1 skipped=prep_failed"',
    'Write-OwnerLine ""',
    `Write-OwnerLine "${escape(WINDOWS_SCREEN.failed)}"`,
    "Wait-OwnerBeforeClose",
    "exit \\$prepResult\\.ExitCode",
  ].join("\\s*(?:if [^\\n]*\\n\\s*)?")));
  assert.doesNotMatch(wrapper, /OWNER ACTION/);

  // The Start Menu window closes on exit, so every failure waits for Enter.
  const wait = wrapper.slice(wrapper.indexOf("function Wait-OwnerBeforeClose"), wrapper.indexOf("function Show-ChildOutput"));
  assert.match(wait, /if \(\$env:MACHINE_PREP_INSTALLER_TEST_MODE -eq "1" -or \[Console\]::IsInputRedirected\) \{ return \}/);
  assert.match(wait, /\[Console\]::Out\.WriteLine\("Press Enter to close this window\."\)/);
  assert.match(wait, /\[void\]\[Console\]::ReadLine\(\)/);
  assert.equal(wrapper.split("Wait-OwnerBeforeClose").length - 1, 5, "defined once and used on all four failure paths");
  for (const [owner, exit] of [
    [WINDOWS_SCREEN.windowFailed, "exit $setupExit"],
    [WINDOWS_SCREEN.handoffFailed, "exit $handoffResult.ExitCode"],
  ]) {
    assert.match(wrapper, new RegExp(`Write-OwnerLine "${escape(owner)}"; Wait-OwnerBeforeClose; ${escape(exit)}`));
  }
});

test("Mac launcher reaches prep and setup decisions, propagates failures, and hands off only after success", bashBehaviorOptions(), () => {
  const prepFailure = runMacWrapper({ prepExit: 7, openExit: 0, handoffExit: 0 });
  assert.equal(prepFailure.status, 7, prepFailure.stderr);
  assert.deepEqual(prepFailure.calls, ["prep"]);
  assert.match(prepFailure.log, /SETUP_LAUNCH_DECISION_REACHED=1 skipped=prep_failed/);

  const launchFailure = runMacWrapper({ prepExit: 0, openExit: 9, handoffExit: 0 });
  assert.equal(launchFailure.status, 9, launchFailure.stderr);
  assert.deepEqual(launchFailure.calls, ["prep", "open"]);
  assert.match(launchFailure.log, /SETUP_WINDOW_STARTED=0/);

  const control = runMacWrapper({ prepExit: 0, openExit: 0, handoffExit: 0 });
  assert.equal(control.status, 0, control.stderr);
  assert.deepEqual(control.calls, ["prep", "open", "handoff"]);
  assert.match(control.log, /INSTALLER_HANDOFF_STARTED=1/);
});

test("Windows launcher reaches one typed exit decision and starts setup only after prep succeeds", { skip: process.platform !== "win32" }, () => {
  const powerShell = process.env.SystemRoot
    ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const run = ({ prep, setup, handoff }) => {
    const home = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-windows-wrapper-")));
    try {
      const result = spawnSync(powerShell, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", join(WINDOWS_INSTALLER, "run-machine-prep.ps1"),
      ], {
        cwd: ROOT,
        env: {
          SystemRoot: process.env.SystemRoot,
          SYSTEMROOT: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          COMSPEC: process.env.COMSPEC,
          PATH: process.env.PATH,
          PATHEXT: process.env.PATHEXT,
          TEMP: join(home, "temp"), TMP: join(home, "temp"), HOME: home,
          USERPROFILE: home, LOCALAPPDATA: join(home, "local"), APPDATA: join(home, "roaming"),
          BRAIN_NO_WRANGLER_LOGIN: "1", BRAIN_TEST_LAUNCHCTL: join(home, "injected-launchctl"),
          MACHINE_PREP_OS_VERSION_OVERRIDE: "10.0",
          MACHINE_PREP_INSTALLER_TEST_MODE: "1",
          MACHINE_PREP_TEST_PREP_EXIT: String(prep),
          MACHINE_PREP_TEST_SETUP_EXIT: String(setup),
          MACHINE_PREP_TEST_HANDOFF_EXIT: String(handoff),
        },
        encoding: "utf8",
      });
      const logFile = join(home, "local", "FinancialBrainMachinePrep", "installer.log");
      const log = existsSync(logFile) ? readFileSync(logFile, "utf8").replaceAll("\r\n", "\n") : "";
      return { ...result, stdout: result.stdout.replaceAll("\r\n", "\n"), log };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };
  const schemaMarkerOnScreen = /^(?:OS_DECISION_REACHED|LOG_SCHEMA_DECISION_REACHED|INSTALLER_PROGRESS|PREP_EXIT_CODE|SETUP_LAUNCH_DECISION_REACHED|SETUP_WINDOW_STARTED|INSTALLER_HANDOFF)/m;

  const refused = run({ prep: 7, setup: 0, handoff: 0 });
  assert.equal(refused.status, 7, `${refused.stdout}${refused.stderr}`);
  assert.match(refused.log, /PREP_EXIT_CODE=7/);
  assert.match(refused.stdout, /TEST_SETUP_ATTEMPTS=0/);
  assert.ok(refused.stdout.includes(`${WINDOWS_SCREEN.start}\n\n${WINDOWS_SCREEN.failed}\n`), refused.stdout);
  assert.doesNotMatch(refused.stdout, /OWNER ACTION|Press Enter/);

  const setupFailure = run({ prep: 0, setup: 9, handoff: 0 });
  assert.equal(setupFailure.status, 9, `${setupFailure.stdout}${setupFailure.stderr}`);
  assert.match(setupFailure.stdout, /TEST_SETUP_ATTEMPTS=1/);
  assert.match(setupFailure.log, /SETUP_WINDOW_STARTED=0/);
  assert.ok(setupFailure.stdout.includes(`${WINDOWS_SCREEN.windowFailed}\n`), setupFailure.stdout);

  const control = run({ prep: 0, setup: 0, handoff: 0 });
  assert.equal(control.status, 0, `${control.stdout}${control.stderr}`);
  assert.match(control.log, /PREP_EXIT_CODE=0/);
  assert.match(control.log, /SETUP_WINDOW_STARTED=1/);
  assert.match(control.log, /INSTALLER_HANDOFF_STARTED=1/);
  // Test mode reports the setup attempt between the ready and handoff lines.
  assert.ok(control.stdout.includes(`${WINDOWS_SCREEN.ready}\nTEST_SETUP_ATTEMPTS=1\n${WINDOWS_SCREEN.handoff}\n${WINDOWS_SCREEN.done}\n`), control.stdout);
  for (const result of [refused, setupFailure, control]) assert.doesNotMatch(result.stdout, schemaMarkerOnScreen, result.stdout);
});

test("Windows launcher concurrently drains oversized child output for zero and nonzero exits", { skip: process.platform !== "win32", timeout: 300_000 }, () => {
  const powerShell = process.env.SystemRoot
    ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  for (const exitCode of [0, 7]) {
    const directory = realpathSync.native(mkdtempSync(join(ROOT, ".machine-prep-windows-runner-pipes-")));
    const child = join(directory, "large-output.ps1");
    mkdirSync(join(directory, "temp"), { recursive: true });
    writeFileSync(child, `$chunk = "x" * 1024\n1..256 | ForEach-Object { [Console]::Error.WriteLine($chunk) }\n1..256 | ForEach-Object { [Console]::Out.WriteLine($chunk) }\nexit ${exitCode}\n`);
    try {
      const result = spawnSync(powerShell, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", join(WINDOWS_INSTALLER, "run-machine-prep.ps1"), "-TestChildPath", child,
      ], {
        cwd: ROOT,
        env: {
          SystemRoot: process.env.SystemRoot,
          SYSTEMROOT: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          COMSPEC: process.env.COMSPEC,
          PATH: process.env.PATH,
          PATHEXT: process.env.PATHEXT,
          TEMP: join(directory, "temp"), TMP: join(directory, "temp"), HOME: directory,
          USERPROFILE: directory, LOCALAPPDATA: join(directory, "local"), APPDATA: join(directory, "roaming"),
          BRAIN_NO_WRANGLER_LOGIN: "1", BRAIN_TEST_LAUNCHCTL: join(directory, "injected-launchctl"),
          MACHINE_PREP_OS_VERSION_OVERRIDE: "10.0",
          MACHINE_PREP_INSTALLER_TEST_MODE: "1",
        },
        encoding: "utf8",
        timeout: WINDOWS_POWERSHELL_PROCESS_TIMEOUT_MS,
      });
      assert.equal(result.error, undefined, String(result.error));
      assert.equal(result.status, exitCode, `${result.stdout}${result.stderr}`);
      assert.match(result.stdout, new RegExp(`REDIRECTED_PROCESS_DECISION_REACHED=1 exit=${exitCode}`));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

// Even the OS decision belongs in the fixed-schema log, not the owner screen.
test("Windows OS decision is logged before refusal and hidden from the owner", () => {
  const source = read("machine-prep/installers/windows/run-machine-prep.ps1");
  assert.match(source, /Write-SafeLog "OS_DECISION_REACHED=1 current=\$CurrentVersion minimum=10\.0"/);
  assert.doesNotMatch(source, /Write-Output "OS_DECISION_REACHED/);
  assert.ok(source.indexOf('Write-SafeLog "OS_DECISION_REACHED=') < source.indexOf('if ($CurrentVersion.Major -lt 10)'));
});
