/**
 * The legacy default-profile session must stay in the plaintext TOML file the
 * legacy reader parses, even on a machine whose Wrangler preferences enable
 * the OS keyring.
 *
 * WHY THIS EXISTS. The named-profile flow runs `wrangler auth keyring enable`,
 * which Wrangler persists globally in preferences.json. From then on, Wrangler
 * 4.131.1 routes EVERY profile, including the legacy default one, through its
 * encrypted store: the first read moves default.toml into default.enc and
 * deletes the plaintext. The legacy reader then finds nothing, and the only
 * advice it can give (sign in again) loops. Wrangler 4.73.0 had no keyring code.
 *
 * This drives the REAL locked Wrangler dist, offline, with the exact child
 * environment the product's refresh builds. A paired control without the
 * opt-out proves the fixture actually reaches Wrangler's keyring decision, so
 * a pass cannot come from a fixture that never triggers migration.
 *
 * Only Linux runs the real-dist half. There the key provider is `secret-tool`
 * resolved from PATH, so a synthetic stand-in keeps the control hermetic. macOS
 * resolves the absolute /usr/bin/security (the runner's real Keychain) and
 * Windows would try an npm install of a native binding, so neither can host a
 * safe control. The environment assertion runs on every platform.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderCommandWithEnvironment } from "../operations/command-display.mjs";
import { readWranglerOAuthToken, refreshWranglerSession } from "../operations/wrangler-oauth.mjs";
import { REVIEWED_WRANGLER_VERSION } from "../operations/wrangler-runtime-contract.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER_BIN = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");

/** The env the product actually hands its refresh child, captured, never hand-copied. */
function productRefreshEnvironment(source) {
  let captured = null;
  refreshWranglerSession({
    env: source,
    platform: process.platform,
    run: (_command, _args, options) => { captured = options.env; return { status: 0 }; },
  });
  assert.ok(captured, "the refresh must spawn a child with an explicit environment");
  return captured;
}

if (process.platform === "linux") {
  const installed = JSON.parse(readFileSync(join(ROOT, "node_modules", "wrangler", "package.json"), "utf8"));
  assert.equal(installed.version, REVIEWED_WRANGLER_VERSION, "the test must exercise the locked Wrangler");

  const FAR_FUTURE = "2099-01-01T00:00:00.000Z";
  const SESSION = [
    'oauth_token = "synthetic-access"',
    'refresh_token = "synthetic-refresh"',
    `expiration_time = "${FAR_FUTURE}"`,
    'scopes = [ "account:read" ]',
    "",
  ].join("\n");

  /** A keyring-enabled machine with a legacy plaintext session and a stand-in secret-tool. */
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "brain-keyring-opt-out-"));
    const home = join(root, "home");
    const config = join(home, ".config");
    const wranglerDir = join(config, ".wrangler");
    mkdirSync(join(wranglerDir, "config"), { recursive: true });
    writeFileSync(join(wranglerDir, "preferences.json"), JSON.stringify({ keyring_enabled: true }));
    writeFileSync(join(wranglerDir, "config", "default.toml"), SESSION, { mode: 0o600 });
    const bin = join(root, "bin");
    mkdirSync(bin);
    // Holds only the envelope Wrangler generates for this fixture, in the fixture.
    writeFileSync(join(bin, "secret-tool"), [
      "#!/bin/sh",
      `store='${join(root, "keystore")}'`,
      'case "$1" in',
      '  --version) echo synthetic; exit 0;;',
      '  lookup) [ -f "$store" ] && cat "$store" && exit 0; exit 1;;',
      '  store) cat > "$store"; exit 0;;',
      '  clear) rm -f "$store"; exit 0;;',
      "esac",
      "exit 2",
      "",
    ].join("\n"));
    chmodSync(join(bin, "secret-tool"), 0o755);
    return {
      root, home, config,
      toml: join(wranglerDir, "config", "default.toml"),
      enc: join(wranglerDir, "config", "default.enc"),
      preferences: join(wranglerDir, "preferences.json"),
      source: {
        HOME: home,
        XDG_CONFIG_HOME: config,
        TMPDIR: root,
        PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
      },
    };
  }

  // Test-only network guards, added on top of the product environment. They
  // must not collide with anything the product sets, or they would mask it.
  const OFFLINE = {
    HTTPS_PROXY: "http://127.0.0.1:9",
    HTTP_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "",
    WRANGLER_SEND_METRICS: "false",
  };

  /**
   * `auth token --json` reads the default profile through the same credential
   * store `whoami` refreshes through. A far-future expiry means no OAuth
   * refresh, and --json suppresses the banner's update check.
   */
  function runRealWrangler(env, cwd) {
    return spawnSync(process.execPath, [WRANGLER_BIN, "auth", "token", "--json"], {
      cwd, env, encoding: "utf8", timeout: 60_000,
    });
  }

  const reader = (f) => readWranglerOAuthToken({
    env: { HOME: f.home, XDG_CONFIG_HOME: f.config },
    platform: "linux",
    now: Date.parse("2030-01-01T00:00:00.000Z"),
    refresh: () => { throw new Error("a far-future session must not be refreshed"); },
  });

  const control = fixture();
  const treated = fixture();
  try {
    // Control: the same machine without the opt-out reaches the keyring
    // decision and migrates, which is the field failure this guards.
    const controlEnv = productRefreshEnvironment(control.source);
    for (const name of Object.keys(OFFLINE)) {
      assert.equal(controlEnv[name], undefined, `the product refresh env must not already set ${name}`);
    }
    const controlBase = { ...controlEnv };
    delete controlBase.CLOUDFLARE_AUTH_USE_KEYRING;
    const controlRun = runRealWrangler({ ...controlBase, ...OFFLINE }, control.root);
    assert.equal(controlRun.status, 0, "the control must read the synthetic session");
    assert.ok(existsSync(control.enc) && !existsSync(control.toml),
      "control: a keyring-enabled Wrangler moves default.toml into default.enc");
    assert.equal(reader(control), null, "control: the legacy reader loses the moved session");

    // Treated: the exact environment the product's refresh builds.
    const treatedRun = runRealWrangler({ ...productRefreshEnvironment(treated.source), ...OFFLINE }, treated.root);
    assert.equal(treatedRun.status, 0, "the product's refresh environment must still read the session");
    assert.ok(existsSync(treated.toml), "the plaintext legacy session must survive a product-driven Wrangler run");
    assert.equal(readFileSync(treated.toml, "utf8"), SESSION, "and must be byte-identical");
    assert.ok(!existsSync(treated.enc), "no encrypted default-profile file may be created");
    assert.ok(!existsSync(join(treated.root, "keystore")), "no keyring entry may be created");
    assert.deepEqual(JSON.parse(readFileSync(treated.preferences, "utf8")), { keyring_enabled: true },
      "the named-profile flow's global keyring preference must be left as found");
    assert.equal(reader(treated), "synthetic-access", "the legacy reader still returns the session");
  } finally {
    rmSync(control.root, { recursive: true, force: true });
    rmSync(treated.root, { recursive: true, force: true });
  }
}

// Every platform: the refresh child opts out of the keyring explicitly, as an
// allowlisted value, and does not inherit a parent override in either direction.
for (const parentOverride of [undefined, "true"]) {
  const source = { HOME: "/synthetic-home", PATH: "/synthetic-bin", UNRELATED_DESKTOP_VALUE: "private" };
  if (parentOverride) source.CLOUDFLARE_AUTH_USE_KEYRING = parentOverride;
  const env = productRefreshEnvironment(source);
  assert.equal(env.CLOUDFLARE_AUTH_USE_KEYRING, "false",
    "the legacy refresh must pin Wrangler to the plaintext default-profile store");
  assert.equal(env.UNRELATED_DESKTOP_VALUE, undefined, "the refresh environment stays an allowlist");
}

// The display helper quotes values for the target shell and refuses names or
// lines that could smuggle a second statement into a copied command.
assert.equal(renderCommandWithEnvironment({ SAMPLE: "it's" }, "tool run", { platformName: "linux" }),
  `SAMPLE='it'"'"'s' tool run`);
assert.equal(renderCommandWithEnvironment({ SAMPLE: "it's" }, "tool run", { platformName: "win32" }),
  "$env:SAMPLE='it''s'; tool run");
assert.throws(() => renderCommandWithEnvironment({ "A;B": "x" }, "tool run", { platformName: "linux" }));
assert.throws(() => renderCommandWithEnvironment({ SAMPLE: "x" }, "tool\nrun", { platformName: "linux" }));
assert.throws(() => renderCommandWithEnvironment({ SAMPLE: "x\n" }, "tool run", { platformName: "win32" }));

console.log(process.platform === "linux"
  ? "legacy keyring opt-out: real Wrangler keeps default.toml; the paired control migrates it"
  : "legacy keyring opt-out: environment pinned; the real-dist control runs on Linux only");
