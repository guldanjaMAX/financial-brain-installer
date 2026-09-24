import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const HANDOFF = join(ROOT, "machine-prep", "handoff");
const MAC_INSTALLER = join(ROOT, "machine-prep", "installers", "macos");

function read(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8").replaceAll("\r\n", "\n");
}

test("Claude handoff messages use the public OS guide and preserve owner approval", () => {
  const mac = read("machine-prep/handoff/message-macos.txt");
  const windows = read("machine-prep/handoff/message-windows.txt");
  assert.match(mac, /^Please start the Financial Brain guided setup\./);
  assert.match(mac, /curl -fsSL https:\/\/financialbrain\.ai\/install\/agent-macos\.md/);
  assert.match(windows, /curl -fsSL https:\/\/financialbrain\.ai\/install\/agent\.md/);
  for (const message of [mac, windows]) {
    assert.match(message, /Want me to do this for you\?/);
    assert.match(message, /Wait for my answer before taking that step\./);
    assert.match(message, /Never ask me to paste a command\./);
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
  assert.equal(`${decoded}\n`, readFileSync(prompt, "utf8"));
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

test("macOS installer refuses an unsupported release after reaching its OS gate", () => {
  const preinstall = join(MAC_INSTALLER, "scripts", "preinstall");
  const result = spawnSync("bash", [preinstall], {
    cwd: ROOT,
    env: {
      ...process.env,
      MACHINE_PREP_OS_VERSION_OVERRIDE: "12.6.9",
      MACHINE_PREP_INSTALLER_TEST_MODE: "1",
    },
    encoding: "utf8",
  });
  const out = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 2, out);
  assert.match(out, /OS_DECISION_REACHED=1/);
  assert.match(out, /REFUSED macOS 13\.5 or newer is required/);
  assert.doesNotMatch(out, /PREP_STARTED/);
});

test("macOS staging contains the real prep, handoff, support log wrapper, and uninstall notes", () => {
  const staging = mkdtempSync(join(tmpdir(), "machine-prep-pkg-stage-"));
  try {
    const build = spawnSync("bash", [join(MAC_INSTALLER, "build-pkg.sh"), "--staging-only", staging], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);
    const installed = join(staging, "payload", "Library", "Application Support", "FinancialBrainMachinePrep");
    const expected = [
      "prep-mac.sh",
      "run-machine-prep-mac.sh",
      "handoff/handoff-mac.sh",
      "handoff/handoff-macos.url",
      "handoff/message-macos.txt",
      "UNINSTALL.md",
    ];
    for (const relativePath of expected) {
      assert.equal(existsSync(join(installed, relativePath)), true, `missing ${relativePath}`);
    }
    assert.notEqual(statSync(join(installed, "prep-mac.sh")).mode & 0o111, 0);
    const wrapper = readFileSync(join(installed, "run-machine-prep-mac.sh"), "utf8");
    assert.match(wrapper, /prep-mac\.sh" --real/);
    assert.match(wrapper, /installer\.log/);
    assert.match(wrapper, /handoff-mac\.sh/);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test("macOS package scripts keep root plumbing separate from the console user prep", () => {
  const postinstall = read("machine-prep/installers/macos/scripts/postinstall");
  assert.match(postinstall, /\/dev\/console/);
  assert.match(postinstall, /launchctl asuser/);
  assert.match(postinstall, /sudo -u/);
  assert.match(postinstall, /run-machine-prep-mac\.sh/);
  assert.doesNotMatch(postinstall, /prep-mac\.sh[^\n]*--real/);
});

test("macOS native tools build the reviewed unsigned package contents", { skip: process.platform !== "darwin" }, () => {
  const output = mkdtempSync(join(tmpdir(), "machine-prep-pkg-build-"));
  try {
    const pkg = join(output, "FinancialBrainMachinePrep-unsigned.pkg");
    const build = spawnSync("bash", [join(MAC_INSTALLER, "build-pkg.sh"), pkg], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);
    const contents = spawnSync("pkgutil", ["--payload-files", pkg], { encoding: "utf8" });
    assert.equal(contents.status, 0, `${contents.stdout}${contents.stderr}`);
    assert.match(contents.stdout, /FinancialBrainMachinePrep\/prep-mac\.sh/);
    // PackageKit can serialize protected host provenance xattrs as AppleDouble
    // entries. Ignore those metadata carriers and pin every functional path.
    const functionalPaths = contents.stdout.trim().split("\n")
      .filter((path) => !path.split("/").some((part) => part.startsWith("._")))
      .sort();
    assert.deepEqual(functionalPaths, [
      ".",
      "./Library",
      "./Library/Application Support",
      "./Library/Application Support/FinancialBrainMachinePrep",
      "./Library/Application Support/FinancialBrainMachinePrep/UNINSTALL.md",
      "./Library/Application Support/FinancialBrainMachinePrep/handoff",
      "./Library/Application Support/FinancialBrainMachinePrep/handoff/continue-in-claude.command",
      "./Library/Application Support/FinancialBrainMachinePrep/handoff/handoff-mac.sh",
      "./Library/Application Support/FinancialBrainMachinePrep/handoff/handoff-macos.url",
      "./Library/Application Support/FinancialBrainMachinePrep/handoff/message-macos.txt",
      "./Library/Application Support/FinancialBrainMachinePrep/prep-mac.sh",
      "./Library/Application Support/FinancialBrainMachinePrep/run-machine-prep-mac.sh",
    ].sort());
    const signature = spawnSync("pkgutil", ["--check-signature", pkg], { encoding: "utf8" });
    assert.equal(signature.status, 1, `${signature.stdout}${signature.stderr}`);
    assert.match(signature.stdout, /Status: no signature/);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
