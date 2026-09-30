import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  adoptCloudflareAuthProfile,
  cloudflareAccessUsesBrowserProfile,
  cloudflareOAuthFailureMessage,
  cloudflareOAuthInstallIdentity,
  cmdConnect,
  cmdDoctor,
  cmdDisconnect,
  cmdUpdate,
  commandPath,
  parseWranglerMetadataIndexList,
  readHiddenCloudflareToken,
  recoverableVectorizeProvisionRefusal,
  renderCliCommands,
  runCloudflareWranglerCommand,
  withCloudflareControlCredential,
  withWranglerSessionIfNeeded,
} from "../brain.mjs";

import {
  CLOUDFLARE_OAUTH_CALLBACK_HOST,
  CLOUDFLARE_OAUTH_CALLBACK_PORT,
  CLOUDFLARE_OAUTH_SCOPES,
  CLOUDFLARE_OAUTH_WRANGLER_PACKAGE,
  CloudflareOAuthSessionError,
  captureCloudflareOAuthToken,
  cloudflareOAuthChildEnvironment,
  cloudflareOAuthProfileName,
  createCloudflareOAuthProfile,
  enableCloudflareOAuthKeyring,
  listCloudflareOAuthAccounts,
  parseWranglerOAuthTokenJson,
  preflightCloudflareOAuthAccount,
  selectCloudflareOAuthAccount,
  withCloudflareOAuthSession,
} from "../operations/cloudflare-oauth-session.mjs";

const INSTALL_ID = "019d00ef-6b02-7a10-a68a-11aa22bb33cc";
const OTHER_INSTALL_ID = "019d00ef-6b02-7a10-a68a-44dd55ee66ff";
const ACCOUNT_A = "a".repeat(32);
const ACCOUNT_B = "b".repeat(32);
const ACCOUNT_C = "c".repeat(32);
const TOKEN = "fixture-oauth-access-token-0123456789abcdef";
const AMBIENT_SECRET = "ambient-secret-must-not-cross-child-boundary";

function tokenOutput(token = TOKEN) {
  return Buffer.from(JSON.stringify({ type: "oauth", token }, null, 2) + "\n", "utf8");
}

function okProcessResult({ stdout = Buffer.alloc(0), stderr = Buffer.alloc(0) } = {}) {
  return { status: 0, signal: null, error: null, stdout, stderr };
}

function processRecorder(handler = () => okProcessResult()) {
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args: [...args], options: { ...options, env: { ...options.env } } });
    return handler({ command, args, options, index: calls.length - 1 });
  };
  runner.calls = calls;
  return runner;
}

function envelope(result, extra = {}) {
  return { success: true, errors: [], messages: [], result, ...extra };
}

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorCode(code) {
  return (error) => error instanceof CloudflareOAuthSessionError && error.code === code;
}

function vectorizeScopeError(accountId = ACCOUNT_A) {
  const error = new CloudflareOAuthSessionError(
    "CLOUDFLARE_OAUTH_SCOPE_MISSING",
    "request",
    "fixture Vectorize scope refusal",
  );
  error.requiredSurface = "vectorize";
  error.selectedAccountId = accountId;
  return error;
}

function workersSubdomainScopeError(accountId = ACCOUNT_A) {
  const error = new CloudflareOAuthSessionError(
    "CLOUDFLARE_OAUTH_SCOPE_MISSING",
    "request",
    "fixture workers subdomain scope refusal",
  );
  error.requiredSurface = "workers_subdomain";
  error.selectedAccountId = accountId;
  return error;
}

test("profile names are stable, per-install, non-identifying, and never default", () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  assert.match(profile, /^financial-brain-[a-f0-9]{24}$/);
  assert.equal(profile, cloudflareOAuthProfileName(INSTALL_ID));
  assert.notEqual(profile, cloudflareOAuthProfileName(OTHER_INSTALL_ID));
  assert.ok(!profile.includes(INSTALL_ID));
  assert.notEqual(profile, "default");
  assert.throws(
    () => cloudflareOAuthProfileName("short"),
    errorCode("CLOUDFLARE_OAUTH_INSTALL_IDENTITY_INVALID"),
  );
});

test("the manifest schema and OAuth runtime agree on exact Cloudflare account ids", () => {
  const schema = JSON.parse(readFileSync(resolve("manifest.schema.json"), "utf8"));
  const accountSchema = schema.properties.infrastructure.properties.cloudflare.properties.account_id;
  const schemaPattern = new RegExp(accountSchema.pattern);
  for (const accountId of [ACCOUNT_A, ACCOUNT_B.toUpperCase()]) {
    assert.equal(schemaPattern.test(accountId), true);
    assert.doesNotThrow(() => cloudflareOAuthChildEnvironment({ accountId }));
  }
  for (const accountId of ["short-account", "g".repeat(32), `${ACCOUNT_A}00`]) {
    assert.equal(schemaPattern.test(accountId), false);
    assert.throws(
      () => cloudflareOAuthChildEnvironment({ accountId }),
      (error) => error?.code === "CLOUDFLARE_ACCOUNT_ID_INVALID",
    );
  }
  assert.equal(schemaPattern.test("REQUIRED_client_account_id"), true);
  assert.throws(
    () => cloudflareOAuthChildEnvironment({ accountId: "REQUIRED_client_account_id" }),
    (error) => error?.code === "CLOUDFLARE_ACCOUNT_ID_INVALID",
  );
});

test("a saved exact profile survives a moved manifest while an asserted mismatched identity fails closed", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const tokenStdout = tokenOutput();
  const runner = processRecorder(({ args }) => args.includes("token")
    ? okProcessResult({ stdout: tokenStdout })
    : okProcessResult());
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/accounts")) {
      return jsonResponse(envelope([{ id: ACCOUNT_A, name: "Bound" }], {
        result_info: { page: 1, count: 1, total_count: 1, total_pages: 1 },
      }));
    }
    if (parsed.pathname.endsWith(`/accounts/${ACCOUNT_A}`)) {
      return jsonResponse(envelope({ id: ACCOUNT_A, name: "Bound" }));
    }
    return jsonResponse(envelope([]));
  };
  const session = await withCloudflareOAuthSession({
    profile,
    expectedAccountId: ACCOUNT_A,
    processRunner: runner,
    platformName: "darwin",
    environment: { PATH: "/fixture/bin", HOME: "/fixture/home" },
    fetchImpl,
  });
  assert.equal(session.profile, profile);
  assert.equal(session.account.id, ACCOUNT_A);
  assert.equal(runner.calls.at(-1).args[runner.calls.at(-1).args.indexOf("--profile") + 1], profile);
  await assert.rejects(
    withCloudflareOAuthSession({ profile, installIdentity: OTHER_INSTALL_ID }),
    errorCode("CLOUDFLARE_OAUTH_PROFILE_MISMATCH"),
  );
});

test("Wrangler OAuth environment is allowlisted and admits only mandatory keyring plus an exact selected account", () => {
  const environment = {
    PATH: "/fixture/bin",
    HOME: "/fixture/home",
    USERPROFILE: "C:\\Users\\fixture",
    APPDATA: "C:\\Users\\fixture\\AppData\\Roaming",
    SystemRoot: "C:\\Windows",
    TEMP: "/fixture/tmp",
    LC_ALL: "C",
    ADMIN_KEY: AMBIENT_SECRET,
    CLOUDFLARE_API_TOKEN: AMBIENT_SECRET,
    CLOUDFLARE_API_KEY: AMBIENT_SECRET,
    CLOUDFLARE_EMAIL: "owner@example.test",
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_C,
    CF_API_TOKEN: AMBIENT_SECRET,
    WRANGLER_PROFILE: "default",
    WRANGLER_AUTH_URL: "https://attacker.invalid/oauth",
    AWS_SECRET_ACCESS_KEY: AMBIENT_SECRET,
    GITHUB_TOKEN: AMBIENT_SECRET,
    NPM_TOKEN: AMBIENT_SECRET,
    NODE_OPTIONS: "--require=/tmp/untrusted.cjs",
    HTTPS_PROXY: "https://name:password@proxy.invalid",
    CI: "true",
  };
  const clean = cloudflareOAuthChildEnvironment({ environment, accountId: ACCOUNT_A.toUpperCase() });
  assert.deepEqual(clean, {
    PATH: "/fixture/bin",
    HOME: "/fixture/home",
    USERPROFILE: "C:\\Users\\fixture",
    APPDATA: "C:\\Users\\fixture\\AppData\\Roaming",
    SystemRoot: "C:\\Windows",
    TEMP: "/fixture/tmp",
    LC_ALL: "C",
    CLOUDFLARE_AUTH_USE_KEYRING: "true",
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_A,
  });
  assert.equal(JSON.stringify(clean).includes(AMBIENT_SECRET), false);

  const beforeSelection = cloudflareOAuthChildEnvironment({ environment });
  assert.equal(beforeSelection.CLOUDFLARE_AUTH_USE_KEYRING, "true");
  assert.equal(Object.hasOwn(beforeSelection, "CLOUDFLARE_ACCOUNT_ID"), false);
});

test("profile authorization pins Wrangler 4.131.1, keyring, scopes, browser callback, and exact profile", () => {
  const runner = processRecorder();
  const profile = createCloudflareOAuthProfile({
    installIdentity: INSTALL_ID,
    processRunner: runner,
    platformName: "darwin",
    environment: {
      PATH: "/fixture/bin",
      HOME: "/fixture/home",
      CLOUDFLARE_API_TOKEN: AMBIENT_SECRET,
      ADMIN_KEY: AMBIENT_SECRET,
    },
  });
  assert.equal(profile, cloudflareOAuthProfileName(INSTALL_ID));
  assert.equal(runner.calls.length, 2);

  const [keyring, authorize] = runner.calls;
  assert.equal(keyring.command, "npx");
  assert.deepEqual(keyring.args.slice(0, -1), [
    CLOUDFLARE_OAUTH_WRANGLER_PACKAGE,
    "auth", "keyring", "enable",
  ]);
  assert.equal(keyring.args.at(-1), "--env-file=/dev/null");
  assert.deepEqual(keyring.options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(keyring.options.env.CLOUDFLARE_AUTH_USE_KEYRING, "true");

  assert.deepEqual(authorize.args.slice(0, -1), [
    CLOUDFLARE_OAUTH_WRANGLER_PACKAGE,
    "auth", "create", profile,
    "--scopes", ...CLOUDFLARE_OAUTH_SCOPES,
    "--browser",
    "--callback-host", CLOUDFLARE_OAUTH_CALLBACK_HOST,
    "--callback-port", String(CLOUDFLARE_OAUTH_CALLBACK_PORT),
  ]);
  assert.equal(authorize.options.stdio, "inherit");
  assert.equal(authorize.options.env.CLOUDFLARE_AUTH_USE_KEYRING, "true");
  assert.equal(Object.hasOwn(authorize.options.env, "CLOUDFLARE_ACCOUNT_ID"), false);
  assert.equal(JSON.stringify(runner.calls).includes(AMBIENT_SECRET), false);
  assert.equal(authorize.args.includes("--profile"), false, "auth create takes the named profile positionally");
  assert.equal(authorize.args.includes("default"), false);
});

test("pinned Wrangler cannot request Vectorize through wrangler auth create", () => {
  const source = readFileSync(resolve("node_modules/wrangler/wrangler-dist/cli.js"), "utf8");
  const start = source.indexOf("DefaultScopes = {");
  const end = source.indexOf("\n    };", start);
  assert.ok(start >= 0 && end > start, "the pinned Wrangler browser-scope allowlist must be inspectable");
  const wranglerScopes = source.slice(start, end);
  assert.doesNotMatch(wranglerScopes, /["']vectorize:write["']/);
  assert.match(source, /CF_SCOPES = \[[\s\S]*?["']vectorize:write["']/,
    "the separate cf client knows Vectorize, proving this is the Wrangler client boundary");
  assert.deepEqual(CLOUDFLARE_OAUTH_SCOPES, [
    "account:read",
    "user:read",
    "workers:write",
    "d1:write",
    "ai:write",
  ]);
});

test("macOS and win32 browser sign-in request the same pinned Wrangler scopes", () => {
  const authorizeArgs = [];
  for (const platformName of ["darwin", "win32"]) {
    const runner = processRecorder();
    createCloudflareOAuthProfile({
      installIdentity: INSTALL_ID,
      processRunner: runner,
      platformName,
      environment: platformName === "win32"
        ? { Path: "C:\\fixture\\bin", USERPROFILE: "C:\\Users\\fixture" }
        : { PATH: "/fixture/bin", HOME: "/fixture/home" },
    });
    const authorize = runner.calls.find((call) => call.args.includes("create"));
    assert.ok(authorize, `${platformName} must reach the authorization decision point`);
    authorizeArgs.push(authorize.args.slice(0, -1));
  }
  assert.deepEqual(authorizeArgs[1], authorizeArgs[0]);
  assert.deepEqual(
    authorizeArgs[0].slice(authorizeArgs[0].indexOf("--scopes") + 1, authorizeArgs[0].indexOf("--browser")),
    [...CLOUDFLARE_OAUTH_SCOPES],
  );
});

test("keyring failure is a generic hard stop and captured output is wiped", () => {
  const stdout = Buffer.from(AMBIENT_SECRET);
  const stderr = Buffer.from(AMBIENT_SECRET);
  assert.throws(
    () => enableCloudflareOAuthKeyring({
      processRunner: () => ({ status: 1, stdout, stderr }),
      platformName: "darwin",
      environment: { PATH: "/fixture/bin", HOME: "/fixture/home" },
    }),
    (error) => {
      assert.equal(error.code, "CLOUDFLARE_KEYRING_UNAVAILABLE");
      assert.equal(error.message.includes(AMBIENT_SECRET), false);
      return true;
    },
  );
  assert.ok(stdout.every((byte) => byte === 0));
  assert.ok(stderr.every((byte) => byte === 0));
});

test("strict token JSON parsing returns a caller-owned zeroable Buffer without accepting other auth types", () => {
  const source = Buffer.from(` { "token": "${TOKEN}", "type": "oauth" }\n`, "utf8");
  const token = parseWranglerOAuthTokenJson(source);
  assert.ok(Buffer.isBuffer(token));
  assert.equal(token.toString("utf8"), TOKEN);
  assert.notEqual(token.buffer, source.buffer, "the token uses an unpooled allocation separate from captured stdout");
  const tokenBeforeSourceWipe = Buffer.from(token);
  source.fill(0);
  assert.ok(token.equals(tokenBeforeSourceWipe), "the token is a copy, even when Node allocates both Buffers from one slab");
  tokenBeforeSourceWipe.fill(0);
  token.fill(0);
  assert.ok(token.every((byte) => byte === 0));

  const invalid = [
    JSON.stringify({ type: "api_token", token: TOKEN }),
    JSON.stringify({ type: "api_key", key: TOKEN, email: "owner@example.test" }),
    JSON.stringify({ type: "oauth", token: TOKEN, extra: true }),
    `{ "type": "oauth", "type": "oauth", "token": "${TOKEN}" }`,
    `{ "type": "oauth", "token": "fixture\\u002doauth-token-0123456789abcdef" }`,
    `{ "type": "oauth", "token": "short" }`,
    `{ "type": "oauth" }`,
    `not-json-${TOKEN}`,
  ];
  for (const text of invalid) {
    assert.throws(
      () => parseWranglerOAuthTokenJson(Buffer.from(text)),
      errorCode("CLOUDFLARE_OAUTH_TOKEN_RESPONSE_INVALID"),
      text.slice(0, 40),
    );
  }
  assert.throws(
    () => parseWranglerOAuthTokenJson(Buffer.alloc(16 * 1024 + 1, 0x20)),
    errorCode("CLOUDFLARE_OAUTH_TOKEN_RESPONSE_INVALID"),
  );
  assert.throws(
    () => parseWranglerOAuthTokenJson(String(tokenOutput())),
    errorCode("CLOUDFLARE_OAUTH_TOKEN_RESPONSE_INVALID"),
  );
});

test("token capture uses only exact named-profile JSON output, never argv/stdout disclosure, and wipes child buffers", () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const stdout = tokenOutput();
  const stderr = Buffer.from("non-secret diagnostic");
  const runner = processRecorder(() => okProcessResult({ stdout, stderr }));
  const token = captureCloudflareOAuthToken({
    profile,
    accountId: ACCOUNT_A,
    processRunner: runner,
    platformName: "win32",
    environment: {
      Path: "C:\\fixture\\bin",
      USERPROFILE: "C:\\Users\\fixture",
      CLOUDFLARE_API_TOKEN: AMBIENT_SECRET,
    },
  });
  assert.equal(token.toString("utf8"), TOKEN);
  assert.ok(stdout.every((byte) => byte === 0));
  assert.ok(stderr.every((byte) => byte === 0));

  const [call] = runner.calls;
  assert.deepEqual(call.args.slice(0, -1), [
    CLOUDFLARE_OAUTH_WRANGLER_PACKAGE,
    "auth", "token", "--json",
    "--profile", profile,
  ]);
  assert.equal(call.options.shell, true);
  assert.equal(call.options.stdio[1], "pipe");
  assert.equal(call.options.env.CLOUDFLARE_AUTH_USE_KEYRING, "true");
  assert.equal(call.options.env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT_A);
  assert.equal(call.args.at(-1), "--env-file=NUL");
  assert.equal(JSON.stringify({ command: call.command, args: call.args, env: call.options.env }).includes(TOKEN), false);
  assert.equal(JSON.stringify(call.options.env).includes(AMBIENT_SECRET), false);
  assert.equal(call.args.includes("default"), false);
  token.fill(0);
});

test("failed token capture wipes any child output and never copies it into the error", () => {
  const stdout = tokenOutput();
  const stderr = Buffer.from(TOKEN);
  assert.throws(
    () => captureCloudflareOAuthToken({
      profile: cloudflareOAuthProfileName(INSTALL_ID),
      processRunner: () => ({ status: 1, stdout, stderr }),
      platformName: "darwin",
      environment: { PATH: "/fixture/bin", HOME: "/fixture/home" },
    }),
    (error) => {
      assert.equal(error.code, "CLOUDFLARE_OAUTH_REAUTH_REQUIRED");
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    },
  );
  assert.ok(stdout.every((byte) => byte === 0));
  assert.ok(stderr.every((byte) => byte === 0));
});

test("account listing reads every page, validates exact identities, and refuses redirects", async () => {
  const token = Buffer.from(TOKEN);
  const calls = [];
  const pages = [
    envelope([
      { id: ACCOUNT_A.toUpperCase(), name: "Personal account" },
      { id: ACCOUNT_B, name: "Existing business" },
    ], { result_info: { page: 1, count: 2, total_count: 3, total_pages: 2 } }),
    envelope([
      { id: ACCOUNT_C, name: "Another account" },
    ], { result_info: { page: 2, count: 1, total_count: 3, total_pages: 2 } }),
  ];
  const accounts = await listCloudflareOAuthAccounts(token, {
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse(pages[calls.length - 1]);
    },
  });
  assert.deepEqual(accounts, [
    { id: ACCOUNT_A, name: "Personal account" },
    { id: ACCOUNT_B, name: "Existing business" },
    { id: ACCOUNT_C, name: "Another account" },
  ]);
  assert.ok(Object.isFrozen(accounts));
  assert.ok(accounts.every(Object.isFrozen));
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/client\/v4\/accounts\?page=1&per_page=50$/);
  assert.match(calls[1].url, /\/client\/v4\/accounts\?page=2&per_page=50$/);
  for (const call of calls) {
    assert.equal(new URL(call.url).origin, "https://api.cloudflare.com");
    assert.equal(call.init.redirect, "manual");
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.headers.Authorization, `Bearer ${TOKEN}`);
  }
  token.fill(0);
});

test("account listing fails closed on duplicate, malformed, or incomplete account pages", async () => {
  const token = Buffer.from(TOKEN);
  const cases = [
    envelope([
      { id: ACCOUNT_A, name: "One" },
      { id: ACCOUNT_A, name: "Duplicate" },
    ], { result_info: { page: 1, count: 2, total_count: 2, total_pages: 1 } }),
    envelope([
      { id: "not-an-account", name: "Bad" },
    ], { result_info: { page: 1, count: 1, total_count: 1, total_pages: 1 } }),
    envelope([
      { id: ACCOUNT_A, name: "One" },
    ], { result_info: { page: 1, count: 1, total_count: 2, total_pages: 1 } }),
  ];
  for (const body of cases) {
    await assert.rejects(
      listCloudflareOAuthAccounts(token, { fetchImpl: async () => jsonResponse(body) }),
      errorCode("CLOUDFLARE_ACCOUNT_LIST_INVALID"),
    );
  }
  token.fill(0);
});

test("account selection handles zero, one, many, exact binding, cancellation, and invalid IDs", async () => {
  const one = Object.freeze([{ id: ACCOUNT_A, name: "Personal" }]);
  let promptCalls = 0;
  assert.deepEqual(
    await selectCloudflareOAuthAccount(one, { prompt: async () => { promptCalls++; return ACCOUNT_A; } }),
    { id: ACCOUNT_A, name: "Personal" },
  );
  assert.equal(promptCalls, 0);

  await assert.rejects(
    selectCloudflareOAuthAccount([]),
    errorCode("CLOUDFLARE_ACCOUNT_NONE"),
  );

  const many = Object.freeze([
    { id: ACCOUNT_A, name: "Same name" },
    { id: ACCOUNT_B, name: "Same name" },
  ]);
  await assert.rejects(
    selectCloudflareOAuthAccount(many),
    errorCode("CLOUDFLARE_ACCOUNT_SELECTION_REQUIRED"),
  );
  const chosen = await selectCloudflareOAuthAccount(many, {
    prompt: async (request) => {
      assert.equal(request.kind, "cloudflare_account");
      assert.equal(request.answer, "account_id");
      assert.ok(Object.isFrozen(request));
      assert.ok(Object.isFrozen(request.accounts));
      return ACCOUNT_B.toUpperCase();
    },
  });
  assert.equal(chosen.id, ACCOUNT_B);
  assert.equal((await selectCloudflareOAuthAccount(many, { expectedAccountId: ACCOUNT_A })).id, ACCOUNT_A);
  await assert.rejects(
    selectCloudflareOAuthAccount(many, { expectedAccountId: ACCOUNT_C }),
    errorCode("CLOUDFLARE_ACCOUNT_BINDING_MISMATCH"),
  );
  await assert.rejects(
    selectCloudflareOAuthAccount(many, { prompt: async () => "" }),
    errorCode("CLOUDFLARE_ACCOUNT_SELECTION_CANCELLED"),
  );
  await assert.rejects(
    selectCloudflareOAuthAccount(many, { prompt: async () => ACCOUNT_C }),
    errorCode("CLOUDFLARE_ACCOUNT_SELECTION_INVALID"),
  );
});

test("account preflight proves the exact account plus Workers subdomain, D1, Vectorize, and Workers AI read paths", async () => {
  const token = Buffer.from(TOKEN);
  const paths = [];
  const receipt = await preflightCloudflareOAuthAccount(
    token,
    { id: ACCOUNT_A, name: "Selected account" },
    {
      fetchImpl: async (url, init) => {
        paths.push(new URL(url).pathname + new URL(url).search);
        assert.equal(init.redirect, "manual");
        if (new URL(url).pathname.endsWith(`/accounts/${ACCOUNT_A}`)) {
          return jsonResponse(envelope({ id: ACCOUNT_A, name: "Selected account" }));
        }
        if (new URL(url).pathname.endsWith(`/accounts/${ACCOUNT_A}/workers/subdomain`)) {
          return jsonResponse(envelope({ subdomain: "exact-fixture-subdomain" }));
        }
        return jsonResponse(envelope([]));
      },
    },
  );
  assert.deepEqual(receipt, {
    status: "ready",
    account: { id: ACCOUNT_A, name: "Selected account" },
    checks: ["account", "workers", "workers_subdomain", "d1", "vectorize", "workers_ai"],
    workersSubdomain: "exact-fixture-subdomain",
  });
  assert.deepEqual(paths, [
    `/client/v4/accounts/${ACCOUNT_A}`,
    `/client/v4/accounts/${ACCOUNT_A}/workers/scripts`,
    `/client/v4/accounts/${ACCOUNT_A}/workers/subdomain`,
    `/client/v4/accounts/${ACCOUNT_A}/d1/database`,
    `/client/v4/accounts/${ACCOUNT_A}/vectorize/v2/indexes`,
    `/client/v4/accounts/${ACCOUNT_A}/ai/models/search?per_page=1`,
  ]);
  token.fill(0);
});

test("a Vectorize preflight refusal carries only its exact decision surface and selected account", async () => {
  const token = Buffer.from(TOKEN);
  const paths = [];
  await assert.rejects(
    preflightCloudflareOAuthAccount(token, { id: ACCOUNT_A, name: "Selected account" }, {
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        paths.push(parsed.pathname + parsed.search);
        if (parsed.pathname.endsWith(`/accounts/${ACCOUNT_A}`)) {
          return jsonResponse(envelope({ id: ACCOUNT_A, name: "Selected account" }));
        }
        if (parsed.pathname.endsWith(`/accounts/${ACCOUNT_A}/workers/subdomain`)) {
          return jsonResponse(envelope({ subdomain: "exact-fixture-subdomain" }));
        }
        if (parsed.pathname.endsWith(`/accounts/${ACCOUNT_A}/vectorize/v2/indexes`)) {
          return jsonResponse({ success: false, errors: [{ code: 10000 }], messages: [], result: null }, { status: 403 });
        }
        return jsonResponse(envelope([]));
      },
    }),
    (error) => {
      assert.equal(error.code, "CLOUDFLARE_OAUTH_SCOPE_MISSING");
      assert.equal(error.requiredSurface, "vectorize");
      assert.equal(error.selectedAccountId, ACCOUNT_A);
      assert.deepEqual(Object.keys(error).sort(), ["code", "name", "phase", "requiredSurface", "selectedAccountId"]);
      return true;
    },
  );
  assert.equal(paths.at(-1), `/client/v4/accounts/${ACCOUNT_A}/vectorize/v2/indexes`,
    "the refusal must reach the exact Vectorize decision point");
  assert.ok(!paths.some((path) => path.includes("/ai/models/search")),
    "no later preflight surface may run after the refusal");
  token.fill(0);
});

test("named-profile setup stops at a denied workers subdomain preflight before its action can create resources", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const runner = processRecorder(({ args }) => args.includes("token")
    ? okProcessResult({ stdout: tokenOutput(), stderr: Buffer.alloc(0) })
    : okProcessResult());
  const paths = [];
  let actionCalls = 0;
  await assert.rejects(
    withCloudflareOAuthSession({
      installIdentity: INSTALL_ID,
      reauthorize: true,
      action: async () => { actionCalls += 1; },
      processRunner: runner,
      platformName: "darwin",
      environment: { PATH: "/fixture/bin", HOME: "/fixture/home" },
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        paths.push(parsed.pathname + parsed.search);
        if (parsed.pathname.endsWith("/accounts")) {
          return jsonResponse(envelope([
            { id: ACCOUNT_A, name: "Selected" },
          ], { result_info: { page: 1, count: 1, total_count: 1, total_pages: 1 } }));
        }
        if (parsed.pathname.endsWith(`/accounts/${ACCOUNT_A}`)) {
          return jsonResponse(envelope({ id: ACCOUNT_A, name: "Selected" }));
        }
        if (parsed.pathname.endsWith("/workers/subdomain")) {
          return jsonResponse(envelope(null, {
            success: false,
            errors: [{ code: 10000, message: "Authentication error" }],
          }), { status: 403 });
        }
        return jsonResponse(envelope([]));
      },
    }),
    errorCode("CLOUDFLARE_OAUTH_SCOPE_MISSING"),
  );
  assert.equal(actionCalls, 0, "the resource-creating action must not start after preflight denial");
  assert.equal(paths.at(-1), `/client/v4/accounts/${ACCOUNT_A}/workers/subdomain`);
  assert.ok(!paths.some((path) => path.includes("/d1/database")),
    "preflight must fail closed at the missing subdomain read");
  assert.ok(runner.calls.some((call) => call.args.includes(profile)));
});

// Cloudflare answers an account that never registered a workers.dev subdomain
// with API error 10007 on exactly this read; the pinned Wrangler special-cases
// the same code to register one. It is an account setting the owner can fix,
// not a network failure and not a reason to reach for a token.
function unregisteredSubdomainFetch(paths) {
  return async (url) => {
    const parsed = new URL(url);
    paths.push(parsed.pathname + parsed.search);
    if (parsed.pathname.endsWith("/accounts")) {
      return jsonResponse(envelope([
        { id: ACCOUNT_A, name: "Selected" },
      ], { result_info: { page: 1, count: 1, total_count: 1, total_pages: 1 } }));
    }
    if (parsed.pathname.endsWith(`/accounts/${ACCOUNT_A}`)) {
      return jsonResponse(envelope({ id: ACCOUNT_A, name: "Selected" }));
    }
    if (parsed.pathname.endsWith("/workers/subdomain")) {
      return jsonResponse(envelope(null, {
        success: false,
        errors: [{ code: 10007, message: "This account does not have a workers.dev subdomain" }],
      }), { status: 404 });
    }
    return jsonResponse(envelope([]));
  };
}

function refusedSubdomainFetch(paths, providerCode = 10000) {
  return async (url) => {
    const parsed = new URL(url);
    paths.push(parsed.pathname + parsed.search);
    if (parsed.pathname.endsWith("/accounts")) {
      return jsonResponse(envelope([
        { id: ACCOUNT_A, name: "Selected" },
      ], { result_info: { page: 1, count: 1, total_count: 1, total_pages: 1 } }));
    }
    if (parsed.pathname.endsWith(`/accounts/${ACCOUNT_A}`)) {
      return jsonResponse(envelope({ id: ACCOUNT_A, name: "Selected" }));
    }
    if (parsed.pathname.endsWith("/workers/subdomain")) {
      return jsonResponse(envelope(null, {
        success: false,
        errors: [{ code: providerCode, message: "Authentication error" }],
      }), { status: 403 });
    }
    return jsonResponse(envelope([]));
  };
}

test("preflight names an account with no registered workers.dev subdomain instead of a failed request", async () => {
  const token = Buffer.from(TOKEN);
  const paths = [];
  await assert.rejects(
    preflightCloudflareOAuthAccount(token, { id: ACCOUNT_A, name: "Selected" }, {
      fetchImpl: unregisteredSubdomainFetch(paths),
    }),
    errorCode("CLOUDFLARE_WORKERS_SUBDOMAIN_UNREGISTERED"),
  );
  assert.equal(paths.at(-1), `/client/v4/accounts/${ACCOUNT_A}/workers/subdomain`,
    "the decision must be reached on the exact subdomain read");
  assert.ok(!paths.some((path) => path.includes("/d1/database")), "preflight still stops at that read");
  token.fill(0);
});

test("error 10007 on any other preflight read stays an ordinary refused request", async () => {
  const token = Buffer.from(TOKEN);
  await assert.rejects(
    preflightCloudflareOAuthAccount(token, { id: ACCOUNT_A, name: "Selected" }, {
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith(`/accounts/${ACCOUNT_A}`)) {
          return jsonResponse(envelope({ id: ACCOUNT_A, name: "Selected" }));
        }
        return jsonResponse(envelope(null, {
          success: false,
          errors: [{ code: 10007, message: "fixture not found" }],
        }), { status: 404 });
      },
    }),
    errorCode("CLOUDFLARE_OAUTH_REQUEST_FAILED"),
  );
  token.fill(0);
});

test("setup with no registered workers.dev subdomain says how to register one and never offers the token path", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "brain-unregistered-subdomain-"));
  try {
    const manifestPath = resolve(root, "brain.manifest.json");
    const resumeCommand = `brain setup ${commandPath(manifestPath)}`;
    const runner = processRecorder(({ args }) => args.includes("token")
      ? okProcessResult({ stdout: tokenOutput() })
      : okProcessResult());
    const paths = [];
    const prompts = [];
    let tokenCalls = 0;
    let actionCalls = 0;
    await assert.rejects(
      withCloudflareControlCredential(() => { actionCalls += 1; }, {
        manifestPath,
        installIdentity: INSTALL_ID,
        accountId: ACCOUNT_A,
        freshOAuth: true,
        reauthorizeOAuth: true,
        interactive: true,
        allowBrowserReauth: true,
        allowTokenRecovery: true,
        resumeCommand,
        askFn: async (question) => { prompts.push(question); return "y"; },
        withToken: async () => { tokenCalls += 1; throw new Error("token lane must not run"); },
        oauthOptions: {
          processRunner: runner,
          platformName: "darwin",
          environment: { PATH: "/fixture/bin", HOME: "/fixture/home" },
          fetchImpl: unregisteredSubdomainFetch(paths),
        },
      }),
      (error) => {
        const shown = renderCliCommands(error.message);
        // Its own issue code: REMOTE_NOT_FOUND's guidance says to wait for
        // propagation, which can never register a workers.dev subdomain.
        assert.equal(error.code, "CLOUDFLARE_WORKERS_SUBDOMAIN_UNREGISTERED");
        assert.match(error.message, /CLOUDFLARE_WORKERS_SUBDOMAIN_UNREGISTERED/);
        assert.match(error.message, /workers\.dev subdomain/);
        assert.match(error.message, /Workers & Pages/);
        assert.ok(shown.includes(renderCliCommands(resumeCommand)),
          `the owner must be told to resume with ${renderCliCommands(resumeCommand)}`);
        assert.doesNotMatch(error.message, /check the network|hidden token/i);
        return true;
      },
    );
    assert.equal(paths.at(-1), `/client/v4/accounts/${ACCOUNT_A}/workers/subdomain`,
      "the refusal must follow the exact subdomain read");
    assert.equal(actionCalls, 0, "nothing may be created on an account with no workers.dev subdomain");
    assert.equal(tokenCalls, 0);
    assert.deepEqual(prompts, [], "neither a browser refresh nor the token path may be offered");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A Brain on its own custom domain never serves from workers.dev, so an
// account that never registered one is not a reason to refuse the sign-in.
// deploy keeps main's 'optional' route disposition and only warns.
test("preflight reports an unregistered workers.dev subdomain without refusing when the Brain does not need one", async () => {
  const token = Buffer.from(TOKEN);
  const paths = [];
  const preflight = await preflightCloudflareOAuthAccount(token, { id: ACCOUNT_A, name: "Selected" }, {
    fetchImpl: unregisteredSubdomainFetch(paths),
    workersSubdomainRequired: false,
  });
  assert.equal(preflight.status, "ready");
  assert.equal(preflight.workersSubdomainUnregistered, true);
  assert.equal(Object.hasOwn(preflight, "workersSubdomain"), false,
    "no hostname label may be invented for an account without one");
  assert.ok(!preflight.checks.includes("workers_subdomain"));
  assert.ok(paths.some((path) => path.includes("/d1/database")),
    "the remaining read-only checks must still run");
  token.fill(0);
});

function namedProfileManifest(root, brain) {
  const manifestPath = resolve(root, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    client: { slug: "fixture" },
    brain: { worker_name: "fixture-brain", ...brain },
    infrastructure: { cloudflare: { account_id: ACCOUNT_A, auth_profile: cloudflareOAuthProfileName(INSTALL_ID) } },
  }));
  return manifestPath;
}

async function namedProfileRoutine(manifestPath, paths, { fetchImpl = unregisteredSubdomainFetch(paths) } = {}) {
  const runner = processRecorder(({ args }) => args.includes("token")
    ? okProcessResult({ stdout: tokenOutput() })
    : okProcessResult());
  let actionCalls = 0;
  let actionSession = null;
  const prompts = [];
  const outcome = await withCloudflareControlCredential((session) => {
    actionCalls += 1;
    actionSession = session;
    return "done";
  }, {
    manifestPath,
    accountId: ACCOUNT_A,
    authProfile: cloudflareOAuthProfileName(INSTALL_ID),
    interactive: true,
    allowBrowserReauth: true,
    allowTokenRecovery: true,
    askFn: async (question) => { prompts.push(question); return "n"; },
    withToken: async () => { throw new Error("token lane must not run"); },
    oauthOptions: {
      processRunner: runner,
      platformName: "darwin",
      environment: { PATH: "/fixture/bin", HOME: "/fixture/home" },
      fetchImpl,
    },
  }).then((value) => ({ value }), (error) => ({ error }));
  return { ...outcome, actionCalls, actionSession, prompts };
}

test("a named-profile update of a custom-domain Brain continues when the subdomain read is refused", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "brain-custom-domain-refused-subdomain-"));
  try {
    const paths = [];
    const result = await namedProfileRoutine(
      namedProfileManifest(root, { domain: "brain.example.invalid" }),
      paths,
      { fetchImpl: refusedSubdomainFetch(paths) },
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.value, "done");
    assert.equal(result.actionCalls, 1, "the update action must run after the optional refusal");
    assert.equal(result.actionSession.preflight.workersSubdomainUnreadable, true);
    assert.equal(Object.hasOwn(result.actionSession.preflight, "workersSubdomain"), false,
      "a refused read must not invent a subdomain receipt");
    assert.ok(!result.actionSession.preflight.checks.includes("workers_subdomain"));
    assert.ok(paths.some((path) => path.includes("/d1/database")),
      "the remaining preflight checks must run after the optional refusal");
    assert.deepEqual(result.prompts, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a named-profile update with a saved workers.dev address continues when the subdomain read is refused", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "brain-saved-workers-dev-refused-subdomain-"));
  try {
    const paths = [];
    const result = await namedProfileRoutine(
      namedProfileManifest(root, { domain: "fixture-brain.fixture-owner.workers.dev" }),
      paths,
      { fetchImpl: refusedSubdomainFetch(paths) },
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.value, "done");
    assert.equal(result.actionCalls, 1,
      "the update action must run because its saved full address needs no subdomain lookup");
    assert.equal(result.actionSession.preflight.workersSubdomainUnreadable, true);
    assert.ok(!result.actionSession.preflight.checks.includes("workers_subdomain"));
    assert.ok(paths.some((path) => path.includes("/vectorize/")),
      "the remaining preflight reads must run after the optional refusal");
    assert.deepEqual(result.prompts, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the update command uses a saved workers.dev address without requiring the account subdomain read", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "brain-update-saved-workers-dev-"));
  try {
    const manifestPath = namedProfileManifest(root, {
      domain: "fixture-brain.fixture-owner.workers.dev",
      version: "0.4.8",
    });
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.infrastructure.cloudflare.storage = "d1";
    manifest.infrastructure.cloudflare.d1_database_id = "fixture-database";
    manifest.infrastructure.cloudflare.vectorize_index = "fixture-index";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    let oauthCalls = 0;
    let verifyCalls = 0;
    let upgradeCalls = 0;
    await cmdUpdate(manifestPath, {
      discoverInstalledManifest: () => ({ path: manifestPath, source: "remembered" }),
      readUpdateBacklog: async () => ({ pending: 0 }),
      adoptCloudflareAuthProfile: async () => manifest.infrastructure.cloudflare.auth_profile,
      interactive: false,
      cmdVerify: async () => { verifyCalls += 1; },
      cmdUpgrade: async () => { upgradeCalls += 1; return { status: "verified" }; },
      withCloudflareControl: withCloudflareControlCredential,
      withOAuthSession: async (request) => {
        oauthCalls += 1;
        assert.equal(request.workersSubdomainRequired, false,
          "the real update wrapper must mark the saved address read as unnecessary");
        return request.action({
          token: Buffer.from(TOKEN),
          profile: manifest.infrastructure.cloudflare.auth_profile,
          account: { id: ACCOUNT_A, name: "Selected" },
          preflight: { status: "ready", checks: ["account", "workers", "d1", "vectorize", "workers_ai"] },
        });
      },
    });
    assert.equal(oauthCalls, 1, "the saved-sign-in boundary must be reached once");
    assert.equal(verifyCalls, 1, "the update verification must run");
    assert.equal(upgradeCalls, 1, "the update must continue to the upgrade");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a named-profile setup with no saved address still requires the subdomain read", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "brain-no-domain-refused-subdomain-"));
  try {
    const paths = [];
    const result = await namedProfileRoutine(
      namedProfileManifest(root, {}),
      paths,
      { fetchImpl: refusedSubdomainFetch(paths) },
    );
    assert.equal(result.value, undefined);
    assert.equal(result.actionCalls, 0, "the mutating action must not run without an address");
    assert.equal(paths.filter((path) => path.endsWith("/workers/subdomain")).length, 1,
      "the required decision point must be reached exactly once");
    assert.equal(result.error?.code, "REMOTE_PERMISSION_DENIED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable manifest still requires the subdomain read", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "brain-unreadable-domain-refused-subdomain-"));
  try {
    const manifestPath = resolve(root, "brain.manifest.json");
    writeFileSync(manifestPath, "{not-json");
    const paths = [];
    const result = await namedProfileRoutine(
      manifestPath,
      paths,
      { fetchImpl: refusedSubdomainFetch(paths) },
    );
    assert.equal(result.value, undefined);
    assert.equal(result.actionCalls, 0, "the action must not run after an unreadable manifest");
    assert.equal(paths.filter((path) => path.endsWith("/workers/subdomain")).length, 1,
      "the fail-closed decision point must be reached exactly once");
    assert.equal(result.error?.code, "REMOTE_PERMISSION_DENIED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a custom-domain Brain treats any subdomain 403 as the same unused scope refusal", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "brain-custom-domain-refused-subdomain-code-"));
  try {
    const paths = [];
    const result = await namedProfileRoutine(
      namedProfileManifest(root, { domain: "brain.example.invalid" }),
      paths,
      { fetchImpl: refusedSubdomainFetch(paths, 9109) },
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.value, "done");
    assert.equal(result.actionCalls, 1, "the update action must run after the exact optional read is classified");
    assert.equal(result.actionSession.preflight.workersSubdomainUnreadable, true);
    assert.ok(!result.actionSession.preflight.checks.includes("workers_subdomain"));
    assert.ok(paths.some((path) => path.includes("/vectorize/")),
      "the remaining preflight reads must run after the optional refusal");
    assert.deepEqual(result.prompts, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function subdomainFailureFetch(paths, failure) {
  return async (url, init) => {
    const parsed = new URL(url);
    paths.push(parsed.pathname + parsed.search);
    if (parsed.pathname.endsWith("/accounts")) {
      return jsonResponse(envelope([
        { id: ACCOUNT_A, name: "Selected" },
      ], { result_info: { page: 1, count: 1, total_count: 1, total_pages: 1 } }));
    }
    if (parsed.pathname.endsWith(`/accounts/${ACCOUNT_A}`)) {
      return jsonResponse(envelope({ id: ACCOUNT_A, name: "Selected" }));
    }
    if (parsed.pathname.endsWith("/workers/subdomain")) {
      if (failure.kind === "network") throw new Error("fixture transport failure");
      if (failure.kind === "timeout") {
        return await new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("fixture aborted request")), { once: true });
        });
      }
      return jsonResponse(envelope(null, {
        success: false,
        errors: [{ code: failure.providerCode, message: "fixture refusal" }],
      }), { status: failure.status });
    }
    return jsonResponse(envelope([]));
  };
}

for (const failure of [
  {
    label: "401",
    status: 401,
    providerCode: 9109,
    oauthCode: "CLOUDFLARE_OAUTH_REAUTH_REQUIRED",
    publicCode: "AUTH_EXPIRED",
  },
  {
    label: "5xx",
    status: 503,
    providerCode: 1000,
    oauthCode: "CLOUDFLARE_OAUTH_REQUEST_FAILED",
    publicCode: "NETWORK_UNREACHABLE",
  },
  {
    label: "network error",
    kind: "network",
    oauthCode: "CLOUDFLARE_OAUTH_REQUEST_FAILED",
    publicCode: "NETWORK_UNREACHABLE",
  },
  {
    label: "timeout",
    kind: "timeout",
    oauthCode: "CLOUDFLARE_OAUTH_REQUEST_TIMEOUT",
    publicCode: "NETWORK_UNREACHABLE",
    requestTimeoutMs: 5,
  },
]) {
  test(`a custom-domain Brain stops on a subdomain ${failure.label}`, async () => {
    const root = mkdtempSync(resolve(tmpdir(), "brain-custom-domain-subdomain-failure-"));
    const paths = [];
    let actionCalls = 0;
    let observedOAuthCode = null;
    try {
      const manifestPath = namedProfileManifest(root, { domain: "brain.example.invalid" });
      const runner = processRecorder(({ args }) => args.includes("token")
        ? okProcessResult({ stdout: tokenOutput() })
        : okProcessResult());
      const outcome = await withCloudflareControlCredential(() => {
        actionCalls += 1;
        return "done";
      }, {
        manifestPath,
        accountId: ACCOUNT_A,
        authProfile: cloudflareOAuthProfileName(INSTALL_ID),
        interactive: true,
        allowBrowserReauth: true,
        allowTokenRecovery: true,
        askFn: async () => "n",
        withToken: async () => { throw new Error("token lane must not run"); },
        withOAuthSession: async (request) => {
          try {
            return await withCloudflareOAuthSession(request);
          } catch (error) {
            observedOAuthCode = error?.code;
            throw error;
          }
        },
        oauthOptions: {
          processRunner: runner,
          platformName: "darwin",
          environment: { PATH: "/fixture/bin", HOME: "/fixture/home" },
          fetchImpl: subdomainFailureFetch(paths, failure),
          ...(failure.requestTimeoutMs ? { requestTimeoutMs: failure.requestTimeoutMs } : {}),
        },
      }).then((value) => ({ value }), (error) => ({ error }));

      assert.equal(outcome.value, undefined);
      assert.equal(actionCalls, 0, "the action must not run after the exact subdomain read fails");
      assert.equal(paths.at(-1), `/client/v4/accounts/${ACCOUNT_A}/workers/subdomain`,
        "the failure must occur at the subdomain decision point");
      assert.equal(observedOAuthCode, failure.oauthCode);
      assert.equal(outcome.error?.code, failure.publicCode);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("a custom-domain Brain still fails closed on a Vectorize 403 after the tolerated subdomain refusal", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "brain-custom-domain-vectorize-refusal-"));
  try {
    const paths = [];
    const result = await namedProfileRoutine(
      namedProfileManifest(root, { domain: "brain.example.invalid" }),
      paths,
      {
        fetchImpl: async (url) => {
          const parsed = new URL(url);
          paths.push(parsed.pathname + parsed.search);
          if (parsed.pathname.endsWith("/accounts")) {
            return jsonResponse(envelope([
              { id: ACCOUNT_A, name: "Selected" },
            ], { result_info: { page: 1, count: 1, total_count: 1, total_pages: 1 } }));
          }
          if (parsed.pathname.endsWith(`/accounts/${ACCOUNT_A}`)) {
            return jsonResponse(envelope({ id: ACCOUNT_A, name: "Selected" }));
          }
          if (parsed.pathname.endsWith("/workers/subdomain") || parsed.pathname.includes("/vectorize/")) {
            return jsonResponse(envelope(null, {
              success: false,
              errors: [{ code: 10000, message: "fixture refusal" }],
            }), { status: 403 });
          }
          return jsonResponse(envelope([]));
        },
      },
    );
    assert.equal(result.actionCalls, 0, "the action must not run after the Vectorize refusal");
    assert.ok(result.error, "the Vectorize refusal must remain fatal");
    assert.equal(result.error.code, "REMOTE_PERMISSION_DENIED");
    assert.ok(paths.some((path) => path.includes("/vectorize/")),
      "the Vectorize decision point must be reached after the tolerated subdomain refusal");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function requiredSubdomainScopeRefusal({ interactive }) {
  const root = mkdtempSync(resolve(tmpdir(), "brain-required-subdomain-refusal-"));
  const paths = [];
  const prompts = [];
  let actionCalls = 0;
  let tokenCalls = 0;
  try {
    const manifestPath = namedProfileManifest(root, {});
    const runner = processRecorder(({ args }) => args.includes("token")
      ? okProcessResult({ stdout: tokenOutput() })
      : okProcessResult());
    const outcome = await withCloudflareControlCredential(() => {
      actionCalls += 1;
      return "done";
    }, {
      manifestPath,
      accountId: ACCOUNT_A,
      authProfile: cloudflareOAuthProfileName(INSTALL_ID),
      interactive,
      allowBrowserReauth: true,
      allowTokenRecovery: true,
      askFn: async (question) => { prompts.push(question); return "n"; },
      withToken: async () => { tokenCalls += 1; throw new Error("declined recovery must not run"); },
      oauthOptions: {
        processRunner: runner,
        platformName: "darwin",
        environment: { PATH: "/fixture/bin", HOME: "/fixture/home" },
        fetchImpl: refusedSubdomainFetch(paths),
      },
    }).then((value) => ({ value }), (error) => ({ error }));
    return { ...outcome, actionCalls, tokenCalls, paths, prompts };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a Brain with no saved address gets a specific subdomain refusal and the explicit recovery offer", async () => {
  const result = await requiredSubdomainScopeRefusal({ interactive: true });
  assert.equal(result.value, undefined);
  assert.equal(result.actionCalls, 0, "the update action must not run before required access is proved");
  assert.equal(result.tokenCalls, 0, "declining the recovery offer must not enter the token lane");
  assert.equal(result.paths.at(-1), `/client/v4/accounts/${ACCOUNT_A}/workers/subdomain`,
    "the refusal must reach the exact required subdomain read");
  assert.equal(result.prompts.length, 1, "the exact recovery decision must be offered once");
  assert.match(result.prompts[0], /This browser sign-in cannot read this account's workers\.dev address, which this Brain needs for its web address/i);
  assert.match(result.prompts[0], /Workers Scripts Edit[\s\S]*D1 Edit[\s\S]*Vectorize Edit[\s\S]*Workers AI Read/i);
  assert.doesNotMatch(result.prompts[0], /refresh in the browser/i);
  assert.match(result.error.message, /This browser sign-in cannot read this account's workers\.dev address, which this Brain needs for its web address/i);
  assert.match(result.error.message, /recovery API token from the Cloudflare dashboard/i);
  assert.match(result.error.message, /Nothing was changed/);
});

test("the no-address refusal enters the existing explicit recovery credential ceremony", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "brain-subdomain-recovery-control-"));
  const paths = [];
  const prompts = [];
  const tokenRequests = [];
  let actionCalls = 0;
  try {
    const manifestPath = namedProfileManifest(root, {});
    const runner = processRecorder(({ args }) => args.includes("token")
      ? okProcessResult({ stdout: tokenOutput() })
      : okProcessResult());
    const result = await withCloudflareControlCredential((session) => {
      actionCalls += 1;
      return session.method;
    }, {
      manifestPath,
      accountId: ACCOUNT_A,
      authProfile: cloudflareOAuthProfileName(INSTALL_ID),
      interactive: true,
      allowBrowserReauth: true,
      allowTokenRecovery: true,
      askFn: async (question) => { prompts.push(question); return "y"; },
      withToken: async (action, request) => {
        tokenRequests.push(request);
        return action();
      },
      oauthOptions: {
        processRunner: runner,
        platformName: "darwin",
        environment: { PATH: "/fixture/bin", HOME: "/fixture/home" },
        fetchImpl: refusedSubdomainFetch(paths),
      },
    });
    assert.equal(result, "api_token");
    assert.equal(actionCalls, 1, "the approved recovery credential reaches the action once");
    assert.equal(paths.at(-1), `/client/v4/accounts/${ACCOUNT_A}/workers/subdomain`,
      "the recovery must originate at the exact subdomain decision point");
    assert.equal(prompts.length, 1, "the recovery offer remains an explicit decision");
    assert.doesNotMatch(prompts[0], /refresh in the browser/i);
    assert.equal(tokenRequests.length, 1, "the shared recovery token runner is entered once");
    assert.equal(tokenRequests[0].accountId, ACCOUNT_A);
    assert.equal(tokenRequests[0].recoveryReason, "wrangler_workers_subdomain_scope_missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-interactive Brain with no saved address fails closed on a refused subdomain read", async () => {
  const result = await requiredSubdomainScopeRefusal({ interactive: false });
  assert.equal(result.value, undefined);
  assert.equal(result.actionCalls, 0, "the update action must remain closed");
  assert.equal(result.tokenCalls, 0, "non-interactive refusal must not enter the token lane");
  assert.deepEqual(result.prompts, [], "non-interactive refusal must not ask a question");
  assert.equal(result.paths.at(-1), `/client/v4/accounts/${ACCOUNT_A}/workers/subdomain`,
    "the exact required read must be reached before refusal");
  assert.match(result.error.message, /This browser sign-in cannot read this account's workers\.dev address, which this Brain needs for its web address/i);
  assert.match(result.error.message, /Nothing was changed/);
});

test("a named-profile update of a custom-domain Brain is not refused for a missing workers.dev subdomain", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "brain-custom-domain-"));
  try {
    const paths = [];
    const result = await namedProfileRoutine(namedProfileManifest(root, { domain: "brain.example.invalid" }), paths);
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.value, "done");
    assert.equal(result.actionCalls, 1);
    assert.deepEqual(result.prompts, []);
    assert.ok(paths.includes(`/client/v4/accounts/${ACCOUNT_A}/workers/subdomain`),
      "the subdomain is still read, only its absence is not fatal");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a named-profile Brain with no saved address is still refused for a missing subdomain", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "brain-workers-dev-"));
  try {
    const paths = [];
    const result = await namedProfileRoutine(namedProfileManifest(root, {}), paths);
    assert.equal(result.actionCalls, 0, "nothing may run before the Brain has an address");
    assert.equal(result.error?.code, "CLOUDFLARE_WORKERS_SUBDOMAIN_UNREGISTERED");
    assert.match(result.error.message, /workers\.dev subdomain/);
    assert.deepEqual(result.prompts, [], "neither a browser refresh nor the token path may be offered");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// An expired named profile refreshes in the browser. When that fresh sign-in
// then meets the unregistered subdomain, the answer is the same account
// setting, so the token prompt must not be offered and the resume command
// must still be named.
test("an unregistered subdomain found by the browser refresh is not routed to the token prompt", async () => {
  const resumeCommand = "brain update /fixture/brain.manifest.json";
  const prompts = [];
  const reauthorizeValues = [];
  let tokenCalls = 0;
  let actionCalls = 0;
  await assert.rejects(
    withCloudflareControlCredential(() => { actionCalls += 1; }, {
      accountId: ACCOUNT_A,
      authProfile: cloudflareOAuthProfileName(INSTALL_ID),
      interactive: true,
      allowBrowserReauth: true,
      allowTokenRecovery: true,
      resumeCommand,
      askFn: async (question) => { prompts.push(question); return "y"; },
      withToken: async () => { tokenCalls += 1; throw new Error("token lane must not run"); },
      withOAuthSession: async ({ reauthorize }) => {
        reauthorizeValues.push(reauthorize);
        if (!reauthorize) {
          throw new CloudflareOAuthSessionError("CLOUDFLARE_OAUTH_REAUTH_REQUIRED", "preflight", "fixture expiry");
        }
        throw new CloudflareOAuthSessionError("CLOUDFLARE_WORKERS_SUBDOMAIN_UNREGISTERED", "preflight", "fixture account");
      },
    }),
    (error) => {
      assert.equal(error.code, "CLOUDFLARE_WORKERS_SUBDOMAIN_UNREGISTERED");
      assert.match(error.message, /Workers & Pages/);
      assert.ok(renderCliCommands(error.message).includes(renderCliCommands(resumeCommand)),
        "the refusal after a refresh must still name the resume command");
      assert.doesNotMatch(error.message, /hidden token/i);
      return true;
    },
  );
  assert.deepEqual(reauthorizeValues, [false, true], "the browser refresh is the step that met the refusal");
  assert.equal(prompts.length, 1, `only the browser refresh may be offered, saw ${JSON.stringify(prompts)}`);
  assert.match(prompts[0], /refresh in the browser/);
  assert.equal(tokenCalls, 0);
  assert.equal(actionCalls, 0);
});

test("preflight rejects wrong-account readback and missing OAuth scope without response disclosure", async () => {
  const token = Buffer.from(TOKEN);
  await assert.rejects(
    preflightCloudflareOAuthAccount(token, { id: ACCOUNT_A, name: "Selected" }, {
      fetchImpl: async () => jsonResponse(envelope({ id: ACCOUNT_B, name: "Wrong" })),
    }),
    errorCode("CLOUDFLARE_ACCOUNT_BINDING_MISMATCH"),
  );
  await assert.rejects(
    preflightCloudflareOAuthAccount(token, { id: ACCOUNT_A, name: "Selected" }, {
      fetchImpl: async () => jsonResponse({
        success: false,
        errors: [{ code: 10000, message: TOKEN }],
        messages: [],
        result: null,
      }, { status: 403 }),
    }),
    (error) => error.code === "CLOUDFLARE_OAUTH_SCOPE_MISSING" && !error.message.includes(TOKEN),
  );
  token.fill(0);
});

test("complete setup session reauthorizes the named profile, selects before preflight, and zeroes token after action", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const tokenStdout = tokenOutput();
  const runner = processRecorder(({ args }) => {
    if (args.includes("token")) return okProcessResult({ stdout: tokenStdout, stderr: Buffer.alloc(0) });
    return okProcessResult();
  });
  const fetchCalls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    fetchCalls.push(parsed.pathname + parsed.search);
    if (parsed.pathname.endsWith("/accounts")) {
      return jsonResponse(envelope([
        { id: ACCOUNT_A, name: "First" },
        { id: ACCOUNT_B, name: "Chosen" },
      ], { result_info: { page: 1, count: 2, total_count: 2, total_pages: 1 } }));
    }
    if (parsed.pathname.endsWith(`/accounts/${ACCOUNT_B}`)) {
      return jsonResponse(envelope({ id: ACCOUNT_B, name: "Chosen" }));
    }
    return jsonResponse(envelope([]));
  };
  let retainedToken;
  const result = await withCloudflareOAuthSession({
    installIdentity: INSTALL_ID,
    reauthorize: true,
    prompt: async () => ACCOUNT_B,
    action: async (session) => {
      retainedToken = session.token;
      assert.equal(session.token.toString("utf8"), TOKEN);
      assert.equal(session.profile, profile);
      assert.equal(session.account.id, ACCOUNT_B);
      assert.equal(session.preflight.status, "ready");
      return { status: "action_complete", profile: session.profile, account_id: session.account.id };
    },
    processRunner: runner,
    platformName: "darwin",
    environment: {
      PATH: "/fixture/bin",
      HOME: "/fixture/home",
      CLOUDFLARE_API_TOKEN: AMBIENT_SECRET,
    },
    fetchImpl,
  });
  assert.deepEqual(result, { status: "action_complete", profile, account_id: ACCOUNT_B });
  assert.ok(retainedToken.every((byte) => byte === 0));
  assert.ok(tokenStdout.every((byte) => byte === 0));
  assert.equal(runner.calls.length, 3, "keyring, browser auth, then exact-profile token capture");
  assert.ok(runner.calls[1].args.includes(profile));
  assert.equal(runner.calls[2].args[runner.calls[2].args.indexOf("--profile") + 1], profile);
  assert.equal(runner.calls.some((call) => call.args.includes("default")), false);
  assert.equal(fetchCalls[0], "/client/v4/accounts?page=1&per_page=50");
  assert.ok(fetchCalls.slice(1).every((path) => path.includes(`/accounts/${ACCOUNT_B}`)));
});

test("routine bound session does not reauthorize or offer account reselection, returns no token, and zeroes on failure", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const tokenOutputs = [];
  const runner = processRecorder(({ args }) => {
    if (args.includes("token")) {
      const stdout = tokenOutput();
      tokenOutputs.push(stdout);
      return okProcessResult({ stdout });
    }
    return okProcessResult();
  });
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/accounts")) {
      return jsonResponse(envelope([
        { id: ACCOUNT_A, name: "Bound" },
        { id: ACCOUNT_B, name: "Other" },
      ], { result_info: { page: 1, count: 2, total_count: 2, total_pages: 1 } }));
    }
    if (parsed.pathname.endsWith(`/accounts/${ACCOUNT_A}`)) {
      return jsonResponse(envelope({ id: ACCOUNT_A, name: "Bound" }));
    }
    return jsonResponse(envelope([]));
  };
  let promptCalled = false;
  const safe = await withCloudflareOAuthSession({
    installIdentity: INSTALL_ID,
    expectedAccountId: ACCOUNT_A,
    prompt: async () => { promptCalled = true; return ACCOUNT_B; },
    processRunner: runner,
    platformName: "darwin",
    environment: { PATH: "/fixture/bin", HOME: "/fixture/home" },
    fetchImpl,
  });
  assert.equal(promptCalled, false);
  assert.equal(safe.profile, profile);
  assert.equal(safe.account.id, ACCOUNT_A);
  assert.equal(Object.hasOwn(safe, "token"), false);
  assert.equal(JSON.stringify(safe).includes(TOKEN), false);
  assert.equal(runner.calls.length, 2, "keyring verification and token capture only");
  assert.equal(runner.calls[1].args[runner.calls[1].args.indexOf("--profile") + 1], profile);
  assert.equal(runner.calls[1].options.env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT_A);

  let retainedToken;
  await assert.rejects(
    withCloudflareOAuthSession({
      installIdentity: INSTALL_ID,
      expectedAccountId: ACCOUNT_A,
      action: async (session) => {
        retainedToken = session.token;
        throw new Error("synthetic action failure");
      },
      processRunner: runner,
      platformName: "darwin",
      environment: { PATH: "/fixture/bin", HOME: "/fixture/home" },
      fetchImpl,
    }),
    /synthetic action failure/,
  );
  assert.ok(retainedToken.every((byte) => byte === 0));
  assert.ok(tokenOutputs.every((bytes) => bytes.every((byte) => byte === 0)));
});

test("a read-only existing-profile session does not persist Wrangler's global keyring preference", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const runner = processRecorder(({ args }) => {
    if (args.includes("token")) return okProcessResult({ stdout: tokenOutput() });
    throw new Error(`unexpected mutating Wrangler command: ${args.join(" ")}`);
  });
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/accounts")) {
      return jsonResponse(envelope([
        { id: ACCOUNT_A, name: "Bound" },
      ], { result_info: { page: 1, count: 1, total_count: 1, total_pages: 1 } }));
    }
    if (parsed.pathname.endsWith(`/accounts/${ACCOUNT_A}`)) {
      return jsonResponse(envelope({ id: ACCOUNT_A, name: "Bound" }));
    }
    return jsonResponse(envelope([]));
  };

  const session = await withCloudflareOAuthSession({
    profile,
    expectedAccountId: ACCOUNT_A,
    readOnlyExistingProfile: true,
    processRunner: runner,
    platformName: "darwin",
    environment: { PATH: "/fixture/bin", HOME: "/fixture/home" },
    fetchImpl,
  });
  assert.equal(session.profile, profile);
  assert.equal(session.account.id, ACCOUNT_A);
  assert.equal(runner.calls.length, 1);
  assert.ok(runner.calls[0].args.includes("token"));
  assert.equal(runner.calls[0].args.includes("enable"), false);
  assert.equal(runner.calls[0].args.includes("create"), false);
  assert.equal(runner.calls[0].args.includes("--browser"), false);
});

test("the command bridge keeps fresh and saved OAuth authoritative over an ambient token", async () => {
  const saved = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = "fixture-ambient-token-that-must-not-win";
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const modes = [];
  let tokenRunnerCalls = 0;
  const withOAuthSession = async (request) => {
    modes.push({ profile: request.profile || null, reauthorize: request.reauthorize });
    return request.action({
      token: Buffer.from(TOKEN),
      profile,
      account: { id: ACCOUNT_A, name: "Selected" },
      preflight: { status: "ready", checks: ["account", "workers", "d1", "vectorize", "workers_ai"] },
    });
  };
  try {
    const fresh = await withCloudflareControlCredential((session) => session, {
      freshOAuth: true,
      reauthorizeOAuth: true,
      interactive: true,
      manifestPath: "/fixture/new/brain.manifest.json",
      withOAuthSession,
      withToken: async () => { tokenRunnerCalls += 1; throw new Error("token path must not run"); },
    });
    assert.equal(fresh.method, "wrangler_oauth");
    assert.equal(fresh.account.id, ACCOUNT_A);

    const resumed = await withCloudflareControlCredential((session) => session, {
      authProfile: profile,
      accountId: ACCOUNT_A,
      interactive: true,
      withOAuthSession,
      withToken: async () => { tokenRunnerCalls += 1; throw new Error("token path must not run"); },
    });
    assert.equal(resumed.method, "wrangler_oauth");
    assert.equal(resumed.profile, profile);
    assert.deepEqual(modes, [
      { profile: null, reauthorize: true },
      { profile, reauthorize: false },
    ]);
    assert.equal(tokenRunnerCalls, 0);
  } finally {
    if (saved === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = saved;
  }
});

test("OAuth extension options cannot replace the saved profile, account, prompt, mode, or action", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const accountPrompt = async () => ACCOUNT_A;
  let suppliedActionCalls = 0;
  let outerActionCalls = 0;
  let observed;
  const result = await withCloudflareControlCredential((session) => {
    outerActionCalls += 1;
    return session.method;
  }, {
    authProfile: profile,
    accountId: ACCOUNT_A,
    interactive: true,
    accountPrompt,
    oauthOptions: {
      profile: "attacker-controlled-profile",
      installIdentity: OTHER_INSTALL_ID,
      expectedAccountId: ACCOUNT_B,
      reauthorize: true,
      prompt: async () => ACCOUNT_B,
      action: async () => { suppliedActionCalls += 1; return "wrong action"; },
    },
    withOAuthSession: async (request) => {
      observed = request;
      return request.action({
        token: Buffer.from(TOKEN),
        profile,
        account: { id: ACCOUNT_A, name: "Selected" },
        preflight: { status: "ready", checks: ["account", "workers", "d1", "vectorize", "workers_ai"] },
      });
    },
  });
  assert.equal(result, "wrangler_oauth");
  assert.equal(observed.profile, profile);
  assert.equal(observed.installIdentity, undefined);
  assert.equal(observed.expectedAccountId, ACCOUNT_A);
  assert.equal(observed.reauthorize, false);
  assert.equal(observed.prompt, accountPrompt);
  assert.equal(suppliedActionCalls, 0);
  assert.equal(outerActionCalls, 1);
});

test("a routine saved profile works without a TTY and never opens reauthorization", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const modes = [];
  let prompts = 0;
  const result = await withCloudflareControlCredential((session) => session.method, {
    authProfile: profile,
    accountId: ACCOUNT_A,
    interactive: false,
    allowBrowserReauth: false,
    allowTokenRecovery: false,
    askFn: async () => { prompts += 1; return "y"; },
    withOAuthSession: async (request) => {
      modes.push(request.reauthorize);
      return request.action({
        token: Buffer.from(TOKEN),
        profile,
        account: { id: ACCOUNT_A, name: "Selected" },
        preflight: { status: "ready", checks: ["account", "workers", "d1", "vectorize", "workers_ai"] },
      });
    },
  });
  assert.equal(result, "wrangler_oauth");
  assert.deepEqual(modes, [false]);
  assert.equal(prompts, 0);
});

test("a stale non-TTY saved profile fails closed without prompt, browser refresh, token fallback, or action", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const modes = [];
  let prompts = 0;
  let tokenCalls = 0;
  let actionCalls = 0;
  await assert.rejects(
    withCloudflareControlCredential(() => {
      actionCalls += 1;
    }, {
      authProfile: profile,
      accountId: ACCOUNT_A,
      interactive: false,
      allowBrowserReauth: true,
      allowTokenRecovery: true,
      askFn: async () => { prompts += 1; return "y"; },
      withToken: async () => { tokenCalls += 1; },
      withOAuthSession: async (request) => {
        modes.push(request.reauthorize);
        throw new CloudflareOAuthSessionError(
          "CLOUDFLARE_OAUTH_REAUTH_REQUIRED",
          "request",
          "fixture expired session",
        );
      },
    }),
    (error) => error?.code === "AUTH_EXPIRED",
  );
  assert.deepEqual(modes, [false]);
  assert.equal(prompts, 0);
  assert.equal(tokenCalls, 0);
  assert.equal(actionCalls, 0);
});

test("legacy, explicit recovery, and noninteractive automation retain the token lane", async () => {
  let oauthCalls = 0;
  let tokenCalls = 0;
  const withToken = async (action) => {
    tokenCalls += 1;
    return action();
  };
  const withOAuthSession = async () => {
    oauthCalls += 1;
    throw new Error("OAuth lane must not run");
  };
  const legacy = await withCloudflareControlCredential((session) => session.method, {
    interactive: true,
    withToken,
    withOAuthSession,
  });
  const explicit = await withCloudflareControlCredential((session) => session.method, {
    authProfile: cloudflareOAuthProfileName(INSTALL_ID),
    accountId: ACCOUNT_A,
    forceToken: true,
    interactive: true,
    withToken,
    withOAuthSession,
  });
  assert.equal(legacy, "api_token");
  assert.equal(explicit, "api_token");
  assert.equal(tokenCalls, 2);
  assert.equal(oauthCalls, 0);
});

test("a malformed or placeholder account can never select a generic recovery-token slot", async () => {
  let selectedAccountId = "not-observed";
  const result = await withCloudflareControlCredential((session) => session.method, {
    accountId: "REQUIRED_client_account_id",
    interactive: true,
    withToken: async (action, options) => {
      selectedAccountId = options.accountId;
      return action();
    },
  });
  assert.equal(result, "api_token");
  assert.equal(selectedAccountId, null);
});

test("expired OAuth gets one owner-approved refresh before any action", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const attempts = [];
  let actionCalls = 0;
  const result = await withCloudflareControlCredential(() => {
    actionCalls += 1;
    return "completed";
  }, {
    authProfile: profile,
    accountId: ACCOUNT_A,
    interactive: true,
    allowBrowserReauth: true,
    askFn: async () => "y",
    withOAuthSession: async (request) => {
      attempts.push(request.reauthorize);
      if (!request.reauthorize) {
        throw new CloudflareOAuthSessionError(
          "CLOUDFLARE_OAUTH_REAUTH_REQUIRED",
          "request",
          "fixture expired session",
        );
      }
      return request.action({
        token: Buffer.from(TOKEN),
        profile,
        account: { id: ACCOUNT_A, name: "Selected" },
        preflight: { status: "ready", checks: ["account", "workers", "d1", "vectorize", "workers_ai"] },
      });
    },
  });
  assert.equal(result, "completed");
  assert.deepEqual(attempts, [false, true]);
  assert.equal(actionCalls, 1);
});

test("a non-Vectorize scope refusal still gets one owner-approved browser refresh", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const attempts = [];
  let tokenCalls = 0;
  let actionCalls = 0;
  const result = await withCloudflareControlCredential(() => {
    actionCalls += 1;
    return "completed";
  }, {
    authProfile: profile,
    accountId: ACCOUNT_A,
    interactive: true,
    allowBrowserReauth: true,
    allowTokenRecovery: true,
    askFn: async () => "y",
    withToken: async () => { tokenCalls += 1; throw new Error("token lane must not run"); },
    withOAuthSession: async (request) => {
      attempts.push(request.reauthorize);
      if (!request.reauthorize) {
        const error = new CloudflareOAuthSessionError(
          "CLOUDFLARE_OAUTH_SCOPE_MISSING",
          "request",
          "fixture D1 scope refusal",
        );
        error.requiredSurface = "d1";
        error.selectedAccountId = ACCOUNT_A;
        throw error;
      }
      return request.action({
        token: Buffer.from(TOKEN),
        profile,
        account: { id: ACCOUNT_A, name: "Selected" },
        preflight: { status: "ready", checks: ["account", "workers", "d1", "vectorize", "workers_ai"] },
      });
    },
  });
  assert.equal(result, "completed");
  assert.deepEqual(attempts, [false, true]);
  assert.equal(actionCalls, 1, "the refreshed browser credential reaches the action once");
  assert.equal(tokenCalls, 0, "only the pinned Vectorize gap should route directly to token recovery");
});

test("a Vectorize scope refusal skips the impossible browser refresh and explicitly approves the saved recovery credential", async () => {
  const priorToken = process.env.CLOUDFLARE_API_TOKEN;
  const priorLog = console.log;
  delete process.env.CLOUDFLARE_API_TOKEN;
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const attempts = [];
  const prompts = [];
  const lines = [];
  const loadedAccounts = [];
  let actionCalls = 0;
  try {
    console.log = (line) => lines.push(String(line));
    const result = await withCloudflareControlCredential((session) => {
      actionCalls += 1;
      return session.method;
    }, {
      authProfile: profile,
      accountId: ACCOUNT_A,
      interactive: true,
      allowBrowserReauth: true,
      allowTokenRecovery: true,
      askFn: async (question) => { prompts.push(question); return "y"; },
      loadStoredCloudflareToken: (accountId) => {
        loadedAccounts.push(accountId);
        return Buffer.from("s".repeat(40));
      },
      withOAuthSession: async (request) => {
        attempts.push(request.reauthorize);
        throw vectorizeScopeError();
      },
    });

    assert.equal(result, "api_token");
    assert.deepEqual(attempts, [false], "Wrangler reauthorization cannot add its unsupported Vectorize scope");
    assert.deepEqual(loadedAccounts, [ACCOUNT_A], "the saved token lookup must be exact-account scoped");
    assert.equal(actionCalls, 1, "the explicitly approved recovery credential reaches the action once");
    assert.equal(prompts.length, 2, "recovery and the saved credential each need an explicit decision");
    assert.match(prompts[0], /Wrangler 4\.131\.1[\s\S]*Vectorize/i);
    assert.match(prompts[0], /Workers Scripts Edit[\s\S]*D1 Edit[\s\S]*Vectorize Edit[\s\S]*Workers AI Read/i);
    assert.match(prompts[1], /saved recovery API token[\s\S]*macOS Keychain/i);
    assert.match(prompts[1], /old or revoked/i);
    assert.match(prompts[1], new RegExp(ACCOUNT_A));
    assert.doesNotMatch(lines.join("\n"), /s{20}/, "no recovery credential bytes may be shown");
  } finally {
    console.log = priorLog;
    if (priorToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = priorToken;
  }
});

function recoverableProvisionCreateRefusal() {
  return recoverableVectorizeProvisionRefusal(
    new Error("POST metadata index create failed (403): 10000 authentication error"),
    ACCOUNT_A,
  );
}

test("an interactive Vectorize create refusal reuses the explicit recovery-token offer", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const prompts = [];
  const tokenRequests = [];
  let actionCalls = 0;
  const result = await withCloudflareControlCredential((session) => {
    actionCalls += 1;
    if (session.method === "wrangler_oauth") throw recoverableProvisionCreateRefusal();
    return "resumed-with-recovery";
  }, {
    authProfile: profile,
    accountId: ACCOUNT_A,
    interactive: true,
    allowBrowserReauth: true,
    allowTokenRecovery: true,
    askFn: async (question) => { prompts.push(question); return "y"; },
    withToken: async (action, request) => {
      tokenRequests.push(request);
      return action();
    },
    withOAuthSession: async (request) => request.action({
      token: Buffer.from(TOKEN),
      profile,
      account: { id: ACCOUNT_A, name: "Selected" },
      preflight: { status: "ready", checks: ["account", "workers", "d1", "vectorize", "workers_ai"] },
    }),
  });

  assert.equal(result, "resumed-with-recovery");
  assert.equal(actionCalls, 2, "the refused create and recovery resume must both reach the action");
  assert.equal(tokenRequests.length, 1, "the recovery-token decision point must be reached once");
  assert.equal(tokenRequests[0].recoveryReason, "wrangler_vectorize_scope_missing");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Workers Scripts Edit[\s\S]*D1 Edit[\s\S]*Vectorize Edit[\s\S]*Workers AI Read/i);
});

test("a non-interactive Vectorize create refusal names the recovery switch and four permissions", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  let actionCalls = 0;
  await assert.rejects(
    withCloudflareControlCredential(() => {
      actionCalls += 1;
      throw recoverableProvisionCreateRefusal();
    }, {
      authProfile: profile,
      accountId: ACCOUNT_A,
      interactive: false,
      allowBrowserReauth: false,
      allowTokenRecovery: false,
      resumeCommand: "brain setup /fixture/brain.manifest.json",
      recoveryCommand: "brain setup /fixture/brain.manifest.json --cloudflare-token",
      withOAuthSession: async (request) => request.action({
        token: Buffer.from(TOKEN),
        profile,
        account: { id: ACCOUNT_A, name: "Selected" },
        preflight: { status: "ready", checks: ["account", "workers", "d1", "vectorize", "workers_ai"] },
      }),
    }),
    (error) => {
      assert.match(error.message, /--cloudflare-token/);
      assert.match(error.message, /Workers Scripts Edit[\s\S]*D1 Edit[\s\S]*Vectorize Edit[\s\S]*Workers AI Read/i);
      return true;
    },
  );
  assert.equal(actionCalls, 1, "the create refusal must come from the real action boundary");
});

test("only setup recovery text names the recovery switch", () => {
  const refusal = vectorizeScopeError();
  for (const resumeCommand of [
    "brain update /fixture/brain.manifest.json",
    "brain provision /fixture/brain.manifest.json",
  ]) {
    const message = cloudflareOAuthFailureMessage(refusal, { resumeCommand });
    const rendered = renderCliCommands(message);
    assert.ok(rendered.includes(renderCliCommands(resumeCommand)),
      `the owner must still see the exact resume command ${resumeCommand}`);
    assert.doesNotMatch(message, /--cloudflare-token/,
      "non-setup commands must never be given a switch they do not accept");
    assert.match(message, /Nothing was changed/);
    assert.match(message, /rerun in an interactive terminal; it asks before using any recovery key/i);
  }

  const setupCommand = "brain setup /fixture/brain.manifest.json --cloudflare-token";
  const setupMessage = cloudflareOAuthFailureMessage(refusal, {
    resumeCommand: "brain setup /fixture/brain.manifest.json",
    recoveryCommand: setupCommand,
  });
  assert.ok(renderCliCommands(setupMessage).includes(renderCliCommands(setupCommand)));
});

test("a mid-setup create refusal does not claim that nothing changed", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  await assert.rejects(
    withCloudflareControlCredential(() => {
      throw recoverableProvisionCreateRefusal();
    }, {
      authProfile: profile,
      accountId: ACCOUNT_A,
      interactive: false,
      allowBrowserReauth: false,
      allowTokenRecovery: false,
      resumeCommand: "brain setup /fixture/brain.manifest.json",
      recoveryCommand: "brain setup /fixture/brain.manifest.json --cloudflare-token",
      withOAuthSession: async (request) => request.action({
        token: Buffer.from(TOKEN),
        profile,
        account: { id: ACCOUNT_A, name: "Selected" },
        preflight: { status: "ready", checks: ["account", "workers", "d1", "vectorize", "workers_ai"] },
      }),
    }),
    (error) => {
      assert.doesNotMatch(error.message, /Nothing was changed/);
      return true;
    },
  );
});

test("the explicit recovery switch cannot silently use a shared Wrangler session", async () => {
  const priorToken = process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_API_TOKEN;
  const prompts = [];
  let storedLoads = 0;
  let hiddenReads = 0;
  let actionCalls = 0;
  try {
    const result = await withWranglerSessionIfNeeded(
      () => withCloudflareControlCredential(() => {
        actionCalls += 1;
        return {
          browserProfileInUse: cloudflareAccessUsesBrowserProfile(),
        };
      }, {
        accountId: ACCOUNT_A,
        authProfile: cloudflareOAuthProfileName(INSTALL_ID),
        forceToken: true,
        interactive: true,
        allowTokenRecovery: true,
        askFn: async (question) => { prompts.push(question); return "y"; },
        loadStoredCloudflareToken: () => { storedLoads += 1; return null; },
        readCloudflareToken: async () => { hiddenReads += 1; return Buffer.from("t".repeat(40)); },
        storeCloudflareToken: () => {},
        platform: "linux",
      }),
      {
        env: {},
        argv: [],
        readWranglerOAuthToken: () => "fixture-shared-wrangler-session-not-real",
      },
    );
    assert.equal(actionCalls, 1, "the chosen recovery credential must reach the action once");
    assert.equal(result.browserProfileInUse, false,
      "the action must not inherit the shared browser session");
    assert.equal(storedLoads, 1, "the exact-account recovery lookup must be reached");
    assert.equal(hiddenReads, 1, "the approved hidden recovery entry must be reached");
    assert.equal(prompts.length, 0,
      "the explicit setup switch is the decision when no saved credential is available");
  } finally {
    if (priorToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = priorToken;
  }
});

for (const oauthFailure of [
  "CLOUDFLARE_OAUTH_REAUTH_REQUIRED",
  "CLOUDFLARE_OAUTH_SCOPE_MISSING",
]) {
  test(`an approved generic recovery offer after ${oauthFailure} cannot use a shared Wrangler session`, async () => {
    const priorToken = process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_API_TOKEN;
    const prompts = [];
    let storedLoads = 0;
    let hiddenReads = 0;
    let actionCalls = 0;
    try {
      const result = await withWranglerSessionIfNeeded(
        () => withCloudflareControlCredential(() => {
          actionCalls += 1;
          return { browserProfileInUse: cloudflareAccessUsesBrowserProfile() };
        }, {
          accountId: ACCOUNT_A,
          authProfile: cloudflareOAuthProfileName(INSTALL_ID),
          interactive: true,
          allowBrowserReauth: false,
          allowTokenRecovery: true,
          askFn: async (question) => { prompts.push(question); return "y"; },
          loadStoredCloudflareToken: () => { storedLoads += 1; return null; },
          readCloudflareToken: async () => { hiddenReads += 1; return Buffer.from("t".repeat(40)); },
          storeCloudflareToken: () => {},
          platform: "linux",
          withOAuthSession: async () => {
            throw new CloudflareOAuthSessionError(oauthFailure, "token", "fixture refusal");
          },
        }),
        {
          env: {},
          argv: [],
          readWranglerOAuthToken: () => "fixture-shared-wrangler-session-not-real",
        },
      );
      assert.equal(actionCalls, 1, "the approved recovery credential must reach the action once");
      assert.equal(result.browserProfileInUse, false,
        "generic recovery must not inherit the shared browser session");
      assert.equal(storedLoads, 1, "the exact-account saved-token lookup must be reached");
      assert.equal(hiddenReads, 1, "the approved hidden recovery entry must be reached");
      assert.ok(prompts.some((question) => /Use recovery API-token access now/i.test(question)),
        "the owner must reach the generic recovery decision");
    } finally {
      if (priorToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
      else process.env.CLOUDFLARE_API_TOKEN = priorToken;
    }
  });
}

test("the explicit setup recovery switch goes straight to hidden entry when no saved token applies", async () => {
  const prompts = [];
  let storedLoads = 0;
  let hiddenReads = 0;
  let actionCalls = 0;
  const result = await withCloudflareControlCredential(() => {
    actionCalls += 1;
    return "ran";
  }, {
    accountId: null,
    forceToken: true,
    interactive: true,
    askFn: async (question) => { prompts.push(question); return "n"; },
    loadStoredCloudflareToken: () => { storedLoads += 1; return null; },
    readCloudflareToken: async () => { hiddenReads += 1; return Buffer.from("t".repeat(40)); },
    platform: "linux",
  });
  assert.equal(result, "ran");
  assert.equal(actionCalls, 1, "the explicit recovery action must run once");
  assert.equal(storedLoads, 0, "an unknown account must not perform an unbound saved-token lookup");
  assert.equal(hiddenReads, 1, "the switch itself approves the hidden prompt");
  assert.deepEqual(prompts, [], "no y/n question belongs between the switch and hidden entry");
});

test("declining a saved setup recovery token reports cancellation without update advice", async () => {
  const prompts = [];
  let storedLoads = 0;
  await assert.rejects(
    withCloudflareControlCredential(() => "must not run", {
      accountId: ACCOUNT_A,
      forceToken: true,
      interactive: true,
      askFn: async (question) => { prompts.push(question); return "n"; },
      loadStoredCloudflareToken: () => {
        storedLoads += 1;
        return Buffer.from("s".repeat(40));
      },
      storedTokenReference: () => "fixture protected store",
      readCloudflareToken: async () => { throw new Error("hidden entry must not run"); },
      platform: "linux",
    }),
    (error) => {
      assert.equal(error?.code, "CLOUDFLARE_TOKEN_RECOVERY_CANCELLED");
      assert.match(error?.message || "", /cancelled before any credential was used/i);
      assert.doesNotMatch(error?.message || "", /brain update|Not setup/i);
      return true;
    },
  );
  assert.equal(storedLoads, 1, "the exact-account saved-token decision point must be reached");
  assert.equal(prompts.length, 2, "declining both saved and replacement credentials requires two decisions");
});

test("Wrangler metadata JSON ignores stderr warnings", () => {
  const rows = [{ propertyName: "source", indexType: "string" }];
  const stdout = JSON.stringify({ metadataIndexes: rows });
  const stderr = "npm warning: fixture-only diagnostic\n";
  const result = runCloudflareWranglerCommand(
    ["vectorize", "list-metadata-index", "fixture-index", "--json"],
    {
      accountId: ACCOUNT_A,
      runCommand: () => ({ ok: true, out: `${stdout}${stderr}`, stdout, stderr }),
    },
  );
  assert.deepEqual(parseWranglerMetadataIndexList(result), rows);
  assert.equal(result.stderr, stderr, "the warning lane must remain separately observable");
});

test("the test-chain guard refuses real Wrangler authentication when a fixture omits its runner", () => {
  let guardReads = 0;
  const environment = {};
  Object.defineProperty(environment, "BRAIN_TEST_CHAIN", {
    enumerable: true,
    get() {
      guardReads += 1;
      return "1";
    },
  });
  assert.throws(
    () => captureCloudflareOAuthToken({
      profile: cloudflareOAuthProfileName(INSTALL_ID),
      accountId: ACCOUNT_A,
      environment,
    }),
    /BRAIN_TEST_CHAIN refused real Wrangler authentication without an injected process runner/,
  );
  assert.ok(guardReads > 0, "the missing-runner refusal decision must be reached");

  let commandGuardReads = 0;
  const commandEnvironment = {};
  Object.defineProperty(commandEnvironment, "BRAIN_TEST_CHAIN", {
    enumerable: true,
    get() {
      commandGuardReads += 1;
      return "1";
    },
  });
  assert.throws(
    () => runCloudflareWranglerCommand(["vectorize", "list", "--json"], {
      accountId: ACCOUNT_A,
      environment: commandEnvironment,
    }),
    /BRAIN_TEST_CHAIN refused a real Wrangler command without an injected process runner/,
  );
  assert.ok(commandGuardReads > 0, "the product Wrangler runner guard must also be reached");

  const priorChain = process.env.BRAIN_TEST_CHAIN;
  process.env.BRAIN_TEST_CHAIN = "1";
  try {
    const fixtureEnvironment = { PATH: "", HOME: "/fixture/home" };
    assert.throws(
      () => captureCloudflareOAuthToken({
        profile: cloudflareOAuthProfileName(INSTALL_ID),
        accountId: ACCOUNT_A,
        environment: fixtureEnvironment,
      }),
      /BRAIN_TEST_CHAIN refused real Wrangler authentication without an injected process runner/,
      "the process-wide chain guard must survive a fixture-owned environment object",
    );
    assert.throws(
      () => runCloudflareWranglerCommand(["vectorize", "list", "--json"], {
        accountId: ACCOUNT_A,
        environment: fixtureEnvironment,
      }),
      /BRAIN_TEST_CHAIN refused a real Wrangler command without an injected process runner/,
      "the product runner guard must also survive a fixture-owned environment object",
    );
  } finally {
    if (priorChain === undefined) delete process.env.BRAIN_TEST_CHAIN;
    else process.env.BRAIN_TEST_CHAIN = priorChain;
  }
});

// The outer CLI wrapper loads this computer's shared Wrangler session before a
// command runs. That session must not count as an approved credential for the
// Vectorize recovery, or the saved recovery token would be used, or skipped,
// without the owner's second explicit decision.
async function vectorizeRecoveryThroughCliSessionWrapper(sharedWranglerToken) {
  const priorToken = process.env.CLOUDFLARE_API_TOKEN;
  const priorLog = console.log;
  delete process.env.CLOUDFLARE_API_TOKEN;
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const prompts = [];
  const lines = [];
  const loadedAccounts = [];
  let wranglerTokenReads = 0;
  let oauthAttempts = 0;
  let actionCalls = 0;
  try {
    console.log = (line) => lines.push(String(line));
    const result = await withWranglerSessionIfNeeded(
      () => withCloudflareControlCredential((session) => {
        actionCalls += 1;
        return session.method;
      }, {
        authProfile: profile,
        accountId: ACCOUNT_A,
        interactive: true,
        allowBrowserReauth: true,
        allowTokenRecovery: true,
        askFn: async (question) => { prompts.push(question); return "y"; },
        loadStoredCloudflareToken: (accountId) => {
          loadedAccounts.push(accountId);
          return Buffer.from("s".repeat(40));
        },
        storedTokenReference: () => "fixture protected store",
        withOAuthSession: async () => {
          oauthAttempts += 1;
          throw vectorizeScopeError();
        },
      }),
      {
        env: {},
        argv: [],
        readWranglerOAuthToken: () => {
          wranglerTokenReads += 1;
          return sharedWranglerToken;
        },
      },
    );
    return { result, prompts, lines, loadedAccounts, wranglerTokenReads, oauthAttempts, actionCalls };
  } finally {
    console.log = priorLog;
    if (priorToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = priorToken;
  }
}

function assertSavedRecoveryApprovedExplicitly(run) {
  assert.equal(run.result, "api_token");
  assert.equal(run.oauthAttempts, 1, "the OAuth refusal decision point is reached once");
  assert.equal(run.actionCalls, 1, "the explicitly approved saved recovery token reaches the action once");
  assert.deepEqual(run.loadedAccounts, [ACCOUNT_A], "the saved token lookup remains exact-account scoped");
  assert.equal(run.prompts.length, 2, "recovery and the saved credential each require approval");
  assert.match(run.prompts[0], /Wrangler 4\.131\.1[\s\S]*Vectorize/i);
  assert.match(run.prompts[1], /saved recovery API token[\s\S]*fixture protected store/i);
  assert.match(run.lines.join("\n"), /about to use the saved recovery API token/i);
  assert.doesNotMatch(run.lines.join("\n"), /s{20}|fixture-shared-wrangler/, "no credential bytes may be shown");
}

test("control: with no shared Wrangler session the CLI wrapper reaches the saved recovery approval", async () => {
  const run = await vectorizeRecoveryThroughCliSessionWrapper(null);
  assert.equal(run.wranglerTokenReads, 1, "the wrapper looked for a shared session and found none");
  assertSavedRecoveryApprovedExplicitly(run);
});

test("a shared Wrangler session cannot bypass explicit saved recovery approval", async () => {
  const run = await vectorizeRecoveryThroughCliSessionWrapper("fixture-shared-wrangler-session-not-real");
  assert.equal(run.wranglerTokenReads, 1, "the wrapper loaded the shared session, so this arm is not vacuous");
  assertSavedRecoveryApprovedExplicitly(run);
});

async function subdomainRecoveryThroughCliSessionWrapper(sharedWranglerToken) {
  const priorToken = process.env.CLOUDFLARE_API_TOKEN;
  const priorLog = console.log;
  delete process.env.CLOUDFLARE_API_TOKEN;
  const prompts = [];
  const lines = [];
  const loadedAccounts = [];
  let wranglerTokenReads = 0;
  let oauthAttempts = 0;
  let actionCalls = 0;
  try {
    console.log = (line) => lines.push(String(line));
    const result = await withWranglerSessionIfNeeded(
      () => withCloudflareControlCredential((session) => {
        actionCalls += 1;
        return session.method;
      }, {
        authProfile: cloudflareOAuthProfileName(INSTALL_ID),
        accountId: ACCOUNT_A,
        interactive: true,
        allowBrowserReauth: true,
        allowTokenRecovery: true,
        askFn: async (question) => { prompts.push(question); return "y"; },
        loadStoredCloudflareToken: (accountId) => {
          loadedAccounts.push(accountId);
          return Buffer.from("s".repeat(40));
        },
        storedTokenReference: () => "fixture protected store",
        withOAuthSession: async () => {
          oauthAttempts += 1;
          throw workersSubdomainScopeError();
        },
      }),
      {
        env: {},
        argv: [],
        readWranglerOAuthToken: () => {
          wranglerTokenReads += 1;
          return sharedWranglerToken;
        },
      },
    );
    return { result, prompts, lines, loadedAccounts, wranglerTokenReads, oauthAttempts, actionCalls };
  } finally {
    console.log = priorLog;
    if (priorToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = priorToken;
  }
}

for (const sharedWranglerToken of [null, "fixture-shared-wrangler-session-not-real"]) {
  test(`subdomain recovery requires saved-token approval with shared session ${Boolean(sharedWranglerToken)}`, async () => {
    const run = await subdomainRecoveryThroughCliSessionWrapper(sharedWranglerToken);
    assert.equal(run.wranglerTokenReads, 1, "the shared-session wrapper must perform exactly one Wrangler read");
    assert.equal(run.oauthAttempts, 1, "the subdomain refusal decision point must be reached once");
    assert.equal(run.result, "api_token");
    assert.equal(run.actionCalls, 1, "the approved saved recovery token must reach the action once");
    assert.deepEqual(run.loadedAccounts, [ACCOUNT_A], "the saved token lookup must use the exact account");
    assert.equal(run.prompts.length, 2, "recovery and the saved token must each receive approval");
    assert.match(run.prompts[0], /workers\.dev address[\s\S]*recovery API token/i);
    assert.match(run.prompts[1], /saved recovery API token[\s\S]*fixture protected store/i);
    assert.match(run.lines.join("\n"), /about to use the saved recovery API token/i);
    assert.doesNotMatch(run.lines.join("\n"), /s{20}|fixture-shared-wrangler/,
      "no credential bytes may be shown");
  });
}

test("win32 refuses an unusable Vectorize recovery offer before asking the owner", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const attempts = [];
  const prompts = [];
  const tokenRequests = [];
  let actionCalls = 0;
  await assert.rejects(
    withCloudflareControlCredential(() => { actionCalls += 1; }, {
      authProfile: profile,
      platform: "win32",
      environment: {},
      interactive: true,
      allowBrowserReauth: true,
      allowTokenRecovery: true,
      askFn: async (question) => { prompts.push(question); return "y"; },
      withToken: async (action, request) => {
        tokenRequests.push(request);
        return action();
      },
      withOAuthSession: async (request) => {
        attempts.push(request.reauthorize);
        throw vectorizeScopeError();
      },
    }),
    /cannot be trusted to hide Cloudflare token entry[\s\S]*not available from this Windows command/i,
  );

  assert.equal(actionCalls, 0, "the Windows refusal must happen before any token action");
  assert.deepEqual(attempts, [false]);
  assert.equal(tokenRequests.length, 0, "an unusable recovery lane must not be entered");
  assert.equal(prompts.length, 0, "the owner must not be offered a path that can only refuse later");
});

test("win32 keeps an ordinary browser sign-in failure's diagnosis and support code", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  let oauthAttempts = 0;
  let tokenCalls = 0;
  let actionCalls = 0;
  const prompts = [];
  await assert.rejects(
    withCloudflareControlCredential(() => { actionCalls += 1; }, {
      authProfile: profile,
      accountId: ACCOUNT_A,
      platform: "win32",
      environment: {},
      interactive: true,
      allowBrowserReauth: false,
      allowTokenRecovery: true,
      askFn: async (question) => { prompts.push(question); return "y"; },
      withToken: async () => { tokenCalls += 1; },
      withOAuthSession: async () => {
        oauthAttempts += 1;
        throw new CloudflareOAuthSessionError(
          "CLOUDFLARE_ACCOUNT_BINDING_MISMATCH",
          "preflight",
          "fixture account mismatch",
        );
      },
    }),
    (error) => {
      assert.equal(error?.code, "CONFIG_INVALID");
      assert.match(error?.message || "", /already tied to a different Cloudflare account/i);
      assert.match(error?.message || "", /CLOUDFLARE_ACCOUNT_BINDING_MISMATCH/);
      assert.doesNotMatch(error?.message || "", /cannot be trusted to hide Cloudflare token entry/i);
      return true;
    },
  );
  assert.equal(oauthAttempts, 1, "the ordinary browser failure decision point must be reached once");
  assert.equal(tokenCalls, 0, "an ordinary failure must not enter token recovery");
  assert.equal(actionCalls, 0, "the control action must not run without a valid browser session");
  assert.deepEqual(prompts, [], "an ordinary failure must not ask token-recovery questions");
});

test("win32 truthy echo-risk override reaches a known scope-recovery decision", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  let oauthAttempts = 0;
  let tokenCalls = 0;
  let actionCalls = 0;
  const prompts = [];
  const result = await withCloudflareControlCredential(() => {
    actionCalls += 1;
    return "recovered";
  }, {
    authProfile: profile,
    accountId: ACCOUNT_A,
    platform: "win32",
    environment: { BRAIN_ALLOW_WINDOWS_ECHO_RISK: "true" },
    interactive: true,
    allowBrowserReauth: false,
    allowTokenRecovery: true,
    askFn: async (question) => { prompts.push(question); return "y"; },
    withToken: async (action) => {
      tokenCalls += 1;
      return action();
    },
    withOAuthSession: async () => {
      oauthAttempts += 1;
      throw vectorizeScopeError();
    },
  });
  assert.equal(result, "recovered");
  assert.equal(oauthAttempts, 1, "the known scope refusal must be observed once");
  assert.equal(tokenCalls, 1, "the truthy override must reach token recovery once");
  assert.equal(actionCalls, 1, "the recovery credential must reach the action once");
  assert.equal(prompts.length, 1, "the known scope recovery must still require approval");
});

test("the explicit recovery switch keeps the win32 hidden-entry refusal", async () => {
  const originalPlatform = process.platform;
  let hiddenReads = 0;
  let actionCalls = 0;
  const terminal = {
    isTTY: true,
    isRaw: false,
    setRawMode(value) { this.isRaw = value === true; },
  };
  const sink = { isTTY: true, write() {} };
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    await assert.rejects(
      withCloudflareControlCredential(() => { actionCalls += 1; }, {
        authProfile: cloudflareOAuthProfileName(INSTALL_ID),
        accountId: ACCOUNT_A,
        forceToken: true,
        platform: "win32",
        interactive: true,
        allowTokenRecovery: true,
        loadStoredCloudflareToken: () => null,
        readCloudflareToken: () => {
          hiddenReads += 1;
          return readHiddenCloudflareToken({ input: terminal, output: sink });
        },
      }),
      (error) => {
        assert.equal(error?.constructor?.name, "Fatal");
        assert.match(
          error?.message || "",
          /cannot be trusted to hide Cloudflare token entry[\s\S]*not available from this Windows command/i,
        );
        assert.doesNotMatch(error?.message || "", /Run `brain update <manifest>`/i);
        return true;
      },
    );
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
  assert.equal(hiddenReads, 1, "the Windows hidden-entry decision point must be reached once");
  assert.equal(actionCalls, 0, "the action must not run after hidden entry is refused");
});

test("declining the saved recovery credential reaches a separate hidden-entry decision without using the saved token", async () => {
  const priorToken = process.env.CLOUDFLARE_API_TOKEN;
  const priorLog = console.log;
  delete process.env.CLOUDFLARE_API_TOKEN;
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const prompts = [];
  const answers = ["y", "n", "y", "n"];
  const lines = [];
  const stored = Buffer.from("r".repeat(40));
  let hiddenEntries = 0;
  let actionCalls = 0;
  try {
    console.log = (line) => lines.push(String(line));
    const result = await withCloudflareControlCredential((session) => {
      actionCalls += 1;
      return session.method;
    }, {
      authProfile: profile,
      accountId: ACCOUNT_A,
      platform: "darwin",
      interactive: true,
      allowBrowserReauth: true,
      allowTokenRecovery: true,
      askFn: async (question) => {
        prompts.push(question);
        return answers.shift() ?? "n";
      },
      loadStoredCloudflareToken: () => stored,
      readCloudflareToken: async () => {
        hiddenEntries += 1;
        return Buffer.from("n".repeat(40));
      },
      storeCloudflareToken: () => { throw new Error("declined storage must not run"); },
      withOAuthSession: async () => {
        throw vectorizeScopeError();
      },
    });

    assert.equal(result, "api_token");
    assert.equal(actionCalls, 1, "the green-control manual credential reaches the action once");
    assert.equal(hiddenEntries, 1, "declining the saved credential reaches hidden entry exactly once");
    assert.ok(stored.every((byte) => byte === 0), "the declined saved credential is wiped before hidden entry");
    assert.match(prompts[1], /saved recovery API token/i);
    assert.match(prompts[2], /different[\s\S]*hidden prompt/i);
    assert.match(lines.join("\n"), /newly entered recovery API token/i);
    assert.doesNotMatch(lines.join("\n"), /r{20}|n{20}/, "neither credential may be shown");
  } finally {
    console.log = priorLog;
    stored.fill(0);
    if (priorToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = priorToken;
  }
});

test("an OAuth-backed action failure propagates unchanged and is never retried as authentication", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const actionError = Object.assign(new Error("fixture install action failed after partial progress"), {
    code: "FIXTURE_ACTION_FAILED",
  });
  let actionCalls = 0;
  let oauthCalls = 0;
  let tokenCalls = 0;
  let promptCalls = 0;

  await assert.rejects(
    withCloudflareControlCredential(() => {
      actionCalls += 1;
      throw actionError;
    }, {
      authProfile: profile,
      accountId: ACCOUNT_A,
      interactive: true,
      allowBrowserReauth: true,
      allowTokenRecovery: true,
      askFn: async () => { promptCalls += 1; return "y"; },
      withToken: async () => { tokenCalls += 1; throw new Error("token lane must not run"); },
      withOAuthSession: async (request) => {
        oauthCalls += 1;
        return request.action({
          token: Buffer.from(TOKEN),
          profile,
          account: { id: ACCOUNT_A, name: "Selected" },
          preflight: { status: "ready", checks: ["account", "workers", "d1", "vectorize", "workers_ai"] },
        });
      },
    }),
    (error) => error === actionError && error.code === "FIXTURE_ACTION_FAILED",
  );

  assert.equal(actionCalls, 1);
  assert.equal(oauthCalls, 1);
  assert.equal(tokenCalls, 0);
  assert.equal(promptCalls, 0);
});

test("an action failure after approved OAuth refresh does not fall back or run again", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const actionError = Object.assign(new Error("fixture refreshed action failed"), {
    code: "FIXTURE_REFRESHED_ACTION_FAILED",
  });
  const oauthModes = [];
  let actionCalls = 0;
  let tokenCalls = 0;
  let promptCalls = 0;

  await assert.rejects(
    withCloudflareControlCredential(() => {
      actionCalls += 1;
      throw actionError;
    }, {
      authProfile: profile,
      accountId: ACCOUNT_A,
      interactive: true,
      allowBrowserReauth: true,
      allowTokenRecovery: true,
      askFn: async () => { promptCalls += 1; return "y"; },
      withToken: async () => { tokenCalls += 1; throw new Error("token lane must not run"); },
      withOAuthSession: async (request) => {
        oauthModes.push(request.reauthorize);
        if (!request.reauthorize) {
          throw new CloudflareOAuthSessionError(
            "CLOUDFLARE_OAUTH_REAUTH_REQUIRED",
            "request",
            "fixture expired session",
          );
        }
        return request.action({
          token: Buffer.from(TOKEN),
          profile,
          account: { id: ACCOUNT_A, name: "Selected" },
          preflight: { status: "ready", checks: ["account", "workers", "d1", "vectorize", "workers_ai"] },
        });
      },
    }),
    (error) => error === actionError && error.code === "FIXTURE_REFRESHED_ACTION_FAILED",
  );

  assert.deepEqual(oauthModes, [false, true]);
  assert.equal(actionCalls, 1);
  assert.equal(tokenCalls, 0);
  assert.equal(promptCalls, 1);
});

test("a token-lane action failure also propagates unchanged exactly once", async () => {
  const actionError = Object.assign(new Error("fixture token action failed"), {
    code: "FIXTURE_TOKEN_ACTION_FAILED",
  });
  let actionCalls = 0;
  let tokenCalls = 0;

  await assert.rejects(
    withCloudflareControlCredential(() => {
      actionCalls += 1;
      throw actionError;
    }, {
      interactive: true,
      withToken: async (action) => {
        tokenCalls += 1;
        return action();
      },
    }),
    (error) => error === actionError && error.code === "FIXTURE_TOKEN_ACTION_FAILED",
  );

  assert.equal(actionCalls, 1);
  assert.equal(tokenCalls, 1);
});

test("Zoom connect and disconnect use the manifest's exact saved Cloudflare profile", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const root = mkdtempSync(resolve(tmpdir(), "brain-zoom-oauth-dispatch-"));
  const manifestPath = resolve(root, "brain.manifest.json");
  const manifest = JSON.parse(readFileSync(resolve("templates/brain.manifest.json"), "utf8"));
  manifest.infrastructure.cloudflare.account_id = ACCOUNT_A;
  manifest.infrastructure.cloudflare.auth_profile = profile;
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const controlRequests = [];
  const connectorCalls = [];
  const withCloudflareControl = async (action, request) => {
    controlRequests.push({
      manifestPath: request.manifestPath,
      accountId: request.accountId,
      authProfile: request.authProfile,
    });
    return action();
  };
  try {
    const connectResult = await cmdConnect("zoom", {
      argv: ["node", "brain.mjs", "connect", "zoom", manifestPath],
      connectZoom: async (path) => {
        connectorCalls.push(["connect", path]);
        return "connected";
      },
      controlOptions: { interactive: true, withCloudflareControl },
    });
    const disconnectResult = await cmdDisconnect("zoom", {
      argv: ["node", "brain.mjs", "disconnect", "zoom", manifestPath],
      disconnectZoom: async (path) => {
        connectorCalls.push(["disconnect", path]);
        return "disconnected";
      },
      controlOptions: { interactive: true, withCloudflareControl },
    });

    assert.equal(connectResult, "connected");
    assert.equal(disconnectResult, "disconnected");
    assert.deepEqual(connectorCalls, [
      ["connect", manifestPath],
      ["disconnect", manifestPath],
    ]);
    assert.deepEqual(controlRequests, [
      { manifestPath, accountId: ACCOUNT_A, authProfile: profile },
      { manifestPath, accountId: ACCOUNT_A, authProfile: profile },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plain doctor runs deployed migration checks inside the saved browser profile without reauthorization", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const root = mkdtempSync(resolve(tmpdir(), "brain-doctor-oauth-dispatch-"));
  const manifestPath = resolve(root, "brain.manifest.json");
  const manifest = JSON.parse(readFileSync(resolve("templates/brain.manifest.json"), "utf8"));
  manifest.infrastructure.cloudflare.account_id = ACCOUNT_A;
  manifest.infrastructure.cloudflare.auth_profile = profile;
  manifest.infrastructure.cloudflare.d1_database_id = "d".repeat(32);
  manifest.infrastructure.cloudflare.vectorize_index = "acme-brain";
  manifest.corpora.bank_feed.enabled = false;
  writeFileSync(manifestPath, JSON.stringify(manifest));

  let insideSavedProfile = false;
  let checksumChecks = 0;
  let request = null;
  let doctorOptions = null;
  try {
    await cmdDoctor(manifestPath, {
      doctorRunAll: async (received) => {
        doctorOptions = received;
        return [];
      },
      withAvailableCloudflareToken: async (action) => action(),
      withCloudflareControl: async (action, received) => {
        request = received;
        insideSavedProfile = true;
        try { return await action(); }
        finally { insideSavedProfile = false; }
      },
      buildUpgradePauseCheck: async () => ({
        name: "upgrade state",
        status: "ok",
        detail: "fixture active",
      }),
      buildChecksumDriftCheck: async () => {
        checksumChecks += 1;
        assert.equal(insideSavedProfile, true);
        return {
          name: "migration checksums",
          status: "ok",
          detail: "fixture checked through D1",
        };
      },
      checkBankFeedRedirect: () => ({
        name: "Bank feed",
        status: "ok",
        detail: "fixture disabled",
      }),
    });

    assert.equal(checksumChecks, 1);
    assert.equal(doctorOptions.allowCodexForExistingBrain, true);
    assert.equal(request.manifestPath, manifestPath);
    assert.equal(request.accountId, ACCOUNT_A);
    assert.equal(request.authProfile, profile);
    assert.equal(request.interactive, false);
    assert.equal(request.allowBrowserReauth, false);
    assert.equal(request.allowTokenRecovery, false);
    assert.equal(request.oauthOptions.readOnlyExistingProfile, true);
    assert.notEqual(request.reauthorizeOAuth, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plain doctor keeps the Codex alternative off for empty, invalid, incomplete, and pre-provision manifests", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "brain-doctor-unprovisioned-gate-"));
  const manifestPath = resolve(root, "brain.manifest.json");
  const preProvision = readFileSync(resolve("templates/brain.manifest.json"), "utf8");
  const cases = [
    ["empty object", JSON.stringify({})],
    ["invalid JSON", "{not-json"],
    ["incomplete resource bindings", JSON.stringify({
      manifest_version: 1,
      client: { slug: "fixture", display_name: "Fixture" },
      brain: { version: "0.4.7", worker_name: "fixture-brain" },
      infrastructure: { cloudflare: { account_id: ACCOUNT_A, storage: "d1" } },
    })],
    ["invalid resource identities", JSON.stringify({
      manifest_version: 1,
      client: { slug: "fixture", display_name: "Fixture" },
      brain: { version: "0.4.7", worker_name: "fixture-brain" },
      infrastructure: {
        cloudflare: {
          account_id: "not-an-account-id",
          storage: "d1",
          d1_database_id: "not-a-database-id",
          vectorize_index: "fixture-brain",
        },
      },
    })],
    ["pre-provision template", preProvision],
  ];

  try {
    for (const [label, bytes] of cases) {
      writeFileSync(manifestPath, bytes);
      let doctorOptions = null;
      await cmdDoctor(manifestPath, {
        doctorRunAll: async (received) => {
          doctorOptions = received;
          return [];
        },
        withAvailableCloudflareToken: async (action) => action(),
        buildUpgradePauseCheck: async () => ({
          name: "upgrade state",
          status: "ok",
          detail: "fixture active",
        }),
        buildChecksumDriftCheck: async () => ({
          name: "migration checksums",
          status: "ok",
          detail: "fixture checked",
        }),
        checkBankFeedRedirect: () => ({
          name: "Bank feed",
          status: "ok",
          detail: "fixture disabled",
        }),
        checkPrioritySlice: () => ({
          name: "priority slice",
          status: "ok",
          detail: "fixture selected",
        }),
      });
      assert.equal(doctorOptions.allowCodexForExistingBrain, false, label);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manifest-path identity is canonical, bounded, and does not disclose a long local path", () => {
  const longPath = resolve("/tmp", ...Array.from({ length: 80 }, (_, index) => `segment-${index}`), "brain.manifest.json");
  const identity = cloudflareOAuthInstallIdentity(longPath);
  assert.match(identity, /^financial-brain-manifest-v1:[a-f0-9]{64}$/);
  assert.ok(identity.length < 100);
  assert.equal(identity.includes("segment-1"), false);
  assert.equal(identity, cloudflareOAuthInstallIdentity(longPath));
});

/*
 * D8. Wrangler writes `.wrangler/cache` under the child's own working
 * directory during the browser callback ceremony. A child that inherits the
 * caller's directory therefore throws away a sign-in that COMPLETED at
 * Cloudflare whenever the owner happens to be standing in an unwritable
 * directory, and the operator is told the sign-in did not complete.
 */
test("the Wrangler sign-in child runs in this install's directory, never the caller's", () => {
  const installDir = mkdtempSync(resolve(tmpdir(), "fb-oauth-cwd-"));
  try {
    const runner = processRecorder();
    createCloudflareOAuthProfile({
      installIdentity: INSTALL_ID,
      workingDirectory: installDir,
      processRunner: runner,
      platformName: "darwin",
      environment: { PATH: "/fixture/bin", HOME: "/fixture/home" },
    });
    assert.equal(runner.calls.length, 2);
    for (const call of runner.calls) {
      assert.equal(call.options.cwd, installDir);
      assert.notEqual(call.options.cwd, process.cwd());
    }
  } finally {
    rmSync(installDir, { recursive: true, force: true });
  }
});

test("with no install directory the sign-in child still refuses to inherit the caller's directory", () => {
  const runner = processRecorder();
  createCloudflareOAuthProfile({
    installIdentity: INSTALL_ID,
    processRunner: runner,
    platformName: "darwin",
    environment: { PATH: "/fixture/bin", HOME: "/fixture/home" },
  });
  for (const call of runner.calls) {
    assert.equal(typeof call.options.cwd, "string");
    assert.notEqual(call.options.cwd, process.cwd());
  }
});

test("a sign-in whose result cannot be written names the directory instead of blaming the browser", () => {
  const unwritable = resolve("/fixture/unwritable-install-dir");
  const denied = () => {
    const error = new Error("permission denied");
    error.code = "EACCES";
    throw error;
  };
  let thrown = null;
  try {
    createCloudflareOAuthProfile({
      installIdentity: INSTALL_ID,
      workingDirectory: unwritable,
      tmpDirectory: unwritable,
      statImpl: () => ({ isDirectory: () => true }),
      accessImpl: denied,
      processRunner: processRecorder(({ args }) => args.includes("create")
        ? { status: 1, signal: null, error: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
        : okProcessResult()),
      platformName: "win32",
      environment: { Path: "C:\\fixture", USERPROFILE: "C:\\fixture\\home" },
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof CloudflareOAuthSessionError, String(thrown));
  assert.equal(thrown.code, "CLOUDFLARE_OAUTH_WORKDIR_UNWRITABLE");
  assert.match(thrown.message, /completed/i);
  assert.ok(thrown.message.includes(unwritable), thrown.message);
  assert.equal(/did not complete/i.test(thrown.message), false, thrown.message);
});

test("a genuine unfinished browser step keeps the sign-in-did-not-complete wording", () => {
  assert.throws(
    () => createCloudflareOAuthProfile({
      installIdentity: INSTALL_ID,
      statImpl: () => ({ isDirectory: () => true }),
      accessImpl: () => undefined,
      processRunner: processRecorder(({ args }) => args.includes("create")
        ? { status: 1, signal: null, error: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
        : okProcessResult()),
      platformName: "darwin",
      environment: { PATH: "/fixture/bin", HOME: "/fixture/home" },
    }),
    (error) => error instanceof CloudflareOAuthSessionError &&
      error.code === "CLOUDFLARE_OAUTH_REAUTH_REQUIRED" &&
      /did not complete/i.test(error.message),
  );
});

test("adoption tells the owner the sign-in completed but could not be saved", async () => {
  const sandbox = mkdtempSync(resolve(tmpdir(), "fb-oauth-adopt-"));
  const priorLog = console.log;
  const priorTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  try {
    const manifestPath = resolve(sandbox, "brain.manifest.json");
    const legacy = {
      brain: { worker_name: "fixture-brain" },
      infrastructure: { cloudflare: { account_id: ACCOUNT_A } },
    };
    const bytes = JSON.stringify(legacy, null, 2) + "\n";

    const run = async (thrown) => {
      writeFileSync(manifestPath, bytes);
      const lines = [];
      console.log = (line) => lines.push(String(line));
      let seenWorkingDirectory;
      try {
        const outcome = await adoptCloudflareAuthProfile(manifestPath, {
          interactive: true,
          env: {},
          askFn: async () => "y",
          withOAuthSession: async (request) => {
            seenWorkingDirectory = request.workingDirectory;
            throw thrown;
          },
        });
        assert.equal(outcome, null);
      } finally {
        console.log = priorLog;
      }
      assert.equal(readFileSync(manifestPath, "utf8"), bytes);
      return { text: lines.join("\n"), seenWorkingDirectory };
    };

    const unwritable = new CloudflareOAuthSessionError(
      "CLOUDFLARE_OAUTH_WORKDIR_UNWRITABLE",
      "authorize",
      `the Cloudflare browser sign-in completed, but Wrangler could not save its result into ${sandbox} (EACCES)`,
    );
    const saveFailure = await run(unwritable);
    assert.equal(saveFailure.seenWorkingDirectory, sandbox, "the child is aimed at the install directory");
    assert.match(saveFailure.text, /completed/i);
    assert.ok(saveFailure.text.includes(sandbox), saveFailure.text);
    assert.match(saveFailure.text, /writable directory/i);
    assert.equal(/sign-in did not complete/i.test(saveFailure.text), false, saveFailure.text);

    const genuine = await run(new CloudflareOAuthSessionError(
      "CLOUDFLARE_OAUTH_REAUTH_REQUIRED",
      "authorize",
      "Cloudflare browser authorization did not complete for this install profile",
    ));
    assert.match(genuine.text, /did not complete/i);
    assert.equal(/writable directory/i.test(genuine.text), false, genuine.text);
  } finally {
    console.log = priorLog;
    if (priorTty) Object.defineProperty(process.stdin, "isTTY", priorTty);
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// Adoption runs its own sign-in ceremony, outside withCloudflareControlCredential.
// A custom-domain Brain on an account with no workers.dev subdomain must still
// be able to record its browser sign-in; a workers.dev Brain keeps the refusal.
test("adopting a browser sign-in applies the same workers.dev need as routine commands", async () => {
  const priorLog = console.log;
  const run = async (brain) => {
    const root = mkdtempSync(resolve(tmpdir(), "fb-oauth-adopt-domain-"));
    const manifestPath = resolve(root, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify({
      brain: { worker_name: "fixture-brain", ...brain },
      infrastructure: { cloudflare: { account_id: ACCOUNT_A } },
    }, null, 2) + "\n");
    const runner = processRecorder(({ args }) => args.includes("token")
      ? okProcessResult({ stdout: tokenOutput() })
      : okProcessResult());
    const lines = [];
    console.log = (line) => lines.push(String(line));
    try {
      const outcome = await adoptCloudflareAuthProfile(manifestPath, {
        interactive: true,
        env: {},
        askFn: async () => "y",
        oauthOptions: {
          processRunner: runner,
          platformName: "darwin",
          environment: { PATH: "/fixture/bin", HOME: "/fixture/home" },
          fetchImpl: unregisteredSubdomainFetch([]),
        },
      });
      const saved = JSON.parse(readFileSync(manifestPath, "utf8"));
      return { outcome, saved, text: lines.join("\n") };
    } finally {
      console.log = priorLog;
      rmSync(root, { recursive: true, force: true });
    }
  };
  const custom = await run({ domain: "brain.example.invalid" });
  assert.match(String(custom.outcome), /^financial-brain-/, custom.text);
  assert.equal(custom.saved.infrastructure.cloudflare.auth_profile, custom.outcome);

  const workersDev = await run({});
  assert.equal(workersDev.outcome, null);
  assert.equal(workersDev.saved.infrastructure.cloudflare.auth_profile, undefined);
  assert.match(workersDev.text, /CLOUDFLARE_WORKERS_SUBDOMAIN_UNREGISTERED|workers\.dev subdomain/);
});
