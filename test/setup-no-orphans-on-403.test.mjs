/**
 * A real Windows install hit `brain setup` step 3 of 6 after it had ALREADY
 * created D1, a Vectorize index, applied every migration, uploaded the
 * Worker, and enabled the workers.dev route. The last thing step 3 does is
 * read the account's workers.dev subdomain so it can save a token-free URL,
 * and on the browser-sign-in path that read can answer 401/403 (or find no
 * credential at all) while every call around it succeeds. Before this fix,
 * persistWorkersDevDomain died unconditionally on that read failing, which
 * left the owner holding billable, already-created resources with no address
 * for them and a message that pointed at a Cloudflare setting rather than the
 * actual denial.
 *
 * cmdDeploy is the exact function that failed (it is the last thing setup's
 * step 3 runs), so these exercise it directly rather than the full six-step
 * `brain setup` orchestration, which has its own dedicated test files for its
 * D1/Vectorize/migration machinery. Nothing here touches a network: every
 * Cloudflare and Worker call is answered by an injected fetch.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cmdDeploy,
  commandPath,
  displayPathForTesting,
  persistWorkersDevDomain,
  renderCliCommands,
  withCloudflareControlCredential,
} from "../brain.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

const ACCOUNT_ID = "a".repeat(32);
const AUTH_PROFILE = `financial-brain-${"b".repeat(24)}`;
const SLUG = "acme";
const SCRIPT_NAME = "acme-brain";
const ACCOUNT_DISPLAY_NAME = "display-fixture";
const SUBDOMAIN_LABEL = "exact-fixture-subdomain";
const CANDIDATE_DOMAIN = `${SCRIPT_NAME}.${SUBDOMAIN_LABEL}.workers.dev`;
const DISPLAY_NAME_DOMAIN = `${SCRIPT_NAME}.${ACCOUNT_DISPLAY_NAME}.workers.dev`;

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-setup-403-")));
after(() => rmSync(sandbox, { recursive: true, force: true }));

let manifestCounter = 0;
function writeManifest() {
  const path = join(sandbox, `fixture-${manifestCounter++}.manifest.json`);
  const value = {
    client: { slug: SLUG, display_name: "Acme" },
    brain: { worker_name: SCRIPT_NAME },
    infrastructure: {
      cloudflare: {
        account_id: ACCOUNT_ID,
        d1_database_id: "db-403-fixture",
        storage: "d1",
        vectorize_index: SCRIPT_NAME,
        drain_cron: "* * * * *",
      },
    },
  };
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function apiResponse(result, { success = true, status = 200, code = 1000, message = "fixture denial" } = {}) {
  return new Response(JSON.stringify({
    success,
    result: success ? result : null,
    errors: success ? [] : [{ code, message }],
  }), { status, headers: { "content-type": "application/json" } });
}

function healthResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * Every Cloudflare and Worker call cmdDeploy's fresh-install path actually
 * makes, for one D1-storage manifest naming `SCRIPT_NAME`. `subdomainRead`
 * selects the account-level `/workers/subdomain` GET's outcome (the exact
 * call the field report's 403 came from); `health` selects what the resulting
 * candidate's `/health` answers. Anything not modeled throws, so a call this
 * fix does not expect is loud rather than silently unanswered.
 */
function harness({ subdomainRead, health = null }) {
  const calls = [];
  const healthHosts = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init.method || "GET";
    calls.push(`${method} ${path}`);
    if (path === "/client/v4/accounts" && method === "GET") {
      return apiResponse([{ id: ACCOUNT_ID, name: ACCOUNT_DISPLAY_NAME }]);
    }
    if (path.endsWith(`/workers/scripts/${SCRIPT_NAME}`) && method === "PUT") {
      return apiResponse({});
    }
    if (path.endsWith(`/workers/scripts/${SCRIPT_NAME}/subdomain`) && method === "POST") {
      return apiResponse({ enabled: true });
    }
    if (path === `/client/v4/accounts/${ACCOUNT_ID}/workers/subdomain` && method === "GET") {
      return subdomainRead === "denied"
        ? apiResponse(null, { success: false, status: 403, code: 10000, message: "Authentication error" })
        : apiResponse({ subdomain: SUBDOMAIN_LABEL });
    }
    if (path.endsWith(`/workers/scripts/${SCRIPT_NAME}/schedules`) && method === "PUT") {
      return apiResponse([]);
    }
    if (path === "/health") {
      healthHosts.push(url.hostname);
      if (Array.isArray(health)) {
        // A scripted route: each probe consumes the next answer, and the last
        // one repeats, so "permanent" outcomes need only one entry.
        const step = health[Math.min(healthHosts.length - 1, health.length - 1)];
        if (step === "fetch-error") throw new Error("fetch failed: connection reset (fixture)");
        if (step === "healthy") return healthResponse({ brain: SLUG, version: VERSION });
        if (step === "stale") return healthResponse({ brain: SLUG, version: "0.0.1" });
        if (step === "wrong-brain") return healthResponse({ brain: "someone-else", version: VERSION });
        return healthResponse({ error: "fixture" }, { status: step });
      }
      if (health === "healthy") return healthResponse({ brain: SLUG, version: VERSION });
      if (health === "wrong-brain") return healthResponse({ brain: "someone-else", version: VERSION });
      if (health === "down") throw new Error("fetch failed: connection refused (fixture)");
      throw new Error("this scenario must never probe /health");
    }
    throw new Error(`offline fixture has no response for ${method} ${path}`);
  };
  return { fetchImpl, calls, healthHosts };
}

let namedProfileTokenReReads = 0;

async function withFixture(fetchImpl, run, { workersSubdomain = SUBDOMAIN_LABEL } = {}) {
  namedProfileTokenReReads = 0;
  const priorFetch = globalThis.fetch;
  const priorToken = process.env.CLOUDFLARE_API_TOKEN;
  try {
    globalThis.fetch = fetchImpl;
    delete process.env.CLOUDFLARE_API_TOKEN;
    return await withCloudflareControlCredential(run, {
      accountId: ACCOUNT_ID,
      authProfile: AUTH_PROFILE,
      interactive: false,
      allowBrowserReauth: false,
      allowTokenRecovery: false,
      // A rejected named-profile request tries one token re-read. The fixture
      // answers it offline as unavailable instead of spawning Wrangler.
      oauthOptions: {
        processRunner: () => {
          namedProfileTokenReReads += 1;
          return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        },
      },
      withOAuthSession: async ({ action }) => action({
        token: Buffer.from("named-profile-fixture-token"),
        profile: AUTH_PROFILE,
        account: { id: ACCOUNT_ID, name: ACCOUNT_DISPLAY_NAME },
        preflight: {
          status: "ready",
          account: { id: ACCOUNT_ID, name: ACCOUNT_DISPLAY_NAME },
          checks: ["account", "workers", "workers_subdomain", "d1", "vectorize", "workers_ai"],
          ...(workersSubdomain ? { workersSubdomain } : {}),
        },
      }),
    });
  } finally {
    globalThis.fetch = priorFetch;
    if (priorToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = priorToken;
  }
}

test("the named-profile lane probes and persists only the exact preflight subdomain", async () => {
  const target = writeManifest();
  const { fetchImpl, calls, healthHosts } = harness({ subdomainRead: "denied", health: "healthy" });
  await withFixture(fetchImpl, () => cmdDeploy(target, { wait: async () => {} }));
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.brain?.domain, CANDIDATE_DOMAIN);
  assert.deepEqual(healthHosts, [CANDIDATE_DOMAIN],
    "only the hostname derived from the authenticated preflight subdomain may be probed");
  assert.ok(!healthHosts.includes(DISPLAY_NAME_DOMAIN),
    "the account display name must never become a workers.dev hostname");
  assert.ok(!calls.includes(`GET /client/v4/accounts/${ACCOUNT_ID}/workers/subdomain`),
    "the carried authenticated receipt must avoid a second control-plane read");
});

test("a lane without a preflight receipt reads, probes, and persists the exact fallback subdomain", async () => {
  const target = writeManifest();
  const { fetchImpl, calls, healthHosts } = harness({ subdomainRead: "ok", health: "healthy" });
  await withFixture(fetchImpl, () => cmdDeploy(target, { wait: async () => {} }), {
    workersSubdomain: null,
  });
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.brain?.domain, CANDIDATE_DOMAIN);
  assert.ok(calls.includes(`GET /client/v4/accounts/${ACCOUNT_ID}/workers/subdomain`),
    "the no-receipt lane must reach the authenticated fallback decision point");
  assert.deepEqual(healthHosts, [CANDIDATE_DOMAIN]);
});

test("an exact preflight hostname that fails identity is neither persisted nor replaced by a fallback read", async () => {
  const target = writeManifest();
  const { fetchImpl, calls, healthHosts } = harness({ subdomainRead: "ok", health: "wrong-brain" });
  await assert.rejects(
    () => withFixture(fetchImpl, () => cmdDeploy(target, { wait: async () => {} })),
    /exact account hostname was not confirmed as this brain/i,
  );
  assert.deepEqual(healthHosts, [CANDIDATE_DOMAIN],
    "the refusal decision must be reached through the exact authenticated hostname");
  assert.ok(!calls.includes(`GET /client/v4/accounts/${ACCOUNT_ID}/workers/subdomain`),
    "a carried receipt must not be replaced after its exact hostname fails identity");
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.brain?.domain, undefined);
});

test("a fallback hostname whose /health answers for a different brain is refused and never saved", async () => {
  const target = writeManifest();
  const { fetchImpl, calls, healthHosts } = harness({ subdomainRead: "ok", health: "wrong-brain" });
  await assert.rejects(
    () => withFixture(fetchImpl, () => cmdDeploy(target, { wait: async () => {} }), {
      workersSubdomain: null,
    }),
    (error) => {
      assert.match(error.message, /exact account hostname was not confirmed as this brain/i);
      assert.match(error.message, /identified itself as "someone-else"/);
      assert.match(error.message, /No address was saved and no admin key was sent to that host/);
      return true;
    },
  );
  assert.ok(calls.includes(`GET /client/v4/accounts/${ACCOUNT_ID}/workers/subdomain`),
    "the no-receipt lane must reach the authenticated fallback decision point");
  assert.deepEqual(healthHosts, [CANDIDATE_DOMAIN],
    "the refusal decision must be reached through the exact fallback hostname");
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.brain?.domain, undefined);
});

test("the named-profile lane gives only an owner action after both URL proof and API fallback fail", async () => {
  const target = writeManifest();
  const { fetchImpl, calls, healthHosts } = harness({ subdomainRead: "denied", health: "down" });
  await assert.rejects(
    () => withFixture(fetchImpl, () => cmdDeploy(target, { wait: async () => {} }), {
      workersSubdomain: null,
    }),
    (error) => {
      assert.match(error.message, /confirm the brain's public address/);
      assert.match(error.message, /sign in again/i, "the message must name an action the owner can take");
      assert.match(error.message, /Do not change the Workers subdomain setting/i);
      assert.doesNotMatch(error.message, /Workers Scripts Read|needs a permission|Grant /i,
        "the browser-sign-in path must not diagnose a scope for the owner");
      assert.doesNotMatch(error.message, /Nothing is stranded|picks up|instead of recreating/i,
        "the failure must not promise an unproved safe setup resume");
      return true;
    },
  );
  assert.ok(calls.includes(`GET /client/v4/accounts/${ACCOUNT_ID}/workers/subdomain`),
    "the refusal must follow an attempted authenticated fallback read");
  assert.equal(namedProfileTokenReReads, 1,
    "the rejected named-profile read must try exactly one token re-read");
  assert.equal(
    calls.filter((call) => call === `GET /client/v4/accounts/${ACCOUNT_ID}/workers/subdomain`).length,
    1,
    "without a changed token the rejected read must not be repeated",
  );
  assert.deepEqual(healthHosts, [],
    "without an exact subdomain receipt, no guessed hostname may be probed");
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.brain?.domain, undefined);
});

test("the no-credential fallback preserves the wrangler-login and no-shell-token guidance", async () => {
  const target = writeManifest();
  const manifest = JSON.parse(readFileSync(target, "utf8"));
  const priorToken = process.env.CLOUDFLARE_API_TOKEN;
  try {
    delete process.env.CLOUDFLARE_API_TOKEN;
    await assert.rejects(
      persistWorkersDevDomain(target, manifest, { id: ACCOUNT_ID, name: "not a label" }, SCRIPT_NAME),
      (error) => {
        assert.match(error.message, /wrangler@[^\s]+ login/);
        assert.match(error.message, /never paste it\s+into a shell command/i);
        assert.doesNotMatch(error.message, /Workers Scripts Read|subdomain really is unset/i);
        return true;
      },
    );
  } finally {
    if (priorToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = priorToken;
  }
});

/** An injected sleep that records every requested delay and never waits. */
function recordingWait() {
  const delays = [];
  return { delays, wait: async (ms) => { delays.push(ms); } };
}

// A brand-new workers.dev route routinely takes longer than a few seconds to
// answer as the new Worker. The identity gate must give it at least the budget
// cmdHealth gives the same propagation lag (six probes five seconds apart).
const MIN_PROPAGATION_BUDGET_MS = 25_000;

test("a fresh workers.dev route that 404s five times while propagating is still confirmed and saved", async () => {
  const target = writeManifest();
  const { fetchImpl, healthHosts } = harness({
    subdomainRead: "ok",
    health: [404, 404, 404, 404, 404, "healthy"],
  });
  const { delays, wait } = recordingWait();
  await withFixture(fetchImpl, () => cmdDeploy(target, { wait }));
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.brain?.domain, CANDIDATE_DOMAIN);
  assert.equal(healthHosts.length, 6, "the gate must keep probing through propagation 404s");
  assert.ok(healthHosts.every((host) => host === CANDIDATE_DOMAIN));
  assert.equal(delays.length, 5, "each propagation miss waits exactly once before the next probe");
});

test("edge 5xx answers and fetch errors while a route propagates are retried, not fatal", async () => {
  const target = writeManifest();
  const { fetchImpl, healthHosts } = harness({
    subdomainRead: "ok",
    health: ["fetch-error", 503, 522, "fetch-error", "healthy"],
  });
  const { delays, wait } = recordingWait();
  await withFixture(fetchImpl, () => cmdDeploy(target, { wait }));
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.brain?.domain, CANDIDATE_DOMAIN);
  assert.equal(healthHosts.length, 5);
  assert.equal(delays.length, 4);
});

test("this brain still answering its previous version three times is retried until the new version is live", async () => {
  const target = writeManifest();
  const { fetchImpl, healthHosts } = harness({
    subdomainRead: "ok",
    health: ["stale", "stale", "stale", "healthy"],
  });
  const { delays, wait } = recordingWait();
  await withFixture(fetchImpl, () => cmdDeploy(target, { wait }));
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.brain?.domain, CANDIDATE_DOMAIN);
  assert.equal(healthHosts.length, 4, "a stale version of THIS brain is propagation, not a refusal");
  assert.equal(delays.length, 3);
});

test("a workers.dev host that answers for a different brain is refused at once, without retries", async () => {
  const target = writeManifest();
  const { fetchImpl, healthHosts } = harness({
    subdomainRead: "ok",
    health: ["wrong-brain", "healthy"],
  });
  const { delays, wait } = recordingWait();
  await assert.rejects(
    () => withFixture(fetchImpl, () => cmdDeploy(target, { wait })),
    (error) => {
      assert.match(error.message, /identified itself as "someone-else"/);
      assert.match(error.message, /No address was saved and no admin key was sent to that host/);
      return true;
    },
  );
  assert.deepEqual(healthHosts, [CANDIDATE_DOMAIN],
    "the identity refusal must be reached on the first probe and never retried");
  assert.deepEqual(delays, [], "a different brain is not propagation, so nothing waits");
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.brain?.domain, undefined);
});

test("a route that never stops 404ing dies after the full propagation budget and names the resume command", async () => {
  const target = writeManifest();
  const { fetchImpl, healthHosts } = harness({ subdomainRead: "ok", health: [404] });
  const { delays, wait } = recordingWait();
  const resume = renderCliCommands(`brain setup ${commandPath(displayPathForTesting(target, process.cwd()))}`);
  await assert.rejects(
    () => withFixture(fetchImpl, () => cmdDeploy(target, { wait })),
    (error) => {
      assert.match(error.message, /exact account hostname was not confirmed as this brain/i);
      assert.match(error.message, /\/health returned 404/);
      assert.ok(renderCliCommands(error.message).includes(resume),
        `the final refusal must name the resume command ${resume}`);
      return true;
    },
  );
  assert.ok(healthHosts.length >= 6, `expected at least six probes, saw ${healthHosts.length}`);
  assert.ok(healthHosts.every((host) => host === CANDIDATE_DOMAIN));
  assert.equal(delays.length, healthHosts.length - 1, "no sleep after the final probe");
  const waited = delays.reduce((sum, ms) => sum + ms, 0);
  assert.ok(waited >= MIN_PROPAGATION_BUDGET_MS,
    `the gate waited ${waited} ms in total, less than the propagation budget`);
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.brain?.domain, undefined);
});

/** Capture everything the CLI prints while `run` executes. */
async function captureOutput(run) {
  const lines = [];
  const priorLog = console.log;
  const priorError = console.error;
  console.log = (...args) => { lines.push(args.join(" ")); };
  console.error = (...args) => { lines.push(args.join(" ")); };
  try {
    await run();
  } finally {
    console.log = priorLog;
    console.error = priorError;
  }
  // Strip ANSI styling so the assertions read the words the owner reads.
  return lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
}

// The identity gate can sit for about a minute after "workers.dev route
// enabled". A silent minute reads as a hang, so each retry says what it is
// waiting for in the same words the drain warm-up already uses.
test("each propagation retry of the identity gate prints its progress like the drain warm-up", async () => {
  const target = writeManifest();
  const { fetchImpl, healthHosts } = harness({ subdomainRead: "ok", health: [404, 404, 503, "fetch-error", "stale", "healthy"] });
  const { delays, wait } = recordingWait();
  const lines = await captureOutput(() => withFixture(fetchImpl, () => cmdDeploy(target, { wait })));
  assert.equal(healthHosts.length, 6);
  const progress = lines.filter((line) => /Retrying \d+\/\d+ in \d+ second\(s\)\./.test(line));
  assert.equal(progress.length, delays.length, "every wait must be announced, and only waits");
  assert.equal(progress.length, 5);
  const seconds = Math.ceil(delays[0] / 1_000);
  assert.ok(progress[0].includes(
    `the brain's address is not answering yet (404). This is normal just after a deploy. Retrying 1/12 in ${seconds} second(s).`,
  ), progress[0]);
  assert.ok(progress[1].includes("Retrying 2/12 in"), progress[1]);
  assert.ok(progress[2].includes("the brain's address is not answering yet (503)."), progress[2]);
  assert.ok(progress[3].includes("Retrying 4/12 in"), progress[3]);
  assert.match(progress[4], /previous build.*Retrying 5\/12 in \d+ second\(s\)\./);
});

// A probe whose fetch hangs used to be allowed 15 seconds each, so twelve
// probes plus eleven waits could hold setup silently for about four minutes.
// Each probe's own timeout now comes out of the same one-minute budget.
test("hanging identity probes stay inside the propagation budget instead of multiplying it", async () => {
  const target = writeManifest();
  const { fetchImpl } = harness({ subdomainRead: "ok", health: "healthy" });
  let clock = 0;
  const timeouts = [];
  const request = async (_url, _init, { timeoutMs } = {}) => {
    timeouts.push(timeoutMs);
    clock += timeoutMs;
    throw new Error(`the health check timed out after ${timeoutMs} ms (fixture)`);
  };
  const wait = async (ms) => { clock += ms; };
  await assert.rejects(
    () => withFixture(fetchImpl, () => cmdDeploy(target, { wait, request, now: () => clock })),
    (error) => {
      assert.match(error.message, /exact account hostname was not confirmed as this brain/i);
      assert.match(error.message, /did not answer/);
      return true;
    },
  );
  assert.ok(timeouts.length >= 2, `expected more than one probe inside the budget, saw ${timeouts.length}`);
  assert.ok(timeouts.every((ms) => Number.isInteger(ms) && ms > 0 && ms <= 10_000),
    `each probe must be bounded, saw ${JSON.stringify(timeouts)}`);
  assert.ok(clock <= 65_000, `the gate held setup for ${clock} ms, far past its one-minute budget`);
  assert.ok(clock >= MIN_PROPAGATION_BUDGET_MS, `the gate gave up after ${clock} ms, before the propagation budget`);
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.brain?.domain, undefined);
});
