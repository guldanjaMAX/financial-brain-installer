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
  persistWorkersDevDomain,
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
      if (health === "healthy") return healthResponse({ brain: SLUG, version: VERSION });
      if (health === "wrong-brain") return healthResponse({ brain: "someone-else", version: VERSION });
      if (health === "down") throw new Error("fetch failed: connection refused (fixture)");
      throw new Error("this scenario must never probe /health");
    }
    throw new Error(`offline fixture has no response for ${method} ${path}`);
  };
  return { fetchImpl, calls, healthHosts };
}

async function withFixture(fetchImpl, run, { workersSubdomain = SUBDOMAIN_LABEL } = {}) {
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
