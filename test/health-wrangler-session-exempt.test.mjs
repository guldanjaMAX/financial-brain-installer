/**
 * `brain health` must never refresh or rewrite a Wrangler login.
 *
 * Health proves the Brain over HTTPS with the admin key, and with a saved
 * brain.domain it needs no Cloudflare account access at all. The CLI entry
 * point used to read the Wrangler session for every command outside a short
 * exemption list. A stale session then launched `npx wrangler whoami`, which
 * can rewrite the owner's login, before health ever looked at its manifest.
 *
 * The installed CLI is spawned with a stale synthetic session and a fake `npx`
 * that records every call. A paired control on a control-plane command proves
 * the fixture really reaches the refresh, so a pass cannot come from a fixture
 * that never triggers it.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRAIN = join(ROOT, "brain.mjs");

const STALE_SESSION = [
  'oauth_token = "synthetic-stale-access"',
  'refresh_token = "synthetic-refresh"',
  'expiration_time = "2000-01-01T00:00:00.000Z"',
  "",
].join("\n");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "brain-health-wrangler-exempt-"));
  const home = join(root, "home");
  const config = join(root, "config");
  const session = join(config, ".wrangler", "config", "default.toml");
  mkdirSync(dirname(session), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(session, STALE_SESSION, { mode: 0o600 });

  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "npx-calls.log");
  // Records the call and succeeds without touching the session, so the
  // product's re-read still finds it stale and continues without a token.
  writeFileSync(join(bin, "npx"), `#!/bin/sh\necho "npx $*" >> '${log}'\nexit 0\n`);
  chmodSync(join(bin, "npx"), 0o755);
  writeFileSync(join(bin, "npx.cmd"), `@echo off\r\necho npx %* >> "${log}"\r\nexit /b 0\r\n`);

  const manifest = join(root, "brain.manifest.json");
  writeFileSync(manifest, `${JSON.stringify({
    client: { name: "Synthetic Owner", slug: "synthetic-health" },
    brain: { name: "synthetic-health", domain: "synthetic-health.invalid" },
    backend: { type: "cloudflare" },
    infrastructure: { cloudflare: { account_id: "0123456789abcdef0123456789abcdef" } },
    sources: {},
  }, null, 2)}\n`);

  // An explicit allowlist: nothing from the parent desktop environment, no
  // proxy, no Cloudflare credential, and no opt-out of the Wrangler reader.
  const env = {
    PATH: [bin, dirname(process.execPath), ...(process.platform === "win32"
      ? [join(process.env.SystemRoot || "C:\\Windows", "System32")]
      : ["/usr/bin", "/bin"])].join(delimiter),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    TMPDIR: root,
    TEMP: root,
    TMP: root,
    NO_COLOR: "1",
  };
  for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
    if (typeof process.env[name] === "string") env[name] = process.env[name];
  }
  return { root, session, log, manifest, env };
}

function runBrain(f, args) {
  return spawnSync(process.execPath, [BRAIN, ...args], {
    cwd: f.root, env: f.env, encoding: "utf8", timeout: 120_000,
  });
}

const npxCalls = (f) => (existsSync(f.log) ? readFileSync(f.log, "utf8").trim().split(/\r?\n/).filter(Boolean) : []);

const control = fixture();
const treated = fixture();
try {
  // Control: a control-plane command still reads the session at the entry
  // point, and the stale fixture makes that read launch the refresh.
  const controlRun = runBrain(control, ["verify", control.manifest]);
  assert.notEqual(controlRun.error?.code, "ETIMEDOUT", "the control command must finish");
  const controlCalls = npxCalls(control);
  assert.ok(controlCalls.length >= 1,
    "control: a stale Wrangler session must reach the fake npx refresh on a control-plane command");
  assert.match(controlCalls[0], /wrangler@[^ ]+ whoami/, "control: the refresh is a Wrangler whoami");

  // Treated: health with a saved domain.
  const healthRun = runBrain(treated, ["health", treated.manifest]);
  assert.notEqual(healthRun.error?.code, "ETIMEDOUT", "health must finish against an unreachable reserved host");
  assert.notEqual(healthRun.status, 0, "an unreachable reserved host cannot pass health");
  assert.deepEqual(npxCalls(treated), [], "health must not launch any npx or Wrangler process");
  assert.equal(readFileSync(treated.session, "utf8"), STALE_SESSION,
    "health must leave the saved Wrangler session byte-identical");
  const output = `${healthRun.stdout}\n${healthRun.stderr}`;
  assert.match(output, /synthetic-health\.invalid/, "health must take its Cloudflare-free path to the saved domain");
  assert.doesNotMatch(output, /synthetic-stale-access|synthetic-refresh/, "no session value may reach output");

  // Without a saved domain health cannot find the Brain, and it says so
  // instead of sending the owner to a browser sign-in it will never read.
  const saved = JSON.parse(readFileSync(treated.manifest, "utf8"));
  delete saved.brain.domain;
  writeFileSync(treated.manifest, `${JSON.stringify(saved, null, 2)}\n`);
  const noDomainRun = runBrain(treated, ["health", treated.manifest]);
  assert.notEqual(noDomainRun.status, 0, "health without a saved domain or credential must refuse");
  const noDomainOutput = `${noDomainRun.stdout}\n${noDomainRun.stderr}`;
  assert.match(noDomainOutput, /no saved brain\.domain/, "the refusal names the missing saved address");
  assert.match(noDomainOutput, /brain update /, "the refusal names the command that saves it");
  assert.doesNotMatch(noDomainOutput, /wrangler@[^ ]+ login/, "the refusal must not advise a sign-in health never reads");
  assert.deepEqual(npxCalls(treated), [], "the refusal must not launch any npx or Wrangler process");
  assert.equal(readFileSync(treated.session, "utf8"), STALE_SESSION, "the refusal leaves the session untouched");
} finally {
  rmSync(control.root, { recursive: true, force: true });
  rmSync(treated.root, { recursive: true, force: true });
}

console.log("health: a stale Wrangler session is never refreshed; the control-plane control still refreshes");
