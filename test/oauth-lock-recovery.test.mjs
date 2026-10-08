import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cmdConnect, supportErrorCode } from "../brain.mjs";
import { acquireSourceIngestLock, sourceIngestLockPath } from "../operations/source-ingest-lock.mjs";
import { authorize } from "../connectors/google-auth.mjs";
import { ProviderOAuthError, authorizeProvider } from "../connectors/provider-oauth.mjs";
import { cliTestEnvironment } from "./helpers/cli-test-environment.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "oauth-lock-recovery-"));
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const manifest = join(root, "brain.manifest.json");
  writeFileSync(manifest, JSON.stringify({ corpora: { slack: { enabled: true } } }));
  return { root, home, manifest };
}

for (const provider of ["google", "slack"]) {
  test(`${provider} sign-in timeout is anticipated and preserves the connection`, async () => {
    const f = fixture();
    let authorizeCalls = 0;
    let saves = 0;
    let timeout = true;
    const authorize = async () => {
      authorizeCalls++;
      if (timeout) throw provider === "google"
        ? Object.assign(new Error("timed out waiting for the browser to complete sign-in"), { code: "callback_timeout" })
        : new ProviderOAuthError("slack", "callback", "timed out waiting for sign-in", { code: "callback_timeout" });
      return { access_token: "fixture-access", refresh_token: "fixture-refresh" };
    };
    const options = {
      argv: [process.execPath, "brain.mjs", "connect", provider, f.manifest],
      env: { GOOGLE_CLIENT_ID: "fixture-client" },
      sourceIngestLockOptions: { home: f.home },
      loadGoogleTokens: () => ({}), saveGoogleTokens: () => { saves++; },
      authorizeGoogle: authorize, fetchConnectedAccountEmail: async () => null,
      tokenStorageDescription: () => "fixture protected store",
      providerOptions: {
        quiet: true, sourceIngestLockOptions: { home: f.home },
        credentials: { clientId: "fixture-client", clientSecret: "fixture-secret" },
        oauth: {
          providerOAuthConfig: () => ({ label: "Slack", clientSecretRequired: true }),
          PROVIDER_DEFAULT_PORT: 47812,
          providerRedirectUri: () => "http://127.0.0.1:47812",
          loadProviderCredentials: () => null,
          authorizeProvider: async () => { const value = await authorize(); saves++; return value; },
          providerCredentialDescription: () => "fixture protected store",
        },
      },
    };
    try {
      const connect = () => cmdConnect(provider, options);
      await assert.rejects(connect(), (error) => {
        assert.equal(authorizeCalls, 1, "the authorization decision was reached");
        assert.equal(error.constructor.name, "Fatal");
        assert.match(error.message, /sign-in timed out/i);
        assert.match(error.message, /nothing changed/i);
        assert.match(error.message, /same command again/i);
        assert.equal(supportErrorCode(error, { command: "connect" }), "OAUTH_SIGN_IN_TIMEOUT");
        return true;
      });
      assert.equal(saves, 0);
      timeout = false;
      await connect();
      assert.equal(authorizeCalls, 2);
      assert.equal(saves, 1, "successful sign-in is the green control");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

for (const mutation of ["none", "host", "user", "legacy", "malformed", "empty", "active"]) {
  test(`source lock recovery requires positive ownership proof: ${mutation}`, async () => {
    const f = fixture();
    const parameters = { sourceName: "google", sharedRecord: "provider:google", home: f.home };
    const holder = acquireSourceIngestLock(parameters);
    const path = sourceIngestLockPath(parameters);
    const ownerPath = join(path, readdirSync(path)[0]);
    const original = readFileSync(ownerPath, "utf8");
    const owner = JSON.parse(original);
    let probes = 0;
    let recovered = 0;
    let entered = 0;
    try {
      if (mutation === "host") owner.host = "0".repeat(64);
      if (mutation === "user") owner.user = "0".repeat(64);
      if (mutation === "legacy") { delete owner.host; delete owner.user; }
      if (mutation === "empty") rmSync(ownerPath);
      else writeFileSync(ownerPath, mutation === "malformed" ? "{" : JSON.stringify(owner), { mode: 0o600 });
      // Fresh dead owners recover immediately. Age never grants authority to
      // remove a foreign, ambiguous, malformed, ownerless, or active lease.
      if (mutation !== "none") {
        const old = new Date("2000-01-01T00:00:00.000Z");
        utimesSync(mutation === "empty" ? path : ownerPath, old, old);
      }
      const run = async () => {
        const lease = acquireSourceIngestLock({ ...parameters,
          isOwnerAlive: () => { probes++; return mutation === "active"; },
          onRecovered: () => { recovered++; },
        });
        try { entered++; lease.assertOwned(); } finally { lease.release(); }
      };
      if (mutation === "none") {
        await run();
        assert.ok(probes >= 2);
        assert.equal(recovered, 1);
        assert.equal(entered, 1);
        assert.equal(holder.release(), false);
      } else {
        await assert.rejects(run, /already running|malformed|unsafe|ownership/i);
        assert.equal(recovered, 0);
        assert.equal(entered, 0);
        assert.deepEqual(readdirSync(path), mutation === "empty" ? [] : [ownerPath.split(/[\\/]/).at(-1)]);
        if (mutation === "active") assert.ok(probes > 0, "liveness decision was reached");
        // Restore the known fixture owner, then prove this same lease is
        // recoverable with matched identity and a proven-dead process.
        writeFileSync(ownerPath, original, { mode: 0o600 });
        const control = acquireSourceIngestLock({ ...parameters, isOwnerAlive: () => false });
        assert.equal(control.assertOwned(), true);
        control.release();
      }
    } finally { holder.release(); rmSync(f.root, { recursive: true, force: true }); }
  });
}

test("a killed CLI connect is reclaimed immediately and reports recovery", async () => {
  const f = fixture();
  const cli = new URL("../brain.mjs", import.meta.url).href;
  const source = `
    import { cmdConnect } from ${JSON.stringify(cli)};
    await cmdConnect("google", {
      argv: [process.execPath, "brain.mjs", "connect", "google"],
      env: { GOOGLE_CLIENT_ID: "fixture-client" },
      sourceIngestLockOptions: { home: process.env.HOME },
      loadGoogleTokens: () => ({}),
      authorizeGoogle: async () => { process.stdout.write("AUTH_READY\\n"); await new Promise(() => { setInterval(() => {}, 1000); }); },
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    env: { HOME: f.home, BRAIN_NO_WRANGLER_LOGIN: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("connect fixture did not reach authorization")), 10_000);
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("AUTH_READY")) { clearTimeout(timer); resolve(); }
      });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("connect fixture exited before authorization")); });
    });
    let authorizations = 0;
    let recovered = 0;
    const options = {
      argv: [process.execPath, "brain.mjs", "connect", "google"],
      env: { GOOGLE_CLIENT_ID: "fixture-client" },
      sourceIngestLockOptions: { home: f.home, onRecovered: () => { recovered++; } },
      loadGoogleTokens: () => ({}),
      authorizeGoogle: async () => { authorizations++; return { access_token: "fixture-access", refresh_token: "fixture-refresh" }; },
      fetchConnectedAccountEmail: async () => null,
      saveGoogleTokens: () => {}, tokenStorageDescription: () => "fixture protected store",
    };
    await assert.rejects(cmdConnect("google", options), /already running/);
    assert.equal(authorizations, 0);
    assert.equal(recovered, 0);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    await cmdConnect("google", options);
    assert.equal(authorizations, 1);
    assert.equal(recovered, 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("real Google and provider callback timers carry a typed timeout", async () => {
  let decisions = 0;
  for (const ceremony of [
    () => authorize({ clientId: "fixture-client", scopes: ["fixture-scope"], port: 0, open: false, timeoutMs: 1 }),
    () => authorizeProvider("slack", { clientId: "fixture-client", clientSecret: "fixture-secret", port: 0, open: false, timeoutMs: 1, log: () => {} }),
  ]) {
    await assert.rejects(ceremony(), (error) => { decisions++; assert.equal(error.code, "callback_timeout", error.message); return true; });
  }
  assert.equal(decisions, 2);
});


test("executable connect renders timeout recovery; regression mutation is red and successful sign-in is green", () => {
  const f = fixture();
  const hook = join(f.root, "provider-hook.mjs");
  const events = join(f.root, "decisions.txt");
  function installFixtureHooks() {
    registerHooks({ load(url, context, next) {
      const result = next(url, context);
      if (!url.endsWith("/connectors/google-auth.mjs") && !url.endsWith("/brain.mjs")) return result;
      let source = String(result.source).replace(/\r?\n/g, process.env.FIXTURE_NEWLINE === "crlf" ? "\r\n" : "\n");
      if (url.endsWith("/connectors/google-auth.mjs")) {
        source = 'import { appendFileSync as recordFixtureDecision } from "node:fs";\n' + source;
        const inject = (name, code) => {
          const pattern = new RegExp('export (?:async )?function ' + name + '\\([^\\n]*\\{\\r?\\n');
          if (!pattern.test(source)) throw new Error("fixture injection point missing");
          source = source.replace(pattern, (header) => header + code + '\n');
        };
        inject("loadTokens", 'return { google: { client_id: "fixture-client" } };');
        inject("saveTokens", 'recordFixtureDecision(process.env.FIXTURE_EVENTS, "save\\n"); return;');
        inject("fetchConnectedAccountEmail", 'return null;');
        inject("tokenStorageDescription", 'return "fixture protected store";');
        inject("authorize", 'recordFixtureDecision(process.env.FIXTURE_EVENTS, "authorize\\n"); if (process.env.FIXTURE_MODE !== "success") throw Object.assign(new Error("fixture callback timeout"), { code: "callback_timeout" }); return { access_token: "fixture-access", refresh_token: "fixture-refresh" };');
      } else if (process.env.FIXTURE_MODE === "regression") {
        const match = 'if (error?.code === "callback_timeout") {';
        if (!source.includes(match)) throw new Error("fixture mutation point missing");
        source = source.replace(match, 'if (false) {');
      }
      return { ...result, source };
    }});
  }
  writeFileSync(hook, 'import { registerHooks } from "node:module";\n(' + installFixtureHooks.toString() + ')();\n');
  try {
    for (const newline of ["lf", "crlf"]) for (const mode of ["regression", "timeout", "success"]) {
      writeFileSync(events, "");
      const child = spawnSync(process.execPath, [
        "--import", new URL("./fixtures/cli-side-effect-tripwire.mjs", import.meta.url).href,
        "--import", new URL("./fixtures/isolate-support-root.mjs", import.meta.url).href,
        "--import", new URL("./fixtures/support-journal-acl-preload.mjs", import.meta.url).href,
        // A raw Windows path such as C:\... is read as a URL scheme by --import.
        "--import", pathToFileURL(hook).href, fileURLToPath(new URL("../brain.mjs", import.meta.url)), "connect", "google",
      ], {
        encoding: "utf8",
        timeout: 20_000,
        env: cliTestEnvironment(f.home, { FIXTURE_EVENTS: events, FIXTURE_MODE: mode, FIXTURE_NEWLINE: newline }),
      });
      assert.doesNotMatch(child.stderr, /TEST_SIDE_EFFECT_BLOCKED/);
      const decisions = readFileSync(events, "utf8").trim().split("\n");
      assert.deepEqual(decisions, mode === "success" ? ["authorize", "save"] : ["authorize"], child.stderr.match(/^(?:[A-Za-z]*Error): .*/m)?.[0] || child.stdout.replace(/\x1b\[[0-9;]*m/g, "").split("\n").find(line => /fail|unexpected/.test(line)));
      assert.equal(child.status, mode === "success" ? 0 : 1);
      if (mode === "regression") assert.match(child.stdout, /bug in the installer/);
      if (mode === "timeout") {
        assert.match(child.stdout, /sign-in timed out/);
        assert.match(child.stdout, /Nothing changed/);
        assert.match(child.stdout, /same command again/);
        assert.doesNotMatch(child.stdout, /bug in the installer|connection dropped/);
      }
      if (mode === "success") assert.match(child.stdout, /connected/);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

// The non-rotating arm uses a provider whose token response omits refresh_token,
// matching Google's refresh semantics without using a native credential store.
import * as renewalOAuth from "../connectors/provider-oauth.mjs";
import { saveTokens } from "../connectors/google-auth.mjs";
import { cmdIngestProvider } from "../brain.mjs";
import { providerJson } from "../connectors/provider-sync.mjs";

const renewalNow = 1_800_000_000_000;
const renewalJson = (data, status = 200) => new Response(JSON.stringify(data), { status });
// Deterministic protected-store double, also usable by a crash fixture child.
// No native ACL or DPAPI command is launched on Windows.
function renewalFileStorage(home) {
  if (process.platform !== "win32") return { backend: "file", platform: "linux", home };
  return { backend: "file", platform: "win32", home, username: "fixture-user",
    environment: { SystemRoot: "C:\\Windows", USERNAME: "fixture-user" },
    runAcl: () => ({ status: 0, stdout: "", stderr: "" }),
    runPowerShell: (_command, _args, options) => ({ status: 0,
      stdout: Buffer.from(options.input).map(value => value ^ 0x5a), stderr: Buffer.alloc(0) }),
  };
}
async function connectedRenewalFixture(provider, storageFactory = renewalFileStorage) {
  const f = fixture();
  const manifest = { corpora: { [provider]: { enabled: true, environment: "sandbox" } } };
  writeFileSync(f.manifest, JSON.stringify(manifest));
  const storage = storageFactory(f.home);
  let ceremonies = 0;
  const oauth = { ...renewalOAuth,
    providerAccessToken: (key, options) => renewalOAuth.providerAccessToken(key, { ...options, now: renewalNow }),
    authorizeProvider: async (key, options) => {
      ceremonies++;
      const candidate = { client_id: "fixture-client", client_secret: "fixture-secret",
        access_token: "fixture-access-before", refresh_token: "fixture-refresh-before",
        expires_at: renewalNow + 3_600_000, provider_metadata: { realm_id: "fixture-company" } };
      const record = { ...(options.prepareConnection ? options.prepareConnection(candidate) : candidate), provider: key, schema_version: 1 };
      saveTokens({ connection: record, ...(key === "quickbooks" ? {
        quickbooks_source_bindings: { schema_version: 1, sources: record.quickbooks_binding.sources },
      } : {}) }, renewalOAuth.providerCredentialOptions(key, storage));
      return record;
    },
  };
  const connect = () => cmdConnect(provider, {
    argv: [process.execPath, "brain.mjs", "connect", provider, f.manifest],
    providerOptions: { quiet: true, environment: {}, oauth, storage,
      sourceIngestLockOptions: { home: f.home },
      credentials: { clientId: "fixture-client", clientSecret: "fixture-secret" } },
  });
  await connect();
  assert.equal(ceremonies, 1, "real connect dispatcher reached the injected authorization and durable save");
  const binding = provider === "quickbooks" ? { source: provider, environment: "sandbox" } : null;
  return { ...f, storage, oauth, binding, connect,
    ingest: (fetchImpl) => cmdIngestProvider(manifest, f.manifest, { from: provider, "dry-run": true }, {
      oauth, storage, fetchImpl,
      sync: async ({ accessToken, fetchImpl }) => {
        await providerJson(provider, "https://provider.invalid/data", { accessToken, fetchImpl });
        return { documents: [], deletions: [] };
      },
    }),
    access: (options = {}) => renewalOAuth.providerAccessToken(provider, {
      storage, now: renewalNow, quickBooksBinding: binding, ...options,
    }),
  };
}

for (const provider of ["quickbooks", "slack"]) {
  for (const repeated of [false, true]) test(`${provider}: connected unexpired token gets one 401 renewal and one retry${repeated ? "; repeated 401 requires sign-in" : ""}`, async () => {
    const f = await connectedRenewalFixture(provider);
    let dataCalls = 0, renewals = 0;
    const fetchImpl = async (url, init) => {
      if (String(url) === renewalOAuth.providerOAuthConfig(provider).tokenUrl) {
        renewals++;
        return renewalJson({ access_token: "fixture-access-after", expires_in: 3600,
          ...(provider === "quickbooks" ? { refresh_token: "fixture-refresh-after" } : {}) });
      }
      assert.equal(String(url), "https://provider.invalid/data");
      dataCalls++;
      const authorization = new Headers(init.headers).get("authorization");
      assert.ok(authorization === `Bearer fixture-access-${dataCalls === 1 ? "before" : "after"}`, "retry uses renewed access");
      return renewalJson({ ok: !repeated }, dataCalls === 1 || repeated ? 401 : 200);
    };
    try {
      if (repeated) {
        await assert.rejects(f.ingest(fetchImpl), /sign in again/i);
        assert.equal(dataCalls, 2, "both provider authorization decisions reached");
        assert.equal(renewals, 1);
        let replayCalls = 0;
        await assert.rejects(f.access({ fetchImpl: async () => { replayCalls++; throw new Error("unexpected replay"); } }), /sign in again|reconnect/i);
        assert.equal(replayCalls, 0, "durable fence stops later reuse");
        await f.connect();
        dataCalls = 0; renewals = 0;
        await f.ingest(async (url, init) => String(url) === "https://provider.invalid/data"
          ? (dataCalls++, renewalJson({ ok: true })) : fetchImpl(url, init));
        assert.equal(dataCalls, 1, "successful reconnect and 200 are the green control");
        assert.equal(renewals, 0);
      } else {
        await f.ingest(fetchImpl);
        assert.equal(dataCalls, 2);
        assert.equal(renewals, 1, "expiry was still in the future; 401 forced renewal");
        assert.ok(renewalOAuth.loadProviderCredentials(provider, f.storage).refresh_token ===
          (provider === "quickbooks" ? "fixture-refresh-after" : "fixture-refresh-before"));
      }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  for (const faultPhase of ["replacement", "fence-clear"]) test(`${provider}: ${faultPhase} verification failure retains newest refresh and reconnect fence`, async () => {
    const f = await connectedRenewalFixture(provider);
    let faults = 0, renewals = 0;
    const fetchImpl = async () => {
      renewals++;
      return renewalJson({ access_token: "fixture-access-after", expires_in: 3600,
        ...(provider === "quickbooks" ? { refresh_token: "fixture-refresh-after" } : {}) });
    };
    const storage = { ...f.storage, readFileForVerification: (_path, descriptor, phase) => {
      const bytes = readFileSync(descriptor);
      const record = phase === "persisted" ? renewalOAuth.loadProviderCredentials(provider, f.storage) : null;
      const fenced = Boolean(record?.quickbooks_refresh_fence || record?.oauth_refresh_fence);
      if (phase === "persisted" && record?.access_token === "fixture-access-after" &&
          (faultPhase === "replacement" || !fenced)) {
        faults++;
        return Buffer.from("{}");
      }
      return bytes;
    } };
    try {
      await assert.rejects(f.access({ storage, now: renewalNow + 3_600_000, fetchImpl }), /newest.*retained.*sign in again/i);
      assert.equal(renewals, 1);
      assert.ok(faults > 0, "post-replacement verification decision reached");
      const record = renewalOAuth.loadProviderCredentials(provider, f.storage);
      assert.ok(record.refresh_token === (provider === "quickbooks" ? "fixture-refresh-after" : "fixture-refresh-before"), "never restore the consumed refresh token");
      assert.ok(record.access_token === "fixture-access-after");
      assert.ok(record.quickbooks_refresh_fence || record.oauth_refresh_fence);
      await assert.rejects(f.access({ fetchImpl }), /reconnect|sign in again/i);
      assert.equal(renewals, 1, "fenced durable record cannot trigger another exchange");
      await f.connect();
      await f.access({ now: renewalNow + 3_600_000, fetchImpl });
      assert.equal(renewals, 2, "same renewal without the injected fault is green");
      const control = renewalOAuth.loadProviderCredentials(provider, f.storage);
      assert.ok(!control.quickbooks_refresh_fence && !control.oauth_refresh_fence);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

for (const provider of ["quickbooks", "slack"]) {
  test(`${provider}: racing expired-token and forced-401 renewals share one exchange`, async () => {
    const f = await connectedRenewalFixture(provider);
    let requests = 0;
    const fetchImpl = async () => {
      requests++;
      await new Promise(resolve => setImmediate(resolve));
      return renewalJson({ access_token: "fixture-access-after", expires_in: 3600,
        ...(provider === "quickbooks" ? { refresh_token: "fixture-refresh-after" } : {}) });
    };
    try {
      for (const forced of [false, true]) {
        if (forced) await f.connect();
        requests = 0;
        const options = { fetchImpl, ...(forced ? { rejectedAccessToken: "fixture-access-before" }
          : { now: renewalNow + 3_600_000 }) };
        const results = await Promise.all([f.access(options), f.access(options)]);
        assert.equal(requests, 1, "both renewal callers reached the same durable record");
        assert.ok(results.every(result => result.accessToken === "fixture-access-after"));
        const record = renewalOAuth.loadProviderCredentials(provider, f.storage);
        assert.ok(!record.quickbooks_refresh_fence && !record.oauth_refresh_fence);
      }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  for (const crashAt of ["request-sent", "replacement-committed"]) test(`${provider}: process death at ${crashAt} leaves a durable reconnect fence`, async () => {
    const f = await connectedRenewalFixture(provider);
    const moduleUrl = new URL("../connectors/provider-oauth.mjs", import.meta.url).href;
    const script = `
      import { renameSync, readFileSync } from "node:fs";
      import { providerAccessToken, loadProviderCredentials } from ${JSON.stringify(moduleUrl)};
      const makeStorage = ${renewalFileStorage.toString()};
      const storage = { ...makeStorage(process.env.HOME),
        renameFile: (from, to) => {
          renameSync(from, to);
          if (process.env.FIXTURE_CRASH === "replacement-committed" &&
              loadProviderCredentials(process.env.FIXTURE_PROVIDER, storage)?.access_token === "fixture-access-after") {
            process.stdout.write("REPLACEMENT_COMMITTED\\n");
            process.exit(77);
          }
        },
      };
      await providerAccessToken(process.env.FIXTURE_PROVIDER, {
        storage, now: ${renewalNow + 3_600_000},
        quickBooksBinding: { source: "quickbooks", environment: "sandbox" },
        fetchImpl: async () => {
          process.stdout.write("REQUEST_SENT\\n");
          if (process.env.FIXTURE_CRASH === "request-sent") process.exit(77);
          return new Response(JSON.stringify({ access_token: "fixture-access-after", expires_in: 3600,
            ...(process.env.FIXTURE_PROVIDER === "quickbooks" ? { refresh_token: "fixture-refresh-after" } : {}) }));
        },
      });
    `;
    try {
      const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
        env: { HOME: f.home, BRAIN_NO_WRANGLER_LOGIN: "1", FIXTURE_PROVIDER: provider, FIXTURE_CRASH: crashAt },
        encoding: "utf8", timeout: 15_000,
      });
      assert.equal(child.status, 77, "fixture process must reach its abrupt exit without transaction cleanup");
      assert.match(child.stdout, /REQUEST_SENT/);
      if (crashAt === "replacement-committed") assert.match(child.stdout, /REPLACEMENT_COMMITTED/);
      const record = renewalOAuth.loadProviderCredentials(provider, f.storage);
      assert.ok(record.quickbooks_refresh_fence || record.oauth_refresh_fence);
      assert.ok(record.refresh_token === (provider === "quickbooks" && crashAt === "replacement-committed"
        ? "fixture-refresh-after" : "fixture-refresh-before"));
      // The separate credential lock retains its existing age threshold. Only
      // fixture residue is aged, and the real liveness probe proves death.
      const lock = renewalOAuth.providerRefreshLockPath(provider, f.storage);
      for (const entry of readdirSync(lock)) utimesSync(join(lock, entry), new Date(0), new Date(0));
      let calls = 0;
      const fetchImpl = async () => { calls++; return renewalJson({ access_token: "fixture-control-access", expires_in: 3600,
        ...(provider === "quickbooks" ? { refresh_token: "fixture-control-refresh" } : {}) }); };
      await assert.rejects(f.access({ fetchImpl }), /reconnect|sign in again/i);
      assert.equal(calls, 0, "the reached, durable uncertainty fence prevents replay");
      await f.connect();
      await f.access({ now: renewalNow + 3_600_000, fetchImpl });
      assert.equal(calls, 1, "fresh sign-in restores usable renewal");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

for (const provider of ["quickbooks", "slack"]) test(`${provider}: Keychain descriptor readback failure retains the newest complete generation`, async () => {
  const values = new Map();
  const account = `local-${provider}-connection`;
  let armed = false, faults = 0, exchanges = 0;
  const storageFactory = home => ({ home, backend: "keychain", platform: "darwin", environment: {},
    runSecurity: (args, options) => {
      const key = args[args.indexOf("-a") + 1];
      if (args[0] === "add-generic-password") {
        values.set(key, String(options.input).replace(/\n$/, ""));
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "delete-generic-password") {
        values.delete(key);
        return { status: 0, stdout: "", stderr: "" };
      }
      assert.equal(args[0], "find-generic-password");
      if (!values.has(key)) return { status: 44, stdout: "", stderr: "" };
      if (armed && key === account && args.includes("-w")) {
        const descriptor = JSON.parse(values.get(account));
        const encoded = Array.from({ length: descriptor.n }, (_, i) =>
          values.get(`${account}.${descriptor.g}.${String(i).padStart(4, "0")}`) || "").join("");
        const record = JSON.parse(Buffer.from(encoded, "base64url")).connection;
        if (record.access_token === "fixture-access-after") {
          faults++; armed = false;
          return { status: 1, stdout: "", stderr: "fixture readback failure" };
        }
      }
      return { status: 0, stdout: args.includes("-w") ? values.get(key) : "present", stderr: "" };
    },
  });
  const f = await connectedRenewalFixture(provider, storageFactory);
  const fetchImpl = async () => { exchanges++; return renewalJson({ access_token: "fixture-access-after", expires_in: 3600,
    ...(provider === "quickbooks" ? { refresh_token: "fixture-refresh-after" } : {}) }); };
  try {
    armed = true;
    await assert.rejects(f.access({ now: renewalNow + 3_600_000, fetchImpl }), /newest.*retained.*sign in again/i);
    assert.equal(faults, 1, "failure occurs after the active descriptor was replaced");
    assert.equal(exchanges, 1);
    const retained = renewalOAuth.loadProviderCredentials(provider, f.storage);
    assert.ok(retained.access_token === "fixture-access-after");
    assert.ok(retained.refresh_token === (provider === "quickbooks" ? "fixture-refresh-after" : "fixture-refresh-before"));
    assert.ok(retained.quickbooks_refresh_fence || retained.oauth_refresh_fence);
    assert.equal(renewalOAuth.providerCredentialStatus(provider, f.storage).connected, false);
    await assert.rejects(f.access({ fetchImpl }), /reconnect|sign in again/i);
    assert.equal(exchanges, 1);
    await f.connect();
    await f.access({ now: renewalNow + 3_600_000, fetchImpl });
    assert.equal(exchanges, 2, "verified Keychain generation is the green control");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const provider of ["quickbooks", "slack"]) test(`${provider}: CLI 401 recovery explains retained token on verification failure`, async () => {
  const f = await connectedRenewalFixture(provider);
  let requests = 0, exchanges = 0, faults = 0;
  f.storage.readFileForVerification = (_path, descriptor, phase) => {
    const bytes = readFileSync(descriptor);
    if (phase === "persisted" && renewalOAuth.loadProviderCredentials(provider, f.storage)?.access_token === "fixture-access-after") {
      faults++;
      return Buffer.from("{}");
    }
    return bytes;
  };
  const fetchImpl = async url => {
    if (String(url) === "https://provider.invalid/data") {
      requests++;
      return renewalJson({}, 401);
    }
    exchanges++;
    return renewalJson({ access_token: "fixture-access-after", expires_in: 3600,
      ...(provider === "quickbooks" ? { refresh_token: "fixture-refresh-after" } : {}) });
  };
  try {
    await assert.rejects(f.ingest(fetchImpl), error => {
      assert.equal(error.constructor.name, "Fatal");
      assert.equal(supportErrorCode(error, { command: "ingest" }), "AUTH_EXPIRED");
      assert.match(error.message, /newest.*retained.*sign in again/i);
      return true;
    });
    assert.equal(requests, 1, "unverified renewal never reaches the data retry");
    assert.equal(exchanges, 1);
    assert.equal(faults, 1);
    delete f.storage.readFileForVerification;
    assert.equal(renewalOAuth.providerCredentialStatus(provider, f.storage).connected, false);
    await f.connect();
    await f.ingest(async () => { requests++; return renewalJson({}); });
    assert.equal(requests, 2, "verified reconnect is usable through the same CLI path");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const provider of ["quickbooks", "slack"]) test(`${provider}: cancellation during renewal cannot replay data or start another renewal`, async () => {
  const f = await connectedRenewalFixture(provider);
  let requests = 0, renewals = 0;
  const controller = new AbortController();
  const fetchImpl = async url => {
    if (String(url) === "https://provider.invalid/data") {
      requests++;
      return renewalJson({}, requests === 1 ? 401 : 200);
    }
    renewals++;
    controller.abort();
    return renewalJson({ access_token: "fixture-access-after", expires_in: 3600,
      ...(provider === "quickbooks" ? { refresh_token: "fixture-refresh-after" } : {}) });
  };
  const wrapped = renewalOAuth.providerDataFetch(provider, { accessToken: "fixture-access-before",
    storage: f.storage, fetchImpl,
    resolveAccess: rejectedAccessToken => f.access({ rejectedAccessToken, fetchImpl }),
  });
  try {
    await assert.rejects(wrapped("https://provider.invalid/data", {
      headers: { authorization: "Bearer fixture-access-before" }, signal: controller.signal,
    }), /sign in again/);
    assert.equal(renewals, 1, "cancellation was injected during the reached token exchange");
    assert.equal(requests, 1, "no data replay after cancellation");
    await assert.rejects(wrapped("https://provider.invalid/data", {
      headers: { authorization: "Bearer fixture-access-before" },
    }), /sign in again/);
    assert.equal(requests, 1, "a transport retry cannot reset the renewal budget");
    await f.ingest(async () => { requests++; return renewalJson({}); });
    assert.equal(requests, 2, "a separate command can use the verified replacement");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("provider aliases keep the reconnect fence visible to credential status", async () => {
  const f = await connectedRenewalFixture("quickbooks");
  try {
    for (const provider of ["quickbooks", "QUICKBOOKS"]) {
      await f.connect();
      let requests = 0, exchanges = 0;
      const fetchImpl = async url => {
        if (String(url) === "https://provider.invalid/data") { requests++; return renewalJson({}, 401); }
        exchanges++;
        return renewalJson({ access_token: "fixture-access-after", refresh_token: "fixture-refresh-after", expires_in: 3600 });
      };
      const wrapped = renewalOAuth.providerDataFetch(provider, { accessToken: "fixture-access-before",
        storage: f.storage, fetchImpl,
        resolveAccess: rejectedAccessToken => f.access({ rejectedAccessToken, fetchImpl }),
      });
      await assert.rejects(wrapped("https://provider.invalid/data", {
        headers: { authorization: "Bearer fixture-access-before" },
      }), /sign in again/);
      assert.equal(requests, 2);
      assert.equal(exchanges, 1);
      assert.equal(renewalOAuth.providerCredentialStatus("quickbooks", f.storage).connected, false);
    }
    await f.connect();
    let successfulReads = 0;
    await f.ingest(async () => { successfulReads++; return renewalJson({}); });
    assert.equal(successfulReads, 1, "fresh sign-in clears the canonical fence");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("supplied Microsoft access preflight never reaches credential lookup", async () => {
  const f = fixture();
  let lookups = 0, decisions = 0;
  const storage = { home: f.home, backend: "keychain", platform: "darwin", environment: {},
    runSecurity: () => { lookups++; return { status: 44, stdout: "", stderr: "" }; },
  };
  const connection = { access_token: "fixture-access", expires_at: renewalNow + 3_600_000,
    scopes: ["Mail.Read"] };
  try {
    await assert.rejects(renewalOAuth.providerAccessToken("microsoft", {
      connection, storage, now: renewalNow,
    }), error => { decisions++; return error.code === "reconsent_required"; });
    assert.equal(decisions, 1, "scope refusal decision was reached");
    assert.equal(lookups, 0, "supplied metadata is enough to refuse without credentials");
    const access = await renewalOAuth.providerAccessToken("microsoft", {
      connection: { ...connection, scopes: [...connection.scopes, "Calendars.Read"] }, storage, now: renewalNow,
    });
    assert.ok(access.accessToken === connection.access_token, "fresh approved supplied access is the green control");
    assert.equal(lookups, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
