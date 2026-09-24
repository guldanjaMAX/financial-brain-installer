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
import { cmdDeploy } from "../brain.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

const ACCOUNT_ID = "acct-403-fixture";
const SLUG = "acme";
const SCRIPT_NAME = "acme-brain";
const SUBDOMAIN_LABEL = "acme-cf";
const CANDIDATE_DOMAIN = `${SCRIPT_NAME}.${SUBDOMAIN_LABEL}.workers.dev`;

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
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init.method || "GET";
    calls.push(`${method} ${path}`);
    if (path === "/client/v4/accounts" && method === "GET") {
      return apiResponse([{ id: ACCOUNT_ID, name: "Acme" }]);
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
      if (health === "healthy") return healthResponse({ brain: SLUG, version: VERSION });
      if (health === "wrong-brain") return healthResponse({ brain: "someone-else", version: VERSION });
      if (health === "down") throw new Error("fetch failed: connection refused (fixture)");
      throw new Error("this scenario must never probe /health");
    }
    throw new Error(`offline fixture has no response for ${method} ${path}`);
  };
  return { fetchImpl, calls };
}

async function withFixture(fetchImpl, run) {
  const priorFetch = globalThis.fetch;
  const priorToken = process.env.CLOUDFLARE_API_TOKEN;
  try {
    globalThis.fetch = fetchImpl;
    process.env.CLOUDFLARE_API_TOKEN = "fixture-token";
    return await run();
  } finally {
    globalThis.fetch = priorFetch;
    if (priorToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = priorToken;
  }
}

test("a 403 on the subdomain read, plus a healthy /health for this brain, completes deploy and persists brain.domain", async () => {
  const target = writeManifest();
  const { fetchImpl, calls } = harness({ subdomainRead: "denied", health: "healthy" });
  await withFixture(fetchImpl, () => cmdDeploy(target, {
    knownAccountSubdomain: SUBDOMAIN_LABEL,
    wait: async () => {},
  }));
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.brain?.domain, CANDIDATE_DOMAIN);
  assert.ok(calls.includes("GET /health"), "the candidate must be verified live, not merely assumed");
});

test("a 403 on the subdomain read, plus /health for the wrong brain, dies with the actionable message", async () => {
  const target = writeManifest();
  const { fetchImpl } = harness({ subdomainRead: "denied", health: "wrong-brain" });
  await assert.rejects(
    () => withFixture(fetchImpl, () => cmdDeploy(target, {
      knownAccountSubdomain: SUBDOMAIN_LABEL,
      wait: async () => {},
    })),
    (error) => {
      assert.match(error.message, /Workers Scripts Read on the account, for the subdomain/,
        "the exact missing scope must be named");
      assert.match(error.message, /not "acme"/, "the identity mismatch must be visible");
      assert.match(error.message, /brain setup/);
      assert.match(error.message, /instead of recreating/i,
        "the message must state resuming is safe, not just possible");
      return true;
    },
  );
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.brain?.domain, undefined, "a candidate that failed identity must never be saved");
});

test("a 403 on the subdomain read, plus /health down, dies with the actionable message", async () => {
  const target = writeManifest();
  const { fetchImpl } = harness({ subdomainRead: "denied", health: "down" });
  await assert.rejects(
    () => withFixture(fetchImpl, () => cmdDeploy(target, {
      knownAccountSubdomain: SUBDOMAIN_LABEL,
      wait: async () => {},
    })),
    (error) => {
      assert.match(error.message, /Workers Scripts Read on the account, for the subdomain/,
        "the exact missing scope must be named even when there was nothing to probe successfully");
      assert.match(error.message, /confirm the brain's public address/);
      assert.match(error.message, /instead of recreating/i);
      return true;
    },
  );
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.brain?.domain, undefined);
});

test("the normal token path is unchanged: a successful subdomain read still persists brain.domain, with no health probe", async () => {
  const target = writeManifest();
  const { fetchImpl, calls } = harness({ subdomainRead: "ok" });
  await withFixture(fetchImpl, () => cmdDeploy(target, { wait: async () => {} }));
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.brain?.domain, CANDIDATE_DOMAIN);
  assert.ok(!calls.includes("GET /health"), "a working credential must never need the fallback probe");
});
