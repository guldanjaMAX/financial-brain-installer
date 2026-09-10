import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PREFLIGHT = join(ROOT, "tools", "preflight.sh");
const WINDOWS_PREFLIGHT = join(ROOT, "tools", "preflight.ps1");

function executable(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function runPreflight({
  nodeVersion = "v22.0.0",
  brainCopies = 0,
  wranglerSession = null,
  elevated = false,
  freeKib = 3 * 1024 * 1024,
} = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "brain-preflight-"));
  try {
    const home = join(fixture, "home");
    const bin = join(fixture, "bin");
    mkdirSync(home);
    mkdirSync(bin);
    executable(join(bin, "uname"), "printf '%s\\n' 'Darwin'");
    executable(join(bin, "id"), `printf '%s\\n' '${elevated ? 0 : 501}'`);
    executable(join(bin, "df"), `printf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on' '/dev/fixture 9999999 1 ${freeKib} 1% /fixture'`);

    if (wranglerSession === "home-fallback") {
      // An existing but empty earlier directory must not hide a later file.
      mkdirSync(join(home, ".config", ".wrangler", "config"), { recursive: true });
      const fallback = join(home, ".wrangler", "config");
      mkdirSync(fallback, { recursive: true });
      writeFileSync(join(fallback, "default.toml"), "fixture session marker only\n");
    } else if (wranglerSession === "native" || wranglerSession === "native-encrypted") {
      const config = join(home, "Library", "Preferences", ".wrangler", "config");
      mkdirSync(config, { recursive: true });
      writeFileSync(join(config, wranglerSession === "native" ? "default.toml" : "default.enc"), "fixture session marker only\n");
    } else if (wranglerSession === "xdg") {
      const xdg = join(fixture, "xdg config");
      const config = join(xdg, ".wrangler", "config");
      mkdirSync(config, { recursive: true });
      writeFileSync(join(config, "default.toml"), "fixture session marker only\n");
    }

    executable(join(bin, "node"), `printf '%s\\n' '${nodeVersion}'`);
    executable(join(bin, "npm"), `
case "$1" in
  -v) printf '%s\\n' '10.0.0' ;;
  config) printf '%s\\n' '/fixture-prefix' ;;
  ls) exit 0 ;;
esac`);
    executable(join(bin, "curl"), `
case "$*" in
  *releases/latest*) printf '%s\\n' '{"tag_name":"v0.3.7"}' ;;
  *) printf '%s' '200' ;;
esac`);

    const brainDirs = [];
    for (let i = 0; i < brainCopies; i++) {
      const dir = join(fixture, `brain-${i + 1}`);
      mkdirSync(dir);
      executable(join(dir, "brain"), "exit 0");
      brainDirs.push(dir);
    }

    const env = {
      LANG: "C.UTF-8",
      HOME: home,
      PATH: [...brainDirs, bin, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
      ...(wranglerSession === "xdg" ? { XDG_CONFIG_HOME: join(fixture, "xdg config") } : {}),
    };
    delete env.CLOUDFLARE_API_TOKEN;
    delete env.CLOUDFLARE_API_KEY;
    if (wranglerSession !== "xdg") delete env.XDG_CONFIG_HOME;

    return spawnSync("/bin/bash", [PREFLIGHT], {
      cwd: ROOT,
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

test("POSIX preflight rejects Node 21 and accepts Node 22", { skip: process.platform === "win32" }, () => {
  const oldNode = runPreflight({ nodeVersion: "v21.9.0" });
  assert.equal(oldNode.status, 1);
  assert.match(oldNode.stdout, /node v21\.9\.0 is too old; the installer needs 22 or newer/);

  const supportedNode = runPreflight({ nodeVersion: "v22.0.0" });
  assert.equal(supportedNode.status, 0, supportedNode.stderr || supportedNode.stdout);
  assert.doesNotMatch(supportedNode.stdout, /node .* is too old/);
});

test("POSIX preflight rejects root and less than 2 GiB on the actual install drive", { skip: process.platform === "win32" }, () => {
  const root = runPreflight({ elevated: true });
  assert.equal(root.status, 1);
  assert.match(root.stdout, /STOP\s+this shell is running as root.*without sudo/i);

  const full = runPreflight({ freeKib: 2 * 1024 * 1024 - 1 });
  assert.equal(full.status, 1);
  assert.match(full.stdout, /STOP\s+the actual install drive has less than 2 GiB free/i);

  const ready = runPreflight({ freeKib: 2 * 1024 * 1024 });
  assert.equal(ready.status, 0, ready.stderr || ready.stdout);
  assert.match(ready.stdout, /ok\s+actual install drive has at least 2 GiB free/i);
  assert.match(ready.stdout, /ok\s+running as the current user without root elevation/i);
});

test("Windows preflight checks LOCALAPPDATA space and refuses Administrator execution", () => {
  const source = readFileSync(WINDOWS_PREFLIGHT, "utf8");
  assert.match(source, /IsInRole\(\[Security\.Principal\.WindowsBuiltInRole\]::Administrator\)/);
  assert.match(source, /running as Administrator.*open a normal PowerShell window/i);
  assert.match(source, /GetPathRoot\(\$env:LOCALAPPDATA\)/);
  assert.match(source, /AvailableFreeSpace -lt 2GB/);
  assert.match(source, /LOCALAPPDATA install drive has at least 2 GiB free/i);
});

test("POSIX preflight finds every Brain CLI on PATH", { skip: process.platform === "win32" }, () => {
  const result = runPreflight({ brainCopies: 2 });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /STOP\s+2 copies of 'brain' on PATH/);
  assert.match(result.stdout, /brain-1\/brain/);
  assert.match(result.stdout, /brain-2\/brain/);
});

test("POSIX preflight follows Wrangler session precedence without directory masking", { skip: process.platform === "win32" }, () => {
  for (const wranglerSession of ["home-fallback", "xdg", "native"]) {
    const result = runPreflight({ wranglerSession });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /ok\s+wrangler session found/);
    assert.doesNotMatch(result.stdout, /no wrangler session yet/);
  }
});

test("macOS preflight identifies native encrypted sessions", { skip: process.platform === "win32" }, () => {
  const result = runPreflight({ wranglerSession: "native-encrypted" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /wrangler wrote default.enc/);
  assert.match(result.stdout, /cannot verify the current named browser profile/);
});
