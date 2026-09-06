/**
 * The bank feed's configuration must reach the WORKER, not just the manifest.
 *
 * doctor.mjs validated corpora.bank_feed while the deploy emitted none of it,
 * so a manifest that passed every check produced a worker reporting the feed
 * unconfigured. This test asserts against the built bindings for that reason:
 * a check that inspects the manifest instead of the artifact is what let the
 * gap exist.
 */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerBindings, bankFeedWorkerVars, cmdDeploy } from "../brain.mjs";

const cfg = { d1_database_id: "db-1", storage: "d1", vectorize_index: "x-brain" };
const base = { client: { slug: "x", display_name: "X" }, infrastructure: { cloudflare: cfg } };
const nameOf = (bindings) => new Set(bindings.map((b) => b.name));
const valueOf = (bindings, name) => bindings.find((b) => b.name === name)?.text;

// A brain that does not use the feed carries no bank configuration at all.
const off = workerBindings({ ...base, corpora: { google_drive: { enabled: true } } }, cfg);
for (const n of [...nameOf(off)]) {
  assert.ok(!n.startsWith("BANK_FEED_"), `a disabled feed must emit no ${n}`);
}
assert.deepEqual(bankFeedWorkerVars({ corpora: {} }), []);

// The named Plaid profile pins its public endpoints and puts all runtime
// routing inputs on the worker without asking the manifest to duplicate them.
const on = workerBindings({
  ...base,
  corpora: {
    bank_feed: {
      enabled: true,
      provider: "plaid",
      environment: "sandbox",
      country_codes: ["US", "CA"],
      reconciliation_interval_minutes: 45,
    },
  },
}, cfg);

// BANK_FEED_API_BASE is the one bankFeedConfig() cannot start without.
assert.equal(valueOf(on, "BANK_FEED_API_BASE"), "https://sandbox.plaid.com",
  "the worker cannot configure the feed without its API base");
assert.equal(valueOf(on, "BANK_FEED_PROVIDER"), "plaid");
assert.equal(valueOf(on, "BANK_FEED_ENV"), "sandbox");
assert.equal(valueOf(on, "BANK_FEED_LINK_SDK_URL"), "https://cdn.plaid.com/link/v2/stable/link-initialize.js");
assert.equal(valueOf(on, "BANK_FEED_LINK_GLOBAL"), "Plaid");
assert.equal(valueOf(on, "BANK_FEED_DISPLAY_NAME"), "X");
assert.equal(valueOf(on, "BANK_FEED_COUNTRIES"), "US,CA");
assert.equal(valueOf(on, "BANK_FEED_RECONCILE_MINUTES"), "45");

// The environment is stated, never inferred, and never silently production.
const implicit = workerBindings({ ...base, corpora: { bank_feed: { enabled: true } } }, cfg);
assert.equal(valueOf(implicit, "BANK_FEED_ENV"), "sandbox",
  "an unstated environment must default to sandbox, never production");
assert.equal(valueOf(implicit, "BANK_FEED_PROVIDER"), "plaid",
  "the schema's omitted provider default must resolve to Plaid");
assert.equal(valueOf(implicit, "BANK_FEED_COUNTRIES"), "US");
assert.equal(valueOf(implicit, "BANK_FEED_RECONCILE_MINUTES"), "360");
const prod = workerBindings({ ...base, corpora: { bank_feed: { enabled: true, provider: "plaid", environment: "production" } } }, cfg);
assert.equal(valueOf(prod, "BANK_FEED_ENV"), "production");
assert.equal(valueOf(prod, "BANK_FEED_API_BASE"), "https://production.plaid.com");

// Pre-profile manifests remain a supported custom-provider path when they
// carry explicit endpoint metadata.
const legacyCustom = workerBindings({ ...base, corpora: { bank_feed: {
  enabled: true,
  api_base: "https://bank-provider.invalid",
  link_sdk_url: "https://cdn.bank-provider.invalid/link.js",
  link_global: "ProviderLink",
  entity_slug: "store-01",
} } }, cfg);
assert.equal(valueOf(legacyCustom, "BANK_FEED_PROVIDER"), "custom");
assert.equal(valueOf(legacyCustom, "BANK_FEED_API_BASE"), "https://bank-provider.invalid");
assert.equal(valueOf(legacyCustom, "BANK_FEED_ENTITY"), "store-01");

// A malformed raw manifest must stop before it can upload a generically routed
// or partially configured bank feed.
assert.throws(() => bankFeedWorkerVars({ corpora: { bank_feed: {
  enabled: true, provider: "plaid", api_base: "https://override.invalid",
} } }), /Plaid.*override/i);
assert.throws(() => bankFeedWorkerVars({ corpora: { bank_feed: {
  enabled: true, provider: "custom", api_base: "https://bank-provider.invalid",
} } }), /custom.*link_sdk_url.*link_global/i);
for (const apiBase of [
  "https://bank-provider.invalid/v1",
  "https://bank-provider.invalid/?tenant=fixture",
  "https://bank-provider.invalid/#api",
]) {
  assert.throws(() => bankFeedWorkerVars({ corpora: { bank_feed: {
    enabled: true,
    provider: "custom",
    api_base: apiBase,
    link_sdk_url: "https://cdn.bank-provider.invalid/link.js",
    link_global: "ProviderLink",
  } } }), /api_base.*origin/i, `custom API base must be an origin: ${apiBase}`);
}
assert.throws(() => bankFeedWorkerVars({ corpora: { bank_feed: {
  enabled: true, api_base: "https://legacy-provider.invalid",
} } }), /custom.*link_sdk_url.*link_global/i,
"one legacy endpoint must select custom and fail closed rather than fall through to Plaid");
assert.throws(() => bankFeedWorkerVars({ corpora: { bank_feed: {
  enabled: true, provider: "other",
} } }), /provider.*plaid.*custom/i);
assert.throws(() => bankFeedWorkerVars({ corpora: { bank_feed: {
  enabled: true, provider: "plaid", country_codes: ["us"],
} } }), /country_codes/i);
assert.throws(() => bankFeedWorkerVars({ corpora: { bank_feed: {
  enabled: true, provider: "plaid", reconciliation_interval_minutes: 5,
} } }), /reconciliation_interval_minutes/i);

// The rest of the worker is untouched by any of this.
for (const required of ["DB", "AI", "STORAGE", "BRAIN_NAME", "BRAIN_VERSION", "CHUNK_SIZE", "CREDENTIAL_SCANNER"]) {
  assert.ok(nameOf(on).has(required), `${required} must still be deployed`);
}

// Exercise the real deploy render, not just the helper. This stays wholly
// offline and inspects the metadata form Cloudflare would receive.
const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-bank-feed-deploy-")));
const apiResponse = (result) => new Response(JSON.stringify({ success: true, result, errors: [] }), {
  status: 200, headers: { "content-type": "application/json" },
});
function cloudflareHarness() {
  const metadata = [];
  let workerPuts = 0;
  const fetchImpl = async (input, options = {}) => {
    const path = new URL(String(input)).pathname;
    const method = options.method || "GET";
    if (path === "/client/v4/accounts" && method === "GET") {
      return apiResponse([{ id: "fixture-account", name: "Fixture" }]);
    }
    if (path.endsWith("/workers/scripts/x-brain") && method === "PUT") {
      workerPuts++;
      metadata.push(JSON.parse(await options.body.get("metadata").text()));
      return apiResponse({});
    }
    if (path.endsWith("/workers/scripts/x-brain/subdomain") && method === "POST") {
      return apiResponse({ enabled: true });
    }
    if (path.endsWith("/workers/scripts/x-brain/schedules") && method === "GET") {
      return apiResponse([{ cron: "* * * * *" }]);
    }
    throw new Error(`offline fixture has no response for ${method} ${path}`);
  };
  return { fetchImpl, metadata, get workerPuts() { return workerPuts; } };
}

async function withFixtureRuntime(fetchImpl, operation) {
  const priorFetch = globalThis.fetch;
  const priorToken = process.env.CLOUDFLARE_API_TOKEN;
  try {
    globalThis.fetch = fetchImpl;
    process.env.CLOUDFLARE_API_TOKEN = "fixture-token";
    return await operation();
  } finally {
    globalThis.fetch = priorFetch;
    if (priorToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = priorToken;
  }
}

try {
  const deployManifest = {
    ...base,
    brain: { worker_name: "x-brain", domain: "x-brain.example.invalid" },
    corpora: { bank_feed: {
      enabled: true, provider: "plaid", environment: "production",
      country_codes: ["US"], reconciliation_interval_minutes: 120,
    } },
  };
  const manifestPath = join(sandbox, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify(deployManifest));
  const harness = cloudflareHarness();
  await withFixtureRuntime(harness.fetchImpl, () => cmdDeploy(manifestPath, { nextSteps: false }));
  assert.equal(harness.workerPuts, 1);
  const deployed = harness.metadata[0].bindings;
  assert.equal(valueOf(deployed, "BANK_FEED_PROVIDER"), "plaid");
  assert.equal(valueOf(deployed, "BANK_FEED_API_BASE"), "https://production.plaid.com");
  assert.equal(valueOf(deployed, "BANK_FEED_DISPLAY_NAME"), "X");
  assert.equal(valueOf(deployed, "BANK_FEED_COUNTRIES"), "US");
  assert.equal(valueOf(deployed, "BANK_FEED_RECONCILE_MINUTES"), "120");

  const invalidHarness = cloudflareHarness();
  writeFileSync(manifestPath, JSON.stringify({
    ...deployManifest,
    corpora: { bank_feed: { enabled: true, provider: "plaid", api_base: "https://override.invalid" } },
  }));
  await assert.rejects(
    withFixtureRuntime(invalidHarness.fetchImpl, () => cmdDeploy(manifestPath, { nextSteps: false })),
    /Plaid.*override/i,
  );
  assert.equal(invalidHarness.workerPuts, 0, "an invalid named profile must never upload a Worker");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log("bank feed deploy path: named and legacy profiles render safely through the real deploy path");
