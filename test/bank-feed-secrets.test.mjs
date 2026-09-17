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
// The second half of the file covers the other things that cannot be fixed while
// a client is sitting in front of you: exact return and webhook registration.
//
// Every persona and identifier here is invented.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WORKER_PROVIDER_SECRET_NAMES, optionalWorkerSecretNames, cmdSecrets, cmdConnectBank,
  readBankFeedKeyHidden, openPromptsForTesting, promptsOpenForTesting,
} from "../brain.mjs";
import {
  checkBankFeedRedirect,
  bankFeedRedirectUri,
  plaidWebhookUri,
  BANK_FEED_REDIRECT_PATH,
  PLAID_WEBHOOK_PATH,
  OK,
  WARN,
  FAIL,
} from "../doctor.mjs";
import { redirectUriFor } from "../worker/src/lib/bank-feed.js";
import { PLAID_WEBHOOK_PATH as WORKER_PLAID_WEBHOOK_PATH } from "../worker/src/lib/plaid-protocol.js";

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
    ...(bankFeed ? { corpora: { bank_feed: { enabled: true } } } : {}),
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
function cloudflareHarness(events, initialSecrets = [], { dropWrites = false } = {}) {
  const secrets = new Set(initialSecrets);
  // Written values are kept apart from `events`, which failure details print.
  const values = new Map();
  let lists = 0;
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = options.method || "GET";
    if (url.pathname === "/client/v4/accounts" && method === "GET") {
      return apiResponse([{ id: "fixture-account", name: "Fixture account" }]);
    }
    if (url.pathname.endsWith("/workers/scripts/fixture-brain/secrets") && method === "GET") {
      lists++;
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
      const body = JSON.parse(String(options.body || "{}"));
      events.push(`set:${body.name}`);
      if (body.type !== "secret_text") events.push(`wrong-type:${body.name}`);
      values.set(body.name, body.text);
      if (!dropWrites) secrets.add(body.name);
      return apiResponse({});
    }
    throw new Error(`offline fixture has no response for ${method} ${url.pathname}`);
  };
  fetchImpl.secretNames = () => new Set(secrets);
  fetchImpl.secretValue = (name) => values.get(name);
  fetchImpl.listCount = () => lists;
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
    check("all three existing Worker secrets are preserved when the manifest enables the feed",
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
    const cases = [
      ["BANK_FEED_CLIENT_ID", "fixture-client-id"],
      ["BANK_FEED_SECRET", "fixture-service-secret"],
      ["BANK_FEED_WRAPPING_KEY_V2", FIXTURE_WRAPPING_KEY],
      ["BANK_FEED_SECRET", ""],
    ];
    const outcomes = [];
    for (const [name, value] of cases) {
      const events = [];
      const localMutations = [];
      let message = "";
      try {
        await isolatedRuntime({
          fetchImpl: cloudflareHarness(events, ["ADMIN_KEY", ...FEED_NAMES]),
          env: { CLOUDFLARE_API_TOKEN: "fixture-token", [name]: value },
        }, () => cmdSecrets(
          writeManifest(`ambient-${name.toLowerCase()}-${outcomes.length}`, manifest({ bankFeed: true })),
          {
            ...secretsOptions,
            gitignoreTheKey: () => localMutations.push("gitignore"),
            persistAdminKeyDurably: async () => {
              localMutations.push("persist");
              throw new Error("must not be reached");
            },
          },
        ));
      } catch (error) {
        message = String(error?.message || error);
      }
      outcomes.push({ name, value, events, localMutations, message });
    }
    check("EVERY AMBIENT BANK SECRET IS REFUSED BEFORE LOCAL OR WORKER MUTATION",
      outcomes.every(({ name, events, localMutations, message }) =>
        message.includes(name) &&
        /not accepted from environment variables or by `brain secrets`/i.test(message) &&
        /credential setup remains held/i.test(message) &&
        /separately reviewed owner-custody process/i.test(message) &&
        events.length === 0 && localMutations.length === 0),
      JSON.stringify(outcomes.map(({ name, events, localMutations, message }) => ({
        name, events, localMutations, message: message.slice(0, 180),
      }))));
    check("the ambient-secret refusal repeats no provider or wrapping-key value",
      outcomes.every(({ value, message }) => !value || !message.includes(value)),
      JSON.stringify(outcomes.map(({ name, message }) => ({ name, message: message.slice(0, 180) }))));
  }

  {
    const events = [];
    await isolatedRuntime({
      fetchImpl: cloudflareHarness(events, ["ADMIN_KEY", ...FEED_NAMES]),
      env: { CLOUDFLARE_API_TOKEN: "fixture-token" },
    }, () => cmdSecrets(writeManifest("feed-on-reuse", manifest({ bankFeed: true })), secretsOptions));
    check("an enabled core-key repair preserves every existing bank secret without rewriting one",
      FEED_NAMES.every((name) =>
        !events.includes(`delete:${name}`) && !events.includes(`set:${name}`)) &&
      ["ADMIN_KEY", "RAG_PROXY_KEY", "SESSION_SIGNING_KEY"].every((name) =>
        events.includes(`set:${name}`)), JSON.stringify(events));
  }

  {
    const events = [];
    const localMutations = [];
    let message = "";
    try {
      await isolatedRuntime({
        fetchImpl: cloudflareHarness(events, ["ADMIN_KEY"]),
        env: { CLOUDFLARE_API_TOKEN: "fixture-token" },
      }, () => cmdSecrets(writeManifest("feed-incomplete", manifest({ bankFeed: true })), {
        ...secretsOptions,
        gitignoreTheKey: () => localMutations.push("gitignore"),
        persistAdminKeyDurably: async () => {
          localMutations.push("persist");
          throw new Error("must not be reached");
        },
      }));
    } catch (error) {
      message = String(error?.message || error);
    }
    check("a fresh enabled feed stops before any core-key or local mutation",
      /BANK_FEED_CLIENT_ID/.test(message) && /BANK_FEED_SECRET/.test(message) &&
      /BANK_FEED_WRAPPING_KEY_V2/.test(message) &&
      /credential setup remains held/i.test(message) &&
      /separately reviewed owner-custody process/i.test(message) &&
      !/ceremony/i.test(message) && events.length === 0 && localMutations.length === 0,
      `${message.slice(0, 280)} ${JSON.stringify({ events, localMutations })}`);
  }

  {
    const events = [];
    const localMutations = [];
    let message = "";
    try {
      await isolatedRuntime({
        fetchImpl: cloudflareHarness(events, [
          "ADMIN_KEY", "BANK_FEED_CLIENT_ID", "BANK_FEED_SECRET", "SUPABASE_SERVICE_ROLE_KEY",
        ]),
        env: { CLOUDFLARE_API_TOKEN: "fixture-token" },
      }, () => cmdSecrets(writeManifest("feed-partial-worker", manifest({ bankFeed: true })), {
        ...secretsOptions,
        gitignoreTheKey: () => localMutations.push("gitignore"),
        persistAdminKeyDurably: async () => {
          localMutations.push("persist");
          throw new Error("must not be reached");
        },
      }));
    } catch (error) {
      message = String(error?.message || error);
    }
    check("a partial bank inventory refuses before unrelated cleanup or core-key rotation",
      /BANK_FEED_WRAPPING_KEY_V2/.test(message) &&
      /credential setup remains held/i.test(message) &&
      events.length === 0 && localMutations.length === 0,
      `${message.slice(0, 240)} ${JSON.stringify({ events, localMutations })}`);
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
    check("disabled to held re-enable preserves wrapping-key custody and refuses missing provider bindings",
      disabledEvents.every((event) => event !== `delete:${WRAPPING_NAME}`) &&
      reenabledEvents.every((event) => event !== `set:${WRAPPING_NAME}`) &&
      fetchImpl.secretNames().has(WRAPPING_NAME) &&
      /missing required Worker secrets/i.test(message) && reenabledEvents.length === 0,
      JSON.stringify({ message, disabledEvents, reenabledEvents }));
  }


  /* ============ owner custody: `brain connect bank` hidden prompt ============ */
  const PLAID_CLIENT_ID = "plaid-client-id-placeholder";
  const PLAID_SECRET = "plaid-secret-placeholder";
  const bankManifest = () => ({
    ...manifest(),
    corpora: { bank_feed: {
      enabled: true, provider: "plaid", environment: "sandbox",
      registered_redirect_uris: ["https://fixture-brain.example.workers.dev/app/connect/bank"],
      registered_webhook_uris: ["https://fixture-brain.example.workers.dev/api/webhooks/plaid"],
    } },
  });
  const ownerPrompt = (prompts, answers = [PLAID_CLIENT_ID, PLAID_SECRET]) => async (text) => {
    prompts.push(text);
    return answers[prompts.length - 1];
  };
  async function connectBank(name, { initial, env = {}, answers, harness = {} }) {
    const events = [];
    const prompts = [];
    const opened = [];
    const fetchImpl = cloudflareHarness(events, initial, harness);
    let result = null;
    let message = "";
    let output = "";
    try {
      ({ value: result, output } = await isolatedRuntime({
        fetchImpl,
        env: { CLOUDFLARE_API_TOKEN: "fixture-token", ...env },
      }, () => cmdConnectBank(writeManifest(name, bankManifest()), {}, {
        readSecret: ownerPrompt(prompts, answers),
        openImpl: (url) => { opened.push(url); return true; },
      })));
    } catch (error) {
      message = String(error?.message || error);
    }
    return { events, prompts, opened, fetchImpl, result, message, output };
  }

  {
    const run = await connectBank("connect-absent", { initial: ["ADMIN_KEY"] });
    const wrapping = run.fetchImpl.secretValue(WRAPPING_NAME);
    check("CONNECT BANK, ABSENT: the owner is prompted once for each Plaid value",
      run.prompts.length === 2 && /client_id/.test(run.prompts[0]) && /secret/.test(run.prompts[1]) &&
      run.prompts.every((text) => /hidden/.test(text)),
      JSON.stringify({ prompts: run.prompts, message: run.message.slice(0, 200) }));
    check("CONNECT BANK, ABSENT: all three are written as secret_text before the browser opens",
      JSON.stringify(run.events) === JSON.stringify(FEED_NAMES.map((name) => `set:${name}`)) &&
      run.fetchImpl.secretValue("BANK_FEED_CLIENT_ID") === PLAID_CLIENT_ID &&
      run.fetchImpl.secretValue("BANK_FEED_SECRET") === PLAID_SECRET &&
      /^v2\.[A-Za-z0-9_-]{43}$/.test(wrapping || "") &&
      run.opened.length === 1 && run.result?.opened === true,
      JSON.stringify({ events: run.events, opened: run.opened, message: run.message.slice(0, 200) }));
    check("CONNECT BANK, ABSENT: the Worker is re-listed after the writes and holds every name",
      run.fetchImpl.listCount() === 2 && FEED_NAMES.every((name) => run.fetchImpl.secretNames().has(name)) &&
      JSON.stringify(run.result?.secrets_written) === JSON.stringify(FEED_NAMES),
      JSON.stringify({ lists: run.fetchImpl.listCount(), written: run.result?.secrets_written }));
    check("CONNECT BANK, ABSENT: output names the secrets and never prints a value",
      FEED_NAMES.every((name) => run.output.includes(name)) &&
      [PLAID_CLIENT_ID, PLAID_SECRET, wrapping].every((value) => value && !run.output.includes(value)),
      "output withheld: it would be the leak being tested");
  }

  {
    // An earlier ask() readline left attached to stdin echoes what the owner
    // types at the hidden prompt, so the default reader must close it first.
    openPromptsForTesting();
    const openBefore = promptsOpenForTesting();
    const seen = [];
    await readBankFeedKeyHidden("  Plaid secret (hidden): ", {
      read: async (text, options) => { seen.push({ text, open: promptsOpenForTesting(), noun: options.noun }); return ""; },
    });
    check("CONNECT BANK, PROMPT: an open ask() readline is closed before the hidden Plaid prompt reads",
      openBefore === true && seen.length === 1 && seen[0].open === false && seen[0].noun === "Plaid key",
      JSON.stringify({ openBefore, seen }));
  }

  {
    const run = await connectBank("connect-present", { initial: ["ADMIN_KEY", ...FEED_NAMES] });
    check("CONNECT BANK, PRESENT: nothing is prompted or written and the page still opens",
      run.prompts.length === 0 && run.events.length === 0 && run.fetchImpl.listCount() === 1 &&
      run.opened.length === 1 && run.result?.secrets_written?.length === 0,
      JSON.stringify({ prompts: run.prompts, events: run.events, message: run.message.slice(0, 200) }));
  }

  {
    const outcomes = [];
    for (const [name, value] of [
      ["BANK_FEED_CLIENT_ID", PLAID_CLIENT_ID],
      ["BANK_FEED_SECRET", PLAID_SECRET],
      [WRAPPING_NAME, FIXTURE_WRAPPING_KEY],
      ["BANK_FEED_SECRET", ""],
    ]) {
      const run = await connectBank(`connect-env-${outcomes.length}`, {
        initial: ["ADMIN_KEY"], env: { [name]: value },
      });
      outcomes.push({ name, value, ...run });
    }
    check("CONNECT BANK, ENV-SUPPLIED: refused before any Cloudflare read, prompt, write, or browser",
      outcomes.every(({ name, message, prompts, events, opened, fetchImpl }) =>
        message.includes(name) && /not accepted from environment variables/i.test(message) &&
        prompts.length === 0 && events.length === 0 && opened.length === 0 && fetchImpl.listCount() === 0),
      JSON.stringify(outcomes.map(({ name, message, events }) => ({ name, events, message: message.slice(0, 160) }))));
    check("CONNECT BANK, ENV-SUPPLIED: the refusal repeats no value",
      outcomes.every(({ value, message }) => !value || !message.includes(value)), "");
  }

  {
    // Disabling sync deletes the provider pair and keeps the wrapping key. The
    // re-enable must restore the pair without regenerating recovery custody.
    const run = await connectBank("connect-reenable", { initial: ["ADMIN_KEY", WRAPPING_NAME] });
    check("CONNECT BANK, RE-ENABLE: an existing wrapping key is never replaced",
      run.prompts.length === 2 &&
      JSON.stringify(run.events) === JSON.stringify(SERVICE_NAMES.map((name) => `set:${name}`)) &&
      run.fetchImpl.secretValue(WRAPPING_NAME) === undefined && run.opened.length === 1,
      JSON.stringify({ events: run.events, message: run.message.slice(0, 200) }));
  }

  {
    const run = await connectBank("connect-unverified", {
      initial: ["ADMIN_KEY"], harness: { dropWrites: true },
    });
    check("CONNECT BANK, UNVERIFIED: a write the re-list does not show stops before Plaid Link",
      /did not list/i.test(run.message) && run.opened.length === 0 &&
      ![PLAID_CLIENT_ID, PLAID_SECRET].some((value) => run.message.includes(value)),
      JSON.stringify({ events: run.events, message: run.message.slice(0, 200) }));
  }

  {
    const run = await connectBank("connect-blank", { initial: ["ADMIN_KEY"], answers: ["", PLAID_SECRET] });
    check("CONNECT BANK, BLANK ENTRY: nothing is written when the owner enters no value",
      /no value was entered for BANK_FEED_CLIENT_ID/.test(run.message) &&
      run.events.length === 0 && run.opened.length === 0,
      JSON.stringify({ events: run.events, message: run.message.slice(0, 200) }));
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
    check("the two runtimes agree on the return and Plaid webhook paths",
      BANK_FEED_REDIRECT_PATH === "/app/connect/bank" &&
      PLAID_WEBHOOK_PATH === WORKER_PLAID_WEBHOOK_PATH &&
      redirectUriFor("https://fixture-brain.example.workers.dev/x") ===
        bankFeedRedirectUri("fixture-brain.example.workers.dev") &&
      plaidWebhookUri("fixture-brain.example.workers.dev") ===
        "https://fixture-brain.example.workers.dev/api/webhooks/plaid",
      JSON.stringify({ BANK_FEED_REDIRECT_PATH, PLAID_WEBHOOK_PATH, WORKER_PLAID_WEBHOOK_PATH }));

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
      corpora: { bank_feed: { enabled: true, registered_redirect_uris: ["https://fixture-brain.example.workers.dev/app/connect/bank"] } },
    });
    check("a Plaid feed with no exact webhook record cannot report OK or claim a signed webhook",
      halfConfigured.status === FAIL &&
      /signed webhook destination.*not recorded as registered/i.test(halfConfigured.detail) &&
      halfConfigured.fix.includes("https://fixture-brain.example.workers.dev/api/webhooks/plaid") &&
      /credential setup and dashboard changes remain held/i.test(halfConfigured.fix),
      JSON.stringify(halfConfigured));

    const wrongWebhook = checkBankFeedRedirect({
      ...manifest({ bankFeed: true }),
      corpora: { bank_feed: {
        enabled: true,
        registered_redirect_uris: ["https://fixture-brain.example.workers.dev/app/connect/bank"],
        registered_webhook_uris: ["https://other-brain.example.workers.dev/api/webhooks/plaid"],
      } },
    });
    check("a different Brain's Plaid webhook does not satisfy the exact registration check",
      wrongWebhook.status === FAIL && !/signed webhook https:\/\/other-brain/.test(wrongWebhook.detail),
      JSON.stringify(wrongWebhook));

    const plaidReady = checkBankFeedRedirect({
      ...manifest({ bankFeed: true }),
      corpora: { bank_feed: {
        enabled: true,
        registered_redirect_uris: ["https://fixture-brain.example.workers.dev/app/connect/bank"],
        registered_webhook_uris: ["https://fixture-brain.example.workers.dev/api/webhooks/plaid"],
      } },
    });
    check("Plaid reports its signed webhook only after the exact URI is recorded",
      plaidReady.status === OK &&
      /signed webhook https:\/\/fixture-brain\.example\.workers\.dev\/api\/webhooks\/plaid/.test(plaidReady.detail),
      JSON.stringify(plaidReady));
    const partialLegacy = checkBankFeedRedirect({
      ...manifest({ bankFeed: true }),
      corpora: { bank_feed: { enabled: true, api_base: "https://sandbox.provider.invalid",
        registered_redirect_uris: ["https://fixture-brain.example.workers.dev/app/connect/bank"] } },
    });
    check("partial legacy endpoint configuration fails before a customer session",
      partialLegacy.status === FAIL && /link_sdk_url/.test(partialLegacy.fix), JSON.stringify(partialLegacy));

    const ready = checkBankFeedRedirect({
      ...manifest({ bankFeed: true }),
      corpora: { bank_feed: {
        enabled: true, environment: "sandbox",
        registered_redirect_uris: ["https://fixture-brain.example.workers.dev/app/connect/bank"],
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
        corpora: { bank_feed: { enabled: true, registered_redirect_uris: ["https://other-brain.example.workers.dev/app/connect/bank"] } },
      }).status === FAIL, "");
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n${fail ? "FAILURES" : "bank-feed-secrets"}: ${ran - fail}/${ran} checks passed`);
process.exit(fail ? 1 : 0);
