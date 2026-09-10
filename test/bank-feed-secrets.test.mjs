// test/bank-feed-secrets.test.mjs
//
// THE TRAP THIS FILE EXISTS FOR.
//
// `reconcileWorkerProviderSecrets` DELETES any worker secret that is in
// WORKER_PROVIDER_SECRET_NAMES and is not in the manifest-derived allowlist
// from `optionalWorkerSecretNames`. That is correct and deliberate: it is how a
// brain switched off Supabase stops carrying a Supabase credential.
//
// It is also how a bank feed silently dies. Add the provider credential names
// to the managed list WITHOUT teaching the allowlist to return them when the
// manifest enables the feed, and the next routine `brain secrets` run deletes
// them. The independent wrapping key follows a different rule: disabling sync
// preserves it because encrypted connection recovery still depends on it.
//
// So both halves are asserted here, against a REAL reconciliation run through
// `cmdSecrets` with an offline Cloudflare fixture. What is proven is not that a
// constant contains a string: it is that a reconciliation over a worker holding
// those secrets leaves the enabled set intact, removes only provider access
// when disabled, and preserves the independent wrapping key across that toggle.
//
// The second half of the file covers the other thing that cannot be fixed while
// a client is sitting in front of you: the return address registration.
//
// Every persona and identifier here is invented.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WORKER_PROVIDER_SECRET_NAMES, optionalWorkerSecretNames, cmdSecrets,
} from "../brain.mjs";
import { checkBankFeedRedirect, bankFeedRedirectUri, BANK_FEED_REDIRECT_PATH, OK, WARN, FAIL } from "../doctor.mjs";
import { redirectUriFor } from "../worker/src/lib/bank-feed.js";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 400)));
  if (!c) fail++;
};

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-bank-feed-secrets-")));
const FIXTURE_KEY = `fixture-admin-${"a".repeat(40)}`;
const SERVICE_NAMES = ["BANK_FEED_CLIENT_ID", "BANK_FEED_SECRET"];
const WRAPPING_NAME = "BANK_FEED_WRAPPING_KEY_V2";
const FEED_NAMES = [...SERVICE_NAMES, WRAPPING_NAME];
const FIXTURE_WRAPPING_KEY = `v2.${Buffer.alloc(32, 17).toString("base64url")}`;

function manifest({ bankFeed = false } = {}) {
  return {
    client: { slug: "fixture", display_name: "Fixture" },
    brain: { worker_name: "fixture-brain", domain: "fixture-brain.example.workers.dev" },
    infrastructure: { cloudflare: { account_id: "fixture-account" } },
    ...(bankFeed ? { corpora: { bank_feed: {
      enabled: true,
      provider: "plaid",
      environment: "sandbox",
    } } } : {}),
  };
}

function writeManifest(name, value) {
  const directory = join(sandbox, name);
  mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, "brain.manifest.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

const apiResponse = (result) => new Response(JSON.stringify({ success: true, result, errors: [] }), {
  status: 200, headers: { "content-type": "application/json" },
});

/** An offline Cloudflare, recording every secret write and delete in order. */
function cloudflareHarness(events, initialSecrets = []) {
  const secrets = new Set(initialSecrets);
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = options.method || "GET";
    if (url.pathname === "/client/v4/accounts" && method === "GET") {
      return apiResponse([{ id: "fixture-account", name: "Fixture account" }]);
    }
    if (url.pathname.endsWith("/workers/scripts/fixture-brain/secrets") && method === "GET") {
      return apiResponse([...secrets].map((name) => ({ name, type: "secret_text" })));
    }
    const one = url.pathname.match(/\/workers\/scripts\/fixture-brain\/secrets\/([^/]+)$/);
    if (one && method === "DELETE") {
      const name = decodeURIComponent(one[1]);
      events.push(`delete:${name}`);
      secrets.delete(name);
      return apiResponse({});
    }
    if (url.pathname.endsWith("/workers/scripts/fixture-brain/secrets") && method === "PUT") {
      const name = JSON.parse(String(options.body || "{}")).name;
      events.push(`set:${name}`);
      secrets.add(name);
      return apiResponse({});
    }
    throw new Error(`offline fixture has no response for ${method} ${url.pathname}`);
  };
  fetchImpl.secretNames = () => new Set(secrets);
  return fetchImpl;
}

async function isolatedRuntime({ fetchImpl, env }, operation) {
  const priorFetch = globalThis.fetch;
  const names = [
    "CLOUDFLARE_API_TOKEN", "ADMIN_KEY", "ANTHROPIC_API_KEY",
    "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", ...FEED_NAMES,
  ];
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const priorLog = console.log;
  const output = [];
  try {
    globalThis.fetch = fetchImpl;
    console.log = (...args) => output.push(args.map(String).join(" "));
    for (const name of names) delete process.env[name];
    for (const [name, value] of Object.entries(env || {})) process.env[name] = value;
    return { value: await operation(), output: output.join("\n") };
  } finally {
    globalThis.fetch = priorFetch;
    console.log = priorLog;
    for (const name of names) {
      if (prior[name] === undefined) delete process.env[name];
      else process.env[name] = prior[name];
    }
  }
}

const secretsOptions = { explicitAdminKey: FIXTURE_KEY, assertKeyDirSafe: () => {} };

try {
  /* ============ both halves of the trap, as constants ============ */
  {
    check("the feed's provider credentials are managed, so disabling sync removes provider access",
      SERVICE_NAMES.every((name) => WORKER_PROVIDER_SECRET_NAMES.includes(name)),
      JSON.stringify(WORKER_PROVIDER_SECRET_NAMES));
    check("the independent wrapping key is not deletion-managed by the sync toggle",
      !WORKER_PROVIDER_SECRET_NAMES.includes(WRAPPING_NAME),
      JSON.stringify(WORKER_PROVIDER_SECRET_NAMES));
    check("all three secrets are ALLOWED when the manifest enables the feed",
      FEED_NAMES.every((name) => optionalWorkerSecretNames(manifest({ bankFeed: true })).includes(name)),
      JSON.stringify(optionalWorkerSecretNames(manifest({ bankFeed: true }))));
    check("with the feed off no bank secret is eligible for a write from the local environment",
      FEED_NAMES.every((name) => !optionalWorkerSecretNames(manifest()).includes(name)),
      JSON.stringify(optionalWorkerSecretNames(manifest())));
    check("enabling the feed does not quietly widen any OTHER credential's eligibility",
      JSON.stringify(optionalWorkerSecretNames(manifest({ bankFeed: true }))) ===
      JSON.stringify([...FEED_NAMES]),
      JSON.stringify(optionalWorkerSecretNames(manifest({ bankFeed: true }))));
    check("`enabled: true` is required; a truthy-looking manifest value does not turn it on",
      optionalWorkerSecretNames({ corpora: { bank_feed: { enabled: "yes" } } }).length === 0, "");
  }

  /* ============ THE PROOF: a real reconciliation run ============ */
  {
    const events = [];
    let message = "";
    try {
      await isolatedRuntime({
        fetchImpl: cloudflareHarness(events, [
          "ADMIN_KEY", "RAG_PROXY_KEY", "SESSION_SIGNING_KEY", ...FEED_NAMES,
        ]),
        env: {
          CLOUDFLARE_API_TOKEN: "fixture-token",
          BANK_FEED_CLIENT_ID: "fixture-client-id",
          BANK_FEED_SECRET: "fixture-service-secret",
          BANK_FEED_WRAPPING_KEY_V2: FIXTURE_WRAPPING_KEY,
        },
      }, () => cmdSecrets(writeManifest("feed-on", manifest({ bankFeed: true })), secretsOptions));
    } catch (error) {
      message = String(error?.message || error);
    }

    check("THE LEGACY ENVIRONMENT PATH CANNOT WRITE ANY BANK SECRET",
      /not accepted from environment variables or by `brain secrets`/i.test(message) &&
      /brain technician <manifest> --run plaid/i.test(message) && events.length === 0,
      `${message.slice(0, 240)} ${JSON.stringify(events)}`);
    check("the legacy-path refusal repeats no provider or wrapping-key value",
      !message.includes("fixture-client-id") && !message.includes("fixture-service-secret") &&
      !message.includes(FIXTURE_WRAPPING_KEY), message.slice(0, 240));
  }

  {
    const events = [];
    const customManifest = manifest({ bankFeed: true });
    customManifest.corpora.bank_feed.provider = "custom";
    let message = "";
    try {
      await isolatedRuntime({
        fetchImpl: cloudflareHarness(events, []),
        env: {
          CLOUDFLARE_API_TOKEN: "fixture-token",
          BANK_FEED_CLIENT_ID: "fixture-client-id",
          BANK_FEED_SECRET: "fixture-service-secret",
        },
      }, () => cmdSecrets(writeManifest("custom-feed-env", customManifest), secretsOptions));
    } catch (error) {
      message = String(error?.message || error);
    }
    check("a custom provider is held instead of being misrouted into the native Plaid ceremony",
      /custom bank provider has no reviewed credential ceremony and remains held/i.test(message) &&
      !/brain technician <manifest> --run plaid/i.test(message) && events.length === 0,
      `${message.slice(0, 240)} ${JSON.stringify(events)}`);
  }

  {
    const events = [];
    await isolatedRuntime({
      fetchImpl: cloudflareHarness(events, ["ADMIN_KEY", ...FEED_NAMES]),
      env: { CLOUDFLARE_API_TOKEN: "fixture-token" },
    }, () => cmdSecrets(writeManifest("feed-on-reuse", manifest({ bankFeed: true })), secretsOptions));
    check("an enabled update preserves an existing wrapping key when no local replacement is supplied",
      !events.includes("delete:BANK_FEED_WRAPPING_KEY_V2") &&
      !events.includes("set:BANK_FEED_WRAPPING_KEY_V2"), JSON.stringify(events));
  }

  {
    const events = [];
    const fetchImpl = cloudflareHarness(events, []);
    let message = "";
    try {
      await isolatedRuntime({
        fetchImpl,
        env: { CLOUDFLARE_API_TOKEN: "fixture-token" },
      }, () => cmdSecrets(writeManifest("feed-incomplete", manifest({ bankFeed: true })), secretsOptions));
    } catch (error) {
      message = String(error?.message || error);
    }
    check("a fresh enabled feed bootstraps the core proof keys before its held bank-secret gate",
      /BANK_FEED_CLIENT_ID/.test(message) && /BANK_FEED_SECRET/.test(message) &&
      /BANK_FEED_WRAPPING_KEY_V2/.test(message) &&
      /core access secrets may already have been updated/i.test(message) &&
      /brain technician <manifest> --run plaid/i.test(message) &&
      ["ADMIN_KEY", "RAG_PROXY_KEY", "SESSION_SIGNING_KEY"].every((name) =>
        events.includes(`set:${name}`) && fetchImpl.secretNames().has(name)) &&
      FEED_NAMES.every((name) => !events.includes(`set:${name}`) && !fetchImpl.secretNames().has(name)),
      `${message.slice(0, 240)} ${JSON.stringify(events)}`);
  }

  {
    const events = [];
    let message = "";
    try {
      await isolatedRuntime({
        fetchImpl: cloudflareHarness(events, ["ADMIN_KEY", ...FEED_NAMES]),
        env: {
          CLOUDFLARE_API_TOKEN: "fixture-token",
          BANK_FEED_CLIENT_ID: "fixture-replacement-client",
        },
      }, () => cmdSecrets(writeManifest("feed-partial-service-rotation", manifest({ bankFeed: true })), secretsOptions));
    } catch (error) {
      message = String(error?.message || error);
    }
    check("even one ambient provider value is delegated to the owner-only atomic ceremony",
      /not accepted from environment variables or by `brain secrets`/i.test(message) &&
      /brain technician <manifest> --run plaid/i.test(message) && events.length === 0,
      `${message.slice(0, 240)} ${JSON.stringify(events)}`);
  }

  {
    const events = [];
    const fetchImpl = cloudflareHarness(events, ["ADMIN_KEY", WRAPPING_NAME]);
    let message = "";
    try {
      await isolatedRuntime({
        fetchImpl,
        env: {
          CLOUDFLARE_API_TOKEN: "fixture-token",
          BANK_FEED_CLIENT_ID: "fixture-client-id",
          BANK_FEED_SECRET: "fixture-service-secret",
        },
      }, () => cmdSecrets(writeManifest("feed-existing-wrap", manifest({ bankFeed: true })), secretsOptions));
    } catch (error) {
      message = String(error?.message || error);
    }
    check("an existing wrapping key still cannot make the legacy provider-pair path safe",
      /owner-only/i.test(message) && events.length === 0 && fetchImpl.secretNames().has(WRAPPING_NAME),
      `${message.slice(0, 200)} ${JSON.stringify(events)}`);
  }

  {
    const events = [];
    let message = "";
    try {
      await isolatedRuntime({
        fetchImpl: cloudflareHarness(events, []),
        env: {
          CLOUDFLARE_API_TOKEN: "fixture-token",
          BANK_FEED_WRAPPING_KEY_V2: "fixture-invalid-key",
        },
      }, () => cmdSecrets(writeManifest("feed-invalid-key", manifest({ bankFeed: true })), secretsOptions));
    } catch (error) {
      message = String(error?.message || error);
    }
    check("a supplied wrapping key is refused before validation or remote mutation",
      /not accepted from environment variables or by `brain secrets`/i.test(message) && events.length === 0,
      `${message.slice(0, 180)} ${JSON.stringify(events)}`);
    check("the invalid wrapping value is never repeated in the failure",
      !message.includes("fixture-invalid-key"), message.slice(0, 180));
  }

  {
    const events = [];
    await isolatedRuntime({
      fetchImpl: cloudflareHarness(events, [
        "ADMIN_KEY", "RAG_PROXY_KEY", "SESSION_SIGNING_KEY", ...FEED_NAMES, "UNRELATED_FIXTURE_SECRET",
      ]),
      env: { CLOUDFLARE_API_TOKEN: "fixture-token" },
    }, () => cmdSecrets(writeManifest("feed-off", manifest()), secretsOptions));

    check("with the feed OFF the same run removes the provider credentials",
      SERVICE_NAMES.every((name) => events.includes(`delete:${name}`)), JSON.stringify(events));
    check("with the feed OFF the same run preserves the independent recovery wrapping key",
      !events.includes(`delete:${WRAPPING_NAME}`), JSON.stringify(events));
    check("and it still never touches a secret name it does not manage",
      !events.includes("delete:UNRELATED_FIXTURE_SECRET"), JSON.stringify(events));
  }

  {
    // The regression this whole file is named after: the managed list gains the
    // names and the allowlist does not. Simulated by asking the allowlist for a
    // manifest that does NOT enable the feed while the worker holds the
    // secrets — which is exactly the state a half-done change produces.
    const allowed = new Set(optionalWorkerSecretNames(manifest()));
    const wouldDelete = WORKER_PROVIDER_SECRET_NAMES.filter((name) => !allowed.has(name));
    check("the allowlist protects enabled provider credentials while the wrapping key stays outside deletion management",
      SERVICE_NAMES.every((name) => wouldDelete.includes(name)) &&
      SERVICE_NAMES.every((name) =>
        !WORKER_PROVIDER_SECRET_NAMES.filter((n) => !new Set(optionalWorkerSecretNames(manifest({ bankFeed: true }))).has(n))
          .includes(name)) && !wouldDelete.includes(WRAPPING_NAME),
      JSON.stringify(wouldDelete));
  }

  {
    const events = [];
    const fetchImpl = cloudflareHarness(events, ["ADMIN_KEY", ...FEED_NAMES]);
    const enabledPath = writeManifest("lifecycle-enabled", manifest({ bankFeed: true }));
    const disabledPath = writeManifest("lifecycle-disabled", manifest());
    await isolatedRuntime({
      fetchImpl,
      env: { CLOUDFLARE_API_TOKEN: "fixture-token" },
    }, () => cmdSecrets(disabledPath, secretsOptions));
    const disabledEvents = [...events];
    const afterDisable = events.length;
    let message = "";
    try {
      await isolatedRuntime({
        fetchImpl,
        env: { CLOUDFLARE_API_TOKEN: "fixture-token" },
      }, () => cmdSecrets(enabledPath, secretsOptions));
    } catch (error) {
      message = String(error?.message || error);
    }
    const reenabledEvents = events.slice(afterDisable);
    check("disabled to held re-enable preserves the exact existing wrapping-key binding",
      disabledEvents.every((event) => event !== `delete:${WRAPPING_NAME}`) &&
      reenabledEvents.every((event) => event !== `set:${WRAPPING_NAME}`) &&
      fetchImpl.secretNames().has(WRAPPING_NAME) && /missing required Worker secrets/i.test(message),
      JSON.stringify({ message, disabledEvents, reenabledEvents }));
  }

  /* ============ deploy before secrets ============ */
  {
    const events = [];
    let message = "";
    const missingScript = async (input, options = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/client/v4/accounts") return apiResponse([{ id: "fixture-account", name: "Fixture" }]);
      if (url.pathname.endsWith("/secrets") && (options.method || "GET") === "GET") return apiResponse([]);
      return new Response(JSON.stringify({
        success: false, result: null,
        errors: [{ code: 10007, message: "workers.api.error.script_not_found This Worker does not exist on your account" }],
      }), { status: 404, headers: { "content-type": "application/json" } });
    };
    try {
      await isolatedRuntime({
        fetchImpl: missingScript,
        env: { CLOUDFLARE_API_TOKEN: "fixture-token" },
      }, () => cmdSecrets(writeManifest("no-worker", manifest()), secretsOptions));
    } catch (error) {
      message = String(error?.message || error);
    }
    check("ORDER IS DEPLOY THEN SECRETS: setting secrets on a worker that is not there says so, in those words",
      /has not been deployed yet/.test(message) && /brain deploy/.test(message), message.slice(0, 200));
    check("and the failure never echoes the admin key or a service secret back",
      !message.includes(FIXTURE_KEY) && !message.includes("fixture-service-secret"), message.slice(0, 200));
    void events;
  }

  /* ============ the return address, checked before the session ============ */
  {
    check("the two runtimes agree on the return address path, so the check cannot drift from the route",
      BANK_FEED_REDIRECT_PATH === "/app/connect/bank" &&
      redirectUriFor("https://fixture-brain.example.workers.dev/x") ===
        bankFeedRedirectUri("fixture-brain.example.workers.dev"),
      `${BANK_FEED_REDIRECT_PATH} vs ${redirectUriFor("https://fixture-brain.example.workers.dev/x")}`);

    const off = checkBankFeedRedirect(manifest());
    check("a brain not using the feed passes without noise", off.status === OK && /not in use/.test(off.detail), JSON.stringify(off));

    const undeployed = checkBankFeedRedirect({ ...manifest({ bankFeed: true }), brain: { worker_name: "x" } });
    check("before deploy there is no address to check, and it says to deploy first",
      undeployed.status === WARN && /brain deploy/.test(undeployed.fix), JSON.stringify(undeployed));

    const unregistered = checkBankFeedRedirect(manifest({ bankFeed: true }));
    check("THE CHECK THAT SAVES A SESSION: an unregistered return address is a FAILURE, found in advance",
      unregistered.status === FAIL, JSON.stringify(unregistered));
    check("and the fix carries the exact address to register, and where to register it",
      unregistered.fix.includes("https://fixture-brain.example.workers.dev/app/connect/bank") &&
      /CLIENT'S OWN/.test(unregistered.fix), unregistered.fix);
    check("and it says what happens if it is skipped, so it is not filed as a nag",
      /land on a dead return/.test(unregistered.fix), unregistered.fix);

    const halfConfigured = checkBankFeedRedirect({
      ...manifest({ bankFeed: true }),
      corpora: { bank_feed: {
        enabled: true,
        registered_redirect_uris: ["https://fixture-brain.example.workers.dev/app/connect/bank"],
        registered_webhook_uris: ["https://fixture-brain.example.workers.dev/api/webhooks/plaid"],
      } },
    });
    check("an omitted provider and environment cannot look ready to doctor when the ceremony will refuse it",
      halfConfigured.status === FAIL && /provider or environment is invalid/.test(halfConfigured.detail), JSON.stringify(halfConfigured));
    const partialLegacy = checkBankFeedRedirect({
      ...manifest({ bankFeed: true }),
      corpora: { bank_feed: { enabled: true, provider: "custom", environment: "sandbox",
        api_base: "https://sandbox.provider.invalid",
        registered_redirect_uris: ["https://fixture-brain.example.workers.dev/app/connect/bank"],
        registered_webhook_uris: ["https://fixture-brain.example.workers.dev/api/webhooks/plaid"] } },
    });
    check("partial legacy endpoint configuration fails before a customer session",
      partialLegacy.status === FAIL && /link_sdk_url/.test(partialLegacy.fix), JSON.stringify(partialLegacy));

    const ready = checkBankFeedRedirect({
      ...manifest({ bankFeed: true }),
      corpora: { bank_feed: {
        enabled: true, provider: "custom", environment: "sandbox",
        registered_redirect_uris: ["https://fixture-brain.example.workers.dev/app/connect/bank"],
        registered_webhook_uris: ["https://fixture-brain.example.workers.dev/api/webhooks/plaid"],
        api_base: "https://sandbox.provider.invalid",
        link_sdk_url: "https://cdn.provider.invalid/link.js",
        link_global: "ProviderLink",
      } },
    });
    check("a fully prepared install passes and names the environment it will rehearse in",
      ready.status === OK && /sandbox/.test(ready.detail), JSON.stringify(ready));
    check("a different brain's registered address does not satisfy this brain's check",
      checkBankFeedRedirect({
        ...manifest({ bankFeed: true }),
        corpora: { bank_feed: {
          enabled: true, provider: "plaid", environment: "sandbox",
          registered_redirect_uris: ["https://other-brain.example.workers.dev/app/connect/bank"],
          registered_webhook_uris: ["https://fixture-brain.example.workers.dev/api/webhooks/plaid"],
        } },
      }).status === FAIL, "");
    const missingWebhook = checkBankFeedRedirect({
      ...manifest({ bankFeed: true }),
      corpora: { bank_feed: {
        enabled: true, provider: "plaid", environment: "sandbox",
        registered_redirect_uris: ["https://fixture-brain.example.workers.dev/app/connect/bank"],
      } },
    });
    check("Plaid also fails before the session when its exact signed webhook is not recorded",
      missingWebhook.status === FAIL &&
      missingWebhook.fix.includes("https://fixture-brain.example.workers.dev/api/webhooks/plaid") &&
      /registered_webhook_uris/.test(missingWebhook.fix), JSON.stringify(missingWebhook));
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n${fail ? "FAILURES" : "bank-feed-secrets"}: ${ran - fail}/${ran} checks passed`);
process.exit(fail ? 1 : 0);
