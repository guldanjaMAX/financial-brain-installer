// This entry point can mutate only a disposable hosted runner. Unit tests
// exercise the injected lifecycle; they never enter this native adapter.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { assertExactPaths, assertHostedRunner, runSmoke, verifyHashRecord } from "./contract.mjs";
import { bootstrapInstalled } from "./bootstrap.mjs";

assertHostedRunner(process.env);
const [platform, artifactDirectory, logDirectory, mode] = process.argv.slice(2);
if (!['macos', 'windows'].includes(platform) || (mode !== undefined && mode !== "--bootstrap") || process.argv.length !== (mode ? 6 : 5) ||
    process.platform !== (platform === "macos" ? "darwin" : "win32")) throw new Error("invalid smoke arguments or platform");
const artifact = resolve(artifactDirectory, `FinancialBrainInstaller.${platform === "macos" ? "pkg" : "msi"}`);
const logs = resolve(logDirectory);
// Reusing a log directory can mix receipts from different attempts.
mkdirSync(logs, { recursive: false });
const emit = (event) => { console.log(event); appendFileSync(join(logs, "decisions.log"), `${event}\n`); };
const environment = {};
for (const name of ["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "ProgramFiles", "ProgramFiles(x86)", "GITHUB_ACTIONS", "RUNNER_ENVIRONMENT"]) {
  if (process.env[name]) environment[name] = process.env[name];
}
environment.BRAIN_NO_WRANGLER_LOGIN = "1";

function command(label, executable, args, accepted = [0]) {
  const timeout = label === "installed-cli-preparation" ? 900_000 : 180_000;
  const result = spawnSync(executable, args, { env: environment, cwd: logs, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 });
  writeFileSync(join(logs, `${label}.log`), `${result.stdout || ""}${result.stderr || ""}\nexit=${result.status}\n`);
  if (result.error || !accepted.includes(result.status)) throw new Error(`${label} failed; inspect its log`);
  return result.stdout;
}
function assertAbsent(path) {
  // existsSync alone misses a dangling symlink, which is not a clean target.
  try { lstatSync(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error("smoke destination is already occupied");
}
function filesUnder(root, prefix = "") {
  if (lstatSync(root).isSymbolicLink()) throw new Error("symlink at payload root");
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error("unsupported payload entry");
    return entry.isDirectory() ? [`${relative}/`, ...filesUnder(join(root, entry.name), relative)] : [relative];
  });
}
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const macFiles = ["UNINSTALL.md", "prep-mac.sh", "Run Financial Brain Machine Prep.command", "start-brain-setup.command",
  "handoff/continue-in-claude.command", "handoff/handoff-mac.sh", "handoff/handoff-macos.url", "handoff/message-macos.txt"];

function macHost() {
  const home = process.env.HOME;
  if (!home || process.getuid() === 0) throw new Error("current-user Mac smoke must not run as root");
  const installed = join(home, "Applications", "Financial Brain Machine Prep");
  const expanded = join(logs, "expanded");
  const identifier = "com.financialbrain.machineprep";
  const receiptArgs = ["--volume", home];
  let payload;
  let applicationDirectoryExisted;
  const receiptPresent = () => command("receipt-list", "/usr/sbin/pkgutil", [...receiptArgs, "--pkgs"]).trim().split(/\r?\n/).includes(identifier);
  const sentinelPaths = [join(home, ".financial-brain"), join(home, ".brain"),
    join(home, "Library", "LaunchAgents"), "/Applications/Financial Brain Machine Prep"];
  let sentinelState;
  const snapshot = () => sentinelPaths.map((path) => existsSync(path)
    ? { exists: true, entries: filesUnder(path).sort().map((file) => [file, file.endsWith("/") ? null : digest(join(path, file))]) }
    : { exists: false });
  return {
    verifySignature() {
      const signature = command("signature", "/usr/sbin/pkgutil", ["--check-signature", artifact]);
      // The same-run signing job already checks the protected Apple Team ID.
      // Here require a Developer ID Installer leaf and native trust checks.
      if (!/^\s*1\.\s+Developer ID Installer: .+ \([A-Z0-9]{10}\)\s*$/m.test(signature)) throw new Error("unexpected package signer");
      command("gatekeeper", "/usr/sbin/spctl", ["--assess", "--type", "install", "--verbose=2", artifact]);
      command("staple", "/usr/bin/xcrun", ["stapler", "validate", artifact]);
    },
    inspectPayload() {
      command("expand", "/usr/sbin/pkgutil", ["--expand-full", artifact, expanded]);
      const distribution = readFileSync(join(expanded, "Distribution"), "utf8");
      if (!distribution.includes('enable_localSystem="false"') || !distribution.includes('enable_currentUserHome="true"') ||
          !distribution.includes('enable_anywhere="false"') || !distribution.includes('require-scripts="false"') ||
          /<script\b|installation-check|volume-check/.test(distribution)) throw new Error("unexpected package domain or script");
      const components = readdirSync(expanded).filter((name) => name.endsWith(".pkg"));
      assertExactPaths(components, ["FinancialBrainMachinePrep-component.pkg"]);
      const component = join(expanded, components[0]);
      const info = readFileSync(join(component, "PackageInfo"), "utf8");
      if (!info.includes(`identifier="${identifier}"`) || !info.includes('version="0.2.0"') ||
          !info.includes('install-location="/"') || /<scripts\b/.test(info) || existsSync(join(component, "Scripts"))) throw new Error("unexpected component metadata");
      const root = join(component, "Payload");
      assertExactPaths(filesUnder(root), ["Applications/", "Applications/Financial Brain Machine Prep/",
        "Applications/Financial Brain Machine Prep/handoff/", ...macFiles.map((file) => `Applications/Financial Brain Machine Prep/${file}`)]);
      payload = join(root, "Applications", "Financial Brain Machine Prep");
      emit(`PAYLOAD_FILES_VERIFIED=${macFiles.length}`);
    },
    assertClean() {
      assertAbsent(installed);
      if (receiptPresent()) throw new Error("package receipt already exists");
      for (const path of sentinelPaths.filter((path) => !path.endsWith("LaunchAgents"))) assertAbsent(path);
      applicationDirectoryExisted = existsSync(join(home, "Applications"));
      sentinelState = snapshot();
      emit("INSTALL_SCOPE=current_user");
    },
    install() {
      // Distribution.xml disables the system domain. sudo -target / would
      // test a different contract and can resolve HOME to the root account.
      const domains = command("domains", "/usr/sbin/installer", ["-pkg", artifact, "-dominfo"]);
      if (!domains.includes("CurrentUserHomeDirectory") || /\bLocalSystem\b/.test(domains)) throw new Error("current-user installer domain unavailable");
      command("install", "/usr/sbin/installer", ["-pkg", artifact, "-target", "CurrentUserHomeDirectory", "-verboseR"]);
    },
    verifyInstalled() {
      assertExactPaths(filesUnder(installed), ["handoff/", ...macFiles]);
      for (const file of macFiles) {
        if (digest(join(installed, file)) !== digest(join(payload, file))) throw new Error("installed file differs from signed payload");
      }
      const launcher = join(installed, "Run Financial Brain Machine Prep.command");
      if (!(lstatSync(launcher).mode & 0o111)) throw new Error("installed launcher is not executable");
      command("launcher-syntax", "/bin/bash", ["-n", launcher]);
      command("installed-prep-help", "/bin/bash", [join(installed, "prep-mac.sh"), "--help"]);
      if (!receiptPresent()) throw new Error("installed receipt missing");
      if (JSON.stringify(snapshot()) !== JSON.stringify(sentinelState)) throw new Error("unexpected installation location");
      emit("INSTALLED_LAUNCHERS_VERIFIED=1");
    },
    uninstall() {
      // assertClean proved this exact directory and receipt were absent.
      // No prepared CLI, user document, or credential path is ever removed.
      if (existsSync(installed)) rmSync(installed, { recursive: true });
      if (receiptPresent()) command("uninstall-receipt", "/usr/sbin/pkgutil", [...receiptArgs, "--forget", identifier]);
      if (!applicationDirectoryExisted && existsSync(join(home, "Applications")) && readdirSync(join(home, "Applications")).length === 0) {
        rmSync(join(home, "Applications"), { recursive: true });
      }
    },
    verifyRemoved() {
      assertAbsent(installed);
      if (receiptPresent()) throw new Error("uninstall receipt remains");
      if (JSON.stringify(snapshot()) !== JSON.stringify(sentinelState)) throw new Error("unexpected uninstall location");
      emit("UNINSTALL_VERIFIED=1");
    },
  };
}

const helper = join(import.meta.dirname, "windows.ps1");
const host = platform === "macos" ? macHost() : Object.fromEntries([
  "verifySignature", "inspectPayload", "assertClean", "install", "verifyInstalled", "uninstall", "verifyRemoved",
].map((phase) => [phase, () => command(phase, "pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", helper,
  "-Phase", phase, "-Artifact", artifact, "-LogDirectory", logs])]));
host.verifyHash = () => {
  assertExactPaths(readdirSync(resolve(artifactDirectory)), [basename(artifact), `${basename(artifact)}.sha256`]);
  for (const path of [artifact, `${artifact}.sha256`]) {
    if (!lstatSync(path).isFile()) throw new Error("signed artifact input is not a regular file");
  }
  verifyHashRecord(readFileSync(artifact), readFileSync(`${artifact}.sha256`, "utf8"), basename(artifact));
};
if (mode === "--bootstrap") host.bootstrap = () => bootstrapInstalled({ platform, logs, environment, command, emit });
try {
  await runSmoke(host, emit);
  if (mode === "--bootstrap") emit("INSTALLER_BOOTSTRAP_SMOKE_PASSED=1");
} catch (error) {
  emit("INSTALLER_SHELL_SMOKE_PASSED=0");
  throw error;
} finally {
  // Expanded payload contains the deep-link note. Retain diagnostics, not a
  // second unsigned copy of the artifact under the log artifact's name.
  if (platform === "macos" && existsSync(join(logs, "expanded"))) rmSync(join(logs, "expanded"), { recursive: true });
}
