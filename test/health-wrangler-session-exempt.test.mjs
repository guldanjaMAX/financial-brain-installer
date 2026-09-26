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
 *
 * The exemption is conditional. Without a saved brain.domain, health finds the
 * Brain by a read-only workers.dev lookup through the owner's Cloudflare
 * session, and `brain update` never writes brain.domain, so a blanket exemption
 * sent the owner around a loop. Such a manifest keeps the session read, and
 * only a manifest with no domain and no Cloudflare access at all is refused.
 * Cloudflare is never contacted: a preloaded fetch stub answers the lookup.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cmdHealth, runCliCommandWithCredentialBoundary, supportErrorCode } from "../brain.mjs";
import { renderCliCommands } from "../operations/cli-guidance.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRAIN = join(ROOT, "brain.mjs");

const FRESH_SESSION = [
  'oauth_token = "synthetic-fresh-access"',
  'refresh_token = "synthetic-refresh"',
  'expiration_time = "2999-01-01T00:00:00.000Z"',
  "",
].join("\n");

// Stands in for Cloudflare so the lookup path is exercised without a live
// service: it answers the account and workers.dev subdomain reads, records
// only the method, host, path and whether the session token was presented,
// and refuses every other host as unreachable.
const FETCH_STUB = `
import { appendFileSync } from "node:fs";
const log = process.env.SYNTHETIC_FETCH_LOG;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const auth = new Headers(init.headers || {}).get("authorization");
  appendFileSync(log, JSON.stringify({
    method: init.method || "GET", host: url.host, path: url.pathname,
    session_token: auth === "Bearer synthetic-fresh-access",
  }) + "\\n");
  const ok = (result) => new Response(JSON.stringify({ success: true, errors: [], result }),
    { status: 200, headers: { "content-type": "application/json" } });
  if (url.host === "api.cloudflare.com" && url.pathname === "/client/v4/accounts") {
    return ok([{ id: "0123456789abcdef0123456789abcdef", name: "Synthetic Account" }]);
  }
  if (url.host === "api.cloudflare.com" &&
      url.pathname === "/client/v4/accounts/0123456789abcdef0123456789abcdef/workers/subdomain") {
    return ok({ subdomain: "synthetic-sub" });
  }
  throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) });
};
`;

const STALE_SESSION = [
  'oauth_token = "synthetic-stale-access"',
  'refresh_token = "synthetic-refresh"',
  'expiration_time = "2000-01-01T00:00:00.000Z"',
  "",
].join("\n");

function fixture({ session: sessionText = STALE_SESSION, domain = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "brain-health-wrangler-exempt-"));
  const home = join(root, "home");
  const config = join(root, "config");
  const session = join(config, ".wrangler", "config", "default.toml");
  mkdirSync(dirname(session), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(session, sessionText, { mode: 0o600 });

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
    brain: domain
      ? { name: "synthetic-health", domain: "synthetic-health.invalid" }
      : { name: "synthetic-health" },
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
  const fetchLog = join(root, "fetch-calls.log");
  const preload = join(root, "fetch-stub.mjs");
  writeFileSync(preload, FETCH_STUB);
  env.SYNTHETIC_FETCH_LOG = fetchLog;
  env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
  return { root, session, log, fetchLog, manifest, env };
}

function runBrain(f, args) {
  return spawnSync(process.execPath, [BRAIN, ...args], {
    cwd: f.root, env: f.env, encoding: "utf8", timeout: 120_000,
  });
}

const fetchCalls = (f) => (existsSync(f.fetchLog)
  ? readFileSync(f.fetchLog, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  : []);
const npxCalls = (f) => (existsSync(f.log) ? readFileSync(f.log, "utf8").trim().split(/\r?\n/).filter(Boolean) : []);

// The dispatcher decision itself: health skips the entry-point session only
// for a manifest with a saved brain.domain; every other manifest state keeps
// the read, and an explicitly exempt command never depends on the manifest.
{
  const decide = async (command, manifestPath) => {
    let sessionRead = false;
    await runCliCommandWithCredentialBoundary(command, () => undefined, {
      manifestPath,
      withWranglerSession: (run) => { sessionRead = true; return run(); },
    });
    return sessionRead;
  };
  const scratch = mkdtempSync(join(tmpdir(), "brain-health-boundary-"));
  try {
    const write = (name, value) => {
      const path = join(scratch, name);
      writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
      return path;
    };
    const withDomain = write("with-domain.json", { brain: { domain: "synthetic-health.invalid" } });
    const noDomain = write("no-domain.json", { brain: { name: "synthetic-health" } });
    const blankDomain = write("blank-domain.json", { brain: { domain: "   " } });
    const nonStringDomain = write("object-domain.json", { brain: { domain: { host: "x" } } });
    const unreadable = write("broken.json", "{ not json");
    assert.equal(await decide("health", withDomain), false, "health with a saved domain skips the session read");
    assert.equal(await decide("health", noDomain), true, "health without a saved domain keeps the session read");
    assert.equal(await decide("health", blankDomain), true, "a blank domain is not a saved address");
    assert.equal(await decide("health", nonStringDomain), true, "a non-string domain is not a saved address");
    assert.equal(await decide("health", unreadable), true, "an unreadable manifest keeps the pre-exemption behaviour");
    assert.equal(await decide("health", join(scratch, "missing.json")), true, "a missing manifest keeps the session read");
    assert.equal(await decide("health", undefined), true, "no manifest argument keeps the session read");
    assert.equal(await decide("verify", withDomain), true, "a control-plane command always reads the session");
    assert.equal(await decide("sources", noDomain), false, "an unconditionally exempt command stays exempt");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// In-process: with no domain and no Cloudflare access at all, the refusal is a
// typed configuration failure whose advice is true and safe.
{
  const scratch = mkdtempSync(join(tmpdir(), "brain-health-no-access-"));
  const savedToken = process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_API_TOKEN;
  try {
    const manifest = join(scratch, "brain.manifest.json");
    writeFileSync(manifest, `${JSON.stringify({
      client: { name: "Synthetic Owner", slug: "synthetic-health" },
      brain: { name: "synthetic-health" },
      infrastructure: { cloudflare: { account_id: "0123456789abcdef0123456789abcdef" } },
    })}\n`);
    let refusal = null;
    try {
      await cmdHealth(manifest, { request: () => { throw new Error("health must refuse before any request"); } });
    } catch (error) {
      refusal = error;
    }
    assert.ok(refusal, "health without a domain or Cloudflare access must refuse");
    assert.equal(refusal.code, "CONFIG_INVALID", "the refusal carries a typed configuration code");
    assert.equal(supportErrorCode(refusal, { command: "health" }), "CONFIG_INVALID",
      "the support journal classifies the refusal as configuration, not a missing sign-in");
    assertTruthfulNoAccessRefusal(renderCliCommands(refusal.message));
  } finally {
    if (savedToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = savedToken;
    rmSync(scratch, { recursive: true, force: true });
  }
}

function assertTruthfulNoAccessRefusal(text) {
  assert.match(text, /no saved brain\.domain/, "the refusal names the missing saved address");
  assert.match(text, /workers\.dev/, "the refusal says health can look the address up instead");
  assert.match(text, /BRAIN_NO_WRANGLER_LOGIN/, "the refusal names the switch that turns the session lookup off");
  assert.match(text, /CLOUDFLARE_API_TOKEN/, "the refusal names the other credential the lookup accepts");
  // Expectations go through the per-platform renderer, as the CLI output does.
  assert.ok(!text.includes(renderCliCommands("brain update")),
    "brain update never saves brain.domain, so it must not be advised");
  assert.ok(!text.includes(renderCliCommands("brain deploy")),
    "a deploy is unsafe on a paused or behind Brain and must not be advised");
  assert.doesNotMatch(text, /wrangler@[^ ]+ login/, "the refusal must not name a pinned Wrangler login command");
}

const control = fixture();
const treated = fixture();
const lookup = fixture({ session: FRESH_SESSION, domain: false });
const staleLookup = fixture({ domain: false });
const noAccess = fixture({ domain: false });
noAccess.env.BRAIN_NO_WRANGLER_LOGIN = "1";
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

  assert.deepEqual(fetchCalls(treated).filter((call) => call.host === "api.cloudflare.com"), [],
    "health with a saved domain must not contact the Cloudflare API");

  // Without a saved domain, a usable session is read at the entry point and
  // health resolves the workers.dev address through it (the behaviour before
  // the exemption), instead of refusing with advice that loops.
  const lookupRun = runBrain(lookup, ["health", lookup.manifest]);
  assert.notEqual(lookupRun.error?.code, "ETIMEDOUT", "the lookup run must finish");
  const lookupOutput = `${lookupRun.stdout}\n${lookupRun.stderr}`;
  const apiCalls = fetchCalls(lookup).filter((call) => call.host === "api.cloudflare.com");
  assert.deepEqual(apiCalls.map((call) => `${call.method} ${call.path}`), [
    "GET /client/v4/accounts",
    "GET /client/v4/accounts/0123456789abcdef0123456789abcdef/workers/subdomain",
  ], "health without a saved domain looks the address up read-only");
  assert.ok(apiCalls.every((call) => call.session_token), "the lookup uses the entry-point session");
  assert.match(lookupOutput, /synthetic-health-brain\.synthetic-sub\.workers\.dev/,
    "health probes the looked-up workers.dev address");
  assert.doesNotMatch(lookupOutput, /no saved brain\.domain/, "a usable session must not be refused");
  assert.deepEqual(npxCalls(lookup), [], "a fresh session needs no refresh");
  assert.equal(readFileSync(lookup.session, "utf8"), FRESH_SESSION, "the lookup leaves the session byte-identical");
  assert.doesNotMatch(lookupOutput, /synthetic-fresh-access|synthetic-refresh/, "no session value may reach output");
  assert.ok(!Object.hasOwn(JSON.parse(readFileSync(lookup.manifest, "utf8")).brain, "domain"),
    "health never writes the looked-up address into the manifest");

  // A stale session without a saved domain takes the same entry-point read as
  // any control-plane command; when it cannot be renewed there is no access,
  // and health refuses truthfully without contacting Cloudflare.
  const staleRun = runBrain(staleLookup, ["health", staleLookup.manifest]);
  assert.notEqual(staleRun.status, 0, "an unrenewable session leaves no access");
  assert.ok(npxCalls(staleLookup).some((call) => /wrangler@[^ ]+ whoami/.test(call)),
    "without a saved domain the entry point reads the session as it did before the exemption");
  assertTruthfulNoAccessRefusal(`${staleRun.stdout}\n${staleRun.stderr}`);
  assert.deepEqual(fetchCalls(staleLookup).filter((call) => call.host === "api.cloudflare.com"), [],
    "no Cloudflare request is made without a credential");

  // No domain and no Cloudflare access at all: the one case that still refuses.
  const noAccessRun = runBrain(noAccess, ["health", noAccess.manifest]);
  assert.notEqual(noAccessRun.status, 0, "health without a saved domain or credential must refuse");
  const noAccessOutput = `${noAccessRun.stdout}\n${noAccessRun.stderr}`;
  assertTruthfulNoAccessRefusal(noAccessOutput);
  assert.deepEqual(npxCalls(noAccess), [], "the refusal must not launch any npx or Wrangler process");
  assert.equal(readFileSync(noAccess.session, "utf8"), STALE_SESSION, "the refusal leaves the session untouched");
  assert.deepEqual(fetchCalls(noAccess), [], "the refusal makes no network request");
} finally {
  for (const f of [control, treated, lookup, staleLookup, noAccess]) {
    rmSync(f.root, { recursive: true, force: true });
  }
}

console.log("health: a saved domain never touches the Wrangler session; without one the session lookup resolves the address, and no access at all is a truthful CONFIG_INVALID refusal");
