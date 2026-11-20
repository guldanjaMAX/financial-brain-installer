import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { persistWorkersDevDomain, createSetupControlAction, withCloudflareControlCredential } from "../brain.mjs";
import { preflightCloudflareOAuthAccount, withCloudflareOAuthSession, CLOUDFLARE_OAUTH_SCOPES } from "../operations/cloudflare-oauth-session.mjs";
import { supportRecovery } from "../support-recovery.mjs";
import { SUPPORT_ERROR_CODES } from "../support-journal.mjs";

const ACCOUNT = "a".repeat(32);
const PROFILE = `financial-brain-${"b".repeat(24)}`;
const CODE = "CLOUDFLARE_WORKERS_SUBDOMAIN_REGISTER_FAILED";
const OLD_SCOPES = CLOUDFLARE_OAUTH_SCOPES.filter(scope => scope !== "workers_scripts:write");
const SCOPES = [...new Set([...CLOUDFLARE_OAUTH_SCOPES, "workers_scripts:write"])];
const apiPath = `/accounts/${ACCOUNT}/workers/subdomain`;
const missing = { status: 404, codes: [10007], message: "No subdomain registered" };
const conflict = { status: 409, codes: [10031], message: "Name is taken" };
const providerError = spec => Object.assign(new Error(spec.message), { status: spec.status, cloudflareErrorCodes: spec.codes });
const envelope = (result, spec) => spec
  ? { success: false, errors: spec.codes.map(code => ({ code, message: spec.message })), result: null }
  : { success: true, errors: [], result };
const response = (result, spec) => new Response(JSON.stringify(envelope(result, spec)), { status: spec?.status ?? 200 });
const loadModule = () => import("../operations/workers-subdomain.mjs");

function script(steps) {
  const calls = [];
  const request = async (path, options = {}) => {
    const call = { path, method: options.method || "GET", body: options.body };
    calls.push(call);
    const step = steps.shift();
    assert.ok(step, `unexpected ${call.method}`);
    assert.equal(path, apiPath);
    assert.equal(call.method, step.method || "GET");
    if (step.label) assert.equal(options.body.subdomain, step.label);
    if (step.error) throw providerError(step.error);
    return step.result ?? { subdomain: "quiet-meadow-1000" };
  };
  return { request, calls, done: () => assert.equal(steps.length, 0) };
}
async function ensure(steps, options = {}) {
  const { ensureWorkersDevSubdomain } = await loadModule();
  const fixture = script(steps);
  let sequence = 1000;
  const output = [];
  const run = () => ensureWorkersDevSubdomain({
    accountId: ACCOUNT, request: fixture.request, registrationContext: "setup",
    generateLabel: () => `quiet-meadow-${sequence++}`, writeLine: line => output.push(line), ...options,
  });
  return { ...fixture, output, run };
}

test("existing account label is read once and is never changed", async () => {
  const fixture = await ensure([{ result: { subdomain: "existing-label" } }]);
  assert.equal(await fixture.run(), "existing-label");
  assert.deepEqual(fixture.calls.map(c => c.method), ["GET"]);
  assert.deepEqual(fixture.output, []);
  fixture.done();
});
test("10007 registers a neutral address and proves exact readback before success", async () => {
  const fixture = await ensure([{ error: missing }, { method: "PUT", label: "quiet-meadow-1000" }, {}]);
  assert.equal(await fixture.run(), "quiet-meadow-1000");
  assert.deepEqual(fixture.calls.map(c => c.method), ["GET", "PUT", "GET"]);
  assert.deepEqual(fixture.output, ["✅ Web address reserved"]);
  fixture.done();
});
for (const status of [400, 409]) test(`taken name retries on provider conflict (${status}) without availability endpoint`, async () => {
  const fixture = await ensure([
    { error: missing }, { method: "PUT", error: { ...conflict, status } },
    { error: missing }, { method: "PUT", label: "quiet-meadow-1001" }, { result: { subdomain: "quiet-meadow-1001" } },
  ]);
  assert.equal(await fixture.run(), "quiet-meadow-1001");
  assert.equal(fixture.calls.filter(c => c.method === "PUT").length, 2);
  assert.ok(fixture.calls.every(c => !c.path.includes("/subdomains/")));
  fixture.done();
});
test("a concurrent account registration is returned without another PUT", async () => {
  const fixture = await ensure([{ error: missing }, { method: "PUT", error: conflict }, { result: { subdomain: "existing-label" } }]);
  assert.equal(await fixture.run(), "existing-label");
  assert.equal(fixture.calls.filter(c => c.method === "PUT").length, 1);
  assert.deepEqual(fixture.output, []);
});
for (const failure of [
  { status: 403, codes: [10000], message: "Permission denied" },
  { status: 404, codes: [10008], message: "Other missing resource" },
  { status: 500, codes: [10007], message: "Not proof of absence" },
]) test(`read refusal ${failure.status}/${failure.codes[0]} never permits a PUT`, async () => {
  const fixture = await ensure([{ error: failure }]);
  await assert.rejects(fixture.run, error => error.status === failure.status && error.code !== CODE);
  assert.deepEqual(fixture.calls.map(c => c.method), ["GET"]);
});
for (const registrationContext of [undefined, "update", "deploy"]) test(`no PUT from context ${registrationContext}`, async () => {
  const fixture = await ensure([{ error: missing }], { registrationContext });
  await assert.rejects(fixture.run, error => error.code === "CLOUDFLARE_WORKERS_SUBDOMAIN_UNREGISTERED");
  assert.deepEqual(fixture.calls.map(c => c.method), ["GET"]);
});
test("custom domain skips the entire subdomain operation", async () => {
  const fixture = await ensure([], { required: false });
  assert.equal(await fixture.run(), null);
  assert.equal(fixture.calls.length, 0);
  const control = await ensure([{}]);
  assert.equal(await control.run(), "quiet-meadow-1000");
  assert.equal(control.calls.length, 1);
});
test("PUT failure has stable code, masked provider wording, help, and no secret", async () => {
  const secret = ["fixture", "opaque", "credential"].join("-");
  const fixture = await ensure([{ error: missing }, { method: "PUT", error: { status: 403, codes: [10000], message: `Permission denied ${secret}` } }], { secrets: [secret] });
  await assert.rejects(fixture.run, error => {
    assert.equal(error.code, CODE);
    assert.match(error.message, /Permission denied/);
    assert.ok(error.message.includes(`https://financialbrain.ai/help/${CODE}`));
    assert.ok(!error.message.includes(secret));
    assert.ok(!JSON.stringify(error).includes(secret));
    return true;
  });
  assert.deepEqual(fixture.calls.map(c => c.method), ["GET", "PUT"]);
  assert.deepEqual(fixture.output, []);
});
test("a readback mismatch stops without another PUT or a success line", async () => {
  const fixture = await ensure([{ error: missing }, { method: "PUT" }, { result: { subdomain: "different-label" } }]);
  await assert.rejects(fixture.run, /readback/i);
  assert.deepEqual(fixture.calls.map(c => c.method), ["GET", "PUT", "GET"]);
  assert.deepEqual(fixture.output, []);
});
test("registration stops after at most five distinct names", async () => {
  const steps = [{ error: missing }];
  for (let i = 0; i < 5; i++) {
    steps.push({ method: "PUT", error: conflict });
    if (i < 4) steps.push({ error: missing });
  }
  const fixture = await ensure(steps);
  await assert.rejects(fixture.run, error => error.code === CODE);
  const puts = fixture.calls.filter(c => c.method === "PUT");
  assert.equal(puts.length, 5);
  assert.equal(new Set(puts.map(c => c.body.subdomain)).size, 5);
  fixture.done();
});
test("labels use only built-in words and four digits, independent of all manifest text", async () => {
  const { neutralWorkersSubdomainLabel } = await loadModule();
  const manifest = { client: { display_name: "Private Owner", slug: "private-business", email: "private@company.invalid" } };
  for (let i = 0; i < 100; i++) {
    const label = neutralWorkersSubdomainLabel();
    assert.match(label, /^[a-z]+-[a-z]+-\d{4}$/);
    for (const token of JSON.stringify(manifest).toLowerCase().split(/[^a-z]+/).filter(t => t.length > 2)) assert.ok(!label.includes(token));
  }
});
test("persist path registers a missing label and saves only a verified hostname", async () => {
  const root = mkdtempSync(join(tmpdir(), "subdomain-persist-"));
  try {
    const path = join(root, "manifest.json");
    const manifest = { client: { slug: "fixture" }, brain: {} };
    writeFileSync(path, JSON.stringify(manifest));
    let reads = 0, puts = 0, verifies = 0;
    const domain = await persistWorkersDevDomain(path, manifest, { id: ACCOUNT }, "fixture-brain", {
      readSubdomain: async () => { reads++; if (reads === 1) throw providerError(missing); return { subdomain: "quiet-meadow-1000" }; },
      registerSubdomain: async label => { puts++; assert.equal(label, "quiet-meadow-1000"); },
      generateSubdomainLabel: () => "quiet-meadow-1000",
      verifyWorkersDevCandidate: async candidate => { verifies++; assert.equal(candidate, "fixture-brain.quiet-meadow-1000.workers.dev"); return { ok: true }; },
    });
    assert.equal(puts, 1); assert.equal(reads, 2); assert.equal(verifies, 1);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).brain.domain, domain);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("setup reserves before runSetup can create anything and carries the label", async () => {
  const calls = [];
  const action = createSetupControlAction({
    readCurrentManifest: () => null, resolveSavedAccount: async () => { throw new Error("unexpected"); },
    chooseAccount: async () => ({ id: ACCOUNT }), confirmWorkersPaid: async () => calls.push("paid"),
    ensureSubdomain: async () => { calls.push("reserve"); return "quiet-meadow-1000"; },
    runSetup: async (account, session) => { calls.push("setup"); assert.equal(session.preflight.workersSubdomain, "quiet-meadow-1000"); },
  });
  await action({ method: "api_token", preflight: null });
  assert.deepEqual(calls, ["paid", "reserve", "setup"]);
});
test("OAuth setup registers through the scripted fetch while routine preflight stays read only", async () => {
  const calls = []; let registered = false;
  const token = Buffer.from(["fixture", "access", "value", "for", "tests"].join("-"));
  const fetchImpl = async (url, options) => {
    calls.push(options.method + " " + new URL(url).pathname);
    if (new URL(url).pathname.endsWith(`/accounts/${ACCOUNT}`)) return response({ id: ACCOUNT, name: "Owner account" });
    if (new URL(url).pathname.endsWith("/workers/subdomain")) {
      if (options.method === "PUT") { registered = true; return response({}); }
      return registered ? response({ subdomain: "quiet-meadow-1000" }) : response(null, missing);
    }
    return response([]);
  };
  const result = await preflightCloudflareOAuthAccount(token, { id: ACCOUNT, name: "Owner account" }, {
    fetchImpl, registrationContext: "setup", generateSubdomainLabel: () => "quiet-meadow-1000", writeLine: () => {},
  });
  assert.equal(result.workersSubdomain, "quiet-meadow-1000");
  assert.equal(calls.filter(c => c.startsWith("PUT")).length, 1);
  token.fill(0);
});
for (const { currentScopes, status, grantedScopes } of [
  { currentScopes: CLOUDFLARE_OAUTH_SCOPES, status: 403, grantedScopes: OLD_SCOPES },
  { currentScopes: OLD_SCOPES, status: 403, grantedScopes: OLD_SCOPES },
  { currentScopes: SCOPES, status: 401, grantedScopes: OLD_SCOPES },
  { currentScopes: SCOPES, status: 403, grantedScopes: SCOPES },
]) test(`profile recovery uses status and granted scopes (${currentScopes.length}/${status}/${grantedScopes.length})`, async () => {
  const events = []; let reads = 0;
  const tokenValue = ["fixture", "access", "value", "for", "tests"].join("-");
  const processRunner = (command, args) => {
    events.push(args.includes("create") ? "allow" : args.includes("whoami") ? "scopes" : args.includes("token") ? "token" : "keyring");
    const stdout = args.includes("whoami") ? { loggedIn: true, authType: "OAuth Token", tokenPermissions: grantedScopes }
      : args.includes("token") ? { type: "oauth", token: tokenValue } : {};
    if (args.includes("create")) assert.ok(args.includes("workers_scripts:write"));
    return { status: 0, stdout: Buffer.from(JSON.stringify(stdout)), stderr: Buffer.alloc(0) };
  };
  const result = await withCloudflareControlCredential(() => { events.push("action"); return "done"; }, {
    // These cases exercise token recovery; Windows deliberately has no such lane.
    platform: "linux",
    accountId: ACCOUNT, authProfile: PROFILE, interactive: true, allowBrowserReauth: true, allowTokenRecovery: true,
    askFn: async () => { events.push("token-offer"); return "y"; }, withToken: async fn => { events.push("recovery"); return fn(); },
    oauthOptions: {
      platformName: "linux",
      scopes: currentScopes, processRunner, workingDirectory: process.env.HOME, environment: { HOME: process.env.HOME },
      fetchImpl: async url => {
        const path = new URL(url).pathname;
        if (path.endsWith("/accounts")) return new Response(JSON.stringify({ ...envelope([{ id: ACCOUNT, name: "Owner account" }]), result_info: { page: 1, count: 1, total_count: 1, total_pages: 1 } }));
        if (path.endsWith(`/accounts/${ACCOUNT}`)) return response({ id: ACCOUNT, name: "Owner account" });
        if (path.endsWith("/workers/subdomain")) { reads++; return reads === 1 ? response(null, { status, codes: [10000], message: "Permission denied" }) : response({ subdomain: "existing-label" }); }
        return response([]);
      },
    },
  });
  assert.equal(result, "done"); assert.ok(reads >= 1);
  if (currentScopes.includes("workers_scripts:write") && !grantedScopes.includes("workers_scripts:write")) {
    assert.equal(reads, 2, events.join(", ")); assert.ok(events.indexOf("scopes") < events.indexOf("allow"));
    assert.ok(events.indexOf("allow") < events.indexOf("action")); assert.ok(!events.includes("token-offer"));
  } else {
    assert.ok(!events.includes("allow"));
    assert.equal(events.includes("scopes"), currentScopes.includes("workers_scripts:write"));
    assert.ok(events.includes("token-offer"));
  }
});
test("registration issue is classified and has owner guidance without Terminal steps", () => {
  assert.ok(SUPPORT_ERROR_CODES.includes(CODE));
  const guide = supportRecovery(CODE);
  assert.equal(guide.code, CODE);
  assert.match(guide.next_steps.join(" "), /Cloudflare/);
  assert.doesNotMatch(guide.next_steps.join(" "), /Terminal|brain setup|brain deploy|brain update/);
});

for (const result of [{ subdomain: "" }, { subdomain: "bad.name" }, {}]) test(`a malformed 200 cannot authorize registration (${JSON.stringify(result)})`, async () => {
  const fixture = await ensure([{ result }]);
  await assert.rejects(fixture.run, error => error.code === "CLOUDFLARE_OAUTH_RESPONSE_INVALID");
  assert.deepEqual(fixture.calls.map(c => c.method), ["GET"]);
  assert.deepEqual(fixture.output, []);
});
test("a failed reservation reaches setup's address decision but cannot start resource creation", async () => {
  const events = [];
  const failure = Object.assign(new Error("fixture reservation refusal"), { code: CODE });
  const action = createSetupControlAction({
    readCurrentManifest: () => null,
    resolveSavedAccount: async () => { throw new Error("unexpected saved account"); },
    chooseAccount: async () => ({ id: ACCOUNT }),
    confirmWorkersPaid: async () => events.push("paid"),
    ensureSubdomain: async () => { events.push("reservation"); throw failure; },
    runSetup: async () => { events.push("resource-creation"); },
  });
  await assert.rejects(action({ method: "api_token" }), error => error === failure);
  assert.deepEqual(events, ["paid", "reservation"]);
});
test("the OAuth receipt and a saved custom domain skip a second setup reservation", async () => {
  for (const manifest of [null, { brain: { domain: "brain.example.invalid" } }]) {
    let setupCalls = 0;
    const action = createSetupControlAction({
      readCurrentManifest: () => manifest, resolveSavedAccount: async () => ({ id: ACCOUNT }),
      chooseAccount: async () => ({ id: ACCOUNT }), confirmWorkersPaid: async () => {},
      ensureSubdomain: async () => { throw new Error("an unnecessary reservation must not run"); },
      runSetup: async () => { setupCalls++; },
    });
    await action({ method: "wrangler_oauth", preflight: manifest ? null : { workersSubdomain: "existing-label" } });
    assert.equal(setupCalls, 1, "the setup decision must be reached in both skip arms");
  }
});
test("the real setup name step shows the exact final address before its next owner choice", async () => {
  const { cmdSetup } = await import("../brain.mjs");
  const root = mkdtempSync(join(tmpdir(), "subdomain-name-step-"));
  const lines = [];
  const originalLog = console.log;
  const stop = new Error("fixture stops at OCR choice before storage or resources");
  let choices = 0;
  console.log = (...parts) => lines.push(parts.join(" "));
  try {
    await assert.rejects(cmdSetup(join(root, "manifest.json"), {
      flags: { name: "Fixture", slug: "fixture" }, preflightChecks: [],
      workersDevSubdomain: "quiet-meadow-1000",
      listCloudflareAccounts: async () => [{ id: ACCOUNT, name: "Owner account" }],
      ask: async question => { assert.match(question, /OCR/); choices++; throw stop; },
    }), error => error === stop);
    assert.equal(choices, 1);
    assert.ok(lines.some(line => line.includes("https://fixture-brain.quiet-meadow-1000.workers.dev")));
  } finally { console.log = originalLog; rmSync(root, { recursive: true, force: true }); }
});
test("scripted fetch with no availability endpoint still retries a PUT conflict", async () => {
  const calls = []; let puts = 0;
  const access = Buffer.from(["fixture", "opaque", "test", "access"].join("-"));
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push(options.method + " " + path);
    // The undocumented endpoint is absent in this provider fixture.
    if (path.includes("/workers/subdomains/")) return response(null, { status: 404, codes: [10008], message: "Endpoint missing" });
    if (path.endsWith(`/accounts/${ACCOUNT}`)) return response({ id: ACCOUNT, name: "Owner account" });
    if (path.endsWith("/workers/subdomain")) {
      if (options.method === "PUT") { puts++; return puts === 1 ? response(null, conflict) : response({}); }
      return puts < 2 ? response(null, missing) : response({ subdomain: "quiet-meadow-1001" });
    }
    return response([]);
  };
  let next = 1000;
  try {
    const result = await preflightCloudflareOAuthAccount(access, { id: ACCOUNT, name: "Owner account" }, {
      fetchImpl, registrationContext: "setup", generateSubdomainLabel: () => `quiet-meadow-${next++}`,
    });
    assert.equal(result.workersSubdomain, "quiet-meadow-1001");
    assert.equal(puts, 2);
    assert.ok(calls.every(call => !call.includes("/workers/subdomains/")));
  } finally { access.fill(0); }
});

test("a token-lane GET refusal cannot echo a credential through its error or stack", async () => {
  const secret = ["fixture", "opaque", "credential"].join("-");
  const fixture = await ensure([{ error: { status: 403, codes: [10000], message: `Permission denied ${secret}` } }], { secrets: [secret] });
  await assert.rejects(fixture.run, error => {
    assert.equal(error.status, 403);
    assert.match(error.message, /Permission denied/);
    assert.ok(!error.message.includes(secret), "the GET provider message must be masked");
    assert.ok(!error.stack.includes(secret), "the original provider error stack must not escape");
    assert.ok(!JSON.stringify(error).includes(secret));
    return true;
  });
  assert.deepEqual(fixture.calls.map(c => c.method), ["GET"]);
});

test("persist recognizes a structured subdomain 403 without diagnosing an absent label", async () => {
  let reads = 0, puts = 0;
  await assert.rejects(persistWorkersDevDomain("unused.manifest.json", {}, { id: ACCOUNT }, "fixture-brain", {
    readSubdomain: async () => { reads++; throw providerError({ status: 403, codes: [10000], message: "Permission denied" }); },
    registerSubdomain: async () => { puts++; },
  }), error => {
    assert.match(error.message, /exact account subdomain read was denied/);
    assert.doesNotMatch(error.message, /subdomain really is unset|failure to ASK/);
    return true;
  });
  assert.equal(reads, 1); assert.equal(puts, 0);
});

test("a token-lane reservation refusal is an anticipated CLI failure with the stable code", async () => {
  let reads = 0, puts = 0;
  await assert.rejects(persistWorkersDevDomain("unused.manifest.json", {}, { id: ACCOUNT }, "fixture-brain", {
    readSubdomain: async () => { reads++; throw providerError(missing); },
    registerSubdomain: async () => { puts++; throw providerError({ status: 403, codes: [10000], message: "Permission denied" }); },
    generateSubdomainLabel: () => "quiet-meadow-1000",
  }), error => {
    assert.equal(error.code, CODE);
    assert.equal(error.constructor.name, "Fatal", "a provider refusal must use the anticipated CLI failure renderer");
    assert.match(error.message, /Permission denied/);
    assert.ok(error.message.includes(`/help/${CODE}`));
    return true;
  });
  assert.equal(reads, 1); assert.equal(puts, 1);
});
test("a failed reservation after a fresh Allow keeps its code instead of becoming an auth error", async () => {
  const { CloudflareOAuthSessionError } = await import("../operations/cloudflare-oauth-session.mjs");
  const calls = [];
  await assert.rejects(withCloudflareControlCredential(() => { calls.push("action"); }, {
    accountId: ACCOUNT, authProfile: PROFILE, interactive: true, allowBrowserReauth: true, allowTokenRecovery: true,
    askFn: async () => { calls.push("token-offer"); return "y"; },
    withToken: async () => { calls.push("recovery"); },
    oauthOptions: { scopes: SCOPES },
    withOAuthSession: async ({ reauthorize }) => {
      calls.push(reauthorize ? "allow" : "read");
      if (reauthorize) throw Object.assign(new Error(`Permission denied. Issue: ${CODE}. Help: https://financialbrain.ai/help/${CODE}`), { code: CODE });
      throw Object.assign(new CloudflareOAuthSessionError("CLOUDFLARE_OAUTH_SCOPE_MISSING", "request", "Permission denied"), {
        status: 403, requiredSurface: "workers_subdomain", grantedScopes: OLD_SCOPES,
      });
    },
  }), error => { assert.equal(error.code, CODE); assert.equal(error.constructor.name, "Fatal"); return true; });
  assert.deepEqual(calls, ["read", "allow"]);
});
