/**
 * The wrangler login session lasts about an hour and wrangler renews it only
 * once it has expired. A run that starts with a few minutes left therefore
 * fails mid-provision with 403 9109. Cloudflare's refusal is the first moment
 * a refresh can work, so the API wrapper renews once and repeats the request;
 * a second refusal, or a refusal on an explicit token, still stops the run and
 * names where the credential came from. Reproduced live 2026-09-02 (20:49 MST).
 */
import assert from "node:assert/strict";
import {
  withWranglerSessionIfNeeded,
  withCloudflareControlCredential,
  runCloudflareWranglerCommand,
  cloudflareApiRequest,
  cloudflareAccessUsesBrowserProfile,
} from "../brain.mjs";
import { cloudflareOAuthProfileName } from "../operations/cloudflare-oauth-session.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const denied = { success: false, errors: [{ code: 9109, message: "Invalid access token" }], result: null };
const granted = { success: true, errors: [], result: [{ id: "acct" }] };
const ACCOUNT_ID = "c".repeat(32);
const PROFILE = cloudflareOAuthProfileName("synthetic-install-identity-0001");
const savedFetch = globalThis.fetch;
const savedToken = process.env.CLOUDFLARE_API_TOKEN;
delete process.env.CLOUDFLARE_API_TOKEN;

async function capturedLogs(action) {
  const savedLog = console.log;
  const lines = [];
  console.log = (...parts) => lines.push(parts.join(" "));
  try {
    return { value: await action(), lines };
  } finally {
    console.log = savedLog;
  }
}

function stubFetch(script) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), auth: opts.headers?.Authorization ?? null });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    return new Response(JSON.stringify(step.body), { status: step.status, headers: { "content-type": "application/json" } });
  };
  return calls;
}
const session = (renew, read = () => A) => ({ env: {}, argv: ["--json"], readWranglerOAuthToken: read, renewSessionToken: renew });

function oauthEnvelope(result, extra = {}) {
  return { success: true, errors: [], messages: [], result, ...extra };
}

function namedProfileHarness({ renewal = B } = {}) {
  let tokenReads = 0;
  let mutationCalls = 0;
  let created = 0;
  const processRunner = (_command, args) => {
    if (!args.includes("token")) {
      return { status: 0, signal: null, error: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    tokenReads += 1;
    if (tokenReads > 1 && renewal === null) {
      return { status: 1, signal: null, error: null, stdout: Buffer.alloc(0), stderr: Buffer.from("fixture refresh refused") };
    }
    const token = tokenReads === 1 ? A : renewal;
    return {
      status: 0,
      signal: null,
      error: null,
      stdout: Buffer.from(JSON.stringify({ type: "oauth", token }) + "\n"),
      stderr: Buffer.alloc(0),
    };
  };
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    if (path.endsWith("/accounts") && parsed.search) {
      return new Response(JSON.stringify(oauthEnvelope([
        { id: ACCOUNT_ID, name: "Fixture account" },
      ], { result_info: { page: 1, count: 1, total_count: 1, total_pages: 1 } })), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (path.endsWith(`/accounts/${ACCOUNT_ID}`)) {
      return new Response(JSON.stringify(oauthEnvelope({ id: ACCOUNT_ID, name: "Fixture account" })), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (path.endsWith("/workers/scripts/renewal-probe") && init.method === "POST") {
      mutationCalls += 1;
      if (init.headers?.Authorization === `Bearer ${B}`) {
        created += 1;
        return new Response(JSON.stringify(oauthEnvelope({ id: "created" })), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(denied), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(oauthEnvelope([])), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const run = (action) => withCloudflareControlCredential(action, {
    accountId: ACCOUNT_ID,
    authProfile: PROFILE,
    interactive: false,
    allowBrowserReauth: false,
    allowTokenRecovery: false,
    oauthOptions: {
      processRunner,
      environment: { PATH: "/fixture/bin", HOME: "/fixture/home" },
      fetchImpl,
    },
  });
  return {
    fetchImpl,
    run,
    counts: () => ({ tokenReads, mutationCalls, created }),
  };
}

try {
  // Local commands may inherit the session wrapper, but they should say
  // nothing about Cloudflare when they never use its control plane.
  {
    const { value, lines } = await capturedLogs(() => withWranglerSessionIfNeeded(
      () => "local result",
      { env: {}, argv: [], readWranglerOAuthToken: () => A },
    ));
    assert.equal(value, "local result");
    assert.deepEqual(lines, [], "an unused Wrangler session stays silent");
  }
  // The first real API use gets one neutral, owner-facing line without CLI
  // implementation jargon; later calls in the same command stay quiet.
  {
    const calls = stubFetch([
      { status: 200, body: granted },
      { status: 200, body: granted },
    ]);
    const { lines } = await capturedLogs(() => withWranglerSessionIfNeeded(async () => {
      assert.equal(cloudflareAccessUsesBrowserProfile(), true,
        "a legacy Wrangler browser session must not be described as an API token");
      await cloudflareApiRequest("/accounts");
      await cloudflareApiRequest("/accounts");
    }, { env: {}, argv: [], readWranglerOAuthToken: () => A }));
    assert.equal(calls.length, 2);
    assert.equal(lines.length, 1, "the credential source is announced once");
    assert.match(lines[0], /Cloudflare access is using the account signed in on this computer/);
    assert.doesNotMatch(lines[0], /wrangler/i);
  }
  // Machine-readable commands never gain a banner before their JSON.
  {
    stubFetch([{ status: 200, body: granted }]);
    const { lines } = await capturedLogs(() => withWranglerSessionIfNeeded(
      () => cloudflareApiRequest("/accounts"),
      session(() => B),
    ));
    assert.deepEqual(lines, []);
  }
  // An expired session: renew once, repeat the same request with the new token.
  {
    const calls = stubFetch([{ status: 403, body: denied }, { status: 200, body: granted }]);
    let renewed = 0;
    const out = await withWranglerSessionIfNeeded(() => cloudflareApiRequest("/accounts"), session(() => { renewed++; return B; }));
    assert.equal(renewed, 1, "renewed exactly once");
    assert.equal(calls.length, 2, "the request was repeated, not abandoned");
    assert.equal(calls[0].auth, `Bearer ${A}`);
    assert.equal(calls[1].auth, `Bearer ${B}`, "the repeat carries the renewed token");
    assert.ok(out, "the repeated request's result is returned");
  }
  // Renewal that yields the same token: one request, one refusal, source named.
  {
    const calls = stubFetch([{ status: 403, body: denied }]);
    await assert.rejects(
      withWranglerSessionIfNeeded(() => cloudflareApiRequest("/accounts"), session(() => A)),
      (error) => /failed \(403\)/.test(error.message) && error.credentialSource === "wrangler-session",
    );
    assert.equal(calls.length, 1, "no blind retry when nothing changed");
  }
  // A refusal that is not an auth error never triggers a renewal.
  {
    const calls = stubFetch([{ status: 500, body: { success: false, errors: [{ code: 1000, message: "boom" }] } }]);
    let renewed = 0;
    await assert.rejects(withWranglerSessionIfNeeded(() => cloudflareApiRequest("/accounts"), session(() => { renewed++; return B; })));
    assert.equal(renewed, 0); assert.equal(calls.length, 1);
  }
  // An explicit CLOUDFLARE_API_TOKEN is never silently swapped for a session.
  {
    process.env.CLOUDFLARE_API_TOKEN = "x".repeat(40);
    const calls = stubFetch([{ status: 403, body: denied }]);
    let renewed = 0;
    await assert.rejects(
      withWranglerSessionIfNeeded(() => cloudflareApiRequest("/accounts"), session(() => { renewed++; return B; })),
      (error) => /failed \(403\)/.test(error.message) && error.credentialSource === undefined,
    );
    assert.equal(renewed, 0); assert.equal(calls.length, 1);
    delete process.env.CLOUDFLARE_API_TOKEN;
  }

  // The product's named profile is a different holder from the legacy
  // default-profile session. Its token can expire inside the same setup run.
  {
    const harness = namedProfileHarness();
    globalThis.fetch = harness.fetchImpl;
    const out = await harness.run(() => cloudflareApiRequest(
      `/accounts/${ACCOUNT_ID}/workers/scripts/renewal-probe`,
      { method: "POST", body: { probe: true } },
    ));
    assert.equal(out.id, "created");
    assert.deepEqual(harness.counts(), { tokenReads: 2, mutationCalls: 2, created: 1 },
      "the named profile must re-read its refreshed token and retry the rejected call exactly once");
  }

  // If the named profile cannot refresh, stop with owner-facing reauthorization
  // guidance. A rejected write is not retried and cannot become a half-created
  // resource behind an error message.
  {
    const harness = namedProfileHarness({ renewal: null });
    globalThis.fetch = harness.fetchImpl;
    await assert.rejects(
      harness.run(() => cloudflareApiRequest(
        `/accounts/${ACCOUNT_ID}/workers/scripts/renewal-probe`,
        { method: "POST", body: { probe: true } },
      )),
      (error) => {
        assert.match(error.message, /authorize.*browser|browser.*authorize/i);
        assert.doesNotMatch(error.message, /403|9109|Invalid access token/i);
        return true;
      },
    );
    assert.deepEqual(harness.counts(), { tokenReads: 2, mutationCalls: 1, created: 0 },
      "failed renewal reaches the write decision once, retries nothing, and creates nothing");
  }

  // Product-owned Wrangler subprocesses must share the same named-profile
  // recovery. The first rejected command reaches its mutation decision; only
  // a proven renewed profile may run it a second time.
  {
    let commandCalls = 0;
    let renewalCalls = 0;
    let created = 0;
    const result = runCloudflareWranglerCommand(
      ["vectorize", "create", "fixture-index", "--dimensions=768", "--metric=cosine"],
      {
        accountId: ACCOUNT_ID,
        authProfile: PROFILE,
        platformName: "darwin",
        runCommand: () => {
          commandCalls += 1;
          if (commandCalls === 1) return { ok: false, out: "Authentication error [code: 10000]" };
          created += 1;
          return { ok: true, out: "created" };
        },
        renewSessionToken: () => { renewalCalls += 1; return true; },
      },
    );
    assert.equal(result.ok, true);
    assert.deepEqual({ commandCalls, renewalCalls, created }, { commandCalls: 2, renewalCalls: 1, created: 1 });
  }

  // A subprocess renewal failure returns only the reauthorization action. It
  // neither leaks the raw provider refusal nor repeats the mutation command.
  {
    let commandCalls = 0;
    let renewalCalls = 0;
    let created = 0;
    const result = runCloudflareWranglerCommand(
      ["vectorize", "create", "fixture-index", "--dimensions=768", "--metric=cosine"],
      {
        accountId: ACCOUNT_ID,
        authProfile: PROFILE,
        platformName: "darwin",
        runCommand: () => {
          commandCalls += 1;
          return { ok: false, out: "Authentication error [code: 10000]" };
        },
        renewSessionToken: () => { renewalCalls += 1; return false; },
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.out, /authorize.*browser|browser.*authorize/i);
    assert.doesNotMatch(result.out, /10000|Authentication error/i);
    assert.deepEqual({ commandCalls, renewalCalls, created }, { commandCalls: 1, renewalCalls: 1, created: 0 });
  }
} finally {
  globalThis.fetch = savedFetch;
  if (savedToken !== undefined) process.env.CLOUDFLARE_API_TOKEN = savedToken;
}
console.log("wrangler session: an expired login is renewed once and the request repeated; a refusal names its source");
