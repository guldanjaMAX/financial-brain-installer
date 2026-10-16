// MAIN-only package installation acceptance. Do not run in no-install lanes.
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { inspectNpmArchiveBytes } from "../../operations/package-bundle-verifier.mjs";
import { deriveUpdateRuntimePayloadSha256, verifyUpdateRuntimePayload } from "../../operations/update-preview.mjs";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("real clean-prefix POSIX npm install preserves the archive-derived runtime identity", {
  skip: process.platform === "win32",
}, (t) => {
  const temporary = realpathSync.native(mkdtempSync(join(realpathSync(tmpdir()),
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

  const npmCli = realpathSync(process.env.npm_execpath || join(dirname(process.execPath), "npm"));
  const npmEnvironment = {
    ...Object.fromEntries(["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR", "BRAIN_NO_WRANGLER_LOGIN"].filter(key => typeof process.env[key] === "string").map(key => [key, process.env[key]])),
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
