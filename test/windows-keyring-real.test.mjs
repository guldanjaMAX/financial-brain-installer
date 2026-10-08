/** CI-only, credential-free probe of the actual pinned Wrangler subprocess. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  CLOUDFLARE_OAUTH_WRANGLER_PACKAGE, cloudflareOAuthChildEnvironment, enableCloudflareOAuthKeyring,
} from "../operations/cloudflare-oauth-session.mjs";
import { WINDOWS_KEYRING_ENABLE_COMMAND } from "../operations/cloudflare-keyring-guidance.mjs";

const optedIn = process.env.BRAIN_TEST_WINDOWS_KEYRING_ENABLE === "1";
const mode = process.argv.find((arg) => ["--missing", "--control"].includes(arg));

test(`real Windows keyring ${mode ?? "CI gate"}`, { skip: !optedIn }, () => {
  assert.equal(process.platform, "win32", "this gate requires native Windows");
  assert.equal(process.env.BRAIN_TEST_CHAIN, "1");
  assert.ok(!process.env.BRAIN_NO_WRANGLER_LOGIN, "the real gate cannot disable Wrangler");
  assert.ok(mode, "select the clean-profile refusal or the preinstalled CONTROL");
  const requestedRoot = process.env.BRAIN_WINDOWS_KEYRING_TEST_ROOT;
  assert.ok(requestedRoot && isAbsolute(requestedRoot));
  if (mode === "--missing") assert.equal(existsSync(requestedRoot), false, "start with a clean profile");
  mkdirSync(requestedRoot, { recursive: true });
  const root = realpathSync.native(requestedRoot);
  const home = join(root, "home");
  const config = join(root, "config");
  const wranglerDir = join(config, ".wrangler");
  const bindingDir = join(wranglerDir, "native", "keyring");
  const receipt = join(root, "missing-binding-reached.json");
  for (const dir of [home, config, join(root, "roaming"), join(root, "local"),
    join(root, "temp"), join(root, "cache"), join(root, "npm-prefix"), join(root, "work")]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(home, ".npmrc"), "");
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const dist = readFileSync(join(repo, "node_modules/wrangler/wrangler-dist/cli.js"), "utf8");
  const wranglerVersion = JSON.parse(readFileSync(join(repo, "node_modules/wrangler/package.json"), "utf8")).version;
  assert.equal(`wrangler@${wranglerVersion}`, CLOUDFLARE_OAUTH_WRANGLER_PACKAGE);
  const versions = [...dist.matchAll(/PINNED_KEYRING_VERSION = "(\d+\.\d+\.\d+)"/g)];
  assert.equal(versions.length, 1, "read the native binding version from the reviewed Wrangler dist");
  const bindingVersion = versions[0][1];
  const distSha256 = createHash("sha256").update(dist).digest("hex");
  const environment = {
    ...cloudflareOAuthChildEnvironment({ environment: process.env }),
    HOME: home, USERPROFILE: home, APPDATA: join(root, "roaming"), LOCALAPPDATA: join(root, "local"),
    XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
    TEMP: join(root, "temp"), TMP: join(root, "temp"), TMPDIR: join(root, "temp"),
    NPM_CONFIG_CACHE: join(root, "npm-cache"), npm_config_cache: join(root, "npm-cache"),
    NPM_CONFIG_PREFIX: join(root, "npm-prefix"), npm_config_prefix: join(root, "npm-prefix"),
    BRAIN_TEST_CHAIN: "1", BRAIN_TEST_WINDOWS_KEYRING_ENABLE: "1",
  };
  // A desktop/global binding must not turn the clean-profile arm into success.
  // The npm prefix is isolated too because Wrangler checks `npm root -g`.
  delete environment.HOMEDRIVE;
  delete environment.HOMEPATH;
  const options = {
    environment, workingDirectory: join(root, "work"),
    allowWindowsKeyringEnableTest: true,
  };
  assert.ok(!process.stdin.isTTY && !process.stdout.isTTY, "CI must exercise captured stdio");
  assert.equal(existsSync(join(home, ".wrangler")), false, "no legacy profile can override the fixture config");
  if (mode === "--missing") {
    assert.equal(existsSync(join(bindingDir, "node_modules/@napi-rs/keyring")), false);
    let caught;
    try { enableCloudflareOAuthKeyring(options); } catch (error) { caught = error; }
    // Reason and preferences prove the actual Wrangler decision ran. A guard,
    // broken npx, timeout, or uniform failure cannot satisfy this arm.
    assert.equal(caught?.code, "CLOUDFLARE_KEYRING_UNAVAILABLE");
    assert.equal(caught?.reason, "binding_missing");
    assert.ok(caught.message.includes(WINDOWS_KEYRING_ENABLE_COMMAND));
    assert.equal(JSON.parse(readFileSync(join(wranglerDir, "preferences.json"), "utf8")).keyring_enabled, false);
    writeFileSync(receipt, JSON.stringify({ reason: caught.reason, distSha256, bindingVersion }));
  } else {
    assert.deepEqual(JSON.parse(readFileSync(receipt, "utf8")), { reason: "binding_missing", distSha256, bindingVersion },
      "CONTROL requires the reached missing-binding arm on these exact Wrangler bytes");
    mkdirSync(bindingDir, { recursive: true });
    writeFileSync(join(bindingDir, "package.json"), JSON.stringify({ private: true, name: "fixture-keyring-host" }));
    const installed = spawnSync("npm", ["install", "--prefix", `"${bindingDir}"`,
      `@napi-rs/keyring@${bindingVersion}`, "--no-audit", "--no-fund"], {
      shell: true, stdio: ["ignore", "pipe", "pipe"], encoding: null,
      cwd: join(root, "work"), env: cloudflareOAuthChildEnvironment({ environment }), timeout: 180_000,
    });
    installed.stdout?.fill(0);
    installed.stderr?.fill(0);
    assert.ok(installed.status === 0 && !installed.error && !installed.signal, "CONTROL binding install failed");
    const bindingPackage = JSON.parse(readFileSync(join(bindingDir, "node_modules/@napi-rs/keyring/package.json"), "utf8"));
    assert.equal(bindingPackage.version, bindingVersion);
    enableCloudflareOAuthKeyring(options);
    assert.equal(JSON.parse(readFileSync(join(wranglerDir, "preferences.json"), "utf8")).keyring_enabled, true,
      "CONTROL must enable protected storage with the real native binding");
  }
  assert.equal(existsSync(join(wranglerDir, "config/default.toml")), false);
  assert.equal(existsSync(join(wranglerDir, "config/default.enc")), false);
});
